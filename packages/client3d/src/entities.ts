/**
 * Bodies, and the prediction/reconciliation block carried over from `scene.ts:4444–4530`.
 *
 * **The constants are the originals and the semantics are the originals.** `SNAP_DISTANCE` 28,
 * `TELEPORT_DISTANCE` one room, `EASE_PREDICTED` 0.12, `EASE_FOLLOW` 0.22, and `ease()` compounding
 * over the real frame time rather than per frame — that last one is not a refinement, it is a bug
 * fix the 2D client already paid for: *"an unpredicted local player settles at the gap where the
 * easing exactly keeps up: 21px at 60fps with a 0.12 factor, but 42px at 30fps — past
 * `SNAP_DISTANCE`, so instead of easing it hard-snapped on essentially every frame."*
 *
 * ## The arithmetic stays in simulation pixels, and that is the whole point
 *
 * The plan asks for the block "re-expressed against 3D positions". It is — but the *conversion* to
 * metres happens after the reconciliation, not before it, and the reason is `stepMovement`. That
 * function is the one-implementation-both-sides guarantee: the server and this predictor must run
 * the same routine over the same grid or prediction is theatre. It takes pixels. Reconciling in
 * metres would mean either a second copy of it or dividing all four constants by 32 — and a plan
 * that says "carry the constants and semantics exactly" is not asking for `SNAP_DISTANCE = 0.875`.
 *
 * So: `x`/`y` are simulation pixels on the zone grid, exactly as they are on the wire and exactly as
 * `scene.ts` holds them; `space.ts` turns them into metres at the moment a matrix is written, and
 * nowhere else.
 *
 * ## M7b: the capsule is now the fallback, and there are three of them
 *
 * M3's note said facing was read and unused because *"a capsule has no front"*, and that the walk
 * cycle was absent because *"there is no stride to advance"*. Both are answered. What is left of the
 * capsule is three jobs, and each is a deliberate degradation rather than a leftover:
 *
 * 1. **A `creature:` body.** `appearance.ts` emits one for the world's animals because no monster pack
 *    is purchasable. Drawn tinted and proportioned per class ({@link body.CREATURE_LOOK}) so a wolf
 *    reads as low, long and grey rather than as a person nobody dressed. Interim, and documented as
 *    interim in both files.
 * 2. **Over the rig cap.** {@link pool.BODY_POOL_SIZE} bodies get skeletons; the 25th gets a pill. See
 *    that constant for the arithmetic and for the world it was measured against.
 * 3. **Before the pack lands.** `characters.load` is not awaited (`main.ts`, and the same argument the
 *    trees and the kit make), so the first second of a session is M3's world and then is not.
 *
 * ## Speed is measured here, and it is measured in metres
 *
 * The gait comes from how far a body actually moved between two frames — see `anim.ts` for why that
 * is right for a predicted local player, for an eased remote one, and for the eye. It is taken from
 * the *drawn* position, after the warp, because that is the ground the character is walking on.
 */

import { Object3D, type Camera, type InstancedMesh, type Scene } from 'three';

import {
  OBJECT_PREFIX,
  PLAYER_SPEED,
  ROOM_TILES,
  TILE_SIZE,
  stepMovement,
  yawOf,
  type EntityId,
  type EntityView,
  type TileGrid,
} from '@mygame/shared';

import { acquireRig, stemOf, CREATURE_DEFAULT, CREATURE_LOOK, type BodyRig, type CreatureLook } from './body.ts';
import type { CharacterSet } from './characters.ts';
import { metresOfPixel } from './frame.ts';
import { SELF_LAYER, WORLD_LAYER } from './lights.ts';
import type { PlateSet } from './plates.ts';
import type { PropsSet } from './props.ts';
import { DIMENSIONS, LOOT_SPARKLE, OBJECT_MODELS, propsGeometryKey, propsMaterialKey, sparkleFadeStep } from './prototypes.ts';
import { WRAPPER_CAPACITY, type ScenePool } from './pool.ts';
import { acquireSparkle, type SparkleRig } from './sparkle.ts';
import type { WarpVec } from './warp.ts';

/** Divergence from the server, in pixels, past which we stop easing and just snap. `scene.ts:213`. */
export const SNAP_DISTANCE = 28;

/**
 * Divergence past which the move was a teleport rather than a correction — one room.
 *
 * With a rigid camera follow the frame goes with the body by construction, so nothing acts on this
 * at M3. It is carried anyway, with its meaning: the moment M4 gives the camera any lag, a seam
 * crossing, an admin teleport or a flee has to bypass it, and rediscovering that from the symptom
 * cost the 2D client a round of owner reports.
 */
