/**
 * `modelgen` — the Quaternius kit import. M5b's first line and the offline half of *"build my game in
 * a world that looks like that"*; M6's second source dir, and the offline half of the interiors;
 * M7b's third, and the offline half of the *people*.
 *
 * ```
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --dry
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --source D:/MyGame/assets/quaternius/nature
 * GAME_NATURE_KIT=D:/MyGame/assets/quaternius/nature node ... /modelgen.ts
 *
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --village
 * GAME_VILLAGE_KIT=D:/MyGame/assets/quaternius/village node ... /modelgen.ts --village
 *
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --characters
 * GAME_CHARACTER_KIT=D:/MyGame/assets/quaternius/characters node ... /modelgen.ts --characters
 *
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --props
 * GAME_PROPS_KIT=D:/MyGame/assets/quaternius/props node ... /modelgen.ts --props
 * ```
 *
 * **Invoked with `node` directly and deliberately given no `package.json` script**, exactly as
 * `treegen.ts` is and for the same reason: `CLAUDE.md` gotcha 6 — npm eats unknown flags, and
 * `--source …` through a nested `npm run --workspace` never reaches this file.
 *
 * ## Three kits, one importer — M6, then M7b
 *
 * The *Medieval Village MegaKit* arrives the same way the nature kit did and is imported by the same
 * code, parameterised by a {@link KitProfile}: where the source is, where the output goes, how a
 * texture file becomes an id, and which prefix names a family. Everything else — the normal-map drop,
 * the image reindex, the URI rewrite, the sorted manifest, the byte-identical re-run — is shared,
 * because those are properties of *the importer* rather than of either kit, and a second copy of them
 * would be a second place for the determinism to rot.
 *
 * The nature profile's emitted bytes are unchanged by the parameterisation, which
 * `modelgen.test.ts` asserts by re-running the same catalogue build it always has.
 *
 * **The characters profile is the third tenant and it stretched the importer in exactly two places**,
 * both of which are no-ops for the first two:
 *
 * 1. **`skins` survives the rewrite.** A base body and every outfit part is a *skinned* mesh: its
 *    nodes carry `skin: 0` and the skin names 65 joints and an inverse-bind-matrix accessor. The
 *    rewrite used to drop the array outright — harmless while no kit had one, fatal the moment one
 *    does, because a node pointing at a `skins` array that is not there is a `GLTFLoader` throw
 *    rather than an untextured mesh. Emitted only when the source has one, so the nature and village
 *    bytes are unchanged to the byte.
 * 2. **Three optional manifest fields**, {@link KitModel.kind}, {@link KitModel.stem} and
 *    {@link KitModel.joints}, written only when a profile declares a {@link KitProfile.kind}. The
 *    *stem* is the load-bearing one: `shared/src/appearance.ts` emits ids like
 *    `base:Superhero_Male_FullBody` and `outfit:Male_Ranger_Feet_Boots`, which are the **vendor's own
 *    file identities**, asymmetries and all (his ranger boots are `Feet_Boots` where hers are `Feet`).
 *    Recording the stem beside the kebab-case id means the renderer joins on what the server actually
 *    said instead of re-deriving a name that is wrong for two of twenty.
 *
 * ## The animation libraries, and the 86% of them that is thrown away
 *
 * *Universal Animation Library* 1 and 2 ship as GLBs of 7.27 MB and 7.72 MB — 43 clips each, of which
 * M7b's state machine names eleven and five. Measured: **15.0 MB in, 2.17 MB out, a 78% and a 92%
 * cut.** {@link buildAnimationLibrary} keeps the named clips and rebuilds the file around them: the mannequin mesh, its skin, its materials and every accessor no kept clip
 * references all go, the surviving buffer views are re-packed into a fresh `BIN` chunk in ascending
 * source order, and the JSON chunk is rebuilt in a fixed key order. Same input, same bytes.
 *
 * That is the same *subtractive and reversible* rule the normal-map drop follows, applied to the one
 * asset in this project where the unused fraction is the majority: a walk cycle nobody plays still
 * costs the player the download. The clip list lives here because this is what does the cutting;
 * `client3d/src/anim.ts` mirrors it and `characters.test.ts` asserts the two agree against the
 * generated manifest, which is `kit.test.ts`'s contract for `treeTexture` in a second costume.
 *
 * ## Where a kit is, and why that is a flag
 *
 * `assets/**` is git-ignored, so **a worktree has no `assets/` directory at all**. That is the same
 * hole `artgen.ts`/`creaturegen.ts` fell into with the LPC pack and it is answered the same way:
 * the source is `--source`, else the profile's environment variable (`$GAME_NATURE_KIT` /
 * `$GAME_VILLAGE_KIT` / `$GAME_CHARACTER_KIT`), else the repo's own `assets/quaternius/<kit>`. From a
 * worktree, point it at the main checkout — `--source D:/MyGame/assets/quaternius/nature`.
 *
 * The characters source is **assembled rather than downloaded**: three itch packs are unpacked into
 * one `characters/glTF` (the two base bodies, six hairstyles from the base pack's own
 * `Hairstyles/Rigged to Head Bone/` line, the twenty modular parts, four props) with the two
 * animation GLBs in a sibling `characters/animations`. That is a hand step, it is recorded in
 * `assets/quaternius/PROVENANCE.md`, and it is why this profile's `pack` line names four packs.
 *
 * The village pack ships its glTF one directory deeper than the nature pack does — the itch download
 * unpacks as `village/Medieval Village MegaKit[Standard]/glTF` — so {@link gltfDirOf} accepts either
 * the directory holding `glTF` or its parent. That is a convenience with a hard edge: it descends
 * **only** when exactly one child holds a `glTF`, so a source directory with two packs in it is an
 * error rather than a coin toss.
 *
 * ## Copy-and-manifest, and the compression that is deliberately *not* here
 *
 * §5's delivery rule names `@gltf-transform/cli` for Draco + KTX2 + meshopt. **That is a follow-up
 * slice and this file does not do it**, on the brief's explicit instruction: the first "world in
 * clothes" moment must not wait on a compression toolchain, and adding a dependency is not M5b's to
 * spend. So the `.bin` files are copied byte for byte and the textures are copied as PNG.
 *
 * What this step *does* do to the glTF is subtractive and reversible:
 *
 * 1. **Normal maps are dropped.** Three of them, 15.5 MB — more than half the kit's texture weight,
 *    and the two 5.7 MB bark maps alone are a third of it. Nothing in `client3d` samples a normal
 *    map: every material in that renderer is a `MeshLambertMaterial` (see `pool.ts`), which the M5a
 *    report justified at length and which M5b keeps. Shipping 15.5 MB of picture that is never read
 *    is exactly the trade `treegen.ts` refused when it threw EZ-Tree's textures away. **When the
 *    compression slice lands these are the first candidates to come back, as KTX2.**
 * 2. **`images`/`textures` are rebuilt** to only the base-colour images that survive (1), and
 *    reindexed. A dangling image reference would make `GLTFLoader` fetch a file that is not there.
 * 3. **URIs are rewritten** to the served layout below. The `.bin` becomes `model.bin`; an image
 *    becomes `../textures/<id>.png`, shared — `Bark_NormalTree.png` is used by ten models and
 *    copying it ten times would turn 20 MB of texture into 88 MB.
 *
 * Accessors, buffer views and the binary itself are untouched. In particular **`COLOR_0` is left
 * alone**, because it is not decoration: the bark primitives carry baked ambient occlusion in it
 * (measured — `CommonTree_1`'s bark runs 0.10..1.00, `TwistedTree_1`'s 0.04..1.00) while every leaf
 * primitive is uniformly white. The manifest records which is which per part
 * ({@link KitPart.vertexColours}) and `client3d/src/kit.ts` reconciles the geometry with the material
 * flag on load, where it is three lines instead of a buffer rewrite.
 *
 * ## What comes out
 *
 * ```
 * packages/client3d/public/models/nature/
 *   manifest.json          ← the only thing the client reads by name
 *   ATTRIBUTION.md
 *   textures/<texture-id>.png
 *   <model-id>/model.gltf
 *   <model-id>/model.bin
 * ```
 *
 * **Git-ignored and reproducible**, the same standing as `data/world` and `models/trees` — see
 * `.gitignore`, and the M5a ruling it records. A per-model directory rather than a flat dump because
 * the `.gltf` names its `.bin` by relative URI, and two models sharing a directory would need their
 * buffers name-mangled to avoid collision; a directory per id makes `model.bin` mean one thing.
 *
 * ## Determinism
 *
 * Same input, byte-identical output. Models and textures are sorted by id, every emitted JSON object
 * is built in a fixed key order, and nothing records a timestamp or a machine path. {@link
 * buildCatalogue} is pure over the parsed glTFs so `modelgen.test.ts` can assert that twice is the
 * same without touching the disk.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODELS_DIR = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models');

/**
 * Bumped in lockstep with `client3d/src/kit.ts`'s `KIT_MANIFEST_VERSION`. A stale import fails
 * loudly at boot rather than oddly three chunks later.
 */
