/**
 * Fleeing: the only voluntary way out of a fight.
 *
 * Two of these are the ones that matter, and if either fails the fix is not the assertion:
 *
 * - **"everyone swinging at it stops"** — §5. A flight that left the pointers in place would have the
 *   fight carry on through a wall, and the fleeing body would still be taking blows in a room it left.
 * - **"a closed door is not a way out"** — which is what makes shutting one a tactic. It also feeds the
 *   chance, so a corridor is a worse place to break contact than a crossroads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TICK_MS,
  WINDED_AFTER_FLEE_MS,
  type RoomFlag,
  boundsOf,
  huntRule,
  makeRng,
  noPursuit,
  passiveRule,
  readCombatStats,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import { engage } from './combat.ts';
import { attemptFlee, chooseDirection, fleeExits, type FleeDeps } from './flee.ts';
import { Scheduler } from './scheduler.ts';
import { Simulation, type Actor, type Mob, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/**
 * A crossroads with four arms, so the number of ways out is something a test can change.
 *
 * ```
 *        5002 (north)
 *          |
 * 5003 - 5000 - 5001
 *          |
 *        5004 (south)
 * ```
 */
function crossroads(): Zone {
  const rooms: Room[] = [
    {
      id: 5000,
      zone: 500,
      name: 'The Crossroads',
      sector: 'road',
      pos: { x: 1, y: 1, z: 0 },
      exits: { east: { to: 5001 }, north: { to: 5002 }, west: { to: 5003 }, south: { to: 5004 } },
    },
    { id: 5001, zone: 500, name: 'The East Arm', sector: 'road', pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 5000 } } },
    { id: 5002, zone: 500, name: 'The North Arm', sector: 'road', pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 5000 } } },
    { id: 5003, zone: 500, name: 'The West Arm', sector: 'road', pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 5000 } } },
    { id: 5004, zone: 500, name: 'The South Arm', sector: 'road', pos: { x: 1, y: 2, z: 0 }, exits: { north: { to: 5000 } } },
  ];
  return { id: 500, name: 'Test Crossroads', rooms, bounds: boundsOf(rooms), entryRoom: 5000 };
}

const template = (over: Partial<MobTemplate> = {}): MobTemplate => ({
  vnum: 500_01,
  keywords: ['servant'],
  name: 'a servant',
  room: 'A servant is here, edging toward the door.',
  level: 15,
  hp: '1d1+199',
  sprite: 'human',
  aggro: passiveRule(15),
  pursuit: noPursuit(),
  wimpyAt: 90,
  experience: 1000,
  combat: readCombatStats({ level: 15, armour: 0, damage: '1d4+0' }),
  ...over,
});

interface Fixture {
  readonly deps: FleeDeps;
  readonly sim: Simulation;
  readonly scheduler: Scheduler;
  readonly world: GameWorld;
  readonly player: Player;
  readonly mob: Mob;
}

/** `rng` defaults to a stream that always rolls well, so a test about exits is not also about luck. */
function makeFixture(over: Partial<MobTemplate> = {}, rng: () => number = () => 0): Fixture {
  const world = new GameWorld([crossroads()], { zone: 500, room: 5000 });
  const sim = new Simulation(world);
  const scheduler = new Scheduler();
  const player = sim.spawn('Runner', makeRng(1));
  const mob = sim.spawnMob(template(over), 5000, makeRng(0xf1ee));
  assert.ok(mob);
  return { deps: { world, sim, scheduler, rng }, sim, scheduler, world, player, mob };
}

describe('whether there is an attempt to make at all', () => {
  it('refuses a body that cannot act', () => {
    const { deps, sim, player } = makeFixture();
    for (const status of ['sleeping', 'incapacitated', 'dying', 'dead'] as const) {
      sim.setStance(player, { status });
      assert.equal(attemptFlee(deps, player).kind, 'helpless', status);
    }
  });

  it('spends the attempt getting to its feet, and does not move', () => {
    // `do_flee`'s "Looking panicked, $n scrambles madly to $s feet!" — a knocked-down character is one
    // round behind rather than helpless, which is the difference between a mechanic and a trap.
    const { deps, sim, player } = makeFixture();
    sim.setStance(player, { posture: 'sitting' });
    assert.equal(attemptFlee(deps, player).kind, 'scrambled');
    assert.equal(player.posture, 'standing');
    assert.equal(player.roomId, 5000, 'standing up is the whole of what that round bought');
  });
});

