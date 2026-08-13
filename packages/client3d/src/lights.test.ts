/**
 * The light pool never grows, and it never hides a light.
 *
 * §3: *"a fixed startup pool of 8 point lights that are re-parented and re-coloured, **never created
 * or destroyed**, is the correct design on forward WebGL anyway, because three recompiles a shader
 * permutation per light count and a mid-frame compile is a visible hitch."*
 *
 * Two invariants, and only the first is the obvious one. **Nothing is constructed after boot** — the
 * plan's own words. And **nothing is ever made invisible**, which the plan does not say and which is
 * the way the first invariant is broken in practice: `WebGLLights.setup` counts *visible* lights, so
 * `light.visible = false` changes `NUM_POINT_LIGHTS`, and a pool that switches its spares off with
 * `visible` recompiles every material in the scene each time a campfire comes into range. That is
 * indistinguishable from "never created" if you only count constructor calls, which is why the test
 * counts both.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PerspectiveCamera, Scene, type Camera, type Object3D } from 'three';

import {
  CLEARING_SLOT,
  LIGHT_POOL_SIZE,
  LightPool,
  SELF_LAYER,
  WORLD_LAYER,
  type LightRequest,
} from './lights.ts';

function fire(x: number, z: number, rank = x * x + z * z): LightRequest {
  return { x, y: 1, z, rank };
}

/** Everything three would count when it decides which shader permutation this scene needs. */
function pointLights(scene: Scene): { total: number; visible: number } {
  const lights = scene.children.filter((child) => child.type === 'PointLight');
  return { total: lights.length, visible: lights.filter((light) => light.visible).length };
}

/** A camera restricted to one layer, which is what each of the composer's two scene passes uses. */
function cameraOn(layer: number): Camera {
  const camera = new PerspectiveCamera();
  camera.layers.set(layer);
  return camera;
}

/**
 * The renderer's own rule, quoted rather than paraphrased.
 *
 * `WebGLRenderer.projectObject`: `if (object.isLight) { ... }` inside `if (object.layers.test(camera
 * .layers))`. A light that fails this is not in the pass's light list at all — which is both how a
 * light is kept off an object *and* how `NUM_POINT_LIGHTS` changes underneath you.
 */
function collectedBy(scene: Scene, camera: Camera): Object3D[] {
  return scene.children.filter((child) => (child as { isLight?: boolean }).isLight === true && child.layers.test(camera.layers));
}

