/**
 * The character registry — where the Quaternius people become pooled geometry, shared clips and two
 * skeleton templates, and the one place this renderer knows the character packs exist.
 *
 * `kit.ts` and `village.ts`'s third sibling, and it keeps their three contracts to the letter: loaded
 * **once at boot** rather than per streaming ring (the ledger has to read the same total at room 100
 * and room 1,000); **never rejects**, because a renderer that refused to boot over a missing build
 * artefact is a worse failure than the one it is reporting; and it holds no geometry itself — that
 * lives in the pool, where every geometry in this renderer lives.
 *
 * What is new here, and it is the whole of M7b's difference from the two prop kits:
 *
 * ## 1. A body is composed, not placed
 *
 * A tree is one mesh at one matrix. A person is a base body with regions of it **hidden**, plus up to
 * six garment meshes and two props, all deforming together on one skeleton. So this file publishes
 * *templates* — {@link BodyTemplate} and {@link PartTemplate} — and `body.ts` assembles them per
 * entity. See `skin.ts` for the measurement that makes the hiding necessary rather than optional.
 *
 * ## 2. One armature, and it is the base body's
 *
 * All 22 rigged files bind 65 joints under the same names in the same order — verified headlessly on
 * 2026-08-13, and asserted in `characters.test.ts` against the generated manifest. But **their
 * inverse-bind matrices are not all the same**, and that measurement decided the design:
 *
 * ```
 *   every FEMALE outfit part   vs Superhero_Female  max |delta| = 0     (byte-identical)
 *   every MALE   outfit part   vs Superhero_Male    max |delta| = 0.352
 * ```
 *
 * Broken down per joint, the male difference is entirely in the **limbs**: `hand_r` sits 23 mm further
 * out on the Superhero rig, `upperarm_r` 20 mm, `thigh_r` 23 mm; the spine, the neck and the head are
 * identical to the millimetre. The outfit pack was authored against the vendor's *Regular* male
 * proportions (its own skin material is `MI_Regular_Male`) and the Standard tier of the base pack
 * ships only *Superhero*.
 *
 * **Every mesh binds to the base body's skeleton and the parts' own inverse-bind matrices are
 * discarded.** At rest that draws each garment exactly where it was authored — skinning is
 * `boneWorld x IBM x v` and `boneWorld = IBM_base^-1`, so substituting the base's IBM is the identity
 * on the bind pose. Under animation a male garment bends around a pivot up to 23 mm inboard of where
 * it was weighted, which is a sub-centimetre artefact at the elbow on a 1.81 m figure. The
 * alternative — a second `Skeleton` per part over the same bones, so each keeps its own inverses —
 * would displace every male garment by *exactly* that 23 mm at rest, permanently, and cost a second
 * bone texture per part. The seam that would show it is the neck, and the neck is identical.
 *
 * ## 3. Clips are data and are shared
 *
 * An `AnimationClip` is immutable keyframe data. All 24 rigs play the same sixteen objects; only the
 * `AnimationMixer` is per body. See `anim.ts`.
 *
 * ## What this file normalises on the way in, and why none of it is `modelgen`'s job
 *
 * `kit.ts`'s two, plus one:
 *
 * 1. **The colour attribute**, exactly as there: the pool's character material is
 *    `vertexColors: true` without exception, `USE_COLOR_ALPHA` is a `#define`, and a missing attribute
 *    reads as `(0,0,0,1)` — a body multiplied by black. A primitive without one is given a white one.
 * 2. **A prop's node transform is baked.** `Axe_Bronze`'s glTF node carries a −90° rotation about Z
 *    and a 0.847 scale; the pool stores geometries, not nodes, so an unbaked axe would arrive in the
 *    hand sideways and a fifth too large. Measured before and after in `characters.test.ts`.
 * 3. **Primitives that share a material inside one part are merged.** `Male_Ranger_Body` ships as
 *    three primitives all wearing `MI_Ranger` (the coat and two belts) and `Female_Ranger_Arms` as
 *    three across two materials. Merging at *registration* — once per part, never per entity — takes a
 *    dressed ranger from ten skinned draw calls to eight and costs nothing at run time.
 */

import {
  Bone,
  BufferAttribute,
  BufferGeometry,
  Matrix4,
  SRGBColorSpace,
  TextureLoader,
  type AnimationClip,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
} from 'three';

