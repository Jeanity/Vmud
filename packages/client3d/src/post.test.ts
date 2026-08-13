/**
 * The frame's two scene passes, headless.
 *
 * `Grade` itself needs a live `WebGLRenderer` and a canvas, so what is under test is the seam it was
 * split at: {@link scenePasses} builds the pair and sets the four properties that make the
 * arrangement work, and {@link BodyPass} owns the one thing that has to happen at exactly the right
 * moment. Both are reachable with a stub renderer, and both fail silently in a running client —
 * a world pass that kept its `ClearPass` shows a player and nothing else, and a mute that leaked
 * shows a world lit by a lamp that has followed the camera off the map.
 *
 * The owner's report this answers, 2026-08-13: *"when the player moves he lights up like the light
 * source is around his neck … the player doesn't need to light up at all. just his surroundings
 * depending on his light source."* `lights.ts`'s header has the diagnosis and the argument for why
 * a second render call is the only shape the answer could take in three's forward WebGL renderer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PerspectiveCamera, Scene, Vector3 } from 'three';

import { ENVELOPE_POSES } from './fixture.ts';
import { CLEARING_SLOT, LightPool, SELF_LAYER } from './lights.ts';
import { NightRig } from './night.ts';
import { BodyPass, scenePasses, syncBodyCamera } from './post.ts';
import { CameraRig } from './rig.ts';

/**
 * Just enough renderer for a `RenderPass` and the `ClearPass` inside it.
 *
 * `render` is where the assertions live: it is called with the GL state the pass has set up, which is
 * the only moment the mute is observable.
 */
function stubRenderer(onRender: () => void): {
  renderer: never;
  shadowMap: { autoUpdate: boolean };
  cleared: number;
} {
  const shadowMap = { autoUpdate: true };
  const state = { cleared: 0 };
  const renderer = {
    shadowMap,
    getClearAlpha: () => 1,
    getClearColor: (target: unknown) => target,
    setClearColor: () => {},
    setClearAlpha: () => {},
    setRenderTarget: () => {},
    clear: () => {
      state.cleared += 1;
    },
    render: onRender,
  };
  return {
    renderer: renderer as never,
    shadowMap,
    get cleared() {
      return state.cleared;
    },
  };
}

/** The real scene's shape: a night rig (which is what sets `scene.background`) and the light pool. */
function fixture(): { scene: Scene; camera: PerspectiveCamera; pool: LightPool } {
  const scene = new Scene();
  new NightRig(scene);
  const pool = new LightPool(scene);
  const camera = new PerspectiveCamera(50, 16 / 9, 0.5, 240);
  camera.position.set(3, 22, 17);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return { scene, camera, pool };
}

