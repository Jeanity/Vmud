/**
 * **What a tile grid costs, measured against the zone that used to be unbuildable** — M0,
 * `docs/PLAN-3d-migration.md` §4 Layer A and §6.
 *
 * `buildZoneTilemap` used to allocate three dense typed arrays sized to a level's *bounding box*, and
 * a bounding box is not an occupancy. Zone 317 "The Roads of the Heartland" is the plan's named
 * example and it is worse than the plan says once you build it level by level: 358 rooms across
 * eleven levels, whose grids together span 91.0 million tiles and so asked for **521.1 MB** — 225.9 MB
 * of that for level 7 alone, which is 58 rooms rattling around a 4917x8030-tile box. That is not a
 * tuning problem, it is a zone the server cannot load and the client cannot draw.
 *
 * This lives in the server package rather than in `shared` for the same reason `seamless.test.ts`
 * does: it needs the built world on disk, and `@mygame/shared` is not allowed I/O — not in its source
 * and not, by the same argument, in its tests. `shared`'s own `tilemap.test.ts` holds the structural
 * invariants (chunk laziness, allocation following occupancy) against synthetic zones, which is what
 * runs on a checkout with no `data/world/`.
 *
 * The assertion is deliberately **not** on `process.memoryUsage`. That moves with the garbage
 * collector and with whatever else the test runner is holding, so a ceiling written against it fails
 * on a Tuesday for no reason. {@link gridBytes} counts the chunks the structure actually allocated,
 * which is the number the change was made to move.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildZoneTilemap, gridBytes } from '@mygame/shared';

import { WORLD_DIR, loadZone } from './world.ts';

/** "The Roads of the Heartland" — the plan's worked example, and the worst case in the world. */
const HEARTLAND = 317;

const built = existsSync(`${WORLD_DIR}/zones/${HEARTLAND}.json`);

/**
 * The bytes the dense arrays would have taken: one `Uint8Array` of kinds, one of sectors, and an
 * `Int32Array` of room ids, over every tile of the bounding box.
 */
const DENSE_BYTES_PER_TILE = 1 + 1 + 4;

/**
 * The ceiling, in bytes, for **every level of zone 317 built at once**.
 *
 * Measured today: 214,016 B in 418 chunks, against 546,401,676 B dense. Half a megabyte is a little
 * over twice that, which is headroom for a chunk edge that changes, for scenery that grows denser, or
 * for a carve rule that touches more of the gap — and is still three orders of magnitude below the
 * dense figure and an order of magnitude below the plan's ~6.4 MB budget for the *entire* 46,500-room
 * world. A ceiling with no headroom is a test that fails on every unrelated change; a ceiling with
 * too much is a test that never fails at all. This one would catch any return to per-tile allocation
 * immediately, because the smallest such regression here is a factor of 2,500.
 */
const CEILING_BYTES = 512 * 1024;

describe('what a tile grid costs — zone 317, the plan’s worked example', () => {
  if (!built) {
    it('skipped: no built world on this checkout', () => {
      // `data/world/` is git-ignored and reproducible; a fresh clone has no zones until worldgen
      // runs. Skipping loudly beats failing on an absence that is expected. The structural half of
      // this milestone is in `shared/src/tilemap.test.ts` and always runs.
      assert.ok(true);
    });
    return;
  }

  const zone = loadZone(HEARTLAND);
  const levels = [...new Set(zone.rooms.map((r) => r.pos.z))].sort((a, b) => a - b);

  it('is the zone the plan named: a few hundred rooms in a box of tens of millions of tiles', () => {
    // Guarding the guard. If the harvest ever renumbers or shrinks this zone, the ceiling below stops
    // meaning anything and this says so instead of passing quietly.
    assert.ok(zone.rooms.length > 300, `${zone.rooms.length} rooms`);
    assert.ok(levels.length >= 10, `${levels.length} levels`);
    const tiles = levels.reduce((sum, level) => {
      const grid = buildZoneTilemap(zone, level);
      return sum + grid.width * grid.height;
    }, 0);
    assert.ok(tiles > 50_000_000, `only ${tiles} tiles of bounding box — is this still the sparse zone?`);
  });

  it('builds all eleven levels under the ceiling', () => {
    let allocated = 0;
    let dense = 0;
    let chunks = 0;
    const worst: string[] = [];
    for (const level of levels) {
      const grid = buildZoneTilemap(zone, level);
      allocated += gridBytes(grid);
      chunks += grid.chunks.size;
      dense += grid.width * grid.height * DENSE_BYTES_PER_TILE;
      worst.push(`${level}: ${grid.width}x${grid.height} -> ${gridBytes(grid)} B`);
    }

    assert.ok(
      allocated < CEILING_BYTES,
      `zone ${HEARTLAND} allocated ${allocated} B in ${chunks} chunks, over the ${CEILING_BYTES} B ` +
        `ceiling\n  ${worst.join('\n  ')}`,
    );
    // And the thing it replaced, so the number above is read against something. If this ever stops
    // being enormous, the bounding boxes have changed and the ceiling wants re-deriving.
    assert.ok(dense > 400 * 1024 * 1024, `the dense arrays would have been ${dense} B`);
    assert.ok(dense / allocated > 1000, `only ${(dense / allocated).toFixed(0)}x better than dense`);
  });

  it('holds on level 7 in particular, which is 58 rooms in a 39-million-tile box', () => {
    // The single worst level, and the one that made the whole zone unloadable: 225.9 MB of dense
    // arrays for 4,698 tiles of floor. Called out separately so a regression names the level.
    const grid = buildZoneTilemap(zone, 7);
    const tiles = grid.width * grid.height;
    assert.ok(tiles > 30_000_000, `fixture: level 7 spans ${tiles} tiles`);
    assert.ok(
      gridBytes(grid) < 64 * 1024,
      `level 7 allocated ${gridBytes(grid)} B in ${grid.chunks.size} chunks`,
    );
  });

  it('allocates for the rooms and not for the gaps between them', () => {
    // The laziness property, stated against real data: a level of this zone touches a handful of
    // chunks per room, not one per cell of its span. Four is the most a 9x9 block on an 11-tile stride
    // can straddle, and carves add at most the gap around them.
    for (const level of levels) {
      const grid = buildZoneTilemap(zone, level);
      const rooms = zone.rooms.filter((r) => r.pos.z === level).length;
      assert.ok(
        grid.chunks.size <= rooms * 4,
        `level ${level}: ${grid.chunks.size} chunks for ${rooms} rooms`,
      );
    }
  });
});
