/**
 * Where a character has been, as a graph of Places — V4.
 *
 * The `M` overview frames the Place you are standing on and there has never been a view of anywhere
 * else. This is that view, and `HANDOFF.md`'s first decision says what shape it is allowed to take:
 * worldgen normalises coordinates **per zone and per level**, so no two Places share a coordinate
 * space and 0 of 991 cross-zone exits are geometric neighbours. There is no plane to lay the world
 * out on. So it is a **graph** — nodes you have visited, edges you have walked — and any attempt to
 * draw it as a map would be inventing a geography the world does not have.
 *
 * ## Nothing here is stored
 *
 * A character already carries the only fact this needs: `seen`, a bitset per Place of every tile they
 * have had light fall on. A Place with any bit set is one they have been to. That means V4 adds **no
 * persisted field** — which matters more than it sounds, because every field of a saved shape needs a
 * reader line and a whole-value round-trip test, and the ones added carelessly are what the gotchas
 * list is made of.
 *
 * ## The edge rule is the honest part
 *
 * An edge needs **both of its rooms seen** — not one of them, and not "one room seen and the far
 * Place visited". That weaker rule was written first and a test killed it, which is worth recording
 * because it reads as sufficient and is not:
 *
 * - Standing in a room with a staircase tells you there is a staircase. It does not tell you what is
 *   at the top, so a link drawn from the near side alone hands over a destination nobody climbed to.
 * - And the far side leaks the same way in reverse. A character who has stood in the marsh and,
 *   separately, in the keep would be shown the passage joining them — because the marsh room they
 *   *did* see has an exit into a Place they *have* been. They never found that passage. The map would
 *   give it to them.
 *
 * Requiring both ends says exactly one thing: *you have stood on this side and on that side*. That is
 * what walking a link gives you, and it is all this may give you. It also needs no stored history —
 * `seen` already records it — which is why V4 adds no persisted field at all.
 */

import { placeKey, roomCentre, type Place, type PlaceEdge, type PlaceNode, type RoomId } from '@mygame/shared';
import { bitsetHas } from '@mygame/shared/vision.ts';

import type { GameWorld } from './world.ts';

/** What the graph builder needs of a character: their seen bitsets, by `placeKey`. */
export interface SeenMaps {
  readonly seen: ReadonlyMap<string, Uint8Array>;
}

/**
 * Whether this character has seen a room at all.
 *
 * **Its centre tile, rather than any tile of it.** A room is an 9x9 block and `relocate` puts every
 * arrival on or beside the centre, so the centre is seen by anybody who has stood there — while
 * "any tile" would count a corner glimpsed across a corridor from the room next door. The cheaper
 * test is also the stricter one, which is the right way round for a gate.
 *
 * Returns false when the Place has no grid or no bitset, which is the ordinary answer for somewhere
 * nobody has been.
 */
function hasSeenRoom(world: GameWorld, maps: SeenMaps, place: Place, roomId: RoomId): boolean {
  const bits = maps.seen.get(placeKey(place));
  if (!bits) return false;
  const grid = world.grid(place);
  const origin = grid?.roomOrigins.get(roomId);
  if (!grid || !origin) return false;
  const centre = roomCentre(origin);
  return bitsetHas(bits, centre.ty * grid.width + centre.tx);
}

/**
 * The graph this character may be shown.
 *
 * Built fresh on each Place change rather than cached: the loaded world is 23 Places and a character
 * has been to a handful, so the whole thing is a few dozen comparisons — far cheaper than keeping a
 * cache honest across authoring, deletion and a grid being re-carved underneath it.
 */
export function buildPlaceGraph(
  world: GameWorld,
  maps: SeenMaps,
  here: Place,
): { readonly nodes: readonly PlaceNode[]; readonly edges: readonly PlaceEdge[] } {
  const visited = new Set<string>();
  for (const [key, bits] of maps.seen) {
    if (bits.some((byte) => byte !== 0)) visited.add(key);
  }
  // **Always including where you are standing.** You may have arrived this instant, before a single
  // tile of the new Place has been folded into `seen` — and a map of where you have been that omits
  // where you are reads as broken rather than as precise.
  visited.add(placeKey(here));

  const nodes: PlaceNode[] = [];
  for (const place of world.allPlaces()) {
    const key = placeKey(place);
    if (!visited.has(key)) continue;
    const zone = world.zone(place.zone);
    if (!zone) continue;
    const rooms = zone.rooms.filter(
      (room) => room.pos.z === place.level && hasSeenRoom(world, maps, place, room.id),
    ).length;
    nodes.push({
      zone: place.zone,
      level: place.level,
      zoneName: world.zoneName(place.zone) ?? `zone ${place.zone}`,
      // At least the one you are standing in, for the same reason the node itself is forced.
      rooms: Math.max(rooms, samePlaceKey(key, here) ? 1 : 0),
    });
  }

  // Deduplicated by the unordered pair, because a doorway is one link however many exits describe it
  // and two rooms of the same Place may both lead to the same neighbour.
  const seenPairs = new Set<string>();
  const edges: PlaceEdge[] = [];
  for (const place of world.allPlaces()) {
    if (!visited.has(placeKey(place))) continue;
    const zone = world.zone(place.zone);
    if (!zone) continue;
    for (const room of zone.rooms) {
      if (room.pos.z !== place.level) continue;
      for (const [dir, exit] of Object.entries(room.exits)) {
        const far = world.locate(exit.to);
        if (!far || samePlaceKey(placeKey(far.place), place)) continue;
        // Both ends, and only both ends. Seeing the far room implies having been in its Place, so
        // there is no separate "is it visited" test to keep in step with this one.
        if (!hasSeenRoom(world, maps, place, room.id)) continue;
        if (!hasSeenRoom(world, maps, far.place, far.room.id)) continue;

        const pair = pairKey(place, far.place);
        if (seenPairs.has(pair)) continue;
        seenPairs.add(pair);
        edges.push({ a: place, b: far.place, via: dir as PlaceEdge['via'] });
      }
    }
  }

  return { nodes, edges };
}

function samePlaceKey(key: string, place: Place): boolean {
  return key === placeKey(place);
}

/** Unordered, so `36:9 ↔ 219:0` and `219:0 ↔ 36:9` are one link rather than two lines. */
function pairKey(a: Place, b: Place): string {
  const [first, second] = [placeKey(a), placeKey(b)].sort();
  return `${first}|${second}`;
}
