/**
 * Regeneration, and the cost of walking.
 *
 * ## Two axes, multiplied
 *
 * This is where posture and status stop being flavour. `hit_regen` in `limits.c` switches on **both**
 * axes, one after the other, and each multiplies what the previous left:
 *
 * ```c
 * switch (GET_STAT(ch)) {                     // consciousness
 *   case STAT_DYING:    gain = -2;  break;    // you LOSE hit points while dying
 *   case STAT_INCAP:    gain = -1;  break;
 *   case STAT_SLEEPING: gain += gain >> 1;    // 150%
 *   case STAT_RESTING:  gain += gain >> 2;    // 125%
 * }
 * switch (GET_POS(ch)) {                      // posture — applied separately, and it stacks
 *   case POS_PRONE:     gain += gain >> 2;    // 125%
 *   case POS_SITTING:   gain += gain >> 3;    // 113%
 *   case POS_KNEELING:  gain += gain >> 4;    // 106%
 * }
 * ```
 *
 * So asleep on the floor is 1.5 × 1.25 = **1.875×**, and standing awake is 1×. Collapse the two axes
 * into one enum and that whole table becomes inexpressible — which is the argument §1.3 makes, cashed
 * out in a number you can watch on a bar.
 *
 * The shifts are Duris' way of writing percentages in integer arithmetic; the fractions here say the
 * same thing without pretending the machine still cares.
 *
 * ## Rates are per minute, spending is per tick
 *
 * Every rate below is **per real minute**, which is the unit `limits.c` uses and a human can reason
 * about. Spending them happens on the 100 ms tick, so the fraction has to be carried between ticks —
 * see {@link accrue}. Rounding it away each tick would silently floor every rate under 600/min to
 * zero, which is all of them.
 */

import { AffectFlag, newAffect, type Affect } from './affects.ts';
import { statusRank, type Posture, type Stance, type Status } from './position.ts';
import { TICK_MS } from './rules.ts';
import { SECTOR_MOVE_COST, type Sector } from './world.ts';

/** Ticks in a minute — the divisor that turns a per-minute rate into a per-tick one. */
export const TICKS_PER_MINUTE = 60_000 / TICK_MS;

/* -------------------------------------------------------------------------- */
/* Base rates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Base regeneration per minute, before posture and status.
 *
 * Duris derives these from age through `graf()` — seven values across seven age bands, peaking in
 * youth and falling away. We have no age and it is explicitly not scheduled (Duris built ageing,
 * shipped it, and switched it off), so each of these is that curve's mid-band value: hit 13,
 * mana 12, move 16.
 *
 * They are also the *whole* of the base for now. Duris adds `points.hit_reg` from gear, epic bonuses,
 * innates, hunger and thirst; every one of those is a later phase, and each will arrive as a modifier
 * on top of this rather than as a second copy of it.
 */
export const BASE_REGEN: Readonly<Record<VitalPool, number>> = {
  hp: 13,
  mana: 12,
  move: 16,
};

export type VitalPool = 'hp' | 'mana' | 'move';

/**
 * Status multipliers, or an absolute rate when the status overrides regeneration entirely.
 *
 * `dying` and `incapacitated` are **absolute and negative** — `gain = -2` and `gain = -1`, replacing
 * the base rather than scaling it. That is the bleed-out, and it is what makes the dying window a
 * clock rather than a state: left alone you get worse, so a rescue is a race and not a formality.
 */
interface StatusRegen {
  /** Multiplier applied to the base. */
  readonly scale?: number;
  /** Absolute per-minute rate, overriding the base entirely. */
  readonly absolute?: number;
}

const STATUS_REGEN: Readonly<Record<Status, StatusRegen>> = {
  dead: { absolute: 0 },
  dying: { absolute: -2 },
  incapacitated: { absolute: -1 },
  sleeping: { scale: 1.5 },
  resting: { scale: 1.25 },
  normal: { scale: 1 },
};

