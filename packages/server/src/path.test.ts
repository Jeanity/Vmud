/**
 * Click-to-move: the server following a route, and the gate that decides where a route may go.
 *
 * Synthetic zones only, no generated data on disk — the engine must always be provable against a
 * world it did not import. The zone is three rooms in a row on level 0 plus one room on level 1, so
 * a route can be walked across a corridor, refused at the edge of what a character has seen, and
 * dropped by a change of Place.
 *
 * ## The gate under test
 *
 * `findPath` is given an `allowed` set of tile indices, and the whole of this change is what builds
 * it: **tiles this character has SEEN**, not rooms they have ENTERED. So the tests here describe a
 * character's history the way the server accumulates it — a light radius carried over the tiles they
 * stood on, unioned by {@link seenWalking} from the same `computeVisible` the server calls — rather
 * than as a list of room ids. A test that hand-listed tiles could not tell the difference between
 * the rule working and the rule being absent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  PLAYER_RADIUS,
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  TILE_SIZE,
  boundsOf,
  roomAtTile,
  type Room,
  type RoomId,
  type TileGrid,
  type TilePoint,
  type Zone,
} from '@mygame/shared';
import { makeRng } from '@mygame/shared';
import { findPath } from '@mygame/shared/pathfind.ts';
import { DEFAULT_LIGHT_RADIUS, bitsetToSet, computeVisible } from '@mygame/shared/vision.ts';

import { PlayerStore, type PlayerRecord } from './players.ts';
import { Simulation, type PathEnded, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Level 0 is 8001 — 8002 — 8003 west to east, each a `ROOM_TILES` square block on `ROOM_STRIDE`,
 * joined by carved corridors. 8004 sits on level 1 and is reachable only by relocate(), which is the
 * point of it.
 *
 * **Every tile coordinate in this file is derived from those constants rather than written out.**
 * `ROOM_GAP` is tuned against `DEFAULT_LIGHT_RADIUS` and has moved once already; a suite that spells
 * its geometry out in digits breaks in eleven places every time it does, and each break looks like a
 * bug in the code under test rather than a stale number in a fixture.
 *
 * At today's values (`ROOM_TILES` 9, `ROOM_GAP` 2, so `ROOM_STRIDE` 11) that puts the block origins
 * on tx 0, 11 and 22, their centre tiles on tx 4, 15 and 26 at ty 4, the corridor between 8001 and
 * 8002 on tx 9..10 and the one between 8002 and 8003 on tx 20..21, both spanning ty 3..5.
 */
function testZone(): Zone {
  const rooms: Room[] = [
    {
      id: 8001,
      zone: 800,
      name: 'West Glade',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 0 },
      exits: { east: { to: 8002 }, up: { to: 8004, portal: true } },
    },
    {
      id: 8002,
      zone: 800,
      name: 'Middle Glade',
      sector: 'forest',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 8001 }, east: { to: 8003 } },
    },
    {
      id: 8003,
      zone: 800,
      name: 'East Glade',
      sector: 'forest',
      pos: { x: 2, y: 0, z: 0 },
      exits: { west: { to: 8002 } },
    },
    {
      id: 8004,
      zone: 800,
      name: 'A High Branch',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 1 },
      exits: { down: { to: 8001, portal: true } },
    },
  ];
  return { id: 800, name: 'Test Glades', rooms, bounds: boundsOf(rooms), entryRoom: 8001 };
}

/* -------------------------------------------------------------------------- */
/* The fixture's geometry, derived                                             */
/* -------------------------------------------------------------------------- */

/** Tile-space origin of the room block in cell column `cell`. Every room here is on cell row 0. */
function blockTx(cell: number): number {
  return cell * ROOM_STRIDE;
}

/** Centre tile of that block. Blocks are square, so the same offset gives the centre row. */
function centreTx(cell: number): number {
  return blockTx(cell) + (ROOM_TILES - 1) / 2;
}

/** The row every room centre and every corridor of this fixture shares. */
const MID_TY = (ROOM_TILES - 1) / 2;

/** The three room centres, west to east: 8001, 8002, 8003. */
const WEST: TilePoint = { tx: centreTx(0), ty: MID_TY };
const MIDDLE: TilePoint = { tx: centreTx(1), ty: MID_TY };
const EAST: TilePoint = { tx: centreTx(2), ty: MID_TY };

