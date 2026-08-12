/**
 * The three-layer instanced scatter — §6-M5's *"boundary vegetation, interior clutter, ground detail
 * with distance fade"*, derived from the IR and from nothing else.
 *
 * Pure, like `chunkPlan.ts` beside it and for the same reason: a `Placement` is eight numbers and two
 * strings, so the whole-world sweep can grow every tree in the built world and count them without a
 * GPU. `world3d.ts` is still the only file that turns any of this into a matrix.
 *
 * ## Layer (a) — boundary vegetation, and why the IR already knew where it goes
 *
 * §4's edge table calls `edge` — *"no neighbour cell exists at all"* — **one rule, a third of all
 * edges**, 59,977 of them, and says what it becomes: *"dressed by biome: forest→tree wall"*. That is
 * the whole placement rule. A room in the middle of a merged forest has four `open` sides and grows
 * nothing; a room at the outer boundary of the walkable region has one or two `edge` sides and grows
 * a wall of conifers along exactly those. So **the treeline follows the outline of the merged region
 * automatically** — the plan's *"the tree line simply follows the outer boundary of the merged
 * walkable region, jittered ±1.5 m by the room seed"*, without anything anywhere computing an
 * outline.
 *
 * Two rows per side, {@link BOUNDARY_FRONT} against the wall and {@link BOUNDARY_BACK} behind it. The
 * second row is what makes it read as a wood rather than as a hedge: at a 64-degree camera you see
 * over the first row, and one row of trees against fog is a fence.
 *
 * ## Layer (b) — interior clutter, and the rule that is *not* the 2D prop system's
 *
 * This is worth stating at length because the two systems look alike and are governed by opposite
 * constraints.
 *
 * `scenery.ts`'s props — the bushes and boulders `scatterFor` grows — are **stamped into the
 * collision grid**. The server and every client write the same tiles solid, so a prop that stands on
 * the floor is a prop you walk around, and putting one on a walkable tile is not merely allowed, it is
 * the entire point. `roomScene.ts` restates them unchanged for exactly that reason: *"a second list
 * that drifted from them would be a bush the client draws and the server walks through."*
 *
 * **M5a's scatter touches no collision at all.** It is added by the renderer, after the grid is
 * built, on a client the server never asks. So the inverse rule applies, and it is the strict one:
 * *visual scatter must never imply blockage that collision lacks*. A conifer standing on open floor is
 * a lie the player discovers by walking through it, which is worse than no tree.
 *
 * The rule is therefore in two halves:
 *
 * 1. **Nothing bulky stands inside the room block.** Every boundary tree is placed *beyond*
 *    `HALF_ROOM`, in the void the collision grid has no tiles for — where a wall already stands and
 *    where the player already cannot go. `scatter.test.ts` asserts that over the whole world by
 *    checking that no tree's foot falls on a room tile at all, which is a stronger statement than
 *    "not on a walkable one".
 * 2. **What does stand inside is knee-high and off the required-walkable set.** {@link
 *    roomScene.walkableRequired} is `scenery.ts`'s law — *"the ring one tile in from each wall, and
 *    the centre cross… A prop on either is a player who cannot move, which is not a theory — it
 *    happened, in a bog room, from the north"* — and the clutter obeys it even though it could not
 *    trap anybody, because a stump on the arrival ring still *looks* like it should stop you.
 *    Feature footprints are excluded too, so a sapling never grows out of the middle of a shrine.
 *
 * ## Layer (c) — ground detail
 *
 * Crossed quads, one archetype, one shape, coloured by sector. Faded out by distance in the vertex
 * shader (`foliage.ts`'s `uFade`) rather than by culling, because a tuft that popped in at a chunk
 * boundary would advertise the streaming window the fog was tuned to hide. It obeys the same
 * walkable rule as the clutter, which has a happy side effect: the arrival ring and the centre cross
 * stay bare, and a room reads as having a path worn across it.
 *
 * ## The bucket arithmetic, which is the reason for every cap in this file
 *
 * A chunk's wrappers are `(geometry, material)` pairs out of a bounded free list. Scatter's
 * contribution is bounded by construction rather than by observation:
 *
 * - one room draws at most {@link prototypes.TREE_VARIANTS_PER_ROOM} species, chosen from the
 *   sector's palette by hash — so at most `3 x 2 = 6` tree buckets;
 * - one room grows at most {@link prototypes.TREES_PER_ROOM_MAX} trees in total, which is exactly
 *   `WRAPPER_CAPACITY`, so even the pathological case where every tree rolls the same species fits in
 *   one wrapper per bucket;
 * - undergrowth is one bucket capped at {@link prototypes.GRASS_PER_ROOM_MAX}, likewise one wrapper.
 *
 * **Seven wrappers a chunk, provably**, and `pool.ts` sizes the pre-warm from that number rather than
 * from a measurement.
 */

import {
  CARDINALS,
  ROOM_TILES,
  featureFootprint,
  hashCell,
  walkableRequired,
  type Cardinal,
  type RoomScene,
  type Sector,
} from '@mygame/shared';

