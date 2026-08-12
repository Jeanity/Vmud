/**
 * The wet response: one uniform, three surfaces, and a ramp with two different speeds.
 *
 * §5's warning is what this file is here to keep true: *"a roughness drop alone renders as 'slightly
 * darker', not 'wet'. You need a streaked specular response and instanced puddle decals … or the rain
 * will read as animated fog over dry ground within one second."* So the assertions are about the
 * three parts existing and reaching the same uniform object, not about a picture — the picture is the
 * owner's to judge with **R** held down.
 *
 * The placement half is swept over the built world like everything else in this package: a puddle
 * lands only on hard ground, only under open sky, and never where a player arrives or walks.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ShaderLib } from 'three';

import {
  ROOM_TILES,
  cellIndex,
  describeRoom,
  featureFootprint,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  walkableRequired,
  type Zone,
} from '@mygame/shared';

import { createWindClock, type ShaderPatch } from './foliage.ts';
import { cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import { ScenePool } from './pool.ts';
import { kitMaterialKey, materialKey } from './prototypes.ts';
import { freeTiles } from './scatter.ts';
import {
  PUDDLES_BY_SECTOR,
  PUDDLES_PER_ROOM_MAX,
  WET_DRY_SECONDS,
  WET_RISE_SECONDS,
  Wetness,
  createPuddleMaterial,
  createWetControls,
  patchWetGround,
  planPuddles,
} from './wetness.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

describe('the wetness ramp', () => {
  it('soaks fast and dries slow, and never leaves 0..1', () => {
    // "While *and shortly after* it rains" is the brief's phrase and these two numbers are what it
    // means: a street that dried as fast as it soaked would be dry before the player looked down.
    assert.ok(WET_DRY_SECONDS > WET_RISE_SECONDS * 4);
    const wet = new Wetness();
    assert.equal(wet.value, 0);
    let t = 0;
    for (let i = 0; i < 400; i++) wet.update((t += 0.05), true);
    assert.equal(wet.value, 1, `${WET_RISE_SECONDS}s of rain did not soak the ground`);
    for (let i = 0; i < 40; i++) wet.update((t += 0.05), false);
    assert.ok(wet.value > 0.9, 'two seconds after the rain stops the street is still wet');
    for (let i = 0; i < 2000; i++) wet.update((t += 0.05), false);
    assert.equal(wet.value, 0);
  });

  it('clamps a slept tab rather than soaking the world in one step', () => {
    // `main.ts` clamps the frame delta for the predictor's sake; this clamps its own for the ramp's.
    // A tab that was in the background for a minute must not arrive fully wet in one frame, because
    // the whole point of a ramp is that it is seen.
    const wet = new Wetness();
    wet.update(0, true);
    wet.update(60, true);
    assert.ok(wet.value < 0.1, `one 60-second step soaked the world to ${wet.value}`);
  });
});

describe('the wet ground shader', () => {
  it('darkens, streaks, and adds its lobe where a Lambert can see it', () => {
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    const controls = createWetControls();
    patchWetGround(shader, controls);

    // All three of §5's parts. The darkening alone is the failure it warns about.
    assert.ok(shader.fragmentShader.includes('outgoingLight *= mix(1.0, uWetDarken, film)'), 'no darkening');
    assert.ok(shader.fragmentShader.includes('uWetStreakDir'), 'no streak direction');
    assert.ok(shader.fragmentShader.includes('wetRunnel('), 'the sheen is even, so it is a sheen and not water');
    // Anisotropy: the halfway vector is squashed along the streak before the lobe is taken. An
    // isotropic lobe on flat ground is a headlight spot that follows the camera.
    assert.ok(shader.fragmentShader.includes('halfway - vec3(uWetStreakDir.x, 0.0, uWetStreakDir.y)'));
    // Before `<opaque_fragment>`, where `outgoingLight` exists. See `water.test.ts` for the argument.
    const lobe = shader.fragmentShader.indexOf('outgoingLight += directionalLights[0].color * lobe');
    assert.ok(lobe > 0 && lobe < shader.fragmentShader.indexOf('#include <opaque_fragment>'));
    // Gated, so a dry frame pays one comparison and no ALU.
    assert.ok(shader.fragmentShader.includes('if (uWet > 0.001)'));
    assert.equal(shader.uniforms['uWet'], controls.uWet, 'the ground has its own copy of the weather');
  });

  it('hands the ground, the kit and the puddles one uWet, by reference', () => {
    /*
     * The mechanism, not a convenience. Two sets of uniforms would be two states of the weather in
     * one frame — a wet road beside a dry boulder — and the failure would look like an art bug rather
     * than like a wiring bug. `world3d.setWetness` writes this object once and every surface in the
     * scene follows.
     */
    const pool = new ScenePool();
    const compile = (material: { onBeforeCompile?: unknown }, lib: 'lambert'): ShaderPatch => {
      const shader: ShaderPatch = {
        vertexShader: ShaderLib[lib].vertexShader,
        fragmentShader: ShaderLib[lib].fragmentShader,
        uniforms: {},
      };
      (material.onBeforeCompile as (s: unknown, r: unknown) => void)(shader, undefined);
      return shader;
    };
    const ground = compile(pool.material(materialKey('ground', 'road', false)), 'lambert');
    const boulder = compile(pool.material(kitMaterialKey('rock-medium-1', 'rocks-diffuse')), 'lambert');
    const puddle = compile(pool.material(materialKey('puddle', undefined, false)), 'lambert');
    assert.equal(ground.uniforms['uWet'], pool.wet.uWet);
    assert.equal(boulder.uniforms['uWet'], pool.wet.uWet);
    assert.equal(puddle.uniforms['uWet'], pool.wet.uWet);
    // The ground keeps its blend patch as well: the wet response is added to it, not instead of it.
    assert.ok(ground.fragmentShader.includes('blendBreakup('), 'the ground lost its two-layer blend');
    pool.dispose();
  });

  it('draws a puddle as a disc that shrinks as it dries, and never writes depth', () => {
    const controls = createWetControls();
    const material = createPuddleMaterial(createWindClock(), controls, 0x14181c, 'puddle');
    assert.equal(material.transparent, true);
    assert.equal(material.depthWrite, false, 'a puddle that writes depth hides the road it lies on');
    const shader: ShaderPatch = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {},
    };
    (material.onBeforeCompile as unknown as (s: unknown, r: unknown) => void)(shader, undefined);
    assert.ok(shader.fragmentShader.includes('float edge = mix(0.25, 1.0, clamp(uWet, 0.0, 1.0));'));
    assert.ok(shader.fragmentShader.includes('if (disc < 0.01) discard;'), 'a square puddle');
    assert.equal(shader.uniforms['uWet'], controls.uWet);
  });
});

