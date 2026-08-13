/**
 * The Shift+drag and the follow mode — M8's two writers of the camera's yaw.
 *
 * Five properties, and each is a way the owner would report "the camera is broken" rather than a bug
 * with a name:
 *
 * 1. **The mapping's two signs.** Drag right must turn right and drag up must look up. Both have a
 *    plausible opposite (`orbit.ts`'s header argues each), and both are invisible in a screenshot —
 *    a reversed yaw looks like a working camera going the wrong way.
 * 2. **The wrap.** A yaw is a circle; the pose that comes out of a drag across the seam has to be a
 *    yaw and not 181 degrees, or `followSpring`'s shortest arc has two targets to choose between.
 * 3. **The discrimination.** A Shift+drag must send no `moveTo` and start no steer; an unshifted
 *    press must still do both, on the same button, on the same element. This is the property with
 *    the most ways to be *nearly* right.
 * 4. **The ease.** Frame-rate independent, shortest way round, and slower than the body it chases —
 *    with a floor, so the tail of the exponential does not write the rig sixty times a second
 *    forever.
 * 5. **First sight snaps.** Everything else eases; arriving in the world does not.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_POSE, type CameraPose } from './dolly.ts';
import { HOLD_THRESHOLD_MS, PointerControl, type PointerTarget } from './pointer.ts';
import { CAMERA_PITCH_MAX, CAMERA_PITCH_MIN } from './rig.ts';
import {
  FOLLOW_SMOOTH_SECONDS,
  FOLLOW_SETTLE_DEGREES,
  FollowCamera,
  ORBIT_DEGREES_PER_PIXEL,
  OrbitControl,
  TILT_DEGREES_PER_PIXEL,
  claimsOrbit,
  followSpring,
  orbitTo,
} from './orbit.ts';

const HOME: CameraPose = { ...DEFAULT_POSE, pitch: 55 };

describe('the orbit mapping', () => {
  it('turns right when the hand goes right, and looks up when it goes up', () => {
    /*
     * **The two signs, against the world rather than against themselves.** The protocol's yaw runs
     * anticlockwise seen from above (east is -90), so "turn right" is a *fall*; and pitch is degrees
     * below the horizontal, so "look up" is also a fall. Two falls with two different reasons, which
     * is exactly the pair a reader would assume had been copied from each other and got wrong.
     */
    assert.equal(orbitTo(HOME, 100, 0).yaw, HOME.yaw - 100 * ORBIT_DEGREES_PER_PIXEL);
    assert.ok(orbitTo(HOME, 100, 0).yaw < HOME.yaw, 'dragging right must turn the camera toward east');
    assert.ok(orbitTo(HOME, -100, 0).yaw > HOME.yaw, 'dragging left must turn it toward west');
    assert.equal(orbitTo(HOME, 0, 100).pitch, HOME.pitch + 100 * TILT_DEGREES_PER_PIXEL);
    assert.ok(orbitTo(HOME, 0, -100).pitch < HOME.pitch, 'dragging up must lower the pitch, toward the horizon');
    assert.ok(orbitTo(HOME, 0, 100).pitch > HOME.pitch, 'dragging down must tip the camera over the top');
  });

  it('crosses its whole range in a comfortable drag, and not the same one twice', () => {
    // A full turn in one screen-width, and the whole tilt range in a quarter of a screen height. The
    // two rates differ by three on purpose — see `orbit.ts` — and the ratio is asserted rather than
    // the numbers alone, because it is the ratio that stops a horizontal drag slamming the tilt.
    assert.equal(360 / ORBIT_DEGREES_PER_PIXEL, 1440);
    assert.ok(Math.abs((CAMERA_PITCH_MAX - CAMERA_PITCH_MIN) / TILT_DEGREES_PER_PIXEL - 237.5) < 1);
    assert.ok(ORBIT_DEGREES_PER_PIXEL / TILT_DEGREES_PER_PIXEL > 2.5, 'the tilt is too twitchy for a stray wobble');
  });

  it('wraps the yaw and clamps the pitch, which is the difference between a circle and a range', () => {
    // Two full turns right, from north, is north.
    let pose = HOME;
    for (let i = 0; i < 8; i++) pose = orbitTo(pose, 360, 0);
    assert.ok(Math.abs(pose.yaw - HOME.yaw) < 1e-9, `${pose.yaw} after two turns`);
    // Across the seam: 179 + 4 is -177, not 183.
    assert.ok(Math.abs(orbitTo({ ...HOME, yaw: 179 }, -4 / ORBIT_DEGREES_PER_PIXEL, 0).yaw - -177) < 1e-9);
    assert.ok(orbitTo({ ...HOME, yaw: -179 }, 4 / ORBIT_DEGREES_PER_PIXEL, 0).yaw > 176);
    // The pitch has ends and holds against them, however hard the hand pushes.
    assert.equal(orbitTo(HOME, 0, 10_000).pitch, CAMERA_PITCH_MAX);
    assert.equal(orbitTo(HOME, 0, -10_000).pitch, CAMERA_PITCH_MIN);
    // And neither axis touches the other two fields.
    const turned = orbitTo({ ...HOME, follow: true }, 300, -50);
    assert.equal(turned.distance, HOME.distance, 'an orbit must not zoom');
    assert.equal(turned.follow, true, 'the mapping does not disarm the mode — the control does');
  });

  it('is a diagonal drag, not two gestures: one move moves both angles', () => {
    const out = orbitTo(HOME, 120, 60);
    assert.notEqual(out.yaw, HOME.yaw);
    assert.notEqual(out.pitch, HOME.pitch);
  });
});

