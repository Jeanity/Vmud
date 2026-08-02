/**
 * Station-keeping: the fight moves with you.
 *
 * The one that matters most is the *negative*: **nothing here may become a range check.** This module
 * moves a body toward a fight it is already in, and Phase 6 is built on blows landing wherever either
 * party stands — so a mob that has not arrived yet must still be swinging, and the test that says so
 * lives in `combat.test.ts` where it can fail loudly. What is tested here is only the walking.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TILE_SIZE,
  boundsOf,
  makeRng,
  noPursuit,
  passiveRule,
  readCombatStats,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import { engage } from './combat.ts';
import { Scheduler } from './scheduler.ts';
import { Simulation, type Mob, type Player } from './sim.ts';
import { MELEE_STATION, advanceStations, atStation } from './station.ts';
import { GameWorld } from './world.ts';

/** One room with somewhere to walk to, and a second so "does not leave" has a place to fail into. */
function hall(): Zone {
  const rooms: Room[] = [
    { id: 7000, zone: 700, name: 'The Long Hall', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 7001 } } },
    { id: 7001, zone: 700, name: 'The Anteroom', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 7000 } } },
  ];
  return { id: 700, name: 'Test Hall', rooms, bounds: boundsOf(rooms), entryRoom: 7000 };
}

const template = (over: Partial<MobTemplate> = {}): MobTemplate => ({
  vnum: 700_01,
  keywords: ['brute'],
  name: 'a brute',
  room: 'A brute stands here, cracking its knuckles.',
  level: 20,
  hp: '1d1+999',
  sprite: 'human',
  aggro: passiveRule(20),
  pursuit: noPursuit(),
  wimpyAt: 0,
  experience: 100,
  combat: readCombatStats({ level: 20, armour: 0, damage: '1d4+0' }),
  ...over,
});

interface Fixture {
  readonly sim: Simulation;
  readonly world: GameWorld;
  readonly scheduler: Scheduler;
  readonly player: Player;
  readonly mob: Mob;
  /** Runs `ms` of station-keeping in tick-sized steps. */
  readonly run: (ms: number) => void;
}

function makeFixture(): Fixture {
  const world = new GameWorld([hall()], { zone: 700, room: 7000 });
  const sim = new Simulation(world);
  const scheduler = new Scheduler();
  const player = sim.spawn('Fighter');
  const mob = sim.spawnMob(template(), 7000, makeRng(0xb00));
  assert.ok(mob);
  return {
    sim,
    world,
    scheduler,
    player,
    mob,
    run: (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100) advanceStations(sim, world, 100);
    },
  };
}

/**
 * Anchors the mob on the player's spawn tile — the room centre — and stands the player off to one
 * side of it.
 *
 * Both ways round matter: a mob spawns on whichever tile the seeded roll gave it, which may be against
 * a wall, and a room is only nine tiles across. Working outward from the centre keeps every position in
 * these tests comfortably inside it, so a test about following is never accidentally a test about
 * walking into a wall.
 */
function standApart(player: Player, mob: Mob, tiles = 3): void {
  mob.x = player.x;
  mob.y = player.y;
  player.x = mob.x + TILE_SIZE * tiles;
}

describe('closing on what it is fighting', () => {
  it('walks to its station and stops there', () => {
    const { scheduler, player, mob, run } = makeFixture();
    standApart(player, mob);
    engage(scheduler, mob, player);

    run(3000);
    assert.equal(atStation(mob, player), true, 'arrived');
    const gap = Math.hypot(player.x - mob.x, player.y - mob.y);
    assert.ok(gap >= MELEE_STATION - 2, `stopped a tile off rather than standing on them (gap ${gap})`);
    assert.ok(gap <= MELEE_STATION + 2, `and did not stop short (gap ${gap})`);
  });

  it('follows when the target moves away — the fight moves with you', () => {
    const { scheduler, player, mob, run } = makeFixture();
    const centre = player.x;
    standApart(player, mob);
    engage(scheduler, mob, player);
    run(3000);
    assert.equal(atStation(mob, player), true);

    // Cross to the *other* side of the room — measured from the centre rather than from the mob, so
    // the walk stays inside nine tiles however far it has already followed.
    player.x = centre - TILE_SIZE * 3;
    assert.equal(atStation(mob, player), false, 'the gap opened');
    run(3000);
    assert.equal(atStation(mob, player), true, 'it came with you');
  });

  it('does not move at all when it has nobody to fight', () => {
    const { player, mob, run } = makeFixture();
    standApart(player, mob);
    const { x, y } = { x: mob.x, y: mob.y };
    run(2000);
    assert.equal(mob.x, x, 'a mob not in a fight stands where it was put');
    assert.equal(mob.y, y);
  });

  it('turns to face its target even when it is already at station', () => {
    const { sim, scheduler, player, mob, world } = makeFixture();
    engage(scheduler, mob, player);
    // Directly north of it and within reach: no closing to do, but a turn is owed.
    player.x = mob.x;
    player.y = mob.y - MELEE_STATION;
    mob.facing = 'south';
    const tick = advanceStations(sim, world, 100);
    assert.equal(mob.facing, 'north');
    assert.deepEqual(tick.moved, [], 'it did not need to move');
    assert.equal(tick.turned.length, 1, 'but the turn is reported, because facing is on the wire');
  });
});

describe('what holds it still', () => {
  it('leaves a body that has been put on the floor where it lies', () => {
    // The owner's rule, and what makes knocking something down worth doing. `canMove` is the same
    // authority that holds a sitting player still — when `bash` lands in Phase 19 it needs no code here.
    const { sim, scheduler, player, mob, run } = makeFixture();
    standApart(player, mob);
    engage(scheduler, mob, player);
    sim.setStance(mob, { posture: 'prone' });
    const { x } = { x: mob.x };

    run(3000);
    assert.equal(mob.x, x, 'it stayed down');
    assert.equal(atStation(mob, player), false);

    // And it resumes the moment it is up again, rather than needing the fight restarted.
    sim.setStance(mob, { posture: 'standing' });
    run(3000);
    assert.equal(atStation(mob, player), true);
  });

  it('will not follow out of the room', () => {
    // It cannot normally arise — the target is in this room by the time we get here — but a doorway
    // on the direct line would otherwise let a mob squeeze through while cornering somebody standing
    // in the threshold.
    const { sim, scheduler, player, mob, run } = makeFixture();
    engage(scheduler, mob, player);
    sim.relocate(player, 7001);
    const { x, y } = { x: mob.x, y: mob.y };
    run(3000);
    assert.equal(mob.x, x);
    assert.equal(mob.y, y);
    assert.equal(mob.roomId, 7000, 'still in the room the fight was in');
  });
});
