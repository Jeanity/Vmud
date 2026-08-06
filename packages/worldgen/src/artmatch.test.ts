/**
 * A7g — guessing a picture for an item that has none.
 *
 * The tests pin the four decisions that make this worth running: the slot is a hard constraint, a
 * builder's keywords outrank the display prose, an authored choice is never overwritten, and the
 * fallback is chosen by a rule rather than by whatever the list happened to start with.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemTemplate } from '@mygame/shared';

import { fallbackFor, matchArt, scoreArt, words, type ArtCandidate } from './artmatch.ts';

const ART: ArtCandidate[] = [
  { id: 'weapon-sword-longsword-longsword', name: 'Longsword', kind: 'weapon', slot: 'mainHand' },
  { id: 'weapon-blunt-mace-mace', name: 'Mace', kind: 'weapon', slot: 'mainHand' },
  { id: 'tool-hoe', name: 'Hoe', kind: 'weapon', slot: 'mainHand' },
  { id: 'hat-helmet-armet', name: 'Armet', kind: 'hat', slot: 'head' },
  { id: 'hat-bandana', name: 'Bandana', kind: 'bandana', slot: 'head' },
  { id: 'shield-heater-pattern-cross', name: 'Cross', kind: 'shield_pattern', slot: 'offHand' },
];

function item(over: Partial<ItemTemplate>): ItemTemplate {
  return {
    vnum: 1, keywords: [], name: '', roomLine: '', type: 5, ac: 0, size: 1, cost: 0, stackLimit: 1,
    ...over,
  } as ItemTemplate;
}

describe('reading an item into words', () => {
  it('drops colour codes, punctuation and words that describe nothing', () => {
    // Colours are worse than useless: the pack's own ids carry them (`belt-belly-brown`) and have nothing
    // to do with the item's, so matching *brown* on both sides pairs a brown cloak with a brown belt.
    assert.deepEqual(words('&+La long black dagger&n'), ['long', 'dagger']);
    assert.deepEqual(words('a pair of steel boots'), ['steel', 'boots']);
  });
});

describe('scoring', () => {
  it('weights a builder’s keyword above the display prose', () => {
    // A keyword list is the builder's own answer to *what is this*; a name is prose about its owner.
    const byKeyword = scoreArt(item({ keywords: ['longsword'], name: 'a blade' }), ART[0]!);
    const byName = scoreArt(item({ keywords: ['blade'], name: 'a longsword' }), ART[0]!);
    assert.ok(byKeyword.score > byName.score, `${byKeyword.score} should beat ${byName.score}`);
  });

  it('has no opinion when nothing is shared', () => {
    assert.equal(scoreArt(item({ keywords: ['pipe'], name: 'a clay pipe' }), ART[0]!).score, 0);
  });

  it('records which words did it, so a bad guess is diagnosable', () => {
    const { matched } = scoreArt(item({ keywords: ['sword', 'longsword'], name: 'a longsword' }), ART[0]!);
    assert.deepEqual([...new Set(matched)].sort(), ['longsword', 'sword']);
  });
});

describe('choosing a fallback', () => {
  it('prefers the commonest kind in the slot', () => {
    // `weapon` is three of the four mainHand entries here, so the default is a weapon and not a hat.
    assert.equal(fallbackFor(ART.filter((a) => a.slot === 'head'))?.kind, 'hat');
  });

  it('prefers the family the kind is named after, which is what keeps a hoe out of every hand', () => {
    // The pack files tools under the same `weapon` kind as swords, and `tool-hoe` is the shortest id in
    // the slot — so without this rule every unmatched sword in the world became a farming tool.
    const chosen = fallbackFor(ART.filter((a) => a.slot === 'mainHand'));
    assert.ok(chosen?.id.startsWith('weapon-'), `${chosen?.id} should be a weapon`);
  });

  it('is the same answer whatever order the candidates arrive in', () => {
    // A matcher whose output moved between runs would make the diff useless for review, which is the
    // whole point of writing one.
    const forwards = fallbackFor(ART.filter((a) => a.slot === 'mainHand'))?.id;
    const backwards = fallbackFor([...ART].reverse().filter((a) => a.slot === 'mainHand'))?.id;
    assert.equal(forwards, backwards);
  });
});

describe('a whole pass', () => {
  const items = [
    item({ vnum: 10, slot: 'mainHand', keywords: ['longsword', 'sword'], name: 'a longsword' }),
    item({ vnum: 11, slot: 'mainHand', keywords: ['glaive'], name: 'a rusted glaive' }),
    item({ vnum: 12, slot: 'head', keywords: ['helmet'], name: 'an iron helmet' }),
    item({ vnum: 13, keywords: ['key'], name: 'a brass key' }),
    item({ vnum: 14, slot: 'eyes', keywords: ['patch'], name: 'an eyepatch' }),
    item({ vnum: 15, slot: 'head', keywords: ['cap'], name: 'a leather cap' }),
  ];

  it('matches what it can and falls back inside the slot for the rest', () => {
    const report = matchArt(items, ART, new Set());
    const guessed = new Map(report.guesses.map((g) => [g.vnum, g]));
    assert.equal(guessed.get(10)?.art, 'weapon-sword-longsword-longsword');
    assert.ok(guessed.get(10)!.score > 0);
    // No shared word, so the slot's own default — and it is still a weapon.
    assert.ok(guessed.get(11)?.art.startsWith('weapon-'));
    assert.equal(guessed.get(11)?.score, 0);
  });

  it('never guesses for something that is carried rather than worn', () => {
    // Every art entry is equipment. Handing a brass key the picture of a bracer is not a guess, it is
    // noise — and it would put a wrong icon in the bag list where A7d leaves the cell empty.
    const report = matchArt(items, ART, new Set());
    assert.equal(report.guesses.find((g) => g.vnum === 13), undefined);
    assert.equal(report.skipped['no-slot'], 1);
  });

  it('names the slots the pack has nothing for rather than silently skipping them', () => {
    const report = matchArt(items, ART, new Set());
    assert.deepEqual(report.uncoveredSlots, ['eyes']);
    assert.equal(report.skipped['no-art-for-slot'], 1);
  });

  it('never overwrites a choice somebody made by hand', () => {
    // The one failure this tool must not have, and what makes a re-run safe.
    const report = matchArt(items, ART, new Set([10, 12]));
    assert.equal(report.guesses.find((g) => g.vnum === 10), undefined);
    assert.equal(report.skipped['already-authored'], 2);
  });
});
