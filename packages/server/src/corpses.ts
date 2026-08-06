/**
 * Corpses: what a death leaves behind, and how long it lasts.
 *
 * ## A corpse is a place, not a body
 *
 * The dead actor is **removed from the simulation** and a corpse takes its position. That is not
 * bookkeeping tidiness — it is what stops every other system having to ask "is this one actually alive?"
 * The hunt, the threat table, perception and the combat round all iterate actors, and a corpse left in
 * that list as an actor with `status: 'dead'` would need a guard in each of them, one of which would be
 * forgotten. `canBeAttacked` already refuses a dead body; removing it means nothing has to.
 *
 * ## Ground pickups were the model, and it only half fits
 *
 * `pickups.ts` derives its objects from the grid: one per room, deterministic, negative entity ids that
 * are stable across restarts because they are computed from the room id. A corpse is the opposite on
 * every count — it is *created* by an event, several can share a room, and it is gone in a few minutes.
 * So it gets its own store and its own id space, and only the wire shape is shared: a corpse reaches a
 * client as `EntityView` with `kind: 'item'`, exactly like a torch on the floor, so the renderer needed
 * no new case.
 */

import {
  TILE_SIZE,
  carry,
  type EntityId,
  type EntityView,
  type Inventory,
  type Item,
  type Place,
  type RoomId,
} from '@mygame/shared';

import { keywordsFromName } from './commands.ts';
import type { Actor } from './sim.ts';

/* -------------------------------------------------------------------------- */
/* Decay                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How long a corpse lasts.
 *
 * Duris decays an NPC corpse in a handful of MUD ticks and a *player's* far more slowly, and the
 * asymmetry is the whole point: a mob's corpse is loot you either take now or lose, while a player's is
 * a retrieval problem that has to survive them walking back across a zone. Ours are the same shape —
 * five minutes against thirty — chosen so the walk back is a real journey and not a hopeless one.
 */
export const CORPSE_DECAY_MS = 5 * 60_000;
export const PLAYER_CORPSE_DECAY_MS = 30 * 60_000;

/** How long before it goes that a corpse starts visibly falling apart, for the log's warning. */
export const CORPSE_WARN_MS = 60_000;

/* -------------------------------------------------------------------------- */
/* The thing itself                                                            */
/* -------------------------------------------------------------------------- */

export interface Corpse {
  readonly id: EntityId;
  /** Who this used to be — "a sentry", "Halvard55". */
  readonly of: string;
  /** Whether it was a player's. Decides the decay clock and whether it may be looted by others. */
  readonly wasPlayer: boolean;
  readonly roomId: RoomId;
  readonly place: Place;
  readonly x: number;
  readonly y: number;
  /**
   * What is in it. Phase 15b, and the thing Phase 13 built the corpse to eventually hold.
   *
   * Mutable, because looting takes from it a piece at a time and a full bag leaves the rest behind.
   */
  contents: Item[];
  /**
   * Whether it has been emptied.
   *
   * **Drives the sprite**, which is the point: a picked-clean corpse is drawn as a single bone rather
   * than a pile, so "has anyone been here" is answerable from across the room without walking over and
   * looking. That is the owner's rule and it is a good one — it makes a corridor of corpses readable.
   *
   * Since 15b this means *empty* rather than *searched*. The difference shows up exactly where it
   * matters: a body holding three things that you could only carry two of stays drawn as a pile, so the
   * one thing still in it is not hidden behind a sprite that says "nothing here".
   */
  looted: boolean;
  /** Milliseconds left before it goes. */
  remainingMs: number;
  /** Set once the "starting to rot" line has been said, so it is said once. */
  warned: boolean;
}

/** Every corpse currently lying about, by entity id. */
export type Graveyard = Map<EntityId, Corpse>;

/**
 * Ids for corpses.
 *
 * **Negative, like a pickup's, and for the same reason** — `Simulation` hands out ids from 1 upward, so
 * the two spaces cannot collide by arithmetic rather than by a base constant chosen to be big enough.
 * Distinguished from a pickup's id by being *even*: a pickup is `-(roomId + 1)` and could be either, so
 * corpses take a counter of their own stepped by two and offset, which keeps every corpse id out of the
 * range any room id could produce.
 */
const CORPSE_ID_BASE = -1_000_000;
let nextCorpseId = CORPSE_ID_BASE;

export function resetCorpseIds(): void {
  nextCorpseId = CORPSE_ID_BASE;
}

