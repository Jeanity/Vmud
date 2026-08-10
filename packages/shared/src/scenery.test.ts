import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCENERY, SCENERY_KINDS, isSceneryKind, sceneryNamed, type RoomScenery } from './scenery.ts';
import {
  ROOM_TILES,
  STAIR_TILES,
  Tile,
  buildZoneTilemap,
  isWalkable,
  sceneryTile,
  scenerySiting,
  stairPlacement,
  tileAt,
} from './tilemap.ts';
import { isOpaqueTile } from './vision.ts';
import { boundsOf, type Room, type Zone } from './world.ts';

function makeRoom(scenery: readonly RoomScenery[], over: Partial<Room> = {}): Room {
  return {
    id: over.id ?? 1,
    zone: 1,
    name: 'Test Room',
    sector: 'city',
    pos: { x: 0, y: 0, z: 0 },
    exits: over.exits ?? {},
    scenery,
    ...over,
  } as Room;
}

function makeZone(rooms: readonly Room[]): Zone {
  return { id: 1, name: 'Test Zone', rooms: [...rooms], bounds: boundsOf(rooms) };
}

/** Room-relative footprint cells of the room's staircases, if any. */
function stairCells(room: Room): { dx: number; dy: number }[] {
  const stairs = stairPlacement(room.id, !!room.exits.up, !!room.exits.down);
  const cells: { dx: number; dy: number }[] = [];
  for (const offset of [stairs.up, stairs.down]) {
    if (!offset) continue;
    for (let dy = 0; dy < STAIR_TILES; dy++) {
      for (let dx = 0; dx < STAIR_TILES; dx++) cells.push({ dx: offset.dx + dx, dy: offset.dy + dy });
    }
  }
  return cells;
}

describe('the scenery catalogue', () => {
  it('never draws a prop shorter than the ground it stands on', () => {
    // `height` is the picture and `depth` is the floor it occupies; the picture may overhang the
    // ground *behind* the prop but can never be shorter than it, which would leave footprint tiles
    // solid with nothing drawn over them.
    for (const kind of SCENERY_KINDS) {
      const spec = SCENERY[kind];
      assert.ok(spec.height >= spec.depth, `${kind}: height ${spec.height} < depth ${spec.depth}`);
      assert.ok(spec.width >= 1 && spec.depth >= 1, `${kind} occupies no ground`);
      assert.ok(spec.width <= ROOM_TILES && spec.depth <= ROOM_TILES, `${kind} cannot fit any room`);
    }
  });

  it('gives an animated prop a frame duration and a still one none', () => {
    for (const kind of SCENERY_KINDS) {
      const spec = SCENERY[kind];
      assert.ok(spec.frames >= 1, `${kind} has no frames`);
      if (spec.frames > 1) assert.ok(spec.frameMs > 0, `${kind} animates with no frame duration`);
    }
  });

  it('recognises its own kinds and nothing else', () => {
    for (const kind of SCENERY_KINDS) assert.ok(isSceneryKind(kind));
    assert.ok(!isSceneryKind('gazebo'));
    assert.ok(!isSceneryKind(7));
    assert.ok(!isSceneryKind(undefined));
  });
});

describe('sceneryTile', () => {
  it('splits solidity from opacity, which is the whole reason Prop exists', () => {
    // A fountain: walk around it, see over it.
    const fountain = sceneryTile('fountain');
    assert.equal(fountain, Tile.Prop);
    assert.ok(!isWalkable(fountain), 'a fountain is not walkable');
    assert.ok(!isOpaqueTile(fountain), 'a fountain does not stop sight');

    // A hay bale: walk around it, and you cannot see past it either.
    const hay = sceneryTile('haystack');
    assert.equal(hay, Tile.Blocker);
    assert.ok(!isWalkable(hay), 'a hay bale is not walkable');
    assert.ok(isOpaqueTile(hay), 'a hay bale stops sight');
  });
});

