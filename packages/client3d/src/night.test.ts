/**
 * The shadow camera's fit, headless.
 *
 * The plan spends one parenthesis on why M4 needs no cascades — *"an orthographic shadow camera
 * refitted per frame to the loaded ring (~40x26 m — which is why you need no cascaded shadow maps at
 * all)"* — and that parenthesis is only true if the fit is *tight*. A fit that is too loose wastes the
 * texel density that made one map enough; a fit that is too tight drops shadows off the edge of the
 * frame. Neither failure throws, and both are invisible in a screenshot of a grey box.
 *
 * So the property tested is containment with a stated margin, checked by projecting the corners
 * independently of the code under test. The projection is written out longhand here on purpose: an
 * assertion that re-used `fitShadowCamera`'s own basis would agree with any basis at all, including a
 * wrong one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Object3D, PerspectiveCamera, Scene, type Camera } from 'three';

import { INSIDE_SKY } from './indoors.ts';
import { SELF_LAYER, WORLD_LAYER } from './lights.ts';
import {
  MOON_FROM,
  NightRig,
  SHADOW_DISTANCE,
  SHADOW_HALF_DEPTH,
  SHADOW_HALF_HEIGHT,
  SHADOW_HALF_WIDTH,
  SHADOW_PAD,
  fitShadowCamera,
  shadowUpFor,
  type Point3,
} from './night.ts';

const HALF = { width: SHADOW_HALF_WIDTH, height: SHADOW_HALF_HEIGHT, depth: SHADOW_HALF_DEPTH };

/** A camera restricted to one layer — one of the composer's two scene passes. `lights.SELF_LAYER`. */
function cameraOn(layer: number): Camera {
  const camera = new PerspectiveCamera();
  camera.layers.set(layer);
  return camera;
}

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function unit(v: Point3): Point3 {
  const n = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

function cross(a: Point3, b: Point3): Point3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Every corner of the fitted box, in world metres. */
function corners(centre: Point3, half: typeof HALF): Point3[] {
  const out: Point3[] = [];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push({
          x: centre.x + sx * half.width,
          y: centre.y + sy * half.height,
          z: centre.z + sz * half.depth,
        });
      }
    }
  }
  return out;
}

