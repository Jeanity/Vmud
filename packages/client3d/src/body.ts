/**
 * One character, assembled — the base body with its dressed regions culled, the garments that
 * replaced them, the props in its hands, and the mixer that moves all of it on one skeleton.
 *
 * This is the pool's first **per-entity** allocation and the file that spends it. `pool.ts` owns the
 * ledger and the free list ({@link ScenePool.acquireBody}); this owns what a rig actually is, which is
 * the same split `registerGeometry` already draws — the pool counts bytes it did not build.
 *
 * ## What is per rig, and what is shared
 *
 * | Per rig | Shared |
 * |---|---|
 * | 65 `Bone`s, cloned from the template | the template's own bones, never in a scene |
 * | one `Skeleton` (4,160 B of matrices, a 20x20 bone texture) | the `boneInverses` behind it |
 * | one `AnimationMixer` | all sixteen `AnimationClip`s |
 * | one `SkinnedMesh` per drawn primitive | every geometry and all twelve materials |
 *
 * A `SkinnedMesh` allocates nothing on the GPU of its own: the geometry is the pool's and the
 * material is the pool's. What a rig costs is the skeleton, and {@link ScenePool.BODY_POOL_SIZE} is
 * the arithmetic for how many of them there may be.
 *
 * ## Two things that are easy to get wrong and are done once, here
 *
 * 1. **`bind` is always given an explicit matrix.** `SkinnedMesh.bind(skeleton)` with no second
 *    argument calls `skeleton.calculateInverses()`, which would overwrite the base body's inverse-bind
 *    matrices with ones derived from the current pose — and the current pose, one frame into a walk
 *    cycle, is not the bind pose. The result is a body that melts. Every part's own bind matrix is
 *    identity (asserted in `characters.test.ts`), so {@link IDENTITY} is what goes in.
 *
 *    **One exception, and it is the hair slice's whole mechanism**: a hairstyle authored on the other
 *    sex's skull is bound with `IBM_body(Head)⁻¹ · IBM_hair(Head)` instead. `bindMatrix` is a shader
 *    uniform that multiplies the vertex *before* the bone matrices, and in `AttachedBindMode` its
 *    partner `bindMatrixInverse` is recomputed each frame from the mesh's own world matrix and never
 *    from `bindMatrix` — so a non-identity value there is a clean pre-transform rather than a thing
 *    that cancels. See `characters.HairTemplate.headInverse` for the derivation and the measurement.
 * 2. **`frustumCulled` is off on every body mesh.** A skinned mesh's bounding sphere is the *bind
 *    pose's*, and a sword swing reaches well outside it, so a character at the edge of the frame
 *    vanishes for the half-second it is doing the most interesting thing it does. At a cap of 24
 *    bodies the saved culling test is worth nothing and the pop is worth avoiding.
 *
 * ## `creature:` bodies do not come here
 *
 * A wolf has no mesh (`appearance.CREATURE_PREFIX`) and `entities.ts` keeps drawing it as a capsule,
 * tinted and proportioned per class so it reads as an animal rather than as a player nobody dressed.
 * See {@link CREATURE_LOOK} — it is documented interim, and it fails a test on purpose the day a
 * monster pack lands.
 */

import {
  Group,
  Matrix4,
  Mesh,
  Object3D,
  Skeleton,
  SkinnedMesh,
  type AnimationClip,
  type Bone,
  type BufferGeometry,
} from 'three';

import { BodyAnimator, BodyMotion, turnToward, type MotionSubject } from './anim.ts';
import type { BodyTemplate, CharacterSet, PartPrimitive } from './characters.ts';
import { MAIN_HAND_BONE, OFF_HAND_BONE } from './characters.ts';
import { WORLD_LAYER } from './lights.ts';
import type { PooledRig, ScenePool } from './pool.ts';
import { hiddenMaskFor } from './skin.ts';

/** Passed to every `bind`, never mutated. See the header's note 1. */
const IDENTITY = new Matrix4();

