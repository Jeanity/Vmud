import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SCENERY, SCENERY_KINDS, isSceneryKind, scatterFor, sceneryNamed, type RoomScenery } from './scenery.ts';
import {
  ROOM_TILES,
  STAIR_TILES,
  Tile,
  buildZoneTilemap,
  isWalkable,
  sceneryOf,
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

describe('what the wilderness grows on its own', () => {
  const ROOMS = Array.from({ length: 600 }, (_, i) => 40000 + i);

  it('never stands where a body can arrive, which is the bug the owner walked into', () => {
    // Owner, 2026-08-11: "I was stuck behind the log in the top left corner and couldn't move."
    // `arrivalTile` spreads an entering body laterally across tiles 1..7 of the edge it came
    // through, so the ring one tile in from each wall is where people appear - and a 3-wide log at
    // tiles 1..3 is a body standing inside a prop. The centre cross alone never protected that.
    const RESERVED = (t: number): boolean => t === 1 || t === ROOM_TILES - 2 || t === (ROOM_TILES - 1) / 2;
    for (const id of ROOMS) {
      for (const sector of ['forest', 'field', 'hills', 'swamp']) {
        for (const prop of scatterFor(id, sector, undefined)) {
          const spec = SCENERY[prop.kind];
          for (let dy = 0; dy < spec.depth; dy++) {
            for (let dx = 0; dx < spec.width; dx++) {
              const tx = prop.tx + dx;
              const ty = prop.ty + dy;
              assert.ok(!RESERVED(tx), `room ${id}: ${prop.kind} occupies reserved column ${tx}`);
              assert.ok(!RESERVED(ty), `room ${id}: ${prop.kind} occupies reserved row ${ty}`);
            }
          }
        }
      }
    }
  });

  it('never leaves a one-tile channel against a wall', () => {
    // The second half of the same report. A prop one tile in from the wall leaves 32px for a 20px
    // collision box - passable on paper, a wedge in practice, and worst at a corner. Reserving the
    // ring at inset 1 means the gap to any wall is always two tiles or more.
    for (const id of ROOMS) {
      for (const prop of scatterFor(id, 'forest', undefined)) {
        const spec = SCENERY[prop.kind];
        assert.ok(prop.tx >= 2, `room ${id}: ${prop.kind} leaves a ${prop.tx}-tile channel to the west wall`);
        assert.ok(prop.ty >= 2, `room ${id}: ${prop.kind} leaves a ${prop.ty}-tile channel to the north wall`);
        assert.ok(ROOM_TILES - (prop.tx + spec.width) >= 2, `room ${id}: ${prop.kind} too close to the east wall`);
        assert.ok(ROOM_TILES - (prop.ty + spec.depth) >= 2, `room ${id}: ${prop.kind} too close to the south wall`);
      }
    }
  });

  it('never stands on a staircase, which is the ring law one flight up', () => {
    // `stairPlacement` puts the flights inside the room block at offsets derived from the room id
    // and the vertical exits — as invisible to `scatterFor` as they are to an author reading the
    // room's JSON, because the exits are not among its inputs. The join is `sceneryOf`: a scattered
    // prop whose footprint would share a tile with a flight is dropped there. Dropped, never
    // re-sited — what survives is `scatterFor`'s own answer, thinned — which is why the expectation
    // below is a filter over `scatterFor` and not a second placement. Before the join existed, the
    // shipped world drew walk-through scatter on a staircase in 227 rooms (448 tiles, M2's count).
    const shapes: Room['exits'][] = [{ up: { to: 9 } }, { down: { to: 9 } }, { up: { to: 9 }, down: { to: 8 } }];
    for (const id of ROOMS) {
      for (const exits of shapes) {
        const room = makeRoom([], { id, sector: 'forest', exits });
        const flights = new Set(stairCells(room).map(({ dx, dy }) => dy * ROOM_TILES + dx));
        assert.ok(flights.size > 0, 'fixture has stairs');
        const clearOfFlights = (prop: RoomScenery): boolean => {
          const spec = SCENERY[prop.kind];
          for (let dy = 0; dy < spec.depth; dy++) {
            for (let dx = 0; dx < spec.width; dx++) {
              if (flights.has((prop.ty + dy) * ROOM_TILES + prop.tx + dx)) return false;
            }
          }
          return true;
        };
        assert.deepEqual(
          sceneryOf(room),
          scatterFor(id, 'forest', undefined).filter(clearOfFlights),
          `room ${id}: sceneryOf must be scatterFor's answer minus the props on a flight`,
        );
      }
    }
  });

  it('gives a room with no flights exactly what scatterFor grew', () => {
    for (const id of ROOMS.slice(0, 100)) {
      assert.deepEqual(sceneryOf(makeRoom([], { id, sector: 'forest' })), scatterFor(id, 'forest', undefined));
    }
  });

  it('never drops an authored prop, even one standing on a flight', () => {
    // The accessor polices only what it grew. An authored prop on a staircase is an authoring
    // mistake, and `scenerySiting` refuses it at build time with a sentence — a silent drop here
    // would hide exactly the mistake that check exists to surface.
    const bare = makeRoom([], { id: 4242, sector: 'forest', exits: { up: { to: 9 } } });
    const on = stairCells(bare)[0]!;
    const authored: RoomScenery[] = [{ kind: 'statue', tx: on.dx, ty: on.dy }];
    assert.deepEqual(sceneryOf(makeRoom(authored, { id: 4242, sector: 'forest', exits: bare.exits })), authored);
  });

  it('always fits inside the room', () => {
    for (const id of ROOMS) {
      for (const sector of ['forest', 'field', 'hills', 'swamp']) {
        for (const prop of scatterFor(id, sector, undefined)) {
          const spec = SCENERY[prop.kind];
          assert.ok(prop.tx >= 0 && prop.tx + spec.width <= ROOM_TILES, `${prop.kind} tx ${prop.tx}`);
          assert.ok(prop.ty >= 0 && prop.ty + spec.depth <= ROOM_TILES, `${prop.kind} ty ${prop.ty}`);
        }
      }
    }
  });

  it('never overlaps itself, because one prop stands per quadrant', () => {
    for (const id of ROOMS) {
      const taken = new Set<number>();
      for (const prop of scatterFor(id, 'forest', undefined)) {
        const spec = SCENERY[prop.kind];
        for (let dy = 0; dy < spec.depth; dy++) {
          for (let dx = 0; dx < spec.width; dx++) {
            const cell = (prop.ty + dy) * ROOM_TILES + prop.tx + dx;
            assert.ok(!taken.has(cell), `room ${id}: two props share ${prop.tx + dx},${prop.ty + dy}`);
            taken.add(cell);
          }
        }
      }
    }
  });

  it('is the same answer every time, for every player and every restart', () => {
    // No RNG stream, no order dependence: a pure function of the room id, which is what lets the
    // server and every client agree about which tiles are solid without a byte on the wire.
    for (const id of ROOMS.slice(0, 50)) {
      assert.deepEqual(scatterFor(id, 'forest', undefined), scatterFor(id, 'forest', undefined));
    }
  });

  it('leaves the tended places alone', () => {
    for (const sector of ['inside', 'city', 'road', 'mountain', 'cave', 'desert', 'water']) {
      assert.deepEqual(scatterFor(41000, sector, undefined), [], `${sector} should stay clear`);
    }
  });

  it('gives an authored room exactly what it was authored, and grows nothing beside it', () => {
    // An author who dressed a room owns it. Mixing the two would put hand-placed props in
    // competition for tiles with generated ones, which is a collision rule nobody wants to debug.
    const authored: RoomScenery[] = [{ kind: 'fountain', tx: 3, ty: 3 }];
    assert.deepEqual(scatterFor(41000, 'forest', authored), authored);
  });

  it('leaves some rooms empty, so a forest does not read as a regular pattern', () => {
    const empty = ROOMS.filter((id) => scatterFor(id, 'forest', undefined).length === 0).length;
    assert.ok(empty > ROOMS.length * 0.1, `only ${empty} clearings in ${ROOMS.length} rooms`);
    assert.ok(empty < ROOMS.length * 0.5, `${empty} of ${ROOMS.length} rooms are bare`);
  });

  it('actually puts something in most of the wilderness', () => {
    // The point of the slice. If this drops to nothing the forest is lawn again.
    const dressed = ROOMS.filter((id) => scatterFor(id, 'forest', undefined).length > 0).length;
    assert.ok(dressed > ROOMS.length * 0.5, `only ${dressed} of ${ROOMS.length} rooms grew anything`);
  });
});

