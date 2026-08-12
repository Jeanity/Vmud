/**
 * M3 acceptance: **a 1,000-room traversal with a flat ledger.**
 *
 * The plan calls this the single most likely way the design dies quietly:
 *
 * > *"GPU memory leak from streaming. With continuous traversal of a 46,500-room world, unpooled
 * > geometry and materials will leak until the tab dies after 20–40 minutes. The pooled-per-archetype
 * > rule is architecture, not optimisation, and the flat-`renderer.info.memory` test at M3 is not
 * > optional."*
 *
 * And it is one of the five stop-the-project triggers: *"The flat-memory test at M3 cannot be made
 * to pass after a serious attempt at pooling."* So it runs on every commit, and it runs **headless**.
 *
 * ## Why the ledger and not `renderer.info.memory`
 *
 * `renderer.info.memory` counts what a `WebGLRenderer` has uploaded, and a `WebGLRenderer` needs a
 * GPU. CI has none. What it counts, though, is downstream of exactly three decisions — how many
 * geometries were made, how many materials were made, how many `InstancedMesh` buffers were minted —
 * and `pool.ts` is the only place any of the three can happen, so it counts them itself. The debug
 * object exposes both numbers side by side (`__debug3d.ledger` and `__debug3d.rendererMemory`) so a
 * human can confirm the proxy once in a browser; this file is the version that can run without one.
 *
 * ## What "flat" is asserted to mean
 *
 * Between the 100th room and the 1,000th, with no tolerance:
 *
 * - the geometry pool and the material pool are the same size;
 * - `wrappersCreated` — every `InstancedMesh` ever minted — has not moved;
 * - therefore `bytes` has not moved;
 * - `acquires - releases === wrappersLive`, so nothing was leaked or double-freed on the way;
 * - the live chunk count never exceeded `MAX_WINDOW_CHUNKS`.
 *
 * The 100th room is the baseline rather than the first because the free list is genuinely cold at
 * the start: the first window mints its wrappers, and a handful more arrive as the walk meets its
 * first dense cell. What must not happen is that the minting *continues*.
 *
 * Follows `worldgen/src/roomscene-world.test.ts`'s skip-if-absent shape: `data/world` is git-ignored
 * and reproducible with `npm run worldgen`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CARDINALS,
  ROOM_TILES,
  TILE_SIZE,
  buildZoneTilemap,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Room,
  type Zone,
} from '@mygame/shared';

import { planChunk } from './chunkPlan.ts';
import { ROOM_METRES, cellOriginTiles, placeFrame } from './frame.ts';
import { MAX_WINDOW_CHUNKS } from './streamer.ts';
import { World3D } from './world3d.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/** How many rooms the walk visits. The plan's number. */
const TRAVERSAL_ROOMS = 1000;
/** Where the baseline is taken, once the free list has warmed. */
const BASELINE_ROOM = 100;

