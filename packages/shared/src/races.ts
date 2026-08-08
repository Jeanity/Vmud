/**
 * The nine playable races — Phase 21, owner's pick 2026-08-08: the Toril seven plus the two
 * underdark races, **racewar excluded**. A race here is stats, senses and flavour; it is never a
 * side, and anyone may group with anyone.
 *
 * ## Transcription, not invention
 *
 * The stat numbers are the *live server's own*, read out of `lib/duris.properties` (the source
 * loads them at boot — `db.c:737` — defaulting to 100), where Human is the all-100 baseline. They
 * arrive here as **factors** on a 100-scale and are folded to 5e-shaped bonuses by
 * {@link racialBonus}: `round((factor − 100) / 15)`, with DEX taking the mean of the source's Dex
 * and Agi (one ability where Duris kept reflexes and fine hands apart). The divisor was chosen so
 * the loudest row in the data — Barbarian Con 165 — lands at +4, which is the top of 5e's own
 * racial range. The factors stay in the table and the bonus is *derived*, so the two can never
 * drift apart.
 *
 * Senses and quirks transcribe `innates.c:469–560`; the mana column and per-level hit-point nudge
 * transcribe `racial_data` (`constant.c`); sizes transcribe `race_size` (`common.c`) — both
 * dwarves are MEDIUM there, only Halfling and Gnome are SMALL.
 *
 * ## The code is the shrug gate's key
 *
 * `code` is the source's own mob race code (`defines.h:891` — `PH`, `PL`, …), the namespace
 * {@link shrugChance} has keyed on since Phase 20. Giving a player character a race code is what
 * finally lets a drow player shrug a kobold shaman's missile — no new arithmetic, the pinned
 * tests stay the authority.
 */

import { ABILITIES, type Ability } from './rules.ts';

export const RACE_IDS = [
  'human',
  'barbarian',
  'grey-elf',
  'mountain-dwarf',
  'duergar',
  'halfling',
  'gnome',
  'half-elf',
  'drow',
] as const;

export type RaceId = (typeof RACE_IDS)[number];

/** The ten-stat factor row as `duris.properties` carries it. 100 is human-normal. */
export interface RaceFactors {
  readonly str: number;
  readonly dex: number;
  readonly agi: number;
  readonly con: number;
  readonly int: number;
  readonly wis: number;
  readonly cha: number;
}

export interface Race {
  readonly id: RaceId;
  readonly name: string;
  /** The source's mob race code — the shrug gate's namespace, shared with every mob. */
  readonly code: string;
  readonly factors: RaceFactors;
  readonly size: 'small' | 'medium';
  /** Sees in the dark. `ultravision` is the deeper form; both read as darkvision for now. */
  readonly vision: 'normal' | 'infravision' | 'ultravision';
  /** Rolls on the shrug gate — `INNATE_MAGIC_RESISTANCE` (or the duergar's magical reduction). */
  readonly magicResistant: boolean;
  /** Burns under the open sun — drow and duergar. A reader in the light system, Phase 21 §5. */
  readonly sunVulnerable: boolean;
  /** Percent of the class mana pool — `racial_data`'s max-mana column, human 100. */
  readonly manaFactor: number;
  /** Per-level hit-point nudge — `racial_data`'s hp bonus column. */
  readonly hpBonus: number;
  /** One line the race card shows. */
  readonly flavour: string;
}

/** `round((factor − 100) / 15)`; DEX is the mean of Dex and Agi. See the module note. */
export function racialBonus(race: Race, ability: Ability): number {
  const factor =
    ability === 'dex' ? (race.factors.dex + race.factors.agi) / 2 : race.factors[ability];
  return Math.round((factor - 100) / 15);
}

/** All six folded bonuses at once — what the race card prints beside the name. */
export function racialBonuses(race: Race): Readonly<Record<Ability, number>> {
  const out = {} as Record<Ability, number>;
  for (const ability of ABILITIES) out[ability] = racialBonus(race, ability);
  return out;
}

