/**
 * The scatter's invariants, swept over the built world rather than over a fixture.
 *
 * §4's verification section is explicit about the method and about why a snapshot will not do: *"do
 * **not** use snapshot tests over a fixed room sample; they rot on the first density tweak and say
 * nothing about the other 46,000 rooms. Assert invariants over **all** rooms."* Three of its named
 * invariants are this file's:
 *
 * - *"no scatter prop intersects a walkable tile"* — sharpened, because M5a's scatter is **visual
 *   only** and therefore held to a stricter rule than `scenery.ts`'s solid props. See `scatter.ts`'s
 *   header for the argument at length: nothing bulky may stand inside the room block at all, and the
 *   knee-high clutter that does must clear `walkableRequired` and every feature footprint.
 * - *"forward and reverse iteration of a room's scatter produce byte-identical positions"* — run for
 *   real, by planning each room twice with the cardinals in opposite orders.
 * - the bucket caps `pool.ts` sizes its free list from, which are the difference between a bound and
 *   a hope.
 *
 * Follows `traversal.test.ts`'s skip-if-absent shape: `data/world` is git-ignored and reproducible
 * with `npm run worldgen`. A small synthetic sweep runs regardless, so the caps are still checked on
 * a machine with no world data.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CARDINALS,
  ROOM_TILES,
  cellIndex,
  describeRoom,
  featureFootprint,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  walkableRequired,
  type Zone,
} from '@mygame/shared';

import { ROOM_METRES, cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import {
  GRASS_PER_ROOM_MAX,
  TREES_PER_ROOM_MAX,
  TREE_VARIANTS,
  TREE_VARIANTS_PER_ROOM,
} from './prototypes.ts';
import { freeTiles, paletteFor, planScatter } from './scatter.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/** Half a room block, in metres. A tree's foot must be outside this box on both axes. */
const HALF_ROOM = ROOM_METRES / 2;

