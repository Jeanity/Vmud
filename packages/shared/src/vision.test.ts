import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROOM_GAP,
  ROOM_STRIDE,
  ROOM_TILES,
  Tile,
  buildZoneTilemap,
  createTileGrid,
  roomCentre,
  setTile,
  tileAt,
  tileAtIndex,
  type TileGrid,
} from './tilemap.ts';
import {
  DEFAULT_LIGHT_RADIUS,
  bitsFromBase64,
  bitsToBase64,
  bitsetAdd,
  bitsetAddAll,
  bitsetBytes,
  bitsetHas,
  bitsetToSet,
  computeVisible,
  createBitset,
  isOpaqueTile,
} from './vision.ts';
import { boundsOf, type Room, type Zone } from './world.ts';

/**
 * Synthetic zones only. Beyond making these tests readable it exercises the project rule that the
 * engine must run with no third-party world data present.
 */
function makeZone(rooms: readonly Partial<Room>[]): Zone {
  const full = rooms.map((r, i) => ({
    id: r.id ?? i + 1,
    zone: 1,
    name: r.name ?? `Room ${i + 1}`,
    sector: r.sector ?? 'forest',
    pos: r.pos ?? { x: i, y: 0, z: 0 },
    exits: r.exits ?? {},
  })) as Room[];
  return { id: 1, name: 'Test Zone', rooms: full, bounds: boundsOf(full) };
}

/**
 * A hand-built grid, for geometry `buildZoneTilemap` cannot produce — a lone pillar, a wall with a
 * slit in it, a maze. `.` is floor and `#` is void. The corridor-mouth test, which is the behaviour
 * this whole change exists for, uses real generated geometry instead.
 */
function asciiGrid(rows: readonly string[]): TileGrid {
  const height = rows.length;
  const width = rows[0]!.length;
  // Built through the engine's own constructor rather than by assembling typed arrays here. The grid
  // is sparse chunks now, and a fixture that reached past the accessors would be testing a shape the
  // engine no longer has — and could not allocate the chunks a write outside a room block needs.
  const grid = createTileGrid({ width, height, roomOrigins: new Map([[1, { tx: 0, ty: 0 }]]) });
  for (let ty = 0; ty < height; ty++) {
    const row = rows[ty]!;
    assert.equal(row.length, width, 'ascii rows must be the same length');
    for (let tx = 0; tx < width; tx++) {
      if (row[tx] === '#') continue;
      setTile(grid, tx, ty, Tile.Floor, 4 /* forest, matching `makeZone` below */);
    }
  }
  return grid;
}

/** An open field of floor, `size` on a side. */
function openField(size: number): TileGrid {
  return asciiGrid(Array.from({ length: size }, () => '.'.repeat(size)));
}

function sees(grid: TileGrid, visible: ReadonlySet<number>, tx: number, ty: number): boolean {
  return visible.has(ty * grid.width + tx);
}

/** Renders a visible set next to the map, so a failure says what the light actually looked like. */
function draw(grid: TileGrid, visible: ReadonlySet<number>, ox: number, oy: number): string {
  const lines: string[] = [];
  for (let ty = 0; ty < grid.height; ty++) {
    let line = '';
    for (let tx = 0; tx < grid.width; tx++) {
      const lit = sees(grid, visible, tx, ty);
      const wall = isOpaqueTile(tileAt(grid, tx, ty));
      if (tx === ox && ty === oy) line += '@';
      else line += lit ? (wall ? '#' : '.') : ' ';
    }
    lines.push(line);
  }
  return `\n${lines.join('\n')}\n`;
}

