/**
 * The bounded pool key set — M3's answer to the plan's risk 3, and the reason this file is data
 * rather than code.
 *
 * *"Geometries and materials are pooled per `(biome, archetype)` and **never** created per room or
 * per zone — bound the pool key set explicitly and assert its size in a test."* (§4, Layer C.) The
 * bound has to be a *fact about the program*, not a habit the streamer keeps, or the first archetype
 * somebody adds inside a loop reintroduces the leak. So every key that can ever exist is enumerated
 * here, at module load, from two closed lists and one boolean — and `prototypes.test.ts` asserts the
 * exact count. A change that widens the set fails that test, which is the whole point of the number.
 *
 * ## Why the key is not `(biome, archetype)` for every archetype
 *
 * Naively crossing 16 sectors with 11 archetypes gives 176 materials, twice over for the faded
 * variant. Most of that product is meaningless: a door is a door in a forest and in a cave, and a
 * *portal* is emphatically the same object wherever it hangs. Only three archetypes are terrain —
 * the ground you stand on and the two things that close a room in — and those are the ones the plan
 * means by "dressed by biome: forest→tree wall, cave→rock, city→facade". So:
 *
 * - {@link BIOME_ARCHETYPES} are crossed with all 16 {@link SECTORS}: 3 x 16 = 48.
 * - Everything else gets one material: 10 (nine at M3; click-to-move's `marker` is the tenth).
 * - Everything except the three archetypes that never fade (`self`, `other`, `marker` — see
 *   {@link NEVER_FADED}) gets a faded twin (see {@link FADE_OPACITY}): 55.
 *
 * **113 materials, created once at startup, never again.** That reads like a lot and is not: colour
 * is a uniform rather than a shader define, so all 113 share two compiled programs (opaque and
 * transparent) and the objects themselves are a few hundred bytes each.
 *
 * ## What M4 added, and what it deliberately did not
 *
 * Two materials: the `glow` archetype and its faded twin, for the stairwell markers. **Emissive and
 * fog of war both went in without a single new key**, and each for a reason worth keeping:
 *
 * - `emissive` is a uniform on `MeshLambertMaterial`, not a define, so the portal ring's light lives
 *   in {@link ARCHETYPE_EMISSIVE} beside its colour and costs no program.
 * - Fog of war is `InstancedMesh.instanceColor` (see `fogOfWar.ts`) — per *instance*, so the three
 *   states are three floats a chunk rather than three times the material pool. Keying them into the
 *   material would have taken 112 to 336 and, worse, made "which state is this room in" a property of
 *   the pool rather than of the room. (336 was the M4 figure; click-to-move's `marker` would make it
 *   339 had this file taken the same wrong turn.)
 *
 * The pool is still two programs. That was the constraint M4 was asked to respect and it held.
 *
 * ## Click-to-move's one addition: `marker`
 *
 * The destination ring click-to-move drops under the pointer (`marker.ts`) is a thirteenth archetype
 * rather than a repaint of `glow` or `portal`, because a pool whose keys are *legible* is the property
 * `materialKey`'s own docblock names — "a dump of the pool should be legible" — and a ring meaning "you
 * clicked here" sharing a name with a ring meaning "a way down" or "a way out" is a future reader's
 * false cognate waiting to happen. It follows `self`/`other`'s pattern exactly, not `glow`'s: never
 * faded (it is only ever drawn on the camera's own level, exactly where a body is), so it costs one
 * material and not two, and it is excluded from the per-chunk bucket ceiling in `pool.ts` because it is
 * never part of a room plan — `marker.ts` acquires its one wrapper once, the way `entities.ts` acquires
 * two, and never gives it back.
 *
 * ## Geometry is not keyed by biome at all
 *
 * Five unit shapes, scaled per instance by the matrix. That is what lets one `InstancedMesh` hold a
 * 9 m ground slab and a 0.6 m wall, and it collapses the geometry pool to a constant that does not
 * grow with the world, the zone or the archetype table.
 *
 * ## What M5a added, and the one rule it had to keep
 *
 * Three archetypes (`trunk`, `canopy`, `grass`), one shape (`grassCross`), and **48 geometry keys
 * that are filled in at boot from a manifest rather than built here** — the baked conifers. That last
 * one is the interesting change, because the whole point of this file is that the key set is *"a fact
 * about the program, not a habit the streamer keeps"*, and a set that grew as GLBs streamed in would
 * be exactly the habit. So the bound is kept by naming the trees: {@link TREE_VARIANTS} is a closed
 * list, {@link TREE_LODS} is a closed list, and `TREE_GEOMETRY_KEYS` is their product, enumerated at
 * module load like everything else here. `assets.test.ts` asserts that the baked manifest contains
 * exactly these ids and no others — a variant added to the baker and not to this list would grow a
 * tree nothing can draw, and one added here and not baked would size the pool for a tree that does
 * not exist.
 *
 * The material count goes up by 32 (8 variants x bark and needle, 16 sectors of undergrowth) and the
 * **program** count by two: the card foliage and the blended ground are `onBeforeCompile` patches, and
 * each patch is one program however many materials carry it, because — as at M4 — every difference
 * between two materials in a family is a *uniform*. See `foliage.ts` and `blend.ts`.
 */

import { SECTORS, type Sector } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The six unit shapes this package builds for itself. Everything drawn is one of these under a
 * scale, a baked tree mesh (see {@link TREE_GEOMETRY_KEYS}) or a kit mesh ({@link KIT_GEOMETRY_KEYS}).
 *
 * `box` covers ground, walls, doors, steps, ramps and props; `cone` is the landmark slot; `torus` is
 * both the portal ring — the plan's emissive ring, which M4 lit — and the flat marker a stairwell
 * lays on its floor; `capsule` is a body; `grassCross` is M5a's undergrowth tuft, two quads crossed at
 * right angles, which is the cheapest thing that has a silhouette from every yaw.
 *
 * `waterPlane` is M5b's, and it is a *plane* rather than a thin box for two reasons that are the same
 * reason twice: a water surface is seen from one side, so five of a box's six faces are wasted draws
 * and wasted overdraw in the transparent queue; and the shader reads `position.xz` as the surface's
 * own `(u, v)` exactly as `blend.ts` does over the ground's top face, which only means anything if
 * there *is* one face. It carries the puddle decals too — a puddle is a small water surface.
 *
 * `groundBox` is M5c's, and it is **the same box with a subdivided face** — the one shape whose
 * vertices are displaced by the domain warp rather than its matrix. A slab with four corners on its
 * top face can only draw the warp as a straight line between them, and the chord error over nine
 * metres of this field is **13.8 cm**: a road that turns at each room rather than curving through it,
 * which is the *"hard 12 m beat"* the warp exists to break, wearing a bend. At four segments the
 * error is **0.9 cm**. Nothing else needs it: a wall follows the warp as `warp.ts`'s chord of
 * three-metre pieces and a prop moves whole, so `box` stays twelve triangles and only the ground pays.
 */
export const SHAPE_KEYS = ['box', 'groundBox', 'cone', 'torus', 'capsule', 'grassCross', 'waterPlane'] as const;

export type ShapeKey = (typeof SHAPE_KEYS)[number];

/**
 * A key into the geometry pool.
 *
 * A bare `string` rather than a union of the five shapes, because M5a's tree geometries are named by
 * {@link treeGeometryKey} from three closed lists and TypeScript template-literal unions over 48
 * combinations buy nothing that {@link GEOMETRY_KEYS} membership does not. The pool throws on an
 * unknown key rather than defaulting, which is where the type would have caught it anyway.
 */
export type GeometryKey = string;

/* -------------------------------------------------------------------------- */
/* Trees                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every tree the world can grow — the closed list this package's pool is sized against.
 *
 * Six conifers and two for the bog, which is §6-M5's *"~6 variants"* plus the brief's swamp pair. The
 * ids are the join key between whatever produced the mesh, the material pool and the scatter's biome
 * palettes, and they are as immovable as a room id: renaming one silently unplants a tree.
 *
 * ## The list is closed; where a mesh comes from is not
 *
 * Everything on it today is baked by `packages/worldgen/src/treegen.ts`, and **nothing in this
 * package assumes that.** M5b brings in the Quaternius *Stylized Nature MegaKit* — CC0 GLTF, the
 * owner's chosen art direction — and those trees join this list beside the generated ones. What has
 * to hold either way is only the two facts the pool is built on: the set of ids is fixed at module
 * load, and every id has a `trunk` and a `canopy` mesh at each of {@link TREE_LODS}. A kit model that
 * arrives as one mesh gets split at import; one that ships its own LODs skips the ladder. Neither
 * touches anything here.
 *
 * {@link TREE_SOURCE} is what keeps that honest: it says which producer owes each id its geometry, so
 * `assets.test.ts` can hold the *baked* subset to the treegen manifest exactly, without that
 * assertion becoming a wall the kit has to be smuggled past.
 */
export const TREE_VARIANTS = [
  'pine-tall',
  'pine-broad',
  'pine-young',
  'fir-dense',
  'fir-ragged',
  'pine-crooked',
  'aspen-thin',
  'snag-bare',
  // M5b: the Quaternius Stylized Nature MegaKit's twenty trees, ids as `modelgen.ts` normalises
  // them. Four families of five — the forest workhorse, the conifer, the blasted snag and the
  // landmark — and the ids are the join key between the kit manifest, the pool and the palettes.
  'common-tree-1',
  'common-tree-2',
  'common-tree-3',
  'common-tree-4',
  'common-tree-5',
  'pine-1',
  'pine-2',
  'pine-3',
  'pine-4',
  'pine-5',
  'dead-tree-1',
  'dead-tree-2',
  'dead-tree-3',
  'dead-tree-4',
  'dead-tree-5',
  'twisted-tree-1',
  'twisted-tree-2',
  'twisted-tree-3',
  'twisted-tree-4',
  'twisted-tree-5',
] as const;

export type TreeVariant = (typeof TREE_VARIANTS)[number];

/**
 * Who owes each variant its geometry.
 *
 * `baked` — generated offline by `treegen.ts` and listed in `models/trees/manifest.json`. `kit` —
 * imported from a third-party CC0 set, M5b's Quaternius Nature MegaKit. The distinction exists for
 * exactly two callers: the manifest-integrity test, which must compare like with like, and a future
 * loader that has to know which registry to look in. The *renderer* never asks — a trunk is a trunk.
 */
export const TREE_SOURCES = ['baked', 'kit'] as const;

export type TreeSource = (typeof TREE_SOURCES)[number];

export const TREE_SOURCE: Readonly<Record<TreeVariant, TreeSource>> = {
  'pine-tall': 'baked',
  'pine-broad': 'baked',
  'pine-young': 'baked',
  'fir-dense': 'baked',
  'fir-ragged': 'baked',
  'pine-crooked': 'baked',
  'aspen-thin': 'baked',
  'snag-bare': 'baked',
  'common-tree-1': 'kit',
  'common-tree-2': 'kit',
  'common-tree-3': 'kit',
  'common-tree-4': 'kit',
  'common-tree-5': 'kit',
  'pine-1': 'kit',
  'pine-2': 'kit',
  'pine-3': 'kit',
  'pine-4': 'kit',
  'pine-5': 'kit',
  'dead-tree-1': 'kit',
  'dead-tree-2': 'kit',
  'dead-tree-3': 'kit',
  'dead-tree-4': 'kit',
  'dead-tree-5': 'kit',
  'twisted-tree-1': 'kit',
  'twisted-tree-2': 'kit',
  'twisted-tree-3': 'kit',
  'twisted-tree-4': 'kit',
  'twisted-tree-5': 'kit',
};

/** The variants a given producer owes. `assets.test.ts` holds `baked` to the treegen manifest. */
export function variantsFrom(source: TreeSource): readonly TreeVariant[] {
  return TREE_VARIANTS.filter((variant) => TREE_SOURCE[variant] === source);
}

/**
 * The two meshes a tree can carry, and the reason it is two rather than one.
 *
 * A trunk is opaque bark under an ordinary Lambert; a canopy is alpha-clipped cards under the
 * foliage patch, two-sided, wind-displaced, with its own `customDepthMaterial`. Merging them would
 * force one of those onto the other — either the bark pays for an alpha test it does not need on
 * every fragment, or the needles lose their clip and the tree becomes a set of solid quads.
 *
 * The kit's two-primitive trees land on exactly this split — a bark primitive and a leaf primitive —
 * which is why kit trees join {@link TREE_VARIANTS} rather than needing a second system. See
 * {@link TREE_PARTS_OF} for the one kit family that has only half of it.
 */
export const TREE_PARTS = ['trunk', 'canopy'] as const;

export type TreePart = (typeof TREE_PARTS)[number];

/**
 * The parts a given variant actually has. **`DeadTree` is a trunk and nothing else.**
 *
 * Every baked variant carries both — `treegen.ts` emits two meshes always, and `snag-bare`'s canopy
 * is a sparse one rather than an absent one. The kit's `DeadTree` family is genuinely one primitive:
 * a blasted snag with no leaves on it, so there is no leaf material to give it and no canopy mesh to
 * register.
 *
 * A table rather than a runtime question, for the same reason the rest of this file is a table: the
 * material pool and the geometry key set are enumerated at module load, and a canopy key for a tree
 * that has no canopy would size the pool for a mesh nothing will ever register — which is the
 * *opposite* failure to the one the closed key set exists to prevent, but a failure of the same
 * argument. `scatter.ts` reads it so it never plans a canopy that cannot be drawn.
 */
