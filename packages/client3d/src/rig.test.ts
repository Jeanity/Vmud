/**
 * The camera rig against §3's spec, the axis map against the trap it was written for, and — M6 — the
 * **four corners of the dolly clamp** against everything that is derived from the frame.
 *
 * `space.test.ts` in `shared` already states the headline case — **walking north must move -Z** —
 * for the *conversion*. This asserts the consequence for the *camera*: pulled back along +Z at 64°,
 * looking north, with the world's north at the top of the frame. A rig that mirrored that would
 * render a perfectly plausible world in which every inn is on the wrong side of the road, and
 * neither the conversion test nor a screenshot would catch it.
 *
 * ## Why the corners, and why four of them
 *
 * Until M6 the rig had one pose and one test case was the whole domain. It now has a rectangle of
 * them — 24..48 m by 45..64° — and every consequence of the frame is monotone in *both* axes but not
 * in the same direction: pulling back widens the frame, and lowering the pitch widens it further and
 * pushes its far edge out much faster. So the extremes are the corners, and a test that checked the
 * default pose would be checking the one case that is nowhere near any of them.
 *
 * The property under test is the one M3 wrote as *"the frame either shows unbuilt void at its edges
 * or the streamer builds two rings nobody sees"*, generalised: **at every corner, the ground the
 * frame contains must be inside the ground the ring guarantees**, and the shadow volume must contain
 * the frame while itself staying inside the ring. `foliage.test.ts` does the same walk for the fade
 * bands and `unproject.test.ts` for the pointer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES, toRenderPoint } from '@mygame/shared';

import { CLAMP_CORNERS } from './fixture.ts';
import { SHADOW_PAD, shadowExtentsFor } from './night.ts';
import {
  CAMERA_DISTANCE,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CameraRig,
  clampDistance,
  clampPitch,
  groundFrame,
} from './rig.ts';
import { RING_ASPECT, RING_COVER } from './streamer.ts';

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

  it('still looks north, and still sits at the distance asked for, at every corner of the clamp', () => {
    for (const [distance, pitch] of CLAMP_CORNERS) {
      const rig = new CameraRig(16 / 9);
      rig.distance = distance;
      rig.pitch = pitch;
      rig.follow(0, 0, 0);
      const { x, y, z } = rig.camera.position;
      assert.ok(Math.abs(x) < 1e-9, `yaw drifted at ${distance} m / ${pitch}°`);
      assert.ok(Math.abs(Math.hypot(y, z) - distance) < 1e-9, `distance is ${Math.hypot(y, z)}`);
      const measured = (Math.atan2(y, z) * 180) / Math.PI;
      assert.ok(Math.abs(measured - pitch) < 1e-9, `pitch is ${measured}, wanted ${pitch}`);
      const north = project(rig, { x: 0, y: 0, z: -8 });
      const here = project(rig, { x: 0, y: 0, z: 0 });
      assert.ok(north.y > here.y, `north stopped being up the frame at ${distance} m / ${pitch}°`);
    }
  });
});

describe('the dolly clamp', () => {
  it('refuses anything outside the range, in both directions and from garbage', () => {
    assert.equal(clampDistance(10), CAMERA_DISTANCE_MIN);
    assert.equal(clampDistance(1000), CAMERA_DISTANCE_MAX);
    assert.equal(clampDistance(37.5), 37.5);
    assert.equal(clampDistance(Number.NaN), CAMERA_DISTANCE);
    assert.equal(clampPitch(0), CAMERA_PITCH_MIN);
    assert.equal(clampPitch(89), CAMERA_PITCH_MAX);
    assert.equal(clampPitch(52), 52);
    assert.equal(clampPitch(Number.NaN), CAMERA_PITCH_DEGREES);
    // The range is the one the brief asked for, stated rather than inferred from the arithmetic.
    assert.equal(CAMERA_DISTANCE_MIN, 24);
    assert.equal(CAMERA_DISTANCE_MAX, 48);
    assert.equal(CAMERA_PITCH_MIN, 45);
    // And the far edge of the frame stays well clear of the horizon at the shallowest tilt: the ray
    // that draws it leaves at `pitch - fov/2`, and at zero it never meets the ground at all.
    assert.ok(CAMERA_PITCH_MIN - CAMERA_FOV_DEGREES / 2 >= 25, 'the shallow clamp is too near the horizon');
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
    // describing a camera this project does not have.
    const frame = groundFrame(CAMERA_DISTANCE, CAMERA_PITCH_DEGREES, 16 / 9);
    assert.ok(Math.abs(frame.north - 12.35) < 0.05, `${frame.north} m north`);
    assert.ok(Math.abs(frame.halfWidthFar - 20.42) < 0.05, `${frame.halfWidthFar} m either side`);
    assert.ok(Math.abs(frame.south - 9.49) < 0.05, `${frame.south} m south`);
    // And the view-depth range `foliage.ts`'s fade band is compared against.
    assert.ok(Math.abs(frame.nearDepth - 31.84) < 0.05, `near depth ${frame.nearDepth}`);
    assert.ok(Math.abs(frame.farDepth - 41.41) < 0.05, `far depth ${frame.farDepth}`);
  });

  it('always sees further ahead than behind, and flares away from the camera', () => {
    for (const [distance, pitch] of CLAMP_CORNERS) {
      const frame = groundFrame(distance, pitch, RING_ASPECT);
      assert.ok(frame.north > frame.south, `${distance} m / ${pitch}° sees further behind than ahead`);
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

  it('stays inside the streaming ring at all four corners of the clamp', () => {
    /*
     * **The generalisation of M3's "keeps its ground footprint inside the streamer window".**
     *
     * `RING_COVER` is what the window guarantees *whatever the character's position inside their own
     * cell* — the centre cell's own stride is theirs to spend, so the guarantee is the cells beyond
     * it. If any corner of the clamp asks for more than that, the frame shows unbuilt void, and at
     * `DAY_SKY`'s third-strength fog there is nothing to hide it behind.
     */
    for (const [distance, pitch] of CLAMP_CORNERS) {
      const frame = groundFrame(distance, pitch, RING_ASPECT);
      const lateral = Math.max(frame.halfWidthNear, frame.halfWidthFar);
      assert.ok(lateral <= RING_COVER.lateral, `${lateral} m wide vs ${RING_COVER.lateral} built, at ${distance}/${pitch}`);
      assert.ok(frame.north <= RING_COVER.north, `${frame.north} m ahead vs ${RING_COVER.north} built`);
      assert.ok(frame.south <= RING_COVER.south, `${frame.south} m behind vs ${RING_COVER.south} built`);
    }
  });

  it('uses most of the ring at the widest corner, or the extra cells are waste', () => {
    // The other half of M3's pair of assertions: a ring the frame never comes near is chunks built,
    // dressed and drawn for nobody. At 48 m and 45° the frame should be filling it.
    const frame = groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, RING_ASPECT);
    assert.ok(frame.halfWidthFar / RING_COVER.lateral > 0.7, `${frame.halfWidthFar} of ${RING_COVER.lateral}`);
    assert.ok(frame.north / RING_COVER.north > 0.7, `${frame.north} of ${RING_COVER.north}`);
    assert.ok(frame.south / RING_COVER.south > 0.7, `${frame.south} of ${RING_COVER.south}`);
  });

  it('grows the moon’s shadow volume with the frame, and keeps it inside the ring', () => {
    /*
     * The per-frame refit already follows the camera's *position*; M6 makes it follow the camera's
     * *pose* as well. Two things have to hold at every corner and they pull against each other: the
     * box must contain the visible ground (or shadows stop at a line across the frame), and it must
     * not reach outside the built ring (or it is fitted to ground that does not exist, spending texel
     * density on nothing). The pad is the slack between them.
     */
    for (const [distance, pitch] of CLAMP_CORNERS) {
      const frame = groundFrame(distance, pitch, RING_ASPECT);
      const half = shadowExtentsFor(frame);
      assert.ok(half.width >= frame.halfWidthFar, `shadow box is narrower than the frame at ${distance}/${pitch}`);
      assert.ok(half.depth >= frame.north, `shadow box is shallower than the frame at ${distance}/${pitch}`);
      assert.ok(half.width + SHADOW_PAD <= RING_COVER.lateral, 'the shadow box reaches past the built ring');
      assert.ok(half.depth + SHADOW_PAD <= RING_COVER.north);
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
    assert.equal(wide.north, square.north);
    assert.equal(wide.farDepth, square.farDepth);
  });
});

/** Normalised device coordinates for a world point, which is all "up the frame" needs. */
function project(rig: CameraRig, point: { x: number; y: number; z: number }): Vector3 {
  rig.camera.updateMatrixWorld(true);
  rig.camera.updateProjectionMatrix();
  return new Vector3(point.x, point.y, point.z).project(rig.camera);
}