export const TELEPORT_DISTANCE = ROOM_TILES * TILE_SIZE;

/** Gentle: a local prediction that is already nearly right. */
export const EASE_PREDICTED = 0.12;
/** Brisk: the only thing moving a body the server alone is driving. */
export const EASE_FOLLOW = 0.22;

/** Per-frame-at-60fps factor, compounded over the frame that actually happened. `scene.ts:5219`. */
export function ease(rate: number, seconds: number): number {
  return 1 - Math.pow(1 - rate, seconds * 60);
}

export interface Body {
  view: EntityView;
  /** Predicted position, simulation pixels. */
  x: number;
  y: number;
  /** Last authoritative position, simulation pixels. */
  serverX: number;
  serverY: number;
  /** M7b: the composed mesh, when one was available. Absent means a capsule — see the header. */
  rig?: BodyRig | undefined;
  /**
   * The loot sparkle standing over this thing, when it is a ground object and one was available.
   *
   * Mutually exclusive with {@link rig} by construction — a body is never an item — but held in its own
   * field rather than a union, because the two are released through different pool calls with
   * different caps.
   */
  sparkle?: SparkleRig | undefined;
  /**
   * Milliseconds this thing has left before it rots, counted down **locally**.
   *
   * Seeded from `EntityView.remainingMs` and decremented in {@link render}, because the wire sends a
   * ground object once on `entityEnter` and corrects it once when the server latches the warning. A
   * client that only redrew on a message would hold the sparkle at full strength for the whole minute
   * and then jump; counting down is what makes the dimming a slope. Absent for anything that does not
   * rot, which is every body and every scatter pickup.
   */
  rotMs?: number | undefined;
  /**
   * The threshold {@link rotMs} is read against — `EntityView.warnAtMs`, held rather than re-read.
   *
   * Held beside its partner rather than taken off `view` at draw time so the **pair** is sticky: the
   * protocol says these two travel together or not at all, and a view that arrived without them must
   * not silently un-rot a dagger that was already dimming. Reading one from the body and the other
   * from the view would make that failure asymmetric and therefore invisible.
   */
  warnMs?: number | undefined;
  /**
   * Latched when the sparkle cap turned this item down — so it is asked **once**, not sixty times a
   * second.
   *
   * `equip` gets this for free because it is called on entity events rather than per frame; the
   * sparkle is acquired inside `render` (the template may land mid-session, which is the same lazy
   * argument `objectMesh` makes) and would otherwise ask the pool on every frame of every item past
   * the cap. That is cheap in work and ruinous in *accounting*: `LedgerSnapshot.sparklesRefused` is
   * meant to be read as "how many things went without", and a floor of sixty daggers would add
   * nineteen thousand a second to it and say nothing.
   *
   * Cleared on the next {@link EntityLayer.upsert}, which is `equip`'s own retry rule — *"gets its rig
   * on the first update that could give it one, which is every resync"*. The template-not-loaded case
   * is deliberately **not** latched: that is a map lookup that costs nothing and moves no counter, and
   * it is the one that resolves on its own a second into the session.
   */
  sparkleRefused?: boolean | undefined;
  /** Drawn position in metres, last frame, for the gait's speed. `undefined` on the first frame. */
  lastX?: number | undefined;
  lastZ?: number | undefined;
}

export class EntityLayer {
  private readonly bodies = new Map<EntityId, Body>();
  private readonly scratch = new Object3D();
  /** Reused by {@link render}: the warp writes into it once per body per frame and allocates nothing. */
  private readonly warp: WarpVec = { x: 0, z: 0 };
  private readonly selfMesh: InstancedMesh;
  private readonly otherMesh: InstancedMesh;
  /**
   * The third wrapper, and the one exception to *"nothing repaints these, ever"* — M7b.
   *
   * A `creature:` placeholder has to be tinted per class or a wolf and a boar are the same grey pill,
   * and `instanceColor` is the only per-instance channel an `InstancedMesh` has. So creatures get
   * their own wrapper and their own writes, and the two *people* wrappers keep the white buffer every
   * mint starts with. Splitting them is what keeps that rule true where it matters — on the bodies
   * that are standing in an unexplored room.
   */
  private readonly creatureMesh: InstancedMesh;

  /**
   * Which of these bodies is the player's own — and, since the lighting fix, a small piece of state
   * rather than a plain field.
   *
   * The player's body is drawn on `lights.SELF_LAYER` so that `post.BodyPass` can draw it without the
   * light it is carrying, and it arrives on the wire (`welcome.you`) at a moment that has no fixed
   * relationship to when the body itself does — a resync can bring the body first, and the pack that
   * turns it from a capsule into a rig lands a second later again. So the layer is applied from all
   * three directions: here when the id changes, in {@link equip} when the rig is taken, and inside
   * `BodyRig.add`/`hold` for everything minted after that.
   */
  private mine: EntityId | undefined;
  /** Set for one frame when the last correction was a whole room. Read by `__debug3d`. */
  teleported = false;

