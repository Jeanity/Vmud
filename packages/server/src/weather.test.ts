import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SKY_STATES, makeRng, type SkyState, type ZoneId } from '@mygame/shared';

import { type GameTime } from './clock.ts';
import {
  DEFAULT_CLIMATE_ROW,
  MAGIC_PRECIP_START,
  MAGIC_PRECIP_STOP,
  MOON_VISIBLE,
  PRESSURE_MAX,
  PRESSURE_MIN,
  SUN_VISIBLE,
  WORLD_WEATHER_ROWS,
  WorldWeather,
  calcLight,
  changeWeather,
  climateFromRow,
  initialConditions,
  skyOf,
  type Climate,
  type Conditions,
} from './weather.ts';

function at(hour: number, day = 10, month = 0): GameTime {
  return { hour, day, month, year: 0 };
}

function fixture(row: readonly number[] = DEFAULT_CLIMATE_ROW, seed = 3): { climate: Climate; conditions: Conditions } {
  const rng = makeRng(seed);
  const climate = climateFromRow(row, rng);
  return { climate, conditions: initialConditions(climate, 0) };
}

/** Runs a zone through `hours` of game time, changing its weather every five, and reports the trace. */
function simulate(row: readonly number[], hours: number, seed = 0x5c17a9) {
  const rng = makeRng(seed);
  const climate = climateFromRow(row, rng);
  const conditions = initialConditions(climate, 0);
  const trace: { sky: SkyState; precip: number; pressure: number; temp: number; light: number }[] = [];
  let due = 5;
  for (let h = 0; h < hours; h++) {
    const time = at(h % 24, Math.floor(h / 24) % 35, Math.floor(h / (24 * 35)) % 17);
    due -= 1;
    while (due <= 0) {
      changeWeather(conditions, climate, time, rng);
      due += 5;
    }
    calcLight(conditions, climate, time);
    trace.push({
      sky: skyOf(conditions),
      precip: conditions.precipRate,
      pressure: conditions.pressure,
      temp: conditions.temp,
      light: conditions.ambientLight,
    });
  }
  return trace;
}

describe('the climate table', () => {
  it('is the six distinct rows of `areas/world.weather`, and the default is the modal one', () => {
    // Six rows over a hundred sectors, ten bands of ten (`weather.c:921`). The default is chosen by
    // count and by nothing else, because the join key that would let us pick properly — a room's
    // position on their surface map — is the one thing the harvest does not give us.
    assert.equal(Object.keys(WORLD_WEATHER_ROWS).length, 6);
    for (const row of Object.values(WORLD_WEATHER_ROWS)) assert.equal(row.length, 12);
    assert.deepEqual([...DEFAULT_CLIMATE_ROW], [2, 5, 3, 1, 4, 4, 1, 4, 5, 1, 4, 4]);
  });

  it('reads a row as four seasons of wind, precipitation and temperature', () => {
    const { climate } = fixture([1, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4]);
    assert.deepEqual([...climate.wind], [1, 4, 7, 2]);
    assert.deepEqual([...climate.precip], [2, 5, 8, 3]);
    assert.deepEqual([...climate.temp], [3, 6, 9, 4]);
  });

  it('is deterministic from the seed, which is `CLAUDE.md` rule 3', () => {
    // Wind direction, variance and `energy_add` are rolled rather than read (`db.c:798-802`), so
    // they are the part that has to come from the seeded stream or a restart is a different world.
    assert.deepEqual(climateFromRow(DEFAULT_CLIMATE_ROW, makeRng(9)), climateFromRow(DEFAULT_CLIMATE_ROW, makeRng(9)));
  });
});

