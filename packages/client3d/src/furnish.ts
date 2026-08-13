/**
 * Furniture — M9, and the half of the interiors M6 left out.
 *
 * M6 gave 10,799 `inside` rooms a floor, four walls, a doorway arch and a lid, and then stopped: the
 * plan's *"second rendering mode"* was about geometry, and what it produced was ten thousand
 * correctly-plastered empty boxes. The *Fantasy Props MegaKit* is furniture and this file is what
 * puts it in them.
 *
 * Pure, like `chunkPlan.ts`, `scatter.ts` and `interior.ts` beside it and for the same reason: a
 * `Placement` is eight numbers and two strings, so the whole-world sweep can furnish every interior
 * in the world and count its buckets without a GPU. `world3d.ts` is still the only file that turns
 * any of it into a matrix.
 *
 * ## Dress by what the room *is*
 *
 * The one input that is not the IR's: **the room's own name**. It is on the wire already (`Room.name`
 * rides the `zone` message) and in this world it is the best signal there is — the MUD's builders
 * called a smithy "The Blacksmith's Shop" because a player was going to read it. {@link roomPurpose}
 * is a word table over that name, in the shape `worldgen/src/terrain.ts` uses to classify sectors, and
 * it is deliberately allowed to answer **nothing**: measured over all 10,799 `inside` rooms, 4,109 of
 * them name a purpose and the bulk of the rest are *"A Bend in the Passage"*, *"A Dead End"* and *"A
 * T-intersection in the Passageway"*. A corridor with two barrels in it because the generator had to
 * put something somewhere is worse than a corridor.
 *
 * The `inn` flag is read too, and the board is not: a noticeboard is a `plinth` outdoors and the two
 * rooms in the world that carry both an `inn` flag and an `inside` sector are already named for it.
 *
 * ## The footprint law, and the two slots it leaves
 *
 * `scatter.ts`'s header states the rule this file inherits and it applies here with more force than
 * anywhere else, because furniture is the first thing this renderer has drawn that is **taller than
 * the player and has no collision at all**:
 *
 * > *visual scatter must never imply blockage that collision lacks.*
 *
 * `roomScene.walkableRequired` is the law — *"the ring one tile in from each wall, and the centre
 * cross… A prop on either is a player who cannot move, which is not a theory — it happened, in a bog
 * room, from the north"* — and this file obeys it **by footprint** rather than by origin. That is
 * strictly stronger than the clutter layer, which checks only which tile a model's origin lands in;
 * it has to be, because a bookcase is 1.46 m wide where a toadstool is 12 cm.
 *
 * Take the 9x9 tile room, remove the arrival ring and the centre cross, and what is left is two
 * shapes and no others:
 *
 * ```
 * . . . . . . . . .      .  free            the outer ring is 9 x 1
 * . # # # # # # # .      #  arrival ring    the four islands are 2 x 2
 * . # . . # . . # .      +  centre cross    and there is no free 3 x 2 anywhere
 * . # . . # . . # .
 * . # # # # # # # .
 * . # . . # . . # .
 * . # . . # . . # .
 * . # # # # # # # .
 * . . . . . . . . .
 * ```
 *
 * So there are exactly two ways to stand a thing up:
 *
 * - **A wall slot** — a run of free ring tiles on one side, with the piece's *back* on the wall and
 *   its footprint one tile deep. Length is whatever the run allows, which is why a 2.78 m bench is
 *   legal and a 1.10 m-deep table is not.
 * - **An island slot** — one of `scenery.SCATTER_BLOCKS`' four 2x2 blocks, the same four the 2D
 *   scatter and `roomScene`'s landmark already share. **The same constant, not a second list that
 *   agrees today**, for the reason that constant's own docblock gives.
 *
 * A mouth is cut out of the wall runs, so nothing stands in a doorway — the brief's *"a bookcase in a
 * doorway is not"*, implemented rather than intended.
 *
 * **What that law refuses is worth reading, because two of them are the pieces you would most want.**
 * `Table_Large` is 2.85 x 1.10 m and `Bed_Twin1` is 1.88 x 2.41 m; the largest free rectangle in the
 * room is 9 x 1 or 2 x 2, so neither fits anywhere at all. A tavern therefore gets benches, stools,
 * barrels and no table, and a bedroom gets its nightstand and chest and no bed. That is a **finding
 * about the room grid**, not a bug in the palette: the honest fixes are a smaller table model or a
 * room grid that reserves a wall bay, and both are bigger than this milestone.
 *
 * ## Determinism
 *
 * Every choice is `hashCell(seed, salt, index, …)` off `RoomScene.seed` and nothing else — no RNG
 * stream, no order dependence, no cursor. Two runs of the whole-world sweep produce byte-identical
 * placements, which is `CLAUDE.md`'s rule 3 and the property `scatter.test.ts` checks by iterating
 * both ways round.
 */

