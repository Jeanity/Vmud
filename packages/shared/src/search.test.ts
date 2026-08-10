/**
 * `search` — the conversion and the gate.
 *
 * Worth pinning because the numbers came from a foreign scale: Duris' abilities are percentile and
 * ours are the SRD's 3–18, so copying its single comparison would have made the verb almost never
 * work. The tests below are the arithmetic that says it does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCORE_TO_PERCENT, findChance, findsIt } from './search.ts';
import { makeRng } from './rules.ts';

describe('findChance', () => {
  it('averages the two scores that survived the SRD, and converts the scale', () => {
    // `(GET_C_INT + GET_C_WIS + GET_C_LUK) / 3` with luck dropped, then x5 to reach percentile.
    assert.equal(findChance(10, 10), 50, 'an unremarkable character is a coin flip');
    assert.equal(findChance(18, 18), 90, 'and a brilliant one is nine times in ten');
    assert.equal(findChance(3, 3), 15, 'a dull one still gets to try');
    assert.equal(findChance(16, 12), 70);
  });

  it('would have been almost useless if the scale had simply been copied', () => {
    // The reason the conversion exists, stated as a number: Duris compares the raw average against
    // number(1, 101). An SRD 18 average copied straight across lands 18 times in 100 - so the best
    // searcher in the game would be worse than our worst one is now.
    const copied = 18;
    assert.ok(findChance(18, 18) > copied * 4, 'x5 is doing real work, not decoration');
    assert.equal(SCORE_TO_PERCENT, 5);
  });

  it('clamps rather than trusting a modified score', () => {
    assert.equal(findChance(40, 40), 100);
    assert.equal(findChance(-5, 0), 0);
  });
});

describe('findsIt', () => {
  it('is deterministic for a given seed, because simulation has to be', () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    const runA = Array.from({ length: 20 }, () => findsIt(a, 12, 12));
    const runB = Array.from({ length: 20 }, () => findsIt(b, 12, 12));
    assert.deepEqual(runA, runB);
  });

  it('lands about as often as the chance says, over enough tries', () => {
    // Not a distribution test for its own sake: the comparison direction is easy to get backwards,
    // and a flipped `>` would still pass every example above while making clever characters worse
    // at searching than dull ones.
    const rng = makeRng(99);
    const runs = 4000;
    let hits = 0;
    for (let i = 0; i < runs; i++) if (findsIt(rng, 14, 14)) hits++;
    const rate = (hits / runs) * 100;
    assert.ok(Math.abs(rate - 70) < 4, `expected about 70%, got ${rate.toFixed(1)}%`);
  });

  it('makes the wise better at it than the dull, which is the whole design', () => {
    const clever = makeRng(7);
    const dull = makeRng(7);
    let cleverHits = 0;
    let dullHits = 0;
    for (let i = 0; i < 2000; i++) {
      if (findsIt(clever, 17, 16)) cleverHits++;
      if (findsIt(dull, 6, 7)) dullHits++;
    }
    assert.ok(cleverHits > dullHits * 2, `${cleverHits} vs ${dullHits}`);
  });

  it('never finds anything on a hopeless score, and is not a certainty on a great one', () => {
    const rng = makeRng(3);
    // findChance(0, 0) is 0, and number(1, 101) is at least 1, so 0 > n is never true.
    assert.equal(Array.from({ length: 200 }, () => findsIt(rng, 0, 0)).some(Boolean), false);
    // 18/18 is 90, so a roll of 91..101 still fails - a search is never guaranteed.
    const best = makeRng(11);
    assert.equal(Array.from({ length: 400 }, () => findsIt(best, 18, 18)).every(Boolean), false);
  });
});
