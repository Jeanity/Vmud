/**
 * Zone reset: the clock, and the executor.
 *
 * ## Reset only loads. Nothing here despawns anything.
 *
 * That is the one sentence to keep, and `REFERENCE-mud-mechanics.md` §4.9 is a warning about getting it
 * wrong: population converges because **per-vnum instance limits block over-spawning**, not because
 * anything is cleared away. Add a despawn pass and the game changes profoundly — a mob lured three zones
 * away is *supposed* to still be alive, still counting against its limit, and still leaving a hole where
 * it came from.
 *
 * So a reset is not "restore the authored state". It is **"top the world up to the limits"**, and the
 * difference is the whole mechanic. It is also why luring is a tactic with a cost rather than a way to
 * farm a room: what you drag away does not come back while you still have it.
 *
 * ## Nothing repops on a timetable
 *
 * A zone's age advances one per {@link ZONE_TICK_MS}, and it resets when the age reaches its lifespan —
 * at which point **the lifespan is re-rolled from the `.zon` file's own band**. IceCrag's is 55–65 ticks,
 * so 68 to 81 minutes, and never the same twice. That is `event_reset_zone` exactly, and the re-roll is
 * the part that matters: a fixed lifespan would let a player set a watch by it.
 *
 * ## The two gotchas, both from §4.9
 *
 * 1. **An `M` below 100% never fires on a timed reset.** The source's gate is
 *    `if ((number < limit && arg4 == 100) || force)`, so a percentage is only consulted when the reset is
 *    *forced*. Mob spawns are therefore deterministic in practice and equipment is the random layer —
 *    which is the rare-drop mechanic, and it arrived by accident. Measured across both matched zones:
 *    every one of the 332 `M` commands is at 100, so nothing is lost by honouring this exactly.
 * 2. **The chain cursor is explicit.** `if_flag` chains a command to the previous one's success, and the
 *    source carries an implicit `last_mob_load` across iterations that §4.9 calls the source of most
 *    zone-file authoring bugs. It is a named local here, and a failed *equipment* roll deliberately does
 *    not break the chain — so one piece of a mob's kit failing does not suppress the sword below it.
 */

import { ZONE_TICK_MS, isExecutable, type MobTemplate, type Rng, type ZoneSpawns } from '@mygame/shared';

import type { Mob, Simulation } from './sim.ts';

/** A zone's live reset state: how old it is, and how old it gets to be this time round. */
export interface ZoneClock {
  readonly spawns: ZoneSpawns;
  /** Ticks since the last reset. */
  age: number;
  /** Ticks until the next one, re-rolled from the band after every reset. */
  lifespan: number;
  /** Milliseconds accumulated toward the next tick — the zone clock is far slower than the sim's. */
  carryMs: number;
}

export interface ResetOutcome {
  readonly zone: number;
  /** Mobs actually loaded. Empty is the normal steady state: the world is already at its limits. */
  readonly spawned: readonly Mob[];
  /** Commands whose limit was already met — the reason a settled world stops growing. */
  readonly atLimit: number;
  /** Doors put back to their authored state. */
  readonly doors: number;
}

/**
 * Rolls a fresh lifespan from a zone's own band.
 *
 * `min === max` is honoured rather than treated as a degenerate range: a builder who wrote the same
 * number twice asked for a fixed schedule, and the source checks for exactly that before rolling.
 */
