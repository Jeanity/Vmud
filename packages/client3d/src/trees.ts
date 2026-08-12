/**
 * The tree registry: where a species' meshes and its shader constants live, and the one place the
 * pool learns what a pine is.
 *
 * §5's delivery rule, quoted where it is obeyed: *"Serve from `packages/client/public/models/` with
 * stable runtime-fetched URLs, **not** Vite bundler imports — `.glb`/`.ktx2` aren't in Vite's default
 * asset list and the streamer wants stable paths anyway."* So nothing in this package `import`s a
 * model. {@link TreeSet.load} fetches a manifest at boot, fetches the GLBs it lists, and hands their
 * geometries to `ScenePool.registerGeometry` under the keys `prototypes.ts` already enumerated.
 *
 * ## This is a registry, not a treegen client
 *
 * M5a's trees come from `packages/worldgen/src/treegen.ts`; **M5b's come from the Quaternius
 * Stylized Nature MegaKit**, which is the owner's chosen art direction and which nothing downstream
 * of here should be able to tell apart. The seam is deliberately narrow and is worth naming so it
 * stays that way:
 *
 * - {@link ScenePool.registerGeometry} takes a `BufferGeometry` under a `(variant, part, lod)` key
 *   and does not care what produced it.
 * - {@link TreeEntry} carries the shader constants — the crown's axis, band, cone slope, tiers and
 *   droop — measured off whatever mesh arrived. A kit importer measures the same five numbers off the
 *   kit's mesh and the foliage material never knows the difference.
 * - {@link TreeSet.load} **merges**. Called twice with two manifests, the set holds both, and
 *   `prototypes.TREE_SOURCE` is what says which producer owes which id.
 *
 * The only thing that is genuinely M5a-shaped is the `uv1` rename below, and it degrades to a
 * documented no-op for a mesh that never had one.
 *
 * ## Why this does not break the bounded pool
 *
 * `prototypes.ts`'s whole argument is that the key set is *"a fact about the program, not a habit the
 * streamer keeps"*, and geometry arriving over the network at run time looks like exactly the habit it
 * forbids. It is not, and the difference is worth being exact about:
 *
 * - The **keys** are a closed product of three closed lists (`TREE_VARIANTS` x `TREE_PARTS` x
 *   `TREE_LODS` = 48), enumerated at module load, and `assets.test.ts` asserts that the treegen
 *   manifest lists exactly the `baked` subset of them. Nothing the network says can add one, whichever
 *   producer sent it.
 * - The load happens **once, at boot**, not per chunk and not per zone. After it, the geometry pool is
 *   a constant for the session, exactly as it was at M4 — the traversal test's *"the geometry pool
 *   grew"* assertion is untouched.
 * - A key that never arrives simply has no geometry, and `world3d.ts` drops any placement whose
 *   geometry the pool cannot resolve. That is the correct behaviour in the second between the first
 *   `zone` message and the last GLB, and the correct behaviour for ever if somebody ships without
 *   running the baker. The world renders; it has no trees.
 *
 * ## What the manifest is for besides paths
 *
 * Every foliage uniform that varies per species. `treegen.ts` measures the crown off the mesh it just
 * generated — its axis, its band, its cone slope — and this file writes those onto the pooled canopy
 * material for that variant. That is the mechanism behind §5's trap 2: the cone the normals are bent
 * onto is the cone the geometry actually is, rather than a constant somebody typed. A leaning pine's
 * crown sits 1.8 m off its bole and its shader knows.
 *
 * ## `uv1` becomes `aCard`
 *
 * `GLTFLoader` names `TEXCOORD_1` `uv1`, which is three's own second UV channel and would be claimed
 * by any material with a second-channel map. The attribute is not a UV — it is `(cardHash, cardHeight)`
 * from `treegen.ts` — so it is renamed on load to the name `foliage.ts` declares. One line, and it
 * keeps the foliage patch from fighting three over an attribute slot.
 */

