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

/** SRD critical hits roll the weapon's damage dice twice; flat bonuses are not doubled. */
export function rollDamage(rng: Rng, dice: Dice, critical: boolean): number {
  if (!critical) return Math.max(0, rollDice(rng, dice));
  const doubled: Dice = { ...dice, count: dice.count * 2 };
  return Math.max(0, rollDice(rng, doubled));
}

/* -------------------------------------------------------------------------- */
/* Derived character statistics                                                */
/* -------------------------------------------------------------------------- */

/** Rounds per minute of combat — used when converting MUD-era rates to our clock. */
export function roundsPerMinute(): number {
  return 60_000 / ROUND_MS;
}

/** SRD: max HP at level 1 is the hit die plus the Constitution modifier. */
export function maxHitPoints(hitDie: number, level: number, conMod: number): number {
  const average = Math.floor(hitDie / 2) + 1;
  return hitDie + conMod + (Math.max(1, level) - 1) * (average + conMod);
}

export function experienceToLevel(level: number): number {
  // A smooth curve rather than the SRD's lookup table, so it extends past level 20 without
  // extra data. Tuned to sit close to the SRD values through the low levels.
  return Math.floor(500 * (level - 1) ** 2 + 300 * (level - 1));
}
