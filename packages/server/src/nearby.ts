/**
 * **Seeing into the next room without asking** — the owner's ruling of 2026-08-13, ROADMAP intake row
 * *"ditch the 'can't see what mob is in the next room until we enter it'… we should be able to see the
 * next room as we approach it at a realistic distance."*
 *
 * This is a **recorded deviation from MUD room-scoping** toward graphical realism, and the roadmap
 * states its limit in the same breath: *visibility* widens, **reach does not**. Combat, aggro and every
 * targeted command stay room-scoped. Seeing a wolf across the field is not being in reach of it.
 *
 * ## What it generalizes
 *
 * `DESIGN-ranged.md` slice 2 already found the hole and half-crossed it: interest management covers
 * "the room and its immediate neighbours" **of *rooms* and not of *bodies*** — `visibleEntities` looped
 * `actorsIn(observer.roomId)` and nothing else, *"so until now a kobold one room west was never sent at
 * all"*. `peek.ts` opened a door in that wall for `look <direction>`: the bodies you have deliberately
 * looked at, flagged {@link EntityView.revealed}. This module turns that from look-on-demand into
 * always-on, for **open crossings only**, and rides the same flag and the same wire shape — so nothing
 * new reaches a client, and every rule already built on `revealed` (a body you may see but not touch)
 * governs these bodies too, for free.
 *
 * `peek` is untouched and still needed: it reaches through an **open door**, which this deliberately
 * does not, and it is still what a `fire <dir>` shot is gated on.
 *
 * ## "Realistic distance" is adjacency, and that is a deliberate reading
 *
 * There is no distance arithmetic here. The camera only ever shows about a room ahead, so *one open
 * crossing* is the budget the owner's sentence actually buys — and it is a budget with a hard ceiling
 * (four rooms), which a radius in tiles would not be. Two rooms away stays invisible, which is the one
 * thing the ranged design already had the owner rule out by name: *"I shouldn't be able to see from 2
 * rooms away"*.
 *
 * ## What counts as an open crossing, and why the server answers it itself
 *
 * The principle: **if the renderer draws the crossing as see-through, bodies behind it are sent; doors,
 * closed or not, hide.** The renderer's own answer is `roomScene.ts`'s edge classes — `open` vs `door`
 * vs `barrier` vs `portal` — but `describeRoom` builds a whole scene (ground plan, features, biome
 * blends) and cannot be called per observer per tick. So {@link openCrossings} derives the same answer
 * from the exit graph the server already holds, and `nearby.test.ts` pins it **against** the IR: every
 * direction this accepts, `describeRoom` must classify `open` and not solid.
 *
 * The gauntlet, in order, each clause with the reason it is there:
 *
 * 1. **Cardinal directions only.** `up` and `down` are a stairwell in `RoomScene.features`, never an
 *    edge — there is no see-through geometry for them to be drawn as.
 * 2. **An exit exists.** The graph is the truth; a wall with no exit is a wall.
 * 3. **Not a `portal`.** `RoomExit.portal` means *the destination is not the geometric neighbour* —
 *    no shared coordinate frame. A revealed body is drawn at its world position, so a body behind a
 *    portal would be drawn at a meaningless spot on this grid. This clause subsumes **seams**: a seam
 *    is a portal in the geometry and the IR calls it `open`, but both ends are different Places, so
 *    clause 5 would refuse it anyway. Named here so nobody "fixes" the omission later.
 * 4. **The far room is loaded.** 323 of 327 zones are not; the world's edge wears the source's mists.
 * 5. **Same Place.** Peek's own ruling, for peek's own reason: tile coordinates are meaningful only
 *    against one Place's grid.
 * 6. **The far room points back.** `peek`'s reciprocity check, `rev_dir` in the source. It is what
 *    keeps a one-way link from being a window.
 * 7. **No door, from either side.** `GameWorld.doorway` is the authority `stepRoom`, `open` and `close`
 *    all use, and it deliberately answers for the 5 exits in the shipped world that *face* a door
 *    without declaring one. **A door hides whether it is open or shut** — that is a narrower rule than
 *    `peek`'s (which sees through an open one) and it is the deliberate one: an open door is a hole you
 *    look through on purpose, not a wall that is not there.
 *
 * ### The one place this is narrower than the IR, named rather than discovered
 *
 * `SceneEdge.inbound` — 283 directed edges in the shipped world where the *far* room declares the exit
 * and we declare nothing. The far room's carve has cut the boundary open, so the IR classifies it
 * `open` and a renderer draws a hole. Clause 6 refuses it, because `peek` refuses it and because
 * `stepRoom` refuses walking that way: a crossing you cannot use, whose far end does not acknowledge
 * you, is exactly the shape a portal wears. Sending fewer bodies than the renderer could draw costs a
 * mob that stays hidden; sending more costs a wallhack. The test pins the direction of the error.
 *
 * ## The light gate is the far room's, never yours
 *
 * Straight from `peek.ts`, and it is the rule that makes the feature honest rather than a radar: across
 * a room boundary the observer's own light never reaches, so {@link canSee} would answer "no" for
 * every body here and the feature would send nothing. The question that matters is whether the **far
 * room lights itself** — `roomLightsItself`, the shared derivation both the server and the 2D client
 * read — or somebody standing in it carries a light, whose beacon is what you are seeing by. A dark
 * cave mouth off a sunlit road still says no, so the light model never lies.
 *
 * Deliberately *not* included: a light lying on the floor of the far room. `peek` names that exclusion
 * too, for the same reason — the ground store is a different lookup, and the two paths must agree.
 */

