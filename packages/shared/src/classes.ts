/**
 * The nine classes — Phase 21, owner's pick 2026-08-08: the Toril core.
 *
 * ## Shape and magnitudes, as always
 *
 * The SRD gives the shape: a hit die per class, rolled once per level with the CON modifier added
 * (14b's rule — rolled and *stored*, never recomputed). Duris gives the cadence and the gates: a
 * **new spell circle every five levels** (`advance_level`, `limits.c`: `level % 5 == 1` — circles
 * open at 1, 6, 11, 16…), and **minimum stats per class** (`min_stats_for_class`,
 * `constant.c:1379`), folded from the 100-scale to ours by dividing by five, DEX taking the mean
 * of the source's Dex and Agi columns. The half-casters open at eleven — a paladin prays for a
 * decade before anyone answers.
 *
 * ## The cut that makes nine classes buildable now
 *
 * A caster **knows** every spell of their class list whose circle has opened. No spellbooks, no
 * scribing, no per-spell memorization times — all recorded as follow-ons in `DESIGN-spells.md`'s
 * inheritance list. What limits casting is slots per circle (slice 2), refilled by the rest that
 * already ticks. The lists below are sized to the registry Phase 20 actually shipped — ten spells
 * — and grow as it does; a class list naming a spell the registry lacks is a typecheck error,
 * which is the point of `SpellId`.
 */

import { type Ability } from './rules.ts';
import { type SpellId } from './spells.ts';

export const CLASS_IDS = [
  'warrior',
  'ranger',
  'paladin',
  'cleric',
  'druid',
  'shaman',
  'sorcerer',
  'necromancer',
  'rogue',
] as const;

export type ClassId = (typeof CLASS_IDS)[number];

/** Which corner of play a class lives in — the skills table keys ceilings on this. */
export type ClassGroup = 'warrior' | 'priest' | 'wizard' | 'rogue';

export interface CharClass {
  readonly id: ClassId;
  readonly name: string;
  readonly group: ClassGroup;
  /** Faces of the per-level hit die. SRD magnitudes: d10 warriors, d8 priests/rogues, d6 wizards. */
  readonly hitDie: number;
  /**
   * Minimum scores to create — `min_stats_for_class` ÷ 5. The roll raises a failing ability to
   * its minimum rather than refusing, which is the source's own behaviour and why class is chosen
   * before the dice are thrown.
   */
  readonly mins: Readonly<Partial<Record<Ability, number>>>;
  /** The ability the mana pool reads (arcane INT, divine WIS). Absent for the mundane. */
  readonly casting?: {
    readonly kind: 'arcane' | 'divine';
    /** Level the first circle opens at: 1 for full casters, 11 for the half-casters. */
    readonly opensAt: number;
  };
  /** What the class can ever know, from the registry that exists. Circle gates come per spell. */
  readonly spells: readonly SpellId[];
  /** One line the class card shows. */
  readonly flavour: string;
}

/**
 * The highest circle open at a level: one at `opensAt`, another every five levels after. Zero
 * before anything has opened — the paladin at ten casts nothing.
 */
export function circleAt(level: number, opensAt: number): number {
  if (level < opensAt) return 0;
  return Math.floor((level - opensAt) / 5) + 1;
}

export const CLASSES: Readonly<Record<ClassId, CharClass>> = {
  warrior: {
    id: 'warrior',
    name: 'Warrior',
    group: 'warrior',
    hitDie: 10,
    mins: { str: 11, con: 11 },
    spells: [],
    flavour: 'The answer to most problems, applied edge-first.',
  },
  ranger: {
    id: 'ranger',
    name: 'Ranger',
    group: 'warrior',
    hitDie: 10,
    mins: { str: 8, dex: 7, con: 8, int: 8 },
    casting: { kind: 'divine', opensAt: 11 },
    spells: ['cure_light'],
    flavour: 'At home where the road is not, and patient enough to pray about it eventually.',
  },
  paladin: {
    id: 'paladin',
    name: 'Paladin',
    group: 'warrior',
    hitDie: 10,
    mins: { str: 11, dex: 5, con: 10, wis: 13, cha: 10 },
    casting: { kind: 'divine', opensAt: 11 },
    spells: ['cure_light', 'bless'],
    flavour: 'A sword that swore something, and meant it.',
  },
  cleric: {
    id: 'cleric',
    name: 'Cleric',
    group: 'priest',
    hitDie: 8,
    mins: { str: 8, con: 4, wis: 11, cha: 10 },
    casting: { kind: 'divine', opensAt: 1 },
    spells: ['cure_light', 'cure_serious', 'bless', 'armor', 'earthquake'],
    flavour: 'The reason the rest of the group is still standing.',
  },
  druid: {
    id: 'druid',
    name: 'Druid',
    group: 'priest',
    hitDie: 8,
    mins: { con: 4, int: 10, wis: 13, cha: 8 },
    casting: { kind: 'divine', opensAt: 1 },
    spells: ['cure_light', 'armor', 'earthquake', 'ice_storm'],
    flavour: 'On speaking terms with the weather, and it listens.',
  },
  shaman: {
    id: 'shaman',
    name: 'Shaman',
    group: 'priest',
    hitDie: 8,
    mins: { int: 10, wis: 10, cha: 8 },
    casting: { kind: 'divine', opensAt: 1 },
    spells: ['cure_light', 'cure_serious', 'bless', 'chill_touch'],
    flavour: 'Talks to what the priest prays at. The kobolds already have one.',
  },
  sorcerer: {
    id: 'sorcerer',
    name: 'Sorcerer',
    group: 'wizard',
    hitDie: 6,
    mins: { dex: 3, int: 15 },
    casting: { kind: 'arcane', opensAt: 1 },
    spells: ['magic_missile', 'burning_hands', 'shocking_grasp', 'ice_storm'],
    flavour: 'Thin as a reed and the most dangerous thing in the room, given a moment.',
  },
  necromancer: {
    id: 'necromancer',
    name: 'Necromancer',
    group: 'wizard',
    hitDie: 6,
    mins: { dex: 3, int: 15 },
    casting: { kind: 'arcane', opensAt: 1 },
    spells: ['chill_touch', 'magic_missile', 'burning_hands'],
    flavour: 'Studies the one subject everyone eventually contributes to.',
  },
  rogue: {
    id: 'rogue',
    name: 'Rogue',
    group: 'rogue',
    hitDie: 8,
    mins: { dex: 14, int: 6, cha: 6 },
    spells: [],
    flavour: 'Wherever the lock, the shadow, or the purse is — briefly.',
  },
};

export function isClassId(value: unknown): value is ClassId {
  return typeof value === 'string' && (CLASS_IDS as readonly string[]).includes(value);
}
