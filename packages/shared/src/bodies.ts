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
 *    heading straight at one has no off-axis component to slide on. {@link stepBody} steps sideways
 *    instead, toward whichever end of the obstruction is nearer — and *the obstruction*, not the
 *    nearest body, because a row of them read one at a time is a loop rather than a detour. See
 *    {@link tangent} for the kobolds that proved it.
 *
 * Nothing here rolls anything. Placement search order is fixed and the sidestep's tie-break is a
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
 *
 * ## It is one number for every body, and since the scale slice that is a known lie
 *
 * `appearance.BODY_SCALE` draws the world's 86 `child` and 44 `teen` templates at 0.72 and 0.88 of
 * adult height, and `EntityView.scale` puts that on the wire — but **nothing here reads it**. A kobold
 * youth is drawn 1.30 m tall and collides as a 1.81 m man: it needs the same 20 px of clearance, it
 * seals the same three-tile gate, and two of them cannot stand as close together as they look like
 * they could.
 *
 * That is deliberate, and it is a slice rather than an oversight. Making the radius a property of the
 * body would move three separate proofs at once — the no-wedge argument in {@link bodySolidAt} (which
 * counts 32 px tile centres against a *constant* 20 px of clearance), {@link sidestep}'s gap
 * arithmetic, and `station.ts`'s 32 − 20 = 12 — and every one of them would become a statement about
 * the *pair* of bodies involved rather than about the world. Half of the work is already done: the
 * scale is now on the wire, so the day it is worth doing, both sides can read the same number.
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

/**
 * {@link stepMovement}'s axis-separated slide, with each axis also asked of the bodies.
 *
 * `major` reverses the order the two axes are attempted in, and it exists because **the order decides
 * the answer** whenever the first axis spends clearance the second one needed. A detour heading nearly
 * due south still carries a pixel or two of east in it; taking that east first walks the mover into the
 * very body it is trying to get round, and the southward metre it actually wanted is then refused for
 * want of the clearance the pixel cost. Measured: a mover 21px west of a column of bodies could pass
 * south of one and, having first been nudged 1.5px east, could not.
 *
 * Off by default, so the {@link stepBody} step that stands in for terrain keeps `stepMovement`'s own
 * x-then-y convention exactly. On for the detours, which are ours to order.
 */
function slide(
  grid: TileGrid,
  self: BodyPoint,
  intentX: number,
  intentY: number,
  distance: number,
  solid: readonly BodyPoint[],
  major = false,
): { x: number; y: number } {
  let nx = self.x;
  let ny = self.y;

  const stepX = (): void => {
    const tryX = nx + intentX * distance;
    if (canStand(grid, tryX, ny) && bodiesAllow(solid, nx, ny, tryX, ny)) nx = tryX;
  };
  const stepY = (): void => {
    const tryY = ny + intentY * distance;
    if (canStand(grid, nx, tryY) && bodiesAllow(solid, nx, ny, nx, tryY)) ny = tryY;
  };

  if (major && Math.abs(intentY) > Math.abs(intentX)) {
    stepY();
    stepX();
  } else {
    stepX();
    stepY();
  }
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
 * 3. Otherwise a body is in the way and the floor is not, so **go round it**: take the shorter way out
 *    of the group of bodies ahead and slide along that. This is escape valve 2, and it is what keeps
 *    click-to-move honest — a route planned over the tilemap cannot see a mob standing on it, and
 *    without the deflection the walker would grind to a halt and `STUCK_TICKS` would end the route as
 *    `'stuck'` two tenths of a second later.
 *
 * "No real headway" rather than "did not move at all", and the distinction is the difference between a
 * detour and a shuffle. Sliding on a disc very often leaves one axis a pixel of room, and a mover that
 * accepted that pixel would never reach step 3: it would creep sideways along the same blocker for
 * ever, moving every tick and arriving nowhere. Measured along the intent and against the same
 * {@link PROGRESS_FRACTION} the route's own stall counter uses, so the two agree about what counts.
 *
 * ## The wall, which this used to hand to the planner and now does not
 *
 * This once went round **one** body and said so: three abreast was *"a local minimum for any stateless
 * rule"*, to be solved by steering. The owner's kobolds refuted the premise rather than the conclusion.
 * A stateless rule that re-reads the nearest disc every tick does oscillate; one that asks *which way is
 * shorter out of the whole group* does not, because that answer only improves as you act on it. See
 * {@link tangent}. So a wall of bodies is now walked round here, and `pathfind.ts` keeps the job it
 * always had — walls of **stone**, which do not move and which no local rule can see the end of.
 *
 * The exemption in {@link bodySolidAt} is still what guarantees a wall can never form where it would
 * *seal* anything; this is what stops one being a wall at all.
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

  // The detour is sideways by construction, so it can never win on the intent's own axis — it is judged
  // on **its own**, against the same {@link PROGRESS_FRACTION}. "Moved at all" was the first rule here
  // and it was too weak by exactly the margin that matters: a detour whose only accepted axis is the
  // pixel of *forward* left in it creeps into the obstacle it is rounding, a step at a time, and reads
  // as a body working away at something it will never get past. If neither way round earns its step the
  // mover is genuinely wedged, and saying so plainly is what lets the caller's stall clock free it.
  for (const way of detours(self, intentX, intentY, solid)) {
    const detour = slide(grid, self, way.x, way.y, distance, solid, true);
    const sideways = (detour.x - self.x) * way.x + (detour.y - self.y) * way.y;
    if (sideways >= distance * PROGRESS_FRACTION) return detour;
  }
  return direct;
}