/**
 * What to add to a heading to point *this vendor's* mesh along it. **π — measured, not assumed.**
 *
 * `space.ts`'s {@link yawOf} says the protocol's yaw is `rotation.y` directly *"for a mesh whose rest
 * forward is `-Z` — which is Three.js' own convention and the Quaternius packs'"*. The first half is
 * true and the second half is **false**, which is the whole of the owner's 2026-08-13 report that
 * their character *"wants to run backwards when I'm moving forwards"* — and it was never about
 * combat, as the first guess had it, because it is not conditional on anything at all.
 *
 * Measured off `superhero-male-full-body/model.gltf` by composing the rest hierarchy's full TRS (the
 * rig is Unreal-named — `pelvis`, `foot_l`, `ball_l` — and its bones run along local Y, so composing
 * translations alone answers a different question and answers it wrongly):
 *
 * ```
 *   foot_l  [ 0.114, 0.086, -0.088]
 *   ball_l  [ 0.114, 0.015,  0.055]      ball - foot = [0, -0.071, +0.142]
 * ```
 *
 * **The toes point `+Z`.** So a body handed a yaw of 0 — due north, `-Z` — stood with its back to
 * north and walked that way with a forward gait, at every heading, for every character in the world.
 * The female base body measures the same, so this is the pack's convention rather than one export's
 * accident.
 *
 * It lives here and **not** in `yawOf`, deliberately: the protocol's yaw is a *heading*, correct as
 * it stands and shared with the camera, the compass and follow mode — all three of which are right
 * today and would break together if the heading were bent to suit one vendor's mesh. This is the
 * renderer's own adapter, applied where the mesh meets the scene graph, which is the only place that
 * knows which way a given asset happens to face.
 */
export const MODEL_FORWARD_OFFSET = Math.PI;

/**
 * Where a prop sits in the hand it is held by — **measured, not guessed.**
 *
 * Every bone in this armature runs down its own local `+Y` (each has `position = (0, length, 0)`), and
 * the forearm direction expressed in `hand_r`'s local space measures `(0, 1, 0.031)` — so *out of the
 * fist* is local `+Y` and a prop authored with its grip at the origin and its length along `+Y`
 * attaches at identity. All four are authored exactly that way; the baked bounding boxes are:
 *
 * ```
 *   Sword_Bronze   y -0.208 .. 0.924   pommel behind the palm, blade ahead
 *   Axe_Bronze     y -0.381 .. 0.446   haft along Y, head offset in -X (node rotation baked in)
 *   Torch_Metal    y -0.278 .. 0.371   shaft along Y, the bowl forward in +Z
 *   Shield_Wooden  x/y +-0.28, z 0.027 .. 0.139   a disc in the XY plane, face normal +Z
 * ```
 *
 * So three of the four take a small slide along `+Y` to bring the middle of the grip into the palm,
 * and the shield takes a quarter turn about `X` — which sends its `+Z` face normal to `+Y`, i.e.
 * punched out along the forearm, which is how a 0.56 m round shield is carried.
 *
 * **These are the numbers to nudge if a blade looks wrong in the owner's hand**, and they are the only
 * hand-tuned constants in the milestone. Everything else is measured off the packs.
 */
export const GRIP: Readonly<Record<string, { readonly y: number; readonly rx: number }>> = {
  Sword_Bronze: { y: 0.1, rx: 0 },
  Axe_Bronze: { y: 0.12, rx: 0 },
  Torch_Metal: { y: 0.1, rx: 0 },
  Shield_Wooden: { y: 0.08, rx: -Math.PI / 2 },
};

/**
 * What a `creature:` placeholder looks like — **interim, and it says so.**
 *
 * `appearance.ts` emits `creature:<ULPC head shape>` for the world's animals because *Ultimate
 * Monsters* is not purchasable (`PLAN-3d-migration.md`'s 2026-08-13 amendment). Measured over the
 * 1,503 templates that is 15 bodies, of which about six are true animals — so this table is small on
 * purpose and its job is only to stop a wolf reading as a person nobody dressed.
 *
 * Colour, height and girth, in metres. A wolf is low and long and grey; a boar is squat and brown; a
 * rat is small and dark. The remaining shapes take the default, which is *"an animal we have no model
 * for"* rather than *"a person"* — and that is the whole distinction the table exists to draw.
 *
 * **The day a monster pack lands this table is deleted**, not extended: `characters.test.ts` asserts
 * that every `creature:` id `appearanceOf` can emit is either here or takes the default, so a real
 * mesh arriving makes the placeholder path visibly dead code.
 */
