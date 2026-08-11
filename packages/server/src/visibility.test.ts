/**
 * Per-player visibility in the simulation.
 *
 * The algorithm itself is `shared`'s problem and is tested exhaustively there. What is tested here
 * is the part the server owns and can get wrong on its own:
 *
 * - `visible` is **transient**. It is recomputed from where the character stands and never
 *   accumulated. The union of every visible set is `seen`, and it lives somewhere else entirely.
 * - It is recomputed **only when it can have changed** — a new tile, or a new radius. At 10 Hz a
 *   walk spends most of its ticks inside the tile it started in, and shadowcasting those again is
 *   pure waste.
 * - It is **invalidated by a change of Place**, because tile indices computed against one grid name
 *   somewhere else entirely on another.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  TILE_SIZE,
  boundsOf,
  buildZoneTilemap,
  type Room,
  type Zone,
} from '@mygame/shared';
import { makeRng } from '@mygame/shared';
import { DEFAULT_LIGHT_RADIUS } from '@mygame/shared/vision.ts';

import { Simulation, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/**
 * Two room blocks side by side on level 0, and one on level 1.
 *
 * Level 0's grid is two blocks wide and level 1's is one, which is the point of the fixture: the
 * centre tile of the first room block is the same *coordinate* on both and a different tile *index*
 * on each. A stale visible set is therefore detectable rather than merely suspected.
 *
 * **The hollows are `cave` rather than `forest`, and M0 is why.** Two linked *outdoor* rooms now
 * merge along their whole shared edge — there is no wall left beside the opening for light to be
 * stopped by, and 'spills through the corridor mouth and nowhere else' below has nowhere to point at.
 * A hollow with rock walls keeps the three-tile mouth this suite was written against, so the subject
 * stays the *wiring* — that the simulation hands the shadowcaster this player's own Place grid, walls
 * and all — instead of quietly becoming a test of the new carve rule.
 */
function testZone(): Zone {
  // **Every room here is `dark`, and that is now a statement rather than a default.** Natural room light
  // (2026-08-06) makes an unflagged room light itself — right for 95% of the harvested world, wrong for a
  // fixture whose whole subject is what a *carried* light reveals. Before that change, "no flags" happened
  // to mean the same thing; now it has to be said.
  const rooms: Room[] = [
    {
      id: 7001,
      zone: 700,
      name: 'West Hollow',
      flags: ['dark'],
      sector: 'cave',
      pos: { x: 0, y: 0, z: 0 },
      exits: { east: { to: 7002 }, up: { to: 7003, portal: true } },
    },
    {
      id: 7002,
      zone: 700,
      name: 'East Hollow',
      flags: ['dark'],
      sector: 'cave',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 7001 } },
    },
    {
      id: 7003,
      zone: 700,
      name: 'A Rope Bridge',
      flags: ['dark'],
      sector: 'cave',
      pos: { x: 0, y: 0, z: 1 },
      exits: { down: { to: 7001, portal: true } },
    },
  ];
  return { id: 700, name: 'Test Hollows', rooms, bounds: boundsOf(rooms), entryRoom: 7001 };
}

function makeSim(): { sim: Simulation; player: Player } {
  const sim = new Simulation(new GameWorld([testZone()], { zone: 700, room: null }));
  return { sim, player: sim.spawn('Torchbearer', makeRng(1)) };
}

/*
 * Every coordinate below is derived from the tilemap constants rather than written out. `ROOM_GAP`
 * is tuned against `DEFAULT_LIGHT_RADIUS` and has moved once already, and a suite that spells its
 * geometry out in digits reports that as a pile of failures in the code under test.
 */

/** Row stride on level 0, whose grid is two room blocks wide. */
const GROUND_WIDTH = 2 * ROOM_STRIDE;
/** Row stride on level 1, whose grid holds a single room block. */
const CANOPY_WIDTH = ROOM_STRIDE;

/** Centre offset within a room block — where a character spawns, and the corridor's own row. */
const CENTRE = (ROOM_TILES - 1) / 2;

/** The first block's last floor column: your own doorway, looking east. */
const MOUTH_TX = ROOM_TILES - 1;

