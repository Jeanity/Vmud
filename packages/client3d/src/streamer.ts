/**
 * Spatial streaming — the plan's §4 Layer C, and the measurement that settled it.
 *
 * *"Several designs propose BFS over the room graph on the grounds that you never load a room across
 * a barrier the player can't see through. That is a 2D fog-of-war assumption and the 64° camera
 * invalidates it — you see **over** barriers."* The numbers behind that: sampling 6,797 rooms across
 * all 327 zones against a 5x3-stride-cell footprint, the footprint holds 8.2 rooms on average, of
 * which **15.0% are not reachable within 3 graph hops** — those are visible holes where a room should
 * be — while **43.4% of what BFS-3 loads is outside the footprint entirely**. So geometry loads by
 * spatial radius, and the room graph keeps the job it is correct for, which is interest management
 * and already works.
 *
 * ## The window, and why it is the shape it is — M6
 *
 * A cell is one room block plus its gap — a **stride cell**, 11 m in a normal zone and 10 m in a
 * seamless one — and the window is a rectangle of them around the camera's own cell. M3 wrote that
 * rectangle down (5x3 plus a ring of margin, 7x5) from the 64° frame's 34 x 22 m of ground. M6 makes
 * the frame *movable*, so the rectangle is no longer a number to write down: it is **derived, here,
 * from the far corner of the rig's clamp** — {@link rig.CAMERA_DISTANCE_MAX} metres back at
 * {@link rig.CAMERA_PITCH_MIN} degrees, the pose that shows the most ground of any the owner can
 * dial in.
 *
 * The derivation is three divisions. At that pose the frame's ground trapezoid reaches 24.8 m ahead
 * of the character, 14.3 m behind, and 32.3 m either side at its widest (16:9). Against the
 * **smaller** of the two strides — a seamless zone's 10 m, because sizing against the 11 m one would
 * leave a seamless zone short — that is 3 cells of lookahead, 2 behind and 4 to each side. Nine
 * columns by six rows, twice over for the two levels: {@link MAX_WINDOW_CHUNKS}.
 *
 * Two consequences worth stating plainly, because both cost something:
 *
 * - **The ring is asymmetric now.** The camera looks north and the frame is a trapezoid, so it sees
 *   73% further ahead than behind; a symmetric window would have to be sized for the far edge in
 *   both directions and would build a row nobody can see. {@link WINDOW_CELLS_NORTH} is one more
 *   than {@link WINDOW_CELLS_SOUTH} for exactly that reason, and it is the *only* asymmetry — east
 *   and west are the same, because the frame is.
 * - **108 chunks, not 70.** That is 54% more pre-warmed wrappers (`pool.ts` sizes itself off
 *   {@link MAX_WINDOW_CHUNKS}) and 2.8 MB more instance buffer, paid at boot whether or not the owner
 *   ever pulls the camera back. It is paid because the pool is minted once — that is the flat-ledger
 *   acceptance — so the ceiling has to be the worst case rather than the current one.
 *
 * ## What the coverage guarantee actually says
 *
 * The window is centred on the **cell** the character is in, and they can stand anywhere inside it.
 * So the guaranteed built ground in a direction is `stride x (cells beyond the centre cell)` and no
 * more: at the far side of their own cell the character has consumed the centre cell's whole stride.
 * {@link RING_COVER} states the three numbers that fall out, and `rig.test.ts` checks them against
 * the frame at all four corners of the clamp.
 *
 * The margin left over is the pop-in guard and the **hysteresis**: crossing a cell boundary changes
 * the window by one row, so a player pacing back and forth over the line rebuilds one row rather
 * than the world. There is no separate hysteresis parameter, deliberately, because a second one
 * would have to be kept consistent with this one.
 *
 * ## The aspect the ring is sized at, and the screens wider than it
 *
 * The frame's width scales with the canvas aspect and the ring does not. Sized at 16:9, the ring
 * covers every aspect up to **2.199:1** at the fully-pulled-back pose — 16:10, 16:9, 2:1 — and falls
 * short of a 3440x1440 ultrawide by about three metres at the two far corners. Rather than ship a
 * documented hole (the fog would hide it at night and would not in daylight, where
 * `daylight.DAY_SKY` runs a third the density), {@link maxDistanceForAspect} pulls the *dolly's*
 * ceiling in on such a screen: 44.2 m instead of 48. The invariant then holds at every aspect
 * without another cell, which is the trade that is actually worth making — nobody will notice four
 * metres of zoom, and everybody would notice the world ending inside the frame.
 *
 * ## Two levels, never three
 *
 * The vertical policy (§4.5, decided at M3 "before shadows and lighting are tuned at M4") is *the
 * player's level plus one below, faded, and everything above hard-culled*. The cull is implemented
 * here, in the streamer, rather than as a visibility toggle downstream: a level above is not
 * something that is loaded and hidden, it is something that is never built. That is the difference
 * between a policy and a flag, and it is why {@link MAX_WINDOW_CHUNKS} is a number rather than a
 * hope.
 */

