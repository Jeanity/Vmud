/**
 * The furniture registry — where the Quaternius *Fantasy Props MegaKit* becomes pooled geometry.
 *
 * `village.ts`'s sibling and `kit.ts`'s cousin: the same never-rejects loader, the same "loaded once
 * at boot, instances stream" deviation from per-ring loading, and the same reason for it — *"the
 * allocation ledger must read the SAME byte total at room 100 and room 1,000"*, which a geometry pool
 * that grows while the player walks cannot satisfy.
 *
 * Three things differ from `village.ts`, and each is a consequence of what furniture *is*:
 *
 * 1. **{@link PropsSet.available} is a liveness test, not a completeness one** — `KitSet`'s posture
 *    rather than `VillageSet`'s, and the inversion is deliberate. A world with some of its *walls* is
 *    a world you can see into, so the village kit stands down as a whole if one wall module is
 *    missing. A world with some of its *furniture* is a tavern with benches and no barrels, which is
 *    a room, so a single model that arrives is worth drawing. `world3d.ts` filters per placement on
 *    `pool.hasGeometry`, exactly as it does for the scatter.
 * 2. **Three of the four atlases are already on the wire.** `trim-furniture`, `trim-metal` and
 *    `trim-props` are the character packs' held-prop atlases (`prototypes.CHARACTER_PROP_TEXTURES`),
 *    and `ScenePool.registerTexture` is keyed by manifest id and returns early on a repeat — so
 *    whichever load lands first pays and the other gets them free. This set still *counts* only what
 *    it fetched, so the two ledgers do not double-count one PNG.
 * 3. **A primitive can be missing a `COLOR_0` where its sibling has one.** Measured across the pack:
 *    `Barrel` carries the attribute on both primitives, `Anvil_Log` on one of three, `Cauldron` on
 *    none. The pool builds every furniture material in the `kitSolid` family, which is
 *    `vertexColors: true`, and `USE_COLOR_ALPHA` is a `#define` — so a geometry whose attribute
 *    disagrees with the flag renders **black**. {@link normaliseColour} gives the ones without a
 *    white one on the way in, which is `village.ts`'s three lines and `kit.ts`'s argument.
 */

import type { BufferGeometry, Mesh, Object3D } from 'three';
import { BoxGeometry, BufferAttribute, SRGBColorSpace, TextureLoader } from 'three';

import type { ScenePool } from './pool.ts';
import { OBJECT_MODELS, PROPS_MODELS, PROPS_PARTS, propsGeometryKey, propsMaterialKey } from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The manifest, as the client reads it                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `worldgen/src/modelgen.ts`. Restated because the two packages do not import each other. */
export interface PropsPartEntry {
  readonly material: string;
  readonly role: 'solid' | 'leaf';
  readonly texture: string;
  readonly triangles: number;
  readonly vertices: number;
  readonly alphaTest: number;
  readonly vertexColours: boolean;
}

export interface PropsModelEntry {
  readonly id: string;
  readonly family: string;
  readonly url: string;
  readonly bytes: number;
  readonly triangles: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly minY: number;
  readonly parts: readonly PropsPartEntry[];
}

export interface PropsTextureEntry {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly used: number;
}

export interface PropsManifest {
  readonly version: number;
  readonly generator: string;
  readonly models: readonly PropsModelEntry[];
  readonly textures: readonly PropsTextureEntry[];
}

/** Bumped in lockstep with `modelgen.ts`'s `PROPS_MANIFEST_VERSION`. */
export const PROPS_MANIFEST_VERSION = 1;

/** The one path this package knows. Relative, so a base-pathed deployment still resolves it. */
export const PROPS_MANIFEST_PATH = 'models/props/manifest.json';

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

export class PropsSet {
  private readonly entries = new Map<string, PropsModelEntry>();
  private readonly ready = new Set<string>();
  private textureCount = 0;
  private textureBytesOnWire = 0;

  get loaded(): number {
    return this.ready.size;
  }