export function rollLifespan(spawns: ZoneSpawns, rng: Rng): number {
  const min = Math.max(1, Math.min(spawns.lifespanMin, spawns.lifespanMax));
  const max = Math.max(min, Math.max(spawns.lifespanMin, spawns.lifespanMax));
  if (min === max) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

export function newZoneClock(spawns: ZoneSpawns, rng: Rng): ZoneClock {
  return { spawns, age: 0, lifespan: rollLifespan(spawns, rng), carryMs: 0 };
}

/**
 * Runs one zone's reset table once.
 *
 * `force` is what a fresh boot uses. It matters for one reason and it is the §4.9 gotcha: without it an
 * `M` below 100% never fires at all, so a forced pass is the only time a percentage is consulted. Since
 * every `M` we harvested is at 100, forcing changes nothing today — but the gate is written the way the
 * source writes it so that the day a sub-100 command arrives, it behaves.
 */
export function runReset(
  sim: Simulation,
  clock: ZoneClock,
  templates: ReadonlyMap<number, MobTemplate>,
  rng: Rng,
  force = false,
): ResetOutcome {
  const spawned: Mob[] = [];
  let atLimit = 0;
  let doors = 0;

  // The explicit chain state §4.9 asks for. `lastSucceeded` gates a command whose `ifPrevious` is set;
  // `lastMobLoaded` is the separate cursor that lets a mob's kit keep loading after one piece of it fails
  // its roll — which is why they are two variables and not one.
  let lastSucceeded = true;
  let lastMobLoaded = false;

  for (const command of clock.spawns.resets) {
    const chained = command.ifPrevious;
    const attachesToMob = command.kind === 'give' || command.kind === 'equip' || command.kind === 'mount';
    if (chained && !lastSucceeded && !(attachesToMob && lastMobLoaded)) continue;

    if (!isExecutable(command)) {
      // Parsed and carried, with no executor yet — the object commands wait for items in Phase 15. They
      // must not clear the cursor: an unimplemented `E` between two `M`s is not a failure of either.
      continue;
    }

    if (command.kind === 'door') {
      if (sim.resetDoor(command)) doors++;
      lastSucceeded = true;
      continue;
    }

    // ---- `M`: load a mobile ----
    const template = templates.get(command.what);
    if (!template) {
      lastSucceeded = false;
      lastMobLoaded = false;
      continue;
    }

    // The source's own gate, verbatim in shape: the percentage is only consulted on a forced reset.
    const room = sim.countOf(command.what) < command.limit && command.percent === 100;
    if (!room && !force) {
      atLimit++;
      lastSucceeded = false;
      lastMobLoaded = false;
      continue;
    }
    if (force && !(command.percent > Math.floor(rng() * 100))) {
      lastSucceeded = false;
      lastMobLoaded = false;
      continue;
    }
    if (force && sim.countOf(command.what) >= command.limit) {
      atLimit++;
      lastSucceeded = false;
      lastMobLoaded = false;
      continue;
    }

    const mob = sim.spawnMob(template, command.room, rng);
    if (!mob) {
      lastSucceeded = false;
      lastMobLoaded = false;
      continue;
    }
    spawned.push(mob);
    lastSucceeded = true;
    lastMobLoaded = true;
  }

  clock.age = 0;
  clock.lifespan = rollLifespan(clock.spawns, rng);
  return { zone: clock.spawns.zone, spawned, atLimit, doors };
}

/**
 * Advances every zone's clock by one simulation tick, and resets whichever came due.
 *
 * The zone clock is 750 times slower than the simulation's, so the fraction is carried rather than
 * rounded — the same argument `accrue` in `vitals.ts` makes about regeneration, for the same reason: round
 * per tick and the age never advances at all.
 *
 * Returns only the zones that actually reset, which is almost never — one zone every seventy minutes or
 * so. The caller therefore does nothing on the overwhelming majority of ticks.
 */
export function advanceZones(
  sim: Simulation,
  clocks: Iterable<ZoneClock>,
  templates: ReadonlyMap<number, MobTemplate>,
  rng: Rng,
  elapsedMs: number,
): ResetOutcome[] {
  const out: ResetOutcome[] = [];
  for (const clock of clocks) {
    clock.carryMs += elapsedMs;
    while (clock.carryMs >= ZONE_TICK_MS) {
      clock.carryMs -= ZONE_TICK_MS;
      clock.age++;
    }
    if (clock.age < clock.lifespan) continue;
    out.push(runReset(sim, clock, templates, rng));
  }
  return out;
}
