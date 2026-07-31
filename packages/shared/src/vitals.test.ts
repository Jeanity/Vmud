import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AffectFlag, hasFlag, sumApply } from './affects.ts';
import { POSTURES, STATUSES, type Posture, type Stance, type Status } from './position.ts';
import {
  BASE_REGEN,
  REGEN_APPLY,
  REGEN_BONUS_SOFT_CAP,
  SECOND_WIND_AFTER_MS,
  SECOND_WIND_BONUS,
  SECOND_WIND_DURATION_MS,
  TICKS_PER_MINUTE,
  accrue,
  canAffordStep,
  clampPool,
  isResting,
  moveCost,
  needsRegen,
  regenBonus,
  regenPerMinute,
  regenerates,
  secondWindAffects,
  settlingAffect,
} from './vitals.ts';
import { SECTOR_MOVE_COST } from './world.ts';

const stance = (posture: Posture, status: Status): Stance => ({ posture, status });

describe('regenPerMinute — the two axes multiply', () => {
  it('takes standing and awake as the baseline', () => {
    assert.equal(regenPerMinute('hp', stance('standing', 'normal')), BASE_REGEN.hp);
  });

  it('scales by status, then by posture, and the two stack', () => {
    // This is the payoff for Phase 4's two axes, and the number it produces is the argument. Asleep on
    // the floor is 1.5 x 1.25; collapse the axes into one enum and this combination cannot be said.
    const base = BASE_REGEN.hp;
    assert.equal(regenPerMinute('hp', stance('standing', 'resting')), base * 1.25);
    assert.equal(regenPerMinute('hp', stance('prone', 'normal')), base * 1.25);
    assert.equal(regenPerMinute('hp', stance('prone', 'sleeping')), base * 1.5 * 1.25);
  });

  it('makes resting strictly better than standing for every pool', () => {
    // The roadmap's completion test, as arithmetic.
    for (const pool of ['hp', 'mana', 'move'] as const) {
      const standing = regenPerMinute(pool, stance('standing', 'normal'));
      const resting = regenPerMinute(pool, stance('sitting', 'resting'));
      const asleep = regenPerMinute(pool, stance('prone', 'sleeping'));
      assert.ok(resting > standing, `${pool}: resting ${resting} should beat standing ${standing}`);
      assert.ok(asleep > resting, `${pool}: asleep ${asleep} should beat resting ${resting}`);
    }
  });

  it('bleeds hit points while dying, and only hit points', () => {
    // `hit_regen` returns an absolute -2 and -1 for these, overriding the base rather than scaling it.
    // That is what makes the dying window a clock: left alone, you get worse.
    assert.equal(regenPerMinute('hp', stance('prone', 'dying')), -2);
    assert.equal(regenPerMinute('hp', stance('prone', 'incapacitated')), -1);
    // A dying character does not lose stamina. They lose blood.
    assert.equal(regenPerMinute('move', stance('prone', 'dying')), 0);
    assert.equal(regenPerMinute('mana', stance('prone', 'incapacitated')), 0);
  });

  it('ignores posture entirely once the status overrides', () => {
    // The absolute rates replace the base, so the posture multiplier has nothing to multiply. A
    // comfortable dying man bleeds at the same rate as an uncomfortable one.
    for (const posture of POSTURES) {
      assert.equal(regenPerMinute('hp', stance(posture, 'dying')), -2, posture);
    }
  });

  it('stops dead in a fight', () => {
    // Without this, resting would be a way to out-heal being hit.
    for (const pool of ['hp', 'mana', 'move'] as const) {
      assert.equal(regenPerMinute(pool, stance('prone', 'sleeping'), { fighting: true }), 0, pool);
    }
  });

  it('gives the dead nothing', () => {
    assert.equal(regenPerMinute('hp', stance('prone', 'dead')), 0);
    assert.equal(regenerates(stance('prone', 'dead')), false);
    assert.equal(regenerates(stance('prone', 'dying')), true, 'the dying still change, downward');
  });

  it('has an answer for every combination, with and without a bonus', () => {
    for (const posture of POSTURES) {
      for (const status of STATUSES) {
        for (const pool of ['hp', 'mana', 'move'] as const) {
          for (const bonus of [0, 6, 40, -3]) {
            const rate = regenPerMinute(pool, stance(posture, status), { bonus });
            assert.ok(Number.isFinite(rate), `${pool} ${posture}/${status} +${bonus} -> ${rate}`);
          }
        }
      }
    }
  });
});

