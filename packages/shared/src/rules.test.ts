import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  abilityMod,
  averageDice,
  diceRange,
  makeRng,
  parseDice,
  writeDice,
  proficiencyBonus,
  resolveAttack,
  rollDamage,
  rollDice,
} from './rules.ts';

describe('abilityMod', () => {
  it('follows the SRD table', () => {
    assert.equal(abilityMod(1), -5);
    assert.equal(abilityMod(8), -1);
    assert.equal(abilityMod(10), 0);
    assert.equal(abilityMod(11), 0);
    assert.equal(abilityMod(18), 4);
    assert.equal(abilityMod(20), 5);
  });
});

describe('proficiencyBonus', () => {
  it('is +2 at level 1 and rises every four levels', () => {
    assert.equal(proficiencyBonus(1), 2);
    assert.equal(proficiencyBonus(4), 2);
    assert.equal(proficiencyBonus(5), 3);
    assert.equal(proficiencyBonus(17), 6);
  });
});

describe('parseDice', () => {
  it('parses plain, positive and negative notation', () => {
    assert.deepEqual(parseDice('2d6'), { count: 2, sides: 6, bonus: 0 });
    assert.deepEqual(parseDice('1d8+3'), { count: 1, sides: 8, bonus: 3 });
    assert.deepEqual(parseDice('3d4 - 1'), { count: 3, sides: 4, bonus: -1 });
  });

  it('rejects malformed input', () => {
    assert.equal(parseDice('d6'), undefined);
    assert.equal(parseDice('0d6'), undefined);
    assert.equal(parseDice('sword'), undefined);
  });
});

/**
 * A9 put dice in a form somebody types into, which makes this the inverse it has to be: the string goes
 * straight back through `parseDice` on the next save, so anything dropped here is a number that vanishes
 * when an operator opens an editor and presses Save without touching that box.
 */
describe('writeDice', () => {
  it('round-trips everything parseDice accepts', () => {
    for (const notation of ['2d6', '1d8+3', '3d4-1', '23d44+207', '1d1']) {
      const dice = parseDice(notation);
      assert.ok(dice, notation);
      assert.deepEqual(parseDice(writeDice(dice)), dice, notation);
    }
  });

  it('writes a zero bonus as nothing, which is how the world files spell it', () => {
    assert.equal(writeDice({ count: 2, sides: 6, bonus: 0 }), '2d6');
    assert.equal(writeDice({ count: 2, sides: 6, bonus: 8 }), '2d6+8');
    assert.equal(writeDice({ count: 2, sides: 6, bonus: -3 }), '2d6-3');
  });
});

describe('rollDice', () => {
  it('never leaves the possible range', () => {
    const dice = parseDice('3d6+2');
    assert.ok(dice);
    const { min, max } = diceRange(dice);
    const rng = makeRng(12345);
    for (let i = 0; i < 5000; i++) {
      const result = rollDice(rng, dice);
      assert.ok(result >= min && result <= max, `${result} outside [${min}, ${max}]`);
    }
  });

  it('converges on the arithmetic mean', () => {
    const dice = parseDice('2d6');
    assert.ok(dice);
    const rng = makeRng(999);
    let total = 0;
    const samples = 20_000;
    for (let i = 0; i < samples; i++) total += rollDice(rng, dice);
    assert.ok(Math.abs(total / samples - averageDice(dice)) < 0.1);
  });
});

describe('makeRng', () => {
  it('is deterministic for a given seed, so combats can be replayed', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
  });

  it('stays within [0, 1)', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 10_000; i++) {
      const value = rng();
      assert.ok(value >= 0 && value < 1);
    }
  });
});

describe('resolveAttack', () => {
  it('always misses on a natural 1 regardless of bonus', () => {
    const rng = makeRng(1);
    let sawFumble = false;
    for (let i = 0; i < 2000; i++) {
      const result = resolveAttack(rng, { attackBonus: 99, targetAc: 10 });
      if (result.natural === 1) {
        sawFumble = true;
        assert.equal(result.hit, false);
      }
    }
    assert.ok(sawFumble, 'expected at least one natural 1 in 2000 rolls');
  });

  it('always hits on a natural 20 regardless of AC', () => {
    const rng = makeRng(2);
    let sawCrit = false;
    for (let i = 0; i < 2000; i++) {
      const result = resolveAttack(rng, { attackBonus: -50, targetAc: 99 });
      if (result.natural === 20) {
        sawCrit = true;
        assert.equal(result.hit, true);
        assert.equal(result.critical, true);
      }
    }
    assert.ok(sawCrit, 'expected at least one natural 20 in 2000 rolls');
  });

  it('favours the higher roll with advantage', () => {
    const straight = averageNatural({ advantage: 'none' as const });
    const advantaged = averageNatural({ advantage: 'advantage' as const });
    const disadvantaged = averageNatural({ advantage: 'disadvantage' as const });
    assert.ok(advantaged > straight, `${advantaged} should exceed ${straight}`);
    assert.ok(disadvantaged < straight, `${disadvantaged} should be under ${straight}`);
  });

  function averageNatural(opts: { advantage: 'none' | 'advantage' | 'disadvantage' }): number {
    const rng = makeRng(31337);
    let total = 0;
    const samples = 20_000;
    for (let i = 0; i < samples; i++) {
      total += resolveAttack(rng, { attackBonus: 0, targetAc: 10, ...opts }).natural;
    }
    return total / samples;
  }
});

describe('rollDamage', () => {
  it('doubles the dice but not the flat bonus on a crit', () => {
    const dice = parseDice('1d6+4');
    assert.ok(dice);
    const rng = makeRng(5);
    for (let i = 0; i < 2000; i++) {
      const damage = rollDamage(rng, dice, true);
      assert.ok(damage >= 2 + 4 && damage <= 12 + 4, `${damage} outside crit range`);
    }
  });
});
