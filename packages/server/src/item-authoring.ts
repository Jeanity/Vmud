/**
 * Items that were **made here** — the second half of A6, and a different animal to the first.
 *
 * `item-overrides.ts` patches the harvest: a handful of changed fields keyed by vnum, folded over a
 * template that already exists. That shape is exactly right for editing a Duris item and exactly wrong
 * for inventing one, because a patch presupposes something to patch. An item with no `.obj` file behind
 * it *is* its record, and the two differ in every rule that matters:
 *
 * | | `item-overrides.ts` | here |
 * | --- | --- | --- |
 * | Shape | a few optional fields | a complete {@link ItemTemplate} |
 * | Composed by | folding over a pristine template | being added to the catalogue |
 * | Empty entry means | *nothing is authored* — delete it, take the ✎ off | nothing; the item stays |
 * | Re-harvest | flows through wherever it was not authored | cannot touch it at all |
 *
 * Those last two are why this is a separate file rather than a range check inside the other one. A
 * partial override that authors nothing **must** be deleted or the item wears an editor's mark for
 * ever; a created item whose name is blanked is a bug, not a request to delete the item. One structure
 * cannot hold two opposite lifecycle rules without somebody eventually applying the wrong one.
 *
 * ## The vnum is the whole safety argument
 *
 * See {@link AUTHORED_VNUM_BASE}. Every created item is numbered at nine million or above, which no
 * Duris object reaches — the harvest's highest is 700,008 — so `npm run worldgen` can be re-run for
 * ever without a created item and a harvested one ever contending for the same key. Nothing else in
 * this file would survive a collision: vnum is the join between the catalogue, every `G`/`E`/`P` reset,
 * every saved bag and every override.
 *
 * ## Validated, never trusted
 *
 * The file is hand-editable by design, like its siblings, so a malformed record is dropped rather than
 * guessed at. A template that reaches the catalogue half-built fails three systems away — an item with
 * a `NaN` size makes the bag maths `NaN` and the failure surfaces as a player who cannot pick anything
 * up. {@link readAuthoredItem} is the only door in.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_VNUM_BASE,
  CONTAINER_ACCEPTS,
  DURIS_ITEM_TYPES,
  EQUIP_SLOTS,
  MAX_ITEM_SIZE,
  stackLimitFor,
  type ContainerAccepts,
  type ContainerRule,
  type EquipSlot,
  type ItemTemplate,
} from '@mygame/shared';

import { readDice } from './item-overrides.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where created items live — beside `rooms.json` and `items.json`, and exported for the same reason. */
export const AUTHORED_ITEMS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'items-authored.json');

/** A created item, plus the provenance every overlay in this project records. */
export interface AuthoredItem {
  readonly item: ItemTemplate;
  /** When it was last written, so the panel can say how stale it is. */
  readonly at?: string;
  /** Who or what wrote it. */
  readonly by?: string;
}

export type AuthoredItems = Map<number, AuthoredItem>;

/**
 * The overlay as a whole: the records, and the number to hand out next.
 *
 * **The counter is stored rather than derived, and a test is the reason.** "Highest existing plus one"
 * looks like it never repeats until you delete the highest item, at which point the next creation gets
 * the number that was just freed — and a vnum is an identity. The moment A4 puts an authored item into
 * a spawn overlay, a recycled number silently changes what a zone spawns, which is precisely the class
 * of bug this project keeps paying for. Persisting the high-water mark makes the guarantee real.
 */
export interface AuthoredStore {
  readonly items: AuthoredItems;
  /** The next vnum to allocate. Only ever increases, including across a delete. */
  next: number;
}

/**
 * The fields a form must supply, before defaults. Everything else is derived or optional.
 *
 * Deliberately **not** `Partial<ItemTemplate>`: `vnum` is the server's to allocate and `stackLimit` is
 * §3's rule about the type rather than a number anybody should be typing. Letting a form post either
 * would be letting it post the two things it has no business deciding.
 */
export interface ItemDraft {
  readonly name?: unknown;
  readonly keywords?: unknown;
  readonly roomLine?: unknown;
  readonly type?: unknown;
  readonly slot?: unknown;
  readonly ac?: unknown;
  readonly damage?: unknown;
  readonly twoHanded?: unknown;
  readonly hitroll?: unknown;
  readonly damroll?: unknown;
  readonly size?: unknown;
  readonly cost?: unknown;
  readonly uses?: unknown;
  readonly container?: unknown;
}

