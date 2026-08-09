/**
 * Phase 22 — the authored world's contract, held as tests. The design's own completion line is
 * *"fails validation as loudly as a harvested zone does"*, so most of what is tested here is the
 * refusals: every rule a hand-written file can break must name the file, the room and the law,
 * because the alternative surfaces three systems later as a door into nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, type Room, type Zone } from '@mygame/shared';

import { mergeAuthoredZones, validateAuthoredZone } from './authored.ts';

/** A minimal valid zone document, spread-and-override per test. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 100001,
    name: 'Testquay',
    entryRoom: 100001000,
    rooms: [
      {
        id: 100001000,
        zone: 100001,
        name: 'A Courtyard',
        sector: 'city',
        pos: { x: 0, y: 0, z: 0 },
        exits: { north: { to: 100001001 } },
      },
      {
        id: 100001001,
        zone: 100001,
        name: 'A Colonnade',
        sector: 'city',
        pos: { x: 0, y: -1, z: 0 },
        exits: { south: { to: 100001000 } },
      },
    ],
    ...overrides,
  };
}

/** One harvested zone to merge against, shaped like worldgen's own output. */
function harvestZone(rooms: Partial<Room>[]): Zone {
  const built = rooms.map(
    (room, index) =>
      ({
        id: 41260 + index,
        zone: 168,
        name: `A Field ${index}`,
        sector: 'field',
        pos: { x: index, y: 0, z: 0 },
        exits: {},
        ...room,
      }) as Room,
  );
  return { id: 168, name: 'Kobold Settlement', rooms: built, bounds: boundsOf(built), entryRoom: built[0]!.id };
}

describe('validateAuthoredZone', () => {
  it('accepts the well-formed courtyard and computes its bounds', () => {
    const zone = validateAuthoredZone(doc(), '100001.json');
    assert.equal(zone.id, 100001);
    assert.equal(zone.rooms.length, 2);
    assert.deepEqual(zone.bounds, { minX: 0, minY: -1, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 });
  });

  const refusals: [string, Record<string, unknown>, RegExp][] = [
    ['a zone id below the authored band', { id: 999 }, /zone id must be an integer >= 100000/],
    ['an empty name', { name: '  ' }, /name must be a non-empty string/],
    ['no rooms', { rooms: [] }, /non-empty array/],
    ['an entry room the zone does not hold', { entryRoom: 100001999 }, /entryRoom/],
  ];
  for (const [what, override, message] of refusals) {
    it(`refuses ${what}`, () => {
      assert.throws(() => validateAuthoredZone(doc(override), '100001.json'), message);
    });
  }

  it('refuses a room id outside zone x 1000 + n', () => {
    const bad = doc();
    (bad.rooms as Record<string, unknown>[])[0]!.id = 100002000;
    (bad.rooms as Record<string, unknown>[])[1]!.exits = { south: { to: 100002000 } };
    assert.throws(() => validateAuthoredZone(bad, '100001.json'), /zone × 1000 \+ n/);
  });

  it('refuses a sector or flag the catalogues do not hold — the hand-written typo law', () => {
    const sector = doc();
    (sector.rooms as Record<string, unknown>[])[0]!.sector = 'citty';
    assert.throws(() => validateAuthoredZone(sector, '100001.json'), /SECTORS catalogue/);
    const flag = doc();
    (flag.rooms as Record<string, unknown>[])[0]!.flags = ['peacful'];
    assert.throws(() => validateAuthoredZone(flag, '100001.json'), /ROOM_FLAGS catalogue/);
  });

  it('refuses two rooms in one cell', () => {
    const bad = doc();
    (bad.rooms as Record<string, unknown>[])[1]!.pos = { x: 0, y: 0, z: 0 };
    assert.throws(() => validateAuthoredZone(bad, '100001.json'), /shares cell/);
  });

  it('refuses an in-zone exit that is neither the geometric neighbour nor an honest portal', () => {
    const bad = doc();
    (bad.rooms as Record<string, unknown>[])[1]!.pos = { x: 3, y: 3, z: 0 };
    assert.throws(() => validateAuthoredZone(bad, '100001.json'), /not the geometric neighbour/);
  });

  it('refuses a door you cannot come back through', () => {
    const bad = doc();
    (bad.rooms as Record<string, unknown>[])[1]!.exits = {};
    assert.throws(() => validateAuthoredZone(bad, '100001.json'), /no return exit/);
  });
});

describe('mergeAuthoredZones — the cross-source edge, checked when both worlds are in hand', () => {
  const withGate = (exit: Record<string, unknown>): Zone => {
    const gate = doc();
    (gate.rooms as Record<string, unknown>[])[0]!.exits = {
      north: { to: 100001001 },
      east: exit,
    };
    return validateAuthoredZone(gate, '100001.json');
  };

  it('stitches the edge: the return half is injected into the harvested room as a portal', () => {
    const harvest = harvestZone([{ id: 41260 }]);
    const { zones, report } = mergeAuthoredZones([harvest], [withGate({ to: 41260, portal: true })]);
    assert.equal(report.crossSource, 1);
    const stitched = zones.find((z) => z.id === 168)!.rooms.find((r) => r.id === 41260)!;
    assert.deepEqual(stitched.exits.west, { to: 100001000, portal: true });
    // The original harvested zone object is rebuilt, not mutated.
    assert.equal(harvest.rooms.find((r) => r.id === 41260)!.exits.west, undefined);
  });

  it('refuses an edge into a room no source holds', () => {
    assert.throws(
      () => mergeAuthoredZones([harvestZone([{ id: 41260 }])], [withGate({ to: 99999, portal: true })]),
      /lands in no harvested or authored room/,
    );
  });

  it('refuses a cross-source edge not declared a portal', () => {
    assert.throws(
      () => mergeAuthoredZones([harvestZone([{ id: 41260 }])], [withGate({ to: 41260 })]),
      /must be a portal/,
    );
  });

  it('never overwrites a harvested exit with the injected return half', () => {
    const occupied = harvestZone([{ id: 41260, exits: { west: { to: 41261 } } }, { id: 41261 }]);
    assert.throws(
      () => mergeAuthoredZones([occupied], [withGate({ to: 41260, portal: true })]),
      /never overwrites a harvested exit/,
    );
  });

  it('refuses two authored edges that both need the same harvested doorway', () => {
    const gate = doc();
    (gate.rooms as Record<string, unknown>[])[0]!.exits = {
      north: { to: 100001001 },
      east: { to: 41260, portal: true },
    };
    (gate.rooms as Record<string, unknown>[])[1]!.exits = {
      south: { to: 100001000 },
      east: { to: 41260, portal: true },
    };
    assert.throws(
      () => mergeAuthoredZones([harvestZone([{ id: 41260 }])], [validateAuthoredZone(gate, '100001.json')]),
      /both need/,
    );
  });
});
