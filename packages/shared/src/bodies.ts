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
 * ## And *how much* floor a body takes is a property of the body
 *
 * Since 2026-08-14 the second half of that sentence is real: a body's radius is {@link BODY_RADIUS}
 * times its own size, so a hill giant keeps 2.75x the room a person does and a kobold youth keeps
 * 0.30x. Every test here is therefore about the **pair** — {@link bodyClearance}, `rA + rB` — and each
 * of the three arguments that used to rest on one constant says so in its own docblock:
 * {@link bodySolidAt}'s no-wedge exemption, {@link sidestep}'s sweep, and, in the server,
 * `station.ts`'s melee reach.
 *
 * ## And since 2026-08-16 the **walls** know it too
 *
 * That slice stopped at the doorframe and said so: `canStand` tested a fixed 10px half-extent whatever
 * was walking, so a hill giant fitted through a human's doorway and could stand 17.5px inside a wall.
 * The terrain box is the body's own now — `tilemap.canStand` takes a radius, `stepBody` hands it
 * {@link bodyRadius}, and {@link placeBody} puts a body only where that box fits.
 *
 * A terrain box is `1x1` cells while its radius is under half a tile and `3x3` above it, so the ladder
 * splits in one place rather than everywhere: **222 of the world's 2,016 spawned bodies (11.0%) — every
 * ogre and every giant — have a footprint bigger than a person's**, and the 189 trolls clear a single
 * cell by 1.03px. What that costs, measured through the real `spawnMob` over every built zone on
 * 2026-08-16:
 *
 * - **93 of those 222 used to be stood with part of themselves inside a wall. None are now.** That is
 *   the bug, and it is the number the slice is for.
 * - **No room in the world (0 of 7,179) refuses a giant every tile**, no spawn is squeezed onto a
 *   person's ground, and **no giant is confined to its own room**. A nine-tile room's 7x7 interior is a
 *   3x3 body's, and every gate is three tiles wide, which is exactly what a 3x3 body needs.
 * - **2 of 14,300 room-to-room links** are closed to a giant and open to an adult. (The sweep reports
 *   1,265 closed in all, but 1,263 of those are closed to an adult too — links the tilemap never
 *   carved, because the far room is not a geometric neighbour.)
 * - 41 of the 222 lose *some* ground, always to scenery rather than to geometry: props cut a 3x3
 *   body's floor into more than one piece in 182 rooms, where a person walks between them. Summed over
 *   all 222, a large body reaches 5,391 rooms where an adult reaches 5,941 — **90.7%** — and a room
 *   offers a giant 62.9% of the cells it offers a person.
 *
 * The three arguments that moved with it, again in their own docblocks: {@link standable} (a body goes
 * only where its own box fits, and degrades to a person's rather than reporting a room with no floor),
 * {@link bodySolidAt} (the no-wedge proof, which now has a geometric half as well as a body half), and
 * `tilemap.standingRadius` (the terrain twin of escape valve 1 below).
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
  ADULT_HEIGHT,
  MODEL_HEIGHT,
  SIZE_SCALE,
  type AppearanceSubject,
  appearanceOf,
  drawnHeightOf,
} from './appearance.ts';
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
  standingRadius,
  stepMovement,
  tileAt,
  tileCentre,
} from './tilemap.ts';
import type { RoomId } from './world.ts';

/**
 * Anything that occupies floor. Structural on purpose: `Actor` lives in the server and `shared` may not
 * import it, and the only fields collision needs are ones every body already has.
 */
export interface BodyPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  /**
   * How big this body is **as a multiple of an adult human** — absent means 1.
   *
   * The scale and not the radius, because a stored radius would be a second copy of a number the
   * simulation and the wire already carry, kept in step by hope. {@link bodyRadius} does the one
   * multiplication and {@link bodySizeOf} is where the number comes from.
   *
   * Optional, and not out of politeness: every rule in this module was written for a person, a body
   * nobody has sized *is* a person, and so every call site that predates the size ladder keeps exactly
   * the answer it always had. Measured over the shipped world on 2026-08-14, 1,090 of 2,016 spawned
   * bodies are adult-sized and would leave this absent.
   */
  readonly scale?: number;
}

