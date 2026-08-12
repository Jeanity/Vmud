import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { SECTORS, makeRng, type RoomFlag, type Sector, type ZoneId } from '@mygame/shared';

import { DEFAULT_HOUR_MS, GameClock } from './clock.ts';
import { WorldWeather, skyOf } from './weather.ts';
import {
  adoptZones,
  clockBanner,
  hearsAstral,
  hearsWeather,
  isOutdoors,
  loadWorldClock,
  saveWorldClock,
  skyFor,
} from './worldclock.ts';

function tempFile(contents?: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'mygame-worldclock-')), 'worldclock.json');
  if (contents !== undefined) writeFileSync(file, contents, 'utf8');
  return file;
}

function room(sector: Sector, ...flags: RoomFlag[]): { sector: Sector; flags: readonly RoomFlag[] } {
  return { sector, flags };
}

/** A live world clock plus one zone of weather, for the round-trip. */
function rig(seed = 31): { clock: GameClock; weather: WorldWeather } {
  const rng = makeRng(seed);
  const clock = new GameClock(12_345.5);
  const weather = new WorldWeather();
  weather.ensure(168 as ZoneId, clock.now(), rng);
  weather.ensure(36 as ZoneId, clock.now(), rng);
  return { clock, weather };
}

describe('who is under the sky', () => {
  it('counts the open-sky sectors and nothing else', () => {
    // `light.ts`'s existing `underOpenSky`, which is the same question Duris asks with `NORMAL_PLANE`
    // and `IS_UNDERWORLD`. Asserted over every sector so a new one cannot be added silently.
    const outdoors = SECTORS.filter((sector) => isOutdoors(room(sector)));
    assert.deepEqual(
      [...outdoors],
      ['city', 'road', 'field', 'forest', 'hills', 'mountain', 'swamp', 'desert', 'arctic', 'shallow_water', 'deep_water', 'air'],
    );
    for (const sheltered of ['inside', 'cave', 'underwater', 'astral'] as Sector[]) {
      assert.equal(isOutdoors(room(sheltered)), false, sheltered);
    }
  });

  it('refuses an `indoors` room whatever its terrain says', () => {
    // Duris' `ROOM_INDOORS`, checked by both of the source's gates. A field with a roof over it is a
    // roof; the flag outranks the sector.
    assert.equal(isOutdoors(room('field')), true);
    assert.equal(isOutdoors(room('field', 'indoors')), false);
  });
});

describe('the two gates, and the difference between them', () => {
  it('lets sunrise reach a dark outdoor room, and refuses rain there', () => {
    // The finding: `event_astral_clock` (`weather.c:241-246`) does not test darkness, and
    // `send_to_weather_sector` (`weather.c:937-938`) does. Dawn over a gloomy moor is *known*;
    // the rain has to be *seen*. Three hundred lines apart in the source and easy to miss.
    const gloomy = room('swamp', 'dark');
    assert.equal(hearsAstral(gloomy, 'normal'), true, 'the day still turns');
    assert.equal(hearsWeather(gloomy, 'normal'), false, 'but you cannot see it rain');
  });

  it('agrees everywhere else', () => {
    for (const sector of SECTORS) {
      const plain = room(sector);
      assert.equal(hearsAstral(plain, 'normal'), hearsWeather(plain, 'normal'), sector);
    }
  });

  it('needs you awake, exactly as `IS_AWAKE` does', () => {
    const field = room('field');
    assert.equal(hearsAstral(field, 'normal'), true);
    assert.equal(hearsAstral(field, 'resting'), true, 'resting is sitting with your eyes open');
    for (const asleep of ['sleeping', 'incapacitated', 'dying', 'dead']) {
      assert.equal(hearsAstral(field, asleep), false, asleep);
      assert.equal(hearsWeather(field, asleep), false, asleep);
    }
  });

  it('keeps every underground and interior sector out of the weather', () => {
    // "No weather underground or inside" — and it falls out of the sector set rather than being a
    // special case, which is why there is no list of exceptions to keep in step.
    for (const sheltered of ['inside', 'cave', 'underwater', 'astral'] as Sector[]) {
      assert.equal(hearsWeather(room(sheltered), 'normal'), false, sheltered);
      assert.equal(hearsAstral(room(sheltered), 'normal'), false, sheltered);
    }
  });

  it('has no desert or arctic special case, because `weather.c` has none', () => {
    // Checked rather than assumed: the source's climate is per map square and sector type never
    // enters the calculation. Desert and arctic hear the sky on exactly the terms a field does.
    for (const sector of ['desert', 'arctic', 'field'] as Sector[]) {
      assert.equal(hearsWeather(room(sector), 'normal'), true, sector);
    }
  });
});

