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
import { dressedScenery, planFurniture, planScenery } from './furnish.ts';
import { dressable, hasRoof, occludingSides, planInterior, roofGroups, roofedRoom } from './interior.ts';
import type { Enclosure } from './indoors.ts';
import { PropsSet } from './props.ts';
import { sceneryParts } from './prototypes.ts';
import { VillageSet } from './village.ts';
import {
  METRES_PER_TILE,
  cellOriginTiles,
  cellOfPixel,
  metresOfTile,
  placeFrame,
  type PlaceFrame,
} from './frame.ts';
import { type SkyRecipe, skyAt } from './daylight.ts';
import { fadeBandsFor } from './foliage.ts';
import { KitSet } from './kit.ts';
import { LightPool, type LightRequest } from './lights.ts';
import { NightRig, shadowExtentsFor } from './night.ts';
import type { GroundFrame } from './rig.ts';
import { ScenePool, WRAPPER_CAPACITY, type LedgerSnapshot } from './pool.ts';
import { freeTiles, planScatter } from './scatter.ts';
import { ChunkStreamer, chunkKey, type ChunkAddress, type ChunkSink } from './streamer.ts';
import { TreeSet } from './trees.ts';
import { planWater } from './water.ts';
import {
  WARP_IN_SHADER,
  WarpField,
  warpFieldOf,
  warpPlacementInto,
  type WarpVec,
} from './warp.ts';
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
  /** Which lid this room is under, or `undefined` for a room with sky. See `interior.roofGroups`. */
  group: RoomId | undefined;
  /** Whether this chunk was built with its lid off — the player is under the same roof. */
  open: boolean;
  /** Where this chunk's campfire is, if it drew one. Feeds `LightPool.scene`. */
  fire: { x: number; y: number; z: number } | undefined;
  /** Which baked level of detail the trees in this chunk are drawn at. See {@link World3D.update}. */
  lod: number;
  /** Trees and tufts this chunk drew. `__debug3d.treeInstances` / `scatterInstances`. */
  trees: number;
  scatter: number;
  /** Kit instances — trees excluded, so it reads as "how much understory". `__debug3d.kitInstances`. */
  kit: number;
  /** Village modules this chunk drew — walls, floor, arches, roof. `__debug3d.villageInstances`. */
  village: number;
  /** Furniture primitives this chunk drew — M9. `__debug3d.propInstances`. */
  props: number;
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
  /** The Medieval Village kit — M6. A third registry, the same contract. See `village.ts`. */
  readonly village = new VillageSet();
  /** The Fantasy Props kit — M9. A fourth registry, and the furniture half of the interiors. */
  readonly props = new PropsSet();
  private readonly streamer = new ChunkStreamer(this);
  private readonly chunks = new Map<string, LoadedChunk>();
  private readonly scratch = new Object3D();
  /** Reused between chunk builds so a load allocates buckets rather than a new index each time. */
  private readonly buckets = new Map<string, Placement[]>();

  private context: SceneZone | undefined;
  private cells: Map<string, Room> | undefined;
  private roomsById = new Map<RoomId, Room>();
  private frameOf: PlaceFrame | undefined;
  /**
   * The domain warp over this Place — M5c. Absent until a `zone` message has arrived.
   *
   * Built here rather than in `chunkPlan.ts` because the amplitude is a property of the room
   * *lattice* and not of one room: a node's value is the `min` over the four cells that touch it (see
   * `warp.ts`), and this is the only object that holds all the cells at once. Which is also why the
   * plan stays pure — `planChunk`, `planScatter`, `planWater` and `planPuddles` all still answer in
   * the unwarped grid the collision tiles live in, and the lens is applied here, at the one place a
   * `Placement` becomes a matrix.
   */
  private warpField: WarpField | undefined;
  /** Scratch for the warp: one vector and one corner tuple for the whole session. */
  private readonly warpVec: WarpVec = { x: 0, z: 0 };
  private readonly warpCorners: number[] = [1, 1, 1, 1];
  /** Reused by {@link build}: the placements after the lens, so a chunk build allocates one array. */
  private readonly warped: Placement[] = [];
  private tiles: TileGrid | undefined;
  private seen: Uint8Array | undefined;
  /** One-entry memo for {@link groundAt}. */
  private ground: { cellX: number; cellY: number; level: number; y: number } | undefined;
  /** The cell the window is centred on. What {@link lodOf} measures a chunk's distance from. */
  private centreCell: { cellX: number; cellY: number } | undefined;
  /** Live door state, keyed `roomId:dir`. See `ChunkPlanInput.doorClosed` for why it lives outside. */
  private readonly doors = new Map<string, boolean>();

  /* ------------------------------------------------------------------- M6 */

  /**
   * Which lid each roofed room is under, for this Place. Built once in {@link setPlace}.
   *
   * One union-find over the zone's roofed rooms, which is the same shape of work `groundComponents`
   * already does per Place and costs the same nothing. See `interior.roofGroups` for why a door does
   * not break a group and a seam does.
   */
  private roofOf: ReadonlyMap<RoomId, RoomId> = new Map();
  /** The group the player is standing under, or `undefined` when they are out in the open. */
  private openGroup: RoomId | undefined;
  /** The sides a wall fades on. Re-derived whenever the rig's pitch or yaw moves; see `occludingSides`. */
  private openSides: ReadonlySet<Cardinal> = occludingSides(64).sides;
  /** The pitch the near-wall set was last derived at, so {@link setCameraYaw} can re-derive without it. */
  private cameraPitch = 64;
  /** Backing field for {@link roofCull}. On, because the cull is the mode and not an effect. */
  private cullRoofs = true;

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
  /** Backing field for {@link warpEnabled}. On, because the warp is the world's shape and not an effect. */
  private warpOn = true;

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
    // The lens for the new Place. Its node arrays are built per level on first use, so arriving
    // costs one object and the walked level's grid, not every level in the zone.
    this.warpField = warpFieldOf(zone, this.frameOf);
    this.warpField.strength = this.warpOn ? 1 : 0;
    this.tiles = buildZoneTilemap(zone, level);
    // M6. The roof groups are a property of the Place and of nothing else, so they are built here and
    // never again — a door swinging does not change one (see `interior.roofGroups`) and neither does
    // a chunk loading. `roofedRoom` rather than `describeRoom(...).enclosure.roofed` because the
    // predicate must not depend on a room's *neighbours*: a group is a walk over the graph, and a
    // membership test that itself read one hop would make the walk quadratic for no new information.
    this.roofOf = roofGroups(zone, roofedRoom);
    this.openGroup = undefined;
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
  scatterCensus(): {
    trees: number;
    instances: number;
    kit: number;
    water: number;
    village: number;
    interiors: number;
    props: number;
    furnished: number;
  } {
    let trees = 0;
    let instances = 0;
    let kit = 0;
    let water = 0;
    let village = 0;
    let interiors = 0;
    let props = 0;
    let furnished = 0;
    for (const chunk of this.chunks.values()) {
      trees += chunk.trees;
      instances += chunk.scatter;
      kit += chunk.kit;
      village += chunk.village;
      props += chunk.props;
      if (chunk.village > 0) interiors += 1;
      if (chunk.props > 0) furnished += 1;
      if (chunk.water) water += 1;
    }
    return { trees, instances, kit, water, village, interiors, props, furnished };
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
   * The hour of the game day, 0..24 — the **named hook** M5b owed, and the one the world clock landed
   * on exactly as predicted.
   *
   * M5b shipped this against a server that ticked no clock, drove it from a debug key, and wrote:
   * *"**this method is where a server clock will land** — a message handler in `main.ts` calling
   * `world.setGameHour(…)` is the whole of that future change, because everything else is already
   * downstream of this one number."* That is precisely what happened: `main.ts`'s `{t:'sky'}` handler
   * and its frame loop call this with an hour interpolated by `sky.ts`, and **nothing in this class
   * changed** — not this method, not `hourOfDay`, not one call site downstream.
   *
   * Writes the whole sky at once (`NightRig.sky`) rather than a colour at a time; `main.ts` picks the
   * exposure off the returned recipe, because the composer is its and not the scene graph's — and
   * writes a second time over the top with the weather and the enclosure folded in, which is why
   * `__debug3d.sky.recipe` can read `dawn->day (storm 0.58)` while this method only ever applied
   * `dawn->day`. Deliberate: the hour is this class's business and the weather is not.
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

  /* --------------------------------------------------------------- M5c: the warp */

  /**
   * Whether the world bends. The **V** key and `__debug3d.warpEnabled`.
   *
   * **Two writes and a rebuild, and all three are necessary.** The uniform straightens the ground and
   * the water, which displace in the shader; the field's own `strength` straightens everything that
   * displaces on the CPU; and the rebuild is what makes the second one visible, because a tree's
   * position was written into an instance matrix when its chunk was built and nothing re-reads it. A
   * rebuild is a release and an acquire and allocates nothing — the same path a door already takes —
   * so the toggle costs one frame and no memory. Flipping it and watching the lattice snap back is the
   * fastest way to see what the warp is actually doing.
   */
  get warpEnabled(): boolean {
    return this.warpOn;
  }

  set warpEnabled(on: boolean) {
    if (on === this.warpOn) return;
    this.warpOn = on;
    this.pool.warp.uWarp.value = on ? 1 : 0;
    if (this.warpField) this.warpField.strength = on ? 1 : 0;
    for (const chunk of this.chunks.values()) this.rebuild(chunk);
  }

  /** The field itself, for `main.ts`'s camera, marker and pointer. Absent before the first `zone`. */
  get warp(): WarpField | undefined {
    return this.warpField;
  }

  /**
   * The displacement at a world position on the **camera's** level, in metres, into a caller's vector.
   *
   * What `main.ts` puts the camera, the moon's shadow volume, the clearing light and the destination
   * ring through, and what `entities.ts` puts every body through. All of them are given positions in
   * the unwarped grid — a simulation position converted by `metresOfPixel` — and all of them have to
   * arrive at the same place the ground under them did, or the character walks beside the road.
   */
  warpAt(out: WarpVec, x: number, z: number): void {
    const frame = this.frameOf;
    if (!this.warpField || !frame) {
      out.x = 0;
      out.z = 0;
      return;
    }
    this.warpField.displaceInto(out, x, z, frame.level);
  }

  /**
   * The inverse — a point on the drawn ground back to the grid it belongs to. **The pointer's step.**
   *
   * See `WarpField.invertInto`. Without it a click lands wherever the field pushed that ground, which
   * at three metres is a third of a room from where the player aimed; the `seen` gate, the tile index
   * and the `moveTo` that follow it are all unwarped-grid values and none of them would know.
   */
  unwarpAt(out: WarpVec, x: number, z: number): void {
    const frame = this.frameOf;
    if (!this.warpField || !frame) {
      out.x = x;
      out.z = z;
      return;
    }
    this.warpField.invertInto(out, x, z, frame.level);
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
    this.refreshRoof();
  }

  /* ------------------------------------------------------------- M6: the lid */

  /**
   * Open the lid the player has just walked under, and close the one they have left.
   *
   * **A rebuild, not a visibility flip**, and the choice is deliberate. Hiding the ceiling wrappers
   * would be cheaper per event and would leave the *walls* solid — the near-wall fade is a material,
   * and a material is chosen when a bucket is formed. Doing half of it would allow a frame with the
   * lid off and the south wall opaque, which is a room you are looking into through a wall you cannot
   * see past: the exact failure the fade exists to prevent, arrived at by optimising the roof.
   *
   * The cost is one frame's worth of release-and-acquire on the chunks whose *group* changed, which
   * is the same path a door already takes and allocates nothing (`traversal.test.ts`'s flat ledger
   * covers it). It happens once per threshold crossed — a few times a minute at walking pace — and
   * never at all while a player walks around inside one building, because every room of an inn shares
   * one group and the comparison below is on the group id rather than on the room.
   */
  private refreshRoof(): void {
    const here = this.here;
    const group = !this.cullRoofs || here === undefined ? undefined : this.roofOf.get(here);
    if (group === this.openGroup) return;
    const was = this.openGroup;
    this.openGroup = group;
    for (const chunk of this.chunks.values()) {
      if (chunk.group === undefined) continue;
      if (chunk.group !== was && chunk.group !== group) continue;
      this.rebuild(chunk);
    }
  }

  /**
   * Which of the three light recipes this frame wants — `indoors.ts`'s question, answered from the
   * room the character is standing in and from nothing else.
   *
   * The **sector** rather than the roof group: an inn and the cellar under it are one group and two
   * different places to be, and a cave mouth that happens to link to a hut should read as a cave
   * while you are in the cave. `indoors` on a room the MUD flagged but whose sector is outdoor takes
   * the inn's recipe, which is what that flag has always meant.
   */
  get enclosure(): Enclosure {
    const here = this.here;
    const room = here === undefined ? undefined : this.roomsById.get(here);
    if (!room || !roofedRoom(room)) return 'outdoor';
    return room.sector === 'cave' ? 'cave' : 'inside';
  }

  /** The lid currently off, for `__debug3d.interior`. `undefined` means the player is out of doors. */
  get roofGroup(): RoomId | undefined {
    return this.openGroup;
  }

  /**
   * Whether lids come off over the player's head. The **K** key and `__debug3d.interior.cull`.
   *
   * M6's own A/B, in the pattern **F** set for the wind and **V** for the warp: the fastest way to
   * check the acceptance by hand is to switch the thing off and see what it was doing. Turn it off
   * standing in a tavern and the frame becomes exactly what §6-M6 forbids — *"a camera looking at the
   * top of a roof"* — which is what makes it obvious that the rest of the time it is not.
   *
   * The near-wall fade goes with it, and the two are one switch on purpose: they are one decision
   * (see `InteriorInput.roofOpen`), and a build with the lid on and the south wall see-through would
   * be a picture neither mode ever produces.
   */
  get roofCull(): boolean {
    return this.cullRoofs;
  }

  set roofCull(on: boolean) {
    if (on === this.cullRoofs) return;
    this.cullRoofs = on;
    this.refreshRoof();
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
  /**
   * The rig moved — M6, and the one call that carries a new frame to everything derived from it.
   *
   * Two consumers and both would otherwise be tuned to a pose the camera has left. The undergrowth's
   * fade band is a view-depth window and the frame's view depths run from 31.8..41.4 m at the default
   * pose to 37.9..65.6 m at the far corner of the clamp, so a fixed band either dissolves the ground
   * in front of the character or never fades at all. The moon's shadow volume is a box that must
   * contain the visible ground, and the visible ground more than doubles across the same range.
   *
   * Called from `main.ts` whenever the wheel moves and on every resize — the frame's *width* is the
   * canvas aspect's business as much as the rig's. Idempotent and cheap: two uniform writes per
   * understory material and one shadow-camera refit, both of which happen anyway.
   */
  setCameraFrame(frame: GroundFrame, pitchDegrees?: number, yawRadians = 0): void {
    const bands = fadeBandsFor(frame);
    this.pool.setFadeBands(bands.grass, bands.kitLeaf);
    const extents = shadowExtentsFor(frame);
    // The extents are in the camera's own axes, so the yaw goes with them or the box is the right
    // size in the wrong quarter of the world. See `night.fitShadowCamera`.
    this.night.setExtents(extents.width, extents.depth, yawRadians);
    // **M8: the day the yaw opened.** M6 wrote this line and left the rebuild out on the grounds that
    // `occludingSides` returned the same object at every pitch, so the assignment was a no-op — and
    // noted that "the day the yaw opens, the set changes and every wall in the window has to be
    // rebuilt against the new one".
    //
    // The rebuild it declined to do is here, and it is affordable for one reason: `open` is
    // `roofOpen && openSides.has(dir)`, so a chunk whose lid is *on* cannot care what the set says.
    // The walk is therefore over the chunks of the one building the player is standing under — the
    // same set `refreshRoof` rebuilds when they cross its threshold, by the same release-and-acquire
    // that allocates nothing — and out of doors, which is most of the time, it is a comparison and
    // nothing else. The set is compared by identity (`interior.OCCLUDING_SETS`), so an orbit costs
    // one rebuild per quadrant crossed rather than one per frame.
    if (pitchDegrees === undefined) return;
    this.cameraPitch = pitchDegrees;
    this.refreshNearWall(yawRadians);
  }

  /**
   * The yaw alone — M8's follow mode, which moves it every frame while the camera is swinging.
   *
   * Deliberately **not** `setCameraFrame` with the same frame: two of that call's three consumers
   * are functions of the view *depth* and the frame's *size*, and a yaw changes neither. Routing an
   * ease through the full call would rewrite every foliage material's fade uniform sixty times a
   * second to the value it already held, for a second at a time, every time the player turned a
   * corner. What genuinely turns is the shadow box and the near-wall set, and both are here.
   */
  setCameraYaw(yawRadians: number): void {
    const half = this.night.extents;
    this.night.setExtents(half.width, half.depth, yawRadians);
    this.refreshNearWall(yawRadians);
  }

  private refreshNearWall(yawRadians: number): void {
    const sides = occludingSides(this.cameraPitch, yawRadians).sides;
    if (sides === this.openSides) return;
    this.openSides = sides;
    if (this.openGroup === undefined) return;
    for (const chunk of this.chunks.values()) {
      if (chunk.group !== undefined && chunk.group === this.openGroup) this.rebuild(chunk);
    }
  }

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
      group: this.roofOf.get(room.id),
      open: false,
      fire: undefined,
      lod: this.lodOf(address),
      trees: 0,
      scatter: 0,
      kit: 0,
      village: 0,
      props: 0,
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

    // M6, and the three questions a lid needs answered. **`open` is the group's, not the room's** —
    // walk into an inn's taproom and the kitchen behind it loses its ceiling too, because they are
    // one building and a lid that came off room by room would be a roof with a hole travelling
    // across it. `top` is "is there open air over this cell", which is the one question that needs
    // the level *above* — the only place in the renderer that looks up, and it looks at the room
    // index rather than at a chunk, because the level above is hard-culled and has none.
    const group = chunk.group;
    const open = group !== undefined && group === this.openGroup;
    const top = !cells.has(cellKey(room.pos.x, room.pos.y, room.pos.z + 1));
    // The dressing is gated on the *complete* shell being loadable — see `VillageSet.available` —
    // and on this not being the level below, which is `prototypes.NEVER_FADED`'s rule for every
    // other art layer in this renderer.
    const dressed = !chunk.faded && this.village.available && dressable(scene);
    // M9. Which scenery props a kit is standing a model in for — derived once, used twice:
    // `planChunk` drops their grey box and `planScenery` draws the model. Gated on the level and on
    // the individual geometry, so a half-loaded pack leaves the box where it was rather than leaving
    // the floor bare.
    //
    // **The per-pack `available` flag is deliberately not consulted, and M9b is why.** A stand-in now
    // comes from any of three registries (`prototypes.SCENERY_PACKS`) and a room can hold props from
    // two of them at once, so a single pack's flag would be the wrong question asked once. The right
    // one is per placement and this filter already asks it: every primitive of the chosen model has
    // to be in the pool before its box is suppressed.
    const scenery = chunk.faded
      ? []
      : dressedScenery(scene).filter(({ entry }) =>
          sceneryParts(entry, chunk.lod).every((part) => this.pool.hasGeometry(part.geometry)),
        );
    const dressedKinds = scenery.length > 0 ? new Set(scenery.map(({ feature }) => feature.kind)) : undefined;
    chunk.open = open;
    const room3d = planChunk({
      scene,
      origin,
      elevation,
      gap: frame.gap,
      faded: chunk.faded,
      doorClosed,
      // `hasRoof` is asked here and again inside `planInterior`, from the same scene and the same
      // `top`, because the slab and the gable must never both appear or both be missing.
      roof: open ? 'open' : dressed && hasRoof(scene, top) ? 'kit' : 'slab',
      dressed,
      ...(dressedKinds ? { dressedScenery: dressedKinds } : {}),
    });

    // M5a. Two gates, both in the file header: nothing grows on the level below, and nothing grows
    // whose baked mesh has not arrived. `planScatter` is pure and does not know about either — it is
    // asked for the room's vegetation and this is where the renderer's own conditions are applied.
    chunk.trees = 0;
    chunk.scatter = 0;
    chunk.kit = 0;
    chunk.village = 0;
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

    // M6's dressing, on the same gate and after the same filter: a placement whose village module
    // has not registered is dropped rather than drawn as a box, which is the rule the trees and the
    // kit already live by. `dressed` above is the *shell's* gate and is all-or-nothing; this filter
    // is the garnish's and is per placement, so a roof that failed to load costs a roof and not a
    // house.
    if (dressed) {
      const inside = planInterior({
        scene,
        origin,
        elevation,
        roofOpen: open,
        top,
        openSides: this.openSides,
      }).filter((p) => this.pool.hasGeometry(p.geometry));
      if (inside.length > 0) {
        placements = [...placements, ...inside];
        chunk.village = inside.length;
      }
    }

    // M9's furniture, on the same gate and after the same per-placement filter. Two conditions
    // beyond the kit having loaded, and both are the interior dressing's own: the level below is not
    // furnished, and a room the village has not dressed is a grey shell that a bookcase standing in
    // it would only make stranger. `planFurniture` refuses everything `dressable` refuses anyway —
    // that is what keeps `pool.DRESSED_WRAPPER_CEILING` a `max` — so this is the renderer's half of
    // a decision the planner has already made, stated where the other three layers state theirs.
    chunk.props = 0;
    if ((dressed && this.props.available) || scenery.length > 0) {
      const furniture = [
        ...(dressed && this.props.available
          ? planFurniture({ scene, name: room.name, flags: room.flags, origin, elevation })
          : []),
        ...(scenery.length > 0 ? planScenery({ scene, origin, elevation, lod: chunk.lod }) : []),
      ].filter((p) => this.pool.hasGeometry(p.geometry));
      if (furniture.length > 0) {
        placements = [...placements, ...furniture];
        chunk.props = furniture.length;
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
      const fireX = metresOfTile(origin.tx + feature.tx) + (feature.width * METRES_PER_TILE) / 2;
      const fireZ = metresOfTile(origin.ty + feature.ty) + (feature.depth * METRES_PER_TILE) / 2;
      // Through the lens with the cone it lights — a light left in the grid would shine from beside
      // the fire, and at three metres that is a campfire whose glow is in the next room's hedge.
      this.warpOf(this.warpVec, fireX, fireZ, chunk.address.level);
      chunk.fire = {
        x: fireX + this.warpVec.x,
        // Head height over the embers: a light *at* the fire lights the ground and nothing standing.
        y: elevation + 1,
        z: fireZ + this.warpVec.z,
      };
    }

    // M5c. **One lens, applied once, at the only place a plan becomes a matrix.** Continuous
    // surfaces keep their unwarped transform and are handed their four corner amplitudes instead, so
    // their vertices displace in the shader and no two adjacent slabs can open a crack; everything
    // else moves here — whole if it is an object, as a chain of chords if it is a wall. See
    // `warp.ts`'s `WARP_IN_SHADER` for the line between the two and why no shadow can come adrift.
    placements = this.applyWarp(placements, chunk.address.level);

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
          // M5c's corner amplitudes, on the same two families and by the same no-op rule.
          if (WARP_IN_SHADER.has(p.archetype)) {
            this.warpCornersOf(p, chunk.address.level);
            this.pool.writeWarp(mesh, i, this.warpCorners);
          }
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

  /* ------------------------------------------------------------- M5c: the lens */

  /** The field at a point on a named level, or nothing at all before a Place has arrived. */
  private warpOf(out: WarpVec, x: number, z: number, level: number): void {
    if (!this.warpField) {
      out.x = 0;
      out.z = 0;
      return;
    }
    this.warpField.displaceInto(out, x, z, level);
  }

  /**
   * A shader-warped surface's four corner amplitudes, into {@link warpCorners}.
   *
   * Zero when there is no field and when the warp is switched off — the shader multiplies the field
   * by this, so a zero corner is a vertex that does not move at all, and the **V** key's "off" is
   * therefore the geometry M5b shipped rather than a warp that happens to be small.
   */
  private warpCornersOf(placement: Placement, level: number): void {
    const field = this.warpField;
    if (!field || field.strength === 0) {
      this.warpCorners[0] = 0;
      this.warpCorners[1] = 0;
      this.warpCorners[2] = 0;
      this.warpCorners[3] = 0;
      return;
    }
    field.cornersInto(this.warpCorners, placement.x, placement.z, placement.sx, placement.sz, level);
  }

  /**
   * Every rigid placement in a chunk, displaced. The surfaces pass through untouched.
   *
   * Returns the input array unchanged when there is no field yet — so the frame between `welcome` and
   * the first `zone` draws the plan as written rather than nothing at all — and **when the warp is
   * switched off**, which is what makes the **V** key an honest A/B: a wall bent into four collinear
   * chords is the same picture as one wall, but it is not the same instance count, and the comparison
   * the owner is making is against the geometry M5b actually shipped. The output array is reused
   * across builds for the reason everything else here is: a chunk build is a hot path.
   */
  private applyWarp(placements: readonly Placement[], level: number): readonly Placement[] {
    const field = this.warpField;
    if (!field || field.strength === 0) return placements;
    const out = this.warped;
    out.length = 0;
    for (const placement of placements) {
      if (WARP_IN_SHADER.has(placement.archetype)) out.push(placement);
      else warpPlacementInto(out, placement, field, level, this.warpVec);
    }
    return out;
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
