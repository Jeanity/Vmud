/**
 * Levels, hit points and the experience that buys them.
 *
 * Phase 14b. See `docs/DESIGN-progression.md` for why the numbers are what they are; the short
 * version is that **the SRD sets the shape of the rules and Duris sets their magnitudes**, because
 * 49 populated zones and 1,499 mob templates are already calibrated to the Duris curve and the
 * player was the only thing on the SRD's.
 *
 * The gap that decision closes was not subtle: a level-1 character had 9 hit points and the gentlest
 * creature in the world — a level-2 baby kobold — has 23. The player needed seven rounds to kill it
 * and died in five and a half.
 *
 * ## Everything here is data, not derivation
 *
 * Hit points are **rolled once per level and stored**, never recomputed from a formula. A character's
 * hit points are a fact about them, not a function that silently changes when the function does. Same
 * reason the seen-map is stored rather than re-derived.
 */

import type { Rng } from './rules.ts';

/**
 * Duris' own experience table, from `duris.properties` via `update_exp_table()`.
 *
 * The generator falls back to the previous level whenever a step is unset, and only every fifth level
 * is set — so the curve is a **step function** rather than a smooth one. These are the eleven steps.
 *
 * **Per level, not cumulative.** `advance_level` does `GET_EXP(ch) -= new_exp_table[i]` in a loop, so
 * experience is a running balance toward the next level and one kill can carry you up more than once.
 * Both properties are kept: they are what make "experience to next level" a number a player can read
 * straight off their own sheet.
 */
const EXPERIENCE_STEPS: readonly { readonly upTo: number; readonly cost: number }[] = [
  { upTo: 5, cost: 2_000 },
  { upTo: 10, cost: 8_000 },
  { upTo: 15, cost: 25_000 },
  { upTo: 20, cost: 100_000 },
  { upTo: 25, cost: 400_000 },
  { upTo: 30, cost: 1_600_000 },
  { upTo: 35, cost: 3_000_000 },
  { upTo: 40, cost: 6_000_000 },
  { upTo: 45, cost: 12_600_000 },
  { upTo: 50, cost: 20_000_000 },
  { upTo: 60, cost: 40_000_000 },
];

/** TorilMUD's own ceiling, and the same one the admin panel validates against. */
export const MAX_LEVEL = 60;

/**
 * What it costs to reach `level` from the one below it.
 *
 * Level 1 is free — you start there. Anything past {@link MAX_LEVEL} is unreachable rather than
 * expensive, which is why it answers `Infinity`: a comparison against it is false for any experience
 * total, so the level-up loop terminates without needing to know the cap.
 */
export function experienceForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level > MAX_LEVEL) return Infinity;
  for (const step of EXPERIENCE_STEPS) if (level <= step.upTo) return step.cost;
  return Infinity;
}

/**
 * Hit points gained on reaching a level, rolled.
 *
 * Duris' `advance_level` exactly: `number(0,3) + 1` below level 26 — a d4 by another name — and a
 * flat `+1` at 26 and above. The flatness is not an oversight in the original and is not one here:
 * in Duris, high-level hit points come almost entirely from equipment, and the shallow base is the
 * room left for gear to be the whole story. We have no gear yet (Phases 15–16), which is exactly why
 * `DESIGN-progression.md` calibrates levels 1–15 and leaves the top of the curve visibly unfinished
 * rather than inventing a power curve Phase 16 would have to unpick.
 */
export function hitPointsForLevel(rng: Rng, level: number): number {
  if (level <= 1) return 0;
  return level < 26 ? 1 + Math.floor(rng() * 4) : 1;
}

/**
 * A level-1 character's hit points.
 *
 * 22, chosen against the measured world rather than from taste: the level 1–5 band deals a median of
 * 3 damage per round and has a median 46 hit points, so a new character needs to survive roughly
 * seven rounds to win their first fight, with margin for a bad opening. Nine — the SRD's d8-plus-Con
 * — bought five and a half.
 */
export const STARTING_HIT_POINTS = 22;

export interface Progress {
  readonly level: number;
  /** Experience banked toward the next level. Reset by the subtraction on each level gained. */
  readonly experience: number;
  readonly maxHp: number;
}

export interface LevelUp extends Progress {
  /** How many levels were gained. Zero means nothing happened and the caller says nothing. */
  readonly gained: number;
  /** Hit points added across all of them, for the one line that reports it. */
  readonly hitPointsGained: number;
}

/**
 * Spends banked experience on as many levels as it buys.
 *
 * A loop rather than a single step because Duris' is a loop, and for the same reason: one kill can
 * carry a low-level character up twice, and the alternative — banking the surplus and levelling again
 * on the next kill — makes a character's progress depend on the order they killed things in.
 *
 * Pure, and takes the rng so the roll is seeded like everything else in the simulation. The caller
 * owns applying the result; this function decides only what the result is.
 */
export function applyExperience(rng: Rng, current: Progress): LevelUp {
  let { level, experience, maxHp } = current;
  let gained = 0;
  let hitPointsGained = 0;

  while (level < MAX_LEVEL) {
    const cost = experienceForLevel(level + 1);
    if (experience < cost) break;
    experience -= cost;
    level += 1;
    const roll = hitPointsForLevel(rng, level);
    maxHp += roll;
    hitPointsGained += roll;
    gained += 1;
  }

  // At the ceiling experience simply accumulates. Refusing to bank it would silently discard a
  // kill's worth of work; spending it on nothing would be worse.
  return { level, experience, maxHp, gained, hitPointsGained };
}

/** How much more is needed for the next level, or `null` at the ceiling where there is no next. */
export function experienceToNext(progress: Progress): number | null {
  if (progress.level >= MAX_LEVEL) return null;
  return Math.max(0, experienceForLevel(progress.level + 1) - progress.experience);
}
