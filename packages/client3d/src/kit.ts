/**
 * The kit registry — where the Quaternius *Stylized Nature MegaKit* becomes pooled geometry, and the
 * one place this renderer knows the kit exists at all.
 *
 * `trees.ts`'s sibling, deliberately: the same contract, the same three facts, the same
 * never-rejects loader. What differs is that a kit model is not always a tree, so this file feeds
 * **two** registries — the tree keys `prototypes.treeGeometryKey` already enumerated, for the twenty
 * models that are trees, and `prototypes.kitGeometryKey` for the forty-three that are props.
 * Downstream of here nothing can tell the two apart, and nothing downstream of `world3d.ts` can tell
 * a kit tree from an ez-tree.
 *
 * ## Loaded once, at boot — and the brief's "per streaming ring" is the deviation
 *
 * The brief asks for *"load on demand per streaming ring"*. **This loads the whole kit once, at
 * boot**, and the reason is the acceptance criterion sitting next to that sentence: *"the allocation
 * ledger must read the SAME byte total at room 100 and room 1,000"*. Registering geometry per ring
 * means the geometry pool grows while the player walks, which is precisely what `traversal.test.ts`
 * asserts does not happen and what `pool.ts`'s header calls *"the habit it forbids"*. What streams is
 * **instances**, exactly as baked trees do — a chunk acquires wrappers on load and gives them back on
 * unload, and a room in the far east of the world costs nothing until you walk to it.
 *
 * The honest cost of the deviation is a slower first paint on a cold cache. It is mitigated the way
 * `main.ts` mitigates the tree bake: the promise is **not awaited**, chunks built before the models
 * land simply have no kit dressing, and the first cell the player crosses rebuilds them with it.
 *
 * ## Textures, which are the largest number in this milestone
 *
 * Twelve, shared: `Bark_NormalTree` dresses ten models on its own. They are fetched once through one
 * `TextureLoader`, cached by manifest id in the pool (which owns teardown), and written onto **both**
 * the pooled material and its `customDepthMaterial` — see `ScenePool.dressKit`, and see
 * `foliage.ts`'s trap 1 for why a depth material that cannot see the leaf's alpha draws the rectangle
 * the leaf is painted on.
 *
 * Twenty megabytes of PNG, and no compression toolchain by the brief's own instruction. That is the
 * number the follow-up slice exists to fix and it is reported rather than hidden.
 *
 * ## Two things the loader normalises, and why neither is `modelgen`'s job
 *
 * 1. **The colour attribute.** Kit bark carries baked AO in `COLOR_0` (measured: 0.10..1.00 on
 *    `CommonTree_1`) and kit leaves carry a uniformly white one; rocks, pebbles and path stones carry
 *    none at all. `vertexColors` is a material flag and `USE_COLOR_ALPHA` is a `#define`, so a
 *    material whose flag disagrees with its geometry renders **black** — a missing attribute reads as
 *    `(0,0,0,1)`. So the rule is applied here, in three lines on a `BufferGeometry`: a solid part
 *    without a colour attribute gets a white one; a leaf part with one loses it. Doing it in
 *    `modelgen` would have meant rewriting the `.bin`, which is a buffer-offset bug waiting to happen
 *    for a saving the textures dwarf.
 * 2. **The kit has no LOD ladder.** A kit tree registers the same `BufferGeometry` under all three
 *    LOD keys, which is `trees.ts`'s *"one that ships its own LODs skips the ladder"* in the direction
 *    the kit actually took. `ScenePool.registerGeometry` counts bytes per geometry *object*, so the
 *    ledger says thirty-five meshes and not one hundred and five.
 *
 * ## What the manifest is for besides paths
 *
 * The per-model numbers the foliage uniforms need. A kit leaf's wind is scaled by the model's own
 * height — a nine-metre fern patch and a 1.3 m grass tuft cannot share one `uTreeHeight` and still
 * both sway by a plausible fraction of themselves — and `uBend` is zero for every one of them, which
 * is `foliage.ts`'s trap 2 read in the other direction: the cone-shell recipe is for intersecting
 * cards, and a kit leaf mesh has real normals of its own that must not be bent onto anything.
 */

import type { BufferGeometry, Mesh, Object3D } from 'three';
// `TextureLoader` is imported statically and `GLTFLoader` dynamically, and the asymmetry is on
// purpose: three itself is in the main chunk already (every file in this package imports it), so a
// dynamic import of it splits nothing and only earns Rollup's "dynamically imported by … but also
// statically imported by …" warning. `GLTFLoader` is a genuine 13.5 KB-gz chunk of its own.
import { BufferAttribute, BoxGeometry, SRGBColorSpace, TextureLoader } from 'three';