/**
 * The flat bonus, which is the half of the affect record combat and buffs will all use.
 *
 * The rule that matters and is easy to get backwards: `points.hit_reg` is added **after** both position
 * switches in `hit_regen`, not before. Posture and status are multiplicative, gear-style bonuses are
 * additive, and they do not compound — fold the bonus in first and a 1.875x sleep multiplier doubles
 * every buff in the game.
 */
describe('regenPerMinute — the flat bonus', () => {
  it('adds to the baseline without being scaled by it', () => {
    const standing = regenPerMinute('hp', stance('standing', 'normal'), { bonus: 6 });
    const resting = regenPerMinute('hp', stance('standing', 'resting'), { bonus: 6 });
    assert.equal(standing, BASE_REGEN.hp + 6);
    assert.equal(resting, BASE_REGEN.hp * 1.25 + 6, 'the bonus is not multiplied by the posture');
    // Stated as the thing it prevents: the same bonus is worth the same in both stances.
    assert.equal(resting - regenPerMinute('hp', stance('standing', 'resting')), standing - BASE_REGEN.hp);
  });

  it('pays the first sixteen points in full and taxes the rest', () => {
    // `if (hit_reg > 16) gain += 2 * sqrt(4 * hit_reg)`, which is 4 * sqrt(hit_reg). Continuous where it
    // matters: 16 pays 16, 17 pays 16.49. Nothing we ship reaches it — the curve is here so a Phase 16
    // armour set does not silently get linear returns.
    assert.equal(regenBonus(0), 0);
    assert.equal(regenBonus(REGEN_BONUS_SOFT_CAP), REGEN_BONUS_SOFT_CAP);
    assert.ok(regenBonus(17) > 16 && regenBonus(17) < 17, `17 -> ${regenBonus(17)}`);
    assert.ok(regenBonus(100) < 100 / 2, 'a hundred is worth well under half of itself');
    // Monotonic, so more is never worse — a cap that could be over-invested past is a trap.
    for (let n = 1; n < 200; n++) assert.ok(regenBonus(n) >= regenBonus(n - 1), `${n}`);
  });

  it('lets hit-point regeneration slow a bleed, because that is what the source does', () => {
    // `gain = -2` overrides the *base*, and `points.hit_reg` is added on top of it. Faithful, and a
    // moment worth having: you rested, you were beaten down, and you cling on.
    assert.equal(regenPerMinute('hp', stance('prone', 'dying'), { bonus: 1 }), -1);
    assert.ok(regenPerMinute('hp', stance('prone', 'dying'), { bonus: 6 }) > 0);
  });

  it('never lets the dying come to a standstill', () => {
    // `if (gain == 0 && GET_STAT(ch) < STAT_SLEEPING) gain = -1;` — a clause that exists *precisely*
    // because the bonus can cancel the bleed. It keeps the dying window a clock: the best a bonus can
    // do is buy longer to be rescued in, never a stable unconscious body.
    assert.equal(regenPerMinute('hp', stance('prone', 'dying'), { bonus: 2 }), -1);
    assert.equal(regenPerMinute('hp', stance('prone', 'incapacitated'), { bonus: 1 }), -1);
  });

  it('refuses to give a zeroed pool a positive bonus', () => {
    // `move_regen` guards the addition with `if (gain || move_reg < 0)`. A dying character does not
    // recover stamina because they had a good sit down.
    assert.equal(regenPerMinute('move', stance('prone', 'dying'), { bonus: 8 }), 0);
    assert.equal(regenPerMinute('mana', stance('prone', 'incapacitated'), { bonus: 6 }), 0);
    // A negative one still applies, which is the other half of that same clause.
    assert.equal(regenPerMinute('move', stance('prone', 'dying'), { bonus: -3 }), -3);
  });

  it('gives a corpse nothing, however large the bonus', () => {
    // Said before the clauses above rather than left to fall out of them: with a bonus in play, `gain =
    // 0` plus a positive modifier would have the dead healing.
    for (const pool of ['hp', 'mana', 'move'] as const) {
      assert.equal(regenPerMinute(pool, stance('prone', 'dead'), { bonus: 99 }), 0, pool);
    }
  });

  it('is still zeroed by a fight, bonus or no bonus', () => {
    assert.equal(regenPerMinute('hp', stance('prone', 'sleeping'), { bonus: 20, fighting: true }), 0);
  });
});

