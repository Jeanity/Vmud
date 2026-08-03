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

import { TILE_SIZE, type EntityId, type EntityView, type Item, type Place, type RoomId } from '@mygame/shared';

/** One thing on the floor. */
export interface GroundItem {
  readonly id: EntityId;
  readonly item: Item;
  readonly roomId: RoomId;
  readonly place: Place;
  /** Where it lies, in room pixels — a dropped thing lands at your feet, not at the room's centre. */
  readonly x: number;
  readonly y: number;
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
): GroundItem {
  const dropped: GroundItem = {
    id: nextGroundId--,
    item,
    roomId: where.roomId,
    place: where.place,
    x: where.x,
    y: where.y,
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
export function groundViewOf(entry: GroundItem): EntityView {
  return {
    id: entry.id,
    kind: 'item',
    name: entry.item.name,
    sprite: groundSprite(entry.item),
    x: entry.x,
    y: entry.y,
    facing: 'south',
    healthFraction: 0,
    level: 0,
    posture: 'prone',
    status: 'dead',
  };
}

/**
 * Which floor sprite an item draws as.
 *
 * By **slot** rather than by item id, so a new garment inherits a sensible look without anybody
 * remembering to add it here. The client's item textures are generated shapes rather than art (see
 * `makeItemTextures`), which is honest for now: a leather tunic on the floor is a bundle, and drawing
 * it as anything more specific would need art the pack does not have at this size.
 */
export function groundSprite(item: Item): string {
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
): GroundItem | undefined {
  const wanted = word.trim().toLowerCase();
  const matches = candidates.filter(
    (entry) =>
      !wanted ||
      entry.item.id === wanted ||
      entry.item.name.toLowerCase().split(/[^a-z0-9]+/).includes(wanted),
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
