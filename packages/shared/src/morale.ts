/**
 * Morale and fleeing: whether a fight is still worth having, and what leaving one costs.
 *
 * `DESIGN-mobs-and-movement.md` §2.8 and `REFERENCE-mud-mechanics.md` §4.7. Only the numbers and the
 * predicates live here — the attempt itself is `server/src/flee.ts`, because it needs the room graph,
 * the scheduler and a body to move. Same split `threat.ts` and `pursuit.ts` make.
 *
 * ## §4.7's trap, which is the reason this file reads the way it does
 *
 * **`wimpy` does not mean auto-flee, and on a player it never did.** Duris' `GET_WIMPY(ch) > GET_HIT(ch)`
 * merely suppresses your *own* auto-engagement while you are hurt; the thing that actually runs away is a
 * mob with `ACT_WIMPY`, and it runs below **`level * 6` hit points** (`mobact.c`). So there is no player
 * wimpy setting here and there is not going to be one: a player leaves a fight by typing `flee`, which is
 * `DESIGN-engagement.md` §5's only voluntary exit.
 *
 * ## Why the threshold is absolute rather than a fraction
 *
 * §2.8 describes `wimpyAt` as *"HP fraction below which it attempts to flee"*, and the source disagrees —
 * it is a flat `level * 6`. The source is right here, and the reason is ours rather than its: **hit points
 * are rolled per instance** (`15d23+60`, since Phase 8), so a fraction of `maxHp` would have two guards of
 * one vnum break at different wounds — one at 180 and one at 240 — for no reason a player could ever read.
 * The absolute rule makes every guard of a template break at the same number of points taken, which is
 * what makes "this one is nearly done" a thing you can learn. The field is stored per template anyway, so
 * an authoring pass (Track A5) can tune one encounter without touching the rule.
 */

import type { Rng } from './rules.ts';

/* -------------------------------------------------------------------------- */
/* When a mob decides it has had enough                                        */
/* -------------------------------------------------------------------------- */

/**
 * Hit points per level below which an `ACT_WIMPY` mob runs — `mobact.c`'s `GET_LEVEL(ch) * 6`.
 *
 * Against the shipped world that lands between a third and a half of a mob's roll: a level 15 servant
 * (`15d23+60`, ~240) breaks around 37%, a level 35 patrol around 45%. It is not tuned to a fraction and
 * should not be re-derived into one — see the header.
 */
export const WIMPY_HP_PER_LEVEL = 6;

/** The hit points at which a wimpy mob of this level breaks. */
export function wimpyThreshold(level: number): number {
  return Math.max(1, Math.round(level * WIMPY_HP_PER_LEVEL));
}

/**
 * Whether this body has had enough, given the threshold its template carries.
 *
 * `wimpyAt` of 0 is a mob that never breaks, which is most of them — the flag is set on 8 of IceCrag's
 * 61 templates. Evaluated on round boundaries by `advanceCombat`, never per tick: a mob that
 * re-evaluated ten times a second would turn to run and back again inside one swing.
 */
export function breaksMorale(hp: number, wimpyAt: number): boolean {
  return wimpyAt > 0 && hp < wimpyAt;
}

/* -------------------------------------------------------------------------- */
/* Getting out                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The chance of breaking away from a fight, out of 100, given how many ways out the room has.
 *
 * `config.h`'s `MIN_CHANCE_TO_FLEE` (78, one exit) and `MAX_CHANCE_TO_FLEE` (86, four or more), with the
 * source's own integer arithmetic reproduced exactly: `78 + min(3, exits - 1) * 8 / 3` truncating at each
 * step gives **78, 80, 83, 86**. Rounding it "properly" would move two of the four numbers, and these are
 * a builder's tuning rather than a formula worth improving.
 *
 * Note how narrow the band is. A dead end is 78% and a crossroads is 86% — fleeing is *reliable*, and the
 * cost is what it takes out of you rather than the risk it fails. That matters for the feel of the
 * mechanic: §5 makes this the only voluntary exit, so a coin-flip escape would make disengaging a thing
 * you cannot plan around.
 */
export const MIN_FLEE_CHANCE = 78;
export const MAX_FLEE_CHANCE = 86;

export function fleeChance(availableExits: number): number {
  if (availableExits <= 0) return 0;
  const steps = Math.min(3, availableExits - 1);
  return MIN_FLEE_CHANCE + Math.trunc((steps * (MAX_FLEE_CHANCE - MIN_FLEE_CHANCE)) / 3);
}

/** Rolls the escape. Kept beside the chance so no caller can invent its own comparison. */
export function escapes(rng: Rng, availableExits: number): boolean {
  return Math.floor(rng() * 101) < fleeChance(availableExits);
}

/**
 * What a successful flight costs in movement points, rolled — `do_flee`'s `number(20, 30)`.
 *
 * The whole price of the mechanic, and it is deliberately steep: a third of a fresh character's pool, so
 * two fights fled in a row leaves you walking slowly through a castle full of things that are faster than
 * you. Duris discounts it for rogues (`number(5, 15)`); we have no classes until Phase 21, so there is one
 * number and a note saying where the second one goes.
 */
export const FLEE_COST_MIN = 20;
export const FLEE_COST_MAX = 30;

export function fleeCost(rng: Rng): number {
  return FLEE_COST_MIN + Math.floor(rng() * (FLEE_COST_MAX - FLEE_COST_MIN + 1));
}

/**
 * How long a body that fled is too winded to regenerate. The owner's lever, 2026-08-02.
 *
 * The problem it closes was found live: a kobold youth flees at half health and **heals while it
 * runs**, so at level-1 damage a chase could cross four rooms and end with the mob back near full —
 * the only practical kill window was the ~20%-per-attempt failed flee. Fleeing now stops the fleer
 * mending until this window passes, and the window **refreshes on every flight**, so a chase never
 * out-waits it.
 *
 * Sixty seconds against the chase's own cadence: a catch cycle — follow, close, swing until it runs
 * again — is five to twenty seconds, so the window holds across any real pursuit with room to spare,
 * while a mob that genuinely escapes starts healing a minute later and is not found half-dead an
 * hour on. Applies to **whoever flees, player or mob** — one flee, one price, same as `fleeCost`.
 */
export const WINDED_AFTER_FLEE_MS = 60_000;
