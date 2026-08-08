import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_WEAPON } from './combat.ts';
import { EQUIP_SLOTS, armourClassFrom, readEquipped, resolveWearSlot, rollStarterKit, weaponFrom } from './equipment.ts';
import type { Item } from './equipment.ts';
import { makeRng } from './rules.ts';

describe('the starter kit', () => {
  it('dresses a character rather than leaving them in one shoe', () => {
    const kit = rollStarterKit(makeRng(7));
    for (const slot of ['mainHand', 'chest', 'legs', 'feet', 'head', 'hands'] as const) {
      assert.ok(kit[slot], `${slot} is filled`);
    }
  });

  it('arms them — an unarmed level 1 would be the cookie-cutter problem in its worst form', () => {
    assert.ok(rollStarterKit(makeRng(3)).mainHand?.damage);
  });

  it('varies, which is the entire point of it', () => {
    // The owner's ask: some newbies get lucky and start sturdy, others are challenged by the
    // rabbits. A kit that rolled the same every time would be a longer way to write a constant.
    const totals = new Set<number>();
    const names = new Set<string>();
    for (let seed = 0; seed < 60; seed++) {
      const kit = rollStarterKit(makeRng(seed));
      totals.add(armourClassFrom(kit));
      names.add(kit.mainHand!.id);
    }
    assert.ok(totals.size >= 4, `armour totals vary (saw ${[...totals].sort((a, b) => a - b).join(',')})`);
    assert.ok(names.size >= 3, 'and so does what you are holding');
  });

  it('lands in a band that is a real gap without being a decisive one', () => {
    // Against the level 1-5 band's attack bonus of 0: AC 12 is hit ~45% of the time, AC 19 ~30%.
    for (let seed = 0; seed < 200; seed++) {
      const total = armourClassFrom(rollStarterKit(makeRng(seed)));
      assert.ok(total >= 1 && total <= 10, `total ${total} stays inside the intended band`);
    }
  });

  it('is reproducible from its seed, so nothing about it is Math.random', () => {
    assert.deepEqual(rollStarterKit(makeRng(42)), rollStarterKit(makeRng(42)));
  });
});

describe('what the kit is worth', () => {
  it('adds armour class the SRD way — higher is harder to hit', () => {
    // Duris' own scale runs the other way (Malice wears -122), which is what `armourToAc` converts.
    // Authored gear needs no conversion, and routing it through one is a sign error waiting to happen.
    assert.equal(armourClassFrom({ chest: { id: 'a', name: 'a', slot: 'chest', ac: 3, size: 1 } }), 3);
    assert.equal(armourClassFrom({}), 0);
  });

  it('swings the main hand, and falls back rather than leaving a character unable to fight', () => {
    const axe = { count: 1, sides: 5, bonus: 1 };
    assert.deepEqual(weaponFrom({ mainHand: { id: 'a', name: 'a', slot: 'mainHand', ac: 0, size: 1, damage: axe } }, DEFAULT_WEAPON), axe);
    assert.deepEqual(weaponFrom({}, DEFAULT_WEAPON), DEFAULT_WEAPON);
  });
});

describe('a ring goes on any finger', () => {
  const ring = { id: 'r1', name: 'a plain band' } as Item;

  it('lands on the named slot while it is free', () => {
    assert.equal(resolveWearSlot('ring1', {}), 'ring1');
  });

  it('takes the bare twin when the named finger is full — the owner’s first-free-slot rule', () => {
    assert.equal(resolveWearSlot('ring1', { ring1: ring }), 'ring2');
  });

  it('displaces only when both are full, and then the named one', () => {
    assert.equal(resolveWearSlot('ring1', { ring1: ring, ring2: ring }), 'ring1');
  });

  it('leaves unpaired slots exactly alone', () => {
    assert.equal(resolveWearSlot('chest', { chest: ring }), 'chest');
  });

  it('covers ears, wrists and neckwear — nobody authors an earring for the left ear specifically', () => {
    assert.equal(resolveWearSlot('ear1', { ear1: ring }), 'ear2');
    assert.equal(resolveWearSlot('wrist1', { wrist1: ring }), 'wrist2');
    assert.equal(resolveWearSlot('neck', { neck: ring }), 'neck2');
  });
});

describe('reading a stored kit', () => {
  it('round-trips what was written', () => {
    const kit = rollStarterKit(makeRng(11));
    assert.deepEqual(readEquipped(JSON.parse(JSON.stringify(kit))), kit);
  });

  it('drops malformed entries instead of admitting an item with no armour value', () => {
    // Same posture as `players.ts` and the overrides loader: an `ac` of undefined propagates as NaN
    // into the armour class and makes every later comparison false.
    const read = readEquipped({ chest: { id: 'x', name: 'x' }, feet: { id: 'y', name: 'y', ac: 1 } });
    assert.equal(read.chest, undefined);
    assert.equal(read.feet?.ac, 1);
  });

  it('survives nonsense on disk', () => {
    for (const nonsense of [null, 'a string', 42, []]) assert.deepEqual(readEquipped(nonsense), {});
  });

  it('never invents a slot the design does not have', () => {
    const read = readEquipped({ tail: { id: 'x', name: 'x', ac: 9 } });
    assert.deepEqual(Object.keys(read), []);
    assert.ok(!(EQUIP_SLOTS as readonly string[]).includes('tail'));
  });

  it('reads handedness back, or a dagger comes home main-hand-only', () => {
    // **The `stackLimit` lesson, one field over** — a persisted field with no line in this reader is
    // deleted at the next login, silently, and only for characters who had logged out. A dagger that
    // quietly lost its off-hand blessing overnight would be a bug nobody could reproduce.
    const saved = { offHand: { id: 'obj:1', name: 'a dagger', ac: 0, size: 1, handedness: 'either' } };
    assert.equal(readEquipped(saved).offHand?.handedness, 'either');
    // Absent stays absent — the main hand is the default and writing it would be noise in every save.
    assert.equal(readEquipped({ offHand: { id: 'obj:2', name: 'a club', ac: 0, size: 2 } }).offHand?.handedness, undefined);
    // And a hand-edited value that is not the one legal answer is refused rather than trusted.
    const bogus = { offHand: { id: 'obj:3', name: 'a club', ac: 0, size: 2, handedness: 'left' } };
    assert.equal(readEquipped(bogus).offHand?.handedness, undefined);
  });
});
