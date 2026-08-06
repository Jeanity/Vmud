import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LIGHT_SOURCES,
  SCATTERABLE_LIGHTS,
  bestLight,
  effectiveRadius,
  expiresTo,
  isRoomMode,
  lightSource,
  naturalLightTiles,
  rollScatteredLight,
  roomLightsItself,
  roomLightTiles,
  toCarriedLight,
  type LightSource,
} from './light.ts';
import { makeRng } from './rules.ts';
import {
  CONNECTOR_WIDTH,
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  Tile,
  buildZoneTilemap,
  roomAtTile,
  tileAt,
  type TileGrid,
} from './tilemap.ts';
import { DEFAULT_LIGHT_RADIUS, computeVisible } from './vision.ts';
import { boundsOf, type Room, type RoomId, type Zone } from './world.ts';

/**
 * Synthetic zones only. Beyond keeping these tests readable it exercises the project rule that the
 * engine must run with no third-party world data present.
 */
function makeZone(rooms: readonly Partial<Room>[]): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: 1,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'cave',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
  })) as Room[];
  return { id: 1, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

/** `count` rooms in a west-to-east line, each linked to the next both ways. Ids are 1-based. */
function linkedLine(count: number): Zone {
  return makeZone(
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      pos: { x: i, y: 0, z: 0 },
      exits: {
        ...(i > 0 ? { west: { to: i } } : {}),
        ...(i < count - 1 ? { east: { to: i + 2 } } : {}),
      },
    })),
  );
}

/** Which rooms a lit set touches. Corridor and void tiles report -1 and are dropped. */
function roomsLit(grid: TileGrid, tiles: ReadonlySet<number>): Set<RoomId> {
  const out = new Set<RoomId>();
  for (const index of tiles) {
    const room = roomAtTile(grid, index % grid.width, Math.floor(index / grid.width));
    if (room !== -1) out.add(room);
  }
  return out;
}

const at = (grid: TileGrid, tx: number, ty: number): number => ty * grid.width + tx;

/* -------------------------------------------------------------------------- */

describe('the catalogue', () => {
  it('is internally consistent', () => {
    for (const [key, source] of Object.entries(LIGHT_SOURCES)) {
      assert.equal(source.id, key, `${key} carries a different id`);
      assert.ok(source.radius > 0, `${key} has no radius`);
      assert.ok(source.scatterWeight >= 0, `${key} has a negative scatter weight`);
      if (source.durationMs !== undefined) {
        assert.ok(source.durationMs > 0, `${key} burns for a non-positive time`);
      }
      if (source.expiresTo !== undefined) {
        // A dangling `expiresTo` would silently leave the holder in the dark at the worst moment.
        assert.ok(expiresTo(source), `${key} expires to unknown source ${source.expiresTo}`);
      }
    }
  });

  it('covers the four archetypes the progression is built from', () => {
    const count = Object.keys(LIGHT_SOURCES).length;
    assert.ok(count >= 4 && count <= 6, `catalogue should stay small, has ${count}`);

    // Something cheap and brief, the workhorse, something lasting and rarer, and the beacon.
    assert.ok(LIGHT_SOURCES['candle']!.durationMs! < LIGHT_SOURCES['torch']!.durationMs!);
    assert.ok(LIGHT_SOURCES['candle']!.scatterWeight > LIGHT_SOURCES['torch']!.scatterWeight);
    assert.equal(LIGHT_SOURCES['lantern']!.durationMs, undefined, 'the lantern should not burn out');
    assert.ok(LIGHT_SOURCES['lantern']!.scatterWeight < LIGHT_SOURCES['torch']!.scatterWeight);
    assert.equal(LIGHT_SOURCES['beacon_of_hope']!.mode, 'rooms');
    assert.equal(LIGHT_SOURCES['beacon_of_hope']!.expiresTo, 'torch');
    assert.ok(LIGHT_SOURCES['beacon_of_hope']!.durationMs! <= 30_000, 'the beacon is a moment');
  });

  it('pins the torch to the gap it exists to cross', () => {
    // Not a taste call. ROOM_GAP is 2, so the next room's floor is 3 tiles from your last one: a
    // torch reaches it and the bare eye does not. Changing either number breaks the other.
    assert.equal(LIGHT_SOURCES['torch']!.radius, ROOM_GAP + 1);
    assert.ok(LIGHT_SOURCES['torch']!.radius > DEFAULT_LIGHT_RADIUS);
  });

  it('puts the lantern exactly at "see every exit of your own room"', () => {
    // A room is 9 tiles across, so its centre is 4 from each wall midpoint.
    assert.equal(LIGHT_SOURCES['lantern']!.radius, (ROOM_TILES - 1) / 2);
  });

  it('looks sources up by id, and refuses inherited properties', () => {
    assert.equal(lightSource('torch'), LIGHT_SOURCES['torch']);
    assert.equal(lightSource('nonesuch'), undefined);
    // Ids arrive off the wire and out of save files; `Record<string, …>` would otherwise hand back
    // `Object.prototype.toString` typed as a LightSource.
    assert.equal(lightSource('toString'), undefined);
    assert.equal(lightSource('constructor'), undefined);
    assert.equal(lightSource('__proto__'), undefined);
  });

  it('resolves what a source leaves behind', () => {
    assert.equal(expiresTo(LIGHT_SOURCES['beacon_of_hope']!), LIGHT_SOURCES['torch']);
    // A torch expires to nothing at all — that drop back to the bare radius is the whole tension.
    assert.equal(expiresTo(LIGHT_SOURCES['torch']!), undefined);
  });
});