  get textures(): number {
    return this.textureCount;
  }

  /** Bytes of PNG this set actually fetched. Three of its four atlases may already have been paid for. */
  get textureBytes(): number {
    return this.textureBytesOnWire;
  }

  entry(id: string): PropsModelEntry | undefined {
    return this.entries.get(id);
  }

  has(model: string): boolean {
    return this.ready.has(model);
  }

  /** One piece of furniture is worth drawing. See the header for why this is not `VillageSet`'s test. */
  get available(): boolean {
    return this.ready.size > 0;
  }

  /** Triangles across everything registered — the honest cost of one fully furnished interior. */
  get triangles(): number {
    let total = 0;
    for (const id of this.ready) total += this.entries.get(id)?.triangles ?? 0;
    return total;
  }

  /**
   * Fetch the manifest, its textures and its models, and register what comes back.
   *
   * **Never rejects**, for `TreeSet.load`'s, `KitSet.load`'s and `VillageSet.load`'s reason: a missing
   * import is a world of empty rooms, which is M6's world, and a renderer that refused to boot
   * because a git-ignored build artefact was absent would be a worse failure than the one it was
   * reporting.
   *
   * Textures before models, the same ordering and the same argument the other two give: a geometry
   * registered before its texture is a chunk that can be built with a white placeholder on it, and a
   * white barrel is more wrong than no barrel.
   */
  async load(pool: ScenePool, base = './', manifestPath = PROPS_MANIFEST_PATH): Promise<string | undefined> {
    let manifest: PropsManifest;
    try {
      const response = await fetch(`${base}${manifestPath}`);
      if (!response.ok) return `props manifest: HTTP ${response.status}`;
      manifest = (await response.json()) as PropsManifest;
    } catch (error) {
      return `props manifest: ${String(error)}`;
    }
    if (manifest.version !== PROPS_MANIFEST_VERSION) {
      return `props manifest is version ${manifest.version}, this client reads ${PROPS_MANIFEST_VERSION} — re-run modelgen --props`;
    }

    // **Both lists, and it has to be both.** `PROPS_MODELS` is what a room may be *furnished* with;
    // `OBJECT_MODELS` is what may be dropped on its floor. They are separate on purpose — `furnish.ts`
    // must never stand a corpse in a tavern — but they are fetched together, because from here down
    // the two are the same thing: a manifest row with a geometry and a material.
    const wanted = new Set<string>([...PROPS_MODELS, ...OBJECT_MODELS]);
    const models = manifest.models.filter((model) => wanted.has(model.id));
    for (const model of models) this.entries.set(model.id, model);

    // Only the atlases the drawn models refer to: four of the pack's five, plus one 70-byte white per
    // object. `page-noise` is a 4096² sheet worn by the two scrolls and nothing else, so it is never
    // fetched — see `prototypes.PROPS_TEXTURES`.
    const needed = new Set<string>();
    for (const model of models) for (const part of model.parts) needed.add(part.texture);

    const loader = new TextureLoader();
    await Promise.all(
      manifest.textures
        .filter((texture) => needed.has(texture.id))
        // Already on the pool from the character packs' own load, three times in four. Skipped here
        // rather than inside `registerTexture` so this set's byte counter reports what *it* fetched.
        .filter((texture) => pool.texture(texture.id) === undefined)
        .map(async (texture) => {
          try {
            const loaded = await loader.loadAsync(`${base}${texture.url}`);
            // sRGB, as both prop kits do and for the same reason: three's working space is linear and
            // it converts on sample only if told. Left at the default the oak comes out bleached.
            loaded.colorSpace = SRGBColorSpace;
            loaded.name = `props:${texture.id}`;
            loaded.generateMipmaps = true;
            pool.registerTexture(texture.id, loaded, texture.width, texture.height);
            this.textureCount += 1;
            this.textureBytesOnWire += texture.bytes;
          } catch {
            // One texture that will not load is a family drawn white.
          }
        }),
    );

    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = new GLTFLoader();
    await Promise.all(
      models.map(async (model) => {
        try {
          const loaded = await gltf.loadAsync(`${base}${model.url}`);
          if (registerModel(pool, model, loaded.scene)) this.ready.add(model.id);
        } catch {
          // One model that will not load is one piece of furniture that is not drawn. The rest of the
          // room still furnishes — see `available`.
        }
      }),
    );

    dressAll(pool);
    return this.ready.size > 0 ? undefined : 'props manifest loaded but no model arrived';
  }

