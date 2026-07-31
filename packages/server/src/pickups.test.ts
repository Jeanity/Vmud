/**
 * Ground pickups: where light sources lie, and what it means for a character to have taken one.
 *
 * The load-bearing property is **determinism**. Nothing about a scattered torch is persisted — the
 * world is recomputed from room ids on demand — so every guarantee the feature makes rests on the
 * placement being a pure function of the room id:
 *
 * - a restarted server puts the torch back where it was;
 * - a character's `taken` key still names something, so a room they emptied stays empty;
 * - two players comparing notes are talking about the same torch.
 *
 * A single `Math.random()` anywhere in that chain breaks all three at once and breaks them quietly,
 * so the tests below check the *distribution* as well as the repeatability: a placement that is
 * stable but heavily biased is a different bug with the same symptom (rooms that never hold
 * anything) and would otherwise pass every equality assertion here.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ROOM_TILES,
  TILE_SIZE,
  boundsOf,
  buildZoneTilemap,
  roomCentre,
  type Room,
  type TileGrid,
  type Zone,
} from '@mygame/shared';
import { LIGHT_SOURCES, SCATTERABLE_LIGHTS } from '@mygame/shared/light.ts';
import { DEFAULT_LIGHT_RADIUS, computeVisible } from '@mygame/shared/vision.ts';

import {
  PICKUP_ROOM_CHANCE,
  PICKUP_SLOTS,
  pickupEntityId,
  pickupInRoom,
  pickupKey,
  pickupOutcome,
  pickupViewOf,
  standingOn,
} from './pickups.ts';
import { PlayerStore, slugify } from './players.ts';

/** Three rooms in a line, so the middle one has a corridor at both ends to be crossed between. */
function testZone(): Zone {
  const rooms: Room[] = [
    {
      id: 8001,
      zone: 800,
      name: 'A Dripping Cave',
      sector: 'cave',
      pos: { x: 0, y: 0, z: 0 },
      exits: { east: { to: 8002 } },
    },
    {
      id: 8002,
      zone: 800,
      name: 'A Wider Chamber',
      sector: 'cave',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 8001 }, east: { to: 8003 } },
    },
    {
      id: 8003,
      zone: 800,
      name: 'A Dead End',
      sector: 'cave',
      pos: { x: 2, y: 0, z: 0 },
      exits: { west: { to: 8002 } },
    },
  ];
  return { id: 800, name: 'Test Caves', rooms, bounds: boundsOf(rooms), entryRoom: 8001 };
}

const grid = buildZoneTilemap(testZone());

/**
 * A grid whose `roomOrigins` answers for any id, so the scatter can be sampled over a realistic
 * block of MUD room numbers without inventing a zone that large.
 *
 * Every room shares one origin, which is fine: the *decision* (whether, which, where in the block)
 * depends on the room id alone, and only the translation into grid tiles uses the origin.
 */
function samplingGrid(from: number, count: number): TileGrid {
  const roomOrigins = new Map<number, { tx: number; ty: number }>();
  for (let id = from; id < from + count; id++) roomOrigins.set(id, { tx: 0, ty: 0 });
  return { ...grid, roomOrigins };
}

/** MUD room ids run in dense consecutive blocks; sampling one is the realistic case. */
const SAMPLE_FROM = 26_000;
const SAMPLE_COUNT = 200_000;

