/**
 * The village registry — where the Quaternius *Medieval Village MegaKit* becomes pooled geometry.
 *
 * `kit.ts`'s sibling and `trees.ts`'s cousin: the same contract, the same never-rejects loader, the
 * same "loaded once at boot, instances stream" deviation from per-ring loading, and the same reason
 * for it — *"the allocation ledger must read the SAME byte total at room 100 and room 1,000"*, which
 * a geometry pool that grows while the player walks cannot satisfy.
 *
 * What differs from `kit.ts` is only what the two kits are *for*, and it shows up in three places:
 *
 * 1. **One registry, not two.** A nature model is either a tree (and joins `TREE_VARIANTS`) or a prop
 *    (and joins `KIT_MODELS`); every village model is a village model. There is no `TREE_SOURCE`
 *    equivalent to consult and nothing downstream that has to be kept from telling them apart.
 * 2. **Eleven models of a hundred and seventy-six.** The manifest is the whole pack, as the nature
 *    one is, and `prototypes.VILLAGE_PART_TEXTURES` is the closed subset the material pool is sized
 *    against. See that table's docblock for what is deliberately absent and why.
 * 3. **{@link VillageSet.available} is a *completeness* test, not a liveness one.** `KitSet` reports
 *    available the moment one bush arrives, because a world with some of its understory is fine. A
 *    world with some of its *walls* is a world you can see into, so this one answers true only when
 *    every wall module in every palette plus every floor has registered — which is exactly the
 *    predicate `world3d.ts` hands to `ChunkPlanInput.dressed`, the flag that suppresses the grey
 *    boxes. A half-loaded kit therefore draws the M3 shell, not a house with two sides.
 *
 * ## Textures
 *
 * Nine across the pack and the eleven drawn models use six of them; `wood-trim` alone dresses 144 of
 * the 299 primitives. Fetched once, cached by manifest id in the pool (which owns teardown), and
 * written onto the material — `ScenePool.dressKit` is reused verbatim because a village material is
 * `kitSolid`'s program with a different picture in it.
 *
 * ## The one thing normalised on load, and why it is here rather than in `modelgen`
 *
 * **No village primitive carries a `COLOR_0`** — measured, 0 of 299, where the nature kit's bark
 * carries baked AO in one. `vertexColors` is a material flag and `USE_COLOR_ALPHA` is a `#define`, so
 * a material whose flag disagrees with its geometry renders black. The pool builds every village
 * material in the `kitSolid` family, which is `vertexColors: true`, so every village geometry is
 * given a white attribute on the way in — three lines on a `BufferGeometry` against a buffer rewrite
 * in the importer, which is `kit.ts`'s own reasoning and the reason `normaliseColour` lives here.
 *
 * The alternative — a second material family with `vertexColors: false` — would have cost a compiled
 * program to save four bytes a vertex, and the program count is the number this project actually
 * watches.
 */

import type { BufferGeometry, Mesh, Object3D } from 'three';
import { BoxGeometry, BufferAttribute, SRGBColorSpace, TextureLoader } from 'three';

