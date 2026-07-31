/**
 * Threat: who a mob is trying to kill, and what it costs to change its mind.
 *
 * ## This is the deliberate divergence from the source, and it is worth being explicit about
 *
 * Duris does not have a threat table. `PickTarget` scores every legal victim with `CountToughness` and
 * takes the **minimum** — it attacks whoever is *weakest*: hit points, ×2/3 if a caster, ×2 if a warrior,
 * halved again if they are not yet fighting, then smeared by a level-dependent random factor. It is a
 * predator's rule and it produces good encounters, but it cannot produce **tanking**: nothing a player
 * does can make a mob prefer them, so holding a dragon off the healer is impossible by construction.
 *
 * `DESIGN-mobs-and-movement.md` §2.7 chose a threat table instead, and it is the one place this project
 * knowingly picks a different rule from the MUD it is built on. What that buys is named there: tanking,
 * off-tanking, kiting, leading mobs to chosen ground, and healers being a real liability to protect.
 *
 * **Both rules are used, at different moments**, which is the reconciliation rather than a compromise:
 *
 * - **Weakness picks who it opens on.** A mob that walks into a room with four strangers and no history
 *   has no threat to read, and `CountToughness` is a better answer than "whoever is first in the list".
 *   {@link toughnessOf} is that scoring, ported.
 * - **Threat governs every switch after.** Once blows land, the table decides — which is what makes a
 *   tank's job possible at all.
 *
 * ## Hysteresis is not a refinement, it is the mechanic
 *
 * §2.7: *"this detail is not optional."* With a bare `>` comparison two attackers of similar output make
 * a mob spin between them every round — it looks broken, and it makes holding aggro impossible, which
 * kills tanking outright. A challenger must **exceed** the current target by a margin before the mob
 * turns. The cost of switching is what makes threat a resource rather than a readout.
 */

/* -------------------------------------------------------------------------- */
/* The table                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much more threat a challenger needs before a mob turns on them.
 *
 * 1.1 — ten per cent, from §2.7's *"around 110%"*. Low enough that a genuinely harder-hitting attacker
 * takes aggro within a round or two, high enough that two similar attackers do not trade it every round.
 */
export const THREAT_SWITCH_MARGIN = 1.1;

/**
 * What healing an engaged ally is worth, as a fraction of the amount healed.
 *
 * §2.7: *"typically half the amount healed. This is why healers get attacked."* **Nothing produces this
 * yet** — healing is Phase 20 — so the constant is declared where the rule lives rather than invented
 * later beside the first heal, which is how a number like this ends up different in two places.
 */
export const THREAT_PER_HEAL = 0.5;

/** Threat generated per point of damage dealt. The baseline §2.7 measures everything else against. */
export const THREAT_PER_DAMAGE = 1;

/**
 * One mob's threat table: how much each character has done to earn its attention.
 *
 * A plain map rather than a class because it is data — the rules that read it are the functions below,
 * and the server holds one of these per engaged mob beside its awareness and its hunt.
 */
export type ThreatTable = Map<number, number>;

/**
 * Puts somebody on the table without adding anything to their score.
 *
 * **Participation and threat are different facts, and conflating them leaves healers out of the fight.**
 * Whether you are *in* this fight is a yes-or-no question answered by having an entry at all; how much
 * the mob hates you is the number in it. A healer who tops somebody up, a caster who lands a protection
 * spell, anyone who helps the aggressor in any way — they have joined the fight, and it must not matter
 * that the number they contributed was small or zero.
 *
 * Get this wrong and the failure is specific and bad: the party's front line dies, the mob finds nobody
 * with damage to its name, and **walks away from the healer who kept the fight going for five minutes**.
 *
 * So an entry may legitimately sit at zero. {@link pickByThreat} tests for *presence*, never for a
 * positive score.
 */
export function markParticipant(table: ThreatTable, actor: number): void {
  if (!table.has(actor)) table.set(actor, 0);
}

/** Whether somebody is in this fight at all, whatever they have contributed. */
export function isParticipant(table: ThreatTable, actor: number): boolean {
  return table.has(actor);
}

/**
 * Credits threat, and puts them on the table whether or not there was any to credit.
 *
 * A heal that restored nothing because the target was already full still joined the fight — see
 * {@link markParticipant}.
 */
export function addThreat(table: ThreatTable, actor: number, amount: number): number {
  markParticipant(table, actor);
  if (amount <= 0) return table.get(actor) ?? 0;
  const next = (table.get(actor) ?? 0) + amount;
  table.set(actor, next);
  return next;
}

export function threatOf(table: ThreatTable, actor: number): number {
  return table.get(actor) ?? 0;
}

/** Forgets one character entirely — they died, disconnected, or left the fight. */
export function dropThreat(table: ThreatTable, actor: number): boolean {
  return table.delete(actor);
}

