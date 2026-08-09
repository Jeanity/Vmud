import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canWalkStraightTo, findPath, type PathResult } from './pathfind.ts';
import {
  CONNECTOR_WIDTH,
  PLAYER_RADIUS,
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  buildZoneTilemap,
  canStand,
  isWalkable,
  roomCentre,
  tileAt,
  type TileGrid,
} from './tilemap.ts';
import type { TilePoint } from './protocol.ts';
import { boundsOf, type Room, type RoomId, type Zone } from './world.ts';

/**
 * Synthetic zones only. Beyond making these tests readable it exercises the project rule that the
 * engine must run with no third-party world data present.
 */
function makeZone(rooms: readonly Partial<Room>[]): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: 1,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'forest',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
  })) as Room[];
  return { id: 1, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

/** Two rooms side by side, joined east-west. */
function corridorZone(): Zone {
  return makeZone([
    { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
    { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
  ]);
}

/** An L: (0,0) -> (0,1) -> (1,1). The cell at (1,0) is void, so it is a genuine detour. */
function elbowZone(): Zone {
  return makeZone([
    { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { south: { to: 2 } } },
    { id: 2, pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 }, east: { to: 3 } } },
    { id: 3, pos: { x: 1, y: 1, z: 0 }, exits: { west: { to: 2 } } },
  ]);
}

/** Five rooms in an S, for a route long enough that smoothing has real work to do. */
function snakeZone(): Zone {
  return makeZone([
    { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { south: { to: 2 } } },
    { id: 2, pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 }, east: { to: 3 } } },
    { id: 3, pos: { x: 1, y: 1, z: 0 }, exits: { west: { to: 2 }, south: { to: 4 } } },
    { id: 4, pos: { x: 1, y: 2, z: 0 }, exits: { north: { to: 3 }, east: { to: 5 } } },
    { id: 5, pos: { x: 2, y: 2, z: 0 }, exits: { west: { to: 4 } } },
  ]);
}

/** A ring of four rooms, so there are two routes of equal length between opposite corners. */
function ringZone(): Zone {
  return makeZone([
    { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 }, south: { to: 4 } } },
    { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 }, south: { to: 3 } } },
    { id: 3, pos: { x: 1, y: 1, z: 0 }, exits: { north: { to: 2 }, west: { to: 4 } } },
    { id: 4, pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 }, east: { to: 3 } } },
  ]);
}

/**
 * A hand-built grid, for geometry `buildZoneTilemap` cannot produce.
 *
 * Measured, and re-measured after `ROOM_GAP` moved from 3 to 2: a grid of `ROOM_TILES` blocks on
 * `ROOM_STRIDE` joined by `CONNECTOR_WIDTH` corridors contains *no* diagonal-only gaps at all —
 * every pair of diagonally touching walkable tiles shares at least one walkable orthogonal. That is
 * good news for the world, but it means the no-corner-cutting rule cannot be exercised by generated
 * geometry, so the two tests that cover it use ASCII instead. `.` is floor, `#` is void.
 */
function asciiGrid(rows: readonly string[]): TileGrid {
  const height = rows.length;
  const width = rows[0]!.length;
  const tiles = new Uint8Array(width * height);
  const rooms = new Int32Array(width * height).fill(-1);
  for (let ty = 0; ty < height; ty++) {
    const row = rows[ty]!;
    assert.equal(row.length, width, 'ascii rows must be the same length');
    for (let tx = 0; tx < width; tx++) {
      if (row[tx] === '#') continue;
      const index = ty * width + tx;
      tiles[index] = Tile.Floor;
      rooms[index] = 1;
    }
  }
  return {
    width,
    height,
    level: 0,
    tiles,
    sectors: new Uint8Array(width * height),
    rooms,
    roomOrigins: new Map([[1, { tx: 0, ty: 0 }]]),
    gap: 2,
  };
}

/* -------------------------------------------------------------------------- */
/* Building the gate                                                           */
/* -------------------------------------------------------------------------- */

