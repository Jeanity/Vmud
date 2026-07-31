/**
 * Combat statistics: what a body hits with, what it takes to hit it, and how often it swings.
 *
 * `rules.ts` has had `resolveAttack`, `rollDamage` and `proficiencyBonus` since the beginning, tested and
 * never called — `ROADMAP.md` rule 1 names them as the failure mode it exists to prevent. This module is
 * the layer that finally gives them arguments, and every number in it is either read from the Duris `.mob`
 * files or derived the way the source derives it.
 *
 * ## Three conversions, and the first one is a trap
 *
 * **The `.mob` hitroll column is vestigial — do not read it.** `db.c` `fscanf`s the field and then
 * immediately overwrites it: `base_hitroll = BOUNDED(2, level >> 1, 25)` for warriors, greater races,
 * elites and giants, and `BOUNDED(0, level / 3, 25)` for everything else. So the number sitting in the
 * file is whatever a builder typed and has been ignored since 1995. Measured on IceCrag it is frequently
 * *negative* (−10 on a level 60), which read literally would make the castle's best fighters the worst.
 * {@link attackBonusFor} derives it instead.
 *
 * **Armour is real, and it runs the other way.** Duris keeps AD&D-style descending armour class — lower is
 * better, `BOUNDED(-250, tmp, 250)` — while `resolveAttack` is SRD 5e and ascending, hitting on
 * `total >= targetAc`. So the file's number has to be flipped and scaled, which {@link armourToAc} does.
 *
 * **Damage dice are real and per-mob**, straight out of the fifth stats column: `2d5+2` on a castle
 * servant, `7d6+35` on Malice. That is the one combat number the source hands over unchanged.
 *
 * ## Round length is per actor, and that is §4.1's warning
 *
 * `ROUND_MS` is a bare export and *"the first combat implementation will read it"*. It must not: a single
 * global round collapses every speed stat into "extra attacks", so a fast dagger and a slow ogre become
 * the same actor with a multiplier. Duris gives each character its own float `base_combat_round` and
 * counts it down per pulse. {@link roundLengthFor} is that field's origin, and `Actor.roundMs` is where it
 * lives — so haste can shorten one actor's round without touching anybody else's.
 */

import { ROUND_MS, parseDice, type Dice } from './rules.ts';

/* -------------------------------------------------------------------------- */
/* What a body hits with                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The weapon a character swings while there is nothing to hold.
 *
 * **A stand-in with a removal trigger, exactly like `LOCKS_HOLD`.** Items are Phase 15; until one can be
 * carried, a player has no weapon and the SRD's honest answer — an unarmed strike for `1 + STR`, and there
 * are no ability scores either — is one point of damage a swing. Against a castle whose weakest inhabitant
 * has 148 hit points that is not a fight, it is arithmetic, and the phase's *"a health bar drops"* would be
 * invisible.
 *
 * So this is a practice weapon baked into the engine: named, explained, and deleted the day equipment
 * arrives. It is deliberately unremarkable — a d6, the SRD's shortsword — so that nobody mistakes it for a
 * balance decision, and so the day a real weapon lands the difference is obvious.
 */
export const DEFAULT_WEAPON: Dice = { count: 1, sides: 6, bonus: 0 };

/** What a player's swing does, until Phase 15. See {@link DEFAULT_WEAPON}. */
export function playerDamage(): Dice {
  return DEFAULT_WEAPON;
}

/* -------------------------------------------------------------------------- */
/* Hitting, and being hard to hit                                              */
/* -------------------------------------------------------------------------- */

/** Duris' own bound on a derived hitroll. */
export const HITROLL_MAX = 25;

/**
 * A mob's attack bonus, derived from level as `db.c` derives it.
 *
 * The `martial` branch is the source's `IS_WARRIOR || IS_GREATER_RACE || IS_ELITE || IS_GIANT`. None of
 * those four are harvested — class and the elite bit live in fields we do not read, and race is reduced to
 * an art key — so **everything currently takes the lesser branch**. That is a known understatement rather
 * than an oversight: it makes the castle slightly easier than Duris intends, in a direction that is safe
 * while players are level 1, and it becomes a one-line change when class is harvested.
 */
