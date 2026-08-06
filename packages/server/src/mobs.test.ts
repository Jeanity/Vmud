/**
 * Mobs, and the actor generalisation underneath them.
 *
 * The mob itself is barely worth testing — it stands still. What is worth testing is the *claim* Phase 7
 * makes: that a mob is not a second kind of thing. So most of what follows asserts that a pass over the
 * world does not care which kind it is walking, and that the handful of places which genuinely do care —
 * a socket to send down, a route to walk, a lit set of one's own — are the only ones.
 *
 * The visibility test is the phase's completion condition and it is the one to read first: a mob is
 * hidden by unlit ground and revealed by light through the code that was already doing it for players.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROOM_TILES,
  TILE_SIZE,
  boundsOf,
  makeRng,
  noPursuit,
  readCombatStats,
  passiveRule,
  newAffect,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';
import { LIGHT_SOURCES } from '@mygame/shared/light.ts';
import { DEFAULT_LIGHT_RADIUS, computeVisible } from '@mygame/shared/vision.ts';

import { Simulation, isMob, isPlayer, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/** Two rooms side by side, which is all a test about who-can-see-whom needs. */
function testZone(): Zone {
  const rooms: Room[] = [
    // **Both `dark`, and that is now a statement rather than a default.** Natural room light (2026-08-06)
    // makes an unflagged room light itself, which is right for 95% of the harvested world and wrong for a
    // fixture whose subject is *what a carried light reveals* — three of the tests below are about a mob
    // being unlit at range. Marking them dark is what they always meant.
    { id: 8000, zone: 800, name: 'The Watch Post', sector: 'hills', flags: ['dark'], pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 8001 } } },
    { id: 8001, zone: 800, name: 'The Next One Over', sector: 'hills', flags: ['dark'], pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 8000 } } },
  ];
  return { id: 800, name: 'Test Watch', rooms, bounds: boundsOf(rooms), entryRoom: 8000 };
}

const template = (over: Partial<MobTemplate> = {}): MobTemplate => ({
  vnum: 97018,
  keywords: ['sentry', 'guard'],
  name: 'a sentry',
  room: 'A sentry stands watch here.',
  level: 3,
  // Fixed rather than a range, so every assertion about hit points below is exact. The *rolling* is
  // tested on its own; everything else wants a body of a known size.
  hp: '1d1+23',
  sprite: 'sentry',
  // Passive by default: most of a castle is, and a test about placement should not accidentally be a test
  // about aggression. `perception.test.ts` is where dispositions are exercised.
  aggro: passiveRule(3),
  // Nailed to its floor by default, for the same reason: a placement test should not accidentally become
  // a chase. `hunt.test.ts` is where pursuit is exercised.
  pursuit: noPursuit(),
  combat: readCombatStats({ level: 3, armour: 0, damage: '1d4+0' }),
  experience: 300,
  // Never breaks off: these fixtures are about pointers, corpses and pathing, not morale.
  wimpyAt: 0,
  ...over,
});

/** A seeded stream, so a test that spawns twice gets the same world twice. */
const rng = () => makeRng(0xc0ffee);

/** Spawn helper: the template API takes the room and the stream explicitly. */
const place = (sim: Simulation, over: Partial<MobTemplate> = {}, room = 8000) =>
  sim.spawnMob(template(over), room, rng());

function makeSim(): { sim: Simulation; player: Player; world: GameWorld } {
  const world = new GameWorld([testZone()], { zone: 800, room: 8000 });
  const sim = new Simulation(world);
  return { sim, player: sim.spawn('Watcher', makeRng(1)), world };
}

const source = (id: string) => {
  const found = LIGHT_SOURCES[id];
  assert.ok(found, `the catalogue has no ${id}`);
  return found;
};

/* -------------------------------------------------------------------------- */

