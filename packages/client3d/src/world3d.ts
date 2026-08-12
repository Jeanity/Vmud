/**
 * The scene graph: chunks in, boxes out. The only file that turns a {@link chunkPlan.Placement} into
 * a matrix.
 *
 * Everything above it is pure — `describeRoom` says what a room is, `planChunk` says where the boxes
 * go, `ChunkStreamer` says which rooms are near enough to care about — and everything it owns below
 * is pooled. What is left here is the wiring, and it is deliberately the only place that knows all
 * three exist.
 *
 * ## What a chunk is
 *
 * **One stride cell on one level**, which is one room block and the half-gap around it. Not a 2x2
 * block of cells, and not the whole window: the plan wants "one `InstancedMesh` per `(chunk,
 * prototype)`, deliberately per chunk and not one world-spanning batch, or frustum culling never
 * fires", and a one-room chunk is the finest granularity at which the unload is exact. The cost is
 * draw calls — a full window is ~35 occupied cells on the walked level, each contributing between
 * two and six buckets — and at grey-box that is the right trade, because the thing being proved at
 * M3 is that memory is flat, not that the frame is cheap. Coarsening the chunk is a one-constant
 * change if M5's density makes it necessary.
 *
 * ## The vertical policy, implemented in three places and stated once
 *
 * *Player's level plus one below, faded; everything above hard-culled.* The cull is in
 * `streamer.ts`, which never asks for a level above. The fade is in `prototypes.ts`, which has a dim
 * twin of every terrain material. The **height** is in `chunkPlan.roomElevation`, which re-anchors
 * the IR's absolute policy on the camera's own level so the walked ground is at y≈0 and the level
 * below is exactly one `separation` down. This file only chooses which of the three applies.
 *
 * ## Fog, at grey-box
 *
 * A room whose centre tile is not in the character's `seen` bitset draws with the faded materials —
 * the same twin the level below uses, because it means the same thing. That is M3's stand-in for
 * M4's per-chunk uniform, and it costs one bitset lookup per loaded chunk per `seenDelta` rather
 * than the blurred one-pixel-per-tile canvas the Phaser client paints.
 */

import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  Object3D,
  Scene,
  type InstancedMesh,
} from 'three';

import {
  CARDINALS,
  OPPOSITE,
  ROOM_TILES,
  buildZoneTilemap,
  cellIndex,
  cellKey,
  describeRoom,
  neighboursOf,
  sceneSeed,
  sceneZone,
  setDoorTiles,
  type Cardinal,
  type Direction,
  type Room,
  type RoomId,
  type SceneZone,
  type TileGrid,
  type Zone,
} from '@mygame/shared';

/**
 * The fog bitset, imported by path.
 *
 * `vision.ts` is not re-exported from `@mygame/shared`'s index — the Phaser client reaches into it
 * the same way, with the same note — and it is the right module to take these from: `seen` is the
 * server's own encoding and both sides must read the same bits out of it.
 */
import { bitsFromBase64, bitsetAdd, bitsetBytes, bitsetHas } from '@mygame/shared/vision.ts';

import { planChunk, roomElevation, type Placement } from './chunkPlan.ts';
import { METRES_PER_TILE, cellOriginTiles, cellOfPixel, placeFrame, type PlaceFrame } from './frame.ts';
import { ScenePool, WRAPPER_CAPACITY, type LedgerSnapshot } from './pool.ts';
import { ChunkStreamer, chunkKey, type ChunkAddress, type ChunkSink } from './streamer.ts';

/** The centre tile of a room block, room-relative. Used only to ask "has this room been seen". */
const CENTRE_TILE = (ROOM_TILES - 1) / 2;

interface LoadedChunk {
  readonly address: ChunkAddress;
  readonly room: RoomId;
  faded: boolean;
  readonly meshes: InstancedMesh[];
}

