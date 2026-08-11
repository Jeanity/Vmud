/**
 * Graph label-diffusion.
 *
 * What matters here is not that majority vote works — it is the guarantees the worldgen pipeline
 * leans on: determinism (same input, same bytes, whatever the iteration order), the synchronous
 * sweep (votes read the round's opening state, so in-round order cannot matter), frozen labels, the
 * stated tie-breaks, and the honesty of the residual (a component with no seed stays untouched
 * rather than being invented).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, type Room, type RoomId, type Sector, type Zone } from '@mygame/shared';

import { diffuseSectors } from './diffuse.ts';

/** A zone from a terse spec: id, sector, and east/west links down a corridor. */
function zone(id: number, rooms: readonly { id: number; sector: Sector; east?: number; extra?: Partial<Room['exits']> }[]): Zone {
  const built: Room[] = rooms.map((r, i) => ({
    id: r.id,
    zone: id,
    name: `Room ${r.id}`,
    sector: r.sector,
    pos: { x: i, y: 0, z: 0 },
    exits: {
      ...(r.east !== undefined ? { east: { to: r.east } } : {}),
      ...(r.extra ?? {}),
    },
  }));
  return { id, name: `Zone ${id}`, rooms: built, bounds: boundsOf(built), entryRoom: built[0]!.id };
}

const seeds = (...ids: number[]): ReadonlySet<RoomId> => new Set(ids);

function sectorOf(zones: readonly Zone[], id: RoomId): Sector {
  for (const z of zones) for (const r of z.rooms) if (r.id === id) return r.sector;
  throw new Error(`no room ${id}`);
}

describe('filling from neighbours', () => {
  it('walks a label down a corridor of unlabelled rooms', () => {
    // One forest seed, four defaulted rooms in a line. The wavefront takes a round per step.
    const world = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'field', east: 13 },
      { id: 13, sector: 'field', east: 14 },
      { id: 14, sector: 'field' },
    ])];
    const { zones, stats } = diffuseSectors(world, seeds(10));
    for (const id of [11, 12, 13, 14]) assert.equal(sectorOf(zones, id), 'forest', `room ${id}`);
    assert.deepEqual(
      { targets: stats.targets, filled: stats.filled, residual: stats.residual, rounds: stats.rounds },
      { targets: 4, filled: 4, residual: 0, rounds: 4 },
    );
  });

  it('takes the majority where regions meet, not the first arrival', () => {
    // Two cave neighbours outvote one city neighbour in the same round.
    const world = [zone(1, [
      { id: 10, sector: 'cave', east: 13 },
      { id: 11, sector: 'cave', extra: { north: { to: 13 } } },
      { id: 12, sector: 'city', extra: { south: { to: 13 } } },
      { id: 13, sector: 'field' },
    ])];
    const { zones } = diffuseSectors(world, seeds(10, 11, 12));
    assert.equal(sectorOf(zones, 13), 'cave');
  });

  it('treats a non-seed room as unlabelled whatever sector it carries', () => {
    // The loader's fallback is 'field', but nothing in the algorithm may trust that: a defaulted
    // room surrounded by swamp becomes swamp, however field-like its bytes looked.
    const world = [zone(1, [
      { id: 10, sector: 'swamp', east: 11 },
      { id: 11, sector: 'field' },
    ])];
    const { zones } = diffuseSectors(world, seeds(10));
    assert.equal(sectorOf(zones, 11), 'swamp');
  });

  it('leaves a seedless component exactly as it was, and counts it as residual', () => {
    // No invention: a region no evidence can reach keeps the default rather than being guessed at.
    const world = [
      zone(1, [{ id: 10, sector: 'forest', east: 11 }, { id: 11, sector: 'field' }]),
      zone(2, [{ id: 20, sector: 'field', east: 21 }, { id: 21, sector: 'field' }]),
    ];
    const { zones, stats } = diffuseSectors(world, seeds(10));
    assert.equal(sectorOf(zones, 11), 'forest');
    assert.equal(sectorOf(zones, 20), 'field');
    assert.equal(sectorOf(zones, 21), 'field');
    assert.equal(stats.residual, 2);
  });

  it('crosses zone boundaries, because a seedless zone can only be labelled from next door', () => {
    // The auto-generated Underdark travel grids have not one classifiable name in them; their only
    // evidence is the zone they connect to. Diffusion is context, not geometry, so a cross-zone
    // portal is an edge like any other.
    const world = [
      zone(1, [{ id: 10, sector: 'cave', extra: { east: { to: 20, portal: true } } }]),
      zone(2, [{ id: 20, sector: 'field', east: 21 }, { id: 21, sector: 'field' }]),
    ];
    const { zones } = diffuseSectors(world, seeds(10));
    assert.equal(sectorOf(zones, 20), 'cave');
    assert.equal(sectorOf(zones, 21), 'cave');
  });

  it('follows one-way exits in both directions, because adjacency is mutual context', () => {
    // The seed's room has the only exit; the unlabelled room points nowhere. It is still next door.
    const world = [zone(1, [
      { id: 10, sector: 'desert', east: 11 },
      { id: 11, sector: 'field' },
    ])];
    // Remove the reciprocal by construction: room 11 has no exits at all in the spec above.
    const { zones } = diffuseSectors(world, seeds(10));
    assert.equal(sectorOf(zones, 11), 'desert');
  });
});

