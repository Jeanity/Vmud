import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, type Room, type Zone } from '@mygame/shared';

import {
  DURIS_SECTOR,
  MIN_MARGIN,
  MIN_OVERLAP,
  buildNameIndex,
  enrichZone,
  flagsFrom,
  matchZone,
  newHarvestStats,
  normaliseName,
  parseWld,
  stripColour,
  type DurisRoom,
} from './duris.ts';

/** A `.wld` record, assembled so the tests read as the file format rather than as string soup. */
function wldRecord(options: {
  vnum: number;
  name: string;
  description?: string;
  flags?: number;
  sector?: number;
  exits?: string;
}): string {
  return [
    `#${options.vnum}`,
    `${options.name}~`,
    options.description ?? 'A description.',
    '~',
    `37 ${options.flags ?? 0} ${options.sector ?? 3}`,
    options.exits ?? '',
    'S',
  ].join('\n');
}

function makeZone(rooms: readonly Partial<Room>[], id = 900): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: id,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'field',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
    ...(r.flags ? { flags: r.flags } : {}),
    ...(r.description ? { description: r.description } : {}),
  })) as Room[];
  return { id, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

describe('parseWld', () => {
  it('reads vnum, name, description, flags and sector', () => {
    const rooms = parseWld(
      wldRecord({ vnum: 3700, name: 'Gravel Path', description: 'A gravely path.', flags: 8, sector: 2 }),
      'ako.wld',
    );
    assert.equal(rooms.length, 1);
    assert.deepEqual(
      { ...rooms[0] },
      {
        vnum: 3700,
        file: 'ako.wld',
        name: 'Gravel Path',
        key: 'gravel path',
        description: 'A gravely path.',
        flags: 8,
        sector: 2,
      },
    );
  });

  it('reads several records from one file, exit blocks and all', () => {
    const text = [
      wldRecord({ vnum: 1, name: 'First', exits: 'D1\n~\n~\n0 -1 2' }),
      wldRecord({ vnum: 2, name: 'Second', exits: 'D3\n~\n~\n0 0 1' }),
    ].join('\n');
    const rooms = parseWld(text, 'x.wld');
    assert.deepEqual(rooms.map((r) => r.vnum), [1, 2]);
    assert.deepEqual(rooms.map((r) => r.name), ['First', 'Second']);
  });

  it('unwraps the terminal hard-wrapping but keeps paragraph breaks', () => {
    // Diku prose is wrapped at ~78 columns for a terminal we are not using. Left alone the browser
    // wraps it a second time and the result reads as ragged nonsense at any panel width.
    const text = wldRecord({
      vnum: 5,
      name: 'A Room',
      description: '  The path here runs through a small patch\nof trees.  The heads of several\ncaribou lie here.\n\nA second paragraph.',
    });
    const room = parseWld(text, 'x.wld')[0]!;
    assert.equal(
      room.description,
      'The path here runs through a small patch of trees.  The heads of several caribou lie here.\n\nA second paragraph.',
    );
  });

  it('skips a record whose numeric line is malformed rather than importing NaN', () => {
    // A NaN sector would silently render as the fallback tile everywhere it landed.
    const text = ['#9', 'Broken~', 'desc', '~', 'not numbers here', 'S'].join('\n');
    assert.deepEqual(parseWld(text, 'x.wld'), []);
  });

  it('ignores anything that is not a record header', () => {
    assert.deepEqual(parseWld('$~\n\n', 'x.wld'), []);
    assert.deepEqual(parseWld('', 'x.wld'), []);
  });
});

describe('colour codes and the join key', () => {
  it('strips every code shape Duris uses', () => {
    assert.equal(stripColour('&+LDark&n Corridor'), 'Dark Corridor');
    assert.equal(stripColour('&-RRed back&n'), 'Red back');
    assert.equal(stripColour('&=LRBoth&N'), 'Both');
  });

  it('normalises to a join key, because a name with codes in it cannot match', () => {
    assert.equal(normaliseName("&+LGrumbiter's Inn&n"), 'grumbiter s inn');
    assert.equal(normaliseName('  The   Ice-Garden!  '), 'the ice garden');
    assert.equal(normaliseName('&+L&n'), '');
  });
});

describe('flagsFrom', () => {
  it('maps the bits Duris actually supplies', () => {
    // BIT_n is 1 << (n-1); an off-by-one here imports the wrong flag and every value still looks
    // plausible, which is why these are spelled out.
    assert.deepEqual(flagsFrom(1 << 0), ['dark']);
    assert.deepEqual(flagsFrom(1 << 2), ['no_mob']);
    assert.deepEqual(flagsFrom(1 << 3), ['indoors']);
    assert.deepEqual(flagsFrom(1 << 6), ['no_recall']);
    assert.deepEqual(flagsFrom(1 << 7), ['no_magic']);
  });

  it('treats an inn as the sanctuary, which is the design rule', () => {
    // "The only safe rooms should be inns." ROOM_SAFE is set on 11 rooms in all 781k of Duris and
    // none in a matched zone, so ROOM_INN is the only source of sanctuary there is.
    assert.deepEqual(flagsFrom(1 << 19), ['safe']);
    assert.deepEqual(flagsFrom(1 << 11), ['safe'], 'an explicit ROOM_SAFE still counts');
    assert.deepEqual(flagsFrom((1 << 19) | (1 << 11)), ['safe'], 'and not twice');
  });

  it('never invents the three flags Duris has no word for', () => {
    // peaceful, death_trap: no ROOM_PEACE or ROOM_DEATH exists upstream. If a bit ever starts
    // producing one of these, the bit table has drifted.
    const everyBit = flagsFrom(0xffffffff);
    assert.ok(!everyBit.includes('peaceful'));
    assert.ok(!everyBit.includes('death_trap'));
  });

  it('reports nothing for an empty bitfield, and is order-stable', () => {
    assert.deepEqual(flagsFrom(0), []);
    assert.deepEqual(flagsFrom((1 << 3) | (1 << 0)), ['dark', 'indoors'], 'table order, not bit order');
  });
});

describe('DURIS_SECTOR', () => {
  it('maps every sector Duris defines', () => {
    for (let s = 0; s <= 24; s++) {
      assert.ok(DURIS_SECTOR[s], `Duris sector ${s} has no mapping`);
    }
  });

  it('keeps the underworld city and interior recognisable rather than flattening all of it to cave', () => {
    assert.equal(DURIS_SECTOR[13], 'cave', 'underworld wilderness');
    assert.equal(DURIS_SECTOR[14], 'city', 'underworld city');
    assert.equal(DURIS_SECTOR[15], 'inside', 'underworld interior');
  });
});

describe('matchZone', () => {
  const index = buildNameIndex(
    new Map<string, DurisRoom[]>([
      ['right.wld', [
        { vnum: 1, file: 'right.wld', name: 'Alpha', key: 'alpha', description: '', flags: 0, sector: 3 },
        { vnum: 2, file: 'right.wld', name: 'Beta', key: 'beta', description: '', flags: 0, sector: 3 },
        { vnum: 3, file: 'right.wld', name: 'Gamma', key: 'gamma', description: '', flags: 0, sector: 3 },
      ]],
      ['wrong.wld', [
        { vnum: 9, file: 'wrong.wld', name: 'Alpha', key: 'alpha', description: '', flags: 0, sector: 3 },
      ]],
    ]),
  );

  it('picks the file that shares most of the zone, with a margin', () => {
    const zone = makeZone([{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }]);
    const match = matchZone(zone, index);
    assert.equal(match?.file, 'right.wld');
    assert.equal(match?.overlap, 1);
    assert.equal(match?.margin, 3);
  });

  it('refuses a match that does not cover enough of the zone', () => {
    // One shared name out of ten is coincidence. `Alpha` is in both files, so the margin is 1 too.
    const zone = makeZone(Array.from({ length: 10 }, (_, i) => ({ name: i === 0 ? 'Alpha' : `Unique ${i}` })));
    assert.ok(0.1 < MIN_OVERLAP);
    assert.equal(matchZone(zone, index), undefined);
  });

  it('refuses a match it cannot tell apart from the runner-up', () => {
    // The case overlap alone cannot catch: a zone of generic names matching two files equally well.
    const zone = makeZone([{ name: 'Alpha' }]);
    const match = matchZone(zone, index);
    assert.ok(MIN_MARGIN > 1);
    assert.equal(match, undefined, '100% overlap but a 1x margin is not evidence');
  });

  it('counts a file once per room however many times it holds the name', () => {
    // Otherwise a wilderness file with a thousand identically-named rooms outvotes every real match.
    const repeated = buildNameIndex(
      new Map<string, DurisRoom[]>([
        ['flood.wld', Array.from({ length: 500 }, (_, i) => ({
          vnum: i, file: 'flood.wld', name: 'Alpha', key: 'alpha', description: '', flags: 0, sector: 3,
        }))],
        ['real.wld', [
          { vnum: 1, file: 'real.wld', name: 'Alpha', key: 'alpha', description: '', flags: 0, sector: 3 },
          { vnum: 2, file: 'real.wld', name: 'Beta', key: 'beta', description: '', flags: 0, sector: 3 },
          { vnum: 3, file: 'real.wld', name: 'Gamma', key: 'gamma', description: '', flags: 0, sector: 3 },
        ]],
      ]),
    );
    const zone = makeZone([{ name: 'Alpha' }, { name: 'Beta' }, { name: 'Gamma' }]);
    assert.equal(matchZone(zone, repeated)?.file, 'real.wld');
  });

  it('answers nothing for a zone with no overlap or no rooms', () => {
    assert.equal(matchZone(makeZone([{ name: 'Nowhere' }]), index), undefined);
    assert.equal(matchZone(makeZone([]), index), undefined);
  });
});

describe('enrichZone', () => {
  const duris = (over: Partial<DurisRoom>): DurisRoom => ({
    vnum: 1, file: 'x.wld', name: 'A Room', key: 'a room', description: '', flags: 0, sector: 3, ...over,
  });

  it('replaces the guessed sector with the real one, and says so', () => {
    const zone = makeZone([{ name: 'A Room', sector: 'field' }]);
    const stats = newHarvestStats();
    const out = enrichZone(zone, [duris({ sector: 5 })], stats);
    assert.equal(out.rooms[0]!.sector, 'mountain');
    assert.equal(stats.sectorsReplaced, 1);
    assert.equal(stats.joined, 1);
  });

  it('leaves rooms Duris does not know entirely alone', () => {
    const zone = makeZone([{ name: 'Unknown Place', sector: 'field' }]);
    const stats = newHarvestStats();
    const out = enrichZone(zone, [duris({})], stats);
    assert.deepEqual(out.rooms[0], zone.rooms[0]);
    assert.equal(stats.joined, 0);
  });

  it('keeps the guess when same-named rooms disagree about the sector', () => {
    // A disagreement means the name is generic ("A Dark Tunnel"), and a coin flip between two real
    // answers is worse than the guess we already had.
    const zone = makeZone([{ name: 'A Room', sector: 'field' }]);
    const stats = newHarvestStats();
    const out = enrichZone(zone, [duris({ sector: 5 }), duris({ vnum: 2, sector: 1 })], stats);
    assert.equal(out.rooms[0]!.sector, 'field');
    assert.equal(stats.sectorConflicts, 1);
    assert.equal(stats.sectorsReplaced, 0);
  });

  it('keeps a sector Duris has no word for rather than taking its generic fallback', () => {
    // Duris has no road/swamp/arctic sector, so its builders reached for `field`. That is not a
    // finding that the room is a field — it is the absence of a better word.
    const stats = newHarvestStats();
    const kept = enrichZone(makeZone([{ name: 'A Room', sector: 'swamp' }]), [duris({ sector: 2 })], stats);
    assert.equal(kept.rooms[0]!.sector, 'swamp');
    assert.equal(stats.sectorsKeptBlindSpot, 1);

    // But a *specific* Duris answer still wins over our blind-spot guess.
    const replaced = enrichZone(makeZone([{ name: 'A Room', sector: 'road' }]), [duris({ sector: 5 })], newHarvestStats());
    assert.equal(replaced.rooms[0]!.sector, 'mountain');
  });

  it('takes the longest description and skips builder stubs', () => {
    const stats = newHarvestStats();
    const out = enrichZone(
      makeZone([{ name: 'A Room' }]),
      [duris({ description: 'Short.' }), duris({ vnum: 2, description: 'A properly written room description here.' })],
      stats,
    );
    assert.equal(out.rooms[0]!.description, 'A properly written room description here.');
    assert.equal(stats.descriptions, 1);

    const stub = newHarvestStats();
    const none = enrichZone(makeZone([{ name: 'A Room' }]), [duris({ description: 'TODO' })], stub);
    assert.equal(none.rooms[0]!.description, undefined);
    assert.equal(stub.descriptions, 0);
  });

  it('applies only the flags every candidate agrees on', () => {
    // Conservative in the direction that matters: wrongly marking a room `safe` or `no_magic` changes
    // what the player is allowed to do there.
    const stats = newHarvestStats();
    const out = enrichZone(
      makeZone([{ name: 'A Room' }]),
      [duris({ flags: (1 << 0) | (1 << 3) }), duris({ vnum: 2, flags: 1 << 3 })],
      stats,
    );
    assert.deepEqual(out.rooms[0]!.flags, ['indoors'], 'dark was not unanimous');
    assert.equal(stats.flagged, 1);
    assert.equal(stats.flagCounts['indoors'], 1);
  });

  it('counts a harvested inn as the sanctuary', () => {
    const stats = newHarvestStats();
    const out = enrichZone(makeZone([{ name: 'A Room' }]), [duris({ flags: 1 << 19 })], stats);
    assert.deepEqual(out.rooms[0]!.flags, ['safe']);
    assert.equal(stats.safeRooms, 1);
  });

  it('does not mutate the zone it was given', () => {
    const zone = makeZone([{ name: 'A Room', sector: 'field' }]);
    const before = JSON.stringify(zone);
    enrichZone(zone, [duris({ sector: 5, flags: 1 << 0, description: 'A real description of a place.' })], newHarvestStats());
    assert.equal(JSON.stringify(zone), before);
  });
});
