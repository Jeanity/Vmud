/**
 * Stacking and charges.
 *
 * The first suite is `DESIGN-inventory.md` §3's worked example, transcribed. It is the owner's own
 * table and the doc says the model must reproduce it exactly, so it is asserted number for number
 * rather than paraphrased.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Item } from './equipment.ts';
import { describeStack, mergeStacks, mergeable, stackSlots, totalUses, useOnce, type Stack } from './stacks.ts';

function item(id: string, size = 1, name = id): Item {
  return { id, name, ac: 0, size };
}
const potion = item('potion', 1, 'a potion of healing');
const large = item('large_potion', 1, 'a large potion of healing');
const arrow = item('arrow', 1, 'an arrow');

describe('§3’s worked example, exactly', () => {
  it('a regular potion: 1 use each, 5 to a slot, 5 uses in one slot', () => {
    const stack: Stack = { item: potion, count: 5, remaining: 1 };
    assert.equal(totalUses(stack), 5);
    assert.equal(stackSlots(stack, 5), 1);
  });

  it('a large potion: 5 uses each, 5 to a slot, **25 uses** in one slot', () => {
    // The line the doc bolds. A large potion is not "a potion worth more" — it is five draughts in one
    // bottle, and five bottles stack, so the two numbers multiply.
    const stack: Stack = { item: large, count: 5, remaining: 5 };
    assert.equal(totalUses(stack), 25);
    assert.equal(stackSlots(stack, 5), 1);
  });

  it('arrows: no charges, 20 to a slot', () => {
    const stack: Stack = { item: arrow, count: 20 };
    assert.equal(totalUses(stack), undefined, 'an arrow has no charges to count');
    assert.equal(stackSlots(stack, 20), 1);
  });
});

describe('a half-used one cannot hide in a full stack', () => {
  it('splits the stack when you drink from it', () => {
    // §3's closing requirement, and the reason a stack is homogeneous in charges: you opened a bottle,
    // and the others are still sealed. Four full plus one at four — two entries, which is what the
    // fiction says.
    const out = useOnce({ item: large, count: 5, remaining: 5 });
    assert.ok(out);
    assert.deepEqual(out.rest, { item: large, count: 4, remaining: 5 });
    assert.deepEqual(out.opened, { item: large, count: 1, remaining: 4 });
  });

  it('refuses to merge the open one back in', () => {
    // The bug this prevents is an item duplication wearing the clothes of a convenience: a 3-of-5
    // potion absorbed into a stack of fulls would come back out full.
    const full: Stack = { item: large, count: 4, remaining: 5 };
    const open: Stack = { item: large, count: 1, remaining: 3 };
    assert.equal(mergeable(full, open), false);
    assert.deepEqual(mergeStacks(full, open, 5), { merged: full, leftover: open });
  });

  it('merges once the open one is back to full', () => {
    const full: Stack = { item: large, count: 4, remaining: 5 };
    assert.deepEqual(mergeStacks(full, { item: large, count: 1, remaining: 5 }, 5), {
      merged: { item: large, count: 5, remaining: 5 },
    });
  });

  it('never merges two different things', () => {
    assert.equal(mergeable({ item: potion, count: 1, remaining: 1 }, { item: large, count: 1, remaining: 1 }), false);
  });
});

describe('spending the last charge', () => {
  it('takes the item out of the bag', () => {
    const out = useOnce({ item: potion, count: 1, remaining: 1 });
    assert.deepEqual(out, {}, 'nothing left of it');
  });

  it('leaves the rest of the stack behind', () => {
    const out = useOnce({ item: potion, count: 5, remaining: 1 });
    assert.deepEqual(out, { rest: { item: potion, count: 4, remaining: 1 } });
  });

  it('drops the charge on a single item without splitting anything', () => {
    assert.deepEqual(useOnce({ item: large, count: 1, remaining: 5 }), {
      opened: { item: large, count: 1, remaining: 4 },
    });
  });

  it('refuses to consume something that has no charges', () => {
    // So a caller cannot quietly use up a sword.
    assert.equal(useOnce({ item: arrow, count: 20 }), undefined);
    assert.equal(useOnce({ item: potion, count: 1, remaining: 0 }), undefined);
  });
});

describe('what a stack costs', () => {
  it('rolls over into a second slot past the limit', () => {
    assert.equal(stackSlots({ item: arrow, count: 20 }, 20), 1);
    assert.equal(stackSlots({ item: arrow, count: 21 }, 20), 2);
  });

  it('multiplies by the item’s own bulk rather than ignoring it', () => {
    // `stackLimit` says how many share a slot, not that they become weightless doing it — two
    // breastplates are not one breastplate's worth of bag.
    const plate = item('breastplate', 10);
    assert.equal(stackSlots({ item: plate, count: 1 }, 1), 10);
    assert.equal(stackSlots({ item: plate, count: 2 }, 1), 20);
  });

  it('treats an unstackable thing as one per slot', () => {
    assert.equal(stackSlots({ item: item('sword', 2), count: 3 }, 1), 6);
  });
});

describe('merging a stack that only partly fits', () => {
  it('takes what it can and leaves the rest, rather than refusing outright', () => {
    // Refusing the whole transfer because it does not all fit is what makes a player shuffle items by
    // hand. Three in the bag, four offered, limit five: two move and two stay.
    const out = mergeStacks({ item: potion, count: 3, remaining: 1 }, { item: potion, count: 4, remaining: 1 }, 5);
    assert.deepEqual(out.merged, { item: potion, count: 5, remaining: 1 });
    assert.deepEqual(out.leftover, { item: potion, count: 2, remaining: 1 });
  });

  it('leaves a full stack completely alone', () => {
    const full: Stack = { item: potion, count: 5, remaining: 1 };
    const more: Stack = { item: potion, count: 2, remaining: 1 };
    assert.deepEqual(mergeStacks(full, more, 5), { merged: full, leftover: more });
  });
});

describe('how a stack reads in a list', () => {
  it('shows the count only when there is more than one', () => {
    assert.equal(describeStack({ item: potion, count: 1, remaining: 1 }, 1), 'a potion of healing');
    assert.equal(describeStack({ item: potion, count: 3, remaining: 1 }, 1), 'a potion of healing (x3)');
  });

  it('shows charges only once they have been touched', () => {
    // "(5/5)" on every untouched bottle is noise that makes the one that matters harder to spot.
    assert.equal(describeStack({ item: large, count: 2, remaining: 5 }, 5), 'a large potion of healing (x2)');
    assert.equal(describeStack({ item: large, count: 1, remaining: 3 }, 5), 'a large potion of healing [3/5]');
  });
});