import { maskedGeometry, vertexRegions } from './skin.ts';
import type { ScenePool } from './pool.ts';
import { CHARACTER_TEXTURES, characterGeometryKey, characterMaterialKey } from './prototypes.ts';
import { CLIPS, type ClipName } from './anim.ts';

/* -------------------------------------------------------------------------- */
/* The manifest, as the client reads it                                        */
/* -------------------------------------------------------------------------- */

/** Mirrors `worldgen/src/modelgen.ts`. Restated because the two packages do not import. */
export interface CharacterPartEntry {
  readonly material: string;
  readonly texture: string;
  readonly triangles: number;
  readonly vertices: number;
}

export interface CharacterModelEntry {
  readonly id: string;
  readonly kind: 'body' | 'outfit' | 'hair' | 'weapon';
  /** The vendor's own stem — the join key to `appearance.ts`'s `base:` / `outfit:` / `prop:` ids. */
  readonly stem: string;
  readonly url: string;
  readonly bytes: number;
  readonly triangles: number;
  readonly height: number;
  readonly minY: number;
  readonly joints: number;
  readonly parts: readonly CharacterPartEntry[];
}

export interface CharacterClipEntry {
  readonly name: string;
  readonly duration: number;
  readonly channels: number;
}

export interface CharacterLibraryEntry {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly sourceBytes: number;
  readonly sourceClips: number;
  readonly clips: readonly CharacterClipEntry[];
}

export interface CharacterTextureEntry {
  readonly id: string;
  readonly url: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly used: number;
}

export interface CharacterManifest {
  readonly version: number;
  readonly generator: string;
  readonly models: readonly CharacterModelEntry[];
  readonly textures: readonly CharacterTextureEntry[];
  readonly animations?: readonly CharacterLibraryEntry[];
}

/**
 * Bumped in lockstep with `modelgen.ts`. A stale import fails loudly here rather than oddly later.
 *
 * **2 since the hair slice.** A v1 manifest has no `hair` models, and — worse in the other direction —
 * a v1 *reader* meeting one would take the body branch below, because a hairstyle is skinned and
 * nothing would throw. Six hairstyles registering as base bodies nobody asks for is precisely the kind
 * of quiet wrongness this number exists to turn into a sentence.
 */
export const CHARACTER_MANIFEST_VERSION = 2;

/** The one path this package knows. Relative, so a base-pathed deployment still resolves it. */
export const CHARACTER_MANIFEST_PATH = 'models/characters/manifest.json';

/** The 65 joints, verified identical across every rigged file in all three packs. */
export const JOINT_COUNT = 65;

/** Right hand main, left hand off — `space.ts`'s frame: a body faces `-Z`, so its left is `+X`. */
export const MAIN_HAND_BONE = 'hand_r';
export const OFF_HAND_BONE = 'hand_l';

/**
 * The one joint a hairstyle is weighted to — **measured, all six meshes, 100% of every vertex**.
 *
 * That single fact is what makes hair cheap here. It rides the head through every clip with no
 * attachment code at all (unlike a prop, which hangs off a bone as a rigid child), and the *whole* of
 * a cross-sex refit is one rigid transform of this joint's frame — see {@link HairTemplate.headInverse}.
 */
export const HEAD_BONE = 'Head';

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

/** One drawable primitive: a pooled geometry key and a pooled material key. */
export interface PartPrimitive {
  readonly geometry: string;
  readonly material: string;
}

/** A garment, an accessory or the two head primitives — anything hung on the rig unmodified. */
export interface PartTemplate {
  readonly stem: string;
  readonly primitives: readonly PartPrimitive[];
}

/**
 * A base body: the bone hierarchy to clone, the inverses to bind against, and the primitives.
 *
 * `skin` is the one primitive whose triangles are culled by what is worn — see `skin.ts`. The others
 * (eyes, eyebrows) are head-region throughout and are always drawn.
 */
export interface BodyTemplate {
  readonly stem: string;
  /** The 65 source bones, in skeleton order. Cloned per rig; never added to a scene itself. */
  readonly bones: readonly Bone[];
  readonly boneInverses: readonly Matrix4[];
  readonly jointNames: readonly string[];
  /** The cullable primitive, with its per-vertex region labels. Absent only for a stand-in. */
  readonly skin?: { readonly primitive: PartPrimitive; readonly regions: Uint8Array };
  /** Eyes and eyebrows: always drawn, never culled. */
  readonly extras: readonly PartPrimitive[];
  readonly height: number;
  /** This rig's own inverse-bind matrix for {@link HEAD_BONE}. See {@link HairTemplate.headInverse}. */
  readonly headInverse: Matrix4;
}