/** A deterministic pseudo-random maze. A plain LCG, so the suite cannot start failing on a Tuesday. */
function mazeRows(seed: number, width: number, height: number, wallPercent: number): string[] {
  let state = seed >>> 0;
  const next = (n: number): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return state % n;
  };
  const rows: string[] = [];
  for (let ty = 0; ty < height; ty++) {
    let row = '';
    for (let tx = 0; tx < width; tx++) row += next(100) < wallPercent ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/* -------------------------------------------------------------------------- */

describe('computeVisible — the light itself', () => {
  it('starts at a deliberately tight radius', () => {
    // Not an arbitrary constant: 2 lights a 5x5 patch inside a 9x9 room, so exits must be walked
    // toward to be found and the first torch is a real upgrade.
    assert.equal(DEFAULT_LIGHT_RADIUS, 2);
  });

  it('always lights the origin, even standing inside a wall', () => {
    const grid = asciiGrid([
      '#####',
      '#####',
      '##.##',
      '#####',
      '#####',
    ]);
    // A character shoved into the void by a bug or a bad teleport must still render somewhere.
    const visible = computeVisible(grid, 2, 2, DEFAULT_LIGHT_RADIUS);
    assert.ok(sees(grid, visible, 2, 2));

    // And with no light at all, the origin is the whole of it.
    const dark = computeVisible(grid, 2, 2, 0);
    assert.deepEqual([...dark], [2 * grid.width + 2]);
  });

  it('returns nothing for an origin off the grid', () => {
    const grid = openField(5);
    assert.equal(computeVisible(grid, -1, 2, 4).size, 0);
    assert.equal(computeVisible(grid, 2, 99, 4).size, 0);
  });

  it('is round, not square', () => {
    const grid = openField(11);
    const visible = computeVisible(grid, 5, 5, 2);

    // The disc of radius 2.5 about a tile centre: the 5x5 block less its four corners.
    assert.equal(visible.size, 21, draw(grid, visible, 5, 5));
    for (const [dx, dy] of [
      [2, 2],
      [-2, 2],
      [2, -2],
      [-2, -2],
    ] as const) {
      assert.ok(!sees(grid, visible, 5 + dx, 5 + dy), `corner ${dx},${dy} should be out of range`);
    }
    // ...but the knight-ish tiles at 2.24 are inside it, which is what makes it a circle and not a
    // diamond either.
    for (const [dx, dy] of [
      [2, 1],
      [1, 2],
      [-2, 1],
      [2, 0],
    ] as const) {
      assert.ok(sees(grid, visible, 5 + dx, 5 + dy), `tile ${dx},${dy} should be lit`);
    }
  });

  it('is clipped by the grid edge rather than running off it', () => {
    const grid = openField(4);
    const visible = computeVisible(grid, 0, 0, 3);
    for (const index of visible) {
      assert.ok(index >= 0 && index < grid.width * grid.height, `index ${index} is off the grid`);
    }
    assert.ok(sees(grid, visible, 3, 0));
    assert.ok(!sees(grid, visible, 3, 3), '3,3 is 4.24 away');
  });
});

describe('computeVisible — line of sight', () => {
  it('casts a shadow behind a pillar', () => {
    const grid = asciiGrid([
      '.........',
      '.........',
      '.........',
      '....#....',
      '.........',
      '.........',
      '.........',
    ]);
    const visible = computeVisible(grid, 4, 4, 3);
    const map = draw(grid, visible, 4, 4);

    assert.ok(sees(grid, visible, 4, 3), `the pillar itself is lit${map}`);
    assert.ok(!sees(grid, visible, 4, 2), `4,2 is directly behind the pillar${map}`);
    assert.ok(!sees(grid, visible, 4, 1), `4,1 is deeper in the same shadow${map}`);
    // The shadow is a wedge, not a blackout: either side of it stays lit at the same range.
    assert.ok(sees(grid, visible, 3, 2), `3,2 is beside the shadow${map}`);
    assert.ok(sees(grid, visible, 5, 2), `5,2 is beside the shadow${map}`);
  });

  it('cannot see through a wall', () => {
    const grid = asciiGrid([
      '.......',
      '.......',
      '#######',
      '.......',
      '.......',
      '.......',
    ]);
    const visible = computeVisible(grid, 3, 4, 5);
    const map = draw(grid, visible, 3, 4);
    for (let tx = 0; tx < grid.width; tx++) {
      for (let ty = 0; ty < 2; ty++) {
        assert.ok(!sees(grid, visible, tx, ty), `${tx},${ty} is beyond the wall${map}`);
      }
    }
    // The near face of the wall is lit along its whole visible span, though.
    assert.ok(sees(grid, visible, 3, 2), `the wall in front of us is lit${map}`);
  });

  it('lights the wall at the edge of the radius without transmitting through it', () => {
    const grid = asciiGrid([
      '.......',
      '#######',
      '.......',
      '.......',
      '.......',
      '.......',
    ]);
    // Radius 2 puts the wall exactly on the edge: you see the wall your torch falls on. Getting this
    // backwards makes rooms render as floating floors with no walls at all.
    const tight = computeVisible(grid, 3, 3, 2);
    assert.ok(sees(grid, tight, 3, 1), `the wall two tiles away is lit${draw(grid, tight, 3, 3)}`);

    // Radius 3 reaches past it — and must not, because the wall is opaque.
    const wide = computeVisible(grid, 3, 3, 3);
    const map = draw(grid, wide, 3, 3);
    assert.ok(sees(grid, wide, 3, 1), `the wall is still lit${map}`);
    for (let tx = 0; tx < grid.width; tx++) {
      assert.ok(!sees(grid, wide, tx, 0), `${tx},0 is behind the wall${map}`);
    }
  });

  it('spills through a slit and fans out behind it', () => {
    // The corridor-mouth behaviour in miniature, and the reason no doorway special case is needed:
    // the lit region beyond the opening is a cone, so it covers more ground the further past the
    // wall it goes rather than stopping at the threshold.
    const grid = asciiGrid([
      '.........',
      '.........',
      '.........',
      '####.####',
      '.........',
      '.........',
      '.........',
    ]);
    const visible = computeVisible(grid, 4, 4, 6);
    const map = draw(grid, visible, 4, 4);

    assert.ok(sees(grid, visible, 4, 3), `the slit itself is lit${map}`);
    for (const tx of [3, 4, 5]) {
      assert.ok(sees(grid, visible, tx, 2), `${tx},2 is just beyond the slit${map}`);
    }
    assert.ok(!sees(grid, visible, 2, 2), `2,2 is outside the cone${map}`);
    assert.ok(!sees(grid, visible, 6, 2), `6,2 is outside the cone${map}`);

    // Two rows further on the same cone is two tiles wider on each side.
    for (const tx of [2, 6]) {
      assert.ok(sees(grid, visible, tx, 0), `${tx},0 should be inside the widened cone${map}`);
    }
    for (const tx of [0, 1, 7, 8]) {
      assert.ok(!sees(grid, visible, tx, 0), `${tx},0 is still in shadow${map}`);
    }
  });
});

describe('computeVisible — light through a corridor mouth', () => {
  // THE behaviour this change exists for. Room-granular fog made the room boundary a hard cliff:
  // you stood at a corridor mouth with a torch and the next room was pure black. Shadowcasting over
  // tiles needs no special case for a doorway — light spills through the opening because that is
  // simply where the unobstructed rays go.
  //
  // **`cave`, not the file's default `forest`, and that is M0's doing.** A corridor between two rooms
  // is now the answer for ground that has walls — interiors, caves, cities — while two adjacent
  // *outdoor* rooms merge along their whole shared edge and have no mouth to speak of. This suite is
  // about the mouth and the wall beside it, so its fixture has to be somewhere that still has one.
  // The merged case is pinned in `tilemap.test.ts` under 'the width of an opening'.
  const zone = makeZone([
    { id: 1, sector: 'cave', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 } } },
    { id: 2, sector: 'cave', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
  ]);

  const grid = buildZoneTilemap(zone);
  const roomTwoTx = ROOM_STRIDE; // first column of the second room block
  const mouthTx = ROOM_TILES - 1; // last floor column of the first room
  const midY = (ROOM_TILES - 1) / 2; // the corridor's centre line

  const inRoomTwo = (visible: ReadonlySet<number>): number[] =>
    [...visible].filter((index) => index % grid.width >= roomTwoTx);

  it('the fixture really is two rooms joined by a corridor ROOM_GAP tiles long', () => {
    assert.equal(roomCentre(grid.roomOrigins.get(1)!).ty, midY);
    for (let step = 0; step < ROOM_GAP; step++) {
      assert.equal(tileAt(grid, ROOM_TILES + step, midY), Tile.Connector);
      assert.equal(tileAt(grid, ROOM_TILES + step, 0), Tile.Void, 'the gap is void off the centre line');
    }
  });

  it('lights the next room from the corridor mouth', () => {
    const visible = computeVisible(grid, mouthTx, midY, 6);
    const map = draw(grid, visible, mouthTx, midY);

    assert.ok(sees(grid, visible, roomTwoTx, midY), `the far room's near edge is lit${map}`);
    assert.ok(inRoomTwo(visible).length >= 3, `several tiles of the far room are lit${map}`);
    // And the corridor between is lit along its length, so there is no black gap to walk through.
    for (let step = 0; step < ROOM_GAP; step++) {
      assert.ok(sees(grid, visible, ROOM_TILES + step, midY), `corridor tile ${step} is dark${map}`);
    }
  });

  it('does not light it from the far side of the same room', () => {
    // The anti-speedrun half of the rule: you can only ever see one lit radius beyond yourself, so
    // the next room stays dark until you walk up to the doorway.
    const far = computeVisible(grid, 0, midY, 6);
    assert.equal(inRoomTwo(far).length, 0, `nothing in the far room may be lit${draw(grid, far, 0, midY)}`);
  });

  it('does not light it from beside the doorway, even in range', () => {
    // Same distance band, but off the corridor's line: the wall between the two blocks is what stops
    // the light, not the radius. This is the assertion that would fail if walls transmitted.
    const beside = computeVisible(grid, mouthTx, 0, 6);
    const map = draw(grid, beside, mouthTx, 0);
    const target = { tx: roomTwoTx, ty: midY };
    const distance = Math.hypot(target.tx - mouthTx, target.ty - 0);
    assert.ok(distance <= 6.5, `the target must be inside the radius for this to mean anything (${distance})`);
    assert.ok(!sees(grid, beside, target.tx, target.ty), `blocked by the wall, not by range${map}`);
    assert.equal(inRoomTwo(beside).length, 0, `nothing in the far room may be lit${map}`);
  });

  it('a two-tile radius in a room centre does not reach the walls', () => {
    // Why the starting radius is interesting: standing in the middle of a 9x9 room with the bare
    // light, you cannot see any of its edges, so exits have to be found by walking.
    const centre = roomCentre(grid.roomOrigins.get(1)!);
    const visible = computeVisible(grid, centre.tx, centre.ty, DEFAULT_LIGHT_RADIUS);
    for (const index of visible) {
      const tx = index % grid.width;
      const ty = (index - tx) / grid.width;
      assert.ok(tx >= 2 && tx <= ROOM_TILES - 3 && ty >= 2 && ty <= ROOM_TILES - 3, `${tx},${ty} is too far`);
    }
  });
});

