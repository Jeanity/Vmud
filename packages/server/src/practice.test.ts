/**
 * The teaching's contract — Phase 24, `guild.c` behaviours held by number: the cost curve at our
 * copper scale, the walls in the source's order, and the four sassy refusals kept word for word.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { practiceCost, practiceRefusal, practiceSlate } from './practice.ts';

describe('practiceCost — SkillRaiseCost ×100, floored at ten silver', () => {
  it('follows the curve: cheap at the bottom, sixty-five gold-hundredths at mastery', () => {
    assert.equal(practiceCost(0), 1000, 'the floor: ten silver');
    assert.equal(practiceCost(19), 1000, 's=1 stays on the floor');
    assert.equal(practiceCost(50), 1700, 's=5: 25−10+2');
    assert.equal(practiceCost(70), 3700, 's=7: 49−14+2');
    assert.equal(practiceCost(94), 6500, 's=9: 81−18+2 — the master rate');
  });
});

describe('practiceSlate — what the hall teaches, what you may have', () => {
  it('offers a warrior hall’s skills to a warrior, priced', () => {
    const rows = practiceSlate('warrior', { classId: 'warrior', level: 20, learned: () => 10 });
    assert.ok(rows.length > 0, 'a warrior hall teaches something');
    const priced = rows.filter((row) => row.cost !== undefined);
    assert.ok(priced.length > 0, 'a warrior may buy in his own hall');
    assert.ok(priced.every((row) => row.cost === 1000), 'all priced at the floor for a novice');
  });

  it('shows a sorcerer the warrior hall’s slate as refusals, not a blank wall', () => {
    const rows = practiceSlate('warrior', { classId: 'sorcerer', level: 20, learned: () => 0 });
    const priced = rows.filter((row) => row.cost !== undefined);
    const barred = rows.filter((row) => row.cost === undefined);
    assert.ok(barred.length > 0, 'a sorcerer cannot have most of a warrior hall');
    assert.ok(priced.length < rows.length, 'and the slate says so row by row');
  });

  it('prices only what the student’s level has reached — a grant below its level is a ceiling of 0', () => {
    const low = practiceSlate('warrior', { classId: 'warrior', level: 1, learned: () => 0 });
    const high = practiceSlate('warrior', { classId: 'warrior', level: 40, learned: () => 0 });
    const pricedLow = low.filter((row) => row.cost !== undefined).length;
    const pricedHigh = high.filter((row) => row.cost !== undefined).length;
    assert.ok(pricedHigh > pricedLow, 'levels open doors in the same hall');
  });
});

describe('practiceRefusal — the walls, in the source’s order and words', () => {
  const base = { learned: 10, ceiling: 95, studentLevel: 20, teacherLevel: 50, canAfford: true };

  it('lets an ordinary lesson proceed', () => {
    assert.equal(practiceRefusal(base, 1), undefined);
  });

  it('refuses the unteachable before the purse', () => {
    assert.match(practiceRefusal({ ...base, ceiling: 0, canAfford: false }, 1)!, /not something I can teach/);
  });

  it('refuses the broke with the source’s own apology', () => {
    assert.equal(practiceRefusal({ ...base, canAfford: false }, 1), "Sorry, boss, but I'm afraid you cannot afford the training.");
  });

  it('holds the twice-your-level wall with both of the source’s sentences', () => {
    assert.match(practiceRefusal({ ...base, learned: 41 }, 1)!, /not fully grasped/);
    assert.match(practiceRefusal({ ...base, learned: 40 }, 1)!, /go learn more on your own/);
  });

  it('holds the ceiling', () => {
    assert.equal(practiceRefusal({ ...base, learned: 95, studentLevel: 60 }, 1), "I'm sorry but I can teach you no more.");
  });

  it('rolls all four sassy refusals at twice the teacher’s level, word for word', () => {
    const args = { ...base, learned: 30, studentLevel: 60, teacherLevel: 15 };
    assert.equal(practiceRefusal(args, 1), 'You are awesome already! Perhaps you would be so kind as to teach me?');
    assert.equal(practiceRefusal(args, 2), 'You trying to make a fool of me? I can teach you nothing more!');
    assert.equal(practiceRefusal(args, 3), 'I fear I am not good enough to teach you more.');
    assert.equal(practiceRefusal(args, 4), 'Begone from my halls! I do not stand for sarcasm!');
  });
});