export const KIT_MANIFEST_VERSION = 1;

/** The same, for `client3d/src/village.ts`'s `VILLAGE_MANIFEST_VERSION`. Its own number, its own kit. */
export const VILLAGE_MANIFEST_VERSION = 1;

/**
 * The same, for `client3d/src/characters.ts`'s `CHARACTER_MANIFEST_VERSION`. M7b.
 *
 * **2 since the hair slice.** {@link characterKind} grew a fourth answer, and a v1 reader meeting a
 * `hair` model would take the *body* branch — the meshes are skinned, so nothing would throw and six
 * hairstyles would quietly register as base bodies nothing ever asks for. That is exactly the silent
 * disagreement the version number exists to make loud: a stale `public/models/characters` now says
 * *"re-run modelgen --characters"* at boot instead of being subtly wrong for ever.
 */
export const CHARACTER_MANIFEST_VERSION = 2;

/** The same, for `client3d/src/props.ts`'s `PROPS_MANIFEST_VERSION`. M9's furniture. */
export const PROPS_MANIFEST_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The shape of a glTF, narrowed to what this file reads                        */
/* -------------------------------------------------------------------------- */

interface GltfTextureRef {
  index: number;
}

interface GltfMaterial {
  name: string;
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  normalTexture?: GltfTextureRef;
  pbrMetallicRoughness?: {
    baseColorTexture?: GltfTextureRef;
    metallicFactor?: number;
  };
}

interface GltfAccessor {
  count: number;
  type: string;
  componentType: number;
  min?: number[];
  max?: number[];
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices: number;
  material: number;
}

interface GltfSkin {
  name?: string;
  inverseBindMatrices?: number;
  skeleton?: number;
  joints: number[];
}

interface Gltf {
  asset: { generator?: string; version: string };
  scene?: number;
  scenes?: unknown[];
  nodes?: { name?: string; mesh?: number; skin?: number }[];
  materials: GltfMaterial[];
  meshes: { name?: string; primitives: GltfPrimitive[] }[];
  textures?: { sampler?: number; source: number }[];
  images?: { mimeType?: string; name?: string; uri: string }[];
  samplers?: unknown[];
  /** M7b: present on every rigged character file and on neither of the two prop kits. */
  skins?: GltfSkin[];
  accessors: GltfAccessor[];
  bufferViews: unknown[];
  buffers: { byteLength: number; uri?: string }[];
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `CommonTree_1.gltf` to `common-tree-1`, and the id is a join key from here on.
 *
 * It has to agree, character for character, with `client3d/src/prototypes.ts`'s `KIT_MODELS` and with
 * the kit ids inside `TREE_VARIANTS` — those lists are the closed set the material pool is sized
 * against, and `kit.test.ts` asserts the two agree. Underscores separate words, and so do camel
 * humps, so `RockPath_Round_Small_1` is `rock-path-round-small-1` rather than
 * `rockpath-round-small-1`: a reader looking for the rock paths should find them under `rock-`.
 */
export function kitId(fileName: string): string {
  return fileName
    .replace(/\.[^.]+$/, '')
    .split('_')
    .flatMap((word) => word.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' '))
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
    .join('-');
}

/**
 * Which of the two roles a primitive plays, from the texture it wears.
 *
 * The brief's rule, quoted where it is implemented: *"match by material/texture name — `Leaves_*`,
 * `Grass`, `Flowers` textures sway; bark and rock do not"*. Everything the client does differently
 * between the two — the wind patch, the alpha clip, the double-sided draw, whether a shadow is cast —
 * hangs off this one classification, so it is decided **here, once, off the texture's own name**,
 * rather than in the renderer where it would be a second table to keep in step.
 *
 * `Mushrooms` is solid on purpose: a mushroom cap is a closed mesh, it does not sway, and putting it
 * in the leaf family would give it an alpha clip it has no alpha for.
 */
export function kitRole(textureId: string): 'solid' | 'leaf' {
  if (textureId.startsWith('leaves') || textureId.startsWith('leaf-')) return 'leaf';
  if (textureId === 'grass' || textureId === 'flowers') return 'leaf';
  return 'solid';
}

/** The family a model belongs to, for the palette and for the report. Longest prefix wins. */
export const KIT_FAMILIES = [
  'common-tree',
  'pine',
  'dead-tree',
  'twisted-tree',
  'bush',
  'clover',
  'fern',
  'flower',
  'grass',
  'mushroom',
  'pebble',
  'petal',
  'plant',
  'rock-path',
  'rock-medium',
] as const;

export type KitFamily = (typeof KIT_FAMILIES)[number];

/** Longest prefix wins, over whichever family list the profile carries. */
function familyOf(id: string, families: readonly string[]): string {
  let best = 'unknown';
  for (const family of families) {
    if (!id.startsWith(family)) continue;
    if (best === 'unknown' || family.length > best.length) best = family;
  }
  return best;
}

export function kitFamily(id: string): KitFamily | 'unknown' {
  return familyOf(id, KIT_FAMILIES) as KitFamily | 'unknown';
}

/* ------------------------------------------------------------------ the village */

/**
 * The village kit's families. Longest prefix wins, and three pairs need it:
 * `door-frame` before `door`, `stairs` before `stair`, `window-shutters` before `window`.
 */
export const VILLAGE_FAMILIES = [
  'balcony',
  'corner',
  'door',
  'door-frame',
  'floor',
  'hole-cover',
  'overhang',
  'prop',
  'roof',
  'stair',
  'stairs',
  'wall',
  'window',
  'window-shutters',
] as const;

export function villageFamily(id: string): string {
  return familyOf(id, VILLAGE_FAMILIES);
}

/**
 * `T_Plaster_BaseColor.png` to `plaster` — the village pack's own texture naming, undone.
 *
 * The nature pack names a texture after the thing it dresses (`Bark_NormalTree.png`) and {@link
 * kitId} is enough. The village pack uses an Unreal-style channel convention — a `T_` prefix and a
 * `_BaseColor` / `_Normal` / `_ORM` / `_Roughness` suffix — so passing those straight through would
 * give the manifest `t-plaster-base-color` and the client a pool key nobody can read. Two literal
 * affixes are stripped and then it is {@link kitId} again, so the ids stay one function's answer.
 *
 * `T_VineLeaf_png.png` is upstream's own typo (the extension is in the stem) and loses its `_png`
 * here rather than being renamed on disk, because the file name is the join key back to the pack.
 */
export function villageTextureId(fileName: string): string {
  const stem = fileName
    .replace(/\.[^.]+$/, '')
    .replace(/^T_/, '')
    .replace(/_png$/i, '')
    .replace(/_(BaseColor|Normal|Roughness|ORM)$/i, '');
  return kitId(stem);
}

/**
 * Which of the two roles a village primitive plays.
 *
 * Almost everything in this kit is masonry, timber or tile — closed, opaque, single-sided, no sway.
 * The one exception is the vine, which is an alpha-masked leaf sheet and belongs in exactly the
 * family `foliage.ts` already has for the nature kit's leaves. `MI_WindowGlass` carries no texture at
 * all and is handled by the *absence* of a pool key rather than by a third role — see
 * `client3d/src/prototypes.ts`'s village part table.
 */
