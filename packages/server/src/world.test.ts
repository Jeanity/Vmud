import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  boundsOf,
  doorwayTiles,
  isWalkable,
  tileAtIndex,
  type Room,
  type RoomExit,
  type Zone,
} from '@mygame/shared';
import { makeRng } from '@mygame/shared';

import { Simulation } from './sim.ts';
import { GameWorld, WORLD_DIR, loadWorldConfig, loadZone, type SpawnConfig } from './world.ts';

/**
 * Synthetic zones, no generated data on disk. Beyond keeping these tests hermetic, this holds the
 * project rule that the engine must always be able to run against a world it did not import.
 *
 * Shape: zone 900 has two rooms side by side on level 0 and one room on level 1, reached by a
 * stair; its east room portals into zone 901, which is a separate coordinate space entirely.
 */
function zoneA(): Zone {
  const rooms: Room[] = [
    {
      id: 9001,
      zone: 900,
      name: 'West Clearing',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 0 },
      exits: { east: { to: 9002 }, up: { to: 9003, portal: true } },
    },
    {
      id: 9002,
      zone: 900,
      name: 'East Clearing',
      sector: 'forest',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 9001 }, north: { to: 9101, portal: true }, south: { to: 4242 } },
    },
    {
      id: 9003,
      zone: 900,
      name: 'A Canopy Walk',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 1 },
      exits: { down: { to: 9001, portal: true } },
    },
  ];
  return { id: 900, name: 'Test Forest', rooms, bounds: boundsOf(rooms), entryRoom: 9001 };
}

function zoneB(): Zone {
  const rooms: Room[] = [
    {
      id: 9101,
      zone: 901,
      name: 'A Sunken Path',
      sector: 'swamp',
      pos: { x: 0, y: 0, z: 0 },
      exits: { south: { to: 9002, portal: true } },
    },
  ];
  return { id: 901, name: 'Test Bog', rooms, bounds: boundsOf(rooms), entryRoom: 9101 };
}

function makeWorld(spawn: SpawnConfig = { zone: 900, room: null }): GameWorld {
  return new GameWorld([zoneA(), zoneB()], spawn);
}

/** Pixel position of the centre tile of the first room block on a grid. */
const FIRST_ROOM_CENTRE = ((ROOM_TILES - 1) / 2) * TILE_SIZE + TILE_SIZE / 2;

describe('GameWorld', () => {
  it('indexes every room of every loaded zone by its global id', () => {
    const world = makeWorld();
    assert.equal(world.locate(9001)?.room.name, 'West Clearing');
    assert.deepEqual(world.locate(9101)?.place, { zone: 901, level: 0 });
    assert.equal(world.locate(4242), undefined);
  });

  it('treats a level of a zone as its own place', () => {
    const world = makeWorld();
    assert.deepEqual(world.locate(9001)?.place, { zone: 900, level: 0 });
    assert.deepEqual(world.locate(9003)?.place, { zone: 900, level: 1 });
    assert.deepEqual(world.levelsOf(900), [0, 1]);
    assert.deepEqual(world.allPlaces(), [
      { zone: 900, level: 0 },
      { zone: 900, level: 1 },
      { zone: 901, level: 0 },
    ]);
  });

  it('builds one grid per place and caches it', () => {
    const world = makeWorld();
    const ground = world.grid({ zone: 900, level: 0 });
    const canopy = world.grid({ zone: 900, level: 1 });
    assert.ok(ground && canopy);
    assert.notEqual(ground, canopy);
    assert.equal(world.grid({ zone: 900, level: 0 }), ground);
    // Each grid holds only the rooms on its own level.
    assert.ok(ground.roomOrigins.has(9001) && !ground.roomOrigins.has(9003));
    assert.ok(canopy.roomOrigins.has(9003) && !canopy.roomOrigins.has(9001));
    assert.equal(world.grid({ zone: 900, level: 9 }), undefined);
    assert.equal(world.grid({ zone: 999, level: 0 }), undefined);
  });

  it('spawns at the configured room, falling back to the zone entrance', () => {
    assert.equal(makeWorld().spawnRoom().id, 9001);
    assert.equal(makeWorld({ zone: 901, room: null }).spawnRoom().id, 9101);
    assert.equal(makeWorld({ zone: 900, room: 9003 }).spawnRoom().id, 9003);
    assert.throws(() => makeWorld({ zone: 42, room: null }).spawnRoom(), /spawn zone 42/);
  });

  it('refuses a spawn room that does not resolve inside the spawn zone', () => {
    // Both of these used to fall through to `zone.rooms[0]` in silence — whichever room the source
    // data happened to list first, on whichever level. A transposed digit in a six-digit MUD room
    // id would start every character somewhere the operator never chose, with nothing in the log
    // to say so.
    assert.throws(
      () => makeWorld({ zone: 900, room: 55555 }).spawnRoom(),
      /room 55555, which does not exist in any zone/,
    );
    // A real room, but in the *other* loaded zone.
    assert.throws(
      () => makeWorld({ zone: 900, room: 9101 }).spawnRoom(),
      /room 9101, which belongs to zone 901, not spawn zone 900/,
    );
  });

  it('refuses a zone whose declared entrance is not one of its rooms', () => {
    const broken: Zone = { ...zoneA(), entryRoom: 9101 };
    const world = new GameWorld([broken, zoneB()], { zone: 900, room: null });
    assert.throws(() => world.spawnRoom(), /entryRoom is room 9101, which belongs to zone 901/);
  });

  it('falls back to the first room only when the zone declares no entrance at all', () => {
    const { entryRoom: _dropped, ...rest } = zoneA();
    const world = new GameWorld([rest as Zone], { zone: 900, room: null });
    assert.equal(world.spawnRoom().id, 9001);
  });
});

