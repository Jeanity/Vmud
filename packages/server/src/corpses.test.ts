/**
 * Corpses: what a death leaves, how long it lasts, and the sprite that says it has been robbed.
 *
 * The sprite test is the one the owner asked for by name — a picked-clean corpse must *look* different
 * from an untouched one, so a corridor of corpses can be read from across the room without walking over
 * to each of them.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { boundsOf, makeRng, noPursuit, passiveRule, readCombatStats, type MobTemplate, type Room, type Zone } from '@mygame/shared';

import {
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
  type Graveyard,
} from './corpses.ts';
import { Simulation } from './sim.ts';
import { GameWorld } from './world.ts';

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
};

function fixture() {
  const sim = new Simulation(new GameWorld([graveZone()], { zone: 300, room: 3000 }));
  const player = sim.spawn('Mourner');
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
  it('is a pile of bones until somebody goes through it, then a single bone', () => {
    // The owner's rule: a picked-clean corpse must look picked clean, so "has anyone been here" is
    // answerable from across the room.
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    assert.equal(corpseSprite(corpse), 'corpse');
    assert.equal(lootCorpse(corpse), true);
    assert.equal(corpseSprite(corpse), 'corpse_looted');
  });

  it('reports nothing changed on a second search', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    lootCorpse(corpse);
    assert.equal(lootCorpse(corpse), false, 'so the caller can say "already picked clean"');
  });

  it('carries the new sprite on the view', () => {
    const f = fixture();
    assert.ok(f.mob);
    const corpse = makeCorpse(f.yard, f.mob, false);
    lootCorpse(corpse);
    assert.equal(corpseViewOf(corpse).sprite, 'corpse_looted');
  });
});

describe('who may loot what', () => {
  it('lets anybody go through a mob', () => {
    const f = fixture();
    assert.ok(f.mob);
    assert.equal(lootRefusal(makeCorpse(f.yard, f.mob, false), f.player), undefined);
  });

  it('keeps a player\'s corpse theirs', () => {
    // The least surprising rule, and it makes retrieval a race against decay rather than against other
    // players. Full player looting is a PvP decision that belongs with consent in Phase 21.
    const f = fixture();
    const corpse = makeCorpse(f.yard, f.player, true);
    const other = f.sim.spawn('Stranger');
    assert.equal(lootRefusal(corpse, other), 'someone-elses');
    assert.equal(lootRefusal(corpse, f.player), undefined, 'but their own is fine');
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