describe('the torch against the real geometry', () => {
  it('sees into the next room from the doorway, where the bare eye cannot', () => {
    const grid = buildZoneTilemap(linkedLine(2));
    // Standing on the last floor column of room 1, on the corridor's centre row.
    const doorway = { tx: ROOM_TILES - 1, ty: (ROOM_TILES - 1) / 2 };
    const nextFloor = { tx: ROOM_STRIDE, ty: doorway.ty };
    assert.equal(roomAtTile(grid, nextFloor.tx, nextFloor.ty), 2, 'fixture: that is room 2s floor');

    const bare = computeVisible(grid, doorway.tx, doorway.ty, effectiveRadius(undefined));
    assert.ok(
      !bare.has(at(grid, nextFloor.tx, nextFloor.ty)),
      'with no light the next room must still be dark',
    );

    const torch = computeVisible(grid, doorway.tx, doorway.ty, effectiveRadius(LIGHT_SOURCES['torch']));
    assert.ok(
      torch.has(at(grid, nextFloor.tx, nextFloor.ty)),
      'a torch is what opens up the room ahead',
    );
  });
});

describe('bestLight', () => {
  const torch = LIGHT_SOURCES['torch']!;
  const candle = LIGHT_SOURCES['candle']!;
  const lantern = LIGHT_SOURCES['lantern']!;
  const everburning = LIGHT_SOURCES['everburning_torch']!;
  const beacon = LIGHT_SOURCES['beacon_of_hope']!;

  it('has nothing to say about nothing', () => {
    assert.equal(bestLight([]), undefined);
    assert.equal(bestLight([undefined, undefined]), undefined);
  });

  it('skips unresolved ids so callers need not filter first', () => {
    assert.equal(bestLight([undefined, torch, lightSource('nonesuch')]), torch);
  });

  it('never sums: two torches are a torch', () => {
    assert.equal(bestLight([torch, torch]), torch);
    assert.equal(effectiveRadius(bestLight([torch, torch])), torch.radius);
  });

  it('prefers the larger radius within a mode', () => {
    assert.equal(bestLight([torch, lantern]), lantern);
    assert.equal(bestLight([lantern, torch]), lantern);
  });

  it('prefers the longer burn at equal radius, unlimited beating any finite one', () => {
    assert.equal(candle.radius, torch.radius, 'fixture: these differ only in duration');
    assert.equal(bestLight([candle, torch]), torch);
    assert.equal(bestLight([torch, everburning]), everburning);
    assert.equal(bestLight([everburning, torch]), everburning);
  });

  it('ranks a rooms source above any radius source, whatever the numbers say', () => {
    // The naive comparison — 1 against 4 — gets this exactly backwards. A room-step is not a tile:
    // the beacon lights every tile of this room and every neighbouring one, through walls.
    assert.ok(beacon.radius < lantern.radius, 'fixture: the beacon has the smaller number');
    assert.equal(bestLight([lantern, beacon]), beacon);
    assert.equal(bestLight([beacon, lantern]), beacon);
    assert.equal(bestLight([candle, torch, everburning, lantern, beacon]), beacon);
  });

  it('does not depend on the order it is handed the candidates', () => {
    const all = [candle, torch, everburning, lantern, beacon];
    for (let i = 0; i < all.length; i++) {
      const rotated = [...all.slice(i), ...all.slice(0, i)];
      assert.equal(bestLight(rotated), beacon, `rotation ${i}`);
      assert.equal(bestLight([...rotated].reverse()), beacon, `reversed rotation ${i}`);
    }
  });

  it('keeps the incumbent on an exact tie', () => {
    const twin: LightSource = { ...torch, id: 'twin', name: 'an identical torch' };
    assert.equal(bestLight([torch, twin]), torch);
    assert.equal(bestLight([twin, torch]), twin);
  });
});

