/**
 * Pursuit: whether a mob follows you out of the room, how far, and what stops it.
 *
 * ## Hunting is a room-graph walk, and the source is unusually specific about it
 *
 * `mobact.c`'s `event_mob_hunt` re-runs a breadth-first search over the room graph every pulse and takes
 * **one room per step**, which is the shape this module keeps. It is not a tile-space chase: the mob does
 * not home in on a position, it works out which exit leads toward you and takes that exit. The distinction
 * is what makes doors, dead ends and doubling back mean something.
 *
 * ## Four flags, and three of them are traps
 *
 * `REFERENCE-mud-mechanics.md` §4.11 is about exactly this branch, and every warning in it is load-bearing:
 *
 * - **`ACT_HUNTER` does nothing without `ACT_MEMORY`.** The whole hunt lives inside
 *   `if (IS_SET(act, ACT_MEMORY))`, so a mob flagged HUNTER alone just wanders. Measured on IceCrag: 34 of
 *   66 carry HUNTER and 56 carry MEMORY, and it is the *intersection* that hunts.
 * - **`ACT_SENTINEL` does not mean immobile.** The source's own line is
 *   `if ((SENTINEL || STAY_ZONE) && zone(cur) != zone(targ)) return;` — an **or**, and a *zone* leash rather
 *   than a refusal to move. A sentinel hunts you happily; it just will not leave home to do it.
 * - **`ACT2_NO_LURE`** opts a mob out of hunting entirely, whatever else it carries.
 *
 * ## What the numbers are, and which of them we had to invent
 *
 * `PULSE_MOB_HUNT` is 6 pulses. A pulse is 0.25 s — `PULSE_MOBILE` is 30 and §4.11 records that its "10
 * seconds" comment is really 7.5 — so a hunter takes **one room every 1.5 s**. That is worth stating
 * plainly because it is the whole feel of being chased: a player crosses a 9-tile room in about 2.4 s at
 * `PLAYER_SPEED`, so **a hunter gains on you**. You cannot stroll away from one. Doors, distance and the
 * edge of a Place are the counterplay, which is what §2.10 wants pursuit to be about.
 *
 * `trackRooms` and `giveUpMs` are **ours**. Duris caps the search at `BFS_MAX_ROOMS` (12,000 — a runaway
 * guard, not a leash) and never gives up on time at all: a HUNTER hunts until it finds you or the path
 * search fails. An unbounded hunt is right for a world of 781,053 rooms and wrong for one where a zone is
 * 219, so the tiers below bound it, and they are documented as a tuning decision rather than a reading of
 * the source.
 */

import type { RoomFlag } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Tiers                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How determined a pursuer is, from `DESIGN-mobs-and-movement.md` §2.10.
 *
 * - `sentinel` — never follows you out of the room.
 * - `local` — follows a short way and gives up. **Nothing produces one**: no `.mob` bit means "follows a
 *   little", and inventing one would be a creature the source does not describe. It is here because §2.10
 *   names it and because the tier the harvest cannot reach is exactly the tier a hand-authored encounter
 *   will want first. Same shape as `territorial` in `aggression.ts`.
 * - `zone` — hunts, but will not leave its own zone. `ACT_SENTINEL` **or** `ACT_STAY_ZONE`.
 * - `relentless` — hunts as far as the world allows.
 */
export const PURSUIT_TIERS = ['sentinel', 'local', 'zone', 'relentless'] as const;

export type PursuitTier = (typeof PURSUIT_TIERS)[number];

/**
 * Everything about how one template gives chase.
 *
 * Per-template rather than global, because §2.10 is explicit that escape conditions *are* the encounter
 * design: a dire wolf you outrun and a dragon you must outwit differ only in these numbers.
 */
export interface PursuitRule {
  readonly tier: PursuitTier;
  /**
   * How many rooms of room-graph distance it will search across. Also the BFS depth cap, so it doubles as
   * the cost bound — see {@link TRACK_ROOMS}.
   */
  readonly trackRooms: number;
  /** How long it keeps hunting once it can no longer see you. `null` never gives up on time. */
  readonly giveUpMs: number | null;
  /** Whether a `safe` room turns it back at the threshold. */
  readonly respectsSafeRooms: boolean;
  /** `ACT_SENTINEL || ACT_STAY_ZONE` — will not cross out of its own zone while hunting. */
  readonly staysInZone: boolean;
  /**
   * Whether it can open a shut door in its way.
   *
   * The source's rule is a lovely piece of texture: a hunter blocked by a closed door opens it, *unless*
   * `!CAN_SPEAK(ch) && !IS_GREATER_RACE(ch)` — **"animals don't open doors"**. So a wolf is stopped by a
   * door a guard walks through, and after Phase 9 there are shut doors everywhere for that to matter in.
   */
  readonly opensDoors: boolean;
}

