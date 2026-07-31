/**
 * Zone reset: the clock, the limits, and the two gotchas.
 *
 * The whole point of this suite is the claim in `REFERENCE-mud-mechanics.md` §4.9 — that reset **only
 * loads** — and the things that follow from it. Those are hard to see in a running game, because a zone
 * comes due once every seventy minutes and the interesting cases are steady-state ones. Here the clock is
 * advanced by hand and they are all reachable in a millisecond.
 *
 * Read in this order: the limits hold the population flat; a mob taken away leaves a hole its replacement
 * fills; nothing is ever despawned; and the lifespan is re-rolled every time so nothing repops on a
 * timetable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ZONE_TICK_MS,
  boundsOf,
  makeRng,
  noPursuit,
  readCombatStats,
  passiveRule,
  type MobTemplate,
  type ResetCommand,
  type Room,
  type Zone,
  type ZoneSpawns,
} from '@mygame/shared';

import { advanceZones, newZoneClock, rollLifespan, runReset } from './reset.ts';
import { Simulation, isMob } from './sim.ts';
import { GameWorld } from './world.ts';

function testZone(): Zone {
  const rooms: Room[] = [
    { id: 7000, zone: 700, name: 'The Guard Room', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 7001 } } },
    { id: 7001, zone: 700, name: 'The Hall', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 7000 } } },
  ];
  return { id: 700, name: 'Test Keep', rooms, bounds: boundsOf(rooms), entryRoom: 7000 };
}

const GUARD: MobTemplate = {
  vnum: 700_01,
  keywords: ['guard'],
  name: 'a guard',
  room: 'A guard stands here.',
  level: 5,
  hp: '1d1+19',
  sprite: 'human',
  aggro: passiveRule(5),
  pursuit: noPursuit(),
  combat: readCombatStats({ level: 5, armour: 0, damage: '1d4+0' }),
  experience: 500,
};
const COOK: MobTemplate = {
  vnum: 700_02,
  keywords: ['cook'],
  name: 'a cook',
  room: 'A cook is busy here.',
  level: 3,
  hp: '1d1+9',
  sprite: 'human',
  aggro: passiveRule(3),
  pursuit: noPursuit(),
  combat: readCombatStats({ level: 3, armour: 0, damage: '1d4+0' }),
  experience: 300,
};

const mob = (over: Partial<ResetCommand> = {}): ResetCommand => ({
  kind: 'mob',
  ifPrevious: false,
  what: GUARD.vnum,
  limit: 2,
  room: 7000,
  percent: 100,
  ...over,
});

function spawnsFor(resets: readonly ResetCommand[], over: Partial<ZoneSpawns> = {}): ZoneSpawns {
  return {
    zone: 700,
    source: 'test.wld',
    lifespanMin: 10,
    lifespanMax: 20,
    templates: [GUARD, COOK],
    resets,
    ...over,
  };
}

function makeSim(): { sim: Simulation; templates: Map<number, MobTemplate> } {
  const sim = new Simulation(new GameWorld([testZone()], { zone: 700, room: 7000 }));
  return { sim, templates: new Map([[GUARD.vnum, GUARD], [COOK.vnum, COOK]]) };
}

const rng = () => makeRng(0x5eed);

/* -------------------------------------------------------------------------- */