describe('spawning from a template', () => {
  it('stands one instance in the room it was told', () => {
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    assert.equal(mob.roomId, 8000);
    assert.deepEqual(mob.place, { zone: 800, level: 0 });
    assert.equal(mob.vnum, 97018);
    assert.equal(mob.name, 'a sentry');
    assert.equal(mob.sprite, 'sentry');
    assert.equal(mob.level, 3);
    // Somewhere on the room's own floor, which is `ROOM_TILES` square from the block's origin. Room 8000
    // is the first block, so its origin is 0,0.
    assert.ok(mob.x > 0 && mob.x < ROOM_TILES * TILE_SIZE, `x ${mob.x}`);
    assert.ok(mob.y > 0 && mob.y < ROOM_TILES * TILE_SIZE, `y ${mob.y}`);
  });

  it('rolls hit points per instance rather than fixing them', () => {
    // Duris rolls `dice(n, size) + bonus` at spawn, so two guards of one vnum are not equally tough. A
    // wide die makes the difference certain rather than probable.
    const { sim } = makeSim();
    const stream = makeRng(7);
    const rolled = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const mob = sim.spawnMob(template({ hp: '10d20+5' }), 8000, stream);
      assert.ok(mob);
      rolled.add(mob.maxHp);
      assert.equal(mob.hp, mob.maxHp, 'a fresh mob is unhurt');
    }
    assert.ok(rolled.size > 1, `every roll came out the same: ${[...rolled]}`);
    for (const hp of rolled) assert.ok(hp >= 15 && hp <= 205, `${hp} outside 10d20+5`);
  });

  it('is reproducible from the seed, which is what makes a restart the same world', () => {
    // `CLAUDE.md` rule 3. Two runs of the same stream must place the same mob with the same hit points.
    const first = makeSim();
    const second = makeSim();
    const a = first.sim.spawnMob(template({ hp: '5d10+1' }), 8000, makeRng(42));
    const b = second.sim.spawnMob(template({ hp: '5d10+1' }), 8000, makeRng(42));
    assert.ok(a && b);
    assert.deepEqual({ x: a.x, y: a.y, hp: a.maxHp }, { x: b.x, y: b.y, hp: b.maxHp });
  });

  it('never gives a mob nothing to lose', () => {
    // An hp expression the harvest let through unparseable would otherwise be NaN hit points, which reads
    // as a health bar that never moves.
    const { sim } = makeSim();
    const mob = place(sim, { hp: 'not dice' });
    assert.ok(mob);
    assert.equal(mob.maxHp, 1);
  });

  it('answers nothing for a room no loaded grid holds', () => {
    // A reset command for a zone this server is not loading is a configuration that has moved on, not a
    // broken build — so it is an `undefined` the caller counts, never a throw at boot.
    const { sim } = makeSim();
    assert.equal(place(sim, {}, 4242), undefined);
  });

  it('gives it a body and nothing more', () => {
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    assert.equal(mob.posture, 'standing');
    assert.equal(mob.status, 'normal');
    assert.equal(mob.lightRadius, DEFAULT_LIGHT_RADIUS);
    assert.deepEqual(mob.affects, []);
    // No movement pool: nothing moves a mob yet, and a full bar it never spends would be a number implying
    // a mechanic that does not exist.
    assert.equal(mob.maxMove, 0);
  });

  it('counts instances by vnum, world-wide', () => {
    // World-wide is load-bearing: a mob lured three zones away still counts against its limit, which is
    // what makes luring cost something instead of farming a room.
    const { sim } = makeSim();
    assert.equal(sim.countOf(97018), 0);
    place(sim);
    place(sim);
    place(sim, {}, 8001);
    assert.equal(sim.countOf(97018), 3, 'the one in the next room counts too');
    assert.equal(sim.countOf(99999), 0);
  });

  it('takes ids from the same counter as players, so nothing downstream can tell the maps apart', () => {
    const { sim, player } = makeSim();
    const a = place(sim);
    const b = place(sim);
    assert.ok(a && b);
    const ids = [player.id, a.id, b.id];
    assert.equal(new Set(ids).size, 3, `ids collided: ${ids.join(',')}`);
  });
});

describe('one world, both kinds', () => {
  it('lists mobs and players through the same room lookup', () => {
    const { sim, player } = makeSim();
    const mob = place(sim);
    assert.ok(mob);

    // Presence is every body...
    assert.deepEqual(
      sim.actorsIn(8000).map((a) => a.id).sort((x, y) => x - y),
      [player.id, mob.id].sort((x, y) => x - y),
    );
    // ...and recipients are only the ones with a socket. Both are real, and merging them would either
    // post log lines to things that cannot read or hide mobs from the room view.
    assert.deepEqual(sim.playersIn(8000).map((a) => a.id), [player.id]);
    assert.deepEqual(sim.actorsIn(8001), []);
  });

  it('narrows by id without the caller knowing which map to ask', () => {
    const { sim, player } = makeSim();
    const mob = place(sim);
    assert.ok(mob);

    assert.equal(sim.get(mob.id)?.kind, 'mob');
    assert.equal(sim.get(player.id)?.kind, 'player');
    // `player()` is what the socket handlers use: a message naming a mob's id must not be honoured as
    // if it named the sender.
    assert.equal(sim.player(mob.id), undefined);
    assert.equal(sim.player(player.id)?.id, player.id);
    assert.ok(isMob(sim.get(mob.id)!));
    assert.ok(isPlayer(sim.get(player.id)!));
  });

  it('describes a mob through the very function that describes a player', () => {
    // No branch on `kind` in `viewOf` beyond passing it along — which is the return on the split. A mob
    // is named, health-barred and posture-described by code that already did it, so the two cannot come
    // to disagree about what a body looks like.
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    const view = sim.viewOf(mob);
    assert.equal(view.kind, 'mob');
    assert.equal(view.name, 'a sentry');
    assert.equal(view.sprite, 'sentry');
    assert.equal(view.level, 3);
    assert.equal(view.healthFraction, 1);
    assert.equal(view.posture, 'standing');
  });

  it('runs a mob through the affect system, expiry and all', () => {
    // Phase 5b promised one list and one expiry pass for everything temporary. A mob is the first thing
    // to test that promise against something that is not a player.
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);

    sim.addAffect(mob, newAffect({ type: 'second_wind', durationMs: 300, apply: 'hpRegen', modifier: 4 }));
    assert.equal(sim.affectsOf(mob, 'second_wind').length, 1);

    const events = [sim.tick(), sim.tick(), sim.tick()].flatMap((r) => r.affectEvents);
    const expired = events.filter((e) => e.kind === 'expired' && e.actor.id === mob.id);
    assert.equal(expired.length, 1, 'a mob’s affects lapse through the same pass');
    assert.deepEqual(mob.affects, []);
  });

  it('gives a mob a light through the same derivation as a player', () => {
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    sim.setCarriedLight(mob, source('torch'));
    assert.equal(mob.light?.id, 'torch');
    assert.equal(mob.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
  });

  it('does not walk a mob in the movement pass, because it has no intent to walk on', () => {
    const { sim } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    const before = { x: mob.x, y: mob.y };
    for (let i = 0; i < 20; i++) sim.tick();
    assert.deepEqual({ x: mob.x, y: mob.y }, before, 'motionless is what a Phase 7 mob is');
  });
});

