/**
 * Who owns the camera's yaw — the owner's hand, or the player's back. M8.
 *
 * The whole slice in the owner's own words, 2026-08-13, across three messages:
 *
 * > *"whats the chance we can rotate the screen when I hold the shift key and move my mouse side to
 * > side?"* … *"always having the camera behind my player"* … *"honestly if I can get the usual 3D
 * > setup where if I hold shift and move back and forth it changes the angle and if I go side to side
 * > it move the camera around the player.. like a full 3d game"*
 *
 * So: **Shift + drag**, horizontal to orbit and vertical to tilt, plus a mode that keeps the camera
 * behind the player. Both write `rig.yaw`, never in the same frame, and everything downstream of the
 * yaw — the ring, the near-wall fade, the shadow box, the compass — is somebody else's file.
 *
 * ## The mapping, and the two signs that are decisions
 *
 * ```
 *   drag right  ->  the camera turns right   (yaw falls;  east is -90 in the protocol's units)
 *   drag up     ->  the camera looks up      (pitch falls, toward 45 and the horizon)
 * ```
 *
 * Both are the **non-inverted** convention every third-person game ships with, and both are worth
 * stating because both have a plausible opposite. Dragging right could equally *turn the world*
 * right — that is Blender's turntable and Maya's, and it is what a modeller expects; a player expects
 * to look where they pushed. Dragging up could equally raise the camera; but "mouse forward = look
 * up" is the muscle memory of every shooter, and here "up" means *toward the horizon*, which is the
 * direction the owner's whole camera arc has pointed since *"lower the angles so we can see more what
 * is in front"*. The tilt's direction also agrees with the wheel it replaces, notch for notch
 * (`dolly.tiltTo`: away from the viewer lowers the pitch).
 *
 * ## Why the two rates differ by three
 *
 * {@link ORBIT_DEGREES_PER_PIXEL} is 0.25 — a full circle in 1,440 px, which is one screen-width drag
 * on a typical monitor and is what `three`'s own OrbitControls does (2π per client width). The tilt is
 * {@link TILT_DEGREES_PER_PIXEL}, 0.08, and it is **not** the same number on purpose: the pitch clamp
 * is 19° wide against the yaw's 360, so at an equal rate the whole tilt range would cross in 76 px
 * and every horizontal drag — none of which is perfectly horizontal — would slam the camera into one
 * of its stops. At 0.08 the full range is a 238 px pull and a 20 px wobble is 1.6°, which is under
 * the threshold at which anybody would notice the tilt moved at all.
 *
 * ## Shift is the discriminator, and it is read once
 *
 * `pointer.ts` already owns the unmodified left press: it is a click *and* the start of a possible
 * hold, decided by {@link pointer.HOLD_THRESHOLD_MS}. A Shift+drag must be neither — no `moveTo` may
 * go out and no steer may start — and the unmodified gestures must be untouched. So there is exactly
 * one predicate, {@link claimsOrbit}, and **both files call it**: this one to take a press,
 * `pointer.ts` to refuse it. Two listeners on one element that each decided for themselves what a
 * shifted press meant is the shape `CLAUDE.md` gotcha 5a warns about, arriving by the pointer's door.
 *
 * **The modifier is read at `pointerdown` and never again**, which is gotcha 5b's own prescription —
 * *"the modifier state at the moment of the press is what the player meant"*. Releasing Shift halfway
 * through a drag therefore keeps orbiting until the button comes up, and pressing Shift halfway
 * through a click keeps clicking. That is the rule and it is the friendly one: an orbit is a gesture
 * with a beginning, and a hand that relaxes on a modifier three-quarters of the way round a turn
 * meant to finish the turn.
 *
 * ## Follow mode suspends when the hand moves, and says so
 *
 * A Shift+drag switches follow **off** — one boolean, no third state — because a hand on the camera
 * outranks a rule about where it should be, and because an "on but suspended" mode has to explain
 * itself twice: once when it stops working and once when it starts again. **O** turns it back on, and
 * the log says which of the two just happened. See `dolly.FOLLOW_ON_FRESH` for why it ships off.
 */

