/**
 * **Trap 1, asserted.** §5: *"the wind displacement must be duplicated into `customDepthMaterial` or
 * shadows visibly detach from the animated foliage"* — a day's debugging, according to the plan, and
 * the kind of bug that only shows up when somebody looks at a tree from the right angle at the right
 * moment.
 *
 * A headless test cannot execute GLSL. What it can do is check the two halves that, together, are the
 * whole of "the shadow stays attached":
 *
 * 1. **Identical code.** The block injected into the visible material's vertex shader and the block
 *    injected into the depth material's are sliced out of the two compiled sources and compared byte
 *    for byte. They are the same because they come from one exported constant, and this is the test
 *    that fails the day somebody copies it to tweak one of them.
 * 2. **Identical inputs.** Every uniform the displacement reads is checked to be the *same object* in
 *    both shaders' uniform records — not an equal value, the same reference — so there is no second
 *    clock to drift against and no way to write a strength to one and not the other. Then
 *    {@link foliageWindOffset}, the TypeScript mirror of the GLSL, is run over a grid of positions
 *    and times from each material's own uniform objects and the two runs are compared.
 *
 * Identical code plus identical inputs is a proof by construction, and the two assertions are what
 * keep the construction true.
 *
 * The mirror also lets the *shape* of the motion be asserted rather than eyeballed: nothing moves at
 * the foot of the trunk, nothing moves with the wind off, the offset is bounded, and two trees a
 * metre apart are out of phase.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DataTexture, ShaderLib } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES } from '@mygame/shared';

import { ENVELOPE_POSES } from './fixture.ts';
import {
  FOLIAGE_MASK_GLSL,
  FOLIAGE_VERTEX_DECL,
  FOLIAGE_WIND_GLSL,
  GRASS_FADE,
  KIT_FADE_LAG,
  KIT_LEAF_FADE,
  MASK_NEEDLE,
  MASK_TEXTURE,
  WIND_STRENGTH,
  createFoliageMaterial,
  createWindClock,
  fadeBandsFor,
  foliageWindOffset,
  type ShaderPatch,
} from './foliage.ts';
import { CAMERA_DISTANCE, frameAt, groundFrame } from './rig.ts';

/** A stand-in for what three hands `onBeforeCompile`, built from the real chunk sources. */
function shaderFor(kind: 'lambert' | 'depth'): ShaderPatch {
  const lib = kind === 'lambert' ? ShaderLib.lambert : ShaderLib.depth;
  return { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: {} };
}

/** Run a material's `onBeforeCompile` and hand back what it wrote. */
function compile(material: { onBeforeCompile?: unknown }, kind: 'lambert' | 'depth'): ShaderPatch {
  const shader = shaderFor(kind);
  const patch = material.onBeforeCompile as (s: unknown, r: unknown) => void;
  patch(shader, undefined);
  return shader;
}

