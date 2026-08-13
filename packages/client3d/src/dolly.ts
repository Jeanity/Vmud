/**
 * The wheel and the remembered pose — M6's live camera rig, from the owner's two questions.
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
 * ## M8: the wheel stopped caring about Shift, and the pose grew a third number
 *
 * Both angles left this file for `orbit.ts`'s Shift+drag, which is where the owner asked for them.
 * That leaves the wheel doing **one** thing — zoom — and it now does it **whether or not Shift is
 * down**, which is not a shrug but the point: Shift is *held for the length of an orbit gesture*
 * now, and a wheel notch during an orbit has to mean what a wheel notch always means. A shifted wheel
 * that tilted (M6) or that refused (the angle lock) would both read as the zoom breaking whenever the
 * owner used the new camera. `wheelNotches`'s `deltaX` reading matters more than ever for the same
 * reason — see the trap below.
 *
 * The remembered pose gains `yaw` and `follow`, migration-safe, and `PITCH_LOCKED` is gone: the
 * owner's *"lock that angle in for now"* was answered by a gate because there was no better gesture
 * to give the tilt; there is one now, and a gate over a gesture the owner asked for by name is just
 * an off switch.
 *
 * ## What is deliberately not here
 *
 * **No smoothing.** The dolly writes the rig directly, exactly as the positional follow does, and for
 * the same reason: a second time constant is one more thing to tune and the one that would be
 * invisible when it was wrong. (`orbit.ts`'s follow mode has one, and its docblock argues for it.)
 */

import { intoFormControl } from './input.ts';
import { CAMERA_DISTANCE, CAMERA_PITCH_MIN, clampDistance, clampPitch, wrapYaw } from './rig.ts';

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
 * Degrees per notch of a wheel that is tilting rather than dollying. 1.5 — a thirteenth of 45..64.
 *
 * **Nothing in the client drives this any more**: M8 moved the tilt to `orbit.ts`'s vertical drag,
 * where the owner asked for it. {@link tiltTo} stays exported and tested because it is the *mapping*
 * — the direction a tilt runs and the clamp it stops at — and `__debug3d.camera.pitch` still writes
 * a pitch through the same clamp. Additive, because a degree is already the unit the eye judges a
 * tilt in and the range is small enough that a ratio would buy nothing.
 */
export const PITCH_DEGREES_PER_NOTCH = 1.5;

/**
 * Where the pose is remembered. `localStorage` since the angle lock — a chosen frame is the
 * owner's property, not a tab's — with a silent read-migration from the `sessionStorage` era so
 * the very pose the owner locked in survives the switch without anyone reading a console.
 */
export const CAMERA_STORAGE_KEY = 'mygame:camera3d';

/**
 * A marker on the end of a stored pose saying *"the `follow` in this value was chosen under the
 * current default"*.
 *
 * Deliberately a suffix rather than a new key: a new key would throw away the distance, the pitch and
 * the yaw with it, and those are the numbers the owner tuned by hand. **Bump this string whenever a
 * remembered field's default changes** — that is the whole mechanism, and it turns "the new default
 * silently loses to a stale save" from a bug somebody has to notice into a one-character edit.
 */
export const POSE_ERA = 'f1';

/** A pose, as it is remembered and as `__debug3d.camera` reads it. */
export interface CameraPose {
  readonly distance: number;
  readonly pitch: number;
  /**
   * Degrees, `(-180, 180]`, `0` = north — M8. See `rig.wrapYaw` for the units and the sign.
   *
   * A *wrapped* member of a type whose other two are clamped, which is the one thing to remember
   * about it: `orbitTo` can hand back 179.9 → -179.9 across one drag frame and every consumer has to
   * be fine with that.
   */
  readonly yaw: number;
  /**
   * Whether the camera keeps itself behind the player — M8, and the owner's *"always having the
   * camera behind my player"*.
   *
   * On the pose because it is remembered with it and reset with it, not because it is geometry. Not
   * to be confused with `rig.CameraRig.follow(x, y, z)`, which is the per-frame aim and happens
   * either way; the mode is `orbit.FollowCamera` and this is the flag that arms it.
   */
  readonly follow: boolean;
}