import {
  CARDINALS,
  ROOM_TILES,
  SCATTER_BLOCKS,
  SCATTER_BLOCK_TILES,
  SCENERY,
  hashCell,
  type Cardinal,
  type RoomScene,
} from '@mygame/shared';

import type { Placement } from './chunkPlan.ts';
import { METRES_PER_TILE, ROOM_METRES, metresOfTile } from './frame.ts';
import { dressable } from './interior.ts';
import {
  PROPS_METRICS,
  PROPS_MODELS_PER_ROOM,
  PROPS_PART_TEXTURES,
  PROPS_PER_ROOM_MAX,
  SCENERY_BOXES,
  SCENERY_MODELS,
  propsGeometryKey,
  propsMaterialKey,
  sceneryParts,
  type SceneryBox,
  type SceneryModel,
  type SceneryPosture,
} from './prototypes.ts';
import { freeTiles } from './scatter.ts';

/* -------------------------------------------------------------------------- */
/* What a room is for                                                          */
/* -------------------------------------------------------------------------- */

/** The kinds of room this file knows how to furnish. Twelve, and a room may be none of them. */
export const ROOM_PURPOSES = [
  'smithy',
  'tavern',
  'shop',
  'library',
  'bedroom',
  'temple',
  'kitchen',
  'store',
  'guard',
  'workshop',
  'home',
  'hall',
] as const;

export type RoomPurpose = (typeof ROOM_PURPOSES)[number];

/**
 * The words that say what a room is for, **most specific first** — and the order is load-bearing in
 * four places, so it is a list of pairs rather than a record.
 *
 * `cellar` must beat `cell`-anything into `store`; `storeroom` must beat `store` so a storeroom is not
 * a shop; `guard room` must beat `room`; and `common room` must be read before `room` reaches
 * anything else. A record's key order would carry the same information and would be one refactor away
 * from not carrying it.
 *
 * Substrings rather than whole words, because the MUD's names are prose — *"The Blacksmith's Shop"*,
 * *"Chambers in the Shaman's Guild"*, *"Behind the Bar"* — and a tokeniser would have to know about
 * possessives to do worse. The cost is the odd false positive (*"The Hall of the Fallen"* furnishes as
 * a hall, which is right, and *"Storm Cellar"* furnishes as a store, which is also right); the
 * measured hit rate over the world is in this file's header.
 */
const PURPOSE_WORDS: readonly (readonly [RoomPurpose, readonly string[]])[] = [
  ['smithy', ['smith', 'forge', 'anvil', 'armoury', 'armory', 'foundry']],
  ['store', ['storeroom', 'store room', 'storage', 'cellar', 'warehouse', 'granary', 'silo', 'vault']],
  ['tavern', ['tavern', 'taproom', 'tap room', 'alehouse', 'ale house', 'common room', 'the inn', 'inn of', 'mess hall', 'dining', 'banquet']],
  ['shop', ['shop', 'store', 'emporium', 'market', 'stall', 'bazaar', 'trading', 'wares', 'merchant', 'apothecary', 'outfitter', 'supplies']],
  ['library', ['library', 'study', 'scriptorium', 'archive', 'scroll', 'reading']],
  ['bedroom', ['bedroom', 'bedchamber', 'bed chamber', 'sleeping', 'dormitory', 'guest room', 'guest quarters', 'quarters', 'barracks']],
  ['temple', ['temple', 'shrine', 'altar', 'chapel', 'sanctuary', 'cathedral', 'cloister', 'abbey']],
  ['kitchen', ['kitchen', 'pantry', 'larder', 'scullery', 'bakery', 'brewery']],
  ['guard', ['guard', 'watch post', 'garrison', 'training', 'practice', 'arena', 'gaol', 'jail', 'prison']],
  ['workshop', ['workshop', 'work room', 'workroom', 'laboratory', 'alchemist', 'tannery', 'mill']],
  ['home', ['home', 'cottage', 'hovel', 'sitting room', 'parlour', 'parlor', 'residence', 'living']],
  ['hall', ['hall', 'throne', 'audience chamber', 'court of', 'the court']],
];

/**
 * What this room is for, from its name and its flags — or nothing, which is the common answer.
 *
 * The `inn` flag is the one non-name input and it is a fallback rather than an override: a room the
 * MUD marked `ROOM_HEAL` is somewhere you sleep, so an unnamed one furnishes as a bedroom, but a room
 * *called* the Common Room that also carries the flag is a taproom and the name wins. Two rooms in
 * the built world carry the flag on an `inside` sector, so this is a rule for the day there are more.
 */
export function roomPurpose(name: string, flags: readonly string[] | undefined): RoomPurpose | undefined {
  const needle = name.toLowerCase();
  for (const [purpose, words] of PURPOSE_WORDS) {
    for (const word of words) {
      if (needle.includes(word)) return purpose;
    }
  }
  return flags?.includes('inn') === true ? 'bedroom' : undefined;
}

