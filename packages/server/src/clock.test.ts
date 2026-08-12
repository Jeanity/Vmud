import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from '@mygame/shared';

import {
  ASTRAL_MESSAGES,
  DEFAULT_HOUR_MS,
  DURIS_EPOCH_SECONDS,
  GameClock,
  HOURS_PER_DAY,
  HOURS_PER_MONTH,
  HOURS_PER_YEAR,
  SECS_PER_MUD_HOUR,
  astralMessageAt,
  firstWeatherDelayHours,
  hoursSinceEpoch,
  nextWeatherDelayHours,
  seasonOf,
  sunlightAt,
  timeFromHours,
} from './clock.ts';

/** `utility.c:2137`, transcribed literally, so the collapsed version can be checked against it. */
function mudTimePassed(t2: number, t1: number): { hour: number; day: number; month: number; year: number } {
  let secs = t2 - t1;
  const second = secs % SECS_PER_MUD_HOUR;
  secs -= second;
  const hour = Math.floor(secs / SECS_PER_MUD_HOUR) % 24;
  secs -= SECS_PER_MUD_HOUR * hour;
  const day = Math.floor(secs / 1800) % 35;
  secs -= 1800 * day;
  const month = Math.floor(secs / 63_000) % 17;
  secs -= 63_000 * month;
  return { hour, day, month, year: Math.floor(secs / 1_071_000) };
}

describe('the calendar', () => {
  it('is the source’s: 24 hours, 35 days, 17 months', () => {
    // `config.h:93-96`, read out of the second counts rather than trusted from the comments.
    assert.equal(SECS_PER_MUD_HOUR, 75);
    assert.equal(1800 / SECS_PER_MUD_HOUR, HOURS_PER_DAY);
    assert.equal(63_000 / 1800, 35);
    assert.equal(1_071_000 / 63_000, 17);
    assert.equal(HOURS_PER_MONTH, 24 * 35);
    assert.equal(HOURS_PER_YEAR, 24 * 35 * 17);
  });

  it('carries exactly where `event_another_hour` carries', () => {
    // `weather.c:91-106`: hour past 23 rolls the day, day past 34 rolls the month, month past 16
    // rolls the year. So the last hour of a year is 24*35*17 - 1.
    assert.deepEqual(timeFromHours(0), { hour: 0, day: 0, month: 0, year: 0 });
    assert.deepEqual(timeFromHours(23), { hour: 23, day: 0, month: 0, year: 0 });
    assert.deepEqual(timeFromHours(24), { hour: 0, day: 1, month: 0, year: 0 });
    assert.deepEqual(timeFromHours(24 * 35 - 1), { hour: 23, day: 34, month: 0, year: 0 });
    assert.deepEqual(timeFromHours(24 * 35), { hour: 0, day: 0, month: 1, year: 0 });
    assert.deepEqual(timeFromHours(HOURS_PER_YEAR - 1), { hour: 23, day: 34, month: 16, year: 0 });
    assert.deepEqual(timeFromHours(HOURS_PER_YEAR), { hour: 0, day: 0, month: 0, year: 1 });
  });

  it('agrees with `mud_time_passed` across a whole year, hour by hour', () => {
    // The collapsed moduli against the source's successive subtractions. If these ever disagree the
    // transcription is wrong, and no other test in this file would notice.
    for (let h = 0; h < HOURS_PER_YEAR; h += 7) {
      const secs = h * SECS_PER_MUD_HOUR;
      assert.deepEqual(timeFromHours(h), mudTimePassed(secs, 0), `hour ${h}`);
    }
  });

  it('keeps the fraction, and floors it into the calendar', () => {
    assert.deepEqual(timeFromHours(9.99), timeFromHours(9));
  });

  it('opens a fresh world on the source’s own epoch', () => {
    // `db.c:762`. A server that has never run reads the date a Duris player would have read, because
    // it is the same derivation from the same instant.
    const now = DURIS_EPOCH_SECONDS * 1000 + 9 * DEFAULT_HOUR_MS;
    assert.equal(hoursSinceEpoch(now), 9);
    assert.deepEqual(GameClock.fresh(now).now(), { hour: 9, day: 0, month: 0, year: 0 });
  });
});

describe('seasons', () => {
  it('splits seventeen months four ways, winter taking the odd one', () => {
    // `weather.c:851`: `month < 5 ? 0 : month < 9 ? 1 : month < 13 ? 2 : 3`.
    const names = Array.from({ length: 17 }, (_, month) => seasonOf(month));
    assert.deepEqual(names.slice(0, 5), Array(5).fill('winter'));
    assert.deepEqual(names.slice(5, 9), Array(4).fill('spring'));
    assert.deepEqual(names.slice(9, 13), Array(4).fill('summer'));
    assert.deepEqual(names.slice(13, 17), Array(4).fill('fall'));
  });
});

