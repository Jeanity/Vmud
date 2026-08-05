/**
 * Who is adventuring with whom — **Phase 18's second half.**
 *
 * `following.ts` answers *"who is walking behind me"*; this answers *"who is this kill for"*. Duris
 * keeps them separate and so do we, because they are separate facts: you can follow somebody you are
 * not grouped with (a stranger heading the same way) and be grouped with somebody you are not
 * following (the tank, who is going nowhere). The one place they meet is `group all`, which enrols
 * **your followers** — the source's own bridge between the two halves, and the reason following was
 * built first.
 *
 * ## Duris' rules, transcribed from `group.c`
 *
 * - **Consent is required, and it is the *member* who gives it.** `group_add_member` refuses a PC
 *   enrolling a PC without `LNK_CONSENT` — *"But ye haven't their permission to do that!"* — so
 *   grouping is a two-step handshake in which the leader acts second. The asymmetry with following is
 *   deliberate and it is the right way round: walking behind somebody costs them nothing, while being
 *   in their group divides their experience.
 * - **Only the leader enrols and only the leader kicks.** *"You can not enroll group members without
 *   being head of a group."* A member who wants out leaves themselves — `group me`.
 * - **`group <a member>` kicks them.** One verb, and which act it performs depends on whether they are
 *   already in. Transcribed rather than split into `group`/`ungroup`, because a Diku player's fingers
 *   already do it this way.
 * - **Thirteen at most** (`groups.size.max.good` / `.evil`, both defaulting to 13).
 * - **The leader leaving promotes the second in the list**, which is why members are ordered rather
 *   than a set: *"You are now the leader of your group!"* goes to whoever joined first.
 * - **A group of one is not a group.** The source disbands it silently the moment the second-to-last
 *   member goes, and says so to whoever is left.
 * - **Grouping another group's leader merges both groups.** Their members come across with them —
 *   *"Your group has merged into $n's group"* — rather than the leader being quietly stolen off the
 *   front of a party that then has nobody to lead it.
 *
 * ## What is deliberately *not* here
 *
 * The experience rule. It is arithmetic over a member list and it lives in `@mygame/shared`'s
 * `experience.ts` beside the split it modifies, where it is testable without a simulation — see
 * `groupedShare`. This file knows who is in a group and nothing about what that is worth.
 *
 * Ranks (`group front` / `group back`) are Duris' front-and-back-line positioning, and every branch of
 * theirs in `do_group` begins with an unconditional `return` — the mechanism is switched off in the
 * source we are reading. Not transcribed: there is nothing to transcribe.
 */

import type { EntityId } from '@mygame/shared';

/**
 * The most members a group may hold.
 *
 * `get_property("groups.size.max.good", 13)`, and its evil twin. A property in Duris because it is
 * tuned per side of a racewar we do not have yet (Phase 21); a constant here until we do, rather than
 * a settings file nobody would ever edit.
 */
export const MAX_GROUP_MEMBERS = 13;

/** A group's identity, independent of who leads it — see {@link Grouping.members}. */
export type GroupId = number;

/**
 * Groups, and who has given whom permission to be enrolled.
 *
 * A separate store rather than fields on `Player`, the shape `following.ts`, `hunt.ts` and `threat.ts`
 * all take: this is a fact *between* characters, and hanging half of it on each of several actors is
 * how the halves drift apart.
 *
 * **Groups are keyed by an id rather than by their leader**, which Duris gets for free by having every
 * member point at the same linked list. The leader is the *head of the member list* and changes when
 * they leave; keying on them would mean rewriting every member's key at the moment the group is
 * already in the middle of losing somebody.
 */
export interface Grouping {
  /** Members in join order, head first. The head is the leader. */
  readonly members: Map<GroupId, EntityId[]>;
  /** Which group each character is in. */
  readonly groupOf: Map<EntityId, GroupId>;
  /**
   * Who each character has given consent to, as `granter -> those they will follow into a group`.
   *
   * Indexed by granter because that is who revokes it — bare `consent` clears the whole set, which is
   * `clear_links(ch, LNK_CONSENT)`.
   */
  readonly consent: Map<EntityId, Set<EntityId>>;
  /** Next group id. Never reused, so a stale id cannot name a group that has been rebuilt. */
  next: GroupId;
}

