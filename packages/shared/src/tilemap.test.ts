import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  arrivalTile,
  CONNECTOR_WIDTH,
  PLAYER_SPEED,
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  buildZoneTilemap,
  doorwayTiles,
  isWalkable,
  normaliseIntent,
  roomAtTile,
  roomCentre,
  STAIR_TILES,
  setDoorTiles,
  stairPlacement,
  stepMovement,
  tileAt,
  type StairOffset,
} from './tilemap.ts';
import { boundsOf, type Door, type Room, type Zone } from './world.ts';

/**
 * A synthetic zone builder. Beyond making these tests readable, it exercises the project rule that
 * the engine must run with no third-party world data present.
 */
function makeZone(rooms: readonly Partial<Room>[]): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: 1,
    name: r.name ?? `Room ${i + 1}`,
    // `inside` on purpose: these tests are about block geometry, and a sector the scatter table
    // knows about would grow props into the middle of every assertion about bare floor.
    sector: r.sector ?? 'inside',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
  })) as Room[];
  return { id: 1, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

describe('buildZoneTilemap', () => {
  it('sizes the grid from the bounds of the rooms on the level', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 } },
      { id: 2, pos: { x: 2, y: 1, z: 0 } },
    ]);
    const grid = buildZoneTilemap(zone);
    assert.equal(grid.width, 3 * ROOM_STRIDE);
    assert.equal(grid.height, 2 * ROOM_STRIDE);
  });

  it('sizes a sparse level to its own rooms, not to the union across levels', () => {
    // Zone 260's shape in miniature: a two-room ground level tucked in one corner of a wide upper
    // level. Sizing the ground level from `zone.bounds` gave it the whole 4x4 span — on the real
    // data a 156x180 grid for four rooms, which is a render texture past GL_MAX_TEXTURE_SIZE and a
    // zoom-to-fit centred on empty space.
    const zone = makeZone([
      { id: 1, pos: { x: 3, y: 3, z: 0 } },
      { id: 2, pos: { x: 3, y: 2, z: 0 } },
      { id: 3, pos: { x: 0, y: 0, z: 1 } },
      { id: 4, pos: { x: 3, y: 3, z: 1 } },
    ]);
    assert.equal(zone.bounds.maxX - zone.bounds.minX + 1, 4, 'fixture should span 4 cells overall');

    const ground = buildZoneTilemap(zone, 0);
    assert.equal(ground.width, 1 * ROOM_STRIDE, 'ground level spans one column');
    assert.equal(ground.height, 2 * ROOM_STRIDE, 'ground level spans two rows');

    // Origins are relative to the level's own minimum, so the rooms sit on the grid rather than
    // off the end of it.
    assert.deepEqual(ground.roomOrigins.get(2), { tx: 0, ty: 0 });
    for (const [id] of ground.roomOrigins) {
      const centre = roomCentre(ground.roomOrigins.get(id)!);
      assert.ok(centre.tx < ground.width && centre.ty < ground.height, `room ${id} is off-grid`);
      assert.equal(roomAtTile(ground, centre.tx, centre.ty), id);
    }

    // The upper level still gets the full span, and is a different Place with its own coordinates.
    const upper = buildZoneTilemap(zone, 1);
    assert.equal(upper.width, 4 * ROOM_STRIDE);
    assert.equal(upper.height, 4 * ROOM_STRIDE);
  });

  it('fills each room with a solid block of floor', () => {
    const grid = buildZoneTilemap(makeZone([{ id: 7, pos: { x: 0, y: 0, z: 0 } }]));
    const origin = grid.roomOrigins.get(7);
    assert.ok(origin);
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        assert.equal(tileAt(grid, origin.tx + dx, origin.ty + dy), Tile.Floor);
        assert.equal(roomAtTile(grid, origin.tx + dx, origin.ty + dy), 7);
      }
    }
  });

  it('leaves unlinked neighbours separated by void', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 } },
      { id: 2, pos: { x: 1, y: 0, z: 0 } },
    ]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    for (let step = 0; step < ROOM_GAP; step++) {
      assert.equal(tileAt(grid, origin.tx + ROOM_TILES + step, midY), Tile.Void);
    }
  });

  it('carves a walkable connector between linked neighbours', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;

    for (let step = 0; step < ROOM_GAP; step++) {
      const tile = tileAt(grid, origin.tx + ROOM_TILES + step, midY);
      assert.equal(tile, Tile.Connector);
      assert.ok(isWalkable(tile));
    }

    // The corridor is exactly CONNECTOR_WIDTH tiles tall — no wider.
    const above = midY - (CONNECTOR_WIDTH - 1) / 2 - 1;
    assert.equal(tileAt(grid, origin.tx + ROOM_TILES, above), Tile.Void);
  });

  it('produces an unbroken walkable path between two linked rooms', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const grid = buildZoneTilemap(zone);
    const a = roomCentre(grid.roomOrigins.get(1)!);
    const b = roomCentre(grid.roomOrigins.get(2)!);
    assert.equal(a.ty, b.ty, 'east-west neighbours should share a row');
    for (let tx = a.tx; tx <= b.tx; tx++) {
      assert.ok(isWalkable(tileAt(grid, tx, a.ty)), `blocked at tx=${tx}`);
    }
  });

  it('marks door exits distinctly from open connectors', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door: { name: 'a gate', closed: true, locked: false } } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 } },
    ]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    assert.equal(tileAt(grid, origin.tx + ROOM_TILES, midY), Tile.Door);
  });

  it('carves a door that stands open as a walkable doorway, not as a wall', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door: door({ closed: false }) } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, door: door({ closed: false }) } } },
    ]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const tile = tileAt(grid, origin.tx + ROOM_TILES, midY);
    assert.equal(tile, Tile.DoorOpen);
    assert.ok(isWalkable(tile), 'an open doorway is walkable');
  });

  it('lets a shut door win over a plain exit facing it back', () => {
    // Both sides carve the same cells, so without a precedence rule the answer is whichever room the
    // zone data happened to list second. 5 exits in the shipped world are exactly this shape: a door
    // on one side, a plain exit on the other. A doorway that is a wall from one room and an open
    // corridor from the other is not a thing the simulation can hold two consistent opinions about.
    const forward = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door: door({}) } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const reversed = makeZone([
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door: door({}) } } },
    ]);

    for (const [label, zone] of [['door listed first', forward], ['door listed second', reversed]] as const) {
      const grid = buildZoneTilemap(zone);
      const origin = grid.roomOrigins.get(1)!;
      const midY = origin.ty + (ROOM_TILES - 1) / 2;
      assert.equal(tileAt(grid, origin.tx + ROOM_TILES, midY), Tile.Door, label);
    }
  });

  it('does not carve corridors for portals', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, portal: true } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 } },
    ]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    assert.equal(tileAt(grid, origin.tx + ROOM_TILES, midY), Tile.Void);
  });

  it('places a stair block for a vertical link instead of a corridor', () => {
    const zone = makeZone([{ id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { down: { to: 99 } } }]);
    const grid = buildZoneTilemap(zone);
    const origin = grid.roomOrigins.get(1)!;

    // A vertical exit carves no gap — the far side is a different Place — so nothing outside the
    // room block should have changed.
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    assert.equal(tileAt(grid, origin.tx + ROOM_TILES, midY), Tile.Void);

    const stairs = countTiles(grid, Tile.StairsDown);
    assert.equal(stairs, STAIR_TILES * STAIR_TILES, 'a 3x3 block, not one marker tile');
  });

  it('only includes rooms on the requested level', () => {
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 } },
      { id: 2, pos: { x: 0, y: 0, z: 1 } },
    ]);
    const ground = buildZoneTilemap(zone, 0);
    const upper = buildZoneTilemap(zone, 1);
    assert.ok(ground.roomOrigins.has(1));
    assert.ok(!ground.roomOrigins.has(2));
    assert.ok(upper.roomOrigins.has(2));
    assert.ok(!upper.roomOrigins.has(1));
  });

  it('treats out-of-bounds as void rather than throwing', () => {
    const grid = buildZoneTilemap(makeZone([{ id: 1 }]));
    assert.equal(tileAt(grid, -1, 0), Tile.Void);
    assert.equal(tileAt(grid, 9999, 0), Tile.Void);
    assert.equal(roomAtTile(grid, -1, 0), -1);
  });
});