describe('the orbit gesture, against click-to-move and hold-to-steer', () => {
  it('claims a shifted left press and nothing else', () => {
    assert.equal(claimsOrbit({ button: 0, shiftKey: true }), true);
    assert.equal(claimsOrbit({ button: 0, shiftKey: false }), false, 'a plain click is click-to-move');
    // Right and middle stay the browser's, exactly as `pointer.ts` leaves them.
    assert.equal(claimsOrbit({ button: 2, shiftKey: true }), false);
    assert.equal(claimsOrbit({ button: 1, shiftKey: true }), false);
  });

  it('never emits a moveTo and never starts a steer — the property, through both classes', () => {
    /*
     * **The discrimination, driven through the real `PointerControl` state machine.** A shifted press
     * is refused at `pointerdown`, so `press` is never called at all: `onPress` cannot fire (no
     * `moveTo`), and `tick` returns on its first line however long the button is held (no steer). The
     * test drives the *listener*, because the refusal lives there and calling `press` directly would
     * be testing a path the DOM never takes.
     */
    const pointer = new PointerControl();
    const presses: (PointerTarget | undefined)[] = [];
    let steers = 0;
    pointer.onPress = (target) => presses.push(target);
    pointer.onSteerStart = () => (steers += 1);
    pointer.resolve = () => ({ tx: 3, ty: 4, simX: 100, simY: 130, seen: true });
    pointer.attach(fakeElement());

    dispatchDown(pointer, { button: 0, shiftKey: true });
    assert.equal(presses.length, 0, 'a shifted press fired onPress, so main.ts would send a moveTo');
    assert.equal(pointer.pointerDown, false, 'a shifted press was taken as a hold');
    // …and held, well past the threshold, with the frame loop running. The listener stamps the press
    // with `performance.now()`, so the frame clock has to be that clock and not a bare millisecond
    // count — a `tick` from the wrong epoch would "pass" this by never crossing the threshold at all.
    pointer.tick(performance.now() + HOLD_THRESHOLD_MS * 10, 0, 0);
    assert.equal(steers, 0, 'a shifted drag started a steer');
    assert.deepEqual(pointer.intent(), { x: 0, y: 0 });

    // The other half, and it is the half a careless guard breaks: an unshifted press is untouched.
    dispatchDown(pointer, { button: 0, shiftKey: false });
    assert.equal(presses.length, 1, 'a plain press stopped reaching click-to-move');
    assert.equal(pointer.pointerDown, true);
    pointer.tick(performance.now() + HOLD_THRESHOLD_MS + 1, 0, 0);
    assert.equal(steers, 1, 'a plain hold stopped becoming a steer');
  });

  it('reads Shift once, at the press — releasing it mid-drag keeps orbiting', () => {
    // `CLAUDE.md` gotcha 5b's own prescription: the modifier state at the moment of the press is what
    // the player meant. A hand that relaxes three-quarters of the way round a turn meant to finish
    // the turn, and — the half that would be a real bug — the drag must not fall through to
    // click-to-move partway, which would send a `moveTo` into the middle of a camera gesture.
    const { orbit, poses } = orbitHarness();
    orbit.press(1, 400, 300);
    orbit.drag(1, 460, 300);
    assert.equal(poses.length, 1);
    // No modifier is consulted here at all; the gesture is owned until the button comes up.
    orbit.drag(1, 520, 300);
    assert.equal(poses.length, 2);
    assert.ok(poses[1]!.yaw < poses[0]!.yaw, 'the second half of the drag stopped turning the camera');
    assert.equal(orbit.release(1), true, 'the release must report that the camera actually turned');
  });

  it('applies the drag from the live pose, so a run into the pitch stop tracks the hand back out', () => {
    // Accumulating from the press instead would unwind a stored total: push 500 px past the stop and
    // the camera would sit there for 500 px of the way back before moving. The clamp is a wall the
    // hand rests against, not a spring it winds up.
    const { orbit, pose } = orbitHarness({ ...HOME, pitch: CAMERA_PITCH_MAX - 1 });
    orbit.press(1, 0, 0);
    orbit.drag(1, 0, 500);
    assert.equal(pose.current.pitch, CAMERA_PITCH_MAX);
    orbit.drag(1, 0, 480);
    assert.ok(pose.current.pitch < CAMERA_PITCH_MAX, 'the drag wound up instead of resting on the stop');
  });

  it('says nothing for a press that never moved, so a Shift+click does not disarm the mode', () => {
    const { orbit, poses, settled } = orbitHarness();
    orbit.press(1, 100, 100);
    assert.equal(orbit.drag(1, 100, 100), undefined);
    assert.equal(poses.length, 0);
    assert.equal(orbit.release(1), false, 'a click that never turned reported itself as a turn');
    assert.equal(settled.length, 0, 'a click that never turned wrote the remembered pose');
    // A pointer that was never pressed is nobody's business either.
    assert.equal(orbit.drag(7, 500, 500), undefined);
  });

  it('reports the pose once, at the end, rather than on every frame of the drag', () => {
    // `main.ts` remembers on `onSettled` and not on `onPose`, because `rememberPose` is a synchronous
    // `localStorage.setItem` and a drag fires sixty of those a second. A regression here is invisible
    // on a fast machine and is the camera feeling heavy on a slow one.
    const { orbit, poses, settled, pose } = orbitHarness();
    orbit.press(1, 0, 0);
    for (let x = 10; x <= 100; x += 10) orbit.drag(1, x, 0);
    assert.equal(poses.length, 10);
    assert.equal(settled.length, 0, 'the drag wrote storage while it was still moving');
    orbit.release(1);
    assert.equal(settled.length, 1);
    assert.deepEqual(settled[0], pose.current, 'the settled pose is not the one the hand left');
    // Twice is not better than once: a second release of a finished gesture is nothing at all.
    orbit.release(1);
    assert.equal(settled.length, 1);
  });

  it('refuses everything while the caret is in the command line', () => {
    const { orbit, poses } = orbitHarness();
    orbit.typing = true;
    orbit.attach(fakeElement());
    dispatchDown(orbit, { button: 0, shiftKey: true });
    orbit.drag(1, 300, 300);
    assert.equal(poses.length, 0);
    assert.equal(orbit.orbiting, false);
  });
});

