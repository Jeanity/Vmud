/**
 * The glint's buffers, headless — `rain.test.ts` and `snow.test.ts`'s third sibling.
 *
 * The shader cannot be run here and the look cannot be judged here. What *can* be pinned is what the
 * shader depends on and cannot check for itself, and for this field that is more than it was for the
 * weather, because a glint has state the rain does not: an emitter list that is rewritten as loot
 * drops and is read back by the same vertex program every frame in between.
 *
 * So there are three families of assertion here and each corresponds to a line in `glint.ts` that
 * would silently produce a wrong picture rather than an error:
 *
 * 1. **The seed buffer's shape and range** — a speed of zero is a mote frozen at the floor, a phase
 *    outside `[0, 1)` is a mote that appears mid-air on its first frame, and a stride that disagrees
 *    with the attribute's `itemSize` is a fountain made of one mote's data read four ways.
 * 2. **The stratified phase**, which is this field's only real departure from its two siblings. Rain
 *    and snow can afford clumps because nobody can see one flake among nine thousand; an emitter is
 *    twenty-four motes and *is* the visible unit, so a gap in its column is a stutter the eye reads
 *    immediately. The stratification is what makes "no bunching" a fact rather than a probability,
 *    and this file is where the minimum gap is actually measured.
 * 3. **The emitter protocol** — that `update`/`emit`/`commit` fills a prefix, refuses past the cap,
 *    and above all does **nothing at all** when the floor has not changed. That last one is the whole
 *    performance claim of the slice and it is invisible from the outside: a field that re-uploaded
 *    every frame would look identical and cost a buffer upload sixty times a second.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GLINT_CLOCK_SLACK,
  GLINT_JITTER,
  GLINT_LIFE,
  GLINT_LIFE_STRIDE,
  GLINT_MOTES,
  GLINT_ORIGIN_STRIDE,
  GLINT_RISE,
  GLINT_SIZE,
  GLINT_MIN_ANGLE,
  GLINT_SPEED,
  GLINT_STRIDE,
  GlintField,
  MAX_GLINT_EMITTERS,
  glintMotes,
} from './glint.ts';

describe('the glint buffer', () => {
  it('is one vec4 per mote, across every emitter the field is cut for', () => {
    const count = MAX_GLINT_EMITTERS * GLINT_MOTES;
    const seeds = glintMotes(count);
    assert.equal(GLINT_STRIDE, 4);
    assert.equal(count, 3_072);
    assert.equal(seeds.length, count * GLINT_STRIDE);
    assert.equal(seeds.BYTES_PER_ELEMENT, 4);
  });

  it('seeds every mote inside the range the vertex program reads it against', () => {
    const seeds = glintMotes(MAX_GLINT_EMITTERS * GLINT_MOTES);
    for (let i = 0; i < MAX_GLINT_EMITTERS * GLINT_MOTES; i++) {
      const at = i * GLINT_STRIDE;
      const bearing = seeds[at]!;
      const radius = seeds[at + 1]!;
      const phase = seeds[at + 2]!;
      const speed = seeds[at + 3]!;
      // A fraction of a turn — the shader multiplies by TAU, so anything outside this is a second lap.
      assert.ok(bearing >= 0 && bearing < 1, `mote ${i} bears ${bearing}`);
      // The *square* of the radius fraction; the shader takes its square root for a uniform disc, and
      // a negative would be a NaN position that deletes the whole draw.
      assert.ok(radius >= 0 && radius < 1, `mote ${i} sits at r²=${radius}`);
      assert.ok(phase >= 0 && phase < 1, `mote ${i} starts at ${phase} of its climb`);
      // Zero would freeze a mote on the floor for the session; the shader also *divides* the lifetime
      // by this, so zero is an infinity rather than a stillness.
      assert.ok(speed >= GLINT_SPEED.min && speed <= GLINT_SPEED.max, `mote ${i} climbs at ${speed}`);
    }
  });

  it('is deterministic, and different per seed', () => {
    assert.deepEqual(glintMotes(96), glintMotes(96), 'two clients over one sword must agree');
    assert.notDeepEqual(glintMotes(96, GLINT_MOTES, 1), glintMotes(96, GLINT_MOTES, 2));
  });

  it('strata every emitter’s phases so no column ever bunches into a pulse', () => {
    // The claim `GLINT_JITTER` makes, measured. Each mote owns slot `i % GLINT_MOTES` of the loop and
    // jitters inside the middle 0.8 of it, so consecutive phases are never closer than 0.2/24 — 14 ms
    // at `GLINT_LIFE`. An unstratified hash would fail this within the first few emitters.
    const seeds = glintMotes(MAX_GLINT_EMITTERS * GLINT_MOTES);
    const floor = (1 - GLINT_JITTER) / GLINT_MOTES;
    let tightest = Number.POSITIVE_INFINITY;
    for (let emitter = 0; emitter < MAX_GLINT_EMITTERS; emitter++) {
      const phases: number[] = [];
      for (let m = 0; m < GLINT_MOTES; m++) {
        phases.push(seeds[(emitter * GLINT_MOTES + m) * GLINT_STRIDE + 2]!);
      }
      phases.sort((a, b) => a - b);
      // Every slot is occupied exactly once, which is what makes the column even rather than merely
      // spread: a hash could cover the loop and still leave two motes in one eighth of it.
      const slots = new Set(phases.map((phase) => Math.floor(phase * GLINT_MOTES)));
      assert.equal(slots.size, GLINT_MOTES, `emitter ${emitter} filled ${slots.size} of ${GLINT_MOTES} slots`);
      for (let m = 1; m < phases.length; m++) tightest = Math.min(tightest, phases[m]! - phases[m - 1]!);
    }
    assert.ok(tightest >= floor, `two motes were ${tightest} of a loop apart, under the ${floor} floor`);
    // 0.2 / 24 of a 1.7 s loop is 14.2 ms — a sixth of a frame at 60 Hz is not a gap the eye can see,
    // and it is the *worst* case rather than the typical one.
    assert.ok(Math.abs(floor * GLINT_LIFE * 1000 - 14.2) < 0.1, `${floor * GLINT_LIFE * 1000} ms`);
  });

  it('spreads the bearings rather than clustering them on the lattice', () => {
    // `hashCell` is the project's determinism contract and not a PRNG. `rain.test.ts`'s octile count,
    // for the same reason: a hash that correlated on `i` would put every emitter's motes on one side.
    const seeds = glintMotes(2048);
    const buckets = new Array<number>(8).fill(0);
    for (let i = 0; i < 2048; i++) {
      const bucket = Math.min(7, Math.floor(seeds[i * GLINT_STRIDE]! * 8));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const [index, count] of buckets.entries()) {
      assert.ok(count > 180 && count < 330, `octile ${index} holds ${count} of 2048 motes`);
    }
  });
});

describe('the glint field', () => {
  it('is one instanced mesh, additive, that never leaves the frustum and never writes depth', () => {
    const glint = new GlintField(4, 8);
    const geometry = glint.mesh.geometry;
    assert.equal(geometry.getAttribute('aMote').itemSize, GLINT_STRIDE);
    assert.equal(geometry.getAttribute('aMote').count, 32);
    assert.equal(geometry.getAttribute('aOrigin').itemSize, GLINT_ORIGIN_STRIDE);
    assert.equal(geometry.getAttribute('aLife').itemSize, GLINT_LIFE_STRIDE);
    // Four corners and two triangles, instanced: one draw call however many things are on the floor.
    assert.equal(geometry.getAttribute('position').count, 4);
    assert.equal(geometry.getIndex()?.count, 6);
    assert.equal(glint.mesh.frustumCulled, false, 'the real positions are in the shader, not the bounds');
    assert.equal(glint.mesh.castShadow, false);
    assert.equal(glint.mesh.receiveShadow, false);
    assert.equal(glint.mesh.matrixAutoUpdate, false);
    // 12: one past the snow's 11, which is one past the rain's 10.
    assert.equal(glint.mesh.renderOrder, 12);
    const material = glint.mesh.material;
    assert.ok(!Array.isArray(material));
    assert.equal(material.depthWrite, false, 'motes must not occlude each other');
    assert.equal(material.depthTest, true, 'but a wall — or a bone pile — must occlude them');
    assert.equal(material.transparent, true);
    // Additive is what makes a mote read as light rather than as confetti. `snow.ts` blends normally
    // and says why; this is the other answer to the same question.
    assert.equal(material.blending, 2, 'AdditiveBlending');
    // Nothing on the floor until something says so — the empty room draws nothing at all.
    assert.equal(glint.drawn, 0);
    assert.equal(glint.emitters, 0);
    glint.dispose();
  });

  it('costs 110,652 B, allocated once, whatever is lying on the floor', () => {
    // The number the whole cost claim rests on, and the one the ledger deliberately does not carry:
    // this geometry is built here and never registered with `pool.ts`, exactly as the rain's 96 KB and
    // the snow's 288 KB are. 3,072 instances x (4 + 3 + 2) floats x 4 B, plus a 48 B quad and its 12 B
    // index.
    const glint = new GlintField();
    assert.equal(glint.capacity, MAX_GLINT_EMITTERS);
    assert.equal(glint.motesPerEmitter, GLINT_MOTES);
    assert.equal(glint.bytes, 3_072 * 9 * 4 + 48 + 12);
    assert.equal(glint.bytes, 110_652);
    const before = glint.bytes;
    glint.update(1);
    for (let i = 0; i < MAX_GLINT_EMITTERS; i++) glint.emit(i, 0, 0);
    glint.commit();
    assert.equal(glint.bytes, before, 'a full floor reallocated something');
    assert.equal(glint.drawn, MAX_GLINT_EMITTERS * GLINT_MOTES);
    glint.dispose();
  });

  it('fills a prefix, refuses past the cap, and empties when the floor does', () => {
    const glint = new GlintField(3, 4);
    glint.update(10);
    assert.equal(glint.emit(1, 2, 3), true);
    assert.equal(glint.emit(4, 5, 6), true);
    assert.equal(glint.emit(7, 8, 9), true);
    // The fourth thing on a three-emitter floor. Refused, and the caller draws its capsule — see
    // `MAX_GLINT_EMITTERS` for why the fallback is a visible pill rather than nothing at all.
    assert.equal(glint.emit(10, 11, 12), false);
    glint.commit();
    assert.equal(glint.emitters, 3);
    assert.equal(glint.drawn, 12);
    assert.deepEqual(glint.originAt(0), [1, 2, 3]);
    assert.deepEqual(glint.originAt(2), [7, 8, 9]);

    // Everything picked up. `instanceCount` goes to zero and the stale positions stay in the buffer,
    // undrawn — there is nothing to clear and nothing to give back.
    glint.update(11);
    glint.commit();
    assert.equal(glint.emitters, 0);
    assert.equal(glint.drawn, 0);
    assert.deepEqual(glint.originAt(0), [1, 2, 3], 'a released slot should not be scrubbed');
    glint.dispose();
  });

  it('writes an emitter across its whole run, so every mote of it climbs from one place', () => {
    // The replication `emit` does instead of reading `gl_InstanceID`, which is GLSL ES 3.00 only. A
    // partial write is the sort of bug that draws one mote in the right place and twenty-three at the
    // world origin, which reads as a beam rather than as a fountain.
    const glint = new GlintField(2, 6);
    glint.update(0);
    glint.emit(3, 4, 5, 30_000, 60_000);
    glint.commit();
    const origins = glint.mesh.geometry.getAttribute('aOrigin').array as Float32Array;
    const clocks = glint.mesh.geometry.getAttribute('aLife').array as Float32Array;
    for (let m = 0; m < 6; m++) {
      assert.deepEqual([origins[m * 3], origins[m * 3 + 1], origins[m * 3 + 2]], [3, 4, 5], `mote ${m}`);
      assert.deepEqual([clocks[m * 2], clocks[m * 2 + 1]], [30, 60], `mote ${m} clock`);
    }
    glint.dispose();
  });

  it('turns the wire’s pair into a deadline on its own clock, and treats a missing one as “never”', () => {
    const glint = new GlintField(2, 4);
    glint.update(100);
    // Ten minutes of life with the last minute dimming — `ground.GROUND_DECAY_MS` and its warning.
    glint.emit(0, 0, 0, 600_000, 60_000);
    // Neither half: a corpse, or the room's own scatter pickup. `warnSpan` of zero is the shader's
    // "this does not rot", which holds the glint at full strength until `entityLeave` takes it away.
    glint.emit(1, 0, 0);
    // Half a pair is not a pair. The protocol says these travel together; a client that honoured one
    // would fade against a threshold it had invented.
    glint.commit();
    assert.deepEqual(glint.lifeAt(0), [700, 60]);
    assert.deepEqual(glint.lifeAt(1), [0, 0]);

    glint.update(200);
    glint.emit(0, 0, 0, 600_000);
    glint.commit();
    assert.deepEqual(glint.lifeAt(0), [0, 0], 'a lone remainingMs must not invent a threshold');
    glint.dispose();
  });

  it('does nothing at all on a frame whose floor has not changed', () => {
    // **The performance claim of the slice, and it is invisible from the outside.** A field that
    // rewrote its buffers every frame would look identical and cost an upload sixty times a second.
    //
    // `GlintField.uploads` is the counter, and it exists because the alternative cannot be read:
    // `BufferAttribute.needsUpdate` is **write-only** in three (the setter bumps `version`, there is
    // no getter), and `getAttribute` answers a union with `InterleavedBufferAttribute`, which carries
    // no `version` of its own.
    const glint = new GlintField(4, 4);

    glint.update(0);
    glint.emit(1, 0, 1, 600_000, 60_000);
    glint.commit();
    assert.equal(glint.uploads, 1, 'the first frame must upload');

    // A hundred frames of a still floor, with the clock advancing and the item counting down in step —
    // which is `entities.ts`'s local countdown, and the reason the derived deadline is a *constant*.
    for (let f = 1; f <= 100; f++) {
      glint.update(f / 60);
      glint.emit(1, 0, 1, 600_000 - (f / 60) * 1000, 60_000);
      glint.commit();
    }
    assert.equal(glint.uploads, 1, 'a still floor uploaded a hundred times');
    assert.equal(glint.emitters, 1);

    // Move it a millimetre and it uploads again — the compare is exact on position, because an item
    // that moved is an item somewhere else.
    glint.update(2);
    glint.emit(1.001, 0, 1, 600_000 - 2000, 60_000);
    glint.commit();
    assert.equal(glint.uploads, 2);
    glint.dispose();
  });

  it('rewrites the deadline when the server corrects it, and not for float noise', () => {
    // `GLINT_CLOCK_SLACK` from both sides. The tolerance exists to absorb float32 representation at
    // the magnitude of `performance.now() / 1000`; it must not swallow the one real correction the
    // wire sends, which is `advanceGround` latching the warning.
    const glint = new GlintField(2, 4);
    glint.update(0);
    glint.emit(0, 0, 0, 600_000, 60_000);
    glint.commit();
    assert.equal(glint.uploads, 1);

    // Inside the slack: a countdown that lost half a frame. No upload.
    glint.update(1);
    glint.emit(0, 0, 0, 600_000 - 1000 + GLINT_CLOCK_SLACK * 1000 * 0.5, 60_000);
    glint.commit();
    assert.equal(glint.uploads, 1);

    // Outside it: the server says this thing has a minute left, not ten. Uploaded.
    glint.update(2);
    glint.emit(0, 0, 0, 60_000, 60_000);
    glint.commit();
    assert.equal(glint.uploads, 2);
    assert.deepEqual(glint.lifeAt(0), [62, 60]);
    glint.dispose();
  });

  it('advances one uniform a frame, and the toggle is the mesh', () => {
    const glint = new GlintField(2, 4);
    glint.update(12.5);
    assert.equal(glint.material.uniforms['uTime']?.value, 12.5);
    assert.equal(glint.time, 12.5);
    // The four numbers the look is actually made of, pinned so a re-tune moves a documented figure.
    assert.equal(glint.material.uniforms['uRise']?.value, GLINT_RISE);
    assert.equal(glint.material.uniforms['uLife']?.value, GLINT_LIFE);
    assert.equal(glint.material.uniforms['uSize']?.value, GLINT_SIZE);
    assert.equal(glint.material.uniforms['uMinAngle']?.value, GLINT_MIN_ANGLE);
    assert.equal(glint.enabled, true);
    glint.enabled = false;
    assert.equal(glint.mesh.visible, false);
    glint.dispose();
  });

  it('keeps a mote legible at the camera’s working distances', () => {
    // §3's table, as arithmetic rather than as prose. The world size and the angular floor cross at
    // 14.5 m; below it a mote is an object in the world, above it a fixed angular size. Without the
    // floor a mote at the default 36 m pose is 1.5 px on an 800 px viewport and shimmers.
    const half = (distance: number): number => Math.max(GLINT_SIZE, GLINT_MIN_ANGLE * distance) / distance;
    const crossover = GLINT_SIZE / GLINT_MIN_ANGLE;
    assert.ok(Math.abs(crossover - 14.545) < 0.01, `${crossover} m`);
    // 800 px over the camera's 30° field is 26.667 px a degree.
    const pixels = (distance: number): number => ((half(distance) * 180) / Math.PI) * (800 / 30) * 2;
    assert.ok(Math.abs(pixels(3) - 16.3) < 0.1, `${pixels(3)} px at 3 m`);
    assert.ok(Math.abs(pixels(12) - 4.07) < 0.05, `${pixels(12)} px at 12 m`);
    // Flat past the crossover: the mote stops shrinking, and the *plume* keeps shrinking, so a distant
    // glint is a small cluster of legible points rather than a full-size effect or a shimmer.
    assert.ok(Math.abs(pixels(36) - pixels(96)) < 1e-9, 'the angular floor is not flat');
    assert.ok(Math.abs(pixels(36) - 3.36) < 0.05, `${pixels(36)} px at the default pose`);
    // And the unfloored alternative, so the reason is on the record: 1.36 px at 36 m.
    const naive = ((GLINT_SIZE / 36) * (180 / Math.PI)) * (800 / 30) * 2;
    assert.ok(naive < 1.5, `${naive} px without the floor`);
  });
});
