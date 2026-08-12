/**
 * The rain's buffer, headless.
 *
 * The shader cannot be run here and the look cannot be judged here. What *can* be pinned is the thing
 * the shader depends on and cannot check for itself: that the seed buffer is the shape and the range
 * the vertex program assumes. Every one of these assertions corresponds to a line in `rain.ts`'s
 * `VERTEX` that would silently produce a wrong picture rather than an error — a speed of zero is a
 * drop hanging in the air, a seed outside the box is a drop that wraps on its first frame, and a
 * stride that disagrees with the attribute's `itemSize` is a storm made of one drop's data read four
 * ways.
 *
 * The determinism case is the one worth having twice: the plan's *"one draw call, zero CPU per
 * frame"* is a performance claim, but a seeded storm is also the difference between two players
 * describing the same weather and two players describing different weather.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RAIN_BOX, RAIN_DROPS, RAIN_STRIDE, Rain, rainSeeds } from './rain.ts';

describe('the rain buffer', () => {
  it('is one vec4 per drop', () => {
    const seeds = rainSeeds(RAIN_DROPS);
    assert.equal(RAIN_STRIDE, 4);
    assert.equal(seeds.length, RAIN_DROPS * RAIN_STRIDE);
    assert.equal(seeds.BYTES_PER_ELEMENT, 4);
    // 96 KB for the whole storm, uploaded once. The number the "zero CPU per frame" claim rests on.
    assert.equal(seeds.byteLength, RAIN_DROPS * RAIN_STRIDE * 4);
  });

  it('seeds every drop inside the box the shader wraps against', () => {
    const seeds = rainSeeds(RAIN_DROPS);
    for (let i = 0; i < RAIN_DROPS; i++) {
      const at = i * RAIN_STRIDE;
      const x = seeds[at]!;
      const z = seeds[at + 1]!;
      const y = seeds[at + 2]!;
      const speed = seeds[at + 3]!;
      assert.ok(x >= 0 && x < RAIN_BOX.width, `drop ${i} seeded at x=${x}`);
      assert.ok(z >= 0 && z < RAIN_BOX.depth, `drop ${i} seeded at z=${z}`);
      assert.ok(y >= 0 && y < RAIN_BOX.height, `drop ${i} seeded at y=${y}`);
      // A speed of zero would hang a drop in mid-air for the whole session, and the streak length is
      // scaled by the same number, so it would be an invisible one.
      assert.ok(speed >= 0.8 && speed <= 1.3, `drop ${i} has speed ${speed}`);
    }
  });

  it('is deterministic, and different per seed', () => {
    assert.deepEqual(rainSeeds(64), rainSeeds(64), 'two builds of one storm must be byte-identical');
    assert.notDeepEqual(rainSeeds(64, 1), rainSeeds(64, 2), 'the seed is not reaching the hash');
  });

  it('spreads the drops rather than clustering them on the lattice', () => {
    // `hashCell` is the project's determinism contract and not a PRNG, so it is worth checking that
    // consecutive indices do not fall into a stripe: a hash that correlated on `i` would produce rain
    // in visible rows and no assertion above would notice.
    const seeds = rainSeeds(2048);
    const buckets = new Array<number>(8).fill(0);
    for (let i = 0; i < 2048; i++) {
      const x = seeds[i * RAIN_STRIDE]!;
      const bucket = Math.min(7, Math.floor((x / RAIN_BOX.width) * 8));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const [index, count] of buckets.entries()) {
      assert.ok(count > 180 && count < 330, `octile ${index} holds ${count} of 2048 drops`);
    }
  });

  it('is one instanced mesh that never leaves the frustum and never writes depth', () => {
    const rain = new Rain(128);
    const geometry = rain.mesh.geometry;
    assert.equal(geometry.getAttribute('aSeed').itemSize, RAIN_STRIDE);
    assert.equal(geometry.getAttribute('aSeed').count, 128);
    // Four corners and two triangles, instanced 128 times: one draw call.
    assert.equal(geometry.getAttribute('position').count, 4);
    assert.equal(geometry.getIndex()?.count, 6);
    assert.equal(rain.mesh.frustumCulled, false, 'the real positions are in the shader, not the bounds');
    assert.equal(rain.mesh.castShadow, false);
    assert.equal(rain.mesh.receiveShadow, false);
    const material = rain.mesh.material;
    assert.ok(!Array.isArray(material));
    assert.equal(material.depthWrite, false, 'six thousand quads writing depth is a grey sheet');
    assert.equal(material.transparent, true);
    rain.dispose();
  });

  it('advances only two uniforms a frame, and the toggle is the mesh', () => {
    const rain = new Rain(16);
    rain.update(12.5, 100, 2, -50);
    assert.equal(rain.material.uniforms['uTime']?.value, 12.5);
    const centre = rain.material.uniforms['uCentre']?.value as { x: number; z: number };
    assert.deepEqual(
      [centre.x, centre.z],
      [100, -50],
      'the wrap is keyed on the camera position; this is that position',
    );
    assert.equal(rain.enabled, true);
    rain.enabled = false;
    assert.equal(rain.mesh.visible, false);
    rain.dispose();
  });
});
