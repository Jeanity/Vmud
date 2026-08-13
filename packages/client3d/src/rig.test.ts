/**
 * The camera rig against §3's spec, the axis map against the trap it was written for, and — M6, then
 * M9 — the **whole reachable pose envelope** against everything that is derived from the frame.
 *
 * `space.test.ts` in `shared` already states the headline case — **walking north must move -Z** —
 * for the *conversion*. This asserts the consequence for the *camera*: pulled back along +Z at 64°,
 * looking north, with the world's north at the top of the frame. A rig that mirrored that would
 * render a perfectly plausible world in which every inn is on the wrong side of the road, and
 * neither the conversion test nor a screenshot would catch it.
 *
 * ## Why a sweep, and why it used to be four corners
 *
 * Until M6 the rig had one pose and one test case was the whole domain. M6 gave it a rectangle —
 * 24..96 m by 45..64° — and every consequence of the frame was monotone in *both* axes, so the four
 * corners were the whole domain too: no interior point could beat all four.
 *
 * **M9 curved the boundary.** The pitch floor is a function of the distance now
 * (`rig.pitchFloorFor`), a curve has no corners, and the quantity the ring is sized against is not
 * monotone along it — the frame's circumradius runs 21.9 m at 3 m, rises to 46.4 at the knee, *dips*
 * to 46.0 at 16 m, then climbs to 81.6 at full pull-back. So the sample set is `fixture.ENVELOPE_POSES`:
 * a geometric ladder of distances, both edges of the envelope at each rung, and the pre-M9 rectangle
 * appended so the range the owner actually plays in stays a literal subset.
 *
 * The property under test is the one M3 wrote as *"the frame either shows unbuilt void at its edges
 * or the streamer builds two rings nobody sees"*, generalised: **at every reachable pose, the ground
 * the frame contains must be inside the ground the ring guarantees**, and the shadow volume must
 * contain the frame while itself staying inside the ring. `foliage.test.ts` does the same walk for
 * the fade bands, `unproject.test.ts` for the pointer, and `interior.test.ts` for the near-wall fade.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES, toRenderPoint } from '@mygame/shared';

import { ENVELOPE_POSES, LEGACY_CLAMP_CORNERS, SWEEP_YAWS } from './fixture.ts';
import { SHADOW_PAD, shadowExtentsFor } from './night.ts';
import { DIMENSIONS } from './prototypes.ts';
import {
  CAMERA_DISTANCE,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CAMERA_PITCH_FLOOR,
  CameraRig,
  FOCUS_LIFT,
  FOCUS_LIFT_FADE,
  PITCH_FLOOR_KNEE,
  clampDistance,
  clampPitch,
  focusLiftFor,
  frameAt,
  groundFrame,
  groundRadius,
  pitchFloorFor,
  wrapYaw,
} from './rig.ts';
import { RING_ASPECT, RING_COVER, cellReach, chunkKey, windowAddresses } from './streamer.ts';

describe('the camera rig', () => {
  it('is §3 to the letter', () => {
    const rig = new CameraRig(16 / 9);
    assert.equal(rig.camera.fov, CAMERA_FOV_DEGREES);
    assert.equal(CAMERA_FOV_DEGREES, 30);
    assert.equal(CAMERA_PITCH_DEGREES, 64);
    assert.ok(CAMERA_PITCH_DEGREES < 90, 'at 90 the up vector degenerates and the frame flips');
    assert.deepEqual(rig.camera.up.toArray(), [0, 1, 0]);
    // M6: the authored pose is where a fresh rig stands, and it is the top of the tilt range.
    assert.equal(rig.distance, CAMERA_DISTANCE);
    assert.equal(rig.pitch, CAMERA_PITCH_DEGREES);
    assert.equal(CAMERA_PITCH_MAX, CAMERA_PITCH_DEGREES, 'the range opens downward only');
    assert.equal(rig.moved, false);
  });

  it('sits behind and above its target, on +Z, at the stated pitch', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(12, 3, -7);
    const { x, y, z } = rig.camera.position;
    assert.ok(Math.abs(x - 12) < 1e-9, 'yaw is fixed: the camera never moves off its target in X');
    assert.ok(z > -7, 'pulled back along +Z');
    assert.ok(y > 3, 'and above');
    const dy = y - 3;
    const dz = z - -7;
    assert.ok(Math.abs(Math.hypot(dy, dz) - CAMERA_DISTANCE) < 1e-9);
    const pitch = (Math.atan2(dy, dz) * 180) / Math.PI;
    assert.ok(Math.abs(pitch - CAMERA_PITCH_DEGREES) < 1e-9, `pitch is ${pitch}`);
  });

  it('looks north, so walking north moves the character up the frame', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(0, 0, 0);
    // One step north in simulation space, which `space.ts` maps to -Z.
    const north = toRenderPoint(0, -32, 0);
    assert.equal(north.z, -1, 'the axis map itself: south is +Z, so north is -Z');
    const before = { x: 0, y: 0, z: 0 };
    const beforeScreen = project(rig, before);
    const afterScreen = project(rig, north);
    assert.ok(afterScreen.y > beforeScreen.y, 'north must be up the frame, as it is on the 2D map');
    assert.ok(Math.abs(afterScreen.x - beforeScreen.x) < 1e-6, 'and dead ahead, not off to one side');
  });

  it('still looks north, and still sits at the distance asked for, everywhere on the envelope', () => {
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const rig = new CameraRig(16 / 9);
      rig.distance = distance;
      rig.pitch = pitch;
      rig.follow(0, 0, 0);
      const { x, y, z } = rig.camera.position;
      // **Measured from the aim point, not from the origin** — M9 raises the orbit centre by
      // `focusLift` at close range, so the camera stands `lift` higher than the focus it was handed.
      // Subtracting it is the assertion that the lift moved the *centre* and not the radius: a rig
      // that added the lift to the eye alone would still pass every screen-space test in this file
      // while quietly holding a pitch four degrees off the one it reports.
      const lift = rig.focusLift;
      const dy = y - lift;
      assert.ok(Math.abs(x) < 1e-9, `yaw drifted at ${distance} m / ${pitch}°`);
      assert.ok(Math.abs(Math.hypot(dy, z) - distance) < 1e-9, `distance is ${Math.hypot(dy, z)}`);
      const measured = (Math.atan2(dy, z) * 180) / Math.PI;
      assert.ok(Math.abs(measured - pitch) < 1e-9, `pitch is ${measured}, wanted ${pitch}`);
      assert.ok(Math.abs(lift - focusLiftFor(distance)) < 1e-12, 'the rig disagrees with its own lift');
      // The aim, too: `lookAt` must have been given the raised point, or the character sits low in
      // the frame at exactly the distance the raise exists for.
      const aimed = project(rig, { x: 0, y: lift, z: 0 });
      assert.ok(Math.abs(aimed.x) < 1e-6 && Math.abs(aimed.y) < 1e-6, `the aim point is off centre at ${distance} m`);
      const north = project(rig, { x: 0, y: lift, z: -8 });
      const here = project(rig, { x: 0, y: lift, z: 0 });
      assert.ok(north.y > here.y, `north stopped being up the frame at ${distance} m / ${pitch}°`);
    }
  });
});

describe('the yaw — M8', () => {
  it('is the protocol’s own angle, so a body’s heading and the camera’s are one number', () => {
    /*
     * **The headline case, and the sibling of "walking north must move -Z".** `shared/space.yawOf`
     * fixes the wire's convention — 0 north, +π/2 west, ±π south, -π/2 east, anticlockwise seen from
     * above, because it is `rotation.y` for a mesh whose rest forward is `-Z`. The camera *is* such a
     * thing. If the rig had picked its own convention, follow mode would be a conversion with a sign
     * in it, and a sign in a conversion is how a camera ends up looking at the back of a character's
     * head from the front.
     *
     * Asserted against where the camera actually *stands*, not against a constant: at yaw 0 it is due
     * south of its target (M3's pose, unmoved), and a quarter turn to +90 must put it due **east**,
     * because looking west means standing east.
     */
    const rig = new CameraRig(16 / 9);
    rig.pitch = 60;
    rig.follow(0, 0, 0);
    assert.ok(Math.abs(rig.camera.position.x) < 1e-9, 'yaw 0 must leave the camera exactly where M3 put it');
    assert.ok(rig.camera.position.z > 0, 'yaw 0 stands due south, looking north');

    const behind = Math.hypot(rig.camera.position.x, rig.camera.position.z);
    for (const [yaw, wx, wz] of [
      [0, 0, 1],
      [90, 1, 0],
      [180, 0, -1],
      [-90, -1, 0],
    ] as const) {
      rig.yaw = yaw;
      rig.follow(0, 0, 0);
      const { x, y, z } = rig.camera.position;
      assert.ok(Math.abs(x - wx * behind) < 1e-9, `yaw ${yaw}: x ${x}, wanted ${wx * behind}`);
      assert.ok(Math.abs(z - wz * behind) < 1e-9, `yaw ${yaw}: z ${z}, wanted ${wz * behind}`);
      // The pitch and the distance are the yaw's business only in that it must not touch them.
      assert.ok(Math.abs(Math.hypot(x, y, z) - rig.distance) < 1e-9, `yaw ${yaw} changed the distance`);
    }
  });

  it('puts whatever it is pointing at up the frame, all the way round', () => {
    const rig = new CameraRig(16 / 9);
    for (const yaw of SWEEP_YAWS) {
      rig.yaw = yaw;
      rig.follow(0, 0, 0);
      // Eight metres along the camera's own forward, which at yaw ψ is `(-sin ψ, 0, -cos ψ)`.
      const radians = (yaw * Math.PI) / 180;
      const ahead = project(rig, { x: -8 * Math.sin(radians), y: 0, z: -8 * Math.cos(radians) });
      const here = project(rig, { x: 0, y: 0, z: 0 });
      assert.ok(ahead.y > here.y, `forward stopped being up the frame at yaw ${yaw}`);
      assert.ok(Math.abs(ahead.x - here.x) < 1e-6, `forward drifted off centre at yaw ${yaw}`);
    }
  });

  it('wraps rather than clamps, with one representative per heading', () => {
    assert.equal(wrapYaw(0), 0);
    assert.equal(wrapYaw(90), 90);
    assert.equal(wrapYaw(181), -179);
    assert.equal(wrapYaw(-181), 179);
    assert.equal(wrapYaw(360), 0);
    assert.equal(wrapYaw(-360), 0);
    assert.equal(wrapYaw(720 + 45), 45);
    assert.equal(wrapYaw(-720 - 45), -45);
    // Both ways to say south collapse onto one, or a shortest-arc ease has two targets to choose
    // between and picks a different one on either side of the boundary.
    assert.equal(wrapYaw(180), 180);
    assert.equal(wrapYaw(-180), 180);
    assert.equal(wrapYaw(Number.NaN), 0);
    // Through the rig, which is where it matters.
    const rig = new CameraRig(16 / 9);
    rig.yaw = 540;
    assert.equal(rig.yaw, 180);
    rig.yaw = -0.5;
    assert.equal(rig.yaw, -0.5, 'a fraction of a degree is a real yaw, not a rounding target');
  });

  it('goes home with the rest of the pose, and counts as having moved', () => {
    const rig = new CameraRig(16 / 9);
    assert.equal(rig.moved, false);
    rig.yaw = 30;
    assert.equal(rig.moved, true, 'an orbited camera is a camera worth remembering');
    rig.reset();
    assert.equal(rig.yaw, 0, 'C must bring north back to the top of the frame');
    assert.equal(rig.moved, false);
  });
});

