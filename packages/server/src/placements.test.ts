/**
 * A9c — where an authored creature lives.
 *
 * The interesting half is the turn from *a room and a number* into an `M` command, because that is where
 * this either becomes population or becomes a reset that quietly never fires. Two things are pinned that
 * a reader would otherwise have to take on trust: the command is **never chained**, so it can neither
 * steal a harvested `G`'s cursor nor be skipped by one; and it is at **100 percent**, because `runReset`
 * fires an `M` on a timed repop only at exactly that.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { RoomId } from '@mygame/shared';

import { loadPlacements, placementResets, savePlacements, type Placements } from './placements.ts';

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-placements-'));
  const file = join(dir, 'placements.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

/** A stand-in world: rooms 6001–6002 in zone 600, 7001 in zone 700, everything else unknown. */
const zoneOf = (room: RoomId): number | undefined =>
  room === 6001 || room === 6002 ? 600 : room === 7001 ? 700 : undefined;

describe('turning a placement into a reset', () => {
  it('makes one M command per room, grouped by the zone the room is in', () => {
    const placements: Placements = new Map([
      [61, [{ room: 6001 as RoomId, limit: 2 }, { room: 7001 as RoomId, limit: 1 }]],
    ]);
    const byZone = placementResets(placements, zoneOf);
    assert.deepEqual([...byZone.keys()].sort(), [600, 700]);
    assert.equal(byZone.get(600)?.length, 1);
    assert.equal(byZone.get(600)?.[0]?.what, 61);
    assert.equal(byZone.get(600)?.[0]?.room, 6001);
    assert.equal(byZone.get(600)?.[0]?.limit, 2);
  });

  it('never chains, so it cannot steal a cursor or be skipped by one', () => {
    // A zone file's order is load-bearing: `G` and `E` attach to *the last mobile loaded*. An authored
    // command that participated in that chain could be handed somebody else's sword.
    const byZone = placementResets(new Map([[61, [{ room: 6001 as RoomId, limit: 1 }]]]), zoneOf);
    assert.equal(byZone.get(600)?.[0]?.ifPrevious, false);
  });

  it('is at a hundred percent, which is the only value that fires on a timed repop', () => {
    const byZone = placementResets(new Map([[61, [{ room: 6001 as RoomId, limit: 1 }]]]), zoneOf);
    assert.equal(byZone.get(600)?.[0]?.percent, 100);
  });

  it('drops a room the world does not have rather than emitting a command that points nowhere', () => {
    const byZone = placementResets(new Map([[61, [{ room: 12_345 as RoomId, limit: 1 }]]]), zoneOf);
    assert.equal(byZone.size, 0);
  });

  it('gathers two mobs placed in one zone into that zone’s list', () => {
    const byZone = placementResets(
      new Map([
        [61, [{ room: 6001 as RoomId, limit: 1 }]],
        [62, [{ room: 6002 as RoomId, limit: 1 }]],
      ]),
      zoneOf,
    );
    assert.equal(byZone.get(600)?.length, 2);
  });
});

describe('the placement overlay on disk', () => {
  it('round-trips', () => {
    const file = tempFile();
    savePlacements(new Map([[61, [{ room: 6001 as RoomId, limit: 3 }]]]), file);
    assert.deepEqual(loadPlacements(file).get(61), [{ room: 6001, limit: 3 }]);
  });

  it('does not write a mob whose rooms were all removed', () => {
    // The rule every overlay here keeps: an empty list is not a placed mob, it is the record of one
    // having been placed and then unplaced.
    const file = tempFile();
    savePlacements(new Map([[61, []], [62, [{ room: 6001 as RoomId, limit: 1 }]]]), file);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')) as object), ['62']);
  });

  it('defaults a hand-written row with no limit to one', () => {
    assert.deepEqual(loadPlacements(tempFile('{"61": [{"room": 6001}]}')).get(61), [{ room: 6001, limit: 1 }]);
  });

  it('clamps a hand-written limit rather than refusing the row', () => {
    // The loader's posture everywhere: salvage what is meant. The *router* refuses instead, because a
    // form is a person still holding the keyboard and a file has nobody to tell.
    assert.equal(loadPlacements(tempFile('{"61": [{"room": 6001, "limit": 900}]}')).get(61)?.[0]?.limit, 99);
    assert.equal(loadPlacements(tempFile('{"61": [{"room": 6001, "limit": 0}]}')).get(61)?.[0]?.limit, 1);
  });

  it('drops a row with no room, which would be a reset that spawns nothing', () => {
    assert.equal(loadPlacements(tempFile('{"61": [{"limit": 2}]}')).size, 0);
  });

  it('reads nothing at all from a file that is not there', () => {
    assert.equal(loadPlacements(join(tmpdir(), 'mygame-no-such-placements.json')).size, 0);
  });
});