import type { ScenePool } from './pool.ts';
import {
  KIT_MODELS,
  KIT_PARTS,
  KIT_PART_TEXTURES,
  TREE_LODS,
  TREE_SOURCE,
  kitGeometryKey,
  kitMaterialKey,
  kitRoleOf,
  treeGeometryKey,
  treeMaterialKey,
  treePartsOf,
  variantsFrom,
  type KitRole,
  type TreePart,
  type TreeVariant,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The manifest, as the client reads it                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `worldgen/src/modelgen.ts`'s own interfaces. Restated because the two packages do not import. */
export interface KitPartEntry {
  readonly material: string;
  readonly role: KitRole;
  readonly texture: string;
  readonly triangles: number;
  readonly vertices: number;
  readonly alphaTest: number;
  readonly vertexColours: boolean;
}

export interface KitModelEntry {
  readonly id: string;
  readonly family: string;
  readonly url: string;
  readonly bytes: number;
  readonly triangles: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly minY: number;
  readonly blocks: boolean;
  readonly blockRadius: number;
  readonly parts: readonly KitPartEntry[];
}

export interface KitTextureEntry {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly used: number;
}

export interface KitManifest {
  readonly version: number;
  readonly generator: string;
  readonly models: readonly KitModelEntry[];
  readonly textures: readonly KitTextureEntry[];
}

/** Bumped in lockstep with `modelgen.ts`. A stale import fails loudly here rather than oddly later. */
export const KIT_MANIFEST_VERSION = 1;

/** The one path this package knows. Relative, so a base-pathed deployment still resolves it. */
export const KIT_MANIFEST_PATH = 'models/nature/manifest.json';

/**
 * How hard a kit leaf sways, as a multiple of the base wind, by family.
 *
 * A tuft of grass whips, a fern nods and a tree canopy barely moves — and the same number cannot
 * serve all three even after `foliage.ts` has divided the sway by the thing's own height, because
 * stiffness is not a function of size. Absent means 1.
 */
const WIND_GAIN: Readonly<Record<string, number>> = {
  grass: 3.2,
  flower: 2.4,
  clover: 2.6,
  plant: 2.0,
  fern: 1.6,
  bush: 1.2,
};

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What the renderer knows about the kit: the manifest, and whether the geometry has arrived.
 *
 * Holds no geometry itself — that lives in the pool, where every other geometry in this renderer
 * lives. This is the index and the loader, exactly as `TreeSet` is.
 */
export class KitSet {
  private readonly entries = new Map<string, KitModelEntry>();
  /** Models whose every part is registered. `__debug3d.kitLoaded`. */
  private readonly ready = new Set<string>();
  private textureCount = 0;
  private textureBytesOnWire = 0;

  get loaded(): number {
    return this.ready.size;
  }

  get textures(): number {
    return this.textureCount;
  }

  /** Bytes of PNG fetched. The number the compression slice exists to reduce. */
  get textureBytes(): number {
    return this.textureBytesOnWire;
  }

  entry(id: string): KitModelEntry | undefined {
    return this.entries.get(id);
  }

  /** True once at least one model can be drawn. `world3d.ts` gates the kit scatter on it. */
  get available(): boolean {
    return this.ready.size > 0;
  }

  /** Triangles across everything registered — the honest cost of one fully dressed room. */
  get triangles(): number {
    let total = 0;
    for (const id of this.ready) total += this.entries.get(id)?.triangles ?? 0;
    return total;
  }

  /**
   * Fetch the manifest, its textures and its models, and register what comes back.
   *
   * **Never rejects**, for `TreeSet.load`'s reason: a missing import is a world without kit dressing,
   * which is M5a's world, and a renderer that refused to boot because a build artefact was absent
   * would be a worse failure than the one it was reporting. What it does instead is return the
   * reason, so `main.ts` can put it in the log where somebody will see it.
   *
   * Textures are awaited **before** the models, and that ordering is not an accident: a geometry
   * registered before its texture is a chunk that can be built with a white placeholder on it, and a
   * white bush is more wrong than no bush. Twelve fetches against sixty-three, so the wait is short.
   */
  async load(pool: ScenePool, base = './', manifestPath = KIT_MANIFEST_PATH): Promise<string | undefined> {
    let manifest: KitManifest;
    try {
      const response = await fetch(`${base}${manifestPath}`);
      if (!response.ok) return `kit manifest: HTTP ${response.status}`;
      manifest = (await response.json()) as KitManifest;
    } catch (error) {
      return `kit manifest: ${String(error)}`;
    }
    if (manifest.version !== KIT_MANIFEST_VERSION) {
      return `kit manifest is version ${manifest.version}, this client reads ${KIT_MANIFEST_VERSION} — re-run modelgen`;
    }

    const wanted = wantedModels();
    const models = manifest.models.filter((model) => wanted.has(model.id));
    for (const model of models) this.entries.set(model.id, model);

    // Only the textures the models we actually draw refer to. The five `Petal_*` are in the manifest
    // and not in `KIT_MODELS` (see that list's docblock), so their texture is only fetched because
    // something else wears it too — which, for `Flowers`, it does.
    const needed = new Set<string>();
    for (const model of models) for (const part of model.parts) needed.add(part.texture);

    const loader = new TextureLoader();
    await Promise.all(
      manifest.textures
        .filter((texture) => needed.has(texture.id))
        .map(async (texture) => {
          try {
            const loaded = await loader.loadAsync(`${base}${texture.url}`);
            // The kit's PNGs are authored in sRGB; three's working space is linear and it converts on
            // sample only if told. Left at the default they would come out visibly pale, and every
            // green in the kit would be the wrong green.
            loaded.colorSpace = SRGBColorSpace;
            loaded.name = `kit:${texture.id}`;
            // Off by default on a loaded texture, and a kit leaf seen at 40 m without it is a field of
            // aliasing sparkle — the one artefact `post.ts`'s MSAA cannot touch, because it is
            // sub-texel rather than sub-pixel.
            loaded.generateMipmaps = true;
            pool.registerTexture(texture.id, loaded, texture.width, texture.height);
            this.textureCount += 1;
            this.textureBytesOnWire += texture.bytes;
          } catch {
            // One texture that will not load is a family drawn white. Swallowed per texture rather
            // than per set, so a single corrupt PNG does not take the kit with it.
          }
        }),
    );

    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = new GLTFLoader();
    await Promise.all(
      models.map(async (model) => {
        try {
          const loaded = await gltf.loadAsync(`${base}${model.url}`);
          registerModel(pool, model, loaded.scene);
          this.ready.add(model.id);
        } catch {
          // One model that will not load is one model that is not drawn.
        }
      }),
    );

    // The textures go on last, after every material exists and every geometry is in. Assigning a map
    // to a material whose geometry has not arrived would be harmless; doing it in the other order and
    // *forgetting* would not be, so the two passes are separated and this one is the sweep.
    dressAll(pool);
    return this.ready.size > 0 ? undefined : 'kit manifest loaded but no model arrived';
  }

  /**
   * Fill the pool with proportioned stand-ins instead of the import — **the headless path**.
   *
   * `traversal.test.ts` has to exercise the kit scatter for the same reason it has to exercise the
   * trees: a flat ledger over a thousand rooms is only worth asserting if the thing that grew the
   * most instances was actually running, and after M5b the kit is a third of the instances in a
   * forest room. There is no network, no GPU and no `GLTFLoader` in that process.
   *
   * A unit box per part, rather than the model's measured extents: unlike `TreeSet.standIn`, nothing
   * here measures anything off a kit mesh — the manifest carries the numbers and the manifest is not
   * present headless either. What the stand-in has to be is *registered*, so that `world3d.ts`'s
   * "drop any placement whose geometry the pool cannot resolve" gate lets the placements through and
   * the wrapper arithmetic is exercised for real.
   */
  standIn(pool: ScenePool): void {
    for (const part of KIT_PARTS) {
      pool.registerGeometry(kitGeometryKey(part.model, part.texture), new BoxGeometry(1, 1, 1));
      this.ready.add(part.model);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/** Every model this client has a pool key for: the 43 props, plus the 20 trees inside `TREE_VARIANTS`. */
export function wantedModels(): ReadonlySet<string> {
  const out = new Set<string>(KIT_MODELS);
  for (const variant of variantsFrom('kit')) out.add(variant);
  return out;
}

/**
 * Pull a loaded model's primitives into the pool under the right keys.
 *
 * The match is by **material name**, which is the glTF's own and which `modelgen` recorded in the
 * manifest for exactly this purpose. `GLTFLoader` turns a two-primitive mesh into two `Mesh` children
 * with two materials, and their names survive the trip — so `Bark_NormalTree` finds its manifest part,
 * which names its texture, which decides its role, which decides its key. One chain, no positional
 * assumptions about primitive order.
 */
function registerModel(pool: ScenePool, model: KitModelEntry, scene: Object3D): void {
  const tree = TREE_SOURCE[model.id as TreeVariant] === 'kit';
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    // `GLTFLoader` gives a multi-primitive mesh a `Group` of one `Mesh` per primitive, each with its
    // own material — never one mesh with a material array — so `material.name` is always a string
    // here. The guard is honest rather than defensive: if that ever changed, the kit would silently
    // register nothing rather than register the wrong primitive under a key.
    if (Array.isArray(mesh.material)) return;
    const name = (mesh.material as { name?: string } | undefined)?.name ?? '';
    const part = model.parts.find((candidate) => candidate.material === name);
    if (!part) return;
    const role = kitRoleOf(part.texture);
    const geometry = normalise(mesh.geometry, role);

    if (tree) {
      const treePart: TreePart = role === 'solid' ? 'trunk' : 'canopy';
      if (!treePartsOf(model.id as TreeVariant).includes(treePart)) return;
      // No ladder: the same object under all three keys. See the header, and `registerGeometry` for
      // why the ledger is not charged three times for it.
      for (const lod of TREE_LODS) pool.registerGeometry(treeGeometryKey(model.id as TreeVariant, treePart, lod), geometry);
      if (treePart === 'canopy') applyLeafLook(pool, treeMaterialKey('canopy', model.id as TreeVariant), model);
      return;
    }

    pool.registerGeometry(kitGeometryKey(model.id, part.texture), geometry);
    if (role === 'leaf') applyLeafLook(pool, kitMaterialKey(model.id, part.texture), model);
  });
}

/**
 * Reconcile a kit geometry's colour attribute with what its material's `vertexColors` flag says.
 *
 * See the header for why this cannot be left to chance: `USE_COLOR_ALPHA` is a `#define`, a missing
 * attribute reads as `(0, 0, 0, 1)`, and a multiply by black is a black model. Solids are
 * `vertexColors: true` in the pool without exception, so a solid without the attribute is given a
 * white one; leaves are `false` without exception, so a leaf's attribute is dropped — it is uniformly
 * white in every leaf primitive in the kit and would upload for nothing.
 *
 * `Uint8Array` with `normalized` rather than floats: four bytes a vertex instead of sixteen, and the
 * only kit meshes that need it are the rocks and path stones, whose vertex counts are the highest in
 * the prop set (`RockPath_Round_Wide` is 7,084).
 */
function normalise(geometry: BufferGeometry, role: KitRole): BufferGeometry {
  if (role === 'leaf') {
    if (geometry.getAttribute('color')) geometry.deleteAttribute('color');
    return geometry;
  }
  if (!geometry.getAttribute('color')) {
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute('color', new BufferAttribute(new Uint8Array(count * 4).fill(255), 4, true));
  }
  return geometry;
}

/**
 * Write one model's proportions onto its leaf material's foliage uniforms.
 *
 * The height is the whole of it: `foliage.ts`'s wind is `local.y / uTreeHeight` squared, so a material
 * that thinks a nine-metre fern patch is two metres tall bends the whole patch as if every vertex were
 * above its own tip. Everything else a canopy carries — the cone slope, the tiers, the droop — is
 * meaningless for a mesh with real normals and stays at the `bend: 0` the pool built it with.
 */
function applyLeafLook(pool: ScenePool, key: string, model: KitModelEntry): void {
  const uniforms = pool.foliage(key);
  if (!uniforms) return;
  uniforms.uTreeHeight.value = Math.max(model.height, 0.2);
  uniforms.uWindGain.value = WIND_GAIN[model.family] ?? 1;
}

/** Put every loaded texture on every material that wears it. One sweep, after everything is in. */
function dressAll(pool: ScenePool): void {
  for (const part of KIT_PARTS) {
    const texture = pool.texture(part.texture);
    if (texture) pool.dressKit(kitMaterialKey(part.model, part.texture), texture);
  }
  for (const variant of variantsFrom('kit')) {
    for (const part of treePartsOf(variant)) {
      const id = treeTexture(variant, part);
      const texture = id ? pool.texture(id) : undefined;
      if (texture) pool.dressKit(treeMaterialKey(part, variant), texture);
    }
  }
}

/**
 * Which kit texture a kit tree's part wears.
 *
 * By family rather than from the manifest, because the pool has to build these materials at
 * construction and the manifest arrives later — the same reason `KIT_PART_TEXTURES` exists in
 * `prototypes.ts`. `kit.test.ts` asserts this table against the generated manifest, which is the
 * contract that keeps a duplicated fact from becoming two facts.
 */
export function treeTexture(variant: TreeVariant, part: TreePart): string | undefined {
  if (TREE_SOURCE[variant] !== 'kit') return undefined;
  if (variant.startsWith('common-tree-')) return part === 'trunk' ? 'bark-normal-tree' : 'leaves-normal-tree-c';
  if (variant.startsWith('pine-')) return part === 'trunk' ? 'bark-normal-tree' : 'leaf-pine-c';
  if (variant.startsWith('dead-tree-')) return part === 'trunk' ? 'bark-dead-tree' : undefined;
  if (variant.startsWith('twisted-tree-')) return part === 'trunk' ? 'bark-twisted-tree' : 'leaves-twisted-tree-c';
  return undefined;
}

/** Every part key the kit props declare, as a flat list. Used by the tests and by the report. */
export function kitPartCount(): number {
  let total = 0;
  for (const model of KIT_MODELS) total += (KIT_PART_TEXTURES[model] ?? []).length;
  return total;
}
