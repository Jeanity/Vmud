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
 * **Grouping is Phase 18**, so nothing calls {@link groupDivisor} yet. It is here because the rule
 * belongs beside the award it modifies, and because §4.4 exists precisely to stop somebody reaching for
 * the obvious `exp / N` on the day groups arrive.
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
 * Unused until Phase 18 builds grouping. Kept here so that the day it is needed nobody writes `/ N`.
 */
export function groupDivisor(members: number): number {
  return (Math.max(1, members) + 3) / 4;
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
