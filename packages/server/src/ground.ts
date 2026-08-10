/**
 * Things lying on the floor: dropped, spilled from a corpse, or put down on purpose.
 *
 * Phase 15b, and the roadmap is explicit that this must be a **new store rather than an extension of
 * `pickups.ts`**. Those two look alike and are opposites on every count:
 *
 * | | `pickups.ts` | here |
 * | --- | --- | --- |
 * | Where it comes from | derived from `scatterSeed(roomId)` | created by an event |
 * | How many per room | exactly one | as many as have been dropped |
 * | Its entity id | **is** `-(roomId + 1)` | a counter of its own |
 * | Being taken | recorded per character | the object is removed |
 * | Placed at run time | never | always |
 *
 * A deterministic scatter cannot represent a thing that was put somewhere, and bending it into one
 * would cost the property that makes it good: that every client derives the same scatter from the
 * same seed without being told. So the scatter stays exactly as it is, for what it is good at, and
 * this file takes the shape `corpses.ts` already proved — own store, own ids, entities that come and
 * go.
 *
 * ## Ids
 *
 * Negative, like both of the others, so `Simulation`'s ids (from 1 upward) cannot collide by
 * arithmetic rather than by a constant chosen to be big enough. The three spaces are kept apart by
 * range rather than by parity: pickups reach about −97,000 (the largest room id), corpses start at
 * −1,000,000, and these start at −2,000,000. Room ids would have to grow twentyfold before anything
 * met anything.
 */

import {
  DURIS_ITEM,
  TILE_SIZE,
  wordsFromName,
  type EntityId,
  type EntityView,
  type Held,
  type Item,
  type Place,
  type Rng,
  type RoomId,
} from '@mygame/shared';

/**
 * How long a dropped thing lies there before it goes.
 *
 * **Ours, and there is nothing to transcribe** — Duris does not decay dropped objects at all.
 * `ITEM_TIMER` is bit 26 of `extra_flags` and `defines.h:125` says it is *"used chiefly to load/activate
 * traps"*, while the `timer` `point_update` increments (`limits.c:1649`) is a **character** idle
 * counter. So the number is a design decision, and the only honest anchor is our own corpse clock.
 *
 * Ten minutes sits deliberately between the two we already have: **twice a mob's corpse** (5 min),
 * because you *chose* to put this down and that deserves more than something which merely fell, and
 * **a third of a player's** (30 min), which is a disaster you are running back to rather than an
 * errand you meant to return for.
 *
 * **The reason to have a clock at all is not tidiness.** `reset.ts` caps object instances world-wide
 * and the census counts what is lying on floors and inside floor containers — so a room ankle-deep in
 * discards quietly holds a zone's repop at its ceiling, and the sword nobody picked up is the reason
 * the table upstairs has none. Clutter is the symptom; a zone that stops repopulating is the cost.
 */
export const GROUND_DECAY_MS = 10 * 60_000;

/** How long before it goes that a dropped thing starts to look like it is going. */
export const GROUND_WARN_MS = 60_000;

/** One thing on the floor. */
export interface GroundItem {
  readonly id: EntityId;
  readonly item: Item;
  readonly roomId: RoomId;
  readonly place: Place;
  /**
   * Milliseconds left before it goes — see {@link GROUND_DECAY_MS}.
   *
   * Mutable, like a corpse's, and for the same reason: the clock is *state* while everything else
   * here is what the thing is. **Restarting on a pickup-and-drop is deliberate and costs nothing to
   * defend**, because the floor is not persisted: a restart clears it entirely, so there is no
   * long-lived object whose age a player could game. If `ground.ts` ever gains a save file, this is
   * the line that has to be thought about again.
   */
  remainingMs: number;
  /**
   * How little time left counts as "starting to go".
   *
   * Per item rather than a bare constant so it can scale with a shortened clock: the shipped
   * behaviour is the constant (ten minutes, warn at one), but `GAME_DEV_DECAY_MS=4000` would
   * otherwise warn before the thing had finished landing. Half the clock, capped at the constant.
   */
  readonly warnAtMs: number;
  /** Latched, so the warning is said once rather than every tick. */
  warned: boolean;
  /** Where it lies, in room pixels — a dropped thing lands at your feet, not at the room's centre. */
  readonly x: number;
  readonly y: number;
  /**
   * What it holds, if it is a container with anything in it — `DESIGN-inventory.md` §4.
   *
   * **A sack you put down is still full.** Without this the floor could only hold bare items, so
   * dropping a quiver of twenty arrows destroyed the arrows and left the quiver: the same silent loss
   * `readInventory` had, one store over. Absent on the sixteen thousand things that are not containers,
   * and on the empty ones.
   */
  readonly held?: Held;
}

