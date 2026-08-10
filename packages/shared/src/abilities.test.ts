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
  SHIELDLESS_BASH_FLOOR,
  shieldBonus,
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
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 1), 1);
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 40), 40, 'the free floor from level 27');
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 95), 95);
  });

  it('clamps a value outside the scale rather than trusting it', () => {
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, -5), 0);
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 400), 100);
  });
});

describe('what one hits for', () => {
  it('converts the skill the same way the to-hit bonus does, rather than copying Duris\' scale', () => {
    // Duris' kick is skill-derived on a 1-100 scale, which at mastery would hit for 95 where a level-30
    // weapon swing does about 25. `floor(learned / 10)` is the established conversion — the identity below
    // is the point: one number, used in two places, so they cannot drift.
    for (const learned of [0, 1, 40, 72, 95]) {
      assert.equal(abilityDamage(COMBAT_ABILITIES.kick, learned)[0]!.bonus, toHitFrom(learned), `at ${learned}`);
    }
  });

  it('leaves the base dice alone and only moves the bonus', () => {
    const novice = abilityDamage(COMBAT_ABILITIES.kick, 1)[0]!;
    const master = abilityDamage(COMBAT_ABILITIES.kick, 95)[0]!;
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

describe('the shield a bash is thrown with', () => {
  const bash = COMBAT_ABILITIES.bash;
  const kite = { size: 3, name: 'a battered kite shield' };

  it('is a fifth as likely to land bare-armed, which is the ask answered', () => {
    // The owner asked five times for bash to *refuse* without a shield. `actoff.c:6286` does not
    // refuse - it multiplies the chance by `MAX(20, SKILL_SHIELDLESS_BASH) / 100`, and that skill is
    // epic (`epic_skills.c:172`), zeroed on every ordinary character (`skills.c:4748`). So for every
    // character this game can make the multiplier is pinned at the floor, permanently.
    assert.equal(abilityChance(bash, 100), 20);
    assert.equal(abilityChance(bash, 40), 8, 'the free floor from level 27, quartered and then some');
    assert.equal(SHIELDLESS_BASH_FLOOR, 20);
  });

  it('adds the shield bulk to the chance when there is one', () => {
    // `percent_chance += weight / 1.8`, with weight rebuilt from the midpoint of the size bucket.
    assert.equal(abilityChance(bash, 40, kite), 40 + shieldBonus(3));
    assert.ok(abilityChance(bash, 40, kite) > abilityChance(bash, 40), 'carrying one is always better');
  });

  it('tracks the source curve, including the church door the author measured', () => {
    // The comment at `actoff.c:6281` is "Heaviest shield in game atm is church door at 30 lbs ->
    // 16.67 % increase." A 30lb shield is size 6, whose midpoint is 28 - so we land near, not on it,
    // and the docblock says by how much.
    assert.ok(Math.abs(shieldBonus(6) - 30 / 1.8) < 1.5, `size 6 gives ${shieldBonus(6)}`);
    assert.ok(shieldBonus(1) < shieldBonus(10), 'heavier is always worth more');
  });

  it('still clamps, so a heavy shield cannot buy a certainty', () => {
    assert.equal(abilityChance(bash, 95, { size: 10, name: 'a tower shield' }), 100);
  });

  it('leaves kick alone, because chance_kick reads no equipment', () => {
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 40), 40);
    assert.equal(abilityChance(COMBAT_ABILITIES.kick, 40, kite), 40, 'a shield does not help you kick');
  });

  it('adds a rolled term and a flat one to the damage, and only with a shield', () => {
    assert.equal(abilityDamage(bash, 40).length, 1, 'bare-armed is the one die it always was');
    const armed = abilityDamage(bash, 40, kite);
    assert.equal(armed.length, 2, 'number(0, 4) cannot live inside a single Dice');
    // `number(0, 4)` is 1d5-1: minimum 0, maximum 4.
    assert.deepEqual({ count: armed[1]!.count, sides: armed[1]!.sides, bonus: armed[1]!.bonus }, { count: 1, sides: 5, bonus: -1 });
    assert.ok(armed[0]!.bonus > abilityDamage(bash, 40)[0]!.bonus, 'the flat half is weight / 2');
  });

  it('doubles for a spiked shield, by the substring test the source uses', () => {
    // `if (strstr(ch->equipment[WEAR_SHIELD]->name, "spiked")) dmg *= 2` - 19 shields in our
    // catalogue answer it, so this is real content rather than a curiosity.
    const plain = abilityDamage(bash, 40, { size: 3, name: 'a battered kite shield' });
    const spiked = abilityDamage(bash, 40, { size: 3, name: 'a spiked bone shield' });
    assert.equal(spiked[0]!.bonus, plain[0]!.bonus * 2);
    assert.equal(spiked[1]!.count, 2, 'the rolled half doubles with the rest');
    assert.equal(spiked[1]!.bonus, -2);
  });

  it('reads the name the world actually authored, colour codes and all', () => {
    // Catalogue names carry Duris colour codes: "&+La &+rbloody&+L spiked shield". A test that
    // matched only a clean name would pass here and fail on nearly every real shield.
    const real = abilityDamage(bash, 40, { size: 4, name: '&+La &+rbloody&+L spiked shield' });
    const plain = abilityDamage(bash, 40, { size: 4, name: '&+La &+rbloody&+L shield' });
    assert.equal(real[0]!.bonus, plain[0]!.bonus * 2);
  });
});
