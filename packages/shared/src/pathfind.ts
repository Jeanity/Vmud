/**
 * Server-side click-to-move pathfinding.
 *
 * This lives in `shared` rather than in the server for the same reason `stepMovement` does: it is
 * pure grid maths with no I/O, and the client may eventually want it to draw a preview of where a
 * click would take you. It is *called* by the server, though, and only the server's answer is
 * authoritative — see the explored gate below.
 *
 * ## The seen gate
 *
 * A route may never pass through, or end on, ground this character has not seen. Without that rule a
 * player reveals a zone once and then clicks across the whole map, and exploration stops being a
 * thing that happens. That is also precisely why the search runs on the server: a client computing
 * its own route could simply decline to apply the rule.
 *
 * The gate is the `allowed` set of tile indices. **This module does not build it and must not**: it
 * is the character's own `seen` bitset for the Place they are standing on — the union of every set
 * of tiles light has fallen on — decoded by the server (`bitsetToSet` in `vision.ts`) and handed in.
 * `allowed` is opaque here and is only ever probed with `has`, which is what lets the rule change
 * without the search changing.
 *
 * The rule used to be *rooms you have entered*, and the difference is the whole point of the tile
 * model: a room-derived gate had to be built from a per-room reveal map, because corridor tiles
 * belong to no room and `roomAtTile` reports -1 for them, so anything derived from room ownership
 * sealed every corridor. A set of tile indices has no notion of ownership to get wrong, and light
 * spilling through a doorway makes the next room clickable without needing a doorway special case.
 *
 * Everything below therefore tests `allowed` at exactly the same points it tests walls — A*'s
 * `traversable`, and every corner track of the smoothing sweep. A shortcut that checked only walls
 * would straighten a legal route into one that cuts through unseen ground, defeating the rule while
 * every test still passed.
 */

import type { TilePoint } from './protocol.ts';
import {
  PLAYER_RADIUS,
  TILE_SIZE,
  canStand,
  isWalkable,
  tileAt,
  type TileGrid,
} from './tilemap.ts';

/**
 * Ceiling on nodes expanded before giving up.
 *
 * The largest grid in play is 168x156 = 26208 tiles, so this is generous for any real click while
 * still bounding a pathological request to a fraction of a tick.
 */
export const DEFAULT_MAX_NODES = 20_000;

export interface PathRequest {
  readonly grid: TileGrid;
  readonly fromTx: number;
  readonly fromTy: number;
  readonly toTx: number;
  readonly toTy: number;
  /**
   * Tile indices this character may traverse: their `seen` set for this Place, nothing else.
   *
   * Opaque to everything in this module — probed with `has` and never built here, never iterated,
   * never derived from the grid. See the module header.
   */
  readonly allowed: ReadonlySet<number>;
  readonly maxNodes?: number;
}

export type PathFailure = 'unexplored' | 'unreachable' | 'not-walkable' | 'off-map';

export type PathResult =
  | { ok: true; points: TilePoint[] }
  | { ok: false; reason: PathFailure };

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                            */
/* -------------------------------------------------------------------------- */

/** World-pixel centre of a tile. Movement targets tile centres, never tile corners. */
function centreX(tx: number): number {
  return (tx + 0.5) * TILE_SIZE;
}

function centreY(ty: number): number {
  return (ty + 0.5) * TILE_SIZE;
}

/**
 * Can the character walk in a straight line from where it actually stands onto a tile centre?
 *
 * Exported for the one caller outside this module that needs it: the server drops the leading
 * waypoint of a route when the character has already walked past it, and that shortcut has to be
 * held to exactly the same standard as smoothing — walls *and* the explored gate. See
 * {@link segmentClear}.
 */
export function canWalkStraightTo(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  fromX: number,
  fromY: number,
  to: TilePoint,
): boolean {
  return segmentClear(grid, allowed, fromX, fromY, centreX(to.tx), centreY(to.ty));
}

/**
 * Octile distance: the exact cost of an unobstructed 8-way walk.
 *
 * It must be *admissible* (never an overestimate) or A* stops returning optimal paths. Euclidean
 * distance would also be admissible but is a weaker bound and expands more nodes; Manhattan would be
 * an overestimate for diagonal movement and is wrong here.
 */
function octile(dx: number, dy: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  return ax > ay ? ax - ay + Math.SQRT2 * ay : ay - ax + Math.SQRT2 * ax;
}

