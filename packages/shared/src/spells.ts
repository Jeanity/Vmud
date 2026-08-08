/**
 * Spells: the registry, the two gates, and the damage the first nukes roll — **Phase 20 slice 3**.
 *
 * `DESIGN-spells.md` is the argument; this is the arithmetic, all of it pure and cited. The registry
 * carries what `SPELL_CREATE` carries (name, wind-up, circle, aggression) minus what waits for later
 * slices (target bitmasks arrive with areas, costs with Phase 21's classes). The gates are the two
 * independent rolls the note's §1 maps, with the traps kept on purpose: the **×5** every save
 * modifier silently gets (`sparser.c:1142` — transcribe it or ship saves five times too weak), the
 * *petri*-named fear save, and the rule that a save-proof cast is still shruggable.
 *
 * **Phase 21** adds the third thing that stands between a spell and a hit point, and it is not a
 * gate: {@link reduceSpellDamage}, the dwarves' 20% off generic damage. The gates decide *whether*;
 * this decides *how much*, after they have decided yes.
 */

import { randomInt, type Dice, type Rng } from './rules.ts';
import { MS_PER_DURIS_HOUR, armourBonusFrom } from './items.ts';
import { RACES, RACE_IDS } from './races.ts';
import type { ApplyLocation } from './affects.ts';

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

export const SPELL_IDS = ['magic_missile', 'burning_hands', 'chill_touch', 'shocking_grasp', 'cure_light', 'cure_serious', 'armor', 'bless', 'earthquake', 'ice_storm'] as const;
export type SpellId = (typeof SPELL_IDS)[number];

/**
 * What a completed cast *does* — the routing fact. A nuke runs the gates and lands blows; a heal
 * restores and pays threat (`joinBySupporting`'s second producer); a buff installs affect nodes;
 * an area sweeps the room (slice 6 — the thinning and the hit test live beside the rolls below).
 * The source has no such field — its spell functions simply do different things — but our completion
 * is one seam and it has to route somehow, and a string it can switch on beats ten callbacks.
 */
export type SpellKind = 'nuke' | 'heal' | 'buff' | 'area';

/**
 * How a spell meets the saving throw — the note's finding that save-for-half is spelled two inverse
 * ways in the source, so a spell's dice are only meaningful beside its convention:
 * `double-on-fail` writes the *saved* amount and doubles it on a failed save (fireball's shape,
 * `magic.c:3048`); `none` rolls no save at all (magic missile, whose bolts shrug individually).
 */
export type SaveConvention = 'none' | 'double-on-fail';

/**
 * What *kind* of damage a spell deals — the source's `SPLDAM_` taxonomy, all twelve of it
 * (`damage.h:91-103`), transcribed whole rather than as the four our registry happens to use. It is
 * a closed, numbered list in the C and it decides real things: which shield absorbs, which aura
 * vamps, which vulnerability doubles — and, the reason it arrives now, **which victims get the
 * dwarves' 20% off** (`fight.c:3817` takes `case SPLDAM_GENERIC` and no other).
 *
 * `generic` is not a fallback or an "untyped" bucket: it is type **1**, the source's own name for
 * force — magic missile's push, an earthquake's falling rock — and the one type no elemental ward
 * in the game answers. `ELEMENTAL_DAM` (`damage.h:105`) is `FIRE…ACID` plus `EARTH`, and it
 * pointedly excludes `generic`, which is the same distinction from the other side.
 */
export type SpellDamageType =
  | 'generic'
  | 'fire'
  | 'cold'
  | 'lightning'
  | 'gas'
  | 'acid'
  | 'negative'
  | 'holy'
  | 'psi'
  | 'spirit'
  | 'sound'
  | 'earth';

export interface Spell {
  readonly id: SpellId;
  readonly name: string;
  readonly kind: SpellKind;
  /** The wind-up. `beats × PULSE_SPELLCAST` ≈ 2.25 s per beat in the source; ours lands on seconds. */
  readonly castMs: number;
  /** The circle `SPELL_ADD` writes — unread until Phase 21's classes, carried because it is identity. */
  readonly circle: number;
  readonly save: SaveConvention;
  /**
   * The `SPLDAM_` argument this spell's handler passes to `spell_damage` — absent on the spells
   * that deal no damage, which is the honest shape: a cure has no damage type in the source either.
   */
  readonly damageType?: SpellDamageType;
  /** Second-person flavour of the strike, for the caster's own line. */
  readonly noun: string;
  /** The recipient's own sentence when a heal or a buff takes — the source's `send_to_char` line. */
  readonly felt?: string;
}

