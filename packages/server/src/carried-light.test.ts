/**
 * Carrying a light: what it is worth, how it burns down, and what it leaves behind.
 *
 * The catalogue is `shared`'s and is tested there. What is tested here is the part the server owns
 * and can get wrong alone:
 *
 * - **`lightRadius` is derived, never assigned.** It comes from the carried source through
 *   `effectiveRadius`, so a torch is a real upgrade and can drop back again.
 * - **Expiry is server-authoritative and announced.** A light that shrinks with no message reads as
 *   a bug rather than a mechanic, so the tick has to *report* the event, not merely apply it — and
 *   it has to fire the `relit` path, or the client keeps the old disc until the next tile crossing.
 * - **`rooms` mode is a different derivation, not a bigger number**, and it has to slot into the
 *   `refreshVisible` cache rather than rebuilding the room graph ten times a second.
 *
 * Burn-down is driven by the 100 ms tick, so every duration below is expressed in ticks and there is
 * no clock to make these flake.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROOM_STRIDE,
  ROOM_TILES,
  TICK_MS,
  TILE_SIZE,
  boundsOf,
  buildZoneTilemap,
  roomAtTile,
  type Room,
  type RoomId,
  type TileGrid,
  type Zone,
} from '@mygame/shared';
import { makeRng } from '@mygame/shared';
import { LIGHT_SOURCES, effectiveRadius, type LightSource } from '@mygame/shared/light.ts';
import { DEFAULT_LIGHT_RADIUS } from '@mygame/shared/vision.ts';

import { LIGHT_WARNING_MS, Simulation, type Player, type TickResult } from './sim.ts';
import { GameWorld } from './world.ts';

/**
 * A plus-shaped junction: a centre room with four neighbours, plus one room hanging off the east
 * arm two exits away.
 *
 * The shape is chosen for the beacon. Its room radius is 1, so from the centre it must light the
 * centre and exactly the four arms — and must *not* reach the sixth room, which is the difference
 * between "lights whole rooms in a block around you" and "lights everything".
 */
function testZone(): Zone {
  const rooms: Room[] = [
    {
      id: 9000,
      zone: 900,
      name: 'The Crossing',
      sector: 'cave',
      pos: { x: 1, y: 1, z: 0 },
      exits: {
        north: { to: 9001 },
        south: { to: 9002 },
        west: { to: 9003 },
        east: { to: 9004 },
      },
    },
    { id: 9001, zone: 900, name: 'North Arm', sector: 'cave', pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 9000 } } },
    { id: 9002, zone: 900, name: 'South Arm', sector: 'cave', pos: { x: 1, y: 2, z: 0 }, exits: { north: { to: 9000 } } },
    { id: 9003, zone: 900, name: 'West Arm', sector: 'cave', pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 9000 } } },
    {
      id: 9004,
      zone: 900,
      name: 'East Arm',
      sector: 'cave',
      pos: { x: 2, y: 1, z: 0 },
      exits: { west: { to: 9000 }, east: { to: 9005 } },
    },
    { id: 9005, zone: 900, name: 'The Far End', sector: 'cave', pos: { x: 3, y: 1, z: 0 }, exits: { west: { to: 9004 } } },
  ];
  return { id: 900, name: 'Test Junction', rooms, bounds: boundsOf(rooms), entryRoom: 9000 };
}

function makeSim(): { sim: Simulation; player: Player } {
  const sim = new Simulation(new GameWorld([testZone()], { zone: 900, room: null }));
  return { sim, player: sim.spawn('Lightbearer', makeRng(1)) };
}

/**
 * The zone's only grid, built once.
 *
 * Every `Simulation` below is handed an identical `GameWorld`, and `buildZoneTilemap` is a pure
 * function of the zone, so this is the same grid every one of them is walking on — which is what
 * makes it legitimate to read tile indices out of a player's lit set against it.
 */
const grid: TileGrid = buildZoneTilemap(testZone());
const at = (tx: number, ty: number): number => ty * grid.width + tx;

const source = (id: string): LightSource => {
  const found = LIGHT_SOURCES[id];
  assert.ok(found, `the catalogue has no ${id}`);
  return found;
};

/** Runs the simulation forward and returns everything it reported along the way. */
function run(sim: Simulation, ticks: number): TickResult[] {
  const results: TickResult[] = [];
  for (let i = 0; i < ticks; i++) results.push(sim.tick());
  return results;
}

const ticksFor = (ms: number): number => Math.ceil(ms / TICK_MS);

/* -------------------------------------------------------------------------- */