/* -------------------------------------------------------------------------- */
/* What goes in it                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What each kind of room is furnished with, and **the order matters** the same way
 * `scatter.TREES_BY_SECTOR`'s does: {@link modelsFor} takes the first
 * {@link prototypes.PROPS_MODELS_PER_ROOM} after a hashed rotation, so every entry gets a turn across
 * a street of taverns while any one tavern draws two.
 *
 * Each list therefore leads with the piece that should dominate the room and carries a few that read
 * as the same trade — a smithy is an anvil first and a whetstone second, and the barrel and the crate
 * behind them are what a forge yard has in it. No list is longer than six, because a palette wider
 * than the eye can associate stops reading as a room and starts reading as a warehouse.
 *
 * Nothing in any list is refused by the footprint law — `furnish.test.ts` asserts that over every
 * entry, so a piece added here that cannot stand anywhere is a failing test rather than a room that
 * silently furnishes with one model.
 */
const FURNITURE_BY_PURPOSE: Readonly<Record<RoomPurpose, readonly string[]>> = {
  smithy: ['anvil-log', 'whetstone', 'workbench', 'weapon-stand', 'barrel', 'crate-metal'],
  tavern: ['bench', 'stool', 'barrel', 'chair-1', 'cabinet', 'barrel-holder'],
  shop: ['stall-empty', 'crate-metal', 'barrel', 'farm-crate-empty', 'cabinet', 'bag'],
  library: ['bookcase-2', 'book-stand', 'chair-1', 'cabinet', 'candle-stick-stand'],
  bedroom: ['nightstand-shelf', 'cabinet', 'chair-1', 'stool', 'bag'],
  temple: ['candle-stick-stand', 'bench', 'vase-2', 'book-stand', 'bookcase-2'],
  kitchen: ['cauldron', 'barrel', 'pot-1', 'bucket-wooden-1', 'crate-metal', 'workbench'],
  store: ['barrel', 'crate-metal', 'farm-crate-empty', 'bag', 'rope-2', 'barrel-holder'],
  guard: ['weapon-stand', 'dummy', 'bench', 'crate-metal', 'cage-small', 'barrel'],
  workshop: ['workbench', 'whetstone', 'crate-metal', 'barrel', 'bucket-wooden-1', 'cabinet'],
  home: ['stool', 'cabinet', 'nightstand-shelf', 'chair-1', 'bucket-wooden-1', 'barrel'],
  hall: ['bench', 'candle-stick-stand', 'chair-1', 'vase-2', 'bookcase-2'],
};

/**
 * How many pieces a room of each kind grows. Never more than {@link prototypes.PROPS_PER_ROOM_MAX},
 * and the spread across the table is the whole of what makes one room read differently from another.
 *
 * A store is stacked and a temple is bare, and that is the difference between a room that is *used*
 * and one that is *kept*. These are counts of attempts rather than of results: a piece whose slot is
 * already taken thins the room rather than being moved somewhere legal, which is `scatterFor`'s own
 * rule and for its reason — a prop that quietly relocated would hide the fact that the room is full.
 */
const FURNITURE_COUNT: Readonly<Record<RoomPurpose, number>> = {
  smithy: 5,
  tavern: 7,
  shop: 6,
  library: 5,
  bedroom: 4,
  temple: 4,
  kitchen: 6,
  store: 8,
  guard: 5,
  workshop: 6,
  home: 5,
  hall: 6,
};

/* -------------------------------------------------------------------------- */
/* The slot law                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How far a piece may overhang the tile rectangle it was sited on, in metres — **three centimetres,
 * and it is a measurement tolerance rather than licence.**
 *
 * The kit was authored on its own grid and lands within a few centimetres of ours on both sides:
 * `Workbench` is 1.024 m deep against a one-tile wall slot and 2.019 m wide against a 2 m island, and
 * `Bench` is 2.777 m against a 3 m run. A rule that rejected 24 mm would throw the forge's bench away
 * to protect a strip of floor 4% as wide as the player's own collision radius
 * (`tilemap.PLAYER_RADIUS`, 0.625 m) — a strip nobody can stand in.
 *
 * Anything past this is a modelling disagreement rather than a rounding one and is refused outright:
 * `Table_Large` at 1.097 m deep misses the wall slot by 67 mm and the island by 818 mm, and is a
 * named gap rather than a piece that overhangs the arrival ring by a tenth of a metre.
 */
export const SLOT_SLACK = 0.03;

/** A piece against a wall stands one tile deep, back to the plaster. */
const WALL_SLOT_DEPTH = METRES_PER_TILE + SLOT_SLACK;

/** A piece on an island fits the 2x2 block `scenery.SCATTER_BLOCKS` left it. */
const ISLAND_SLOT = SCATTER_BLOCK_TILES * METRES_PER_TILE + SLOT_SLACK;

