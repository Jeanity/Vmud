import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ITEM_ARMOUR_BONUS,
  MAX_ITEM_SIZE,
  CRAFTSMANSHIP_NAMES,
  CRAFT_AVERAGE,
  armourBonusFrom,
  craftsmanshipBonus,
  instantiate,
  sizeFrom,
  slotForWearPosition,
  vnumOf,
  type ItemTemplate,
} from './items.ts';

function template(over: Partial<ItemTemplate> = {}): ItemTemplate {
  return { vnum: 1, keywords: ['thing'], name: 'a thing', roomLine: 'A thing.', type: 12, ac: 0, size: 1, cost: 0, stackLimit: 1, ...over };
}

describe('Duris armour, compressed onto our AC', () => {
  it('hits the three points that were measured', () => {
    // Owner's decision (2026-08-03): a clear but bounded upgrade. The catalogue's armour values run
    // median 7, p90 16, max 200; the starter kit is authored at +0 to +3 a piece.
    assert.equal(armourBonusFrom(7), 2, 'a median piece edges a median starter piece');
    assert.equal(armourBonusFrom(16), 4, 'p90');
    assert.equal(armourBonusFrom(200), MAX_ITEM_ARMOUR_BONUS, 'the best in the world, capped');
  });

  it('keeps the catalogue’s ordering, which is what the square root is for', () => {
    // Flattening the top must not reorder anything below it: a better piece stays a better piece.
    let previous = -1;
    for (const value of [1, 3, 4, 7, 9, 16, 25, 36, 49, 64]) {
      const bonus = armourBonusFrom(value);
      assert.ok(bonus >= previous, `${value} → +${bonus} is not below the one before`);
      previous = bonus;
    }
  });

  it('never makes armour hurt', () => {
    // Duris' *mob* armour scale is inverted — lower is better, and a well-armoured mob carries −122.
    // An item's is not, and feeding one to the other is a single sign error away from negative armour.
    assert.equal(armourBonusFrom(0), 0);
    assert.equal(armourBonusFrom(-122), 0);
  });

  it('leaves the whole world alone at average craftsmanship — Phase 16', () => {
    // 66.7% of the catalogue sits at 7, so the common case must be bit-for-bit what it was before
    // craftsmanship existed. An absent value means the same thing and must not read as `terrible`.
    for (const value of [1, 7, 16, 64, 200]) {
      assert.equal(armourBonusFrom(value, CRAFT_AVERAGE), armourBonusFrom(value), `value ${value}`);
      assert.equal(armourBonusFrom(value, undefined), armourBonusFrom(value), `value ${value}, unset`);
    }
  });

  it('lets craftsmanship move a piece by up to two, and no further', () => {
    // A median piece is +2. One made by a master artisan is +4; a very poorly made one is +1 — the
    // floor, because a badly-made breastplate is still a breastplate.
    assert.equal(armourBonusFrom(7, 14), 4, 'master artisan');
    assert.equal(armourBonusFrom(7, 15), 4, 'one-of-a-kind sits in the same band as master, not past it');
    assert.equal(armourBonusFrom(16, 5), 3, 'a p90 piece of below average quality');
    assert.equal(armourBonusFrom(7, 2), 1, 'very poorly made — floored, not zero');
    assert.equal(armourBonusFrom(7, 0), 1, 'terribly made, floored rather than negative');
  });

  it('does not let craftsmanship break the cap in either direction', () => {
    // The cap is what stops the best gear in the world being immunity, and the floor is what stops
    // the worst being a trap. Craftsmanship is an edge on top of the base; it is not a way out.
    assert.equal(armourBonusFrom(200, 15), MAX_ITEM_ARMOUR_BONUS);
    assert.ok(armourBonusFrom(1, 0) >= 1);
    assert.equal(armourBonusFrom(0, 15), 0, 'and it cannot turn clothing into armour');
  });

  it('maps the 0–15 ladder onto quarter-steps', () => {
    // The table in `craftsmanshipBonus`, asserted rung by rung — this is the shape of the divergence
    // and it should not drift silently.
    const expected = [-2, -2, -2, -1, -1, -1, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2];
    assert.deepEqual([...expected.keys()].map((c) => craftsmanshipBonus(c)), expected);
    assert.equal(CRAFTSMANSHIP_NAMES.length, expected.length, 'a name for every rung');
    // `Math.round` gives `-0` for the rungs just below average, and `-0` is not `0` to `Object.is`.
    // Left uncollapsed it would ride into a JSON overlay and out again as a value nothing expects.
    assert.ok(Object.is(craftsmanshipBonus(6), 0), 'zero, not negative zero');
  });
});

