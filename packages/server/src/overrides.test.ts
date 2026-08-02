import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Room, RoomId, Zone } from '@mygame/shared';

import {
  applyOverridesToZone,
  loadRoomOverrides,
  mergeOverride,
  saveRoomOverrides,
  type RoomOverrides,
} from './overrides.ts';

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-overrides-'));
  const file = join(dir, 'rooms.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

function room(id: number, over: Partial<Room> = {}): Room {
  return {
    id: id as RoomId,
    zone: 1,
    name: 'A Plain Room',
    sector: 'inside',
    pos: { x: 0, y: 0, z: 0 },
    exits: {},
    description: 'Bare stone.',
    ...over,
  } as Room;
}

function zone(rooms: readonly Room[]): Zone {
  return {
    id: 1,
    name: 'Test',
    rooms,
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
  } as Zone;
}

test('a missing overlay is not an error — it is the ordinary case', () => {
  assert.equal(loadRoomOverrides(join(tmpdir(), 'mygame-nothing-here', 'rooms.json')).size, 0);
});

test('malformed JSON loses the overlay rather than the server', () => {
  assert.equal(loadRoomOverrides(tempFile('{ not json')).size, 0);
});

test('an override patches only the fields it names', () => {
  const file = tempFile(JSON.stringify({ 5: { description: 'Rewritten.' } }));
  const target = room(5);
  const z = zone([target]);

  assert.equal(applyOverridesToZone(z, loadRoomOverrides(file)), 1);
  assert.equal(target.description, 'Rewritten.');
  // Untouched, because the patch did not mention them.
  assert.equal(target.name, 'A Plain Room');
  assert.equal(target.sector, 'inside');
});

test('geometry is not overridable — id, position and exits are the join key and the grid', () => {
  const file = tempFile(
    JSON.stringify({ 7: { id: 999, pos: { x: 40, y: 40, z: 4 }, exits: { north: { to: 12 } }, zone: 88 } }),
  );
  const target = room(7, { exits: {} });
  applyOverridesToZone(zone([target]), loadRoomOverrides(file));

  assert.equal(target.id, 7);
  assert.deepEqual(target.pos, { x: 0, y: 0, z: 0 });
  assert.deepEqual(target.exits, {});
  assert.equal(target.zone, 1);
});

test('a sector the game does not have is dropped, not stored', () => {
  // The failure this prevents: `SECTOR_MOVE_COST['forrest']` is `undefined`, movement cost becomes
  // NaN, and every later comparison against the pool is false.
  const file = tempFile(JSON.stringify({ 3: { sector: 'forrest', description: 'Trees.' } }));
  const loaded = loadRoomOverrides(file);
  assert.equal(loaded.get(3 as RoomId)?.sector, undefined);
  assert.equal(loaded.get(3 as RoomId)?.description, 'Trees.');
});

test('unknown flags are filtered out, known ones survive', () => {
  const file = tempFile(JSON.stringify({ 3: { flags: ['safe', 'peacful', 'dark'] } }));
  assert.deepEqual(loadRoomOverrides(file).get(3 as RoomId)?.flags, ['safe', 'dark']);
});

test('an entry with nothing valid left in it is not stored at all', () => {
  const file = tempFile(JSON.stringify({ 3: { sector: 'nowhere' }, 4: { name: '   ' } }));
  assert.equal(loadRoomOverrides(file).size, 0);
});

test('a save round-trips through a load', () => {
  const file = tempFile();
  const overrides: RoomOverrides = new Map();
  mergeOverride(overrides, 12 as RoomId, { name: '&+YThe Gilded Hall&N', flags: ['safe'] }, '2026-08-02T00:00:00Z');
  saveRoomOverrides(overrides, file);

  const back = loadRoomOverrides(file);
  assert.equal(back.get(12 as RoomId)?.name, '&+YThe Gilded Hall&N');
  assert.deepEqual(back.get(12 as RoomId)?.flags, ['safe']);
  assert.equal(back.get(12 as RoomId)?.at, '2026-08-02T00:00:00Z');
});

test('merging keeps fields the new patch does not mention', () => {
  const overrides: RoomOverrides = new Map();
  mergeOverride(overrides, 1 as RoomId, { description: 'First.', flags: ['dark'] }, 'a');
  const merged = mergeOverride(overrides, 1 as RoomId, { name: 'Second' }, 'b');

  assert.equal(merged.description, 'First.');
  assert.deepEqual(merged.flags, ['dark']);
  assert.equal(merged.name, 'Second');
  assert.equal(merged.at, 'b');
});

test('rooms with no override are left exactly as generated', () => {
  const file = tempFile(JSON.stringify({ 1: { description: 'Edited.' } }));
  const edited = room(1);
  const untouched = room(2);
  assert.equal(applyOverridesToZone(zone([edited, untouched]), loadRoomOverrides(file)), 1);
  assert.equal(untouched.description, 'Bare stone.');
});