describe('the radius a source is worth', () => {
  it('is derived from what is carried, never assigned', () => {
    const { sim, player } = makeSim();
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS, 'everyone starts in the dark');
    assert.equal(player.light, undefined);

    // The first torch: exactly one tile past the bare radius, which is what crosses `ROOM_GAP`.
    sim.setCarriedLight(player, source('torch'));
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
    assert.equal(player.lightRadius, effectiveRadius(source('torch')));

    // The second threshold: a room's centre is 4 tiles from each wall midpoint.
    sim.setCarriedLight(player, source('lantern'));
    assert.equal(player.lightRadius, (ROOM_TILES - 1) / 2);

    // And back to nothing at all.
    sim.setCarriedLight(player, undefined);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);
  });

  it('never reports a rooms-mode source as a downgrade', () => {
    // `effectiveRadius` converts room-steps into a tile floor rather than returning the step count,
    // because a consumer that only understands a radius would otherwise be told the Beacon of Hope
    // is worth 1 tile — dimmer than no light at all.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));
    assert.equal(player.lightRadius, ROOM_STRIDE, 'one room step, in tiles');
    assert.ok(player.lightRadius > effectiveRadius(source('lantern')));
  });

  it('puts the source on the wire with its remaining time, and omits what does not apply', () => {
    const { sim, player } = makeSim();
    assert.equal(sim.selfViewOf(player).light, undefined, 'nothing in hand, no field');

    sim.setCarriedLight(player, source('torch'));
    const lit = sim.selfViewOf(player);
    assert.equal(lit.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
    assert.equal(lit.light?.id, 'torch');
    assert.equal(lit.light?.mode, 'radius');
    assert.equal(lit.light?.remainingMs, source('torch').durationMs);

    // A source that never expires carries no countdown — omitted, not undefined, so a client can
    // tell "never expires" from "the server forgot to fill this in".
    sim.setCarriedLight(player, source('lantern'));
    const forever = sim.selfViewOf(player).light;
    assert.ok(forever);
    assert.equal('remainingMs' in forever, false);
  });

  it('reports every change to the client, even one that leaves the radius alone', () => {
    // Swapping a torch for an everburning one is the same three tiles and a completely different
    // decision. The client counts `remainingMs` down itself, so it has to be told.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('torch'));
    sim.tick();

    sim.setCarriedLight(player, source('everburning_torch'));
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1, 'no brighter');
    assert.deepEqual(
      sim.tick().relit.map((p) => p.id),
      [player.id],
      'but the client must still hear about it',
    );
  });
});