/**
 * Turns a fallen actor into a corpse.
 *
 * Takes the position off the body rather than the room's centre, so a corpse lies where it fell. That is
 * worth the two lines: a fight that ranged across a room leaves its dead spread across it, and walking
 * back to a specific corpse is a Phase 13 mechanic rather than a formality.
 *
 * `contents` is what the dead were carrying. A body with nothing in it is `looted` from the moment it
 * falls, so a mob that drops nothing is drawn as a picked-clean corpse immediately — which is true, and
 * saves a player the walk over to find out.
 */
export function makeCorpse(yard: Graveyard, actor: Actor, wasPlayer: boolean, contents: readonly Item[] = []): Corpse {
  const corpse: Corpse = {
    id: nextCorpseId--,
    of: actor.name,
    wasPlayer,
    roomId: actor.roomId,
    place: actor.place,
    x: actor.x,
    y: actor.y,
    contents: [...contents],
    looted: contents.length === 0,
    remainingMs: wasPlayer ? PLAYER_CORPSE_DECAY_MS : CORPSE_DECAY_MS,
    warned: false,
  };
  yard.set(corpse.id, corpse);
  return corpse;
}

/** How a corpse reads in a sentence. Duris' own phrasing, which is hard to improve on. */
export function corpseName(corpse: Corpse): string {
  return `the corpse of ${corpse.of}`;
}

/**
 * The sprite key a corpse is drawn with — **the owner's looted-state rule**.
 *
 * A fresh corpse is a pile of bones; a looted one is a single bone, so it reads as picked clean from
 * across the room. Two keys rather than a flag on the view because the client resolves sprites through
 * one lookup with a fallback, so a new corpse state is a new texture and no new branch.
 */
export function corpseSprite(corpse: Corpse): string {
  return corpse.looted ? 'corpse_looted' : 'corpse';
}

export function corpseViewOf(corpse: Corpse): EntityView {
  return {
    id: corpse.id,
    kind: 'item',
    name: corpseName(corpse),
    sprite: corpseSprite(corpse),
    x: corpse.x,
    y: corpse.y,
    // Corpses do not face anywhere. `south` is the resting value every `EntityView` carries and the
    // client ignores it for an item, which has no sheet rows to pick between.
    facing: 'south',
    healthFraction: 0,
    level: 0,
    posture: 'prone',
    status: 'dead',
  };
}

/* -------------------------------------------------------------------------- */
/* Looting                                                                     */
/* -------------------------------------------------------------------------- */

/** Why a loot attempt was refused, or `undefined` if it was allowed. */
export type LootRefusal = 'gone' | 'not-here' | 'someone-elses';

/**
 * Whether this character may take from this corpse.
 *
 * **A player's corpse is theirs unless PvP is switched on** — owner's rule (2026-08-03): *"we should
 * not be able to loot other players' corpses as this is not a pkill game"*, with an operator switch
 * for the evenings when it is. See `settings.ts` for why the switch is a file.
 *
 * The flag is passed in rather than read here, because this file is pure and the switch is I/O. That
 * also means the refusal and the attack gate cannot drift apart: both take the same boolean from the
 * one place that loads it.
 */
export function lootRefusal(corpse: Corpse | undefined, looter: Actor, pvp = false): LootRefusal | undefined {
  if (!corpse) return 'gone';
  if (corpse.roomId !== looter.roomId) return 'not-here';
  if (!pvp && corpse.wasPlayer && corpse.of !== looter.name) return 'someone-elses';
  return undefined;
}

/** What a search of a body actually moved. */
export interface LootResult {
  /** What went into the bag, in the order it came out. */
  readonly taken: readonly Item[];
  /** What would not fit and is still lying in the corpse. */
  readonly left: readonly Item[];
  readonly inventory: Inventory;
}

/**
 * Empties a corpse into a bag, as far as the bag allows. **Mutates the corpse**; returns the new bag.
 *
 * Phase 15b, replacing the flag-flip Phase 13 shipped when there was nothing in the world to transfer.
 *
 * ## It takes what fits and leaves the rest, rather than refusing
 *
 * The alternative — refuse the whole search because one thing would not fit — is the behaviour that
 * makes a player empty their bag on the floor to loot a body and then discover they cannot pick their
 * own kit back up. Duris' `get all` is per-item for the same reason. Each item is offered to the bag in
 * turn and the ones that do not fit stay where they are, so a corpse is a place you can come back to.
 *
 * **A larger item can be skipped and a smaller one behind it still taken**, because each is asked
 * separately. That is not an accident of the loop: stopping at the first refusal would make what you
 * got depend on the order somebody died holding things.
 */
