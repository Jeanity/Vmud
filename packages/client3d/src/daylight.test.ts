/**
 * The two skies, and the rule that the second one may not cost the first anything.
 *
 * M4 was the go/no-go and it was decided on a *night*. So the first thing this file asserts is that
 * M5b did not quietly retune it: {@link NIGHT_SKY} must be `night.ts`'s own published constants,
 * number for number, and a `NightRig` nobody speaks to must still be the rig M4 signed off. Everything
 * after that is about the day recipe being a real second answer rather than the night with the gain
 * turned up.
 *
 * The sweep is the interesting part. `skyAt` is pure, so twenty-four hours can be walked headlessly
 * and asked the questions a screenshot cannot: does the sun ever pass through the horizon (where
 * `fitShadowCamera`'s basis is worth nothing), does any channel leave the envelope its two keys set,
 * and is midnight the same sky whichever side you approach it from.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Scene } from 'three';

import {
  DAWN_SKY,
  DAY_SKY,
  DUSK_SKY,
  NIGHT_SKY,
  SKY_KEYS,
  SKY_PRESETS,
  clockOf,
  hourOf,
  normaliseHour,
  skyAt,
} from './daylight.ts';
import {
  FOG_DENSITY,
  GROUND_COLOUR,
  HEMISPHERE_INTENSITY,
  MOON_COLOUR,
  MOON_FROM,
  MOON_INTENSITY,
  NIGHT_COLOUR,
  NightRig,
  SKY_COLOUR,
} from './night.ts';

describe('the night, unregressed', () => {
  it('is M4’s own constants, number for number', () => {
    // The one assertion in this file that is about M5b *not* doing something. If a day recipe is ever
    // tuned by nudging these, this is where it is caught.
    assert.equal(NIGHT_SKY.sky, SKY_COLOUR);
    assert.equal(NIGHT_SKY.ground, GROUND_COLOUR);
    assert.equal(NIGHT_SKY.hemisphere, HEMISPHERE_INTENSITY);
    assert.equal(NIGHT_SKY.sun, MOON_COLOUR);
    assert.equal(NIGHT_SKY.sunIntensity, MOON_INTENSITY);
    assert.deepEqual(NIGHT_SKY.from, MOON_FROM);
    assert.equal(NIGHT_SKY.fog, NIGHT_COLOUR);
    assert.equal(NIGHT_SKY.fogDensity, FOG_DENSITY);
  });

  it('leaves a rig nobody has spoken to exactly as M4 built it', () => {
    const rig = new NightRig(new Scene());
    assert.equal(rig.sky, undefined, 'a fresh rig claims a recipe it was never given');
    assert.equal(rig.hemisphere.color.getHex(), SKY_COLOUR);
    assert.equal(rig.moon.intensity, MOON_INTENSITY);
    assert.equal(rig.fog.density, FOG_DENSITY);
    rig.dispose();
  });

  it('applies a whole sky in one write, shadow fit included', () => {
    const rig = new NightRig(new Scene());
    rig.refit(10, 0, -5);
    const before = { ...rig.fit };
    rig.sky = DAY_SKY;
    assert.equal(rig.hemisphere.color.getHex(), DAY_SKY.sky);
    assert.equal(rig.hemisphere.groundColor.getHex(), DAY_SKY.ground);
    assert.equal(rig.hemisphere.intensity, DAY_SKY.hemisphere);
    assert.equal(rig.moon.color.getHex(), DAY_SKY.sun);
    assert.equal(rig.moon.intensity, DAY_SKY.sunIntensity);
    assert.equal(rig.fog.color.getHex(), DAY_SKY.fog);
    assert.equal(rig.fog.density, DAY_SKY.fogDensity);
    assert.equal(rig.sky?.name, 'day');
    // The shadow follows in the same write, not on the next frame: pressing **G** must swing the
    // shadows and the colours together or the flip reads as a bug for one frame.
    assert.notDeepEqual({ ...rig.fit }, before, 'the shadow camera did not move with the sun');
    // Still two lights and no ambient. M4's rule, which a day recipe is exactly the temptation to break.
    const lights = rig.hemisphere.parent?.children.filter((child) => 'isLight' in child) ?? [];
    assert.equal(lights.length, 2);
    // Back to night, and back to M4's numbers.
    rig.sky = NIGHT_SKY;
    assert.equal(rig.fog.density, FOG_DENSITY);
    assert.equal(rig.hemisphere.intensity, HEMISPHERE_INTENSITY);
    rig.dispose();
  });
});

describe('the day recipe', () => {
  it('is a different answer, not the night with the gain turned up', () => {
    // A warm sun several times the moon over a *sky-blue* hemisphere. If the ratio between the key
    // and the fill were the night's, the world would flatten into overcast — which is the grey-box
    // look M4 was checked against and the one thing daylight must not arrive at.
    assert.ok(DAY_SKY.sunIntensity > NIGHT_SKY.sunIntensity * 2, 'the sun is not a key light');
    assert.ok(DAY_SKY.sunIntensity / DAY_SKY.hemisphere > NIGHT_SKY.sunIntensity / NIGHT_SKY.hemisphere);
    // Sky-blue: blue is the largest channel and the whole colour is bright.
    assert.ok((DAY_SKY.sky & 0xff) > ((DAY_SKY.sky >> 16) & 0xff), 'the day sky is not blue');
    assert.ok(((DAY_SKY.sky >> 16) & 0xff) > 0x60, 'the day sky is as dark as the night one');
    // Warm sun: red over blue.
    assert.ok(((DAY_SKY.sun >> 16) & 0xff) > (DAY_SKY.sun & 0xff), 'the sun is cold');
    // Fog pushed back and brightened — the brief's exact instruction.
    assert.ok(DAY_SKY.fogDensity < NIGHT_SKY.fogDensity / 2, 'the day fog is not pushed back');
    assert.ok(((DAY_SKY.fog >> 16) & 0xff) > ((NIGHT_SKY.fog >> 16) & 0xff), 'the day fog is not brightened');
    // Exposure comes down: Neutral maps a sunlit surface to most of the range on its own, and 1.6
    // would put a lit clearing through the bloom threshold.
    assert.ok(DAY_SKY.exposure < NIGHT_SKY.exposure);
    // The sun is higher than the moon and still nowhere near overhead — `night.ts` refuses a vertical
    // light because a vertical light throws no readable shadow.
    assert.ok(DAY_SKY.from.y > NIGHT_SKY.from.y);
    assert.ok(DAY_SKY.from.y < 0.9);
  });

  it('keeps dawn and dusk low and warm, and puts them on opposite sides of the sky', () => {
    for (const recipe of [DAWN_SKY, DUSK_SKY]) {
      assert.ok(recipe.from.y > 0.1 && recipe.from.y < 0.35, `${recipe.name} is not a low sun`);
      assert.ok(((recipe.sun >> 16) & 0xff) > (recipe.sun & 0xff) + 0x30, `${recipe.name}'s sun is not warm`);
    }
    // Dawn in the east, dusk in the west — or the shadows would rake the same way all day.
    assert.ok(DAWN_SKY.from.x * DUSK_SKY.from.x < 0, 'dawn and dusk are on the same side of the sky');
  });
});

describe('the sweep', () => {
  it('never lets the sun touch the horizon, at any hour', () => {
    // `fitShadowCamera` builds an orthonormal basis from this vector, and `shadowUpFor` guards the
    // *vertical* degenerate case. This is the other end: a sun at y = 0 is a shadow camera looking
    // along the ground, whose near plane and far plane are the same plane.
    for (let hour = 0; hour < 24; hour += 0.25) {
      const recipe = skyAt(hour);
      assert.ok(recipe.from.y > 0.1, `at ${clockOf(hour)} the sun is at y=${recipe.from.y}`);
      const length = Math.hypot(recipe.from.x, recipe.from.y, recipe.from.z);
      assert.ok(Math.abs(length - 1) < 1e-9, `at ${clockOf(hour)} the sun vector is ${length} long`);
    }
  });

  it('stays inside the envelope its keys set, and wraps at midnight', () => {
    const intensities = SKY_KEYS.map((key) => key.recipe.sunIntensity);
    const densities = SKY_KEYS.map((key) => key.recipe.fogDensity);
    const exposures = SKY_KEYS.map((key) => key.recipe.exposure);
    for (let hour = 0; hour < 24; hour += 0.25) {
      const recipe = skyAt(hour);
      assert.ok(recipe.sunIntensity >= Math.min(...intensities) - 1e-9);
      assert.ok(recipe.sunIntensity <= Math.max(...intensities) + 1e-9);
      assert.ok(recipe.fogDensity >= Math.min(...densities) - 1e-9);
      assert.ok(recipe.fogDensity <= Math.max(...densities) + 1e-9);
      assert.ok(recipe.exposure >= Math.min(...exposures) - 1e-9);
      assert.ok(recipe.exposure <= Math.max(...exposures) + 1e-9);
      for (const channel of [recipe.sky, recipe.ground, recipe.sun, recipe.fog]) {
        assert.ok(channel >= 0 && channel <= 0xffffff, `at ${clockOf(hour)} a colour left the range`);
      }
    }
    // A clock is a circle: 24:00 is 00:00, and -1:00 is 23:00.
    assert.deepEqual(skyAt(24), skyAt(0));
    assert.deepEqual(skyAt(-1), skyAt(23));
    assert.equal(normaliseHour(25.5), 1.5);
    assert.equal(normaliseHour(-0.5), 23.5);
  });

  it('lands exactly on a key at that key’s hour', () => {
    // The **G** key jumps to an authored sky rather than to a blend, so the two presets have to be
    // reachable exactly. A `smoothstep` at t=0 is 0, which is what makes this true.
    for (const key of SKY_KEYS) {
      const at = skyAt(key.hour);
      assert.equal(at.sky, key.recipe.sky, `${key.recipe.name} at ${clockOf(key.hour)}`);
      assert.equal(at.sunIntensity, key.recipe.sunIntensity);
      assert.equal(at.fogDensity, key.recipe.fogDensity);
      assert.equal(at.exposure, key.recipe.exposure);
    }
    assert.equal(hourOf(NIGHT_SKY), 0);
    assert.equal(hourOf(DAY_SKY), 12);
    assert.deepEqual([...SKY_PRESETS], [NIGHT_SKY, DAY_SKY]);
  });

  it('prints an hour a human can read', () => {
    assert.equal(clockOf(0), '00:00');
    assert.equal(clockOf(13.5), '13:30');
    assert.equal(clockOf(24), '00:00');
  });
});