import type { Placement } from './chunkPlan.ts';
import { METRES_PER_TILE, ROOM_METRES, metresOfTile } from './frame.ts';
import {
  DIMENSIONS,
  GRASS_PER_ROOM_MAX,
  KIT_BLOCKS,
  KIT_MODELS_PER_ROOM,
  KIT_PART_TEXTURES,
  KIT_PER_ROOM_MAX,
  TREES_PER_ROOM_MAX,
  TREE_VARIANTS_PER_ROOM,
  kitGeometryKey,
  kitMaterialKey,
  kitRoleOf,
  materialKey,
  treeFamily,
  treeGeometryKey,
  treeMaterialKey,
  treePartsOf,
  treeRationOf,
  type TreeVariant,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* Palettes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What grows at the edge of each biome that has one.
 *
 * At M5a this was three sectors of ez-tree conifers. **M5b's kit is what the owner chose the world to
 * look like**, so the kit's trees lead every list and the baked conifers are the supporting cast that
 * keeps a treeline from being one vendor's silhouette repeated — which is exactly the mix §5 asked
 * for and the opposite of the asset-flip failure it warns about.
 *
 * `field` still gets undergrowth and no trees — an open field walled by trees is a forest clearing,
 * and calling every open sector a clearing would put the reference image's one composition on 18,818
 * rooms. **The brief's *"field: … lone CommonTree"* is the one palette line not implemented, and it is
 * a deliberate refusal**: the only layer that places a full-size tree is the boundary one, which
 * places *beyond* the room block, and a lone tree standing inside a field would be a nine-metre object
 * on ground the collision grid says is walkable — the precise lie this file's header forbids. It wants
 * a fourth placement rule (a tree in the *gap* between two field rooms) and that is a slice of its own.
 *
 * `desert` and `arctic` are thin on purpose and the brief says so: *"rocks + DeadTree only — **thin,
 * and named as a gap**; do not pad with off-palette models."* Two dead trees each, and the gap is
 * recorded rather than filled with a conifer that does not belong in a dune.
 *
 * The order inside a palette matters, because {@link paletteFor} takes the first
 * {@link TREE_VARIANTS_PER_ROOM} after a hashed rotation: the earlier entries are the ones a room is
 * most likely to draw. Each list therefore leads with the tree that should dominate the biome **and,
 * within a family, with the cheapest member of it** — `common-tree-5` is 3,182 triangles and
 * `common-tree-1` is 6,265 for the same silhouette at 30 m, so the leading entry being the light one
 * is worth about a third of a forest room's triangles.
 */
const TREES_BY_SECTOR: Readonly<Partial<Record<Sector, readonly TreeVariant[]>>> = {
  forest: ['common-tree-5', 'common-tree-3', 'common-tree-4', 'common-tree-2', 'common-tree-1', 'fir-dense', 'pine-tall'],
  hills: ['pine-5', 'pine-2', 'pine-1', 'pine-broad', 'pine-young', 'snag-bare'],
  // Pine belts and mountain aprons, the brief's own phrase. Sparse rather than a wall: `mountain` had
  // no treeline at M5a and a solid one would hide the rock faces M6 is going to grow there.
  mountain: ['pine-5', 'pine-4', 'pine-crooked'],
  swamp: ['dead-tree-1', 'dead-tree-3', 'aspen-thin', 'twisted-tree-2', 'snag-bare', 'dead-tree-5'],
  desert: ['dead-tree-4', 'dead-tree-2'],
  arctic: ['dead-tree-5', 'snag-bare'],
};

/** How many tufts a sector's floor carries. Absent means bare — a road, a street, a cave. */
const GRASS_BY_SECTOR: Readonly<Partial<Record<Sector, number>>> = {
  field: 28,
  forest: 22,
  hills: 20,
  swamp: 18,
};

/** Interior clutter, per the brief: forest rooms. Stumps and saplings, nothing that reaches a waist. */
const CLUTTER_BY_SECTOR: Readonly<Partial<Record<Sector, number>>> = {
  forest: 4,
};

/* ------------------------------------------------------ M5b: the kit palettes */

/**
 * What the kit dresses each sector with — the brief's palette draft, as data.
 *
 * > *forest: CommonTree (bulk), Bush, Clover, Mushroom_Common, Flower singles, Grass_Common, Fern-patch
 * > · pine belts / mountain aprons: Pine, Rock_Medium, Pebbles, Grass_Wispy_Short
 * > · swamp: DeadTree, TwistedTree (≤1/room), Plant_1_Big, Grass_Wispy_Tall, Mushroom_Laetiporus
 * > · field: Grass tall kinds, Flower groups, Clover, lone CommonTree
 * > · hills: Rock_Medium, Pebbles, sparse lone trees
 * > · road: RockPath pieces + Grass_Common_Short along edges*
 *
 * The trees in that draft are in {@link TREES_BY_SECTOR} above; what is left here is the understory,
 * and it is one list per sector rather than three layered ones because **the bucket budget is a
 * property of how many distinct models a room draws, not of how they are laid out**. A room takes at
 * most {@link KIT_MODELS_PER_ROOM} of these by hashed rotation and each one is then placed according
 * to its own nature — see {@link kitLayerOf}. That keeps the ceiling `4 x 2 = 8` buckets whatever a
 * palette contains, so a palette can be as long as the biome deserves.
 *
 * `city` gets the road's treatment minus the grass: a street is hard ground with stones in it.
 */
const KIT_BY_SECTOR: Readonly<Partial<Record<Sector, readonly string[]>>> = {
  forest: [
    'fern-1',
    'clover-1',
    'mushroom-common',
    'bush-common',
    'flower-3-single',
    'grass-common-tall',
    'clover-2',
    'plant-1',
  ],
  field: [
    'grass-common-tall',
    'flower-4-group',
    'clover-1',
    'flower-3-group',
    'grass-wispy-tall',
    'clover-2',
    'bush-common-flowers',
  ],
  hills: ['rock-medium-2', 'pebble-round-1', 'grass-wispy-short', 'rock-medium-1', 'pebble-round-4', 'pebble-square-2'],
  mountain: ['rock-medium-3', 'pebble-square-1', 'rock-medium-1', 'pebble-round-3', 'pebble-square-5'],
  swamp: ['plant-1-big', 'grass-wispy-tall', 'mushroom-laetiporus', 'plant-7-big', 'fern-1', 'mushroom-common'],
  road: [
    'rock-path-round-small-1',
    'grass-common-short',
    'rock-path-square-small-2',
    'pebble-round-2',
    'rock-path-round-thin',
    'rock-path-square-small-3',
    'pebble-square-3',
  ],
  city: ['rock-path-square-small-1', 'pebble-square-4', 'rock-path-square-thin', 'pebble-round-5', 'rock-path-square-wide'],
  desert: ['rock-medium-2', 'pebble-square-6', 'pebble-round-3'],
  arctic: ['rock-medium-1', 'pebble-round-5'],
};

/** How many kit instances a sector's room grows. Absent means undressed — a cave, a lake, the astral. */
const KIT_COUNT_BY_SECTOR: Readonly<Partial<Record<Sector, number>>> = {
  forest: 14,
  field: 12,
  hills: 9,
  mountain: 6,
  swamp: 11,
  road: 10,
  city: 7,
  desert: 4,
  arctic: 3,
};

/**
 * Per-instance scale, as a multiplier on the kit's own metres. **The kit is already at world scale.**
 *
 * The brief settled that headlessly and it is the finding this whole layer rests on: *"One room cell
 * is 9 m; a CommonTree is 7–9.4 m tall on a ~4 m crown. **No normalization pass** — apply only
 * per-instance jitter."* So the default is a tenth either side of life size and nothing else.
 *
 * `fern-1` is the exception the brief also named: *"one mesh, one primitive, 243 vertices genuinely
 * spread over 9.0x8.5 m — a multi-frond ground patch, not a bad export. Scatter it at 0.3–0.5 scale
 * as forest-floor fill."* At life size one fern covers an entire room.
 */
const KIT_SCALE: Readonly<Record<string, readonly [number, number]>> = {
  'fern-1': [0.3, 0.5],
  'plant-1-big': [0.7, 1.0],
  'plant-7-big': [0.7, 1.0],
  'mushroom-laetiporus': [0.8, 1.2],
};

const KIT_SCALE_DEFAULT: readonly [number, number] = [0.85, 1.15];

/**
 * Where a kit model belongs, from what it is.
 *
 * Three answers and the rule behind each is `scatter.ts`'s own, not a new one:
 *
 * - **`boundary`** — it blocks. `prototypes.KIT_BLOCKS` is `Rock_Medium` and nothing else, and the
 *   brief's *"trees and `Rock_Medium` block"* puts it under the treeline's rule: outside the room
 *   block, in the void the collision grid has no tiles for and where the player already cannot walk.
 *   A room with no `edge` side grows none, because there is nowhere honest to put one.
 * - **`edging`** — it is flat and belongs at the margin. Path stones and pebbles, on the ring of tiles
 *   just inside the block's wall, which is where a track's edge is. That is the whole of *"the road
 *   **reads** as a road before M5c ever bends it"*: a strip of laid stone down each side.
 * - **`understory`** — everything else, on any free tile.
 */
export type KitLayer = 'boundary' | 'edging' | 'understory';

export function kitLayerOf(model: string): KitLayer {
  if (KIT_BLOCKS.has(model)) return 'boundary';
  if (model.startsWith('rock-path') || model.startsWith('pebble')) return 'edging';
  return 'understory';
}

/* -------------------------------------------------------------------------- */
/* Numbers                                                                     */
/* -------------------------------------------------------------------------- */

/** Trees in the row against the wall, and in the row behind it. See the header on why there are two. */
export const BOUNDARY_FRONT = 4;
export const BOUNDARY_BACK = 2;

/** Metres beyond the room block's own boundary that each row stands. */
const ROW_OFFSET = [0.6, 2.0] as const;

/** Metres of jitter, along the side and outward from it. The plan's *"jittered ±1.5 m by the room seed"*. */
const JITTER_ALONG = 1.5;
const JITTER_OUT = 0.5;

/** How much a tree's baked size is multiplied by. A stand of identical trees is a wallpaper. */
const SCALE_MIN = 0.82;
const SCALE_RANGE = 0.42;

/** A sapling and a stump, as fractions of the baked tree. Knee to waist, and never more. */
const SAPLING_SCALE = 0.22;
const STUMP_SCALE = 0.1;

/** Half a room block, in metres — `chunkPlan.ts`'s own constant, restated where it is used. */
const HALF_ROOM = ROOM_METRES / 2;

/** `hashCell` is unsigned 32-bit; this maps it onto `[0, 1)`. Same divisor `noise.ts` uses. */
const HASH_RANGE = 0x1_0000_0000;

/*
 * Salts. One per decision, so adding a decision cannot perturb the ones already made — `roomScene.ts`
 * makes the same argument at length and this file keeps the same discipline for the same reason.
 */
const SALT_PALETTE = 0x5c01;
const SALT_SPECIES = 0x5c02;
const SALT_ALONG = 0x5c03;
const SALT_OUT = 0x5c04;
const SALT_SCALE = 0x5c05;
const SALT_YAW = 0x5c06;
const SALT_LEAN = 0x5c07;
const SALT_SKIP = 0x5c08;
const SALT_CLUTTER_TILE = 0x5c10;
const SALT_CLUTTER_KIND = 0x5c11;
const SALT_CLUTTER_JITTER = 0x5c12;
const SALT_GRASS_TILE = 0x5c20;
const SALT_GRASS_JITTER = 0x5c21;
const SALT_GRASS_SCALE = 0x5c22;
const SALT_KIT_PALETTE = 0x5c30;
const SALT_KIT_MODEL = 0x5c31;
const SALT_KIT_TILE = 0x5c32;
const SALT_KIT_JITTER = 0x5c33;
const SALT_KIT_SCALE = 0x5c34;
const SALT_KIT_YAW = 0x5c35;
const SALT_KIT_TILT = 0x5c36;
const SALT_KIT_SIDE = 0x5c37;

/** One decision, in `[0, 1)`. A pure function of the seed, the salt and the index — never of a cursor. */
function roll(seed: number, salt: number, index: number): number {
  return hashCell(salt, index, 0, seed) / HASH_RANGE;
}

/* -------------------------------------------------------------------------- */
/* Input                                                                       */
/* -------------------------------------------------------------------------- */

export interface ScatterInput {
  readonly scene: RoomScene;
  /** Tile-space origin of the room block in the {@link frame.PlaceFrame}. `chunkPlan`'s own. */
  readonly origin: { readonly tx: number; readonly ty: number };
  /** Metres, already anchored to the camera's level — `chunkPlan.roomElevation`'s answer. */
  readonly elevation: number;
  /** Which baked level of detail this chunk draws. See `trees.ts` for how it is chosen. */
  readonly lod: number;
}

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The species one room may grow — at most {@link TREE_VARIANTS_PER_ROOM}, from its sector's palette.
 *
 * A hashed rotation rather than a hashed subset, so the list is contiguous in the palette and the
 * leading entry — the one the palette author put first — is in every room's set. That keeps a forest
 * recognisably a spruce forest while still giving two neighbouring rooms different supporting cast.
 */
export function paletteFor(sector: Sector, seed: number): readonly TreeVariant[] {
  const palette = TREES_BY_SECTOR[sector];
  if (!palette || palette.length === 0) return [];
  const take = Math.min(TREE_VARIANTS_PER_ROOM, palette.length);
  const start = Math.floor(roll(seed, SALT_PALETTE, 0) * palette.length);
  const out: TreeVariant[] = [];
  for (let i = 0; i < take; i++) out.push(palette[(start + i) % palette.length]!);
  return out;
}

/**
 * The kit models one room may dress itself with — at most {@link KIT_MODELS_PER_ROOM}, by the same
 * hashed rotation {@link paletteFor} uses and for the same reason.
 *
 * A rotation rather than a subset keeps the list contiguous, so the leading entry — the one the
 * palette author put first, and the one that should characterise the biome — is in every room's set.
 * A forest floor is therefore always ferny, and which of clover, mushrooms and a bush joins the ferns
 * changes from room to room.
 */
export function kitPaletteFor(sector: Sector, seed: number): readonly string[] {
  const palette = KIT_BY_SECTOR[sector];
  if (!palette || palette.length === 0) return [];
  const take = Math.min(KIT_MODELS_PER_ROOM, palette.length);
  const start = Math.floor(roll(seed, SALT_KIT_PALETTE, 0) * palette.length);
  const out: string[] = [];
  for (let i = 0; i < take; i++) out.push(palette[(start + i) % palette.length]!);
  return out;
}

/* -------------------------------------------------------------------------- */
/* The plan                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything a room grows.
 *
 * `order` exists for one reason and it is `scatter.test.ts`'s: the plan's §4 verification asks that
 * *"forward and reverse iteration of a room's scatter produce byte-identical positions"*, and the only
 * way to actually demonstrate that rather than assert it is to run the traversal both ways round and
 * compare. Every placement is a pure function of `(seed, salt, index)` and never of a cursor, so the
 * two runs differ in the order of the array and in nothing else.
 */
export function planScatter(input: ScatterInput, order: readonly Cardinal[] = CARDINALS): readonly Placement[] {
  const { scene } = input;
  // No sky, no weather, no trees. §4's enclosure class, applied one layer further down: an `inside`
  // room's ceiling is M6's, and until it exists a conifer growing through a roof would be the most
  // visible bug in the build.
  if (scene.enclosure.roofed) return [];

  const out: Placement[] = [];
  const palette = paletteFor(scene.biome.sector, scene.seed);
  if (palette.length > 0) {
    // **The species are chosen before a single side is walked, and that is M5b's doing.** The
    // rationing the brief asks for is a *running count* — "at most one twisted tree in this room" —
    // and a running count over `order` is the one thing this file has never allowed itself: which
    // tree got the last twisted slot would depend on which way the cardinals were iterated, and §4's
    // byte-identical verification would fail. So {@link speciesPlan} decides every slot up front in a
    // canonical order, and the loop below only reads its answer.
    const species = speciesPlan(scene, palette);
    boundary(input, species, order, out);
    clutter(input, species, out);
  }
  undergrowth(input, out);
  kit(input, out);
  return out;
}

/* ------------------------------------------------- the species plan (rationed) */

/**
 * Which variant stands in each boundary slot and each clutter slot, decided once, in canonical order.
 *
 * The brief rations `TwistedTree` to one a room and `DeadTree` to four (see
 * `prototypes.TREE_RATION`), and a ration is inherently stateful: the *n*th twisted tree is refused
 * because of the *n-1* before it. This file's whole determinism contract is that a placement is a
 * pure function of `(seed, salt, index)` and never of a cursor, so the state has to be resolved
 * somewhere the cursor cannot reach — which is here, over `CARDINALS` in their own fixed order,
 * before the caller's `order` is looked at.
 *
 * Two details that are decisions:
 *
 * - **The skipped back-row slots are skipped here too.** The gap roll is a pure function of the index
 *   like everything else, so the plan can and does apply it; a slot that will not be planted must not
 *   consume a ration.
 * - **A refused variant falls back to the first palette entry that is still under its own ration**,
 *   not blindly to `palette[0]`. In a swamp whose hashed rotation happens to lead with the twisted
 *   tree, a blind fallback would turn a ration of one into a room full of them — which is the exact
 *   opposite of the instruction, and is what the first draft of this did.
 */
function speciesPlan(
  scene: RoomScene,
  palette: readonly TreeVariant[],
): { readonly boundary: ReadonlyMap<number, TreeVariant>; readonly clutter: readonly TreeVariant[] } {
  const grown = new Map<string, number>();
  const boundaryPlan = new Map<number, TreeVariant>();

  for (const dir of CARDINALS) {
    if (scene.edges[dir].kind !== 'edge') continue;
    const side = CARDINALS.indexOf(dir);
    for (let row = 0; row < 2; row++) {
      const count = row === 0 ? BOUNDARY_FRONT : BOUNDARY_BACK;
      for (let i = 0; i < count; i++) {
        const index = side * 64 + row * 16 + i;
        if (row === 1 && roll(scene.seed, SALT_SKIP, index) < 0.25) continue;
        const rolled = palette[Math.floor(roll(scene.seed, SALT_SPECIES, index) * palette.length)]!;
        const chosen = ration(rolled, palette, grown);
        if (chosen) boundaryPlan.set(index, chosen);
      }
    }
  }

  const clutterPlan: TreeVariant[] = [];
  const wanted = CLUTTER_BY_SECTOR[scene.biome.sector] ?? 0;
  for (let i = 0; i < wanted; i++) {
    const rolled = palette[Math.floor(roll(scene.seed, SALT_SPECIES, 512 + i) * palette.length)]!;
    // A sapling is a small tree and still a tree: it counts against the ration, or a room could hold
    // one twisted tree at the treeline and four more in the middle of it.
    const chosen = ration(rolled, palette, grown);
    if (chosen) clutterPlan.push(chosen);
  }

  return { boundary: boundaryPlan, clutter: clutterPlan };
}

/* --------------------------------------------------------- layer (a): boundary */

function boundary(
  input: ScatterInput,
  species: { readonly boundary: ReadonlyMap<number, TreeVariant> },
  order: readonly Cardinal[],
  out: Placement[],
): void {
  const { scene, origin, elevation, lod } = input;
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const cx = x0 + HALF_ROOM;
  const cz = z0 + HALF_ROOM;

  for (const dir of order) {
    // `edge` and only `edge`. A `barrier` is a room you cannot reach and its wall is a correctness
    // requirement (§4) — hiding it behind trees would let the player see foliage where the geometry
    // is meant to say "solid", and a `portal` or a `door` must not be grown over at all.
    if (scene.edges[dir].kind !== 'edge') continue;
    const lateral = dir === 'north' || dir === 'south';
    const outward = dir === 'north' || dir === 'west' ? -1 : 1;
    // The index is seeded from the side, so the north row and the south row are different rows.
    const side = CARDINALS.indexOf(dir);

    for (let row = 0; row < 2; row++) {
      const count = row === 0 ? BOUNDARY_FRONT : BOUNDARY_BACK;
      for (let i = 0; i < count; i++) {
        const index = side * 64 + row * 16 + i;
        // A gap in the back row now and then, and the species plan's own refusals. Both are decided
        // in `speciesPlan`, over the same indices, so a slot missing here is a slot missing there.
        const variant = species.boundary.get(index);
        if (!variant) continue;
        if (countTrees(out) >= TREES_PER_ROOM_MAX) return;

        // Spread across the side and a little past its corners, so two adjacent sides close up.
        const t = (i + 0.5) / count;
        const along = -HALF_ROOM - 0.7 + t * (ROOM_METRES + 1.4)
          + (roll(scene.seed, SALT_ALONG, index) - 0.5) * JITTER_ALONG;
        const depth = ROW_OFFSET[row === 0 ? 0 : 1]
          + (roll(scene.seed, SALT_OUT, index) - 0.5) * JITTER_OUT;

        const scale = SCALE_MIN + roll(scene.seed, SALT_SCALE, index) * SCALE_RANGE;
        const yaw = roll(scene.seed, SALT_YAW, index) * Math.PI * 2;
        // A degree or two off vertical. Trees that all stand plumb read as telegraph poles.
        const lean = (roll(scene.seed, SALT_LEAN, index) - 0.5) * 0.12;

        const x = lateral ? cx + along : cx + outward * (HALF_ROOM + depth);
        const z = lateral ? cz + outward * (HALF_ROOM + depth) : cz + along;
        pushTree(out, variant, lod, x, elevation, z, scale, yaw, lean);
      }
    }
  }
}

/* ---------------------------------------------------------- layer (b): clutter */

function clutter(
  input: ScatterInput,
  species: { readonly clutter: readonly TreeVariant[] },
  out: Placement[],
): void {
  const { scene, origin, elevation, lod } = input;
  const wanted = species.clutter.length;
  if (wanted === 0) return;

  const free = freeTiles(scene);
  if (free.length === 0) return;
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);

  for (let i = 0; i < wanted; i++) {
    if (countTrees(out) >= TREES_PER_ROOM_MAX) return;
    const tile = free[Math.floor(roll(scene.seed, SALT_CLUTTER_TILE, i) * free.length)]!;
    const tx = tile % ROOM_TILES;
    const ty = Math.floor(tile / ROOM_TILES);
    const jx = roll(scene.seed, SALT_CLUTTER_JITTER, i * 2);
    const jz = roll(scene.seed, SALT_CLUTTER_JITTER, i * 2 + 1);
    const x = x0 + metresOfTile(tx) + jx * METRES_PER_TILE;
    const z = z0 + metresOfTile(ty) + jz * METRES_PER_TILE;

    const variant = species.clutter[i]!;
    const stump = roll(scene.seed, SALT_CLUTTER_KIND, i) < 0.45;
    const scale = stump ? STUMP_SCALE : SAPLING_SCALE;
    const yaw = roll(scene.seed, SALT_YAW, 512 + i) * Math.PI * 2;
    // A stump is a trunk and nothing else. Half the point of the layer: the *absence* of a canopy is
    // what says "this was cut", and it costs one draw rather than two.
    pushTrunk(out, variant, lod, x, elevation, z, scale, yaw, 0);
    if (!stump && treePartsOf(variant).includes('canopy')) {
      pushCanopy(out, variant, lod, x, elevation, z, scale, yaw, 0);
    }
  }
}

