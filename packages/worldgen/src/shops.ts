/**
 * Shops, harvested from Duris' own `.shp` files — Phase 17.
 *
 * ## The format, from `boot_the_shops` in `shop.c`
 *
 * ```
 * #<vnum>~
 * N                      the "new format" marker; the source *fatally errors* on anything else
 * <produced vnum> …      what the keeper sells, terminated by a non-positive number
 * <buy percent>          what the keeper pays you, as a fraction of the item's cost
 * <sell percent>         what the keeper charges you, as a multiple of it
 * <trade type> …         which item types it will buy from you
 * <seven ~-terminated messages>
 * <temper1> <temper2> <keeper mob vnum> <with_who> <in_room> <open1> <close1> <open2> <close2>
 * …flags and two more messages
 * ```
 *
 * **The numbers are read with `fscanf` again**, so the same trap `objects.ts` documents applies: the
 * run flows across line breaks and must be tokenised as one stream rather than parsed line by line.
 * The seven messages are what separates the two numeric runs, and they are the only reliable
 * landmark in the record — which is why this parser finds them first and reads outward.
 *
 * ## What is kept, and what is deliberately dropped
 *
 * Kept: **who keeps the shop, what it sells, and the two percentages.** Those four are the whole of
 * buying and selling.
 *
 * Dropped, with reasons rather than by omission:
 *
 * - **The seven refusal messages.** They are `printf` templates with `%s` holes the source fills with
 *   a name and a price, and our prose is rendered per recipient through `act()`. Carrying somebody
 *   else's format strings would mean either running `printf` in the simulation or storing sentences
 *   we never say.
 * - **Opening hours.** There is no clock in this game yet — no `time_info`, no day — so a shop that
 *   closed at 28 o'clock would be a rule nothing could evaluate. `ROADMAP.md` rule 1 exactly.
 * - **`racist`, `with_who` and the race gate.** Races are Phase 21. A gate with no races to check is
 *   a field with no reader.
 * - **Roaming, magic and killability flags.** Each is a rule about a mechanic we do not have.
 *
 * ## The spread is the interesting number, and the source explains itself
 *
 * `boot_the_shops` clamps `buy_percent` to **0.8** and `sell_percent` to at least **1.0**, and the
 * comment says why in as many words: *"with a buy% > .7, it is possible for high charisma players to
 * MAKE money buying/selling … when the places you can do it are in the same city, and the shops
 * CAN'T go out of business, it's called a bug"*. So the clamps are not tidiness, they are the
 * anti-arbitrage rule, and they are transcribed rather than re-derived.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** What a keeper will pay, at most — `shop.c`'s own clamp, and the reason is anti-arbitrage. */
export const MAX_BUY_PERCENT = 0.8;
export const MIN_BUY_PERCENT = 0.05;
/** What a keeper will charge, at least. Below 1.0 it would be selling at a loss. */
export const MIN_SELL_PERCENT = 1.0;
export const MAX_SELL_PERCENT = 10.0;

/** One shop, as the file states it and as the server needs it. */
export interface Shop {
  /** The shop's own vnum, kept for traceability back to the `.shp` record. */
  readonly vnum: number;
  /** The **mob** vnum that keeps it. This is the join key: a mob is a shopkeeper or it is not. */
  readonly keeper: number;
  /** The room the shop is in, as the file states it. Kept for reporting, not for the rule. */
  readonly room: number;
  /** Item vnums it sells, in the file's own order. Stock is unlimited, as it is in Duris. */
  readonly sells: readonly number[];
  /** Fraction of an item's cost the keeper pays you. Clamped as the source clamps it. */
  readonly buyPercent: number;
  /** Multiple of an item's cost the keeper charges you. */
  readonly sellPercent: number;
  /** Duris' `ITEM_*` types the keeper will buy from you. Empty means it buys nothing. */
  readonly buysTypes: readonly number[];
}