describe('where a light source lies', () => {
  it('is the same answer every time it is asked, which is what a restart relies on', () => {
    // The whole feature: nothing about a scattered torch is stored, so "it is still there after a
    // restart" and "this function is pure" are the same statement.
    for (const roomId of [8001, 8002, 8003]) {
      const first = pickupInRoom(grid, roomId);
      const second = pickupInRoom(grid, roomId);
      assert.deepEqual(second, first, `room ${roomId} moved its pickup between two calls`);
    }
  });

  it('is a golden fixture, so re-seeding the world announces itself', () => {
    // Placement is a promise to the player — "there's a torch in the fungus cave" has to keep being
    // true — so a change to the seed, the hash, or the *order* the rng is drawn in is a change to
    // the world and must not slip through as an implementation detail. Any of those three edits
    // fails this and nothing else.
    const wide = samplingGrid(26_000, 40);
    const found = [];
    for (let id = 26_000; id < 26_040; id++) {
      const pickup = pickupInRoom(wide, id);
      if (pickup) found.push(`${id}:${pickup.source.id}@${pickup.tx},${pickup.ty}`);
    }
    assert.deepEqual(found, [
      '26007:torch@0,8',
      '26011:candle@0,6',
      '26015:candle@0,0',
      '26030:candle@4,8',
      '26033:torch@2,4',
      '26036:candle@8,8',
      '26037:candle@3,6',
    ]);
  });

  it('scatters about one room in eight, over a realistic block of room ids', () => {
    // Not a restatement of the constant: this is the rate the *hash and the rng* actually produce
    // over consecutive ids. MUD room ids come in dense runs, which is precisely the input pattern a
    // weak seeding step turns into stripes — every room in a corridor holding a torch, or none of
    // them doing.
    const wide = samplingGrid(SAMPLE_FROM, SAMPLE_COUNT);
    let held = 0;
    for (let id = SAMPLE_FROM; id < SAMPLE_FROM + SAMPLE_COUNT; id++) {
      if (pickupInRoom(wide, id)) held++;
    }
    const rate = held / SAMPLE_COUNT;
    assert.ok(
      Math.abs(rate - PICKUP_ROOM_CHANCE) < 0.005,
      `scatter rate ${rate.toFixed(4)} is not close to ${PICKUP_ROOM_CHANCE}`,
    );
  });

  it('picks sources in proportion to their scatter weights', () => {
    const wide = samplingGrid(SAMPLE_FROM, SAMPLE_COUNT);
    const counts = new Map<string, number>();
    let held = 0;
    for (let id = SAMPLE_FROM; id < SAMPLE_FROM + SAMPLE_COUNT; id++) {
      const pickup = pickupInRoom(wide, id);
      if (!pickup) continue;
      held++;
      counts.set(pickup.source.id, (counts.get(pickup.source.id) ?? 0) + 1);
    }

    const total = SCATTERABLE_LIGHTS.reduce((sum, s) => sum + s.scatterWeight, 0);
    for (const source of SCATTERABLE_LIGHTS) {
      const share = (counts.get(source.id) ?? 0) / held;
      assert.ok(
        Math.abs(share - source.scatterWeight / total) < 0.01,
        `${source.id} came up ${(100 * share).toFixed(2)}% against a weight of ${source.scatterWeight}/${total}`,
      );
    }

    // The Beacon of Hope is weight 0 and must never turn up in the mud next to a rock.
    assert.equal(counts.has(LIGHT_SOURCES['beacon_of_hope']!.id), false);
  });

  it('never uses the room s centre tile, and uses every other one', () => {
    // The centre is where `relocate` puts a character stepping in through an exit, so a pickup there
    // would be collected by the act of arriving — the one way of finding a light that involves no
    // exploring whatsoever.
    const wide = samplingGrid(SAMPLE_FROM, SAMPLE_COUNT);
    const centre = roomCentre({ tx: 0, ty: 0 });
    const used = new Set<number>();
    for (let id = SAMPLE_FROM; id < SAMPLE_FROM + SAMPLE_COUNT; id++) {
      const pickup = pickupInRoom(wide, id);
      if (!pickup) continue;
      assert.ok(
        pickup.tx !== centre.tx || pickup.ty !== centre.ty,
        `room ${id} put its pickup on the arrival tile`,
      );
      used.add(pickup.ty * ROOM_TILES + pickup.tx);
    }
    assert.equal(used.size, PICKUP_SLOTS, 'every non-centre floor tile should be reachable');
  });

  it('lands inside the room block it belongs to, on that Place s own grid', () => {
    for (const roomId of [8001, 8002, 8003]) {
      const pickup = pickupInRoom(grid, roomId);
      if (!pickup) continue;
      const origin = grid.roomOrigins.get(roomId)!;
      assert.ok(pickup.tx >= origin.tx && pickup.tx < origin.tx + ROOM_TILES);
      assert.ok(pickup.ty >= origin.ty && pickup.ty < origin.ty + ROOM_TILES);
    }
  });

  it('holds nothing for a room that is not on this grid', () => {
    // Another level, another zone, or a room id from a save written when the world was larger.
    // Answering with a tile here would place a torch by indexing one grid with another's room.
    assert.equal(pickupInRoom(grid, 99_999), undefined);
  });

  it('gives every pickup an id that cannot collide with a player s', () => {
    // `Simulation` hands ids out from 1 upward, so disjointness is arithmetic rather than a base
    // constant chosen to be big enough — and "big enough" is an assumption with an expiry date.
    for (const roomId of [0, 1, 8002, 26_031, 999_999]) {
      assert.ok(pickupEntityId(roomId) < 0, `room ${roomId} produced a non-negative entity id`);
    }
    assert.notEqual(pickupEntityId(0), pickupEntityId(1));
    // Stable across restarts, which a counter is not.
    assert.equal(pickupEntityId(8002), pickupEntityId(8002));
  });
});

