/**
 * **Bodies are solid** — the owner's ask, 2026-08-13: *"can we make mobs solid objects so they can't
 * walk through each others and players can't walk through them either"*, and, in the same breath,
 * *"never have mobs or players load on top of each other also as that will likely cause issues."*
 *
 * Two halves of one fact, so they live in one module: nothing may **walk** into a body, and nothing may
 * be **placed** on one. `tilemap.ts` answers both questions about the floor; this answers them about
 * whoever is standing on it.
 *
 * ## Why this is not a few lines inside `stepMovement`
 *
 * A wall never moves and is validated at build time — `seamless.test.ts` proves a flood-fill of the
 * rendered tiles equals a walk of the room graph, so the geometry can never seal a route. **A body
 * can.** It moves, it arrives where it likes, and three of them standing abreast in a three-tile gate
 * would close a doorway that the world's own law says is open. That is not a hypothetical: this project
 * has already paid for placement that trapped the owner (*"I was stuck behind the log"*, and the fix was
 * a placement discipline rather than a nudge), and a prop at least holds still.
 *
 * So solidity here is deliberately **not uniform**. It is a property of the ground a body stands on:
 *
 * - On a room's floor a body is solid, which is the whole feature.
 * - On **threshold ground** — the connector, seam and doorway cells between rooms, and the mouth tiles
 *   of a *narrow* gate — a body is not solid at all. See {@link bodySolidAt}.
 *
 * That single rule is what makes the no-wedge proof finite instead of probabilistic: every tile that
 * could be the last way out of a room is a tile a body cannot stand on *as an obstacle*, so no
 * arrangement of bodies can seal a room. Everywhere else there is a nine-tile floor to walk around on.
 *
 * ## And the two escape valves
 *
 * Even inside a room, a refusal must never be a trap:
 *
 * 1. **A step that opens a gap is always allowed.** Bodies can end up overlapping anyway — a crowded
 *    den's placement fallback stacks rather than losing a mob, a teleport lands on someone — and a
 *    refusal that also refused the way *out* of an overlap would weld the two together for ever.
 * 2. **A body dead ahead is walked around, not walked into.** Terrain slides because a wall is
 *    axis-aligned and `stepMovement` resolves the axes separately; a body is a disc, and a mover
 *    heading straight at one has no off-axis component to slide on. {@link stepBody} projects the
 *    intent onto the disc's tangent instead, which is the same idea the wall slide is — remove the
 *    component that points into the obstacle and keep the rest.
 *
 * Nothing here rolls anything. Placement search order is fixed and the tangent's tie-break is a
 * constant, so two servers with the same seed put the same body on the same tile (`CLAUDE.md` rule 3).
 */

import {
  CONNECTOR_WIDTH,
  PLAYER_RADIUS,
  ROOM_TILES,
  TILE_SIZE,
  type TileGrid,
  canStand,
  isWalkable,
  normaliseIntent,
  roomAtTile,
  stepMovement,
  tileAt,
  tileCentre,
} from './tilemap.ts';
import type { RoomId } from './world.ts';

/**
 * Anything that occupies floor. Structural on purpose: `Actor` lives in the server and `shared` may not
 * import it, and the only three fields collision needs are the three every body already has.
 */
export interface BodyPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

/**
 * Half-extent of a living body for body-against-body tests, in pixels — **the same number the terrain
 * box uses**, and that identity is the point rather than a coincidence.
 *
 * A second, smaller figure would let a body slip through a gap its own collision box does not fit in;
 * a larger one would let it be refused by a doorway it demonstrably fits through. One radius means the
 * space a body needs is the space a body takes.
 *
 * The consequence worth writing down is the number it produces. Two bodies keep {@link BODY_SEPARATION}
 * — 20px — between their centres, and `station.ts`'s `MELEE_STATION` is `TILE_SIZE`, 32. Its docblock
 * already claimed *"there are 12 units of daylight between the collision boxes"* at station; with this
 * constant that sentence stops being an observation about the art and becomes the collision rule:
 * 32 − 20 = 12, so a fighter closing to station is never refused by the body it is closing on.
 */
export const BODY_RADIUS = PLAYER_RADIUS;

/** How far apart two body centres must stay. Two discs of {@link BODY_RADIUS}, touching. */
export const BODY_SEPARATION = BODY_RADIUS * 2;

/** Squared, because every comparison in here is against a squared distance and `hypot` is not free. */
const SEPARATION_SQ = BODY_SEPARATION * BODY_SEPARATION;

