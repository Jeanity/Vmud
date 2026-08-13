/**
 * Solid bodies, at the level of the rules themselves.
 *
 * **Almost everything here is a refusal, and the dangerous half is the refusals that must not happen.**
 * A mob you cannot walk through looks the same whether or not the doorway exemption works; the day it
 * stops working, three kobolds stand in a gate and the owner cannot leave the room. So the wedge proof
 * comes first and is exhaustive rather than sampled — see *the no-wedge proof* below — and the rest of
 * the file is ordered by how expensive the failure would be, not by how the module is laid out.
 *
 * The fixtures are synthetic zones, which is deliberate beyond readability: `CLAUDE.md` rule 5 says the
 * engine must run against a world with no third-party data in it, and a collision rule that needed
 * IceCrag to be on disk would be a rule nobody could test on a fresh clone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BODY_RADIUS,
  BODY_SEPARATION,
  bodySolidAt,
  placeBody,
  stepBody,
  type BodyPoint,
} from './bodies.ts';
import {
  CONNECTOR_WIDTH,
  PLAYER_RADIUS,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  buildZoneTilemap,
  isWalkable,
  normaliseIntent,
  roomAtTile,
  roomCentre,
  setTile,
  stepMovement,
  tileAt,
  tileCentre,
  type TileGrid,
} from './tilemap.ts';
import { boundsOf, type Room, type RoomId, type Zone } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A synthetic zone. `inside` by default for the reason `tilemap.test.ts` gives — an outdoor sector
 * pulls the scatter table in and grows props through the middle of every assertion about bare floor.
 */
function makeZone(rooms: readonly Partial<Room>[]): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: 1,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'inside',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
    ...r,
  })) as Room[];
  return { id: 1, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

/** Two rooms side by side with a way between them — the geometry every wedge lives in. */
function pair(sector: Room['sector'] = 'inside', door?: { closed: boolean }): TileGrid {
  const gate = door ? { door: { name: 'a gate', closed: door.closed, locked: false } } : {};
  return buildZoneTilemap(
    makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, sector, exits: { east: { to: 2, ...gate } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, sector, exits: { west: { to: 1, ...gate } } },
    ]),
  );
}

/** One room, alone, with nothing but its own four walls. */
function solitary(): TileGrid {
  return buildZoneTilemap(makeZone([{ id: 1, pos: { x: 0, y: 0, z: 0 } }]));
}

function originOf(grid: TileGrid, roomId: RoomId): { tx: number; ty: number } {
  const origin = grid.roomOrigins.get(roomId);
  assert.ok(origin, `the fixture should have placed room ${roomId}`);
  return origin;
}

/** A body at the centre of a tile. Ids are arbitrary but must differ from the mover's. */
function at(id: number, tx: number, ty: number): BodyPoint {
  return { id, x: tileCentre(tx), y: tileCentre(ty) };
}

/** Every tile of a room, in row-major order. */
function roomTiles(origin: { tx: number; ty: number }): { tx: number; ty: number }[] {
  const out: { tx: number; ty: number }[] = [];
  for (let dy = 0; dy < ROOM_TILES; dy++) {
    for (let dx = 0; dx < ROOM_TILES; dx++) out.push({ tx: origin.tx + dx, ty: origin.ty + dy });
  }
  return out;
}

/**
 * Walks a body toward a point at walking pace until it arrives or gives up, and reports both.
 *
 * A tick-by-tick walk rather than a straight-line test, because the thing under test is a *sequence*
 * of refusals: a deflection that gets you round a body on tick one and back into it on tick two is a
 * mover that oscillates for ever, and only a walk can see that.
 */
function walkTo(
  grid: TileGrid,
  self: BodyPoint,
  goal: { x: number; y: number },
  others: readonly BodyPoint[],
  ticks = 400,
): { arrived: boolean; x: number; y: number; ticks: number } {
  let { x, y } = self;
  for (let n = 1; n <= ticks; n++) {
    const dx = goal.x - x;
    const dy = goal.y - y;
    const remaining = Math.hypot(dx, dy);
    if (remaining <= 1) return { arrived: true, x, y, ticks: n };
    const intent = normaliseIntent(dx, dy);
    const next = stepBody(grid, { id: self.id, x, y }, intent.x, intent.y, Math.min(15, remaining), others);
    x = next.x;
    y = next.y;
  }
  return { arrived: false, x, y, ticks };
}