/** Is this tile walkable ground the character has already seen? Out of bounds is neither. */
function open(grid: TileGrid, allowed: ReadonlySet<number>, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return false;
  return isWalkable(tileAt(grid, tx, ty)) && allowed.has(ty * grid.width + tx);
}

/** The four corners of the collision box, relative to the character's centre. */
const BOX_CORNERS: readonly (readonly [dx: number, dy: number])[] = [
  [-PLAYER_RADIUS, -PLAYER_RADIUS],
  [PLAYER_RADIUS, -PLAYER_RADIUS],
  [-PLAYER_RADIUS, PLAYER_RADIUS],
  [PLAYER_RADIUS, PLAYER_RADIUS],
];

/**
 * Is every tile the collision box touches while sliding along this segment walkable *and* explored?
 *
 * This used to sample the segment at half a tile and run the four-corner standing test at each
 * sample. That argument — "a 20px box against a 16px step overlaps, so nothing goes untested" — is a
 * one-dimensional claim about a two-dimensional sweep, and it is wrong on diagonals: two boxes 16px
 * apart *along* a diagonal are only 11.3px apart per axis, and the swept area has uncovered slivers
 * at the trailing corners. Measured on the shipped data, `findPath(4,4 -> 17,11)` on zone 260 level 0
 * returned a segment that cut the corner of void tile 14,9 by 2.6px — and because the explored gate
 * rode on the same sampler, the identical hole existed in the gate. Nothing but this map's geometry
 * stopped an escape landing on walkable-but-unexplored ground.
 *
 * So do not sample: enumerate. The swept region is the Minkowski sum of the segment and the box, and
 * because the box (20px) is smaller than a tile (32px) in both axes, a tile overlaps that region if
 * and only if one of the four *corner tracks* — the segment translated by (±r, ±r) — passes through
 * it. (If the box overlaps a tile, the box's interval is the shorter one on each axis, so one of its
 * two endpoints per axis lies inside the tile's; that pair of endpoints is a corner, and it is inside
 * the tile.) Four exact tile walks therefore cover the sweep with nothing left over, and cost less
 * than the sampling they replace.
 */
function segmentClear(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  for (const [dx, dy] of BOX_CORNERS) {
    if (!trackClear(grid, allowed, ax + dx, ay + dy, bx + dx, by + dy)) return false;
  }
  return true;
}

/**
 * Every tile one straight line passes through, tested with {@link open}.
 *
 * Amanatides–Woo grid traversal: step to whichever axis boundary is nearer, and when both fall at
 * the same parameter the line is going exactly through a tile corner, so the two tiles sharing that
 * corner are grazed as well and are tested too. Grazing counts as touching here — a route that
 * shaves a wall corner to the pixel is refused rather than rounded off, which costs at worst one
 * un-smoothed waypoint and never a failed path (A* itself does not use this).
 */
