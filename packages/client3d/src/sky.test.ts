/**
 * The live sky, headless — the clock, the weather gate, and what happens when a human grabs the wheel.
 *
 * Every question this slice can get wrong is arithmetic or state, and both are testable without a
 * GPU. What is *not* testable here is whether a storm-lit afternoon looks right, so nothing below
 * asserts a colour by value: the assertions are about **relations and invariants** — a dry sky must
 * leave M5b's recipes untouched at every hour, a step of the scrub must never be visible, a garbled
 * message must never be able to put the world at midnight, and the weather must stop at the door
 * because it rides M6's one threshold rather than a second one.
 *
 * The two integration blocks at the end drive the pieces the way `main.ts` does — the rain's three
 * writers composed in precedence order, and the wetness ramp fed from the answer — because the bugs
 * this slice can actually ship are wiring bugs, and a wiring bug is invisible to a file that only
 * ever calls one function.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SKY_STATES, type SkyState, type SkyView } from '@mygame/shared';

import { DAWN_SKY, DAY_SKY, DUSK_SKY, NIGHT_SKY, skyAt } from './daylight.ts';
import { CAVE_SKY, INSIDE_SKY, approach, skyFor } from './indoors.ts';
import { RAIN_DROPS, Rain } from './rain.ts';
import {
  DEFAULT_HOUR_MS,
  RAIN_DENSITY_MIN,
  RAIN_FULL_PRECIP,
  SKY_HOUR_STEP,
  STORM_EXPOSURE_LIFT,
  STORM_HEMISPHERE_DIM,
  STORM_SUN_DIM,
  SkyClock,
  displayHourOf,
  fallingOf,
  gloomOf,
  quantiseHour,
  rainDensityOf,
  rainVisibleFor,
  sanitiseSky,
  snowDensityOf,
  snowVisibleFor,
  stormy,
  wouldFall,
  type Falling,
} from './sky.ts';
import { WET_DRY_SECONDS, WET_RISE_SECONDS, Wetness } from './wetness.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/** A served sky, as the server builds it: hour 15 on the date a fresh server opens at. */
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

