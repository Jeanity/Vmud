/**
 * The loot sparkle — one glint standing over one thing on the floor, and the renderer's second
 * per-entity skeleton.
 *
 * `body.ts`'s twin, and deliberately built to the same shape: `props.ts` owns the *registry* (the
 * template a rig is cloned from), `pool.ts` owns the *ledger* and the free list
 * ({@link ScenePool.acquireSparkle}), and this owns what a rig actually is. That is
 * `registerGeometry`'s split for the third time — the pool counts what it did not build.
 *
 * ## Why this cannot be an `InstancedMesh`, which everything else on a floor is
 *
 * The bone piles a corpse draws (`entities.objectMesh`, `b3e44bb`) are instanced: one wrapper, 32
 * matrices, one draw. A sparkle cannot join them, and the reason is the same one that makes a body
 * expensive — **skinning reads a per-mesh bone texture**, so two instances of one skinned mesh are two
 * copies of one pose. Two sparkles on an instanced mesh would be one sparkle drawn twice, in step.
 *
 * And in step is exactly what must not happen. The clip is `Idle_Loop`, 2.4 s, **five rotation
 * channels — one per glint bone (`g1`..`g5`), each on its own independent 25-key path**. That
 * independence is measured and is the whole effect: a uniform spin or a uniform pulse does not
 * reproduce it, which is why the import kept the seven-joint rig instead of baking the motion out.
 * A room of items all glinting on the same frame reads as machinery, so on top of that each rig's
 * mixer is started at {@link phaseOf} — a hash of the entity id, spread over the clip's own length.
 *
 * ## What is per rig, and what is shared
 *
 * | Per rig | Shared |
 * |---|---|
 * | 7 `Bone`s, cloned from the template | the template's own bones, never in a scene |
 * | one `Skeleton` (448 B of matrices, an 8x8 bone texture) | the `boneInverses` behind it |
 * | one `AnimationMixer` | the one `AnimationClip` |
 * | one `SkinnedMesh` | the merged geometry and all eight fade materials |
 *
 * **1,472 B a rig** — 13.9% of a body's 10,560. See {@link pool.SPARKLE_POOL_SIZE} for the cap, for
 * the world it was measured against, and for what happens past it.
 *
 * ## The two things `body.ts` had to get right, and they are the same two here
 *
 * 1. **`bind` is always given an explicit matrix.** The no-argument form calls
 *    `skeleton.calculateInverses()`, which derives inverse-bind matrices from the *current* pose — and
 *    a tenth of a second into a phase-offset loop that is not the bind pose. The result would be a
 *    sparkle that melts. The import's own inverse-bind matrices are what the template carries.
 * 2. **`frustumCulled` is off.** A skinned mesh's bounding sphere is the bind pose's, and the glints
 *    swing outside it; at a cap of 41 the saved culling test is worth nothing and the pop is not.
 */

import { AnimationMixer, Group, Matrix4, SkinnedMesh, Skeleton, type Bone } from 'three';

import { WORLD_LAYER } from './lights.ts';
import type { PooledRig, ScenePool } from './pool.ts';
import type { AnimatedTemplate } from './props.ts';
import { sparkleMaterialKey } from './prototypes.ts';

/** Passed to every `bind`, never mutated. See the header's note 1. */
const IDENTITY = new Matrix4();

/** The clip every animated object plays. One, and it loops for ever. */
export const SPARKLE_CLIP = 'Idle_Loop';

/**
 * The clip's own length in seconds — **2.4, measured off the import**, and the fallback when the
 * template arrived without its animation.
 *
 * Only ever used as the span a phase is spread over. A wrong number here would make the phases cluster
 * rather than spread, which is a duller room and not a broken one.
 */
export const SPARKLE_CLIP_SECONDS = 2.4;

/**
 * Where in the loop this entity's sparkle starts — a hash of its id, in `[0, 1)`.
 *
 * **FNV-1a over the decimal digits**, and an integer hash rather than anything trigonometric because
 * the ids it is fed are consecutive: `ground.ts` counts down from `-2,000,000` one per drop, so ten
 * things dropped in a row differ by ten in the last digit. `Math.sin(id)`-style hashes are notoriously
 * smooth over exactly that input and would have put a whole floor within a few frames of each other —
 * the failure this function exists to avoid, wearing a different hat.
 *
 * Deterministic, and pure: two clients watching one room see the same floor glinting the same way,
 * which costs nothing and is the sort of thing that is impossible to add later.
 */
export function phaseOf(id: number): number {
  let hash = 0x811c9dc5;
  const text = String(id);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return ((hash >>> 0) % 100_000) / 100_000;
}

/**
 * One assembled sparkle.
 *
 * Created through {@link acquireSparkle} so the pool sees it, parked on release, and disposed exactly
 * once at teardown. Fields are declared and assigned in the constructor body rather than written as
 * parameter properties — `CLAUDE.md` gotcha 8, and this module is reachable from a headless test.
 */
export class SparkleRig implements PooledRig {
  readonly group = new Group();

  private readonly pool: ScenePool;
  private readonly bones: Bone[];
  private readonly skeleton: Skeleton;
  private readonly mixer: AnimationMixer;
  private readonly mesh: SkinnedMesh | undefined;
  /** Which rung of the fade ladder is currently hung on the mesh. See {@link fade}. */
  private step = -1;