/**
 * A hairstyle: the primitive, and the skull it was authored on.
 *
 * ## The one number that is not the same as an outfit part's
 *
 * `headInverse` is this mesh's own inverse-bind matrix for {@link HEAD_BONE}, and it is kept because
 * the two base rigs put that joint in different places — the male's at `y = 1.5986, z = -0.0637`, the
 * female's at `1.5491, -0.0389`, with a degree of tilt between them. Every other part in this pack is
 * bound with the base body's inverses and its own discarded (see the file header, §2): at rest that
 * draws a garment exactly where it was authored, which is right, because a garment authored on a body
 * and a body are the same size.
 *
 * A hairstyle is not. It is authored around **one** skull, and the vendor shipped five of the six
 * around one sex or the other — so drawn "exactly where it was authored" a female bun sits 50 mm
 * inside a male scalp. The fix is one matrix and no geometry: because hair is weighted 100% to the
 * head, `IBM_body(Head)⁻¹ · IBM_hair(Head)` is exactly the rigid transform that carries this mesh's
 * bind-pose head onto that body's, and `SkinnedMesh.bind(skeleton, m)` applies it as a **uniform** —
 * `AttachedBindMode` recomputes `bindMatrixInverse` from the mesh's own world matrix each frame and
 * never from `bindMatrix`, so the shader's product comes out as `boneWorld · IBM_body · m · v`, which
 * is `boneWorld · IBM_hair · v`. Correct at rest and correct through every animation.
 *
 * Measured against the vendor's own answer, on the one style they fitted twice: transforming
 * `Hair_BuzzedFemale` onto the male rig this way lands within **8 mm** of `Hair_Buzzed`, against ~50 mm
 * for doing nothing. Where a fitted variant exists `appearance.HAIR_STYLES` names it and the matrix is
 * the identity anyway.
 */
export interface HairTemplate {
  readonly stem: string;
  readonly primitives: readonly PartPrimitive[];
  readonly headInverse: Matrix4;
}

/** A held prop: one geometry, one material, and the node transform already baked in. */
export interface WeaponTemplate {
  readonly stem: string;
  readonly primitives: readonly PartPrimitive[];
}

/* -------------------------------------------------------------------------- */
/* The set                                                                     */
/* -------------------------------------------------------------------------- */

/** Bare identity for a stand-in geometry, so a headless test exercises the same code paths. */
const STAND_IN_TEXTURE = CHARACTER_TEXTURES[0];

export class CharacterSet {
  private readonly bodies = new Map<string, BodyTemplate>();
  private readonly parts = new Map<string, PartTemplate>();
  private readonly hairs = new Map<string, HairTemplate>();
  private readonly weapons = new Map<string, WeaponTemplate>();
  private readonly clipsByName = new Map<string, AnimationClip>();
  /**
   * Culled body geometries, by `(base stem, hidden mask)` — the cache that keeps the cull free.
   *
   * At most `2 x 2^4 = 32` entries can ever exist, because only four gear slots hide anything
   * (`skin.HIDDEN_BY_SLOT`) and there are two bodies. In practice three or four: naked, fully dressed,
   * and whatever partial kit the world's mobs happen to wear. Each is an index buffer over the
   * template's own vertex attributes, so the vertex data uploads once however many masks are live.
   */
  private readonly masked = new Map<string, BufferGeometry>();
  /**
   * Bumped once, when a load finishes — the signal `entities.ts` watches to re-body the capsules.
   *
   * A counter rather than a boolean because the question is *"has this changed since I last looked"*,
   * and the answer has to be cheap enough to ask every frame: the load is not awaited (`main.ts`), so
   * the first second of a session has real entities standing in a real room with no pack behind them,
   * and without this they would stay capsules until they next changed clothes or the player next
   * changed rooms. One integer compare a frame against a re-scan of the room on the one frame it
   * moves.
   */
  private loads = 0;
  private textureCount = 0;
  private textureBytesOnWire = 0;
  private animationBytesOnWire = 0;

  /** Models whose every primitive is registered. `__debug3d.characters`. */
  private readonly ready = new Set<string>();

  get loaded(): number {
    return this.ready.size;
  }