import type { BufferGeometry, Mesh, Object3D } from 'three';
import { BoxGeometry, BufferAttribute, ConeGeometry } from 'three';

import type { ScenePool } from './pool.ts';
import {
  TREE_LODS,
  TREE_PARTS,
  TREE_VARIANTS,
  treeGeometryKey,
  treeMaterialKey,
  type TreePart,
  type TreeVariant,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The manifest, as the client reads it                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `worldgen/src/treegen.ts`'s own interfaces. Restated because the two packages do not import. */
export interface TreeLodEntry {
  readonly lod: number;
  readonly path: string;
  readonly bytes: number;
  readonly distance: number;
  readonly triangles: number;
  readonly vertices: number;
}

export interface TreeCanopyBand {
  readonly cx: number;
  readonly cz: number;
  readonly base: number;
  readonly top: number;
}

export interface TreeEntry {
  readonly id: string;
  readonly note: string;
  readonly height: number;
  readonly radius: number;
  readonly trunkRadius: number;
  readonly canopy: TreeCanopyBand;
  readonly coneSlope: number;
  readonly tiers: number;
  readonly droop: number;
  readonly bark: number;
  readonly needle: number;
  readonly lods: readonly TreeLodEntry[];
}

export interface TreeManifest {
  readonly version: number;
  readonly generator: string;
  readonly trees: readonly TreeEntry[];
}

/** Bumped in lockstep with `treegen.ts`. A stale bake fails loudly here rather than oddly later. */
export const TREE_MANIFEST_VERSION = 1;

/** The one path this package knows. Relative, so a base-pathed deployment still resolves it. */
export const TREE_MANIFEST_PATH = 'models/trees/manifest.json';

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the renderer knows about trees: the manifest, and whether the geometry has arrived.
 *
 * Holds no geometry itself — that lives in the pool, where every other geometry in this renderer
 * lives. This is the index and the loader.
 */
export class TreeSet {
  /** Variants whose meshes are all registered. `__debug3d.treesLoaded`. */
  private readonly ready = new Set<TreeVariant>();
  private readonly entries = new Map<TreeVariant, TreeEntry>();
  /** Metres at which each LOD takes over, ascending, from the manifest. Empty until it loads. */
  private distances: readonly number[] = [];

  get loaded(): number {
    return this.ready.size;
  }

  entry(variant: TreeVariant): TreeEntry | undefined {
    return this.entries.get(variant);
  }

  /** Triangles at LOD0 across the whole set — the honest cost of one fully detailed room of trees. */
  get triangles(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.lods[0]?.triangles ?? 0;
    return total;
  }

  /**
   * Which level of detail a chunk that far from the camera draws.
   *
   * Read off the manifest rather than written here, so retuning the ladder is a re-bake and not a
   * client change. Before the manifest loads there is nothing to draw, so the answer does not matter
   * and is 0.
   */
  lodFor(metres: number): number {
    let chosen = 0;
    for (let i = 0; i < this.distances.length; i++) {
      if (metres >= this.distances[i]!) chosen = i;
    }
    return chosen;
  }

  /** True once at least one variant can be drawn. `world3d.ts` gates the scatter on it. */
  get available(): boolean {
    return this.ready.size > 0;
  }

  /**
   * Fetch a manifest and every GLB it lists, and register what comes back.
   *
   * **Merges into whatever is already registered**, so a second producer's manifest — M5b's kit — is
   * a second call rather than a second class. `manifestPath` is a parameter for the same reason.
   *
   * Resolves when that manifest's set is in, and **never rejects**: a missing manifest is a world
   * without those trees, which is M4's world, and a renderer that refused to boot because a build
   * artefact was absent would be a worse failure than the one it was reporting. What it does instead
   * is return the reason, so `main.ts` can put it in the log where somebody will see it.
   */
  async load(pool: ScenePool, base = './', manifestPath = TREE_MANIFEST_PATH): Promise<string | undefined> {
    let manifest: TreeManifest;
    try {
      const response = await fetch(`${base}${manifestPath}`);
      if (!response.ok) return `tree manifest: HTTP ${response.status}`;
      manifest = (await response.json()) as TreeManifest;
    } catch (error) {
      return `tree manifest: ${String(error)}`;
    }
    if (manifest.version !== TREE_MANIFEST_VERSION) {
      return `tree manifest is version ${manifest.version}, this client reads ${TREE_MANIFEST_VERSION} — re-run treegen`;
    }

    const known = new Set<string>(TREE_VARIANTS);
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();

    const jobs: Promise<void>[] = [];
    for (const tree of manifest.trees) {
      if (!known.has(tree.id)) continue;
      const variant = tree.id as TreeVariant;
      this.entries.set(variant, tree);
      if (this.distances.length === 0) this.distances = tree.lods.map((lod) => lod.distance);
      for (const lod of tree.lods) {
        jobs.push(
          loader
            .loadAsync(`${base}${lod.path}`)
            .then((gltf) => {
              registerParts(pool, variant, lod.lod, gltf.scene);
            })
            .catch(() => {
              // One tree that will not load is one tree that is not drawn. Swallowed per GLB rather
              // than per set, so a single corrupt file does not take the forest with it.
            }),
        );
      }
    }
    await Promise.all(jobs);

    for (const [variant, entry] of this.entries) {
      if (!complete(pool, variant)) continue;
      this.ready.add(variant);
      applyLook(pool, variant, entry);
    }
    return this.ready.size > 0 ? undefined : 'tree manifest loaded but no geometry arrived';
  }

  /**
   * Fill the pool with proportioned stand-ins instead of the bake — **the headless path**.
   *
   * `traversal.test.ts` has to exercise the scatter, because a flat ledger over a thousand rooms is
   * only worth asserting if the thing that grew the most instances was actually running. It has no
   * network, no GPU and no `GLTFLoader`, so it cannot have the real meshes; without this it would
   * measure a world with no trees in it and report success.
   *
   * The shapes are a thin box and a cone at the manifest's own proportions rather than a placeholder
   * cube, so the geometry the pool holds has roughly the vertex count and exactly the metre extents
   * the real thing does. That makes it useful for a second thing too: run the client with the bake
   * deleted and the placement is still there to look at, in grey, which is how you tell a scatter bug
   * from a shader bug.
   */
  standIn(pool: ScenePool): void {
    for (const variant of TREE_VARIANTS) {
      const entry = STAND_IN[TREE_VARIANTS.indexOf(variant) % STAND_IN.length]!;
      this.entries.set(variant, { ...entry, id: variant });
      for (const lod of TREE_LODS) {
        const trunk = new BoxGeometry(entry.trunkRadius * 2, entry.height, entry.trunkRadius * 2);
        trunk.translate(0, entry.height / 2, 0);
        pool.registerGeometry(treeGeometryKey(variant, 'trunk', lod), trunk);
        const canopy = new ConeGeometry(entry.radius, entry.canopy.top - entry.canopy.base, 6 - lod);
        canopy.translate(0, (entry.canopy.top + entry.canopy.base) / 2, 0);
        canopy.setAttribute(
          'aCard',
          new BufferAttribute(new Float32Array(canopy.getAttribute('position').count * 2), 2),
        );
        pool.registerGeometry(treeGeometryKey(variant, 'canopy', lod), canopy);
      }
      this.ready.add(variant);
      applyLook(pool, variant, this.entries.get(variant)!);
    }
    if (this.distances.length === 0) this.distances = STAND_IN_DISTANCES;
  }
}

/** The LOD ladder `treegen.ts` bakes, restated for {@link TreeSet.standIn}. Metres. */
const STAND_IN_DISTANCES: readonly number[] = [0, 14, 26];

/**
 * Two proportions — a tall narrow conifer and a shorter broad one — for the headless stand-in.
 *
 * Real numbers off the real bake rather than round ones, so a test that measures anything about a
 * tree measures something the shipped world would also say.
 */
const STAND_IN: readonly TreeEntry[] = [
  {
    id: '',
    note: 'stand-in',
    height: 15.98,
    radius: 2.12,
    trunkRadius: 0.29,
    canopy: { cx: 0, cz: 0, base: 4.13, top: 15.98 },
    coneSlope: 5.6,
    tiers: 8,
    droop: 0.35,
    bark: 0x6b4f3a,
    needle: 0x3f7f52,
    lods: [],
  },
  {
    id: '',
    note: 'stand-in',
    height: 11.05,
    radius: 2.35,
    trunkRadius: 0.23,
    canopy: { cx: 0, cz: 0, base: 1.04, top: 11.05 },
    coneSlope: 4.26,
    tiers: 6,
    droop: 0.42,
    bark: 0x74573d,
    needle: 0x4c8f5a,
    lods: [],
  },
];

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/** Pull the two named meshes out of a loaded GLB and put their geometry in the pool. */
function registerParts(pool: ScenePool, variant: TreeVariant, lod: number, scene: Object3D): void {
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const part = TREE_PARTS.find((candidate) => candidate === mesh.name);
    if (!part) return;
    pool.registerGeometry(treeGeometryKey(variant, part, lod), prepare(mesh.geometry, part));
  });
}