describe('the wire', () => {
  it('carries the clock and the zone’s own weather', () => {
    const { clock, weather } = rig();
    const conditions = weather.get(168 as ZoneId)!.conditions;
    const view = skyFor(clock, conditions);

    assert.equal(view.hour, clock.now().hour);
    assert.equal(view.day, clock.now().day);
    assert.equal(view.month, clock.now().month);
    assert.equal(view.year, clock.now().year);
    assert.equal(view.progress, 0.5, 'and how far through the hour, so a client can interpolate');
    assert.equal(view.hourMs, DEFAULT_HOUR_MS);
    assert.equal(view.sky, skyOf(conditions));
    assert.equal(view.precip, conditions.precipRate);
    assert.equal(view.wind, conditions.windspeed);
    assert.equal(view.temp, conditions.temp);
    assert.equal(view.light, conditions.ambientLight);
  });

  it('says different things to two players in two zones, which is the whole reason it is per player', () => {
    const { clock, weather } = rig();
    const here = weather.get(168 as ZoneId)!.conditions;
    const there = weather.get(36 as ZoneId)!.conditions;
    here.precipRate = 40;
    here.temp = 12;
    there.precipRate = 0;
    there.humidity = 10;
    assert.equal(skyFor(clock, here).sky, 'raining');
    assert.equal(skyFor(clock, there).sky, 'mostly_clear');
  });

  it('changes rate on the wire when the operator throws the setting', () => {
    // `CLAUDE.md` rule 4 reaching the client: the hour length is shipped, not assumed, so a client
    // interpolating between messages cannot disagree with the server about how fast the sun moves.
    const { clock, weather } = rig();
    clock.setMsPerHour(5_000);
    assert.equal(skyFor(clock, weather.get(168 as ZoneId)!.conditions).hourMs, 5_000);
  });

  it('degrades to a clear sky for a zone with no weather rather than throwing', () => {
    const { clock } = rig();
    const view = skyFor(clock, undefined);
    assert.equal(view.sky, 'clear');
    assert.equal(view.precip, 0);
    assert.equal(view.sun, false);
    assert.equal(view.moon, false);
  });

  it('reports the sunlight state the hour is in', () => {
    const weather = new WorldWeather();
    for (const [hour, expected] of [[2, 'night'], [6, 'twilight'], [12, 'day'], [18, 'twilight'], [22, 'night']] as const) {
      assert.equal(skyFor(new GameClock(hour), weather.get(1 as ZoneId)?.conditions).sunlight, expected, `${hour}`);
    }
  });
});