import { ROOM_TILES, SEAM_GAP } from '@mygame/shared';

import { METRES_PER_TILE } from './frame.ts';
import { CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_MIN, CAMERA_PITCH_MIN, groundFrame } from './rig.ts';
import { SHADOW_PAD } from './night.ts';

/**
 * The tighter of the two stride cells, in metres — a **seamless** zone's.
 *
 * `frame.placeFrame` picks `SEAM_GAP` for a seamless zone and `ROOM_GAP` otherwise, so a cell is 10 m
 * in one and 11 m in the other. The window is a count of cells, so sizing it against the 11 m cell
 * would leave every seamless zone a metre short per ring — which is the kind of gap that shows up as
 * a strip of void in one zone out of twelve and nowhere else.
 */
const STRIDE_METRES = (ROOM_TILES + SEAM_GAP) * METRES_PER_TILE;

/**
 * The aspect the ring is sized at. Wider screens are handled by {@link maxDistanceForAspect}.
 *
 * 16:9 rather than the widest imaginable monitor, because every extra column is 12 chunks and the
 * dolly ceiling is a cheaper place to absorb an ultrawide than the pre-warmed pool is.
 */
export const RING_ASPECT = 16 / 9;

/** The frame at the far corner of the clamp — the pose the whole window is sized against. */
const WORST = groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, RING_ASPECT);

/**
 * Cells either side of the centre cell — sized for the frame *plus the moon's shadow pad*.
 *
 * The pad joined the derivation when the dolly ceiling doubled (48 → 96, owner's ask): at 48 m the
 * `ceil` slack happened to swallow {@link SHADOW_PAD}'s 2.5 m and `rig.test`'s "shadow box fits
 * inside the built ring" held by luck; at 96 m the slack shrank and it did not. The invariant now
 * lives in the arithmetic instead of the rounding.
 */
export const WINDOW_HALF_X = Math.ceil(
  (Math.max(WORST.halfWidthNear, WORST.halfWidthFar) + SHADOW_PAD) / STRIDE_METRES,
);

/** Cells **ahead** of the centre cell, north — frame plus shadow pad, as above. The lookahead. */
export const WINDOW_CELLS_NORTH = Math.ceil((WORST.north + SHADOW_PAD) / STRIDE_METRES);

/** Cells behind it, south. Two: the near edge is 14.3 m back. */
export const WINDOW_CELLS_SOUTH = Math.ceil(WORST.south / STRIDE_METRES);

/** Columns in the window. Nine. */
export const WINDOW_CELLS_X = 2 * WINDOW_HALF_X + 1;

/** Rows. Six — and not centred; see {@link WINDOW_CELLS_NORTH}. */
export const WINDOW_CELLS_Y = WINDOW_CELLS_NORTH + WINDOW_CELLS_SOUTH + 1;

/** The camera's level and the one below it. Never the one above — see the header. */
export const WINDOW_LEVELS = 2;

/**
 * Metres of built ground the window guarantees in each direction, **whatever the character's
 * position inside their own cell**. See the header: the centre cell's own stride is theirs to spend.
 */
export const RING_COVER = {
  lateral: WINDOW_HALF_X * STRIDE_METRES,
  north: WINDOW_CELLS_NORTH * STRIDE_METRES,
  south: WINDOW_CELLS_SOUTH * STRIDE_METRES,
} as const;

/** The hard ceiling on live chunks, asserted by the traversal test — see `streamer.test` for the
 * current cell arithmetic (it moved when the dolly ceiling doubled). */
export const MAX_WINDOW_CHUNKS = WINDOW_CELLS_X * WINDOW_CELLS_Y * WINDOW_LEVELS;

/**
 * The furthest the dolly may pull back on a canvas of this shape, so the frame stays inside the ring.
 *
 * Every extent of {@link rig.groundFrame} is linear in the distance, so the answer is a ratio rather
 * than a search: take the tightest of the three coverage margins at the fully-pulled-back, fully
 * lowered pose and scale the ceiling by it. Only the lateral term can ever bind (the north and south
 * margins are 1.21x and 1.39x at 16:9), and it binds only past 2.199:1.
 *
 * Evaluated at {@link rig.CAMERA_PITCH_MIN} rather than at the live pitch on purpose: a ceiling that
 * moved as the owner tilted would pull the camera in under their hand, and a fixed number per window
 * size is one they can read off `__debug3d.camera` and reason about.
 */
