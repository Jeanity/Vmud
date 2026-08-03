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
}

export const DEFAULT_SETTINGS: WorldSettings = { pvp: false };

/** Reads the switches, falling back to the defaults for a missing or unreadable file. */
export function loadSettings(file = SETTINGS_FILE): WorldSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<WorldSettings>;
    // Only `true` turns it on. A hand-edited `"yes"` or `1` is not an authorisation to let players
    // kill each other, and the safe reading of a malformed dangerous flag is off.
    return { pvp: raw.pvp === true };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: WorldSettings, file = SETTINGS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}
