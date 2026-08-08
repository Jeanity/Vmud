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
 * - **`type`, `container`, `twoHanded`** — behaviour, derived from Duris' own wear bits and type
 *   constants. Editing those means editing what a thing *is*, and each carries rules this slice
 *   would have to re-validate (a container needs a capacity, a two-hander clears the off hand).
 *   Refusing them keeps this slice an item editor rather than half of a mechanics editor.
 * - **`stackLimit` and `uses`** — §3's rules, derived from the type. A hand-set stack limit on one
 *   arrow would make two arrows of the same vnum disagree about sharing a slot.
 * - **`vnum`** — the join key. `CLAUDE.md`: never renumber.
 *
 * **`slot` moved sides on the owner's ruling (2026-08-07)**: *"worn items we need to be able to
 * select where it is worn"* — a shroud the harvest put `about` that should ride the back like a
 * cloak. The old refusal reasoned that a slot is behaviour; the owner's case is that a slot is
 * **where the artist meant it**, which is content wearing behaviour's clothes. It validates against
 * `EQUIP_SLOTS` and nothing else, because unlike `container` it carries no dependent rules. And
 * **`weaponClass` joins it the same day** for the same kind of reason (Windsong punching): the
 * class decides the verb, the trained skill and the swing animation, and an authored weapon with no
 * way to say what it is swings like a fist for ever.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { EQUIP_SLOTS, LPC_ART_BY_ID, isKnownArt, type Dice, type EquipSlot, type ItemTemplate } from '@mygame/shared';

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
  /**
   * What this item is worth as a light — **A6c**, owner's ask 2026-08-06: *"some equipment will be light
   * sources so that needs to be added to the item editor."*
   *
   * `radius` in tiles and `durationMs` for one that burns; **absent `durationMs` means it never goes
   * out**, which is a state rather than a big number and is what 32 of the harvested 64 are.
   *
   * Authorable now because it finally *does* something anywhere: until the light redesign the same day, a
   * light only lit you from a hand, so authoring a glowing helmet produced an item the game could not
   * use — which is why this row waited for that one.
   */
  readonly light?: { readonly radius: number; readonly durationMs?: number };
  /**
   * Where it is worn — the owner's shroud ruling (2026-08-07); see the header for why this crossed
   * the behaviour line. Only where the body has such a place; `EQUIP_SLOTS` is the whole law.
   */
  readonly slot?: EquipSlot;
  /**
   * Duris' 1–20 weapon ladder — the verb, the trained skill and the swing animation in one number.
   * Authored because Windsong punched: the harvest carries it for its own weapons, and an authored
   * or corrected blade needs the same single fact said once.
   */
  readonly weaponClass?: number;
  /**
   * **May ride the off hand** — Phase 21, and it lands on the *allowed* side of the header's line by
   * the header's own test. `twoHanded` is refused there because it *"clears the off hand"*: it drags
   * a second slot with it and a slice that allowed it would owe that rule a re-validation. This one
   * drags nothing. It widens where a weapon may go and empties no slot, displaces no item and needs
   * no capacity — the same reason `slot` and `weaponClass` were let through, and the same sentence
   * Windsong prompted: a blade with no way to say it was made for the weaker hand is a stat stick for
   * ever.
   *
   * Only ever `'either'`. Absent means the main hand, so a second value would say the same thing twice.
   */
  readonly handedness?: 'either';
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
      ...(typeof patch.art === 'string' && isKnownArt(patch.art, LPC_ART_BY_ID) ? { art: patch.art } : {}),
      ...(readAuthoredLight(patch.light) ? { light: readAuthoredLight(patch.light)! } : {}),
      ...(typeof patch.slot === 'string' && (EQUIP_SLOTS as readonly string[]).includes(patch.slot)
        ? { slot: patch.slot as EquipSlot }
        : {}),
      ...(typeof patch.weaponClass === 'number' && Number.isInteger(patch.weaponClass) && patch.weaponClass >= 1 && patch.weaponClass <= 20
        ? { weaponClass: patch.weaponClass }
        : {}),
      // One legal value, so the check is an equality rather than a range. Anything else is dropped
      // the way every other malformed field here is — this is the disk reader as well as the panel's
      // door, and a hand-edited `"handedness": "left"` should leave the weapon alone, not break boot.
      ...(patch.handedness === 'either' ? { handedness: 'either' as const } : {}),
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
    ...(override.light !== undefined ? { light: override.light } : {}),
    ...(override.slot !== undefined ? { slot: override.slot } : {}),
    ...(override.weaponClass !== undefined ? { weaponClass: override.weaponClass } : {}),
    ...(override.handedness !== undefined ? { handedness: override.handedness } : {}),
  };
}

/**
 * An authored light, sanitised — **A6c**.
 *
 * Three clamps, and each is a decision the project already took somewhere else:
 *
 * - **The radius is clamped to the shipped ladder**, because it is not a free number. `light.ts` gives
 *   *every* light the same reach on purpose: Diku light is a boolean, so there is nothing to transcribe,
 *   and `ROOM_GAP` makes 3 the distance at which a room's exits become findable — *"every light sees as
 *   far as a torch and what separates a candle from a lantern is how long you keep it"*. An author typing
 *   11 would be overriding a tuned relationship from a form, so the form does not let them; the four
 *   catalogue radii are 1, 3 and 4, and the cap is {@link MAX_AUTHORED_LIGHT_RADIUS}.
 * - **Duration is in milliseconds here and hours in the file it came from.** `light.ts` pinned one Duris
 *   hour at ten seconds by making the two catalogues agree, so a form offering "hours" has to multiply.
 *   This layer takes the resolved number and only checks it is a positive finite one.
 * - **Absent means unlimited**, not zero. A zero-duration light would gutter on the first tick, which is
 *   not a thing anybody wants to author, so a non-positive duration is read as *no clock at all*.
 */
export const MAX_AUTHORED_LIGHT_RADIUS = 4;

export function readAuthoredLight(raw: unknown): { readonly radius: number; readonly durationMs?: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const light = raw as { radius?: unknown; durationMs?: unknown };
  if (typeof light.radius !== 'number' || !Number.isFinite(light.radius)) return undefined;
  const radius = Math.min(MAX_AUTHORED_LIGHT_RADIUS, Math.max(1, Math.round(light.radius)));
  const duration =
    typeof light.durationMs === 'number' && Number.isFinite(light.durationMs) && light.durationMs > 0
      ? Math.round(light.durationMs)
      : undefined;
  return { radius, ...(duration === undefined ? {} : { durationMs: duration }) };
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
