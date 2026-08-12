/**
 * The camera rig against §3's spec, and the axis map against the trap it was written for.
 *
 * `space.test.ts` in `shared` already states the headline case — **walking north must move -Z** —
 * for the *conversion*. This asserts the consequence for the *camera*: pulled back along +Z at 64°,
 * looking north, with the world's north at the top of the frame. A rig that mirrored that would
 * render a perfectly plausible world in which every inn is on the wrong side of the road, and
 * neither the conversion test nor a screenshot would catch it.
 *
 * The last case ties the rig to the streamer. The window is sized from the camera's ground
 * footprint, and the two are in different files; if either moves without the other, the frame either
 * shows unbuilt void at its edges or the streamer builds two rings nobody sees.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES, toRenderPoint } from '@mygame/shared';

import { METRES_PER_TILE } from './frame.ts';
import { CAMERA_DISTANCE, CameraRig } from './rig.ts';
import { WINDOW_CELLS_X, WINDOW_CELLS_Y } from './streamer.ts';

const STRIDE_METRES = 11 * METRES_PER_TILE;

describe('the camera rig', () => {
  it('is §3 to the letter', () => {
    const rig = new CameraRig(16 / 9);
    assert.equal(rig.camera.fov, CAMERA_FOV_DEGREES);
    assert.equal(CAMERA_FOV_DEGREES, 30);
    assert.equal(CAMERA_PITCH_DEGREES, 64);
    assert.ok(CAMERA_PITCH_DEGREES < 90, 'at 90 the up vector degenerates and the frame flips');
    assert.deepEqual(rig.camera.up.toArray(), [0, 1, 0]);
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

  it('keeps its ground footprint inside the streamer window', () => {
    const rig = new CameraRig(16 / 9);
    const { width, depth } = rig.footprint();
    assert.ok(width < WINDOW_CELLS_X * STRIDE_METRES, `${width} m across vs a ${WINDOW_CELLS_X}-cell window`);
    assert.ok(depth < WINDOW_CELLS_Y * STRIDE_METRES, `${depth} m deep vs a ${WINDOW_CELLS_Y}-cell window`);
    // And not absurdly smaller than it, or the margin ring is doing nothing and the window is waste.
    assert.ok(width > (WINDOW_CELLS_X - 2) * STRIDE_METRES);
  });
});

/** Normalised device coordinates for a world point, which is all "up the frame" needs. */
function project(rig: CameraRig, point: { x: number; y: number; z: number }): Vector3 {
  rig.camera.updateMatrixWorld(true);
  rig.camera.updateProjectionMatrix();
  return new Vector3(point.x, point.y, point.z).project(rig.camera);
}