/*
 * `allowed` is built here, in the tests, and there is deliberately no engine function for it.
 *
 * Production builds it from the character's `seen` bitset — `bitsetToSet(store.seenBits(...))` in
 * the server's `moveTo` — and the pathfinder only ever probes it with `has`, so it is opaque to
 * everything under test in this file. What these fixtures need is a *readable* set with known edges,
 * not a faithful reproduction of how a character accumulates one; the server's own `path.test.ts`
 * covers that, unioning real `computeVisible` discs along a real walk.
 *
 * The predecessor of these two helpers was `allowedTiles(grid, roomIds)`, an engine export that
 * built the gate from a per-room reveal map — the room-granular rule this change retired. It was
 * removed with the rule, because a gate builder shipped next to `findPath` is the first thing the
 * next author reaches for, and reaching for that one would have silently restored "rooms you have
 * entered" with every test still green.
 */

/**
 * Every walkable tile of these room blocks and of the corridor stubs leading out of them.
 *
 * The block expanded by `ROOM_GAP` on each side, intersected with what is walkable. That reaches
 * exactly the carved corridors and cannot touch a neighbouring block, whose own floor starts one
 * tile beyond the expansion. Rooms are visited in the order given, so the *insertion* order of the
 * result differs between `[1,2,3,4]` and `[4,3,2,1]` — which is what the determinism test needs.
 */
function seenIn(grid: TileGrid, rooms: Iterable<RoomId>): Set<number> {
  const out = new Set<number>();
  for (const id of rooms) {
    const origin = grid.roomOrigins.get(id);
    if (!origin) continue;
    for (let ty = origin.ty - ROOM_GAP; ty < origin.ty + ROOM_TILES + ROOM_GAP; ty++) {
      for (let tx = origin.tx - ROOM_GAP; tx < origin.tx + ROOM_TILES + ROOM_GAP; tx++) {
        // `tileAt` reports Void off the grid, so this also keeps negative indices out.
        if (isWalkable(tileAt(grid, tx, ty))) out.add(ty * grid.width + tx);
      }
    }
  }
  return out;
}

/** Every walkable tile on the grid — "this character has seen all of it", for the ASCII fixtures. */
function allSeen(grid: TileGrid): Set<number> {
  const out = new Set<number>();
  for (let ty = 0; ty < grid.height; ty++) {
    for (let tx = 0; tx < grid.width; tx++) {
      if (isWalkable(tileAt(grid, tx, ty))) out.add(ty * grid.width + tx);
    }
  }
  return out;
}

function expectOk(result: PathResult): TilePoint[] {
  assert.ok(result.ok, `expected a path, got ${result.ok ? '' : result.reason}`);
  return result.points;
}

function expectFail(result: PathResult): string {
  assert.ok(!result.ok, 'expected a failure, got a path');
  return result.reason;
}

/** Walks each segment at 4px and asserts the character's whole box clears the walls throughout. */
function assertSegmentsWalkable(grid: TileGrid, points: readonly TilePoint[]): void {
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ax = (a.tx + 0.5) * TILE_SIZE;
    const ay = (a.ty + 0.5) * TILE_SIZE;
    const bx = (b.tx + 0.5) * TILE_SIZE;
    const by = (b.ty + 0.5) * TILE_SIZE;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const px = ax + (bx - ax) * t;
      const py = ay + (by - ay) * t;
      assert.ok(
        canStand(grid, px, py),
        `segment ${a.tx},${a.ty} -> ${b.tx},${b.ty} is blocked at ${px},${py}`,
      );
    }
  }
}

/** Every tile the character's box overlaps along the whole route must be explored. */
function assertSegmentsAllowed(
  grid: TileGrid,
  points: readonly TilePoint[],
  allowed: ReadonlySet<number>,
): void {
  const check = (px: number, py: number): void => {
    for (const [ox, oy] of [
      [-PLAYER_RADIUS, -PLAYER_RADIUS],
      [PLAYER_RADIUS, -PLAYER_RADIUS],
      [-PLAYER_RADIUS, PLAYER_RADIUS],
      [PLAYER_RADIUS, PLAYER_RADIUS],
    ] as const) {
      const tx = Math.floor((px + ox) / TILE_SIZE);
      const ty = Math.floor((py + oy) / TILE_SIZE);
      assert.ok(
        allowed.has(ty * grid.width + tx),
        `route crosses unexplored tile ${tx},${ty}`,
      );
    }
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const ax = (a.tx + 0.5) * TILE_SIZE;
    const ay = (a.ty + 0.5) * TILE_SIZE;
    const bx = (b.tx + 0.5) * TILE_SIZE;
    const by = (b.ty + 0.5) * TILE_SIZE;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      check(ax + (bx - ax) * t, ay + (by - ay) * t);
    }
  }
}

