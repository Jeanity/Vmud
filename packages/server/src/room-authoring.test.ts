import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AUTHORED_ROOM_BASE, boundsOf, type Room, type RoomId, type Zone } from '@mygame/shared';

import {
  composeAuthoredRooms,
  draftAuthoredRoom,
  loadAuthoredRooms,
  placementRefusal,
  resolveExits,
  saveAuthoredRooms,
  takeAuthoredRoomId,
  type AuthoredRooms,
} from './room-authoring.ts';

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-authored-rooms-'));
  const file = join(dir, 'rooms-authored.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

function room(id: number, x: number, y: number, over: Partial<Room> = {}): Room {
  return {
    id: id as RoomId,
    zone: 1,
    name: `Room ${id}`,
    sector: 'inside',
    pos: { x, y, z: 0 },
    exits: {},
    ...over,
  } as Room;
}

/**
 * A three-by-one strip with a hole in the middle: rooms at (0,0) and (2,0), nothing at (1,0).
 *
 * The shape the whole slice exists for — a gap the source left, inside an extent that already
 * reaches past it, so filling it resizes nothing.
 */
function zone(rooms: readonly Room[] = [room(10, 0, 0), room(11, 2, 0)]): Zone {
  return { id: 1, name: 'Test', rooms: [...rooms], bounds: boundsOf(rooms) } as Zone;
}

function draft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { zone: 1, name: 'A New Room', sector: 'cave', x: 1, y: 0, level: 0, exits: ['west'], ...over };
}

/* -------------------------------------------------------------------------- */
/* The draft                                                                   */
/* -------------------------------------------------------------------------- */

test('an id below the authored base is refused — the range is the whole safety argument', () => {
  const bad = draftAuthoredRoom(97_271 as RoomId, draft());
  assert.ok('error' in bad && bad.error.includes(String(AUTHORED_ROOM_BASE)));
});

test('a draft carries no exits of its own — their far ends are a fact about the zone', () => {
  const drafted = draftAuthoredRoom(AUTHORED_ROOM_BASE as RoomId, draft());
  assert.ok('room' in drafted);
  assert.deepEqual(drafted.room.exits, {});
  assert.deepEqual(drafted.dirs, ['west']);
});

test('a room with no exits is refused — one you cannot walk into is not a room yet', () => {
  const none = draftAuthoredRoom(AUTHORED_ROOM_BASE as RoomId, draft({ exits: [] }));
  assert.ok('error' in none && none.error.includes('at least one exit'));
});

test('an unknown sector or flag is named rather than dropped', () => {
  const sector = draftAuthoredRoom(AUTHORED_ROOM_BASE as RoomId, draft({ sector: 'forrest' }));
  assert.ok('error' in sector && sector.error.includes('sector must be one of'));
  const flag = draftAuthoredRoom(AUTHORED_ROOM_BASE as RoomId, draft({ flags: ['peacful'] }));
  assert.ok('error' in flag && flag.error.includes('peacful'));
});

/* -------------------------------------------------------------------------- */
/* Placement — the sharp edge, side-stepped                                    */
/* -------------------------------------------------------------------------- */

test('a gap inside the extent is free', () => {
  assert.equal(placementRefusal(zone().rooms, { x: 1, y: 0, z: 0 }), undefined);
});

test('a cell outside the extent is refused, and says what the extent is', () => {
  const why = placementRefusal(zone().rooms, { x: 3, y: 0, z: 0 });
  assert.ok(why?.includes('outside level 0'), why);
  assert.ok(why?.includes('0..2'), why);
});

test('an occupied cell names its occupant', () => {
  const why = placementRefusal(zone().rooms, { x: 0, y: 0, z: 0 });
  assert.ok(why?.includes('already holds room 10'), why);
});

test('a level with no rooms has no grid to put one inside', () => {
  const why = placementRefusal(zone().rooms, { x: 0, y: 0, z: 4 });
  assert.ok(why?.includes('level 4 has no rooms'), why);
});

/* -------------------------------------------------------------------------- */
/* Exits                                                                       */
/* -------------------------------------------------------------------------- */