/**
 * Half-extent of an **adult human** body for body-against-body tests, in pixels — the bottom rung of a
 * ladder since 2026-08-14, and no longer the whole of it.
 *
 * A tile is 32px and a room is nine tiles across `ROOM_METRES` — 9 m — so one pixel is 1/32 m and this
 * is **0.3125 m of half-width**: a 0.625 m disc under a 1.81 m body, which is a person's shoulders and
 * a little air. It is also **the same number the terrain box uses** (`PLAYER_RADIUS`), and since
 * 2026-08-16 that identity holds at every rung rather than only at scale 1: `stepBody` hands
 * {@link bodyRadius} straight to `canStand`, so the width a body is refused by a wall at and the width
 * it is refused by another body at are one number with one derivation.
 *
 * ## The lie this used to be, and the part of it that is left
 *
 * The docblock this replaces called one radius for every body *"a known lie"* and named the three
 * proofs a per-body radius would move. The measurement that finally forced it is the giants: the
 * shipped world stands **192 bodies at 2.75x** — 4.98 m tall, drawn — and under a single 10px radius
 * two of them kept 0.625 m between their centres while their silhouettes wanted 1.72 m. They stood
 * inside each other, and it was visible from the camera's usual 24 m.
 *
 * So a body's radius is `BODY_RADIUS × scale` ({@link bodyRadius}) and the pair test is `rA + rB`
 * ({@link bodyClearance}). The ladder the world actually stands on runs from **3.01px** (a kobold
 * youth, 0.54 m drawn) to **27.5px** (a hill giant): **926 of 2,016 spawned bodies — 45.9% — are not
 * adult-sized**, which is what makes this a rule about pairs rather than a rounding error.
 *
 * ## The terrain box, which used to be the named remainder and is not one now
 *
 * The 2026-08-14 docblock this replaces said `canStand` still tested a fixed 10px half-extent whatever
 * was walking, and gave three reasons that could not be unpicked separately. All three are answered,
 * and the reason they could be is that **the premise was wrong**: a 27.5px box does not fit inside a
 * 32px tile, but it was never asked to. It has to fit inside a *gate*, and a gate is
 * {@link CONNECTOR_WIDTH} tiles — 96px — which takes a 55px body with 41px of lateral play.
 *
 * - `placeBody`'s {@link standable} does not rest on the box lying in one cell; it rests on the box
 *   lying on **walkable ground**, which is one cell for a person and nine for a giant. See its own
 *   docblock for the rung it grew rather than the constant it lost.
 * - The no-wedge proof rests on a 96px gate admitting anybody, and it still does — that is now a
 *   *measured* claim about the shipped world rather than an assumed one. See {@link bodySolidAt}.
 * - The client predictor rests on `stepBody` being `stepMovement` byte for byte where no body is near,
 *   and it is: `canStand`'s radius **defaults to `PLAYER_RADIUS`**, its swept-tile form reads exactly
 *   the four tiles the old corner form read at that radius, and a player is scale 1.
 */
export const BODY_RADIUS = PLAYER_RADIUS;

/**
 * How far apart **two adult** body centres must stay. Two discs of {@link BODY_RADIUS}, touching.
 *
 * Kept as a constant now that it is one rung rather than the rule, because it is still the number the
 * world was tuned against and the one every other figure here is quoted against: `MELEE_STATION` is
 * `TILE_SIZE` and `32 − 20 = 12`, and a room's tile centres are 32px apart. {@link bodyClearance} is
 * the rule; this is that rule evaluated for the pair it was originally written for.
 */
export const BODY_SEPARATION = BODY_RADIUS * 2;