  get selfId(): EntityId | undefined {
    return this.mine;
  }

  set selfId(id: EntityId | undefined) {
    if (id === this.mine) return;
    // The body that *was* mine goes back to the world's layer before the new one takes the exemption,
    // so a `welcome` after a reconnect cannot leave a stranger's body drawn in the body pass.
    const was = this.mine === undefined ? undefined : this.bodies.get(this.mine);
    this.mine = id;
    was?.rig?.setLayer(WORLD_LAYER);
    const now = id === undefined ? undefined : this.bodies.get(id);
    now?.rig?.setLayer(SELF_LAYER);
  }

  private readonly pool: ScenePool;
  private readonly characters: CharacterSet;
  private readonly plates: PlateSet | undefined;
  /**
   * The props registry, for the one thing in it this class asks for: the loot sparkle's template.
   *
   * Optional so a caller that only wants bodies — most of the tests — needs no fourth registry, and
   * absent simply means every ground object draws the capsule, which is the same graceful nothing the
   * character pack's absence produces.
   */
  private readonly props: PropsSet | undefined;
  private readonly scene: Scene;
  /** Last {@link CharacterSet.generation} acted on — see {@link render}'s re-body pass. */
  private packGeneration = -1;

  /**
   * One `InstancedMesh` per drawn object model, minted on demand. See {@link objectMesh}.
   *
   * A map rather than two fields because the *count* is a property of `OBJECT_MODELS` rather than of
   * this class, and because both of its entries are reached by the same three lines.
   */
  private readonly objectMeshes = new Map<string, InstancedMesh>();
  /** How many of each are drawn this frame. Keys are cleared, never deleted — see `render`. */
  private readonly objectCounts = new Map<string, number>();

  /** Fields are declared rather than written as parameter properties — see `streamer.ts`'s note. */
  constructor(scene: Scene, pool: ScenePool, characters: CharacterSet, plates?: PlateSet, props?: PropsSet) {
    this.pool = pool;
    this.scene = scene;
    this.characters = characters;
    this.plates = plates;
    this.props = props;
    // Three wrappers, taken once and never given back: a body is not streamed, so it has no unload to
    // return them on. Self and others differ by material and by nothing else.
    this.selfMesh = pool.acquire('capsule', 'self');
    this.otherMesh = pool.acquire('capsule', 'other');
    this.creatureMesh = pool.acquire('capsule', 'other');
    // Bodies never take a fog-of-war tint — a character is not terrain, and the one thing that must
    // stay legible in an unexplored room is the person standing in it. The pool mints every wrapper
    // with a white `instanceColor`, so this is a statement about what is *not* done rather than a
    // call: nothing repaints these two, ever. The creature wrapper is repainted per *class*, which is
    // identity rather than fog — see its own note.
    // **One wrapper per object model, and they are the first entity meshes that are not capsules.**
    // Taken here for the reason the three above are — an object on the floor is an entity, so it is
    // not streamed and has no unload to give a wrapper back on. Two of them, from a closed list, so
    // this stays a constant rather than a map that grows with whatever the server drops.
    //
    // A corpse arrives before the props manifest does (`PropsSet.load` is not awaited, the same
    // argument the characters make), so the geometry may not be registered yet. `acquire` would throw
    // on a key the pool has no geometry for, so the wrapper is minted lazily in `render` instead —
    // see {@link objectMesh}.
    scene.add(this.selfMesh, this.otherMesh, this.creatureMesh);
    // **The capsule half of the lighting rule, and it is one line because the wrapper is already
    // split.** `selfMesh` holds the player's own body and nothing else, so it goes on the body pass's
    // layer for good — no per-frame work, and it covers both of the capsule's remaining jobs: the
    // second before the 35 MB character pack lands, and a room so crowded the player is past
    // `pool.BODY_POOL_SIZE`. See `lights.SELF_LAYER`.
    this.selfMesh.layers.set(SELF_LAYER);
  }

  get count(): number {
    return this.bodies.size;
  }