import type { CameraPose } from './dolly.ts';
import { intoFormControl } from './input.ts';
import { clampPitch, wrapYaw } from './rig.ts';

/**
 * Degrees of orbit per pixel of horizontal drag. 0.25 — a full turn in 1,440 px.
 *
 * See the file header for why this and the tilt are not the same number.
 */
export const ORBIT_DEGREES_PER_PIXEL = 0.25;

/** Degrees of tilt per pixel of vertical drag. 0.08 — the 45..64 range in 238 px. */
export const TILT_DEGREES_PER_PIXEL = 0.08;

/**
 * The pose a Shift+drag of `dx`, `dy` **pixels** moves `from` to. Yaw wraps, pitch clamps.
 *
 * Pure, and takes pixels rather than an event, so the entire mapping — both signs, both rates, the
 * wrap and the clamp — is exercised with plain numbers in `orbit.test.ts` and no `PointerEvent`.
 * `follow` is carried through unchanged: switching it off is the *control's* decision (a drag that
 * moved nothing must not disarm a mode), not the mapping's.
 */
export function orbitTo(from: CameraPose, dx: number, dy: number): CameraPose {
  return {
    ...from,
    // Right is a *fall* in yaw because the protocol's yaw runs anticlockwise seen from above — east
    // is -90 — and turning right is turning toward east. `rig.wrapYaw` for the whole convention.
    yaw: wrapYaw(from.yaw - dx * ORBIT_DEGREES_PER_PIXEL),
    // Down the screen is a *rise* in pitch, because pitch is degrees below the horizontal: pulling
    // the mouse toward you tips the camera over onto the top of the world.
    pitch: clampPitch(from.pitch + dy * TILT_DEGREES_PER_PIXEL),
  };
}

/**
 * Whether this press belongs to the orbit rather than to click-to-move.
 *
 * The one predicate, called from both sides of the split — see the file header. Middle and right
 * buttons are nobody's here: `pointer.ts` leaves them to the browser (its context menu still opens
 * over the canvas) and so does this.
 */
export function claimsOrbit(event: { readonly button: number; readonly shiftKey: boolean }): boolean {
  return event.button === 0 && event.shiftKey;
}

/**
 * The Shift+drag listener, over the canvas only.
 *
 * Scoped exactly as `PointerControl` and `Dolly` are — attached to `renderer.domElement`, refusing
 * outright when the caret is in the command line or the login card is up (`typing`) or when the event
 * is aimed at a form control.
 */
export class OrbitControl {
  /** Same discipline as `Input.typing` — composed by `main.ts` from the log focus and the login gate. */
  typing = false;

  /**
   * Fired with the new pose whenever a drag moved it. `main.ts` writes the rig — and **does not
   * remember**; see {@link onSettled}.
   */
  onPose: ((pose: CameraPose) => void) | undefined;

  /**
   * Fired once when a drag that actually turned the camera ends. `main.ts` remembers the pose here.
   *
   * A separate callback because {@link onPose} fires on every `pointermove` — sixty times a second
   * while the hand is moving — and `dolly.rememberPose` is a synchronous `localStorage.setItem`.
   * The wheel gets away with remembering per notch because a notch is a discrete event a few times a
   * second; a drag is not, and writing storage per frame of a gesture is the kind of thing that shows
   * up as the camera feeling heavy on a slow disk. The end of the gesture is also the only moment the
   * remembered value is the one the owner *chose* rather than one they dragged through.
   */
  onSettled: ((pose: CameraPose) => void) | undefined;

  /** The pose to move *from*. Injected, because the rig owns the truth and this owns the gesture. */
  poseOf: (() => CameraPose) | undefined;

  private element: HTMLElement | undefined;
  private pointerId: number | undefined;
  private lastX = 0;
  private lastY = 0;
  private turned = false;

  /** Whether a Shift+drag is live — `__debug3d.orbiting`, and what suppresses the follow ease. */
  get orbiting(): boolean {
    return this.pointerId !== undefined;
  }

