/**
 * Combat statistics: the three conversions, and the one column that is a lie.
 *
 * These are data-fidelity tests rather than gameplay ones. Each pins a decision made by *reading the
 * source* rather than by taste, so the assertion is really "this is still what `db.c` does".
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AC_PER_ARMOUR_POINT,
  BASE_AC,
  DEFAULT_WEAPON,
  HITROLL_MAX,
  MAX_AC,
  MIN_AC,
  ROUND_MS,
  armourToAc,
  attackBonusFor,
  playerCombatStats,
  readCombatStats,
  roundLengthFor,
} from './index.ts';

describe('armour, converted from descending to ascending', () => {
  it('turns Duris armour into an SRD armour class', () => {
    // Measured against IceCrag's own numbers, which is the point: the scale factor was chosen so the real
    // range lands where SRD armour classes live rather than being picked for tidiness.
    assert.equal(armourToAc(0), BASE_AC, 'unarmoured is the SRD 10');
    assert.equal(armourToAc(74), 3, 'a servant in cloth — easy to hit');
    assert.equal(armourToAc(51), 5);
    assert.equal(armourToAc(-69), 17);
    assert.equal(armourToAc(-122), 22, 'Malice, in the plate-and-shield band');
  });

  it('runs the opposite way from the source, which is the whole conversion', () => {
    // Duris is AD&D-descending: lower is better. SRD is ascending. Getting this backwards would make the
    // castle's best fighters the easiest to hit, and it would look like a data problem rather than a sign
    // error.
    assert.ok(armourToAc(-100) > armourToAc(100));
  });

  it('clamps rather than trusting a builder', () => {
    assert.equal(armourToAc(100_000), MIN_AC);
    assert.equal(armourToAc(-100_000), MAX_AC);
    // The floor matters specifically: the SRD already makes a natural 1 an automatic miss, so an armour
    // class below that is not merely generous, it is meaningless.
    assert.ok(MIN_AC >= 1);
  });

  it('scales by the documented factor', () => {
    assert.equal(armourToAc(AC_PER_ARMOUR_POINT), BASE_AC - 1);
  });
});

describe('attack bonus, derived and not read', () => {
  it('derives from level, because the file column is vestigial', () => {
    // `db.c` `fscanf`s the hitroll and overwrites it on the next line. IceCrag's file has −10 on a level
    // 60; read literally that would make its best fighter its worst.
    assert.equal(attackBonusFor(60), 20);
    assert.equal(attackBonusFor(30), 10);
    assert.equal(attackBonusFor(1), 0);
  });

  it('uses the martial branch when told to', () => {
    // The source's `IS_WARRIOR || IS_GREATER_RACE || IS_ELITE || IS_GIANT`. Nothing harvested reaches it
    // yet, which is a known understatement rather than an oversight.
    assert.equal(attackBonusFor(60, true), 25, 'capped');
    assert.equal(attackBonusFor(20, true), 10);
    assert.equal(attackBonusFor(1, true), 2, 'the martial floor is 2, not 0');
  });

  it('respects both of the source bounds', () => {
    assert.equal(attackBonusFor(1_000), HITROLL_MAX);
    assert.equal(attackBonusFor(-5), 0, 'a nonsense level cannot produce a negative bonus');
  });
});

describe('what a body swings with', () => {
  it('reads the damage column straight through', () => {
    const stats = readCombatStats({ level: 60, armour: -122, damage: '7d6+35' });
    assert.deepEqual(stats.damage, { count: 7, sides: 6, bonus: 35 });
  });

  it('falls back to one point rather than NaN on an unreadable column', () => {
    // A mob swinging for NaN reads as a health bar that never moves, which is far harder to diagnose than
    // a mob that hits weakly.
    const stats = readCombatStats({ level: 1, armour: 0, damage: 'not dice' });
    assert.deepEqual(stats.damage, { count: 1, sides: 1, bonus: 0 });
  });

  it('gives a player the documented stand-in weapon', () => {
    // A practice weapon with a removal trigger, exactly like `LOCKS_HOLD`. Deliberately unremarkable, so
    // it cannot be mistaken for a balance decision and so a real weapon is obviously different.
    assert.deepEqual(playerCombatStats(1).damage, DEFAULT_WEAPON);
    assert.deepEqual(DEFAULT_WEAPON, { count: 1, sides: 6, bonus: 0 });
  });
});

describe('the round is a function, not a constant', () => {
  it('starts everything on the base round', () => {
    assert.equal(roundLengthFor(1), ROUND_MS);
    assert.equal(roundLengthFor(60), ROUND_MS);
  });

  it('puts the round on the stats, so it can be varied per body', () => {
    // §4.1's warning is that the first combat code reads the global constant and every speed stat then has
    // nowhere to land but "extra attacks". The value being uniform today is fine; the *field* is the point.
    assert.equal(readCombatStats({ level: 20, armour: 0, damage: '1d6+0' }).roundMs, ROUND_MS);
    assert.equal(playerCombatStats(1).roundMs, ROUND_MS);
  });
});