export function villageRole(textureId: string): 'solid' | 'leaf' {
  return textureId.startsWith('vine') ? 'leaf' : 'solid';
}

/**
 * The families whose models stand in the player's way, and therefore may only be placed where the
 * collision grid already says "no".
 *
 * The brief: *"trees and `Rock_Medium` block (reuse the shared scatter-block discipline … the 2D
 * scatter's `SCATTER_BLOCKS` rule exists because the owner got wedged behind a log once).
 * Understory never blocks."* The flag travels in the manifest rather than being re-derived in the
 * renderer so that a model added to the kit declares its own bulk.
 */
const BLOCKING: ReadonlySet<string> = new Set([
  'common-tree',
  'pine',
  'dead-tree',
  'twisted-tree',
  'rock-medium',
]);

/* -------------------------------------------------------------------------- */
/* Profiles — what differs between the two kits, and nothing else               */
/* -------------------------------------------------------------------------- */

/**
 * One kit, as the four facts that are not shared.
 *
 * Everything absent from this interface is deliberately *not* a per-kit decision: the normal-map
 * drop, the image reindex, the sorted manifest, the per-model directory and the byte-identical
 * re-run are properties of the importer and are shared by construction.
 */
export interface KitProfile {
  /** `nature` / `village`. Names the output directory, the URL prefix and the flag. */
  readonly id: string;
  /** `$GAME_NATURE_KIT` / `$GAME_VILLAGE_KIT`. */
  readonly env: string;
  readonly version: number;
  readonly generator: string;
  /** Texture file name to manifest id. The two packs name their PNGs differently. */
  readonly textureId: (fileName: string) => string;
  readonly role: (textureId: string) => 'solid' | 'leaf';
  readonly family: (id: string) => string;
  /** Families whose models stand in the player's way. Empty for a kit nothing scatters. */
  readonly blocking: ReadonlySet<string>;
  /**
   * What a file *is*, when that is a question this kit's renderer branches on — M7b, characters only.
   *
   * Its presence is also the switch for the three optional {@link KitModel} fields: a profile with no
   * `kind` emits no `kind`, no `stem` and no `joints`, so the nature and village manifests are
   * byte-for-byte what they were before this parameter existed.
   */
  readonly kind?: (stem: string) => string;
  /** Lines for the `ATTRIBUTION.md`'s "what was changed on the way in" section. */
  readonly changes: readonly string[];
  readonly pack: string;
}

export const NATURE_PROFILE: KitProfile = {
  id: 'nature',
  env: 'GAME_NATURE_KIT',
  version: KIT_MANIFEST_VERSION,
  generator: 'modelgen.ts from the Quaternius Stylized Nature MegaKit (CC0)',
  textureId: kitId,
  role: kitRole,
  family: kitFamily,
  blocking: BLOCKING,
  pack: '**Quaternius — Stylized Nature MegaKit**, textured glTF line, Standard tier.',
  changes: [
    '- Normal maps dropped: nothing in `client3d` samples one (every material is a `MeshLambertMaterial`).',
    '- `images`/`textures` rebuilt and reindexed; image URIs pointed at the shared `textures/` directory.',
    '- Geometry, accessors and buffer views are the upstream bytes, unmodified.',
  ],
};

/**
 * The Medieval Village MegaKit — M6.
 *
 * **Nothing blocks**, and the empty set is the point: `blocks` is the *scatter's* question ("may this
 * be dropped on open ground?") and no village module is ever scattered. Every one of them is placed
 * by `client3d/src/interior.ts` from the room IR's own edges, on the boundary line the collision grid
 * already made solid, so a bulk flag would be answering a question nobody asks.
 */
export const VILLAGE_PROFILE: KitProfile = {
  id: 'village',
  env: 'GAME_VILLAGE_KIT',
  version: VILLAGE_MANIFEST_VERSION,
  generator: 'modelgen.ts from the Quaternius Medieval Village MegaKit (CC0)',
  textureId: villageTextureId,
  role: villageRole,
  family: villageFamily,
  blocking: new Set(),
  pack: '**Quaternius — Medieval Village MegaKit**, textured glTF line, Standard tier.',
  changes: [
    '- Normal maps, roughness and ORM maps dropped: `client3d` is Lambert throughout and samples none',
    '  of them. That is 38.1 MB of the pack’s 58.4 MB of PNG, and the largest single saving available',
    '  before the deferred KTX2 slice.',
    '- `images`/`textures` rebuilt and reindexed; image URIs pointed at the shared `textures/` directory.',
    '- Geometry, accessors and buffer views are the upstream bytes, unmodified. No module is rescaled on',
    '  disk: the 2 m module grid is mapped onto the 9 m room by the renderer’s own `VILLAGE_SCALE`, so',
    '  the mapping is one named constant in one file rather than a transform baked into 176 buffers.',
  ],
};

/* ---------------------------------------------------------------- the people */

/**
 * What a character file *is*, from its own stem — and the join key `client3d` routes on.
 *
 * Four answers and no fifth, because four packs are read into one directory: a **body** is one of the
 * two rigs in *Universal Base Characters*, an **outfit** is one of the twenty modular parts in
 * *Modular Character Outfits — Fantasy*, **hair** is one of that first pack's `Hairstyles/` meshes, and
 * a **weapon** is one of the four props `appearance.ts`'s `WEAPON_ART` can name. The test asserts the
 * partition is total over what is actually on disk, so a fifth file dropped into the source directory
 * fails here rather than arriving as an unclassified model the renderer silently never draws.
 *
 * Keyed on the stem's own shape rather than on a list, because the vendor's naming is regular in
 * exactly the way that matters: a body is `Superhero_*`, an outfit part is `<Sex>_<Style>_*`, a
 * hairstyle is `Hair_*`.
 *
 * **`hair` is a kind rather than a fifth `outfit` slot**, and the reason is what the renderer does
 * with it: a garment *replaces* a region of the naked body (`skin.HIDDEN_BY_SLOT`) and hair replaces
 * nothing — the base bodies are bald. It also carries a fact no outfit part needs, its own head
 * inverse-bind matrix, which is what lets a hairstyle authored on one sex sit correctly on the other.
 * Filing it under `outfit` would make the renderer ask "is this one of the hair ones" at every use.
 *
 * **The two `Eyebrows_*` meshes in the same source directory are deliberately not staged**, and it is
 * a measurement rather than an omission: they are already *inside* the base bodies. `Eyebrows_Regular`
 * is the male body's own `Face` primitive and `Eyebrows_Female` is the female's `Eyebrows` — identical
 * index, UV, joint and weight buffers, and positions agreeing to 4.9e-7 m. Importing them would draw
 * the same 984 and 1,480 triangles twice, in the same place, on every character in the world.
 */
export function characterKind(stem: string): 'body' | 'outfit' | 'hair' | 'weapon' {
  if (stem.startsWith('Superhero_')) return 'body';
  if (/^(Female|Male)_(Peasant|Ranger)_/.test(stem)) return 'outfit';
  if (stem.startsWith('Hair_')) return 'hair';
  return 'weapon';
}

/**
 * The character packs' families, for the report and for the attribution contact sheet.
 *
 * Deliberately coarser than {@link characterKind} — this is the "what shelf does it live on" answer a
 * human reads, where `kind` is the one the renderer branches on.
 */
export const CHARACTER_FAMILIES = [
  'axe',
  'female-peasant',
  'female-ranger',
  // One shelf for all six hairstyles: `hair-beard`, `hair-buns`, `hair-buzzed`, `hair-buzzed-female`,
  // `hair-long`, `hair-simple-parted`. Coarser than `characterKind`, as every row here is.
  'hair',
  'male-peasant',
  'male-ranger',
  'shield',
  'superhero-female',
  'superhero-male',
  'sword',
  'torch',
] as const;

export function characterFamily(id: string): string {
  return familyOf(id, CHARACTER_FAMILIES);
}

