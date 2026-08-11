import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAMERA_FOV_DEGREES,
  CAMERA_PITCH_DEGREES,
  RENDER_UP,
  WORLD_SCALE,
  toRenderPoint,
} from './space.ts';
import { ROOM_STRIDE, ROOM_TILES, PLAYER_RADIUS, PLAYER_SPEED, TILE_SIZE } from './tilemap.ts';
import { DIRECTION_DELTA } from './world.ts';

describe('the coordinate adapter', () => {
  it('walking north moves -Z', () => {
    // **The headline case, and the reason this file exists.** `world.ts` fixes y as growing south so
    // that world and screen coordinates agree; a renderer that negates it mirrors the entire world
    // north-for-south while every individual room still draws correctly, which is a bug you find
    // weeks later from a description of a landmark rather than from a crash.
    //
    // Derived from `DIRECTION_DELTA` rather than from a hardcoded -1, so that flipping *either*
    // side of the map — the direction table or the adapter — fails here.
    const [, northDy] = DIRECTION_DELTA.north;
    const start = toRenderPoint(0, 0);
    const oneRoomNorth = toRenderPoint(0, northDy * ROOM_STRIDE * TILE_SIZE);

    assert.ok(oneRoomNorth.z < start.z, `north must decrease z, got ${oneRoomNorth.z} from ${start.z}`);
    assert.equal(oneRoomNorth.z, -ROOM_STRIDE, 'and by exactly one stride in metres');
    assert.equal(oneRoomNorth.x, 0, 'north moves nothing east or west');
  });

  it('walking south moves +Z and east moves +X, with no negation anywhere', () => {
    const [eastDx] = DIRECTION_DELTA.east;
    const [, southDy] = DIRECTION_DELTA.south;
    assert.equal(toRenderPoint(0, southDy * TILE_SIZE).z, 1, 'south is +Z: y grows downward, so does z');
    assert.equal(toRenderPoint(eastDx * TILE_SIZE, 0).x, 1, 'east is +X');
    assert.equal(toRenderPoint(-TILE_SIZE, 0).x, -1, 'west is -X');
  });

  it('puts elevation on +Y and nothing else there', () => {
    // The simulation has no opinion about up in pixels, so `y` is the one axis that is not a scaled
    // simulation coordinate. Passing none must leave the ground plane at zero rather than lifting the
    // world by whatever the last caller happened to send.
    assert.equal(toRenderPoint(32, 64).y, 0);
    assert.deepEqual(toRenderPoint(32, 64, 2.5), { x: 1, y: 2.5, z: 2 });
  });

  it('scales a room to nine metres and the classic stride to eleven', () => {
    // The numbers the plan quotes, asserted rather than trusted: if `TILE_SIZE` or `WORLD_SCALE` ever
    // move apart, every asset in the build is the wrong size and nothing else says so.
    assert.equal(WORLD_SCALE, 1 / 32);
    assert.equal(ROOM_TILES * TILE_SIZE * WORLD_SCALE, 9, 'a room is nine metres across');
    assert.equal(ROOM_STRIDE * TILE_SIZE * WORLD_SCALE, 11, 'and the stride is eleven');
    assert.ok(Math.abs(PLAYER_RADIUS * WORLD_SCALE - 0.3125) < 1e-12, 'the collision box is 0.31 m');
    assert.ok(Math.abs(PLAYER_SPEED * WORLD_SCALE - 4.6875) < 1e-12, 'and a walk is 4.69 m/s');
  });

  it('keeps the camera pitch off the degenerate axis', () => {
    // At 90 degrees the view direction is parallel to `RENDER_UP` and the basis has no defined roll:
    // the frame flips or blanks depending on which way a floating-point comparison fell.
    assert.ok(CAMERA_PITCH_DEGREES > 0 && CAMERA_PITCH_DEGREES < 90, `pitch ${CAMERA_PITCH_DEGREES}`);
    assert.equal(CAMERA_PITCH_DEGREES, 64);
    assert.equal(CAMERA_FOV_DEGREES, 30);
    assert.deepEqual(RENDER_UP, { x: 0, y: 1, z: 0 });
  });

  it('is linear, so a walk in two steps lands where the same walk in one does', () => {
    // Client prediction reconciles positions computed at different times against one map. An adapter
    // with any offset in it would put the two answers a fraction of a metre apart, which reads as a
    // permanent jitter nobody can find.
    const oneStep = toRenderPoint(300, -170, 1.5);
    const twoSteps = toRenderPoint(100 + 200, -70 - 100, 1.5);
    assert.deepEqual(twoSteps, oneStep);
    assert.deepEqual(toRenderPoint(0, 0), { x: 0, y: 0, z: 0 }, 'and the origin is the origin');
  });
});
