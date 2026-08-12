/**
 * Click-to-move and hold-to-steer — `scene.ts:2506-2723`'s pointer handling, re-expressed without
 * Phaser and without panning (see the file's closing note).
 *
 * ## The two gestures, and where the line between them is drawn
 *
 * A press is a click first and the start of a possible hold second, exactly as `scene.ts:2559-2561`
 * frames it: `beginDrag` and the click both fire on **every** qualifying left press, unconditionally.
 * What decides which the player *meant* is time, not the event stream — `updateDrag` polls the elapsed
 * hold against {@link HOLD_THRESHOLD_MS} (`scene.ts:853`, `DRAG_HOLD_MS = 150`) once a frame, and the
 * instant it is crossed the press stops being a click and starts being a joystick: the route the click
 * fired is abandoned (the caller sends `stop`) and every subsequent frame steers toward the pointer
 * instead.
 *
 * That "once a frame" is load-bearing and is why {@link PointerControl.tick} exists as a method the
 * render loop calls, separately from the `pointerdown`/`pointermove` handlers. The 3D camera follows the
 * character every frame (`rig.ts`), so a screen position that has not moved can still unproject to a
 * *different* ground point from one frame to the next — the exact 3D analogue of `scene.ts:2689`'s
 * `cameras.main.getWorldPoint`, which re-resolves a screen pixel to a world point every frame because the
 * 2D camera is scrolling too. Recomputing the heading only on `pointermove` would make the joystick lag
 * or stall while the character walks past the aim point with the hand never moving — a behaviour 2D does
 * not have and this class is not entitled to introduce.
 *
 * ## Decoupled from `three` and from `World3D`, on purpose
 *
 * This class knows timestamps, normalised device coordinates and simulation pixels — nothing about a
 * camera, a scene, or a seen bitset. Where a screen point lands is injected as {@link
 * PointerControl.resolve}, wired once by `main.ts` from `unprojectToGround`, `frame.ts`'s
 * `pixelOfMetres` and `World3D.hasSeenTile`. That is what makes the click-vs-hold state machine
 * testable with plain numbers and a fake resolver (`pointer.test.ts`), the same reason `entities.ts`'s
 * `step` takes a grid and an intent rather than reaching into a `World3D` itself.
 *
 * ## The seen-gate applies to the click and never to the steer
 *
 * `index.html:1003`'s hint for the 2D drag is explicit: *"Unlike Click this is NOT fog-gated… it is
 * steering, and steering earns every tile at walking pace."* This class carries that split at the root:
 * {@link PointerTarget.seen} rides along on every resolve, but only `press`'s caller (`main.ts`'s
 * `onPress`) ever reads it, to decide whether to send `moveTo`. `tick` reads only `simX`/`simY` and
 * never `seen`, so a hold that started on unseen ground steers exactly as one that started on lit
 * ground — the flag is data this class carries, not a rule it enforces.
 *
 * This is itself a **3D-specific addition**, not a straight port: the 2D `requestMoveTo`
 * (`scene.ts:2712-2723`) sends every press unfiltered and lets the server's `pathFailed` be the only
 * refusal, on the reasoning that a Phaser click can only ever land on a tile the camera is already
 * rendering. A ray-plane unprojection has no such natural bound, so gating the send client-side here is
 * the safer default at grey-box; see `unproject.ts`'s header for why a plane and not a mesh answers it.
 *
 * ## What a refusal looks like here, and why it is quieter than 2D's
 *
 * 2D flashes a ring where a refused click landed (`scene.ts:2811-2829`, `flashDenied`) because the
 * server always answers, even wrongly. Here, ground outside the seen set never reaches the server at
 * all — there is no round trip to react to, and writing a *local* refusal sentence would repeat the
 * mistake `scene.ts:2705-2710` documents fixing: *"a player who clicked into the dark read two
 * differently-worded sentences about one click."* So an unseen click is a plain no-op: `onPress` still
 * fires (a hold can still start from it), nothing is sent, nothing is drawn.
 *
 * ## The gesture this class does *not* get: Shift+drag — M8
 *
 * The camera orbits on a shifted left drag now (`orbit.ts`), on the same element, from the same
 * button. That gesture must be **neither** of this file's two: a Shift+drag may not send a `moveTo`
 * and may not start a steer, and — the half that is easy to forget — an unshifted press must behave
 * exactly as it always did, including the 150 ms hold that turns it into a joystick.
 *
 * The split is one predicate, `orbit.claimsOrbit`, imported here rather than restated: this listener
 * refuses what it claims and `OrbitControl`'s takes only what it claims, so the two cannot disagree
 * about a press. **The refusal is at `pointerdown`, before `press` is ever called**, which is what
 * makes it total — `onPress` never fires, so `main.ts` has no target to send, and `tick` returns on
 * the first line because no pointer is held, so no hold can cross the threshold. There is no path
 * from a shifted press to either outcome, rather than a flag checked at each of them.
 *
 * Shift is read **once, off the `pointerdown` event**, and never polled — `CLAUDE.md` gotcha 5b, the
 * same discipline `input.ts` keeps for Shift+W. Releasing Shift mid-drag therefore does not hand the
 * gesture over to this class: the press was already spoken for, `this.pointerId` was never set, and
 * the moves and the release go to the orbit that started them.
 *
 * ## Also not ported
 *
 * **Right-drag panning.** In 2D it lets go of the camera follow while the left button is the joystick;
 * here the camera is rigidly bolted to the player's position and only its *angles* are free, so there
 * is no follow to let go of and the gesture has nothing to attach to. A right or middle press is left
 * alone entirely — {@link PointerControl}'s `pointerdown` listener returns before touching the event
 * at all, so the browser's own context menu still opens on a right click, exactly as it would over
 * any other canvas.
 */