  get textures(): number {
    return this.textureCount;
  }

  get textureBytes(): number {
    return this.textureBytesOnWire;
  }

  /** Bytes of re-cut animation GLB fetched — the number `buildAnimationLibrary` exists to reduce. */
  get animationBytes(): number {
    return this.animationBytesOnWire;
  }

  get clipCount(): number {
    return this.clipsByName.size;
  }

  /** True once a body can be drawn at all. `entities.ts` falls back to capsules until it is. */
  get available(): boolean {
    return this.bodies.size > 0;
  }

  /** Changes exactly once, when the pack lands. See {@link loads}. */
  get generation(): number {
    return this.loads;
  }

  /** The shared clip table, handed to every `BodyAnimator`. */
  get clips(): ReadonlyMap<string, AnimationClip> {
    return this.clipsByName;
  }

  body(stem: string): BodyTemplate | undefined {
    return this.bodies.get(stem);
  }

  part(stem: string): PartTemplate | undefined {
    return this.parts.get(stem);
  }

  hair(stem: string): HairTemplate | undefined {
    return this.hairs.get(stem);
  }

  /** How many hairstyles are registered. `__debug3d`, and the number a test joins on. */
  get hairCount(): number {
    return this.hairs.size;
  }

  weapon(stem: string): WeaponTemplate | undefined {
    return this.weapons.get(stem);
  }

  /**
   * The body's own skin geometry with the dressed regions dropped, cached per `(stem, mask)`.
   *
   * The pool is not asked to hold these: a masked index is a *derived view over a pooled geometry*
   * rather than an import, its count is bounded by the mask space rather than by the world, and
   * charging the geometry ledger for the same vertex buffer 32 times would make the honest proxy
   * dishonest — which is `registerGeometry`'s own argument about kit trees, one step further along.
   */
  maskedSkin(pool: ScenePool, template: BodyTemplate, mask: number): BufferGeometry | undefined {
    if (!template.skin) return undefined;
    const base = pool.hasGeometry(template.skin.primitive.geometry)
      ? pool.geometry(template.skin.primitive.geometry)
      : undefined;
    if (!base) return undefined;
    if (mask === 0) return base;
    const key = `${template.stem}|${mask}`;
    const held = this.masked.get(key);
    if (held) return held;
    const built = maskedGeometry(base, template.skin.regions, mask);
    this.masked.set(key, built);
    return built;
  }

  /** How many distinct culled bodies are alive — `__debug3d`, and the bound is 32. */
  get maskedGeometries(): number {
    return this.masked.size;
  }

  /**
   * Fetch the manifest, its textures, its models and its two animation libraries.
   *
   * **Never rejects**, `TreeSet.load`'s contract: a world with no people is M6's world, and it still
   * runs. What it does instead is return the reason so `main.ts` can log it.
   *
   * Textures before models, `kit.ts`'s ordering and its reason: a body registered before its atlas is
   * a character built white, and a white character is more wrong than a capsule.
   */
  async load(pool: ScenePool, base = './', manifestPath = CHARACTER_MANIFEST_PATH): Promise<string | undefined> {
    let manifest: CharacterManifest;
    try {
      const response = await fetch(`${base}${manifestPath}`);
      if (!response.ok) return `character manifest: HTTP ${response.status}`;
      manifest = (await response.json()) as CharacterManifest;
    } catch (error) {
      return `character manifest: ${String(error)}`;
    }
    if (manifest.version !== CHARACTER_MANIFEST_VERSION) {
      return `character manifest is version ${manifest.version}, this client reads ${CHARACTER_MANIFEST_VERSION} — re-run modelgen --characters`;
    }

    const loader = new TextureLoader();
    await Promise.all(
      manifest.textures.map(async (texture) => {
        try {
          const loaded = await loader.loadAsync(`${base}${texture.url}`);
          // Authored in sRGB; three's working space is linear and converts on sample only if told.
          // Left at the default every skin tone in the world comes out pale.
          loaded.colorSpace = SRGBColorSpace;
          loaded.name = `character:${texture.id}`;
          loaded.generateMipmaps = true;
          pool.registerTexture(`character:${texture.id}`, loaded, texture.width, texture.height);
          pool.dressKit(characterMaterialKey(texture.id), loaded);
          this.textureCount += 1;
          this.textureBytesOnWire += texture.bytes;
        } catch {
          // One atlas that will not load is one family drawn white, not a world with no people.
        }
      }),
    );

    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const gltf = new GLTFLoader();

    await Promise.all(
      manifest.models.map(async (model) => {
        try {
          const loaded = await gltf.loadAsync(`${base}${model.url}`);
          this.register(pool, model, loaded.scene);
          this.ready.add(model.stem);
        } catch {
          // One model that will not load is one model that is not drawn. A missing base body means
          // that sex draws as a capsule; a missing garment means a bare region, which the cull
          // already declines to hide because the gear list is what drives the mask.
        }
      }),
    );

    for (const library of manifest.animations ?? []) {
      try {
        const loaded = await gltf.loadAsync(`${base}${library.url}`);
        for (const clip of loaded.animations) this.clipsByName.set(clip.name, clip);
        this.animationBytesOnWire += library.bytes;
      } catch {
        // A library that will not load is a body that stands still. Everything else still works.
      }
    }

    this.loads += 1;
    if (this.bodies.size === 0) return 'character manifest loaded but no base body arrived';
    return undefined;
  }

