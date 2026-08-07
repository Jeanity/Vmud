/**
 * Phase 19 slice 5 — deep water priced, boats exempting, and the wash-ashore rules.
 *
 * The contracts pinned: the surcharge is the dead drain's curve and falls with the skill, a swim aid
 * removes exactly the surcharge and nothing else, and a body comes ashore at its **entry shore**
 * before anywhere nearer — the owner's anti-ferry rule, which is the difference between drowning
 * being a tragedy and being a ticket.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, makeRng, swimSurcharge, type Room, type Zone } from '@mygame/shared';

import { shoreFor } from './corpses.ts';
import { Simulation } from './sim.ts';
import { GameWorld } from './world.ts';

/** A jetty, three rooms of open water, and the far bank — the smallest ocean worth drowning in. */
function lakeZone(): Zone {
  const room = (id: number, x: number, sector: Room['sector'], exits: Room['exits']): Room =>
    ({ id, zone: 800, name: `Room ${id}`, sector, pos: { x, y: 0, z: 0 }, exits } as Room);
  const rooms: Room[] = [
    room(8000, 0, 'field', { east: { to: 8001 } }),
    room(8001, 1, 'deep_water', { west: { to: 8000 }, east: { to: 8002 } }),
    room(8002, 2, 'deep_water', { west: { to: 8001 }, east: { to: 8003 } }),
    room(8003, 3, 'deep_water', { west: { to: 8002 }, east: { to: 8004 } }),
    room(8004, 4, 'field', { west: { to: 8003 } }),
  ];
  return { id: 800, name: 'A Cold Lake', rooms, bounds: boundsOf(rooms), entryRoom: 8000 };
}

function makeLake() {
  const world = new GameWorld([lakeZone()], { zone: 800, room: 8000 });
  const sim = new Simulation(world);
  const player = sim.spawn('Swimmer', makeRng(1));
  return { world, sim, player };
}

describe('the surcharge', () => {
  it('is the dead drain’s own curve: +4 at nothing, −1 per 25, +0 at mastery', () => {
    assert.equal(swimSurcharge(0), 4);
    assert.equal(swimSurcharge(24), 4);
    assert.equal(swimSurcharge(25), 3);
    assert.equal(swimSurcharge(75), 1);
    assert.equal(swimSurcharge(100), 0);
  });

  it('prices a stroke by skill, and a boat removes exactly the surcharge', () => {
    const { sim, player } = makeLake();

    // The unskilled stroke: the terrain rate plus the full surcharge.
    player.move = player.maxMove;
    assert.ok(sim.spendMove(player, 'field', 'deep_water'));
    const unskilled = player.maxMove - player.move;

    // The same stroke with a boat: the surcharge is gone and nothing else moved.
    player.move = player.maxMove;
    sim.setSwimAid(() => true);
    assert.ok(sim.spendMove(player, 'field', 'deep_water'));
    const boated = player.maxMove - player.move;
    assert.equal(unskilled - boated, swimSurcharge(1), 'level 1’s floor is 1% — the full surcharge');

    // Mastery closes most of the same gap without a boat.
    sim.setSwimAid(() => false);
    player.skills.set('swim', 95);
    player.move = player.maxMove;
    assert.ok(sim.spendMove(player, 'field', 'deep_water'));
    const mastered = player.maxMove - player.move;
    assert.equal(mastered - boated, swimSurcharge(95));
  });

  it('refuses the stroke the pool cannot cover', () => {
    const { sim, player } = makeLake();
    player.move = 1;
    assert.equal(sim.spendMove(player, 'field', 'deep_water'), false);
    assert.equal(player.move, 1, 'a refused step charges nothing');
  });

  it('never surcharges dry ground', () => {
    const { sim, player } = makeLake();
    player.move = player.maxMove;
    assert.ok(sim.spendMove(player, 'field', 'field'));
    const dry = player.maxMove - player.move;
    player.skills.set('swim', 95);
    player.move = player.maxMove;
    assert.ok(sim.spendMove(player, 'field', 'field'));
    assert.equal(player.maxMove - player.move, dry, 'the swim skill is about water, not walking');
  });
});

describe('the wash ashore', () => {
  const { sim } = makeLake();
  const roomOf = (id: number) => sim.room(id as Parameters<typeof sim.room>[0]);

  it('prefers the entry shore, however far, over the nearest bank', () => {
    // Died at 8003, one room from the far bank (8004) — but they swam in from 8000, and the owner's
    // rule says the bag does not cross the lake for the price of dying.
    assert.equal(shoreFor(8003 as never, roomOf, 8000 as never), 8000);
  });

  it('falls back to the nearest bank when no entry shore is known', () => {
    assert.equal(shoreFor(8003 as never, roomOf), 8004);
    assert.equal(shoreFor(8001 as never, roomOf), 8000);
  });

  it('ignores a preferred shore that is itself water', () => {
    // A stale entry shore pointing at open water must not strand the body there: the fallback runs,
    // and from 8002 the search reaches 8000 first (west before east, exit order).
    assert.equal(shoreFor(8002 as never, roomOf, 8001 as never), 8000);
  });

  it('gives up on an all-water world rather than inventing a beach', () => {
    const wet = (id: number) => {
      const room = roomOf(id);
      return room && room.sector === 'deep_water' ? room : undefined;
    };
    assert.equal(shoreFor(8002 as never, wet), undefined);
  });
});