describe('effectiveRadius', () => {
  it('falls back to the bare eye with no source', () => {
    assert.equal(effectiveRadius(undefined), DEFAULT_LIGHT_RADIUS);
  });

  it('is the source radius for a radius source', () => {
    assert.equal(effectiveRadius(LIGHT_SOURCES['torch']), 3);
    assert.equal(effectiveRadius(LIGHT_SOURCES['lantern']), 4);
  });

  it('never returns less than the bare eye', () => {
    // A light cannot make you blinder than no light. Anything that should is not a light source.
    const guttering: LightSource = {
      id: 'guttering',
      name: 'a guttering wick',
      radius: 1,
      mode: 'radius',
      scatterWeight: 0,
    };
    assert.equal(effectiveRadius(guttering), DEFAULT_LIGHT_RADIUS);
  });

  it('converts a rooms source into tiles instead of shipping its room-step count', () => {
    const beacon = LIGHT_SOURCES['beacon_of_hope']!;
    // Returning the raw 1 would put a legendary artefact below the naked eye on the wire.
    assert.ok(effectiveRadius(beacon) > DEFAULT_LIGHT_RADIUS);
    assert.equal(effectiveRadius(beacon), beacon.radius * ROOM_STRIDE);
    assert.ok(isRoomMode(beacon));
    assert.ok(!isRoomMode(LIGHT_SOURCES['torch']));
    assert.ok(!isRoomMode(undefined));
  });
});