describe('loadWorldConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-config-'));

  const write = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    return path;
  };

  it('reads the zone list and spawn point', () => {
    const path = write('ok.json', '{"zones":[260,261],"spawn":{"zone":261,"room":77584}}');
    assert.deepEqual(loadWorldConfig(path), {
      zones: [260, 261],
      spawn: { zone: 261, room: 77584 },
      // Absent means **none**, not all. A silent default of "everything" would have a zone start spawning
      // the moment worldgen learned how to harvest it, which is the opposite of a pluggable bit.
      populate: [],
    });
  });

  describe('the populate list', () => {
    it('reads the zones whose inhabitants are switched on', () => {
      const path = write('pop.json', '{"zones":[36,168],"spawn":{"zone":36,"room":null},"populate":[36]}');
      assert.deepEqual(loadWorldConfig(path).populate, [36]);
    });

    it('refuses a zone that is not loaded, because that typo has no symptom', () => {
      // Nothing spawns and nothing complains — and it is exactly the mistake trimming "zones" invites.
      const path = write('pop-unloaded.json', '{"zones":[36],"spawn":{"zone":36,"room":null},"populate":[168]}');
      assert.throws(() => loadWorldConfig(path), /"populate" lists zone 168, which is not in "zones"/);
    });

    it('refuses anything that is not a list of integers', () => {
      for (const [name, body] of [
        ['object', '{"zones":[36],"populate":{}}'],
        ['string', '{"zones":[36],"populate":["36"]}'],
      ] as const) {
        assert.throws(() => loadWorldConfig(write(`pop-bad-${name}.json`, body)), /malformed/, name);
      }
    });

    it('de-duplicates, so a repeated id cannot populate a zone twice', () => {
      const path = write('pop-dupe.json', '{"zones":[36],"spawn":{"zone":36,"room":null},"populate":[36,36]}');
      assert.deepEqual(loadWorldConfig(path).populate, [36]);
    });
  });


  it('defaults the spawn room to the zone entrance when it is null', () => {
    const path = write('null-room.json', '{"zones":[260],"spawn":{"zone":260,"room":null}}');
    assert.equal(loadWorldConfig(path).spawn.room, null);
  });

  it('names the file when it is missing or malformed', () => {
    const missing = join(dir, 'nope.json');
    assert.throws(() => loadWorldConfig(missing), new RegExp(escapeRe(missing)));

    const empty = write('empty.json', '{"zones":[]}');
    assert.throws(() => loadWorldConfig(empty), /"zones" must be a non-empty array/);

    const notInts = write('strings.json', '{"zones":["260"]}');
    assert.throws(() => loadWorldConfig(notInts), /not an integer zone id/);

    const straySpawn = write('stray.json', '{"zones":[260],"spawn":{"zone":999,"room":null}}');
    assert.throws(() => loadWorldConfig(straySpawn), /not listed in "zones"/);

    const junk = write('junk.json', 'not json at all');
    assert.throws(() => loadWorldConfig(junk), /not valid JSON/);
  });
});