/**
 * The bug this suite exists for.
 *
 * `isWalkable` was `tile !== Void`, so `Tile.Door` was walkable and a door's state reached the grid
 * only at build time. `stepRoom` refused a locked door and WASD, the drag joystick and click-to-move
 * all walked through the same doorway, because every one of them resolves against `isWalkable` and
 * nothing else.
 */
describe('doors as geometry', () => {
  it('refuses a shut door and admits an open one', () => {
    assert.equal(isWalkable(Tile.Door), false, 'a shut door is a wall');
    assert.equal(isWalkable(Tile.DoorOpen), true);
    assert.equal(isWalkable(Tile.Connector), true);
    assert.equal(isWalkable(Tile.Floor), true);
    assert.equal(isWalkable(Tile.Void), false);
  });

  it('stops free steering at a shut door, and lets it through once open', () => {
    const grid = buildZoneTilemap(gatedPair(true));
    const origin = grid.roomOrigins.get(1)!;
    const from = roomCentre(origin);
    const to = roomCentre(grid.roomOrigins.get(2)!);

    const stopped = walkEast(grid, from, to);
    assert.ok(stopped.tx < to.tx, `steering crossed a shut door and reached tile ${stopped.tx}`);
    // At the door, not short of it. `PLAYER_RADIUS` is under half a tile, so the collision box fits
    // inside the last floor column with the door tile still clear — the character walks right up to
    // it and stops, which is what makes the barrier read as a door rather than as an invisible wall
    // somewhere in the room.
    assert.equal(stopped.tx, origin.tx + ROOM_TILES - 1, 'stopped at the last floor column');
    assert.equal(roomAtTile(grid, stopped.tx, stopped.ty), 1, 'still in the room it started in');

    setDoorTiles(grid, 1, 'east', false);
    const through = walkEast(grid, from, to);
    assert.equal(through.tx, to.tx, 'an opened door lets the same walk through');
  });

  it('flips only the doorway, and says which tiles changed', () => {
    const grid = buildZoneTilemap(gatedPair(true));
    const before = grid.tiles.slice();

    const opened = setDoorTiles(grid, 1, 'east', false);
    assert.equal(opened.length, ROOM_GAP * CONNECTOR_WIDTH, 'the whole carved strip, and no more');
    assert.deepEqual(
      [...opened].sort((a, b) => a - b),
      [...doorwayTiles(grid, 1, 'east')].sort((a, b) => a - b),
    );
    for (const index of opened) assert.equal(grid.tiles[index], Tile.DoorOpen);

    // Everything else is untouched — no floor overwritten, no void carved into.
    for (let i = 0; i < before.length; i++) {
      if (opened.includes(i)) continue;
      assert.equal(grid.tiles[i], before[i], `tile ${i} changed and should not have`);
    }
  });

  it('is idempotent, and free when nothing moves', () => {
    const grid = buildZoneTilemap(gatedPair(true));
    assert.equal(setDoorTiles(grid, 1, 'east', true).length, 0, 'already shut');
    assert.equal(setDoorTiles(grid, 1, 'east', false).length, ROOM_GAP * CONNECTOR_WIDTH);
    assert.equal(setDoorTiles(grid, 1, 'east', false).length, 0, 'already open');
  });

  it('names the same tiles from either side of a two-way door', () => {
    // The two rooms carve one shared strip, so opening from either end has to move the same cells —
    // otherwise a door opened from the west is still shut when approached from the east.
    const grid = buildZoneTilemap(gatedPair(true));
    const fromWest = [...doorwayTiles(grid, 1, 'east')].sort((a, b) => a - b);
    const fromEast = [...doorwayTiles(grid, 2, 'west')].sort((a, b) => a - b);
    assert.deepEqual(fromWest, fromEast);
  });

  it('will not carve a passage through ground that is not already a doorway', () => {
    // The guard that makes `setDoorTiles` safe to call with anything: it rewrites door tiles only, so
    // no argument, however wrong, can open a hole in a wall or overwrite a room's floor.
    const zone = makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);
    const grid = buildZoneTilemap(zone);
    const before = grid.tiles.slice();

    assert.deepEqual(setDoorTiles(grid, 1, 'east', true), [], 'a plain connector is not a door');
    assert.deepEqual(setDoorTiles(grid, 1, 'north', true), [], 'no exit at all');
    assert.deepEqual(setDoorTiles(grid, 1, 'up', true), [], 'a vertical link carves no strip');
    assert.deepEqual(setDoorTiles(grid, 999, 'east', true), [], 'a room not on this grid');
    assert.deepEqual([...grid.tiles], [...before]);
  });
});

