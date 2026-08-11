/**
 * M2 acceptance: the scene IR's invariants over **every room in the built world**.
 *
 * The plan is emphatic about the shape of this file and it is right: *"do not use snapshot tests over
 * a fixed room sample; they rot on the first density tweak and say nothing about the other 46,000
 * rooms. Assert invariants over all 46,508 rooms."* So there is no snapshot here and no golden file.
 * Every test below is a property that must hold for all 46,544 rooms of the world as built, and the
 * whole sweep — 328 zones parsed, 46,544 scenes derived, 1,827 tile grids built and cross-checked —
 * runs in a couple of seconds and prints its own wall time.
 *
 * It lives in `worldgen` and not in `shared` because it reads `data/world`, which `shared` may not do
 * (no I/O in that package, by rule). It follows `terrain-report.test.ts`'s skip-if-absent shape:
 * `data/world` is git-ignored and reproducible with `npm run worldgen`.
 *
 * ## The cross-check against real geometry is the point
 *
 * Four of these invariants are not statements about the IR's internal consistency — they compare it
 * against the tile grid the server and the client actually collide against. An IR that said "solid"
 * where `buildZoneTilemap` carves a corridor would be a wall the player walks through, and no amount
 * of internal tidiness would catch it. That is the failure this file exists to make impossible.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CARDINALS,
  DIRECTION_DELTA,
  EDGE_KINDS,
  OPPOSITE,
  ROOM_GAP,
  ROOM_TILES,
  SEAM_GAP,
  Tile,
  buildZoneTilemap,
  cellIndex,
  cellKey,
  describeRoom,
  featureFootprint,
  indexRooms,
  isWalkable,
  neighboursOf,
  sceneSeed,
  sceneZone,
  sceneryOf,
  tileAt,
  walkableRequired,
  type Cardinal,
  type EdgeKind,
  type Room,
  type RoomScene,
  type Sector,
  type Zone,
} from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

describe('M2: the scene IR over the whole built world', () => {
  if (!existsSync(ZONES_DIR)) {
    it('skips: data/world/zones is absent', (t) => {
      t.skip(`no generated world data at ${ZONES_DIR} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const started = Date.now();

  const zones = readdirSync(ZONES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ZONES_DIR, f), 'utf8')) as Zone);
  const rooms = indexRooms(zones);

  /* ---------------------------------------------------------------------- */
  /* One sweep, many buckets                                                 */
  /* ---------------------------------------------------------------------- */

  /** A failed invariant, as a sentence naming the room. Kept, not thrown, so the count is reportable. */
  type Failure = string;
  const fail = {
    geometry: [] as Failure[],
    solid: [] as Failure[],
    carved: [] as Failure[],
    walkable: [] as Failure[],
    overlap: [] as Failure[],
    props: [] as Failure[],
    order: [] as Failure[],
    component: [] as Failure[],
    pure: [] as Failure[],
    exhaustive: [] as Failure[],
  };
  /** Every bucket is capped: 46,544 rooms can produce 46,544 identical sentences and nobody reads them. */
  const record = (bucket: Failure[], message: string): void => {
    if (bucket.length < 20) bucket.push(message);
    else if (bucket.length === 20) bucket.push('... (further failures suppressed)');
  };

  const edgeCount: Record<EdgeKind, number> = { open: 0, edge: 0, barrier: 0, portal: 0, door: 0 };
  const enclosureCount = [0, 0, 0, 0, 0];
  const sectorPairs = new Set<string>();
  const landmarkKinds = new Map<string, number>();
  let roomCount = 0;
  let seamEdges = 0;
  let inboundEdges = 0;
  let cardinalExits = 0;
  let verticalFeatures = 0;
  let roomsWithLandmark = 0;
  let sameLevelNonPortalExits = 0;
  let geometryMismatches = 0;
  let sharedCells = 0;
  let componentCount = 0;
  let authoredOnRing = 0;
  let propOnStairTiles = 0;
  const stairPropRooms = new Set<number>();
  const required = walkableRequired();

  for (const zone of zones) {
    const context = sceneZone(zone);
    const cells = cellIndex(zone);
    const scenes = new Map<number, RoomScene>();
    for (const room of zone.rooms) {
      scenes.set(room.id, describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room)));
    }
    for (const id of new Set(context.ground?.of.values() ?? [])) {
      void id;
      componentCount += 1;
    }

    // Cells holding more than one room. 31 in the world; the tile grid's `cells` map keeps the last
    // writer, so both rooms share one block of floor and a per-room geometry check cannot be honest
    // about either. Excluded from the grid cross-checks only, and counted so the exclusion is visible.
    const occupants = new Map<string, number>();
    for (const room of zone.rooms) {
      const key = cellKey(room.pos.x, room.pos.y, room.pos.z);
      occupants.set(key, (occupants.get(key) ?? 0) + 1);
    }
    const contested = new Set([...occupants].filter(([, n]) => n > 1).map(([key]) => key));
    sharedCells += contested.size;

    const gap = zone.seamless === true ? SEAM_GAP : ROOM_GAP;

    for (const level of [...new Set(zone.rooms.map((r) => r.pos.z))].sort((a, b) => a - b)) {
      const grid = buildZoneTilemap(zone, level);
      for (const room of zone.rooms) {
        if (room.pos.z !== level) continue;
        const scene = scenes.get(room.id)!;
        const origin = grid.roomOrigins.get(room.id);
        roomCount += 1;

        /* --- the safety claim the whole classification rests on --------- */
        for (const dir of CARDINALS) {
          const exit = room.exits[dir];
          if (!exit) continue;
          cardinalExits += 1;
          const target = rooms.get(exit.to);
          if (!target || exit.portal === true) continue;
          if (target.zone !== room.zone || target.pos.z !== room.pos.z) continue;
          sameLevelNonPortalExits += 1;
          const delta = DIRECTION_DELTA[dir];
          if (
            target.pos.x !== room.pos.x + delta[0] ||
            target.pos.y !== room.pos.y + delta[1] ||
            target.pos.z !== room.pos.z + delta[2]
          ) {
            geometryMismatches += 1;
            record(fail.geometry, `room ${room.id} ${dir} -> ${exit.to} is not the grid neighbour`);
          }
        }

        /* --- edge classes, and their agreement with the tile grid ------- */
        for (const dir of CARDINALS) {
          const edge = scene.edges[dir];
          edgeCount[edge.kind] += 1;
          if (edge.seam) seamEdges += 1;
          if (edge.inbound) inboundEdges += 1;
          if (edge.sector !== undefined && edge.sector !== room.sector && !edge.solid) {
            sectorPairs.add([room.sector, edge.sector].sort().join('|'));
          }
          if (!EDGE_KINDS.includes(edge.kind)) {
            record(fail.exhaustive, `room ${room.id} ${dir} has kind ${JSON.stringify(edge.kind)}`);
          }
          if (edge.solid !== (edge.kind === 'edge' || edge.kind === 'barrier')) {
            record(fail.exhaustive, `room ${room.id} ${dir}: solid disagrees with kind ${edge.kind}`);
          }
          if (!origin || contested.has(cellKey(room.pos.x, room.pos.y, room.pos.z))) continue;

          const strip = gapStrip(origin, dir, gap);
          if (edge.solid) {
            // **Every barrier edge is solid.** Nothing across it may be walked, or the renderer would
            // be drawing a wall the collision grid lets a body straight through.
            for (const { tx, ty } of strip) {
              if (isWalkable(tileAt(grid, tx, ty))) {
                record(fail.solid, `room ${room.id} ${dir} is ${edge.kind} but tile ${tx},${ty} is walkable`);
                break;
              }
            }
          } else if (edge.mouth?.carved === true && edge.to !== undefined) {
            const target = rooms.get(edge.to);
            if (!target || target.zone !== room.zone || target.pos.z !== room.pos.z) continue;
            // ...and the converse: a mouth the IR reports as carved must be cut in the grid.
            for (const { tx, ty } of mouthStrip(origin, dir, gap, edge.mouth.span)) {
              if (tileAt(grid, tx, ty) === Tile.Void) {
                record(fail.carved, `room ${room.id} ${dir} claims a ${edge.mouth.span}-tile mouth; ${tx},${ty} is void`);
                break;
              }
            }
          }
        }

        enclosureCount[scene.enclosure.solid] = (enclosureCount[scene.enclosure.solid] ?? 0) + 1;

        /* --- features: the walkable law, no overlaps, and scenery parity - */
        // A room a human dressed is exempt from the *derived* placement law, and only from that one:
        // `scatterFor` obeys the four blocks because nothing can see the room it is filling, while an
        // author looked at theirs. `scenerySiting` polices authored props separately and differently.
        const authored = (room.scenery?.length ?? 0) > 0;
        const taken = new Map<number, string>();
        for (const feature of scene.features) {
          for (const cell of featureFootprint(feature)) {
            // Stairs are walkable geometry — `Tile.StairsUp` passes `isWalkable` — so they may stand
            // on the arrival ring. Props and landmarks are solid and may not.
            if (feature.t !== 'stair' && required.has(cell)) {
              if (authored && feature.t === 'prop') authoredOnRing += 1;
              else record(fail.walkable, `room ${room.id}: ${feature.t} at ${feature.tx},${feature.ty} is on a tile that must stay walkable`);
            }
            if (cell < 0 || cell >= ROOM_TILES * ROOM_TILES) {
              record(fail.walkable, `room ${room.id}: ${feature.t} at ${feature.tx},${feature.ty} leaves the room block`);
            }
            const other = taken.get(cell);
            if (other !== undefined) {
              // The one overlap that is neither this milestone's to guarantee nor its to fix: see
              // the `pins the one overlap it inherited` test for the whole argument.
              if ((other === 'stair') !== (feature.t === 'stair') && feature.t !== 'landmark' && other !== 'landmark') {
                propOnStairTiles += 1;
                stairPropRooms.add(room.id);
              } else {
                record(fail.overlap, `room ${room.id}: ${feature.t} at ${feature.tx},${feature.ty} overlaps a ${other}`);
              }
            }
            taken.set(cell, feature.t);
          }
          if (feature.t === 'landmark') landmarkKinds.set(feature.kind, (landmarkKinds.get(feature.kind) ?? 0) + 1);
          if (feature.t === 'stair') verticalFeatures += 1;
        }
        if (scene.features.some((f) => f.t === 'landmark')) roomsWithLandmark += 1;

        const props = sceneryOf(room);
        const carried = scene.features.filter((f) => f.t === 'prop');
        if (carried.length !== props.length) {
          record(fail.props, `room ${room.id}: ${carried.length} props in the scene, ${props.length} in sceneryOf`);
        } else {
          for (let i = 0; i < props.length; i++) {
            const a = props[i]!;
            const b = carried[i]!;
            if (b.t !== 'prop' || b.kind !== a.kind || b.tx !== a.tx || b.ty !== a.ty) {
              record(fail.props, `room ${room.id}: prop ${i} is ${JSON.stringify(b)}, sceneryOf says ${JSON.stringify(a)}`);
            }
          }
        }

        /* --- iteration order ------------------------------------------- */
        const forward = scene.features.map((f) => featureFootprint(f).join(','));
        const reverse = [...scene.features].reverse().map((f) => featureFootprint(f).join(','));
        if (forward.join('|') !== [...reverse].reverse().join('|')) {
          record(fail.order, `room ${room.id}: features are not order-free`);
        }

        /* --- purity: the same question twice --------------------------- */
        const again = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        if (JSON.stringify(again) !== JSON.stringify(scene)) {
          record(fail.pure, `room ${room.id}: two identical calls disagreed`);
        }
      }
    }

    /* --- ground components agree from both sides ---------------------- */
    for (const room of zone.rooms) {
      const scene = scenes.get(room.id)!;
      for (const dir of CARDINALS) {
        const exit = room.exits[dir];
        if (!exit || exit.portal === true) continue;
        const target = rooms.get(exit.to);
        if (!target || target.zone !== room.zone || target.pos.z !== room.pos.z) continue;
        const other = scenes.get(target.id);
        if (!other) continue;
        if (scene.ground.component < 0 || other.ground.component < 0) continue;
        if (scene.ground.component !== other.ground.component) {
          record(fail.component, `rooms ${room.id} and ${target.id} are linked outdoor but in components ${scene.ground.component} and ${other.ground.component}`);
          continue;
        }
        const a = scene.ground.elevation;
        const b = other.ground.elevation;
        if (a.t === 'continuous' && b.t === 'continuous' && a.base !== b.base) {
          record(fail.component, `rooms ${room.id} and ${target.id} share component ${scene.ground.component} but disagree on base (${a.base} vs ${b.base})`);
        }
      }
    }
  }

  const elapsedMs = Date.now() - started;
  const totalEdges = Object.values(edgeCount).reduce((a, b) => a + b, 0);

  /* ---------------------------------------------------------------------- */
  /* The invariants                                                          */
  /* ---------------------------------------------------------------------- */

  it('reports what it swept, and how long it took', () => {
    const pct = (n: number): string => `${((100 * n) / totalEdges).toFixed(2)}%`;
    console.log(
      [
        '',
        `  swept ${roomCount} rooms in ${zones.length} zones, ${totalEdges} cardinal edges, in ${elapsedMs} ms`,
        `  edge classes  ${EDGE_KINDS.map((k) => `${k} ${edgeCount[k]} (${pct(edgeCount[k])})`).join('  ')}`,
        `                of which ${seamEdges} seam and ${inboundEdges} inbound`,
        `  enclosure     ${enclosureCount.map((n, i) => `${i}:${n}`).join('  ')}`,
        `  ground        ${componentCount} components; ${sharedCells} contested cells excluded from grid checks`,
        `  sector pairs  ${sectorPairs.size} distinct across crossable edges`,
        `  landmarks     ${roomsWithLandmark} rooms (${((100 * roomsWithLandmark) / roomCount).toFixed(1)}%): ` +
          [...landmarkKinds].sort().map(([k, n]) => `${n} ${k}`).join(', '),
        `  vertical      ${verticalFeatures} stair/ramp features; ${cardinalExits} cardinal exits`,
        `  geometry      ${sameLevelNonPortalExits} same-level non-portal exits, ${geometryMismatches} mismatches`,
        `  inherited     ${propOnStairTiles} prop-on-stair tiles in ${stairPropRooms.size} rooms; ` +
          `${authoredOnRing} authored-prop tiles on the arrival ring`,
        '',
      ].join('\n'),
    );
    assert.ok(roomCount > 40_000, `only ${roomCount} rooms swept — is data/world complete?`);
    // Not a benchmark, a guard: the plan's whole argument for exhaustive invariants is that they are
    // cheap. If this ever takes a minute, someone has put a quadratic in the sweep.
    assert.ok(elapsedMs < 60_000, `the sweep took ${elapsedMs} ms; it is meant to be seconds`);
  });

  /**
   * The claim every other edge test depends on: *"all same-level non-portal exits land on exact grid
   * neighbours with zero mismatches"*. If it ever stops being true, "no exit this way" stops meaning
   * "there is a boundary here" and the barrier class quietly becomes a guess.
   */
  it('verifies the plan\'s safety claim: same-level non-portal exits land on the exact grid neighbour', () => {
    assert.ok(sameLevelNonPortalExits > 100_000, `only ${sameLevelNonPortalExits} such exits — the sweep is wrong`);
    assert.equal(geometryMismatches, 0, fail.geometry.join('\n'));
  });

  it('classifies every edge as exactly one known kind, with solid agreeing', () => {
    assert.deepEqual(fail.exhaustive, []);
    assert.equal(totalEdges, roomCount * 4);
  });

  it('leaves every solid edge solid in the tile grid', () => {
    assert.deepEqual(fail.solid, []);
  });

  it('cuts every mouth it claims to cut', () => {
    assert.deepEqual(fail.carved, []);
  });

  /**
   * The law is `scenery.ts`'s and it was written after the owner walked into a bog room from the
   * north and could not move: the ring one tile in from each wall (where `arrivalTile` puts an
   * entering body, spread across tiles 1 to 7) and the centre cross stay clear, which leaves the four
   * 2x2 blocks a scattered prop — and now a landmark — must fit inside.
   *
   * **Authored props are exempt and counted rather than asserted**: 26 tiles, all in Velen, where a
   * human looked at the room and put a fountain where they wanted it. `scenerySiting` is what polices
   * those, and it deliberately asks different questions.
   */
  it('never stands a derived prop or a landmark on a tile that must stay walkable', () => {
    assert.deepEqual(fail.walkable, []);
  });

  it('never overlaps a landmark with anything, and never one prop with another', () => {
    assert.deepEqual(fail.overlap, []);
  });

  /**
   * **A pre-existing gap this milestone found, measured and refused to paper over.**
   *
   * `scatterFor` places props from the room id alone and cannot see where `stairPlacement` put the
   * flights, which are also derived from the room id and also invisible in the room's JSON. So a
   * scattered bush sometimes lands on a staircase. `buildZoneTilemap` stamps scenery **last and only
   * over plain `Tile.Floor`**, so the grid quietly drops that prop — and `sceneryOf`, which the
   * client draws sprites from, still returns it. Measured: **448 tiles across 227 rooms**, 0.5% of
   * the world.
   *
   * The IR carries `sceneryOf`'s answer verbatim, deliberately: inventing a filtered second list here
   * would be exactly the parallel prop system M2 is under orders not to build, and the honest fix is
   * one line in `scatterFor` — which is forbidden this milestone, because `scatterFor`'s output is
   * shipped world state and re-rolling it would move props players have already walked round.
   *
   * So this test **pins the shape of the inheritance rather than asserting it away**: the only
   * overlap in the world is prop-on-stair, it is rare, and if it ever grows past a percent of rooms
   * somebody has changed something and should find out here.
   */
  it('pins the one overlap it inherited: scattered props on staircases', () => {
    assert.ok(
      stairPropRooms.size < roomCount / 100,
      `${stairPropRooms.size} of ${roomCount} rooms have a scattered prop on a staircase — that used to be 227`,
    );
  });

  it('carries exactly the props sceneryOf gives, in order — no parallel prop system', () => {
    assert.deepEqual(fail.props, []);
  });

  it('produces identical results iterating a room\'s features forward and backward', () => {
    assert.deepEqual(fail.order, []);
  });

  it('gives both sides of a link the same ground component and base offset', () => {
    assert.deepEqual(fail.component, []);
  });

  it('is pure: the same room, the same neighbourhood, byte-identical output', () => {
    assert.deepEqual(fail.pure, []);
  });

  /**
   * The other half of the purity contract, and the one the override layer has to live with: a room
   * two hops away is invisible, and a room one hop away is not. Sampled one room per zone rather than
   * swept, because each sample re-describes a whole zone twice; 328 samples across every zone in the
   * world is broad enough to catch a reach that should not exist.
   *
   * `ground` is excluded from the comparison and that exclusion is the documented exception, not a
   * loophole: ground components are a whole-zone derivation, so changing any room's sector can split
   * a region and move every member's base offset. `roomScene-overrides.ts` says so at length.
   */
  it('changes nothing two hops away when a room\'s sector changes', () => {
    const problems: string[] = [];
    for (const zone of zones) {
      const cells = cellIndex(zone);
      const subject = zone.rooms.find((room) =>
        CARDINALS.some((dir) => {
          const near = neighbourAt(cells, room, dir);
          return near !== undefined && CARDINALS.some((d2) => d2 !== OPPOSITE[dir] && neighbourAt(cells, near, d2) !== undefined);
        }),
      );
      if (!subject) continue;

      const twoHops = new Set<number>();
      for (const dir of CARDINALS) {
        const near = neighbourAt(cells, subject, dir);
        if (!near) continue;
        for (const d2 of CARDINALS) {
          const far = neighbourAt(cells, near, d2);
          if (far && far.id !== subject.id && !CARDINALS.some((d) => neighbourAt(cells, subject, d)?.id === far.id)) {
            twoHops.add(far.id);
          }
        }
      }
      const victim = [...twoHops].sort((a, b) => a - b)[0];
      if (victim === undefined) continue;

      const flipped: Sector = zone.rooms.find((r) => r.id === victim)!.sector === 'astral' ? 'desert' : 'astral';
      const mutated: Zone = {
        ...zone,
        rooms: zone.rooms.map((r) => (r.id === victim ? { ...r, sector: flipped } : r)),
      };
      const before = sceneFor(zone, subject.id, rooms);
      const after = sceneFor(mutated, subject.id, rooms);
      if (JSON.stringify({ ...before, ground: null }) !== JSON.stringify({ ...after, ground: null })) {
        problems.push(`zone ${zone.id}: room ${subject.id} changed when room ${victim}, two hops away, did`);
      }
    }
    assert.deepEqual(problems.slice(0, 20), []);
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function neighbourAt(cells: ReadonlyMap<string, Room>, room: Room, dir: Cardinal): Room | undefined {
  const delta = DIRECTION_DELTA[dir];
  return cells.get(cellKey(room.pos.x + delta[0], room.pos.y + delta[1], room.pos.z));
}

function sceneFor(zone: Zone, id: number, rooms: ReadonlyMap<number, Room>): RoomScene {
  const context = sceneZone(zone);
  const cells = cellIndex(zone);
  const room = zone.rooms.find((r) => r.id === id)!;
  return describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
}

/**
 * The gap cells across one side of a room block: the whole shared edge, `gap` tiles deep.
 *
 * Wider than any single carve on purpose — a solid edge has to be solid across the *whole* boundary,
 * not just where a corridor would have been. The strips of two different boundaries never overlap
 * (the corner cells belong to neither), so a walkable tile found here was carved by this boundary.
 */
function gapStrip(
  origin: { readonly tx: number; readonly ty: number },
  dir: Cardinal,
  gap: number,
): { tx: number; ty: number }[] {
  const delta = DIRECTION_DELTA[dir];
  const cells: { tx: number; ty: number }[] = [];
  for (let step = 0; step < gap; step++) {
    for (let across = 0; across < ROOM_TILES; across++) {
      cells.push(
        delta[0] !== 0
          ? { tx: delta[0] > 0 ? origin.tx + ROOM_TILES + step : origin.tx - 1 - step, ty: origin.ty + across }
          : { tx: origin.tx + across, ty: delta[1] > 0 ? origin.ty + ROOM_TILES + step : origin.ty - 1 - step },
      );
    }
  }
  return cells;
}

/** The `span` cells at the centre of that strip — `connectorCells`' own geometry, re-derived here. */
function mouthStrip(
  origin: { readonly tx: number; readonly ty: number },
  dir: Cardinal,
  gap: number,
  span: number,
): { tx: number; ty: number }[] {
  const offset = (ROOM_TILES - span) / 2;
  return gapStrip(origin, dir, gap).filter((_, index) => {
    const across = index % ROOM_TILES;
    return across >= offset && across < offset + span;
  });
}
