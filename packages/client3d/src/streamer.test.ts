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
 * 4. **M6 derived the shape from the dolly's clamp; M8 made it symmetric.** The camera can be
 *    pointed anywhere now, so a ring with a lookahead in it would starve the frame at half a turn.
 *    The shape is a disc and the guarantee is a radius — checked here as arithmetic, and in
 *    `rig.test.ts` as the property that actually matters (the frame's own corners land on built
 *    cells, at every yaw). On a canvas too wide for the ring the *dolly* still gives way rather than
 *    the world.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CAMERA_DISTANCE_MAX } from './rig.ts';
import {
  ChunkStreamer,
  MAX_WINDOW_CHUNKS,
  RING_ASPECT,
  RING_CELLS,
  RING_COVER,
  RING_RADIUS,
  WINDOW_HALF,
  WINDOW_LEVELS,
  cellReach,
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
  it('is a 293-cell disc on two levels, derived from the far corner of the clamp', () => {
    /*
     * **These numbers have moved three times and every move was a decision somebody wrote down.**
     * M3's 7 x 5 x 2 = 70 was sized from a fixed 64-degree, 36 m frame; the camera slice took the rig
     * to 48 m at 45 degrees (9 x 6 x 2 = 108); the owner's *"about 100% more"* doubled the ceiling to
     * 96 m (15 x 10 x 2 = 300); and M8's free yaw made the shape a **disc**, because a rectangle with
     * a lookahead in it is a statement about which way the camera points and the camera now points
     * wherever the owner drags it.
     *
     * 293 cells a level rather than the 361 of the square that covers the same radius — the disc's
     * 19% — and 586 chunks against 300, which is the price of the feature and is paid in `pool.ts`'s
     * pre-warm. Written as literals as well as derived, deliberately: a change to a clamp that
     * silently costs hundreds of chunks and tens of megabytes of instance buffer should fail a test
     * rather than land. It has done, twice.
     */
    assert.equal(WINDOW_HALF, 9, 'nine cells along an axis: 84.06 m of guarantee over a 10 m stride, plus the centre');
    assert.equal(WINDOW_LEVELS, 2);
    assert.equal(RING_CELLS.length, 293);
    assert.equal(MAX_WINDOW_CHUNKS, 586);
    assert.equal(windowAddresses(0, 0, 0).length, MAX_WINDOW_CHUNKS);
    // The guarantee everything else rests on, as one number: metres in *any* direction.
    assert.ok(Math.abs(RING_COVER.radius - 84.059) < 0.001, `${RING_COVER.radius} m`);
    assert.equal(RING_COVER.radius, RING_RADIUS);
    // It is a disc and not a square wearing one: the axes reach nine, the diagonal is cut to six.
    assert.ok(cellReach(9, 0) <= RING_RADIUS && cellReach(10, 0) > RING_RADIUS, 'the axis reach is not nine');
    assert.ok(cellReach(6, 6) <= RING_RADIUS && cellReach(7, 7) > RING_RADIUS, 'the diagonal reach is not six');
    assert.ok(RING_CELLS.length < (2 * WINDOW_HALF + 1) ** 2, 'the disc is the square after all');
  });

  it('is symmetric in both axes, because a lookahead is a claim about the yaw', () => {
    const cells = windowAddresses(10, 20, 3).filter((a) => a.level === 3);
    const xs = cells.map((a) => a.cellX - 10);
    const ys = cells.map((a) => a.cellY - 20);
    assert.equal(Math.min(...xs), -WINDOW_HALF);
    assert.equal(Math.max(...xs), WINDOW_HALF);
    assert.equal(Math.min(...ys), -WINDOW_HALF);
    assert.equal(Math.max(...ys), WINDOW_HALF);
    // Every cell's three mirrors are in too, or the shape has a bias somebody will find at 180°.
    const present = new Set(cells.map((a) => `${a.cellX - 10}:${a.cellY - 20}`));
    for (const [dx, dy] of RING_CELLS) {
      for (const [mx, my] of [
        [-dx, dy],
        [dx, -dy],
        [dy, dx],
      ]) {
        assert.ok(present.has(`${mx}:${my}`), `the window is not symmetric: ${dx},${dy} has no mirror ${mx},${my}`);
      }
    }
  });

  it('pulls the dolly ceiling in on a canvas too wide for the ring, rather than showing void', () => {
    // At the aspect it was sized for the full 96 m is available *exactly* — `RING_RADIUS` is derived
    // from that pose, so the two agree by construction rather than by leftover slack.
    assert.equal(maxDistanceForAspect(RING_ASPECT), CAMERA_DISTANCE_MAX);
    assert.equal(maxDistanceForAspect(4 / 3), CAMERA_DISTANCE_MAX);
    assert.equal(maxDistanceForAspect(16 / 10), CAMERA_DISTANCE_MAX);
    // Wider than 16:9 and the frame's own circumradius outgrows the disc, so the dolly gives way:
    // 88.9 m at 2:1, 78.2 at a 3440x1440 ultrawide. Both are *more* pull-back than the whole clamp
    // allowed before the owner doubled it, and neither is a metre of world nobody built.
    const twoToOne = maxDistanceForAspect(2);
    assert.ok(twoToOne > 87 && twoToOne < 91, `${twoToOne} m at 2:1`);
    assert.ok(twoToOne < CAMERA_DISTANCE_MAX);
    const ultrawide = maxDistanceForAspect(3440 / 1440);
    assert.ok(ultrawide > 76 && ultrawide < 80, `${ultrawide} m at 2.39:1`);
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

  it('trades one ragged column for one ragged column when the camera steps east', () => {
    const sink = new CountingSink();
    const streamer = new ChunkStreamer(sink);
    streamer.update(0, 0, 0);
    sink.reset();
    const step = streamer.update(1, 0, 0);
    // A disc's column is ragged rather than rectangular, so the count is measured rather than
    // multiplied — but it must *balance*, which is what says the shape did not drift on the step,
    // and it must stay a small fraction of the window, which is what says the ring has hysteresis.
    assert.equal(step.loaded, step.unloaded, 'a step east did not trade evenly');
    assert.equal(step.loaded, 38, 'the leading edge of the disc is 19 cells on each of two levels');
    assert.ok(step.loaded < MAX_WINDOW_CHUNKS / 8, 'a step is rebuilding too much of the window');
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
