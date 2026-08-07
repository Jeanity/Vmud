/**
 * `look <direction>` — the gauntlet between you and the next room, in the source's order.
 *
 * The two rules worth pinning hardest: the light gate belongs to the **far** room (you can see into a
 * lit room from the dark, and not into a dark room from the light — the whole reason the feature is
 * interesting), and a one-way link refuses (which is what keeps every portal-marked exit from being a
 * window into a room six cells away).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Room } from '@mygame/shared';

import { directionFrom, peek } from './peek.ts';

function room(id: number, over: Partial<Room> = {}): Room {
  return { id, zone: 400, name: `Room ${id}`, sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: {}, ...over } as Room;
}

/** A two-room world with a mutual east-west link, the shape every rule below starts from. */
function pair(overNear: Partial<Room> = {}, overFar: Partial<Room> = {}) {
  const near = room(1, { exits: { east: { to: 2 } }, ...overNear });
  const far = room(2, { exits: { west: { to: 1 } }, ...overFar });
  return { near, far };
}

type Body = { name: string; lightRadius: number };

function deps(rooms: Room[], occupants: Body[] = [], door?: { name: string; closed: boolean }) {
  return {
    roomOf: (id: number) => rooms.find((r) => r.id === id),
    occupantsOf: () => occupants,
    doorAt: () => door,
  };
}

describe('naming a direction', () => {
  it('reads the Diku abbreviations, case-blind', () => {
    assert.equal(directionFrom('e'), 'east');
    assert.equal(directionFrom('nor'), 'north');
    assert.equal(directionFrom('d'), 'down');
    assert.equal(directionFrom('EAST'), 'east');
  });

  it('names nothing for the empty string, a phrase, or a non-prefix', () => {
    assert.equal(directionFrom(''), undefined);
    assert.equal(directionFrom('in quiver'), undefined);
    // `door` shares two letters with `down` and is not a prefix of it.
    assert.equal(directionFrom('door'), undefined);
  });
});

describe('the gauntlet, in the source’s order', () => {
  it('has nothing to say where there is no exit', () => {
    const { near, far } = pair();
    assert.deepEqual(peek(near, 'north', deps([near, far])), { t: 'no-exit' });
  });

  it('is blocked by a closed door, and names it', () => {
    const { near, far } = pair();
    const outcome = peek(near, 'east', deps([near, far], [], { name: 'the oak door', closed: true }));
    assert.deepEqual(outcome, { t: 'closed-door', door: 'the oak door' });
  });

  it('sees through an open door, and still mentions it', () => {
    const { near, far } = pair();
    const outcome = peek(near, 'east', deps([near, far], [], { name: 'the oak door', closed: false }));
    assert.equal(outcome.t, 'view');
    assert.equal((outcome as { door?: string }).door, 'the oak door');
  });

  it('meets mists at the edge of the loaded world', () => {
    const { near } = pair();
    assert.deepEqual(peek(near, 'east', deps([near])), { t: 'nowhere' });
  });

  it('refuses a one-way link — which is what keeps portals from being windows', () => {
    const near = room(1, { exits: { east: { to: 2 } } });
    // The far room's west exit goes somewhere else entirely, which is every portal's shape.
    const far = room(2, { exits: { west: { to: 3 } } });
    assert.deepEqual(peek(near, 'east', deps([near, far, room(3)])), { t: 'one-way' });
    // And no reverse exit at all is the plain one-way case.
    const blind = room(2, { exits: {} });
    assert.deepEqual(peek(near, 'east', deps([near, blind])), { t: 'one-way' });
  });

  it('gates on the far room’s light, not the looker’s', () => {
    // The near room is dark and the far one lights itself: visible. The reverse: not.
    const { near, far } = pair({ flags: ['dark'] });
    assert.equal(peek(near, 'east', deps([near, far])).t, 'view');
    const { near: lit, far: cave } = pair({}, { flags: ['dark'] });
    assert.equal(peek(lit, 'east', deps([lit, cave])).t, 'dark');
  });

  it('sees a dark room by the light somebody in it carries', () => {
    const { near, far } = pair({}, { flags: ['dark'] });
    const outcome = peek(near, 'east', deps([near, far], [{ name: 'a miner', lightRadius: 3 }]));
    assert.equal(outcome.t, 'view');
  });
});

describe('what is standing there', () => {
  it('aggregates twins into one name and a count, in encounter order', () => {
    const { near, far } = pair();
    const outcome = peek(
      near,
      'east',
      deps([near, far], [
        { name: 'a member of the Court Patrol', lightRadius: 0 },
        { name: 'the kobold shaman', lightRadius: 0 },
        { name: 'a member of the Court Patrol', lightRadius: 0 },
        { name: 'a member of the Court Patrol', lightRadius: 0 },
      ]),
    );
    assert.equal(outcome.t, 'view');
    assert.deepEqual((outcome as { occupants: unknown }).occupants, [
      { name: 'a member of the Court Patrol', count: 3 },
      { name: 'the kobold shaman', count: 1 },
    ]);
  });

  it('reports an empty room as empty rather than saying nothing', () => {
    const { near, far } = pair();
    const outcome = peek(near, 'east', deps([near, far]));
    assert.equal(outcome.t, 'view');
    assert.deepEqual((outcome as { occupants: readonly unknown[] }).occupants, []);
  });
});