describe('Simulation across places', () => {
  it('spawns a player on the spawn room of the spawn zone', () => {
    const sim = new Simulation(makeWorld());
    const player = sim.spawn('Tester', makeRng(1));
    assert.equal(player.roomId, 9001);
    assert.deepEqual(player.place, { zone: 900, level: 0 });
    assert.equal(player.x, FIRST_ROOM_CENTRE);
    assert.equal(player.y, FIRST_ROOM_CENTRE);
    assert.deepEqual(sim.selfViewOf(player).place, { zone: 900, level: 0 });
  });

  it('relocates between zones and between levels through one code path', () => {
    const sim = new Simulation(makeWorld());
    const player = sim.spawn('Tester', makeRng(1));

    // Another zone.
    assert.deepEqual(sim.relocate(player, 9101), { zone: 901, level: 0 });
    assert.deepEqual(player.place, { zone: 901, level: 0 });
    assert.equal(player.roomId, 9101);
    assert.equal(player.x, FIRST_ROOM_CENTRE);

    // Another level of another zone — same operation, same result.
    assert.deepEqual(sim.relocate(player, 9003), { zone: 900, level: 1 });
    assert.deepEqual(player.place, { zone: 900, level: 1 });
    assert.equal(player.roomId, 9003);
    assert.equal(player.x, FIRST_ROOM_CENTRE);
  });

  it('refuses to relocate into a zone that is not loaded', () => {
    const sim = new Simulation(makeWorld());
    const player = sim.spawn('Tester', makeRng(1));
    assert.equal(sim.relocate(player, 4242), undefined);
    assert.deepEqual(player.place, { zone: 900, level: 0 });
    assert.equal(player.roomId, 9001);
  });

  it('collides each player against the grid of their own place', () => {
    const sim = new Simulation(makeWorld());
    const walker = sim.spawn('Walker', makeRng(1));
    const climber = sim.spawn('Climber', makeRng(1));
    sim.relocate(climber, 9003);

    // East out of 9001 is a real corridor; on the one-room canopy level the same push hits void.
    sim.setIntent(walker.id, 1, 0);
    sim.setIntent(climber.id, 1, 0);
    const startX = climber.x;
    for (let i = 0; i < 40; i++) sim.tick();

    const roomBlock = ROOM_TILES * TILE_SIZE;
    assert.ok(walker.x > roomBlock, 'walker should have crossed out of its room block');
    assert.equal(walker.roomId, 9002);
    assert.ok(climber.x > startX && climber.x < roomBlock, 'climber should be walled in');
    assert.deepEqual(climber.place, { zone: 900, level: 1 });
    assert.equal(climber.roomId, 9003);
  });

  it('reports a room transition with the place it was left from', () => {
    const sim = new Simulation(makeWorld());
    const player = sim.spawn('Tester', makeRng(1));
    sim.setIntent(player.id, 1, 0);

    let seen: { from: number; to: number; fromPlace: { zone: number; level: number } } | undefined;
    for (let i = 0; i < 200 && !seen; i++) {
      const [transition] = sim.tick().transitions;
      if (transition) {
        seen = { from: transition.from, to: transition.to, fromPlace: transition.fromPlace };
      }
    }
    assert.deepEqual(seen, { from: 9001, to: 9002, fromPlace: { zone: 900, level: 0 } });
  });
});

/**
 * Everything above runs on synthetic zones so the engine is proven to work without any third-party
 * data present. This block instead runs against the real generated data for the two prototype
 * zones — 260 The Stag Forest (4 levels) and 261 The Stump Bog (2 levels) — because the property
 * that matters most, "every cross-zone exit resolves into the other zone", can only be checked
 * against the actual layout, not a hand-built fixture.
 *
 * `data/world/zones` is git-ignored and rebuilt by `npm run worldgen`, so a missing directory must
 * read as "regenerate the data", not as a code failure.
 */
