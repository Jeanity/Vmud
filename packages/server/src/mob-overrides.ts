/**
 * Authored mobs — the overlay the panel writes over the harvested templates. **A4c.**
 *
 * Owner's ask, 2026-08-04: *"assign items to mobs as loot."* A4 built the live half — spawn one,
 * watch it, slay it and see what its corpse holds — and this is the authoring half.
 *
 * The same shape `item-overrides.ts` gave items and `overrides.ts` gave rooms, for the same
 * governing rule (`DESIGN-admin-panel.md` §1): **authoring lands as overlay files the game loads**,
 * never as edits to generated data. `data/world/spawns/*.json` is a build output of
 * `npm run worldgen`, so a kit edited there would be undone by the next harvest.
 *
 * ## Per template, and it has to be said out loud
 *
 * A harvested kit does **not** live on the template — it comes from the zone's reset table, where an
 * `E` or a `G` attaches to *the last mobile loaded* (`reset.ts`). So the same vnum placed in two rooms
 * can be carrying two different things, because two different reset commands dressed it.
 *
 * What this file authors is the other thing: loot on the **template**, which every instance of that
 * vnum gets wherever it spawns. That is the useful shape for *"give kobold guards a rusty key"* and it
 * is also the surprising one, so the panel says it in as many words: **authoring this changes every
 * kobold guard the world spawns**, not the one you were looking at.
 *
 * ## Additive, never a replacement
 *
 * Authored loot is applied **on top of** whatever the reset table dressed the mob in. It cannot take a
 * harvested piece away, and that is deliberate: subtraction would mean this overlay had to name things
 * that are not in it, and a re-harvest that changed a zone's `E` list would silently change what the
 * subtraction meant. Adding is a statement that stays true no matter what moves underneath it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EQUIP_SLOTS, type EquipSlot, type Item, type ItemTemplate } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where authored mobs live — beside `rooms.json` and `items.json`, and exported for the same reason. */
export const MOBS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'mobs.json');

/**
 * One thing this mob is authored to have.
 *
 * `slot` decides worn against carried, and it is the **author's** choice rather than the item's:
 * `reset.ts` makes exactly the same distinction for a harvested `E`, where the wear position comes
 * from the command and not from the item's own bits, *"because a ring on the left hand is
 * `WEAR_FINGER_L`, and no wear flag distinguishes left from right"*. An item with no slot named is
 * carried, which is what a `G` does.
 */
export interface AuthoredLoot {
  readonly vnum: number;
  readonly slot?: EquipSlot;
}

/** What an author may change about a mob. Only loot today; the shape leaves room for more. */
export interface MobOverride {
  readonly loot?: readonly AuthoredLoot[];
  /** When it was last written, so the panel can say how stale it is. */
  readonly at?: string;
  /** Who or what wrote it — the provenance every overlay here records. */
  readonly by?: string;
}

export type MobOverrides = Map<number, MobOverride>;

/** The most pieces one template may be authored to carry. */
export const MAX_AUTHORED_LOOT = 12;

const SLOT_SET = new Set<string>(EQUIP_SLOTS);

/**
 * Reads one loot row, or nothing.
 *
 * A slot the game does not model is **refused rather than downgraded to carried**, which is the
 * opposite of what `reset.ts` does with a harvested `E` — and the asymmetry is right. A harvested
 * position we do not model is *data we inherited* and throwing the item away would lose content, so it
 * goes into the mob's hands. A slot typed here is *a choice somebody just made*, and silently doing
 * something else with it is how an author ends up believing a hat is on a head it is not on.
 */
function readLoot(raw: unknown): AuthoredLoot | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.vnum !== 'number' || !Number.isInteger(row.vnum)) return undefined;
  if (row.slot === undefined || row.slot === null || row.slot === '') return { vnum: row.vnum };
  if (typeof row.slot !== 'string' || !SLOT_SET.has(row.slot)) return undefined;
  return { vnum: row.vnum, slot: row.slot as EquipSlot };
}

/**
 * Reads the overlay, tolerating anything — the same posture as every sibling loader.
 *
 * A malformed row is dropped rather than guessed at, because a mob spawning with `undefined` in an
 * equipment slot fails somewhere else entirely: the paper doll, the corpse, the armour fold.
 */