describe('the rest cycle', () => {
  it('rewards patience with more than it cost', () => {
    assert.ok(SECOND_WIND_DURATION_MS > SECOND_WIND_AFTER_MS);
  });

  it('counts resting and sleeping as rest, and nothing else', () => {
    const resting = STATUSES.filter(isResting);
    assert.deepEqual(resting, ['sleeping', 'resting']);
  });

  it('installs one node per pool, all of one type — the multi-apply idiom', () => {
    // This is `REFERENCE-mud-mechanics.md` §4.12 in the flesh, and it is the reason the first thing to
    // use the primitive was chosen to need it: a rule about runs of one type only stays true in code if
    // something actually installs a run.
    const nodes = secondWindAffects();
    assert.equal(nodes.length, 3);
    assert.deepEqual(new Set(nodes.map((a) => a.type)), new Set(['second_wind']));
    assert.deepEqual(
      nodes.map((a) => a.apply).sort(),
      [REGEN_APPLY.hp, REGEN_APPLY.mana, REGEN_APPLY.move].sort(),
    );
    for (const pool of ['hp', 'mana', 'move'] as const) {
      assert.equal(sumApply(nodes, REGEN_APPLY[pool]), SECOND_WIND_BONUS[pool], pool);
    }
  });

  it('makes a measurable difference to resting, and stays well under the soft cap', () => {
    // The phase's completion test as arithmetic: a bar that moved every four seconds moves every three.
    const plain = regenPerMinute('hp', stance('standing', 'resting'));
    const buffed = regenPerMinute('hp', stance('standing', 'resting'), { bonus: SECOND_WIND_BONUS.hp });
    assert.equal(plain, 16.25);
    assert.equal(buffed, 22.25);
    assert.ok(SECOND_WIND_BONUS.move < REGEN_BONUS_SOFT_CAP, 'the first user should not be the one testing the cap');
  });

  it('asks not to be saved, both stages', () => {
    // The cost of the reward is sitting still. Banking a part-served wait, or the reward itself, across
    // a reconnect would be a way to skip that.
    for (const affect of [settlingAffect(), ...secondWindAffects()]) {
      assert.ok(hasFlag(affect, AffectFlag.NoSave), affect.type);
      assert.ok(!hasFlag(affect, AffectFlag.NoShow), `${affect.type} is meant to be watched`);
    }
  });

  it('makes the wait a bare timer that derives nothing', () => {
    const settling = settlingAffect();
    assert.equal(settling.apply, 'none');
    assert.equal(settling.modifier, 0);
    assert.equal(settling.durationMs, SECOND_WIND_AFTER_MS);
  });
});