describe('computeVisible — doors', () => {
  /** Two rooms joined by a door both sides declare, in the given state. */
  function gatedZone(closed: boolean): Zone {
    const door = { name: 'an iron gate', closed, locked: false };
    return makeZone([
      { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2, door } } },
      { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1, door } } },
    ]);
  }

  /** Standing in the doorway's mouth, where an open corridor would show the next room. */
  function atMouth(grid: TileGrid): { tx: number; ty: number } {
    const origin = grid.roomOrigins.get(1)!;
    return { tx: origin.tx + ROOM_TILES - 1, ty: roomCentre(origin).ty };
  }

  it('counts a shut door as opaque and an open one as clear', () => {
    assert.equal(isOpaqueTile(Tile.Door), true);
    assert.equal(isOpaqueTile(Tile.DoorOpen), false);
    assert.equal(isOpaqueTile(Tile.Connector), false);
  });

  it('does not see past a shut door, and does once it opens', () => {
    // A radius that reaches the next room's first column through an open doorway — the relationship
    // `ROOM_GAP` is tuned for. The point of the test is that the *same* radius from the *same* tile
    // gives two answers, so what changed is the door and nothing else.
    const radius = ROOM_GAP + 1;
    const shut = buildZoneTilemap(gatedZone(true));
    const open = buildZoneTilemap(gatedZone(false));

    const from = atMouth(shut);
    const beyond = grid2Index(open, ROOM_STRIDE, from.ty);

    const throughShut = computeVisible(shut, from.tx, from.ty, radius);
    const throughOpen = computeVisible(open, from.tx, from.ty, radius);

    assert.ok(!throughShut.has(beyond), 'a shut door must not show the room behind it');
    assert.ok(throughOpen.has(beyond), 'an open one must');

    // The door itself is still lit while shut — walls are revealed by any ray that reaches them, so
    // the barrier is visible rather than being an unexplained hole in the light.
    const doorTile = shut.width * from.ty + ROOM_TILES;
    assert.equal(tileAtIndex(shut, doorTile), Tile.Door);
    assert.ok(throughShut.has(doorTile), 'you can see the door you cannot see through');
  });
});

