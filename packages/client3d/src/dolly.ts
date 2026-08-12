/**
 * The wheel, the tilt and the remembered pose — M6's live camera rig, from the owner's two questions.
 *
 * > *"are we going to be able to zoom out?"* and *"we may need to lower the angles so we can see more
 * > what is in front"* — 2026-08-13.
 *
 * Neither is answerable by argument, and neither is answerable by shipping a number and asking. So
 * this is a **tuning instrument**: the wheel over the canvas dollies, Shift and the wheel tilts, the
 * numbers are on `__debug3d.camera`, and the pose survives a reload. The owner finds the frame they
 * like by eye and reads it off; what gets baked as the default is then a decision made from a
 * screenshot rather than from a paragraph.
 *
 * ## Why a wheel and not two more letter keys
 *
 * `CLAUDE.md` gotcha 5a is the reason, restated for the DOM: every letter this client binds is a
 * letter that can vanish out of the command line, and the mitigation — `input.typing` plus
 * `intoFormControl` on every listener — is a thing you have to remember on each one. The wheel binds
 * no letter at all, it is the gesture every 3D application already uses for exactly this, and it is
 * *continuous*, which matters here more than it usually would: the owner is hunting for a frame, and
 * a hunt wants a dial rather than a staircase. Only the reset takes a key.
 *
 * ## The trap this file exists to have already hit
 *
 * **Shift + wheel is not a vertical wheel event.** Chrome on Windows and Linux, and Safari, turn a
 * shifted wheel into a *horizontal* scroll before the event is dispatched: `deltaY` is 0 and `deltaX`
 * carries the notches. Firefox does not. A handler that reads `deltaY` alone therefore tilts on some
 * of the owner's machines and silently does nothing on others, which would read as "the pitch control
 * is broken" rather than as a browser difference. {@link wheelNotches} takes whichever of the two is
 * non-zero, and the test drives both shapes.
 *
 * The second trap is `deltaMode`: the same physical notch is 100 in pixel mode, 3 in line mode and 1
 * in page mode, so a step scaled off the raw number is thirty times bigger on a mouse Firefox has
 * decided to report in lines. Normalised to notches here, once.
 *
 * ## What is deliberately not here
 *
 * **No yaw.** `rig.ts`'s header makes fixed yaw a decision rather than an omission — north is up the
 * frame, which is what makes the 2D map and the 3D view describe the same place — and a milestone
 * about how far away the camera stands is not the milestone to overturn it in.
 *
 * **No smoothing.** The dolly writes the rig directly, exactly as the follow does, and for the same
 * reason: a second time constant is one more thing to tune and the one that would be invisible when
 * it was wrong.
 */

import { intoFormControl } from './input.ts';
import { CAMERA_DISTANCE, CAMERA_PITCH_MIN, clampDistance, clampPitch } from './rig.ts';

/**
 * The owner's ruling, 2026-08-13, after an evening of tuning: *"the current view Azder is seeing is
 * what I like.. that angle.. I would still like to be able to zoom in and out but lock that angle
 * in for now."* So: the wheel still dollies, the tilt is **gated off**, and the pose store moved
 * from `sessionStorage` to `localStorage` (with a one-way migration) so the exact angle the owner
 * had on screen when they said it outlives the tab that heard it. Flip this to re-open the tilt.
 */
export const PITCH_LOCKED = true;

/**
 * Metres per notch, as a **ratio**. 1.06 — about a twelfth of the range per notch.
 *
 * Multiplicative rather than additive so a notch changes the frame by the same *proportion* at both
 * ends of the clamp: a flat 2 m step is 8% of the frame at 24 m and 4% at 48, which feels like the
 * wheel getting stuck as you pull back. `ln 2 / ln 1.06` is 11.9, so the whole 24..48 m range is
 * twelve notches — one flick of a wheel, and fine enough to stop on a frame you like.
 */
export const DOLLY_RATIO = 1.06;

