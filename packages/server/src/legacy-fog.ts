/**
 * The pre-v4 fog rule, kept alive for exactly one job: migrating a save written before visibility
 * became tile-granular.
 *
 * **Nothing new may use this.** It answers "which tiles did entering this room uncover", which is
 * the room-granular rule the tile model replaced — a *different* rule, not a coarser version of the
 * current one. It used to live on `TileGrid.reveal`, where it sat in front of anyone writing new
 * code and was built for every grid whether or not a legacy save ever appeared. It lives here
 * instead, under a name that says what it is, so that the day the `explored` field is dropped from
 * `StoredRecord` this file and `PlayerStore.migrateExplored` are deleted together and the rule
 * leaves the codebase entirely.
 *
 * The current rule is `computeVisible` unioned into a `seen` bitset. See `shared/src/vision.ts`.
 */

import {
  CONNECTOR_WIDTH,
  DIRECTION_DELTA,
  DIRECTIONS,
  ROOM_GAP,
  ROOM_TILES,
  type Room,
  type TileGrid,
} from '@mygame/shared';

/**
 * The tiles the old fog uncovered on first entering `room`: its own 9x9 floor block, plus the
 * corridor stubs carved out of it.
 *
 * Deliberately derived from the room's *exits* rather than by scanning the grid for walkable tiles
 * in the gap. Both sides of a two-way exit carve the same strip, so a scan would also hand back the
 * stub of a one-way exit pointing *into* this room — tiles the old model never revealed from here.
 * A migration must not grant ground the rule it is migrating from would have refused, so this walks
 * the same exits, in the same order, with the same offsets `buildZoneTilemap`'s `carve` uses.
 *
 * Rooms not on this grid — another level, another zone — return nothing, exactly as the old
 * per-grid reveal map did by omission.
 */
export function legacyRoomReveal(grid: TileGrid, room: Room): number[] {
  const origin = grid.roomOrigins.get(room.id);
  if (!origin) return [];

  const out: number[] = [];
  for (let dy = 0; dy < ROOM_TILES; dy++) {
    for (let dx = 0; dx < ROOM_TILES; dx++) {
      out.push((origin.ty + dy) * grid.width + origin.tx + dx);
    }
  }

  const offset = (ROOM_TILES - CONNECTOR_WIDTH) / 2;
  for (const dir of DIRECTIONS) {
    if (dir === 'up' || dir === 'down') continue;
    const exit = room.exits[dir];
    // Portals and links whose far side is not on this level were never corridors, so they never
    // revealed one — they are transitions, and appear as stair tiles instead.
    if (!exit || exit.portal || !grid.roomOrigins.has(exit.to)) continue;

    const [dx, dy] = DIRECTION_DELTA[dir];
    for (let step = 0; step < ROOM_GAP; step++) {
      for (let span = 0; span < CONNECTOR_WIDTH; span++) {
        const tx =
          dx !== 0
            ? dx > 0
              ? origin.tx + ROOM_TILES + step
              : origin.tx - 1 - step
            : origin.tx + offset + span;
        const ty =
          dx !== 0
            ? origin.ty + offset + span
            : dy > 0
              ? origin.ty + ROOM_TILES + step
              : origin.ty - 1 - step;
        if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) continue;
        out.push(ty * grid.width + tx);
      }
    }
  }
  return out;
}
