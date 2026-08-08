/**
 * Cutting a room's prose out of the mapper's raw capture.
 *
 * The bug these pin was player-visible for as long as unmatched zones have been loaded: the Unseelie
 * Court described five spiky faeries in its prose while five spiky faeries stood in the room, because
 * `Desc` is a transcript of a screen rather than a description of a place.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { proseFromCapture } from './zmud.ts';

/** The full four-part shape the MUD prints, as zMUD stored it — CRLF and all. */
const CAPTURE = [
  'A Once Fine Boulevard',
  '   Half-way from here to nowhere lies this lost city of the elves.',
  'Within the Faerie Realm, it was abandoned long ago, left to slow decay.',
  'Exits: - North - East  - South - West ',
  'A copper coin.',
  'An spiky faerie looks about with killing intent.',
].join('\r\n');

describe('prose out of a capture', () => {
  it('keeps the prose and drops the name, the exits line and everybody who was standing there', () => {
    assert.equal(
      proseFromCapture(CAPTURE, 'A Once Fine Boulevard'),
      '   Half-way from here to nowhere lies this lost city of the elves.\n' +
        'Within the Faerie Realm, it was abandoned long ago, left to slow decay.',
    );
  });

  it('gives a room captured as nothing but its own name no description at all', () => {
    // Hundreds of real rooms are exactly this, and they have been rendering their name twice.
    assert.equal(proseFromCapture('Cluttered Beach', 'Cluttered Beach'), undefined);
    assert.equal(proseFromCapture('Storm Haven Island\r\nExits: - North ', 'Storm Haven Island'), undefined);
  });

  it('trims a capture that has a name and prose but no exits line', () => {
    // 1,071 rooms are this shape — the mapper recorded the header and the prose and nothing after.
    assert.equal(
      proseFromCapture('A Stand of Ancient Trees\nThe oaks grow close here.', 'A Stand of Ancient Trees'),
      'The oaks grow close here.',
    );
  });

  it('leaves a description that was never a capture completely alone', () => {
    // The Duris half of the harvest is builder prose read out of a .wld file: no header, no exits.
    const wld = 'The thick trunks of oaks and birches grow close together here.\nThe ground is loamy.';
    assert.equal(proseFromCapture(wld, 'A Stand of Ancient Trees'), wld);
  });

  it('does not mistake prose that merely mentions the room name for the header', () => {
    // Only a line that is *nothing but* the name is the capture's header. This one is a sentence.
    const desc = 'A Once Fine Boulevard stretches away to the west, cracked and weedy.';
    assert.equal(proseFromCapture(desc, 'A Once Fine Boulevard'), desc);
  });

  it('matches the header case-insensitively, because the capture and the name column disagree', () => {
    assert.equal(proseFromCapture('THE CLUTTERED BEACH\nSand everywhere.', 'The Cluttered Beach'), 'Sand everywhere.');
  });

  it('cuts the tail before rescuing the header, so a creature line cannot stand in for prose', () => {
    // Ordering test: if the name line were dropped first and the tail second, a capture whose only
    // non-blank content after the header is a creature would keep the creature as its prose.
    assert.equal(
      proseFromCapture('A Dim Cell\r\nExits: -N\r\nA bored palace guard leans against the wall.', 'A Dim Cell'),
      undefined,
    );
  });

  it('has nothing to say about an absent or empty capture', () => {
    assert.equal(proseFromCapture(null, 'Anywhere'), undefined);
    assert.equal(proseFromCapture(undefined, 'Anywhere'), undefined);
    assert.equal(proseFromCapture('   \r\n  ', 'Anywhere'), undefined);
  });
});