/** Tile index of a cell, for reading assertions that would otherwise be arithmetic. */
function grid2Index(grid: TileGrid, tx: number, ty: number): number {
  return ty * grid.width + tx;
}

describe('computeVisible — symmetry', () => {
  it('is symmetric between transparent tiles across a whole maze', () => {
    // If A can see B then B must see A. Asymmetric field of view means a mob shoots you from
    // darkness you cannot see into, which is indefensible when light is a mechanic. Checked
    // exhaustively rather than argued: every open tile of a knotty maze, at three radii.
    const rows = mazeRows(17, 24, 24, 28);
    const grid = asciiGrid(rows);

    for (const radius of [2, 3, 6]) {
      const cache = new Map<number, Set<number>>();
      const visibleFrom = (index: number): Set<number> => {
        let found = cache.get(index);
        if (!found) {
          const tx = index % grid.width;
          found = computeVisible(grid, tx, (index - tx) / grid.width, radius);
          cache.set(index, found);
        }
        return found;
      };

      let pairs = 0;
      for (let ty = 0; ty < grid.height; ty++) {
        for (let tx = 0; tx < grid.width; tx++) {
          if (isOpaqueTile(tileAt(grid, tx, ty))) continue;
          const from = ty * grid.width + tx;
          for (const to of visibleFrom(from)) {
            const bx = to % grid.width;
            const by = (to - bx) / grid.width;
            // Walls are deliberately over-revealed — a torch lights the wall it falls on even when
            // the wall's centre is outside the slope range — so the guarantee is between tiles a
            // character can actually stand on.
            if (isOpaqueTile(tileAt(grid, bx, by))) continue;
            assert.ok(
              visibleFrom(to).has(from),
              `radius ${radius}: ${tx},${ty} sees ${bx},${by} but not the reverse`,
            );
            pairs++;
          }
        }
      }
      assert.ok(pairs > 2000, `radius ${radius} should exercise many pairs, only checked ${pairs}`);
    }
  });

  it('is symmetric across the geometry the world generator actually produces', () => {
    const grid = buildZoneTilemap(
      makeZone([
        { id: 1, pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 2 }, south: { to: 3 } } },
        { id: 2, pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 1 } } },
        { id: 3, pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 1 } } },
      ]),
    );
    const radius = 5;
    const cache = new Map<number, Set<number>>();
    const visibleFrom = (index: number): Set<number> => {
      let found = cache.get(index);
      if (!found) {
        const tx = index % grid.width;
        found = computeVisible(grid, tx, (index - tx) / grid.width, radius);
        cache.set(index, found);
      }
      return found;
    };

    for (let ty = 0; ty < grid.height; ty++) {
      for (let tx = 0; tx < grid.width; tx++) {
        if (isOpaqueTile(tileAt(grid, tx, ty))) continue;
        const from = ty * grid.width + tx;
        for (const to of visibleFrom(from)) {
          const bx = to % grid.width;
          const by = (to - bx) / grid.width;
          if (isOpaqueTile(tileAt(grid, bx, by))) continue;
          assert.ok(visibleFrom(to).has(from), `${tx},${ty} sees ${bx},${by} but not the reverse`);
        }
      }
    }
  });

  it('is deterministic', () => {
    const grid = asciiGrid(mazeRows(3, 20, 20, 30));
    const a = computeVisible(grid, 10, 10, 5);
    const b = computeVisible(grid, 10, 10, 5);
    assert.deepEqual([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));
  });
});

