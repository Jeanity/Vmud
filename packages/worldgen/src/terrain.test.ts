/**
 * The name rules.
 *
 * Every case here is a room name that exists in the source data — the table was rebuilt against a
 * survey of the 10,773 rooms the old rules defaulted, and these are the shapes that survey found.
 * The point of pinning them individually is that the table is *ordered*, so a rule added in the
 * wrong place breaks a neighbour silently: the tests say which sentence each ordering decision is
 * for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inferSector } from './terrain.ts';

const sector = (room: string, zone = 'Zone With No Terrain Words') => inferSector(room, zone).sector;
const source = (room: string, zone = 'Zone With No Terrain Words') => inferSector(room, zone).source;

describe('word rules', () => {
  it('matches plurals, which the old table famously did not', () => {
    // "Lost in a Maze of Tunnels" was the single most defaulted name in the world — 546 rooms —
    // because \btunnel\b cannot match "Tunnels".
    assert.equal(sector('Lost in a Maze of Tunnels'), 'cave');
    assert.equal(sector('Atop the Walls'), 'city');
  });

  it('knows the vocabulary the survey found missing', () => {
    assert.equal(sector('Wandering through the Labyrinth'), 'cave');
    assert.equal(sector('The Calimport Sewers'), 'cave');
    assert.equal(sector('The Trade Way'), 'road');
    assert.equal(sector('The Moonsea Ride'), 'road');
    assert.equal(sector('The Bazaar'), 'city');
    assert.equal(sector('A Small Home'), 'inside');
    assert.equal(sector("A Storage Clerk's Office"), 'inside');
    assert.equal(sector('On Skull Pool (Water)'), 'shallow_water');
    assert.equal(sector('Deep In a Vast Sea'), 'deep_water');
    assert.equal(sector('A Deep Twisting Canyon'), 'mountain');
    assert.equal(sector('At the Bottom of a Steep Ravine'), 'mountain');
  });

  it('reads the mapper of Toril’s own annotations, but only as a last resort', () => {
    // The zMUD mapper marks hundreds of rooms "(Water)" and "(No Ground)". They are true but
    // generic, so a specific name must win first: the Stump Bog is a swamp that happens to be wet.
    assert.equal(sector('In A Vast, Gentle Sea (Water)'), 'deep_water');
    assert.equal(sector('Somewhere Wet (Water)'), 'shallow_water');
    assert.equal(sector('The Stump Bog (Water)'), 'swamp');
    assert.equal(sector('A Bottomless Pit (No Ground)'), 'air');
  });

  it('reads fortification names as interiors, except where a street word says otherwise', () => {
    // Measured against the Duris harvest: rooms named for a castle or keep are its interiors three
    // times out of four. The words moved from the city rule to a rule *after* it, so courtyards and
    // roads keep their own sector.
    assert.equal(sector('Within IceCrag Castle'), 'inside');
    assert.equal(sector('A Lonely Tower'), 'inside');
    assert.equal(sector('The Castle Courtyard'), 'city');
    assert.equal(sector('Castle Road'), 'road');
  });

  it('reads a bare passage as cave, but lets any landscape word claim it first', () => {
    // Connective names concentrate in dug and delved zones — Undermountain alone holds hundreds —
    // so the fallthrough is cave. The rule sits below every landscape word, so a passage that says
    // where it is keeps that answer.
    assert.equal(sector('A Bend in the Passage'), 'cave');
    assert.equal(sector('A T-intersection in the Passageway'), 'cave');
    assert.equal(sector('A Mountain Passage'), 'mountain');
  });

  it('still gives no rule at all to pure connective tissue', () => {
    // "A Dead End" says nothing about terrain, and any word we picked would be wrong half the time.
    // These rooms are the diffusion stage's job — absence of vocabulary here is an instruction.
    assert.equal(source('A Dead End'), 'default');
    assert.equal(source('The Outer Ring'), 'default');
    assert.equal(source('An unnamed place'), 'default');
  });
});

describe('suffix rules', () => {
  it('sees into the compounds the word tier cannot', () => {
    // "The regex finds no word boundary inside Nightwood" — the type case for the whole tier.
    assert.equal(sector('Within the Heart of the Nightwood'), 'forest');
    assert.equal(source('Within the Heart of the Nightwood'), 'room-suffix');
    assert.equal(sector('In the Wyllowwood'), 'forest');
    assert.equal(sector('On the Evermoor'), 'swamp');
    assert.equal(sector('Skullport Stables'), 'inside'); // word first: stables
    assert.equal(sector('Above Skullport'), 'city'); // then the compound
    assert.equal(sector('The Bank of Hulburg'), 'inside');
    assert.equal(sector('A Flower Bed in the Hulburg Park'), 'city');
    assert.equal(sector('Before the Iron Gates of Bartertown'), 'city');
    assert.equal(sector('Entrance to Silverglen'), 'forest');
    assert.equal(sector('The Darktree'), 'forest');
  });

  it('checks bridge before ridge, because every Zundbridge ends in both', () => {
    assert.equal(sector('Crossing the Zundbridge'), 'road');
    assert.equal(sector('Along the Windridge'), 'hills');
  });

  it('requires a real stem, so the bare word stays the word tier’s business', () => {
    // "the Port" is a word match; "Skullport" is a suffix match. A suffix with no stem would just be
    // a second, lower-priority copy of the word tier.
    assert.equal(source('The Port District'), 'room');
    assert.equal(source('Above Skullport'), 'room-suffix');
  });

  it('never classifies an office as arctic', () => {
    // The cautionary example from the survey: `-ice` looks like a suffix for glaciers until it
    // matches "Office" and "Apprentice". The table must not contain it, or anything like it.
    assert.equal(sector('An Office'), 'inside');
    assert.notEqual(sector("An Apprentice's Abode"), 'arctic');
    // And `-ton` is missing on purpose: place-names end in it, but so does "skeleton".
    assert.equal(source('The Skeleton'), 'default');
  });
});

describe('precedence', () => {
  it('lets the room’s own name beat the zone’s, whatever the tier', () => {
    // A room called "A Small Chamber" is an interior even in the Nightwood; the Nightwood is a
    // forest even when the zone name says nothing.
    assert.equal(sector('A Small Chamber', 'The Nightwood'), 'inside');
    assert.equal(inferSector('A Small Chamber', 'The Nightwood').source, 'room');

    assert.equal(sector('Deep within the Nightwood', 'The Haunted Halls'), 'forest');
    assert.equal(inferSector('Deep within the Nightwood', 'The Haunted Halls').source, 'room-suffix');
  });

  it('falls through room suffix to zone word to zone suffix, in that order', () => {
    assert.equal(inferSector('A Dead End', 'The Stag Forest').source, 'zone');
    assert.equal(inferSector('A Dead End', 'The Stag Forest').sector, 'forest');

    assert.equal(inferSector('A Dead End', 'The Nightwood').source, 'zone-suffix');
    assert.equal(inferSector('A Dead End', 'The Nightwood').sector, 'forest');

    assert.equal(inferSector('A Dead End', 'Grid-UD-Ixarkon').source, 'default');
  });

  it('defaults to field, which renders as open ground and reads as unclassified', () => {
    const guess = inferSector('Xyzzy', 'Plugh');
    assert.equal(guess.sector, 'field');
    assert.equal(guess.source, 'default');
    assert.equal(guess.matched, undefined);
  });

  it('keeps the evidence for every non-default guess, so a bad rule is traceable', () => {
    assert.ok(inferSector('The Trade Way', 'x').matched);
    assert.equal(inferSector('Above Skullport', 'x').matched, '-port');
  });
});