/**
 * Who this mob should be fighting, given what it can currently reach.
 *
 * `reachable` is passed in rather than filtered here because "can I reach them" is the server's question
 * — same room, still alive, still in the world — and this module deliberately knows nothing about rooms.
 *
 * ## Only people who joined in
 *
 * **A candidate who is not on the table is not a candidate.** Start a brawl in an inn, go down, and the
 * thing you picked the fight with must not round on the other drinkers — they did nothing to it. But
 * anybody who waded in on your side is on the table and the fight carries on with them.
 *
 * *On the table*, not *dealt damage* — see {@link markParticipant}. A healer contributes no damage and
 * is every bit as much in the fight as the person swinging; a rule keyed on damage would let a mob walk
 * away from the one who kept the party standing.
 *
 * This is why the table is consulted rather than the room. An *aggressive* mob still attacks strangers on
 * sight, and that is right — but it happens through `aggression.ts`'s predicate and Phase 9's reaction,
 * not through here. Threat answers a narrower question: of the people who have hurt me, whom do I hate
 * most? A mob with an empty table and a room full of bystanders is answered `undefined`, and stops.
 *
 * Returns the **current target unchanged** unless a challenger clears the margin, which is the whole of
 * the hysteresis rule. A current target that has become unreachable is not defended: the highest
 * reachable entry wins outright, which is §2.7's *"on target death, or when the top-threat target cannot
 * be reached, the mob falls to the next entry."*
 */
export function pickByThreat(
  table: ThreatTable,
  reachable: readonly number[],
  current: number | undefined,
): number | undefined {
  if (reachable.length === 0) return undefined;

  let best: number | undefined;
  let bestThreat = -Infinity;
  for (const id of reachable) {
    // **Presence, not a positive score.** A healer sits at zero and is still in the fight; a bystander
    // has no entry at all. This one test is both halves of the rule.
    if (!isParticipant(table, id)) continue;
    const threat = threatOf(table, id);
    // Ties break toward the lower id rather than iteration order, so the same fight replays identically —
    // the same reason the scheduler carries a sequence number.
    if (threat > bestThreat || (threat === bestThreat && best !== undefined && id < best)) {
      best = id;
      bestThreat = threat;
    }
  }
  if (best === undefined) return undefined;

  // No current target, or the one it had is gone: take the top of the table with no margin to clear.
  if (current === undefined || !reachable.includes(current)) return best;
  if (best === current) return current;

  // The margin. Note `>` rather than `>=`: an exact tie at 110% is not an improvement worth turning for.
  return threatOf(table, best) > threatOf(table, current) * THREAT_SWITCH_MARGIN ? best : current;
}

/* -------------------------------------------------------------------------- */
/* Weakness, for the opening choice                                            */
/* -------------------------------------------------------------------------- */

/** What {@link toughnessOf} needs to know about a candidate. Deliberately tiny. */
export interface ToughnessSubject {
  readonly hp: number;
  /** Whether they are already in a fight — Duris halves the score of anyone who is not. */
  readonly fighting: boolean;
  /**
   * Class bloc, once classes exist (Phase 21). `caster` scores ×2/3 and `warrior` ×2, so a mob prefers
   * the squishy one. **Nothing sets this yet**, which makes the branch inert rather than wrong — every
   * candidate is scored on hit points alone until there are classes to tell apart.
   */
  readonly bloc?: 'caster' | 'warrior';
}

/**
 * Duris' `CountToughness`, ported — **lower is more attractive**.
 *
 * Used only to choose an opening target, and only when the threat table is empty. The random smear the
 * source applies (`val * 100 / number(100 - foo, 100 + foo)`, with `foo = MAX(0, 60 - level)`) is
 * deliberately *not* included: it would need the seeded RNG threaded through a pure scoring function, and
 * its purpose is to stop a mob picking identically every time — which our tie-break on entity id already
 * handles deterministically, and determinism is worth more to us than variety here (`CLAUDE.md` rule 3).
 */
export function toughnessOf(subject: ToughnessSubject): number {
  let value = Math.max(0, subject.hp);
  if (subject.bloc === 'caster') value = (value * 2) / 3;
  else if (subject.bloc === 'warrior') value = value * 2;
  // "Not yet fighting" halves it, so a mob that has just walked in prefers the bystander over the person
  // already swinging at somebody else. That is what makes a fresh arrival dangerous to the back line.
  if (!subject.fighting) value = value / 2;
  return value;
}

/** The most attractive of several candidates by {@link toughnessOf}, ties broken on id. */
export function pickByWeakness(
  candidates: readonly { readonly id: number; readonly subject: ToughnessSubject }[],
): number | undefined {
  let best: number | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const score = toughnessOf(candidate.subject);
    if (score < bestScore || (score === bestScore && best !== undefined && candidate.id < best)) {
      best = candidate.id;
      bestScore = score;
    }
  }
  return best;
}
