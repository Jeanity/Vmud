/**
 * The snow, headless — the buffers, the thinning, the wind mapping, and the crossfade.
 *
 * `rain.test.ts`'s standing argument applies unchanged: the shader cannot be run here and the look
 * cannot be judged here, so what is pinned is everything the shader *depends on* and cannot check for
 * itself. Every assertion below corresponds to a line in `snow.ts`'s `VERTEX` that would produce a
 * quietly wrong picture rather than an error — a speed of zero is a flake hanging in the air, a seed
 * outside the box wraps on its first frame, a stride that disagrees with the attribute's `itemSize`
 * is a blizzard made of one flake's data read four ways, and a frequency ratio near a small integer
 * is a field of metronomes.
 *
 * Two things here are *not* in the rain's file and are the substance of this slice:
 *
 * 1. **The tumble's periods** are checked against the flake's own life in the box. "No flake repeats
 *    its path on screen" is a claim about arithmetic and it is settled by arithmetic.
 * 2. **The crossfade's accounting.** Rain turning into snow is the one thing a two-field weather
 *    system can visibly get wrong, and the invariants — the weights sum to one across a crossing,
 *    the outgoing field keeps the strength it had, both fields are drawn for the fade and not one
 *    frame longer, a reversal mid-fade does not corrupt anything — are all pure and all checked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RAIN_BOX, RAIN_DROPS, RAIN_STRIDE, Rain, rainSeeds } from './rain.ts';
import {
  PRECIP_CROSSFADE_SECONDS,
  PrecipFade,
  RAIN_DENSITY_MIN,
  RAIN_FULL_PRECIP,
  SkyClock,
  precipDensityOf,
  snowDensityOf,
} from './sky.ts';
import {
  SNOW_BOX,
  SNOW_DRIFT_STRIDE,
  SNOW_FALL,
  SNOW_FLAKES,
  SNOW_OMEGA,
  SNOW_OMEGA_RATIO,
  SNOW_SPEED,
  SNOW_STRIDE,
  SNOW_WIND_DIR,
  SNOW_WIND_FULL,
  SNOW_WIND_MAX,
  Snow,
  snowDrift,
  snowSeeds,
} from './snow.ts';
import type { SkyView } from '@mygame/shared';
import { DEFAULT_HOUR_MS } from './sky.ts';
import { WET_RISE_SECONDS, Wetness } from './wetness.ts';

/** `sky.test.ts`'s fixture, restated: a served sky with everything overridable. */
function view(over: Partial<SkyView> = {}): SkyView {
  return {
    hour: 15,
    progress: 0,
    hourMs: DEFAULT_HOUR_MS,
    day: 13,
    month: 23,
    year: 1060,
    sunlight: 'day',
    sky: 'clear',
    precip: 0,
    wind: 6,
    temp: 18,
    light: 40,
    sun: true,
    moon: false,
    ...over,
  };
}

/* -------------------------------------------------------------------------- */
/* The buffers                                                                 */
/* -------------------------------------------------------------------------- */

