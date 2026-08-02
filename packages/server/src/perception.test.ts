/**
 * Perception: the delay, and the revalidation that makes it mean something.
 *
 * `REFERENCE-mud-mechanics.md` §4.5 names the risk precisely — the delay *"gets dropped as an optimisation
 * during implementation"* — so these are the tests that would fail if it ever were. Read the first two
 * first: a mob does not notice you instantly, and a mob does not notice you *after you have gone*. Every
 * other assertion here is a corollary of one of those.
 *
 * The tick is driven by hand, so a reaction that takes 1.5 seconds in the game takes no time here and the
 * boundary cases are exact rather than approximate.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  noPursuit,
  readCombatStats,
  AGGRO_RANGE_TILES,
  REACTION_BASE_MS,
  REACTION_FLOOR_MS,
  TICK_MS,
  TILE_SIZE,
  boundsOf,
  makeRng,
  matchesAggro,
  passiveRule,
  reactionFor,
  type AggroRule,
  type PursuitRule,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import { advancePerception, forgetTarget, newAwareness, perceives, type MobAwareness } from './perception.ts';
import { Simulation, type Mob, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

function testZone(): Zone {
  const rooms: Room[] = [
    { id: 6000, zone: 600, name: 'The Guard Post', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 6001 } } },
    { id: 6001, zone: 600, name: 'The Corridor', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 6000 } } },
  ];
  return { id: 600, name: 'Test Post', rooms, bounds: boundsOf(rooms), entryRoom: 6000 };
}

/** An aggressive rule with a round reaction, so tick arithmetic in the tests is exact. */
const hostile = (over: Partial<AggroRule> = {}): AggroRule => ({
  disposition: 'aggressive',
  clauses: ['all'],
  reactionMs: 1_000,
  remembers: true,
  sentinel: false,
  assists: false,
  ...over,
});

const templateWith = (aggro: AggroRule, pursuit: PursuitRule = noPursuit()): MobTemplate => ({
  pursuit,
  combat: readCombatStats({ level: 50, armour: 0, damage: '1d4+0' }),
  experience: 5000,
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
  vnum: 600_01,
  keywords: ['sentinel'],
  name: 'a vault sentinel',
  room: 'A vault sentinel stands watch.',
  level: 50,
  hp: '1d1+99',
  sprite: 'human',
  aggro,
});

interface Fixture {
  readonly sim: Simulation;
  readonly player: Player;
  readonly mob: Mob;
  readonly awareness: Map<number, MobAwareness>;
  /** Runs the pass `ticks` times and returns every notice it produced. */
  readonly run: (ticks: number) => { mob: Mob; target: Player; remembered: boolean }[];
}

function makeFixture(aggro: AggroRule = hostile()): Fixture {
  const sim = new Simulation(new GameWorld([testZone()], { zone: 600, room: 6000 }));
  const player = sim.spawn('Intruder');
  const mob = sim.spawnMob(templateWith(aggro), 6000, makeRng(1));
  assert.ok(mob, 'the fixture mob should have spawned');
  // Both on the same tile, so distance is never what these tests are about unless they say so.
  mob.x = player.x;
  mob.y = player.y;

  const awareness = new Map<number, MobAwareness>();
  const run = (ticks: number) => {
    const out: { mob: Mob; target: Player; remembered: boolean }[] = [];
    for (let i = 0; i < ticks; i++) out.push(...advancePerception(sim, awareness, TICK_MS));
    return out;
  };
  return { sim, player, mob, awareness, run };
}

/** Puts the player out of the mob's reach without leaving the room. */
const stepAway = (f: Fixture): void => {
  f.player.x = f.mob.x + (AGGRO_RANGE_TILES + 2) * TILE_SIZE;
};

/* -------------------------------------------------------------------------- */

