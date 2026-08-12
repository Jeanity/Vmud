/**
 * The hunt: which exit it takes, what turns it back, and when it gives up.
 *
 * Read the flag tests first — `REFERENCE-mud-mechanics.md` §4.11 is a list of ways to build a mob that
 * looks configured and is inert, and three of its four warnings are about exactly this branch. A HUNTER
 * without MEMORY that chases anyway, or a SENTINEL treated as immobile, would both pass a naive test suite
 * and be wrong in opposite directions.
 *
 * The rest is the room graph. The tick is driven by hand, so a chase that takes seconds in the game takes
 * none here and every boundary is exact.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PLAYER_SPEED,
  ROOM_TILES,
  TILE_SIZE,
  WORLD_SCALE,
  boundsOf,
  huntRule,
  isWalkableAt,
  makeRng,
  noPursuit,
  passiveRule,
  newAffect,
  readCombatStats,
  pursues,
  tileCentre,
  type MobTemplate,
  type PursuitRule,
  type Room,
  type RoomFlag,
  type Zone,
} from '@mygame/shared';

import { AMBLE_SPEED, HUNT_SPEED, PROVOKED_LEASH_ROOMS, PROVOKED_PATIENCE_MS, advanceHunts, beginHunt, beginWalkTo, effectivePursuit, firstStepToward, forgetQuarry, provokedLeash, wanderRoll, type Hunt } from './hunt.ts';
import { Simulation, type Mob, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A corridor of five rooms west to east, plus a side room off the middle one.
 *
 * ```
 *   9000 - 9001 - 9002 - 9003 - 9004
 *                   |
 *                 9005
 * ```
 *
 * The side room is what makes "routes around" testable: block 9002 and the only way east is gone, but
 * block nothing and there are two ways to reach 9005.
 */
function corridor(flags: Partial<Record<number, RoomFlag[]>> = {}): Zone {
  const room = (id: number, x: number, y: number, exits: Room['exits']): Room => ({
    id,
    zone: 900,
    name: `Room ${id}`,
    sector: 'inside',
    pos: { x, y, z: 0 },
    exits,
    ...(flags[id] ? { flags: flags[id] } : {}),
  });
  const rooms: Room[] = [
    room(9000, 0, 0, { east: { to: 9001 } }),
    room(9001, 1, 0, { west: { to: 9000 }, east: { to: 9002 } }),
    room(9002, 2, 0, { west: { to: 9001 }, east: { to: 9003 }, south: { to: 9005 } }),
    room(9003, 3, 0, { west: { to: 9002 }, east: { to: 9004 } }),
    room(9004, 4, 0, { west: { to: 9003 } }),
    room(9005, 2, 1, { north: { to: 9002 } }),
  ];
  return { id: 900, name: 'Test Corridor', rooms, bounds: boundsOf(rooms), entryRoom: 9000 };
}

/** A hunter with round numbers, so tick arithmetic is exact. */
const hunter = (over: Partial<PursuitRule> = {}): PursuitRule => ({
  ...huntRule({ hunter: true, remembers: true, sentinel: false, staysInZone: false, noLure: false, opensDoors: true }),
  trackRooms: 10,
  giveUpMs: 5_000,
  ...over,
});

const template = (pursuit: PursuitRule): MobTemplate => ({
  vnum: 900_01,
  keywords: ['wolf'],
  name: 'a dire wolf',
  room: 'A dire wolf watches you.',
  level: 20,
  hp: '1d1+99',
  sprite: 'human',
  aggro: passiveRule(20),
  pursuit,
  combat: readCombatStats({ level: 20, armour: 0, damage: '1d4+0' }),
  experience: 2000,
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
});

interface Fixture {
  readonly sim: Simulation;
  readonly world: GameWorld;
  readonly player: Player;
  readonly mob: Mob;
  readonly hunts: Map<number, Hunt>;
  /** Runs the pass `ticks` times at `ms` each and returns everything it reported. */
  readonly run: (ticks: number, ms?: number) => ReturnType<typeof advanceHunts>['events'][number][];
  /** Puts an actor in a room without any of the movement machinery. */
  readonly place: (who: Mob | Player, roomId: number) => void;
}