describe('M3: streaming a real world with a flat ledger', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const started = Date.now();
  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone)
    // Sorted by id, not by directory order, so the walk is the same on every machine.
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  /** The level of a zone with the most rooms on it — the one a player is most likely to be on. */
  function busiestLevel(zone: Zone): number {
    const counts = new Map<number, number>();
    for (const room of zone.rooms) counts.set(room.pos.z, (counts.get(room.pos.z) ?? 0) + 1);
    let best = 0;
    let most = -1;
    for (const [level, count] of [...counts].sort((a, b) => a[0] - b[0])) {
      if (count > most) {
        most = count;
        best = level;
      }
    }
    return best;
  }

  /**
   * A spatially coherent walk over a level's rooms: rows north to south, alternating direction.
   *
   * Not the room graph, deliberately — the streamer is spatial and a graph walk would flatter it by
   * only ever visiting cells that are linked. A boustrophedon crosses barriers, walks over voids and
   * doubles back, which is what a camera does.
   */
  function serpentine(zone: Zone, level: number): Room[] {
    const here = zone.rooms.filter((room) => room.pos.z === level);
    here.sort((a, b) => (a.pos.y - b.pos.y) || (a.pos.y % 2 === 0 ? a.pos.x - b.pos.x : b.pos.x - a.pos.x));
    return here;
  }

  it(`walks ${TRAVERSAL_ROOMS} rooms of the built world without allocating`, () => {
    const world = new World3D();
    let visited = 0;
    let places = 0;
    let chunkHigh = 0;
    let baseline: ReturnType<World3D['ledger']> | undefined;

    outer: for (const zone of zones) {
      const level = busiestLevel(zone);
      const order = serpentine(zone, level);
      if (order.length === 0) continue;
      world.setPlace(zone, level);
      places += 1;
      const frame = placeFrame(zone, level);

      for (const room of order) {
        // The centre of the room, in simulation pixels — what `EntityView.x/y` carries.
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        world.update((origin.tx + ROOM_TILES / 2) * TILE_SIZE, (origin.ty + ROOM_TILES / 2) * TILE_SIZE);
        // The camera and every body ask this every frame; it must not accumulate either.
        world.groundAt((origin.tx + ROOM_TILES / 2) * TILE_SIZE, (origin.ty + ROOM_TILES / 2) * TILE_SIZE);
        visited += 1;
        chunkHigh = Math.max(chunkHigh, world.chunksLoaded);
        assert.ok(
          world.chunksLoaded <= MAX_WINDOW_CHUNKS,
          `${world.chunksLoaded} chunks live, over the ${MAX_WINDOW_CHUNKS} bound, at room ${visited}`,
        );
        if (visited === BASELINE_ROOM) baseline = world.ledger();
        if (visited >= TRAVERSAL_ROOMS) break outer;
      }
    }

    assert.equal(visited, TRAVERSAL_ROOMS, 'the built world is too small to walk a thousand rooms');
    assert.ok(baseline, 'no baseline taken');
    const end = world.ledger();

    console.log(
      `[M3 traversal] ${visited} rooms across ${places} Places in ${Date.now() - started} ms\n` +
        `  pool          geometries ${end.geometries}  materials ${end.materials}  prewarmed ${end.prewarmed}\n` +
        `  wrappers      created ${end.wrappersCreated}  live ${end.wrappersLive}  free ${end.wrappersFree}` +
        `  high-water ${end.wrapperHighWater}\n` +
        `  churn         acquires ${end.acquires}  releases ${end.releases}\n` +
        `  chunks        high-water ${chunkHigh} of ${MAX_WINDOW_CHUNKS}\n` +
        `  bytes         at room ${BASELINE_ROOM}: ${baseline.bytes}   at room ${visited}: ${end.bytes}\n` +
        `                geometry ${end.geometryBytes} + instance ${end.instanceBytes}`,
    );

    assert.equal(end.geometries, baseline.geometries, 'the geometry pool grew');
    assert.equal(end.materials, baseline.materials, 'the material pool grew');
    assert.equal(end.wrappersCreated, baseline.wrappersCreated, 'wrappers were still being minted after room 100');
    assert.equal(end.bytes, baseline.bytes, 'the ledger is not flat');
    assert.equal(end.acquires - end.releases, end.wrappersLive, 'a wrapper was leaked or freed twice');
    assert.equal(end.wrappersLive + end.wrappersFree, end.wrappersCreated, 'the free list lost one');
    assert.ok(end.acquires > 5000, `only ${end.acquires} acquires — the walk is not exercising the pool`);
    // The empirical half of the ceiling argument: the pre-warm was never exhausted, so nothing was
    // minted after boot and `wrappersCreated` is a constant rather than a plateau.
    assert.equal(end.wrappersCreated, end.prewarmed, 'a bucket overflowed the ceiling the pool was sized for');
    assert.ok(end.wrapperHighWater < end.prewarmed, 'the ceiling has no headroom left');

    world.dispose();
  });

  it('renders the level below faded and never builds the level above', () => {
    // A zone with rooms above *and* below one level, so both halves of the policy are exercised by
    // the same walk. Skullport (18 levels) and the Comarian Mines (a 21-room stack) are the cases
    // the plan names; picking the deepest zone in the built world finds one of them without
    // hard-coding an id that a re-harvest could move.
    let deepest: { zone: Zone; level: number; rooms: Room[] } | undefined;
    for (const zone of zones) {
      const levels = [...new Set(zone.rooms.map((r) => r.pos.z))].sort((a, b) => a - b);
      if (levels.length < 3) continue;
      const middle = levels[Math.floor(levels.length / 2)]!;
      const here = zone.rooms.filter((r) => r.pos.z === middle);
      const below = zone.rooms.filter((r) => r.pos.z === middle - 1);
      if (here.length < 20 || below.length < 20) continue;
      if (!deepest || levels.length > new Set(deepest.zone.rooms.map((r) => r.pos.z)).size) {
        deepest = { zone, level: middle, rooms: here };
      }
    }
    assert.ok(deepest, 'no zone in the built world stacks three levels — the policy cannot be tested');
    const target = deepest;

    const world = new World3D();
    world.setPlace(target.zone, target.level);
    const frame = placeFrame(target.zone, target.level);
    let sawBelow = 0;
    for (const room of target.rooms.slice(0, 60)) {
      const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
      world.update((origin.tx + ROOM_TILES / 2) * TILE_SIZE, (origin.ty + ROOM_TILES / 2) * TILE_SIZE);
      const { levels, faded } = world.chunkLevels();
      for (const key of Object.keys(levels)) {
        const level = Number(key);
        assert.ok(level <= target.level, `level ${level} was built with the camera on ${target.level}`);
        assert.ok(level >= target.level - 1, `level ${level} is two below the camera`);
      }
      const below: number = levels[target.level - 1] ?? 0;
      sawBelow = Math.max(sawBelow, below);
      // Everything on the level below is faded, and nothing else is: no `seen` bitset has arrived,
      // so the camera's own level is drawn fully present. See `World3D.isFaded`.
      assert.equal(faded, below, 'the fade and the level below must be the same set before any fog');
    }
    console.log(
      `[M3 vertical] zone ${target.zone.id} level ${target.level}: ` +
        `${sawBelow} faded chunks below at the peak, 0 above, ever`,
    );
    assert.ok(sawBelow > 0, 'the walk never came within a window of the level below');
    world.dispose();
  });

  it('places every room block exactly where the collision grid does', () => {
    let checked = 0;
    for (const zone of zones) {
      const levels = new Set(zone.rooms.map((room) => room.pos.z));
      for (const level of levels) {
        const grid = buildZoneTilemap(zone, level);
        const frame = placeFrame(zone, level);
        assert.equal(frame.widthTiles, grid.width, `zone ${zone.id} level ${level} width`);
        assert.equal(frame.heightTiles, grid.height, `zone ${zone.id} level ${level} height`);
        for (const [id, origin] of grid.roomOrigins) {
          const room = rooms.get(id)!;
          assert.deepEqual(cellOriginTiles(frame, room.pos.x, room.pos.y), origin, `room ${id}`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 40000, `only ${checked} room origins checked`);
  });

  it('grows solid geometry across every solid edge in the world', () => {
    let solid = 0;
    let failures = 0;
    const examples: string[] = [];
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const frames = new Map<number, ReturnType<typeof placeFrame>>();
      for (const room of zone.rooms) {
        let frame = frames.get(room.pos.z);
        if (!frame) {
          frame = placeFrame(zone, room.pos.z);
          frames.set(room.pos.z, frame);
        }
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        const plan = planChunk({ scene, origin, elevation: 0, gap: frame.gap, faded: false, doorClosed: {} });
        const x0 = origin.tx;
        const z0 = origin.ty;
        for (const dir of CARDINALS) {
          if (!scene.edges[dir].solid) continue;
          solid += 1;
          const lateral = dir === 'north' || dir === 'south';
          const wall = plan.find((p) => {
            if (p.archetype !== 'edge' && p.archetype !== 'barrier') return false;
            if (lateral) {
              const near = dir === 'north' ? z0 : z0 + ROOM_METRES;
              return Math.abs(p.z - near) < 2 && p.sx >= ROOM_METRES;
            }
            const near = dir === 'west' ? x0 : x0 + ROOM_METRES;
            return Math.abs(p.x - near) < 2 && p.sz >= ROOM_METRES;
          });
          if (!wall) {
            failures += 1;
            if (examples.length < 10) examples.push(`room ${room.id} ${dir}`);
          }
        }
      }
    }
    console.log(`[M3 solidity] ${solid} solid edges swept, ${failures} without a wall`);
    assert.equal(failures, 0, `solid edges with no geometry:\n${examples.join('\n')}`);
    assert.ok(solid > 50000, `only ${solid} solid edges — the sweep is not reaching the world`);
  });
});
