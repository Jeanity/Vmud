/**
 * Ability scores, races and classes — Phase 21 slice 1's foundation.
 *
 * The racial-bonus expectations here are computed from the transcribed factor table, so a factor
 * edit that shifts a bonus fails a test *by name* rather than silently rebalancing a race.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CLASSES, CLASS_IDS, circleAt } from './classes.ts';
import { RACES, RACE_IDS, racialBonus, racialBonuses } from './races.ts';
import { ABILITIES, abilityMod, type Rng } from './rules.ts';
import { BONUS_POINTS, readScores, rollScores, scoreWord, spendBonus } from './scores.ts';

/** An rng that always rolls the same face — 0 → every die shows 1, 0.99 → every die shows max. */
const always = (fraction: number): Rng => () => fraction;

describe('the modifier and the words', () => {
  it('is the SRD modifier — the one rules.ts has carried since 14b', () => {
    assert.equal(abilityMod(3), -4);
    assert.equal(abilityMod(10), 0);
    assert.equal(abilityMod(11), 0);
    assert.equal(abilityMod(18), 4);
    assert.equal(abilityMod(20), 5);
  });

  it('walks the source word ladder end to end', () => {
    assert.equal(scoreWord(3), 'lame');
    assert.equal(scoreWord(6), 'poor');
    assert.equal(scoreWord(9), 'below average');
    assert.equal(scoreWord(10), 'average');
    assert.equal(scoreWord(13), 'above average');
    assert.equal(scoreWord(15), 'good');
    assert.equal(scoreWord(17), 'very good');
    assert.equal(scoreWord(18), 'excellent');
    assert.equal(scoreWord(20), 'quite excellent');
  });
});

describe('racial bonuses fold from the live factor table', () => {
  it('leaves the human at zero everywhere — the baseline', () => {
    for (const ability of ABILITIES) assert.equal(racialBonus(RACES.human, ability), 0);
  });

  it('gives the barbarian the loudest row in the data', () => {
    assert.equal(racialBonus(RACES.barbarian, 'str'), 4); // 155
    assert.equal(racialBonus(RACES.barbarian, 'con'), 4); // 165
    assert.equal(racialBonus(RACES.barbarian, 'int'), -2); // 70
    assert.equal(racialBonus(RACES.barbarian, 'dex'), -1); // mean(90, 90)
  });

  it('takes DEX as the mean of the split source columns', () => {
    assert.equal(racialBonus(RACES.drow, 'dex'), 1); // mean(110, 130) = 120
    assert.equal(racialBonus(RACES.halfling, 'dex'), 2); // mean(130, 125) = 127.5
  });

  it('keeps every bonus inside 5e´s racial range', () => {
    for (const id of RACE_IDS) {
      const bonuses = racialBonuses(RACES[id]);
      for (const ability of ABILITIES) {
        assert.ok(bonuses[ability] >= -2 && bonuses[ability] <= 4, `${id} ${ability}`);
      }
    }
  });
});

describe('the roll', () => {
  it('is deterministic under the seeded rng, like everything else', () => {
    let calls = 0;
    const rng: Rng = () => (((calls++ * 7919) % 100) + 0.5) / 100;
    let repeat = 0;
    const same: Rng = () => (((repeat++ * 7919) % 100) + 0.5) / 100;
    assert.deepEqual(rollScores(rng, 'drow', 'sorcerer'), rollScores(same, 'drow', 'sorcerer'));
  });

  it('applies the race inside the roll and clamps with it', () => {
    const max = rollScores(always(0.999), 'barbarian', 'warrior');
    assert.equal(max.str, 20); // 18 + 4, clamped to the absolute cap
    assert.equal(max.int, 16); // 18 − 2
    const min = rollScores(always(0), 'barbarian', 'warrior');
    assert.equal(min.int, 3); // 3 − 2, clamped up to the floor
  });

  it('raises a short ability to the class minimum rather than refusing', () => {
    const scores = rollScores(always(0), 'human', 'sorcerer');
    assert.equal(scores.int, 15); // rolled 3, sorcerers need 15
    const rogue = rollScores(always(0), 'human', 'rogue');
    assert.equal(rogue.dex, 14);
  });
});

describe('the five points', () => {
  it('spends within the budget and the caps', () => {
    const base = rollScores(always(0.5), 'human', 'warrior');
    const spent = spendBonus(base, { str: 2, con: 3 }, 'human');
    assert.equal(spent.ok, true);
    if (spent.ok) {
      assert.equal(spent.scores.str, base.str + 2);
      assert.equal(spent.scores.con, base.con + 3);
    }
  });

  it('refuses a sixth point, a negative point, and a bought score past the cap', () => {
    const base = rollScores(always(0.5), 'human', 'warrior');
    assert.equal(spendBonus(base, { str: 6 }, 'human').ok, false);
    assert.equal(spendBonus(base, { str: 3, dex: 3 }, 'human').ok, false);
    assert.equal(spendBonus(base, { str: -1 }, 'human').ok, false);
    const high = { ...base, str: 18 };
    assert.equal(spendBonus(high, { str: 1 }, 'human').ok, false); // 18 is the human ceiling
    const barbarian = { ...base, str: 18 };
    assert.equal(spendBonus(barbarian, { str: 1 }, 'barbarian').ok, true); // their blood carries it
  });

  it(`ships ${BONUS_POINTS} points, the live server's own number`, () => {
    assert.equal(BONUS_POINTS, 5);
  });
});

describe('storage', () => {
  it('round-trips and shrugs at garbage', () => {
    const scores = rollScores(always(0.5), 'gnome', 'cleric');
    assert.deepEqual(readScores(JSON.parse(JSON.stringify(scores))), scores);
    assert.equal(readScores(undefined), undefined);
    assert.equal(readScores({ str: 10 }), undefined);
    assert.equal(readScores({ str: 10, dex: 'high', con: 10, int: 10, wis: 10, cha: 10 }), undefined);
  });
});

describe('classes', () => {
  it('opens circles on the five-level cadence, half-casters a decade late', () => {
    assert.equal(circleAt(1, 1), 1);
    assert.equal(circleAt(5, 1), 1);
    assert.equal(circleAt(6, 1), 2);
    assert.equal(circleAt(11, 1), 3);
    assert.equal(circleAt(10, 11), 0); // the paladin at ten casts nothing
    assert.equal(circleAt(11, 11), 1);
    assert.equal(circleAt(16, 11), 2);
  });

  it('names only spells the registry ships, for all nine', () => {
    for (const id of CLASS_IDS) {
      const spec = CLASSES[id];
      assert.ok(spec.hitDie >= 6 && spec.hitDie <= 10, id);
      if (spec.casting) assert.ok(spec.spells.length > 0, `${id} casts but knows nothing`);
      else assert.equal(spec.spells.length, 0, `${id} knows spells it cannot cast`);
    }
  });
});
