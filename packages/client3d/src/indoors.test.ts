/**
 * Light without sky — the properties of M6's two interior recipes, and of the threshold between them.
 *
 * `daylight.test.ts`'s sibling: the recipes are data and the rig is not touched, so everything here
 * is arithmetic over four constants. What it is actually protecting is a set of *relations* rather
 * than any one number — an interior must be dimmer than the day, foggier than the day, and lit from
 * more steeply overhead than any hour of it — because the numbers themselves are the owner's to
 * retune and the relations are what make the second rendering mode a second mode at all.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DAWN_SKY, DAY_SKY, DUSK_SKY, NIGHT_SKY, mixSky, skyAt } from './daylight.ts';
import {
  CAVE_SKY,
  ENCLOSURES,
  INDOOR_BLEND_SECONDS,
  INSIDE_SKY,
  approach,
  indoorSky,
  skyFor,
} from './indoors.ts';

const OUTDOOR = [NIGHT_SKY, DAWN_SKY, DAY_SKY, DUSK_SKY];

describe('the interior recipes', () => {
  it('names one recipe per enclosure and nothing for the open air', () => {
    assert.deepEqual([...ENCLOSURES], ['outdoor', 'inside', 'cave']);
    assert.equal(indoorSky('outdoor'), undefined);
    assert.equal(indoorSky('inside'), INSIDE_SKY);
    assert.equal(indoorSky('cave'), CAVE_SKY);
  });

  it('lights from overhead rather than from a horizon, at every hour', () => {
    // **The shadow decision, as an assertion.** The key is kept — a body with no contact shadow
    // floats, and on a bare plank floor there is nothing else putting it on the ground — but it is
    // re-pointed from a sun's 41 degrees to 72 and 76. Anything shallower would be a sunbeam in a
    // cellar, which is the failure this recipe exists to avoid.
    for (const indoor of [INSIDE_SKY, CAVE_SKY]) {
      assert.ok(indoor.sunIntensity > 0, `${indoor.name} has no key light — bodies would float`);
      const elevation = (Math.asin(indoor.from.y) * 180) / Math.PI;
      assert.ok(elevation > 70, `${indoor.name}'s key is only ${elevation.toFixed(0)}° up`);
      for (const outdoor of OUTDOOR) {
        assert.ok(indoor.from.y > outdoor.from.y, `${indoor.name} is shallower than ${outdoor.name}`);
      }
      // A unit vector to six places, because `fitShadowCamera` builds an orthonormal basis from it
      // and one that was even 0.2% short would scale the shadow volume by that much every frame.
      assert.ok(
        Math.abs(Math.hypot(indoor.from.x, indoor.from.y, indoor.from.z) - 1) < 1e-5,
        `${indoor.name}'s key vector is not unit`,
      );
    }
  });

  it('is dimmer and closer than any hour of the day', () => {
    for (const indoor of [INSIDE_SKY, CAVE_SKY]) {
      for (const outdoor of OUTDOOR) {
        // The hemisphere is a *gradient*, not a sky, and indoors it is the ceiling's bounce over the
        // floor's — so it stays, at a fraction of the strength. Switching it off would be a shader
        // permutation and would flatten every box in the room.
        assert.ok(indoor.hemisphere > 0, `${indoor.name} has no hemisphere term`);
        assert.ok(indoor.hemisphere < outdoor.hemisphere, `${indoor.name} is brighter than ${outdoor.name}`);
        assert.ok(indoor.sunIntensity < outdoor.sunIntensity, `${indoor.name}'s key beats ${outdoor.name}'s`);
      }
      // **The fog is the wall of the world.** There is one light rig for the whole scene, so an
      // interior recipe lights the street outside the door too; the honest answer is to make the far
      // field go dark rather than to add lights. At the widest frame the dolly can show — 65.6 m of
      // view depth — an interior must leave less than a third of a surface's own colour.
      const far = Math.exp(-((65.6 * indoor.fogDensity) ** 2));
      assert.ok(far < 0.34, `${indoor.name} leaves ${(100 * far).toFixed(0)}% at the far edge`);
      // …and it must not swallow the room the player is standing in. The near edge of the default
      // frame is 31.8 m of view depth and must keep most of itself.
      const near = Math.exp(-((31.8 * indoor.fogDensity) ** 2));
      assert.ok(near > 0.5, `${indoor.name} leaves only ${(100 * near).toFixed(0)}% at the near edge`);
      assert.ok(indoor.fogDensity > DAY_SKY.fogDensity * 2, `${indoor.name} is no foggier than noon`);
      // Exposure comes up, because everything in frame is now its own reflected light.
      assert.ok(indoor.exposure > DAY_SKY.exposure);
    }
    // A cavern is colder, dimmer and foggier than an inn on every axis. That is the whole difference
    // between the two recipes and it is the thing that makes "underground" read as underground.
    assert.ok(CAVE_SKY.sunIntensity < INSIDE_SKY.sunIntensity);
    assert.ok(CAVE_SKY.hemisphere < INSIDE_SKY.hemisphere);
    assert.ok(CAVE_SKY.fogDensity > INSIDE_SKY.fogDensity);
  });
});

describe('crossing the threshold', () => {
  it('is the hour at one end and the room at the other', () => {
    for (let hour = 0; hour < 24; hour++) {
      const outdoor = skyAt(hour);
      // Out of doors, or not yet across: the hour wins, byte for byte, so a world spent outside is
      // exactly M5b's.
      assert.equal(skyFor(outdoor, 'outdoor', 0), outdoor);
      assert.equal(skyFor(outdoor, 'outdoor', 1), outdoor);
      assert.equal(skyFor(outdoor, 'inside', 0), outdoor);
      // Fully indoors: **the hour has no effect at all**, which is the whole of "the daylight keys
      // do nothing weird inside". `[`, `]` and `G` still move the hour; the frame does not change.
      assert.equal(skyFor(outdoor, 'inside', 1), INSIDE_SKY);
      assert.equal(skyFor(outdoor, 'cave', 1), CAVE_SKY);
    }
  });

  it('interpolates every field monotonically in between', () => {
    const outdoor = DAY_SKY;
    let previous = outdoor.fogDensity;
    for (let step = 1; step <= 10; step++) {
      const blended = skyFor(outdoor, 'inside', step / 10);
      assert.ok(blended.fogDensity >= previous, 'the fog went backwards mid-threshold');
      previous = blended.fogDensity;
      assert.ok(blended.sunIntensity <= DAY_SKY.sunIntensity);
      assert.ok(blended.sunIntensity >= INSIDE_SKY.sunIntensity);
      assert.ok(Math.abs(Math.hypot(blended.from.x, blended.from.y, blended.from.z) - 1) < 1e-5);
    }
    assert.equal(previous, INSIDE_SKY.fogDensity);
  });

  it('mixes the same way an hour does, and renormalises the light', () => {
    // One interpolator, so a hue that took the sRGB path across dawn cannot take the linear path
    // across a doorway. The direction is the part that matters most here: 41 degrees to 72 is a
    // 31-degree swing, and an unnormalised half-way sum is measurably short.
    const half = mixSky(DAY_SKY, INSIDE_SKY, 0.5);
    assert.ok(Math.abs(Math.hypot(half.from.x, half.from.y, half.from.z) - 1) < 1e-9);
    const naive = Math.hypot(
      (DAY_SKY.from.x + INSIDE_SKY.from.x) / 2,
      (DAY_SKY.from.y + INSIDE_SKY.from.y) / 2,
      (DAY_SKY.from.z + INSIDE_SKY.from.z) / 2,
    );
    assert.ok(naive < 0.995, 'the unnormalised mix is not short enough for this test to be meaningful');
    assert.equal(mixSky(DAY_SKY, INSIDE_SKY, 0).fogDensity, DAY_SKY.fogDensity);
    assert.equal(mixSky(DAY_SKY, INSIDE_SKY, 1).fogDensity, INSIDE_SKY.fogDensity);
    // Clamped, because the caller's blend is a float that walks toward a target.
    assert.equal(mixSky(DAY_SKY, INSIDE_SKY, -1).fogDensity, DAY_SKY.fogDensity);
    assert.equal(mixSky(DAY_SKY, INSIDE_SKY, 2).fogDensity, INSIDE_SKY.fogDensity);
  });

  it('crosses in about a third of a second, symmetrically, and lands exactly', () => {
    const step = 1 / 60;
    let value = 0;
    let frames = 0;
    while (value < 1 && frames < 600) {
      value = approach(value, 1, step);
      frames += 1;
    }
    const inbound = frames / 60;
    assert.equal(value, 1, 'the blend never reached its target — it must snap, not asymptote');
    // Long enough to read as a fade and short enough that the geometry, which swaps in one frame,
    // is not left waiting for it. Two blend constants either side of a third of a second.
    assert.ok(inbound > INDOOR_BLEND_SECONDS, `crossed in ${inbound.toFixed(2)} s — that is a cut`);
    assert.ok(inbound < INDOOR_BLEND_SECONDS * 6, `crossed in ${inbound.toFixed(2)} s — that is a dissolve`);

    let back = 1;
    let out = 0;
    while (back > 0 && out < 600) {
      back = approach(back, 0, step);
      out += 1;
    }
    assert.equal(back, 0);
    // **Symmetric.** A player who steps in and straight back out must not finish the second
    // transition at the first one's rate, which a linear ramp on a counter would do.
    assert.equal(out, frames, 'stepping out takes a different time from stepping in');
    // A zero step is a paused tab, not a teleport.
    assert.equal(approach(0.4, 1, 0), 0.4);
    console.log(`[M6 threshold] crossed in ${frames} frames (${inbound.toFixed(2)} s) each way at 60 fps`);
  });
});
