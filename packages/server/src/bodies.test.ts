/**
 * Solid bodies, where the simulation actually uses them.
 *
 * `shared/bodies.test.ts` proves the rules. This proves the **wiring**, and the wiring is the half that
 * rots: four separate passes move a body a fraction of a tile at a time, and the failure mode is not a
 * wrong answer but a pass that quietly kept its old one. So every mover gets a case that puts a body in
 * its way and watches it refuse, and there is a case whose only job is to notice a fifth mover being
 * added.
 *
 * The other half is placement. The owner reported both halves on 2026-08-13 — *"never have mobs or
 * players load on top of each other"*, and a screenshot of a kobold youth inside a scenery block in
 * room 41260 — and the sweep at the bottom of this file is the one that answers for the world as
 * shipped rather than for a fixture.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  BODY_SEPARATION,
  ROOM_TILES,
  TILE_SIZE,
  Tile,
  bodySolidAt,
  boundsOf,
  canStand,
  isWalkableAt,
  makeRng,
  noPursuit,
  parseDice,
  passiveRule,
  readCombatStats,
  rollDice,
  roomAtTile,
  setTile,
  tileCentre,
  type MobTemplate,
  type Room,
  type RoomId,
  type TileGrid,
  type Zone,
  type ZoneSpawns,
} from '@mygame/shared';

import { engage } from './combat.ts';
import { advanceHunts, beginDrift, beginWalkTo, type Hunt } from './hunt.ts';
import { Scheduler } from './scheduler.ts';
import { Simulation, type Actor, type Mob, type Player } from './sim.ts';
import { SPAWNS_DIR, indexTemplates, loadZoneSpawns } from './spawns.ts';
import { MELEE_STATION, advanceStations, atStation } from './station.ts';
import { GameWorld, builtZoneFileExists, loadZone, placeOf } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Fixture                                                                     */
/* -------------------------------------------------------------------------- */

const ZONE = 770;
const HALL = 77_000;
const ANTE = 77_001;

/** Two indoor rooms with a gate between them — the geometry everything in this file happens in. */
function hall(): Zone {
  const rooms: Room[] = [
    { id: HALL, zone: ZONE, name: 'The Long Hall', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: ANTE } } },
    { id: ANTE, zone: ZONE, name: 'The Anteroom', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: HALL } } },
  ];
  return { id: ZONE, name: 'Test Hall', rooms, bounds: boundsOf(rooms), entryRoom: HALL };
}

const template = (over: Partial<MobTemplate> = {}): MobTemplate => ({
  vnum: 770_01,
  keywords: ['brute'],
  name: 'a brute',
  room: 'A brute stands here.',
  level: 20,
  hp: '1d1+999',
  sprite: 'human',
  aggro: passiveRule(20),
  pursuit: noPursuit(),
  wimpyAt: 0,
  experience: 100,
  combat: readCombatStats({ level: 20, armour: 0, damage: '1d4+0' }),
  ...over,
});

interface Fixture {
  readonly world: GameWorld;
  readonly sim: Simulation;
  readonly grid: TileGrid;
  readonly player: Player;
  readonly origin: { readonly tx: number; readonly ty: number };
}

function makeFixture(): Fixture {
  const world = new GameWorld([hall()], { zone: ZONE, room: HALL });
  const sim = new Simulation(world);
  const player = sim.spawn('Walker', makeRng(1));
  const grid = world.grid(player.place);
  assert.ok(grid);
  const origin = grid.roomOrigins.get(HALL);
  assert.ok(origin);
  return { world, sim, grid, player, origin };
}

/** A mob standing exactly on a tile centre, wherever the test wants it. */
function mobAt(sim: Simulation, tx: number, ty: number, roomId: RoomId = HALL): Mob {
  const mob = sim.spawnMob(template(), roomId, makeRng(0xb0));
  assert.ok(mob);
  mob.x = tileCentre(tx);
  mob.y = tileCentre(ty);
  return mob;
}

/** How far apart two bodies are. The one number this whole file is about. */
function gap(a: Actor, b: Actor): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/* -------------------------------------------------------------------------- */
/* Every mover goes through the funnel                                         */
/* -------------------------------------------------------------------------- */

