/**
 * The hunt: a mob that has noticed you, following you through the map.
 *
 * ## Two layers, and keeping them apart is the whole design
 *
 * **Policy is a room-graph question.** Which room do I go to next? How far away is my quarry? Is the room
 * ahead somewhere I may not go? That is {@link firstStepToward}, a breadth-first search over exits, and it
 * is what `mobact.c`'s `find_first_step` does every pulse.
 *
 * **Motion is a tile question.** Having decided on an exit, the mob walks to it and through it, on the same
 * grid and through the same collision as a player. That is {@link advanceHunts}.
 *
 * Mixing them is the tempting shortcut and it is wrong twice over. A pure tile-space A* toward the quarry
 * would chase it *through* a sanctuary rather than stopping at the threshold, because tiles do not know
 * what a room is; and it would make the mob home in on a position rather than take an exit, which is the
 * distinction §2.5 draws when it says pursuit is a room-graph walk. Meanwhile a pure room-graph hop would
 * teleport a body between room centres, which in a game you can *watch* reads as a bug.
 *
 * ## What stops a hunter
 *
 * In rough order of how often each fires: the quarry is in the room already (the hunt has succeeded and
 * Phase 11 takes over), the quarry left the Place, `trackRooms` is exceeded, the give-up timer ran out, or
 * the search found no path. Sanctuary and `no_mob` do not stop the hunt — they are removed from the graph,
 * so a hunter *routes around* them and only gives up if that leaves no way through. That is
 * `BFS_AVOID_NOMOB`'s behaviour in the source and it is much better than stopping dead: a mob that paces
 * outside the inn you ran into is the picture §2.10 is after.
 */

import {
  HUNT_STEP_MS,
  ROOM_TILES,
  TILE_SIZE,
  doorwayTiles,
  huntBlockedBy,
  roomAtTile,
  normaliseIntent,
  pursues,
  stepMovement,
  tileCentre,
  type Direction,
  type PursuitRule,
  type RoomId,
} from '@mygame/shared';

import { isMob, isPlayer, type Actor, type Mob, type Player, type Simulation } from './sim.ts';
import type { GameWorld } from './world.ts';

/** How fast a hunter moves, in px/s. A room is `ROOM_TILES` across and takes {@link HUNT_STEP_MS}. */
export const HUNT_SPEED = (ROOM_TILES * TILE_SIZE * 1000) / HUNT_STEP_MS;

/**
 * One mob's chase, in progress.
 *
 * `quarry` is an entity id rather than a `Player` so that a disconnect cannot leave a live reference to a
 * body that has left the world — the same reason `MobAwareness` keys on ids.
 */
export interface Hunt {
  readonly mob: Mob;
  quarry: number;
  /** Milliseconds since the quarry was last in a room this mob could see it in. */
  lostForMs: number;
  /** The room this mob is currently walking toward, and the exit it is taking to get there. */
  nextRoom: RoomId | undefined;
  heading: Direction | undefined;
}

/** What happened to one hunter this tick, for the caller to announce and sync. */
export interface HuntEvent {
  readonly mob: Mob;
  readonly kind: 'entered' | 'arrived' | 'gaveUp';
  /** Set on `entered`: the room it just walked into, and the one it came from. */
  readonly from?: RoomId;
  readonly to?: RoomId;
  /** The direction it went, for "a sentry arrives from the south". */
  readonly heading?: Direction;
}

/* -------------------------------------------------------------------------- */
/* Policy: the room graph                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether a hunter may pass through a room at all.
 *
 * Not "may stand in" — a room refused here is cut out of the search entirely, so the path routes around
 * it. See the module note on why that beats stopping.
 */
export function huntMayEnter(world: GameWorld, rule: PursuitRule, roomId: RoomId, home: number): boolean {
  const located = world.locate(roomId);
  if (!located) return false;
  if (huntBlockedBy(located.room.flags, rule)) return false;
  // `ACT_SENTINEL || ACT_STAY_ZONE`, which the source reads as one leash. Note it compares *zones*, not
  // Places — a leashed hunter will follow you up a staircase inside its own zone.
  if (rule.staysInZone && located.room.zone !== home) return false;
  return true;
}

