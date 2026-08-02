/**
 * Morale: the threshold a mob breaks at, and the odds of getting out of a room.
 *
 * The flee-chance table is asserted verbatim because it is a builder's tuning reproduced through the
 * source's own integer truncation — "improving" the arithmetic moves two of its four numbers, and the
 * point of transcribing it was not to end up with something near it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FLEE_COST_MAX,
  FLEE_COST_MIN,
  MAX_FLEE_CHANCE,
  MIN_FLEE_CHANCE,
  breaksMorale,
  escapes,
  fleeChance,
  fleeCost,
  makeRng,
  wimpyThreshold,
} from './index.ts';

describe('when a mob has had enough', () => {
  it('breaks below level * 6 hit points', () => {
    assert.equal(wimpyThreshold(15), 90);
    assert.equal(wimpyThreshold(35), 210);
    assert.equal(wimpyThreshold(60), 360);
  });

  it('never returns a threshold a body could not be above', () => {
    // A level 0 template is not a thing the harvest produces, but a hand-authored one could be, and a
    // threshold of 0 would read as "never flees" — the opposite of what setting the flag meant.
    assert.equal(wimpyThreshold(0), 1);
  });

  it('is a fact about the template, not the fraction remaining', () => {
    // Two guards of one vnum roll different maxima; both break at the same number of points *taken*,
    // which is the whole reason the threshold is absolute. See the module header.
    assert.equal(breaksMorale(89, 90), true);
    assert.equal(breaksMorale(90, 90), false, 'strictly below, as the source has it');
    assert.equal(breaksMorale(200, 90), false);
  });

  it('treats a threshold of zero as a mob that never runs', () => {
    // Most of them: 8 of IceCrag's 61 templates carry the flag.
    assert.equal(breaksMorale(1, 0), false);
    assert.equal(breaksMorale(0, 0), false);
  });
});

describe('the odds of getting out', () => {
  it('reproduces the source table exactly, truncation and all', () => {
    assert.equal(fleeChance(1), 78, 'a dead end');
    assert.equal(fleeChance(2), 80);
    assert.equal(fleeChance(3), 83);
    assert.equal(fleeChance(4), 86, 'a crossroads');
    assert.equal(fleeChance(9), 86, 'four or more is the cap');
    assert.equal(fleeChance(1), MIN_FLEE_CHANCE);
    assert.equal(fleeChance(4), MAX_FLEE_CHANCE);
  });

  it('gives no chance at all from a room with no way out', () => {
    assert.equal(fleeChance(0), 0);
    assert.equal(escapes(() => 0, 0), false, 'even the luckiest roll cannot leave a sealed room');
  });

  it('rolls against that chance', () => {
    // The extremes pin the comparison: `rng` of 0 is the best possible roll and 0.999 the worst.
    assert.equal(escapes(() => 0, 1), true);
    assert.equal(escapes(() => 0.999, 4), false);
  });

  it('escapes about four times in five from a dead end', () => {
    const rng = makeRng(20260802);
    let escaped = 0;
    for (let i = 0; i < 2000; i++) if (escapes(rng, 1)) escaped++;
    // 78/101 ≈ 77%. A wide band, because this asserts the shape rather than the stream.
    assert.ok(escaped > 1400 && escaped < 1700, `escaped ${escaped} of 2000`);
  });
});

describe('what it costs', () => {
  it('rolls within the source band', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 500; i++) {
      const cost = fleeCost(rng);
      assert.ok(cost >= FLEE_COST_MIN && cost <= FLEE_COST_MAX, `cost ${cost} out of band`);
      assert.equal(Number.isInteger(cost), true);
    }
  });

  it('reaches both ends of it', () => {
    assert.equal(fleeCost(() => 0), FLEE_COST_MIN);
    assert.equal(fleeCost(() => 0.999), FLEE_COST_MAX);
  });
});