  /**
   * Fill the registry with proportioned stand-ins — **the headless path**, `KitSet.standIn`'s twin.
   *
   * `traversal.test.ts` has to churn real bodies to assert the rig ledger is flat, and there is no
   * network, no GPU and no `GLTFLoader` in that process. What a stand-in must be is *registered*, with
   * a real 65-bone hierarchy under the real joint names, because the thing under test is the pool's
   * accounting and the rig's assembly — not the vendor's vertices.
   *
   * The bones are built here rather than imported so the names are this package's own statement of
   * what the armature is, and `characters.test.ts` asserts that statement against the manifest.
   */
  standIn(pool: ScenePool, jointNames: readonly string[], stems: readonly string[]): void {
    for (const stem of stems) {
      const geometryKey = characterGeometryKey(stem, STAND_IN_TEXTURE);
      pool.registerGeometry(geometryKey, standInGeometry(jointNames.length));
      const primitive: PartPrimitive = { geometry: geometryKey, material: characterMaterialKey(STAND_IN_TEXTURE) };
      // The same partition `modelgen.characterKind` draws, and it has to be: a stand-in that filed a
      // sword under `parts` would let the hand test pass with the weapon hung off the *body* instead
      // of off a bone, which is the exact bug the test exists to catch. Four branches since the hair
      // slice, in the same order and on the same stems.
      if (stem.startsWith('Superhero_')) {
        const bones = standInBones(jointNames);
        this.bodies.set(stem, {
          stem,
          bones,
          boneInverses: bones.map(() => new Matrix4()),
          jointNames,
          skin: { primitive, regions: standInRegions(jointNames) },
          extras: [],
          height: 1.8,
          // Identity, so a stand-in's refit matrix is the identity too and a headless test measures
          // the *plumbing* rather than the vendor's skulls.
          headInverse: new Matrix4(),
        });
      } else if (/^(Female|Male)_(Peasant|Ranger)_/.test(stem)) {
        this.parts.set(stem, { stem, primitives: [primitive] });
      } else if (stem.startsWith('Hair_')) {
        this.hairs.set(stem, { stem, primitives: [primitive], headInverse: new Matrix4() });
      } else {
        this.weapons.set(stem, { stem, primitives: [primitive] });
      }
      this.ready.add(stem);
    }
    this.loads += 1;
  }

  /** Every clip name the state machine reaches for that did not arrive. Empty is the healthy answer. */
  missingClips(): readonly ClipName[] {
    return CLIPS.filter((name) => !this.clipsByName.has(name));
  }

