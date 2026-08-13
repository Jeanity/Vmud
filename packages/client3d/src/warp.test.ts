/**
 * **M5c's acceptance: the world bends, and nothing tears.**
 *
 * The design row is one sentence with four conditions welded into it — *"a deterministic seeded
 * low-frequency displacement field over world position, applied to everything visual … so collision
 * honesty survives by construction … amplitude zero for inside and city … bounded gradient so the
 * warp never folds"* — and every one of them is a thing a headless test can check, because the field
 * is arithmetic and the amplitude is arithmetic and the placements are numbers.
 *
 * What is asserted here, in the order it is argued:
 *
 * 1. **Deterministic.** Two constructions of the table agree bit for bit, and so does the field they
 *    drive. A second seed produces a *different* field, which is the assertion that the seed is read
 *    at all rather than decorating a constant.
 * 2. **Bounded.** The Jacobian's spectral norm over a four-kilometre sweep stays under
 *    {@link WARP_GRADIENT_BOUND}, so `p -> p + w(p)` is a contraction and cannot fold.
 * 3. **One field, two languages.** The GLSL is generated from the same table the TypeScript reads, so
 *    the ground (which displaces in a vertex shader) and the wall standing on it (which displaces on
 *    the CPU) cannot disagree. This is `foliage.ts`'s trap 1 in its third costume and it is tested the
 *    same way: identical code, identical inputs — the same uniform *object*, not an equal value.
 * 4. **Square where it must be.** Every roofed, `inside` and `city` room in the built world presents
 *    zero warp across its whole block, and the ramp out of them is continuous.
 * 5. **Invertible in practice, not just in theory.** The pointer's fixed point closes to a
 *    centimetre over a world-wide sample, boundary ramps included.
 * 6. **And it actually winds**, which is the owner's own sentence and the last test in the file.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ShaderLib } from 'three';

import {
  CARDINALS,
  ROOM_TILES,
  cellIndex,
  cellKey,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Room,
  type Zone,
} from '@mygame/shared';

import { createBlendControls, createGroundMapControls, patchGroundBlend } from './blend.ts';
import { planChunk } from './chunkPlan.ts';
import { METRES_PER_TILE, ROOM_METRES, cellOriginTiles, placeFrame } from './frame.ts';
import type { ShaderPatch } from './foliage.ts';
import { ScenePool } from './pool.ts';
import { ARCHETYPE_CASTS, MATERIAL_KEYS, materialFamily, type Archetype } from './prototypes.ts';
import { planWater } from './water.ts';
import {
  SECTOR_WARP,
  WARP_AMPLITUDES,
  WARP_GLSL,
  WARP_GRADIENT_BOUND,
  WARP_IN_SHADER,
  WARP_SEED,
  WARP_TABLE,
  WARP_VERTEX_GLSL,
  WarpField,
  createWarpControls,
  patchWarpVertex,
  roomWarpAmplitude,
  warpFieldOf,
  warpGlsl,
  warpInto,
  warpJacobianNorm,
  warpOf,
  warpPlacementInto,
  warpTable,
  type WarpVec,
} from './warp.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/** The straight east run of road this milestone is judged on. See the last test in the file. */
const TRADE_WAY_ZONE = 15;
const TRADE_WAY_FIRST = 13812;
const TRADE_WAY_LAST = 13821;

/* -------------------------------------------------------------------------- */
/* The field                                                                   */
/* -------------------------------------------------------------------------- */

