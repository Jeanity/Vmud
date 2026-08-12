/**
 * World settings an operator can throw at run time, and which survive a restart.
 *
 * One switch today: **whether players may kill each other.** Owner's rule (2026-08-03) and their
 * reasoning is the design: *"I am not a fan of pkill at all but I understand some people are, so
 * having it so I can turn it off or on would be a nice feature. I could have pkill days where I save
 * all the players' information in backup and turn on pkill and let them go at it."*
 *
 * ## Why this is a file and not a constant
 *
 * A constant would need a rebuild to change, and the whole point is that it is thrown for an evening
 * and thrown back. It is written to disk rather than held in memory because an operator who turns PvP
 * *off* and then restarts must not find it quietly on again — the failure is silent, and its cost is
 * a player being killed by a rule nobody meant to be in force.
 *
 * ## Off is the default, and that is a fix rather than a preference
 *
 * Nothing refused a player attacking another player before this existed: `startFight` checked only
 * that you were not attacking yourself. So the game shipped as a PvP game by omission. Defaulting to
 * `false` makes the stated intent — *"this is not a pkill game"* — actually true of the code.
 *
 * ## What it does not do
 *
 * It does not back anything up. The owner's event workflow is to copy `data/players/` aside, throw the
 * switch, and restore afterwards; that is a shell command against a directory of JSON files, and a
 * "backup" button that quietly decided *when* to snapshot would be worse than the copy they already
 * know how to make. See `DESIGN-admin-panel.md`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the switches live. Beside the authored overrides, for the same reason: nothing regenerates it. */
export const SETTINGS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'settings.json');

export interface WorldSettings {
  /**
   * Whether players may attack each other, and take from each other's corpses.
   *
   * **One flag for both**, deliberately. They are the same question asked at two moments, and a world
   * where you may kill someone but not take what they dropped — or the reverse — is a rule nobody can
   * hold in their head. Duris gates both off its own PvP state for the same reason.
   */
  readonly pvp: boolean;
  /**
   * Whether stepping into a room costs movement — the owner's event switch (2026-08-07): *"just in
   * case I decide to remove the cost of movement during special events."*
   *
   * **One flag for the whole economy of exhaustion**, deliberately: the terrain rate, the load
   * multiplier, the swim surcharge and the drowning drain are one system asked at four moments, and
   * a world where walking is free but swimming still kills is a rule nobody can hold in their head —
   * so throwing this off also suspends drowning, and yes, that means an event night's oceans are
   * crossable for nothing. That is what an event is. The ferry rule resumes with the switch.
   */
  readonly movementCosts: boolean;
  /**
   * How long a game hour lasts, in real milliseconds — default **75,000**, which is Duris'
   * `SECS_PER_MUD_HOUR` (`config.h:93`) to the second.
   *
   * A setting rather than a constant because `CLAUDE.md` rule 4 says so in as many words: *"round
   * length is data, not a constant sprinkled through code"*, and an hour is the world's other round.
   * The default is the transcription; the knob is for the two cases a constant cannot serve — an
   * operator who wants a longer day, and a tester who cannot wait twenty-five real minutes to watch
   * a sunset.
   *
   * Throwing it changes the *rate* and never the date: `GameClock` keeps accumulated hours and only
   * the future runs at the new speed. The weather's own timers are counted in game hours, so they
   * follow for free.
   */
  readonly gameHourMs: number;
}

/** The sane band for {@link WorldSettings.gameHourMs}: one second to one real hour. */
export const MIN_GAME_HOUR_MS = 1_000;
export const MAX_GAME_HOUR_MS = 3_600_000;

/** `config.h:93`. Seventy-five real seconds to the game hour. */
export const DEFAULT_GAME_HOUR_MS = 75_000;

export const DEFAULT_SETTINGS: WorldSettings = {
  pvp: false,
  movementCosts: true,
  gameHourMs: DEFAULT_GAME_HOUR_MS,
};

/** Reads the switches, falling back to the defaults for a missing or unreadable file. */
export function loadSettings(file = SETTINGS_FILE): WorldSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings>;
    return {
      // Only `true` turns it on. A hand-edited `"yes"` or `1` is not an authorisation to let players
      // kill each other, and the safe reading of a malformed dangerous flag is off.
      pvp: raw.pvp === true,
      // The mirror rule, because the polarity mirrors: costs are the shipped mechanic, so only an
      // explicit `false` suspends them — a malformed value must not quietly hand out a free world.
      movementCosts: raw.movementCosts !== false,
      // A number, and inside the band. Neither flag's polarity argument applies here — this is not a
      // dangerous switch, it is a rate — but the same instinct does: a hand-edited `0` divides the
      // world's clock by zero, and a `"75000"` is not a number. Anything that is not a finite number
      // in range reads as the transcription.
      gameHourMs: readHourMs(raw.gameHourMs),
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readHourMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_GAME_HOUR_MS;
  if (value < MIN_GAME_HOUR_MS || value > MAX_GAME_HOUR_MS) return DEFAULT_GAME_HOUR_MS;
  return value;
}

export function saveSettings(settings: WorldSettings, file = SETTINGS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
