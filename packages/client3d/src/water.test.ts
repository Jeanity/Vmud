/**
 * The water surface's invariants, swept over the built world rather than over a fixture.
 *
 * §4's verification method, again: *"do **not** use snapshot tests over a fixed room sample… Assert
 * invariants over **all** rooms."* For water the invariants that matter are the ones that say it is a
 * *surface over a lake* rather than a blue plane somebody parked:
 *
 * - it exists exactly where the IR says the sector is wet, and nowhere else;
 * - it is above the room's own ground and below anything a player could bump their head on;
 * - it tiles with its neighbours — the quad is the room block plus the gap, so two adjacent water
 *   rooms meet without overlapping (nothing to z-fight) and without a gap (nothing to see through);
 * - it foams **only** where there is land on the other side, which is the whole difference between a
 *   shoreline and a white border round every room.
 *
 * Plus the shader-structure half, which is the only thing a headless test can say about GLSL: the
 * patch reaches the three chunks it must reach, and the specular is added where a Lambert's
 * `outgoingLight` actually exists rather than to a `reflectedLight.directSpecular` that a Lambert
 * never reads.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ShaderLib } from 'three';

import {
  CARDINALS,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Zone,
} from '@mygame/shared';

import { createWindClock, type ShaderPatch } from './foliage.ts';
import { ROOM_METRES, cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import {
  WATER_DEPTH,
  createWaterControls,
  isWater,
  patchWater,
  planWater,
  waterFoamOf,
} from './water.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

describe('the water shader', () => {
  it('patches the three chunks it needs and puts the lobe where outgoingLight exists', () => {
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    const clock = createWindClock();
    const controls = createWaterControls();
    patchWater(shader, clock, controls);

    // The corner attribute the foam is interpolated from, and the world position the waves are
    // sampled at — both in the vertex shader, both after `<begin_vertex>` so `transformed` exists.
    assert.ok(shader.vertexShader.includes('attribute vec4 iBlend;'));
    assert.ok(shader.vertexShader.includes('vShore = mix('));
    assert.ok(shader.vertexShader.indexOf('vWorldXZ =') > shader.vertexShader.indexOf('#include <begin_vertex>'));

    // **The specular must land before `<opaque_fragment>`.** A Lambert's `outgoingLight` is
    // `directDiffuse + indirectDiffuse + emissive` and is assembled four lines above that include —
    // so a term added at `<lights_fragment_end>` would not compile, and one added to
    // `reflectedLight.directSpecular` would compile and be discarded. Both were tried.
    const specular = shader.fragmentShader.indexOf('outgoingLight += directionalLights[0].color * lobe');
    const opaque = shader.fragmentShader.indexOf('#include <opaque_fragment>');
    const lightsEnd = shader.fragmentShader.indexOf('#include <lights_fragment_end>');
    assert.ok(specular > lightsEnd, 'the lobe is computed before the lighting is finished');
    assert.ok(specular < opaque, 'the lobe is computed after gl_FragColor is written');
    assert.ok(!shader.fragmentShader.includes('reflectedLight.directSpecular'), 'a Lambert never reads that');

    // The depth fade goes in before `<color_fragment>`, so the fog-of-war instance colour dims the
    // finished answer rather than half of it — `blend.ts`'s argument, restated for the surface.
    assert.ok(
      shader.fragmentShader.indexOf('uDeepColour, depth') < shader.fragmentShader.indexOf('#include <color_fragment>'),
    );

    // One clock. The lake's waves and the canopy's sway are the same `uTime`, shared by reference.
    assert.equal(shader.uniforms['uTime'], clock.uTime);
    assert.equal(shader.uniforms['uFoamWidth'], controls.uFoamWidth);
  });

  it('knows which sectors are wet, and gives each one a depth a body can read', () => {
    assert.ok(isWater('shallow_water'));
    assert.ok(isWater('deep_water'));
    assert.ok(isWater('underwater'));
    assert.ok(!isWater('swamp'), 'a bog is wet ground, not a water surface');
    assert.ok(!isWater('field'));
    // Shin, chest, and a lid overhead. The 1.8 m capsule is what these are read against.
    assert.ok((WATER_DEPTH.shallow_water ?? 0) < 0.6);
    assert.ok((WATER_DEPTH.deep_water ?? 0) > 1 && (WATER_DEPTH.deep_water ?? 0) < 1.8);
    assert.ok((WATER_DEPTH.underwater ?? 0) > 2);
  });
});

describe('the water surface over the built world', () => {
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

  it('puts one surface over every wet room, none over a dry one, and foams only at a shore', () => {
    let wet = 0;
    let dry = 0;
    let foaming = 0;
    let open = 0;
    const bySector = new Map<string, number>();
    const problems: string[] = [];
    const examples: string[] = [];

    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const frames = new Map<number, ReturnType<typeof placeFrame>>();
      for (const room of zone.rooms) {
        let frame = frames.get(room.pos.z);
        if (!frame) {
          frame = placeFrame(zone, room.pos.z);
          frames.set(room.pos.z, frame);
        }
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        const surface = planWater({ scene, origin, elevation: 0, gap: frame.gap });

        if (!isWater(scene.biome.sector)) {
          dry += 1;
          if (surface && problems.length < 8) problems.push(`room ${room.id}: ${scene.biome.sector} grew water`);
          continue;
        }
        wet += 1;
        bySector.set(scene.biome.sector, (bySector.get(scene.biome.sector) ?? 0) + 1);
        if (!surface) {
          if (problems.length < 8) problems.push(`room ${room.id}: ${scene.biome.sector} grew no surface`);
          continue;
        }

        // Above the ground it covers, and by the sector's own depth.
        assert.equal(surface.y, WATER_DEPTH[scene.biome.sector], `room ${room.id} surface height`);
        assert.ok(surface.y > 0, `room ${room.id}: the surface is at or below the bed`);
        // The block plus the gap, so two adjacent water rooms tile exactly. Not a metre more: an
        // overlap is a z-fight and a shortfall is a strip of dry ground in the middle of a lake.
        assert.equal(surface.sx, ROOM_METRES + frame.gap, `room ${room.id} surface width`);
        assert.equal(surface.sz, surface.sx);
        // Centred on the block, like the ground slab it floats over.
        assert.ok(Math.abs(surface.x - (metresOfTile(origin.tx) + ROOM_METRES / 2)) < 1e-9);
        assert.equal(surface.archetype, 'water');
        assert.equal(surface.geometry, 'waterPlane');
        // The depth and the phase travel in `iTint`; the foam in `iBlend`.
        assert.equal(surface.tint?.[0], WATER_DEPTH[scene.biome.sector]);
        assert.ok((surface.tint?.[1] ?? -1) >= 0 && (surface.tint?.[1] ?? 1) < 1, 'the wave phase is not in [0,1)');

        const foam = waterFoamOf(scene);
        assert.deepEqual(surface.blend, foam.corners);
        for (const corner of foam.corners) {
          assert.ok(corner >= 0 && corner <= 1, `room ${room.id} corner weight ${corner}`);
        }
        // **The invariant that makes it a shoreline.** A side may only foam if the far side is not
        // water: either there is no crossing at all (`edge`/`barrier`), or the neighbour's ground is
        // land. A water-to-water crossing must be silent, or every lake is a grid of white lines.
        for (const dir of CARDINALS) {
          const weight = foam.edges[dir] ?? 0;
          if (weight === 0) continue;
          const edge = scene.edges[dir];
          const hard = edge.kind === 'edge' || edge.kind === 'barrier';
          const blend = scene.biome.blend.find((entry) => entry.dir === dir);
          const land = blend ? !isWater(blend.sector) : edge.sector !== undefined && !isWater(edge.sector);
          if (!hard && !land && problems.length < 8) {
            problems.push(`room ${room.id}: foam on ${dir} with water across it`);
          }
        }
        const shores = CARDINALS.filter((dir) => (foam.edges[dir] ?? 0) > 0).length;
        if (shores > 0) foaming += 1;
        else open += 1;
        if (shores === 0 && examples.length < 3) examples.push(`open water: room ${room.id} of zone ${zone.id}`);
      }
    }

    console.log(
      `[M5b water] ${wet} wet rooms of ${wet + dry} (${[...bySector].sort().map(([s, n]) => `${s} ${n}`).join(', ')}); ` +
        `${foaming} have a shore, ${open} are open water\n  ${examples.join('\n  ')}`,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(wet > 100, `only ${wet} wet rooms in the world — the sweep is not reaching the water`);
    assert.ok(foaming > 50, `only ${foaming} shorelines`);
    // Some water must be *open*, or the foam term is a border rather than a shore.
    assert.ok(open > 0, 'every wet room in the world foams on some side — that is a border, not a shore');
  });

  it('agrees with the room across a crossable edge about whether there is a shore between them', () => {
    /*
     * The reciprocal check `blend.test.ts` makes for the ground, made for the foam: a *crossable*
     * boundary that foams must have land on the other side of it.
     *
     * **Crossable, and the exclusion is the finding.** `edge` and `barrier` foam unconditionally, and
     * they are right to: a barrier is a wall the player cannot pass, and water lapping a wall breaks
     * on it whatever is behind. Measured in the built world, room 16134 in zone 13 is exactly that —
     * it foams south against a barrier whose far side is `deep_water`, which is a bank between two
     * stretches of lake and not a contradiction. The first version of this test asserted over all
     * four sides and found it; the rule it was really testing is about crossings.
     */
    let checked = 0;
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const scenes = new Map<number, ReturnType<typeof describeRoom>>();
      const describe1 = (id: number): ReturnType<typeof describeRoom> | undefined => {
        const held = scenes.get(id);
        if (held) return held;
        const room = rooms.get(id);
        if (!room) return undefined;
        const built = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        scenes.set(id, built);
        return built;
      };
      for (const room of zone.rooms) {
        const scene = describe1(room.id);
        if (!scene || !isWater(scene.biome.sector)) continue;
        const foam = waterFoamOf(scene);
        for (const dir of CARDINALS) {
          if ((foam.edges[dir] ?? 0) === 0) continue;
          const edge = scene.edges[dir];
          if (edge.kind === 'edge' || edge.kind === 'barrier') continue;
          const across = edge.to;
          if (across === undefined) continue;
          const other = describe1(across);
          if (!other) continue;
          assert.ok(
            !isWater(other.biome.sector),
            `room ${room.id} foams ${dir} at room ${across}, which is ${other.biome.sector}`,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked > 20, `only ${checked} reciprocal shorelines checked`);
  });
});