/* ------------------------------------------------------ layer (c): undergrowth */

function undergrowth(input: ScatterInput, out: Placement[]): void {
  const { scene, origin, elevation } = input;
  const sector = scene.biome.sector;
  const wanted = Math.min(GRASS_BY_SECTOR[sector] ?? 0, GRASS_PER_ROOM_MAX);
  if (wanted === 0) return;

  const free = freeTiles(scene);
  if (free.length === 0) return;
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const material = materialKey('grass', sector, false);

  for (let i = 0; i < wanted; i++) {
    const tile = free[Math.floor(roll(scene.seed, SALT_GRASS_TILE, i) * free.length)]!;
    const tx = tile % ROOM_TILES;
    const ty = Math.floor(tile / ROOM_TILES);
    const x = x0 + metresOfTile(tx) + roll(scene.seed, SALT_GRASS_JITTER, i * 2) * METRES_PER_TILE;
    const z = z0 + metresOfTile(ty) + roll(scene.seed, SALT_GRASS_JITTER, i * 2 + 1) * METRES_PER_TILE;
    const scale = 0.7 + roll(scene.seed, SALT_GRASS_SCALE, i) * 0.7;
    out.push({
      archetype: 'grass',
      geometry: 'grassCross',
      material,
      x,
      y: elevation,
      z,
      sx: DIMENSIONS.grassWidth * scale,
      sy: DIMENSIONS.grassHeight * scale,
      sz: DIMENSIONS.grassWidth * scale,
      rx: 0,
      ry: roll(scene.seed, SALT_YAW, 1024 + i) * Math.PI * 2,
      rz: 0,
    });
  }
}

