/**
 * Rules maths — SRD 5e derived, with MUD-style timing.
 *
 * Every function here is pure and deterministic. Randomness is always supplied by a caller-owned
 * seeded {@link Rng}: an authoritative server must be able to replay a fight and get the same
 * result, which `Math.random()` makes impossible.
 */

/* -------------------------------------------------------------------------- */
/* Timing                                                                      */
/* -------------------------------------------------------------------------- */

/** Simulation tick. Movement, regeneration and timers advance on this clock. */
export const TICK_MS = 100;

/** Combat round. Auto-attacks and ability resolution land on this clock. */
export const ROUND_MS = 3000;

export const TICKS_PER_ROUND = ROUND_MS / TICK_MS;

/* -------------------------------------------------------------------------- */
/* Deterministic randomness                                                    */
/* -------------------------------------------------------------------------- */

/** Returns a float in `[0, 1)`. */
export type Rng = () => number;

/**
 * mulberry32 — small, fast, and good enough for game dice. Chosen over `Math.random()` because it
 * is seedable, so any combat can be replayed exactly from its seed.
 */
export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform integer in `[min, max]`, inclusive at both ends. */
export function randomInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(rng() * items.length)];
}

/* -------------------------------------------------------------------------- */
/* Dice                                                                        */
/* -------------------------------------------------------------------------- */

export interface Dice {
  readonly count: number;
  readonly sides: number;
  readonly bonus: number;
}

const DICE_PATTERN = /^\s*(\d+)\s*d\s*(\d+)\s*(?:([+-])\s*(\d+))?\s*$/i;

/** Parses `"2d6"`, `"1d8+3"`, `"3d4 - 1"`. Returns `undefined` if the input is not dice notation. */
export function parseDice(notation: string): Dice | undefined {
  const match = DICE_PATTERN.exec(notation);
  if (!match) return undefined;
  const [, countRaw, sidesRaw, sign, bonusRaw] = match;
  const count = Number(countRaw);
  const sides = Number(sidesRaw);
  if (count <= 0 || sides <= 0) return undefined;
  const magnitude = bonusRaw === undefined ? 0 : Number(bonusRaw);
  return { count, sides, bonus: sign === '-' ? -magnitude : magnitude };
}

/**
 * Dice back into notation — **`parseDice`'s exact inverse**, and it has to be exact.
 *
 * A9 gave the panel a mob's damage as a field somebody types into, which means the string this produces is
 * fed straight back through `parseDice` on the next save. Anything it drops is a number that disappears
 * the moment an operator opens the editor and presses Save without touching that box — which is how
 * `"2d6+8"` would quietly become `"2d6"` and a mob would lose eight points of damage per swing to a
 * round trip nobody made a decision in.
 *
 * A zero bonus is omitted rather than written as `+0`, because that is what the notation looks like
 * everywhere else in the world files and re-parsing it gives the same record back either way.
 */
export function writeDice(dice: Dice): string {
  const base = `${dice.count}d${dice.sides}`;
  if (dice.bonus === 0) return base;
  return `${base}${dice.bonus > 0 ? '+' : '-'}${Math.abs(dice.bonus)}`;
}

export function rollDice(rng: Rng, dice: Dice): number {
  let total = dice.bonus;
  for (let i = 0; i < dice.count; i++) total += randomInt(rng, 1, dice.sides);
  return total;
}

/** Lowest and highest results a dice expression can produce. */
export function diceRange(dice: Dice): { min: number; max: number } {
  return { min: dice.count + dice.bonus, max: dice.count * dice.sides + dice.bonus };
}

export function averageDice(dice: Dice): number {
  return dice.count * ((dice.sides + 1) / 2) + dice.bonus;
}

/* -------------------------------------------------------------------------- */
/* Abilities                                                                   */
/* -------------------------------------------------------------------------- */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;

export type Ability = (typeof ABILITIES)[number];

export type AbilityScores = Readonly<Record<Ability, number>>;

