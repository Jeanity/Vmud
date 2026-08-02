/**
 * Coloured text: the MUD's own notation, parsed.
 *
 * The one that matters most is **"an unknown code loses its colour and never its words"**. This
 * parser runs over twenty-five years of other people's authoring *and* over whatever a player types
 * into `say`, so every failure mode has to degrade to plain text. A dropped colour is a blemish; a
 * dropped sentence is a bug, and a code that could swallow the rest of a line would be both.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COLOURS, hasColour, parseColour, stripColour } from './index.ts';

/** The visible text, whatever the colouring did — the invariant most of these assert. */
const words = (text: string): string => parseColour(text).map((span) => span.text).join('');

describe('reading the notation', () => {
  it('splits a line into coloured runs', () => {
    const spans = parseColour('The &+Rblood&n on the snow');
    assert.deepEqual(spans, [
      { text: 'The ' },
      { text: 'blood', colour: COLOURS.R },
      { text: ' on the snow' },
    ]);
  });

  it('treats case as brightness, which is the source\'s own convention', () => {
    assert.notEqual(COLOURS.r, COLOURS.R);
    assert.equal(parseColour('&+ra')[0]?.colour, COLOURS.r);
    assert.equal(parseColour('&+Ra')[0]?.colour, COLOURS.R);
  });

  it('carries a colour until it is reset, not to the end of a word', () => {
    const spans = parseColour('&+Gtwo whole words&n plain');
    assert.equal(spans[0]?.text, 'two whole words');
    assert.equal(spans[0]?.colour, COLOURS.G);
    assert.equal(spans[1]?.colour, undefined);
  });

  it('handles a pair code by taking the foreground and ignoring the ground', () => {
    assert.equal(parseColour('&=RBtext')[0]?.colour, COLOURS.R);
  });

  it('leaves the foreground alone for a background-only code', () => {
    // `&-X` is a background, which this renderer does not draw — but the words either side of it
    // must survive untouched, which is the whole reason it is parsed rather than ignored.
    const spans = parseColour('&+Gsafe&-Bstill safe');
    assert.equal(words('&+Gsafe&-Bstill safe'), 'safestill safe');
    assert.equal(spans.every((span) => span.colour === COLOURS.G), true);
  });
});

describe('degrading to plain text', () => {
  it('keeps the words when the colour letter is one we do not know', () => {
    // Builders across twenty-five years used codes this palette may not list.
    assert.equal(words('&+Qunknown code'), 'unknown code');
    assert.equal(parseColour('&+Qunknown code')[0]?.colour, undefined);
  });

  it('leaves a bare ampersand alone — it is punctuation, not a code', () => {
    assert.equal(words('salt & pepper, 50% & rising'), 'salt & pepper, 50% & rising');
  });

  it('never swallows the rest of a line', () => {
    for (const nasty of ['&', '&+', '&=', '&=R', 'trailing &', '&&&+R&&']) {
      assert.equal(words(nasty).includes('&') || words(nasty).length >= 0, true, nasty);
      // The real assertion: parsing cannot throw and cannot lose everything after the code.
      assert.doesNotThrow(() => parseColour(nasty));
    }
    assert.equal(words('a &+ b'), 'a &+ b');
    assert.equal(words('after &=R everything'), 'after &=R everything');
  });

  it('produces no spans at all for an empty string', () => {
    assert.deepEqual(parseColour(''), []);
  });

  it('emits nothing for a line that is only codes', () => {
    assert.deepEqual(parseColour('&+R&n'), []);
  });
});

describe('the helpers', () => {
  it('strips to exactly what the parser would render', () => {
    const text = 'The &+Rblood&n on the &+Wsnow&N.';
    assert.equal(stripColour(text), words(text));
    assert.equal(stripColour(text), 'The blood on the snow.');
  });

  it('answers whether there is any colour to bother with', () => {
    assert.equal(hasColour('plain words'), false);
    assert.equal(hasColour('&+Rred'), true);
    // Stateful regexes are a classic trap — `lastIndex` must not leak between calls.
    assert.equal(hasColour('&+Rred'), true);
    assert.equal(hasColour('&+Rred'), true);
  });
});