export function attackBonusFor(level: number, martial = false): number {
  const raw = martial ? Math.floor(level / 2) : Math.floor(level / 3);
  const floor = martial ? 2 : 0;
  return Math.max(floor, Math.min(HITROLL_MAX, raw));
}

/** Ascending SRD armour class for an unarmoured body — the SRD's own 10. */
export const BASE_AC = 10;

/**
 * Duris' descending armour turned into an ascending SRD armour class.
 *
 * The two systems disagree about direction and about scale. Duris runs −250 (superb) to 250 (helpless) and
 * treats it as a percentage-ish quantity; SRD runs about 10 (unarmoured) to 22 (plate and shield) and
 * compares it directly against `d20 + bonus`. Dividing by ten and flipping the sign lands the observed
 * IceCrag range where it should be: measured on the zone's own numbers, armour 74 → AC 3 (a servant in
 * cloth, easy to hit), 51 → AC 5, −69 → AC 17, −122 → AC 22 (Malice, in the SRD's plate-and-shield band).
 *
 * Clamped at the bottom so a builder's absurd number cannot produce an AC a natural 1 would beat — the SRD
 * already makes a 1 an automatic miss, and an AC below that is meaningless rather than merely generous.
 */
export const AC_PER_ARMOUR_POINT = 10;
export const MIN_AC = 1;
export const MAX_AC = 40;

export function armourToAc(armour: number): number {
  const scaled = BASE_AC - armour / AC_PER_ARMOUR_POINT;
  return Math.max(MIN_AC, Math.min(MAX_AC, Math.round(scaled)));
}

/* -------------------------------------------------------------------------- */
/* How often it swings                                                         */
/* -------------------------------------------------------------------------- */

/**
 * How long one actor's combat round lasts, in milliseconds.
 *
 * Everything is on the base round today and the *function* is the point: §4.1's warning is that the first
 * attack written will read the global `ROUND_MS` constant, and once every fight shares one clock, haste,
 * weapon speed and dexterity have nowhere to land but "extra attacks per round". Routing the number
 * through here — and storing the result per actor — means adding a speed modifier later changes this
 * function and nothing else.
 */
export function roundLengthFor(_level: number): number {
  return ROUND_MS;
}

/** The shortest round anything may have, so a bug cannot produce an actor swinging every tick. */
export const MIN_ROUND_MS = 500;

/* -------------------------------------------------------------------------- */
/* A mob's fighting statistics, as harvested                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a mob fights with. Harvested from the `.mob` stats line — see the module note for which columns
 * are trustworthy and which one is a lie.
 */
export interface CombatStats {
  /** SRD ascending armour class. Converted on harvest, so the server never sees Duris' scale. */
  readonly armourClass: number;
  /** Damage dice, straight from the file. */
  readonly damage: Dice;
  /** `d20 + this` against the target's armour class. */
  readonly attackBonus: number;
  /** This actor's own round, in milliseconds. */
  readonly roundMs: number;
}

/** Reads the two trustworthy stats columns and derives the rest. */
export function readCombatStats(options: {
  readonly level: number;
  readonly armour: number;
  readonly damage: string;
  readonly martial?: boolean;
}): CombatStats {
  return {
    armourClass: armourToAc(options.armour),
    // A record whose damage column the harvest could not parse would otherwise be a mob that swings for
    // NaN, which reads as a health bar that never moves. One point is a hit; zero is a ghost.
    damage: parseDice(options.damage) ?? { count: 1, sides: 1, bonus: 0 },
    attackBonus: attackBonusFor(options.level, options.martial ?? false),
    roundMs: roundLengthFor(options.level),
  };
}

/** A player's fighting statistics, until classes and equipment exist. */
export function playerCombatStats(level: number): CombatStats {
  return {
    armourClass: BASE_AC,
    damage: playerDamage(),
    attackBonus: attackBonusFor(level, true),
    roundMs: roundLengthFor(level),
  };
}