/**
 * **Whether a machine with nothing remembered starts with the camera glued behind the player. On.**
 *
 * ## It shipped `false`, and the reason was good
 *
 * M8 set this to `false` and wrote down exactly why, and the argument was not about the camera at all
 * — it was about `input.ts`. W was the world's **north** at every yaw, because a MUD's directions are
 * cardinal. With follow on, the camera sits behind the player and up-the-frame is wherever they last
 * walked, *"so a player facing south presses W to go north and walks toward the camera, which then
 * swings 180° behind them. That is the first thing anybody would try, and it would read as the feature
 * being broken rather than as two features that have not been introduced to each other."* The note
 * ended by naming its own remedy — *"the honest fix is camera-relative movement keys… Flip this to
 * `true` when it is made"* — and left the decision to the owner rather than taking it overnight.
 *
 * ## M8b made it, so the reason is retired
 *
 * `input.cameraRelative` rotates the steer vector through the rig's yaw, so W is now *away from the
 * camera* — which, with the camera behind the player, is the way the player faces. The failure this
 * constant was guarding against is not merely unlikely now; it is **unreachable**, because the
 * character can no longer walk toward a camera that is behind them. Follow-on-by-default stopped being
 * a hazard and became the coherent default: the two features have been introduced.
 *
 * The owner asked for the flip in the same breath as the rotation, 2026-08-13 — *"also having the
 * camera behind the player"*, after *"always having the camera behind my player"* the session before.
 *
 * **A machine that remembers a pose still gets what it stored**, follow included: `rememberedPose`
 * only falls back to this when the field is absent, which means a pre-M8 two- or three-field string.
 * Turning the mode off is still one press of **O**, and still says so in the log.
 */
export const FOLLOW_ON_FRESH = true;

/**
 * What a fresh machine starts at, and what a reset returns to.
 *
 * Pitch is the clamp's forward-looking floor rather than the authored 64: the owner's whole camera
 * arc ("lower the angles so we can see more what is in front" → the lock) points down-range, and a
 * machine with a remembered pose never reads this anyway — the migration keeps the owner's own
 * angle to the degree.
 *
 * **Yaw is north and follow is on** — the yaw because the world was authored under it and because
 * `input.cameraRelative` is the identity there, the mode because M8b retired the reason it shipped off.
 * See {@link FOLLOW_ON_FRESH}, whose argument was always about the keyboard rather than the camera.
 */
export const DEFAULT_POSE: CameraPose = {
  distance: CAMERA_DISTANCE,
  pitch: CAMERA_PITCH_MIN,
  yaw: 0,
  follow: FOLLOW_ON_FRESH,
};

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

/** The pose `notches` of the wheel moves `from` to. Clamped; everything else carried through. */
export function dollyTo(from: CameraPose, notches: number, ceiling?: number): CameraPose {
  return { ...from, distance: clampDistance(from.distance * DOLLY_RATIO ** notches, ceiling) };
}

/**
 * The pose `notches` of tilt moves `from` to. Clamped.
 *
 * Scrolling away from the viewer — the same direction that pulls the camera back — *lowers* the
 * pitch, because both are the same instinct: show me more of what is out there. `orbit.ts`'s drag
 * maps the same way and says so.
 */
export function tiltTo(from: CameraPose, notches: number): CameraPose {
  return { ...from, pitch: clampPitch(from.pitch - notches * PITCH_DEGREES_PER_NOTCH) };
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
 * `localStorage.setItem` away in the same console the owner is reading `__debug3d` in), and a pitch
 * of 89 degrees out of storage would put the rig somewhere `rig.ts`'s own constructor refuses to go.
 *
 * **Two fields or four, and a two-field value is the owner's own.** The angle lock's era wrote
 * `distance,pitch`; every such string still parses, taking north and {@link FOLLOW_ON_FRESH} — so the
 * distance and pitch that machine was showing survive to the degree, the same promise the
 * `sessionStorage` migration made. Missing fields default rather than voiding the whole value, because
 * a camera that silently forgot its distance over a new field would be a worse bug than the new field
 * is a feature.
 *
 * That the *mode* follows the current default rather than the era's is the right way round and is the
 * reason this reads {@link FOLLOW_ON_FRESH} instead of a literal: a string with no fourth field is a
 * machine that has never expressed an opinion about follow mode, and it should get today's answer. A
 * machine that **has** — any four-field string, including one whose fourth field is `0` — keeps what it
 * chose, which is what makes flipping the default safe for somebody mid-session.
 */