describe('the dolly clamp', () => {
  it('refuses anything outside the range, in both directions and from garbage', () => {
    assert.equal(clampDistance(1), CAMERA_DISTANCE_MIN);
    assert.equal(clampDistance(1000), CAMERA_DISTANCE_MAX);
    assert.equal(clampDistance(37.5), 37.5);
    assert.equal(clampDistance(Number.NaN), CAMERA_DISTANCE);
    // `clampPitch`'s distance defaults to the *far* end, which is the strictest floor the envelope
    // has — a caller who does not say where the camera is gets the answer that is legal everywhere.
    assert.equal(clampPitch(0), CAMERA_PITCH_MIN);
    assert.equal(clampPitch(89), CAMERA_PITCH_MAX);
    assert.equal(clampPitch(52), 52);
    assert.equal(clampPitch(Number.NaN), CAMERA_PITCH_DEGREES);
    // The range is the one the brief asked for, stated rather than inferred from the arithmetic.
    assert.equal(CAMERA_DISTANCE_MIN, 3);
    assert.equal(CAMERA_DISTANCE_MAX, 96);
    assert.equal(CAMERA_PITCH_MIN, 45);
    assert.equal(CAMERA_PITCH_FLOOR, 20);
    // And the far edge of the frame stays clear of the horizon at the shallowest tilt **the envelope
    // can actually reach**, which since M9 is the floor rather than `CAMERA_PITCH_MIN`: the ray that
    // draws that edge leaves at `pitch - fov/2`, and at zero it never meets the ground at all. Five
    // degrees is the whole margin, and `groundFrame` throws the moment it is spent — so this is the
    // assertion standing between the owner's eye-level camera and an `ahead` of infinity.
    assert.ok(CAMERA_PITCH_FLOOR - CAMERA_FOV_DEGREES / 2 >= 5, 'the eye-level floor is on the horizon');
    assert.throws(() => groundFrame(3, CAMERA_FOV_DEGREES / 2, RING_ASPECT), 'the guard below the floor is gone');
  });

  it('is an envelope, not a rectangle: the pitch floor falls as the camera comes in — M9', () => {
    /*
     * **The shape of the owner's ask, as five numbers.** *"Move the camera angle right down to eye
     * level and… zoom in so I can see my character better"* is unaffordable read as two independent
     * ranges (eye level at 96 m reaches 285 m of ground against 81.6 m of built ring) and nearly free
     * read as one pose. `pitchFloorFor` is that reading.
     */
    assert.equal(pitchFloorFor(CAMERA_DISTANCE_MIN), CAMERA_PITCH_FLOOR);
    assert.equal(pitchFloorFor(PITCH_FLOOR_KNEE), CAMERA_PITCH_FLOOR, 'the portrait band is flat');
    assert.equal(pitchFloorFor(CAMERA_DISTANCE_MAX), CAMERA_PITCH_MIN, 'the far end is exactly M6’s');
    // Monotone, so pulling back can only ever raise the floor — the property `dollyTo` relies on when
    // it re-clamps the pitch, and the reason a zoom-out tilts up rather than jittering.
    let previous = 0;
    for (let metres = CAMERA_DISTANCE_MIN; metres <= CAMERA_DISTANCE_MAX; metres += 0.25) {
      const floor = pitchFloorFor(metres);
      assert.ok(floor >= previous - 1e-12, `the floor fell from ${previous} to ${floor} at ${metres} m`);
      assert.ok(floor >= CAMERA_PITCH_FLOOR && floor <= CAMERA_PITCH_MIN, `${floor}° is outside the envelope`);
      previous = floor;
    }
    // The pre-M9 rectangle is a subset: every pose the owner has been using is still reachable.
    for (const [distance, pitch] of LEGACY_CLAMP_CORNERS) {
      assert.equal(clampPitch(pitch, distance), pitch, `${distance} m / ${pitch}° stopped being legal`);
      assert.equal(clampDistance(distance), distance);
    }
    // The ramp ends at the *live* ceiling, not at `CAMERA_DISTANCE_MAX` — which is what keeps the
    // envelope inside the ring on a canvas too wide for it without costing a metre of zoom. See
    // `pitchFloorFor`'s docblock for the measured alternative.
    assert.equal(pitchFloorFor(48, 48), CAMERA_PITCH_MIN, 'a lowered ceiling must be a full floor');
    assert.ok(pitchFloorFor(36, 48) > pitchFloorFor(36), 'a narrower ceiling must steepen the floor');
    assert.equal(pitchFloorFor(CAMERA_DISTANCE_MIN, 48), CAMERA_PITCH_FLOOR, 'the portrait band is not for sale');
    // A ceiling inside the portrait band leaves no ramp to draw; answer the strict end, not a NaN.
    assert.equal(pitchFloorFor(5, 4), CAMERA_PITCH_MIN);
    assert.equal(pitchFloorFor(Number.NaN), CAMERA_PITCH_MIN);
  });

  it('keeps the character and the ground outside the near plane, everywhere on the envelope — M9', () => {
    /*
     * **The first thing that breaks at 3 m and does not at 24.** The near plane is 0.5 m and the far
     * 240, both set once in the constructor and never touched since M3, when the closest the camera
     * could come was 24 m and the question could not arise. Three ways it could arise now:
     *
     * - the character's own surface crossing the near plane, which slices them open on screen;
     * - the *ground* crossing it, because at 20° the camera is under two metres up and the near
     *   plane's bottom edge hangs `n · (sin θ + tan(fov/2) · cos θ)` below the eye;
     * - the far plane cutting the frame, which is the same question the ring answers and is checked
     *   here against the projection rather than against the streamer.
     */
    const half = Math.tan((CAMERA_FOV_DEGREES / 2) * (Math.PI / 180));
    let worstBody = Infinity;
    let worstGround = Infinity;
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const rig = new CameraRig(RING_ASPECT);
      rig.distance = distance;
      rig.pitch = pitch;
      const near = rig.camera.near;
      const radians = (pitch * Math.PI) / 180;
      const lift = rig.focusLift;
      const eye = distance * Math.sin(radians) + lift;
      const behind = distance * Math.cos(radians);
      // The closest point of the body's capsule: the nearest point of its axis, less its radius. The
      // axis runs from the feet to `bodyHeight`, so the nearest point is the head once the eye is
      // above it — which is exactly the case at the closest pose.
      const axisY = Math.min(DIMENSIONS.bodyHeight, Math.max(0, eye));
      const toBody = Math.hypot(behind, eye - axisY) - DIMENSIONS.bodyRadius;
      assert.ok(toBody > near, `the body is ${toBody} m away against a ${near} m near plane at ${distance} m`);
      worstBody = Math.min(worstBody, toBody);
      // The lowest point of the near plane, in metres above the ground the character stands on.
      const lowest = eye - near * Math.sin(radians) - near * half * Math.cos(radians);
      assert.ok(lowest > 0, `the near plane is ${lowest} m below the ground at ${distance} m / ${pitch}°`);
      worstGround = Math.min(worstGround, lowest);
      // And the far plane still contains the whole frame, with the fog's own reach inside it.
      assert.ok(frameAt(distance, pitch, RING_ASPECT).farDepth < rig.camera.far, `the far plane cuts ${distance} m`);
    }
    const near = new CameraRig(RING_ASPECT).camera.near;
    console.log(
      `[M9 near plane] closest body surface ${worstBody.toFixed(2)} m and lowest near-plane corner ` +
        `${worstGround.toFixed(2)} m above ground, against a ${near} m near plane`,
    );
    /*
     * Stated as a **margin** rather than a bare pass, because the interesting fact is how much room
     * is left. The tightest pose is not the shallow one it looks like it should be: it is 3 m at
     * **64°**, straight down at your own head, where the eye is 3.60 m up and 1.32 m back and the top
     * of the skull is the nearest thing to it — 1.91 m, or nearly four near planes. Under a 3x margin
     * this needs revisiting, and the way it would get there is `CAMERA_DISTANCE_MIN` going below
     * about 1.5 m rather than anything about the pitch.
     */
    assert.ok(worstBody > 3 * near, `only ${worstBody} m of clearance — the near plane needs revisiting`);
    assert.ok(worstGround > 3 * near, `the near plane comes within ${worstGround} m of the ground`);
  });

  it('aims at the character’s middle up close and at their feet from 20 m out — M9', () => {
    /*
     * A rig that aims at the feet is invisible at 36 m and useless at 3 m — the head lands 35° off a
     * 15° half-frame, so the close-up the owner asked for is a close-up of two boots. What matters
     * here is the pair of ends: full lift where the body owns the frame, and **exactly zero** across
     * the whole of the pre-M9 clamp, which is what makes every pose the owner has ever looked at
     * bit-identical arithmetic.
     */
    assert.equal(focusLiftFor(CAMERA_DISTANCE_MIN), FOCUS_LIFT);
    assert.equal(focusLiftFor(PITCH_FLOOR_KNEE), FOCUS_LIFT, 'the portrait band gets the whole lift');
    assert.equal(focusLiftFor(FOCUS_LIFT_FADE), 0);
    assert.equal(focusLiftFor(24), 0, 'the pre-M9 clamp must be untouched');
    assert.equal(focusLiftFor(CAMERA_DISTANCE), 0);
    assert.equal(focusLiftFor(CAMERA_DISTANCE_MAX), 0);
    assert.equal(focusLiftFor(Number.NaN), 0);
    // Half a 1.8 m body, so the aim point is its middle rather than a number that felt right.
    assert.ok(Math.abs(FOCUS_LIFT - 0.9) < 1e-9);
    // Continuous, and monotone down — a step here is the character jumping up the screen on one
    // notch of the wheel, which is the whole reason it fades rather than switching off.
    let previous = FOCUS_LIFT;
    for (let metres = CAMERA_DISTANCE_MIN; metres <= FOCUS_LIFT_FADE + 4; metres += 0.1) {
      const lift = focusLiftFor(metres);
      assert.ok(lift <= previous + 1e-12, `the lift rose from ${previous} to ${lift} at ${metres} m`);
      assert.ok(Math.abs(lift - previous) < 0.05, `the lift stepped by ${Math.abs(lift - previous)} at ${metres} m`);
      previous = lift;
    }
    // And it is real height, so the frame knows about it: at the closest pose the lift is worth more
    // than twice the ground the frame would otherwise contain, which is exactly why it cannot be a
    // cosmetic offset applied after `groundFrame` has spoken.
    const lifted = frameAt(CAMERA_DISTANCE_MIN, CAMERA_PITCH_FLOOR, RING_ASPECT);
    const flat = groundFrame(CAMERA_DISTANCE_MIN, CAMERA_PITCH_FLOOR, RING_ASPECT);
    assert.ok(lifted.ahead > flat.ahead * 2, `${lifted.ahead} m against ${flat.ahead} m`);
  });

  it('clamps through the rig, and a lowered ceiling pulls the camera in with it', () => {
    const rig = new CameraRig(16 / 9);
    rig.distance = 1000;
    assert.equal(rig.distance, CAMERA_DISTANCE_MAX);
    rig.pitch = 10;
    assert.equal(rig.pitch, CAMERA_PITCH_MIN);
    assert.equal(rig.moved, true);
    // An ultrawide canvas lowers the ceiling; the live distance must come with it, not stay illegal.
    rig.maxDistance = 40;
    assert.equal(rig.distance, 40);
    rig.distance = 44;
    assert.equal(rig.distance, 40, 'the ceiling did not hold against a later write');
    rig.reset();
    assert.equal(rig.distance, CAMERA_DISTANCE);
    assert.equal(rig.pitch, CAMERA_PITCH_DEGREES);
    assert.equal(rig.moved, false);
  });

  it('moves the camera the moment the pose is written, with no frame of lag', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(0, 0, 0);
    const before = rig.camera.position.clone();
    rig.distance = CAMERA_DISTANCE_MAX;
    rig.follow(0, 0, 0);
    assert.ok(rig.camera.position.z > before.z, 'pulling back must move the camera back');
    assert.ok(rig.camera.position.y > before.y, 'and up, at a fixed pitch');
    const pulled = rig.camera.position.clone();
    rig.pitch = CAMERA_PITCH_MIN;
    rig.follow(0, 0, 0);
    assert.ok(rig.camera.position.y < pulled.y, 'lowering the pitch must lower the camera');
    assert.ok(rig.camera.position.z > pulled.z, 'and lay it further back');
  });
});

