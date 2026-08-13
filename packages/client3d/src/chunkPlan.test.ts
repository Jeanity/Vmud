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
  ROOM_GAP,
  ROOM_TILES,
  SEAM_GAP,
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

import { planChunk, roomElevation, wallDepth, type Placement } from './chunkPlan.ts';
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

  it('gives every room one ground slab, and it reaches half the gap on every side', () => {
    // **The void fix, as the property it is** — 2026-08-13. This used to assert one slab of exactly
    // `ROOM_METRES` and it was the shape of the bug: the block was floored, the gap around it was
    // floored only under a mouth, and the corners were floored by nobody. One slab of
    // `ROOM_METRES + gap`, centred on the room, is the whole of the fix and it is *fewer* placements
    // than the five it replaces. See `chunkPlan.ts`'s header for the 32.3% it measured against.
    const frame = placeFrame(zone, 0);
    const span = ROOM_METRES + frame.gap;
    for (const room of zone.rooms) {
      const plan = planOf(zone, room.id);
      const grounds = plan.filter((p) => p.archetype === 'ground');
      assert.equal(grounds.length, 1, `room ${room.id} draws ${grounds.length} ground placements`);
      const slab = grounds[0]!;
      assert.equal(slab.sx, span, `room ${room.id}`);
      assert.equal(slab.sz, span, `room ${room.id}`);
      assert.equal(slab.sy, DIMENSIONS.groundThickness);
      // Centred on the block, so the reach is symmetric and two neighbours meet on the midline
      // rather than one of them overshooting into the other's half and z-fighting.
      const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
      assert.equal(slab.x, origin.tx + ROOM_METRES / 2, `room ${room.id} slab is off-centre in x`);
      assert.equal(slab.z, origin.ty + ROOM_METRES / 2, `room ${room.id} slab is off-centre in z`);
    }
  });

  it('tiles the gap between two rooms exactly, with no overlap and no hole', () => {
    // Rooms 2 (0,1) and 3 (1,1) are adjacent. Their slabs must meet on the midline between the two
    // blocks: touching is the fix, overlapping would z-fight two coplanar surfaces at the same
    // elevation, and falling short is the bug the owner reported.
    const frame = placeFrame(zone, 0);
    const west = planOf(zone, 2).find((p) => p.archetype === 'ground')!;
    const east = planOf(zone, 3).find((p) => p.archetype === 'ground')!;
    const westReach = west.x + west.sx / 2;
    const eastReach = east.x - east.sx / 2;
    assert.ok(Math.abs(westReach - eastReach) < 1e-9, `a ${(eastReach - westReach).toFixed(3)} m gap remains`);
    // And that meeting point is the middle of the gap, not the edge of either block.
    const origin = cellOriginTiles(frame, 0, 1);
    assert.equal(westReach, origin.tx + ROOM_METRES + frame.gap / 2);
  });

  it('draws a wall at least half the gap deep, so a wall *is* the gap', () => {
    // The owner's second ask: *"the gap should be the width of a wall if there is a wall, so that
    // what you see is a wall and not a gap at all."* Two rooms facing each other across a wall each
    // draw half of it; at `edgeThickness` alone they left a 0.8 m slot of sky down the middle.
    for (const gap of [SEAM_GAP, ROOM_GAP]) {
      assert.ok(wallDepth(DIMENSIONS.edgeThickness, gap) * 2 >= gap, `an edge leaves a slot at gap ${gap}`);
      assert.ok(wallDepth(DIMENSIONS.barrierThickness, gap) * 2 >= gap, `a barrier leaves a slot at gap ${gap}`);
      // §4's correctness requirement survives the change at every gap width the world uses: a
      // barrier is still strictly the thicker of the two, it is simply no longer thicker by 2.3x.
      assert.ok(
        wallDepth(DIMENSIONS.barrierThickness, gap) > wallDepth(DIMENSIONS.edgeThickness, gap),
        `a barrier is not thicker than an edge at gap ${gap}`,
      );
    }
    // A wall never *shrinks* below the archetype's own thickness — the gap is a floor, not the answer.
    assert.equal(wallDepth(DIMENSIONS.barrierThickness, ROOM_GAP), DIMENSIONS.barrierThickness);
    assert.equal(wallDepth(DIMENSIONS.edgeThickness, ROOM_GAP), ROOM_GAP / 2);
    assert.equal(wallDepth(DIMENSIONS.edgeThickness, SEAM_GAP), DIMENSIONS.edgeThickness);
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
    // And the gap is floored, half from each side, so the two grounds meet — by the one slab now
    // rather than by a strip, which is why `onSide` finds nothing *past* the block: the slab's centre
    // is the room's centre. What matters is its reach.
    assert.deepEqual(onSide(plan, ['ground'], 'east', centre), [], 'the gap is no longer a separate strip');
    const slab = plan.find((p) => p.archetype === 'ground')!;
    assert.equal(slab.x + slab.sx / 2, centre.x + ROOM_METRES / 2 + frame.gap / 2, 'each room floors half the gap');
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
    // Since 2026-08-13 that is the one slab reaching half the gap out on every side, where it used to
    // be the block plus a strip in the seam's own mouth — so the count is 1 and the *reach* is what
    // carries the claim.
    const grounds = plan.filter((p) => p.archetype === 'ground');
    assert.equal(grounds.length, 1);
    assert.ok(grounds[0]!.sx > ROOM_METRES, 'the ground stops at the block and the road ends in a cliff');
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
