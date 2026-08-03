import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Item } from './equipment.ts';
import {
  STARTING_CAPACITY,
  carry,
  emptyInventory,
  fits,
  loose,
  matchInventory,
  readInventory,
  removeAt,
  slotsFree,
  slotsUsed,
  stackOf,
  type Inventory,
} from './inventory.ts';
import type { Stack } from './stacks.ts';

function item(id: string, size: number, name = id): Item {
  return { id, name, slot: 'chest', ac: 0, size };
}

/** Reads an item back the way the server's own loader does — enough shape to be an item. */
function readItem(value: unknown): Item | undefined {
  const v = value as Partial<Item> | null;
  if (typeof v !== 'object' || v === null) return undefined;
  if (typeof v.id !== 'string' || typeof v.name !== 'string' || typeof v.size !== 'number') return undefined;
  return {
    id: v.id,
    name: v.name,
    slot: 'chest',
    ac: v.ac ?? 0,
    size: v.size,
    // Carried through, because a reader that drops them turns a saved stack back into loose items.
    ...(v.stackLimit === undefined ? {} : { stackLimit: v.stackLimit }),
    ...(v.uses === undefined ? {} : { uses: v.uses }),
  };
}

describe('slots are bulk, not count', () => {
  it('charges each item its own size', () => {
    // `DESIGN-inventory.md` §2: a breastplate might cost ten of your twenty where a dagger costs one.
    const bag = { stacks: [stackOf(item('breastplate', 10)), stackOf(item('dagger', 1))], capacity: STARTING_CAPACITY };
    assert.equal(slotsUsed(bag), 11);
    assert.equal(slotsFree(bag), 9);
  });

  it('starts empty at the design doc\'s own twenty', () => {
    assert.equal(emptyInventory().capacity, 20);
    assert.equal(slotsUsed(emptyInventory()), 0);
  });

  it('treats a sizeless item as one slot rather than as free', () => {
    // A kit written before 15b has no `size`. Zero would make it weightless and infinitely stackable.
    const bag = { stacks: [stackOf(item('old', 0))], capacity: 20 };
    assert.equal(slotsUsed(bag), 1);
  });
});

describe('a full bag refuses', () => {
  it('names what would not fit and how many slots it needed', () => {
    // §7, and the message is the requirement: the alternatives are dropping the item on the floor by
    // heuristic or discarding it silently, and both lose a quest object to something invisible.
    const bag = { stacks: [stackOf(item('anvil', 19))], capacity: 20 };
    const result = carry(bag, item('breastplate', 10));
    assert.deepEqual(result, { needed: 10, free: 1 });
  });

  it('leaves the bag untouched when it refuses', () => {
    const bag = { stacks: [stackOf(item('anvil', 19))], capacity: 20 };
    carry(bag, item('breastplate', 10));
    assert.equal(bag.stacks.length, 1, 'the caller still holds exactly what it held');
  });

  it('accepts the thing that exactly fills it', () => {
    const bag = { stacks: [stackOf(item('anvil', 19))], capacity: 20 };
    const result = carry(bag, item('pin', 1));
    assert.ok('stacks' in result);
    assert.equal(slotsFree(result as Inventory), 0);
  });

  it('agrees with `fits`, which is the cheap question asked before the expensive one', () => {
    const bag = { stacks: [stackOf(item('anvil', 19))], capacity: 20 };
    assert.equal(fits(bag, item('pin', 1)), true);
    assert.equal(fits(bag, item('breastplate', 10)), false);
  });
});

describe('taking something out', () => {
  it('removes the one at that position, not the first with the same name', () => {
    // Two identical items are two items: a character with three daggers who drops one must drop one,
    // and matching on id would make *which* unanswerable.
    const bag = { stacks: [stackOf(item('dagger', 1)), stackOf(item('dagger', 1)), stackOf(item('rope', 2))], capacity: 20 };
    const out = removeAt(bag, 1);
    assert.ok(out);
    assert.equal(out.inventory.stacks.length, 2);
    assert.deepEqual(out.inventory.stacks.map((s) => s.item.id), ['dagger', 'rope']);
  });

  it('answers nothing for a position that is not there', () => {
    assert.equal(removeAt(emptyInventory(), 0), undefined);
    assert.equal(removeAt({ stacks: [stackOf(item('a', 1))], capacity: 20 }, 5), undefined);
  });
});