describe('the frame the rig shows', () => {
  it('reproduces the numbers M4 derived by hand at the authored pose', () => {
    // `night.ts`'s header states the default frame as "12.4 m north and 20.4 m either side". Those
    // were worked out with a pencil at 36 m and 64°; `groundFrame` must agree, or one of the two is
    // describing a camera this project does not have. (M4 said "north" because M4's camera could
    // only look north; the number is the frame's own forward and is unchanged.)
    const frame = groundFrame(CAMERA_DISTANCE, CAMERA_PITCH_DEGREES, 16 / 9);
    assert.ok(Math.abs(frame.ahead - 12.35) < 0.05, `${frame.ahead} m ahead`);
    assert.ok(Math.abs(frame.halfWidthFar - 20.42) < 0.05, `${frame.halfWidthFar} m either side`);
    assert.ok(Math.abs(frame.behind - 9.49) < 0.05, `${frame.behind} m behind`);
    // And the view-depth range `foliage.ts`'s fade band is compared against.
    assert.ok(Math.abs(frame.nearDepth - 31.84) < 0.05, `near depth ${frame.nearDepth}`);
    assert.ok(Math.abs(frame.farDepth - 41.41) < 0.05, `far depth ${frame.farDepth}`);
  });

  it('always sees further ahead than behind, and flares away from the camera', () => {
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const frame = frameAt(distance, pitch, RING_ASPECT);
      assert.ok(frame.ahead > frame.behind, `${distance} m / ${pitch}° sees further behind than ahead`);
      assert.ok(frame.halfWidthFar > frame.halfWidthNear, 'the trapezoid is inverted');
      assert.ok(frame.farDepth > frame.nearDepth, 'the depth range is inverted');
      assert.ok(frame.nearDepth > 0 && Number.isFinite(frame.farDepth));
    }
  });

  it('refuses a pitch that would put the far edge on the horizon', () => {
    // Not reachable through the clamp — this is the guard behind it, and the reason the clamp's floor
    // is where it is. At `pitch === fov/2` the far ray is horizontal and `tan` is zero.
    assert.throws(() => groundFrame(36, 15, 16 / 9));
    assert.throws(() => groundFrame(36, 10, 16 / 9));
  });

  it('stays inside the streaming ring everywhere on the envelope', () => {
    /*
     * **The generalisation of M3's "keeps its ground footprint inside the streamer window".**
     *
     * `RING_COVER.radius` is what the window guarantees *whatever the character's position inside
     * their own cell* — the centre cell's own stride is theirs to spend, so the guarantee is measured
     * from its far side. If any corner of the clamp asks for more than that, the frame shows unbuilt
     * void, and at `DAY_SKY`'s third-strength fog there is nothing to hide it behind.
     *
     * One number since M8, because a rotating frame has no stable per-axis extent — see
     * `rig.groundRadius`. The sweep that actually exercises the rotation is the next test; this one
     * is the scalar it rests on.
     */
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const radius = groundRadius(frameAt(distance, pitch, RING_ASPECT));
      assert.ok(radius <= RING_COVER.radius, `${radius} m of frame vs ${RING_COVER.radius} built, at ${distance}/${pitch}`);
    }
  });

  it('lands every corner of the frame on a built cell, at every yaw, everywhere on the envelope', () => {
    /*
     * **M8's own acceptance, and it is a property rather than a derivation.**
     *
     * The ring's arithmetic could be re-derived wrongly and still be internally consistent; what
     * cannot be faked is this: take the four corners of the ground the frame actually shows, at a
     * pose, at a yaw, with the character standing at the *worst* corner of their own cell, and ask
     * whether the cell each one lands in is a cell the streamer built. A hole anywhere in that sweep
     * is a frame with void in it — which is the failure M3 named and every camera slice since has
     * owed an answer for.
     *
     * 52 yaws x 4 clamp corners x 4 player positions x 4 frame corners = 3,328 samples, and the
     * expensive part (the window's own key set) is built once.
     */
    const built = new Set<string>();
    for (const address of windowAddresses(0, 0, 0)) {
      if (address.level === 0) built.add(chunkKey(address));
    }
    const stride = RING_COVER.radius; // only used in the message below
    let checked = 0;
    let worst = 0;
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const frame = frameAt(distance, pitch, RING_ASPECT);
      // The trapezoid, in the camera's own axes: `u` across, `v` forward.
      const corners: readonly (readonly [number, number])[] = [
        [frame.halfWidthFar, frame.ahead],
        [-frame.halfWidthFar, frame.ahead],
        [frame.halfWidthNear, -frame.behind],
        [-frame.halfWidthNear, -frame.behind],
      ];
      for (const yaw of SWEEP_YAWS) {
        const radians = (yaw * Math.PI) / 180;
        const sin = Math.sin(radians);
        const cos = Math.cos(radians);
        // The character anywhere in their own cell. The corners of it are the worst cases, and they
        // are what the `- 1` in `WINDOW_HALF` exists to pay for.
        for (const [px, pz] of [
          [0, 0],
          [9.999, 0],
          [0, 9.999],
          [9.999, 9.999],
        ] as const) {
          for (const [u, v] of corners) {
            // Camera axes to world: right is `(cos, -sin)`, forward is `(-sin, -cos)`.
            const x = px + u * cos - v * sin;
            const z = pz - u * sin - v * cos;
            const key = `0:${Math.floor(x / 10)}:${Math.floor(z / 10)}`;
            checked += 1;
            worst = Math.max(worst, Math.hypot(x - px, z - pz));
            assert.ok(built.has(key), `void at yaw ${yaw}, ${distance} m / ${pitch}°, corner ${u},${v} -> ${key}`);
          }
        }
      }
    }
    console.log(
      `[M9 ring] ${checked} frame corners over 52 yaws x ${ENVELOPE_POSES.length} envelope poses x 4 cell positions all on ` +
        `built ground; furthest corner ${worst.toFixed(2)} m against ${stride.toFixed(2)} m of guarantee`,
    );
  });

  it('uses most of the ring at the widest corner, or the extra cells are waste', () => {
    // The other half of M3's pair of assertions: a ring the frame never comes near is chunks built,
    // dressed and drawn for nobody. At 96 m and 45° the frame should be filling it.
    const radius = groundRadius(groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, RING_ASPECT));
    assert.ok(radius / RING_COVER.radius > 0.9, `${radius} of ${RING_COVER.radius}`);
    // And the disc is a disc: the diagonal is genuinely cut, or this is a square wearing a radius.
    assert.ok(cellReach(9, 4) > RING_COVER.radius, 'the corners of the square are still being built');
    assert.ok(cellReach(9, 0) <= RING_COVER.radius, 'the axis reach was cut instead');
  });

  it('grows the moon’s shadow volume with the frame, and keeps it inside the ring at every yaw', () => {
    /*
     * The per-frame refit already follows the camera's *position*; M6 makes it follow the camera's
     * *pose* as well. Two things have to hold at every corner and they pull against each other: the
     * box must contain the visible ground (or shadows stop at a line across the frame), and it must
     * not reach outside the built ring (or it is fitted to ground that does not exist, spending texel
     * density on nothing). The pad is the slack between them.
     *
     * **M8 keeps both by turning the box rather than growing it** (`night.fitShadowCamera`'s `yaw`),
     * which is why the second assertion is yaw-free: the box's furthest corner is at
     * `hypot(width, depth)` from the character whatever the yaw, and that is the same circumradius
     * the ring was sized on. An axis-aligned box would have reached `width + depth` on the diagonal —
     * asserted here as the thing that was avoided, so nobody quietly re-flattens it.
     */
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const frame = frameAt(distance, pitch, RING_ASPECT);
      const half = shadowExtentsFor(frame);
      assert.ok(half.width >= frame.halfWidthFar, `shadow box is narrower than the frame at ${distance}/${pitch}`);
      assert.ok(half.depth >= frame.ahead, `shadow box is shallower than the frame at ${distance}/${pitch}`);
      const corner = Math.hypot(half.width, half.depth);
      assert.ok(corner + SHADOW_PAD <= RING_COVER.radius, `the shadow box reaches past the built ring at ${distance}/${pitch}`);
      // What an axis-aligned hull would have cost, stated so the trade is visible in the test too.
      if (distance === CAMERA_DISTANCE_MAX && pitch === CAMERA_PITCH_MIN) {
        assert.ok(half.width + half.depth > RING_COVER.radius, 'a world-aligned box would have fitted after all');
      }
    }
    // And it is the *live* number, not a constant: the widest corner must want a bigger box than the
    // authored pose does, or nothing about this is actually derived.
    const home = shadowExtentsFor(groundFrame(CAMERA_DISTANCE, CAMERA_PITCH_DEGREES, RING_ASPECT));
    const widest = shadowExtentsFor(groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, RING_ASPECT));
    assert.ok(widest.width > home.width * 1.4, `${widest.width} vs ${home.width}`);
    assert.ok(widest.depth > home.depth * 1.8, `${widest.depth} vs ${home.depth}`);
  });

  it('reads its own aspect, so a wider canvas widens the frame and not the depth', () => {
    const rig = new CameraRig(1);
    rig.resize(1600, 900);
    const wide = rig.ground();
    rig.resize(900, 900);
    const square = rig.ground();
    assert.ok(wide.halfWidthFar > square.halfWidthFar);
    assert.equal(wide.ahead, square.ahead);
    assert.equal(wide.farDepth, square.farDepth);
  });
});

/** Normalised device coordinates for a world point, which is all "up the frame" needs. */
function project(rig: CameraRig, point: { x: number; y: number; z: number }): Vector3 {
  rig.camera.updateMatrixWorld(true);
  rig.camera.updateProjectionMatrix();
  return new Vector3(point.x, point.y, point.z).project(rig.camera);
}