/** How many tiles a raw tile-by-tile path along this polyline would have visited. */
function tileSteps(points: readonly TilePoint[]): number {
  let total = 1;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    total += Math.max(Math.abs(b.tx - a.tx), Math.abs(b.ty - a.ty));
  }
  return total;
}

function centreOf(grid: TileGrid, room: RoomId): TilePoint {
  return roomCentre(grid.roomOrigins.get(room)!);
}

/** Octile cost of a returned polyline — the same measure A* minimises. */
function routeCost(points: readonly TilePoint[]): number {
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = Math.abs(points[i + 1]!.tx - points[i]!.tx);
    const dy = Math.abs(points[i + 1]!.ty - points[i]!.ty);
    total += dx > dy ? dx - dy + Math.SQRT2 * dy : dy - dx + Math.SQRT2 * dx;
  }
  return total;
}

/**
 * The true least cost between two tiles, by Dijkstra.
 *
 * Deliberately the dumbest correct implementation available: no heuristic, no early exit, and a
 * linear scan for the minimum instead of a priority queue — a reference that shares a data structure
 * with the thing it is checking checks nothing. Same 8-way moves and same no-corner-cutting rule as
 * `findPath`, so the two are directly comparable.
 */
function optimalCost(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  from: TilePoint,
  to: TilePoint,
): number | undefined {
  const { width, height } = grid;
  const walk = (tx: number, ty: number): boolean =>
    tx >= 0 && ty >= 0 && tx < width && ty < height &&
    isWalkable(tileAt(grid, tx, ty)) && allowed.has(ty * width + tx);

  const dist = new Float64Array(width * height).fill(Infinity);
  const done = new Uint8Array(width * height);
  dist[from.ty * width + from.tx] = 0;

  for (;;) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < dist.length; i++) {
      if (done[i] === 0 && (dist[i] ?? Infinity) < bestDist) {
        bestDist = dist[i]!;
        best = i;
      }
    }
    if (best === -1) break;
    done[best] = 1;

    const cx = best % width;
    const cy = (best - cx) / width;
    for (const [dx, dy] of [
      [0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!walk(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!walk(cx + dx, cy) || !walk(cx, cy + dy))) continue;
      const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
      const index = ny * width + nx;
      if (bestDist + step < (dist[index] ?? Infinity)) dist[index] = bestDist + step;
    }
  }

  const answer = dist[to.ty * width + to.tx];
  return answer === undefined || answer === Infinity ? undefined : answer;
}

/**
 * A deterministic pseudo-random maze, in the `#`/`.` form {@link asciiGrid} takes.
 *
 * Big and knotty on purpose. The heap bug this fixture exists for needs a search with enough
 * plateau churn to re-queue nodes that are already sitting in the open set, which a five-room
 * synthetic zone never produces. The generator is a plain LCG so the maze is a pure function of the
 * seed and the suite cannot start failing on a Tuesday.
 */