function makeFixture(pursuit: PursuitRule = hunter(), zone: Zone = corridor()): Fixture {
  const world = new GameWorld([zone], { zone: 900, room: 9000 });
  const sim = new Simulation(world);
  const player = sim.spawn('Quarry', makeRng(1));
  const mob = sim.spawnMob(template(pursuit), 9000, makeRng(0x51ee9));
  assert.ok(mob, 'the fixture mob must spawn');

  const hunts = new Map<number, Hunt>();
  const place = (who: Mob | Player, roomId: number) => {
    sim.relocate(who, roomId);
  };

  return {
    sim,
    world,
    player,
    mob,
    hunts,
    place,
    run: (ticks, ms = 100) => {
      const all: ReturnType<typeof advanceHunts>['events'][number][] = [];
      for (let i = 0; i < ticks; i++) all.push(...advanceHunts(sim, world, hunts, ms).events);
      return all;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The flags, and §4.11's traps                                                */
/* -------------------------------------------------------------------------- */

describe('the pace a mob keeps', () => {
  // The client picks a walk/jog/sprint clip from a body's *measured* speed (`client3d/anim.ts`), and
  // its thresholds are fractions of a player at full tilt. Those fractions are restated here as
  // literals rather than imported, because a server package must not depend on a renderer — so if
  // `anim.JOG_SPEED`'s 0.4 ever moves, this test is the thing that should be revisited with it.
  const FULL = PLAYER_SPEED * WORLD_SCALE;
  const JOG_THRESHOLD = FULL * 0.4;
  const SPRINT_THRESHOLD = FULL * 0.77;

  it('ambles at a human walking pace when it has nowhere urgent to be', () => {
    const amble = AMBLE_SPEED * WORLD_SCALE;
    assert.ok(Math.abs(amble - 1.5) < 1e-9, `${amble} m/s should be a walk`);
    // Inside the walk band with room to spare, not against its ceiling: a remote body is *eased*
    // toward its authoritative position, so the speed the client measures undershoots this one and
    // must not be allowed to land back on a boundary.
    assert.ok(amble < JOG_THRESHOLD * 0.85, 'an amble must not read as a jog');
  });

  it('still runs a chase down, because that rule was never about the animation', () => {
    // `pursuit.ts`: "a hunter gains on you. You cannot stroll away from one." Untouched by the amble.
    assert.ok(HUNT_SPEED > PLAYER_SPEED, 'a hunter must out-pace a fleeing player');
    assert.ok(HUNT_SPEED * WORLD_SCALE > SPRINT_THRESHOLD, 'and it should look like a run');
    assert.equal(AMBLE_SPEED * 4, HUNT_SPEED);
  });
});

describe('what makes a mob a hunter at all', () => {
  it('refuses to hunt without ACT_MEMORY, however loudly it is flagged HUNTER', () => {
    // §4.11's sharpest trap. The whole hunt branch in `mobact.c` is inside `if (IS_SET(act, ACT_MEMORY))`,
    // so a HUNTER without MEMORY just wanders — and a reader who assumes the bit means what it says
    // produces a mob that looks configured in the data and never moves in the game.
    const rule = huntRule({ hunter: true, remembers: false, sentinel: false, staysInZone: false, noLure: false, opensDoors: true });
    assert.equal(rule.tier, 'sentinel');
    assert.equal(pursues(rule), false);
  });

  it('hunts with both bits', () => {
    const rule = huntRule({ hunter: true, remembers: true, sentinel: false, staysInZone: false, noLure: false, opensDoors: true });
    assert.equal(rule.tier, 'relentless');
    assert.equal(pursues(rule), true);
  });

  it('treats SENTINEL as a zone leash, not as immobility', () => {
    // The other half of §4.11, and the opposite mistake: `ACT_SENTINEL` does not mean "will not move". The
    // source's line is `if ((SENTINEL || STAY_ZONE) && zone differs) return` — it hunts, inside its zone.
    const rule = huntRule({ hunter: true, remembers: true, sentinel: true, staysInZone: false, noLure: false, opensDoors: true });
    assert.equal(rule.tier, 'zone', 'a sentinel hunter still hunts');
    assert.equal(pursues(rule), true);
    assert.equal(rule.staysInZone, true);
  });

  it('reads STAY_ZONE the same way, because the source ORs them', () => {
    const rule = huntRule({ hunter: true, remembers: true, sentinel: false, staysInZone: true, noLure: false, opensDoors: true });
    assert.equal(rule.tier, 'zone');
    assert.equal(rule.staysInZone, true);
  });

  it('lets ACT2_NO_LURE opt out entirely', () => {
    const rule = huntRule({ hunter: true, remembers: true, sentinel: false, staysInZone: false, noLure: true, opensDoors: true });
    assert.equal(pursues(rule), false);
  });

  it('never starts a hunt for a mob that does not pursue', () => {
    const fixture = makeFixture(noPursuit());
    const started = beginHunt(fixture.hunts, fixture.mob, fixture.player);
    assert.equal(started, undefined);
    assert.equal(fixture.hunts.size, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Which exit                                                                  */
/* -------------------------------------------------------------------------- */

describe('choosing the exit', () => {
  it('takes the first step toward the quarry, not toward the wall', () => {
    const world = new GameWorld([corridor()], { zone: 900, room: 9000 });
    const step = firstStepToward(world, hunter(), 9000, 9004);
    assert.equal(step?.dir, 'east');
    assert.equal(step?.room, 9001, 'the room it steps into, not the destination');
    assert.equal(step?.rooms, 4, 'four rooms of distance');
  });

  it('turns down the side passage when that is where you went', () => {
    const world = new GameWorld([corridor()], { zone: 900, room: 9000 });
    const step = firstStepToward(world, hunter(), 9002, 9005);
    assert.equal(step?.dir, 'south');
  });

  it('answers nothing when it is already there', () => {
    const world = new GameWorld([corridor()], { zone: 900, room: 9000 });
    assert.equal(firstStepToward(world, hunter(), 9002, 9002), undefined);
  });

  it('stops looking past trackRooms', () => {
    // The leash and the cost bound in one number. Four rooms away with a three-room leash is unreachable,
    // and the mob has to be told that rather than walking hopefully in the right direction for ever.
    const world = new GameWorld([corridor()], { zone: 900, room: 9000 });
    assert.ok(firstStepToward(world, hunter({ trackRooms: 4 }), 9000, 9004), 'four rooms, four allowed');
    assert.equal(firstStepToward(world, hunter({ trackRooms: 3 }), 9000, 9004), undefined, 'one room too far');
  });
});

/* -------------------------------------------------------------------------- */
/* What turns it back                                                          */
/* -------------------------------------------------------------------------- */

describe('rooms a hunter will not enter', () => {
  it('routes around a no_mob room rather than stopping at it', () => {
    // `BFS_AVOID_NOMOB` is set on every hunt the source schedules. Removing the room from the graph rather
    // than refusing at the threshold is what lets a hunter take the long way round — and here there is no
    // long way, so the answer is "no path" rather than "walk into it and stick".
    const world = new GameWorld([corridor({ 9002: ['no_mob'] })], { zone: 900, room: 9000 });
    assert.equal(firstStepToward(world, hunter(), 9000, 9004), undefined);
    assert.ok(firstStepToward(world, hunter(), 9000, 9001), 'rooms on this side are still reachable');
  });

  it('respects a safe room, and only when the rule says to', () => {
    const world = new GameWorld([corridor({ 9002: ['safe'] })], { zone: 900, room: 9000 });
    assert.equal(firstStepToward(world, hunter(), 9000, 9004), undefined, 'sanctuary blocks the way');
    // §2.10's dragon: `respectsSafeRooms: false` walks straight through. Nothing the harvest produces does
    // this — it is the authored-encounter case — so this is the test that keeps the field honest.
    assert.ok(
      firstStepToward(world, hunter({ respectsSafeRooms: false }), 9000, 9004),
      'a creature that ignores sanctuary is not stopped by it',
    );
  });

  it('follows you through a portal that stays on this Place', () => {
    // **Changed in 15c, and the measurement is the argument.** Phase 6 refused `exit.portal` outright on
    // the reasoning that a portal *is* a Place change by definition. Of the 7,261 portals in the shipped
    // world most are not: they are same-level links the layout pass could not reconcile with the map's
    // coordinates, and 4,996 same-level exits are simply not axis-aligned with their destination.
    //
    // So the flag conflated "leads somewhere else entirely" with "the map cannot draw this", and
    // refusing on it meant a player could shake any pursuer by stepping through an ordinary door.
    // Harmless while portals were invisible; a discoverable exploit the moment 15c drew them.
    const zone = corridor();
    const rooms = zone.rooms.map((room) =>
      room.id === 9002 ? { ...room, exits: { ...room.exits, east: { to: 9003, portal: true } } } : room,
    );
    const world = new GameWorld([{ ...zone, rooms }], { zone: 900, room: 9000 });
    assert.ok(firstStepToward(world, hunter(), 9000, 9003), 'a portal on this Place is an ordinary door');
  });

  it('still refuses a portal that leaves the Place', () => {
    // The half that was always doing the real work. A crossing is caught by comparing the destination's
    // zone and level, portal flag or not — which is why dropping the flag check lost nothing.
    const near: Room[] = [
      { id: 9300, zone: 930, name: 'Home', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 9400, portal: true } } },
    ];
    const far: Room[] = [
      { id: 9400, zone: 940, name: 'Elsewhere', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: {} },
    ];
    const world = new GameWorld(
      [
        { id: 930, name: 'Near', rooms: near, bounds: boundsOf(near), entryRoom: 9300 },
        { id: 940, name: 'Far', rooms: far, bounds: boundsOf(far), entryRoom: 9400 },
      ],
      { zone: 930, room: 9300 },
    );
    assert.equal(firstStepToward(world, hunter(), 9300, 9400), undefined);
  });

  it('will not leave its own zone when leashed', () => {
    // Two zones joined by an ordinary exit. The leashed hunter refuses the crossing; the relentless one
    // would too — but for the *Place* reason, not this one — so the assertion is on the graph search.
    const near: Room[] = [
      { id: 9100, zone: 910, name: 'Home', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 9200 } } },
    ];
    const far: Room[] = [
      { id: 9200, zone: 920, name: 'Abroad', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { west: { to: 9100 } } },
    ];
    const world = new GameWorld(
      [
        { id: 910, name: 'Home Zone', rooms: near, bounds: boundsOf(near), entryRoom: 9100 },
        { id: 920, name: 'Away Zone', rooms: far, bounds: boundsOf(far), entryRoom: 9200 },
      ],
      { zone: 910, room: 9100 },
    );
    assert.equal(firstStepToward(world, hunter({ staysInZone: true }), 9100, 9200), undefined);
  });
});

/* -------------------------------------------------------------------------- */
/* The chase                                                                   */
/* -------------------------------------------------------------------------- */

describe('the chase itself', () => {
  it('walks the mob into the room you retreated to', () => {
    const fixture = makeFixture();
    fixture.place(fixture.player, 9001);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    assert.equal(fixture.mob.roomId, 9000, 'starts a room behind');

    // A room takes HUNT_STEP_MS; give it twice that plus the walk to the doorway.
    const events = fixture.run(60);
    const entered = events.filter((event) => event.kind === 'entered');
    assert.ok(entered.length >= 1, 'it came through the doorway');
    assert.equal(fixture.mob.roomId, 9001);
    assert.equal(entered[0]?.from, 9000);
    assert.equal(entered[0]?.to, 9001);
    assert.equal(entered[0]?.heading, 'east');
  });

  it('reports arrival once it shares the room, and stops there', () => {
    // The seam Phase 11 hangs `engage()` on. The hunt does not attack and must not: it has arrived, and
    // that is the whole of its job.
    const fixture = makeFixture();
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    const events = fixture.run(1);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, 'arrived');
    assert.ok(fixture.hunts.has(fixture.mob.id), 'still hunting — arriving is not giving up');
  });

  it('keeps following as the quarry keeps moving', () => {
    const fixture = makeFixture();
    fixture.place(fixture.player, 9001);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    fixture.run(60);
    assert.equal(fixture.mob.roomId, 9001, 'caught up to the first room');

    fixture.place(fixture.player, 9003);
    fixture.run(120);
    assert.equal(fixture.mob.roomId, 9003, 'and followed through two more');
  });

  it('gives up once the timer runs out with no route', () => {
    const fixture = makeFixture(hunter({ trackRooms: 1, giveUpMs: 1_000 }));
    fixture.place(fixture.player, 9004);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);

    const events = fixture.run(9, 100);
    assert.deepEqual(events.map((event) => event.kind), [], 'nothing yet at 900ms');
    const later = fixture.run(2, 100);
    assert.ok(later.some((event) => event.kind === 'gaveUp'));
    assert.equal(fixture.hunts.size, 0);
  });

  it('never gives up on time when the rule says null', () => {
    const fixture = makeFixture(hunter({ trackRooms: 1, giveUpMs: null }));
    fixture.place(fixture.player, 9004);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    const events = fixture.run(200, 1_000);
    assert.equal(events.filter((event) => event.kind === 'gaveUp').length, 0, '200 seconds later, still coming');
    assert.equal(fixture.hunts.size, 1);
  });

  it('drops the hunt when the quarry leaves the world', () => {
    const fixture = makeFixture();
    fixture.place(fixture.player, 9001);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    fixture.sim.remove(fixture.player.id);

    const events = fixture.run(1);
    assert.equal(events[0]?.kind, 'gaveUp');
    assert.equal(fixture.hunts.size, 0);
  });

  it('forgets a quarry on request, for the disconnect path', () => {
    const fixture = makeFixture();
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    assert.equal(fixture.hunts.size, 1);
    forgetQuarry(fixture.hunts, fixture.player.id);
    assert.equal(fixture.hunts.size, 0);
  });

  it('does not switch quarry when it notices somebody else', () => {
    // Target selection is a threat question and belongs to Phase 12. Switching on every fresh notice would
    // make the last person through the door always the victim, which is the opposite of holding aggro.
    const fixture = makeFixture();
    const second = fixture.sim.spawn('Someone Else', makeRng(1));
    fixture.place(fixture.player, 9001);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    beginHunt(fixture.hunts, fixture.mob, second);
    assert.equal(fixture.hunts.get(fixture.mob.id)?.quarry, fixture.player.id);
  });

  it('reports the mob as moved so its position can reach the client', () => {
    // The bug Phase 9 found, in its movement form: `entityMoved` was built from players only, so nothing a
    // mob did could be drawn. A chase nobody can see is not a chase.
    const fixture = makeFixture();
    fixture.place(fixture.player, 9001);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    const tick = advanceHunts(fixture.sim, fixture.world, fixture.hunts, 100);
    assert.deepEqual(tick.moved.map((mob) => mob.id), [fixture.mob.id]);
  });

  it('leaves a mob exactly where it was when it has nowhere to go', () => {
    const fixture = makeFixture(hunter({ trackRooms: 1 }));
    fixture.place(fixture.player, 9004);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    const x = fixture.mob.x;
    const y = fixture.mob.y;
    fixture.run(20);
    assert.equal(fixture.mob.x, x);
    assert.equal(fixture.mob.y, y);
  });
});

/* -------------------------------------------------------------------------- */
/* Sanity on the geometry                                                      */
/* -------------------------------------------------------------------------- */

describe('the mob stays on the map', () => {
  it('never walks outside the grid while chasing', () => {
    const fixture = makeFixture();
    fixture.place(fixture.player, 9004);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    const grid = fixture.world.grid(fixture.mob.place);
    assert.ok(grid);
    for (let i = 0; i < 200; i++) {
      advanceHunts(fixture.sim, fixture.world, fixture.hunts, 100);
      assert.ok(fixture.mob.x >= 0 && fixture.mob.x < grid.width * TILE_SIZE, `x off-grid at tick ${i}`);
      assert.ok(fixture.mob.y >= 0 && fixture.mob.y < grid.height * TILE_SIZE, `y off-grid at tick ${i}`);
    }
    assert.equal(fixture.mob.roomId, 9004, 'and got there');
  });

  it('stands on a walkable tile at every step', () => {
    const fixture = makeFixture();
    fixture.place(fixture.player, 9005);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    for (let i = 0; i < 200; i++) {
      advanceHunts(fixture.sim, fixture.world, fixture.hunts, 100);
      const tx = Math.floor(fixture.mob.x / TILE_SIZE);
      const ty = Math.floor(fixture.mob.y / TILE_SIZE);
      assert.ok(tx >= 0 && ty >= 0, `tile ${tx},${ty} at tick ${i}`);
    }
    assert.equal(fixture.mob.roomId, 9005, 'round the corner and down the side passage');
    // Sanity that the fixture geometry is what the test thinks: a room is ROOM_TILES across.
    assert.equal(ROOM_TILES, 9);
  });
});

/* -------------------------------------------------------------------------- */
/* Provocation — ranged slice 5                                                */
/* -------------------------------------------------------------------------- */

/**
 * The pull's two safety properties, which `DESIGN-ranged.md` demands tests for **before** the feature:
 * both are restrictions, and a restriction is invisible on the happy path. A sentinel that answers a
 * shot from two rooms away looks exactly like one answering from one room — until a player walks a
 * shopkeeper across a zone by shooting it rhythmically.
 */
describe('a provoked sentinel', () => {
  const provoke = (mob: Mob) =>
    mob.affects.push(newAffect({ type: 'provoked', durationMs: PROVOKED_PATIENCE_MS, context: String(mob.roomId) }));

  it('cannot be hunted into existence while unprovoked — the harvested rule still refuses', () => {
    const fixture = makeFixture(noPursuit());
    assert.equal(beginHunt(fixture.hunts, fixture.mob, fixture.player), undefined);
  });

  it('crosses one room to answer the shot, and arrival is what engagement hangs off', () => {
    const fixture = makeFixture(noPursuit());
    fixture.place(fixture.player, 9001);
    provoke(fixture.mob);
    assert.ok(beginHunt(fixture.hunts, fixture.mob, fixture.player), 'provocation must open the gate beginHunt refused above');
    const events = fixture.run(60);
    assert.ok(events.some((e) => e.kind === 'entered' && e.to === 9001), 'it walks the one room');
    assert.ok(events.some((e) => e.kind === 'arrived'), 'and arrives, which is what the tick engages off');
  });

  it('can be kited down the corridor — the owner\'s caster-to-the-no-magic-room tactic', () => {
    // Re-ruled 2026-08-09: the one-room cap became a five-room leash. The kite: the player stays one
    // room ahead and the provoked sentinel keeps coming, because the leash is measured from its post
    // and the whole corridor is inside it.
    const fixture = makeFixture(noPursuit());
    provoke(fixture.mob);
    beginHunt(fixture.hunts, fixture.mob, fixture.player, provokedLeash(fixture.world, 9000));
    for (const room of [9001, 9002, 9003, 9004]) {
      fixture.place(fixture.player, room);
      const events = fixture.run(60);
      assert.ok(events.some((e) => e.kind === 'arrived'), `it keeps coming: room ${room} is inside the leash`);
    }
    assert.equal(fixture.mob.roomId, 9004, 'four rooms from its post, still on the leash');
  });

  it('**stops at the leash** — the sixth room from its post might as well be another world', () => {
    // A corridor two rooms longer than the leash, so the fence itself is testable.
    // The fixture spawns at zone 900, room 9000 — so the line lives there, two rooms longer than
    // the leash so the fence itself is testable.
    const room = (id: number, x: number, exits: Room['exits']): Room => ({
      id, zone: 900, name: `Line ${id}`, sector: 'inside', pos: { x, y: 0, z: 0 }, exits,
    });
    const rooms: Room[] = [];
    for (let i = 0; i <= PROVOKED_LEASH_ROOMS + 1; i++) {
      rooms.push(room(9000 + i, i, {
        ...(i > 0 ? { west: { to: 9000 + i - 1 } } : {}),
        ...(i < PROVOKED_LEASH_ROOMS + 1 ? { east: { to: 9000 + i + 1 } } : {}),
      }));
    }
    const zone: Zone = { id: 900, name: 'The Long Line', rooms, bounds: boundsOf(rooms), entryRoom: 9000 };
    const fixture = makeFixture(noPursuit(), zone);
    const leash = provokedLeash(fixture.world, 9000);

    // The fence itself: exactly the ball of radius five, and not the room beyond.
    assert.ok(leash.has(9000 + PROVOKED_LEASH_ROOMS), 'the fifth room is reachable');
    assert.ok(!leash.has(9000 + PROVOKED_LEASH_ROOMS + 1), 'the sixth is not — a kite is not a tow');

    // And the walk honours it: kite to the edge, then one room further finds nobody following.
    provoke(fixture.mob);
    beginHunt(fixture.hunts, fixture.mob, fixture.player, leash);
    for (let i = 1; i <= PROVOKED_LEASH_ROOMS; i++) {
      fixture.place(fixture.player, 9000 + i);
      fixture.run(60);
    }
    assert.equal(fixture.mob.roomId, 9000 + PROVOKED_LEASH_ROOMS, 'kited to the edge of the leash');
    fixture.place(fixture.player, 9000 + PROVOKED_LEASH_ROOMS + 1);
    const beyond = fixture.run(120);
    assert.ok(!beyond.some((e) => e.kind === 'arrived'), 'the room past the leash is never arrived in');
    assert.equal(fixture.mob.roomId, 9000 + PROVOKED_LEASH_ROOMS, 'it stands at the fence');
  });

  it('keeps a real tracker at its own reach — max, not plus one', () => {
    const fixture = makeFixture(hunter({ trackRooms: 10 }));
    provoke(fixture.mob);
    assert.equal(effectivePursuit(fixture.mob).trackRooms, 10);
  });

  it('stops the moment the anger lapses, whatever its own giveUpMs says', () => {
    const fixture = makeFixture(noPursuit());
    fixture.place(fixture.player, 9001);
    provoke(fixture.mob);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    fixture.mob.affects.splice(0); // the expiry pass, abbreviated
    const events = fixture.run(10);
    assert.ok(events.some((e) => e.kind === 'gaveUp'), 'a hunt whose permission expired is over');
    assert.equal(fixture.hunts.size, 0);
  });

  it('walks home without arriving at anybody — coming home engages nothing', () => {
    const fixture = makeFixture(noPursuit());
    fixture.place(fixture.mob, 9001);
    beginWalkTo(fixture.hunts, fixture.mob, 9000);
    const events = fixture.run(60);
    assert.ok(events.some((e) => e.kind === 'entered' && e.to === 9000), 'the walk back is watchable');
    assert.ok(!events.some((e) => e.kind === 'arrived'), 'and silent: no arrival event, so nothing engages');
    assert.equal(fixture.hunts.size, 0, 'home ends the hunt');
  });

  it('settles a few steps inside the room instead of standing in the doorway', () => {
    // Owner-reported: walks that ended the tick the room id flipped left every wanderer parked on
    // the border it came through, and a field of them read as through-traffic. The walk now hands
    // over to a short settle-shuffle along its own heading.
    const fixture = makeFixture(noPursuit());
    fixture.place(fixture.mob, 9001);
    beginWalkTo(fixture.hunts, fixture.mob, 9000);
    const grid = fixture.world.grid(fixture.mob.place);
    assert.ok(grid);
    const origin = grid.roomOrigins.get(9000);
    assert.ok(origin, 'room 9000 has an origin');
    fixture.run(120);
    assert.equal(fixture.hunts.size, 0, 'the settle itself also ends');
    assert.equal(fixture.mob.roomId, 9000, 'and ends where the walk was going');
    // Walking west out of 9001, the border crossed is 9000's east edge; settled means measurably
    // clear of it, not flush against it.
    const eastEdge = tileCentre(origin.tx + ROOM_TILES - 1);
    assert.ok(
      fixture.mob.x < eastEdge - TILE_SIZE,
      `settled ${eastEdge - fixture.mob.x}px inside — more than a tile clear of the doorway`,
    );
  });
});

/**
 * The wedge: routed by the graph, refused by the tiles. The regression here held a room's worth of
 * kobold youths — the stall clock below the route step was reset by the route step, every tick, so a
 * walker pinned against a wall never aged and never died, and the overgrown field's corners each
 * collected a permanent crowd. The clock now resets only on motion, and these hold that shape.
 */
describe('the wedged walker', () => {
  /** Parks the mob's pixels in the solid tile north of its room, where `stepMovement` refuses all. */
  const wedge = (fixture: Fixture): void => {
    const grid = fixture.world.grid(fixture.mob.place);
    assert.ok(grid, 'the fixture zone has a grid');
    const origin = grid.roomOrigins.get(9000);
    assert.ok(origin, 'room 9000 has an origin');
    const x = tileCentre(origin.tx);
    const y = tileCentre(origin.ty - 1);
    assert.equal(isWalkableAt(grid, x, y), false, 'the tile north of the room is wall, or this test tests nothing');
    fixture.mob.x = x;
    fixture.mob.y = y;
  };

  it('a stroll pinned by the tiles gives up in three seconds, not thirty', () => {
    const fixture = makeFixture(noPursuit());
    wedge(fixture);
    beginWalkTo(fixture.hunts, fixture.mob, 9001);
    fixture.run(29);
    assert.equal(fixture.hunts.size, 1, 'still leaning on the wall at 2.9s');
    const events = fixture.run(2);
    assert.equal(fixture.hunts.size, 0, 'gone at 3.1s — a stroll was going nowhere in particular anyway');
    assert.equal(events.filter((e) => e.kind === 'gaveUp').length, 0, 'and silently: strolls announce nothing');
  });

  it('a wedged chase ages to its own give-up instead of living for ever', () => {
    // The immortality regression itself: the route east exists every single tick, so the old reset
    // wiped the stall clock every single tick, and this hunt outlived the heat death of the zone.
    const fixture = makeFixture(hunter({ giveUpMs: 5_000 }));
    fixture.place(fixture.player, 9002);
    beginHunt(fixture.hunts, fixture.mob, fixture.player);
    wedge(fixture);
    fixture.run(49);
    assert.equal(fixture.hunts.size, 1, 'patient to 4.9s — a chase keeps its rule');
    const events = fixture.run(2);
    assert.equal(fixture.hunts.size, 0, 'dead at 5.1s, not immortal');
    assert.equal(events.filter((e) => e.kind === 'gaveUp').length, 1, 'and it says so');
  });

  it('motion resets the clock, so a stall survived is not a stall accrued', () => {
    const fixture = makeFixture(noPursuit());
    const grid = fixture.world.grid(fixture.mob.place);
    assert.ok(grid);
    const origin = grid.roomOrigins.get(9000);
    assert.ok(origin);
    const freeX = tileCentre(origin.tx + Math.floor(ROOM_TILES / 2));
    const freeY = tileCentre(origin.ty + Math.floor(ROOM_TILES / 2));
    wedge(fixture);
    beginWalkTo(fixture.hunts, fixture.mob, 9001);
    fixture.run(20);
    assert.equal(fixture.hunts.size, 1, 'two seconds of wall is under the patience');
    fixture.mob.x = freeX;
    fixture.mob.y = freeY;
    const events = fixture.run(200);
    assert.ok(events.some((e) => e.kind === 'entered' && e.to === 9001), 'freed, the walk finishes — the old stall did not linger on the clock');
    assert.equal(fixture.hunts.size, 0);
  });
});


/* -------------------------------------------------------------------------- */
/* The wander — Phase 8¾                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `mobact.c:7530-7551`, held still. The roll is injected, so every face is testable without
 * statistics; the memory is the caller's, so the anti-backtrack contract is explicit.
 */
describe('the wander roll', () => {
  it('takes an existing door', () => {
    const fixture = makeFixture(noPursuit());
    const step = wanderRoll(fixture.world, fixture.mob, 1, undefined, () => false); // face 1 = east
    assert.deepEqual(step, { dir: 'east', room: 9001 });
  });

  it('stays put on the seventh face and on a door that does not exist', () => {
    const fixture = makeFixture(noPursuit());
    assert.equal(wanderRoll(fixture.world, fixture.mob, 6, undefined, () => false), undefined);
    assert.equal(wanderRoll(fixture.world, fixture.mob, 3, undefined, () => false), undefined); // no west from 9000
  });

  it('refuses the door it took last pulse — the anti-backtrack', () => {
    const fixture = makeFixture(noPursuit());
    assert.equal(wanderRoll(fixture.world, fixture.mob, 1, 'east', () => false), undefined);
    // And the caller clears the memory on a refusal, so the same door works the pulse after.
    assert.ok(wanderRoll(fixture.world, fixture.mob, 1, undefined, () => false));
  });

  it('refuses a closed door — CAN_GO, the gate whose absence wedged the mound youths', () => {
    const fixture = makeFixture(noPursuit());
    assert.equal(wanderRoll(fixture.world, fixture.mob, 1, undefined, () => true), undefined);
  });

  it('refuses a no_mob destination — the same wall the hunts respect', () => {
    const zone = corridor({ 9001: ['no_mob'] });
    const fixture = makeFixture(noPursuit(), zone);
    assert.equal(wanderRoll(fixture.world, fixture.mob, 1, undefined, () => false), undefined);
  });
});
