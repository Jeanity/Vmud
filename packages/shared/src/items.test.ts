import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_ITEM_ARMOUR_BONUS,
  MAX_ITEM_SIZE,
  MAX_WEAR_POSITION,
  UNMODELLED_WEAR_POSITIONS,
  CRAFTSMANSHIP_NAMES,
  CRAFT_AVERAGE,
  armourBonusFrom,
  craftsmanshipBonus,
  handednessFor,
  instantiate,
  OFFHAND_MAX_SIZE,
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

  it('maps the nose and the ioun stone, which had slots and no rows', () => {
    // **The hole this test exists to have closed.** `nose` and `ioun` were in `EQUIP_SLOTS` and in
    // `WEAR_BITS` — an item could declare itself nose-wearable — but `WEAR_POSITIONS` had no row for
    // either, so a zone file that *placed* one landed it in the mob's hands instead of on its face.
    // One `E` command in the whole world does it, which is exactly why nobody noticed.
    assert.equal(slotForWearPosition(39), 'nose', 'WEAR_NOSE');
    assert.equal(slotForWearPosition(41), 'ioun', 'WEAR_IOUN');
  });

  it('accounts for every position the source defines, mapped or recorded', () => {
    // **The completeness check, and the reason the two tables are worth having as data.** `defines.h`
    // names positions 0–42; a table you cannot count is a table with a hole in it, which is how the
    // nose sat missing. Every position must be in exactly one of the two — mapped to a slot, or
    // written down as unmodelled *with a reason*. Adding a slot to `EQUIP_SLOTS` without deciding
    // about its position now fails here rather than silently dropping gear into a mob's hands.
    for (let position = 0; position <= MAX_WEAR_POSITION; position++) {
      const slot = slotForWearPosition(position);
      const excuse = UNMODELLED_WEAR_POSITIONS[position];
      assert.notEqual(
        slot === undefined,
        excuse === undefined,
        `position ${position} must be either mapped or recorded as unmodelled, never both and never neither`,
      );
      if (excuse !== undefined) assert.ok(excuse.length > 10, `position ${position} needs a real reason, not a shrug`);
    }
  });

  it('leaves nothing above the source’s own ceiling', () => {
    // `WEAR_SPIDER_BODY` is 42 and `MAX_WEAR` is the array size past it. A position beyond the ceiling
    // is not a slot we have not built — it is a misread column, and it must not resolve to anything.
    assert.equal(slotForWearPosition(MAX_WEAR_POSITION + 1), undefined);
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

/**
 * **Handedness — Phase 21**, the catalogue half of dual wield.
 *
 * The rule is `IS_DIRK` (`objmisc.h:423`) plus the bulk ceiling derived from `actobj.c:4918`, and the
 * thing most worth pinning is what it *refuses*: this is the gate that decides whether a weapon can
 * ride the off hand at all, so a rule that quietly widened would put greatswords in people's fists.
 */
describe('which hand a weapon may occupy', () => {
  /** A one-handed dagger — Duris' `WEAPON_DAGGER`, and the case that must work with no authoring. */
  const dagger = (over: Partial<ItemTemplate> = {}) =>
    template({ type: 5, weaponClass: 2, size: 1, damage: { count: 2, sides: 4, bonus: 0 }, ...over });

  it('lets a plain dagger ride the off hand out of the box', () => {
    // The whole point of having an automatic rule: nobody should have to author the obvious case.
    assert.equal(handednessFor(dagger()), 'either');
  });

  it('and a short sword, which is the other half of IS_DIRK', () => {
    assert.equal(handednessFor(dagger({ weaponClass: 9 })), 'either');
  });

  it('refuses everything that is not a light blade', () => {
    // Longsword (5), axe (1), mace (6), polearm (8) — the source's macro names two classes and only
    // two. Windsong is a 5, which is exactly why she needs authoring.
    for (const cls of [1, 5, 6, 8, 12, 13, 15]) {
      assert.equal(handednessFor(dagger({ weaponClass: cls })), undefined, `class ${cls}`);
    }
  });

  it('refuses a blade heavier than the source\'s own strength gate allows', () => {
    assert.equal(handednessFor(dagger({ size: OFFHAND_MAX_SIZE })), 'either', 'at the limit');
    assert.equal(handednessFor(dagger({ size: OFFHAND_MAX_SIZE + 1 })), undefined, 'over it');
  });

  it('refuses anything needing both hands, and refuses it even when authored', () => {
    // The two flags are the same fact from opposite ends. An item claiming both would have `wield`
    // and `wield … offhand` disagreeing about how many hands it took, which is unresolvable rather
    // than merely odd — so `twoHanded` is tested before the authored value is even read.
    assert.equal(handednessFor(dagger({ twoHanded: true })), undefined);
    assert.equal(handednessFor(dagger({ twoHanded: true, handedness: 'either' })), undefined);
  });

  it('refuses something with no dice, because a shield is not dual wield', () => {
    // The off hand legitimately holds shields and lanterns; Duris' `WIELD2` never did. What this
    // function answers is *may this swing from there*, and something with no damage cannot.
    assert.equal(handednessFor(template({ type: 9, slot: 'offHand' })), undefined);
    assert.equal(handednessFor(undefined), undefined, 'and an empty hand is not a weapon either');
  });

  it('lets an authored answer overrule the rule, which is how Windsong is blessed', () => {
    // Her real shape: an elven scimitar, `weaponClass` 5, one-handed, two slots of bulk. The
    // automatic rule refuses her on class and an operator says otherwise — the exception mechanism
    // the owner asked for, in one field.
    const windsong = template({ type: 5, weaponClass: 5, size: 2, damage: { count: 2, sides: 6, bonus: 2 } });
    assert.equal(handednessFor(windsong), undefined, 'a longsword is not a dirk');
    assert.equal(handednessFor({ ...windsong, handedness: 'either' }), 'either');
    // And the authored answer beats the *bulk* gate too — an author overrules the whole rule, not
    // the class half of it.
    assert.equal(handednessFor({ ...windsong, size: MAX_ITEM_SIZE, handedness: 'either' }), 'either');
  });

  it('resolves the verdict onto the instance, so nothing looks it up at wield time', () => {
    // `instantiate` stores the answer rather than the ingredients — the departure from the lines
    // around it, and what lets an authored blade with no catalogue entry still know its own hands.
    assert.equal(instantiate(dagger()).handedness, 'either');
    assert.equal(instantiate(dagger({ weaponClass: 5 })).handedness, undefined);
    assert.equal(instantiate(dagger({ weaponClass: 5, handedness: 'either' })).handedness, 'either');
  });
});