describe('follow mode', () => {
  it('starts at rest, which is the whole of why it replaced the exponential', () => {
    // The owner's report — "it almost snaps to the new view" — was a description of exponential
    // decay, whose speed is *maximal* the instant the target jumps. A critically damped spring
    // begins at rest. So the first frame of a 90-degree corner must move only a little, where the
    // old ease threw away 45 degrees in its first half-life.
    const first = followSpring(0, 90, 0, 1 / 60);
    assert.ok(first.yaw > 0 && first.yaw < 3, `${first.yaw}° in the first frame is a lurch`);
    assert.ok(first.velocity > 0, 'and it must be moving by the end of that frame');

    // It accelerates: the second frame covers more ground than the first.
    const second = followSpring(first.yaw, 90, first.velocity, 1 / 60);
    assert.ok(second.yaw - first.yaw > first.yaw, 'the swing should build, not decay from the start');
  });

  it('arrives without overshooting, at any frame rate', () => {
    // Critically damped means exactly this: it gets there and stops, rather than sailing past and
    // coming back. A camera that overshoots a corner reads as a wobble on every turn.
    for (const dt of [1 / 240, 1 / 60, 1 / 30, 1 / 10]) {
      let yaw = 0;
      let velocity = 0;
      let worst = 0;
      for (let i = 0; i < 600; i++) {
        ({ yaw, velocity } = followSpring(yaw, 90, velocity, dt));
        worst = Math.max(worst, yaw);
      }
      assert.ok(worst <= 90 + 1e-6, `overshot to ${worst}° at ${dt}s frames`);
      assert.ok(Math.abs(yaw - 90) < 0.5, `${yaw}° of 90 after ten seconds at ${dt}s frames`);
    }
  });

  it('turns a corner in about the time the constant claims, whatever the frame rate', () => {
    // Frame-rate independence is the property that keeps the camera feeling the same on every
    // machine. The integrator is a rational approximation rather than a closed form, so this is a
    // tolerance rather than an identity — but a 4x change in frame time must not change the feel.
    const after = (dt: number, seconds: number): number => {
      let yaw = 0;
      let velocity = 0;
      for (let i = 0; i < Math.round(seconds / dt); i++) ({ yaw, velocity } = followSpring(yaw, 90, velocity, dt));
      return yaw;
    };
    const fast = after(1 / 240, FOLLOW_SMOOTH_SECONDS);
    const slow = after(1 / 30, FOLLOW_SMOOTH_SECONDS);
    assert.ok(Math.abs(fast - slow) < 2, `${fast}° vs ${slow}° — the frame rate changed the swing`);
    // And it is substantially there by the time the constant names, without being finished early.
    assert.ok(fast > 50 && fast < 85, `${fast}° of 90 after ${FOLLOW_SMOOTH_SECONDS}s`);
  });

  it('takes the short way round, including across the seam', () => {
    // 170 to -170 is a 20° swing through south, not a 340° tour through north. A camera that took the
    // long way would spin the whole world exactly once per turn.
    const step = followSpring(170, -170, 0, 1 / 60);
    assert.ok(step.yaw > 170 || step.yaw <= -170, `${step.yaw} took the long way`);
    // Every answer is a wrapped yaw, or the pose that comes out is not one the rig would accept.
    for (const [from, to] of [
      [179, -179],
      [-179, 179],
      [0, 180],
      [90, -90],
    ] as const) {
      const out = followSpring(from, to, 0, 0.1);
      assert.ok(out.yaw > -180 && out.yaw <= 180, `${out.yaw} is not a wrapped yaw`);
    }
  });

  it('settles rather than creeping forever', () => {
    // Below the floor it snaps, and the snap is what makes "nothing moved" a state the frame can be
    // cheap in — every yaw write refits the shadow box and asks `interior.ts` for a wall set. The
    // spring needs the velocity in the test too: a body still swinging is not settled however close
    // it happens to be this frame.
    const settled = followSpring(90, 90 + FOLLOW_SETTLE_DEGREES / 2, 0, 1 / 60);
    assert.equal(settled.yaw, 90 + FOLLOW_SETTLE_DEGREES / 2);
    assert.equal(settled.velocity, 0);
    assert.equal(followSpring(90, 90, 0, 1 / 60).yaw, 90);
    // A zero-length frame moves nothing, rather than dividing by it.
    assert.equal(followSpring(0, 90, 0, 0).yaw, 0);
  });

  it('snaps on first sight and eases ever after', () => {
    const follow = new FollowCamera(true);
    // Arriving in the world with the camera wherever the last session left it: the first heading is
    // taken whole, or every login is a second of the camera swinging in from an angle nobody chose.
    assert.equal(follow.update(-90, Math.PI / 2, 1 / 60, false), 90);
    // And after that it eases: one frame moves a fraction of the remaining 90°, not all of it.
    // (From 90 to 0 rather than 90 to -90, which is the one genuinely ambiguous pair on a circle —
    // both ways round are 180° and either answer would be correct.)
    const eased = follow.update(90, 0, 1 / 60, false);
    assert.ok(eased !== undefined && eased < 90 && eased > 80, `${eased}`);
    // A new body or a new Place is a first sight again.
    follow.clear();
    assert.equal(follow.update(0, Math.PI, 1 / 60, false), 180);
  });

  it('answers nothing at all when it is disarmed, suspended, or has no heading yet', () => {
    const follow = new FollowCamera(true);
    assert.equal(follow.update(0, undefined, 1 / 60, false), undefined, 'a wire with no yaw is not a target');
    assert.equal(follow.update(0, Math.PI / 2, 1 / 60, true), undefined, 'a live drag outranks the mode');
    follow.enabled = false;
    assert.equal(follow.update(0, Math.PI / 2, 1 / 60, false), undefined);
    // Suspending must not consume the first sight: re-armed, the next heading is still taken whole.
    follow.enabled = true;
    assert.equal(follow.update(0, Math.PI / 2, 1 / 60, false), 90);
  });

  it('is far slower than the body it chases, which is what makes it read as a camera', () => {
    // `anim.TURN_RATE` is 10 rad/s — a body turns 90° in 0.16 s. The camera must take about a second
    // to do the same, or the world snaps round every time the player turns a corner and the mode is
    // unusable. Stated as a ratio so it survives either constant moving.
    const bodySeconds = Math.PI / 2 / 10;
    let yaw = 0;
    let velocity = 0;
    let seconds = 0;
    while (Math.abs(yaw - 90) > 9 && seconds < 10) {
      ({ yaw, velocity } = followSpring(yaw, 90, velocity, 1 / 60));
      seconds += 1 / 60;
    }
    assert.ok(seconds > bodySeconds * 4, `the camera reached 90% in ${seconds.toFixed(2)} s — too fast to read`);
    assert.ok(seconds < 1.5, `the camera took ${seconds.toFixed(2)} s to turn a corner — too slow to follow`);
  });
});

