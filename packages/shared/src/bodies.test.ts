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

import { RACE_SIZE, SIZE_SCALE } from './appearance.ts';
import {
  BODY_RADIUS,
  BODY_SEPARATION,
  MAX_BODY_RADIUS,
  MAX_BODY_SIZE,
  bodyClearance,
  bodyRadius,
  bodySizeOf,
  bodySolidAt,
  placeBody,
  stepBody,
  type BodyPoint,
} from './bodies.ts';
import {
  CONNECTOR_WIDTH,
  MAX_TERRAIN_RADIUS,
  PLAYER_RADIUS,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  buildZoneTilemap,
  canStand,
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

/**
 * The three sizes this file walks bodies around at, taken off the real ladder rather than invented.
 *
 * Named constants and not `bodySizeOf` calls, deliberately: the collision rules are geometry and must
 * be testable without the appearance pipeline standing behind them — `bodySizeOf` gets its own case
 * below, which is where the two are tied together. The numbers are what `appearanceOf` actually
 * produces for the bodies named beside them, measured 2026-08-14.
 */
/** A hill giant — `SIZE_GIANT`, 4.98 m drawn, 27.5px of radius. 192 of the world's spawned bodies. */
const GIANT = 2.75;
/** A kobold youth — the smallest body in the world, 0.54 m drawn and 3.01px of radius. */
const KOBOLD = 0.3007;
/** A dragon or a titan: the top of `SIZE_SCALE`, 40px of radius, and nothing in the world yet. */
const GARGANTUAN = 4;

/** A body at the centre of a tile. Ids are arbitrary but must differ from the mover's. */
function at(id: number, tx: number, ty: number, scale?: number): BodyPoint {
  return { id, x: tileCentre(tx), y: tileCentre(ty), ...(scale === undefined ? {} : { scale }) };
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
    // Spread rather than rebuilt from three fields: the mover's own `scale` is half of every clearance
    // it is judged by, and dropping it here would have quietly walked every giant as a person.
    const next = stepBody(grid, { ...self, x, y }, intent.x, intent.y, Math.min(15, remaining), others);
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
    // Walked with intermediate aims, and that is now a *choice* rather than a necessity. It was written
    // when going round a wall of bodies was the planner's job — three abreast being, the note said, a
    // local minimum no stateless rule escapes. `stepBody` escapes it since 2026-08-13 (see the wall
    // cases above), so the walker would very likely get there aimed straight at the far side. Steering
    // it by hand keeps the claim this case is actually here to make narrow and stable: **the room is
    // not sealed** — a property of the geometry and the exemption, which must go on holding whatever
    // the deflection does next.
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

  it('walks round a wall of bodies instead of oscillating in the pocket between two of them', () => {
    // **The owner's kobolds, 2026-08-13**: five lined up along a room edge, *"haven't moved since."*
    //
    // The deflection used to be the tangent of the *nearest* disc, and against a row of them that is a
    // two-tick flip-flop — clearing A makes B the nearest, and B's tangent points back at A. Measured
    // in the server at 3.53px of amplitude, in perpetuity. It is the *sequence* that fails and no
    // single step of which is wrong, so this has to be walked rather than asserted; `walkTo`'s own
    // docblock says as much and this is the case it was written for.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    // Five abreast down the middle column — wider than the three the old note called a local minimum
    // no stateless rule escapes, and still two clear rows at each end of a nine-tile room to go by.
    const wall = [-2, -1, 0, 1, 2].map((dy, i) => at(10 + i, origin.tx + 4, midY + dy));
    const self = { id: 1, x: tileCentre(origin.tx + 1), y: tileCentre(midY) };
    const goal = { x: tileCentre(origin.tx + ROOM_TILES - 1), y: tileCentre(midY) };

    // Every position the walk stood on, so the failure can be named rather than inferred from a
    // timeout: a mover that revisits a pixel it has already left is going back and forth by
    // definition, and that is the whole of the bug.
    const seen = new Set<string>();
    let repeated: string | undefined;
    let { x, y } = self;
    let arrived = false;
    for (let n = 0; n < 400 && !arrived; n++) {
      const key = `${x.toFixed(2)},${y.toFixed(2)}`;
      if (seen.has(key) && repeated === undefined) repeated = key;
      seen.add(key);
      const dx = goal.x - x;
      const dy = goal.y - y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= 1) {
        arrived = true;
        break;
      }
      const intent = normaliseIntent(dx, dy);
      const next = stepBody(grid, { id: 1, x, y }, intent.x, intent.y, Math.min(15, remaining), wall);
      x = next.x;
      y = next.y;
    }

    assert.equal(repeated, undefined, `stood on ${repeated} twice — the mover is oscillating, not walking`);
    assert.equal(arrived, true, `never got past the wall; stopped at ${x},${y}`);
    // And it did go *round*, not through: the wall is as solid as it ever was.
    for (const body of wall) {
      assert.ok(
        Math.hypot(x - body.x, y - body.y) >= BODY_SEPARATION - 1e-6,
        'ended up inside one of the wall',
      );
    }
  });

  it('commits to one side of a wall rather than re-deciding, which is what made the loop', () => {
    // The property behind the fix, stated on its own so a rewrite cannot lose it while keeping the walk
    // above green: the way round must be chosen by **which end of the wall is nearer**, and nothing
    // else. That is what makes it monotone — every step toward the near end shortens that side and
    // lengthens the other, so acting on the answer only confirms it. The old rule read the nearest
    // *body* instead, which says nothing about where the wall ends, and flipped every tick.
    //
    // Pressed against the wall at exactly {@link BODY_SEPARATION}, so the mover is genuinely refused at
    // every offset. Further off and it slips diagonally between two of them — legal, 23px of clearance
    // at the midpoint — and never reaches the deflection at all.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const wall = [-2, -1, 0, 1, 2].map((dy, i) => at(10 + i, origin.tx + 4, midY + dy));
    const face = tileCentre(origin.tx + 4) - BODY_SEPARATION;

    for (let offset = 4; offset <= TILE_SIZE * 2; offset += 4) {
      for (const hand of [1, -1]) {
        const self = { id: 1, x: face, y: tileCentre(midY) + offset * hand };
        const next = stepBody(grid, self, 1, 0, 15, wall);
        // Nearer the southern end, go south; nearer the northern end, go north. Never the long way.
        assert.ok(
          hand > 0 ? next.y > self.y : next.y < self.y,
          `${offset}px ${hand > 0 ? 'south' : 'north'} of centre, the mover took the long way round`,
        );
        // And it is a *sidestep*, not a shuffle into the wall: the forward axis must not creep.
        assert.equal(next.x, self.x, 'the detour crept toward the wall instead of along it');
      }
    }

    // Dead centre is the one genuine tie, and `CLAUDE.md` rule 3 forbids tossing for it: the road rule
    // decides, and decides the same way on every restart.
    const centred = { id: 1, x: face, y: tileCentre(midY) };
    const first = stepBody(grid, centred, 1, 0, 15, wall);
    assert.ok(first.y > centred.y, 'a symmetric wall should be passed on the right, which is south');
    for (let n = 0; n < 5; n++) assert.deepEqual(stepBody(grid, centred, 1, 0, 15, wall), first);
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

  it('keeps an adult’s radius the one the terrain box uses, so a person fits wherever they fit', () => {
    assert.equal(BODY_RADIUS, PLAYER_RADIUS);
    assert.equal(BODY_SEPARATION, 2 * PLAYER_RADIUS);
    assert.equal(bodyRadius({ id: 1, x: 0, y: 0 }), PLAYER_RADIUS, 'an unsized body is a person');
    // The reconciliation `station.ts` depends on: a fighter closes to one tile, which is outside this.
    assert.ok(BODY_SEPARATION < TILE_SIZE, 'a mob could never reach melee station');
  });
});

/* -------------------------------------------------------------------------- */
/* Size, which is now a property of the body                                   */
/* -------------------------------------------------------------------------- */

/**
 * **The slice this section is the characterisation of**, 2026-08-14: a body drawn larger than a human
 * collides larger.
 *
 * Every case below is one that says nothing at all when both bodies are scale 1 — which is the trap the
 * brief for this work named, and which the whole of the file above walks straight into, because a rule
 * about `rA + rB` evaluated for two adults is arithmetically the old constant. The cases are chosen at
 * the ends of the ladder the world actually stands on rather than in the middle of it.
 */
describe('a body’s radius is its own', () => {
  it('puts the world’s bodies on the ladder, reading the drawn height and not the mesh scale', () => {
    // A person is 1 by construction: the base mesh is `ADULT_HEIGHT` and nothing scales it.
    assert.equal(bodySizeOf({ kind: 'player', sprite: 'human' }), 1);
    // Race is what makes a giant giant, and it lands whole — 27.5px of radius against a person's 10.
    assert.equal(bodySizeOf({ kind: 'mob', sprite: 'muscular/human', race: 'G' }), GIANT);
    assert.equal(BODY_RADIUS * GIANT, 27.5);
    // Age and race multiply, exactly as `appearanceOf` says they do: a giant's child.
    assert.equal(bodySizeOf({ kind: 'mob', sprite: 'child/human', race: 'G' }), 0.72 * GIANT);
    // An unraced template is a person, which is the same answer an unknown race code gets.
    assert.equal(bodySizeOf({ kind: 'mob', sprite: 'male/human' }), 1);
    assert.equal(bodySizeOf({ kind: 'mob', sprite: 'male/human', race: 'not-a-race' }), 1);
    // And the judgement this rule carries, stated rather than hidden: height stands in for width, so
    // the female base body — 43 mm shorter as authored — gets a 2.4% smaller disc.
    const female = bodySizeOf({ kind: 'mob', sprite: 'female/human' });
    assert.ok(female > 0.97 && female < 0.98, `female bodies came out at ${female}`);
  });

  it('never exceeds the cap the broad-phase query is sized against, over the whole race table', () => {
    // Exhaustive over the tables rather than sampled, because the failure it guards is silent: a body
    // wider than `MAX_BODY_RADIUS` is a body `sim.bodiesNear` can fail to offer, and a blocker the
    // query never yields is a blocker that gets walked through.
    for (const race of [...Object.keys(RACE_SIZE), 'unknown', undefined]) {
      for (const word of ['', 'male', 'female', 'muscular', 'child', 'teen', 'skeleton', 'zombie']) {
        for (const head of ['human', 'kobold', 'wolf', 'orc']) {
          const sprite = word === '' ? head : `${word}/${head}`;
          const size = bodySizeOf({ kind: 'mob', sprite, ...(race === undefined ? {} : { race }) });
          assert.ok(size > 0, `${sprite}/${race} sized ${size}, which is not a body`);
          assert.ok(
            size <= MAX_BODY_SIZE,
            `${sprite} of race ${race} is ${size}x, past the ${MAX_BODY_SIZE}x cap`,
          );
        }
      }
    }
    assert.equal(MAX_BODY_SIZE, Math.max(...SIZE_SCALE), 'today the tallest mesh is under the ladder');
    assert.equal(MAX_BODY_RADIUS, 40);
  });

  it('holds a person out of a giant at 37.5px, where an adult pair would have closed to 20', () => {
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const giant = at(2, origin.tx + 4, midY, GIANT);
    assert.equal(bodyClearance({ id: 1, x: 0, y: 0 }, giant), 37.5);

    // 45px out, due east. One 15px step lands at 30px — outside two adults' 20 and well inside 37.5.
    const self = { id: 1, x: giant.x - 45, y: giant.y };
    const next = stepBody(grid, self, 1, 0, 15, [giant]);
    assert.ok(
      Math.hypot(next.x - giant.x, next.y - giant.y) >= 37.5 - 1e-9,
      `closed to ${Math.hypot(next.x - giant.x, next.y - giant.y)}px of a giant`,
    );
    assert.equal(next.x, self.x, 'the forward axis crept toward it instead of stepping round');

    // The same step, against a body of the same shape that is merely a person: allowed, in full. This
    // is the pair rule doing the work — nothing about the mover, the floor or the step changed.
    const person = at(2, origin.tx + 4, midY);
    assert.equal(stepBody(grid, self, 1, 0, 15, [person]).x, self.x + 15);
  });

  it('keeps two giants 55px apart, which is a tile and three quarters', () => {
    // The measurement the whole slice came from: two 4.98 m bodies kept 0.625 m between their centres
    // and stood inside each other. 55px is 1.72 m, which is what their silhouettes want.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const other = at(2, origin.tx + 5, midY, GIANT);
    const self: BodyPoint = { id: 1, x: tileCentre(origin.tx + 1), y: tileCentre(midY), scale: GIANT };
    assert.equal(bodyClearance(self, other), 55);
    assert.ok(bodyClearance(self, other) > TILE_SIZE, 'two giants cannot share adjacent tiles');

    const walk = walkTo(grid, self, { x: other.x, y: other.y }, [other]);
    const gap = Math.hypot(walk.x - other.x, walk.y - other.y);
    assert.ok(gap >= 55 - 1e-6, `one giant closed to ${gap}px of the other`);
    assert.equal(walk.arrived, false, 'a body cannot walk onto another body’s centre');
  });

  it('lets a kobold stand on the tile beside a giant, where a person cannot', () => {
    // The two ends of the ladder against the one constant that did not move — 32px, the tile. A person
    // and a giant want 37.5 and therefore *overlap* on adjacent tiles; a kobold youth and a giant want
    // 30.5 and fit. That inversion is the whole feature, and it is invisible at scale 1.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const giant = at(2, origin.tx + 4, midY, GIANT);
    const kobold: BodyPoint = { id: 1, x: tileCentre(origin.tx + 3), y: tileCentre(midY), scale: KOBOLD };
    const person: BodyPoint = { id: 1, x: kobold.x, y: kobold.y };

    assert.ok(bodyClearance(kobold, giant) < TILE_SIZE, 'the fixture should fit the kobold');
    assert.ok(bodyClearance(person, giant) > TILE_SIZE, 'and should not fit the person');

    // The kobold is clear, so it may walk on past — north, south, or straight by.
    assert.equal(stepBody(grid, kobold, 0, 1, 15, [giant]).y, kobold.y + 15);
    // The person is already inside the giant, and escape valve 1 is what stops that being a weld: it
    // may take any step that does not push further in, and none that does.
    assert.equal(stepBody(grid, person, -1, 0, 15, [giant]).x, person.x - 15, 'welded to a giant');
    assert.equal(stepBody(grid, person, 1, 0, 15, [giant]).x, person.x, 'and shouldered further in');
  });

  it('does not trap a person in the corner between a giant and a wall', () => {
    // "A giant against a wall", and it is a case that only exists now. A giant's clearance is 37.5px
    // and a tile is 32, so a person standing on the tile next to one is *already* inside it — a state
    // placement refuses to create but stacking and a teleport both can. The wall takes two of the four
    // ways out, so this is where a weld would actually bite.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const giant = at(2, origin.tx + 1, origin.ty, GIANT);
    const corner: BodyPoint = { id: 1, x: tileCentre(origin.tx), y: tileCentre(origin.ty) };
    assert.equal(bodySolidAt(grid, giant.x, giant.y), true, 'the fixture must be solid ground');
    assert.ok(
      Math.hypot(corner.x - giant.x, corner.y - giant.y) < bodyClearance(corner, giant),
      'the fixture should start the person inside the giant',
    );

    // North and west are the walls, and `canStand` refuses both whatever is standing about.
    assert.equal(stepBody(grid, corner, 0, -1, 15, [giant]).y, corner.y, 'walked through the wall');
    // South is open floor and it opens the gap, so it must be allowed — and it must be the way out.
    const away = stepBody(grid, corner, 0, 1, 15, [giant]);
    assert.equal(away.y, corner.y + 15);
    const walk = walkTo(grid, corner, { x: corner.x, y: tileCentre(origin.ty + ROOM_TILES - 1) }, [giant]);
    assert.equal(walk.arrived, true, `sealed into the corner at ${walk.x},${walk.y}`);
  });

  it('walks past a wall of mixed sizes without oscillating or clipping any of them', () => {
    // The heterogeneous sweep, end to end. `sidestep` used to order the group by the *centre* of each
    // body, which is the same order as by near shoulder only while every body wants the same clearance;
    // with a giant beside a kobold the two orders differ and the near shoulder is the one that decides
    // whether a gap is real. This is the observable half of that — the mover has to get past a wall
    // whose gaps are only wide enough where the small bodies are.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const wall = [
      at(10, origin.tx + 4, midY - 2, GIANT),
      at(11, origin.tx + 4, midY - 1, KOBOLD),
      at(12, origin.tx + 4, midY, GIANT),
      at(13, origin.tx + 4, midY + 1, KOBOLD),
      at(14, origin.tx + 4, midY + 2, GIANT),
    ];
    const self = { id: 1, x: tileCentre(origin.tx + 1), y: tileCentre(midY) };
    const goal = { x: tileCentre(origin.tx + ROOM_TILES - 1), y: tileCentre(midY) };

    const seen = new Set<string>();
    let repeated: string | undefined;
    let { x, y } = self;
    let arrived = false;
    for (let n = 0; n < 400 && !arrived; n++) {
      const key = `${x.toFixed(2)},${y.toFixed(2)}`;
      if (seen.has(key) && repeated === undefined) repeated = key;
      seen.add(key);
      const dx = goal.x - x;
      const dy = goal.y - y;
      const remaining = Math.hypot(dx, dy);
      if (remaining <= 1) {
        arrived = true;
        break;
      }
      const intent = normaliseIntent(dx, dy);
      const next = stepBody(grid, { id: 1, x, y }, intent.x, intent.y, Math.min(15, remaining), wall);
      x = next.x;
      y = next.y;
    }

    assert.equal(repeated, undefined, `stood on ${repeated} twice — the mover is oscillating`);
    assert.equal(arrived, true, `never got past the mixed wall; stopped at ${x},${y}`);
    for (const body of wall) {
      const clear = bodyClearance({ id: 1, x, y }, body);
      assert.ok(Math.hypot(x - body.x, y - body.y) >= clear - 1e-6, `ended up inside body ${body.id}`);
    }
  });

  it('still refuses a gargantuan the ground a gargantuan needs, at the top of the ladder', () => {
    // Nothing in the world is `SIZE_GARGANTUAN` today — `RACE_SIZE` carries dragons, titans, constructs
    // and avatars against a harvest that has authored none of them — so this is the rung the world will
    // meet before anybody re-reads this file. 40px of radius, 80px between two of them: two and a half
    // tiles, which is more than a quarter of a room.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const other = at(2, origin.tx + 6, midY, GARGANTUAN);
    const self: BodyPoint = { id: 1, x: tileCentre(origin.tx + 1), y: tileCentre(midY), scale: GARGANTUAN };
    assert.equal(bodyClearance(self, other), 80);
    assert.equal(bodyRadius(self), MAX_BODY_RADIUS);

    const walk = walkTo(grid, self, { x: other.x, y: other.y }, [other]);
    assert.ok(Math.hypot(walk.x - other.x, walk.y - other.y) >= 80 - 1e-6);
  });
});

