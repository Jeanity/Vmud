/**
 * Aggression: who a mob objects to, and how long it takes to work it out.
 *
 * ## Aggression is a predicate, not a boolean
 *
 * The instinct is `aggressive: true`, and the source is emphatic that it is wrong. Duris carries **three
 * 32-bit words** of aggression bits — `AGGR_ALL`, `AGGR_EVIL_ALIGN`, `AGGR_DROW_ELF`, `AGGR_OUTCASTS`, and
 * twenty more — and `IS_AGGRESSIVE(m)` is merely "any of them is set". Whether a mob attacks *you* is a
 * question about **you**: your race, your alignment, your standing, and the time of day.
 *
 * That matters beyond fidelity. A boolean gives every zone one flavour of danger; a predicate gives a
 * kobold warren that tolerates its own kind and a drow city that objects to daylight races, out of the same
 * mechanism and no extra code. Measured in the two zones we load: IceCrag uses only `AGGR_ALL` (14 of 66
 * mobs), but Kobold Settlement uses `GOOD_RACE`, `GOOD_ALIGN` and `NEUTRAL_ALIGN` as well — so the shape is
 * justified by the data on disk, not by anticipation.
 *
 * **What is evaluable today is `all`, and only `all`.** Players have no race and no alignment until Phase
 * 21, and there is no day cycle, so every other clause is *carried and refused*: {@link matchesAggro}
 * answers false for a rule it cannot evaluate rather than guessing. A mob that would object to elves
 * therefore objects to nobody yet, which is the honest reading of "we do not know what you are".
 *
 * ## Reaction time is the most valuable number here
 *
 * `REFERENCE-mud-mechanics.md` §4.5 is a warning: a mob that attacks the frame you enter its room removes
 * all skill from movement. Duris schedules the reaction some pulses out and **re-validates when it fires**,
 * and that one delay produces speed-running, sneaking past dangerous rooms, and the tension of deciding
 * whether to risk a corridor. §4.5 names the real risk as it being dropped as an optimisation during
 * implementation — so it is the first thing in this module and the thing its tests are mostly about.
 */

/* -------------------------------------------------------------------------- */
/* Dispositions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * How a mob treats company, from `DESIGN-mobs-and-movement.md` §2.3.
 *
 * - `passive` — never initiates. Most of a castle: servants, guests, cooks.
 * - `aggressive` — objects to anyone its predicate matches, once the reaction has elapsed.
 * - `territorial` — *"get off my lawn."* Tolerates you for a grace period, then grows less patient.
 *
 * `territorial` is the design's own invention rather than a Duris flag, and §2.3 is specific that it must
 * **not** be a timer that flips to `aggressive`: the per-round roll is what makes lingering feel risky
 * rather than merely timed. Nothing produces one yet — no `.mob` bit maps to it — so it is a value the type
 * admits and the harvest never returns. It is here because the type is the design and leaving it out would
 * quietly settle a question §2.3 already answered.
 */
export const DISPOSITIONS = ['passive', 'aggressive', 'territorial'] as const;

export type Disposition = (typeof DISPOSITIONS)[number];

/**
 * The clauses of an aggression predicate — Duris' `AGGR_*` bits, named.
 *
 * Only the ones the loaded zones actually use are here. The source has twenty-five; carrying the other
 * seventeen would be a table nothing reads, and the harvest is offline and free to re-run.
 *
 * - `all` — anyone at all. The only clause evaluable today.
 * - `goodAlign`, `neutralAlign`, `evilAlign` — by the intruder's alignment. No alignment exists yet.
 * - `goodRace`, `evilRace` — by race bloc. No races yet.
 */
export const AGGRO_CLAUSES = ['all', 'goodAlign', 'neutralAlign', 'evilAlign', 'goodRace', 'evilRace'] as const;

export type AggroClause = (typeof AGGRO_CLAUSES)[number];

/** What a mob knows about how to feel about people. Harvested; see `worldgen/src/mobs.ts`. */
export interface AggroRule {
  readonly disposition: Disposition;
  /**
   * Clauses, held as **union** — matching any one is enough, which is what `IS_SET` on a bitfield means.
   * Empty for a passive mob.
   */
  readonly clauses: readonly AggroClause[];
  /** How long this one takes to notice an intruder. See {@link reactionFor}. */
  readonly reactionMs: number;
  /** Duris' `ACT_MEMORY` — whether it keeps track of who it has seen. 61 of IceCrag's 66 do. */
  readonly remembers: boolean;
  /** Duris' `ACT_SENTINEL` — never leaves its room. Carried for Phase 10's pursuit; unread today. */
  readonly sentinel: boolean;
  /**
   * Duris' `ACT_PROTECTOR` — joins a fight already happening beside it.
   *
   * Here rather than on `PursuitRule` because it is a fact about *who this objects to*: an assister
   * extends its hostility to whoever is hitting its neighbour. §2.3's `assistsOthers`.
   *
   * **Room-scoped**, which is the source's own limit rather than ours: `find_protector_target` scans the
   * people in the room and nothing further. The cross-room half — a cry for help that pulls a mob in from
   * next door — is `ACT2_COMBAT_NEARBY`, and the simple `.mob` record has no second action word, so it
   * cannot be harvested from the zones we load. See `assistRange` in §2.5 for the design that waits on it.
   */
  readonly assists: boolean;
}