/**
 * Stairs.
 *
 * Vertical travel is the one movement the map cannot draw as a corridor, so the block is the only
 * signal a room has stairs at all. The placement varies per room for looks — but it has to be varied
 * *deterministically*, because the client and the server each build their own grid and a block one
 * tile apart on the two sides is terrain one of them will not let you stand on.
 */
describe('stairs', () => {
  function stairZone(id: number, exits: Room['exits']): Zone {
    return makeZone([{ id, pos: { x: 0, y: 0, z: 0 }, exits }]);
  }

  /** Every tile of `kind`, as offsets inside the room block. */
  function blockOf(grid: ReturnType<typeof buildZoneTilemap>, roomId: number, kind: number): StairOffset[] {
    const origin = grid.roomOrigins.get(roomId)!;
    const found: StairOffset[] = [];
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        if (tileAt(grid, origin.tx + dx, origin.ty + dy) === kind) found.push({ dx, dy });
      }
    }
    return found;
  }

  it('stamps a solid 3x3 block, wholly inside the room', () => {
    const grid = buildZoneTilemap(stairZone(7, { up: { to: 99 } }));
    const block = blockOf(grid, 7, Tile.StairsUp);
    assert.equal(block.length, STAIR_TILES * STAIR_TILES);

    // Contiguous, and inside the floor — never spilling into the gap where a corridor would go.
    const xs = block.map((b) => b.dx);
    const ys = block.map((b) => b.dy);
    assert.equal(Math.max(...xs) - Math.min(...xs), STAIR_TILES - 1);
    assert.equal(Math.max(...ys) - Math.min(...ys), STAIR_TILES - 1);
    assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) < ROOM_TILES);
    assert.ok(Math.min(...ys) >= 0 && Math.max(...ys) < ROOM_TILES);
  });

  it('is walkable, so a stair block can never seal a room', () => {
    const grid = buildZoneTilemap(stairZone(7, { up: { to: 99 } }));
    for (const { dx, dy } of blockOf(grid, 7, Tile.StairsUp)) {
      const origin = grid.roomOrigins.get(7)!;
      assert.ok(isWalkable(tileAt(grid, origin.tx + dx, origin.ty + dy)));
    }
  });

  it('draws up and down as different tiles', () => {
    // The other half of the discoverability problem: one grey marker for both meant you could not
    // tell which way a flight went without reading the exit list.
    const grid = buildZoneTilemap(stairZone(7, { up: { to: 98 }, down: { to: 99 } }));
    assert.equal(blockOf(grid, 7, Tile.StairsUp).length, STAIR_TILES * STAIR_TILES);
    assert.equal(blockOf(grid, 7, Tile.StairsDown).length, STAIR_TILES * STAIR_TILES);
  });

  it('never lets an up and a down block overlap', () => {
    // Two flights sharing a tile would render as whichever was written second, and one of them would
    // simply be invisible. Checked across many room ids because the placement is a hash.
    for (let id = 1; id <= 400; id++) {
      const grid = buildZoneTilemap(stairZone(id, { up: { to: 98 }, down: { to: 99 } }));
      const up = blockOf(grid, id, Tile.StairsUp);
      const down = blockOf(grid, id, Tile.StairsDown);
      assert.equal(up.length, STAIR_TILES * STAIR_TILES, `room ${id} lost part of its up block`);
      assert.equal(down.length, STAIR_TILES * STAIR_TILES, `room ${id} lost part of its down block`);
    }
  });

  it('is deterministic — the same room always places identically', () => {
    // The whole reason this is a hash and not `Math.random()`: both sides build their own grid.
    for (const id of [1, 42, 77484, 5750]) {
      const a = stairPlacement(id, true, true);
      const b = stairPlacement(id, true, true);
      assert.deepEqual(a, b, `room ${id} placed differently on a second build`);
    }
  });

  it('actually varies between rooms, rather than being uniform in practice', () => {
    // A hash that spread badly would pass every test above and still put every staircase in the same
    // corner, which is the thing this feature exists to avoid.
    const seen = new Set<string>();
    for (let id = 1; id <= 200; id++) {
      const { up } = stairPlacement(id, true, false);
      seen.add(`${up!.dx},${up!.dy}`);
    }
    assert.ok(seen.size > 20, `only ${seen.size} distinct positions across 200 rooms`);
  });

  it('places nothing at all for a room with no vertical exit', () => {
    const grid = buildZoneTilemap(stairZone(7, { east: { to: 99 } }));
    assert.equal(blockOf(grid, 7, Tile.StairsUp).length, 0);
    assert.equal(blockOf(grid, 7, Tile.StairsDown).length, 0);
    assert.deepEqual(stairPlacement(7, false, false), {});
  });

  it('leaves the room centre floor most of the time, since that is where you land', () => {
    // `relocate` puts an arriving character on `roomCentre`. Stairs used to be exactly there, so you
    // always landed on them; now that is the uncommon case rather than the invariable one.
    let onCentre = 0;
    const centre = (ROOM_TILES - 1) / 2;
    for (let id = 1; id <= 200; id++) {
      const { up } = stairPlacement(id, true, false);
      const covers = centre >= up!.dx && centre < up!.dx + STAIR_TILES
        && centre >= up!.dy && centre < up!.dy + STAIR_TILES;
      if (covers) onCentre++;
    }
    assert.ok(onCentre < 100, `stairs covered the landing tile in ${onCentre} of 200 rooms`);
  });
});