/** A whole number in range, or nothing. The shape every numeric field here is checked against. */
function readInt(raw: unknown, low: number, high: number): number | undefined {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < low || raw > high) return undefined;
  return raw;
}

/**
 * The words a player may type for it, deduplicated and folded to lower case.
 *
 * Deduplicated **because the panel diffs against what the server stored** — the same lesson A6's editor
 * learned: store what you canonicalise, or an entry equal to its own input looks like a change for ever.
 */
function readKeywords(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words = [
    ...new Set(
      (raw as unknown[])
        .filter((w): w is string => typeof w === 'string')
        .map((w) => w.trim().toLowerCase())
        .filter((w) => w.length > 0),
    ),
  ];
  return words.length > 0 ? words : undefined;
}

function readContainer(raw: unknown): ContainerRule | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rule = raw as Record<string, unknown>;
  const capacity = readInt(rule.capacity, 1, 1000);
  if (capacity === undefined) return undefined;
  const accepts = CONTAINER_ACCEPTS.includes(rule.accepts as ContainerAccepts)
    ? (rule.accepts as ContainerAccepts)
    : 'any';
  return { capacity, accepts };
}

/**
 * A draft turned into a complete template, or the reason it cannot be.
 *
 * Returns the *reason* rather than a bare `undefined` because this is the one validator whose failure a
 * person reads: it answers a form POST, and "refused" with no cause is the difference between an editor
 * somebody can use and one they file a bug about.
 *
 * **Defaults are applied here and nowhere else**, so a record on disk is always whole and every reader
 * downstream can treat it as such. `roomLine` falls back to the name in Duris' own idiom, and
 * `stackLimit` comes from `stackLimitFor` rather than from the caller — two arrows of one vnum
 * disagreeing about sharing a slot is the bug §3 exists to prevent.
 */
export function draftAuthoredItem(vnum: number, draft: ItemDraft): { item: ItemTemplate } | { error: string } {
  if (!Number.isInteger(vnum) || vnum < AUTHORED_VNUM_BASE) {
    return { error: `an authored vnum must be an integer at or above ${AUTHORED_VNUM_BASE}` };
  }

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) return { error: 'name is required' };

  const keywords = readKeywords(draft.keywords);
  if (!keywords) return { error: 'at least one keyword is required — it is what a player types' };

  const type = readInt(draft.type, 0, 1000);
  if (type === undefined || !DURIS_ITEM_TYPES.includes(type)) {
    return { error: 'type must be one of the catalogue types' };
  }

  // A slot is optional — plenty of real items are carried and never worn — but a *named* slot has to be
  // one we model, or `wear` would accept it and the paper doll would have nowhere to draw it.
  let slot: EquipSlot | undefined;
  if (draft.slot !== undefined && draft.slot !== null && draft.slot !== '') {
    if (!EQUIP_SLOTS.includes(draft.slot as EquipSlot)) return { error: `no such slot: ${String(draft.slot)}` };
    slot = draft.slot as EquipSlot;
  }

  const ac = draft.ac === undefined || draft.ac === null ? 0 : readInt(draft.ac, 0, 50);
  if (ac === undefined) return { error: 'armour class must be a whole number from 0 to 50' };

  const size = draft.size === undefined || draft.size === null ? 1 : readInt(draft.size, 1, MAX_ITEM_SIZE);
  if (size === undefined) return { error: `size must be a whole number from 1 to ${MAX_ITEM_SIZE}` };

  const cost = draft.cost === undefined || draft.cost === null ? 0 : readInt(draft.cost, 0, 100_000_000);
  if (cost === undefined) return { error: 'cost must be a whole number of coins, zero or more' };

  // Dice are optional, but a *malformed* triple is refused rather than dropped: a weapon silently
  // arriving with no damage is the kind of thing nobody notices until a fight reads wrong.
  let damage;
  if (draft.damage !== undefined && draft.damage !== null) {
    damage = readDice(draft.damage);
    if (!damage) return { error: 'damage must be whole dice — a count, sides, and a bonus' };
  }

  const hitroll = draft.hitroll === undefined || draft.hitroll === null ? undefined : readInt(draft.hitroll, -1000, 1000);
  if (draft.hitroll !== undefined && draft.hitroll !== null && hitroll === undefined) {
    return { error: 'hitroll must be a whole number' };
  }
  const damroll = draft.damroll === undefined || draft.damroll === null ? undefined : readInt(draft.damroll, -1000, 1000);
  if (draft.damroll !== undefined && draft.damroll !== null && damroll === undefined) {
    return { error: 'damroll must be a whole number' };
  }

  const uses = draft.uses === undefined || draft.uses === null ? undefined : readInt(draft.uses, 1, 1000);
  if (draft.uses !== undefined && draft.uses !== null && uses === undefined) {
    return { error: 'uses must be a whole number of charges, one or more' };
  }

  let container: ContainerRule | undefined;
  if (draft.container !== undefined && draft.container !== null) {
    container = readContainer(draft.container);
    if (!container) return { error: 'a container needs a capacity of at least one slot' };
  }

  const roomLine = typeof draft.roomLine === 'string' && draft.roomLine.trim()
    ? draft.roomLine.trim()
    : `${name} is lying here.`;

  return {
    item: {
      vnum,
      keywords,
      name,
      roomLine,
      type,
      ac,
      size,
      cost,
      stackLimit: stackLimitFor(type),
      ...(slot ? { slot } : {}),
      ...(damage ? { damage } : {}),
      ...(draft.twoHanded === true ? { twoHanded: true as const } : {}),
      ...(hitroll ? { hitroll } : {}),
      ...(damroll ? { damroll } : {}),
      ...(uses !== undefined ? { uses } : {}),
      ...(container ? { container } : {}),
    },
  };
}