export function newGrouping(): Grouping {
  return { members: new Map(), groupOf: new Map(), consent: new Map(), next: 1 };
}

/* -------------------------------------------------------------------------- */
/* Consent                                                                     */
/* -------------------------------------------------------------------------- */

/** `consent <name>`. Returns whether this said anything new. */
export function grantConsent(state: Grouping, granter: EntityId, to: EntityId): boolean {
  if (granter === to) return false;
  const set = state.consent.get(granter) ?? new Set<EntityId>();
  if (set.has(to)) return false;
  set.add(to);
  state.consent.set(granter, set);
  return true;
}

/** Bare `consent` — *"You no longer feel generous and revoke your consent."* */
export function revokeConsent(state: Grouping, granter: EntityId): void {
  state.consent.delete(granter);
}

/** Who this character has consented to, in the order they were given it. */
export function consentedTo(state: Grouping, granter: EntityId): readonly EntityId[] {
  return [...(state.consent.get(granter) ?? [])];
}

/**
 * Whether `member` has given `leader` permission to enrol them.
 *
 * The direction is worth reading twice, because it is the opposite of the way the sentence usually
 * runs: it is the *joiner* who consents, and the leader who needs it.
 */
export function hasConsent(state: Grouping, member: EntityId, leader: EntityId): boolean {
  return state.consent.get(member)?.has(leader) ?? false;
}

/* -------------------------------------------------------------------------- */
/* Reading a group                                                             */
/* -------------------------------------------------------------------------- */

/** The group this character is in, members in join order, leader first. Empty when they are in none. */
export function membersWith(state: Grouping, who: EntityId): readonly EntityId[] {
  const id = state.groupOf.get(who);
  if (id === undefined) return [];
  return [...(state.members.get(id) ?? [])];
}

/** Who leads this character's group, or `undefined` when they are in none. */
export function leaderFor(state: Grouping, who: EntityId): EntityId | undefined {
  return membersWith(state, who)[0];
}

/** Whether this character leads a group. False for somebody in no group at all. */
export function leads(state: Grouping, who: EntityId): boolean {
  return leaderFor(state, who) === who;
}

/** Whether these two are in the same group. False when either is in none. */
export function grouped(state: Grouping, a: EntityId, b: EntityId): boolean {
  const id = state.groupOf.get(a);
  return id !== undefined && id === state.groupOf.get(b);
}

/* -------------------------------------------------------------------------- */
/* Changing one                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Why an enrolment was refused — **four answers rather than a boolean**.
 *
 * The same rule 15c's container refusals follow: a player told *"no"* learns nothing about which no it
 * was, and *"they are in another group"*, *"they have not consented"* and *"your group is full"* are
 * three genuinely different things to do about it.
 */
export type EnrolResult =
  | { readonly ok: true; readonly merged: readonly EntityId[] }
  | { readonly ok: false; readonly why: 'self' | 'already' | 'in-another-group' | 'no-consent' | 'full' | 'not-leader' };

/**
 * Enrols somebody, merging their group into this one if they lead one.
 *
 * The order of the refusals is the source's, and one of them is load-bearing: **consent is checked
 * before size**, so a full group tells you it is full only for somebody who would otherwise have been
 * allowed in. The other way round leaks the fact that a stranger has consented to you.
 *
 * `merged` names everybody who came across with the new member — their group's other members. Empty in
 * the ordinary case, which is the one-person-joining case.
 */
