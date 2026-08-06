/**
 * The item overlay: reading it off disk, folding it over a template, and the merge that makes a
 * revert honest. Everything runs against literals and a temporary directory — the real overlay file
 * must never be touched by a test, which is the same rule every store test here follows.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { ItemTemplate } from '@mygame/shared';

import {
  applyItemOverride,
  itemAuthorsAnything,
  loadItemOverrides,
  MAX_AUTHORED_LIGHT_RADIUS,
  mergeItemOverride,
  readAuthoredLight,
  readDice,
  saveItemOverrides,
  type ItemOverrides,
} from './item-overrides.ts';

const SWORD: ItemTemplate = {
  vnum: 500,
  keywords: ['sword', 'steel'],
  name: 'a steel sword',
  roomLine: 'A sword lies here.',
  type: 5,
  slot: 'mainHand',
  ac: 0,
  size: 2,
  cost: 100,
  stackLimit: 1,
  damage: { count: 2, sides: 5, bonus: 0 },
};

describe('folding an override over a template', () => {
  it('changes only what was authored', () => {
    const applied = applyItemOverride(SWORD, { name: 'the blade of testing', at: 'now' });
    assert.equal(applied.name, 'the blade of testing');
    assert.equal(applied.cost, SWORD.cost, 'the harvest still owns everything unauthored');
    assert.deepEqual(applied.damage, SWORD.damage);
    assert.equal(applied.vnum, SWORD.vnum, 'the join key is untouchable');
  });

  it('returns a new template rather than mutating the pristine one', () => {
    applyItemOverride(SWORD, { ac: 5, at: 'now' });
    assert.equal(SWORD.ac, 0, 'the pristine copy is what makes a revert possible');
  });
});

describe('the merge, and the revert it makes honest', () => {
  it('clears a field back out, and deletes the entry when nothing authored remains', () => {
    // The rule OVERRIDE_META set for rooms: an entry carrying only `at` is not an authored item, it
    // is the mark of one — and keeping it would show ✎ forever on a fully reverted item.
    const once = mergeItemOverride(undefined, { name: 'renamed' }, [], 't1');
    assert.ok(once && itemAuthorsAnything(once));
    const cleared = mergeItemOverride(once, {}, ['name'], 't2');
    assert.equal(cleared, undefined, 'nothing authored left means no entry at all');
  });

  it('keeps other authored fields through a single clear', () => {
    const both = mergeItemOverride(undefined, { name: 'renamed', cost: 9 }, [], 't1');
    const oneLeft = mergeItemOverride(both, {}, ['name'], 't2');
    assert.ok(oneLeft);
    assert.equal(oneLeft.cost, 9);
    assert.equal(oneLeft.name, undefined);
  });
});

describe('the file, hand-editable and therefore distrusted', () => {
  it('round-trips through disk, sorted by vnum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-itemov-'));
    const file = join(dir, 'items.json');
    const overrides: ItemOverrides = new Map([
      [900, { name: 'renamed', at: 't' }],
      [200, { cost: 5, at: 't' }],
    ]);
    saveItemOverrides(overrides, file);
    assert.ok(readFileSync(file, 'utf8').indexOf('"200"') < readFileSync(file, 'utf8').indexOf('"900"'),
      'sorted, so a diff shows the change rather than a reshuffle');
    const back = loadItemOverrides(file);
    assert.deepEqual(back.get(900), { name: 'renamed', at: 't' });
    assert.deepEqual(back.get(200), { cost: 5, at: 't' });
  });

  it('drops what it cannot believe rather than propagating it', () => {
    // "3d5" as a string is a hand-edit somebody will make. A template whose dice are NaN swings for
    // NaN, and the failure surfaces three systems away — so it is dropped here, at the door.
    const dir = mkdtempSync(join(tmpdir(), 'mygame-itemov-'));
    const file = join(dir, 'items.json');
    writeFileSync(file, JSON.stringify({
      '500': { damage: '3d5', ac: 'high', name: '  ', cost: -3, keywords: [] },
      '501': { name: 'a believable rename' },
      'not-a-vnum': { name: 'x' },
    }));
    const back = loadItemOverrides(file);
    assert.equal(back.get(500), undefined, 'every field failed validation, so nothing was authored');
    assert.equal(back.get(501)?.name, 'a believable rename');
    assert.equal(back.size, 1);
  });

  it('treats a missing file as nothing authored, which is the ordinary case', () => {
    assert.equal(loadItemOverrides(join(tmpdir(), 'mygame-none', 'missing.json')).size, 0);
  });
});

describe('readDice', () => {
  it('accepts a sane record and defaults the bonus', () => {
    assert.deepEqual(readDice({ count: 2, sides: 6 }), { count: 2, sides: 6, bonus: 0 });
  });
  it('refuses strings, halves, zeroes and the absurd', () => {
    for (const bad of ['2d6', { count: 0, sides: 6 }, { count: 2.5, sides: 6 }, { count: 2, sides: 6, bonus: 10_000 }, null]) {
      assert.equal(readDice(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('authoring a light — A6c', () => {
  it('clamps the radius to the shipped ladder rather than trusting a form', () => {
    // The radius is not a free number: `light.ts` gives every light the same reach on purpose, so what
    // separates a candle from a lantern is duration. A form that let somebody type 11 would be overriding
    // a tuned relationship, and the server is the gate rather than the form.
    assert.deepEqual(readAuthoredLight({ radius: 3 }), { radius: 3 });
    assert.deepEqual(readAuthoredLight({ radius: 99 }), { radius: MAX_AUTHORED_LIGHT_RADIUS });
    assert.deepEqual(readAuthoredLight({ radius: 0 }), { radius: 1 });
    assert.deepEqual(readAuthoredLight({ radius: 2.6 }), { radius: 3 }, 'rounded, not truncated');
  });

  it('reads an absent or non-positive burn as unlimited, which is a state', () => {
    // 32 of the harvested 64 never go out. A zero-duration light would gutter on the first tick, which
    // nobody wants to author, so it means "no clock" rather than "no light".
    assert.deepEqual(readAuthoredLight({ radius: 3 }), { radius: 3 });
    assert.deepEqual(readAuthoredLight({ radius: 3, durationMs: 0 }), { radius: 3 });
    assert.deepEqual(readAuthoredLight({ radius: 3, durationMs: -5 }), { radius: 3 });
    assert.deepEqual(readAuthoredLight({ radius: 3, durationMs: 960_000 }), { radius: 3, durationMs: 960_000 });
  });

  it('refuses anything that is not a light at all', () => {
    // These files are hand-editable, so every shape somebody might type has to resolve to nothing rather
    // than to a light with a NaN radius.
    assert.equal(readAuthoredLight(undefined), undefined);
    assert.equal(readAuthoredLight(null), undefined);
    assert.equal(readAuthoredLight({}), undefined);
    assert.equal(readAuthoredLight({ radius: 'bright' }), undefined);
    assert.equal(readAuthoredLight(3), undefined);
  });

  it('folds onto a template and can be cleared back to the harvest', () => {
    const template: ItemTemplate = { ...SWORD, light: { radius: 3, durationMs: 240_000 } };
    const lit = applyItemOverride(template, { light: { radius: 4 } });
    assert.deepEqual(lit.light, { radius: 4 }, 'authored wins, and its absent burn means unlimited');

    // Cleared, and the composition is always applied to the *pristine* template — so a clear restores the
    // harvest's own light rather than whatever the last edit left.
    const back = applyItemOverride(template, {});
    assert.deepEqual(back.light, { radius: 3, durationMs: 240_000 });
  });
});