export function rememberedPose(): CameraPose | undefined {
  const stored = read(CAMERA_STORAGE_KEY);
  if (!stored) return undefined;
  const [rawDistance, rawPitch, rawYaw, rawFollow, rawEra] = stored.split(',');
  const distance = Number(rawDistance);
  const pitch = Number(rawPitch);
  if (!Number.isFinite(distance) || !Number.isFinite(pitch)) return undefined;
  const yaw = rawYaw === undefined || rawYaw === '' ? 0 : Number(rawYaw);
  // **A `follow` written before the default flipped is not a choice, and must not act like one.**
  // The owner reported the camera-behind feature as not landing, and it had: their browser was
  // holding a four-field pose saved during the hours when follow shipped *off*, and a stored `0`
  // outranks a changed default for ever. `rememberPose`'s own docblock predicted exactly this — *"a
  // tab that stored `36,45,0,0` and a tab that stored nothing must behave identically, or the day the
  // default moves the owner's browser will quietly keep showing them the old frame"* — and it was
  // right; the guard it described only covered the whole-pose-equals-default case, which a tuned
  // angle never hits. {@link POSE_ERA} is the narrow repair: a value from before the flip keeps its
  // distance, pitch and yaw (the owner tuned those by hand) and **re-reads the default for follow**,
  // exactly once. Anything saved since carries the marker and is honoured, including a deliberate off.
  const chosenEra = rawEra === POSE_ERA;
  return {
    distance: clampDistance(distance),
    pitch: clampPitch(pitch),
    // `wrapYaw` answers 0 for a NaN, so a corrupt third field is north rather than a broken camera.
    yaw: wrapYaw(yaw),
    follow: !chosenEra || rawFollow === undefined || rawFollow === '' ? DEFAULT_POSE.follow : rawFollow === '1',
  };
}

/**
 * Remember a pose, or forget it when it is the default one.
 *
 * Forgetting matters: a tab that stored `36,45,0,0` and a tab that stored nothing must behave
 * identically, or the day the default moves the owner's browser will quietly keep showing them the
 * old frame and they will report that the change did not land.
 *
 * **Follow's yaw is deliberately not written here.** `main.ts` calls this from the gestures — the
 * wheel, the drag, the debug knob — and never from the per-frame follow ease, which would be a
 * `localStorage` write sixty times a second. So what is remembered is the yaw the owner's *hand* last
 * chose, which is the one they would expect back.
 */
export function rememberPose(pose: CameraPose): void {
  if (
    pose.distance === DEFAULT_POSE.distance &&
    pose.pitch === DEFAULT_POSE.pitch &&
    pose.yaw === DEFAULT_POSE.yaw &&
    pose.follow === DEFAULT_POSE.follow
  ) {
    erase(CAMERA_STORAGE_KEY);
    return;
  }
  // The era marker rides along so the next read knows this `follow` was chosen under the current
  // default rather than inherited from an older one. See {@link POSE_ERA}.
  write(
    CAMERA_STORAGE_KEY,
    `${round(pose.distance)},${round(pose.pitch)},${round(pose.yaw)},${pose.follow ? 1 : 0},${POSE_ERA}`,
  );
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
   *
   * **Shift is not a parameter any more**, and that is M8's decision rather than an omission: the
   * modifier is held for the length of an orbit drag, so a notch rolled mid-orbit must zoom like any
   * other notch. See the file header.
   */
  apply(notches: number): CameraPose | undefined {
    // The gate lives here as well as in the listener, and this is the copy that matters: the listener
    // has to check first so it does not `preventDefault` a wheel it is going to ignore, but *this* is
    // the one place a pose can change, so this is where the refusal has to be true.
    if (this.typing) return undefined;
    if (notches === 0) return undefined;
    const from = this.poseOf?.();
    if (!from) return undefined;
    const next = dollyTo(from, notches, this.ceilingOf?.());
    if (next.distance === from.distance) return undefined;
    this.onPose?.(next);
    return next;
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.typing || intoFormControl(event.target)) return;
    // The browser's own zoom. Not ours to take.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    // `wheelNotches` reads whichever of `deltaY`/`deltaX` carries the scroll, which is what makes a
    // shifted wheel work at all on Chrome and Safari — see the header's trap. It stopped being about
    // the tilt and started being about zooming during an orbit; the code is the same and the reason
    // it is load-bearing is different.
    this.apply(wheelNotches(event));
  };
}
