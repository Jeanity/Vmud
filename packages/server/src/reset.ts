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

import {
  ZONE_TICK_MS,
  armourClassFrom,
  instantiate,
  isExecutable,
  slotForWearPosition,
  type ItemTemplate,
  type MobTemplate,
  type Rng,
  type RoomId,
  type ZoneSpawns,
} from '@mygame/shared';

import { applyOutfit, type Outfit } from './mob-overrides.ts';
import type { Mob, Simulation } from './sim.ts';

/** A zone's live reset state: how old it is, and how old it gets to be this time round. */
export interface ZoneClock {
  /**
   * The population this zone resets to.
   *
   * **Mutable since A9c**, and deliberately: a clock copies the table at boot, so an authored placement
   * that only reached the overlay file would take effect on the next server start and not before. Every
   * write rebuilds this from the harvest plus the placements as they now stand — rebuilt rather than
   * appended, or the table would grow by one every time somebody pressed Save.
   */
  spawns: ZoneSpawns;
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
  /**
   * Mobs this pass could not give a tile of their own — **placed anyway, and counted**.
   *
   * A missing mob is worse than an overlap, so `spawnMob` degrades to sharing a tile when a room has
   * more bodies than standable floor (zone 168's Cubs Den is the case that motivated it). Reporting the
   * number is what keeps that from being a silent policy: a zone that crowds every reset is a zone
   * whose population outgrew its geometry, and this is the only place that would ever say so.
   */
  readonly crowded: number;
  /** Pieces of kit put on or into the mobs that were loaded. Phase 15c. */
  readonly kitted: number;
  /**
   * Objects an `O` command wants on a floor — **intentions, not placements**.
   *
   * Returned rather than placed, because the ground store lives in `index.ts` and this file has no
   * reference to it. The same split `spawned` already makes: the executor decides *whether*, and the
   * caller decides where in the room it lands.
   */
  readonly objects: readonly { readonly template: ItemTemplate; readonly room: RoomId }[];
  /**
   * Objects a `P` command wants **inside another object** — intentions again, and for a harder reason
   * than `O`'s.
   *
   * `O` needs a room, which this file has. `P` needs the *particular container instance* just placed,
   * which lives in a store this file has no reference to. So it hands back the container's **vnum** and
   * lets the caller match it against the objects it has just put down — the same split, one level up.
   */
  readonly contents: readonly { readonly template: ItemTemplate; readonly container: number }[];
}

/**
 * The most armour class a mob's whole worn kit may be worth. `MAX_ITEM_ARMOUR_BONUS`, deliberately.
 *
 * **The cap exists because of one measured pathology, and it is sized so that it only touches it.**
 * Measured across 2,016 mob loads: 15% wear at least one armour piece, the median wears **one** and
 * gains **+3**, and the ninetieth percentile gains **+8**. Then the tail: a sentinel private in IceCrag
 * is equipped with **34 pieces** and would reach **AC 94**, which is not an armoured soldier but a
 * quartermaster standing in his own stores — and at that armour class a player rolling a natural 19
 * still misses. Kobold Settlement, the zone actually played, tops out at **+5**, so the cap never bites
 * anywhere a character currently goes.
 *
 * One legendary piece is the unit, which is the same number {@link armourBonusFrom} caps a single item
 * at: **a mob's entire kit is worth at most one very good piece of armour.**
 */
export const MAX_MOB_KIT_ARMOUR = 8;

/**
 * Folds what a mob is wearing into how hard it is to hit — **reversing 15c's deliberate omission**.
 *
 * 15c left a mob's kit as pure loot and said why: several pieces per mob at the catalogue's median
 * would quietly add ten armour class to every equipped guard in IceCrag, and doing that silently during
 * an inventory phase would have invalidated 14b's balance pass without anybody noticing.
 *
 * Phase 16 is the balance pass, so it is decided here instead of tuned around. **The source folds it
 * in**: Diku's `equip_char` runs the same `affect_modify` for a mob as for a player, and `calculate_ac`
 * in `fight.c` carries the authors' own note — *"we don't want to mess with the ac set in zone
 * files"* — which is about leaving an authored number alone, not about ignoring armour. So a guard in
 * mail being harder to hit than a guard in rags is what the world already means.
 *
 * Recomputed from the whole kit rather than accumulated per piece, so equipping twice cannot count once.
 */