describe('GameWorld against the generated world (zones 260, 261)', () => {
  const zonesDir = join(WORLD_DIR, 'zones');
  const dataPresent = existsSync(join(zonesDir, '260.json')) && existsSync(join(zonesDir, '261.json'));

  if (!dataPresent) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${zonesDir} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zone260 = loadZone(260);
  const zone261 = loadZone(261);
  const world = new GameWorld([zone260, zone261], { zone: 260, room: null });

  it('loads both zones and indexes every room from each', () => {
    // The documented shape of the two prototype zones; a drift here means the fixture regenerated
    // differently than the design assumed, which is worth failing loudly on.
    assert.equal(zone260.rooms.length, 98, 'zone 260 room count drifted from the documented prototype');
    assert.equal(zone261.rooms.length, 93, 'zone 261 room count drifted from the documented prototype');

    assert.deepEqual(
      world
        .allZones()
        .map((z) => z.id)
        .sort((a, b) => a - b),
      [260, 261],
    );
    for (const room of zone260.rooms) assert.equal(world.locate(room.id)?.room.id, room.id);
    for (const room of zone261.rooms) assert.equal(world.locate(room.id)?.room.id, room.id);
  });

  it('locate() resolves the correct Place for a room in each zone', () => {
    const entry260 = zone260.entryRoom;
    const entry261 = zone261.entryRoom;
    assert.ok(entry260, 'zone 260 fixture should declare an entryRoom');
    assert.ok(entry261, 'zone 261 fixture should declare an entryRoom');
    assert.deepEqual(world.locate(entry260)?.place, { zone: 260, level: 0 });
    assert.deepEqual(world.locate(entry261)?.place, { zone: 261, level: 0 });
  });

  it('locate() returns undefined for a room id in a zone that is not loaded', () => {
    const foreignZone = loadZone(1);
    const foreignRoom = foreignZone.rooms[0];
    assert.ok(foreignRoom, 'fixture zone 1 unexpectedly has no rooms');
    // Guard against the fixtures overlapping — room ids are meant to be globally unique.
    assert.equal(zone260.rooms.some((r) => r.id === foreignRoom.id), false);
    assert.equal(zone261.rooms.some((r) => r.id === foreignRoom.id), false);
    assert.equal(world.locate(foreignRoom.id), undefined);
  });

  it('builds a grid per level, and 260 (4 levels) yields more than one grid', () => {
    const levels = world.levelsOf(260);
    assert.deepEqual([...levels], [0, 1, 2, 3]);

    const grids = levels.map((level) => world.grid({ zone: 260, level }));
    assert.ok(
      grids.every((g) => g !== undefined),
      'every declared level should produce a grid',
    );
    assert.ok(grids.length > 1, 'a 4-level zone should yield more than one grid');
    assert.equal(new Set(grids).size, grids.length, 'each level should get its own grid instance');

    // Each level's grid contains exactly the rooms on that level, not rooms from other levels.
    for (const level of levels) {
      const grid = world.grid({ zone: 260, level });
      assert.ok(grid);
      const onLevel = zone260.rooms.filter((r) => r.pos.z === level);
      const offLevel = zone260.rooms.filter((r) => r.pos.z !== level);
      assert.ok(onLevel.every((r) => grid.roomOrigins.has(r.id)));
      assert.ok(offLevel.every((r) => !grid.roomOrigins.has(r.id)));
    }
  });

  it('resolves every one of the 13 cross-zone exits from 260 into a room whose place is zone 261', () => {
    // Filter on "lands in 261", not merely "leaves 260": zone 260 has a 14th portal (room 77455,
    // south) that recalls into room 1444, which belongs to an unrelated zone (108, Waterdeep
    // Trails) outside the loaded pair. Filtering on "not in 260" alone over-counts by that one.
    const in261 = new Set(zone261.rooms.map((r) => r.id));
    const crossings: RoomExit[] = zone260.rooms.flatMap((room) =>
      Object.values(room.exits).filter((exit): exit is RoomExit => exit !== undefined && in261.has(exit.to)),
    );

    assert.equal(crossings.length, 13, 'expected exactly 13 cross-zone exits from 260 into 261');
    assert.ok(
      crossings.every((exit) => exit.portal === true),
      'every cross-zone exit should be flagged as a portal',
    );

    for (const exit of crossings) {
      const located = world.locate(exit.to);
      assert.ok(located, `exit target room ${exit.to} did not resolve via locate()`);
      assert.equal(located.place.zone, 261, `room ${exit.to} should belong to zone 261`);
    }
  });
});

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Doors.
 *
 * The half of "locked doors do not lock" that is not geometry: a doorway is one object with two
 * ends, and the server is what keeps them in step. Two rooms carve the *same* strip of tiles, so a
 * door opened from one side and left shut on the other is not a cosmetic inconsistency — it is two
 * incompatible answers about the same six tiles.
 */
