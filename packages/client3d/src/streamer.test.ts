/**
 * The window, the cull and the churn.
 *
 * Three properties, and each one is a way the design could fail quietly:
 *
 * 1. **The window is exactly {@link MAX_WINDOW_CHUNKS}.** Everything downstream is bounded by this
 *    number, so if it stops being a constant nothing else's bound means anything.
 * 2. **No level above the camera is ever asked for.** The vertical policy is implemented by never
 *    building the level above, not by hiding it, and this is where that is checked.
 * 3. **Recentring by one cell touches one row.** A window that reloaded itself on every step would
 *    keep the memory flat and still be unusable, and the slack between the frame and the ring is the
 *    only thing preventing it.
 * 4. **M6: the shape is derived from the dolly's clamp, and it is asymmetric.** The camera looks
 *    north and can now be tilted to see much further that way, so the ring reaches one cell further
 *    ahead than behind — and on a canvas too wide for it, the *dolly* gives way rather than the
 *    world. Both are checked here; `rig.test.ts` checks the coverage that justifies them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CAMERA_DISTANCE_MAX } from './rig.ts';
import {
  ChunkStreamer,
  MAX_WINDOW_CHUNKS,
  RING_ASPECT,
  RING_COVER,
  WINDOW_CELLS_NORTH,
  WINDOW_CELLS_SOUTH,
  WINDOW_CELLS_X,
  WINDOW_CELLS_Y,
  WINDOW_HALF_X,
  WINDOW_LEVELS,
  chunkKey,
  maxDistanceForAspect,
  windowAddresses,
  type ChunkAddress,
  type ChunkSink,
} from './streamer.ts';

/** A sink that says yes to everything and remembers what it was asked. */
class CountingSink implements ChunkSink {
  loaded: ChunkAddress[] = [];
  unloaded: string[] = [];
  live = new Set<string>();
  /** Cells this sink pretends hold a room. `undefined` means "all of them". */
  occupied: Set<string> | undefined;

  load(address: ChunkAddress): boolean {
    const key = chunkKey(address);
    if (this.occupied && !this.occupied.has(key)) return false;
    this.loaded.push(address);
    this.live.add(key);
    return true;
  }

  unload(key: string): void {
    this.unloaded.push(key);
    this.live.delete(key);
  }

  reset(): void {
    this.loaded = [];
    this.unloaded = [];
  }
}