export const TREE_PARTS_OF: Readonly<Record<TreeVariant, readonly TreePart[]>> = (() => {
  const out: Partial<Record<TreeVariant, readonly TreePart[]>> = {};
  for (const variant of TREE_VARIANTS) {
    out[variant] = variant.startsWith('dead-tree-') ? (['trunk'] as const) : TREE_PARTS;
  }
  return out as Record<TreeVariant, readonly TreePart[]>;
})();

export function treePartsOf(variant: TreeVariant): readonly TreePart[] {
  return TREE_PARTS_OF[variant];
}

/**
 * How many of one *family* of tree a single room may grow. The brief's rationing, as data.
 *
 * > *"TwistedTree … **landmark accents, ≤1 per room, never bulk scatter**"*
 *
 * A `TwistedTree` is 9.1–10.1k triangles on a 9.5–13.5 m crown: six of them along one side of a room
 * is 60k triangles and a silhouette that reads as one enormous shrub. `DeadTree` is cheaper and less
 * dominating but still 5.6–6.6k and 9.5–16.4 m, so it gets a looser ration rather than none.
 * Everything absent from this table is unrationed, which is the right default for a workhorse.
 *
 * Keyed by family and not by variant deliberately: five twisted trees rationed to one *each* is five
 * twisted trees, which is exactly what the brief forbids.
 */
export const TREE_RATION: Readonly<Record<string, number>> = {
  'twisted-tree': 1,
  'dead-tree': 4,
};

/** The family a variant belongs to — `common-tree-3` to `common-tree`. Baked ids are their own. */
export function treeFamily(variant: TreeVariant): string {
  return variant.replace(/-\d+$/, '');
}

/** How many of this variant's family one room may grow. `Infinity` when it is not rationed. */
export function treeRationOf(variant: TreeVariant): number {
  return TREE_RATION[treeFamily(variant)] ?? Infinity;
}

/** Three levels of detail, baked. The metres at which each takes over live in the manifest. */
export const TREE_LODS = [0, 1, 2] as const;

/** The pool key for one tree mesh. Legible in a dump, exactly as {@link materialKey} is. */
export function treeGeometryKey(variant: TreeVariant, part: TreePart, lod: number): GeometryKey {
  return `${part}:${variant}:${lod}`;
}

/**
 * Every key {@link treeGeometryKey} can return, enumerated once.
 *
 * 8 baked x 2 parts x 3 LODs = 48, plus the kit's 35 parts x 3 = 105. **A kit tree has no ladder**
 * and registers the same mesh under all three keys — `trees.ts`'s *"one that ships its own LODs skips
 * the ladder"*, in the direction the kit actually took. The pool counts a geometry's bytes once per
 * *object* rather than once per key (see `ScenePool.registerGeometry`), so the ledger stays honest
 * about the three that are one.
 */
export const TREE_GEOMETRY_KEYS: readonly GeometryKey[] = (() => {
  const keys: GeometryKey[] = [];
  for (const variant of TREE_VARIANTS) {
    for (const part of treePartsOf(variant)) {
      for (const lod of TREE_LODS) keys.push(treeGeometryKey(variant, part, lod));
    }
  }
  return keys;
})();

/* -------------------------------------------------------------------------- */
/* The kit — M5b                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The Quaternius textures the kit's props wear, and the *only* thing that decides how a primitive is
 * drawn.
 *
 * The brief's rule, restated where the pool reads it: *"match by material/texture name — `Leaves_*`,
 * `Grass`, `Flowers` textures sway; bark and rock do not"*. So the texture is the part key: a model's
 * primitives are told apart by which of these they wear, which is unique within a model and is a
 * name a human recognises in a pool dump (`kit|bush-common-flowers|flowers`).
 *
 * Mirrors `worldgen/src/modelgen.ts`'s `kitRole`, and `kit.test.ts` asserts the two agree against the
 * generated manifest — the same contract `assets.test.ts` holds between `treegen` and
 * {@link TREE_VARIANTS}.
 */
export const KIT_TEXTURES = [
  'bark-dead-tree',
  'bark-normal-tree',
  'bark-twisted-tree',
  'flowers',
  'grass',
  'leaf-pine-c',
  'leaves',
  'leaves-normal-tree-c',
  'leaves-twisted-tree-c',
  'mushrooms',
  'path-rocks-diffuse',
  'rocks-diffuse',
] as const;

export type KitTextureId = (typeof KIT_TEXTURES)[number];

export const KIT_ROLES = ['solid', 'leaf'] as const;

export type KitRole = (typeof KIT_ROLES)[number];

/** `modelgen.kitRole`, restated. A leaf sways, clips and draws two-sided; a solid does none of that. */
export function kitRoleOf(texture: string): KitRole {
  if (texture.startsWith('leaves') || texture.startsWith('leaf-')) return 'leaf';
  if (texture === 'grass' || texture === 'flowers') return 'leaf';
  return 'solid';
}

/**
 * Whether a kit part is in the shadow render list.
 *
 * By texture rather than by role, because the role is about *how* a thing is shaded and this is about
 * whether it is worth a draw call in the shadow pass. `path-rocks-diffuse` dresses a road with stones
 * 10 cm tall whose shadow is thinner than the 2 cm shadow texel is soft; `grass`, `flowers` and
 * `leaves` are the ground clutter M5a already excluded `grass` for. Bark, rock and the two tree-canopy
 * leaf textures cast, because a treeline that does not break the light is a treeline that is not there.
 */
export const KIT_TEXTURE_CASTS: Readonly<Record<KitTextureId, boolean>> = {
  'bark-dead-tree': true,
  'bark-normal-tree': true,
  'bark-twisted-tree': true,
  flowers: false,
  grass: false,
  'leaf-pine-c': true,
  leaves: false,
  'leaves-normal-tree-c': true,
  'leaves-twisted-tree-c': true,
  mushrooms: false,
  'path-rocks-diffuse': false,
  'rocks-diffuse': true,
};

/**
 * Every kit model that is **not** a tree, and which textures its primitives wear.
 *
 * Forty-three of the kit's forty-eight non-tree models. The five `Petal_*` are deliberately absent:
 * the brief calls them *"falling-petal particles, optional garnish"* and a petal lying still on the
 * ground is litter rather than garnish, so they are imported by `modelgen` (the manifest is the whole
 * kit) and never given a pool key. That is a named gap, not an oversight — see the M5b report.
 *
 * The order is the manifest's, which is alphabetical by id, so a diff of this list against a
 * re-import is a diff of the kit.
 */
export const KIT_PART_TEXTURES: Readonly<Record<string, readonly KitTextureId[]>> = {
  'bush-common': ['leaves-twisted-tree-c'],
  'bush-common-flowers': ['leaves-normal-tree-c', 'flowers'],
  'clover-1': ['leaves'],
  'clover-2': ['leaves'],
  'fern-1': ['leaves'],
  'flower-3-group': ['leaves', 'flowers'],
  'flower-3-single': ['leaves', 'flowers'],
  'flower-4-group': ['leaves', 'flowers'],
  'flower-4-single': ['leaves', 'flowers'],
  'grass-common-short': ['grass'],
  'grass-common-tall': ['grass'],
  'grass-wispy-short': ['grass'],
  'grass-wispy-tall': ['grass'],
  'mushroom-common': ['mushrooms'],
  'mushroom-laetiporus': ['mushrooms'],
  'pebble-round-1': ['path-rocks-diffuse'],
  'pebble-round-2': ['path-rocks-diffuse'],
  'pebble-round-3': ['path-rocks-diffuse'],
  'pebble-round-4': ['path-rocks-diffuse'],
  'pebble-round-5': ['path-rocks-diffuse'],
  'pebble-square-1': ['path-rocks-diffuse'],
  'pebble-square-2': ['path-rocks-diffuse'],
  'pebble-square-3': ['path-rocks-diffuse'],
  'pebble-square-4': ['path-rocks-diffuse'],
  'pebble-square-5': ['path-rocks-diffuse'],
  'pebble-square-6': ['path-rocks-diffuse'],
  'plant-1': ['leaves'],
  'plant-1-big': ['leaves'],
  'plant-7': ['leaves'],
  'plant-7-big': ['leaves'],
  'rock-medium-1': ['rocks-diffuse'],
  'rock-medium-2': ['rocks-diffuse'],
  'rock-medium-3': ['rocks-diffuse'],
  'rock-path-round-small-1': ['path-rocks-diffuse'],
  'rock-path-round-small-2': ['path-rocks-diffuse'],
  'rock-path-round-small-3': ['path-rocks-diffuse'],
  'rock-path-round-thin': ['path-rocks-diffuse'],
  'rock-path-round-wide': ['path-rocks-diffuse'],
  'rock-path-square-small-1': ['path-rocks-diffuse'],
  'rock-path-square-small-2': ['path-rocks-diffuse'],
  'rock-path-square-small-3': ['path-rocks-diffuse'],
  'rock-path-square-thin': ['path-rocks-diffuse'],
  'rock-path-square-wide': ['path-rocks-diffuse'],
};

/** The closed list of kit prop ids. Forty-three; see {@link KIT_PART_TEXTURES}. */
export const KIT_MODELS: readonly string[] = Object.keys(KIT_PART_TEXTURES);

/**
 * The kit props that stand in the player's way, and are therefore held to the treeline's placement
 * rule rather than the understory's.
 *
 * `Rock_Medium` is ~3 m across and ~2 m tall — the brief's *"trees and `Rock_Medium` block"* — so it
 * goes where a boundary tree goes, outside the room block, in the void the collision grid has no
 * tiles for. Everything else in the kit is knee-high or flat and never implies a blockage the
 * collision grid lacks, which is `scatter.ts`'s strict rule and the reason the owner is not going to
 * get wedged behind a boulder.
 */
export const KIT_BLOCKS: ReadonlySet<string> = new Set(['rock-medium-1', 'rock-medium-2', 'rock-medium-3']);

/**
 * How far a blocking kit model reaches from its own origin at life size, in metres — **measured, and
 * the number a boulder has to be pushed past a wall by.**
 *
 * From the generated nature manifest's `blockRadius`, which `modelgen` takes off the mesh's own
 * bounding box: `rock-medium-1` 1.613, `rock-medium-2` 1.525, `rock-medium-3` 1.738. The largest,
 * rounded up, because the placement rule has to hold for whichever one a hash rolls.
 *
 * `scatter.ts` used a flat 1.1 m clearance until 2026-08-13, which is **less than this** — so a
 * boulder's origin was outside the room block, as the rule requires and the test checked, while half
 * a metre of the boulder itself leaned back over walkable floor. Invisible at life size behind a
 * three-metre wall, and not invisible at all once the mountain edge started drawing them at two and a
 * half times that for the owner's rock face. The clearance is now this radius times the instance's
 * own bulk, and `scatter.test.ts` checks the rock's **extent** rather than its origin.
 */
export const KIT_BLOCK_RADIUS = 1.75;

/** The pool key for one kit primitive. `kit:bush-common-flowers:flowers`. */
export function kitGeometryKey(model: string, texture: string): GeometryKey {
  return `kit:${model}:${texture}`;
}

/** Its material. Same discipline, same shape: `kit|rock-medium-1|rocks-diffuse`. */
export function kitMaterialKey(model: string, texture: string): MaterialKey {
  return `kit|${model}|${texture}`;
}

/** Every `(model, texture)` pair the kit props can produce: 48 across 43 models. */
export const KIT_PARTS: readonly { readonly model: string; readonly texture: KitTextureId }[] = (() => {
  const out: { model: string; texture: KitTextureId }[] = [];
  for (const model of KIT_MODELS) {
    for (const texture of KIT_PART_TEXTURES[model] ?? []) out.push({ model, texture });
  }
  return out;
})();

export const KIT_GEOMETRY_KEYS: readonly GeometryKey[] = KIT_PARTS.map((part) =>
  kitGeometryKey(part.model, part.texture),
);

/* -------------------------------------------------------------------------- */
/* The village — M6                                                            */
/* -------------------------------------------------------------------------- */