function mazeRows(seed: number, width: number, height: number, wallPercent: number): string[] {
  let state = seed >>> 0;
  const next = (n: number): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state % n;
  };
  const rows: string[] = [];
  for (let ty = 0; ty < height; ty++) {
    let row = '';
    for (let tx = 0; tx < width; tx++) row += next(100) < wallPercent ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/** The walkable tile nearest a given point, scanned in a fixed order so it is deterministic. */
function nearestOpen(rows: readonly string[], sx: number, sy: number): TilePoint {
  let best: TilePoint = { tx: sx, ty: sy };
  let bestDist = Infinity;
  for (let ty = 0; ty < rows.length; ty++) {
    const row = rows[ty]!;
    for (let tx = 0; tx < row.length; tx++) {
      if (row[tx] === '#') continue;
      const d = (tx - sx) ** 2 + (ty - sy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { tx, ty };
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */

/*
 * A self-check on the fixture helper, not a statement about the engine — {@link seenIn} is test code
 * and nothing ships it. It is here because every gate assertion below is only as meaningful as the
 * set it is given: if `seenIn` silently stopped reaching the corridor stubs, half this suite would
 * be asserting that routes fail for a reason that has nothing to do with the code under test.
 */
describe('the fixture gate', () => {
  it('covers a room block and the corridor stubs leading out of it, and nothing further', () => {
    const grid = buildZoneTilemap(corridorZone());
    const allowed = seenIn(grid, [1]);

    // The room's own 9x9 floor, plus a CONNECTOR_WIDTH x ROOM_GAP stub heading east — and not one
    // tile of the room block on the far side of that stub.
    assert.equal(allowed.size, ROOM_TILES * ROOM_TILES + CONNECTOR_WIDTH * ROOM_GAP);

    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    for (let step = 0; step < ROOM_GAP; step++) {
      const tx = origin.tx + ROOM_TILES + step;
      assert.ok(allowed.has(midY * grid.width + tx), `corridor tile ${tx},${midY} missing`);
    }
    const beyond = grid.roomOrigins.get(2)!;
    assert.equal(allowed.has(midY * grid.width + beyond.tx), false, 'the next room must stay dark');
  });

  it('skips rooms that are not on this grid', () => {
    const grid = buildZoneTilemap(corridorZone());
    assert.equal(seenIn(grid, [1, 9999]).size, seenIn(grid, [1]).size);
  });
});

describe('findPath — clearance', () => {
  it('a 3-wide corridor has a standable centre line', () => {
    // The claim that makes corridors passable at all: the character is a 20px box in 32px tiles, so
    // it needs a tile whose centre it clears. Verified rather than assumed.
    const grid = buildZoneTilemap(corridorZone());
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;

    for (let step = 0; step < ROOM_GAP; step++) {
      const tx = origin.tx + ROOM_TILES + step;
      assert.equal(tileAt(grid, tx, midY), Tile.Connector);
      assert.ok(
        canStand(grid, (tx + 0.5) * TILE_SIZE, (midY + 0.5) * TILE_SIZE),
        `no clearance on the corridor centre line at ${tx},${midY}`,
      );
    }

    // And nothing walkable anywhere on this grid fails clearance at its own centre, so the
    // clearance gate never rejects a tile the corridor geometry actually offers.
    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        if (!isWalkable(tileAt(grid, tx, ty))) continue;
        assert.ok(canStand(grid, (tx + 0.5) * TILE_SIZE, (ty + 0.5) * TILE_SIZE));
      }
    }
  });
});

describe('findPath — routing', () => {
  it('walks a straight corridor between two rooms', () => {
    const grid = buildZoneTilemap(corridorZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 2);
    assert.equal(from.ty, to.ty, 'east-west neighbours share a row');

    const points = expectOk(
      findPath({
        grid,
        fromTx: from.tx,
        fromTy: from.ty,
        toTx: to.tx,
        toTy: to.ty,
        allowed: seenIn(grid, [1, 2]),
      }),
    );

    // A dead-straight run smooths all the way down to its endpoints.
    assert.deepEqual(points, [from, to]);
    assertSegmentsWalkable(grid, points);
  });

  it('routes around an obstacle', () => {
    const grid = buildZoneTilemap(elbowZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 3);
    const allowed = seenIn(grid, [1, 2, 3]);

    const points = expectOk(
      findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed }),
    );

    assert.deepEqual(points[0], from);
    assert.deepEqual(points[points.length - 1], to);
    assert.ok(points.length > 2, 'a detour cannot be a single straight segment');

    // The cell at (1,0) is void, so the route has to dip into room 2's row before heading east.
    const cornerTx = ROOM_STRIDE; // first column of the (1, *) cell column
    const cornerTy = ROOM_STRIDE; // first row of the (*, 1) cell row
    for (const p of points) {
      assert.ok(!(p.tx >= cornerTx && p.ty < cornerTy), `point ${p.tx},${p.ty} is in the void cell`);
    }

    assertSegmentsWalkable(grid, points);
    assertSegmentsAllowed(grid, points, allowed);
  });

  it('never routes through a tile outside `allowed`', () => {
    // The ring gives two routes of equal length between opposite corners. Whichever room is left
    // unexplored, the answer must be the *other* route — this is the anti-speedrun rule itself, and
    // asserting it both ways proves the gate is doing the steering rather than a fixed tie-break.
    const grid = buildZoneTilemap(ringZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 3);

    const inRoom = (p: TilePoint, room: RoomId): boolean => {
      const o = grid.roomOrigins.get(room)!;
      return p.tx >= o.tx && p.tx < o.tx + ROOM_TILES && p.ty >= o.ty && p.ty < o.ty + ROOM_TILES;
    };

    const routes: TilePoint[][] = [];
    for (const [explored, forbidden, permitted] of [
      [[1, 2, 3], 4, 2],
      [[1, 3, 4], 2, 4],
    ] as const) {
      const allowed = seenIn(grid, explored);
      const points = expectOk(
        findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed }),
      );

      for (const p of points) {
        assert.ok(
          allowed.has(p.ty * grid.width + p.tx),
          `waypoint ${p.tx},${p.ty} is outside the explored set`,
        );
        assert.ok(!inRoom(p, forbidden), `waypoint ${p.tx},${p.ty} is inside unexplored room ${forbidden}`);
      }
      assert.ok(points.some((p) => inRoom(p, permitted)), `route should pass through room ${permitted}`);

      assertSegmentsWalkable(grid, points);
      assertSegmentsAllowed(grid, points, allowed);
      routes.push(points);
    }

    assert.notDeepEqual(routes[0], routes[1], 'the explored set must change which way round the ring we go');
  });
});