/** How many tiles of one kind the whole grid holds. */
function countTiles(grid: ReturnType<typeof buildZoneTilemap>, kind: number): number {
  let n = 0;
  for (const t of grid.tiles) if (t === kind) n++;
  return n;
}

/** A door, shut and unlocked unless told otherwise. */
function door(overrides: Partial<Door>): Door {
  return { name: 'an iron gate', closed: true, locked: false, ...overrides };
}

/** Two rooms side by side, joined by a door both of them declare. */
function gatedPair(closed: boolean): Zone {
  return makeZone([
    { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door: door({ closed }) } } },
    { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, door: door({ closed }) } } },
  ]);
}

/**
 * Walks due east with `stepMovement` until it stops making progress, and reports where it ended.
 *
 * The same routine the server ticks and the client predicts with — the point of the test is that
 * this is not a special door-aware movement path, it is the ordinary one meeting a wall.
 */
function walkEast(
  grid: ReturnType<typeof buildZoneTilemap>,
  from: { tx: number; ty: number },
  to: { tx: number; ty: number },
): { tx: number; ty: number } {
  let x = from.tx * TILE_SIZE + TILE_SIZE / 2;
  let y = from.ty * TILE_SIZE + TILE_SIZE / 2;
  const goal = to.tx * TILE_SIZE + TILE_SIZE / 2;
  // One tick's worth per step, generously bounded: 400 ticks is 40 s of walking against a two-room map.
  for (let tick = 0; tick < 400 && x < goal; tick++) {
    const next = stepMovement(grid, x, y, 1, 0, PLAYER_SPEED * 0.1);
    if (next.x === x && next.y === y) break;
    x = next.x;
    y = next.y;
  }
  return { tx: Math.floor(x / TILE_SIZE), ty: Math.floor(y / TILE_SIZE) };
}

