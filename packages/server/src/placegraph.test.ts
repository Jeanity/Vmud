/**
 * V4's graph, and the two conditions on an edge that keep it honest.
 *
 * The fixture is three Places in a chain: a ground level, an upper level reached by stairs, and a
 * separate zone reached by a portal. That is enough to exercise every rule — visited and unvisited
 * nodes, a link with both ends seen, and a link whose source room the character never stood in.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, placeKey, roomCentre, type Place, type Room, type Zone } from '@mygame/shared';
import { bitsetAddAll, createBitset } from '@mygame/shared/vision.ts';

import { buildPlaceGraph, type SeenMaps } from './placegraph.ts';
import { GameWorld } from './world.ts';

const GROUND = { zone: 700, level: 0 } as const;
const UPPER = { zone: 700, level: 1 } as const;
const OVER_THERE = { zone: 701, level: 0 } as const;

function room(id: number, zone: number, x: number, y: number, z: number, exits: Room['exits'] = {}): Room {
  return { id, zone, name: `Room ${id}`, sector: 'inside', pos: { x, y, z }, exits } as Room;
}

function world(): GameWorld {
  // 7000 --east--> 7001, and 7001 has a staircase up to 7010 on the level above.
  const home: Room[] = [
    room(7000, 700, 0, 0, 0, { east: { to: 7001 } }),
    room(7001, 700, 1, 0, 0, { west: { to: 7000 }, up: { to: 7010 } }),
    room(7010, 700, 0, 0, 1, { down: { to: 7001 } }),
    // A room on the ground level whose portal leads into the other zone. Deliberately *not* joined
    // to 7000, so a character can stand on this level without ever having seen it.
    room(7002, 700, 3, 3, 0, { north: { to: 7100, portal: true } }),
  ];
  const away: Room[] = [room(7100, 701, 0, 0, 0, { south: { to: 7002, portal: true } })];

  const zones: Zone[] = [
    { id: 700, name: 'Test Keep', rooms: home, bounds: boundsOf(home), entryRoom: 7000 },
    { id: 701, name: 'Test Marsh', rooms: away, bounds: boundsOf(away), entryRoom: 7100 },
  ];
  return new GameWorld(zones, { zone: 700, room: 7000 });
}

/** A character who has seen exactly these rooms — the centre tile of each, which is what the gate reads. */
function seeing(w: GameWorld, rooms: readonly { place: Place; room: number }[]): SeenMaps {
  const seen = new Map<string, Uint8Array>();
  for (const { place, room: id } of rooms) {
    const grid = w.grid(place);
    const origin = grid?.roomOrigins.get(id);
    if (!grid || !origin) throw new Error(`no grid for ${placeKey(place)} room ${id}`);
    const key = placeKey(place);
    const bits = seen.get(key) ?? createBitset(grid.width * grid.height);
    const centre = roomCentre(origin);
    bitsetAddAll(bits, [centre.ty * grid.width + centre.tx]);
    seen.set(key, bits);
  }
  return { seen };
}

describe('the graph of Places', () => {
  it('shows only the Places you have been', () => {
    const w = world();
    const graph = buildPlaceGraph(w, seeing(w, [{ place: GROUND, room: 7000 }]), GROUND);
    assert.deepEqual(
      graph.nodes.map((n) => `${n.zone}:${n.level}`),
      ['700:0'],
    );
    // The world has three Places. Two of them are somewhere this character has never stood, and a
    // map that named them would be handing out the shape of the world for free.
    assert.equal(w.allPlaces().length, 3);
  });

  it('always includes where you are standing, even before a tile of it is seen', () => {
    const w = world();
    // An empty seen map — the state on the very first frame after arriving somewhere new.
    const graph = buildPlaceGraph(w, { seen: new Map() }, UPPER);
    assert.deepEqual(
      graph.nodes.map((n) => `${n.zone}:${n.level}`),
      ['700:1'],
    );
    assert.equal(graph.nodes[0]?.rooms, 1, 'and it counts as one room rather than none');
  });

  it('counts rooms explored, not rooms that exist', () => {
    const w = world();
    const graph = buildPlaceGraph(w, seeing(w, [{ place: GROUND, room: 7000 }]), GROUND);
    // The ground level has three rooms. Saying so would tell a new character exactly how much of it
    // they have not found yet.
    assert.equal(graph.nodes[0]?.rooms, 1);
  });

  it('draws a link when both of its rooms have been seen', () => {
    const w = world();
    const maps = seeing(w, [
      { place: GROUND, room: 7001 },
      { place: UPPER, room: 7010 },
    ]);
    const graph = buildPlaceGraph(w, maps, GROUND);
    assert.equal(graph.edges.length, 1);
    assert.equal(placeKey(graph.edges[0]!.a), '700:0');
    assert.equal(placeKey(graph.edges[0]!.b), '700:1');
    assert.equal(graph.edges[0]!.via, 'up', 'the direction travelled, which is what a stair means');
  });

  it('draws no link from a staircase you never climbed', () => {
    const w = world();
    // Standing in the room *with* the staircase, having never climbed it. The exit is right there on
    // screen; what is at the top of it is not.
    const graph = buildPlaceGraph(w, seeing(w, [{ place: GROUND, room: 7001 }]), GROUND);
    assert.deepEqual(graph.edges, []);
  });

  it('draws no link through a room you have never seen — the secret-passage rule', () => {
    const w = world();
    // Both ends visited, but by separate routes: 7002 is the only room joining them and this
    // character has never been in it. Without this rule the map would hand them the passage.
    const maps = seeing(w, [
      { place: GROUND, room: 7000 },
      { place: OVER_THERE, room: 7100 },
    ]);
    const graph = buildPlaceGraph(w, maps, GROUND);
    assert.deepEqual(
      graph.nodes.map((n) => `${n.zone}:${n.level}`).sort(),
      ['700:0', '701:0'],
      'both places are on the map',
    );
    assert.deepEqual(graph.edges, [], 'but nothing says how they join');
  });

  it('draws one line for a doorway, not one per end', () => {
    const w = world();
    // Both sides seen and both Places visited, so both rooms' exits qualify. It is still one link.
    const maps = seeing(w, [
      { place: GROUND, room: 7002 },
      { place: OVER_THERE, room: 7100 },
    ]);
    const graph = buildPlaceGraph(w, maps, GROUND);
    assert.equal(graph.edges.length, 1);
  });
});
