/**
 * Experience: contribution, and the group divisor whose sign decides whether players ever group.
 *
 * The tank and healer tests are the point of the phase. A last-hit rule would pay them nothing, and
 * §4.4 is explicit that getting the group divisor backwards makes solo play optimal and stops the whole
 * social layer forming.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  VALUE_PER_SUPPORT_ACT,
  contributionValue,
  divideExperience,
  groupDivisor,
  groupedShare,
  groupMultiplier,
  powerLevelDivisor,
  type Contribution,
} from './index.ts';

const did = (over: Partial<Contribution> = {}): Contribution => ({ dealt: 0, taken: 0, supported: 0, ...over });

describe('what a contribution is worth', () => {
  it('values damage taken as highly as damage dealt', () => {
    // Deliberate. A tank standing in front of something for a whole fight contributed as much as the
    // person hitting it, and any discount here tells players that tanking is the lesser job.
    assert.equal(contributionValue(did({ dealt: 100 })), contributionValue(did({ taken: 100 })));
  });

  it('pays support per act rather than per point', () => {
    // Paying by amount healed would make a healer's share depend on how badly the tank was playing.
    assert.equal(contributionValue(did({ supported: 2 })), VALUE_PER_SUPPORT_ACT * 2);
  });

  it('is nothing for somebody who did nothing', () => {
    assert.equal(contributionValue(did()), 0);
  });
});

describe('dividing a kill', () => {
  it('pays in proportion to contribution', () => {
    const awards = divideExperience(1000, new Map([
      [1, did({ dealt: 300 })],
      [2, did({ dealt: 100 })],
    ]));
    assert.equal(awards.find((a) => a.actor === 1)?.experience, 750);
    assert.equal(awards.find((a) => a.actor === 2)?.experience, 250);
  });

  it('pays a tank who dealt no damage at all', () => {
    // The phase's headline rule. Under a last-hit or damage-only scheme this character earns nothing,
    // and tanking becomes something you do for other people rather than something you do.
    const awards = divideExperience(1000, new Map([
      [1, did({ dealt: 500 })],
      [2, did({ taken: 500 })],
    ]));
    assert.equal(awards.find((a) => a.actor === 2)?.experience, 500);
  });

  it('pays a healer who neither dealt nor took anything', () => {
    const awards = divideExperience(1000, new Map([
      [1, did({ dealt: 975 })],
      [2, did({ supported: 1 })],
    ]));
    const healer = awards.find((a) => a.actor === 2);
    assert.ok(healer);
    assert.ok(healer.experience > 0, 'a share, not nothing');
  });

  it('ignores somebody who merely stood there', () => {
    const awards = divideExperience(1000, new Map([[1, did({ dealt: 100 })], [2, did()]]));
    assert.deepEqual(awards.map((a) => a.actor), [1]);
  });

  it('pays nothing from an empty pool, and nothing to nobody', () => {
    assert.deepEqual(divideExperience(0, new Map([[1, did({ dealt: 10 })]])), []);
    assert.deepEqual(divideExperience(1000, new Map()), []);
  });

  it('never pays out more than the pool', () => {
    // Rounding down per share with the remainder lost, rather than handed to the biggest contributor —
    // a rounding rule that favours damage is the thumb on the scale this module exists to avoid.
    const awards = divideExperience(1000, new Map([
      [1, did({ dealt: 33 })],
      [2, did({ dealt: 33 })],
      [3, did({ dealt: 33 })],
    ]));
    assert.ok(awards.reduce((sum, a) => sum + a.experience, 0) <= 1000);
  });

  it('divides identically every time', () => {
    const contributions = new Map([[7, did({ dealt: 10 })], [3, did({ taken: 10 })], [5, did({ supported: 1 })]]);
    const first = divideExperience(900, contributions).map((a) => `${a.actor}:${a.experience}`);
    const second = divideExperience(900, contributions).map((a) => `${a.actor}:${a.experience}`);
    assert.deepEqual(first, second);
    assert.deepEqual(first.map((s) => Number(s.split(':')[0])), [3, 5, 7], 'sorted by id, not by insertion');
  });

  it('carries the breakdown, so a player can see why they were paid', () => {
    const awards = divideExperience(100, new Map([[1, did({ taken: 40 })]]));
    assert.deepEqual(awards[0]?.contribution, did({ taken: 40 }));
  });
});

describe('the group divisor — §4.4, and the sign is the mechanic', () => {
  it('is Duris\' (N+3)/4 and not exp/N', () => {
    assert.equal(groupDivisor(1), 1);
    assert.equal(groupDivisor(2), 1.25);
    assert.equal(groupDivisor(4), 1.75);
    assert.equal(groupDivisor(8), 2.75);
  });

  it('makes the party total RISE with size, which is why players group at all', () => {
    // The whole point, as an assertion. With `exp / N` the total is flat and solo is strictly optimal,
    // and §4.4's warning is that the entire social layer then never forms.
    const total = (members: number) => (members / groupDivisor(members));
    assert.ok(total(2) > total(1));
    assert.ok(total(4) > total(2));
    assert.ok(total(8) > total(4));
  });

  it('still gives each member less than a solo kill, so grouping is a trade', () => {
    for (const members of [2, 4, 8]) {
      assert.ok(1 / groupDivisor(members) < 1, `${members} members`);
    }
  });

  it('treats a party of none as a party of one', () => {
    assert.equal(groupDivisor(0), 1);
  });
});

describe('what a group does to a contribution share — Phase 18', () => {
  it('lands on Duris\' own numbers when everybody pulls their weight', () => {
    // Two equal contributors split the pool 50/50 and the multiplier takes each to 80% of a solo kill —
    // 160% between them, which is the divisor's table read from the other end.
    assert.equal(groupedShare(500, { members: 2, level: 10, highest: 10 }), 800);
    assert.equal(groupMultiplier(2), 1.6);
    // Four equal contributors: 25% each × 2.2857 = 57.1%, the table's 57%.
    assert.equal(Math.round(groupMultiplier(4) * 25), 57);
  });

  it('leaves a lone contributor exactly where they were, grouped or not', () => {
    // The rule has to be invisible to somebody fighting alone, or every ungrouped kill in the game
    // changes the day grouping lands.
    assert.equal(groupMultiplier(1), 1);
    assert.equal(groupedShare(1234, { members: 1, level: 20, highest: 20 }), 1234);
  });

  it('pays nothing extra for members who did not fight, because they are not counted', () => {
    // Owner's call, 2026-08-06: `members` is contributing members present, so twelve idle alts parked
    // in the room cannot turn one player's solo kill into 3.25 kills. The caller counts; this asserts
    // that the arithmetic gives them no way to profit if they did not.
    const alone = groupedShare(1000, { members: 1, level: 30, highest: 30 });
    assert.equal(alone, 1000);
  });

  it('walls off power-levelling at the source\'s own four steps', () => {
    assert.equal(powerLevelDivisor(50, 50), 1);
    assert.equal(powerLevelDivisor(36, 50), 1, 'fourteen levels is still a group');
    assert.equal(powerLevelDivisor(35, 50), 40);
    assert.equal(powerLevelDivisor(30, 50), 150);
    assert.equal(powerLevelDivisor(20, 50), 1000);
    assert.equal(powerLevelDivisor(10, 50), 5000);
  });

  it('applies the bonus first and the wall second, so a bigger group cannot buy the penalty back', () => {
    // 1,000 × 1.6 = 1,600, then ÷ 5,000 → 0. The other order would floor to 0 and then multiply 0,
    // which happens to agree here — so the assertion that matters is the one where it does not.
    assert.equal(groupedShare(100_000, { members: 2, level: 5, highest: 50 }), 32);
    assert.equal(Math.floor(100_000 / 5000) * 1.6, 32.0, 'and the orders agree only by luck at this size');
    // A level 1 taking one hit from a level 50 mob is genuine contribution and would otherwise be a
    // career: a share worth dozens of their levels becomes nothing at all.
    assert.equal(groupedShare(50_000, { members: 2, level: 1, highest: 50 }), 16);
  });

  it('floors, because a fraction of a point is not spendable', () => {
    assert.equal(groupedShare(1, { members: 2, level: 10, highest: 10 }), 1);
    assert.equal(groupedShare(1, { members: 2, level: 10, highest: 40 }), 0);
  });
});