/**
 * The far mouth of the corridor out of 8001: its last tile, one short of 8002's first floor column.
 * A corridor tile, so `roomAtTile` reports -1 for it and standing here is still standing in 8001.
 */
const MOUTH_TX = blockTx(1) - 1;

/**
 * The deepest tile the bare radius reaches from that mouth.
 *
 * It lands inside 8002 — asserted rather than assumed by the seen-gate tests below — because the
 * mouth sits one tile short of 8002's near column and a light of radius `r` reaches `r` tiles.
 */
const LIT_IN_MIDDLE: TilePoint = { tx: MOUTH_TX + DEFAULT_LIGHT_RADIUS, ty: MID_TY };

/**
 * The first row of void below every room block: floor stops at `ROOM_TILES` and the grid runs on to
 * `ROOM_STRIDE`. Nothing stands here, whatever light has fallen on it.
 */
const VOID_TY = ROOM_TILES;

function makeSim(): { world: GameWorld; sim: Simulation; player: Player } {
  const world = new GameWorld([testZone()], { zone: 800, room: null });
  const sim = new Simulation(world);
  return { world, sim, player: sim.spawn('Walker', makeRng(1)) };
}

/** World-pixel centre of a tile, the only place movement ever aims for. */
function centrePx(t: number): number {
  return t * TILE_SIZE + TILE_SIZE / 2;
}

function gridOf(world: GameWorld, player: Player): TileGrid {
  const grid = world.grid(player.place);
  assert.ok(grid, 'the fixture should have a grid for the place the player is standing on');
  return grid;
}

/** The tile a player is standing in. */
function tileOf(player: Player): TilePoint {
  return { tx: Math.floor(player.x / TILE_SIZE), ty: Math.floor(player.y / TILE_SIZE) };
}

/**
 * The `seen` set of a character who has walked the straight run of tiles from `a` to `b`.
 *
 * The union of the visible set at every tile they stood on — which is precisely how the server
 * accumulates `seen`, one tile-change at a time. Note what it is *not*: no room is ever mentioned,
 * and a room the character passed through is only seen as far as their light reached into it.
 */
function seenWalking(
  grid: TileGrid,
  a: TilePoint,
  b: TilePoint,
  radius: number = DEFAULT_LIGHT_RADIUS,
): Set<number> {
  const seen = new Set<number>();
  let { tx, ty } = a;
  for (;;) {
    for (const index of computeVisible(grid, tx, ty, radius)) seen.add(index);
    if (tx === b.tx && ty === b.ty) break;
    tx += Math.sign(b.tx - tx);
    ty += Math.sign(b.ty - ty);
  }
  return seen;
}

/** Plans a route the way `index.ts` does: this character's seen tiles, this Place's grid. */
function plan(world: GameWorld, player: Player, seen: ReadonlySet<number>, to: TilePoint) {
  const from = tileOf(player);
  return findPath({
    grid: gridOf(world, player),
    fromTx: from.tx,
    fromTy: from.ty,
    toTx: to.tx,
    toTy: to.ty,
    allowed: seen,
  });
}

/** The seen set of a character who has walked from where they spawned to where they are now. */
function seenSoFar(world: GameWorld, player: Player, from: TilePoint = WEST): Set<number> {
  return seenWalking(gridOf(world, player), from, tileOf(player));
}

interface Walk {
  readonly ended: PathEnded[];
  readonly transitions: { from: RoomId; to: RoomId }[];
  readonly ticks: number;
}

/** Ticks until the route ends, or gives up. The limit is a test failure, not a silent stop. */
function walkOut(sim: Simulation, limit = 400): Walk {
  const ended: PathEnded[] = [];
  const transitions: { from: RoomId; to: RoomId }[] = [];
  let ticks = 0;
  while (ticks < limit && ended.length === 0) {
    const result = sim.tick();
    ticks++;
    for (const t of result.transitions) transitions.push({ from: t.from, to: t.to });
    ended.push(...result.pathsEnded);
  }
  return { ended, transitions, ticks };
}

/**
 * Steers a player east under their own steam, accumulating `seen` exactly as the server's tick loop
 * does: refresh the lit set only when the tile changes, and union whatever it now holds.
 *
 * Deliberately end-to-end rather than a synthesised set of tiles. The claim being tested is that a
 * character who *walks up to a doorway* can then click through it, so the walking has to be real.
 */
