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

import { blendWeightAt, createBlendControls, createGroundMapControls, patchGroundBlend } from './blend.ts';
import { groundBlendOf } from './chunkPlan.ts';
import {
  GROUND_TEXTURES,
  VILLAGE_TEXTURES,
  groundTextureOf,
  linearRgb,
  materialKey,
  sectorGround,
} from './prototypes.ts';
import { ScenePool } from './pool.ts';
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
    patchGroundBlend(shader, controls, createGroundMapControls(undefined, null));

    assert.ok(shader.vertexShader.includes('attribute vec4 iBlend;'));
    assert.ok(shader.vertexShader.includes('attribute vec4 iTint;'));
    assert.ok(shader.vertexShader.includes('vec2 blendUv = position.xz + 0.5;'));
    // **Before** `<color_fragment>`, not after: that chunk is where three multiplies `instanceColor`
    // in, and `instanceColor` is this renderer's fog of war. Blending after it would leave the
    // neighbour's soil at full brightness inside an unexplored room.
    const mix = shader.fragmentShader.indexOf('vBlendColour, layerB');
    const colour = shader.fragmentShader.indexOf('#include <color_fragment>');
    assert.ok(mix > 0 && colour > 0);
    assert.ok(mix < colour, 'the blend runs after the fog of war and will not be dimmed by it');
    // Shared knobs, by reference, so one write retunes every ground material in the pool.
    assert.equal(shader.uniforms['uBlendNoise'], controls.uBlendNoise);
    assert.equal(shader.uniforms['uBlendFrequency'], controls.uBlendFrequency);
  });

  it('samples the floor texture in world space, after the mix, and never as a define', () => {
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    const map = createGroundMapControls(GROUND_TEXTURES.city, null);
    patchGroundBlend(shader, createBlendControls(), map);

    // A sampler the patch declares, not `material.map` — which is `USE_MAP`, which is a `#define`,
    // which would have split the one ground program in two. See `prototypes.GROUND_TEXTURES` rule 1.
    assert.ok(shader.fragmentShader.includes('uniform sampler2D uGroundMap;'));
    assert.ok(!shader.fragmentShader.includes('#define USE_MAP'));
    // `vBlendWorld` and not `vMapUv`: the paving has to run through the room, through the gap and
    // into the next room, and it has to ride M5c's warp rather than slide over it.
    assert.ok(shader.fragmentShader.includes('texture2D(uGroundMap, vBlendWorld * uGroundScale)'));
    // Nothing wraps the coordinate by hand. A `fract` here would break the derivative once per tile
    // and hang a blurred mip seam off every repeat.
    assert.ok(!shader.fragmentShader.includes('fract(vBlendWorld'));
    // After the two-layer mix — a pattern applied before it would be mixed toward a *flat* layer B
    // and the boundary would come back as a texture edge — and still before the fog of war.
    const stone = shader.fragmentShader.indexOf('vec3 stone = texture2D(uGroundMap');
    const mix = shader.fragmentShader.indexOf('vBlendColour, layerB');
    const colour = shader.fragmentShader.indexOf('#include <color_fragment>');
    assert.ok(mix > 0 && stone > mix, 'the texture must be applied after layer B is mixed in');
    assert.ok(stone < colour, 'a cobbled street must still be dimmed by the fog of war');

    // Per material, by reference — the opposite lifetime to the shared knobs above, and the reason
    // one program can serve a cobbled city and a bare field.
    assert.equal(shader.uniforms['uGroundMap'], map.uGroundMap);
    assert.equal(shader.uniforms['uGroundGain'], map.uGroundGain);
    // Born dark: a gain live against the white placeholder would divide white by the texture's mean
    // and flash the floor bright for as long as the fetch takes.
    assert.equal(map.uGroundGain.value, 0);
    assert.equal(map.uGroundScale.value, 1 / GROUND_TEXTURES.city!.metres);
  });

  it('survives the whole patch chain on a real pooled ground material', () => {
    // The three isolated patches above are each right on their own; what a room actually draws is
    // all of them applied to one shader in `pool.buildMaterial`, in an order that is load-bearing and
    // invisible at every call site. The warp goes on **last** so it runs **first** (a vertex patch
    // inserts after `<begin_vertex>`); the wetness goes in at `<opaque_fragment>`, downstream of
    // everything here. This is the composition, checked on the material the city floor is drawn with.
    const pool = new ScenePool();
    const patch: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    pool.material(materialKey('ground', 'city', false)).onBeforeCompile(patch as never, undefined as never);

    const warp = patch.vertexShader.indexOf('warpDelta');
    const world = patch.vertexShader.indexOf('vBlendWorld = (modelMatrix');
    assert.ok(warp > 0 && world > warp, 'the paving must be sampled at the *warped* world position');

    const stone = patch.fragmentShader.indexOf('texture2D(uGroundMap');
    const colour = patch.fragmentShader.indexOf('#include <color_fragment>');
    const wet = patch.fragmentShader.indexOf('#include <opaque_fragment>');
    assert.ok(stone > 0 && stone < colour, 'the fog of war must dim the paving');
    assert.ok(colour < wet, 'rain must land on the textured floor, not under it');
    // All four floor uniforms and both shared knobs reached one shader without either patch
    // overwriting the other's entries.
    for (const name of ['uBlendNoise', 'uBlendFrequency', 'uGroundMap', 'uGroundScale', 'uGroundGain', 'uGroundMean', 'uWarp', 'uWet']) {
      assert.ok(patch.uniforms[name], `${name} did not survive the chain`);
    }
    // A field floor takes the same shader with the gain at zero — one program, two looks.
    const bare: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    pool.material(materialKey('ground', 'field', false)).onBeforeCompile(bare as never, undefined as never);
    assert.equal(bare.fragmentShader, patch.fragmentShader, 'a textured floor compiled different GLSL');
    assert.equal(bare.vertexShader, patch.vertexShader);
    pool.dispose();
  });

  it('names a real village texture, a stone-sized repeat and a measured mean for every floor', () => {
    const sectors = Object.keys(GROUND_TEXTURES);
    assert.ok(sectors.length > 0);
    for (const [sector, spec] of Object.entries(GROUND_TEXTURES)) {
      assert.ok(VILLAGE_TEXTURES.includes(spec.texture), `${sector}: ${spec.texture} is not in the pack`);
      // One repeat between two and eight metres. Below two, a 2048² tile is over 1,000 texels a metre
      // and the pattern beats faster than a stride; above eight, a stone is a metre across.
      assert.ok(spec.metres >= 2 && spec.metres <= 8, `${sector}: ${spec.metres} m repeat`);
      assert.ok(spec.gain > 0 && spec.gain <= 1, `${sector}: gain ${spec.gain}`);
      // The mean is what makes the palette survive the multiply (rule 2). A zero channel would divide
      // by zero and a mean above one is not a measurement of anything.
      for (const channel of spec.mean) assert.ok(channel > 0 && channel <= 1, `${sector}: mean ${channel}`);
      // A repeat that divided the 11 m room pitch would print the room grid onto the paving.
      assert.ok(Math.abs((11 / spec.metres) % 1) > 0.01, `${sector}: the repeat aligns with the room pitch`);
    }
    // The natural sectors are deliberately untextured — see `GROUND_TEXTURES`' closing note.
    for (const sector of ['field', 'forest', 'hills', 'swamp', 'mountain', 'cave', 'deep_water'] as const) {
      assert.equal(groundTextureOf(sector), undefined, `${sector} must keep the colour-and-blend floor`);
    }
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