describe('naming something in the bag', () => {
  it('matches a word of the display name, which is what a player can see', () => {
    const bag = { stacks: [stackOf(item('leather_tunic', 3, 'a leather tunic'))], capacity: 20 };
    assert.equal(matchInventory(bag, 'tunic'), 0);
    assert.equal(matchInventory(bag, 'leather'), 0);
    assert.equal(matchInventory(bag, 'LEATHER'), 0);
  });

  it('matches the id too, so a script can be exact', () => {
    const bag = { stacks: [stackOf(item('leather_tunic', 3, 'a leather tunic'))], capacity: 20 };
    assert.equal(matchInventory(bag, 'leather_tunic'), 0);
  });

  it('takes the first match, the only ordering a player can predict', () => {
    const bag = { stacks: [stackOf(item('a', 1, 'a rusty dagger')), stackOf(item('b', 1, 'a fine dagger'))], capacity: 20 };
    assert.equal(matchInventory(bag, 'dagger'), 0);
  });

  it('answers -1 for nothing, rather than 0 which is a real position', () => {
    assert.equal(matchInventory({ stacks: [stackOf(item('a', 1))], capacity: 20 }, 'sword'), -1);
    assert.equal(matchInventory({ stacks: [stackOf(item('a', 1))], capacity: 20 }, '   '), -1);
  });

  it('does not match a partial word, which would make "a" mean everything', () => {
    const bag = { stacks: [stackOf(item('a', 1, 'a leather tunic'))], capacity: 20 };
    assert.equal(matchInventory(bag, 'tun'), -1);
  });
});

describe('reading a bag off disk', () => {
  it('round-trips', () => {
    const bag = { stacks: [stackOf(item('rope', 2, 'a coil of rope'))], capacity: 20 };
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
    assert.deepEqual(read.stacks.map((s) => s.item.id), ['y']);
  });
});

describe('stacking changes what "does it fit" means', () => {
  const arrow = (): Item => ({ id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 });

  it('takes one more of something you already carry for no extra slot', () => {
    // **The behaviour a flat list could not have.** Nineteen arrows fill one slot; the twentieth fills a
    // slot already paid for. `fits` used to be `size <= free`, which would refuse this in a full bag —
    // a bag that turns down an arrow it has room for reads as broken.
    let bag: Inventory = { stacks: [{ item: arrow(), count: 19 }], capacity: 1 };
    assert.equal(slotsUsed(bag), 1, 'nineteen arrows, one slot');
    assert.equal(slotsFree(bag), 0, 'and the bag is full');
    assert.equal(fits(bag, arrow()), true, 'yet one more still fits');

    const out = carry(bag, arrow());
    assert.ok('stacks' in out);
    bag = out;
    assert.equal(bag.stacks[0]?.count, 20);
    assert.equal(slotsUsed(bag), 1, 'still one slot');
  });

  it('refuses the one that would tip into a slot there is no room for', () => {
    // The twenty-first arrow needs a second slot, and a bag of one has none. Charged honestly rather
    // than letting a stack grow past its limit for free.
    const bag: Inventory = { stacks: [{ item: arrow(), count: 20 }], capacity: 1 };
    assert.equal(fits(bag, arrow()), false);
    assert.deepEqual(carry(bag, arrow()), { needed: 1, free: 0 });
  });

  it('agrees with `carry` by construction, not by keeping two branches in step', () => {
    const bag: Inventory = { stacks: [{ item: arrow(), count: 19 }], capacity: 1 };
    for (const candidate of [arrow(), item('anvil', 19), item('pin', 1)]) {
      assert.equal(fits(bag, candidate), 'stacks' in carry(bag, candidate), candidate.id);
    }
  });

  it('keeps a part-used stack out of the full one when carrying', () => {
    // §3 again, this time through `carry` rather than `mergeStacks`: a bag holding four full potions
    // does not absorb a three-charge one, so the open bottle stays visibly open.
    const potion: Item = { id: 'potion', name: 'a potion', ac: 0, size: 1, stackLimit: 5, uses: 5 };
    const bag: Inventory = { stacks: [{ item: potion, count: 4, remaining: 3 }], capacity: 20 };
    const out = carry(bag, potion);
    assert.ok('stacks' in out);
    assert.equal(out.stacks.length, 2, 'the full one lands beside the part-used ones');
    assert.equal(out.stacks[1]?.remaining, 5);
  });
});

describe('drop takes one, not the pile', () => {
  it('leaves the rest of the stack behind', () => {
    // `drop arrow` means an arrow. Taking the whole stack would be a fat-finger that empties a quiver.
    const arrow: Item = { id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 };
    const out = removeAt({ stacks: [{ item: arrow, count: 3 }], capacity: 20 }, 0);
    assert.ok(out);
    assert.equal(out.item.id, 'arrow');
    assert.equal(out.inventory.stacks[0]?.count, 2);
  });

  it('removes the stack once it empties, so a bag never holds a stack of zero', () => {
    const out = removeAt({ stacks: [stackOf(item('rope', 2))], capacity: 20 }, 0);
    assert.deepEqual(out?.inventory.stacks, []);
  });
});

