/**
 * Where the clock and the weather meet the world: who hears them, what goes on the wire, and what
 * survives a restart.
 *
 * `clock.ts` and `weather.ts` are transcriptions with no I/O and no knowledge of a room. This file
 * is the join, and it holds three things worth reading:
 *
 * ## 1. Two gates, and the difference between them is the point
 *
 * The source sends sunrise and rain to **different sets of people**, and it is easy to miss because
 * the two are three hundred lines apart:
 *
 * - The astral clock (`weather.c:239-248`) reaches anyone **awake**, not indoors, on the normal plane
 *   and not in the underworld. It does **not** check darkness. Dawn breaks over a gloomy moor.
 * - `send_to_weather_sector` (`weather.c:935-942`) additionally refuses `ROOM_DARK`, `ROOM_NO_PRECIP`
 *   and the blind. Rain is *seen*; the turning of the day is simply known.
 *
 * Both are transcribed as far as this project has the vocabulary. We have `dark` (2,283 rooms carry
 * it) and the `indoors` flag; we have no `ROOM_NO_PRECIP` and no blindness, and neither is invented.
 * `NORMAL_PLANE` / `IS_UNDERWORLD` land on {@link underOpenSky}, whose set already excludes `inside`,
 * `cave`, `underwater` and `astral` — which is the same question the source asks with a plane check.
 *
 * ## 2. The wire is per player, because weather is per zone
 *
 * `skyFor` builds one {@link SkyView} for one character's zone. Two players standing in different
 * zones get different messages, which is what `weather.c:872`'s hundred independent sectors mean.
 *
 * ## 3. Persistence: one document, beside the operator's switches
 *
 * `data/world/overrides/worldclock.json`, next to `settings.json` and `boards.json`, and for exactly
 * `boards.ts`'s stated reason: **nothing regenerates it**. It is not authored content (no human wrote
 * it), it is not per-character (it belongs to the world, not to a save file in `data/players/`), and
 * it is not derivable from `data/world/` (worldgen has no idea what the weather is). That leaves the
 * overrides directory, which is git-ignored and already the home of runtime world state.
 *
 * A single document rather than one file per half, because the two are **mutually dependent**: a
 * zone's `dueHours` is a countdown against the clock, so a clock restored from one file and a timer
 * restored from another could be torn by a crash between two writes into a state neither half ever
 * had. One write, or none.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RoomFlag, Sector, SkyView, ZoneId } from '@mygame/shared';
// Deep import, as `admin.ts` does: `light.ts` is deliberately outside the barrel.
import { underOpenSky } from '@mygame/shared/light.ts';

import { astralMessageAt, sunlightAt, timeFromHours, type ClockState, type GameClock } from './clock.ts';
import { skyOf, type Conditions, type ZoneWeather, type WorldWeather } from './weather.ts';
import { MOON_VISIBLE, SUN_VISIBLE } from './weather.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Beside `settings.json` and `boards.json`. See the header for why here and not `data/players/`. */
export const WORLD_CLOCK_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'worldclock.json');

/* -------------------------------------------------------------------------- */
/* Who hears it                                                                */
/* -------------------------------------------------------------------------- */

/** The half of a room these gates read. A shape rather than `Room` so a test needs no world. */
export interface SkyRoom {
  readonly sector: Sector;
  readonly flags?: readonly RoomFlag[];
}

/**
 * `IS_AWAKE` (`utils.h`) — anything above sleeping. Resting counts; the source's own gate is
 * position-based and a resting character is sitting with their eyes open.
 */
export function isAwake(status: string): boolean {
  return status === 'normal' || status === 'resting';
}

/**
 * Whether a room is under the sky at all — the shared half of both gates.
 *
 * `underOpenSky` is `light.ts`'s existing set, written for sun-vulnerability and correct here for the
 * same reason: it is the list of sectors where "outside" means the actual sky. The `indoors` flag is
 * Duris' `ROOM_INDOORS`, checked by both of the source's gates.
 */
export function isOutdoors(room: SkyRoom): boolean {
  if (!underOpenSky(room.sector)) return false;
  return !(room.flags?.includes('indoors') ?? false);
}

/**
 * `event_astral_clock`'s gate (`weather.c:241-246`): awake, outdoors, on the normal plane.
 *
 * **No darkness check**, and that is the source's, not an omission — see the header.
 */
export function hearsAstral(room: SkyRoom, status: string): boolean {
  return isAwake(status) && isOutdoors(room);
}

/**
 * `send_to_weather_sector`'s gate (`weather.c:937-938`): the astral gate plus `!IS_ROOM(r,
 * ROOM_DARK)`.
 *
 * `ROOM_NO_PRECIP` and `IS_BLIND` are the two clauses this project has no vocabulary for; both are
 * named here rather than approximated. The blind one is the more interesting omission — when
 * blindness exists, it belongs in this function and nowhere else.
 */
