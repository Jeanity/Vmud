/**
 * Skills — Phase 19's arithmetic, which is all of it that can be tested without a fight.
 *
 * The rules worth pinning are the ones that would be silently wrong: the floor's cap, the mapping's two
 * `undefined` cases, the curve's asymptote, and the conversion of a percentage into a d20 bonus — that
 * last one because it is *derived* from the source's `>> 1`, so a change to it is a change to a
 * measurement rather than a preference.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from './rules.ts';
import {
  ceilingFor,
  isSkillId,
  learnedAt,
  mobWeaponSkill,
  notchChance,
  rollNotch,
  SKILL_CEILING,
  SKILL_IDS,
  SKILLS,
  skillFloor,
  toHitFrom,
  WEAPON_NOTCH_CHANCE,
  weaponSkillFor,
} from './skills.ts';

describe('the catalogue', () => {
  it('has a row for every id and an id for every row', () => {
    // The `AFFECT_TYPE_IDS` discipline: the list is the type and the table is the data, so a row added
    // to one and not the other is a type error rather than a silent gap.
    for (const id of SKILL_IDS) assert.equal(SKILLS[id]?.id, id, id);
    assert.equal(Object.keys(SKILLS).length, SKILL_IDS.length);
  });

  it('names them the way the source does, because that is what a player should read', () => {
    assert.equal(SKILLS['slashing-1h'].name, '1h slashing');
    assert.equal(SKILLS['reach'].name, 'reach weapons');
  });

  it('gates unknown ids, which is the load path\'s only defence', () => {
    assert.equal(isSkillId('slashing-1h'), true);
    // A hand-edited save, or a skill a later build removed.
    assert.equal(isSkillId('longsword'), false);
    assert.equal(isSkillId('__proto__'), false, 'and not through the prototype either');
  });
});

describe('which skill a weapon trains', () => {
  it('takes the damage class, one- or two-handed', () => {
    assert.equal(weaponSkillFor({ weaponClass: 5 }), 'slashing-1h', 'a longsword');
    assert.equal(weaponSkillFor({ weaponClass: 5, twoHanded: true }), 'slashing-2h');
    assert.equal(weaponSkillFor({ weaponClass: 2 }), 'piercing-1h', 'a dagger');
    assert.equal(weaponSkillFor({ weaponClass: 4 }), 'bludgeon-1h', 'a hammer');
    assert.equal(weaponSkillFor({ weaponClass: 14 }), 'flaying-1h', 'a whip');
  });

  it('folds the two classes the source says should be removed', () => {
    // 7 spiked mace and 11 spiked club are marked "should be removed" in `objmisc.h`; the mapping
    // already treats them as their unspiked kin, which is the source tidying its own history.
    assert.equal(weaponSkillFor({ weaponClass: 7 }), weaponSkillFor({ weaponClass: 6 }));
    assert.equal(weaponSkillFor({ weaponClass: 11 }), weaponSkillFor({ weaponClass: 10 }));
  });

  it('sends a two-handed spear, trident or polearm to reach weapons', () => {
    // The only skill that exists *only* in the two-handed form — there is no `SKILL_2H_PIERCING`.
    assert.equal(weaponSkillFor({ weaponClass: 15, twoHanded: true }), 'reach');
    assert.equal(weaponSkillFor({ weaponClass: 18, twoHanded: true }), 'reach');
    assert.equal(weaponSkillFor({ weaponClass: 8, twoHanded: true }), 'reach');
    assert.equal(weaponSkillFor({ weaponClass: 8 }), 'slashing-1h', 'and one-handed it is a slash');
  });

  it('trains unarmed with no weapon at all', () => {
    // `!wpn → SKILL_UNARMED_DAMAGE`. Bare hands are a skill, not a gap.
    assert.equal(weaponSkillFor(undefined), 'unarmed');
  });

  it('trains nothing for the two cases the source refuses', () => {
    // A weapon with no class — 6 of the 2,841 — and a two-handed dagger, which
    // `required_weapon_skill` refuses after logging a builder error. There is one in the world.
    assert.equal(weaponSkillFor({}), undefined);
    assert.equal(weaponSkillFor({ weaponClass: 2, twoHanded: true }), undefined);
    assert.equal(weaponSkillFor({ weaponClass: 99 }), undefined, 'and an id no class table has');
  });
});

describe('the floor and the ceiling', () => {
  it('is `MIN(40, 3 * level / 2)` and caps at level 27', () => {
    assert.equal(skillFloor(1), 1);
    assert.equal(skillFloor(10), 15);
    assert.equal(skillFloor(26), 39);
    assert.equal(skillFloor(27), 40);
    assert.equal(skillFloor(60), 40, 'and never climbs again');
  });

  it('makes a fresh high-level character competent for free', () => {
    // The half of `update_skills` that matters: the floor drags the learned value, so nothing has to
    // be ground before a level-30 character can fight.
    assert.equal(learnedAt(undefined, 30, 'slashing-1h'), 40);
    assert.equal(learnedAt(undefined, 1, 'slashing-1h'), 1);
  });

  it('keeps what was ground above the floor, and never exceeds the ceiling', () => {
    assert.equal(learnedAt(72, 30, 'slashing-1h'), 72);
    assert.equal(learnedAt(20, 30, 'slashing-1h'), 40, 'the floor wins when it is higher');
    assert.equal(learnedAt(999, 30, 'slashing-1h'), SKILL_CEILING, 'a hand-edited save cannot exceed it');
  });

  it('holds the ceiling below 100, which is what leaves room for a teacher', () => {
    assert.equal(ceilingFor('slashing-1h'), 95);
    assert.ok(SKILL_CEILING < 100);
  });
});

describe('notching', () => {
  it('is impossible at the ceiling', () => {
    assert.equal(notchChance(WEAPON_NOTCH_CHANCE, SKILL_CEILING, SKILL_CEILING, { onCooldown: false }), 0);
  });

  it('slows as the ceiling is approached, so the last points cost the most', () => {
    const at = (learned: number) =>
      notchChance(WEAPON_NOTCH_CHANCE, learned, SKILL_CEILING, { onCooldown: false });
    assert.ok(at(0) > at(40));
    assert.ok(at(40) > at(90));
    // The asymptote, as arithmetic: at 90 of 95 the chance is a twentieth of what it was at zero.
    assert.ok(at(90) / at(0) < 0.06);
  });

  it('divides by four on cooldown rather than refusing', () => {
    // The source's own later wording: *"Instead of simply not allowing notches, we just make it
    // harder."* A player who keeps fighting is slowed, not stopped.
    const free = notchChance(20, 40, SKILL_CEILING, { onCooldown: false });
    const held = notchChance(20, 40, SKILL_CEILING, { onCooldown: true });
    assert.equal(held, free / 4);
    assert.ok(held > 0);
  });

  it('rolls through the seeded rng, so a fight replays identically', () => {
    // The whole point of `CLAUDE.md` §3, asserted: same seed, same sequence of outcomes.
    const run = () => {
      const rng = makeRng(4242);
      return Array.from({ length: 40 }, () => rollNotch(rng, 25));
    };
    assert.deepEqual(run(), run());
    assert.equal(rollNotch(makeRng(1), 0), false, 'and a zero chance never fires');
  });

  it('resolves a percentage to two decimals, which is what 33.33 needs', () => {
    // `number(1, 10000) > chance * 100` — the source's scale, and the reason `33.33 / 5` is not
    // silently floored to 6%.
    const rng = makeRng(7);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) if (rollNotch(rng, WEAPON_NOTCH_CHANCE)) hits++;
    const rate = (hits / 20_000) * 100;
    assert.ok(Math.abs(rate - WEAPON_NOTCH_CHANCE) < 0.6, `observed ${rate.toFixed(2)}%`);
  });
});

describe('what a skill is worth', () => {
  it('converts the source\'s half-a-percentage into a d20 bonus by division', () => {
    // `getChartoHitSkillMod` is `skill >> 1` against a 1-100 roll; ours is a d20, so the same
    // proportion is `learned / 10`. Nothing here is a preference.
    assert.equal(toHitFrom(0), 0);
    assert.equal(toHitFrom(40), 4, 'the free floor at level 27+');
    assert.equal(toHitFrom(95), 9, 'and a master');
  });

  it('leaves the level bands 14b calibrated alone at the bottom', () => {
    // Below level 6 the floor is under 10, so an unpractised character gets +0 or +1 and the
    // six-to-eight-round target for that band is untouched.
    assert.equal(toHitFrom(learnedAt(undefined, 1, 'slashing-1h')), 0);
    assert.equal(toHitFrom(learnedAt(undefined, 5, 'slashing-1h')), 0);
    assert.equal(toHitFrom(learnedAt(undefined, 7, 'slashing-1h')), 1);
  });

  it('spreads a novice and a master of the same level by at most five', () => {
    const level = 30;
    const free = toHitFrom(learnedAt(undefined, level, 'slashing-1h'));
    const mastered = toHitFrom(learnedAt(SKILL_CEILING, level, 'slashing-1h'));
    assert.equal(free, 4);
    assert.equal(mastered - free, 5);
  });

  it('gives a mob level x 1.75, capped, and stores nothing', () => {
    // Not `level << 1` — that is the compiled-out branch. A level-30 mob is 52%, not 60%.
    assert.equal(mobWeaponSkill(30), 52);
    assert.equal(mobWeaponSkill(1), 1);
    assert.equal(mobWeaponSkill(60), 100, 'capped');
    assert.equal(mobWeaponSkill(0), 1, 'and a level-0 record is treated as level 1');
  });
});
