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
  type ItemTemplate,
  type MobTemplate,
  type ResetCommand,
  type Room,
  type Zone,
  type ZoneSpawns,
} from '@mygame/shared';

import { MAX_MOB_KIT_ARMOUR, advanceZones, newZoneClock, rollLifespan, runReset } from './reset.ts';
import { Simulation, isMob } from './sim.ts';
import { GameWorld } from './world.ts';

function testZone(): Zone {
  const rooms: Room[] = [
    { id: 7000, zone: 700, name: 'The Guard Room', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 7001 } } },
    { id: 7001, zone: 700, name: 'The Hall', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 7000 } } },
  ];
  return { id: 700, name: 'Test Keep', rooms, bounds: boundsOf(rooms), entryRoom: 7000 };
}

/**
 * No catalogue, for the tests that are about spawning rather than about kit.
 *
 * A real empty map rather than a stub: a world whose `data/world/items.json` is absent is a world the
 * server genuinely runs in — `loadItemCatalogue` returns exactly this — so these tests exercise the
 * shipped path rather than a special case.
 */
const NO_ITEMS: ReadonlyMap<number, ItemTemplate> = new Map();

/** Nothing exists anywhere — the census a world with no objects in it answers. */
const NO_OBJECTS = () => 0;

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
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
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
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
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

    const first = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
    assert.equal(first.spawned.length, 2);
    assert.equal(first.atLimit, 1);
    assert.equal(sim.countOf(GUARD.vnum), 2);

    for (let i = 0; i < 20; i++) {
      const again = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream);
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
    runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);

    const guard = [...sim.allActors()].find(isMob);
    assert.ok(guard);
    assert.equal(guard.roomId, 7000);

    // Lure it next door.
    sim.relocate(guard, 7001);
    assert.equal(sim.countOf(GUARD.vnum), 1, 'still alive, wherever it is');

    const after = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream);
    assert.deepEqual(after.spawned, [], 'the limit is still met, so no replacement');
    assert.equal(sim.actorsIn(7000).filter(isMob).length, 0, 'and the guard room stays empty');
  });

  it('fills the hole once the lured mob is gone', () => {
    // The other half: the limit is a *count*, so removing the instance frees the slot. Nothing else has to
    // be told — no despawn pass, no bookkeeping.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 1 })]), stream);
    runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);

    const guard = [...sim.allActors()].find(isMob);
    assert.ok(guard);
    sim.remove(guard.id);
    assert.equal(sim.countOf(GUARD.vnum), 0);

    const after = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream);
    assert.equal(after.spawned.length, 1, 'the slot is free, so it is filled');
  });

  it('counts each vnum on its own', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(
      spawnsFor([mob({ limit: 1 }), mob({ what: COOK.vnum, limit: 3, room: 7001 })]),
      stream,
    );
    runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
    assert.equal(sim.countOf(GUARD.vnum), 1);
    assert.equal(sim.countOf(COOK.vnum), 1, 'one command, one instance — the limit is a ceiling not a quota');
  });

  it('ignores a command naming a template it does not have', () => {
    // A reset for a mob the harvest dropped — one of the five IceCrag races with no LPC body, say. It must
    // be a skip and not a crash, because that combination is the normal state of a partial source.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ what: 999_999 }), mob()]), stream);
    const outcome = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
    assert.equal(outcome.spawned.length, 1, 'the known one still loads');
  });

  it('ignores a command for a room this server does not load', () => {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ room: 4242 })]), stream);
    assert.deepEqual(runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true).spawned, []);
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
      assert.deepEqual(runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream).spawned, [], `pass ${i} fired`);
    }
    assert.equal(sim.countOf(GUARD.vnum), 0);
  });

  it('consults it only when the reset is forced', () => {
    // A forced pass is the only time the percentage means anything. At 100 it always loads.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ percent: 100, limit: 1 })]), stream);
    assert.equal(runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true).spawned.length, 1);
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
    const outcome = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
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
    runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
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
    runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
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
      runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream);
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
    let fired = advanceZones(sim, [clock], templates, NO_ITEMS, NO_OBJECTS, stream, ZONE_TICK_MS * 2);
    assert.deepEqual(fired, []);
    assert.equal(clock.age, 2);

    fired = advanceZones(sim, [clock], templates, NO_ITEMS, NO_OBJECTS, stream, ZONE_TICK_MS);
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
      fired = advanceZones(sim, [clock], templates, NO_ITEMS, NO_OBJECTS, stream, 100);
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