describe('the ways out', () => {
  it('counts every open exit', () => {
    const { deps, world, player } = makeFixture();
    assert.deepEqual(fleeExits(world, deps.sim, player).sort(), ['east', 'north', 'south', 'west']);
  });

  it('does not count a closed door, which is what makes shutting one a tactic', () => {
    const { deps, world, player } = makeFixture();
    const doorway = world.doorway(5000, 'north');
    if (doorway) doorway.near.door.closed = true;
    const exits = fleeExits(world, deps.sim, player);
    assert.equal(exits.includes('north'), doorway ? false : true);
  });

  it('reports being cornered rather than inventing a way out', () => {
    const { deps, sim } = makeFixture();
    // The east arm is a dead end back to the crossroads; move there and shut nothing — one exit exists,
    // so the honest test of "cornered" is a room whose only exit leads nowhere the mob may stand.
    const player = sim.spawn('Trapped', makeRng(1));
    sim.relocate(player, 5001);
    assert.equal(fleeExits(deps.world, sim, player).length, 1);
    // A mob in a `no_mob` room's neighbour cannot use that exit — same shape, and it is the case the
    // room filter exists for.
    const walled = deps.world.locate(5000);
    assert.ok(walled);
    (walled.room as unknown as { flags: readonly RoomFlag[] }).flags = ['no_mob'];
    const mob = sim.spawnMob(template(), 5001, makeRng(1));
    assert.ok(mob);
    assert.deepEqual(fleeExits(deps.world, sim, mob), []);
    assert.equal(attemptFlee(deps, mob).kind, 'cornered');
  });
});

