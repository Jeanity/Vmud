/**
 * A8d — zones made here, and the three rules that make an unattended overlay safe: the counter is
 * stored and only ever raised, records below the base are dropped rather than honoured, and a config
 * that names a missing authored zone refuses loudly instead of booting a world with a hole in it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AUTHORED_ZONE_BASE, type ZoneId } from '@mygame/shared';

import { AUTHORED_ROOM_BASE, type Room, type RoomId } from '@mygame/shared';

import {
  composeAuthoredRooms,
  draftAuthoredRoom,
  loadAuthoredRooms,
  saveAuthoredRooms,
  type AuthoredRoom,
  type AuthoredRoomStore,
} from './room-authoring.ts';
import { GameWorld, authoredZoneShell } from './world.ts';
import {
  loadAuthoredZones,
  readZoneName,
  saveAuthoredZones,
  takeAuthoredZoneId,
  type AuthoredZoneStore,
} from './zone-authoring.ts';

const tempFile = () => join(mkdtempSync(join(tmpdir(), 'mygame-zones-')), 'zones-authored.json');

describe('the name rule', () => {
  it('trims, refuses the empty and the overlong', () => {
    assert.equal(readZoneName('  The Sunken Stair  '), 'The Sunken Stair');
    assert.equal(readZoneName(''), undefined);
    assert.equal(readZoneName('   '), undefined);
    assert.equal(readZoneName(42), undefined);
    assert.equal(readZoneName('x'.repeat(61)), undefined);
  });
});

describe('the store', () => {
  it('starts empty at the base when there is no file', () => {
    const store = loadAuthoredZones(join(mkdtempSync(join(tmpdir(), 'mygame-zones-')), 'missing.json'));
    assert.equal(store.zones.size, 0);
    assert.equal(store.next, AUTHORED_ZONE_BASE);
  });

  it('round-trips, ids ascending', () => {
    const file = tempFile();
    const store: AuthoredZoneStore = { zones: new Map(), next: AUTHORED_ZONE_BASE as ZoneId };
    const first = takeAuthoredZoneId(store);
    store.zones.set(first, { name: 'The Sunken Stair', at: '2026-08-07T00:00:00Z', by: 'test' });
    saveAuthoredZones(store, file);

    const back = loadAuthoredZones(file);
    assert.equal(back.zones.get(first)?.name, 'The Sunken Stair');
    assert.equal(back.next, first + 1);
  });

  it('drops a record below the base rather than letting it shadow a harvested zone', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ next: AUTHORED_ZONE_BASE, zones: { 168: { name: 'An Impostor Settlement' } } }));
    const store = loadAuthoredZones(file);
    assert.equal(store.zones.size, 0);
  });

  it('raises a lagging counter past what the file actually holds', () => {
    // A hand-edited `next` behind a real record would hand out an id already in use — the one
    // direction an allocator may not be wrong in.
    const file = tempFile();
    const id = AUTHORED_ZONE_BASE + 7;
    writeFileSync(file, JSON.stringify({ next: AUTHORED_ZONE_BASE, zones: { [id]: { name: 'A Held Number' } } }));
    const store = loadAuthoredZones(file);
    assert.equal(store.next, id + 1);
    assert.equal(takeAuthoredZoneId(store), id + 1);
  });

  it('honours a stored counter that is ahead, so a deleted zone never lends out its number', () => {
    const file = tempFile();
    writeFileSync(file, JSON.stringify({ next: AUTHORED_ZONE_BASE + 40, zones: {} }));
    assert.equal(loadAuthoredZones(file).next, AUTHORED_ZONE_BASE + 40);
  });
});

describe('booting from the overlay', () => {
  it('builds a shell the composer can fill', () => {
    const store: AuthoredZoneStore = {
      zones: new Map([[AUTHORED_ZONE_BASE as ZoneId, { name: 'The Sunken Stair' }]]),
      next: (AUTHORED_ZONE_BASE + 1) as ZoneId,
    };
    const shell = authoredZoneShell(AUTHORED_ZONE_BASE as ZoneId, store);
    assert.equal(shell.id, AUTHORED_ZONE_BASE);
    assert.equal(shell.name, 'The Sunken Stair');
    assert.equal(shell.rooms.length, 0);
  });

  it('refuses loudly when the config names an authored zone the overlay does not hold', () => {
    const store: AuthoredZoneStore = { zones: new Map(), next: AUTHORED_ZONE_BASE as ZoneId };
    assert.throws(
      () => authoredZoneShell((AUTHORED_ZONE_BASE + 3) as ZoneId, store),
      /world\.config\.json names zone 100003/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The origin exception — the one rule A8 could not express                    */
/* -------------------------------------------------------------------------- */

const ZONE = AUTHORED_ZONE_BASE as ZoneId;

function authoredRoom(id: number, x: number, y: number, zone: number = ZONE): [RoomId, AuthoredRoom] {
  const room: Room = {
    id: id as RoomId, zone: zone as ZoneId, name: `Room ${id}`, sector: 'inside',
    pos: { x, y, z: 0 }, exits: {},
  };
  return [id as RoomId, { room }];
}