/**
 * The character packs share the village kit's Unreal-style texture naming — with **one more vendor
 * asymmetry**, which is why this is `villageTextureId` and not a fourth function.
 *
 * `T_Superhero_Female_Dark_BaseColor.png` carries the channel suffix and
 * `T_Superhero_Male_Dark.png` does not. Both survive: stripping `_BaseColor` when it is there and
 * leaving the stem alone when it is not gives `superhero-female-dark` and `superhero-male-dark`, two
 * distinct ids naming two distinct files. A `${sex}` template would have produced one name, found one
 * file and dressed both bodies in the same skin.
 *
 * The base pack also ships the `_png.png` typo the village kit's `T_VineLeaf_png.png` already taught
 * this importer about (`T_Hair_1_BaseColor_png.png` beside `T_Hair_1_BaseColor.png`), and it is
 * handled by the same `_png$` strip plus `readSources`' base-colour-wins rule.
 */
export const CHARACTERS_PROFILE: KitProfile = {
  id: 'characters',
  env: 'GAME_CHARACTER_KIT',
  version: CHARACTER_MANIFEST_VERSION,
  generator: 'modelgen.ts from the Quaternius character packs (CC0)',
  textureId: villageTextureId,
  // Nothing a character wears sways, and nothing it holds does either: `foliage.ts`'s leaf family is
  // for intersecting alpha cards and a hood is a closed mesh. One role, stated rather than inferred.
  role: () => 'solid',
  family: characterFamily,
  kind: characterKind,
  // `blocks` is the *scatter's* question and nothing here is ever scattered — a body is placed by the
  // simulation's own coordinates. The same empty set the village profile carries, for the same reason.
  blocking: new Set(),
  pack:
    '**Quaternius — Universal Base Characters** (the two rigs and six of its eight `Hairstyles/` ' +
    'meshes, in the *Rigged to Head Bone* line), **Modular Character Outfits — Fantasy**, ' +
    '**Fantasy Props MegaKit** (four props) and **Universal Animation Library 1 & 2**, ' +
    'textured glTF / GLB lines, Standard tier.',
  changes: [
    '- Normal, roughness and ORM maps dropped: `client3d` is Lambert throughout and samples none of',
    '  them. That is 71.4 MB of the packs’ 91.8 MB of PNG.',
    '- The two `Eyebrows_*` hairstyle meshes are **not** staged: they are already inside the base',
    '  bodies (`Eyebrows_Regular` is the male body’s own `Face` primitive, `Eyebrows_Female` the',
    '  female’s `Eyebrows`) — same indices, UVs, joints and weights, positions agreeing to 4.9e-7 m.',
    '  Importing them would draw the same triangles twice on every character in the world.',
    '- The six hairstyles come from *Rigged to Head Bone* rather than *Origin at 0*: that line binds',
    '  the same 65 joints as everything else here, weighted 100% to `Head`, so a hairstyle rides the',
    '  head through every animation with no attachment code at all.',
    '- `images`/`textures` rebuilt and reindexed; image URIs pointed at the shared `textures/` directory.',
    '- `skins` and their inverse-bind-matrix accessors are **kept**, untouched: they are the rig.',
    '- Geometry, accessors and buffer views are the upstream bytes, unmodified. Nothing is rescaled on',
    '  disk — the base bodies measure 1.81 m and 1.767 m as authored, which is the height the world was',
    '  already built for.',
    '- The two animation libraries are re-cut to the clips the state machine names — 11 of 43 and 5 of',
    '  43 — and re-packed; see `buildAnimationLibrary`. That is 15.0 MB of GLB down to 2.2 MB.',
  ],
};

/* ------------------------------------------------------------- the furniture */

/**
 * The Fantasy Props MegaKit's families. Longest prefix wins, and four pairs need it: `bed-twin`
 * before `bed`, `book-group`/`book-stack`/`book-stand`/`bookcase` around `book`, `candle-stick`
 * before `candle`, `stall-cart` before `stall`, `workbench-drawers` before `workbench`.
 *
 * Broader than the drawn set on purpose — the manifest is the whole pack, as both prop kits' are, and
 * a family is what a human reads on a contact sheet rather than what the renderer branches on.
 */
export const PROPS_FAMILIES = [
  'anvil', 'axe', 'bag', 'banner', 'barrel', 'bed', 'bed-twin', 'bench', 'book', 'book-group',
  'book-stack', 'book-stand', 'bookcase', 'bottle', 'bucket', 'cabinet', 'cage', 'candle',
  'candle-stick', 'carrot', 'cauldron', 'chain', 'chair', 'chalice', 'chandelier', 'chest', 'coin',
  'crate', 'dummy', 'farm-crate', 'key', 'lantern', 'mug', 'nightstand', 'peg-rack', 'pickaxe',
  'pot', 'potion', 'pouch', 'rope', 'scroll', 'shelf', 'shield', 'small-bottle', 'small-bottles',
  'stall', 'stall-cart', 'stool', 'sword', 'table', 'torch', 'vase', 'weapon-stand', 'whetstone',
  'workbench', 'workbench-drawers',
] as const;

export function propsFamily(id: string): string {
  return familyOf(id, PROPS_FAMILIES);
}

/**
 * The Fantasy Props MegaKit — M9, and the **fourth tenant of one importer with nothing new in it**.
 *
 * Every parameter is one the first three already needed. The pack shares the village kit's
 * Unreal-style texture naming (`T_Trim_Furniture_BaseColor.png`), so `textureId` is
 * {@link villageTextureId} for the third time; nothing in it sways, so `role` is the constant
 * `CHARACTERS_PROFILE` already uses; and nothing in it is ever *scattered*, so `blocking` is the
 * empty set both the village and the characters carry — a furniture piece is placed by
 * `client3d/src/furnish.ts` from the room's own name and its footprint is checked against
 * `roomScene.walkableRequired` there, which is a stricter question than "may this be dropped on open
 * ground?" and is asked in a different file.
 *
 * **Three of its five atlases are already on the wire.** `MI_Trim_Furniture`, `MI_Trim_Metal` and
 * `MI_Trim_Props` are the same three the *Modular Character Outfits* props wear — the sword, the axe
 * and the shield — and `ScenePool.registerTexture` is keyed by manifest id, so whichever pack loads
 * first pays for them and the other gets them free. What this kit actually adds to the download is
 * `trim-cloth` and `page-noise`.
 *
 * The source unpacks as `props/Exports/glTF`, which {@link gltfDirOf}'s single-child descent already
 * handles — `Textures/` beside it has no `glTF` of its own, so the choice is unambiguous.
 */
export const PROPS_PROFILE: KitProfile = {
  id: 'props',
  env: 'GAME_PROPS_KIT',
  version: PROPS_MANIFEST_VERSION,
  generator: 'modelgen.ts from the Quaternius Fantasy Props MegaKit (CC0)',
  textureId: villageTextureId,
  role: () => 'solid',
  family: propsFamily,
  blocking: new Set(),
  pack: '**Quaternius — Fantasy Props MegaKit**, textured glTF line, Standard tier.',
  changes: [
    '- Normal, roughness and ORM maps dropped: `client3d` is Lambert throughout and samples none of',
    '  them. Five base-colour atlases survive of the pack’s thirteen PNGs.',
    '- `images`/`textures` rebuilt and reindexed; image URIs pointed at the shared `textures/` directory.',
    '- Geometry, accessors and buffer views are the upstream bytes, unmodified. Nothing is rescaled on',
    '  disk — the pack is authored at world scale already (a barrel is 0.90 m tall, a table 0.81 m, a',
    '  bookcase 2.55 m), which is the one thing the nature kit’s understory was not.',
    '- `Chest_Wood` keeps its skin: it is the pack’s only rigged file (an animated lid) and a node',
    '  naming a `skins` array that is not in the document is a `GLTFLoader` throw.',
  ],
};

export const PROFILES: readonly KitProfile[] = [
  NATURE_PROFILE,
  VILLAGE_PROFILE,
  CHARACTERS_PROFILE,
  PROPS_PROFILE,
];

