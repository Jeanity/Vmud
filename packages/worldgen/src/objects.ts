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
  DURIS_ITEM,
  armourBonusFrom,
  sizeFrom,
  slotForWearPosition,
  type ContainerAccepts,
  type ItemTemplate,
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
    // Positions 1–5 are material, two fields the source itself discards, craftsmanship and another
    // discarded one. Skipped by position, which is what the format guarantees.
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
 * `ITEM_WEAR_*` bits, in the order a wear slot is picked. Mirrors `WEAR_BITS` in `shared/src/items.ts`
 * and is deliberately a **separate list**: this one is the file's vocabulary and that one is the game's,
 * and collapsing them would put the harvest's assumptions inside the rules module.
 */
const WEAR_BIT_ORDER: readonly (readonly [number, ReturnType<typeof slotForWearPosition>])[] = [
  [1 << 13, slotForWearPosition(16)], // ITEM_WIELD → mainHand
  [1 << 3, slotForWearPosition(5)], // BODY → chest
  [1 << 4, slotForWearPosition(6)], // HEAD
  [1 << 5, slotForWearPosition(7)], // LEGS
  [1 << 6, slotForWearPosition(8)], // FEET
  [1 << 7, slotForWearPosition(9)], // HANDS
  [1 << 9, slotForWearPosition(11)], // SHIELD → offHand
  [1 << 2, slotForWearPosition(3)], // NECK
  [1 << 22, slotForWearPosition(27)], // BACK
  [1 << 1, slotForWearPosition(1)], // FINGER → ring1
  [1 << 14, slotForWearPosition(18)], // ITEM_HOLD → offHand, last
];

/** How many of a thing share one slot, by type. `DESIGN-inventory.md` §3. */
function stackLimitFor(type: number): number {
  // Arrows are the doc's own worked example, at 20 to a slot. Coins and small consumables stack too;
  // a sword does not, because two swords are two swords.
  if (type === DURIS_ITEM.missile) return 20;
  if (type === DURIS_ITEM.potion || type === DURIS_ITEM.scroll || type === DURIS_ITEM.food) return 5;
  return 1;
}

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

  let slot: ReturnType<typeof slotForWearPosition>;
  for (const [bit, candidate] of WEAR_BIT_ORDER) {
    if (candidate && (raw.wearFlags & bit) !== 0) {
      slot = candidate;
      break;
    }
  }

  // Armour value lives in `value[0]`, and `read_object` itself demotes an armour with none to
  // `ITEM_WORN` — so reading it off the type rather than off the value would credit clothing with
  // protection it does not have.
  const ac = raw.type === DURIS_ITEM.armor || raw.type === DURIS_ITEM.shield
    ? armourBonusFrom(raw.values[0] ?? 0)
    : 0;

  // `dice(value[1], value[2])` — `fight.c`'s own expression, verbatim. Taken unscaled, unlike armour:
  // 14b proved our combat scale *against* these numbers, so a 2d6 sword is what it already expects.
  const isWeapon = raw.type === DURIS_ITEM.weapon;
  const count = raw.values[1] ?? 0;
  const sides = raw.values[2] ?? 0;
  const damage = isWeapon && count > 0 && sides > 0 ? { count, sides, bonus: 0 } : undefined;

  const container = containerRule(raw.type, raw.values);
  const uses = usesFor(raw.type, raw.values);

  return {
    vnum: raw.vnum,
    keywords: raw.keywords,
    name: raw.name,
    roomLine: raw.roomLine,
    type: raw.type,
    ...(slot ? { slot } : {}),
    ac,
    ...(damage ? { damage } : {}),
    size: sizeFrom(raw.weight),
    cost: Math.max(0, raw.cost),
    stackLimit: stackLimitFor(raw.type),
    ...(uses === undefined ? {} : { uses }),
    ...(container ? { container } : {}),
    // `value[0]` on a money pile is the number of coins. It is the one type whose worth is its
    // quantity rather than its price.
    ...(raw.type === DURIS_ITEM.money ? { coins: Math.max(0, raw.values[0] ?? 0) } : {}),
  };
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