import type { ScenePool } from './pool.ts';
import {
  VILLAGE_FLOORS,
  VILLAGE_MODELS,
  VILLAGE_PARTS,
  VILLAGE_WALLS,
  villageGeometryKey,
  villageMaterialKey,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The manifest, as the client reads it                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `worldgen/src/modelgen.ts`. Restated because the two packages do not import each other. */
export interface VillagePartEntry {
  readonly material: string;
  readonly role: 'solid' | 'leaf';
  readonly texture: string;
  readonly triangles: number;
  readonly vertices: number;
  readonly alphaTest: number;
  readonly vertexColours: boolean;
}

export interface VillageModelEntry {
  readonly id: string;
  readonly family: string;
  readonly url: string;
  readonly bytes: number;
  readonly triangles: number;
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly minY: number;
  readonly parts: readonly VillagePartEntry[];
}

export interface VillageTextureEntry {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly used: number;
}

export interface VillageManifest {
  readonly version: number;
  readonly generator: string;
  readonly models: readonly VillageModelEntry[];
  readonly textures: readonly VillageTextureEntry[];
}

/** Bumped in lockstep with `modelgen.ts`'s `VILLAGE_MANIFEST_VERSION`. */
export const VILLAGE_MANIFEST_VERSION = 1;

/** The one path this package knows. Relative, so a base-pathed deployment still resolves it. */
export const VILLAGE_MANIFEST_PATH = 'models/village/manifest.json';

/**
 * The models without which a room must keep its grey shell.
 *
 * Every wall in every palette and every floor — *not* the roof, the arch or the chimney, because a
 * house with no roof is a house you can see the inside of from above, which is odd, while a house
 * with no walls is a house you can walk through the picture of. The first is a missing garnish and
 * the second is the correctness property `chunkPlan`'s `dressed` flag is gated on.
 */
export const VILLAGE_REQUIRED: readonly string[] = (() => {
  const out = new Set<string>(VILLAGE_FLOORS);
  for (const palette of VILLAGE_WALLS) {
    out.add(palette.plain);
    out.add(palette.window);
  }
  return [...out].sort();
})();

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

export class VillageSet {
  private readonly entries = new Map<string, VillageModelEntry>();
  private readonly ready = new Set<string>();
  private textureCount = 0;
  private textureBytesOnWire = 0;

  get loaded(): number {
    return this.ready.size;
  }

  get textures(): number {
    return this.textureCount;
  }

  /** Bytes of PNG fetched. The number the deferred compression slice exists to reduce. */
  get textureBytes(): number {
    return this.textureBytesOnWire;
  }

  entry(id: string): VillageModelEntry | undefined {
    return this.entries.get(id);
  }

  /** Whether a specific module can be drawn. The roof and the chimney are asked for individually. */
  has(model: string): boolean {
    return this.ready.has(model);
  }

  /**
   * True when the **shell** can be drawn from the kit: every palette wall and every floor.
   *
   * See the header. This is the predicate behind `ChunkPlanInput.dressed`, so a partial load falls
   * back to M3's grey boxes as a whole rather than leaving one side of one room open.
   */
  get available(): boolean {
    return VILLAGE_REQUIRED.every((model) => this.ready.has(model));
  }

  /** Triangles across everything registered — the honest cost of one fully dressed interior. */
  get triangles(): number {
    let total = 0;
    for (const id of this.ready) total += this.entries.get(id)?.triangles ?? 0;
    return total;
  }

  /**
   * Fetch the manifest, its textures and its models, and register what comes back.
   *
   * **Never rejects**, for `TreeSet.load`'s and `KitSet.load`'s reason: a missing import is a world of
   * grey interiors, which is M3's world with a lid on it, and a renderer that refused to boot because
   * a git-ignored build artefact was absent would be a worse failure than the one it was reporting.
   * The reason comes back as a string so `main.ts` can put it in the log.
   *
   * Textures before models, the same ordering and the same argument `kit.ts` gives: a geometry
   * registered before its texture is a chunk that can be built with a white placeholder on it, and a
   * white wall is more wrong than a grey one.
   */
  async load(pool: ScenePool, base = './', manifestPath = VILLAGE_MANIFEST_PATH): Promise<string | undefined> {
    let manifest: VillageManifest;
    try {
      const response = await fetch(`${base}${manifestPath}`);
      if (!response.ok) return `village manifest: HTTP ${response.status}`;
      manifest = (await response.json()) as VillageManifest;
    } catch (error) {
      return `village manifest: ${String(error)}`;
    }
    if (manifest.version !== VILLAGE_MANIFEST_VERSION) {
      return `village manifest is version ${manifest.version}, this client reads ${VILLAGE_MANIFEST_VERSION} — re-run modelgen --village`;
    }

    const wanted = new Set(VILLAGE_MODELS);
    const models = manifest.models.filter((model) => wanted.has(model.id));
    for (const model of models) this.entries.set(model.id, model);

    // Only the textures the eleven drawn models refer to: six of the pack's nine. `red-brick` is
    // 2.4 MB and dresses exactly one model this build does not use, so it is never fetched.
    const needed = new Set<string>();
    for (const model of models) for (const part of model.parts) needed.add(part.texture);

    const loader = new TextureLoader();
    await Promise.all(
      manifest.textures
        .filter((texture) => needed.has(texture.id))
        .map(async (texture) => {
          try {
            const loaded = await loader.loadAsync(`${base}${texture.url}`);
            // sRGB, as `kit.ts` does and for the same reason: three's working space is linear and it
            // converts on sample only if told. Left at the default the plaster comes out chalky.
            loaded.colorSpace = SRGBColorSpace;
            loaded.name = `village:${texture.id}`;
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
          // One model that will not load is one model that is not drawn — and, if it is a wall, the
          // whole kit stands down. See `available`.
        }
      }),
    );

    dressAll(pool);
    return this.available ? undefined : `village kit loaded ${this.ready.size} of ${VILLAGE_MODELS.length} models`;
  }

  /**
   * Fill the pool with stand-ins instead of the import — **the headless path**.
   *
   * `traversal.test.ts` has to exercise the interior dressing for the reason it has to exercise the
   * scatter: a flat ledger over a thousand rooms is only worth asserting if the thing that produced
   * the most buckets was running, and after M6 an interior room's dressing is every bucket it has.
   * There is no network, no GPU and no `GLTFLoader` in that process.
   */
  standIn(pool: ScenePool): void {
    for (const part of VILLAGE_PARTS) {
      pool.registerGeometry(villageGeometryKey(part.model, part.texture), new BoxGeometry(1, 1, 1));
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
 * manifest for exactly this purpose — `MI_Plaster` finds its manifest part, which names its texture,
 * which is its key. One chain, no positional assumptions about primitive order.
 *
 * Returns whether every part `prototypes.ts` expects of this model actually arrived. A model that
 * registered two of its three primitives is a wall with a hole in it and must not count as ready.
 */
function registerModel(pool: ScenePool, model: VillageModelEntry, scene: Object3D): boolean {
  const found = new Set<string>();
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const name = (mesh.material as { name?: string } | undefined)?.name ?? '';
    const part = model.parts.find((candidate) => candidate.material === name);
    // `MI_WindowGlass` carries no texture and has no pool key — see `VILLAGE_PART_TEXTURES`.
    if (!part || part.texture === 'none') return;
    const key = villageGeometryKey(model.id, part.texture);
    if (!pool.hasGeometry(key) && !hasKey(model.id, part.texture)) return;
    pool.registerGeometry(key, normaliseColour(mesh.geometry));
    found.add(part.texture);
  });
  return expectedTextures(model.id).every((texture) => found.has(texture));
}

function hasKey(model: string, texture: string): boolean {
  return VILLAGE_PARTS.some((part) => part.model === model && part.texture === texture);
}

function expectedTextures(model: string): readonly string[] {
  return VILLAGE_PARTS.filter((part) => part.model === model).map((part) => part.texture);
}

/**
 * Give a village geometry the white colour attribute its material's `vertexColors` flag promises.
 *
 * See the header: a `#define` disagreeing with the geometry renders black. `Uint8Array` with
 * `normalized` rather than floats — four bytes a vertex instead of sixteen, and the roof is the
 * highest vertex count in the drawn set at 3,888 triangles.
 */
function normaliseColour(geometry: BufferGeometry): BufferGeometry {
  if (!geometry.getAttribute('color')) {
    const count = geometry.getAttribute('position')?.count ?? 0;
    geometry.setAttribute('color', new BufferAttribute(new Uint8Array(count * 4).fill(255), 4, true));
  }
  return geometry;
}

/**
 * Put every loaded texture on every material that wears it — **both twins**.
 *
 * The open twin is the same picture at 42% opacity, so forgetting it would leave a faded wall white
 * while the solid one beside it is plaster: the most visible possible symptom of the one duplicated
 * fact in this file.
 */
function dressAll(pool: ScenePool): void {
  for (const part of VILLAGE_PARTS) {
    const texture = pool.texture(part.texture);
    if (!texture) continue;
    pool.dressKit(villageMaterialKey(part.model, part.texture), texture);
    pool.dressKit(villageMaterialKey(part.model, part.texture, true), texture);
  }
  // **And the ground** — 2026-08-13. All three floor textures `prototypes.GROUND_TEXTURES` names are
  // this pack's (`uneven-brick` is the cobblestone, `brick` the laid floor, `plaster` the dirt), and
  // every one of them is already fetched here because a wall or a floor module wears it too. So the
  // owner's *"why isn't the entire room cobblestones"* costs no new asset, no new fetch and no new
  // byte on the wire — only this line, and the four uniforms behind it.
  //
  // A pool sweep rather than a list, because which sectors take a floor is `prototypes.ts`'s to say.
  // It reaches materials this file has no other business with, which is why it is spelled out here
  // rather than folded into the loop above: the village pack is the *source* of the pictures, not the
  // owner of the surfaces they land on.
  pool.dressGround((id) => pool.texture(id));
  // **And the walls** — M9, and the same sentence one surface along. `prototypes.WALL_TEXTURES` names
  // two of this pack's textures for the grey `edge` and `barrier` boxes M6 left outdoors, and both
  // are already fetched above because a wall or a floor module wears them too. So the owner's grey
  // blocks cost no new asset, no new fetch and no new byte on the wire either — only this line, and
  // the four uniforms behind it.
  pool.dressWalls((id) => pool.texture(id));
}
