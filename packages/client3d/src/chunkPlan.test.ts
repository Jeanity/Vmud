/**
 * What a room turns into, asserted as geometry rather than as a snapshot.
 *
 * The plan is explicit that snapshots are the wrong tool here — *"they rot on the first density
 * tweak and say nothing about the other 46,000 rooms"* — so every case below is a property. Three of
 * them are the plan's own acceptance criteria restated in metres: **every barrier edge produces
 * solid geometry**, a barrier is **thicker** than an edge, and the same inputs produce **byte-
 * identical** output whichever order they are asked in.
 *
 * The fixture is synthetic on purpose (see `fixture.ts`): these invariants must hold on a checkout
 * that has never run `npm run worldgen`. `traversal.test.ts` is where the real world gets swept.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEVEL_SEPARATION,
  ROOM_TILES,
  buildZoneTilemap,
  cellIndex,
  describeRoom,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Cardinal,
  type Room,
  type RoomScene,
  type Zone,
} from '@mygame/shared';

import { planChunk, roomElevation, type Placement } from './chunkPlan.ts';
import { ROOM_METRES, cellOriginTiles, placeFrame } from './frame.ts';
import { DIMENSIONS } from './prototypes.ts';
import { sampleZone, zoneOf } from './fixture.ts';

function planOf(zone: Zone, roomId: number, level = 0, faded = false): readonly Placement[] {
  const context = sceneZone(zone);
  const cells = cellIndex(zone);
  const rooms = new Map(zone.rooms.map((r) => [r.id, r]));
  const room = rooms.get(roomId)!;
  const frame = placeFrame(zone, level);
  const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
  const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
  return planChunk({
    scene,
    origin,
    elevation: 0,
    gap: frame.gap,
    faded,
    doorClosed: {},
  });
}

function sceneOf(zone: Zone, roomId: number): { scene: RoomScene; room: Room } {
  const context = sceneZone(zone);
  const cells = cellIndex(zone);
  const rooms = new Map(zone.rooms.map((r) => [r.id, r]));
  const room = rooms.get(roomId)!;
  return { scene: describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room)), room };
}

/** A placement's extent along the axis a side runs down: X for north/south, Z for east/west. */
function along(placement: Placement, dir: Cardinal): number {
  return dir === 'north' || dir === 'south' ? placement.sx : placement.sz;
}

/** Placements of one archetype that sit on a given side of the room block. */
function onSide(plan: readonly Placement[], archetypes: readonly string[], dir: Cardinal, centre: { x: number; z: number }): Placement[] {
  return plan.filter((p) => {
    if (!archetypes.includes(p.archetype)) return false;
    switch (dir) {
      case 'north':
        return p.z < centre.z - ROOM_METRES / 2 + 0.001;
      case 'south':
        return p.z > centre.z + ROOM_METRES / 2 - 0.001;
      case 'west':
        return p.x < centre.x - ROOM_METRES / 2 + 0.001;
      case 'east':
        return p.x > centre.x + ROOM_METRES / 2 - 0.001;
    }
  });
}

describe('the frame agrees with the collision grid', () => {
  it('puts every room block where buildZoneTilemap put it', () => {
    const zone = sampleZone();
    const grid = buildZoneTilemap(zone, 0);
    const frame = placeFrame(zone, 0);
    for (const room of zone.rooms) {
      const expected = grid.roomOrigins.get(room.id);
      assert.ok(expected, `room ${room.id} has no origin on the grid`);
      assert.deepEqual(cellOriginTiles(frame, room.pos.x, room.pos.y), expected);
    }
    assert.equal(frame.widthTiles, grid.width);
    assert.equal(frame.heightTiles, grid.height);
  });
});