describe('the delay', () => {
  it('does not notice on the tick you arrive', () => {
    // §4.5's whole point: a mob that reacts the frame you enter removes all skill from movement.
    const f = makeFixture();
    assert.deepEqual(f.run(1), []);
  });

  it('notices once the reaction has elapsed, and not before', () => {
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    // 1000 ms at a 100 ms tick is ten ticks. Nine is not enough.
    assert.deepEqual(f.run(9), [], 'nine ticks is 900 ms');
    const events = f.run(1);
    assert.equal(events.length, 1, 'the tenth tick reaches 1000 ms');
    assert.equal(events[0]!.target.id, f.player.id);
    assert.equal(events[0]!.mob.id, f.mob.id);
  });

  it('scales the reaction with level, because agility is not on the record', () => {
    // Duris derives the delay from the mob's own agility, which lives on the *enhanced* record — and every
    // mob in the loaded zones is the simple form. Level is the stand-in.
    assert.equal(reactionFor(0), REACTION_BASE_MS);
    assert.ok(reactionFor(60) < reactionFor(10), 'a captain is quicker than a scullion');
    assert.equal(reactionFor(1_000), REACTION_FLOOR_MS, 'and never instant, however high the level');
    // The floor is the load-bearing end: a room crosses in ~2.4 s, so even the sharpest mob can be run past.
    assert.ok(REACTION_FLOOR_MS > 0);
  });
});

describe('revalidation', () => {
  /**
   * The case the naive implementation gets wrong, and it is the reason the check happens on *firing* rather
   * than on scheduling: you step in, step straight out, and something decides to attack you retrospectively.
   */
  it('never notices somebody who left inside the window', () => {
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    f.run(9);
    stepAway(f);
    assert.deepEqual(f.run(20), [], 'the timer went with them');
  });

  it('starts the count again on a second approach rather than resuming', () => {
    // Two half-visits must not add up to one noticing. §2.2 is explicit that the *dwell* is the mechanic, and
    // a paused timer would quietly remove the tension it exists to create.
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    f.run(9);
    stepAway(f);
    f.run(1);
    f.player.x = f.mob.x;
    assert.deepEqual(f.run(9), [], 'nine more ticks is not eighteen');
    assert.equal(f.run(1).length, 1, 'it takes a full reaction again');
  });

  it('refuses a target the predicate does not object to', () => {
    // A mob that objects to elves, looking at somebody whose race the game does not model. `matchesAggro`
    // answers false for a clause it cannot evaluate, rather than assuming a default.
    const f = makeFixture(hostile({ clauses: ['evilRace'] }));
    assert.deepEqual(f.run(40), [], 'unknown means no');
  });

  it('never notices anything at all when passive', () => {
    const f = makeFixture(passiveRule(50));
    assert.deepEqual(f.run(40), []);
  });
});

describe('reach', () => {
  it('does not reach into the next room', () => {
    const f = makeFixture();
    f.player.roomId = 6001;
    assert.deepEqual(f.run(40), []);
  });

  it('does not reach across a large room', () => {
    // Six tiles of a nine-tile room, so the far corner is out — which is what makes a doorway worth pausing
    // in rather than every room being all-or-nothing.
    const f = makeFixture();
    stepAway(f);
    assert.equal(perceives(f.mob, f.player), false);
    assert.deepEqual(f.run(40), []);
  });

  it('reaches exactly as far as it says', () => {
    const f = makeFixture();
    f.player.x = f.mob.x + AGGRO_RANGE_TILES * TILE_SIZE;
    f.player.y = f.mob.y;
    assert.equal(perceives(f.mob, f.player), true, 'the boundary is inclusive');
    f.player.x += 1;
    assert.equal(perceives(f.mob, f.player), false);
  });
});

describe('memory', () => {
  it('reports the first notice as new and the next as remembered', () => {
    // Memory's one consumer today: the announcer says nothing the second time, because a mob repeating itself
    // every time somebody crosses a threshold is the nag the light warning's latch exists to prevent.
    const f = makeFixture(hostile({ reactionMs: 1_000, remembers: true }));
    const first = f.run(10);
    assert.equal(first.length, 1);
    assert.equal(first[0]!.remembered, false);

    stepAway(f);
    f.run(1);
    f.player.x = f.mob.x;
    const second = f.run(10);
    assert.equal(second.length, 1);
    assert.equal(second[0]!.remembered, true);
  });

  it('does not remember when its template says it does not', () => {
    // 56 of IceCrag's 61 templates carry `ACT_MEMORY`; the five that do not should announce every time.
    const f = makeFixture(hostile({ reactionMs: 1_000, remembers: false }));
    assert.equal(f.run(10)[0]!.remembered, false);
    stepAway(f);
    f.run(1);
    f.player.x = f.mob.x;
    assert.equal(f.run(10)[0]!.remembered, false, 'still news to it');
  });

  it('forgets a character who disconnects, because ids are reissued', () => {
    // Not tidiness: entity ids are handed out again, so a mob that remembered id 7 would silently already
    // know the next person given it.
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    f.run(10);
    forgetTarget(f.awareness, f.player.id);
    stepAway(f);
    f.run(1);
    f.player.x = f.mob.x;
    assert.equal(f.run(10)[0]!.remembered, false, 'a stranger again');
  });
});