describe('persistence', () => {
  it('round-trips the clock and every zone’s weather', () => {
    const file = tempFile();
    const { clock, weather } = rig();
    const before = weather.get(168 as ZoneId)!.conditions;
    before.temp = -7;
    before.precipRate = 33;
    before.pressure = 1001;

    saveWorldClock(clock, weather, 1_000_000, file);
    const saved = loadWorldClock(file);
    assert.ok(saved);
    assert.equal(saved.clock.totalHours, 12_345.5);
    assert.equal(saved.clock.savedAtMs, 1_000_000);

    const revived = new WorldWeather();
    adoptZones(revived, saved);
    assert.deepEqual(revived.get(168 as ZoneId)?.conditions, before);
    assert.deepEqual(revived.get(36 as ZoneId)?.climate, weather.get(36 as ZoneId)?.climate);
  });

  it('resumes the clock across a restart — the whole point of the file', () => {
    // Kill and reload: the world comes back where it was, plus the downtime, which is what Duris'
    // wall-clock-derived clock does for free (`db.c:764`).
    const file = tempFile();
    const { clock, weather } = rig();
    saveWorldClock(clock, weather, 1_000_000, file);

    const saved = loadWorldClock(file);
    assert.ok(saved);
    const resumed = GameClock.restore(saved.clock, 1_000_000 + DEFAULT_HOUR_MS * 3);
    assert.equal(resumed.totalHours(), 12_348.5, 'three real hours of downtime is three game hours');
    assert.notDeepEqual(resumed.now(), new GameClock(0).now(), 'and emphatically not a reset');
  });

  it('keeps a storm through the restart, so a reload is not a fresh sky', () => {
    const file = tempFile();
    const { clock, weather } = rig();
    const storm = weather.get(168 as ZoneId)!;
    storm.conditions.precipRate = 88;
    storm.conditions.temp = 9;
    storm.dueHours = 2.25;
    saveWorldClock(clock, weather, 1_000_000, file);

    const revived = new WorldWeather();
    adoptZones(revived, loadWorldClock(file)!);
    assert.equal(skyOf(revived.get(168 as ZoneId)!.conditions), 'raining');
    assert.equal(revived.get(168 as ZoneId)!.dueHours, 2.25, 'and it is still due to turn when it was');
  });

  it('shrugs at a missing or corrupt file rather than refusing to boot', () => {
    // The caller has a good default for "nothing" — `GameClock.fresh`, which is the source's own
    // `reset_time` — so there is no failure worth crashing for.
    assert.equal(loadWorldClock(tempFile()), undefined, 'missing');
    assert.equal(loadWorldClock(tempFile('{ not json')), undefined, 'unparseable');
    assert.equal(loadWorldClock(tempFile('[]')), undefined, 'not an object');
    assert.equal(loadWorldClock(tempFile('{"zones":{}}')), undefined, 'no clock at all');
    assert.equal(loadWorldClock(tempFile('{"clock":{"totalHours":"12"}}')), undefined, 'a clock that is not a number');
  });

  it('drops a zone that will not parse and keeps the rest', () => {
    // A dropped zone is re-seeded from its climate by `WorldWeather.ensure`, which is a fresh sky
    // rather than a wrong one.
    const file = tempFile();
    const { clock, weather } = rig();
    saveWorldClock(clock, weather, 1_000_000, file);
    const doc = JSON.parse(
      // Re-read and corrupt exactly one zone.
      loadWorldClock(file) ? JSON.stringify({ ...loadWorldClock(file), zones: { ...loadWorldClock(file)!.zones, 36: 'nonsense' } }) : '{}',
    ) as { zones: Record<string, unknown> };
    writeFileSync(file, JSON.stringify(doc), 'utf8');

    const saved = loadWorldClock(file);
    assert.ok(saved);
    assert.ok(saved.zones['168']);
    assert.equal(saved.zones['36'], undefined);
  });

  it('writes a file a human can read and hand-edit — which is how a climate gets changed', () => {
    const file = tempFile();
    const { clock, weather } = rig();
    saveWorldClock(clock, weather, 1_000_000, file);
    const saved = loadWorldClock(file)!;
    // The climate is in the document, so switching a zone from the cold default to a warmer band is
    // an edit rather than a code change. See `WORLD_WEATHER_ROWS`.
    assert.ok(Array.isArray(saved.zones['168']!.climate.temp));
    assert.equal(saved.zones['168']!.climate.temp.length, 4);
  });
});

describe('the boot line', () => {
  it('reads the date back the way `reset_time` prints it', () => {
    // `db.c:766-775`, twelve-hour with noon and midnight spelt out — a clock nobody can read is a
    // clock nobody trusts.
    assert.match(clockBanner(0), /midnight/);
    assert.match(clockBanner(12), /noon/);
    assert.match(clockBanner(9), /9am/);
    assert.match(clockBanner(21), /9pm/);
    assert.equal(clockBanner(24 * 35 * 17 + 24 * 35 * 2 + 24 * 3 + 13).startsWith('2/3/1'), true, 'month/day/year');
  });
});
