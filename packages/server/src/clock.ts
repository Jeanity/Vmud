/**
 * The game clock — transcribed from Duris' `weather.c`, `db.c` and `config.h`.
 *
 * The owner asked, 2026-08-13, *"how long is this rain going to last?"* and the honest answer was
 * *until you press R*: rain was M4's visual toggle and **nothing in the world ticked a game hour**.
 * This file is the first half of the fix. The second is `weather.ts`, which cannot exist without it —
 * every rule in the source's weather model reads `time_info`.
 *
 * ## What the source actually says
 *
 * A game hour is **75 real seconds** (`config.h:93`, `SECS_PER_MUD_HOUR`), and the calendar above it
 * is 24 / 35 / 17: `SECS_PER_MUD_DAY 1800` is 24 hours, `SECS_PER_MUD_MONTH 63000` is 35 days,
 * `SECS_PER_MUD_YEAR 1071000` is 17 months (`config.h:93-96`). `event_another_hour` (`weather.c:53`)
 * increments and carries with exactly those bounds — `day > 34` rolls the month, `month > 16` rolls
 * the year (`weather.c:91-106`) — and it re-arms itself at `PULSES_IN_TICK` (300 pulses at 4
 * pulses/sec, `config.h:82`/`107`), which is the same 75 seconds by another route.
 *
 * **The source's clock is derived, not stored.** `reset_time` (`db.c:760`) computes the whole
 * calendar at boot from wall time with `mud_time_passed(time(0), beginning_of_time)`
 * (`utility.c:2137`), against a fixed epoch of `650336715` — 1990-08-11. So a Duris restart *resumes*
 * rather than resets, and downtime advances the world, because the clock was never a variable in the
 * first place. That is transcribed here as {@link hoursSinceEpoch}, and it is why a fresh server
 * with no state file opens on the same date a Duris player would read.
 *
 * ## Why it is nonetheless persisted
 *
 * Because the rate is data (`CLAUDE.md` rule 4). The moment `gameHourMs` can be thrown by an
 * operator, `elapsed / rate` stops being a stable function of wall time — halving the hour length
 * would teleport the calendar by decades. So {@link ClockState} stores the total hours reached and
 * the wall instant it was reached at, and a reload adds the downtime **at the current rate**. At the
 * default 75 s the two agree exactly, which is the property the round-trip test pins: persistence
 * buys rate-tunability and changes nothing else.
 *
 * ## What is deliberately not here
 *
 * `astral_clock_setMapModifiers` sets three sight-distance modifiers beside the message it returns
 * (`weather.c:136-220`, `map_normal_modifier` / `map_ultra_modifier` / `map_dayblind_modifier`).
 * Those drive the source's ASCII map radius, which this project has no analogue for — our fog is
 * tiles and light radii. The **message half** of that function is transcribed exactly; the modifier
 * half is named and dropped rather than invented into something it is not.
 */

import { randomInt, type Rng, type Sunlight } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* The source's constants                                                      */
/* -------------------------------------------------------------------------- */

/** `config.h:93`. A game hour is seventy-five real seconds. */
export const SECS_PER_MUD_HOUR = 75;

/** `config.h:94-96`, read back out of the second counts: 24 hours, 35 days, 17 months. */
export const HOURS_PER_DAY = 24;
export const DAYS_PER_MONTH = 35;
export const MONTHS_PER_YEAR = 17;

export const HOURS_PER_MONTH = HOURS_PER_DAY * DAYS_PER_MONTH;
export const HOURS_PER_YEAR = HOURS_PER_MONTH * MONTHS_PER_YEAR;

/** The default hour, in milliseconds. Overridable — see `settings.ts`. */
export const DEFAULT_HOUR_MS = SECS_PER_MUD_HOUR * 1000;

/**
 * `db.c:762`, `beginning_of_time`. Unix second 650,336,715 — 1990-08-11.
 *
 * Kept rather than replaced with our own zero, and that is not sentiment: it costs nothing and it
 * makes the world's date a transcribed fact instead of an invented one. A server booting today opens
 * on the same year the source would have printed.
 */