describe('the domain warp field', () => {
  it('is deterministic: two constructions of one seed are the same field', () => {
    const a = warpTable(WARP_SEED);
    const b = warpTable(WARP_SEED);
    assert.deepEqual(a, b, 'the wave table is not a pure function of the seed');

    const first: WarpVec = { x: 0, z: 0 };
    const second: WarpVec = { x: 0, z: 0 };
    for (let i = 0; i < 4000; i++) {
      const x = ((i * 37) % 811) * 3.13 - 900;
      const z = ((i * 53) % 719) * 4.07 - 900;
      warpInto(first, x, z, a);
      warpInto(second, x, z, b);
      // Bit-for-bit, not within an epsilon: the two are the same arithmetic on the same doubles, and
      // anything less than exact equality here would be a determinism rule with a tolerance in it.
      assert.equal(first.x, second.x, `x differs at ${x},${z}`);
      assert.equal(first.z, second.z, `z differs at ${x},${z}`);
    }
    // …and the convenience form agrees with the hot-path one.
    const single = warpOf(123.5, -456.25);
    warpInto(first, 123.5, -456.25, WARP_TABLE);
    assert.deepEqual(single, first);
  });

  it('reads the seed: a different one bends the world differently', () => {
    const other = warpTable(WARP_SEED ^ 0x1234_5678);
    const mine: WarpVec = { x: 0, z: 0 };
    const theirs: WarpVec = { x: 0, z: 0 };
    let apart = 0;
    for (let i = 0; i < 500; i++) {
      const x = i * 7.7;
      const z = i * -5.3;
      warpInto(mine, x, z, WARP_TABLE);
      warpInto(theirs, x, z, other);
      apart += Math.hypot(mine.x - theirs.x, mine.z - theirs.z);
    }
    assert.ok(apart / 500 > 0.5, `two seeds gave the same field (mean ${(apart / 500).toFixed(3)} m apart)`);
  });

  it('never folds: the Jacobian stays under the bound over four kilometres of world', () => {
    let worstNorm = 0;
    let worstAt = '';
    let maxDisplacement = 0;
    let sumDisplacement = 0;
    let samples = 0;
    const out: WarpVec = { x: 0, z: 0 };
    for (let x = -2000; x <= 2000; x += 2.9) {
      for (let z = -2000; z <= 2000; z += 3.7) {
        const norm = warpJacobianNorm(x, z, WARP_TABLE);
        if (norm > worstNorm) {
          worstNorm = norm;
          worstAt = `${x.toFixed(0)},${z.toFixed(0)}`;
        }
        warpInto(out, x, z, WARP_TABLE);
        const magnitude = Math.hypot(out.x, out.z);
        if (magnitude > maxDisplacement) maxDisplacement = magnitude;
        sumDisplacement += magnitude;
        samples += 1;
      }
    }
    console.log(
      `[M5c field] ${samples.toLocaleString()} samples over 4 km:\n` +
        `  displacement  max ${maxDisplacement.toFixed(3)} m  mean ${(sumDisplacement / samples).toFixed(3)} m` +
        `  (per axis, the octaves sum to ${WARP_AMPLITUDES.reduce((a, b) => a + b, 0).toFixed(2)} m)\n` +
        `  gradient      max ||J|| ${worstNorm.toFixed(4)} at ${worstAt}, bound ${WARP_GRADIENT_BOUND}`,
    );
    assert.ok(
      worstNorm < WARP_GRADIENT_BOUND,
      `||J|| reached ${worstNorm.toFixed(4)} at ${worstAt} — the field can fold`,
    );
    // A contraction is injective, and this is the direct reading of it: no two distinct points can be
    // pushed onto one. Checked along the worst line rather than over the whole plane, because the
    // bound above is the proof and this is the sanity check on the proof.
    const a: WarpVec = { x: 0, z: 0 };
    const b: WarpVec = { x: 0, z: 0 };
    for (let x = -400; x < 400; x += 0.5) {
      warpInto(a, x, 0, WARP_TABLE);
      warpInto(b, x + 0.5, 0, WARP_TABLE);
      assert.ok(x + a.x < x + 0.5 + b.x, `the field folded back on itself at x = ${x}`);
    }
  });

  it('emits its GLSL from the same table it evaluates', () => {
    // Regenerating from a freshly built table must give the identical string: one source of truth,
    // two emissions. This is the test that fails the day somebody hand-edits the shader constant.
    assert.equal(warpGlsl(warpTable(WARP_SEED)), WARP_GLSL);
    for (const octave of [...WARP_TABLE.x, ...WARP_TABLE.z]) {
      assert.ok(
        WARP_GLSL.includes(octave.amplitude.toFixed(9)),
        `octave amplitude ${octave.amplitude} is not in the GLSL`,
      );
      assert.ok(WARP_GLSL.includes(octave.kx.toFixed(9)), `octave kx ${octave.kx} is not in the GLSL`);
    }
    // Nine decimals of a wave number is far beyond a 32-bit float's seven digits, so the GPU and the
    // CPU differ by less than a micron over a kilometre of world.
    assert.ok(WARP_GLSL.includes('vec2 warpField(vec2 p)'));
    assert.equal(WARP_GLSL.split('sin(').length - 1, WARP_TABLE.x.length + WARP_TABLE.z.length);
  });
});

/* -------------------------------------------------------------------------- */
/* The shader                                                                  */
/* -------------------------------------------------------------------------- */