/**
 * Posture multipliers, applied *on top of* the status one.
 *
 * Note that these are gentle — 6% to 25% — and that standing is the baseline. Lying down helps a
 * little; being asleep helps a lot. The posture axis is a nudge and the status axis is the decision,
 * which is the right balance: it means `rest` is the command that matters and `prone` is a detail.
 */
const POSTURE_REGEN: Readonly<Record<Posture, number>> = {
  prone: 1.25,
  sitting: 1.125,
  kneeling: 1.0625,
  standing: 1,
};

/**
 * Where the flat bonus stops paying full price, and what it pays above it.
 *
 * `hit_regen` again, and this clause is the reason regeneration gear cannot be stacked into
 * immortality:
 *
 * ```c
 * if (ch->points.hit_reg > 16)
 *   gain += (int)(2. * sqrt(4 * ch->points.hit_reg));   // == 4 * sqrt(hit_reg)
 * else
 *   gain += ch->points.hit_reg;
 * ```
 *
 * It is continuous where it matters: 16 pays 16, and 17 pays 16.5. So the first sixteen points are
 * linear and everything past them is a long flat tail — a second identical item is worth about a
 * quarter of the first, and the tenth is worth almost nothing.
 *
 * Nothing we ship reaches 16 yet; {@link SECOND_WIND_BONUS} is single digits. It is implemented
 * anyway, because the alternative is a Phase 16 armour set silently getting linear returns and the
 * bug being a balance complaint rather than an error. The one departure from the source is that we do
 * not truncate to an integer — our rates are carried as fractions on purpose (see {@link accrue}), so
 * rounding here would throw away the precision the accumulator exists to keep.
 */
export const REGEN_BONUS_SOFT_CAP = 16;

export function regenBonus(total: number): number {
  if (total <= REGEN_BONUS_SOFT_CAP) return total;
  return 4 * Math.sqrt(total);
}

/**
 * Per-minute regeneration for one pool, given how the body is arranged and what is affecting it.
 *
 * `fighting` zeroes it outright, as `hit_regen` does — you do not knit bone mid-swing, and without
 * that clause resting would be a way to out-heal being hit.
 *
 * Mana and movement stop dead below `sleeping`; only hit points go *negative*, because bleeding is a
 * property of blood. Duris says the same thing by giving mana and move `gain = 0` for all three
 * bottom states while hp gets -2 and -1.
 *
 * ## The bonus is flat, and it lands *after* the multipliers
 *
 * `bonus` is the total of every `hpRegen`/`manaRegen`/`moveRegen` affect — Duris' `points.hit_reg`,
 * which `hit_regen` adds **after** both position switches have run, not before. That ordering is the
 * whole character of the two kinds of regeneration and it is worth stating: posture and status are
 * *multiplicative* and gear-style bonuses are *additive*, so they do not compound. Resting does not
 * make your second wind stronger; it makes your body stronger and then the second wind is added on.
 * Fold the bonus in before the switches and a 1.875× sleep multiplier would double every buff in the
 * game, which is how regeneration balance dies.
 *
 * ## Three rules at the bottom of the ladder, and they are not the same rule
 *
 * - **Hit points take the bonus even while bleeding.** `gain = -2` overrides the *base*, and
 *   `points.hit_reg` is still added on top of it, so regeneration really can slow or reverse a bleed.
 *   Faithful, and it is a moment worth having: you rested, you were beaten down, and you cling on.
 * - **Mana and movement do not.** `move_regen` guards the addition with `if (gain || move_reg < 0)`,
 *   so a zeroed pool stays zeroed. A dying character does not recover stamina because they had a good
 *   sit down.
 * - **Hit points can never come to a standstill while unconscious.** `if (gain == 0 && GET_STAT(ch) <
 *   STAT_SLEEPING) gain = -1;` — a clause that exists *precisely because* the bonus can cancel the
 *   bleed, and it means the dying window stays a clock. A rescue is still a race; the best a bonus can
 *   do is give you longer to be rescued in.
 *
 * `dead` is arithmetically reachable here and is not a case this function guards: {@link regenerates}
 * is the gate, and it answers `false` for a corpse. Nothing in the simulation asks a dead character
 * how fast they are healing.
 */