describe('the sweep is synchronous and labels freeze', () => {
  it('lets two wavefronts meet without the first one recruiting the middle as a voter', () => {
    // forest seed - x - y - city seed. Round one labels x forest and y city *simultaneously*; if x
    // were committed early and voted on y in the same round, y would tie between forest and city
    // instead of taking its own neighbour's label cleanly.
    const world = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'field', east: 13 },
      { id: 13, sector: 'city' },
    ])];
    const { zones, stats } = diffuseSectors(world, seeds(10, 13));
    assert.equal(sectorOf(zones, 11), 'forest');
    assert.equal(sectorOf(zones, 12), 'city');
    assert.equal(stats.rounds, 1);
  });

  it('is unmoved by the order rooms and zones are listed in', () => {
    const forward = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'city' },
    ])];
    // Same graph, rooms listed backwards in a zone listed after a decoy.
    const reversed = [
      zone(2, [{ id: 20, sector: 'swamp' }]),
      {
        ...forward[0]!,
        rooms: [...forward[0]!.rooms].reverse(),
      },
    ];
    const a = diffuseSectors(forward, seeds(10, 12));
    const b = diffuseSectors(reversed, seeds(10, 12, 20));
    assert.equal(sectorOf(a.zones, 11), sectorOf(b.zones, 11));
  });
});

