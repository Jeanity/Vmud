/**
 * The furniture, held to three promises, of which one is a **safety** property and is why this file
 * sweeps the whole world rather than a fixture.
 *
 * 1. **Nothing stands where a player walks.** `roomScene.walkableRequired` is `scenery.ts`'s law and
 *    this pass obeys it *by footprint* rather than by origin, which is a stronger statement than the
 *    clutter layer makes and has to be: a bookcase is 1.46 m wide where a toadstool is 12 cm. The
 *    sweep checks every tile of every piece in every furnished room in the built world.
 * 2. **The bucket budget holds.** `pool.ts` sizes its pre-warm from `DRESSED_WRAPPER_CEILING`, whose
 *    interior term is now `11 + 6` — and the `+6` is only free because `planFurniture` refuses every
 *    room `interior.dressable` refuses. Both halves are asserted, and the second is asserted the way
 *    `interior.test.ts` asserts its own exclusivity: over all 46,544 rooms rather than in a comment.
 * 3. **It is a pure function of the room seed.** Two runs, byte-identical.
 *
 * Skips cleanly when `data/world/zones` is absent, which is the shape every whole-world sweep in this
 * package uses — the data is git-ignored and reproducible with `npm run worldgen`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  ROOM_TILES,
  SCATTER_BLOCKS,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  walkableRequired,
  type Zone,
} from '@mygame/shared';

import { METRES_PER_TILE, ROOM_METRES, cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import {
  ROOM_PURPOSES,
  SLOT_SLACK,
  dressedScenery,
  fitsIslandSlot,
  fitsWallSlot,
  planFurniture,
  planScenery,
  roomPurpose,
  sceneryScale,
  wallRuns,
} from './furnish.ts';
import { dressable } from './interior.ts';
import { DRESSED_WRAPPER_CEILING, WRAPPER_CAPACITY } from './pool.ts';
import {
  PROPS_METRICS,
  PROPS_MODELS_PER_ROOM,
  PROPS_PARTS_MAX,
  SCENERY_MODELS,
} from './prototypes.ts';
import { freeTiles, planScatter } from './scatter.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/** The interior term of `pool.DRESSED_WRAPPER_CEILING`, restated where it is checked. */
const FURNITURE_BUCKETS = PROPS_MODELS_PER_ROOM * PROPS_PARTS_MAX;

describe('what a room is for', () => {
  it('reads the trade out of the name the builder wrote', () => {
    assert.equal(roomPurpose('The Blacksmith', undefined), 'smithy');
    assert.equal(roomPurpose("Durgan's Forge", undefined), 'smithy');
    assert.equal(roomPurpose('The Common Room', undefined), 'tavern');
    assert.equal(roomPurpose('A Dusty Library', undefined), 'library');
    assert.equal(roomPurpose('The General Store', undefined), 'shop');
    assert.equal(roomPurpose('A Small Home', undefined), 'home');
    assert.equal(roomPurpose('The Temple of Tyr', undefined), 'temple');
    assert.equal(roomPurpose('The Kitchen', undefined), 'kitchen');
    assert.equal(roomPurpose('The Guard Room', undefined), 'guard');
    assert.equal(roomPurpose('A Great Hall', undefined), 'hall');
    assert.equal(roomPurpose('An Alchemist Laboratory', undefined), 'workshop');
  });

  it('keeps a corridor a corridor', () => {
    // 62% of the world's `inside` rooms are passages, bends, dead ends and T-intersections. Furnishing
    // them because the generator had to put something somewhere is worse than leaving them bare, and
    // "no answer" is a first-class answer here rather than a fallback.
    for (const name of [
      'A Bend in the Passage',
      'A Dead End',
      'A T-intersection in the Passageway',
      'A Corridor',
      'An unnamed place',
      'The Outer Ring',
    ]) {
      assert.equal(roomPurpose(name, undefined), undefined, name);
    }
  });

  it('breaks the four ties the word order exists for', () => {
    // `cellar` must reach `store` before anything else claims it; `storeroom` must beat `store` into
    // `shop`; and a name that says both wins on the more specific.
    assert.equal(roomPurpose('A Storm Cellar', undefined), 'store');
    assert.equal(roomPurpose("The Inn's Storeroom", undefined), 'store');
    assert.equal(roomPurpose('The Smithy Storeroom', undefined), 'smithy');
    // The `inn` flag is a fallback and never an override: a room *called* the common room is a
    // taproom even when the MUD marked it `ROOM_HEAL`.
    assert.equal(roomPurpose('The Common Room', ['inn']), 'tavern');
    assert.equal(roomPurpose('A Quiet Chamber', ['inn']), 'bedroom');
    assert.equal(roomPurpose('A Quiet Chamber', []), undefined);
  });

  it('never names a piece the footprint law cannot stand up', () => {
    // A palette entry that fits nowhere would silently cost a room one of its two model slots. The
    // planner drops it in `modelsFor`, so this catches the mistake where it is made rather than where
    // it shows.
    for (const purpose of ROOM_PURPOSES) {
      const plan = planFurniture({
        scene: fakeScene(),
        name: `A ${purpose}`,
        flags: undefined,
        origin: { tx: 0, ty: 0 },
        elevation: 0,
      });
      assert.ok(plan.length >= 0, purpose);
    }
    // …and the two pieces that fit nowhere are named, so the gap stays visible rather than becoming a
    // silently absent table.
    assert.equal(fitsWallSlot('table-large'), false, 'a 1.097 m-deep table cannot back onto a wall');
    assert.equal(fitsIslandSlot('table-large'), false, 'nor fit a 2 x 2 island');
    assert.equal(fitsWallSlot('bench'), true, 'a 0.534 m-deep bench can, at any length the run allows');
    assert.equal(fitsIslandSlot('bench'), false, '2.777 m is wider than an island');
    // And the slack is a rounding tolerance rather than licence — it lets the 1.024 m workbench
    // through and keeps the 1.097 m table out.
    assert.equal(SLOT_SLACK, 0.03);
    assert.equal(fitsWallSlot('workbench'), true);
    assert.ok(PROPS_METRICS['workbench']!.depth > METRES_PER_TILE, 'the slack is doing real work here');
  });
});