describe('the card-foliage material', () => {
  it('injects the same wind displacement into the material and its depth twin', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 12 }, 0x2c4a30, 'canopy|test');
    const lit = compile(pair.material, 'lambert');
    const shadow = compile(pair.depth, 'depth');

    // The constant, present in both. Not "a function called foliageWind" — the text.
    assert.ok(lit.vertexShader.includes(FOLIAGE_WIND_GLSL), 'the material lost the wind');
    assert.ok(shadow.vertexShader.includes(FOLIAGE_WIND_GLSL), 'the depth material lost the wind');
    assert.ok(lit.vertexShader.includes(FOLIAGE_VERTEX_DECL));
    assert.ok(shadow.vertexShader.includes(FOLIAGE_VERTEX_DECL));

    // And the call site, which is where a copy would drift even if the function did not.
    const call = 'transformed += foliageWind(position, instanceMatrix[3].xyz, aCard.x);';
    assert.ok(lit.vertexShader.includes(call), 'the material never calls it');
    assert.ok(shadow.vertexShader.includes(call), 'the depth material never calls it');

    // The clip has to happen in the shadow pass too, or every tree drops a solid rectangle.
    assert.ok(shadow.fragmentShader.includes(FOLIAGE_MASK_GLSL), 'the depth material has no mask');
    assert.ok(shadow.fragmentShader.includes('diffuseColor.a *= foliageMask('));
  });

  it('drives both from the same uniform objects, not from equal values', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 12 }, 0x2c4a30, 'canopy|test');
    const lit = compile(pair.material, 'lambert');
    const shadow = compile(pair.depth, 'depth');

    for (const name of ['uTime', 'uWind', 'uWindDir', 'uWindStrength', 'uWindSpeed', 'uWindGain', 'uTreeHeight']) {
      assert.ok(lit.uniforms[name], `the material never got ${name}`);
      assert.equal(shadow.uniforms[name], lit.uniforms[name], `${name} is two objects, so it can drift`);
    }
    // The shared clock is the object itself, so `world3d.breathe` and the F key reach both.
    assert.equal(lit.uniforms['uTime'], clock.uTime);
    assert.equal(shadow.uniforms['uWind'], clock.uWind);
  });

  it('displaces identically when driven from either material', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 14 }, 0x2c4a30, 'canopy|test');
    const lit = compile(pair.material, 'lambert');
    const shadow = compile(pair.depth, 'depth');

    // Two callers, each reading the uniform objects out of *its own* shader's record. If the depth
    // path had been given its own copies, these would agree at t=0 and diverge the moment the frame
    // loop wrote a time to one of them — which is exactly the bug, so the sweep moves the clock.
    const from = (record: Record<string, { value: unknown }>): typeof clock =>
      ({
        uTime: record['uTime'],
        uWind: record['uWind'],
        uWindDir: record['uWindDir'],
        uWindStrength: record['uWindStrength'],
        uWindSpeed: record['uWindSpeed'],
      }) as unknown as typeof clock;
    const litClock = from(lit.uniforms);
    const shadowClock = from(shadow.uniforms);
    const litOwn = { uTreeHeight: lit.uniforms['uTreeHeight'], uWindGain: lit.uniforms['uWindGain'] };
    const shadowOwn = { uTreeHeight: shadow.uniforms['uTreeHeight'], uWindGain: shadow.uniforms['uWindGain'] };

    let samples = 0;
    for (let step = 0; step < 40; step++) {
      // The frame loop writes here, and only here. Both shaders must see it.
      clock.uTime.value = step * 0.137;
      for (const y of [0, 3.5, 9, 14]) {
        for (const card of [0, 0.31, 0.87]) {
          const local: readonly [number, number, number] = [0.4, y, -0.2];
          const origin: readonly [number, number, number] = [17.5 + step, 0, -8.25];
          const a = foliageWindOffset(local, origin, card, litClock, litOwn as never);
          const b = foliageWindOffset(local, origin, card, shadowClock, shadowOwn as never);
          assert.deepEqual(b, a, `the shadow displaced differently at t=${clock.uTime.value}, y=${y}`);
          samples += 1;
        }
      }
    }
    assert.equal(samples, 40 * 4 * 3);
  });

  it('moves nothing at the foot, everything at the tip, and nothing at all with the wind off', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 10 }, 0x2c4a30, 'canopy|test');
    const own = pair.uniforms;
    clock.uTime.value = 3.7;
    const origin: readonly [number, number, number] = [11, 0, 22];

    // `-0` is not `0` to `deepStrictEqual` and is to everything else; normalised so the assertion is
    // about the tree standing still rather than about IEEE 754.
    const still = (v: readonly [number, number, number]): number[] => v.map((n) => n + 0);
    assert.deepEqual(still(foliageWindOffset([0, 0, 0], origin, 0.5, clock, own)), [0, 0, 0], 'the base moved');

    const tip = foliageWindOffset([0, 10, 0], origin, 0.5, clock, own);
    const mid = foliageWindOffset([0, 5, 0], origin, 0.5, clock, own);
    // `bend = h * h`, so the tip moves four times as far as the half-way point. A cantilever, not a
    // shear — see `FOLIAGE_WIND_GLSL`.
    assert.ok(Math.abs(tip[0]) > Math.abs(mid[0]) * 3.5, 'the sway is not a cantilever');

    // Bounded by the strength, as a fraction of height: gust <= 1, flutter <= 0.18.
    const bound = WIND_STRENGTH * 10 * 1.2;
    assert.ok(Math.abs(tip[0]) <= bound && Math.abs(tip[2]) <= bound, `${tip[0]} exceeds ${bound}`);
    // The arc drops rather than stretching.
    assert.ok(tip[1] <= 0);

    clock.uWind.value = 0;
    assert.deepEqual(still(foliageWindOffset([0, 10, 0], origin, 0.5, clock, own)), [0, 0, 0]);
  });

  it('sways two trees a metre apart out of phase', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 10 }, 0x2c4a30, 'canopy|test');
    clock.uTime.value = 1.25;
    const here = foliageWindOffset([0, 10, 0], [40, 0, 40], 0.5, clock, pair.uniforms);
    const there = foliageWindOffset([0, 10, 0], [41, 0, 40], 0.5, clock, pair.uniforms);
    assert.notEqual(here[0], there[0], 'the whole treeline is one sheet');
  });

  it('clips rather than blends, and is two-sided so the moon can rim it', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 10 }, 0x2c4a30, 'canopy|test');
    // §5: *"clip, not blend, so they shadow-map and sort correctly"*. `transparent` true would put
    // every tree in the transparent queue behind the rain, with no depth write and no sort.
    assert.equal(pair.material.transparent, false);
    assert.equal(pair.material.alphaToCoverage, true);
    assert.ok(pair.material.alphaTest > 0.3 && pair.material.alphaTest < 0.5);
    // `DoubleSide` is 2 in three's enum. Both the translucency term and the crossed cards need it.
    assert.equal(pair.material.side, 2);
    assert.equal(pair.depth.side, 2);
  });

  it('fades the ground layer outside the frame and not across it, everywhere on the envelope', () => {
    /*
     * **The M5a bug this pins.** `uFade` is compared against `-mvPosition.z`, which is depth along the
     * camera's own forward axis and not distance from the character — and at the authored pose the
     * camera stands 36 m back (`rig.CAMERA_DISTANCE`) at 64 degrees. So every square metre of ground
     * the frame contains sits at a view depth of 31.8 m to 41.4 m, and M5a's `[17, 27]` put the whole
     * frame past the end of the fade: `vFoliageFade` was 0 everywhere and the alpha test discarded
     * every tuft in the world. Nothing caught it, because nothing about it is testable as a picture
     * and every *placement* was correct.
     *
     * **What M6 changes.** M5b's fix was a hand-authored `[38, 45]` checked against one frame. The
     * rig's distance and pitch are live now, and the frame's view-depth range travels from 21.2..27.6
     * at the near/steep corner to 37.9..65.6 at the far/shallow one — a band that is right at one of
     * those is wrong at the other three in *both* of M5a's directions at once. So the band is derived
     * (`fadeBandsFor`) and this walks the whole envelope: at each pose, the fade must start inside the
     * frame's far half and finish outside the frame entirely.
     */
    const radians = Math.PI / 180;
    // The frame at the authored pose, by M5b's own approximation, so the numbers above stay checkable.
    const half = Math.tan((CAMERA_FOV_DEGREES / 2) * radians) * CAMERA_DISTANCE;
    const groundDepth = (2 * half) / Math.sin(CAMERA_PITCH_DEGREES * radians);
    const swing = (groundDepth / 2) * Math.cos(CAMERA_PITCH_DEGREES * radians);
    assert.ok(CAMERA_DISTANCE - swing > 30, 'the authored frame no longer starts where M5b measured it');

    for (const [distance, pitch] of ENVELOPE_POSES) {
      const frame = frameAt(distance, pitch, 16 / 9);
      const bands = fadeBandsFor(frame);
      const at = `${distance} m / ${pitch}°`;
      for (const [label, band] of [['grass', bands.grass] as const, ['kit understory', bands.kitLeaf] as const]) {
        assert.ok(band[0] < band[1], `${label}'s fade band is inverted at ${at}`);
        // The fade must not begin in the near half of the frame, or the ground in front of the
        // character is already dissolving. Half the frame's depth, not a fixed four metres: the frame
        // is 6 m deep at one corner of the clamp and 28 at another.
        const midway = (frame.nearDepth + frame.farDepth) / 2;
        assert.ok(band[0] > midway, `${label} starts fading at ${band[0]} m, inside the near half at ${at}`);
        // …and it must *finish* outside the frame, or the far strip of ground ends at a hard line
        // where the last tuft is cut off mid-view rather than softening into the fog. **This one is
        // unconditional and it is the one that protects a picture**: everything else here is economy.
        assert.ok(band[1] > frame.farDepth, `${label} finishes at ${band[1]} m, inside the frame at ${at}`);
        /*
         * It must also begin *before* the far edge, or it is a fade that never happens and the
         * clutter accumulates out to the streaming ring's rim — **where the band can fit at all.**
         *
         * M9 is what put a caveat on that. `fadeBandFor` starts the grass at `near + 2/3 span`, so
         * the grass has `span/3` of room before the far edge and always fits; the kit's band is the
         * same one pushed {@link KIT_FADE_LAG} = 2 m further out, which needs `span > 3 · 2` = 6 m of
         * view depth to still land inside the frame. The old clamp's shallowest frame was 6.4 m deep
         * (24 m at 64°) and cleared it by 13 cm. M9's envelope reaches 3 m, where the same 64° frame
         * is **1.1 m** deep, and no fixed lag can fit inside that.
         *
         * The remedy is to say so rather than to shrink the lag: a lag that scaled with the span
         * would have to shrink at 24 m/64° too — the margin there is 13 cm — and that is a pose the
         * owner has been playing in for two days. What actually happens at a 1 m-deep frame is that
         * the kit's understory never dissolves, which costs a handful of instances in a frame that
         * contains a handful of instances, and produces no line anywhere because the assertion above
         * still holds. So: assert the economy where it is available and the *safety* where it is not.
         */
        const fits = frame.farDepth - frame.nearDepth > 3 * KIT_FADE_LAG;
        if (label === 'grass' || fits) {
          assert.ok(band[0] < frame.farDepth, `${label} never fades: it starts at ${band[0]} m, past ${at}`);
        } else {
          // Uniformly opaque across the whole frame — not partly faded, which would be a gradient
          // running the wrong way. `>=` and not `>`: the two are equal at exactly `span = 3 · lag`.
          assert.ok(band[0] >= frame.farDepth, `${label} half-fades at ${at}`);
          assert.ok(frame.farDepth - frame.nearDepth < 3 * KIT_FADE_LAG + 1e-9, `${at} should have fitted`);
        }
      }
      // The kit's understory outlives the tufts, which is the only difference between the two bands.
      assert.equal(bands.kitLeaf[0] - bands.grass[0], KIT_FADE_LAG);
      assert.equal(bands.kitLeaf[1] - bands.grass[1], KIT_FADE_LAG);
    }

    // The band a material is *born* with is the authored pose's, and it is M5b's hand-picked [38, 45]
    // to within half a metre — which is why making it derived changed no picture.
    assert.ok(Math.abs(GRASS_FADE[0] - 38) < 0.5, `${GRASS_FADE[0]}`);
    assert.ok(Math.abs(GRASS_FADE[1] - 45) < 0.5, `${GRASS_FADE[1]}`);
    assert.ok(KIT_LEAF_FADE[0] > GRASS_FADE[0] && KIT_LEAF_FADE[1] > GRASS_FADE[1]);

    /*
     * And the reason the derivation had to exist at all, stated as an assertion rather than as a
     * paragraph: **M5b's fixed band is M5a's bug again at the far corner of the clamp.** At 48 m and
     * 45 degrees the frame reaches 65.6 m of view depth and `[38, 45]` has faded everything past
     * 45 m to nothing — two thirds of the visible ground, bare, with the tufts vanishing at a hard
     * line a third of the way up the screen. Same failure, same invisibility, one wheel notch away.
     */
    const widest = groundFrame(48, 45, 16 / 9);
    assert.ok(GRASS_FADE[1] < widest.farDepth * 0.8, 'the fixed band would still have covered the widest frame');
    const derived = fadeBandsFor(widest);
    assert.ok(derived.grass[1] > widest.farDepth, 'the derived band must outlive the widest frame');
    assert.ok(derived.grass[0] > GRASS_FADE[1], 'the derived band starts past where the fixed one ended');
  });

  it('lets a textured leaf switch the procedural mask off with a uniform, not a define', () => {
    /*
     * M5b. A Quaternius leaf carries its silhouette in its own alpha channel, so the needle spray
     * this file draws must contribute nothing but the distance fade — and the switch has to be a
     * *uniform*, because the whole reason `pool.ts` costs seven programs and not two hundred is that
     * every difference inside a family is one.
     *
     * The branch is coherent across every fragment of every draw (one material, one value), so it
     * costs a jump and not a program, and `uMaskKind` is already the uniform the needle and the blade
     * are told apart by.
     */
    const clock = createWindClock();
    const needle = createFoliageMaterial(clock, { height: 12, maskKind: MASK_NEEDLE }, 0x2c4a30, 'canopy|baked');
    const textured = createFoliageMaterial(clock, { height: 2, maskKind: MASK_TEXTURE }, 0xffffff, 'kit|leaf');
    assert.equal(needle.uniforms.uMaskKind.value, MASK_NEEDLE);
    assert.equal(textured.uniforms.uMaskKind.value, MASK_TEXTURE);
    // One shader, both materials: the mask block is a constant and the kind is read out of it.
    const lit = compile(needle.material, 'lambert');
    const kit = compile(textured.material, 'lambert');
    assert.ok(lit.fragmentShader.includes(FOLIAGE_MASK_GLSL));
    assert.ok(kit.fragmentShader.includes(FOLIAGE_MASK_GLSL));
    assert.ok(FOLIAGE_MASK_GLSL.includes('if (uMaskKind > 1.5) return vFoliageFade;'));
    // …and the same `customProgramCacheKey`, so the family is one family however many masks it has.
    assert.equal(needle.material.customProgramCacheKey?.(), textured.material.customProgramCacheKey?.());
  });

  it('carries a leaf’s texture into its depth twin, or the shadow is the card it is painted on', () => {
    // Trap 1 in its second costume. The wind was the first thing the shadow could lose; the *mask* is
    // the second, and for a kit leaf the mask lives in the texture. `pool.dressKit` writes both from
    // one object; this asserts the constructor already wired them that way.
    const clock = createWindClock();
    const map = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    const pair = createFoliageMaterial(clock, { height: 2, maskKind: MASK_TEXTURE }, 0xffffff, 'kit|leaf', map);
    assert.equal(pair.material.map, map);
    assert.equal(pair.depth.map, map, 'the depth material cannot see the leaf’s alpha');
    map.dispose();
  });

  it('bends the normal onto a cone and its tiers, not onto a sphere', () => {
    const clock = createWindClock();
    const pair = createFoliageMaterial(clock, { height: 12, coneSlope: 5.6, tiers: 8, droop: 0.35 }, 0x2c4a30, 'c');
    const lit = compile(pair.material, 'lambert');
    // Trap 2, as a text assertion, because it is the *recipe* that is wrong in the broadleaf version
    // and a recipe is a shape of code. The cone shell must use the slope; the tiers must use the
    // card's own height; and the spherical `normalize(position - centre)` must be nowhere near it.
    assert.ok(lit.vertexShader.includes('radial.x * uConeSlope'), 'the cone shell lost its slope');
    assert.ok(lit.vertexShader.includes('fract(tierCoord * uTiers)'), 'the tiers are gone');
    assert.ok(lit.vertexShader.includes('foliageBentNormal(position, objectNormal, aCard.y)'));
    // The broadleaf recipe, absent: a normal bent toward a *centre* rather than onto a shell.
    assert.ok(!/normalize\s*\(\s*local\s*-/.test(lit.vertexShader), 'that is the broadleaf recipe');
    // The depth pass has no normals and must not pay for one.
    const shadow = compile(pair.depth, 'depth');
    assert.ok(!shadow.vertexShader.includes('foliageBentNormal'), 'the depth pass bent a normal');
  });
});