  /**
   * The wrapper for one object model, minted on the frame the pool first has its geometry.
   *
   * Lazy and not eager, because `PropsSet.load` is not awaited: a corpse can be on the wire before its
   * mesh has been fetched, and `pool.acquire` on a geometry key the pool has never registered throws
   * inside a frame. Answering `undefined` for a beat draws nothing, which is right — a corpse that
   * appears half a second late is better than a renderer that stops.
   *
   * Bounded by {@link OBJECT_MODELS}, so this map has two entries and reaches two for ever.
   */
  private objectMesh(stem: string): InstancedMesh | undefined {
    const held = this.objectMeshes.get(stem);
    if (held) return held;
    const geometry = propsGeometryKey(stem, stem);
    const material = propsMaterialKey(stem);
    if (!this.pool.hasGeometry(geometry) || !this.pool.hasMaterial(material)) return undefined;
    const mesh = this.pool.acquire(geometry, material);
    // A corpse takes no fog-of-war tint, for the reason a body does not: the pool mints every wrapper
    // white and nothing repaints these.
    this.scene.add(mesh);
    this.objectMeshes.set(stem, mesh);
    return mesh;
  }

  /** How many entities are drawn as a real composed mesh. `__debug3d.rigs`. */
  get rigged(): number {
    let total = 0;
    for (const body of this.bodies.values()) if (body.rig) total += 1;
    return total;
  }

  body(id: EntityId): Body | undefined {
    return this.bodies.get(id);
  }

  /** A snapshot of the ids held, so a caller can prune while iterating it. */
  ids(): EntityId[] {
    return [...this.bodies.keys()];
  }

  self(): Body | undefined {
    return this.mine === undefined ? undefined : this.bodies.get(this.mine);
  }

  upsert(view: EntityView): void {
    const held = this.bodies.get(view.id);
    if (held) {
      held.view = view;
      held.serverX = view.x;
      held.serverY = view.y;
      // The server's own reading of the rot clock wins over the local countdown whenever one arrives —
      // which is on entry and on the one `entityUpdate` `advanceGround` sends when it latches the
      // warning. Guarded, so a view that carries no clock does not wipe one this object already had.
      if (view.remainingMs !== undefined) {
        held.rotMs = view.remainingMs;
        held.warnMs = view.warnAtMs;
      }
      // An update is a reason to try again — `equip`'s rule for a body that arrived before its pack,
      // applied to an item that arrived while the floor was full.
      held.sparkleRefused = undefined;
      this.dress(held);
      return;
    }
    const body: Body = {
      view,
      x: view.x,
      y: view.y,
      serverX: view.x,
      serverY: view.y,
      ...(view.remainingMs !== undefined ? { rotMs: view.remainingMs, warnMs: view.warnAtMs } : {}),
    };
    this.bodies.set(view.id, body);
    this.equip(body);
  }

  remove(id: EntityId): void {
    const held = this.bodies.get(id);
    if (held) this.unequip(held);
    this.plates?.release(id);
    this.bodies.delete(id);
  }

  /**
   * The view this layer currently holds for a body — for tests and `__debug3d`, read-only.
   *
   * Worth having beyond convenience: the wire delivers a body in one shape (`EntityView`) and then
   * amends it in another (`entityMoved`'s four fields), so *what the client believes about a body
   * right now* is a thing neither message states and only this map knows. The moonwalk of
   * 2026-08-13 lived exactly in that gap — see {@link moved}.
   */
  viewOf(id: EntityId): EntityView | undefined {
    return this.bodies.get(id)?.view;
  }

  /**
   * Positional delta for a body already held. Unknown ids are dropped, as the 2D client drops them.
   *
   * **`yaw` is re-derived here, and forgetting to was the moonwalk.** The owner, 2026-08-13: *"the
   * mobs are moonwalking now.. michael jackson would be happy about that but I need them walking
   * forwards"*. `entityMoved` is the high-frequency message and it predates M7a: it carries the
   * cardinal `facing` and no `yaw` at all. M7a put `yaw` on the *full* `EntityView`, M7b's rig reads
   * `view.yaw` every frame — and nothing joined the two, so a body's orientation froze at whatever it
   * was the moment it entered view (a mob's spawn `'south'`, mostly) and stayed there while the body
   * walked off in every other direction. It was not the mesh: that offset is measured twice over, by
   * the rest pose's toes and by the root-motion clip's own travel, and both say `+Z`.
   *
   * Deriving rather than plumbing a float through the wire is deliberate and temporary in the right
   * way: `yawOf` is M7a's own stated *adapter* over a simulation that holds four cardinals, so the
   * invariant is simply **wherever `facing` is written, `yaw` is written with it**. When the server
   * grows a real continuous heading, this line prefers that field and the rest of the client does not
   * move.
   */
  moved(id: EntityId, x: number, y: number, facing: EntityView['facing']): void {
    const held = this.bodies.get(id);
    if (!held) return;
    held.serverX = x;
    held.serverY = y;
    held.view = { ...held.view, facing, yaw: yawOf(facing) };
  }

