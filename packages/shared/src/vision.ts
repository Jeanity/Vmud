/**
 * Tile-granular visibility: light radius, line of sight, and the persistent `seen` bitset.
 *
 * This lives in `shared` for the same reason `stepMovement` does: the server computes visibility to
 * decide what a character has *seen* (which gates click-to-move and is persisted), and the client
 * computes it every frame from its predicted position to decide what is *lit* right now. If the two
 * used different algorithms the lit edge would shimmer against the ground the server will actually
 * let you walk on. One implementation, both sides.
 *
 * ## Two pieces of state, and they are not the same thing
 *
 * - **`visible`** — {@link computeVisible}. Recomputed from the current position. Transient, never
 *   stored, cheap enough to run per tick and per frame.
 * - **`seen`** — the union of every `visible` set so far, per character per Place, held as a bitset
 *   over tile indices. Persistent, server-owned, shipped as base64 (`seen`) then as index deltas
 *   (`seenDelta`).
 *
 * Conflating them is the main way this goes wrong: `seen` must never be recomputed from a position,
 * and `visible` must never be accumulated.
 *
 * ## What is remembered
 *
 * Terrain only. `seen` is a property of the map, not of its contents — a mob that wanders into a
 * remembered room while you are away is not drawn until light falls on it again. Nothing in this
 * module knows about entities, and that is deliberate.
 *
 * ## Light radius is a stat, not a constant
 *
 * {@link DEFAULT_LIGHT_RADIUS} is the *bare* radius, what you see with no light source at all. Every
 * caller takes the radius as an argument, sourced from `SelfView.lightRadius`, so a torch, a spell,
 * a cursed item or a darkness-suppressing zone all work by changing one number.
 */

import { Tile, tileAt, type TileGrid } from './tilemap.ts';

/**
 * The radius a character sees with no light source, in tiles.
 *
 * Deliberately tight: a 5x5 lit patch inside a 9x9 room means you must walk toward each wall to find
 * its exits, which is what makes the first torch a real upgrade rather than a rounding error. Light
 * is an early progression axis, so this is a floor to build on, not a tuning constant to sprinkle
 * through rendering code.
 */
export const DEFAULT_LIGHT_RADIUS = 2;

/**
 * Whether a tile stops light.
 *
 * Void, and a door that is **shut**. A shut door is a wall in every other respect — `isWalkable`
 * refuses it, the pathfinder will not route through it — and a wall you can see straight through is
 * the one combination that reads as a rendering fault rather than as a rule. It would also be a
 * quietly unfair one: `seen` is permanent, so light spilling through a barred gate would bank the
 * room behind it forever, and the player would then be told "you cannot find a way through to there"
 * about ground they are watching their own torch fall on.
 *
 * An open doorway is transparent, which is what makes opening one *visibly* worth doing: the room
 * beyond appears the moment the door swings back, without the character taking a step.
 *
 * **`Blocker` was missing here until V8d, and that was a bug.** Its own docblock promised it was
 * *"as solid and as sight-stopping as void"* and `tilemap.test.ts` said "still solid, still opaque"
 * — but nothing had ever asked this function, so every wall, hedge and tree line the seamless
 * projection stamped between rooms was see-through. It is exactly the fault the paragraph above
 * describes: a wall you can see straight through, banking rooms into `seen` through solid masonry.
 * Adding it here narrows what a player can see, which is the correct direction for a mistake of
 * this kind to be corrected in.
 *
 * {@link Tile.Prop} is deliberately *not* here. That is the whole reason it is a separate kind.
 */
export function isOpaqueTile(tile: number): boolean {
  return tile === Tile.Void || tile === Tile.Door || tile === Tile.Blocker;
}

/* -------------------------------------------------------------------------- */
/* Field of view                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Octant transforms. `tx = ox + col*xx + row*xy`, `ty = oy + col*yx + row*yy`.
 *
 * Eight triangles, each scanned with `0 <= col <= row`, covering the plane with the four diagonals
 * counted twice — harmless, since the result is a set.
 */
