/**
 * The Place frame — one coordinate origin for everything the renderer draws. M3.
 *
 * `buildZoneTilemap` sizes a grid to *the rooms on one level*, so the tile origin of a room is
 * `(pos.x - bounds.minX) * stride` where the bounds are that level's own. Two levels of one zone
 * therefore have two different tile origins for the same cell coordinate, and the plan's §4.5
 * vertical policy — "render the player's level plus one below" — needs both drawn in **one** frame or
 * the level below appears offset by however far apart the two bounding boxes happen to start.
 *
 * So this file names the frame explicitly: the bounds, gap and stride of the level the camera is on,
 * and functions that place *any* room's cell coordinate into it. A room one level down is laid out
 * against the walked level's bounds, which is exactly the read the policy wants — the shaft below you
 * is under your feet, not beside them.
 *
 * The derivation is `buildZoneTilemap`'s, line for line, and deliberately so: `boundsOf` over the
 * rooms on the level, `SEAM_GAP` for a seamless zone and `ROOM_GAP` otherwise. Re-deriving it here
 * rather than reading it off the grid keeps the frame available for levels the grid was never built
 * for, and the test asserts the two agree on every room the grid does hold.
 *
 * ## Units
 *
 * One tile is one metre — that is `WORLD_SCALE = 1/32` and `TILE_SIZE = 32` meeting in the middle —
 * but the conversion is spelled out through both constants rather than assumed to be 1, so that
 * moving either moves the renderer with it instead of silently halving the world.
 */

import {
  ROOM_GAP,
  ROOM_TILES,
  SEAM_GAP,
  TILE_SIZE,
  WORLD_SCALE,
  boundsOf,
  type Zone,
} from '@mygame/shared';

/** Renderer metres per collision tile. One, today, and derived rather than written down as one. */
export const METRES_PER_TILE = TILE_SIZE * WORLD_SCALE;

/** A room block's side, in metres. Nine tiles. */
export const ROOM_METRES = ROOM_TILES * METRES_PER_TILE;

export interface PlaceFrame {
  /** The z the camera is standing on. Everything is drawn relative to this. */
  readonly level: number;
  /** Cell coordinate of the frame's origin — `boundsOf` over the rooms on {@link level}. */
  readonly minX: number;
  readonly minY: number;
  /** Tiles between adjacent room blocks: {@link SEAM_GAP} in a seamless zone, else {@link ROOM_GAP}. */
  readonly gap: number;
  /** `ROOM_TILES + gap`. The cell pitch, in tiles. */
  readonly stride: number;
  /** The bounding box, in tiles — the same numbers `buildZoneTilemap` gives the grid. */
  readonly widthTiles: number;
  readonly heightTiles: number;
}

export function placeFrame(zone: Zone, level: number): PlaceFrame {
  const rooms = zone.rooms.filter((room) => room.pos.z === level);
  const bounds = boundsOf(rooms);
  const gap = zone.seamless === true ? SEAM_GAP : ROOM_GAP;
  const stride = ROOM_TILES + gap;
  return {
    level,
    minX: bounds.minX,
    minY: bounds.minY,
    gap,
    stride,
    widthTiles: (bounds.maxX - bounds.minX + 1) * stride,
    heightTiles: (bounds.maxY - bounds.minY + 1) * stride,
  };
}

/** Tile-space origin (north-west corner) of the room block occupying a cell. */
export function cellOriginTiles(frame: PlaceFrame, cellX: number, cellY: number): { tx: number; ty: number } {
  return { tx: (cellX - frame.minX) * frame.stride, ty: (cellY - frame.minY) * frame.stride };
}

/** The cell a tile falls in, in **zone** cell coordinates — the ones `room.pos` speaks. */
export function cellOfTile(frame: PlaceFrame, tx: number, ty: number): { cellX: number; cellY: number } {
  return {
    cellX: Math.floor(tx / frame.stride) + frame.minX,
    cellY: Math.floor(ty / frame.stride) + frame.minY,
  };
}

/**
 * The cell a simulation position falls in.
 *
 * `EntityView.x/y` arrive as zone-grid **pixels** — the `x`/`y` doc comment on the protocol still
 * says "within the room cell, in tiles" and is wrong, which the plan's M7 notes and does not fix —
 * so the division by {@link TILE_SIZE} is the first thing that happens to every position the wire
 * carries.
 */
export function cellOfPixel(frame: PlaceFrame, px: number, py: number): { cellX: number; cellY: number } {
  return cellOfTile(frame, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE));
}

/** Metres east/south of the frame origin, from a simulation pixel position. */
export function metresOfPixel(px: number): number {
  return px * WORLD_SCALE;
}

/**
 * The inverse of {@link metresOfPixel} — simulation pixels from a metres position.
 *
 * Pointer click-to-move needs this: a pointer ray meets the ground in renderer metres, and the tile
 * it landed on, the `moveTo` it sends and the `seen` bitset it is gated on are all in simulation
 * pixels. `WORLD_SCALE` is `space.ts`'s (`@mygame/shared`) — this file cannot own the constant, only
 * the direction it runs, because the axis contract has to stay the one file every determinism check
 * agrees with (see `space.ts`'s own header). Division rather than a second stored reciprocal, because
 * a pointer click is once a frame at most and is nowhere near the budget that would justify it.
 */
export function pixelOfMetres(metres: number): number {
  return metres / WORLD_SCALE;
}

/** Metres east/south of the frame origin, from a tile coordinate. */
export function metresOfTile(tile: number): number {
  return tile * METRES_PER_TILE;
}
