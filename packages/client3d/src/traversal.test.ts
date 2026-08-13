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
 * **M8 is the largest single move that pin has ever caught, and it caught it.** The owner asked to
 * orbit the camera; the ring stopped being a rectangle with a lookahead and became a disc; 300 chunks
 * became 586 and the ledger 45.6 MB. Every byte of it is instance buffer, none of it is geometry, and
 * the whole of it is one decision in `streamer.ts` — which is exactly what this file exists to make
 * visible rather than surprising.
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
  cellKey,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Room,
  type Zone,
} from '@mygame/shared';

import { CharacterSet } from './characters.ts';
import { planChunk, type Placement } from './chunkPlan.ts';
import { EntityLayer } from './entities.ts';
import { ROOM_METRES, cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import { occludingSides, planInterior, roleOfPlacement } from './interior.ts';
import { BODY_POOL_SIZE, BODY_RIG_BYTES } from './pool.ts';
import { VILLAGE_METRICS, groundTextureOf } from './prototypes.ts';
import { treelineFor } from './scatter.ts';
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
 * | M6 camera | 8,137,908 | **the streaming ring, 70 cells to 108** — `+703` wrappers at 3,968 B |
 * | M6 interiors | 8,582,412 | the `ceiling` archetype (+108 wrappers) and 19 village stand-ins |
 * | zoom x2 | 23,438,604 | **the owner's "about 100% more"**: the dolly ceiling 48 -> 96 m, the ring 108 -> 300 cells with the shadow pad folded into the derivation — +3,744 wrappers at 3,968 B, zero geometry |
 * | M7b | 23,517,236 | **+78,632 B, and it is the first per-*entity* term in this table.** `+3,968` is one more wrapper — the `creature:` capsules' own, which carry a per-instance colour the two people wrappers must not. `+73,920` is **seven body rigs at 10,560 B**, the high-water of the churn this walk now runs; unlike everything else here they cannot be pre-warmed (there are no bones to clone until a pack has loaded), so they climb from zero and then stop, and the stopping is what is asserted. `+744` is four stand-in character geometries. |
 * | M8 orbit | 45,646,772 | **+22,129,536 B: `+5,577` wrappers at 3,968 B, zero geometry, zero rigs.** The owner's Shift+drag. A streaming ring with a lookahead is a claim about which way the camera points, so the ring became a symmetric **disc** — 293 cells a level, 586 chunks against 300 — and `pool.ts` derived its pre-warm from it as it always has: `586 x 10 + 293 x 16 + 4 = 10,552`, plus 586 ground and 293 water wrappers on their own lists = 11,431. Nothing here was chosen; the shape was. The two alternatives and their prices are in `streamer.ts`: rotating the window with the view costs a rebuild *during* every orbit gesture, and the 19 x 19 square that covers the same radius costs another 136 cells a level (`+10.8 MB`) for the corners no frame can reach. |
 * | M9 furniture | 49,175,804 | **+3,529,032 B, and none of it is the furniture.** `+3,487,872` is `+879` wrappers at 3,968 B: `pool.DRESSED_WRAPPER_CEILING` went `max(15 + 1, 11) = 16` to `max(15 + 1 + 3, 11 + 6) = 19`, so `586 x 10 + 293 x 19 + 4 = 11,431` pre-warmed plus 586 ground and 293 water = 12,310. The `+6` is the furniture and it is **free**, because it rides the interior side of a `max` that the understory was already winning; the `+3` that actually moved the number is the **scenery** term — dressing an authored `cart` with a market stall, on chunks that grow scatter too, because all ten of the world's authored scenery props stand in outdoor `city` and `road` rooms. Three carts in one hand-authored zone for 3.49 MB is a poor rate against today's content and a fair one against the slot: `Room.scenery` is the seam the owner authors through. `+41,160` is geometry: forty-nine props stand-in boxes at 840 B, the headless proxy for the twenty-six real models (in a browser this term is their own vertex data — 41,689 triangles across the drawn set). **The wall texture that answers the owner's actual complaint is not in this row at all** — it is a `sampler2D` on materials that already existed, which is exactly why it beat a village module; see `prototypes.WALL_TEXTURES` for the `+8,138,368 B` the module would have cost. |
 *
 * The camera delta was `+2,789,504` B, all of it instance buffer and all of it a consequence of one
 * decision: the dolly's clamp reaches 48 m at 45°, `streamer.ts` derives the ring from that pose, and
 * `pool.ts` derives its pre-warm from the ring. Nothing there was chosen; the clamp was.
 *
 * **The interiors delta is `+444,504` B and it is two things, both small on purpose.** `+428,544` is
 * instance buffer: one `ceiling` wrapper for each of the 108 window chunks, which is the lid every
 * roofed room in the world gets and the whole of what makes *"no sky from an interior"* true without
 * an art asset in the build. `+15,960` is geometry: nineteen village stand-in boxes at 840 B, the
 * headless proxy for the eleven real modules (in a browser this term is the modules' own vertex data
 * — 117,880 triangles across the imported pack, of which the drawn subset is a few thousand).
 *
 * What is **not** in that delta is the second rendering mode's dressing, and its absence is the
 * design: `pool.DRESSED_WRAPPER_CEILING` was `max(scatter + puddle, interior) = max(16, 11)`, because
 * a room is dressed by `interior.ts` only when it is roofed and `inside`, and none of the four
 * scatter tables has an `inside` row. Interiors fit inside the budget the understory already had.
 *
 * **M9's furniture fits inside it too, and that is the point of where it was put.** `planFurniture`
 * refuses every room `interior.dressable` refuses — the same predicate, imported rather than
 * restated — so the six furniture buckets are added to the *interior* term rather than becoming a
 * third one, and the `max` is still a `max` over two things no chunk can want at once. `11 + 6 = 17`
 * is under `15 + 1`, so ten thousand furnished rooms cost nothing. The three buckets that did move it
 * are the dressed **scenery**, which lands on outdoor chunks and therefore has to be summed with the
 * understory rather than maxed against it.
 */
const LEDGER_BYTES = 49_175_804;

/**
 * The stand-in armature and cast the body churn runs on — M7b.
 *
 * Names rather than the real 65, because what the churn exercises is the *pool*, not the vendor's
 * weights: `characters.test.ts` asserts the real files bind 65 joints under these names and
 * `skin.test.ts` asserts the cull against the real vertices. Here a rig only has to be a rig.
 */
const CHURN_JOINTS = ['root', 'pelvis', 'spine_01', 'Head', 'hand_r', 'hand_l', 'thigh_r', 'foot_r'];
const CHURN_STEMS = [
  'Superhero_Male_FullBody',
  'Superhero_Female_FullBody',
  'Male_Peasant_Body',
  'Sword_Bronze',
];

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
    // M6: and so must the village, which after this milestone is *every* bucket an interior chunk
    // has. A flat ledger measured with the interiors switched off would be a statement about M5c
    // wearing M6's version number, and 47.2% of the world is roofed or paved.
    world.village.standIn(world.pool);
    // M9: **and so must the furniture**, which is now more than a third of a furnished interior's
    // buckets and all of a dressed cart's. A flat ledger measured with the props kit switched off
    // would be a statement about M6 wearing M9's version number — the same sentence the three lines
    // above make, and the reason the ledger's own delta table can name the scenery term.
    world.props.standIn(world.pool);
    // M7b: **and so must the bodies.** A flat ledger measured with nobody in the world would be a
    // statement about a renderer that draws rooms, and the whole of this milestone is the first
    // allocation family in `pool.ts` that is *per entity* rather than per chunk. Every room the walk
    // enters is populated and emptied through the real `EntityLayer`, so `rigsCreated` is exercised by
    // the same acquire/release seam `entityEnter`/`entityLeave` drive.
    const characters = new CharacterSet();
    characters.standIn(world.pool, CHURN_JOINTS, CHURN_STEMS);
    const entities = new EntityLayer(world.scene, world.pool, characters);
    let nextEntity = 1;
    let bodyHigh = 0;
    let visited = 0;
    let places = 0;
    let chunkHigh = 0;
    let treeHigh = 0;
    let scatterHigh = 0;
    let kitHigh = 0;
    let waterHigh = 0;
    let villageHigh = 0;
    let interiorHigh = 0;
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
        villageHigh = Math.max(villageHigh, census.village);
        interiorHigh = Math.max(interiorHigh, census.interiors);
        assert.ok(
          world.chunksLoaded <= MAX_WINDOW_CHUNKS,
          `${world.chunksLoaded} chunks live, over the ${MAX_WINDOW_CHUNKS} bound, at room ${visited}`,
        );
        // A room's population, entering and leaving. The count cycles 0..7 so the free list is both
        // outgrown and left slack, and the sexes alternate so both lists churn — a body pool that
        // recycled only one of them would still look flat if only one were ever asked for.
        const population = visited % 8;
        for (let i = 0; i < population; i++) {
          const stem = (visited + i) % 2 === 0 ? 'Superhero_Male_FullBody' : 'Superhero_Female_FullBody';
          entities.upsert({
            id: nextEntity++,
            kind: 'mob',
            name: 'a walk-on',
            sprite: 'human',
            x: (origin.tx + ROOM_TILES / 2) * TILE_SIZE,
            y: (origin.ty + ROOM_TILES / 2) * TILE_SIZE,
            facing: 'north',
            model: `base:${stem}`,
            ...(i % 3 === 0 ? { gear: [{ slot: 'torso', part: 'outfit:Male_Peasant_Body' }] } : {}),
            ...(i % 4 === 0 ? { hands: { main: 'prop:Sword_Bronze' } } : {}),
            yaw: 0,
          });
        }
        bodyHigh = Math.max(bodyHigh, entities.rigged);
        entities.render(1 / 60, (px, py) => world.groundAt(px, py));
        for (const id of entities.ids()) entities.remove(id);
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
        `  interiors     dressed chunks high-water ${interiorHigh}  ` +
        `village modules high-water ${villageHigh}\n` +
        `  bodies        rigs created ${end.rigsCreated}  high-water ${end.rigHighWater} of ${BODY_POOL_SIZE}  ` +
        `refused ${end.rigsRefused}  drawn high-water ${bodyHigh}  ${end.rigBytes} B\n` +
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
    // **M7b's half of the same property.** A rig cannot be pre-warmed — there are no bones to clone
    // until a pack has loaded — so unlike the wrappers it climbs from zero and then must *stop*. Flat
    // between room 100 and room 1,000 is the whole assertion; the high-water is what says the walk
    // actually asked for bodies rather than sailing under the cap on an empty world.
    assert.equal(end.rigsCreated, baseline.rigsCreated, 'rigs were still being minted after room 100');
    assert.equal(end.rigsLive, 0, 'a body left the room and kept its skeleton');
    assert.equal(end.rigsLive + end.rigsFree, end.rigsCreated, 'the body free list lost one');
    assert.equal(end.rigsRefused, 0, `the cap was hit ${end.rigsRefused} times on a real walk`);
    assert.ok(end.rigsCreated <= BODY_POOL_SIZE, `${end.rigsCreated} rigs, over the cap`);
    assert.ok(bodyHigh >= 7, `only ${bodyHigh} bodies were ever drawn — the churn is not exercising the pool`);
    assert.equal(end.rigBytes, end.rigsCreated * BODY_RIG_BYTES);
    // M5a: the walk actually grew things. Without this the flat ledger above would be a statement
    // about a renderer with the trees switched off. Three programs and one depth program, fixed at
    // boot and unmoved by a thousand rooms of streaming.
    assert.ok(treeHigh > 20, `only ${treeHigh} trees ever stood in the window`);
    assert.ok(scatterHigh > 200, `only ${scatterHigh} scatter instances at the peak`);
    // M5b: the kit and the water both ran. Without these the flat ledger above would be a statement
    // about a renderer with the understory and the lakes switched off.
    assert.ok(kitHigh > 40, `only ${kitHigh} kit instances at the peak`);
    // M6: the walk dressed real interiors. Without this the flat ledger above would be a statement
    // about a renderer with the second mode switched off, which is 47.2% of the world.
    assert.ok(villageHigh > 40, `only ${villageHigh} village modules at the peak`);
    assert.ok(interiorHigh > 3, `only ${interiorHigh} chunks were ever dressed as interiors`);
    // Nine colour programs and two depth, fixed at boot and unmoved by a thousand rooms of
    // streaming. See `pool.programKeys` for why `map`, `vertexColors` and — M7b — `skinned` are in the
    // proxy's key. Seven until M7b, which added the character material (no wetness patch, so its own
    // cache key) and the character *prop* (a rigid `Mesh` beside a `SkinnedMesh`, so its own
    // `USE_SKINNING` define). Both are compiled at boot like everything else here.
    assert.equal(end.programs, 9, 'the material pool grew a program while streaming');
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

  it('grows solid geometry across every solid edge in the world, dressed or not', () => {
    // **The correctness property M6 could most easily have broken.** §4 calls a barrier a
    // *correctness requirement, not aesthetics* — "the player can otherwise see into a room they
    // cannot reach" — and `chunkPlan`'s `dressed` flag now **suppresses** the grey box on an inside
    // room's side, because a 0.6 m box and a 0.61 m village panel each protrude past the other and a
    // street would see grey standing behind its own plaster.
    //
    // So the sweep is stronger than M3's in two ways. It runs the whole world **twice**, once with
    // the village kit absent (grey boxes) and once with it present (village chords), because both are
    // states a real client is in — the manifest is git-ignored and arrives a second after the first
    // chunk. And it checks **coverage** rather than the existence of one wall: the union of every
    // wall interval along the side must span the full nine metres, which is the assertion that
    // catches three chords where there should be three and a half.
    for (const dressed of [false, true]) {
      let solid = 0;
      let failures = 0;
      let chords = 0;
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
          const plan = planChunk({
            scene,
            origin,
            elevation: 0,
            gap: frame.gap,
            faded: false,
            doorClosed: {},
            dressed,
          });
          const inside = dressed
            ? planInterior({
                scene,
                origin,
                elevation: 0,
                roofOpen: false,
                top: true,
                openSides: occludingSides(64).sides,
              })
            : [];
          chords += inside.filter((p) => roleOfPlacement(p) === 'wall').length;
          const x0 = metresOfTile(origin.tx);
          const z0 = metresOfTile(origin.ty);
          for (const dir of CARDINALS) {
            if (!scene.edges[dir].solid) continue;
            solid += 1;
            const lateral = dir === 'north' || dir === 'south';
            // Where this side's boundary line is, and how far a placement may be from it and still
            // be part of it. One metre: a grey box's centre sits `thickness / 2` out (0.7 m at most)
            // and a village panel's origin sits exactly on the line.
            const line = lateral
              ? dir === 'north'
                ? z0
                : z0 + ROOM_METRES
              : dir === 'west'
                ? x0
                : x0 + ROOM_METRES;
            const spans: [number, number][] = [];
            for (const p of [...plan, ...inside]) {
              const wall =
                p.archetype === 'edge' || p.archetype === 'barrier' || roleOfPlacement(p) === 'wall';
              if (!wall) continue;
              const across = lateral ? p.z : p.x;
              if (Math.abs(across - line) > 1) continue;
              // A village chord is rotated, so its run is `sx` scaled onto the module's own 2 m
              // width; a grey box's run is whichever of `sx`/`sz` lies along the side.
              const run =
                p.archetype === 'edge' || p.archetype === 'barrier'
                  ? lateral
                    ? p.sx
                    : p.sz
                  : p.sx * VILLAGE_METRICS.module;
              const centre = lateral ? p.x : p.z;
              spans.push([centre - run / 2, centre + run / 2]);
            }
            if (!covers(spans, lateral ? x0 : z0, ROOM_METRES)) {
              failures += 1;
              if (examples.length < 10) examples.push(`room ${room.id} ${dir} (dressed=${dressed})`);
            }
          }
        }
      }
      console.log(
        `[M6 solidity] dressed=${dressed}: ${solid} solid edges swept, ${failures} not covered` +
          (dressed ? `, ${chords} village wall chords planned` : ''),
      );
      assert.equal(failures, 0, `solid edges the geometry does not close:\n${examples.join('\n')}`);
      assert.ok(solid > 50000, `only ${solid} solid edges — the sweep is not reaching the world`);
      if (dressed) assert.ok(chords > 40000, `only ${chords} village chords — the dressing is not running`);
    }
  });

  it('floors every square metre of the gap between two rooms, and dresses the world where it stops', () => {
    /*
     * **The void sweep** — the owner's *"can we close the gaps between rooms? … we don't have those
     * bluish looking voids"*, as a measurement over all 46,544 rooms rather than a screenshot.
     *
     * What is counted is each room's *own share* of the ring of gap around its block: four sides of
     * `ROOM_METRES x half` and four corners of `half x half`, which at `ROOM_GAP` is 40 m² a room.
     * Before the fix, 32.3% of that was drawn world-wide and 17.4% in a city room; the three holes
     * are catalogued in `chunkPlan.ts`'s header. The assertion is 100%, exactly, because the fix is
     * not "more coverage" but a single slab whose reach is `HALF_ROOM + half` by construction — a
     * number below 100 would mean the slab had stopped being that.
     *
     * It also counts the two things that make the coverage safe rather than merely present: no two
     * neighbouring slabs may **overlap** (two coplanar surfaces at one elevation is a z-fight, not a
     * floor), and every side that is solid must carry a wall at least half the gap deep so the player
     * never sees floor they cannot reach.
     */
    let swept = 0;
    let share = 0;
    let drawn = 0;
    let textured = 0;
    let solidSides = 0;
    let gapDeep = 0;
    let worldEdge = 0;
    let dressedEdge = 0;
    const bySector = new Map<string, { rooms: number; textured: number }>();
    const problems: string[] = [];

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
        swept += 1;
        const half = frame.gap / 2;
        share += 4 * ROOM_METRES * half + 4 * half * half;

        const grounds = plan.filter((p) => p.archetype === 'ground');
        if (grounds.length !== 1 && problems.length < 8) {
          problems.push(`room ${room.id}: ${grounds.length} ground placements, expected one slab`);
        }
        const slab = grounds[0];
        if (slab) {
          // Everything the slab covers outside the block is gap fill. One slab, so no double count.
          drawn += slab.sx * slab.sz - ROOM_METRES * ROOM_METRES;
          const reach = slab.sx / 2 - ROOM_METRES / 2;
          if (Math.abs(reach - half) > 1e-9 && problems.length < 8) {
            problems.push(`room ${room.id}: the slab reaches ${reach.toFixed(3)} m of the ${half} m it owes`);
          }
        }

        const sector = scene.biome.sector;
        const row = bySector.get(sector) ?? { rooms: 0, textured: 0 };
        row.rooms += 1;
        if (groundTextureOf(sector)) {
          row.textured += 1;
          textured += 1;
        }
        bySector.set(sector, row);

        for (const dir of CARDINALS) {
          const edge = scene.edges[dir];
          if (edge.kind === 'edge') {
            worldEdge += 1;
            // Case 3: what stands where the built world stops. A treeline for the sectors that grow
            // one, a rock apron on a mountain, and a city's own wall — see `scatter.ts`'s layer (a).
            if (!scene.enclosure.roofed && treelineFor(scene).length > 0) dressedEdge += 1;
          }
          if (!edge.solid) continue;
          solidSides += 1;
          const lateral = dir === 'north' || dir === 'south';
          const wall = plan.find(
            (p) => (p.archetype === 'edge' || p.archetype === 'barrier') && (lateral ? p.sz : p.sx) >= half - 1e-9,
          );
          if (wall) gapDeep += 1;
          else if (problems.length < 8) problems.push(`room ${room.id} ${dir}: no wall reaches the gap's midline`);
        }
      }
    }

    const coverage = (100 * drawn) / share;
    console.log(
      `[M9 voids] ${swept} rooms: ${coverage.toFixed(1)}% of the gap ring floored (was 32.3%), ` +
        `${drawn.toFixed(0)} m² of ${share.toFixed(0)}\n` +
        `  walls        ${gapDeep} of ${solidSides} solid sides reach the gap's midline\n` +
        `  world's edge ${worldEdge} sides with no neighbour, ${dressedEdge} of them growing a treeline or apron\n` +
        `  floors       ${textured} rooms draw a textured floor (` +
        [...bySector]
          .filter(([, r]) => r.textured > 0)
          .sort((a, b) => b[1].textured - a[1].textured)
          .map(([s, r]) => `${s} ${r.textured}`)
          .join(', ') +
        `)`,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    // Exactly, not approximately: the slab's reach is `half` by construction on all four sides.
    assert.ok(Math.abs(coverage - 100) < 1e-6, `only ${coverage.toFixed(2)}% of the gap is floored`);
    assert.equal(gapDeep, solidSides, 'a solid boundary left a slot the camera can see through');
    assert.ok(textured > 20000, `only ${textured} rooms wear a floor texture`);
    assert.ok(worldEdge > 50000, `only ${worldEdge} world-edge sides — the sweep is not reaching them`);
  });

  it('never lets two neighbouring ground slabs overlap', () => {
    // The other half of the fix, and the one that would show as a flickering seam rather than as a
    // hole: each room reaches exactly half the gap, so two adjacent slabs *touch*. A slab that
    // reached the full gap would put two coplanar surfaces at one elevation in the depth buffer.
    let pairs = 0;
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        const frame = placeFrame(zone, room.pos.z);
        const east = cells.get(cellKey(room.pos.x + 1, room.pos.y, room.pos.z));
        if (!east) continue;
        const of = (r: Room): Placement =>
          planChunk({
            scene: describeRoom(context, r, neighboursOf(cells, r, rooms), sceneSeed(context, r)),
            origin: cellOriginTiles(frame, r.pos.x, r.pos.y),
            elevation: 0,
            gap: frame.gap,
            faded: false,
            doorClosed: {},
          }).find((p) => p.archetype === 'ground')!;
        const here = of(room);
        const there = of(east);
        const overlap = here.x + here.sx / 2 - (there.x - there.sx / 2);
        assert.ok(Math.abs(overlap) < 1e-9, `rooms ${room.id}/${east.id} overlap by ${overlap.toFixed(4)} m`);
        pairs += 1;
      }
    }
    console.log(`[M9 voids] ${pairs} east-west neighbour pairs meet on the midline, none overlapping`);
    assert.ok(pairs > 20000, `only ${pairs} adjacent pairs checked`);
  });

  /** Whether a set of intervals covers `[from, from + length]` with no gap. Order-independent. */
  function covers(spans: readonly [number, number][], from: number, length: number): boolean {
    if (spans.length === 0) return false;
    const sorted = [...spans].sort((a, b) => a[0] - b[0]);
    // A millimetre of slack at both ends: a chord's ends are floating-point sums of metres and
    // tiles, and an assertion that failed on 1e-13 would be an assertion about IEEE 754. `reach`
    // starts *inside* the interval rather than before it, so a run of chords whose first one begins
    // exactly at `from` — which is every village side, where the grey box it replaced was overlong
    // by a wall thickness at each end — is covered rather than rejected on its first span.
    let reach = from + 1e-3;
    for (const [start, end] of sorted) {
      if (start > reach) return false;
      if (end > reach) reach = end;
    }
    return reach >= from + length - 1e-3;
  }
});
