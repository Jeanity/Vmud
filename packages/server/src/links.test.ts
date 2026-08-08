/**
 * The authored-link overlay.
 *
 * What these are really about is the two silent failures. A link that writes only one half is a door
 * you walk through and cannot come back from, and a link that overwrites a harvested exit changes the
 * shape of a zone in a file that says nothing about that zone — both invisible until a player is
 * standing somewhere they cannot leave.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Room, RoomId } from '@mygame/shared';

import { applyLinks, draftLink, loadLinks, type LinkDraft } from './links.ts';

function room(id: number, exits: Record<string, { to: number }> = {}): Room {
  return {
    id: id as RoomId,
    zone: Math.floor(id / 100),
    name: `Room ${id}`,
    sector: 'forest',
    pos: { x: 0, y: 0, z: 0 },
    exits,
    flags: [],
  } as unknown as Room;
}

function world(...rooms: Room[]): (id: RoomId) => Room | undefined {
  const map = new Map(rooms.map((r) => [r.id, r]));
  return (id) => map.get(id);
}

const RING: LinkDraft = { a: 100, aDir: 'north', b: 700, bDir: 'south', brief: 'the faerie ring' };

describe('what may be authored as a link', () => {
  it('takes a well-formed pair', () => {
    const made = draftLink(RING);
    assert.ok('link' in made);
    assert.deepEqual(made.link, { a: 100, aDir: 'north', b: 700, bDir: 'south', brief: 'the faerie ring' });
  });

  it('does not require a brief, and drops an empty one rather than storing it', () => {
    const made = draftLink({ a: 100, aDir: 'north', b: 700, bDir: 'south', brief: '' });
    assert.ok('link' in made);
    assert.equal('brief' in made.link, false);
  });

  it('refuses a direction that is not one', () => {
    for (const dir of ['northeast', 'in', 'NORTH', 5, undefined]) {
      const made = draftLink({ ...RING, aDir: dir });
      assert.ok('error' in made, `${String(dir)} should be refused`);
      assert.match(made.error, /aDir must be one of/);
    }
  });

  it('refuses a room id that is not a whole number', () => {
    for (const id of ['100', 1.5, -1, null]) {
      const made = draftLink({ ...RING, b: id });
      assert.ok('error' in made, `${String(id)} should be refused`);
      assert.match(made.error, /b must be a whole room id/);
    }
  });

  it('refuses a room linked to itself, where the two halves would land on one room', () => {
    const made = draftLink({ ...RING, a: 700, b: 700 });
    assert.ok('error' in made);
    assert.match(made.error, /joins two different rooms/);
  });
});

describe('carving links into a world', () => {
  it('writes both halves, and marks both as portals', () => {
    const a = room(100);
    const b = room(700);
    const made = draftLink(RING);
    assert.ok('link' in made);
    const result = applyLinks(world(a, b), [made.link]);
    assert.equal(result.applied, 1);
    assert.deepEqual(result.refused, []);
    // **Both ways.** The failure this pins is a one-way faerie ring — you step through and live there.
    assert.deepEqual(a.exits.north, { to: 700, portal: true });
    assert.deepEqual(b.exits.south, { to: 100, portal: true });
  });

  it('refuses a link whose far room is in a zone nobody loaded, and leaves the world standing', () => {
    const a = room(100);
    const made = draftLink(RING);
    assert.ok('link' in made);
    const result = applyLinks(world(a), [made.link]);
    assert.equal(result.applied, 0);
    assert.match(result.refused[0] ?? '', /room 700 is not in a loaded zone/);
    // Nothing was written on the half that *was* loaded.
    assert.equal(a.exits.north, undefined);
  });

  it('never overwrites an exit the harvest already has', () => {
    const a = room(100, { north: { to: 999 } });
    const b = room(700);
    const made = draftLink(RING);
    assert.ok('link' in made);
    const result = applyLinks(world(a, b), [made.link]);
    assert.equal(result.applied, 0);
    assert.match(result.refused[0] ?? '', /already has a north exit/);
    assert.deepEqual(a.exits.north, { to: 999 }, 'the harvested door is untouched');
    // **And the other half was never written either** — the check is done before anything is carved,
    // so a refusal on one side cannot leave a one-way door on the other.
    assert.equal(b.exits.south, undefined);
  });

  it('refuses on the far side too, and still writes nothing', () => {
    const a = room(100);
    const b = room(700, { south: { to: 888 } });
    const made = draftLink(RING);
    assert.ok('link' in made);
    const result = applyLinks(world(a, b), [made.link]);
    assert.equal(result.applied, 0);
    assert.equal(a.exits.north, undefined, 'the near half must not survive a far-half refusal');
  });
});

describe('the file a person edits', () => {
  it('reads good records and skips bad ones rather than refusing to boot', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mygame-links-')), 'links.json');
    writeFileSync(
      file,
      JSON.stringify([
        { a: 100, aDir: 'north', b: 700, bDir: 'south' },
        { a: 101, aDir: 'sideways', b: 701, bDir: 'south' },
        { a: 102, aDir: 'east', b: 702, bDir: 'west' },
      ]),
    );
    // One malformed record must not cost the other two — `quests.ts`' posture, and the reason is the
    // same: a hand-edited world file with a typo in it should lose a door, not a server.
    const links = loadLinks(file);
    assert.equal(links.length, 2);
    assert.deepEqual(links.map((l) => l.a), [100, 102]);
  });

  it('treats a missing file as a world with no authored links', () => {
    assert.deepEqual(loadLinks(join(tmpdir(), 'mygame-links-does-not-exist', 'links.json')), []);
  });
});