/**
 * The first step from `from` toward `to`, or nothing if there is no way there.
 *
 * Breadth-first from the hunter outward, which is `find_first_step`'s own shape: it answers "which exit"
 * rather than producing a whole path, because the path is recomputed every step anyway and the quarry is
 * moving. Bounded by `trackRooms` in *rooms of distance*, so the bound is the leash and the cost limit at
 * once.
 *
 * **Refuses to cross a Place**, settled in Phase 6 and restated in §2.5: a mob follows you through the room
 * graph of the zone-and-level it is in, and never up a staircase or through a link to another zone.
 *
 * It no longer refuses a *portal* as such — 15c measured that most portals are same-level links the layout
 * pass could not draw rather than genuine Place changes, so the flag was refusing ordinary doors and
 * handing players an escape route that could not be explained. The Place comparison catches every real
 * crossing, portal or not.
 */
export function firstStepToward(
  world: GameWorld,
  rule: PursuitRule,
  from: RoomId,
  to: RoomId,
): { readonly dir: Direction; readonly room: RoomId; readonly rooms: number } | undefined {
  if (from === to) return undefined;
  return firstStepWhere(world, rule, from, (room) => room === to);
}

/**
 * The same search, stopping at the first room that satisfies a predicate rather than at a named one.
 *
 * {@link firstStepToward} is this with `room === to`, and Phase 14's flight toward allies is this with
 * *"is one of mine standing there"* — a destination that is not known before the search runs, because the
 * question is which friend is **nearest**. Asking the room-id form once per candidate would repeat the
 * same breadth-first walk for every mob in the zone to learn what one walk already knows.
 *
 * `maxRooms` defaults to the rule's own leash, which is what hunting wants. Fleeing passes a much shorter
 * bound: running to a friend six rooms away is not fleeing, it is commuting.
 */
export function firstStepWhere(
  world: GameWorld,
  rule: PursuitRule,
  from: RoomId,
  goal: (room: RoomId) => boolean,
  maxRooms: number = rule.trackRooms,
): { readonly dir: Direction; readonly room: RoomId; readonly rooms: number } | undefined {
  const origin = world.locate(from);
  if (!origin) return undefined;
  const home = origin.room.zone;
  const place = origin.place;

  // Each frontier entry remembers the *first* step that reached it, which is the only thing the caller
  // needs — no parent chain, no path to reverse.
  interface Node {
    readonly room: RoomId;
    readonly dir: Direction;
    readonly next: RoomId;
    readonly depth: number;
  }
  const seen = new Set<RoomId>([from]);
  const queue: Node[] = [];

  const expand = (roomId: RoomId, first: { dir: Direction; next: RoomId } | undefined, depth: number) => {
    const here = world.locate(roomId);
    if (!here) return;
    for (const [dir, exit] of Object.entries(here.room.exits)) {
      const next = exit.to;
      if (seen.has(next)) continue;
      // **The Place is the leash, and it is the only thing tested.** Phase 6 also refused `exit.portal`
      // here, on the reasoning that a portal *is* a Place change by definition. Measured in 15c, that
      // turned out to be false for the great majority: of 7,261 portals in the shipped world, most are
      // same-level links where the layout pass could not reconcile the `.wld` exit graph with the map's
      // own coordinates — 4,996 same-level exits are simply not axis-aligned with their destination.
      //
      // So the flag conflated *"leads somewhere else entirely"* with *"the map cannot draw this"*, and
      // refusing on it gave players a free escape that looked arbitrary: run into the one exit your
      // pursuer will not follow. Harmless while portals were invisible; a discoverable exploit the
      // moment 15c drew them. A real Place change is still refused — the line below catches it, and
      // always did, which is why removing the flag check loses nothing.
      const there = world.locate(next);
      if (!there || there.place.zone !== place.zone || there.place.level !== place.level) continue;
      if (!huntMayEnter(world, rule, next, home)) continue;
      seen.add(next);
      const step = first ?? { dir: dir as Direction, next };
      queue.push({ room: next, dir: step.dir, next: step.next, depth });
    }
  };

  expand(from, undefined, 1);
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head]!;
    if (goal(node.room)) return { dir: node.dir, room: node.next, rooms: node.depth };
    if (node.depth >= maxRooms) continue;
    expand(node.room, { dir: node.dir, next: node.next }, node.depth + 1);
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Motion: the tile grid                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Where in the room a mob should aim to leave by a given exit.
 *
 * The doorway's own tiles, averaged. A doorway is `CONNECTOR_WIDTH` tiles across, so its centre is a point
 * a mob can walk at without clipping the jamb — and using the grid's own carved tiles rather than
 * recomputing the geometry means this cannot drift from where the gap actually is.
 */