export const RACES: Readonly<Record<RaceId, Race>> = {
  human: {
    id: 'human',
    name: 'Human',
    code: 'PH',
    factors: { str: 100, dex: 100, agi: 100, con: 100, int: 100, wis: 100, cha: 100 },
    size: 'medium',
    vision: 'normal',
    magicResistant: false,
    sunVulnerable: false,
    manaFactor: 100,
    hpBonus: 0,
    flavour: 'The baseline everything else is measured against — and the only race magic never shrugs off.',
  },
  barbarian: {
    id: 'barbarian',
    name: 'Barbarian',
    code: 'PB',
    factors: { str: 155, dex: 90, agi: 90, con: 165, int: 70, wis: 95, cha: 75 },
    size: 'medium',
    vision: 'normal',
    magicResistant: false,
    sunVulnerable: false,
    manaFactor: 80,
    hpBonus: 1,
    flavour: 'The strongest thing on two legs that still counts as people. Not a reader.',
  },
  'grey-elf': {
    id: 'grey-elf',
    name: 'Grey Elf',
    code: 'PE',
    factors: { str: 90, dex: 110, agi: 120, con: 90, int: 115, wis: 120, cha: 120 },
    size: 'medium',
    vision: 'infravision',
    magicResistant: true,
    sunVulnerable: false,
    manaFactor: 120,
    hpBonus: -1,
    flavour: 'Old blood, older manners, and a constitution that never forgave either.',
  },
  'mountain-dwarf': {
    id: 'mountain-dwarf',
    name: 'Mountain Dwarf',
    code: 'PM',
    factors: { str: 135, dex: 95, agi: 85, con: 120, int: 85, wis: 125, cha: 80 },
    size: 'medium',
    vision: 'infravision',
    magicResistant: false,
    sunVulnerable: false,
    manaFactor: 90,
    hpBonus: 1,
    flavour: 'Stone sense, iron patience, and no opinion of yours required.',
  },
  duergar: {
    id: 'duergar',
    name: 'Duergar',
    code: 'PD',
    factors: { str: 130, dex: 90, agi: 90, con: 135, int: 75, wis: 130, cha: 70 },
    size: 'medium',
    vision: 'ultravision',
    magicResistant: true,
    sunVulnerable: true,
    manaFactor: 95,
    hpBonus: 1,
    flavour: 'The dwarves the mountain kept. The sun is not their friend, and neither are they.',
  },
  halfling: {
    id: 'halfling',
    name: 'Halfling',
    code: 'PF',
    factors: { str: 95, dex: 130, agi: 125, con: 95, int: 100, wis: 115, cha: 110 },
    size: 'small',
    vision: 'normal',
    magicResistant: false,
    sunVulnerable: false,
    manaFactor: 95,
    hpBonus: 0,
    flavour: 'Small, quick, and standing exactly where you were about to step.',
  },
  gnome: {
    id: 'gnome',
    name: 'Gnome',
    code: 'PG',
    factors: { str: 85, dex: 115, agi: 120, con: 90, int: 130, wis: 95, cha: 95 },
    size: 'small',
    vision: 'infravision',
    magicResistant: false,
    sunVulnerable: false,
    manaFactor: 150,
    hpBonus: -1,
    flavour: 'A mind like a lockworks, in a body built close to the ground it studies.',
  },
  'half-elf': {
    id: 'half-elf',
    name: 'Half-elf',
    code: 'P2',
    factors: { str: 105, dex: 110, agi: 110, con: 102, int: 115, wis: 110, cha: 115 },
    size: 'medium',
    vision: 'infravision',
    magicResistant: true,
    sunVulnerable: false,
    manaFactor: 110,
    hpBonus: 0,
    flavour: 'A little of everything, resented by both sides of the family. The generalist.',
  },
  drow: {
    id: 'drow',
    name: 'Drow',
    code: 'PL',
    factors: { str: 90, dex: 110, agi: 130, con: 90, int: 120, wis: 115, cha: 110 },
    size: 'medium',
    vision: 'ultravision',
    magicResistant: true,
    sunVulnerable: true,
    manaFactor: 120,
    hpBonus: -1,
    flavour: 'Grace sharpened in the dark. Sunlight is a wound the surface keeps reopening.',
  },
};

export function isRaceId(value: unknown): value is RaceId {
  return typeof value === 'string' && (RACE_IDS as readonly string[]).includes(value);
}