describe('roomLightTiles', () => {
  it('lights only the room you stand in at zero steps', () => {
    const zone = linkedLine(3);
    const grid = buildZoneTilemap(zone);
    const lit = roomLightTiles(grid, zone, 2, 0);

    assert.deepEqual(roomsLit(grid, lit), new Set([2]));
    // Exactly the floor, and no corridor stub pointing at a dark room.
    assert.equal(lit.size, ROOM_TILES * ROOM_TILES);
  });

  it('covers exactly the rooms within N steps and no more', () => {
    const zone = linkedLine(5);
    const grid = buildZoneTilemap(zone);

    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 3, 1)), new Set([2, 3, 4]));
    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 3, 2)), new Set([1, 2, 3, 4, 5]));
    // A radius past the component saturates rather than running off the grid.
    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 3, 99)), new Set([1, 2, 3, 4, 5]));
    // The walk is symmetric: from an end room, one step reaches one neighbour.
    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 1, 1)), new Set([1, 2]));
  });

  it('lights the corridors between lit rooms, and only those', () => {
    const zone = linkedLine(5);
    const grid = buildZoneTilemap(zone);
    const lit = roomLightTiles(grid, zone, 3, 1);

    const midRow = (ROOM_TILES - 1) / 2;
    // Rooms 2 and 3 are both lit, so the gap between them is too.
    for (let step = 0; step < ROOM_GAP; step++) {
      const tx = 1 * ROOM_STRIDE + ROOM_TILES + step;
      assert.equal(tileAt(grid, tx, midRow), Tile.Connector, `fixture: ${tx},${midRow} is a corridor`);
      assert.ok(lit.has(at(grid, tx, midRow)), `corridor tile ${tx} between two lit rooms`);
    }
    // Room 1 is dark, so the corridor running to it stays dark — a lit stub pointing into nothing
    // reads as a rendering fault, not as a spell.
    for (let step = 0; step < ROOM_GAP; step++) {
      const tx = ROOM_TILES + step;
      assert.equal(tileAt(grid, tx, midRow), Tile.Connector, `fixture: ${tx},${midRow} is a corridor`);
      assert.ok(!lit.has(at(grid, tx, midRow)), `corridor tile ${tx} runs to an unlit room`);
    }

    // Three room floors plus two corridors, counted exactly. Both ends of a link carve the same
    // strip, so a double-counted corridor would show up here.
    assert.equal(lit.size, 3 * ROOM_TILES * ROOM_TILES + 2 * ROOM_GAP * CONNECTOR_WIDTH);
  });

  it('never lights void', () => {
    const zone = linkedLine(4);
    const grid = buildZoneTilemap(zone);
    for (const index of roomLightTiles(grid, zone, 2, 2)) {
      const tx = index % grid.width;
      const ty = Math.floor(index / grid.width);
      assert.notEqual(tileAt(grid, tx, ty), Tile.Void, `lit the void at ${tx},${ty}`);
    }
  });

  it('stops at a neighbour that is adjacent but unlinked', () => {
    // Room 3 sits directly south of room 1 with no exit between them. The beacon follows topology,
    // not geometry — `buildZoneTilemap` leaves solid void in that gap.
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
      { id: 3, pos: { x: 0, y: 1, z: 0 }, exits: {} },
    ]);
    const grid = buildZoneTilemap(zone);
    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 1, 5)), new Set([1, 2]));
  });

  it('does not leak across a portal to another Place', () => {
    // The far side is on this grid and is the geometric neighbour, so nothing but the portal flag
    // stops this. A portal is a transition, not a corridor.
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, portal: true } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, portal: true } } },
    ]);
    const grid = buildZoneTilemap(zone);
    assert.ok(grid.roomOrigins.has(2), 'fixture: room 2 is laid out on this grid');

    const lit = roomLightTiles(grid, zone, 1, 5);
    assert.deepEqual(roomsLit(grid, lit), new Set([1]));
    assert.equal(lit.size, ROOM_TILES * ROOM_TILES);
  });

  it('does not follow an exit to another level', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { up: { to: 2 } } },
      { id: 2, pos: { x: 0, y: 0, z: 1 }, exits: { down: { to: 1 } } },
    ]);
    const ground = buildZoneTilemap(zone, 0);
    assert.ok(!ground.roomOrigins.has(2), 'fixture: room 2 is not on the ground level');

    const lit = roomLightTiles(ground, zone, 1, 5);
    assert.deepEqual(roomsLit(ground, lit), new Set([1]));
    assert.equal(lit.size, ROOM_TILES * ROOM_TILES);
  });

  it('does not follow an exit to another zone', () => {
    const zone = makeZone([{ id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 9001 } } }]);
    const grid = buildZoneTilemap(zone);
    assert.equal(roomLightTiles(grid, zone, 1, 5).size, ROOM_TILES * ROOM_TILES);
  });

  it('lights nothing from a room that is not on this grid', () => {
    const zone = linkedLine(2);
    const grid = buildZoneTilemap(zone);
    assert.equal(roomLightTiles(grid, zone, 404, 3).size, 0);

    const zoneWithUpper = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 } },
      { id: 2, pos: { x: 0, y: 0, z: 1 } },
    ]);
    const upper = buildZoneTilemap(zoneWithUpper, 1);
    assert.equal(roomLightTiles(upper, zoneWithUpper, 1, 3).size, 0);
  });

  it('is deterministic, down to the iteration order of the set', () => {
    // The server folds this into `seen` and the client paints from it. Agreeing on the contents but
    // not the order would still be a difference two `seenDelta`s later.
    const zone = linkedLine(4);
    const grid = buildZoneTilemap(zone);
    const first = [...roomLightTiles(grid, zone, 2, 2)];
    const second = [...roomLightTiles(buildZoneTilemap(linkedLine(4)), linkedLine(4), 2, 2)];
    assert.deepEqual(first, second);
    assert.ok(first.length > 0);
  });

  it('does not depend on the order exits were declared in', () => {
    // The room graph is walked in fixed DIRECTIONS order, not in whatever order the `exits` object
    // happens to enumerate — otherwise two builds of the same world could produce two orderings.
    const eastFirst = makeZone([
      { id: 1, pos: { x: 1, y: 0, z: 0 }, exits: { east: { to: 2 }, west: { to: 3 } } },
      { id: 2, pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 1 } } },
      { id: 3, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 1 } } },
    ]);
    const westFirst = makeZone([
      { id: 1, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 3 }, east: { to: 2 } } },
      { id: 2, pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 1 } } },
      { id: 3, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 1 } } },
    ]);
    assert.deepEqual(
      [...roomLightTiles(buildZoneTilemap(eastFirst), eastFirst, 1, 1)],
      [...roomLightTiles(buildZoneTilemap(westFirst), westFirst, 1, 1)],
    );
  });

  it('sees round a corner, which is the whole point of the mode', () => {
    // An L: room 3 is not in line of sight from room 1, and a radius source could never reach it.
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 }, south: { to: 3 } } },
      { id: 3, pos: { x: 1, y: 1, z: 0 }, exits: { north: { to: 2 } } },
    ]);
    const grid = buildZoneTilemap(zone);
    assert.deepEqual(roomsLit(grid, roomLightTiles(grid, zone, 1, 2)), new Set([1, 2, 3]));

    // Every tile of room 3, corners included — a shadowcast from room 1 reaches none of them.
    const beacon = LIGHT_SOURCES['beacon_of_hope']!;
    const lit = roomLightTiles(grid, zone, 1, beacon.radius + 1);
    const origin = grid.roomOrigins.get(3)!;
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        assert.ok(lit.has(at(grid, origin.tx + dx, origin.ty + dy)), `room 3 tile ${dx},${dy}`);
      }
    }
  });

  it('at the beacons own radius, lights this room and its immediate neighbours', () => {
    // Room-radius 1 is exactly the interest-management radius: you see what the server is already
    // streaming you, and nothing beyond it.
    const zone = makeZone([
      { id: 1, pos: { x: 1, y: 1, z: 0 }, exits: { north: { to: 2 }, east: { to: 3 }, south: { to: 4 }, west: { to: 5 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 1 } } },
      { id: 3, pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 1 }, east: { to: 6 } } },
      { id: 4, pos: { x: 1, y: 2, z: 0 }, exits: { north: { to: 1 } } },
      { id: 5, pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 1 } } },
      { id: 6, pos: { x: 3, y: 1, z: 0 }, exits: { west: { to: 3 } } },
    ]);
    const grid = buildZoneTilemap(zone);
    const beacon = LIGHT_SOURCES['beacon_of_hope']!;
    const lit = roomLightTiles(grid, zone, 1, beacon.radius);
    assert.deepEqual(roomsLit(grid, lit), new Set([1, 2, 3, 4, 5]));
    assert.equal(lit.size, 5 * ROOM_TILES * ROOM_TILES + 4 * ROOM_GAP * CONNECTOR_WIDTH);
  });
});