export function exitAim(
  world: GameWorld,
  mob: Mob,
  dir: Direction,
): { readonly x: number; readonly y: number } | undefined {
  const grid = world.grid(mob.place);
  if (!grid) return undefined;
  const tiles = doorwayTiles(grid, mob.roomId, dir);
  if (tiles.length === 0) {
    // No carved doorway: an exit the layout could not reconcile. Aim at the neighbouring room's centre and
    // let collision sort it out, rather than refusing to move at all.
    const there = world.locate(mob.roomId)?.room.exits[dir]?.to;
    const origin = there === undefined ? undefined : grid.roomOrigins.get(there);
    if (!origin) return undefined;
    const half = (ROOM_TILES - 1) / 2;
    return { x: tileCentre(origin.tx + half), y: tileCentre(origin.ty + half) };
  }
  let sx = 0;
  let sy = 0;
  for (const index of tiles) {
    sx += tileCentre(index % grid.width);
    sy += tileCentre(Math.floor(index / grid.width));
  }
  return { x: sx / tiles.length, y: sy / tiles.length };
}

/* -------------------------------------------------------------------------- */
/* The pass                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether the quarry is still somewhere this mob could reach at all — the same Place.
 *
 * Not a sight test, deliberately. Losing sight of you is not losing you: the source's hunter re-runs a
 * path search to your *room* whether or not it can see you, and that omniscience-within-reach is what
 * makes fleeing a matter of distance and geography rather than of breaking line of sight. What §2.10
 * calls a decaying scent trail is the refinement that softens this, and it is a `relentless`-tier feature
 * with nothing to demonstrate it in a world where pursuit already stops at every staircase.
 */
function stillOnIt(mob: Mob, quarry: Player): boolean {
  return mob.place.zone === quarry.place.zone && mob.place.level === quarry.place.level;
}

/**
 * Starts a hunt, if this mob is the sort that hunts and is not already on someone.
 *
 * Called from the notice event, which is the only thing that produces a quarry — so hunting is downstream
 * of Phase 9's predicate and delay rather than a second way of deciding to care about somebody.
 */
export function beginHunt(hunts: Map<number, Hunt>, mob: Mob, quarry: Player): Hunt | undefined {
  if (!pursues(mob.pursuit)) return undefined;
  const existing = hunts.get(mob.id);
  if (existing) {
    // Already chasing someone. Switching target on a fresh notice would make the last person through the
    // door always the victim, which is a threat rule and belongs to Phase 12.
    return existing;
  }
  const hunt: Hunt = { mob, quarry: quarry.id, lostForMs: 0, nextRoom: undefined, heading: undefined };
  hunts.set(mob.id, hunt);
  return hunt;
}

/** Ends every hunt for a quarry that has left the world. */
export function forgetQuarry(hunts: Map<number, Hunt>, quarryId: number): void {
  for (const [id, hunt] of hunts) if (hunt.quarry === quarryId) hunts.delete(id);
}

/** One tick's worth of hunting: what to announce, and whose position moved. */
export interface HuntTick {
  readonly events: readonly HuntEvent[];
  /** Mobs whose position changed, for the caller to fold into its `entityMoved` batch. */
  readonly moved: readonly Mob[];
}

/**
 * Advances every hunt by one tick.
 *
 * Returns what to announce and sync. The mob is moved here directly rather than through an intent field:
 * `sim.ts`'s movement pass is explicitly players-only — *"a mob moves when Phase 10 makes it hunt, and that
 * will be its own pass over the room graph rather than another reader of `intentX`"* — and this is that
 * pass, written where the note said it would be.
 */