  private register(pool: ScenePool, model: CharacterModelEntry, scene: Object3D): void {
    const meshes: { mesh: Mesh; skinned: boolean }[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh) meshes.push({ mesh, skinned: (mesh as SkinnedMesh).isSkinnedMesh === true });
    });

    // Merge within a part, by material — see the header's note 3. Keyed by the glTF material's own
    // name, which `modelgen` recorded in the manifest for exactly this join.
    const byMaterial = new Map<string, { texture: string; geometries: BufferGeometry[] }>();
    for (const { mesh, skinned } of meshes) {
      if (Array.isArray(mesh.material)) continue;
      const name = (mesh.material as { name?: string } | undefined)?.name ?? '';
      const part = model.parts.find((candidate) => candidate.material === name);
      if (!part) continue;
      let geometry = mesh.geometry;
      if (!skinned) {
        // A prop's node transform is real geometry — the axe's −90° and its 0.847. Baked once here,
        // because the pool holds geometries and has nowhere to keep a node.
        geometry = geometry.clone();
        geometry.applyMatrix4(mesh.matrixWorld);
      }
      whiten(geometry);
      let bucket = byMaterial.get(part.texture);
      if (!bucket) {
        bucket = { texture: part.texture, geometries: [] };
        byMaterial.set(part.texture, bucket);
      }
      bucket.geometries.push(geometry);
    }

    const primitives: PartPrimitive[] = [];
    for (const [texture, bucket] of byMaterial) {
      const geometry = bucket.geometries.length === 1 ? bucket.geometries[0]! : mergeSame(bucket.geometries);
      geometry.name = `${model.stem}:${texture}`;
      const key = characterGeometryKey(model.stem, texture);
      pool.registerGeometry(key, geometry);
      primitives.push({ geometry: key, material: characterMaterialKey(texture) });
    }

    if (model.kind === 'weapon') {
      this.weapons.set(model.stem, { stem: model.stem, primitives });
      return;
    }
    if (model.kind === 'outfit') {
      this.parts.set(model.stem, { stem: model.stem, primitives });
      return;
    }
    if (model.kind === 'hair') {
      // The one thing a hairstyle carries that a garment does not — the skull it was authored on.
      // Dropped silently if the file arrives unrigged, which would make it undrawable rather than
      // wrongly drawn: see `HairTemplate.headInverse`.
      const rig = meshes.find((entry) => entry.skinned)?.mesh as SkinnedMesh | undefined;
      const headInverse = rig?.skeleton ? headInverseOf(rig) : undefined;
      if (headInverse) this.hairs.set(model.stem, { stem: model.stem, primitives, headInverse });
      return;
    }

    // A base body. Find the skinned mesh that carries the *skin* — the biggest one, which is also the
    // only one whose material is not the eye or the eyebrow atlas — and label its vertices.
    const skinned = meshes.find((entry) => entry.skinned)?.mesh as SkinnedMesh | undefined;
    if (!skinned?.skeleton) return;
    const jointNames = skinned.skeleton.bones.map((bone) => bone.name);
    const biggest = meshes
      .filter((entry) => entry.skinned)
      .sort((a, b) => (b.mesh.geometry.getIndex()?.count ?? 0) - (a.mesh.geometry.getIndex()?.count ?? 0))[0];
    const skinTexture = biggest
      ? model.parts.find((part) => part.material === ((biggest.mesh.material as { name?: string }).name ?? ''))?.texture
      : undefined;

    let skin: BodyTemplate['skin'];
    const extras: PartPrimitive[] = [];
    for (const primitive of primitives) {
      if (skinTexture !== undefined && primitive.geometry === characterGeometryKey(model.stem, skinTexture)) {
        const geometry = pool.geometry(primitive.geometry);
        const joints = geometry.getAttribute('skinIndex');
        const weights = geometry.getAttribute('skinWeight');
        if (joints && weights) {
          skin = {
            primitive,
            regions: vertexRegions(joints.array as ArrayLike<number>, weights.array as ArrayLike<number>, jointNames),
          };
          continue;
        }
      }
      extras.push(primitive);
    }

    this.bodies.set(model.stem, {
      stem: model.stem,
      bones: skinned.skeleton.bones,
      boneInverses: skinned.skeleton.boneInverses,
      jointNames,
      ...(skin ? { skin } : {}),
      extras,
      height: model.height,
      headInverse: headInverseOf(skinned) ?? new Matrix4(),
    });
  }
}

/**
 * A skinned mesh's own inverse-bind matrix for {@link HEAD_BONE}, or nothing when the rig has no such
 * joint.
 *
 * Read by **name** rather than by index, which is the discipline `skin.regionOfJoint` already states
 * for the same reason: the name is the thing all four packs agree on, and an index-based read would be
 * one vendor re-export away from fitting a hairstyle to somebody's pelvis.
 */