describe('a pickup as the client sees it', () => {
  it('is an ordinary item entity, needing no new message type', () => {
    // `EntityKind` already had 'item' and `EntityView` already carried a position, which is the
    // whole reason acquisition needs no protocol change: a torch enters and leaves a client's world
    // through the same `entityEnter`/`entityLeave` a player does, and therefore through the same
    // visibility gate.
    const wide = samplingGrid(26_000, 40);
    const pickup = pickupInRoom(wide, 26_007);
    assert.ok(pickup);
    const view = pickupViewOf(pickup);
    assert.equal(view.kind, 'item');
    assert.equal(view.id, pickup.id);
    assert.equal(view.name, pickup.source.name);
    assert.equal(view.sprite, pickup.source.id);
    // World pixels at the centre of its tile, matching `Simulation.viewOf`.
    assert.equal(view.x, pickup.tx * TILE_SIZE + TILE_SIZE / 2);
    assert.equal(view.y, pickup.ty * TILE_SIZE + TILE_SIZE / 2);
  });

  it('is collected by standing on its tile and not by passing near it', () => {
    const wide = samplingGrid(26_000, 40);
    const pickup = pickupInRoom(wide, 26_007);
    assert.ok(pickup);

    const centreX = pickup.tx * TILE_SIZE + TILE_SIZE / 2;
    const centreY = pickup.ty * TILE_SIZE + TILE_SIZE / 2;
    assert.equal(standingOn(pickup, centreX, centreY), true);
    // Anywhere within the tile counts — a character rests wherever it stopped, not on a centre.
    assert.equal(standingOn(pickup, centreX - TILE_SIZE / 2 + 1, centreY + TILE_SIZE / 2 - 1), true);
    // The next tile over does not.
    assert.equal(standingOn(pickup, centreX + TILE_SIZE, centreY), false);
    assert.equal(standingOn(pickup, centreX, centreY - TILE_SIZE), false);
  });
});