export function advanceHunts(
  sim: Simulation,
  world: GameWorld,
  hunts: Map<number, Hunt>,
  elapsedMs: number,
): HuntTick {
  const events: HuntEvent[] = [];
  const moved: Mob[] = [];

  for (const [id, hunt] of [...hunts]) {
    const mob = hunt.mob;
    const quarry = sim.player(hunt.quarry);
    const rule = mob.pursuit;

    // Gone from the world entirely.
    if (!quarry) {
      hunts.delete(id);
      events.push({ mob, kind: 'gaveUp' });
      continue;
    }

    // Caught up: same room. The hunt has done its job and stops here — engagement is Phase 11's, and
    // `MobStartFight` is exactly where the source goes next.
    if (mob.roomId === quarry.roomId) {
      hunt.lostForMs = 0;
      hunt.nextRoom = undefined;
      hunt.heading = undefined;
      events.push({ mob, kind: 'arrived' });
      continue;
    }

    // Off this Place: pursuit stops at the boundary, settled in Phase 6. The timer runs while it waits,
    // so a quarry who goes upstairs and stays there is eventually forgotten.
    if (!stillOnIt(mob, quarry)) {
      hunt.lostForMs += elapsedMs;
      if (rule.giveUpMs !== null && hunt.lostForMs >= rule.giveUpMs) {
        hunts.delete(id);
        events.push({ mob, kind: 'gaveUp' });
      }
      continue;
    }

    const step = firstStepToward(world, rule, mob.roomId, quarry.roomId);
    if (!step) {
      // No route within `trackRooms` — too far, or walled off by sanctuary and `no_mob`. Not an immediate
      // give-up: the quarry may come back into range, and the timer is what decides.
      hunt.lostForMs += elapsedMs;
      if (rule.giveUpMs !== null && hunt.lostForMs >= rule.giveUpMs) {
        hunts.delete(id);
        events.push({ mob, kind: 'gaveUp' });
      }
      continue;
    }

    hunt.lostForMs = 0;
    hunt.nextRoom = step.room;
    hunt.heading = step.dir;

    const grid = world.grid(mob.place);
    const aim = exitAim(world, mob, step.dir);
    if (!grid || !aim) continue;

    const dx = aim.x - mob.x;
    const dy = aim.y - mob.y;
    const intent = normaliseIntent(dx, dy);
    if (intent.x === 0 && intent.y === 0) continue;

    // Never overshoot the doorway: the same clamp the player's route walker uses, and for the same reason
    // — overshooting is what makes a follower orbit the thing it is walking at.
    const distance = Math.min((HUNT_SPEED * elapsedMs) / 1000, Math.hypot(dx, dy));
    const before = mob.roomId;
    const startX = mob.x;
    const startY = mob.y;
    const next = stepMovement(grid, mob.x, mob.y, intent.x, intent.y, distance);
    mob.x = next.x;
    mob.y = next.y;
    if (mob.x === startX && mob.y === startY) continue;
    mob.facing = headingOf(intent.x, intent.y, mob.facing);
    moved.push(mob);

    // -1 is a corridor between rooms: keep the room it left until it stands somewhere real, exactly as the
    // player pass does. Without this a mob is briefly in no room and drops out of everyone's view mid-stride.
    const arrivedIn = roomAtTile(grid, Math.floor(mob.x / TILE_SIZE), Math.floor(mob.y / TILE_SIZE));
    if (arrivedIn !== -1 && arrivedIn !== before) {
      mob.roomId = arrivedIn;
      events.push({ mob, kind: 'entered', from: before, to: arrivedIn, heading: step.dir });
    }
  }

  return { events, moved };
}

/** The same rule `sim.ts` uses, including its diagonal-ambiguity clause. */
function headingOf(dx: number, dy: number, previous: Direction): Direction {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'south' : 'north';
  return previous;
}

/** Mobs that could hunt at all, for a caller that wants to skip the rest cheaply. */
export function hunters(sim: Simulation): Mob[] {
  const out: Mob[] = [];
  for (const actor of sim.allActors()) if (isMob(actor) && pursues(actor.pursuit)) out.push(actor);
  return out;
}

/** Narrowing helper re-exported so callers need one import for the hunt. */
export { isMob, isPlayer, type Actor, type Player };
