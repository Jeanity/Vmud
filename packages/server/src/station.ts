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
  BODY_SEPARATION,
  TILE_SIZE,
  type BodyPoint,
  bodyClearance,
  normaliseIntent,
  roomAtTile,
  samePlace,
} from '@mygame/shared';

import { HUNT_SPEED } from './hunt.ts';
import { isMob, type Actor, type Mob, type Simulation } from './sim.ts';
import type { GameWorld } from './world.ts';

/**
 * How close **two adults** stand to fight, in world units — **one tile**, centre to centre.
 *
 * The default reach, and deliberately the only one until Phase 16. The owner's spec is per weapon —
 * fists against the body, a sword a tile off, a bow across the room — and that needs weapons to be
 * items with properties, which is Phase 15/16's job. One number now beats a table of numbers nothing
 * can populate.
 *
 * A tile is also the smallest distance that keeps two bodies visibly apart: `BODY_RADIUS` is 10 and a
 * tile is 32, so there are 12 units of daylight between the collision discs. Standing *on* the player
 * reads as a rendering fault however correct the arithmetic is.
 *
 * **This is now the reference value rather than the rule** — see {@link stationFor}, which is what
 * every line below actually calls. It is still exported, still `TILE_SIZE`, and still exactly what
 * {@link stationFor} answers for two adult bodies, which is what keeps this file's tests measuring the
 * number they were written against.
 */
export const MELEE_STATION = TILE_SIZE;

/**
 * The daylight a fighter leaves between the two collision discs at station — **12px**, and the whole
 * of what survives of `32 − 20 = 12`.
 *
 * That subtraction was this file's reconciliation with `bodies.ts` and it stopped being a statement
 * about the world on 2026-08-14, when a body's radius became a property of the body. Run it for a
 * player closing on a hill giant and it is `32 − (10 + 27.5) = −5.5`: **the station is inside the
 * giant**, so `stepActor` refuses the last 5.5px for ever, `atStation` never returns true, and a mob
 * that has arrived reads as one still walking. The bug is not subtle; it is 195 spawned bodies wide.
 *
 * So the reach scales with the pair and the daylight does not. That split is a **judgement, not a
 * measurement**, and here is the argument for it: the reason for the 12 was never physics, it was
 * *reading* — the docblock above says so, "standing on the player reads as a rendering fault". Twelve
 * pixels is 0.375 m of visible ground between two silhouettes, and 0.375 m reads as a gap at any body
 * size. The alternative considered was proportional — station = clearance × 32/20, which is also 32
 * for two adults — and it was rejected on its own numbers: it gives a person closing on a hill giant
 * 22.5px of daylight (0.70 m, nearly double a person's) and two kobold youths 3.6px (0.11 m), which at
 * the camera's usual 24 m is contact. The absolute figure is the one that keeps meaning the same thing
 * up and down the ladder.
 */
export const MELEE_DAYLIGHT = MELEE_STATION - BODY_SEPARATION;

/**
 * How close **these two** stand to fight: their own clearance, plus {@link MELEE_DAYLIGHT}.
 *
 * The one arithmetic, so the closer, the settle test and anything that later asks "is it on me" cannot
 * come to three answers. Measured against the ladder the world stands on:
 *
 * ```
 *   two adults              10.00 + 10.00 + 12 = 32.00px   TILE_SIZE, unchanged
 *   a person and a 1.5x     10.00 + 15.00 + 12 = 37.00px   SIZE_LARGE — a troll, an ettin
 *   a person and a giant    10.00 + 27.50 + 12 = 49.50px   was −5.5px of daylight; now 12
 *   two giants              27.50 + 27.50 + 12 = 67.00px
 *   two kobold youths        3.01 +  3.01 + 12 = 18.01px   the smallest pair in the world
 * ```
 *
 * **A bigger defender admits more attackers, and that falls out rather than being arranged.** Bodies
 * of radius `r` ringing a defender at station `s` need `2·s·sin(θ/2) ≥ 2r`, so people round a person
 * need 36.4° each and nine fit — the number this file has always claimed — while people round a hill
 * giant need 23.3° and **fifteen** fit, and giants round a person need 67.5° and only five do. That is
 * the right answer in both directions and no code anywhere had to be told it.
 *
 * Takes {@link BodyPoint} rather than `Actor` because that is genuinely all it reads — two radii — and
 * an `Actor` is one. Anything that can be collided with can be stood beside.
 */
export function stationFor(a: BodyPoint, b: BodyPoint): number {
  return bodyClearance(a, b) + MELEE_DAYLIGHT;
}

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
  /**
   * Everyone who turned — **players included**, because facing is face-to-face and a character in a
   * fight is pointed at their opponent rather than at their feet. Facing is on `EntityView`, so a turn
   * is a change worth sending even when nothing moved.
   */
  readonly turned: readonly Actor[];
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
  const turned: Actor[] = [];
  const reach = STATION_SPEED * (elapsedMs / 1000);

  for (const actor of sim.allActors()) {
    if (actor.fighting === undefined) continue;

    const target = sim.get(actor.fighting);
    // Same room and same map. The pointer can legitimately outlive the target being *here* — a
    // player who fled is still pointed at for the tick it takes the combat pass to notice — and a mob
    // that chased a stale pointer across a Place boundary would walk through a wall to do it.
    if (!target || target.roomId !== actor.roomId || !samePlace(target.place, actor.place)) continue;

    // **Both parties turn, which is what makes it face-to-face** (the owner's rule, 2026-08-02).
    // Turning is free and costs no round, so it happens whether or not anything closes: a body
    // already at station still tracks its opponent as they circle it, and a player backing away
    // keeps their eyes on the thing they are backing away from. Facing while engaged belongs here
    // and nowhere else — the walk in `Simulation.tick` stands down for exactly this reason.
    if (sim.turnToward(actor, target.x, target.y)) turned.push(actor);

    // Everything below moves a body, and only a mob is moved: a player walks themselves.
    if (!isMob(actor)) continue;

    // **A body that has been put on the floor stays on the floor.** The owner's rule, and it is what
    // makes knocking something down worth doing: `canMove` is the simulation's own authority on who
    // may move at all, so a stunned or prone mob is held here by the same test that holds a sitting
    // player still. When `bash` arrives in Phase 19 it will need no code here.
    if (!sim.canMove(actor)) continue;

    const gap = Math.hypot(target.x - actor.x, target.y - actor.y) - stationFor(actor, target);
    if (gap <= SETTLED) continue;

    const grid = world.grid(actor.place);
    if (!grid) continue;
    const heading = normaliseIntent(target.x - actor.x, target.y - actor.y);
    // Clamped to the gap, never past it. Overshooting is what makes a follower orbit its target —
    // the same clamp click-to-move applies to its waypoints, and for the same reason.
    //
    // **The numbers reconcile, and it is worth stating why this pass is safe.** `bodiesAllow` refuses
    // a step that closes inside `bodyClearance(actor, target)`, and {@link stationFor} is that same
    // clearance plus {@link MELEE_DAYLIGHT} — so a fighter stops 12px *outside* the radius that would
    // refuse it whatever the two of them are, and solid bodies can never leave one jittering against
    // its opponent while the round timer fires. **The reconciliation is now identical by construction
    // rather than by two constants agreeing**, which is the whole reason it is one function call: the
    // old form spelled the clearance out as 20 and would have gone negative against a giant.
    const next = sim.stepActor(actor, grid, heading.x, heading.y, Math.min(reach, gap));

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
  return Math.hypot(target.x - mob.x, target.y - mob.y) - stationFor(mob, target) <= SETTLED;
}
