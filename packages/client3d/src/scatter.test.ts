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
  KIT_BLOCKS,
  KIT_BLOCK_RADIUS,
  KIT_MODELS,
  KIT_MODELS_PER_ROOM,
  KIT_PARTS_MAX,
  KIT_PER_ROOM_MAX,
  TREES_PER_ROOM_MAX,
  TREE_VARIANTS,
  TREE_VARIANTS_PER_ROOM,
} from './prototypes.ts';
import { builtUp, freeTiles, kitPaletteFor, kitScaleOf, paletteFor, planScatter } from './scatter.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/** Half a room block, in metres. A tree's foot must be outside this box on both axes. */
const HALF_ROOM = ROOM_METRES / 2;

/** The kit manifest's `(id, height)` rows, tolerating either shape modelgen may have written. */
function manifestModels(path: string): readonly { readonly id: string; readonly height: number }[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as { models?: unknown }).models ?? []);
  return rows as readonly { readonly id: string; readonly height: number }[];
}

describe('nothing underfoot is taller than the player', () => {
  // The owner's own criterion, and their own words: *"flowers and grass taller than a player is a
  // bit much, even for an overgrown field"*. This is the check that was missing when the ground
  // cover shipped at life size — the numbers in `scatter.ts` were never wrong about themselves, they
  // were right about an assumption ("the kit is already at world scale") that held for the trees and
  // not for the understory. Only the manifest could have said so, so only the manifest can guard it.
  const MANIFEST = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', 'nature', 'manifest.json');
  /** A person is 1.8 m. Ground cover that clears their eyeline is the thing being refused. */
  const PLAYER_HEIGHT = 1.8;

  it('holds every scattered kit model against its measured height', (t) => {
    if (!existsSync(MANIFEST)) {
      t.skip('the nature kit has not been imported — see .gitignore for the modelgen command');
      return;
    }
    const models = manifestModels(MANIFEST);
    assert.ok(models.length > 0, 'the manifest should list the kit');

    const tall: string[] = [];
    for (const model of models) {
      if (!KIT_MODELS.includes(model.id)) continue;
      // Trees are meant to tower; this is about what grows around your feet. A **bush** is exempt by
      // name and not by height: `bush-common` tops out at 1.82 m, which is a big bush and still a
      // bush — it was never what the owner was looking at, and shrinking it to satisfy an arithmetic
      // line would be the test writing the art direction.
      if (KIT_BLOCKS.has(model.id) || /tree|pine|^bush-/.test(model.id)) continue;
      const drawn = model.height * kitScaleOf(model.id)[1];
      if (drawn > PLAYER_HEIGHT) tall.push(`${model.id} draws at ${drawn.toFixed(2)} m`);
    }
    assert.deepEqual(tall, [], `understory taller than a person:\n  ${tall.join('\n  ')}`);
  });

  it('puts the ground cover the owner named at about half life size', (t) => {
    if (!existsSync(MANIFEST)) {
      t.skip('the nature kit has not been imported');
      return;
    }
    // Flowers and grass specifically: waist-high at the tallest, which is what "overgrown" should
    // look like rather than "wading through wheat".
    const models = manifestModels(MANIFEST);
    let checked = 0;
    for (const model of models) {
      if (!/^(flower|grass|clover)/.test(model.id)) continue;
      checked += 1;
      const drawn = model.height * kitScaleOf(model.id)[1];
      assert.ok(drawn <= 1.45, `${model.id} draws at ${drawn.toFixed(2)} m, which is not waist-high`);
      // And the halving must be a halving, not a crush: still clearly a plant you can see.
      assert.ok(drawn >= 0.4, `${model.id} draws at ${drawn.toFixed(2)} m and has been scaled away`);
    }
    assert.ok(checked >= 10, `only ${checked} ground-cover models were checked`);
  });
});

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

  it('grows a treeline at the world\'s edge, and never one inside a town', () => {
    // The owner's *"the boundaries of the outside should be controlled by trees or cliff faces"*, as
    // the two properties it actually decomposes into.
    //
    // The trap is `road`: one sector covers the Trade Way and every lane in Bryn Shander, so a
    // straight palette lookup grew 774 trees inside that town's walls, in the dead ends where a house
    // belongs. `scatter.builtUp` refuses those and the refusal is what this test is mostly about — a
    // count that only went *up* would have looked like a success.
    let country = 0;
    let town = 0;
    let treesInTown = 0;
    const problems: string[] = [];
    for (const { room, scene, placements } of grown()) {
      const sector = scene.biome.sector;
      const trunks = placements.filter((p) => p.archetype === 'trunk').length;
      if (sector !== 'road' && sector !== 'field') continue;
      if (builtUp(scene)) {
        town += 1;
        treesInTown += trunks;
        if (trunks > 0 && problems.length < 8) {
          problems.push(`room ${room.id} (${sector}) is built up and grew ${trunks} trees`);
        }
      } else if (trunks > 0) {
        country += 1;
      }
      // Whatever the gate says, a tree still only ever stands on a side with no neighbour cell.
      if (trunks > 0) {
        const edges = CARDINALS.filter((dir) => scene.edges[dir].kind === 'edge').length;
        if (edges === 0 && problems.length < 8) {
          problems.push(`room ${room.id} grew ${trunks} trees with no world edge to grow them on`);
        }
      }
    }
    console.log(
      `[M9 treeline] road/field: ${country} open-country rooms grew a boundary wood, ` +
        `${town} built-up rooms refused one (${treesInTown} trees inside a settlement)`,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.equal(treesInTown, 0, 'a lane in a town grew a wood');
    assert.ok(country > 1500, `only ${country} country rooms grew a treeline — the new palettes are not firing`);
    assert.ok(town > 500, `only ${town} built-up rooms — the refusal is not being exercised`);
  });

  it('never exceeds the caps pool.ts sizes its free list from', () => {
    let worstTrees = 0;
    let worstTufts = 0;
    let worstKit = 0;
    let worstBuckets = 0;
    // The ceiling `pool.SCATTER_WRAPPER_CEILING` is derived from, restated where it is checked: three
    // species x two parts, one undergrowth bucket, and four kit models x two primitives.
    const ceiling = TREE_VARIANTS_PER_ROOM * 2 + 1 + KIT_MODELS_PER_ROOM * KIT_PARTS_MAX;
    for (const { room, scene, origin, placements } of grown()) {
      let trees = 0;
      let tufts = 0;
      let kit = 0;
      const buckets = new Map<string, number>();
      for (const placement of placements) {
        if (placement.archetype === 'trunk') trees += 1;
        if (placement.archetype === 'grass') tufts += 1;
        if (placement.archetype === 'kitSolid' || placement.archetype === 'kitLeaf') kit += 1;
        const key = `${placement.geometry}|${placement.material}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
      assert.ok(trees <= TREES_PER_ROOM_MAX, `room ${room.id} grew ${trees} trees`);
      assert.ok(tufts <= GRASS_PER_ROOM_MAX, `room ${room.id} grew ${tufts} tufts`);
      assert.ok(kit <= KIT_PER_ROOM_MAX, `room ${room.id} grew ${kit} kit instances`);
      assert.ok(buckets.size <= ceiling, `room ${room.id} wanted ${buckets.size} buckets of ${ceiling}`);
      for (const [key, count] of buckets) {
        assert.ok(count <= 32, `room ${room.id} put ${count} instances in ${key}, over one wrapper`);
      }
      // Both palettes are bounded whatever the hash rolls.
      assert.ok(paletteFor(scene.biome.sector, scene.seed).length <= TREE_VARIANTS_PER_ROOM);
      assert.ok(kitPaletteFor(scene.biome.sector, scene.seed).length <= KIT_MODELS_PER_ROOM);
      // `freeTiles` must never offer a tile a feature is standing on.
      if (scene.features.length > 0) {
        const free = new Set(freeTiles(scene));
        for (const feature of scene.features) {
          for (const tile of featureFootprint(feature)) assert.ok(!free.has(tile), `room ${room.id} tile ${tile}`);
        }
      }
      worstTrees = Math.max(worstTrees, trees);
      worstTufts = Math.max(worstTufts, tufts);
      worstKit = Math.max(worstKit, kit);
      worstBuckets = Math.max(worstBuckets, buckets.size);
      void origin;
    }
    console.log(
      `[M5b caps] worst room: ${worstTrees} trees of ${TREES_PER_ROOM_MAX}, ` +
        `${worstTufts} tufts of ${GRASS_PER_ROOM_MAX}, ${worstKit} kit of ${KIT_PER_ROOM_MAX}, ` +
        `${worstBuckets} buckets of ${ceiling}`,
    );
    assert.ok(worstTrees > 0, 'nothing grew anywhere');
    assert.ok(worstKit > 0, 'the kit never dressed a single room');
  });

  it('holds the kit to its palette, its ration and the scatter-block rule', () => {
    // The three things the brief asks of the kit layer, over the whole world rather than a fixture.
    const known = new Set(KIT_MODELS);
    const required = walkableRequired();
    let kitInstances = 0;
    let boulders = 0;
    let biggest = 0;
    let worstTwisted = 0;
    const problems: string[] = [];

    for (const { room, scene, origin, placements } of grown()) {
      const x0 = metresOfTile(origin.tx);
      const z0 = metresOfTile(origin.ty);
      const blocked = new Set<number>(required);
      for (const feature of scene.features) {
        for (const tile of featureFootprint(feature)) blocked.add(tile);
      }
      let twisted = 0;
      for (const placement of placements) {
        if (placement.archetype === 'trunk' && placement.material.includes('twisted-tree')) twisted += 1;
        if (placement.archetype !== 'kitSolid' && placement.archetype !== 'kitLeaf') continue;
        kitInstances += 1;
        // `kit|<model>|<texture>` — the model must be one this package has a pool key for.
        const model = placement.material.split('|')[1] ?? '';
        if (!known.has(model) && problems.length < 8) problems.push(`room ${room.id}: unknown kit model ${model}`);

        const tx = Math.floor(placement.x - x0);
        const ty = Math.floor(placement.z - z0);
        const inside = tx >= 0 && tx < ROOM_TILES && ty >= 0 && ty < ROOM_TILES;
        if (KIT_BLOCKS.has(model)) {
          boulders += 1;
          biggest = Math.max(biggest, placement.sx);
          // A blocking model is held to the treeline's rule: outside the room block entirely, in the
          // void the collision grid has no tiles for. Never merely "on a free tile".
          //
          // **Its whole extent, not its origin** — 2026-08-13. The origin test passed for a milestone
          // while `KIT_BLOCK_RADIUS` of rock leaned back over walkable floor, because the clearance
          // was a flat 1.1 m and the measured reach is 1.75; and it would have passed just as
          // happily with the mountain's 2.4x crags overlapping the room by four metres. What a
          // player walks into is the rock, so the rock is what is checked.
          const reach = KIT_BLOCK_RADIUS * placement.sx;
          const clear =
            Math.abs(placement.x - (x0 + HALF_ROOM)) - reach > HALF_ROOM
            || Math.abs(placement.z - (z0 + HALF_ROOM)) - reach > HALF_ROOM;
          if (!clear && problems.length < 8) {
            problems.push(
              `room ${room.id}: ${model} at ${placement.sx.toFixed(2)}x reaches back over the block at ${tx},${ty}`,
            );
          }
          continue;
        }
        // Understory never blocks, so it stands inside — but never where a player arrives or walks.
        if (!inside && problems.length < 8) problems.push(`room ${room.id}: ${model} outside the block`);
        else if (inside && blocked.has(ty * ROOM_TILES + tx) && problems.length < 8) {
          problems.push(`room ${room.id}: ${model} on required-walkable tile ${tx},${ty}`);
        }
      }
      // The brief's ration, over the built world: at most one twisted tree in any room, ever.
      assert.ok(twisted <= 1, `room ${room.id} grew ${twisted} twisted trees`);
      worstTwisted = Math.max(worstTwisted, twisted);
    }

    console.log(
      `[M5b kit] ${kitInstances} kit instances world-wide, of which ${boulders} blocking; ` +
        `worst room ${worstTwisted} twisted tree; biggest boundary rock ${biggest.toFixed(2)}x life size`,
    );
    assert.deepEqual(problems, [], problems.join('\n'));
    assert.ok(kitInstances > 100000, `only ${kitInstances} kit instances — the world is undressed`);
    assert.ok(boulders > 1000, `only ${boulders} boulders — the hills grew nothing`);
    // The mountain's rock apron actually ran — `scatter.BOUNDARY_BULK`. Without this the extent check
    // above would be a statement about life-size boulders, which is the case that already passed.
    assert.ok(biggest > 2, `the biggest boundary rock is ${biggest.toFixed(2)}x — the rock apron is not growing`);
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
        if (placement.archetype !== 'trunk' && placement.archetype !== 'canopy') continue;
        const variant = placement.material.split('|')[1] ?? '';
        assert.ok(known.has(variant), `unknown variant ${variant}`);
        checked += 1;
      }
      if (checked > 20000) break;
    }
    assert.ok(checked > 10000);
  });
});