  /**
   * Fill the pool with stand-ins instead of the import — **the headless path**.
   *
   * `traversal.test.ts` has to exercise the furniture for the reason it has to exercise the interior
   * dressing: a flat ledger over a thousand rooms is only worth asserting if the thing that produced
   * the most buckets was running, and after M9 a furnished room's six props buckets are more than half
   * of what an interior chunk has. There is no network, no GPU and no `GLTFLoader` in that process.
   */
  standIn(pool: ScenePool): void {
    for (const part of PROPS_PARTS) {
      pool.registerGeometry(propsGeometryKey(part.model, part.texture), new BoxGeometry(1, 1, 1));
      this.ready.add(part.model);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Pull a loaded model's primitives into the pool under the right keys.
 *
 * The match is by **material name**, which is the glTF's own and which `modelgen` recorded in the
 * manifest for exactly this purpose — `MI_Trim_Furniture` finds its manifest part, which names its
 * texture, which is half its key. One chain, no positional assumptions about primitive order.
 *
 * Returns whether every part `prototypes.ts` expects of this model arrived. A model that registered
 * two of its three primitives is a market stall with no awning and must not count as ready — the same
 * all-or-nothing per *model* rule `village.ts` applies, which is what makes the drawn set's
 * "no two primitives of one model share an atlas" property (see `PROPS_PART_TEXTURES`) checkable at
 * run time as well as in a test.
 */
function registerModel(pool: ScenePool, model: PropsModelEntry, scene: Object3D): boolean {
  const found = new Set<string>();
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const name = (mesh.material as { name?: string } | undefined)?.name ?? '';
    const part = model.parts.find((candidate) => candidate.material === name);
    if (!part || part.texture === 'none') return;
    const key = propsGeometryKey(model.id, part.texture);
    if (!hasKey(model.id, part.texture)) return;
    pool.registerGeometry(key, normaliseColour(mesh.geometry));
    found.add(part.texture);
  });
  return expectedTextures(model.id).every((texture) => found.has(texture));
}

function hasKey(model: string, texture: string): boolean {
  return PROPS_PARTS.some((part) => part.model === model && part.texture === texture);
}

function expectedTextures(model: string): readonly string[] {
  return PROPS_PARTS.filter((part) => part.model === model).map((part) => part.texture);
}

/**
 * Give a furniture geometry the white colour attribute its material's `vertexColors` flag promises.
 *
 * See the header: a `#define` disagreeing with the geometry renders black, and this pack is
 * inconsistent about `COLOR_0` **within one model** where the village pack was consistently without
 * it. `Uint8Array` with `normalized` rather than floats — four bytes a vertex instead of sixteen, and
 * `CandleStick_Stand` is the highest vertex count in the drawn set.
 */
function normaliseColour(geometry: BufferGeometry): BufferGeometry {
  if (!geometry.getAttribute('color')) {
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute('color', new BufferAttribute(new Uint8Array(count * 4).fill(255), 4, true));
  }
  return geometry;
}

/**
 * Put every loaded atlas on the four materials that wear them — one sweep, after everything is in.
 *
 * Four calls rather than forty-nine, because a furniture material is keyed by its atlas alone: see
 * `prototypes.propsMaterialKey` for why this kit follows the *characters*' key discipline and not the
 * two scatter kits'.
 */
function dressAll(pool: ScenePool): void {
  for (const part of PROPS_PARTS) {
    const texture = pool.texture(part.texture);
    if (texture) pool.dressKit(propsMaterialKey(part.texture), texture);
  }
}
