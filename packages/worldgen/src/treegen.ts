/**
 * `treegen` — the EZ-Tree conifer bake. §5's *"Gap 1 — conifers"*, and milestone M5's first line.
 *
 * ```
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/treegen.ts
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/treegen.ts --dry
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/treegen.ts --only pine-tall
 * ```
 *
 * **Invoked with `node` directly and deliberately given no `package.json` script**, the same reason
 * `scenedump.ts` is: `CLAUDE.md` gotcha 6, npm eats unknown flags and `--only pine-tall` through a
 * nested `npm run --workspace` never reaches this file.
 *
 * > *"No free pack advertises pine species, and pine is the defining silhouette of your reference.
 * > Close it with **EZ-Tree** (`@dgreenheck/ez-tree`, MIT) … Run it **offline in `packages/worldgen`**
 * > to bake ~6 variants x 3 LODs per biome theme … Trees become build artefacts, which is the only
 * > answer that scales to 46,500 rooms."*
 *
 * ## The bake path that works, and the two shims it needs
 *
 * EZ-Tree is a browser library and its module scope is not portable: it decodes sixteen bark and leaf
 * textures from embedded data URIs through `THREE.TextureLoader` **at import time**, and
 * `ImageLoader` reaches straight for `document.createElementNS`. A bare `import` of it under Node
 * throws `ReferenceError: document is not defined` before a single line of this file runs. Three's
 * `GLTFExporter` has the same shape of problem one layer down: its binary path merges the buffer
 * views through a `Blob` and reads it back with a `FileReader`, and Node has the first of those and
 * not the second.
 *
 * Both are answered by {@link installBrowserShims}, and the answer is deliberately the *smallest* one
 * that works rather than a DOM emulation:
 *
 * - `document.createElementNS` returns an object with `addEventListener` and a `src` setter that does
 *   nothing. The texture then never loads, which is exactly right — **we throw EZ-Tree's materials
 *   away**. The client dresses these meshes with its own pooled bark and card-foliage materials
 *   (`client3d/src/foliage.ts`), so a bark albedo baked into the GLB would be 200 KB of picture that
 *   is never sampled, and §5's *"restyle EZ-Tree output to the Quaternius palette at bake time"* is
 *   easier to obey when there is no upstream texture to fight.
 * - `FileReader.readAsArrayBuffer` is four lines over `Blob.arrayBuffer()`.
 *
 * Because the shims must be installed *before* either module's top-level code runs, both are reached
 * through `await import(...)` rather than a static import — ESM hoists static imports above every
 * statement in the file, so a static `import` of EZ-Tree would throw before {@link
 * installBrowserShims} could be called. That is the whole reason this file's imports look unusual.
 *
 * The alternative the brief allowed — driving EZ-Tree's core classes by hand and serialising with
 * `GLTFExporter` — turned out to be unnecessary: with the two shims the public `Tree` API generates
 * headless exactly as it does in a browser, and using the library's own generator keeps us on its
 * presets rather than on a reimplementation of them that would drift at the first upgrade.
 *
 * ## What comes out
 *
 * {@link VARIANTS} x {@link LODS}, as one GLB each, into `packages/client3d/public/models/trees/`,
 * beside a generated `manifest.json` and a generated `ATTRIBUTION.md`. Every GLB holds exactly two
 * meshes, named `trunk` and `canopy`, because the client draws them with two different materials and
 * two different shadow behaviours — an opaque bark Lambert and an alpha-clipped card-foliage patch —
 * and a single merged mesh would force one of those onto the other.
 *
 * **Served from `public/`, never imported.** §5's delivery note: *"Serve from `public/models/` with
 * stable runtime-fetched URLs, **not** Vite bundler imports — `.glb` isn't in Vite's default asset
 * list and the streamer wants stable paths anyway."*
 *
 * ## Two things baked in here rather than derived at runtime
 *
 * 1. **`uv1` on every canopy vertex: `(cardHash, cardHeight)`.** A canopy is a few dozen intersecting
 *    quads and both of the runtime material's hard problems are *per card* rather than per vertex —
 *    the cone tier a card belongs to, and the colour and wind phase that stop two adjacent cards
 *    being the same card twice. Deriving either from the vertex's own position puts a seam through
 *    the middle of a card; computing it once here, from the card's centroid, does not. The card
 *    grouping is a union-find over the index buffer rather than an assumption about EZ-Tree's vertex
 *    stride, so it stays correct if the generator's billboard layout ever changes.
 * 2. **The shape constants each variant's foliage shader needs** — `coneSlope`, `tiers`, `droop` —
 *    travel in the manifest. They are authored per variant here, next to the geometry parameters they
 *    describe, because a cone slope that disagreed with the tree it is bending the normals of is
 *    precisely §5's *"spherical normals will flatten it into a lit blob"* trap wearing a different hat.
 *
 * ## Size
 *
 * No Draco, no meshopt, no KTX2 — §5 names `@gltf-transform/cli` for those and M5a is allowed exactly
 * one new dependency, which EZ-Tree is. The answer instead is to not generate the polygons in the
 * first place: EZ-Tree's stock `Pine Medium` is 19,872 triangles, which is a hero asset, and a tree
 * that is 34 metres from a 30-degree camera in fog does not need one. {@link LODS} reduces branch
 * children, tube sections and leaf count while *raising* card size, so the silhouette survives the
 * cut — the thing a distant conifer is, is its silhouette.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashCell } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OUT_DIR = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', 'trees');

/* -------------------------------------------------------------------------- */
/* The shims                                                                   */
/* -------------------------------------------------------------------------- */

