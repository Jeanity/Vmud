/**
 * The wheel: its normalisation, its two mappings, its gate, and the pose it remembers.
 *
 * Four properties, and each one is a way M6's tuning instrument could fail in a way the owner would
 * report as "the camera is broken" rather than as a bug with a name:
 *
 * 1. **Shift + wheel arrives on `deltaX` in half the browsers.** Chrome and Safari swap a shifted
 *    wheel to horizontal scroll before dispatch; Firefox does not. A handler that reads `deltaY`
 *    alone works on one machine and does nothing on another — and since M8 that is not about the
 *    tilt but about the *zoom*, because Shift is held for the length of an orbit gesture. Both
 *    shapes are driven here.
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

import { ENVELOPE_POSES } from './fixture.ts';
import {
  CAMERA_STORAGE_KEY,
  DEFAULT_POSE,
  DOLLY_RATIO,
  Dolly,
  PITCH_DEGREES_PER_NOTCH,
  POSE_ERA,
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
  CAMERA_PITCH_FLOOR,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  clampDistance,
  clampPitch,
  pitchFloorFor,
} from './rig.ts';

/**
 * Both storages for a headless process. Node has no DOM; the module only needs three methods of
 * each. `local` is the live store since the angle lock; `session` exists for the migration the
 * lock shipped with — a pose remembered in the sessionStorage era must survive the move.
 */
function installStorages(): { local: Map<string, string>; session: Map<string, string> } {
  const local = stubStorage('localStorage');
  const session = stubStorage('sessionStorage');
  return { local, session };
}

