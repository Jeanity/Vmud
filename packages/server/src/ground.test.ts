import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TILE_SIZE, type Item, type Place, type RoomId } from '@mygame/shared';

import {
  GROUND_DECAY_MS,
  GROUND_WARN_MS,
  advanceGround,
  dropItem,
  groundSprite,
  groundViewOf,
  itemsIn,
  visibleItemsIn,
  nearestMatching,
  resetGroundIds,
  takeItem,
  withinPickupReach,
  type Ground,
  stackRoomLines,
} from './ground.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

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

  it('puts the rot clock on the wire, so the warning is legible on the floor as well as in the log', () => {
    // The 3D client draws a loot sparkle over every ground object and dims it across the warning
    // window. It cannot work the number out for itself: the clock is server state, it restarts on a
    // pickup-and-drop, and `advanceGround` is the only thing that moves it.
    const ground: Ground = new Map();
    resetGroundIds();
    const dropped = dropItem(ground, item('a', 'a rusty dagger'), at(0, 0));
    const view = groundViewOf(dropped);
    assert.equal(view.remainingMs, GROUND_DECAY_MS);
    assert.equal(view.warnAtMs, GROUND_WARN_MS);

    // **Both, and never just the first.** `warnAtMs` is `min(GROUND_WARN_MS, decayMs / 2)`, so it is
    // per item rather than a constant — a dev server on `GAME_DEV_DECAY_MS=4000` warns at two seconds,
    // and a client that assumed the shipped minute would draw everything on it at full strength right
    // up to the moment it vanished.
    const brief = dropItem(ground, item('b', 'a dev dagger'), at(0, 0), undefined, 4_000);
    assert.equal(groundViewOf(brief).remainingMs, 4_000);
    assert.equal(groundViewOf(brief).warnAtMs, 2_000);

    // …and it is a live read rather than a copy taken at the drop: `advanceGround` mutates the entry,
    // and the view built afterwards has to say so or the `fading` correction would repeat the old
    // number back at the client it was sent to correct.
    advanceGround(ground, 30_000);
    assert.equal(groundViewOf(dropped).remainingMs, GROUND_DECAY_MS - 30_000);
  });

  it('is reachable from the same three tiles a corpse is', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const dropped = dropItem(ground, item('a'), at(0, 0));
    assert.equal(withinPickupReach(dropped, TILE_SIZE * 2, 0), true);
    assert.equal(withinPickupReach(dropped, TILE_SIZE * 4, 0), false);
  });
});

describe('a container put down is still full', () => {
  const arrow: Item = { id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 };

  it('carries what a container holds onto the floor and back', () => {
    // Before this, `dropItem` took a bare `Item` — so dropping a quiver of twenty arrows put the quiver
    // on the floor and destroyed the arrows. The same silent loss `readInventory` had, one store over.
    const ground: Ground = new Map();
    resetGroundIds();
    const held = { rule: { capacity: 30, accepts: 'missile' } as const, contents: [{ item: arrow, count: 20 }] };
    const dropped = dropItem(ground, item('quiver', 'a leather quiver'), at(8, 8), held);
    assert.deepEqual(dropped.held, held);
    assert.deepEqual(takeItem(ground, dropped.id)?.held, held, 'and it comes back up with it');
  });

  it('tells the client a floor object is a container, but not what is in it', () => {
    // The flag is what puts a `Look inside` row on the menu — the client cannot derive it, because
    // which of 16,421 catalogue entries hold things is content and content stays server-side. It says
    // *is a container* and nothing more: sending contents to everyone in the room would hand out the
    // answer to the verb before anybody looked.
    const ground: Ground = new Map();
    resetGroundIds();
    const held = { rule: { capacity: 5, accepts: 'missile' } as const, contents: [{ item: arrow, count: 3 }] };
    const sack = groundViewOf(dropItem(ground, item('sack', 'a small sack'), at(0, 0), held), undefined, true);
    assert.equal(sack.container, true);
    assert.equal(JSON.stringify(sack).includes('arrow'), false, 'and not a word about the arrows');

    assert.equal(groundViewOf(dropItem(ground, item('rock'), at(0, 0)), undefined, false).container, undefined);
  });

  it('trusts what a container already holds over what the catalogue says today', () => {
    // A sack with things in it is a sack, even if its catalogue entry is edited out from under it —
    // otherwise a builder's change would strand the contents behind a menu row that stopped existing.
    const ground: Ground = new Map();
    resetGroundIds();
    const held = { rule: { capacity: 5, accepts: 'any' } as const, contents: [{ item: arrow, count: 1 }] };
    const view = groundViewOf(dropItem(ground, item('sack'), at(0, 0), held), undefined, false);
    assert.equal(view.container, true);
  });

  it('does not write an empty container onto every dropped dagger', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const empty = { rule: { capacity: 30, accepts: 'any' } as const, contents: [] };
    assert.equal(dropItem(ground, item('sack'), at(0, 0), empty).held, undefined);
    assert.equal(dropItem(ground, item('dagger'), at(0, 0)).held, undefined);
  });
});