/* -------------------------------------------------------------------------- */

/**
 * A mob's kit — Phase 15c's `G` and `E`.
 *
 * These are the commands that were being deleted by the harvest until 15c: `arg3` on an `E` is the wear
 * position, not a room, and looking it up as one dropped all 16,263 of them. Now that they arrive, this
 * is what they have to do.
 */
describe('a mob gets its kit', () => {
  const SWORD: ItemTemplate = {
    vnum: 91_000, keywords: ['sword'], name: 'a short sword', roomLine: 'A sword lies here.',
    type: 5, slot: 'mainHand', ac: 0, damage: { count: 2, sides: 6, bonus: 0 }, size: 2, cost: 50, stackLimit: 1,
  };
  const PURSE: ItemTemplate = {
    vnum: 91_001, keywords: ['purse'], name: 'a small purse', roomLine: 'A purse lies here.',
    type: 12, ac: 0, size: 1, cost: 5, stackLimit: 1,
  };
  const BELT: ItemTemplate = {
    vnum: 91_002, keywords: ['belt'], name: 'a leather belt', roomLine: 'A belt lies here.',
    type: 11, slot: 'chest', ac: 1, size: 1, cost: 5, stackLimit: 1,
  };
  const ITEMS: ReadonlyMap<number, ItemTemplate> = new Map([
    [SWORD.vnum, SWORD], [PURSE.vnum, PURSE], [BELT.vnum, BELT],
  ]);

  const give = (what: number): ResetCommand => ({ kind: 'give', ifPrevious: true, what, limit: 1, percent: 100 });
  const equip = (what: number, wearPosition: number): ResetCommand =>
    ({ kind: 'equip', ifPrevious: true, what, limit: 1, wearPosition, percent: 100 });

  function kitted(resets: readonly ResetCommand[]) {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 1 }), ...resets]), stream);
    const outcome = runReset(sim, clock, templates, ITEMS, NO_OBJECTS, stream, true);
    const guard = [...sim.allActors()].find(isMob);
    return { outcome, guard };
  }

  it('wields what an E command puts in its hand', () => {
    const { outcome, guard } = kitted([equip(SWORD.vnum, 16)]);
    assert.equal(outcome.kitted, 1);
    assert.equal(guard?.equipped.mainHand?.name, 'a short sword', 'position 16 is PRIMARY_WEAPON');
  });

  it('carries what a G command gives it', () => {
    const { guard } = kitted([give(PURSE.vnum)]);
    assert.deepEqual(guard?.carrying.map((i) => i.name), ['a small purse']);
    assert.deepEqual(guard?.equipped, {}, 'given is not worn');
  });

  it('takes the slot from the command, not from the item', () => {
    // `E`'s third argument is where the *builder* put it, which is a different fact from where it may
    // go. A belt whose template says `chest` but whose command says position 6 goes on the head, because
    // the zone file is the authority on what this particular mob is wearing.
    const { guard } = kitted([equip(BELT.vnum, 6)]);
    assert.equal(guard?.equipped.head?.name, 'a leather belt');
    assert.equal(guard?.equipped.chest, undefined);
  });

  it('puts a belt on the waist, which we model since Phase 16', () => {
    // **Position 13 is `WEAR_WAIST`, and this test used to assert we had nowhere to put it.** Phase 16
    // modelled Duris' whole humanoid slot list — owner's call — which recovered 308 of the 315 `E`
    // placements that were falling into mobs' hands. The belt is one of them; the waist was the single
    // biggest gap in the world at 94 commands.
    const { guard } = kitted([equip(BELT.vnum, 13)]);
    assert.equal(guard?.equipped.waist?.name, 'a leather belt');
    assert.deepEqual(guard?.carrying.map((i) => i.name), []);
  });

  it('still holds a piece for a body we do not have, rather than destroying it', () => {
    // What is left is barding and tails — positions that need a mount or a race, not a row in a table.
    // The item is real and worth taking off the corpse either way, so it goes into the mob's hands.
    const { guard } = kitted([equip(BELT.vnum, 35)]);
    assert.deepEqual(guard?.carrying.map((i) => i.name), ['a leather belt'], 'WEAR_HORSE_BODY');
  });

  it('keeps loading a mob’s kit after one piece fails', () => {
    // §4.9's cursor rule, and the reason `lastMob` is separate from `lastSucceeded`: a sword that is not
    // in the catalogue must not suppress the boots below it.
    const { outcome, guard } = kitted([equip(999_999, 16), equip(SWORD.vnum, 16), give(PURSE.vnum)]);
    assert.equal(outcome.kitted, 2, 'the missing one, and only it, was skipped');
    assert.equal(guard?.equipped.mainHand?.name, 'a short sword');
    assert.deepEqual(guard?.carrying.map((i) => i.name), ['a small purse']);
  });

  it('re-tunes the mob’s armour from what it is wearing — 16c reversed 15c here', () => {
    // **This test used to assert the opposite, and the reversal is the point.** 15c refused to fold
    // worn armour into a mob's AC because zone 36 alone has 247 `E` commands and doing it silently
    // during an inventory phase would have invalidated 14b's balance pass without anybody noticing.
    // Phase 16 *is* the balance pass, so it is decided rather than tuned around — and the source folds
    // it in, `equip_char` running the same `affect_modify` for a mob as for a player.
    //
    const before = readCombatStats({ level: 5, armour: 0, damage: '1d4+0' });
    const { guard } = kitted([equip(BELT.vnum, 5)]);
    assert.equal(guard?.combat.armourClass, before.armourClass + BELT.ac, 'a guard in a leather belt');
  });

  it('leaves a mob no harder to hit for what it is only carrying', () => {
    // The other half, and the one that keeps the fold honest: `G` puts a thing in a mob's hands, and a
    // sword in your hands is not armour. It is also what happens to any `E` for a wear position we do
    // not model — the item is real and lootable, and it protects nothing.
    const before = readCombatStats({ level: 5, armour: 0, damage: '1d4+0' });
    const { guard } = kitted([give(BELT.vnum)]);
    assert.equal(guard?.combat.armourClass, before.armourClass);
    assert.deepEqual(guard?.carrying.map((i) => i.name), ['a leather belt']);
  });

  it('attaches nothing when no mob has been loaded', () => {
    // A zone file whose first command is an `E` is a builder's slip. It must be a skip, not a crash.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([equip(SWORD.vnum, 16)]), stream);
    const outcome = runReset(sim, clock, templates, ITEMS, NO_OBJECTS, stream, true);
    assert.equal(outcome.kitted, 0);
  });

  it('gives a mob nothing when the world has no catalogue at all', () => {
    // The shipped state through 15b, and still the state of a checkout with no `data/zones-source/`.
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor([mob({ limit: 1 }), equip(SWORD.vnum, 16)]), stream);
    const outcome = runReset(sim, clock, templates, NO_ITEMS, NO_OBJECTS, stream, true);
    assert.equal(outcome.kitted, 0);
    assert.equal(outcome.spawned.length, 1, 'and the mob still loads');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * `O` — objects on floors, and the limit that stops the world silting up.
 *
 * This is the command that waited longest, and not because it was hard to write: its `arg2` is a
 * *world-wide* cap on how many of a vnum exist, so it could not ship until something could count them.
 */
describe('objects the reset puts in rooms', () => {
  const LAMP: ItemTemplate = {
    vnum: 92_000, keywords: ['lamp'], name: 'a brass lamp', roomLine: 'A lamp sits here.',
    type: 1, ac: 0, size: 1, cost: 20, stackLimit: 1,
  };
  const ITEMS_O: ReadonlyMap<number, ItemTemplate> = new Map([[LAMP.vnum, LAMP]]);
  const object = (over: Partial<ResetCommand> = {}): ResetCommand =>
    ({ kind: 'object', ifPrevious: false, what: LAMP.vnum, limit: 1, room: 7000, percent: 100, ...over });

  function run(resets: readonly ResetCommand[], census: (vnum: number) => number = () => 0) {
    const { sim, templates } = makeSim();
    const stream = rng();
    const clock = newZoneClock(spawnsFor(resets), stream);
    return runReset(sim, clock, templates, ITEMS_O, census, stream, true);
  }

  it('asks for the object to be placed, rather than placing it', () => {
    // The executor decides *whether*; the caller decides where in the room. Same split `spawned` makes,
    // and it is what keeps the ground store out of this file.
    const outcome = run([object()]);
    assert.equal(outcome.objects.length, 1);
    assert.equal(outcome.objects[0]?.template.vnum, LAMP.vnum);
    assert.equal(outcome.objects[0]?.room, 7000);
  });

  it('refuses once the world already holds its limit', () => {
    // **The reason this command waited.** Without the census every repop adds another lamp to the same
    // table, and a zone left running overnight is ankle-deep.
    const outcome = run([object({ limit: 1 })], () => 1);
    assert.deepEqual(outcome.objects, []);
    assert.equal(outcome.atLimit, 1);
  });

  it('counts what it has already placed in the same pass', () => {
    // Two rows for one vnum at a limit of one. The census cannot see the first placement — it has not
    // happened yet — so the pass has to remember it itself.
    const outcome = run([object({ limit: 1 }), object({ limit: 1 })]);
    assert.equal(outcome.objects.length, 1, 'the second row is refused by the first');
  });

  it('fills up to the limit and no further', () => {
    const outcome = run([object({ limit: 3 }), object({ limit: 3 }), object({ limit: 3 }), object({ limit: 3 })]);
    assert.equal(outcome.objects.length, 3);
    assert.equal(outcome.atLimit, 1);
  });

  it('counts instances that are not on a floor', () => {
    // A lamp in somebody's bag still counts. That is what makes the limit *world-wide* rather than
    // per-room, and it is why the census walks bags, containers, corpses and mobs as well as the ground.
    assert.deepEqual(run([object({ limit: 2 })], () => 2).objects, []);
  });

  it('skips an object the catalogue does not have', () => {
    const outcome = run([object({ what: 999_999 }), object()]);
    assert.equal(outcome.objects.length, 1, 'the known one still lands');
  });

  it('does not break the chain for the commands below it', () => {
    // A successful `O` sets the cursor; a refused one clears it, the same as a refused `M`. What must
    // not happen is an `O` silently poisoning an unrelated mob spawn beneath it.
    const outcome = run([object(), mob({ limit: 1 })]);
    assert.equal(outcome.objects.length, 1);
    assert.equal(outcome.spawned.length, 1);
  });
});

describe('a mob in mail is harder to hit — 16c', () => {
  /** An armour piece the `E` executor can put on a chest, at whatever AC the test needs. */
  const armour = (vnum: number, ac: number): ItemTemplate => ({
    vnum,
    keywords: ['mail'],
    name: 'a suit of mail',
    roomLine: 'A suit of mail lies here.',
    type: 9,
    slot: 'chest',
    ac,
    size: 3,
    cost: 100,
    stackLimit: 1,
  });

  it('folds worn armour into the armour class, reversing 15c', () => {
    // 15c left a mob's kit as pure loot and said why. Phase 16 is the balance pass, so it is decided
    // rather than tuned around — and the source folds it in: `equip_char` runs the same
    // `affect_modify` for a mob as for a player.
    const { sim, templates } = makeSim();
    const items = new Map([[900, armour(900, 3)]]);
    const clock = newZoneClock(
      spawnsFor([mob(), { kind: 'equip', ifPrevious: true, what: 900, limit: 1, percent: 100, wearPosition: 5 }]),
      rng(),
    );
    const out = runReset(sim, clock, templates, items, NO_OBJECTS, rng(), true);
    const base = GUARD.combat.armourClass;
    assert.equal(out.spawned[0]!.combat.armourClass, base + 3, 'the guard is three points harder to hit');
  });

  it('caps the whole kit at one legendary piece, because of the quartermaster', () => {
    // A sentinel private in IceCrag is equipped with 34 pieces and would reach AC 94 — not an armoured
    // soldier but a man standing in his own stores, and at that armour class a natural 19 still misses.
    // Kobold Settlement, the zone actually played, tops out at +5, so this never bites where a
    // character currently goes.
    const { sim, templates } = makeSim();
    const items = new Map([[900, armour(900, 8)], [901, armour(901, 8)]]);
    const clock = newZoneClock(
      spawnsFor([
        mob(),
        { kind: 'equip', ifPrevious: true, what: 900, limit: 1, percent: 100, wearPosition: 5 },
        { kind: 'equip', ifPrevious: true, what: 901, limit: 1, percent: 100, wearPosition: 5 },
      ]),
      rng(),
    );
    const out = runReset(sim, clock, templates, items, NO_OBJECTS, rng(), true);
    const base = GUARD.combat.armourClass;
    assert.equal(out.spawned[0]!.combat.armourClass, base + MAX_MOB_KIT_ARMOUR, 'sixteen points offered, eight allowed');
  });
});

describe('P puts things inside the things O put down', () => {
  const chest: ItemTemplate = {
    vnum: 92_001, keywords: ['chest'], name: 'a wooden chest', roomLine: 'A chest sits here.',
    type: 15, ac: 0, size: 8, cost: 20, stackLimit: 1, container: { capacity: 20, accepts: 'any' },
  };
  const gem: ItemTemplate = {
    vnum: 92_002, keywords: ['gem'], name: 'a green gem', roomLine: 'A gem lies here.',
    type: 8, ac: 0, size: 1, cost: 500, stackLimit: 1,
  };
  const ITEMS2: ReadonlyMap<number, ItemTemplate> = new Map([[chest.vnum, chest], [gem.vnum, gem]]);
  const object = (what: number, room: number): ResetCommand =>
    ({ kind: 'object', ifPrevious: false, what, limit: 1, room: room as never, percent: 100 });
  const put = (what: number, container: number): ResetCommand =>
    ({ kind: 'put', ifPrevious: true, what, limit: 1, container, percent: 100 });

  it('hands back the contents as intentions, naming the container by vnum', () => {
    // `reset.ts` cannot name an instance — the ground store is not its business — so it reports the
    // container's vnum and lets the caller match it against what it has just placed. The same split
    // `objects` already makes, one level up.
    const { sim, templates } = makeSim();
    const clock = newZoneClock(spawnsFor([object(chest.vnum, 7000), put(gem.vnum, chest.vnum)]), rng());
    const out = runReset(sim, clock, templates, ITEMS2, NO_OBJECTS, rng(), true);
    assert.deepEqual(out.objects.map((o) => o.template.vnum), [chest.vnum]);
    assert.deepEqual(out.contents.map((c) => [c.template.vnum, c.container]), [[gem.vnum, chest.vnum]]);
  });

  it('refuses a container inside a container, wherever it is attempted', () => {
    // §4's depth rule is not only `put`'s. A zone file is authored by hand and this is the same refusal
    // `putRefusal` gives a player — a builder gets no exemption from a rule the game enforces.
    const { sim, templates } = makeSim();
    const clock = newZoneClock(spawnsFor([object(chest.vnum, 7000), put(chest.vnum, chest.vnum)]), rng());
    const out = runReset(sim, clock, templates, ITEMS2, NO_OBJECTS, rng(), true);
    assert.deepEqual(out.contents, []);
  });

  it('honours the world-wide instance limit, exactly as O does', () => {
    // Without this a chest gains another gem every repop and a zone left running overnight is a vault.
    const { sim, templates } = makeSim();
    const clock = newZoneClock(spawnsFor([object(chest.vnum, 7000), put(gem.vnum, chest.vnum)]), rng());
    const out = runReset(sim, clock, templates, ITEMS2, (vnum) => (vnum === gem.vnum ? 1 : 0), rng(), true);
    assert.deepEqual(out.contents, [], 'the one gem in the world is already somewhere');
    assert.ok(out.atLimit >= 1);
  });
});