describe('findPath — doors', () => {
  /** Two rooms joined by a door both sides declare, in the given state. */
  function gatedZone(closed: boolean): Zone {
    const door = { name: 'an iron gate', closed, locked: false };
    return makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, door } } },
    ]);
  }

  it('will not route through a shut door, however well explored the far room is', () => {
    // The half of the bug that made the fog gate look like the culprit: the route was refused for the
    // right reason only by accident, because click-to-move happily crossed a locked door as soon as
    // the tiles beyond it had been seen. `open` in `pathfind.ts` resolves against `isWalkable`, so
    // this now falls out of the same fact that stops WASD.
    const grid = buildZoneTilemap(gatedZone(true));
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 2);

    const result = findPath({
      grid,
      fromTx: from.tx,
      fromTy: from.ty,
      toTx: to.tx,
      toTy: to.ty,
      allowed: allSeen(grid),
    });
    assert.equal(expectFail(result), 'unreachable');
  });

  it('routes through the same doorway once it is open', () => {
    const grid = buildZoneTilemap(gatedZone(false));
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 2);

    const points = expectOk(
      findPath({
        grid,
        fromTx: from.tx,
        fromTy: from.ty,
        toTx: to.tx,
        toTy: to.ty,
        allowed: allSeen(grid),
      }),
    );
    assert.deepEqual(points[points.length - 1], to);
  });

  it('reports not-walkable for a click on the shut door itself', () => {
    const grid = buildZoneTilemap(gatedZone(true));
    const from = centreOf(grid, 1);
    const doorTile = { tx: ROOM_TILES, ty: from.ty };
    assert.equal(tileAt(grid, doorTile.tx, doorTile.ty), Tile.Door);

    const result = findPath({
      grid,
      fromTx: from.tx,
      fromTy: from.ty,
      toTx: doorTile.tx,
      toTy: doorTile.ty,
      allowed: allSeen(grid),
    });
    assert.equal(expectFail(result), 'not-walkable');
  });
});

describe('findPath — corner cutting', () => {
  it('refuses a diagonal step through a corner both orthogonals block', () => {
    const grid = asciiGrid([
      '..##',
      '..##',
      '##..',
      '##..',
    ]);
    const allowed = allSeen(grid);

    // (1,1) and (2,2) touch only at a corner: (2,1) and (1,2) are both void. Cutting it would put
    // the character's box straight through the wall junction.
    assert.ok(isWalkable(tileAt(grid, 1, 1)) && isWalkable(tileAt(grid, 2, 2)));
    assert.ok(!isWalkable(tileAt(grid, 2, 1)) && !isWalkable(tileAt(grid, 1, 2)));

    const result = findPath({ grid, fromTx: 0, fromTy: 0, toTx: 3, toTy: 3, allowed });
    assert.equal(expectFail(result), 'unreachable');
  });

  it('takes the diagonal once one orthogonal opens up', () => {
    // The control for the test above: same shape, but (2,1) is floor, so the two halves join
    // through a real opening rather than a corner.
    const grid = asciiGrid([
      '..##',
      '...#',
      '##..',
      '##..',
    ]);
    const allowed = allSeen(grid);
    const points = expectOk(findPath({ grid, fromTx: 0, fromTy: 0, toTx: 3, toTy: 3, allowed }));
    assert.deepEqual(points[0], { tx: 0, ty: 0 });
    assert.deepEqual(points[points.length - 1], { tx: 3, ty: 3 });
    assertSegmentsWalkable(grid, points);
  });
});

