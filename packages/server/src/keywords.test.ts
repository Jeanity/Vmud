/**
 * The authored keyword lists, and the five ways reading them naively goes wrong.
 *
 * Every case here is a hazard that was *measured* in the real data before this module was written —
 * the counts are in `keywords.ts`'s own doc — so a test failing means the guard for a known fault
 * has been removed, not that a hypothesis broke.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Item, ItemTemplate } from '@mygame/shared';

import { playerWords, wordsForItem, wordsForMob } from './keywords.ts';

function item(name: string, id = 'obj:63'): Item {
  return { id, name, ac: 0, size: 1 };
}

function template(keywords: readonly string[]): ItemTemplate {
  return { vnum: 63, keywords, name: 'x', roomLine: 'x', type: 5, ac: 0, size: 1, cost: 0, stackLimit: 1 };
}

describe('an authored list made fit for a player', () => {
  it('strips colour codes, which ten authored keywords carry', () => {
    // `book&n` is vnum 134032's own file. Without stripping, the canonical rule ships with the exact
    // failure it exists to fix: the item unreachable by the one word authored for it.
    assert.deepEqual(playerWords(['book&n', 'poison&n']), ['book', 'poison']);
    assert.deepEqual(playerWords(['&+wpeppermint']), ['peppermint']);
  });

  it('drops builder tokens, which are machinery rather than words', () => {
    assert.deepEqual(playerWords(['sword', '_binder_', 'steel']), ['sword', 'steel']);
  });

  it('survives a missing list rather than taking the server down', () => {
    // The loader blind-casts rows from a git-ignored, hand-editable file, and index.ts has no
    // try/catch anywhere: a throw here escapes the socket handler and kills the process for every
    // connected player. A missing list means no authored words, never a crash.
    assert.deepEqual(playerWords(undefined), []);
  });
});

describe('what an item answers to', () => {
  it('answers to the authored word the display name cannot yield — the bug itself', () => {
    const words = wordsForItem(
      item('&n&+La black two-handed sword&n'),
      template(['sword', 'two-handed', 'black']),
    );
    assert.ok(words.includes('two-handed'), 'the authored word');
    assert.ok(words.includes('sword'), 'and the ordinary ones still');
  });

  it('keeps every display-name word — union, not replacement', () => {
    // Measured: 6,121 of 16,421 items have a name word absent from their authored list. `pair` alone
    // is 565 of them, and `remove pair` works today on every one. Replacement would kill it silently.
    const words = wordsForItem(item('a pair of stiff work gloves'), template(['gloves', 'work']));
    assert.ok(words.includes('pair'), 'the name word the authored list lacks');
    assert.ok(words.includes('gloves'), 'and the authored words');
  });

  it('falls back to the name alone for the starter kit, which has no template', () => {
    assert.deepEqual(wordsForItem(item('a leather tunic', 'leather_tunic'), undefined), ['leather', 'tunic']);
  });

  it('deduplicates, so a word in both halves is one entry', () => {
    const words = wordsForItem(item('a steel shield'), template(['shield', 'steel']));
    assert.equal(words.filter((w) => w === 'shield').length, 1);
  });
});

describe('what a mob answers to', () => {
  it('unions the authored list with the name, because each alone loses mobs', () => {
    // Measured against the shipped spawn files: authored-only makes 129 templates unreachable by
    // their own head noun and leaves 8 answering to no visible word at all — "a bored soldier" is
    // authored only as `guard`. Name-only is the bug being fixed: `kill watch` failing on a sentry
    // guard authored `['sentry', 'guard', 'watch']`. The union loses neither.
    const words = wordsForMob('a bored soldier', ['guard']);
    assert.ok(words.includes('soldier'), 'the word on screen');
    assert.ok(words.includes('guard'), 'the word the builder wrote');
  });
});