/** Everything currently on the floor anywhere, by entity id. */
export type Ground = Map<EntityId, GroundItem>;

const GROUND_ID_BASE = -2_000_000;
let nextGroundId = GROUND_ID_BASE;

/** Resets the counter. Tests only — a live server never rewinds ids. */
export function resetGroundIds(): void {
  nextGroundId = GROUND_ID_BASE;
}

/**
 * Puts something on the floor at a position.
 *
 * Takes the position from the caller rather than the room's centre for the reason a corpse does: a
 * thing dropped mid-room lies mid-room, and walking back to a specific one is then a real act.
 */
export function dropItem(
  ground: Ground,
  item: Item,
  where: { roomId: RoomId; place: Place; x: number; y: number },
  /** What it holds. Passed straight through, so putting a full quiver down and taking it back is a
   * round trip rather than a way to destroy arrows. */
  held?: Held,
  /** How long it lies there. Defaults to the shipped clock; `GAME_DEV_DECAY_MS` shortens it. */
  decayMs: number = GROUND_DECAY_MS,
): GroundItem {
  const dropped: GroundItem = {
    id: nextGroundId--,
    item,
    roomId: where.roomId,
    place: where.place,
    x: where.x,
    y: where.y,
    remainingMs: decayMs,
    warnAtMs: Math.min(GROUND_WARN_MS, decayMs / 2),
    warned: false,
    // Only when there is something in it: an empty container on the floor is an ordinary object, and
    // writing an empty `contents` on every dropped dagger says nothing.
    ...(held && held.contents.length > 0 ? { held } : {}),
  };
  ground.set(dropped.id, dropped);
  return dropped;
}

export interface GroundEvent {
  readonly entry: GroundItem;
  readonly kind: 'fading' | 'gone';
}

/**
 * Ages everything on the floor, and reports what changed.
 *
 * `advanceCorpses`' shape exactly, down to the latched warning — a countdown that announces itself
 * every tick is a nag, and one that never announces itself is a thing that vanishes with no
 * explanation while somebody is walking back for it.
 *
 * **A `gone` event carries what it held**, and the caller must decide what happens to a container's
 * contents. The corpse rule is the precedent and points the same way: destroying what was inside
 * because a player was slow is *"I came back and it was gone"*, which is the worse feeling. Spilling
 * is not done here because this file has no view of the room.
 */
export function advanceGround(ground: Ground, elapsedMs: number): GroundEvent[] {
  const events: GroundEvent[] = [];
  for (const [id, entry] of ground) {
    entry.remainingMs -= elapsedMs;
    if (entry.remainingMs <= 0) {
      ground.delete(id);
      events.push({ entry, kind: 'gone' });
      continue;
    }
    if (!entry.warned && entry.remainingMs <= entry.warnAtMs) {
      entry.warned = true;
      events.push({ entry, kind: 'fading' });
    }
  }
  return events;
}

/** Takes it off the floor. Returns what was there, or nothing if somebody else got it first. */
export function takeItem(ground: Ground, id: EntityId): GroundItem | undefined {
  const found = ground.get(id);
  if (found) ground.delete(id);
  return found;
}

export function itemsIn(ground: Ground, roomId: RoomId): GroundItem[] {
  const out: GroundItem[] = [];
  for (const entry of ground.values()) if (entry.roomId === roomId) out.push(entry);
  return out;
}

/**
 * The same list, minus anything nobody has found yet — `ITEM_SECRET`, and what `search` is for.
 *
 * **Every player-facing path uses this one**; `itemsIn` stays raw for the two callers that must see
 * everything, which are the search itself and the operator's panel. The split matters more than it
 * looks: a hidden needle that stayed in the room view would be drawn on the floor by the client,
 * answer to `get needle`, and be listed by `look` — three different ways of handing over the thing
 * the player was supposed to have to look for.
 */