export function refitMobArmour(mob: Mob, baseArmourClass: number): void {
  const worn = Math.min(MAX_MOB_KIT_ARMOUR, armourClassFrom(mob.equipped));
  mob.combat = { ...mob.combat, armourClass: baseArmourClass + worn };
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
  items: ReadonlyMap<number, ItemTemplate>,
  /**
   * How many of an object vnum exist **anywhere** — floors, bags, containers, corpses, mobs.
   *
   * Injected because this file has no business knowing where an object can hide, and because the
   * answer spans stores it cannot reach. Without it an `O` command has no limit it can honour and the
   * world silts up one sword per repop.
   */
  census: (vnum: number) => number,
  /**
   * What each mob vnum is authored to carry — A4c, injected for the reason everything else here is:
   * this file has no business reading an overlay off disk, and a test wants to hand it a map.
   */
  authoredLoot: (vnum: number) => Outfit,
  rng: Rng,
  force = false,
): ResetOutcome {
  const spawned: Mob[] = [];
  let atLimit = 0;
  let kitted = 0;
  const objects: { template: ItemTemplate; room: RoomId }[] = [];
  const contents: { template: ItemTemplate; container: number }[] = [];
  const placedThisPass = new Map<number, number>();
  let doors = 0;
  // Diffed rather than returned per spawn: `spawnMob` answers with a `Mob` and nothing else, and
  // threading a placement report back through it would put a rendering concern in its signature for
  // the sake of one counter. The tally is monotonic, so a before/after pair is this pass's share.
  const crowdedBefore = sim.crowding.stacked + sim.crowding.blocked;

  // The explicit chain state §4.9 asks for. `lastSucceeded` gates a command whose `ifPrevious` is set;
  // `lastMob` is the separate cursor that lets a mob's kit keep loading after one piece of it fails
  // its roll — which is why they are two variables and not one.
  let lastSucceeded = true;
  let lastMob: Mob | undefined;
  // The mob's own armour class, before anything it is wearing — kept because the refold below is
  // recomputed from scratch on every piece rather than accumulated, so a second piece cannot count the
  // first one twice.
  let lastMobBaseAc = 0;

  for (const command of clock.spawns.resets) {
    const chained = command.ifPrevious;
    const attachesToMob = command.kind === 'give' || command.kind === 'equip' || command.kind === 'mount';
    if (chained && !lastSucceeded && !(attachesToMob && lastMob)) continue;

    // ---- `G` and `E`: the last mobile loaded gets its kit ----
    //
    // **Phase 15c, and the cursor discipline written in Phase 8 is what makes them work.** Both attach
    // to `lastMob`, never to a room, which is why they carry no room at all — see `ResetCommand`. A
    // piece failing does *not* clear the cursor: a mob whose sword did not load still gets its boots.
    //
    // **A mob's kit is loot, not armour, and that is a deliberate line.** `combat` is *not* refolded
    // from what goes on: the harvested combat profile was tuned against player capability in 14b, and
    // zone 36 alone has 247 `E` commands — several pieces per mob, which at the catalogue's median +2
    // would quietly add ten armour class to every equipped guard in IceCrag. That is precisely the kind
    // of change that looks plausible and invalidates a balance pass invisibly. Making a mob's gear
    // count needs a rebalance, not a line here.
    if (command.kind === 'give' || command.kind === 'equip') {
      if (!lastMob) continue;
      const template = items.get(command.what);
      if (!template) continue;
      const item = instantiate(template);
      if (command.kind === 'give') {
        lastMob.carrying.push(item);
        kitted++;
        continue;
      }
      // **The slot comes from the command, not from the item.** `E`'s third argument is where the
      // builder put it, and that is a different fact from where it *may* go: a ring on the left hand is
      // `WEAR_FINGER_L`, and no wear flag distinguishes left from right.
      const slot = command.wearPosition === undefined ? undefined : slotForWearPosition(command.wearPosition);
      if (!slot) {
        // A position we do not model — a belt, a wrist, an ioun stone. It still exists and is still
        // worth taking off the body, so it goes in the mob's hands rather than being thrown away.
        lastMob.carrying.push(item);
        kitted++;
        continue;
      }
      lastMob.equipped[slot] = item;
      refitMobArmour(lastMob, lastMobBaseAc);
      kitted++;
      continue;
    }

    // ---- `O`: put an object in a room ----
    //
    // **The limit is the whole difficulty, and it is why this waited.** `arg2` is a *world-wide* cap on
    // how many of a vnum exist, exactly as a mob's is — so honouring it means counting every instance
    // on every floor, in every bag, inside every container and on every mob. Without that count each
    // repop would add another sword to the same table for ever, and a zone left running overnight
    // would be ankle-deep. `census` is that count, supplied by the caller because this file has no
    // business knowing where objects can hide.
    if (command.kind === 'object') {
      if (command.room === undefined) continue;
      const template = items.get(command.what);
      if (!template) continue;
      // Counted fresh each time, plus whatever this pass has already placed — two `O` rows for the
      // same vnum at a limit of one must not both fire.
      const already = census(command.what) + (placedThisPass.get(command.what) ?? 0);
      if (already >= Math.max(1, command.limit)) {
        atLimit++;
        lastSucceeded = false;
        continue;
      }
      objects.push({ template, room: command.room });
      placedThisPass.set(command.what, (placedThisPass.get(command.what) ?? 0) + 1);
      lastSucceeded = true;
      continue;
    }

    // ---- `P`: put an object inside another object ----
    //
    // **The chain is the whole mechanic.** A `P` follows the `O` that placed its container, and Duris
    // resolves it against the last object loaded — which is why this hands the caller a vnum rather
    // than trying to name an instance it cannot see. The limit is `O`'s, counted the same way and from
    // the same census, so a chest's contents cannot silt up either.
    if (command.kind === 'put') {
      if (command.container === undefined) continue;
      const template = items.get(command.what);
      if (!template) continue;
      // §4's depth rule, enforced here as well as in `put`: a container inside a container is refused
      // wherever it is attempted, including by a builder's zone file.
      if (template.container) {
        lastSucceeded = false;
        continue;
      }
      const already = census(command.what) + (placedThisPass.get(command.what) ?? 0);
      if (already >= Math.max(1, command.limit)) {
        atLimit++;
        lastSucceeded = false;
        continue;
      }
      contents.push({ template, container: command.container });
      placedThisPass.set(command.what, (placedThisPass.get(command.what) ?? 0) + 1);
      lastSucceeded = true;
      continue;
    }

    if (!isExecutable(command)) {
      // Parsed and carried, with no executor yet. `P` — put an object inside another object — still
      // waits, and on a harder problem than `O`'s: it needs the *instance* just placed rather than the
      // type, so the executor has to hand back identities rather than intentions. It must not clear
      // the cursor: an unexecuted `P` between two `M`s is not a failure of either.
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
      lastMob = undefined;
      continue;
    }

    // The source's own gate, verbatim in shape: the percentage is only consulted on a forced reset.
    const room = sim.countOf(command.what) < command.limit && command.percent === 100;
    if (!room && !force) {
      atLimit++;
      lastSucceeded = false;
      lastMob = undefined;
      continue;
    }
    if (force && !(command.percent > Math.floor(rng() * 100))) {
      lastSucceeded = false;
      lastMob = undefined;
      continue;
    }
    if (force && sim.countOf(command.what) >= command.limit) {
      atLimit++;
      lastSucceeded = false;
      lastMob = undefined;
      continue;
    }

    // An `M` always names a room; the field is optional because `G`, `E` and `P` do not.
    const mob = command.room === undefined ? undefined : sim.spawnMob(template, command.room, rng);
    if (!mob) {
      lastSucceeded = false;
      lastMob = undefined;
      continue;
    }
    spawned.push(mob);
    lastSucceeded = true;
    lastMob = mob;
    lastMobBaseAc = mob.combat.armourClass;
  }

  // **A4c, and after the whole pass rather than inside it.** Authored loot is per *template* while a
  // harvested kit is per reset command, so this dresses every mob the pass produced — including the
  // ones the table gave nothing at all. Last, so an authored piece wins a contested slot and the
  // harvested one it displaces goes to the mob's hands rather than being destroyed: what is on the
  // body only ever goes up, which is what makes "additive" true rather than merely intended.
  for (const mob of spawned) {
    // The mob's own armour class, recovered by subtracting whatever its kit is currently worth —
    // `refitMobArmour` folds from scratch, so it needs the bare number rather than the dressed one.
    const baseAc = mob.combat.armourClass - Math.min(MAX_MOB_KIT_ARMOUR, armourClassFrom(mob.equipped));
    const added = applyOutfit(mob, authoredLoot(mob.vnum));
    if (added > 0) {
      kitted += added;
      refitMobArmour(mob, baseAc);
    }
  }

  clock.age = 0;
  clock.lifespan = rollLifespan(clock.spawns, rng);
  const crowded = sim.crowding.stacked + sim.crowding.blocked - crowdedBefore;
  return { zone: clock.spawns.zone, spawned, atLimit, doors, kitted, objects, contents, crowded };
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
  items: ReadonlyMap<number, ItemTemplate>,
  census: (vnum: number) => number,
  authoredLoot: (vnum: number) => Outfit,
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
    out.push(runReset(sim, clock, templates, items, census, authoredLoot, rng));
  }
  return out;
}