/**
 * Duris' own clamps, applied in its own order.
 *
 * **The repair at the end is unreachable, and that is worth writing down rather than leaving to be
 * discovered.** The source clamps sell into `[1.0, 10.0]` and buy into `[0.05, 0.8]` and *then* tests
 * `sell <= buy` — which by that point cannot hold, because the floor of one is above the ceiling of
 * the other. It is transcribed anyway: the clamps and the repair are one rule in one function, and
 * keeping half of it would be a silent divergence rather than a decision. Measured across the shipped
 * world, 0 of 720 records come out inverted.
 *
 * The clamps themselves are load-bearing and the source says why: *"with a buy% > .7, it is possible
 * for high charisma players to MAKE money buying/selling … when the places you can do it are in the
 * same city, and the shops CAN'T go out of business, it's called a bug"*.
 */
export function clampSpread(buy: number, sell: number): { buyPercent: number; sellPercent: number } {
  let sellPercent = Math.min(MAX_SELL_PERCENT, Math.max(MIN_SELL_PERCENT, sell));
  let buyPercent = Math.min(MAX_BUY_PERCENT, Math.max(MIN_BUY_PERCENT, buy));
  if (sellPercent <= buyPercent) {
    if (sellPercent > 7.0) buyPercent = sellPercent - 1.0;
    else sellPercent = buyPercent + 0.25;
  }
  return { buyPercent, sellPercent };
}

/**
 * One `.shp` file, parsed.
 *
 * Records are split on `#<vnum>~`, and inside a record the **seven messages are found first**: they
 * are the only landmark that cannot be confused with data, since every other field is a bare number.
 * Everything before them is the produced list and the percentages; everything after is the keeper
 * and its room.
 */
export function parseShopFile(path: string): Shop[] {
  // `latin1` for the same reason every other Duris reader here uses it: the files carry high-bit
  // bytes inside colour runs, and decoding as UTF-8 replaces them with U+FFFD.
  const text = readFileSync(path, 'latin1');
  const starts = [...text.matchAll(/#(\d+)~/g)];
  const out: Shop[] = [];

  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const body = text.slice(start.index, i + 1 < starts.length ? starts[i + 1]!.index : text.length);
    const tildes = [...body.matchAll(/~/g)].map((m) => m.index);
    // The record's own `#vnum~` is the first, then the seven messages. Fewer than eight and this is
    // not a record we understand — skipped rather than guessed at.
    if (tildes.length < 8) continue;

    const head = body.slice(tildes[0]! + 1, tildes[1]!).trim();
    const tail = body.slice(tildes[7]! + 1).trim();

    // The head begins with the `N` marker; everything after it is the numeric run.
    const headNumbers = head
      .replace(/^\s*N\s*/, '')
      .split(/\s+/)
      .map(Number)
      .filter((n) => Number.isFinite(n));
    if (headNumbers.length < 3) continue;

    // Produced vnums up to the terminator, then the two percentages, then the trade types.
    const end = headNumbers.findIndex((n) => n <= 0);
    if (end < 0) continue;
    const sells = headNumbers.slice(0, end);
    const buy = headNumbers[end + 1];
    const sell = headNumbers[end + 2];
    if (buy === undefined || sell === undefined) continue;
    // The trade list runs to its own terminator. `0` is `ITEM_UNDEFINED` and is what an empty list
    // looks like, so a shop that buys nothing is a real answer rather than a parse failure.
    const buysTypes = headNumbers.slice(end + 3).filter((n) => n > 0);

    const tailNumbers = tail.split(/\s+/).map(Number);
    // temper1, temper2, keeper, with_who, in_room — the order `boot_the_shops` reads them in.
    const keeper = tailNumbers[2];
    const room = tailNumbers[4];
    if (!Number.isFinite(keeper) || !Number.isFinite(room)) continue;

    out.push({
      vnum: Number(start[1]),
      keeper: keeper!,
      room: room!,
      sells,
      ...clampSpread(buy, sell),
      buysTypes,
    });
  }
  return out;
}

/** Every shop in a directory of `.shp` files, keyed by the mob that keeps it. */
export function loadShops(dir: string): Map<number, Shop> {
  const byKeeper = new Map<number, Shop>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.shp'))) {
    for (const shop of parseShopFile(join(dir, file))) {
      // **First wins, and duplicates are real**: `world.shp` and the per-area files overlap, and the
      // source itself boots one stream. Keeping the first keeps the answer stable across a re-run.
      if (!byKeeper.has(shop.keeper)) byKeeper.set(shop.keeper, shop);
    }
  }
  return byKeeper;
}
