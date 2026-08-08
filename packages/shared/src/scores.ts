/**
 * Ability scores — the derivation half Phase 14b named and never built, landed by Phase 21.
 *
 * The SRD sets the shape: six abilities ({@link ABILITIES}, the vocabulary `rules.ts` has carried
 * since 14b), scores on 3–20, and `floor((score − 10) / 2)` as the modifier every rule consults.
 * Duris sets the manner of the roll, and three of its choices are transcribed on purpose
 * (`roll_basic_attributes`, `actwiz.c`; `DESIGN-characters.md` §1):
 *
 * 1. **The roll is per race** — the racial bonus is applied *inside* the roll and clamped with
 *    it, so no combination can produce an impossible score.
 * 2. **Class minimums are met by the roll** (`min_stats_for_class`): an ability that comes up
 *    short is raised to its class minimum, not refused — which is why class is chosen before the
 *    dice are thrown.
 * 3. **Five bonus points afterwards** (`stats.bonus` in the live properties), so a bad roll is a
 *    starting point rather than a reason to disconnect.
 *
 * The player is shown **words at the roll and numbers at the table** (owner's rule, 2026-08-08):
 * {@link scoreWord} maps our 3–20 onto the source's own ladder (`stat_names2`, `actinf.c:193`).
 */

import { CLASSES, type ClassId } from './classes.ts';
import { RACES, racialBonus, type RaceId } from './races.ts';
import { ABILITIES, rollDice, type Ability, type AbilityScores, type Rng } from './rules.ts';

export const SCORE_MIN = 3;
export const SCORE_MAX = 20;
/** `stats.bonus.Human=5.000` — the points a fresh roll gets to spend. */
export const BONUS_POINTS = 5;
/** No score may be *bought* past this; only the race can carry one higher. */
const BOUGHT_CAP = 18;

/**
 * The source's word ladder, mapped from its 1–100 bands onto 3–20. What the roll shows; the sheet
 * afterwards shows the number.
 */
export function scoreWord(score: number): string {
  if (score <= 4) return 'lame';
  if (score <= 7) return 'poor';
  if (score <= 9) return 'below average';
  if (score <= 11) return 'average';
  if (score <= 13) return 'above average';
  if (score <= 15) return 'good';
  if (score <= 17) return 'very good';
  if (score <= 19) return 'excellent';
  return 'quite excellent';
}

const ONE_D_SIX = { count: 1, sides: 6, bonus: 0 } as const;

/**
 * The D&D roll, by name: four d6, drop the lowest — the owner's rule (2026-08-08 follow-up,
 * *"stats rolls that can be rerolled according to DnD rules"*), and the SRD's own standard method,
 * which supersedes this file's first draft of a flat 3d6. Kinder on average (12.24 against 10.5)
 * and bounded 3–18 exactly as before.
 */
function rollFourDropLowest(rng: Rng): number {
  const dice = [rollDice(rng, ONE_D_SIX), rollDice(rng, ONE_D_SIX), rollDice(rng, ONE_D_SIX), rollDice(rng, ONE_D_SIX)];
  dice.sort((a, b) => a - b);
  return dice[1]! + dice[2]! + dice[3]!;
}

/**
 * One fresh character's scores: 4d6-drop-lowest per ability, racial bonus inside the roll,
 * clamped 3–20, then raised to any class minimum left unmet. Deterministic under the seeded
 * {@link Rng}, like every roll in the simulation — and rerollable without limit at creation,
 * because the seed moves on and the five bonus points reset with it.
 */
export function rollScores(rng: Rng, raceId: RaceId, classId: ClassId): AbilityScores {
  const race = RACES[raceId];
  const mins = CLASSES[classId].mins;
  const out = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const rolled = rollFourDropLowest(rng) + racialBonus(race, ability);
    const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, rolled));
    out[ability] = Math.max(clamped, mins[ability] ?? SCORE_MIN);
  }
  return out;
}

/**
 * Spends bonus points: +1 per point, nothing bought past 18 plus the racial bonus, never more
 * than {@link BONUS_POINTS} in total. Returns the new scores, or a reason the spend is refused —
 * the server calls this with client input, so the refusals are the contract.
 */
export function spendBonus(
  scores: AbilityScores,
  spend: Readonly<Partial<Record<Ability, number>>>,
  raceId: RaceId,
): { ok: true; scores: AbilityScores } | { ok: false; reason: string } {
  const race = RACES[raceId];
  let total = 0;
  const out = { ...scores } as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const points = spend[ability] ?? 0;
    if (!Number.isInteger(points) || points < 0) return { ok: false, reason: 'points are whole and positive' };
    if (points === 0) continue;
    total += points;
    const cap = Math.min(SCORE_MAX, BOUGHT_CAP + Math.max(0, racialBonus(race, ability)));
    const next = out[ability] + points;
    if (next > cap) return { ok: false, reason: `${ability} cannot be bought past ${cap}` };
    out[ability] = next;
  }
  if (total > BONUS_POINTS) return { ok: false, reason: `only ${BONUS_POINTS} points to spend` };
  return { ok: true, scores: out };
}

/** Storage shape → scores, shrugging at garbage the way every other decoder here does. */
export function readScores(stored: unknown): AbilityScores | undefined {
  if (typeof stored !== 'object' || stored === null) return undefined;
  const record = stored as Record<string, unknown>;
  const out = {} as Record<Ability, number>;
  for (const ability of ABILITIES) {
    const value = record[ability];
    if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
    out[ability] = Math.min(SCORE_MAX, Math.max(SCORE_MIN, value));
  }
  return out;
}