describe('puddles over the built world', () => {
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

  it('lands only on open hard ground, and never where a player arrives or walks', () => {
    const required = walkableRequired();
    let puddles = 0;
    let roomsWith = 0;
    let roofed = 0;
    const problems: string[] = [];

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
        const planned = planPuddles({ scene, origin, elevation: 0, free: freeTiles(scene) });

        if (scene.enclosure.roofed) {
          roofed += 1;
          // Weather is gated on the roof (M4's ruling for the rain), so a puddle under one would be
          // the rain's own gate contradicted by a decal.
          if (planned.length > 0 && problems.length < 8) problems.push(`room ${room.id}: a puddle under a roof`);
          continue;
        }
        const wanted = PUDDLES_BY_SECTOR[scene.biome.sector] ?? 0;
        assert.equal(planned.length, Math.min(wanted, PUDDLES_PER_ROOM_MAX), `room ${room.id} puddle count`);
        if (planned.length === 0) continue;
        roomsWith += 1;

        const blocked = new Set<number>(required);
        for (const feature of scene.features) {
          for (const tile of featureFootprint(feature)) blocked.add(tile);
        }
        const x0 = metresOfTile(origin.tx);
        const z0 = metresOfTile(origin.ty);
        for (const puddle of planned) {
          puddles += 1;
          assert.equal(puddle.archetype, 'puddle');
          assert.equal(puddle.geometry, 'waterPlane');
          // Just above the slab, never buried in it and never floating over it.
          assert.ok(puddle.y > 0 && puddle.y < 0.05, `room ${room.id}: a puddle at y=${puddle.y}`);
          // Elliptical, so it does not read as a decal.
          assert.notEqual(puddle.sx, puddle.sz);
          const tx = Math.floor(puddle.x - x0);
          const ty = Math.floor(puddle.z - z0);
          const inside = tx >= 0 && tx < ROOM_TILES && ty >= 0 && ty < ROOM_TILES;
          if (!inside && problems.length < 8) problems.push(`room ${room.id}: a puddle outside the block`);
          else if (inside && blocked.has(ty * ROOM_TILES + tx) && problems.length < 8) {
            problems.push(`room ${room.id}: a puddle on required-walkable tile ${tx},${ty}`);
          }
        }
      }
    }

    console.log(`[M5b puddles] ${puddles} puddles across ${roomsWith} rooms; ${roofed} roofed rooms stayed dry`);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(puddles > 5000, `only ${puddles} puddles — the roads are not wet`);
    assert.ok(roofed > 10000);
  });
});