describe('reading a pre-15c bag', () => {
  it('folds a flat `items` array back into stacks', () => {
    // A save written before 15c has no `stacks`. Refusing it would lock a character out of their own
    // inventory over a data format — the call `explored` and `light` each got when they migrated.
    const arrow = { id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 };
    const read = readInventory({ items: [arrow, arrow, arrow], capacity: 20 }, readItem);
    assert.equal(read.stacks.length, 1, 'three loose arrows come back as one stack');
    assert.equal(read.stacks[0]?.count, 3);
  });

  it('round-trips the new shape', () => {
    const bag: Inventory = { stacks: [{ item: item('rope', 2), count: 2 }], capacity: 20 };
    assert.deepEqual(readInventory(JSON.parse(JSON.stringify(bag)), readItem), bag);
  });
});

describe('what is inside a container survives the trip to disk', () => {
  const arrow = (): Item => ({ ...item('arrow', 1, 'an arrow'), stackLimit: 20 });
  const quiver = (contents: Stack[]): Stack => ({
    item: item('quiver', 2, 'a leather quiver'),
    count: 1,
    held: { rule: { capacity: 30, accepts: 'missile' }, contents },
  });

  it('brings a bag holding a container holding a stack of arrows back identical', () => {
    // **The bug this test exists for.** `readInventory` read `item`, `count` and `remaining` and
    // stopped, so anything a player had *put somewhere* vanished at the next restart — and, because
    // `PlayerStore.setInventory` normalises through this same reader, on the way to disk as well.
    const bag: Inventory = { stacks: [quiver([{ item: arrow(), count: 12 }])], capacity: 20 };
    assert.deepEqual(readInventory(JSON.parse(JSON.stringify(bag)), readItem), bag);
  });

  it('keeps a container full of stacks as stacks, not as loose arrows', () => {
    // Sixty arrows in a quiver are three stacks of twenty on the way out and three on the way back —
    // §4's own example. A reader that flattened them would quietly change how much the quiver holds.
    const bag: Inventory = {
      stacks: [quiver([{ item: arrow(), count: 20 }, { item: arrow(), count: 20 }, { item: arrow(), count: 20 }])],
      capacity: 20,
    };
    assert.deepEqual(readInventory(JSON.parse(JSON.stringify(bag)), readItem), bag);
  });

  it('refuses a container inside a container, because a save file is a text file somebody can edit', () => {
    // §4's depth rule is bag → container → items, and `putRefusal` returns `'too-deep'` for *any*
    // container going in. The reader enforces the same bound, because nothing else stops a save being
    // hand-edited into a russian doll and a bag that loads deeper than the rules allow is a bag whose
    // rules are decoration. The over-deep container arrives as an ordinary item — its contents are
    // lost, which is the honest outcome for something that was never legally there.
    const tooDeep = {
      stacks: [
        {
          item: item('sack', 3, 'a sack'),
          count: 1,
          held: {
            rule: { capacity: 20, accepts: 'any' },
            contents: [quiver([{ item: arrow(), count: 1 }])],
          },
        },
      ],
      capacity: 20,
    };
    const read = readInventory(JSON.parse(JSON.stringify(tooDeep)), readItem);
    assert.ok(read.stacks[0]?.held, 'the sack is a legal container and keeps its contents');
    const inner = read.stacks[0]?.held?.contents[0];
    assert.equal(inner?.item.id, 'quiver', 'the quiver inside it is still an item');
    assert.equal(inner?.held, undefined, 'but not a container, and the arrow in it is gone');
  });

  it('empties containers onto the corpse instead of burning what is in them', () => {
    // `loose` is what a death hands to `makeCorpse`. Stopping at the top level would have destroyed
    // twenty arrows and left the empty quiver, which is the same silent loss as the save bug above —
    // only permanent, and on the one event where a player is already unhappy.
    const bag: Inventory = {
      stacks: [quiver([{ item: arrow(), count: 20 }]), { item: item('rope', 2, 'a coil of rope'), count: 2 }],
      capacity: 20,
    };
    const dropped = loose(bag).map((i) => i.id);
    assert.equal(dropped.filter((id) => id === 'arrow').length, 20, 'every arrow is on the body');
    assert.equal(dropped.filter((id) => id === 'quiver').length, 1, 'and so is the quiver itself');
    assert.equal(dropped.length, 23);
  });

  it('drops a rule it cannot believe rather than loading a container with no capacity', () => {
    for (const rule of [undefined, {}, { capacity: 0, accepts: 'any' }, { capacity: 10, accepts: 'sandwiches' }]) {
      const read = readInventory({ stacks: [{ item: item('sack', 3), count: 1, held: { rule, contents: [] } }], capacity: 20 }, readItem);
      assert.equal(read.stacks.length, 1, 'the sack itself is still a sack');
      assert.equal(read.stacks[0]?.held, undefined, JSON.stringify(rule));
    }
  });
});