/** The second block's first floor column, `ROOM_GAP + 1` tiles further east. */
const NEXT_ROOM_TX = ROOM_STRIDE;

const groundIndex = (tx: number, ty: number): number => ty * GROUND_WIDTH + tx;
const canopyIndex = (tx: number, ty: number): number => ty * CANOPY_WIDTH + tx;

describe('a player s lit tiles', () => {
  it('starts unlit and is computed on demand, not at spawn', () => {
    // Spawning does not know whether anyone is listening. The server folds light in as part of the
    // join handshake instead, which keeps `Simulation.spawn` free of I/O ordering concerns.
    const { sim, player } = makeSim();
    assert.equal(player.visible.size, 0);
    assert.equal(sim.refreshVisible(player), true);
    assert.ok(player.visible.size > 1);
    assert.equal(
      player.visible.has(groundIndex(CENTRE, CENTRE)),
      true,
      'the tile underfoot is always lit',
    );
  });

  it('starts at the bare radius, and reports it to the client as a stat', () => {
    const { sim, player } = makeSim();
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);
    assert.equal(sim.selfViewOf(player).lightRadius, DEFAULT_LIGHT_RADIUS);
    // The 21-tile rounded disc of a two-tile radius, not a 25-tile square and not a room.
    sim.refreshVisible(player);
    assert.equal(player.visible.size, 21);
  });

  it('recomputes when the tile changes and not when it does not', () => {
    const { sim, player } = makeSim();
    assert.equal(sim.refreshVisible(player), true, 'the first call always computes');
    assert.equal(sim.refreshVisible(player), false, 'standing still costs nothing');

    // Most ticks of a walk look like this: real movement, same tile.
    player.x += TILE_SIZE / 4;
    assert.equal(sim.refreshVisible(player), false, 'a quarter-tile drift changes no light');

    player.x += TILE_SIZE;
    assert.equal(sim.refreshVisible(player), true, 'crossing into the next tile does');
    assert.equal(player.visible.has(groundIndex(CENTRE + 1, CENTRE)), true);
  });

  it('is replaced rather than accumulated, so it can never drift into a `seen` map', () => {
    const { sim, player } = makeSim();
    sim.refreshVisible(player);
    const startTile = groundIndex(CENTRE, CENTRE);
    assert.equal(player.visible.has(startTile), true);

    // Four tiles east: the starting tile is well outside a two-tile radius now. `seen` would still
    // hold it — that is the whole difference between the two — but `visible` must not.
    player.x += 4 * TILE_SIZE;
    assert.equal(sim.refreshVisible(player), true);
    assert.equal(player.visible.has(startTile), false, 'visibility is not a memory');
    assert.equal(player.visible.has(groundIndex(CENTRE + 4, CENTRE)), true);
  });

  it('takes a better light source as a change of stat, not of code', () => {
    const { sim, player } = makeSim();
    sim.refreshVisible(player);
    const bare = player.visible.size;

    assert.equal(sim.setLightRadius(player, DEFAULT_LIGHT_RADIUS), false, 'no change is no change');
    assert.equal(sim.refreshVisible(player), false);

    assert.equal(sim.setLightRadius(player, 4), true);
    // No explicit invalidation: the radius is part of the cache key, so there is nothing to forget.
    assert.equal(sim.refreshVisible(player), true);
    assert.ok(player.visible.size > bare, 'a torch should light more than none');
    assert.equal(sim.selfViewOf(player).lightRadius, 4);
  });

  it('handles a light that has gone out without special-casing it', () => {
    // A Beacon of Hope crumbling to dust, or a zone that suppresses light. Radius 0 is a legitimate
    // state, not an error: you see the tile you are standing on and nothing else.
    const { sim, player } = makeSim();
    assert.equal(sim.setLightRadius(player, 0), true);
    assert.equal(sim.refreshVisible(player), true);
    assert.deepEqual([...player.visible], [groundIndex(CENTRE, CENTRE)]);

    // And a client asking for a negative radius gets nothing of the sort.
    assert.equal(sim.setLightRadius(player, -5), false);
    assert.equal(player.lightRadius, 0);
  });

  it('drops every lit tile on changing Place, rather than reading them against the wrong grid', () => {
    const { sim, player } = makeSim();
    sim.refreshVisible(player);
    assert.equal(player.visible.has(groundIndex(CENTRE, CENTRE)), true);

    // Level 1's room block puts the character on tile (4, 4) again — the same coordinates, a
    // different grid, and a different index. A cache keyed on the tile alone would hand back level
    // 0's tiles here, and the client would shade the wrong squares.
    assert.deepEqual(sim.relocate(player, 7003), { zone: 700, level: 1 });
    assert.equal(player.visible.size, 0, 'nothing is a safer answer than another map s tiles');

    assert.equal(sim.refreshVisible(player), true, 'the same tile on a new grid must recompute');
    assert.equal(player.visible.has(canopyIndex(CENTRE, CENTRE)), true);
    assert.equal(player.visible.has(groundIndex(CENTRE, CENTRE)), false);
  });

  it('spills through the corridor mouth and nowhere else', () => {
    // Not a re-test of the shadowcaster — that is `shared`'s job — but of the wiring: the simulation
    // must hand it *this* player's own Place grid, walls and all. With a radius long enough to cross
    // the gap, the two tiles that matter are both on the far room's west edge, two rows apart.
    //
    // This is the behaviour the whole change exists for, and it needs no special case for doorways:
    // the far room's near column is lit on the corridor's own row, because the corridor leaves an
    // unobstructed line to it, and dark two rows up, because the wall beside the opening does not.
    const { sim, player } = makeSim();
    sim.setLightRadius(player, 8);
    sim.refreshVisible(player);

    assert.equal(
      player.visible.has(groundIndex(MOUTH_TX, CENTRE)),
      true,
      'the room s own east edge is lit',
    );
    assert.equal(
      player.visible.has(groundIndex(NEXT_ROOM_TX, CENTRE)),
      true,
      'light reaches through the mouth',
    );
    assert.equal(
      player.visible.has(groundIndex(NEXT_ROOM_TX, CENTRE - 2)),
      false,
      'but not through the wall beside it',
    );
  });

  it('shows nothing of the next room at the bare radius, and reaches it at the first torch', () => {
    // The test above uses radius 8 to isolate the *geometry*. This one pins what a player actually
    // gets, and it is the guard rail on a deliberate design decision rather than an observation
    // about the current numbers.
    //
    // **The relationship.** A room's last floor column and its neighbour's first are `ROOM_GAP + 1`
    // tiles apart. A light of radius `r` reaches exactly `r` tiles — the FOV test is
    // `distance <= radius + 0.5`. So radius `ROOM_GAP + 1` is the first that crosses the gap, and
    // with `DEFAULT_LIGHT_RADIUS === ROOM_GAP` the bare light lands exactly one tile short of it.
    //
    // At today's values that reads: the next room is three tiles from your doorway, invisible at the
    // starting radius of 2, and visible at radius 3 — the first torch. **Finding a light source is
    // what lets you see into the next room before walking into it**, which is what makes the upgrade
    // something a player feels rather than reads in a tooltip.
    //
    // At the previous `ROOM_GAP` of 3 the next room was four tiles off and no early light reached it
    // at all: you stood in your own doorway with a torch and the room beyond was black, which is the
    // complaint this geometry exists to answer.
    //
    // Change `ROOM_TILES`, `ROOM_GAP` or `DEFAULT_LIGHT_RADIUS` and that relationship is re-tuned —
    // so this test states it in both forms, as arithmetic over the constants and as the light the
    // shadowcaster actually casts, and fails either way round.
    // Measured off the grid the builder actually produces, not restated from the constants, so a
    // change in how blocks are laid out is caught here too.
    const nearColumnOfNextRoom = buildZoneTilemap(testZone()).roomOrigins.get(7002)?.tx ?? -1;
    assert.equal(
      nearColumnOfNextRoom - MOUTH_TX,
      ROOM_GAP + 1,
      'the next room block is ROOM_GAP + 1 tiles from this one s last floor column',
    );
    assert.equal(nearColumnOfNextRoom, NEXT_ROOM_TX, 'and that is the column the counter below uses');
    assert.equal(
      DEFAULT_LIGHT_RADIUS,
      ROOM_GAP,
      'while the bare radius is exactly one tile short of crossing it',
    );

    /** What `docs/DESIGN-visibility-and-light.md` gives the first torch: one tile past the bare radius. */
    const FIRST_TORCH = DEFAULT_LIGHT_RADIUS + 1;

    const { sim, player } = makeSim();

    /** How many tiles of the *second* room block are lit, standing at (tx, CENTRE). */
    const intoRoomTwo = (tx: number, radius: number): number => {
      player.x = tx * TILE_SIZE + TILE_SIZE / 2;
      sim.setLightRadius(player, radius);
      sim.refreshVisible(player);
      let count = 0;
      for (const index of player.visible) if (index % GROUND_WIDTH >= NEXT_ROOM_TX) count++;
      return count;
    };

    // The decision itself: same tile, same geometry, one number different.
    assert.equal(
      intoRoomTwo(MOUTH_TX, DEFAULT_LIGHT_RADIUS),
      0,
      'from your own last floor column the bare radius must show nothing of the room beyond',
    );
    assert.ok(
      intoRoomTwo(MOUTH_TX, FIRST_TORCH) > 0,
      'and the first torch must open it up from that same tile, without taking a step',
    );

    // Walking still buys more than standing does, which is what keeps "you see one lit radius beyond
    // your feet" true — a torch extends the rule rather than replacing it with a free reveal.
    assert.equal(intoRoomTwo(ROOM_TILES, DEFAULT_LIGHT_RADIUS), 3, 'the first corridor tile sees in');
    assert.equal(intoRoomTwo(ROOM_STRIDE - 1, DEFAULT_LIGHT_RADIUS), 8, 'the last one sees further');
    assert.ok(
      intoRoomTwo(ROOM_STRIDE - 1, DEFAULT_LIGHT_RADIUS) > intoRoomTwo(MOUTH_TX, FIRST_TORCH),
      'standing in the doorway with a torch must not beat walking to the far end of the corridor',
    );
  });
});

