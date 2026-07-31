/**
 * Perception: how a mob comes to notice somebody, and why it takes a moment.
 *
 * ## The delay is the mechanic, not an implementation detail
 *
 * `REFERENCE-mud-mechanics.md` §4.5 is a warning rather than a description: *"a mob that attacks the frame
 * you enter its room removes all skill from movement."* Duris schedules the reaction some pulses out and
 * **re-validates when it fires**, and that one delay produces speed-running, sneaking past dangerous rooms,
 * and the tension of deciding whether to risk a corridor. §4.5 names the actual risk as it *being dropped as
 * an optimisation during implementation* — so it is the first thing in this file.
 *
 * ## Revalidation is where the naive version goes wrong, and it is subtle
 *
 * The obvious implementation checks the target when it *starts* the timer and acts when the timer fires. That
 * is wrong in a way that is invisible in testing and infuriating in play: you step into a room, step
 * straight out, and are attacked from behind by something that decided to attack you while you were still
 * there. So the check happens **when the timer fires**, against the world as it then is — and the timer is
 * discarded the moment the target leaves perception, so there is nothing left to fire late.
 *
 * ## What noticing does today
 *
 * It **turns the mob toward you, and says so.** It cannot attack: engagement is Phase 11, and
 * `DESIGN-engagement.md` is explicit that the first combat code written must make stickiness explicit rather
 * than growing out of something else. So this phase builds the whole of the decision — perception, the
 * delay, the predicate, the memory — and stops at the point where a blow would land. Phase 11 hangs
 * `engage()` on the same event.
 */

import {
  AGGRO_RANGE_TILES,
  TILE_SIZE,
  matchesAggro,
  type AggroSubject,
} from '@mygame/shared';

import { isMob, isPlayer, type Actor, type Mob, type Player, type Simulation } from './sim.ts';

/**
 * What a mob has worked out about the people in front of it.
 *
 * Two maps and they are **not** the same fact, which is the distinction the phase turns on:
 *
 * - `dwell` is *"how long have I been looking at you"* — transient, per target, and thrown away the instant
 *   you leave. This is what makes running through a room free.
 * - `noticed` is memory: *"I have seen you before."* It survives you leaving the room, and it is what stops
 *   the same mob announcing you every time you step back over the threshold.
 *
 * Kept beside the actor rather than on it because they are `perception.ts`'s business alone — a `Mob` is a
 * body, and Phase 7's split exists to keep it one.
 */
export interface MobAwareness {
  /** Milliseconds each currently-perceived target has been perceived for. */
  readonly dwell: Map<number, number>;
  /** Everyone this mob has ever noticed. Only kept when its template says it remembers. */
  readonly noticed: Set<number>;
}

export function newAwareness(): MobAwareness {
  return { dwell: new Map(), noticed: new Set() };
}

/** One mob deciding about one character, this tick. */
export interface NoticeEvent {
  readonly mob: Mob;
  readonly target: Player;
  /** Whether this mob had already noticed them before — memory's one consumer today. */
  readonly remembered: boolean;
}

/**
 * Whether a mob's attention reaches a target at all.
 *
 * Room first, because it is the cheap gate and the one that holds across Places — two actors in the same
 * room are on the same grid by definition. Then distance, in tiles.
 *
 * **Not gated on light, deliberately.** See {@link AGGRO_RANGE_TILES}: `ac_can_see` is asymmetric in the
 * source, and it falls this way round — a guard is not blind in a hall it has stood in for years, while the
 * intruder is the one carrying a torch. Creeping past unseen is what stealth is for (Phase 19), not
 * something the absence of a lantern should buy.
 */
export function perceives(mob: Mob, target: Actor): boolean {
  if (mob.roomId !== target.roomId) return false;
  const dx = mob.x - target.x;
  const dy = mob.y - target.y;
  return Math.hypot(dx, dy) <= AGGRO_RANGE_TILES * TILE_SIZE;
}

/**
 * What a mob is allowed to know about a target, for the aggression predicate.
 *
 * Every field is absent, and that is the honest state of the game: players have no race and no alignment
 * until Phase 21. {@link matchesAggro} refuses a clause it cannot evaluate rather than assuming a default,
 * so a mob that objects to elves objects to nobody yet — which is right, because nobody is an elf yet.
 *
 * A named function rather than an inline `{}` so that Phase 21 has one place to fill in, and so the *reason*
 * it is empty is written down where somebody would otherwise wonder.
 */
export function subjectOf(_target: Player): AggroSubject {
  return {};
}