/**
 * The floor's clock — round 8, and the owner's ask: *"dropped items need to decay so we don't have
 * rooms full of discarded items everywhere."*
 *
 * The reason it matters is not tidiness. `reset.ts` caps object instances world-wide and counts what
 * is lying on floors, so a room of discards holds a zone's repop at its ceiling.
 */
describe('a thing nobody has found yet', () => {
  it('is on the floor, and is not in the list anybody is shown', () => {
    // ITEM_SECRET. The raw list is what `search` and the operator's panel read; every player-facing
    // path takes the filtered one, or the needle would be drawn on the floor, answer to `get needle`
    // and be listed by `look` - three ways of handing over the thing you had to look for.
    const ground: Ground = new Map();
    resetGroundIds();
    dropItem(ground, item('dagger'), at(0, 0));
    dropItem(ground, { ...item('needle'), hidden: true }, at(0, 0));

    assert.equal(itemsIn(ground, 6001).length, 2, 'both are really there');
    assert.deepEqual(visibleItemsIn(ground, 6001).map((e) => e.item.id), ['dagger']);
  });

  it('rots on the ordinary clock, so a corpse rotting does not litter the world', () => {
    // The owner's question, 2026-08-11: when a corpse rots with a hidden thing still in it, does the
    // thing pile up for ever? No - the corpse spills its contents onto the floor with the ordinary
    // decay clock and the flag rides along on the item, so it lands hidden, stays findable by
    // `search` for as long as any dropped thing lasts, and is then collected like anything else.
    const ground: Ground = new Map();
    resetGroundIds();
    dropItem(ground, { ...item('needle'), hidden: true }, at(0, 0));

    // It warns on the way past like any other dropped thing - being hidden does not exempt it
    // from the clock, which is the whole answer to the litter question.
    advanceGround(ground, GROUND_DECAY_MS - 100);
    assert.equal(ground.size, 1, 'still there, still hidden');
    assert.equal(visibleItemsIn(ground, 6001).length, 0, 'and still not shown to anyone');
    assert.equal(itemsIn(ground, 6001).length, 1, 'but searchable the whole time');

    const events = advanceGround(ground, 200);
    assert.deepEqual(events.map((e) => e.kind), ['gone']);
    assert.equal(ground.size, 0, 'nothing accumulates');
  });
});