describe('the body pass', () => {
  it('draws with a camera that can see the body and nothing else', () => {
    const { scene, camera, pool } = fixture();
    const pass = new BodyPass(scene, camera, pool);
    assert.equal(pass.camera3d.layers.mask, 1 << SELF_LAYER, 'the body pass must draw the body and only it');
    assert.notEqual(pass.camera3d, camera, 'a second camera object is what forces the light uniforms to refresh');
    pool.dispose();
  });

  it('mutes the carried light for exactly the duration of the draw', () => {
    // The assertion the whole slice exists for. Slot 0 burns for the world and is zero for the body,
    // and it is zero *at the moment three assembles the light list*, which is inside `render`.
    const { scene, camera, pool } = fixture();
    const pass = new BodyPass(scene, camera, pool);
    pool.clearing(0, 1.5, 0, 7);
    const lit = pool.at(CLEARING_SLOT)!.intensity;
    assert.ok(lit > 0);

    let during = -1;
    const stub = stubRenderer(() => {
      during = pool.at(CLEARING_SLOT)!.intensity;
    });
    pass.render(stub.renderer, null as never, null as never, 1 / 60, false);

    assert.equal(during, 0, 'the player was drawn with their own lamp still on');
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit, 'the world pass would draw without it');
    assert.equal(pool.clearingMuted, false);
    pool.dispose();
  });

  it('gives the light back even when the draw throws', () => {
    // A throw inside a draw must cost one frame of a slightly over-lit player, not a world that never
    // lights up again — which is what a mute restored after the call rather than in a `finally` would
    // give, and it would survive every test that did not throw on purpose.
    const { scene, camera, pool } = fixture();
    const pass = new BodyPass(scene, camera, pool);
    pool.clearing(0, 1.5, 0, 7);
    const lit = pool.at(CLEARING_SLOT)!.intensity;
    const stub = stubRenderer(() => {
      throw new Error('a driver hiccup mid-frame');
    });
    assert.throws(() => pass.render(stub.renderer, null as never, null as never, 1 / 60, false));
    assert.equal(pool.clearingMuted, false, 'the mute leaked');
    assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit);
    pool.dispose();
  });

  it('points its twin camera exactly where the real one is looking, every frame', () => {
    // `matrixWorldAutoUpdate` is off on the twin, so nothing but this sync writes its world matrix —
    // and if the sync were wrong, three would not complain: it would draw the player from the origin
    // looking north, which at this camera pitch is a player who has vanished.
    const { scene, camera, pool } = fixture();
    const pass = new BodyPass(scene, camera, pool);
    const stub = stubRenderer(() => {});
    camera.position.set(-40, 26, 91);
    camera.lookAt(-40, 0, 80);
    camera.updateMatrixWorld();
    pass.render(stub.renderer, null as never, null as never, 1 / 60, false);

    assert.deepEqual([...pass.camera3d.matrixWorld.elements], [...camera.matrixWorld.elements]);
    assert.deepEqual([...pass.camera3d.matrixWorldInverse.elements], [...camera.matrixWorldInverse.elements]);
    assert.deepEqual([...pass.camera3d.projectionMatrix.elements], [...camera.projectionMatrix.elements]);
    assert.equal(pass.camera3d.far, camera.far, 'the depth term and the frustum cull read this');
    assert.equal(pass.camera3d.aspect, camera.aspect, 'a resize must reach the body pass too');
    // The one thing about the twin that must never match.
    assert.equal(pass.camera3d.layers.mask, 1 << SELF_LAYER);
    assert.notEqual(camera.layers.mask, pass.camera3d.layers.mask);
    pool.dispose();
  });

  it('follows a real rig to the closest pose the dolly reaches, lift and all — M9', () => {
    /*
     * **The pose the body pass was never built for.** It landed hours before M9 opened the clamp to
     * 3 m, and everything about it is distance-free by construction — `syncBodyCamera` copies the
     * main camera's matrices and projection verbatim, and the clearing light is excluded by being
     * muted for the length of the pass rather than by any range test. This drives that claim through
     * the *rig* rather than a hand-set camera, at every pose on the envelope, because two things M9
     * changed could have broken it without changing a line of `post.ts`: the aim point is lifted now
     * (so a twin syncing position-but-not-orientation would draw the body from under the floor), and
     * the eye comes within 2.5 m of the body's own surface against a 0.5 m near plane.
     *
     * This is exactly the view in which a lighting artefact would be most visible — the character
     * fills the frame — so it is the view worth pinning.
     */
    const { scene, pool } = fixture();
    pool.clearing(12, 1.5, -7, 7);
    const lit = pool.at(CLEARING_SLOT)!.intensity;
    assert.ok(lit > 0);
    const stub = stubRenderer(() => {
      assert.equal(pool.at(CLEARING_SLOT)!.intensity, 0, 'the player was lit by their own light');
    });
    for (const [distance, pitch] of ENVELOPE_POSES) {
      const rig = new CameraRig(16 / 9);
      rig.distance = distance;
      rig.pitch = pitch;
      rig.follow(12, 0, -7);
      rig.camera.updateMatrixWorld(true);
      const pass = new BodyPass(scene, rig.camera, pool);
      pass.render(stub.renderer, null as never, null as never, 1 / 60, false);
      const at = `${distance.toFixed(1)} m / ${pitch.toFixed(1)}°`;
      assert.deepEqual([...pass.camera3d.matrixWorld.elements], [...rig.camera.matrixWorld.elements], at);
      assert.deepEqual([...pass.camera3d.projectionMatrix.elements], [...rig.camera.projectionMatrix.elements], at);
      assert.equal(pass.camera3d.near, rig.camera.near, at);
      assert.equal(pass.camera3d.far, rig.camera.far, at);
      assert.equal(pass.camera3d.layers.mask, 1 << SELF_LAYER, at);
      // And the light is *back* the instant the pass is over, or the world goes dark behind them.
      assert.equal(pool.at(CLEARING_SLOT)!.intensity, lit, `the clearing light stayed muted at ${at}`);
      assert.equal(pool.clearingMuted, false, at);
      // The body's own middle — the point the rig is now aiming at — must land dead centre of the
      // twin's frame. This is the assertion the lift would fail if `follow` raised the eye alone.
      const middle = new Vector3(12, rig.focusLift, -7).project(pass.camera3d);
      assert.ok(Math.abs(middle.x) < 1e-6 && Math.abs(middle.y) < 1e-6, `the body is off centre at ${at}`);
      assert.ok(middle.z > -1 && middle.z < 1, `the body is outside the twin's depth range at ${at}`);
    }
    pool.dispose();
  });

  it('does not touch the layers of the camera it is copying', () => {
    const { camera } = fixture();
    const twin = new PerspectiveCamera();
    twin.layers.set(SELF_LAYER);
    const before = camera.layers.mask;
    syncBodyCamera(camera, twin);
    assert.equal(camera.layers.mask, before, 'the main camera stopped drawing the world');
    assert.equal(twin.layers.mask, 1 << SELF_LAYER, 'the twin stopped drawing the body');
  });
});