describe('the moon shadow camera fit', () => {
  it('contains every corner of the region, with the pad as slack and no more', () => {
    const centre = { x: 137.5, y: 2.25, z: -84 };
    const fit = fitShadowCamera(centre, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD);

    // Rebuilt from scratch, matching `Object3D.lookAt`: +Z from target to light.
    const forward = unit(MOON_FROM);
    const right = unit(cross(fit.up, forward));
    const realUp = cross(forward, right);

    let widestU = 0;
    let widestV = 0;
    for (const corner of corners(centre, HALF)) {
      const p = { x: corner.x - fit.position.x, y: corner.y - fit.position.y, z: corner.z - fit.position.z };
      const u = dot(p, right);
      const v = dot(p, realUp);
      const w = -dot(p, forward);
      assert.ok(u >= fit.left && u <= fit.right, `corner outside left/right at u=${u}`);
      assert.ok(v >= fit.bottom && v <= fit.top, `corner outside bottom/top at v=${v}`);
      assert.ok(w >= fit.near && w <= fit.far, `corner outside near/far at w=${w}`);
      widestU = Math.max(widestU, Math.abs(u));
      widestV = Math.max(widestV, Math.abs(v));
    }

    // Tight: the frustum is the corners' own extent plus exactly one pad on each side. This is the
    // half of the claim a containment test alone would not catch.
    assert.ok(Math.abs(fit.right - (widestU + SHADOW_PAD)) < 1e-9, 'right is not the extent plus the pad');
    assert.ok(Math.abs(fit.top - (widestV + SHADOW_PAD)) < 1e-9, 'top is not the extent plus the pad');
  });

  it('turns the box with the frame rather than growing a hull around it — M8', () => {
    /*
     * The box's extents are the *camera's* two axes, so under free yaw it has to rotate with the
     * camera. Two things follow and both are asserted here, because the cheap alternative — leaving
     * the box world-aligned and growing it to contain the rotated frame — passes a containment test
     * and fails everything else:
     *
     * - **The volume is the same at every yaw.** A grown hull would be `(w + d)/√2` on each axis at
     *   45°, which over a fixed 2048 map is a 25% coarser shadow texel exactly when the owner orbits.
     * - **Its furthest corner stays `hypot(w, d)` from the centre**, which is the circumradius
     *   `streamer.ts` sized the ring against. A grown hull reaches `w + d` — half as far again — and
     *   would be fitted to ground outside the built world.
     */
    const centre = { x: 0, y: 0, z: 0 };
    const flat = fitShadowCamera(centre, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD, 0);
    const oblique = { x: 0, y: 1, z: 0.0001 }; // straight down, so the fit is the box's own footprint
    let widest = 0;
    for (const yaw of [0, Math.PI / 8, Math.PI / 4, 1.1, -2.4, Math.PI]) {
      const fit = fitShadowCamera(centre, HALF, oblique, SHADOW_DISTANCE, SHADOW_PAD, yaw);
      widest = Math.max(widest, fit.right - fit.left, fit.top - fit.bottom);
    }
    const diagonal = 2 * Math.hypot(HALF.width, HALF.depth) + 2 * SHADOW_PAD;
    assert.ok(widest <= diagonal + 1e-9, `the box grew to ${widest} m, past its own diagonal ${diagonal}`);
    // A grown world-aligned hull would have reached this instead — stated so the trade stays visible.
    assert.ok(diagonal < 2 * (HALF.width + HALF.depth) + 2 * SHADOW_PAD);
    // And a turn is not a no-op: the box really did move, so the assertion above is not passing
    // because the yaw was ignored. Measured on the light's own footprint, which is where it shows —
    // a box turned 45° into a raking light is *narrower* in that basis, not wider, which is the
    // second small dividend of turning it rather than growing it.
    const turned = fitShadowCamera(centre, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD, Math.PI / 4);
    assert.ok(Math.abs(turned.right - turned.left - (flat.right - flat.left)) > 1, 'the yaw was ignored');
  });

  it('is a translation of itself: walking the world does not change the volume, only where it is', () => {
    const a = fitShadowCamera({ x: 0, y: 0, z: 0 }, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD);
    const b = fitShadowCamera({ x: 900, y: -12, z: 40 }, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD);
    for (const key of ['left', 'right', 'top', 'bottom', 'near', 'far'] as const) {
      assert.ok(Math.abs(a[key] - b[key]) < 1e-9, `${key} moved with the centre: ${a[key]} vs ${b[key]}`);
    }
    // Which is what makes "refit per frame" cheap *and* stable: the texel grid does not resize as the
    // character walks, so a shadow edge does not shimmer between frames.
    assert.equal(b.position.x - a.position.x, 900);
    assert.equal(b.position.z - a.position.z, 40);
  });

  it('covers the whole camera footprint at the plan’s 40 x 26 m', () => {
    // rig.ts: at 36 m, a 30-degree field and a 64-degree pitch see 34 x 22 m of ground. The fitted
    // region is the plan's 40 x 26, so the footprint sits inside it with margin on all four sides.
    assert.ok(SHADOW_HALF_WIDTH * 2 >= 34, 'the shadow region is narrower than the frame');
    assert.ok(SHADOW_HALF_DEPTH * 2 >= 22, 'the shadow region is shallower than the frame');
    assert.equal(SHADOW_HALF_WIDTH * 2, 40);
    assert.equal(SHADOW_HALF_DEPTH * 2, 26);
  });

  it('keeps the near plane in front of the light however the region is placed', () => {
    for (const y of [-40, 0, 40]) {
      const fit = fitShadowCamera({ x: 0, y, z: 0 }, HALF, MOON_FROM, SHADOW_DISTANCE, SHADOW_PAD);
      assert.ok(fit.near > 0, `near ${fit.near} is behind the light`);
      assert.ok(fit.far > fit.near, 'far is not beyond near');
    }
  });

  it('switches the up vector before a vertical light can degenerate it', () => {
    // Not a case `MOON_FROM` reaches; asserted because the failure is a frame that flips orientation
    // depending on which way a floating-point comparison fell, exactly like `rig.ts`'s pitch limit.
    assert.deepEqual(shadowUpFor({ x: 0, y: 1, z: 0 }), { x: 0, y: 0, z: 1 });
    assert.deepEqual(shadowUpFor({ x: 0, y: -1, z: 0 }), { x: 0, y: 0, z: 1 });
    assert.deepEqual(shadowUpFor(MOON_FROM), { x: 0, y: 1, z: 0 });
    const fit = fitShadowCamera({ x: 0, y: 0, z: 0 }, HALF, { x: 0, y: 1, z: 0 }, SHADOW_DISTANCE, SHADOW_PAD);
    assert.ok(Number.isFinite(fit.left) && Number.isFinite(fit.top), 'a vertical light produced NaN bounds');
  });

  it('the moon is above the horizon and not straight overhead', () => {
    const dir = unit(MOON_FROM);
    assert.ok(dir.y > 0.3, 'the moon is at or below the horizon');
    assert.ok(dir.y < 0.9, 'the moon is near-vertical, so nothing casts a readable shadow');
  });
});