export function loadMobOverrides(file = MOBS_FILE): MobOverrides {
  const out: MobOverrides = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been authored yet.
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum) || typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const loot = Array.isArray(record.loot)
      ? (record.loot as unknown[]).map(readLoot).filter((row): row is AuthoredLoot => row !== undefined)
      : undefined;
    const override: MobOverride = {
      ...(loot && loot.length > 0 ? { loot: loot.slice(0, MAX_AUTHORED_LOOT) } : {}),
      ...(typeof record.at === 'string' ? { at: record.at } : {}),
      ...(typeof record.by === 'string' ? { by: record.by } : {}),
    };
    if (override.loot) out.set(vnum, override);
  }
  return out;
}

/**
 * Writes the whole overlay, sorted by vnum so a hand-read diff shows what changed.
 *
 * An entry that authors no loot is **dropped rather than written**, the same rule `authorsAnything`
 * enforces for rooms: an empty record is not an authored mob, it is a record of one having been
 * edited and then emptied, and keeping it would make every "is this authored" check answer yes.
 */
export function saveMobOverrides(overrides: MobOverrides, file = MOBS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, MobOverride> = {};
  for (const vnum of [...overrides.keys()].sort((a, b) => a - b)) {
    const override = overrides.get(vnum)!;
    if (!override.loot || override.loot.length === 0) continue;
    out[String(vnum)] = override;
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/** What a mob is authored to be wearing and carrying, resolved against the catalogue. */
export interface Outfit {
  readonly worn: readonly { readonly slot: EquipSlot; readonly item: Item }[];
  readonly carried: readonly Item[];
  /** Loot rows naming a vnum the catalogue does not have. Reported rather than swallowed. */
  readonly missing: readonly number[];
}

/**
 * Turns an override into things, against the catalogue.
 *
 * **Instantiated per call**, because every instance gets its own copy: two kobold guards authored to
 * carry a key carry two keys, exactly as two harvested `G` commands would. Sharing one `Item` between
 * bodies would make looting one empty the other.
 *
 * Takes `instantiate` rather than importing it so this file stays free of the item machinery — the
 * same injection `reset.ts` uses, and for the same reason.
 */
export function outfitFor(
  override: MobOverride | undefined,
  items: ReadonlyMap<number, ItemTemplate>,
  instantiate: (template: ItemTemplate) => Item,
): Outfit {
  const worn: { slot: EquipSlot; item: Item }[] = [];
  const carried: Item[] = [];
  const missing: number[] = [];
  for (const row of override?.loot ?? []) {
    const template = items.get(row.vnum);
    if (!template) {
      missing.push(row.vnum);
      continue;
    }
    const item = instantiate(template);
    if (row.slot) worn.push({ slot: row.slot, item });
    else carried.push(item);
  }
  return { worn, carried, missing };
}

/**
 * Puts an outfit on a mob, and says how many pieces went on.
 *
 * **Applied after the reset table has dressed it, so authored loot wins a slot** — and the piece it
 * displaces goes into the mob's hands rather than being destroyed. That is what makes the "additive,
 * never a replacement" claim literally true: the number of things on the body never goes down, so a
 * corpse still holds everything the harvest gave it plus everything somebody authored. It is also the
 * rule `reset.ts` already uses for a wear position we do not model — *"it still exists and is still
 * worth taking off the body, so it goes in the mob's hands"*.
 *
 * The armour refold is the caller's, because the base armour class is theirs to know: a mob's own AC
 * before any kit is not recoverable from the mob once something is on it.
 */
export function applyOutfit(mob: { equipped: Partial<Record<EquipSlot, Item>>; carrying: Item[] }, outfit: Outfit): number {
  for (const item of outfit.carried) mob.carrying.push(item);
  for (const { slot, item } of outfit.worn) {
    const displaced = mob.equipped[slot];
    if (displaced) mob.carrying.push(displaced);
    mob.equipped[slot] = item;
  }
  return outfit.carried.length + outfit.worn.length;
}