function headInverseOf(mesh: SkinnedMesh): Matrix4 | undefined {
  const at = mesh.skeleton.bones.findIndex((bone) => bone.name === HEAD_BONE);
  return at < 0 ? undefined : mesh.skeleton.boneInverses[at];
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Give a primitive a white colour attribute if it has none — `kit.ts`'s `normalise`, one material
 * family over.
 *
 * `USE_COLOR_ALPHA` is a `#define` and the pool's character material is `vertexColors: true` without
 * exception, so a missing attribute reads as `(0,0,0,1)` and multiplies the whole body to black. Every
 * character primitive measured on 2026-08-13 *does* carry one; this is the guard for the one that will
 * not, in a pack re-export nobody was watching.
 */
function whiten(geometry: BufferGeometry): void {
  if (geometry.getAttribute('color')) return;
  const count = geometry.getAttribute('position')?.count ?? 0;
  geometry.setAttribute('color', new BufferAttribute(new Uint8Array(count * 4).fill(255), 4, true));
}

/**
 * Concatenate primitives that share a material — the merge described in note 3.
 *
 * Hand-rolled rather than `BufferGeometryUtils.mergeGeometries`, for the reason `body.cloneBones`
 * gives about `SkeletonUtils`: this needs twenty lines and the alternative is a second
 * `three/examples` chunk in the boot path.
 *
 * **The attribute set is the intersection, and it has to be**: `Female_Ranger_Body`'s coat carries
 * `JOINTS_1`/`WEIGHTS_1` (a second set of four bone influences) and its two belts do not. Three's
 * skinning shader reads four influences and no more, so the extra set is already ignored; dropping it
 * here is the same decision made where it can be stated.
 *
 * **Values are read through `getComponent`, never off the raw array**, because `color` arrives as a
 * *normalized* `Uint8Array`: copying its bytes into a `Float32Array` would turn 1.0 into 255.0 and
 * multiply every merged garment to white. `getComponent` denormalises; the output is plain floats.
 */
function mergeSame(parts: readonly BufferGeometry[]): BufferGeometry {
  const first = parts[0]!;
  const out = new BufferGeometry();
  for (const name of Object.keys(first.attributes)) {
    if (!parts.every((part) => part.getAttribute(name))) continue;
    const size = (first.getAttribute(name) as BufferAttribute).itemSize;
    let total = 0;
    for (const part of parts) total += part.getAttribute(name)!.count;
    const array = new Float32Array(total * size);
    let at = 0;
    for (const part of parts) {
      const source = part.getAttribute(name) as BufferAttribute;
      for (let i = 0; i < source.count; i++) {
        for (let c = 0; c < size; c++) array[at + i * size + c] = source.getComponent(i, c);
      }
      at += source.count * size;
    }
    out.setAttribute(name, new BufferAttribute(array, size, false));
  }
  const indices: number[] = [];
  let offset = 0;
  for (const part of parts) {
    const index = part.getIndex();
    const count = part.getAttribute('position')?.count ?? 0;
    if (index) for (let i = 0; i < index.count; i++) indices.push((index.array as ArrayLike<number>)[i]! + offset);
    else for (let i = 0; i < count; i++) indices.push(i + offset);
    offset += count;
  }
  out.setIndex(indices);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Stand-ins                                                                   */
/* -------------------------------------------------------------------------- */

/** A one-triangle skinned primitive: enough for the pool to hold and for a rig to bind. */
function standInGeometry(joints: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0, 1, 0, 0.2, 0, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0]), 2));
  geometry.setAttribute('color', new BufferAttribute(new Uint8Array(12).fill(255), 4, true));
  // Weighted to three different joints so a stand-in exercises the region cull rather than sidestepping
  // it: the middle vertex sits on the spine, the others on a thigh and a hand.
  const spine = Math.min(3, joints - 1);
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array([0, 0, 0, 0, spine, 0, 0, 0, 1, 0, 0, 0]), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  geometry.setIndex([0, 1, 2]);
  return geometry;
}

function standInRegions(jointNames: readonly string[]): Uint8Array {
  const geometry = standInGeometry(jointNames.length);
  return vertexRegions(
    geometry.getAttribute('skinIndex').array as ArrayLike<number>,
    geometry.getAttribute('skinWeight').array as ArrayLike<number>,
    jointNames,
  );
}

/** A flat chain of correctly-named bones. Only the names and the count are load-bearing headless. */
function standInBones(jointNames: readonly string[]): Bone[] {
  const out: Bone[] = [];
  for (const name of jointNames) {
    const bone = new Bone();
    bone.name = name;
    out.push(bone);
  }
  for (let i = 1; i < out.length; i++) out[0]!.add(out[i]!);
  return out;
}