describe('every pass that moves a body asks the same question', () => {
  /**
   * **The guard against a fifth mover.** Body collision lives behind `Simulation.stepActor`, and a
   * pass that called `stepMovement` directly would walk straight through people while every other test
   * in this file stayed green. There is exactly one legitimate direct caller left in the server — none
   * — so the count is zero and any new one has to come and change this number on purpose.
   */
  it('leaves no direct caller of stepMovement anywhere in the server', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const offenders: string[] = [];
    for (const file of readdirSync(here)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const body = readFileSync(join(here, file), 'utf8');
      for (const [n, line] of body.split(/\r?\n/).entries()) {
        // The call, not the several comments that name it.
        if (/(?<![\w.])stepMovement\s*\(/.test(line)) offenders.push(`${file}:${n + 1}`);
      }
    }
    assert.deepEqual(offenders, [], 'these bypass Simulation.stepActor and so bypass solid bodies');
  });

  /**
   * The other half of the same guard, and the one that catches a mover written without `stepMovement`
   * at all. Only five lines in the server may write a body's coordinates: the four continuous movers,
   * each of which now takes its answer from `stepActor`, and `relocate`, which takes its answer from
   * the placement helper. A sixth would be a body moving with no rule attached.
   */
  it('leaves exactly five places that write a body’s position', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const writers: string[] = [];
    for (const file of readdirSync(here)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      for (const [n, line] of readFileSync(join(here, file), 'utf8').split(/\r?\n/).entries()) {
        // `<something>.x = ` on a body. Items, corpses and ground drops carry coordinates too, and
        // they are not bodies — none of them is solid, so none of them is this file's business.
        const match = /^\s*(\w+)\.x = /.exec(line);
        if (!match) continue;
        if (/corpse|item|drop|ground/i.test(match[1] ?? '')) continue;
        writers.push(file);
        void n;
      }
    }
    // Counted per file rather than pinned to line numbers, which would turn every unrelated edit above
    // one of them into a failing test. `hunt.ts` twice — the drift and the room-to-room walk; `sim.ts`
    // twice — the player walk and `relocate`; `station.ts` once.
    const perFile = new Map<string, number>();
    for (const file of writers) perFile.set(file, (perFile.get(file) ?? 0) + 1);
    assert.deepEqual(
      [...perFile].sort(),
      [['hunt.ts', 2], ['sim.ts', 2], ['station.ts', 1]],
      'a body is being moved somewhere that goes through neither stepActor nor the placement helper',
    );
  });

  it('refuses the player walk — the pass in Simulation.tick', () => {
    const { sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 2);
    player.y = tileCentre(midY);
    const wall = mobAt(sim, origin.tx + 4, midY);

    sim.setIntent(player.id, 1, 0);
    for (let n = 0; n < 40; n++) sim.tick();
    assert.ok(gap(player, wall) >= BODY_SEPARATION - 1e-6, `walked into it (gap ${gap(player, wall)})`);
  });

  it('refuses the hunt’s in-room drift', () => {
    const { world, sim, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const walker = mobAt(sim, origin.tx + 1, midY);
    const standing = mobAt(sim, origin.tx + 4, midY);

    const hunts = new Map<number, Hunt>();
    beginDrift(hunts, walker, { x: tileCentre(origin.tx + 7), y: tileCentre(midY) });
    for (let n = 0; n < 200 && hunts.size > 0; n++) advanceHunts(sim, world, hunts, 100);
    assert.ok(gap(walker, standing) >= BODY_SEPARATION - 1e-6, `drifted through it (gap ${gap(walker, standing)})`);
  });

  it('refuses the hunt’s room-to-room walk', () => {
    const { world, sim, grid, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const walker = mobAt(sim, origin.tx + 1, midY);
    // Two abreast, off the mouth so the exemption does not apply: a wall inside the room.
    const north = mobAt(sim, origin.tx + 4, midY - 1);
    const south = mobAt(sim, origin.tx + 4, midY);
    assert.equal(bodySolidAt(grid, south.x, south.y), true, 'the fixture must be solid ground');

    const hunts = new Map<number, Hunt>();
    beginWalkTo(hunts, walker, ANTE);
    for (let n = 0; n < 200 && hunts.size > 0; n++) advanceHunts(sim, world, hunts, 100);
    assert.ok(gap(walker, north) >= BODY_SEPARATION - 1e-6, 'walked through the northern one');
    assert.ok(gap(walker, south) >= BODY_SEPARATION - 1e-6, 'walked through the southern one');
  });

  it('stops being solid the moment it stops being a body — corpses are furniture', () => {
    // Only *living* bodies are solid. A corpse is an item in the ground store and a mob is an entry in
    // the actor map, and `bodiesNear` reads the actor map — so a kill is the same event as ceasing to
    // block, with no separate rule to keep in step. Walking over the exact tile where it fell is the
    // only honest way to say that, since there is no "corpse" for collision to consult.
    const { sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 2);
    player.y = tileCentre(midY);
    const victim = mobAt(sim, origin.tx + 4, midY);
    const fell = { x: victim.x, y: victim.y };

    /** How close the player ever got to that spot while walking due east across it. */
    const closestPass = (): number => {
      player.x = tileCentre(origin.tx + 2);
      player.y = tileCentre(midY);
      sim.setIntent(player.id, 1, 0);
      let closest = Infinity;
      for (let n = 0; n < 30; n++) {
        sim.tick();
        closest = Math.min(closest, Math.hypot(player.x - fell.x, player.y - fell.y));
      }
      return closest;
    };

    assert.ok(closestPass() >= BODY_SEPARATION - 1e-6, 'the fixture should have the body in the way');
    sim.remove(victim.id);
    assert.ok(closestPass() < BODY_SEPARATION, 'the ground where it died is still refusing to be crossed');
  });

  it('refuses a fighter closing to station', () => {
    const { world, sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 7);
    player.y = tileCentre(midY);
    const closer = mobAt(sim, origin.tx + 1, midY);
    const inTheWay = mobAt(sim, origin.tx + 4, midY);

    engage(new Scheduler(), closer, player);
    for (let n = 0; n < 60; n++) advanceStations(sim, world, 100);
    assert.ok(gap(closer, inTheWay) >= BODY_SEPARATION - 1e-6, `shouldered through (gap ${gap(closer, inTheWay)})`);
  });
});

/* -------------------------------------------------------------------------- */
/* Combat must still reach                                                     */
/* -------------------------------------------------------------------------- */

describe('MELEE_STATION and BODY_SEPARATION reconcile', () => {
  it('states the two numbers, because a fighter that cannot arrive jitters for ever', () => {
    // If the separation ever grew past a tile, a mob would be refused *before* reaching station and
    // would grind against its opponent while the round timer fired. 32 against 20 leaves 12px, which is
    // the same 12px `MELEE_STATION`'s own docblock has always claimed.
    assert.equal(MELEE_STATION, TILE_SIZE);
    assert.equal(BODY_SEPARATION, 20);
    assert.ok(BODY_SEPARATION < MELEE_STATION, 'a fighter could never reach its station');
  });

  it('arrives at station across an empty floor, and stops there rather than jittering', () => {
    const { world, sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 6);
    player.y = tileCentre(midY);
    const mob = mobAt(sim, origin.tx + 1, midY);
    engage(new Scheduler(), mob, player);

    for (let n = 0; n < 40; n++) advanceStations(sim, world, 100);
    assert.equal(atStation(mob, player), true, `never arrived (gap ${gap(mob, player)})`);

    // And holds still once there: a body that kept being nudged would stream `entityMoved` for ever.
    const settled = { x: mob.x, y: mob.y };
    for (let n = 0; n < 20; n++) advanceStations(sim, world, 100);
    assert.deepEqual({ x: mob.x, y: mob.y }, settled);
  });

  it('lets a second and third mob reach station on the same target', () => {
    // Bodies at 32px from one centre need 36.4° between them to keep 20px apart, so a ring of nine
    // fits. Three is the case that actually happens, and it is the one that would have exposed a
    // separation tuned too large.
    const { world, sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 4);
    player.y = tileCentre(midY);
    const scheduler = new Scheduler();
    const pack = [
      mobAt(sim, origin.tx + 1, midY),
      mobAt(sim, origin.tx + 7, midY),
      mobAt(sim, origin.tx + 4, midY + 3),
    ];
    for (const mob of pack) engage(scheduler, mob, player);

    for (let n = 0; n < 60; n++) advanceStations(sim, world, 100);
    for (const mob of pack) {
      assert.ok(gap(mob, player) <= MELEE_STATION + 4, `${mob.id} stood off at ${gap(mob, player)}`);
    }
    for (const a of pack) {
      for (const b of pack) {
        if (a.id === b.id) continue;
        assert.ok(gap(a, b) >= BODY_SEPARATION - 1e-6, 'two of the pack ended up inside each other');
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Click-to-move                                                               */
/* -------------------------------------------------------------------------- */

describe('a route past a standing mob', () => {
  it('slides around it and arrives, rather than stalling into “stuck”', () => {
    // The planner works over the tilemap and cannot see a body standing on the route, so without the
    // deflection in `stepBody` the walker would grind and `STUCK_TICKS` would end an honest walk within
    // half a second. Constraint 3 of the brief, and the one a player would meet first.
    const { sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 1);
    player.y = tileCentre(midY);
    mobAt(sim, origin.tx + 4, midY);

    const goal = { tx: origin.tx + 7, ty: midY };
    sim.setPath(player, [goal]);

    let ended: { reason: string } | undefined;
    for (let n = 0; n < 200 && !ended; n++) ended = sim.tick().pathsEnded[0];
    assert.ok(ended, 'the route never finished at all');
    assert.equal(ended.reason, 'arrived', 'the mob in the way turned a walk into a stall');
    assert.ok(Math.hypot(player.x - tileCentre(goal.tx), player.y - tileCentre(goal.ty)) <= TILE_SIZE);
  });
});

/* -------------------------------------------------------------------------- */
/* Placement                                                                   */
/* -------------------------------------------------------------------------- */

describe('nothing loads on top of anything', () => {
  it('gives every mob in a room a tile of its own', () => {
    const { sim } = makeFixture();
    const rng = makeRng(99);
    const mobs: Mob[] = [];
    for (let n = 0; n < 12; n++) {
      const mob = sim.spawnMob(template(), HALL, rng);
      assert.ok(mob);
      mobs.push(mob);
    }
    for (const a of mobs) {
      for (const b of mobs) {
        if (a.id === b.id) continue;
        assert.ok(gap(a, b) >= BODY_SEPARATION, `${a.id} and ${b.id} loaded on top of each other`);
      }
    }
    assert.equal(sim.crowding.stacked, 0);
    assert.equal(sim.crowding.blocked, 0);
  });

  it('never loads one inside a prop — the kobold in the rock', () => {
    const { sim, grid, origin } = makeFixture();
    // Floor the room over except for one tile, so a uniform roll almost certainly lands in scenery.
    const free = { tx: origin.tx + 6, ty: origin.ty + 2 };
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        const tx = origin.tx + dx;
        const ty = origin.ty + dy;
        if (tx === free.tx && ty === free.ty) continue;
        setTile(grid, tx, ty, Tile.Prop);
      }
    }
    const mob = sim.spawnMob(template(), HALL, makeRng(4));
    assert.ok(mob);
    assert.equal(isWalkableAt(grid, mob.x, mob.y), true, 'spawned inside the scenery');
    assert.deepEqual({ tx: Math.floor(mob.x / TILE_SIZE), ty: Math.floor(mob.y / TILE_SIZE) }, free);
  });

  it('shares a tile rather than losing a mob when the den is full, and counts it', () => {
    // The Cubs Den rule. A missing mob is worse than an overlap, so the degradation is deliberate —
    // and it is reported, because a policy nobody can see is indistinguishable from a bug.
    const { sim, grid } = makeFixture();
    const rng = makeRng(7);
    const spawned: Mob[] = [];
    for (let n = 0; n < ROOM_TILES * ROOM_TILES + 5; n++) {
      const mob = sim.spawnMob(template(), HALL, rng);
      assert.ok(mob, `mob ${n} was refused, which is the one outcome that is not allowed`);
      spawned.push(mob);
    }
    assert.equal(spawned.length, ROOM_TILES * ROOM_TILES + 5);
    assert.ok(sim.crowding.stacked >= 5, `expected the overflow to be counted, got ${sim.crowding.stacked}`);
    assert.equal(sim.crowding.blocked, 0, 'every one of them still landed on floor');
    for (const mob of spawned) {
      assert.equal(roomAtTile(grid, Math.floor(mob.x / TILE_SIZE), Math.floor(mob.y / TILE_SIZE)), HALL);
    }
  });

  it('spreads arrivals through the same gate, and keeps them out of the scenery', () => {
    const { sim, grid, origin } = makeFixture();
    // A prop on the tile the id spread would otherwise choose for the first arrival.
    const arrivals: Actor[] = [];
    for (let n = 0; n < 6; n++) {
      const mob = sim.spawnMob(template(), ANTE, makeRng(50 + n));
      assert.ok(mob);
      arrivals.push(mob);
    }
    setTile(grid, origin.tx + 1, origin.ty + 4, Tile.Prop);

    for (const actor of arrivals) sim.relocate(actor, HALL, 'east');
    for (const actor of arrivals) {
      assert.equal(actor.roomId, HALL);
      assert.equal(canStand(grid, actor.x, actor.y), true, 'arrived inside geometry');
      for (const other of arrivals) {
        if (other.id === actor.id) continue;
        assert.ok(gap(actor, other) >= BODY_SEPARATION, 'two arrivals stacked');
      }
    }
  });

  it('keeps two characters logging in off each other’s tile', () => {
    const { sim, player } = makeFixture();
    const second = sim.spawn('Second', makeRng(2));
    assert.ok(gap(player, second) >= BODY_SEPARATION, 'the second login landed on the first');
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep, over the world as shipped                                        */
/* -------------------------------------------------------------------------- */

/**
 * Skipped when `data/world` has not been generated — it is git-ignored and reproducible via
 * `npm run worldgen`, the same gate `nearby.test.ts` and `appearance.test.ts` use.
 */
const HAVE_SPAWNS = existsSync(SPAWNS_DIR) && readdirSync(SPAWNS_DIR).some((f) => f.endsWith('.json'));

/** Every harvested zone that also has a built tilemap to place bodies on. */
function shippedZones(): ZoneSpawns[] {
  const out: ZoneSpawns[] = [];
  for (const file of readdirSync(SPAWNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    const id = Number(file.replace(/\.json$/, ''));
    if (!Number.isFinite(id) || !builtZoneFileExists(id)) continue;
    const spawns = loadZoneSpawns(id);
    if (spawns) out.push(spawns);
  }
  return out;
}

describe('the shipped world, swept', { skip: HAVE_SPAWNS ? false : 'data/world/spawns not generated' }, () => {
  /**
   * Runs every `M` command of every harvested zone through the real `spawnMob`, and reports what the
   * floor looked like afterwards.
   *
   * The reset executor is deliberately *not* used: it enforces instance limits world-wide and would
   * quietly decline most of the population once the first zone had filled them, which is exactly the
   * commands this sweep needs to see. Every `M` is fired instead, which is the worst case a forced
   * repop can produce.
   */
  function sweep(): {
    placed: number;
    overlapping: number;
    unwalkable: number;
    wouldHaveBeenUnwalkable: number;
    wouldHaveOverlapped: number;
    worst: { room: RoomId; bodies: number; tiles: number };
    tightest: { room: RoomId; bodies: number; tiles: number };
  } {
    let placed = 0;
    let overlapping = 0;
    let unwalkable = 0;
    let wouldHaveBeenUnwalkable = 0;
    let wouldHaveOverlapped = 0;
    let worst = { room: -1 as RoomId, bodies: 0, tiles: ROOM_TILES * ROOM_TILES };
    let tightest = { room: -1 as RoomId, bodies: 0, tiles: ROOM_TILES * ROOM_TILES };

    for (const spawns of shippedZones()) {
      const zone = loadZone(spawns.zone);
      const world = new GameWorld([zone], { zone: spawns.zone, room: zone.rooms[0]?.id ?? null });
      const sim = new Simulation(world);
      const templates = indexTemplates([spawns]);
      // One stream per zone, seeded from the zone id, so the sweep is reproducible and independent of
      // the order `readdirSync` happens to return.
      const rng = makeRng(spawns.zone);
      /** What a *blind* roll would have produced, for the "before" number the owner asked for. */
      const naive = makeRng(spawns.zone);
      const byRoom = new Map<RoomId, { x: number; y: number }[]>();
      const naiveByRoom = new Map<RoomId, { tx: number; ty: number }[]>();

      for (const command of spawns.resets) {
        if (command.kind !== 'mob' || command.room === undefined) continue;
        const template = templates.get(command.what);
        if (!template) continue;
        const located = world.locate(command.room);
        if (!located) continue;
        const grid = world.grid(placeOf(located.room));
        const origin = grid?.roomOrigins.get(command.room);
        if (!grid || !origin) continue;

        const before = byRoom.get(command.room) ?? [];
        const mob = sim.spawnMob(template, command.room, rng);
        if (!mob) continue;
        placed++;

        // **The counterfactual, replayed exactly rather than estimated.** `naive` is a second stream
        // seeded identically and consumed in the same order the old `spawnMob` consumed it — the hit
        // point roll, then two uniform tile rolls used as they came — so these are the tiles the
        // shipped world was standing its mobs on before today, mob for mob and not on average.
        const dice = parseDice(template.hp);
        if (dice) rollDice(naive, dice);
        const nx = origin.tx + Math.floor(naive() * ROOM_TILES);
        const ny = origin.ty + Math.floor(naive() * ROOM_TILES);
        if (!canStand(grid, tileCentre(nx), tileCentre(ny))) wouldHaveBeenUnwalkable++;
        else if (naiveByRoom.get(command.room)?.some((b) => b.tx === nx && b.ty === ny)) {
          wouldHaveOverlapped++;
        }
        const naiveHere = naiveByRoom.get(command.room) ?? [];
        naiveHere.push({ tx: nx, ty: ny });
        naiveByRoom.set(command.room, naiveHere);

        if (!canStand(grid, mob.x, mob.y)) unwalkable++;
        if (before.some((b) => Math.hypot(b.x - mob.x, b.y - mob.y) < BODY_SEPARATION)) overlapping++;
        before.push({ x: mob.x, y: mob.y });
        byRoom.set(command.room, before);

        let standable = 0;
        for (let dy = 0; dy < ROOM_TILES; dy++) {
          for (let dx = 0; dx < ROOM_TILES; dx++) {
            if (canStand(grid, tileCentre(origin.tx + dx), tileCentre(origin.ty + dy))) standable++;
          }
        }
        if (before.length > worst.bodies) worst = { room: command.room, bodies: before.length, tiles: standable };
        // Separately: the room closest to running out of floor, which is a different room from the
        // one holding the most bodies whenever scenery is what made it tight.
        if (before.length / Math.max(1, standable) > tightest.bodies / Math.max(1, tightest.tiles)) {
          tightest = { room: command.room, bodies: before.length, tiles: standable };
        }
      }
    }
    return { placed, overlapping, unwalkable, wouldHaveBeenUnwalkable, wouldHaveOverlapped, worst, tightest };
  }

  const result = sweep();

  it('places a whole world’s worth of bodies, so the sweep is worth believing', () => {
    assert.ok(result.placed > 1000, `only ${result.placed} mobs were placed — the sweep is not seeing the world`);
  });

  it('puts none of them inside geometry, where the old roll put many', () => {
    // The number the owner asked for: how big the bug actually was. Reported rather than asserted
    // against a threshold, because the honest bound is zero on the left and "whatever the scatter table
    // grows" on the right.
    assert.equal(
      result.unwalkable,
      0,
      `${result.unwalkable} of ${result.placed} bodies stand in scenery or a wall`,
    );
    assert.ok(
      result.wouldHaveBeenUnwalkable > 0,
      'the counterfactual found nothing, so this sweep is not exercising the fix',
    );
    console.log(
      `      bodies placed: ${result.placed}; inside geometry before the fix: ${result.wouldHaveBeenUnwalkable} ` +
        `(${((result.wouldHaveBeenUnwalkable / result.placed) * 100).toFixed(1)}%), after: ${result.unwalkable}`,
    );
  });

  it('never puts two of them on one tile', () => {
    assert.equal(
      result.overlapping,
      0,
      `${result.overlapping} of ${result.placed} bodies share a tile with somebody already there`,
    );
    console.log(
      `      stacked before the fix: ${result.wouldHaveOverlapped} ` +
        `(${((result.wouldHaveOverlapped / result.placed) * 100).toFixed(1)}%), after: ${result.overlapping}`,
    );
  });

  it('reports the most crowded room against the floor it has to stand on', () => {
    // The headroom number. When `bodies` reaches `tiles` the placement helper starts stacking, which is
    // by design — but this is where anyone would look first to find out how close the world is to it.
    console.log(
      `      most bodies: room ${result.worst.room}, ${result.worst.bodies} on ${result.worst.tiles} standable tiles`,
    );
    console.log(
      `      tightest fit: room ${result.tightest.room}, ${result.tightest.bodies} on ${result.tightest.tiles} ` +
        `standable tiles (${((result.tightest.bodies / result.tightest.tiles) * 100).toFixed(0)}% full)`,
    );
    assert.ok(result.worst.bodies > 0);
    assert.ok(
      result.tightest.bodies <= result.tightest.tiles,
      `room ${result.tightest.room} wants ${result.tightest.bodies} bodies on ${result.tightest.tiles} tiles — over full`,
    );
  });
});