describe('normaliseIntent', () => {
  it('normalises a real push and reads a small one as a release', () => {
    const east = normaliseIntent(5, 0);
    assert.equal(east.x, 1);
    assert.equal(east.y, 0);

    const diagonal = normaliseIntent(3, 3);
    assert.ok(Math.abs(Math.hypot(diagonal.x, diagonal.y) - 1) < 1e-12, 'no free speed on a diagonal');

    assert.deepEqual(normaliseIntent(0, 0), { x: 0, y: 0 });
    assert.deepEqual(normaliseIntent(0.001, 0), { x: 0, y: 0 });
  });

  it('reads a non-finite vector as a release rather than passing NaN downstream', () => {
    // Steering comes straight off the wire, so `{t:'steer'}` with the fields missing arrives here as
    // `undefined`, and a client is free to send a string or 1e400. The magnitude test alone does not
    // catch any of them: `NaN < 0.01` is false, and `Infinity` only becomes `NaN` at the division.
    //
    // What a leaked NaN costs is out of all proportion to the typo that causes it. `NaN !== 0` reads
    // as a real push, so it cancels any active route; the simulation's idle skip (`!path && intentX
    // === 0`) then never fires again, so that character is walked every tick for the rest of the
    // session while `stepMovement` refuses to move them a pixel. A release is the only safe reading.
    const cases: readonly (readonly [unknown, unknown])[] = [
      [Number.NaN, Number.NaN],
      [Number.NaN, 0],
      [0, Number.NaN],
      [undefined, undefined],
      ['east', 'north'],
      [Number.POSITIVE_INFINITY, 0],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY],
    ];
    for (const [dx, dy] of cases) {
      const intent = normaliseIntent(dx as number, dy as number);
      assert.deepEqual(intent, { x: 0, y: 0 }, `normaliseIntent(${String(dx)}, ${String(dy)})`);
    }
  });
});