  attach(element: HTMLElement): void {
    this.element = element;
    element.addEventListener('pointerdown', this.handlePointerDown);
    element.addEventListener('pointermove', this.handlePointerMove);
    element.addEventListener('pointerup', this.handlePointerUp);
    element.addEventListener('pointercancel', this.handlePointerUp);
    element.addEventListener('lostpointercapture', this.handlePointerUp);
    // A button held while the tab loses focus never sends its `pointerup` — `pointer.ts`'s note, for
    // the same reason, and here it would leave the camera spinning on the next mouse move.
    window.addEventListener('blur', this.handleBlur);
  }

  detach(): void {
    const element = this.element;
    if (element) {
      element.removeEventListener('pointerdown', this.handlePointerDown);
      element.removeEventListener('pointermove', this.handlePointerMove);
      element.removeEventListener('pointerup', this.handlePointerUp);
      element.removeEventListener('pointercancel', this.handlePointerUp);
      element.removeEventListener('lostpointercapture', this.handlePointerUp);
    }
    window.removeEventListener('blur', this.handleBlur);
    this.element = undefined;
    this.pointerId = undefined;
  }

  /**
   * A claimed press, already resolved to client pixels — the state machine's own entry point, so
   * `orbit.test.ts` drives it without a `PointerEvent`.
   */
  press(pointerId: number, x: number, y: number): void {
    this.pointerId = pointerId;
    this.lastX = x;
    this.lastY = y;
    this.turned = false;
  }

  /**
   * The pointer moved while held. Returns the pose it produced, or `undefined` for a press that has
   * not moved a pixel — which matters, because a Shift+*click* that never became a drag must not
   * count as the hand taking the camera and must not disarm follow mode.
   */
  drag(pointerId: number, x: number, y: number): CameraPose | undefined {
    if (pointerId !== this.pointerId) return undefined;
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    if (dx === 0 && dy === 0) return undefined;
    const from = this.poseOf?.();
    if (!from) return undefined;
    // Applied from the *live* pose every move rather than accumulated from the press, so a drag that
    // runs into the pitch clamp and comes back out again tracks the hand instead of unwinding a
    // stored total — the same reason `Dolly` reads `poseOf` per notch.
    const next = orbitTo(from, dx, dy);
    if (next.yaw === from.yaw && next.pitch === from.pitch) return undefined;
    this.turned = true;
    this.onPose?.(next);
    return next;
  }

  /** A release, by whatever event reported it. `true` if the gesture actually turned the camera. */
  release(pointerId: number): boolean {
    if (pointerId !== this.pointerId) return false;
    return this.settle();
  }

  /** End whatever gesture is live and fire {@link onSettled} if it turned anything. */
  private settle(): boolean {
    const turned = this.turned;
    this.pointerId = undefined;
    this.turned = false;
    if (turned) {
      const pose = this.poseOf?.();
      if (pose) this.onSettled?.(pose);
    }
    return turned;
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.typing || intoFormControl(event.target)) return;
    if (!claimsOrbit(event)) return;
    const element = this.element;
    if (!element) return;
    // Or the drag selects the page's text the moment it leaves the canvas.
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    this.press(event.pointerId, event.clientX, event.clientY);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    // `clientX/Y` rather than `offsetX/Y`: a delta wants one origin for the whole gesture, and
    // `offsetX` is measured from whatever element the pointer is over — which under capture is this
    // one, but only until somebody puts a child in the canvas host.
    this.drag(event.pointerId, event.clientX, event.clientY);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.release(event.pointerId);
  };

  // A tab that loses focus mid-drag still settles: the camera is where the hand left it, and the
  // owner would be entitled to find it there again after a reload.
  private readonly handleBlur = (): void => {
    this.settle();
  };
}

