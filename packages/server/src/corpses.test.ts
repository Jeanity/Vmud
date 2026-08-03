/**
 * Corpses: what a death leaves, how long it lasts, and the sprite that says it has been robbed.
 *
 * The sprite test is the one the owner asked for by name — a picked-clean corpse must *look* different
 * from an untouched one, so a corridor of corpses can be read from across the room without walking over
 * to each of them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  boundsOf,
  emptyInventory,
  stackOf,
  makeRng,
  noPursuit,
  passiveRule,
  readCombatStats,
  type Item,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import {
  nearestLootable,
  CORPSE_DECAY_MS,
  CORPSE_WARN_MS,
  PLAYER_CORPSE_DECAY_MS,
  advanceCorpses,
  corpseName,
  corpseSprite,
  corpseViewOf,
  corpsesIn,
  lootCorpse,
  lootRefusal,
  makeCorpse,
  withinReach,
  type Corpse,
  type Graveyard,
} from './corpses.ts';
import { Simulation } from './sim.ts';
import { GameWorld } from './world.ts';

/** Something a corpse can hold. The slot is irrelevant here; only the bulk is. */
function thing(id: string, size: number): Item {
  return { id, name: id, slot: 'chest', ac: 0, size };
}

function graveZone(): Zone {
  const rooms: Room[] = [
    { id: 3000, zone: 300, name: 'The Crypt', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 3001 } } },
    { id: 3001, zone: 300, name: 'The Antechamber', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 3000 } } },
  ];
  return { id: 300, name: 'Test Crypt', rooms, bounds: boundsOf(rooms), entryRoom: 3000 };
}

const template: MobTemplate = {
  vnum: 300_01,
  keywords: ['sentry'],
  name: 'a sentry',
  room: 'A sentry stands here.',
  level: 10,
  hp: '1d1+49',
  sprite: 'human',
  aggro: passiveRule(10),
  pursuit: noPursuit(),
  combat: readCombatStats({ level: 10, armour: 0, damage: '1d4+0' }),
  experience: 1000,
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
};

function fixture() {
  const sim = new Simulation(new GameWorld([graveZone()], { zone: 300, room: 3000 }));
  const player = sim.spawn('Mourner', makeRng(1));
  const mob = sim.spawnMob(template, 3000, makeRng(0xc0f1e5));
  return { sim, player, mob, yard: new Map() as Graveyard };
}

describe('what a death leaves', () => {
  it('lies where the body fell, not at the room centre', () => {
    // Worth the two lines: a fight that ranged across a room leaves its dead spread across it, and
    // walking back to a particular corpse is the mechanic rather than a formality.
    const f = fixture();
    assert.ok(f.mob);
    f.mob.x = 512;
    f.mob.y = 384;
    const corpse = makeCorpse(f.yard, f.mob, false);
    assert.equal(corpse.x, 512);
    assert.equal(corpse.y, 384);
    assert.equal(corpse.roomId, f.mob.roomId);
  });

  it('reads as a corpse of whoever it was', () => {
    const f = fixture();
    assert.ok(f.mob);
    assert.equal(corpseName(makeCorpse(f.yard, f.mob, false)), 'the corpse of a sentry');
  });

  it('takes an id that cannot collide with a living entity', () => {
    // `Simulation` hands out ids from 1 upward, so negative ids are disjoint by arithmetic rather than
    // by a base constant chosen to be big enough.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    assert.ok(corpse.id < 0);
    assert.equal(f.sim.get(corpse.id), undefined);
  });

  it('reaches a client as an item, so the renderer needed no new case', () => {
    const f = fixture();
    assert.ok(f.mob);
    const view = corpseViewOf(makeCorpse(f.yard, f.mob, false));
    assert.equal(view.kind, 'item');
    assert.equal(view.healthFraction, 0);
  });
});

