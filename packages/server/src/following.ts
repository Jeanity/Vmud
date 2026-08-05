/**
 * Who is walking behind whom — **Phase 18's first half.**
 *
 * `ROADMAP.md`: *"Followers move by re-issuing the movement intent, never by teleporting."* That one
 * sentence decides nearly everything here, and it is worth spelling out why it is not merely tidier.
 * A follower who is *moved* arrives wherever the leader is, through closed doors, across deep water,
 * out of a fight, and without paying a step's stamina. A follower who is issued **the same intent**
 * meets every rule the leader met, separately: their own exhaustion, their own engagement, their own
 * blocked door. A train that breaks because one member was too tired is the correct outcome and
 * needs no code of its own — it falls out of asking rather than telling.
 *
 * ## Duris' own rules, transcribed
 *
 * `do_follow` (`actmove.c:3116`) is where the shape comes from:
 *
 * - **The follower chooses; the leader does not consent.** Anyone may follow anyone they can see. That
 *   reads wrong until you notice the leader's remedy is one command away, which is the next line.
 * - **`follow stop` throws off everybody in the room** — the leader's answer, and deliberately scoped
 *   to the room, so somebody trailing you from three rooms back is not silently dropped.
 * - **One master at a time.** Following somebody new stops following whoever it was first — the source
 *   calls `stop_follower` before `add_follower` rather than refusing.
 * - **Loops are refused.** `circle_follow` walks the chain; so does {@link wouldLoop}. Without it two
 *   characters following each other are a movement intent that never terminates.
 * - **Following yourself is how you stop.** `follow <your own name>` clears it, which is the one form
 *   of the command that reads oddly and is worth keeping, because it is what a Diku player's fingers
 *   already do.
 *
 * ## What is deliberately *not* here
 *
 * Grouping. Consent, a shared list and the superlinear experience split are the phase's other half,
 * and following is the half that can be seen on its own: two characters walk the map as one train.
 * Keeping them apart also keeps the relationship honest — in Duris you can follow somebody without
 * being in their group, and the two facts answer different questions.
 */

import type { EntityId } from '@mygame/shared';

/**
 * Who follows whom, as a pair of indexes over one relationship.
 *
 * Both directions are stored because both are asked on the hot path: a step needs *this leader's
 * followers*, and a disconnect needs *this character's leader*. Deriving either by scanning would be
 * a walk over every player on every step.
 *
 * A separate store rather than fields on `Player`, the same shape `hunt.ts` and `threat.ts` take:
 * this is a fact *between* characters, and hanging half of it on each of two actors is how the two
 * halves drift apart.
 */
export interface Following {
  /** Who each character is following. */
  readonly leaderOf: Map<EntityId, EntityId>;
  /** Who is following each character. Insertion-ordered, so a train keeps the order it formed in. */
  readonly followersOf: Map<EntityId, Set<EntityId>>;
}

export function newFollowing(): Following {
  return { leaderOf: new Map(), followersOf: new Map() };
}

/** Who this character is walking behind, if anyone. */
export function leaderOf(state: Following, follower: EntityId): EntityId | undefined {
  return state.leaderOf.get(follower);
}

/** Who is walking behind this one, in the order they joined. */
export function followersOf(state: Following, leader: EntityId): readonly EntityId[] {
  return [...(state.followersOf.get(leader) ?? [])];
}

/**
 * Whether making `follower` follow `leader` would close a ring.
 *
 * `circle_follow`, and the reason it is not optional: the step propagation walks the chain, so a ring
 * is not a strange state to be in — it is a movement intent that never terminates.
 *
 * Walks upward from the proposed leader. If the follower is anywhere above, adding this link joins
 * the two ends of the same chain.
 */
export function wouldLoop(state: Following, follower: EntityId, leader: EntityId): boolean {
  let above: EntityId | undefined = leader;
  // Bounded by the chain length, which is bounded by the number of characters — but written as a
  // walk with a visited set rather than a `while (true)`, because a ring that somehow already exists
  // must not hang the server while it is being asked about.
  const seen = new Set<EntityId>();
  while (above !== undefined && !seen.has(above)) {
    if (above === follower) return true;
    seen.add(above);
    above = state.leaderOf.get(above);
  }
  return false;
}

/**
 * Starts following, having stopped following whoever it was.
 *
 * Returns whether anything changed — following the same person twice is not an error, it is a
 * repeated statement of a fact, and reporting it as a change would make the room hear about it twice.
 *
 * Refuses a loop rather than silently dropping the old link, which is the one place this parts
 * company with "one master at a time": a request that cannot be honoured must not also cost the
 * relationship the character already had.
 */
export function startFollowing(state: Following, follower: EntityId, leader: EntityId): boolean {
  if (follower === leader) return false;
  if (state.leaderOf.get(follower) === leader) return false;
  if (wouldLoop(state, follower, leader)) return false;

  stopFollowing(state, follower);
  state.leaderOf.set(follower, leader);
  const followers = state.followersOf.get(leader) ?? new Set<EntityId>();
  followers.add(follower);
  state.followersOf.set(leader, followers);
  return true;
}

/** Stops following whoever it was. Returns who that was, so the caller can say so. */
export function stopFollowing(state: Following, follower: EntityId): EntityId | undefined {
  const leader = state.leaderOf.get(follower);
  if (leader === undefined) return undefined;
  state.leaderOf.delete(follower);
  const followers = state.followersOf.get(leader);
  followers?.delete(follower);
  // The empty set goes too, so `followersOf` does not grow one entry per character who ever led.
  if (followers && followers.size === 0) state.followersOf.delete(leader);
  return leader;
}

/**
 * Forgets a character entirely — both directions.
 *
 * Called on disconnect and on death, and **entity ids are reissued**, which is the whole reason this
 * is not optional: a leftover link would make the next character handed this id inherit a train, or
 * be dragged along behind somebody they have never met. The same argument `forgetTarget` makes about
 * a mob's memory.
 *
 * Returns everyone who was following them, so they can be told rather than silently stranded.
 */
export function forgetFollower(state: Following, who: EntityId): readonly EntityId[] {
  stopFollowing(state, who);
  const orphans = [...(state.followersOf.get(who) ?? [])];
  for (const follower of orphans) state.leaderOf.delete(follower);
  state.followersOf.delete(who);
  return orphans;
}