test('a direction resolves to whatever is in the adjacent cell — it is never posted', () => {
  const resolved = resolveExits(zone().rooms, { x: 1, y: 0, z: 0 }, ['west', 'east']);
  assert.ok('exits' in resolved);
  assert.deepEqual(resolved.exits, { west: 10, east: 11 });
});

test('a direction with nothing beside it is refused', () => {
  const resolved = resolveExits(zone().rooms, { x: 1, y: 0, z: 0 }, ['north']);
  assert.ok('error' in resolved && resolved.error.includes('nothing lies north'));
});

test('up and down are refused by name — they land on another Place', () => {
  const resolved = resolveExits(zone().rooms, { x: 1, y: 0, z: 0 }, ['up']);
  assert.ok('error' in resolved && resolved.error.includes('not linkable'));
});

test("a neighbour's existing exit is refused, never overwritten", () => {
  const occupied = zone([room(10, 0, 0, { exits: { east: { to: 99 as RoomId } } }), room(11, 2, 0)]);
  const resolved = resolveExits(occupied.rooms, { x: 1, y: 0, z: 0 }, ['west']);
  assert.ok('error' in resolved && resolved.error.includes('already has a east exit'));
});

/* -------------------------------------------------------------------------- */
/* Composition                                                                 */
/* -------------------------------------------------------------------------- */

function authored(id: number, over: Record<string, unknown> = {}): AuthoredRooms {
  const rooms: AuthoredRooms = new Map();
  rooms.set(id as RoomId, {
    room: {
      id: id as RoomId,
      zone: 1,
      name: 'A New Room',
      sector: 'cave',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 10 as RoomId } },
      ...over,
    } as Room,
  });
  return rooms;
}

test('composing hangs the room in the zone and writes the reverse exit onto its neighbour', () => {
  const z = zone();
  const { added, refused } = composeAuthoredRooms(z, authored(AUTHORED_ROOM_BASE));

  assert.equal(refused.length, 0);
  assert.equal(added.length, 1);
  assert.equal(z.rooms.length, 3);
  // Both ends. A doorway worked from one side only is a wall from the other.
  assert.equal(added[0]!.exits.west?.to, 10);
  assert.equal(z.rooms.find((r) => r.id === 10)!.exits.east?.to, AUTHORED_ROOM_BASE);
});

test('composing does not widen the level — which is what makes a saved map still valid', () => {
  const z = zone();
  const before = boundsOf(z.rooms.filter((r) => r.pos.z === 0));
  composeAuthoredRooms(z, authored(AUTHORED_ROOM_BASE));
  assert.deepEqual(boundsOf(z.rooms.filter((r) => r.pos.z === 0)), before);
});

test('a room placed outside the extent is left out entirely, and says why', () => {
  const z = zone();
  const { added, refused } = composeAuthoredRooms(z, authored(AUTHORED_ROOM_BASE, { pos: { x: 9, y: 0, z: 0 } }));

  assert.equal(added.length, 0);
  assert.equal(z.rooms.length, 2);
  assert.ok(refused[0]?.why.includes('outside level 0'), refused[0]?.why);
});

test('a neighbour that moved costs the exit, not the room', () => {
  // The record says west is room 10; room 10 is now two cells away, so the link is a lie.
  const rooms = authored(AUTHORED_ROOM_BASE);
  const stale = zone([room(10, -1, 0), room(11, 2, 0), room(12, 0, 0)]);
  const { added, refused } = composeAuthoredRooms(stale, rooms);

  assert.equal(added.length, 1, 'the room still stands');
  assert.deepEqual(added[0]!.exits, {}, 'the exit that cannot be honoured is gone');
  assert.ok(refused[0]?.why.includes('no longer the cell west'), refused[0]?.why);
});