/* -------------------------------------------------------------------------- */
/* The manifest, as this file writes it and `client3d/src/kit.ts` reads it      */
/* -------------------------------------------------------------------------- */

export interface KitPart {
  /** The glTF material's own name — how `kit.ts` matches a loaded primitive back to this entry. */
  readonly material: string;
  readonly role: 'solid' | 'leaf';
  /** The shared texture's id, into {@link KitManifest.textures}. */
  readonly texture: string;
  readonly triangles: number;
  readonly vertices: number;
  /** The glTF's own `alphaCutoff` when the material is `MASK`, else 0. */
  readonly alphaTest: number;
  /** Whether the primitive carries a `COLOR_0`. See the header on the baked bark AO. */
  readonly vertexColours: boolean;
}

export interface KitModel {
  readonly id: string;
  readonly family: string;
  /**
   * What the renderer branches on — M7b, and present only for a profile with a
   * {@link KitProfile.kind}. `body` / `outfit` / `hair` / `weapon` for the character packs, absent for
   * both prop kits.
   */
  readonly kind?: string;
  /**
   * The **vendor's own file stem**, `Male_Ranger_Feet_Boots` — the join key back to the ids
   * `shared/src/appearance.ts` puts on the wire, and the reason it is recorded rather than derived.
   *
   * `id` is `kitId(stem)` and is what names the directory; the two are not interchangeable, because
   * the round trip is lossy in the one direction that matters. Present only for a profile with a
   * {@link KitProfile.kind}.
   */
  readonly stem?: string;
  /**
   * How many joints this file's skin binds — 65 for every rigged character file in all three packs,
   * absent for anything with no skin at all.
   *
   * On the manifest because it is the fact the whole milestone rests on: one armature, bound by name,
   * shared by the bodies, the outfit parts and both animation libraries. A part that arrived with 63
   * would compose into a body with two joints of its geometry pinned at the origin, and a number in
   * the manifest is where a test can see that before a frame is drawn.
   */
  readonly joints?: number;
  /** The runtime URL, relative to the served root. Never a disk path and never a bundler specifier. */
  readonly url: string;
  /** glTF + bin, on disk. */
  readonly bytes: number;
  readonly triangles: number;
  /** XZ footprint and height, in metres, off the accessors' own min/max. */
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  /** How far the model sinks below its own origin — roots and skirts. Placement is by the origin. */
  readonly minY: number;
  readonly blocks: boolean;
  /** Metres. Half the larger footprint axis; 0 when {@link blocks} is false. */
  readonly blockRadius: number;
  readonly parts: readonly KitPart[];
}

export interface KitTexture {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** How many primitives across the whole kit wear it. Informational; the client caches by id. */
  readonly used: number;
}

export interface KitManifest {
  readonly version: number;
  readonly generator: string;
  readonly models: readonly KitModel[];
  readonly textures: readonly KitTexture[];
  /** M7b, characters only: the re-cut animation libraries. Absent for a kit that has none. */
  readonly animations?: readonly AnimationLibrary[];
}

/** One re-cut *Universal Animation Library*, as {@link buildAnimationLibrary} left it. */
export interface AnimationLibrary {
  /** `ual1` / `ual2` — the client's own name for the file, and its filename stem. */
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  /** What was on the way in, so the report can say what the cut was worth. */
  readonly sourceBytes: number;
  readonly sourceClips: number;
  readonly clips: readonly AnimationClipEntry[];
}

export interface AnimationClipEntry {
  /** The clip's own name, which is what `AnimationMixer` binds on. */
  readonly name: string;
  /** Seconds, off the largest keyframe time in the clip's own samplers. */
  readonly duration: number;
  /** 195 for every clip in both libraries: 65 joints x translation/rotation/scale. */
  readonly channels: number;
}

/* -------------------------------------------------------------------------- */
/* Reading the kit                                                              */
/* -------------------------------------------------------------------------- */

export interface SourceModel {
  readonly file: string;
  readonly gltf: Gltf;
  readonly binBytes: number;
  readonly gltfBytes: number;
}

/** PNG `IHDR` is the first chunk and always at a fixed offset. Sixteen bytes rather than a decoder. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24) return { width: 0, height: 0 };
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The whole import, as a pure function of what was read off disk.
 *
 * Pure so that `modelgen.test.ts` can run it twice over the same input and assert the two are
 * byte-identical without writing anything — determinism is the property the brief asks for by name,
 * and a test that re-ran the *writer* would be testing the filesystem.
 */
export function buildCatalogue(
  sources: readonly SourceModel[],
  textureBytes: ReadonlyMap<string, Buffer>,
  profile: KitProfile = NATURE_PROFILE,
): { manifest: KitManifest; gltfs: Map<string, string>; textureFiles: Map<string, string> } {
  const used = new Map<string, number>();
  const textureFiles = new Map<string, string>();
  const models: KitModel[] = [];
  const gltfs = new Map<string, string>();

  // Sorted by id so the manifest's order is a property of the kit rather than of `readdir`.
  const ordered = [...sources].sort((a, b) => (kitId(a.file) < kitId(b.file) ? -1 : 1));

  for (const source of ordered) {
    const id = kitId(source.file);
    const gltf = source.gltf;
    const parts: KitPart[] = [];
    let triangles = 0;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    /** Old image index to the id it was rewritten to, so the glTF rebuild below can reindex. */
    const keptImages: number[] = [];

    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives) {
        const material = gltf.materials[primitive.material];
        if (!material) continue;
        const baseColour = material.pbrMetallicRoughness?.baseColorTexture;
        const imageIndex = baseColour ? gltf.textures?.[baseColour.index]?.source : undefined;
        const imageUri = imageIndex === undefined ? undefined : gltf.images?.[imageIndex]?.uri;
        const textureId = imageUri ? profile.textureId(imageUri) : 'none';
        if (imageIndex !== undefined && !keptImages.includes(imageIndex)) keptImages.push(imageIndex);
        if (imageUri) {
          used.set(textureId, (used.get(textureId) ?? 0) + 1);
          textureFiles.set(textureId, imageUri);
        }

        const indices = gltf.accessors[primitive.indices];
        const position = gltf.accessors[primitive.attributes['POSITION'] ?? -1];
        const tris = indices ? indices.count / 3 : 0;
        triangles += tris;
        if (position?.min && position.max) {
          minX = Math.min(minX, position.min[0] ?? 0);
          minY = Math.min(minY, position.min[1] ?? 0);
          minZ = Math.min(minZ, position.min[2] ?? 0);
          maxX = Math.max(maxX, position.max[0] ?? 0);
          maxY = Math.max(maxY, position.max[1] ?? 0);
          maxZ = Math.max(maxZ, position.max[2] ?? 0);
        }

        parts.push({
          material: material.name,
          role: profile.role(textureId),
          texture: textureId,
          triangles: tris,
          vertices: position?.count ?? 0,
          // `alphaCutoff` defaults to 0.5 in glTF when `MASK` omits it; the kit always states 0.2.
          alphaTest: material.alphaMode === 'MASK' ? (material.alphaCutoff ?? 0.5) : 0,
          vertexColours: primitive.attributes['COLOR_0'] !== undefined,
        });
      }
    }

    const family = profile.family(id);
    const width = round(maxX - minX);
    const depth = round(maxZ - minZ);
    const blocks = profile.blocking.has(family);
    // The *emitted* glTF's size, not the source's: this one has lost its normal-map references and
    // gained rewritten URIs, so it is a different length. `kit.test.ts` compares the manifest's
    // figure against what is on disk, which is the only version of this number worth recording.
    const text = rewriteGltf(gltf, keptImages, profile);
    const stem = source.file.replace(/\.[^.]+$/, '');
    models.push({
      id,
      family,
      // Three fields or none: a profile that does not classify emits the manifest it always did. See
      // `KitProfile.kind`, and `KitModel.stem` for why the vendor's spelling is the join key.
      ...(profile.kind
        ? { kind: profile.kind(stem), stem, joints: gltf.skins?.[0]?.joints.length ?? 0 }
        : {}),
      url: `models/${profile.id}/${id}/model.gltf`,
      bytes: Buffer.byteLength(text, 'utf8') + source.binBytes,
      triangles,
      width,
      depth,
      height: round(maxY - minY),
      minY: round(minY),
      blocks,
      blockRadius: blocks ? round(Math.max(width, depth) / 2) : 0,
      parts,
    });

    gltfs.set(id, text);
  }

  const textures: KitTexture[] = [...textureFiles.keys()].sort().map((id) => {
    const bytes = textureBytes.get(id);
    const size = bytes ? pngSize(bytes) : { width: 0, height: 0 };
    return {
      id,
      url: `models/${profile.id}/textures/${id}.png`,
      bytes: bytes?.byteLength ?? 0,
      width: size.width,
      height: size.height,
      used: used.get(id) ?? 0,
    };
  });

  return {
    manifest: {
      version: profile.version,
      generator: profile.generator,
      models,
      textures,
    },
    gltfs,
    textureFiles,
  };
}