describe('what a bare radius can find', () => {
  it('sweeps 45 of a room s 81 tiles, which is what the scatter rate is tuned against', () => {
    // The measurement `PICKUP_ROOM_CHANCE` is argued from: a pickup has to be *lit* to be found, so
    // the useful find rate is the scatter rate times this fraction. Stated here rather than in a
    // comment because it is a fact about the shadowcaster and the room geometry together, and either
    // of them moving re-tunes the scatter rate.
    const origin = grid.roomOrigins.get(8002)!;
    const centreRow = origin.ty + (ROOM_TILES - 1) / 2;

    /** Floor tiles of room 8002 lit at some point while walking its centre row end to end. */
    const sweptAt = (radius: number): number => {
      const lit = new Set<number>();
      for (let tx = origin.tx; tx < origin.tx + ROOM_TILES; tx++) {
        for (const index of computeVisible(grid, tx, centreRow, radius)) lit.add(index);
      }
      let inRoom = 0;
      for (const index of lit) {
        const tx = index % grid.width;
        const ty = Math.floor(index / grid.width);
        if (
          tx >= origin.tx &&
          tx < origin.tx + ROOM_TILES &&
          ty >= origin.ty &&
          ty < origin.ty + ROOM_TILES
        ) {
          inRoom++;
        }
      }
      return inRoom;
    };

    const floor = ROOM_TILES * ROOM_TILES;
    assert.equal(sweptAt(DEFAULT_LIGHT_RADIUS), 45, 'the bare eye misses nearly half of a room');

    // And the reason the rate can afford to be stingy: light compounds. A torch does not merely see
    // further, it makes you strictly better at finding the next one, and a lantern misses nothing in
    // a room it crosses. The first find is the hard one; every one after it is easier.
    assert.equal(sweptAt(DEFAULT_LIGHT_RADIUS + 1), 63, 'a torch sweeps most of it');
    assert.equal(sweptAt(DEFAULT_LIGHT_RADIUS + 2), floor, 'a lantern sweeps all of it');
  });
});

/**
 * Walking onto a light while already carrying one.
 *
 * The decision has real teeth because there is no inventory: whatever is not put in the character's
 * hand is destroyed by the act of stepping on it. So "is this an upgrade" is the wrong question on
 * its own — the right one is "will I see by this for longer than by what I hold".
 */
describe('what a light on the floor is worth', () => {
  const src = (id: string) => {
    const found = LIGHT_SOURCES[id];
    assert.ok(found, `the catalogue has no ${id}`);
    return found;
  };
  const torch = src('torch');
  const candle = src('candle');
  const lantern = src('lantern');
  const everburning = src('everburning_torch');
  const beacon = src('beacon_of_hope');

  it('equips anything at all when the character is in the dark', () => {
    assert.equal(pickupOutcome(undefined, undefined, candle), 'equip');
    assert.equal(pickupOutcome(undefined, undefined, beacon), 'equip');
  });

  it('equips a genuine upgrade and refuses a genuine downgrade', () => {
    assert.equal(pickupOutcome(candle, candle.durationMs, lantern), 'equip', 'radius 4 beats radius 3');
    assert.equal(pickupOutcome(torch, torch.durationMs, everburning), 'equip', 'forever beats four minutes');
    assert.equal(pickupOutcome(torch, torch.durationMs, beacon), 'equip', 'rooms mode is not on the same scale');
    assert.equal(pickupOutcome(lantern, undefined, candle), 'spare', 'a candle is no use to a lantern-bearer');
    assert.equal(pickupOutcome(torch, torch.durationMs, candle), 'spare', 'a fresh torch outlasts a candle');
  });

  it('takes a fresh one of what it holds, rather than reporting it as outshining itself', () => {
    // `bestLight` keeps the incumbent on a tie and the incumbent is the same catalogue object, so
    // this is the case that read as a strict upgrade and announced itself as one.
    assert.equal(pickupOutcome(torch, 12_000, torch), 'refresh');
    // Nothing to reset, so a second one is simply a spare.
    assert.equal(pickupOutcome(lantern, undefined, lantern), 'spare');
    assert.equal(pickupOutcome(everburning, undefined, everburning), 'spare');
  });

  it('takes a lesser source that will outlast what is nearly spent', () => {
    // The whole point. A torch with half a second left is worth less, from here on, than a candle.
    assert.equal(pickupOutcome(torch, 500, candle), 'replace');
    assert.equal(pickupOutcome(torch, candle.durationMs! - 1, candle), 'replace');
    // And the moment it is not, it goes back to being a spare — no cliff, no window where both
    // answers look right.
    assert.equal(pickupOutcome(torch, candle.durationMs!, candle), 'spare');
    assert.equal(pickupOutcome(torch, candle.durationMs! + 1, candle), 'spare');
  });

  it('never trades away a kind of seeing, however little of it is left', () => {
    // A beacon's last tick is still whole rooms through walls, and it crumbles to a torch by itself.
    assert.equal(pickupOutcome(beacon, 1, torch), 'spare');
    assert.equal(pickupOutcome(beacon, 1, candle), 'spare');
    // Nor a radius, for time: a lantern reaches every exit of a room and a torch does not.
    assert.equal(pickupOutcome(lantern, undefined, torch), 'spare');
  });

  it('treats an unlimited source as unlimited, not as nothing left', () => {
    // `undefined` remaining is the everburning case, and reading it as 0 would have every character
    // trade their permanent light for the first candle they trod on.
    assert.equal(pickupOutcome(everburning, undefined, candle), 'spare');
    assert.equal(pickupOutcome(everburning, undefined, torch), 'spare');
  });
});

