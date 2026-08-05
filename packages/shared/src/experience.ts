/**
 * Experience: who earned a kill, and why the answer is not "whoever landed the last blow".
 *
 * ## Contribution, not the killing blow
 *
 * `ROADMAP.md` Phase 13: *"experience awarded from damage dealt **and taken**, not only from the killing
 * blow."* That single choice is what makes tanking and healing viable with **no role system at all**. A
 * tank contributes by absorbing; a healer contributes by keeping somebody upright; neither lands the
 * finishing hit, and a last-hit rule would pay them nothing and quietly make solo damage the only way to
 * play. Nothing else in this project has to know what a "role" is for that to work.
 *
 * ## The group divisor is Duris', and getting its sign wrong breaks the game
 *
 * `REFERENCE-mud-mechanics.md` §4.4 is emphatic. Almost every implementation assumes `exp / N`. Duris
 * divides by **`(N + 3) / 4`**, which means:
 *
 * | Party | Divisor | Each member gets | Party total |
 * | --- | --- | --- | --- |
 * | 1 | 1.00 | 100% | 100% |
 * | 2 | 1.25 | 80% | 160% |
 * | 4 | 1.75 | 57% | 229% |
 * | 8 | 2.75 | 36% | 291% |
 *
 * Total payout **rises** with party size and every member beats a fraction of solo, so grouping is
 * self-interested rather than altruistic. That is why MUD populations organise into parties with no
 * matchmaking system anywhere — and §4.4's warning is that with `exp / N` solo play is strictly optimal
 * and the entire social layer that grouping, following, tanking, healing and consent exist to support
 * simply never forms.
 *
 * ## How the divisor composes with contribution — Phase 18, owner's call 2026-08-06
 *
 * Duris pays **every group member standing in the room** `(level / highest_level) * (gain / divisor)`,
 * whatever they did. We pay by contribution. Both rules cannot decide the same kill, and the owner
 * picked the composition: **the group multiplies what a contributor earned, and only members who
 * actually fought count toward the size.**
 *
 * That lands on Duris' own numbers where it matters and is exploit-free where his rule is not:
 *
 * - Two members who both fight, contributing equally, get 50% × {@link groupMultiplier}(2) = **80%
 *   each**, for a party total of 160% — the table above, exactly.
 * - Twelve idle alts parked in the room change **nothing**, because a member with no contribution is
 *   not counted. Under the literal rule they would each draw a share, and under a
 *   multiply-the-whole-pool reading the one player fighting would collect 3.25× solo.
 *
 * So the *total* a group earns is Duris'; *who* earns it is ours. What survives from the source
 * untouched is {@link powerLevelDivisor} — the one thing contribution cannot police, because taking a
 * single hit from a level 50 mob is contribution, and paying a level 1 a share of it is a career.
 */

/* -------------------------------------------------------------------------- */
/* What a share is worth                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What one character did in a fight, as the ledger records it.
 *
 * Three separate numbers because they are three different ways to earn a share, and collapsing them
 * would silently rank one above the others. `supported` is a **count of acts**, not an amount — a heal
 * that restored nothing still kept somebody standing.
 */
export interface Contribution {
  /** Damage this character dealt to the mob. */
  readonly dealt: number;
  /** Damage the mob dealt to this character. The tank's share. */
  readonly taken: number;
  /** Heals, buffs and protections cast on somebody in this fight. The healer's share. */
  readonly supported: number;
}

export const NO_CONTRIBUTION: Contribution = { dealt: 0, taken: 0, supported: 0 };

/**
 * What each unit of contribution is worth, relative to a point of damage dealt.
 *
 * Damage taken is worth the same as damage dealt, deliberately: a tank standing in front of something
 * for a whole fight has contributed as much as the person hitting it, and any discount here is a thumb
 * on the scale telling players that tanking is the lesser job. Support is worth a flat amount per act
 * because there is no natural unit — a protection spell that prevented damage has no number attached,
 * and paying by amount healed would make a healer's share depend on how badly the tank was playing.
 */
export const VALUE_PER_DAMAGE_DEALT = 1;
export const VALUE_PER_DAMAGE_TAKEN = 1;
export const VALUE_PER_SUPPORT_ACT = 25;

export function contributionValue(contribution: Contribution): number {
  return (
    contribution.dealt * VALUE_PER_DAMAGE_DEALT +
    contribution.taken * VALUE_PER_DAMAGE_TAKEN +
    contribution.supported * VALUE_PER_SUPPORT_ACT
  );
}

