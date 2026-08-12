/**
 * M6 acceptance: **the second rendering mode, swept over the whole world.**
 *
 * Four properties, and each of them is a thing that would otherwise only be visible as a picture:
 *
 * 1. **The module grid divides.** `9 / 3 = 3` and `3 = CONNECTOR_WIDTH`, so a side is three chords
 *    and a mouth is one, exactly, with no remainder anywhere in the world.
 * 2. **The bucket budget holds.** `pool.ts` sizes its pre-warm from `DRESSED_WRAPPER_CEILING`, which
 *    is a `max` over the scatter's term and the interior's on the argument that no chunk can want
 *    both. That argument is checked here against all 46,544 rooms rather than left in a comment.
 * 3. **`roofedRoom` agrees with the IR.** It is a duplicated fact — `roomScene.isRoofed` is private —
 *    and a duplicated fact is one that can drift.
 * 4. **The camera never looks at a roof from inside, at any pose the dolly can reach.** Derived
 *    rather than eyeballed: the sightline's clearance over the wall head is computed at all four
 *    corners of the clamp.
 *
 * Follows the project's skip-if-absent shape for the world sweep; the geometry and the arithmetic
 * need nothing but numbers and always run.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CARDINALS,
  CONNECTOR_WIDTH,
  ROOM_TILES,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Zone,
} from '@mygame/shared';

import { planChunk } from './chunkPlan.ts';
import { ROOM_METRES, cellOriginTiles, metresOfTile, placeFrame } from './frame.ts';
import {
  CHORDS_PER_SIDE,
  ROOF_RIDGE,
  dressable,
  occludingSides,
  planInterior,
  roleOfPlacement,
  roofGroups,
  roofVisible,
  roofedRoom,
} from './interior.ts';
import { INTERIOR_WRAPPER_CEILING, WRAPPER_CAPACITY } from './pool.ts';
import {
  DIMENSIONS,
  VILLAGE_CHORD,
  VILLAGE_METRICS,
  VILLAGE_SCALE,
  VILLAGE_WALL_MODELS_PER_ROOM,
} from './prototypes.ts';
import { CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_MIN, CAMERA_PITCH_MAX, CAMERA_PITCH_MIN } from './rig.ts';
import { planScatter } from './scatter.ts';
import { WARP_CHORD_SPAN } from './warp.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

const OPEN_SIDES = occludingSides(CAMERA_PITCH_MAX).sides;

describe('the module grid', () => {
  it('maps a 2 m module onto a 9 m room with no remainder', () => {
    // The measurement this whole milestone was started with: every `Wall_*` and every `Floor_*` in
    // the Quaternius Medieval Village pack is exactly two metres across. `village.test.ts` holds that
    // against the generated manifest; this holds the *arithmetic* that follows from it.
    assert.equal(VILLAGE_METRICS.module, 2);
    assert.equal(VILLAGE_CHORD, 3);
    assert.equal(VILLAGE_SCALE, 1.5);
    // Three chords a side, and it is a whole number — which `9 / 2` is not, and which is the entire
    // reason the module is stretched rather than tiled.
    assert.equal(CHORDS_PER_SIDE, 3);
    assert.equal(CHORDS_PER_SIDE % 1, 0);
    assert.equal(CHORDS_PER_SIDE * VILLAGE_CHORD, ROOM_METRES);
    // A chord *is* a mouth: the collision grid carves `CONNECTOR_WIDTH` tiles between two indoor
    // rooms, so the arch across an opening is one module and the flanks either side are one each.
    assert.equal(VILLAGE_CHORD, CONNECTOR_WIDTH);
    assert.equal((ROOM_TILES - CONNECTOR_WIDTH) / 2, VILLAGE_CHORD);
    // And it is the warp's chord too, so a bent wall is one displaced module per piece rather than a
    // module cut in half by a subdivision it knows nothing about.
    assert.equal(VILLAGE_CHORD, WARP_CHORD_SPAN);
  });

  it('leaves the storey height alone, so a wall fits under the floor above', () => {
    // The kit's own storey: `Corner_Exterior_Wood` is exactly 3.000 m to the wall plate and the wall
    // panel 3.1227 m to the top of its eave lip. The ceiling's underside is the former, so the lip is
    // swallowed by the slab, and both sit inside `LEVEL_SEPARATION`'s four metres with room to spare.
    assert.equal(DIMENSIONS.ceilingHeight, 3);
    assert.ok(VILLAGE_METRICS.wallHeight > DIMENSIONS.ceilingHeight);
    assert.ok(
      DIMENSIONS.ceilingHeight + DIMENSIONS.ceilingThickness < 4,
      'a lid that reached the storey above would be the floor of the room over it',
    );
    // The scaled panel's thickness lands on the grey wall's, which is why the suppression in
    // `chunkPlan` is a swap rather than a change of footprint.
    assert.ok(Math.abs(VILLAGE_METRICS.wallDepth * VILLAGE_SCALE - DIMENSIONS.edgeThickness) < 0.02);
    // And the panel's outward lap stays inside the half-gap it shares with its neighbour, so two
    // interiors facing each other across a two-tile gap do not interpenetrate.
    assert.ok(VILLAGE_METRICS.wallOut * VILLAGE_SCALE < 1);
  });
});

describe('what the camera is behind', () => {
  it('finds exactly one occluding side, and clears the wall head, at all four clamp corners', () => {
    const corners: [number, number][] = [
      [CAMERA_DISTANCE_MIN, CAMERA_PITCH_MIN],
      [CAMERA_DISTANCE_MIN, CAMERA_PITCH_MAX],
      [CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN],
      [CAMERA_DISTANCE_MAX, CAMERA_PITCH_MAX],
    ];
    const report: string[] = [];
    for (const [distance, pitch] of corners) {
      const seen = occludingSides(pitch);
      // At yaw 0 the camera is pulled back along +Z, so only the south wall is between it and the
      // room — M6's answer, unchanged, and the fixed point the whole generalisation is checked from.
      assert.deepEqual([...seen.sides], ['south']);
      // **The frame never shows the camera looking at a wall instead of the player.** The sightline
      // to the character's feet passes the south boundary line 4.5 m out; it must be above the wall.
      assert.ok(
        seen.clearance > 0,
        `at ${distance} m / ${pitch}° the south wall is ${-seen.clearance} m above the sightline`,
      );
      // …and the roof is higher than the wall, so a lid that stayed on would be in the way even
      // where the wall is not. That is the whole justification for the cull being a separate rule.
      assert.ok(DIMENSIONS.ceilingHeight + ROOF_RIDGE > DIMENSIONS.ceilingHeight);
      report.push(`${distance} m/${pitch}°: clears by ${seen.clearance} m, hides ${seen.hidden} m of floor`);
    }
    console.log(`[M6 sightline] ${report.join('   ')}`);
    // The shallow pose hides three metres of the room's own floor and the steep one under one and a
    // half. That range is why the near wall fades rather than being left solid: at 45° a third of the
    // room's depth, with whatever is standing in it, is behind a wall the camera can see over.
    assert.ok(occludingSides(CAMERA_PITCH_MIN).hidden > 2.9);
    assert.ok(occludingSides(CAMERA_PITCH_MAX).hidden < 1.6);
  });

  it('follows the camera round: one wall on a cardinal, two on a diagonal — M8', () => {
    /*
     * M6 left this returning a set *"so that the day free yaw arrives, the callers are already asking
     * the right question"*. The day arrived. The answers are asserted against where the camera
     * physically stands rather than against a table, because a table is the thing that would be wrong
     * in the same direction as the code.
     */
    const at = (degrees: number): string[] => [...occludingSides(50, (degrees * Math.PI) / 180).sides].sort();
    assert.deepEqual(at(0), ['south'], 'yaw 0 stands due south — M6, unchanged');
    assert.deepEqual(at(90), ['east'], 'looking west means standing east');
    assert.deepEqual(at(180), ['north']);
    assert.deepEqual(at(-90), ['west']);
    // Halfway between, two walls stand between the camera and the player, and fading only the nearer
    // one would leave a solid corner in the way — the exact frame the fade exists to prevent.
    assert.deepEqual(at(45), ['east', 'south']);
    assert.deepEqual(at(135), ['east', 'north']);
    assert.deepEqual(at(-45), ['south', 'west']);
    assert.deepEqual(at(-135), ['north', 'west']);
  });

  it('never fades a wall the camera is edge-on to, and never fades a wall behind it', () => {
    // `cos 90°` is 6e-17, not 0. Without the deadband a camera due east of the room fades the south
    // wall as well, forever, invisibly — and worse, a yaw resting on the boundary would flip the set
    // on floating-point noise and rebuild the building the player is standing in, frame after frame.
    for (const cardinal of [0, 90, 180, -90]) {
      assert.equal(occludingSides(50, (cardinal * Math.PI) / 180).sides.size, 1, `two walls at yaw ${cardinal}`);
    }
    // Two is the ceiling everywhere, and the two are never opposites — a camera cannot be north and
    // south of the same room.
    for (let yaw = -180; yaw < 180; yaw += 3) {
      const sides = occludingSides(50, (yaw * Math.PI) / 180).sides;
      assert.ok(sides.size >= 1 && sides.size <= 2, `${sides.size} walls at yaw ${yaw}`);
      assert.ok(!(sides.has('north') && sides.has('south')), `north and south together at yaw ${yaw}`);
      assert.ok(!(sides.has('east') && sides.has('west')), `east and west together at yaw ${yaw}`);
    }
  });

  it('answers with the same object for the same set, so a rebuild is a `!==` and not a walk', () => {
    // `world3d.setCameraFrame` compares by identity to decide whether any wall in the window has to
    // be rebuilt. A fresh `Set` per call would rebuild the player's building sixty times a second,
    // which is the one place in this renderer a camera move would allocate.
    const a = occludingSides(50, 0).sides;
    const b = occludingSides(64, 0).sides;
    assert.equal(a, b, 'the pitch changed the set object');
    assert.equal(occludingSides(50, 0.01).sides, a, 'a yaw inside the deadband changed the set object');
    // And within one octant — where the answer is the same *pair* — it is also the same object, so
    // sixty frames of a slow orbit through the south-east cost sixty comparisons and no rebuild.
    const pair = occludingSides(50, 0.5).sides;
    assert.equal(occludingSides(64, 0.9).sides, pair, 'two yaws in one octant gave two set objects');
    assert.notEqual(pair, a, 'a quarter turn did not change the set');
  });
});