function walkEastSeeing(sim: Simulation, player: Player, stopAtTx: number): Set<number> {
  const seen = new Set<number>();
  const absorb = (): void => {
    for (const index of player.visible) seen.add(index);
  };

  sim.refreshVisible(player);
  absorb();
  sim.setIntent(player.id, 1, 0);
  for (let i = 0; i < 400 && tileOf(player).tx < stopAtTx; i++) {
    sim.tick();
    if (sim.refreshVisible(player)) absorb();
  }
  sim.setIntent(player.id, 0, 0);
  assert.equal(tileOf(player).tx, stopAtTx, 'the walk should have reached the tile it was aimed at');
  return seen;
}

/* -------------------------------------------------------------------------- */
/* Following a route                                                           */
/* -------------------------------------------------------------------------- */

describe('path following', () => {
  it('walks a route to the clicked tile and reports arriving there', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok, 'a route across a corridor this character has seen should be found');

    sim.setPath(player, result.points);
    assert.equal(sim.hasPath(player), true);

    const walk = walkOut(sim);
    assert.deepEqual(
      walk.ended.map((e) => e.reason),
      ['arrived'],
    );
    // Exactly on the tile centre, not merely near it: the final step is clamped to the distance
    // remaining, so a follower lands on its waypoint instead of overshooting and orbiting it.
    assert.equal(player.x, centrePx(MIDDLE.tx));
    assert.equal(player.y, centrePx(MIDDLE.ty));
    assert.equal(sim.hasPath(player), false);
    assert.equal(player.roomId, 8002);
  });

  it('reports the room transition it walks through on the way', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(player, result.points);

    const walk = walkOut(sim);
    assert.deepEqual(walk.transitions, [{ from: 8001, to: 8002 }]);
  });

  it('covers exactly the same ground per tick as keyboard movement', () => {
    // The guard on "one movement code path". If click-to-move ever grows its own stepping, these two
    // drift apart and client-side prediction breaks for one of them.
    const { world, sim, player: manual } = makeSim();
    const clicker = sim.spawn('Clicker', makeRng(1));

    sim.setIntent(manual.id, 1, 0);
    const seen = seenWalking(gridOf(world, clicker), WEST, MIDDLE);
    const result = plan(world, clicker, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(clicker, result.points);

    for (let i = 0; i < 5; i++) sim.tick();
    assert.equal(clicker.x, manual.x);
    assert.equal(clicker.y, manual.y);
    assert.ok(clicker.x > centrePx(WEST.tx), 'both should have actually moved');
  });

  it('lets the route override a steer vector pointing the other way', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);

    // Steering set first, then a route: while the route lasts it is the authoritative intent.
    sim.setIntent(player.id, -1, 0);
    sim.setPath(player, result.points);

    const startX = player.x;
    for (let i = 0; i < 5; i++) sim.tick();
    assert.ok(player.x > startX, 'the route should win over the westward steer');
  });

  it('stops on arrival rather than resuming a steer held from before the click', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setIntent(player.id, -1, 0);
    sim.setPath(player, result.points);

    walkOut(sim);
    const restX = player.x;
    const restY = player.y;
    for (let i = 0; i < 10; i++) sim.tick();
    assert.equal(player.x, restX);
    assert.equal(player.y, restY);
  });
});

/* -------------------------------------------------------------------------- */
/* Giving up                                                                   */
/* -------------------------------------------------------------------------- */