describe('weight, converted to bulk', () => {
  it('puts a median item at one slot and a heavy one at a handful', () => {
    // Measured: weight runs median 2, p90 20.
    assert.equal(sizeFrom(2), 1);
    assert.equal(sizeFrom(20), 4);
  });

  it('caps at half a bag, which is the design doc’s own breastplate', () => {
    assert.equal(sizeFrom(1_000_000), MAX_ITEM_SIZE, 'a builder’s slip does not fill five bags');
    assert.equal(MAX_ITEM_SIZE, 10);
  });

  it('never costs nothing, so a weightless item is not infinitely stackable', () => {
    assert.equal(sizeFrom(0), 1);
    assert.equal(sizeFrom(-5), 1);
    assert.equal(sizeFrom(Number.NaN), 1);
  });
});

describe('wear positions', () => {
  it('maps the commonest value in the world', () => {
    assert.equal(slotForWearPosition(16), 'mainHand', 'PRIMARY_WEAPON');
    assert.equal(slotForWearPosition(5), 'chest', 'WEAR_BODY');
  });

  it('collapses the four weapon hands onto two, because we have two arms', () => {
    assert.equal(slotForWearPosition(25), 'mainHand', 'THIRD_WEAPON on a four-armed race');
    assert.equal(slotForWearPosition(26), 'offHand', 'FOURTH_WEAPON');
  });

  it('models the waist and the eyes now, and keeps them apart', () => {
    // **This test used to assert that both answered `undefined`**, and it was right to: guessing
    // "close enough" would have put a belt on your chest. Phase 16 modelled Duris' whole humanoid slot
    // list instead — owner's call, and the eyepatch was the example — so the honest assertion is that
    // each position lands on its own slot rather than on a neighbour.
    assert.equal(slotForWearPosition(13), 'waist');
    assert.equal(slotForWearPosition(19), 'eyes');
  });

  it('still answers nothing for a body we do not have', () => {
    // The four-arm, horse and tail positions are the ones left, and they need a race or a mount rather
    // than a row in a table. 99 is not a position at all.
    assert.equal(slotForWearPosition(35), undefined, 'WEAR_HORSE_BODY');
    assert.equal(slotForWearPosition(37), undefined, 'WEAR_TAIL');
    assert.equal(slotForWearPosition(99), undefined);
  });
});

describe('a template becomes a thing you can hold', () => {
  it('namespaces harvested ids so nothing can collide with the authored kit', () => {
    // The starter kit's ids are bare words. `obj:` keeps the two apart in a save file, and keeps which
    // one an item came from readable a year later.
    const item = instantiate(template({ vnum: 420_000 }));
    assert.equal(item.id, 'obj:420000');
    assert.equal(vnumOf(item), 420_000);
    assert.equal(vnumOf({ id: 'leather_tunic', name: 'a leather tunic', ac: 1, size: 3 }), undefined);
  });

  it('leaves an unwearable thing with no slot rather than inventing one', () => {
    // Keys, coins, food and trash are the bulk of the catalogue. Any resting value picked here would
    // make every key in the world wearable somewhere.
    assert.equal(instantiate(template()).slot, undefined);
    assert.equal(instantiate(template({ slot: 'head' })).slot, 'head');
  });

  it('carries the damage dice through untouched', () => {
    // Unlike armour, taken unscaled: 14b proved our combat scale *against* these numbers.
    const sword = instantiate(template({ damage: { count: 2, sides: 6, bonus: 0 } }));
    assert.deepEqual(sword.damage, { count: 2, sides: 6, bonus: 0 });
  });
});