export class World3D implements ChunkSink {
  readonly scene = new Scene();
  readonly pool = new ScenePool();
  private readonly streamer = new ChunkStreamer(this);
  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly scratch = new Object3D();
  /** Reused between chunk builds so a load allocates buckets rather than a new index each time. */
  private readonly buckets = new Map<string, Placement[]>();

  private context: SceneZone | undefined;
  private cells: Map<string, Room> | undefined;
  private roomsById = new Map<RoomId, Room>();
  private frameOf: PlaceFrame | undefined;
  private tiles: TileGrid | undefined;
  private seen: Uint8Array | undefined;
  /** One-entry memo for {@link groundAt}. */
  private ground: { cellX: number; cellY: number; level: number; y: number } | undefined;
  /** Live door state, keyed `roomId:dir`. See `ChunkPlanInput.doorClosed` for why it lives outside. */
  private readonly doors = new Map<string, boolean>();

  constructor() {
    // **Untuned on purpose.** M4 is the milestone that decides whether the light matches the
    // reference, and a palette or an exposure chosen now would be chosen against grey boxes and
    // thrown away. What this pair has to do is make a box read as a box: a sky/ground hemisphere so
    // the tops are lighter than the sides, and one key light so the sides differ from each other.
    // No shadows, no fog colour grade, no tone mapping — all four are M4's, by name.
    this.scene.background = new Color(0x10161c);
    this.scene.fog = new Fog(0x10161c, 40, 90);
    this.scene.add(new HemisphereLight(0x9db4c6, 0x3a3630, 1.6));
    const key = new DirectionalLight(0xffffff, 1.1);
    key.position.set(-0.4, 1, 0.6);
    this.scene.add(key);
  }

  /* ---------------------------------------------------------------- the Place */

  /**
   * A new map under the character's feet — the `zone` message, on join and on every arrival.
   *
   * Everything is dropped: the frame, the collision grid, the ground components, every chunk. The
   * `seen` bitset goes too, because it is per Place and the server sends the new one immediately
   * behind this (protocol note on `zone`: *"Receiving this for a different Place must reset the
   * client's `seen` bitset"*).
   */
  setPlace(zone: Zone, level: number): void {
    this.streamer.clear();
    this.context = sceneZone(zone);
    this.cells = cellIndex(zone);
    this.roomsById = new Map(zone.rooms.map((room) => [room.id, room]));
    this.frameOf = placeFrame(zone, level);
    this.tiles = buildZoneTilemap(zone, level);
    this.seen = undefined;
    this.ground = undefined;
    this.doors.clear();
  }

  get frame(): PlaceFrame | undefined {
    return this.frameOf;
  }

  /** The collision grid the predictor steps against — the same one the server built. */
  get grid(): TileGrid | undefined {
    return this.tiles;
  }

  get chunksLoaded(): number {
    return this.chunks.size;
  }

  /**
   * Live chunks per level, and how many of them are drawn faded.
   *
   * The vertical policy's own read-out: an entry for a level *above*
   * {@link PlaceFrame.level} would mean the hard cull had failed, and `faded` counts the level below
   * plus whatever ground this character has not seen. Exposed on `__debug3d` and asserted by
   * `traversal.test.ts`, because both are otherwise only visible as a picture.
   */
  chunkLevels(): { levels: Record<number, number>; faded: number } {
    const levels: Record<number, number> = {};
    let faded = 0;
    for (const chunk of this.chunks.values()) {
      levels[chunk.address.level] = (levels[chunk.address.level] ?? 0) + 1;
      if (chunk.faded) faded += 1;
    }
    return { levels, faded };
  }

  ledger(): LedgerSnapshot {
    return this.pool.snapshot();
  }

  /* ----------------------------------------------------------------- fog */

  /** The authoritative snapshot for the Place the character is standing on. */
  setSeen(bits: string): void {
    const grid = this.tiles;
    if (!grid) return;
    this.seen = bitsFromBase64(bits, bitsetBytes(grid.width * grid.height));
    this.refreshFog();
  }