describe('the looted sprite', () => {
  it('is a pile of bones while it holds something, then a single bone', () => {
    // The owner's rule: a picked-clean corpse must look picked clean, so "has anyone been here" is
    // answerable from across the room.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('rope', 2)]);
    assert.equal(corpseSprite(corpse), 'corpse');
    lootCorpse(corpse, emptyInventory());
    assert.equal(corpseSprite(corpse), 'corpse_looted');
  });

  it('is a single bone from the moment it falls when it held nothing', () => {
    // Phase 15b: emptiness is the flag, so a mob that drops nothing says so without being walked over
    // to. Before this, every corpse looked worth searching until somebody had searched it.
    const f = fixture();
    assert.ok(f.mob);
    assert.equal(corpseSprite(makeCorpse(f.yard, f.mob, false)), 'corpse_looted');
  });

  it('stays a pile while one thing is still in it', () => {
    // The case the flag used to get wrong: a bag that could take two of three leaves the third behind,
    // and drawing that body as picked clean hides it.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('anvil', 19), thing('pin', 1)]);
    const result = lootCorpse(corpse, { stacks: [stackOf(thing('ballast', 19))], capacity: 20 });
    assert.deepEqual(result.taken.map((i) => i.id), ['pin']);
    assert.deepEqual(result.left.map((i) => i.id), ['anvil']);
    assert.equal(corpseSprite(corpse), 'corpse', 'still worth searching');
  });

  it('carries the new sprite on the view', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('rope', 2)]);
    lootCorpse(corpse, emptyInventory());
    assert.equal(corpseViewOf(corpse).sprite, 'corpse_looted');
  });
});

describe('emptying a body', () => {
  it('moves what fits into the bag and leaves the rest in the corpse', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('tunic', 3), thing('dagger', 1)]);
    const result = lootCorpse(corpse, emptyInventory());
    assert.deepEqual(result.inventory.stacks.map((s) => s.item.id), ['tunic', 'dagger']);
    assert.equal(corpse.contents.length, 0);
  });

  it('takes a smaller thing sitting behind one that would not fit', () => {
    // Each item is asked separately, so what you get does not depend on the order somebody died
    // holding things.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('breastplate', 10), thing('ring', 1)]);
    const result = lootCorpse(corpse, { stacks: [stackOf(thing('ballast', 15))], capacity: 20 });
    assert.deepEqual(result.taken.map((i) => i.id), ['ring']);
  });

  it('leaves the caller\'s bag untouched — it returns a new one', () => {
    const f = fixture();
    assert.ok(f.mob);
    const bag = emptyInventory();
    const corpse = makeCorpse(f.yard, f.mob, false, [thing('rope', 2)]);
    lootCorpse(corpse, bag);
    assert.equal(bag.stacks.length, 0);
  });
});

describe('who may loot what', () => {
  it('lets anybody go through a mob', () => {
    const f = fixture();
    assert.ok(f.mob);
    assert.equal(lootRefusal(makeCorpse(f.yard, f.mob, false), f.player), undefined);
  });

  it('keeps a player\'s corpse theirs while PvP is off', () => {
    // Owner's rule (2026-08-03): *"we should not be able to loot other players' corpses as this is not
    // a pkill game."* Off is the default, so this is what the argument-less call answers.
    const f = fixture();
    const corpse = makeCorpse(f.yard, f.player, true);
    const other = f.sim.spawn('Stranger', makeRng(1));
    assert.equal(lootRefusal(corpse, other), 'someone-elses');
    assert.equal(lootRefusal(corpse, f.player), undefined, 'but their own is fine');
  });

  it('opens player corpses to everyone once PvP is switched on', () => {
    // The pkill-evening case: the operator throws the switch and the same body becomes fair game,
    // without any state on the corpse itself changing — so a corpse that fell before the switch is
    // governed by the switch as it stands now, which is the only rule anybody could reason about.
    const f = fixture();
    const corpse = makeCorpse(f.yard, f.player, true);
    const other = f.sim.spawn('Stranger', makeRng(1));
    assert.equal(lootRefusal(corpse, other, true), undefined);
  });

  it('never let the switch reach a mob\'s corpse either way', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    assert.equal(lootRefusal(corpse, f.player, false), undefined);
    assert.equal(lootRefusal(corpse, f.player, true), undefined);
  });

  it('refuses one in another room', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    f.sim.relocate(f.player, 3001);
    assert.equal(lootRefusal(corpse, f.player), 'not-here');
  });

  it('refuses one that has already rotted away', () => {
    const f = fixture();
    assert.equal(lootRefusal(undefined, f.player), 'gone');
  });
});

