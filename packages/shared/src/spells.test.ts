/**
 * Phase 20 slice 3 — the registry, the two gates, and the nukes' own arithmetic.
 *
 * The traps are the tests: the ×5 on every save modifier, the inverted lower-is-better save scale,
 * chill touch's shipped precedence quirk, magic missile's per-bolt independence, and the shrug that
 * rolls for nobody without the innate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from './rules.ts';
import {
  MAGIC_RESISTANT_RACES,
  SPELLS,
  areaHitCount,
  scaleSpellDamage,
  defaultSaveMod,
  mobCastMs,
  rollEarthquake,
  rollSpellBlows,
  rollSpellBuff,
  rollSpellHeal,
  saveFailurePercent,
  shrugChance,
  spellByName,
  spellFromDurisNumber,
} from './spells.ts';

describe('the registry', () => {
  it('answers to whole names, never prefixes', () => {
    assert.equal(spellByName('magic missile')?.id, 'magic_missile');
    assert.equal(spellByName('MAGIC MISSILE')?.id, 'magic_missile');
    assert.equal(spellByName('magic'), undefined);
  });

  it("translates Duris' own spell numbers — including the one folk memory gets wrong", () => {
    // `spells.h`, read not remembered: shocking grasp is 37 here, where most Dikus put it at 48.
    assert.equal(spellFromDurisNumber(5)?.id, 'burning_hands');
    assert.equal(spellFromDurisNumber(8)?.id, 'chill_touch');
    assert.equal(spellFromDurisNumber(32)?.id, 'magic_missile');
    assert.equal(spellFromDurisNumber(37)?.id, 'shocking_grasp');
    assert.equal(spellFromDurisNumber(48), undefined, 'the other tradition\'s shocking grasp is nothing here');
    assert.equal(spellFromDurisNumber(-1), undefined, 'the empty-slot marker a scroll carries');
    // Slice 5's four: armor and bless from the single digits, the cures from where Duris put them.
    assert.equal(spellFromDurisNumber(1)?.id, 'armor');
    assert.equal(spellFromDurisNumber(3)?.id, 'bless');
    assert.equal(spellFromDurisNumber(16)?.id, 'cure_light');
    assert.equal(spellFromDurisNumber(57)?.id, 'cure_serious');
  });
});

describe('heals and buffs — slice 5, the handlers\' own numbers', () => {
  const rng = makeRng(0x5e11a);

  it('cure light restores 2..10 and cure serious 3..24, level-blind', () => {
    for (let i = 0; i < 200; i++) {
      const light = rollSpellHeal(rng, 'cure_light', 60);
      assert.ok(light >= 2 && light <= 10, `cure light rolled ${light}`);
      const serious = rollSpellHeal(rng, 'cure_serious', 1);
      assert.ok(serious >= 3 && serious <= 24, `cure serious rolled ${serious}`);
    }
  });

  it('a nuke heals nothing and a heal throws no blows — the kinds cannot cross', () => {
    assert.equal(rollSpellHeal(rng, 'magic_missile', 30), 0);
    assert.deepEqual(rollSpellBlows(rng, 'cure_light', 30), []);
  });

  it('armor is one ac node for 20 ticks, compressed through the armour law', () => {
    for (let i = 0; i < 100; i++) {
      const rolled = rollSpellBuff(rng, 'armor', 25);
      assert.ok(rolled);
      assert.equal(rolled.durationMs, 20 * 10_000, 'the torch calibration: a Duris tick is ten seconds');
      assert.equal(rolled.nodes.length, 1);
      assert.equal(rolled.nodes[0]!.apply, 'ac');
      // armourBonusFrom(25..35): sqrt puts it at 5, and the law's floor and cap bound it either way.
      assert.ok(rolled.nodes[0]!.modifier >= 1, 'armour that protects for nothing is not a spell');
    }
  });

  it('bless is two nodes of one cause: +hit, and a save mod that helps by being negative', () => {
    const rolled = rollSpellBuff(rng, 'bless', 25);
    assert.ok(rolled);
    assert.equal(rolled.durationMs, 12 * 10_000, 'max(5, 25/2) = 12 ticks');
    assert.deepEqual(rolled.nodes, [
      { apply: 'hit', modifier: 2 },
      { apply: 'saves', modifier: -1 },
    ]);
    // And the floor: a level-1 blessing still lasts its 5 ticks.
    assert.equal(rollSpellBuff(rng, 'bless', 1)?.durationMs, 5 * 10_000);
  });

  it('a nuke installs nothing', () => {
    assert.equal(rollSpellBuff(rng, 'chill_touch', 25), undefined);
  });
});

describe('areas — slice 6, the thinning that thins players only', () => {
  const rng = makeRng(0xa5ea);

  it('translates the two area numbers', () => {
    assert.equal(spellFromDurisNumber(23)?.id, 'earthquake');
    assert.equal(spellFromDurisNumber(111)?.id, 'ice_storm');
  });

  it('always strikes a lone player, and nobody in an empty room', () => {
    assert.equal(areaHitCount(rng, 0, 90), 0);
    for (let i = 0; i < 50; i++) assert.equal(areaHitCount(rng, 1, 90), 1, 'median 5.5, capped at the one present');
  });

  it("ice storm's 90% floor outranks the median roll in a crowd", () => {
    // Ten players: the median roll lands 4..6, and the min-chance floor of 9 wins every time —
    // which is the source's own tuning: the property default barely thins at all.
    for (let i = 0; i < 100; i++) assert.equal(areaHitCount(rng, 10, 90), 9);
    // With no floor, the median arithmetic shows itself: pc/2 + 5/pc ± 0.75 → 4..6 of ten.
    for (let i = 0; i < 100; i++) {
      const hit = areaHitCount(rng, 10, 0);
      assert.ok(hit >= 4 && hit <= 6, `rolled ${hit}`);
    }
  });

  it("earthquake's two rolls: felled dice(1,30)+level, grazed dice(1,4)+flag*(level/2)", () => {
    for (let i = 0; i < 100; i++) {
      const { felled, grazed } = rollEarthquake(rng, 20, 3);
      assert.ok(felled >= 21 && felled <= 50, `felled ${felled}`);
      assert.ok(grazed >= 31 && grazed <= 34, `grazed ${grazed} — the indoors flag triples the debris`);
    }
  });

  it("ice storm's per-victim roll caps its dice at 36", () => {
    for (let i = 0; i < 50; i++) {
      const [blow] = rollSpellBlows(rng, 'ice_storm', 60);
      assert.ok(blow && blow.damage >= 36 && blow.damage <= 288, `rolled ${blow?.damage}`);
    }
  });
});

describe('gate 1 — the saving throw', () => {
  it('is a failure percentage that falls with level between the two endpoints', () => {
    assert.equal(saveFailurePercent(0, 0, false), 70);
    assert.equal(saveFailurePercent(60, 0, false), 20);
    assert.ok(saveFailurePercent(30, 0, false) < 70 && saveFailurePercent(30, 0, false) > 20);
  });

  it('multiplies every modifier by five — the silent scale change, transcribed', () => {
    // A +3 mod at the call sites is worth 15 points of failure, not 3.
    assert.equal(saveFailurePercent(30, 3, false) - saveFailurePercent(30, 0, false), 15);
  });

  it('keeps a 1% surprise at both ends', () => {
    assert.equal(saveFailurePercent(60, -20, false), 1);
    assert.equal(saveFailurePercent(0, 20, false), 99);
  });

  it('gives an NPC defender the source’s level/3 bonus', () => {
    assert.ok(saveFailurePercent(30, 0, true) < saveFailurePercent(30, 0, false));
  });

  it('bounds the standard offensive mod at ±3 below circle 7', () => {
    assert.equal(defaultSaveMod(50, 1, 1), 3);
    assert.equal(defaultSaveMod(1, 50, 1), -3);
    assert.equal(defaultSaveMod(31, 30, 1), 0);
  });
});

describe('gate 2 — the shrug', () => {
  it('rolls for nobody without the innate — a raceless player never shrugs', () => {
    assert.equal(shrugChance(undefined, 50), 0);
    assert.equal(shrugChance('H', 50), 0);
  });

  it('floors an unauthored magic-resistant race at 5%, the source’s own default consequence', () => {
    for (const race of MAGIC_RESISTANT_RACES) {
      assert.equal(shrugChance(race, 50), 5, race);
    }
  });

  it('lets an authored base climb with level and caps at 100', () => {
    assert.ok(shrugChance('DR', 50, 60) > shrugChance('DR', 25, 60));
    assert.equal(shrugChance('DR', 60, 500), 100);
  });
});

describe('the nukes', () => {
  it('throws one to five missiles, each its own blow — bolts shrug separately', () => {
    const rng = makeRng(7);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 1).length, 1);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 9).length, 3);
    assert.equal(rollSpellBlows(rng, 'magic_missile', 30).length, 5);
  });

  it('keeps chill touch’s shipped precedence quirk: 1d6 + 20 + level, not a ×4 sibling', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20; i++) {
      const [blow] = rollSpellBlows(rng, 'chill_touch', 10);
      assert.ok(blow!.damage >= 31 && blow!.damage <= 36, String(blow!.damage));
    }
  });

  it('scales burning hands by the book: dice(level/10+5, 6) × 4', () => {
    const rng = makeRng(7);
    for (let i = 0; i < 20; i++) {
      const [blow] = rollSpellBlows(rng, 'burning_hands', 20);
      // 7d6×4: 28..168.
      assert.ok(blow!.damage >= 28 && blow!.damage <= 168, String(blow!.damage));
    }
  });
});

describe('the economy translation', () => {
  it('leaves a mob’s pool taking the transcribed number as written', () => {
    assert.equal(scaleSpellDamage(109, false), 109);
    assert.equal(scaleSpellDamage(1, false), 1);
  });

  it('quarters what lands on a player, floored, never below one', () => {
    // The autopsy’s own numbers: the 109 magic missile and the 120 burning hands become bruises
    // proportionate to an ~87-hp pool instead of erasing it.
    assert.equal(scaleSpellDamage(109, true), 27);
    assert.equal(scaleSpellDamage(120, true), 30);
    assert.equal(scaleSpellDamage(4, true), 1);
    assert.equal(scaleSpellDamage(3, true), 1, 'floored but never zero');
    assert.equal(scaleSpellDamage(1, true), 1);
  });

  it('composes after the save doubling, which is the delivery order', () => {
    // A doubled 50 against a player is 100 ÷ 4 = 25 — not (50 ÷ 4) × 2 = 24 off a floored half.
    assert.equal(scaleSpellDamage(50 * 2, true), 25);
  });
});

describe('the mob’s quick chant', () => {
  it('halves or keeps the wind-up by level, and never goes instant below 60', () => {
    const rng = makeRng(7);
    const spell = SPELLS.magic_missile;
    for (let i = 0; i < 50; i++) {
      const ms = mobCastMs(rng, spell, 23);
      assert.ok(ms === spell.castMs || ms === Math.max(1000, Math.round(spell.castMs / 2)), String(ms));
    }
    assert.equal(mobCastMs(rng, spell, 60), 0);
  });
});

describe('gate 2 — the player dialect, Phase 21', () => {
  it('rolls for the blooded player races by their defines.h codes', () => {
    for (const code of ['PL', 'PD', 'PE', 'P2']) {
      assert.equal(shrugChance(code, 50), 5, code);
    }
  });

  it('still rolls for nobody human', () => {
    assert.equal(shrugChance('PH', 50), 0);
    assert.equal(shrugChance('PB', 50), 0);
    assert.equal(shrugChance('PM', 50), 0); // a mountain dwarf resists nothing arcane
  });
});