describe('planChunk', () => {
  const zone = sampleZone();

  it('gives every room exactly one full-size ground slab', () => {
    for (const room of zone.rooms) {
      const plan = planOf(zone, room.id);
      const slabs = plan.filter((p) => p.archetype === 'ground' && p.sx === ROOM_METRES && p.sz === ROOM_METRES);
      assert.equal(slabs.length, 1, `room ${room.id}`);
      assert.equal(slabs[0]!.sy, DIMENSIONS.groundThickness);
    }
  });

  it('makes a barrier thicker and taller than an edge — the plan calls this correctness', () => {
    assert.ok(
      DIMENSIONS.barrierThickness > DIMENSIONS.edgeThickness * 2,
      'a barrier a hair thicker than an edge is not visibly thicker',
    );
    // Room 1 sits alone at (1,0) with no exits: every side of it is `edge`. Room 3's north side
    // faces room 1 with no link either way, which is the definition of a barrier.
    const three = planOf(zone, 3);
    const centre = { x: ROOM_METRES / 2 + 11, z: ROOM_METRES / 2 + 11 };
    const north = onSide(three, ['barrier'], 'north', centre);
    assert.equal(north.length, 1, 'a barrier with no mouth is one wall');
    assert.equal(north[0]!.sz, DIMENSIONS.barrierThickness);
    assert.equal(north[0]!.sy, DIMENSIONS.barrierHeight);
  });

  it('produces solid geometry spanning every solid edge', () => {
    for (const room of zone.rooms) {
      const { scene } = sceneOf(zone, room.id);
      const plan = planOf(zone, room.id);
      const frame = placeFrame(zone, 0);
      const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
      const centre = { x: origin.tx + ROOM_METRES / 2, z: origin.ty + ROOM_METRES / 2 };
      for (const dir of ['north', 'east', 'south', 'west'] as const) {
        if (!scene.edges[dir].solid) continue;
        const walls = onSide(plan, ['edge', 'barrier'], dir, centre);
        assert.equal(walls.length, 1, `${room.id} ${dir}`);
        assert.ok(
          along(walls[0]!, dir) >= ROOM_METRES,
          `${room.id} ${dir}: wall is ${along(walls[0]!, dir)} m across a ${ROOM_METRES} m side`,
        );
      }
    }
  });

  it('grows no wall where two outdoor rooms merge along their whole edge', () => {
    // Rooms 2 and 3 are forest and field, both outdoor, linked: M0's carve opens all nine tiles.
    const { scene } = sceneOf(zone, 2);
    assert.equal(scene.edges.east.mouth?.span, ROOM_TILES, 'the fixture is not exercising the merge');
    const frame = placeFrame(zone, 0);
    const origin = cellOriginTiles(frame, 0, 1);
    const centre = { x: origin.tx + ROOM_METRES / 2, z: origin.ty + ROOM_METRES / 2 };
    const plan = planOf(zone, 2);
    assert.deepEqual(onSide(plan, ['edge', 'barrier'], 'east', centre), []);
    // And the gap is floored, half from each side, so the two grounds meet.
    const strips = onSide(plan, ['ground'], 'east', centre);
    assert.equal(strips.length, 1);
    assert.equal(strips[0]!.sz, ROOM_METRES, 'the strip is as wide as the mouth');
    assert.equal(strips[0]!.sx, frame.gap / 2, 'each room floors half the gap');
  });

  it('hangs a leaf in a door mouth and flanks it with wall', () => {
    const frame = placeFrame(zone, 0);
    const origin = cellOriginTiles(frame, 1, 1);
    const centre = { x: origin.tx + ROOM_METRES / 2, z: origin.ty + ROOM_METRES / 2 };
    const shut = planOf(zone, 3);
    const leaves = onSide(shut, ['door', 'doorOpen'], 'east', centre);
    assert.equal(leaves.length, 1);
    assert.equal(leaves[0]!.archetype, 'door', 'the fixture ships the door closed');
    assert.equal(leaves[0]!.sz, 3, 'the leaf fills the three-tile mouth');
    assert.equal(onSide(shut, ['edge'], 'east', centre).length, 2, 'a door is a hole in a wall');
  });

  it('swings the leaf aside when the door is open, and moves nothing else', () => {
    const context = sceneZone(zone);
    const cells = cellIndex(zone);
    const rooms = new Map(zone.rooms.map((r) => [r.id, r]));
    const room = rooms.get(3)!;
    const frame = placeFrame(zone, 0);
    const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
    const base = {
      scene,
      origin: cellOriginTiles(frame, room.pos.x, room.pos.y),
      elevation: 0,
      gap: frame.gap,
      faded: false,
    };
    const shut = planChunk({ ...base, doorClosed: {} });
    const open = planChunk({ ...base, doorClosed: { east: false } });
    assert.equal(shut.filter((p) => p.archetype === 'door').length, 1);
    assert.equal(open.filter((p) => p.archetype === 'doorOpen').length, 1);
    assert.equal(open.filter((p) => p.archetype === 'door').length, 0);
    const walls = (plan: readonly Placement[]): unknown => plan.filter((p) => p.archetype === 'edge');
    assert.deepEqual(walls(open), walls(shut), 'opening a door must not move a wall');
  });

  it('rings a portal and nothing else', () => {
    const rings = planOf(zone, 4).filter((p) => p.archetype === 'portal');
    assert.equal(rings.length, 1);
    assert.equal(rings[0]!.geometry, 'torus');
    // Room 4 is the only room in the fixture with a portal, so nothing else may carry a ring.
    for (const id of [1, 2, 3]) {
      assert.deepEqual(planOf(zone, id).filter((p) => p.archetype === 'portal'), []);
    }
  });

  it('draws no ring on a seam — M2 ruled a seam is a step, not a gate', () => {
    const seamZone = zoneOf([
      { id: 10, x: 0, y: 0, sector: 'road', exits: { east: { to: 11, portal: true, seam: true } } },
      { id: 11, x: 1, y: 0, sector: 'road' },
    ]);
    const { scene } = sceneOf(seamZone, 10);
    assert.equal(scene.edges.east.seam, true, 'the fixture is not exercising a seam');
    assert.notEqual(scene.edges.east.kind, 'portal');
    const plan = planOf(seamZone, 10);
    assert.deepEqual(plan.filter((p) => p.archetype === 'portal'), [], 'a seam must never grow a ring');
    // It does keep its ground: the road runs off the edge of the Place rather than stopping short.
    assert.ok(plan.filter((p) => p.archetype === 'ground').length >= 2);
  });

  it('is deterministic', () => {
    for (const room of zone.rooms) {
      assert.deepEqual(planOf(zone, room.id), planOf(zone, room.id));
    }
  });

  it('fades by material and by nothing else', () => {
    const plain = planOf(zone, 3, 0, false);
    const dim = planOf(zone, 3, 0, true);
    assert.equal(plain.length, dim.length);
    for (let i = 0; i < plain.length; i++) {
      const a = plain[i]!;
      const b = dim[i]!;
      assert.deepEqual({ ...a, material: '' }, { ...b, material: '' }, 'fading must not move geometry');
      assert.ok(b.material.endsWith('|dim'), `${b.material} is not the faded twin`);
    }
  });
});