/* ------------------------------------------------------------- layer (d): kit */

/**
 * The Quaternius understory — M5b's whole visible contribution to a room's floor.
 *
 * One loop over one palette, because the *bucket* budget is about how many distinct models a room
 * draws and not about how many rules laid them out (see {@link KIT_BY_SECTOR}). Each rolled model is
 * then placed by {@link kitLayerOf}'s answer, and every one of those three answers obeys a rule this
 * file already had:
 *
 * - a **boundary** model blocks, so it stands beyond `HALF_ROOM` on an `edge` side exactly as a tree
 *   does, in the void the collision grid has no tiles for. If the room has no `edge` side it grows
 *   none — there is nowhere to put a boulder that is not a lie.
 * - an **edging** model is flat and goes on the ring of tiles just inside the wall, which is where a
 *   track's margin is.
 * - an **understory** model goes on any free tile, which is `walkableRequired()`-clear and
 *   feature-clear by construction.
 *
 * Every model contributes one placement **per part**, because a flowering bush is a leaf primitive
 * and a flower primitive in two materials and they must be instanced separately — the same reason a
 * tree is a trunk and a canopy.
 */
function kit(input: ScatterInput, out: Placement[]): void {
  const { scene, origin, elevation } = input;
  const sector = scene.biome.sector;
  const palette = kitPaletteFor(sector, scene.seed);
  if (palette.length === 0) return;
  const wanted = Math.min(KIT_COUNT_BY_SECTOR[sector] ?? 0, KIT_PER_ROOM_MAX);
  if (wanted === 0) return;

  const free = freeTiles(scene);
  const rim = ringTiles(free);
  /**
   * **`CARDINALS` and not the caller's `order`.** The boundary layer above walks the sides in the
   * order it is handed because it emits *one row per side* and the row is what the order describes.
   * This layer picks a side per *instance* from a hash, so an order-dependent candidate list would
   * put the same boulder on the north side going one way and the west side going the other — which
   * is exactly the failure §4's *"forward and reverse iteration produce byte-identical positions"*
   * verification exists to catch, and did catch, the first time this was written with `order`.
   */
  const sides = CARDINALS.filter((dir) => scene.edges[dir].kind === 'edge');
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const cx = x0 + HALF_ROOM;
  const cz = z0 + HALF_ROOM;

  for (let i = 0; i < wanted; i++) {
    const model = palette[Math.floor(roll(scene.seed, SALT_KIT_MODEL, i) * palette.length)]!;
    const layer = kitLayerOf(model);
    const range = KIT_SCALE[model] ?? KIT_SCALE_DEFAULT;
    const scale = range[0] + roll(scene.seed, SALT_KIT_SCALE, i) * (range[1] - range[0]);
    const yaw = roll(scene.seed, SALT_KIT_YAW, i) * Math.PI * 2;
    // A degree or two off vertical, as the brief asks — and none at all for the flat pieces, because
    // a tilted paving stone is a paving stone sticking out of the road.
    const tilt = layer === 'edging' ? 0 : (roll(scene.seed, SALT_KIT_TILT, i) - 0.5) * 0.1;

    let x: number;
    let z: number;
    if (layer === 'boundary') {
      if (sides.length === 0) continue;
      const dir = sides[Math.floor(roll(scene.seed, SALT_KIT_SIDE, i) * sides.length)]!;
      const lateral = dir === 'north' || dir === 'south';
      const outward = dir === 'north' || dir === 'west' ? -1 : 1;
      const along = (roll(scene.seed, SALT_KIT_JITTER, i * 2) - 0.5) * (ROOM_METRES - 1);
      const depth = 1.1 + roll(scene.seed, SALT_KIT_JITTER, i * 2 + 1) * 1.4;
      x = lateral ? cx + along : cx + outward * (HALF_ROOM + depth);
      z = lateral ? cz + outward * (HALF_ROOM + depth) : cz + along;
    } else {
      const pool = layer === 'edging' && rim.length > 0 ? rim : free;
      if (pool.length === 0) continue;
      const tile = pool[Math.floor(roll(scene.seed, SALT_KIT_TILE, i) * pool.length)]!;
      x = x0 + metresOfTile(tile % ROOM_TILES)
        + roll(scene.seed, SALT_KIT_JITTER, i * 2) * METRES_PER_TILE;
      z = z0 + metresOfTile(Math.floor(tile / ROOM_TILES))
        + roll(scene.seed, SALT_KIT_JITTER, i * 2 + 1) * METRES_PER_TILE;
    }

    for (const texture of KIT_PART_TEXTURES[model] ?? []) {
      out.push({
        archetype: kitRoleOf(texture) === 'leaf' ? 'kitLeaf' : 'kitSolid',
        geometry: kitGeometryKey(model, texture),
        material: kitMaterialKey(model, texture),
        x,
        y: elevation,
        z,
        // A multiplier, not an extent — the kit is already at world scale. See `pushPart`'s docblock
        // for the same note about baked trees, and `KIT_SCALE` for the one model that needs shrinking.
        sx: scale,
        sy: scale,
        sz: scale,
        rx: tilt,
        ry: yaw,
        rz: tilt * 0.6,
      });
    }
  }
}

