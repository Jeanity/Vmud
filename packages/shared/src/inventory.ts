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
// `MAX_NESTING_DEPTH` is a value, and importing it is deliberate: the depth rule belongs to containers
// and is enforced on the way *in* as well as on the way out. See {@link readStack}.
import { MAX_NESTING_DEPTH, type Held } from './containers.ts';
import { CONTAINER_ACCEPTS, type ContainerAccepts } from './items.ts';

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
  return carryStack(inventory, stackOf(item));
}

/**
 * Puts a whole stack in the bag — the same act as {@link carry}, for a stack that already exists.
 *
 * The case that needs it is **a container coming back off the floor with things in it**: `carry` builds
 * a fresh single item from a type, which has nowhere to put the twenty arrows in the quiver you just
 * picked up. Rather than a second code path that could accept what `carry` refuses, `carry` is now the
 * one-item spelling of this.
 *
 * `mergeable` already refuses a container holding anything, so a full quiver lands as its own stack and
 * cannot be absorbed into a pile of empty ones.
 */
export function carryStack(inventory: Inventory, incoming: Stack): Inventory | CarryRefusal {
  const limit = limitOf(incoming.item);

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

  const needed = stackSlots(incoming, limit);
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
 * Every item in the bag, one entry per physical thing — **including what is inside containers**.
 *
 * For a death that empties a bag into a corpse: a stack of five arrows is five arrows on the body, not
 * one. Charges are lost in the flattening, which is a known limit rather than a decision — corpse
 * contents are still `Item[]`, and giving them stacks is the same wiring as this file, one layer out.
 *
 * **Descending into containers is not a nicety.** A quiver on a corpse is one item; twenty arrows in
 * that quiver are twenty more, and a version of this that stopped at the top level destroyed them
 * silently on every death. The quiver comes out too, so what the corpse holds is exactly what the
 * character was carrying — nothing created, nothing quietly burned.
 */
export function loose(inventory: Inventory): Item[] {
  const out: Item[] = [];
  for (const stack of inventory.stacks) {
    for (let i = 0; i < stack.count; i++) out.push(stack.item);
    // A container with contents always has `count: 1` — `stacks.ts` refuses to merge one that holds
    // anything — so there is no risk of emptying the same quiver twice.
    if (stack.held) {
      for (const inside of stack.held.contents) for (let i = 0; i < inside.count; i++) out.push(inside.item);
    }
  }
  return out;
}

/** The kinds a container may accept, from the catalogue's own list rather than a copy of it. */
const ACCEPTS = new Set<string>(CONTAINER_ACCEPTS);

/**
 * Reads one stack off disk, including what it holds.
 *
 * **`depth` is the §4 nesting rule enforced on the way in, not only on the way out.** `put` refuses a
 * container inside a container, but a save file is hand-editable and nothing stops somebody nesting
 * three deep in a text editor — at which point every reader downstream would have to cope with a shape
 * the rules say cannot exist. Refusing it here means the invariant holds for anything that has been
 * loaded, however the file got that way.
 *
 * Contents recurse through this same function, so a stack of arrows inside a quiver is read by the
 * code that reads a stack of arrows in a bag. One reader, one set of rules.
 */
function readStack(
  entry: unknown,
  readItem: (value: unknown) => Item | undefined,
  depth: number,
): Stack | undefined {
  const row = entry as { item?: unknown; count?: unknown; remaining?: unknown; held?: unknown } | null;
  if (typeof row !== 'object' || row === null) return undefined;
  const item = readItem(row.item);
  if (!item) return undefined;

  const count = typeof row.count === 'number' && row.count >= 1 ? Math.floor(row.count) : 1;
  const stack: Stack = {
    item,
    count,
    ...(typeof row.remaining === 'number' && row.remaining >= 0 ? { remaining: row.remaining } : {}),
  };

  const held = readHeld(row.held, readItem, depth);
  return held ? { ...stack, held } : stack;
}

/**
 * Reads a container's rule and contents, or nothing if this stack is not one.
 *
 * The rule is validated the way every other loaded field is: a capacity that is not a positive number
 * and an `accepts` the catalogue does not define are both refused rather than repaired, because a
 * container claiming to accept `"everything"` would be a quiet rule change rather than a typo.
 */
function readHeld(
  raw: unknown,
  readItem: (value: unknown) => Item | undefined,
  depth: number,
): Held | undefined {
  // Past the nesting limit there is nothing legitimate to read. The container itself still loads; only
  // what it claims to hold is dropped, which loses less than refusing the whole bag.
  if (depth >= MAX_NESTING_DEPTH) return undefined;

  const source = raw as { rule?: unknown; contents?: unknown } | null;
  if (typeof source !== 'object' || source === null) return undefined;
  const rule = source.rule as { capacity?: unknown; accepts?: unknown } | null;
  if (typeof rule !== 'object' || rule === null) return undefined;
  if (typeof rule.capacity !== 'number' || !Number.isFinite(rule.capacity) || rule.capacity <= 0) return undefined;
  if (typeof rule.accepts !== 'string' || !ACCEPTS.has(rule.accepts)) return undefined;

  const contents: Stack[] = [];
  if (Array.isArray(source.contents)) {
    for (const entry of source.contents) {
      const inside = readStack(entry, readItem, depth + 1);
      if (inside) contents.push(inside);
    }
  }
  return { rule: { capacity: Math.round(rule.capacity), accepts: rule.accepts as ContainerAccepts }, contents };
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
      const stack = readStack(entry, readItem, 1);
      if (stack) stacks.push(stack);
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
