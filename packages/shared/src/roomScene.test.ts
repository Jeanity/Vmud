/**
 * The scene IR's pure pieces, against synthetic fixtures.
 *
 * `shared` tests may not read `data/world` — the package has no I/O and the world file is git-ignored
 * and reproducible — so everything here is a hand-built zone. The exhaustive sweep over all 46,544
 * real rooms lives in `worldgen/src/roomscene-world.test.ts`, where reading the built world is
 * allowed; the two halves are deliberate, and neither is a substitute for the other. This one pins
 * *behaviour* (what a seam classifies as, what a door does to a blend weight); that one pins
 * *invariants* over data no fixture could stand in for.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CARDINALS,
  GIANT_CEILING,
  GIANT_FOLK_ZONES,
  GROUND_BASE_METRES,
  LEVEL_SEPARATION,
  NO_GROUND_COMPONENT,
  STANDARD_CEILING,
  THEME_COUNT,
  cellIndex,
  describeRoom,
  featureFootprint,
  groundComponents,
  hashCell,
  neighboursOf,
  roomsUnderAStorey,
  sceneSeed,
  sceneZone,
  walkableRequired,
  zoneTheme,
  type Cardinal,
  type RoomScene,
  type SceneZone,
} from './roomScene.ts';
import {
  SCENE_OVERRIDE_VERSION,
  overriddenRooms,
  validateZoneSceneOverrides,
  type ZoneSceneOverrides,
} from './roomScene-overrides.ts';
import { SCATTER_BLOCKS, SCATTER_BLOCK_TILES, SCENERY, scatterFor } from './scenery.ts';
import { CONNECTOR_WIDTH, ROOM_TILES, STAIR_TILES, sceneryOf, stairPlacement } from './tilemap.ts';
import { boundsOf, type Room, type Zone } from './world.ts';

/** A synthetic zone, in the shape `tilemap.test.ts` uses, for the same reason: no world data. */
function makeZone(rooms: readonly Partial<Room>[], zone: Partial<Zone> = {}): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: zone.id ?? 1,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'inside',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
    ...(r.flags ? { flags: r.flags } : {}),
    ...(r.scenery ? { scenery: r.scenery } : {}),
  })) as Room[];
  return {
    id: zone.id ?? 1,
    name: zone.name ?? 'Test Zone',
    rooms: full,
    bounds: boundsOf(full),
    ...(zone.seamless === true ? { seamless: true } : {}),
  };
}

/** Every room of a zone described, the way the dump tool and the world sweep both do it. */
function sceneMap(zone: Zone): Map<number, RoomScene> {
  const context = sceneZone(zone);
  const cells = cellIndex(zone);
  const rooms = new Map(zone.rooms.map((r) => [r.id, r]));
  const out = new Map<number, RoomScene>();
  for (const room of zone.rooms) {
    out.set(room.id, describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room)));
  }
  return out;
}

function sceneOf(zone: Zone, id: number): RoomScene {
  const scene = sceneMap(zone).get(id);
  assert.ok(scene, `fixture has no room ${id}`);
  return scene;
}

/* -------------------------------------------------------------------------- */

describe('hashCell — the determinism contract', () => {
  it('is a pure function of its four arguments', () => {
    assert.equal(hashCell(3, 4, 0), hashCell(3, 4, 0));
    assert.equal(hashCell(3, 4, 0, 7), hashCell(3, 4, 0, 7));
  });

  it('pins its answers, because changing them re-rolls the whole world', () => {
    // Not magic numbers to be updated when they fail: if these move, every landmark, every theme and
    // every component offset in 46,544 rooms moved with them. Re-deriving them is the decision.
    assert.deepEqual(
      [hashCell(0, 0, 0), hashCell(1, 0, 0), hashCell(0, 1, 0), hashCell(0, 0, 1), hashCell(0, 0, 0, 1)],
      [2856213345, 1587646380, 2100341503, 3938591681, 89281271],
    );
  });

  it('separates the three axes and the salt', () => {
    const distinct = new Set([hashCell(1, 2, 3), hashCell(2, 1, 3), hashCell(3, 2, 1), hashCell(1, 2, 3, 1)]);
    assert.equal(distinct.size, 4, 'x/y/z/salt must not be interchangeable');
  });

  it('spreads well enough for a modulo to be usable', () => {
    // The hash is asked for `% 4`, `% 8` and `% 2001`; a hash that clumps on any of those would give
    // a world of landmarks in one corner. 4,096 cells into 8 buckets, no bucket past 20% off even.
    const buckets = new Array<number>(8).fill(0);
    for (let x = 0; x < 64; x++) {
      for (let y = 0; y < 64; y++) buckets[hashCell(x, y, 0) % 8] = (buckets[hashCell(x, y, 0) % 8] ?? 0) + 1;
    }
    for (const count of buckets) assert.ok(count > 410 && count < 615, `bucket ${count} of an even 512`);
  });

  it('folds the zone into the seed, because cell coordinates are per zone here', () => {
    const room = makeZone([{ id: 1, pos: { x: 2, y: 0, z: 0 } }]).rooms[0]!;
    const a: SceneZone = { id: 390 };
    const b: SceneZone = { id: 317 };
    assert.notEqual(sceneSeed(a, room), sceneSeed(b, room), 'two zones must not grow the same forest');
  });
});

