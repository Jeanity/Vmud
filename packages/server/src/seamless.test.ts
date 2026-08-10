/**
 * **The open world is still the MUD's world** — V8b's whole safety story, run against the real
 * shipped city rather than a fixture.
 *
 * `DESIGN-open-world.md` §2 states the rule and names the test: *"flood-fill the rendered tilemap
 * and assert its reachability equals the graph's connectivity, both directions. A blocker line
 * with a one-tile hole is a wall-walk exploit; an over-eager blocker is a broken zone. Neither
 * survives a test that compares the two truths."* `tilemap.test.ts` holds that shape against
 * hand-built fixtures; this holds it against **Velen as authored**, which is the version a player
 * actually walks and the one a careless edit will break.
 *
 * It lives in the server package because that is where `GameWorld` composes the world — overlays,
 * renames, locks and all. A test against the raw zone file would be testing the file; this tests
 * what the server serves.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { ROOM_TILES, buildZoneTilemap, isWalkable, roomCentre, tileAt, type Zone } from '@mygame/shared';

import { WORLD_DIR, loadZone } from './world.ts';
import { applyZoneOverride, loadZoneOverrides } from './zone-overrides.ts';

const VELEN = 100001;
const built = existsSync(`${WORLD_DIR}/zones/${VELEN}.json`);

/** Which rooms the *tiles* can reach from one room, walking the grid four ways. */
function roomsReachableByTile(zone: Zone, level: number, from: number): Set<number> {
  const grid = buildZoneTilemap(zone, level);
  const origin = grid.roomOrigins.get(from);
  assert.ok(origin, `room ${from} has no origin on level ${level}`);
  const start = roomCentre(origin);
  const seen = new Set<number>([start.ty * grid.width + start.tx]);
  const queue = [start];
  while (queue.length > 0) {
    const { tx, ty } = queue.pop()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = tx + dx;
      const ny = ty + dy;
      const index = ny * grid.width + nx;
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height || seen.has(index)) continue;
      if (!isWalkable(tileAt(grid, nx, ny))) continue;
      seen.add(index);
      queue.push({ tx: nx, ty: ny });
    }
  }
  const rooms = new Set<number>();
  for (const index of seen) {
    const room = grid.rooms[index] ?? -1;
    if (room !== -1) rooms.add(room);
  }
  return rooms;
}

/**
 * Which rooms the *graph* can reach from one room, on this level, ignoring portals and stairs.
 *
 * **Undirected, and that is the engine's own rule rather than a convenience.** Ground between two
 * rooms is walkable from both ends the moment either room declares the exit: the classic projection
 * has always carved its corridor per-room-per-exit, and the seamless one opens a seam if either
 * side names it. So a one-way exit has never been enforced by geometry — `stepRoom` enforces it on
 * the typed command, which is a different layer.
 *
 * Found by this very test, which first ran directed and reported two Stump Bog rooms as wall-walk
 * exploits. They were nothing of the kind: *Atop an Enormous Stump* is reached by going **up** from
 * the four rooms around its base, while its own exits run horizontally back down to them, so the
 * only inbound edge is vertical and a directed walk can never arrive. The tiles were right and the
 * model was wrong.
 */
