/**
 * The wheel: its normalisation, its two mappings, its gate, and the pose it remembers.
 *
 * Four properties, and each one is a way M6's tuning instrument could fail in a way the owner would
 * report as "the camera is broken" rather than as a bug with a name:
 *
 * 1. **Shift + wheel arrives on `deltaX` in half the browsers.** Chrome and Safari swap a shifted
 *    wheel to horizontal scroll before dispatch; Firefox does not. A handler that reads `deltaY`
 *    alone tilts on one machine and does nothing on another. Both shapes are driven here.
 * 2. **`deltaMode` is not a unit.** The same notch is 100 in pixel mode and 3 in line mode, so a
 *    step scaled off the raw number is thirty times bigger on some mice.
 * 3. **The gate.** `CLAUDE.md` gotcha 5a's discipline: a wheel while the caret is in the command
 *    line, or aimed at a form control, must not reach the camera — and must not be `preventDefault`ed
 *    either, or the log stops scrolling.
 * 4. **The remembered pose is user-editable by definition** — it is one `setItem` away in the same
 *    console the owner reads `__debug3d` in — so it is clamped on the way out, not on the way in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLAMP_CORNERS } from './fixture.ts';
import {
  CAMERA_STORAGE_KEY,
  DEFAULT_POSE,
  DOLLY_RATIO,
  Dolly,
  PITCH_DEGREES_PER_NOTCH,
  dollyTo,
  rememberPose,
  rememberedPose,
  tiltTo,
  wheelNotches,
  type CameraPose,
} from './dolly.ts';
import {
  CAMERA_DISTANCE,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
} from './rig.ts';

/** A `sessionStorage` for a headless process. Node has no DOM; the module only needs these three. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value),
    removeItem: (key: string): void => void store.delete(key),
  };
  return store;
}

describe('the wheel, normalised', () => {
  it('reads a notch the same however the browser measures it', () => {
    assert.equal(wheelNotches({ deltaX: 0, deltaY: 100, deltaMode: 0 }), 1);
    assert.equal(wheelNotches({ deltaX: 0, deltaY: 3, deltaMode: 1 }), 1);
    assert.equal(wheelNotches({ deltaX: 0, deltaY: 1, deltaMode: 2 }), 1);
    assert.equal(wheelNotches({ deltaX: 0, deltaY: -100, deltaMode: 0 }), -1);
    // A trackpad's fine-grained scroll is a fraction of a notch, and must stay one.
    assert.ok(Math.abs(wheelNotches({ deltaX: 0, deltaY: 12, deltaMode: 0 }) - 0.12) < 1e-12);
    assert.equal(wheelNotches({ deltaX: 0, deltaY: 0, deltaMode: 0 }), 0, 'a momentum tail is not a notch');
  });

  it('finds the notches of a shift-swapped wheel, which arrive horizontally', () => {
    // Chrome/Safari on a shifted wheel: `deltaY` is 0 and `deltaX` carries it. Firefox: the other way.
    // Both must tilt, or the pitch control works on some of the owner's machines and not others.
    assert.equal(wheelNotches({ deltaX: 100, deltaY: 0, deltaMode: 0 }), 1);
    assert.equal(wheelNotches({ deltaX: -300, deltaY: 0, deltaMode: 1 }), -100);
    // When both are present, vertical wins — that is the axis the gesture is actually on.
    assert.equal(wheelNotches({ deltaX: 500, deltaY: 100, deltaMode: 0 }), 1);
  });
});

describe('the two mappings', () => {
  const home: CameraPose = DEFAULT_POSE;

  it('dollies by a ratio, so a notch is the same proportion at both ends', () => {
    const out = dollyTo(home, 1);
    assert.ok(Math.abs(out.distance - CAMERA_DISTANCE * DOLLY_RATIO) < 1e-9);
    assert.equal(out.pitch, home.pitch, 'the plain wheel must not touch the tilt');
    // Scrolling *away* from the viewer pulls the camera back — "show me more".
    assert.ok(dollyTo(home, 1).distance > home.distance);
    assert.ok(dollyTo(home, -1).distance < home.distance);
    // Twenty-four notches crosses the whole range — two comfortable flicks. It was one flick of
    // twelve when the ceiling was 48; the range doubled on the owner's ask and the RATIO is what a
    // notch feels like, so the ratio stayed and the journey lengthened.
    assert.equal(dollyTo({ distance: CAMERA_DISTANCE_MIN, pitch: 64 }, 24).distance, CAMERA_DISTANCE_MAX);
    assert.ok(dollyTo({ distance: CAMERA_DISTANCE_MIN, pitch: 64 }, 23).distance < CAMERA_DISTANCE_MAX);
  });

  it('tilts by degrees, in the same direction the dolly pulls back', () => {
    const out = tiltTo(home, 1);
    assert.ok(Math.abs(out.pitch - (CAMERA_PITCH_MAX - PITCH_DEGREES_PER_NOTCH)) < 1e-9);
    assert.equal(out.distance, home.distance, 'the shifted wheel must not touch the distance');
    // Down the range in thirteen notches, and it cannot climb past the authored pose.
    assert.equal(tiltTo(home, 20).pitch, CAMERA_PITCH_MIN);
    assert.equal(tiltTo(home, -1).pitch, CAMERA_PITCH_MAX);
  });

  it('clamps at both ends, and honours a ceiling the ring imposed', () => {
    assert.equal(dollyTo(home, 100).distance, CAMERA_DISTANCE_MAX);
    assert.equal(dollyTo(home, -100).distance, CAMERA_DISTANCE_MIN);
    assert.equal(dollyTo(home, 100, 40).distance, 40, 'an ultrawide canvas lowered the ceiling');
    for (const [distance, pitch] of CLAMP_CORNERS) {
      const at: CameraPose = { distance, pitch };
      // Every corner is a fixed point of a push further into its own corner, which is what "clamped"
      // has to mean for a control the owner will hold against the stop.
      assert.deepEqual(dollyTo(at, distance === CAMERA_DISTANCE_MAX ? 5 : -5), at);
      assert.deepEqual(tiltTo(at, pitch === CAMERA_PITCH_MIN ? 5 : -5), at);
    }
  });
});

describe('the Dolly listener', () => {
  function harness(): { dolly: Dolly; poses: CameraPose[]; pose: { current: CameraPose } } {
    const dolly = new Dolly();
    const pose = { current: { ...DEFAULT_POSE } };
    const poses: CameraPose[] = [];
    dolly.poseOf = () => pose.current;
    dolly.onPose = (next) => {
      pose.current = next;
      poses.push(next);
    };
    return { dolly, poses, pose };
  }

  it('moves the pose it is given, and reports every move', () => {
    const { dolly, poses } = harness();
    dolly.apply(1, false);
    dolly.apply(1, false);
    assert.equal(poses.length, 2);
    assert.ok(poses[1]!.distance > poses[0]!.distance, 'the second notch must build on the first');
    dolly.apply(2, true);
    assert.equal(poses.length, 3);
    assert.ok(poses[2]!.pitch < poses[1]!.pitch);
  });

  it('says nothing when the pose did not actually move', () => {
    const { dolly, poses } = harness();
    assert.equal(dolly.apply(0, false), undefined, 'a zero-delta event is not a gesture');
    // Held against the stop: the clamp refuses, and a `setFadeBands` + shadow refit per wheel event
    // for a pose that is not changing is work nobody asked for.
    for (let i = 0; i < 20; i++) dolly.apply(3, false);
    const settled = poses.length;
    assert.equal(dolly.apply(3, false), undefined);
    assert.equal(poses.length, settled);
  });

  it('refuses a wheel while the caret is in the command line', () => {
    const { dolly, poses } = harness();
    dolly.typing = true;
    assert.equal(dolly.apply(1, false), undefined);
    assert.equal(poses.length, 0, 'the gate is checked before the pose is read, not after');
  });

  it('does nothing at all with no rig wired to it', () => {
    const dolly = new Dolly();
    assert.equal(dolly.apply(1, false), undefined);
  });
});

describe('the remembered pose', () => {
  it('survives a round trip through storage, rounded to something a human can retype', () => {
    installStorage();
    rememberPose({ distance: 41.234567, pitch: 52.5 });
    const back = rememberedPose();
    assert.deepEqual(back, { distance: 41.23, pitch: 52.5 });
  });

  it('forgets the default rather than storing it', () => {
    const store = installStorage();
    rememberPose({ distance: 44, pitch: 50 });
    assert.ok(store.has(CAMERA_STORAGE_KEY));
    rememberPose(DEFAULT_POSE);
    // A tab that stored `36,64` and a tab that stored nothing must behave identically, or the day the
    // default moves this browser quietly keeps showing the old frame and the change looks unlanded.
    assert.equal(store.has(CAMERA_STORAGE_KEY), false);
    assert.equal(rememberedPose(), undefined);
  });

  it('clamps and rejects whatever it finds there, because a console can write anything', () => {
    const store = installStorage();
    store.set(CAMERA_STORAGE_KEY, '900,89');
    assert.deepEqual(rememberedPose(), { distance: CAMERA_DISTANCE_MAX, pitch: CAMERA_PITCH_MAX });
    store.set(CAMERA_STORAGE_KEY, '1,1');
    assert.deepEqual(rememberedPose(), { distance: CAMERA_DISTANCE_MIN, pitch: CAMERA_PITCH_MIN });
    store.set(CAMERA_STORAGE_KEY, 'north-by-northwest');
    assert.equal(rememberedPose(), undefined);
    store.set(CAMERA_STORAGE_KEY, '42');
    assert.equal(rememberedPose(), undefined, 'half a pose is not a pose');
  });

  it('shrugs when storage throws, which is a partitioned context and not a bug', () => {
    (globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
      getItem: (): string => {
        throw new Error('blocked');
      },
      setItem: (): void => {
        throw new Error('blocked');
      },
      removeItem: (): void => {
        throw new Error('blocked');
      },
    };
    assert.equal(rememberedPose(), undefined);
    rememberPose({ distance: 40, pitch: 50 });
    rememberPose(DEFAULT_POSE);
  });
});
