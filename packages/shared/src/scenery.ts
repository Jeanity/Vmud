/**
 * Scenery — the things that stand in a room.
 *
 * V8d, and the owner's ask on first walking the open square: *"we will have to think about adding
 * some scenery at some point, also a fountain or pothole or something like that, just for
 * atmosphere."* The Great Crossing's prose has promised a fountain and a plinth since Phase 23, and
 * until now the promise was only text.
 *
 * **A prop is a thing in the way.** That is the whole definition, and it is what separates scenery
 * from the decoration the client has drawn since V8a. Tile variants — the grass tufts, the cobble
 * mix, the scattered rock — are chosen by a hash of the coordinate and change nothing about the
 * room; they are paint, and paint can live in the client because it can never desync. A prop
 * occupies ground, so it is a rule, so it is here in `shared` where the server and every client
 * read one table and stamp the same tiles. Anything that would *not* be in the way does not belong
 * in this file.
 *
 * That rule is why there is no `solid` field. Every prop is solid; a non-solid prop is paint that
 * wandered into the wrong module.
 *
 * **Footprint and artwork are different rectangles**, and conflating them is the trap. `width` and
 * `depth` are the ground the prop stands on — the tiles that stop being walkable. `height` is how
 * tall the picture is, and it may exceed `depth`: a statue occupies one tile of floor and is drawn
 * two tiles tall, the upper one overhanging the ground *behind* it, which is how a three-quarter
 * view reads as having height at all. The art's bottom edge always sits on the footprint's bottom
 * edge, so `height - depth` is the overhang.
 *
 * This module is **deliberately import-free**: it is the catalogue and nothing else. Turning a prop
 * into tiles is geometry and lives in `tilemap.ts` ({@link tilemap.sceneryTile},
 * {@link tilemap.scenerySiting}), which imports this — one direction, no cycle, and the reason the
 * stamping code is not here beside the table it reads.
 *
 * @see `DESIGN-open-world.md` §V8d.
 */

/** Every prop the world knows how to stand up. The client keeps one image per name. */
export const SCENERY_KINDS = ['fountain', 'plinth', 'well', 'statue', 'cart', 'haystack'] as const;

export type SceneryKind = (typeof SCENERY_KINDS)[number];

export interface SceneryProp {
  /** Footprint east-west, in tiles. Also the width of one frame of the artwork. */
  readonly width: number;
  /** Footprint north-south, in tiles: the ground it stands on, and the ground you cannot cross. */
  readonly depth: number;
  /**
   * Artwork height in tiles, never less than {@link depth}. The picture's bottom edge sits on the
   * footprint's bottom edge, so any excess overhangs the ground behind the prop.
   */
  readonly height: number;
  /** Animation frames, laid left to right in the image file. 1 for a still prop. */
  readonly frames: number;
  /** Milliseconds a frame is held. Ignored when {@link frames} is 1. */
  readonly frameMs: number;
  /**
   * Stops sight as well as movement.
   *
   * Almost nothing here does. You see over a fountain's rim, a well's, a cart's sideboard and a
   * statue's shoulder — they are waist-high or narrow, and a plaza that went dark behind its own
   * furniture would be a worse lie than one you can see across. The hay bale is the exception:
   * three tiles of stacked straw is taller than the person looking at it.
   */
  readonly opaque: boolean;
}

/**
 * The catalogue.
 *
 * Sizes are measured from the artwork rather than chosen: each prop is a rectangular crop at the
 * source atlas's own 32px grid, so `width` and `height` are that crop in tiles and cannot drift
 * from the picture. `depth` is the only judgement — how much of the picture is standing on the
 * floor rather than rising above it.
 */
export const SCENERY: Readonly<Record<SceneryKind, SceneryProp>> = {
  /** Three frames of a jet rising and falling. The one prop that moves, and the one that was asked for. */
  fountain: { width: 2, depth: 2, height: 2, frames: 3, frameMs: 220, opaque: false },
  /** A stepped granite dais with a board bolted to it — the Great Crossing's noticeboard, made visible. */
  plinth: { width: 3, depth: 3, height: 3, frames: 1, frameMs: 0, opaque: false },
  well: { width: 2, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false },
  /** One tile of floor, two tiles of marble: the overhang case the `height` field exists for. */
  statue: { width: 1, depth: 1, height: 2, frames: 1, frameMs: 0, opaque: false },
  cart: { width: 2, depth: 2, height: 2, frames: 1, frameMs: 0, opaque: false },
  haystack: { width: 2, depth: 2, height: 3, frames: 1, frameMs: 0, opaque: true },
} as const;

/** A prop standing in a room, at a tile offset inside that room's own block. */
export interface RoomScenery {
  readonly kind: SceneryKind;
  /** Room-relative tile of the footprint's north-west corner. */
  readonly tx: number;
  /** Room-relative tile of the footprint's north-west corner. */
  readonly ty: number;
}

export function isSceneryKind(value: unknown): value is SceneryKind {
  return typeof value === 'string' && (SCENERY_KINDS as readonly string[]).includes(value);
}