export interface CreatureLook {
  readonly colour: number;
  readonly height: number;
  readonly radius: number;
}

export const CREATURE_LOOK: Readonly<Record<string, CreatureLook>> = {
  wolf: { colour: 0x6b6660, height: 0.85, radius: 0.38 },
  boarman: { colour: 0x6b4f36, height: 1.0, radius: 0.45 },
  pig: { colour: 0xa8797a, height: 0.7, radius: 0.4 },
  sheep: { colour: 0xd9d3c4, height: 0.85, radius: 0.4 },
  rabbit: { colour: 0xa2907a, height: 0.4, radius: 0.2 },
  rat: { colour: 0x4a423a, height: 0.3, radius: 0.18 },
  mouse: { colour: 0x6b625a, height: 0.22, radius: 0.13 },
};

/** Anything `CREATURE_LOOK` has no row for: dun, knee-high, and visibly not a person. */
export const CREATURE_DEFAULT: CreatureLook = { colour: 0x7a6f60, height: 0.8, radius: 0.35 };

/** What is currently hung on a rig, as one string, so a re-dress is one comparison. */
function dressKey(
  model: string,
  gear: readonly { readonly slot: string; readonly part: string }[] | undefined,
  main: string | undefined,
  off: string | undefined,
  hair: string | undefined,
): string {
  const worn = gear ? gear.map((entry) => `${entry.slot}=${entry.part}`).join(',') : '';
  return `${model}|${worn}|${main ?? ''}|${off ?? ''}|${hair ?? ''}`;
}

/**
 * One assembled character.
 *
 * Created through {@link acquireRig} so the pool sees it, parked and re-dressed on reuse, and disposed
 * exactly once at teardown.
 */
export class BodyRig implements PooledRig {
  readonly group = new Group();
  readonly motion = new BodyMotion();
  readonly template: BodyTemplate;

  private readonly set: CharacterSet;
  private readonly pool: ScenePool;
  private readonly bones: Bone[];
  private readonly skeleton: Skeleton;
  private readonly animator: BodyAnimator;
  private readonly byName = new Map<string, Bone>();
  /** Meshes currently drawn. Rebuilt whole on a re-dress: a body changes kit a handful of times a session. */
  private readonly drawn: SkinnedMesh[] = [];
  /** Props, which hang off bones rather than off the group and so are tracked apart. */
  private readonly held: Object3D[] = [];
  private worn = '';
  /** Yaw actually drawn, chasing the wire's at `anim.TURN_RATE`. */
  private yaw = 0;
  private yawSeeded = false;
  /**
   * Which render layer everything this rig draws belongs to — see {@link setLayer}.
   *
   * A field and not just a one-off traversal, because a rig's meshes are **not** the meshes it will
   * be drawing in a minute: `dress` throws all of them away and builds new ones every time the wearer
   * changes kit, and `hold` mints a fresh holder for each hand. A layer applied once and not
   * remembered would survive exactly until the player drew their sword, at which point the sword
   * would be lit by a lamp the hand holding it is not.
   */
  private layer = WORLD_LAYER;

  constructor(set: CharacterSet, pool: ScenePool, template: BodyTemplate, clips: ReadonlyMap<string, AnimationClip>) {
    this.set = set;
    this.pool = pool;
    this.template = template;
    this.bones = cloneBones(template.bones);
    for (const bone of this.bones) this.byName.set(bone.name, bone);
    // A shallow copy of the inverse array: the `Matrix4`s are shared (nothing writes them) but the
    // array is this skeleton's, so a future three that sorted or spliced it could not reach across.
    this.skeleton = new Skeleton(this.bones, [...template.boneInverses]);
    // The root bone — the one whose parent is not itself a bone — carries the whole hierarchy.
    for (const bone of this.bones) {
      if (!bone.parent) this.group.add(bone);
    }
    this.animator = new BodyAnimator(this.group, clips);
    this.group.name = `body:${template.stem}`;
  }