interface FakeElement {
  addEventListener(): void;
  removeEventListener(): void;
  src: string;
}

/**
 * The two globals EZ-Tree and `GLTFExporter` reach for. See the header for why each exists and why
 * neither is a DOM emulation.
 *
 * Installed with `??=` so a future caller that already has a real DOM (a browser-side baker, a jsdom
 * test) is left alone: a half-shim over a real `document` would be worse than no shim at all.
 */
function installBrowserShims(): void {
  const globals = globalThis as unknown as {
    document?: { createElementNS(): FakeElement };
    FileReader?: unknown;
  };
  globals.document ??= {
    createElementNS: (): FakeElement => ({
      addEventListener: () => {},
      removeEventListener: () => {},
      src: '',
    }),
  };
  globals.FileReader ??= class {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then((buffer) => {
        this.result = buffer;
        this.onloadend?.();
      });
    }
  };
}

/* -------------------------------------------------------------------------- */
/* The variants                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A tree the world can grow.
 *
 * `id` is the join key and **must match `client3d/src/prototypes.ts`'s `TREE_VARIANTS` exactly** —
 * that list is the closed set the material pool is sized from, and `assets.test.ts` asserts the two
 * agree. A variant added here and not there would bake a GLB nothing can draw; the other way round
 * would size the pool for a tree that does not exist.
 */