export function maxDistanceForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return CAMERA_DISTANCE_MAX;
  const frame = groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, aspect);
  const slack = Math.min(
    RING_COVER.lateral / Math.max(frame.halfWidthNear, frame.halfWidthFar),
    RING_COVER.north / frame.north,
    RING_COVER.south / frame.south,
  );
  return Math.max(CAMERA_DISTANCE_MIN, Math.min(CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_MAX * slack));
}

/** A chunk's address: one stride cell on one level, in **zone** cell coordinates. */
export interface ChunkAddress {
  readonly cellX: number;
  readonly cellY: number;
  readonly level: number;
}

export function chunkKey(address: ChunkAddress): string {
  return `${address.level}:${address.cellX}:${address.cellY}`;
}

/**
 * Every address the window covers, centred on a cell. Always {@link MAX_WINDOW_CHUNKS} long.
 *
 * `y` grows **south** (`CLAUDE.md`'s coordinate convention), so the lookahead is the negative side:
 * `dy` runs from `-WINDOW_CELLS_NORTH` to `+WINDOW_CELLS_SOUTH`. Getting that sign wrong would build
 * the extra row behind the camera and starve the frame, and it would look exactly like the streamer
 * working.
 */
export function windowAddresses(cellX: number, cellY: number, level: number): ChunkAddress[] {
  const out: ChunkAddress[] = [];
  for (let l = 0; l < WINDOW_LEVELS; l++) {
    for (let dy = -WINDOW_CELLS_NORTH; dy <= WINDOW_CELLS_SOUTH; dy++) {
      for (let dx = -WINDOW_HALF_X; dx <= WINDOW_HALF_X; dx++) {
        out.push({ cellX: cellX + dx, cellY: cellY + dy, level: level - l });
      }
    }
  }
  return out;
}

/**
 * What the streamer drives.
 *
 * `load` returns whether a chunk was actually built. A cell with no room in it is not a failure — it
 * is the void, which is most of any level's bounding box — and returning `false` keeps it out of the
 * live set so nothing tries to unload it later.
 */
export interface ChunkSink {
  load(address: ChunkAddress): boolean;
  unload(key: string, address: ChunkAddress): void;
}

export interface StreamStep {
  readonly loaded: number;
  readonly unloaded: number;
  /** False when the centre had not moved and nothing was considered. */
  readonly moved: boolean;
}

/**
 * The live set, and the difference between one window and the next.
 *
 * Holds addresses, never geometry: what a chunk *is* belongs to the sink. That is what lets the
 * traversal test drive a real 1,000-room walk through a counting sink and assert the window never
 * exceeds its bound, without a renderer.
 */
export class ChunkStreamer {
  private readonly live = new Map<string, ChunkAddress>();
  private centre: string | undefined;
  private readonly sink: ChunkSink;

  /**
   * The field is declared and assigned rather than written as `constructor(private sink: …)`.
   *
   * **A parameter property is not erasable syntax** and Node's strip-only type stripping rejects it
   * outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), which would make this module unimportable from a
   * `node --test` file — and the whole reason it is a separate module is so a headless test can
   * drive it. Same family as `CLAUDE.md`'s "no `enum` or `namespace`" rule, and it applies to every
   * file in this package that a test can reach.
   */
  constructor(sink: ChunkSink) {
    this.sink = sink;
  }

  get size(): number {
    return this.live.size;
  }

  has(key: string): boolean {
    return this.live.has(key);
  }

  keys(): IterableIterator<string> {
    return this.live.keys();
  }

  addresses(): IterableIterator<ChunkAddress> {
    return this.live.values();
  }

  /**
   * Recentre the window.
   *
   * Cheap to call every frame: it does nothing at all until the camera crosses a cell boundary,
   * which at walking pace is about every two and a half seconds.
   */
  update(cellX: number, cellY: number, level: number): StreamStep {
    const centre = `${level}:${cellX}:${cellY}`;
    if (centre === this.centre) return { loaded: 0, unloaded: 0, moved: false };
    this.centre = centre;

    const wanted = new Map<string, ChunkAddress>();
    for (const address of windowAddresses(cellX, cellY, level)) wanted.set(chunkKey(address), address);

    let unloaded = 0;
    for (const [key, address] of this.live) {
      if (wanted.has(key)) continue;
      this.sink.unload(key, address);
      this.live.delete(key);
      unloaded += 1;
    }

    let loaded = 0;
    for (const [key, address] of wanted) {
      if (this.live.has(key)) continue;
      if (!this.sink.load(address)) continue;
      this.live.set(key, address);
      loaded += 1;
    }

    return { loaded, unloaded, moved: true };
  }

  /** Drop everything — an arrival at a new Place, or a reconnect. The sink returns its resources. */
  clear(): void {
    for (const [key, address] of this.live) this.sink.unload(key, address);
    this.live.clear();
    this.centre = undefined;
  }
}