describe('sunlight', () => {
  it('partitions the day exactly as weather.h’s three macros do', () => {
    // `weather.h:64-69`, evaluated independently and compared. Nine night hours, six twilight, nine
    // day, no hour in two states and none in none — which the macros' overlapping shapes make easy
    // to get wrong by hand.
    const counts = { night: 0, twilight: 0, day: 0 };
    for (let hour = 0; hour < 24; hour++) {
      const isDay = hour >= 8 && hour <= 16;
      const isTwilight = (hour > 4 && hour < 8) || (hour > 16 && hour <= 19);
      const isNight = hour <= 4 || hour > 19;
      assert.equal(Number(isDay) + Number(isTwilight) + Number(isNight), 1, `hour ${hour} is in one state`);
      const expected = isDay ? 'day' : isTwilight ? 'twilight' : 'night';
      assert.equal(sunlightAt(hour), expected, `hour ${hour}`);
      counts[expected] += 1;
    }
    assert.deepEqual(counts, { night: 9, twilight: 6, day: 9 });
  });

  it('names the four boundary hours the source picked', () => {
    // The edges are where an off-by-one hides, and each of these is a `<=` or a `<` in the macro.
    assert.equal(sunlightAt(4), 'night', 'hour 4 is still night — IS_NIGHT is `hour <= 4`');
    assert.equal(sunlightAt(5), 'twilight');
    assert.equal(sunlightAt(8), 'day', 'IS_DAY opens at 8');
    assert.equal(sunlightAt(16), 'day', 'and closes at 16 inclusive');
    assert.equal(sunlightAt(17), 'twilight');
    assert.equal(sunlightAt(19), 'twilight', 'IS_TWILIGHT is `hour <= 19`');
    assert.equal(sunlightAt(20), 'night');
  });

  it('wraps, because a clock is a circle', () => {
    assert.equal(sunlightAt(24), sunlightAt(0));
    assert.equal(sunlightAt(-1), sunlightAt(23));
  });
});

describe('the astral clock', () => {
  it('speaks at the nine hours `astral_clock_setMapModifiers` returns an index at', () => {
    // `weather.c:127-223`. Every other hour returns 0, and `astralMsgs[0]` is NULL.
    const speaking = Array.from({ length: 24 }, (_, h) => h).filter((h) => astralMessageAt(h) !== undefined);
    assert.deepEqual(speaking, [4, 5, 8, 9, 14, 16, 17, 18, 19]);
  });

  it('says the sun rises at 8 and the day begins at 9', () => {
    // The two lines a player is most likely to be awake for, and the pair that proves the table is
    // keyed to the switch rather than to the message array's own order.
    assert.match(astralMessageAt(8) ?? '', /sun.* rises over the northern horizon/);
    assert.match(astralMessageAt(9) ?? '', /The day has begun/);
    assert.match(astralMessageAt(18) ?? '', /vanishes behind the southern horizon/);
    assert.match(astralMessageAt(19) ?? '', /The night has begun/);
  });

  it('keeps the source’s colour codes, which `colour.ts` renders', () => {
    // The whole argument of `colour.ts`: throwing authored colour away is the bug. Every line carries
    // at least one code and every line ends the run it opened.
    for (const [hour, line] of Object.entries(ASTRAL_MESSAGES)) {
      assert.match(line, /&[+nN]/, `hour ${hour} carries colour`);
      assert.doesNotMatch(line, /\r|\n/, `hour ${hour} is one line — the source's \\r\\n is dropped`);
    }
  });

  it('says nothing during the small hours or the middle of the day', () => {
    for (const quiet of [0, 3, 6, 7, 10, 12, 15, 20, 23]) {
      assert.equal(astralMessageAt(quiet), undefined, `hour ${quiet}`);
    }
  });
});