export function regenPerMinute(
  pool: VitalPool,
  stance: Stance,
  options: { readonly fighting?: boolean; readonly bonus?: number } = {},
): number {
  if (options.fighting) return 0;
  // A corpse is not a body doing slow arithmetic, and this has to be said *before* the clauses below
  // rather than fall out of them: with a bonus in play, `gain = 0` plus a positive modifier would have
  // the dead healing, and the standstill rule at the bottom would otherwise have them bleeding. Duris
  // reaches the same answer by a different route — `gain = 0` for `STAT_DEAD`, and `die()` removes the
  // character before either tail clause can be reached.
  if (stance.status === 'dead') return 0;

  const status = STATUS_REGEN[stance.status];
  const bonus = regenBonus(options.bonus ?? 0);

  let gain: number;
  if (status.absolute !== undefined) {
    // Only hit points bleed. A dying character does not lose stamina, they lose blood.
    gain = pool === 'hp' ? status.absolute : 0;
  } else {
    gain = BASE_REGEN[pool] * (status.scale ?? 1) * POSTURE_REGEN[stance.posture];
  }

  if (pool === 'hp' || gain !== 0 || bonus < 0) gain += bonus;

  if (pool === 'hp' && gain === 0 && statusRank(stance.status) < statusRank('sleeping')) return -1;
  return gain;
}

/* -------------------------------------------------------------------------- */
/* Rest that deepens                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How long rest must go unbroken before it is worth something extra.
 *
 * Thirty seconds is chosen against what it costs you rather than against a feel: a room crossing is
 * about 2.3 s, so this is roughly thirteen rooms you did not walk. Short enough that stopping to rest
 * is a real option in the middle of exploring, long enough that it cannot be collected by tapping
 * `rest` and standing straight back up.
 */
export const SECOND_WIND_AFTER_MS = 30_000;

/** How long the reward lasts. Twice the wait, so patience is worth more than it cost. */
export const SECOND_WIND_DURATION_MS = 60_000;

/**
 * The bonus, per pool, per minute — flat, on top of everything else.
 *
 * Half the base rate each ({@link BASE_REGEN} is 13/12/16), which is a real difference without being
 * a different game: resting hit-point regeneration goes from 16.25 a minute to 22.25, so a bar that
 * was moving every four seconds moves every three. Deliberately well under
 * {@link REGEN_BONUS_SOFT_CAP} — the curve is there for stacked gear in Phase 16, and the first thing
 * to use this mechanism should not be the thing that tests the cap.
 */
export const SECOND_WIND_BONUS: Readonly<Record<VitalPool, number>> = {
  hp: 6,
  mana: 6,
  move: 8,
};

/**
 * Which regeneration location each pool is fed by.
 *
 * A table rather than a template string, so a typo is a type error rather than an affect that applies
 * to a location nothing reads.
 */
export const REGEN_APPLY = {
  hp: 'hpRegen',
  mana: 'manaRegen',
  move: 'moveRegen',
} as const satisfies Record<VitalPool, string>;

/**
 * The timer you are given for sitting down: one node, no modifier, nothing derived from it.
 *
 * `NoSave`, because it is a property of the situation and not of the character — the sitting still is
 * the cost, and carrying a part-served wait across a reconnect would be a way to bank one.
 */
export function settlingAffect(): Affect {
  return newAffect({
    type: 'settling',
    durationMs: SECOND_WIND_AFTER_MS,
    flags: AffectFlag.NoSave,
  });
}

/**
 * The reward: **three nodes of one type**, one per regeneration location.
 *
 * This is the multi-apply idiom from `REFERENCE-mud-mechanics.md` §4.12 in the flesh, and it is here
 * on purpose rather than as one node with three numbers. `type` is not a key — a cause installs one
 * node per location it touches — and the only way that rule stays true in code is for the first thing
 * to use it to actually need it. Removal takes all three, and the display path shows one row.
 */
