/**
 * The `.shp` reader — Phase 17.
 *
 * The format is `boot_the_shops` in `shop.c` and the tests below are written against what that
 * function does rather than against what the files look like, for the reason `objects.test.ts` gives:
 * the files are conventionally laid out and the reader is not, so a parser that agrees with the
 * layout can still disagree with the source.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  MAX_BUY_PERCENT,
  MIN_SELL_PERCENT,
  clampSpread,
  loadShops,
  parseShopFile,
} from './shops.ts';

/** A record in the shape `boot_the_shops` reads, with the seven messages it uses as landmarks. */
function shopRecord(over: Partial<{ vnum: number; sells: number[]; buy: string; sell: string; types: number[]; keeper: number; room: number }> = {}): string {
  const { vnum = 5715, sells = [312, 363], buy = '0.80', sell = '1.10', types = [9, 5], keeper = 5715, room = 5770 } = over;
  return [
    `#${vnum}~`,
    'N',
    ...sells.map(String),
    '0',
    buy,
    sell,
    ...types.map(String),
    '0',
    '%s I am not selling that.~',
    '%s You do not have that item.~',
    '%s I will not buy that.~',
    '%s I have no money.~',
    '%s You have no money.~',
    '%s Thank you, that will be %s.~',
    '%s I will give you %s.~',
    '0',
    '0',
    String(keeper),
    '0',
    String(room),
    '0',
    '28',
    '0',
    '28',
    'N',
    'N',
    'Y',
    'I am open!~',
    'I am closed!~',
  ].join('\n');
}

function write(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-shp-'));
  const path = join(dir, 'test.shp');
  writeFileSync(path, text, 'latin1');
  return path;
}

describe('reading a shop', () => {
  it('takes the keeper, the stock and the two percentages', () => {
    const [shop] = parseShopFile(write(shopRecord()));
    assert.ok(shop);
    assert.equal(shop.vnum, 5715);
    assert.equal(shop.keeper, 5715, 'the mob vnum, which is the join key');
    assert.equal(shop.room, 5770);
    assert.deepEqual(shop.sells, [312, 363], 'in the file’s own order');
    assert.equal(shop.buyPercent, 0.8);
    assert.equal(shop.sellPercent, 1.1);
    assert.deepEqual(shop.buysTypes, [9, 5]);
  });

  it('reads several records out of one file', () => {
    const shops = parseShopFile(write([shopRecord({ vnum: 1, keeper: 11 }), shopRecord({ vnum: 2, keeper: 22 })].join('\n')));
    assert.deepEqual(shops.map((s) => s.keeper), [11, 22]);
  });

  it('survives a numeric run that flows across line breaks', () => {
    // `fscanf(" %d ")` skips any whitespace including newlines, so the source does not care where the
    // breaks fall — and neither may this. Same trap `objects.ts` documents for the `.obj` files.
    const packed = shopRecord().replace('312\n363', '312 363');
    const [shop] = parseShopFile(write(packed));
    assert.deepEqual(shop?.sells, [312, 363]);
  });

  it('reads a shop that sells nothing and one that buys nothing', () => {
    const [empty] = parseShopFile(write(shopRecord({ sells: [] })));
    assert.deepEqual(empty?.sells, []);
    const [nobuy] = parseShopFile(write(shopRecord({ types: [] })));
    assert.deepEqual(nobuy?.buysTypes, [], 'an empty trade list is an answer, not a parse failure');
  });

  it('skips a record it does not understand rather than guessing', () => {
    // Fewer than eight `~` means the seven messages are not all there, and every other field in the
    // record is a bare number — so there is no landmark left to read outward from.
    assert.deepEqual(parseShopFile(write('#99~\nN\n312\n0\n0.8\n1.1\n0\n')), []);
  });
});

describe('the spread, clamped as Duris clamps it', () => {
  it('caps what a keeper will pay, which is the anti-arbitrage rule', () => {
    // `shop.c`: "with a buy% > .7, it is possible for high charisma players to MAKE money
    // buying/selling ... it's called a bug". The cap is the fix, and it is the source's.
    assert.equal(clampSpread(0.95, 1.5).buyPercent, MAX_BUY_PERCENT);
    assert.equal(clampSpread(0.01, 1.5).buyPercent, 0.05);
  });

  it('never lets a keeper sell below cost', () => {
    assert.equal(clampSpread(0.5, 0.2).sellPercent, MIN_SELL_PERCENT);
    assert.equal(clampSpread(0.5, 99).sellPercent, 10);
  });

  it('cannot produce a spread that pays more than it charges', () => {
    // **The repair branch in `shop.c` is unreachable, and that is worth knowing rather than
    // discovering.** The source clamps sell into [1.0, 10.0] and buy into [0.05, 0.8] and *then*
    // tests `sell <= buy` — which by that point cannot be true, since the floor of one is above the
    // ceiling of the other. The branch is transcribed anyway, because the clamps and the repair are
    // one rule and dropping half of it would be a divergence nobody had decided on; but the property
    // that actually holds is this one, so this is what is asserted.
    //
    // Measured against the shipped world: 0 of 720 records come out inverted.
    for (const [b, s] of [[0.8, 1.0], [0.8, 0.1], [0.5, 0.5], [0.05, 1.0], [0.8, 7.5], [0.95, 0.2], [2, 2]] as const) {
      const out = clampSpread(b, s);
      assert.ok(out.sellPercent > out.buyPercent, `${b}/${s} came out as ${out.sellPercent}/${out.buyPercent}`);
    }
  });

  it('leaves a spread that is already legal exactly alone', () => {
    // The common case by a distance: the shipped world's median shop is 0.80 / 1.10, and a harvest
    // that quietly moved those would be retuning 694 shops nobody asked to retune.
    assert.deepEqual(clampSpread(0.8, 1.1), { buyPercent: 0.8, sellPercent: 1.1 });
    assert.deepEqual(clampSpread(0.5, 3), { buyPercent: 0.5, sellPercent: 3 });
  });
});

describe('a directory of shop files', () => {
  it('keys by keeper and keeps the first of a duplicate', () => {
    // `world.shp` and the per-area files overlap; the source boots one stream. Keeping the first is
    // what makes the answer stable across a re-run rather than dependent on directory order.
    const dir = mkdtempSync(join(tmpdir(), 'mygame-shpdir-'));
    writeFileSync(join(dir, 'a.shp'), [shopRecord({ vnum: 1, keeper: 7, sells: [100] }), shopRecord({ vnum: 2, keeper: 7, sells: [200] })].join('\n'), 'latin1');
    const shops = loadShops(dir);
    assert.equal(shops.size, 1);
    assert.deepEqual(shops.get(7)?.sells, [100]);
  });
});
