/**
 * Spells: the registry, the two gates, and the damage the first nukes roll — **Phase 20 slice 3**.
 *
 * `DESIGN-spells.md` is the argument; this is the arithmetic, all of it pure and cited. The registry
 * carries what `SPELL_CREATE` carries (name, wind-up, circle, aggression) minus what waits for later
 * slices (target bitmasks arrive with areas, costs with Phase 21's classes). The gates are the two
 * independent rolls the note's §1 maps, with the traps kept on purpose: the **×5** every save
 * modifier silently gets (`sparser.c:1142` — transcribe it or ship saves five times too weak), the
 * *petri*-named fear save, and the rule that a save-proof cast is still shruggable.
 */

import { randomInt, type Dice, type Rng } from './rules.ts';

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

export const SPELL_IDS = ['magic_missile', 'burning_hands', 'chill_touch', 'shocking_grasp'] as const;
export type SpellId = (typeof SPELL_IDS)[number];

/**
 * How a spell meets the saving throw — the note's finding that save-for-half is spelled two inverse
 * ways in the source, so a spell's dice are only meaningful beside its convention:
 * `double-on-fail` writes the *saved* amount and doubles it on a failed save (fireball's shape,
 * `magic.c:3048`); `none` rolls no save at all (magic missile, whose bolts shrug individually).
 */
export type SaveConvention = 'none' | 'double-on-fail';

export interface Spell {
  readonly id: SpellId;
  readonly name: string;
  /** The wind-up. `beats × PULSE_SPELLCAST` ≈ 2.25 s per beat in the source; ours lands on seconds. */
  readonly castMs: number;
  /** The circle `SPELL_ADD` writes — unread until Phase 21's classes, carried because it is identity. */
  readonly circle: number;
  readonly save: SaveConvention;
  /** Second-person flavour of the strike, for the caster's own line. */
  readonly noun: string;
}

/**
 * The four first nukes, each verified live in `magic.c` with its dice and its convention
 * (`skills.c:845-881` registrations; handlers cited per formula below).
 */
export const SPELLS: Readonly<Record<SpellId, Spell>> = {
  magic_missile: { id: 'magic_missile', name: 'magic missile', castMs: 2000, circle: 1, save: 'none', noun: 'missiles' },
  burning_hands: { id: 'burning_hands', name: 'burning hands', castMs: 2000, circle: 2, save: 'none', noun: 'flames' },
  chill_touch: { id: 'chill_touch', name: 'chill touch', castMs: 2000, circle: 2, save: 'double-on-fail', noun: 'chill' },
  shocking_grasp: { id: 'shocking_grasp', name: 'shocking grasp', castMs: 2500, circle: 3, save: 'double-on-fail', noun: 'shock' },
};

export function isSpellId(value: string): value is SpellId {
  return Object.hasOwn(SPELLS, value);
}