/* -------------------------------------------------------------------------- */
/* Harnesses                                                                   */
/* -------------------------------------------------------------------------- */

function orbitHarness(from: CameraPose = HOME): {
  orbit: OrbitControl;
  poses: CameraPose[];
  settled: CameraPose[];
  pose: { current: CameraPose };
} {
  const orbit = new OrbitControl();
  const pose = { current: from };
  const poses: CameraPose[] = [];
  const settled: CameraPose[] = [];
  orbit.poseOf = () => pose.current;
  orbit.onPose = (next) => {
    pose.current = next;
    poses.push(next);
  };
  orbit.onSettled = (next) => settled.push(next);
  return { orbit, poses, settled, pose };
}

/**
 * The smallest thing `attach` will accept — Node has no DOM, and neither class needs one.
 *
 * The listeners are captured rather than ignored so a test can hand them a plain object and exercise
 * the *listener's* own guards, which is where the shifted-press refusal lives.
 */
function fakeElement(): HTMLElement {
  const listeners = new Map<string, (event: unknown) => void>();
  const element = {
    style: {},
    listeners,
    addEventListener: (type: string, handler: (event: unknown) => void): void => void listeners.set(type, handler),
    removeEventListener: (type: string): void => void listeners.delete(type),
    setPointerCapture: (): void => {},
    releasePointerCapture: (): void => {},
    hasPointerCapture: (): boolean => false,
    clientWidth: 1600,
    clientHeight: 900,
  };
  return element as unknown as HTMLElement;
}

/** A `pointerdown` through the real listener, with only the fields either class reads. */
function dispatchDown(target: { attach(element: HTMLElement): void }, init: { button: number; shiftKey: boolean }): void {
  const element = (target as unknown as { element: { listeners: Map<string, (event: unknown) => void> } }).element;
  element.listeners.get('pointerdown')?.({
    ...init,
    pointerId: 1,
    target: null,
    offsetX: 800,
    offsetY: 450,
    clientX: 800,
    clientY: 450,
    preventDefault: (): void => {},
  });
}

/** `window` exists in Node; `addEventListener` on it does not need to do anything here. */
(globalThis as unknown as { window: unknown }).window ??= {
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
};

/**
 * `input.intoFormControl` is four `instanceof`s against DOM classes, and `instanceof` against an
 * undeclared name is a `ReferenceError` rather than `false`. Node has none of them, so a headless
 * test that drives a real listener has to declare them — stubs, because nothing here is ever an
 * instance of one and the branch under test is the *first* line, which must return `false`.
 */
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= class {};
}