/**
 * **The module grid, measured off the pack before a line of this was written.**
 *
 * Every number here came out of a headless bbox sweep over the 176 glTFs (the technique
 * `modelgen.test.ts` uses: `POSITION` accessor min/max, node transforms composed — and there are
 * none, every model in this pack is a single node at identity). `village.test.ts` asserts them back
 * against the generated manifest, so a re-import that moved a module would fail rather than
 * silently unpick the tiling.
 *
 * | measured | value | what it is |
 * | --- | --- | --- |
 * | module | **2.000 m** | every `Wall_*` is `x ∈ [-1, 1]`; every `Floor_*` is 2 x 2 |
 * | wall height | **3.1227 m** | `Wall_Plaster_Straight`, floor to the top of its eave lip |
 * | wall depth | **0.4065 m** | `z ∈ [-0.314, +0.0924]` — the panel laps 31 cm outward, 9 cm in |
 * | roof | **9.952 x 10.332 m**, rise **6.001 m** | `Roof_RoundTiles_8x8`, eaves included |
 *
 * ## How 2 m modules tile a 9 m room
 *
 * They do not, and that is the whole problem: `9 / 2 = 4.5`. What *does* divide our room is **3 m** —
 * `ROOM_METRES / 3` is exactly three, `CONNECTOR_WIDTH` is exactly three tiles, and every wall run the
 * IR can produce is either a full 9 m side or a 3 m flank beside a mouth. So a module is scaled to a
 * **3 m chord** and the tiling is exact with no remainder:
 *
 * ```
 * solid side   [ chord ][ chord ][ chord ]                       3 modules
 * mouth side   [ chord ][ mouth ][ chord ]                       2 modules + an arch
 * floor        3 x 3 chords                                      9 modules
 * ```
 *
 * {@link VILLAGE_SCALE} is that factor, `3 / 2 = 1.5`, and it is applied **in the horizontal only**
 * (X along the run, Z through the wall's thickness; Y untouched). Three consequences, each chosen:
 *
 * 1. **The wall stays 3.12 m tall**, so it fits under `LEVEL_SEPARATION`'s four metres with room for
 *    a ceiling — which a uniform 1.5x would not (4.68 m walls under a 4 m storey is an upper floor
 *    inside a lower one).
 * 2. **The wall becomes 0.61 m thick**, which is `DIMENSIONS.edgeThickness` to within a centimetre.
 *    That is a coincidence and a useful one: the panel occupies exactly the footprint the grey-box
 *    wall it replaces did.
 * 3. **The texture stretches 1.5x horizontally.** This is the honest cost and it is why the palette
 *    is plaster-led: `T_Plaster_BaseColor` is noise and a 50% stretch is invisible in it, while
 *    `T_UnevenBrick` is a course pattern and shows it. The brick wall is therefore the *minority*
 *    variant, used by two of the four zone themes, and the windows chosen are the **Thin** ones —
 *    a thin window stretched by half is a normal window, where a wide one becomes a shopfront.
 *
 * The alternative that needs no stretch was measured and rejected: `9 = 4 x 2 + 2 x 0.5` with a
 * `Corner_Exterior_Brick` quoin (0.531 m) in each half-metre slot tiles a *solid* side exactly, but a
 * 3 m flank then wants `1 x 2 + 2 x 0.5` and the two 0.5 m slots at a doorway jamb are a corner piece
 * used as a jamb; it also doubles the wall instances per side and leaves the 2 m floor module with
 * nothing to tile (`9 / 2` again). One chord length that both the walls and the floor agree on, and
 * that happens to equal `warp.WARP_CHORD_SPAN` so a bent wall is exactly one displaced module per
 * chord, was worth 50% of texel density.
 */
export const VILLAGE_METRICS = {
  /** Metres. The `Wall_*` / `Floor_*` module width, measured. */
  module: 2,
  /** Metres, floor to the top of the eave lip. The ceiling sits *under* the lip — see `interior.ts`. */
  wallHeight: 3.1227,
  wallDepth: 0.4065,
  /** How far the panel laps past its own plane, outward and inward. `[-0.314, +0.0924]`, measured. */
  wallOut: 0.314,
  wallIn: 0.0924,
  /** `Roof_RoundTiles_8x8`, eaves included. */
  roofWidth: 9.952,
  roofDepth: 10.332,
  /** Ridge height above the model's origin: `height + minY`, i.e. `6.781 - 0.78`. */
  roofRise: 6.001,
  /** How far the fascia hangs below the origin. The roof is seated by its wall-plate, not its base. */
  roofDrop: 0.78,
  /** `Wall_Arch`: a 6 cm-deep trim arch, 2 m by 3 m. */
  archHeight: 3,
} as const;

/**
 * The textures the village modules wear — nine, and the whole pack shares them.
 *
 * `MI_WoodTrim` alone dresses 144 of the 299 primitives. Ids are `modelgen.villageTextureId`'s and
 * `village.test.ts` asserts this list against the generated manifest, the same contract
 * {@link KIT_TEXTURES} holds against the nature one.
 */
export const VILLAGE_TEXTURES = [
  'brick',
  'metal-ornaments',
  'plaster',
  'red-brick',
  'rock-trim',
  'round-tiles',
  'uneven-brick',
  'vine-leaf',
  'wood-trim',
] as const;

export type VillageTextureId = (typeof VILLAGE_TEXTURES)[number];

/** What a village module is *for*. Decides where `interior.ts` puts it and whether it casts. */
export const VILLAGE_ROLES = ['wall', 'arch', 'floor', 'roof', 'prop'] as const;

export type VillageRole = (typeof VILLAGE_ROLES)[number];

/**
 * The eleven modules the interior mode draws, their parts, and what each is for.
 *
 * Eleven of a hundred and seventy-six, and the shortness is a pool decision before it is an art one:
 * every `(model, texture)` pair is a bucket, and the ceiling in `pool.ts` is `models per room x parts
 * per model`. What is *absent* is therefore worth naming, because none of it is an oversight:
 *
 * - **Stairs.** `Stair_Interior_Solid` is a 4.7 m flight and the IR's stair block is
 *   `STAIR_TILES` = 3 m square. Squeezing a 4.7 m run into 3 m changes the tread-to-riser ratio into
 *   something no builder ever made. Flights keep M3's box steps until the stair block is revisited.
 * - **Doors and door frames.** `DoorFrame_*` is 1.57 m wide against a 3 m carved mouth, so it would
 *   stand in the middle of an opening the collision grid says is walkable end to end. The mouth gets
 *   `wall-arch` — 3 m at {@link VILLAGE_SCALE}, exactly the opening — and `chunkPlan`'s existing door
 *   leaf still swings inside it.
 * - **Balconies, overhangs, shutters, fences, wagons, vines.** All of them are *placed* things that
 *   want a rule of their own; none of them is load-bearing for "no sky from an interior". `Prop_Vine*`
 *   is the one this milestone most regrets: it is an alpha-masked leaf sheet that would sit on
 *   `foliage.ts`'s existing kit-leaf material with no new program, and a city wall with vines on it is
 *   most of what makes a street read as lived-in. It is a named gap, not a limitation.
 * - **`MI_WindowGlass`** — seven primitives, all on `Door_*` leaves, carrying no texture at all
 *   (`texture: 'none'` in the manifest). Imported and given no pool key, exactly as the nature kit's
 *   five `Petal_*` are.
 *
 * The order is the manifest's, so a diff of this list against a re-import is a diff of the kit.
 */
export const VILLAGE_PART_TEXTURES: Readonly<Record<string, readonly VillageTextureId[]>> = {
  'floor-brick': ['brick'],
  'floor-uneven-brick': ['uneven-brick'],
  'floor-wood-dark': ['wood-trim'],
  'prop-chimney2': ['uneven-brick'],
  'roof-round-tiles-8x8': ['round-tiles', 'wood-trim'],
  'wall-arch': ['wood-trim'],
  'wall-plaster-straight': ['plaster', 'wood-trim'],
  'wall-plaster-window-wide-flat2': ['plaster', 'wood-trim'],
  'wall-plaster-wood-grid': ['plaster', 'wood-trim'],
  'wall-uneven-brick-straight': ['plaster', 'uneven-brick', 'wood-trim'],
  'wall-uneven-brick-window-thin-round': ['plaster', 'uneven-brick', 'wood-trim'],
};

export const VILLAGE_MODELS: readonly string[] = Object.keys(VILLAGE_PART_TEXTURES);

/** What each module is for. Derived from the id's own prefix, which is `modelgen.villageFamily`'s. */
export const VILLAGE_ROLE_OF: Readonly<Record<string, VillageRole>> = {
  'floor-brick': 'floor',
  'floor-uneven-brick': 'floor',
  'floor-wood-dark': 'floor',
  'prop-chimney2': 'prop',
  'roof-round-tiles-8x8': 'roof',
  'wall-arch': 'arch',
  'wall-plaster-straight': 'wall',
  'wall-plaster-window-wide-flat2': 'wall',
  'wall-plaster-wood-grid': 'wall',
  'wall-uneven-brick-straight': 'wall',
  'wall-uneven-brick-window-thin-round': 'wall',
};

export function villageRoleOf(model: string): VillageRole {
  return VILLAGE_ROLE_OF[model] ?? 'prop';
}

/**
 * What is in the shadow render list, by role rather than by texture.
 *
 * `KIT_TEXTURE_CASTS` keys on the texture because a kit part's bulk is a fact about the *object* — a
 * 10 cm path stone and a 3 m boulder are both `rocks`. A village module's bulk is a fact about its
 * *role*: every wall is a wall. **A floor does not cast**, on `ARCHETYPE_CASTS`'s own argument for
 * `ground` — a 2 cm slab shadowing the slab beside it is acne with a long name — and neither does the
 * ceiling, which is `chunkPlan`'s grey slab and never a village module at all.
 */
export const VILLAGE_ROLE_CASTS: Readonly<Record<VillageRole, boolean>> = {
  wall: true,
  arch: true,
  floor: false,
  roof: true,
  prop: true,
};

/** `village:wall-plaster-straight:plaster`. Same discipline as {@link kitGeometryKey}. */
export function villageGeometryKey(model: string, texture: string): GeometryKey {
  return `village:${model}:${texture}`;
}

/**
 * Its material — and the third key shape in this file, with a fourth segment the other two lack.
 *
 * `open` is **not** `materialKey`'s `dim`, and conflating the two would be a real bug. `dim` means
 * *"this is the level below"* and is `prototypes`'s vertical-policy fade; `open` means *"this wall
 * stands between the camera and the room the player is standing in"* and is `interior.ts`'s
 * near-wall fade. They are different questions with different opacities, they are never both true —
 * the village kit dresses nothing on the level below (see {@link NEVER_FADED}) — and giving the
 * second one its own word is what stops a future reader from "unifying" them.
 */
export function villageMaterialKey(model: string, texture: string, open = false): MaterialKey {
  return `village|${model}|${texture}${open ? '|open' : ''}`;
}

/** Every `(model, texture)` pair the interior mode can draw: 19 across 11 models. */
export const VILLAGE_PARTS: readonly { readonly model: string; readonly texture: VillageTextureId }[] = (() => {
  const out: { model: string; texture: VillageTextureId }[] = [];
  for (const model of VILLAGE_MODELS) {
    for (const texture of VILLAGE_PART_TEXTURES[model] ?? []) out.push({ model, texture });
  }
  return out;
})();

export const VILLAGE_GEOMETRY_KEYS: readonly GeometryKey[] = VILLAGE_PARTS.map((part) =>
  villageGeometryKey(part.model, part.texture),
);

/* -------------------------------------------------------------------------- */
/* The furniture — M9                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The Fantasy Props MegaKit's atlases — **four of five, and three of the four are already paid for.**
 *
 * `trim-furniture`, `trim-metal` and `trim-props` are the same three the character packs' held props
 * wear ({@link CHARACTER_PROP_TEXTURES}), and `ScenePool.registerTexture` is keyed by manifest id, so
 * whichever pack's fetch lands first pays and the other gets them free. What this kit actually adds
 * to the wire is `trim-cloth` — a banner, a bedspread, a training dummy's sacking — at 1.9 MB.
 *
 * `page-noise` is the fifth and is deliberately absent: it is a **4096²** sheet, 7.3 MB, worn by the
 * two `Scroll_*` primitives and nothing else. A scroll is 24 cm of prop that this camera cannot read
 * at any dolly distance, so the models are imported (the manifest is the whole pack, as both other
 * prop kits' are) and given no pool key — the same named gap the nature kit's five `Petal_*` are.
 */
export const PROPS_TEXTURES = ['trim-cloth', 'trim-furniture', 'trim-metal', 'trim-props'] as const;

export type PropsTextureId = (typeof PROPS_TEXTURES)[number];

/**
 * Everything a piece of furniture is, in one row — **measured off the pack, not chosen.**
 *
 * The footprint is what `furnish.ts` sites against `roomScene.walkableRequired`, so it has to be the
 * model's own and it has to be here rather than read from the manifest: the planner is pure and runs
 * in the whole-world sweep where no manifest exists, exactly as `VILLAGE_METRICS` is. `props.test.ts`
 * asserts every number back against the generated manifest, so a re-import that resized a bookcase
 * fails rather than quietly standing it in a doorway.
 */
export interface PropsMetric {
  /** Metres, east–west at the model's own yaw. */
  readonly width: number;
  /** Metres, north–south at the model's own yaw. This is the one the arrival ring cares about. */
  readonly depth: number;
  readonly height: number;
}

/**
 * The twenty-six models the furniture pass draws, of the pack's ninety-four.
 *
 * Short for `VILLAGE_PART_TEXTURES`' reason before it is short for any other: every `(model,
 * texture)` pair is a bucket and `pool.ts`'s ceiling is `models per room x parts per model`. What is
 * **absent** is worth naming, because none of it is an oversight and three of the four groups are
 * findings rather than taste:
 *
 * - **`Anvil` and `Chest_Wood` carry two primitives on one atlas.** A pool key is
 *   `(model, texture)` and `ScenePool.registerGeometry` is first-wins, so the second primitive would
 *   be silently dropped and the chest would arrive without its lid. `Anvil_Log` — the same anvil on
 *   a chopping block — has three primitives on three atlases and is the better smithy piece anyway.
 * - **`Axe_Bronze`, `Crate_Wooden` and `Chest_Wood` are not a single node at identity.** The village
 *   and nature packs are ({@link VILLAGE_METRICS} says so, and it is why the importer measures a
 *   bounding box straight off the accessors); these three carry a node rotation or a 0.78 scale that
 *   nothing downstream composes, so the manifest's footprint would be wrong by up to 28%.
 *   `Crate_Metal` and `FarmCrate_Empty` stand in for the wooden crate.
 * - **`Table_Large` (2.85 x 1.10 m) and `Bed_Twin1/2` (1.88 x 2.41 m) do not fit any legal slot.**
 *   See `furnish.ts`: the room grid's largest free rectangle is the one-tile strip against a wall or
 *   a 2 x 2 m island, and both of those pieces are bigger than both. They are a named gap, and the
 *   fix is a smaller model rather than a relaxed law.
 * - **Everything you put *on* furniture** — the mug, the plate, the fork, the candle, the coin pile,
 *   the bottles. They want a surface to stand on and this pass sites on floor tiles, so a tankard
 *   would sit on the boards beside the bench. A second pass that dresses a table top is the follow-up
 *   and is why the models are imported.
 *
 * The order is the manifest's, so a diff of this list against a re-import is a diff of the kit.
 */