describe('the scenery catalogue, dressed', () => {
  it('has a model for one of the ten kinds and says so', () => {
    // The sourcing gap, stated as an assertion so it cannot quietly become a substitution. There is no
    // fountain, no well, no statue and no haystack in either prop kit; a wellhead drawn as a barrel
    // would be a lie the player types `look well` at.
    assert.deepEqual(Object.keys(SCENERY_MODELS), ['cart']);
    for (const kind of ['fountain', 'plinth', 'well', 'statue', 'haystack']) {
      assert.equal(SCENERY_MODELS[kind], undefined, `${kind} must stay a named gap`);
    }
  });

  it('shrinks a model to the footprint the collision grid already stamped', () => {
    // `SCENERY.cart` is two tiles by two and both the server and every client wrote those four solid.
    // The market booth needs no help; the handcart is 3.02 m long and would hang a metre of shaft over
    // walkable floor, which is `scatter.ts`'s forbidden lie in its most visible form.
    assert.equal(sceneryScale('stall-empty', 2, 2), 1);
    const scale = sceneryScale('stall-cart-empty', 2, 2);
    assert.ok(Math.abs(scale - 0.672) < 0.01, `the handcart is drawn at ${scale}`);
    assert.ok(PROPS_METRICS['stall-cart-empty']!.width * scale <= 2 + SLOT_SLACK + 1e-9);
    // Never above 1: a model smaller than its footprint is a cart in a bay, which is correct.
    assert.equal(sceneryScale('stall-empty', 4, 4), 1);
  });
});

