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
 * ## Fog of war, three states, as a per-chunk uniform — M4
 *
 * M3 drew an unseen room with the faded (transparent) materials, which said the same thing as the
 * level below and had no third state. It now writes one of {@link fogOfWar.FOG_STATES} into the
 * chunk's wrappers as an instance colour:
 *
 * - **visible** — the character's own room and every room an exit links it to. That set is the MUD's
 *   own unit of interest management (*"players receive updates for their current room and its
 *   immediate neighbours only"*), it is the same size as what the camera actually frames, and it is
 *   free: the client already holds the room graph. What it buys is the reference image's read — a lit
 *   clearing that travels with the character and falls off into remembered ground at its rim.
 * - **remembered** — in the `seen` bitset, but not in that set. Dimmed and desaturated.
 * - **unseen** — not in the bitset. Near-black, and opaque, so unexplored ground is a silhouette.
 *
 * Costs one bitset lookup per loaded chunk per `seenDelta` and a three-float write per instance when a
 * state flips — no rebuild, because nothing about the *geometry* changed. That is the whole of the
 * plan's *"rather than the blurred 1 px-per-tile canvas"*.
 *
 * ## Lighting lives here because the scene does
 *
 * `night.ts` owns the recipe and this file owns when it is applied: {@link World3D.focus} refits the
 * moon's shadow camera and moves the clearing light every frame, and `main.ts` calls it with the same
 * position it gives the camera rig, so the light, the shadow and the frame all describe one instant.
 *
 * ## M5a: the scatter, and the one thing it added to the streaming contract
 *
 * A chunk's placements are now `planChunk`'s **plus** `scatter.ts`'s, concatenated before the buckets
 * are formed — so a tree is instanced, pooled, fogged, released and counted by exactly the machinery
 * a wall already was, and the only new code path is the one that decides *which* baked mesh.
 *
 * That decision is the addition. A tree has three levels of detail and which one a chunk draws
 * depends on how far it is from the camera, which changes as the player walks — so {@link
 * World3D.update} re-checks every loaded chunk's LOD tier when the window recentres and rebuilds the
 * handful whose tier moved. A rebuild is a release and an acquire; it allocates nothing, and the
 * traversal test's flat-ledger assertion covers it. The alternative — choosing the LOD once at load
 * and never revisiting it — would leave a chunk built at the window's rim still drawing LOD2 when the
 * player is standing in it.
 *
 * Two gates, both stated once here: **scatter is skipped on faded chunks** (the level below grows
 * nothing — see `prototypes.ts`'s never-faded set), and **a placement whose geometry the pool cannot
 * resolve is dropped** (the GLBs arrive over the network a moment after the first chunk does, and a
 * world with no trees is the correct picture until they land).
 */

import { Object3D, Scene, type InstancedMesh } from 'three';

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
import { fogStateOf, type FogState } from './fogOfWar.ts';
import {
  METRES_PER_TILE,
  cellOriginTiles,
  cellOfPixel,
  metresOfTile,
  placeFrame,
  type PlaceFrame,
} from './frame.ts';
import { type SkyRecipe, skyAt } from './daylight.ts';
import { KitSet } from './kit.ts';
import { LightPool, type LightRequest } from './lights.ts';
import { NightRig } from './night.ts';
import { ScenePool, WRAPPER_CAPACITY, type LedgerSnapshot } from './pool.ts';
import { freeTiles, planScatter } from './scatter.ts';
import { ChunkStreamer, chunkKey, type ChunkAddress, type ChunkSink } from './streamer.ts';
import { TreeSet } from './trees.ts';
import { planWater } from './water.ts';
import { planPuddles } from './wetness.ts';

/** The centre tile of a room block, room-relative. Used only to ask "has this room been seen". */
const CENTRE_TILE = (ROOM_TILES - 1) / 2;

/**
 * What a wrapper has to be registered with to bloom.
 *
 * Structurally a `postprocessing` `Selection` and named as an interface so this file — which the
 * headless tests construct — never imports the composer. The plan's *"do not also use
 * `UnrealBloomPass`"* warning is about mixing two composer stacks; the same discipline says the scene
 * graph should not know which one it got.
 */
export interface GlowSet {
  add(object: Object3D): unknown;
  delete(object: Object3D): unknown;
}

interface LoadedChunk {
  readonly address: ChunkAddress;
  readonly room: RoomId;
  /** The level below. See `FADE_OPACITY`: transparency now means only this. */
  faded: boolean;
  state: FogState;
  /** True when the room has a roof over it. Drives the weather gate — no rain indoors or in a cave. */
  roofed: boolean;
  /** Where this chunk's campfire is, if it drew one. Feeds `LightPool.scene`. */
  fire: { x: number; y: number; z: number } | undefined;
  /** Which baked level of detail the trees in this chunk are drawn at. See {@link World3D.update}. */
  lod: number;
  /** Trees and tufts this chunk drew. `__debug3d.treeInstances` / `scatterInstances`. */
  trees: number;
  scatter: number;
  /** Kit instances — trees excluded, so it reads as "how much understory". `__debug3d.kitInstances`. */
  kit: number;
  /** True when this chunk drew a water surface. `__debug3d.waterChunks`. */
  water: boolean;
  readonly meshes: InstancedMesh[];
  /** The material key each mesh was drawn with, so a retint knows which tint row to write. */
  readonly keys: string[];
  /**
   * The puddle wrappers, held apart so the wetness can hide them without walking every mesh.
   *
   * See `wetness.ts`'s header for why they are planned dry and hidden rather than planned when it
   * starts raining: making their *existence* weather-dependent would rebuild seventy chunks the
   * moment a storm began.
   */
  readonly puddles: InstancedMesh[];
}

export class World3D implements ChunkSink {
  readonly scene = new Scene();
  readonly pool = new ScenePool();
  readonly night: NightRig;
  readonly lights: LightPool;
  /** The baked tree set. Empty until `main.ts` loads the manifest; the scatter is gated on it. */
  readonly trees = new TreeSet();
  /** The Quaternius kit. Same contract, same gate, a second manifest. See `kit.ts`. */
  readonly kit = new KitSet();
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
  /** The cell the window is centred on. What {@link lodOf} measures a chunk's distance from. */
  private centreCell: { cellX: number; cellY: number } | undefined;
  /** Live door state, keyed `roomId:dir`. See `ChunkPlanInput.doorClosed` for why it lives outside. */
  private readonly doors = new Map<string, boolean>();

  /** Where the bloom selection lives, once `main.ts` has built a composer. Absent under test. */
  private glowSet: GlowSet | undefined;
  /** The room the character is standing in, and the rooms an exit links it to. See the header. */
  private here: RoomId | undefined;
  private lit: ReadonlySet<RoomId> = new Set();
  /** Raised whenever the loaded set changes, so the light assignment is redone once and not per frame. */
  private lightsStale = true;
  /** Scratch for {@link focus}: reused so the per-frame light pass allocates nothing. */
  private readonly requests: LightRequest[] = [];
  /** The hour {@link setGameHour} was last given. 0 is midnight, which is M4's world. */
  private hourOfDay = 0;

  constructor() {
    this.night = new NightRig(this.scene);
    this.lights = new LightPool(this.scene);
  }

  /**
   * Hand the renderer's bloom selection to the scene graph, or take it away again.
   *
   * Called at boot with the composer's selection, and everything already loaded is re-registered,
   * because the composer is built after the first `zone` message can already have arrived. Passing
   * `undefined` detaches it — see `post.ts`'s `selective`, whose fallback needs the flow of new
   * portals to stop as well as the existing flags to be cleared.
   */
  setGlowSet(glow: GlowSet | undefined): void {
    const previous = this.glowSet;
    if (previous && !glow) {
      for (const chunk of this.chunks.values()) {
        for (const mesh of chunk.meshes) previous.delete(mesh);
      }
    }
    this.glowSet = glow;
    if (glow) for (const chunk of this.chunks.values()) this.registerGlow(chunk);
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
    // The lit set belongs to the Place that has just been left. Keeping it would light a room in the
    // new zone that happens to share an id with one in the old.
    this.here = undefined;
    this.lit = new Set();
    this.lights.darken();
    this.lightsStale = true;
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
   * The vertical policy's own read-out: an entry for a level *above* {@link PlaceFrame.level} would
   * mean the hard cull had failed, and after M4 `faded` counts the level below and **nothing else** —
   * unexplored ground is now a colour rather than an alpha, so the two sets are exactly equal by
   * construction. Exposed on `__debug3d` and asserted by `traversal.test.ts`, because both are
   * otherwise only visible as a picture.
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

  /**
   * Trees standing in the loaded window, and every scatter instance including undergrowth.
   *
   * `__debug3d.treeInstances` and `__debug3d.scatterInstances`. Counted off the chunks rather than off
   * the pool, because the pool counts *wrappers* and the question a dense forest room raises is how
   * many things are in it.
   */
  scatterCensus(): { trees: number; instances: number; kit: number; water: number } {
    let trees = 0;
    let instances = 0;
    let kit = 0;
    let water = 0;
    for (const chunk of this.chunks.values()) {
      trees += chunk.trees;
      instances += chunk.scatter;
      kit += chunk.kit;
      if (chunk.water) water += 1;
    }
    return { trees, instances, kit, water };
  }

  /* ------------------------------------------------------------- M5b: weather */

  /**
   * How wet the world is, 0..1 — one uniform write, and the puddles shown or hidden with it.
   *
   * The uniform reaches every ground material, every kit solid and every puddle because they were all
   * handed the *same* {@link WetControls} object at construction (see `wetness.ts`'s header); this is
   * one write, not a loop over 48 materials. The visibility pass is a loop, but only over the puddle
   * wrappers and only when the boolean actually flips — a dry world costs nothing per frame.
   */
  setWetness(wet: number): void {
    const clamped = Math.min(1, Math.max(0, wet));
    const was = this.pool.wet.uWet.value > 0;
    this.pool.wet.uWet.value = clamped;
    const now = clamped > 0;
    if (was === now) return;
    for (const chunk of this.chunks.values()) {
      for (const mesh of chunk.puddles) mesh.visible = now;
    }
  }

  get wetness(): number {
    return this.pool.wet.uWet.value;
  }

  /* ------------------------------------------------------------- M5b: the hour */

  /**
   * The hour of the game day, 0..24 — the **named hook** M5b owes and the toggle it ships instead.
   *
   * *Settled 2026-08-13 and re-verified while building this:* the server ticks no game-hour clock.
   * The only `hour` matches under `packages/server/src` are the scheduler's and the noticeboards'
   * wall-clock timestamps, and no message on the wire carries a time of day. So the hour is a client
   * value, driven by a debug key, and **this method is where a server clock will land** — a `time`
   * message handler in `main.ts` calling `world.setGameHour(message.hour)` is the whole of that future
   * change, because everything else is already downstream of this one number.
   *
   * Writes the whole sky at once (`NightRig.sky`) rather than a colour at a time; `main.ts` picks the
   * exposure off the returned recipe, because the composer is its and not the scene graph's.
   */
  setGameHour(hour: number): SkyRecipe {
    const recipe = skyAt(hour);
    this.hourOfDay = hour;
    this.night.sky = recipe;
    return recipe;
  }

  get gameHour(): number {
    return this.hourOfDay;
  }

  /**
   * Whether the foliage sways. The **F** key and `__debug3d.windEnabled`, on one shared uniform.
   *
   * A uniform and not a define, so the toggle compiles nothing — and it reaches the depth material as
   * well as the visible one, because both hold the same clock object. Switching the wind off and
   * watching a shadow stay exactly where it was is, incidentally, the fastest manual check of
   * `foliage.ts`'s trap 1.
   */
  get windEnabled(): boolean {
    return this.pool.wind.uWind.value > 0.5;
  }

  set windEnabled(on: boolean) {
    this.pool.wind.uWind.value = on ? 1 : 0;
  }

  /** Advance the foliage clock. Wall-clock seconds, exactly as the rain and the portal pulse take. */
  breathe(seconds: number): void {
    this.pool.wind.uTime.value = seconds;
  }

  /** How the loaded window is divided between the three fog states. `__debug3d.fogOfWar`. */
  fogCensus(): Record<FogState, number> {
    const census: Record<FogState, number> = { unseen: 0, remembered: 0, visible: 0 };
    for (const chunk of this.chunks.values()) census[chunk.state] += 1;
    return census;
  }

  /** True when the character is under a roof. The weather gate — see `LoadedChunk.roofed`. */
  get roofed(): boolean {
    const here = this.here;
    if (here === undefined) return false;
    for (const chunk of this.chunks.values()) {
      if (chunk.room === here && !chunk.faded) return chunk.roofed;
    }
    return false;
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

  /** Tiles seen since the last message. Only a chunk whose room's state *flipped* is repainted. */
  addSeen(indices: readonly number[]): void {
    const seen = this.seen;
    if (!seen) return;
    let changed = false;
    for (const index of indices) changed = bitsetAdd(seen, index) || changed;
    if (changed) this.refreshFog();
  }

  /**
   * Click-to-move's gate: has this tile index — `ty * grid.width + tx`, the same key `stateOf` reads
   * below and `vision.ts`'s `computeVisible` writes — ever been seen.
   *
   * `true` before the first `seen` snapshot arrives, matching {@link stateOf}'s own default: *"before
   * the `seen` snapshot arrives everything is drawn present"*, so a click in the first frame after a
   * `zone` message is not refused by a client-side gate answering a question the server has not
   * answered yet either.
   */
  hasSeenTile(index: number): boolean {
    const seen = this.seen;
    return seen ? bitsetHas(seen, index) : true;
  }

  /**
   * The character moved to a new room — the `room` message.
   *
   * Recomputes the lit set: this room and every room one exit away, which is the MUD's own
   * neighbourhood and roughly what the camera frames. See the file header for why that is the right
   * definition of "visible" and not a line-of-sight computation.
   */
  setHere(roomId: RoomId | undefined): void {
    if (roomId === this.here) return;
    this.here = roomId;
    const lit = new Set<RoomId>();
    if (roomId !== undefined) {
      lit.add(roomId);
      const room = this.roomsById.get(roomId);
      if (room) {
        for (const exit of Object.values(room.exits)) {
          if (exit) lit.add(exit.to);
        }
      }
    }
    this.lit = lit;
    this.refreshFog();
  }

  /**
   * Repaint whatever changed state. **No rebuild** — the geometry is identical either way.
   *
   * The distinction matters: `rebuild` re-runs `describeRoom` and `planChunk` and cycles the chunk's
   * wrappers through the free list, which is the right response to a door but a wasteful one to a bit
   * flipping in a bitset. A state change is three floats an instance.
   */
  private refreshFog(): void {
    let moved = false;
    for (const chunk of this.chunks.values()) {
      const state = this.stateOf(chunk.address, chunk.room);
      if (state === chunk.state) continue;
      chunk.state = state;
      this.repaint(chunk);
      moved = true;
    }
    // A campfire in a room that has just stopped being unexplored is a light that should come on.
    if (moved) this.lightsStale = true;
  }

  private repaint(chunk: LoadedChunk): void {
    for (let i = 0; i < chunk.meshes.length; i++) {
      const mesh = chunk.meshes[i];
      const key = chunk.keys[i];
      if (!mesh || key === undefined) continue;
      this.pool.paint(mesh, key, chunk.state, mesh.count);
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
    // Written before the streamer runs, because `load` is called from inside it and every chunk built
    // there asks {@link lodOf} where the camera is.
    this.centreCell = { cellX, cellY };
    const step = this.streamer.update(cellX, cellY, frame.level);
    // Only when the window actually moved. `update` is called every frame and does nothing on most of
    // them; re-walking the loaded set to compare LOD tiers on every one of those would undo that.
    if (step.moved) this.refreshLods();
  }

  /**
   * Re-choose each chunk's level of detail now the camera has crossed a cell, and rebuild what moved.
   *
   * The distance is measured in **stride cells** rather than from the body's real position, for the
   * same reason the streamer's window is: a chunk is a cell, its trees are all within four and a half
   * metres of its centre, and a per-tree distance would make the LOD a property of a frame rather
   * than of a chunk — which is a rebuild every frame instead of one or two per cell crossed. A
   * rebuild is a release and an acquire and allocates nothing; `traversal.test.ts` covers it.
   */
  private refreshLods(): void {
    if (!this.trees.available) return;
    for (const chunk of this.chunks.values()) {
      if (this.lodOf(chunk.address) === chunk.lod) continue;
      this.rebuild(chunk);
    }
  }

  /** The LOD a chunk at this address should be drawing, from the camera's current cell. */
  private lodOf(address: ChunkAddress): number {
    const frame = this.frameOf;
    const centre = this.centreCell;
    if (!frame || !centre) return 0;
    const metresPerCell = frame.stride * METRES_PER_TILE;
    const dx = (address.cellX - centre.cellX) * metresPerCell;
    const dy = (address.cellY - centre.cellY) * metresPerCell;
    return this.trees.lodFor(Math.hypot(dx, dy));
  }

  /**
   * Point the light at the frame — the moon's shadow camera and the character's own clearing. M4.
   *
   * Called every frame from `main.ts` with the *same* metres the camera rig is given, which is what
   * makes the shadow volume and the visible frame describe one region rather than two that drift
   * apart by a frame of prediction. Costs eight corner projections (`night.refit`) plus a `Vector3`
   * write; the campfire scan behind {@link lightsStale} runs only when the loaded set has changed,
   * which is once per stride cell crossed.
   */
  focus(x: number, y: number, z: number, clearingRadius?: number): void {
    this.night.refit(x, y, z);
    // A little above the ground: a point light *at* the feet lights the floor and nothing else.
    this.lights.clearing(x, y + 1.5, z, clearingRadius);
    if (!this.lightsStale) return;
    this.lightsStale = false;
    this.requests.length = 0;
    for (const chunk of this.chunks.values()) {
      const fire = chunk.fire;
      if (!fire || chunk.faded || chunk.state === 'unseen') continue;
      const dx = fire.x - x;
      const dz = fire.z - z;
      this.requests.push({ x: fire.x, y: fire.y, z: fire.z, rank: dx * dx + dz * dz });
    }
    this.lights.scene(this.requests);
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
    const chunk: LoadedChunk = {
      address,
      room: room.id,
      faded: this.isFaded(address),
      state: this.stateOf(address, room.id),
      roofed: false,
      fire: undefined,
      lod: this.lodOf(address),
      trees: 0,
      scatter: 0,
      kit: 0,
      water: false,
      meshes: [],
      keys: [],
      puddles: [],
    };
    this.chunks.set(key, chunk);
    this.build(chunk, room, frame, context, cells);
    this.lightsStale = true;
    return true;
  }

  unload(key: string): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.releaseAll(chunk);
    this.chunks.delete(key);
    this.lightsStale = true;
  }

  /**
   * Hand a chunk's wrappers back, and take them out of the bloom selection first.
   *
   * The selection is a **layer flag written onto the object**, and the free list is LIFO, so the very
   * next chunk to ask for a wrapper gets the one a portal was just drawn with. Leaving the flag on it
   * would make a ground slab bloom, intermittently, in whichever room happened to load next — a bug
   * that reproduces once in twenty and looks like a driver fault.
   */
  private releaseAll(chunk: LoadedChunk): void {
    const glow = this.glowSet;
    for (const mesh of chunk.meshes) {
      if (glow) glow.delete(mesh);
      this.pool.release(mesh);
    }
    chunk.meshes.length = 0;
    chunk.keys.length = 0;
    chunk.puddles.length = 0;
  }

  /** A loaded chunk whose *geometry* changed — a door, or a level that is now the one below. */
  private rebuild(chunk: LoadedChunk): void {
    const frame = this.frameOf;
    const context = this.context;
    const cells = this.cells;
    const room = this.roomsById.get(chunk.room);
    if (!frame || !context || !cells || !room) return;
    this.releaseAll(chunk);
    chunk.faded = this.isFaded(chunk.address);
    chunk.state = this.stateOf(chunk.address, chunk.room);
    chunk.lod = this.lodOf(chunk.address);
    this.build(chunk, room, frame, context, cells);
  }

  /**
   * Transparency, and after M4 it means exactly one thing: **this is the level below.**
   *
   * At M3 it also answered "never seen", which is why it took a room id and read the bitset. That
   * question moved to {@link stateOf}, where its answer is a colour rather than an alpha, and what is
   * left is the vertical policy on its own — *"the player's level plus one below, faded"* — with no
   * fog rule mixed into it.
   */
  private isFaded(address: ChunkAddress): boolean {
    const frame = this.frameOf;
    return frame !== undefined && address.level !== frame.level;
  }

  /**
   * Which of the three states a chunk's room is in.
   *
   * A chunk on the level below is never `visible`, whatever the room graph says: you are not looking
   * *into* it, you are looking *over* it, and lighting a room you cannot walk in would undo the read
   * the fade exists to give. Before the `seen` snapshot arrives everything is drawn present, for the
   * same reason M3 gave — a world that boots entirely black and resolves a tick later reads as a bug.
   */
  private stateOf(address: ChunkAddress, roomId: RoomId): FogState {
    const frame = this.frameOf;
    const seen = this.seen;
    const grid = this.tiles;
    if (!frame || !seen || !grid) return 'visible';
    const below = address.level !== frame.level;
    const origin = grid.roomOrigins.get(roomId);
    if (!origin) return below ? 'remembered' : 'visible';
    const index = (origin.ty + CENTRE_TILE) * grid.width + (origin.tx + CENTRE_TILE);
    return fogStateOf(bitsetHas(seen, index), !below && this.lit.has(roomId));
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

    const elevation = roomElevation(scene, room.pos.z, frame.level, centreX, centreZ);
    const room3d = planChunk({
      scene,
      origin,
      elevation,
      gap: frame.gap,
      faded: chunk.faded,
      doorClosed,
    });

    // M5a. Two gates, both in the file header: nothing grows on the level below, and nothing grows
    // whose baked mesh has not arrived. `planScatter` is pure and does not know about either — it is
    // asked for the room's vegetation and this is where the renderer's own conditions are applied.
    chunk.trees = 0;
    chunk.scatter = 0;
    chunk.kit = 0;
    chunk.water = false;
    let placements = room3d;
    if (!chunk.faded && (this.trees.available || this.kit.available)) {
      const grown = planScatter({ scene, origin, elevation, lod: chunk.lod }).filter((p) =>
        this.pool.hasGeometry(p.geometry),
      );
      if (grown.length > 0) {
        placements = [...room3d, ...grown];
        for (const placement of grown) {
          if (placement.archetype === 'trunk') chunk.trees += 1;
          if (placement.archetype === 'kitSolid' || placement.archetype === 'kitLeaf') chunk.kit += 1;
        }
        chunk.scatter = grown.length;
      }
    }

    // M5b's two surfaces. Both are `prototypes.ts` never-faded archetypes, so both are gated on the
    // same "this is the camera's own level" condition the scatter is — see that set's docblock for
    // why a transparent surface drawn at 30% over a transparent surface is two lies about depth.
    if (!chunk.faded) {
      const surface = planWater({ scene, origin, elevation, gap: frame.gap });
      const puddles = planPuddles({ scene, origin, elevation, free: freeTiles(scene) });
      if (surface || puddles.length > 0) {
        placements = [...placements, ...(surface ? [surface] : []), ...puddles];
        chunk.water = surface !== undefined;
      }
    }

    // Weather and light, read off the same IR the geometry came from — a second `describeRoom` here
    // would be a second chance for the two to disagree.
    chunk.roofed = scene.enclosure.roofed;
    chunk.fire = undefined;
    for (const feature of scene.features) {
      if (feature.t !== 'landmark' || feature.kind !== 'campfire') continue;
      chunk.fire = {
        x: metresOfTile(origin.tx + feature.tx) + (feature.width * METRES_PER_TILE) / 2,
        // Head height over the embers: a light *at* the fire lights the ground and nothing standing.
        y: elevation + 1,
        z: metresOfTile(origin.ty + feature.ty) + (feature.depth * METRES_PER_TILE) / 2,
      };
    }

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
          // M5a's two-layer ground blend, per instance. A no-op for every archetype that is not
          // ground — see `pool.writeBlend`, which is where "does this wrapper have the buffers"
          // is answered once rather than at every call site.
          if (p.blend && p.tint) this.pool.writeBlend(mesh, i, p.blend, p.tint);
        }
        mesh.count = slice.length;
        this.pool.finish(mesh);
        // The fog-of-war uniform, written once per build. A later state change repaints without
        // touching any of the above — see `repaint`.
        this.pool.paint(mesh, first.material, chunk.state, slice.length);
        if (first.archetype === 'portal') this.glowSet?.add(mesh);
        if (first.archetype === 'puddle') {
          // Born hidden unless it is already raining. A hidden `InstancedMesh` costs no draw call, so
          // a dry world pays nothing for the puddles it is not showing. See `setWetness`.
          mesh.visible = this.pool.wet.uWet.value > 0;
          chunk.puddles.push(mesh);
        }
        this.scene.add(mesh);
        chunk.meshes.push(mesh);
        chunk.keys.push(first.material);
      }
    }
  }

  /** Re-flag a loaded chunk's portal wrappers, for a composer built after the chunk was. */
  private registerGlow(chunk: LoadedChunk): void {
    const glow = this.glowSet;
    if (!glow) return;
    for (let i = 0; i < chunk.meshes.length; i++) {
      const mesh = chunk.meshes[i];
      if (mesh && chunk.keys[i]?.startsWith('portal')) glow.add(mesh);
    }
  }

  dispose(): void {
    this.streamer.clear();
    this.pool.dispose();
    this.lights.dispose();
    this.night.dispose();
  }
}