describe('the two scene passes, in order', () => {
  it('puts the body first, so everything transparent still composites over it', () => {
    // World first and body second is one line shorter and quietly wrong: rain and snow falling in
    // front of the player would already have been composited, so the player would be painted over
    // them, and another character's nameplate would show through them. See `BodyPass`.
    const { scene, camera, pool } = fixture();
    const [body, world] = scenePasses(scene, camera, pool);
    assert.ok(body instanceof BodyPass, 'the body must be the first of the two');
    assert.ok(!(world instanceof BodyPass));
  });

  it('gives the clear, the background and the shadow map to the body pass alone', () => {
    // Three separate silent failures if any of them moves. A world pass that kept its `ClearPass`
    // shows a player against an empty frame. One that kept the background clears anyway, because
    // `WebGLBackground` forces a clear for a `Color` background whatever `autoClear` says. And one
    // that updated the shadow map renders 2048² twice a frame for a map identical to the first.
    const { scene, camera, pool } = fixture();
    const [body, world] = scenePasses(scene, camera, pool);
    assert.equal(body.clear, true, 'nothing else in the chain clears the buffer');
    assert.equal(body.ignoreBackground, false, 'nothing else in the chain paints the sky');
    assert.equal(body.skipShadowMapUpdate, false, 'nothing else in the chain builds the shadow map');
    assert.equal(world.clear, false);
    assert.equal(world.ignoreBackground, true);
    assert.equal(world.skipShadowMapUpdate, true);
    // And the depth texture is blitted once rather than twice: the first copy would be overwritten
    // by the second before the bloom's mask ever read it.
    assert.equal(body.needsDepthBlit, false);
    assert.equal(world.needsDepthBlit, true, 'the depth mask has nothing to compare against');
    pool.dispose();
  });

  it('actually suppresses the second clear and the second shadow-map pass', () => {
    // The properties above are `postprocessing`'s API; this is what it does with them, so a version
    // bump that renamed one fails here rather than in the owner's frame.
    const { scene, camera, pool } = fixture();
    const [body, world] = scenePasses(scene, camera, pool);

    const first = stubRenderer(() => {});
    body.render(first.renderer, null as never, null as never, 1 / 60, false);
    assert.equal(first.cleared, 1, 'the body pass must clear the buffer it draws into');

    let shadowsDuring = true;
    const second = stubRenderer(() => {
      shadowsDuring = second.shadowMap.autoUpdate;
    });
    world.render(second.renderer, null as never, null as never, 1 / 60, false);
    assert.equal(second.cleared, 0, 'the world pass wiped the body it was drawn over');
    assert.equal(shadowsDuring, false, 'the shadow map was rendered a second time');
    assert.equal(second.shadowMap.autoUpdate, true, 'and the flag must be put back afterwards');
    pool.dispose();
  });

  it('leaves the scene’s background where it found it', () => {
    // `ignoreBackground` nulls it for the length of the pass. If it did not put it back, the sky
    // would be painted on exactly one frame.
    const { scene, camera, pool } = fixture();
    const [, world] = scenePasses(scene, camera, pool);
    const background = scene.background;
    assert.ok(background, 'the night rig should have set one — see `night.ts`');
    world.render(stubRenderer(() => {}).renderer, null as never, null as never, 1 / 60, false);
    assert.equal(scene.background, background);
    pool.dispose();
  });
});
