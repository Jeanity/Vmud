import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_LEVEL,
  STARTING_HIT_POINTS,
  applyExperience,
  experienceForLevel,
  experienceToNext,
  hitPointsForLevel,
} from './progression.ts';
import { makeRng } from './rules.ts';

/** A deterministic rng that walks a fixed list, so a roll's effect can be asserted exactly. */
function scripted(values: readonly number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('the experience curve', () => {
  it('is a step function, because Duris generates it as one', () => {
    // `update_exp_table()` falls back to the previous level whenever a step is unset, and only every
    // fifth is set — so every level in a band costs the same.
    for (const level of [2, 3, 4, 5]) assert.equal(experienceForLevel(level), 2_000);
    for (const level of [6, 7, 10]) assert.equal(experienceForLevel(level), 8_000);
    assert.equal(experienceForLevel(11), 25_000);
    assert.equal(experienceForLevel(16), 100_000);
    assert.equal(experienceForLevel(60), 40_000_000);
  });

  it('costs nothing to be level 1, and cannot pass the ceiling', () => {
    assert.equal(experienceForLevel(1), 0);
    assert.equal(experienceForLevel(MAX_LEVEL + 1), Infinity);
  });

  it('is eight kobolds to the first level, which is the economy the world already had', () => {
    // A baby kobold is worth 259 experience in the shipped world; level 2 costs 2,000.
    assert.equal(Math.ceil(2_000 / 259), 8);
  });
});

describe('spending experience', () => {
  it('subtracts the cost rather than accumulating a lifetime total', () => {
    // Duris does `GET_EXP(ch) -= new_exp_table[i]`, which is what makes "experience to next level"
    // readable straight off the character rather than needing a table to interpret.
    const after = applyExperience(makeRng(1), { level: 1, experience: 2_500, maxHp: 22 });
    assert.equal(after.level, 2);
    assert.equal(after.experience, 500);
    assert.equal(after.gained, 1);
  });

  it('can carry a character up more than one level at once', () => {
    // Otherwise the surplus banks and levels you on the *next* kill, which makes progress depend on
    // the order things were killed in.
    const after = applyExperience(makeRng(1), { level: 1, experience: 6_100, maxHp: 22 });
    assert.equal(after.level, 4);
    assert.equal(after.experience, 100);
    assert.equal(after.gained, 3);
  });

  it('does nothing at all when the experience is not there', () => {
    const before = { level: 3, experience: 1_999, maxHp: 30 };
    const after = applyExperience(makeRng(1), before);
    assert.equal(after.gained, 0);
    assert.equal(after.level, 3);
    assert.equal(after.maxHp, 30);
    assert.equal(after.hitPointsGained, 0);
  });

  it('banks experience at the ceiling instead of discarding it', () => {
    const after = applyExperience(makeRng(1), { level: MAX_LEVEL, experience: 999_999_999, maxHp: 200 });
    assert.equal(after.level, MAX_LEVEL);
    assert.equal(after.experience, 999_999_999);
    assert.equal(after.gained, 0);
  });

  it('adds the hit points it rolled, and reports the total', () => {
    // rng 0.99 → the top of the d4 → 4 per level, twice.
    const after = applyExperience(scripted([0.99]), { level: 1, experience: 4_000, maxHp: 22 });
    assert.equal(after.gained, 2);
    assert.equal(after.hitPointsGained, 8);
    assert.equal(after.maxHp, 30);
  });
});

describe('hit points per level', () => {
  it('is Duris\' d4 below 26 and a flat point above it', () => {
    // `advance_level`: `base_hit += number(0,3)` then `+= 1`, and only the `+= 1` past 25.
    const low = [0, 0.3, 0.6, 0.99].map((r) => hitPointsForLevel(scripted([r]), 10));
    assert.deepEqual(low, [1, 2, 3, 4]);
    for (const r of [0, 0.5, 0.99]) assert.equal(hitPointsForLevel(scripted([r]), 26), 1);
  });

  it('gives nothing for being level 1, which you start at', () => {
    assert.equal(hitPointsForLevel(makeRng(1), 1), 0);
  });

  it('starts a character where the measured world says they can survive', () => {
    // The level 1-5 band deals a median 3 damage per round and has a median 46 hit points, so a new
    // character must live about seven rounds to win their first fight. The SRD's 9 bought five.
    assert.equal(STARTING_HIT_POINTS, 22);
    assert.ok(STARTING_HIT_POINTS / 3 > 7, 'survives long enough to win the first fight');
  });
});

describe('experience to next', () => {
  it('reports the remainder, and nothing at the ceiling', () => {
    assert.equal(experienceToNext({ level: 1, experience: 500, maxHp: 22 }), 1_500);
    assert.equal(experienceToNext({ level: MAX_LEVEL, experience: 0, maxHp: 200 }), null);
  });

  it('never goes negative while a level-up is pending', () => {
    assert.equal(experienceToNext({ level: 1, experience: 9_000, maxHp: 22 }), 0);
  });
});
