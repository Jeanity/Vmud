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

import type { AnimationClip, Mesh, Object3D, SkinnedMesh } from 'three';
import { Bone, BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, SRGBColorSpace, TextureLoader } from 'three';

import type { ScenePool } from './pool.ts';
import {
  ANIMATED_MODELS,
  OBJECT_MODELS,
  PROPS_MODELS,
  PROPS_PARTS,
  propsGeometryKey,
  propsMaterialKey,
} from './prototypes.ts';

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

export interface PropsClipEntry {
  readonly name: string;
  readonly duration: number;
  readonly channels: number;
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
  /**
   * **`'animated'` for a model that keeps its rig** — absent, and therefore static, for the other 96.
   *
   * Additive rather than a manifest version bump, on `protocol.EntityView`'s standing argument: a
   * reader that does not know the word takes the static branch, and the static branch on a rigged
   * model registers a geometry nothing asks for. See `prototypes.ANIMATED_MODELS` for the three-way
   * split this field is the wire form of.
   */
  readonly kind?: 'animated';
  /** The vendor-shaped stem, for a model that has one. `Loot_sparkle` was the first. */
  readonly stem?: string;
  /** Joints in its skin. Seven for the retired loot sparkle. */
  readonly joints?: number;
  /** Its own clips, which travel inside its own file. `characters.CharacterModelEntry.clips`' twin. */
  readonly clips?: readonly PropsClipEntry[];
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
/* The animated objects' template                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a rigged object is, once — the thing a per-entity rig is cloned from.
 *
 * `characters.BodyTemplate`'s small cousin, and short for the reason that one is long: a body template
 * carries a cullable skin, its per-vertex region labels, a head inverse for refitting hair and a
 * `composable` flag, because a body is a thing you dress. An animated object is a thing that *plays*.
 * There is nothing to hang on it, no region to cull, and one clip.
 *
 * The bones here are the **import's own**, never added to a scene — every rig clones them, exactly as
 * `BodyTemplate.bones` are cloned. The geometry and the materials are the pool's.
 */
export interface AnimatedTemplate {
  readonly id: string;
  /** The source bones, in skeleton order. Seven for the sparkle. */
  readonly bones: readonly Bone[];
  readonly boneInverses: readonly Matrix4[];
  /** The pooled key of the one merged primitive. See {@link mergeShared}. */
  readonly geometry: string;
  /** Its own clips, by name — `Idle_Loop`. Never the shared table; there is no shared table here. */
  readonly clips: ReadonlyMap<string, AnimationClip>;
  /** Metres, as the manifest measured them. The sparkle is 0.418 m tall over a base at y = 0.002. */
  readonly height: number;
}

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

export class PropsSet {
  private readonly entries = new Map<string, PropsModelEntry>();
  private readonly ready = new Set<string>();
  private readonly rigged = new Map<string, AnimatedTemplate>();
  private textureCount = 0;
  private textureBytesOnWire = 0;

