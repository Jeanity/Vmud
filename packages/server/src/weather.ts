/**
 * Weather — transcribed from Duris' `weather.c`, `weather.h` and `db.c:778` (`weather_setup`).
 *
 * The second half of the owner's *"how long is this rain going to last?"* (2026-08-13). The first
 * half is `clock.ts`, and this file cannot exist without it: every rule below reads `time_info`.
 *
 * ## The model is not the one the brief expected, and that is the finding
 *
 * `defines.h:509-512` declares `SKY_CLOUDLESS` / `SKY_CLOUDY` / `SKY_RAINING` / `SKY_LIGHTNING` — the
 * classic Diku four-state sky machine. **Nothing in the Duris tree reads them.** A grep for `SKY_`
 * across all 400-odd `.c` and `.h` files returns those four declarations and no use. Duris replaced
 * that machine in 1991 (`weather.h`'s own header: *"new zone-based weather routines"*) with a
 * continuous climate simulation, and that is what is transcribed here:
 *
 * - Six live quantities per zone — temperature, humidity, precipitation rate, wind speed, barometric
 *   pressure and a "free energy" pool — each drifting under a **seasonal character** drawn from the
 *   zone's climate (`weather.c:276-521`).
 * - Precipitation is decided by one deliberately unprincipled expression, `magic` (`weather.c:542`),
 *   whose own comment says the numbers *"have little bearing on reality"*. It starts rain above
 *   `MAGIC_PRECIP_START` (1060) and stops it below `MAGIC_PRECIP_STOP` (970) — `weather.c:49-50`.
 * - Rain versus snow is temperature, nothing else: `temp > 0` (`weather.c:549`, `623`, `646`).
 * - **There is no lightning.** No thunder either. Not transcribed, because it is not there.
 *
 * The four-state sky the client will want is therefore *derived* rather than stored — {@link skyOf},
 * which is `do_weather`'s own player-facing summary (`actinf.c:5826-5844`), the one place in the
 * source that turns these numbers back into a word.
 *
 * ## The unit of weather is the zone, and the source chose that for us
 *
 * Duris runs **100 weather sectors**, 30x30 blocks of its surface map (`weather.c:872`). We have no
 * surface-map coordinate for most rooms, so that grid cannot be reproduced — but `in_weather_sector`
 * does not need one either: its first act is `if (!IS_MAP_ROOM(room)) room = maproom_of_zone(...)`
 * (`weather.c:865`), collapsing every non-map room to **its zone's** representative. Zone-granular
 * weather is the source's own fallback path taken always, not an invention.
 *
 * ## Climate data, and what is deferred
 *
 * `weather_setup` reads `areas/world.weather` — 100 rows of twelve integers, wind/precip/temp for
 * four seasons (`db.c:790-816`). That file keys on their map grid, so it cannot be joined to our
 * zones. What is transcribable is its content: the file holds only **six distinct rows**, and the
 * modal one covers 30 of the 100 sectors. That row is {@link DEFAULT_CLIMATE_ROW}, and every zone
 * gets it until something says otherwise — a per-zone climate table is named as deferred rather than
 * guessed at from terrain, because `weather.c` has no terrain term anywhere in it. (The brief asked
 * whether desert and arctic are special-cased. They are not. Not in this file, not anywhere: climate
 * is per map-square data, and sector type never enters the calculation.)
 *
 * The parts `weather_setup` randomises rather than reads — wind direction, wind variance and
 * `energy_add` (`db.c:798-802`) — are randomised here too, but from the seeded RNG per zone id, so
 * the same world seed gives the same climates (`CLAUDE.md` rule 3).
 *
 * ## Deviations, all of them
 *
 * 1. **`precip_depth` does not wrap.** It is a `char` in the source (`structs.h:638`) accumulating
 *    `+= precip_rate` every change, so it overflows within three changes of any real storm. Nothing
 *    reads it but the wizard weather dump. Kept as a plain number; an 8-bit wrap nothing depends on
 *    is a bug, not a mechanism.
 * 2. **`WEATHER_CONTROLLED` is dropped.** The flag is cleared at the top of every change
 *    (`weather.c:272`) and set by nothing in the tree — the header calls it *"Idea for expansion"*.
 * 3. **Timers are counted in game hours, not pulses.** See `clock.ts`'s `nextWeatherDelayHours`.
 * 4. **Hurricane wind is `= 100`, and stays.** Faithfully odd: `SEASON_HURRICANE` assigns rather than
 *    drifts (`weather.c:320-322`).
 */

import { randomInt, type Rng, type SkyState, type ZoneId } from '@mygame/shared';

import {
  firstWeatherDelayHours,
  nextWeatherDelayHours,
  seasonIndex,
  type GameTime,
} from './clock.ts';

/* -------------------------------------------------------------------------- */
/* The source's constants                                                      */
/* -------------------------------------------------------------------------- */

/** `weather.c:49-50`. The two thresholds the whole precipitation state machine turns on. */
export const MAGIC_PRECIP_START = 1060;
export const MAGIC_PRECIP_STOP = 970;