describe('zoneTheme', () => {
  it('is in range and stable', () => {
    for (const id of [1, 105, 296, 317, 390, 100001]) {
      const theme = zoneTheme(id);
      assert.ok(Number.isInteger(theme) && theme >= 0 && theme < THEME_COUNT, `${id} -> ${theme}`);
      assert.equal(theme, zoneTheme(id));
    }
  });

  it('uses more than one theme across the zones that exist', () => {
    const seen = new Set<number>();
    for (let id = 1; id <= 423; id++) seen.add(zoneTheme(id));
    assert.equal(seen.size, THEME_COUNT);
  });
});

/* -------------------------------------------------------------------------- */

describe('edge classification', () => {
  it('calls a linked neighbour open, and carves the whole edge between two outdoor rooms', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'open');
    assert.equal(edge.solid, false);
    assert.equal(edge.to, 2);
    assert.deepEqual(edge.mouth, { span: ROOM_TILES, offset: 0, carved: true });
  });

  it('keeps a doorway a doorway, and says whether it is shut and locked', () => {
    const zone = makeZone([
      {
        id: 1,
        sector: 'forest',
        pos: { x: 0, y: 0, z: 0 },
        exits: { east: { to: 2, door: { name: 'a gate', closed: true, locked: true } } },
      },
      { id: 2, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'door');
    assert.equal(edge.closed, true);
    assert.equal(edge.locked, true);
    assert.equal(edge.mouth?.span, CONNECTOR_WIDTH, 'a nine-tile-wide doorway is not a door');
    assert.equal(edge.mouth?.offset, (ROOM_TILES - CONNECTOR_WIDTH) / 2);
  });

  it('calls an occupied cell with no link a barrier, and marks it solid', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 } },
      { id: 2, sector: 'city', pos: { x: 1, y: 0, z: 0 } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'barrier');
    assert.equal(edge.solid, true);
    assert.equal(edge.to, 2);
    assert.equal(edge.sector, 'city');
    assert.equal(edge.mouth, undefined, 'nothing is carved through a barrier');
  });

  it('calls an empty cell an edge — the third of all edges that becomes the tree line', () => {
    const zone = makeZone([{ id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 } }]);
    const scene = sceneOf(zone, 1);
    for (const dir of CARDINALS) {
      assert.equal(scene.edges[dir].kind, 'edge');
      assert.equal(scene.edges[dir].solid, true);
      assert.equal(scene.edges[dir].to, undefined);
    }
    assert.equal(scene.enclosure.solid, 4);
  });

  it('gives a ring only to a portal that is not a seam', () => {
    const zone = makeZone([
      { id: 1, sector: 'cave', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 99, portal: true } } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'portal');
    assert.equal(edge.solid, false);
    assert.equal(edge.to, 99);
    assert.equal(edge.mouth, undefined);
  });

  /**
   * The headline ruling of this milestone. A seam is `portal: true` in the geometry and an ordinary
   * step in the fiction, and the emissive ring is exactly what seams exist to remove — so it must
   * classify as `open`, never as `portal`. Measured on the built world: 5,140 of the 5,142 cardinal
   * portal-shaped edges are seams, so getting this backwards would put a magic gate on every road
   * leaving every zone.
   */
  it('classifies a seam as open, carrying the flag and no carved mouth', () => {
    const zone = makeZone([
      { id: 1, sector: 'road', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 99, portal: true, seam: true } } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'open');
    assert.equal(edge.seam, true);
    assert.equal(edge.solid, false);
    assert.equal(edge.mouth?.carved, false, 'the grid carves nothing across a seam');
    assert.ok(edge.mouth, 'but both sides are still dressed to a width');
  });

  it('classifies a seam that carries a door as a door, still not a portal', () => {
    const zone = makeZone([
      {
        id: 1,
        sector: 'city',
        pos: { x: 0, y: 0, z: 0 },
        exits: { east: { to: 99, portal: true, seam: true, door: { name: 'a gate', closed: false, locked: false } } },
      },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'door');
    assert.equal(edge.seam, true);
  });

  /**
   * 283 directed barriers in the built world have the far room's one-way exit carved through them.
   * Calling those solid would put a wall where the collision grid has a corridor.
   */
  it('opens a barrier the far room links back through, and flags it inbound', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 } },
      { id: 2, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const edge = sceneOf(zone, 1).edges.east;
    assert.equal(edge.kind, 'open');
    assert.equal(edge.inbound, true);
    assert.equal(edge.solid, false);
    assert.equal(edge.mouth?.span, ROOM_TILES);
    // And the far room, which does declare the exit, is an ordinary open edge.
    assert.equal(sceneOf(zone, 2).edges.west.inbound, undefined);
  });

  it('reads a seamless zone as full-edge floor, or a gate where a door stands', () => {
    const zone = makeZone(
      [
        { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
        {
          id: 2,
          sector: 'city',
          pos: { x: 1, y: 0, z: 0 },
          exits: { west: { to: 1 }, east: { to: 3, door: { name: 'a door', closed: true, locked: false } } },
        },
        { id: 3, sector: 'inside', pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 2 } } },
      ],
      { seamless: true },
    );
    const scenes = sceneMap(zone);
    // `city` is not an outdoor sector, so the classic projection would give this a 3-tile neck;
    // `stampSeams` fills the whole shared edge instead, and the IR has to read the projection.
    assert.equal(scenes.get(1)!.edges.east.mouth?.span, ROOM_TILES);
    assert.equal(scenes.get(2)!.edges.east.mouth?.span, CONNECTOR_WIDTH);
  });
});

