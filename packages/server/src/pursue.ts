/**
 * Pursuit that closes — following a fleeing enemy re-engages *that* enemy.
 *
 * The owner's pick from `DESIGN-progression.md` §5b's three options (2026-08-02). The problem it
 * solves was found by playing: a wounded kobold flees at half health, and the player who follows it
 * into the next room had no way to resume *that* fight — `kill youth` resolves by keyword and picks
 * the freshest youth in the room, so the wounded one walked away from every chase. A level-1
 * character could not land a kill on anything that flees.
 *
 * ## The design is two small rules
 *
 * **A mob that flees from you leaves you pointing at it.** Not at its name — at its **entity id**,
 * the same identity the V2 click menu exists to express, and the thing a keyword cannot say when
 * three youths share one name.
 *
 * **Arriving in a room where your quarry stands re-engages it.** Any arrival — walking, or the click
 * path — because the pointer rides the player, not the command that moved them. The re-engage passes
 * the same gates a typed `kill` would: the quarry must be in the room, alive, and **visible through
 * the same watch set that gates every other line about an entity** — a mob that flees into darkness
 * is gone, not tracked through a wall.
 *
 * ## When the pointer dies
 *
 * Engaging anything (the pursuit itself, or any other fight) clears it — a new fight is a new story.
 * So does fleeing yourself: running away and keeping a claim on the kill would make `flee` a tactical
 * reposition rather than an escape, and Phase 14 built it to cost something. The pointer is *not*
 * cleared by distance or time: a chase through three rooms is still a chase, and `fleeChance`'s
 * ~20% failure per attempt plus `fleeCost` on nobody but players means the mob's escape is already
 * bounded by its own luck. It is not persisted — a pursuit is a moment, not a property.
 *
 * ## What this is not
 *
 * Not hunting. `hunt.ts` is a *mob* tracking a player through the room graph on a pursuit rule
 * harvested from the world; this is a player's own intent, one room at a time, on their own legs.
 * The mirror-image case — the player flees, the mob comes after — was already built (`beginHunt` at
 * the flee site) and is untouched.
 */

import type { EntityId } from '@mygame/shared';

import { incapacitated } from './combat.ts';
import { isMob, isPlayer, type Actor, type Player } from './sim.ts';

/**
 * Marks everyone a fleeing mob just escaped from as its pursuer.
 *
 * `changed` is `clearEngagements`' own list — the fleer and every actor whose pointer at it was
 * broken — so this walks exactly the people who were mid-swing when the target left. Players only:
 * a mob resuming a fight goes through the hunt machinery, which knows about pursuit rules, zone
 * bounds and give-up clocks that a player's own two feet do not need.
 */
export function markPursuers(fleer: Actor, changed: readonly Actor[]): void {
  if (!isMob(fleer)) return;
  for (const actor of changed) {
    if (isPlayer(actor) && actor.wasFighting === fleer.id) actor.pursuing = fleer.id;
  }
}

/**
 * The quarry to re-engage on arrival, or nothing.
 *
 * Deliberately answers with the actor rather than acting: the caller owns starting the fight,
 * because `startFight` carries the whole engagement discipline (stop-then-set, facing, the room
 * being told) and duplicating any of it here would be the drift §2 of the engagement design warns
 * about.
 *
 * `canSee` is injected rather than read, so the check is the *caller's* visibility gate — the same
 * watch set that decides every entity message — and so this function stays testable without a socket.
 */
export function pursuitTarget(
  lookup: { get(id: EntityId): Actor | undefined },
  player: Player,
  canSee: (id: EntityId) => boolean,
): Actor | undefined {
  const id = player.pursuing;
  if (id === undefined) return undefined;
  // Already fighting means the pointer is stale by definition — a fight in progress owns the player.
  if (player.fighting !== undefined) return undefined;
  const quarry = lookup.get(id);
  // Dead, despawned, or simply not here: the pointer stays for the next room, except when the body
  // is gone from the world entirely, where it can never fire again and is cleared to say so.
  if (!quarry || incapacitated(quarry)) {
    player.pursuing = undefined;
    return undefined;
  }
  if (quarry.roomId !== player.roomId) return undefined;
  if (!canSee(id)) return undefined;
  return quarry;
}
