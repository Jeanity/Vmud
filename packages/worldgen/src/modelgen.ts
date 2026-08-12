/**
 * `modelgen` — the Quaternius *Stylized Nature MegaKit* import. M5b's first line, and the offline
 * half of *"build my game in a world that looks like that"*.
 *
 * ```
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --dry
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --source D:/MyGame/assets/quaternius/nature
 * GAME_NATURE_KIT=D:/MyGame/assets/quaternius/nature node ... /modelgen.ts
 * ```
 *
 * **Invoked with `node` directly and deliberately given no `package.json` script**, exactly as
 * `treegen.ts` is and for the same reason: `CLAUDE.md` gotcha 6 — npm eats unknown flags, and
 * `--source …` through a nested `npm run --workspace` never reaches this file.
 *
 * ## Where the kit is, and why that is a flag
 *
 * `assets/**` is git-ignored, so **a worktree has no `assets/` directory at all**. That is the same
 * hole `artgen.ts`/`creaturegen.ts` fell into with the LPC pack and it is answered the same way:
 * {@link SOURCE} is `--source`, else `$GAME_NATURE_KIT`, else the repo's own `assets/quaternius/nature`.
 * From a worktree, point it at the main checkout — `--source D:/MyGame/assets/quaternius/nature`.
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
const OUT_DIR = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', 'nature');

/**
 * Bumped in lockstep with `client3d/src/kit.ts`'s `KIT_MANIFEST_VERSION`. A stale import fails
 * loudly at boot rather than oddly three chunks later.
 */
export const KIT_MANIFEST_VERSION = 1;

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