describe('scenerySiting', () => {
  it('accepts a prop that fits', () => {
    assert.equal(scenerySiting(makeRoom([{ kind: 'fountain', tx: 3, ty: 3 }])), undefined);
  });

  it('accepts a room with no scenery at all', () => {
    assert.equal(scenerySiting(makeRoom([])), undefined);
    assert.equal(scenerySiting(makeRoom(undefined as unknown as RoomScenery[])), undefined);
  });

  it('refuses a footprint that leaves the room', () => {
    // The plinth is 3x3, so 7,7 puts its far corner two tiles into the gap where doors live.
    const why = scenerySiting(makeRoom([{ kind: 'plinth', tx: 7, ty: 7 }]));
    assert.match(String(why), /does not fit/);
    assert.match(String(scenerySiting(makeRoom([{ kind: 'well', tx: -1, ty: 0 }]))), /does not fit/);
  });

  it('refuses two props on the same tile', () => {
    const why = scenerySiting(
      makeRoom([
        { kind: 'fountain', tx: 2, ty: 2 },
        { kind: 'cart', tx: 3, ty: 3 },
      ]),
    );
    assert.match(String(why), /overlaps fountain/);
  });

  it('refuses a fractional offset', () => {
    const why = scenerySiting(makeRoom([{ kind: 'statue', tx: 1.5, ty: 2 }]));
    assert.match(String(why), /whole tile/);
  });

  it('refuses a prop standing on a staircase nobody can see in the JSON', () => {
    // The point of the check: stair offsets are derived from the room id, so an author reading
    // 100001014.json has no way to know a flight occupies 4,4 in it. Find where this room's stairs
    // actually landed and try to put a statue on one of those tiles.
    const room = makeRoom([], { id: 4242, exits: { up: { to: 1 } } });
    const cells = stairCells(room);
    assert.ok(cells.length > 0, 'fixture has stairs');
    const on = cells[0]!;
    const why = scenerySiting(makeRoom([{ kind: 'statue', tx: on.dx, ty: on.dy }], { id: 4242, exits: room.exits }));
    assert.match(String(why), /staircase/);
  });
});

describe('scenery in the tile grid', () => {
  it('stamps a footprint solid and leaves the rest of the room walkable', () => {
    const room = makeRoom([{ kind: 'fountain', tx: 3, ty: 3 }]);
    const grid = buildZoneTilemap(makeZone([room]));

    for (let ty = 0; ty < ROOM_TILES; ty++) {
      for (let tx = 0; tx < ROOM_TILES; tx++) {
        const inside = tx >= 3 && tx < 5 && ty >= 3 && ty < 5;
        const tile = tileAt(grid, tx, ty);
        if (inside) assert.equal(tile, Tile.Prop, `${tx},${ty} is fountain`);
        else assert.equal(tile, Tile.Floor, `${tx},${ty} is open floor`);
      }
    }
  });

  it('stamps only the footprint, not the overhang', () => {
    // A statue is one tile of floor and two tiles of picture. Only the floor tile goes solid — the
    // upper half is drawn over the ground behind it, and you may stand on that ground.
    const grid = buildZoneTilemap(makeZone([makeRoom([{ kind: 'statue', tx: 4, ty: 4 }])]));
    assert.equal(tileAt(grid, 4, 4), Tile.Prop, 'the statue stands on 4,4');
    assert.equal(tileAt(grid, 4, 3), Tile.Floor, 'the tile it is drawn over is still floor');
  });

  it('uses Blocker for an opaque prop so sight stops too', () => {
    const grid = buildZoneTilemap(makeZone([makeRoom([{ kind: 'haystack', tx: 0, ty: 0 }])]));
    assert.equal(tileAt(grid, 0, 0), Tile.Blocker);
    assert.ok(isOpaqueTile(tileAt(grid, 0, 0)));
  });

  it('never eats a staircase, even when told to', () => {
    // `scenerySiting` refuses this at authoring time, but the stamp is the last line of defence:
    // the grid is what movement resolves against, and a prop that silently deleted a flight of
    // stairs would strand whoever was meant to use it. Only plain floor is ever overwritten.
    const room = makeRoom([], { id: 909, exits: { down: { to: 2 } } });
    const on = stairCells(room)[0]!;
    const withProp = makeRoom([{ kind: 'plinth', tx: Math.min(on.dx, ROOM_TILES - 3), ty: Math.min(on.dy, ROOM_TILES - 3) }], {
      id: 909,
      exits: room.exits,
    });
    const grid = buildZoneTilemap(makeZone([withProp]));
    assert.equal(tileAt(grid, on.dx, on.dy), Tile.StairsDown, 'the stair survived the prop');
  });

  it('leaves a room with no scenery exactly as it was', () => {
    const bare = buildZoneTilemap(makeZone([makeRoom([])]));
    for (let ty = 0; ty < ROOM_TILES; ty++) {
      for (let tx = 0; tx < ROOM_TILES; tx++) assert.equal(tileAt(bare, tx, ty), Tile.Floor);
    }
  });
});

