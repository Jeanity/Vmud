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
 * ## M5a: the walk grows trees
 *
 * The scatter is the largest single source of instances in the renderer — 59,059 trees and 188,884
 * tufts over the built world — so a flat-ledger test that ran with the trees switched off would be
 * measuring M4 and reporting on M5. `TreeSet.standIn` fills the pool with proportioned stand-ins so
 * the whole path runs headless: the placements, the buckets, the LOD tier changes as the window
 * recentres, and the rebuilds those cause. A rebuild is a release and an acquire and must allocate
 * nothing, which is exactly what the baseline-to-end comparison says.
 *
 * ## M5c: the walk runs through the lens
 *
 * `World3D.setPlace` builds a {@link warp.WarpField} for every Place the walk enters, and every
 * placement in every chunk goes through it — the ground's four corner amplitudes written into a third
 * instanced attribute, and every wall cut into chords. **Both are things that could have allocated per
 * chunk and neither does**: the corner buffer is minted with the wrapper at boot, and the chord
 * expansion writes into one array this class reuses. The two numbers that say so are the same two this
 * file has always asserted — `wrappersCreated` unmoved and `bytes` identical between room 100 and room
 * 1,000 — with the walls now producing up to twice as many instances per bucket, which is the thing
 * that would have overflowed {@link WRAPPER_CAPACITY} if the chord span had been chosen carelessly.
 *
 * ## M6: the walk is 108 chunks wide, and the ledger says so out loud
 *
 * The dolly can pull the camera to 48 m and tilt it to 45°, which shows 24.8 m of ground ahead of the
 * character instead of 12.3 and 32.3 m either side instead of 20.4. The streaming ring is derived
 * from that pose (`streamer.ts`) and grew from 7 x 5 x 2 = 70 cells to 9 x 6 x 2 = 108, and the
 * pre-warmed pool grew with it because the pool is minted **once** — which is this file's own
 * acceptance and the reason the ceiling has to be the worst pose rather than the current one.
 *
 * So this file now pins {@link LEDGER_BYTES} absolutely as well as flatly. Flat has always been the
 * property that matters; the absolute number is here because M6 moved it by 52% in one commit and a
 * figure that large should be a line somebody chose rather than a line in a log nobody reads.
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

/**
 * The ledger's total, in bytes. **Update this once, deliberately, with the reason written down.**
 *
 * `197,940` of geometry (the seven built shapes plus the tree and kit stand-ins) and `7,939,968` of
 * per-instance buffer — 2,001 pre-warmed wrappers at `pool.WRAPPER_BYTES`, which is 32 instances x 31
 * floats. Both terms are decided in the constructor and neither can move while streaming, which is
 * what the flat assertions below say; this one says *what* they are flat at.
 *
 * | Milestone | Bytes | Why it moved |
 * | --- | --- | --- |
 * | M5b | 4,680,176 | the kit, the water and the puddles |
 * | M5c | 5,348,404 | `iWarp`'s four floats on every wrapper, and 3.6 KB of subdivided geometry |
 * | M6  | 8,137,908 | **the streaming ring, 70 cells to 108** — `+703` wrappers at 3,968 B |
 *
 * The M6 delta is `+2,789,504` B, all of it instance buffer and all of it a consequence of one
 * decision: the dolly's clamp reaches 48 m at 45°, `streamer.ts` derives the ring from that pose, and
 * `pool.ts` derives its pre-warm from the ring. Nothing here was chosen; the clamp was.
 */