describe('the night rig', () => {
  it('adds exactly one hemisphere and one moon, and no ambient light', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    const lights = scene.children.filter((child) => 'isLight' in child && child['isLight'] === true);
    assert.equal(lights.length, 2, 'the rig is a hemisphere and a moon, and nothing else');
    assert.ok(lights.includes(rig.hemisphere));
    assert.ok(lights.includes(rig.moon));
    // The plan says "no `AmbientLight`" and means it — see `night.ts` for why the omission is the
    // point rather than a saving.
    assert.equal(
      scene.children.filter((child) => child.type === 'AmbientLight').length,
      0,
      'an AmbientLight flattens every box in the scene',
    );
    rig.dispose();
  });

  it('puts the moon’s target in the graph, or the light points at the origin for ever', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    assert.equal(rig.moon.target.parent, scene, 'an unparented DirectionalLight target is never updated');
    rig.refit(50, 3, -20);
    assert.deepEqual(
      [rig.moon.target.position.x, rig.moon.target.position.y, rig.moon.target.position.z],
      [50, 3, -20],
    );
    rig.dispose();
  });

  it('writes the fit onto the shadow camera and keeps the light’s up in step with it', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    rig.refit(11, 0, 7);
    const camera = rig.moon.shadow.camera;
    assert.equal(camera.left, rig.fit.left);
    assert.equal(camera.right, rig.fit.right);
    assert.equal(camera.near, rig.fit.near);
    assert.equal(camera.far, rig.fit.far);
    // The fit's basis is only the camera's basis if the light carries the same up vector.
    assert.deepEqual([rig.moon.up.x, rig.moon.up.y, rig.moon.up.z], [rig.fit.up.x, rig.fit.up.y, rig.fit.up.z]);
    rig.dispose();
  });

  it('resizes the shadow map by disposing it, not by writing a number nothing reads', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    assert.equal(rig.shadowMapSize, 2048);
    rig.shadowMapSize = 1024;
    assert.equal(rig.shadowMapSize, 1024);
    assert.equal(rig.moon.shadow.mapSize.x, 1024);
    assert.equal(rig.moon.shadow.map, null, 'the old render target survived, so the size never applies');
    rig.shadowMapSize = 99_999;
    assert.equal(rig.shadowMapSize, 4096, 'the clamp is what stops a typo allocating a gigabyte');
    rig.dispose();
  });

  it('moves fog and background together', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    rig.nightColour = 0x123456;
    assert.equal(rig.fog.color.getHex(), 0x123456);
    assert.equal(scene.background && 'getHex' in scene.background ? scene.background.getHex() : -1, 0x123456);
    rig.dispose();
  });

  it('fogs the far edge of the frame appreciably more than the near one', () => {
    const scene = new Scene();
    const rig = new NightRig(scene);
    // The frame's own numbers, from `rig.ts`: the visible ground runs from 33 m to 43 m away.
    const near = Math.exp(-Math.pow(rig.fogDensity * 33, 2));
    const far = Math.exp(-Math.pow(rig.fogDensity * 43, 2));
    assert.ok(near > 0.6, `the foreground keeps only ${near.toFixed(2)} of itself — the frame is a fog bank`);
    assert.ok(far < near - 0.1, 'there is no depth cue across the frame at this density');
    rig.dispose();
  });
});