/**
 * The ways round, best first: **sideways, sideways-and-back, then back.**
 *
 * More than one candidate because a mover that reached the obstacle *at an angle* can wedge itself
 * somewhere pure sideways cannot leave. Two bodies on adjacent tiles are 32px apart and each wants
 * {@link BODY_SEPARATION}, so the pocket between them admits a mover to 12px of the line joining their
 * centres and then holds it: the way out needs 20px of clearance it no longer has, and every forward and
 * sideways step is refused. A goal *behind the middle of a wall* aims a walker straight into one of
 * these, which is exactly what a mob strolling at a doorway does — the far side of the wall is where it
 * wants to be, so it cuts in as soon as it has any room, and cuts in too early.
 *
 * The way out of a pocket is the way in, so the later candidates bend **away from the nearest body**:
 * first blended with the tangent, which backs out *and* round in one step and is what anyone would
 * actually do; then straight away from it, for the pocket so tight that even the blend's sideways half
 * is refused. Each is tried only when the one before it earned nothing, so an ordinary detour round an
 * ordinary body never sees them.
 *
 * A retreat cannot become a habit: {@link bodiesAllow} always permits a step that opens a gap, so the
 * back-out is *reliable* rather than merely likely, and it is the caller's stall clock — which counts
 * ground gained on the destination, not pixels travelled — that notices a mover buying room it never
 * converts into progress.
 */
function detours(
  self: BodyPoint,
  intentX: number,
  intentY: number,
  solid: readonly BodyPoint[],
): { x: number; y: number }[] {
  const around = tangent(self, intentX, intentY, solid);
  if (!around) return [];

  let nearest: BodyPoint | undefined;
  let nearestSq = Infinity;
  for (const other of solid) {
    const sq = (other.x - self.x) ** 2 + (other.y - self.y) ** 2;
    if (sq >= nearestSq) continue;
    nearestSq = sq;
    nearest = other;
  }
  if (!nearest) return [around];
  const away = normaliseIntent(self.x - nearest.x, self.y - nearest.y);
  if (away.x === 0 && away.y === 0) return [around];
  const bent = normaliseIntent(around.x + away.x, around.y + away.y);
  if (bent.x === 0 && bent.y === 0) return [around, away];
  return [around, bent, away];
}