/**
 * The completion test.
 *
 * `visibleEntities` in `index.ts` is the authority and is not reachable from here, but the rule it
 * applies is: same room, and the subject standing on a tile the observer has light on. Both halves are
 * asserted directly against the same `computeVisible` the server calls.
 */
describe('a mob is hidden by the dark, through the gate players already use', () => {
  /** The rule `canSee` applies, in the one line it is. */
  const litOn = (player: Player, x: number, y: number, world: GameWorld): boolean => {
    const grid = world.grid(player.place);
    assert.ok(grid);
    const tx = Math.floor(x / TILE_SIZE);
    const ty = Math.floor(y / TILE_SIZE);
    return player.visible.has(ty * grid.width + tx);
  };

  /**
   * Stands a mob on a chosen tile of its room.
   *
   * The spawn rolls its own tile, which is right for population and useless for a test about sight — so
   * these tests place it by hand. Moving a mob is not a mechanic the game has, but the sim is the test's
   * own and the alternative is a geometry assertion that depends on a die roll.
   */
  const standAt = (mob: { x: number; y: number }, dx: number, dy: number): void => {
    mob.x = dx * TILE_SIZE + TILE_SIZE / 2;
    mob.y = dy * TILE_SIZE + TILE_SIZE / 2;
  };

  it('is unlit from the room centre at the bare radius, and lit once you close on it', () => {
    const { sim, player, world } = makeSim();
    // Spawn puts the player at the room centre; the sentry stands in the corner on purpose.
    const mob = place(sim);
    assert.ok(mob);
    standAt(mob, 7, 1);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);

    sim.refreshVisible(player);
    assert.equal(litOn(player, mob.x, mob.y, world), false, 'six tiles away at radius two: not seen');

    // Walk to within the bare radius. No light found, no torch — just closing the distance.
    player.x = mob.x - TILE_SIZE;
    player.y = mob.y;
    sim.refreshVisible(player);
    assert.equal(litOn(player, mob.x, mob.y, world), true, 'a tile away: seen');
  });

  it('is revealed by finding a light rather than by moving', () => {
    // The other half of the same rule, and the one that makes light a progression axis: standing still
    // and picking up a torch is enough.
    const { sim, player, world } = makeSim();
    const mob = place(sim);
    assert.ok(mob);
    standAt(mob, 4, 1);

    // Stand three tiles from it — outside the bare radius of two, inside a torch's three.
    player.x = mob.x;
    player.y = mob.y + 3 * TILE_SIZE;
    sim.refreshVisible(player);
    assert.equal(litOn(player, mob.x, mob.y, world), false, 'three tiles at radius two: not seen');

    sim.setCarriedLight(player, source('torch'));
    sim.refreshVisible(player);
    assert.equal(litOn(player, mob.x, mob.y, world), true, 'the torch reaches it');
  });

  it('is never visible from another room, however bright the light', () => {
    // Room scope is the cheaper gate and the one that holds across Places. A beacon lights whole rooms,
    // so this is the case where only the room check stops it.
    const { sim, player } = makeSim();
    const mob = place(sim, {}, 8001);
    assert.ok(mob);
    sim.setCarriedLight(player, source('beacon_of_hope'));
    sim.refreshVisible(player);

    // The tile may well be lit — a beacon reaches the next room — but the mob is not in this room, and
    // `canSee` refuses on that before it ever consults the light.
    assert.notEqual(player.roomId, mob.roomId);
    assert.deepEqual(sim.actorsIn(player.roomId).map((a) => a.id), [player.id]);
  });

  it('computes the same lit set the gate reads, so this test cannot pass while the game fails', () => {
    // Guards the test rather than the code: if `refreshVisible` stopped filling `visible`, every
    // assertion above would pass vacuously on an empty set.
    const { sim, player, world } = makeSim();
    sim.refreshVisible(player);
    const grid = world.grid(player.place);
    assert.ok(grid);
    const direct = computeVisible(
      grid,
      Math.floor(player.x / TILE_SIZE),
      Math.floor(player.y / TILE_SIZE),
      player.lightRadius,
    );
    assert.equal(player.visible.size, direct.size);
    assert.ok(player.visible.size > 0);
  });
});
