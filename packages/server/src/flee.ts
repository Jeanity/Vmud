/**
 * Fleeing — `DESIGN-engagement.md` §5's **only voluntary way out of a fight**.
 *
 * One implementation for players and mobs, which is the source's own shape: `do_flee` is called by a
 * player typing `flee`, by `mobact.c` when a wimpy mob's morale breaks, and by half a dozen spells that
 * make something run. Two copies would drift, and the half that drifted would be the mob's — so the
 * player's `flee` and a servant bolting from a fight go through this function and differ only in what
 * `index.ts` says about it afterwards.
 *
 * ## What the source does, in order, and what each step is for
 *
 * 1. **A body that cannot act cannot run.** Asleep, incapacitated, dying: refused.
 * 2. **Not standing fails the attempt but gets you up.** `do_flee`'s
 *    *"Looking panicked, $n scrambles madly to $s feet!"* — the round is spent and you are on your feet
 *    for the next one. It is the difference between a mechanic and a trap: a knocked-down character is
 *    not helpless, they are one round behind.
 * 3. **Count the ways out.** A closed door is not a way out (`CAN_GO` tests it), which is what makes
 *    shutting one a tactic rather than decoration.
 * 4. **Pick a direction.** Random, except for a mob that can path — see {@link chooseDirection}.
 * 5. **Roll**, but only if actually engaged: `!was_fighting || number(0,100) < chance`. Walking out of a
 *    room you are not fighting in always works and still costs the movement.
 * 6. **On success, everyone swinging at you stops** (`StopAllAttackers`), and the movement is spent.
 *
 * The one thing deliberately *not* transcribed is the direction argument. `flee west` is a rogue skill in
 * the source (`SKILL_CONTROL_FLEE`) and skills are Phase 19; until then flight is panicked by definition
 * and the direction is not yours to choose.
 */

import {
  DIRECTIONS,
  escapes,
  fleeCost,
  pursues,
  type Direction,
  type Place,
  type Rng,
  type RoomId,
} from '@mygame/shared';

import { clearEngagements } from './combat.ts';
import { firstStepWhere } from './hunt.ts';
import type { Scheduler } from './scheduler.ts';
import { isMob, isPlayer, type Actor, type Simulation } from './sim.ts';
import type { GameWorld } from './world.ts';

/**
 * How far a frightened mob will look for a friend to run to.
 *
 * Three rooms. Ours, and small on purpose: §2.8 wants a fleeing mob to become *a developing problem*
 * rather than an escape, and that only holds if it reaches help while you are still chasing it. A long
 * leash would have it set off across the castle, which reads as a mob that has lost interest in you.
 */
export const ALLY_SEARCH_ROOMS = 3;

export type FleeOutcome =
  /** Asleep, dying or knocked out — there is no attempt to make. */
  | { readonly kind: 'helpless' }
  /** Was not on its feet: the attempt is spent standing up, per `do_flee`. */
  | { readonly kind: 'scrambled' }
  /** Nowhere to go. Every exit is a wall, a shut door or somewhere this body may not stand. */
  | { readonly kind: 'cornered' }
  /** Rolled and failed. Still engaged, still there, a round worse off. */
  | { readonly kind: 'panicked' }
  | {
      readonly kind: 'fled';
      readonly dir: Direction;
      readonly from: RoomId;
      readonly fromPlace: Place;
      readonly to: RoomId;
      /** Movement points spent. Zero for a mob, which has no pool to spend from. */
      readonly cost: number;
      /** Who it had been fighting, for the caller to set a pursuit on. Undefined if it was not engaged. */
      readonly wasFighting: Actor | undefined;
      /** Everyone whose engagement pointer this broke, for the caller to re-sync. */
      readonly changed: readonly Actor[];
    };

export interface FleeDeps {
  readonly world: GameWorld;
  readonly sim: Simulation;
  readonly scheduler: Scheduler;
  readonly rng: Rng;
}

/**
 * Everywhere this body could go from where it stands.
 *
 * A closed door is not an exit; neither is one leading out of the Place, because a flight is a step
 * through the room graph and Phase 6 settled that the room graph stops at a Place boundary. For a mob,
 * rooms it may not stand in are cut too — `no_mob` and, if its rule respects them, sanctuaries — which is
 * `can_enter_room`'s job in the source.
 */
export function fleeExits(world: GameWorld, sim: Simulation, actor: Actor): Direction[] {
  const here = sim.room(actor.roomId);
  if (!here) return [];
  const out: Direction[] = [];
  for (const dir of DIRECTIONS) {
    const exit = here.exits[dir];
    if (!exit) continue;
    // Closed, not locked — the same rule `stepRoom` walks by. Locked is what refuses `open`; closed is
    // what refuses passage, and a shut door is therefore a way of cornering something.
    if (world.doorway(actor.roomId, dir)?.near.door.closed) continue;
    const there = world.locate(exit.to);
    if (!there) continue;
    if (isMob(actor) && !mobMayFleeInto(world, actor, exit.to)) continue;
    out.push(dir);
  }
  return out;
}

