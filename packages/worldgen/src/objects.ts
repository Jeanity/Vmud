/**
 * Reading Duris' `.obj` files — the item catalogue.
 *
 * Phase 15c. 15b built bags, a floor and corpses that hold things, and had nothing to put in any of
 * them: every item in the world was the rolled starter kit in `shared/src/equipment.ts`, which is code
 * rather than data. This is where the world's own 8.4 MB of objects arrives.
 *
 * ## The format, from `read_object` in `db.c` rather than from a wiki
 *
 * ```
 * #<vnum>
 * <keywords>~
 * <short description>~          the item's name, in a sentence
 * <long description>~           the line when it is lying on the ground
 * <action description>~         usually empty
 * <type> <material> <_> <_> <craftsmanship> <_>
 *   <extra_flags> <wear_flags> <extra2_flags> <anti_flags> <anti2_flags>
 * <value0..value7>
 * <weight> <cost> <condition>
 * [<bitvector1..4>]             optional, and only some files carry them
 * E <keyword>~ <description>~   zero or more extra descriptions
 * A <location> <modifier>       zero or more affects
 * ```
 *
 * **The numeric fields flow across line breaks**, because the source reads them with `fscanf(" %d ")`
 * and that skips any whitespace including newlines. Parsing them line-by-line looks like it works —
 * the files are conventionally laid out — and then silently misreads the handful that are not. So the
 * numeric run is tokenised as one stream, exactly as `fscanf` sees it.
 *
 * Three fields in the first row are read and thrown away by the source itself (`obj->size`,
 * `obj->space`, `damres_bonus` are all commented out in `read_object`). They are skipped here by
 * position and not by name, because their *position* is what the format guarantees.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  CRAFT_AVERAGE,
  DURIS_ITEM,
  armourBonusFrom,
  lightFromValues,
  sizeFrom,
  slotForWearFlags,
  stackLimitFor,
  unpackWeaponSpells,
  type ContainerAccepts,
  type ItemTemplate,
  type SpellsProc,
} from '@mygame/shared';

/** One object as the file states it, before any interpretation. */
export interface RawObject {
  readonly vnum: number;
  /** The words it answers to — Duris' own authored list, which is what `isname` is written against. */
  readonly keywords: readonly string[];
  /** Short description: its name in a sentence, colour codes and all. */
  readonly name: string;
  /** Long description: the line when it is lying on the floor. */
  readonly roomLine: string;
  readonly type: number;
  /**
   * `OBJCRAFT_*`, 0–15 with 7 as average. **Read and discarded by Duris itself** — every mechanical
   * use of it in the source is commented out — and set deliberately by the builders on a third of the
   * world. See {@link craftsmanshipBonus} for what it buys here and why that is a divergence.
   */
  readonly craftsmanship: number;
  readonly extraFlags: number;
  readonly wearFlags: number;
  /** `value[0..7]`, whose meaning depends entirely on `type`. */
  readonly values: readonly number[];
  readonly weight: number;
  readonly cost: number;
  /** `A` blocks: what the item modifies while worn. */
  readonly affects: readonly { readonly location: number; readonly modifier: number }[];
}

/**
 * Splits a file into its `#vnum` records.
 *
 * `$` ends the file in Diku convention, and anything after it is a builder's scratch notes.
 */