/** `weather.c:529-530`. Barometric pressure never leaves this band. */
export const PRESSURE_MIN = 960;
export const PRESSURE_MAX = 1040;

/** `weather.h:56-58`, climate flags. `NON_CONTROLLABLE` and `AFFECTS_INDOORS` are read by nothing. */
export const NO_MOON_EVER = 1;
export const NO_SUN_EVER = 2;

/** `weather.h:61-62`, live weather flags. `WEATHER_CONTROLLED` (4) is dropped — see the header. */
export const MOON_VISIBLE = 1;
export const SUN_VISIBLE = 2;

/* -------------------------------------------------------------------------- */
/* Climate                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A zone's seasonal character — `struct climate`, `structs.h:615`.
 *
 * Each array is four long, one per season, and holds the `SEASON_*` code from `weather.h:22-51`:
 * wind 1–7 (calm…hurricane), precipitation 1–9 (never…constant), temperature 1–11 (frostbite…boiling).
 */
export interface Climate {
  readonly wind: readonly number[];
  readonly windDir: readonly number[];
  readonly windVariance: readonly number[];
  readonly precip: readonly number[];
  readonly temp: readonly number[];
  readonly flags: number;
  readonly energyAdd: number;
}

/**
 * **Every climate Duris has.** `areas/world.weather` is a hundred rows and exactly **six distinct
 * ones**, laid down in ten bands of ten — the sector index is `row * 10 + column` over a 10x10 grid
 * (`weather.c:921-922`), so a band is a horizontal strip of the world map.
 *
 * Six twelve-number rows of *rules* constants, in the same category as the wear-off lines in
 * `affects.ts` and not in the category `CLAUDE.md` rule 5 protects: no room, mob or zone is named
 * here. It is here rather than in a file because the join key that would let us read the real file —
 * a room's position on their surface map — is the one thing the harvest does not give us.
 *
 * Decoded, in wind/precip/temp triples per season (winter, spring, summer, fall):
 *
 * | Band | Sectors | Character | Measured over one game year |
 * | --- | --- | --- | --- |
 * | 0, 3, 7 | 30 | Breezy, average-precipitation, freezing winter; calm, low-precipitation, cold rest | 434 h rain, 3,781 h snow |
 * | 1, 8 | 20 | Unsettled and stormy, nippy through freezing | 950 h rain, 6,375 h snow |
 * | 2, 9 | 20 | Arctic: chinook winds, torrential, frostbite | 95 h rain, **14,100 h snow** of 14,280 |
 * | 4 | 10 | Warm and arid, calm | **3,280 h rain**, no snow |
 * | 5 | 10 | Desert: hot to boiling, no precipitation at all in summer | 254 h rain, no snow |
 * | 6 | 10 | Mild and arid, calm | **3,240 h rain**, no snow |
 *
 * Measured by simulating 14,280 hours per row against the seeded stream — see the report, and note
 * that the two rainiest climates in Duris are the two *arid* ones. Precipitation is decided by
 * humidity and pressure; whether it lands as rain or as snow is decided by nothing but temperature.
 */
export const WORLD_WEATHER_ROWS: Readonly<Record<string, readonly number[]>> = {
  temperateCold: [2, 5, 3, 1, 4, 4, 1, 4, 5, 1, 4, 4],
  stormyCold: [3, 7, 2, 5, 5, 3, 3, 3, 4, 3, 2, 3],
  arctic: [5, 8, 1, 4, 8, 1, 2, 7, 2, 1, 6, 1],
  warmArid: [1, 2, 5, 1, 1, 7, 1, 2, 8, 1, 5, 7],
  desert: [3, 4, 6, 2, 4, 8, 3, 1, 11, 2, 4, 8],
  mildArid: [1, 2, 4, 1, 1, 6, 1, 2, 8, 1, 5, 7],
};

/**
 * The default every zone gets: the **modal** row, thirty of the hundred sectors.
 *
 * Chosen by count and nothing else, which is the only defensible way to pick when the real join key
 * is missing. It is a cold climate, so this world snows more than it rains — see the table above,
 * and see `worldclock.json` if that is not the world somebody wants: the climate is per zone and it
 * is written to disk, so changing one is editing a file rather than editing this line.
 */
export const DEFAULT_CLIMATE_ROW: readonly number[] = WORLD_WEATHER_ROWS['temperateCold']!;

/**
 * `db.c:796-816` — a climate from a twelve-number row plus the four fields the source rolls rather
 * than reads.
 *
 * `flags` is `0`: no row in `world.weather` carries `NO_SUN_EVER` or `NO_MOON_EVER`, and
 * `weather_setup` hardcodes zero (`db.c:801`). The underworld's sunless zones would be the natural
 * users, and they are excluded from weather entirely by the sector gate instead.
 */