/**
 * The registry — the four first nukes (slice 3) and the first heals and buffs (slice 5), each
 * verified live in `magic.c` with its dice and its convention (`skills.c` registrations; handlers
 * cited per formula below). The `felt` lines are the source's own sentences, colour and all.
 *
 * The `damageType` column is read straight off each handler's own `spell_damage` call and is the
 * whole reason {@link reduceSpellDamage} discriminates: **two of our six damaging spells are
 * `generic` and four are typed**, which is not a rounding of the source but its actual split.
 */
export const SPELLS: Readonly<Record<SpellId, Spell>> = {
  // `magic.c:510` — `SPLDAM_GENERIC`. Force, and the archetypal reducible spell.
  magic_missile: { id: 'magic_missile', name: 'magic missile', kind: 'nuke', castMs: 2000, circle: 1, save: 'none', damageType: 'generic', noun: 'missiles' },
  // `magic.c:623` — `SPLDAM_FIRE`.
  burning_hands: { id: 'burning_hands', name: 'burning hands', kind: 'nuke', castMs: 2000, circle: 2, save: 'none', damageType: 'fire', noun: 'flames' },
  // `magic.c:539` — `SPLDAM_COLD`. Named "chill", and typed as cold: no reduction.
  chill_touch: { id: 'chill_touch', name: 'chill touch', kind: 'nuke', castMs: 2000, circle: 2, save: 'double-on-fail', damageType: 'cold', noun: 'chill' },
  // `magic.c:644` — `SPLDAM_LIGHTNING`.
  shocking_grasp: { id: 'shocking_grasp', name: 'shocking grasp', kind: 'nuke', castMs: 2500, circle: 3, save: 'double-on-fail', damageType: 'lightning', noun: 'shock' },
  cure_light: { id: 'cure_light', name: 'cure light', kind: 'heal', castMs: 1500, circle: 1, save: 'none', noun: 'healing touch', felt: '&+WYou feel a little better!&N' },
  cure_serious: { id: 'cure_serious', name: 'cure serious', kind: 'heal', castMs: 2000, circle: 2, save: 'none', noun: 'healing touch', felt: '&+WYou feel a lot better!&N' },
  armor: { id: 'armor', name: 'armor', kind: 'buff', castMs: 2000, circle: 1, save: 'none', noun: 'warding', felt: '&+WBands of magic armor wrap around you!&N' },
  bless: { id: 'bless', name: 'bless', kind: 'buff', castMs: 2000, circle: 1, save: 'none', noun: 'blessing', felt: '&+WYou suddenly feel blessed!&N' },
  // Slice 6. Earthquake's save is bespoke (an agility save inside its own loop), so `save` stays
  // 'none' — the convention field describes gate 1, and neither area runs it.
  // `magic.c:3485` — `SPLDAM_GENERIC`, which is the falling rock and not the ground: an earthquake
  // is reducible and an ice storm is not, from the same pair of area spells.
  earthquake: { id: 'earthquake', name: 'earthquake', kind: 'area', castMs: 2500, circle: 3, save: 'none', damageType: 'generic', noun: 'quake' },
  // `magic.c:12868`, inside `spell_single_icestorm` — `SPLDAM_COLD`.
  ice_storm: { id: 'ice_storm', name: 'ice storm', kind: 'area', castMs: 2500, circle: 6, save: 'none', damageType: 'cold', noun: 'storm of ice' },
};

export function isSpellId(value: string): value is SpellId {
  return Object.hasOwn(SPELLS, value);
}

/**
 * Duris' own spell numbers for the registry — `spells.h`, read rather than remembered, because folk
 * memory is wrong about at least one of them (shocking grasp is **37**, not the 48 other Dikus use).
 * This is the join key a scroll's `value[1..3]` speaks (`do_recite`, `actoth.c:4234`), kept raw in
 * the catalogue exactly as `ItemTemplate.type` is, and translated here at the edge — a scroll whose
 * number names a spell we do not model yet stays recorded, and starts working the day its spell
 * joins {@link SPELLS}.
 */
export const DURIS_SPELL_NUMBERS: Readonly<Record<number, SpellId>> = {
  1: 'armor',
  3: 'bless',
  5: 'burning_hands',
  8: 'chill_touch',
  16: 'cure_light',
  23: 'earthquake',
  32: 'magic_missile',
  37: 'shocking_grasp',
  57: 'cure_serious',
  111: 'ice_storm',
};