/**
 * Degrees per notch of a shifted wheel. 1.5 — about a thirteenth of the 45..64 range.
 *
 * Additive, because a degree is already the unit the eye judges a tilt in and the range is small
 * enough that a ratio would buy nothing. Matched to the dolly's twelve notches on purpose: both
 * controls cross their whole range in one comfortable flick, so neither feels like the slow one.
 */
export const PITCH_DEGREES_PER_NOTCH = 1.5;

/**
 * Where the pose is remembered. `localStorage` since the angle lock — a chosen frame is the
 * owner's property, not a tab's — with a silent read-migration from the `sessionStorage` era so
 * the very pose the owner locked in survives the switch without anyone reading a console.
 */
export const CAMERA_STORAGE_KEY = 'mygame:camera3d';

/** A pose, as it is remembered and as `__debug3d.camera` reads it. */
export interface CameraPose {
  readonly distance: number;
  readonly pitch: number;
}

/**
 * What a fresh machine starts at, and what a reset returns to.
 *
 * Pitch is the clamp's forward-looking floor rather than the authored 64: the owner's whole camera
 * arc ("lower the angles so we can see more what is in front" → the lock) points down-range, and a
 * machine with a remembered pose never reads this anyway — the migration keeps the owner's own
 * angle to the degree.
 */
export const DEFAULT_POSE: CameraPose = { distance: CAMERA_DISTANCE, pitch: CAMERA_PITCH_MIN };

/**
 * Notches of wheel in a wheel event, normalised — positive is *away from the viewer*, which zooms out.
 *
 * See the file header for both traps this closes. Returns 0 for an event that carries no scroll at
 * all, which a trackpad's momentum tail can produce.
 */
export function wheelNotches(event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>): number {
  // Shift-swapped wheels arrive on `deltaX`; a genuine horizontal wheel would too, and treating it
  // as a notch is the friendlier reading of a gesture nothing else here claims.
  const raw = event.deltaY !== 0 ? event.deltaY : event.deltaX;
  if (raw === 0) return 0;
  // 0 = pixels (100 per notch), 1 = lines (3), 2 = pages (1). `WheelEvent.DOM_DELTA_*`, by number
  // rather than by name because the constants live on the DOM class and this must run headless.
  const perNotch = event.deltaMode === 1 ? 3 : event.deltaMode === 2 ? 1 : 100;
  return raw / perNotch;
}

/** The pose `notches` of an unshifted wheel moves `from` to. Clamped. */
export function dollyTo(from: CameraPose, notches: number, ceiling?: number): CameraPose {
  return { distance: clampDistance(from.distance * DOLLY_RATIO ** notches, ceiling), pitch: from.pitch };
}

/**
 * The pose `notches` of a shifted wheel moves `from` to. Clamped.
 *
 * Scrolling away from the viewer — the same direction that pulls the camera back — *lowers* the
 * pitch, because both are the same instinct: show me more of what is out there.
 */
export function tiltTo(from: CameraPose, notches: number): CameraPose {
  return { distance: from.distance, pitch: clampPitch(from.pitch - notches * PITCH_DEGREES_PER_NOTCH) };
}