interface Variant {
  readonly id: string;
  /** An EZ-Tree preset name — the generator's own, not ours. `Object.keys(TreePreset)` lists them. */
  readonly preset: string;
  /** Metres, trunk base to tip. The generator's units are arbitrary; this is what we scale to. */
  readonly height: number;
  /** Overrides applied on top of the preset, as a deep patch. */
  readonly options: DeepPartial<TreeOptionsShape>;
  /**
   * Rows of branches the silhouette reads as. Not a generator parameter — EZ-Tree does not grow
   * whorls — but the number the foliage shader tiers its bent normals into, so it is authored
   * against the branch count and travels with it. See `client3d/src/foliage.ts`.
   */
  readonly tiers: number;
  /**
   * How far a tier's cards droop, 0..1. A fir droops; an aspen does not, and asking one to would put
   * a conifer's lighting on a broadleaf.
   */
  readonly droop: number;
  /** Bark and needle, as the client's own palette rather than EZ-Tree's textures. §5's restyle. */
  readonly bark: number;
  readonly needle: number;
  /** Documented in the attribution note, so a contact sheet says what each tree is for. */
  readonly note: string;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Only the parts of EZ-Tree's `TreeOptions` this file patches. The generator owns the rest. */
interface TreeOptionsShape {
  seed: number;
  bark: { tint: number; flatShading: boolean; textured: boolean };
  branch: {
    levels: number;
    angle: Record<string, number>;
    children: Record<string, number>;
    force: { direction: { x: number; y: number; z: number }; strength: number };
    gnarliness: Record<string, number>;
    length: Record<string, number>;
    radius: Record<string, number>;
    sections: Record<string, number>;
    segments: Record<string, number>;
    start: Record<string, number>;
    taper: Record<string, number>;
    twist: Record<string, number>;
  };
  leaves: {
    billboard: string;
    angle: number;
    count: number;
    start: number;
    size: number;
    sizeVariance: number;
    tint: number;
    alphaTest: number;
  };
}

/**
 * Six conifers and two bare-ish trees for the bog. §6-M5's *"~6 variants"*, and the two the brief
 * adds for swamp.
 *
 * The six conifers are not six random seeds: they differ in the three things that read at 34 metres
 * in fog — **height, taper and density** — because risk 4 is that *"the first forest looks like every
 * other forest"* and a variant set that varies only its seed is a rotation of one tree. `pine-tall`
 * and `pine-young` bracket the height range at 15 m and 5.5 m so a treeline has a skyline; `fir-dense`
 * and `fir-ragged` bracket the density so it has holes in it; `pine-crooked` leans, which is the one
 * cue that says a tree grew somewhere rather than being placed there.
 */
const VARIANTS: readonly Variant[] = [
  {
    id: 'pine-tall',
    preset: 'Pine Large',
    height: 15,
    tiers: 8,
    droop: 0.35,
    bark: 0x6b4f3a,
    needle: 0x3f7f52,
    note: 'tall narrow spruce — the skyline of a forest treeline',
    options: {
      seed: 1041,
      branch: {
        children: { 0: 26 },
        length: { 1: 9 },
        sections: { 0: 7, 1: 4 },
        segments: { 0: 6, 1: 3 },
        angle: { 1: 104 },
      },
      leaves: { count: 5, size: 4.4, sizeVariance: 0.35, start: 0.06, angle: 34 },
    },
  },
  {
    id: 'pine-broad',
    preset: 'Pine Medium',
    height: 11,
    tiers: 6,
    droop: 0.42,
    bark: 0x74573d,
    needle: 0x4c8f5a,
    note: 'shorter broad pine — the body of a treeline',
    options: {
      seed: 2207,
      branch: {
        children: { 0: 24 },
        length: { 1: 15 },
        sections: { 0: 7, 1: 4 },
        segments: { 0: 6, 1: 3 },
        angle: { 1: 118 },
      },
      leaves: { count: 5, size: 4.2, sizeVariance: 0.3, start: 0.08, angle: 40 },
    },
  },
  {
    id: 'pine-young',
    preset: 'Pine Small',
    height: 5.5,
    tiers: 5,
    droop: 0.3,
    bark: 0x7c6045,
    needle: 0x5aa565,
    note: 'sapling conifer — fills the gaps a treeline would otherwise show through',
    options: {
      seed: 3319,
      branch: {
        children: { 0: 18 },
        length: { 1: 12 },
        sections: { 0: 6, 1: 3 },
        segments: { 0: 5, 1: 3 },
        angle: { 1: 112 },
      },
      leaves: { count: 4, size: 3.4, sizeVariance: 0.3, start: 0.05, angle: 36 },
    },
  },
  {
    id: 'fir-dense',
    preset: 'Pine Medium',
    height: 12.5,
    tiers: 9,
    droop: 0.5,
    bark: 0x5e4634,
    needle: 0x357049,
    note: 'dense dark fir — the mass a clearing is walled by',
    options: {
      seed: 4231,
      branch: {
        children: { 0: 30 },
        length: { 1: 12 },
        sections: { 0: 7, 1: 4 },
        segments: { 0: 6, 1: 3 },
        angle: { 1: 100 },
        gnarliness: { 1: 0.12 },
      },
      leaves: { count: 6, size: 3.8, sizeVariance: 0.25, start: 0.05, angle: 30 },
    },
  },
  {
    id: 'fir-ragged',
    preset: 'Pine Medium',
    height: 11.5,
    tiers: 6,
    droop: 0.55,
    bark: 0x6d5239,
    needle: 0x468553,
    note: 'sparse ragged fir — the holes that stop a treeline reading as a hedge',
    options: {
      seed: 5077,
      branch: {
        children: { 0: 17 },
        length: { 1: 17 },
        sections: { 0: 7, 1: 4 },
        segments: { 0: 6, 1: 3 },
        angle: { 1: 122 },
        gnarliness: { 0: 0.12, 1: 0.22 },
      },
      leaves: { count: 5, size: 4.6, sizeVariance: 0.45, start: 0.1, angle: 46 },
    },
  },
  {
    id: 'pine-crooked',
    preset: 'Pine Small',
    height: 8.5,
    tiers: 5,
    droop: 0.45,
    bark: 0x715440,
    needle: 0x437f4e,
    note: 'windblown leaning pine — the one cue that says a tree grew here',
    options: {
      seed: 6113,
      branch: {
        children: { 0: 19 },
        length: { 1: 8 },
        sections: { 0: 8, 1: 4 },
        segments: { 0: 6, 1: 3 },
        angle: { 1: 102 },
        gnarliness: { 0: 0.22, 1: 0.16 },
        // A lean, not a collapse. At 0.03 the crown ended up 7.6 m off the bole, which is a tree
        // lying down; 0.011 puts it about a metre and a half out, which is a tree in the wind.
        force: { direction: { x: 0.55, y: 0.82, z: 0.16 }, strength: 0.011 },
      },
      leaves: { count: 5, size: 4, sizeVariance: 0.4, start: 0.08, angle: 44 },
    },
  },
  {
    id: 'aspen-thin',
    preset: 'Aspen Medium',
    height: 10,
    // A broadleaf is not tiered and must not be lit as if it were — one tier is the shader's way of
    // saying "no tiers", and `droop` near zero leaves the cone shell doing all the bending.
    tiers: 1,
    droop: 0.08,
    bark: 0x9c9581,
    needle: 0x8ab24e,
    note: 'thin aspen — the bog and the fen, where a conifer would be wrong',
    options: {
      seed: 7229,
      branch: {
        children: { 0: 7, 1: 3 },
        sections: { 0: 6, 1: 4, 2: 3 },
        segments: { 0: 5, 1: 3, 2: 3 },
      },
      leaves: { count: 7, size: 3.6, sizeVariance: 0.4, start: 0.3, angle: 52 },
    },
  },
  {
    id: 'snag-bare',
    preset: 'Aspen Small',
    height: 7,
    tiers: 1,
    droop: 0,
    bark: 0x8f8674,
    needle: 0x7f7a60,
    // Every variant carries both meshes on purpose, even this one: a `canopy` that some variants have
    // and others do not would make "which buckets can a chunk want" depend on which trees a room
    // happened to roll, and `pool.ts`'s ceiling is only a *bound* if that answer is a constant.
    note: 'dead bare snag — a handful of grey cards, deliberately not an empty canopy',
    options: {
      seed: 8317,
      branch: {
        children: { 0: 5, 1: 2 },
        length: { 1: 9, 2: 5 },
        sections: { 0: 6, 1: 4, 2: 3 },
        segments: { 0: 5, 1: 3, 2: 3 },
        gnarliness: { 0: 0.18, 1: 0.2 },
      },
      leaves: { count: 2, size: 2.6, sizeVariance: 0.5, start: 0.45, angle: 60 },
    },
  },
];

/* -------------------------------------------------------------------------- */
/* The LOD ladder                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Three levels of detail, and the distance in metres at which each takes over.
 *
 * The distances are read off the frame rather than chosen. The camera sees ground between 33 m and
 * 43 m (`night.ts`'s fog derivation) and the streaming window's outermost built chunk is 38.5 m from
 * the centre cell, so the *whole* usable range is about ten metres wide in screen terms and a tree
 * beyond ~26 m is already two thirds fogged. LOD1 therefore takes over at the second ring of chunks
 * and LOD2 at the third, which is where a tree is a shape and not a tree.
 *
 * The reductions raise `leafScale` as they cut `leaves`, which is the whole trick: fewer, bigger cards
 * hold the silhouette while the triangle count falls, and a conifer at 30 metres *is* its silhouette.
 */
interface Lod {
  readonly lod: number;
  /** Metres from the camera at which this level starts. LOD0 always starts at zero. */
  readonly distance: number;
  readonly children: number;
  readonly leaves: number;
  readonly leafScale: number;
  readonly sections: number;
  readonly segments: number;
}

const LODS: readonly Lod[] = [
  { lod: 0, distance: 0, children: 1, leaves: 1, leafScale: 1, sections: 1, segments: 1 },
  { lod: 1, distance: 14, children: 0.6, leaves: 0.55, leafScale: 1.35, sections: 0.65, segments: 0.75 },
  { lod: 2, distance: 26, children: 0.34, leaves: 0.32, leafScale: 1.95, sections: 0.45, segments: 0.6 },
];

/* -------------------------------------------------------------------------- */
/* The manifest                                                                */
/* -------------------------------------------------------------------------- */

/** One baked level of detail. `path` is the runtime URL, not a disk path — see the delivery note. */
export interface TreeLodEntry {
  readonly lod: number;
  readonly path: string;
  readonly bytes: number;
  readonly distance: number;
  readonly triangles: number;
  readonly vertices: number;
}

/**
 * The crown, in the model's own metres — the axis and the band the foliage shader works in.
 *
 * Not derivable from `height` and `radius`: a leaning tree's crown is off the bole, and the cards
 * start well above the ground on every variant. Read at LOD0 and applied to all three, because a
 * variant's three levels are the same tree and the shader's uniforms are per variant.
 */
export interface TreeCanopy {
  /** Metres east/south of the trunk's foot. The cone's axis. */
  readonly cx: number;
  readonly cz: number;
  /** Metres above the foot: the lowest and highest card. `uv1.y` is normalised across this band. */
  readonly base: number;
  readonly top: number;
}

/** One tree, at every level of detail, with the constants its shader needs. */
export interface TreeManifestEntry {
  readonly id: string;
  readonly note: string;
  /** Metres, trunk base to tip, after scaling. */
  readonly height: number;
  /** Metres, the canopy's half-width at its widest. The scatter's spacing and the cone's base. */
  readonly radius: number;
  /** Metres. What a stump is as wide as, and how far a trunk may lean into a mouth before it blocks it. */
  readonly trunkRadius: number;
  readonly canopy: TreeCanopy;
  /** `(canopy.top - canopy.base) / radius`. The cone shell the foliage shader bends its normals onto. */
  readonly coneSlope: number;
  readonly tiers: number;
  readonly droop: number;
  readonly bark: number;
  readonly needle: number;
  readonly lods: readonly TreeLodEntry[];
}

export interface TreeManifest {
  /** Bumped when the *shape* of this file changes, so a stale bake fails loudly rather than oddly. */
  readonly version: number;
  readonly generator: string;
  readonly trees: readonly TreeManifestEntry[];
}

export const TREE_MANIFEST_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Geometry helpers — pure, and the reason the bake is reproducible            */
/* -------------------------------------------------------------------------- */

/**
 * Which vertices belong to the same card, by walking the index buffer.
 *
 * A union-find rather than *"EZ-Tree emits four vertices per quad"*, which is true today and is an
 * assumption about somebody else's generator. Returns one group id per vertex.
 */
export function cardGroups(indices: ArrayLike<number>, vertexCount: number): Int32Array {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (a: number): number => {
    let root = a;
    while (parent[root] !== root) root = parent[root]!;
    let walk = a;
    while (parent[walk] !== root) {
      const next = parent[walk]!;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = find(indices[i]!);
    const b = find(indices[i + 1]!);
    const c = find(indices[i + 2]!);
    const root = Math.min(a, b, c);
    parent[a] = root;
    parent[b] = root;
    parent[c] = root;
  }
  const out = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) out[i] = find(i);
  return out;
}

/** `hashCell` mapped onto `[0, 1)`. The same divisor `noise.ts` and `rain.ts` use. */
const HASH_RANGE = 0x1_0000_0000;

/**
 * `(cardHash, cardHeight)` per vertex — the canopy's `uv1`.
 *
 * The hash is `hashCell` over the card's centroid in centimetres, so it is the project's own
 * determinism contract rather than a fourth positional hash, and it is stable under a re-bake because
 * the centroid is.
 */
export function cardAttributes(
  positions: ArrayLike<number>,
  groups: Int32Array,
  minY: number,
  height: number,
): Float32Array {
  const count = groups.length;
  const sums = new Map<number, { x: number; y: number; z: number; n: number }>();
  for (let i = 0; i < count; i++) {
    const group = groups[i]!;
    const held = sums.get(group);
    const x = positions[i * 3]!;
    const y = positions[i * 3 + 1]!;
    const z = positions[i * 3 + 2]!;
    if (held) {
      held.x += x;
      held.y += y;
      held.z += z;
      held.n += 1;
    } else {
      sums.set(group, { x, y, z, n: 1 });
    }
  }
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const centre = sums.get(groups[i]!)!;
    const cx = centre.x / centre.n;
    const cy = centre.y / centre.n;
    const cz = centre.z / centre.n;
    out[i * 2] = hashCell(Math.round(cx * 100), Math.round(cz * 100), Math.round(cy * 100), 0x7e33) / HASH_RANGE;
    out[i * 2 + 1] = height > 0 ? Math.min(1, Math.max(0, (cy - minY) / height)) : 0;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The bake                                                                    */
/* -------------------------------------------------------------------------- */

function patch(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const held = target[key];
    if (value !== null && typeof value === 'object' && held !== null && typeof held === 'object') {
      patch(held as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

/** Scale a level's integer parameter, never below one — a branch with no sections is not a branch. */
function reduce(value: number, factor: number, floor = 1): number {
  return Math.max(floor, Math.round(value * factor));
}

async function main(): Promise<void> {
  installBrowserShims();

  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? args[onlyAt + 1] : undefined;

  const THREE = await import('three');
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const ez = await import('@dgreenheck/ez-tree');

  const wanted = VARIANTS.filter((v) => only === undefined || v.id === only);
  if (wanted.length === 0) throw new Error(`no variant named ${String(only)}`);

  if (!dry) {
    mkdirSync(OUT_DIR, { recursive: true });
    // A stale GLB from a renamed variant would sit in `public/` for ever and ship. Only this bake's
    // own artefacts live here, so clearing them is safe and is the only way the directory stays a
    // function of this file.
    for (const entry of readdirSync(OUT_DIR)) {
      if (entry.endsWith('.glb') || entry === 'manifest.json' || entry === 'ATTRIBUTION.md') {
        rmSync(join(OUT_DIR, entry));
      }
    }
  }

  const trees: TreeManifestEntry[] = [];
  let totalBytes = 0;
  let totalTriangles = 0;

  for (const variant of wanted) {
    const lods: TreeLodEntry[] = [];
    let height = variant.height;
    let radius = 0;
    let trunkRadius = 0;
    let canopy: TreeCanopy = { cx: 0, cz: 0, base: 0, top: variant.height };

    for (const level of LODS) {
      const tree = new ez.Tree();
      tree.loadPreset(variant.preset);
      const options = tree.options as unknown as Record<string, unknown>;
      patch(options, variant.options as Record<string, unknown>);

      const branch = (options['branch'] as TreeOptionsShape['branch']);
      const leaves = (options['leaves'] as TreeOptionsShape['leaves']);
      for (const key of Object.keys(branch.children)) {
        branch.children[key] = reduce(branch.children[key]!, level.children);
      }
      for (const key of Object.keys(branch.sections)) {
        branch.sections[key] = reduce(branch.sections[key]!, level.sections, 3);
      }
      for (const key of Object.keys(branch.segments)) {
        branch.segments[key] = reduce(branch.segments[key]!, level.segments, 3);
      }
      leaves.count = reduce(leaves.count, level.leaves);
      leaves.size *= level.leafScale;
      // The generator's own materials are discarded at the end of this loop, but flat shading changes
      // the *geometry* it emits (split vertices), so it is switched off here rather than there.
      (options['bark'] as TreeOptionsShape['bark']).flatShading = false;

      tree.generate();

      const trunkGeometry = tree.branchesMesh.geometry.clone();
      const canopyGeometry = tree.leavesMesh.geometry.clone();
      // The generator leaves a normal and a uv on the branches and nothing else useful; anything it
      // did add would be exported and never read.
      for (const geometry of [trunkGeometry, canopyGeometry]) {
        for (const name of Object.keys(geometry.attributes)) {
          if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
        }
      }

      trunkGeometry.computeBoundingBox();
      const raw = trunkGeometry.boundingBox!;
      const rawHeight = raw.max.y - raw.min.y;
      const scale = rawHeight > 0 ? variant.height / rawHeight : 1;

      // Trunk base at the origin, canopy centred over it: the scatter places a tree by its foot, and
      // a model whose foot is not at `y = 0` sinks or floats by however far the generator's own
      // bounding box happened to start.
      const matrix = new THREE.Matrix4()
        .makeTranslation(0, -raw.min.y, 0)
        .premultiply(new THREE.Matrix4().makeScale(scale, scale, scale));
      trunkGeometry.applyMatrix4(matrix);
      canopyGeometry.applyMatrix4(matrix);
      trunkGeometry.computeBoundingBox();
      canopyGeometry.computeBoundingBox();

      const canopyBox = canopyGeometry.boundingBox!;
      const trunkBox = trunkGeometry.boundingBox!;
      const levelHeight = Math.max(trunkBox.max.y, canopyBox.max.y);
      /**
       * **The crown's own axis, not the trunk's.** `pine-crooked` leans a metre and a half, so the
       * cone the foliage shader bends its normals onto is not centred on the bole — measuring the
       * radius from the origin gave it 6.4 m and a cone slope of 1.5, which is the lighting of a
       * bush. Every variant's crown is at least slightly off-axis; taking the centre from the canopy
       * makes the correction general rather than a special case for the one tree that showed it.
       */
      const crown = {
        cx: (canopyBox.min.x + canopyBox.max.x) / 2,
        cz: (canopyBox.min.z + canopyBox.max.z) / 2,
        base: canopyBox.min.y,
        top: canopyBox.max.y,
      };
      const crownRadius = Math.max(
        (canopyBox.max.x - canopyBox.min.x) / 2,
        (canopyBox.max.z - canopyBox.min.z) / 2,
      );

      // `uv1` — the card hash and the card's height **within the canopy band**, so `uv1.y` runs 0 at
      // the lowest card and 1 at the tip whatever the trunk under it is doing. That is what makes
      // `tiers` mean the same thing on a 16 m spruce and a 5.7 m sapling.
      const canopyPositions = canopyGeometry.attributes['position']!.array as ArrayLike<number>;
      const canopyCount = canopyGeometry.attributes['position']!.count;
      const groups = cardGroups(canopyGeometry.index!.array, canopyCount);
      const cards = cardAttributes(canopyPositions, groups, crown.base, crown.top - crown.base);
      canopyGeometry.setAttribute('uv1', new THREE.BufferAttribute(cards, 2));

      if (level.lod === 0) {
        height = levelHeight;
        radius = crownRadius;
        canopy = { cx: round(crown.cx), cz: round(crown.cz), base: round(crown.base), top: round(crown.top) };
        // The trunk's own footprint, read at its base rather than over the whole tree — the upper
        // branches are wider than the bole and a stump is as wide as the bole.
        trunkRadius = trunkRadiusOf(trunkGeometry.attributes['position']!.array as ArrayLike<number>);
      }

      const group = new THREE.Group();
      group.name = `${variant.id}-lod${level.lod}`;
      const trunkMesh = new THREE.Mesh(trunkGeometry, new THREE.MeshStandardMaterial({ name: 'bark' }));
      trunkMesh.name = 'trunk';
      const canopyMesh = new THREE.Mesh(canopyGeometry, new THREE.MeshStandardMaterial({ name: 'needle' }));
      canopyMesh.name = 'canopy';
      group.add(trunkMesh, canopyMesh);

      const triangles = ((trunkGeometry.index?.count ?? 0) + (canopyGeometry.index?.count ?? 0)) / 3;
      const vertices = trunkGeometry.attributes['position']!.count + canopyCount;
      const file = `${variant.id}-lod${level.lod}.glb`;
      let bytes = 0;
      if (!dry) {
        const glb = (await new GLTFExporter().parseAsync(group, {
          binary: true,
          onlyVisible: false,
        })) as ArrayBuffer;
        writeFileSync(join(OUT_DIR, file), Buffer.from(glb));
        bytes = statSync(join(OUT_DIR, file)).size;
      }
      totalBytes += bytes;
      totalTriangles += triangles;
      lods.push({ lod: level.lod, path: `models/trees/${file}`, bytes, distance: level.distance, triangles, vertices });
      console.log(
        `  ${variant.id} lod${level.lod}  ${String(triangles).padStart(6)} tris  ` +
          `${String(vertices).padStart(6)} verts  ${String(bytes).padStart(8)} B`,
      );
    }

    trees.push({
      id: variant.id,
      note: variant.note,
      height: round(height),
      radius: round(radius),
      trunkRadius: round(trunkRadius),
      canopy,
      coneSlope: round(radius > 0 ? (canopy.top - canopy.base) / radius : 4),
      tiers: variant.tiers,
      droop: variant.droop,
      bark: variant.bark,
      needle: variant.needle,
      lods,
    });
  }

  const manifest: TreeManifest = {
    version: TREE_MANIFEST_VERSION,
    generator: '@dgreenheck/ez-tree via packages/worldgen/src/treegen.ts',
    trees,
  };

  console.log(
    `\n[treegen] ${trees.length} variants x ${LODS.length} LODs = ${trees.length * LODS.length} GLBs, ` +
      `${totalTriangles} triangles, ${(totalBytes / 1024).toFixed(1)} KiB total`,
  );

  if (dry) {
    console.log('[treegen] --dry: nothing written');
    return;
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'ATTRIBUTION.md'), attribution(trees));
  console.log(`[treegen] wrote ${OUT_DIR}`);
}

/** Metres, to the centimetre. A manifest that is legible diffs when a variant is retuned. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The bole's radius, from the widest vertex in the bottom tenth of the trunk mesh. */
function trunkRadiusOf(positions: ArrayLike<number>): number {
  let top = 0;
  for (let i = 1; i < positions.length; i += 3) top = Math.max(top, positions[i]!);
  const band = top * 0.1;
  let radius = 0;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i + 1]! > band) continue;
    radius = Math.max(radius, Math.hypot(positions[i]!, positions[i + 2]!));
  }
  return radius;
}

/**
 * The attribution note, generated with the bake it describes.
 *
 * `CLAUDE.md`'s art rule is that *"every asset folder keeps its upstream `LICENSE` and `AUTHORS`
 * file"*, and this folder's honest answer is unusual enough to be worth writing down every time:
 * nothing upstream is *in* these files. The geometry is generated by an MIT tool from parameters in
 * this repository, EZ-Tree's own bark and leaf textures are never loaded (see the header's shim note)
 * and never exported, and the materials are the client's. MIT asks for the notice regardless, and it
 * is here.
 */
function attribution(trees: readonly TreeManifestEntry[]): string {
  const rows = trees
    .map((tree) => `| \`${tree.id}\` | ${tree.height} m | ${tree.tiers} | ${tree.note} |`)
    .join('\n');
  return `# Trees — generated, not sourced

Every \`.glb\` in this directory is **generated** by
\`packages/worldgen/src/treegen.ts\` from parameters held in that file. Re-create the whole set with:

\`\`\`
node --disable-warning=ExperimentalWarning packages/worldgen/src/treegen.ts
\`\`\`

## Upstream

- **EZ-Tree** (\`@dgreenheck/ez-tree\`), Copyright (c) Dan Greenheck — **MIT**. The procedural
  generator. Its own bark and leaf textures are **not** loaded and **not** redistributed here: the
  bake runs headless with a stub image loader (see \`treegen.ts\`'s header) and the client dresses
  these meshes with its own materials.
- **three.js**, Copyright (c) three.js authors — **MIT**. \`GLTFExporter\` writes the GLB.

No CC-BY-SA or GPL asset is involved, and nothing in this directory carries a share-alike obligation.

## What is here

| Variant | Height | Tiers | Role |
|---|---|---|---|
${rows}

Each variant is baked at three levels of detail; \`manifest.json\` carries the byte sizes, the
triangle counts and the metres at which each level takes over.
`;
}

await main();