describe('the warp in the shader', () => {
  it('declares what it binds and displaces `transformed`, not the projection', () => {
    const controls = createWarpControls();
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    patchWarpVertex(shader, controls);
    assert.equal(shader.uniforms['uWarp'], controls.uWarp, 'the switch is a copy, so it can drift');
    assert.ok(shader.vertexShader.includes('attribute vec4 iWarp;'));
    assert.ok(shader.vertexShader.includes('vec2 warpField(vec2 p)'));
    // `transformed`, so `<project_vertex>`, `<worldpos_vertex>` and therefore the shadow lookup all
    // see one position. Displacing `mvPosition` would move the pixels and leave the shadow behind.
    assert.ok(shader.vertexShader.includes('transformed.x += warpDelta.x'));
    const begin = shader.vertexShader.indexOf('#include <begin_vertex>');
    const displace = shader.vertexShader.indexOf('transformed.x += warpDelta.x');
    assert.ok(begin > 0 && displace > begin, 'the displacement runs before `transformed` exists');
  });

  it('runs before the ground blend, so the breakup rides the warped ground', () => {
    // The order is a consequence of *when* the patches are applied — each inserts itself immediately
    // after `#include <begin_vertex>`, so the last one applied is the first one that runs — and
    // `pool.ts` therefore applies the warp last. Pinned here because the dependency is invisible at
    // both call sites.
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    patchGroundBlend(shader, createBlendControls(), createGroundMapControls(undefined, null));
    patchWarpVertex(shader, createWarpControls());
    const warp = shader.vertexShader.indexOf('warpDelta');
    const blend = shader.vertexShader.indexOf('vec2 blendUv = position.xz + 0.5;');
    assert.ok(warp > 0 && blend > 0);
    assert.ok(warp < blend, 'the blend reads `transformed` before the warp has moved it');
  });

  it('hands every warped material the same switch, by reference', () => {
    const pool = new ScenePool();
    const shaders: { key: string; patch: ShaderPatch }[] = [];
    for (const key of MATERIAL_KEYS) {
      const material = pool.material(key);
      const patch: ShaderPatch = {
        vertexShader: ShaderLib.lambert.vertexShader,
        fragmentShader: ShaderLib.lambert.fragmentShader,
        uniforms: {},
      };
      material.onBeforeCompile(patch as never, undefined as never);
      if (patch.vertexShader.includes('vec2 warpField(vec2 p)')) shaders.push({ key, patch });
    }
    assert.ok(shaders.length > 30, `only ${shaders.length} materials carry the warp`);
    for (const { key, patch } of shaders) {
      // The same uniform object in every one of them, not an equal value: one switch, so **V** is a
      // single write and no material can be left bent while its neighbour is straight.
      assert.equal(patch.uniforms['uWarp'], pool.warp.uWarp, `${key} holds a second switch`);
      // …and byte-identical code, which here is stronger than `foliage.test.ts`'s slice-and-compare:
      // the field and the displacement are two exported constants and both must appear *verbatim*, so
      // there is nothing for a second copy to be a copy of.
      assert.ok(patch.vertexShader.includes(WARP_GLSL), `${key} injected a different field`);
      assert.ok(patch.vertexShader.includes(WARP_VERTEX_GLSL), `${key} injected a different displacement`);
    }
    // Which families they are: the ground's 48 and the water's one, and nothing else.
    const families = new Set(shaders.map(({ key }) => (key.startsWith('water') ? 'water' : 'blend')));
    assert.deepEqual([...families].sort(), ['blend', 'water']);
    console.log(`[M5c shader] ${shaders.length} materials carry the warp, all on one uWarp object`);
    pool.dispose();
  });

  it('cannot detach a shadow, because nothing that warps in a shader casts one', () => {
    // The depth-parity requirement, discharged rather than duplicated. Every archetype whose vertices
    // the shader moves is a non-caster, and every archetype that *does* cast is displaced by its
    // instance matrix — which three's own `MeshDepthMaterial` reads. So there is exactly one copy of
    // each object's displacement in the whole renderer, and the shadow pass reads the same one the
    // colour pass does. If a future archetype ever joins both sets, this fails.
    for (const archetype of WARP_IN_SHADER) {
      assert.equal(
        ARCHETYPE_CASTS[archetype],
        false,
        `${archetype} warps in the vertex shader *and* casts — its depth material needs the same term`,
      );
    }
    // The other half: the two families that warp in the shader are exactly the two that own the
    // per-instance attribute the shader reads. A third family carrying `WARP_GLSL` with no `iWarp`
    // would read whatever the last tenant left behind.
    for (const archetype of WARP_IN_SHADER) {
      const family = materialFamily(archetype as Archetype);
      assert.ok(family === 'blend' || family === 'water', `${archetype} is family ${family}`);
    }
    const pool = new ScenePool();
    assert.equal(pool.snapshot().depthProgramCount, 2, 'the warp grew a depth program');
    pool.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The world                                                                   */
/* -------------------------------------------------------------------------- */

describe('the warp over the built world', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  /** Every `(zone, level)` the world has, with the frame and the field the renderer would build. */
  function places(): { zone: Zone; level: number; frame: ReturnType<typeof placeFrame>; field: WarpField }[] {
    const out: { zone: Zone; level: number; frame: ReturnType<typeof placeFrame>; field: WarpField }[] = [];
    for (const zone of zones) {
      for (const level of new Set(zone.rooms.map((room) => room.pos.z))) {
        const frame = placeFrame(zone, level);
        out.push({ zone, level, frame, field: warpFieldOf(zone, frame) });
      }
    }
    return out;
  }

  /** Room block centre, in renderer metres, in its own frame. */
  function centreOf(frame: ReturnType<typeof placeFrame>, room: Room): { x: number; z: number } {
    const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
    return {
      x: (origin.tx + ROOM_TILES / 2) * METRES_PER_TILE,
      z: (origin.ty + ROOM_TILES / 2) * METRES_PER_TILE,
    };
  }

  it('presents no warp at all inside, in the city, or under any roof', () => {
    let square = 0;
    let bent = 0;
    let worst = 0;
    let worstRoom = 0;
    const failures: string[] = [];
    for (const { zone, level, frame, field } of places()) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        if (room.pos.z !== level) continue;
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const flat = scene.enclosure.roofed || room.sector === 'city' || room.sector === 'inside';
        if (!flat) {
          bent += 1;
          continue;
        }
        square += 1;
        // The roof rule and the sector table must agree with `describeRoom`'s own answer — the
        // restated `isRoofed` in `warp.ts` is a duplicate and this is what stops it drifting.
        if (scene.enclosure.roofed) {
          assert.equal(roomWarpAmplitude(room), 0, `room ${room.id} is roofed but its amplitude is not 0`);
        }
        // Not just the centre: the whole block, corners included, **plus half a gap past every
        // side** — which is exactly the footprint `planChunk` draws (the slab and its four mouth
        // strips) and exactly the territory `WarpField`'s half-gap lattice offset is there to make
        // one cell. A tear or a tilted threshold would show here and nowhere else.
        const { x, z } = centreOf(frame, room);
        const reach = ROOM_METRES / 2 + frame.gap / 2;
        for (const dz of [-reach, 0, reach]) {
          for (const dx of [-reach, 0, reach]) {
            const amplitude = field.ampAt(x + dx, z + dz, level);
            if (amplitude > worst) {
              worst = amplitude;
              worstRoom = room.id;
            }
            if (amplitude !== 0 && failures.length < 8) {
              failures.push(`room ${room.id} (${room.sector}) at +${dx},${dz}: ${amplitude}`);
            }
          }
        }
      }
    }
    console.log(
      `[M5c square] ${square.toLocaleString()} roofed/city/inside rooms present zero warp across their whole block; ` +
        `${bent.toLocaleString()} landscape rooms bend`,
    );
    assert.equal(worst, 0, `the buildings are not square — worst ${worst} at room ${worstRoom}\n${failures.join('\n')}`);
    assert.ok(square > 20000, `only ${square} square rooms swept`);
    assert.ok(bent > 20000, `only ${bent} bending rooms swept`);
  });

  it('gives the open landscape its full amplitude, and ramps in between', () => {
    // The other side of the zero rule: if `min` over the lattice were too greedy the whole world
    // would be half-straightened, and the warp would be a rumour. Measured on the sectors the design
    // names as full — the fraction at full amplitude is what says the ramp is a *boundary* effect.
    let full = 0;
    let ramped = 0;
    let zero = 0;
    let sum = 0;
    let count = 0;
    for (const { zone, level, frame, field } of places()) {
      for (const room of zone.rooms) {
        if (room.pos.z !== level || SECTOR_WARP[room.sector] !== 1) continue;
        const { x, z } = centreOf(frame, room);
        const amplitude = field.ampAt(x, z, level);
        sum += amplitude;
        count += 1;
        if (amplitude > 0.999) full += 1;
        else if (amplitude > 0.001) ramped += 1;
        else zero += 1;
      }
    }
    console.log(
      `[M5c ramp] landscape room centres: ${full.toLocaleString()} at full amplitude, ` +
        `${ramped.toLocaleString()} on a ramp, ${zero.toLocaleString()} pinned flat by a neighbour; ` +
        `mean ${(sum / count).toFixed(3)}`,
    );
    assert.ok(full / count > 0.5, `only ${((full / count) * 100).toFixed(1)}% of the landscape bends fully`);
    assert.ok(ramped > 1000, `only ${ramped} rooms are on a ramp — the boundary is a cliff, not a ramp`);
  });

  it('agrees with itself across every reciprocal boundary', () => {
    // The property the whole design rests on: the field is keyed on **world position**, so two rooms
    // that share a boundary compute one answer for the ground they share. Checked at the two ends and
    // the middle of every linked cardinal boundary in the world, from each side's own arithmetic.
    let boundaries = 0;
    let worst = 0;
    const here: WarpVec = { x: 0, z: 0 };
    const there: WarpVec = { x: 0, z: 0 };
    for (const { zone, level, frame, field } of places()) {
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        if (room.pos.z !== level) continue;
        for (const dir of CARDINALS) {
          const exit = room.exits[dir];
          if (!exit) continue;
          const far = rooms.get(exit.to);
          if (!far || far.pos.z !== level || cells.get(cellKey(far.pos.x, far.pos.y, level))?.id !== far.id) continue;
          const mine = centreOf(frame, room);
          const theirs = centreOf(frame, far);
          boundaries += 1;
          // The midline between the two blocks, sampled along its whole length.
          const midX = (mine.x + theirs.x) / 2;
          const midZ = (mine.z + theirs.z) / 2;
          const lateral = dir === 'north' || dir === 'south';
          for (const t of [-ROOM_METRES / 2, 0, ROOM_METRES / 2]) {
            const px = lateral ? midX + t : midX;
            const pz = lateral ? midZ : midZ + t;
            // "From both sides" is the two rooms' own levels and the two rooms' own amplitudes: one
            // function of position, asked twice.
            field.displaceInto(here, px, pz, room.pos.z);
            field.displaceInto(there, px, pz, far.pos.z);
            worst = Math.max(worst, Math.hypot(here.x - there.x, here.z - there.z));
          }
        }
      }
    }
    console.log(`[M5c seams] ${boundaries.toLocaleString()} reciprocal boundaries agree, worst disagreement ${worst} m`);
    assert.equal(worst, 0, 'two rooms disagreed about the displacement of the ground they share');
    assert.ok(boundaries > 50000, `only ${boundaries} boundaries swept`);
  });

  it('inverts: a click on the drawn ground finds the tile it came from', () => {
    // The pointer's own step, over the world rather than over a unit square — including the rooms on
    // a sector-boundary ramp, which is where the composed map's Lipschitz constant is worst and where
    // a two-step inversion would quietly leave half a metre on the table.
    let worst = 0;
    let worstAt = '';
    let samples = 0;
    let onRamp = 0;
    let worstRamp = 0;
    const forward: WarpVec = { x: 0, z: 0 };
    const back: WarpVec = { x: 0, z: 0 };
    for (const { zone, level, frame, field } of places()) {
      for (const room of zone.rooms) {
        if (room.pos.z !== level) continue;
        const { x, z } = centreOf(frame, room);
        const offsets: readonly (readonly [number, number])[] = [
          [0, 0],
          [-3.5, -3.5],
          [3.5, 3.5],
          [-3.5, 3.5],
        ];
        for (const [dx, dz] of offsets) {
          const px = x + dx;
          const pz = z + dz;
          const amplitude = field.ampAt(px, pz, level);
          field.displaceInto(forward, px, pz, level);
          field.invertInto(back, px + forward.x, pz + forward.z, level);
          const error = Math.hypot(back.x - px, back.z - pz);
          samples += 1;
          if (amplitude > 0.001 && amplitude < 0.999) {
            onRamp += 1;
            worstRamp = Math.max(worstRamp, error);
          }
          if (error > worst) {
            worst = error;
            worstAt = `zone ${zone.id} room ${room.id}`;
          }
        }
      }
    }
    console.log(
      `[M5c inverse] ${samples.toLocaleString()} round trips over the world: worst ${(worst * 1000).toFixed(2)} mm ` +
        `at ${worstAt}; worst on a sector ramp ${(worstRamp * 1000).toFixed(2)} mm over ${onRamp.toLocaleString()} samples`,
    );
    // A centimetre is a third of a collision tile's width and two orders of magnitude inside one, so
    // the tile a click resolves to is the tile the player aimed at.
    assert.ok(worst < 0.01, `the inverse left ${worst.toFixed(4)} m on the table at ${worstAt}`);
    assert.ok(onRamp > 2000, `only ${onRamp} samples landed on a sector ramp — the hard case is untested`);
  });

  it('keeps every shader-warped surface axis-aligned, which the shader assumes', () => {
    // `WARP_VERTEX_GLSL` divides the world-space delta back through `length(warpModel[n].xyz)`, which
    // is the instance's own scale — exact for a scale-and-translate matrix and wrong for a rotated
    // one. Nothing in the plan rotates a ground slab or a water surface today; this is the assertion
    // that notices the day something does.
    let surfaces = 0;
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        const frame = placeFrame(zone, room.pos.z);
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        const surface = planWater({ scene, origin, elevation: 0, gap: frame.gap });
        const plan = [
          ...planChunk({ scene, origin, elevation: 0, gap: frame.gap, faded: false, doorClosed: {} }),
          ...(surface ? [surface] : []),
        ];
        for (const placement of plan) {
          if (!WARP_IN_SHADER.has(placement.archetype)) continue;
          surfaces += 1;
          assert.equal(placement.rx, 0, `a ${placement.archetype} in room ${room.id} carries an rx`);
          assert.equal(placement.ry, 0, `a ${placement.archetype} in room ${room.id} carries an ry`);
          assert.equal(placement.rz, 0, `a ${placement.archetype} in room ${room.id} carries an rz`);
        }
      }
    }
    // One ground slab a room plus a surface over every wet one. This was `> 100000` while a room drew
    // its slab **and up to four half-gap mouth strips**; closing the voids (2026-08-13) replaced all
    // five with a single slab spanning the block plus half the gap, so the honest floor is one a room.
    assert.ok(surfaces > 46000, `only ${surfaces} shader-warped surfaces swept`);
  });
});

