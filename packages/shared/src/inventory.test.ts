import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Item } from './equipment.ts';
import {
  STARTING_CAPACITY,
  carry,
  emptyInventory,
  fits,
  matchInventory,
  readInventory,
  removeAt,
  slotsFree,
  slotsUsed,
} from './inventory.ts';

function item(id: string, size: number, name = id): Item {
  return { id, name, slot: 'chest', ac: 0, size };
}

/** Reads an item back the way the server's own loader does — enough shape to be an item. */
function readItem(value: unknown): Item | undefined {
  const v = value as Partial<Item> | null;
  if (typeof v !== 'object' || v === null) return undefined;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.size !== 'number') return undefined;
  return { id: v.id, name: v.name, slot: 'chest', ac: v.ac ?? 0, size: v.size };
}

describe('slots are bulk, not count', () => {
  it('charges each item its own size', () => {
    // `DESIGN-inventory.md` §2: a breastplate might cost ten of your twenty where a dagger costs one.
    const bag = { items: [item('breastplate', 10), item('dagger', 1)], capacity: STARTING_CAPACITY };
    assert.equal(slotsUsed(bag), 11);
    assert.equal(slotsFree(bag), 9);
  });

  it('starts empty at the design doc\'s own twenty', () => {
    assert.equal(emptyInventory().capacity, 20);
    assert.equal(slotsUsed(emptyInventory()), 0);
  });

  it('treats a sizeless item as one slot rather than as free', () => {
    // A kit written before 15b has no `size`. Zero would make it weightless and infinitely stackable.
    const bag = { items: [item('old', 0)], capacity: 20 };
    assert.equal(slotsUsed(bag), 1);
  });
});

describe('a full bag refuses', () => {
  it('names what would not fit and how many slots it needed', () => {
    // §7, and the message is the requirement: the alternatives are dropping the item on the floor by
    // heuristic or discarding it silently, and both lose a quest object to something invisible.
    const bag = { items: [item('anvil', 19)], capacity: 20 };
    const result = carry(bag, item('breastplate', 10));
    assert.deepEqual(result, { needed: 10, free: 1 });
  });

  it('leaves the bag untouched when it refuses', () => {
    const bag = { items: [item('anvil', 19)], capacity: 20 };
    carry(bag, item('breastplate', 10));
    assert.equal(bag.items.length, 1, 'the caller still holds exactly what it held');
  });

  it('accepts the thing that exactly fills it', () => {
    const bag = { items: [item('anvil', 19)], capacity: 20 };
    const result = carry(bag, item('pin', 1));
    assert.ok('items' in result);
    assert.equal(slotsFree(result as { items: Item[]; capacity: number }), 0);
  });

  it('agrees with `fits`, which is the cheap question asked before the expensive one', () => {
    const bag = { items: [item('anvil', 19)], capacity: 20 };
    assert.equal(fits(bag, item('pin', 1)), true);
    assert.equal(fits(bag, item('breastplate', 10)), false);
  });
});

describe('taking something out', () => {
  it('removes the one at that position, not the first with the same name', () => {
    // Two identical items are two items: a character with three daggers who drops one must drop one,
    // and matching on id would make *which* unanswerable.
    const bag = { items: [item('dagger', 1), item('dagger', 1), item('rope', 2)], capacity: 20 };
    const out = removeAt(bag, 1);
    assert.ok(out);
    assert.equal(out.inventory.items.length, 2);
    assert.deepEqual(out.inventory.items.map((i) => i.id), ['dagger', 'rope']);
  });

  it('answers nothing for a position that is not there', () => {
    assert.equal(removeAt(emptyInventory(), 0), undefined);
    assert.equal(removeAt({ items: [item('a', 1)], capacity: 20 }, 5), undefined);
  });
});

describe('naming something in the bag', () => {
  it('matches a word of the display name, which is what a player can see', () => {
    const bag = { items: [item('leather_tunic', 3, 'a leather tunic')], capacity: 20 };
    assert.equal(matchInventory(bag, 'tunic'), 0);
    assert.equal(matchInventory(bag, 'leather'), 0);
    assert.equal(matchInventory(bag, 'LEATHER'), 0);
  });

  it('matches the id too, so a script can be exact', () => {
    const bag = { items: [item('leather_tunic', 3, 'a leather tunic')], capacity: 20 };
    assert.equal(matchInventory(bag, 'leather_tunic'), 0);
  });

  it('takes the first match, the only ordering a player can predict', () => {
    const bag = { items: [item('a', 1, 'a rusty dagger'), item('b', 1, 'a fine dagger')], capacity: 20 };
    assert.equal(matchInventory(bag, 'dagger'), 0);
  });

  it('answers -1 for nothing, rather than 0 which is a real position', () => {
    assert.equal(matchInventory({ items: [item('a', 1)], capacity: 20 }, 'sword'), -1);
    assert.equal(matchInventory({ items: [item('a', 1)], capacity: 20 }, '   '), -1);
  });

  it('does not match a partial word, which would make "a" mean everything', () => {
    const bag = { items: [item('a', 1, 'a leather tunic')], capacity: 20 };
    assert.equal(matchInventory(bag, 'tun'), -1);
  });
});

describe('reading a bag off disk', () => {
  it('round-trips', () => {
    const bag = { items: [item('rope', 2, 'a coil of rope')], capacity: 20 };
    assert.deepEqual(readInventory(JSON.parse(JSON.stringify(bag)), readItem), bag);
  });

  it('survives nonsense, and keeps the default capacity', () => {
    for (const junk of [null, 'a string', 42, []]) {
      assert.deepEqual(readInventory(junk, readItem), emptyInventory());
    }
    assert.equal(readInventory({ items: [], capacity: -5 }, readItem).capacity, STARTING_CAPACITY);
  });

  it('drops malformed items rather than admitting one with no size', () => {
    const read = readInventory({ items: [{ id: 'x', name: 'x' }, { id: 'y', name: 'y', size: 2 }] }, readItem);
    assert.deepEqual(read.items.map((i) => i.id), ['y']);
  });
});