export function climateFromRow(row: readonly number[], rng: Rng): Climate {
  const windDir: number[] = [];
  const windVariance: number[] = [];
  for (let i = 0; i < 4; i++) {
    windDir.push(randomInt(rng, 0, 3));
    windVariance.push(randomInt(rng, 0, 1));
  }
  const wind: number[] = [];
  const precip: number[] = [];
  const temp: number[] = [];
  for (let s = 0; s < 4; s++) {
    wind.push(row[s * 3] ?? 1);
    precip.push(row[s * 3 + 1] ?? 1);
    temp.push(row[s * 3 + 2] ?? 1);
  }
  return { wind, windDir, windVariance, precip, temp, flags: 0, energyAdd: randomInt(rng, 0, 1000) };
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the sky is doing right now — `struct weather_data`, `structs.h:626`.
 *
 * **Mutable**, unlike most state in this codebase, and deliberately: `event_weather_change` is three
 * hundred lines of in-place drift on exactly these fields, and a transcription that rebuilt the
 * record at every step would be harder to check against the original than to read. The only writer
 * is {@link changeWeather}.
 */
export interface Conditions {
  /** Celsius. Decides rain against snow, and nothing else does. */
  temp: number;
  /** 0–100. */
  humidity: number;
  /** 0–100 while it falls, 0 when it does not. */
  precipRate: number;
  windspeed: number;
  /** 0–3: north, east, south, west (`actinf.c:5762`). */
  windDir: number;
  /** Millibars, 960–1040. */
  pressure: number;
  /** 0–100, sun plus moon minus precipitation — `calc_light_zone`. */
  ambientLight: number;
  freeEnergy: number;
  /** {@link SUN_VISIBLE} | {@link MOON_VISIBLE}. */
  flags: number;
  /** Snowpack / flood level. Accumulates; see deviation 1 in the header. */
  precipDepth: number;
  pressureChange: number;
  precipChange: number;
}

/** `db.c:785-788`. The starting bands, indexed by the season code. */
const WINDS: readonly number[] = [2, 12, 30, 40, 50, 80];
const PRECIPS: readonly number[] = [0, 1, 5, 10, 15, 25, 35, 45, 60];
const HUMIDS: readonly number[] = [4, 10, 20, 30, 40, 50, 60, 75, 100];
const TEMPS: readonly number[] = [-15, -8, 0, 10, 17, 27, 33, 40, 50, 75, 100];

/**
 * `ARR_GET` (`structs.h:90`) — a bounds-clamping array read that prints and carries on.
 *
 * Transcribed rather than tidied, because the clamping is **load-bearing and off by one**: the
 * `SEASON_*` codes are 1-based and these tables are 0-based, so `SEASON_CALM` (1) reads `WINDS[1]`
 * = 12 rather than the 2 a reader expects, and `SEASON_HURRICANE` (7) falls off the end of a
 * six-entry table and clamps to 80. Both are what the source does; "fixing" either would silently
 * change every zone's opening weather.
 */
function arrGet(table: readonly number[], index: number): number {
  if (index < 0) return table[0]!;
  if (index >= table.length) return table[table.length - 1]!;
  return table[index]!;
}

/**
 * `db.c:818-830` — a zone's opening weather, from its climate and the season it boots in.
 *
 * Pressure 980, free energy 10000, no precipitation depth, no flags: *"These are pretty standard
 * start values"* (`db.c:820`).
 */
export function initialConditions(climate: Climate, season: number): Conditions {
  const conditions: Conditions = {
    pressure: 980,
    freeEnergy: 10_000,
    precipDepth: 0,
    flags: 0,
    windspeed: arrGet(WINDS, climate.wind[season] ?? 1),
    windDir: climate.windDir[season] ?? 0,
    precipRate: arrGet(PRECIPS, climate.precip[season] ?? 1),
    temp: arrGet(TEMPS, climate.temp[season] ?? 1),
    humidity: arrGet(HUMIDS, climate.precip[season] ?? 1),
    ambientLight: 0,
    pressureChange: 0,
    precipChange: 0,
  };
  return conditions;
}

/* -------------------------------------------------------------------------- */
/* calc_light_zone                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `calc_light_zone` (`weather.c:806`) — the sun and moon, and how much light they leave on the ground.
 *
 * Sun: `hour` folded about noon (`if (temp > 11) temp = 23 - temp`), minus five. Positive means
 * visible, and worth ten light each — so the sun is up for hours **6 to 17** and peaks at 60 at hours
 * 11 and 12. Note the fold is about 11.5, not 12, so the curve is very slightly asymmetric; that is
 * the source's arithmetic and it is kept.
 *
 * Moon: needs `abs(hour - 12) > 7` (hours 20–23 and 0–4) **and** a day within a fortnight of the
 * 17th, contributing `temp * temp2 / 2` on C integer division. **The moon flag is not cleared when
 * the hour test fails** — there is no `else` at `weather.c:828` — so a moon that rose stays flagged
 * through the following day until a night with the wrong phase clears it. Faithfully quirky.
 *
 * Then `light_sum -= precip_rate`, clamped 0–100: rain is the only thing that darkens the world here.
 */
export function calcLight(conditions: Conditions, climate: Climate, time: GameTime): void {
  let lightSum = 0;

  if (!(climate.flags & NO_SUN_EVER)) {
    let temp = time.hour;
    if (temp > 11) temp = 23 - temp;
    temp -= 5;
    if (temp > 0) {
      conditions.flags |= SUN_VISIBLE;
      lightSum += temp * 10;
    } else {
      conditions.flags &= ~SUN_VISIBLE;
    }
  }

  if (!(climate.flags & NO_MOON_EVER)) {
    const temp = Math.abs(time.hour - 12) - 7;
    if (temp > 0) {
      const temp2 = 17 - Math.abs(time.day - 17) - 3;
      if (temp2 > 0) {
        conditions.flags |= MOON_VISIBLE;
        lightSum += Math.trunc((temp * temp2) / 2);
      } else {
        conditions.flags &= ~MOON_VISIBLE;
      }
    }
  }

  lightSum -= conditions.precipRate;
  conditions.ambientLight = Math.min(Math.max(0, lightSum), 100);
}

/* -------------------------------------------------------------------------- */
/* event_weather_change                                                        */
/* -------------------------------------------------------------------------- */

/** 2d15, `dice(2, 15)` at `weather.c:338`. */
function dice2d15(rng: Rng): number {
  return randomInt(rng, 1, 15) + randomInt(rng, 1, 15);
}

/**
 * One weather change for one zone — `event_weather_change`, `weather.c:253-780`, in order.
 *
 * Mutates `conditions` and returns the lines the zone should hear, which is the source's `STWS`
 * macro (`weather.c:51`) unrolled: it sends immediately, we collect and let the caller apply the
 * sector gate once. At most one line comes back from the precipitation ladder, plus possibly a moon
 * line — the source can emit both in the same change for the same reason.
 */
export function changeWeather(
  conditions: Conditions,
  climate: Climate,
  time: GameTime,
  rng: Rng,
): string[] {
  const messages: string[] = [];
  const oldTemp = conditions.temp;
  const oldPrecip = conditions.precipRate;
  const oldWind = conditions.windspeed;
  const season = seasonIndex(time.month);

  /* -- free energy and wind, weather.c:275-341 ---------------------------- */

  conditions.freeEnergy = Math.min(Math.max(3000, climate.energyAdd + conditions.freeEnergy), 50_000);

  switch (climate.wind[season]) {
    case 1: // SEASON_CALM
      if (conditions.windspeed > 25) conditions.windspeed -= 5;
      else conditions.windspeed += randomInt(rng, -2, 1);
      break;
    case 2: // SEASON_BREEZY
      if (conditions.windspeed > 40) conditions.windspeed -= 5;
      else conditions.windspeed += randomInt(rng, -2, 2);
      break;
    case 3: // SEASON_UNSETTLED
      if (conditions.windspeed < 5) conditions.windspeed += 5;
      else if (conditions.windspeed > 60) conditions.windspeed -= 5;
      else conditions.windspeed += randomInt(rng, -6, 6);
      break;
    case 4: // SEASON_WINDY
      if (conditions.windspeed < 15) conditions.windspeed += 5;
      else if (conditions.windspeed > 80) conditions.windspeed -= 5;
      else conditions.windspeed += randomInt(rng, -6, 6);
      break;
    case 5: // SEASON_CHINOOK
      if (conditions.windspeed < 25) conditions.windspeed += 5;
      else if (conditions.windspeed > 110) conditions.windspeed -= 5;
      else conditions.windspeed += randomInt(rng, -15, 15);
      break;
    case 6: // SEASON_VIOLENT
      if (conditions.windspeed < 40) conditions.windspeed += 5;
      else conditions.windspeed += randomInt(rng, -8, 8);
      break;
    case 7: // SEASON_HURRICANE
      conditions.windspeed = 100;
      break;
    default:
      break;
  }

  conditions.freeEnergy += conditions.windspeed;
  if (conditions.freeEnergy < 0) conditions.freeEnergy = 0;
  else if (conditions.freeEnergy > 20_000) conditions.windspeed += randomInt(rng, -10, -1);
  conditions.windspeed = Math.max(0, conditions.windspeed);

  switch (climate.windVariance[season]) {
    case 0:
      conditions.windDir = climate.windDir[season] ?? 0;
      break;
    case 1:
      if (dice2d15(rng) * 1000 < conditions.freeEnergy) conditions.windDir = randomInt(rng, 0, 3);
      break;
    default:
      break;
  }

  /* -- temperature, weather.c:342-436 ------------------------------------- */

  switch (climate.temp[season]) {
    case 1: // SEASON_FROSTBITE
      if (conditions.temp > -20) conditions.temp -= 4;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 2: // SEASON_NIPPY
      if (conditions.temp < -40) conditions.temp += 2;
      else if (conditions.temp > 5) conditions.temp -= 3;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 3: // SEASON_FREEZING
      if (conditions.temp < -20) conditions.temp += 2;
      else if (conditions.temp > 0) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -2, 2);
      break;
    case 4: // SEASON_COLD
      if (conditions.temp < -10) conditions.temp += 1;
      else if (conditions.temp > 5) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -2, 2);
      break;
    case 5: // SEASON_COOL
      if (conditions.temp < -3) conditions.temp += 2;
      else if (conditions.temp > 14) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 6: // SEASON_MILD
      if (conditions.temp < 7) conditions.temp += 2;
      else if (conditions.temp > 26) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -2, 2);
      break;
    case 7: // SEASON_WARM
      if (conditions.temp < 19) conditions.temp += 2;
      else if (conditions.temp > 33) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 8: // SEASON_HOT
      if (conditions.temp < 24) conditions.temp += 3;
      else if (conditions.temp > 46) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 9: // SEASON_BLUSTERY
      if (conditions.temp < 34) conditions.temp += 3;
      else if (conditions.temp > 53) conditions.temp -= 2;
      else conditions.temp += randomInt(rng, -5, 5);
      break;
    case 10: // SEASON_HEATSTROKE
      if (conditions.temp < 44) conditions.temp += 5;
      else if (conditions.temp > 60) conditions.temp -= 5;
      else conditions.temp += randomInt(rng, -3, 3);
      break;
    case 11: // SEASON_BOILING
      if (conditions.temp < 80) conditions.temp += 5;
      else if (conditions.temp > 120) conditions.temp -= 5;
      else conditions.temp += randomInt(rng, -6, 6);
      break;
    default:
      break;
  }

  // weather.c:433-436. The day is two degrees warmer than the night, and that is the whole of the
  // diurnal cycle: `SUN_VISIBLE` is whatever `calcLight` left at the end of the previous change.
  if (conditions.flags & SUN_VISIBLE) conditions.temp += 2;
  else if (!(climate.flags & NO_SUN_EVER)) conditions.temp -= 2;

  /* -- humidity and the precipitation budget, weather.c:437-523 ----------- */

  switch (climate.precip[season]) {
    case 1: // SEASON_NO_PRECIP_EVER
      if (conditions.precipRate > 0) conditions.precipRate = Math.trunc(conditions.precipRate / 2);
      conditions.humidity = 0;
      break;
    case 2: // SEASON_ARID
      if (conditions.humidity > 30) conditions.humidity -= 3;
      else conditions.humidity += randomInt(rng, -3, 2);
      if (oldPrecip > 20) conditions.precipRate -= 8;
      break;
    case 3: // SEASON_DRY
      if (conditions.humidity > 50) conditions.humidity -= 3;
      else conditions.humidity += randomInt(rng, -4, 3);
      if (oldPrecip > 35) conditions.precipRate -= 6;
      break;
    case 4: // SEASON_LOW_PRECIP
      if (conditions.humidity < 13) conditions.humidity += 3;
      else if (conditions.humidity > 91) conditions.humidity -= 2;
      else conditions.humidity += randomInt(rng, -5, 4);
      if (oldPrecip > 45) conditions.precipRate -= 10;
      break;
    case 5: // SEASON_AVG_PRECIP
      if (conditions.humidity < 30) conditions.humidity += 3;
      else if (conditions.humidity > 80) conditions.humidity -= 2;
      else conditions.humidity += randomInt(rng, -9, 9);
      if (oldPrecip > 55) conditions.precipRate -= 5;
      if (oldPrecip < 15) conditions.precipRate += 5;
      break;
    case 6: // SEASON_HIGH_PRECIP
      if (conditions.humidity < 40) conditions.humidity += 3;
      else if (conditions.humidity > 90) conditions.humidity -= 2;
      else conditions.humidity += randomInt(rng, -8, 8);
      if (oldPrecip > 65) conditions.precipRate -= 10;
      if (oldPrecip < 20) conditions.precipRate += 10;
      break;
    case 7: // SEASON_STORMY
      if (conditions.humidity < 50) conditions.humidity += 4;
      else conditions.humidity += randomInt(rng, -6, 6);
      if (oldPrecip > 80) conditions.precipRate -= 10;
      if (oldPrecip < 30) conditions.precipRate += 10;
      break;
    case 8: // SEASON_TORRENT
      if (conditions.humidity < 60) conditions.humidity += 4;
      else conditions.humidity += randomInt(rng, -6, 9);
      if (oldPrecip > 100) conditions.precipRate -= 15;
      if (oldPrecip < 40) conditions.precipRate += 15;
      break;
    case 9: // SEASON_CONSTANT_PRECIP
      conditions.humidity = 100;
      if (conditions.precipRate < 10) conditions.precipRate += randomInt(rng, 5, 12);
      break;
    default:
      break;
  }

  conditions.humidity = Math.min(100, conditions.humidity);
  conditions.humidity = Math.max(0, conditions.humidity);

  /* -- pressure, weather.c:525-532 ---------------------------------------- */

  conditions.pressureChange += randomInt(rng, -3, 3);
  conditions.pressureChange = Math.min(8, conditions.pressureChange);
  conditions.pressureChange = Math.max(-8, conditions.pressureChange);
  conditions.pressure += conditions.pressureChange;
  conditions.pressure = Math.min(conditions.pressure, PRESSURE_MAX);
  conditions.pressure = Math.max(conditions.pressure, PRESSURE_MIN);

  conditions.freeEnergy += conditions.pressureChange;

  /* -- the magic number, weather.c:534-542 -------------------------------- */

  // The source's own comment: *"The numbers that follow are truly magic since they have little
  // bearing on reality."* `>> 4` and `/ 100` are C integer arithmetic and both are reproduced as
  // such — the shift on a value that is always positive here (pressure never exceeds 1040), the
  // division truncating toward zero because free energy can sit below 10,000.
  const magic =
    (((1240 - conditions.pressure) * conditions.humidity) >> 4) +
    conditions.temp +
    oldPrecip * 2 +
    Math.trunc((conditions.freeEnergy - 10_000) / 100);

  if (oldPrecip === 0) {
    messages.push(...dryLadder(conditions, oldWind, magic));
  } else if (magic < MAGIC_PRECIP_STOP) {
    conditions.precipRate = 0;
    messages.push(oldTemp > 0 ? 'The rain stops.' : 'It stops snowing.');
  } else {
    messages.push(...wetLadder(conditions, oldTemp, rng));
    messages.push(...celestial(conditions, climate, time));
  }

  calcLight(conditions, climate, time);
  return messages;
}