describe('the fixed pool of eight point lights', () => {
  it('is eight, in the scene, from the constructor', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    assert.equal(LIGHT_POOL_SIZE, 8, "the plan's number");
    assert.deepEqual(pointLights(scene), { total: 8, visible: 8 });
    assert.deepEqual(pool.audit(), { total: 8, lit: 0, visible: 8, created: 8 });
    pool.dispose();
  });

  it('survives a long churn without constructing a light or hiding one', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);

    for (let step = 0; step < 500; step++) {
      // A walk that repeatedly runs into, past and away from clusters of campfires — the pattern that
      // makes a naive pool grow, because each denser region wants a few more than the last left.
      const wanted = step % 11;
      const requests: LightRequest[] = [];
      for (let i = 0; i < wanted; i++) requests.push(fire(step + i * 3, step - i));
      pool.clearing(step, 1.5, -step, step % 3 === 0 ? 0 : 7);
      pool.scene(requests);

      const audit = pool.audit();
      assert.equal(audit.total, LIGHT_POOL_SIZE, `the pool changed size at step ${step}`);
      assert.equal(audit.created, LIGHT_POOL_SIZE, `a light was constructed at step ${step}`);
      assert.equal(audit.visible, LIGHT_POOL_SIZE, `a light was hidden at step ${step} — see the header`);
      // Slot 0 plus however many of the seven the request list could fill.
      const expected = (step % 3 === 0 ? 0 : 1) + Math.min(wanted, LIGHT_POOL_SIZE - 1);
      assert.equal(audit.lit, expected, `wrong number lit at step ${step}`);
      assert.deepEqual(pointLights(scene), { total: 8, visible: 8 });
    }

    pool.dispose();
  });

  it('turns a slot off with intensity and nothing else', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.scene([fire(1, 1), fire(2, 2)]);
    const second = pool.at(1);
    assert.ok(second);
    assert.ok(second.intensity > 0);
    pool.scene([]);
    assert.equal(second.intensity, 0);
    assert.equal(second.visible, true, 'off is intensity 0; invisible is a shader recompile');
    assert.equal(second.parent, scene, 'a light removed from the scene is the same recompile');
    pool.dispose();
  });

  it('takes the nearest campfires when there are more than seven', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    // Ten, deliberately out of order, so an implementation that took them as they came would fail.
    const requests = [90, 10, 70, 30, 110, 20, 50, 5, 80, 40].map((rank) => fire(rank, 0, rank));
    pool.scene(requests);

    const claimed: number[] = [];
    for (let slot = CLEARING_SLOT + 1; slot < LIGHT_POOL_SIZE; slot++) {
      const light = pool.at(slot);
      assert.ok(light);
      assert.ok(light.intensity > 0, `slot ${slot} was left dark with ten requests waiting`);
      claimed.push(light.position.x);
    }
    assert.deepEqual(claimed.sort((a, b) => a - b), [5, 10, 20, 30, 40, 50, 70]);
    pool.dispose();
  });

  it('scales the clearing light by the square of its radius, so the rim keeps its brightness', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 4);
    const small = pool.at(CLEARING_SLOT)!.intensity;
    const smallReach = pool.at(CLEARING_SLOT)!.distance;
    pool.clearing(0, 1.5, 0, 8);
    const big = pool.at(CLEARING_SLOT)!.intensity;
    // Twice the radius is four times the candela: inverse-square then puts the same irradiance at the
    // rim. That is the whole of the "carried-light radius can drive intensity later" hook.
    assert.ok(Math.abs(big / small - 4) < 1e-9, `radius doubled but intensity went up ${big / small}x`);
    assert.ok(pool.at(CLEARING_SLOT)!.distance > smallReach, 'the reach did not widen with the radius');
    pool.dispose();
  });

  it('a radius of zero is off, not a light with no reach', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 0);
    const light = pool.at(CLEARING_SLOT)!;
    assert.equal(light.intensity, 0);
    assert.equal(light.visible, true);
    pool.dispose();
  });

  it('darkens every slot on arrival at a new Place', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0);
    pool.scene([fire(1, 1), fire(2, 2), fire(3, 3)]);
    assert.equal(pool.audit().lit, 4);
    pool.darken();
    assert.deepEqual(pool.audit(), { total: 8, lit: 0, visible: 8, created: 8 });
    pool.dispose();
  });

  it('puts every one of the eight on both layers, so the two passes are one permutation', () => {
    // The whole reason the carried light is excluded by *intensity* rather than by leaving slot 0 off
    // `SELF_LAYER`. A light that fails the body camera's test is not collected for that pass, so a
    // seven-light body pass and an eight-light world pass would be two values of `NUM_POINT_LIGHTS`
    // and therefore two compiled programs for every material a character is made of — which is the
    // exact cost this file's header spends its first page refusing to pay.
    const scene = new Scene();
    const pool = new LightPool(scene);
    const world = cameraOn(WORLD_LAYER);
    const body = cameraOn(SELF_LAYER);
    assert.equal(collectedBy(scene, world).length, LIGHT_POOL_SIZE);
    assert.equal(collectedBy(scene, body).length, LIGHT_POOL_SIZE, 'the body pass must see the same eight');
    for (let slot = 0; slot < LIGHT_POOL_SIZE; slot++) {
      const light = pool.at(slot);
      assert.ok(light);
      assert.ok(light.layers.test(world.layers), `slot ${slot} left the world's layer`);
      assert.ok(light.layers.test(body.layers), `slot ${slot} is not on the body's layer`);
    }
    pool.dispose();
  });

  it('mutes the carried light for the body pass and gives back exactly what it took', () => {
    // The owner's report, as an assertion: *"the player doesn't need to light up at all. just his
    // surroundings depending on his light source."* The surroundings are the world pass, where slot 0
    // burns; the body is the pass where it does not.
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(4, 1.5, -2, 7);
    const lit = pool.at(CLEARING_SLOT)!.intensity;
    assert.ok(lit > 0, 'a seven-metre clearing light should be burning');

    pool.muteClearing();
    assert.equal(pool.clearingMuted, true);
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, 0, 'the body must be drawn without it');
    assert.equal(pool.at(CLEARING_SLOT)!.visible, true, 'muted is intensity 0; invisible is a recompile');
    assert.equal(pool.at(CLEARING_SLOT)!.parent, scene, 'and removing it from the scene is the same recompile');
    // The rest of the pool is untouched — a mob standing in your lamplight is *surroundings*, and so
    // is every campfire in the room.
    assert.equal(pool.audit().visible, LIGHT_POOL_SIZE);

    pool.unmuteClearing();
    assert.equal(pool.clearingMuted, false);
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit, 'the world pass got a different light back');
    pool.dispose();
  });

  it('mutes slot 0 and never a campfire', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 7);
    pool.scene([fire(1, 1), fire(2, 2), fire(3, 3)]);
    const fires = [1, 2, 3].map((slot) => pool.at(slot)!.intensity);
    pool.muteClearing();
    assert.equal(pool.audit().lit, 3, 'only the carried light comes out of the frame');
    assert.deepEqual([1, 2, 3].map((slot) => pool.at(slot)!.intensity), fires);
    pool.unmuteClearing();
    assert.equal(pool.audit().lit, 4);
    pool.dispose();
  });

  it('cannot lose the candela to a second mute, or to an unmute that never had one', () => {
    // `BodyPass.render` restores from a `finally`, so an exception mid-pass must not be able to leave
    // the world permanently dark — and a stray second call must not overwrite the saved value with
    // the zero the first one wrote.
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 7);
    const lit = pool.at(CLEARING_SLOT)!.intensity;
    pool.muteClearing();
    pool.muteClearing();
    pool.unmuteClearing();
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit);
    pool.unmuteClearing();
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit, 'an unmute with nothing saved must do nothing');
    pool.dispose();
  });

  it('writes a new clearing radius through the mute rather than around it', () => {
    // The ordering bug this forecloses: `focus` runs in the frame loop and the mute spans one pass,
    // so today they never overlap. If they ever did, a write that landed on the live light would be
    // undone by the restore and the clearing light would be one frame stale for ever after.
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 4);
    pool.muteClearing();
    pool.clearing(0, 1.5, 0, 8);
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, 0, 'the body pass must still see nothing');
    pool.unmuteClearing();
    const wide = pool.at(CLEARING_SLOT)!.intensity;
    pool.clearing(0, 1.5, 0, 8);
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, wide, 'the restored value is the one that was written');
    pool.dispose();
  });

  it('arrives in a new Place dark even if the mute is still open', () => {
    const scene = new Scene();
    const pool = new LightPool(scene);
    pool.clearing(0, 1.5, 0, 7);
    pool.muteClearing();
    pool.darken();
    pool.unmuteClearing();
    assert.deepEqual(pool.audit(), { total: 8, lit: 0, visible: 8, created: 8 });
    pool.dispose();
  });

  it('never casts a shadow from a point light', () => {
    // A shadow-casting point light is six shadow-map faces and its own program permutation, and the
    // plan's shadow budget is one directional light. Asserted so nothing switches it on by hand.
    const scene = new Scene();
    const pool = new LightPool(scene);
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) assert.equal(pool.at(i)?.castShadow, false);
    pool.dispose();
  });
});