/**
 * Yaw that turns a model's local `-Z` outward across a side — **`interior.SIDE_YAW`'s table, and the
 * same convention, measured again for this pack.**
 *
 * A village `Wall_*` module is authored with its outward face toward `-Z`. Whether the furniture pack
 * agreed was not something to assume, so it was measured: the area-weighted surface centroid of every
 * backed piece sits on the **negative** Z side of its own bounding box — `Chair_1` -0.190,
 * `Whetstone` -0.160, `Cabinet` -0.117, `Bookcase_2` -0.074, `Shelf_Simple` -0.062, `Bed_Twin1`
 * -0.058, `Stall_Empty` -0.036 — with no exception in either direction. A chair's back is
 * unambiguous and it is the strongest of them, which is what makes the reading a convention rather
 * than a coincidence.
 *
 * So a piece standing against the north wall keeps yaw 0 and looks south into the room, and the rest
 * follow anticlockwise looking down. One table, two kits.
 */
const SIDE_YAW: Readonly<Record<Cardinal, number>> = {
  north: 0,
  east: -Math.PI / 2,
  south: Math.PI,
  west: Math.PI / 2,
};

const HASH_RANGE = 0x1_0000_0000;

const SALT_PALETTE = 0x9f01;
const SALT_MODEL = 0x9f02;
const SALT_SLOT = 0x9f03;
const SALT_ALONG = 0x9f04;
const SALT_YAW = 0x9f05;
const SALT_JITTER = 0x9f06;
const SALT_SCENERY = 0x9f07;

function roll(seed: number, salt: number, index: number): number {
  return hashCell(seed, salt, index, salt ^ index) / HASH_RANGE;
}

/** How many tiles a piece of this size covers along one axis, with the slack folded in. */
function tilesAcross(metres: number): number {
  return Math.max(1, Math.ceil((metres - SLOT_SLACK) / METRES_PER_TILE));
}

/** Whether a piece may stand with its back to a wall: one tile deep or less. */
export function fitsWallSlot(model: string): boolean {
  const metric = PROPS_METRICS[model];
  return metric !== undefined && metric.depth <= WALL_SLOT_DEPTH;
}

/** Whether a piece fits one of the four 2x2 islands. */
export function fitsIslandSlot(model: string): boolean {
  const metric = PROPS_METRICS[model];
  return metric !== undefined && metric.width <= ISLAND_SLOT && metric.depth <= ISLAND_SLOT;
}

/**
 * A run of free tiles along one side, with its doorway cut out and the wall's own yaw attached.
 *
 * A run rather than a tile because a piece's *length* is the thing a wall has plenty of and its depth
 * is the thing it has none of: a 2.78 m bench wants three ring tiles in a row on one side, and which
 * three is the only question left.
 */
interface WallRun {
  readonly dir: Cardinal;
  /** Tile index along the side of the first free tile in the run. */
  readonly start: number;
  readonly length: number;
}

/**
 * Every ring tile that is part of *some* side's opening — **all four sides', not just its own.**
 *
 * The first draft cut only the run's own mouth out and the whole-world sweep found the corner it
 * misses: in a seamless zone an undoored side is carved end to end (`roomScene.openingSpan` returns
 * `ROOM_TILES` rather than `CONNECTOR_WIDTH`), so the whole north row is an opening — and tile `(0,0)`
 * belongs to the *west* wall's run as much as to the north's. A bench standing at the west end of
 * that run had its head in a nine-metre doorway. Velen's inside rooms are the case, room 100001011
 * the one that failed.
 */
function thresholdTiles(scene: RoomScene): ReadonlySet<number> {
  const out = new Set<number>();
  for (const dir of CARDINALS) {
    const span = scene.edges[dir].mouth?.span ?? 0;
    if (span <= 0) continue;
    const offset = scene.edges[dir].mouth?.offset ?? 0;
    for (let i = offset; i < offset + span && i < ROOM_TILES; i++) out.add(ringTile(dir, i));
  }
  return out;
}

/** Where a piece may stand against a wall. Exported so the whole-world sweep can count them. */
export function wallRuns(scene: RoomScene, free: ReadonlySet<number>): readonly WallRun[] {
  const runs: WallRun[] = [];
  const thresholds = thresholdTiles(scene);
  for (const dir of CARDINALS) {
    let start = -1;
    for (let i = 0; i <= ROOM_TILES; i++) {
      // A doorway is not a wall, and the tile in front of one is where a body walks through: both are
      // cut out, which is the whole of "a bookcase in a doorway is not".
      const tile = i < ROOM_TILES ? ringTile(dir, i) : -1;
      const usable = i < ROOM_TILES && !thresholds.has(tile) && free.has(tile);
      if (usable) {
        if (start < 0) start = i;
        continue;
      }
      if (start >= 0) {
        runs.push({ dir, start, length: i - start });
        start = -1;
      }
    }
  }
  return runs;
}