describe('tie-breaks', () => {
  it('gives a tied vote to the zone’s prevailing seed sector', () => {
    // Room 13 hears one cave and one city. Its zone's seeds lean cave, so cave it is.
    const world = [zone(1, [
      { id: 10, sector: 'cave', east: 13 },
      { id: 11, sector: 'city', extra: { north: { to: 13 } } },
      { id: 12, sector: 'cave', extra: { south: { to: 14 } } }, // another cave seed, elsewhere in the zone
      { id: 13, sector: 'field' },
      { id: 14, sector: 'field' },
    ])];
    const { zones } = diffuseSectors(world, seeds(10, 11, 12));
    assert.equal(sectorOf(zones, 13), 'cave');
  });

  it('falls back to alphabetical order when the zone is no help — arbitrary, stated, stable', () => {
    // One arctic seed, one swamp seed, one room between them, zone histogram tied 1-1.
    const world = [zone(1, [
      { id: 10, sector: 'swamp', east: 11 },
      { id: 11, sector: 'field' },
      { id: 12, sector: 'arctic', extra: { north: { to: 11 } } },
    ])];
    const { zones } = diffuseSectors(world, seeds(10, 12));
    assert.equal(sectorOf(zones, 11), 'arctic');
  });

  it('counts only seeds in the tie-break table, never its own verdicts', () => {
    // Two wavefronts, both three hops from room 13, so they arrive in the same round and tie 1–1.
    // The city side also fills a side corridor first, so by the tie there are more city *labels* in
    // the zone than cave ones — but the *seed* histogram is 1–1, and a judge that counted its own
    // verdicts would answer city where the stated rule (seeds, then alphabetical order) answers cave.
    const world = [zone(1, [
      { id: 10, sector: 'cave', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'field', east: 13 },
      { id: 13, sector: 'field' },
      { id: 14, sector: 'city', east: 15, extra: { north: { to: 24 } } },
      { id: 15, sector: 'field', east: 16 },
      { id: 16, sector: 'field', extra: { north: { to: 13 } } },
      { id: 24, sector: 'field', extra: { north: { to: 25 } } },
      { id: 25, sector: 'field' },
    ])];
    const { zones, stats } = diffuseSectors(world, seeds(10, 14));
    assert.equal(sectorOf(zones, 13), 'cave');
    assert.ok(stats.rounds >= 3);
  });
});

describe('bookkeeping', () => {
  it('reports what the filled rooms became', () => {
    const world = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'field' },
    ])];
    const { stats } = diffuseSectors(world, seeds(10));
    assert.deepEqual(stats.filledBySector, { forest: 2 });
  });

  it('reuses room objects it did not change', () => {
    // The pipeline hands zones through several stages; a stage that rewrote every object would make
    // "what changed" unanswerable in a debugger.
    const world = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field' },
    ])];
    const { zones } = diffuseSectors(world, seeds(10));
    assert.equal(zones[0]!.rooms[0], world[0]!.rooms[0], 'the seed room is the same object');
    assert.notEqual(zones[0]!.rooms[1], world[0]!.rooms[1], 'the relabelled room is a new one');
  });

  it('does nothing at all to a world with no unlabelled rooms', () => {
    const world = [zone(1, [{ id: 10, sector: 'forest', east: 11 }, { id: 11, sector: 'city' }])];
    const { zones, stats } = diffuseSectors(world, seeds(10, 11));
    assert.equal(stats.targets, 0);
    assert.equal(stats.rounds, 0);
    assert.equal(zones[0]!.rooms[0], world[0]!.rooms[0]);
  });

  it('reports `reached` as exactly the filled rooms, by id, whether or not the object changed', () => {
    // Room 11 enters unlabelled carrying 'field' (as any non-seed room the loader defaulted would),
    // and its only neighbour votes 'field' too — so the vote and the prior value agree, the output
    // object is untouched by identity (see the test above), and reference equality would miss it.
    // `reached` must not: a caller attributing per-room provenance from *this* set rather than object
    // identity is the whole reason it exists.
    const world = [zone(1, [
      { id: 10, sector: 'field', east: 11 },
      { id: 11, sector: 'field' },
    ])];
    const { zones, reached } = diffuseSectors(world, seeds(10));
    assert.equal(zones[0]!.rooms[1], world[0]!.rooms[1], 'object identity says unchanged');
    assert.equal(sectorOf(zones, 11), 'field');
    assert.ok(reached.has(11), 'but the room was still reached and voted on');
    assert.equal(reached.size, 1);
  });

  it('sizes `reached` to exactly stats.filled', () => {
    const world = [zone(1, [
      { id: 10, sector: 'forest', east: 11 },
      { id: 11, sector: 'field', east: 12 },
      { id: 12, sector: 'field' },
      { id: 13, sector: 'field' }, // no exits at all: unreachable, must not appear in `reached`
    ])];
    const { stats, reached } = diffuseSectors(world, seeds(10));
    assert.equal(reached.size, stats.filled);
    assert.equal(reached.has(13), false);
  });
});
