/**
 * Stacking and charges — `DESIGN-inventory.md` §3.
 *
 * Two numbers per item type, and **conflating them is the easy mistake** the design doc opens by
 * warning about:
 *
 * - `stackLimit` — how many of this item share one slot.
 * - `uses` — how many charges *a single one* of them carries.
 *
 * The owner's worked example, which this file exists to reproduce exactly:
 *
 * | | `uses` each | `stackLimit` | a full stack is |
 * | --- | --- | --- | --- |
 * | regular potion | 1 | 5 | 5 uses in one slot |
 * | large potion | 5 | 5 | **25 uses** in one slot |
 * | arrows | — | 20 | 20 arrows in one slot |
 *
 * A large potion is not "a potion worth more". It is five draughts in one bottle, and five bottles
 * stack — so total uses is `count × uses`, and the two numbers multiply rather than either standing in
 * for the other.
 *
 * ## A stack is homogeneous in charges, and that is the whole design
 *
 * §3's last line is the requirement that shapes everything here: *"a half-used large potion is 3 of 5,
 * and cannot merge with a full one into a clean stack."* So a stack cannot be `{item, count}` with the
 * charges tracked somewhere else — there would be nowhere to put "four full and one at three".
 *
 * Instead **every item in a stack has the same `remaining`**, and drinking from one splits it: five
 * full potions become four full plus one at four. That is two entries in the bag, which is exactly
 * what the fiction says — you have four sealed bottles and an open one.
 *
 * The alternative, a per-item charge array inside one stack, is the same information with the
 * invariant removed: nothing would stop a stack holding five different charge levels, and every reader
 * would have to cope with that instead of being able to multiply.
 */

import type { Item } from './equipment.ts';
// Type-only, so the cycle with `containers.ts` (which needs `Stack`) exists in the types and never at
// run time. A stack has to know it may hold things; a container has to know what things are.
import type { Held } from './containers.ts';

/**
 * One entry in a bag: some number of identical items, all with the same charges left.
 *
 * `remaining` is per *item*, not per stack. A stack of three wands at 2 charges each holds six casts.
 */
export interface Stack {
  readonly item: Item;
  /** How many, at least one. A stack of zero is removed rather than kept. */
  readonly count: number;
  /**
   * Charges left on **each** item here. Equal to the type's `uses` for anything untouched, and
   * `undefined` for something use does not consume — a sword, a tunic, a key.
   */
  readonly remaining?: number;
  /**
   * What is inside, when this is a container. `containers.ts` §4.
   *
   * On the *stack* rather than on the `Item`, because contents are per-instance: two quivers hold
   * different arrows, and `Item` is a type-level record copied wherever it goes. A stack carrying
   * this always has `count: 1` — see {@link mergeable}.
   */
  readonly held?: Held;
}

/** How many of this type share one slot. Absent or nonsensical means it does not stack. */
export function stackLimitOf(item: Item, limits: (item: Item) => number | undefined): number {
  const limit = limits(item);
  return typeof limit === 'number' && limit >= 1 ? Math.floor(limit) : 1;
}

/** Total charges in a stack — `count × remaining`. Undefined for something that has none. */
export function totalUses(stack: Stack): number | undefined {
  if (stack.remaining === undefined) return undefined;
  return stack.count * stack.remaining;
}

/**
 * Slots a stack occupies.
 *
 * **Ceiling of count over the limit, times the item's own size.** Six arrows at a limit of twenty is
 * one slot; twenty-one is two. The size multiplies rather than being ignored, because a stack of two
 * breastplates is not one breastplate's worth of bulk — `stackLimit` says how many share a slot, not
 * that they become weightless doing it.
 */
export function stackSlots(stack: Stack, limit: number): number {
  const per = Math.max(1, limit);
  return Math.ceil(stack.count / per) * Math.max(1, stack.item.size);
}

/**
 * Whether two stacks are the same thing at the same wear, and may therefore merge.
 *
 * Both halves are load-bearing. Same **type**, or a dagger would absorb a sword; same **charges**, or
 * §3's half-used potion would vanish into a stack of full ones and reappear as a full one — which is
 * an item duplication bug wearing the clothes of a convenience.
 */
export function mergeable(a: Stack, b: Stack): boolean {
  // **A container holding anything cannot stack**, and it falls out of the invariant rather than being
  // a new rule: a stack is homogeneous, and two quivers with different arrows in them are not the same
  // thing. Empty ones merge freely, which is what a merchant's crate of empty sacks wants.
  if (a.held?.contents.length || b.held?.contents.length) return false;
  return a.item.id === b.item.id && a.remaining === b.remaining;
}

/**
 * Folds one stack into another, returning what fitted and what did not.
 *
 * Answers with a leftover rather than refusing outright, because a bag holding three of a five-limit
 * potion should take two more from a stack of four and leave two behind — refusing the whole transfer
 * because it does not all fit is the behaviour that makes a player shuffle items by hand.
 */
export function mergeStacks(into: Stack, from: Stack, limit: number): { merged: Stack; leftover?: Stack } {
  if (!mergeable(into, from)) return { merged: into, leftover: from };
  const room = Math.max(0, Math.max(1, limit) - into.count);
  const moved = Math.min(room, from.count);
  if (moved === 0) return { merged: into, leftover: from };

  const merged: Stack = { ...into, count: into.count + moved };
  const rest = from.count - moved;
  return rest > 0 ? { merged, leftover: { ...from, count: rest } } : { merged };
}

/**
 * Spends one charge from a stack — the split §3 requires.
 *
 * The three outcomes are the whole of the mechanic:
 *
 * - **A single item**: its charges just drop. Nothing splits, because there is nothing to split from.
 * - **A stack of more than one**: it becomes *count − 1 untouched* plus *one at `remaining − 1`*. You
 *   opened a bottle; the others are still sealed. Those two entries cannot merge again until the open
 *   one is finished, which is precisely what §3 asks for.
 * - **The last charge**: that item is gone. A stack of five where one is emptied becomes four.
 *
 * Answers `undefined` for a stack with no charges to spend, so a caller cannot quietly consume a
 * sword.
 */
export function useOnce(stack: Stack): { rest?: Stack; opened?: Stack } | undefined {
  if (stack.remaining === undefined || stack.remaining <= 0) return undefined;

  const left = stack.remaining - 1;
  // The last charge: this one is used up and leaves the bag.
  if (left === 0) {
    return stack.count > 1 ? { rest: { ...stack, count: stack.count - 1 } } : {};
  }
  // One item opens; the rest stay as they were.
  const opened: Stack = { item: stack.item, count: 1, remaining: left };
  return stack.count > 1 ? { rest: { ...stack, count: stack.count - 1 }, opened } : { opened };
}

/**
 * How a stack reads in a list.
 *
 * The charges are shown **per item and only when they have been touched**: "a potion of healing (3/5)"
 * says something a player can act on, while "(5/5)" on every untouched bottle is noise that makes the
 * one that matters harder to spot.
 */
export function describeStack(stack: Stack, fullUses?: number): string {
  const many = stack.count > 1 ? ` (x${stack.count})` : '';
  const worn =
    stack.remaining !== undefined && fullUses !== undefined && stack.remaining < fullUses
      ? ` [${stack.remaining}/${fullUses}]`
      : '';
  return `${stack.item.name}${many}${worn}`;
}