describe('findPath — failure reasons', () => {
  it('reports off-map for a click outside the grid', () => {
    const grid = buildZoneTilemap(corridorZone());
    const from = centreOf(grid, 1);
    const allowed = seenIn(grid, [1, 2]);
    const base = { grid, fromTx: from.tx, fromTy: from.ty, allowed };

    assert.equal(expectFail(findPath({ ...base, toTx: -1, toTy: from.ty })), 'off-map');
    assert.equal(expectFail(findPath({ ...base, toTx: from.tx, toTy: -1 })), 'off-map');
    assert.equal(expectFail(findPath({ ...base, toTx: grid.width, toTy: from.ty })), 'off-map');
    assert.equal(expectFail(findPath({ ...base, toTx: from.tx, toTy: grid.height })), 'off-map');
  });

  it('reports not-walkable for a click on void', () => {
    // Two rooms with no exit between them: the gap stays void.
    const grid = buildZoneTilemap(
      makeZone([
        { id: 1, pos: { x: 0, y: 0, z: 0 } },
        { id: 2, pos: { x: 1, y: 0, z: 0 } },
      ]),
    );
    const from = centreOf(grid, 1);
    const void1 = { tx: ROOM_TILES, ty: from.ty };
    assert.equal(tileAt(grid, void1.tx, void1.ty), Tile.Void);

    const result = findPath({
      grid,
      fromTx: from.tx,
      fromTy: from.ty,
      toTx: void1.tx,
      toTy: void1.ty,
      allowed: seenIn(grid, [1, 2]),
    });
    assert.equal(expectFail(result), 'not-walkable');
  });

  it('reports unexplored for a walkable tile this character has not seen', () => {
    const grid = buildZoneTilemap(corridorZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 2);
    assert.ok(isWalkable(tileAt(grid, to.tx, to.ty)), 'the target is real floor');

    const result = findPath({
      grid,
      fromTx: from.tx,
      fromTy: from.ty,
      toTx: to.tx,
      toTy: to.ty,
      allowed: seenIn(grid, [1]),
    });
    assert.equal(expectFail(result), 'unexplored');
  });

  it('reports unreachable when the target is explored but disconnected', () => {
    const grid = buildZoneTilemap(
      makeZone([
        { id: 1, pos: { x: 0, y: 0, z: 0 } },
        { id: 2, pos: { x: 1, y: 0, z: 0 } },
      ]),
    );
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 2);
    const allowed = seenIn(grid, [1, 2]);
    assert.ok(allowed.has(to.ty * grid.width + to.tx), 'the target is explored');

    const result = findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed });
    assert.equal(expectFail(result), 'unreachable');
  });

  it('reports unreachable rather than hanging when the node budget runs out', () => {
    const grid = buildZoneTilemap(elbowZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 3);
    const allowed = seenIn(grid, [1, 2, 3]);
    const base = { grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed };

    assert.equal(expectFail(findPath({ ...base, maxNodes: 4 })), 'unreachable');
    assert.ok(findPath(base).ok, 'the same request succeeds with the default budget');
  });

  it('distinguishes all four reasons on one grid', () => {
    const grid = buildZoneTilemap(
      makeZone([
        { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
        { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
        { id: 3, pos: { x: 3, y: 0, z: 0 } },
      ]),
    );
    const from = centreOf(grid, 1);
    const allowed = seenIn(grid, [1, 3]);
    const base = { grid, fromTx: from.tx, fromTy: from.ty, allowed };
    const two = centreOf(grid, 2);
    const three = centreOf(grid, 3);

    const reasons = [
      expectFail(findPath({ ...base, toTx: grid.width + 5, toTy: 0 })),
      expectFail(findPath({ ...base, toTx: ROOM_TILES, toTy: 0 })),
      expectFail(findPath({ ...base, toTx: two.tx, toTy: two.ty })),
      expectFail(findPath({ ...base, toTx: three.tx, toTy: three.ty })),
    ];
    assert.deepEqual(reasons, ['off-map', 'not-walkable', 'unexplored', 'unreachable']);
    assert.equal(new Set(reasons).size, 4, 'the four reasons must be distinguishable');
  });
});

