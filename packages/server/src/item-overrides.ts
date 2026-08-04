/**
 * Authored items — the overlay the admin panel writes over the harvested catalogue. **A6.**
 *
 * The same shape `overrides.ts` gave rooms in A5, for the same governing rule
 * (`DESIGN-admin-panel.md` §1): **authoring lands as overlay files the game loads**, never as edits
 * to generated data. `data/world/items.json` is a build output of `npm run worldgen` — editing it
 * would be editing an artefact, and the next harvest would silently undo the edit. This file is
 * composed *over* it at boot, so the harvest can be re-run forever underneath a growing body of
 * authored changes.
 *
 * ## Partial on purpose
 *
 * An override stores **only the fields somebody changed**, keyed by vnum — the join key every data
 * source already shares. A re-harvest that improves an item's damage dice flows through unless the
 * dice are the thing that was authored, which is exactly the property the room overlay chose and for
 * the same reason: an overlay that snapshots whole records freezes everything it touches.
 *
 * ## What may be authored, and what may not
 *
 * Name, keywords, armour class, damage dice and cost — the *content* of an item. Deliberately not:
 *
 * - **`slot`, `type`, `container`, `twoHanded`** — behaviour, derived from Duris' own wear bits and
 *   type constants. Editing those means editing what a thing *is*, and each carries rules this slice
 *   would have to re-validate (a container needs a capacity, a two-hander clears the off hand).
 *   Refusing them keeps this slice an item editor rather than half of a mechanics editor.
 * - **`stackLimit` and `uses`** — §3's rules, derived from the type. A hand-set stack limit on one
 *   arrow would make two arrows of the same vnum disagree about sharing a slot.
 * - **`vnum`** — the join key. `CLAUDE.md`: never renumber.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LPC_ART_BY_ID, type Dice, type ItemTemplate } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where authored items live — beside `rooms.json`, and exported for the same anti-drift reason. */
export const ITEMS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'items.json');

/** What an author may change about an item. Every field optional — an override is a *patch*. */
export interface ItemOverride {
  readonly name?: string;
  /** The words it answers to. Authoring these is renaming what a player can type. */
  readonly keywords?: readonly string[];
  /** On **our** compressed scale, not Duris' raw value — the number the fight actually uses. */
  readonly ac?: number;
  readonly damage?: Dice;
  readonly cost?: number;
  /**
   * A7b: the LPC art id this item is drawn with. **Content, not behaviour** — which is why it is here
   * and `slot` is not. Choosing a sword's picture changes nothing about what the sword does.
   */
  readonly art?: string;
  /** When it was last written, so the panel can say how stale an item's authoring is. */
  readonly at?: string;
  /** Who or what wrote it — the same provenance rule the room overlay records. */
  readonly by?: string;
}

export type ItemOverrides = Map<number, ItemOverride>;

/** The fields that are *about* an override rather than part of one. See `OVERRIDE_META` in A5. */
export const ITEM_OVERRIDE_META: readonly string[] = ['at', 'by'];

/** Whether an override still authors anything, or is only metadata left over from a revert. */
export function itemAuthorsAnything(override: ItemOverride): boolean {
  return Object.keys(override).some((key) => !ITEM_OVERRIDE_META.includes(key));
}

/** A well-formed dice record, or nothing. Shared by the loader and the PATCH validator. */
export function readDice(raw: unknown): Dice | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const dice = raw as Record<string, unknown>;
  const count = dice.count;
  const sides = dice.sides;
  const bonus = dice.bonus ?? 0;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 100) return undefined;
  if (typeof sides !== 'number' || !Number.isInteger(sides) || sides < 1 || sides > 1000) return undefined;
  if (typeof bonus !== 'number' || !Number.isInteger(bonus) || Math.abs(bonus) > 1000) return undefined;
  return { count, sides, bonus };
}

/**
 * Reads the overlay, tolerating anything — the same posture as the room loader and `players.ts`.
 *
 * Hand-editable by design, so every field is validated rather than trusted: a `"damage": "3d5"`
 * written as a string is dropped, not guessed at, because a template whose dice are `NaN` swings for
 * `NaN` and the failure surfaces three systems away.
 */
export function loadItemOverrides(file = ITEMS_FILE): ItemOverrides {
  const out: ItemOverrides = new Map();
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
    const patch = value as Record<string, unknown>;
    const damage = readDice(patch.damage);
    const keywords = Array.isArray(patch.keywords)
      ? (patch.keywords as unknown[])
          .filter((w): w is string => typeof w === 'string')
          .map((w) => w.trim().toLowerCase())
          .filter((w) => w.length > 0)
      : undefined;
    const override: ItemOverride = {
      ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...(keywords && keywords.length > 0 ? { keywords } : {}),
      ...(typeof patch.ac === 'number' && Number.isInteger(patch.ac) && patch.ac >= 0 && patch.ac <= 50
        ? { ac: patch.ac }
        : {}),
      ...(damage ? { damage } : {}),
      ...(typeof patch.cost === 'number' && Number.isInteger(patch.cost) && patch.cost >= 0 ? { cost: patch.cost } : {}),
      // Checked against the generated index, not merely for being a string: an art id with no sheet
      // behind it is a magenta box on somebody's body three systems away from this file.
      ...(typeof patch.art === 'string' && LPC_ART_BY_ID.has(patch.art) ? { art: patch.art } : {}),
      ...(typeof patch.at === 'string' ? { at: patch.at } : {}),
      ...(typeof patch.by === 'string' ? { by: patch.by } : {}),
    };
    if (itemAuthorsAnything(override)) out.set(vnum, override);
  }
  return out;
}

/** Writes the whole overlay, sorted by vnum so a hand-read diff shows the change, not a reshuffle. */
export function saveItemOverrides(overrides: ItemOverrides, file = ITEMS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, ItemOverride> = {};
  for (const vnum of [...overrides.keys()].sort((a, b) => a - b)) out[String(vnum)] = overrides.get(vnum)!;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * A template with an override folded over it. Returns a **new** template.
 *
 * Always applied to the *pristine* harvested template, never to an already-overridden one — that is
 * what lets clearing a field genuinely restore the harvest rather than whatever the last edit left.
 * The caller owns keeping the pristine copy; see `composeItemOverrides` in `index.ts`.
 */
export function applyItemOverride(template: ItemTemplate, override: ItemOverride): ItemTemplate {
  return {
    ...template,
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.keywords !== undefined ? { keywords: override.keywords } : {}),
    ...(override.ac !== undefined ? { ac: override.ac } : {}),
    ...(override.damage !== undefined ? { damage: override.damage } : {}),
    ...(override.cost !== undefined ? { cost: override.cost } : {}),
    ...(override.art !== undefined ? { art: override.art } : {}),
  };
}

/**
 * Merges an edit into an existing override, honouring clears, or returns `undefined` when nothing
 * authored remains — at which point the entry must be *deleted*, or the item wears the editor's mark
 * forever. The same rule `authorsAnything` enforces for rooms.
 */
export function mergeItemOverride(
  current: ItemOverride | undefined,
  next: Partial<ItemOverride>,
  cleared: readonly string[],
  at: string,
): ItemOverride | undefined {
  const merged: Record<string, unknown> = { ...(current ?? {}), ...next, at };
  for (const key of cleared) delete merged[key];
  const override = merged as ItemOverride;
  return itemAuthorsAnything(override) ? override : undefined;
}