/**
 * Fraction of a requested step that has to land along the intent before {@link stepBody} accepts it
 * without trying to go round.
 *
 * **The same 0.25 the route's stall counter in `sim.ts` uses, and deliberately the same number.** That
 * one decides whether a tick counted as progress; this one decides whether a tick was worth taking.
 * Two different answers would mean a mover creeping along at a rate the walker calls "moving" and the
 * route calls "stuck" — or worse, the reverse: a detour that reads as a stall and ends the walk.
 */
const PROGRESS_FRACTION = 0.25;

/** The four orthogonal neighbours, for the threshold scan. */
const ORTHOGONAL: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * **Whether a body standing here is an obstacle** — the wedge rule, and the one thing in this module
 * that is a judgement rather than arithmetic.
 *
 * Three answers, in order:
 *
 * 1. **A tile belonging to no room is never solid.** Connectors, open doorways and seam cells are the
 *    only route between two rooms and nothing is *meant* to stand on them: `station.ts` refuses a step
 *    that would leave the room, the in-room shuffle requires `roomAtTile === mob.roomId`, and `hunt.ts`
 *    settles a walker a couple of tiles *past* the threshold precisely because standing in a doorway
 *    reads as through-traffic. So a body is on one of these cells only while walking across it, which
 *    is exactly the moment you want two bodies to be able to pass.
 *
 * 2. **A room tile at the mouth of a narrow gate is not solid either.** A gate is
 *    {@link CONNECTOR_WIDTH} — three tiles, 96px. Body centres sit on tile centres 32px apart and need
 *    20px of clearance, so a mover cannot thread between two bodies on adjacent tiles: three bodies on
 *    the three mouth tiles is a sealed door, and three *sentinels* there is a permanently sealed door.
 *    Exempting the mouth removes the arrangement instead of hoping the dice miss it.
 *
 * 3. **Everywhere else a body is solid**, which is most of a nine-tile room and all of the open
 *    ground that outdoor rooms merge into.
 *
 * The narrowness test in (2) is measured against the grid rather than assumed, because
 * `connectorSpan` already gives two answers: a door or an indoor pair gets `CONNECTOR_WIDTH`, while two
 * outdoor rooms merge along their **whole shared edge** and get `ROOM_TILES`. A merged edge is nine
 * tiles wide and needs nine abreast to close, so it keeps its bodies solid; a gate does not. Reading
 * the live grid also means a door that opens flips this answer for free — `setDoorTiles` rewrites the
 * cells and the next query sees the gate.
 */
export function bodySolidAt(grid: TileGrid, x: number, y: number): boolean {
  const tx = Math.floor(x / TILE_SIZE);
  const ty = Math.floor(y / TILE_SIZE);
  if (roomAtTile(grid, tx, ty) === -1) return false;

  for (const [dx, dy] of ORTHOGONAL) {
    const ax = tx + dx;
    const ay = ty + dy;
    // Still inside the room: not an edge in this direction.
    if (roomAtTile(grid, ax, ay) !== -1) continue;
    // A wall, a shut door, a blocked seam. Not a way out, so nothing here can seal one.
    if (!isWalkable(tileAt(grid, ax, ay))) continue;
    if (gateWidth(grid, ax, ay, dx, dy) <= CONNECTOR_WIDTH) return false;
  }
  return true;
}

/**
 * How many walkable between-rooms cells lie abreast of this one, across the direction of travel.
 *
 * Counts the contiguous run through `(tx, ty)` perpendicular to `(dx, dy)`, and stops the moment the run
 * exceeds {@link CONNECTOR_WIDTH} — the only question asked of it is "gate or merge", and a merged
 * outdoor edge answers that after four tiles.
 */
function gateWidth(grid: TileGrid, tx: number, ty: number, dx: number, dy: number): number {
  const px = -dy;
  const py = dx;
  let run = 1;
  for (const sign of [1, -1]) {
    for (let n = 1; n <= ROOM_TILES; n++) {
      const cx = tx + px * sign * n;
      const cy = ty + py * sign * n;
      if (roomAtTile(grid, cx, cy) !== -1) break;
      if (!isWalkable(tileAt(grid, cx, cy))) break;
      run++;
      if (run > CONNECTOR_WIDTH) return run;
    }
  }
  return run;
}