export const PROPS_PART_TEXTURES: Readonly<Record<string, readonly PropsTextureId[]>> = {
  'anvil-log': ['trim-furniture', 'trim-metal', 'trim-props'],
  bag: ['trim-cloth', 'trim-furniture'],
  barrel: ['trim-furniture', 'trim-metal'],
  'barrel-holder': ['trim-furniture', 'trim-metal'],
  bench: ['trim-furniture', 'trim-metal'],
  'book-stand': ['trim-furniture'],
  'bookcase-2': ['trim-furniture', 'trim-metal'],
  'bucket-wooden-1': ['trim-furniture', 'trim-metal'],
  cabinet: ['trim-furniture', 'trim-metal'],
  'cage-small': ['trim-metal'],
  'candle-stick-stand': ['trim-metal', 'trim-props'],
  cauldron: ['trim-metal'],
  'chair-1': ['trim-furniture', 'trim-metal'],
  'crate-metal': ['trim-furniture', 'trim-metal'],
  dummy: ['trim-furniture', 'trim-metal', 'trim-cloth'],
  'farm-crate-empty': ['trim-furniture', 'trim-metal'],
  'nightstand-shelf': ['trim-furniture'],
  'pot-1': ['trim-metal'],
  'rope-2': ['trim-furniture'],
  'stall-cart-empty': ['trim-metal', 'trim-furniture', 'trim-cloth'],
  'stall-empty': ['trim-metal', 'trim-furniture', 'trim-cloth'],
  stool: ['trim-furniture'],
  'vase-2': ['trim-props'],
  'weapon-stand': ['trim-furniture', 'trim-metal'],
  whetstone: ['trim-furniture', 'trim-metal', 'trim-props'],
  workbench: ['trim-furniture', 'trim-metal'],
};

/** The closed list of drawn furniture ids. Twenty-six; see {@link PROPS_PART_TEXTURES}. */
export const PROPS_MODELS: readonly string[] = Object.keys(PROPS_PART_TEXTURES);

/**
 * Each drawn model's own extents, in metres — the pack's numbers, to the millimetre.
 *
 * **This kit is correctly scaled and that is worth recording, because the nature kit's understory was
 * not.** A barrel is 0.90 m tall, a stool 0.59, a table 0.81, a bookcase 2.55 and a training dummy
 * 1.86 against a 1.81 m character. Nothing here is multiplied by anything: a furniture placement's
 * scale is 1 unless the scenery catalogue's own footprint says otherwise (see
 * {@link SCENERY_MODELS}).
 */
export const PROPS_METRICS: Readonly<Record<string, PropsMetric>> = {
  'anvil-log': { width: 0.929, depth: 0.821, height: 1.073 },
  bag: { width: 0.655, depth: 0.544, height: 0.799 },
  barrel: { width: 0.698, depth: 0.698, height: 0.898 },
  'barrel-holder': { width: 1.359, depth: 0.741, height: 1.257 },
  bench: { width: 2.777, depth: 0.534, height: 0.533 },
  'book-stand': { width: 0.507, depth: 0.511, height: 1.447 },
  'bookcase-2': { width: 1.461, depth: 0.429, height: 2.545 },
  'bucket-wooden-1': { width: 0.434, depth: 0.383, height: 0.293 },
  cabinet: { width: 1.362, depth: 0.357, height: 0.997 },
  'cage-small': { width: 0.855, depth: 0.884, height: 0.805 },
  'candle-stick-stand': { width: 0.732, depth: 0.731, height: 1.313 },
  cauldron: { width: 0.989, depth: 0.944, height: 0.816 },
  'chair-1': { width: 0.581, depth: 0.549, height: 1.123 },
  'crate-metal': { width: 0.864, depth: 0.866, height: 0.868 },
  dummy: { width: 0.809, depth: 0.585, height: 1.863 },
  'farm-crate-empty': { width: 0.714, depth: 0.414, height: 0.244 },
  'nightstand-shelf': { width: 0.693, depth: 0.393, height: 1.216 },
  'pot-1': { width: 0.539, depth: 0.486, height: 0.224 },
  'rope-2': { width: 0.808, depth: 0.845, height: 0.124 },
  'stall-cart-empty': { width: 3.021, depth: 1.06, height: 2.632 },
  'stall-empty': { width: 1.845, depth: 0.932, height: 2.627 },
  stool: { width: 0.475, depth: 0.475, height: 0.589 },
  'vase-2': { width: 0.695, depth: 0.695, height: 0.516 },
  'weapon-stand': { width: 1.386, depth: 0.983, height: 1.109 },
  whetstone: { width: 1.141, depth: 0.902, height: 1.17 },
  workbench: { width: 2.019, depth: 1.024, height: 0.895 },
};

/**
 * Which models stand in for a {@link scenery.SceneryKind} — **and the four kinds nothing does.**
 *
 * `SCENERY_KINDS` names ten things and this pack contains exactly one of them: a cart. There is **no
 * fountain, no well, no statue and no haystack** in either the Fantasy Props kit or the Medieval
 * Village kit — checked model by model, not assumed — so those four keep `chunkPlan`'s grey box and
 * are reported as a sourcing gap rather than filled with something that is nearly one. The four
 * scatter kinds (`stump`, `log`, `bush`, `toadstools`) are the *nature* kit's business and are
 * already dressed by `scatter.ts`; a plinth is a stepped granite dais with a noticeboard bolted to it
 * and the pack has no such thing either.
 *
 * Two entries for `cart` because the pack has two wheeled trade props and they are different objects:
 * `Stall_Empty` is a market booth and `Stall_Cart_Empty` is the same booth on shafts and a wheel.
 * Which one a room gets is its seed's; **both are scaled to the catalogue's own footprint** by
 * `furnish.sceneryScale`, which is why the cart's 3.02 m length is not a problem and is also why the
 * scale is derived rather than chosen.
 */
export const SCENERY_MODELS: Readonly<Record<string, readonly string[]>> = {
  cart: ['stall-empty', 'stall-cart-empty'],
};

/** The pool key for one furniture primitive. `props:barrel:trim-metal`. */
export function propsGeometryKey(model: string, texture: string): GeometryKey {
  return `props:${model}:${texture}`;
}

/**
 * Its material — **one per atlas, not one per pair**, which is {@link CHARACTER_TEXTURES}' break with
 * the two scatter kits and it is right here for the same reason.
 *
 * A kit material's identity is its `(model, texture)` pair because two bushes wearing one leaf atlas
 * still want different `uTreeHeight`s. A furniture material carries no per-model uniform at all — it
 * is a Lambert with a base-colour map and the pack's baked vertex colour — so a barrel and a bookcase
 * wearing `T_Trim_Furniture` are the *same* material, and giving them one each would be 26 copies of
 * four. Four materials for the whole kit, and no new program: see {@link materialFamily}.
 */
export function propsMaterialKey(texture: string): MaterialKey {
  return `props|${texture}`;
}

/** Every `(model, texture)` pair the furniture pass can draw: 49 across 26 models. */
export const PROPS_PARTS: readonly { readonly model: string; readonly texture: PropsTextureId }[] = (() => {
  const out: { model: string; texture: PropsTextureId }[] = [];
  for (const model of PROPS_MODELS) {
    for (const texture of PROPS_PART_TEXTURES[model] ?? []) out.push({ model, texture });
  }
  return out;
})();

export const PROPS_GEOMETRY_KEYS: readonly GeometryKey[] = PROPS_PARTS.map((part) =>
  propsGeometryKey(part.model, part.texture),
);

/**
 * Distinct furniture **models** one room may draw. Two, and it is a pool constant before it is a
 * design one — see `pool.FURNITURE_WRAPPER_CEILING`.
 *
 * Two families of object placed several times each is also how a real room reads: a tavern is benches
 * and barrels, a library is bookcases and a lectern, a smithy is an anvil and a whetstone. Six of one
 * and half a dozen of another is a showroom.
 */
export const PROPS_MODELS_PER_ROOM = 2;

/** Primitives the widest drawn furniture model has. Three: wood, iron and cloth on one market stall. */
export const PROPS_PARTS_MAX = 3;

/** Instances one room may grow, across both its models. Well inside `pool.WRAPPER_CAPACITY`. */
export const PROPS_PER_ROOM_MAX = 12;

/* -------------------------------------------------------------------------- */
/* The character packs — M7b                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The twelve textures the base bodies, the outfit parts and the four props share between them.
 *
 * **Keyed by texture and not by `(model, texture)`**, which is the one place characters break the
 * pattern the two prop kits set — and deliberately. A kit material's identity is its pair because two
 * bushes wearing one leaf atlas still want different `uTreeHeight`s; a character material carries no
 * per-model uniform at all, so `Male_Peasant_Body` and `Female_Peasant_Legs` are the *same*
 * Lambert-with-the-peasant-atlas and giving them one each would be 26 copies of one material.
 *
 * Twelve materials, and — because a character primitive is a Lambert with a texture and a vertex
 * colour drawn single-sided, which is `kitSolid`'s shape to the `#define` — **zero new programs**.
 * That is the same free ride M6's village modules took and it is checked the same way, by
 * `ScenePool.programKeys()` still answering seven.
 *
 * `ranger` dresses 17 of the 41 primitives on its own; `trim-props` dresses the sword, the axe and
 * part of the shield. Ids are `modelgen.villageTextureId`'s, which the characters profile reuses.
 */
export const CHARACTER_TEXTURES = [
  'eye-brown',
  'hair-1',
  'hair-2',
  'peasant',
  'ranger',
  'regular-female-dark',
  'regular-male-dark',
  'superhero-female-dark',
  'superhero-male-dark',
  'trim-furniture',
  'trim-metal',
  'trim-props',
] as const;

export type CharacterTextureId = (typeof CHARACTER_TEXTURES)[number];

/**
 * The three atlases only a **held prop** wears — and the reason this list exists is a `#define`.
 *
 * A body is a `SkinnedMesh` and a sword in its hand is a plain `Mesh` parented to the hand bone (see
 * `body.ts`: a prop's geometry has no `skinIndex`, so skinning it would draw it at the origin).
 * `USE_SKINNING` is an **object**-level define in three, not a material one, so those two draw with
 * two compiled programs however identical their materials are.
 *
 * `ScenePool.programKeys()` is the headless proxy for the real program count and its whole value is
 * being *honest* — under-reporting by one is worse than not having it. So the split is declared here,
 * where it can be checked: the two texture sets are **disjoint** (measured — nothing wearing
 * `trim-*` is ever skinned and nothing wearing `peasant`/`ranger`/`superhero-*` is ever rigid), which
 * is what makes "is this material's object skinned" answerable from the material alone.
 */
export const CHARACTER_PROP_TEXTURES: ReadonlySet<string> = new Set(['trim-furniture', 'trim-metal', 'trim-props']);

/**
 * A character primitive's pooled geometry — `character:Male_Ranger_Feet_Boots:ranger`.
 *
 * The **vendor's stem** rather than the kebab id, because that is what is on the wire: `appearance.ts`
 * emits `outfit:Male_Ranger_Feet_Boots` and the renderer should not have to re-derive a name whose
 * round trip is lossy in exactly the two places the vendor was inconsistent.
 */
export function characterGeometryKey(stem: string, texture: string): GeometryKey {
  return `character:${stem}:${texture}`;
}

/** Its material — one per texture. See {@link CHARACTER_TEXTURES} for why the model is not in the key. */
export function characterMaterialKey(texture: string): MaterialKey {
  return `character|${texture}`;
}

/**
 * The wall modules a room may pick from, by role — the palettes `interior.ts` rolls against.
 *
 * Two entries per row and the bound is what matters: {@link VILLAGE_WALL_MODELS_PER_ROOM} plain
 * walls plus one feature wall would make a chunk's bucket count a property of a hash, so a room takes
 * exactly one plain and one feature and the pool is sized for `2 x` {@link VILLAGE_PARTS_MAX}.
 */
export const VILLAGE_WALLS: readonly {
  readonly plain: string;
  readonly window: string;
}[] = [
  { plain: 'wall-plaster-straight', window: 'wall-plaster-window-wide-flat2' },
  { plain: 'wall-plaster-wood-grid', window: 'wall-plaster-window-wide-flat2' },
  { plain: 'wall-uneven-brick-straight', window: 'wall-uneven-brick-window-thin-round' },
  { plain: 'wall-plaster-straight', window: 'wall-uneven-brick-window-thin-round' },
];

/** Floor modules, one per zone theme. Boards for a house, brick and flag for a hall. */
export const VILLAGE_FLOORS: readonly string[] = [
  'floor-wood-dark',
  'floor-uneven-brick',
  'floor-brick',
  'floor-wood-dark',
];

/** Distinct wall **models** one room may draw: a plain and a feature. A pool constant. */
export const VILLAGE_WALL_MODELS_PER_ROOM = 2;

/** Primitives the widest village model has. Three: plaster, brick and timber on one brick wall. */
export const VILLAGE_PARTS_MAX = 3;