describe('reset only loads', () => {
  it('fills up to the limit and then stops, however often it runs', () => {
    // The whole convergence mechanic in one assertion: population is flat not because anything is cleared
    // away but because the limit refuses to be exceeded.
    const { sim, templates } = makeSim();
    const stream = rng();
    // Three commands for a vnum limited to two. The third has nowhere to go, first pass or hundredth.
    const clock = newZoneClock(spawnsFor([mob(), mob(), mob()]), stream);

    const first = runReset(sim, clock, templates, stream, true);
    assert.equal(first.spawned.length, 2);
    assert.equal(first.atLimit, 1);
    assert.equal(sim.countOf(GUARD.vnum), 2);

    for (let i = 0; i < 20; i++) {
      const again = runReset(sim, clock, templates, stream);
      assert.deepEqual(again.spawned, [], `pass ${i + 2} spawned something`);
      assert.equal(again.atLimit, 3);
    }
    assert.equal(sim.countOf(GUARD.vnum), 2, 'twenty resets later, still two');
  });

  it('never despawns, which is what makes luring cost something', () => {
    // §4.9's warning, as a test. A mob dragged into the next room is still alive, still counts, and its
    // replacement therefore does not appear — so what you took stays taken.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 1 })]), stream);
    runReset(sim, clock, templates, stream, true);

    const guard = [...sim.allActors()].find(isMob);
    assert.ok(guard);
    assert.equal(guard.roomId, 7000);

    // Lure it next door.
    sim.relocate(guard, 7001);
    assert.equal(sim.countOf(GUARD.vnum), 1, 'still alive, wherever it is');

    const after = runReset(sim, clock, templates, stream);
    assert.deepEqual(after.spawned, [], 'the limit is still met, so no replacement');
    assert.equal(sim.actorsIn(7000).filter(isMob).length, 0, 'and the guard room stays empty');
  });

  it('fills the hole once the lured mob is gone', () => {
    // The other half: the limit is a *count*, so removing the instance frees the slot. Nothing else has to
    // be told — no despawn pass, no bookkeeping.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 1 })]), stream);
    runReset(sim, clock, templates, stream, true);

    const guard = [...sim.allActors()].find(isMob);
    assert.ok(guard);
    sim.remove(guard.id);
    assert.equal(sim.countOf(GUARD.vnum), 0);

    const after = runReset(sim, clock, templates, stream);
    assert.equal(after.spawned.length, 1, 'the slot is free, so it is filled');
  });

  it('counts each vnum on its own', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(
      spawnsFor([mob({ limit: 1 }), mob({ what: COOK.vnum, limit: 3, room: 7001 })]),
      stream,
    );
    runReset(sim, clock, templates, stream, true);
    assert.equal(sim.countOf(GUARD.vnum), 1);
    assert.equal(sim.countOf(COOK.vnum), 1, 'one command, one instance — the limit is a ceiling not a quota');
  });

  it('ignores a command naming a template it does not have', () => {
    // A reset for a mob the harvest dropped — one of the five IceCrag races with no LPC body, say. It must
    // be a skip and not a crash, because that combination is the normal state of a partial source.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ what: 999_999 }), mob()]), stream);
    const outcome = runReset(sim, clock, templates, stream, true);
    assert.equal(outcome.spawned.length, 1, 'the known one still loads');
  });

  it('ignores a command for a room this server does not load', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ room: 4242 })]), stream);
    assert.deepEqual(runReset(sim, clock, templates, stream, true).spawned, []);
  });
});

describe('the percentage gate', () => {
  /**
   * §4.9's first subtler trap, and it is genuinely surprising: on a *timed* reset the source requires
   * `arg4 == 100`, so any lesser percentage never fires at all. Mob spawns are therefore deterministic in
   * practice and equipment is the random layer — which is the rare-drop mechanic, arrived at by accident.
   */
  it('never fires a sub-100% command on a timed reset', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ percent: 99, limit: 5 })]), stream);
    for (let i = 0; i < 50; i++) {
      assert.deepEqual(runReset(sim, clock, templates, stream).spawned, [], `pass ${i} fired`);
    }
    assert.equal(sim.countOf(GUARD.vnum), 0);
  });

  it('consults it only when the reset is forced', () => {
    // A forced pass is the only time the percentage means anything. At 100 it always loads.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ percent: 100, limit: 1 })]), stream);
    assert.equal(runReset(sim, clock, templates, stream, true).spawned.length, 1);
  });
});

