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
 * ## The window, and why it is the shape it is — M6, and then M8
 *
 * A cell is one room block plus its gap — a **stride cell**, 11 m in a normal zone and 10 m in a
 * seamless one — and the window is a set of them around the camera's own cell. M3 wrote a rectangle
 * down (5x3 plus a ring of margin, 7x5) from the 64° frame's 34 x 22 m of ground. M6 made the frame
 * *movable*, so the rectangle became **derived** from the far corner of the rig's clamp —
 * {@link rig.CAMERA_DISTANCE_MAX} metres back at {@link rig.CAMERA_PITCH_MIN} degrees, the pose that
 * shows the most ground of any the owner can dial in — and asymmetric, one extra row of lookahead
 * *north*, "because that is where the camera looks".
 *
 * **M8 turned the camera.** A lookahead in a fixed direction is the single most yaw-dependent thing
 * this renderer contained: at 180° of orbit it builds the row behind the frame and starves the row in
 * front of it, and it would look exactly like the streamer working. The brief's two options were to
 * rotate the lookahead with the view or to make the ring symmetric at the worst case. **Symmetric,
 * and the reason is churn**: a window whose shape is a function of the yaw changes shape *during the
 * gesture*, so an orbit — one continuous drag — would load and unload chunks the whole way round,
 * and a chunk load is `planChunk` plus scatter plus interior. The owner would have bought a camera
 * that stutters every time they use it. A window sized for the worst case is paid once, at boot, in
 * a currency (`pool.ts`'s pre-warm) this renderer already agreed to spend.
 *
 * ## The ring is a disc now, and 293 cells is what that costs
 *
 * Symmetric does **not** mean the square that circumscribes the frame. Once the yaw is free the only
 * statement about the footprint that survives a rotation is its circumradius about the character
 * (`rig.groundRadius`), so the window is the set of cells that can hold a point within
 * {@link RING_RADIUS} of the player — a **disc**, rasterised to cells, and 19% cheaper than the
 * 19 x 19 square that would cover the same guarantee (293 cells a level against 361).
 *
 * The rasterisation rule is the coverage guarantee restated, and it is the one line to get right. The
 * window is centred on the **cell** the character is in and they can stand anywhere inside it, so the
 * distance the ring must answer for is measured from the *worst* point of the centre cell to the
 * *nearest* point of a candidate cell — which for axis-aligned cells of one stride is
 * `hypot(max(0, |dx| - 1), max(0, |dy| - 1)) x stride`. Every cell that could contain a point within
 * {@link RING_RADIUS} of any point of the centre cell is built; nothing else is. Along an axis that
 * reaches 9 cells out, on the diagonal 6, and `rig.test.ts` checks the *property* rather than the
 * arithmetic — the frame's own corners, swept through a full circle of yaw at every corner of the
 * clamp, must land on cells the ring built.
 *
 * Three consequences worth stating plainly, because all three cost something:
 *
 * - **586 chunks, not 300.** That is 95% more pre-warmed wrappers (`pool.ts` sizes itself off
 *   {@link MAX_WINDOW_CHUNKS}) and 22.1 MB more instance buffer, paid at boot whether or not the
 *   owner ever orbits. It is paid because the pool is minted once — that is the flat-ledger
 *   acceptance — so the ceiling has to be the worst case rather than the current one.
 * - **At any one yaw about half of it is behind the frame.** That is not waste to be trimmed; it is
 *   the *same* half that will be in front of the frame two seconds later, which is the whole reason
 *   the shape does not move.
 * - **The lookahead is gone as a concept.** There is no `WINDOW_CELLS_NORTH` any more, and nothing
 *   downstream may reintroduce a directional term without answering the yaw question again.
 *
 * The margin between the disc and the frame is the pop-in guard and the **hysteresis**: crossing a
 * cell boundary changes the window by one ragged column, so a player pacing back and forth over the
 * line rebuilds a column rather than the world. There is no separate hysteresis parameter,
 * deliberately, because a second one would have to be kept consistent with this one.
 *
 * ## The aspect the ring is sized at, and the screens wider than it
 *
 * The frame's width scales with the canvas aspect and the ring does not. Sized at 16:9, the ring
 * covers the full 96 m of pull-back at that aspect **exactly** — {@link RING_RADIUS} is derived from
 * it, so the two agree by construction rather than by luck — and falls short on anything wider.
 * Rather than ship a documented hole (the fog would hide it at night and would not in daylight, where
 * `daylight.DAY_SKY` runs a third the density), {@link maxDistanceForAspect} pulls the *dolly's*
 * ceiling in on such a screen. The invariant then holds at every aspect and every yaw without another
 * cell, which is the trade that is actually worth making — nobody will notice a few metres of zoom,
 * and everybody would notice the world ending inside the frame.
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
import { CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_MIN, CAMERA_PITCH_MIN, groundFrame, groundRadius } from './rig.ts';
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
 * Metres of built ground the window guarantees **in every direction** — 84.06 m.
 *
 * `rig.groundRadius` of the worst pose (81.56 m at 96 m / 45° / 16:9), plus the moon's
 * {@link SHADOW_PAD}. Two things are folded in here rather than left to a `ceil` to absorb, and both
 * were bought with a failure:
 *
 * - **The pad** joined the derivation when the dolly ceiling doubled (48 → 96, owner's ask): at 48 m
 *   the slack happened to swallow its 2.5 m and `rig.test`'s "shadow box fits inside the built ring"
 *   held by luck; at 96 m the slack shrank and it did not.
 * - **The radius, rather than three extents**, is M8's: the frame's *widest* point is the far corner
 *   of the trapezoid, not the middle of its far edge, and once the yaw turns that corner can point
 *   down any axis. Sizing off `halfWidthFar` alone would leave the ring 17 m short on the diagonal —
 *   which is a hole that appears only when the owner orbits to 45°, i.e. immediately.
 */
export const RING_RADIUS = groundRadius(WORST) + SHADOW_PAD;

/**
 * Cells out along an axis. **Nine.**
 *
 * The `+ 1` is the coverage guarantee, not a fudge: the character may stand anywhere in the centre
 * cell, so the ring has to answer from the *far* side of it, and the nearest point of the cell `k`
 * out is only `(k - 1)` strides away. See the header for the whole rasterisation rule.
 */
export const WINDOW_HALF = Math.floor(RING_RADIUS / STRIDE_METRES) + 1;

/** The camera's level and the one below it. Never the one above — see the header. */
export const WINDOW_LEVELS = 2;

/**
 * Every cell offset in the disc, in build order — **the window's shape, computed once at load.**
 *
 * A list rather than a nested loop with a predicate, because {@link windowAddresses} runs on every
 * cell boundary the player crosses and the shape never changes; and because a shape that is a value
 * is a shape a test can hold up against the frame's own corners.
 */
export const RING_CELLS: readonly (readonly [dx: number, dy: number])[] = (() => {
  const out: [number, number][] = [];
  for (let dy = -WINDOW_HALF; dy <= WINDOW_HALF; dy++) {
    for (let dx = -WINDOW_HALF; dx <= WINDOW_HALF; dx++) {
      if (cellReach(dx, dy) <= RING_RADIUS) out.push([dx, dy]);
    }
  }
  return out;
})();

/**
 * Metres from the worst point of the centre cell to the nearest point of the cell `(dx, dy)` out.
 *
 * Adjacent cells touch, so the first ring out is at zero distance and the `k`-th at `(k - 1)`
 * strides. Exported for the test that checks the window against this rule rather than against a
 * copy of it.
 */
export function cellReach(dx: number, dy: number): number {
  return Math.hypot(Math.max(0, Math.abs(dx) - 1), Math.max(0, Math.abs(dy) - 1)) * STRIDE_METRES;
}

/**
 * What the window guarantees, as the one number that survives a rotation. See {@link RING_RADIUS}.
 *
 * Kept as an object with a named field rather than a bare number so that `__debug3d.window` and
 * `rig.test.ts` read the same shape they always did — and so the day something needs a second term,
 * adding it does not silently change what an existing caller was comparing against.
 */
export const RING_COVER = { radius: RING_RADIUS } as const;

/** The hard ceiling on live chunks, asserted by the traversal test. 586 — see the header. */
export const MAX_WINDOW_CHUNKS = RING_CELLS.length * WINDOW_LEVELS;

/**
 * The furthest the dolly may pull back on a canvas of this shape, so the frame stays inside the ring.
 *
 * Every extent of {@link rig.groundFrame} is linear in the distance and so, therefore, is its
 * circumradius — the answer is one division rather than a search. The shadow pad is *not* linear, so
 * it comes off the radius before the division rather than scaling with it; getting that backwards
 * would cost two metres of ceiling and would never show up as anything but a slightly shorter zoom.
 *
 * Evaluated at {@link rig.CAMERA_PITCH_MIN} rather than at the live pitch on purpose: a ceiling that
 * moved as the owner tilted would pull the camera in under their hand, and a fixed number per window
 * size is one they can read off `__debug3d.camera` and reason about. **And not at the live yaw, for
 * the same reason and more loudly** — a ceiling that varied with the yaw would zoom the camera in and
 * out as the owner orbited, which is the one behaviour a rotation control must not have.
 */
export function maxDistanceForAspect(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return CAMERA_DISTANCE_MAX;
  const radiusPerMetre = groundRadius(groundFrame(CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN, aspect)) / CAMERA_DISTANCE_MAX;
  const ceiling = (RING_RADIUS - SHADOW_PAD) / radiusPerMetre;
  return Math.max(CAMERA_DISTANCE_MIN, Math.min(CAMERA_DISTANCE_MAX, ceiling));
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
 * There is no sign to get wrong here any more, and that is M8's whole point: the shape is symmetric
 * in both axes, so the bug M6 warned about — *"getting that sign wrong would build the extra row
 * behind the camera and starve the frame, and it would look exactly like the streamer working"* — is
 * not available to be written. The direction the camera faces is no longer this file's business.
 */
export function windowAddresses(cellX: number, cellY: number, level: number): ChunkAddress[] {
  const out: ChunkAddress[] = [];
  for (let l = 0; l < WINDOW_LEVELS; l++) {
    for (const [dx, dy] of RING_CELLS) {
      out.push({ cellX: cellX + dx, cellY: cellY + dy, level: level - l });
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