export function lootCorpse(corpse: Corpse, bag: Inventory): LootResult {
  const taken: Item[] = [];
  const left: Item[] = [];
  let inventory = bag;
  for (const item of corpse.contents) {
    const result = carry(inventory, item);
    if ('stacks' in result) {
      inventory = result;
      taken.push(item);
    } else {
      left.push(item);
    }
  }
  corpse.contents = left;
  // Emptiness is the flag, so a body still holding the one thing you could not carry stays drawn as a
  // pile. See {@link Corpse.looted}.
  corpse.looted = left.length === 0;
  return { taken, left, inventory };
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                   */
/* -------------------------------------------------------------------------- */

export interface CorpseEvent {
  readonly corpse: Corpse;
  readonly kind: 'rotting' | 'gone';
}

/**
 * Ages every corpse, and reports the ones that changed.
 *
 * The warning is a latch on the corpse rather than a comparison the caller repeats, the same shape the
 * carried light's warning uses — a countdown that announces itself every tick is a nag, and one that
 * announces itself never is a corpse that vanishes without explanation while you are walking back to it.
 *
 * **A `gone` event still carries its `contents`**, and the caller must spill them onto the floor. The
 * roadmap is explicit about why: a corpse that took its loot with it destroys a reward because a player
 * was slow rather than because anything they did, and *"I came back and it was gone"* is a different and
 * worse feeling from *"somebody else got there first"*. The spill is not done here because this file has
 * no ground store and should not grow one — see `ground.ts`.
 */
export function advanceCorpses(yard: Graveyard, elapsedMs: number): CorpseEvent[] {
  const events: CorpseEvent[] = [];
  for (const [id, corpse] of yard) {
    corpse.remainingMs -= elapsedMs;
    if (corpse.remainingMs <= 0) {
      yard.delete(id);
      events.push({ corpse, kind: 'gone' });
      continue;
    }
    if (!corpse.warned && corpse.remainingMs <= CORPSE_WARN_MS) {
      corpse.warned = true;
      events.push({ corpse, kind: 'rotting' });
    }
  }
  return events;
}

/** Corpses lying in one room. */
export function corpsesIn(yard: Graveyard, roomId: RoomId): Corpse[] {
  const out: Corpse[] = [];
  for (const corpse of yard.values()) if (corpse.roomId === roomId) out.push(corpse);
  return out;
}

/** Whether a character is standing close enough to reach one. Loot is a room action, so this is generous. */
export function withinReach(corpse: Corpse, x: number, y: number): boolean {
  return Math.hypot(corpse.x - x, corpse.y - y) <= TILE_SIZE * 3;
}

/**
 * Whether a word names this body — the one rule every corpse verb matches on.
 *
 * Shared rather than written per verb, because `loot sentry`, `get axe corpse` and anything after them
 * disagreeing about which body a word means is a way to rob a corpse the other verb protects.
 *
 * **Three ways to name one, in widening order.** The dead thing's own keywords, so `loot sentry` works on
 * *the corpse of a sentry* without the phrase being typed. A substring of its name, so `loot kobold`
 * finds *a kobold wet nurse*. And the bare word **`corpse`**, which names any of them — what somebody
 * standing over a single body actually types, and which the name match alone cannot answer, since `of`
 * holds the dead thing's name and never the word "corpse".
 *
 * Takes the raw word and lowercases it here: every caller had trimmed and lowered its own copy, which is
 * three chances for one of them to stop doing it.
 */
export function corpseAnswersTo(corpse: Corpse, word: string): boolean {
  const wanted = word.trim().toLowerCase();
  if (!wanted) return true;
  if (wanted === 'corpse') return true;
  if (keywordsFromName(corpse.of).some((k) => k === wanted)) return true;
  return corpse.of.toLowerCase().includes(wanted);
}

/**
 * Which of several bodies a `loot` means: **the nearest one still worth searching**.
 *
 * Owner's rule (2026-08-02). A corpse lies where it fell, so a fight against three guards leaves three
 * of them scattered across the floor — and taking whichever the graveyard happened to store first meant
 * `loot` twice running searched the same body twice while the one at your feet stayed untouched.
 *
 * Two keys in order: **unlooted before looted**, then distance. Emptied bodies stay in the running
 * rather than being filtered out, so a room holding nothing else still resolves to one and the caller
 * can answer *"already picked clean"* — a different and far more useful line than "there is nothing here
 * to loot" while a corpse is plainly visible.
 */
export function nearestLootable(candidates: readonly Corpse[], x: number, y: number): Corpse | undefined {
  let best: Corpse | undefined;
  for (const corpse of candidates) {
    if (!best) {
      best = corpse;
      continue;
    }
    if (best.looted !== corpse.looted) {
      if (best.looted) best = corpse;
      continue;
    }
    if (Math.hypot(corpse.x - x, corpse.y - y) < Math.hypot(best.x - x, best.y - y)) best = corpse;
  }
  return best;
}