/** Three decimals of a metre. Rounded so the manifest is stable against float printing. */
function round(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/**
 * The emitted glTF: the source, minus the normal maps, with its URIs pointed at the served layout.
 *
 * Built as a fresh object in a fixed key order rather than mutated in place, so the JSON this writes
 * is a function of the input and not of whatever order the source happened to serialise its keys in.
 */
function rewriteGltf(gltf: Gltf, keptImages: readonly number[], profile: KitProfile): string {
  const imageAt = new Map<number, number>();
  keptImages.forEach((source, index) => imageAt.set(source, index));

  const images = keptImages.map((source) => {
    const image = gltf.images?.[source];
    const uri = image?.uri ?? '';
    const id = profile.textureId(uri);
    return { mimeType: 'image/png', name: image?.name ?? id, uri: `../textures/${id}.png` };
  });

  // One texture per kept image, in the same order. The source's own `textures` array carried an
  // entry per *use* including the normal maps; rebuilding it is what keeps the indices honest.
  const textures = keptImages.map(() => ({ sampler: 0, source: 0 })).map((_, index) => ({ sampler: 0, source: index }));

  const materials = gltf.materials.map((material) => {
    const baseColour = material.pbrMetallicRoughness?.baseColorTexture;
    const oldImage = baseColour ? gltf.textures?.[baseColour.index]?.source : undefined;
    const newIndex = oldImage === undefined ? undefined : imageAt.get(oldImage);
    return {
      ...(material.alphaCutoff !== undefined ? { alphaCutoff: material.alphaCutoff } : {}),
      ...(material.alphaMode !== undefined ? { alphaMode: material.alphaMode } : {}),
      doubleSided: material.doubleSided === true,
      name: material.name,
      pbrMetallicRoughness: {
        ...(newIndex !== undefined ? { baseColorTexture: { index: newIndex } } : {}),
        metallicFactor: material.pbrMetallicRoughness?.metallicFactor ?? 0,
      },
    };
  });

  const out = {
    asset: { generator: gltf.asset.generator ?? 'unknown', version: gltf.asset.version },
    scene: gltf.scene ?? 0,
    scenes: gltf.scenes ?? [],
    nodes: gltf.nodes ?? [],
    materials,
    meshes: gltf.meshes,
    ...(images.length > 0 ? { textures, images, samplers: gltf.samplers ?? [{}] } : {}),
    // **M7b: the rig survives.** Every node in a character file carries `skin: 0`, and a node that
    // names a `skins` array which is not in the document is a `GLTFLoader` throw rather than an
    // untextured mesh. Conditional, so the two prop kits — which have no skin — emit exactly the
    // bytes they emitted before this line existed. The inverse-bind matrices it points at are
    // accessors, which have always come through untouched.
    ...(gltf.skins ? { skins: gltf.skins } : {}),
    accessors: gltf.accessors,
    bufferViews: gltf.bufferViews,
    buffers: gltf.buffers.map((buffer) => ({ byteLength: buffer.byteLength, uri: 'model.bin' })),
  };
  return `${JSON.stringify(out, null, '\t')}\n`;
}

/* -------------------------------------------------------------------------- */
/* The animation libraries — M7b                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which clips M7b's state machine actually plays, by library — **the cut list**.
 *
 * The canonical copy, because this is what does the cutting; `client3d/src/anim.ts` mirrors it as
 * `CLIPS` and `characters.test.ts` asserts every name the state machine reaches for is in the
 * generated manifest. Two lists and one check, which is `kit.test.ts`'s standing arrangement for
 * `treeTexture` and the reason a renamed clip is a failing test rather than a character frozen in a
 * T-pose.
 *
 * Ten of UAL1's 43 and five of UAL2's 43. What is *not* here is as deliberate: `Punch_*`,
 * `Pistol_*`, `Zombie_*`, the swimming, the farming and the twelve idle variants are motions this
 * game has no state for, and a clip nobody plays is 130 KB of keyframes the player still downloads.
 * Adding one is one line in each of the two lists and a re-run.
 */
export const CHARACTER_CLIPS: Readonly<Record<string, readonly string[]>> = {
  ual1: [
    // Locomotion, by speed. `Walk_Formal_Loop` is the same gait with the arms held and is not used.
    'Idle_Loop',
    'Walk_Loop',
    'Jog_Fwd_Loop',
    'Sprint_Loop',
    // Combat, for a body with no sword in its hand and for a caster. `Spell_Simple_Idle_Loop` is the
    // held wind-up protocol 22's `EntityView.casting` was added to make observable.
    'Sword_Attack',
    'Sword_Idle',
    'Spell_Simple_Idle_Loop',
    'Spell_Simple_Shoot',
    // Being hit, and stopping.
    'Hit_Chest',
    'Hit_Head',
    'Death01',
  ],
  ual2: [
    // The three-swing melee ladder the 3 s round rotates through, plus the shield's own two.
    'Sword_Regular_A',
    'Sword_Regular_B',
    'Sword_Regular_C',
    'Sword_Block',
    'Hit_Knockback',
  ],
};

/** GLB container constants. `glTF` little-endian, then `JSON` and `BIN\0` chunk types. */
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

interface GltfAnimationSampler {
  input: number;
  output: number;
  interpolation?: string;
}

interface GltfAnimation {
  name: string;
  samplers: GltfAnimationSampler[];
  channels: { sampler: number; target: { node: number; path: string } }[];
}

interface AnimationGltf extends Gltf {
  animations: GltfAnimation[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

/** Reads a GLB's two chunks. Throws rather than guesses: a malformed library is not a smaller one. */
export function readGlb(bytes: Buffer): { json: AnimationGltf; bin: Buffer } {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC) throw new Error('not a GLB');
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== GLB_CHUNK_JSON) throw new Error('GLB: first chunk is not JSON');
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as AnimationGltf;
  const binHeader = 20 + jsonLength;
  if (bytes.readUInt32LE(binHeader + 4) !== GLB_CHUNK_BIN) throw new Error('GLB: second chunk is not BIN');
  const binLength = bytes.readUInt32LE(binHeader);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

/** The inverse. Both chunks are padded to four bytes, JSON with spaces and BIN with zeros — the spec's own. */
function writeGlb(json: unknown, bin: Buffer): Buffer {
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (text.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const jsonChunk = Buffer.concat([text, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(GLB_CHUNK_JSON, 16);
  jsonChunk.copy(out, 20);
  const binAt = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binAt);
  out.writeUInt32LE(GLB_CHUNK_BIN, binAt + 4);
  binChunk.copy(out, binAt + 8);
  return out;
}

/**
 * Re-cut one animation library to the clips {@link CHARACTER_CLIPS} names — the whole of M7b's
 * offline saving, and a pure function so `modelgen.test.ts` can run it twice and diff the bytes.
 *
 * **The mesh goes.** A UAL GLB carries a grey mannequin so that a human opening it in Blender sees
 * something move; nothing in this renderer ever draws it, and its skin's inverse-bind matrices are
 * the *mannequin's* rather than the character's — binding to them would be the one way to get the
 * retarget wrong. So `meshes`, `skins`, `materials`, `textures`, `images` and `samplers` are all
 * dropped and every node loses its `mesh`/`skin` reference. What remains is the joint hierarchy and
 * the keyframes, which is exactly what `AnimationMixer` needs and all it needs.
 *
 * **Nodes all stay**, cheap and whole: they are JSON, they carry the joint *names* the retarget binds
 * on, and pruning them would mean reindexing every channel target for no measurable saving.
 *
 * Determinism comes from three ordering rules and nothing else: clips are emitted in the order
 * {@link CHARACTER_CLIPS} lists them; the accessors they reference are re-emitted in ascending
 * *source* index; and the buffer views are packed in ascending source index at four-byte alignment.
 * No timestamp, no machine path, no `Map` iteration whose order is an accident.
 */
export function buildAnimationLibrary(
  source: Buffer,
  wanted: readonly string[],
): { readonly glb: Buffer; readonly clips: readonly AnimationClipEntry[]; readonly sourceClips: number } {
  const { json, bin } = readGlb(source);
  const byName = new Map(json.animations.map((clip) => [clip.name, clip]));

  const kept: GltfAnimation[] = [];
  for (const name of wanted) {
    const clip = byName.get(name);
    // Thrown rather than skipped: a clip the state machine names and the pack does not have is a
    // character that freezes at the moment it matters, and the pack is on disk right now to check.
    if (!clip) throw new Error(`animation library has no clip named ${name}`);
    kept.push(clip);
  }

  // Every accessor any kept sampler reads, in ascending source order.
  const accessorsUsed = new Set<number>();
  for (const clip of kept) {
    for (const sampler of clip.samplers) {
      accessorsUsed.add(sampler.input);
      accessorsUsed.add(sampler.output);
    }
  }
  const accessorOrder = [...accessorsUsed].sort((a, b) => a - b);
  const accessorAt = new Map<number, number>();
  accessorOrder.forEach((old, index) => accessorAt.set(old, index));

  // Every buffer view those accessors read, likewise — deduped, because two accessors may share one.
  const viewsUsed = new Set<number>();
  for (const old of accessorOrder) {
    const view = (json.accessors[old] as { bufferView?: number } | undefined)?.bufferView;
    if (view !== undefined) viewsUsed.add(view);
  }
  const viewOrder = [...viewsUsed].sort((a, b) => a - b);
  const viewAt = new Map<number, number>();

  const chunks: Buffer[] = [];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let at = 0;
  for (const old of viewOrder) {
    const view = json.bufferViews[old]!;
    // Four-byte alignment, because an accessor's `byteOffset` into the *buffer* must be a multiple of
    // its component size and every component here is a float or a short. Padding rather than packing
    // tight: 3 bytes at worst per view against a rebuild that is provably legal.
    const pad = (4 - (at % 4)) % 4;
    if (pad > 0) {
      chunks.push(Buffer.alloc(pad));
      at += pad;
    }
    viewAt.set(old, bufferViews.length);
    const start = view.byteOffset ?? 0;
    chunks.push(Buffer.from(bin.subarray(start, start + view.byteLength)));
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: view.byteLength });
    at += view.byteLength;
  }
  const rebuilt = Buffer.concat(chunks);

  const accessors = accessorOrder.map((old) => {
    const accessor = json.accessors[old]! as GltfAccessor & { bufferView?: number; byteOffset?: number; normalized?: boolean };
    return {
      ...(accessor.bufferView === undefined ? {} : { bufferView: viewAt.get(accessor.bufferView)! }),
      ...(accessor.byteOffset ? { byteOffset: accessor.byteOffset } : {}),
      componentType: accessor.componentType,
      count: accessor.count,
      ...(accessor.max ? { max: accessor.max } : {}),
      ...(accessor.min ? { min: accessor.min } : {}),
      ...(accessor.normalized ? { normalized: true } : {}),
      type: accessor.type,
    };
  });

  const animations = kept.map((clip) => ({
    channels: clip.channels.map((channel) => ({
      sampler: channel.sampler,
      target: { node: channel.target.node, path: channel.target.path },
    })),
    name: clip.name,
    samplers: clip.samplers.map((sampler) => ({
      input: accessorAt.get(sampler.input)!,
      ...(sampler.interpolation ? { interpolation: sampler.interpolation } : {}),
      output: accessorAt.get(sampler.output)!,
    })),
  }));

  const nodes = (json.nodes ?? []).map((node) => {
    const { mesh: _mesh, skin: _skin, ...rest } = node;
    return rest;
  });

  const out = {
    accessors,
    animations,
    asset: { generator: json.asset.generator ?? 'unknown', version: json.asset.version },
    bufferViews,
    buffers: [{ byteLength: rebuilt.length }],
    nodes,
    scene: json.scene ?? 0,
    scenes: json.scenes ?? [],
  };

  const clips: AnimationClipEntry[] = kept.map((clip) => {
    let duration = 0;
    for (const sampler of clip.samplers) {
      const input = json.accessors[sampler.input];
      duration = Math.max(duration, input?.max?.[0] ?? 0);
    }
    return { name: clip.name, duration: round(duration), channels: clip.channels.length };
  });

  return { glb: writeGlb(out, rebuilt), clips, sourceClips: json.animations.length };
}

/* -------------------------------------------------------------------------- */
/* The CLI                                                                      */
/* -------------------------------------------------------------------------- */

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** `--source`, else the profile's environment variable, else the repo's own copy. See the header. */
export function sourceDir(profile: KitProfile = NATURE_PROFILE): string {
  const explicit = flag('source') ?? process.env[profile.env];
  return explicit ? resolve(explicit) : join(REPO_ROOT, 'assets', 'quaternius', profile.id);
}

/**
 * The directory holding the `.gltf` files, given whatever the owner pointed at.
 *
 * `<source>/glTF` when it exists; otherwise the single child that has one — the village pack unpacks
 * as `village/Medieval Village MegaKit[Standard]/glTF` and typing that bracketed name on a command
 * line is a trap. It descends only when the choice is unambiguous: two packs under one directory
 * returns nothing and the caller reports the same "no kit here" error it would for an empty one,
 * because silently picking the alphabetically-first pack is the kind of help nobody can debug.
 */
export function gltfDirOf(source: string): string | undefined {
  const direct = join(source, 'glTF');
  if (existsSync(direct)) return direct;
  if (!existsSync(source)) return undefined;
  const nested = readdirSync(source, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, 'glTF')))
    .map((entry) => join(source, entry.name, 'glTF'));
  return nested.length === 1 ? nested[0] : undefined;
}

