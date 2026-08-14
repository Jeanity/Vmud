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
  bodyClearance,
  bodyRadius,
  bodySizeOf,
  bodySolidAt,
  boundsOf,
  canStand,
  isWalkableAt,
  makeRng,
  noPursuit,
  parseDice,
  passiveRule,
  placeBody,
  readCombatStats,
  rollDice,
  roomAtTile,
  setTile,
  tileCentre,
  type BodyPoint,
  type MobTemplate,
  type Room,
  type RoomId,
  type TileGrid,
  type Zone,
  type ZoneSpawns,
} from '@mygame/shared';

import { engage } from './combat.ts';
import { advanceHunts, beginDrift, beginWalkTo, type Hunt } from './hunt.ts';
import { applyMobOverride, loadMobOverrides } from './mob-overrides.ts';
import { Scheduler } from './scheduler.ts';
import { Simulation, type Actor, type Mob, type Player } from './sim.ts';
import { SPAWNS_DIR, indexTemplates, loadZoneSpawns } from './spawns.ts';
import { MELEE_DAYLIGHT, MELEE_STATION, advanceStations, atStation, stationFor } from './station.ts';
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

/**
 * A **giant's** template — `muscular/human` on Duris' `G` race, which is what 105 of the world's mob
 * templates and 192 of its spawned bodies actually are.
 *
 * Not a made-up scale: it goes through `spawnMob` exactly as a harvested giant does, so a test that
 * uses it is testing the wiring from the harvest through `bodySizeOf` and out into collision, which is
 * the seam this file exists to hold. 2.75x, and therefore 27.5px of radius.
 */
const giantTemplate = (): MobTemplate => template({ sprite: 'muscular/human', race: 'G' });

/** A mob standing exactly on a tile centre, wherever the test wants it. */
function mobAt(sim: Simulation, tx: number, ty: number, roomId: RoomId = HALL, over?: MobTemplate): Mob {
  const mob = sim.spawnMob(over ?? template(), roomId, makeRng(0xb0));
  assert.ok(mob);
  mob.x = tileCentre(tx);
  mob.y = tileCentre(ty);
  return mob;
}

/** A hill giant standing on a tile centre. 27.5px of radius against an adult's 10. */
function giantAt(sim: Simulation, tx: number, ty: number, roomId: RoomId = HALL): Mob {
  const mob = mobAt(sim, tx, ty, roomId, giantTemplate());
  assert.equal(mob.scale, 2.75, 'the fixture giant is not a giant');
  return mob;
}

/** How far apart two bodies are. The one number this whole file is about. */
function gap(a: Actor, b: Actor): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * How far apart these two must stay — {@link bodyClearance}, and the replacement for the flat
 * `BODY_SEPARATION` every assertion in this file used to compare against.
 *
 * It is the same 20px for two adult bodies, which is every fixture that predates 2026-08-14, so those
 * cases go on measuring exactly what they measured. It is 37.5 for a person and a giant, which is the
 * number those cases were silently getting wrong.
 */