describe('accrue — the fractional carry', () => {
  /** Runs `minutes` of ticks at a rate and returns the whole points delivered. */
  function overMinutes(rate: number, minutes: number): number {
    let carry = 0;
    let total = 0;
    for (let tick = 0; tick < TICKS_PER_MINUTE * minutes; tick++) {
      const step = accrue(carry, rate);
      carry = step.carry;
      total += step.points;
    }
    return total;
  }

  it('carries the remainder rather than rounding it away', () => {
    // The bug this exists to prevent: 13 per minute is 0.0217 of a point per 100 ms tick. Round per
    // tick and every rate in the game is exactly zero, for ever.
    assert.equal(overMinutes(13, 1), 13);
  });

  it('does not accumulate error — the lag stays inside one point however long it runs', () => {
    // Floating-point addition means a slow rate can deliver its last point a tick or two late: 2 per
    // minute lands its second point on tick 601. What matters is that the carry keeps the remainder, so
    // that lag is a fixed offset rather than a leak. Measured at 1 and 20 minutes it is the same 1.
    for (const rate of [1, 2, 16, -2]) {
      for (const minutes of [1, 20]) {
        const delivered = overMinutes(rate, minutes);
        const want = rate * minutes;
        assert.ok(
          Math.abs(delivered - want) <= 1,
          `rate ${rate} over ${minutes}min delivered ${delivered}, wanted ${want}`,
        );
      }
    }
  });

  it('delivers nothing on a single tick at a realistic rate, and that is correct', () => {
    const { points, carry } = accrue(0, 13);
    assert.equal(points, 0);
    assert.ok(carry > 0 && carry < 1);
  });

  it('spends a whole point the moment the carry reaches one', () => {
    const { points, carry } = accrue(0.99, 13);
    assert.equal(points, 1);
    assert.ok(carry < 1);
  });

  it('truncates toward zero on both signs, so a bleed keeps pace with a heal', () => {
    // `Math.floor` would make -2/min spend its first point on tick 1 and +2/min on tick 301 — a bleed
    // that outran an identical heal. Truncation makes the two mirror images, which this asserts by
    // measuring *when* each fires rather than only how much.
    const firstPointAt = (rate: number): number => {
      let carry = 0;
      for (let tick = 1; tick <= TICKS_PER_MINUTE * 2; tick++) {
        const step = accrue(carry, rate);
        carry = step.carry;
        if (step.points !== 0) return tick;
      }
      return -1;
    };
    for (const rate of [1, 2, 13, 16]) {
      assert.equal(firstPointAt(rate), firstPointAt(-rate), `rate ${rate} vs ${-rate}`);
    }
    assert.equal(overMinutes(-13, 1), -13);
  });

  it('handles a zero rate without drifting', () => {
    assert.deepEqual(accrue(0, 0), { points: 0, carry: 0 });
  });
});

describe('needsRegen', () => {
  it('is done when the pool is full and healing', () => {
    // `hit_regen` opens with this test, and it is what lets an idle character cost nothing.
    assert.equal(needsRegen(10, 10, 13), false);
    assert.equal(needsRegen(9, 10, 13), true);
  });

  it('is never done while bleeding, even at full', () => {
    assert.equal(needsRegen(10, 10, -2), true);
  });

  it('is done when the rate is zero', () => {
    assert.equal(needsRegen(1, 10, 0), false);
  });
});

describe('clampPool', () => {
  it('holds a pool inside its own range', () => {
    assert.equal(clampPool(12, 10, 0), 10);
    assert.equal(clampPool(-5, 10, 0), 0);
    assert.equal(clampPool(-5, 10, -11), -5, 'hit points have a negative half');
    assert.equal(clampPool(-20, 10, -11), -11);
  });
});

describe('moveCost', () => {
  it('averages the terrain you leave and the terrain you enter', () => {
    // Diku's rule. A step from road onto mountain costs less than mountain to mountain, which is what
    // makes a road worth following.
    const road = SECTOR_MOVE_COST.road;
    const mountain = SECTOR_MOVE_COST.mountain;
    assert.equal(moveCost('road', 'road'), road);
    assert.equal(moveCost('mountain', 'mountain'), mountain);
    assert.ok(moveCost('road', 'mountain') < mountain);
    assert.ok(moveCost('road', 'mountain') > road);
  });

  it('is symmetric', () => {
    assert.equal(moveCost('road', 'swamp'), moveCost('swamp', 'road'));
  });

  it('never charges nothing', () => {
    // A free step would make the pool decorative again, which is the state this whole mechanism exists
    // to end.
    for (const from of Object.keys(SECTOR_MOVE_COST) as (keyof typeof SECTOR_MOVE_COST)[]) {
      for (const to of Object.keys(SECTOR_MOVE_COST) as (keyof typeof SECTOR_MOVE_COST)[]) {
        assert.ok(moveCost(from, to) >= 1, `${from} -> ${to}`);
      }
    }
  });

  it('makes hard ground actually cost more', () => {
    assert.ok(moveCost('mountain', 'mountain') > moveCost('city', 'city'));
    assert.ok(moveCost('swamp', 'swamp') > moveCost('field', 'field'));
  });
});

describe('canAffordStep', () => {
  it('allows a step the pool exactly covers, and refuses one it does not', () => {
    // Running out of movement does not disable walking — it makes each step something you must have
    // the stamina for, which is why this is a per-step test rather than a state.
    assert.equal(canAffordStep(3, 3), true);
    assert.equal(canAffordStep(2, 3), false);
    assert.equal(canAffordStep(0, 1), false);
  });
});