/* -------------------------------------------------------------------------- */
/* Follow mode                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Seconds for the camera to close **half** the angle to the player's back. 0.30.
 *
 * A half-life rather than a rate, so the ease is frame-rate independent by construction
 * (`1 - 2^(-dt/T)`) and so the number means something you can check with a stopwatch: 90% of the arc
 * in 1.0 s, 99% in 2.0 s. A 90° corner is visibly *swung*, not cut.
 *
 * **It is deliberately far slower than the body it chases.** `anim.TURN_RATE` is 10 rad/s, which
 * turns a body through 90° in 0.16 s; the wire's yaw is one of four cardinals, so every corner is a
 * 90° step function. At the body's rate the camera would snap with it and the world would jump. At
 * this rate the body turns *inside* the frame and the frame comes after — which is the difference
 * between a camera and a pole welded to somebody's shoulders.
 */
export const FOLLOW_HALF_LIFE_S = 0.3;

/**
 * Degrees of disagreement the ease ignores. 0.05.
 *
 * The tail of an exponential never arrives, so without a floor the yaw would write a new value every
 * frame forever — and every write recomputes the shadow box and asks `interior.ts` for a wall set.
 * Below a twentieth of a degree the camera has arrived; snapping the last of it is invisible and
 * makes "the follow is settled" a state the rest of the frame can be cheap in.
 */
export const FOLLOW_SETTLE_DEGREES = 0.05;

/**
 * One step of the ease, in degrees. Pure — the whole mode's arithmetic, testable with two numbers.
 *
 * The short way round, always: 170° to -170° is a 20° swing through south, not a 340° tour through
 * north. That is `anim.turnToward`'s rule and this is its own copy rather than a call, because the
 * camera's yaw is in degrees and eased by half-life while a body's is in radians and rate-limited —
 * *the camera's yaw and the body's yaw are different things* even when one is chasing the other.
 */
export function followStep(from: number, to: number, seconds: number): number {
  const delta = wrapYaw(to - from);
  if (Math.abs(delta) <= FOLLOW_SETTLE_DEGREES) return wrapYaw(to);
  if (!(seconds > 0)) return wrapYaw(from);
  const closed = 1 - 2 ** (-seconds / FOLLOW_HALF_LIFE_S);
  return wrapYaw(from + delta * closed);
}

/**
 * The mode: whether the camera keeps itself behind the player, and how it gets there.
 *
 * Holds no yaw of its own — the rig's yaw is the truth and this only ever answers "what should it be
 * next frame?", which is what keeps a hand-turned yaw and a followed yaw the same number rather than
 * two that have to be reconciled.
 */
export class FollowCamera {
  /** Armed. Written by the **O** key, by the remembered pose, and (to `false`) by a Shift+drag. */
  enabled: boolean;

  /**
   * Whether a body's heading has ever been applied.
   *
   * `body.ts`'s `yawSeeded`, one level up and for the same reason: the first frame after arriving in
   * the world has no previous heading to turn *from*, so easing would swing the camera in from
   * wherever the last session left it. First sight snaps; every frame after that eases. Cleared on a
   * `welcome` or a Place change, which is the only other time "first sight" is true again.
   */
  private seeded = false;

  constructor(enabled: boolean) {
    this.enabled = enabled;
  }

  /** A new world, or a new body. The next heading is a first sight again. */
  clear(): void {
    this.seeded = false;
  }

  /**
   * What the rig's yaw should be this frame, or `undefined` to leave it alone.
   *
   * `targetRadians` is `EntityView.yaw` off the wire — M7a's float, the same field M7b turns bodies
   * with — and the conversion to degrees is the *only* place the two units meet. `suspended` is the
   * live Shift+drag: the hand outranks the mode for as long as the button is down, without disarming
   * it, so the camera does not fight the drag frame by frame and does not need to be re-enabled after
   * every gesture that started before the disarm landed.
   */
  update(yawDegrees: number, targetRadians: number | undefined, seconds: number, suspended: boolean): number | undefined {
    if (!this.enabled || suspended || targetRadians === undefined) return undefined;
    const target = wrapYaw((targetRadians * 180) / Math.PI);
    if (!this.seeded) {
      this.seeded = true;
      return target;
    }
    const next = followStep(yawDegrees, target, seconds);
    return next === yawDegrees ? undefined : next;
  }
}