/**
 * Rename `uv1` and make sure `aCard` exists.
 *
 * A trunk has no cards and needs none — but it is drawn by an ordinary Lambert that never declares
 * the attribute, so nothing is added to it. Only the canopy is patched, and only the canopy's
 * attribute is renamed.
 */
function prepare(geometry: BufferGeometry, part: TreePart): BufferGeometry {
  if (part !== 'canopy') return geometry;
  const cards = geometry.getAttribute('uv1');
  if (cards) {
    geometry.deleteAttribute('uv1');
    geometry.setAttribute('aCard', cards);
  } else if (!geometry.getAttribute('aCard')) {
    // A canopy baked before `uv1` existed: every card in the same tier with no jitter. Ugly rather
    // than broken, and the manifest version check above is what is meant to catch it first.
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute('aCard', new BufferAttribute(new Float32Array(count * 2), 2));
  }
  return geometry;
}

function complete(pool: ScenePool, variant: TreeVariant): boolean {
  for (const part of TREE_PARTS) {
    for (const lod of TREE_LODS) {
      if (!pool.hasGeometry(treeGeometryKey(variant, part, lod))) return false;
    }
  }
  return true;
}

/**
 * Write one variant's look onto its two pooled materials.
 *
 * The bark is a colour and nothing else. The canopy is a colour **and the five shape constants the
 * bent-normal recipe needs** — see `foliage.ts`'s trap 2 for why the cone has to be the tree's own
 * cone and not a house default.
 */
function applyLook(pool: ScenePool, variant: TreeVariant, entry: TreeEntry): void {
  // `recolour` rather than `material(...).color.setHex`, because the fog-of-war tint is a ratio
  // computed from the base colour and has to be recomputed with it. See `ScenePool.recolour`.
  pool.recolour(treeMaterialKey('trunk', variant), entry.bark);
  pool.recolour(treeMaterialKey('canopy', variant), entry.needle);
  const uniforms = pool.foliage(treeMaterialKey('canopy', variant));
  if (!uniforms) return;
  uniforms.uTreeHeight.value = entry.height;
  uniforms.uCanopyAxis.value.set(entry.canopy.cx, entry.canopy.cz);
  uniforms.uConeSlope.value = entry.coneSlope;
  uniforms.uTiers.value = entry.tiers;
  uniforms.uDroop.value = entry.droop;
}