/** The spell a Duris number means, or nothing — this world does not model all 700 of them yet. */
export function spellFromDurisNumber(n: number): Spell | undefined {
  const id = DURIS_SPELL_NUMBERS[n];
  return id === undefined ? undefined : SPELLS[id];
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
    case 'ice_storm':
      // Per victim: dice(min(level, 36), 8) — `spell_single_icestorm`, `magic.c:12852`. Rolled once
      // per body the storm reaches, which is why the area loop calls this per survivor.
      return [{ damage: die(Math.min(lvl, 36), 8) }];
    case 'cure_light':
    case 'cure_serious':
    case 'armor':
    case 'bless':
    case 'earthquake':
      // Not single-roll nukes. Heals and buffs live in {@link rollSpellHeal} / {@link rollSpellBuff};
      // earthquake's two rolls are bespoke ({@link rollEarthquake}) because which one applies is a
      // per-victim save its own loop makes. An empty volley keeps a misrouted call harmless.
      return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Areas — slice 6                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Ice storm's floor — the **live** value, not the C fallback. `spell_ice_storm` reads
 * `get_property("spell.area.minChance.iceStorm", 90)` (`magic.c:12894`), and the 90 is only reached
 * when the key is absent: `get_property` `bsearch`es the loaded table and returns the default *only*
 * on a miss (`properties.c:59-72`). The key is present — `spell.area.minChance.iceStorm=0.000`
 * (`lib/duris.properties:821`) — so the running server floors an ice storm at **none** of the players
 * present and lets {@link areaHitCount}'s own draw decide. We shipped the fallback for a phase; this
 * is the live number. (`chanceStep` is 10 there and read by nobody — the ladder is dead code.)
 */
export const ICE_STORM_MIN_CHANCE = 0;

/**
 * How many of the players present an area actually strikes — the live half of `cast_as_damage_area`
 * (`utility.c:5961-5985`), transcribed with its own strange arithmetic: the count is drawn uniformly
 * from `pc/2 + 5/pc ± 0.75`, floored at `min_chance%` of those present, capped at all of them. The
 * roadmap's "crowd thinning" was the *dead* algorithm's name — the decaying-chance ladder is
 * commented out in the source, `chance_step` fetched at ~25 call sites and read by none. **Players
 * only**: NPCs are never thinned, which is why a room of thirty mobs takes thirty full hits.
 */
export function areaHitCount(rng: Rng, pcCount: number, minChancePct: number): number {
  if (pcCount <= 0) return 0;
  const median = pcCount / 2 + 5 / pcCount;
  const rolled = Math.floor(randomInt(rng, Math.floor((median - 0.75) * 1000), Math.floor((median + 0.75) * 1000)) / 1000);
  return Math.min(pcCount, Math.max(Math.floor((pcCount * minChancePct) / 100), rolled));
}

/**
 * Earthquake's two damage rolls (`magic.c:3475-3515`) — which applies is the victim's agility save,
 * made inside the spell's own loop: a **felled** victim takes `dice(1,30) + level` and goes down; one
 * who keeps their feet is **grazed** for `dice(1,4) + damFlag × (level/2)`, where `damFlag` is the
 * sector's danger (1 open ground, 2 mountains, 3 indoors — falling debris is the whole reason casting
 * this in a cave is famous). Level is fed clamped ≥1 like every roll here.
 */
export function rollEarthquake(rng: Rng, level: number, damFlag: number): { readonly felled: number; readonly grazed: number } {
  const lvl = Math.max(1, level);
  return {
    felled: randomInt(rng, 1, 30) + lvl,
    grazed: randomInt(rng, 1, 4) + damFlag * Math.floor(lvl / 2),
  };
}

/**
 * What a heal restores — the handlers' own rolls, small on purpose (`magic.c:5858-5891`): cure
 * light is `number(2, 10)` and cure serious `dice(3, 8)`, and neither reads the level at all, which
 * is the source's own shape — a first-circle heal is a bandage, not a percentage.
 */
export function rollSpellHeal(rng: Rng, spell: SpellId, _level: number): number {
  switch (spell) {
    case 'cure_light': return randomInt(rng, 2, 10);
    case 'cure_serious': return rollDiceLocal(rng, 3, 8);
    default: return 0;
  }
}

/** One installed node of a buff: a location and how much, `affects.ts`'s own vocabulary. */
export interface SpellBuffNode {
  readonly apply: ApplyLocation;
  readonly modifier: number;
}

/**
 * What a buff installs — durations in the source's own ticks, converted at the one rate this
 * project already fixed (`MS_PER_DURIS_HOUR`, the torch calibration: a Duris hour is ten of our
 * seconds), and every number the handler's own:
 *
 * - **armor** (`magic.c:4295-4325`): `-(level) - number(0, 10)` of Duris AC for 20 ticks — ours
 *   compresses that roll through {@link armourBonusFrom}, the same law a breastplate's value passes,
 *   so the node arrives in our AC points and `refitCombat` adds it beside gear.
 * - **bless** (`magic.c:5118-5156`): `+(level/20 + 1)` hitroll and `-(level/30 + 1)` on the spell
 *   save (negative helps — the source's inverted scale, kept), for `max(5, level/2)` ticks.
 *
 * Re-casting refreshes the duration and never re-rolls the numbers — the source's own else-branch.
 */
export function rollSpellBuff(rng: Rng, spell: SpellId, level: number): { readonly durationMs: number; readonly nodes: readonly SpellBuffNode[] } | undefined {
  const lvl = Math.max(1, level);
  switch (spell) {
    case 'armor':
      return {
        durationMs: 20 * MS_PER_DURIS_HOUR,
        nodes: [{ apply: 'ac', modifier: armourBonusFrom(lvl + randomInt(rng, 0, 10)) }],
      };
    case 'bless':
      return {
        durationMs: Math.max(5, Math.floor(lvl / 2)) * MS_PER_DURIS_HOUR,
        nodes: [
          { apply: 'hit', modifier: Math.floor(lvl / 20) + 1 },
          { apply: 'saves', modifier: -(Math.floor(lvl / 30) + 1) },
        ],
      };
    default:
      return undefined;
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
 * Race codes that carry `INNATE_MAGIC_RESISTANCE` (`assign_innates`, `innates.c:477-791`), each with
 * the **live racial base** its shrug is scaled from. Membership and base are two different sources
 * and both are transcribed here:
 *
 * - *who rolls* is the C — `resists_spell` gates on `has_innate(victim, INNATE_MAGIC_RESISTANCE)`
 *   (`innates.c:3757`) and nothing else;
 * - *how much* is a runtime property — `update_racial_shrug_data` fills `racial_shrug_data[race]`
 *   from `innate.shrug.<race>` with a default of 0 (`sparser.c:2942-2952`), keyed on the race's
 *   `no_spaces` name, and `get_innate_resistance` reads that array (`innates.c:3696`).
 *
 * This is `DESIGN-spells.md` §2.6 in its plainest form — *"the property names recorded beside each
 * number"* — and it is why the table is a map and not a set. Phase 20 shipped the set with **no
 * bases at all**, so every resistant race in the game sat on the 5% floor; a drow was as hard to
 * nuke as a wood elf. A victim with no race never shrugs: MR is innate, and innates ride races.
 *
 * The keys are the source's own mob race codes — `race_names_table`'s fourth column (`common.c:67`),
 * echoed in `defines.h`'s own per-race comments, and the same short string `worldgen/src/mobs.ts`
 * reads out of a `.mob` file's second line. **Four of Phase 20's eight mob codes were not that
 * vocabulary** and are corrected here: dragon is `D` not `DR` (which is *drider*), dracolich `UD`
 * not `DL`, demon `X` not `DE`, devil `Y` not `DV` (which is *deva*), and the fire/air/water
 * elementals are `EF`/`EA`/`EW` — `FE` and `DL` and `DE` name no race at all, and `AE` is a
 * quadruped. Inert either way: no mob in the loaded world carries any of these codes, because
 * `spriteFor` spawns only the humanoids we can draw. See `DESIGN-spell-memory.md` §6.
 */
export const MAGIC_RESISTANT_RACES: ReadonlyMap<string, number> = new Map([
  // Player races (`defines.h:891+`). Duergar are **absent** and that is the correction, not an
  // oversight: `assign_innates` gives them `MAGICAL_REDUCTION`, a −20% damage modifier that never
  // reaches this roll. `innates.c:552`, `fight.c:3817`, and §6 of the spell-memory note.
  ['PL', 35], // drow      — `innate.shrug.DrowElf=35`   (`duris.properties:1908`), `innates.c:542`
  ['PE', 35], // grey elf  — `innate.shrug.GreyElf=35`   (`duris.properties:1901`), `innates.c:509`
  ['P2', 20], // half-elf  — `innate.shrug.Half-Elf=20`  (`duris.properties:1904`), `innates.c:513`
  // The mob races Phase 20 chose, under their real codes and with their real bases.
  ['D', 45],  // dragon          — `innate.shrug.Dragon=45`          (:1918), `innates.c:766`
  ['UD', 30], // dracolich       — `innate.shrug.Dracolich=30`       (:1920), `innates.c:769`
  ['X', 50],  // demon           — `innate.shrug.Demon=50`          (:1915), `innates.c:773`
  ['Y', 50],  // devil           — `innate.shrug.Devil=50`          (:1916), `innates.c:768`
  ['EF', 20], // fire elemental  — `innate.shrug.FireElemental=20`  (:1913), `innates.c:777`
  ['EA', 20], // air elemental   — `innate.shrug.AirElemental=20`   (:1911), `innates.c:774`
  ['EW', 55], // water elemental — `innate.shrug.WaterElemental=55` (:1912), `innates.c:776`
  ['EE', 20], // earth elemental — `innate.shrug.EarthElemental=20` (:1914), `innates.c:775`
]);

/**
 * The shrug chance, as a percentage — `get_innate_resistance` (`innates.c:3688-3720`), transcribed
 * whole. The arithmetic is unchanged from Phase 20 and stays pinned; what changed is its **input**,
 * which used to be a zero nobody ever passed and is now the race's live base from
 * {@link MAGIC_RESISTANT_RACES}:
 *
 * ```
 * res = base − min(6, 56 − level)      // a flat toll that only a level above 56 turns into a bonus
 * res = res × min(1, level / 50)       // and the whole thing ramps in over the first fifty levels
 * res = max(5, res), capped at 100     // the 5% floor every unauthored race used to sit on
 * ```
 *
 * The floor is why the bug was quiet: a drow *did* shrug, at 5%, so nothing looked broken. At level
 * 30 — the top of our band — a drow now shrugs **17%** where it shrugged 5, and a half-elf 8%.
 * Zero for everyone else; the gate is simply not rolled.
 *
 * Dropped with their names: the rrakkma group bonus (`innates.c:3701-3717`) needs groups of blooded
 * players; desecrate land's −10 needs the spell.
 */
export function shrugChance(raceCode: string | undefined, level: number): number {
  const base = raceCode === undefined ? undefined : MAGIC_RESISTANT_RACES.get(raceCode.toUpperCase());
  if (base === undefined) return 0;
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
 * The economy translation for spell damage landing on a **player** — the fix for the kobold shaman
 * killing a level-30 rig character twice in one evening (owner's tuning ask, 2026-08-07).
 *
 * The nuke formulas above are transcribed verbatim, `× 4`s and all — and the source wrote them
 * against its own hit-point pools. A Duris fighter in his twenties stands on several hundred hp,
 * and our **harvested mobs still do** (the kobold shaman's `23d44+207` averages 725) — but our
 * players walk on SRD-scale pools a quarter that size: ~87 hp at level 30 by real progression.
 * So a volley the source costed as a third of a pool is **all** of ours: the autopsy drive measured
 * magic missile for 109 and burning hands for 120, back to back, against a character with 360.
 *
 * The formulas stay verbatim — transcription doctrine; re-deriving dice invites drift — and the
 * translation happens once, at the delivery layer, keyed on **whose pool is being hit**. A mob's
 * pool is the source's own economy and takes the number as written (player nukes against 725-hp
 * mobs were tuned on exactly that). A player's pool takes a quarter, floored, never less than 1 a
 * blow. Melee needs no counterpart: mob swing dice are harvested small (the shaman's 3d5+3) and
 * were already proportionate. Symmetric for any future player-versus-player spell by construction.
 */
export const PLAYER_POOL_DIVISOR = 4;

/** {@link PLAYER_POOL_DIVISOR}, applied. Every spell-damage delivery path routes through this. */
export function scaleSpellDamage(damage: number, victimIsPlayer: boolean): number {
  return victimIsPlayer ? Math.max(1, Math.floor(damage / PLAYER_POOL_DIVISOR)) : damage;
}

/* -------------------------------------------------------------------------- */
/* Magical reduction — the dwarves' armour, and the gates' opposite            */
/* -------------------------------------------------------------------------- */

/**
 * Race codes carrying `MAGICAL_REDUCTION` — **derived from {@link RACES}, not listed**, because for
 * once the source's whole roster fits inside our nine and a hand-copied set could only drift. The
 * grep is the proof: `MAGICAL_REDUCTION` occurs **four times in the entire source** — the `#define`
 * (`structs.h:417`), two grants (`ADD_RACIAL_INNATE(MAGICAL_REDUCTION, RACE_MOUNTAIN, 1)` and the
 * same for `RACE_DUERGAR`, `innates.c:473` and `552`), and one reader (`fight.c:3817`). There is no
 * third race and no mob-only holder to add later, which is exactly what {@link MAGIC_RESISTANT_RACES}
 * could not say and why *that* one is a hand-written map.
 *
 * **This is a race fact, not a player fact**, and the difference is load-bearing: `has_innate` reads
 * `ch->player.race` for anything with a race, PC or NPC alike (`innate_char_race`, `innates.c:362`,
 * consulted by `innate_unlock_level` at `innates.c:420-428`), and racial innates unlock at level 1.
 * The loaded world settles it — **25 mobs already carry these codes**: 16 `PM` (dwarven soldiers,
 * Olaf Forkbeard, Surak) and 9 `PD` (duergar slaves, Bregnar the duergar King) — spread over eight
 * zones, none of them loaded today, all of them one line of `world.config.json` away. Keying on the
 * code arms every one of them the day their zone loads, which is the transcription; keying on player
 * identity would have quietly exempted them from the mechanism their own kin gave the name to.
 */
export const MAGICAL_REDUCTION_RACES: ReadonlySet<string> = new Set(
  RACE_IDS.filter((id) => RACES[id].magicalReduction === true).map((id) => RACES[id].code),
);

/**
 * How much comes off: `dam_mod->mod += -0.2` (`fight.c:3817`). Kept as the source's own signed
 * addend rather than a tidied `0.8`, because the number in the C is the one that has to be checked
 * against the C.
 */
export const MAGICAL_REDUCTION_MOD = -0.2;

/**
 * The dwarves' 20% — `spell_damage_modifiers[]`'s sixth predicate (`fight.c:3817`), transcribed
 * with its discrimination intact:
 *
 * ```c
 * switch (damageType) { case SPLDAM_GENERIC:
 *     if (has_innate(victim, MAGICAL_REDUCTION)) { dam_mod->mod += -0.2; dam_mod->type = More; }
 *     break; }
 * ```
 *
 * **A `switch` with one `case` and no `default` is the whole specification.** Generic damage is
 * reduced; fire, cold, lightning, gas, acid, negative, holy, psi, spirit, sound and earth are not.
 * So a duergar shrugs off part of a magic missile and takes an ice storm whole — and takes *burning
 * hands* whole, which is the counter-intuitive half and the reason this is a per-spell fact rather
 * than a flat racial band. The predicate is the *only* reader of the innate in the source.
 *
 * **Where it sits in the order.** `spell_damage`'s gates all come first and all return early —
 * damage ward, elemental vamp, globes, deflect, procs, the shrug, spell absorb, type shields
 * (`fight.c:4349-4646`) — and only then does the modifier table run (`fight.c:4648-4682`). So this
 * is not a gate and cannot stop a spell: it applies to damage that has already been decided to
 * land. `DESIGN-spell-memory.md` §6's layer 9, arriving.
 *
 * **It multiplies, and it is alone.** `dam_mod_type::More` folds in as `moreMod *= (1 + mod)`
 * (`fight.c:4676`), so this is ×0.8 and not −20 flat; a fresh `damage_mod` is zeroed per predicate
 * (`fight.c:4661`), so the `+=` starts from 0 and cannot self-stack; and a racial innate is granted
 * once, so no victim holds it twice. Nothing else in the table reads generic damage, so today the
 * source's `BOUNDEDF(0.1, moreMod, 2.0)` clamp is unreachable through this row and is not modelled.
 *
 * **Silent, on purpose.** The predicate calls no `act()` — compare its neighbour at `fight.c:3810`,
 * arcane block, which prints three lines for the same job. Mitigation the victim is not told about
 * is the source's choice and ours: nothing in the combat feed announces this.
 *
 * Composes *before* {@link scaleSpellDamage}: the reduction is the source's own, applied to
 * source-scale damage where the source applies it; the pool divisor is ours, and stays last.
 */
export function reduceSpellDamage(damage: number, damageType: SpellDamageType | undefined, raceCode: string | undefined): number {
  if (damageType !== 'generic') return damage;
  if (raceCode === undefined || !MAGICAL_REDUCTION_RACES.has(raceCode.toUpperCase())) return damage;
  return Math.max(1, Math.floor(damage * (1 + MAGICAL_REDUCTION_MOD)));
}

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