describe('light that changes while standing still', () => {
  it('is reported by the tick, because nothing else in the loop is keyed on it', () => {
    // The seam the first light source will land on. Everything the server does per tick — folding
    // light into `seen`, shipping `seenDelta`, re-evaluating who is lit — is driven by the `moved`
    // list, and a character who lights a torch on the spot moves nothing. Without being reported
    // here they would keep the old disc until they next crossed a tile: `seen` would not grow, so
    // `moveTo` would answer "You cannot see that far" on ground the client is already drawing lit.
    // That is the one client/server divergence the delta protocol cannot absorb.
    const { sim, player } = makeSim();
    assert.deepEqual(sim.tick().relit, [], 'nothing changed, nothing to report');

    assert.equal(sim.setLightRadius(player, 5), true);
    const first = sim.tick();
    assert.deepEqual(first.moved, [], 'the character has not moved a pixel');
    assert.deepEqual(
      first.relit.map((p) => p.id),
      [player.id],
    );

    // An edge, not a level: reporting it every tick would have the server re-send `self` and re-fold
    // `seen` for the rest of the character's life.
    assert.deepEqual(sim.tick().relit, [], 'drained, not latched');

    // And a radius that did not actually change is not an edge at all.
    assert.equal(sim.setLightRadius(player, 5), false);
    assert.deepEqual(sim.tick().relit, []);
  });

  it('grows the lit set on the next refresh, with no separate invalidation to forget', () => {
    const { sim, player } = makeSim();
    sim.refreshVisible(player);
    const bare = new Set(player.visible);

    sim.setLightRadius(player, 5);
    const relit = sim.tick().relit;
    assert.equal(relit.length, 1);

    // What the server does with the report: exactly what it does for a mover.
    assert.equal(sim.refreshVisible(player), true);
    for (const index of bare) assert.equal(player.visible.has(index), true, 'light never shrinks here');
    assert.ok(player.visible.size > bare.size, 'and the wider radius reaches further');
  });
});