describe('the streaming window', () => {
  it('is 9 x 6 x 2 = 108 cells, derived from the far corner of the dolly clamp', () => {
    /*
     * **M6 moved these numbers and it is worth being loud about it.** M3's 7 x 5 x 2 = 70 was sized
     * from a fixed 64-degree, 36 m frame. The rig now runs to 48 m at 45 degrees, which shows 24.8 m
     * of ground ahead instead of 12.3 and 32.3 m either side instead of 20.4, so the ring is
     * re-derived from that pose against a *seamless* zone's tighter 10 m stride cell.
     *
     * Written as literals as well as derived, deliberately: a change to a clamp that silently costs
     * 38 chunks and 2.8 MB of pre-warmed instance buffer should fail a test rather than land.
     */
    assert.equal(WINDOW_HALF_X, 4);
    assert.equal(WINDOW_CELLS_NORTH, 3, 'the lookahead: the frame sees furthest in front of the camera');
    assert.equal(WINDOW_CELLS_SOUTH, 2);
    assert.equal(WINDOW_CELLS_X, 9);
    assert.equal(WINDOW_CELLS_Y, 6);
    assert.equal(WINDOW_LEVELS, 2);
    assert.equal(MAX_WINDOW_CHUNKS, 108);
    assert.equal(windowAddresses(0, 0, 0).length, MAX_WINDOW_CHUNKS);
    // The guarantee the coverage argument rests on: cells beyond the centre one, times the stride.
    assert.deepEqual({ ...RING_COVER }, { lateral: 40, north: 30, south: 20 });
  });

  it('reaches further ahead of the camera than behind it, and equally to each side', () => {
    const cells = windowAddresses(10, 20, 3).filter((a) => a.level === 3);
    const xs = cells.map((a) => a.cellX);
    const ys = cells.map((a) => a.cellY);
    assert.equal(Math.min(...xs), 10 - WINDOW_HALF_X);
    assert.equal(Math.max(...xs), 10 + WINDOW_HALF_X);
    // `y` grows south, so the lookahead is the negative side. Getting this sign wrong would build the
    // extra row behind the camera and starve the frame, and would look exactly like it working.
    assert.equal(Math.min(...ys), 20 - WINDOW_CELLS_NORTH);
    assert.equal(Math.max(...ys), 20 + WINDOW_CELLS_SOUTH);
    assert.ok(WINDOW_CELLS_NORTH > WINDOW_CELLS_SOUTH, 'the window is not looking where the camera is');
  });

  it('pulls the dolly ceiling in on a canvas too wide for the ring, rather than showing void', () => {
    // At the aspect it was sized for, and at anything narrower, the full 48 m is available.
    assert.equal(maxDistanceForAspect(RING_ASPECT), CAMERA_DISTANCE_MAX);
    assert.equal(maxDistanceForAspect(4 / 3), CAMERA_DISTANCE_MAX);
    assert.equal(maxDistanceForAspect(16 / 10), CAMERA_DISTANCE_MAX);
    // 2:1 still fits; the ring covers up to 2.199:1 at full pull-back.
    assert.equal(maxDistanceForAspect(2), CAMERA_DISTANCE_MAX);
    // A 3440x1440 ultrawide does not, and loses four metres of zoom rather than four metres of world.
    const ultrawide = maxDistanceForAspect(3440 / 1440);
    assert.ok(ultrawide > 43 && ultrawide < 45, `${ultrawide} m at 2.39:1`);
    assert.ok(ultrawide < CAMERA_DISTANCE_MAX);
    // Nonsense in, the nominal ceiling out — a zero-height canvas must not produce a NaN clamp.
    assert.equal(maxDistanceForAspect(0), CAMERA_DISTANCE_MAX);
    assert.equal(maxDistanceForAspect(Number.NaN), CAMERA_DISTANCE_MAX);
  });

  it('never asks for a level above the camera', () => {
    for (const level of [-3, 0, 7]) {
      for (const address of windowAddresses(0, 0, level)) {
        assert.ok(address.level <= level, `asked for level ${address.level} from ${level}`);
        assert.ok(address.level >= level - (WINDOW_LEVELS - 1));
      }
    }
  });

  it('has no duplicate addresses', () => {
    const keys = windowAddresses(4, 4, 1).map(chunkKey);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe('ChunkStreamer', () => {
  it('does nothing at all until the centre cell changes', () => {
    const sink = new CountingSink();
    const streamer = new ChunkStreamer(sink);
    const first = streamer.update(0, 0, 0);
    assert.equal(first.moved, true);
    assert.equal(first.loaded, MAX_WINDOW_CHUNKS);
    sink.reset();
    for (let i = 0; i < 100; i++) {
      const step = streamer.update(0, 0, 0);
      assert.equal(step.moved, false);
      assert.equal(step.loaded, 0);
      assert.equal(step.unloaded, 0);
    }
    assert.equal(sink.loaded.length, 0);
  });

  it('trades one column for one column when the camera steps east', () => {
    const sink = new CountingSink();
    const streamer = new ChunkStreamer(sink);
    streamer.update(0, 0, 0);
    sink.reset();
    const step = streamer.update(1, 0, 0);
    // One column is six rows on each of two levels.
    const column = WINDOW_CELLS_Y * WINDOW_LEVELS;
    assert.equal(step.loaded, column);
    assert.equal(step.unloaded, column);
    assert.equal(streamer.size, MAX_WINDOW_CHUNKS);
  });

  it('holds the bound over a long walk, and returns everything on a Place change', () => {
    const sink = new CountingSink();
    const streamer = new ChunkStreamer(sink);
    let high = 0;
    for (let step = 0; step < 400; step++) {
      // A meander rather than a straight line: a straight walk never re-loads a cell it just left,
      // which is exactly the case a leak would hide in.
      streamer.update(Math.round(6 * Math.sin(step / 9)), Math.round(4 * Math.cos(step / 13)), 0);
      high = Math.max(high, streamer.size);
      assert.ok(streamer.size <= MAX_WINDOW_CHUNKS);
    }
    assert.equal(high, MAX_WINDOW_CHUNKS);
    assert.equal(sink.live.size, streamer.size);
    streamer.clear();
    assert.equal(streamer.size, 0);
    assert.equal(sink.live.size, 0);
  });

  it('keeps an empty cell out of the live set rather than remembering a hole', () => {
    const sink = new CountingSink();
    // Only two cells of the whole window hold anything, which is the sparse-zone case.
    sink.occupied = new Set(['0:0:0', '0:1:0']);
    const streamer = new ChunkStreamer(sink);
    const step = streamer.update(0, 0, 0);
    assert.equal(step.loaded, 2);
    assert.equal(streamer.size, 2);
    streamer.update(20, 20, 0);
    assert.equal(streamer.size, 0);
    assert.deepEqual(sink.unloaded.sort(), ['0:0:0', '0:1:0']);
  });
});