/** The ring tile on a side, at an index running along it. */
function ringTile(dir: Cardinal, along: number): number {
  const tx = dir === 'west' ? 0 : dir === 'east' ? ROOM_TILES - 1 : along;
  const ty = dir === 'north' ? 0 : dir === 'south' ? ROOM_TILES - 1 : along;
  return ty * ROOM_TILES + tx;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

export interface FurnishInput {
  readonly scene: RoomScene;
  /**
   * The room's own name, off the `zone` message — the one input in this file that is not the IR's.
   *
   * Taken as a string rather than as a `Room` so the planner stays free of `world.ts` shapes and can
   * be asked about a hypothetical room in a test, which is `sceneryNamed`'s posture in `shared`.
   */
  readonly name: string;
  readonly flags: readonly string[] | undefined;
  /** Tile-space origin of the room block, as `chunkPlan` takes it. */
  readonly origin: { readonly tx: number; readonly ty: number };
  /** Metres, already anchored to the camera's level. */
  readonly elevation: number;
}

/**
 * One room's furniture.
 *
 * Returns nothing for anything `interior.dressable` refuses, so a caller may hand it every room in
 * the world and let the IR decide — and, more importantly, so the furniture lands **only on the
 * chunks the interior dressing already owns**. That is what keeps `pool.DRESSED_WRAPPER_CEILING` a
 * `max` over two mutually exclusive terms rather than a sum; see its docblock.
 *
 * It also returns nothing for a room whose scenery this file is dressing, which is the second half of
 * the same budget argument and reads as sense on its own: a room somebody bothered to author a
 * fountain into does not also want two generated barrels.
 */
export function planFurniture(input: FurnishInput): readonly Placement[] {
  const { scene, origin, elevation } = input;
  if (!dressable(scene)) return [];
  if (dressedScenery(scene).length > 0) return [];
  const purpose = roomPurpose(input.name, input.flags);
  if (purpose === undefined) return [];

  const models = modelsFor(scene.seed, FURNITURE_BY_PURPOSE[purpose]);
  if (models.length === 0) return [];

  const free = new Set(freeTiles(scene));
  const runs = wallRuns(scene, free);
  const taken = new Set<number>();
  const out: Placement[] = [];
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const wanted = Math.min(FURNITURE_COUNT[purpose], PROPS_PER_ROOM_MAX);

  for (let i = 0; i < wanted; i++) {
    const model = models[Math.floor(roll(scene.seed, SALT_MODEL, i) * models.length)]!;
    const metric = PROPS_METRICS[model];
    if (!metric) continue;
    // Tall pieces go against a wall and short ones prefer an island, which is what a room looks like
    // and is also the safety rule: the things that most look like they should stop you are the ones
    // standing where you would not walk anyway.
    const site =
      metric.height >= TALL_ENOUGH_FOR_A_WALL
        ? (siteAgainstWall(scene, model, metric, runs, free, taken, i) ?? siteOnIsland(scene, model, metric, free, taken, i))
        : (siteOnIsland(scene, model, metric, free, taken, i) ?? siteAgainstWall(scene, model, metric, runs, free, taken, i));
    if (!site) continue;
    for (const texture of PROPS_PART_TEXTURES[model] ?? []) {
      out.push({
        archetype: 'propSolid',
        geometry: propsGeometryKey(model, texture),
        material: propsMaterialKey(texture),
        x: x0 + site.x,
        y: elevation,
        z: z0 + site.z,
        // A multiplier, not an extent — this pack is already at world scale, and unlike the nature
        // kit's understory it measured correct on the way in. See `prototypes.PROPS_METRICS`.
        sx: 1,
        sy: 1,
        sz: 1,
        rx: 0,
        ry: site.yaw,
        rz: 0,
      });
    }
  }
  return out;
}

/**
 * Metres of height past which a piece belongs against a wall — 1.2 m, roughly the shoulder of the
 * 1.81 m base body.
 *
 * Chosen at the height the eye stops reading over a thing: below it a piece is furniture in a room
 * and above it a piece is part of the room's edge, which is also where it stops obstructing the
 * sightline the near-wall fade exists to protect. A bookcase, a market stall, a training dummy, a
 * lectern and a candelabrum are above it; a bench, a barrel, a stool and a cauldron are below.
 */
const TALL_ENOUGH_FOR_A_WALL = 1.2;

interface Site {
  /** Metres from the room block's own north-west corner. */
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

/**
 * Stand a piece against a wall, back to the plaster.
 *
 * The footprint is `ceil(width)` ring tiles by one, and every one of them must be free and unused.
 * The piece's *centre* then sits half its own depth in from the boundary line rather than at the
 * tile's centre — so its back touches the wall and the remainder of the tile is the floor in front of
 * it, which is both what a room looks like and what keeps a 1.02 m workbench inside a 1 m slot.
 */
function siteAgainstWall(
  scene: RoomScene,
  model: string,
  metric: { readonly width: number; readonly depth: number },
  runs: readonly WallRun[],
  free: ReadonlySet<number>,
  taken: Set<number>,
  index: number,
): Site | undefined {
  if (!fitsWallSlot(model)) return undefined;
  const need = tilesAcross(metric.width);
  const usable = runs.filter((run) => run.length >= need);
  if (usable.length === 0) return undefined;
  const run = usable[Math.floor(roll(scene.seed, SALT_SLOT, index) * usable.length)]!;
  const slide = run.length - need;
  const at = run.start + (slide === 0 ? 0 : Math.floor(roll(scene.seed, SALT_ALONG, index) * (slide + 1)));
  const tiles: number[] = [];
  for (let i = 0; i < need; i++) {
    const tile = ringTile(run.dir, at + i);
    if (!free.has(tile) || taken.has(tile)) return undefined;
    tiles.push(tile);
  }
  for (const tile of tiles) taken.add(tile);

  const along = metresOfTile(at) + (need * METRES_PER_TILE) / 2;
  const inward = metric.depth / 2;
  const lateral = run.dir === 'north' || run.dir === 'south';
  const near = run.dir === 'north' || run.dir === 'west' ? inward : ROOM_METRES - inward;
  return {
    x: lateral ? along : near,
    z: lateral ? near : along,
    yaw: SIDE_YAW[run.dir],
  };
}

/**
 * Stand a piece on one of the four 2x2 blocks the arrival ring and the centre cross leave.
 *
 * `scenery.SCATTER_BLOCKS`' own four, shared rather than restated — see that constant for why two
 * lists that agree today are a landmark drifting into a doorway tomorrow. The yaw is a **quarter
 * turn** rather than a free angle: a boulder lands where it fell and a crate is put down square to
 * the room.
 */
function siteOnIsland(
  scene: RoomScene,
  model: string,
  metric: { readonly width: number; readonly depth: number },
  free: ReadonlySet<number>,
  taken: Set<number>,
  index: number,
): Site | undefined {
  if (!fitsIslandSlot(model)) return undefined;
  const start = Math.floor(roll(scene.seed, SALT_SLOT, index) * SCATTER_BLOCKS.length);
  for (let n = 0; n < SCATTER_BLOCKS.length; n++) {
    const block = SCATTER_BLOCKS[(start + n) % SCATTER_BLOCKS.length]!;
    const tiles: number[] = [];
    let clear = true;
    for (let dy = 0; dy < SCATTER_BLOCK_TILES && clear; dy++) {
      for (let dx = 0; dx < SCATTER_BLOCK_TILES; dx++) {
        const tile = (block.ty + dy) * ROOM_TILES + block.tx + dx;
        if (!free.has(tile) || taken.has(tile)) {
          clear = false;
          break;
        }
        tiles.push(tile);
      }
    }
    if (!clear) continue;
    for (const tile of tiles) taken.add(tile);
    const span = SCATTER_BLOCK_TILES * METRES_PER_TILE;
    // **The yaw first, and the jitter against the yawed footprint** — the sweep found the other order
    // in room 2132, where a bookcase turned a quarter turn was jittered by the slack its *unturned*
    // depth left and reached half a metre into the centre cross. A quarter turn swaps the axes, so the
    // slack has to swap with it.
    const quarter = Math.floor(roll(scene.seed, SALT_YAW, index) * 4);
    const turned = quarter % 2 === 1;
    const footX = turned ? metric.depth : metric.width;
    const footZ = turned ? metric.width : metric.depth;
    if (footX > ISLAND_SLOT || footZ > ISLAND_SLOT) continue;
    // Jitter inside whatever the piece does not fill, so four barrels in four blocks are not four
    // barrels at four identical offsets. Clamped by the piece's own size, so nothing leaves the block.
    const slackX = Math.max(0, span - footX) / 2;
    const slackZ = Math.max(0, span - footZ) / 2;
    return {
      x: metresOfTile(block.tx) + span / 2 + (roll(scene.seed, SALT_JITTER, index * 2) - 0.5) * 2 * slackX,
      z: metresOfTile(block.ty) + span / 2 + (roll(scene.seed, SALT_JITTER, index * 2 + 1) - 0.5) * 2 * slackZ,
      yaw: (quarter * Math.PI) / 2,
    };
  }
  return undefined;
}

/**
 * Which models this room draws — the first {@link prototypes.PROPS_MODELS_PER_ROOM} of the palette
 * after a hashed rotation, `scatter.paletteFor`'s own trick and for its reason.
 *
 * A piece the footprint law refuses is dropped here rather than at placement, so a room never spends
 * one of its two model slots on something that cannot stand.
 */
function modelsFor(seed: number, palette: readonly string[]): readonly string[] {
  const usable = palette.filter((model) => fitsWallSlot(model) || fitsIslandSlot(model));
  if (usable.length === 0) return [];
  const take = Math.min(PROPS_MODELS_PER_ROOM, usable.length);
  const start = Math.floor(roll(seed, SALT_PALETTE, 0) * usable.length);
  const out: string[] = [];
  for (let i = 0; i < take; i++) out.push(usable[(start + i) % usable.length]!);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Scenery, dressed                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The scenery props in this room that a kit has a mesh for — **the join between V8d's catalogue and
 * three model registries, and M9b is where it stopped being one row long.**
 *
 * `scenery.SCENERY_KINDS` names ten things and five of them now draw. The five that do not —
 * `fountain`, `plinth`, `well`, `statue`, `haystack` — are in none of the three packs, checked model
 * by model, and keep `chunkPlan`'s grey box as a **sourcing gap** rather than being filled with
 * something that is nearly one. See `prototypes.SCENERY_MODELS` for the table and for what each
 * stand-in is.
 *
 * The kinds M9 missed are the ones that matter most, because they are the ones `scenery.scatterFor`
 * grows: a `stump`, a `crate`, a `barrel` or a `cart` is derived into every forest, field, hillside
 * and bog in the world, so where an authored cart is three props in one zone these are tens of
 * thousands. That is why this function now runs hot and why it takes a `lod`.
 *
 * Returned as a list of `(feature, entry)` pairs rather than as placements so `world3d.ts` can use
 * the same answer to suppress the grey `prop` box — one derivation, so the picture and the
 * suppression can never disagree about which props were dressed.
 */
export function dressedScenery(
  scene: RoomScene,
): readonly {
  readonly feature: Extract<RoomScene['features'][number], { t: 'prop' }>;
  readonly entry: SceneryModel;
}[] {
  const out: { feature: Extract<RoomScene['features'][number], { t: 'prop' }>; entry: SceneryModel }[] = [];
  for (const feature of scene.features) {
    if (feature.t !== 'prop') continue;
    const models = SCENERY_MODELS[feature.kind];
    if (!models || models.length === 0) continue;
    // The prop's own tile, so two bushes in one room are not the same mesh twice and a field is not
    // one silhouette repeated. `cart` has picked between a booth and a handcart this way since M9.
    const entry = models[Math.floor(roll(scene.seed, SALT_SCENERY, feature.tx * ROOM_TILES + feature.ty) * models.length)]!;
    if (!SCENERY_BOXES[entry.model]) continue;
    out.push({ feature, entry });
  }
  return out;
}

/**
 * The box a stand-in presents to the tile grid once its posture and its quarter turn are applied —
 * **the yaw first and the footprint against the yawed box**, which is `siteOnIsland`'s own correction
 * one system along and matters here for the same reason: `SCENERY.log` is three tiles by two, so a
 * quarter turn is the difference between a 3 m log and a 2 m one.
 *
 * Everything is in the model's own metres at scale 1, in **world axes**: `ex`/`ez` are what has to
 * fit the stamped rectangle, `ey` is what the catalogue's height bounds, `cx`/`cz` are where the
 * box's centre lands relative to the placement origin, and `my` is its underside.
 *
 * The felled case is a rotation about **`rz`** and not `rx`, and that is load-bearing. `world3d.ts`
 * writes `rotation.set(rx, ry, rz)` into a three.js Euler in its default `XYZ` order, which composes
 * as `Rx · Ry · Rz` — so `rz` is applied *innermost*, the model tips over first and the yaw then
 * steers the fallen trunk about the world's own vertical. Felling with `rx` would apply the yaw
 * first and merely roll the log about its own length, and every log in the world would point north.
 */
function presentedBox(
  box: SceneryBox,
  posture: SceneryPosture,
  quarter: number,
): { ex: number; ez: number; ey: number; cx: number; cz: number; my: number } {
  // Local axes, mapped to world. Upright is the identity; `Rz(+90°)` sends `(x, y, z)` to
  // `(-y, x, z)`, so the model's height becomes its length and its width becomes its standing height.
  const felled = posture === 'felled';
  const x0 = felled ? -box.maxY : box.minX;
  const x1 = felled ? -box.minY : box.maxX;
  const y0 = felled ? box.minX : box.minY;
  const y1 = felled ? box.maxX : box.maxY;
  const midX = (x0 + x1) / 2;
  const midZ = (box.minZ + box.maxZ) / 2;
  const spanX = x1 - x0;
  const spanZ = box.maxZ - box.minZ;
  // `Ry(q · 90°)` on the horizontal box: odd quarters swap the axes, and the centre goes with them.
  const turned = (quarter & 3) % 2 === 1;
  const rotated: readonly [number, number] =
    (quarter & 3) === 1 ? [midZ, -midX]
    : (quarter & 3) === 2 ? [-midX, -midZ]
    : (quarter & 3) === 3 ? [-midZ, midX]
    : [midX, midZ];
  return {
    ex: turned ? spanZ : spanX,
    ez: turned ? spanX : spanZ,
    ey: y1 - y0,
    cx: rotated[0],
    cz: rotated[1],
    my: y0,
  };
}

/**
 * How much a model is shrunk to sit inside the catalogue box the collision grid already stamped —
 * **derived, never chosen, and never above 1.**
 *
 * `SCENERY.cart` is two tiles by two, and both the server and every client have written those four
 * tiles solid. `Stall_Empty` is 1.845 x 0.932 m and needs no help; `Stall_Cart_Empty` is
 * **3.021 x 1.060 m** and would hang a metre of shaft over walkable floor in each direction, which is
 * `scatter.ts`'s forbidden lie in its most visible form. So it is drawn at `2.03 / 3.021 = 0.672` and
 * measures 2.03 x 0.71 x 1.77 m — a handcart rather than a market cart, which is what the catalogue's
 * own prose promises anyway (*"A wooden handcart tipped onto its shafts"*).
 *
 * **The height term is the posture's**, and only a stand-in pays it: see
 * `prototypes.SCENERY_POSTURES`. A `standing` model *is* the object and keeps its own proportions
 * against the footprint alone, which is M9's rule and is why the cart's two factors are unchanged; a
 * `cropped` or `felled` model is a whole tree standing in for a piece of one, and then the
 * catalogue's declared height is the only statement of how tall the thing should be. The fit stays
 * **uniform** in all three cases — a squashed mesh is a lie about a shape rather than about a size.
 */
export function sceneryScale(
  entry: SceneryModel,
  widthTiles: number,
  depthTiles: number,
  heightTiles: number,
  quarter = 0,
): number {
  const box = SCENERY_BOXES[entry.model];
  if (!box) return 1;
  const presented = presentedBox(box, entry.posture, quarter);
  const height =
    entry.posture === 'standing' ? Infinity : (heightTiles * METRES_PER_TILE + SLOT_SLACK) / presented.ey;
  return Math.min(
    1,
    (widthTiles * METRES_PER_TILE + SLOT_SLACK) / presented.ex,
    (depthTiles * METRES_PER_TILE + SLOT_SLACK) / presented.ez,
    height,
  );
}

/**
 * The scenery a room stands up, as kit models.
 *
 * Placed with the **model's own bounding box** centred on the footprint, at a hashed quarter turn,
 * scaled to fit. Box-centred rather than origin-centred, and that is M9b's second fix rather than a
 * tidy-up: a mesh's origin is wherever the artist left it, `Stall_Cart_Empty`'s is at the back of its
 * bed (`x ∈ [-2.107, +0.914]`), and M9 stood that origin on the footprint's centre — so the shafts of
 * every handcart in Velen reached **1.42 m** across floor the collision grid calls walkable while the
 * scale that was supposed to prevent exactly that was computed correctly. The scale bounds a model's
 * *size*; only the centring bounds where it ends up.
 *
 * Unlike the furniture this runs on **every** room the renderer draws, and after M9b that is most of
 * the outdoors — which is why the scenery term is charged to the scatter side of
 * `pool.DRESSED_WRAPPER_CEILING` and why it is the term that moved it, twice.
 */
export function planScenery(input: {
  readonly scene: RoomScene;
  readonly origin: { readonly tx: number; readonly ty: number };
  readonly elevation: number;
  /** Which baked level of detail this chunk draws, for the `tree` stand-ins. `planScatter`'s own. */
  readonly lod: number;
}): readonly Placement[] {
  const { scene, origin, elevation, lod } = input;
  const dressed = dressedScenery(scene);
  if (dressed.length === 0) return [];
  const out: Placement[] = [];
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  for (const { feature, entry } of dressed) {
    const box = SCENERY_BOXES[entry.model]!;
    const quarter = Math.floor(roll(scene.seed, SALT_YAW, feature.tx * ROOM_TILES + feature.ty) * 4);
    const height = SCENERY[feature.kind].height;
    const scale = sceneryScale(entry, feature.width, feature.depth, height, quarter);
    const presented = presentedBox(box, entry.posture, quarter);
    // The centre of the stamped rectangle, less wherever the model's own box sits relative to its
    // origin. `Matrix4.compose` is `position + R · (S · v)`, so the offset is rotated and scaled
    // exactly as the mesh is.
    const x = x0 + metresOfTile(feature.tx) + (feature.width * METRES_PER_TILE) / 2 - presented.cx * scale;
    const z = z0 + metresOfTile(feature.ty) + (feature.depth * METRES_PER_TILE) / 2 - presented.cz * scale;
    // **Only a felled model is seated.** Every pack authors an upright prop with its origin on the
    // ground — a bush's `minY` of -0.235 is root sinkage the artist meant — so lifting one to put its
    // lowest vertex on the grass would make it hover. Tipping a model over moves its base off the
    // origin entirely, and then the ground has to be found again.
    const y = elevation - (entry.posture === 'felled' ? presented.my * scale : 0);
    for (const part of sceneryParts(entry, lod)) {
      out.push({
        archetype: part.archetype,
        geometry: part.geometry,
        material: part.material,
        x,
        y,
        z,
        sx: scale,
        sy: scale,
        sz: scale,
        rx: 0,
        ry: (quarter * Math.PI) / 2,
        rz: entry.posture === 'felled' ? Math.PI / 2 : 0,
      });
    }
  }
  return out;
}