/**
 * A unit heading that goes **around the blocking group** instead of into it.
 *
 * ## Why this is not the tangent of the nearest disc
 *
 * It was, until the owner's kobolds proved what that costs (2026-08-13: *five kobold youths lined up
 * along a room edge, "haven't moved since"*). Projecting the intent onto the nearest blocker's tangent
 * is correct for one body and **oscillates against a row of them**: sliding clear of A makes B the
 * nearest, whose tangent points back at A. The measured period was two ticks and the amplitude 3.53px,
 * forever — and because that is *motion*, every stall counter downstream read it as a mover making its
 * way and never gave up. A body welded to a spot while technically moving is the worst of both.
 *
 * So the question asked here is the one a planner would ask, not the one a reflex would: **which way is
 * shorter out of this wall?** Answered over every body the mover is facing rather than over the nearest
 * one alone, and answered in the only currency that matters — how far sideways the mover must displace
 * before there is a gap it fits through. See {@link sidestep}.
 *
 * *Every* body ahead, with no bound on how far ahead, because the only honest definition of "this wall"
 * is the one the sweep itself applies: bodies belong to the same wall when there is no gap between them
 * a mover could fit through. An earlier attempt fenced the group by depth instead — bodies within a
 * separation of the nearest — and it read a wall approached at an angle as two bodies rather than five,
 * because the far end of a wall you are beside is a long way *ahead* of you. It then sent the mover back
 * along the wall it had nearly cleared. Anything past a real gap is somebody else's problem and the
 * sweep stops there of its own accord.
 *
 * That makes the choice **monotone**, which is the property the tangent lacked: every step toward the
 * near end shortens that side and lengthens the other, so the mover commits and walks out instead of
 * flip-flopping in the pocket. Still stateless, still deterministic, still no dice — `CLAUDE.md` rule 3
 * is satisfied by the tie-break rather than by a stored side.
 *
 * **Pass on the right** on a tie: `(-iy, ix)` is a quarter turn clockwise on a y-down screen, which is
 * the mover's right hand and the road rule. A single body dead ahead is exactly a tie — it reaches the
 * same distance either way — so the one-body behaviour this replaced is preserved by construction.
 */
function tangent(
  self: BodyPoint,
  intentX: number,
  intentY: number,
  solid: readonly BodyPoint[],
): { x: number; y: number } | undefined {
  // The mover's right hand, and the sideways offset of every body it is facing. The one behind you is
  // not why you stopped, and that is the only body dropped here.
  const px = -intentY;
  const py = intentX;
  const sides: number[] = [];
  for (const other of solid) {
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx * intentX + dy * intentY <= 0) continue;
    sides.push(dx * px + dy * py);
  }
  if (sides.length === 0) return undefined;

  return sidestep(sides, 1) <= sidestep(sides, -1) ? { x: px, y: py } : { x: -px, y: -py };
}

/**
 * How far the mover must displace along `hand` before it clears every body in the group — the length of
 * the detour, in pixels.
 *
 * A sweep outward from the mover's own line. Bodies fully behind it on this side cannot obstruct and
 * are skipped; each remaining one either leaves a gap wide enough to slip through (and the sweep stops,
 * because the mover is out) or pushes the answer past its own far shoulder. Reaching the end of the
 * group is the same answer as finding a gap: there is nothing further out to be blocked by.
 *
 * A gap counts when consecutive centres are {@link BODY_SEPARATION} apart *from the displaced mover*,
 * which is what makes two bodies on adjacent tiles impassable — 32px of centre spacing against 20px of
 * clearance each side — and keeps this arithmetic honest with {@link bodiesAllow}.
 */
function sidestep(sides: readonly number[], hand: 1 | -1): number {
  const ordered = sides.map((side) => side * hand).sort((a, b) => a - b);
  let out = 0;
  for (const at of ordered) {
    if (at + BODY_SEPARATION <= out) continue;
    if (at - out >= BODY_SEPARATION) break;
    out = at + BODY_SEPARATION;
  }
  return out;
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