/* -------------------------------------------------------------------------- */

describe('biome blend', () => {
  it('weights a merged outdoor edge at a half and a doorway at a twelfth', () => {
    const zone = makeZone([
      {
        id: 1,
        sector: 'forest',
        pos: { x: 1, y: 1, z: 0 },
        exits: {
          east: { to: 2 },
          north: { to: 3, door: { name: 'a gate', closed: false, locked: false } },
        },
      },
      { id: 2, sector: 'field', pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 1 } } },
      { id: 3, sector: 'field', pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 1 } } },
    ]);
    const blend = sceneOf(zone, 1).biome.blend;
    assert.deepEqual(blend, [
      { dir: 'north', sector: 'field', weight: 0.083 },
      { dir: 'east', sector: 'field', weight: 0.5 },
    ]);
  });

  it('says nothing about a neighbour whose ground is the same', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    assert.deepEqual(sceneOf(zone, 1).biome.blend, []);
  });

  it('says nothing across a solid side', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 } },
      { id: 2, sector: 'city', pos: { x: 1, y: 0, z: 0 } },
    ]);
    assert.deepEqual(sceneOf(zone, 1).biome.blend, [], 'a barrier blends nothing; it is a wall');
  });

  it('is listed in cardinal order whatever order the neighbours were built in', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 1, y: 1, z: 0 }, exits: { west: { to: 2 }, north: { to: 3 } } },
      { id: 2, sector: 'swamp', pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 1 } } },
      { id: 3, sector: 'desert', pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 1 } } },
    ]);
    assert.deepEqual(
      sceneOf(zone, 1).biome.blend.map((b) => b.dir),
      ['north', 'west'],
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('ground components', () => {
  it('joins linked outdoor rooms and names the region after its smallest room id', () => {
    const zone = makeZone([
      { id: 40, sector: 'field', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 12 } } },
      { id: 12, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 40 }, east: { to: 77 } } },
      { id: 77, sector: 'road', pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 12 } } },
    ]);
    const ground = groundComponents(zone);
    assert.deepEqual([...ground.of.values()], [12, 12, 12]);
    assert.equal(ground.sizes.get(12), 3);
  });

  it('follows a one-way link both ways, so the id does not depend on file order', () => {
    const forward = makeZone([
      { id: 1, sector: 'field', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'field', pos: { x: 1, y: 0, z: 0 } },
    ]);
    const reversed = makeZone([
      { id: 2, sector: 'field', pos: { x: 1, y: 0, z: 0 } },
      { id: 1, sector: 'field', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
    ]);
    assert.deepEqual([...groundComponents(forward).of].sort(), [
      [1, 1],
      [2, 1],
    ]);
    assert.deepEqual([...groundComponents(reversed).of].sort(), [
      [1, 1],
      [2, 1],
    ]);
  });

  it('does not join across an indoor room, a portal or a seam', () => {
    const zone = makeZone([
      { id: 1, sector: 'field', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 }, east: { to: 3 } } },
      { id: 3, sector: 'field', pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 2 } } },
      { id: 4, sector: 'field', pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 5, portal: true, seam: true } } },
      { id: 5, sector: 'field', pos: { x: 1, y: 1, z: 0 } },
    ]);
    const ground = groundComponents(zone);
    assert.equal(ground.of.get(1), 1);
    assert.equal(ground.of.get(3), 3, 'an interior between two fields is two grounds, not one');
    assert.equal(ground.of.get(2), undefined, 'an interior has no shared outdoor ground');
    assert.equal(ground.of.get(4), 4);
    assert.equal(ground.of.get(5), 5, 'a seam crosses a coordinate frame; it does not join ground');
  });

  it('gives every room of a component the same base offset, within range', () => {
    const zone = makeZone([
      { id: 5, sector: 'hills', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 6 } } },
      { id: 6, sector: 'hills', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 5 } } },
    ]);
    const scenes = sceneMap(zone);
    const a = scenes.get(5)!.ground;
    const b = scenes.get(6)!.ground;
    assert.equal(a.component, b.component);
    assert.equal(a.elevation.t, 'continuous');
    assert.equal(b.elevation.t, 'continuous');
    const base = a.elevation.t === 'continuous' ? a.elevation.base : NaN;
    assert.equal(base, b.elevation.t === 'continuous' ? b.elevation.base : NaN);
    assert.ok(Math.abs(base) <= GROUND_BASE_METRES);
  });

  it('leaves an unresolved zone context saying every room has no component', () => {
    // A caller with a bare `Zone` and no `sceneZone()` gets an honest answer rather than a wrong one.
    const zone = makeZone([{ id: 1, sector: 'field', pos: { x: 0, y: 0, z: 0 } }]);
    const scene = describeRoom({ id: 1 }, zone.rooms[0]!, {}, 0);
    assert.equal(scene.ground.component, NO_GROUND_COMPONENT);
    assert.equal(scene.ground.elevation.t === 'continuous' ? scene.ground.elevation.base : NaN, 0);
  });
});

