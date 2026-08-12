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
  TREES_PER_ROOM_MAX,
  TREE_VARIANTS_PER_ROOM,
  materialKey,
  treeGeometryKey,
  treeMaterialKey,
  type TreeVariant,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* Palettes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What grows at the edge of each biome that has one.
 *
 * Three sectors and no more, deliberately: the brief's *"forest/hills/swamp"*, which is where a
 * treeline is the right answer. `field` gets undergrowth and no trees — an open field walled by
 * conifers is a forest clearing, and calling every open sector a clearing would put the reference
 * image's one composition on 18,818 rooms. Rock faces for `mountain` and `cave`, facades for `city`
 * and shorelines for water are the rest of §4's *"dressed by biome"* table and are M5b's and M6's.
 *
 * The order inside a palette matters, because {@link paletteFor} takes the first
 * {@link TREE_VARIANTS_PER_ROOM} after a hashed rotation: the earlier entries are the ones a room is
 * most likely to draw, so each list leads with the tree that should dominate that biome.
 */
const TREES_BY_SECTOR: Readonly<Partial<Record<Sector, readonly TreeVariant[]>>> = {
  forest: ['pine-tall', 'fir-dense', 'pine-broad', 'fir-ragged', 'pine-young', 'pine-crooked'],
  hills: ['pine-broad', 'pine-young', 'pine-crooked', 'snag-bare'],
  swamp: ['aspen-thin', 'snag-bare', 'pine-crooked', 'pine-young'],
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
    boundary(input, palette, order, out);
    clutter(input, palette, out);
  }
  undergrowth(input, out);
  return out;
}

/* --------------------------------------------------------- layer (a): boundary */

function boundary(
  input: ScatterInput,
  palette: readonly TreeVariant[],
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
        // A gap in the back row now and then. Without it the second row is a copy of the first and
        // the treeline reads as two fences rather than as depth.
        if (row === 1 && roll(scene.seed, SALT_SKIP, index) < 0.25) continue;
        if (countTrees(out) >= TREES_PER_ROOM_MAX) return;

        // Spread across the side and a little past its corners, so two adjacent sides close up.
        const t = (i + 0.5) / count;
        const along = -HALF_ROOM - 0.7 + t * (ROOM_METRES + 1.4)
          + (roll(scene.seed, SALT_ALONG, index) - 0.5) * JITTER_ALONG;
        const depth = ROW_OFFSET[row === 0 ? 0 : 1]
          + (roll(scene.seed, SALT_OUT, index) - 0.5) * JITTER_OUT;

        const variant = palette[Math.floor(roll(scene.seed, SALT_SPECIES, index) * palette.length)]!;
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

function clutter(input: ScatterInput, palette: readonly TreeVariant[], out: Placement[]): void {
  const { scene, origin, elevation, lod } = input;
  const wanted = CLUTTER_BY_SECTOR[scene.biome.sector] ?? 0;
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

    const variant = palette[Math.floor(roll(scene.seed, SALT_SPECIES, 512 + i) * palette.length)]!;
    const stump = roll(scene.seed, SALT_CLUTTER_KIND, i) < 0.45;
    const scale = stump ? STUMP_SCALE : SAPLING_SCALE;
    const yaw = roll(scene.seed, SALT_YAW, 512 + i) * Math.PI * 2;
    // A stump is a trunk and nothing else. Half the point of the layer: the *absence* of a canopy is
    // what says "this was cut", and it costs one draw rather than two.
    pushTrunk(out, variant, lod, x, elevation, z, scale, yaw, 0);
    if (!stump) pushCanopy(out, variant, lod, x, elevation, z, scale, yaw, 0);
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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

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
  pushTrunk(out, variant, lod, x, y, z, scale, yaw, lean);
  pushCanopy(out, variant, lod, x, y, z, scale, yaw, lean);
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