export const DURIS_EPOCH_SECONDS = 650_336_715;

/**
 * `config.h:82`/`107`. Four pulses a second, three hundred to the hour-tick.
 *
 * Exported because the weather's own cadence is written in pulses (`weather.c:778`) and converting
 * it here — once — is what keeps that timer rate-independent when an operator throws the hour length.
 */
export const PULSES_PER_HOUR = 300;

/* -------------------------------------------------------------------------- */
/* The calendar                                                                */
/* -------------------------------------------------------------------------- */

/** `structs.h:1074`, minus the two fields `mud_time_passed` never fills in a way anything reads. */
export interface GameTime {
  /** 0–23. */
  readonly hour: number;
  /** 0–34. */
  readonly day: number;
  /** 0–16. */
  readonly month: number;
  readonly year: number;
}

/**
 * The calendar at a whole-hour count — `mud_time_passed` (`utility.c:2137`) with the divisions
 * collapsed, which is the same arithmetic: its successive subtractions leave exactly these moduli.
 */
export function timeFromHours(totalHours: number): GameTime {
  const whole = Math.floor(totalHours);
  return {
    hour: modulo(whole, HOURS_PER_DAY),
    day: modulo(Math.floor(whole / HOURS_PER_DAY), DAYS_PER_MONTH),
    month: modulo(Math.floor(whole / HOURS_PER_MONTH), MONTHS_PER_YEAR),
    year: Math.floor(whole / HOURS_PER_YEAR),
  };
}