/**
 * The bodies in `others` that would actually obstruct `self`, with the mover itself and every body on
 * threshold ground dropped.
 *
 * Materialised once per step rather than filtered at each of the three tests below it: the tile
 * lookups behind {@link bodySolidAt} are the expensive part and the answer cannot change mid-step.
 */
function obstructing(grid: TileGrid, self: BodyPoint, others: Iterable<BodyPoint>): BodyPoint[] {
  const out: BodyPoint[] = [];
  for (const other of others) {
    if (other.id === self.id) continue;
    if (!bodySolidAt(grid, other.x, other.y)) continue;
    out.push(other);
  }
  return out;
}

/**
 * Whether moving from `(fromX, fromY)` to `(toX, toY)` is allowed by the bodies in `solid`.
 *
 * **A step is refused only when it makes things worse.** Three cases, and the third is escape valve 1:
 *
 * - Landing clear of everybody is always fine.
 * - Starting clear and landing inside somebody is the refusal this module exists for.
 * - **Starting inside somebody is not a trap.** A body can end up overlapping another anyway — a
 *   crowded den's placement fallback shares a tile rather than losing a mob, a teleport lands on an
 *   occupant — and a rule that refused every step out of an overlap would weld the pair together for
 *   good. So an overlapping mover may take any step that does not push *further in*.
 *
 * That last test is on the step's direction rather than on the distance it ends at, and the difference
 * is not pedantry: one tick is 15px and the separation is 20, so "ended up further away" would happily
 * license walking clean through somebody and out the other side. Judging the direction cannot, and it
 * still guarantees a way out, because the half-plane pointing away from the blocker is never empty.
 */
