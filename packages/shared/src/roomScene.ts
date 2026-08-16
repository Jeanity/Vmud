/**
 * The scene IR — Layer B of `docs/PLAN-3d-migration.md` §4, milestone M2.
 *
 * `describeRoom` turns one room and its four neighbours into a **description of a place**: what
 * ground it stands on, what closes it in on each side, how high it sits, what stands in it. Nothing
 * here draws anything. It is pure, deterministic, free of I/O, of `three`, of the DOM and of Node, so
 * the same function answers in the offline baker, in a future client and in a plain `node --test`
 * with no GPU anywhere near it. That is the single decision that makes 46,544 procedurally dressed
 * rooms tractable, and it survives being wrong about the engine, the art or the look — a 2D renderer
 * would be just as happy to place better tiles from it.
 *
 * ## The purity contract, and its one honest exception
 *
 * **`describeRoom` reads the room and its 1-neighbourhood and nothing else.** The explicit
 * `neighbours` parameter is what makes that a contract rather than a promise: there is no zone to
 * walk, no index to consult, no way to reach a second-degree room even by accident. The consequence
 * the plan warns about is real and cuts both ways — because blend weights and edge classes read
 * neighbours, **editing one room's sector changes up to four other rooms' scenes**, and any override
 * layer has to re-derive the neighbours of everything it touches. See `roomScene-overrides.ts`.
 *
 * The exception is the **ground component** (output 2), which is a connected-component id and
 * therefore global by nature: no amount of local information can tell a room which region of ground
 * it belongs to. So it is computed *once per zone* by {@link groundComponents} and handed in as part
 * of {@link SceneZone}. The contract restated precisely: **given a fixed {@link SceneZone}, the
 * output depends only on the room and its four cardinal neighbours.** The component index has a wider
 * blast radius than one room — changing a sector can split or merge a region and move the base
 * elevation of every room in it — and that, too, is written down in the override notes.
 *
 * There is now a **second** index on {@link SceneZone} of exactly the same shape and for exactly the
 * same reason: {@link roomsUnderAStorey}, which answers "is there a room on top of this one". That is
 * a *vertical* neighbour, and the cardinal neighbourhood cannot see it any more than it can see a
 * component id. It exists because {@link GIANT_CEILING} does not fit inside
 * {@link LEVEL_SEPARATION} — see that function for the measurement and the cost.
 *
 * ## Where the numbers came from
 *
 * Everything below marked "measured" was swept over the built world in `data/world/zones` while this
 * file was written (46,544 rooms, 328 zones, 186,176 cardinal edges), not taken from the plan on
 * trust. Three of those measurements changed the design:
 *
 * 1. **The plan's safety claim holds completely.** All **103,218** same-level non-portal cardinal
 *    exits land on the exact grid neighbour, with **zero** mismatches. That is what makes "no exit in
 *    this direction" mean "there is a boundary here" and the whole edge classification safe.
 * 2. **`portal` is all but extinct once seams are excluded** — see {@link EDGE_KINDS} for the ruling
 *    and its reasoning. 5,142 cardinal edges look like portals; **5,140 of them are seams**.
 * 3. **283 directed `barrier` edges have a corridor carved across them** by the far room's one-way
 *    exit. The plan's table has no cell for that, and calling them solid would have put a wall where
 *    the collision grid has floor. They classify as the crossing they are, flagged {@link
 *    SceneEdge.inbound}.
 *
 * ## What this file deliberately does not do
 *
 * No geometry, no noise evaluation, no camera. The IR carries the *inputs* that make displacement
 * deterministic ({@link GroundNoise}) and the renderer evaluates the field at a world position; the
 * multi-level camera policy is M3's and is not decided here. And it invents no second prop system:
 * a room's props are `tilemap.sceneryOf`'s answer, unchanged, because those tiles are already solid
 * in the collision grid and a parallel list could disagree with it.
 */

import {
  SCATTER_BLOCKS,
  SCATTER_BLOCK_TILES,
  SCENERY,
  type SceneryKind,
} from './scenery.ts';
import {
  CONNECTOR_WIDTH,
  OUTDOOR_SECTORS,
  ROOM_STRIDE,
  ROOM_TILES,
  STAIR_TILES,
  connectorSpan,
  sceneryOf,
  stairPlacement,
} from './tilemap.ts';
import {
  DIRECTION_DELTA,
  OPPOSITE,
  cellKey,
  type Direction,
  type Room,
  type RoomId,
  type Sector,
  type Zone,
  type ZoneId,
} from './world.ts';

/* -------------------------------------------------------------------------- */
/* Directions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four sides a room has.
 *
 * A scene's edges are cardinal only, and `up`/`down` are deliberately absent: a vertical exit is not
 * a side of the room, it is a *thing in* the room — a stairwell or a ramp — and it appears in
 * {@link RoomScene.features} keeping its `exit.to`, exactly as M0's `grid.stairs` does.
 */
export const CARDINALS = ['north', 'east', 'south', 'west'] as const satisfies readonly Direction[];

export type Cardinal = (typeof CARDINALS)[number];

/* -------------------------------------------------------------------------- */
/* The determinism contract                                                    */
/* -------------------------------------------------------------------------- */