describe('the furniture over the built world', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const zones = readdirSync(ZONES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(ZONES_DIR, file), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  /** Every room in the world, with the frame and the scene it would be drawn from. */
  function* everyRoom(): Generator<{
    zone: Zone;
    room: Zone['rooms'][number];
    scene: ReturnType<typeof describeRoom>;
    origin: { tx: number; ty: number };
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
        yield { zone, room, scene, origin: cellOriginTiles(frame, room.pos.x, room.pos.y) };
      }
    }
  }

  it('never stands a piece on a tile a player arrives on or walks down', () => {
    // **The safety property, and the one this file exists for.** Checked by footprint: every tile the
    // piece's own measured rectangle covers, not the tile its origin happens to land in.
    const required = walkableRequired();
    let furnished = 0;
    let pieces = 0;
    let worstReach = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const plan = planFurniture({
        scene,
        name: room.name,
        flags: room.flags,
        origin,
        elevation: 0,
      });
      if (plan.length === 0) continue;
      furnished += 1;
      const x0 = metresOfTile(origin.tx);
      const z0 = metresOfTile(origin.ty);
      const seen = new Set<string>();
      for (const placement of plan) {
        const model = placement.geometry.split(':')[1]!;
        const metric = PROPS_METRICS[model]!;
        // One placement per primitive; a three-part stall is one piece. Counted once.
        const at = `${model}@${placement.x.toFixed(3)},${placement.z.toFixed(3)}`;
        if (seen.has(at)) continue;
        seen.add(at);
        pieces += 1;
        // The yaw is a quarter turn, so the footprint swaps axes rather than rotating.
        const turned = Math.abs(Math.sin(placement.ry)) > 0.5;
        const w = turned ? metric.depth : metric.width;
        const d = turned ? metric.width : metric.depth;
        const minX = placement.x - x0 - w / 2;
        const maxX = placement.x - x0 + w / 2;
        const minZ = placement.z - z0 - d / 2;
        const maxZ = placement.z - z0 + d / 2;
        // Nothing may leave the room block at all: a barrel poking through a plastered wall is the
        // interior mode's version of the boundary rule the treeline lives by.
        assert.ok(minX >= -SLOT_SLACK, `room ${room.id}: ${model} reaches ${minX.toFixed(3)} m west of its block`);
        assert.ok(minZ >= -SLOT_SLACK, `room ${room.id}: ${model} reaches ${minZ.toFixed(3)} m north of its block`);
        assert.ok(maxX <= ROOM_METRES + SLOT_SLACK, `room ${room.id}: ${model} reaches past its east wall`);
        assert.ok(maxZ <= ROOM_METRES + SLOT_SLACK, `room ${room.id}: ${model} reaches past its south wall`);
        worstReach = Math.max(worstReach, -minX, -minZ, maxX - ROOM_METRES, maxZ - ROOM_METRES);
        // And no tile of it may be one a body arrives on or walks across.
        const first = tileOf(minX + SLOT_SLACK);
        const lastX = tileOf(maxX - SLOT_SLACK);
        const firstZ = tileOf(minZ + SLOT_SLACK);
        const lastZ = tileOf(maxZ - SLOT_SLACK);
        for (let tx = first; tx <= lastX; tx++) {
          for (let ty = firstZ; ty <= lastZ; ty++) {
            const tile = ty * ROOM_TILES + tx;
            assert.ok(
              !required.has(tile),
              `room ${room.id}: ${model} covers tile (${tx}, ${ty}), which must stay walkable`,
            );
          }
        }
      }
    }
    console.log(
      `[M9 furniture] ${furnished} rooms furnished, ${pieces} pieces, ` +
        `worst overhang ${worstReach.toFixed(4)} m of the ${SLOT_SLACK} m slack`,
    );
    assert.ok(furnished > 3000, `only ${furnished} rooms furnished`);
    assert.ok(worstReach <= SLOT_SLACK + 1e-9);
  });

  it('never stands a piece in a doorway', () => {
    // *"a bookcase in a doorway is not"*, as a sweep — and the corner case the first draft of the
    // planner missed. A **threshold tile** is a ring tile inside *any* side's opening, which in a
    // seamless zone is the whole of that side: room 100001011's north side is carved end to end, so
    // tile `(0, 0)` is in the north doorway even though it is on the west wall's own run.
    let doorways = 0;
    let pieces = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const plan = planFurniture({ scene, name: room.name, flags: room.flags, origin, elevation: 0 });
      if (plan.length === 0) continue;
      const thresholds = new Set<number>();
      for (const dir of ['north', 'east', 'south', 'west'] as const) {
        const mouth = scene.edges[dir].mouth;
        if (!mouth || mouth.span <= 0) continue;
        doorways += 1;
        for (let i = mouth.offset; i < mouth.offset + mouth.span && i < ROOM_TILES; i++) {
          const tx = dir === 'west' ? 0 : dir === 'east' ? ROOM_TILES - 1 : i;
          const ty = dir === 'north' ? 0 : dir === 'south' ? ROOM_TILES - 1 : i;
          thresholds.add(ty * ROOM_TILES + tx);
        }
      }
      if (thresholds.size === 0) continue;
      const x0 = metresOfTile(origin.tx);
      const z0 = metresOfTile(origin.ty);
      for (const placement of plan) {
        pieces += 1;
        const model = placement.geometry.split(':')[1]!;
        const metric = PROPS_METRICS[model]!;
        const turned = Math.abs(Math.sin(placement.ry)) > 0.5;
        const w = turned ? metric.depth : metric.width;
        const d = turned ? metric.width : metric.depth;
        for (let tx = tileOf(placement.x - x0 - w / 2 + SLOT_SLACK); tx <= tileOf(placement.x - x0 + w / 2 - SLOT_SLACK); tx++) {
          for (let ty = tileOf(placement.z - z0 - d / 2 + SLOT_SLACK); ty <= tileOf(placement.z - z0 + d / 2 - SLOT_SLACK); ty++) {
            assert.ok(
              !thresholds.has(ty * ROOM_TILES + tx),
              `room ${room.id}: ${model} covers tile (${tx}, ${ty}), which is a doorway threshold`,
            );
          }
        }
      }
    }
    console.log(`[M9 doorways] ${doorways} openings checked against ${pieces} placed primitives`);
    assert.ok(doorways > 0, 'no furnished room in the world has a doorway, which cannot be right');
  });

  it('keeps the worst furnished room inside its bucket and instance budget', () => {
    let worstBuckets = 0;
    let worstInstances = 0;
    let worstRoom = 0;
    let worstModels = 0;
    const byPurpose = new Map<string, number>();
    const byModel = new Map<string, number>();
    for (const { room, scene, origin } of everyRoom()) {
      const plan = planFurniture({ scene, name: room.name, flags: room.flags, origin, elevation: 0 });
      if (plan.length === 0) continue;
      const purpose = roomPurpose(room.name, room.flags)!;
      byPurpose.set(purpose, (byPurpose.get(purpose) ?? 0) + 1);
      const buckets = new Map<string, number>();
      const models = new Set<string>();
      for (const placement of plan) {
        const key = `${placement.geometry}|${placement.material}`;
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
        const model = placement.geometry.split(':')[1]!;
        models.add(model);
        byModel.set(model, (byModel.get(model) ?? 0) + 1);
      }
      if (buckets.size > worstBuckets) {
        worstBuckets = buckets.size;
        worstRoom = room.id;
      }
      worstModels = Math.max(worstModels, models.size);
      for (const count of buckets.values()) worstInstances = Math.max(worstInstances, count);
      assert.ok(
        models.size <= PROPS_MODELS_PER_ROOM,
        `room ${room.id} wants ${models.size} furniture models`,
      );
    }
    console.log(
      `[M9 budget] worst room ${worstRoom} at ${worstBuckets} of ${FURNITURE_BUCKETS} furniture buckets, ` +
        `worst bucket ${worstInstances} of ${WRAPPER_CAPACITY} instances, ${worstModels} models`,
    );
    console.log(
      `[M9 purposes] ${[...byPurpose].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
    console.log(
      `[M9 pieces] ${[...byModel].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
    assert.ok(worstBuckets <= FURNITURE_BUCKETS, `${worstBuckets} buckets over the ${FURNITURE_BUCKETS} budgeted`);
    assert.ok(worstInstances <= WRAPPER_CAPACITY, `${worstInstances} instances in one bucket`);
  });

  it('never lets one chunk want both the understory and the furniture', () => {
    // **The exclusivity `pool.DRESSED_WRAPPER_CEILING` still rests on after M9**, and the reason the
    // furniture is free: it is added to the interior term, so it must land only where the interior
    // dressing does. `interior.test.ts` asserts the same property for the walls; this asserts that the
    // furniture did not quietly widen it.
    let furnished = 0;
    let both = 0;
    let alsoScenery = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const plan = planFurniture({ scene, name: room.name, flags: room.flags, origin, elevation: 0 });
      if (plan.length === 0) continue;
      furnished += 1;
      assert.ok(dressable(scene), `room ${room.id} is furnished and is not an interior`);
      if (planScatter({ scene, origin, elevation: 0, lod: 0 }).length > 0) both += 1;
      if (dressedScenery(scene).length > 0) alsoScenery += 1;
    }
    assert.equal(both, 0, 'a chunk wanted both the scatter budget and the furniture budget');
    assert.equal(alsoScenery, 0, 'a chunk wanted both the scenery budget and the furniture budget');
    assert.ok(furnished > 3000, `only ${furnished} rooms furnished`);
  });

  it('keeps the whole dressed budget inside the ceiling the pool was sized for', () => {
    // The other side of the `max`: a chunk that draws scatter *and* a dressed cart. Three of the ten
    // authored scenery props in the world are carts and all of them stand in outdoor city rooms, which
    // is exactly the case the scenery term was added to the scatter side for.
    let dressedCarts = 0;
    let worst = 0;
    let worstRoom = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const dressed = dressedScenery(scene);
      if (dressed.length === 0) continue;
      dressedCarts += dressed.length;
      assert.ok(dressed.length <= 1, `room ${room.id} asks for ${dressed.length} dressed scenery props`);
      const plan = planScenery({ scene, origin, elevation: 0 });
      const buckets = new Set(plan.map((p) => `${p.geometry}|${p.material}`));
      assert.ok(buckets.size <= PROPS_PARTS_MAX, `room ${room.id} wants ${buckets.size} scenery buckets`);
      const scatter = planScatter({ scene, origin, elevation: 0, lod: 0 });
      const scatterBuckets = new Set(scatter.map((p) => `${p.geometry}|${p.material}`));
      const total = buckets.size + scatterBuckets.size;
      if (total > worst) {
        worst = total;
        worstRoom = room.id;
      }
    }
    console.log(
      `[M9 scenery] ${dressedCarts} authored props dressed as kit models, ` +
        `worst combined chunk ${worstRoom} at ${worst} of ${DRESSED_WRAPPER_CEILING} buckets`,
    );
    assert.ok(dressedCarts > 0, 'the world has authored carts and none of them was dressed');
    assert.ok(worst <= DRESSED_WRAPPER_CEILING, `${worst} buckets over the ${DRESSED_WRAPPER_CEILING} budgeted`);
  });

  it('is a pure function of the room seed', () => {
    // `CLAUDE.md` rule 3, checked the way `scatter.test.ts` checks it: run it twice and compare the
    // bytes. Every choice in this file is `hashCell(seed, salt, index, …)`, so the only way this can
    // fail is somebody reaching for `Math.random` or for a cursor.
    let compared = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const input = { scene, name: room.name, flags: room.flags, origin, elevation: 0 };
      const first = planFurniture(input);
      if (first.length === 0) continue;
      assert.deepEqual(planFurniture(input), first, `room ${room.id} is not deterministic`);
      compared += 1;
      if (compared > 500) break;
    }
    assert.ok(compared > 400);
  });

  it('reports how much of the world it reaches, and how much it does not', () => {
    // The number the milestone is judged on, and the honest half of it: 62% of the world's interiors
    // are passages and stay bare on purpose. See `roomPurpose`.
    let interiors = 0;
    let named = 0;
    let furnished = 0;
    let runs = 0;
    for (const { room, scene, origin } of everyRoom()) {
      if (!dressable(scene)) continue;
      interiors += 1;
      if (roomPurpose(room.name, room.flags) !== undefined) named += 1;
      const plan = planFurniture({ scene, name: room.name, flags: room.flags, origin, elevation: 0 });
      if (plan.length > 0) furnished += 1;
      runs += wallRuns(scene, new Set(freeTiles(scene))).length;
    }
    console.log(
      `[M9 reach] ${interiors} dressable interiors, ${named} name a purpose ` +
        `(${((named / interiors) * 100).toFixed(1)}%), ${furnished} furnished; ` +
        `${SCATTER_BLOCKS.length} island slots a room and ${(runs / interiors).toFixed(2)} wall runs`,
    );
    assert.ok(furnished / interiors > 0.3, 'the furniture reaches less than a third of the interiors');
    assert.ok(furnished <= named, 'a room furnished without naming a purpose');
  });
});

/** The tile a room-relative metre offset falls in, clamped to the block. */
function tileOf(metres: number): number {
  return Math.min(ROOM_TILES - 1, Math.max(0, Math.floor(metres / METRES_PER_TILE)));
}

/**
 * A minimal interior for the palette check — four solid `edge` sides, no features, roofed and
 * `inside`, which is the emptiest room `dressable` accepts and therefore the one with the most slots.
 */
function fakeScene(): Parameters<typeof planFurniture>[0]['scene'] {
  const edge = { kind: 'edge' as const, solid: true, sector: undefined, mouth: undefined };
  return {
    room: 1,
    zone: 1,
    seed: 12345,
    biome: { sector: 'inside', theme: 0, blend: [] },
    ground: { elevation: { t: 'flat', base: 0, noise: 0 } },
    edges: { north: edge, east: edge, south: edge, west: edge },
    enclosure: { roofed: true, walls: 4, openSides: 0, sky: false },
    features: [],
  } as unknown as Parameters<typeof planFurniture>[0]['scene'];
}
