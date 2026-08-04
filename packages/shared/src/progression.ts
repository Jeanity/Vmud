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

/**
 * What dying takes, as a fraction of the level you were climbing toward.
 *
 * Duris' `exp.death.level.loss`, default **0.10** — `limits.c`'s `EXP_DEATH` branch computes
 * `-1 * (new_exp_table[level + 1] * 0.10)`. Deliberately quoted against the *next* level rather than
 * against what you are holding, which is what makes it a steady cost: dying always sets you back the
 * same tenth of a level whether you had banked nothing or nearly enough.
 *
 * A tenth is far gentler than it sounds from the presence of `lose_level` in the same file — at level
 * 1→2 it is 200 experience, about one kobold. The level only goes when the subtraction runs out of
 * balance to take, which is Duris' `while (GET_EXP(ch) < 0)` loop and {@link applyDeathCost} below.
 */
export const DEATH_LEVEL_LOSS = 0.1;

export interface DeathCost extends Progress {
  /** Experience actually taken. Zero for a level-1 character, who is exempt. */
  readonly experienceLost: number;
  /** Levels lost — almost always zero. See {@link applyDeathCost}. */
  readonly levelsLost: number;
}

/**
 * Charges a death.
 *
 * **Level 1 pays nothing**, which is Duris' own guard (`GET_LEVEL(ch) > 1` in `fight.c`) and not a
 * kindness invented here: a new character learning that mobs hit back should not also be learning
 * about debt, and there is nothing below level 1 to demote them to.
 *
 * A level is lost only when the charge runs out of banked experience to take — the balance would go
 * negative, so it is topped back up from the level below and the level goes instead. That makes dying
 * near the *top* of a level cheap and dying near the *bottom* expensive, which is the right shape:
 * it costs you the progress you actually had.
 *
 * **Hit points are not refunded on the way down.** Duris' `lose_level` docks `base_hit` by 3, but ours
 * were *rolled* per level and stored (`DESIGN-progression.md` §3), so there is no formula to invert —
 * subtracting an average would let a character farm maximum hit points by dying at the right moment.
 * Losing the level is the cost; the hit points that level bought are kept.
 */
export function applyDeathCost(current: Progress): DeathCost {
  if (current.level <= 1) return { ...current, experienceLost: 0, levelsLost: 0 };

  const charge = Math.round(experienceForLevel(current.level + 1) * DEATH_LEVEL_LOSS);
  let { level, experience } = current;
  let levelsLost = 0;
  experience -= charge;

  // Duris' `while (GET_EXP(ch) < 0)`: refill from the level below and demote, repeatedly. It loops
  // rather than stepping once because a single charge could in principle exceed a whole cheaper level
  // — the curve steps by 4x at a band boundary, so the level below is sometimes a quarter the price.
  while (experience < 0 && level > 1) {
    level -= 1;
    levelsLost += 1;
    experience += experienceForLevel(level + 1);
  }
  // Floor at zero for the level-1 case the loop cannot fix: there is no level below to borrow from.
  if (experience < 0) experience = 0;

  return { level, experience, maxHp: current.maxHp, experienceLost: charge, levelsLost };
}

/** How much more is needed for the next level, or `null` at the ceiling where there is no next. */
export function experienceToNext(progress: Progress): number | null {
  if (progress.level >= MAX_LEVEL) return null;
  return Math.max(0, experienceForLevel(progress.level + 1) - progress.experience);
}

/* -------------------------------------------------------------------------- */
/* Phase 16: damage that rises with level                                      */
/* -------------------------------------------------------------------------- */

/**
 * How much flat damage a character gains **at** each level — `DESIGN-progression.md` §8.
 *
 * **This is the one divergence from Duris in this file, and it is deliberate.** Duris has no per-level
 * damage bonus at all: `specials.damage_mod` looks like the missing term and is a *race* multiplier
 * scaled by zone difficulty, and `advance_level` is startlingly flat because in the real MUD high-level
 * power lives in equipment. But the owner's test is about *level* rather than kit — an unequipped level
 * 50 should flatten a level 10 — and nothing that lives in gear can answer that.
 *
 * The bands are measured against the shipped world rather than chosen:
 *
 * - **Nothing below 6.** 14b already calibrated the newbie band and a same-level fight at 5 is 8.1
 *   rounds. Any bonus there drops it under the six-to-eight target, so this phase must not re-tune what
 *   14b got right.
 * - **8–10 across 16–20, and the spike is the world's rather than ours.** Median mob hit points go
 *   203 → 500 between levels 15 and 20, the sharpest jump in the game. A smooth curve through it leaves
 *   level 20 at fourteen rounds.
 * - **It stops trying above 25.** A flat bonus big enough to make a level-50 same-level fight last seven
 *   rounds is +771, at which point a weapon's seven average damage is 0.9% of a swing — and Phase 16 is
 *   the gear phase. Duris bounds its own flat term at ±100 (`fight.c:4681`) and does the rest
 *   multiplicatively; ours stops for the same reason. The closing factor at high level is Phase 19's
 *   skills, Phase 20's buffs, and a group.
 */
export function damageBandFor(level: number): { readonly min: number; readonly max: number } {
  if (level <= 5) return { min: 0, max: 0 };
  if (level <= 15) return { min: 2, max: 3 };
  if (level <= 20) return { min: 8, max: 10 };
  return { min: 3, max: 5 };
}

/**
 * The gain for reaching one particular level, rolled.
 *
 * **Rolled once at the level-up and stored**, never derived at login — the same rule hit points and the
 * starter kit follow, and for the same two reasons: a character's damage is then a fact about them
 * rather than noise on every swing, and a value rolled at login is a value a player rerolls by
 * reconnecting.
 */
export function rollDamageGain(rng: Rng, level: number): number {
  const band = damageBandFor(level);
  if (band.max <= 0) return 0;
  return band.min + Math.floor(rng() * (band.max - band.min + 1));
}

/**
 * The expected total by a level — **the migration path, not the live rule.**
 *
 * A character who levelled before this shipped has no stored bonus, and giving them zero would leave a
 * level-40 veteran hitting like a novice. This hands them the band midpoints, which is the average they
 * would have rolled. Deliberately *not* used for anybody levelling normally: they roll.
 */
export function expectedDamageBonus(level: number): number {
  let total = 0;
  for (let l = 2; l <= level; l++) {
    const band = damageBandFor(l);
    total += (band.min + band.max) / 2;
  }
  return Math.round(total);
}
