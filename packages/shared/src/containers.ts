/**
 * Containers — `DESIGN-inventory.md` §4.
 *
 * A container is an ordinary item that holds other items: findable, droppable, losable. What makes it
 * worth carrying is one rule:
 *
 * > **A container's contents do not count against the capacity holding it.**
 *
 * That is the whole point, and it is what the owner meant by a quiver letting arrows *"free up the spot
 * in the inventory"*. A quiver costs its own slots and then holds far more arrows than those slots
 * would have held loose. Without that rule a container is a decoration.
 *
 * ## Depth 2, confirmed rather than assumed
 *
 * §4 flagged the nesting depth as *"a proposal, not a decision taken"*. Owner confirmed it (2026-08-03):
 * **your inventory may hold containers, and those containers hold items, but not further containers.**
 *
 * Unbounded nesting is unbounded storage — a bag in a bag in a bag, forever — and Diku has exactly that
 * problem. Depth 2 removes the exploit *by rule* rather than mitigating it, while keeping the quiver and
 * the belt pouch, which is what nesting is actually for. The alternative the doc records — propagate
 * bulk upward so a full bag costs more than an empty one — closes the same hole by economics, but makes
 * capacity arithmetic much harder to explain to a player, and a grid you can see is the thing §2 chose
 * over a weight budget you have to compute.
 *
 * ## A container with something in it cannot stack
 *
 * Falls out of `stacks.ts`'s invariant rather than being a new rule. A `Stack` is *homogeneous* — every
 * item in it is identical, which is what lets `count` mean anything. Two quivers holding different
 * arrows are not identical, so a container that holds anything has `count: 1`. Empty ones stack freely,
 * which is what you want for a merchant's crate of empty sacks.
 */

import type { Item } from './equipment.ts';
import { DURIS_ITEM, type ContainerAccepts, type ContainerRule } from './items.ts';
import { limitOf } from './inventory.ts';
import { stackSlots, type Stack } from './stacks.ts';

/** The deepest a thing may be nested: bag → item. Owner-confirmed, 2026-08-03. */
export const MAX_NESTING_DEPTH = 2;

/**
 * A container instance and what is inside it.
 *
 * Contents are `Stack[]`, so arrows in a quiver stack the same way arrows in a bag do — a quiver
 * holding sixty arrows is three stacks of twenty, not sixty entries.
 */
export interface Held {
  readonly rule: ContainerRule;
  readonly contents: readonly Stack[];
}

/** Whether an item is a container at all. */
export function isContainer(item: Item, rules: (item: Item) => ContainerRule | undefined): boolean {
  return rules(item) !== undefined;
}

/**
 * Whether a container will take a particular item.
 *
 * Two gates, and the second is the depth rule. A restricted container refuses by *type* — Duris' own
 * `ITEM_MISSILE` for a quiver, `ITEM_WEAPON` for a scabbard — which is read off the item's harvested
 * type rather than guessed from its name.
 */
export function accepts(rule: ContainerRule, itemType: number | undefined, itemIsContainer: boolean): boolean {
  // **Depth 2.** A container inside a container is where unbounded storage comes from, and refusing it
  // here is the whole of the fix — there is no depth counter to get wrong because there is no depth
  // to count past two.
  if (itemIsContainer) return false;
  if (rule.accepts === 'any') return true;
  if (rule.accepts === 'missile') return itemType === DURIS_ITEM.missile;
  if (rule.accepts === 'weapon') return itemType === DURIS_ITEM.weapon;
  return false;
}

/** Slots the contents of a container occupy **inside it**. Never against the bag holding it. */
export function usedInside(held: Held): number {
  return held.contents.reduce((total, stack) => total + stackSlots(stack, limitOf(stack.item)), 0);
}

export function freeInside(held: Held): number {
  return Math.max(0, held.rule.capacity - usedInside(held));
}

/**
 * Why something would not go into a container.
 *
 * Three distinct refusals rather than one boolean, because they call for three different sentences and
 * a player who is told "it will not go in" learns nothing about which.
 */
export type PutRefusal = 'not-a-container' | 'wrong-kind' | 'full' | 'too-deep';

export function putRefusal(
  held: Held,
  item: Item,
  itemType: number | undefined,
  itemIsContainer: boolean,
): PutRefusal | undefined {
  if (itemIsContainer) return 'too-deep';
  if (!accepts(held.rule, itemType, itemIsContainer)) return 'wrong-kind';
  if (Math.max(1, item.size) > freeInside(held)) return 'full';
  return undefined;
}

