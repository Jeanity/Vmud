/**
 * The A7g quality sweep — re-choosing the per-slot fallbacks with a model.
 *
 * The tests pin the three contracts that make an unattended pass safe to run at all: only the
 * machine's own untouched fallbacks are ever re-decided, the model's answer is validated against the
 * closed candidate list rather than trusted, and a colour survives a sheet change only where the new
 * sheet can actually wear it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemTemplate } from '@mygame/shared';

import type { ArtCandidate } from './artmatch.ts';
import { buildArtPrompt, rampAcross, readArtAnswer, sweepSet } from './artpick.ts';

// Two sleeves and one armour in `arms`, so the fallback rule (commonest kind first) picks a sleeve —
// which is exactly the shape of the real finding this sweep exists for: "arm plates" wearing a shirt.
const ART: ArtCandidate[] = [
  { id: 'torso-clothes-longsleeves', name: 'Long-sleeved shirt', kind: 'clothes', slot: 'arms' },
  { id: 'torso-clothes-shortsleeves', name: 'Short-sleeved shirt', kind: 'clothes', slot: 'arms' },
  { id: 'arms-armour', name: 'Armour', kind: 'armour', slot: 'arms' },
  { id: 'cape-solid', name: 'Cape', kind: 'cape', slot: 'back' },
  { id: 'cape-solid-tattered', name: 'Tattered cape', kind: 'cape', slot: 'back' },
];

function item(over: Partial<ItemTemplate>): ItemTemplate {
  return {
    vnum: 1, keywords: [], name: '', roomLine: '', type: 5, ac: 0, size: 1, cost: 0, stackLimit: 1,
    ...over,
  } as ItemTemplate;
}

/** The real finding: exact-word matching shares nothing between "arm plates" and any arms candidate. */
const armPlates = item({ vnum: 100, name: 'arm plates', keywords: ['arm', 'plates'], slot: 'arms' });

describe('what is sweepable', () => {
  it('takes a machine fallback and carries everything the prompt needs', () => {
    const { targets, wordMatched } = sweepSet([armPlates], ART, {
      '100': { art: 'torso-clothes-longsleeves', by: 'artassign' },
    });
    assert.equal(targets.length, 1);
    assert.deepEqual(targets[0], {
      vnum: 100,
      name: 'arm plates',
      keywords: ['arm', 'plates'],
      slot: 'arms',
      currentArt: 'torso-clothes-longsleeves',
      fallbackId: 'torso-clothes-longsleeves',
    });
    assert.equal(wordMatched, 0);
  });

  it('leaves a word-matched guess alone — the sweep is for the fallbacks only', () => {
    const armour = item({ vnum: 101, name: 'some armour', keywords: ['armour'], slot: 'arms' });
    const report = sweepSet([armour], ART, { '101': { art: 'arms-armour', by: 'artassign' } });
    assert.equal(report.targets.length, 0);
    assert.equal(report.wordMatched, 1);
  });

  it('takes a colourassign record and keeps its ramp in currentArt', () => {
    const { targets } = sweepSet([armPlates], ART, {
      '100': { art: 'torso-clothes-longsleeves#cloth_ulpc.steel', by: 'colourassign' },
    });
    assert.equal(targets.length, 1);
    assert.equal(targets[0]!.currentArt, 'torso-clothes-longsleeves#cloth_ulpc.steel');
    assert.equal(targets[0]!.fallbackId, 'torso-clothes-longsleeves');
  });

  it('skips a record already swept, whichever way the sweep decided it', () => {
    // Changed: the swept art no longer equals the fallback — that alone must not re-open it.
    const changed = sweepSet([armPlates], ART, { '100': { art: 'arms-armour', by: 'artsweep' } });
    assert.equal(changed.targets.length, 0);
    assert.equal(changed.alreadySwept, 1);
    // Confirmed: the art still is the fallback, and the marker alone says it was looked at.
    const confirmed = sweepSet([armPlates], ART, { '100': { art: 'torso-clothes-longsleeves', by: 'artsweep' } });
    assert.equal(confirmed.targets.length, 0);
    assert.equal(confirmed.alreadySwept, 1);
  });

  it('guards art that is not the deterministic fallback — somebody changed it', () => {
    const report = sweepSet([armPlates], ART, { '100': { art: 'arms-armour', by: 'artassign' } });
    assert.equal(report.targets.length, 0);
    assert.equal(report.guarded, 1);
  });

  it('guards provenance that is not a machine marker', () => {
    for (const by of [undefined, 'panel', 'danny']) {
      const report = sweepSet([armPlates], ART, {
        '100': { art: 'torso-clothes-longsleeves', ...(by ? { by } : {}) },
      });
      assert.equal(report.targets.length, 0, `by=${by} must be guarded`);
      assert.equal(report.guarded, 1, `by=${by} must be counted`);
    }
  });

  it('leaves an un-guessed item un-guessed — Restore harvested means what it says', () => {
    const report = sweepSet([armPlates], ART, { '100': { name: 'arm plates of note' } });
    assert.equal(report.targets.length, 0);
    assert.equal(report.guarded, 0);
  });

  it('classifies under the overlay name an operator gave the item', () => {
    const { targets } = sweepSet([armPlates], ART, {
      '100': { art: 'torso-clothes-longsleeves', by: 'artassign', name: 'dented arm plates' },
    });
    assert.equal(targets[0]!.name, 'dented arm plates');
  });

  it('drops the target entirely when the overlay name now matches a word', () => {
    // Renamed to carry the word "armour": the recomputed match is no longer a fallback, so the record
    // is no longer the machine's no-opinion guess and the sweep has nothing to re-decide.
    const report = sweepSet([armPlates], ART, {
      '100': { art: 'torso-clothes-longsleeves', by: 'artassign', name: 'arm armour' },
    });
    assert.equal(report.targets.length, 0);
    assert.equal(report.wordMatched, 1);
  });
});

