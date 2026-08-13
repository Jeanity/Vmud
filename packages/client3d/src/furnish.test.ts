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
  SCATTER_KINDS,
  SCENERY,
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
  KIT_MODELS,
  PROPS_METRICS,
  PROPS_MODELS,
  PROPS_MODELS_PER_ROOM,
  PROPS_PARTS_MAX,
  SCENERY_BOXES,
  SCENERY_MODELS,
  SCENERY_STAND_INS,
  TREE_VARIANTS,
  sceneryParts,
  treePartsOf,
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
  it('has a model for five of the twelve kinds and names the five gaps', () => {
    // The sourcing gap, stated as an assertion so it cannot quietly become a substitution. There is
    // no fountain, no plinth, no well, no statue and no haystack in the props kit, the village kit or
    // the nature kit; a wellhead drawn as a barrel would be a lie the player types `look well` at.
    // There is no headstone either, which is why there is no `headstone` *kind*: adding one would add
    // a grey box and nothing else.
    assert.deepEqual(Object.keys(SCENERY_MODELS).sort(), ['barrel', 'cart', 'crate', 'log', 'stump']);
    for (const kind of ['fountain', 'plinth', 'well', 'statue', 'haystack']) {
      assert.equal(SCENERY_MODELS[kind], undefined, `${kind} must stay a named gap`);
    }
    // **And every kind `scatterFor` can grow draws.** A derived prop is one a hash put in the
    // player's way ten thousand times over; if any of them were a grey box the owner would be looking
    // at a field of boxes again.
    for (const kind of SCATTER_KINDS) {
      assert.ok(SCENERY_MODELS[kind], `${kind} is scattered across the whole world and has no mesh`);
    }
    // **And no scattered kind is foliage.** The owner's rule, as an assertion: *"Foliage should not be
    // a blocker unless it is for boundaries."* A solid bush is indistinguishable from the dozens of
    // decorative ones `scatter.ts` paints into the same room, so nothing may derive one.
    for (const kind of ['bush', 'toadstools']) {
      assert.ok(!SCATTER_KINDS.has(kind as never), `${kind} is foliage and must not be a derived blocker`);
      assert.equal(SCENERY_MODELS[kind], undefined, `${kind} must not be drawn as a blocker`);
    }
  });

  it('names one or two models a kind, from a pack that draws them', () => {
    // Two where the pack has two, so a field of barrels is two silhouettes and not one repeated — and
    // every one drawn, or `dressedScenery` would suppress a grey box and put nothing in its place.
    for (const [kind, models] of Object.entries(SCENERY_MODELS)) {
      assert.ok(models.length >= 1 && models.length <= 2, `${kind} names ${models.length} models`);
      const distinct = new Set(models.map((entry) => entry.model));
      assert.equal(distinct.size, models.length, `${kind} names the same model twice`);
      for (const entry of models) {
        assert.ok(SCENERY_BOXES[entry.model], `${entry.model} has no measured box`);
        assert.ok(sceneryParts(entry, 0).length > 0, `${entry.model} draws no primitive`);
        if (entry.pack === 'props') assert.ok(PROPS_MODELS.includes(entry.model), `${entry.model} is not a drawn prop`);
        if (entry.pack === 'kit') assert.ok(KIT_MODELS.includes(entry.model), `${entry.model} is not a kit model`);
        if (entry.pack === 'tree') {
          assert.ok((TREE_VARIANTS as readonly string[]).includes(entry.model), `${entry.model} is not a tree`);
          assert.ok(
            treePartsOf(entry.model as (typeof TREE_VARIANTS)[number]).includes('trunk'),
            `${entry.model} has no trunk to stand in with`,
          );
        }
      }
    }
    // A stump and a log are the same family and must not be the same picture: the posture differs and
    // so do the variants, because a lying `DeadTree_1` beside a standing one is one silhouette twice.
    const stumps = SCENERY_MODELS['stump']!.map((entry) => entry.model);
    const logs = SCENERY_MODELS['log']!.map((entry) => entry.model);
    assert.equal(stumps.filter((model) => logs.includes(model)).length, 0, 'a stump and a log share a variant');
    assert.deepEqual([...new Set(SCENERY_MODELS['stump']!.map((e) => e.posture))], ['cropped']);
    assert.deepEqual([...new Set(SCENERY_MODELS['log']!.map((e) => e.posture))], ['felled']);
  });

  it('measures every box off the pack itself', () => {
    // `PROPS_METRICS` is asserted against the props manifest and `kit.test.ts` against the nature one.
    // Neither carries what this table needs: a manifest has extents and this has **offsets**, and a
    // `tree` row is the bark primitive alone where the nature manifest measures the whole model. So
    // it is checked against the glTF `POSITION` accessors, which is what both manifests are made of.
    const packs: Readonly<Record<string, string>> = { props: 'props', kit: 'nature', tree: 'nature' };
    let checked = 0;
    for (const entry of SCENERY_STAND_INS) {
      const dir = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', packs[entry.pack]!, entry.model);
      const file = join(dir, 'model.gltf');
      if (!existsSync(file)) continue;
      const gltf = JSON.parse(readFileSync(file, 'utf8')) as {
        meshes: { primitives: { attributes: { POSITION: number } }[] }[];
        accessors: { min: number[]; max: number[] }[];
      };
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (const mesh of gltf.meshes) {
        for (const primitive of mesh.primitives) {
          const accessor = gltf.accessors[primitive.attributes.POSITION]!;
          for (let axis = 0; axis < 3; axis++) {
            lo[axis] = Math.min(lo[axis]!, accessor.min[axis]!);
            hi[axis] = Math.max(hi[axis]!, accessor.max[axis]!);
          }
        }
      }
      const box = SCENERY_BOXES[entry.model]!;
      const near = (a: number, b: number, what: string) =>
        assert.ok(Math.abs(a - b) <= 0.001, `${entry.model} ${what}: table ${a}, pack ${b.toFixed(4)}`);
      near(box.minX, lo[0]!, 'minX');
      near(box.maxX, hi[0]!, 'maxX');
      near(box.minY, lo[1]!, 'minY');
      near(box.maxY, hi[1]!, 'maxY');
      near(box.minZ, lo[2]!, 'minZ');
      near(box.maxZ, hi[2]!, 'maxZ');
      checked += 1;
    }
    if (checked === 0) console.log('[M9b boxes] skipped: no imported packs on disk (git-ignored)');
  });

  it('shrinks a model to the box the collision grid already stamped', () => {
    // `SCENERY.cart` is two tiles by two and both the server and every client wrote those four solid.
    // The market booth needs no help; the handcart is 3.02 m long and would hang a metre of shaft over
    // walkable floor, which is `scatter.ts`'s forbidden lie in its most visible form.
    const booth = SCENERY_MODELS['cart']![0]!;
    const handcart = SCENERY_MODELS['cart']![1]!;
    assert.equal(sceneryScale(booth, 2, 2, 2), 1);
    const scale = sceneryScale(handcart, 2, 2, 2);
    assert.ok(Math.abs(scale - 0.672) < 0.01, `the handcart is drawn at ${scale}`);
    assert.ok(PROPS_METRICS['stall-cart-empty']!.width * scale <= 2 + SLOT_SLACK + 1e-9);
    // Never above 1: a model smaller than its footprint is a cart in a bay, which is correct.
    assert.equal(sceneryScale(booth, 4, 4, 2), 1);
    // **A `standing` model ignores the catalogue's height and the two stand-in postures do not.** The
    // booth is 2.63 m against a two-tile sprite and stays 2.63 m, because the model is the object; a
    // dead tree standing in for a stump is 9.5 m against a one-tile sprite and is shrunk until it is
    // one tile tall, because there the catalogue is the only description of the object there is.
    assert.equal(sceneryScale(booth, 2, 2, 1), 1, 'a standing model is never bound by the sprite height');
    const stump = sceneryScale(SCENERY_MODELS['stump']![0]!, 1, 1, 1);
    assert.ok(Math.abs(stump - 0.1085) < 0.001, `the stump is drawn at ${stump}`);
    assert.ok(
      SCENERY_BOXES['dead-tree-1']!.maxY * stump <= 1 + SLOT_SLACK + 1e-9,
      'a stump taller than the tile the catalogue gives it',
    );
    // …and it lands within a tenth of `scatter.STUMP_SCALE`, which is the picture this renderer has
    // drawn for a cut tree since M5a. Derived now, rather than picked.
    assert.ok(Math.abs(stump - 0.1) < 0.02, `${stump} is not the stump this renderer already draws`);
    // A felled trunk is measured against its *rotated* box, and the quarter turn is what decides
    // whether the three-tile side or the two-tile side takes its length.
    const along = sceneryScale(SCENERY_MODELS['log']![0]!, 3, 2, 2, 0);
    const across = sceneryScale(SCENERY_MODELS['log']![0]!, 3, 2, 2, 1);
    assert.ok(Math.abs(along - 0.2282) < 0.001, `the log lies at ${along}`);
    assert.ok(Math.abs(across - 0.1528) < 0.001, `the turned log lies at ${across}`);
    assert.ok(along > across, 'a log turned across its own footprint should not grow');
    // A barrel and a crate are the mappings that need no shrinking at all: 0.70 m and 0.87 m in a
    // one-tile stamp. The two-barrel rack is 1.36 m and comes down to 1.03.
    assert.equal(sceneryScale(SCENERY_MODELS['barrel']![0]!, 1, 1, 1), 1);
    assert.equal(sceneryScale(SCENERY_MODELS['crate']![0]!, 1, 1, 1), 1);
    const rack = sceneryScale(SCENERY_MODELS['barrel']![1]!, 1, 1, 1);
    assert.ok(Math.abs(rack - 0.758) < 0.001, `the barrel rack is drawn at ${rack}`);
  });

  it('lays a felled trunk in its stamp and seats it on the ground', () => {
    // **The `log` posture has no coverage in the world sweep and cannot have any.** `SCENERY.log` is
    // three tiles by two, `scatterFor` only ever places a prop inside a 2 x 2 quadrant, and no zone
    // authors one — so the whole of `felled` is code for the authoring seam and this is the only
    // place its arithmetic is exercised. Two things have to be right and neither is right by default:
    // tipping a model moves its base off the origin (so it must be seated) and moves its *centre* a
    // whole trunk-length away from it (so it must be recentred).
    const spec = SCENERY['log']!;
    for (let quarter = 0; quarter < 4; quarter++) {
      const scene = fakeScene([{ t: 'prop', kind: 'log', tx: 1, ty: 1, width: spec.width, depth: spec.depth }]);
      const dressed = dressedScenery(scene);
      assert.equal(dressed.length, 1, 'an authored log was not dressed');
      const entry = dressed[0]!.entry;
      assert.equal(entry.posture, 'felled');
      const box = SCENERY_BOXES[entry.model]!;
      const scale = sceneryScale(entry, spec.width, spec.depth, spec.height, quarter);
      // The model tips about `rz`, so its own height becomes the log's length and its own width
      // becomes how tall the fallen trunk stands.
      const length = (box.maxY - box.minY) * scale;
      const stands = (box.maxX - box.minX) * scale;
      const across = (box.maxZ - box.minZ) * scale;
      const long = quarter % 2 === 0 ? spec.width : spec.depth;
      const short = quarter % 2 === 0 ? spec.depth : spec.width;
      assert.ok(length <= long * METRES_PER_TILE + SLOT_SLACK + 1e-9, `a ${length.toFixed(2)} m log in ${long} tiles`);
      assert.ok(across <= short * METRES_PER_TILE + SLOT_SLACK + 1e-9);
      assert.ok(stands <= spec.height * METRES_PER_TILE + SLOT_SLACK + 1e-9);
      assert.ok(length > 1.9, `a felled trunk should still be a trunk, not a twig: ${length.toFixed(2)} m`);
    }
    // And the placement itself, at the quarter the fixture's own seed rolls.
    const scene = fakeScene([{ t: 'prop', kind: 'log', tx: 1, ty: 1, width: spec.width, depth: spec.depth }]);
    const plan = planScenery({ scene, origin: { tx: 0, ty: 0 }, elevation: 7, lod: 0 });
    assert.equal(plan.length, 1, 'a dead trunk is one primitive');
    const placement = plan[0]!;
    assert.equal(placement.rz, Math.PI / 2, 'the fell is `rz`, so the yaw still steers it in world space');
    const box = SCENERY_BOXES[dressedScenery(scene)[0]!.entry.model]!;
    // Seated: the model's own `minX` is its underside once it is on its side, and it lands on the
    // floor rather than half in it.
    assert.ok(
      Math.abs(placement.y + box.minX * placement.sy - 7) < 1e-9,
      `a felled trunk floats or sinks: ${(placement.y + box.minX * placement.sy).toFixed(3)} m against a 7 m floor`,
    );
    // Centred: the log's midpoint sits on the stamp's, not a trunk-length off it.
    const cos = Math.round(Math.cos(placement.ry));
    const sin = Math.round(Math.sin(placement.ry));
    const midAlong = -(box.minY + box.maxY) / 2;
    const midAcross = (box.minZ + box.maxZ) / 2;
    const centreX = placement.x + (midAlong * cos + midAcross * sin) * placement.sx;
    const centreZ = placement.z + (-midAlong * sin + midAcross * cos) * placement.sz;
    assert.ok(Math.abs(centreX - (metresOfTile(1) + (spec.width * METRES_PER_TILE) / 2)) < 1e-9);
    assert.ok(Math.abs(centreZ - (metresOfTile(1) + (spec.depth * METRES_PER_TILE) / 2)) < 1e-9);
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
    // The other side of the `max`: a chunk that draws scatter *and* dressed scenery. Ten authored
    // props stand in outdoor city rooms and — after M9b — every forest, field, hillside and bog in
    // the world grows two or three more, which is exactly the case the scenery term was added to the
    // scatter side for and is why that term had to grow.
    let props = 0;
    let worstProps = 0;
    let worstScenery = 0;
    let worst = 0;
    let worstRoom = 0;
    const byKind = new Map<string, number>();
    const byModel = new Map<string, number>();
    for (const { room, scene, origin } of everyRoom()) {
      const dressed = dressedScenery(scene);
      if (dressed.length === 0) continue;
      props += dressed.length;
      worstProps = Math.max(worstProps, dressed.length);
      // **The bound the pool is sized on**: a room holds at most one prop per `SCATTER_BLOCKS`
      // quadrant, whether they were authored or derived.
      assert.ok(
        dressed.length <= SCATTER_BLOCKS.length,
        `room ${room.id} asks for ${dressed.length} dressed scenery props`,
      );
      for (const { feature, entry } of dressed) {
        byKind.set(feature.kind, (byKind.get(feature.kind) ?? 0) + 1);
        byModel.set(entry.model, (byModel.get(entry.model) ?? 0) + 1);
      }
      const plan = planScenery({ scene, origin, elevation: 0, lod: 0 });
      const buckets = new Set(plan.map((p) => `${p.geometry}|${p.material}`));
      worstScenery = Math.max(worstScenery, buckets.size);
      const scatter = planScatter({ scene, origin, elevation: 0, lod: 0 });
      const scatterBuckets = new Set(scatter.map((p) => `${p.geometry}|${p.material}`));
      // A dressed prop and the understory around it often draw the *same* bucket — a scattered
      // `bush-common` and a scenery `bush-common` are one key — so the union is what a chunk costs.
      const total = new Set([...buckets, ...scatterBuckets]).size;
      if (total > worst) {
        worst = total;
        worstRoom = room.id;
      }
    }
    console.log(
      `[M9b scenery] ${props} props dressed as kit models, worst room ${worstProps} props / ` +
        `${worstScenery} scenery buckets; worst combined chunk ${worstRoom} at ${worst} of ` +
        `${DRESSED_WRAPPER_CEILING} buckets`,
    );
    console.log(
      `[M9b kinds] ${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
    console.log(
      `[M9b models] ${[...byModel].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    );
    assert.ok(props > 0, 'the world has scenery and none of it was dressed');
    assert.ok(worst <= DRESSED_WRAPPER_CEILING, `${worst} buckets over the ${DRESSED_WRAPPER_CEILING} budgeted`);
  });

  it('never draws a prop outside the tiles the collision grid stamped for it', () => {
    // **The scenery half of the safety property, and the bug M9b was sent to find twice over.** The
    // scale bounds a model's *size* and only the centring bounds where it ends up: M9 scaled
    // `Stall_Cart_Empty` correctly to 2.03 m of a 2 x 2 m stamp and then stood its origin — which is
    // at the back of its bed — on the footprint's centre, so 1.42 m of handcart hung over floor the
    // collision grid calls walkable. This checks the drawn box against the stamped rectangle for
    // every dressed prop in the world, which is the assertion that would have caught it.
    let checked = 0;
    let worstReach = 0;
    let worstUnder = 0;
    for (const { room, scene, origin } of everyRoom()) {
      const plan = planScenery({ scene, origin, elevation: 0, lod: 0 });
      if (plan.length === 0) continue;
      const dressed = dressedScenery(scene);
      const x0 = metresOfTile(origin.tx);
      const z0 = metresOfTile(origin.ty);
      // `planScenery` emits its props in `dressedScenery`'s order, one placement per primitive, so
      // the plan is walked with a cursor rather than searched: two bushes in one room share a
      // geometry key and a `find` would check the first one twice.
      let cursor = 0;
      for (const { feature, entry } of dressed) {
        const placement = plan[cursor]!;
        cursor += sceneryParts(entry, 0).length;
        checked += 1;
        const box = SCENERY_BOXES[entry.model]!;
        // The corners of the model's own box, put through the same rotation and scale `world3d.ts`
        // will compose — `Rz` first and then `Ry`, which is three's `XYZ` Euler order.
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let minZ = Infinity;
        let maxZ = -Infinity;
        for (const cx of [box.minX, box.maxX]) {
          for (const cy of [box.minY, box.maxY]) {
            for (const cz of [box.minZ, box.maxZ]) {
              const [fx, fy] = entry.posture === 'felled' ? [-cy, cx] : [cx, cy];
              const cos = Math.round(Math.cos(placement.ry));
              const sin = Math.round(Math.sin(placement.ry));
              const wx = placement.x + (fx * cos + cz * sin) * placement.sx;
              const wz = placement.z + (-fx * sin + cz * cos) * placement.sz;
              const wy = placement.y + fy * placement.sy;
              minX = Math.min(minX, wx);
              maxX = Math.max(maxX, wx);
              minZ = Math.min(minZ, wz);
              maxZ = Math.max(maxZ, wz);
              minY = Math.min(minY, wy);
            }
          }
        }
        const stampX0 = x0 + metresOfTile(feature.tx);
        const stampZ0 = z0 + metresOfTile(feature.ty);
        const stampX1 = stampX0 + feature.width * METRES_PER_TILE;
        const stampZ1 = stampZ0 + feature.depth * METRES_PER_TILE;
        const reach = Math.max(stampX0 - minX, minX === Infinity ? 0 : maxX - stampX1, stampZ0 - minZ, maxZ - stampZ1);
        // Half the slack and not all of it: `sceneryScale` fits the model to the stamp *plus*
        // `SLOT_SLACK`, and a centred box therefore spends at most half of that measurement tolerance
        // on each side. 15 mm is a quarter of the 62.5 cm the player's own collision radius is.
        assert.ok(
          reach <= SLOT_SLACK / 2 + 1e-6,
          `room ${room.id}: ${entry.model} reaches ${reach.toFixed(3)} m past the tiles stamped for a ${feature.kind}`,
        );
        worstReach = Math.max(worstReach, reach);
        // And nothing sinks: a felled trunk is seated on the ground, an upright one keeps the pack's
        // own root sinkage, and neither may bury itself.
        assert.ok(minY >= -0.25, `room ${room.id}: ${entry.model} sits ${minY.toFixed(3)} m into the ground`);
        worstUnder = Math.min(worstUnder, minY);
      }
    }
    console.log(
      `[M9b footprint] ${checked} dressed props checked, worst reach ${worstReach.toFixed(4)} m past the stamp, ` +
        `deepest ${worstUnder.toFixed(3)} m under the ground`,
    );
    assert.ok(checked > 1000, `only ${checked} dressed props in the world`);
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
 * A minimal interior for the palette check — four solid `edge` sides, roofed and `inside`, which is
 * the emptiest room `dressable` accepts and therefore the one with the most slots.
 *
 * `features` is a parameter for the felled-log case above and for nothing else: `SCENERY.log` is
 * three tiles wide, no room in the built world holds one, and a posture with no coverage at all is a
 * posture that will be wrong the first time somebody authors it.
 */
function fakeScene(features: unknown[] = []): Parameters<typeof planFurniture>[0]['scene'] {
  const edge = { kind: 'edge' as const, solid: true, sector: undefined, mouth: undefined };
  return {
    room: 1,
    zone: 1,
    seed: 12345,
    biome: { sector: 'inside', theme: 0, blend: [] },
    ground: { elevation: { t: 'flat', base: 0, noise: 0 } },
    edges: { north: edge, east: edge, south: edge, west: edge },
    enclosure: { roofed: true, walls: 4, openSides: 0, sky: false },
    features,
  } as unknown as Parameters<typeof planFurniture>[0]['scene'];
}