describe('elevation policy', () => {
  it('is continuous under the sky, with a biome-dependent amplitude', () => {
    const zone = makeZone([
      { id: 1, sector: 'hills', pos: { x: 0, y: 0, z: 3 } },
      { id: 2, sector: 'field', pos: { x: 2, y: 0, z: 3 } },
    ]);
    const scenes = sceneMap(zone);
    const hills = scenes.get(1)!.ground.elevation;
    const field = scenes.get(2)!.ground.elevation;
    assert.equal(hills.t, 'continuous');
    assert.equal(field.t, 'continuous');
    assert.ok(
      hills.t === 'continuous' && field.t === 'continuous' && hills.noise.amplitude > field.noise.amplitude,
      'hills must undulate more than a field',
    );
    assert.ok(hills.t === 'continuous' && hills.noise.seed === (field.t === 'continuous' ? field.noise.seed : -1),
      'one noise field for the world, so chunks agree at their seams');
  });

  it('stacks a roofed room at a real height instead of using pos.z as terrain', () => {
    const zone = makeZone([
      { id: 1, sector: 'cave', pos: { x: 0, y: 0, z: 4 } },
      { id: 2, sector: 'field', pos: { x: 2, y: 0, z: 4 }, flags: ['indoors'] },
    ]);
    const scenes = sceneMap(zone);
    for (const id of [1, 2]) {
      const elevation = scenes.get(id)!.ground.elevation;
      assert.equal(elevation.t, 'stacked', `room ${id} has a roof over it`);
      if (elevation.t !== 'stacked') return;
      assert.equal(elevation.level, 4);
      assert.equal(elevation.separation, LEVEL_SEPARATION);
      assert.equal(elevation.height, 4 * LEVEL_SEPARATION);
    }
  });

  it('does not stack a mountainside just because its ground does not merge', () => {
    // `OUTDOOR_SECTORS` and "has a roof" are different questions and this is the room that proves it.
    const zone = makeZone([{ id: 1, sector: 'mountain', pos: { x: 0, y: 0, z: 2 } }]);
    assert.equal(sceneOf(zone, 1).ground.elevation.t, 'continuous');
  });
});

/* -------------------------------------------------------------------------- */