const OCTANTS: readonly (readonly [number, number, number, number])[] = [
  [1, 0, 0, 1],
  [0, 1, 1, 0],
  [0, -1, 1, 0],
  [-1, 0, 0, 1],
  [-1, 0, 0, -1],
  [0, -1, -1, 0],
  [0, 1, -1, 0],
  [1, 0, 0, -1],
];

/** Per-call state, allocated once and mutated as the octants are walked. */
interface Cast {
  readonly grid: TileGrid;
  readonly out: Set<number>;
  readonly ox: number;
  readonly oy: number;
  /** Furthest row scanned. A tile at `col = 0` and this depth is exactly `radius` away. */
  readonly maxDepth: number;
  /** `(radius + 0.5)^2`, compared against squared tile distance so no `sqrt` is needed. */
  readonly limitSq: number;
  xx: number;
  xy: number;
  yx: number;
  yy: number;
}

/**
 * Tiles lit from `(tx, ty)` with a light radius of `radius`, as a set of tile indices.
 *
 * ## Algorithm
 *
 * **Symmetric recursive shadowcasting** (Albert Ford's formulation of the classic Björn Bergström
 * shadowcast), over eight octants. Each row of an octant is scanned across a slope range; a run of
 * opaque tiles narrows the range for the next row, and a floor tile is lit only when its *centre*
 * lies inside the range. That centre test is the whole difference between this and the textbook
 * shadowcast, which lights a tile when any part of it is touched and is therefore asymmetric.
 *
 * Slopes are held as exact integer fractions rather than floats. The comparisons decide whether a
 * tile centre sits on a boundary, and a double that lands a bit either side of `0.5` there flips a
 * tile in one direction and not the other — which is precisely the asymmetry this is here to avoid.
 *
 * ## Symmetry
 *
 * **Strictly symmetric between transparent tiles**: if a floor tile B is lit from A, then A is lit
 * from B, for any radius, because both the slope test and the Euclidean distance test are symmetric
 * in the two endpoints. `vision.test.ts` asserts this exhaustively over a maze rather than taking
 * it on trust.
 *
 * It is deliberately **not** symmetric for opaque tiles: a wall is lit whenever a ray reaches it,
 * even if its centre falls outside the slope range, so you always see the wall your torch falls on
 * and rooms do not render as floating floors. That is the one documented break, it is one-way in the
 * harmless direction (you over-see walls, never under-see them), and nothing can stand in a wall to
 * exploit the asymmetry.
 *
 * ## Shape
 *
 * Euclidean, not Chebyshev: a tile is lit when its centre is within `radius + 0.5` of the origin
 * centre, so radius 2 lights 21 tiles in a rounded disc rather than a 25-tile square.
 *
 * ## Cost
 *
 * One `Set` and one `Cast` per call, no other allocation; recursion depth is bounded by `radius`.
 * At the radii in play (2-8) this visits a couple of hundred tiles at most, which is what makes it
 * affordable once per player per tick and once per frame.
 */
export function computeVisible(grid: TileGrid, tx: number, ty: number, radius: number): Set<number> {
  const out = new Set<number>();
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return out;

  // The origin is always lit, even standing inside something opaque — otherwise a character shoved
  // into a wall by a bug or a teleport renders as being nowhere at all.
  out.add(ty * grid.width + tx);
  if (!(radius > 0)) return out;

  const cast: Cast = {
    grid,
    out,
    ox: tx,
    oy: ty,
    maxDepth: Math.floor(radius + 0.5),
    limitSq: (radius + 0.5) * (radius + 0.5),
    xx: 1,
    xy: 0,
    yx: 0,
    yy: 1,
  };

  for (const [xx, xy, yx, yy] of OCTANTS) {
    cast.xx = xx;
    cast.xy = xy;
    cast.yx = yx;
    cast.yy = yy;
    // Slopes run 0 (the cardinal column) to 1 (the diagonal), as exact fractions num/den.
    scanRow(cast, 1, 0, 1, 1, 1);
  }
  return out;
}

/**
 * Scans one row of one octant, recursing into the next row for every unobstructed run.
 *
 * `sn/sd` and `en/ed` are the start and end slopes as fractions; both stay within `[0, 1]`, so the
 * denominators are always positive and every comparison below is exact integer arithmetic.
 */