/**
 * How wide this body is, in pixels. The one multiplication, so nothing has to remember to do it.
 *
 * Takes anything carrying a `scale` rather than a whole {@link BodyPoint}, because a caller can have a
 * size and no position: the client's predictor sizes its terrain box off the `EntityView` it was sent.
 * Widening the parameter is what stops it writing `BODY_RADIUS * (scale ?? 1)` out a second time.
 *
 * The union names `BodyPoint` explicitly even though every `BodyPoint` already satisfies the second
 * arm, and that is not redundancy: TypeScript's excess-property check runs against a *fresh object
 * literal*, so without the first arm `bodyRadius({ id, x, y })` — how every test in this module speaks
 * — would be rejected for knowing too much.
 */
export function bodyRadius(body: BodyPoint | { readonly scale?: number }): number {
  return BODY_RADIUS * (body.scale ?? 1);
}

/**
 * **The pair rule** — how far apart these two centres must stay, and the replacement for the single
 * `SEPARATION_SQ` every test in this module used to compare against.
 *
 * Two discs touching, which is the same sentence {@link BODY_SEPARATION} always was; the only change
 * is that the two discs are now allowed to be different sizes. Written as one function rather than
 * inlined four times because the four places that ask it — {@link bodiesAllow}, {@link sidestep},
 * {@link vacant} and `station.ts`'s reach — are exactly the places that must never disagree.
 */
export function bodyClearance(a: BodyPoint, b: BodyPoint): number {
  return bodyRadius(a) + bodyRadius(b);
}

/**
 * The largest a body can ever be, as a multiple of an adult — **4 today**, and derived rather than
 * written down as four.
 *
 * Two sources, because {@link bodySizeOf} has two branches that can grow. A body drawn on the human
 * mesh is scaled by `SIZE_SCALE`, whose top rung is a gargantuan at 4; a body with a **mesh of its
 * own** skips that ladder entirely and is as big as the mesh was authored — the Troll model is 2.709 m
 * against an adult's 1.81, which is 1.497 and would silently exceed a cap taken from `SIZE_SCALE`
 * alone the day somebody authors a dragon. Reading both tables means the cap follows the art.
 *
 * Its one job is to bound `sim.BODY_QUERY_REACH`: a broad-phase box that does not cover the largest
 * pair in the world is a giant that another body walks through because the query never offered it.
 */
export const MAX_BODY_SIZE = Math.max(
  ...SIZE_SCALE,
  ...Object.values(MODEL_HEIGHT).map((height) => height / ADULT_HEIGHT),
);

/** The widest any body can be — 40px, a gargantuan. The far end of {@link bodyRadius}'s range. */
export const MAX_BODY_RADIUS = BODY_RADIUS * MAX_BODY_SIZE;

/**
 * **How big a body is for collision** — its drawn height as a multiple of an adult human's, and
 * deliberately *not* `Appearance.scale`.
 *
 * The distinction is the same one `MODEL_HEIGHT`'s docblock draws for corpses, and it is load-bearing
 * here for the same reason: **`scale` is relative to a body's own mesh, and the meshes are not the same
 * size.** A troll rides a 2.709 m mesh at `scale: undefined`; reading `scale` alone would give the
 * world's 96 troll templates a 1.81 m person's radius, which is precisely the bug this slice exists to
 * remove, one rung further down the ladder. A kobold rides a 0.756 m mesh at the same `scale: 1` and
 * would get the same wrong answer in the other direction.
 *
 * So the question asked is *how tall is this body actually drawn*, which `drawnHeightOf` already
 * answers, over `ADULT_HEIGHT`, which is already the denominator a corpse is sized against. No second
 * table, and no second classification pass: this is `appearanceOf`'s own verdict read in metres.
 *
 * ## Height standing in for width is a judgement, and here is its size
 *
 * It is exact for the case that matters — a giant is the human mesh scaled uniformly by 2.75, so it is
 * 2.75x as tall *and* 2.75x as broad. It is a judgement across different meshes: the female base body
 * is 43 mm shorter than the male and therefore gets a 2.4% smaller disc (9.76px against 10), which is
 * a consequence of the rule rather than a decision about women, and is small enough to leave. The
 * alternative was a second table of authored footprints that nobody has measured.
 *
 * Pure, total, and free of dice — the same contract every other function in `appearance.ts` keeps, so
 * two servers with one seed size the same body identically (`CLAUDE.md` rule 3).
 */