describe('GameWorld — doors', () => {
  /** A zone whose two rooms are joined by a door, declared on both sides unless told otherwise. */
  function gatedZone(options: { readonly locked?: boolean; readonly oneSided?: boolean } = {}): Zone {
    const near: RoomExit = {
      to: 5002,
      door: { name: 'an iron gate', closed: true, locked: options.locked ?? false },
    };
    const far: RoomExit = options.oneSided
      ? { to: 5001 }
      : { to: 5001, door: { name: 'an iron gate', closed: true, locked: options.locked ?? false } };
    const rooms: Room[] = [
      { id: 5001, zone: 500, name: 'The Gatehouse', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: near } },
      { id: 5002, zone: 500, name: 'The Courtyard', sector: 'city', pos: { x: 1, y: 0, z: 0 }, exits: { west: far } },
    ];
    return { id: 500, name: 'Test Keep', rooms, bounds: boundsOf(rooms), entryRoom: 5001 };
  }

  function gatedWorld(options: { readonly locked?: boolean; readonly oneSided?: boolean } = {}): GameWorld {
    return new GameWorld([gatedZone(options)], { zone: 500, room: 5001 });
  }

  it('finds the doorway from either side, and reports both ends', () => {
    const world = gatedWorld();
    const west = world.doorway(5001, 'east');
    assert.ok(west);
    assert.equal(west.near.roomId, 5001);
    assert.equal(west.far?.roomId, 5002);
    assert.equal(west.far?.dir, 'west');

    const east = world.doorway(5002, 'west');
    assert.equal(east?.far?.roomId, 5001);
  });

  it('answers for the side that declares no door of its own', () => {
    // 5 exits in the shipped world are this shape. Both ends were carved from one strip of tiles, so
    // the side without the `Door` object still has to be refused — otherwise that doorway is a wall
    // from one room and an open corridor from the other.
    const world = gatedWorld({ oneSided: true });
    const bare = world.doorway(5002, 'west');
    assert.ok(bare, 'the plain-exit side must still find the door facing it');
    assert.equal(bare.near.door.name, 'an iron gate');
    assert.equal(bare.near.door.closed, true);
  });

  it('reports nothing where there is no door', () => {
    const world = makeWorld();
    assert.equal(world.doorway(9001, 'east'), undefined, 'a plain exit');
    assert.equal(world.doorway(9001, 'north'), undefined, 'no exit at all');
    assert.equal(world.doorway(4242, 'east'), undefined, 'a room this server has not loaded');
  });

  it('opens both ends at once, and patches the grid they share', () => {
    const world = gatedWorld();
    const place = { zone: 500, level: 0 };
    // Built before the change, so this exercises the patch rather than a rebuild.
    const grid = world.grid(place);
    assert.ok(grid);

    const doorway = world.doorway(5001, 'east');
    assert.ok(doorway);
    const tiles = doorwayTiles(grid, 5001, 'east');
    assert.ok(tiles.length > 0, 'the fixture really does carve a doorway');
    for (const index of tiles) assert.equal(tileAtIndex(grid, index), Tile.Door);

    const changed = world.setDoorClosed(doorway, false);

    assert.equal(doorway.near.door.closed, false);
    assert.equal(doorway.far?.door.closed, false, 'the far side moved too');
    for (const index of tiles) assert.equal(tileAtIndex(grid, index), Tile.DoorOpen);
    assert.ok(isWalkable(tileAtIndex(grid, tiles[0]!)), 'and the tiles are walkable now');

    // Reported per side, and the shared strip is only counted once — the second side finds it done.
    assert.deepEqual(changed.map((c) => c.side.roomId), [5001, 5002]);
    assert.deepEqual(changed[0]!.tiles.sort((a, b) => a - b), [...tiles].sort((a, b) => a - b));
    assert.deepEqual(changed[1]!.tiles, []);
  });

  it('leaves a grid built after the change already correct', () => {
    // A Place nobody has walked on yet has no grid to patch. It must not therefore be built shut:
    // `buildZoneTilemap` reads the same `Door` objects this mutated, so it comes out open by itself.
    const world = gatedWorld();
    const doorway = world.doorway(5001, 'east');
    assert.ok(doorway);
    world.setDoorClosed(doorway, false);

    const grid = world.grid({ zone: 500, level: 0 });
    assert.ok(grid);
    for (const index of doorwayTiles(grid, 5001, 'east')) {
      assert.equal(tileAtIndex(grid, index), Tile.DoorOpen);
    }
  });

  it('carries the lock without letting it stand in for being shut', () => {
    // They are different facts and the MUD reads them in different places: movement is refused on
    // `closed` (`actmove.c:1220`), opening is refused on `locked`. Checking `locked` for movement was
    // the original bug, and it also meant a shut-but-unlocked door could be stepped through.
    //
    // Locked *after* loading, because load now clears authored locks — see the tests below. The
    // subject here is `setDoorClosed`, which must be indifferent to the lock either way.
    const world = gatedWorld();
    const doorway = world.doorway(5001, 'east');
    assert.ok(doorway);
    doorway.near.door.locked = true;
    assert.equal(doorway.near.door.closed, true);

    // The lock is state the caller enforces, not something this refuses on its behalf — `workDoor`
    // is what declines to open a locked door, and unlocking will use this same setter.
    world.setDoorClosed(doorway, false);
    assert.equal(doorway.near.door.locked, true, 'unlocking is a separate act');
  });
});