/**
 * Advances every mob's attention by one tick and reports who just decided about whom.
 *
 * The order inside the loop is the whole design:
 *
 * 1. Drop the dwell timer for anyone no longer perceived. **First**, so a target who left cannot have a
 *    timer fire for them later in this same pass.
 * 2. Advance the timer for everyone still perceived.
 * 3. When a timer passes the reaction, **re-check everything** — still perceived, still a target the
 *    predicate objects to — and only then notice.
 *
 * A passive mob is skipped before any of it. Most of a castle is passive (52 of IceCrag's 66), so the common
 * case costs one field read.
 */
export function advancePerception(
  sim: Simulation,
  awareness: Map<number, MobAwareness>,
  elapsedMs: number,
): NoticeEvent[] {
  const events: NoticeEvent[] = [];

  for (const actor of sim.allActors()) {
    if (!isMob(actor)) continue;
    const rule = actor.aggro;
    // Passive is the overwhelming majority, and it never initiates whatever else is true of it.
    if (rule.disposition === 'passive') continue;

    const mind = awareness.get(actor.id) ?? newAwareness();
    if (!awareness.has(actor.id)) awareness.set(actor.id, mind);

    // Who is in front of it right now. Players only: a mob objecting to another mob is faction fighting,
    // which nothing models, and `assistsOthers` in §2.3 is Phase 12's.
    const present = new Set<number>();
    for (const other of sim.actorsIn(actor.roomId)) {
      if (!isPlayer(other) || !perceives(actor, other)) continue;
      present.add(other.id);
    }

    // 1. Anyone who left is forgotten *as a dwell*. This is the line that makes running through free, and
    //    deleting rather than pausing is deliberate: a resumed timer would mean two half-visits add up to
    //    one noticing, which is exactly the tension §2.2 says the number exists to create.
    for (const id of [...mind.dwell.keys()]) {
      if (!present.has(id)) mind.dwell.delete(id);
    }

    for (const id of present) {
      const target = sim.player(id);
      if (!target) continue;

      const before = mind.dwell.get(id) ?? 0;
      const dwelt = before + elapsedMs;
      mind.dwell.set(id, dwelt);
      // 2. Only the tick that **crosses** the reaction counts. An edge, not a threshold — the same shape the
      //    carried light's warning uses, and for the same reason: noticing is a transition. Testing `>=`
      //    alone would re-notice every tick for as long as somebody stood there, and clearing the timer to
      //    avoid that would instead re-notice once per reaction period, for ever. Neither is "it has seen
      //    you"; both are a heartbeat. The timer keeps running and is cleared only when they leave, which is
      //    what re-arms it for the next approach.
      if (before >= rule.reactionMs || dwelt < rule.reactionMs) continue;

      // 3. Revalidation. `perceives` is asked *again* here, and it is not redundant with the loop above —
      //    that built `present` at the top of this pass, and this is the check §4.5 requires to happen at
      //    the moment of firing rather than the moment of scheduling. Reading it twice is cheaper than
      //    reasoning about whether it could have changed.
      if (!perceives(actor, target)) {
        mind.dwell.delete(id);
        continue;
      }
      if (!matchesAggro(rule, subjectOf(target))) {
        // Not a target after all — a mob that objects to elves, looking at somebody who is not one. Drop the
        // timer so it is not re-evaluated every tick for as long as they stand there.
        mind.dwell.delete(id);
        continue;
      }

      const remembered = mind.noticed.has(id);
      // The timer is deliberately **not** cleared here — see the crossing test above. It stays past the
      // reaction so the edge cannot fire twice, and leaving perception is the only thing that resets it.
      if (rule.remembers) mind.noticed.add(id);
      events.push({ mob: actor, target, remembered });
    }
  }

  return events;
}

/**
 * Forgets a character everywhere — called when one disconnects.
 *
 * There is no matching `forgetMob`, and its absence is deliberate: **nothing removes a mob yet.** Reset only
 * loads (§4.9) and nothing can kill one until Phase 13, so an awareness entry cannot outlive its mob. When
 * death arrives it needs one line here, and this note is where to find it.
 *
 * Both maps, and `noticed` matters as much as `dwell`: entity ids are reissued to new characters, so a mob
 * that remembered id 7 would silently already know the next person to be handed it.
 */
export function forgetTarget(awareness: Map<number, MobAwareness>, targetId: number): void {
  for (const mind of awareness.values()) {
    mind.dwell.delete(targetId);
    mind.noticed.delete(targetId);
  }
}