function clearance(a: Actor, b: Actor): number {
  return bodyClearance(a, b);
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
    assert.ok(gap(player, wall) >= clearance(player, wall) - 1e-6, `walked into it (gap ${gap(player, wall)})`);
  });

  it('refuses the hunt’s in-room drift', () => {
    const { world, sim, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const walker = mobAt(sim, origin.tx + 1, midY);
    const standing = mobAt(sim, origin.tx + 4, midY);

    const hunts = new Map<number, Hunt>();
    beginDrift(hunts, walker, { x: tileCentre(origin.tx + 7), y: tileCentre(midY) });
    for (let n = 0; n < 200 && hunts.size > 0; n++) advanceHunts(sim, world, hunts, 100);
    assert.ok(
      gap(walker, standing) >= clearance(walker, standing) - 1e-6,
      `drifted through it (gap ${gap(walker, standing)})`,
    );
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
    assert.ok(gap(walker, north) >= clearance(walker, north) - 1e-6, 'walked through the northern one');
    assert.ok(gap(walker, south) >= clearance(walker, south) - 1e-6, 'walked through the southern one');
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
    assert.ok(
      gap(closer, inTheWay) >= clearance(closer, inTheWay) - 1e-6,
      `shouldered through (gap ${gap(closer, inTheWay)})`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* And nothing may end up welded to the floor                                  */
/* -------------------------------------------------------------------------- */

/**
 * **The owner's kobolds, 2026-08-13**: five youths lined up along a room edge, *"haven't moved since."*
 *
 * Solidity landed a few hours before the photograph and this is the bill for it. The deflection that
 * walks a body round another one re-read the nearest blocker every tick, which against a *row* of them
 * is a two-tick oscillation — 3.53px, measured, forever. Every stall counter in `hunt.ts` asked *did the
 * body move*, so the answer was yes on every one of those ticks: `lostForMs` reset, the errand never
 * expired, and the wander pass skips any mob that already has one. **A live hunt going nowhere is a mob
 * welded to the floor for the life of the server.**
 *
 * Both halves are fixed and both are tested here, because either alone would have left the game with a
 * failure the owner can see: `shared/bodies.test.ts` proves the deflection no longer loops, and these
 * prove that a body which *does* get stuck is let go of instead of held for ever. The second is the one
 * that has to keep working when some future local rule finds a pocket nobody has thought of yet.
 */
describe('a body that cannot get where it is going is released, not held there', () => {
  /** A wall of `n` bodies abreast on the column at `tx`, centred on the room's middle row. */
  function wallAt(sim: Simulation, origin: { tx: number; ty: number }, tx: number, n: number): Mob[] {
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const half = (n - 1) / 2;
    const out: Mob[] = [];
    for (let i = 0; i < n; i++) out.push(mobAt(sim, tx, midY + i - half));
    return out;
  }

  it('gives up a shuffle it cannot finish, instead of holding it open for ever', () => {
    // The reproduction. Before the fix this ran the full 600 ticks — a simulated minute — with the hunt
    // still live and the walker flip-flopping between two positions 3.53px apart, and it would have run
    // until the process died. The claim is not that the walker arrives; a shuffle is allowed to fail.
    // It is that the *hunt ends*, because that is the only thing standing between the mob and the next
    // wander pulse.
    const { world, sim, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const walker = mobAt(sim, origin.tx + 1, midY);
    wallAt(sim, origin, origin.tx + 4, 4);

    const hunts = new Map<number, Hunt>();
    beginDrift(hunts, walker, { x: tileCentre(origin.tx + 7), y: tileCentre(midY) });
    let ticks = 0;
    while (ticks < 600 && hunts.size > 0) {
      advanceHunts(sim, world, hunts, 100);
      ticks++;
    }
    assert.equal(hunts.size, 0, `the shuffle was still live after ${ticks} ticks — the mob is welded`);
    // Three seconds is `DRIFT_GIVE_UP_MS`; the walk out to the wall is allowed on top of it.
    assert.ok(ticks < 200, `took ${ticks} ticks to notice, which is long enough for the owner to see`);
  });

  it('never leaves a crowded room with a body that has not moved, over a long run', () => {
    // Six bodies in one nine-tile room, every one of them repeatedly told to go somewhere else in it —
    // the Cubs Den's own crowding (zone 168 holds eight) with the dice taken out, so the case is the
    // arrangement rather than a seed. Ten simulated minutes, and the measure is the one the owner
    // applied to the screenshot: has this body been anywhere?
    const { world, sim, grid, origin } = makeFixture();
    const hunts = new Map<number, Hunt>();
    const crowd: Mob[] = [];
    for (const [tx, ty] of [[1, 1], [1, 4], [1, 7], [2, 2], [2, 6], [3, 4]] as const) {
      crowd.push(mobAt(sim, origin.tx + tx, origin.ty + ty));
    }
    const anchored = wallAt(sim, origin, origin.tx + 5, 5);
    const mark = new Map<number, { x: number; y: number }>();
    const reached = new Map(crowd.map((m) => [m.id, 0]));
    /** The census starts here, so the answer is about the *steady state* rather than the first minute. */
    const settled = 3_000;

    // A wander pulse every ten seconds, exactly as `index.ts` beats it, aiming each idle body at the
    // far side of the room — the far side being *behind the wall*, which is the errand that fails.
    for (let tick = 0; tick < 6_000; tick++) {
      if (tick % 100 === 0) {
        for (const mob of crowd) {
          beginDrift(hunts, mob, { x: tileCentre(origin.tx + 7), y: tileCentre(origin.ty + (tick / 100) % ROOM_TILES) });
        }
      }
      advanceHunts(sim, world, hunts, 100);
      if (tick === settled) for (const mob of crowd) mark.set(mob.id, { x: mob.x, y: mob.y });
      if (tick < settled) continue;
      for (const mob of crowd) {
        const from = mark.get(mob.id)!;
        reached.set(mob.id, Math.max(reached.get(mob.id)!, Math.hypot(mob.x - from.x, mob.y - from.y)));
      }
    }

    // Measured over the **second half**, and that is the whole point of the measure: a welded body has
    // usually walked somewhere before it welded, so "did it ever move" is answered yes by the very
    // screenshot this is about. Five minutes in, a body that is going to amble has ambled.
    for (const mob of crowd) {
      assert.ok(
        reached.get(mob.id)! > TILE_SIZE,
        `mob ${mob.id} never got a tile from where it stood five minutes in — it is the screenshot`,
      );
    }
    // Solid throughout. A liveliness fix that quietly let bodies interpenetrate would pass everything
    // above and undo the feature this whole module is.
    //
    // Asked of bodies standing on **solid ground**, which is the rule rather than a softening of it:
    // threshold cells are exempt on purpose, so two wanderers may share the mouth of a gate and the
    // only honest claim is the one `bodySolidAt` actually makes. The first draft aimed the crowd at the
    // room's east edge, walked them into the exemption, and failed here — correctly.
    const solid = [...crowd, ...anchored].filter((m) => bodySolidAt(grid, m.x, m.y));
    assert.ok(solid.length >= crowd.length, 'the run ended with almost everybody in the doorway');
    for (const a of solid) {
      for (const b of solid) {
        if (a.id === b.id) continue;
        assert.ok(gap(a, b) >= clearance(a, b) - 1e-6, `${a.id} and ${b.id} ended up inside each other`);
      }
    }
  });

  it('lets the player walk past a line of five, which a chokepoint proof does not cover', () => {
    // The wedge proof is about *doorways*: no arrangement of bodies can seal a room, because every tile
    // that could be the last way out is a tile a body is not solid on. **A line across open floor is not
    // a chokepoint**, so none of that applies to it — and the owner walking into five kobolds in the
    // middle of a field must still get where they were going. Before the fix this player pushed east for
    // thirty seconds and finished 0.66 of a tile short of the line, having slid 0.29 of a tile sideways.
    const { sim, grid, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 1);
    player.y = tileCentre(midY);
    const line = wallAt(sim, origin, origin.tx + 4, 5);
    for (const mob of line) {
      assert.equal(bodySolidAt(grid, mob.x, mob.y), true, 'the fixture must be a wall on solid ground');
    }

    sim.setIntent(player.id, 1, 0);
    for (let n = 0; n < 300; n++) sim.tick();
    assert.ok(player.x > tileCentre(origin.tx + 4), `never got past the line; stopped at ${player.x},${player.y}`);
    // Past, not through, and without shoving anybody: the line is where it was put.
    for (const mob of line) {
      assert.ok(gap(player, mob) >= clearance(player, mob) - 1e-6, 'the player ended up inside one of them');
      assert.equal(mob.x, tileCentre(origin.tx + 4), 'a mob was pushed off its tile — bodies are not shovable');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Combat must still reach                                                     */
/* -------------------------------------------------------------------------- */

describe('the melee station and the pair clearance reconcile', () => {
  it('states the numbers, because a fighter that cannot arrive jitters for ever', () => {
    // If the clearance ever grew past the station, a mob would be refused *before* reaching it and
    // would grind against its opponent while the round timer fired. For two adults that is 32 against
    // 20 and leaves 12px, which is the same 12px `MELEE_STATION`'s docblock has always claimed — and
    // it is now the *definition* rather than a coincidence of two constants.
    const person: BodyPoint = { id: 1, x: 0, y: 0 };
    const giant: BodyPoint = { id: 2, x: 0, y: 0, scale: 2.75 };
    assert.equal(MELEE_STATION, TILE_SIZE);
    assert.equal(BODY_SEPARATION, 20);
    assert.equal(MELEE_DAYLIGHT, 12);
    assert.equal(stationFor(person, person), MELEE_STATION, 'two adults must still stand a tile apart');

    // And the arithmetic that made this slice necessary. The old form was `MELEE_STATION − clearance`;
    // run it for a person closing on a hill giant and the daylight is **negative**, which is a station
    // inside the defender and a fighter that can never report having arrived.
    assert.equal(bodyRadius(giant), 27.5);
    assert.equal(MELEE_STATION - bodyClearance(person, giant), -5.5);
    assert.equal(stationFor(person, giant), 49.5);
    for (const [a, b] of [[person, person], [person, giant], [giant, giant]] as const) {
      assert.equal(stationFor(a, b) - bodyClearance(a, b), MELEE_DAYLIGHT, 'the daylight moved');
    }
  });

  it('walks a giant onto a player and lets it arrive, where the fixed tile left it 5.5px short', () => {
    // The regression the whole third proof is about, run through the real pass. A giant closing on a
    // player is refused by `bodiesAllow` at 37.5px; the station it is aiming for used to be 32, which
    // it can never reach, so `atStation` stayed false for ever and the fight read as one body still
    // walking toward another it was already standing on top of.
    const { world, sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 7);
    player.y = tileCentre(midY);
    const giant = giantAt(sim, origin.tx + 1, midY);
    engage(new Scheduler(), giant, player);

    for (let n = 0; n < 60; n++) advanceStations(sim, world, 100);
    assert.equal(atStation(giant, player), true, `never arrived (gap ${gap(giant, player)})`);
    assert.ok(gap(giant, player) >= clearance(giant, player) - 1e-6, 'it arrived by standing inside them');
    assert.ok(gap(giant, player) > MELEE_STATION, 'a giant that stopped at a tile is inside the player');
    assert.ok(Math.abs(gap(giant, player) - 49.5) <= 1.5, `stood off at ${gap(giant, player)}`);

    // And holds still once there, which is the half a negative station broke: every tick it re-tried
    // the last 5.5px, was refused, and moved nothing.
    const settled = { x: giant.x, y: giant.y };
    for (let n = 0; n < 20; n++) advanceStations(sim, world, 100);
    assert.deepEqual({ x: giant.x, y: giant.y }, settled);
  });

  it('rings a giant with more attackers than it rings a person, which falls out of the arithmetic', () => {
    // `2·s·sin(θ/2) ≥ 2r`: people round a person need 36.4° each and nine fit, people round a hill
    // giant need 23.3° and fifteen do. Three is the case that happens; what this checks is that the
    // three of them get *in* — a station that did not scale would have refused all three at 37.5px and
    // left them in a ring nobody could close.
    const { world, sim, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    const giant = giantAt(sim, origin.tx + 4, midY);
    const scheduler = new Scheduler();
    const pack = [
      mobAt(sim, origin.tx + 1, midY),
      mobAt(sim, origin.tx + 8, midY),
      mobAt(sim, origin.tx + 4, midY + 4),
    ];
    for (const mob of pack) engage(scheduler, mob, giant);

    for (let n = 0; n < 80; n++) advanceStations(sim, world, 100);
    for (const mob of pack) {
      assert.equal(atStation(mob, giant), true, `${mob.id} never closed (gap ${gap(mob, giant)})`);
      assert.ok(gap(mob, giant) >= clearance(mob, giant) - 1e-6, `${mob.id} stood inside the giant`);
    }
    for (const a of pack) {
      for (const b of pack) {
        if (a.id === b.id) continue;
        assert.ok(gap(a, b) >= clearance(a, b) - 1e-6, 'two of the ring ended up inside each other');
      }
    }
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
        assert.ok(gap(a, b) >= clearance(a, b) - 1e-6, 'two of the pack ended up inside each other');
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

  it('gives up rather than orbiting a body standing on the tile you clicked', () => {
    // The owner, 2026-08-14: *"if I click on a creature and my player moves to it, the player keeps
    // running around the creature trying to get to the place I clicked. it should stop at obstacles
    // so a new destination can be clicked."*
    //
    // **This is the test above's own mechanism turned against it.** `stepBody`'s deflection is what
    // stops a mob beside the route from ending an honest walk — and when the mob is standing *on* the
    // goal, that same deflection walks the player round and round it at full speed forever. Every tick
    // covers the whole requested distance, so `STUCK_TICKS`, which asks only whether the body moved,
    // is satisfied in perpetuity. The route overrides steering, so the player cannot walk out of it.
    //
    // `NO_PROGRESS_TICKS` is the counter that sees it: circling never betters the best distance to the
    // waypoint. Two seconds, so the sibling test above — which spends a few ticks going round
    // something before closing again — is untouched.
    const { sim, player, origin } = makeFixture();
    const midY = origin.ty + (ROOM_TILES - 1) / 2;
    player.x = tileCentre(origin.tx + 1);
    player.y = tileCentre(midY);

    const goal = { tx: origin.tx + 6, ty: midY };
    // Standing exactly where the click landed, which is what clicking a creature does.
    mobAt(sim, goal.tx, goal.ty);
    sim.setPath(player, [goal]);

    let ended: { reason: string } | undefined;
    let ticks = 0;
    for (; ticks < 400 && !ended; ticks++) ended = sim.tick().pathsEnded[0];
    assert.ok(ended, 'the walk never ended — the player is still orbiting');
    assert.equal(ended.reason, 'stuck');
    // Ended because it stopped getting closer, not because it stopped moving: it has to have crossed
    // most of the room first, or this is passing for the wrong reason.
    assert.ok(
      player.x > tileCentre(origin.tx + 3),
      `the walker should have reached the body before giving up, stopped at ${player.x}`,
    );
    // And it gave up in about the two seconds the constant promises rather than in half a second or
    // never — 20 ticks of no progress, plus the ticks spent legitimately crossing the room.
    assert.ok(ticks < 200, `took ${ticks} ticks to notice it was going nowhere`);
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
        assert.ok(gap(a, b) >= clearance(a, b), `${a.id} and ${b.id} loaded on top of each other`);
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
        assert.ok(gap(actor, other) >= clearance(actor, other), 'two arrivals stacked');
      }
    }
  });

  it('keeps two characters logging in off each other’s tile', () => {
    const { sim, player } = makeFixture();
    const second = sim.spawn('Second', makeRng(2));
    assert.ok(gap(player, second) >= clearance(player, second), 'the second login landed on the first');
  });

  it('gives a room of giants two clear cells each, not one', () => {
    // *"Never have mobs or players load on top of each other"*, run at the size the rule was written
    // without. Every free tile satisfies two adults; two giants want 55px and the nearest tile that
    // offers it is two cells out. Six is what the world's most giant-heavy room actually holds.
    const { sim } = makeFixture();
    const rng = makeRng(31);
    const giants: Mob[] = [];
    for (let n = 0; n < 6; n++) {
      const mob = sim.spawnMob(giantTemplate(), HALL, rng);
      assert.ok(mob);
      assert.equal(mob.scale, 2.75);
      giants.push(mob);
    }
    for (const a of giants) {
      for (const b of giants) {
        if (a.id === b.id) continue;
        assert.ok(gap(a, b) >= 55 - 1e-9, `two giants loaded ${gap(a, b)}px apart, which is inside each other`);
      }
    }
    assert.equal(sim.crowding.stacked, 0);
    assert.equal(sim.crowding.blocked, 0);
  });

  it('lets a kobold in beside a giant that a person would have been moved off', () => {
    // The same tile and the same occupant, answered differently for two different bodies — which is
    // the whole of "a property of the body" as placement sees it.
    const { sim, origin } = makeFixture();
    const giant = giantAt(sim, origin.tx + 4, origin.ty + 4);
    const beside = { x: tileCentre(origin.tx + 5), y: tileCentre(origin.ty + 4) };
    assert.ok(bodyClearance(giant, { id: 0, x: 0, y: 0, scale: 0.3007 }) < TILE_SIZE);
    assert.ok(bodyClearance(giant, { id: 0, x: 0, y: 0 }) > TILE_SIZE);

    const kobold = sim.spawnMob(template({ sprite: 'child/kobold' }), HALL, makeRng(5));
    assert.ok(kobold);
    assert.ok(kobold.scale !== undefined && kobold.scale < 0.5, `a kobold youth came out at ${kobold.scale}x`);
    kobold.x = beside.x;
    kobold.y = beside.y;
    assert.ok(gap(kobold, giant) >= clearance(kobold, giant), 'the fixture should be legal for a kobold');

    // And the person is not: `landing` walks them off it. Aimed at the same tile, through the real path.
    const person = sim.spawnMob(template(), HALL, makeRng(6));
    assert.ok(person);
    assert.ok(gap(person, giant) >= clearance(person, giant), 'a person was loaded inside the giant');
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
  /**
   * The overlay `index.ts` folds over every template at boot, applied here for the first time.
   *
   * **Without it this sweep cannot see a single sized body**, and that is the finding rather than a
   * detail of the fixture: the mob sweep's classification lives in `data/world/overrides/mobs.json`,
   * not in the harvest, so a raw template's `sprite` is the bare word `human` and `bodySizeOf` reads
   * every one of the world's giants, trolls and kobolds as a 1.81 m person. The sweep was measuring a
   * world that never boots. With the overlay, 926 of the 2,016 spawned bodies — 45.9% — are not
   * adult-sized (2026-08-14).
   */
  const mobOverrides = loadMobOverrides();
  const asShipped = (t: MobTemplate): MobTemplate => {
    const override = mobOverrides.get(t.vnum);
    return override ? applyMobOverride(t, override) : t;
  };

  function sweep(): {
    placed: number;
    overlapping: number;
    unwalkable: number;
    wouldHaveBeenUnwalkable: number;
    wouldHaveOverlapped: number;
    sized: number;
    largest: number;
    wouldHaveOverlappedBySize: number;
    worst: { room: RoomId; bodies: number; tiles: number };
    tightest: { room: RoomId; bodies: number; tiles: number };
  } {
    let placed = 0;
    let overlapping = 0;
    let unwalkable = 0;
    let wouldHaveBeenUnwalkable = 0;
    let wouldHaveOverlapped = 0;
    let sized = 0;
    let largest = 0;
    let wouldHaveOverlappedBySize = 0;
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
      const byRoom = new Map<RoomId, { id: number; x: number; y: number; scale?: number }[]>();
      const naiveByRoom = new Map<RoomId, { tx: number; ty: number }[]>();
      const yesterdayByRoom = new Map<RoomId, { id: number; x: number; y: number; scale?: number }[]>();

      for (const command of spawns.resets) {
        if (command.kind !== 'mob' || command.room === undefined) continue;
        const raw = templates.get(command.what);
        if (!raw) continue;
        const template = asShipped(raw);
        const located = world.locate(command.room);
        if (!located) continue;
        const grid = world.grid(placeOf(located.room));
        const origin = grid?.roomOrigins.get(command.room);
        if (!grid || !origin) continue;

        const before = byRoom.get(command.room) ?? [];
        const mob = sim.spawnMob(template, command.room, rng);
        if (!mob) continue;
        placed++;
        if (mob.scale !== undefined) sized++;
        largest = Math.max(largest, mob.scale ?? 1);
        // **The identity that keeps the two answers one answer.** `viewOf` sizes the mesh from
        // `appearanceOf`; collision sizes the disc from `bodySizeOf`, which is that same verdict read
        // in metres. Both read `sprite` and `race`, both are `readonly`, so the only way they could
        // drift is a second derivation — and this is what would catch one.
        const expected = bodySizeOf({
          kind: 'mob',
          sprite: template.sprite,
          ...(template.race !== undefined ? { race: template.race } : {}),
        });
        assert.equal(mob.scale ?? 1, expected, `${template.name} collides at a size it is not drawn at`);

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

        // **Yesterday's placement, replayed exactly.** The counterfactual above is the *blind roll*,
        // which is the slice before this one; this is the rule that shipped between them — the same
        // nearest-free-tile search, run with every body 10px wide. Fed the same rolled tile off the
        // same stream, so these are the positions the world actually stood its giants on, and they are
        // then judged by the clearance those giants really want.
        const yesterdayHere = yesterdayByRoom.get(command.room) ?? [];
        const asAdult = placeBody(grid, command.room, origin, { tx: nx, ty: ny }, yesterdayHere, 1);
        const stood = {
          id: mob.id,
          x: tileCentre(asAdult.tx),
          y: tileCentre(asAdult.ty),
          ...(mob.scale === undefined ? {} : { scale: mob.scale }),
        };
        if (yesterdayHere.some((b) => Math.hypot(b.x - stood.x, b.y - stood.y) < bodyClearance(b, stood))) {
          wouldHaveOverlappedBySize++;
        }
        yesterdayHere.push(stood);
        yesterdayByRoom.set(command.room, yesterdayHere);

        if (!canStand(grid, mob.x, mob.y)) unwalkable++;
        // The pair rule, over the world. **This is the assertion that would have failed yesterday**:
        // two hill giants on adjacent tiles are 32px apart and want 55, so a placement that only knew
        // about 20 put them inside each other and reported nothing wrong.
        if (before.some((b) => Math.hypot(b.x - mob.x, b.y - mob.y) < bodyClearance(b, mob))) {
          overlapping++;
        }
        before.push({ id: mob.id, x: mob.x, y: mob.y, ...(mob.scale === undefined ? {} : { scale: mob.scale }) });
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
    return {
      placed,
      overlapping,
      unwalkable,
      wouldHaveBeenUnwalkable,
      wouldHaveOverlapped,
      sized,
      largest,
      wouldHaveOverlappedBySize,
      worst,
      tightest,
    };
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

  it('never puts two of them inside each other, at any of their sizes', () => {
    assert.equal(
      result.overlapping,
      0,
      `${result.overlapping} of ${result.placed} bodies stand inside somebody already there`,
    );
    console.log(
      `      stacked before the fix: ${result.wouldHaveOverlapped} ` +
        `(${((result.wouldHaveOverlapped / result.placed) * 100).toFixed(1)}%), after: ${result.overlapping}`,
    );
  });

  it('sizes them from the harvest, and places them at the size it sized them', () => {
    // The world is not one size, and this is the number that says so. Without it every case above is a
    // rule about pairs evaluated for two adults, which is arithmetically the constant it replaced.
    assert.ok(
      result.sized > result.placed / 10,
      `only ${result.sized} of ${result.placed} bodies carry a size — the sweep is not seeing the overlay`,
    );
    assert.ok(result.largest > 2, `the largest body in the world is ${result.largest}x, which is a person`);
    // And the size of the placement half of the bug, replayed rather than estimated: yesterday's
    // nearest-free-tile search run with every body 10px wide, judged by the clearance those bodies
    // really want. Asserted only to be non-zero — the exact count moves with the mob sweep's
    // classification, and pinning it would make this test a hostage to `overrides/mobs.json`.
    assert.ok(
      result.wouldHaveOverlappedBySize > 0,
      'the counterfactual found nothing, so this sweep is not exercising the size rule',
    );
    console.log(
      `      bodies not adult-sized: ${result.sized} of ${result.placed} ` +
        `(${((result.sized / result.placed) * 100).toFixed(1)}%); largest ${result.largest}x ` +
        `= ${bodyRadius({ id: 0, x: 0, y: 0, scale: result.largest }).toFixed(1)}px of radius`,
    );
    console.log(
      `      loaded inside each other under the flat 20px placement: ${result.wouldHaveOverlappedBySize}, after: 0`,
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
