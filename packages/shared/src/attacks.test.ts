/**
 * What a blow is called — V7.
 *
 * Two things are worth pinning and the second is the reason this file exists. The table has to have a row
 * for every id (the `AFFECT_TYPE_IDS` discipline), and **the verb grouping must not drift into the skill
 * grouping** — they read alike, they come from the same field, and they are different answers. A test that
 * states the difference is what stops somebody merging them later in good faith.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTACK_TYPE_IDS,
  ATTACK_VERBS,
  attackTypeForRace,
  attackTypeForWeapon,
} from './attacks.ts';
import { weaponSkillFor } from './skills.ts';

describe('the verb table', () => {
  it('has a row for every id, with all three forms', () => {
    for (const id of ATTACK_TYPE_IDS) {
      const verb = ATTACK_VERBS[id];
      assert.ok(verb, id);
      for (const form of ['second', 'third', 'past'] as const) {
        assert.ok(verb[form].length > 0, `${id}.${form}`);
      }
    }
    assert.equal(Object.keys(ATTACK_VERBS).length, ATTACK_TYPE_IDS.length);
  });

  it('keeps Duris\' own words, including "punch" for the plain hit', () => {
    // `MSG_HIT`'s verb is punch, not hit — the source's choice and a better one: "you hit the kobold"
    // says nothing about how, and every other row is specific.
    assert.deepEqual(ATTACK_VERBS.hit, { second: 'punch', third: 'punches', past: 'punched' });
    assert.deepEqual(ATTACK_VERBS.slash, { second: 'slash', third: 'slashes', past: 'slashed' });
    assert.equal(ATTACK_VERBS.bite.past, 'bitten', 'irregular, and the table has it right');
  });
});

describe('a weapon\'s verb', () => {
  it('is the owner\'s ask, at both ends of it', () => {
    // "If I swing an axe or a sword it should say You slash; if it was a club it should be bludgeon."
    // The club is `crush` in the source's own grouping — see the next test but one.
    assert.equal(attackTypeForWeapon(1), 'slash', 'axe');
    assert.equal(attackTypeForWeapon(5), 'slash', 'longsword');
    assert.equal(attackTypeForWeapon(13), 'slash', 'two-handed sword');
    assert.equal(attackTypeForWeapon(2), 'pierce', 'dagger');
    assert.equal(attackTypeForWeapon(14), 'whip', 'whip');
  });

  it('punches with nothing in hand and with a class nothing recognises', () => {
    assert.equal(attackTypeForWeapon(undefined), 'hit');
    assert.equal(attackTypeForWeapon(0), 'hit', 'the six weapons with no class');
    assert.equal(attackTypeForWeapon(99), 'hit');
  });

  it('splits crush from bludgeon, which the skill mapping does not — and that is the point', () => {
    // The trap this whole file exists to hold shut. Both groupings are the source's: `get_weapon_msg`
    // separates the hammer family from the mace family, `required_weapon_skill` lumps them together.
    assert.equal(attackTypeForWeapon(4), 'crush', 'hammer');
    assert.equal(attackTypeForWeapon(6), 'bludgeon', 'mace');
    assert.equal(
      weaponSkillFor({ weaponClass: 4 }),
      weaponSkillFor({ weaponClass: 6 }),
      'while the skill they train is the same one',
    );
    assert.notEqual(attackTypeForWeapon(4), attackTypeForWeapon(6));
  });

  it('reads the class and never the two-handed flag, unlike the skill mapping', () => {
    // A greatsword still slashes; it just trains a different skill. Two functions over one field,
    // asking different questions.
    assert.equal(attackTypeForWeapon(5), attackTypeForWeapon(5), 'stable');
    assert.equal(attackTypeForWeapon(8), 'slash', 'a polearm slashes either way');
    assert.notEqual(
      weaponSkillFor({ weaponClass: 8 }),
      weaponSkillFor({ weaponClass: 8, twoHanded: true }),
      'while the skill it trains changes with the hands it takes',
    );
  });
});

describe('an unarmed creature\'s verb', () => {
  it('comes from the race, which is how a spider stings and a troll mauls', () => {
    assert.equal(attackTypeForRace('AR'), 'sting', 'arachnid');
    assert.equal(attackTypeForRace('PT'), 'maul', 'troll');
    assert.equal(attackTypeForRace('G'), 'crush', 'giant');
    assert.equal(attackTypeForRace('AN'), 'bite', 'animal');
    assert.equal(attackTypeForRace('QU'), 'thrash', 'quadruped, and those are hooves');
    assert.equal(attackTypeForRace('DR'), 'claw', 'dragon');
  });

  it('punches for a humanoid, for an unknown code and for nothing at all', () => {
    // `MSG_HIT` is the source's `default`, and the last case is a spawn file written before the race was
    // harvested — which is why the field is optional.
    assert.equal(attackTypeForRace('H'), 'hit');
    assert.equal(attackTypeForRace('PH'), 'hit');
    assert.equal(attackTypeForRace('ZZ'), 'hit');
    assert.equal(attackTypeForRace(undefined), 'hit');
  });

  it('is case-insensitive, because a race code is read out of a text file', () => {
    assert.equal(attackTypeForRace('ar'), 'sting');
    assert.equal(attackTypeForRace('pt'), 'maul');
  });
});
