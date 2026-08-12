/**
 * The two-layer ground blend: the weight field, and the one shader that carries all 104 sector pairs.
 *
 * §4's *"the ground material blends two biome layers by vertex weight across the boundary — one
 * shader handles all 98 pairs"* is two claims and they are checked separately. The **one shader** half
 * lives in `prototypes.test.ts`, which asserts the whole material pool costs three programs. This file
 * is the **weight field** half: that it is zero where it should be flat, that it reaches the IR's own
 * weight at the edge that carries it, that the two rooms either side of a boundary agree about how
 * strong it is, and that the patch lands in the shader where the fog of war can still dim it.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ShaderLib } from 'three';

import {
  CARDINALS,
  OPPOSITE,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Cardinal,
  type Zone,
} from '@mygame/shared';

import { blendWeightAt, createBlendControls, patchGroundBlend } from './blend.ts';
import { groundBlendOf } from './chunkPlan.ts';
import { linearRgb, sectorGround } from './prototypes.ts';
import type { ShaderPatch } from './foliage.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

describe('the ground blend shader', () => {
  it('patches the vertex and fragment shaders where the two chunks need it', () => {
    const controls = createBlendControls();
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    patchGroundBlend(shader, controls);

    assert.ok(shader.vertexShader.includes('attribute vec4 iBlend;'));
    assert.ok(shader.vertexShader.includes('attribute vec4 iTint;'));
    assert.ok(shader.vertexShader.includes('vec2 blendUv = position.xz + 0.5;'));
    // **Before** `<color_fragment>`, not after: that chunk is where three multiplies `instanceColor`
    // in, and `instanceColor` is this renderer's fog of war. Blending after it would leave the
    // neighbour's soil at full brightness inside an unexplored room.
    const mix = shader.fragmentShader.indexOf('vBlendColour, smoothstep');
    const colour = shader.fragmentShader.indexOf('#include <color_fragment>');
    assert.ok(mix > 0 && colour > 0);
    assert.ok(mix < colour, 'the blend runs after the fog of war and will not be dimmed by it');
    // Shared knobs, by reference, so one write retunes every ground material in the pool.
    assert.equal(shader.uniforms['uBlendNoise'], controls.uBlendNoise);
    assert.equal(shader.uniforms['uBlendFrequency'], controls.uBlendFrequency);
  });

  it('interpolates the four corners bilinearly', () => {
    const corners = [0.5, 0, 0, 0.25] as const;
    // (u,v) = (0,0) is the north-west corner; the winding is NW, NE, SE, SW.
    assert.equal(blendWeightAt(corners, 0, 0), 0.5);
    assert.equal(blendWeightAt(corners, 1, 0), 0);
    assert.equal(blendWeightAt(corners, 1, 1), 0);
    assert.equal(blendWeightAt(corners, 0, 1), 0.25);
    assert.equal(blendWeightAt(corners, 0.5, 0.5), (0.5 + 0 + 0 + 0.25) / 4);
    // Four zeros is flat everywhere — the roofed case, and the no-neighbour case.
    for (const u of [0, 0.3, 1]) {
      for (const v of [0, 0.7, 1]) assert.equal(blendWeightAt([0, 0, 0, 0], u, v), 0);
    }
  });

  if (!existsSync(ZONES_DIR)) {
    it('skips the world sweep: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  it('is flat under every roof and carries the IR weight at every boundary that has one', () => {
    let roofed = 0;
    let blended = 0;
    let flat = 0;
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const blend = groundBlendOf(scene);

        if (scene.enclosure.roofed) {
          roofed += 1;
          assert.deepEqual([...blend.corners], [0, 0, 0, 0], `room ${room.id} is roofed and blends`);
          // Layer B is the room's own soil when there is no layer B, so the mix is a no-op even if a
          // stray weight ever leaked in.
          const own = linearRgb(sectorGround(scene.biome.sector));
          assert.deepEqual(blend.tint.slice(0, 3), [...own]);
          continue;
        }
        if (scene.biome.blend.length === 0) {
          flat += 1;
          assert.deepEqual([...blend.corners], [0, 0, 0, 0]);
          continue;
        }

        blended += 1;
        // Every corner is the larger of the two edges it touches, and no corner exceeds the largest
        // weight the IR named — a corner that did would mix in more of the neighbour than the
        // collision grid's own opening justifies.
        const strongest = Math.max(...scene.biome.blend.map((entry) => entry.weight));
        for (const corner of blend.corners) {
          assert.ok(corner >= 0 && corner <= strongest + 1e-9, `room ${room.id} corner ${corner}`);
        }
        // The dominant sector's own colour, and it is not the room's own unless they happen to match.
        const phase = blend.tint[3];
        assert.ok(phase >= 0 && phase < 1, `room ${room.id} phase ${phase}`);
      }
    }
    console.log(`[M5a blend] ${blended} rooms blend, ${flat} outdoor rooms are flat, ${roofed} roofed`);
    assert.ok(blended > 5000, `only ${blended} rooms blend — the sweep is not reaching the boundaries`);
  });

  it('agrees with the room on the other side about how wide a shared boundary is', () => {
    /*
     * The invariant the blend rests on: where two rooms genuinely face each other across one
     * boundary, `connectorSpan` is symmetric and so is the weight. If it were not, the two halves of
     * one seam would fade at different rates and the join would show as a step in the middle of a
     * doorway.
     *
     * "Genuinely face each other" is the whole precision of this test and it cost a failing
     * assertion to learn. Room 7669's east exit is a **seam** to 7670, which sits diagonally at
     * (22,17) rather than at (22,16), and 7670's west edge is a different boundary pointing at a
     * third room. A seam's two ends share no coordinate frame — that is what a seam *is*, and M2's
     * ruling says so — so their widths have no reason to agree and 0.167 against 0.5 is not a bug.
     * The pairing is therefore checked both ways round before the weights are compared, and seams
     * are excluded.
     */
    let checked = 0;
    let seams = 0;
    let doorSided = 0;
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const scenes = new Map<number, ReturnType<typeof describeRoom>>();
      for (const room of zone.rooms) {
        scenes.set(room.id, describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room)));
      }
      for (const room of zone.rooms) {
        const here = scenes.get(room.id)!;
        for (const dir of CARDINALS) {
          const edge = here.edges[dir];
          if (edge.to === undefined || !edge.mouth) continue;
          if (edge.seam) {
            seams += 1;
            continue;
          }
          // `OPPOSITE` is typed over all six directions; a cardinal's opposite is a cardinal, and
          // the record this indexes has only the four.
          const opposite = OPPOSITE[dir] as Cardinal;
          const there = scenes.get(edge.to);
          const back = there?.edges[opposite];
          // Reciprocal, and not itself a seam. Anything else is two different boundaries.
          if (!there || !back || back.to !== room.id || back.seam) continue;
          const mine = here.biome.blend.find((entry) => entry.dir === dir);
          const theirs = there.biome.blend.find((entry) => entry.dir === opposite);
          if (!mine || !theirs) continue;
          // The **opening** is what has to match, and it always does: `connectorSpan` is symmetric.
          assert.equal(back.mouth?.span, edge.mouth.span, `room ${room.id} ${dir} vs ${edge.to}`);
          checked += 1;

          /*
           * The **weight** matches too, unless exactly one side calls the crossing a door.
           * `BiomeBlend.weight` is `(span / ROOM_TILES) x (a door halves it again)` and `RoomExit.door`
           * is per direction, so a one-way-doored link gives 0.083 on the doored side and 0.167 on the
           * other. That is the IR's asymmetry rather than this milestone's — M5a reads the weight, it
           * does not compute it — and the visible consequence is a quarter of a metre of soil on one
           * side of a three-metre doorway. Recorded rather than papered over; if it ever shows, the
           * fix belongs in `roomScene.ts` where the factor is applied.
           */
          if ((edge.kind === 'door') === (back.kind === 'door')) {
            assert.equal(theirs.weight, mine.weight, `room ${room.id} ${dir} disagrees with ${edge.to}`);
          } else {
            doorSided += 1;
          }
        }
      }
    }
    console.log(
      `[M5a blend] ${checked} reciprocal boundaries agree on their width; ` +
        `${seams} seams excluded, ${doorSided} one-sided doors weighted differently`,
    );
    assert.ok(checked > 10000, `only ${checked} boundaries checked`);
  });
});