describe('the chain cursor', () => {
  it('skips a chained command when the one before it did not fire', () => {
    // `if_flag` chains a command to the previous one's success. The first command here is at its limit
    // already, so the chained second must not load either.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(
      spawnsFor([mob({ limit: 1 }), mob({ limit: 1 }), mob({ what: COOK.vnum, ifPrevious: true })]),
      stream,
    );
    const outcome = runReset(sim, clock, templates, stream, true);
    assert.equal(sim.countOf(GUARD.vnum), 1, 'the second guard hit the limit');
    assert.equal(sim.countOf(COOK.vnum), 0, 'so the cook chained to it did not load');
    assert.equal(outcome.spawned.length, 1);
  });

  it('runs a chained command when the one before it did fire', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(
      spawnsFor([mob({ limit: 1 }), mob({ what: COOK.vnum, ifPrevious: true })]),
      stream,
    );
    runReset(sim, clock, templates, stream, true);
    assert.equal(sim.countOf(COOK.vnum), 1);
  });

  it('is not broken by a command it has no executor for', () => {
    // §4.9's second trap, in the shape it takes for us. An `equip` between two mob loads has no executor
    // yet — Phase 15 — and must not read as a failure: reimplement the chain naively and a 5% helmet
    // silently suppresses the sword below it.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(
      spawnsFor([
        mob({ limit: 1 }),
        { kind: 'equip', ifPrevious: true, what: 1234, limit: 0, room: 7000, percent: 50 },
        mob({ what: COOK.vnum, ifPrevious: true }),
      ]),
      stream,
    );
    runReset(sim, clock, templates, stream, true);
    assert.equal(sim.countOf(COOK.vnum), 1, 'the cook still loaded past the unimplemented equip');
  });
});

describe('the clock', () => {
  it('rolls a lifespan inside the zone’s own band', () => {
    const stream = rng();
    const spawns = spawnsFor([], { lifespanMin: 55, lifespanMax: 65 });
    const rolled = new Set<number>();
    for (let i = 0; i < 200; i++) rolled.add(rollLifespan(spawns, stream));
    for (const n of rolled) assert.ok(n >= 55 && n <= 65, `${n} outside 55-65`);
    assert.ok(rolled.size > 1, 'a band should not always produce the same answer');
  });

  it('honours a band a builder wrote as a single number', () => {
    const stream = rng();
    const fixed = spawnsFor([], { lifespanMin: 30, lifespanMax: 30 });
    for (let i = 0; i < 20; i++) assert.equal(rollLifespan(fixed, stream), 30);
  });

  it('re-rolls after every reset, so nothing repops on a timetable', () => {
    // The part that matters. A fixed lifespan would let a player set a watch by repop.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([], { lifespanMin: 10, lifespanMax: 40 }), stream);
    const seen = new Set<number>([clock.lifespan]);
    for (let i = 0; i < 40; i++) {
      runReset(sim, clock, templates, stream);
      assert.equal(clock.age, 0, 'a reset restarts the clock');
      seen.add(clock.lifespan);
    }
    assert.ok(seen.size > 1, `every lifespan came out the same: ${[...seen]}`);
  });

  it('advances on the simulation tick and fires only when due', () => {
    // The zone clock is 750 times slower than the sim's, so the fraction is carried. Round it away and the
    // age never advances at all — the same argument `accrue` makes about regeneration.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 4 })], { lifespanMin: 3, lifespanMax: 3 }), stream);

    // One zone tick short of due: nothing fires, but the age has moved.
    let fired = advanceZones(sim, [clock], templates, stream, ZONE_TICK_MS * 2);
    assert.deepEqual(fired, []);
    assert.equal(clock.age, 2);

    fired = advanceZones(sim, [clock], templates, stream, ZONE_TICK_MS);
    assert.equal(fired.length, 1, 'due at three ticks');
    assert.equal(clock.age, 0);
  });

  it('accumulates many small ticks into one zone tick', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([], { lifespanMin: 1, lifespanMax: 1 }), stream);
    // 100 ms at a time, which is the real simulation tick.
    let fired: unknown[] = [];
    for (let i = 0; i < ZONE_TICK_MS / 100; i++) {
      fired = advanceZones(sim, [clock], templates, stream, 100);
      if (fired.length > 0) break;
    }
    assert.equal(fired.length, 1, 'a zone tick assembled out of 750 simulation ticks');
  });
});