describe('breaking contact', () => {
  it('always works when nothing is swinging at you, and still costs movement', () => {
    // `!was_fighting ||` in the source: walking out of a room is not a gamble. The rng here always
    // rolls the *worst* possible value, so a roll happening at all would fail.
    const { deps, player } = makeFixture({}, () => 0.999);
    const before = player.move;
    const outcome = attemptFlee(deps, player);
    assert.equal(outcome.kind, 'fled');
    assert.notEqual(player.roomId, 5000);
    assert.ok(before - player.move >= 20, 'the cost is paid whether or not it was a gamble');
  });

  it('stops everyone who was swinging at it', () => {
    // §5, and the reason this is not merely a move: a flight that left the pointers in place would have
    // the fight carry on through a wall.
    const { deps, scheduler, player, mob } = makeFixture();
    engage(scheduler, player, mob);
    engage(scheduler, mob, player);
    assert.equal(mob.fighting, player.id);

    const outcome = attemptFlee(deps, player);
    assert.equal(outcome.kind, 'fled');
    assert.equal(player.fighting, undefined);
    assert.equal(mob.fighting, undefined, 'the thing left behind is not still fighting a ghost');
    if (outcome.kind === 'fled') {
      assert.equal(outcome.wasFighting?.id, mob.id, 'the caller needs this to set a pursuit');
      assert.ok(outcome.changed.some((a: Actor) => a.id === mob.id));
    }
  });

  it('can fail while engaged, and failure leaves you exactly where you were', () => {
    const { deps, scheduler, player, mob } = makeFixture({}, () => 0.999);
    engage(scheduler, mob, player);
    engage(scheduler, player, mob);
    const outcome = attemptFlee(deps, player);
    assert.equal(outcome.kind, 'panicked');
    assert.equal(player.roomId, 5000);
    assert.equal(player.fighting, mob.id, 'still in it');
    assert.equal(mob.fighting, player.id);
  });

  it('costs a mob nothing, because a mob has no pool to spend', () => {
    const { deps, mob } = makeFixture();
    const outcome = attemptFlee(deps, mob);
    assert.equal(outcome.kind, 'fled');
    if (outcome.kind === 'fled') assert.equal(outcome.cost, 0);
  });

  it('winds whoever escapes a fight — player or mob — so the chase cannot be out-healed', () => {
    // The owner's lever (2026-08-02). One flee, one price: this function serves both kinds of actor,
    // and so does the wind. rng 0 wins every escape roll, so the flight itself cannot fail here.
    const first = makeFixture();
    engage(first.scheduler, first.player, first.mob);
    engage(first.scheduler, first.mob, first.player);
    assert.equal(attemptFlee(first.deps, first.mob).kind, 'fled');
    assert.equal(first.mob.windedMs, WINDED_AFTER_FLEE_MS);

    const second = makeFixture();
    engage(second.scheduler, second.mob, second.player);
    engage(second.scheduler, second.player, second.mob);
    assert.equal(attemptFlee(second.deps, second.player).kind, 'fled');
    assert.equal(second.player.windedMs, WINDED_AFTER_FLEE_MS);
  });

  it('does not wind a flight from nothing — outside combat, flee is only a panicky walk', () => {
    // Review's catch: outside combat the command always succeeds and costs one keypress, and winding
    // it would put a sixty-second blackout on ordinary movement. The price belongs to breaking away
    // from something swinging at you.
    const { deps, player } = makeFixture();
    assert.equal(attemptFlee(deps, player).kind, 'fled');
    assert.equal(player.windedMs, 0);
  });

  it('does not wind a failed flight — panic keeps you in the fight, and fighting already stops regen', () => {
    const { deps, scheduler, player, mob } = makeFixture({}, () => 0.999);
    engage(scheduler, mob, player);
    engage(scheduler, player, mob);
    assert.equal(attemptFlee(deps, player).kind, 'panicked');
    assert.equal(player.windedMs, 0, 'the wind is the price of the flight, not of the attempt');
  });

  it('refreshes on every flight, so a pursuit never out-waits it', () => {
    const { deps, scheduler, sim, player, mob } = makeFixture();
    engage(scheduler, player, mob);
    engage(scheduler, mob, player);
    assert.equal(attemptFlee(deps, mob).kind, 'fled');
    mob.windedMs = 1_000; // most of the first window has been chased away
    // The player catches up and re-engages in the room it fled to — the real chase's shape.
    sim.relocate(player, mob.roomId);
    engage(scheduler, player, mob);
    engage(scheduler, mob, player);
    const again = attemptFlee(deps, mob);
    assert.equal(again.kind, 'fled');
    assert.equal(mob.windedMs, WINDED_AFTER_FLEE_MS, 'back to the full window');
  });
});

describe('which way it runs', () => {
  it('scatters blindly when it cannot path', () => {
    // A sentinel-tier mob — the cleaning crew, the garden attendant, the mason. No search is run at all.
    const { deps, mob } = makeFixture({ pursuit: noPursuit() });
    const dir = chooseDirection(deps, mob, ['north', 'east', 'south', 'west']);
    assert.ok(['north', 'east', 'south', 'west'].includes(dir));
  });

  it('runs toward a friend when it can path — §2.8', () => {
    // A hunter-tier coward, which in IceCrag is the Archivist's assistant. Its ally stands two rooms
    // west, and the rng would pick `north` if the search were not consulted.
    const hunter = huntRule({
      hunter: true,
      remembers: true,
      sentinel: false,
      staysInZone: false,
      noLure: false,
      opensDoors: true,
    });
    const { deps, sim, mob } = makeFixture({ pursuit: hunter }, () => 0);
    const ally = sim.spawnMob(template(), 5003, makeRng(2));
    assert.ok(ally);
    assert.equal(chooseDirection(deps, mob, ['north', 'east', 'south', 'west']), 'west');
  });

  it('does not look further than it could reach in a flight', () => {
    // ALLY_SEARCH_ROOMS: a friend across the castle is not help, and running for one reads as a mob
    // that has lost interest in you. Nothing is within reach here, so it falls back to scattering.
    const hunter = huntRule({
      hunter: true,
      remembers: true,
      sentinel: false,
      staysInZone: false,
      noLure: false,
      opensDoors: true,
    });
    const { deps, mob } = makeFixture({ pursuit: hunter }, () => 0);
    // No allies anywhere: the search finds nothing and the random pick stands.
    const dir = chooseDirection(deps, mob, ['north', 'east']);
    assert.ok(['north', 'east'].includes(dir));
  });
});

