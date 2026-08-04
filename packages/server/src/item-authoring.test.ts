import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTHORED_VNUM_BASE, DURIS_ITEM, MAX_ITEM_SIZE } from '@mygame/shared';

import {
  draftAuthoredItem,
  loadAuthoredStore,
  readAuthoredItem,
  saveAuthoredStore,
  takeAuthoredVnum,
  type AuthoredStore,
} from './item-authoring.ts';

const scratch = (): string => join(mkdtempSync(join(tmpdir(), 'authored-')), 'items-authored.json');

/** The smallest draft that is legal — everything else in these tests is this plus one change. */
const sword = {
  name: 'a rune-etched longsword',
  keywords: ['longsword', 'sword', 'rune'],
  type: DURIS_ITEM.weapon,
  slot: 'mainHand',
  damage: { count: 2, sides: 6, bonus: 1 },
  size: 3,
  cost: 900,
};

describe('drafting an item', () => {
  it('fills in what the author should not have to type', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, sword);
    assert.ok('item' in drafted);
    // The room line is Duris' own idiom rather than a second thing to write, and the stack limit is
    // §3's rule about the *type* — not a number a form gets to decide.
    assert.equal(drafted.item.roomLine, 'a rune-etched longsword is lying here.');
    assert.equal(drafted.item.stackLimit, 1);
    assert.equal(drafted.item.vnum, AUTHORED_VNUM_BASE);
  });

  it('takes the stack limit from the type, so two arrows of one vnum cannot disagree', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, {
      ...sword,
      name: 'a black-fletched arrow',
      type: DURIS_ITEM.missile,
    });
    assert.ok('item' in drafted);
    assert.equal(drafted.item.stackLimit, 20);
  });

  it('deduplicates and lowercases the keywords, because the panel diffs against what is stored', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, {
      ...sword,
      keywords: ['Sword', 'sword', '  RUNE  ', ''],
    });
    assert.ok('item' in drafted);
    assert.deepEqual(drafted.item.keywords, ['sword', 'rune']);
  });

  it('refuses a vnum below the reserved base, which is the whole collision argument', () => {
    const drafted = draftAuthoredItem(700_008, sword);
    assert.ok('error' in drafted);
    assert.match(drafted.error, /9000000/);
  });

  it('refuses a draft with no keywords — nothing a player types would find it', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, { ...sword, keywords: [] });
    assert.ok('error' in drafted);
    assert.match(drafted.error, /keyword/);
  });

  it('refuses a type outside the catalogue vocabulary', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, { ...sword, type: 999 });
    assert.ok('error' in drafted);
    assert.match(drafted.error, /type/);
  });

  it('refuses a slot we do not model, rather than accepting one the doll cannot draw', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, { ...sword, slot: 'tail' });
    assert.ok('error' in drafted);
    assert.match(drafted.error, /tail/);
  });

  it('refuses malformed dice instead of dropping them — a weapon that silently does nothing reads as a balance bug', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, { ...sword, damage: '2d6' });
    assert.ok('error' in drafted);
    assert.match(drafted.error, /dice/);
  });

  it('refuses a size past the half-a-bag cap', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, { ...sword, size: MAX_ITEM_SIZE + 1 });
    assert.ok('error' in drafted);
    assert.match(drafted.error, /size/);
  });

  it('allows a carried-only item, which is most of the catalogue', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, {
      name: 'a scrap of vellum',
      keywords: ['vellum', 'scrap'],
      type: DURIS_ITEM.treasure,
    });
    assert.ok('item' in drafted);
    assert.equal(drafted.item.slot, undefined);
    assert.equal(drafted.item.ac, 0);
    assert.equal(drafted.item.size, 1);
    assert.equal(drafted.item.cost, 0);
  });

  it('keeps a container rule, and defaults what it accepts rather than refusing', () => {
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, {
      name: 'a battered satchel',
      keywords: ['satchel'],
      type: DURIS_ITEM.container,
      container: { capacity: 12 },
    });
    assert.ok('item' in drafted);
    assert.deepEqual(drafted.item.container, { capacity: 12, accepts: 'any' });
  });
});

/** A store holding exactly one item, at the given vnum. */
const storeWith = (vnum: number): AuthoredStore => {
  const drafted = draftAuthoredItem(vnum, sword);
  assert.ok('item' in drafted);
  return { items: new Map([[vnum, { item: drafted.item }]]), next: vnum + 1 };
};