/* -------------------------------------------------------------------------- */
/* And so is the floor it stands on                                            */
/* -------------------------------------------------------------------------- */

/**
 * **The other half of the same slice, 2026-08-16**: the walls know how big a body is too.
 *
 * The 2026-08-14 note called this a knowingly-shipped remainder and gave three reasons it could not be
 * unpicked on its own — `placeBody`'s standability test, the no-wedge proof and the client predictor.
 * All three are restated here rather than deleted, and the cases below are the ones that say nothing
 * whatever at scale 1. `tilemap.test.ts` owns the `canStand` arithmetic (including the sweep proving
 * the adult answer did not move by a hair); this owns what a *body* does with it.
 */
describe('a body’s terrain box is its own', () => {
  it('walks a giant through a human’s doorway, which is the whole question this slice turns on', () => {
    // **The measurement the mechanism was chosen against.** "A giant cannot use a human's corridor" is
    // a defensible design and "a giant is sealed in its spawn room" is a bug, and the two are the same
    // sentence until you check the arithmetic: a gate is `CONNECTOR_WIDTH` tiles, 96px, and a giant's
    // box is 55px. It fits, with 41px of lateral play, and that is why a per-body terrain box was
    // affordable at all. Over the shipped world: 0 of 222 large bodies confined to their own room.
    const grid = pair();
    const from = roomCentre(originOf(grid, 1));
    const to = roomCentre(originOf(grid, 2));
    const giant: BodyPoint = { id: 1, x: tileCentre(from.tx), y: tileCentre(from.ty), scale: GIANT };

    const walk = walkTo(grid, giant, { x: tileCentre(to.tx), y: tileCentre(to.ty) }, []);
    assert.equal(walk.arrived, true, `a giant could not leave its room; stopped at ${walk.x},${walk.y}`);
    assert.equal(roomAtTile(grid, Math.floor(walk.x / TILE_SIZE), Math.floor(walk.y / TILE_SIZE)), 2);
  });

  it('refuses a giant the wall a person walks up to, which is the artefact it removes', () => {
    // Before this, `canStand` tested 10px whatever was walking, so a hill giant pressed against a wall
    // stood with **17.5px of itself inside it** — a quarter of a body, visible from the camera's usual
    // 24 m. The person still gets right up to the wall; the giant is stopped a tile short of it.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const start = { x: tileCentre(origin.tx + 4), y: tileCentre(midY) };
    const west = { x: tileCentre(origin.tx) - TILE_SIZE, y: tileCentre(midY) };

    const wall = origin.tx * TILE_SIZE;
    const person = walkTo(grid, { id: 1, ...start }, west, []);
    const giant = walkTo(grid, { id: 1, ...start, scale: GIANT }, west, []);
    assert.equal(person.arrived, false, 'the fixture aims through the wall on purpose');
    assert.equal(giant.arrived, false);
    assert.ok(person.x - PLAYER_RADIUS < wall + TILE_SIZE, 'a person should reach the edge tile');
    assert.ok(giant.x > person.x, 'the giant walked as far into the wall as the person did');
    assert.equal(canStand(grid, giant.x, giant.y, BODY_RADIUS * GIANT), true, 'ended inside geometry');

    // And the artefact itself, without the 15px tick quantising it: `PLAYER_RADIUS` from the wall is a
    // position the old rule accepted from *anybody*, and a giant standing there has 17.5px of itself
    // in the stone — the figure `BODY_RADIUS`'s docblock has carried since 2026-08-14.
    const flush = wall + PLAYER_RADIUS;
    assert.equal(canStand(grid, flush, start.y), true, 'a person may stand flush against a wall');
    assert.equal(canStand(grid, flush, start.y, BODY_RADIUS * GIANT), false);
    assert.equal(flush - BODY_RADIUS * GIANT, wall - 17.5);
  });

  it('keeps the no-wedge proof, with every chokepoint cell occupied and a giant doing the walking', () => {
    // The proof's two halves have to hold for the **largest** mover, not the one they were written
    // with: the cells are exempt from body solidity, and the gate is wide enough for the box. Both are
    // asked at once here — three bodies across each of the gate's cells, and a hill giant threading
    // them. The mover is refused by neither, and neither is a coincidence of it being small.
    const grid = pair();
    const origin = originOf(grid, 1);
    const far = originOf(grid, 2);
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const half = (CONNECTOR_WIDTH - 1) / 2;
    const crowd: BodyPoint[] = [];
    let id = 100;
    for (let dy = -half; dy <= half; dy++) {
      crowd.push(at(id++, origin.tx + ROOM_TILES - 1, midY + dy));
      crowd.push(at(id++, far.tx, midY + dy));
      for (let tx = origin.tx + ROOM_TILES; tx < far.tx; tx++) crowd.push(at(id++, tx, midY + dy));
    }

    const from = roomCentre(origin);
    const giant: BodyPoint = { id: 1, x: tileCentre(from.tx), y: tileCentre(from.ty), scale: GIANT };
    const walk = walkTo(grid, giant, { x: tileCentre(far.tx + 4), y: tileCentre(midY) }, crowd);
    assert.equal(walk.arrived, true, `a giant was corked in: stopped at ${walk.x},${walk.y}`);
    assert.equal(roomAtTile(grid, Math.floor(walk.x / TILE_SIZE), Math.floor(walk.y / TILE_SIZE)), 2);
  });

  it('lets a gargantuan out of a room too, because the terrain box is clamped and the body box is not', () => {
    // The rung the world has not reached: `MAX_BODY_RADIUS` is 40px and a gate is 96, which leaves 8px
    // of play — not enough for an axis-separated slide to find, so an unclamped terrain box would seal
    // a dragon in its own lair. `MAX_TERRAIN_RADIUS` is 32, so it walks out clipping the frame by 8px.
    // The **body** box is untouched at 40: it still keeps 80px from another gargantuan.
    assert.equal(MAX_BODY_RADIUS, 40);
    assert.ok(MAX_TERRAIN_RADIUS < MAX_BODY_RADIUS, 'the clamp is doing nothing');
    const grid = pair();
    const from = roomCentre(originOf(grid, 1));
    const to = roomCentre(originOf(grid, 2));
    const dragon: BodyPoint = { id: 1, x: tileCentre(from.tx), y: tileCentre(from.ty), scale: GARGANTUAN };

    const walk = walkTo(grid, dragon, { x: tileCentre(to.tx), y: tileCentre(to.ty) }, []);
    assert.equal(walk.arrived, true, `a gargantuan was sealed in; stopped at ${walk.x},${walk.y}`);
    assert.equal(bodyClearance(dragon, dragon), 80, 'the body box shrank with the terrain box');
  });

  it('never welds a body standing where its own box does not fit', () => {
    // The terrain twin of escape valve 1, at the level `stepBody` sees it. `placeBody` degrades rather
    // than losing a mob and a door can shut across a shoulder, so a giant *can* be standing on ground
    // it does not fit on — and a rule that judged every step by a box it cannot satisfy would refuse
    // all four directions for ever. It is moved as a person until it reaches ground of its own.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const corner: BodyPoint = { id: 1, x: tileCentre(origin.tx), y: tileCentre(origin.ty), scale: GIANT };
    assert.equal(canStand(grid, corner.x, corner.y, BODY_RADIUS * GIANT), false, 'the fixture must not fit');

    const out = stepBody(grid, corner, 1, 1, 15, []);
    assert.ok(out.x > corner.x && out.y > corner.y, 'a giant put in a corner cannot move at all');
    const walk = walkTo(grid, corner, { x: tileCentre(origin.tx + 4), y: tileCentre(origin.ty + 4) }, []);
    assert.equal(walk.arrived, true, 'and it cannot walk back onto ground it fits on');
    assert.equal(canStand(grid, walk.x, walk.y, BODY_RADIUS * GIANT), true);
  });

  it('leaves a person’s step exactly what it was, bodies and all', () => {
    // The compatibility clause, restated for the whole of `stepBody` rather than for `canStand` alone:
    // an adult body's radius is `PLAYER_RADIUS`, so every call it makes resolves to the default and the
    // client's predictor — which is scale 1 by construction — stays reconcilable.
    const grid = pair();
    const origin = originOf(grid, 1);
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        const x = tileCentre(origin.tx + dx);
        const y = tileCentre(origin.ty + dy);
        for (const [ix, iy] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, 0.8]] as const) {
          assert.deepEqual(
            stepBody(grid, { id: 1, x, y }, ix, iy, 15, []),
            stepMovement(grid, x, y, ix, iy, 15),
            `an adult's step moved at ${x},${y} heading ${ix},${iy}`,
          );
        }
      }
    }
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
    assert.deepEqual(placeBody(grid, 1, origin, prefer, []), {
      ...prefer,
      stacked: false,
      blocked: false,
      squeezed: false,
    });
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
    assert.deepEqual(landing, { ...prefer, stacked: false, blocked: true, squeezed: false });
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

  it('will not load a second giant on the tile beside the first — 55px needs two cells, not one', () => {
    // The owner's rule at the far end of the ladder: *"never have mobs or players load on top of each
    // other."* Any free tile satisfies two adults, because 32 > 20. Two giants want 55, so every one of
    // the eight neighbours fails — 32px orthogonally, 45.25 on the diagonal — and the Chebyshev ring
    // search has to walk out to the second ring, 64px, to find one. It does, without being told.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const first = { tx: origin.tx + 4, ty: origin.ty + 4 };
    const standing = [at(2, first.tx, first.ty, GIANT)];

    const landing = placeBody(grid, 1, origin, first, standing, GIANT);
    assert.equal(landing.stacked, false, 'the room had room and the search did not find it');
    const apart = Math.hypot(tileCentre(landing.tx) - standing[0]!.x, tileCentre(landing.ty) - standing[0]!.y);
    assert.ok(apart >= 55 - 1e-9, `two giants loaded ${apart}px apart`);
    assert.equal(Math.max(Math.abs(landing.tx - first.tx), Math.abs(landing.ty - first.ty)), 2);
  });

  it('still lets a kobold in beside the giant that just refused a person', () => {
    // The same tile, the same occupant, a different body asking. Placement reads the pair exactly as
    // movement does, so the answer moves with who is being placed rather than with the room.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const spot = { tx: origin.tx + 4, ty: origin.ty + 4 };
    const giant = [at(2, spot.tx, spot.ty, GIANT)];
    const beside = { tx: spot.tx + 1, ty: spot.ty };

    assert.deepEqual(
      { tx: placeBody(grid, 1, origin, beside, giant, KOBOLD).tx, ty: placeBody(grid, 1, origin, beside, giant, KOBOLD).ty },
      beside,
      'a kobold youth wants 30.5px and the tile offers 32',
    );
    assert.notDeepEqual(
      { tx: placeBody(grid, 1, origin, beside, giant).tx, ty: placeBody(grid, 1, origin, beside, giant).ty },
      beside,
      'a person wants 37.5px and must be moved off',
    );
  });

  it('fits sixteen giants in a nine-tile room and stacks the seventeenth rather than losing it', () => {
    // How much headroom the large end of the ladder actually has, measured rather than argued — and
    // this is one of the numbers the terrain box moved, on 2026-08-16. It used to be **24**, giants on
    // every other cell of the whole nine-tile room; a giant's box is nine cells now, so it keeps the
    // **7x7 interior**, and every other cell of a 7x7 is a 4x4 grid at 64px pitch. Sixteen.
    //
    // Sixteen is also the *geometric* bound rather than what greed happened to reach, which the old
    // 24-of-25 was not: the search loses nothing to having no backtracking here. The world's most
    // giant-heavy room holds six (measured 2026-08-14), so the headroom is nearly threefold.
    //
    // The seventeenth is the Cubs Den rule at the other end of the ladder. **A missing mob is worse
    // than an overlap**, so it lands stacked and says so; what it must never do is be refused.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const placed: BodyPoint[] = [];
    for (let n = 0; n < 16; n++) {
      const prefer = { tx: origin.tx + (n % ROOM_TILES), ty: origin.ty + Math.floor(n / ROOM_TILES) };
      const landing = placeBody(grid, 1, origin, prefer, placed, GIANT);
      assert.equal(landing.stacked, false, `ran out of floor after ${n} giants`);
      assert.equal(landing.squeezed, false, `giant ${n} was squeezed onto ground it does not fit`);
      // Never the edge ring: a 3x3 box on a room's outer cell has a corner in the wall.
      assert.ok(
        landing.tx > origin.tx &&
          landing.ty > origin.ty &&
          landing.tx < origin.tx + ROOM_TILES - 1 &&
          landing.ty < origin.ty + ROOM_TILES - 1,
        `giant ${n} was put on the room's edge ring at ${landing.tx},${landing.ty}`,
      );
      placed.push(at(100 + n, landing.tx, landing.ty, GIANT));
    }
    for (const a of placed) {
      for (const b of placed) {
        if (a.id === b.id) continue;
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= 55 - 1e-9, `${a.id} and ${b.id} are inside each other`);
      }
    }

    const overflow = placeBody(grid, 1, origin, { tx: origin.tx + 4, ty: origin.ty + 4 }, placed, GIANT);
    assert.equal(overflow.stacked, true, 'the seventeenth found floor the first sixteen did not');
    assert.equal(overflow.blocked, false, 'and it is standing on floor, which is the point of the ranking');
    assert.equal(overflow.squeezed, false, 'the interior still had ground it fits on');
  });

  it('puts a large body only where its own box fits, and a small one anywhere', () => {
    // The placement half of "the terrain box is the body's own". Same room, same preferred tile, two
    // bodies: the kobold is left where it was asked to stand and the giant is walked in off the wall.
    const grid = solitary();
    const origin = originOf(grid, 1);
    const edge = { tx: origin.tx, ty: origin.ty + 4 };

    assert.deepEqual(
      { ...placeBody(grid, 1, origin, edge, [], KOBOLD) },
      { ...edge, stacked: false, blocked: false, squeezed: false },
    );
    const giant = placeBody(grid, 1, origin, edge, [], GIANT);
    assert.equal(giant.tx, origin.tx + 1, 'a giant should be walked one cell off the wall');
    assert.equal(
      Math.max(Math.abs(giant.tx - edge.tx), Math.abs(giant.ty - edge.ty)),
      1,
      'and no further than that — the search is nearest-first',
    );
    assert.equal(giant.squeezed, false);
  });

  it('squeezes a giant onto a person’s ground rather than reporting a room with no floor', () => {
    // Rung 4, which never fires on the world as shipped (0 of 2,016 spawns, 2026-08-16) and exists
    // because the alternative is worse than what it does. Props over the whole 7x7 interior leave a
    // giant nothing its own box fits on; without this rung `placeBody` would answer `blocked` — *"this
    // room has no floor"* — and stand it at the rolled tile, which may be inside a wall.
    const grid = solitary();
    const origin = originOf(grid, 1);
    for (let dy = 1; dy < ROOM_TILES - 1; dy++) {
      for (let dx = 1; dx < ROOM_TILES - 1; dx++) propAt(grid, origin.tx + dx, origin.ty + dy);
    }
    const prefer = { tx: origin.tx, ty: origin.ty + 4 };
    const landing = placeBody(grid, 1, origin, prefer, [], GIANT);
    assert.equal(landing.squeezed, true, 'the room still offered a giant ground it fits on');
    assert.equal(landing.blocked, false, 'a room with a ring of floor is not a room with no floor');
    assert.equal(landing.stacked, false);
    assert.equal(isWalkable(tileAt(grid, landing.tx, landing.ty)), true, 'squeezed into a prop');

    // **And the squeeze buys nothing from the bodies.** It is a concession to the walls only, so the
    // pair clearance is still the full 55px and the second giant is put elsewhere on the ring.
    const first = at(2, landing.tx, landing.ty, GIANT);
    const second = placeBody(grid, 1, origin, prefer, [first], GIANT);
    assert.equal(second.squeezed, true);
    assert.ok(
      Math.hypot(tileCentre(second.tx) - first.x, tileCentre(second.ty) - first.y) >= 55 - 1e-9,
      'the squeeze let two giants stand inside each other',
    );
  });
});
