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
 * ## The window, and why it is the shape it is
 *
 * A cell is one room block plus its gap — a **stride cell**, 11 m at the classic projection — and
 * the window is the plan's 5x3 rectangle plus one ring of margin. Wider than tall because the camera
 * is pitched: at 64° the frame covers roughly {@link rig.CAMERA_DISTANCE} x 0.95 metres of ground
 * across and 0.60 down, which at 36 m is 34 m x 22 m, a little over 3 cells by 2.
 *
 * The margin ring is doing two jobs and both matter. It is the pop-in guard — a chunk is built a
 * whole cell before it can be seen — and it is the **hysteresis**: crossing a cell boundary changes
 * the window by one row, so a player pacing back and forth over the line rebuilds one row rather
 * than the world. There is no separate hysteresis parameter, deliberately, because a second one
 * would have to be kept consistent with this one.
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

/** The plan's footprint, in stride cells. Wider than deep because the camera is pitched. */
export const WINDOW_CELLS_X = 5;
export const WINDOW_CELLS_Y = 3;

/** One ring beyond the footprint: the pop-in guard, and the only hysteresis there is. */
export const WINDOW_MARGIN = 1;

/** The camera's level and the one below it. Never the one above — see the header. */
export const WINDOW_LEVELS = 2;

const HALF_X = (WINDOW_CELLS_X - 1) / 2 + WINDOW_MARGIN;
const HALF_Y = (WINDOW_CELLS_Y - 1) / 2 + WINDOW_MARGIN;

/** 7 x 5 x 2 = 70. The hard ceiling on live chunks, asserted by the traversal test. */
export const MAX_WINDOW_CHUNKS = (2 * HALF_X + 1) * (2 * HALF_Y + 1) * WINDOW_LEVELS;

/** A chunk's address: one stride cell on one level, in **zone** cell coordinates. */
export interface ChunkAddress {
  readonly cellX: number;
  readonly cellY: number;
  readonly level: number;
}

export function chunkKey(address: ChunkAddress): string {
  return `${address.level}:${address.cellX}:${address.cellY}`;
}

/** Every address the window covers, centred on a cell. Always {@link MAX_WINDOW_CHUNKS} long. */
export function windowAddresses(cellX: number, cellY: number, level: number): ChunkAddress[] {
  const out: ChunkAddress[] = [];
  for (let l = 0; l < WINDOW_LEVELS; l++) {
    for (let dy = -HALF_Y; dy <= HALF_Y; dy++) {
      for (let dx = -HALF_X; dx <= HALF_X; dx++) {
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