  /**
   * Everyone goes, except optionally the local player.
   *
   * The exception is the `zone` case: everyone else was in the Place just left, but the local body
   * is what the camera is following and dropping it would leave the frame at the origin for a tick.
   */
  clear(keepSelf: boolean): void {
    for (const [id, body] of [...this.bodies]) {
      if (keepSelf && id === this.mine) continue;
      this.unequip(body);
      this.plates?.release(id);
      this.bodies.delete(id);
    }
  }

  /* ---------------------------------------------------------------- M7b: combat */

  /**
   * One resolved blow — `attackResolved`, which the server has emitted since Phase 11 and which no
   * client has ever handled.
   *
   * Both ends of it act: the attacker swings, the target flinches or blocks, and a number rises off
   * whoever was hit. All three are gated on the entity being *here* — a blow between two mobs in the
   * next room arrives on the wire (interest management is per room, and the neighbours are revealed)
   * and simply finds no body to animate.
   */
  attackResolved(
    attacker: EntityId,
    target: EntityId,
    hit: boolean,
    critical: boolean,
    damage: number,
    swing: 'slash' | 'thrust' | 'shoot' | undefined,
    groundAt: (px: number, py: number) => number,
  ): void {
    const striker = this.bodies.get(attacker);
    if (striker?.rig) striker.rig.motion.struck(subjectOf(striker.view), swing, striker.rig.clipSeconds);
    const victim = this.bodies.get(target);
    if (!victim) return;
    if (victim.rig) victim.rig.motion.tookBlow(subjectOf(victim.view), hit, critical, victim.rig.clipSeconds);
    this.plates?.showDamage(
      damage,
      critical,
      hit,
      metresOfPixel(victim.x),
      groundAt(victim.x, victim.y),
      metresOfPixel(victim.y),
      // Off the head that was actually hit. A number that started at adult height over a kobold youth
      // would look like somebody else had been struck.
      victim.view.scale ?? 1,
    );
  }

  /** A body died — `died`. It falls and **holds the last frame** until `entityLeave` takes it away. */
  died(id: EntityId): void {
    const rig = this.bodies.get(id)?.rig;
    rig?.motion.fell(rig.clipSeconds);
  }

  /**
   * One frame of movement — `scene.ts:4456–4509`, with the Phaser sprite work removed and nothing
   * else changed.
   *
   * `canMovePredicted` is the mirrored `SelfView` answer, never inferred: *"A client that predicted
   * a walk the server refuses produces a sprite that slides away and is snapped back every frame for
   * as long as the key is held, which reads as the connection being broken rather than as the
   * character being sat down."*
   */
  step(
    seconds: number,
    grid: TileGrid | undefined,
    intent: { readonly x: number; readonly y: number },
    canMovePredicted: boolean,
  ): void {
    this.teleported = false;
    const predicting = canMovePredicted && (intent.x !== 0 || intent.y !== 0);
    const followRate = ease(EASE_FOLLOW, seconds);

    for (const [id, body] of this.bodies) {
      if (id === this.mine) {
        if (predicting && grid) {
          const next = stepMovement(grid, body.x, body.y, intent.x, intent.y, PLAYER_SPEED * seconds);
          body.x = next.x;
          body.y = next.y;
        }
        const drift = Math.hypot(body.serverX - body.x, body.serverY - body.y);
        if (drift > SNAP_DISTANCE) {
          body.x = body.serverX;
          body.y = body.serverY;
          if (drift > TELEPORT_DISTANCE) this.teleported = true;
        } else if (drift > 0.5) {
          // Two different jobs, so two different rates — see the constants.
          const rate = predicting ? ease(EASE_PREDICTED, seconds) : followRate;
          body.x += (body.serverX - body.x) * rate;
          body.y += (body.serverY - body.y) * rate;
        }
      } else {
        body.x += (body.serverX - body.x) * followRate;
        body.y += (body.serverY - body.y) * followRate;
      }
    }
  }

