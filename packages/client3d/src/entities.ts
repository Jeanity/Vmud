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
 * ## What is deliberately not here
 *
 * **Facing.** It is on the wire, it is read, and it is stored — and a capsule has no front, so
 * nothing rotates. Drawing it would mean inventing a heading marker that the M7 character mesh will
 * immediately replace. The walk cycle is absent for the same reason and `WALK_MOVING_EPSILON` did
 * not come across: there is no stride to advance.
 */

import { Object3D, type InstancedMesh, type Scene } from 'three';

import {
  PLAYER_SPEED,
  ROOM_TILES,
  TILE_SIZE,
  stepMovement,
  type EntityId,
  type EntityView,
  type TileGrid,
} from '@mygame/shared';

import { metresOfPixel } from './frame.ts';
import { DIMENSIONS } from './prototypes.ts';
import { WRAPPER_CAPACITY, type ScenePool } from './pool.ts';

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
}

export class EntityLayer {
  private readonly bodies = new Map<EntityId, Body>();
  private readonly scratch = new Object3D();
  private readonly selfMesh: InstancedMesh;
  private readonly otherMesh: InstancedMesh;

  selfId: EntityId | undefined;
  /** Set for one frame when the last correction was a whole room. Read by `__debug3d`. */
  teleported = false;

  private readonly pool: ScenePool;

  /** Fields are declared rather than written as parameter properties — see `streamer.ts`'s note. */
  constructor(scene: Scene, pool: ScenePool) {
    this.pool = pool;
    // Two wrappers, taken once and never given back: a body is not streamed, so it has no unload to
    // return them on. Self and others differ by material and by nothing else at M3.
    this.selfMesh = pool.acquire('capsule', 'self');
    this.otherMesh = pool.acquire('capsule', 'other');
    // Bodies never take a fog-of-war tint — a character is not terrain, and the one thing that must
    // stay legible in an unexplored room is the person standing in it. The pool mints every wrapper
    // with a white `instanceColor`, so this is a statement about what is *not* done rather than a
    // call: nothing repaints these two, ever.
    scene.add(this.selfMesh, this.otherMesh);
  }

  get count(): number {
    return this.bodies.size;
  }

  body(id: EntityId): Body | undefined {
    return this.bodies.get(id);
  }

  /** A snapshot of the ids held, so a caller can prune while iterating it. */
  ids(): EntityId[] {
    return [...this.bodies.keys()];
  }

  self(): Body | undefined {
    return this.selfId === undefined ? undefined : this.bodies.get(this.selfId);
  }

  upsert(view: EntityView): void {
    const held = this.bodies.get(view.id);
    if (held) {
      held.view = view;
      held.serverX = view.x;
      held.serverY = view.y;
      return;
    }
    this.bodies.set(view.id, { view, x: view.x, y: view.y, serverX: view.x, serverY: view.y });
  }

  remove(id: EntityId): void {
    this.bodies.delete(id);
  }

  /** Positional delta for a body already held. Unknown ids are dropped, as the 2D client drops them. */
  moved(id: EntityId, x: number, y: number, facing: EntityView['facing']): void {
    const held = this.bodies.get(id);
    if (!held) return;
    held.serverX = x;
    held.serverY = y;
    held.view = { ...held.view, facing };
  }

  /**
   * Everyone goes, except optionally the local player.
   *
   * The exception is the `zone` case: everyone else was in the Place just left, but the local body
   * is what the camera is following and dropping it would leave the frame at the origin for a tick.
   */
  clear(keepSelf: boolean): void {
    if (!keepSelf) {
      this.bodies.clear();
      return;
    }
    for (const id of [...this.bodies.keys()]) {
      if (id !== this.selfId) this.bodies.delete(id);
    }
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
      if (id === this.selfId) {
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

  /** Writes the two instance buffers. `groundAt` answers in metres for a simulation position. */
  render(groundAt: (px: number, py: number) => number): void {
    let selfCount = 0;
    let otherCount = 0;
    const diameter = DIMENSIONS.bodyRadius * 2;
    // `CapsuleGeometry(0.5, 1)` is two metres tall, so the height scale is half the wanted height.
    const heightScale = DIMENSIONS.bodyHeight / 2;

    for (const [id, body] of this.bodies) {
      const mine = id === this.selfId;
      const index = mine ? selfCount : otherCount;
      if (index >= WRAPPER_CAPACITY) continue;
      this.scratch.position.set(
        metresOfPixel(body.x),
        groundAt(body.x, body.y) + DIMENSIONS.bodyHeight / 2,
        metresOfPixel(body.y),
      );
      this.scratch.rotation.set(0, 0, 0);
      this.scratch.scale.set(diameter, heightScale, diameter);
      this.scratch.updateMatrix();
      if (mine) {
        this.selfMesh.setMatrixAt(selfCount++, this.scratch.matrix);
      } else {
        this.otherMesh.setMatrixAt(otherCount++, this.scratch.matrix);
      }
    }

    this.selfMesh.count = selfCount;
    this.otherMesh.count = otherCount;
    this.pool.finish(this.selfMesh);
    this.pool.finish(this.otherMesh);
  }
}
