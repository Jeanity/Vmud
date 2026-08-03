/**
 * What a character is carrying, and whether the next thing fits.
 *
 * `DESIGN-inventory.md` is the specification. 15b built §2, §5 and §7 over a flat list of items;
 * **15c replaced that list with stacks** (§3), which is why the field is `stacks` rather than
 * `items` — a rename on purpose, so every reader had to be revisited rather than silently compiling
 * against a different meaning.
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
 * ## Stacking makes "does it fit" a different question
 *
 * With a flat list, one more item always cost its own bulk. With stacks it may cost **nothing**:
 * picking up the twentieth arrow when you already hold nineteen fills a slot you had already paid
 * for. So {@link fits} cannot be `size <= free` any more — it has to ask whether the thing merges
 * first. Getting that wrong is not a rounding error; it is a bag that refuses an arrow it has room
 * for, which reads as broken.
 *
 * ## What cannot be lost
 *
 * The capacity itself is a number on the character rather than a bag you wear, and that is the
 * owner's rule with the owner's reason: *"there is nothing worse than playing a game of months and
 * losing everything due to 1 mistake."* Everything **inside** the bag can be lost. The floor cannot.
 *
 * ## Worn gear is not in here
 *
 * Equipment slots are a separate store and never consume capacity — §6. A character wearing thirty
 * slots of plate carries an empty bag, which is the point: what you are wearing is not luggage.
 */

import type { Item } from './equipment.ts';
import { mergeStacks, mergeable, stackSlots, type Stack } from './stacks.ts';

/**
 * Slots a character starts with. `DESIGN-inventory.md` §5's own number.
 *
 * Against the starter kit's sizes — 1 to 3 a garment — twenty is roughly seven or eight pieces of
 * light gear. Enough that early looting is not immediately a management puzzle, small enough that it
 * becomes one before long, which is when a container starts being worth finding (§4).
 */
export const STARTING_CAPACITY = 20;

export interface Inventory {
  readonly stacks: readonly Stack[];
  /** Total slots, a property of the character. Larger bags raise it; nothing lowers it. */
  readonly capacity: number;
}

export function emptyInventory(capacity = STARTING_CAPACITY): Inventory {
  return { stacks: [], capacity };
}

/** How many of this item share a slot. Absent or nonsensical means it does not stack. */
export function limitOf(item: Item): number {
  return typeof item.stackLimit === 'number' && item.stackLimit >= 1 ? Math.floor(item.stackLimit) : 1;
}

/** A stack of one, at full charges. The one road from a loose item into a bag. */
export function stackOf(item: Item, count = 1): Stack {
  return { item, count, ...(typeof item.uses === 'number' && item.uses > 0 ? { remaining: item.uses } : {}) };
}

/** Slots in use. Summed rather than tracked, so it cannot drift from what is actually held. */
export function slotsUsed(inventory: Inventory): number {
  return inventory.stacks.reduce((total, stack) => total + stackSlots(stack, limitOf(stack.item)), 0);
}

export function slotsFree(inventory: Inventory): number {
  return Math.max(0, inventory.capacity - slotsUsed(inventory));
}

/**
 * Whether one more of this would fit.
 *
 * **Asks by simulating the carry**, rather than comparing size against free space. Since 15c a thing
 * may merge into a stack that already has room and cost nothing at all, and there is no way to answer
 * that from the two numbers alone. Doing it this way also means `fits` and {@link carry} cannot
 * disagree — a bag that refuses what a carry would have accepted is a bug this avoids by
 * construction rather than by keeping two branches in step.
 */
export function fits(inventory: Inventory, item: Item): boolean {
  return 'stacks' in carry(inventory, item);
}

/**
 * Why a carry was refused: what it needed, and what was free. §7.
 *
 * The message is the requirement rather than a nicety. The alternative designs are both worse:
 * silently dropping the item loses a quest object to an invisible heuristic, and silently discarding
 * it is the same thing with no evidence. Refusing leaves the world exactly as it was.
 */
export type CarryRefusal = { readonly needed: number; readonly free: number };

/**
 * Puts something in the bag, or explains why not.
 *
 * **Merges before it adds.** The first stack that will take it gets it, which keeps a bag from
 * filling with half-empty stacks of the same arrow — and, since a merge may cost no slots at all, is
 * what lets an otherwise full bag still accept one more of something it is already carrying.
 */