  /** The mixer's clip-length lookup, in the shape `BodyMotion` wants. */
  readonly clipSeconds = (clip: Parameters<BodyAnimator['durationOf']>[0]): number => this.animator.durationOf(clip);

  /**
   * Draw this rig — and everything hanging off it — on one render layer and no other.
   *
   * `lights.SELF_LAYER` for the player's own body, `lights.WORLD_LAYER` for everybody else, and the
   * difference is which of the two render passes draws it. See `lights.SELF_LAYER` for the whole
   * mechanism and `post.BodyPass` for the pass.
   *
   * **`Object3D.layers` is not inherited.** Three tests each object's own mask, so setting the group
   * and stopping there would move nothing at all — the group is not drawn, and `projectObject`
   * recurses into a group's children whether or not the group itself passed the test. So this walks
   * what is actually drawn: the skinned meshes (the naked body, every garment, the hair), and every
   * prop hanging off a hand bone. {@link add} and {@link hold} then apply {@link layer} to whatever
   * they mint next, which is what carries the rule across a change of clothes.
   *
   * The bones are deliberately left alone. They are `Object3D`s in the graph but nothing draws them,
   * and walking 65 of them per rig to write a mask no renderer reads would be work for its own sake.
   */
  setLayer(layer: number): void {
    this.layer = layer;
    this.group.layers.set(layer);
    for (const mesh of this.drawn) mesh.layers.set(layer);
    for (const holder of this.held) holder.traverse((object) => object.layers.set(layer));
  }

  /** Which layer this rig draws on. `__debug3d`, and the test that follows a rig through a re-dress. */
  get drawnLayer(): number {
    return this.layer;
  }

  /**
   * (Re)build the meshes for a model, a gear list and two hands — idempotent, and cheap when nothing
   * changed.
   *
   * Called on `entityEnter` and on every `entityUpdate`, which is every kit change and every tick a
   * watcher's view is resynced. The guard is a single string comparison, so a body that has not
   * changed clothes costs nothing at all; a body that has pays one pass over at most eight primitives.
   */
  dress(
    model: string,
    gear: readonly { readonly slot: string; readonly part: string }[] | undefined,
    main: string | undefined,
    off: string | undefined,
    hair?: string | undefined,
  ): void {
    const key = dressKey(model, gear, main, off, hair);
    if (key === this.worn) return;
    this.worn = key;
    this.clearMeshes();

    // The base body, with the regions its gear replaces dropped. See `skin.ts` for the measurement
    // that makes this necessary: the garments sit *inside* the naked silhouette, so drawing both is a
    // body worn over its own clothes.
    const mask = hiddenMaskFor((gear ?? []).map((entry) => entry.slot));
    const skin = this.set.maskedSkin(this.pool, this.template, mask);
    if (skin && this.template.skin) this.add(skin, this.template.skin.primitive.material);
    for (const primitive of this.template.extras) this.addPrimitive(primitive);

    for (const entry of gear ?? []) {
      const part = this.set.part(stemOf(entry.part));
      if (!part) continue;
      for (const primitive of part.primitives) this.addPrimitive(primitive);
    }

    // **Hair goes through the same composition path as a garment, with one matrix of difference.**
    // It is not in the gear list — a garment replaces a region of the naked mesh and hair replaces
    // nothing, so `hiddenMaskFor` above must never see it — but from here down it is a primitive on
    // the same skeleton like any other. The bind matrix is the whole of the refit: see
    // `characters.HairTemplate.headInverse` for why it is a uniform rather than a geometry copy, and
    // note it is the *identity* whenever the style named the mesh authored for this body's sex.
    if (hair) {
      const style = this.set.hair(stemOf(hair));
      if (style) {
        const refit = new Matrix4().copy(this.template.headInverse).invert().multiply(style.headInverse);
        for (const primitive of style.primitives) this.addPrimitive(primitive, refit);
      }
    }

    this.hold(MAIN_HAND_BONE, main);
    this.hold(OFF_HAND_BONE, off);
  }