describe('a light burning down', () => {
  it('counts down on the simulation tick, not on a wall clock', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('candle'));
    const burn = source('candle').durationMs!;
    assert.equal(sim.lightRemaining(player), burn);

    run(sim, 10);
    assert.equal(sim.lightRemaining(player), burn - 10 * TICK_MS);
  });

  it('warns once, shortly before it goes out', () => {
    // A light dying with no warning in a dark zone is miserable — the radius drops between one tick
    // and the next and the honest reading is that the server glitched.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('candle'));
    const burn = source('candle').durationMs!;

    const quiet = run(sim, ticksFor(burn - LIGHT_WARNING_MS) - 1);
    assert.deepEqual(quiet.flatMap((r) => r.affectEvents), [], 'no nagging while it is healthy');

    const rest = run(sim, ticksFor(LIGHT_WARNING_MS));
    const warnings = rest.flatMap((r) => r.affectEvents).filter((e) => e.kind === 'expiring');
    assert.equal(warnings.length, 1, 'exactly one warning, not one per tick');
    assert.equal(warnings[0]?.affect.context, 'candle');
    assert.ok((warnings[0]?.affect.durationMs ?? 0) <= LIGHT_WARNING_MS);
    assert.ok((warnings[0]?.affect.durationMs ?? 0) > 0, 'warned before it dies, not as it dies');
  });

  it('expires a torch to nothing, and says so', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('torch'));
    sim.tick();

    const burn = source('torch').durationMs!;
    const results = run(sim, ticksFor(burn));
    const expired = results.flatMap((r) => r.affectEvents).filter((e) => e.kind === 'expired');

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.affect.context, 'torch');
    assert.deepEqual(expired[0]?.chained, [], 'a torch leaves nothing behind');

    // Back to the bare eye, and the room beyond the doorway is gone again — which is the whole
    // tension of the resource.
    assert.equal(player.light, undefined);
    assert.equal(sim.lightRemaining(player), undefined);
    assert.deepEqual(player.affects, [], 'and nothing is left on the list');
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);
    assert.equal(sim.selfViewOf(player).light, undefined);
  });

  it('expires the Beacon of Hope to a torch, with a full torch s burn', () => {
    // The owner's own example: carried for thirty seconds, then it crumbles back to ordinary torch
    // range. The aftermath is a working light rather than a punishment.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));

    const burn = source('beacon_of_hope').durationMs!;
    const results = run(sim, ticksFor(burn));
    const expired = results.flatMap((r) => r.affectEvents).filter((e) => e.kind === 'expired');

    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.affect.context, 'beacon_of_hope');
    // The successor arrives on the event rather than being looked up afterwards, because the sentence
    // the player reads is about it: "crumbles away, leaving a pitch-soaked torch".
    assert.equal(expired[0]?.chained[0]?.context, 'torch');

    assert.equal(player.light?.id, 'torch');
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
    // A fresh torch, not the remains of one: there is no inventory for a half-burnt one to come from.
    assert.equal(sim.lightRemaining(player), source('torch').durationMs);
  });

  it('fires the relit path in the same tick, so the client is not left a tile crossing behind', () => {
    // The one client/server divergence the delta protocol cannot absorb. A character standing still
    // when their torch dies moves nothing, and everything else the tick loop does is keyed on
    // movement — so without this their `seen` would not change, the click gate would still allow
    // ground that is now dark, and the HUD would keep showing radius 3.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('torch'));
    sim.tick();

    const burn = source('torch').durationMs!;
    const results = run(sim, ticksFor(burn));
    const dying = results.find((r) => r.affectEvents.some((e) => e.kind === 'expired'));
    assert.ok(dying, 'the torch should have gone out');
    assert.deepEqual(dying.moved, [], 'the character has not moved a pixel');
    assert.deepEqual(
      dying.relit.map((p) => p.id),
      [player.id],
      'expiry and the relight must land in one tick',
    );
  });

  it('never counts down a source that does not expire', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('everburning_torch'));
    const results = run(sim, 200);
    assert.deepEqual(results.flatMap((r) => r.affectEvents), []);
    assert.equal(sim.lightRemaining(player), undefined);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
  });

  /**
   * Resuming a burn.
   *
   * `setCarriedLight`'s default is to reset the timer, because lighting a fresh torch is what it is
   * for. The third argument exists for the one caller that is not lighting anything — putting a
   * character's own light back in their hand after a reconnect or a server restart — and it has to
   * be exact, because the alternative is a free refill on every disconnect.
   */
  it('resumes a source mid-burn rather than refilling it', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('torch'), 3_000);
    assert.equal(sim.lightRemaining(player), 3_000);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1, 'a resumed torch is still a torch');

    const results = run(sim, ticksFor(3_000));
    const expired = results.flatMap((r) => r.affectEvents).filter((e) => e.kind === 'expired');
    assert.equal(expired.length, 1, 'it goes out on the schedule it was resumed on');
    assert.equal(player.light, undefined);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);
  });

  it('clamps a resumed burn into the source s own range', () => {
    const { sim, player } = makeSim();
    // A hand-edited save, or one written by a build whose catalogue said something else.
    sim.setCarriedLight(player, source('candle'), 10 * source('candle').durationMs!);
    assert.equal(sim.lightRemaining(player), source('candle').durationMs);

    sim.setCarriedLight(player, source('candle'), -1);
    assert.equal(sim.lightRemaining(player), 0, 'spent, not negative');
  });

  it('ignores a resumed burn for a source that never expires', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('lantern'), 5_000);
    assert.equal(sim.lightRemaining(player), undefined, 'unlimited stays unlimited');
    assert.deepEqual(run(sim, ticksFor(10_000)).flatMap((r) => r.affectEvents), []);
  });

  it('warns again for the next source rather than staying latched', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));
    // Beacon -> torch, and the torch must be able to warn in its own right later.
    run(sim, ticksFor(source('beacon_of_hope').durationMs!));
    assert.equal(player.affects[0]?.warned, false, 'a new source starts unwarned');

    const torchBurn = source('torch').durationMs!;
    const rest = run(sim, ticksFor(torchBurn));
    const kinds = rest.flatMap((r) => r.affectEvents).map((e) => e.kind);
    assert.deepEqual(kinds, ['expiring', 'expired']);
  });
});

