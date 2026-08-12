/**
 * The destination ring: one pooled wrapper, shown/hidden/pulsed without growing the pool, and a pulse
 * that stays inside `scene.ts:2758`'s 0.8-1.3 scale range.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Matrix4, Quaternion, Scene, Vector3, type InstancedMesh } from 'three';

import { Marker } from './marker.ts';
import { ScenePool } from './pool.ts';
import { DIMENSIONS } from './prototypes.ts';

/** Pulls a wrapper's one instance matrix back apart, for asserting on position/scale directly. */
function decomposeAt(mesh: InstancedMesh, index: number): { position: Vector3; scale: Vector3 } {
  const matrix = new Matrix4();
  mesh.getMatrixAt(index, matrix);
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);
  return { position, scale };
}

describe('Marker', () => {
  it('acquires exactly one wrapper, once, and never grows the pool', () => {
    const pool = new ScenePool();
    const before = pool.snapshot();
    const scene = new Scene();
    new Marker(scene, pool);
    const after = pool.snapshot();
    assert.equal(after.wrappersLive, before.wrappersLive + 1);
    assert.equal(after.wrappersCreated, before.wrappersCreated, 'the free list already had one to give');
    assert.equal(scene.children.length, 1);
    pool.dispose();
  });

  it('is invisible (count 0) until shown, and goes back to invisible on hide', () => {
    const pool = new ScenePool();
    const scene = new Scene();
    const marker = new Marker(scene, pool);
    const mesh = scene.children[0] as unknown as InstancedMesh;
    assert.equal(mesh.count, 0);
    assert.equal(marker.visible, false);

    marker.show(1, 2, 3);
    marker.pulse(0);
    assert.equal(mesh.count, 1);
    assert.equal(marker.visible, true);

    marker.hide();
    assert.equal(mesh.count, 0);
    assert.equal(marker.visible, false);

    // A pulse after hide must not resurrect it.
    marker.pulse(1);
    assert.equal(mesh.count, 0);
    pool.dispose();
  });

  it("pulses the ring's radius within scene.ts's 0.8-1.3 scale band, never outside it", () => {
    const pool = new ScenePool();
    const scene = new Scene();
    const marker = new Marker(scene, pool);
    const mesh = scene.children[0] as unknown as InstancedMesh;
    marker.show(0, 0, 0);

    const minRadius = DIMENSIONS.glowRadius * 0.8;
    const maxRadius = DIMENSIONS.glowRadius * 1.3;
    let sawNearMin = false;
    let sawNearMax = false;
    // `InstancedMesh.instanceMatrix` is `Float32Array`-backed, so a value read back through
    // `getMatrixAt` carries float32 rounding (an exact 2.21 comes back `2.2100000381469727`) —
    // the tolerance is 1e-4, not the double-precision 1e-9 `unproject.test.ts` can use because
    // nothing there round-trips through a GPU-shaped buffer.
    const EPSILON = 1e-4;
    for (let t = 0; t < 4; t += 0.02) {
      marker.pulse(t);
      const { scale } = decomposeAt(mesh, 0);
      assert.ok(scale.x >= minRadius - EPSILON && scale.x <= maxRadius + EPSILON, `${scale.x} at t=${t}`);
      // The ring is uniformly scaled — `setScalar` — so every axis carries the same radius.
      assert.ok(Math.abs(scale.x - scale.y) < EPSILON && Math.abs(scale.x - scale.z) < EPSILON);
      if (scale.x < minRadius + 0.02) sawNearMin = true;
      if (scale.x > maxRadius - 0.02) sawNearMax = true;
    }
    assert.ok(sawNearMin, 'the sweep should have passed near the bottom of the breath');
    assert.ok(sawNearMax, 'the sweep should have passed near the top of the breath');
    pool.dispose();
  });

  it('lifts the ring off the ground by DIMENSIONS.glowLift and leaves x/z where shown', () => {
    const pool = new ScenePool();
    const scene = new Scene();
    const marker = new Marker(scene, pool);
    const mesh = scene.children[0] as unknown as InstancedMesh;
    marker.show(5, 10, -5);
    marker.pulse(0);

    const { position } = decomposeAt(mesh, 0);
    // Float32 tolerance again — see the pulse test above.
    assert.ok(Math.abs(position.x - 5) < 1e-4);
    assert.ok(Math.abs(position.y - (10 + DIMENSIONS.glowLift)) < 1e-4);
    assert.ok(Math.abs(position.z - -5) < 1e-4);
    pool.dispose();
  });
});