describe('where you land when you enter a room', () => {
  // Owner's report (2026-08-03): every arrival used the room centre, so bodies stacked on one tile and
  // whoever was underneath could not be clicked — "they can hide behind someone else".
  const origin = { tx: 0, ty: 0 };

  it('puts you at the wall you came through, not in the middle', () => {
    // Walk north and you arrive at the *southern* edge, having just stepped through it.
    assert.equal(arrivalTile(origin, 'north', 0).ty, ROOM_TILES - 2);
    assert.equal(arrivalTile(origin, 'south', 0).ty, 1);
    assert.equal(arrivalTile(origin, 'east', 0).tx, 1);
    assert.equal(arrivalTile(origin, 'west', 0).tx, ROOM_TILES - 2);
  });

  it('keeps the centre when nothing was walked through', () => {
    // A teleport, a respawn, a portal, a staircase: there is no wall, so the centre is the honest answer.
    assert.deepEqual(arrivalTile(origin, undefined, 7), roomCentre(origin));
  });

  it('spreads two bodies arriving the same way onto different tiles', () => {
    // The whole point. Derived from the caller's id rather than rolled, because `CLAUDE.md` rule 3
    // forbids unseeded randomness in simulation and no `Rng` reaches `relocate`.
    const a = arrivalTile(origin, 'north', 3);
    const b = arrivalTile(origin, 'north', 4);
    assert.notDeepEqual(a, b);
    assert.equal(a.ty, b.ty, 'both still at the wall they came through');
  });

  it('never lands on the room’s boundary tiles', () => {
    // One tile in from the wall on every axis, so the collision box starts clear of it.
    for (const dir of ['north', 'east', 'south', 'west'] as const) {
      for (let id = 0; id < 40; id++) {
        const at = arrivalTile(origin, dir, id);
        assert.ok(at.tx >= 1 && at.tx <= ROOM_TILES - 2, `${dir}/${id} tx ${at.tx}`);
        assert.ok(at.ty >= 1 && at.ty <= ROOM_TILES - 2, `${dir}/${id} ty ${at.ty}`);
      }
    }
  });

  it('is stable for a negative spread, because ids are not promised to be positive', () => {
    const at = arrivalTile(origin, 'north', -5);
    assert.ok(at.tx >= 1 && at.tx <= ROOM_TILES - 2);
  });

  it('offsets from the room’s own origin, not from zero', () => {
    const far = arrivalTile({ tx: 90, ty: 45 }, 'south', 0);
    assert.equal(far.ty, 46, 'one tile in from that room’s northern edge');
    assert.ok(far.tx >= 91);
  });
});