describe('the origin exception', () => {
  it('places the first room of an authored zone bare, and holds the composer’s own rules after it', () => {
    // The join-a-neighbour rule is the *API's* (`draftAuthoredRoom` — a POSTed room must name a real
    // neighbour); the composer deliberately tolerates a hand-written island, because one bad record
    // must not cost the rest of the overlay. What the composer itself enforces — and what the origin
    // exception must not loosen — is the grid gate this test starts from and the occupied-cell rule
    // it ends on.
    const shell = authoredZoneShell(ZONE, {
      zones: new Map([[ZONE, { name: 'The Sunken Stair' }]]),
      next: (ZONE + 1) as ZoneId,
    });
    const rooms = new Map([
      authoredRoom(AUTHORED_ROOM_BASE, 0, 0), // the origin — lowest id, placed with nothing to join
      authoredRoom(AUTHORED_ROOM_BASE + 1, 1, 0), // beside it, on a free cell
      authoredRoom(AUTHORED_ROOM_BASE + 2, 0, 0), // contending for the origin's cell: refused
    ]);
    const { added, refused } = composeAuthoredRooms(shell, rooms);
    assert.deepEqual(added.map((room) => room.id), [AUTHORED_ROOM_BASE, AUTHORED_ROOM_BASE + 1]);
    assert.equal(refused.length, 1);
    assert.equal(refused[0]!.id, AUTHORED_ROOM_BASE + 2);
    assert.match(refused[0]!.why, /already holds room/);
  });

  it('keeps refusing an empty zone below the base — a harvested file with no rooms is a fault, not an origin', () => {
    const hollow = { id: 168 as ZoneId, name: 'A Hollowed Harvest', rooms: [], bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 } };
    const rooms = new Map([authoredRoom(AUTHORED_ROOM_BASE, 0, 0, 168)]);
    const { added, refused } = composeAuthoredRooms(hollow, rooms);
    assert.equal(added.length, 0);
    assert.equal(refused.length, 1);
  });

  it('holds the exit rule at both doors, and loosens it only for the origin', () => {
    // The ordinary door: exit-less refused, for infill's own reason.
    const bare = draftAuthoredRoom(AUTHORED_ROOM_BASE as RoomId, {
      zone: ZONE, name: 'A Flooded Landing', sector: 'inside', x: 0, y: 0, level: 0, exits: [],
    });
    assert.ok('error' in bare && /at least one exit/.test(bare.error));
    // The origin allowance: the same draft, stated as what it is.
    const origin = draftAuthoredRoom(
      AUTHORED_ROOM_BASE as RoomId,
      { zone: ZONE, name: 'A Flooded Landing', sector: 'inside', x: 0, y: 0, level: 0, exits: [] },
      { allowNoExits: true },
    );
    assert.ok(!('error' in origin));
  });

  it('round-trips the origin room through the file — where the first version died', () => {
    // The drive found this: the route hand-built the record, the file held it, and the loader —
    // running the real drafting rules — dropped an exit-less room on the next boot. The zone booted
    // with 0 rooms and nothing said why. Through the drafting door, with the allowance, it survives.
    const drafted = draftAuthoredRoom(
      AUTHORED_ROOM_BASE as RoomId,
      { zone: ZONE, name: 'A Flooded Landing', sector: 'inside', x: 0, y: 0, level: 0, exits: [] },
      { allowNoExits: true },
    );
    assert.ok(!('error' in drafted));
    const file = join(mkdtempSync(join(tmpdir(), 'mygame-zones-')), 'rooms-authored.json');
    const store: AuthoredRoomStore = {
      rooms: new Map([[AUTHORED_ROOM_BASE as RoomId, { room: drafted.room }]]),
      next: AUTHORED_ROOM_BASE + 1,
      deleted: new Set(),
      extents: new Map(),
    };
    saveAuthoredRooms(store, file);
    const back = loadAuthoredRooms(file);
    const room = back.rooms.get(AUTHORED_ROOM_BASE as RoomId)?.room;
    assert.ok(room, 'the origin room survives the file');
    assert.equal(room.zone, ZONE);
    assert.deepEqual(room.pos, { x: 0, y: 0, z: 0 });
    // And an exit-less record in a *harvested* zone still drops — the allowance is the origin's only.
    const stray = { ...drafted.room, zone: 168 as ZoneId };
    saveAuthoredRooms({ ...store, rooms: new Map([[stray.id, { room: stray }]]) }, file);
    assert.equal(loadAuthoredRooms(file).rooms.size, 0);
  });

  it('boots a one-room authored zone into one Place a body can stand in', () => {
    const shell = authoredZoneShell(ZONE, {
      zones: new Map([[ZONE, { name: 'The Sunken Stair' }]]),
      next: (ZONE + 1) as ZoneId,
    });
    const world = new GameWorld([shell], { zone: ZONE, room: null }, [], new Map(), {
      rooms: new Map([authoredRoom(AUTHORED_ROOM_BASE, 0, 0)]),
      next: AUTHORED_ROOM_BASE + 1,
      deleted: new Set(),
      extents: new Map(),
    });
    assert.equal(world.zone(ZONE)?.rooms.length, 1);
    assert.deepEqual(world.levelsOf(ZONE), [0]);
    assert.ok(world.grid({ zone: ZONE, level: 0 }), 'a grid can be built for the new Place');
    assert.equal(world.authoredRefusals.length, 0);
  });
});