/**
 * The free tiles on the outer ring of the room block — where a road's edging goes.
 *
 * Derived from the free set rather than computed independently, so it inherits
 * `walkableRequired()`'s exclusions for nothing: the arrival ring is one tile *in* from the wall
 * (`scenery.ts`'s law), so the wall ring itself is free and is exactly the strip a track's margin
 * occupies. If a room's features have eaten it, the caller falls back to the whole free set.
 */
function ringTiles(free: readonly number[]): readonly number[] {
  const out: number[] = [];
  for (const tile of free) {
    const tx = tile % ROOM_TILES;
    const ty = Math.floor(tile / ROOM_TILES);
    if (tx === 0 || ty === 0 || tx === ROOM_TILES - 1 || ty === ROOM_TILES - 1) out.push(tile);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hold a family to its ration, falling back to the first palette entry that is still under its own.
 *
 * See {@link speciesPlan} for why this is called from there and not from the placement loops. Two
 * things it must get right and one it must not do:
 *
 * - **The fallback is searched, not assumed.** `palette[0]` is the leading entry after a *hashed
 *   rotation*, so in a swamp it is as likely to be the twisted tree as anything else — and falling
 *   back to a rationed variant turns a ration of one into a room full of them. That was the first
 *   draft, and `scatter.test.ts`'s whole-world sweep found it in a bog at room 11667.
 * - **Every accepted variant is charged**, fallback included, so the count is what grew and not what
 *   was rolled.
 * - It must **not** silently plant nothing when the whole palette is rationed out. `undefined` says
 *   so and the caller leaves the slot empty, which is a gap in a treeline rather than a lie.
 */
function ration(
  rolled: TreeVariant,
  palette: readonly TreeVariant[],
  grown: Map<string, number>,
): TreeVariant | undefined {
  const take = (variant: TreeVariant): TreeVariant => {
    const family = treeFamily(variant);
    grown.set(family, (grown.get(family) ?? 0) + 1);
    return variant;
  };
  if ((grown.get(treeFamily(rolled)) ?? 0) < treeRationOf(rolled)) return take(rolled);
  for (const candidate of palette) {
    if ((grown.get(treeFamily(candidate)) ?? 0) < treeRationOf(candidate)) return take(candidate);
  }
  return undefined;
}

/**
 * The room tiles anything may stand on: not required-walkable, and not already under a feature.
 *
 * See the header's layer (b) for why this rule is the opposite of `scenery.ts`'s and why the opposite
 * is correct here. The set is built per call rather than cached, because it depends on the room's
 * features and a cache keyed on a room would be a fourth thing to invalidate when a door moves.
 */
export function freeTiles(scene: RoomScene): readonly number[] {
  const blocked = new Set<number>(walkableRequired());
  for (const feature of scene.features) {
    for (const tile of featureFootprint(feature)) blocked.add(tile);
  }
  const free: number[] = [];
  for (let i = 0; i < ROOM_TILES * ROOM_TILES; i++) {
    if (!blocked.has(i)) free.push(i);
  }
  return free;
}

/** Trees so far, for the {@link TREES_PER_ROOM_MAX} cap. Trunks, because every tree has exactly one. */
function countTrees(out: readonly Placement[]): number {
  let count = 0;
  for (const placement of out) {
    if (placement.archetype === 'trunk') count += 1;
  }
  return count;
}

/**
 * One tree, as its parts.
 *
 * `treePartsOf` rather than both, always: M5b's kit `DeadTree` is a blasted snag with one primitive
 * and no leaves, so there is no canopy mesh to place and no canopy material to place it with. The
 * renderer would drop the placement anyway (`world3d.ts` refuses a geometry the pool cannot resolve),
 * but a plan that emits one is a plan that counts a bucket nothing will draw — and the bucket count
 * is what `pool.ts`'s ceiling is derived from.
 */
function pushTree(
  out: Placement[],
  variant: TreeVariant,
  lod: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  lean: number,
): void {
  const parts = treePartsOf(variant);
  if (parts.includes('trunk')) pushTrunk(out, variant, lod, x, y, z, scale, yaw, lean);
  if (parts.includes('canopy')) pushCanopy(out, variant, lod, x, y, z, scale, yaw, lean);
}

/**
 * One baked mesh, placed.
 *
 * **`sx`/`sy`/`sz` are a multiplier here, not an extent.** `Placement`'s docblock states the extent
 * reading and it is true of the five unit shapes; a baked tree is already in metres, and the manifest
 * carries the height it was baked at so nothing has to guess which reading applies. The lean is split
 * across `rx` and `rz` so it is a tilt rather than a roll about the trunk.
 */
function pushPart(
  out: Placement[],
  archetype: 'trunk' | 'canopy',
  variant: TreeVariant,
  lod: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  lean: number,
): void {
  out.push({
    archetype,
    geometry: treeGeometryKey(variant, archetype, lod),
    material: treeMaterialKey(archetype, variant),
    x,
    y,
    z,
    sx: scale,
    sy: scale,
    sz: scale,
    rx: lean,
    ry: yaw,
    rz: lean * 0.6,
  });
}

function pushTrunk(
  out: Placement[],
  variant: TreeVariant,
  lod: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  lean: number,
): void {
  pushPart(out, 'trunk', variant, lod, x, y, z, scale, yaw, lean);
}

function pushCanopy(
  out: Placement[],
  variant: TreeVariant,
  lod: number,
  x: number,
  y: number,
  z: number,
  scale: number,
  yaw: number,
  lean: number,
): void {
  pushPart(out, 'canopy', variant, lod, x, y, z, scale, yaw, lean);
}