/** The four channels of a recipe that are colours, as bytes. */
function channels(hour: number): number[] {
  const recipe = skyAt(hour);
  const out: number[] = [];
  for (const hex of [recipe.sky, recipe.ground, recipe.sun, recipe.fog]) {
    out.push((hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The interpolation                                                           */
/* -------------------------------------------------------------------------- */

describe('the scrub', () => {
  it('is hour + progress + elapsed, so the sky moves between messages', () => {
    // The reason `progress` and `hourMs` are on the wire at all: without them a client can only step
    // the sky once every seventy-five seconds, and dawn arrives as a cut.
    const v = view({ hour: 3, progress: 0.25 });
    assert.equal(displayHourOf(v, 1_000, 1_000), 3.25);
    assert.equal(displayHourOf(v, 1_000, 1_000 + DEFAULT_HOUR_MS / 2), 3.75);
    assert.equal(displayHourOf(v, 1_000, 1_000 + DEFAULT_HOUR_MS), 4.25);
    // A quarter of the way through a message's silence the sky is a quarter of an hour further on —
    // there is no waiting for the next message and no stepping when it lands.
    assert.equal(displayHourOf(v, 0, DEFAULT_HOUR_MS * 0.04), 3.29);
  });

  it('crosses the hour boundary and the day boundary without a seam', () => {
    // 23:54 plus half an hour is 00:24 the next day, not 24.4.
    assert.ok(Math.abs(displayHourOf(view({ hour: 23, progress: 0.9 }), 0, DEFAULT_HOUR_MS * 0.5) - 0.4) < 1e-9);
    // And a socket that died leaves the sky running: the world keeps time whether or not anyone is
    // listening, so two whole game days of silence wrap round to the same hour rather than saturating.
    const twoDays = DEFAULT_HOUR_MS * 48;
    assert.ok(Math.abs(displayHourOf(view({ hour: 6, progress: 0 }), 0, twoDays) - 6) < 1e-9);
    assert.ok(Math.abs(displayHourOf(view({ hour: 6 }), 0, twoDays + DEFAULT_HOUR_MS * 5) - 11) < 1e-9);
    // A stamp in the future is a bug somewhere; running the sky backwards would be a worse one.
    assert.equal(displayHourOf(view({ hour: 6 }), 5_000, 0), 6);
  });

  it('follows the rate the operator threw, from the message that carries it', () => {
    // `settings.gameHourMs` is the switch and the server re-sends `sky` to everyone the moment it
    // moves (`index.ts:10528`), so a change of *rate* arrives as data. Fifteen times faster here.
    const clock = new SkyClock();
    clock.accept(view({ hour: 10, progress: 0 }), 0);
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS), 11);
    clock.accept(view({ hour: 11, progress: 0, hourMs: 5_000 }), DEFAULT_HOUR_MS);
    // One real minute now buys twelve game hours rather than four fifths of one.
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS + 5_000), 12);
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS + 60_000), 23);
    // And the old rate is gone rather than averaged with the new one.
    assert.equal(clock.view?.hourMs, 5_000);
  });

  it('is quantised to a step no display can show, and never to a visible one', () => {
    // The frame cost, and M6's *"one comparison a frame and nothing else"* kept. A live clock that
    // re-applied the whole sky sixty times a second would quietly repeal that, so the hour is rounded
    // — and the rounding is only legitimate if the step it hides is smaller than one 8-bit level.
    const steps = Math.round(24 / SKY_HOUR_STEP);
    let worstChannel = 0;
    let moved = 0;
    let previous = channels(0);
    for (let i = 1; i <= steps; i++) {
      const next = channels(i * SKY_HOUR_STEP);
      let any = false;
      for (const [at, value] of next.entries()) {
        const delta = Math.abs(value - previous[at]!);
        if (delta > 0) any = true;
        if (delta > worstChannel) worstChannel = delta;
      }
      if (any) moved += 1;
      previous = next;
    }
    assert.equal(worstChannel, 1, 'a step of the scrub moves a colour by more than the smallest step there is');
    // A channel moves on roughly one step in ten — which *is* the "under a tenth of a level" claim,
    // measured on the far side of `mixHex`'s rounding where it can actually be observed.
    const fraction = moved / steps;
    assert.ok(fraction < 0.35, `a colour moves on ${(100 * fraction).toFixed(0)}% of steps`);
    // The float fields have no levels to round to, so they get the same claim as a ratio.
    for (let i = 0; i < steps; i++) {
      const a = skyAt(i * SKY_HOUR_STEP);
      const b = skyAt((i + 1) * SKY_HOUR_STEP);
      assert.ok(Math.abs(b.sunIntensity - a.sunIntensity) / a.sunIntensity < 0.002);
      assert.ok(Math.abs(b.exposure - a.exposure) / a.exposure < 0.002);
    }
    console.log(
      `[sky] ${steps} steps of ${(SKY_HOUR_STEP * 60).toFixed(2)} game-minutes a day; ` +
        `worst colour step ${worstChannel}/255, a channel moves on ${(100 * fraction).toFixed(1)}% of them`,
    );
  });

  it('lands on the grid, and never reports 24 for a caller comparing against 0', () => {
    assert.equal(quantiseHour(3.14159), Math.round(3.14159 * 512) / 512);
    const clock = new SkyClock();
    // 23:59:56 of a game day quantises up to a flat 24; a caller normalising its own copy would then
    // see 24 against 0 and re-apply the sky every frame for the 146 ms that lasts.
    clock.accept(view({ hour: 23, progress: 0.9999 }), 0);
    const hour = clock.hourAt(0);
    assert.ok(hour !== undefined && hour >= 0 && hour < 24, `hourAt returned ${hour}`);
    for (let ms = 0; ms < DEFAULT_HOUR_MS * 3; ms += 137) {
      const at = clock.hourAt(ms)!;
      assert.ok(at >= 0 && at < 24);
      assert.ok(Math.abs(at * 512 - Math.round(at * 512)) < 1e-9, `${at} is off the grid`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Resilience                                                                  */
/* -------------------------------------------------------------------------- */

describe('a message that cannot be trusted', () => {
  it('is clamped field by field, because the decoder validates only the tag', () => {
    // `decodeServerMessage` is three lines and checks that `t` is a string. Everything else arrives
    // as `unknown` in a `SkyView` costume, so these ranges are the actual contract and not paranoia.
    const clean = sanitiseSky({
      hour: 99.5,
      progress: 7,
      hourMs: -1,
      day: Number.NaN,
      sunlight: 'afternoon',
      sky: 'apocalypse',
      precip: 5_000,
      wind: -3,
      temp: -40,
      light: -20,
      sun: 'yes',
      moon: 1,
    })!;
    assert.ok(clean);
    assert.equal(clean.hour, 3.5, 'the hour is a circle, so 99.5 is 3.5');
    assert.equal(clean.progress, 1);
    assert.equal(clean.hourMs, 1, 'a rate of zero would divide the scrub by nothing');
    assert.equal(clean.day, 0);
    assert.equal(clean.sunlight, 'night', 'an unreadable band is rebuilt from the hour, not invented');
    assert.equal(clean.sky, 'clear');
    assert.equal(clean.precip, 100);
    assert.equal(clean.wind, 0);
    assert.equal(clean.temp, -40, 'below zero is the whole reason `sky` ever says snow');
    assert.equal(clean.light, 0);
    assert.equal(clean.sun, false, 'a truthy string is not a boolean');
    assert.equal(clean.moon, false);
    // Whatever it says, the scrub stays finite and on the dial.
    const hour = displayHourOf(clean, 0, 10_000);
    assert.ok(Number.isFinite(hour) && hour >= 0 && hour < 24);
  });

  it('never puts the world at midnight, and never throws', () => {
    const clock = new SkyClock();
    clock.accept(view({ hour: 9, progress: 0.5 }), 0);
    for (const rubbish of [undefined, null, 'sky', 42, true, Number.NaN]) {
      assert.equal(clock.accept(rubbish, 1_000), undefined, `${String(rubbish)} was accepted`);
    }
    // The held sky survived every one of them.
    assert.equal(clock.view?.hour, 9);
    assert.equal(clock.hourAt(0), 9.5);
    // An array *is* an object, so it gets through the shape gate and comes out as a view of defaults.
    // Recorded rather than guarded against: the gate is "is there anything here to clamp", and a
    // payload that reached this function at all already carried the `sky` tag the decoder checked.
    assert.equal(sanitiseSky([])?.hour, 0);
  });

  it('has nothing to say before the first message, and says nothing loudly', () => {
    // The old-server case, and the raced-`welcome` case: same state, same answer.
    const clock = new SkyClock();
    assert.equal(clock.served, false);
    assert.equal(clock.live, false);
    assert.equal(clock.overridden, false);
    assert.equal(clock.hourAt(123_456), undefined, 'the caller must keep the hour it already had');
    assert.equal(clock.raining, undefined, 'no opinion, so `override ?? world ?? true` keeps M4 rain');
    assert.equal(clock.rainDensity, undefined);
    assert.equal(clock.gloom, 0, 'a recipe must be untouched when nobody has said anything');
    assert.equal(clock.falling, 'none');
  });

  it('lets the newest message win whole, so a restarted server is not merged with the old one', () => {
    // The server came back a fortnight earlier in its year and four hours earlier in its day. There
    // is no field worth keeping and no merging to do: the newest message simply *is* the sky.
    const clock = new SkyClock();
    clock.accept(view({ hour: 20, day: 30, year: 1060, sky: 'raining', precip: 60, light: 0 }), 0);
    assert.equal(clock.falling, 'rain');
    assert.ok(clock.gloom > 0.9);
    clock.accept(view({ hour: 16, day: 2, year: 1061, sky: 'clear', precip: 0, light: 30 }), 10_000);
    assert.equal(clock.view?.year, 1061);
    assert.equal(clock.view?.day, 2);
    assert.equal(clock.falling, 'none');
    assert.equal(clock.gloom, 0, 'the old storm is still eating the new sky');
    // And the scrub restarts from the new message's stamp rather than from the old one's.
    assert.equal(clock.hourAt(10_000), 16);
    assert.equal(clock.hourAt(10_000 + DEFAULT_HOUR_MS), 17);
  });
});

/* -------------------------------------------------------------------------- */
/* The weather gate                                                            */
/* -------------------------------------------------------------------------- */

describe('what falls out of the sky', () => {
  it('reads the state rather than the rate, and tells the truth about snow', () => {
    assert.equal(fallingOf(view({ sky: 'raining' })), 'rain');
    assert.equal(fallingOf(view({ sky: 'snowing' })), 'snow');
    for (const dry of ['clear', 'mostly_clear', 'partly_cloudy', 'cloudy', 'very_cloudy'] as const) {
      assert.equal(fallingOf(view({ sky: dry })), 'none', `${dry} is not weather`);
    }
    // Every state the protocol has is covered by the three answers above — a state added to the wire
    // without a branch here would fall through to `none` and rain would silently stop working.
    assert.equal(SKY_STATES.length, 7);
    const answered = SKY_STATES.map((state: SkyState) => fallingOf(view({ sky: state })));
    assert.equal(answered.filter((f) => f !== 'none').length, 2);
  });

  it('sends snow to its own field, and the two gates never both answer', () => {
    // **The decision, taken.** `SNOW_FALLS_AS_RAIN` is retired rather than flipped: with `Snow`
    // beside `Rain` the constant would be a lie sitting in the file that says otherwise. What is
    // left is two gates over one truthful `fallingOf`, and they must partition rather than overlap —
    // a state that lit both would draw fifteen thousand particles for one storm.
    assert.equal(rainVisibleFor('rain'), true);
    assert.equal(rainVisibleFor('snow'), false, 'snow has its own field now');
    assert.equal(rainVisibleFor('none'), false);
    assert.equal(snowVisibleFor('snow'), true);
    assert.equal(snowVisibleFor('rain'), false);
    assert.equal(snowVisibleFor('none'), false);
    for (const state of SKY_STATES) {
      const falling = fallingOf(view({ sky: state }));
      assert.ok(
        !(rainVisibleFor(falling) && snowVisibleFor(falling)),
        `${state} lit both fields at once`,
      );
    }
    // And the density gates follow the visibility gates exactly, in both directions.
    assert.ok(snowDensityOf(view({ sky: 'snowing', precip: 40, temp: -3 })) > 0);
    assert.equal(rainDensityOf(view({ sky: 'snowing', precip: 40, temp: -3 })), 0);
    assert.ok(rainDensityOf(view({ sky: 'raining', precip: 40, temp: 8 })) > 0);
    assert.equal(snowDensityOf(view({ sky: 'raining', precip: 40, temp: 8 })), 0);
  });

  it('answers what would fall here, off `temp` alone, for the R key to show', () => {
    // The one caller of the field `sky.ts` used to list as unread. `weather.c:549` splits on
    // `temp > 0` and nothing else does, so this is the world's own answer and not an invention.
    assert.equal(wouldFall(view({ temp: 18 })), 'rain');
    assert.equal(wouldFall(view({ temp: 0.1 })), 'rain');
    assert.equal(wouldFall(view({ temp: 0 })), 'snow', 'zero is snow — the source’s own boundary');
    assert.equal(wouldFall(view({ temp: -14 })), 'snow');
    // No world at all is M4's world, which is rain: the client that has heard from no server keeps
    // the storm it always had.
    assert.equal(wouldFall(undefined), 'rain');
  });

  it('scales the density by the source’s own five prose bands', () => {
    assert.equal(rainDensityOf(view({ sky: 'clear', precip: 0 })), 0);
    assert.equal(rainDensityOf(view({ sky: 'cloudy', precip: 80 })), 0, 'a rate with no state is not rain');
    // "A light drizzle is falling here" — the bottom band, and still visible.
    const drizzle = rainDensityOf(view({ sky: 'raining', precip: 1 }));
    assert.ok(drizzle >= RAIN_DENSITY_MIN && drizzle < 0.22, `a drizzle is ${drizzle}`);
    // Monotone all the way up, and full at the top band and above it.
    let previous = 0;
    for (const precip of [1, 11, 31, 51, 81, 100]) {
      const density = rainDensityOf(view({ sky: 'raining', precip }));
      assert.ok(density >= previous, `density went backwards at rate ${precip}`);
      previous = density;
    }
    assert.equal(rainDensityOf(view({ sky: 'raining', precip: RAIN_FULL_PRECIP })), 1);
    assert.equal(rainDensityOf(view({ sky: 'raining', precip: 100 })), 1, 'nothing above the top band');
    console.log(
      '[sky] rain density by rate: ' +
        [1, 20, 40, 60, 80]
          .map((p) => `${p}->${Math.round(rainDensityOf(view({ sky: 'raining', precip: p })) * RAIN_DROPS)}`)
          .join('  ') +
        ' drops',
    );
  });

  it('thins the storm by drawing fewer drops, without reallocating a thing', () => {
    const rain = new Rain(1_000);
    const seeds = rain.mesh.geometry.getAttribute('aSeed');
    assert.equal(rain.density, 1);
    rain.density = 0.25;
    assert.equal(rain.drawn, 250);
    assert.equal(rain.mesh.geometry.getAttribute('aSeed'), seeds, 'the buffer was rebuilt');
    assert.equal(seeds.count, 1_000, 'the seeds are still all there — only the draw is shorter');
    rain.density = 1;
    assert.equal(rain.drawn, 1_000);
    // Clamped, because the caller is dividing one wire field by another.
    rain.density = 4;
    assert.equal(rain.density, 1);
    rain.density = -1;
    assert.equal(rain.density, 0);
    rain.density = Number.NaN;
    assert.equal(rain.density, 1, 'a NaN rate must not empty the sky');
    rain.dispose();
  });
});

/* -------------------------------------------------------------------------- */
/* The storm's light                                                           */
/* -------------------------------------------------------------------------- */

describe('how dark a storm makes the afternoon', () => {
  it('is the fraction of the sky’s own light the rain is eating, not an absolute', () => {
    // `light` peaks at 60 at noon and is legitimately **0** on a clear moonless midnight, so anything
    // of the form `1 - light/max` would darken every clear night by the full amount. This is the
    // reading that does not: the shortfall, over what there was to lose.
    assert.equal(gloomOf(view({ precip: 0, light: 60 })), 0, 'clear noon');
    assert.equal(gloomOf(view({ precip: 0, light: 0 })), 0, 'a clear moonless midnight must be untouched');
    assert.equal(gloomOf(view({ precip: 30, light: 30 })), 0.5, 'noon under a moderate rain');
    assert.equal(gloomOf(view({ precip: 60, light: 0 })), 1, 'the rain took all of it');
    assert.equal(gloomOf(view({ precip: 100, light: 0 })), 1, 'and it saturates rather than overshooting');
    // A full moon (light 35) losing 10 to a light rain is proportionate rather than absolute — the
    // property that lets one mapping serve every hour of the day.
    assert.ok(Math.abs(gloomOf(view({ precip: 10, light: 25 })) - 10 / 35) < 1e-9);
    for (const light of [0, 7, 35, 60, 100]) {
      for (const precip of [0, 1, 25, 60, 100]) {
        const g = gloomOf(view({ light, precip }));
        assert.ok(g >= 0 && g <= 1, `gloom ${g} at light ${light} precip ${precip}`);
      }
    }
  });

  it('leaves a dry sky byte-for-byte M5b’s, at every hour of the day', () => {
    // **The no-regression assertion.** Identity, not equality: `indoors.skyFor` compares the object
    // it was handed, `daylight.test.ts`'s envelope sweep describes what is on screen, and M4's night
    // was signed off on these exact numbers.
    for (let hour = 0; hour < 24; hour += 0.25) {
      const recipe = skyAt(hour);
      assert.equal(stormy(recipe, 0), recipe, `the hour ${hour} recipe was rebuilt for no reason`);
    }
    for (const recipe of [NIGHT_SKY, DAWN_SKY, DAY_SKY, DUSK_SKY]) {
      assert.equal(stormy(recipe, 0), recipe);
      assert.equal(stormy(recipe, -1), recipe, 'clamped, because gloom is a quotient of wire fields');
      assert.equal(stormy(recipe, Number.NaN), recipe);
    }
  });

  it('collapses the contrast rather than turning everything down', () => {
    const clear = DAY_SKY;
    const storm = stormy(clear, 1);
    // The key loses nearly half of itself and lands between noon's and dusk's, which is what a
    // storm-lit afternoon actually looks like.
    assert.ok(Math.abs(storm.sunIntensity - clear.sunIntensity * (1 - STORM_SUN_DIM)) < 1e-9);
    assert.ok(storm.sunIntensity < DUSK_SKY.sunIntensity && storm.sunIntensity > NIGHT_SKY.sunIntensity);
    // The fill barely moves, because a storm scatters the key into the sky rather than removing it.
    assert.ok(Math.abs(storm.hemisphere - clear.hemisphere * (1 - STORM_HEMISPHERE_DIM)) < 1e-9);
    assert.ok(STORM_HEMISPHERE_DIM < STORM_SUN_DIM / 2, 'the fill is being dimmed like the key');
    // So the ratio between a lit face and a shadowed one collapses — the flattening that reads as
    // overcast, and the whole of the effect.
    const before = clear.sunIntensity / clear.hemisphere;
    const after = storm.sunIntensity / storm.hemisphere;
    assert.ok(after < before * 0.7, `the key:fill ratio only went ${before.toFixed(2)} to ${after.toFixed(2)}`);
    // And the camera opens a little, so the frame goes grey rather than merely dark.
    assert.ok(Math.abs(storm.exposure - clear.exposure * (1 + STORM_EXPOSURE_LIFT)) < 1e-9);
    assert.ok(storm.exposure > clear.exposure);
    // Subtle: a lit surface keeps most of a stop and a shadowed one is essentially unchanged.
    const lit = ((1 - STORM_SUN_DIM) * (1 + STORM_EXPOSURE_LIFT)).toFixed(3);
    const shade = ((1 - STORM_HEMISPHERE_DIM) * (1 + STORM_EXPOSURE_LIFT)).toFixed(3);
    assert.ok(Number(lit) > 0.5 && Number(lit) < 0.7, `a lit face ends at ${lit} of clear`);
    assert.ok(Number(shade) > 0.9, `a shadowed face ends at ${shade} of clear`);
    console.log(
      `[sky] full storm: key x${(1 - STORM_SUN_DIM).toFixed(2)}, fill x${(1 - STORM_HEMISPHERE_DIM).toFixed(2)}, ` +
        `exposure x${(1 + STORM_EXPOSURE_LIFT).toFixed(2)} — lit face ${lit}, shadowed face ${shade}`,
    );
  });

  it('touches three fields and leaves the hour’s own colours, sun and fog alone', () => {
    // A storm that also moved the sun would be two systems arguing about where the shadows fall.
    for (const hour of [0, 6, 12, 19]) {
      const clear = skyAt(hour);
      const storm = stormy(clear, 0.7);
      assert.equal(storm.sky, clear.sky);
      assert.equal(storm.ground, clear.ground);
      assert.equal(storm.sun, clear.sun);
      assert.equal(storm.fog, clear.fog);
      assert.equal(storm.fogDensity, clear.fogDensity);
      assert.deepEqual(storm.from, clear.from);
      assert.ok(storm.name.includes('storm'), 'the debug read-out cannot say why the frame is dark');
      // Monotone in gloom, and bounded by the three constants at either end.
      let previous = clear.sunIntensity;
      for (let g = 0.1; g <= 1.0001; g += 0.1) {
        const step = stormy(clear, g);
        assert.ok(step.sunIntensity <= previous + 1e-12, 'the key brightened as the storm worsened');
        assert.ok(step.sunIntensity >= clear.sunIntensity * (1 - STORM_SUN_DIM) - 1e-12);
        assert.ok(step.exposure <= clear.exposure * (1 + STORM_EXPOSURE_LIFT) + 1e-12);
        previous = step.sunIntensity;
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The threshold                                                               */
/* -------------------------------------------------------------------------- */

describe('the weather stops at the door', () => {
  it('rides M6’s one threshold rather than adding a second', () => {
    // `main.ts` composes `skyFor(stormy(skyAt(h), gloom), enclosure, blend)` — the storm inside the
    // threshold, so there is one interpolation and nothing for a second one to disagree with.
    for (let hour = 0; hour < 24; hour += 1) {
      const outdoor = stormy(skyAt(hour), 1);
      // Out of doors the storm is the whole answer, byte for byte.
      assert.equal(skyFor(outdoor, 'outdoor', 0), outdoor);
      assert.equal(skyFor(outdoor, 'inside', 0), outdoor);
      // Fully indoors it has no effect at all — the same sentence M6 wrote about the hour, and now
      // true of the weather for free, because a storm that reached inside would be a fourth layer.
      assert.equal(skyFor(outdoor, 'inside', 1), INSIDE_SKY);
      assert.equal(skyFor(outdoor, 'cave', 1), CAVE_SKY);
    }
  });

  it('crosses without a pop, at any strength of storm', () => {
    // Walked the way the frame walks it: the same `approach` at the same 60 fps, under a full storm,
    // asserting that every step is a step *toward* the interior and that the arrival is exact.
    const outdoor = stormy(DAY_SKY, 1);
    let blend = 0;
    let previous = skyFor(outdoor, 'inside', blend);
    assert.equal(previous, outdoor);
    let frames = 0;
    while (blend < 1 && frames < 600) {
      blend = approach(blend, 1, 1 / 60);
      frames += 1;
      const now = skyFor(outdoor, 'inside', blend);
      // Monotone toward the interior on both of the fields the storm moved, so the storm cannot make
      // the threshold double back on itself.
      assert.ok(now.sunIntensity <= previous.sunIntensity + 1e-12, `the key rose crossing the threshold`);
      assert.ok(now.exposure >= previous.exposure - 1e-12);
      // And no step is a jump: the largest single frame of the fade is a small fraction of the whole.
      assert.ok(Math.abs(now.exposure - previous.exposure) < 0.25, 'a frame of the fade is a cut');
      previous = now;
    }
    assert.equal(blend, 1);
    assert.equal(previous, INSIDE_SKY);
    // The storm's own strength is continuous too — a weather message arriving mid-threshold nudges
    // the frame rather than snapping it.
    for (const at of [0, 0.25, 0.5, 0.75, 1]) {
      const a = skyFor(stormy(DAY_SKY, 0.5), 'inside', at);
      const b = skyFor(stormy(DAY_SKY, 0.51), 'inside', at);
      assert.ok(Math.abs(a.sunIntensity - b.sunIntensity) < 0.05, `gloom 0.01 moved the key at blend ${at}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The override                                                                */
/* -------------------------------------------------------------------------- */

describe('a human takes the wheel', () => {
  it('detaches from the clock and stays detached until it is given back', () => {
    const clock = new SkyClock();
    clock.accept(view({ hour: 15, progress: 0 }), 0);
    assert.equal(clock.live, true);
    assert.equal(clock.overridden, false);
    assert.equal(clock.hourAt(0), 15);

    // **G**: pinned at noon.
    assert.equal(clock.override(12), 12);
    assert.equal(clock.overridden, true);
    assert.equal(clock.live, false, 'the read-out must say the sky is a human’s and not the world’s');
    // A whole game hour of wall clock goes by and the pinned sky does not move…
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS), 12);
    // …nor does the next message from the server drag it off the authored key, which is exactly what
    // it would have done before, seventy-five seconds after every keypress.
    clock.accept(view({ hour: 16, progress: 0 }), DEFAULT_HOUR_MS);
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS), 12);
    assert.equal(clock.live, false);

    // **Shift+G**: back to the world's clock, at the hour the world has reached in the meantime.
    assert.equal(clock.resume(), true);
    assert.equal(clock.live, true);
    assert.equal(clock.overridden, false);
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS), 16, 'the world kept time while it was being ignored');
    assert.equal(clock.hourAt(DEFAULT_HOUR_MS * 2), 17);
  });

  it('steps from what is on screen, and wraps like the clock it replaced', () => {
    // `[` and `]` step from `hourAt`, so the first press off a live clock lands an hour from *now*.
    const clock = new SkyClock();
    clock.accept(view({ hour: 22, progress: 0.5 }), 0);
    assert.equal(clock.override((clock.hourAt(0) ?? 0) + 1), 23.5);
    assert.equal(clock.override((clock.hourAt(0) ?? 0) + 1), 0.5, 'the sweep must wrap through midnight');
    assert.equal(clock.override((clock.hourAt(0) ?? 0) - 1), 23.5);
    assert.equal(clock.override(Number.NaN), 0, 'a typed `__debug3d.hour = NaN` is not a broken sky');
  });

  it('is releasable even when there is no clock to release it to', () => {
    // The old-server case again: the owner presses shift+G, nothing can be resumed, and the honest
    // answer is to drop the override and leave the hour where they put it rather than to snap to
    // midnight. `resume` says which happened so the log line can too.
    const clock = new SkyClock();
    clock.override(9);
    assert.equal(clock.overridden, true);
    assert.equal(clock.resume(), false);
    assert.equal(clock.overridden, false);
    assert.equal(clock.live, false);
    assert.equal(clock.hourAt(0), undefined, 'the caller keeps the hour it was showing');
  });

  it('holds the clock but never the weather', () => {
    // The two are separate wheels: grabbing the hour must not stop a storm arriving, because the
    // storm is the *weather's* and the pinned hour does not exempt the frame from it.
    const clock = new SkyClock();
    clock.accept(view({ hour: 14, sky: 'clear', precip: 0, light: 50 }), 0);
    clock.override(12);
    assert.equal(clock.gloom, 0);
    clock.accept(view({ hour: 15, sky: 'raining', precip: 45, light: 5 }), 1_000);
    assert.equal(clock.hourAt(1_000), 12, 'the pin held');
    assert.ok(clock.gloom > 0.85, 'the storm did not reach the pinned sky');
    assert.equal(clock.raining, true);
  });
});

/* -------------------------------------------------------------------------- */
/* Wiring, the way `main.ts` does it                                           */
/* -------------------------------------------------------------------------- */

/**
 * `main.ts`'s `precipWanted()`, restated: a hard override, then the world, then M4's default.
 *
 * The one thing the snow slice changed about the composition is its **return type** — the three
 * writers now agree on a `Falling` rather than on a boolean, because there are two fields to hand it
 * to. The precedence, the `undefined`-means-no-opinion rule and the old-server fallback are the
 * previous slice's, unmoved, and the block below is the previous slice's test with `!== 'none'`
 * around it.
 */
function precipWanted(override: boolean | undefined, clock: SkyClock): Falling {
  if (override === false) return 'none';
  if (override === true) return clock.falling !== 'none' ? clock.falling : clock.would;
  if (!clock.served) return 'rain';
  return clock.falling;
}

/** `main.ts`'s `rainWanted()`: whether *anything* is being asked to fall. */
function rainWanted(override: boolean | undefined, clock: SkyClock): boolean {
  return precipWanted(override, clock) !== 'none';
}

describe('the weather’s three writers', () => {
  it('rank the override over the world over M4’s default', () => {
    const clock = new SkyClock();
    // Nobody has said anything: M4's world, where the rain is always on.
    assert.equal(rainWanted(undefined, clock), true);
    assert.equal(precipWanted(undefined, clock), 'rain', 'an old server still gets M4’s rain');
    // The world says it is a clear afternoon, and the weather stops without anyone pressing anything.
    clock.accept(view({ sky: 'clear' }), 0);
    assert.equal(rainWanted(undefined, clock), false);
    // The world says it is raining.
    clock.accept(view({ sky: 'raining', precip: 40 }), 0);
    assert.equal(rainWanted(undefined, clock), true);
    // **R** in a downpour: off, and it stays off across the next three weather messages.
    let override: boolean | undefined = !rainWanted(undefined, clock);
    assert.equal(override, false);
    for (const sky of ['raining', 'snowing', 'very_cloudy'] as const) {
      clock.accept(view({ sky, precip: 70 }), 0);
      assert.equal(rainWanted(override, clock), false, `a ${sky} message beat a hard override`);
      assert.equal(precipWanted(override, clock), 'none');
    }
    // **Shift+R**: back to the world's, which is a clear sky now.
    override = undefined;
    clock.accept(view({ sky: 'partly_cloudy', precip: 0 }), 0);
    assert.equal(rainWanted(override, clock), false);
    // And **R** off a dry sky forces it on, which is the M4 look on demand at any hour.
    override = !rainWanted(undefined, clock);
    assert.equal(rainWanted(override, clock), true);
  });

  it('hand the world’s own phase to the override, and `temp`’s answer when there is none', () => {
    // "R flips whatever is currently falling" is unchanged as a *gesture*; what it can now be
    // flipping is snow. The type it resolves to is never the key's own choice.
    const clock = new SkyClock();
    clock.accept(view({ sky: 'snowing', precip: 55, temp: -6 }), 0);
    assert.equal(precipWanted(undefined, clock), 'snow', 'the world’s blizzard, unpressed');
    // **R** in a blizzard turns it off, not into rain.
    assert.equal(precipWanted(false, clock), 'none');
    // And **R** again turns the blizzard back on — the same weather, not a different one.
    assert.equal(precipWanted(true, clock), 'snow');

    // On a *dry* sky the key still has to show something, and `temp` is what says which. A frozen
    // clear night gives snow…
    clock.accept(view({ sky: 'clear', precip: 0, temp: -11 }), 0);
    assert.equal(precipWanted(undefined, clock), 'none');
    assert.equal(precipWanted(true, clock), 'snow', 'forcing weather on a frozen sky gave rain');
    // …and a warm one gives rain.
    clock.accept(view({ sky: 'mostly_clear', precip: 0, temp: 21 }), 0);
    assert.equal(precipWanted(true, clock), 'rain');
    // With no served sky at all, both answers are M4's.
    const fresh = new SkyClock();
    assert.equal(precipWanted(true, fresh), 'rain');
    assert.equal(precipWanted(undefined, fresh), 'rain');
  });
});

describe('the ground remembers the world’s rain', () => {
  it('soaks in six seconds and dries in forty, driven by the served sky', () => {
    // The uWet ramp is M5b's and its constants do not move; what changed is *what asks for it*. The
    // frame's own two lines, in order: the rain is composed from the writers and the roof, and the
    // wetness follows whether it is actually falling.
    const clock = new SkyClock();
    const rain = new Rain(64);
    const wet = new Wetness();
    let t = 0;
    const step = (roofed: boolean): void => {
      t += 1 / 60;
      rain.enabled = rainWanted(undefined, clock) && !roofed;
      rain.density = clock.rainDensity ?? 1;
      wet.update(t, rain.enabled);
    };

    clock.accept(view({ sky: 'clear', precip: 0 }), 0);
    for (let i = 0; i < 60; i++) step(false);
    assert.equal(wet.value, 0, 'a clear sky wet the ground');
    assert.equal(rain.enabled, false);

    // The zone's weather turns. Nothing was pressed.
    clock.accept(view({ sky: 'raining', precip: 55 }), 0);
    const startedAt = t;
    while (wet.value < 1 && t - startedAt < 30) step(false);
    const soak = t - startedAt;
    assert.equal(wet.value, 1);
    assert.ok(Math.abs(soak - WET_RISE_SECONDS) < 0.4, `soaked in ${soak.toFixed(2)} s`);
    assert.equal(rain.enabled, true);
    assert.ok(rain.density > 0.5 && rain.density < 1, `rate 55 drew ${rain.density.toFixed(2)} of the storm`);

    // Step under a roof while it is still pouring: the rain stops on this character and the roof
    // dries — M4's gate, untouched, and the reason the wetness reads `rain.enabled` and not the sky.
    const dryFrom = t;
    while (wet.value > 0 && t - dryFrom < 90) step(true);
    const dry = t - dryFrom;
    assert.equal(wet.value, 0);
    assert.ok(Math.abs(dry - WET_DRY_SECONDS) < 1, `dried in ${dry.toFixed(2)} s under a roof`);
    assert.equal(clock.falling, 'rain', 'the world is still raining — only this character is not in it');

    // And back out into it: the same six-second rise, from a standing start, with nothing pressed.
    const backAt = t;
    while (wet.value < 1 && t - backAt < 30) step(false);
    assert.equal(wet.value, 1, 'stepping back into the storm did not re-wet the street');
    assert.ok(Math.abs(t - backAt - WET_RISE_SECONDS) < 0.4);
    rain.dispose();
    console.log(
      `[sky] wetness: ${soak.toFixed(2)} s to soak under the world's rain, ${dry.toFixed(2)} s to dry under a roof`,
    );
  });

  it('keeps the world dry when the world is dry, whatever M4 used to do', () => {
    // The regression that matters most to a player: before the clock, `rainWanted` was `true` and the
    // street outside was permanently wet. It must now be dry unless the world says otherwise.
    const clock = new SkyClock();
    clock.accept(view({ sky: 'very_cloudy', precip: 0 }), 0);
    const wet = new Wetness();
    for (let i = 1; i <= 600; i++) wet.update(i / 60, rainWanted(undefined, clock));
    assert.equal(wet.value, 0);
  });
});

describe('the first frame', () => {
  it('has the right sky in it, because `welcome` is answered before anything is built', () => {
    // The server sends `sky` at `welcome`, straight after `zone` and *before* the first room
    // description (`index.ts:10874`). The handler applies it synchronously, so the first frame that
    // has a world in it also has the right sky over that world — this is that ordering, in the small.
    const clock = new SkyClock();
    const bootedAt = 4_211.5;
    // Nothing yet: whatever the caller's default hour is, it keeps it. No error, no midnight flash
    // *to* something — the flash this prevents is midnight persisting *into* a lit afternoon.
    assert.equal(clock.hourAt(bootedAt), undefined);
    // `welcome`'s sky lands, and the answer is available on the same millisecond — not next frame.
    clock.accept(view({ hour: 15, progress: 0.4 }), bootedAt);
    assert.equal(clock.hourAt(bootedAt), quantiseHour(15.4));
    assert.ok(Math.abs(clock.hourAt(bootedAt)! - 15.4) < SKY_HOUR_STEP);
    assert.equal(clock.live, true);
    // The first `requestAnimationFrame` after it, 16 ms later, is already scrubbing — a frame is
    // shorter than one step of the grid, so this is the *second* one that shows a new hour.
    assert.ok(clock.hourAt(bootedAt + 400)! > clock.hourAt(bootedAt)!);
    // A reconnect: `welcome` does not clear the held sky, so the seconds between the socket coming
    // back and the new `sky` arriving keep running on the old one rather than dropping to midnight.
    assert.equal(clock.hourAt(bootedAt + DEFAULT_HOUR_MS * 0.6), 16);
  });
});