export function carry(inventory: Inventory, item: Item): Inventory | CarryRefusal {
  const incoming = stackOf(item);
  const limit = limitOf(item);

  // Merge first. Same type *and* same charges — `mergeable` is what enforces §3's rule that a
  // part-used one cannot hide in a stack of full ones.
  for (let i = 0; i < inventory.stacks.length; i++) {
    const existing = inventory.stacks[i]!;
    if (!mergeable(existing, incoming)) continue;
    const { merged, leftover } = mergeStacks(existing, incoming, limit);
    if (leftover) continue; // that stack was already full; try the next one
    const stacks = [...inventory.stacks];
    stacks[i] = merged;
    const next: Inventory = { stacks, capacity: inventory.capacity };
    // A merge can still tip into a new slot — the twenty-first arrow. Charged honestly, and if there
    // is no room for it the loop falls through to the refusal below rather than pretending.
    if (slotsUsed(next) > inventory.capacity) break;
    return next;
  }

  const needed = Math.max(1, item.size);
  const free = slotsFree(inventory);
  if (needed > free) return { needed, free };
  return { stacks: [...inventory.stacks, incoming], capacity: inventory.capacity };
}

/**
 * Takes **one** item out of the stack at a position.
 *
 * By index rather than by id because **two identical items are two items**: a character holding three
 * daggers who drops one must drop one, and matching on `id` would make "which" unanswerable. The
 * caller resolves a keyword to an index — see {@link matchInventory} — so the ambiguity is settled
 * once, where the player's words are, rather than here.
 *
 * One item, not the whole stack: `drop arrow` means an arrow. A stack that empties is removed, so the
 * bag never holds a stack of zero.
 */
export function removeAt(inventory: Inventory, index: number): { inventory: Inventory; item: Item } | undefined {
  const stack = inventory.stacks[index];
  if (!stack) return undefined;

  const stacks = [...inventory.stacks];
  if (stack.count > 1) stacks[index] = { ...stack, count: stack.count - 1 };
  else stacks.splice(index, 1);
  return { inventory: { stacks, capacity: inventory.capacity }, item: stack.item };
}

/**
 * The index of the first carried stack a player's word names, or `-1`.
 *
 * Matches the way every other target in the game does — against the *display name*, which is what a
 * player can actually see. "a leather tunic" answers to `tunic` and to `leather`, and the first match
 * wins, because a bag is an ordered list and "the first one" is the only ordering a player can
 * predict without being shown indices.
 */
export function matchInventory(inventory: Inventory, word: string): number {
  const wanted = word.trim().toLowerCase();
  if (!wanted) return -1;
  return inventory.stacks.findIndex(
    (stack) =>
      stack.item.id === wanted || stack.item.name.toLowerCase().split(/[^a-z0-9]+/).includes(wanted),
  );
}

/**
 * Every item in the bag, one entry per physical thing.
 *
 * For a death that empties a bag into a corpse: a stack of five arrows is five arrows on the body, not
 * one. Charges are lost in the flattening, which is a known limit rather than a decision — corpse
 * contents are still `Item[]`, and giving them stacks is the same wiring as this file, one layer out.
 */
export function loose(inventory: Inventory): Item[] {
  const out: Item[] = [];
  for (const stack of inventory.stacks) for (let i = 0; i < stack.count; i++) out.push(stack.item);
  return out;
}

/**
 * Rebuilds a bag from disk, dropping anything malformed.
 *
 * Reads **both shapes**: a pre-15c save has `items`, a flat array, and is folded back through
 * {@link carry} so it comes out stacked the way a live bag would be. Refusing to load it would lock a
 * character out of their own inventory over a data format — the same call `explored` and `light` each
 * got when they migrated.
 */
export function readInventory(raw: unknown, readItem: (value: unknown) => Item | undefined): Inventory {
  const source = raw as { stacks?: unknown; items?: unknown; capacity?: unknown } | null;
  if (typeof source !== 'object' || source === null) return emptyInventory();
  const capacity =
    typeof source.capacity === 'number' && Number.isFinite(source.capacity) && source.capacity > 0
      ? Math.round(source.capacity)
      : STARTING_CAPACITY;

  if (Array.isArray(source.stacks)) {
    const stacks: Stack[] = [];
    for (const entry of source.stacks) {
      const row = entry as { item?: unknown; count?: unknown; remaining?: unknown };
      const item = readItem(row?.item);
      if (!item) continue;
      const count = typeof row.count === 'number' && row.count >= 1 ? Math.floor(row.count) : 1;
      stacks.push({
        item,
        count,
        ...(typeof row.remaining === 'number' && row.remaining >= 0 ? { remaining: row.remaining } : {}),
      });
    }
    return { stacks, capacity };
  }

  // Pre-15c: a flat `items` array.
  let bag: Inventory = { stacks: [], capacity };
  if (Array.isArray(source.items)) {
    for (const entry of source.items) {
      const item = readItem(entry);
      if (!item) continue;
      const next = carry(bag, item);
      // A save that overflows the capacity it declares keeps what fits. Refusing the whole file loses
      // more than dropping the overflow does.
      if ('stacks' in next) bag = next;
    }
  }
  return bag;
}