import { normaliseIntent } from '@mygame/shared';

import { intoFormControl } from './input.ts';
import { claimsOrbit } from './orbit.ts';

/** Milliseconds a press must be held before it stops being a click and starts steering. `scene.ts:853`. */
export const HOLD_THRESHOLD_MS = 150;

/** Granularity the steer heading is rounded to before it is compared or sent. `scene.ts:867`. */
export const HEADING_STEPS = 100;

/** Where a screen point resolves to, in the world. Carries `seen` for the caller, not for this class. */
export interface PointerTarget {
  readonly tx: number;
  readonly ty: number;
  /** Simulation pixels — the continuous aim point a steer intent is computed against. */
  readonly simX: number;
  readonly simY: number;
  /** Whether `(tx, ty)` is in the character's `seen` bitset. Read by `main.ts`'s `onPress`, not here. */
  readonly seen: boolean;
}

function ndcOfEvent(event: PointerEvent, element: HTMLElement): { readonly x: number; readonly y: number } {
  const width = element.clientWidth || 1;
  const height = element.clientHeight || 1;
  return { x: (event.offsetX / width) * 2 - 1, y: -(event.offsetY / height) * 2 + 1 };
}

export class PointerControl {
  /** Same discipline as `Input.typing` — composed by `main.ts` from the log focus and the login gate. */
  typing = false;

  /**
   * Fired on every qualifying left press, immediately, with the resolved target (or `undefined` off
   * the ground plane). `scene.ts:2506-2563`'s `onPointerDown`, minus the entity/portal hit-tests —
   * this class only ever asks the ground.
   */
  onPress: ((target: PointerTarget | undefined) => void) | undefined;

  /** Fired the instant a hold crosses {@link HOLD_THRESHOLD_MS}. The caller sends `stop`. `scene.ts:2669-2677`. */
  onSteerStart: (() => void) | undefined;

  /** Screen point to world tile, injected. See the file header for why this class holds neither `three` nor `World3D`. */
  resolve: ((ndcX: number, ndcY: number) => PointerTarget | undefined) | undefined;

  private element: HTMLElement | undefined;
  private pointerId: number | undefined;
  private pressedAt = 0;
  private ndcX = 0;
  private ndcY = 0;
  private steeringNow = false;
  private intentX = 0;
  private intentY = 0;
  private lastResolved: PointerTarget | undefined;

  /** Whether the primary button is held, from press to release — `__debug3d.pointerDown`. */
  get pointerDown(): boolean {
    return this.pointerId !== undefined;
  }

  /** Whether a hold has crossed the threshold and is currently driving a steer intent. `__debug3d.steering`. */
  get steering(): boolean {
    return this.steeringNow;
  }

  /** The last point the pointer resolved to, however stale by a frame — `main.ts`'s `__debug3d.clickTarget`. */
  get lastTarget(): PointerTarget | undefined {
    return this.lastResolved;
  }

  /**
   * The steer intent this frame, normalised and quantised — `{x:0,y:0}` unless {@link steering}.
   *
   * Zero rather than the frozen last heading when not steering, so a caller that folds this straight
   * into the frame's transmitted intent (`main.ts`, mirroring `scene.ts:4434-4438`) sends the release
   * exactly as a key release does: one `steer 0,0` and nothing more.
   */
  intent(): { readonly x: number; readonly y: number } {
    return this.steeringNow ? { x: this.intentX, y: this.intentY } : { x: 0, y: 0 };
  }

  attach(element: HTMLElement): void {
    this.element = element;
    // Otherwise a touch drag scrolls or zooms the page instead of steering — there is no Phaser
    // input plugin here claiming the gesture first.
    element.style.touchAction = 'none';
    element.addEventListener('pointerdown', this.handlePointerDown);
    element.addEventListener('pointermove', this.handlePointerMove);
    element.addEventListener('pointerup', this.handlePointerUp);
    element.addEventListener('pointercancel', this.handlePointerUp);
    element.addEventListener('lostpointercapture', this.handlePointerUp);
    // A button held while the tab loses focus never sends its `pointerup` — `input.ts`'s `blur` note,
    // for the same reason.
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
    this.clearState();
  }