export function visibleItemsIn(ground: Ground, roomId: RoomId): GroundItem[] {
  return itemsIn(ground, roomId).filter((entry) => entry.item.hidden !== true);
}

/**
 * How this appears to a client.
 *
 * `kind: 'item'` puts it down the same path corpses already take — one image, no facing, no health
 * bar — so nothing in the renderer needed a new concept for objects on the floor.
 */
export function groundViewOf(entry: GroundItem, durisType?: number, isContainer = false, art?: string): EntityView {
  return {
    id: entry.id,
    kind: 'item',
    name: entry.item.name,
    // Injected like the type and the container flag, and for the same reason each of those is: the
    // catalogue is not this file's business.
    sprite: groundSprite(entry.item, durisType, art),
    x: entry.x,
    y: entry.y,
    facing: 'south',
    healthFraction: 0,
    level: 0,
    posture: 'prone',
    status: 'dead',
    // Injected like the type, and for the same reason: the catalogue is not this file's business. A
    // container that already holds something is one whatever the caller believes, which is what keeps
    // a sack still standing after its catalogue entry is edited out from under it.
    ...(isContainer || entry.held ? { container: true as const } : {}),
  };
}

/**
 * Which floor sprite an item draws as.
 *
 * **By Duris' own item type where we know it, falling back to the wear slot.** Owner's point
 * (2026-08-03): *"not everyone reads every description"* — a thing on the floor has to be noticeable
 * and identifiable at a glance, or it may as well not be there. Two generic blobs across a catalogue
 * of 16,421 items made every floor look the same.
 *
 * The type is passed in rather than looked up, because this file has no business holding the
 * catalogue — the same injection the reset census uses. Absent (the authored starter kit, which has no
 * vnum) it falls back to the slot, which is what shipped in 15b.
 *
 * These are generated shapes rather than art, and that is still honest: a colour and a silhouette is
 * enough to say *sword* apart from *flask* apart from *coin*, which is the job. Real per-item art is
 * an LPC gap and Phase 16's.
 */
export function groundSprite(item: Item, durisType?: number, art?: string): string {
  // **A7d. Authored art wins over the category placeholder.** The nine `item_*` sprites below are a
  // *taxonomy* — this is a weapon, this is a container — and they were always the stopgap: 16,421
  // catalogue entries share nine pictures between them. An item somebody chose a sheet for has a
  // real picture available, and the id is already the client's texture key (A7b), so saying it here
  // costs nothing on the wire and needs no protocol change.
  //
  // Deliberately *only* where art was authored. The placeholder is not retired, it is demoted: an
  // item nobody has dressed still reads as the kind of thing it is, which is better than a blank.
  if (art) return art;
  switch (durisType) {
    case DURIS_ITEM.weapon:
    case DURIS_ITEM.fireweapon:
      return 'item_weapon';
    case DURIS_ITEM.missile:
      return 'item_missile';
    case DURIS_ITEM.armor:
    case DURIS_ITEM.shield:
      return 'item_armour';
    case DURIS_ITEM.container:
    case DURIS_ITEM.quiver:
    case DURIS_ITEM.scabbard:
    case DURIS_ITEM.storage:
      return 'item_container';
    case DURIS_ITEM.potion:
    case DURIS_ITEM.drinkcon:
      return 'item_flask';
    case DURIS_ITEM.scroll:
    case DURIS_ITEM.book:
    case DURIS_ITEM.spellbook:
      return 'item_scroll';
    case DURIS_ITEM.wand:
    case DURIS_ITEM.staff:
      return 'item_wand';
    case DURIS_ITEM.money:
    case DURIS_ITEM.treasure:
      return 'item_coin';
    case DURIS_ITEM.key:
      return 'item_key';
    case DURIS_ITEM.food:
      return 'item_food';
    case DURIS_ITEM.light:
      return 'item_light';
    default:
      break;
  }
  // No type — an authored item. 15b's rule.
  if (item.slot === 'mainHand' || item.slot === 'offHand') return 'item_weapon';
  return 'item_bundle';
}