describe('the seen bitset', () => {
  it('sizes itself to the tile count, rounding up to whole bytes', () => {
    assert.equal(bitsetBytes(0), 0);
    assert.equal(bitsetBytes(1), 1);
    assert.equal(bitsetBytes(8), 1);
    assert.equal(bitsetBytes(9), 2);
    // The real thing: 168x156 is 26208 tiles, which is the 3.3 KB the protocol note claims.
    assert.equal(bitsetBytes(168 * 156), 3276);
  });

  it('sets and reads individual tiles', () => {
    const bits = createBitset(20);
    assert.ok(!bitsetHas(bits, 7));
    assert.equal(bitsetAdd(bits, 7), true);
    assert.equal(bitsetAdd(bits, 7), false, 'setting a set bit is not news');
    assert.ok(bitsetHas(bits, 7));
    assert.ok(!bitsetHas(bits, 6));
    assert.ok(!bitsetHas(bits, 8));

    // Out of range is refused rather than silently corrupting a neighbouring byte.
    assert.equal(bitsetAdd(bits, -1), false);
    assert.equal(bitsetAdd(bits, 10_000), false);
    assert.equal(bitsetHas(bits, -1), false);
    assert.equal(bitsetHas(bits, 10_000), false);
  });

  it('reports exactly the newly seen tiles, which is the seenDelta payload', () => {
    const bits = createBitset(64);
    assert.deepEqual(bitsetAddAll(bits, [3, 9, 3]), [3, 9], 'a repeat within one batch is not new');
    assert.deepEqual(bitsetAddAll(bits, [9, 10]), [10]);
    assert.deepEqual(bitsetAddAll(bits, [9, 10]), []);
  });

  it('accumulates a visible set into seen without ever storing visibility itself', () => {
    const grid = openField(11);
    const seen = createBitset(grid.width * grid.height);

    const first = computeVisible(grid, 3, 5, 2);
    const firstDelta = bitsetAddAll(seen, first);
    assert.equal(firstDelta.length, first.size, 'everything is new the first time');

    const second = computeVisible(grid, 4, 5, 2);
    const secondDelta = bitsetAddAll(seen, second);
    assert.ok(secondDelta.length > 0 && secondDelta.length < second.size, 'the two discs overlap');

    // `seen` is the union; `visible` is not, and the tile behind us proves it.
    const union = new Set([...first, ...second]);
    assert.deepEqual(bitsetToSet(seen, grid.width * grid.height), union);
    assert.ok(union.has(5 * grid.width + 1), '1,5 was seen from the first position');
    assert.ok(!second.has(5 * grid.width + 1), 'but it is not lit from the second');
  });

  it('never yields an index past the end of the grid', () => {
    // The last byte holds up to seven bits beyond the final tile. A stray index there would be a
    // tile that does not exist, and the pathfinder would happily route to it.
    const tileCount = 20;
    const bits = createBitset(tileCount);
    bits[2] = 0xff;
    const set = bitsetToSet(bits, tileCount);
    assert.deepEqual([...set].sort((a, b) => a - b), [16, 17, 18, 19]);
  });
});