/**
 * What a container's own bulk is, **excluding what is in it**.
 *
 * A one-liner with a name, because the rule it encodes is the entire reason containers exist and a
 * reader who sees `item.size` at a call site cannot tell whether the contents were meant to be counted.
 * They never are. §4.
 */
export function containerBulk(item: Item): number {
  return Math.max(1, item.size);
}

/** How a container reads in a listing: what it is, and how full. */
export function describeContainer(item: Item, held: Held): string {
  const inside = usedInside(held);
  const kind: Record<ContainerAccepts, string> = { any: '', missile: ' (arrows)', weapon: ' (weapons)' };
  return `${item.name}${kind[held.rule.accepts]} [${inside}/${held.rule.capacity}]`;
}

/* -------------------------------------------------------------------------- */
/* Coin                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * **Four currencies, because Duris has four** — owner's call (2026-08-03): *"if Duris has the gold,
 * silver, copper or even platinum mechanics already, let's use all the currency types available."*
 *
 * It does, and the order is not guessable, so it was read rather than assumed. `utils.h`:
 *
 * ```
 * #define GET_COPPER(ch)   ((ch)->points.cash[0])
 * #define GET_SILVER(ch)   ((ch)->points.cash[1])
 * #define GET_GOLD(ch)     ((ch)->points.cash[2])
 * #define GET_PLATINUM(ch) ((ch)->points.cash[3])
 * ```
 *
 * and `actobj.c` pours a money pile into them from `value[0..3]` in exactly that order. The catalogue
 * confirms it: `#420002`, *"a MASSIVE pile of platinum and gold coins"*, carries `0 0 15000 7500` —
 * fifteen thousand gold and seven and a half thousand platinum, with copper and silver at zero.
 * Reading `value[0]` as "the coins" would have made that pile fifteen thousand *coppers* and lost the
 * platinum entirely.
 */
export const CURRENCIES = ['copper', 'silver', 'gold', 'platinum'] as const;

export type Currency = (typeof CURRENCIES)[number];

/** What a character is carrying, by coin. Absent is zero. */
export type Purse = Readonly<Partial<Record<Currency, number>>>;

/**
 * Coins are a **number on the character**, not a stack in the bag.
 *
 * `DESIGN-inventory.md` §8 already says so — *"inventory, equipment and gold persist per character"* —
 * and the alternative is worse in a way that is easy to miss: coins as an item would cost slots, so a
 * player emptying a dungeon would spend their bag on money and have nowhere to put the loot. Duris does
 * the same (`points.cash`), and every Diku since.
 *
 * A money pile is therefore **converted, not carried**: the pile leaves the world and the purse goes
 * up, which is why `ITEM_MONEY` never reaches a `Stack` at all.
 */
export function isMoney(itemType: number | undefined): boolean {
  return itemType === DURIS_ITEM.money;
}

export function emptyPurse(): Purse {
  return {};
}

/**
 * Adds coins of every kind, refusing to go negative or non-finite.
 *
 * Clamped rather than trusted because coin is the one number a bug in either direction is
 * unrecoverable for: a negative purse is a character who can never buy anything again, and one NaN
 * propagates into every total that touches it. A negative *starting* purse is read as empty rather
 * than preserved, so a corrupt save cannot leave someone permanently in debt.
 */
export function addCoins(purse: Purse, gained: Purse): Purse {
  const out: Record<string, number> = {};
  for (const kind of CURRENCIES) {
    const have = purse[kind];
    const more = gained[kind];
    const base = Number.isFinite(have) && (have ?? 0) > 0 ? Math.floor(have!) : 0;
    const add = Number.isFinite(more) && (more ?? 0) > 0 ? Math.floor(more!) : 0;
    const total = base + add;
    if (total > 0) out[kind] = total;
  }
  return out;
}

/** Whether a purse holds anything at all. */
export function purseIsEmpty(purse: Purse): boolean {
  return CURRENCIES.every((kind) => !purse[kind]);
}

/**
 * How a purse reads.
 *
 * **Richest first and zeroes omitted**, because a line reading "0 copper, 0 silver, 3 gold, 0 platinum"
 * buries the one number that matters. Thousands are separated: five figures of gold is otherwise
 * unreadable, and the catalogue has piles of fifteen thousand.
 */
export function describePurse(purse: Purse): string {
  const parts: string[] = [];
  for (const kind of [...CURRENCIES].reverse()) {
    const n = purse[kind] ?? 0;
    if (n > 0) parts.push(`${n.toLocaleString('en-GB')} ${kind}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no coin';
}

/** The coins a money pile is worth, read off its harvested values. */
export function coinsOf(template: { readonly coins?: Purse }): Purse {
  return template.coins ?? {};
}
