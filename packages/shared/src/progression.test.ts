import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_LEVEL,
  STARTING_HIT_POINTS,
  applyDeathCost,
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

describe('what dying costs', () => {
  it('takes a tenth of the level you were climbing toward', () => {
    // Duris' `EXP_DEATH`: `-1 * (new_exp_table[level + 1] * exp.death.level.loss)`, default 0.10.
    // Quoted against the *next* level, so the cost is steady whether you had banked much or little.
    const after = applyDeathCost({ level: 2, experience: 1_000, maxHp: 25 });
    assert.equal(after.experienceLost, 200, 'a tenth of level 3\'s 2,000');
    assert.equal(after.experience, 800);
    assert.equal(after.level, 2, 'and the level stands');
    assert.equal(after.levelsLost, 0);
  });

  it('charges a level-1 character nothing at all', () => {
    // Duris' own guard, `GET_LEVEL(ch) > 1`. Somebody learning that mobs hit back should not also be
    // learning about debt, and there is nothing below level 1 to demote them to.
    const before = { level: 1, experience: 500, maxHp: 22 };
    const after = applyDeathCost(before);
    assert.equal(after.experienceLost, 0);
    assert.deepEqual({ level: after.level, experience: after.experience }, { level: 1, experience: 500 });
  });

  it('takes a level only when there is not enough banked to pay', () => {
    // Dying near the top of a level is cheap; near the bottom it costs the level. That is the right
    // shape — it takes the progress you actually had.
    const after = applyDeathCost({ level: 3, experience: 50, maxHp: 30 });
    assert.equal(after.levelsLost, 1);
    assert.equal(after.level, 2);
    // 50 - 200 = -150, refilled by level 3's own cost of 2,000.
    assert.equal(after.experience, 1_850);
  });

  it('never demotes below level 1, and never banks a negative', () => {
    const after = applyDeathCost({ level: 2, experience: 0, maxHp: 25 });
    assert.equal(after.level, 1);
    assert.ok(after.experience >= 0);
  });

  it('keeps the hit points the lost level bought', () => {
    // They were *rolled* and stored, so there is no formula to invert — and subtracting an average
    // would let a character farm a maximum by dying at the right moment. See `DESIGN-progression.md`.
    const after = applyDeathCost({ level: 3, experience: 0, maxHp: 30 });
    assert.equal(after.levelsLost, 1);
    assert.equal(after.maxHp, 30);
  });

  it('scales with the band, because the curve does', () => {
    // Level 16 costs 100,000, so dying there is 10,000 — fifty times the level-2 charge. The penalty
    // stays worth the same fraction of your time at every level, which a flat number would not.
    assert.equal(applyDeathCost({ level: 15, experience: 999_999, maxHp: 60 }).experienceLost, 10_000);
    assert.equal(applyDeathCost({ level: 2, experience: 999_999, maxHp: 25 }).experienceLost, 200);
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