  /**
   * Place the rig in the world. `y` is the ground; the base bodies' feet are at their own origin.
   *
   * `scale` is `EntityView.scale`, and it is applied to the **group** rather than to any mesh, which
   * is the only place it can go: a `SkinnedMesh` in `AttachedBindMode` cancels its own world matrix
   * out of the skinning product, so scaling one does nothing at all. Scaling the group scales the
   * bones with it — they are its children — so the whole rig, its clothes, its hair and whatever is in
   * its hands come down together. A child's sword is a child-sized sword, which is right.
   */
  place(x: number, y: number, z: number, scale = 1): void {
    this.group.position.set(x, y, z);
    this.group.scale.setScalar(scale);
  }

  /**
   * Turn toward the wire's yaw at {@link anim.TURN_RATE}, and advance the animation.
   *
   * The first call **snaps**, deliberately: a body that has just entered the room has no previous
   * heading to turn from, and easing it from north would spin every arrival. Every call after that
   * takes the short way round at the documented rate.
   */
  update(seconds: number, wantedYaw: number, moved: number, subject: MotionSubject): void {
    if (!this.yawSeeded) {
      this.yaw = wantedYaw;
      this.yawSeeded = true;
    } else {
      this.yaw = turnToward(this.yaw, wantedYaw, seconds);
    }
    this.group.rotation.y = this.yaw + MODEL_FORWARD_OFFSET;
    this.motion.advance(seconds, moved);
    this.animator.apply(this.motion.motion(subject), seconds);
  }

  /** The heading actually drawn — the *body's*, before {@link MODEL_FORWARD_OFFSET}. For `__debug3d`. */
  get drawnYaw(): number {
    return this.yaw;
  }

  /** Off the scene graph and back to a standing, undressed, living body. `PooledRig`. */
  park(): void {
    this.group.removeFromParent();
    this.clearMeshes();
    this.animator.reset();
    this.motion.reset();
    this.worn = '';
    this.yawSeeded = false;
    // Back to the world's layer, because the next entity to be handed this rig out of the free list
    // is overwhelmingly likely to be a mob. A rig that kept `SELF_LAYER` from its last tenant would
    // hand the next one the player's exemption: a kobold drawn in the body pass, unlit by the torch
    // it is standing in and invisible to every other player in the room.
    this.setLayer(WORLD_LAYER);
  }

  dispose(): void {
    this.park();
    this.animator.dispose();
    // The bone texture is the one GPU resource a rig owns outright. Everything else it draws with
    // belongs to the pool and is released there.
    this.skeleton.dispose();
  }

  private hold(boneName: string, id: string | undefined): void {
    if (!id) return;
    const stem = stemOf(id);
    const weapon = this.set.weapon(stem);
    const bone = this.byName.get(boneName);
    if (!weapon || !bone) return;
    const grip = GRIP[stem] ?? { y: 0, rx: 0 };
    const holder = new Object3D();
    holder.position.set(0, grip.y, 0);
    holder.rotation.set(grip.rx, 0, 0);
    for (const primitive of weapon.primitives) {
      if (!this.pool.hasGeometry(primitive.geometry) || !this.pool.hasMaterial(primitive.material)) continue;
      // **A prop is rigid and is a plain `Mesh`.** Its geometry carries no `skinIndex`, so a
      // `SkinnedMesh` would either draw nothing or draw it at the origin; what it wants is the hand
      // bone's own matrix, which parenting gives it for free. The honest cost is a second compiled
      // program — `USE_SKINNING` is an *object* define, not a material one — and it is charged
      // explicitly rather than hidden: see `pool.programKeyOf` and `prototypes.CHARACTER_PROP_TEXTURES`.
      const mesh = new Mesh(this.pool.geometry(primitive.geometry), this.pool.material(primitive.material));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      // A sword is drawn by whichever pass draws the hand holding it. See {@link setLayer}.
      mesh.layers.set(this.layer);
      holder.add(mesh);
    }
    holder.layers.set(this.layer);
    bone.add(holder);
    this.held.push(holder);
  }