  /** Tiles seen since the last message. Only a chunk whose room's state *flipped* is rebuilt. */
  addSeen(indices: readonly number[]): void {
    const seen = this.seen;
    if (!seen) return;
    let changed = false;
    for (const index of indices) changed = bitsetAdd(seen, index) || changed;
    if (changed) this.refreshFog();
  }

  private refreshFog(): void {
    for (const chunk of this.chunks.values()) {
      const faded = this.isFaded(chunk.address, chunk.room);
      if (faded !== chunk.faded) this.rebuild(chunk);
    }
  }

  /* ----------------------------------------------------------------- doors */

  /**
   * A door on this Place opened or shut.
   *
   * Two things happen and both are necessary: the collision grid is mutated with the *same*
   * `setDoorTiles` the server ran — "a client whose copy is stale predicts straight through a tile
   * the server will refuse" — and the two chunks that can be drawing that leaf are rebuilt. Only two,
   * because a door lives on the boundary between exactly two rooms.
   */
  applyDoor(roomId: RoomId, dir: Direction, closed: boolean): void {
    const grid = this.tiles;
    if (!grid) return;
    setDoorTiles(grid, roomId, dir, closed);
    this.doors.set(`${roomId}:${dir}`, closed);
    const room = this.roomsById.get(roomId);
    const across = room?.exits[dir]?.to;
    if (across !== undefined) this.doors.set(`${across}:${OPPOSITE[dir]}`, closed);
    for (const chunk of this.chunks.values()) {
      if (chunk.room === roomId || chunk.room === across) this.rebuild(chunk);
    }
  }

  /* ------------------------------------------------------------- streaming */

  /**
   * Recentre the window on a simulation position. Called every frame; does nothing most frames.
   *
   * The centre is the *predicted* position rather than the server's, for the same reason the Phaser
   * client's lit set is: streaming a fifth of a room behind the character would show its seam every
   * time they turned round.
   */
  update(px: number, py: number): void {
    const frame = this.frameOf;
    if (!frame) return;
    const { cellX, cellY } = cellOfPixel(frame, px, py);
    this.streamer.update(cellX, cellY, frame.level);
  }

  /**
   * The height of the ground under a simulation position, in metres.
   *
   * What the camera and every body stand on. Answered from the *room's* elevation rather than by
   * raycasting the built geometry: at M3 a room's ground is one flat slab, so the two answers are
   * identical and this one needs neither `three-mesh-bvh` (which arrives with click-to-move) nor a
   * loaded chunk — which matters, because the body has to be somewhere sensible during the frame
   * between `welcome` and the first chunk build.
   *
   * Memoised on the cell, so it costs one `describeRoom` every time the character crosses a room
   * boundary — about once every two and a half seconds at walking pace — and a comparison otherwise.
   */
  groundAt(px: number, py: number): number {
    const frame = this.frameOf;
    const context = this.context;
    const cells = this.cells;
    if (!frame || !context || !cells) return 0;
    const { cellX, cellY } = cellOfPixel(frame, px, py);
    const held = this.ground;
    if (held && held.cellX === cellX && held.cellY === cellY && held.level === frame.level) return held.y;

    const room = cells.get(cellKey(cellX, cellY, frame.level));
    let y = 0;
    if (room) {
      const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
      const scene = describeRoom(context, room, neighboursOf(cells, room, this.roomsById), sceneSeed(context, room));
      y = roomElevation(
        scene,
        room.pos.z,
        frame.level,
        (origin.tx + ROOM_TILES / 2) * METRES_PER_TILE,
        (origin.ty + ROOM_TILES / 2) * METRES_PER_TILE,
      );
    }
    this.ground = { cellX, cellY, level: frame.level, y };
    return y;
  }

  load(address: ChunkAddress): boolean {
    const frame = this.frameOf;
    const context = this.context;
    const cells = this.cells;
    if (!frame || !context || !cells) return false;
    const room = cells.get(cellKey(address.cellX, address.cellY, address.level));
    if (!room) return false;

    const key = chunkKey(address);
    const chunk: LoadedChunk = { address, room: room.id, faded: this.isFaded(address, room.id), meshes: [] };
    this.chunks.set(key, chunk);
    this.build(chunk, room, frame, context, cells);
    return true;
  }

