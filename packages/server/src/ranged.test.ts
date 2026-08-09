/**
 * The chances and the quiver — ranged slices 3+4.
 *
 * Everything here is a rule whose failure is invisible in play: a wrong-target roll that never fires
 * reads as skill, a breakage that always fires reads as bad luck, and an ammunition search that cannot
 * see inside the quiver reads as "buy more arrows". Held still per `peek.test.ts`'s argument.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from '@mygame/shared';
import type { Inventory, Item, Stack } from '@mygame/shared';

import { breakChance, rollChance, takeMissile, wrongTargetChance } from './ranged.ts';

const arrow = { id: 'obj:182', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 } as Item;
const bolt = { id: 'obj:36442', name: 'a drow bolt', ac: 0, size: 1, stackLimit: 20 } as Item;
const quiver = { id: 'obj:181', name: 'a quiver', ac: 0, size: 1 } as Item;

/** The lookup the server builds from `templateOf`; here the id is the whole template. */
const typeOf = (item: Item): number | undefined =>
  item.id === 'obj:182' ? 1 : item.id === 'obj:36442' ? 2 : undefined;

function bag(stacks: Stack[]): Inventory {
  return { stacks, capacity: 20 };
}

describe('the ammunition search', () => {
  it('takes one from a loose stack and leaves the rest', () => {
    const result = takeMissile(bag([{ item: arrow, count: 5 }]), 1, typeOf);
    assert.ok(result);
    assert.equal(result.missile.id, 'obj:182');
    assert.deepEqual(result.inventory.stacks.map((s) => s.count), [4]);
  });

  it('removes the stack entirely when it held its last arrow', () => {
    const result = takeMissile(bag([{ item: arrow, count: 1 }]), 1, typeOf);
    assert.ok(result);
    assert.equal(result.inventory.stacks.length, 0);
  });

  it('finds arrows inside a quiver, which is the whole reason quivers exist', () => {
    const held = { rule: { capacity: 5, accepts: 'missile' as const }, contents: [{ item: arrow, count: 20 }] };
    const result = takeMissile(bag([{ item: quiver, count: 1, held }]), 1, typeOf);
    assert.ok(result, 'a full quiver must not read as an empty bag');
    assert.equal(result.missile.id, 'obj:182');
    const inside = result.inventory.stacks[0]!.held!.contents;
    assert.deepEqual(inside.map((s) => s.count), [19]);
  });

  it('refuses ammunition of the wrong type, however much of it there is', () => {
    // A longbow (fires 1) over a bag of drow bolts (type 2) — shop 36439's shelf, aimed wrong.
    assert.equal(takeMissile(bag([{ item: bolt, count: 20 }]), 1, typeOf), undefined);
  });

  it('never finds the keyless — the five broken records match no launcher', () => {
    const needle = { id: 'obj:163', name: 'a blowgun needle', ac: 0, size: 1 } as Item;
    assert.equal(takeMissile(bag([{ item: needle, count: 3 }]), 1, typeOf), undefined);
  });

  it('does not touch the bag it was given', () => {
    const stacks = [{ item: arrow, count: 5 }];
    const before = bag(stacks);
    takeMissile(before, 1, typeOf);
    assert.equal(before.stacks[0]!.count, 5, 'the search must be pure — a refusal downstream must not cost an arrow');
  });
});

describe('the chances', () => {
  it('breaks more often across a room boundary, as asked', () => {
    assert.ok(breakChance(true) > breakChance(false));
  });

  it('mistakes the target less as skill rises, and not at all at mastery', () => {
    assert.ok(wrongTargetChance(0) > wrongTargetChance(50));
    assert.ok(wrongTargetChance(50) > wrongTargetChance(95));
    assert.equal(wrongTargetChance(100), 0);
  });

  it('rolls deterministically through the seeded rng', () => {
    const a = makeRng(7);
    const b = makeRng(7);
    for (let i = 0; i < 50; i++) assert.equal(rollChance(a, 0.3), rollChance(b, 0.3));
  });

  it('never fires on a zero chance and always on a certain one', () => {
    const rng = makeRng(1);
    for (let i = 0; i < 20; i++) {
      assert.equal(rollChance(rng, 0), false);
      assert.equal(rollChance(rng, 1), true);
    }
  });

});