  /**
   * Writes the three instance buffers and places every rig. `groundAt` answers in metres.
   *
   * `warpAt` is M5c's, and it is what keeps a body on the road rather than beside it: the ground the
   * character is standing on is drawn displaced by the domain warp (`warp.ts`), so a body placed at
   * the grid position the simulation holds would stand up to three metres away from the piece of
   * ground it is actually walking on. Sampled at the body's own position and applied to the
   * translation — **not** to the vertices — because the field's gradient across half a metre of
   * shoulder would squash the body by a quarter of its width. It is injected, like `groundAt`, so
   * this class still knows nothing about `World3D`.
   *
   * **A composed body is placed by its feet.** The base bodies' lowest vertex is at y = −0.01 m and
   * −0.008 m as authored (measured), so the rig's origin *is* the sole of the foot and the ground
   * height goes straight onto it — M5a's tree-trunk rule, unchanged. The capsule still has to be
   * lifted by half its height, because `CapsuleGeometry` is centred and a tree is not.
   */
  render(
    seconds: number,
    groundAt: (px: number, py: number) => number,
    warpAt?: (out: WarpVec, x: number, z: number) => void,
    camera?: Camera,
  ): void {
    // **The pack is not awaited, so the room can be full before the bodies exist.** One integer
    // compare a frame; on the one frame it moves, every capsule that could be a person becomes one.
    // Without this a player standing still while the 35 MB import lands would keep a room of grey
    // pills until they next changed clothes or walked through a door.
    if (this.characters.generation !== this.packGeneration) {
      this.packGeneration = this.characters.generation;
      for (const held of this.bodies.values()) if (!held.rig) this.equip(held);
    }

    let selfCount = 0;
    let otherCount = 0;
    let creatureCount = 0;
    // Cleared rather than rebuilt, so the map's two entries are allocated once for the session.
    for (const key of this.objectCounts.keys()) this.objectCounts.set(key, 0);
    const diameter = DIMENSIONS.bodyRadius * 2;
    // `CapsuleGeometry(0.5, 1)` is two metres tall, so the height scale is half the wanted height.
    const heightScale = DIMENSIONS.bodyHeight / 2;

    for (const [id, body] of this.bodies) {
      const mine = id === this.mine;
      const x = metresOfPixel(body.x);
      const z = metresOfPixel(body.y);
      this.warp.x = 0;
      this.warp.z = 0;
      warpAt?.(this.warp, x, z);
      const worldX = x + this.warp.x;
      const worldZ = z + this.warp.z;
      const ground = groundAt(body.x, body.y);

      // **The owner's youths, and the one number every drawn part of a body has to agree on.**
      // Absent means adult, which is 95% of the world — see `appearance.BODY_SCALE`.
      const scale = body.view.scale ?? 1;

      if (body.rig) {
        // How far the body actually moved on screen since the last frame, in metres. The first frame
        // has no previous position and therefore no speed, which is right: a body that has just
        // entered the room is standing still until it is seen to move.
        const moved =
          body.lastX === undefined || body.lastZ === undefined
            ? 0
            : Math.hypot(worldX - body.lastX, worldZ - body.lastZ);
        body.lastX = worldX;
        body.lastZ = worldZ;
        body.rig.place(worldX, ground, worldZ, scale);
        body.rig.update(seconds, body.view.yaw ?? 0, moved, subjectOf(body.view));
        if (this.plates && camera && body.view.name) {
          const distance = camera.position.distanceTo(body.rig.group.position);
          // The plate follows the head, not a constant: a 0.72-scale child whose name floated at an
          // adult's 2.1 m would have it hanging three quarters of a metre above them.
          this.plates.showName(id, body.view.name, worldX, ground, worldZ, distance, camera, scale);
        }
        continue;
      }

      // **An object on the ground: a corpse, and the first entity with a real mesh that is not a
      // body.** Read before `creatureLook` because it is more specific — an `object:` model is never
      // an animal — and before the capsule fallthrough because that is what it replaces.
      const object = objectStem(body.view.model);
      if (object) {
        const mesh = this.objectMesh(object);
        if (!mesh) continue;
        const index = this.objectCounts.get(object) ?? 0;
        if (index >= WRAPPER_CAPACITY) continue;
        this.objectCounts.set(object, index + 1);
        // Sits **on** the ground rather than centred on it: the pile is authored with its lowest
        // vertex at y = 0, so its origin is where the floor is. The same rule the kit's trees follow
        // and the opposite of the capsule below, which is centred because a capsule has no feet.
        this.scratch.position.set(worldX, ground, worldZ);
        this.scratch.rotation.set(0, 0, 0);
        // **Uniform, from the wire.** `view.scale` on a corpse is what died divided by an adult —
        // see `appearance.corpseScaleFor`. A dragon leaves a dragon-sized pile because the number
        // says so, not because there is a second mesh.
        this.scratch.scale.setScalar(scale);
        this.scratch.updateMatrix();
        mesh.setMatrixAt(index, this.scratch.matrix);
        continue;
      }

      // **A thing lying on the floor, and the last of the orange pills.** An `item`-kind view with no
      // `object:` model is a dropped sword, a spilled quiver or the room's own scatter pickup — the
      // three things `groundViewOf`, `pickupViewOf` and nothing else produce. Every one of them drew as
      // an `other`-archetype capsule until now, which is the pill this branch exists to retire.
      //
      // **Read after the object branch, and that ordering is load-bearing**: a corpse is `kind: 'item'`
      // too (`corpses.ts` and `ground.ts` share the tag deliberately — one image, no facing, no health
      // bar), and it already draws a bone pile. The branch above `continue`s on every corpse, including
      // the beat before the props manifest lands, so nothing reaches here that has a mesh of its own.
      //
      // **The sparkle is uniform.** No scale, no tint, no second model — owner's ruling, and the
      // reasoning is the game's rather than the renderer's: *"a MUD's tension is partly not knowing"*,
      // so nothing about an item may be legible before it is picked up. The one permitted variation is
      // how long it has left, which is the fade below, and the one *non*-variation that still had to be
      // broken up is the clip's phase — a room of items glinting on the same frame reads as machinery
      // rather than as magic. See `sparkle.phaseOf`.
      if (body.view.kind === 'item') {
        // Counted down whether or not there is a sparkle to show it on, so a rig acquired late (the
        // pack lands, or the floor thins out below the cap) is already at the right rung.
        if (body.rotMs !== undefined) body.rotMs -= seconds * 1000;
        // Lazy, exactly as `objectMesh` is lazy and for the same reason: `PropsSet.load` is not
        // awaited, so an item can be on the wire before its template exists. Answering nothing for a
        // beat draws the capsule, which is M3's world and already-correct code.
        //
        // The template lookup is retried every frame and the *acquire* is not — see
        // {@link Body.sparkleRefused}. A missing template resolves itself and moves no counter; a full
        // cap does neither, so asking it again on the next frame is only a way to make the ledger lie.
        if (!body.sparkle && !body.sparkleRefused) {
          const template = this.props?.animated(LOOT_SPARKLE);
          if (template) {
            const rig = acquireSparkle(this.pool, template);
            if (rig) {
              rig.seed(id);
              this.scene.add(rig.group);
              body.sparkle = rig;
            } else {
              body.sparkleRefused = true;
            }
          }
        }
        const sparkle = body.sparkle;
        if (sparkle) {
          // On the ground rather than centred on it: the import's lowest vertex is at y = 0.002, so its
          // origin is the floor. The corpse pile's rule, and the opposite of the capsule below.
          sparkle.place(worldX, ground, worldZ);
          sparkle.fade(sparkleFadeStep(body.rotMs, body.warnMs));
          sparkle.update(seconds);
          continue;
        }
        // …and if there was no rig — past `pool.SPARKLE_POOL_SIZE`, or before the import — this falls
        // through to the capsule deliberately. See that cap for why the fallback is a visible pill
        // rather than nothing at all.
      }

      const creature = creatureLook(body.view.model);
      // A `child/wolf` is a wolf cub. The placeholder capsule takes the same scale the rig would have,
      // which is why `appearanceOf` reads the body word *before* it branches on the head shape.
      const height = (creature?.height ?? DIMENSIONS.bodyHeight) * scale;
      const radius = (creature?.radius ?? DIMENSIONS.bodyRadius) * scale;
      // **`mine` is read before `creature`, and the order is the lighting rule.** `creatureMesh` is
      // shared by every animal in the room, so a player who landed in it would be un-excludable from
      // their own lamp without splitting a fourth wrapper off the ledger. Reading `mine` first costs
      // a self creature its per-class *material* and nothing else — the tint follows below — and it
      // is not reachable today in any case: `appearance.appearanceOf` only takes the `creature:`
      // branch for a sprite whose head is in `ANIMAL_HEADS`, and no playable race has one. Handled
      // anyway, because the failure mode is the player being the one thing in the world still wearing
      // the collar of light this was all built to remove.
      const mesh = mine ? this.selfMesh : creature ? this.creatureMesh : this.otherMesh;
      const index = mine ? selfCount : creature ? creatureCount : otherCount;
      if (index >= WRAPPER_CAPACITY) continue;
      this.scratch.position.set(worldX, ground + height / 2, worldZ);
      this.scratch.rotation.set(0, 0, 0);
      this.scratch.scale.set(
        creature ? radius * 2 : diameter * scale,
        creature ? height / 2 : heightScale * scale,
        creature ? radius * 2 : diameter * scale,
      );
      this.scratch.updateMatrix();
      mesh.setMatrixAt(index, this.scratch.matrix);
      // The tint follows the *body*, not the wrapper it landed in. A creature is painted its class
      // colour wherever it is drawn; the self wrapper is painted back to white when it is not one, so
      // a body that stopped being a creature cannot keep a stale grey. `otherMesh` is still never
      // written at all, which is the half of the rule that matters — see the constructor.
      if (creature || mine) {
        const colours = mesh.instanceColor;
        if (colours) {
          const tint = creature?.colour ?? 0xffffff;
          colours.setXYZ(index, ((tint >> 16) & 0xff) / 255, ((tint >> 8) & 0xff) / 255, (tint & 0xff) / 255);
          colours.needsUpdate = true;
        }
      }
      if (mine) selfCount += 1;
      else if (creature) creatureCount += 1;
      else otherCount += 1;
    }

    this.selfMesh.count = selfCount;
    this.otherMesh.count = otherCount;
    this.creatureMesh.count = creatureCount;
    for (const [stem, mesh] of this.objectMeshes) {
      mesh.count = this.objectCounts.get(stem) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.pool.finish(this.selfMesh);
    this.pool.finish(this.otherMesh);
    this.pool.finish(this.creatureMesh);
    if (camera) this.plates?.advance(seconds, camera);
  }

  /* ---------------------------------------------------------------- rig plumbing */

  /**
   * Take a rig for a body that has just arrived, and dress it.
   *
   * Silently does nothing for a `creature:` model, for a body with no `model` at all (a server that
   * predates M7a), before the pack has loaded, and past the cap. Each of those is the capsule path and
   * each is correct.
   */
  private equip(body: Body): void {
    const model = body.view.model;
    if (!model || !model.startsWith('base:') || !this.characters.available) return;
    const rig = acquireRig(this.characters, this.pool, model);
    if (!rig) return;
    body.rig = rig;
    // Before `dress`, so the first set of meshes is minted straight onto the right layer rather than
    // built on the world's and moved. A rig out of the free list arrives on `WORLD_LAYER` (`park`
    // puts it back), so this is the only place a body becomes the player's.
    rig.setLayer(body.view.id === this.mine ? SELF_LAYER : WORLD_LAYER);
    this.scene.add(rig.group);
    this.dress(body);
  }

  /** Re-read the wire's gear and hands. Cheap when nothing changed — one string comparison. */
  private dress(body: Body): void {
    if (!body.rig) {
      // A body that arrived before the pack landed, or before the server knew what it looked like,
      // gets its rig on the first update that could give it one — which is every resync.
      this.equip(body);
      return;
    }
    body.rig.dress(
      body.view.model ?? '',
      body.view.gear,
      body.view.hands?.main,
      body.view.hands?.off,
      body.view.hair,
    );
  }

  private unequip(body: Body): void {
    // The sparkle first and unconditionally: an item has no rig, so a `return` on `!body.rig` above
    // this line would leak one skeleton per thing ever picked up off a floor.
    if (body.sparkle) {
      this.pool.releaseSparkle(body.sparkle);
      body.sparkle = undefined;
      body.rotMs = undefined;
      body.warnMs = undefined;
    }
    body.sparkleRefused = undefined;
    if (!body.rig) return;
    this.pool.releaseBody(stemOf(body.view.model ?? ''), body.rig);
    body.rig = undefined;
    body.lastX = undefined;
    body.lastZ = undefined;
  }
}

/**
 * The stem of an `object:` model, or nothing for anything else.
 *
 * Gated on {@link OBJECT_MODELS} rather than on the prefix alone, and that is the same discipline
 * `appearance.ANIMAL_HEADS` states for `creature:`: a closed set means a server that invented an id
 * draws the fallback rather than reaching for a pool key nothing ever registered.
 */
function objectStem(model: string | undefined): string | undefined {
  if (!model?.startsWith(OBJECT_PREFIX)) return undefined;
  const stem = model.slice(OBJECT_PREFIX.length);
  return (OBJECT_MODELS as readonly string[]).includes(stem) ? stem : undefined;
}

/** What `anim.ts` needs off a view. Three optional fields, all already on the wire. */
function subjectOf(view: EntityView): {
  mainHand?: string;
  offHand?: string;
  fighting?: boolean;
  casting?: boolean;
} {
  return {
    ...(view.hands?.main ? { mainHand: view.hands.main } : {}),
    ...(view.hands?.off ? { offHand: view.hands.off } : {}),
    ...(view.fighting !== undefined ? { fighting: true } : {}),
    ...(view.casting ? { casting: true } : {}),
  };
}

/** The placeholder look for a `creature:` model, or nothing for anything else. */
function creatureLook(model: string | undefined): CreatureLook | undefined {
  if (!model || !model.startsWith('creature:')) return undefined;
  return CREATURE_LOOK[stemOf(model)] ?? CREATURE_DEFAULT;
}