function scanRow(cast: Cast, depth: number, sn: number, sd: number, en: number, ed: number): void {
  if (depth > cast.maxDepth) return;

  // The columns whose *centres* fall in the slope range, ties rounded outward so a tile sitting
  // exactly on a boundary is still scanned (it may be a wall that must be lit).
  const minCol = floorDiv(2 * depth * sn + sd, 2 * sd);
  const maxCol = ceilDiv(2 * depth * en - ed, 2 * ed);

  let startNum = sn;
  let startDen = sd;
  /** -1 before the first tile, 0 for the previous tile transparent, 1 for opaque. */
  let prev = -1;

  for (let col = minCol; col <= maxCol; col++) {
    const tx = cast.ox + col * cast.xx + depth * cast.xy;
    const ty = cast.oy + col * cast.yx + depth * cast.yy;
    const opaque = isOpaqueTile(tileAt(cast.grid, tx, ty));

    // Walls are lit but do not transmit: an opaque tile is revealed whenever the scan touches it,
    // a transparent one only when its centre is inside the live slope range.
    if (opaque || withinSlopes(depth, col, startNum, startDen, en, ed)) {
      reveal(cast, tx, ty);
    }

    if (prev === 1 && !opaque) {
      // Emerging from a run of wall: the next row starts at this tile's near corner.
      startNum = 2 * col - 1;
      startDen = 2 * depth;
    }
    if (prev === 0 && opaque) {
      // Entering a wall: recurse into the gap that just closed, before the wall shadows it.
      scanRow(cast, depth + 1, startNum, startDen, 2 * col - 1, 2 * depth);
    }
    prev = opaque ? 1 : 0;
  }

  if (prev === 0) scanRow(cast, depth + 1, startNum, startDen, en, ed);
}

/** Whether a tile centre lies within `[start, end]` — `col >= depth*start && col <= depth*end`. */
function withinSlopes(depth: number, col: number, sn: number, sd: number, en: number, ed: number): boolean {
  return col * sd >= depth * sn && col * ed <= depth * en;
}

function reveal(cast: Cast, tx: number, ty: number): void {
  const { grid } = cast;
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return;
  const dx = tx - cast.ox;
  const dy = ty - cast.oy;
  if (dx * dx + dy * dy > cast.limitSq) return;
  cast.out.add(ty * grid.width + tx);
}

/** `Math.floor(a / b)` for `b > 0`, correct for negative `a`. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** `Math.ceil(a / b)` for `b > 0`, correct for negative `a`. */
function ceilDiv(a: number, b: number): number {
  return Math.ceil(a / b);
}

/* -------------------------------------------------------------------------- */
/* The `seen` bitset                                                           */
/* -------------------------------------------------------------------------- */

/*
 * Plain functions over `Uint8Array`, not a `TileBits` class.
 *
 * The bitset is stored on disk per character per Place, shipped over the wire as base64, and read
 * back into the pathfinder's `allowed` gate. A class would add an identity that every one of those
 * boundaries has to construct and rehydrate, for no behaviour of its own — all the state is the
 * bytes. `TileGrid` already carries its data as bare typed arrays for the same reason, and this
 * keeps the persisted form, the wire form and the in-memory form the same object.
 */

/** Bytes needed to hold `tileCount` bits. */
export function bitsetBytes(tileCount: number): number {
  return (tileCount + 7) >> 3;
}

/** A zeroed bitset big enough for every tile of a grid this size. */
export function createBitset(tileCount: number): Uint8Array {
  return new Uint8Array(bitsetBytes(tileCount));
}

export function bitsetHas(bits: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  if (index < 0 || byte >= bits.length) return false;
  return ((bits[byte] ?? 0) & (1 << (index & 7))) !== 0;
}

/** Sets a bit. Returns `true` only if it was not already set — i.e. this tile is newly seen. */
export function bitsetAdd(bits: Uint8Array, index: number): boolean {
  const byte = index >> 3;
  if (index < 0 || byte >= bits.length) return false;
  const mask = 1 << (index & 7);
  const before = bits[byte] ?? 0;
  if ((before & mask) !== 0) return false;
  bits[byte] = before | mask;
  return true;
}