/**
 * The chord one village module is stretched to, in metres — **the module grid mapping, as one number.**
 *
 * Derived, not chosen: `CONNECTOR_WIDTH` tiles is the width of every mouth the collision grid carves
 * between two indoor rooms, `ROOM_METRES / VILLAGE_CHORD` is exactly three, and `warp.WARP_CHORD_SPAN`
 * is the same three metres — so one module is one mouth, one side is three modules, and a warped wall
 * is one displaced module per chord with no subdivision. See {@link VILLAGE_METRICS} for the measured
 * grid this maps from and for the alternative that was rejected.
 */
export const VILLAGE_CHORD = 3;

/** `3 / 2`. Horizontal only — see {@link VILLAGE_METRICS} for why Y is untouched. */
export const VILLAGE_SCALE = VILLAGE_CHORD / VILLAGE_METRICS.module;

/**
 * Every geometry the pool can ever hold: the shapes it builds, the trees it is handed, and the kit.
 *
 * The tree and kit entries are **absent from the pool until their manifests load** and the scatter
 * simply draws nothing for a key it cannot resolve — which is the correct behaviour for the second
 * and a half between the first `zone` message and the last model, and the correct behaviour for ever
 * if somebody ships without running the importers.
 */
export const GEOMETRY_KEYS: readonly GeometryKey[] = [
  ...SHAPE_KEYS,
  ...TREE_GEOMETRY_KEYS,
  ...KIT_GEOMETRY_KEYS,
  ...VILLAGE_GEOMETRY_KEYS,
  ...PROPS_GEOMETRY_KEYS,
];

/* -------------------------------------------------------------------------- */
/* Archetypes                                                                  */
/* -------------------------------------------------------------------------- */