/** `can_enter_room` for a fleeing mob: the pursuit rule's own room filter, reused. */
function mobMayFleeInto(world: GameWorld, actor: Actor, room: RoomId): boolean {
  if (!isMob(actor)) return true;
  const there = world.locate(room);
  if (!there) return false;
  const flags = there.room.flags;
  if (flags?.includes('no_mob')) return false;
  return !(actor.pursuit.respectsSafeRooms && flags?.includes('safe'));
}

/**
 * Which way it runs.
 *
 * Duris picks uniformly at random from the available exits, and that is what a panicking body does. Our
 * one divergence is §2.8's, and the roadmap asked for it by name: **a mob that can path runs toward its
 * allies**, turning a fleeing mob into a developing problem rather than an escape.
 *
 * The predicate for "can path" is `pursues(rule)` — the same faculty hunting needs — and it is a
 * *capability* argument rather than a stand-in for the intelligence score the simple `.mob` record does
 * not carry: fleeing toward allies is a room-graph search, so a mob that cannot search cannot search
 * toward anything either. It lands well in the shipped world: of IceCrag's five placed cowards, the
 * Archivist's two assistants run for help and the cleaning crew, the garden attendant and the mason
 * scatter blindly — the ones clever enough to hunt you down are the ones clever enough to fetch someone.
 */
export function chooseDirection(deps: FleeDeps, actor: Actor, available: readonly Direction[]): Direction {
  const random = (): Direction => available[Math.floor(deps.rng() * available.length)] ?? available[0]!;
  if (!isMob(actor) || !pursues(actor.pursuit)) return random();

  // Rooms with one of ours standing in them. Anything alive that is not the thing chasing us: a mob's
  // ally is any other mob, because there are no factions until Phase 21 and inventing one here would be
  // a mechanism no data supports.
  const step = firstStepWhere(
    deps.world,
    actor.pursuit,
    actor.roomId,
    (room) => room !== actor.roomId && deps.sim.actorsIn(room).some((other) => isMob(other) && other.id !== actor.id),
    ALLY_SEARCH_ROOMS,
  );
  // The search may name an exit this body cannot actually take — a shut door it would have walked
  // through, since the room graph does not know about door state. Fall back rather than stand still.
  if (step && available.includes(step.dir)) return step.dir;
  return random();
}

/**
 * One attempt to break off and run. See the header for the order and where each step comes from.
 *
 * Moves the body and clears the engagement pointers itself, because those are the parts that must not
 * differ between a player fleeing and a mob bolting. Everything *said* about it is the caller's — this
 * returns facts, `index.ts` renders them per recipient.
 */
export function attemptFlee(deps: FleeDeps, actor: Actor): FleeOutcome {
  const { sim, scheduler, world, rng } = deps;

  // A body that cannot act cannot run. `canMove` is the simulation's own authority on that and already
  // knows about both position axes, so morale cannot come to disagree with movement about who is on
  // their feet.
  if (actor.status === 'dead' || actor.status === 'dying' || actor.status === 'incapacitated') {
    return { kind: 'helpless' };
  }
  if (actor.status === 'sleeping') return { kind: 'helpless' };

  // Not standing: the attempt buys you your feet and nothing else.
  if (actor.posture !== 'standing') {
    sim.setStance(actor, { posture: 'standing' });
    return { kind: 'scrambled' };
  }

  const available = fleeExits(world, sim, actor);
  if (available.length === 0) return { kind: 'cornered' };

  const engaged = actor.fighting !== undefined;
  // Not fighting means it always works — `!was_fighting ||` in the source. Walking out of a room is not
  // a gamble; breaking contact with something swinging at you is.
  if (engaged && !escapes(rng, available.length)) return { kind: 'panicked' };

  const dir = chooseDirection(deps, actor, available);
  const from = actor.roomId;
  const fromPlace = actor.place;
  const exit = sim.room(from)?.exits[dir];
  if (!exit) return { kind: 'cornered' };
  const wasFighting = actor.fighting === undefined ? undefined : sim.get(actor.fighting);

  if (!sim.relocate(actor, exit.to)) return { kind: 'cornered' };

  // §5: everyone swinging at you stops, found by scanning. This is `StopAllAttackers` and it is the
  // whole point of the exit existing — a flight that left the pointers in place would have the fight
  // carry on through a wall.
  const changed = clearEngagements(scheduler, sim, actor);

  // The price. A mob has no movement pool (nothing spends one yet), so this is a player's cost in
  // practice — and it is steep by design: two flights in a row leaves you walking through a castle full
  // of things that are faster than you.
  const cost = isPlayer(actor) ? Math.min(fleeCost(rng), actor.move) : 0;
  actor.move = Math.max(0, actor.move - cost);

  return { kind: 'fled', dir, from, fromPlace, to: exit.to, cost, wasFighting, changed };
}