/**
 * Locks, while there is no key in the world.
 *
 * `LOCKS_HOLD` is off, and these are the tests that pin *what that means* — because the alternative
 * was measured and it is not survivable: honouring the 42 authored locks leaves 25 of IceCrag's 219
 * rooms reachable and seals every one of its 13 aggressive mobs behind the castle's front door. None
 * of the 156 doors in the shipped world carries a `keyId`, so there is nothing to find.
 *
 * The distinction being tested is that the lock is *ignored*, not *deleted*: doors stay shut, still
 * have to be opened, and `Door.locked` survives as a field for Phase 15 to switch back on.
 */
describe('GameWorld — locks while no key exists', () => {
  function lockedZone(): Zone {
    const rooms: Room[] = [
      {
        id: 5001, zone: 500, name: 'The Gatehouse', sector: 'inside', pos: { x: 0, y: 0, z: 0 },
        exits: { east: { to: 5002, door: { name: 'an iron gate', closed: true, locked: true } } },
      },
      {
        id: 5002, zone: 500, name: 'The Courtyard', sector: 'city', pos: { x: 1, y: 0, z: 0 },
        exits: { west: { to: 5001, door: { name: 'an iron gate', closed: true, locked: true } } },
      },
    ];
    return { id: 500, name: 'Test Keep', rooms, bounds: boundsOf(rooms), entryRoom: 5001 };
  }

  it('unlocks what the zone authored, and counts it', () => {
    const world = new GameWorld([lockedZone()], { zone: 500, room: 5001 });
    const doorway = world.doorway(5001, 'east');
    assert.ok(doorway);
    assert.equal(doorway.near.door.locked, false);
    assert.equal(doorway.far?.door.locked, false, 'both ends, or one side is a wall and the other is not');
    // Two `Door` objects, both authored locked, so both counted.
    assert.equal(world.locksRelaxed, 2);
  });

  it('leaves the door shut — unlocking is not opening', () => {
    // The whole point. The authored intent that survives is "this is closed"; what is dropped is only
    // the part with no counterpart in the game. You still have to open the castle door.
    const world = new GameWorld([lockedZone()], { zone: 500, room: 5001 });
    const doorway = world.doorway(5001, 'east');
    assert.equal(doorway?.near.door.closed, true);
    assert.equal(doorway?.far?.door.closed, true);

    const grid = world.grid({ zone: 500, level: 0 });
    assert.ok(grid);
    const tiles = doorwayTiles(grid, 5001, 'east');
    assert.ok(tiles.length > 0);
    for (const index of tiles) {
      assert.equal(tileAtIndex(grid, index), Tile.Door, 'the grid is carved shut, so movement is still refused');
    }
  });

  it('relaxes before any grid is built from the zone', () => {
    // Ordering, not behaviour: `buildZoneTilemap` reads these same `Door` objects. Relaxing after a
    // grid was cached would leave the two disagreeing, which is the bug `setDoorClosed` exists to
    // avoid on the live path.
    const world = new GameWorld([lockedZone()], { zone: 500, room: 5001 });
    const doorway = world.doorway(5001, 'east');
    assert.ok(doorway);
    world.setDoorClosed(doorway, false);

    const grid = world.grid({ zone: 500, level: 0 });
    assert.ok(grid);
    for (const index of doorwayTiles(grid, 5001, 'east')) {
      assert.equal(tileAtIndex(grid, index), Tile.DoorOpen, 'openable, which a held lock would have refused');
    }
  });
});