function bodiesAllow(
  solid: readonly BodyPoint[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  for (const other of solid) {
    const toSq = (toX - other.x) ** 2 + (toY - other.y) ** 2;
    if (toSq >= SEPARATION_SQ) continue;
    const awayX = fromX - other.x;
    const awayY = fromY - other.y;
    if (awayX * awayX + awayY * awayY >= SEPARATION_SQ) return false;
    if ((toX - fromX) * awayX + (toY - fromY) * awayY >= 0) continue;
    return false;
  }
  return true;
}

/** {@link stepMovement}'s axis-separated slide, with each axis also asked of the bodies. */
function slide(
  grid: TileGrid,
  self: BodyPoint,
  intentX: number,
  intentY: number,
  distance: number,
  solid: readonly BodyPoint[],
): { x: number; y: number } {
  let nx = self.x;
  let ny = self.y;

  const tryX = nx + intentX * distance;
  if (canStand(grid, tryX, ny) && bodiesAllow(solid, nx, ny, tryX, ny)) nx = tryX;

  const tryY = ny + intentY * distance;
  if (canStand(grid, nx, tryY) && bodiesAllow(solid, nx, ny, nx, tryY)) ny = tryY;

  return { x: nx, y: ny };
}

/**
 * **The one routine that moves a body past both walls and other bodies.**
 *
 * Every continuous mover in the simulation goes through here — the player walk, the hunt's two steps
 * and a fighter closing to station — so that a fifth one cannot be written that forgets. With no
 * obstructing bodies it is `stepMovement` exactly, byte for byte, which is what keeps the client's
 * predictor reconcilable: prediction that ignores bodies is wrong only where a body is, and there the
 * server's answer wins as it does for every other refusal.
 *
 * Three attempts, in order, and the order is the whole design:
 *
 * 1. The ordinary axis-separated slide, with bodies consulted per axis. This alone handles every
 *    glancing contact, which is nearly all of them.
 * 2. If that made **no real headway**, ask whether the **terrain** would have refused it anyway. A
 *    mover pressed into a corner is a wall problem, walls already slide, and deflecting off a body that
 *    happens to be nearby would send them somewhere they never asked to go.
 * 3. Otherwise a body is in the way and the floor is not, so **go round it**: project the intent onto
 *    the tangent of the nearest disc ahead and slide along that. This is escape valve 2, and it is what
 *    keeps click-to-move honest — a route planned over the tilemap cannot see a mob standing on it, and
 *    without the deflection the walker would grind to a halt and `STUCK_TICKS` would end the route as
 *    `'stuck'` two tenths of a second later.
 *
 * "No real headway" rather than "did not move at all", and the distinction is the difference between a
 * detour and a shuffle. Sliding on a disc very often leaves one axis a pixel of room, and a mover that
 * accepted that pixel would never reach step 3: it would creep sideways along the same blocker for
 * ever, moving every tick and arriving nowhere. Measured along the intent and against the same
 * {@link PROGRESS_FRACTION} the route's own stall counter uses, so the two agree about what counts.
 *
 * ## What this deliberately does not do
 *
 * **It goes round one body, not round a wall of them.** Three bodies abreast is a local minimum for
 * any stateless rule — every tangent points back into the pocket between the next pair — and escaping
 * one needs a plan rather than a reflex. That is not a gap, it is the same division of labour terrain
 * already has: `stepMovement` slides along a wall and `pathfind.ts` decides which way round it. The
 * consequence to keep in mind is that a body-wall is a *planner* problem, and the exemption in
 * {@link bodySolidAt} is what guarantees one can never form where it would matter.
 */
export function stepBody(
  grid: TileGrid,
  self: BodyPoint,
  intentX: number,
  intentY: number,
  distance: number,
  others: Iterable<BodyPoint>,
): { x: number; y: number } {
  const solid = obstructing(grid, self, others);
  if (solid.length === 0) return stepMovement(grid, self.x, self.y, intentX, intentY, distance);

  const direct = slide(grid, self, intentX, intentY, distance, solid);
  const gained = (direct.x - self.x) * intentX + (direct.y - self.y) * intentY;
  if (gained >= distance * PROGRESS_FRACTION) return direct;

  // Barely moving. If the floor alone would have refused this step there is nothing to route around.
  const terrain = stepMovement(grid, self.x, self.y, intentX, intentY, distance);
  if (terrain.x === self.x && terrain.y === self.y) return direct;

  const around = tangent(self, intentX, intentY, solid);
  if (!around) return direct;
  const detour = slide(grid, self, around.x, around.y, distance, solid);
  // The detour is sideways by construction, so it can never win on the intent's own axis. Taking it
  // whenever it moves at all is the point: a step that goes nowhere useful is worth trading for one
  // that at least changes which side of the obstacle you are on.
  if (detour.x === self.x && detour.y === self.y) return direct;
  return detour;
}

/**
 * A unit heading that goes **around** the nearest body ahead instead of into it.
 *
 * The blocker is chosen by distance among those the mover is actually facing (`dot > 0`), because the
 * one behind you is not why you stopped. From there it is the wall slide's own arithmetic on a curved
 * surface: strip out the component of the intent that points at the blocker's centre and keep what is
 * left, which is the tangent.
 *
 * Dead-on, that leaves nothing — the tangent of a disc you are aimed at the centre of is a coin toss,
 * and `CLAUDE.md` rule 3 does not allow tossing one. **Pass on the right**, then: `(-iy, ix)` is a
 * quarter turn clockwise on a y-down screen, which is the mover's right hand, which is the road rule
 * and is stable across restarts.
 */
function tangent(
  self: BodyPoint,
  intentX: number,
  intentY: number,
  solid: readonly BodyPoint[],
): { x: number; y: number } | undefined {
  let nearest: BodyPoint | undefined;
  let nearestSq = Infinity;
  for (const other of solid) {
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx * intentX + dy * intentY <= 0) continue;
    const sq = dx * dx + dy * dy;
    if (sq >= nearestSq) continue;
    nearestSq = sq;
    nearest = other;
  }
  if (!nearest) return undefined;

  const away = normaliseIntent(self.x - nearest.x, self.y - nearest.y);
  if (away.x === 0 && away.y === 0) return { x: -intentY, y: intentX };

  const into = intentX * away.x + intentY * away.y;
  const off = normaliseIntent(intentX - away.x * into, intentY - away.y * into);
  if (off.x === 0 && off.y === 0) return { x: -intentY, y: intentX };
  return off;
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

/** Where a body was actually put, and what had to be given up to put it there. */
export interface Landing {
  readonly tx: number;
  readonly ty: number;
  /**
   * True when no free tile existed and the body had to share one. **A missing mob is worse than an
   * overlap**, so this is reported rather than refused — see {@link placeBody}.
   */
  readonly stacked: boolean;
  /** True when the room offered no walkable tile at all — a room floored over by its own props. */
  readonly blocked: boolean;
}

/**
 * **Where a body goes when it is put on the floor** — every spawn, every zone reset, every arrival.
 *
 * The owner reported both failures this fixes, on the same day. *"Never have mobs or players load on
 * top of each other"* is the one `relocate` already half-answered for arrivals (`arrivalTile` spreads
 * laterally by actor id) and that `spawnMob` did not answer at all: it rolled a tile uniformly across
 * the room and used it. And then the screenshot — a kobold youth in room 41260 standing **inside** a
 * scenery block, head and shoulders out of the top of it — which is the same roll landing on a
 * {@link Tile.Prop} cell that `isWalkable` has always called solid. One roll, two bugs, one gate.
 *
 * `prefer` is the tile the caller wanted: the rolled offset, `arrivalTile`'s lateral answer, the room
 * centre. It is honoured whenever it is legal, so the RNG stream, the id spread and the arrival fiction
 * all survive untouched and only a *bad* answer moves. Otherwise the room's own tiles are searched in a
 * fixed order — nearest first by Chebyshev distance, row-major to break ties — and the first legal one
 * wins. No dice: the same world rebuilds the same way.
 *
 * ## When nothing is legal
 *
 * Two degradations, ranked, and the ranking is the interesting part:
 *
 * - **Walkable but occupied beats unoccupied but blocked.** Zone 168's Cubs Den holds more bodies than
 *   a nine-tile room has comfortable places for, and when the free tiles run out the answer is two
 *   kobolds standing close together — not a kobold inside a rock. Bodies push apart again the moment
 *   either one moves (see the escape valve in {@link stepBody}); a body inside geometry never does, and
 *   it is the artefact the owner actually photographed.
 * - **Blocked at all is the last resort**, and means the room has no floor left. It is reported, not
 *   hidden, so a zone that manages it shows up as a number instead of as a body in a wall.
 */
export function placeBody(
  grid: TileGrid,
  roomId: RoomId,
  origin: { readonly tx: number; readonly ty: number },
  prefer: { readonly tx: number; readonly ty: number },
  occupied: Iterable<BodyPoint>,
): Landing {
  // Copied once: the scan below reads it up to ROOM_TILES² times and the caller may hand a generator.
  const bodies = [...occupied];

  if (standable(grid, roomId, prefer.tx, prefer.ty) && vacant(bodies, prefer.tx, prefer.ty)) {
    return { tx: prefer.tx, ty: prefer.ty, stacked: false, blocked: false };
  }

  let best: { tx: number; ty: number } | undefined;
  let bestRange = Infinity;
  let fallback: { tx: number; ty: number } | undefined;
  let fallbackRange = Infinity;

  for (let dy = 0; dy < ROOM_TILES; dy++) {
    for (let dx = 0; dx < ROOM_TILES; dx++) {
      const tx = origin.tx + dx;
      const ty = origin.ty + dy;
      if (!standable(grid, roomId, tx, ty)) continue;
      // Chebyshev, so the search grows as a square ring and a body displaced off a prop lands beside
      // it rather than across the room. Strictly-less keeps the row-major tie-break.
      const range = Math.max(Math.abs(tx - prefer.tx), Math.abs(ty - prefer.ty));
      if (range < fallbackRange) {
        fallbackRange = range;
        fallback = { tx, ty };
      }
      if (!vacant(bodies, tx, ty)) continue;
      if (range < bestRange) {
        bestRange = range;
        best = { tx, ty };
      }
    }
  }

  if (best) return { tx: best.tx, ty: best.ty, stacked: false, blocked: false };
  if (fallback) return { tx: fallback.tx, ty: fallback.ty, stacked: true, blocked: false };
  return { tx: prefer.tx, ty: prefer.ty, stacked: false, blocked: true };
}

/**
 * Whether a body could stand on this tile at all: inside the named room, and clear of walls and props.
 *
 * `canStand` rather than `isWalkableAt` because it is the test movement itself uses — and at a tile
 * centre the two agree exactly, since `PLAYER_RADIUS` is 10 and a tile is 32, so the whole box lies
 * inside the one cell. Using the mover's own authority means a tile placement accepts is a tile
 * movement will not immediately eject a body from.
 */
function standable(grid: TileGrid, roomId: RoomId, tx: number, ty: number): boolean {
  if (roomAtTile(grid, tx, ty) !== roomId) return false;
  return canStand(grid, tileCentre(tx), tileCentre(ty));
}

/** Whether this tile's centre is clear of every body by at least {@link BODY_SEPARATION}. */
function vacant(bodies: readonly BodyPoint[], tx: number, ty: number): boolean {
  const x = tileCentre(tx);
  const y = tileCentre(ty);
  for (const body of bodies) {
    if ((x - body.x) ** 2 + (y - body.y) ** 2 < SEPARATION_SQ) return false;
  }
  return true;
}