/* -------------------------------------------------------------------------- */
/* The numbers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How long a hunter takes to cross one room: `PULSE_MOB_HUNT` (6) × 0.25 s.
 *
 * Read as a *speed* rather than a delay — the mob moves continuously and this is how long a room takes it,
 * which works out faster than a player walks. See the module note.
 */
export const HUNT_STEP_MS = 1_500;

/** Rooms of chase per tier. Ours, not the source's; see the module note. */
export const TRACK_ROOMS: Readonly<Record<PursuitTier, number>> = {
  sentinel: 0,
  local: 3,
  zone: 40,
  // Not `Infinity`: this is a BFS depth cap that has to survive JSON, and 219 rooms is IceCrag entire.
  relentless: 500,
};

/** How long each tier keeps hunting after losing you. `null` is "never on time alone". */
export const GIVE_UP_MS: Readonly<Record<PursuitTier, number | null>> = {
  sentinel: 0,
  local: 30_000,
  zone: 120_000,
  relentless: null,
};

/* -------------------------------------------------------------------------- */
/* Reading the flags                                                           */
/* -------------------------------------------------------------------------- */

/** A rule for something that never follows you anywhere. */
export function noPursuit(): PursuitRule {
  return {
    tier: 'sentinel',
    trackRooms: 0,
    giveUpMs: 0,
    respectsSafeRooms: true,
    staysInZone: true,
    opensDoors: false,
  };
}

/**
 * Builds a pursuit rule from the `ACT_*` bits, as `mobact.c` reads them.
 *
 * The `remembers` argument is not decoration — it is §4.11's dependency, and dropping it is the mistake the
 * gotcha exists to prevent. A HUNTER without MEMORY is inert in the source and inert here.
 */
export function huntRule(options: {
  readonly hunter: boolean;
  readonly remembers: boolean;
  readonly sentinel: boolean;
  readonly staysInZone: boolean;
  readonly noLure: boolean;
  readonly opensDoors: boolean;
}): PursuitRule {
  const leashed = options.sentinel || options.staysInZone;
  if (options.noLure || !options.hunter || !options.remembers) {
    // Still records the leash, so a future wanderer (§2.3's patrols) reads the same field.
    return { ...noPursuit(), staysInZone: leashed, opensDoors: options.opensDoors };
  }
  const tier: PursuitTier = leashed ? 'zone' : 'relentless';
  return {
    tier,
    trackRooms: TRACK_ROOMS[tier],
    giveUpMs: GIVE_UP_MS[tier],
    // Nothing in the source makes a hunter ignore sanctuary — that is §2.10's dragon, which is authored
    // rather than harvested. Everything the harvest produces respects it.
    respectsSafeRooms: true,
    staysInZone: leashed,
    opensDoors: options.opensDoors,
  };
}

/** Whether this rule ever leaves the room at all. */
export function pursues(rule: PursuitRule): boolean {
  return rule.tier !== 'sentinel' && rule.trackRooms > 0;
}

/* -------------------------------------------------------------------------- */
/* Room flags the hunt reads                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Room flags that turn a hunter back at the threshold.
 *
 * `no_mob` is the source's own `BFS_AVOID_NOMOB`, set on the hunt every time it is scheduled — so a
 * hunter routes *around* rooms mobs may not enter rather than piling up against them. `safe` is §2.10's
 * sanctuary. Both are harvested from the Duris `.wld` bitfield and present in the shipped world (14 and 1
 * room respectively), so this reads real data rather than anticipating it.
 */
export function huntBlockedBy(flags: readonly RoomFlag[] | undefined, rule: PursuitRule): boolean {
  if (!flags) return false;
  if (flags.includes('no_mob')) return true;
  return rule.respectsSafeRooms && flags.includes('safe');
}
