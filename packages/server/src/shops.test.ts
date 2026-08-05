/**
 * Shop rules — Phase 17. Pure functions over harvested data, so no simulation is needed.
 *
 * What is *not* here is the buying itself: it lives in `index.ts`, which starts a server on import
 * and has no harness, so it is driven instead. `HANDOFF.md` says why that split is deliberate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemTemplate } from '@mygame/shared';

import { findInStock, priceToBuy, priceToSell, stockOf, willBuy, type Shop } from './shops.ts';

const shop = (over: Partial<Shop> = {}): Shop => ({
  vnum: 1430, keeper: 1430, room: 1443, sells: [1, 2],
  buyPercent: 0.8, sellPercent: 1.1, buysTypes: [9], ...over,
});

const item = (over: Partial<ItemTemplate> = {}): ItemTemplate => ({
  vnum: 1, keywords: ['egg', 'chicken'], name: 'a chicken egg', roomLine: 'x',
  type: 19, ac: 0, size: 1, cost: 24, stackLimit: 1, ...over,
});

describe('what a shop charges and pays', () => {
  it('marks up on the way out and down on the way in', () => {
    // The spread is the whole of a shop. 24 copper at 1.1 is 27 to buy; at 0.8 it is 19 to sell.
    assert.equal(priceToBuy(item(), shop()), 27);
    assert.equal(priceToSell(item(), shop()), 19);
  });

  it('rounds so the keeper never loses to arithmetic', () => {
    // Up on the charge, down on the payment. At the shipped median that is a penny on eleven, and on
    // the cheapest item in the world it is the difference between a price and a gift.
    assert.equal(priceToBuy(item({ cost: 1 }), shop({ sellPercent: 1.1 })), 2);
    assert.equal(priceToSell(item({ cost: 1 }), shop({ buyPercent: 0.8 })), 0);
  });

  it('never prices a sale at nothing, and never invents a penny for worthless goods', () => {
    // A floor of 1 on the charge, because free is not a price. A floor of *0* on the payment, because
    // inventing a penny would make every piece of trash in the world a slow income.
    assert.equal(priceToBuy(item({ cost: 0 }), shop()), 1);
    assert.equal(priceToSell(item({ cost: 0 }), shop()), 0);
  });

  it('buys only the kinds it deals in, and an empty list means nothing', () => {
    // 261 of the 694 keepers buy nothing at all. Reading empty as "anything" would turn every one of
    // them into a fence for the whole catalogue.
    assert.equal(willBuy(shop({ buysTypes: [9] }), item({ type: 9 })), true);
    assert.equal(willBuy(shop({ buysTypes: [9] }), item({ type: 19 })), false);
    assert.equal(willBuy(shop({ buysTypes: [] }), item({ type: 9 })), false);
  });
});

describe('the shelf', () => {
  const catalogue = new Map<number, ItemTemplate>([
    [1, item({ vnum: 1 })],
    [2, item({ vnum: 2, name: 'a bottle', keywords: ['bottle'], type: 17 })],
  ]);

  it('drops stock this server has no catalogue entry for', () => {
    // The `.shp` files name items from areas we may not have loaded. A shelf line nobody can name is
    // worse than a shorter shelf.
    assert.deepEqual(stockOf(shop({ sells: [1, 999, 2] }), catalogue).map((t) => t.vnum), [1, 2]);
  });

  it('finds stock by number, which is what a player reads off the list', () => {
    const stock = stockOf(shop(), catalogue);
    assert.equal(findInStock(stock, '2', () => [])?.vnum, 2, 'one-based, as printed');
    assert.equal(findInStock(stock, '9', () => []), undefined);
  });

  it('finds stock by keyword prefix and by name', () => {
    const stock = stockOf(shop(), catalogue);
    const words = (t: ItemTemplate) => t.keywords;
    assert.equal(findInStock(stock, 'egg', words)?.vnum, 1);
    assert.equal(findInStock(stock, 'bot', words)?.vnum, 2, 'a prefix is enough');
    assert.equal(findInStock(stock, 'chicken egg', () => [])?.vnum, 1, 'and the whole name works too');
    assert.equal(findInStock(stock, '', words), undefined);
  });
});