/**
 * `weather.c:544-619` — nothing was falling. Either it starts, or the zone gets a line about the
 * wind, or failing that a line about the temperature.
 *
 * A strict ladder: exactly one of these fires. Note the start test reads the **new** temperature to
 * pick rain or snow, where the stop test reads the old one — `weather.c:549` against `623`.
 */
function dryLadder(conditions: Conditions, oldWind: number, magic: number): string[] {
  if (magic > MAGIC_PRECIP_START) {
    conditions.precipRate += 1;
    return [conditions.temp > 0 ? 'It begins to rain.' : 'It starts to snow.'];
  }
  if (!oldWind && conditions.windspeed) return ['The wind begins to blow.'];
  if (conditions.windspeed - oldWind > 10) return ['The wind picks up some.'];
  if (conditions.windspeed - oldWind < -10) return ['The wind calms down a bit.'];

  if (conditions.windspeed > 60) {
    if (conditions.temp > 50) {
      return ['A violent scorching wind blows hard in the face of any poor travellers in the area.'];
    }
    if (conditions.temp > 21) return ['A hot wind gusts wildly through the area.'];
    if (conditions.temp > 0) return ['A fierce wind cuts the air like a razor-sharp knife.'];
    if (conditions.temp > -10) return ['A freezing gale blasts through the area.'];
    return ['An icy wind drains the warmth from all in sight.'];
  }

  if (conditions.windspeed > 25) {
    if (conditions.temp > 50) return ['A hot, dry breeze blows languidly around.'];
    if (conditions.temp > 22) return ['A warm pocket of air is rolling through here.'];
    if (conditions.temp > 10) return ["It's breezy."];
    if (conditions.temp > 2) return ['A cool breeze wafts by.'];
    if (conditions.temp > -5) return ['A slight wind blows a chill into living tissue.'];
    if (conditions.temp > -15) {
      return ['A freezing wind blows gently, but firmly against all obstacles in the area.'];
    }
    return ["The wind isn't very strong here, but the cold makes it quite noticeable."];
  }

  if (conditions.temp > 52) return ["It's hotter than anyone could imagine."];
  if (conditions.temp > 37) return ["It's really, really hot here.  A slight breeze would really improve things."];
  if (conditions.temp > 25) return ["It's hot out here."];
  if (conditions.temp > 19) return ["It's nice and warm out."];
  if (conditions.temp > 9) return ["It's mild out today."];
  if (conditions.temp > 1) return ["It's cool out here."];
  if (conditions.temp > -5) return ["It's a bit nippy here."];
  if (conditions.temp > -20) return ["It's cold!"];
  if (conditions.temp > -25) return ["It's really c-c-c-cold!!"];
  return ['Better get inside - this is too cold for man or -most- beasts.'];
}

