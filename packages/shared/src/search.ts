/**
 * `search` — looking harder at what is already in front of you.
 *
 * Owner's ask, 2026-08-10: *"maybe the haystack can be searched with a chance of finding a needle
 * that is part of a quest in the future."* Transcribed from `do_search` (`actobj.c:5771`) and its
 * gate `find_chance` (`actobj.c:5758`), and it closes a second ask with the same build — *"hidden
 * items in corpses, found by searching"* (owner, 2026-08-06), which wants this verb and this gate.
 *
 * ## Search is not a skill, and that is the interesting part
 *
 * There is no `SKILL_SEARCH` anywhere in the source. `interp.c:2608` registers `CMD_SEARCH` at
 * `STAT_NORMAL + POS_STANDING` with no skill argument, and the whole gate is:
 *
 * ```c
 * if (((GET_C_INT(ch) + GET_C_WIS(ch) + GET_C_LUK(ch)) / 3) > number(1, 101)) return TRUE;
 * ```
 *
 * **Everyone can search, and how good you are at it is who you are rather than what you practised.**
 * That is worth preserving exactly: it makes a wise character quietly better at something without
 * a practice session, which is the only place in this game so far where an ability score is the
 * whole answer instead of a modifier on a roll.
 *
 * ## The scale had to be converted, and luck had to be dropped
 *
 * **Duris' stats are percentile.** `STAT_INDEX` (`utility.c:4205`) buckets a raw score in steps of
 * roughly six — 1, 10, 16, 22, 28, 34 … — across the 52 slots `str_app[52]` holds, and
 * `find_chance` compares the raw average against `number(1, 101)`, a straight percentile roll.
 * Ours are SRD: 4d6-drop-lowest, 3 to 18. Copying the comparison would make a brilliant character
 * succeed 18 times in 100, so the score is converted the way this project has converted a foreign
 * scale twice already — {@link SCORE_TO_PERCENT}, a plain five-times, which is the classic d20-to-
 * percentile step and puts a 10 at a coin flip and an 18 at 90.
 *
 * **Luck is dropped and named as dropped.** `GET_C_LUK` is Duris' seventh stat; `ABILITIES` in
 * `rules.ts` is the SRD's six and has no room for it. So the average is over two rather than three.
 * If luck ever arrives this is the first place that wants it, and the divisor is the only line that
 * changes.
 *
 * ## What is deliberately not here
 *
 * `do_search` finds four kinds of thing, and three of them have nothing to find in this world yet —
 * measured before building rather than discovered after:
 *
 * - **Trip wires on trapped objects** (`k->trap_charge`, rogue-only). We have no traps.
 * - **Secret exits** (`EX_SECRET` on a door). Nothing in our harvest carries the bit.
 * - **Hidden characters** (`AFF_HIDE`, behind a second `!number(0,3)` gate). We have no hide.
 * - **A shut container's refusal** — *"Opening it would probably improve your chances."* Our
 *   `ContainerRule` has no `closed` at all; only doors shut. The sentence is transcribed here in
 *   this comment rather than shipped as an unreachable branch, which is the thing this project keeps
 *   warning itself about.
 *
 * That leaves the fourth, `ITEM_SECRET` — an object that is really there and simply is not listed
 * until somebody looks properly — which is both of the owner's asks and the reason the verb earns
 * its place. The other three are transcribed as comments here so the next person adding traps,
 * secret doors or hiding knows the verb is already waiting for them.
 */

import type { Rng } from './rules.ts';
import { randomInt } from './rules.ts';

/**
 * SRD score to percentile.
 *
 * Five, because an SRD ability runs 3–18 and Duris' runs 0–100: a 10 becomes 50, an 18 becomes 90,
 * a 3 becomes 15. Nothing subtler is warranted — the source's own gate is a single comparison, and
 * a curve fitted to it would be inventing precision the original never had.
 */
export const SCORE_TO_PERCENT = 5;

/** A round of standing still, `CharWait(ch, PULSE_VIOLENCE)` at the end of `do_search`. */
export const SEARCH_LAG_ROUNDS = 1;

/**
 * The chance to notice something, as a percentage.
 *
 * The average of the scores that matter, converted. Clamped to 0–100 so a modified score outside
 * the SRD band cannot produce a certainty in either direction — nothing produces one today, and a
 * search that could never fail would quietly delete the mechanic.
 */
export function findChance(intelligence: number, wisdom: number): number {
  const average = (intelligence + wisdom) / 2;
  return Math.max(0, Math.min(100, average * SCORE_TO_PERCENT));
}

/**
 * One attempt. `number(1, 101) < chance` in the source's own direction.
 *
 * Takes the rng so simulation stays deterministic and a test can pin the outcome — the project's
 * rule, and the reason no `Math.random` appears anywhere below `shared`.
 */
export function findsIt(rng: Rng, intelligence: number, wisdom: number): boolean {
  return findChance(intelligence, wisdom) > randomInt(rng, 1, 101);
}

/**
 * The one sentence the verb actually needs, kept verbatim.
 *
 * It does triple duty in `do_search` — the word named nothing, the thing named has no inside, and
 * the search turned up nothing at all. **One sentence for three outcomes is deliberate on the
 * source's part and worth keeping**: telling a player *which* of the three happened would tell them
 * whether there is anything there to find, which is the one thing a search is supposed to cost you
 * a round to learn.
 */
export const SEARCH_LINES = {
  notFound: "You don't find anything you didn't see before.",
} as const;