export function secondWindAffects(): Affect[] {
  return (Object.keys(SECOND_WIND_BONUS) as VitalPool[]).map((pool) =>
    newAffect({
      type: 'second_wind',
      durationMs: SECOND_WIND_DURATION_MS,
      apply: REGEN_APPLY[pool],
      modifier: SECOND_WIND_BONUS[pool],
      flags: AffectFlag.NoSave,
    }),
  );
}

/** Whether this status is one that rest accumulates in. Sleeping counts; standing about does not. */
export function isResting(status: Status): boolean {
  return status === 'resting' || status === 'sleeping';
}

/* -------------------------------------------------------------------------- */
/* Fractional accumulation                                                     */
/* -------------------------------------------------------------------------- */

export interface Accrual {
  /** Whole points to apply now. May be negative. */
  readonly points: number;
  /** The fraction to carry into the next tick. Always has the same sign as the rate. */
  readonly carry: number;
}

/**
 * Turns a per-minute rate into whole points plus a remainder to carry.
 *
 * This is `regen_value += per_tick / PULSES_IN_TICK` and the `(int)` truncation around it, which is
 * the mechanism that lets a rate of 13 per minute mean anything at all on a 100 ms tick: it is 0.0217
 * points, and any implementation that rounds per tick makes it exactly zero for ever.
 *
 * Truncation toward zero, deliberately, on both signs — so a bleed of -2/min spends whole points at
 * the same cadence a heal of +2/min does, rather than one of them limping a tick behind the other.
 */
export function accrue(carried: number, perMinute: number): Accrual {
  const total = carried + perMinute / TICKS_PER_MINUTE;
  const points = Math.trunc(total);
  return { points, carry: total - points };
}

/* -------------------------------------------------------------------------- */
/* The cost of walking                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Movement points spent entering a room of this terrain.
 *
 * `SECTOR_MOVE_COST` has existed, tested, with **zero callers** since the beginning — one of the four
 * mechanisms `ROADMAP.md` names as the failure mode it exists to prevent. This is the caller.
 *
 * The average of the two sectors, as Diku does: you pay half for the ground you leave and half for the
 * ground you arrive on, so a road-to-mountain step costs less than mountain-to-mountain. Rounded up,
 * because a free step is worse than a cheap one — a pool that never moves is decorative again.
 */
export function moveCost(from: Sector, to: Sector): number {
  return Math.max(1, Math.ceil((SECTOR_MOVE_COST[from] + SECTOR_MOVE_COST[to]) / 2));
}

/**
 * Whether a character has the stamina for a step, and what it costs.
 *
 * Being out of movement is not the same as being unable to move: Duris lets you keep going and simply
 * refuses when the pool cannot cover the cost. So this answers both questions at once and the caller
 * says which one it hit.
 */
export function canAffordStep(move: number, cost: number): boolean {
  return move >= cost;
}

/**
 * Whether regeneration has anything left to do for this pool.
 *
 * `hit_regen` opens with exactly this test and returns 0 — which is what lets the scheduler stop
 * re-arming the event instead of running a no-op ten times a second for every idle character in the
 * world.
 */
export function needsRegen(current: number, max: number, perMinute: number): boolean {
  if (perMinute > 0) return current < max;
  if (perMinute < 0) return true;
  return false;
}

/** Clamps a pool into `[floor, max]`. Hit points floor below zero; the others stop at nothing. */
export function clampPool(value: number, max: number, floor: number): number {
  return Math.max(floor, Math.min(max, value));
}

/**
 * How far below zero hit points may go before the character is simply gone.
 *
 * One point below the death threshold, so `statusFor` has somewhere to *be* dead rather than the
 * number running away for ever. See `HP_DEAD_BELOW` in `position.ts`.
 */
export const HP_FLOOR = -11;

/** Movement and mana have no negative half — you run out, you do not go into debt. */
export const POOL_FLOOR = 0;

/** Whether a stance regenerates at all, for deciding if a character is worth scheduling. */
export function regenerates(stance: Stance): boolean {
  return statusRank(stance.status) > statusRank('dead');
}