/* -------------------------------------------------------------------------- */
/* Dividing the pool                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Duris' group divisor: `(N + 3) / 4`. See the module note — the sign of this is load-bearing.
 *
 * `fight.c:3000`, and note what `N` counts there: **group members in the killer's own room**, not the
 * group's size. The source is explicit about it — *"Ppl out of room still count against exp gain?
 * Erm... no"* — and it is the right call, because a divisor that grew with somebody standing four
 * rooms away would punish a group for having a scout.
 */
export function groupDivisor(members: number): number {
  return (Math.max(1, members) + 3) / 4;
}

/**
 * What one member's contribution share is multiplied by: `N / divisor(N)`, which is `4N / (N + 3)`.
 *
 * Derived rather than chosen, and the derivation is the whole argument. Duris hands each of `N` equal
 * members `pool / divisor`; our split hands each of `N` equal contributors `pool / N`. Multiplying the
 * second by this makes them the same number — so the group's total payout is the source's, while the
 * *distribution* stays contribution's. See the module note for why the two had to be reconciled at all.
 *
 * `1` for a lone contributor, so an ungrouped kill is untouched by grouping's existence.
 */
export function groupMultiplier(members: number): number {
  const n = Math.max(1, members);
  return n / groupDivisor(n);
}

/**
 * The power-levelling stopgap, transcribed from `fight.c` — a divisor, 1 when the gap is small.
 *
 * The source's own comment calls it a *"power leveler stopgap measure"*, and the shape is four steps
 * rather than a curve: 15 levels below the highest in the room divides by 40, 20 by 150, 30 by 1,000,
 * 40 by 5,000. Steep on purpose — this is not a tuning knob, it is a wall.
 *
 * **It is the one rule contribution cannot replace.** Everywhere else, weighting by damage dealt,
 * damage taken and support does the work Duris' `level / highest_level` scaling does, and does it
 * better because it measures the thing directly. But *taking a hit is contribution* — a level 1 who
 * stands in front of a level 50 mob for one round has genuinely taken 200 damage, and by our own rule
 * that earns a large share of a pool worth dozens of their levels. So this stays.
 *
 * Measured against the highest level **among the contributing members present**, which is what the
 * source measures it against (`highest_level`, computed over group members in the room).
 */
export function powerLevelDivisor(level: number, highest: number): number {
  const gap = highest - level;
  if (gap >= 40) return 5000;
  if (gap >= 30) return 1000;
  if (gap >= 20) return 150;
  if (gap >= 15) return 40;
  return 1;
}

/**
 * One member's share after the group has had its say: the bonus, then the wall.
 *
 * Ordered that way deliberately. The bonus is what the group earned together and the wall is a limit
 * on what *this* member may take out of it, so applying the wall first would let a bigger group buy
 * back part of a penalty that exists to be unbuyable.
 *
 * Floored, like {@link divideExperience}'s own shares and for the same reason — a fractional point of
 * experience is not a thing anyone can spend, and rounding it up would pay a 5,000-divided share of a
 * huge kill one point instead of none.
 */
export function groupedShare(
  share: number,
  options: { readonly members: number; readonly level: number; readonly highest: number },
): number {
  const { members, level, highest } = options;
  return Math.floor((share * groupMultiplier(members)) / powerLevelDivisor(level, highest));
}

/** One character's cut of a kill. */
export interface Award {
  readonly actor: number;
  readonly experience: number;
  readonly contribution: Contribution;
}

/**
 * Splits a kill between everyone who contributed, in proportion to what they did.
 *
 * **Everyone with any contribution gets something**, which is the rule the phase is about. A character
 * who only ever took damage, or only ever healed, is on this list.
 *
 * Rounded down per share, with the remainder simply lost rather than handed to the highest contributor:
 * a rounding rule that quietly favours whoever did the most damage is exactly the thumb on the scale
 * this module exists to avoid, and the amounts involved are single points of experience against pools in
 * the thousands.
 */
export function divideExperience(
  pool: number,
  contributions: ReadonlyMap<number, Contribution>,
): Award[] {
  if (pool <= 0 || contributions.size === 0) return [];

  let total = 0;
  const values = new Map<number, number>();
  for (const [actor, contribution] of contributions) {
    const value = contributionValue(contribution);
    if (value <= 0) continue;
    values.set(actor, value);
    total += value;
  }
  if (total <= 0) return [];

  const awards: Award[] = [];
  // Sorted by id so the same fight divides identically every time — the same determinism rule the
  // scheduler's tie-break and the threat table's follow.
  for (const actor of [...values.keys()].sort((a, b) => a - b)) {
    const share = Math.floor((pool * (values.get(actor) ?? 0)) / total);
    if (share <= 0) continue;
    awards.push({
      actor,
      experience: share,
      contribution: contributions.get(actor) ?? NO_CONTRIBUTION,
    });
  }
  return awards;
}