describe('decay', () => {
  it('lasts far longer for a player, because retrieval is a journey', () => {
    assert.ok(PLAYER_CORPSE_DECAY_MS > CORPSE_DECAY_MS);
  });

  it('warns once before it goes, and only once', () => {
    // A countdown that announces itself every tick is a nag; one that never does is a corpse that
    // vanishes without explanation while you are walking back to it.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    corpse.remainingMs = CORPSE_WARN_MS + 100;

    assert.deepEqual(advanceCorpses(f.yard, 50).map((e) => e.kind), []);
    assert.deepEqual(advanceCorpses(f.yard, 100).map((e) => e.kind), ['rotting']);
    assert.deepEqual(advanceCorpses(f.yard, 100).map((e) => e.kind), [], 'said once');
  });

  it('goes when its time is up, and leaves the yard', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    corpse.remainingMs = 100;
    const events = advanceCorpses(f.yard, 200);
    assert.deepEqual(events.map((e) => e.kind), ['gone']);
    assert.equal(f.yard.size, 0);
  });

  it('ages in small ticks the same as one large one', () => {
    const f = fixture();
    assert.ok(f.mob);
    makeCorpse(f.yard, f.mob, false);
    for (let i = 0; i < CORPSE_DECAY_MS / 100 - 1; i++) advanceCorpses(f.yard, 100);
    assert.equal(f.yard.size, 1, 'still there a tick before its time');
    advanceCorpses(f.yard, 100);
    assert.equal(f.yard.size, 0);
  });
});

describe('finding one', () => {
  it('lists the corpses in a room', () => {
    const f = fixture();
    assert.ok(f.mob);
    makeCorpse(f.yard, f.mob, false);
    makeCorpse(f.yard, f.mob, false);
    assert.equal(corpsesIn(f.yard, 3000).length, 2, 'several can share a room, unlike a ground pickup');
    assert.equal(corpsesIn(f.yard, 3001).length, 0);
  });

  it('is reachable from a few tiles away, because loot is a room action', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    assert.equal(withinReach(corpse, corpse.x, corpse.y), true);
    assert.equal(withinReach(corpse, corpse.x + 64, corpse.y), true);
    assert.equal(withinReach(corpse, corpse.x + 640, corpse.y), false);
  });
});

describe('which body a loot means', () => {
  /** Three corpses on one floor, at increasing distance, so "nearest" is something to get wrong. */
  function scatter(): Corpse[] {
    const at = (id: number, x: number, looted: boolean): Corpse =>
      ({ id, of: 'a sentry', roomId: 6001, x, y: 0, looted, ageMs: 0, decayMs: 300_000 }) as unknown as Corpse;
    return [at(-901, 90, false), at(-902, 30, false), at(-903, 10, true)];
  }

  it('takes the nearest one still worth searching', () => {
    // The looted body at 10 is closest and is not the answer; the unlooted one at 30 is.
    assert.equal(nearestLootable(scatter(), 0, 0)?.id, -902);
  });

  it('falls to the next-nearest once that one is emptied', () => {
    const corpses = scatter();
    const first = nearestLootable(corpses, 0, 0);
    assert.ok(first);
    first.contents = [thing('rope', 2)];
    lootCorpse(first, emptyInventory());
    assert.equal(nearestLootable(corpses, 0, 0)?.id, -901, 'the far unlooted one, not the near empty one');
  });

  it('still names a body when every one of them is empty', () => {
    // So the caller can say "already picked clean" rather than "there is nothing here to loot" while a
    // corpse is plainly visible — two different problems, two different answers.
    const corpses = scatter();
    for (const corpse of corpses) corpse.looted = true;
    assert.equal(nearestLootable(corpses, 0, 0)?.id, -903, 'nearest of the empties');
  });

  it('has nothing to say about an empty floor', () => {
    assert.equal(nearestLootable([], 0, 0), undefined);
  });
});