describe('the snow buffers', () => {
  it('are two vec4s per flake, allocated once, and 288 KB for the whole blizzard', () => {
    const seeds = snowSeeds(SNOW_FLAKES);
    const drift = snowDrift(SNOW_FLAKES);
    assert.equal(SNOW_STRIDE, 4, 'a GLSL attribute is at most a vec4');
    assert.equal(SNOW_DRIFT_STRIDE, 4);
    assert.equal(seeds.length, SNOW_FLAKES * SNOW_STRIDE);
    assert.equal(drift.length, SNOW_FLAKES * SNOW_DRIFT_STRIDE);
    assert.equal(seeds.BYTES_PER_ELEMENT, 4);
    assert.equal(drift.BYTES_PER_ELEMENT, 4);
    // `rain.test.ts` accounts its 96 KB the same way and for the same reason: this is the number the
    // "zero CPU per frame" claim rests on, because it is uploaded exactly once.
    const bytes = seeds.byteLength + drift.byteLength;
    assert.equal(bytes, SNOW_FLAKES * (SNOW_STRIDE + SNOW_DRIFT_STRIDE) * 4);
    assert.equal(bytes, 288_000);
    const rainBytes = rainSeeds(RAIN_DROPS).byteLength;
    assert.equal(rainBytes, 96_000);
    console.log(
      `[snow] ${SNOW_FLAKES} flakes = ${(bytes / 1024).toFixed(0)} KiB uploaded once, ` +
        `against the rain's ${RAIN_DROPS} drops at ${(rainBytes / 1024).toFixed(0)} KiB`,
    );
  });

  it('lives in exactly the volume the rain does, because the crossfade draws both at once', () => {
    // Not tidiness. Two storms in two different boxes cross-fade as one receding while another
    // approaches; one box makes the transition a change of *form*. See `snow.ts`'s SNOW_BOX.
    assert.deepEqual({ ...SNOW_BOX }, { ...RAIN_BOX });
  });

  it('seeds every flake inside the box the shader wraps against', () => {
    const seeds = snowSeeds(SNOW_FLAKES);
    for (let i = 0; i < SNOW_FLAKES; i++) {
      const at = i * SNOW_STRIDE;
      const x = seeds[at]!;
      const z = seeds[at + 1]!;
      const y = seeds[at + 2]!;
      const speed = seeds[at + 3]!;
      assert.ok(x >= 0 && x < SNOW_BOX.width, `flake ${i} seeded at x=${x}`);
      assert.ok(z >= 0 && z < SNOW_BOX.depth, `flake ${i} seeded at z=${z}`);
      assert.ok(y >= 0 && y < SNOW_BOX.height, `flake ${i} seeded at y=${y}`);
      // Zero would hang a flake in mid-air for the session, and the *size* is scaled by the same
      // number, so it would be an invisible one.
      assert.ok(speed >= SNOW_SPEED.min && speed <= SNOW_SPEED.max, `flake ${i} has speed ${speed}`);
    }
  });

  it('gives every flake a tumble that outlives it', () => {
    // **The claim, as arithmetic.** A flake crosses the box in `height / (fall * speed)` seconds and
    // then wraps; its path is periodic in the least common multiple of the two sinusoids. The ratio
    // band excludes 1 and 2, so even at its worst rational (3/2) the figure needs three cycles of the
    // slow one — and that is longer than any flake is on screen. So nothing ever visibly repeats.
    const drift = snowDrift(SNOW_FLAKES);
    const seeds = snowSeeds(SNOW_FLAKES);
    let shortestPath = Infinity;
    let longestLife = 0;
    for (let i = 0; i < SNOW_FLAKES; i++) {
      const at = i * SNOW_DRIFT_STRIDE;
      const slow = drift[at]!;
      const fast = drift[at + 1]!;
      const phaseA = drift[at + 2]!;
      const phaseB = drift[at + 3]!;
      assert.ok(slow >= SNOW_OMEGA.min && slow <= SNOW_OMEGA.max, `flake ${i} slow omega ${slow}`);
      const ratio = fast / slow;
      assert.ok(
        ratio >= SNOW_OMEGA_RATIO.min - 1e-6 && ratio <= SNOW_OMEGA_RATIO.max + 1e-6,
        `flake ${i} has a frequency ratio of ${ratio}`,
      );
      // The band's whole job: never 1 (one sinusoid, a metronome) and never 2 (a closed figure at
      // one slow period).
      assert.ok(ratio > 1.05 && ratio < 1.99, `flake ${i} would metronome at ratio ${ratio}`);
      assert.ok(phaseA >= 0 && phaseA < Math.PI * 2);
      assert.ok(phaseB >= 0 && phaseB < Math.PI * 2);
      // Worst case: the pair closes after three cycles of the slow sinusoid.
      shortestPath = Math.min(shortestPath, (3 * 2 * Math.PI) / slow);
      longestLife = Math.max(longestLife, SNOW_BOX.height / (SNOW_FALL * seeds[i * SNOW_STRIDE + 3]!));
    }
    assert.ok(
      shortestPath > longestLife,
      `a flake lives ${longestLife.toFixed(1)} s and its path closes in ${shortestPath.toFixed(1)} s`,
    );
    console.log(
      `[snow] fall ${SNOW_FALL} m/s: a flake crosses the ${SNOW_BOX.height} m box in ` +
        `${(SNOW_BOX.height / SNOW_FALL).toFixed(1)} s at base speed (up to ${longestLife.toFixed(1)} s), ` +
        `and the slowest tumble closes no sooner than ${shortestPath.toFixed(1)} s`,
    );
  });

  it('falls far slower than the rain, which is most of what makes it snow', () => {
    // The single number that does the most work. `rain.ts` is 30 m/s; anything at that speed is a
    // streak whatever shape it is given.
    assert.ok(SNOW_FALL < 3, `snow falling at ${SNOW_FALL} m/s is sleet`);
    assert.ok(SNOW_FALL > 1, 'and snow that hangs still reads as ash');
    // Wider per-flake spread than the rain's 0.8..1.3, because a slow field shows its uniformity.
    const spread = SNOW_SPEED.max / SNOW_SPEED.min;
    assert.ok(spread > 1.3 / 0.8, `the snow's speed spread ${spread.toFixed(2)} is no wider than the rain's`);
  });

  it('is deterministic, and different per seed and per buffer', () => {
    assert.deepEqual(snowSeeds(64), snowSeeds(64), 'two builds of one blizzard must be byte-identical');
    assert.deepEqual(snowDrift(64), snowDrift(64));
    assert.notDeepEqual(snowSeeds(64, 1), snowSeeds(64, 2), 'the seed is not reaching the hash');
    assert.notDeepEqual(snowDrift(64, 1), snowDrift(64, 2));
    // And the snow is not the rain rotated: a shared salt would make one field the other's ghost,
    // which is visible the instant the crossfade puts them on screen together.
    const snowX = Array.from({ length: 64 }, (_, i) => snowSeeds(64)[i * SNOW_STRIDE]!);
    const rainX = Array.from({ length: 64 }, (_, i) => rainSeeds(64)[i * RAIN_STRIDE]!);
    assert.notDeepEqual(snowX, rainX);
  });

  it('spreads the flakes rather than clustering them on the lattice', () => {
    // The property `density`'s prefix thinning rests on: index order must not correlate with
    // position, or drawing the first tenth of the buffer would draw a tenth of the *box*.
    const seeds = snowSeeds(2048);
    const buckets = new Array<number>(8).fill(0);
    for (let i = 0; i < 2048; i++) {
      const x = seeds[i * SNOW_STRIDE]!;
      const bucket = Math.min(7, Math.floor((x / SNOW_BOX.width) * 8));
      buckets[bucket] = (buckets[bucket] ?? 0) + 1;
    }
    for (const [index, count] of buckets.entries()) {
      assert.ok(count > 180 && count < 330, `octile ${index} holds ${count} of 2048 flakes`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The mesh                                                                    */
/* -------------------------------------------------------------------------- */

describe('the snow field', () => {
  it('is one instanced mesh that never leaves the frustum and never writes depth', () => {
    const field = new Snow(128);
    const geometry = field.mesh.geometry;
    assert.equal(geometry.getAttribute('aSeed').itemSize, SNOW_STRIDE);
    assert.equal(geometry.getAttribute('aSeed').count, 128);
    assert.equal(geometry.getAttribute('aDrift').itemSize, SNOW_DRIFT_STRIDE);
    assert.equal(geometry.getAttribute('aDrift').count, 128);
    // Four corners and two triangles, instanced 128 times: one draw call.
    assert.equal(geometry.getAttribute('position').count, 4);
    assert.equal(geometry.getIndex()?.count, 6);
    assert.equal(field.mesh.frustumCulled, false, 'the real positions are in the shader, not the bounds');
    assert.equal(field.mesh.castShadow, false);
    assert.equal(field.mesh.receiveShadow, false);
    const material = field.mesh.material;
    assert.ok(!Array.isArray(material));
    assert.equal(material.depthWrite, false, 'nine thousand quads writing depth is a grey sheet');
    assert.equal(material.transparent, true);
    field.dispose();
  });

  it('blends as matter rather than as light, unlike the rain', () => {
    // **The one deliberate divergence from `rain.ts`.** A raindrop is a specular highlight and adds
    // light; a snowflake is a white solid and hides what is behind it. Additive white over
    // `DAY_SKY`'s pale blue at exposure 0.95 has almost nowhere to go, so the world's *common*
    // weather would be invisible for half of every day. See `snow.ts`'s header §1.
    const field = new Snow(8);
    const rain = new Rain(8);
    const snowMaterial = field.mesh.material;
    const rainMaterial = rain.mesh.material;
    assert.ok(!Array.isArray(snowMaterial) && !Array.isArray(rainMaterial));
    assert.notEqual(snowMaterial.blending, rainMaterial.blending, 'the snow is blending additively');
    // And it draws after the rain, which is the order that reads while both are on screen.
    assert.ok(field.mesh.renderOrder > rain.mesh.renderOrder);
    field.dispose();
    rain.dispose();
  });

  it('advances only two uniforms a frame, and the toggle is the mesh', () => {
    const field = new Snow(16);
    field.update(12.5, 100, 2, -50);
    assert.equal(field.material.uniforms['uTime']?.value, 12.5);
    const centre = field.material.uniforms['uCentre']?.value as { x: number; z: number };
    assert.deepEqual([centre.x, centre.z], [100, -50], 'the wrap is keyed on this position');
    assert.equal(field.enabled, true);
    field.enabled = false;
    assert.equal(field.mesh.visible, false);
    field.dispose();
  });

  it('thins the blizzard by drawing fewer flakes, without reallocating a thing', () => {
    const field = new Snow(1_000);
    const seeds = field.mesh.geometry.getAttribute('aSeed');
    const drift = field.mesh.geometry.getAttribute('aDrift');
    assert.equal(field.density, 1);
    assert.equal(field.drawn, 1_000);
    field.density = 0.25;
    assert.equal(field.drawn, 250);
    assert.equal(field.mesh.geometry.getAttribute('aSeed'), seeds, 'the seed buffer was rebuilt');
    assert.equal(field.mesh.geometry.getAttribute('aDrift'), drift, 'the tumble buffer was rebuilt');
    assert.equal(seeds.count, 1_000, 'the seeds are still all there — only the draw is shorter');
    field.density = 1;
    assert.equal(field.drawn, 1_000);
    // Clamped, because the caller is dividing one wire field by another.
    field.density = 4;
    assert.equal(field.density, 1);
    field.density = -1;
    assert.equal(field.density, 0);
    assert.equal(field.drawn, 0);
    field.density = Number.NaN;
    assert.equal(field.density, 1, 'a NaN rate must not empty the sky');
    field.dispose();
  });

  it('maps the world’s wind to a drift a breeze can be told from a hurricane', () => {
    const field = new Snow(8);
    const uniform = field.material.uniforms['uWind']?.value as { x: number; y: number };
    assert.deepEqual([uniform.x, uniform.y], [0, 0], 'a fresh field is not already blowing');

    // The fixture's wind 12 — a drift. The angle off vertical is what the eye judges.
    field.wind = 12;
    const breeze = field.windMetres;
    assert.ok(Math.abs(breeze - (SNOW_WIND_MAX * 12) / SNOW_WIND_FULL) < 1e-9);
    const breezeAngle = (Math.atan2(breeze, SNOW_FALL) * 180) / Math.PI;
    assert.ok(breezeAngle > 10 && breezeAngle < 35, `a breeze slants ${breezeAngle.toFixed(0)}°`);

    // The source's hurricane. `SEASON_HURRICANE` assigns 100 rather than drifting toward it.
    field.wind = 100;
    assert.equal(field.windMetres, SNOW_WIND_MAX);
    const galeAngle = (Math.atan2(SNOW_WIND_MAX, SNOW_FALL) * 180) / Math.PI;
    assert.ok(galeAngle > 65, `a hurricane only slants ${galeAngle.toFixed(0)}°`);
    // Pointed along the client-side bearing, because the wire carries a speed and no direction.
    assert.ok(Math.abs(uniform.x - SNOW_WIND_DIR[0] * SNOW_WIND_MAX) < 1e-6);
    assert.ok(Math.abs(uniform.y - SNOW_WIND_DIR[1] * SNOW_WIND_MAX) < 1e-6);
    assert.ok(Math.abs(Math.hypot(SNOW_WIND_DIR[0], SNOW_WIND_DIR[1]) - 1) < 0.01, 'the bearing is not a unit vector');

    // `wind` is unbounded above in the source, so the ramp clamps rather than extrapolating.
    field.wind = 400;
    assert.equal(field.windMetres, SNOW_WIND_MAX);
    field.wind = -3;
    assert.equal(field.windMetres, 0);
    field.wind = Number.NaN;
    assert.equal(field.windMetres, 0);
    console.log(
      '[snow] wind slant: ' +
        [0, 12, 25, 40, 70, 100]
          .map((w) => {
            const drift = SNOW_WIND_MAX * Math.min(1, w / SNOW_WIND_FULL);
            return `${w}->${((Math.atan2(drift, SNOW_FALL) * 180) / Math.PI).toFixed(0)}°`;
          })
          .join('  '),
    );
    field.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The density ladder                                                          */
/* -------------------------------------------------------------------------- */

describe('how hard it snows', () => {
  it('rides the same five prose bands the rain does, over its own particle ceiling', () => {
    // The ladder is the *rate*'s and the rate does not know its phase — one `precipRate` in the
    // source, split by temperature at the moment of drawing. So the mapping is shared and the
    // ceiling in particles is not: a full blizzard is 9,000 flakes where a downpour is 6,000 drops.
    assert.equal(snowDensityOf(view({ sky: 'clear', precip: 0 })), 0);
    assert.equal(snowDensityOf(view({ sky: 'very_cloudy', precip: 80 })), 0, 'a rate with no state is not snow');
    const flurry = snowDensityOf(view({ sky: 'snowing', precip: 1, temp: -4 }));
    assert.ok(flurry >= RAIN_DENSITY_MIN && flurry < 0.22, `a flurry is ${flurry}`);
    let previous = 0;
    for (const precip of [1, 11, 31, 51, 81, 100]) {
      const density = snowDensityOf(view({ sky: 'snowing', precip, temp: -4 }));
      assert.ok(density >= previous, `density went backwards at rate ${precip}`);
      previous = density;
    }
    assert.equal(snowDensityOf(view({ sky: 'snowing', precip: RAIN_FULL_PRECIP, temp: -4 })), 1);
    assert.equal(snowDensityOf(view({ sky: 'snowing', precip: 100, temp: -4 })), 1, 'nothing above the top band');
    console.log(
      '[snow] flakes by rate: ' +
        [1, 20, 40, 60, 80]
          .map(
            (p) =>
              `${p}->${Math.round(snowDensityOf(view({ sky: 'snowing', precip: p, temp: -4 })) * SNOW_FLAKES)}`,
          )
          .join('  ') +
        ` flakes of ${SNOW_FLAKES}`,
    );
  });

  it('is the same ladder the rain rides, to the last bit', () => {
    // Not "similar": the same function, gated twice. A drift between the two would be a storm that
    // changed strength when it changed phase.
    for (const precip of [0, 1, 13, 40, 79, 80, 100]) {
      const rainy = view({ sky: 'raining', precip, temp: 6 });
      const snowy = view({ sky: 'snowing', precip, temp: -6 });
      assert.equal(precipDensityOf(rainy), precipDensityOf(snowy));
      assert.equal(snowDensityOf(snowy), precipDensityOf(snowy));
    }
    // And the ungated ladder never returns zero, which is what lets the fade hold a strength through
    // the message that says the storm has stopped.
    assert.equal(precipDensityOf(view({ sky: 'clear', precip: 0 })), RAIN_DENSITY_MIN);
  });

  it('drives the field’s instance count as a prefix of the seeded buffer', () => {
    const field = new Snow(SNOW_FLAKES);
    for (const precip of [1, 20, 40, 60, 80, 100]) {
      field.density = snowDensityOf(view({ sky: 'snowing', precip, temp: -5 }));
      const wanted = Math.round(SNOW_FLAKES * snowDensityOf(view({ sky: 'snowing', precip, temp: -5 })));
      assert.equal(field.drawn, wanted, `rate ${precip} drew ${field.drawn} flakes`);
      assert.ok(field.drawn <= SNOW_FLAKES);
    }
    assert.equal(field.mesh.geometry.getAttribute('aSeed').count, SNOW_FLAKES, 'the buffer never shrank');
    field.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The crossfade                                                               */
/* -------------------------------------------------------------------------- */

describe('rain becoming snow', () => {
  it('never lets the two fields jump: the weights sum to one across the whole crossing', () => {
    const fade = new PrecipFade();
    // A steady rain at rate 55, settled.
    const wet = precipDensityOf(view({ sky: 'raining', precip: 55, temp: 3 }));
    for (let i = 0; i < 200; i++) {
      fade.want('rain', wet);
      fade.advance(1 / 60);
    }
    assert.equal(fade.weights.rain, 1);
    assert.equal(fade.weights.snow, 0);
    assert.equal(fade.rain, wet);
    assert.equal(fade.draws, 1, 'a settled storm is one draw call');

    // "The rain turns to snow." — `weather.c:628`, the message this whole class exists for. The
    // snow's rate is deliberately *different* from the rain's it replaces, so the total on screen
    // actually has to travel and the per-frame step below is measuring something.
    const cold = precipDensityOf(view({ sky: 'snowing', precip: 80, temp: -1 }));
    assert.notEqual(cold, wet);
    let frames = 0;
    let sawBoth = 0;
    let biggestStep = 0;
    let previous = fade.rain + fade.snow;
    while (fade.weights.snow < 1 && frames < 600) {
      fade.want('snow', cold);
      fade.advance(1 / 60);
      frames += 1;
      // **The invariant.** Both ramps move at one rate in opposite directions, so the total on
      // screen is exactly one storm's worth at every instant of the crossing — never two, which
      // would read as a squall, and never a gap, which would read as a stutter.
      assert.ok(
        Math.abs(fade.weights.rain + fade.weights.snow - 1) < 1e-9,
        `the weights summed to ${(fade.weights.rain + fade.weights.snow).toFixed(4)}`,
      );
      if (fade.crossing) sawBoth += 1;
      const total = fade.rain + fade.snow;
      biggestStep = Math.max(biggestStep, Math.abs(total - previous));
      previous = total;
    }
    const seconds = frames / 60;
    assert.ok(
      Math.abs(seconds - PRECIP_CROSSFADE_SECONDS) < 0.05,
      `the crossing took ${seconds.toFixed(2)} s`,
    );
    assert.ok(sawBoth > 60, 'the two fields were never on screen together, so this was a cut');
    // No frame of the fade is itself a pop.
    assert.ok(biggestStep < 0.05, `one frame moved the total density by ${biggestStep.toFixed(3)}`);
    assert.equal(fade.rain, 0);
    assert.equal(fade.snow, cold);
    assert.equal(fade.draws, 1, 'the second draw call outlived the fade');
    console.log(
      `[snow] rain->snow in ${seconds.toFixed(2)} s, two draw calls for ${sawBoth} frames of it ` +
        `and one either side; largest single-frame change ${biggestStep.toFixed(4)}`,
    );
  });

  it('costs two draw calls for the fade and not one frame longer', () => {
    const fade = new PrecipFade();
    fade.want('rain', 0.8);
    fade.advance(PRECIP_CROSSFADE_SECONDS);
    assert.equal(fade.draws, 1);
    assert.equal(fade.crossing, false);

    fade.want('snow', 0.8);
    fade.advance(1 / 60);
    assert.equal(fade.draws, 2, 'the crossing is the only time the weather costs two draws');
    assert.equal(fade.crossing, true);

    // Exactly one crossfade later, back to one.
    for (let i = 0; i < 200; i++) {
      fade.want('snow', 0.8);
      fade.advance(1 / 60);
    }
    assert.equal(fade.draws, 1);
    assert.equal(fade.crossing, false);

    // And a storm that simply stops leaves nothing drawn at all.
    for (let i = 0; i < 200; i++) {
      fade.want('none', 0);
      fade.advance(1 / 60);
    }
    assert.equal(fade.draws, 0);
    assert.equal(fade.rain, 0);
    assert.equal(fade.snow, 0);
  });

  it('holds the outgoing strength rather than reading the wire it has just left', () => {
    // The message that says "it is snowing now" carries the *snow's* rate and says nothing about the
    // rain's — and a stopping storm sends `precip: 0`. A field reading the live rate would collapse
    // to the floor of the ladder before it had finished leaving, which is a two-stage pop.
    const fade = new PrecipFade();
    const hard = precipDensityOf(view({ sky: 'raining', precip: 80 }));
    assert.equal(hard, 1);
    for (let i = 0; i < 200; i++) {
      fade.want('rain', hard);
      fade.advance(1 / 60);
    }
    // The storm stops dead: `sky` goes clear and `precip` goes to zero in one message.
    fade.want('none', precipDensityOf(view({ sky: 'clear', precip: 0 })));
    fade.advance(PRECIP_CROSSFADE_SECONDS / 2);
    // Half way out, at half of the strength it *was*, not at half of the floor.
    assert.ok(Math.abs(fade.rain - hard * 0.5) < 1e-9, `the rain fell out through ${fade.rain}`);
    fade.advance(PRECIP_CROSSFADE_SECONDS / 2);
    assert.equal(fade.rain, 0);
  });

  it('survives a temperature hovering on zero, which is exactly when this happens', () => {
    // `weather.c` flips on `temp > 0`, so a storm sitting at the boundary can turn twice inside one
    // fade. Two independent ramps have no "what was showing" state to corrupt: they simply turn
    // round. A single-`t` design is what this test would break.
    const fade = new PrecipFade();
    for (let i = 0; i < 200; i++) {
      fade.want('rain', 0.7);
      fade.advance(1 / 60);
    }
    // Half a fade toward snow…
    for (let i = 0; i < 48; i++) {
      fade.want('snow', 0.7);
      fade.advance(1 / 60);
    }
    const half = fade.weights.snow;
    assert.ok(half > 0.4 && half < 0.6, `half a fade is ${half.toFixed(2)}`);
    // …and back to rain before it lands.
    for (let i = 0; i < 200; i++) {
      fade.want('rain', 0.7);
      fade.advance(1 / 60);
      assert.ok(fade.weights.rain >= 0 && fade.weights.rain <= 1);
      assert.ok(fade.weights.snow >= 0 && fade.weights.snow <= 1);
      assert.ok(fade.rain + fade.snow <= 0.7 + 1e-9, 'a reversal put more weather on screen than there is');
    }
    assert.equal(fade.weights.rain, 1);
    assert.equal(fade.weights.snow, 0);
    assert.equal(fade.draws, 1);
  });

  it('is not upset by a frame delta of zero, a negative one, or a NaN', () => {
    const fade = new PrecipFade();
    fade.want('snow', 0.5);
    fade.advance(0);
    assert.equal(fade.snow, 0);
    fade.advance(-1);
    assert.equal(fade.snow, 0, 'a backwards frame ran the fade in reverse');
    fade.advance(Number.NaN);
    assert.equal(fade.snow, 0);
    fade.want('snow', Number.NaN);
    fade.advance(10);
    assert.equal(fade.snow, 0, 'a NaN density became a blizzard');
    fade.want('snow', 4);
    fade.advance(10);
    assert.equal(fade.snow, 1, 'the density is clamped, because it is a quotient of wire fields');
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring, the way `main.ts` does it                                           */
/* -------------------------------------------------------------------------- */

/** `main.ts`'s `precipWanted()`, restated. See `sky.test.ts` for the writers' own block. */
function precipWanted(override: boolean | undefined, clock: SkyClock): 'none' | 'rain' | 'snow' {
  if (override === false) return 'none';
  if (override === true) return clock.falling !== 'none' ? clock.falling : clock.would;
  if (!clock.served) return 'rain';
  return clock.falling;
}

describe('the frame’s two fields', () => {
  it('switches on `fallingOf` and nothing else, and the roof still stops both', () => {
    // The frame's own five lines, driven the way `main.ts` drives them. The bugs this slice can
    // actually ship are wiring bugs, and a wiring bug is invisible to a file that calls one function.
    const clock = new SkyClock();
    const rain = new Rain(600);
    const field = new Snow(900);
    const fade = new PrecipFade();
    const wet = new Wetness();
    let t = 0;
    const step = (roofed: boolean, override?: boolean): void => {
      t += 1 / 60;
      fade.want(precipWanted(override, clock), override === true ? 1 : (clock.density ?? 1));
      fade.advance(1 / 60);
      rain.enabled = !roofed && fade.rain > 0;
      field.enabled = !roofed && fade.snow > 0;
      rain.density = fade.rain;
      field.density = fade.snow;
      field.wind = clock.wind;
      wet.update(t, rain.enabled || field.enabled);
    };
    // Ten seconds: longer than the crossfade (1.6 s) and longer than `WET_RISE_SECONDS` (6 s), so
    // "settled" means settled for the fade, the field and the ground alike.
    const settle = (roofed = false, override?: boolean): void => {
      for (let i = 0; i < 600; i++) step(roofed, override);
    };

    // A clear afternoon: neither field draws, and nothing is wet.
    clock.accept(view({ sky: 'clear', precip: 0, temp: 12 }), 0);
    settle();
    assert.equal(rain.enabled, false);
    assert.equal(field.enabled, false);
    assert.equal(wet.value, 0);

    // The zone's weather turns to snow. Nothing was pressed; `fallingOf` did all of it.
    clock.accept(view({ sky: 'snowing', precip: 60, temp: -7, wind: 34 }), 0);
    settle();
    assert.equal(field.enabled, true, 'the world said snow and the snow did not fall');
    assert.equal(rain.enabled, false, 'the rain fell in a blizzard');
    assert.ok(field.drawn > 700 && field.drawn <= 900, `rate 60 drew ${field.drawn} of 900 flakes`);
    assert.equal(field.wind, 34, 'the wind never reached the field');
    assert.ok(field.windMetres > 2 && field.windMetres < 3);
    // **Melt.** Snow wets the ground on the rain's own ramp — see `main.ts` for why, and for the
    // frost whitening that is deliberately not built.
    assert.equal(wet.value, 1, 'a blizzard left the street dry');

    // It warms up mid-storm. The rain takes over and the snow leaves, over the crossfade.
    clock.accept(view({ sky: 'raining', precip: 60, temp: 2, wind: 34 }), 0);
    step(false);
    assert.equal(rain.enabled, true);
    assert.equal(field.enabled, true, 'the switch was a cut rather than a fade');
    settle();
    assert.equal(rain.enabled, true);
    assert.equal(field.enabled, false);
    assert.ok(rain.drawn > 450 && rain.drawn <= 600);

    // Step under a roof while it is pouring: M4's gate, unchanged, and now over both fields.
    step(true);
    assert.equal(rain.enabled, false, 'the roof gate leaked');
    assert.equal(field.enabled, false);
    // And the roof dries at `wetness.ts`'s own rate, with the world still raining outside.
    const dryFrom = t;
    while (wet.value > 0 && t - dryFrom < 90) step(true);
    assert.equal(wet.value, 0);
    assert.equal(clock.falling, 'rain', 'the world stopped raining because a character went indoors');

    // Back out into it, and the same six-second rise with nothing pressed.
    const backAt = t;
    while (wet.value < 1 && t - backAt < 30) step(false);
    assert.equal(wet.value, 1);
    assert.ok(Math.abs(t - backAt - WET_RISE_SECONDS) < 0.5);

    rain.dispose();
    field.dispose();
  });

  it('gives a hard R the world’s own phase at full strength', () => {
    // The override's semantics are the previous slice's; what is new is that "full strength" now
    // means whichever of the two fields the world (or `temp`) says this place has.
    const clock = new SkyClock();
    const rain = new Rain(600);
    const field = new Snow(900);
    const fade = new PrecipFade();
    const run = (override: boolean | undefined): void => {
      for (let i = 0; i < 300; i++) {
        fade.want(precipWanted(override, clock), override === true ? 1 : (clock.density ?? 1));
        fade.advance(1 / 60);
      }
      rain.enabled = fade.rain > 0;
      field.enabled = fade.snow > 0;
      rain.density = fade.rain;
      field.density = fade.snow;
    };

    // A light snow at rate 4. The world's own density is near the floor.
    clock.accept(view({ sky: 'snowing', precip: 4, temp: -9 }), 0);
    run(undefined);
    assert.equal(field.enabled, true);
    assert.ok(field.density < 0.25, `a flurry drew ${field.density.toFixed(2)} of the field`);
    // **R** off, then **R** on: the same weather at full strength, not a different weather.
    run(false);
    assert.equal(field.enabled, false);
    assert.equal(rain.enabled, false);
    run(true);
    assert.equal(field.enabled, true, 'forcing weather on in a flurry gave rain');
    assert.equal(field.density, 1, 'a hard R is M4’s storm at full strength');
    assert.equal(rain.enabled, false);

    // A dry frozen sky: **R** gives the snow this place would have, off `temp` alone.
    clock.accept(view({ sky: 'mostly_clear', precip: 0, temp: -18 }), 0);
    run(undefined);
    assert.equal(field.enabled, false);
    assert.equal(rain.enabled, false);
    run(true);
    assert.equal(field.enabled, true, '`temp` never reached the override');
    assert.equal(rain.enabled, false);

    // A dry warm sky: the same key gives rain, which is M4's look on demand.
    clock.accept(view({ sky: 'mostly_clear', precip: 0, temp: 24 }), 0);
    run(true);
    assert.equal(rain.enabled, true);
    assert.equal(field.enabled, false);

    rain.dispose();
    field.dispose();
  });
});