/**
 * One record off disk, or nothing.
 *
 * Runs the same {@link draftAuthoredItem} the API does rather than a second, laxer reader — a file
 * somebody edited by hand deserves exactly the validation a form POST gets, and two validators for one
 * shape is how a field ends up legal through one door and not the other.
 */
export function readAuthoredItem(vnum: number, raw: unknown): AuthoredItem | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const drafted = draftAuthoredItem(vnum, record as ItemDraft);
  if ('error' in drafted) return undefined;
  return {
    item: drafted.item,
    ...(typeof record.at === 'string' ? { at: record.at } : {}),
    ...(typeof record.by === 'string' ? { by: record.by } : {}),
  };
}

/**
 * Reads the overlay, tolerating anything. The same posture as the room and item override loaders.
 *
 * The stored counter is trusted only so far as it is *ahead* of the records: a hand-edited file whose
 * `next` is behind an item it contains would hand out a number already in use, so the floor is raised
 * to clear whatever is actually there. Wrong in the safe direction, which is the only direction a
 * number allocator may be wrong in.
 */
export function loadAuthoredStore(file = AUTHORED_ITEMS_FILE): AuthoredStore {
  const items: AuthoredItems = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been created yet.
    return { items, next: AUTHORED_VNUM_BASE };
  }
  if (typeof raw !== 'object' || raw === null) return { items, next: AUTHORED_VNUM_BASE };
  const file_ = raw as Record<string, unknown>;

  const records = typeof file_.items === 'object' && file_.items !== null ? (file_.items as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(records)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum)) continue;
    const authored = readAuthoredItem(vnum, value);
    if (authored) items.set(vnum, authored);
  }

  let next = typeof file_.next === 'number' && Number.isInteger(file_.next) ? file_.next : AUTHORED_VNUM_BASE;
  for (const vnum of items.keys()) if (vnum >= next) next = vnum + 1;
  return { items, next: Math.max(next, AUTHORED_VNUM_BASE) };
}

/**
 * Writes the whole overlay: the counter, then the records sorted by vnum.
 *
 * Each record is flat rather than `{ item: {...}, at }` — the file is meant to be readable and
 * hand-editable and a second level of nesting per entry buys nothing a reader wants. `vnum` is written
 * into the body as well as being the key, redundant on purpose, so a record copied out on its own still
 * says which item it is.
 */
export function saveAuthoredStore(store: AuthoredStore, file = AUTHORED_ITEMS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const records: Record<string, unknown> = {};
  for (const vnum of [...store.items.keys()].sort((a, b) => a - b)) {
    const authored = store.items.get(vnum)!;
    records[String(vnum)] = {
      ...authored.item,
      ...(authored.at ? { at: authored.at } : {}),
      ...(authored.by ? { by: authored.by } : {}),
    };
  }
  writeFileSync(file, `${JSON.stringify({ next: store.next, items: records }, null, 2)}\n`);
}

/**
 * Takes the next number, and advances the counter past it.
 *
 * Mutates deliberately: allocation and recording that the allocation happened must not be separable, or
 * a caller that forgets the second half hands the same number out twice.
 */
export function takeAuthoredVnum(store: AuthoredStore): number {
  const vnum = Math.max(store.next, AUTHORED_VNUM_BASE);
  store.next = vnum + 1;
  return vnum;
}