/**
 * How far apart two things on the floor have to be to read as two things.
 *
 * A tile. The sprites are 64 px drawn at this scale and a pile sharing one tile renders as one
 * object with a fringe — which is exactly what the owner reported (2026-08-05) after A7d gave items
 * real pictures: *"if we can avoid stacking items that would be good."*
 */
const GROUND_SPACING = TILE_SIZE;

/** How far a dropped thing lands from the dropper, in tiles. Owner's numbers, 2026-08-05. */
const DROP_MIN_TILES = 1;
const DROP_MAX_TILES = 2;

/**
 * Where a dropped thing lands: **one to two tiles away, in a random direction**.
 *
 * Owner's rule (2026-08-05), and the reasoning is theirs: *"if we are going to make it that we need
 * to be close to pick it up, have it drop the item 1-2 tiles from the dropper in a random
 * direction."* The two halves lock together — {@link withinPickupReach} is **three** tiles, so
 * anything thrown down inside two is still inside arm's reach and cannot be dropped somewhere you
 * then have to walk to.
 *
 * It replaced dropping at the dropper's own feet, which stacked: A7d gave items real pictures and
 * three things on one tile immediately read as one object with a fringe.
 *
 * **Seeded, never `Math.random`** — `CLAUDE.md` rule 3. A drop is simulation, so two clients must
 * agree about where the sword went and a restart must reproduce it.
 *
 * The candidate is rejected and re-rolled if it lands on another item or off the walkable floor;
 * after the bound it takes the dropper's own position rather than refusing. A floor too crowded to
 * find a gap is a worse problem than a stack, and a refused drop would strand the item in a bag
 * somebody is trying to empty.
 */
export function dropSpotNear(
  ground: Ground,
  roomId: RoomId,
  x: number,
  y: number,
  rng: Rng,
  /** Whether a point is floor a thing can rest on. Injected — the tile grid is not this file's. */
  canRest: (px: number, py: number) => boolean,
): { x: number; y: number } {
  const taken = itemsIn(ground, roomId);
  const clear = (px: number, py: number): boolean =>
    canRest(px, py) && taken.every((entry) => Math.hypot(entry.x - px, entry.y - py) >= GROUND_SPACING);

  for (let attempt = 0; attempt < 12; attempt++) {
    const angle = rng() * Math.PI * 2;
    const distance = TILE_SIZE * (DROP_MIN_TILES + rng() * (DROP_MAX_TILES - DROP_MIN_TILES));
    const px = x + Math.cos(angle) * distance;
    const py = y + Math.sin(angle) * distance;
    if (clear(px, py)) return { x: px, y: py };
  }
  return { x, y };
}

/** Close enough to pick up — the same three tiles a corpse may be searched from. */
export function withinPickupReach(entry: GroundItem, x: number, y: number): boolean {
  return Math.hypot(entry.x - x, entry.y - y) <= TILE_SIZE * 3;
}

/**
 * Which of several things a bare `get <word>` means: **the nearest one whose name matches**.
 *
 * The same rule `nearestLootable` uses, and for the same reason — a fight leaves things scattered, so
 * "the one at your feet" is what a player means and what the floor can answer.
 */
export function nearestMatching(
  candidates: readonly GroundItem[],
  word: string,
  x: number,
  y: number,
  /**
   * The words each item answers to. Injected exactly as {@link matchInventory}'s is and for the same
   * reason: the authored keyword lists live in the catalogue, and this store has no business holding
   * one. Defaults to the display-name split so a bare call keeps 15b's behaviour.
   */
  wordsOf: (item: Item) => readonly string[] = (item) => wordsFromName(item.name),
): GroundItem | undefined {
  const wanted = word.trim().toLowerCase();
  const matches = candidates.filter(
    (entry) => !wanted || entry.item.id === wanted || wordsOf(entry.item).includes(wanted),
  );
  let best: GroundItem | undefined;
  let bestDistance = Infinity;
  for (const entry of matches) {
    const distance = Math.hypot(entry.x - x, entry.y - y);
    if (distance >= bestDistance) continue;
    best = entry;
    bestDistance = distance;
  }
  return best;
}