describe('a rooms-mode source', () => {
  /** Which rooms a lit set touches, ascending. Corridor and void tiles report -1 and are dropped. */
  function roomsLit(player: Player): RoomId[] {
    const out = new Set<RoomId>();
    for (const index of player.visible) {
      const room = roomAtTile(grid, index % grid.width, Math.floor(index / grid.width));
      if (room !== -1) out.add(room);
    }
    return [...out].sort((a, b) => a - b);
  }

  it('lights whole rooms out to its room radius, and no further', () => {
    // Not a bigger disc: every tile of every room one exit away, walls, corners and all, with no
    // line of sight involved. The room two exits out stays dark, which is what makes it a radius
    // rather than a reveal.
    const { sim, player } = makeSim();
    assert.equal(player.roomId, 9000, 'spawns at the junction');

    sim.setCarriedLight(player, source('beacon_of_hope'));
    assert.equal(sim.refreshVisible(player), true);

    assert.deepEqual(
      roomsLit(player),
      [9000, 9001, 9002, 9003, 9004],
      'the junction and its four arms, entirely',
    );
  });

  it('lights every tile of those rooms, including the corners a disc would miss', () => {
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));
    sim.refreshVisible(player);

    for (const roomId of [9000, 9001, 9002, 9003, 9004]) {
      const origin = grid.roomOrigins.get(roomId);
      assert.ok(origin, `room ${roomId} is not on this grid`);
      for (let dy = 0; dy < ROOM_TILES; dy++) {
        for (let dx = 0; dx < ROOM_TILES; dx++) {
          assert.equal(
            player.visible.has(at(origin.tx + dx, origin.ty + dy)),
            true,
            `room ${roomId} tile ${dx},${dy} should be lit by a beacon`,
          );
        }
      }
    }
  });

  it('beats every radius source, because it is not on the same scale', () => {
    // The weakest possible rooms source lights a whole 9x9 room plus every neighbour, through walls.
    // No disc we would ship can match that, so the comparison is not a judgement call.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('lantern'));
    sim.refreshVisible(player);
    const lantern = player.visible.size;

    sim.setCarriedLight(player, source('beacon_of_hope'));
    sim.refreshVisible(player);
    assert.ok(player.visible.size > lantern);
  });

  it('is cached on the room rather than the tile, so walking about does not rebuild it', () => {
    // The requirement that it slot into the existing cache. A beacon lights the same set from every
    // tile of the room it is carried in, so keying it on the tile would walk the whole room graph
    // nine times per room for an identical answer.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));
    assert.equal(sim.refreshVisible(player), true, 'the first call always computes');
    assert.equal(sim.refreshVisible(player), false, 'standing still costs nothing');

    const before = player.visible;
    player.x += TILE_SIZE * 2;
    assert.equal(sim.refreshVisible(player), false, 'crossing a tile inside one room changes nothing');
    assert.equal(player.visible, before, 'and the same set is kept, not rebuilt');

    // Leaving the room is what changes it — which the tick records by updating `roomId`.
    player.roomId = 9004;
    assert.equal(sim.refreshVisible(player), true);
    assert.deepEqual(roomsLit(player), [9000, 9004, 9005], 'the east arm and its own neighbours');
  });

  it('recomputes when a beacon is swapped for a torch and back', () => {
    // Two cache keys, exactly one live at a time. Whichever branch runs retires the other, so a
    // character who goes torch -> beacon -> torch never reads a set left over from two sources ago.
    const { sim, player } = makeSim();

    sim.setCarriedLight(player, source('torch'));
    assert.equal(sim.refreshVisible(player), true);
    const torchLit = new Set(player.visible);
    assert.deepEqual(roomsLit(player), [9000], 'a torch sees its own room only');

    sim.setCarriedLight(player, source('beacon_of_hope'));
    assert.equal(sim.refreshVisible(player), true, 'the mode changed, so the set must be rebuilt');
    assert.ok(player.visible.size > torchLit.size);

    sim.setCarriedLight(player, source('torch'));
    assert.equal(sim.refreshVisible(player), true, 'and back again');
    assert.deepEqual([...player.visible].sort((a, b) => a - b), [...torchLit].sort((a, b) => a - b));
  });

  it('drops its lit set on changing Place, like every other kind of light', () => {
    // Tile indices from a room-graph walk are indices on one grid and name somewhere else on
    // another, exactly as a shadowcast's do.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, source('beacon_of_hope'));
    sim.refreshVisible(player);
    assert.ok(player.visible.size > 0);

    assert.ok(sim.relocate(player, 9005));
    assert.equal(player.visible.size, 0);
    assert.equal(sim.refreshVisible(player), true, 'and it recomputes for where they now stand');
    assert.deepEqual(roomsLit(player), [9004, 9005], 'the far end and its one neighbour');
  });
});
