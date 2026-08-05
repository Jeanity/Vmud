import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AUTHORED_ROOM_BASE, boundsOf, type Room, type RoomId, type Zone } from '@mygame/shared';

import {
  applyDeletions,
  composeAuthoredRooms,
  draftAuthoredRoom,
  extentOf,
  loadAuthoredRooms,
  narrowsExtent,
  placementRefusal,
  removalRefusal,
  resolveExits,
  saveAuthoredRooms,
  takeAuthoredRoomId,
  widensExtent,
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

test('a cell outside the extent is allowed now, and reported as moving the grid', () => {
  // Slices 1 and 2 refused this. Slice 3 pays for it instead — the room is built and the Place's
  // maps are cleared, which is the only honest outcome of the three.
  assert.equal(placementRefusal(zone().rooms, { x: 3, y: 0, z: 0 }), undefined);
  assert.equal(widensExtent(zone().rooms, { x: 3, y: 0, z: 0 }), true);
  assert.equal(widensExtent(zone().rooms, { x: 1, y: 0, z: 0 }), false, 'a gap inside it still costs nothing');
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
  // Pointing at room 11, which is right there in the fixture — a link that still leads somewhere.
  const occupied = zone([room(10, 0, 0, { exits: { east: { to: 11 as RoomId } } }), room(11, 2, 0)]);
  const resolved = resolveExits(occupied.rooms, { x: 1, y: 0, z: 0 }, ['west']);
  assert.ok('error' in resolved && resolved.error.includes('already has a east exit'));
});

test('an exit left pointing at a deleted room is debris, and building into the hole repairs it', () => {
  // Exactly what slice 2 leaves behind: 10 still points east at a room that is no longer there.
  const emptied = zone([room(10, 0, 0, { exits: { east: { to: 11 as RoomId } } }), room(12, 2, 0)]);
  const resolved = resolveExits(emptied.rooms, { x: 1, y: 0, z: 0 }, ['west']);
  assert.ok('exits' in resolved, 'a dead link must not make the cell unbuildable for ever');
  assert.deepEqual(resolved.exits, { west: 10 });
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

test('a room outside the extent composes, and the level really is wider afterwards', () => {
  const z = zone();
  // Its west exit points at room 10, which is now four cells away, so the link is dropped — but the
  // room itself stands. Slice 3's question is only about the grid.
  const { added, refused } = composeAuthoredRooms(z, authored(AUTHORED_ROOM_BASE, { pos: { x: 4, y: 0, z: 0 } }));

  assert.equal(added.length, 1);
  assert.equal(z.rooms.length, 3);
  assert.deepEqual(extentOf(z.rooms, 0), { minX: 0, maxX: 4, minY: 0, maxY: 0 });
  assert.ok(refused[0]?.why.includes('west exit dropped'), refused[0]?.why);
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
  const store = { rooms: authored(AUTHORED_ROOM_BASE), next: AUTHORED_ROOM_BASE + 1, deleted: new Set<RoomId>(), extents: new Map() };
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
  const store = { rooms: new Map(), next: AUTHORED_ROOM_BASE, deleted: new Set<RoomId>(), extents: new Map() };
  const first = takeAuthoredRoomId(store);
  const second = takeAuthoredRoomId(store);
  assert.equal(second, first + 1);
  // Deleting the highest must not free its number — a room id is a name, and names are not reused.
  store.rooms.clear();
  assert.equal(takeAuthoredRoomId(store), second + 1);
});

/* -------------------------------------------------------------------------- */
/* Removal — slice 2                                                           */
/* -------------------------------------------------------------------------- */

test('an interior room can go — the middle of a strip holds no bound', () => {
  const strip = [room(1, 0, 0), room(2, 1, 0), room(3, 2, 0)];
  assert.equal(removalRefusal(strip, 2 as RoomId), undefined);
});

test('a room that is not there at all is refused rather than silently succeeding', () => {
  const strip = [room(1, 0, 0), room(2, 1, 0), room(3, 2, 0)];
  assert.ok(removalRefusal(strip, 99 as RoomId)?.includes('not in this zone'));
});

test('a room the extent rests on can go now, and is reported as moving the grid', () => {
  const strip = [room(1, 0, 0), room(2, 1, 0), room(3, 2, 0)];
  assert.equal(removalRefusal(strip, 3 as RoomId), undefined);
  assert.equal(narrowsExtent(strip, 3 as RoomId), true);
  assert.equal(narrowsExtent(strip, 2 as RoomId), false, 'the middle still costs nothing');
});

test('a bound shared with another room is not a bound this room holds', () => {
  // Two rooms at maxX: losing one moves nothing, and treating every edge room as a resize would
  // clear maps for nothing several times a session.
  const block = [room(1, 0, 0), room(2, 1, 0), room(3, 1, 1), room(4, 0, 1)];
  assert.equal(removalRefusal(block, 2 as RoomId), undefined);
  assert.equal(narrowsExtent(block, 2 as RoomId), false);
});

test('the last room on a level is refused — that is removing the Place, not a room', () => {
  const alone = [room(1, 0, 0)];
  assert.ok(removalRefusal(alone, 1 as RoomId)?.includes('only room on level 0'));
});

test('a tombstone takes the room out at load and counts what now leads nowhere', () => {
  const z = zone([
    room(10, 0, 0, { exits: { east: { to: 11 as RoomId } } }),
    room(11, 1, 0, { exits: { west: { to: 10 as RoomId }, east: { to: 12 as RoomId } } }),
    room(12, 2, 0, { exits: { west: { to: 11 as RoomId } } }),
  ]);
  const { removed, refused, dangling } = applyDeletions(z, new Set([11 as RoomId]));

  assert.deepEqual(refused, []);
  assert.equal(removed.length, 1);
  assert.equal(z.rooms.length, 2);
  // Both survivors still point at 11. Left alone rather than rewritten — the shipped world already
  // has 5 exits like this and the engine simply does not walk them.
  assert.equal(dangling, 2);
  assert.equal(z.rooms.find((r) => r.id === 10)!.exits.east?.to, 11);
});

test('a tombstone on the edge shrinks the grid, and the extent says so afterwards', () => {
  const z = zone([room(10, 0, 0), room(11, 1, 0), room(12, 2, 0)]);
  const { removed, refused } = applyDeletions(z, new Set([12 as RoomId]));

  assert.deepEqual(refused, []);
  assert.equal(removed.length, 1);
  // The comparison that catches it is the stored extent's, at boot — see `GameWorld.staleExtents`.
  assert.deepEqual(extentOf(z.rooms, 0), { minX: 0, maxX: 1, minY: 0, maxY: 0 });
});

test('the last room on a level is still refused — that is removing the Place, not resizing it', () => {
  const z = zone([room(10, 0, 0)]);
  const { removed, refused } = applyDeletions(z, new Set([10 as RoomId]));
  assert.equal(removed.length, 0);
  assert.ok(refused[0]?.why.includes('only room on level 0'), refused[0]?.why);
});

test('extents round-trip, and a half-written one is dropped rather than compared', () => {
  const file = tempFile(
    JSON.stringify({
      next: AUTHORED_ROOM_BASE,
      extents: { '168:5': { minX: 0, maxX: 12, minY: 0, maxY: 9 }, '36:9': { minX: 0, maxX: 3 } },
      rooms: {},
    }),
  );
  const store = loadAuthoredRooms(file);
  assert.deepEqual(store.extents.get('168:5'), { minX: 0, maxX: 12, minY: 0, maxY: 9 });
  // All four or none: a half-read extent compares unequal to everything and would clear a Place's
  // maps on every boot, which is the one failure this record exists to prevent.
  assert.equal(store.extents.has('36:9'), false);

  const back = tempFile();
  saveAuthoredRooms(store, back);
  assert.deepEqual(loadAuthoredRooms(back).extents.get('168:5'), { minX: 0, maxX: 12, minY: 0, maxY: 9 });
});

test('tombstones round-trip, and only harvested ids are honoured', () => {
  const file = tempFile(
    JSON.stringify({ next: AUTHORED_ROOM_BASE, deleted: [41260, AUTHORED_ROOM_BASE, 'x', 41261], rooms: {} }),
  );
  const store = loadAuthoredRooms(file);
  // A created room is deleted by removing its record — a tombstone at or above the base is a
  // contradiction, and honouring it would hide a room the same file still declares.
  assert.deepEqual([...store.deleted].sort((a, b) => a - b), [41260, 41261]);

  const back = tempFile();
  saveAuthoredRooms(store, back);
  assert.deepEqual([...loadAuthoredRooms(back).deleted].sort((a, b) => a - b), [41260, 41261]);
});