function records(text: string): { vnum: number; body: string }[] {
  const out: { vnum: number; body: string }[] = [];
  const end = text.indexOf('\n$');
  const usable = end === -1 ? text : text.slice(0, end);
  // Split on a `#` that starts a line and is followed by digits — a `#` mid-description is common.
  const parts = usable.split(/\r?\n(?=#\d)/);
  for (const part of parts) {
    const match = /^#(\d+)/.exec(part.trimStart());
    if (!match) continue;
    out.push({ vnum: Number(match[1]), body: part.slice(part.indexOf('\n') + 1) });
  }
  return out;
}

/**
 * Reads the next tilde-terminated string, returning it and the offset past the terminator.
 *
 * Diku strings end at `~` and may contain newlines. A missing terminator means a corrupt record rather
 * than an empty string, so this reports it as such instead of consuming the rest of the file.
 */
function readString(text: string, from: number): { value: string; next: number } | undefined {
  const tilde = text.indexOf('~', from);
  if (tilde === -1) return undefined;
  return { value: text.slice(from, tilde).trim(), next: tilde + 1 };
}

export function parseObjectRecord(vnum: number, body: string): RawObject | undefined {
  let at = 0;
  const strings: string[] = [];
  // Four strings: keywords, short, long, action.
  for (let i = 0; i < 4; i++) {
    const read = readString(body, at);
    if (!read) return undefined;
    strings.push(read.value);
    at = read.next;
  }

  // Everything up to the first `E`/`A` block is the numeric run. Tokenised as one stream because
  // `fscanf` does not care where the line breaks fall.
  const rest = body.slice(at);
  const stop = /^[ \t]*[EA](?:[ \t]|$)/m.exec(rest);
  const numericText = stop ? rest.slice(0, stop.index) : rest;
  const numbers = numericText
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map(Number);
  // 11 header + 8 values + 3 tail. The optional bitvectors follow and are not read: nothing in this
  // game consumes an affect bitvector yet, and reading a field no code uses is how this project
  // ended up with mechanisms that were tested and never called.
  if (numbers.length < 22 || numbers.some((n) => !Number.isFinite(n))) return undefined;

  const affects: { location: number; modifier: number }[] = [];
  if (stop) {
    const blocks = rest.slice(stop.index);
    // `A <location> <modifier>` on its own line. `E` blocks are extra descriptions — flavour text for
    // `look <keyword>`, which is Track V's, so they are skipped rather than carried.
    for (const match of blocks.matchAll(/^[ \t]*A[ \t]*\r?\n?[ \t]*(-?\d+)[ \t]+(-?\d+)/gm)) {
      affects.push({ location: Number(match[1]), modifier: Number(match[2]) });
    }
  }

  return {
    vnum,
    keywords: strings[0]!.toLowerCase().split(/\s+/).filter((w) => w.length > 0),
    name: strings[1]!,
    roomLine: strings[2]!,
    type: numbers[0]!,
    // Position 1 is **material** and is deliberately not carried: `common.c`'s `materials[]` makes it
    // a damage-resistance row, and this game has no damage types to resist. `craftsmanshipBonus` has
    // the argument. Positions 2, 3 and 5 are read and thrown away by the source itself. Everything
    // here is taken by *position*, which is what the format guarantees.
    craftsmanship: numbers[4]!,
    extraFlags: numbers[6]!,
    wearFlags: numbers[7]!,
    values: numbers.slice(11, 19),
    weight: numbers[19]!,
    cost: numbers[20]!,
    affects,
  };
}

export function parseObjectFile(path: string): RawObject[] {
  // `latin1`, like every other Duris reader here: the files carry high-bit bytes inside colour runs and
  // decoding them as UTF-8 replaces those bytes with U+FFFD.
  const text = readFileSync(path, 'latin1');
  const out: RawObject[] = [];
  for (const record of records(text)) {
    const parsed = parseObjectRecord(record.vnum, record.body);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Every object in the directory, **last file wins on a duplicate vnum**.
 *
 * Duplicates are real: several `.obj` files are older copies of a zone kept beside the live one. The
 * `.wld` match already picks which file a zone's *rooms* come from, and objects are joined by vnum
 * rather than by file, so a stable rule is what matters more than which side of it wins.
 */
export function loadObjects(dir: string): Map<number, RawObject> {
  const byVnum = new Map<number, RawObject>();
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.obj')) continue;
    for (const object of parseObjectFile(join(dir, file))) byVnum.set(object.vnum, object);
  }
  return byVnum;
}

/* -------------------------------------------------------------------------- */
/* Raw object → catalogue entry                                                */
/* -------------------------------------------------------------------------- */


/**
 * Charges in one item, or nothing for something use does not consume.
 *
 * Diku keeps a wand's maximum charges in `value[1]` and its remaining ones in `value[2]`. The
 * **maximum** is the template's business; how many are left is the instance's, which is exactly the
 * type/instance split §8 asks for and the reason this returns one number rather than two.
 */
function usesFor(type: number, values: readonly number[]): number | undefined {
  if (type === DURIS_ITEM.wand || type === DURIS_ITEM.staff) return Math.max(1, values[1] ?? 1);
  if (type === DURIS_ITEM.scroll || type === DURIS_ITEM.potion) return 1;
  return undefined;
}

/** What a container takes. A quiver holds missiles; a scabbard holds weapons; a sack holds anything. */
function containerRule(type: number, values: readonly number[]): { capacity: number; accepts: ContainerAccepts } | undefined {
  const accepts: ContainerAccepts | undefined =
    type === DURIS_ITEM.quiver ? 'missile'
    : type === DURIS_ITEM.scabbard ? 'weapon'
    : type === DURIS_ITEM.container || type === DURIS_ITEM.storage ? 'any'
    : undefined;
  if (!accepts) return undefined;
  // Duris' capacity is in its own weight units, so it goes through the same conversion an item's bulk
  // does — otherwise a 200-capacity quiver and a 200-weight anvil would be on different scales while
  // looking like the same number. Floored at one so a mis-authored container is small, not useless.
  return { capacity: Math.max(1, Math.round(values[0] ?? 0) / 5), accepts };
}

/**
 * Turns one parsed object into a catalogue entry, or nothing if it is not something we can hold.
 *
 * Two refusals, and both are the source's own judgement rather than ours:
 *
 * - **`ITEM_TAKE` must be set.** `read_object` guarantees take and hold travel together, and an object
 *   without it is scenery — a wall of force, a ship, a switch — that a player was never meant to pick
 *   up. Dropping them here is what keeps 20,079 records from turning into 20,079 things on the floor.
 * - **A corpse type is refused outright.** `ITEM_CORPSE` is marked "internal use only, do NOT assign
 *   this type" in `defines.h`, and we have a corpse of our own.
 */
export function toTemplate(raw: RawObject): ItemTemplate | undefined {
  const ITEM_TAKE = 1 << 0;
  const ITEM_CORPSE = 24;
  if (raw.type === ITEM_CORPSE) return undefined;
  if ((raw.wearFlags & ITEM_TAKE) === 0) return undefined;

  // **One table, in `items.ts`.** This file used to hold its own copy of the wear-bit order, and it
  // went stale the moment the slot list grew — see `slotForWearFlags`.
  const slot = slotForWearFlags(raw.wearFlags);

  // Armour value lives in `value[0]`, and `read_object` itself demotes an armour with none to
  // `ITEM_WORN` — so reading it off the type rather than off the value would credit clothing with
  // protection it does not have.
  const ac = raw.type === DURIS_ITEM.armor || raw.type === DURIS_ITEM.shield
    ? armourBonusFrom(raw.values[0] ?? 0, raw.craftsmanship)
    : 0;

  // `dice(value[1], value[2])` — `fight.c`'s own expression, verbatim. Taken unscaled, unlike armour:
  // 14b proved our combat scale *against* these numbers, so a 2d6 sword is what it already expects.
  const light = lightFromValues(raw.type, raw.values);

  const isWeapon = raw.type === DURIS_ITEM.weapon;
  const count = raw.values[1] ?? 0;
  const sides = raw.values[2] ?? 0;
  const damage = isWeapon && count > 0 && sides > 0 ? { count, sides, bonus: 0 } : undefined;

  // **Two-handed, and the test is Duris' own disjunction rather than the flag alone.** `actobj.c`:
  //
  // ```c
  // hands_needed = (IS_SET(obj->extra_flags, ITEM_TWOHANDS) || obj->value[0] == WEAPON_2HANDSWORD) ? 2 : 1;
  // ```
  //
  // Reading only the flag would be plausible and wrong: measured over the 2,841 weapons in the
  // catalogue, **535 carry `ITEM_TWOHANDS` and 223 are weapon class 13, but only 201 are both** — so
  // twenty-two two-handed swords are two-handed by class with no flag on them, and the flag alone
  // misses every one. `ITEM_TWOHANDS` is `BIT_23` of **`extra_flags`**, not of `wear_flags`, where the
  // same bit is `ITEM_WEAR_BACK` — reading the wrong field would make every backpack a greatsword.
  const ITEM_TWOHANDS = 1 << 22;
  const WEAPON_2HANDSWORD = 13;
  const twoHanded =
    isWeapon && ((raw.extraFlags & ITEM_TWOHANDS) !== 0 || raw.values[0] === WEAPON_2HANDSWORD);

  const container = containerRule(raw.type, raw.values);
  const uses = usesFor(raw.type, raw.values);

  // **Duris' gear-side power curve, which was parsed and then dropped on the floor.** The `A <location>
  // <modifier>` blocks have been read into `raw.affects` since the harvest landed and nothing carried
  // them, so a level-40 sword was better than a level-10 one only by its dice. Measured across the
  // 20,079 objects: `APPLY_HITROLL` on 3,207, `APPLY_DAMROLL` on 3,187 (median +2, p90 +4, max +100).
  //
  // Summed rather than taken once, because an object may carry the same apply twice, and **negatives are
  // kept**: cursed gear is a real category in this world and a sword that costs you accuracy is content.
  //
  // `APPLY_HIT` (2,458 objects, median +15) is deliberately *not* carried. Maximum hit points are rolled
  // once and stored per §3, and letting a hat change them would mean deciding what happens to a wounded
  // character who takes it off — a real question, and not this phase's.
  const APPLY_HITROLL = 18;
  const APPLY_DAMROLL = 19;
  let hitroll = 0;
  let damroll = 0;
  for (const affect of raw.affects) {
    if (affect.location === APPLY_HITROLL) hitroll += affect.modifier;
    if (affect.location === APPLY_DAMROLL) damroll += affect.modifier;
  }

  return {
    vnum: raw.vnum,
    keywords: raw.keywords,
    name: raw.name,
    roomLine: raw.roomLine,
    type: raw.type,
    ...(slot ? { slot } : {}),
    ac,
    // Absent at average, which is two thirds of the world: carrying `7` on 14,322 entries would be
    // three hundred kilobytes of JSON saying "nothing unusual here".
    ...(raw.craftsmanship === CRAFT_AVERAGE ? {} : { craftsmanship: raw.craftsmanship }),
    // Phase 16. `value[2]` is the burn in Duris' own hours; the radius is ours, because Diku light is
    // a boolean and has none to transcribe.
    ...(light ? { light } : {}),
    ...(damage ? { damage } : {}),
    ...(twoHanded ? { twoHanded: true as const } : {}),
    // **Phase 19, and the field this file has been reading and discarding since the harvest landed.**
    // `values[0]` is the weapon class (`objmisc.h:362`, 1-20) and it is what decides which skill a
    // swing trains — `weaponSkillFor` in `skills.ts` is the reader, in the same commit, which is the
    // rule a new field on `ItemTemplate` is allowed to exist under.
    //
    // Weapons only, and **absent for class 0**: 6 of the 2,841 carry no class, and the source's own
    // mapping gives those no skill rather than a wrong one. Writing a `0` here would put a number on
    // 13,580 non-weapons to say nothing.
    ...(isWeapon && (raw.values[0] ?? 0) > 0 ? { weaponClass: raw.values[0] } : {}),
    ...(hitroll === 0 ? {} : { hitroll }),
    ...(damroll === 0 ? {} : { damroll }),
    size: sizeFrom(raw.weight),
    cost: Math.max(0, raw.cost),
    stackLimit: stackLimitFor(raw.type),
    ...(uses === undefined ? {} : { uses }),
    ...(container ? { container } : {}),
    // A money pile carries its worth across all four of `value[0..3]` — copper, silver, gold,
    // platinum, in that order per `utils.h`. Zeroes are dropped so a purse of pure gold does not
    // record three empty currencies.
    ...(raw.type === DURIS_ITEM.money ? { coins: coinsFrom(raw.values) } : {}),
    // Phase 20 slice 4. A scroll's stored level and up to three spell numbers, exactly the fields
    // `do_recite` reads (`actoth.c:4234`: `value[0]` as the cast level, `value[1..3]` as spells,
    // a slot `< 1` skipped). Numbers kept raw — the source's vocabulary, `spells.ts` translates.
    ...(raw.type === DURIS_ITEM.scroll ? { scroll: scrollFrom(raw.values) } : {}),
    // And a potion is a scroll you drink: the identical value layout (`do_quaff`, `actoth.c:4145`),
    // so the identical reader — only the field name and the drinking rules differ, and those are
    // the server's.
    ...(raw.type === DURIS_ITEM.potion ? { potion: scrollFrom(raw.values) } : {}),
    // Weapon procs, the data path — `weapon_proc` reads exactly these (`fight.c:7764-7858`):
    // `value[7]` the 1-in-N odds, `value[6]` the cast level, `value[5]` the packed spell numbers.
    // 210 weapons carry it. `value[4]`'s one-shot poison is dropped and named: no poison yet.
    ...(isWeapon && procFrom(raw.values) ? { proc: procFrom(raw.values)! } : {}),
    // And a meal: fullness hours, the two regeneration multipliers, and the poison flag — exactly
    // the four values `do_eat` reads (`actobj.c:3327-3346`), raw as ever.
    ...(raw.type === DURIS_ITEM.food ? { food: foodFrom(raw.values) } : {}),
  };
}

/** A meal's worth, off its values — negative fullness is the stale-food marker, floored to zero. */
function foodFrom(values: readonly number[]): { hours: number; hpBoost: number; moveBoost: number; poison: number } {
  return {
    hours: Math.max(0, Math.floor(values[0] ?? 0)),
    hpBoost: Math.max(0, Math.floor(values[1] ?? 0)),
    moveBoost: Math.max(0, Math.floor(values[2] ?? 0)),
    poison: Math.max(0, Math.floor(values[3] ?? 0)),
  };
}

/** The data-path proc off a weapon's values, or nothing — most weapons are only what they hit with. */
function procFrom(values: readonly number[]): SpellsProc | undefined {
  const oneIn = Math.floor(values[7] ?? 0);
  const packed = Math.floor(values[5] ?? 0);
  if (oneIn <= 0 || packed <= 0) return undefined;
  const { spells, pickOne } = unpackWeaponSpells(packed);
  if (spells.length === 0) return undefined;
  return {
    t: 'spells',
    oneIn,
    level: Math.max(1, Math.floor(values[6] ?? 1)),
    spells,
    ...(pickOne ? { pickOne: true as const } : {}),
  };
}

/** A scroll's recitation, off its values. Duplicates kept — a slot is a casting, not a set. */
function scrollFrom(values: readonly number[]): { level: number; spells: number[] } {
  return {
    level: Math.max(1, Math.floor(values[0] ?? 1)),
    spells: [values[1], values[2], values[3]].filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1),
  };
}

/**
 * A money pile's worth, by coin.
 *
 * The order is `utils.h`'s and not guessable: `GET_COPPER` is `cash[0]` and `GET_PLATINUM` is
 * `cash[3]`, and `actobj.c` pours `value[0..3]` into them in exactly that order.
 */
function coinsFrom(values: readonly number[]): Record<string, number> {
  const kinds = ['copper', 'silver', 'gold', 'platinum'] as const;
  const out: Record<string, number> = {};
  kinds.forEach((kind, i) => {
    const n = values[i] ?? 0;
    if (n > 0) out[kind] = Math.floor(n);
  });
  return out;
}

/** The whole catalogue, as the game will read it. */
export function buildCatalogue(dir: string): ItemTemplate[] {
  const out: ItemTemplate[] = [];
  for (const raw of loadObjects(dir).values()) {
    const template = toTemplate(raw);
    if (template) out.push(template);
  }
  return out.sort((a, b) => a.vnum - b.vnum);
}
