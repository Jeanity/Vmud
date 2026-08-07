/**
 * Weapon procs — the unpacking is the trap, so the unpacking is the test: `value[5]`'s decimal
 * thousands are transcribed digit for digit from `fight.c:7808-7826`, and getting a divisor wrong
 * produces plausible spell numbers that are simply the wrong spells.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { makeRng } from './rules.ts';
import { PROC_DEPTH_CAP, SPECIAL_PROCS, isSpecialProcId, rollProc, rollProcBlows, unpackWeaponSpells } from './procs.ts';

describe('the value[5] unpacking', () => {
  it('reads one, two and three packed spells from the decimal thousands', () => {
    assert.deepEqual(unpackWeaponSpells(111), { spells: [111], pickOne: false });
    assert.deepEqual(unpackWeaponSpells(16_057), { spells: [57, 16], pickOne: false });
    // The forge hammer family: three spells, low slot first — the source's own order.
    assert.deepEqual(unpackWeaponSpells(15_016_057), { spells: [57, 16, 15], pickOne: false });
  });

  it('drops empty slots exactly as the source drops them', () => {
    assert.deepEqual(unpackWeaponSpells(16_000), { spells: [16], pickOne: false });
    assert.deepEqual(unpackWeaponSpells(0).spells, []);
  });

  it('reads the tenth digit as the pick-one flag', () => {
    const packed = 1_015_016_057;
    const { spells, pickOne } = unpackWeaponSpells(packed);
    assert.deepEqual(spells, [57, 16, 15]);
    assert.equal(pickOne, true, 'above 999,999,999 the weapon casts one of the set at random');
  });
});

describe('the odds and the volley', () => {
  const rng = makeRng(0x9c0c);

  it('rolls the source idiom: one face of an N-sided die', () => {
    let fired = 0;
    for (let i = 0; i < 8000; i++) if (rollProc(rng, 8)) fired++;
    // 1-in-8 over 8000 rolls: ~1000, and the tolerance is wide because this is a distribution check.
    assert.ok(fired > 800 && fired < 1200, `1-in-8 fired ${fired}/8000`);
    assert.equal(rollProc(rng, 1), true, 'a 1-in-1 proc always fires');
  });

  it("windsong throws the owner's remembered 2-4 extra slashes", () => {
    assert.ok(isSpecialProcId('windsong'));
    const windsong = SPECIAL_PROCS.windsong;
    assert.equal(windsong.recurses, true, '"it could proc on a proc" — the owner\'s own rule');
    for (let i = 0; i < 200; i++) {
      const blows = rollProcBlows(rng, windsong);
      assert.ok(blows >= 2 && blows <= 4, `rolled ${blows}`);
    }
    assert.ok(PROC_DEPTH_CAP >= 2, 'recursion is allowed');
    assert.ok(PROC_DEPTH_CAP <= 16, 'and bounded — a sword that swings forever is a bug, not a legend');
  });
});