describe('base64', () => {
  const roundTrip = (bits: Uint8Array): Uint8Array => bitsFromBase64(bitsToBase64(bits), bits.length);

  it('round-trips lengths that are and are not multiples of three bytes', () => {
    for (let length = 0; length <= 12; length++) {
      const bits = new Uint8Array(length);
      for (let i = 0; i < length; i++) bits[i] = (i * 37 + 11) & 0xff;
      assert.deepEqual(roundTrip(bits), bits, `length ${length} did not survive`);
    }
  });

  it('pads to a multiple of four characters', () => {
    assert.equal(bitsToBase64(new Uint8Array(0)), '');
    assert.equal(bitsToBase64(new Uint8Array([0])), 'AA==');
    assert.equal(bitsToBase64(new Uint8Array([0, 0])), 'AAA=');
    assert.equal(bitsToBase64(new Uint8Array([0, 0, 0])), 'AAAA');
    // Against a known-good encoding, so a self-consistent but wrong alphabet cannot pass.
    assert.equal(bitsToBase64(new Uint8Array([0xfb, 0xef, 0xbe])), '++++');
    assert.equal(bitsToBase64(new Uint8Array([77, 121, 71, 97, 109, 101])), 'TXlHYW1l');
  });

  it('keeps the trailing bits of the final byte when the tile count is not a byte multiple', () => {
    // 26208 tiles is a whole number of bytes; a 9x9 room block on its own is not. The bit that has
    // most often been lost here is the very last one.
    for (const tileCount of [1, 7, 8, 9, 17, ROOM_TILES * ROOM_TILES]) {
      const bits = createBitset(tileCount);
      const expected = tileCount === 1 ? [0] : [0, tileCount - 1];
      assert.deepEqual(bitsetAddAll(bits, expected), expected, `tile count ${tileCount} refused a bit`);

      const back = roundTrip(bits);
      assert.deepEqual(back, bits, `tile count ${tileCount} lost bytes`);
      assert.ok(bitsetHas(back, tileCount - 1), `tile count ${tileCount} lost its last bit`);
      assert.deepEqual(bitsetToSet(back, tileCount), new Set(expected));
    }
  });

  it('round-trips a full grid-sized bitset', () => {
    const tileCount = 168 * 156;
    const bits = createBitset(tileCount);
    let state = 99;
    const indices: number[] = [];
    for (let i = 0; i < 4000; i++) {
      state = (state * 1103515245 + 12345) >>> 0;
      indices.push(state % tileCount);
    }
    bitsetAddAll(bits, indices);

    const encoded = bitsToBase64(bits);
    assert.ok(encoded.length < 4500, `3.3 KB of bits should encode small, got ${encoded.length}`);
    const back = bitsFromBase64(encoded, bitsetBytes(tileCount));
    assert.deepEqual(back, bits);
    assert.deepEqual(bitsetToSet(back, tileCount), new Set(indices));
  });

  it('survives a wrong or damaged string without throwing', () => {
    const bits = createBitset(64);
    bitsetAddAll(bits, [0, 5, 63]);
    const encoded = bitsToBase64(bits);

    // Line-wrapped input decodes; whitespace is not part of the alphabet.
    const wrapped = `${encoded.slice(0, 4)}\n  ${encoded.slice(4)}`;
    assert.deepEqual(bitsFromBase64(wrapped, bits.length), bits);

    // A short string leaves the rest unseen rather than throwing mid-join.
    const truncated = bitsFromBase64(encoded.slice(0, 4), bits.length);
    assert.equal(truncated.length, bits.length);
    assert.ok(bitsetHas(truncated, 0));
    assert.ok(!bitsetHas(truncated, 63));

    // A longer one is clipped rather than handing out indices off the end of the map.
    assert.equal(bitsFromBase64(encoded, 2).length, 2);
    assert.equal(bitsFromBase64('', 8).length, 8);
    assert.deepEqual(bitsFromBase64('!!!!', 4), new Uint8Array(4));
  });
});
