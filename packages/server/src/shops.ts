/**
 * Shopkeepers — Phase 17, the rules half.
 *
 * `worldgen/shops.ts` harvested 694 of them out of Duris' `.shp` files; this is what the game does
 * with one. The split is the same the catalogue keeps: worldgen decides what the world *contains*,
 * the server decides what happens when somebody walks up to it.
 *
 * ## A shopkeeper is a mob vnum, and that is the whole of it
 *
 * No flag on the instance, no second kind of actor. The shop file names a **mob vnum** and this
 * module answers *"is the thing I am standing in front of a keeper"* by looking that vnum up. Three
 * consequences fall out for free: a keeper that wanders is still a keeper, killing one and letting the
 * zone repop gives you a new one that still trades, and A4's spawn tooling can place a working shop
 * without knowing shops exist.
 *
 * ## Stock is unlimited, and that is Duris' rule rather than a shortcut
 *
 * `producing` in the source is exactly that — the keeper *produces* the item, it does not hold one.
 * So buying never depletes anything and there is no restock clock to write. The interesting
 * consequence is the one worth stating: **what you sell a keeper does not go on its shelf.** Duris
 * keeps sold goods in the keeper's inventory and lets you buy them back; we do not model that yet, so
 * a sale is a sale and the item is gone. Said out loud because "I sold it by mistake, buy it back" is
 * the first thing somebody will try.
 *
 * ## The spread
 *
 * `sellPercent` is what you are charged, `buyPercent` is what you are paid, and the harvest clamps
 * them so the second is always below the first — `shop.c`'s own anti-arbitrage rule, with its own
 * comment explaining that a keeper paying more than it charges is a money printer rather than
 * commerce. Prices are in **copper**, because an item's `cost` is.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { stripColour } from '@mygame/shared';
import type { ItemTemplate } from '@mygame/shared';

import { WORLD_DIR } from './world.ts';

/** Where `npm run worldgen` writes the harvest. One file for the world, like the catalogue. */
export const SHOPS_FILE = join(WORLD_DIR, 'shops.json');

/**
 * The authored shops — Phase 23's anchor keepers, committed beside the other authored overlays.
 * Same record shape as the harvest; {@link loadShops} reads it with the same tolerant eye, and the
 * caller lays it over the harvest map so an authored keeper vnum can never be shadowed by a
 * harvested one (the bands cannot collide — 9,000,000 against a harvest that tops out five digits
 * lower — but the ordering states the intent).
 */
export const AUTHORED_SHOPS_FILE = join(WORLD_DIR, 'overrides', 'shops-authored.json');

/** One shop, exactly as worldgen emits it. */
export interface Shop {
  readonly vnum: number;
  readonly keeper: number;
  readonly room: number;
  readonly sells: readonly number[];
  readonly buyPercent: number;
  readonly sellPercent: number;
  readonly buysTypes: readonly number[];
}

/**
 * Reads the harvest, keyed by keeper.
 *
 * Missing file is an empty map rather than a throw, the same posture every other Duris-derived
 * loader here takes: `data/` is git-ignored and reproducible, so a checkout without it is a world
 * with no shops in it, not a server that will not boot.
 */
export function loadShops(file = SHOPS_FILE): Map<number, Shop> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
  const out = new Map<number, Shop>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw as Shop[]) {
    // Blind-cast off a hand-editable file, so the shape is checked rather than trusted — the same
    // guard `keywords` needed after a throw inside `wear` took the whole server down.
    if (typeof entry?.keeper !== 'number' || !Array.isArray(entry.sells)) continue;
    out.set(entry.keeper, entry);
  }
  return out;
}

/**
 * What the keeper charges for one of these, in copper.
 *
 * Rounded **up**, so a keeper never sells at a loss to rounding. At the shipped median of 1.10 that
 * is a penny on eleven, which nobody will notice; on the cheapest item in the world it is the
 * difference between a price and a gift.
 *
 * **Phase 21: charisma tilts the spread** — two percent a modifier point, CHA's first reader
 * (DESIGN-characters.md §2). Duris does this through `CHA_APP(ch).prices`; ours rides the SRD
 * modifier instead, so a +3 face pays 94 on the hundred and a −2 lout pays 104. Zero for the
 * identity-less, who shop exactly as they did before the phase.
 */
export function priceToBuy(template: ItemTemplate, shop: Shop, chaMod = 0): number {
  return Math.max(1, Math.ceil(template.cost * shop.sellPercent * (1 - chaMod * 0.02)));
}

/**
 * What the keeper pays you for one of these, in copper.
 *
 * Rounded **down**, for the mirror of the reason above, and floored at zero rather than at one: an
 * item the world says is worth nothing fetches nothing, and inventing a penny for it would make
 * every piece of trash in the world a slow income.
 *
 * Charisma raises this end of the spread too — and is then **clamped below what the same charmer
 * would be charged**, because the harvest's anti-arbitrage rule (`shop.c`'s own) must survive the
 * tilt: a face good enough to be paid more than the shelf price would be a money printer with
 * dimples.
 */
export function priceToSell(template: ItemTemplate, shop: Shop, chaMod = 0): number {
  const paid = Math.floor(template.cost * shop.buyPercent * (1 + chaMod * 0.02));
  if (chaMod <= 0) return Math.max(0, paid); // untinted, the harvest's own clamp is the guarantee
  const ceiling = Math.max(0, priceToBuy(template, shop, chaMod) - 1);
  return Math.max(0, Math.min(paid, ceiling));
}

/**
 * Whether this keeper deals in this kind of thing at all.
 *
 * An **empty list means it buys nothing**, which is 261 of the 694 and a real answer rather than a
 * missing one: plenty of Duris' keepers only sell. Reading empty as "anything" would turn every one
 * of them into a fence for the whole catalogue.
 */
export function willBuy(shop: Shop, template: ItemTemplate): boolean {
  return shop.buysTypes.includes(template.type);
}

/**
 * The keeper's stock, resolved against the catalogue.
 *
 * A vnum with no catalogue entry is dropped rather than shown as a blank line: the `.shp` files name
 * items from areas this server may not have loaded, and a shelf listing something nobody can name is
 * worse than a shorter shelf.
 */
export function stockOf(shop: Shop, items: ReadonlyMap<number, ItemTemplate>): ItemTemplate[] {
  const out: ItemTemplate[] = [];
  for (const vnum of shop.sells) {
    const template = items.get(vnum);
    if (template) out.push(template);
  }
  return out;
}

/**
 * Which of a keeper's stock a typed word means.
 *
 * **Matched on the same union `keywords.ts` built** — authored keywords plus the name split, colour
 * stripped — because a player typing `buy sword` in a shop is doing exactly what they do typing
 * `get sword` on a floor, and two answers to "which one is that" is how a game gets a reputation for
 * not listening. Numbered too: `buy 2` is the second thing on the list, which is what a player reads
 * off the screen and what every Diku shop has always accepted.
 */
export function findInStock(
  stock: readonly ItemTemplate[],
  term: string,
  wordsOf: (template: ItemTemplate) => readonly string[],
): ItemTemplate | undefined {
  const wanted = stripColour(term).trim().toLowerCase();
  if (!wanted) return undefined;

  // A bare number is an index into the list as printed, one-based.
  if (/^\d+$/.test(wanted)) return stock[Number(wanted) - 1];

  for (const template of stock) {
    if (wordsOf(template).some((word) => word.toLowerCase().startsWith(wanted))) return template;
  }
  // Then the whole name, so `buy long thin flaming` works on something whose keywords are terser.
  return stock.find((template) => stripColour(template.name).toLowerCase().includes(wanted));
}