describe('scattering', () => {
  it('never scatters the beacon', () => {
    assert.ok(!SCATTERABLE_LIGHTS.some((s) => s.id === 'beacon_of_hope'));
    assert.ok(SCATTERABLE_LIGHTS.length >= 3);
    for (const source of SCATTERABLE_LIGHTS) assert.ok(source.scatterWeight > 0);
  });

  it('is a pure function of the seed', () => {
    const a = Array.from({ length: 20 }, ((rng) => () => rollScatteredLight(rng)?.id)(makeRng(7)));
    const b = Array.from({ length: 20 }, ((rng) => () => rollScatteredLight(rng)?.id)(makeRng(7)));
    assert.deepEqual(a, b);
    // Every client and every restart must agree on what is lying in a room; `Math.random()` here
    // would give each of them a different torch.
    assert.ok(new Set(a).size > 1, 'the roll should actually vary');
  });

  it('follows the weights', () => {
    const rng = makeRng(20260729);
    const counts = new Map<string, number>();
    const rolls = 4000;
    for (let i = 0; i < rolls; i++) {
      const id = rollScatteredLight(rng)!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const total = SCATTERABLE_LIGHTS.reduce((sum, s) => sum + s.scatterWeight, 0);
    for (const source of SCATTERABLE_LIGHTS) {
      const expected = (source.scatterWeight / total) * rolls;
      const actual = counts.get(source.id) ?? 0;
      assert.ok(
        Math.abs(actual - expected) < Math.max(40, expected * 0.15),
        `${source.id}: expected about ${expected}, got ${actual}`,
      );
    }
    assert.ok((counts.get('candle') ?? 0) > (counts.get('torch') ?? 0), 'candles are the common find');
  });
});

describe('toCarriedLight', () => {
  it('omits remainingMs rather than sending undefined', () => {
    const lantern = toCarriedLight(LIGHT_SOURCES['lantern']!);
    assert.equal('remainingMs' in lantern, false);
    assert.deepEqual(lantern, { id: 'lantern', name: 'a hooded lantern', radius: 4, mode: 'radius' });
  });

  it('carries the mode and a rounded, clamped remainder', () => {
    const beacon = toCarriedLight(LIGHT_SOURCES['beacon_of_hope']!, 12_345.6);
    assert.equal(beacon.mode, 'rooms');
    // The room-step count, not the tile radius: the HUD is describing the object, and
    // `SelfView.lightRadius` is the mechanically meaningful number alongside it.
    assert.equal(beacon.radius, 1);
    assert.equal(beacon.remainingMs, 12_346);
    assert.equal(toCarriedLight(LIGHT_SOURCES['torch']!, -5).remainingMs, 0);
  });
});

describe("rooms that light themselves — the owner's ask, 2026-08-06", () => {
  it('treats an unflagged room as lit and a `dark` one as not', () => {
    // The flag was harvested from the start and read by nothing; 2,283 of 46,508 rooms carry it, so this
    // predicate is what turns 95% of the world from pitch black into daylight.
    assert.equal(roomLightsItself({}), true);
    assert.equal(roomLightsItself({ flags: [] }), true);
    assert.equal(roomLightsItself({ flags: ['safe', 'no_mob'] }), true, 'other flags say nothing about light');
    assert.equal(roomLightsItself({ flags: ['dark'] }), false);
    assert.equal(roomLightsItself({ flags: ['safe', 'dark'] }), false);
  });

  it('says a room that does not exist is not lit, rather than throwing', () => {
    // `locate` misses for a room this server does not load — a cross-zone stub. Dark is the safe answer:
    // it means "your own light is all you have", which is what it was before this rule existed.
    assert.equal(roomLightsItself(undefined), false);
  });

  it("lights the room's own floor and not its neighbours", () => {
    // A lit hall does not light the passage off it. Same derivation as a beacon at zero room-steps, which
    // is why there is no second lighting model to keep in step.
    const zone = twoRooms();
    const grid = buildZoneTilemap(zone);
    const here = naturalLightTiles(grid, zone, 9001 as RoomId);
    const beacon = roomLightTiles(grid, zone, 9001 as RoomId, 0);
    assert.deepEqual([...here].sort((a, b) => a - b), [...beacon].sort((a, b) => a - b));

    // The neighbour's own floor is outside it, which is the whole of "not its neighbours".
    const next = naturalLightTiles(grid, zone, 9002 as RoomId);
    for (const tile of next) assert.equal(here.has(tile), false, 'no tile of the far room is lit from here');
    assert.ok(here.size > 0 && next.size > 0);
  });
});

/** Two linked rooms side by side, the smallest fixture that can tell "this room" from "the next one". */
function twoRooms(): Zone {
  const rooms: Room[] = [
    { id: 9001 as RoomId, zone: 900, name: 'Here', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 9002 as RoomId } } },
    { id: 9002 as RoomId, zone: 900, name: 'There', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 9001 as RoomId } } },
  ];
  return { id: 900, name: 'Pair', rooms, bounds: boundsOf(rooms), entryRoom: 9001 as RoomId };
}
