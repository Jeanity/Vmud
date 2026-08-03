import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { TILE_SIZE, type Item, type Place, type RoomId } from '@mygame/shared';

import {
  dropItem,
  groundSprite,
  groundViewOf,
  itemsIn,
  nearestMatching,
  resetGroundIds,
  takeItem,
  withinPickupReach,
  type Ground,
} from './ground.ts';

const PLACE: Place = { zone: 600, level: 0 };

function item(id: string, name = id, slot: Item['slot'] = 'chest'): Item {
  return { id, name, slot, ac: 0, size: 1 };
}
function at(x: number, y: number, room = 6001) {
  return { roomId: room as RoomId, place: PLACE, x, y };
}

describe('the ground store', () => {
  let ground: Ground;
  beforeEach(() => {
    ground = new Map();
    resetGroundIds();
  });

  it('holds several things in one room, which the scatter cannot', () => {
    // The whole reason this is not `pickups.ts`: a room scatters exactly one pickup, derived from its
    // own id, and a dropped object is created by an event with as many per room as have been dropped.
    dropItem(ground, item('a'), at(10, 10));
    dropItem(ground, item('b'), at(40, 10));
    dropItem(ground, item('c'), at(70, 10));
    assert.equal(itemsIn(ground, 6001 as RoomId).length, 3);
  });

  it('gives every drop its own id, so two of the same thing are two things', () => {
    const first = dropItem(ground, item('dagger'), at(0, 0));
    const second = dropItem(ground, item('dagger'), at(0, 0));
    assert.notEqual(first.id, second.id);
  });

  it('keeps its ids clear of the other two negative spaces', () => {
    // Pickups are `-(roomId + 1)` and reach about -97,000 on the shipped world; corpses start at
    // -1,000,000. Room ids would have to grow twentyfold before anything met anything.
    const dropped = dropItem(ground, item('a'), at(0, 0));
    assert.ok(dropped.id <= -2_000_000, `${dropped.id} is below the corpse range`);
  });

  it('lies where it was put, not at the room\'s centre', () => {
    const dropped = dropItem(ground, item('a'), at(137, 42));
    assert.deepEqual({ x: dropped.x, y: dropped.y }, { x: 137, y: 42 });
  });

  it('is gone once taken, and a second taker gets nothing', () => {
    const dropped = dropItem(ground, item('a'), at(0, 0));
    assert.equal(takeItem(ground, dropped.id)?.item.id, 'a');
    assert.equal(takeItem(ground, dropped.id), undefined, 'somebody else got there first');
    assert.equal(itemsIn(ground, 6001 as RoomId).length, 0);
  });

  it('keeps rooms apart', () => {
    dropItem(ground, item('a'), at(0, 0, 6001));
    dropItem(ground, item('b'), at(0, 0, 6002));
    assert.deepEqual(itemsIn(ground, 6001 as RoomId).map((e) => e.item.id), ['a']);
  });
});

describe('picking the one you meant', () => {
  let ground: Ground;
  beforeEach(() => {
    ground = new Map();
    resetGroundIds();
  });

  it('takes the nearest match, because a fight leaves things scattered', () => {
    dropItem(ground, item('t1', 'a leather tunic'), at(200, 0));
    const near = dropItem(ground, item('t2', 'a leather tunic'), at(10, 0));
    const found = nearestMatching(itemsIn(ground, 6001 as RoomId), 'tunic', 0, 0);
    assert.equal(found?.id, near.id);
  });

  it('matches a word of the display name or the id, and not a fragment', () => {
    dropItem(ground, item('leather_tunic', 'a leather tunic'), at(0, 0));
    const all = itemsIn(ground, 6001 as RoomId);
    assert.ok(nearestMatching(all, 'tunic', 0, 0));
    assert.ok(nearestMatching(all, 'leather_tunic', 0, 0));
    assert.equal(nearestMatching(all, 'tun', 0, 0), undefined);
  });

  it('takes the nearest of anything at all when no word is given', () => {
    dropItem(ground, item('far', 'a rope'), at(300, 0));
    const near = dropItem(ground, item('near', 'a lamp'), at(5, 0));
    assert.equal(nearestMatching(itemsIn(ground, 6001 as RoomId), '', 0, 0)?.id, near.id);
  });

  it('finds nothing rather than the wrong thing', () => {
    dropItem(ground, item('a', 'a rope'), at(0, 0));
    assert.equal(nearestMatching(itemsIn(ground, 6001 as RoomId), 'sword', 0, 0), undefined);
  });
});

describe('how it appears and how close you must be', () => {
  it('draws as a weapon or a bundle, by slot rather than by id', () => {
    // So a garment added later inherits a sensible look without anybody remembering this file.
    assert.equal(groundSprite(item('x', 'x', 'mainHand')), 'item_weapon');
    assert.equal(groundSprite(item('x', 'x', 'offHand')), 'item_weapon');
    assert.equal(groundSprite(item('x', 'x', 'chest')), 'item_bundle');
    assert.equal(groundSprite(item('x', 'x', 'head')), 'item_bundle');
  });

  it('goes down the client\'s existing item path — no new concept for objects', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const dropped = dropItem(ground, item('a', 'a coil of rope'), at(12, 34));
    const view = groundViewOf(dropped);
    assert.equal(view.kind, 'item');
    assert.equal(view.name, 'a coil of rope');
    assert.deepEqual({ x: view.x, y: view.y }, { x: 12, y: 34 });
  });

  it('is reachable from the same three tiles a corpse is', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const dropped = dropItem(ground, item('a'), at(0, 0));
    assert.equal(withinPickupReach(dropped, TILE_SIZE * 2, 0), true);
    assert.equal(withinPickupReach(dropped, TILE_SIZE * 4, 0), false);
  });
});
