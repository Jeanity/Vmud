/**
 * A7f — choosing a colour from a description.
 *
 * The tests pin the design rather than the wording: the **name is tried before the model**, the model's
 * answer is **validated against the closed list** rather than trusted, and a two-word ramp cannot beat
 * the plain one it contains.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildColourPrompt, rampFromName, readRampAnswer, suggestColour } from './artcolour.ts';

/** A realistic slice of `cloth_ulpc` plus two from `all_lpcr`, which is where the compound names live. */
const RAMPS = [
  'cloth_ulpc.brown',
  'cloth_ulpc.leather',
  'cloth_ulpc.red',
  'cloth_ulpc.blue',
  'cloth_ulpc.gray',
  'cloth_ulpc.black',
  'cloth_ulpc.white',
  'all_lpcr.blue_violet',
  'all_lpcr.red_orange',
];

describe('reading a colour out of the name', () => {
  it('takes the builder’s own word', () => {
    // The case that makes the whole feature cheap: the answer is very often already written down.
    assert.deepEqual(rampFromName('a hooded black cape', ['cape'], RAMPS), {
      ramp: 'cloth_ulpc.black',
      because: 'black',
    });
  });

  it('reads through colour codes', () => {
    assert.equal(rampFromName('&+La long black dagger&n', [], RAMPS)?.ramp, 'cloth_ulpc.black');
  });

  it('reads a keyword when the name is prose', () => {
    assert.equal(rampFromName('the cloak of the fallen', ['cloak', 'blue'], RAMPS)?.ramp, 'cloth_ulpc.blue');
  });

  it('maps the handful of words the world file actually uses', () => {
    // Deliberately small. A wrong synonym is worse than none: no match falls through to the model, which
    // can read the whole name, while a wrong synonym confidently ends the search.
    assert.equal(rampFromName('a flaming rapier', [], RAMPS)?.ramp, 'cloth_ulpc.red');
    assert.equal(rampFromName('a grey tunic', [], RAMPS)?.ramp, 'cloth_ulpc.gray');
  });

  it('resolves two colour words the same way every time', () => {
    // Ordered by the *ramp list*, not by the name — otherwise the answer depends on how the builder
    // happened to phrase it, and a re-run of a bulk pass would churn the overlay.
    const once = rampFromName('a black and red tabard', [], RAMPS);
    const again = rampFromName('a red and black tabard', [], RAMPS);
    assert.equal(once?.ramp, again?.ramp);
  });

  it('does not let a compound ramp steal a plain one', () => {
    // `blue_violet` contains *blue*. A cloak described only as blue must reach `blue`.
    assert.equal(rampFromName('a blue cloak', [], RAMPS)?.ramp, 'cloth_ulpc.blue');
    // And a name with both halves does reach the compound.
    assert.equal(rampFromName('a blue violet robe', [], RAMPS)?.ramp, 'all_lpcr.blue_violet');
  });

  it('never matches on the table, only on the colour', () => {
    // `cloth_ulpc.leather` answers to *leather*; nothing should answer to *cloth* or *ulpc*, or every
    // cloth item in the world would pair with whichever ramp sorted first.
    assert.equal(rampFromName('a cloth wrap', [], RAMPS), undefined);
    assert.equal(rampFromName('a leather jerkin', [], RAMPS)?.ramp, 'cloth_ulpc.leather');
  });

  it('says nothing about a name with no colour in it', () => {
    assert.equal(rampFromName('a curious device', ['device'], RAMPS), undefined);
  });
});

describe('the prompt', () => {
  it('offers the whole vocabulary and asks for one word', () => {
    const prompt = buildColourPrompt({ name: 'a curious device', keywords: ['device'] }, RAMPS);
    // Given the list, a model picks from it; asked for "a colour", it invents one.
    assert.match(prompt, /brown, leather, red, blue/);
    assert.match(prompt, /exactly one word/);
    // Without the table, which is bookkeeping the model cannot reason about.
    assert.equal(prompt.includes('cloth_ulpc'), false);
  });
});

describe('reading the model’s answer', () => {
  it('takes a bare word', () => {
    assert.equal(readRampAnswer('red', RAMPS), 'cloth_ulpc.red');
  });

  it('digs the choice out of a sentence, because models write sentences', () => {
    assert.equal(readRampAnswer('I would choose blue for this item.', RAMPS), 'cloth_ulpc.blue');
    assert.equal(readRampAnswer('**Black.**', RAMPS), 'cloth_ulpc.black');
  });

  it('refuses a word that is not on the list', () => {
    // The whole reason this is classification: inventing `cloth_ulpc.chartreuse` would only be refused
    // three layers away by `isKnownArt`, with nothing left to say why.
    assert.equal(readRampAnswer('chartreuse', RAMPS), undefined);
  });

  it('lets a near-miss through the same small synonym table the name uses', () => {
    assert.equal(readRampAnswer('crimson', RAMPS), 'cloth_ulpc.red');
  });
});

describe('the order the two are tried in', () => {
  it('never asks the model when the name already answers', () => {
    // The design decision, asserted rather than described: it is what makes the feature work with Ollama
    // switched off and what makes a hundred-item bulk pass a loop rather than a hundred round trips.
    let asked = 0;
    const suggestion = suggestColour({ name: 'a black cape', keywords: [] }, RAMPS, async () => {
      asked++;
      return 'blue';
    });
    return suggestion.then((result) => {
      assert.equal(asked, 0);
      assert.deepEqual(result, { ramp: 'cloth_ulpc.black', how: 'name', because: 'black' });
    });
  });

  it('asks the model when the name says nothing', async () => {
    const result = await suggestColour({ name: 'a curious device', keywords: [] }, RAMPS, async () => 'blue');
    assert.deepEqual(result, { ramp: 'cloth_ulpc.blue', how: 'model' });
  });

  it('answers nothing rather than guessing when there is no model to ask', async () => {
    assert.equal(await suggestColour({ name: 'a curious device', keywords: [] }, RAMPS), undefined);
  });

  it('answers nothing when the model says something off the list', async () => {
    assert.equal(
      await suggestColour({ name: 'a curious device', keywords: [] }, RAMPS, async () => 'chartreuse'),
      undefined,
    );
  });
});