  /**
   * A qualifying left press, already resolved to normalised device coordinates by the caller.
   *
   * Exported as its own method — not folded into the private DOM listener — so the click-vs-hold state
   * machine is exercised directly in `pointer.test.ts` with a fake {@link resolve} and no `PointerEvent`
   * at all. `scene.ts:2561-2562`'s `beginDrag` + `requestMoveTo` pair, unconditionally together.
   */
  press(pointerId: number, now: number, ndcX: number, ndcY: number): void {
    this.pointerId = pointerId;
    this.pressedAt = now;
    this.ndcX = ndcX;
    this.ndcY = ndcY;
    this.steeringNow = false;
    this.intentX = 0;
    this.intentY = 0;
    const target = this.resolve?.(ndcX, ndcY);
    this.lastResolved = target;
    this.onPress?.(target);
  }

  /** The pointer moved while held. Only remembers where — {@link tick} does the work, and for why see the file header. */
  drag(pointerId: number, ndcX: number, ndcY: number): void {
    if (pointerId !== this.pointerId) return;
    this.ndcX = ndcX;
    this.ndcY = ndcY;
  }

  /** A release, by whatever event reported it. */
  release(pointerId: number): void {
    if (pointerId !== this.pointerId) return;
    this.clearState();
  }

  /**
   * Ends a live press with no pointer event of its own — a movement key or an exit taking the wheel
   * back, `scene.ts:4407-4410` and `:4684-4689`'s `endDrag()` calls. Also releases the DOM's pointer
   * capture, so the button does not go on being "held" as far as the browser is concerned after the
   * game has already let go of it.
   */
  cancel(): void {
    const id = this.pointerId;
    if (id === undefined) return;
    this.clearState();
    if (this.element?.hasPointerCapture(id)) this.element.releasePointerCapture(id);
  }

  /**
   * Once a frame, from the render loop, while a press is live — see the file header for why this
   * cannot wait for the next `pointermove`. `selfSimX`/`selfSimY` are the character's *predicted*
   * position, simulation pixels — `scene.ts:2682-2684`'s reasoning carries over exactly: steering from
   * the server position would aim from a fraction of a second behind and lag the cursor at close range.
   */
  tick(now: number, selfSimX: number, selfSimY: number): void {
    if (this.pointerId === undefined) return;
    const target = this.resolve?.(this.ndcX, this.ndcY);
    this.lastResolved = target;
    if (!this.steeringNow) {
      if (now - this.pressedAt < HOLD_THRESHOLD_MS) return;
      this.steeringNow = true;
      this.onSteerStart?.();
    }
    // A one-frame graze past the horizon (see `unprojectToGround`) holds the last heading rather than
    // zeroing it — a momentary miss reads as nothing happening, not as the character catching its foot.
    if (!target) return;
    const heading = normaliseIntent(target.simX - selfSimX, target.simY - selfSimY);
    // Rounded so a motionless pointer against a motionless character produces a byte-identical heading
    // frame after frame, and `main.ts`'s resend-on-change dedupe sends it once rather than every frame.
    this.intentX = Math.round(heading.x * HEADING_STEPS) / HEADING_STEPS;
    this.intentY = Math.round(heading.y * HEADING_STEPS) / HEADING_STEPS;
  }

  private clearState(): void {
    this.pointerId = undefined;
    this.steeringNow = false;
    this.intentX = 0;
    this.intentY = 0;
    this.lastResolved = undefined;
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    // Both of `CLAUDE.md`'s Phaser input traps are moot here (there is no Phaser), but the discipline
    // they taught is exactly this line: never read, and above all never `preventDefault`, a pointer
    // aimed at a form control or arriving while the caret is in the command line or the login card.
    if (this.typing || intoFormControl(event.target)) return;
    if (event.button !== 0) return; // right/middle would pan in 2D; skipped here, see the file header
    // M8's split, and it has to be here rather than inside `press`: a shifted press must produce no
    // `onPress` at all, or `main.ts` sends a `moveTo` for the ground the orbit started over.
    if (claimsOrbit(event)) return;
    const element = this.element;
    if (!element) return;
    event.preventDefault();
    element.setPointerCapture(event.pointerId);
    const ndc = ndcOfEvent(event, element);
    this.press(event.pointerId, performance.now(), ndc.x, ndc.y);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const element = this.element;
    if (!element) return;
    const ndc = ndcOfEvent(event, element);
    this.drag(event.pointerId, ndc.x, ndc.y);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    this.release(event.pointerId);
  };

  private readonly handleBlur = (): void => {
    this.clearState();
  };
}