function stubStorage(name: 'localStorage' | 'sessionStorage'): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as Record<string, unknown>)[name] = {
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
    // Chrome/Safari on a shifted wheel: `deltaY` is 0 and `deltaX` carries it. Firefox: the other
    // way. Both must zoom, or a notch rolled in the middle of an orbit does nothing on half the
    // owner's machines — which would read as the new camera having broken the wheel.
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
    // Sixty notches crosses the whole range. It was twelve when the ceiling was 48 and twenty-four
    // when it doubled; M9 dropped the floor from 24 m to 3, which is another factor of eight, and
    // `ln 32 / ln 1.06` is 59.5. The RATIO is what a notch *feels* like, so the ratio stays and the
    // journey lengthens — five flicks end to end, and the wheel is still the same wheel.
    const near: CameraPose = { ...home, distance: CAMERA_DISTANCE_MIN, pitch: 64 };
    assert.equal(dollyTo(near, 60).distance, CAMERA_DISTANCE_MAX);
    assert.ok(dollyTo(near, 59).distance < CAMERA_DISTANCE_MAX);
    // **A zoom-out tilts the camera up when it has to** — M9. From eye level at 3 m, the far end's
    // floor is 45°, so the wheel cannot leave the pitch where it found it without pointing the frame
    // at 285 m of ground the streamer never built. A pose already above its new floor is untouched.
    const eyeLevel: CameraPose = { ...home, distance: CAMERA_DISTANCE_MIN, pitch: CAMERA_PITCH_FLOOR };
    assert.equal(dollyTo(eyeLevel, 60).pitch, CAMERA_PITCH_MIN, 'the pitch did not ride the zoom out');
    assert.equal(dollyTo(eyeLevel, -5).pitch, CAMERA_PITCH_FLOOR, 'zooming further in must not tilt');
    assert.equal(dollyTo({ ...home, pitch: CAMERA_PITCH_MAX }, 60).pitch, CAMERA_PITCH_MAX, 'a steep pose moved');
    // M8: the yaw and the mode are carried through untouched. A wheel notch must not straighten the
    // camera and must not disarm a follow.
    const orbited = dollyTo({ ...home, yaw: -137, follow: true }, 1);
    assert.equal(orbited.yaw, -137);
    assert.equal(orbited.follow, true);
  });

  it('tilts by degrees, in the same direction the dolly pulls back', () => {
    // The authored top of the range, explicitly — DEFAULT_POSE moved to the forward-looking floor
    // when the owner locked the angle, so it is no longer a pose a tilt can descend from.
    const authored: CameraPose = { ...home, pitch: CAMERA_PITCH_MAX };
    const out = tiltTo(authored, 1);
    assert.ok(Math.abs(out.pitch - (CAMERA_PITCH_MAX - PITCH_DEGREES_PER_NOTCH)) < 1e-9);
    assert.equal(out.distance, authored.distance, 'the tilt must not touch the distance');
    // Down to the floor **for the distance it is standing at** — M9's envelope, through the wheel.
    // At `home`'s 36 m that floor is 27.56°, so the descent is 25 notches rather than the 13 it was
    // when the floor was a flat 45 everywhere; at 3 m it is 20° and the range is wider still.
    assert.equal(tiltTo(authored, 100).pitch, pitchFloorFor(authored.distance));
    assert.ok(pitchFloorFor(authored.distance) < CAMERA_PITCH_MIN, 'the floor at 36 m is below M6’s');
    const close: CameraPose = { ...authored, distance: CAMERA_DISTANCE_MIN };
    assert.equal(tiltTo(close, 100).pitch, CAMERA_PITCH_FLOOR, 'eye level is not reachable at 3 m');
    assert.equal(tiltTo(authored, -1).pitch, CAMERA_PITCH_MAX);
    // And the new default already sits on the floor the owner chose — which is no longer *the* floor,
    // just the pitch they picked. A tilt can descend from it now.
    assert.equal(home.pitch, CAMERA_PITCH_MIN);
    assert.ok(tiltTo(home, 1).pitch < CAMERA_PITCH_MIN, 'the default pose can no longer be tilted down');
  });

  it('clamps at both ends, and honours a ceiling the ring imposed', () => {
    assert.equal(dollyTo(home, 100).distance, CAMERA_DISTANCE_MAX);
    assert.equal(dollyTo(home, -100).distance, CAMERA_DISTANCE_MIN);
    assert.equal(dollyTo(home, 100, 40).distance, 40, 'an ultrawide canvas lowered the ceiling');
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const at: CameraPose = { ...home, distance, pitch };
      // **Every pose on the envelope is legal**, which is the first thing a curved boundary has to
      // prove about itself: a sample the clamp would move is a sample that tests nothing downstream.
      assert.equal(clampPitch(pitch, distance), pitch, `${distance} m / ${pitch}° is outside its own clamp`);
      assert.equal(clampDistance(distance), distance);
      // And a push further into the stop the pose is *already* against is a fixed point, which is
      // what "clamped" has to mean for a control the owner will hold against it. Which stop that is
      // now depends on the pose rather than on which of two constants it equals: on the floor it is
      // a tilt down, at the ceiling a zoom out. Poses in the middle of the envelope have no stop to
      // be held against and are not asked to be fixed points of anything.
      const onFloor = Math.abs(pitch - pitchFloorFor(distance)) < 1e-9;
      if (onFloor) assert.deepEqual(tiltTo(at, 5), at, `the floor gave way at ${distance} m`);
      if (pitch === CAMERA_PITCH_MAX) assert.deepEqual(tiltTo(at, -5), at, `the ceiling gave way at ${distance} m`);
      if (distance === CAMERA_DISTANCE_MAX) assert.deepEqual(dollyTo(at, 5), at);
      if (distance === CAMERA_DISTANCE_MIN) assert.deepEqual(dollyTo(at, -5), at);
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
    dolly.apply(1);
    dolly.apply(1);
    assert.equal(poses.length, 2);
    assert.ok(poses[1]!.distance > poses[0]!.distance, 'the second notch must build on the first');
  });

  it('says nothing when the pose did not actually move', () => {
    const { dolly, poses } = harness();
    assert.equal(dolly.apply(0), undefined, 'a zero-delta event is not a gesture');
    // Held against the stop: the clamp refuses, and a `setFadeBands` + shadow refit per wheel event
    // for a pose that is not changing is work nobody asked for.
    for (let i = 0; i < 20; i++) dolly.apply(3);
    const settled = poses.length;
    assert.equal(dolly.apply(3), undefined);
    assert.equal(poses.length, settled);
  });

  it('refuses a wheel while the caret is in the command line', () => {
    const { dolly, poses } = harness();
    dolly.typing = true;
    assert.equal(dolly.apply(1), undefined);
    assert.equal(poses.length, 0, 'the gate is checked before the pose is read, not after');
  });

  it('does nothing at all with no rig wired to it', () => {
    const dolly = new Dolly();
    assert.equal(dolly.apply(1), undefined);
  });

  it('zooms whether or not Shift is down, because Shift is now held for an orbit — M8', () => {
    /*
     * The wheel's listener no longer looks at the modifier at all, and this is the test that says so
     * from the outside: the same event with `shiftKey` true and false must produce the same pose.
     * M6 tilted on the shifted one and the angle lock refused it; both would now mean that rolling
     * the wheel in the middle of an orbit did something other than zoom, which is the one thing a
     * wheel must never do.
     */
    const shifted = harness();
    const plain = harness();
    shifted.dolly.apply(wheelNotches({ deltaX: 100, deltaY: 0, deltaMode: 0 }));
    plain.dolly.apply(wheelNotches({ deltaX: 0, deltaY: 100, deltaMode: 0 }));
    assert.deepEqual(shifted.pose.current, plain.pose.current);
    assert.ok(shifted.pose.current.distance > DEFAULT_POSE.distance, 'a shifted wheel did not zoom');
  });
});