/**
 * Folds a `visible` set into a `seen` bitset and returns the tiles that were new.
 *
 * That return value *is* the `seenDelta` payload: the server sends exactly the tiles it just added,
 * so the client's copy of `seen` stays byte-identical to the authoritative one without the client
 * ever deriving visibility from its own predicted position.
 */
export function bitsetAddAll(bits: Uint8Array, indices: Iterable<number>): number[] {
  const added: number[] = [];
  for (const index of indices) {
    if (bitsetAdd(bits, index)) added.push(index);
  }
  return added;
}

/**
 * The set form, for the pathfinder's `allowed` gate.
 *
 * `tileCount` is passed rather than inferred because the final byte holds up to seven bits past the
 * end of the grid, and a stray index there would be a tile that does not exist.
 */
export function bitsetToSet(bits: Uint8Array, tileCount: number): Set<number> {
  const out = new Set<number>();
  for (let byte = 0; byte < bits.length; byte++) {
    const value = bits[byte] ?? 0;
    if (value === 0) continue;
    for (let bit = 0; bit < 8; bit++) {
      if ((value & (1 << bit)) === 0) continue;
      const index = (byte << 3) | bit;
      if (index < tileCount) out.add(index);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Base64                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * Hand-rolled, because this file runs in both Node and the browser.
 *
 * `Buffer` does not exist in the browser, and `btoa`/`atob` only speak Latin-1, so they need a
 * byte-to-char dance anyway. Detecting which is available would leave two code paths encoding the
 * same character's map progress, and the branch that only runs in the browser is the branch the test
 * suite never takes. This is thirty lines of table lookup with no platform surface at all.
 */

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_INVERSE = /* @__PURE__ */ (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) table[B64_ALPHABET.charCodeAt(i)] = i;
  return table;
})();

/** Standard base64 with `=` padding. Whole bytes in, so trailing bits survive untouched. */
export function bitsToBase64(bits: Uint8Array): string {
  const chunks: string[] = [];
  let i = 0;
  for (; i + 2 < bits.length; i += 3) {
    const n = ((bits[i] ?? 0) << 16) | ((bits[i + 1] ?? 0) << 8) | (bits[i + 2] ?? 0);
    chunks.push(
      B64_ALPHABET[(n >>> 18) & 63]! +
        B64_ALPHABET[(n >>> 12) & 63]! +
        B64_ALPHABET[(n >>> 6) & 63]! +
        B64_ALPHABET[n & 63]!,
    );
  }
  const rest = bits.length - i;
  if (rest === 1) {
    const n = (bits[i] ?? 0) << 16;
    chunks.push(`${B64_ALPHABET[(n >>> 18) & 63]!}${B64_ALPHABET[(n >>> 12) & 63]!}==`);
  } else if (rest === 2) {
    const n = ((bits[i] ?? 0) << 16) | ((bits[i + 1] ?? 0) << 8);
    chunks.push(
      `${B64_ALPHABET[(n >>> 18) & 63]!}${B64_ALPHABET[(n >>> 12) & 63]!}${B64_ALPHABET[(n >>> 6) & 63]!}=`,
    );
  }
  return chunks.join('');
}

/**
 * Decodes into a buffer of exactly `byteLength` bytes.
 *
 * The length is given rather than derived so the result always matches the grid it will be indexed
 * against: a short or corrupt string leaves the remaining tiles unseen instead of throwing mid-join,
 * and a longer one is clipped rather than handing the pathfinder indices off the end of the map.
 * Characters outside the alphabet are skipped, so line-wrapped input decodes.
 */
export function bitsFromBase64(s: string, byteLength: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, byteLength));
  let acc = 0;
  let accBits = 0;
  let written = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 61 /* = */) break;
    const value = code < 128 ? (B64_INVERSE[code] ?? -1) : -1;
    if (value < 0) continue;
    acc = (acc << 6) | value;
    accBits += 6;
    if (accBits >= 8) {
      accBits -= 8;
      if (written < out.length) out[written++] = (acc >>> accBits) & 0xff;
    }
  }
  return out;
}