  /**
   * The template for one animated object, or nothing — the accessor `entities.ts` asks before it
   * spends a skeleton.
   *
   * Nothing is the answer for the whole of a session's first second (`PropsSet.load` is not awaited,
   * the same argument the trees, the kit and the characters make) and for ever if the import was never
   * run. Both draw the capsule, which is already-correct code.
   */
  animated(id: string): AnimatedTemplate | undefined {
    return this.rigged.get(id);
  }

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
    const wanted = new Set<string>([...PROPS_MODELS, ...OBJECT_MODELS, ...ANIMATED_MODELS]);
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
          // **The rigged branch, and it is read first because it is the more specific one.** An
          // animated object's primitives are `SkinnedMesh`es and its geometry has to keep its
          // `JOINTS_0`/`WEIGHTS_0`; the static path below would register it perfectly happily and draw
          // it in its bind pose for ever, which reads as a broken animation system rather than as a
          // model filed under the wrong word. See `characters.CHARACTER_MANIFEST_VERSION` for the same
          // failure, one pack over, and the version bump it bought.
          if (model.kind === 'animated') {
            const template = registerAnimated(pool, model, loaded.scene, loaded.animations);
            if (template) {
              this.rigged.set(model.id, template);
              this.ready.add(model.id);
            }
            return;
          }
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
    // **And the animated objects, which need a rig rather than a box** — a real hierarchy under the
    // real joint names, because what a stand-in has to be is *bindable*. The loop is over the list and
    // the armature is {@link SPARKLE_JOINTS}, which is honest while the list is empty or holds the one
    // model that armature belongs to, and is the line to split the day it holds two.
    for (const model of ANIMATED_MODELS) {
      const key = propsGeometryKey(model, model);
      pool.registerGeometry(key, standInGeometry());
      const bones = standInBones(SPARKLE_JOINTS);
      this.rigged.set(model, {
        id: model,
        bones,
        boneInverses: bones.map(() => new Matrix4()),
        geometry: key,
        // Empty, and that is the honest headless shape: there is no `AnimationClip` without a file to
        // read one out of.
        clips: new Map(),
        height: 0.418,
      });
      this.ready.add(model);
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
  // The animated objects would be dressed here, on `propsMaterialKey(model)` like the objects above.
  // {@link ANIMATED_MODELS} is empty, so there is nothing to dress; the loop is kept as the seam the
  // next rigged prop arrives through, and a model added to that list without a material key of its own
  // would be a dress call against a material that does not exist.
  for (const model of ANIMATED_MODELS) {
    const texture = pool.texture(model);
    if (texture) pool.dressKit(propsMaterialKey(model), texture);
  }
}

/* -------------------------------------------------------------------------- */
/* The animated objects                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The seven joints of the loot sparkle's armature, in skeleton order — **measured off the import**.
 *
 * `base` is the root the whole thing hangs from, `shaft` is the still column of light, and `g1`..`g5`
 * are the glints. Each of those five carries its own independent 25-key rotation path in `Idle_Loop`.
 *
 * **The model is no longer drawn** — `glint.ts` replaced it with a particle field, and
 * `prototypes.ANIMATED_MODELS` is empty. This constant stays because it is the package's statement of
 * what the one verified rigged import *is*: `props.test.ts` holds it against the glTF on disk, which
 * is the check that keeps `modelgen.buildAnimatedObject` honest for the next rigged prop.
 *
 * Written down here rather than read from the file for `characters.CHURN_JOINTS`' reason: this is the
 * package's own statement of what the armature is, and `props.test.ts` holds it against the glTF on
 * disk — so a re-import that renamed a bone fails a test instead of silently drawing a still sparkle.
 */
export const SPARKLE_JOINTS = ['base', 'shaft', 'g1', 'g2', 'g3', 'g4', 'g5'] as const;

/**
 * Pull a rigged object into the pool: one merged geometry, one skeleton, its own clips.
 *
 * `registerModel`'s opposite number, and the differences are all consequences of the mesh being
 * skinned:
 *
 * - **The geometry is taken as it is, never rebuilt.** `registerModel` finds a primitive by material
 *   name and normalises its colour; here the vertices carry `JOINTS_0`/`WEIGHTS_0` and their bind is
 *   only meaningful against the skeleton in the same file, so anything clever done to them on the way
 *   in is a chance to break the pose for no gain. That is `modelgen.buildAnimatedObject`'s own
 *   argument for copying the source buffer wholesale, restated at the other end of the wire.
 * - **The primitives are merged rather than keyed apart.** Both of the sparkle's wear a material named
 *   `loot_sparkle`, so the `(model, texture)` key they would each claim is the *same* key and
 *   `registerGeometry` is first-wins — the exact trap `PROPS_PART_TEXTURES` keeps `Anvil` and
 *   `Chest_Wood` out of the drawn set to avoid. Half a sparkle is 228 triangles of 420. See
 *   {@link mergeShared}.
 * - **The skeleton is the file's own**, `characters.register`'s creature branch exactly: `cloneBones`
 *   walks whatever array it is given and `new Skeleton` takes as many inverses as there are bones, so
 *   nothing downstream cares that this is seven joints rather than sixty-five.
 *
 * Returns nothing when the file arrived without a skin or without a mergeable geometry — either is one
 * object that is not drawn, and `entities.ts` falls back to the capsule.
 */
function registerAnimated(
  pool: ScenePool,
  model: PropsModelEntry,
  scene: Object3D,
  animations: readonly AnimationClip[],
): AnimatedTemplate | undefined {
  const skinned: SkinnedMesh[] = [];
  scene.traverse((node) => {
    const mesh = node as SkinnedMesh;
    if (mesh.isSkinnedMesh === true) skinned.push(mesh);
  });
  const first = skinned[0];
  if (!first?.skeleton) return undefined;

  const merged = mergeShared(skinned.map((mesh) => mesh.geometry));
  if (!merged) return undefined;
  merged.name = `${model.id}:${model.id}`;
  const key = propsGeometryKey(model.id, model.id);
  pool.registerGeometry(key, merged);

  return {
    id: model.id,
    bones: first.skeleton.bones,
    boneInverses: first.skeleton.boneInverses,
    geometry: key,
    clips: new Map(animations.map((clip) => [clip.name, clip])),
    height: model.height,
  };
}

/**
 * Concatenate primitives that already **share their vertex buffers** — the sparkle's two, as one draw.
 *
 * Not `characters.mergeSame`, and the difference is a measurement. That function copies every
 * attribute value through `getComponent` and offsets the indices, because the garments it merges are
 * genuinely separate vertex sets. These are not: `modelgen.buildAnimatedObject` emits two primitives
 * that reference **one** `POSITION` accessor (0), one `NORMAL` (1), one `JOINTS_0` (2), one `WEIGHTS_0`
 * (3) and one `COLOR_0` (17), differing only in which triangles they draw — 684 indices and 576, 420
 * triangles over 1,497 vertices. Three's `GLTFLoader` caches by accessor, so the two `BufferGeometry`s
 * hold the *same* `BufferAttribute` objects, and the merge is the index arrays end to end with no
 * offset and no copy at all.
 *
 * **Refuses rather than guesses.** Every attribute of every primitive must be the identical object, and
 * a re-import that broke that sharing gets `undefined` — one object not drawn, loudly, on the capsule
 * path — rather than a silent half-merge. That is `registerModel`'s all-or-nothing-per-model rule with
 * a sharper edge, and it is the right edge here because the failure it guards is the one thing about
 * this model that is unusual.
 */
function mergeShared(parts: readonly BufferGeometry[]): BufferGeometry | undefined {
  const first = parts[0];
  if (!first) return undefined;
  if (parts.length === 1) return first;

  const names = Object.keys(first.attributes);
  for (const part of parts) {
    if (Object.keys(part.attributes).length !== names.length) return undefined;
    for (const name of names) {
      if (part.getAttribute(name) !== first.getAttribute(name)) return undefined;
    }
  }

  const indices: number[] = [];
  for (const part of parts) {
    const index = part.getIndex();
    if (!index) return undefined;
    for (let i = 0; i < index.count; i++) indices.push((index.array as ArrayLike<number>)[i]!);
  }

  const out = new BufferGeometry();
  for (const name of names) out.setAttribute(name, first.getAttribute(name));
  out.setIndex(indices);
  return out;
}

/**
 * A one-triangle skinned primitive — the headless stand-in, `characters.standInGeometry`'s twin.
 *
 * Identical in shape and therefore in bytes: `position` 36 + `normal` 36 + `uv` 24 + `color` 12 +
 * `skinIndex` 24 + `skinWeight` 48 + `index` 6 = **186 B**, which is the whole of this slice's geometry
 * delta on `traversal.test.ts`'s ledger. Weighted to three different joints so a stand-in binds like a
 * real one rather than collapsing onto the root.
 */
function standInGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 1, 0, 0.2, 0, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0]), 2));
  geometry.setAttribute('color', new BufferAttribute(new Uint8Array(12).fill(255), 4, true));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([0, 0, 0, 0, 2, 0, 0, 0, 4, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
}

/** A flat chain of correctly-named bones. Only the names and the count are load-bearing headless. */
function standInBones(names: readonly string[]): Bone[] {
  const out: Bone[] = [];
  for (const name of names) {
    const bone = new Bone();
    bone.name = name;
    out.push(bone);
  }
  for (let i = 1; i < out.length; i++) out[0]!.add(out[i]!);
  return out;
}
