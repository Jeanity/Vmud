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

import { afterLook, directionFrom, nameable, peek, revealShownIn } from './peek.ts';

function room(id: number, over: Partial<Room> = {}): Room {
  return { id, zone: 400, name: `Room ${id}`, sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: {}, ...over } as Room;
}

/** A two-room world with a mutual east-west link, the shape every rule below starts from. */
function pair(overNear: Partial<Room> = {}, overFar: Partial<Room> = {}) {
  const near = room(1, { exits: { east: { to: 2 } }, ...overNear });
  const far = room(2, { exits: { west: { to: 1 } }, ...overFar });
  return { near, far };
}

type Body = { name: string; carriesLight: boolean };

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
    const outcome = peek(near, 'east', deps([near, far], [{ name: 'a miner', carriesLight: true }]));
    assert.equal(outcome.t, 'view');
  });

  it('does not see a dark room merely because it is occupied', () => {
    // The bug this pins lived from the feature's birth to 2026-08-13: the gate read `lightRadius > 0`,
    // and the bare eye's radius is floored at 2 world-wide, so four kobolds in a pitch-dark mine
    // tunnel were reported in full to anyone who looked in. Occupied and dark must answer `dark` —
    // an actor is not a torch.
    const { near, far } = pair({}, { flags: ['dark'] });
    const bodies = [
      { name: 'a kobold miner', carriesLight: false },
      { name: 'a kobold miner', carriesLight: false },
      { name: 'the mine overseer', carriesLight: false },
    ];
    assert.deepEqual(peek(near, 'east', deps([near, far], bodies)), { t: 'dark' });
  });
});

describe('what is standing there', () => {
  it('aggregates twins into one name and a count, in encounter order', () => {
    const { near, far } = pair();
    const outcome = peek(
      near,
      'east',
      deps([near, far], [
        { name: 'a member of the Court Patrol', carriesLight: false },
        { name: 'the kobold shaman', carriesLight: false },
        { name: 'a member of the Court Patrol', carriesLight: false },
        { name: 'a member of the Court Patrol', carriesLight: false },
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

/**
 * The reveal a peek leaves behind — ranged slice 2.
 *
 * **Both rules here are restrictions, so neither can fail visibly.** `look west` naming three kobolds
 * reads identically whether or not the set dies when you walk, and the day it stops dying is the day a
 * player is reading a room two away — the one thing the owner ruled out by name: *"I shouldn't be able
 * to see from 2 rooms away"*. Hence tests, rather than trusting the happy path.
 */
describe('what a peek leaves behind', () => {
  it('shows the room you looked at, while you stay put', () => {
    const reveal = afterLook(undefined, 1, 2);
    assert.deepEqual([...revealShownIn(reveal, 1)], [2]);
  });

  it('adds a second direction rather than replacing the first', () => {
    const west = afterLook(undefined, 1, 2);
    const north = afterLook(west, 1, 3);
    assert.deepEqual([...revealShownIn(north, 1)].sort(), [2, 3]);
  });

  it('**does not chain** — walking into the room you peeked at reveals nothing beyond it', () => {
    // Stand in 1, look east into 2, then walk into 2. Room 3 is one further east and was never seen.
    const reveal = afterLook(undefined, 1, 2);
    assert.deepEqual([...revealShownIn(reveal, 2)], [], 'standing in the revealed room must show nothing');
  });

  it('goes dark the moment you are anywhere else, not only in the room you saw', () => {
    const reveal = afterLook(undefined, 1, 2);
    assert.equal(revealShownIn(reveal, 9).size, 0);
  });

  it('starts over when you look from somewhere new, so a trail cannot accumulate behind you', () => {
    const fromOne = afterLook(undefined, 1, 2);
    const fromTwo = afterLook(fromOne, 2, 3);
    assert.deepEqual([...revealShownIn(fromTwo, 2)], [3], 'the room seen from the old spot must not survive the move');
  });

  it('reads as nothing when no direction has been looked at', () => {
    assert.equal(revealShownIn(undefined, 1).size, 0);
  });
});

/**
 * Seeing is not reaching — the rule that broke once already.
 *
 * Slice 2 added peeked bodies to the visible set, and every targeted verb resolves through it, so for
 * one commit `kill kobold` reached a body one room west and a click did the same by a second route.
 * **No test caught it and none would have**: every other test in this repo targets something standing
 * in the same room, where this filter changes nothing. These exist precisely because the happy path is
 * blind to it.
 */
describe('what a verb may name', () => {
  const here = { id: 1, name: 'the kobold shaman' };
  const away = { id: 2, name: 'a kobold youth', revealed: true as const };

  it('keeps a body in your own room', () => {
    assert.deepEqual(nameable([here]), [here]);
  });

  it('drops a body you have only peeked at, so `kill` cannot reach through a wall', () => {
    assert.deepEqual(nameable([away]), []);
  });

  it('keeps the one and drops the other when both are visible', () => {
    assert.deepEqual(nameable([here, away]), [here]);
  });

  it('lets everything through when nothing has been peeked at', () => {
    const second = { id: 3, name: 'a rat' };
    assert.deepEqual(nameable([here, second]), [here, second]);
  });

  it('preserves order, because the ordinal in `2.kobold` counts down this list', () => {
    const second = { id: 4, name: 'a kobold youth' };
    assert.deepEqual(nameable([here, away, second]), [here, second]);
  });
});