  unload(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    for (const mesh of chunk.meshes) this.pool.release(mesh);
    chunk.meshes.length = 0;
    this.chunks.delete(key);
  }

  /** A loaded chunk whose inputs changed — a door, or ground that has just been seen. */
  private rebuild(chunk: LoadedChunk): void {
    const frame = this.frameOf;
    const context = this.context;
    const cells = this.cells;
    const room = this.roomsById.get(chunk.room);
    if (!frame || !context || !cells || !room) return;
    for (const mesh of chunk.meshes) this.pool.release(mesh);
    chunk.meshes.length = 0;
    chunk.faded = this.isFaded(chunk.address, chunk.room);
    this.build(chunk, room, frame, context, cells);
  }

  private isFaded(address: ChunkAddress, roomId: RoomId): boolean {
    const frame = this.frameOf;
    if (!frame) return false;
    // The level below is always faded — that is the policy, not a fog rule.
    if (address.level !== frame.level) return true;
    const seen = this.seen;
    const grid = this.tiles;
    // Before the snapshot arrives, everything is drawn present. The alternative is a world that
    // boots entirely grey and resolves a tick later, which reads as a bug.
    if (!seen || !grid) return false;
    const origin = grid.roomOrigins.get(roomId);
    if (!origin) return false;
    const index = (origin.ty + CENTRE_TILE) * grid.width + (origin.tx + CENTRE_TILE);
    return !bitsetHas(seen, index);
  }

  private build(
    chunk: LoadedChunk,
    room: Room,
    frame: PlaceFrame,
    context: SceneZone,
    cells: ReadonlyMap<string, Room>,
  ): void {
    const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
    const scene = describeRoom(context, room, neighboursOf(cells, room, this.roomsById), sceneSeed(context, room));
    const centreX = (origin.tx + ROOM_TILES / 2) * METRES_PER_TILE;
    const centreZ = (origin.ty + ROOM_TILES / 2) * METRES_PER_TILE;
    const doorClosed: { -readonly [K in Cardinal]?: boolean } = {};
    for (const dir of CARDINALS) {
      const held = this.doors.get(`${room.id}:${dir}`);
      if (held !== undefined) doorClosed[dir] = held;
    }

    const placements = planChunk({
      scene,
      origin,
      elevation: roomElevation(scene, room.pos.z, frame.level, centreX, centreZ),
      gap: frame.gap,
      faded: chunk.faded,
      doorClosed,
    });

    this.buckets.clear();
    for (const placement of placements) {
      const key = `${placement.geometry}|${placement.material}`;
      const bucket = this.buckets.get(key);
      if (bucket) bucket.push(placement);
      else this.buckets.set(key, [placement]);
    }

    for (const bucket of this.buckets.values()) {
      const first = bucket[0];
      if (!first) continue;
      // A bucket wider than one wrapper spills into the next rather than growing a buffer — see
      // `WRAPPER_CAPACITY`. Nothing in the shipped world reaches even a quarter of it.
      for (let start = 0; start < bucket.length; start += WRAPPER_CAPACITY) {
        const slice = bucket.slice(start, start + WRAPPER_CAPACITY);
        const mesh = this.pool.acquire(first.geometry, first.material);
        for (let i = 0; i < slice.length; i++) {
          const p = slice[i]!;
          this.scratch.position.set(p.x, p.y, p.z);
          this.scratch.rotation.set(p.rx, p.ry, p.rz);
          this.scratch.scale.set(p.sx, p.sy, p.sz);
          this.scratch.updateMatrix();
          mesh.setMatrixAt(i, this.scratch.matrix);
        }
        mesh.count = slice.length;
        this.pool.finish(mesh);
        this.scene.add(mesh);
        chunk.meshes.push(mesh);
      }
    }
  }

  dispose(): void {
    this.streamer.clear();
    this.pool.dispose();
  }
}
