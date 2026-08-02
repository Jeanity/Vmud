/**
 * Station-keeping: a mob in a fight **closes on whoever it is fighting and follows them**.
 *
 * Phase 14c, and the owner's framing is the clearest statement of it: *"the mob should follow you
 * around the room, so if you move, the fight moves with you."*
 *
 * ## What this is not
 *
 * **It is not a range check, and adding one here would undo Phase 6.** Blows land wherever either body
 * stands — `combat.ts` contains no distance test anywhere and a test is named after that fact. This
 * moves a body toward a fight it is *already* in; whether the blow connects is settled somewhere else
 * and stays settled. That is what makes this safe to add late: nothing about threat, tanking or rescue
 * depends on the mob arriving, so a bug here is cosmetic rather than structural.
 *
 * ## Two movement systems, and why this is the second one
 *
 * `hunt.ts` answers *"which room is my quarry in and which exit leads there"* and stops the moment the
 * two are in one room (`arrived`). From there nothing moved a mob at all: it stood on the tile it
 * happened to spawn on while you walked to the far corner and the two of you traded blows across the
 * floor. This is the other half — no room graph, no exits, just closing the gap inside one room.
 *
 * They cannot both move the same body in one tick, because the hunt gives up its claim exactly when
 * this one takes over: same room means the hunt is over.
 *
 * ## Whose side the threat table is on
 *
 * Nothing here reads the threat table, and it does not need to: a mob closes on `fighting`, and *that*
 * is what threat already chooses. So pulling something off a healer moves the body as well as the
 * pointer, and a tank holding aggro holds the thing **in place next to them** — which is the first
 * time in this project that tanking is a fact about the floor rather than an inference from the log.
 */

import {
  TILE_SIZE,
  normaliseIntent,
  roomAtTile,
  samePlace,
  stepMovement,
} from '@mygame/shared';

import { HUNT_SPEED } from './hunt.ts';
import { isMob, type Actor, type Mob, type Simulation } from './sim.ts';
import type { GameWorld } from './world.ts';

/**
 * How close a mob tries to get, in world units — **one tile**, centre to centre.
 *
 * The default reach, and deliberately the only one until Phase 16. The owner's spec is per weapon —
 * fists against the body, a sword a tile off, a bow across the room — and that needs weapons to be
 * items with properties, which is Phase 15/16's job. One number now beats a table of numbers nothing
 * can populate.
 *
 * A tile is also the smallest distance that keeps two bodies visibly apart: `PLAYER_RADIUS` is 10 and
 * a tile is 32, so there are 12 units of daylight between the collision boxes. Standing *on* the
 * player reads as a rendering fault however correct the arithmetic is.
 */
export const MELEE_STATION = TILE_SIZE;

/**
 * How fast it closes — a hunter's own pace, not a walker's.
 *
 * The same creature with the same legs: a mob that crossed three rooms to reach you at
 * `HUNT_SPEED` and then ambled the last few feet would look like two different animals. It is
 * faster than `PLAYER_SPEED` by design (Phase 10's *"a hunter gains on you"*), and that is not
 * exploitable in either direction, because there is no range check — outrunning it inside the room
 * wins you nothing and losing the race costs you nothing.
 */
export const STATION_SPEED = HUNT_SPEED;

/** Distance at which the gap is close enough to leave alone, so a mob at station does not jitter. */
const SETTLED = 1;

export interface StationTick {
  /** Mobs whose position changed, for the tick's `entityMoved` batch. */
  readonly moved: readonly Mob[];
  /** Mobs that only turned. Facing is on `EntityView`, so a turn is a change worth sending. */
  readonly turned: readonly Mob[];
}

/**
 * Closes every engaged mob on its target by one tick's worth of movement.
 *
 * Runs over actors rather than a registry: a fight is a pointer on the body, there is no fight object
 * to iterate, and §2 of `DESIGN-engagement.md` is explicit that the inbound set is derived by
 * scanning. The scan costs one field read per actor and almost always finds nothing — IceCrag stands
 * ninety-two inhabitants and a handful are ever swinging.
 */
export function advanceStations(sim: Simulation, world: GameWorld, elapsedMs: number): StationTick {
  const moved: Mob[] = [];
  const turned: Mob[] = [];
  const reach = STATION_SPEED * (elapsedMs / 1000);

  for (const actor of sim.allActors()) {
    if (!isMob(actor) || actor.fighting === undefined) continue;

    const target = sim.get(actor.fighting);
    // Same room and same map. The pointer can legitimately outlive the target being *here* — a
    // player who fled is still pointed at for the tick it takes the combat pass to notice — and a mob
    // that chased a stale pointer across a Place boundary would walk through a wall to do it.
    if (!target || target.roomId !== actor.roomId || !samePlace(target.place, actor.place)) continue;

    // **A body that has been put on the floor stays on the floor.** The owner's rule, and it is what
    // makes knocking something down worth doing: `canMove` is the simulation's own authority on who
    // may move at all, so a stunned or prone mob is held here by the same test that holds a sitting
    // player still. When `bash` arrives in Phase 19 it will need no code here.
    if (!sim.canMove(actor)) continue;

    // Turning is free and happens whether or not it closes: a mob already at station still tracks you
    // as you circle it, which is most of what makes the fight look like a fight.
    if (sim.turnToward(actor, target.x, target.y)) turned.push(actor);

    const gap = Math.hypot(target.x - actor.x, target.y - actor.y) - MELEE_STATION;
    if (gap <= SETTLED) continue;

    const grid = world.grid(actor.place);
    if (!grid) continue;
    const heading = normaliseIntent(target.x - actor.x, target.y - actor.y);
    // Clamped to the gap, never past it. Overshooting is what makes a follower orbit its target —
    // the same clamp click-to-move applies to its waypoints, and for the same reason.
    const next = stepMovement(grid, actor.x, actor.y, heading.x, heading.y, Math.min(reach, gap));

    // A step that would leave the room is refused outright, which cannot normally happen — the target
    // is in this room and the mob is closing on it — but a doorway on the direct line would otherwise
    // let a mob squeeze through it while cornering something standing in the threshold.
    const into = roomAtTile(grid, Math.floor(next.x / TILE_SIZE), Math.floor(next.y / TILE_SIZE));
    if (into !== actor.roomId) continue;

    if (next.x === actor.x && next.y === actor.y) continue;
    actor.x = next.x;
    actor.y = next.y;
    moved.push(actor);
  }

  return { moved, turned };
}

/** Whether this mob is at its station — for tests, and for anything that wants to say "it is on you". */
export function atStation(mob: Mob, target: Actor): boolean {
  return Math.hypot(target.x - mob.x, target.y - mob.y) - MELEE_STATION <= SETTLED;
}