describe('the overlay file', () => {
  it('round-trips a record through disk unchanged', () => {
    const file = scratch();
    const drafted = draftAuthoredItem(AUTHORED_VNUM_BASE, sword);
    assert.ok('item' in drafted);
    saveAuthoredStore(
      {
        items: new Map([[AUTHORED_VNUM_BASE, { item: drafted.item, at: '2026-08-04T12:00:00.000Z', by: 'test' }]]),
        next: AUTHORED_VNUM_BASE + 1,
      },
      file,
    );

    const back = loadAuthoredStore(file);
    assert.equal(back.items.size, 1);
    assert.deepEqual(back.items.get(AUTHORED_VNUM_BASE)?.item, drafted.item);
    assert.equal(back.items.get(AUTHORED_VNUM_BASE)?.by, 'test');
    assert.equal(back.next, AUTHORED_VNUM_BASE + 1);
  });

  it('writes the vnum into the body as well as the key, so a copied record still says what it is', () => {
    const file = scratch();
    saveAuthoredStore(storeWith(AUTHORED_VNUM_BASE), file);
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { items: Record<string, { vnum: number }> };
    assert.equal(raw.items[String(AUTHORED_VNUM_BASE)]?.vnum, AUTHORED_VNUM_BASE);
  });

  it('drops a hand-edited record that is not whole, rather than letting a half-built template reach the catalogue', () => {
    const file = scratch();
    writeFileSync(
      file,
      JSON.stringify({
        next: AUTHORED_VNUM_BASE + 2,
        items: {
          [AUTHORED_VNUM_BASE]: { name: 'a nameless thing', type: DURIS_ITEM.weapon },
          [AUTHORED_VNUM_BASE + 1]: { ...sword, vnum: AUTHORED_VNUM_BASE + 1 },
        },
      }),
    );
    const loaded = loadAuthoredStore(file);
    // The first has no keywords, so nothing a player types would ever find it.
    assert.equal(loaded.items.has(AUTHORED_VNUM_BASE), false);
    assert.equal(loaded.items.has(AUTHORED_VNUM_BASE + 1), true);
  });

  it('treats a missing file as nothing created, which is the ordinary case', () => {
    const empty = loadAuthoredStore(join(tmpdir(), 'no-such-authored-items.json'));
    assert.equal(empty.items.size, 0);
    assert.equal(empty.next, AUTHORED_VNUM_BASE);
  });

  it('validates a hand-edited file through the same door a form POST uses', () => {
    // Not a laxer reader: a vnum below the base is refused on disk exactly as it is over HTTP.
    assert.equal(readAuthoredItem(12, { ...sword, vnum: 12 }), undefined);
    assert.notEqual(readAuthoredItem(AUTHORED_VNUM_BASE, sword), undefined);
  });

  it('raises a hand-edited counter that is behind the records it holds', () => {
    // Wrong in the safe direction is the only direction an allocator may be wrong in.
    const file = scratch();
    writeFileSync(
      file,
      JSON.stringify({ next: AUTHORED_VNUM_BASE, items: { [AUTHORED_VNUM_BASE + 9]: { ...sword, vnum: AUTHORED_VNUM_BASE + 9 } } }),
    );
    assert.equal(loadAuthoredStore(file).next, AUTHORED_VNUM_BASE + 10);
  });
});

describe('handing out numbers', () => {
  it('starts at the reserved base', () => {
    const store: AuthoredStore = { items: new Map(), next: AUTHORED_VNUM_BASE };
    assert.equal(takeAuthoredVnum(store), AUTHORED_VNUM_BASE);
  });

  it('advances the counter as it hands one out, so the same number cannot go twice', () => {
    const store: AuthoredStore = { items: new Map(), next: AUTHORED_VNUM_BASE };
    assert.equal(takeAuthoredVnum(store), AUTHORED_VNUM_BASE);
    assert.equal(takeAuthoredVnum(store), AUTHORED_VNUM_BASE + 1);
  });

  it('does not free a number when the highest item is deleted — the reason the counter is stored', () => {
    // Derived from the records this would fall back to the base; a saved bag or a spawn overlay naming
    // the deleted vnum would then point at whatever was created next.
    const store = storeWith(AUTHORED_VNUM_BASE);
    store.items.delete(AUTHORED_VNUM_BASE);
    assert.equal(takeAuthoredVnum(store), AUTHORED_VNUM_BASE + 1);
  });

  it('survives the counter through a save and load, delete and all', () => {
    const file = scratch();
    const store = storeWith(AUTHORED_VNUM_BASE);
    store.items.delete(AUTHORED_VNUM_BASE);
    saveAuthoredStore(store, file);
    assert.equal(loadAuthoredStore(file).next, AUTHORED_VNUM_BASE + 1);
  });
});