/** Positive-remainder modulo. A clock before its epoch is still a clock. */
function modulo(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/**
 * `reset_time` (`db.c:760`): the world's hour, derived from wall time and the source's epoch.
 *
 * The seed for a server that has never run. Fractional on purpose — the caller keeps the fraction so
 * the wire can say how far through the hour we are, which is what lets the 3D client's `setGameHour`
 * scrub smoothly between two messages 75 seconds apart.
 */
export function hoursSinceEpoch(nowMs: number, hourMs: number = DEFAULT_HOUR_MS): number {
  return (nowMs - DURIS_EPOCH_SECONDS * 1000) / hourMs;
}

/* -------------------------------------------------------------------------- */
/* Seasons                                                                     */
/* -------------------------------------------------------------------------- */

export const SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;

export type Season = (typeof SEASONS)[number];

/**
 * `get_season` (`weather.c:847`). Four seasons over seventeen months, so winter gets the odd one:
 * `month < 5 ? 0 : month < 9 ? 1 : month < 13 ? 2 : 3`.
 *
 * The parameter the source takes — `int sector` — is unused in its own body. Not transcribed.
 */
export function seasonIndex(month: number): number {
  return month < 5 ? 0 : month < 9 ? 1 : month < 13 ? 2 : 3;
}

export function seasonOf(month: number): Season {
  return SEASONS[seasonIndex(month)]!;
}

/* -------------------------------------------------------------------------- */
/* Sunlight                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `weather.h:64-69` — `IS_DAY`, `IS_TWILIGHT`, `IS_NIGHT`, verbatim bounds.
 *
 * They partition the day exactly, which is worth stating because the macros overlap in appearance and
 * not in fact: night is `hour <= 4 || hour > 19`, twilight is `(hour > 4 && hour < 8) || (hour > 16 &&
 * hour <= 19)`, day is `hour >= 8 && hour <= 16`. Nine night hours, six twilight, nine day.
 *
 * The type is `protocol.ts`'s — it goes on the wire, so the two cannot be allowed to drift.
 */
export function sunlightAt(hour: number): Sunlight {
  const h = modulo(Math.floor(hour), HOURS_PER_DAY);
  if (h >= 8 && h <= 16) return 'day';
  if ((h > 4 && h < 8) || (h > 16 && h <= 19)) return 'twilight';
  return 'night';
}

/* -------------------------------------------------------------------------- */
/* The astral clock                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `astralMsgs` (`weather.c:113-124`), keyed by the hour that `astral_clock_setMapModifiers`
 * (`weather.c:127`) returns each index at — so the table below *is* the switch, flattened.
 *
 * Colour codes are kept. They are Duris' own notation, `colour.ts` already renders them, and the
 * whole argument of that file is that throwing authored colour away is the bug. The trailing `\r\n`
 * is dropped: a log line is a line.
 *
 * Hours 6, 7, 10–13, 15 and 20–3 carry no message, exactly as `astralMsgIdx` stays 0 there. Note the
 * deliberate-looking fallthrough at `case 14` (`weather.c:176-178`): it sets message 5 and then takes
 * hour 15's sight modifiers. Only the message half concerns us, and hour 14 has one.
 */
export const ASTRAL_MESSAGES: Readonly<Record<number, string>> = {
  4: '&+bThe first hint of &+Cdaylight&N &+bcan be seen on the northern horizon.&n',
  5: '&+BThe first rays of&N &+Ysunlight&N&+B signal that day is approaching.&n',
  8: '&+cThe&N &+Ysun&N&+c rises over the northern horizon.&n',
  9: '&+CThe day has begun.&n',
  14: '&+MThe&n&+Y sun&N&+M hangs low on the southern sky.&n',
  16: '&+mThe &+Ysun&N &+mstarts to set in the south.&n',
  17: '&+LShadows stretch across the land as the &+Ysun&+L limps towards the horizon.&n',
  18: '&+bThe &N&+Ysun&N &+bvanishes behind the southern horizon.&n',
  19: '&+LThe night has begun.&n',
};

/** The line the world says on entering this hour, or nothing. */
export function astralMessageAt(hour: number): string | undefined {
  return ASTRAL_MESSAGES[modulo(Math.floor(hour), HOURS_PER_DAY)];
}

/* -------------------------------------------------------------------------- */
/* The running clock                                                           */
/* -------------------------------------------------------------------------- */

/** What survives a restart. See the header for why a derived clock is stored at all. */
export interface ClockState {
  /** Total game hours since {@link DURIS_EPOCH_SECONDS}, fractional. */
  readonly totalHours: number;
  /** The wall instant `totalHours` was true at, so a reload can add the downtime. */
  readonly savedAtMs: number;
}

/**
 * The world's clock: hours in, calendar out, and an edge every time an hour turns.
 *
 * Not a pure function of `Date.now()` — see the header. It is advanced by the 100 ms tick like
 * everything else in the simulation, which also means a test drives it by handing it milliseconds
 * rather than by mocking the system clock.
 */
export class GameClock {
  /**
   * Whole game hours since the epoch, and the real milliseconds accumulated toward the next one.
   *
   * **Two fields rather than one fractional count, and it is not a style choice.** A single
   * `hours += deltaMs / hourMs` drifts: seven hundred and fifty ticks of 100 ms against a 75,000 ms
   * hour lands on 0.9999999999999999 and the hour never turns. Counting the carry in milliseconds and
   * subtracting a whole hour off it is exact for as long as the process runs, and it is the same
   * shape `ZoneClock` already uses for repops.
   */
  private wholeHours: number;
  private carryMs: number;
  private hourMs: number;

  constructor(hours: number, hourMs: number = DEFAULT_HOUR_MS) {
    this.hourMs = Math.max(1, hourMs);
    this.wholeHours = Math.floor(hours);
    this.carryMs = (hours - this.wholeHours) * this.hourMs;
  }

  /**
   * A clock for a world with no saved state: the source's own derivation, `reset_time`.
   */
  static fresh(nowMs: number, hourMs: number = DEFAULT_HOUR_MS): GameClock {
    return new GameClock(hoursSinceEpoch(nowMs, hourMs), hourMs);
  }

  /**
   * A clock resumed from disk, carrying the downtime forward **at the current rate**.
   *
   * The rate matters and the argument is in the header: adding real downtime at the rate now in force
   * is what makes throwing `gameHourMs` change the speed of the world rather than its date.
   */
  static restore(state: ClockState, nowMs: number, hourMs: number = DEFAULT_HOUR_MS): GameClock {
    const rate = Math.max(1, hourMs);
    const downtime = Math.max(0, nowMs - state.savedAtMs);
    return new GameClock(state.totalHours + downtime / rate, rate);
  }

  /** Total game hours since the epoch, fractional. What goes on the wire and to disk. */
  totalHours(): number {
    return this.wholeHours + this.progress();
  }

  /** How far through the current hour, 0–1. What the wire carries so the client can interpolate. */
  progress(): number {
    return this.carryMs / this.hourMs;
  }

  now(): GameTime {
    return timeFromHours(this.wholeHours);
  }

  /** The current rate, in real milliseconds per game hour. */
  msPerHour(): number {
    return this.hourMs;
  }

  /**
   * Changes the rate without moving the date — the operator's knob.
   *
   * Only the *future* runs faster: `hours` is already accumulated, so re-basing it is neither needed
   * nor wanted. The alternative (re-deriving from the epoch at the new rate) is precisely the
   * teleport this class exists to prevent.
   */
  setMsPerHour(hourMs: number): void {
    // The *fraction* through the hour is preserved, not the millisecond count. Keeping the raw carry
    // would mean halving the hour length instantly turned the hour for anyone more than halfway
    // through one — a rate change that also moves the clock, which is the thing this class refuses
    // to do.
    const through = this.progress();
    this.hourMs = Math.max(1, hourMs);
    this.carryMs = through * this.hourMs;
  }

  /**
   * Advances by real milliseconds and returns **every whole hour crossed**, in order.
   *
   * A list rather than a count because each hour crossed may have its own astral line, and a tick
   * long enough to cross two (a debug rate, a paused laptop) must say both rather than only the last.
   * Duris cannot express this — its clock is one event re-arming itself — but its per-hour effects
   * are what we are reproducing, and dropping one is a lie the source never tells.
   */
  advance(deltaMs: number): number[] {
    if (!(deltaMs > 0)) return [];
    this.carryMs += deltaMs;
    const whole = Math.floor(this.carryMs / this.hourMs);
    this.carryMs -= whole * this.hourMs;
    this.wholeHours += whole;
    // Bounded: a delta big enough to cross a whole day is a clock jump, not a tick, and replaying
    // thousands of hourly effects would hang the tick it happened on. The *date* still moves fully —
    // only the list of hours to react to is capped, at the day's worth ending now.
    const crossed: number[] = [];
    const first = this.wholeHours - Math.min(whole, HOURS_PER_DAY) + 1;
    for (let h = first; h <= this.wholeHours; h++) crossed.push(h);
    return crossed;
  }

  /** What goes to disk. */
  save(nowMs: number): ClockState {
    return { totalHours: this.totalHours(), savedAtMs: nowMs };
  }
}

/* -------------------------------------------------------------------------- */
/* Cadence helpers shared with the weather                                     */
/* -------------------------------------------------------------------------- */

/**
 * `weather.c:778` — the sector's weather re-arms at `5 * PULSES_IN_TICK + number(-90, 90)` pulses.
 *
 * Written in **game hours** rather than milliseconds, which is the one liberty taken and the reason
 * for it is `CLAUDE.md` rule 4: the source's pulse is a fixed 250 ms, ours is a tunable hour, and a
 * jitter frozen in real time would become a different fraction of the hour every time the rate moved.
 * Five hours, plus or minus three tenths, at any rate.
 */
export function nextWeatherDelayHours(rng: Rng): number {
  return 5 + randomInt(rng, -90, 90) / PULSES_PER_HOUR;
}

/**
 * `new_events.c:962` — the first change is armed at `125 * WAIT_SEC + number(-9, 9)` pulses, so the
 * hundred sectors do not all turn on the same tick. Same conversion, same reason.
 */
export function firstWeatherDelayHours(rng: Rng): number {
  return (500 + randomInt(rng, -9, 9)) / PULSES_PER_HOUR;
}