export function enrol(state: Grouping, leader: EntityId, member: EntityId): EnrolResult {
  if (leader === member) return { ok: false, why: 'self' };
  if (grouped(state, leader, member)) return { ok: false, why: 'already' };

  // In a group they do not lead: theirs to leave, not ours to take them out of. *"$N is in another
  // group."*
  const theirGroup = state.groupOf.get(member);
  if (theirGroup !== undefined && !leads(state, member)) {
    return { ok: false, why: 'in-another-group' };
  }
  // Leading a group already? Only its leader may speak for it, and only they can be asked.
  const ourGroup = state.groupOf.get(leader);
  if (ourGroup !== undefined && !leads(state, leader)) return { ok: false, why: 'not-leader' };

  if (!hasConsent(state, member, leader)) return { ok: false, why: 'no-consent' };

  const joining = theirGroup === undefined ? [member] : [...(state.members.get(theirGroup) ?? [])];
  const existing = ourGroup === undefined ? [leader] : [...(state.members.get(ourGroup) ?? [])];
  if (existing.length + joining.length > MAX_GROUP_MEMBERS) return { ok: false, why: 'full' };

  const id = ourGroup ?? newGroup(state, leader);
  const list = state.members.get(id);
  if (!list) return { ok: false, why: 'not-leader' };
  if (theirGroup !== undefined) state.members.delete(theirGroup);
  for (const joiner of joining) {
    list.push(joiner);
    state.groupOf.set(joiner, id);
  }
  return { ok: true, merged: joining.filter((who) => who !== member) };
}

function newGroup(state: Grouping, leader: EntityId): GroupId {
  const id = state.next++;
  state.members.set(id, [leader]);
  state.groupOf.set(leader, id);
  return id;
}

/** What happened to the group when somebody left it. */
export interface DepartureResult {
  /** Everyone still in the group afterwards, leader first. Empty when it dissolved. */
  readonly remaining: readonly EntityId[];
  /** Who inherited the lead, when the leader was the one who left. */
  readonly promoted?: EntityId;
  /** Set when the group dissolved because one person is not a group. Names who was left holding it. */
  readonly dissolved?: EntityId;
}

/**
 * Takes one character out of their group, however they came to be leaving.
 *
 * One function for `group me`, for being kicked, for disconnecting and for `disband`'s loop, because
 * the three consequences — a promotion, a dissolution, or neither — are properties of the *group's*
 * new shape rather than of the reason. `group_remove_member` is one function in the source too.
 *
 * Returns an empty result for somebody who was in no group, so callers need no guard.
 */
export function depart(state: Grouping, who: EntityId): DepartureResult {
  const id = state.groupOf.get(who);
  if (id === undefined) return { remaining: [] };
  const list = state.members.get(id) ?? [];
  const wasLeader = list[0] === who;
  const rest = list.filter((member) => member !== who);
  state.groupOf.delete(who);

  // One person is not a group. The source disbands it silently and tells whoever is left, which is the
  // right way round: they did not do anything, and a party that has quietly become a solo character
  // must not keep dividing their experience as though it had not.
  if (rest.length <= 1) {
    state.members.delete(id);
    const last = rest[0];
    if (last !== undefined) state.groupOf.delete(last);
    return { remaining: [], ...(last !== undefined ? { dissolved: last } : {}) };
  }

  state.members.set(id, rest);
  return { remaining: [...rest], ...(wasLeader ? { promoted: rest[0] } : {}) };
}

/**
 * `disband` — the leader dissolving their own group.
 *
 * Returns everybody who was thrown out, in join order, so each can be told. The leader is not in the
 * list: they are who is doing it.
 *
 * Implemented by departing the members rather than deleting the map entry, so the one-is-not-a-group
 * rule fires from its single home. Deleting directly would leave the leader's own `groupOf` entry
 * pointing at a group that no longer exists — the state a `group` command would then read.
 */
export function disband(state: Grouping, leader: EntityId): readonly EntityId[] {
  if (!leads(state, leader)) return [];
  const thrown = membersWith(state, leader).filter((who) => who !== leader);
  for (const member of thrown) depart(state, member);
  // The last departure dissolves the group and takes the leader's own entry with it; if a single
  // member somehow remained, this is what removes the leader from a group of one.
  depart(state, leader);
  return thrown;
}

/**
 * Forgets a character entirely — group membership, consent given, and consent received.
 *
 * Called on disconnect, and **entity ids are reissued**, which is the whole reason it is not optional:
 * a leftover membership would put the next character handed this id into a stranger's party and start
 * dividing their kills, and a leftover consent would let a stranger enrol them without being asked.
 * The same argument `forgetFollower` and `forgetTarget` make.
 *
 * Returns the departure, so whoever is left can be told what became of the group.
 */
export function forgetGrouping(state: Grouping, who: EntityId): DepartureResult {
  const result = depart(state, who);
  state.consent.delete(who);
  for (const set of state.consent.values()) set.delete(who);
  return result;
}
