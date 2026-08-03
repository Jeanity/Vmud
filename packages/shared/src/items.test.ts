import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ITEM_ARMOUR_BONUS,
  MAX_ITEM_SIZE,
  armourBonusFrom,
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

  it('answers nothing for a slot we do not model, rather than the nearest one', () => {
    // 13 is WEAR_WAIST and 19 is WEAR_EYES. Guessing "close enough" would put a belt on your chest.
    assert.equal(slotForWearPosition(13), undefined);
    assert.equal(slotForWearPosition(19), undefined);
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