interface Gltf {
  asset: { generator?: string; version: string };
  scene?: number;
  scenes?: unknown[];
  nodes?: unknown[];
  materials: GltfMaterial[];
  meshes: { name?: string; primitives: GltfPrimitive[] }[];
  textures?: { sampler?: number; source: number }[];
  images?: { mimeType?: string; name?: string; uri: string }[];
  samplers?: unknown[];
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

export function kitFamily(id: string): KitFamily | 'unknown' {
  let best: KitFamily | 'unknown' = 'unknown';
  for (const family of KIT_FAMILIES) {
    if (!id.startsWith(family)) continue;
    if (best === 'unknown' || family.length > best.length) best = family;
  }
  return best;
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
        const textureId = imageUri ? kitId(imageUri) : 'none';
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
          role: kitRole(textureId),
          texture: textureId,
          triangles: tris,
          vertices: position?.count ?? 0,
          // `alphaCutoff` defaults to 0.5 in glTF when `MASK` omits it; the kit always states 0.2.
          alphaTest: material.alphaMode === 'MASK' ? (material.alphaCutoff ?? 0.5) : 0,
          vertexColours: primitive.attributes['COLOR_0'] !== undefined,
        });
      }
    }

    const family = kitFamily(id);
    const width = round(maxX - minX);
    const depth = round(maxZ - minZ);
    const blocks = BLOCKING.has(family);
    // The *emitted* glTF's size, not the source's: this one has lost its normal-map references and
    // gained rewritten URIs, so it is a different length. `kit.test.ts` compares the manifest's
    // figure against what is on disk, which is the only version of this number worth recording.
    const text = rewriteGltf(gltf, keptImages);
    models.push({
      id,
      family,
      url: `models/nature/${id}/model.gltf`,
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
      url: `models/nature/textures/${id}.png`,
      bytes: bytes?.byteLength ?? 0,
      width: size.width,
      height: size.height,
      used: used.get(id) ?? 0,
    };
  });

  return {
    manifest: {
      version: KIT_MANIFEST_VERSION,
      generator: 'modelgen.ts from the Quaternius Stylized Nature MegaKit (CC0)',
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
function rewriteGltf(gltf: Gltf, keptImages: readonly number[]): string {
  const imageAt = new Map<number, number>();
  keptImages.forEach((source, index) => imageAt.set(source, index));

  const images = keptImages.map((source) => {
    const image = gltf.images?.[source];
    const uri = image?.uri ?? '';
    return { mimeType: 'image/png', name: image?.name ?? kitId(uri), uri: `../textures/${kitId(uri)}.png` };
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
    accessors: gltf.accessors,
    bufferViews: gltf.bufferViews,
    buffers: gltf.buffers.map((buffer) => ({ byteLength: buffer.byteLength, uri: 'model.bin' })),
  };
  return `${JSON.stringify(out, null, '\t')}\n`;
}

/* -------------------------------------------------------------------------- */
/* The CLI                                                                      */
/* -------------------------------------------------------------------------- */

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** `--source`, else `$GAME_NATURE_KIT`, else the repo's own copy. See the header on why. */
export function sourceDir(): string {
  const explicit = flag('source') ?? process.env['GAME_NATURE_KIT'];
  return explicit ? resolve(explicit) : join(REPO_ROOT, 'assets', 'quaternius', 'nature');
}

export function readSources(gltfDir: string): { sources: SourceModel[]; textures: Map<string, Buffer> } {
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
    textures.set(kitId(file), readFileSync(join(gltfDir, file)));
  }
  return { sources, textures };
}

function attribution(manifest: KitManifest, source: string): string {
  const families = new Map<string, number>();
  for (const model of manifest.models) families.set(model.family, (families.get(model.family) ?? 0) + 1);
  return [
    '# Nature kit attribution',
    '',
    'Generated by `packages/worldgen/src/modelgen.ts`. Do not edit; re-run the importer.',
    '',
    '## Source',
    '',
    '**Quaternius — Stylized Nature MegaKit**, textured glTF line, Standard tier.',
    'Licence: **CC0 1.0 Universal** (public domain dedication). No attribution is legally required;',
    'this note exists because `CLAUDE.md` asks every asset folder to say where its contents came from,',
    'and because a contact sheet is worthless if nobody can tell what made it.',
    '',
    `Imported from \`${source}\`. See \`assets/quaternius/PROVENANCE.md\` in the main checkout.`,
    '',
    '## What was changed on the way in',
    '',
    '- Normal maps dropped: nothing in `client3d` samples one (every material is a `MeshLambertMaterial`).',
    '- `images`/`textures` rebuilt and reindexed; image URIs pointed at the shared `textures/` directory.',
    '- Geometry, accessors and buffer views are the upstream bytes, unmodified.',
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
        `${model.blocks ? `, blocks (r=${model.blockRadius} m)` : ''}`,
    ),
    '',
  ].join('\n');
}

function main(): void {
  const source = sourceDir();
  const gltfDir = join(source, 'glTF');
  const dry = process.argv.includes('--dry');

  if (!existsSync(gltfDir)) {
    console.error(
      `no Quaternius nature kit at ${gltfDir}.\n` +
        `The pack is git-ignored, so a worktree has none: point --source or GAME_NATURE_KIT at the\n` +
        `main checkout's copy, e.g.\n` +
        `  node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts ` +
        `--source D:/MyGame/assets/quaternius/nature`,
    );
    process.exitCode = 1;
    return;
  }

  const { sources, textures } = readSources(gltfDir);
  const { manifest, gltfs, textureFiles } = buildCatalogue(sources, textures);

  const modelBytes = manifest.models.reduce((n, m) => n + m.bytes, 0);
  const textureTotal = manifest.textures.reduce((n, t) => n + t.bytes, 0);
  console.log(
    `[modelgen] ${manifest.models.length} models, ${manifest.models.reduce((n, m) => n + m.triangles, 0)} tris, ` +
      `${(modelBytes / 1024 / 1024).toFixed(1)} MiB of glTF+bin; ` +
      `${manifest.textures.length} textures, ${(textureTotal / 1024 / 1024).toFixed(1)} MiB`,
  );
  for (const texture of manifest.textures) {
    console.log(
      `  ${texture.id.padEnd(24)} ${String(texture.width).padStart(5)}x${String(texture.height).padEnd(5)} ` +
        `${(texture.bytes / 1024).toFixed(0).padStart(6)} KiB  x${texture.used}`,
    );
  }
  if (dry) {
    console.log('[modelgen] --dry: nothing written');
    return;
  }

  // Cleared rather than merged: a model renamed upstream would otherwise ship for ever beside its
  // replacement, and `kit.test.ts` asserts there is nothing on disk the manifest does not list.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(join(OUT_DIR, 'textures'), { recursive: true });

  for (const [id, file] of [...textureFiles].sort()) {
    copyFileSync(join(gltfDir, file), join(OUT_DIR, 'textures', `${id}.png`));
  }
  for (const model of manifest.models) {
    const dir = join(OUT_DIR, model.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'model.gltf'), gltfs.get(model.id) ?? '', 'utf8');
    const original = sources.find((candidate) => kitId(candidate.file) === model.id);
    const binName = original?.gltf.buffers[0]?.uri ?? `${model.id}.bin`;
    copyFileSync(join(gltfDir, binName), join(dir, 'model.bin'));
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUT_DIR, 'ATTRIBUTION.md'), attribution(manifest, source), 'utf8');
  console.log(`[modelgen] wrote ${OUT_DIR}`);
}

// Run only as a script. `modelgen.test.ts` imports the pure half above and must not trigger a write.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
