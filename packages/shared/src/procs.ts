/**
 * Weapon procs — the blade that acts on its own. Owner's ask (2026-08-07), from Sojourn memory:
 * *"when a weapon procced … the elven sword named windsong would do an extra 2-4 slashes that round
 * with a special text … and it could proc on a proc."*
 *
 * Duris ships **two mechanisms under one dispatch** (`weapon_proc`, `fight.c:7764-7858`), and both
 * are here:
 *
 * 1. **The data path** — a weapon's own `.obj` record carries the whole proc in `value[5..7]`:
 *    `value[7]` is a 1-in-N chance per landed hit, `value[5]` packs up to three spell numbers in
 *    decimal thousands (a tenth digit means *cast one of them at random* instead of all), and
 *    `value[6]` is the casting level. Aggressive spells strike the victim; the rest buff the
 *    wielder. **This is harvestable** — 210 of the catalogue's 2,841 weapons carry it — and it
 *    rides the exact machinery Phase 20 built: each spell goes through `deliverSpell`, so the forge
 *    hammer of Urtengor's earthquake is the same earthquake a scroll recites. Spell numbers are
 *    kept raw (the scroll rule): a weapon whose spell the registry does not know yet is inert and
 *    starts firing the day its spell lands.
 *
 * 2. **The special path** — bespoke procs that were C functions bound to vnums in the source
 *    (`specs.assign.c:1266`), which no harvest can produce. Ours is a registry of ids, and its
 *    first entry is **Windsong itself**, authored from the owner's memory rather than transcribed —
 *    Sojourn's source was never released, so the memory is the primary source and is recorded as
 *    such.
 */

import { randomInt, type Rng } from './rules.ts';

/* -------------------------------------------------------------------------- */
/* The shapes                                                                  */
/* -------------------------------------------------------------------------- */

/** The harvested data path: `value[5..7]`, unpacked at harvest time, numbers kept raw. */
export interface SpellsProc {
  readonly t: 'spells';
  /** 1-in-N per landed hit — `value[7]`, the source's own odds field. */
  readonly oneIn: number;
  /** The level every spell casts at — `value[6]`. */
  readonly level: number;
  /** Raw Duris spell numbers, up to three — unpacked from `value[5]`'s decimal thousands. */
  readonly spells: readonly number[];
  /** The tenth-digit flag: cast ONE of the set at random rather than all of them. */
  readonly pickOne?: true;
}

/** The bespoke path: an id into {@link SPECIAL_PROCS}, because the behaviour is code. */
export interface SpecialProcRef {
  readonly t: 'special';
  readonly id: SpecialProcId;
}

export type WeaponProc = SpellsProc | SpecialProcRef;

/* -------------------------------------------------------------------------- */
/* The special registry                                                        */
/* -------------------------------------------------------------------------- */

export const SPECIAL_PROC_IDS = ['windsong'] as const;
export type SpecialProcId = (typeof SPECIAL_PROC_IDS)[number];

/**
 * What a special proc does: extra blows this round, with its own prose. The one kind the first
 * slice ships — the *blade-takes-over* family the owner remembers — with the fields later kinds
 * (riposte wards, on-hit drains) will sit beside rather than inside.
 */
export interface SpecialProc {
  readonly id: SpecialProcId;
  /** 1-in-N per landed hit, the data path's own odds convention. */
  readonly oneIn: number;
  /** Extra blows when it fires, rolled inclusive. */
  readonly blows: { readonly min: number; readonly max: number };
  /**
   * Whether the extra blows may themselves proc — the owner's *"it could proc on a proc"*, which is
   * the source's own behaviour (its extra hits re-entered `hit()` and so re-reached `weapon_proc`;
   * its only limiter, `CheckMultiProcTiming`, ships disabled). The executor still carries a hard
   * depth cap, because a bug that makes a sword swing forever should be impossible, not unlikely.
   */
  readonly recurses: boolean;
  /** The wielder's own line. `$p` is the weapon's name. */
  readonly self: string;
  /** The room's line. `$n` is the wielder, `$p` the weapon. */
  readonly room: string;
}

export const SPECIAL_PROCS: Readonly<Record<SpecialProcId, SpecialProc>> = {
  /**
   * The owner's blade, from memory (2026-08-07): an elven scimitar; 2–4 extra slashes; prose in the
   * spirit of *"Your elven blade started glowing and seems to take over and slashes repeatedly"*;
   * proc-on-proc allowed. The odds are ours — memory recorded feel, not numbers — chosen so a fight
   * of ten rounds usually shows it once.
   */
  windsong: {
    id: 'windsong',
    oneIn: 8,
    blows: { min: 2, max: 4 },
    recurses: true,
    self: '&+WYour elven blade glows &+Cbrilliantly&+W and seems to take over, slashing repeatedly!&N',
    room: '&+W$n&N&+W\'s elven blade glows &+Cbrilliantly&+W and slashes repeatedly of its own accord!&N',
  },
};

export function isSpecialProcId(value: string): value is SpecialProcId {
  return Object.hasOwn(SPECIAL_PROCS, value);
}

/** The executor's belt: proc-on-proc is the mechanic, a sword that swings forever is a bug. */
export const PROC_DEPTH_CAP = 8;

/* -------------------------------------------------------------------------- */
/* The rolls and the unpacking                                                 */
/* -------------------------------------------------------------------------- */

/** The source's own odds idiom: `!number(0, N-1)` — one face of an N-sided die. */
export function rollProc(rng: Rng, oneIn: number): boolean {
  if (oneIn <= 1) return true;
  return randomInt(rng, 1, Math.floor(oneIn)) === 1;
}

/** How many blows a special proc throws this firing. */
export function rollProcBlows(rng: Rng, proc: SpecialProc): number {
  return randomInt(rng, proc.blows.min, proc.blows.max);
}

/**
 * `value[5]`'s decimal-thousands unpacking, transcribed digit for digit (`fight.c:7808-7826`):
 * three spell numbers in the low nine digits, and anything above them the *pick one* flag. Zero
 * slots are dropped exactly as the source's `if (spells[i] >= 1)` drops them.
 */
export function unpackWeaponSpells(value5: number): { readonly spells: number[]; readonly pickOne: boolean } {
  const v = Math.max(0, Math.floor(value5));
  const spells = [v % 1000, Math.floor((v % 1_000_000) / 1000), Math.floor((v % 1_000_000_000) / 1_000_000)].filter(
    (n) => n >= 1,
  );
  return { spells, pickOne: v > 999_999_999 };
}