import { samePlace, type EntityId, type Place, type Room, type RoomId } from '@mygame/shared';
import { roomLightsItself, type LightSource } from '@mygame/shared/light.ts';
import { CARDINALS, type Cardinal } from '@mygame/shared/roomScene.ts';
import type { EntityView } from '@mygame/shared';

import { REVERSE } from './peek.ts';
import { placeOf } from './world.ts';

/**
 * The lookups {@link openCrossings} needs, injected so the whole gauntlet is testable without a world.
 *
 * Both are answers the server already has: `roomOf` is `Simulation.room`, and `hasDoor` is
 * `GameWorld.doorway` reduced to the one bit this cares about.
 */
export interface CrossingDeps {
  readonly roomOf: (id: RoomId) => Room | undefined;
  /** Whether a door hangs on this exit, **from either side**. See clause 7 in the header. */
  readonly hasDoor: (from: RoomId, dir: Cardinal) => boolean;
}

/**
 * The rooms that share an open crossing with `from` — **structure only, no light.**
 *
 * The light gate is left out on purpose and applied by {@link visibleBodies}. Two callers need this
 * answer and they need different halves of it: the entity feed needs "and is it lit", while the
 * *notification* fan-out (who must be re-evaluated when something happens in a room) needs the
 * light-free relation, because whether the far room is lit is precisely what may have just changed.
 *
 * Structure is *nearly* symmetric — every clause but one is stated over both ends — and the fan-out
 * declines to rely on that. See {@link roomsSeeingInto}.
 */
export function openCrossings(from: Room, deps: CrossingDeps): RoomId[] {
  const here = placeOf(from);
  const out: RoomId[] = [];
  for (const dir of CARDINALS) {
    const exit = from.exits[dir];
    if (!exit) continue;
    // Clause 3: no shared coordinate frame. Subsumes seams — see the header.
    if (exit.portal === true) continue;
    const far = deps.roomOf(exit.to);
    if (!far) continue;
    if (!samePlace(placeOf(far), here)) continue;
    // Clause 6: `rev_dir`, exactly as `peek` asks it.
    if (far.exits[REVERSE[dir]]?.to !== from.id) continue;
    // Clause 7: a door hides whether it is open or shut.
    if (deps.hasDoor(from.id, dir)) continue;
    out.push(far.id);
  }
  return out;
}