/** SRD: modifier is `floor((score - 10) / 2)`. */
export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** SRD: +2 at level 1, rising by 1 every four levels. */
export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

/* -------------------------------------------------------------------------- */
/* Attack resolution                                                           */
/* -------------------------------------------------------------------------- */

export type Advantage = 'none' | 'advantage' | 'disadvantage';

export interface AttackInput {
  readonly attackBonus: number;
  readonly targetAc: number;
  readonly advantage?: Advantage;
  /** Natural roll at or above this crits. 20 by default; some features lower it. */
  readonly critThreshold?: number;
}

export interface AttackResult {
  readonly natural: number;
  readonly total: number;
  readonly hit: boolean;
  readonly critical: boolean;
  /** A natural 1 always misses, regardless of bonuses. */
  readonly fumble: boolean;
}

function rollD20(rng: Rng, advantage: Advantage): number {
  const first = randomInt(rng, 1, 20);
  if (advantage === 'none') return first;
  const second = randomInt(rng, 1, 20);
  return advantage === 'advantage' ? Math.max(first, second) : Math.min(first, second);
}

export function resolveAttack(rng: Rng, input: AttackInput): AttackResult {
  const critThreshold = input.critThreshold ?? 20;
  const natural = rollD20(rng, input.advantage ?? 'none');
  const total = natural + input.attackBonus;
  const critical = natural >= critThreshold;
  const fumble = natural === 1;
  return {
    natural,
    total,
    // SRD: a natural 20 always hits and a natural 1 always misses.
    hit: critical || (!fumble && total >= input.targetAc),
    critical,
    fumble,
  };
}

/**
 * A critical doubles the **whole roll** — Duris' own arithmetic, not the SRD's.
 *
 * This used to be the SRD shape (dice rolled twice, flat bonuses untouched), and the owner caught
 * what that does in our economy (2026-08-07): *"I am seeing crits that are only a few more damage
 * than normal attacks."* He was right, and the source settles it — `fight.c:7497`, on an ordinary
 * critical: `dam = (int)(dam * 2.0)`, the accumulated damage **as a whole**, with only small
 * level-riders added after. In Duris the weapon dice *are* most of a blow, so doubling dice and
 * doubling everything were nearly the same number; in our fold the flat bonus dominates a
 * high-level swing (a 2d6+2 blade folded to 144), and doubling dice alone moved a crit by a
 * seven-ish. Doubling the roll is what the source's own economy meant by the word.
 *
 * Dropped and named: `SKILL_DEVASTATING_CRITICAL`'s ×(300+skill)/150 rider and the monk's ×1.5
 * live with their skills, none of which exist yet.
 */
export function rollDamage(rng: Rng, dice: Dice, critical: boolean): number {
  const rolled = Math.max(0, rollDice(rng, dice));
  return critical ? rolled * 2 : rolled;
}

/* -------------------------------------------------------------------------- */
/* Derived character statistics                                                */
/* -------------------------------------------------------------------------- */

/** Rounds per minute of combat — used when converting MUD-era rates to our clock. */
export function roundsPerMinute(): number {
  return 60_000 / ROUND_MS;
}

/*
 * `maxHitPoints` and `experienceToLevel` lived here and were deleted by Phase 14b. Both were the SRD's
 * *magnitudes* — a d8-plus-Constitution maximum, and a smooth quadratic experience curve — and
 * `DESIGN-progression.md` §1 settled that the SRD sets the shape of the rules while **Duris sets their
 * magnitudes**. Their replacements are `progression.ts`: hit points rolled per level on Duris' own d4
 * and stored, and Duris' step table read out of `duris.properties`.
 *
 * Named here rather than silently removed because the SRD versions are the obvious thing to reach for
 * again. `maxHitPoints(8, 1, 1)` returned 9, against a world whose gentlest creature has 23 — that gap
 * is the whole reason the phase existed, and reintroducing either function would reopen it.
 */