const LEDGER_BYTES = 8_137_908;

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
    // M5a: the scatter must be running or this measures the wrong renderer. See the header.
    world.trees.standIn(world.pool);
    // M5b: and so must the kit, which after this milestone is a third of what a forest room grows
    // and *all* of what a road grows. A flat ledger measured with the understory switched off would
    // be a statement about M5a wearing M5b's version number.
    world.kit.standIn(world.pool);
    let visited = 0;
    let places = 0;
    let chunkHigh = 0;
    let treeHigh = 0;
    let scatterHigh = 0;
    let kitHigh = 0;
    let waterHigh = 0;
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
        const census = world.scatterCensus();
        treeHigh = Math.max(treeHigh, census.trees);
        scatterHigh = Math.max(scatterHigh, census.instances);
        kitHigh = Math.max(kitHigh, census.kit);
        waterHigh = Math.max(waterHigh, census.water);
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
      `[M6 traversal] ${visited} rooms across ${places} Places in ${Date.now() - started} ms\n` +
        `  pool          geometries ${end.geometries}  materials ${end.materials}  prewarmed ${end.prewarmed}\n` +
        `  programs      materials ${end.programs}  depth ${end.depthProgramCount}\n` +
        `  wrappers      created ${end.wrappersCreated}  live ${end.wrappersLive}  free ${end.wrappersFree}` +
        `  high-water ${end.wrapperHighWater}  of which attributed ${end.blendWrappers}\n` +
        `  churn         acquires ${end.acquires}  releases ${end.releases}\n` +
        `  chunks        high-water ${chunkHigh} of ${MAX_WINDOW_CHUNKS}\n` +
        `  scatter       trees high-water ${treeHigh}  kit high-water ${kitHigh}  ` +
        `instances high-water ${scatterHigh}\n` +
        `  water         chunks high-water ${waterHigh}\n` +
        `  bytes         at room ${BASELINE_ROOM}: ${baseline.bytes}   at room ${visited}: ${end.bytes}\n` +
        `                geometry ${end.geometryBytes} + instance ${end.instanceBytes}` +
        `  textures ${end.textureBytes}`,
    );

    assert.equal(end.geometries, baseline.geometries, 'the geometry pool grew');
    assert.equal(end.materials, baseline.materials, 'the material pool grew');
    assert.equal(end.wrappersCreated, baseline.wrappersCreated, 'wrappers were still being minted after room 100');
    assert.equal(end.bytes, baseline.bytes, 'the ledger is not flat');
    // …and flat *at the figure somebody chose*. See {@link LEDGER_BYTES} for the one-line history of
    // every time this has moved and why.
    assert.equal(end.bytes, LEDGER_BYTES, 'the ledger total moved — is that a decision or an accident?');
    assert.equal(baseline.bytes, LEDGER_BYTES);
    assert.equal(end.acquires - end.releases, end.wrappersLive, 'a wrapper was leaked or freed twice');
    assert.equal(end.wrappersLive + end.wrappersFree, end.wrappersCreated, 'the free list lost one');
    assert.ok(end.acquires > 5000, `only ${end.acquires} acquires — the walk is not exercising the pool`);
    // The empirical half of the ceiling argument: the pre-warm was never exhausted, so nothing was
    // minted after boot and `wrappersCreated` is a constant rather than a plateau.
    assert.equal(end.wrappersCreated, end.prewarmed, 'a bucket overflowed the ceiling the pool was sized for');
    assert.ok(end.wrapperHighWater < end.prewarmed, 'the ceiling has no headroom left');
    // M5a: the walk actually grew things. Without this the flat ledger above would be a statement
    // about a renderer with the trees switched off. Three programs and one depth program, fixed at
    // boot and unmoved by a thousand rooms of streaming.
    assert.ok(treeHigh > 20, `only ${treeHigh} trees ever stood in the window`);
    assert.ok(scatterHigh > 200, `only ${scatterHigh} scatter instances at the peak`);
    // M5b: the kit and the water both ran. Without these the flat ledger above would be a statement
    // about a renderer with the understory and the lakes switched off.
    assert.ok(kitHigh > 40, `only ${kitHigh} kit instances at the peak`);
    // Seven colour programs and two depth, fixed at boot and unmoved by a thousand rooms of
    // streaming. See `pool.programKeys` for why `map` and `vertexColors` are in the proxy's key.
    assert.equal(end.programs, 7, 'the material pool grew a program while streaming');
    assert.equal(end.depthProgramCount, 2);
    assert.equal(end.programs, baseline.programs);
    // Nothing loaded a texture headlessly, so the texture ledger must still be zero — the number that
    // would otherwise hide a per-chunk load creeping in behind the geometry pool's back.
    assert.equal(end.textures, 0);
    assert.equal(end.textureBytes, 0);

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