/**
 * The mirror: rooms whose occupants can see **into** `roomId`.
 *
 * This is what every "something changed in this room" site has to fan out over, and it is a separate
 * function rather than a reuse of {@link openCrossings} because the relation is symmetric only *nearly*
 * — one direction of a mutual pair may carry `portal` while the other does not, and a fan-out that
 * assumed perfect symmetry would leave a sprite standing in a room nobody is in.
 *
 * The candidate set is small and provably complete: clause 6 requires exits both ways, so the only
 * rooms that can possibly see into `roomId` are the far ends of `roomId`'s own cardinal exits.
 */
export function roomsSeeingInto(roomId: RoomId, deps: CrossingDeps): RoomId[] {
  const here = deps.roomOf(roomId);
  if (!here) return [];
  const out: RoomId[] = [];
  for (const dir of CARDINALS) {
    const exit = here.exits[dir];
    if (!exit) continue;
    const far = deps.roomOf(exit.to);
    if (!far || out.includes(far.id)) continue;
    if (openCrossings(far, deps).includes(roomId)) out.push(far.id);
  }
  return out;
}

/** The little of an actor this module needs. Structural, so a test needs no `Simulation`. */
export interface NearbyBody {
  readonly id: EntityId;
  readonly place: Place;
  /** The source they hold, or nothing for the bare eye. See {@link carriesLight}. */
  readonly light: LightSource | undefined;
}

/**
 * Whether a body is carrying a light — **holding a source, not merely having eyes.**
 *
 * `Actor.light` and not `Actor.lightRadius`, and the difference is the whole predicate.
 * `Simulation.recompute` derives the radius as `max(effectiveRadius(source), bare)`, and the bare eye
 * is `DEFAULT_LIGHT_RADIUS` — **2, never 0** — so *every actor in the world has a positive
 * `lightRadius`* whether or not it is carrying anything. A gate written as `lightRadius > 0` therefore
 * reads "is anybody standing there", which would light every dark room in the world that happened to
 * have a kobold in it. `light` is `undefined` unless a real source is held or affecting them, which is
 * the fact this is asking about.
 *
 * **`peek.ts` has this wrong today** (`peek.ts:188`, via `peekDeps`' `occupantsOf`, which maps
 * `lightRadius`): its `dark` outcome fires only for an *empty* dark room. Left alone rather than fixed
 * in passing — it changes what `look <direction>` and a cross-room shot are allowed to do, which is
 * `DESIGN-ranged.md`'s territory and not this slice's. Recorded here so the two are not later
 * "reconciled" by copying the broken half.
 */
export function carriesLight(body: NearbyBody): boolean {
  return body.light !== undefined;
}

/**
 * Whether a room you are looking *into* is lit enough to make out who is standing in it.
 *
 * `peek.ts`'s rule in its own words — the far room lights itself, or a body in it carries the light you
 * are seeing by — over the honest predicate. A light lying on that room's floor deliberately does not
 * count: the ground store is a different lookup, and `peek` excludes it by name for the same reason.
 */
export function farRoomLit(far: Room, bodies: readonly NearbyBody[]): boolean {
  return roomLightsItself(far) || bodies.some(carriesLight);
}

/**
 * Everything {@link visibleBodies} looks up. `index.ts` supplies the server's real answers; a test
 * supplies four literals.
 */
export interface BodyDeps<A extends NearbyBody> extends CrossingDeps {
  readonly actorsIn: (id: RoomId) => readonly A[];
  readonly viewOf: (actor: A) => EntityView;
  /**
   * The observer's own light gate — `canSee` in `index.ts`, **the single authority** on whether a body
   * in your own room is drawn. Passed in rather than reimplemented for the reason `actToRoom` passes it
   * to `actLines`: two copies of that question is how prose and presence came to disagree once already.
   */
  readonly canSee: (subject: A) => boolean;
  /** What a `look <direction>` is currently showing — `revealedRooms(player)`. Usually empty. */
  readonly revealed: ReadonlySet<RoomId>;
}

