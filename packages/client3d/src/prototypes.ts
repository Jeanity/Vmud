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
 */
export const SHAPE_KEYS = ['box', 'cone', 'torus', 'capsule', 'grassCross', 'waterPlane'] as const;

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
export const BIOME_ARCHETYPES = ['ground', 'edge', 'barrier', 'grass'] as const satisfies readonly Archetype[];

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
  ground: 'box',
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
    if (archetype === 'kitSolid' || archetype === 'kitLeaf') continue;
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
  if (variant !== undefined && TREE_SOURCE[variant as TreeVariant] === 'kit') return 0xffffff;
  if (archetype === 'ground') return SECTOR_COLOUR[sector ?? 'field'].ground;
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
} as const;

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
