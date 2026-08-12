/**
 * The pool key set is bounded, and this is the assertion the plan asks for by name.
 *
 * *"Geometries and materials are pooled per (biome, archetype) and never created per room or per
 * zone — **bound the pool key set explicitly and assert its size in a test**."* A count that is
 * written down here and nowhere else is the only thing standing between the design and the failure
 * mode it exists to prevent, so the number is spelled out rather than recomputed from the same
 * tables the implementation uses: recomputing it would make the test agree with any change,
 * including the one that reintroduces the leak.
 *
 * M5a adds the number that matters most now that there are three material families: **the program
 * count**. 145 materials, three programs, and the third assertion in this file is the one that says
 * so — because a foliage material that forgot its `customProgramCacheKey`, or a ground material that
 * varied a `#define` instead of a uniform, would compile one program per material and the first
 * symptom would be a two-second hitch the first time somebody walked into a wood.
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
  SHAPE_KEYS,
  TREE_GEOMETRY_KEYS,
  TREE_LODS,
  TREE_PARTS,
  TREE_VARIANTS,
  VARIANT_ARCHETYPES,
  archetypeColour,
  linearRgb,
  materialFamily,
  materialKey,
  treeMaterialKey,
} from './prototypes.ts';
import { ScenePool, WRAPPER_POOL_SIZE } from './pool.ts';

describe('the pool key set', () => {
  it('has exactly five built shapes and forty-eight baked ones', () => {
    assert.equal(SHAPE_KEYS.length, 5);
    assert.deepEqual([...SHAPE_KEYS], ['box', 'cone', 'torus', 'capsule', 'grassCross']);
    // 8 variants x 2 parts x 3 LODs. Closed, enumerated at module load, and asserted against the
    // baked manifest in `assets.test.ts` — see that file for the other half of this contract.
    assert.equal(TREE_VARIANTS.length, 8);
    assert.equal(TREE_PARTS.length, 2);
    assert.equal(TREE_LODS.length, 3);
    assert.equal(TREE_GEOMETRY_KEYS.length, 48);
    assert.equal(new Set(TREE_GEOMETRY_KEYS).size, 48);
    assert.equal(GEOMETRY_KEYS.length, 53);
  });

  it('has exactly 145 materials, and the arithmetic is legible', () => {
    // Terrain: 4 biome archetypes x 16 sectors = 64, of which `grass` never fades, so
    // 3 x 16 = 48 with twins (96) plus 16 without = 112.
    // Trees: 2 variant archetypes x 8 variants = 16, none of which fade.
    // Objects: the remaining 10 archetypes = 10, with twins for all but `self`/`other`/`marker` = 17.
    // 112 + 16 + 17 = 145.
    //
    // 110 at M3. M4 added `glow` and its twin — the stairwell marker — the *whole* of M4's growth,
    // because the emissive ring is a uniform on an existing material and the three-state fog of war is
    // a per-instance colour, so neither multiplied this table. Click-to-move added `marker`: 113.
    // M5a adds 32: eight barks, eight canopies and sixteen undergrowths.
    const terrain = (BIOME_ARCHETYPES.length - 1) * SECTORS.length;
    const trees = VARIANT_ARCHETYPES.length * TREE_VARIANTS.length;
    const objects = ARCHETYPES.length - BIOME_ARCHETYPES.length - VARIANT_ARCHETYPES.length;
    assert.equal(terrain, 48);
    assert.equal(trees, 16);
    assert.equal(objects, 10);
    assert.equal(MATERIAL_KEYS.length, 145);
    // The `- 3` is `self`, `other` and `marker` — the object archetypes with no faded twin. Literals
    // rather than `NEVER_FADED.size` on purpose, the same reasoning the file header gives for the
    // whole test: recomputing the exclusion from the table under test would let the table widen
    // silently and this assertion would still agree with it.
    assert.equal(MATERIAL_KEYS.length, terrain * 2 + SECTORS.length + trees + objects + (objects - 3));
  });

  it('enumerates without duplicates', () => {
    assert.equal(new Set(MATERIAL_KEYS).size, MATERIAL_KEYS.length);
  });

  it('is closed: every key either constructor can produce is already in the list', () => {
    const known = new Set(MATERIAL_KEYS);
    for (const archetype of ARCHETYPES) {
      if ((VARIANT_ARCHETYPES as readonly string[]).includes(archetype)) continue;
      for (const faded of [false, true]) {
        for (const sector of SECTORS) {
          assert.ok(known.has(materialKey(archetype, sector, faded)), `${archetype}/${sector}/${faded}`);
        }
        assert.ok(known.has(materialKey(archetype, undefined, faded)), `${archetype}/-/${faded}`);
      }
    }
    for (const archetype of VARIANT_ARCHETYPES) {
      for (const variant of TREE_VARIANTS) {
        assert.ok(known.has(treeMaterialKey(archetype, variant)), `${archetype}/${variant}`);
      }
    }
  });

  it('gives every archetype a shape the pool can hold', () => {
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
      // Undergrowth is its own ground, darker. Never equal, or the tufts are invisible.
      assert.notEqual(archetypeColour('grass', sector), archetypeColour('ground', sector));
    }
  });

  it('converts sRGB to the linear space the blend shader mixes in', () => {
    // The three anchors three's own `Color.setHex` agrees on: black, white, and the 0.5 midpoint,
    // which is where a naive `x / 255` would be visibly wrong (0.5 sRGB is 0.214 linear, not 0.5).
    assert.deepEqual(linearRgb(0x000000), [0, 0, 0]);
    const white = linearRgb(0xffffff);
    for (const channel of white) assert.ok(Math.abs(channel - 1) < 1e-6, `white is ${channel}`);
    const mid = linearRgb(0x808080)[0];
    assert.ok(Math.abs(mid - 0.2158) < 0.002, `0x80 linearises to ${mid}`);
  });

  it('sorts every archetype into one of three material families', () => {
    assert.equal(materialFamily('ground'), 'blend');
    assert.equal(materialFamily('canopy'), 'foliage');
    assert.equal(materialFamily('grass'), 'foliage');
    assert.equal(materialFamily('trunk'), 'plain');
    assert.equal(materialFamily('edge'), 'plain');
  });

  it('builds the whole pool in the constructor and never grows it', () => {
    const pool = new ScenePool();
    const start = pool.snapshot();
    // The five built shapes. The forty-eight baked ones arrive through `registerGeometry` at boot —
    // see `trees.ts` for why that does not unbind the key set.
    assert.equal(start.geometries, SHAPE_KEYS.length);
    assert.equal(start.materials, MATERIAL_KEYS.length);
    // 70 window chunks x 9 plain buckets + 35 ground-level cells x 7 scatter wrappers + 2 bodies + 1
    // marker = 878, plus 70 ground wrappers on their own free list = 948. Derived, not chosen — see
    // `pool.ts`. Nine buckets at M3 plus `glow` was ten; ground moving to its own list takes the plain
    // term back to nine and adds the 70 separately.
    assert.equal(WRAPPER_POOL_SIZE, 878);
    assert.equal(start.prewarmed, 948);
    assert.equal(start.blendWrappers, 70);
    assert.equal(start.wrappersCreated, 948, 'both free lists are whole before anything asks');
    assert.equal(start.wrappersFree, 948);
    assert.equal(start.wrappersLive, 0);

    // Ask for every key. Nothing may be constructed by the asking.
    for (const key of MATERIAL_KEYS) assert.ok(pool.material(key));
    for (const key of SHAPE_KEYS) assert.ok(pool.geometry(key));
    const after = pool.snapshot();
    assert.deepEqual(after, start);
    pool.dispose();
  });

  it('costs three programs for 145 materials, plus one for the foliage shadow', () => {
    const pool = new ScenePool();
    const keys = pool.programKeys();
    assert.equal(keys.size, 3, `expected plain/blend/foliage, got ${[...keys].join(', ')}`);
    // The foliage family must be the alpha-clipped, double-sided one, and it must be *one* — every
    // canopy and every tuft shares it, and the eight species differ only in uniforms.
    assert.equal([...keys].filter((key) => key.includes('foliage')).length, 1);
    assert.equal([...keys].filter((key) => key.includes('ground-blend')).length, 1);
    assert.equal([...keys].filter((key) => key.includes('clip')).length, 1, 'only foliage clips');
    // `foliage.ts`'s trap 1: exactly one depth material family, for the canopies and the tufts.
    assert.equal(pool.depthPrograms().size, 1);
    pool.dispose();
  });

  it('recycles wrappers rather than minting them', () => {
    const pool = new ScenePool();
    const minted = pool.snapshot().wrappersCreated;
    const first = pool.acquire('box', 'edge|field');
    const second = pool.acquire('box', 'edge|forest');
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
    const first = pool.acquire('box', 'edge|forest');
    pool.release(first);
    const second = pool.acquire('cone', 'landmark');
    assert.equal(second, first, 'the free list is LIFO, so the same object comes straight back');
    assert.equal(second.geometry, pool.geometry('cone'));
    assert.equal(second.material, pool.material('landmark'));
    assert.equal(second.count, 0);
    pool.dispose();
  });

  it('keeps ground on its own free list, with its own blend buffers', () => {
    const pool = new ScenePool();
    const ground = pool.acquire('box', 'ground|forest');
    // Not the shared box: a blend wrapper owns a `BufferGeometry` view carrying `iBlend`/`iTint`,
    // because three has no per-instance slot beyond `instanceMatrix` and `instanceColor`. See
    // `ScenePool.mintBlend`.
    assert.notEqual(ground.geometry, pool.geometry('box'));
    assert.ok(ground.geometry.getAttribute('iBlend'), 'the ground wrapper has no blend attribute');
    assert.ok(ground.geometry.getAttribute('iTint'), 'the ground wrapper has no tint attribute');
    // …but it shares the box's vertex data, so there is no second copy on the GPU.
    assert.equal(ground.geometry.getAttribute('position'), pool.geometry('box').getAttribute('position'));

    pool.writeBlend(ground, 0, [0.5, 0.5, 0, 0], [0.1, 0.2, 0.3, 0.4]);
    const blend = ground.geometry.getAttribute('iBlend');
    assert.equal(blend.getX(0), 0.5);
    assert.equal(blend.getZ(0), 0);

    // A wall released back never becomes a ground wrapper and vice versa.
    pool.release(ground);
    const wall = pool.acquire('box', 'edge|forest');
    assert.notEqual(wall, ground);
    // …and writing blend data to a wall is a no-op rather than an error.
    pool.writeBlend(wall, 0, [1, 1, 1, 1], [1, 1, 1, 1]);
    pool.release(wall);
    assert.equal(pool.snapshot().wrappersCreated, 948, 'the split lists must not mint');
    pool.dispose();
  });

  it('hands a canopy wrapper its custom depth material, and takes it away again', () => {
    const pool = new ScenePool();
    // `foliage.ts`'s trap 1 wired at the only place it can be: `customDepthMaterial` is a property of
    // the *object*, so a recycled wrapper must be given the right one — and a wrapper that used to be
    // a canopy must lose it, or a wall would cast a needle-shaped shadow.
    const canopy = pool.acquire('box', 'canopy|pine-tall');
    assert.ok(canopy.customDepthMaterial, 'a canopy wrapper has no custom depth material');
    pool.release(canopy);
    const wall = pool.acquire('box', 'edge|forest');
    assert.equal(wall, canopy, 'LIFO: the same object');
    assert.equal(wall.customDepthMaterial, undefined, 'the depth material outlived its canopy');
    pool.dispose();
  });

  it('accepts a baked geometry once and refuses to replace it', () => {
    const pool = new ScenePool();
    const before = pool.snapshot().geometries;
    const key = 'trunk:pine-tall:0';
    assert.equal(pool.hasGeometry(key), false, 'nothing is baked in');
    const box = pool.geometry('box');
    pool.registerGeometry(key, box);
    assert.equal(pool.hasGeometry(key), true);
    assert.equal(pool.snapshot().geometries, before + 1);
    pool.registerGeometry(key, pool.geometry('cone'));
    assert.equal(pool.geometry(key), box, 'a second registration must not swap it under a live wrapper');
    assert.equal(pool.snapshot().geometries, before + 1);
    pool.dispose();
  });
});