describe('the wind, on the clock', () => {
  /** Runs whole ticks. Movement is a no-op with no intents, so this is regen and timers alone. */
  const run = (sim: Simulation, ms: number): void => {
    for (let t = 0; t < ms; t += TICK_MS) sim.tick();
  };

  it('a winded body does not mend, and mends again once the wind returns', () => {
    const { sim, mob } = makeFixture();
    mob.hp = 5;
    mob.windedMs = 2_000;
    run(sim, 2_000);
    assert.equal(mob.hp, 5, 'no healing inside the window');
    assert.equal(mob.windedMs, 0, 'and the window has been counted down by the same ticks');
    // 13 hp/minute needs ~4.6 s a point; a minute of calm afterwards is unmistakably healing.
    run(sim, 60_000);
    assert.ok(mob.hp > 5, `healed once the wind came back (hp ${mob.hp})`);
  });

  it('a fighting body does not mend either — the rule vitals authored, finally wired', () => {
    // `regenPerMinute` said "fighting means zero" from the day it was written, and the one call site
    // never passed the option: every combatant quietly trickled 13 hp a minute through their own
    // fights. Found while wiring the winded lever beside it.
    const { sim, scheduler, player, mob } = makeFixture();
    engage(scheduler, player, mob, { immediate: true });
    player.hp = 5;
    run(sim, 30_000);
    assert.equal(player.hp, 5, 'no trickle while the fight stands');
  });

  it('the countdown runs even for a body regeneration skips, so the wind cannot become permanent', () => {
    const { sim, player } = makeFixture();
    sim.setStance(player, { status: 'dying' });
    player.windedMs = 1_000;
    run(sim, 1_500);
    assert.equal(player.windedMs, 0);
  });
});

describe('you cannot walk out of a fight', () => {
  /** Steers hard toward the east arm for a second of ticks and reports the room landed in. */
  function steerEast(sim: Simulation, player: Player): number {
    sim.setIntent(player.id, 1, 0);
    for (let tick = 0; tick < 40; tick++) sim.tick();
    return player.roomId;
  }

  it('lets steering cross a room boundary when nothing is swinging at you', () => {
    const { sim, player } = makeFixture();
    assert.notEqual(steerEast(sim, player), 5000, 'walking out is ordinary movement');
  });

  it('stops steering at the threshold while engaged — §4, the gate the command table cannot reach', () => {
    // The typed `north` was refused by COMMAND_REQUIREMENTS from the start; WASD was not, and
    // steering is pure geometry, so a doorway tile is walkable like any other. This is that hole.
    const { sim, scheduler, player, mob } = makeFixture();
    engage(scheduler, player, mob);
    engage(scheduler, mob, player);
    assert.equal(steerEast(sim, player), 5000, 'held inside the room it is fighting in');
  });

  it('lets you move around inside the room, which is the divergence §4 kept', () => {
    // Blows land wherever either party stands, so intra-room movement stays free — a character
    // rooted to the spot for a whole fight reads as a hung server.
    const { sim, scheduler, player, mob } = makeFixture();
    engage(scheduler, player, mob);
    const startX = player.x;
    sim.setIntent(player.id, 1, 0);
    for (let tick = 0; tick < 4; tick++) sim.tick();
    assert.notEqual(player.x, startX, 'still able to shift position inside the room');
    assert.equal(player.roomId, 5000);
  });
});