/** The spell a typed or authored name means, matched whole — `magic missile`, not `magic`. */
export function spellByName(name: string): Spell | undefined {
  const wanted = name.trim().toLowerCase();
  for (const id of SPELL_IDS) if (SPELLS[id].name === wanted) return SPELLS[id];
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Damage — per-spell formulas of caster level, the source's own               */
/* -------------------------------------------------------------------------- */

/** One struck packet of a spell: magic missile is several, everything else is one. */
export interface SpellBlow {
  readonly damage: number;
}

/**
 * What a spell throws before the gates have their say, as **blows** — plural only for magic missile,
 * whose 1–5 bolts each face the shrug separately (`magic.c:495-512`), which is why this returns a
 * list rather than a sum.
 *
 * The formulas are transcribed, not tidied — including chill touch's precedence quirk: the source
 * writes `dice(1, 6) + 5 * 4 + level`, and `5 * 4` binds first, so it is `1d6 + 20 + level` and not
 * its siblings' `(dice(n+5,6)) × 4` shape. The number shipped; the number is transcribed
 * (`magic.c:529`, and the design note's §0 warning about it).
 */
export function rollSpellBlows(rng: Rng, spell: SpellId, level: number): SpellBlow[] {
  const lvl = Math.max(1, level);
  const die = (count: number, sides: number): number => rollDiceLocal(rng, count, sides);
  switch (spell) {
    case 'magic_missile': {
      // BOUNDED(1, level/3, 5) missiles of dice(1,4)*4 + number(1, level) each.
      const bolts = Math.max(1, Math.min(5, Math.floor(lvl / 3)));
      const out: SpellBlow[] = [];
      for (let i = 0; i < bolts; i++) out.push({ damage: die(1, 4) * 4 + randomInt(rng, 1, lvl) });
      return out;
    }
    case 'burning_hands':
      // dice(level/10 + 5, 6) * 4, no save (`magic.c:606-624`).
      return [{ damage: die(Math.floor(lvl / 10) + 5, 6) * 4 }];
    case 'chill_touch':
      // The quirk, verbatim (`magic.c:529`). The STR-drain rider is dropped and named: no ability scores.
      return [{ damage: die(1, 6) + 20 + lvl }];
    case 'shocking_grasp':
      // dice(level/6 + 5, 6) * 4, doubled on a failed save (`magic.c:626-645`).
      return [{ damage: die(Math.floor(lvl / 6) + 5, 6) * 4 }];
  }
}

function rollDiceLocal(rng: Rng, count: number, sides: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += randomInt(rng, 1, sides);
  return total;
}

/* -------------------------------------------------------------------------- */
/* Gate 1 — the saving throw                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The five save types, the source's own order — and its own naming trap kept visible: slot 2 is
 * **fear** in every macro (`SAVING_FEAR`, `APPLY_SAVING_FEAR`) but `petri` in the property tables
 * (`saves_data[2] = "petri"`, `sparser.c:93`) — the table name outlived the meaning. Ours are named
 * for what they are; the note records where the source's property files would disagree.
 */
export const SAVE_TYPES = ['paralysis', 'rod', 'fear', 'breath', 'spell'] as const;
export type SaveType = (typeof SAVE_TYPES)[number];

/** `find_save`'s two endpoints — a *failure* percentage, high at level 0, falling with level. */
export const SAVE_STARTING = 70;
export const SAVE_TOP = 20;

/**
 * The chance a save FAILS, as a percentage — `find_save` (`sparser.c:1047-1066`), inverted from
 * D&D's instincts twice over: lower is better, and a **positive mod hurts the defender**. The mod is
 * multiplied by five because the scale changed and the ±3 call sites did not (`sparser.c:1142`,
 * *"mod is a modification to the SAVE, not the roll... less is more"*). Clamped 1–99: both ends
 * always keep a 1% surprise. Race and class adjustments are Phase 21's data; NPCs' `-level/3` bonus
 * is folded when the defender is one, as the source has it.
 */
export function saveFailurePercent(level: number, mod: number, npc: boolean): number {
  let save = SAVE_STARTING - (Math.max(0, level) * (SAVE_STARTING - SAVE_TOP)) / 60;
  if (npc) save -= Math.max(0, level) / 3;
  save += mod * 5;
  return Math.max(1, Math.min(99, Math.round(save)));
}

/** The roll: a save succeeds when d100 clears the failure percentage. Seeded, like every roll. */
export function rollSave(rng: Rng, level: number, mod: number, npc: boolean): boolean {
  return randomInt(rng, 1, 100) > saveFailurePercent(level, mod, npc);
}

/**
 * The standard offensive mod — `get_default_save_mod` (`sparser.c:1068-1107`). Below circle 7 it is
 * the level difference, halved and bounded ±3; the higher tiers ignore the victim entirely and wait
 * for spells of circles we do not ship yet.
 */
export function defaultSaveMod(casterLevel: number, victimLevel: number, circle: number): number {
  if (circle < 7) return Math.max(-3, Math.min(3, Math.floor((casterLevel - victimLevel) / 2)));
  if (casterLevel <= 45) return Math.max(0, Math.min(5, Math.floor((casterLevel - 30) / 3)));
  return Math.max(1, Math.floor(((casterLevel - 45) * 2) / 3));
}

/* -------------------------------------------------------------------------- */
/* Gate 2 — the shrug                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Race codes that carry `INNATE_MAGIC_RESISTANCE` (`assign_innates`, `innates.c:477-788`), keyed by
 * the harvest's own codes (`attacks.ts`'s vocabulary): dragons and dracoliches, demons and devils,
 * the four elementals. The source's list also names drow, the elf family, tiefling, gith, lich,
 * vampire and beholder — player-adjacent races whose codes join this set with Phase 21, and undead
 * codes the loaded zones do not yet spawn. A victim with no race — every player until Phase 21 —
 * never shrugs, which is the source's own shape: MR is innate, and innates ride races.
 */
export const MAGIC_RESISTANT_RACES: ReadonlySet<string> = new Set(['DR', 'DL', 'DE', 'DV', 'FE', 'AE', 'WE', 'EE']);

/**
 * The shrug chance, as a percentage — `get_innate_resistance` (`innates.c:3688-3720`). The racial
 * base is a runtime property in Duris (`innate.shrug.<race>`, default 0), so the C alone cannot say
 * what a drow shrugs; ours ships the same default and the same consequence: an MR race with no
 * authored number shrugs at the **floor of 5%**, scaled up by level exactly as the source scales it.
 * Zero for everyone else — the gate simply is not rolled.
 */
export function shrugChance(raceCode: string | undefined, level: number, base = 0): number {
  if (!raceCode || !MAGIC_RESISTANT_RACES.has(raceCode.toUpperCase())) return 0;
  const lvl = Math.max(1, level);
  const raw = base - Math.min(6, 56 - lvl);
  const scaled = raw * Math.min(1, lvl / 50);
  return Math.min(100, Math.max(5, Math.round(scaled)));
}

/** The roll. Independent of the save by design — a save-proof cast is still shruggable. */
export function rollShrug(rng: Rng, chance: number): boolean {
  if (chance <= 0) return false;
  return randomInt(rng, 1, 100) <= chance;
}

/** How often a fighting mob that knows spells reaches for one instead of swinging. Ours, named. */
export const MOB_CAST_CHANCE = 50;

/**
 * The source's level-rolled quick chant for mobs (`mobact.c:735-742`): full wind-up when
 * `number(1,101) > 20 + 3·level/2`, half otherwise — and at level 60+ a mob casts instantly, which
 * none of ours reaches. What it buys: a low-level shaman telegraphs, a high-level one is dangerous.
 */
export function mobCastMs(rng: Rng, spell: Spell, level: number): number {
  if (level >= 60) return 0;
  const full = randomInt(rng, 1, 101) > 20 + Math.floor((3 * level) / 2);
  return full ? spell.castMs : Math.max(1000, Math.round(spell.castMs / 2));
}

/** The dice shape callers pass to `landBlow`-adjacent code; exported for symmetry with abilities. */
export type SpellDice = Dice;