describe('naming a prop', () => {
  const crossing: RoomScenery[] = [
    { kind: 'fountain', tx: 2, ty: 3 },
    { kind: 'plinth', tx: 5, ty: 3 },
  ];

  it('answers to every word in its catalogue row', () => {
    for (const kind of SCENERY_KINDS) {
      const standing: RoomScenery[] = [{ kind, tx: 0, ty: 0 }];
      for (const word of SCENERY[kind].keywords) {
        assert.equal(sceneryNamed(standing, word)?.kind, kind, `${kind} should answer to "${word}"`);
      }
    }
  });

  it('matches whole words only, so look s is still south', () => {
    // A prefix match would let a statue answer to "s" and shadow the direction. `lookAt` gives
    // directions first refusal, but a prop that grabbed single letters would still be a trap.
    assert.equal(sceneryNamed([{ kind: 'statue', tx: 0, ty: 0 }], 's'), undefined);
    assert.equal(sceneryNamed([{ kind: 'fountain', tx: 0, ty: 0 }], 'foun'), undefined);
  });

  it('is case-blind, the way find_ex_description is', () => {
    assert.equal(sceneryNamed(crossing, 'FOUNTAIN')?.kind, 'fountain');
  });

  it('names nothing in a room that has none, and nothing for an empty word', () => {
    assert.equal(sceneryNamed(undefined, 'fountain'), undefined);
    assert.equal(sceneryNamed([], 'fountain'), undefined);
    assert.equal(sceneryNamed(crossing, ''), undefined);
    assert.equal(sceneryNamed(crossing, 'gazebo'), undefined);
  });

  it('marks exactly one kind as the thing a board is bolted to', () => {
    // If a second kind ever claims it, a room with both would have two readable noticeboards and
    // `read` would answer with whichever came first in the list - which is a coin toss, not a rule.
    const bearers = SCENERY_KINDS.filter((kind) => SCENERY[kind].bearsBoard === true);
    assert.deepEqual(bearers, ['plinth']);
  });

  it('lets the plinth be found by the words a player would actually type at a noticeboard', () => {
    for (const word of ['plinth', 'noticeboard', 'board', 'notices']) {
      assert.equal(sceneryNamed(crossing, word)?.kind, 'plinth', `"${word}"`);
    }
  });

  it('gives every prop something to say when looked at', () => {
    for (const kind of SCENERY_KINDS) {
      assert.ok(SCENERY[kind].look.length > 20, `${kind} has no description`);
      assert.ok(SCENERY[kind].keywords.length > 0, `${kind} answers to nothing`);
      for (const word of SCENERY[kind].keywords) {
        assert.equal(word, word.toLowerCase().trim(), `${kind}: "${word}" is not a plain lowercase word`);
        assert.ok(!word.includes(' '), `${kind}: "${word}" is two words`);
      }
    }
  });
});