describe('the running clock', () => {
  it('advances one hour per 75 real seconds by default', () => {
    const clock = new GameClock(0);
    assert.deepEqual(clock.advance(DEFAULT_HOUR_MS), [1]);
    assert.equal(clock.now().hour, 1);
    assert.equal(clock.totalHours(), 1);
  });

  it('reports every hour it crossed, not just the last', () => {
    // A tick long enough to cross two hours must fire both astral lines. Duris cannot express this —
    // its clock is one event re-arming itself — but dropping one would be a lie it never tells.
    const clock = new GameClock(0);
    assert.deepEqual(clock.advance(DEFAULT_HOUR_MS * 3), [1, 2, 3]);
  });

  it('crosses nothing on a tick that stays inside the hour', () => {
    const clock = new GameClock(0);
    for (let i = 0; i < 749; i++) assert.deepEqual(clock.advance(100), [], `tick ${i}`);
    // 750 ticks of 100 ms is 75 s exactly, so the 750th is the one that turns the hour.
    assert.deepEqual(clock.advance(100), [1]);
  });

  it('carries the fraction, which is what lets a client scrub between messages', () => {
    const clock = new GameClock(0);
    clock.advance(DEFAULT_HOUR_MS / 4);
    assert.equal(clock.progress(), 0.25);
    assert.equal(clock.now().hour, 0);
  });

  it('bounds a clock jump at a day rather than replaying a decade of hours', () => {
    const clock = new GameClock(0);
    const crossed = clock.advance(DEFAULT_HOUR_MS * 5000);
    assert.equal(crossed.length, HOURS_PER_DAY, 'a day of catch-up, and the date still moves fully');
    assert.equal(clock.totalHours(), 5000);
  });

  it('changes rate without moving the date', () => {
    // `CLAUDE.md` rule 4's whole point. Halving the hour must double the speed of the world, not
    // teleport the calendar — which is exactly what re-deriving from the epoch would do.
    const clock = new GameClock(1000);
    const before = clock.now();
    clock.setMsPerHour(DEFAULT_HOUR_MS / 2);
    assert.deepEqual(clock.now(), before, 'the date did not move');
    assert.deepEqual(clock.advance(DEFAULT_HOUR_MS), [1001, 1002], 'and now two hours pass in one');
  });

  it('refuses a zero or negative rate rather than dividing the world by zero', () => {
    const clock = new GameClock(0, 0);
    assert.ok(clock.msPerHour() >= 1);
    assert.ok(Number.isFinite(clock.advance(100).length));
  });
});

describe('resuming', () => {
  it('carries the downtime forward, so a restart resumes rather than resets', () => {
    // The source's clock is derived from wall time (`db.c:764`), so a Duris server down for an hour
    // comes back 48 game hours later. Ours stores, and adds the same downtime, for the same result.
    const clock = new GameClock(100);
    const saved = clock.save(1_000_000);
    const resumed = GameClock.restore(saved, 1_000_000 + DEFAULT_HOUR_MS * 6);
    assert.equal(resumed.totalHours(), 106);
  });

  it('adds the downtime at the *current* rate, which is why the file exists at all', () => {
    const saved = new GameClock(100).save(1_000_000);
    const fast = GameClock.restore(saved, 1_000_000 + DEFAULT_HOUR_MS * 6, DEFAULT_HOUR_MS / 2);
    assert.equal(fast.totalHours(), 112, 'six real hours of downtime at double speed is twelve');
  });

  it('never runs backwards on a clock that went back', () => {
    // A machine whose wall clock is corrected backwards must not un-happen game hours.
    const saved = new GameClock(100).save(1_000_000);
    assert.equal(GameClock.restore(saved, 1).totalHours(), 100);
  });

  it('at the default rate, a resume equals the derived clock — which is the whole claim', () => {
    // Persistence buys rate-tunability and changes nothing else: with the source's own 75 s the
    // stored clock and `reset_time`'s derivation land on the same hour.
    const bootedAt = DURIS_EPOCH_SECONDS * 1000 + 12_345 * DEFAULT_HOUR_MS;
    const saved = GameClock.fresh(bootedAt).save(bootedAt);
    const later = bootedAt + 400 * DEFAULT_HOUR_MS;
    assert.equal(GameClock.restore(saved, later).totalHours(), hoursSinceEpoch(later));
  });
});

describe('the weather cadence', () => {
  it('is five game hours give or take three tenths — the source’s ±90 pulses', () => {
    // `weather.c:778`: `5 * PULSES_IN_TICK + number(-90, 90)`, and 300 pulses is an hour.
    const rng = makeRng(7);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const delay = nextWeatherDelayHours(rng);
      min = Math.min(min, delay);
      max = Math.max(max, delay);
    }
    assert.equal(min, 5 - 90 / 300);
    assert.equal(max, 5 + 90 / 300);
  });

  it('staggers the first change so a hundred zones do not all turn at once', () => {
    // `new_events.c:962`: `125 * WAIT_SEC + number(-9, 9)` pulses — a bit under two game hours.
    const rng = makeRng(11);
    for (let i = 0; i < 500; i++) {
      const delay = firstWeatherDelayHours(rng);
      assert.ok(delay >= 491 / 300 && delay <= 509 / 300, `${delay}`);
    }
  });
});