describe('enclosure', () => {
  it('counts the solid sides and nothing else', () => {
    const zone = makeZone([
      { id: 1, sector: 'city', pos: { x: 1, y: 1, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'city', pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 1 } } },
      { id: 3, sector: 'city', pos: { x: 1, y: 0, z: 0 } },
    ]);
    const scene = sceneOf(zone, 1);
    // north: a room with no link -> barrier; east: open; south and west: nothing there -> edge.
    assert.equal(scene.edges.north.kind, 'barrier');
    assert.equal(scene.enclosure.solid, 3);
  });

  it('says whether there is sky, which is what picks the lighting recipe', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 } },
      { id: 2, sector: 'inside', pos: { x: 2, y: 0, z: 0 } },
      { id: 3, sector: 'city', pos: { x: 4, y: 0, z: 0 }, flags: ['indoors'] },
    ]);
    const scenes = sceneMap(zone);
    assert.equal(scenes.get(1)!.enclosure.roofed, false);
    assert.equal(scenes.get(2)!.enclosure.roofed, true);
    assert.equal(scenes.get(3)!.enclosure.roofed, true, 'the indoors flag roofs a room whatever its sector');
  });

  it('says how high the lid is, and it is the zone that decides', () => {
    // 3 m everywhere, 6 m in the eighteen zones the giants live in. The list is derived from the
    // spawn harvest and enumerated in `GIANT_FOLK_ZONES`; here we only check that the field carries
    // the zone's answer and that it is reported for a room with sky as well as one without.
    const plain = makeZone([{ id: 1, sector: 'inside', pos: { x: 0, y: 0, z: 0 } }], { id: 999 });
    assert.equal(sceneOf(plain, 1).enclosure.ceiling, STANDARD_CEILING);

    const jotunheim = GIANT_FOLK_ZONES.has(225);
    assert.ok(jotunheim, 'zone 225 Jotunheim should be giant folk — 56 tall spawns');
    const tall = makeZone(
      [
        { id: 1, sector: 'inside', pos: { x: 0, y: 0, z: 0 } },
        { id: 2, sector: 'forest', pos: { x: 2, y: 0, z: 0 } },
      ],
      { id: 225 },
    );
    const scenes = sceneMap(tall);
    assert.equal(scenes.get(1)!.enclosure.ceiling, GIANT_CEILING);
    assert.equal(
      scenes.get(2)!.enclosure.ceiling,
      GIANT_CEILING,
      'the height is reported for an open-air room too, so no reader has to branch',
    );
    assert.equal(GIANT_CEILING, 2 * STANDARD_CEILING, 'a tall room must be a whole number of wall courses');
  });

  it('takes the tall ceiling away again under a storey, because a 6 m lid does not fit in 4 m', () => {
    // `LEVEL_SEPARATION` is 4 m and the streaming window draws the level below the camera's, so a
    // 6 m lid with a room on top of it is a slab hanging 2 m above that room's floor. The cap is
    // a whole-zone pass on `SceneZone` for the same reason `groundComponents` is: the room above is
    // not in the cardinal neighbourhood and no amount of local information can find it.
    assert.ok(GIANT_CEILING > LEVEL_SEPARATION, 'the cap would be pointless if a tall lid fitted');
    const zone = makeZone(
      [
        { id: 1, sector: 'inside', pos: { x: 0, y: 0, z: 0 } },
        // Directly on top of room 1 — so 1 is capped and 2, with open air over it, is not.
        { id: 2, sector: 'inside', pos: { x: 0, y: 0, z: 1 } },
        { id: 3, sector: 'inside', pos: { x: 2, y: 0, z: 0 } },
      ],
      { id: 225 },
    );
    assert.deepEqual([...roomsUnderAStorey(zone)], [1]);
    const scenes = sceneMap(zone);
    assert.equal(scenes.get(1)!.enclosure.ceiling, STANDARD_CEILING, 'a room with a storey on it stayed tall');
    assert.equal(scenes.get(2)!.enclosure.ceiling, GIANT_CEILING);
    assert.equal(scenes.get(3)!.enclosure.ceiling, GIANT_CEILING);

    // A bare `SceneZone` has no index, and absent means open air over everything — the same shape of
    // honest-but-uninformed fallback `ground` already has. Stated so a caller who skips `sceneZone`
    // knows what they are getting rather than discovering it in a picture.
    const bare = describeRoom({ id: 225 }, zone.rooms[0]!, {}, 0);
    assert.equal(bare.enclosure.ceiling, GIANT_CEILING);
  });
});

/* -------------------------------------------------------------------------- */