/* -------------------------------------------------------------------------- */
/* The no-wedge proof                                                          */
/* -------------------------------------------------------------------------- */

/**
 * **The case this whole design exists to prevent**, and the reason the exemption is a rule about tiles
 * rather than a radius somebody tuned.
 *
 * A gate is {@link CONNECTOR_WIDTH} tiles — 96px — and bodies sit on tile centres 32px apart needing
 * {@link BODY_SEPARATION} of clearance. A mover therefore cannot thread between two bodies on adjacent
 * tiles, so three of them across a gate is a closed door and three *sentinels* is a closed door for
 * ever. The scale is not hypothetical: an eight-body room offers roughly one chance in seven hundred
 * of filling a given mouth, and the world has hundreds of populated rooms with several exits each.
 *
 * The proof has two halves and needs both. The first is exhaustive and cheap: **no cell of the
 * chokepoint is ever an obstacle**, checked one cell at a time. Because a body's solidity depends only
 * on the tile it stands on and on nothing else in the room, that single fact rules out all 2^n
 * arrangements of bodies over those n cells at once — there is no combination to enumerate. The second
 * is the walk itself, with every one of those cells occupied at the same time, because a rule that is
 * right and a mover that is wrong would still leave the owner stuck behind a kobold.
 */
describe('the no-wedge proof: a gate cannot be corked', () => {
  /** The cells a body would have to stand on to seal the east–west gate of room 1. */
  function chokepoint(grid: TileGrid): { tx: number; ty: number }[] {
    const origin = originOf(grid, 1);
    const far = originOf(grid, 2);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const half = (CONNECTOR_WIDTH - 1) / 2;
    const cells: { tx: number; ty: number }[] = [];
    for (let dy = -half; dy <= half; dy++) {
      // The mouth tiles inside each room…
      cells.push({ tx: origin.tx + ROOM_TILES - 1, ty: midY + dy });
      cells.push({ tx: far.tx, ty: midY + dy });
      // …and every cell of the corridor between them.
      for (let tx = origin.tx + ROOM_TILES; tx < far.tx; tx++) cells.push({ tx, ty: midY + dy });
    }
    return cells;
  }

  it('marks every cell of the chokepoint as ground a body cannot obstruct from', () => {
    const grid = pair();
    const cells = chokepoint(grid);
    assert.ok(cells.length >= CONNECTOR_WIDTH * 3, `expected a real gate, got ${cells.length} cells`);
    for (const { tx, ty } of cells) {
      assert.equal(isWalkable(tileAt(grid, tx, ty)), true, `${tx},${ty} should be part of the route`);
      assert.equal(
        bodySolidAt(grid, tileCentre(tx), tileCentre(ty)),
        false,
        `a body at ${tx},${ty} would be able to seal the gate`,
      );
    }
  });

  it('lets a walker through with every one of those cells occupied at once', () => {
    const grid = pair();
    const cells = chokepoint(grid);
    const bodies = cells.map((c, i) => at(100 + i, c.tx, c.ty));
    const from = roomCentre(originOf(grid, 1));
    const to = roomCentre(originOf(grid, 2));

    const walk = walkTo(
      grid,
      { id: 1, x: tileCentre(from.tx), y: tileCentre(from.ty) },
      { x: tileCentre(to.tx), y: tileCentre(to.ty) },
      bodies,
    );
    assert.equal(walk.arrived, true, `sealed in: stopped at ${walk.x},${walk.y}`);
    assert.equal(roomAtTile(grid, Math.floor(walk.x / TILE_SIZE), Math.floor(walk.y / TILE_SIZE)), 2);
  });

  it('leaves a way past a three-abreast plug parked just inside the far room', () => {
    // The gate is exempt; **the floor behind it is not**, and that is where the exemption stops. Three
    // bodies abreast on the column inside the far room is the worst arrangement solidity still allows
    // near a doorway, and a nine-tile room is wide enough that it blocks a line rather than a route.
    //
    // Walked with one intermediate aim, because **going round a wall of bodies is the planner's job**,
    // exactly as going round a wall of stone is: `stepMovement` has always slid along geometry and left
    // `pathfind.ts` to decide which way round. Three abreast is a local minimum no stateless rule
    // escapes — every tangent points back into the pocket between the next pair — so the claim this
    // case makes is the true one: the room is not sealed, and a walker that steers gets there.
    const grid = pair();
    const far = originOf(grid, 2);
    const midY = far.ty + (ROOM_TILES - 1) / 2;
    const half = (CONNECTOR_WIDTH - 1) / 2;
    const crowd: BodyPoint[] = chokepoint(grid).map((c, i) => at(100 + i, c.tx, c.ty));
    for (let dy = -half; dy <= half; dy++) crowd.push(at(200 + dy, far.tx + 1, midY + dy));

    const from = roomCentre(originOf(grid, 1));
    let walker: BodyPoint = { id: 1, x: tileCentre(from.tx), y: tileCentre(from.ty) };
    for (const aim of [
      // Through the gate, then south of the plug, then across to the far wall.
      { tx: far.tx, ty: midY },
      { tx: far.tx + 1, ty: far.ty + ROOM_TILES - 1 },
      { tx: far.tx + ROOM_TILES - 1, ty: midY },
    ]) {
      const leg = walkTo(grid, walker, { x: tileCentre(aim.tx), y: tileCentre(aim.ty) }, crowd);
      assert.equal(leg.arrived, true, `could not reach ${aim.tx},${aim.ty} — stopped at ${leg.x},${leg.y}`);
      walker = { id: 1, x: leg.x, y: leg.y };
    }
    assert.equal(roomAtTile(grid, Math.floor(walker.x / TILE_SIZE), Math.floor(walker.y / TILE_SIZE)), 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Where a body is solid                                                       */
/* -------------------------------------------------------------------------- */

describe('bodySolidAt: solidity is a property of the ground', () => {
  it('is solid in the middle of a room, which is the whole feature', () => {
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    assert.equal(bodySolidAt(grid, tileCentre(centre.tx), tileCentre(centre.ty)), true);
  });

  it('is never solid on ground that belongs to no room', () => {
    const grid = pair();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    for (let tx = origin.tx + ROOM_TILES; tx < originOf(grid, 2).tx; tx++) {
      assert.equal(roomAtTile(grid, tx, midY), -1, 'the corridor should belong to neither room');
      assert.equal(bodySolidAt(grid, tileCentre(tx), tileCentre(midY)), false);
    }
  });

  it('keeps bodies solid along a merged outdoor edge, which is nine tiles and needs nine to close', () => {
    // `connectorSpan` gives two answers, and this is the other one: two outdoor rooms merge along their
    // whole shared edge rather than through a gate. Nine abreast is not an arrangement worth designing
    // against, so the edge keeps its solidity and the feature keeps its reach.
    const grid = pair('field');
    const origin = originOf(grid, 1);
    const edge = origin.tx + ROOM_TILES - 1;
    let solid = 0;
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      const ty = origin.ty + dy;
      if (!isWalkable(tileAt(grid, edge, ty))) continue;
      if (bodySolidAt(grid, tileCentre(edge), tileCentre(ty))) solid++;
    }
    assert.equal(solid, ROOM_TILES, 'every tile of a merged edge should still stop a body');
  });

  it('softens a gate mouth and no more of the room than that', () => {
    const grid = pair();
    const origin = originOf(grid, 1);
    let soft = 0;
    for (const { tx, ty } of roomTiles(origin)) {
      if (!bodySolidAt(grid, tileCentre(tx), tileCentre(ty))) soft++;
    }
    // One exit, so exactly one mouth: three tiles of eighty-one.
    assert.equal(soft, CONNECTOR_WIDTH);
  });

  it('reads the live grid, so shutting a door hardens the mouth it was softening', () => {
    // A shut door is not a route, so nothing standing beside it can seal one — and `setDoorTiles` is the
    // one mutation both the server and every client run, which means this answer flips on both sides of
    // the wire for free rather than needing a message of its own.
    const open = pair('inside', { closed: false });
    const shut = pair('inside', { closed: true });
    const origin = originOf(open, 1);
    const mouth = { tx: origin.tx + ROOM_TILES - 1, ty: origin.ty + (ROOM_TILES - 1) / 2 };

    assert.equal(bodySolidAt(open, tileCentre(mouth.tx), tileCentre(mouth.ty)), false);
    assert.equal(bodySolidAt(shut, tileCentre(mouth.tx), tileCentre(mouth.ty)), true);
  });

  it('is not solid on a wall, which cannot be stood on in the first place', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    assert.equal(bodySolidAt(grid, tileCentre(origin.tx - 1), tileCentre(origin.ty)), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Moving among bodies                                                         */
/* -------------------------------------------------------------------------- */

describe('stepBody', () => {
  it('is stepMovement exactly when nothing solid is near', () => {
    // The compatibility clause the client's predictor rests on: terrain behaviour must not have moved
    // by a floating-point hair, or every walk in an empty room desyncs.
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    const x = tileCentre(centre.tx);
    const y = tileCentre(centre.ty);
    for (const [ix, iy] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0, -1],
      [0.6, 0.8],
      [-0.6, -0.8],
    ] as const) {
      assert.deepEqual(
        stepBody(grid, { id: 1, x, y }, ix, iy, 15, []),
        stepMovement(grid, x, y, ix, iy, 15),
        `intent ${ix},${iy}`,
      );
    }
  });

  it('refuses a step that would close inside the separation', () => {
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    const self = { id: 1, x: tileCentre(centre.tx), y: tileCentre(centre.ty) };
    // Directly east, close enough that one step would overlap but far enough that we are clear now.
    const other: BodyPoint = { id: 2, x: self.x + BODY_SEPARATION + 5, y: self.y };
    const next = stepBody(grid, self, 1, 0, 15, [other]);
    assert.ok(Math.hypot(next.x - other.x, next.y - other.y) >= BODY_SEPARATION - 1e-9, 'walked into it');
  });

  it('lets a body that is already overlapping open the gap, so nothing is ever welded shut', () => {
    // Escape valve 1. Placement degrades to stacking rather than losing a mob, and a teleport can land
    // on somebody; a refusal that also refused the way out would make either one permanent.
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    const self = { id: 1, x: tileCentre(centre.tx), y: tileCentre(centre.ty) };
    const other: BodyPoint = { id: 2, x: self.x + 4, y: self.y };
    const away = stepBody(grid, self, -1, 0, 15, [other]);
    assert.equal(away.x, self.x - 15, 'a separating step must always be allowed');

    const closer = stepBody(grid, self, 1, 0, 15, [other]);
    assert.equal(closer.x, self.x, 'and a step further in must not be');
  });

  it('walks two stacked bodies apart rather than leaving them stacked', () => {
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    const self = { id: 1, x: tileCentre(centre.tx), y: tileCentre(centre.ty) };
    const other: BodyPoint = { id: 2, x: self.x, y: self.y };
    const next = stepBody(grid, self, 1, 0, 15, [other]);
    assert.equal(next.x, self.x + 15, 'a body on the same pixel can still walk off it');
  });

  it('goes round a body standing dead ahead instead of stopping against it', () => {
    // Escape valve 2, and the case a wall slide cannot cover: heading due east there is no off-axis
    // component to slide on, so the intent is projected onto the disc's tangent instead.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const self = { id: 1, x: tileCentre(origin.tx + 1), y: tileCentre(midY) };
    const blocker = at(2, origin.tx + 4, midY);
    const goal = { x: tileCentre(origin.tx + ROOM_TILES - 1), y: tileCentre(midY) };

    const walk = walkTo(grid, self, goal, [blocker]);
    assert.equal(walk.arrived, true, `stopped short at ${walk.x},${walk.y}`);
    assert.ok(walk.ticks < 100, `took ${walk.ticks} ticks, which reads as an orbit rather than a detour`);
  });

  it('passes a head-on body on the same side every time, because a coin toss is not deterministic', () => {
    // Perfectly head-on, the tangent is degenerate and something has to break the tie. `CLAUDE.md`
    // rule 3 rules out rolling for it, so the rule is the road's: pass on your right, which on a
    // y-down screen is a quarter turn clockwise from the heading.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const self = { id: 1, x: tileCentre(origin.tx + 2), y: tileCentre(midY) };
    const blocker: BodyPoint = { id: 2, x: self.x + BODY_SEPARATION - 1, y: self.y };

    const first = stepBody(grid, self, 1, 0, 15, [blocker]);
    assert.ok(first.y > self.y, 'heading east, a head-on pass should go south — the mover’s right');
    for (let n = 0; n < 5; n++) {
      assert.deepEqual(stepBody(grid, self, 1, 0, 15, [blocker]), first, 'and identically every time');
    }
  });

  it('does not deflect off a body when the wall is what refused the step', () => {
    // A mover pressed into a corner is a terrain problem; terrain already slides, and deflecting off
    // whatever body happened to be nearby would send them somewhere they never asked to go.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const corner = { id: 1, x: tileCentre(origin.tx) - (TILE_SIZE / 2 - PLAYER_RADIUS), y: tileCentre(origin.ty) };
    const bystander = at(2, origin.tx + 2, origin.ty + 2);
    const into = stepBody(grid, corner, -1, 0, 15, [bystander]);
    assert.deepEqual(into, stepMovement(grid, corner.x, corner.y, -1, 0, 15));
  });

  it('ignores itself, so a body cannot be blocked by the entry it appears in', () => {
    const grid = solitary();
    const centre = roomCentre(originOf(grid, 1));
    const self = { id: 7, x: tileCentre(centre.tx), y: tileCentre(centre.ty) };
    assert.deepEqual(
      stepBody(grid, self, 1, 0, 15, [{ id: 7, x: self.x, y: self.y }]),
      stepMovement(grid, self.x, self.y, 1, 0, 15),
    );
  });

  it('walks straight through a body standing on threshold ground', () => {
    const grid = pair();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const doorman = at(2, origin.tx + ROOM_TILES, midY);
    const self = { id: 1, x: doorman.x - 6, y: doorman.y };
    assert.deepEqual(
      stepBody(grid, self, 1, 0, 5, [doorman]),
      stepMovement(grid, self.x, self.y, 1, 0, 5),
    );
  });

  it('keeps the radius the terrain box already uses, so a body fits wherever it fits', () => {
    assert.equal(BODY_RADIUS, PLAYER_RADIUS);
    assert.equal(BODY_SEPARATION, 2 * PLAYER_RADIUS);
    // The reconciliation `station.ts` depends on: a fighter closes to one tile, which is outside this.
    assert.ok(BODY_SEPARATION < TILE_SIZE, 'a mob could never reach melee station');
  });
});

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

describe('placeBody', () => {
  /** Stamps a prop over a tile, the way V8d's scenery pass does. */
  function propAt(grid: TileGrid, tx: number, ty: number): void {
    setTile(grid, tx, ty, Tile.Prop);
  }

  it('honours a preference that is legal, so the roll and the id spread survive untouched', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    const prefer = { tx: origin.tx + 3, ty: origin.ty + 6 };
    assert.deepEqual(placeBody(grid, 1, origin, prefer, []), { ...prefer, stacked: false, blocked: false });
  });

  it('walks a body off a prop it was told to stand in — the kobold in the rock', () => {
    // The owner's screenshot, 2026-08-13: a kobold youth in room 41260 with its head and shoulders out
    // of the top of a grey scenery block. `spawnMob` rolled a tile uniformly across the room and used
    // it, and `Tile.Prop` has been solid since V8d.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const prefer = { tx: origin.tx + 4, ty: origin.ty + 4 };
    propAt(grid, prefer.tx, prefer.ty);

    const landing = placeBody(grid, 1, origin, prefer, []);
    assert.notDeepEqual({ tx: landing.tx, ty: landing.ty }, prefer);
    assert.equal(isWalkable(tileAt(grid, landing.tx, landing.ty)), true);
    assert.equal(landing.stacked, false);
    assert.equal(landing.blocked, false);
    // Beside the prop rather than across the room: the search is nearest-first.
    assert.equal(Math.max(Math.abs(landing.tx - prefer.tx), Math.abs(landing.ty - prefer.ty)), 1);
  });

  it('walks a body off a tile somebody is already standing on', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    const prefer = { tx: origin.tx + 4, ty: origin.ty + 4 };
    const landing = placeBody(grid, 1, origin, prefer, [at(2, prefer.tx, prefer.ty)]);
    assert.notDeepEqual({ tx: landing.tx, ty: landing.ty }, prefer);
    assert.equal(landing.stacked, false);
  });

  it('never leaves the room it was asked for', () => {
    const grid = pair();
    const origin = originOf(grid, 1);
    const tiles = roomTiles(origin);
    // Every tile taken but one, so the search has to range across the whole block to find it.
    const free = tiles[0]!;
    const occupied = tiles.filter((t) => t !== free).map((t, i) => at(100 + i, t.tx, t.ty));
    const landing = placeBody(grid, 1, origin, { tx: origin.tx + 8, ty: origin.ty + 8 }, occupied);
    assert.deepEqual({ tx: landing.tx, ty: landing.ty }, free);
    assert.equal(roomAtTile(grid, landing.tx, landing.ty), 1);
  });

  it('shares a tile rather than losing the mob, and says so', () => {
    // The crowded-den rule. Zone 168's Cubs Den holds more bodies than a nine-tile room has places for,
    // and a reset that dropped the overflow would be a den that empties out over an evening.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const occupied = roomTiles(origin).map((t, i) => at(100 + i, t.tx, t.ty));
    const prefer = { tx: origin.tx + 2, ty: origin.ty + 2 };

    const landing = placeBody(grid, 1, origin, prefer, occupied);
    assert.equal(landing.stacked, true);
    assert.equal(landing.blocked, false);
    assert.deepEqual({ tx: landing.tx, ty: landing.ty }, prefer, 'and stays where it was asked to be');
    assert.equal(isWalkable(tileAt(grid, landing.tx, landing.ty)), true, 'on floor, which is the point');
  });

  it('prefers a walkable tile somebody is on to an empty tile inside a rock', () => {
    // The ranking, stated as a test because it is a judgement rather than an accident: two bodies close
    // together push apart the moment either moves, and a body inside geometry never does.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const tiles = roomTiles(origin);
    const hole = tiles[40]!;
    const occupied: BodyPoint[] = [];
    let id = 100;
    for (const tile of tiles) {
      if (tile === hole) {
        propAt(grid, tile.tx, tile.ty);
        continue;
      }
      occupied.push(at(id++, tile.tx, tile.ty));
    }

    const landing = placeBody(grid, 1, origin, hole, occupied);
    assert.equal(landing.stacked, true);
    assert.equal(isWalkable(tileAt(grid, landing.tx, landing.ty)), true, 'never inside the prop');
  });

  it('reports a room with no floor left rather than throwing or inventing one', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    for (const tile of roomTiles(origin)) propAt(grid, tile.tx, tile.ty);
    const prefer = { tx: origin.tx + 1, ty: origin.ty + 1 };
    const landing = placeBody(grid, 1, origin, prefer, []);
    assert.deepEqual(landing, { ...prefer, stacked: false, blocked: true });
  });

  it('answers identically every time, because a restart must rebuild the same world', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    const prefer = { tx: origin.tx + 4, ty: origin.ty + 4 };
    propAt(grid, prefer.tx, prefer.ty);
    const occupied = [at(2, prefer.tx + 1, prefer.ty), at(3, prefer.tx, prefer.ty + 1)];
    const first = placeBody(grid, 1, origin, prefer, occupied);
    for (let n = 0; n < 5; n++) assert.deepEqual(placeBody(grid, 1, origin, prefer, occupied), first);
  });

  it('leaves every placed body far enough apart to satisfy the mover', () => {
    // The two halves agreeing: placement uses the same separation collision does, so a room filled by
    // resets never starts the tick with a body already refusing to move.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const placed: BodyPoint[] = [];
    for (let n = 0; n < ROOM_TILES * ROOM_TILES; n++) {
      const prefer = { tx: origin.tx + (n % ROOM_TILES), ty: origin.ty + Math.floor(n / ROOM_TILES) };
      const landing = placeBody(grid, 1, origin, prefer, placed);
      assert.equal(landing.stacked, false, `ran out of floor after ${n} bodies`);
      placed.push(at(n, landing.tx, landing.ty));
    }
    for (const a of placed) {
      for (const b of placed) {
        if (a.id === b.id) continue;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= BODY_SEPARATION, 'two bodies placed on top of each other');
      }
    }
  });
});