if (!existsSync(ZONES_DIR)) {
  describe('the interior sweep', () => {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
  });
} else {
  const zones = readdirSync(ZONES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => JSON.parse(readFileSync(join(ZONES_DIR, file), 'utf8')) as Zone)
    .sort((a, b) => a.id - b.id);
  const rooms = indexRooms(zones);

  describe('the interior sweep', () => {
    it('agrees with the IR about which rooms have a lid, everywhere', () => {
      // `roofedRoom` restates `roomScene.isRoofed`, which is private there, because `roofGroups` is a
      // graph walk that would otherwise have to describe five thousand scenes to learn eighteen
      // booleans. A duplicated fact is a fact that can drift, so it is swept.
      let roofed = 0;
      let checked = 0;
      for (const zone of zones) {
        const context = sceneZone(zone);
        const cells = cellIndex(zone);
        for (const room of zone.rooms) {
          const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
          assert.equal(roofedRoom(room), scene.enclosure.roofed, `room ${room.id}`);
          if (scene.enclosure.roofed) roofed += 1;
          checked += 1;
        }
      }
      console.log(`[M6 enclosure] ${roofed} of ${checked} rooms are roofed (${((100 * roofed) / checked).toFixed(1)}%)`);
      assert.ok(checked > 46000);
      assert.ok(roofed > 18000, `only ${roofed} roofed rooms — the second rendering mode has no world`);
    });

    it('gives every roofed room a lid, and takes it away only when the player is under it', () => {
      let lidded = 0;
      let open = 0;
      let sky = 0;
      for (const zone of zones.slice(0, 60)) {
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
          const base = { scene, origin, elevation: 0, gap: frame.gap, faded: false, doorClosed: {} };
          const closed = planChunk(base).filter((p) => p.archetype === 'ceiling');
          const lifted = planChunk({ ...base, roof: 'open' }).filter((p) => p.archetype === 'ceiling');
          const tiled = planChunk({ ...base, roof: 'kit' }).filter((p) => p.archetype === 'ceiling');
          if (scene.enclosure.roofed) {
            assert.equal(closed.length, 1, `room ${room.id} has no lid`);
            // Wider than the room by the whole gap, so two interiors joined by a corridor have a
            // continuous ceiling over the doorway rather than a strip of sky.
            assert.ok(closed[0]!.sx > ROOM_METRES, `room ${room.id}'s lid does not cover its doorways`);
            assert.equal(lifted.length, 0, `room ${room.id} kept its lid with the player under it`);
            assert.equal(tiled.length, 0, `room ${room.id} kept its slab under a tiled roof`);
            lidded += 1;
            open += 1;
          } else {
            assert.equal(closed.length, 0, `room ${room.id} has sky and grew a ceiling anyway`);
            sky += 1;
          }
        }
      }
      console.log(`[M6 lids] ${lidded} roofed rooms lidded, ${open} opened on demand, ${sky} left under the sky`);
      assert.ok(lidded > 2000);
      assert.ok(sky > 2000);
    });

    it('never lets one chunk want both the understory and the interior', () => {
      // The exclusivity `pool.DRESSED_WRAPPER_CEILING` is a `max` over. A room dressed by
      // `interior.ts` is roofed and `inside`; no scatter table has an `inside` row and `planPuddles`
      // refuses a roofed room outright. If that ever stops being true the pool is undersized and the
      // ledger stops being flat, which is the acceptance this milestone inherited.
      let dressed = 0;
      let both = 0;
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
          if (!dressable(scene)) continue;
          dressed += 1;
          const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
          if (planScatter({ scene, origin, elevation: 0, lod: 0 }).length > 0) both += 1;
        }
      }
      console.log(`[M6 exclusivity] ${dressed} rooms dressed as interiors, ${both} of them also scattered`);
      assert.equal(both, 0, 'a chunk wanted both the scatter budget and the interior budget');
      assert.ok(dressed > 9000, `only ${dressed} dressed rooms`);
    });

    it('keeps the worst interior inside its bucket and instance budget', () => {
      let worstBuckets = 0;
      let worstInstances = 0;
      let worstRoom = 0;
      let totalModules = 0;
      let rooms3 = 0;
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
          if (!dressable(scene)) continue;
          const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
          // The worst case is `top` — a building with open air over it draws a roof and a chimney on
          // top of everything else — and closed, because an open one draws no roof at all.
          const plan = planInterior({
            scene,
            origin,
            elevation: 0,
            roofOpen: false,
            top: true,
            openSides: OPEN_SIDES,
          });
          rooms3 += 1;
          totalModules += plan.length;
          const buckets = new Map<string, number>();
          for (const p of plan) {
            const key = `${p.geometry}|${p.material}`;
            buckets.set(key, (buckets.get(key) ?? 0) + 1);
          }
          if (buckets.size > worstBuckets) {
            worstBuckets = buckets.size;
            worstRoom = room.id;
          }
          for (const count of buckets.values()) worstInstances = Math.max(worstInstances, count);
          // Distinct wall models never exceeds the pool's own cap: a plain and a feature, chosen by
          // theme, and nothing hashed can add a third.
          const models = new Set(
            plan.filter((p) => roleOfPlacement(p) === 'wall').map((p) => p.geometry.split(':')[1]),
          );
          assert.ok(
            models.size <= VILLAGE_WALL_MODELS_PER_ROOM,
            `room ${room.id} wants ${models.size} wall models`,
          );
        }
      }
      console.log(
        `[M6 budget] ${rooms3} interiors, ${totalModules} modules, ` +
          `worst room ${worstRoom} at ${worstBuckets} of ${INTERIOR_WRAPPER_CEILING} buckets, ` +
          `worst bucket ${worstInstances} of ${WRAPPER_CAPACITY} instances`,
      );
      assert.ok(
        worstBuckets <= INTERIOR_WRAPPER_CEILING,
        `${worstBuckets} buckets over the ${INTERIOR_WRAPPER_CEILING} the pool is sized for`,
      );
      assert.ok(
        worstInstances <= WRAPPER_CAPACITY,
        `${worstInstances} instances in one bucket, over the ${WRAPPER_CAPACITY} a wrapper holds`,
      );
    });

    it('puts every wall on a boundary line and nothing bulky on the floor', () => {
      // The rule `scatter.ts` lives by, restated for masonry: the renderer must never imply a
      // blockage the collision grid lacks. A village wall stands on the room's own boundary, where a
      // grey box already stood and where the grid has no walkable tile; a floor tile is 2 cm thick
      // and lies flat. Nothing else is placed inside the block at all.
      let walls = 0;
      let floors = 0;
      for (const zone of zones.slice(0, 80)) {
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
          if (!dressable(scene)) continue;
          const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
          const x0 = origin.tx;
          const z0 = origin.ty;
          for (const p of planInterior({
            scene,
            origin,
            elevation: 0,
            roofOpen: false,
            top: true,
            openSides: OPEN_SIDES,
          })) {
            const role = roleOfPlacement(p);
            if (role === 'wall' || role === 'arch') {
              const onX = Math.abs(p.x - x0) < 1e-6 || Math.abs(p.x - (x0 + ROOM_METRES)) < 1e-6;
              const onZ = Math.abs(p.z - z0) < 1e-6 || Math.abs(p.z - (z0 + ROOM_METRES)) < 1e-6;
              assert.ok(onX || onZ, `room ${room.id}: a ${role} stands inside the block at ${p.x},${p.z}`);
              walls += 1;
            }
            if (role === 'floor') {
              assert.ok(p.y <= 0.05, `room ${room.id}: a floor tile is ${p.y} m off the ground`);
              floors += 1;
            }
          }
        }
      }
      console.log(`[M6 placement] ${walls} walls and arches on boundary lines, ${floors} floor tiles laid flat`);
      assert.ok(walls > 5000);
      assert.ok(floors > 5000);
    });

    it('groups the rooms that share a lid, and stops at the building line', () => {
      let groups = 0;
      let members = 0;
      let largest = 0;
      let largestZone = 0;
      for (const zone of zones) {
        const of = roofGroups(zone, roofedRoom);
        const sizes = new Map<number, number>();
        for (const group of of.values()) sizes.set(group, (sizes.get(group) ?? 0) + 1);
        groups += sizes.size;
        members += of.size;
        for (const [, size] of sizes) {
          if (size > largest) {
            largest = size;
            largestZone = zone.id;
          }
        }
        // A group is roofed rooms only, and it never crosses a level: a cellar and the room above it
        // are two lids, which is exactly what makes the vertical policy compose.
        for (const [id, group] of of) {
          const room = zone.rooms.find((candidate) => candidate.id === id)!;
          const head = zone.rooms.find((candidate) => candidate.id === group)!;
          assert.ok(roofedRoom(room), `room ${id} is in a roof group and has sky`);
          assert.equal(room.pos.z, head.pos.z, `roof group ${group} spans two levels`);
          assert.ok(group <= id, 'a group id must be the smallest room id in it');
        }
      }
      console.log(
        `[M6 roofs] ${groups} roof groups over ${members} roofed rooms, ` +
          `mean ${(members / groups).toFixed(1)}, largest ${largest} in zone ${largestZone}`,
      );
      assert.ok(groups > 1000, `only ${groups} roof groups — the lid is a global switch, not a building`);
      assert.ok(members > 18000);
    });

    it('opens a tavern without opening the house next door', () => {
      // The property the whole roof-group idea exists for, on a real street. Bryn Shander is 229
      // inside rooms lining 119 city ones; if the groups were a level-wide toggle its whole main
      // street would lose its roofs the moment somebody stepped inside a shop.
      const zone = zones.find((candidate) => candidate.id === 123);
      if (!zone) return;
      const of = roofGroups(zone, roofedRoom);
      const sizes = new Map<number, number>();
      for (const group of of.values()) sizes.set(group, (sizes.get(group) ?? 0) + 1);
      const ranked = [...sizes.values()].sort((a, b) => b - a);
      console.log(
        `[M6 Bryn Shander] ${sizes.size} separate lids over ${of.size} roofed rooms, ` +
          `sizes ${ranked.slice(0, 6).join('/')}…`,
      );
      assert.ok(sizes.size > 20, `Bryn Shander resolved to ${sizes.size} lids — that is a level switch`);
      // **A measured surprise, recorded rather than asserted away.** 135 of Bryn Shander's 229 inside
      // rooms are one connected component: the zone's interiors link to *each other* rather than back
      // out to the street, so the town is one warren and fifty-eight small buildings. That is the
      // world's own topology and the grouping is reading it correctly — and it costs nothing, because
      // opening a lid rebuilds the chunks **in the window**, never the group. What the assertion
      // guards is the thing that would be a bug: a group that had swallowed the whole level.
      assert.ok(ranked[0]! < of.size, 'one lid covers every roofed room — the groups are a level switch');
      assert.ok(ranked.filter((size) => size <= 4).length > 40, 'the small buildings have been merged away');
    });

    it('never draws a lid on a room that has one above it, and never a roof either', () => {
      // The composition the brief asks for: *"an upper floor's floor is not the lower floor's missing
      // ceiling"*. Both halves are checked — a stacked room keeps its own slab (so standing in it you
      // are not looking at the underside of the storey above, which is hard-culled anyway) and does
      // **not** get a tiled gable, because a gable inside a building is a roof in a bedroom.
      const zone = zones.find((candidate) => candidate.id === 273);
      if (!zone) return;
      const cells = cellIndex(zone);
      const context = sceneZone(zone);
      let stacked = 0;
      let tops = 0;
      let buried = 0;
      for (const room of zone.rooms) {
        if (!roofedRoom(room)) continue;
        const above = zone.rooms.some(
          (candidate) =>
            candidate.pos.x === room.pos.x && candidate.pos.y === room.pos.y && candidate.pos.z === room.pos.z + 1,
        );
        const frame = placeFrame(zone, room.pos.z);
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        if (!dressable(scene)) continue;
        const plan = planInterior({
          scene,
          origin: cellOriginTiles(frame, room.pos.x, room.pos.y),
          elevation: 0,
          roofOpen: false,
          top: !above,
          openSides: OPEN_SIDES,
        });
        const roofs = plan.filter((p) => roleOfPlacement(p) === 'roof').length;
        if (above) {
          assert.equal(roofs, 0, `room ${room.id} has a storey above it and grew a tiled roof`);
          stacked += 1;
        } else if (roofVisible(scene)) {
          assert.ok(roofs > 0, `room ${room.id} fronts a street and grew no roof`);
          tops += 1;
        } else {
          // Nothing above it and nothing outside it — a chamber cut into rock. It keeps the flat lid.
          assert.equal(roofs, 0, `room ${room.id} is walled in on every side and grew a gable`);
          buried += 1;
        }
      }
      console.log(
        `[M6 Skullport stacks] ${stacked} interiors with a storey above, ${tops} fronting a street, ` +
          `${buried} walled in on every side`,
      );
      assert.ok(stacked > 20, `only ${stacked} stacked interiors in Skullport — the case is not exercised`);
      assert.ok(tops > 20);
    });

    it('fades exactly the wall the camera is behind, and nothing else', () => {
      const zone = zones.find((candidate) => candidate.id === 123)!;
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      let opened = 0;
      for (const room of zone.rooms) {
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        if (!dressable(scene)) continue;
        const frame = placeFrame(zone, room.pos.z);
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        const plan = planInterior({
          scene,
          origin,
          elevation: 0,
          roofOpen: true,
          top: true,
          openSides: OPEN_SIDES,
        });
        const z0 = origin.ty;
        for (const p of plan) {
          const role = roleOfPlacement(p);
          if (role !== 'wall' && role !== 'arch') continue;
          const south = Math.abs(p.z - (z0 + ROOM_METRES)) < 1e-6;
          const open = p.material.endsWith('|open');
          assert.equal(open, south, `room ${room.id}: a ${south ? 'south' : 'non-south'} wall is ${open ? '' : 'not '}open`);
          if (open) opened += 1;
        }
        // …and with the lid on, nothing fades at all: the fade is what the *cull* costs, not a look.
        const shut = planInterior({
          scene,
          origin,
          elevation: 0,
          roofOpen: false,
          top: true,
          openSides: OPEN_SIDES,
        });
        assert.equal(shut.filter((p) => p.material.endsWith('|open')).length, 0, `room ${room.id} faded a closed wall`);
      }
      console.log(`[M6 fade] ${opened} south-wall placements drawn open across Bryn Shander`);
      assert.ok(opened > 100);
    });

    it('fades the walls the camera is behind at any yaw, and the corner opens both — M8', () => {
      /*
       * The same sweep, turned. What is checked is not "the south wall" but the geometric fact
       * underneath it: a wall placement is drawn open exactly when the camera stands out past *that
       * side's* boundary line. The corner case is the point — orbit to the south-east and a room
       * opens two of its four walls, because both stand between the camera and the floor.
       *
       * Bryn Shander rather than the fixture because a real town has rooms with every combination of
       * mouths and edges, and the arch on a mouth takes the same `open` flag the flanking chords do.
       */
      const zone = zones.find((candidate) => candidate.id === 123)!;
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const tally = new Map<string, number>();
      for (const yawDegrees of [0, 45, 90, 135, 180, -135, -90, -45]) {
        const yaw = (yawDegrees * Math.PI) / 180;
        const sides = occludingSides(50, yaw).sides;
        for (const room of zone.rooms) {
          const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
          if (!dressable(scene)) continue;
          const frame = placeFrame(zone, room.pos.z);
          const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
          const plan = planInterior({ scene, origin, elevation: 0, roofOpen: true, top: true, openSides: sides });
          const x0 = metresOfTile(origin.tx);
          const z0 = metresOfTile(origin.ty);
          for (const p of plan) {
            const role = roleOfPlacement(p);
            if (role !== 'wall' && role !== 'arch') continue;
            // Which side this placement sits on, from where it was put rather than from a label.
            const side =
              Math.abs(p.z - (z0 + ROOM_METRES)) < 1e-6
                ? 'south'
                : Math.abs(p.z - z0) < 1e-6
                  ? 'north'
                  : Math.abs(p.x - (x0 + ROOM_METRES)) < 1e-6
                    ? 'east'
                    : 'west';
            const open = p.material.endsWith('|open');
            assert.equal(open, sides.has(side), `yaw ${yawDegrees}, room ${room.id}: ${side} wall open=${open}`);
            if (open) tally.set(`${yawDegrees}`, (tally.get(`${yawDegrees}`) ?? 0) + 1);
          }
        }
      }
      const cardinal = tally.get('0') ?? 0;
      const diagonal = tally.get('45') ?? 0;
      console.log(`[M8 fade] Bryn Shander opens ${cardinal} placements due south and ${diagonal} on the south-east diagonal`);
      // The diagonal opens roughly two sides' worth where a cardinal opens one — the whole difference
      // free yaw makes to this file, stated as a number rather than as a claim.
      assert.ok(diagonal > cardinal * 1.5, `${diagonal} vs ${cardinal}`);
    });

    it('dresses a street’s block faces without inventing a building', () => {
      // The brief's rule: *"an inside room IS the building; its exterior faces are what the street
      // sees"*. So a `city` room draws nothing of its own, and every wall a street sees belongs to an
      // inside room that is genuinely there. Measured on Bryn Shander: how many city rooms have an
      // inside neighbour, and how many of those neighbours dress the shared boundary.
      const zone = zones.find((candidate) => candidate.id === 123)!;
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      const frame = placeFrame(zone, 0);
      let streets = 0;
      let faces = 0;
      let fromCity = 0;
      let openAirPlacements = 0;
      for (const room of zone.rooms) {
        if (roofedRoom(room)) continue;
        streets += 1;
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        const origin = cellOriginTiles(frame, room.pos.x, room.pos.y);
        openAirPlacements += planInterior({
          scene,
          origin,
          elevation: 0,
          roofOpen: false,
          top: true,
          openSides: OPEN_SIDES,
        }).length;
        for (const dir of CARDINALS) {
          const across = scene.edges[dir].to;
          const neighbour = across === undefined ? undefined : rooms.get(across);
          if (neighbour?.sector !== 'inside') continue;
          faces += 1;
          if (room.sector === 'city') fromCity += 1;
        }
      }
      // Measured, and the split is the interesting part: Bryn Shander is 192 `road` rooms and 119
      // `city` ones, and most of its shop doors open off a road rather than off a square — so 141 of
      // the block faces the open air sees belong to a road and only 19 to a street proper. Both are
      // dressed identically, because it is the *inside* room that owns the wall.
      console.log(
        `[M6 streets] ${streets} open-air rooms, ${faces} block faces onto an inside room ` +
          `(${fromCity} of them from a city room), ${openAirPlacements} village modules of their own`,
      );
      assert.equal(openAirPlacements, 0, 'an open-air room grew village geometry — a street is ground');
      assert.ok(faces > 100, `only ${faces} street-to-building faces in Bryn Shander`);
    });
  });
}