/** Murmur3's 32-bit finalizer. Not cryptographic; only well spread, which is all any of this needs. */
function fmix32(input: number): number {
  let h = input | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The scene seed for a cell — the plan's `hashCell(x, y, z)`, and the reason every client places the
 * same tree in the same spot with zero server traffic.
 *
 * **This is the third positional hash in the project and the other two must not move.** They answer
 * different questions and the difference is worth stating once, here, because the temptation to
 * "unify" them would silently move the shipped world:
 *
 * | Hash | Lives in | Keyed on | What it decides |
 * |---|---|---|---|
 * | `hashRoom` | `scenery.ts` (private) | room id + salt | which props `scatterFor` grows and where |
 * | `hashTile` | `client/src/scene.ts` (private) | tile x,y | which frame of a tile sheet is painted |
 * | `hashCell` | here | cell x,y,z + salt | everything a {@link RoomScene} chooses |
 *
 * `scatterFor`'s output is *shipped world state* — the props it returns are solid tiles that both
 * the server and every client stamp — so re-hashing it would move bushes players have already walked
 * round. `hashTile` is pure paint but is the client's own and equally none of this file's business.
 * So this is a **new** hash standing alongside them, with its own constants, and the whole-world
 * sweep asserts that a room's props still equal `sceneryOf`'s answer byte for byte.
 *
 * `salt` exists because **cell coordinates in this codebase are per zone, not global** — the plan
 * predates that being explicit. Zone 390's cell (2,0,0) and zone 317's are the same three numbers
 * and would otherwise grow the same tree; {@link sceneSeed} folds the zone id in here.
 */
export function hashCell(x: number, y: number, z: number, salt = 0): number {
  const mixed =
    (0x9e3779b9 ^
      Math.imul(x | 0, 0x27d4eb2d) ^
      Math.imul(y | 0, 0x165667b1) ^
      Math.imul(z | 0, 0x1b873593) ^
      Math.imul(salt | 0, 0x9e3779b1)) |
    0;
  return fmix32(fmix32(mixed));
}

/**
 * One decision derived from a scene seed.
 *
 * Every choice a scene makes goes through this with its own salt, so adding a decision cannot
 * perturb the ones already made — the failure mode of a running RNG, where inserting one draw
 * reshuffles the whole world downstream of it.
 */
function sceneHash(seed: number, salt: number): number {
  return fmix32((seed ^ Math.imul(salt | 0, 0x9e3779b1)) | 0);
}

/*
 * Salts. Distinct primes-ish integers; the values are arbitrary and only have to stay put, because
 * changing one re-rolls that decision for the whole world.
 */
const SALT_THEME = 0x7a1e;
const SALT_GROUND_BASE = 0x1d05;
const SALT_LANDMARK_ROLL = 0x3c11;
const SALT_LANDMARK_KIND = 0x3c12;
const SALT_LANDMARK_BLOCK = 0x3c13;
const SALT_LANDMARK_JITTER = 0x3c20;

/**
 * The seed for one room's scene: its cell, salted with its zone.
 *
 * Callers may pass any number they like to {@link describeRoom} — the parameter is the plan's, and a
 * baker experimenting with a whole-world reseed wants it — but this is the answer the shipped world
 * uses, and getting it wrong is invisible until two zones grow identical forests.
 */
export function sceneSeed(zone: SceneZone, room: Room): number {
  return hashCell(room.pos.x, room.pos.y, room.pos.z, zone.id);
}

/* -------------------------------------------------------------------------- */
/* Biome                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-zone themes, so two forest zones are not the same forest.
 *
 * Four rather than forty on purpose: a theme is a *material set* the renderer has to actually own —
 * bark, needle, ground and undergrowth variants — and an IR that names twenty of them is writing
 * cheques the art budget cannot cash. Measured: 74.0% of rooms share their name with another room in
 * the same zone, so per-zone theming plus {@link RoomScene.seed} and the landmark slot are the whole
 * defence against monotony. See the plan's risk 4.
 */
export const THEME_COUNT = 4;

/** Deterministic from the zone id alone, so a zone looks the same on every client and every restart. */
export function zoneTheme(zoneId: ZoneId): number {
  return sceneHash(zoneId, SALT_THEME) % THEME_COUNT;
}

/**
 * How far a neighbour's ground reaches across one shared edge.
 *
 * Not a transition *set*. Measured on today's world: **104 distinct sector pairs occur across linked
 * cardinal neighbours** — 105 counting seams, 108 counting every boundary with a known room on the
 * far side — and 61 of them occur fewer than 50 times each. The plan predicted 98 and was close
 * enough to be making the right point. Hand-authored transition art for a hundred pairs is not a
 * thing anyone will finish, so the ground material blends two biome layers by vertex weight and one
 * shader handles every pair.
 */
export interface BiomeBlend {
  readonly dir: Cardinal;
  /** The ground on the other side. Only ever present when it differs from the room's own. */
  readonly sector: Sector;
  /**
   * Weight at the shared edge, 0 at the room's centre. Derived from the opening the collision grid
   * cuts rather than chosen: `(span / ROOM_TILES) x (a door halves it again)`, so two merged outdoor
   * rooms meet halfway across their whole shared edge (0.5) while a three-tile corridor drags only a
   * sixth of the far ground in (0.167) and a doorway a twelfth (0.083). The blend then follows the
   * geometry instead of drifting from it.
   */
  readonly weight: number;
}

export interface SceneBiome {
  /** The room's own repaired sector — M1's output, and after M1 it is art direction, not a detail. */
  readonly sector: Sector;
  /** 0..{@link THEME_COUNT}-1, from the zone id. */
  readonly theme: number;
  /** One entry per crossable edge whose far ground differs, in {@link CARDINALS} order. */
  readonly blend: readonly BiomeBlend[];
}

/* -------------------------------------------------------------------------- */
/* Ground components                                                           */
/* -------------------------------------------------------------------------- */

/** {@link GroundPlan.component} for a room whose ground is nobody else's — every indoor room. */
export const NO_GROUND_COMPONENT = -1;

/**
 * Which rooms share one continuous piece of ground, per zone.
 *
 * The plan is explicit that ground is **not per room**: it is built per *component region*,
 * subdivided and displaced as one mesh, because that is the only way neighbouring rooms agree at
 * their seam without talking to each other. The predicate is the plan's — linked, same level, both
 * outdoor — and "outdoor" is {@link OUTDOOR_SECTORS}, the very set `connectorSpan` merges across.
 * That is not a coincidence to be tidied away later: a component is exactly "the rooms whose
 * walkable ground the carve joined up", so a second set would describe ground the collision grid
 * does not have.
 *
 * Three details that are decisions rather than implementation:
 *
 * - **Links are followed both ways.** 392 cardinal links in the built world are one-way. A directed
 *   flood fill would put a one-way pair in one component or two depending on which room the zone file
 *   happened to list first, and a component id that depends on file order is not stable.
 * - **Portals and seams do not join ground.** A seam's far side is another zone's coordinate frame
 *   and so another mesh, however continuous the fiction is.
 * - **The id is the smallest room id in the component**, not an iteration counter, so it is stable
 *   under any traversal order and legible in a dump.
 *
 * Measured: **1,958 components** over the world covering all 18,818 outdoor rooms — mean 9.6, largest
 * 494, 823 of them singletons. (A directed fill gives 1,971, which is the one-way-link bug above
 * showing up as thirteen regions that should have been one with their neighbour.)
 */
export interface GroundIndex {
  /** Component id per room. Rooms with no shared ground are absent. */
  readonly of: ReadonlyMap<RoomId, RoomId>;
  /** Rooms per component, keyed by component id — one mesh's worth of work, for a builder sizing it. */
  readonly sizes: ReadonlyMap<RoomId, number>;
}

export function groundComponents(zone: Zone): GroundIndex {
  const byId = new Map<RoomId, Room>();
  for (const room of zone.rooms) byId.set(room.id, room);

  // Undirected adjacency first, then the fill — see the note above on one-way links.
  const links = new Map<RoomId, RoomId[]>();
  const join = (a: RoomId, b: RoomId): void => {
    const list = links.get(a);
    if (list) list.push(b);
    else links.set(a, [b]);
  };
  for (const room of zone.rooms) {
    if (!OUTDOOR_SECTORS.has(room.sector)) continue;
    for (const dir of CARDINALS) {
      const exit = room.exits[dir];
      if (!exit || exit.portal) continue;
      const next = byId.get(exit.to);
      if (!next || next.pos.z !== room.pos.z || !OUTDOOR_SECTORS.has(next.sector)) continue;
      join(room.id, next.id);
      join(next.id, room.id);
    }
  }

  const of = new Map<RoomId, RoomId>();
  const sizes = new Map<RoomId, number>();
  const seen = new Set<RoomId>();
  for (const start of zone.rooms) {
    if (seen.has(start.id) || !OUTDOOR_SECTORS.has(start.sector)) continue;
    const members: RoomId[] = [];
    const stack: RoomId[] = [start.id];
    seen.add(start.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      members.push(id);
      for (const next of links.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    let component = members[0]!;
    for (const id of members) if (id < component) component = id;
    for (const id of members) of.set(id, component);
    sizes.set(component, members.length);
  }
  return { of, sizes };
}

/* -------------------------------------------------------------------------- */
/* Elevation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The one noise field the whole world's outdoor ground is displaced by.
 *
 * **World-constant on purpose.** The plan's argument for keying displacement on world position is
 * that neighbouring chunks then agree at their seams *without communicating*; a per-zone or
 * per-component seed would reintroduce exactly the mismatch that buys. What varies per component is
 * {@link ElevationPolicy} `base`, and what varies per room is the amplitude its biome asks for.
 */
export const GROUND_NOISE_SEED = 0x3d9a11e5;

/**
 * Cycles per metre. One tile is one metre ({@link space.WORLD_SCALE}), so this is one full undulation
 * every two room strides — low frequency, as the plan asks, because ground that ripples per room
 * reads as a golf course rather than as terrain.
 */
export const GROUND_NOISE_FREQUENCY = 1 / (2 * ROOM_STRIDE);

/** Metres of peak displacement, by biome. The plan's +/-0.15 m is the default; landscape raises it. */
const GROUND_AMPLITUDE: Readonly<Partial<Record<Sector, number>>> = {
  mountain: 0.7,
  hills: 0.45,
  desert: 0.25,
  forest: 0.2,
  swamp: 0.1,
  road: 0.08,
  city: 0.05,
};

const GROUND_AMPLITUDE_DEFAULT = 0.15;

/** Half-range of a component's base offset, in metres. A hillside, not a staircase. */
export const GROUND_BASE_METRES = 1.5;

/**
 * Metres between two stacked interior levels: floor slab, headroom, ceiling.
 *
 * Only ever applied where a stack is genuinely roofed. Measured: **13.0% of occupied columns hold
 * rooms at more than one z and the deepest stack is 21** (The Comarian Mines), which at a 64 degree
 * camera is either a floating layer cake or interpenetrating geometry if `pos.z` is used as terrain
 * height outdoors. That is the mistake this split exists to make impossible.
 *
 * **It is also the ceiling on how high a ceiling can be.** Four metres holds a 3 m room and its
 * 0.2 m slab with 0.8 m to spare and cannot hold a 6 m one at all, which is why
 * {@link roomsUnderAStorey} exists and why 33 of the 123 spawns that are too tall for their room are
 * still too tall for it. Raising this per zone is the slice that would finish the job, and it is
 * bigger than it looks: the number is read by the stacked policy, by the continuous one (so both
 * halves of a mixed zone agree), by `chunkPlan.planStair`'s rise and by the camera rig's clamps.
 */
export const LEVEL_SEPARATION = 4;

/** Inputs a renderer needs to displace a component's ground identically to every other client. */
export interface GroundNoise {
  readonly seed: number;
  /** Cycles per metre. */
  readonly frequency: number;
  /** Peak displacement in metres, either side of the base. */
  readonly amplitude: number;
}

/**
 * Which of the two vertical policies this room lives under — the plan's §4.5, and the place a naive
 * design breaks.
 *
 * - `continuous`: the room takes its height from the noise field plus its component's base offset. A
 *   z-level outdoors means "a different part of the hill", never "a slab four metres up".
 * - `stacked`: the room is roofed, so its level is a real floor at a real height with a slab and a
 *   ceiling between it and the one below.
 */
export type ElevationPolicy =
  | {
      readonly t: 'continuous';
      /** Metres, shared by every room in the ground component. 0 for a room that has none. */
      readonly base: number;
      readonly noise: GroundNoise;
    }
  | {
      readonly t: 'stacked';
      /** The room's own `pos.z`. */
      readonly level: number;
      readonly separation: number;
      /** `level * separation`, spelled out so a renderer never re-derives it differently. */
      readonly height: number;
    };

/** Output 2 and output 5 together: which ground this room is part of, and how high it sits. */
export interface GroundPlan {
  /** {@link GroundIndex} id, or {@link NO_GROUND_COMPONENT}. */
  readonly component: number;
  readonly elevation: ElevationPolicy;
}

/**
 * Sectors that have a roof over them, and therefore a floor under them at a discrete height.
 *
 * **Deliberately not {@link OUTDOOR_SECTORS} inverted.** That set answers "does the walkable ground
 * merge across this boundary", which is false for a city street and a mountainside alike — and a
 * mountain rendered as a stack of four-metre slabs would be absurd. This set answers a different
 * question, "is there sky", and only `inside`, `cave` and the `indoors` room flag say no. Measured:
 * 40.5% of rooms by sector, plus 2,708 rooms carrying the flag.
 */
const ROOFED_SECTORS: ReadonlySet<Sector> = new Set<Sector>(['inside', 'cave']);

function isRoofed(room: Room): boolean {
  return ROOFED_SECTORS.has(room.sector) || (room.flags?.includes('indoors') ?? false);
}

/* -------------------------------------------------------------------------- */
/* How high the lid is                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Metres of headroom under an ordinary lid — the number the whole world was built at.
 *
 * It is the **kit's own storey height**, not a taste: `Corner_Exterior_Wood` is exactly 3.000 m to
 * its wall plate and the `Wall_*` panel 3.1227 m to the top of its eave lip, so a 3 m ceiling puts
 * its underside on the plate and swallows the 12 cm lip inside the slab. `client3d`'s
 * `DIMENSIONS.ceilingHeight` is the same number seen from the renderer's side and
 * `interior.test.ts` asserts the two agree.
 */
export const STANDARD_CEILING = 3;

/**
 * Metres of headroom in a giant-folk zone — **two courses of the same wall, and nothing else moves.**
 *
 * Owner's ruling, 2026-08-13: *"we'll need to assign zones as giant folk or something and raise the
 * roof to something like 6m."* Six rather than five or seven because it is exactly `2 x
 * {@link STANDARD_CEILING}`, and the wall is a fixed 3.1227 m Quaternius module that is never scaled
 * vertically: a second course seated at 3.000 m puts its head at 6.1227 m, which stands the same
 * **0.1227 m** proud of a 6 m slab that one course stands proud of a 3 m one. A tall room is
 * literally a normal room built twice — no stretching, no new art, no new bucket in the pool.
 *
 * The measurement that made it necessary: since the race scale landed (`a59cacf`) a mob is drawn at
 * `appearance.SIZE_SCALE` of the 1.81 m base body, so a `SIZE_GIANT` stands at **4.978 m** and a
 * `SIZE_HUGE` ogre at **3.620 m** — both taller than the lid over their heads. Swept over the built
 * world's 49 harvested spawn files: **123 mob resets stand in a roofed room they do not fit in**,
 * 115 giants and 8 ogres. Trolls are the near miss and are fine — `MODEL_HEIGHT.Troll` is 2.709 m,
 * which clears 3 m with 29 cm to spare — so this is a giant-and-ogre problem and nothing else.
 */
export const GIANT_CEILING = 6;

/**
 * The zones whose interiors are built for giant folk — **enumerated, because the derivation is a
 * join across four files and a closed list is the honest way to carry the answer.**
 *
 * A zone is here when any of its **roofed** rooms holds a mob drawn taller than
 * {@link STANDARD_CEILING}. Roofed is {@link ROOFED_SECTORS} or the `indoors` flag; drawn height is
 * `appearance.drawnHeightOf(model, scale)` over `appearanceOf`'s answer for the harvested template's
 * `sprite` and `race`. Re-derived from `data/world/spawns` and `data/world/zones` on 2026-08-16 and
 * it came out at exactly these eighteen — the same list the owner's own sweep produced.
 *
 * ```
 *   225  Jotunheim                        56 tall spawns   G x56
 *   198  The Defense of Longhollow        18               G x18
 *    37  The Fog Enshrouded Wood          13               G x13
 *   255  The Ruins of Undermountain I     10               G x8, PO x2
 *    36  IceCrag Castle                    7               G x7
 *   120  Labyrinth of No Return            3               G x3
 *    25  The Troll Hills                   2               PO x2
 *   218  The Ruins of Undermountain II     2               PO x2
 *   300  New Cavecity                      2               G x2
 *   305  Lava Tubes One                    2               G x2
 *     6  Caves of Mt. Skelenak             1               PO — Goortok
 *    61  Leuthilspar - City of Elves       1               G  — the great oak tree
 *    85  The Citadel                       1               G  — the guardian
 *   121  Desert City of Nizari             1               G  — the sultan of Nizari
 *   257  Myrloch Vale                      1               G  — the warlord of fire
 *   267  Myth Unnohyr                      1               PO — a hulking ogre
 *   303  The_Wildland_Trails               1               G  — a verbeeg giant
 *   352  The Temple of Blipdoolpoolp       1               G  — Sir Epho
 * ```
 *
 * **Zone-wide rather than room-wide, deliberately.** The four single-spawn oddities at the bottom
 * were put to the owner and not vetoed: over-reaching costs *"an elven city has high ceilings"*,
 * which reads as grandeur, and under-reaching costs a giant's head through a roof, which reads as a
 * bug. It also keeps a zone one place rather than a hall that changes height at a doorway.
 *
 * **A list and not an override file.** `roomScene-overrides.ts` looks like the natural home and is
 * not: its own header says *"Nothing reads it yet"* and that a half-wired loader costs a debugging
 * session. This is the idiom `appearance.RACE_SIZE` and `prototypes.CHARACTER_TEXTURES` already use —
 * enumerated in code, with the derivation written down beside it — and the day M8 builds the
 * override pipeline this is one of the facts it should absorb.
 *
 * A zone id is the MUD's own number and is never renumbered, so this list cannot rot by renaming.
 */
export const GIANT_FOLK_ZONES: ReadonlySet<ZoneId> = new Set<ZoneId>([
  6, 25, 36, 37, 61, 85, 120, 121, 198, 218, 225, 255, 257, 267, 300, 303, 305, 352,
]);

/** Metres of headroom a zone builds its interiors at. {@link GIANT_FOLK_ZONES} or the standard. */
export function zoneCeiling(zoneId: ZoneId): number {
  return GIANT_FOLK_ZONES.has(zoneId) ? GIANT_CEILING : STANDARD_CEILING;
}

/**
 * Rooms with **another room standing directly on top of them** — the one thing that can take a tall
 * ceiling away again, and the reason it is computed per zone rather than per room.
 *
 * {@link LEVEL_SEPARATION} is four metres, and a lid has to fit inside it: a 6 m ceiling under a
 * storey would put the slab **two metres above the floor of the room over it**, and since the
 * streaming window draws the camera's level *and the one below* (`streamer.WINDOW_LEVELS`), that
 * slab is not hidden by anything — it is a grey lid hanging at chest height in the room upstairs.
 * So a room with a storey on it keeps {@link STANDARD_CEILING} whatever its zone says.
 *
 * Measured over the eighteen: **447 of their 2,368 roofed rooms** have a room in the cell above,
 * 416 of them roofed too — concentrated in The Citadel (157 of 197) and IceCrag Castle (86 of 182),
 * which is a loaded zone, so this is not a theoretical case. The cost is stated rather than hidden:
 * **33 of the 123 too-tall spawns stand in one of those rooms** and keep a lid they do not fit
 * under. Raising them needs a per-zone {@link LEVEL_SEPARATION}, which moves stair rise, camera
 * anchoring and the elevation of every outdoor room in the zone — a slice of its own, not this one.
 *
 * This is a **vertical** neighbour, which is exactly why it is here and not inside `describeRoom`:
 * the module header's contract is that a scene depends on the room and its four *cardinal*
 * neighbours, and the honest way to widen it is the way {@link groundComponents} already did —
 * compute it once per zone and hand it in on {@link SceneZone}. The predicate is the renderer's own
 * `top` inverted (`world3d.ts` asks `!cells.has(cellKey(x, y, z + 1))`), read off the same cell
 * index, so the two cannot disagree about which rooms have open air over them.
 */
export function roomsUnderAStorey(zone: Zone): ReadonlySet<RoomId> {
  const occupied = new Set<string>();
  for (const room of zone.rooms) occupied.add(cellKey(room.pos.x, room.pos.y, room.pos.z));
  const under = new Set<RoomId>();
  for (const room of zone.rooms) {
    if (occupied.has(cellKey(room.pos.x, room.pos.y, room.pos.z + 1))) under.add(room.id);
  }
  return under;
}

/** Metres, quantised to centimetres so a dump is legible and a comparison is exact. */
function groundBase(component: number): number {
  if (component === NO_GROUND_COMPONENT) return 0;
  const roll = sceneHash(component, SALT_GROUND_BASE) % 2001;
  return Math.round((roll / 1000 - 1) * GROUND_BASE_METRES * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Boundary edges                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What closes a room in on one side — the highest-value derivation in the whole design, because in
 * 2D the void means "don't draw" and in 3D **the void is the scene**: the pines, the shrubs, the
 * water and the shoreline all live in the gap.
 *
 * | Class | What it means | What it becomes |
 * |---|---|---|
 * | `open` | an exit crosses here | ground continues through; no geometry |
 * | `edge` | no exit, and no room in the next cell at all | dressed by biome: tree wall, rock face, facade, shoreline |
 * | `barrier` | no exit, but a room *is* there | must be solid and thicker than an `edge` |
 * | `portal` | a link with no shared coordinate frame | the emissive ring from the reference image |
 * | `door` | an exit with a door on it | real door geometry with open/shut state |
 *
 * ## The seam ruling — read this before changing anything here
 *
 * `RoomExit.seam` postdates the plan and cuts straight across its table. A seam is `portal: true` in
 * the **geometry** — no tiles are carved, because the two ends share no coordinate frame — and the
 * owner's ruling of 2026-08-10 is that it is an ordinary step in the **fiction**: *"portals should
 * only be used to traverse large distances or for magic reasons"*, and a road leaving one zone for
 * the trees of the next is neither.
 *
 * **So a seam classifies as `open` (or `door` if it carries one), never as `portal`**, and carries
 * {@link SceneEdge.seam} so a renderer knows the ground stops even though the crossing does not. The
 * emissive ring is precisely what seams exist to remove; drawing one on every seam would put a magic
 * gate across every road out of every zone, which is the opposite of what the field is for.
 *
 * The measurement makes the size of the call plain, and it is much larger than it looks. Of the
 * **5,142** cardinal edges that are portals in the geometry, **5,140 are seams**. Classifying them
 * the plan's way gives `portal` 2.76% of all edges; classifying them this way leaves **two** portal
 * edges in the entire world (one east, one west) and moves the rest to `open`. Every other non-seam
 * portal — 1,125 of them — is vertical, and a vertical link is not an edge at all: it is a stairwell
 * in {@link RoomScene.features}.
 *
 * **This is the call in this milestone most worth revisiting.** If the owner decides a zone boundary
 * *should* read as a threshold, the change is one branch here plus dressing, and the override layer
 * (`roomScene-overrides.ts`) is where a per-zone exception would go. What must not happen is the ring
 * arriving by accident because `portal` was tested before `seam`.
 */
export const EDGE_KINDS = ['open', 'edge', 'barrier', 'portal', 'door'] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/** The opening cut across a shared edge — output 6's "corridor mouth", in room-relative tiles. */
export interface EdgeMouth {
  /** Tiles across, straight from {@link connectorSpan}: 9 where two outdoor rooms merge, else 3. */
  readonly span: number;
  /** First tile of the mouth along this edge, `(ROOM_TILES - span) / 2` — `connectorCells`' own centring. */
  readonly offset: number;
  /**
   * Whether the collision grid actually cuts these tiles.
   *
   * False on a seam and only on a seam. `buildZoneTilemap` carves nothing for a portal, and a seam is
   * a portal in the geometry — the server carries the walker across when they press against the edge
   * instead. The width is still worth reporting, because both sides have to be *dressed* to the same
   * width for the crossing to read as a step rather than a hole.
   */
  readonly carved: boolean;
}

export interface SceneEdge {
  readonly dir: Cardinal;
  readonly kind: EdgeKind;
  /** `edge` and `barrier`. Counted into {@link SceneEnclosure.solid}; nothing may be drawn through it. */
  readonly solid: boolean;
  /** The room on the other side, when there is one — the exit's target, or the occupant of the cell. */
  readonly to?: RoomId;
  /** That room's ground, when it was supplied. Absent for a seam whose far zone is not loaded. */
  readonly sector?: Sector;
  /** A zone boundary crossed on foot. See {@link EDGE_KINDS} for why it is not a portal. */
  readonly seam?: true;
  /** A shut door. `door` edges only. */
  readonly closed?: true;
  /** Locked as well as shut, so a renderer can hang a lock plate on it. `door` edges only. */
  readonly locked?: true;
  /**
   * **The crossing is the far room's, not ours** — it declares an exit back here and we declare
   * nothing.
   *
   * Measured: **283** of the 17,112 directed barriers are like this, 14 of them with a door. The
   * plan's table has no cell for it and would call them `barrier`, i.e. solid — but the far room's
   * carve has already cut a corridor through that boundary, so a wall there is geometry the player
   * walks straight through. They are classified as the crossing they physically are, and flagged, so
   * that a renderer can dress the one-way-ness (a drop, a bank, a gap in a hedge) if it wants to.
   * `stepRoom` still refuses the typed command in that direction; nothing about MUD semantics moves.
   */
  readonly inbound?: true;
  /** Present exactly for `open` and `door`. */
  readonly mouth?: EdgeMouth;
}

/**
 * How closed-in this room is — output 4, and what selects the *lighting recipe* downstream rather
 * than merely the prop kit.
 *
 * The plan puts it in the IR at M2 for one reason: it is what stops interiors being a retrofit.
 * 0 solid sides wants a hemisphere and moon shadows; 3 or 4 wants an interior probe, no sky term and
 * no weather. Getting that decision out of the renderer and into a tested pure function now is the
 * cheap half of M6.
 */
export interface SceneEnclosure {
  /** 0..4. Sides classified `edge` or `barrier`. */
  readonly solid: number;
  /** No sky term: an `inside` or `cave` room, or one flagged `indoors`. */
  readonly roofed: boolean;
  /**
   * **How high the lid is, in metres** — {@link STANDARD_CEILING} or {@link GIANT_CEILING}.
   *
   * Here rather than as a constant in the renderer because the thing that knows a room *has* a lid
   * is the thing that should say how high it is: the wall's height, the slab's height, the roof's
   * seat and the near-wall fade are four readings of one fact, and four copies of a constant is
   * four chances to raise three of them.
   *
   * Reported for **every** room, roofed or not, so a reader never has to branch to find out whether
   * the field is meaningful. On a room with sky it is what the lid *would* be and nothing draws it.
   *
   * Two rungs today and the second is capped by the storey above — see {@link GIANT_FOLK_ZONES} for
   * which zones ask for it and {@link roomsUnderAStorey} for what takes it away again.
   */
  readonly ceiling: number;
}

/* -------------------------------------------------------------------------- */
/* Features                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The optional landmark slot — the cheapest single defence against 46,544 rooms feeling identical.
 *
 * The plan's own list. Kept short and kept *placeable*: every one of these fits a 2x2 scatter block,
 * which is what guarantees it can never stand where a player arrives or walks.
 */
export const LANDMARK_KINDS = ['well', 'shrine', 'campfire', 'statue', 'ruin'] as const;

export type LandmarkKind = (typeof LANDMARK_KINDS)[number];

/** Footprints, in tiles. Nothing here exceeds a scatter block; {@link landmarkOf} refuses if it does. */
const LANDMARKS: Readonly<Record<LandmarkKind, { readonly width: number; readonly depth: number }>> = {
  well: { width: 2, depth: 2 },
  shrine: { width: 2, depth: 2 },
  campfire: { width: 2, depth: 2 },
  statue: { width: 1, depth: 1 },
  ruin: { width: 2, depth: 2 },
};

/**
 * What each biome puts on its landmark slot, weighted the way `SCATTER_BY_SECTOR` weights scatter —
 * by repetition, so the table stays one line per sector and the weights are visible.
 *
 * A sector with no row gets no landmark, and the absences are the interesting part. **`inside` is
 * deliberately empty**: an interior's furniture is authored, and a campfire in a shop is worse than
 * an empty shop. Water, `air` and `astral` are empty because a well on a lake is a bug with a
 * texture. Roads and cities get built things, wilderness gets ruins and shrines.
 */
const LANDMARK_BY_SECTOR: Readonly<Partial<Record<Sector, readonly LandmarkKind[]>>> = {
  forest: ['shrine', 'campfire', 'ruin', 'shrine'],
  field: ['well', 'shrine', 'ruin', 'campfire'],
  road: ['well', 'shrine', 'statue', 'ruin'],
  hills: ['ruin', 'shrine', 'campfire'],
  swamp: ['ruin', 'shrine'],
  desert: ['ruin', 'well'],
  city: ['statue', 'well', 'statue', 'shrine'],
  cave: ['ruin', 'shrine'],
  mountain: ['ruin', 'shrine'],
  arctic: ['ruin'],
};

/**
 * One room in this many, among sectors that have a palette at all, carries a landmark.
 *
 * Tuned rather than chosen: at one in four the world reads as a theme park, and at one in thirty-two
 * you can walk a zone without meeting one. Measured at this value, **3,896 rooms — 8.4% of the
 * world** — carry one: 1,386 shrines, 1,327 ruins, 513 wells, 430 statues, 240 campfires.
 */
const LANDMARK_ONE_IN = 8;

/**
 * A thing standing in the room, in room-relative tiles — output 6.
 *
 * **`prop` is not a new prop system.** It is `tilemap.sceneryOf`'s answer restated, unchanged and in
 * its own order: those footprints are already stamped solid into the collision grid, and a second
 * list that drifted from them would be a bush the client draws and the server walks through. The
 * whole-world sweep asserts the two agree exactly.
 */
export type SceneFeature =
  | {
      readonly t: 'prop';
      readonly kind: SceneryKind;
      readonly tx: number;
      readonly ty: number;
      readonly width: number;
      readonly depth: number;
    }
  | {
      readonly t: 'stair';
      readonly dir: 'up' | 'down';
      /**
       * A flight in a roofed room, a ramp under the sky. The distinction is the elevation policy's:
       * a stacked room's levels are four metres apart and need steps, a continuous one's are a
       * different part of the same hill and need a slope.
       */
      readonly style: 'stair' | 'ramp';
      /** **The field M0 stopped throwing away.** The room at the other end. */
      readonly to: RoomId;
      readonly tx: number;
      readonly ty: number;
      /** {@link STAIR_TILES} square, at `stairPlacement`'s offset — the same block the grid stamps. */
      readonly span: number;
    }
  | {
      readonly t: 'landmark';
      readonly kind: LandmarkKind;
      readonly tx: number;
      readonly ty: number;
      readonly width: number;
      readonly depth: number;
    };

/* -------------------------------------------------------------------------- */
/* The IR                                                                      */
/* -------------------------------------------------------------------------- */

/** What {@link describeRoom} needs to know about the zone. A {@link Zone} satisfies it as it stands. */
export interface SceneZone {
  readonly id: ZoneId;
  /** V8a's flush projection. Changes what the carve does, so it changes what a mouth is. */
  readonly seamless?: boolean;
  /**
   * {@link groundComponents}' answer for this zone.
   *
   * Optional so a caller holding a bare {@link Zone} still gets a scene, and **absent means every
   * room is its own ground** — honest, and wrong for anything that renders. Build it once per zone
   * with {@link sceneZone}.
   */
  readonly ground?: GroundIndex;
  /**
   * {@link roomsUnderAStorey}' answer for this zone — the rooms a tall ceiling is taken away from.
   *
   * Optional for {@link ground}'s reason and with the same shape of fallback: **absent means open
   * air over everything**, so a giant-folk zone described without it gets {@link GIANT_CEILING}
   * everywhere. That is the honest answer for a caller who handed over one room and no zone, and
   * the wrong one for anything that renders a stack; build it once per zone with {@link sceneZone}.
   */
  readonly underStorey?: ReadonlySet<RoomId>;
}

/**
 * The room across each cardinal boundary.
 *
 * One room per direction, not two, and the resolution rule is {@link neighboursOf}'s: **the exit's
 * target when there is an exit, the occupant of the adjacent cell when there is not.** Those are the
 * same room in every case that matters — the zero-mismatch measurement is what says so — and where
 * they differ (a seam whose far room is in another zone, with something else sitting in the cell) the
 * exit's target is the right answer, because it is the ground you actually see continuing.
 *
 * A direction with no entry means "nothing known that way": no room in the cell, or a seam whose far
 * zone is not loaded. It never means "no exit" — the exit list on the room says that. What it *does*
 * cost is precision: with no far room there is no ground to blend toward and no way to ask
 * `connectorSpan` whether the two sectors merge, so the mouth falls back to the conservative doorway
 * width. Pass a world-wide `rooms` index to {@link neighboursOf} if you want the wide answer at zone
 * boundaries.
 */
export type RoomNeighbourhood = Readonly<Partial<Record<Cardinal, Room>>>;

/** One room, described. The six outputs of the plan's Layer B. */
export interface RoomScene {
  readonly room: RoomId;
  readonly zone: ZoneId;
  /** {@link sceneSeed}. Every choice below is derived from it, so the room is reproducible from it. */
  readonly seed: number;
  readonly biome: SceneBiome;
  readonly ground: GroundPlan;
  readonly edges: Readonly<Record<Cardinal, SceneEdge>>;
  readonly enclosure: SceneEnclosure;
  /** Props, then stairs (`up` before `down`), then the landmark. Fixed order, so two runs compare. */
  readonly features: readonly SceneFeature[];
}

/* -------------------------------------------------------------------------- */
/* Building the neighbourhood                                                  */
/* -------------------------------------------------------------------------- */

/** Rooms by cell, for {@link neighboursOf}. Last writer wins, as the tile grid's own `cells` does. */
export function cellIndex(zone: Zone): Map<string, Room> {
  const cells = new Map<string, Room>();
  for (const room of zone.rooms) cells.set(cellKey(room.pos.x, room.pos.y, room.pos.z), room);
  return cells;
}

/**
 * The 1-neighbourhood of a room, by the rule {@link RoomNeighbourhood} documents.
 *
 * `rooms` is optional and resolves a seam's far room, which lives in another zone by definition —
 * pass a world-wide index if you have one, and accept a seam that blends toward nothing if you do
 * not.
 */
export function neighboursOf(
  cells: ReadonlyMap<string, Room>,
  room: Room,
  rooms?: ReadonlyMap<RoomId, Room>,
): RoomNeighbourhood {
  const out: { -readonly [K in Cardinal]?: Room } = {};
  for (const dir of CARDINALS) {
    const delta = DIRECTION_DELTA[dir];
    const cell = cells.get(cellKey(room.pos.x + delta[0], room.pos.y + delta[1], room.pos.z));
    const exit = room.exits[dir];
    if (!exit) {
      if (cell) out[dir] = cell;
      continue;
    }
    const across = rooms?.get(exit.to) ?? (exit.portal ? undefined : cell);
    if (across) out[dir] = across;
  }
  return out;
}

/** A {@link SceneZone} with its whole-zone indices resolved. One call per zone, then reuse it. */
export function sceneZone(zone: Zone): SceneZone {
  return {
    id: zone.id,
    ground: groundComponents(zone),
    underStorey: roomsUnderAStorey(zone),
    ...(zone.seamless === true ? { seamless: true } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* describeRoom                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How wide the opening across this edge reads, accounting for the projection.
 *
 * {@link connectorSpan} is the authority and is reused rather than re-derived — it is what the carve
 * asks. The one thing it does not cover is the **seamless** projection, which never reaches it:
 * `stampSeams` decides those borders as pairs, filling an open edge completely and narrowing a doored
 * one to a gate. That branch is spelled out here rather than pushed into `tilemap.ts`, because it is
 * a *reading* of what `stampSeams` does and changing `connectorSpan` to know about zones would change
 * behaviour this milestone is not allowed to touch.
 */
function openingSpan(zone: SceneZone, room: Room, across: Room | undefined, dir: Cardinal): number {
  if (zone.seamless === true) {
    const out = room.exits[dir];
    const back = across?.exits[OPPOSITE[dir]];
    const doored = out?.door !== undefined || (back?.to === room.id && back?.door !== undefined);
    return doored ? CONNECTOR_WIDTH : ROOM_TILES;
  }
  // Without a far room there is nothing to merge with, so the conservative width is the doorway one.
  if (!across) return CONNECTOR_WIDTH;
  return connectorSpan(room, across, dir);
}

function mouthFor(span: number, carved: boolean): EdgeMouth {
  return { span, offset: (ROOM_TILES - span) / 2, carved };
}

/**
 * One side of a room, classified. See {@link EDGE_KINDS} for the table and the seam ruling.
 *
 * The order of the tests is the whole safety argument, so it is worth reading in order: **no exit**
 * decides `edge` vs `barrier` (and the inbound exception); then a **non-seam portal** is the only
 * thing that earns a ring; then a **door**; then everything left is `open`.
 */
function classifyEdge(
  zone: SceneZone,
  room: Room,
  dir: Cardinal,
  across: Room | undefined,
): SceneEdge {
  const exit = room.exits[dir];

  if (!exit) {
    if (!across) return { dir, kind: 'edge', solid: true };
    // Does the far room link back? Then the carve has already cut this boundary open.
    const back = across.exits[OPPOSITE[dir]];
    if (back === undefined || back.portal === true || back.to !== room.id) {
      return { dir, kind: 'barrier', solid: true, to: across.id, sector: across.sector };
    }
    const span = openingSpan(zone, room, across, dir);
    return {
      dir,
      kind: back.door ? 'door' : 'open',
      solid: false,
      to: across.id,
      sector: across.sector,
      inbound: true,
      mouth: mouthFor(span, true),
      ...(back.door?.closed === true ? { closed: true as const } : {}),
      ...(back.door?.locked === true ? { locked: true as const } : {}),
    };
  }

  const far = across ? { to: across.id, sector: across.sector } : { to: exit.to };

  // A portal that is not a seam: no shared coordinate frame and no fiction saying otherwise.
  if (exit.portal === true && exit.seam !== true) {
    return { dir, kind: 'portal', solid: false, ...far };
  }

  const span = openingSpan(zone, room, across, dir);
  // A seam carves nothing — `buildZoneTilemap` skips portals — but both sides are dressed to width.
  //
  // The `across` half of the test is what makes this exact rather than nearly right: the grid carves
  // only when the far room is on this level of this zone, and the far room is knowable here only if
  // the caller handed it over. Measured, the two conditions coincide on today's world — **0**
  // non-portal exits leave their zone, **0** cardinal ones leave their level and **0** point at a
  // room that does not exist — so `across` present means the carve happened, and `across` absent
  // means this call was never told enough to say.
  const carved = exit.seam !== true && across !== undefined;
  return {
    dir,
    kind: exit.door ? 'door' : 'open',
    solid: false,
    ...far,
    ...(exit.seam === true ? { seam: true as const } : {}),
    ...(exit.door?.closed === true ? { closed: true as const } : {}),
    ...(exit.door?.locked === true ? { locked: true as const } : {}),
    mouth: mouthFor(span, carved),
  };
}

/** Room-relative tile index, the same `ty * ROOM_TILES + tx` `scenerySiting` uses. */
function tileIndex(tx: number, ty: number): number {
  return ty * ROOM_TILES + tx;
}

function occupy(taken: Set<number>, tx: number, ty: number, width: number, depth: number): void {
  for (let dy = 0; dy < depth; dy++) {
    for (let dx = 0; dx < width; dx++) taken.add(tileIndex(tx + dx, ty + dy));
  }
}

function clear(taken: ReadonlySet<number>, tx: number, ty: number, width: number, depth: number): boolean {
  for (let dy = 0; dy < depth; dy++) {
    for (let dx = 0; dx < width; dx++) {
      if (taken.has(tileIndex(tx + dx, ty + dy))) return false;
    }
  }
  return true;
}

/**
 * The landmark slot, or nothing.
 *
 * Placed in one of `scenery.ts`'s four {@link SCATTER_BLOCKS} — imported rather than restated,
 * because those four blocks *are* the law that the arrival ring and the centre cross stay walkable,
 * and that law was written in blood: the owner walked into a bog room and could not move. A landmark
 * is a bigger obstruction than a bush, so it obeys the same rule and additionally clears anything
 * already standing (props, both flights of stairs).
 *
 * The four blocks are tried in a fixed rotation from a hashed start, so the choice is a function of
 * the seed and not of the order anything was iterated in.
 */
function landmarkOf(room: Room, seed: number, taken: ReadonlySet<number>): SceneFeature | undefined {
  const palette = LANDMARK_BY_SECTOR[room.sector];
  if (!palette || palette.length === 0) return undefined;
  if (sceneHash(seed, SALT_LANDMARK_ROLL) % LANDMARK_ONE_IN !== 0) return undefined;

  const kind = palette[sceneHash(seed, SALT_LANDMARK_KIND) % palette.length];
  if (!kind) return undefined;
  const spec = LANDMARKS[kind];
  // A landmark too big for a block would spill into the ring the blocks exist to protect. Skipped
  // rather than clamped, exactly as `scatterFor` skips an oversized palette entry.
  if (spec.width > SCATTER_BLOCK_TILES || spec.depth > SCATTER_BLOCK_TILES) return undefined;

  const slackX = SCATTER_BLOCK_TILES - spec.width;
  const slackY = SCATTER_BLOCK_TILES - spec.depth;
  const start = sceneHash(seed, SALT_LANDMARK_BLOCK) % SCATTER_BLOCKS.length;
  for (let step = 0; step < SCATTER_BLOCKS.length; step++) {
    const corner = SCATTER_BLOCKS[(start + step) % SCATTER_BLOCKS.length];
    if (!corner) continue;
    const tx = corner.tx + (slackX === 0 ? 0 : sceneHash(seed, SALT_LANDMARK_JITTER + step) % (slackX + 1));
    const ty = corner.ty + (slackY === 0 ? 0 : sceneHash(seed, SALT_LANDMARK_JITTER + 8 + step) % (slackY + 1));
    if (clear(taken, tx, ty, spec.width, spec.depth)) {
      return { t: 'landmark', kind, tx, ty, width: spec.width, depth: spec.depth };
    }
  }
  return undefined;
}

/**
 * One room, described. Pure, deterministic, and dependent on nothing outside `room`, its four
 * `neighbours` and the `zone` context — see the module header for the exact contract.
 *
 * `seed` is a parameter rather than derived so that a baker can reseed a whole world without editing
 * this file; {@link sceneSeed} is the answer the shipped world uses.
 */
export function describeRoom(
  zone: SceneZone,
  room: Room,
  neighbours: RoomNeighbourhood,
  seed: number,
): RoomScene {
  const edges: Record<Cardinal, SceneEdge> = {
    north: classifyEdge(zone, room, 'north', neighbours.north),
    east: classifyEdge(zone, room, 'east', neighbours.east),
    south: classifyEdge(zone, room, 'south', neighbours.south),
    west: classifyEdge(zone, room, 'west', neighbours.west),
  };

  let solid = 0;
  const blend: BiomeBlend[] = [];
  for (const dir of CARDINALS) {
    const edge = edges[dir];
    if (edge.solid) solid += 1;
    if (!edge.mouth || edge.sector === undefined || edge.sector === room.sector) continue;
    const weight = (edge.mouth.span / ROOM_TILES) * (edge.kind === 'door' ? 0.25 : 0.5);
    blend.push({ dir, sector: edge.sector, weight: Math.round(weight * 1000) / 1000 });
  }

  const roofed = isRoofed(room);
  // The zone's own storey height, capped by whatever stands on this room. `room.zone` rather than
  // `zone.id` because the room is the thing being described and the two are the same number
  // everywhere — swept: 0 of 46,544 rooms disagree with the zone file they are listed in.
  const ceiling =
    zone.underStorey?.has(room.id) === true
      ? Math.min(zoneCeiling(room.zone), STANDARD_CEILING)
      : zoneCeiling(room.zone);
  const component = zone.ground?.of.get(room.id) ?? NO_GROUND_COMPONENT;
  const elevation: ElevationPolicy = roofed
    ? {
        t: 'stacked',
        level: room.pos.z,
        separation: LEVEL_SEPARATION,
        height: room.pos.z * LEVEL_SEPARATION,
      }
    : {
        t: 'continuous',
        base: groundBase(component),
        noise: {
          seed: GROUND_NOISE_SEED,
          frequency: GROUND_NOISE_FREQUENCY,
          amplitude: GROUND_AMPLITUDE[room.sector] ?? GROUND_AMPLITUDE_DEFAULT,
        },
      };

  // Props first, and straight from the accessor both the server and the client stamp tiles from.
  const features: SceneFeature[] = [];
  const taken = new Set<number>();
  for (const prop of sceneryOf(room)) {
    const spec = SCENERY[prop.kind];
    if (!spec) continue;
    features.push({ t: 'prop', kind: prop.kind, tx: prop.tx, ty: prop.ty, width: spec.width, depth: spec.depth });
    occupy(taken, prop.tx, prop.ty, spec.width, spec.depth);
  }

  // Then the flights, at the offsets the grid stamps them at — decided together, because a room with
  // both has to put them somewhere they do not overlap and neither block can decide that alone.
  const up = room.exits.up;
  const down = room.exits.down;
  const placement = stairPlacement(room.id, up !== undefined, down !== undefined);
  const style = roofed ? 'stair' : 'ramp';
  if (up && placement.up) {
    features.push({ t: 'stair', dir: 'up', style, to: up.to, tx: placement.up.dx, ty: placement.up.dy, span: STAIR_TILES });
    occupy(taken, placement.up.dx, placement.up.dy, STAIR_TILES, STAIR_TILES);
  }
  if (down && placement.down) {
    features.push({ t: 'stair', dir: 'down', style, to: down.to, tx: placement.down.dx, ty: placement.down.dy, span: STAIR_TILES });
    occupy(taken, placement.down.dx, placement.down.dy, STAIR_TILES, STAIR_TILES);
  }

  const landmark = landmarkOf(room, seed, taken);
  if (landmark) features.push(landmark);

  return {
    room: room.id,
    zone: zone.id,
    seed,
    biome: { sector: room.sector, theme: zoneTheme(zone.id), blend },
    ground: { component, elevation },
    edges,
    enclosure: { solid, roofed, ceiling },
    features,
  };
}

/* -------------------------------------------------------------------------- */
/* Reading a scene                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Every room-relative tile a scene's features stand on.
 *
 * Here rather than in each caller because three of them want it — the dump tool, the whole-world
 * sweep and any future collision cross-check — and a fourth derivation of "which tiles does a 2x3
 * prop cover" is how the picture and the physics drift apart.
 */
export function featureFootprint(feature: SceneFeature): readonly number[] {
  const width = feature.t === 'stair' ? feature.span : feature.width;
  const depth = feature.t === 'stair' ? feature.span : feature.depth;
  const cells: number[] = [];
  for (let dy = 0; dy < depth; dy++) {
    for (let dx = 0; dx < width; dx++) cells.push(tileIndex(feature.tx + dx, feature.ty + dy));
  }
  return cells;
}

/**
 * The tiles that must stay walkable in every room — `scenery.ts`'s law, restated as a set so a test
 * can assert against it.
 *
 * **The ring one tile in from each wall, and the centre cross.** The ring is where
 * `tilemap.arrivalTile` puts a body entering the room, spread laterally across tiles 1 to 7; the
 * cross is the path across. A prop on either is a player who cannot move, which is not a theory — it
 * happened, in a bog room, from the north.
 */
export function walkableRequired(): ReadonlySet<number> {
  const cells = new Set<number>();
  const near = 1;
  const far = ROOM_TILES - 2;
  const mid = (ROOM_TILES - 1) / 2;
  for (let i = near; i <= far; i++) {
    cells.add(tileIndex(i, near));
    cells.add(tileIndex(i, far));
    cells.add(tileIndex(near, i));
    cells.add(tileIndex(far, i));
    cells.add(tileIndex(i, mid));
    cells.add(tileIndex(mid, i));
  }
  return cells;
}