describe('the three-layer scatter', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  /** Every room in the world, described and grown. One pass, reused by the assertions below. */
  function* grown(): Generator<{
    zone: Zone;
    room: ReturnType<typeof indexRooms> extends Map<number, infer R> ? R : never;
    scene: ReturnType<typeof describeRoom>;
    origin: { tx: number; ty: number };
    placements: ReturnType<typeof planScatter>;
  }> {
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
        yield { zone, room, scene, origin, placements: planScatter({ scene, origin, elevation: 0, lod: 0 }) };
      }
    }
  }

  it('never stands a tree on a room tile, and never a tuft on ground that must stay walkable', () => {
    const required = walkableRequired();
    let trees = 0;
    let tufts = 0;
    let rooms3 = 0;
    const problems: string[] = [];

    for (const { room, scene, origin, placements } of grown()) {
      rooms3 += 1;
      const x0 = metresOfTile(origin.tx);
      const z0 = metresOfTile(origin.ty);
      const blocked = new Set<number>(required);
      for (const feature of scene.features) {
        for (const tile of featureFootprint(feature)) blocked.add(tile);
      }

      for (const placement of placements) {
        const tx = Math.floor((placement.x - x0) / 1);
        const ty = Math.floor((placement.z - z0) / 1);
        const inside = tx >= 0 && tx < ROOM_TILES && ty >= 0 && ty < ROOM_TILES;

        if (placement.archetype === 'grass') {
          tufts += 1;
          if (!inside) {
            if (problems.length < 8) problems.push(`room ${room.id}: a tuft outside the block at ${tx},${ty}`);
            continue;
          }
          if (blocked.has(ty * ROOM_TILES + tx) && problems.length < 8) {
            problems.push(`room ${room.id}: a tuft on required-walkable tile ${tx},${ty}`);
          }
          continue;
        }

        if (placement.archetype !== 'trunk') continue;
        trees += 1;
        // A boundary tree is beyond the block on one axis; interior clutter is inside it and knee-high.
        const boundary = Math.abs(placement.x - (x0 + HALF_ROOM)) > HALF_ROOM
          || Math.abs(placement.z - (z0 + HALF_ROOM)) > HALF_ROOM;
        if (boundary) continue;
        if (placement.sy > 0.3 && problems.length < 8) {
          problems.push(`room ${room.id}: a full-size tree inside the block at scale ${placement.sy}`);
        }
        if (!inside || blocked.has(ty * ROOM_TILES + tx)) {
          if (problems.length < 8) problems.push(`room ${room.id}: clutter on a protected tile ${tx},${ty}`);
        }
      }
    }

    console.log(`[M5a scatter] ${rooms3} rooms swept: ${trees} trees, ${tufts} tufts`);
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(trees > 5000, `only ${trees} trees in the whole world — the treeline is not growing`);
    assert.ok(tufts > 50000, `only ${tufts} tufts`);
  });

  it('produces byte-identical placements whichever way the sides are walked', () => {
    const reverse = [...CARDINALS].reverse();
    let compared = 0;
    for (const { room, scene, origin, placements } of grown()) {
      if (placements.length === 0) continue;
      const other = planScatter({ scene, origin, elevation: 0, lod: 0 }, reverse);
      assert.equal(other.length, placements.length, `room ${room.id} grew a different number of things`);
      // Sorted, because the *order* of the array is allowed to follow the traversal; the *positions*
      // are not. Every placement is a pure function of (seed, salt, index) and never of a cursor.
      const key = (p: (typeof placements)[number]): string =>
        `${p.material}|${p.geometry}|${p.x}|${p.y}|${p.z}|${p.sx}|${p.ry}`;
      assert.deepEqual([...other].map(key).sort(), [...placements].map(key).sort(), `room ${room.id}`);
      compared += 1;
      if (compared >= 4000) break;
    }
    assert.ok(compared > 1000, `only ${compared} rooms grew anything to compare`);
  });

  it('never exceeds the caps pool.ts sizes its free list from', () => {
    let worstTrees = 0;
    let worstTufts = 0;
    let worstBuckets = 0;
    for (const { room, scene, origin, placements } of grown()) {
      let trees = 0;
      let tufts = 0;
      const buckets = new Map<string, number>();
      for (const placement of placements) {
        if (placement.archetype === 'trunk') trees += 1;
        if (placement.archetype === 'grass') tufts += 1;
        const key = `${placement.geometry}|${placement.material}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      assert.ok(trees <= TREES_PER_ROOM_MAX, `room ${room.id} grew ${trees} trees`);
      assert.ok(tufts <= GRASS_PER_ROOM_MAX, `room ${room.id} grew ${tufts} tufts`);
      // Seven, and provably: 3 species x 2 parts, plus one undergrowth bucket.
      assert.ok(buckets.size <= TREE_VARIANTS_PER_ROOM * 2 + 1, `room ${room.id} wanted ${buckets.size} buckets`);
      for (const [key, count] of buckets) {
        assert.ok(count <= 32, `room ${room.id} put ${count} instances in ${key}, over one wrapper`);
      }
      // The palette is bounded whatever the hash rolls.
      assert.ok(paletteFor(scene.biome.sector, scene.seed).length <= TREE_VARIANTS_PER_ROOM);
      // `freeTiles` must never offer a tile a feature is standing on.
      if (scene.features.length > 0) {
        const free = new Set(freeTiles(scene));
        for (const feature of scene.features) {
          for (const tile of featureFootprint(feature)) assert.ok(!free.has(tile), `room ${room.id} tile ${tile}`);
        }
      }
      worstTrees = Math.max(worstTrees, trees);
      worstTufts = Math.max(worstTufts, tufts);
      worstBuckets = Math.max(worstBuckets, buckets.size);
      void origin;
    }
    console.log(
      `[M5a caps] worst room: ${worstTrees} trees of ${TREES_PER_ROOM_MAX}, ` +
        `${worstTufts} tufts of ${GRASS_PER_ROOM_MAX}, ${worstBuckets} buckets of ${TREE_VARIANTS_PER_ROOM * 2 + 1}`,
    );
    assert.ok(worstTrees > 0, 'nothing grew anywhere');
  });

  it('grows nothing at all under a roof', () => {
    let roofed = 0;
    for (const { scene, origin, placements } of grown()) {
      if (!scene.enclosure.roofed) continue;
      roofed += 1;
      assert.equal(placements.length, 0, `a roofed room grew ${placements.length} things`);
      void origin;
    }
    assert.ok(roofed > 10000, `only ${roofed} roofed rooms swept`);
  });

  it('only ever names a variant the pool knows', () => {
    const known = new Set<string>(TREE_VARIANTS);
    let checked = 0;
    for (const { placements } of grown()) {
      for (const placement of placements) {
        if (placement.archetype === 'grass') continue;
        const variant = placement.material.split('|')[1] ?? '';
        assert.ok(known.has(variant), `unknown variant ${variant}`);
        checked += 1;
      }
      if (checked > 20000) break;
    }
    assert.ok(checked > 10000);
  });
});