  private addPrimitive(primitive: PartPrimitive, bindMatrix?: Matrix4): void {
    // Both halves gated: a geometry the pool never took is a part that failed to load, and a material
    // it has no key for is a pack that grew an atlas. Either is one mesh not drawn, never a throw
    // inside a frame — see `ScenePool.hasMaterial`.
    if (!this.pool.hasGeometry(primitive.geometry) || !this.pool.hasMaterial(primitive.material)) return;
    this.add(this.pool.geometry(primitive.geometry), primitive.material, bindMatrix);
  }

  private add(geometry: BufferGeometry, material: string, bindMatrix?: Matrix4): void {
    if (!this.pool.hasMaterial(material)) return;
    const mesh = new SkinnedMesh(geometry, this.pool.material(material));
    // Note 1: an explicit matrix, never the no-argument form. See the header. Identity for everything
    // but a hairstyle authored on the other sex's skull, whose refit *is* this argument.
    mesh.bind(this.skeleton, bindMatrix ?? IDENTITY);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Note 2: a bind-pose bounding sphere cannot contain a sword swing.
    mesh.frustumCulled = false;
    // Note 3: a re-dress builds new meshes, so the layer is applied here rather than once from
    // outside. See {@link setLayer} — the hair a player puts on is drawn by the same pass they are.
    mesh.layers.set(this.layer);
    this.group.add(mesh);
    this.drawn.push(mesh);
  }

  private clearMeshes(): void {
    for (const mesh of this.drawn) mesh.removeFromParent();
    this.drawn.length = 0;
    for (const holder of this.held) holder.removeFromParent();
    this.held.length = 0;
  }
}

/**
 * A rig for one entity, through the pool so it lands on the ledger — or `undefined` at the cap.
 *
 * The caller draws a capsule when this answers nothing. See {@link ScenePool.acquireBody}.
 */
export function acquireRig(set: CharacterSet, pool: ScenePool, model: string): BodyRig | undefined {
  const template = set.body(stemOf(model));
  if (!template) return undefined;
  const rig = pool.acquireBody(template.stem, () => new BodyRig(set, pool, template, set.clips));
  return rig as BodyRig | undefined;
}

/** `base:Superhero_Male_FullBody` to `Superhero_Male_FullBody`. Prefixed ids, never paths — M7a's rule. */
export function stemOf(id: string): string {
  const colon = id.indexOf(':');
  return colon < 0 ? id : id.slice(colon + 1);
}

/**
 * Clone a bone hierarchy — 65 fresh `Bone`s with the template's names and rest transforms.
 *
 * Hand-rolled rather than `SkeletonUtils.clone`, and it is the same trade `characters.mergeSame`
 * makes: that helper clones the *whole* subtree including its `SkinnedMesh`es, which would leave every
 * rig carrying a copy of the base body's meshes still bound to the template's skeleton, and it is a
 * second `three/examples` chunk in the boot path. What is actually needed is fifteen lines.
 *
 * Parentage is rebuilt by index against the source array, so a bone whose parent is not itself a joint
 * (the armature node) becomes a root and is added to the rig's group by the caller.
 */
function cloneBones(source: readonly Bone[]): Bone[] {
  const at = new Map<Bone, number>();
  source.forEach((bone, index) => at.set(bone, index));
  const out = source.map((bone) => {
    const copy = bone.clone(false);
    copy.name = bone.name;
    copy.position.copy(bone.position);
    copy.quaternion.copy(bone.quaternion);
    copy.scale.copy(bone.scale);
    return copy;
  });
  source.forEach((bone, index) => {
    const parent = bone.parent as Bone | null;
    const parentIndex = parent ? at.get(parent) : undefined;
    if (parentIndex !== undefined) out[parentIndex]!.add(out[index]!);
  });
  return out;
}
