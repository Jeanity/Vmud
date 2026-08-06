/**
 * Dodge and parry — Phase 19 slice 2.
 *
 * These pin the four places a reader would otherwise have to trust the transcription: the `MAX(1, …)`
 * floor that only applies to a non-zero skill, parry's dependence on a weapon *and* on the weapon's own
 * skill, the crowd table's surprising `else`, and the critical quirk that looks like a bug.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DODGE_CAP,
  crowdModifier,
  defenceEase,
  defenceVerb,
  dodgeChance,
  mobDefenceSkill,
  parryChance,
} from './defence.ts';

describe('dodging', () => {
  it('is a fifth of the skill', () => {
    // `chance = MAX(1, dodge_skill / 5)`, then the crowd multiplier for a single attacker.
    assert.equal(dodgeChance({ skill: 100, attackers: 1 }), Math.floor(20 * crowdModifier(1)));
    assert.equal(dodgeChance({ skill: 50, attackers: 1 }), Math.floor(10 * crowdModifier(1)));
  });

  it('is nothing at all for somebody who has never dodged', () => {
    // The floor is inside `if (dodge_skill)`, so zero skill is zero chance rather than the 1% a bare
    // `MAX(1, 0/5)` would give. That distinction is the whole reason the source wrote it in two lines.
    assert.equal(dodgeChance({ skill: 0, attackers: 1 }), 0);
    // A trace of skill gets the floor of 1 — and then the lone-attacker penalty rounds it back to
    // nothing, which is the source's own arithmetic: `(int)(1 * 0.86)`. The floor is what stops the
    // *division* erasing a skill, not a promise that any skill at all is worth something.
    assert.equal(dodgeChance({ skill: 4, attackers: 1 }), 0);
    assert.ok(dodgeChance({ skill: 10, attackers: 1 }) > 0);
  });

  it('adds the critical bonus after the crowd penalty, not before', () => {
    // `getCharDodgeVal` applies its modifiers and clamps to 100; the overshoot is added at the *call
    // site* and only then capped at 60. Putting it first would send the bonus through the crowd penalty
    // too — a quietly smaller number, and one nothing would have caught.
    const rolled = Math.floor(20 * crowdModifier(1));
    assert.equal(dodgeChance({ skill: 100, attackers: 1, criticalOvershoot: 30 }), rolled + 30);
  });

  it('cannot reach its own cap, which is a fact about what we have not built', () => {
    // Worth recording rather than glossed. The best case is a maxed skill alone against one attacker on
    // a critical: 20 × 0.86 → 17, plus the 30 overshoot, is 47 — and the arithmetic ceiling with no
    // crowd penalty at all would be 50. `DODGE_CAP` is 60 because the source doubles the whole thing for
    // drow and halflings (`vict_dodge *= 2`), and we have no races until Phase 21. The cap is therefore
    // dead code today, kept because it becomes live the moment the race column is read.
    const best = dodgeChance({ skill: 100, attackers: 1, criticalOvershoot: 30 });
    assert.ok(best < DODGE_CAP, `${best} is the real ceiling, under the cap of ${DODGE_CAP}`);
    assert.equal(best, Math.floor(20 * crowdModifier(1)) + 30);
  });

  it('is helped by a critical from somebody who could not otherwise have hit', () => {
    // The quirk kept rather than tidied: `vict_dodge += BOUNDED(0, (hitrand - ch_tohit) / 2, 30)` can
    // only fire on a critical, so a wild swing that happened to land perfectly is the easiest thing in
    // the game to get out of the way of.
    const ordinary = dodgeChance({ skill: 60, attackers: 1 });
    const wild = dodgeChance({ skill: 60, attackers: 1, criticalOvershoot: 20 });
    assert.ok(wild > ordinary, `${wild} should beat ${ordinary}`);
  });
});

describe('parrying', () => {
  it('is nothing with an empty hand, whatever the skill', () => {
    // `if (… || !weapon) return 0` — you do not parry a sword with your arm, and that gate is why parry
    // gets the higher cap.
    assert.equal(parryChance({ parrySkill: 95, weaponSkill: 95, attackers: 1, armed: false }), 0);
  });

  it('is half the knack and half the weapon', () => {
    const both = parryChance({ parrySkill: 100, weaponSkill: 100, attackers: 1, armed: true });
    const skilledButUnfamiliar = parryChance({ parrySkill: 100, weaponSkill: 0, attackers: 1, armed: true });
    assert.ok(skilledButUnfamiliar < both, 'a strange weapon parries worse');
    // 50 + 0 → 10 before the crowd multiplier, against 50 + 50 → 20.
    assert.equal(skilledButUnfamiliar, Math.floor(10 * crowdModifier(1)));
    assert.equal(both, Math.floor(20 * crowdModifier(1)));
  });
});

describe('being set upon by several people', () => {
  it('charges the defender even for one attacker', () => {
    // The part a reader would get wrong: the chain is `if / else if / else`, so a lone attacker falls
    // into the `else` and costs 14%. It is not a rounding artefact — being attacked at all is what the
    // default case charges for.
    assert.equal(crowdModifier(1), 1 - 0.14);
  });

  it('follows the source’s own table, which is not monotonic in the obvious way', () => {
    assert.equal(crowdModifier(2), 0.9);
    assert.equal(crowdModifier(3), 0.75);
    assert.equal(crowdModifier(4), 0.6);
    assert.equal(crowdModifier(5), 0.4);
    // Six falls back to the formula, which is *milder* than five's flat 0.6 penalty — the table and the
    // fall-through disagree at the seam, and it is the source's own seam.
    assert.equal(Math.round(crowdModifier(6) * 100) / 100, 0.16);
  });

  it('can take a defence to nothing', () => {
    assert.equal(dodgeChance({ skill: 95, attackers: 8 }), 0);
  });
});

describe('a mob’s own defence', () => {
  it('is twice its level, capped', () => {
    assert.equal(mobDefenceSkill(8), 16);
    assert.equal(mobDefenceSkill(60), 100);
    assert.equal(mobDefenceSkill(0), 0);
  });

  it('leaves a low-level mob with a small but real chance', () => {
    // Level 8 → skill 16 → 3 before the crowd penalty. Present, and not a stealth rebalance of the
    // whole world.
    assert.equal(dodgeChance({ skill: mobDefenceSkill(8), attackers: 1 }), 2);
  });
});

describe('how it reads', () => {
  it('grades on the chance rather than the roll', () => {
    // `getDodgeEaseString(passedby, …)` is called with the *chance*, so the prose says how good you are
    // at this rather than how close that one was.
    assert.equal(defenceEase(90), 'no-trouble');
    assert.equal(defenceEase(61), 'easily');
    assert.equal(defenceEase(41), 'plain');
    assert.equal(defenceEase(21), 'barely');
    assert.equal(defenceEase(20), 'narrowly');
  });

  it('says the narrowest dodge as the blow nearly landing', () => {
    // The one line not built on the verb, and it is the source's own phrasing.
    assert.equal(defenceVerb('dodge', 'narrowly', true), 'narrowly miss being hit by');
    assert.equal(defenceVerb('dodge', 'narrowly', false), 'narrowly misses being hit by');
  });

  it('agrees with itself in both persons', () => {
    assert.equal(defenceVerb('parry', 'plain', true), 'parry');
    assert.equal(defenceVerb('parry', 'plain', false), 'parries');
    assert.equal(defenceVerb('dodge', 'plain', true), 'dodge');
    assert.equal(defenceVerb('dodge', 'plain', false), 'dodges');
  });
});
