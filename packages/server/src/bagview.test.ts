/**
 * What the bag looks like on the wire — **A7d-bag, protocol 20.**
 *
 * The rest of the bag's shape (folding, counts, charges, a container's fullness) is exercised through
 * the inventory command and the stack tests. What is tested here is the one thing this slice added and
 * the one way it can silently be wrong: **the art class comes through the injected resolver**, so a row
 * carries a picture id when the catalogue has one for it and nothing at all when it does not.
 *
 * The injection is the point. `sim.ts` must not know what a catalogue is — the rule `artClassOf` was
 * created under for `EntityView.wearing` — and the bag now reads the *same* resolver, so an item in your
 * hand and the same item in your bag cannot draw differently.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, makeRng, type Item, type Room, type RoomId, type Zone } from '@mygame/shared';

import { Simulation } from './sim.ts';
import { GameWorld } from './world.ts';

const room = (id: number): Room => ({
  id: id as RoomId,
  zone: 900,
  name: 'A Room',
  pos: { x: 0, y: 0, z: 0 },
  sector: 'inside',
  exits: {},
});

const rooms = [room(90001)];
const zone: Zone = { id: 900, name: 'Test', rooms, bounds: boundsOf(rooms) };

function makeSim() {
  const sim = new Simulation(new GameWorld([zone], { zone: 900, room: 90001 as RoomId }));
  return { sim, player: sim.spawn('Bagholder', makeRng(1)) };
}

const item = (id: string, name: string): Item => ({ id, name, ac: 0, size: 1 });

describe('a bag row on the wire', () => {
  it('carries the art class the resolver gives it, and nothing when there is none', () => {
    const { sim, player } = makeSim();
    // The same shape `index.ts` injects at boot: a catalogue lookup this file knows nothing about.
    sim.artClassOf = (held) => (held.id === 'obj:83328' ? 'cape-solid' : undefined);
    player.inventory = {
      ...player.inventory,
      stacks: [
        { item: item('obj:83328', 'a hooded black cape'), count: 1 },
        { item: item('obj:10', 'a long black dagger'), count: 1 },
      ],
    };

    const rows = sim.selfViewOf(player).bag?.rows ?? [];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.art, 'cape-solid');
    // Absent, not `undefined` in the payload and not an empty string: a row for something with no
    // picture says nothing, which is what keeps the addition free for most of a 16,421-entry catalogue.
    assert.equal('art' in (rows[1] ?? {}), false);
  });

  it('says nothing about art when no resolver has been injected', () => {
    // A checkout with no harvested catalogue, which is exactly the state `artClassOf`'s own doc comment
    // describes as having to keep working.
    const { sim, player } = makeSim();
    player.inventory = {
      ...player.inventory,
      stacks: [{ item: item('obj:83328', 'a hooded black cape'), count: 1 }],
    };
    const rows = sim.selfViewOf(player).bag?.rows ?? [];
    assert.equal(rows.length, 1);
    assert.equal('art' in (rows[0] ?? {}), false);
  });

  it('gives a container\'s contents their own art', () => {
    const { sim, player } = makeSim();
    sim.artClassOf = (held) => (held.id === 'obj:1750' ? 'weapon-sword-glowsword-blue' : undefined);
    const sack: Item = { id: 'obj:500', name: 'a sack', ac: 0, size: 2 };
    player.inventory = {
      ...player.inventory,
      stacks: [
        {
          item: sack,
          count: 1,
          held: {
            rule: { capacity: 10, accepts: 'any' },
            contents: [{ item: item('obj:1750', 'a glowing sword'), count: 1 }],
          },
        },
      ],
    };

    const rows = sim.selfViewOf(player).bag?.rows ?? [];
    // The row inside is built by the same `rowOf`, so this is really asserting that the recursion was
    // not written twice — which is how the nested rows would have ended up without pictures.
    assert.equal(rows[0]?.contents?.[0]?.art, 'weapon-sword-glowsword-blue');
  });

});