/**
 * V8a — the seamless projection. The suite that matters most here is the last one: the flood-fill
 * validator is DESIGN-open-world.md §2's whole safety story, the proof that the open-looking world
 * is still exactly the room graph's world.
 */
describe('buildZoneTilemap, seamless', () => {
  const seamlessZone = (rooms: readonly Partial<Room>[]): Zone => ({
    ...makeZone(rooms),
    seamless: true,
  });

  /** A courtyard pair: two city rooms side by side, linked both ways. */
  const pair = (): Zone =>
    seamlessZone([
      { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
      { id: 2, sector: 'city', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
    ]);

  it('lays blocks on the seam stride, not the corridor stride', () => {
    const grid = buildZoneTilemap(pair());
    assert.equal(grid.width, 2 * (ROOM_TILES + 1));
    assert.equal(grid.gap, 1);
    assert.equal(grid.roomOrigins.get(2)!.tx, ROOM_TILES + 1);
  });

  it('fills the whole shared edge of an open exit with walkable floor', () => {
    const grid = buildZoneTilemap(pair());
    const seamX = ROOM_TILES;
    for (let ty = 0; ty < ROOM_TILES; ty++) {
      assert.equal(tileAt(grid, seamX, ty), Tile.Floor, `seam tile at ty=${ty} is plaza floor`);
    }
  });

  it('fills the whole seam with a blocker between adjacent rooms with no exit', () => {
    // V8b changed what a blocked seam *is* without changing what it does: V8a left it `Void`,
    // which is solid and looks like nothing. It is now `Blocker` — still solid, still opaque, and
    // drawn by the client as the wall or tree line the two sectors call for. The assertion that
    // matters is the law, so it is made twice: the kind, and `isWalkable` regardless of kind.
    const grid = buildZoneTilemap(
      seamlessZone([
        { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 } },
        { id: 2, sector: 'city', pos: { x: 1, y: 0, z: 0 } },
      ]),
    );
    const seamX = ROOM_TILES;
    for (let ty = 0; ty < ROOM_TILES; ty++) {
      const tile = tileAt(grid, seamX, ty);
      assert.equal(tile, Tile.Blocker, `blocked seam at ty=${ty} is dressed`);
      assert.equal(isWalkable(tile), false, `blocked seam at ty=${ty} refuses passage`);
    }
  });

  it('narrows a door exit to a gate in a wall, on the cells the runtime derives', () => {
    const door: Door = { name: 'a stout door', closed: true, locked: false };
    const grid = buildZoneTilemap(
      seamlessZone([
        { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door } } },
        { id: 2, sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, door } } },
      ]),
    );
    const seamX = ROOM_TILES;
    const doorCells = [];
    for (let ty = 0; ty < ROOM_TILES; ty++) {
      const tile = tileAt(grid, seamX, ty);
      if (tile === Tile.Door) doorCells.push(ty);
      // V8b: the wall beside a gate is a *drawn* wall now, not the void V8a left. Solid either
      // way — the assertion that matters is that nobody walks through it.
      else {
        assert.equal(tile, Tile.Blocker, `wall beside the gate at ty=${ty}`);
        assert.equal(isWalkable(tile), false, `wall beside the gate at ty=${ty} is solid`);
      }
    }
    assert.equal(doorCells.length, CONNECTOR_WIDTH, 'the gate is exactly connector-wide');
    // Both rooms derive the same cells — the open/shut invariant.
    const fromWest = doorwayTiles(grid, 1, 'east');
    const fromEast = doorwayTiles(grid, 2, 'west');
    assert.deepEqual(fromWest, fromEast);
    assert.equal(fromWest.length, CONNECTOR_WIDTH);
    // And the door opens through the same machinery every corridor door uses.
    const changed = setDoorTiles(grid, 1, 'east', false);
    assert.equal(changed.length, CONNECTOR_WIDTH);
    assert.ok(fromWest.every((index) => grid.tiles[index] === Tile.DoorOpen));
  });

  it('keeps seam tiles roomless, so crossing announces the arrival room and nothing else', () => {
    const grid = buildZoneTilemap(pair());
    assert.equal(roomAtTile(grid, ROOM_TILES, 4), -1, 'the seam belongs to no room');
    assert.equal(roomAtTile(grid, ROOM_TILES - 1, 4), 1);
    assert.equal(roomAtTile(grid, ROOM_TILES + 1, 4), 2);
  });

  it('floors a corner only when all four rooms around it stand open to each other', () => {
    const quad = (linked: boolean): Zone =>
      seamlessZone([
        { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 }, south: { to: 3 } } },
        { id: 2, sector: 'city', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 }, ...(linked ? { south: { to: 4 } } : {}) } },
        { id: 3, sector: 'city', pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 }, east: { to: 4 } } },
        { id: 4, sector: 'city', pos: { x: 1, y: 1, z: 0 }, exits: { west: { to: 3 }, ...(linked ? { north: { to: 2 } } : {}) } },
      ]);
    const open = buildZoneTilemap(quad(true));
    assert.equal(tileAt(open, ROOM_TILES, ROOM_TILES), Tile.Floor, 'a plaza corner is plaza');
    const walled = buildZoneTilemap(quad(false));
    assert.equal(tileAt(walled, ROOM_TILES, ROOM_TILES), Tile.Blocker, 'a corner beside any shut seam is a post');
    assert.equal(isWalkable(tileAt(walled, ROOM_TILES, ROOM_TILES)), false, 'and the post is solid');
  });

  it('flood-fill equals the room graph — the open world is still the MUD world', () => {
    // Velen Square's own shape: a plus of streets, an inn behind a door, and one deliberate
    // wall — the inn and the north street are adjacent with no exit between them.
    const door: Door = { name: 'the inn door', closed: false, locked: false };
    const zone = seamlessZone([
      { id: 1, sector: 'city', pos: { x: 0, y: 0, z: 0 }, exits: { north: { to: 2 }, south: { to: 3 }, west: { to: 4 }, east: { to: 5 } } },
      { id: 2, sector: 'city', pos: { x: 0, y: -1, z: 0 }, exits: { south: { to: 1 } } },
      { id: 3, sector: 'city', pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 } } },
      { id: 4, sector: 'city', pos: { x: -1, y: 0, z: 0 }, exits: { east: { to: 1 }, north: { to: 6, door } } },
      { id: 5, sector: 'city', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
      { id: 6, sector: 'inside', pos: { x: -1, y: -1, z: 0 }, exits: { south: { to: 4, door } } },
    ]);
    const grid = buildZoneTilemap(zone);

    const roomsReached = (): number[] => {
      const start = roomCentre(grid.roomOrigins.get(1)!);
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
      const reached = new Set<number>();
      for (const index of seen) {
        const room = grid.rooms[index] ?? -1;
        if (room !== -1) reached.add(room);
      }
      return [...reached].sort();
    };

    // The graph reaches all six rooms (the inn through its open door), and the tiles agree.
    assert.deepEqual(roomsReached(), [1, 2, 3, 4, 5, 6]);

    // Shut the door: the tiles must seal exactly what the graph would — the inn, and nothing else.
    setDoorTiles(grid, 4, 'north', true);
    assert.deepEqual(roomsReached(), [1, 2, 3, 4, 5], 'the shut door seals the inn and nothing else');
  });
});
