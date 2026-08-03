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
  type RoomId,
} from '@mygame/shared';

/** One thing on the floor. */
export interface GroundItem {
  readonly id: EntityId;
  readonly item: Item;
  readonly roomId: RoomId;
  readonly place: Place;
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
): GroundItem {
  const dropped: GroundItem = {
    id: nextGroundId--,
    item,
    roomId: where.roomId,
    place: where.place,
    x: where.x,
    y: where.y,
    // Only when there is something in it: an empty container on the floor is an ordinary object, and
    // writing an empty `contents` on every dropped dagger says nothing.
    ...(held && held.contents.length > 0 ? { held } : {}),
  };
  ground.set(dropped.id, dropped);
  return dropped;
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
 * How this appears to a client.
 *
 * `kind: 'item'` puts it down the same path corpses already take — one image, no facing, no health
 * bar — so nothing in the renderer needed a new concept for objects on the floor.
 */
export function groundViewOf(entry: GroundItem, durisType?: number, isContainer = false): EntityView {
  return {
    id: entry.id,
    kind: 'item',
    name: entry.item.name,
    sprite: groundSprite(entry.item, durisType),
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
export function groundSprite(item: Item, durisType?: number): string {
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
