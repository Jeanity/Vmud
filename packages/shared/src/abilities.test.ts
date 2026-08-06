/**
 * The two things you can do in a fight — Phase 19 slice 3.
 *
 * What is worth pinning is the conversion and the shape of the two abilities, because both are places where
 * copying Duris' numbers would have been wrong: its skill scale is 1–100 and ours is a d20, and a bash that
 * did a kick's damage would stop being about the knockdown.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  COMBAT_ABILITIES,
  COMBAT_ABILITY_IDS,
  abilityChance,
  abilityDamage,
  isCombatAbility,
} from './abilities.ts';
import { SKILLS } from './skills.ts';
import { toHitFrom } from './skills.ts';

describe('the two abilities', () => {
  it('has a row for every id, each naming a real skill', () => {
    for (const id of COMBAT_ABILITY_IDS) {
      const ability = COMBAT_ABILITIES[id];
      assert.equal(ability.id, id);
      assert.ok(SKILLS[ability.skill], `${id} names a skill that exists`);
      assert.ok(ability.verb.length > 0 && ability.verbThird.length > 0);
    }
    assert.equal(Object.keys(COMBAT_ABILITIES).length, COMBAT_ABILITY_IDS.length);
  });

  it('gates the command dispatch on real ids only', () => {
    assert.equal(isCombatAbility('bash'), true);
    assert.equal(isCombatAbility('kick'), true);
    assert.equal(isCombatAbility('flee'), false);
    assert.equal(isCombatAbility('toString'), false, 'and not through the prototype');
  });

  it('keeps bash about the knockdown and kick about the damage', () => {
    // `do_bash` passes `MAX(1, dam)` — the damage is incidental and the floor is the point. So bash hits
    // for less, knocks down, and costs the longer recovery; kick hits harder and does not.
    assert.equal(COMBAT_ABILITIES.bash.knocksDown, true);
    assert.equal(COMBAT_ABILITIES.kick.knocksDown, false);
    assert.ok(COMBAT_ABILITIES.bash.damage.sides < COMBAT_ABILITIES.kick.damage.sides);
    assert.ok(COMBAT_ABILITIES.bash.selfLagRounds > COMBAT_ABILITIES.kick.selfLagRounds);
  });

  it('charges the source\'s own recovery, in rounds', () => {
    // `set_short_affected_by(ch, SKILL_BASH, 2 * PULSE_VIOLENCE)` and `(PULSE_VIOLENCE * 3) / 2`.
    assert.equal(COMBAT_ABILITIES.bash.selfLagRounds, 2);
    assert.equal(COMBAT_ABILITIES.kick.selfLagRounds, 1.5);
    // Only a bash takes the victim's round off them, which is what makes it the opener rather than the
    // damage: `CharWait(victim, PULSE_VIOLENCE)`.
    assert.equal(COMBAT_ABILITIES.bash.targetLagRounds, 1);
    assert.equal(COMBAT_ABILITIES.kick.targetLagRounds, 0);
  });
});

describe('landing one', () => {
  it('is the skill percentage, and nothing else while there are no ability scores', () => {
    // `chance_kick` returns the skill and then scales it by dexterity, which does not exist yet — dropped
    // and named as dropped rather than approximated with a guess.
    assert.equal(abilityChance(1), 1);
    assert.equal(abilityChance(40), 40, 'the free floor from level 27');
    assert.equal(abilityChance(95), 95);
  });

  it('clamps a value outside the scale rather than trusting it', () => {
    assert.equal(abilityChance(-5), 0);
    assert.equal(abilityChance(400), 100);
  });
});

describe('what one hits for', () => {
  it('converts the skill the same way the to-hit bonus does, rather than copying Duris\' scale', () => {
    // Duris' kick is skill-derived on a 1-100 scale, which at mastery would hit for 95 where a level-30
    // weapon swing does about 25. `floor(learned / 10)` is the established conversion — the identity below
    // is the point: one number, used in two places, so they cannot drift.
    for (const learned of [0, 1, 40, 72, 95]) {
      assert.equal(abilityDamage(COMBAT_ABILITIES.kick, learned).bonus, toHitFrom(learned), `at ${learned}`);
    }
  });

  it('leaves the base dice alone and only moves the bonus', () => {
    const novice = abilityDamage(COMBAT_ABILITIES.kick, 1);
    const master = abilityDamage(COMBAT_ABILITIES.kick, 95);
    assert.deepEqual([novice.count, novice.sides], [master.count, master.sides]);
    assert.equal(novice.bonus, 0, 'a level-1 kick is 1d6 and nothing more');
    assert.equal(master.bonus, 9, 'and a mastered one is 1d6+9, beside a weapon swing rather than past it');
  });

  it('never mutates the ability it was asked about', () => {
    // The table is module state shared by every fight in the process; a bonus added in place would grow
    // without limit and every kick in the world would get stronger.
    abilityDamage(COMBAT_ABILITIES.bash, 90);
    abilityDamage(COMBAT_ABILITIES.bash, 90);
    assert.equal(COMBAT_ABILITIES.bash.damage.bonus, 0);
  });
});