describe('the prompt', () => {
  it('carries the item, the slot and every candidate id, with colour codes stripped', () => {
    const prompt = buildArtPrompt(
      { name: '&+Larm plates&n', keywords: ['arm', 'plates'], slot: 'arms' },
      ART.filter((a) => a.slot === 'arms'),
    );
    assert.ok(prompt.includes('Item name: arm plates'));
    assert.ok(!prompt.includes('&+'));
    assert.ok(prompt.includes('Keywords: arm, plates'));
    assert.ok(prompt.includes('Worn on: arms'));
    for (const id of ['torso-clothes-longsleeves', 'torso-clothes-shortsleeves', 'arms-armour']) {
      assert.ok(prompt.includes(`- ${id}:`), `must list ${id}`);
    }
    assert.ok(prompt.includes('exactly one id'));
  });
});

describe('reading the answer', () => {
  const arms = ART.filter((a) => a.slot === 'arms');

  it('accepts the id bare, wrapped, or inside a sentence', () => {
    for (const answer of ['arms-armour', '`arms-armour`.', '"arms-armour"', 'I would choose arms-armour here']) {
      assert.equal(readArtAnswer(answer, arms), 'arms-armour', answer);
    }
  });

  it('the earliest id wins, so a preamble cannot beat the choice', () => {
    assert.equal(
      readArtAnswer('arms-armour, not torso-clothes-longsleeves', arms),
      'arms-armour',
    );
  });

  it('never misreads a longer id as the shorter one inside it', () => {
    const capes = ART.filter((a) => a.slot === 'back');
    assert.equal(readArtAnswer('cape-solid-tattered', capes), 'cape-solid-tattered');
    assert.equal(readArtAnswer('cape-solid', capes), 'cape-solid');
  });

  it('refuses an invented variant rather than trimming it to a listed id', () => {
    const capes = ART.filter((a) => a.id === 'cape-solid');
    assert.equal(readArtAnswer('cape-solid-fancy', capes), undefined);
  });

  it('refuses an answer that names nothing on the list', () => {
    assert.equal(readArtAnswer('a suit of plate armour', arms), undefined);
  });
});

describe('the ramp across a sheet change', () => {
  const plated = { name: 'silver-plated arm plates', keywords: ['arm', 'plates'] };

  it('keeps the old ramp when the new sheet lists it', () => {
    assert.equal(rampAcross('metal.steel', ['metal.steel', 'metal.silver'], plated), 'metal.steel');
  });

  it('re-derives from the name when the old ramp does not fit', () => {
    assert.equal(rampAcross('cloth_ulpc.steel', ['metal.silver', 'metal.gold'], plated), 'metal.silver');
  });

  it('drops the colour when the new sheet cannot wear one at all', () => {
    assert.equal(rampAcross('cloth_ulpc.steel', [], plated), undefined);
    assert.equal(rampAcross('cloth_ulpc.steel', undefined, plated), undefined);
  });

  it('never adds colour where there was none', () => {
    assert.equal(rampAcross(undefined, ['metal.silver'], plated), undefined);
  });
});