export function readSources(
  gltfDir: string,
  profile: KitProfile = NATURE_PROFILE,
): { sources: SourceModel[]; textures: Map<string, Buffer> } {
  const sources: SourceModel[] = [];
  const textures = new Map<string, Buffer>();
  for (const file of readdirSync(gltfDir).sort()) {
    if (!file.endsWith('.gltf')) continue;
    const gltfPath = join(gltfDir, file);
    const gltf = JSON.parse(readFileSync(gltfPath, 'utf8')) as Gltf;
    const binName = gltf.buffers[0]?.uri ?? file.replace(/\.gltf$/, '.bin');
    sources.push({
      file,
      gltf,
      gltfBytes: statSync(gltfPath).size,
      binBytes: statSync(join(gltfDir, binName)).size,
    });
  }
  for (const file of readdirSync(gltfDir).sort()) {
    if (!file.toLowerCase().endsWith('.png')) continue;
    // Last writer would win on a collision, so the id function must be injective over the pack's
    // PNGs. It is for both, and the *dropped* channel maps are what would collide if it were not:
    // `villageTextureId` strips `_Normal` as well as `_BaseColor`, so `T_Plaster_Normal.png` and
    // `T_Plaster_BaseColor.png` both answer `plaster`. That is deliberate and harmless — only the
    // base colours are ever referenced by a material, and `buildCatalogue` copies only those — but
    // it is the reason the base colour must win, so it is read last.
    const id = profile.textureId(file);
    if (/_BaseColor\.png$/i.test(file) || !textures.has(id)) textures.set(id, readFileSync(join(gltfDir, file)));
  }
  return { sources, textures };
}