describe('abandoning a route', () => {
  it('gives up rather than grinding into geometry forever', () => {
    const { sim, player } = makeSim();
    // Deliberately a route the pathfinder would never produce: every row from `ROOM_TILES` to the end
    // of the stride is void below a room block, so this waypoint is unreachable. The stuck detector
    // exists for exactly the case where the plan and the collision geometry disagree — and because an
    // active route overrides the player's own steering, a jam that never resolved would be one the
    // player could not escape.
    const goal: TilePoint = { tx: WEST.tx, ty: VOID_TY };
    sim.setPath(player, [goal]);

    const walk = walkOut(sim);
    assert.deepEqual(
      walk.ended.map((e) => e.reason),
      ['stuck'],
    );
    // The destination survives the waypoints being consumed, so the tile it gave up short of can be
    // named — the whole of the reproduction when a route and the geometry disagree.
    assert.deepEqual(walk.ended[0]?.goal, goal);
    assert.equal(sim.hasPath(player), false);
    assert.ok(
      player.y < centrePx(VOID_TY),
      'should have stopped against the wall, not passed through it',
    );
    assert.ok(walk.ticks < 40, 'should give up promptly, not after hundreds of ticks');
  });

  it('does not mistake sliding along a wall for being stuck', () => {
    const { sim, player } = makeSim();
    // Pressed against the south wall of the room block and sent south-east. The y component is
    // refused every tick while the x component goes through, so the mover covers ~97% of the step it
    // asked for along one axis and none along the other. That is real progress and must not read as
    // a jam — sliding is how movement gets around geometry in the first place, which is why the
    // stuck test is a fraction of the *requested* step and not an absolute distance.
    //
    // As far south as a half-box fits inside the room block: row `VOID_TY` is void, so the bottom of
    // the box may not reach `VOID_TY * TILE_SIZE`.
    const southEdgeY = VOID_TY * TILE_SIZE - PLAYER_RADIUS - 1;
    player.y = southEdgeY;
    // South-east into the void beyond the block's last row. Far enough east to be a shallow angle —
    // a real slide — and far enough south that the y component is refused every single tick.
    sim.setPath(player, [{ tx: MIDDLE.tx, ty: ROOM_STRIDE - 1 }]);

    const startX = player.x;
    // Comfortably more ticks than the stuck threshold, and fewer than the ~9 the slide lasts.
    for (let i = 0; i < 8; i++) sim.tick();

    assert.equal(sim.hasPath(player), true, 'sliding is progress, not a stall');
    assert.ok(player.x > startX, 'the unblocked axis should still be advancing');
    assert.equal(player.y, southEdgeY, 'the blocked axis should not have moved at all');
  });

  it('does not give up on a long walk that is simply taking a while', () => {
    const { world, sim, player } = makeSim();
    // The full width of the zone: three rooms and two corridors, some fifty ticks of walking. A
    // stuck detector that counted anything other than *consecutive* failures would fire in here.
    const seen = seenWalking(gridOf(world, player), WEST, EAST);
    const result = plan(world, player, seen, EAST);
    assert.ok(result.ok);
    sim.setPath(player, result.points);

    const walk = walkOut(sim);
    assert.deepEqual(
      walk.ended.map((e) => e.reason),
      ['arrived'],
    );
    assert.ok(walk.ticks > 40, 'the fixture should be long enough for this test to mean something');
    assert.deepEqual(walk.transitions, [
      { from: 8001, to: 8002 },
      { from: 8002, to: 8003 },
    ]);
    assert.equal(player.x, centrePx(EAST.tx));
  });

  it('drops the route when the player changes Place', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(player, result.points);

    assert.deepEqual(sim.relocate(player, 8004), { zone: 800, level: 1 });
    // Tile coordinates from level 0 name a different spot on level 1's grid — or none at all.
    assert.equal(sim.hasPath(player), false);
  });

  it('reports whether there was a route to clear, so the client is told only when it matters', () => {
    const { world, sim, player } = makeSim();
    assert.equal(sim.clearPath(player), false);

    const result = plan(world, player, seenSoFar(world, player, WEST), WEST);
    assert.ok(result.ok);
    sim.setPath(player, result.points);
    assert.equal(sim.clearPath(player), true);
    assert.equal(sim.clearPath(player), false);
    assert.equal(sim.hasPath(player), false);
  });

  it('treats an empty route as clearing rather than as a route', () => {
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(player, result.points);
    sim.setPath(player, []);
    assert.equal(sim.hasPath(player), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Taking manual control back                                                  */
/* -------------------------------------------------------------------------- */

describe('setIntent as the manual-control signal', () => {
  it('distinguishes a real push from a key release', () => {
    const { sim, player } = makeSim();
    assert.equal(sim.setIntent(player.id, 1, 0), true);
    assert.equal(sim.setIntent(player.id, 0, 0), false);
    // Answers after normalisation, so a sub-threshold nudge counts as a release too — otherwise a
    // client sending analogue noise would cancel every route the player laid down.
    assert.equal(sim.setIntent(player.id, 0.001, 0), false);
    assert.equal(sim.setIntent(player.id, 0, -1), true);
  });

  it('is false for an entity that is not here', () => {
    const { sim } = makeSim();
    assert.equal(sim.setIntent(999, 1, 0), false);
  });

  it('treats a malformed steer as a release rather than wedging the character', () => {
    // `{t:'steer'}` with the fields missing, or holding a string, reaches `setIntent` from the wire
    // as `NaN`. Read as a real push it would cancel the route below *and* defeat the tick loop's
    // idle skip (`!path && intentX === 0`, which `NaN === 0` fails), so the character would be
    // walked every tick for the rest of the session while never actually moving. See
    // `normaliseIntent` — the guard is there, and this is the behaviour that guard buys.
    const { world, sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, MIDDLE);
    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(player, result.points);

    for (const [dx, dy] of [[Number.NaN, Number.NaN], [undefined, undefined], ['east', 'north']] as const) {
      assert.equal(sim.setIntent(player.id, dx as number, dy as number), false);
    }
    assert.equal(sim.hasPath(player), true, 'nonsense must not cancel a route the player laid down');
    assert.equal(player.intentX, 0);
    assert.equal(player.intentY, 0);

    // And with the route cleared the character is genuinely idle: the tick reports no movement at
    // all, rather than reporting a mover who cannot move.
    sim.clearPath(player);
    const at = { x: player.x, y: player.y };
    for (let i = 0; i < 10; i++) assert.deepEqual(sim.tick().moved, []);
    assert.deepEqual({ x: player.x, y: player.y }, at);
  });
});

/* -------------------------------------------------------------------------- */
/* The seen gate                                                               */
/* -------------------------------------------------------------------------- */

describe('the seen gate on the server', () => {
  it('plots a route into a room the character has SEEN but never ENTERED', () => {
    // The bug this whole change exists to fix, end to end. The character walks east out of 8001 and
    // stops at the far mouth of the corridor — still in 8001 as far as the simulation is concerned,
    // because corridor tiles belong to no room. Their torch spills through the opening into 8002,
    // and those tiles are now clickable.
    const { world, sim, player } = makeSim();
    const seen = walkEastSeeing(sim, player, MOUTH_TX);
    const grid = gridOf(world, player);

    assert.equal(player.roomId, 8001, 'the character has not entered 8002');
    assert.equal(
      roomAtTile(grid, MOUTH_TX, MID_TY),
      -1,
      'they are standing in the corridor, which owns no room',
    );
    assert.equal(
      roomAtTile(grid, LIT_IN_MIDDLE.tx, LIT_IN_MIDDLE.ty),
      8002,
      'the target tile belongs to the room beyond',
    );
    assert.equal(
      seen.has(LIT_IN_MIDDLE.ty * grid.width + LIT_IN_MIDDLE.tx),
      true,
      'light should have spilled into 8002',
    );

    const into = plan(world, player, seen, LIT_IN_MIDDLE);
    assert.equal(into.ok, true, 'a tile lit through the doorway must be walkable to');
  });

  it('still refuses the far side of that room, so seeing in is not seeing across', () => {
    // The anti-speedrun property, which the old room-granular rule provided by accident and this one
    // has to provide on purpose. Light reaches DEFAULT_LIGHT_RADIUS tiles past the corridor mouth and
    // no further, so 8002's centre is as unreachable as it ever was — you can never reveal more than
    // one lit radius beyond your feet.
    const { world, sim, player } = makeSim();
    const seen = walkEastSeeing(sim, player, MOUTH_TX);
    const grid = gridOf(world, player);

    assert.equal(seen.has(MIDDLE.ty * grid.width + MIDDLE.tx), false, '8002s centre is out of the light');
    const across = plan(world, player, seen, MIDDLE);
    assert.equal(across.ok, false);
    assert.equal(across.ok === false && across.reason, 'unexplored');
  });

  it('reaches further when the character carries a better light, because radius is a stat', () => {
    // Same standpoint, same geometry, one number different. This is what makes light a progression
    // axis: a torch does not merely brighten the picture, it extends where you may go.
    const { world, sim, player } = makeSim();
    walkEastSeeing(sim, player, MOUTH_TX);

    // Exactly far enough to put 8002's centre inside the disc, and no further.
    const reachesTheCentre = MIDDLE.tx - MOUTH_TX;
    assert.equal(sim.setLightRadius(player, reachesTheCentre), true);
    assert.equal(sim.refreshVisible(player), true, 'a radius change must invalidate the lit set');
    const seen = new Set(player.visible);

    const across = plan(world, player, seen, MIDDLE);
    assert.equal(across.ok, true, 'a longer light reaches the room centre the bare radius cannot');
    assert.equal(
      sim.selfViewOf(player).lightRadius,
      reachesTheCentre,
      'and the client is told, so it can shade it',
    );
  });

  it('refuses a route onto ground this character has never had light on', () => {
    const { world, sim: _sim, player } = makeSim();
    // Standing where they spawned, having seen nothing but their own two-tile radius. 8003's floor
    // is walkable and reachable; the only thing stopping the click is that nobody has been there.
    const refused = plan(world, player, seenSoFar(world, player), EAST);
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, 'unexplored');

    const walked = seenWalking(gridOf(world, player), WEST, EAST);
    assert.equal(plan(world, player, walked, EAST).ok, true);
  });

  it('gates on tiles and not on room ownership, so corridors stay passable', () => {
    const { world, sim, player } = makeSim();
    const grid = gridOf(world, player);
    const seen = seenWalking(grid, WEST, MIDDLE);

    // Every tile of the corridor — ROOM_GAP of them, starting one past 8001's last floor column —
    // belongs to no room: `roomAtTile` reports -1, because a corridor is shared by the two rooms it
    // joins. The old gate needed a per-room reveal map to work around that; a set of tile indices has
    // no notion of ownership to get wrong.
    for (let step = 0; step < ROOM_GAP; step++) {
      const tx = blockTx(0) + ROOM_TILES + step;
      assert.equal(roomAtTile(grid, tx, MID_TY), -1, `tile ${tx},${MID_TY} should belong to no room`);
      assert.equal(
        seen.has(MID_TY * grid.width + tx),
        true,
        `tile ${tx},${MID_TY} should still be walkable`,
      );
    }

    const result = plan(world, player, seen, MIDDLE);
    assert.ok(result.ok);
    sim.setPath(player, result.points);
    assert.deepEqual(
      walkOut(sim).ended.map((e) => e.reason),
      ['arrived'],
      'and a route straight through them should complete',
    );
  });

  it('names the reason a click failed for reasons other than the dark', () => {
    const { world, sim: _sim, player } = makeSim();
    const seen = seenWalking(gridOf(world, player), WEST, EAST);

    // Void below the room blocks, and on the grid: nothing to stand on, whether or not light ever
    // fell on it. The distinction from `off-map` only means something while the tile is real, which
    // is why this is `VOID_TY` and not simply a row past the bottom of the grid.
    const void_ = plan(world, player, seen, { tx: WEST.tx, ty: VOID_TY });
    assert.equal(void_.ok, false);
    assert.equal(void_.ok === false && void_.reason, 'not-walkable');

    const offMap = plan(world, player, seen, { tx: 999, ty: 999 });
    assert.equal(offMap.ok, false);
    assert.equal(offMap.ok === false && offMap.reason, 'off-map');
  });
});

/* -------------------------------------------------------------------------- */
/* The gate through the machinery that actually builds it                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything above hands `findPath` a `Set` this file assembled. That proves the *rule*, but every
 * one of those tests would still pass if the server built `allowed` some entirely different way —
 * and it does build it another way: `bitsetToSet(store.seenBits(record, place, tileCount))`, over a
 * bitset that has been through `markSeen`, base64, a file, and back.
 *
 * `index.ts` is an entry script that binds a socket at import time, so nothing can import it and
 * that assembly has no coverage at all. These tests run the same four calls in the same order
 * against the real `PlayerStore`, so a change to the bitset, the sizing, the Place keying or the
 * round trip through disk shows up as a route that should exist and does not — or, far worse, one
 * that should not and does.
 */
describe('the gate as the server actually assembles it', () => {
  /** The gate `moveTo` builds, character record and all. */
  function gateOf(store: PlayerStore, record: PlayerRecord, world: GameWorld, player: Player): Set<number> {
    const grid = gridOf(world, player);
    const tileCount = grid.width * grid.height;
    return bitsetToSet(store.seenBits(record, player.place, tileCount), tileCount);
  }

  function makeStore(): { store: PlayerStore; record: PlayerRecord; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-gate-'));
    const store = new PlayerStore({ dir });
    return { store, record: store.load('Walker'), dir };
  }

  /** Walks east, folding light into the persistent record exactly as the tick loop does. */
  function walkEastMarking(
    store: PlayerStore,
    record: PlayerRecord,
    world: GameWorld,
    sim: Simulation,
    player: Player,
    stopAtTx: number,
  ): void {
    const grid = gridOf(world, player);
    const tileCount = grid.width * grid.height;
    const fold = (): void => {
      if (sim.refreshVisible(player)) store.markSeen(record, player.place, tileCount, player.visible);
    };
    fold();
    sim.setIntent(player.id, 1, 0);
    for (let i = 0; i < 400 && tileOf(player).tx < stopAtTx; i++) {
      sim.tick();
      fold();
    }
    sim.setIntent(player.id, 0, 0);
    assert.equal(tileOf(player).tx, stopAtTx, 'the walk should have reached the tile it was aimed at');
  }

  it('lets a route onto ground seen through a doorway, and no further', () => {
    const { world, sim, player } = makeSim();
    const { store, record } = makeStore();
    walkEastMarking(store, record, world, sim, player, MOUTH_TX);

    const grid = gridOf(world, player);
    const allowed = gateOf(store, record, world, player);
    assert.equal(player.roomId, 8001, 'the character has still not entered 8002');

    // Lit through the corridor mouth: reachable, even though no room was ever entered.
    assert.equal(allowed.has(LIT_IN_MIDDLE.ty * grid.width + LIT_IN_MIDDLE.tx), true);
    assert.equal(plan(world, player, allowed, LIT_IN_MIDDLE).ok, true);

    // The far side of that same room: two tiles of light do not reach it, so it stays refused. This
    // is the pair that matters — a gate that was accidentally permissive would pass the first
    // assertion on its own.
    assert.equal(allowed.has(MIDDLE.ty * grid.width + MIDDLE.tx), false);
    const across = plan(world, player, allowed, MIDDLE);
    assert.equal(across.ok === false && across.reason, 'unexplored');
  });

  it('survives the round trip through the save file', () => {
    // The gate is rebuilt from the record on every click, and the record is base64 in a JSON file
    // between sessions. A character who logs back in must be able to click exactly where they could
    // before — no more, and no less.
    const { world, sim, player } = makeSim();
    const { store, record, dir } = makeStore();
    walkEastMarking(store, record, world, sim, player, MOUTH_TX);
    const before = gateOf(store, record, world, player);
    store.flush(record);

    const reloaded = new PlayerStore({ dir }).load('Walker');
    const grid = gridOf(world, player);
    const tileCount = grid.width * grid.height;
    const after = bitsetToSet(store.seenBits(reloaded, player.place, tileCount), tileCount);

    assert.deepEqual([...after].sort((a, b) => a - b), [...before].sort((a, b) => a - b));
    assert.equal(plan(world, player, after, LIT_IN_MIDDLE).ok, true);
    assert.equal(plan(world, player, after, MIDDLE).ok, false);
  });

  it('keeps one Place s seen tiles out of another s gate', () => {
    // Tile indices are row-major and mean nothing off the grid they were computed on: level 0 here is
    // three room blocks wide and level 1 is one, so the same index names two different spots. The
    // record keys its bitsets by Place for exactly this reason, and `moveTo` always pairs the grid for
    // the player's Place with the bitset for that same Place.
    const { world, sim, player } = makeSim();
    const { store, record } = makeStore();
    walkEastMarking(store, record, world, sim, player, MOUTH_TX);
    const ground = gateOf(store, record, world, player);
    assert.ok(ground.size > 40, 'the walk should have seen a decent amount of level 0');

    assert.deepEqual(sim.relocate(player, 8004), { zone: 800, level: 1 });
    const canopy = gateOf(store, record, world, player);
    assert.equal(canopy.size, 0, 'a Place never visited has an empty gate, not the previous one s');

    // And the spot they are standing on is refused until light has actually fallen on it there.
    const here = tileOf(player);
    const refused = plan(world, player, canopy, here);
    assert.equal(refused.ok === false && refused.reason, 'unexplored');
  });
});