/**
 * `weather.c:628-751` — it was already falling and it has not stopped. The rate drifts, then the
 * zone is told what that looks like: turning to snow or back to rain first, then a change of
 * intensity, then the plain description crossed with the wind.
 */
function wetLadder(conditions: Conditions, oldTemp: number, rng: Rng): string[] {
  if (conditions.freeEnergy > 10_000) conditions.precipChange += randomInt(rng, -3, 4);
  else conditions.precipChange += randomInt(rng, -4, 2);
  conditions.precipChange = Math.max(-10, conditions.precipChange);
  conditions.precipChange = Math.min(10, conditions.precipChange);
  conditions.precipRate += conditions.precipChange;
  conditions.precipRate = Math.max(1, conditions.precipRate);
  conditions.precipRate = Math.min(100, conditions.precipRate);
  conditions.precipDepth += conditions.precipRate;
  conditions.precipDepth = Math.max(1, conditions.precipDepth);
  conditions.freeEnergy -= conditions.precipRate * 2 - Math.abs(conditions.precipChange);

  if (oldTemp > 0 && conditions.temp <= 0) return ['The rain turns to snow.'];
  if (oldTemp <= 0 && conditions.temp > 0) return ['The snow turns to a cold rain.'];
  if (conditions.precipChange > 5) {
    return [conditions.temp > 0 ? 'It rains a bit harder.' : 'The snow is coming down faster now.'];
  }
  if (conditions.precipChange < -5) {
    return [conditions.temp > 0 ? 'The rain is falling less heavily now.' : 'The snow has let up a little.'];
  }

  if (conditions.temp > 0) {
    if (conditions.precipRate > 80) {
      if (conditions.windspeed > 80) return ["There's a hurricane out here!"];
      if (conditions.windspeed > 40) return ['The wind and the rain are nearly too much to handle.'];
      return ["It's raining really hard right now."];
    }
    if (conditions.precipRate > 50) {
      if (conditions.windspeed > 60) return ['What a rainstorm!'];
      if (conditions.windspeed > 30) return ['The wind is lashing this wild rain seemingly straight into your face.'];
      return ["It's raining pretty hard."];
    }
    if (conditions.precipRate > 30) {
      if (conditions.windspeed > 50) return ['A respectable rain is being thrashed about by a vicious wind.'];
      if (conditions.windspeed > 25) return ["It's rainy and windy but altogether not too uncomfortable."];
      return ["Hey, it's raining..."];
    }
    if (conditions.precipRate > 10) {
      if (conditions.windspeed > 50) {
        return ['The light rain here is nearly unnoticeable compared to the horrendous wind.'];
      }
      if (conditions.windspeed > 24) return ['A light rain is being driven fiercely by the wind.'];
      return ["It's raining lightly."];
    }
    if (conditions.windspeed > 55) return ['A few drops of rain are falling admidst a fierce windstorm.'];
    if (conditions.windspeed > 30) return ['The wind and a bit of rain hint at the possibility of a storm.'];
    return ['A light drizzle is falling here.'];
  }

  if (conditions.precipRate > 70) {
    if (conditions.windspeed > 50) return ['This must be the worst blizzard ever.'];
    if (conditions.windspeed > 25) return ["There's a blizzard out here, making it quite difficult to see."];
    return ["It's snowing very hard."];
  }
  if (conditions.precipRate > 40) {
    if (conditions.windspeed > 60) {
      return ['The heavily falling snow is being whipped up to a frenzy by a ferocious wind.'];
    }
    if (conditions.windspeed > 35) return ['A heavy snow is being blown randomly about by a brisk wind.'];
    if (conditions.windspeed > 18) return ['Drifts in the snow are being formed by the wind.'];
    return ["The snow's coming down pretty fast now."];
  }
  if (conditions.precipRate > 19) {
    if (conditions.windspeed > 70) {
      return ["The snow wouldn't be too bad, except for the awful wind blowing it in every direction."];
    }
    if (conditions.windspeed > 45) return ["There's a minor blizzard here, more wind than snow."];
    if (conditions.windspeed > 12) return ['Snow is being blown about by a stiff breeze.'];
    return ['It is snowing here.'];
  }
  if (conditions.windspeed > 60) return ['A light snow is being tossed about by a fierce wind.'];
  if (conditions.windspeed > 42) return ['A lightly falling snow is being driven by a strong wind.'];
  if (conditions.windspeed > 18) return ['A light snow is falling admidst an unsettled wind.'];
  return ['It is lightly snowing.'];
}