/**
 * The three sources of bodies an observer is sent, unioned, each body exactly once.
 *
 * **Order is the precedence rule, and the rule is: your own room wins.**
 *
 * 1. **Your room, through your own light** (`canSee`). These carry **no** `revealed` flag, so they stay
 *    nameable: `kill kobold` reaches them, which is the whole difference between the sources.
 * 2. **What you peeked at** (`revealed`), which bypasses the light gate because looking already paid it.
 * 3. **Across an open crossing**, gated on the far room lighting itself.
 *
 * A body reachable by more than one source appears **once**, under the earliest source that claimed it,
 * and `id` is the identity. That matters in exactly one direction: a body in your own room must never
 * come out flagged `revealed`, because `nameable` strips the flagged ones and a kobold standing in
 * front of you would stop being targetable. Between sources 2 and 3 there is nothing to decide — both
 * mint the same flag — so their union is order-insensitive, and 2 runs first only because it is older.
 *
 * The two far sources are checked for `samePlace` even though `openCrossings` already refuses a
 * cross-Place crossing: source 2 does not go through it (`peek` allows a **mutual portal pair**, which
 * can land in another zone) and a body drawn at another grid's coordinates lands somewhere meaningless.
 */
export function visibleBodies<A extends NearbyBody>(
  observer: { readonly roomId: RoomId; readonly place: Place },
  deps: BodyDeps<A>,
): EntityView[] {
  const out: EntityView[] = [];
  const claimed = new Set<EntityId>();

  for (const other of deps.actorsIn(observer.roomId)) {
    if (!deps.canSee(other)) continue;
    claimed.add(other.id);
    out.push(deps.viewOf(other));
  }

  const far = new Set<RoomId>(deps.revealed);
  const here = deps.roomOf(observer.roomId);
  if (here) {
    for (const id of openCrossings(here, deps)) {
      // The light gate, and the one thing that makes this a *view* rather than a radar.
      const room = deps.roomOf(id);
      if (room && farRoomLit(room, deps.actorsIn(id))) far.add(id);
    }
  }
  // A self-loop exit would otherwise re-emit your own room's bodies as revealed ones.
  far.delete(observer.roomId);

  for (const roomId of far) {
    for (const other of deps.actorsIn(roomId)) {
      if (claimed.has(other.id)) continue;
      if (!samePlace(other.place, observer.place)) continue;
      claimed.add(other.id);
      out.push({ ...deps.viewOf(other), revealed: true });
    }
  }
  return out;
}

/**
 * The membership diff `syncEntities` sends: who is newly visible, who has dropped out, and the set to
 * remember. **A body visible before and visible now appears in neither list** — that is the whole
 * property, and widening the visible set is exactly the change that could break it.
 *
 * Extracted from `index.ts` when the third source landed, so the claims can be tested rather than
 * reasoned about. Three of them are load-bearing and none shows on a happy path: crossing a room
 * boundary must not make a body that stays visible leave and re-enter; a mob walking from one visible
 * room to another must produce no membership event at all (its new position rides `entityMoved`, which
 * is sent to everyone watching it); and a far room going dark must produce a `leave` rather than a
 * silently stale sprite.
 *
 * The observer is never in their own watch set — being told about your own character is not optional
 * and is not a diff — so they are filtered here rather than at each caller.
 */
export function membershipDiff(
  shown: ReadonlySet<EntityId>,
  visible: readonly EntityView[],
  self: EntityId,
): { readonly entered: EntityView[]; readonly left: EntityId[]; readonly now: Set<EntityId> } {
  const now = new Set<EntityId>();
  const entered: EntityView[] = [];
  for (const entity of visible) {
    if (entity.id === self) continue;
    now.add(entity.id);
    if (!shown.has(entity.id)) entered.push(entity);
  }
  const left: EntityId[] = [];
  for (const id of shown) if (!now.has(id)) left.push(id);
  return { entered, left, now };
}