  constructor(pool: ScenePool, template: AnimatedTemplate) {
    this.pool = pool;
    this.bones = cloneBones(template.bones);
    // A shallow copy of the inverse array, `BodyRig`'s reason exactly: the `Matrix4`s are shared
    // because nothing writes them, but the array is this skeleton's.
    this.skeleton = new Skeleton(this.bones, [...template.boneInverses]);
    for (const bone of this.bones) {
      if (!bone.parent) this.group.add(bone);
    }
    this.mixer = new AnimationMixer(this.group);
    this.group.name = 'sparkle';
    this.group.layers.set(WORLD_LAYER);

    // The mesh is built once and kept: unlike a body this rig never changes what it draws, so there is
    // no `dress` and no re-mint. A template whose geometry never registered draws nothing at all, which
    // `entities.ts` then falls back out of — the same both-halves-gated rule `BodyRig.addPrimitive`
    // states.
    if (pool.hasGeometry(template.geometry)) {
      const mesh = new SkinnedMesh(pool.geometry(template.geometry), pool.material(sparkleMaterialKey(0)));
      mesh.bind(this.skeleton, IDENTITY);
      // **A glint of light casts no shadow and catches none.** Both are off rather than inherited: a
      // 0.42 m sparkle in the shadow pass is a draw call spent on a smudge, and a sparkle that darkened
      // under the tree it was lying beneath would be reporting the wrong thing entirely.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.layers.set(WORLD_LAYER);
      this.group.add(mesh);
      this.mesh = mesh;
    }

    const clip = template.clips.get(SPARKLE_CLIP);
    if (clip) this.mixer.clipAction(clip).play();
  }

  /** Whether this rig actually drew anything — false when the model never made it into the pool. */
  get drawn(): boolean {
    return this.mesh !== undefined;
  }

  /**
   * Start the loop somewhere of this entity's own choosing. Called once, on acquire.
   *
   * `setTime` rather than an `AnimationAction.time` write, because the mixer's own clock is what
   * `update` advances and what a recycled rig must have reset — see {@link park}.
   */
  seed(id: number, clipSeconds = SPARKLE_CLIP_SECONDS): void {
    this.mixer.setTime(phaseOf(id) * clipSeconds);
  }

  /** Stand it on the ground. The import's lowest vertex is at y = 0.002, so `y` is the floor itself. */
  place(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
  }

  /**
   * Hang the rung of the fade ladder this item's remaining life is worth.
   *
   * One integer compare a frame, and a material swap only on the seven frames of a ten-minute life
   * where the step actually moves. See `prototypes.SPARKLE_FADE_STEPS` for why the fade is eight shared
   * materials rather than one material with an opacity written on it.
   */
  fade(step: number): void {
    if (step === this.step || !this.mesh) return;
    this.step = step;
    const key = sparkleMaterialKey(step);
    if (this.pool.hasMaterial(key)) this.mesh.material = this.pool.material(key);
  }

  /** One frame. Nothing to blend and nothing to decide — the clip is the whole behaviour. */
  update(seconds: number): void {
    this.mixer.update(seconds);
  }

  /** Off the scene graph and back to the head of the loop. `PooledRig`. */
  park(): void {
    this.group.removeFromParent();
    this.mixer.setTime(0);
    // Back to full brightness, so the next item handed this rig does not inherit the last one's rot.
    this.step = -1;
    if (this.mesh && this.pool.hasMaterial(sparkleMaterialKey(0))) {
      this.mesh.material = this.pool.material(sparkleMaterialKey(0));
    }
  }

  dispose(): void {
    this.park();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.group);
    // The bone texture is the one GPU resource a rig owns outright, here as in `body.ts`.
    this.skeleton.dispose();
  }
}

/**
 * A sparkle for one ground item, through the pool so it lands on the ledger — or `undefined` at the
 * cap, or when the model never arrived.
 *
 * The caller draws the capsule when this answers nothing. See {@link ScenePool.acquireSparkle}.
 */
export function acquireSparkle(pool: ScenePool, template: AnimatedTemplate | undefined): SparkleRig | undefined {
  if (!template) return undefined;
  const rig = pool.acquireSparkle(() => new SparkleRig(pool, template)) as SparkleRig | undefined;
  // A rig that built no mesh is a registration that half-failed. Handing it straight back keeps the
  // ledger's `live + free === created` true and puts the item on the capsule path, which is where an
  // undrawable thing belongs.
  if (rig && !rig.drawn) {
    pool.releaseSparkle(rig);
    return undefined;
  }
  return rig;
}

/**
 * Clone a bone hierarchy — seven fresh `Bone`s with the template's names and rest transforms.
 *
 * `body.cloneBones` restated rather than imported, and the duplication is deliberate: that function is
 * `body.ts`'s private detail about a 65-joint Unreal armature, and importing it here would tie an
 * in-house seven-joint rig to the character pack's file for fifteen lines of loop. The *shape* is the
 * shared thing and it is shared by being written down twice with the same reasoning.
 *
 * Parentage is rebuilt by index against the source array, so a bone whose parent is not itself a joint
 * (here the scene root the importer left `base` hanging from) becomes a root and is added to the rig's
 * group by the caller.
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