/** What a thing *is*, for the purpose of choosing a material and a shape. */
export const ARCHETYPES = [
  'ground',
  'edge',
  'barrier',
  'door',
  'doorOpen',
  'portal',
  'glow',
  'stair',
  'prop',
  'landmark',
  'self',
  'other',
  'marker',
  'trunk',
  'canopy',
  'grass',
  // M5b. `kitSolid`/`kitLeaf` are the two ways a Quaternius primitive is drawn (see
  // {@link kitRoleOf}); `water` is the per-chunk surface and `puddle` its wet-weather cousin.
  'kitSolid',
  'kitLeaf',
  'water',
  'puddle',
  // M6, the second rendering mode. `ceiling` is the grey-box lid every roofed room gets — biome
  // keyed, because the underside of a cave is not the underside of an inn — and it is what makes
  // *"no sky from an interior"* true for all 21,978 roofed rooms whether or not the village kit was
  // ever imported. `villageSolid` is every Quaternius Medieval Village primitive, and it is one
  // archetype rather than five because the thing that varies between a wall and a floor is where
  // `interior.ts` puts it, not how the pool draws it.
  'ceiling',
  'villageSolid',
  // M7b. Every primitive of every body, garment and held prop — one archetype for the same reason
  // `villageSolid` is one: what varies between a hood and a sword is where the *rig* puts it, not how
  // the pool draws it. Never a `planChunk` placement, so it is carved out of the per-chunk ceiling
  // exactly as `self`/`other`/`marker` are.
  'character',
  // M9. Every Fantasy Props primitive — a barrel, a bookcase, a market stall. One archetype for
  // `villageSolid`'s reason exactly: what varies between an anvil and a bed is where `furnish.ts`
  // puts it, not how the pool draws it. Keyed by `(model, texture)` in the geometry and by texture
  // alone in the material, and carved out of the per-chunk ceiling because it is `furnish.ts`'s and
  // rides `DRESSED_WRAPPER_CEILING` with the rest of the dressing.
  'propSolid',
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

/**
 * The archetypes whose material is keyed by tree variant rather than by sector — M5a.
 *
 * A bark is a *species*, not a biome: the same pine standing at the edge of a field and at the edge
 * of a forest is the same tree, and keying it by sector would have made 16 copies of each of eight
 * trees for no visible difference. The variant already carries everything that varies — the manifest
 * gives each one its bark and needle colour, its cone slope, its tier count and its droop — so the
 * key is the variant and nothing else.
 */
export const VARIANT_ARCHETYPES = ['trunk', 'canopy'] as const satisfies readonly Archetype[];

const VARIANT_KEYED: ReadonlySet<Archetype> = new Set<Archetype>(VARIANT_ARCHETYPES);

/**
 * The archetypes whose material depends on the ground they stand on.
 *
 * `edge` is the plan's "one rule, a third of all edges" — 32.2% of the world's boundaries dressed by
 * biome — and `barrier` is the correctness requirement that must read as solid; both are terrain and
 * both change with the sector. M5a adds `grass`, and it is terrain in exactly the same sense: the
 * undergrowth of a fen is not the undergrowth of a heath, and it is the tuft's colour rather than its
 * shape that says which. Nothing else changes with the sector.
 */
export const BIOME_ARCHETYPES = [
  'ground',
  'edge',
  'barrier',
  'grass',
  // M6. A ceiling is terrain in exactly the sense the other four are: the lid of a cave is wet rock
  // and the lid of a cellar is boards, and it is the *sector* that says which. It is also the only
  // one of the five that is only ever seen from **above** at this camera — see `interior.ts`.
  'ceiling',
] as const satisfies readonly Archetype[];

const BIOME_KEYED: ReadonlySet<Archetype> = new Set<Archetype>(BIOME_ARCHETYPES);

/**
 * Archetypes that never fade.
 *
 * A body is only ever on your own level — interest management is room-scoped and a room is on one
 * level — so a faded capsule would be a variant nothing can produce. `marker` joins them for the same
 * reason: click-to-move only ever aims at ground on the level the player is walking (`main.ts` gates
 * the unprojection plane on the player's own `groundAt`), so a faded destination ring is equally a
 * variant nothing can produce.
 *
 * M5a's three scatter archetypes join them, and this is a design decision rather than a saving:
 * **the level below grows nothing.** A treeline drawn at 30% alpha through the floor you are standing
 * on is not the cliff read the fade exists for, it is noise over a shaft — and a transparent
 * alpha-clipped card is a contradiction in the first place, because `alphaToCoverage` needs an opaque
 * draw to resolve against. It also halves what the scatter costs the wrapper ceiling: only the
 * camera's own level ever asks for a tree. See `pool.ts`'s `WRAPPER_POOL_SIZE`.
 */
const NEVER_FADED: ReadonlySet<Archetype> = new Set<Archetype>([
  'self',
  'other',
  'marker',
  'trunk',
  'canopy',
  'grass',
  // M5b's four join them for M5a's reason and one of their own. The kit is scatter and the level
  // below grows nothing. Water and puddles are *surfaces*, and a transparent surface drawn at 30%
  // over a transparent surface is two lies about depth in one pixel — a lake one level down reads as
  // a lake because the ground under it is faded, not because the lake is.
  'kitSolid',
  'kitLeaf',
  'water',
  'puddle',
  // M6's village modules join them for M5a's reason exactly — **the level below is not dressed** —
  // and for one of their own. A village wall's only transparent state is `interior.ts`'s near-wall
  // fade, which means *"you are standing behind this"*; a second transparency meaning *"this is a
  // storey down"* on the same panel would be two readings of one alpha, and a shaft in Skullport
  // would be indistinguishable from a wall the camera is looking through. The level below keeps its
  // grey shell, faded, which is the cliff read M3 designed and M6 must not blur.
  'villageSolid',
  // M9's furniture, for the village modules' reason and one more: furniture is only ever placed
  // inside a room `interior.ts` has already dressed, and that room's walls are not drawn on the level
  // below either — so a floating barrel at 30% alpha would be the only thing visible of a storey the
  // renderer is deliberately showing as an empty grey shell.
  'propSolid',
]);

/**
 * The default shape for an archetype.
 *
 * The three scatter archetypes are the exception the `Placement.geometry` field exists for: a trunk's
 * geometry is a *(variant, LOD)* pair chosen per room and per chunk distance, so `scatter.ts` writes
 * the key straight onto the placement and these entries are only the LOD0 fallback a reader would
 * expect to find. `grass` is genuinely one shape.
 */
export const ARCHETYPE_GEOMETRY: Readonly<Record<Archetype, GeometryKey>> = {
  // The one subdivided shape, and the only archetype whose vertices the warp moves. See `SHAPE_KEYS`.
  ground: 'groundBox',
  edge: 'box',
  barrier: 'box',
  door: 'box',
  doorOpen: 'box',
  portal: 'torus',
  glow: 'torus',
  stair: 'box',
  prop: 'box',
  landmark: 'cone',
  self: 'capsule',
  other: 'capsule',
  // A flat ring, exactly `glow`'s shape — see `marker.ts` for why the geometry is shared but the
  // material is not.
  marker: 'torus',
  trunk: treeGeometryKey(TREE_VARIANTS[0], 'trunk', 0),
  canopy: treeGeometryKey(TREE_VARIANTS[0], 'canopy', 0),
  grass: 'grassCross',
  // The kit's two are the same exception as `trunk`/`canopy`: `scatter.ts` writes the real key onto
  // the placement, and these are the LOD0 fallback a reader would expect to find.
  kitSolid: KIT_GEOMETRY_KEYS[0] ?? 'box',
  kitLeaf: KIT_GEOMETRY_KEYS[0] ?? 'box',
  water: 'waterPlane',
  puddle: 'waterPlane',
  // M6. A ceiling is a slab like the ground is, but on the plain `box`: the warp does not reach a
  // roofed room (`warp.ts` measured 22,372 of them at exactly zero displacement), so there is
  // nothing for a subdivided top face to bend to and 84 triangles a room to pay for it.
  ceiling: 'box',
  // The same exception `kitSolid` is: `interior.ts` writes the real key onto the placement and this
  // is the fallback a reader would expect to find.
  villageSolid: VILLAGE_GEOMETRY_KEYS[0] ?? 'box',
  // Never read: a character primitive's geometry is chosen by the rig from the wire's own model and
  // gear ids, never from an archetype default. A box so the table stays total.
  character: 'box',
  // The same exception `villageSolid` is: `furnish.ts` writes the real key onto the placement and
  // this is the fallback a reader would expect to find.
  propSolid: PROPS_GEOMETRY_KEYS[0] ?? 'box',
};

/**
 * What casts a shadow, and — by its absence — what does not. M4.
 *
 * `receiveShadow` is **not** here: everything receives, always, set once when a wrapper is minted.
 * (In r185 that is a uniform rather than a define — `WebGLRenderer.js:2690` — so varying it would
 * cost no program, which is worth knowing and is not the reason. The reason is that there is nothing
 * in a grey-box scene that should be exempt from moonlight, and a second per-archetype table whose
 * every entry is `true` is a table that will one day be wrong in one row.)
 *
 * `castShadow` is what varies, and it decides membership of the shadow render list rather than
 * anything about the shader:
 *
 * - **`ground` does not cast.** A 0.2 m slab shadowing the slab beside it is acne with a long name,
 *   and there is nothing under it at M4 for a real shadow to land on. Excluding it also halves the
 *   shadow pass's draw calls, because ground is the one archetype every chunk has.
 * - **`portal` and `glow` do not cast.** They are light sources. A ring that occludes the moon reads
 *   as a hole in the world rather than as a thing that shines.
 * - **`marker` does not cast**, for the same reason as `portal`/`glow`: it is a UI cue floating a few
 *   centimetres off the ground, not an object, and a shadow under a destination ring would read as a
 *   solid disc sitting on the grass rather than as a mark on it.
 * - Everything with height casts, including bodies: the plan's *"soft moon shadows"* is mostly walls
 *   and props, but a character with no shadow floats however good the terrain looks.
 * - **`trunk` and `canopy` cast; `grass` does not.** The canopy is the whole reason `foliage.ts` has
 *   a `customDepthMaterial` at all — a treeline that does not break the moonlight is a treeline that
 *   is not there. Undergrowth is excluded because a 30 cm tuft's shadow is smaller than the shadow
 *   map's own 2 cm texel is soft, so it costs a draw call per chunk and returns a smudge.
 */
export const ARCHETYPE_CASTS: Readonly<Record<Archetype, boolean>> = {
  ground: false,
  edge: true,
  barrier: true,
  door: true,
  doorOpen: true,
  portal: false,
  glow: false,
  stair: true,
  prop: true,
  landmark: true,
  self: true,
  other: true,
  marker: false,
  trunk: true,
  canopy: true,
  grass: false,
  // The kit's default. Overridden per texture by {@link KIT_TEXTURE_CASTS}, because "is this worth a
  // draw in the shadow pass" is a question about a pebble and not about a role.
  kitSolid: true,
  kitLeaf: true,
  // **Water does not cast.** A shadow map is a depth buffer and a transparent surface writing into
  // one puts the lake's own shadow on the lake bed — a dark rectangle exactly the shape of the water.
  // A puddle is the same argument at 40 cm.
  water: false,
  puddle: false,
  // **A ceiling does not cast**, and the reason is the same one `ground` gives with the sign flipped:
  // when the room is *closed* the ceiling is its roof and the shadow it would throw is already thrown
  // by the walls under it; when the room is **open** — the player is inside — the slab is not drawn at
  // all, so a casting flag would only ever matter on the frame it is being culled. Excluding it also
  // keeps the shadow pass free of the one archetype every interior chunk has.
  ceiling: false,
  // The village default. Overridden per model by {@link VILLAGE_ROLE_CASTS}, because "is this worth a
  // draw in the shadow pass" is a question about a floor slab and not about a kit.
  villageSolid: true,
  // **A body with no shadow floats.** M5a's own note about the trees, and it is more true of a
  // character: a shadow under the feet is the single cheapest cue that a figure is standing on the
  // ground rather than hovering a hand's width above it, and at this camera pitch it is most of what
  // sells the contact. No per-primitive exception — the eyes cast too, inside the head, for nothing.
  character: true,
  // **Furniture casts, without exception.** No per-texture table beside this one, and the difference
  // from `kitSolid` is the point: the kit's exceptions exist because a 10 cm path stone and a 3 m
  // boulder share `rocks-diffuse`, so the texture is the only place the bulk is known. Nothing in the
  // drawn furniture set is under 12 cm and most of it is waist high or taller, so every piece is
  // worth its draw in the shadow pass — and a bookcase standing in a lamplit room with no shadow is
  // the most obviously wrong thing an interior can contain.
  propSolid: true,
};

/**
 * How much light a thing makes of its own — M4's *"emissive portal rings"*, as a table.
 *
 * The numbers are `emissiveIntensity`, and they are above one on purpose: the composer's buffers are
 * `HalfFloatType`, so a ring at 5.5 hands the bloom pass a value five and a half times display white
 * and gets a halo instead of a flat clipped disc. That is the entire mechanism behind the reference
 * image's glowing gate, and it only works because the grade happens *after* the bloom (see `post.ts`).
 *
 * The stairwell marker is at 0.9 — under the bloom threshold, by design. §6-M4 asks for *"the
 * horizontal rings the full emissive treatment"* and stairwells only a *"subtle glow marker"*, and the
 * cheapest way to keep those apart is a value that cannot reach the bloom even if the selection
 * mask fails.
 *
 * `marker` sits between the two at 1.1: brighter than the stairwell hint, because a destination the
 * player just chose should read more insistently than a passive "there is a way down here", but nowhere
 * near the portal's 5.5 — a walk-to ring is not a gate to somewhere else and must not compete with one
 * for the eye. Fixed rather than pulsed through this table: `marker.ts` breathes its *scale* instead,
 * carrying over `scene.ts:2756-2764`'s tween rather than reusing the portal's emissive swing, so it is
 * never added to `pool.ts`'s `pulse()` list and this number never changes at runtime.
 */
export const ARCHETYPE_EMISSIVE: Readonly<Partial<Record<Archetype, number>>> = {
  portal: 5.5,
  glow: 0.9,
  marker: 1.1,
};

/**
 * How far the portal's emissive swings, and how fast, in Hz.
 *
 * Time-based and therefore exempt from the determinism rule — and it has to stay exempt by being
 * *unread*: nothing samples the pulse, nothing derives a position from it, and the server never hears
 * of it. A ring that sat at a constant value would read as a texture rather than as a thing that is on.
 */
export const PORTAL_PULSE_DEPTH = 0.18;
export const PORTAL_PULSE_HZ = 0.28;

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A material's identity: archetype, the sector when the archetype is terrain, and whether this is
 * the faded twin.
 *
 * A string rather than a tuple because it is a `Map` key on the hot path of every chunk build, and
 * because a dump of the pool should be legible: `ground|forest`, `barrier|cave|dim`, `portal`.
 */
export type MaterialKey = string;

export function materialKey(archetype: Archetype, sector: Sector | undefined, faded: boolean): MaterialKey {
  const biome = BIOME_KEYED.has(archetype) ? `|${sector ?? SECTORS[0]}` : '';
  return `${archetype}${biome}${faded && !NEVER_FADED.has(archetype) ? '|dim' : ''}`;
}

/**
 * The material a baked tree's mesh is drawn with — M5a's second key shape.
 *
 * Separate from {@link materialKey} rather than a fourth parameter on it, because the two answer
 * different questions and a function that took both a sector and a variant would be a function where
 * three quarters of the argument space is meaningless. Same string discipline: `trunk|pine-tall`,
 * `canopy|fir-dense`.
 */
export function treeMaterialKey(archetype: (typeof VARIANT_ARCHETYPES)[number], variant: TreeVariant): MaterialKey {
  return `${archetype}|${variant}`;
}

/**
 * Every key {@link materialKey}, {@link treeMaterialKey} and {@link kitMaterialKey} can ever return.
 *
 * The kit's own 48 are appended rather than crossed with an archetype, because a kit material's
 * identity *is* its `(model, texture)` pair — the archetype is derived from the texture, not chosen
 * beside it.
 */
export const MATERIAL_KEYS: readonly MaterialKey[] = (() => {
  const keys: MaterialKey[] = [];
  for (const archetype of ARCHETYPES) {
    if (
      archetype === 'kitSolid' ||
      archetype === 'kitLeaf' ||
      archetype === 'villageSolid' ||
      archetype === 'character' ||
      archetype === 'propSolid'
    ) {
      continue;
    }
    if (VARIANT_KEYED.has(archetype)) {
      const variantArchetype = archetype as (typeof VARIANT_ARCHETYPES)[number];
      for (const variant of TREE_VARIANTS) {
        if (!treePartsOf(variant).includes(variantArchetype)) continue;
        keys.push(treeMaterialKey(variantArchetype, variant));
      }
      continue;
    }
    const sectors = BIOME_KEYED.has(archetype) ? SECTORS : ([undefined] as const);
    for (const sector of sectors) {
      keys.push(materialKey(archetype, sector, false));
      if (!NEVER_FADED.has(archetype)) keys.push(materialKey(archetype, sector, true));
    }
  }
  for (const part of KIT_PARTS) keys.push(kitMaterialKey(part.model, part.texture));
  // M6. Every village part twice: as it stands, and open. **Uniformly**, including the floor and the
  // roof that `interior.ts` will never ask to fade — a table with an exception in it is a table that
  // will be wrong in one row, which is the argument `ARCHETYPE_CASTS` makes about `receiveShadow`,
  // and six spare `MeshLambertMaterial`s are a few hundred bytes against that.
  for (const part of VILLAGE_PARTS) {
    keys.push(villageMaterialKey(part.model, part.texture));
    keys.push(villageMaterialKey(part.model, part.texture, true));
  }
  // M7b. Twelve, one per texture rather than one per primitive — see {@link CHARACTER_TEXTURES}.
  for (const texture of CHARACTER_TEXTURES) keys.push(characterMaterialKey(texture));
  // M9. Four, on the same reasoning one level along: a furniture material's whole identity is its
  // atlas. No open twin — `interior.ts`'s near-wall fade is a *wall* thing, and a barrel that went
  // translucent because the camera was outside the room would be a hole in the floor.
  for (const texture of PROPS_TEXTURES) keys.push(propsMaterialKey(texture));
  return keys;
})();

/**
 * Which material family a key belongs to — the thing that decides how many *programs* the pool costs.
 *
 * Seven at M5b, and the count is still the point. `plain` is M3/M4's `MeshLambertMaterial` with a
 * colour uniform; `blend` is the same Lambert under `blend.ts`'s two-layer patch; `foliage` is the
 * same Lambert under `foliage.ts`'s wind, bent normals, translucency and procedural alpha clip.
 *
 * M5b adds four, and **each is a genuinely different compiled program rather than a bookkeeping
 * split** — which is worth being exact about, because the M5a discipline "every difference within a
 * family is a uniform" is only worth keeping if the exceptions are real:
 *
 * - `kitSolid` — a Lambert with a **texture** and **vertex colours**. `USE_MAP` and
 *   `USE_COLOR_ALPHA` are `#define`s, not uniforms, so a mapped material cannot share a program with
 *   an unmapped one however much one wishes it could. The vertex colour is the kit's baked bark AO
 *   (measured: `CommonTree_1`'s bark runs 0.10..1.00) and is most of why a kit trunk reads as bark
 *   rather than as a brown tube.
 * - `kitLeaf` — the same texture and the whole of `foliage.ts`'s wind, but with the procedural needle
 *   mask switched off by a uniform: a kit leaf's silhouette is in its own alpha channel, and carving
 *   a needle spray out of it would cut holes in a painted leaf.
 * - `water` — depth fade, foam and a scrolling wave normal, transparent and depth-write-off.
 * - `puddle` — the wet-ground decal. Shares water's *ideas* and not its shader: no depth to fade, no
 *   land to foam against, and an opacity driven by how recently it rained.
 *
 * All 48 kit-prop materials plus 35 kit-tree parts still share two programs between them, and all 48
 * ground materials still share one. That is the property that matters.
 */
export const MATERIAL_FAMILIES = ['plain', 'blend', 'foliage', 'kitSolid', 'kitLeaf', 'water', 'puddle'] as const;

export type MaterialFamily = (typeof MATERIAL_FAMILIES)[number];

/**
 * The family a material belongs to.
 *
 * `variant` is only ever needed for `trunk`/`canopy`, and only because M5b's kit trees wear the same
 * two archetypes as M5a's baked ones while being drawn by a different program — a kit trunk has a
 * bark texture and an ez-tree trunk has a colour. Everything downstream of the pool still cannot tell
 * a kit tree from a baked one; only the pool, which has to compile them, can.
 */
export function materialFamily(archetype: Archetype, variant?: string): MaterialFamily {
  if (archetype === 'ground') return 'blend';
  // M6, and **the reason the second rendering mode costs no program**: a village module is a Lambert
  // with a texture and a vertex colour, drawn single-sided — which is `kitSolid`'s shape exactly, down
  // to the two `#define`s (`USE_MAP`, `USE_COLOR_ALPHA`) that are the only things three's cache key
  // would separate them by. So all 38 village materials join the 83 kit ones on one program. The
  // *near-wall fade* is `transparent` + `opacity`, both uniforms, so the open twin joins them too.
  if (archetype === 'villageSolid') return 'kitSolid';
  // M7b, and the same free ride for the same reason: a body, a garment and a sword are each a Lambert
  // with a base-colour map and a vertex colour, drawn single-sided. Twelve more materials, no eighth
  // program. What they do *not* take from `kitSolid` is the wetness patch — rain darkening a boulder
  // is right and rain darkening a person's face is a wet-look mask nobody asked for — so the pool
  // branches on the archetype once, where the material is built. See `ScenePool.buildMaterial`.
  if (archetype === 'character') return 'kitSolid';
  // M9, and the third free ride on the same recipe: a barrel is a Lambert with a base-colour map and
  // the pack's baked vertex colour, drawn single-sided. Four more materials, no tenth program — and
  // unlike `character` it *does* take the wetness patch, because a rain barrel standing in a doorway
  // is exactly the surface that should darken.
  if (archetype === 'propSolid') return 'kitSolid';
  if (archetype === 'kitSolid') return 'kitSolid';
  if (archetype === 'kitLeaf') return 'kitLeaf';
  if (archetype === 'water') return 'water';
  if (archetype === 'puddle') return 'puddle';
  const kit = variant !== undefined && TREE_SOURCE[variant as TreeVariant] === 'kit';
  if (archetype === 'trunk') return kit ? 'kitSolid' : 'plain';
  if (archetype === 'canopy') return kit ? 'kitLeaf' : 'foliage';
  if (archetype === 'grass') return 'foliage';
  return 'plain';
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Grey-box biome colours: the ground you stand on, and the thing that walls it in.
 *
 * Flat, unlit, deliberately drab. M4 is the milestone that decides whether the *light* matches the
 * reference, and a palette tuned now would be tuned against no lighting at all and thrown away.
 * What these have to do is one job: make it obvious at a glance which sector a room resolved to,
 * because M1 changed 9.5% of the world's sectors and this is the first time anyone can look at the
 * result.
 */
const SECTOR_COLOUR: Readonly<Record<Sector, { readonly ground: number; readonly dressing: number }>> = {
  inside: { ground: 0x6b6055, dressing: 0x8a7b66 },
  city: { ground: 0x7a7570, dressing: 0x9a9088 },
  road: { ground: 0x8a7a5c, dressing: 0x6d6248 },
  field: { ground: 0x6f8a4a, dressing: 0x54683a },
  forest: { ground: 0x3f6437, dressing: 0x25401f },
  hills: { ground: 0x7d8a53, dressing: 0x5c6640 },
  mountain: { ground: 0x8b8578, dressing: 0x615c53 },
  swamp: { ground: 0x4d5a3a, dressing: 0x36402a },
  desert: { ground: 0xc2ab74, dressing: 0x9a875a },
  arctic: { ground: 0xd6dee4, dressing: 0xa8b4bd },
  cave: { ground: 0x4a4640, dressing: 0x322f2b },
  shallow_water: { ground: 0x4f7f96, dressing: 0x3b6070 },
  deep_water: { ground: 0x2e5470, dressing: 0x224054 },
  underwater: { ground: 0x27485c, dressing: 0x1b3444 },
  air: { ground: 0x8fb8d8, dressing: 0x6f92ac },
  astral: { ground: 0x7a63a8, dressing: 0x584878 },
};

/** Dressing colours for the archetypes that are objects rather than terrain. */
const OBJECT_COLOUR: Readonly<Record<Archetype, number>> = {
  ground: 0x000000,
  edge: 0x000000,
  barrier: 0x000000,
  door: 0xd0a070,
  doorOpen: 0x9a7048,
  // The reference image's ring. The *diffuse* is near-black on purpose — a portal is a thing that
  // emits, not a thing that is lit, and a bright albedo under it would put moonlight on the tube and
  // flatten the glow. All of its colour is in `ARCHETYPE_EMISSIVE`.
  portal: 0x0a1416,
  glow: 0x0d1614,
  stair: 0xdad2bc,
  prop: 0x8a7f6a,
  landmark: 0xc9b483,
  // Self and others are told apart by colour and by nothing else at M3 — no nameplates until M7.
  self: 0x5fd0ff,
  other: 0xff9a5c,
  // Near-black, the same reasoning as `portal`/`glow` above: a destination ring emits, it is not lit.
  marker: 0x1a1710,
  // The three scatter archetypes never reach here: `trunk` and `canopy` take their variant's own bark
  // and needle from the registry (see `trees.ts`), and `grass` is biome-keyed below. The entries exist
  // because the record is total, and they are the colour a tree would be if nothing ever registered
  // one — which is a case the scatter refuses to draw at all, so they are never seen. Kept in step
  // with the palette anyway: soft, saturated and flat, the register the Quaternius Stylized Nature
  // kit sets and the one the owner has chosen for the world.
  trunk: 0x6b4f3a,
  canopy: 0x3f7f52,
  grass: 0x000000,
  // **White on purpose.** A kit material's colour is its texture; `diffuse` multiplies the map, so
  // anything but white would tint the whole Quaternius palette by a number nobody chose. The fog-of-war
  // tint row is a *ratio* off this base (see `ScenePool.recolour`), and a ratio off white is the
  // identity — which is exactly what an unexplored kit prop wants: the same silhouette, darker.
  kitSolid: 0xffffff,
  kitLeaf: 0xffffff,
  // The shallow end. `water.ts` mixes toward {@link WATER_DEEP_COLOUR} by depth, per instance.
  water: 0x4c7f8c,
  // A puddle is a hole in the ground full of sky. Near-black diffuse, and all of its read is in the
  // specular the wet patch adds — the same argument `portal` makes for its own near-black albedo.
  puddle: 0x14181c,
  // Biome-keyed below; the entry exists because the record is total.
  ceiling: 0x000000,
  // White, `kitSolid`'s reasoning verbatim: a village material's colour is its texture, and `diffuse`
  // multiplies the map, so anything but white would tint the whole Quaternius palette by a number
  // nobody chose.
  villageSolid: 0xffffff,
  // White, so the pack’s own texture is what you see — the same statement the village makes. A
  // tint here would put a wash over every face in the world.
  character: 0xffffff,
  // White, for the third time and the same reason. Never actually read — `archetypeColour` answers
  // before it reaches here — and present so the record stays total.
  propSolid: 0xffffff,
};

/** What the deep end of a water surface mixes toward. See `water.ts`'s depth fade. */
export const WATER_DEEP_COLOUR = 0x17323f;

/** The foam line's colour where water meets land. Not pure white: foam under a moon is grey-green. */
export const WATER_FOAM_COLOUR = 0xd8e6e2;

/**
 * What the emissive archetypes actually shine, as distinct from what they reflect.
 *
 * The reference's gate is a saturated cyan and the stairwell marker a colder, quieter teal, so that
 * one reads as "somewhere else" and the other as "another floor" without a legend. The destination
 * marker takes a third, warm hue for the same reason: `0xffe9a8` is `scene.ts:822`'s `PATH_COLOUR`,
 * unchanged — the one piece of the 2D route's look this port keeps, so a player who has used both
 * clients reads "that is where I am walking" in the same colour on either one.
 */
export const EMISSIVE_COLOUR: Readonly<Partial<Record<Archetype, number>>> = {
  portal: 0x64e2ff,
  glow: 0x74d9c0,
  marker: 0xffe9a8,
};

/**
 * The colour a material key paints. A pure function of the key's parts.
 *
 * `variant` is M5b's and only ever matters for `trunk`/`canopy`: a kit tree's colour is its texture,
 * and a `diffuse` of anything but white would tint the Quaternius palette by a number nobody chose.
 * The fog-of-war tint row is a *ratio* computed off this value (see `ScenePool.recolour`), so getting
 * it wrong would also leave an unexplored kit trunk the wrong kind of dark.
 */
export function archetypeColour(archetype: Archetype, sector: Sector | undefined, variant?: string): number {
  if (archetype === 'villageSolid' || archetype === 'propSolid') return 0xffffff;
  if (variant !== undefined && TREE_SOURCE[variant as TreeVariant] === 'kit') return 0xffffff;
  if (archetype === 'ground') return SECTOR_COLOUR[sector ?? 'field'].ground;
  // A lid, and the sector says what it is made of. Darker than the wall that holds it up because the
  // only face of it this camera ever sees is the *top* — see `interior.ts` — and a roof lit by the
  // same sky as the wall beneath it at the same value is a building with no silhouette.
  if (archetype === 'ceiling') return darken(SECTOR_COLOUR[sector ?? 'inside'].dressing, 0.82);
  if (archetype === 'edge') return SECTOR_COLOUR[sector ?? 'field'].dressing;
  // A barrier is the same material as an edge, darkened — thickness is what says "you cannot pass",
  // and a second hue would say something the classification does not mean.
  if (archetype === 'barrier') return darken(SECTOR_COLOUR[sector ?? 'field'].dressing, 0.7);
  // Undergrowth is the ground it grows out of, one step darker and one step greener: a tuft that
  // matched its ground exactly would be invisible, and one with its own hue would read as litter.
  if (archetype === 'grass') return darken(SECTOR_COLOUR[sector ?? 'field'].ground, 0.78);
  return OBJECT_COLOUR[archetype];
}

/** The ground colour of a sector, for the far side of a {@link blend} boundary. */
export function sectorGround(sector: Sector): number {
  return SECTOR_COLOUR[sector].ground;
}

/* -------------------------------------------------------------------------- */
/* Ground textures — 2026-08-13                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a sector's floor is *made of*, where "a flat colour" was no longer enough.
 *
 * > *"I wonder why the entire room isn't cobblestones"* — the owner, in a walled city room.
 *
 * The honest answer to that question was that the floor had never been anything but a painted box:
 * `SECTOR_COLOUR.city.ground` is `0x7a7570` and the cobbles in the screenshot were a handful of
 * `RockPath_*` **meshes** that `scatter.ts`'s `edging` layer drops along the kerb. M5b textured the
 * props and M6 textured the village panels; the ground is the last grey box in the renderer.
 *
 * ## Four rules this table has to obey, and how each is kept
 *
 * 1. **It must not cost a program.** `USE_MAP` is a `#define`, so a ground material with
 *    `material.map` set and one without are two compiled programs and the `blend` family would split
 *    in half. So the map is **not** `material.map` at all: it is a sampler the `blend.ts` patch
 *    declares, which makes the GLSL of all 48 ground materials byte-identical whatever each one is
 *    pointed at. A sampler is a uniform; a define is not. See `pool.programKeys`.
 * 2. **It must not disturb the palette, because the fog of war is derived from it.**
 *    `ScenePool.recolour` builds each material's unexplored/remembered tint row as a *ratio* off
 *    `archetypeColour`, so a floor that came out of the texture at the texture's own brightness would
 *    desaturate to the wrong grey. The shader therefore divides the sample by {@link
 *    GroundTexture.mean} — the texture's own average, in the **linear** space three mixes in — so an
 *    average texel multiplies the sector colour by exactly one and the palette is untouched. What the
 *    texture contributes is its *variation*: mortar lines darker, stone faces lighter and a little
 *    warmer, on top of the colour M3 chose.
 * 3. **It must be tileable, and it is sampled in world space.** `blend.ts` already carries the warped
 *    world position to the fragment shader (`vBlendWorld`), so the map is sampled there rather than
 *    off the geometry's own `uv`. Three consequences, all wanted: the stones run continuously across
 *    the room, across the gap and into the next room with no seam anywhere; the pattern bends with
 *    M5c's warp instead of sliding over it; and one shared pooled `groundBox` can serve a slab and a
 *    lid without its `uv` meaning two different scales. Nothing calls `fract`, so the derivatives stay
 *    continuous and the mip chain works.
 * 4. **The stones have to be stone-sized.** {@link GroundTexture.metres} is how far one repeat of the
 *    texture reaches, which is the only honest way to state it — "a repeat every 3 m" says what a
 *    player will measure, where "0.333 repeats per metre" says what the shader multiplies by.
 *
 * ## What was measured, and what was rejected
 *
 * Every candidate on disk was decoded headlessly and checked for tiling (mean absolute difference
 * between opposite borders against the difference between adjacent interior rows — a tileable image
 * scores about the same on both):
 *
 * | texture | 2048² unless noted | seam vs interior | verdict |
 * | --- | --- | --- | --- |
 * | `uneven-brick` | village | 1.3 / 2.3 vs 1.5 | **tiles.** Irregular flagstones in mortar — literally cobblestone |
 * | `brick` | village | 5.6 / 5.4 vs 0.8 | tiles well enough. A regular course; a laid floor |
 * | `plaster` | village | 0.5 / 0.8 vs 0.5 | **tiles.** Soft neutral mottle; dirt, once the hue is normalised out |
 * | `path-rocks-diffuse` | nature, 1024² | 13.7 / 18.2 vs 0.2 | **rejected** — a UV *atlas*: stone islands on green. Tiling it would put grass between the cobbles |
 * | `wood-trim` | village | 100.1 / 5.1 vs 0.8 | **rejected** — an atlas of three unrelated bands |
 * | `rock-trim` | village | 0.1 / 10.5 vs 0.3 | rejected — tiles horizontally only |
 * | `rocks-diffuse` | nature | 28.2 / 28.5 vs 0.4 | rejected — an atlas, same failure as the path rocks |
 *
 * The brief nominated `path-rocks-diffuse` and it is the one that cannot work, which is worth
 * recording: it is the texture the *cobbles in the screenshot* wear, but they wear it through their
 * own UVs and the green around them is what the island borders are made of.
 *
 * ## What is deliberately **not** here
 *
 * Every natural sector. `field`, `forest`, `hills`, `swamp`, `mountain`, `desert`, `arctic` and the
 * three water sectors keep M3's colour under M5a's blend, because the owner asked about cobblestone
 * and because a grass texture is the one thing a two-layer biome blend most wants to be free of — a
 * detail map with a fixed repeat over a boundary the blend is deliberately breaking up would put a
 * visible grid across the one transition this renderer has spent a milestone hiding. `cave` is left
 * alone too: it is roofed rock and none of the three tileable candidates is rock.
 */
export interface GroundTexture {
  /** A manifest texture id — `pool.texture(id)`. All three are the village pack's, already fetched. */
  readonly texture: VillageTextureId;
  /** Metres one repeat of the texture spans. See rule 4. */
  readonly metres: number;
  /** 0 leaves the floor exactly as M3 painted it; 1 is the full normalised multiply. */
  readonly gain: number;
  /**
   * The texture's mean colour in **linear** space, measured over every texel.
   *
   * Decoded from the PNG on 2026-08-13 with the sRGB curve `srgbToLinear` states, averaged per
   * channel. It is what makes rule 2 true, and it is a property of the file rather than a taste
   * setting: a re-import that changed the image would want this re-measured, which is why the
   * measurement is written down beside the number.
   */
  readonly mean: readonly [number, number, number];
}

export const GROUND_TEXTURES: Readonly<Partial<Record<Sector, GroundTexture>>> = {
  // The owner's cobblestone. ~6.5 stones across a 2048² tile, so a 3 m repeat puts a stone at ~0.46 m
  // — the size of the kit's own `RockPath_*` meshes, which is the yardstick a street already has
  // lying on it. 3 m is also `VILLAGE_CHORD`, so a paved street and a village brick floor beat
  // together; it does *not* align with the 11 m room pitch, so no room grid appears in the paving.
  city: { texture: 'uneven-brick', metres: 3, gain: 0.85, mean: [0.2471, 0.1951, 0.1395] },
  // A dirt road is not one colour and never was. `plaster` is a soft neutral mottle at this scale and
  // nothing else — its own hue is divided out — so what it adds is patchiness, at a 7 m period that
  // reads as ground rather than as a material. Low gain on purpose: a road with a *pattern* is paved.
  road: { texture: 'plaster', metres: 7, gain: 0.4, mean: [0.4269, 0.3423, 0.2125] },
  // A laid floor. ~7 courses a tile, so a 2.5 m repeat puts a brick at ~0.36 m. Mostly seen where the
  // village kit has *not* dressed a room — an interior whose modules have not loaded, and the metre
  // of floor that now runs out under the walls into the gap — because a dressed room lays its own
  // `Floor_*` modules on top. That is the right place for it to be: the undressed case was the one
  // still showing a flat brown box.
  inside: { texture: 'brick', metres: 2.5, gain: 0.8, mean: [0.2931, 0.2390, 0.1811] },
};

/** The floor texture a sector's ground wears, or nothing — see {@link GROUND_TEXTURES}. */
export function groundTextureOf(sector: Sector | undefined): GroundTexture | undefined {
  return sector === undefined ? undefined : GROUND_TEXTURES[sector];
}

/* -------------------------------------------------------------------------- */
/* Wall textures — M9                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What the thing that walls a room in is *made of* — **the owner's actual complaint, and the last
 * grey box in the renderer.**
 *
 * The screenshots were bodies standing beside grey blocks in a kobold field room and in a city
 * street. Those blocks are `chunkPlan.ts`'s `edge` and `barrier` archetypes, and M6 textured only
 * *interior* walls: a room that is roofed and `inside` gets village panels and its grey boxes are
 * suppressed, and every other room in the world — 3,544 city edges among them — still wears M3's
 * flat `SECTOR_COLOUR.dressing`.
 *
 * ## Why a texture and not a village module
 *
 * A module was the obvious answer and it is the wrong one, on four counts, and the first is the one
 * that decides it:
 *
 * 1. **It would break the exclusivity `pool.DRESSED_WRAPPER_CEILING` is a `max` over.** That `max` is
 *    only a `max` because no chunk can want the understory *and* the interior dressing: a room is
 *    dressed by `interior.ts` only when it is roofed and `inside`, and no scatter table has an
 *    `inside` row. Putting village walls on **outdoor** rooms puts them on exactly the chunks that
 *    also grow scatter, so `max(16, 11)` would become `16 + 7` and the pool would grow by seven
 *    wrappers on each of 293 cells — `+8,138,368 B` on a pinned ledger. A texture costs **zero**
 *    wrappers, zero placements and zero programs, because it changes what an existing box *looks*
 *    like rather than what is drawn.
 * 2. **It reaches every grey wall at once.** 77,341 of the world's cardinal boundaries are solid; the
 *    village pack is masonry and only some of those are masonry. The kobold field room's block is a
 *    bank of earth, and a plaster panel would be a worse answer there than the grey it replaced.
 * 3. **The geometry is already right and a module's is not.** `chunkPlan.wallDepth` makes the box at
 *    least half the gap deep so two rooms' walls meet on the midline — *"what you see is a wall and
 *    not a gap at all"*. A village panel is 0.61 m against a 1 m gap and reopens the 0.39 m footing
 *    the `dressed` flag's docblock already names as its cost. Indoors a roof hides that; outdoors
 *    nothing does.
 * 4. **It costs nothing on the wire.** Both textures are the village pack's own and both are already
 *    fetched for the interiors, exactly as the three floor textures were.
 *
 * What a texture cannot do, stated so it is not mistaken for an oversight: **a window, a door frame
 * or a quoin.** Those are geometry and they want a module. A city wall with real openings in it is
 * the follow-up, and it should be priced against the ledger row above before it is built.
 *
 * ## The two pictures, and the four rules {@link GROUND_TEXTURES} set
 *
 * The same four, and each is kept the same way — see that table for the full argument. The map is a
 * `sampler2D` a patch declares rather than `material.map`, so `USE_MAP` is never set and all 74 plain
 * materials still compile one program (rule 1). It is divided by its own linear mean, so an average
 * texel multiplies the palette by exactly one and the fog-of-war ratio rows are untouched (rule 2).
 * It is sampled in **world space on the dominant axis of the face's own normal**, so a wall's courses
 * run horizontally, two rooms' walls meet with no seam, and the top of a wall gets the plan view
 * rather than a stretched elevation (rule 3, one sample and two `step`s rather than a three-tap
 * triplanar). And the repeat is stated in metres (rule 4).
 *
 * `uneven-brick` is the city's own paving at the city's own 3 m repeat, so a street and the wall
 * beside it are cut from one stone — which is what a town looks like and is free, because
 * `GROUND_TEXTURES.city` already fetched it. `plaster` is a soft neutral mottle whose hue is divided
 * out, which is what a bank of earth or a rock face looks like at a low gain; it is the same picture
 * a dirt road already wears, at a coarser repeat because a wall is seen from further away.
 *
 * **`cave` is deliberately absent and so are the four water sectors.** A cave's rock walls are
 * `chunkPlan`'s shell at the sector's own colour and that is M6's ruling — *plaster in a cavern would
 * be worse than grey* — and a wall that a lake laps against is a surface nobody has looked at yet.
 */
export interface WallTexture {
  /** A manifest texture id. Both are the village pack's and both are already fetched. */
  readonly texture: VillageTextureId;
  /** Metres one repeat spans, along the wall and up it. See {@link GroundTexture.metres}. */
  readonly metres: number;
  /** 0 leaves the wall exactly as M3 painted it; 1 is the full normalised multiply. */
  readonly gain: number;
  /** The texture's mean colour in **linear** space. {@link GROUND_TEXTURES}' own measurement, reused. */
  readonly mean: readonly [number, number, number];
}

const MASONRY: WallTexture = {
  texture: 'uneven-brick',
  metres: 3,
  gain: 0.8,
  mean: [0.2471, 0.1951, 0.1395],
};

/**
 * A bank of earth and stone rather than a course of masonry — the same soft mottle a dirt road's
 * ground wears, at a 5 m repeat because a wall stands further from the eye than the floor does, and
 * at a lower gain because what it has to add is *unevenness* and not a pattern. A boundary with a
 * pattern in it is a built thing, and the whole point of this row is that a field's edge is not.
 */
const EARTH: WallTexture = {
  texture: 'plaster',
  metres: 5,
  gain: 0.45,
  mean: [0.4269, 0.3423, 0.2125],
};

export const WALL_TEXTURES: Readonly<Partial<Record<Sector, WallTexture>>> = {
  city: MASONRY,
  // An `inside` room whose village modules have not loaded, and — more often — the *barrier* walls of
  // one that has: `chunkPlan`'s `dressed` suppression is per room, so an undressed neighbour still
  // draws its own grey side of a party wall.
  inside: MASONRY,
  road: EARTH,
  field: EARTH,
  forest: EARTH,
  hills: EARTH,
  mountain: EARTH,
  swamp: EARTH,
  desert: EARTH,
  arctic: EARTH,
};

/**
 * The wall texture an `edge` or a `barrier` wears in this sector, or nothing.
 *
 * Takes the archetype as well as the sector because the table is about **walls** and the `plain`
 * material family is not: a door, a stair, a landmark, a destination ring and a body all come out of
 * it too, and every one of them would be wrong with masonry multiplied over it. Every other plain
 * archetype answers `undefined`, which is a gain of zero, which is a multiply by one.
 */
export function wallTextureOf(archetype: Archetype, sector: Sector | undefined): WallTexture | undefined {
  if (archetype !== 'edge' && archetype !== 'barrier') return undefined;
  return sector === undefined ? undefined : WALL_TEXTURES[sector];
}

function darken(colour: number, factor: number): number {
  const r = Math.round(((colour >> 16) & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * sRGB hex to the linear working space three's shaders actually mix in.
 *
 * Here rather than in `blend.ts` because `chunkPlan.ts` needs it and `chunkPlan.ts` is deliberately
 * *"not a `three` import in sight"* — the ground's per-instance layer-B colour is computed on the
 * pure side and handed to the shader as three floats, and a colour handed over in sRGB would be
 * mixed against a linear `diffuseColor` and come out visibly too bright at the seam. This is
 * `Color.SRGBToLinear`'s own curve, restated: the same numbers three would produce, from a file that
 * cannot import it.
 */
export function srgbToLinear(channel: number): number {
  return channel < 0.04045 ? channel * 0.0773993808 : Math.pow(channel * 0.9478672986 + 0.0521327014, 2.4);
}

/** `0xRRGGBB` to linear `[r, g, b]`, each in `[0, 1]`. See {@link srgbToLinear}. */
export function linearRgb(hex: number): readonly [number, number, number] {
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}

/**
 * How much of a faded thing is left.
 *
 * **M4 took one of this twin's two jobs away and left it the other.** At M3 it meant both "the level
 * below" and "ground you have never seen", because there was no third state to give the second one.
 * There is now: fog of war is `instanceColor` (`fogOfWar.ts`) and an unexplored room is drawn *opaque
 * and near-black* — a silhouette, which is what unexplored ground should be — while transparency is
 * reserved for the one statement it is actually right for.
 *
 * That statement is the plan's *"the camera renders the player's level plus one below (faded, for the
 * cliff/shaft read)"*. A level below has to be see-*through*, not merely dark, or a shaft reads as a
 * floor with a stain on it. The two meanings are now in two registers because they were always two
 * meanings.
 */
export const FADE_OPACITY = 0.3;

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Metres, and every one of them a decision the geometry can be read back from.
 *
 * The only load-bearing pair is `edgeThickness` against `barrierThickness`. The plan calls a barrier
 * a *correctness requirement, not aesthetics* — "must be visually solid and thicker than an `edge`,
 * because the player can otherwise see into a room they cannot reach" — so the two numbers differ by
 * more than a rendering tolerance and `chunkPlan.test.ts` asserts the inequality rather than the
 * values.
 */
export const DIMENSIONS = {
  /** How deep the ground slab is. Thick enough to have a visible side where a level drops away. */
  groundThickness: 0.2,
  edgeThickness: 0.6,
  edgeHeight: 3,
  barrierThickness: 1.4,
  barrierHeight: 3.6,
  doorThickness: 0.35,
  doorHeight: 2.6,
  /** Ring radius and tube radius, before the per-instance scale. */
  portalRadius: 1.5,
  portalTube: 0.2,
  /**
   * The stairwell marker: a ring laid flat on the floor around the flight's mouth.
   *
   * Wide enough to enclose the {@link chunkPlan} stair block's three-metre span and low enough that a
   * character walks over it rather than into it. Its whole job is to be the thing you notice when a
   * room has a way down in it, from across the room, at a 64 degree camera.
   */
  glowRadius: 1.7,
  glowLift: 0.08,
  /** How many boxes a flight of stairs is cut into. A ramp is one. */
  stairSteps: 4,
  stairThickness: 0.35,
  propHeight: 1.2,
  landmarkHeight: 2.2,
  /** A body: `PLAYER_RADIUS` is 10 px = 0.31 m, so the capsule is drawn at the collision box's width. */
  bodyRadius: 0.32,
  bodyHeight: 1.8,
  /** An undergrowth tuft, in metres. Knee height: enough to catch the moon, not enough to hide a body. */
  grassWidth: 0.55,
  grassHeight: 0.42,
  /**
   * Head height in a roofed room, in metres — **and it is `edgeHeight`, which is not a coincidence.**
   *
   * The village kit's wall module is 3.1227 m to the top of its eave lip and `Corner_Exterior_Wood`
   * is exactly 3.000 m to the wall plate, so the kit's own storey height is three metres and M3's
   * grey wall was already standing at it. The ceiling's underside therefore lands on the number both
   * halves already agreed on, the 12 cm lip is swallowed inside the slab, and no wall anywhere in
   * the world had to change height to grow a roof.
   */
  ceilingHeight: 3,
  /** How thick the lid is. Seen only from above, so this is its silhouette rather than its edge. */
  ceilingThickness: 0.2,
} as const;

/**
 * How much of a wall is left when the camera is behind it — **the near-wall fade.**
 *
 * Not {@link FADE_OPACITY}. That number means "a storey down" and is tuned so a shaft reads as a
 * shaft; this one means "you are standing behind this wall" and is tuned so the wall still draws a
 * line the eye can follow round the room while the floor and the bodies inside are legible through
 * it. Higher than the vertical fade on purpose: at 0.3 a plaster wall against a dark interior floor
 * simply disappears and the room loses its shape, which is the failure the fade exists to avoid in
 * the first place.
 */
export const WALL_OPEN_OPACITY = 0.42;

/* -------------------------------------------------------------------------- */
/* Scatter — the numbers the wrapper ceiling is derived from                   */
/* -------------------------------------------------------------------------- */

/**
 * How many tree species one room may grow. **This is a pool constant before it is an art one.**
 *
 * Every distinct `(geometry, material)` pair a chunk produces is a bucket, and a bucket is at least
 * one `InstancedMesh` out of the free list. Letting a room roll freely over all eight variants would
 * make a chunk's bucket count a property of a hash rather than of the program, and `pool.ts`'s
 * ceiling would stop being a bound. Three is the smallest number at which a treeline does not read as
 * a hedge of clones — the plan's risk 4, *"don't be surprised when the first forest looks like every
 * other forest"* — and it costs `3 x 2 = 6` buckets a chunk.
 */
export const TREE_VARIANTS_PER_ROOM = 3;

/**
 * The hard cap on trees in one room, boundary and interior together.
 *
 * Exactly {@link pool.WRAPPER_CAPACITY}, and that is not a coincidence: it is the largest number for
 * which *"every tree in this room landed on the same variant"* still fits in one wrapper, so the
 * per-chunk wrapper count is `TREE_VARIANTS_PER_ROOM x TREE_PARTS.length` whatever the hash does.
 * `scatter.ts` truncates rather than spilling, and `scatter.test.ts` asserts the cap holds over the
 * whole built world.
 */
export const TREES_PER_ROOM_MAX = 32;

/** The same argument for undergrowth: one bucket, one wrapper, whatever the room. */
export const GRASS_PER_ROOM_MAX = 32;

/* ------------------------------------------------------------------ M5b: the kit */

/**
 * How many distinct kit **models** one room may dress itself with. A pool constant before it is an
 * art one, exactly as {@link TREE_VARIANTS_PER_ROOM} is.
 *
 * Four, and it costs `4 x 2 = 8` buckets a chunk in the worst case (the five two-primitive models —
 * the flowering bush and the four flower clusters — are the only ones that take two). Letting a room
 * roll freely over all 43 would make a chunk's bucket count a property of a hash and `pool.ts`'s
 * ceiling would stop being a bound. Four is enough for a forest floor to read as *"ferns, clover,
 * mushrooms and a bush"* rather than as one plant repeated, which is risk 4 again at the scale of the
 * understory.
 */
export const KIT_MODELS_PER_ROOM = 4;

/** Primitives a kit model can have. Two: a leaf part and a flower part, or bark and leaves. */
export const KIT_PARTS_MAX = 2;

/** The hard cap on kit instances in one room. One bucket, one wrapper, whatever the hash rolls. */
export const KIT_PER_ROOM_MAX = 32;