describe('opening conditions', () => {
  it('starts at the source’s own “pretty standard start values”', () => {
    // `db.c:820-824`.
    const { conditions } = fixture();
    assert.equal(conditions.pressure, 980);
    assert.equal(conditions.freeEnergy, 10_000);
    assert.equal(conditions.precipDepth, 0);
    assert.equal(conditions.flags, 0);
  });

  it('keeps `ARR_GET`’s off-by-one, because the source’s tables are 0-based and its codes are not', () => {
    // `SEASON_CALM` is 1 and reads `winds[1]` = 12, not the 2 a reader expects; `SEASON_HURRICANE`
    // is 7 and falls off a six-entry table, clamping to 80. Both are `ARR_GET` (`structs.h:90`)
    // doing exactly what it says. "Fixing" either silently changes every zone's opening weather.
    assert.equal(fixture([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).conditions.windspeed, 12);
    assert.equal(fixture([7, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]).conditions.windspeed, 80);
    assert.equal(fixture([1, 1, 11, 1, 1, 1, 1, 1, 1, 1, 1, 1]).conditions.temp, 100);
  });
});

describe('calc_light_zone', () => {
  it('has the sun up from 6 to 17, peaking at hours 11 and 12', () => {
    // `weather.c:811-824`: fold about 11.5, minus five, positive means visible and worth ten each.
    const { climate, conditions } = fixture();
    const lit: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      conditions.flags = 0;
      calcLight(conditions, climate, at(hour, 0));
      if (conditions.flags & SUN_VISIBLE) lit.push(hour);
    }
    assert.deepEqual(lit, [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);

    // Day 0 so there is no moon, and a dry sky so nothing is subtracted: the sun's own contribution
    // alone. (The default climate opens its winter at rate 25, which is why this has to be said.)
    conditions.precipRate = 0;
    conditions.flags = 0;
    calcLight(conditions, climate, at(11, 0));
    assert.equal(conditions.ambientLight, 60, 'noon is the brightest the sun gets');
    conditions.flags = 0;
    calcLight(conditions, climate, at(12, 0));
    assert.equal(conditions.ambientLight, 60);
    conditions.flags = 0;
    calcLight(conditions, climate, at(6, 0));
    assert.equal(conditions.ambientLight, 10, 'and the first hour of sun is worth ten');
  });

  it('shows the moon only in the small hours and only near the middle of the month', () => {
    // `weather.c:826-840`: `abs(hour - 12) > 7` and `abs(day - 17) < 14`.
    const { climate, conditions } = fixture();
    const nights: number[] = [];
    for (let hour = 0; hour < 24; hour++) {
      conditions.flags = 0;
      calcLight(conditions, climate, at(hour, 17));
      if (conditions.flags & MOON_VISIBLE) nights.push(hour);
    }
    assert.deepEqual(nights, [0, 1, 2, 3, 4, 20, 21, 22, 23]);

    conditions.flags = 0;
    calcLight(conditions, climate, at(0, 0));
    assert.equal(conditions.flags & MOON_VISIBLE, 0, 'new moon at the turn of the month');
  });

  it('leaves a risen moon flagged through the day — the missing `else` at weather.c:828', () => {
    // Faithfully quirky. There is no branch clearing the flag when the *hour* test fails, only when
    // the phase test does, so a moon that rose at 03:00 is still flagged at noon.
    const { climate, conditions } = fixture();
    conditions.flags = 0;
    calcLight(conditions, climate, at(3, 17));
    assert.ok(conditions.flags & MOON_VISIBLE);
    calcLight(conditions, climate, at(12, 17));
    assert.ok(conditions.flags & MOON_VISIBLE, 'still set at noon, exactly as the source leaves it');
  });

  it('is darkened by rain and never leaves 0–100', () => {
    const { climate, conditions } = fixture();
    conditions.precipRate = 100;
    calcLight(conditions, climate, at(12, 17));
    assert.equal(conditions.ambientLight, 0);
    conditions.precipRate = 0;
    calcLight(conditions, climate, at(12, 17));
    assert.ok(conditions.ambientLight > 0 && conditions.ambientLight <= 100);
  });
});

describe('the pressure model', () => {
  it('never leaves 960–1040, however long it runs', () => {
    // `weather.c:529-530`. Both bounds are actually reached over a year, so this is a real clamp
    // rather than a bound nothing approaches.
    const trace = simulate(DEFAULT_CLIMATE_ROW, 24 * 35 * 17);
    const min = Math.min(...trace.map((t) => t.pressure));
    const max = Math.max(...trace.map((t) => t.pressure));
    assert.ok(min >= PRESSURE_MIN, `${min}`);
    assert.ok(max <= PRESSURE_MAX, `${max}`);
    assert.equal(min, PRESSURE_MIN, 'and the low bound is reached, so the clamp is exercised');
    assert.equal(max, PRESSURE_MAX);
  });

  it('bounds its own rate of change at ±8 a step', () => {
    const { climate, conditions } = fixture();
    const rng = makeRng(5);
    for (let i = 0; i < 400; i++) {
      changeWeather(conditions, climate, at(i % 24), rng);
      assert.ok(conditions.pressureChange >= -8 && conditions.pressureChange <= 8, `${conditions.pressureChange}`);
    }
  });

  it('holds humidity and the precipitation rate inside their own bands', () => {
    const { climate, conditions } = fixture(WORLD_WEATHER_ROWS['arctic']!);
    const rng = makeRng(6);
    for (let i = 0; i < 2000; i++) {
      changeWeather(conditions, climate, at(i % 24, Math.floor(i / 24) % 35), rng);
      assert.ok(conditions.humidity >= 0 && conditions.humidity <= 100, `humidity ${conditions.humidity}`);
      assert.ok(conditions.precipRate >= 0 && conditions.precipRate <= 100, `precip ${conditions.precipRate}`);
      assert.ok(conditions.precipChange >= -10 && conditions.precipChange <= 10);
      assert.ok(conditions.windspeed >= 0);
    }
  });
});

describe('legal sky transitions only', () => {
  it('never jumps between raining and snowing without passing through the temperature that decides it', () => {
    // The only thing separating the two is `temp > 0` (`weather.c:549`, `623`, `646`). So a step from
    // `raining` to `snowing` is legal — that is the source's own "The rain turns to snow." — but only
    // when the temperature actually crossed zero, and never while the rate is unchanged at zero.
    const trace = simulate(DEFAULT_CLIMATE_ROW, 24 * 35 * 17);
    for (let i = 1; i < trace.length; i++) {
      const before = trace[i - 1]!;
      const now = trace[i]!;
      assert.ok(SKY_STATES.includes(now.sky), now.sky);
      if (before.sky === 'raining' && now.sky === 'snowing') assert.ok(now.temp <= 0);
      if (before.sky === 'snowing' && now.sky === 'raining') assert.ok(now.temp > 0);
      // Falling weather and a named cloud cover are mutually exclusive by construction: `skyOf`
      // reads the rate first.
      const falling = now.sky === 'raining' || now.sky === 'snowing';
      assert.equal(falling, now.precip > 0, `sky ${now.sky} against rate ${now.precip}`);
    }
  });

  it('names the sky by the source’s own humidity ladder', () => {
    // `do_weather`, `actinf.c:5826-5844`.
    const base: Conditions = { ...fixture().conditions, precipRate: 0 };
    const named = (humidity: number): SkyState => skyOf({ ...base, humidity });
    assert.equal(named(0), 'clear');
    assert.equal(named(1), 'mostly_clear');
    assert.equal(named(25), 'mostly_clear');
    assert.equal(named(26), 'partly_cloudy');
    assert.equal(named(55), 'partly_cloudy');
    assert.equal(named(56), 'cloudy');
    assert.equal(named(80), 'cloudy');
    assert.equal(named(81), 'very_cloudy');
  });

  it('calls anything falling rain above freezing and snow at or below it', () => {
    const base = { ...fixture().conditions, precipRate: 20, humidity: 90 };
    assert.equal(skyOf({ ...base, temp: 1 }), 'raining');
    assert.equal(skyOf({ ...base, temp: 0 }), 'snowing');
    assert.equal(skyOf({ ...base, temp: -30 }), 'snowing');
  });
});

describe('starting and stopping', () => {
  it('starts precipitation only above `MAGIC_PRECIP_START` and stops it only below `MAGIC_PRECIP_STOP`', () => {
    // `weather.c:49-50` and `546`/`620`. Driven from the outside: a dry zone forced to a very humid,
    // low-pressure state must begin; a wet zone forced dry must stop.
    const { climate, conditions } = fixture();
    const rng = makeRng(2);
    Object.assign(conditions, { precipRate: 0, humidity: 100, pressure: PRESSURE_MIN, freeEnergy: 20_000, temp: 20 });
    // `magic` is computed from the *post-drift* numbers, so nudge and re-check rather than asserting
    // one step: what matters is that it does begin from a state well past the threshold.
    let began = false;
    for (let i = 0; i < 20 && !began; i++) {
      conditions.humidity = 100;
      conditions.pressure = PRESSURE_MIN;
      const lines = changeWeather(conditions, climate, at(12), rng);
      began = lines.some((line) => /begins to rain|starts to snow/.test(line));
    }
    assert.ok(began, 'a saturated, low-pressure sky eventually opens');

    Object.assign(conditions, { precipRate: 30, humidity: 0, pressure: PRESSURE_MAX, freeEnergy: 3000, temp: 20 });
    const stopped = changeWeather(conditions, climate, at(12), rng);
    assert.deepEqual(stopped, ['The rain stops.']);
    assert.equal(conditions.precipRate, 0);
    assert.ok(MAGIC_PRECIP_STOP < MAGIC_PRECIP_START, 'and the two thresholds leave a hysteresis band');
  });

  it('reads the *old* temperature when it stops and the *new* one when it starts', () => {
    // `weather.c:549` against `623` — the asymmetry is the source's, and it is the difference between
    // "It starts to snow." and "The rain stops." on the same freezing step.
    const { climate, conditions } = fixture();
    const rng = makeRng(4);
    Object.assign(conditions, { precipRate: 30, humidity: 0, pressure: PRESSURE_MAX, freeEnergy: 3000, temp: 5 });
    // Winter is FREEZING, so the drift takes temp down; the message still says "rain" because the
    // old temperature was above zero.
    assert.deepEqual(changeWeather(conditions, climate, at(2), rng), ['The rain stops.']);
  });

  it('says something on every change, which is what makes weather ambient rather than an event', () => {
    // `STWS` fires in all three branches (`weather.c:544-774`). A quiet, dry, calm zone still gets its
    // temperature read out — that is Duris being chatty on purpose, roughly once every five game
    // hours, and it is where the log's sense of place comes from.
    const { climate, conditions } = fixture();
    const rng = makeRng(8);
    for (let i = 0; i < 200; i++) {
      const lines = changeWeather(conditions, climate, at(i % 24, Math.floor(i / 24) % 35), rng);
      assert.ok(lines.length >= 1, `change ${i} said nothing`);
    }
  });

  it('answers the owner’s question: a spell of rain runs about five game hours', () => {
    // 2026-08-13, *"how long is this rain going to last?"* Measured over a game year of the default
    // climate: precipitation is re-decided on the same ~5-hour cadence as everything else, so the
    // shortest possible answer is one change and the median is one change.
    const trace = simulate(DEFAULT_CLIMATE_ROW, 24 * 35 * 17);
    const spells: number[] = [];
    let start = -1;
    for (let i = 0; i < trace.length; i++) {
      const wet = trace[i]!.precip > 0;
      if (wet && start < 0) start = i;
      if (!wet && start >= 0) {
        spells.push(i - start);
        start = -1;
      }
    }
    assert.ok(spells.length > 20, `a year should hold many spells, got ${spells.length}`);
    spells.sort((a, b) => a - b);
    const median = spells[Math.floor(spells.length / 2)]!;
    assert.ok(median >= 4 && median <= 10, `median spell was ${median} game hours`);
  });
});

describe('the six climates behave as differently as the source’s data says', () => {
  it('makes the arctic band precipitate almost always, and the desert band almost never', () => {
    // The check that the seasonal tables are actually wired: two rows of twelve numbers producing
    // two entirely different worlds. Note the finding that surprised: Duris' two *arid* bands are its
    // rainiest, because precipitation is humidity and pressure while rain-or-snow is temperature.
    const year = 24 * 35 * 17;
    const wetFraction = (row: readonly number[]): number =>
      simulate(row, year).filter((t) => t.precip > 0).length / year;
    assert.ok(wetFraction(WORLD_WEATHER_ROWS['arctic']!) > 0.9);
    assert.ok(wetFraction(WORLD_WEATHER_ROWS['desert']!) < 0.1);
  });

  it('never lets a `NO_PRECIP_EVER` season keep any humidity', () => {
    // `weather.c:439-443`. The desert's summer is code 1, and it zeroes humidity outright.
    const { climate, conditions } = fixture(WORLD_WEATHER_ROWS['desert']!);
    const rng = makeRng(13);
    // Month 10 is summer (`month < 13`), where this row's precip code is 1.
    conditions.humidity = 100;
    changeWeather(conditions, climate, at(12, 10, 10), rng);
    assert.equal(conditions.humidity, 0);
  });
});

describe('the running weather', () => {
  it('turns each zone on its own countdown, independently', () => {
    // `new_events.c:958` runs a hundred separate events and asks why. Ours is a countdown per zone,
    // which is the same independence: two zones seeded from the same stream still drift apart.
    const rng = makeRng(21);
    const weather = new WorldWeather();
    const time = at(6);
    for (const zone of [1, 2, 3] as ZoneId[]) weather.ensure(zone, time, rng);
    const dues = [1, 2, 3].map((z) => weather.get(z as ZoneId)!.dueHours);
    assert.equal(new Set(dues).size, 3, 'three zones, three different first changes');
  });

  it('changes nothing until a zone’s countdown runs out, then re-arms it', () => {
    const rng = makeRng(22);
    const weather = new WorldWeather();
    const time = at(6);
    weather.ensure(1 as ZoneId, time, rng);
    const due = weather.get(1 as ZoneId)!.dueHours;
    assert.deepEqual(weather.advance(due / 2, time, rng), [], 'halfway is not there yet');
    const changes = weather.advance(due, time, rng);
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.zone, 1);
    assert.ok(changes[0]!.messages.length >= 1);
    assert.ok(weather.get(1 as ZoneId)!.dueHours > 4, 're-armed about five hours out');
  });

  it('catches up rather than skipping, and refuses to catch up forever', () => {
    const rng = makeRng(23);
    const weather = new WorldWeather();
    const time = at(6);
    weather.ensure(1 as ZoneId, time, rng);
    const changes = weather.advance(10_000, time, rng);
    assert.equal(changes.length, 1);
    assert.ok(changes[0]!.messages.length <= 4, 'bounded, so a clock jump cannot stall the tick');
    assert.ok(weather.get(1 as ZoneId)!.dueHours > 0, 'and the countdown is left in a sane state');
  });

  it('re-lights every zone on demand, which is what the hourly pass buys', () => {
    // Without it a zone whose weather last turned at 03:00 would still report a dark sky at noon:
    // the source only calls `calc_light_zone` from inside a weather change.
    const rng = makeRng(24);
    const weather = new WorldWeather();
    weather.ensure(1 as ZoneId, at(3), rng);
    weather.relight(at(3));
    const night = weather.get(1 as ZoneId)!.conditions.ambientLight;
    weather.relight(at(12));
    assert.ok(weather.get(1 as ZoneId)!.conditions.ambientLight > night);
  });

  it('leaves a zone it already knows alone', () => {
    const rng = makeRng(25);
    const weather = new WorldWeather();
    const first = weather.ensure(1 as ZoneId, at(6), rng);
    first.conditions.temp = 99;
    assert.equal(weather.ensure(1 as ZoneId, at(6), rng).conditions.temp, 99);
  });
});