describe('the predicate', () => {
  it('matches anyone on `all`, which is the only clause evaluable today', () => {
    assert.equal(matchesAggro(hostile({ clauses: ['all'] }), {}), true);
  });

  it('refuses every clause about something the game does not model', () => {
    for (const clause of ['goodAlign', 'neutralAlign', 'evilAlign', 'goodRace', 'evilRace'] as const) {
      assert.equal(matchesAggro(hostile({ clauses: [clause] }), {}), false, clause);
    }
  });

  it('evaluates a clause once the subject carries the fact', () => {
    // Phase 21 fills `subjectOf` in; this is the assertion that says the predicate is already right when it
    // does, rather than a structure waiting to be rewritten.
    assert.equal(matchesAggro(hostile({ clauses: ['evilAlign'] }), { alignment: -800 }), true);
    assert.equal(matchesAggro(hostile({ clauses: ['evilAlign'] }), { alignment: 0 }), false);
    assert.equal(matchesAggro(hostile({ clauses: ['goodAlign'] }), { alignment: 800 }), true);
    assert.equal(matchesAggro(hostile({ clauses: ['neutralAlign'] }), { alignment: 0 }), true);
    assert.equal(matchesAggro(hostile({ clauses: ['goodRace'] }), { raceBloc: 'good' }), true);
    assert.equal(matchesAggro(hostile({ clauses: ['goodRace'] }), { raceBloc: 'evil' }), false);
  });

  it('is a union — any clause matching is enough', () => {
    const rule = hostile({ clauses: ['goodRace', 'evilAlign'] });
    assert.equal(matchesAggro(rule, { raceBloc: 'good' }), true);
    assert.equal(matchesAggro(rule, { alignment: -900 }), true);
    assert.equal(matchesAggro(rule, { raceBloc: 'neutral', alignment: 0 }), false);
  });

  it('never initiates when passive, whatever its clauses say', () => {
    // The disposition is the outer question and the bits are the inner one, which is how the source reads.
    assert.equal(matchesAggro({ ...hostile({ clauses: ['all'] }), disposition: 'passive' }, {}), false);
  });
});

describe('the visible half', () => {
  it('turns the mob to face whoever it noticed', () => {
    // `facing` drives which of the four LPC sheet rows the client draws, so this is a real change on screen
    // rather than a log line claiming something happened.
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    f.mob.facing = 'north';
    f.player.x = f.mob.x;
    f.player.y = f.mob.y + 4 * TILE_SIZE; // due south of it
    const events = f.run(10);
    assert.equal(events.length, 1);
    assert.equal(f.sim.turnToward(f.mob, f.player.x, f.player.y), true, 'it was not already facing them');
    assert.equal(f.mob.facing, 'south');
  });

  it('answers false when it is already looking the right way', () => {
    // A fresh mob faces south, so the target is moved north of it to make the first turn a real one.
    const f = makeFixture();
    f.player.x = f.mob.x;
    f.player.y = f.mob.y - 4 * TILE_SIZE;
    assert.equal(f.sim.turnToward(f.mob, f.player.x, f.player.y), true);
    assert.equal(f.mob.facing, 'north');
    assert.equal(f.sim.turnToward(f.mob, f.player.x, f.player.y), false, 'no second broadcast');
  });
});

describe('awareness bookkeeping', () => {
  it('keeps nothing for a passive mob', () => {
    const f = makeFixture(passiveRule(50));
    f.run(40);
    assert.equal(f.awareness.size, 0, 'the common case allocates nothing');
  });

  it('notices once per approach, not once per reaction period', () => {
    // The bug this caught: clearing the timer on firing made it re-notice every reaction period for as long
    // as somebody stood in front of it. Noticing is a *transition*, so it is an edge — and the timer runs on
    // past the reaction precisely so the edge cannot come round again.
    const f = makeFixture(hostile({ reactionMs: 1_000 }));
    assert.equal(f.run(10).length, 1);
    assert.deepEqual(f.run(60), [], 'six more reaction periods, and it says nothing further');
    assert.equal(newAwareness().dwell.size, 0);
  });
});