function trackClear(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  let tx = Math.floor(ax / TILE_SIZE);
  let ty = Math.floor(ay / TILE_SIZE);
  const endTx = Math.floor(bx / TILE_SIZE);
  const endTy = Math.floor(by / TILE_SIZE);

  if (!open(grid, allowed, tx, ty)) return false;

  const dx = bx - ax;
  const dy = by - ay;
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const deltaX = stepX === 0 ? Infinity : TILE_SIZE / Math.abs(dx);
  const deltaY = stepY === 0 ? Infinity : TILE_SIZE / Math.abs(dy);
  let nextX =
    stepX === 0 ? Infinity : (stepX > 0 ? (tx + 1) * TILE_SIZE - ax : ax - tx * TILE_SIZE) / Math.abs(dx);
  let nextY =
    stepY === 0 ? Infinity : (stepY > 0 ? (ty + 1) * TILE_SIZE - ay : ay - ty * TILE_SIZE) / Math.abs(dy);

  // Bounded by the tiles the walk can possibly cross. Rounding must never turn a missed termination
  // into a spin inside the tick loop.
  let remaining = Math.abs(endTx - tx) + Math.abs(endTy - ty) + 2;
  while ((tx !== endTx || ty !== endTy) && remaining-- > 0) {
    if (nextX < nextY) {
      tx += stepX;
      nextX += deltaX;
    } else if (nextY < nextX) {
      ty += stepY;
      nextY += deltaY;
    } else {
      if (!open(grid, allowed, tx + stepX, ty)) return false;
      if (!open(grid, allowed, tx, ty + stepY)) return false;
      tx += stepX;
      ty += stepY;
      nextX += deltaX;
      nextY += deltaY;
    }
    if (!open(grid, allowed, tx, ty)) return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* A*                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Neighbour offsets in a fixed order: the four straights, then the four diagonals.
 *
 * The order is part of the determinism contract — see the comment on tie-breaking below — and
 * straights coming first means an equal-cost tie during relaxation is resolved in favour of the
 * squarer route, which smooths better.
 */
const NEIGHBOURS: readonly (readonly [dx: number, dy: number, cost: number])[] = [
  [0, -1, 1],
  [1, 0, 1],
  [0, 1, 1],
  [-1, 0, 1],
  [1, -1, Math.SQRT2],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

const UNKNOWN = 0;
const PASSABLE = 1;
const BLOCKED = 2;

/**
 * Finds a route between two tiles, or explains why it could not.
 *
 * The returned points are tile coordinates, starting at `from` and ending at `to`, already
 * simplified — see {@link smooth}. Consecutive points are not necessarily adjacent tiles; they are a
 * polyline the mover can follow in straight lines.
 */
export function findPath(request: PathRequest): PathResult {
  const { grid, fromTx, fromTy, toTx, toTy, allowed } = request;
  const { width, height } = grid;
  const maxNodes = request.maxNodes ?? DEFAULT_MAX_NODES;

  // Failure reasons are reported about the *destination*, because that is the thing the player
  // clicked and the thing they need explaining. They are checked most-specific first so that, for
  // example, a click on unexplored void reads as 'not-walkable' rather than 'unexplored'.
  if (toTx < 0 || toTy < 0 || toTx >= width || toTy >= height) return { ok: false, reason: 'off-map' };
  if (!isWalkable(tileAt(grid, toTx, toTy))) return { ok: false, reason: 'not-walkable' };
  const goal = toTy * width + toTx;
  if (!allowed.has(goal)) return { ok: false, reason: 'unexplored' };

  // A bad *start* is not the player's fault and is not about the click, so it is reported as
  // 'unreachable': the destination was fine, the character just cannot set off.
  if (fromTx < 0 || fromTy < 0 || fromTx >= width || fromTy >= height) {
    return { ok: false, reason: 'unreachable' };
  }
  const start = fromTy * width + fromTx;

  const size = width * height;
  // 0 unknown, 1 passable, 2 blocked. Cached because every tile is tested up to nine times.
  const passable = new Int8Array(size);

  const traversable = (tx: number, ty: number): boolean => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return false;
    const index = ty * width + tx;
    const cached = passable[index] ?? UNKNOWN;
    if (cached !== UNKNOWN) return cached === PASSABLE;
    // In bounds, not void, explored, and the character's box fits at the tile centre.
    //
    // At today's numbers the clearance test is an identity: PLAYER_RADIUS is 10 and a tile half is
    // 16, so a box centred on a tile lies inside that same tile and `canStand` reduces to the
    // `isWalkable` above it. It is kept because it stops being an identity the moment the radius
    // exceeds TILE_SIZE / 2, and A* silently routing characters into gaps they do not fit through is
    // not a failure worth discovering later. What it does *not* do — despite what this comment used
    // to claim — is keep a route off the edge of a corridor; the box only ever leaves its tile
    // *between* waypoints, which is `lineOfSight`'s job, not this one's.
    //
    // **The radius is an adult's, and that is now a choice rather than the only option** (2026-08-16).
    // `canStand` takes one, and a body's own is `bodies.bodyRadius` — but every route this plans is a
    // *player's* click-to-move, players are scale 1, and the mobs that are not go through `hunt.ts`'s
    // room-graph BFS and never reach here. Threading a radius through `findPath` for a caller that
    // does not exist would be a parameter nobody could test. If a large body is ever given A*, this
    // line and `NODE_CORNERS` are the two places that have to learn its size together.
    const ok =
      isWalkable(tileAt(grid, tx, ty)) &&
      allowed.has(index) &&
      canStand(grid, centreX(tx), centreY(ty));
    passable[index] = ok ? PASSABLE : BLOCKED;
    return ok;
  };

  if (!traversable(fromTx, fromTy) || !traversable(toTx, toTy)) {
    // The goal tile passed the walkable and explored checks above, so reaching here means it failed
    // clearance — the character does not fit. That is a property of the route, not of the tile.
    return { ok: false, reason: 'unreachable' };
  }

  if (start === goal) return { ok: true, points: [{ tx: toTx, ty: toTy }] };

  const g = new Float64Array(size).fill(Infinity);
  const parent = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  g[start] = 0;
  const startH = octile(toTx - fromTx, toTy - fromTy);

  const open: OpenSet = { node: [], f: [], h: [] };
  heapPush(open, start, startH, startH);

  let expanded = 0;
  let found = false;

  while (open.node.length > 0) {
    const current = heapPop(open);
    if (closed[current] === 1) continue; // Stale entry: this node was improved after being queued.
    closed[current] = 1;

    if (current === goal) {
      found = true;
      break;
    }

    if (++expanded > maxNodes) break;

    const cx = current % width;
    const cy = (current - cx) / width;
    const gc = g[current] ?? Infinity;

    for (const [dx, dy, cost] of NEIGHBOURS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!traversable(nx, ny)) continue;

      // No corner cutting. A diagonal step is legal only if BOTH shared orthogonal neighbours are
      // themselves traversable. Otherwise the mover slices through a wall corner — and because
      // collision is a box rather than a point, the midpoint of that diagonal is exactly the shared
      // tile corner, so it would immediately jam on geometry the path called clear.
      if (dx !== 0 && dy !== 0) {
        if (!traversable(cx + dx, cy) || !traversable(cx, cy + dy)) continue;
      }

      const next = ny * width + nx;
      if (closed[next] === 1) continue;

      const tentative = gc + cost;
      // Strict improvement only: an equal-cost rediscovery never re-parents, so the first route
      // found at a given cost wins and the parent chain is a function of the scan order alone.
      if (tentative < (g[next] ?? Infinity)) {
        const heuristic = octile(toTx - nx, toTy - ny);
        g[next] = tentative;
        parent[next] = current;
        heapPush(open, next, tentative + heuristic, heuristic);
      }
    }
  }

  if (!found) return { ok: false, reason: 'unreachable' };

  const raw: TilePoint[] = [];
  for (let node = goal; node !== -1; node = parent[node] ?? -1) {
    const tx = node % width;
    raw.push({ tx, ty: (node - tx) / width });
    if (node === start) break;
  }
  raw.reverse();

  return { ok: true, points: smooth(grid, allowed, raw) };
}

/* -------------------------------------------------------------------------- */
/* Binary heap                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The open set: a binary heap of `(node, f, h)` triples in parallel arrays.
 *
 * The keys are held *per entry*, not looked up in the score arrays at comparison time. That is not a
 * micro-optimisation, it is the heap invariant. Relaxation lowers a node's `f` while an entry for
 * that same node may already be sitting in the heap; a comparator reading the live score would then
 * see that entry's key change underneath it, with its position still fixed by the old, larger key
 * and nothing to re-sift it. `heapPop` could return a node that is not the minimum, nodes would be
 * closed out of `f` order, and the `closed` skip during relaxation would lock the worse `g` in
 * permanently. Measured on zone 261 level 0, `79,122 -> 27,22` came back at octile cost 126.811
 * against a true optimum of 126.225 — deterministically, so the determinism tests could not see it.
 *
 * Snapshotting instead means a stale entry keeps its old key, sorts after the improved one, and is
 * discarded by the `closed` check when it eventually surfaces.
 */
interface OpenSet {
  readonly node: number[];
  readonly f: number[];
  readonly h: number[];
}

/**
 * Total ordering of the open set, and the whole of the determinism story.
 *
 * Two identical requests must return byte-identical routes, so ties may never be resolved by
 * whatever order the heap happens to hold equal elements in. The comparator is therefore a *total*
 * order with no ties at all:
 *
 *   1. lower `f` first — ordinary A*;
 *   2. then lower `h` first — prefer the node nearer the goal, which also cuts plateau wandering;
 *   3. then lower tile index first — tile indices are unique, so this can never tie.
 *
 * With a total order the pop sequence is fixed no matter how the heap arranges its array, and with
 * strict-improvement relaxation plus the fixed `NEIGHBOURS` order the parent chain is fixed too.
 * Note that `allowed` is only ever probed by `has`, so its insertion order cannot leak in either.
 */
function before(open: OpenSet, a: number, b: number): boolean {
  const fa = open.f[a] ?? Infinity;
  const fb = open.f[b] ?? Infinity;
  if (fa !== fb) return fa < fb;
  const ha = open.h[a] ?? Infinity;
  const hb = open.h[b] ?? Infinity;
  if (ha !== hb) return ha < hb;
  return (open.node[a] ?? -1) < (open.node[b] ?? -1);
}

function swapEntries(open: OpenSet, a: number, b: number): void {
  const node = open.node[a]!;
  const f = open.f[a]!;
  const h = open.h[a]!;
  open.node[a] = open.node[b]!;
  open.f[a] = open.f[b]!;
  open.h[a] = open.h[b]!;
  open.node[b] = node;
  open.f[b] = f;
  open.h[b] = h;
}

function heapPush(open: OpenSet, node: number, f: number, h: number): void {
  open.node.push(node);
  open.f.push(f);
  open.h.push(h);
  let i = open.node.length - 1;
  while (i > 0) {
    const up = (i - 1) >> 1;
    if (!before(open, i, up)) break;
    swapEntries(open, i, up);
    i = up;
  }
}

function heapPop(open: OpenSet): number {
  const top = open.node[0]!;
  const last = open.node.length - 1;
  swapEntries(open, 0, last);
  open.node.pop();
  open.f.pop();
  open.h.pop();

  let i = 0;
  for (;;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let best = i;
    if (left < open.node.length && before(open, left, best)) best = left;
    if (right < open.node.length && before(open, right, best)) best = right;
    if (best === i) break;
    swapEntries(open, i, best);
    i = best;
  }
  return top;
}

/* -------------------------------------------------------------------------- */
/* Smoothing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Turns a tile-by-tile staircase into a short polyline.
 *
 * Two passes. First drop every point that continues in the same direction as the one before, which
 * collapses long runs to their endpoints for free. Then repeatedly drop an interior point whenever
 * {@link lineOfSight} says the straight segment replacing it clears walls *and* stays inside
 * `allowed` along its whole length. Both endpoints always survive: the mover has to start where it
 * is and stop where the player clicked.
 *
 * The first pass runs no such test, and that is safe only for two reasons that are worth stating
 * because nothing asserts them. A collinear run is a chain of adjacent tiles A* already passed
 * through `traversable`, which includes `allowed.has`. For an axis-aligned run the four corner
 * tracks of the collapsed segment stay in the run's own row or column, because `PLAYER_RADIUS` (10)
 * is less than half a tile (16). For a diagonal run they reach only the chain's orthogonal
 * neighbours, and A*'s no-corner-cutting rule already forced *those* through `traversable` too. Both
 * arguments die the moment `PLAYER_RADIUS` exceeds `TILE_SIZE / 2`: this pass would then emit
 * segments nothing had gate-checked, and it would have to call `lineOfSight` like the second one.
 */
function smooth(grid: TileGrid, allowed: ReadonlySet<number>, raw: readonly TilePoint[]): TilePoint[] {
  if (raw.length <= 2) return raw.map((p) => ({ tx: p.tx, ty: p.ty }));

  const corners: TilePoint[] = [raw[0]!];
  for (let i = 1; i < raw.length - 1; i++) {
    const prev = raw[i - 1]!;
    const here = raw[i]!;
    const next = raw[i + 1]!;
    if (here.tx - prev.tx !== next.tx - here.tx || here.ty - prev.ty !== next.ty - here.ty) {
      corners.push(here);
    }
  }
  corners.push(raw[raw.length - 1]!);

  let i = 0;
  while (i + 2 < corners.length) {
    if (lineOfSight(grid, allowed, corners[i]!, corners[i + 2]!)) {
      corners.splice(i + 1, 1);
    } else {
      i++;
    }
  }
  return corners;
}

/**
 * Can the character walk the straight line between two tile centres?
 *
 * The test is the swept collision box rather than the centre point — a line the *centre* could
 * follow is not one a 20px-wide character can — and it is walls *and* the explored gate together,
 * because a shortcut between two explored waypoints can clip the corner of an unexplored tile and
 * letting that through would reopen the hole the gate exists to close. See {@link segmentClear}.
 */
function lineOfSight(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  a: TilePoint,
  b: TilePoint,
): boolean {
  return segmentClear(grid, allowed, centreX(a.tx), centreY(a.ty), centreX(b.tx), centreY(b.ty));
}