describe('the remembered pose', () => {
  it('survives a round trip through storage, rounded to something a human can retype', () => {
    installStorages();
    rememberPose({ distance: 41.234567, pitch: 52.5, yaw: -137.891, follow: true });
    assert.deepEqual(rememberedPose(), { distance: 41.23, pitch: 52.5, yaw: -137.89, follow: true });
  });

  it('forgets the default rather than storing it', () => {
    const { local: store } = installStorages();
    rememberPose({ ...DEFAULT_POSE, distance: 44, pitch: 50 });
    assert.ok(store.has(CAMERA_STORAGE_KEY));
    rememberPose(DEFAULT_POSE);
    // A tab that stored the default and a tab that stored nothing must behave identically, or the day
    // the default moves this browser quietly keeps showing the old frame and the change looks
    // unlanded. All four fields count: an orbited camera at the default distance is still a pose.
    assert.equal(store.has(CAMERA_STORAGE_KEY), false);
    assert.equal(rememberedPose(), undefined);
    rememberPose({ ...DEFAULT_POSE, yaw: 90 });
    assert.ok(store.has(CAMERA_STORAGE_KEY), 'a turned camera at the default distance was forgotten');
    rememberPose({ ...DEFAULT_POSE, follow: !DEFAULT_POSE.follow });
    assert.ok(store.has(CAMERA_STORAGE_KEY), 'the follow mode was forgotten');
  });

  it('clamps and rejects whatever it finds there, because a console can write anything', () => {
    const { local: store } = installStorages();
    // Note the era marker on every value here: without it the `follow` field is deliberately ignored
    // (see the migration test below), and these cases are about the *other* three fields.
    store.set(CAMERA_STORAGE_KEY, `900,89,0,0,${POSE_ERA}`);
    assert.deepEqual(rememberedPose(), {
      distance: CAMERA_DISTANCE_MAX,
      pitch: CAMERA_PITCH_MAX,
      yaw: 0,
      follow: false,
    });
    // M9: the pitch is clamped against the distance **in the same stored value**, so the floor here
    // is 3 m's own 20° and not the far end's 45°. That is what lets a genuinely-chosen eye-level pose
    // survive a reload — the whole point of remembering one.
    store.set(CAMERA_STORAGE_KEY, `1,1,0,0,${POSE_ERA}`);
    assert.deepEqual(rememberedPose(), {
      distance: CAMERA_DISTANCE_MIN,
      pitch: CAMERA_PITCH_FLOOR,
      yaw: 0,
      follow: false,
    });
    store.set(CAMERA_STORAGE_KEY, `3,20,0,1,${POSE_ERA}`);
    assert.deepEqual(rememberedPose(), {
      distance: CAMERA_DISTANCE_MIN,
      pitch: CAMERA_PITCH_FLOOR,
      yaw: 0,
      follow: true,
    });
    // …while the same pitch stored against a far distance is still refused, because there it is.
    store.set(CAMERA_STORAGE_KEY, `96,20,0,1,${POSE_ERA}`);
    assert.equal(rememberedPose()?.pitch, CAMERA_PITCH_MIN);
    // The yaw wraps rather than clamping, and garbage in the third field is north rather than a
    // camera pointing at NaN — which would put the rig somewhere `lookAt` cannot recover from.
    store.set(CAMERA_STORAGE_KEY, `40,50,540,1,${POSE_ERA}`);
    assert.deepEqual(rememberedPose(), { distance: 40, pitch: 50, yaw: 180, follow: true });
    store.set(CAMERA_STORAGE_KEY, `40,50,due-west,1,${POSE_ERA}`);
    assert.deepEqual(rememberedPose(), { distance: 40, pitch: 50, yaw: 0, follow: true });
    store.set(CAMERA_STORAGE_KEY, 'north-by-northwest');
    assert.equal(rememberedPose(), undefined);
    store.set(CAMERA_STORAGE_KEY, '42');
    assert.equal(rememberedPose(), undefined, 'half a pose is not a pose');
  });

  it('does not let a follow saved before the flip outrank the new default', () => {
    // The bug the owner hit, exactly: they had a four-field pose written during the hours when follow
    // shipped *off*, so the flip to on never reached them and they reported the camera-behind feature
    // as missing. A stored `0` from that era is not a decision — the era marker is what tells the two
    // apart, and the tuned distance/pitch/yaw survive either way because those were always chosen.
    const { local: store } = installStorages();
    store.set(CAMERA_STORAGE_KEY, '52,50,90,0');
    const migrated = rememberedPose();
    assert.equal(migrated?.follow, DEFAULT_POSE.follow, 'a pre-era follow must re-read the default');
    assert.equal(migrated?.distance, 52, 'and the frame the owner tuned by hand is untouched');
    assert.equal(migrated?.pitch, 50);
    assert.equal(migrated?.yaw, 90);

    // Once it carries the marker, an explicit off is a real choice and is honoured for ever.
    rememberPose({ distance: 52, pitch: 50, yaw: 90, follow: false });
    assert.ok(store.get(CAMERA_STORAGE_KEY)?.endsWith(`,${POSE_ERA}`), 'a write stamps the era');
    assert.equal(rememberedPose()?.follow, false, 'a deliberate off survives the round trip');
  });

  it('reads the angle lock’s two-field pose as north, with the mode at today’s default', () => {
    // Every machine that has run this client since the angle lock has a `distance,pitch` string in
    // localStorage, and that machine was looking north with no follow mode to speak of. So the
    // shortest possible value is not a corrupt one: it is the owner's own frame, and it must come
    // back to the degree rather than being discarded for want of two fields that did not exist.
    //
    // The *mode* deliberately tracks `FOLLOW_ON_FRESH` rather than the era's absent value, which is
    // why every assertion below reads it symbolically: a string with no fourth field is a machine that
    // has never expressed an opinion, and it gets today's answer. M8b flipping that default from off
    // to on must therefore move these rows without editing them — a literal here would have hidden the
    // change instead of tracking it.
    const { local } = installStorages();
    local.set(CAMERA_STORAGE_KEY, '31.5,52.5');
    assert.deepEqual(rememberedPose(), { distance: 31.5, pitch: 52.5, yaw: 0, follow: DEFAULT_POSE.follow });
    // A three-field value — a yaw remembered before the mode was persisted — takes the mode's default.
    local.set(CAMERA_STORAGE_KEY, '31.5,52.5,90');
    assert.deepEqual(rememberedPose(), { distance: 31.5, pitch: 52.5, yaw: 90, follow: DEFAULT_POSE.follow });
  });

  it('migrates a sessionStorage-era pose into localStorage on first read', () => {
    // The angle lock's whole promise: the pose the owner was looking at when they said "lock that
    // angle in" was in sessionStorage; the first read after the switch must carry it over exactly,
    // so their chosen frame becomes permanent without a console ever being opened.
    const { local, session } = installStorages();
    session.set(CAMERA_STORAGE_KEY, '31.5,52.5');
    assert.deepEqual(rememberedPose(), { distance: 31.5, pitch: 52.5, yaw: 0, follow: DEFAULT_POSE.follow });
    assert.equal(local.get(CAMERA_STORAGE_KEY), '31.5,52.5', 'migrated, not merely read');
    assert.equal(session.has(CAMERA_STORAGE_KEY), false, 'and the old home is emptied');
    // A localStorage value outranks any sessionStorage leftover.
    session.set(CAMERA_STORAGE_KEY, '96,64');
    assert.deepEqual(rememberedPose(), { distance: 31.5, pitch: 52.5, yaw: 0, follow: DEFAULT_POSE.follow });
  });

  it('shrugs when storage throws, which is a partitioned context and not a bug', () => {
    const blocked = {
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
    (globalThis as unknown as Record<string, unknown>)['localStorage'] = blocked;
    (globalThis as unknown as Record<string, unknown>)['sessionStorage'] = blocked;
    assert.equal(rememberedPose(), undefined);
    rememberPose({ distance: 40, pitch: 50, yaw: 12, follow: true });
    rememberPose(DEFAULT_POSE);
  });
});