/**
 * What a target *is*, as far as aggression is concerned.
 *
 * Every field is optional and today every one of them is absent, which is the point: the predicate has to
 * be able to say **"I cannot tell"** and be refused, rather than defaulting a missing alignment to neutral
 * and having a mob attack over a fact nobody has asserted.
 */
export interface AggroSubject {
  readonly alignment?: number;
  readonly raceBloc?: 'good' | 'evil' | 'neutral';
}

/** Duris' own thresholds for reading an alignment number as a word (`IS_GOOD` and friends). */
export const ALIGN_GOOD_AT_OR_ABOVE = 350;
export const ALIGN_EVIL_AT_OR_BELOW = -350;

/**
 * Whether this mob objects to this subject.
 *
 * **Unknown means no.** A clause about something the game does not model yet is refused, so a mob whose only
 * clause is `evilRace` is inert until races exist. The alternative — assuming a default — would have mobs
 * attacking over a property nobody has set, and the bug would look like a mob being aggressive at random.
 *
 * `passive` short-circuits: it never initiates whatever its clauses say, which is also how the source reads
 * — the disposition is the outer question and the bits are the inner one.
 */
export function matchesAggro(rule: AggroRule, subject: AggroSubject): boolean {
  if (rule.disposition === 'passive') return false;

  for (const clause of rule.clauses) {
    switch (clause) {
      case 'all':
        return true;
      case 'goodAlign':
        if (subject.alignment !== undefined && subject.alignment >= ALIGN_GOOD_AT_OR_ABOVE) return true;
        break;
      case 'neutralAlign':
        if (
          subject.alignment !== undefined &&
          subject.alignment > ALIGN_EVIL_AT_OR_BELOW &&
          subject.alignment < ALIGN_GOOD_AT_OR_ABOVE
        ) {
          return true;
        }
        break;
      case 'evilAlign':
        if (subject.alignment !== undefined && subject.alignment <= ALIGN_EVIL_AT_OR_BELOW) return true;
        break;
      case 'goodRace':
        if (subject.raceBloc === 'good') return true;
        break;
      case 'evilRace':
        if (subject.raceBloc === 'evil') return true;
        break;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Reaction time                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How long an unhurried mob takes to notice, and how much of that a level buys back.
 *
 * **Duris derives the delay from the mob's own agility, and we cannot.** Agility lives on the *enhanced*
 * `.mob` record, and every mob in the zones we load is the *simple* form — all 66 of IceCrag's — so the
 * number is not on disk to harvest. Level is what we have, and it is a reasonable stand-in: a captain of
 * the guard should be quicker off the mark than a scullion.
 *
 * The band is chosen against what it buys the player rather than for feel. A room crosses in about 2.4 s at
 * `PLAYER_SPEED`, so a floor of 800 ms means even the sharpest mob in the world can be run past, and a
 * ceiling of 2.5 s means the dullest gives you a comfortable walk through. That is §2.2's *"speed-running,
 * sneaking past dangerous rooms, and the tension of deciding whether to risk it"* — from one number, and it
 * only works if the number stays large enough to act inside.
 */
export const REACTION_BASE_MS = 2_500;
export const REACTION_PER_LEVEL_MS = 20;
export const REACTION_FLOOR_MS = 800;

export function reactionFor(level: number): number {
  const scaled = REACTION_BASE_MS - Math.max(0, level) * REACTION_PER_LEVEL_MS;
  return Math.max(REACTION_FLOOR_MS, Math.min(REACTION_BASE_MS, scaled));
}

/**
 * How far a mob's attention reaches inside its room, in tiles.
 *
 * A room is 9 tiles square, so 6 covers most of one without covering all of it — you can stand in the far
 * corner of a big room and go unremarked, which is what makes a doorway worth pausing in.
 *
 * **Not light-gated, and that is deliberate rather than unfinished.** `ac_can_see` in the source is
 * explicitly asymmetric, and the asymmetry falls this way round: a guard standing in a hall it has lived in
 * for years is not blind in it, while the intruder is the one holding a torch. So the mob's reach is a
 * distance and the *player's* sight is a light — and the practical consequence is right too, since creeping
 * past in the dark is what stealth is for (Phase 19) rather than something a lantern's absence should buy.
 */
export const AGGRO_RANGE_TILES = 6;

/** A passive rule, for a mob with no aggression bits at all. Most of a castle. */
export function passiveRule(level: number): AggroRule {
  return {
    disposition: 'passive',
    clauses: [],
    reactionMs: reactionFor(level),
    remembers: false,
    sentinel: false,
    assists: false,
  };
}