describe('decay', () => {
  it('gives a dropped thing the full clock, and takes it away when the clock runs out', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const dropped = dropItem(ground, item('dagger'), at(0, 0));
    assert.equal(dropped.remainingMs, GROUND_DECAY_MS);

    assert.deepEqual(advanceGround(ground, 1000), [], 'nothing to say a second in');
    assert.equal(ground.size, 1);

    // One step past the end. Note it reports `gone` alone rather than warning on the way past: a
    // thing that has already vanished has nothing to warn about, and a caller handed both would have
    // to work out which of the two to render.
    const events = advanceGround(ground, GROUND_DECAY_MS);
    assert.deepEqual(events.map((e) => e.kind), ['gone']);
    assert.equal(ground.size, 0, 'and it is off the floor');
  });

  it('warns once rather than every tick', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    dropItem(ground, item('dagger'), at(0, 0));

    // Up to just short of the threshold, so the warning has not fired yet, then across it.
    advanceGround(ground, GROUND_DECAY_MS - GROUND_WARN_MS - 100);
    const first = advanceGround(ground, 200);
    assert.deepEqual(first.map((e) => e.kind), ['fading']);
    // A countdown that says so every tick is a nag; one that never says so is a thing that vanishes
    // while somebody is walking back for it.
    assert.deepEqual(advanceGround(ground, 100), []);
  });

  it('hands a gone container its contents, so the caller can spill them', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const held = { rule: { capacity: 20, accepts: 'any' } as const, contents: [{ item: item('arrow'), count: 20 }] };
    dropItem(ground, item('quiver'), at(0, 0), held);

    const gone = advanceGround(ground, GROUND_DECAY_MS).find((e) => e.kind === 'gone');
    assert.equal(gone?.entry.held?.contents[0]?.count, 20);
  });

  it('restarts the clock on a fresh drop, which the floor not being saved makes free', () => {
    const ground: Ground = new Map();
    resetGroundIds();
    const first = dropItem(ground, item('dagger'), at(0, 0));
    advanceGround(ground, GROUND_DECAY_MS / 2);
    assert.ok(first.remainingMs < GROUND_DECAY_MS);

    const taken = takeItem(ground, first.id);
    assert.ok(taken);
    const again = dropItem(ground, taken.item, at(0, 0));
    // Nothing here is persisted, so a restart clears the floor outright — there is no long-lived
    // object whose age this could be used to game. If `ground.ts` ever gains a save file, this is the
    // line to think about again.
    assert.equal(again.remainingMs, GROUND_DECAY_MS);
  });
});

describe('naming what is glinting', () => {
  it('collapses consecutive identical lines behind a count, and leaves the rest alone', () => {
    // `actinf.c:901`'s rule. Twenty arrows spilled by a decaying container is one line saying so,
    // not twenty sentences — and without it the answer to `look sparkle` is a wall of text.
    const arrow = 'An arrow lies here.';
    const sword = 'Someone have lost a sword here.';
    assert.deepEqual(stackRoomLines([arrow, arrow, arrow]), [`[3] ${arrow}`]);
    assert.deepEqual(stackRoomLines([sword]), [sword]);
    assert.deepEqual(stackRoomLines([]), []);
    assert.deepEqual(stackRoomLines([sword, arrow]), [sword, arrow]);
  });

  it('counts runs, not totals — the floor keeps its own order', () => {
    // **Consecutive rather than global, deliberately.** Sorting first would collapse the two runs of
    // arrows into one and would throw away what the floor is actually telling you: what was dropped
    // last lies on top. The source counts runs and so does this.
    const arrow = 'An arrow lies here.';
    const sword = 'Someone have lost a sword here.';
    assert.deepEqual(stackRoomLines([arrow, arrow, sword, arrow, arrow, arrow]), [
      `[2] ${arrow}`,
      sword,
      `[3] ${arrow}`,
    ]);
  });

  it('has a room line for every item in the catalogue, so nothing falls back', () => {
    // The whole feature rests on this: the prose is the builders' own and there is none to write.
    // Measured 2026-08-15 at 16,421 of 16,421. If a re-harvest ever drops the field, `look sparkle`
    // quietly degrades to "<name> is lying here" for the affected rows and this is where it shows.
    const file = join(REPO_ROOT, 'data', 'world', 'items.json');
    if (!existsSync(file)) return;
    const rows = Object.values(JSON.parse(readFileSync(file, 'utf8')) as Record<string, { roomLine?: unknown }>);
    const missing = rows.filter((row) => typeof row.roomLine !== 'string' || row.roomLine.trim() === '');
    assert.equal(missing.length, 0, `${missing.length} of ${rows.length} catalogue rows have no roomLine`);
    assert.ok(rows.length > 16_000, `the catalogue should be the whole harvest, got ${rows.length}`);
  });
});
