import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  HP_DEAD_BELOW,
  HP_DYING_AT_OR_BELOW,
  HP_INCAPACITATED_AT_OR_BELOW,
  POSTURES,
  STATUSES,
  describeStance,
  isConscious,
  meets,
  postureRank,
  shortfall,
  statusFor,
  statusRank,
  type Posture,
  type Requirement,
  type Stance,
  type Status,
} from './position.ts';

const stance = (posture: Posture, status: Status): Stance => ({ posture, status });
const need = (posture: Posture, status: Status): Requirement => ({ posture, status });

describe('the two ladders', () => {
  it('orders posture least-capable first, matching the MUD constants', () => {
    // POS_PRONE 0, POS_SITTING 1, POS_KNEELING 2, POS_STANDING 3 — the numbers are compared with
    // `>=`, so the order is the mechanism and reordering this list silently changes every gate.
    assert.deepEqual([...POSTURES], ['prone', 'sitting', 'kneeling', 'standing']);
    assert.equal(postureRank('prone'), 0);
    assert.equal(postureRank('standing'), 3);
  });

  it('orders status least-capable first, matching the bit magnitudes', () => {
    // Duris stores these as single bits STAT_DEAD(4) .. STAT_NORMAL(128) and then compares them with
    // `>=`, so the bits are an ordinal scale. We keep the order and drop the packing.
    assert.deepEqual([...STATUSES], ['dead', 'dying', 'incapacitated', 'sleeping', 'resting', 'normal']);
    assert.equal(statusRank('dead'), 0);
    assert.equal(statusRank('normal'), 5);
    assert.ok(statusRank('sleeping') < statusRank('resting'), 'asleep is worse off than resting');
  });
});

describe('meets — MIN_POS', () => {
  it('compares both axes independently', () => {
    // The whole point of two axes. Standing but asleep fails a status requirement; awake but prone
    // fails a posture one. Neither can excuse the other.
    assert.equal(meets(stance('standing', 'sleeping'), need('standing', 'normal')), false);
    assert.equal(meets(stance('prone', 'normal'), need('standing', 'normal')), false);
    assert.equal(meets(stance('standing', 'normal'), need('standing', 'normal')), true);
  });

  it('is satisfied by anything above the minimum, not only by an exact match', () => {
    assert.equal(meets(stance('standing', 'normal'), need('prone', 'resting')), true);
    assert.equal(meets(stance('kneeling', 'resting'), need('prone', 'resting')), true);
  });

  it('lets a sleeper do the one thing a sleeper must be able to do', () => {
    // `wake` is registered STAT_SLEEPING + POS_PRONE, and it is the only command a sleeper passes.
    // Without it `sleep` would be a command that ends the session.
    const asleep = stance('prone', 'sleeping');
    assert.equal(meets(asleep, need('prone', 'sleeping')), true, 'wake');
    assert.equal(meets(asleep, need('prone', 'resting')), false, 'look');
    assert.equal(meets(asleep, need('standing', 'normal')), false, 'walking');
  });

  it('lets the dead read the interface', () => {
    // `help`, `who` and `score` are all registered at STAT_DEAD — the floor — so they always work.
    // Interface is not action.
    const dead = stance('prone', 'dead');
    assert.equal(meets(dead, need('prone', 'dead')), true);
    assert.equal(meets(dead, need('prone', 'resting')), false);
  });
});

describe('shortfall', () => {
  it('blames status before posture, because that is the more useful complaint', () => {
    // Telling someone to stand up while they are unconscious is not help.
    assert.equal(shortfall(stance('prone', 'sleeping'), need('standing', 'normal')), 'status');
    assert.equal(shortfall(stance('sitting', 'normal'), need('standing', 'normal')), 'posture');
    assert.equal(shortfall(stance('standing', 'normal'), need('standing', 'normal')), undefined);
  });
});

describe('statusFor', () => {
  it('reads the dying window off absolute hit points', () => {
    assert.equal(statusFor(HP_DEAD_BELOW - 1, 'normal', false), 'dead');
    assert.equal(statusFor(HP_DYING_AT_OR_BELOW, 'normal', false), 'dying');
    assert.equal(statusFor(HP_INCAPACITATED_AT_OR_BELOW, 'normal', false), 'incapacitated');
    assert.equal(statusFor(HP_INCAPACITATED_AT_OR_BELOW + 1, 'normal', false), 'normal');
  });

  it('keeps the window a fixed width rather than scaling it', () => {
    // Absolute, deliberately: a rescue is always the same number of points of healing away whether
    // the character has 8 hit points or 800. Scaling would make low-level death instant and
    // high-level death a long slide.
    assert.equal(HP_DEAD_BELOW, -10);
    assert.equal(statusFor(-4, 'normal', false), 'incapacitated');
    assert.equal(statusFor(-7, 'normal', false), 'dying');
  });

  it('is a transition, not a function of hit points alone', () => {
    // The bug this guards: recomputing status from hp every tick would make `sleep` a command that
    // appears to work and silently undoes itself a tenth of a second later.
    assert.equal(statusFor(10, 'sleeping', false), 'sleeping');
    assert.equal(statusFor(10, 'resting', false), 'resting');
    assert.equal(statusFor(10, 'normal', false), 'normal');
  });

  it('wakes a sleeper who is attacked', () => {
    // What stops resting being a way to opt out of being hit.
    assert.equal(statusFor(10, 'sleeping', true), 'normal');
    assert.equal(statusFor(10, 'resting', true), 'normal');
  });

  it('brings someone round resting, never straight to normal', () => {
    // `calculate_ch_state`: if the old status was below sleeping and the hit points have recovered,
    // you regain consciousness lying there. Standing up is a separate act.
    for (const from of ['dead', 'dying', 'incapacitated'] as const) {
      assert.equal(statusFor(5, from, false), 'resting', `recovering from ${from}`);
    }
  });

  it('does not wake the unconscious just because someone swings at them', () => {
    // The fight clause is above the thresholds only. Being attacked while dying does not help.
    assert.equal(statusFor(-7, 'dying', true), 'dying');
  });
});

describe('isConscious', () => {
  it('draws the line at resting', () => {
    assert.equal(isConscious('normal'), true);
    assert.equal(isConscious('resting'), true);
    assert.equal(isConscious('sleeping'), false);
    assert.equal(isConscious('dead'), false);
  });
});

describe('describeStance', () => {
  it('says the remarkable half', () => {
    assert.equal(describeStance(stance('standing', 'normal')), 'is standing here');
    assert.equal(describeStance(stance('sitting', 'normal')), 'is sitting down');
    assert.equal(describeStance(stance('prone', 'dying')), 'is bleeding to death');
  });

  it('keeps the posture when it is the interesting part', () => {
    // The line the two-axis model exists to be able to write.
    assert.equal(describeStance(stance('standing', 'sleeping')), 'is asleep on their feet');
    assert.equal(describeStance(stance('prone', 'sleeping')), 'is asleep, lying on the floor');
  });

  it('has something to say for every combination', () => {
    for (const posture of POSTURES) {
      for (const status of STATUSES) {
        const text = describeStance(stance(posture, status));
        assert.ok(text.startsWith('is '), `${posture}/${status} -> ${text}`);
        assert.ok(text.length > 5);
      }
    }
  });
});