export function bodySizeOf(subject: AppearanceSubject): number {
  const look = appearanceOf(subject);
  // A ground object has no body and no appearance. Nothing in the simulation asks, since only actors
  // are ever solid, but a total function is cheaper than a caller that has to know that.
  if (!look) return 1;
  return drawnHeightOf(look.model, look.scale) / ADULT_HEIGHT;
}

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
 *    {@link CONNECTOR_WIDTH} — three tiles, 96px — and body centres sit on tile centres 32px apart.
 *
 *    This used to be one subtraction. Every body needed 20px of clearance, a mover threading between
 *    two of them on adjacent tiles needed 20 + 20 against 32, so it could not: three bodies across the
 *    mouth was a shut door and three *sentinels* was a shut door for ever. Since 2026-08-14 the
 *    subtraction is **a statement about the pair**, and the pair changes the answer both ways — a
 *    person threading between two kobolds needs (10 + 4.18) twice, 28.4 of the 32px, and **gets
 *    through**; two hill giants on adjacent mouth tiles need 55px and are already inside each other
 *    before anybody tries.
 *
 *    That the arithmetic no longer decides the rule is the strengthening rather than the weakening it
 *    reads as. The exemption has to hold for the **worst** pair the world can produce, the worst pair
 *    is now 2.75x worse than the one it was derived from, and a rule tuned to the arithmetic would
 *    have to be re-derived every time the size ladder moved. Exempting the *ground* removes the
 *    arrangement for every pair at once — which is exactly what lets `shared/bodies.test.ts`'s
 *    no-wedge proof stay exhaustive over **cells** and say nothing at all about how many bodies of
 *    what sizes stand on them.
 *
 * 3. **Everywhere else a body is solid**, which is most of a nine-tile room and all of the open
 *    ground that outdoor rooms merge into.
 *
 * ## The proof grew a second half on 2026-08-16, and it is geometric rather than combinatorial
 *
 * Everything above is about *bodies* corking a gate, and none of it moved. What moved is that the
 * **floor itself** now refuses a large body in places it used to accept one, so "no arrangement of
 * bodies can seal a room" stopped being the whole claim: geometry could seal one on its own. The
 * second half is proved the way the first is — by the cell rather than by the arrangement:
 *
 * - A gate is {@link CONNECTOR_WIDTH} tiles across and a body's footprint at a tile centre is `1x1`
 *   below 16px of radius and `3x3` from there to `MAX_TERRAIN_RADIUS`. Three fits three, so **the
 *   centre line of every gate in the world is standable by every body the art can make**, which is why
 *   `tilemap.MAX_TERRAIN_RADIUS` is clamped where it is rather than left at `MAX_BODY_RADIUS`.
 * - Inside a room, a `3x3` body keeps the 7x7 interior of a nine-tile room, which is a solid rectangle
 *   and therefore connected, and the interior touches the mouth tile of every gate.
 *
 * Both are claims about *empty* geometry, so scenery is the one thing that can break them — and it
 * does, in 182 of the world's 7,179 rooms, where props cut a large body's floor into pieces a person
 * walks between. Measured rather than argued; the module header carries the numbers, and the honest
 * summary is that a giant reaches 90.7% of the rooms an adult does and 0% of them seal it in.
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
 * is not pedantry: one tick is 15px and two adults need 20, so "ended up further away" would happily
 * license walking clean through somebody and out the other side. Judging the direction cannot, and it
 * still guarantees a way out, because the half-plane pointing away from the blocker is never empty.
 * **Per-body radii made that argument stronger at both ends**: two kobold youths need 6.02px against
 * the same 15px tick, so a distance test would let them swap places without ever being refused.
 *
 * The one number this reads is {@link bodyClearance}, per blocker, because the mover's own size is half
 * of every answer here.
 */
