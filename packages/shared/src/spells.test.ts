/**
 * Phase 20 slice 3 — the registry, the two gates, and the nukes' own arithmetic.
 *
 * The traps are the tests: the ×5 on every save modifier, the inverted lower-is-better save scale,
 * chill touch's shipped precedence quirk, magic missile's per-bolt independence, and the shrug that
 * rolls for nobody without the innate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from './rules.ts';
import {
  MAGIC_RESISTANT_RACES,
  SPELLS,
  defaultSaveMod,
  mobCastMs,
  rollSpellBlows,
  saveFailurePercent,
  shrugChance,
  spellByName,
} from './spells.ts';

describe('the registry', () => {
  it('answers to whole names, never prefixes', () => {
    assert.equal(spellByName('magic missile')?.id, 'magic_missile');
    assert.equal(spellByName('MAGIC MISSILE')?.id, 'magic_missile');
    assert.equal(spellByName('magic'), undefined);
  });
});

describe('gate 1 — the saving throw', () => {
  it('is a failure percentage that falls with level between the two endpoints', () => {
    assert.equal(saveFailurePercent(0, 0, false), 70);
    assert.equal(saveFailurePercent(60, 0, false), 20);
    assert.ok(saveFailurePercent(30, 0, false) < 70 && saveFailurePercent(30, 0, false) > 20);
  });

  it('multiplies every modifier by five — the silent scale change, transcribed', () => {
    // A +3 mod at the call sites is worth 15 points of failure, not 3.
    assert.equal(saveFailurePercent(30, 3, false) - saveFailurePercent(30, 0, false), 15);
  });

  it('keeps a 1% surprise at both ends', () => {
    assert.equal(saveFailurePercent(60, -20, false), 1);
    assert.equal(saveFailurePercent(0, 20, false), 99);
  });

  it('gives an NPC defender the source’s level/3 bonus', () => {
    assert.ok(saveFailurePercent(30, 0, true) < saveFailurePercent(30, 0, false));
  });

  it('bounds the standard offensive mod at ±3 below circle 7', () => {
    assert.equal(defaultSaveMod(50, 1, 1), 3);
    assert.equal(defaultSaveMod(1, 50, 1), -3);
    assert.equal(defaultSaveMod(31, 30, 1), 0);
  });
});

describe('gate 2 — the shrug', () => {
  it('rolls for nobody without the innate — a raceless player never shrugs', () => {
    assert.equal(shrugChance(undefined, 50), 0);
    assert.equal(shrugChance('H', 50), 0);
  });

  it('floors an unauthored magic-resistant race at 5%, the source’s own default consequence', () => {
    for (const race of MAGIC_RESISTANT_RACES) {
      assert.equal(shrugChance(race, 50), 5, race);
    }
  });

  it('lets an authored base climb with level and caps at 100', () => {
    assert.ok(shrugChance('DR', 50, 60) > shrugChance('DR', 25, 60));
    assert.equal(shrugChance('DR', 60, 500), 100);
  });
});

describe('the nukes', () => {
  it('throws one to five missiles, each its own blow — bolts shrug separately', () => {
    const rng = makeRng(7);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 1).length, 1);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 9).length, 3);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 30).length, 5);
  });

  it('keeps chill touch’s shipped precedence quirk: 1d6 + 20 + level, not a ×4 sibling', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20; i++) {
      const [blow] = rollSpellBlows(rng, 'chill_touch', 10);
      assert.ok(blow!.damage >= 31 && blow!.damage <= 36, String(blow!.damage));
    }
  });

  it('scales burning hands by the book: dice(level/10+5, 6) × 4', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20; i++) {
      const [blow] = rollSpellBlows(rng, 'burning_hands', 20);
      // 7d6×4: 28..168.
      assert.ok(blow!.damage >= 28 && blow!.damage <= 168, String(blow!.damage));
    }
  });
});

describe('the mob’s quick chant', () => {
  it('halves or keeps the wind-up by level, and never goes instant below 60', () => {
    const rng = makeRng(7);
    const spell = SPELLS.magic_missile;
    for (let i = 0; i < 50; i++) {
      const ms = mobCastMs(rng, spell, 23);
      assert.ok(ms === spell.castMs || ms === Math.max(1000, Math.round(spell.castMs / 2)), String(ms));
    }
    assert.equal(mobCastMs(rng, spell, 60), 0);
  });
});
