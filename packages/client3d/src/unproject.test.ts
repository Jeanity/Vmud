/**
 * `unprojectToGround` against a known camera pose, and `pixelOfMetres` against its own inverse.
 *
 * `rig.test.ts` already proves the *camera*: pulled back along +Z at 64°, looking north. This proves
 * the *pointer*: that a screen point run back through that same camera lands where the geometry says
 * it must, both at the dead-centre case a `lookAt` point makes exact and, self-consistently, off it.
 *
 * ## M6: the whole composed path, at every corner of the dolly clamp
 *
 * The last test in the file is the one the milestone owes. Since M5c a click does not stop at the
 * ground plane: the ray meets the ground where it is **drawn**, and everything downstream of that —
 * the tile index, the `seen` gate, the `moveTo` — speaks the unwarped grid the simulation walks, so
 * `main.ts` runs the lens backwards in between (`World3D.unwarpAt`). M5c measured that inversion at
 * a worst residual of 0.06 mm over 186,176 samples, at one camera pose.
 *
 * The pose moves now. `Raycaster.setFromCamera` is camera-agnostic and the warp is a function of
 * world position alone, so in principle nothing about the composition depends on where the camera
 * stands — but "in principle" is exactly what M5a's invisible undergrowth was, and the conditioning
 * of the ray-plane intersection genuinely does get worse as the pitch drops and the rays graze. So
 * the round trip is measured, everywhere on the envelope: grid point -> warp -> project -> unproject ->
 * unwarp, back to the grid point it started at, against M5c's own sub-millimetre bar.
 *
 * ## M8: and around the whole circle
 *
 * The yaw is a third axis of the same argument and it deserves less trust, not more, because it is
 * the one that changes the *shape* of the view matrix rather than one term in it. Two things could
 * have gone wrong and the sweep is what says neither did: the ray-plane solve could condition
 * differently off-axis (it does not — the ray's angle to the plane depends on the pitch alone), and
 * the warp inversion could pick up a directional bias (it cannot — the field is keyed on world
 * position, and this is the test that says so rather than the file that claims it). The bar is
 * unchanged at sub-millimetre, which is the point: a pointer that got worse when the camera turned
 * would be a click-to-move that drifted only for players who use the new camera.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Vector3 } from 'three';

import { WORLD_SCALE } from '@mygame/shared';

import { CARDINAL_YAWS, ENVELOPE_POSES, SWEEP_YAWS, sampleZone } from './fixture.ts';
import { metresOfPixel, pixelOfMetres, placeFrame } from './frame.ts';
import { CameraRig } from './rig.ts';
import { unprojectToGround } from './unproject.ts';
import { warpFieldOf, type WarpVec } from './warp.ts';

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

  it('hits the followed target dead centre at every yaw, which is the whole claim in one line', () => {
    // If the pointer read the camera's *pose* anywhere — and it reads none of it — this is where a
    // yaw would show up first: the centre of the screen is exactly the point the rig is looking at,
    // at any angle, or the click is aimed somewhere the player is not.
    const rig = new CameraRig(16 / 9);
    for (const yaw of SWEEP_YAWS) {
      rig.yaw = yaw;
      rig.follow(12, 3, -7);
      rig.camera.updateMatrixWorld(true);
      const hit = unprojectToGround(rig.camera, 0, 0, 3);
      assert.ok(hit, `no hit at yaw ${yaw}`);
      assert.ok(Math.abs(hit.x - 12) < 1e-6, `yaw ${yaw}: x ${hit.x}`);
      assert.ok(Math.abs(hit.z - -7) < 1e-6, `yaw ${yaw}: z ${hit.z}`);
    }
  });

  it('round-trips a click through the M5c lens at every corner of the dolly clamp', () => {
    // A synthetic Place rather than the built world, so this runs on a checkout that has never
    // generated one — `warp.test.ts` owns the world-wide sweep and measures 186,176 samples of it.
    // What is new here is the *camera*, and the camera does not care which zone it is looking at.
    const zone = sampleZone();
    const frame = placeFrame(zone, 0);
    const field = warpFieldOf(zone, frame);
    // The centre of room 3, in renderer metres: cell (1,1), a stride of 11 tiles, half a block in.
    const homeX = 15.5;
    const homeZ = 15.5;

    const drawn: WarpVec = { x: 0, z: 0 };
    const back: WarpVec = { x: 0, z: 0 };
    let worst = 0;
    let worstAt = '';
    let samples = 0;
    let moved = 0;
    let worstPush = 0;

    for (const [distance, pitch] of ENVELOPE_POSES) {
      for (const yaw of CARDINAL_YAWS) {
        const rig = new CameraRig(16 / 9);
        rig.distance = distance;
        rig.pitch = pitch;
        rig.yaw = yaw;
        // `main.ts` follows the *drawn* body, not the grid one — the camera goes through the lens
        // with everything else. Following the grid position instead would put every residual below
        // out by the field's local displacement, which is metres, not millimetres.
        field.displaceInto(drawn, homeX, homeZ, 0);
        rig.follow(homeX + drawn.x, 0, homeZ + drawn.z);
        rig.camera.updateMatrixWorld(true);
        rig.camera.updateProjectionMatrix();

        const ground = rig.ground();
        for (let ix = -3; ix <= 3; ix++) {
          for (let iz = -3; iz <= 3; iz++) {
            // Grid positions spread across the ground the frame actually contains at this pose —
            // and since M8 the frame is turned, so the offsets are laid out in the *camera's* axes
            // and rotated into the world. Sampling a world-axis square would walk off the top of
            // the frame at 45° of yaw and test the sky.
            const radians = (yaw * Math.PI) / 180;
            const across = (ix / 3) * ground.halfWidthNear * 0.9;
            const along = (iz < 0 ? (-iz / 3) * ground.ahead : (-iz / 3) * ground.behind) * 0.9;
            const gx = homeX + across * Math.cos(radians) - along * Math.sin(radians);
            const gz = homeZ - across * Math.sin(radians) - along * Math.cos(radians);
            field.displaceInto(drawn, gx, gz, 0);
            const push = Math.hypot(drawn.x, drawn.z);
            if (push > 0.01) moved += 1;
            worstPush = Math.max(worstPush, push);
            // Where that patch of ground is *drawn*, projected to the screen the player is looking at.
            const ndc = new Vector3(gx + drawn.x, 0, gz + drawn.z).project(rig.camera);
            // …and the pointer's own two steps, in `main.ts`'s order.
            const hit = unprojectToGround(rig.camera, ndc.x, ndc.y, 0);
            assert.ok(hit, `no ground hit at ${distance} m / ${pitch}° / yaw ${yaw}, offset ${ix},${iz}`);
            field.invertInto(back, hit.x, hit.z, 0);
            const error = Math.hypot(back.x - gx, back.z - gz);
            samples += 1;
            if (error > worst) {
              worst = error;
              worstAt = `${distance} m / ${pitch}° / yaw ${yaw} at ${ix},${iz}`;
            }
          }
        }
      }
    }

    console.log(
      `[M8 pointer] ${samples} round trips over the pose envelope x eight yaws: ` +
        `worst ${(worst * 1000).toExponential(2)} mm at ${worstAt}; ` +
        `the lens pushed the ground up to ${worstPush.toFixed(2)} m under them`,
    );
    // The field has to have actually bent something, or this is a test of the identity function.
    assert.ok(moved > samples / 2, `only ${moved} of ${samples} samples were displaced at all`);
    // M5c's own bar, unchanged by the camera moving: sub-millimetre, which is a thirtieth of a
    // collision tile and three orders inside the tile a click resolves to.
    assert.ok(worst < 0.001, `the composed path left ${(worst * 1000).toFixed(3)} mm on the table at ${worstAt}`);
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