describe('the sky rig lights the player’s own body too', () => {
  /** A body mesh, as the composer's second pass sees it. See `lights.SELF_LAYER`. */
  function bodyMesh(): Object3D {
    const object = new Object3D();
    object.layers.set(SELF_LAYER);
    return object;
  }

  it('gives the hemisphere and the moon both layers, or the player is a cut-out', () => {
    // The failure this pins is the one that would be *reported* rather than crash: the composer draws
    // the player's body with a camera restricted to `SELF_LAYER`, and `WebGLRenderer.projectObject`
    // collects a light for a pass only if the light tests against that camera. A hemisphere left on
    // the default layer alone leaves the player a black silhouette in a lit street; a moon left on it
    // takes their key light and their shadow-receiving with it. Indoors, where M6's interior key *is*
    // this same directional (`indoors.ts` — "nothing here touches a light object"), it is the whole
    // of the light in the room.
    const scene = new Scene();
    const rig = new NightRig(scene);
    const world = cameraOn(WORLD_LAYER);
    const body = cameraOn(SELF_LAYER);
    for (const [name, light] of [['hemisphere', rig.hemisphere], ['moon', rig.moon]] as const) {
      assert.ok(light.layers.test(world.layers), `the ${name} left the world's layer`);
      assert.ok(light.layers.test(body.layers), `the ${name} does not reach the player's own body`);
    }
    // And the counts match across the two passes, which is what keeps them one shader permutation.
    const lit = (camera: Camera): number =>
      scene.children.filter((child) => (child as { isLight?: boolean }).isLight === true && child.layers.test(camera.layers)).length;
    assert.equal(lit(body), lit(world), 'the two passes must collect the same lights');
    rig.dispose();
  });

  it('keeps the player casting a shadow, which is the trap layers set', () => {
    // `WebGLShadowMap` decides what casts with `object.layers.test(shadowCamera.layers)` — the shadow
    // camera's own mask, not the light's, and it is an ordinary `Object3D` that nobody thinks to
    // touch. Miss this line and the player's shadow silently disappears, which `indoors.ts` already
    // calls the worse artefact: *"a character with no shadow floats however good the terrain looks"*.
    const scene = new Scene();
    const rig = new NightRig(scene);
    const shadow = rig.moon.shadow.camera;
    assert.ok(bodyMesh().layers.test(shadow.layers), 'the player stopped casting a shadow');
    assert.ok(new Object3D().layers.test(shadow.layers), 'and everything else must still cast one');
    rig.dispose();
  });

  it('re-fits the shadow volume without ever narrowing what casts into it', () => {
    // The refit runs every frame and turns with the camera (M8). None of that may touch the mask.
    const scene = new Scene();
    const rig = new NightRig(scene);
    const mask = rig.moon.shadow.camera.layers.mask;
    rig.refit(120, 3, -80);
    rig.setExtents(31, 19, Math.PI / 3);
    rig.sky = INSIDE_SKY;
    rig.refit(121, 3, -80);
    assert.equal(rig.moon.shadow.camera.layers.mask, mask, 'a refit changed which objects cast');
    assert.ok(bodyMesh().layers.test(rig.moon.shadow.camera.layers));
    // And indoors the key light still reaches the body — the interior recipe is a colour and a
    // direction, and must never become a layer.
    assert.ok(rig.moon.layers.test(cameraOn(SELF_LAYER).layers), 'the interior key stopped reaching the player');
    assert.ok(rig.hemisphere.layers.test(cameraOn(SELF_LAYER).layers));
    rig.dispose();
  });
});