function bodiesAllow(
  self: BodyPoint,
  solid: readonly BodyPoint[],
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): boolean {
  for (const other of solid) {
    const clear = bodyClearance(self, other);
    const clearSq = clear * clear;
    const toSq = (toX - other.x) ** 2 + (toY - other.y) ** 2;
    if (toSq >= clearSq) continue;
    const awayX = fromX - other.x;
    const awayY = fromY - other.y;
    if (awayX * awayX + awayY * awayY >= clearSq) return false;
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
 *
 * `radius` is the terrain box, already resolved by {@link stepBody} through `standingRadius` — passed
 * in rather than recomputed here because all four calls in one step must be judged by one box, and a
 * `slide` that re-resolved it per call would measure the detour against a different body than the
 * direct step it is a detour from.
 */
function slide(
  grid: TileGrid,
  self: BodyPoint,
  intentX: number,
  intentY: number,
  distance: number,
  solid: readonly BodyPoint[],
  radius: number,
  major = false,
): { x: number; y: number } {
  let nx = self.x;
  let ny = self.y;

  const stepX = (): void => {
    const tryX = nx + intentX * distance;
    if (canStand(grid, tryX, ny, radius) && bodiesAllow(self, solid, nx, ny, tryX, ny)) nx = tryX;
  };
  const stepY = (): void => {
    const tryY = ny + intentY * distance;
    if (canStand(grid, nx, tryY, radius) && bodiesAllow(self, solid, nx, ny, nx, tryY)) ny = tryY;
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
  // Resolved once, from where the step starts, and then handed to every test in it — the walls, the
  // terrain probe and each detour. See `standingRadius` for why a body may be moved as a person.
  const radius = standingRadius(grid, self.x, self.y, bodyRadius(self));
  const solid = obstructing(grid, self, others);
  if (solid.length === 0) return stepMovement(grid, self.x, self.y, intentX, intentY, distance, radius);

  const direct = slide(grid, self, intentX, intentY, distance, solid, radius);
  const gained = (direct.x - self.x) * intentX + (direct.y - self.y) * intentY;
  if (gained >= distance * PROGRESS_FRACTION) return direct;

  // Barely moving. If the floor alone would have refused this step there is nothing to route around.
  const terrain = stepMovement(grid, self.x, self.y, intentX, intentY, distance, radius);
  if (terrain.x === self.x && terrain.y === self.y) return direct;

  // The detour is sideways by construction, so it can never win on the intent's own axis — it is judged
  // on **its own**, against the same {@link PROGRESS_FRACTION}. "Moved at all" was the first rule here
  // and it was too weak by exactly the margin that matters: a detour whose only accepted axis is the
  // pixel of *forward* left in it creeps into the obstacle it is rounding, a step at a time, and reads
  // as a body working away at something it will never get past. If neither way round earns its step the
  // mover is genuinely wedged, and saying so plainly is what lets the caller's stall clock free it.
  for (const way of detours(self, intentX, intentY, solid)) {
    const detour = slide(grid, self, way.x, way.y, distance, solid, radius, true);
    const sideways = (detour.x - self.x) * way.x + (detour.y - self.y) * way.y;
    if (sideways >= distance * PROGRESS_FRACTION) return detour;
  }
  return direct;
}

/**
 * The ways round, best first: **sideways, sideways-and-back, then back.**
 *
 * More than one candidate because a mover that reached the obstacle *at an angle* can wedge itself
 * somewhere pure sideways cannot leave. Two bodies on adjacent tiles are 32px apart, so a mover aiming
 * at the midpoint gets to `sqrt(clearance² − 16²)` of the line joining their centres and is then held:
 * the way out needs a clearance it no longer has, and every forward and sideways step is refused. **How
 * deep the pocket is now depends on all three bodies**, and the spread is the whole reason this is no
 * longer one number — a person between two people reaches 12px in (the figure this note was written
 * with), a person between two hill giants is stopped 33.9px out, and a person between two kobold youths
 * meets no pocket at all, because 13.01px of clearance does not reach the 16px midline.
 *
 * A goal *behind the middle of a wall* aims a walker straight into one of these, which is exactly what
 * a mob strolling at a doorway does — the far side of the wall is where it wants to be, so it cuts in as
 * soon as it has any room, and cuts in too early.
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
  //
  // **A centre test, and at the top of the size ladder that is an approximation** — a gargantuan whose
  // centre is a pixel behind you still has 40px of itself beside you. It is left as a centre test
  // because this function only picks a *hand*: `slide` does the real per-pair test on the step that
  // follows, and `stepBody` judges the detour on the ground it gains, so a hand chosen against a body
  // this drops costs one refused step and the next candidate in {@link detours}, not a wedge.
  const px = -intentY;
  const py = intentX;
  const sides: Shoulder[] = [];
  for (const other of solid) {
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    if (dx * intentX + dy * intentY <= 0) continue;
    sides.push({ at: dx * px + dy * py, clear: bodyClearance(self, other) });
  }
  if (sides.length === 0) return undefined;

  return sidestep(sides, 1) <= sidestep(sides, -1) ? { x: px, y: py } : { x: -px, y: -py };
}

/** One blocking body, as {@link sidestep} sees it: how far to the side, and how wide a berth it wants. */
interface Shoulder {
  /** Its centre's offset along the mover's right hand, in pixels. Negative is to the left. */
  readonly at: number;
  /** {@link bodyClearance} for this body and the mover — half the answer belongs to each of them. */
  readonly clear: number;
}

/**
 * How far the mover must displace along `hand` before it clears every body in the group — the length of
 * the detour, in pixels.
 *
 * Each body forbids the mover an **interval** of displacements: it may not stand within `clear` of that
 * body's own offset, so `(at − clear, at + clear)` is out. The answer is the smallest displacement from
 * zero that no interval covers, and the sweep below computes it exactly rather than approximately.
 *
 * ## The proof this used to be, and the one line of it that had to change
 *
 * It used to sweep the *centres* in order, because with one clearance for every body sorting by centre
 * and sorting by near shoulder are the same order — so "the first body that leaves a gap" was also the
 * last body that could block, and stopping there was sound. **With per-pair clearances they are two
 * different orders**, and the failure is concrete: a kobold 50px out leaves a person a gap at
 * displacement 0, while a gargantuan 60px out — further along the hand, and therefore later in the old
 * ordering — reaches 50px back and covers it. The old sweep would have stopped at the kobold and
 * reported a detour of nothing.
 *
 * So the sweep is ordered by **near shoulder** (`at − clear`) and stops at the first interval that
 * starts at or beyond where the mover already stands, which is sound again for the reason the old one
 * was: every remaining interval starts no earlier, so none of them can cover that point. For a group of
 * equal-sized bodies it is the same walk over the same numbers and returns the same answer, which is
 * what keeps the wall cases in `shared/bodies.test.ts` measuring what they measured.
 *
 * Bodies fully behind the mover on this side are skipped by the same `hi <= out` test as before, and
 * reaching the end of the group is the same answer as finding a gap: nothing further out to be blocked
 * by. The clearance is {@link bodyClearance}, so this arithmetic and {@link bodiesAllow} cannot drift.
 */
function sidestep(sides: readonly Shoulder[], hand: 1 | -1): number {
  const spans = sides
    .map(({ at, clear }) => ({ lo: at * hand - clear, hi: at * hand + clear }))
    .sort((a, b) => a.lo - b.lo);
  let out = 0;
  for (const span of spans) {
    if (span.lo >= out) break;
    if (span.hi > out) out = span.hi;
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
  /**
   * True when no tile in the room would take this body's **own** terrain box and it was stood on
   * ground sized for a person instead — a giant with its shoulder through a wall rather than a giant
   * reported as homeless.
   *
   * Its own flag and not folded into {@link blocked}, because the two mean different things to whoever
   * reads the tally: `blocked` says *this room has no floor*, which is a build error in the scenery,
   * and this says *this room's floor is too narrow for what the reset put in it*, which is a content
   * mismatch between a zone and its population. **Zero across the shipped world** (measured 2026-08-16
   * over 2,016 spawns in 7,179 rooms), which is exactly why it is worth counting: the day a scatter
   * table grows, this is the number that moves first.
   */
  readonly squeezed: boolean;
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
 *
 * ## `scale` is what makes "two giants must not load on top of each other" true
 *
 * A tile is 32px and two adults want 20, so before 2026-08-14 *any* free tile satisfied the mover and
 * the occupancy scan only ever had to reject the tile somebody was standing on. **Two hill giants want
 * 55px**, which no pair of adjacent tiles offers and no diagonal pair offers either (45.25px): the
 * nearest tile that will take a second giant is two cells away, 64px. The Chebyshev ring search finds
 * it without knowing that — it asks {@link vacant}, which asks {@link bodyClearance} — and the world
 * has 30 rooms holding two giant-sized bodies, nine holding three and one holding six, so this is a
 * case the shipped reset tables actually reach rather than a hypothetical.
 *
 * ## And since 2026-08-16 the **floor** is asked the same question
 *
 * {@link standable} takes the body's radius too, so the search is over tiles this body's own box fits
 * on rather than over tiles a person's does. In a nine-tile room that is the 7x7 interior for anything
 * from an ogre upward — a troll is still 1x1, by 1.03px — which is 49 candidate cells against a world
 * whose most crowded room holds 14 bodies of every size together. **No room in the world (0 of 7,179,
 * measured 2026-08-16) hands back none.**
 *
 * The ladder of degradations therefore grew a rung, between "shared a tile" and "there is no floor":
 *
 * 1. The preferred tile, if this body fits on it and nobody is in the way.
 * 2. The nearest tile that fits it and is free.
 * 3. The nearest tile that fits it, sharing (`stacked`).
 * 4. **The nearest tile a *person* would fit on** (`squeezed`), still keeping the full pair clearance
 *    from every body already there — the squeeze is a concession to the *walls*, never to the bodies,
 *    because two bodies inside each other is the artefact the owner photographed and a shoulder
 *    through a doorframe is not.
 * 5. Nothing walkable at all (`blocked`).
 *
 * Rung 4 never fires on the world as shipped. It exists because without it a room whose scenery grew
 * would report a giant as `blocked` — *"this room has no floor"* — and stand it at the rolled tile,
 * inside a wall, which is a worse answer than the one this whole module was written to stop.
 */
export function placeBody(
  grid: TileGrid,
  roomId: RoomId,
  origin: { readonly tx: number; readonly ty: number },
  prefer: { readonly tx: number; readonly ty: number },
  occupied: Iterable<BodyPoint>,
  scale = 1,
): Landing {
  // Copied once: the scan below reads it up to ROOM_TILES² times and the caller may hand a generator.
  const bodies = [...occupied];
  const mine = BODY_RADIUS * scale;

  const fits = search(grid, roomId, origin, prefer, bodies, mine, mine);
  if (fits) return { ...fits, blocked: false, squeezed: false };

  // Rung 4. Only a body wider than a person can be short of floor a person would have had, so this is
  // skipped entirely for 1,605 of the world's 2,016 spawns — every adult and everything below one.
  if (mine > PLAYER_RADIUS) {
    const squeezed = search(grid, roomId, origin, prefer, bodies, mine, PLAYER_RADIUS);
    if (squeezed) return { ...squeezed, blocked: false, squeezed: true };
  }
  return { tx: prefer.tx, ty: prefer.ty, stacked: false, blocked: true, squeezed: false };
}

/**
 * One pass of the nearest-first search, for a body of clearance `mine` standing on a `terrain` box.
 *
 * Two radii and not one, because {@link placeBody}'s squeeze rung relaxes exactly one of them. `mine`
 * is what other bodies are kept at and never moves; `terrain` is what the walls are asked about and is
 * dropped to a person's on the second pass. Passing one number for both would make a crowded room
 * quietly permit two giants inside each other, which is the bug rung 4 must not buy its way out with.
 *
 * `undefined` means the room offered nothing at this terrain box — walkable or otherwise.
 */
function search(
  grid: TileGrid,
  roomId: RoomId,
  origin: { readonly tx: number; readonly ty: number },
  prefer: { readonly tx: number; readonly ty: number },
  bodies: readonly BodyPoint[],
  mine: number,
  terrain: number,
): { tx: number; ty: number; stacked: boolean } | undefined {
  if (
    standable(grid, roomId, prefer.tx, prefer.ty, terrain) &&
    vacant(bodies, mine, prefer.tx, prefer.ty)
  ) {
    return { tx: prefer.tx, ty: prefer.ty, stacked: false };
  }

  let best: { tx: number; ty: number } | undefined;
  let bestRange = Infinity;
  let fallback: { tx: number; ty: number } | undefined;
  let fallbackRange = Infinity;

  for (let dy = 0; dy < ROOM_TILES; dy++) {
    for (let dx = 0; dx < ROOM_TILES; dx++) {
      const tx = origin.tx + dx;
      const ty = origin.ty + dy;
      if (!standable(grid, roomId, tx, ty, terrain)) continue;
      // Chebyshev, so the search grows as a square ring and a body displaced off a prop lands beside
      // it rather than across the room. Strictly-less keeps the row-major tie-break.
      const range = Math.max(Math.abs(tx - prefer.tx), Math.abs(ty - prefer.ty));
      if (range < fallbackRange) {
        fallbackRange = range;
        fallback = { tx, ty };
      }
      if (!vacant(bodies, mine, tx, ty)) continue;
      if (range < bestRange) {
        bestRange = range;
        best = { tx, ty };
      }
    }
  }

  if (best) return { tx: best.tx, ty: best.ty, stacked: false };
  if (fallback) return { tx: fallback.tx, ty: fallback.ty, stacked: true };
  return undefined;
}

/**
 * Whether a body of half-extent `radius` could stand on this tile at all: inside the named room, and
 * with its whole box clear of walls and props.
 *
 * `canStand` rather than `isWalkableAt` because it is the test movement itself uses. Using the mover's
 * own authority means a tile placement accepts is a tile movement will not immediately eject a body
 * from — and that agreement is *why* this had to take a radius the day the mover's box started
 * scaling. A giant put on ground that a person fits on and a giant does not is a giant that spends its
 * first tick being refused in all four directions.
 *
 * **It takes a radius now, where the 2026-08-14 note said it deliberately did not.** That note argued a
 * scaling `standable` would *"refuse a giant every tile within one cell of a wall and hand most rooms
 * back as blocked"*. The first half is exactly right and turns out to be the feature: a giant keeps to
 * the 7x7 interior of a nine-tile room. The second half was wrong — 49 of 81 cells is not "most rooms
 * blocked", and the sweep over the shipped world finds **no room at all** with nothing a giant can
 * stand on.
 */
function standable(grid: TileGrid, roomId: RoomId, tx: number, ty: number, radius: number): boolean {
  if (roomAtTile(grid, tx, ty) !== roomId) return false;
  return canStand(grid, tileCentre(tx), tileCentre(ty), radius);
}

/**
 * Whether this tile's centre is far enough from every body for one of radius `mine` to stand on it.
 *
 * The same {@link bodyClearance} the mover uses, evaluated against a body that does not exist yet —
 * which is why it takes a radius rather than a {@link BodyPoint}. That agreement is the point: a room
 * filled by a reset must never start the next tick with a body already refusing to move.
 */
function vacant(bodies: readonly BodyPoint[], mine: number, tx: number, ty: number): boolean {
  const x = tileCentre(tx);
  const y = tileCentre(ty);
  for (const body of bodies) {
    const clear = mine + bodyRadius(body);
    if ((x - body.x) ** 2 + (y - body.y) ** 2 < clear * clear) return false;
  }
  return true;
}