describe('findPath — determinism', () => {
  it('returns identical output for identical requests', () => {
    const grid = buildZoneTilemap(ringZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 3);
    const request = {
      grid,
      fromTx: from.tx,
      fromTy: from.ty,
      toTx: to.tx,
      toTy: to.ty,
      allowed: seenIn(grid, [1, 2, 3, 4]),
    };

    const first = expectOk(findPath(request));
    const second = expectOk(findPath(request));
    assert.deepEqual(second, first);
    assert.equal(JSON.stringify(second), JSON.stringify(first));
  });

  it('does not depend on the insertion order of the allowed set', () => {
    // Two routes of equal cost exist through the ring; which one is chosen must be fixed by the
    // tie-break rule, not by how the explored set happened to be assembled.
    const grid = buildZoneTilemap(ringZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 3);
    const forward = seenIn(grid, [1, 2, 3, 4]);
    const backward = seenIn(grid, [4, 3, 2, 1]);
    assert.equal(forward.size, backward.size);
    assert.notDeepEqual([...forward], [...backward], 'the two sets should differ in order');

    const a = expectOk(findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed: forward }));
    const b = expectOk(findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed: backward }));
    assert.deepEqual(b, a);
  });
});

describe('findPath — optimality', () => {
  it('returns a least-cost route and not merely a route', () => {
    // Nothing else in this suite compares the answer against a reference optimum, and that is how a
    // real defect hid: the heap comparator read the live `f`/`h` score arrays, so relaxing a node
    // already sitting in the open set changed that entry's sort key underneath it while its position
    // stayed fixed by the old, larger key. `heapPop` could then return something that was not the
    // minimum, nodes closed out of order, and the `closed` skip locked the worse `g` in for good.
    // It is deterministic, so the determinism tests could not see it; measured on zone 261 it cost
    // 0.55% on 4 routes in 2866. This seed is one where the corner-to-corner routes catch it.
    const rows = mazeRows(29, 44, 56, 22);
    const grid = asciiGrid(rows);
    const allowed = allSeen(grid);

    const corners = [
      nearestOpen(rows, 0, 0),
      nearestOpen(rows, 43, 0),
      nearestOpen(rows, 0, 55),
      nearestOpen(rows, 43, 55),
    ];

    let checked = 0;
    for (const from of corners) {
      for (const to of corners) {
        if (from.tx === to.tx && from.ty === to.ty) continue;
        const optimal = optimalCost(grid, allowed, from, to);
        if (optimal === undefined) continue;

        const points = expectOk(
          findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed }),
        );
        // Smoothing replaces a staircase with straight segments, which never costs more in octile
        // terms and is what the mover actually walks, so equality is the right assertion.
        assert.ok(
          Math.abs(routeCost(points) - optimal) < 1e-9,
          `route ${from.tx},${from.ty} -> ${to.tx},${to.ty} cost ${routeCost(points)}, optimum ${optimal}`,
        );
        assertSegmentsWalkable(grid, points);
        assertSegmentsAllowed(grid, points, allowed);
        checked++;
      }
    }
    assert.ok(checked >= 8, `the fixture should connect most corners, only checked ${checked}`);
  });
});