describe('features', () => {
  it('carries the room\'s props exactly as sceneryOf gives them', () => {
    const zone = makeZone([{ id: 4242, sector: 'forest', pos: { x: 0, y: 0, z: 0 } }]);
    const room = zone.rooms[0]!;
    const props = sceneryOf(room);
    assert.ok(props.length > 0, 'fixture should be a forest room the scatter fills');
    assert.deepEqual(
      sceneOf(zone, 4242)
        .features.filter((f) => f.t === 'prop')
        .map((f) => (f.t === 'prop' ? { kind: f.kind, tx: f.tx, ty: f.ty } : null)),
      props.map((p) => ({ kind: p.kind, tx: p.tx, ty: p.ty })),
    );
  });

  it('keeps the stair placement the grid stamps, and the room at the other end', () => {
    const zone = makeZone([
      { id: 9, sector: 'cave', pos: { x: 0, y: 0, z: 0 }, exits: { up: { to: 10 }, down: { to: 11 } } },
    ]);
    const placement = stairPlacement(9, true, true);
    const stairs = sceneOf(zone, 9).features.filter((f) => f.t === 'stair');
    assert.deepEqual(
      stairs.map((f) => (f.t === 'stair' ? { dir: f.dir, to: f.to, tx: f.tx, ty: f.ty, span: f.span, style: f.style } : null)),
      [
        { dir: 'up', to: 10, tx: placement.up!.dx, ty: placement.up!.dy, span: STAIR_TILES, style: 'stair' },
        { dir: 'down', to: 11, tx: placement.down!.dx, ty: placement.down!.dy, span: STAIR_TILES, style: 'stair' },
      ],
    );
  });

  it('makes a flight under the sky a ramp', () => {
    const zone = makeZone([{ id: 9, sector: 'hills', pos: { x: 0, y: 0, z: 0 }, exits: { up: { to: 10 } } }]);
    const stair = sceneOf(zone, 9).features.find((f) => f.t === 'stair');
    assert.equal(stair?.t === 'stair' ? stair.style : undefined, 'ramp');
  });

  it('puts every landmark in a scatter block, clear of props and stairs', () => {
    // Sweep enough synthetic rooms to actually meet landmarks; the placement law is the point.
    const rooms = Array.from({ length: 400 }, (_, i) => ({
      id: 1000 + i,
      sector: 'forest' as const,
      pos: { x: i % 20, y: Math.floor(i / 20), z: 0 },
      exits: { up: { to: 1 } },
    }));
    const zone = makeZone(rooms);
    const required = walkableRequired();
    let found = 0;
    for (const scene of sceneMap(zone).values()) {
      const taken = new Set<number>();
      for (const feature of scene.features) {
        if (feature.t === 'landmark') {
          found += 1;
          assert.ok(
            SCATTER_BLOCKS.some((b) => feature.tx >= b.tx && feature.tx < b.tx + SCATTER_BLOCK_TILES && feature.ty >= b.ty && feature.ty < b.ty + SCATTER_BLOCK_TILES),
            `landmark at ${feature.tx},${feature.ty} is outside every scatter block`,
          );
          for (const cell of featureFootprint(feature)) {
            assert.ok(!required.has(cell), 'a landmark on the arrival ring or the centre cross wedges a player');
            assert.ok(!taken.has(cell), 'a landmark standing inside a prop or a staircase');
          }
        }
        for (const cell of featureFootprint(feature)) taken.add(cell);
      }
    }
    assert.ok(found > 20, `only ${found} landmarks in 400 forest rooms — the roll is broken`);
  });

  it('gives a sector with no palette no landmark at all', () => {
    const rooms = Array.from({ length: 200 }, (_, i) => ({
      id: 5000 + i,
      sector: 'inside' as const,
      pos: { x: i % 20, y: Math.floor(i / 20), z: 0 },
    }));
    for (const scene of sceneMap(makeZone(rooms)).values()) {
      assert.equal(scene.features.some((f) => f.t === 'landmark'), false, 'a campfire in a shop');
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('purity', () => {
  it('returns byte-identical output for the same inputs', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 1, y: 1, z: 0 }, exits: { east: { to: 2 }, up: { to: 9 } } },
      { id: 2, sector: 'swamp', pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const context = sceneZone(zone);
    const cells = cellIndex(zone);
    const room = zone.rooms[0]!;
    const seed = sceneSeed(context, room);
    const first = describeRoom(context, room, neighboursOf(cells, room), seed);
    const second = describeRoom(context, room, neighboursOf(cells, room), seed);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it('does not depend on the order the neighbourhood was built in', () => {
    const zone = makeZone([
      { id: 1, sector: 'forest', pos: { x: 1, y: 1, z: 0 }, exits: { north: { to: 2 }, east: { to: 3 }, south: { to: 4 }, west: { to: 5 } } },
      { id: 2, sector: 'field', pos: { x: 1, y: 0, z: 0 }, exits: { south: { to: 1 } } },
      { id: 3, sector: 'swamp', pos: { x: 2, y: 1, z: 0 }, exits: { west: { to: 1 } } },
      { id: 4, sector: 'road', pos: { x: 1, y: 2, z: 0 }, exits: { north: { to: 1 } } },
      { id: 5, sector: 'hills', pos: { x: 0, y: 1, z: 0 }, exits: { east: { to: 1 } } },
    ]);
    const context = sceneZone(zone);
    const cells = cellIndex(zone);
    const room = zone.rooms[0]!;
    const forward = neighboursOf(cells, room);
    const reversed: Partial<Record<Cardinal, Room>> = {};
    for (const dir of [...CARDINALS].reverse()) {
      const value = forward[dir];
      if (value) reversed[dir] = value;
    }
    assert.notDeepEqual(Object.keys(forward), Object.keys(reversed), 'fixture must actually reverse the keys');
    assert.equal(
      JSON.stringify(describeRoom(context, room, forward, 1234)),
      JSON.stringify(describeRoom(context, room, reversed, 1234)),
    );
  });

  it('changes nothing when a second-degree neighbour changes', () => {
    const build = (farSector: 'forest' | 'deep_water'): Zone =>
      makeZone([
        { id: 1, sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
        { id: 2, sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 }, east: { to: 3 } } },
        { id: 3, sector: farSector, pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 2 } } },
      ]);
    const near = sceneMap(build('forest')).get(1)!;
    const far = sceneMap(build('deep_water')).get(1)!;
    // Room 3 is two hops away. Its ground component membership changes — which is a *zone*-level
    // derivation and documented as such — so compare everything the 1-neighbourhood contract covers.
    assert.equal(JSON.stringify({ ...near, ground: null }), JSON.stringify({ ...far, ground: null }));
    // And the immediate neighbour does see it, which is the other half of the contract.
    assert.notEqual(
      JSON.stringify(sceneMap(build('forest')).get(2)!.edges.east),
      JSON.stringify(sceneMap(build('deep_water')).get(2)!.edges.east),
    );
  });

  it('leaves scatterFor byte-identical — the wilderness must not reshuffle', () => {
    // A regression guard on the *other* two hashes: `hashCell` is new and stands alongside
    // `hashRoom`, and if anyone ever "unifies" them these props move under players' feet. The one
    // movement sanctioned since M2 is a *drop*, not a move — `sceneryOf` thins scatter standing on
    // a staircase, downstream of this function — so what `scatterFor` answers stays frozen.
    //
    // **M9b changed every `kind` here and not one `tx`/`ty`, and that is the assertion.** Taking the
    // foliage out of `SCATTER_BY_SECTOR` is a change to what a slot grows; the block a slot lands in
    // and the jitter inside it come off their own salts, so the wilderness kept its shape exactly
    // while the things standing in it became objects a player can read as obstacles. What *does*
    // move is the collision footprint — a `bush` is two tiles by two and a `crate` is one by one —
    // which is the point: there is strictly less blocked ground than there was.
    assert.deepEqual(scatterFor(92060, 'forest', undefined), [
      { kind: 'stump', tx: 6, ty: 5 },
      { kind: 'crate', tx: 6, ty: 2 },
    ]);
    assert.deepEqual(scatterFor(1, 'field', undefined), [
      { kind: 'crate', tx: 2, ty: 6 },
      { kind: 'barrel', tx: 5, ty: 5 },
      { kind: 'crate', tx: 2, ty: 3 },
    ]);
    assert.deepEqual(scatterFor(7, 'inside', undefined), []);
    // Nothing a hash grows is foliage any more — the owner's rule, at the source rather than at the
    // renderer: *"Foliage should not be a blocker unless it is for boundaries."*
    for (const sector of ['forest', 'field', 'hills', 'swamp']) {
      for (let room = 1; room < 400; room++) {
        for (const prop of scatterFor(room, sector, undefined)) {
          assert.ok(prop.kind !== 'bush' && prop.kind !== 'toadstools', `${sector} grew a solid ${prop.kind}`);
        }
      }
    }
  });
});

describe('walkableRequired', () => {
  it('is exactly the arrival ring and the centre cross, and misses the four scatter blocks', () => {
    const required = walkableRequired();
    for (const block of SCATTER_BLOCKS) {
      for (let dy = 0; dy < SCATTER_BLOCK_TILES; dy++) {
        for (let dx = 0; dx < SCATTER_BLOCK_TILES; dx++) {
          assert.ok(
            !required.has((block.ty + dy) * ROOM_TILES + block.tx + dx),
            `scatter block ${block.tx},${block.ty} overlaps a tile that must stay walkable`,
          );
        }
      }
    }
    // Row 1, row 7, column 1, column 7 and the centre cross, from tile 1 to tile 7 inclusive.
    assert.ok(required.has(1 * ROOM_TILES + 4));
    assert.ok(required.has(4 * ROOM_TILES + 4));
    assert.ok(required.has(7 * ROOM_TILES + 3));
    assert.equal(required.has(0), false, 'the outermost ring is not the arrival ring');
  });

  it('is where every scattered prop already stands', () => {
    const required = walkableRequired();
    for (let id = 1; id <= 2000; id++) {
      for (const prop of scatterFor(id, 'forest', undefined)) {
        const spec = SCENERY[prop.kind];
        for (let dy = 0; dy < spec.depth; dy++) {
          for (let dx = 0; dx < spec.width; dx++) {
            assert.ok(!required.has((prop.ty + dy) * ROOM_TILES + prop.tx + dx), `${prop.kind} in room ${id}`);
          }
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The override format — M8's layer, validated at M2                           */
/* -------------------------------------------------------------------------- */

describe('zone scene overrides', () => {
  const good: ZoneSceneOverrides = {
    version: SCENE_OVERRIDE_VERSION,
    zone: 390,
    theme: 2,
    note: 'The Nightwood should be darker than the other forests.',
    rooms: {
      '92060': { sector: 'forest', landmark: 'shrine', base: -0.75 },
      '92058': { landmark: 'none' },
      '92061': { theme: 0 },
    },
  };

  it('accepts a well-formed document', () => {
    assert.deepEqual(validateZoneSceneOverrides(good), []);
  });

  it('accepts a document that overrides nothing', () => {
    assert.deepEqual(validateZoneSceneOverrides({ version: SCENE_OVERRIDE_VERSION, zone: 1 }), []);
  });

  it('refuses anything that is not an object', () => {
    for (const value of [null, 7, 'zone', [], undefined]) {
      assert.equal(validateZoneSceneOverrides(value).length, 1, `${JSON.stringify(value)} should be one problem`);
    }
  });

  it('refuses a version it does not know, so a format change cannot be silently ignored', () => {
    const problems = validateZoneSceneOverrides({ ...good, version: 2 });
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.path, 'version');
  });

  it('refuses an unknown key rather than ignoring it', () => {
    // A typo'd override is an override that does nothing, found by eye, months later.
    const problems = validateZoneSceneOverrides({ ...good, biome: 'forest' });
    assert.deepEqual(problems.map((p) => p.path), ['biome']);
    const inner = validateZoneSceneOverrides({ ...good, rooms: { '1': { secter: 'forest' } } });
    assert.deepEqual(inner.map((p) => p.path), ['rooms.1.secter']);
  });

  it('names the path of every problem, and reports all of them at once', () => {
    const problems = validateZoneSceneOverrides({
      version: SCENE_OVERRIDE_VERSION,
      zone: 'three-ninety',
      theme: 99,
      rooms: {
        '92060': { sector: 'woods', landmark: 'obelisk', base: 'high' },
        ' 92058': {},
        '92061': 7,
      },
    });
    assert.deepEqual(problems.map((p) => p.path).sort(), [
      'rooms. 92058',
      'rooms.92060.base',
      'rooms.92060.landmark',
      'rooms.92060.sector',
      'rooms.92061',
      'theme',
      'zone',
    ]);
    for (const problem of problems) assert.ok(problem.message.length > 0, `${problem.path} has no message`);
  });

  it('refuses a room key that is not a plain integer', () => {
    for (const key of ['0x1674c', '92060 ', '9.2e4', 'entry']) {
      const problems = validateZoneSceneOverrides({ version: SCENE_OVERRIDE_VERSION, zone: 1, rooms: { [key]: {} } });
      assert.equal(problems.length, 1, `${JSON.stringify(key)} should be refused`);
    }
    assert.deepEqual(
      validateZoneSceneOverrides({ version: SCENE_OVERRIDE_VERSION, zone: 1, rooms: { '92060': {} } }),
      [],
    );
  });

  it('bounds an elevation override, because a typo\'d metre is a room in the sky', () => {
    for (const base of [1e6, -1e6, Number.NaN, Number.POSITIVE_INFINITY]) {
      const problems = validateZoneSceneOverrides({
        version: SCENE_OVERRIDE_VERSION,
        zone: 1,
        rooms: { '1': { base } },
      });
      assert.equal(problems.length, 1, `base ${base} should be refused`);
    }
  });

  it('lists the rooms a loader has to re-derive — and, per the format note, their neighbours too', () => {
    assert.deepEqual([...overriddenRooms(good)].sort((a, b) => a - b), [92058, 92060, 92061]);
    assert.deepEqual(overriddenRooms({ version: SCENE_OVERRIDE_VERSION, zone: 1 }), []);
  });
});