export function hearsWeather(room: SkyRoom, status: string): boolean {
  if (!hearsAstral(room, status)) return false;
  return !(room.flags?.includes('dark') ?? false);
}

/* -------------------------------------------------------------------------- */
/* The wire                                                                    */
/* -------------------------------------------------------------------------- */

/** One character's sky: the world clock, plus their own zone's weather. */
export function skyFor(clock: GameClock, conditions: Conditions | undefined): SkyView {
  const time = clock.now();
  return {
    hour: time.hour,
    progress: clock.progress(),
    hourMs: clock.msPerHour(),
    day: time.day,
    month: time.month,
    year: time.year,
    sunlight: sunlightAt(time.hour),
    // A zone with no weather yet is a zone nobody is standing in; `clear` is the honest default and
    // it never reaches a client, because the caller seeds the zone before asking.
    sky: conditions ? skyOf(conditions) : 'clear',
    precip: conditions?.precipRate ?? 0,
    wind: conditions?.windspeed ?? 0,
    temp: conditions?.temp ?? 0,
    light: conditions?.ambientLight ?? 0,
    sun: conditions ? (conditions.flags & SUN_VISIBLE) !== 0 : false,
    moon: conditions ? (conditions.flags & MOON_VISIBLE) !== 0 : false,
  };
}

/** The line the world says on entering an hour, or nothing. Re-exported so callers need one import. */
export { astralMessageAt };

/* -------------------------------------------------------------------------- */
/* Persistence                                                                 */
/* -------------------------------------------------------------------------- */

export interface WorldClockState {
  readonly clock: ClockState;
  /** Keyed by zone id as a string, because JSON object keys are strings. */
  readonly zones: Readonly<Record<string, ZoneWeather>>;
}

/**
 * Reads the saved world clock, or nothing.
 *
 * Nothing is a perfectly good answer and the caller has a good default for it — `GameClock.fresh`,
 * which is the source's own `reset_time`. So a missing, unreadable or corrupt file costs a boot on
 * the derived clock and a re-rolled sky, never a refusal to start.
 */
export function loadWorldClock(file: string = WORLD_CLOCK_FILE): WorldClockState | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { clock?: unknown; zones?: unknown };
  const clock = readClock(record.clock);
  if (!clock) return undefined;
  const zones: Record<string, ZoneWeather> = {};
  if (typeof record.zones === 'object' && record.zones !== null) {
    for (const [key, value] of Object.entries(record.zones as Record<string, unknown>)) {
      const zone = readZone(value);
      // A zone that will not parse is dropped rather than defaulted: the caller re-seeds it from the
      // climate, which is a fresh sky and not a wrong one.
      if (zone) zones[key] = zone;
    }
  }
  return { clock, zones };
}

function readClock(value: unknown): ClockState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { totalHours?: unknown; savedAtMs?: unknown };
  if (!Number.isFinite(record.totalHours) || !Number.isFinite(record.savedAtMs)) return undefined;
  return { totalHours: record.totalHours as number, savedAtMs: record.savedAtMs as number };
}

function readZone(value: unknown): ZoneWeather | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as { climate?: unknown; conditions?: unknown; dueHours?: unknown };
  if (typeof record.climate !== 'object' || record.climate === null) return undefined;
  if (typeof record.conditions !== 'object' || record.conditions === null) return undefined;
  if (!Number.isFinite(record.dueHours)) return undefined;
  return value as ZoneWeather;
}

export function saveWorldClock(
  clock: GameClock,
  weather: WorldWeather,
  nowMs: number,
  file: string = WORLD_CLOCK_FILE,
): void {
  const zones: Record<string, ZoneWeather> = {};
  for (const [zone, state] of weather.all()) zones[String(zone)] = state;
  const state: WorldClockState = { clock: clock.save(nowMs), zones };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** Puts every saved zone back into a live {@link WorldWeather}. */
export function adoptZones(weather: WorldWeather, saved: WorldClockState): void {
  for (const [key, state] of Object.entries(saved.zones)) {
    const zone = Number(key);
    if (!Number.isInteger(zone)) continue;
    weather.adopt(zone as ZoneId, state);
  }
}

/**
 * The one line the boot log prints — the source prints the same fact at `db.c:766-775`, in the same
 * twelve-hour-with-noon-and-midnight form, because a clock nobody can read is a clock nobody trusts.
 */
export function clockBanner(totalHours: number): string {
  const time = timeFromHours(totalHours);
  const twelve = time.hour % 12 === 0 ? 12 : time.hour % 12;
  const suffix =
    time.hour === 12 ? ' noon' : time.hour === 0 ? ' midnight' : time.hour > 11 ? 'pm' : 'am';
  return `${time.month}/${time.day}/${time.year} ${twelve}${suffix}`;
}