/**
 * `weather.c:753-773` — the celestial block, which the source runs **only while precipitation is
 * ongoing** (it sits inside the third branch).
 *
 * Its flag writes are then overwritten a few lines later by `calc_light_zone`, which uses different
 * bounds. The only surviving effect is the **moon line**, said the first time the moon becomes
 * visible during rain, with the full moon on day 17 getting its own. Transcribed in place rather
 * than tidied away, because the order is what makes the flags come out where they do.
 */
function celestial(conditions: Conditions, climate: Climate, time: GameTime): string[] {
  if (!(climate.flags & NO_SUN_EVER)) {
    if (time.hour < 6 || time.hour > 18 || conditions.humidity > 90 || conditions.precipRate > 80) {
      conditions.flags &= ~SUN_VISIBLE;
    } else {
      conditions.flags |= SUN_VISIBLE;
    }
  }
  if (!(climate.flags & NO_MOON_EVER)) {
    if (
      (time.hour > 5 && time.hour < 19) ||
      conditions.humidity > 80 ||
      conditions.precipRate > 70 ||
      time.day < 3 ||
      time.day > 31
    ) {
      conditions.flags &= ~MOON_VISIBLE;
    } else if (!(conditions.flags & MOON_VISIBLE)) {
      conditions.flags |= MOON_VISIBLE;
      return [
        time.day === 17
          ? 'The full moon floods the area with light.'
          : 'The moon casts a little bit of light on the ground.',
      ];
    }
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* The sky, as a word                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `do_weather` (`actinf.c:5826-5844`) — the source's own player-facing summary, and the only place
 * it turns these numbers back into a word.
 *
 * The vocabulary lives in `protocol.ts` because it is what the wire carries; it is derived rather
 * than stored for the reason the header gives: Duris has no sky *state*, it has a humidity and a
 * precipitation rate.
 */
export function skyOf(conditions: Conditions): SkyState {
  if (conditions.precipRate > 0) return conditions.temp <= 0 ? 'snowing' : 'raining';
  if (conditions.humidity > 80) return 'very_cloudy';
  if (conditions.humidity > 55) return 'cloudy';
  if (conditions.humidity > 25) return 'partly_cloudy';
  if (conditions.humidity > 0) return 'mostly_clear';
  return 'clear';
}

/* -------------------------------------------------------------------------- */
/* The running weather                                                         */
/* -------------------------------------------------------------------------- */

/** One zone's weather: what it is like there, what it tends to be like, and when it next turns. */
export interface ZoneWeather {
  readonly climate: Climate;
  readonly conditions: Conditions;
  /** Game hours until the next change. Counted down by {@link WorldWeather.advance}. */
  dueHours: number;
}

/** A zone whose weather just turned, and what it said. */
export interface WeatherChange {
  readonly zone: ZoneId;
  readonly messages: readonly string[];
}

/**
 * Every zone's weather, and the timer that turns it.
 *
 * Duris runs a hundred independent events, one per sector (`new_events.c:958-965`, whose own comment
 * asks *"Why do we have 100 events where the weather changes instead of just one?"*). We run one
 * countdown per zone against the game clock, which is the same independence without the scheduler
 * traffic — and, unlike a real timer, it is a number that serialises.
 */
export class WorldWeather {
  private readonly zones = new Map<ZoneId, ZoneWeather>();

  /** Seeds a zone that has none, at the season the clock is currently in. */
  ensure(zone: ZoneId, time: GameTime, rng: Rng): ZoneWeather {
    const existing = this.zones.get(zone);
    if (existing) return existing;
    const climate = climateFromRow(DEFAULT_CLIMATE_ROW, rng);
    const conditions = initialConditions(climate, seasonIndex(time.month));
    calcLight(conditions, climate, time);
    const fresh: ZoneWeather = { climate, conditions, dueHours: firstWeatherDelayHours(rng) };
    this.zones.set(zone, fresh);
    return fresh;
  }

  /** Puts a zone back exactly as it was — the restart path. */
  adopt(zone: ZoneId, state: ZoneWeather): void {
    this.zones.set(zone, state);
  }

  get(zone: ZoneId): ZoneWeather | undefined {
    return this.zones.get(zone);
  }

  all(): ReadonlyMap<ZoneId, ZoneWeather> {
    return this.zones;
  }

  /**
   * Counts every zone's timer down by `hours` and changes the weather of any that reached zero.
   *
   * A `while` rather than an `if`: a long delta (a debug rate, a resumed laptop) must not silently
   * skip a change, and the source's own timer would have fired every one of them. Bounded at four
   * changes an advance so a pathological delta cannot stall the tick — twenty game hours of weather
   * caught up at once is already well past anything a player could witness.
   */
  advance(hours: number, time: GameTime, rng: Rng): WeatherChange[] {
    if (!(hours > 0)) return [];
    const changes: WeatherChange[] = [];
    for (const [zone, state] of this.zones) {
      state.dueHours -= hours;
      let guard = 0;
      const messages: string[] = [];
      while (state.dueHours <= 0 && guard < 4) {
        messages.push(...changeWeather(state.conditions, state.climate, time, rng));
        state.dueHours += nextWeatherDelayHours(rng);
        guard++;
      }
      if (guard >= 4 && state.dueHours <= 0) state.dueHours = nextWeatherDelayHours(rng);
      if (messages.length > 0) changes.push({ zone, messages });
    }
    return changes;
  }

  /**
   * Re-derives sun, moon and ambient light for every zone without changing the weather.
   *
   * The source gets this for free: `calc_light_zone` runs at the end of every weather change, and
   * changes are frequent enough relative to the day that the sun is never far wrong. Ours runs on the
   * **hour** instead, which is strictly better and costs a loop over fourteen zones every 75 seconds:
   * without it a zone whose weather last turned at 03:00 would still be reporting a dark sky at noon.
   */
  relight(time: GameTime): void {
    for (const state of this.zones.values()) calcLight(state.conditions, state.climate, time);
  }
}
