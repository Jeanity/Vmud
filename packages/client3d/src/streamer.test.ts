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
 *    keep the memory flat and still be unusable, and the margin ring is the only thing preventing it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ChunkStreamer,
  MAX_WINDOW_CHUNKS,
  WINDOW_CELLS_X,
  WINDOW_CELLS_Y,
  WINDOW_LEVELS,
  WINDOW_MARGIN,
  chunkKey,
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
  it('is 7 x 5 x 2 = 70 cells', () => {
    assert.equal(WINDOW_CELLS_X, 5);
    assert.equal(WINDOW_CELLS_Y, 3);
    assert.equal(WINDOW_MARGIN, 1);
    assert.equal(WINDOW_LEVELS, 2);
    assert.equal(MAX_WINDOW_CHUNKS, 70);
    assert.equal(windowAddresses(0, 0, 0).length, MAX_WINDOW_CHUNKS);
  });

  it('covers the footprint plus one ring, centred', () => {
    const cells = windowAddresses(10, 20, 3).filter((a) => a.level === 3);
    const xs = cells.map((a) => a.cellX);
    const ys = cells.map((a) => a.cellY);
    assert.equal(Math.min(...xs), 10 - 3);
    assert.equal(Math.max(...xs), 10 + 3);
    assert.equal(Math.min(...ys), 20 - 2);
    assert.equal(Math.max(...ys), 20 + 2);
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
    // One column is 5 rows on each of 2 levels.
    const column = (2 * ((WINDOW_CELLS_Y - 1) / 2 + WINDOW_MARGIN) + 1) * WINDOW_LEVELS;
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
