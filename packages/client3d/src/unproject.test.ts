/**
 * `unprojectToGround` against a known camera pose, and `pixelOfMetres` against its own inverse.
 *
 * `rig.test.ts` already proves the *camera*: pulled back along +Z at 64°, looking north. This proves
 * the *pointer*: that a screen point run back through that same camera lands where the geometry says
 * it must, both at the dead-centre case a `lookAt` point makes exact and, self-consistently, off it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { WORLD_SCALE } from '@mygame/shared';

import { metresOfPixel, pixelOfMetres } from './frame.ts';
import { CameraRig } from './rig.ts';
import { unprojectToGround } from './unproject.ts';

describe('unprojectToGround', () => {
  it('hits the followed target dead centre, at NDC (0, 0)', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(0, 0, 0);
    rig.camera.updateMatrixWorld(true);
    const hit = unprojectToGround(rig.camera, 0, 0, 0);
    assert.ok(hit, 'the centre of the screen must meet the plane the rig is looking at');
    assert.ok(Math.abs(hit.x) < 1e-9, `x ${hit.x}`);
    assert.ok(Math.abs(hit.y) < 1e-9, `y ${hit.y}`);
    assert.ok(Math.abs(hit.z) < 1e-9, `z ${hit.z}`);
  });

  it('hits an off-origin target dead centre too — the same case `rig.test.ts` follows', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(12, 3, -7);
    rig.camera.updateMatrixWorld(true);
    const hit = unprojectToGround(rig.camera, 0, 0, 3);
    assert.ok(hit);
    assert.ok(Math.abs(hit.x - 12) < 1e-6, `x ${hit.x}`);
    assert.ok(Math.abs(hit.y - 3) < 1e-6, `y ${hit.y}`);
    assert.ok(Math.abs(hit.z - -7) < 1e-6, `z ${hit.z}`);
  });

  it('round-trips through the camera projection at several off-centre points', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(5, 0, -20);
    rig.camera.updateMatrixWorld(true);
    rig.camera.updateProjectionMatrix();

    for (const [ndcX, ndcY] of [
      [0.4, 0.3],
      [-0.6, 0.1],
      [0, 0.8],
      [-0.9, -0.5],
    ] as const) {
      const hit = unprojectToGround(rig.camera, ndcX, ndcY, 0);
      assert.ok(hit, `(${ndcX}, ${ndcY}) should meet the ground plane inside the frustum`);
      const reprojected = new Vector3(hit.x, hit.y, hit.z).project(rig.camera);
      assert.ok(Math.abs(reprojected.x - ndcX) < 1e-6, `x: ${reprojected.x} vs ${ndcX}`);
      assert.ok(Math.abs(reprojected.y - ndcY) < 1e-6, `y: ${reprojected.y} vs ${ndcY}`);
    }
  });

  it('answers a different plane at the requested height, exactly', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(0, 0, 0);
    rig.camera.updateMatrixWorld(true);
    for (const groundY of [-4, 0, 6]) {
      const hit = unprojectToGround(rig.camera, 0.2, -0.3, groundY);
      assert.ok(hit);
      assert.equal(hit.y, groundY);
    }
  });

  it('misses when the ray points above the horizon', () => {
    const rig = new CameraRig(16 / 9);
    rig.follow(0, 0, 0);
    rig.camera.updateMatrixWorld(true);
    // Pitch is 64° with a 30° vertical FOV (15° either side of centre — `space.ts`), so a point this
    // far outside the actual frustum is aimed well above horizontal; extreme rather than boundary-exact
    // on purpose, so the assertion does not depend on the FOV or pitch numbers staying what they are.
    const hit = unprojectToGround(rig.camera, 0, 20, 0);
    assert.equal(hit, undefined);
  });
});

describe('pixelOfMetres, the inverse of metresOfPixel', () => {
  it('is the reciprocal of WORLD_SCALE', () => {
    assert.equal(pixelOfMetres(1), 1 / WORLD_SCALE);
    assert.equal(pixelOfMetres(1), 32);
  });

  it('round-trips a simulation pixel through metres and back', () => {
    for (const px of [0, 1, -1, 32, 288, -1500.5]) {
      assert.ok(Math.abs(pixelOfMetres(metresOfPixel(px)) - px) < 1e-9, `${px}`);
    }
  });

  it('round-trips a metres position through pixels and back', () => {
    for (const metres of [0, 0.5, -3.25, 47]) {
      assert.ok(Math.abs(metresOfPixel(pixelOfMetres(metres)) - metres) < 1e-9, `${metres}`);
    }
  });
});