function roomsReachableByGraph(zone: Zone, level: number, from: number): Set<number> {
  const here = new Map(zone.rooms.filter((r) => r.pos.z === level).map((r) => [r.id, r]));
  const neighbours = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const room of here.values()) {
    for (const [dir, exit] of Object.entries(room.exits)) {
      // Portals and vertical links are transitions rather than geometry — they carve no tiles, so
      // the tile walk cannot follow them and neither may this side of the comparison.
      if (!exit || exit.portal || dir === 'up' || dir === 'down') continue;
      // A shut door stops both truths; an open one stops neither.
      if (exit.door?.closed) continue;
      if (!here.has(exit.to)) continue;
      link(room.id, exit.to);
      link(exit.to, room.id);
    }
  }
  const seen = new Set<number>([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const next of neighbours.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

describe('the seamless world is still the room graph — V8b, against the shipped city', () => {
  if (!built) {
    it('skipped: no built world on this checkout', () => {
      // `data/world/` is git-ignored and reproducible; a fresh clone has no zones until worldgen
      // runs. Skipping loudly beats failing on an absence that is expected.
      assert.ok(true);
    });
    return;
  }

  const zone = loadZone(VELEN);
  const levels = [...new Set(zone.rooms.map((r) => r.pos.z))].sort((a, b) => a - b);

  it('renders Velen seamless in the first place', () => {
    assert.equal(zone.seamless, true, 'the city declares itself seamless');
    assert.ok(levels.length >= 2, 'and spans levels — streets, and at least one of under or over');
  });

  for (const level of levels) {
    it(`flood-fill equals the graph on level ${level}`, () => {
      const rooms = zone.rooms.filter((r) => r.pos.z === level);
      assert.ok(rooms.length > 0);
      const from = rooms[0]!.id;
      const byTile = roomsReachableByTile(zone, level, from);
      const byGraph = roomsReachableByGraph(zone, level, from);
      const tileOnly = [...byTile].filter((r) => !byGraph.has(r));
      const graphOnly = [...byGraph].filter((r) => !byTile.has(r));
      // Named separately because they are different bugs: a room the *tiles* reach and the graph
      // does not is a wall-walk exploit; one the graph reaches and the tiles do not is a room a
      // player can never get to.
      assert.deepEqual(tileOnly, [], `walkable without an exit (wall-walk): ${tileOnly.join(', ')}`);
      assert.deepEqual(graphOnly, [], `has an exit but no way through (sealed): ${graphOnly.join(', ')}`);
    });
  }

  it('every blocked border is solid, and there are some — or the test proves nothing', () => {
    let blockers = 0;
    for (const level of levels) {
      const grid = buildZoneTilemap(zone, level);
      for (let index = 0; index < grid.tiles.length; index++) {
        const tile = grid.tiles[index]!;
        if (tile === 7 /* Tile.Blocker */) {
          blockers += 1;
          assert.equal(isWalkable(tile), false, 'a blocker that let anybody through');
        }
      }
    }
    assert.ok(blockers > 0, 'the city has at least one border with no door in it');
  });

  it('the streets are one connected ground — no district is an island', () => {
    const streets = zone.rooms.filter((r) => r.pos.z === 0);
    const reached = roomsReachableByTile(zone, 0, streets[0]!.id);
    const missed = streets.filter((r) => !reached.has(r.id)).map((r) => `${r.id} ${r.name}`);
    assert.deepEqual(missed, [], `unreachable on foot from the first street room: ${missed.join(' | ')}`);
    assert.ok(streets.length >= 20, `and there is a real city here: ${streets.length} street rooms`);
  });

  it('every zone that declares itself seamless obeys the same law — V8c', () => {
    // Velen is authored and small; the wilderness is harvested, large, and laid out by a mapper
    // who never imagined a tile grid. If the rule holds there it holds anywhere, so every seamless
    // zone in the config is walked, on every level, rather than only the one we wrote.
    const overrides = loadZoneOverrides();
    const seamless = [...overrides.entries()].filter(([, o]) => o.seamless === true).map(([id]) => id);
    assert.ok(seamless.length > 0, 'the overlay declares at least one seamless zone');
    for (const id of seamless) {
      if (!existsSync(`${WORLD_DIR}/zones/${id}.json`)) continue;
      // `loadZone` reads the file; the overlay is composed by `GameWorld.load`. A test that skipped
      // the composition would be testing the harvest rather than the world the server serves, so
      // it runs the same function the loader runs.
      const wild = loadZone(id);
      applyZoneOverride(wild as unknown as { name: string; id: typeof id; seamless?: boolean }, overrides);
      assert.equal(wild.seamless, true, `zone ${id} took the overlay's seamless flag`);
      for (const level of new Set(wild.rooms.map((r) => r.pos.z))) {
        const rooms = wild.rooms.filter((r) => r.pos.z === level);
        const from = rooms[0]!.id;
        const byTile = roomsReachableByTile(wild, level, from);
        const byGraph = roomsReachableByGraph(wild, level, from);
        const tileOnly = [...byTile].filter((r) => !byGraph.has(r));
        const graphOnly = [...byGraph].filter((r) => !byTile.has(r));
        assert.deepEqual(tileOnly, [], `zone ${id} level ${level}: wall-walk into ${tileOnly.join(', ')}`);
        assert.deepEqual(graphOnly, [], `zone ${id} level ${level}: sealed off ${graphOnly.join(', ')}`);
      }
    }
  });

  it('no zone with dark rooms was made seamless — the light radius depends on the gap', () => {
    // The rule that chose the six: `ROOM_GAP` is tuned so the next room sits outside the starting
    // light radius and inside a torch's. A seam of one tile puts it within reach of anything, so a
    // zone with real darkness in it would quietly lose the mechanic that makes a torch an upgrade.
    for (const [id, override] of loadZoneOverrides()) {
      if (override.seamless !== true) continue;
      if (!existsSync(`${WORLD_DIR}/zones/${id}.json`)) continue;
      const dark = loadZone(id).rooms.filter((r) => r.flags?.includes('dark'));
      assert.deepEqual(dark.map((r) => r.id), [], `zone ${id} is seamless but has dark rooms`);
    }
  });

  it('a room block is nine tiles square, so the seam maths never drifted', () => {
    const grid = buildZoneTilemap(zone, 0);
    assert.equal(grid.gap, 1, 'a seamless zone lays its blocks one tile apart');
    const origins = [...grid.roomOrigins.values()];
    assert.ok(origins.length > 1);
    const strides = new Set<number>();
    for (const a of origins) for (const b of origins) {
      if (a.ty === b.ty && b.tx > a.tx) strides.add(b.tx - a.tx);
    }
    for (const stride of strides) {
      assert.equal(stride % (ROOM_TILES + 1), 0, `a stride of ${stride} is not a whole number of blocks`);
    }
  });
});
