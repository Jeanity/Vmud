/**
 * What a character is carrying, and whether the next thing fits.
 *
 * Phase 15b. `DESIGN-inventory.md` is the specification; this is §2, §5 and §7 of it — the parts a
 * bag needs before anything can be picked up at all. Stacking, charges and containers are §3 and §4
 * and land in 15c; a bag of loose items is the floor they build on.
 *
 * ## Slots are bulk, not count
 *
 * An item costs a *number* of slots and that number varies — a breastplate might be ten of your
 * twenty where a dagger is one. It is a bulk model wearing a slot model's clothes, and it is the
 * right one: armour becomes a real logistical decision without asking anybody to add up pounds.
 *
 * **Note the departure, because the rules backbone is otherwise SRD.** Diku and the SRD both derive
 * carrying capacity from Strength. This does not — capacity comes from your bag, and Strength governs
 * nothing here. A grid you can see beats a weight budget you have to compute.
 *
 * ## What cannot be lost
 *
 * The capacity itself is a number on the character rather than a bag you wear, and that is the
 * owner's rule with the owner's reason: *"there is nothing worse than playing a game of months and
 * losing everything due to 1 mistake."* Everything **inside** the bag can be lost. The floor cannot.
 * That is why this is a plain number here and not an item occupying a `back` slot, despite the latter
 * being the more conventional choice.
 *
 * ## Worn gear is not in here
 *
 * Equipment slots are a separate store and never consume capacity — §6. A character wearing thirty
 * slots of plate carries an empty bag, which is the point: what you are wearing is not luggage.
 */

import type { Item } from './equipment.ts';

/**
 * Slots a character starts with. `DESIGN-inventory.md` §5's own number.
 *
 * Against the starter kit's sizes — 1 to 3 a garment — twenty is roughly seven or eight pieces of
 * light gear. Enough that early looting is not immediately a management puzzle, small enough that it
 * becomes one before long, which is when a container starts being worth finding (15c).
 */
export const STARTING_CAPACITY = 20;

export interface Inventory {
  readonly items: readonly Item[];
  /** Total slots, a property of the character. Larger bags raise it; nothing lowers it. */
  readonly capacity: number;
}

export function emptyInventory(capacity = STARTING_CAPACITY): Inventory {
  return { items: [], capacity };
}

/** Slots in use. Summed rather than tracked, so it cannot drift from what is actually held. */
export function slotsUsed(inventory: Inventory): number {
  return inventory.items.reduce((total, item) => total + Math.max(1, item.size), 0);
}

export function slotsFree(inventory: Inventory): number {
  return Math.max(0, inventory.capacity - slotsUsed(inventory));
}

/** Whether one more of this would fit. */
export function fits(inventory: Inventory, item: Item): boolean {
  return Math.max(1, item.size) <= slotsFree(inventory);
}

/**
 * Puts something in the bag, or explains why not.
 *
 * **A full bag refuses and says what would not fit and how many slots it needed** — §7, and the
 * message is the requirement rather than a nicety. The alternative designs are both worse: silently
 * dropping the item loses a quest object to an invisible heuristic, and silently discarding it is
 * the same thing with no evidence. Refusing leaves the world exactly as it was.
 */
export type CarryRefusal = { readonly needed: number; readonly free: number };

export function carry(inventory: Inventory, item: Item): Inventory | CarryRefusal {
  const needed = Math.max(1, item.size);
  const free = slotsFree(inventory);
  if (needed > free) return { needed, free };
  return { items: [...inventory.items, item], capacity: inventory.capacity };
}

/**
 * Takes one specific item out, by its position.
 *
 * By index rather than by id because **two identical items are two items**: a character holding three
 * daggers who drops one must drop one, and matching on `id` would make "which" unanswerable. The
 * caller resolves a keyword to an index — see `matchInventory` — so the ambiguity is settled once,
 * where the player's words are, rather than here.
 */
export function removeAt(inventory: Inventory, index: number): { inventory: Inventory; item: Item } | undefined {
  const item = inventory.items[index];
  if (!item) return undefined;
  const items = [...inventory.items.slice(0, index), ...inventory.items.slice(index + 1)];
  return { inventory: { items, capacity: inventory.capacity }, item };
}

/**
 * The index of the first carried item a player's word names, or `-1`.
 *
 * Matches the way every other target in the game does — against the *display name*, which is what a
 * player can actually see. "a leather tunic" answers to `tunic` and to `leather`, and the first match
 * wins, because a bag is an ordered list and "the first one" is the only ordering a player can
 * predict without being shown indices.
 */
export function matchInventory(inventory: Inventory, word: string): number {
  const wanted = word.trim().toLowerCase();
  if (!wanted) return -1;
  return inventory.items.findIndex(
    (item) => item.id === wanted || item.name.toLowerCase().split(/[^a-z0-9]+/).includes(wanted),
  );
}

/** Rebuilds a bag from disk, dropping anything malformed. Same posture as `readEquipped`. */
export function readInventory(raw: unknown, readItem: (value: unknown) => Item | undefined): Inventory {
  const source = raw as { items?: unknown; capacity?: unknown } | null;
  if (typeof source !== 'object' || source === null) return emptyInventory();
  const capacity =
    typeof source.capacity === 'number' && Number.isFinite(source.capacity) && source.capacity > 0
      ? Math.round(source.capacity)
      : STARTING_CAPACITY;
  const items = Array.isArray(source.items)
    ? source.items.map(readItem).filter((item): item is Item => item !== undefined)
    : [];
  return { items, capacity };
}