/**
 * Doors, and the lock a repop would otherwise put back.
 *
 * Load-time relaxation is only half of `LOCKS_HOLD` — a zone reset runs its `D` rows again every
 * seventy-five seconds, so a `resetDoor` that honoured `locked` would re-seal what load had opened.
 * IceCrag's first reset command is exactly that: the castle's front door, closed *and* locked. Without
 * the policy here the castle is walkable for 75 seconds after boot and then is not.
 */
describe('door resets', () => {
  /** Two rooms joined by a door that starts wide open, so a reset has something to change. */
  function doorZone(): Zone {
    const rooms: Room[] = [
      {
        id: 7000, zone: 700, name: 'The Guard Room', sector: 'inside', pos: { x: 0, y: 0, z: 0 },
        exits: { east: { to: 7001, door: { name: 'the castle door', closed: false, locked: false } } },
      },
      {
        id: 7001, zone: 700, name: 'The Hall', sector: 'inside', pos: { x: 1, y: 0, z: 0 },
        exits: { west: { to: 7000, door: { name: 'the castle door', closed: false, locked: false } } },
      },
    ];
    return { id: 700, name: 'Test Keep', rooms, bounds: boundsOf(rooms), entryRoom: 7000 };
  }

  function doorSim(): { sim: Simulation; world: GameWorld } {
    const world = new GameWorld([doorZone()], { zone: 700, room: 7000 });
    return { sim: new Simulation(world), world };
  }

  const door = (over: Partial<ResetCommand> = {}): ResetCommand => ({
    kind: 'door', ifPrevious: false, what: 0, limit: 0, room: 7000,
    percent: 100, direction: 'east', doorState: 'closed', ...over,
  });

  it('shuts a door the zone says is shut, both ends', () => {
    const { sim, world } = doorSim();
    assert.equal(sim.resetDoor(door()), true, 'something moved');
    const doorway = world.doorway(7000, 'east');
    assert.equal(doorway?.near.door.closed, true);
    assert.equal(doorway?.far?.door.closed, true);
  });

  it('shuts but does not lock, while no key exists', () => {
    // The line that keeps IceCrag open. `locked` in the zone file becomes closed-and-openable, so the
    // door is still an obstacle and still not a wall.
    const { sim, world } = doorSim();
    assert.equal(sim.resetDoor(door({ doorState: 'locked' })), true);
    const doorway = world.doorway(7000, 'east');
    assert.equal(doorway?.near.door.closed, true, 'still shut — the authored intent that survives');
    assert.equal(doorway?.near.door.locked, false, 'but openable');
    assert.equal(doorway?.far?.door.locked, false);
  });

  it('reports nothing moved when the door is already as authored', () => {
    // `runReset` counts what changed, and a steady-state zone changing nothing every 75 seconds is the
    // normal case — a door reset firing repeatedly must not read as activity.
    const { sim } = doorSim();
    assert.equal(sim.resetDoor(door({ doorState: 'locked' })), true, 'first run shuts it');
    assert.equal(sim.resetDoor(door({ doorState: 'locked' })), false, 'second run has nothing to do');
  });

  it('opens a door the zone says is open, however the players left it', () => {
    const { sim, world } = doorSim();
    sim.resetDoor(door({ doorState: 'closed' }));
    assert.equal(sim.resetDoor(door({ doorState: 'open' })), true);
    assert.equal(world.doorway(7000, 'east')?.near.door.closed, false);
  });
});