describe('roomElevation', () => {
  const zone = sampleZone();

  it('puts the camera level at zero for a roofed room', () => {
    const { scene, room } = sceneOf(zone, 4);
    assert.equal(scene.ground.elevation.t, 'stacked', 'room 4 is flagged indoors');
    assert.equal(roomElevation(scene, room.pos.z, 0, 0, 0), 0);
  });

  it('puts the level below exactly one separation down', () => {
    const { scene, room } = sceneOf(zone, 4);
    assert.equal(roomElevation(scene, room.pos.z, 1, 0, 0), -LEVEL_SEPARATION);
    // And hard-culling above is the streamer's job, so this stays defined for a level above too.
    assert.equal(roomElevation(scene, room.pos.z, -1, 0, 0), LEVEL_SEPARATION);
  });

  it('keeps an outdoor room within its own noise amplitude of its base', () => {
    const { scene, room } = sceneOf(zone, 2);
    assert.equal(scene.ground.elevation.t, 'continuous');
    if (scene.ground.elevation.t !== 'continuous') return;
    const { base, noise } = scene.ground.elevation;
    for (let x = 0; x < 200; x += 7) {
      const y = roomElevation(scene, room.pos.z, 0, x, x * 1.7);
      assert.ok(Math.abs(y - base) <= noise.amplitude + 1e-9, `${y} is outside ${base} +/- ${noise.amplitude}`);
    }
  });
});