/** Wrapped because storage access throws outright in a partitioned or cookie-blocked context. */
function read(key: string): string | undefined {
  try {
    const kept = localStorage.getItem(key);
    if (kept !== null) return kept;
    // The sessionStorage era's value — the pose the owner was looking at when they locked the
    // angle. Migrated on first read so it becomes permanent without a console ever being opened.
    const legacy = sessionStorage.getItem(key);
    if (legacy !== null) {
      localStorage.setItem(key, legacy);
      sessionStorage.removeItem(key);
      return legacy;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A machine that cannot remember simply starts from the default next reload.
  }
}

function erase(key: string): void {
  try {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored, nothing lost.
  }
}

/**
 * The remembered pose, or `undefined`.
 *
 * Parsed defensively and clamped on the way out: the value is user-editable by definition (it is one
 * `sessionStorage.setItem` away in the same console the owner is reading `__debug3d` in), and a
 * pitch of 89 degrees out of storage would put the rig somewhere `rig.ts`'s own constructor refuses
 * to go.
 */
export function rememberedPose(): CameraPose | undefined {
  const stored = read(CAMERA_STORAGE_KEY);
  if (!stored) return undefined;
  const [rawDistance, rawPitch] = stored.split(',');
  const distance = Number(rawDistance);
  const pitch = Number(rawPitch);
  if (!Number.isFinite(distance) || !Number.isFinite(pitch)) return undefined;
  return { distance: clampDistance(distance), pitch: clampPitch(pitch) };
}

/**
 * Remember a pose, or forget it when it is the default one.
 *
 * Forgetting matters: a tab that stored `36,64` and a tab that stored nothing must behave
 * identically, or the day the default moves the owner's browser will quietly keep showing them the
 * old frame and they will report that the change did not land.
 */
export function rememberPose(pose: CameraPose): void {
  if (pose.distance === DEFAULT_POSE.distance && pose.pitch === DEFAULT_POSE.pitch) {
    erase(CAMERA_STORAGE_KEY);
    return;
  }
  write(CAMERA_STORAGE_KEY, `${round(pose.distance)},${round(pose.pitch)}`);
}

/** Two decimals. A pose is a thing a human reads and retypes; 36.000000000000004 helps nobody. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The wheel listener, over the canvas only.
 *
 * Scoped exactly as `PointerControl` is — attached to `renderer.domElement`, so a wheel over the log
 * pane scrolls the log and never reaches here, and refusing outright when the caret is in the
 * command line or the login card is up (`typing`) or when the event is aimed at a form control. The
 * `intoFormControl` check is belt and braces given the element it is attached to, and it is here for
 * the same reason `pointer.ts` carries it: two listeners on one page that disagree about what counts
 * as typing is `CLAUDE.md` gotcha 5a arriving by a different door.
 *
 * A ctrl/meta/alt wheel is left entirely alone, without `preventDefault` — that is the browser's own
 * page-zoom gesture and a renderer has no business eating it.
 */
export class Dolly {
  /** Same discipline as `Input.typing` — composed by `main.ts` from the log focus and the login gate. */
  typing = false;

  /** Fired with the new pose whenever the wheel moved it. `main.ts` writes the rig and remembers. */
  onPose: ((pose: CameraPose) => void) | undefined;

  /** The pose to move *from*. Injected, because the rig owns the truth and this owns the gesture. */
  poseOf: (() => CameraPose) | undefined;

  /** The dolly's current ceiling, if the canvas is too wide for the ring. See `streamer.maxDistanceForAspect`. */
  ceilingOf: (() => number) | undefined;

  private element: HTMLElement | undefined;

  attach(element: HTMLElement): void {
    this.element = element;
    // `passive: false` or the `preventDefault` below is ignored with a console warning and the page
    // scrolls under the frame while the camera also moves.
    element.addEventListener('wheel', this.handleWheel, { passive: false });
  }

  detach(): void {
    this.element?.removeEventListener('wheel', this.handleWheel);
    this.element = undefined;
  }

  /**
   * A wheel gesture, already normalised — exported as its own method so the whole mapping is
   * exercised in `dolly.test.ts` with plain numbers and no `WheelEvent`.
   */
  apply(notches: number, shift: boolean): CameraPose | undefined {
    // The gate lives here as well as in the listener, and this is the copy that matters: the listener
    // has to check first so it does not `preventDefault` a wheel it is going to ignore, but *this* is
    // the one place a pose can change, so this is where the refusal has to be true.
    if (this.typing) return undefined;
    if (notches === 0) return undefined;
    // The angle lock: a shifted wheel changes nothing while the owner's ruling stands. `tiltTo`
    // stays exported and tested — the instrument is gated, not dismantled.
    if (shift && PITCH_LOCKED) return undefined;
    const from = this.poseOf?.();
    if (!from) return undefined;
    const next = shift ? tiltTo(from, notches) : dollyTo(from, notches, this.ceilingOf?.());
    if (next.distance === from.distance && next.pitch === from.pitch) return undefined;
    this.onPose?.(next);
    return next;
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.typing || intoFormControl(event.target)) return;
    // The browser's own zoom. Not ours to take.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    this.apply(wheelNotches(event), event.shiftKey);
  };
}