/* -------------------------------------------------------------------------- */
/* Rigid placements                                                            */
/* -------------------------------------------------------------------------- */

describe('the CPU half of the lens', () => {
  const frame = placeFrame(
    {
      id: 1,
      name: 'test',
      rooms: [
        { id: 1, sector: 'road', pos: { x: 0, y: 0, z: 0 }, exits: {} },
        { id: 2, sector: 'road', pos: { x: 1, y: 0, z: 0 }, exits: {} },
        { id: 3, sector: 'road', pos: { x: 0, y: 1, z: 0 }, exits: {} },
        { id: 4, sector: 'road', pos: { x: 1, y: 1, z: 0 }, exits: {} },
      ],
    } as unknown as Zone,
    0,
  );
  const field = new WarpField(
    [
      { id: 1, sector: 'road', pos: { x: 0, y: 0, z: 0 }, exits: {} },
      { id: 2, sector: 'road', pos: { x: 1, y: 0, z: 0 }, exits: {} },
      { id: 3, sector: 'road', pos: { x: 0, y: 1, z: 0 }, exits: {} },
      { id: 4, sector: 'road', pos: { x: 1, y: 1, z: 0 }, exits: {} },
    ] as unknown as Room[],
    frame,
  );
  const scratch: WarpVec = { x: 0, z: 0 };

  const wall = {
    archetype: 'edge' as Archetype,
    geometry: 'box',
    material: 'edge|road',
    x: 10,
    y: 1.5,
    z: 4.5,
    sx: 10.2,
    sy: 3,
    sz: 0.6,
    rx: 0,
    ry: 0,
    rz: 0,
  };

  it('bends a wall into chords that join exactly', () => {
    const out: typeof wall[] = [];
    warpPlacementInto(out, wall, field, 0, scratch);
    assert.ok(out.length >= 4, `a 10.2 m wall became ${out.length} pieces`);
    for (const piece of out) {
      // The cross-section is untouched: a wall follows the ground, it does not get thinner on a bend.
      assert.equal(piece.sz, wall.sz);
      assert.equal(piece.sy, wall.sy);
      assert.equal(piece.y, wall.y);
    }
    // Consecutive pieces share an end. Computed from each piece's own centre, yaw and length, which
    // is exactly what `world3d.ts` writes into the instance matrix — so this is a statement about the
    // drawn geometry rather than about the arithmetic that produced it.
    const endOf = (piece: typeof wall, sign: number): { x: number; z: number } => ({
      x: piece.x + sign * (piece.sx / 2) * Math.cos(piece.ry),
      z: piece.z - sign * (piece.sx / 2) * Math.sin(piece.ry),
    });
    for (let i = 1; i < out.length; i++) {
      const previous = endOf(out[i - 1]!, 1);
      const next = endOf(out[i]!, -1);
      const gap = Math.hypot(previous.x - next.x, previous.z - next.z);
      assert.ok(gap < 1e-9, `pieces ${i - 1} and ${i} are ${gap} m apart`);
    }
    // The whole run still starts and ends where the field says the wall's own ends went.
    const first = endOf(out[0]!, -1);
    field.displaceInto(scratch, wall.x - wall.sx / 2, wall.z, 0);
    assert.ok(Math.abs(first.x - (wall.x - wall.sx / 2 + scratch.x)) < 1e-9);
    assert.ok(Math.abs(first.z - (wall.z + scratch.z)) < 1e-9);
  });

  it('moves a compact object whole, rotation and scale untouched', () => {
    const puddle = { ...wall, archetype: 'puddle' as Archetype, sx: 0.8, sz: 0.5, ry: 1.1 };
    const out: typeof wall[] = [];
    warpPlacementInto(out, puddle, field, 0, scratch);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.ry, 1.1, 'a rotated decal was re-yawed by the chord rule');
    assert.equal(out[0]!.sx, 0.8);
    field.displaceInto(scratch, puddle.x, puddle.z, 0);
    assert.ok(Math.abs(out[0]!.x - (puddle.x + scratch.x)) < 1e-12);
    assert.ok(Math.abs(out[0]!.z - (puddle.z + scratch.z)) < 1e-12);
  });

  it('leaves a ramp alone rather than composing a yaw onto its tilt', () => {
    const ramp = { ...wall, archetype: 'stair' as Archetype, rx: 0.38, sx: 3, sz: 3.2 };
    const out: typeof wall[] = [];
    warpPlacementInto(out, ramp, field, 0, scratch);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.rx, 0.38);
    assert.equal(out[0]!.ry, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The owner's own sentence                                                    */
/* -------------------------------------------------------------------------- */

describe('a winding road actually winds', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);

  /** What a straight grid run of road draws as, once the lens has been applied. */
  interface Wander {
    readonly zone: number;
    readonly first: number;
    readonly last: number;
    readonly rooms: number;
    readonly metres: number;
    /** Range of the drawn centres across the run's own straight axis, in metres. */
    readonly deviation: number;
    /** Change of heading from the straightest leg to the most turned, in degrees. */
    readonly turn: number;
    /** The amplitude at each room centre — where a building has straightened the road, and how much. */
    readonly amplitudes: readonly number[];
  }

  /**
   * Every dead-straight run of linked road rooms in the world, and how far the warp bends each.
   *
   * "Straight" is the strongest form of the owner's complaint: same northing (or easting), one cell
   * apart, each linked to the next, all `road`. Those are the runs that drew as a ruler, and the
   * measurement is the one the design row asks for — *"a chain of east-east-east road rooms draws as
   * a road that drifts and bends"*.
   */
  function wanders(minimum: number): Wander[] {
    const out: Wander[] = [];
    const scratch: WarpVec = { x: 0, z: 0 };
    for (const zone of zones) {
      const cells = cellIndex(zone);
      const byId = new Map(zone.rooms.map((room) => [room.id, room]));
      for (const [axis, step, back] of [
        ['east', { x: 1, y: 0 }, 'west'],
        ['south', { x: 0, y: 1 }, 'north'],
      ] as const) {
        for (const room of zone.rooms) {
          if (room.sector !== 'road') continue;
          const behind = cells.get(cellKey(room.pos.x - step.x, room.pos.y - step.y, room.pos.z));
          if (behind?.sector === 'road' && behind.exits[axis]?.to === room.id) continue;
          const run: Room[] = [room];
          for (;;) {
            const head = run[run.length - 1]!;
            const next = cells.get(cellKey(head.pos.x + step.x, head.pos.y + step.y, head.pos.z));
            if (!next || next.sector !== 'road' || head.exits[axis]?.to !== next.id) break;
            if (next.exits[back]?.to !== head.id) break;
            run.push(next);
          }
          if (run.length < minimum) continue;
          const frame = placeFrame(zone, room.pos.z);
          const field = warpFieldOf(zone, frame);
          const drawn = run.map((step2) => {
            const origin = cellOriginTiles(frame, step2.pos.x, step2.pos.y);
            const x = (origin.tx + ROOM_TILES / 2) * METRES_PER_TILE;
            const z = (origin.ty + ROOM_TILES / 2) * METRES_PER_TILE;
            field.displaceInto(scratch, x, z, room.pos.z);
            return { x: x + scratch.x, z: z + scratch.z, amplitude: field.ampAt(x, z, room.pos.z) };
          });
          // Across the run: the northing of an east run, the easting of a south run.
          const across = drawn.map((point) => (axis === 'east' ? point.z : point.x));
          const legs = drawn
            .slice(1)
            .map((point, i) =>
              axis === 'east'
                ? Math.atan2(point.z - drawn[i]!.z, point.x - drawn[i]!.x)
                : Math.atan2(point.x - drawn[i]!.x, point.z - drawn[i]!.z),
            );
          out.push({
            zone: zone.id,
            first: run[0]!.id,
            last: run[run.length - 1]!.id,
            rooms: run.length,
            metres: (run.length - 1) * frame.stride * METRES_PER_TILE,
            deviation: Math.max(...across) - Math.min(...across),
            turn: (Math.max(...legs) - Math.min(...legs)) * (180 / Math.PI),
            amplitudes: drawn.map((point) => point.amplitude),
          });
          void byId;
        }
      }
    }
    return out;
  }

  it('bends every straight run of open road in the world, and no town lane at all', () => {
    const runs = wanders(6);
    assert.ok(runs.length > 50, `only ${runs.length} straight road runs of six rooms or more`);
    const mean = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0) / values.length;
    // A run through a town is *supposed* to stay straight: its lattice nodes are pinned to zero by
    // the buildings either side of it, which is the design's *"zero for inside/city so buildings stay
    // square"* reaching one cell out into the street. Split before measuring, or the town lanes drag
    // the landscape's average down and hide both halves of the answer.
    const open = runs.filter((run) => mean(run.amplitudes) > 0.5);
    const lanes = runs.filter((run) => mean(run.amplitudes) === 0);
    const sorted = [...open].sort((a, b) => a.deviation - b.deviation);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const best = sorted[sorted.length - 1]!;
    const least = sorted[0]!;
    const meanPerHundred = mean(open.map((run) => (run.deviation / run.metres) * 100));

    const named = runs.find((run) => run.zone === TRADE_WAY_ZONE && run.first === TRADE_WAY_FIRST);
    assert.ok(named, 'the Trade Way run has changed shape — re-find it before quoting it');
    assert.equal(named.last, TRADE_WAY_LAST);
    assert.equal(named.rooms, 10);

    const line = (run: Wander): string =>
      `zone ${run.zone} rooms ${run.first}-${run.last} (${run.rooms} rooms, ${run.metres.toFixed(0)} m): ` +
      `${run.deviation.toFixed(2)} m across, ${run.turn.toFixed(1)} deg of turn`;
    console.log(
      `[M5c winding] ${runs.length} dead-straight road runs of six rooms or more, world-wide: ` +
        `${open.length} in open country, ${lanes.length} town lanes pinned flat by the buildings beside them.\n` +
        `  open road, mean wander ${meanPerHundred.toFixed(2)} m per 100 m of road\n` +
        `  median open run        ${line(median)}\n` +
        `  the most bent          ${line(best)}\n` +
        `  the least bent open    ${line(least)}\n` +
        `  **the Trade Way**      ${line(named)}\n` +
        `    amplitude along it   ${named.amplitudes.map((a) => a.toFixed(2)).join(' ')} ` +
        `(the dip is a building beside the road, straightening it — the design working, not against it)`,
    );

    // A road block is nine metres wide, so a metre of wander per hundred metres is already a road
    // that leaves its own lane; the mean is the number that says this is the world's behaviour and
    // not one lucky run. The ceiling is the other half: past a block per hundred metres the road
    // would stop reading as the road the map drew.
    assert.ok(meanPerHundred > 1, `open road wanders ${meanPerHundred.toFixed(2)} m per 100 m — still a ruler`);
    assert.ok(meanPerHundred < ROOM_METRES, `open road wanders ${meanPerHundred.toFixed(2)} m per 100 m`);
    // Nothing in open country comes through the lens untouched.
    assert.ok(least.deviation > 0.2, `${line(least)} — an open run came through the lens untouched`);
    // …and nothing in a town moves at all. Both halves of the sector rule, in one measurement.
    for (const lane of lanes) assert.equal(lane.deviation, 0, `${line(lane)} — a town lane bent`);
    assert.ok(lanes.length > 0, 'no town lane in the world is walled in on both sides — check the split');
    // And the named one, which is where the owner will stand.
    assert.ok(named.deviation > ROOM_METRES / 5, `the Trade Way wandered only ${named.deviation.toFixed(2)} m`);
    assert.ok(named.turn > 5, `the Trade Way's heading changed by ${named.turn.toFixed(1)} degrees`);
  });
});