describe('findPath — smoothing', () => {
  it('collapses the staircase while keeping every segment walkable', () => {
    const grid = buildZoneTilemap(snakeZone());
    const from = centreOf(grid, 1);
    const to = centreOf(grid, 5);
    const allowed = seenIn(grid, [1, 2, 3, 4, 5]);

    const points = expectOk(
      findPath({ grid, fromTx: from.tx, fromTy: from.ty, toTx: to.tx, toTy: to.ty, allowed }),
    );

    // `tileSteps` is how many tiles a raw, unsmoothed A* path would have listed along this same
    // polyline — one per step, since every segment is straight or a pure diagonal.
    const raw = tileSteps(points);
    assert.ok(raw >= 30, `expected a long route to smooth, got ${raw} tiles`);
    assert.ok(
      points.length * 3 < raw,
      `smoothing should cut waypoints hard: ${points.length} waypoints for ${raw} tiles`,
    );

    assertSegmentsWalkable(grid, points);
    assertSegmentsAllowed(grid, points, allowed);
  });

  it('keeps both endpoints exactly', () => {
    const grid = buildZoneTilemap(elbowZone());
    // Deliberately off-centre, so a smoother that snapped to room centres would be caught.
    const origin1 = grid.roomOrigins.get(1)!;
    const origin3 = grid.roomOrigins.get(3)!;
    const from = { tx: origin1.tx + 1, ty: origin1.ty + 1 };
    const to = { tx: origin3.tx + ROOM_TILES - 2, ty: origin3.ty + ROOM_TILES - 2 };

    const points = expectOk(
      findPath({
        grid,
        fromTx: from.tx,
        fromTy: from.ty,
        toTx: to.tx,
        toTy: to.ty,
        allowed: seenIn(grid, [1, 2, 3]),
      }),
    );
    assert.deepEqual(points[0], from);
    assert.deepEqual(points[points.length - 1], to);
  });

  it('does not shave a wall corner on a diagonal shortcut', () => {
    // Transcribed tile for tile from zone 260 level 0 with rooms 77504 and 77503 explored — the
    // shape that broke the old smoother, which sampled each candidate segment every half tile and
    // ran the four-corner standing test at each sample. That argument is one-dimensional and a
    // diagonal sweep is not: two 20px boxes 16px apart along a diagonal are only 11.3px apart per
    // axis, leaving uncovered slivers at the trailing corners. Here it collapsed the route to
    // (4,4) -> (12,5) -> (17,11), whose second segment cuts 2.6px into the void at 14,9.
    //
    // The walkability half of that is merely embarrassing — the server drew and walked a route
    // through a wall and `stepMovement` scraped along it. The other half is the point of this test:
    // the explored gate rode on the same sampler, so it had the identical hole, and only this map's
    // geometry stopped an escape landing on walkable-but-unexplored ground.
    const grid = asciiGrid([
      '.........###.........###',
      '.........###.........###',
      '.........###.........###',
      '.....................###',
      '.....................###',
      '.....................###',
      '.........###.........###',
      '.........###.........###',
      '.........###.........###',
      '###############...######',
      '###############...######',
      '###############...######',
    ]);
    const allowed = allSeen(grid);
    assert.ok(!isWalkable(tileAt(grid, 14, 9)), '14,9 is the void corner the old route clipped');

    const points = expectOk(findPath({ grid, fromTx: 4, fromTy: 4, toTx: 17, toTy: 11, allowed }));
    assert.deepEqual(points[0], { tx: 4, ty: 4 });
    assert.deepEqual(points[points.length - 1], { tx: 17, ty: 11 });

    // The old route was exactly these three points; keeping the diagonal would be the regression.
    assert.notDeepEqual(points, [
      { tx: 4, ty: 4 },
      { tx: 12, ty: 5 },
      { tx: 17, ty: 11 },
    ]);

    assertSegmentsWalkable(grid, points);
    assertSegmentsAllowed(grid, points, allowed);
  });

  it('refuses a straight line from an off-centre position that would clip geometry', () => {
    // `canWalkStraightTo` is what lets the server drop a leading waypoint the character has already
    // walked past. It runs the same swept-box test as smoothing, so the shortcut is held to the same
    // standard — including the explored gate — rather than being taken on trust.
    const grid = asciiGrid([
      '....####',
      '....####',
      '########',
      '####....',
      '####....',
    ]);
    const allowed = allSeen(grid);
    // 1,1 and 4,3 touch diagonally through a solid junction; no straight line between them is legal.
    assert.equal(canWalkStraightTo(grid, allowed, 1.5 * TILE_SIZE, 1.5 * TILE_SIZE, { tx: 5, ty: 4 }), false);
    // Within one open block it is fine, from anywhere the box actually fits.
    assert.equal(canWalkStraightTo(grid, allowed, 1.5 * TILE_SIZE, 1.5 * TILE_SIZE, { tx: 3, ty: 0 }), true);
    assert.equal(canWalkStraightTo(grid, allowed, 0.5 * TILE_SIZE + 6, 1.5 * TILE_SIZE - 5, { tx: 3, ty: 1 }), true);
  });

  it('returns a single point when already standing on the target', () => {
    const grid = buildZoneTilemap(corridorZone());
    const from = centreOf(grid, 1);
    const points = expectOk(
      findPath({
        grid,
        fromTx: from.tx,
        fromTy: from.ty,
        toTx: from.tx,
        toTy: from.ty,
        allowed: seenIn(grid, [1]),
      }),
    );
    assert.deepEqual(points, [from]);
  });
});