test('two authored rooms side by side are joined to each other', () => {
  // A two-cell gap: (1,0) and (2,0) empty, walls at (0,0) and (3,0).
  const z = zone([room(10, 0, 0), room(11, 3, 0)]);
  const rooms = authored(AUTHORED_ROOM_BASE);
  rooms.set((AUTHORED_ROOM_BASE + 1) as RoomId, {
    room: {
      id: (AUTHORED_ROOM_BASE + 1) as RoomId,
      zone: 1,
      name: 'The Second',
      sector: 'cave',
      pos: { x: 2, y: 0, z: 0 },
      exits: { west: { to: AUTHORED_ROOM_BASE as RoomId }, east: { to: 11 as RoomId } },
    } as Room,
  });

  const { added, refused } = composeAuthoredRooms(z, rooms);
  assert.deepEqual(refused, []);
  assert.equal(added.length, 2);
  // The first room was hung before the second was linked, which is the whole reason for two passes.
  assert.equal(added[0]!.exits.east?.to, AUTHORED_ROOM_BASE + 1);
  assert.equal(added[1]!.exits.west?.to, AUTHORED_ROOM_BASE);
});

test('a room whose id collides with the harvest is refused rather than shadowing it', () => {
  const z = zone();
  const rooms: AuthoredRooms = new Map();
  rooms.set(10 as RoomId, { room: { ...room(10, 1, 0), sector: 'cave' } as Room });

  const { added, refused } = composeAuthoredRooms(z, rooms);
  assert.equal(added.length, 0);
  assert.ok(refused[0]?.why.includes('already in the zone'), refused[0]?.why);
});

/* -------------------------------------------------------------------------- */
/* The file                                                                    */
/* -------------------------------------------------------------------------- */

test('a missing overlay is not an error — it is the ordinary case', () => {
  const store = loadAuthoredRooms(join(tmpdir(), 'mygame-nothing-here', 'rooms-authored.json'));
  assert.equal(store.rooms.size, 0);
  assert.equal(store.next, AUTHORED_ROOM_BASE);
});

test('malformed JSON loses the overlay rather than the server', () => {
  assert.equal(loadAuthoredRooms(tempFile('{ not json')).rooms.size, 0);
});

test('a whole record round-trips, exits and all', () => {
  const file = tempFile();
  const store = { rooms: authored(AUTHORED_ROOM_BASE), next: AUTHORED_ROOM_BASE + 1 };
  saveAuthoredRooms(store, file);

  const back = loadAuthoredRooms(file);
  const record = back.rooms.get(AUTHORED_ROOM_BASE as RoomId);
  assert.equal(back.next, AUTHORED_ROOM_BASE + 1);
  assert.equal(record?.room.name, 'A New Room');
  assert.equal(record?.room.sector, 'cave');
  assert.deepEqual(record?.room.pos, { x: 1, y: 0, z: 0 });
  assert.equal(record?.room.exits.west?.to, 10);
});

test('a record the validator refuses is dropped, and the rest of the file survives', () => {
  const file = tempFile(
    JSON.stringify({
      next: AUTHORED_ROOM_BASE + 2,
      rooms: {
        [AUTHORED_ROOM_BASE]: { zone: 1, name: '', sector: 'cave', x: 1, y: 0, level: 0, exits: { west: 10 } },
        [AUTHORED_ROOM_BASE + 1]: { zone: 1, name: 'Kept', sector: 'cave', x: 1, y: 1, level: 0, exits: { west: 10 } },
      },
    }),
  );
  const store = loadAuthoredRooms(file);
  assert.equal(store.rooms.size, 1);
  assert.equal(store.rooms.get((AUTHORED_ROOM_BASE + 1) as RoomId)?.room.name, 'Kept');
});

test('the counter is raised to clear the records, never lowered by a hand edit', () => {
  const file = tempFile(
    JSON.stringify({
      next: AUTHORED_ROOM_BASE,
      rooms: {
        [AUTHORED_ROOM_BASE + 7]: { zone: 1, name: 'High', sector: 'cave', x: 1, y: 0, level: 0, exits: { west: 10 } },
      },
    }),
  );
  assert.equal(loadAuthoredRooms(file).next, AUTHORED_ROOM_BASE + 8);
});

test('an id is never handed out twice, including across a delete', () => {
  const store = { rooms: new Map(), next: AUTHORED_ROOM_BASE };
  const first = takeAuthoredRoomId(store);
  const second = takeAuthoredRoomId(store);
  assert.equal(second, first + 1);
  // Deleting the highest must not free its number — a room id is a name, and names are not reused.
  store.rooms.clear();
  assert.equal(takeAuthoredRoomId(store), second + 1);
});