describe('remembering what a character has taken', () => {
  function makeStore(): { store: PlayerStore; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-pickups-'));
    return { store: new PlayerStore({ dir }), dir };
  }

  it('records a taken pickup once, and says so the second time', () => {
    // The second answer is what stops a character standing on a torch's tile for two ticks from
    // announcing two finds and re-lighting an already-lit torch.
    const { store } = makeStore();
    const record = store.load('Finder');
    const key = pickupKey(8002);

    assert.equal(store.hasTaken(record, key), false);
    assert.equal(store.markTaken(record, key), true);
    assert.equal(store.hasTaken(record, key), true);
    assert.equal(store.markTaken(record, key), false, 'taking it twice is not two pickups');
  });

  it('survives a restart, which is the only reason it is persisted at all', () => {
    // Placement is recomputed rather than stored, so without this a restart would put every torch a
    // character has ever collected back on the floor for them.
    const { store, dir } = makeStore();
    const record = store.load('Restarter');
    store.markTaken(record, pickupKey(8001));
    store.markTaken(record, pickupKey(8003));
    store.flush(record);

    const saved = JSON.parse(readFileSync(join(dir, `${slugify('Restarter')}.json`), 'utf8')) as {
      taken?: string[];
    };
    assert.deepEqual(saved.taken, ['r8001', 'r8003']);

    const reloaded = new PlayerStore({ dir }).load('Restarter');
    assert.equal(reloaded.taken.has(pickupKey(8001)), true);
    assert.equal(reloaded.taken.has(pickupKey(8003)), true);
    assert.equal(reloaded.taken.has(pickupKey(8002)), false, 'a room they never emptied stays full');
  });

  it('is per character, so one player taking a torch leaves another s where it was', () => {
    // The deliberate simplification. A pickup is a property of a room rather than an object in it,
    // so there is nothing for two characters to race over — see the header of `pickups.ts`.
    const { store } = makeStore();
    const mine = store.load('Alice');
    const yours = store.load('Bob');
    const key = pickupKey(8002);

    store.markTaken(mine, key);
    assert.equal(store.hasTaken(mine, key), true);
    assert.equal(store.hasTaken(yours, key), false);
    // And the room itself is unchanged: it still holds exactly what it always held.
    assert.deepEqual(pickupInRoom(grid, 8002), pickupInRoom(grid, 8002));
  });

  it('reads a save written before pickups existed as having taken nothing', () => {
    // No migration is possible and none is needed — an old save records no such thing, and an empty
    // set is exactly right: that character has emptied no rooms.
    const { store, dir } = makeStore();
    const record = store.load('Oldtimer');
    store.markTaken(record, pickupKey(8001));
    store.flush(record);

    // Strip the field the way a pre-v5 file would not have had it.
    const path = join(dir, `${slugify('Oldtimer')}.json`);
    const stored = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete stored['taken'];
    writeFileSync(path, JSON.stringify(stored));

    const reloaded = new PlayerStore({ dir }).load('Oldtimer');
    assert.equal(reloaded.taken.size, 0);
  });
});
