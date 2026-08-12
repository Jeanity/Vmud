/**
 * The pool key set is bounded, and this is the assertion the plan asks for by name.
 *
 * *"Geometries and materials are pooled per (biome, archetype) and never created per room or per
 * zone — **bound the pool key set explicitly and assert its size in a test**."* A count that is
 * written down here and nowhere else is the only thing standing between the design and the failure
 * mode it exists to prevent, so the number is spelled out rather than recomputed from the same
 * tables the implementation uses: recomputing it would make the test agree with any change,
 * including the one that reintroduces the leak.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SECTORS } from '@mygame/shared';

import {
  ARCHETYPES,
  ARCHETYPE_GEOMETRY,
  BIOME_ARCHETYPES,
  GEOMETRY_KEYS,
  MATERIAL_KEYS,
  archetypeColour,
  materialKey,
} from './prototypes.ts';
import { ScenePool, WRAPPER_POOL_SIZE } from './pool.ts';

describe('the pool key set', () => {
  it('has exactly four geometries', () => {
    assert.equal(GEOMETRY_KEYS.length, 4);
    assert.deepEqual([...GEOMETRY_KEYS], ['box', 'cone', 'torus', 'capsule']);
  });

  it('has exactly 112 materials, and the arithmetic is legible', () => {
    // 3 terrain archetypes x 16 sectors = 48, plus 9 object archetypes = 57 distinct looks;
    // everything but the two body archetypes gets a faded twin, so + 55 = 112.
    //
    // 110 at M3. The two M4 added are `glow` and its twin — the stairwell marker — and that is the
    // *whole* of M4's growth: the emissive ring is a uniform on an existing material and the
    // three-state fog of war is a per-instance colour, so neither multiplied this table. See
    // `prototypes.ts` for why keying fog of war into the material would have taken it to 336.
    const terrain = BIOME_ARCHETYPES.length * SECTORS.length;
    const objects = ARCHETYPES.length - BIOME_ARCHETYPES.length;
    assert.equal(terrain, 48);
    assert.equal(objects, 9);
    assert.equal(MATERIAL_KEYS.length, 112);
    assert.equal(MATERIAL_KEYS.length, terrain + objects + (terrain + objects - 2));
  });

  it('enumerates without duplicates', () => {
    assert.equal(new Set(MATERIAL_KEYS).size, MATERIAL_KEYS.length);
  });

  it('is closed: every key materialKey can produce is already in the list', () => {
    const known = new Set(MATERIAL_KEYS);
    for (const archetype of ARCHETYPES) {
      for (const faded of [false, true]) {
        for (const sector of SECTORS) {
          assert.ok(known.has(materialKey(archetype, sector, faded)), `${archetype}/${sector}/${faded}`);
        }
        assert.ok(known.has(materialKey(archetype, undefined, faded)), `${archetype}/-/${faded}`);
      }
    }
  });

  it('gives every archetype a shape', () => {
    for (const archetype of ARCHETYPES) {
      assert.ok(GEOMETRY_KEYS.includes(ARCHETYPE_GEOMETRY[archetype]), archetype);
    }
  });

  it('gives a terrain archetype a different colour per sector', () => {
    const grounds = new Set(SECTORS.map((sector) => archetypeColour('ground', sector)));
    assert.equal(grounds.size, SECTORS.length, 'two sectors sharing a ground colour is a palette bug');
    // A barrier is the edge material darkened — same hue family, unmistakably not the same value.
    for (const sector of SECTORS) {
      assert.notEqual(archetypeColour('barrier', sector), archetypeColour('edge', sector));
    }
  });

  it('builds the whole pool in the constructor and never grows it', () => {
    const pool = new ScenePool();
    const start = pool.snapshot();
    assert.equal(start.geometries, GEOMETRY_KEYS.length);
    assert.equal(start.materials, MATERIAL_KEYS.length);
    // 70 window chunks x 10 buckets a chunk + 2 for the bodies. Derived, not chosen — see `pool.ts`.
    // Nine buckets at M3; M4's `glow` archetype is the tenth a single room can want.
    assert.equal(WRAPPER_POOL_SIZE, 702);
    assert.equal(start.prewarmed, WRAPPER_POOL_SIZE);
    assert.equal(start.wrappersCreated, WRAPPER_POOL_SIZE, 'the free list is whole before anything asks');
    assert.equal(start.wrappersFree, WRAPPER_POOL_SIZE);
    assert.equal(start.wrappersLive, 0);

    // Ask for every key. Nothing may be constructed by the asking.
    for (const key of MATERIAL_KEYS) assert.ok(pool.material(key));
    for (const key of GEOMETRY_KEYS) assert.ok(pool.geometry(key));
    const after = pool.snapshot();
    assert.deepEqual(after, start);
    pool.dispose();
  });

  it('recycles wrappers rather than minting them', () => {
    const pool = new ScenePool();
    const minted = pool.snapshot().wrappersCreated;
    const first = pool.acquire('box', 'ground|field');
    const second = pool.acquire('box', 'ground|forest');
    assert.equal(pool.snapshot().wrappersLive, 2);
    pool.release(first);
    pool.release(second);
    assert.equal(pool.snapshot().wrappersFree, minted);

    for (let round = 0; round < 50; round++) {
      const mesh = pool.acquire('cone', 'landmark');
      pool.release(mesh);
    }
    const ledger = pool.snapshot();
    assert.equal(ledger.wrappersCreated, minted, 'fifty acquire/release rounds must mint nothing');
    assert.equal(ledger.wrappersLive, 0);
    assert.equal(ledger.acquires - ledger.releases, ledger.wrappersLive);
    assert.equal(ledger.wrapperHighWater, 2);
    assert.equal(ledger.bytes, ledger.geometryBytes + ledger.instanceBytes);
    pool.dispose();
  });

  it('re-points a recycled wrapper at whatever the next chunk asked for', () => {
    const pool = new ScenePool();
    const first = pool.acquire('box', 'ground|forest');
    pool.release(first);
    const second = pool.acquire('cone', 'landmark');
    assert.equal(second, first, 'the free list is LIFO, so the same object comes straight back');
    assert.equal(second.geometry, pool.geometry('cone'));
    assert.equal(second.material, pool.material('landmark'));
    assert.equal(second.count, 0);
    pool.dispose();
  });
});