function attribution(manifest: KitManifest, source: string, profile: KitProfile): string {
  const families = new Map<string, number>();
  for (const model of manifest.models) families.set(model.family, (families.get(model.family) ?? 0) + 1);
  return [
    `# ${profile.id} kit attribution`,
    '',
    'Generated by `packages/worldgen/src/modelgen.ts`. Do not edit; re-run the importer.',
    '',
    '## Source',
    '',
    profile.pack,
    'Licence: **CC0 1.0 Universal** (public domain dedication). No attribution is legally required;',
    'this note exists because `CLAUDE.md` asks every asset folder to say where its contents came from,',
    'and because a contact sheet is worthless if nobody can tell what made it.',
    '',
    `Imported from \`${source}\`. See \`assets/quaternius/PROVENANCE.md\` in the main checkout.`,
    '',
    '## What was changed on the way in',
    '',
    ...profile.changes,
    '',
    '## Contents',
    '',
    `${manifest.models.length} models, ${manifest.models.reduce((n, m) => n + m.triangles, 0)} triangles, ` +
      `${manifest.textures.length} shared textures.`,
    '',
    ...[...families]
      .sort()
      .map(([family, count]) => `- \`${family}\` x${count}`),
    '',
    '## Models',
    '',
    ...manifest.models.map(
      (model) =>
        `- \`${model.id}\` — ${model.triangles} tris, ${model.width}x${model.depth} m, ${model.height} m tall` +
        `${model.joints ? `, ${model.joints} joints` : ''}` +
        `${model.blocks ? `, blocks (r=${model.blockRadius} m)` : ''}`,
    ),
    '',
    ...(manifest.animations && manifest.animations.length > 0
      ? [
          '## Animation',
          '',
          ...manifest.animations.flatMap((library) => [
            `\`${library.id}\` — ${library.clips.length} of ${library.sourceClips} clips kept, ` +
              `${(library.bytes / 1024 / 1024).toFixed(2)} MiB from ${(library.sourceBytes / 1024 / 1024).toFixed(2)} MiB:`,
            ...library.clips.map((clip) => `- \`${clip.name}\` — ${clip.duration.toFixed(3)} s, ${clip.channels} channels`),
            '',
          ]),
        ]
      : []),
  ].join('\n');
}

/**
 * The two libraries, read from the source's `animations/` sibling and re-cut.
 *
 * A sibling directory rather than a fourth profile, because a GLB of keyframes is not a model: it has
 * no textures, no footprint, nothing `buildCatalogue` measures. Kept beside the `glTF/` the parts come
 * out of so one `--source` still names the whole import.
 */
function importAnimations(
  source: string,
): { readonly libraries: AnimationLibrary[]; readonly files: Map<string, Buffer> } {
  const dir = join(source, 'animations');
  const libraries: AnimationLibrary[] = [];
  const files = new Map<string, Buffer>();
  if (!existsSync(dir)) return { libraries, files };
  // Sorted, and the id is the key rather than the file name, so the manifest's order is a property of
  // this list and not of `readdir` — the same rule the models follow.
  for (const id of Object.keys(CHARACTER_CLIPS).sort()) {
    const file = readdirSync(dir).find((name) => name.toLowerCase().startsWith(id) && name.endsWith('.glb'));
    if (!file) continue;
    const bytes = readFileSync(join(dir, file));
    const { glb, clips, sourceClips } = buildAnimationLibrary(bytes, CHARACTER_CLIPS[id] ?? []);
    files.set(id, glb);
    libraries.push({
      id,
      url: `models/${CHARACTERS_PROFILE.id}/animations/${id}.glb`,
      bytes: glb.length,
      sourceBytes: bytes.length,
      sourceClips,
      clips,
    });
  }
  return { libraries, files };
}

function main(): void {
  const profile = process.argv.includes('--characters')
    ? CHARACTERS_PROFILE
    : process.argv.includes('--village')
      ? VILLAGE_PROFILE
      : process.argv.includes('--props')
        ? PROPS_PROFILE
        : NATURE_PROFILE;
  const outDir = join(MODELS_DIR, profile.id);
  const source = sourceDir(profile);
  const gltfDir = gltfDirOf(source);
  const dry = process.argv.includes('--dry');

  if (!gltfDir) {
    console.error(
      `no Quaternius ${profile.id} kit under ${source}.\n` +
        `The pack is git-ignored, so a worktree has none: point --source or ${profile.env} at the\n` +
        `main checkout's copy, e.g.\n` +
        `  node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts ` +
        `${profile.id === 'nature' ? '' : `--${profile.id} `}--source D:/MyGame/assets/quaternius/${profile.id}`,
    );
    process.exitCode = 1;
    return;
  }

  const { sources, textures } = readSources(gltfDir, profile);
  const built = buildCatalogue(sources, textures, profile);
  const { gltfs, textureFiles } = built;
  const { libraries, files: animationFiles } = profile.kind
    ? importAnimations(source)
    : { libraries: [] as AnimationLibrary[], files: new Map<string, Buffer>() };
  const manifest: KitManifest = libraries.length > 0 ? { ...built.manifest, animations: libraries } : built.manifest;

  const modelBytes = manifest.models.reduce((n, m) => n + m.bytes, 0);
  const textureTotal = manifest.textures.reduce((n, t) => n + t.bytes, 0);
  console.log(
    `[modelgen:${profile.id}] ${manifest.models.length} models, ` +
      `${manifest.models.reduce((n, m) => n + m.triangles, 0)} tris, ` +
      `${(modelBytes / 1024 / 1024).toFixed(1)} MiB of glTF+bin; ` +
      `${manifest.textures.length} textures, ${(textureTotal / 1024 / 1024).toFixed(1)} MiB`,
  );
  for (const texture of manifest.textures) {
    console.log(
      `  ${texture.id.padEnd(24)} ${String(texture.width).padStart(5)}x${String(texture.height).padEnd(5)} ` +
        `${(texture.bytes / 1024).toFixed(0).padStart(6)} KiB  x${texture.used}`,
    );
  }
  for (const library of libraries) {
    const seconds = library.clips.reduce((n, clip) => n + clip.duration, 0);
    console.log(
      `  ${library.id.padEnd(24)} ${String(library.clips.length).padStart(3)} of ` +
        `${String(library.sourceClips).padEnd(3)} clips, ${seconds.toFixed(1).padStart(5)} s, ` +
        `${(library.sourceBytes / 1024 / 1024).toFixed(2)} -> ${(library.bytes / 1024 / 1024).toFixed(2)} MiB ` +
        `(${(100 - (library.bytes / library.sourceBytes) * 100).toFixed(0)}% cut)`,
    );
  }
  if (dry) {
    console.log('[modelgen] --dry: nothing written');
    return;
  }

  // Cleared rather than merged: a model renamed upstream would otherwise ship for ever beside its
  // replacement, and `kit.test.ts` asserts there is nothing on disk the manifest does not list.
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, 'textures'), { recursive: true });

  for (const [id, file] of [...textureFiles].sort()) {
    copyFileSync(join(gltfDir, file), join(outDir, 'textures', `${id}.png`));
  }
  if (animationFiles.size > 0) {
    mkdirSync(join(outDir, 'animations'), { recursive: true });
    for (const [id, bytes] of [...animationFiles].sort()) {
      writeFileSync(join(outDir, 'animations', `${id}.glb`), bytes);
    }
  }
  for (const model of manifest.models) {
    const dir = join(outDir, model.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.gltf'), gltfs.get(model.id) ?? '', 'utf8');
    const original = sources.find((candidate) => kitId(candidate.file) === model.id);
    const binName = original?.gltf.buffers[0]?.uri ?? `${model.id}.bin`;
    copyFileSync(join(gltfDir, binName), join(dir, 'model.bin'));
  }
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(outDir, 'ATTRIBUTION.md'), attribution(manifest, source, profile), 'utf8');
  console.log(`[modelgen:${profile.id}] wrote ${outDir}`);
}

// Run only as a script. `modelgen.test.ts` imports the pure half above and must not trigger a write.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
