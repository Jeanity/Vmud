/**
 * Seeing into the next room without asking — the owner's ruling of 2026-08-13.
 *
 * **Almost everything worth testing here is a restriction, and a restriction never shows on a happy
 * path.** A kobold appearing in the field to the north looks exactly the same whether or not the rule
 * that hides the dark mine, the shut door and the room two away is working. `peek.test.ts` learned this
 * the expensive way — *"seeing is not reaching"* broke for a whole commit with every existing test
 * green — so the refusals are tested first and hardest, and the two that would be actual exploits (a
 * verb reaching through a wall, a mob noticing you through one) each get their own named case.
 *
 * The other half is the **diff**: widening what an observer is sent is exactly the change that could
 * make a body leave and re-enter as you walk, or strand one drawn in a room it left. Those are pinned
 * against {@link membershipDiff}, which is the function `syncEntities` itself calls.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TILE_SIZE,
  boundsOf,
  makeRng,
  noPursuit,
  passiveRule,
  readCombatStats,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';
import {
  CARDINALS,
  cellIndex,
  describeRoom as describeScene,
  neighboursOf,
  sceneSeed,
  sceneZone,
} from '@mygame/shared/roomScene.ts';

import { LIGHT_SOURCES } from '@mygame/shared/light.ts';

import {
  carriesLight,
  farRoomLit,
  membershipDiff,
  openCrossings,
  roomsSeeingInto,
  visibleBodies,
  type CrossingDeps,
} from './nearby.ts';
import { perceives } from './perception.ts';
import { nameable } from './peek.ts';
import { Simulation, isMob, type Actor, type Player } from './sim.ts';
import { GameWorld, builtZoneFileExists, loadZone } from './world.ts';

/* -------------------------------------------------------------------------- */
/* The fixture: one room with every kind of crossing leading out of it          */
/* -------------------------------------------------------------------------- */

/**
 * `THE CROSSROADS` (9000) has one of each crossing on it, which is the point — the gauntlet is an
 * ordered list of refusals and a fixture with only the happy case tests none of them.
 *
 * ```
 *                9002  A Dark Cave Mouth      (north, open, but `dark`)
 *                  |
 *   9003 ---door--- 9000 THE CROSSROADS ---open--- 9001 ---open--- 9005
 *   A Gatehouse                |                   A Field         A Far Field
 *                              |                                   (two rooms away)
 *                  9004  A Sinkhole  (south, one-way: it does not point back)
 * ```
 *
 * Every room is unflagged — and therefore lights itself — except the cave. `THE CROSSROADS` itself is
 * `dark`, deliberately: the light gate belongs to the room you are looking *into*, so a fixture whose
 * observer stands in the dark proves that rather than assuming it.
 */
const CROSSROADS = 9000;
const FIELD = 9001;
const CAVE = 9002;
const GATEHOUSE = 9003;
const SINKHOLE = 9004;
const FAR_FIELD = 9005;
/** A mutual portal pair, same Place, no door — everything but a shared coordinate frame. */
const TOWER = 9006;
const TOWER_TOP = 9007;
/** The far end of a seam: another zone, so another Place. The IR draws a seam `open`; we do not. */
const OVER_THE_BORDER = 9100;

function room(id: number, name: string, x: number, y: number, over: Partial<Room> = {}): Room {
  return { id, zone: 900, name, sector: 'field', pos: { x, y, z: 0 }, exits: {}, ...over };
}

function testZone(): Zone {
  const rooms: Room[] = [
    room(CROSSROADS, 'The Crossroads', 1, 1, {
      flags: ['dark'],
      exits: {
        east: { to: FIELD },
        north: { to: CAVE },
        west: { to: GATEHOUSE, door: { name: 'the iron gate', closed: false, locked: false } },
        south: { to: SINKHOLE },
      },
    }),
    room(FIELD, 'A Field', 2, 1, { exits: { west: { to: CROSSROADS }, east: { to: FAR_FIELD } } }),
    room(CAVE, 'A Dark Cave Mouth', 1, 0, { sector: 'cave', flags: ['dark'], exits: { south: { to: CROSSROADS } } }),
    room(GATEHOUSE, 'A Gatehouse', 0, 1, {
      exits: { east: { to: CROSSROADS, door: { name: 'the iron gate', closed: false, locked: false } } },
    }),
    // No exit back north: a one-way link, which is every portal's shape and what `peek` refuses.
    room(SINKHOLE, 'A Sinkhole', 1, 2, { exits: {} }),
    room(FAR_FIELD, 'A Far Field', 3, 1, { exits: { west: { to: FIELD } } }),
    // Mutual, doorless, same Place, and four cells apart — so worldgen marked it a portal.
    room(TOWER, 'The Tower Foot', 5, 5, {
      exits: {
        north: { to: TOWER_TOP, portal: true },
        east: { to: OVER_THE_BORDER, portal: true, seam: true },
      },
    }),
    room(TOWER_TOP, 'The Tower Head', 5, 1, { exits: { south: { to: TOWER, portal: true } } }),
  ];
  return { id: 900, name: 'The Test Marches', rooms, bounds: boundsOf(rooms), entryRoom: CROSSROADS };
}

/** The far side of the seam: a different zone, therefore a different Place. */
function borderZone(): Zone {
  const rooms: Room[] = [
    {
      id: OVER_THE_BORDER,
      zone: 901,
      name: 'Over the Border',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 0 },
      exits: { west: { to: TOWER, portal: true, seam: true } },
    },
  ];
  return { id: 901, name: 'The Far Side', rooms, bounds: boundsOf(rooms), entryRoom: OVER_THE_BORDER };
}

const template = (name: string): MobTemplate => ({
  vnum: 99001,
  keywords: ['kobold', 'youth'],
  name,
  room: `${name} is here.`,
  level: 3,
  hp: '1d1+23',
  sprite: 'kobold',
  aggro: passiveRule(3),
  pursuit: noPursuit(),
  combat: readCombatStats({ level: 3, armour: 0, damage: '1d4+0' }),
  experience: 300,
  wimpyAt: 0,
});

interface Fixture {
  readonly sim: Simulation;
  readonly world: GameWorld;
  readonly player: Player;
  readonly deps: (observer: Player) => Parameters<typeof visibleBodies<Actor>>[1];
  readonly crossings: CrossingDeps;
  readonly put: (name: string, roomId: number) => Actor;
  readonly see: (observer: Player) => ReturnType<typeof visibleBodies<Actor>>;
}

function makeFixture(): Fixture {
  const world = new GameWorld([testZone(), borderZone()], { zone: 900, room: CROSSROADS });
  const sim = new Simulation(world);
  const player = sim.spawn('Scout', makeRng(1));
  sim.refreshVisible(player);

  const crossings: CrossingDeps = {
    roomOf: (id) => sim.room(id),
    hasDoor: (from, dir) => world.doorway(from, dir) !== undefined,
  };

  /**
   * `canSee` as `index.ts` computes it, transcribed rather than imported: `index.ts` is the server
   * bootstrap and importing it would open a socket. Three lines, and every one of them is the rule
   * under test — same room, and the body standing on a tile this observer's own light reaches.
   */
  const canSee = (observer: Player, subject: Actor): boolean => {
    if (observer.id === subject.id) return true;
    if (observer.roomId !== subject.roomId) return false;
    const grid = world.grid(observer.place);
    if (!grid) return false;
    const index =
      Math.floor(subject.y / TILE_SIZE) * grid.width + Math.floor(subject.x / TILE_SIZE);
    return observer.visible.has(index);
  };

  const deps = (observer: Player) => ({
    ...crossings,
    actorsIn: (id: number) => sim.actorsIn(id),
    viewOf: (actor: Actor) => sim.viewOf(actor),
    canSee: (subject: Actor) => canSee(observer, subject),
    revealed: new Set<number>(),
  });

  let minted = 0;
  const put = (name: string, roomId: number): Actor => {
    const mob = sim.spawnMob(template(name), roomId, makeRng(0x5eed + minted++));
    assert.ok(mob, `nothing could stand in room ${roomId}`);
    return mob;
  };

  return {
    sim,
    world,
    player,
    deps,
    crossings,
    put,
    see: (observer: Player) => visibleBodies(observer, deps(observer)),
  };
}

const source = (id: string) => {
  const found = LIGHT_SOURCES[id];
  assert.ok(found, `the catalogue has no ${id}`);
  return found;
};

/** The names on the wire, in order — what an acceptance walk actually reads. */
const namesOf = (views: readonly { readonly name: string; readonly revealed?: true }[]): string[] =>
  views.map((v) => (v.revealed ? `${v.name} (revealed)` : v.name));

/* -------------------------------------------------------------------------- */

describe('what counts as an open crossing', () => {
  it('accepts a mutual, doorless, non-portal cardinal exit inside one Place', () => {
    // **Structure only** — the dark cave is in this list and its bodies are still not sent. The light
    // gate lives in `visibleBodies` on purpose: whether the far room is lit is precisely what may have
    // just changed, so the *notification* fan-out needs the light-free relation.
    const { sim, crossings } = makeFixture();
    assert.deepEqual(openCrossings(sim.room(CROSSROADS)!, crossings).sort((a, b) => a - b), [FIELD, CAVE]);
  });

  it('**refuses a door, open as well as shut** — which is where it is narrower than `peek`', () => {
    // The gate to the west is wide open and `peek` would see straight through it. This does not, and
    // that is the deliberate half of the ruling: an open door is a hole you look through on purpose,
    // not a wall that is not there. `peek` still covers it, which is why it stays.
    const { sim, world, crossings } = makeFixture();
    const gate = world.doorway(CROSSROADS, 'west');
    assert.ok(gate, 'the fixture must hang a door on the west exit');
    assert.equal(gate.near.door.closed, false, 'and it must be open, or this tests the wrong thing');
    assert.equal(openCrossings(sim.room(CROSSROADS)!, crossings).includes(GATEHOUSE), false);

    // Shut it and nothing changes, which is the property worth having: **a door's state can never move
    // a body onto or off the wire**, so there is no door event this feature has to be re-synced by.
    // (Doors do change at run time — `open`/`close` and a zone reset both call `setDoorClosed` — which
    // is why the invariance is asserted rather than assumed.)
    world.setDoorClosed(gate, true);
    assert.equal(openCrossings(sim.room(CROSSROADS)!, crossings).includes(GATEHOUSE), false);
  });

  it('refuses a one-way link, exactly as `peek` does', () => {
    const { sim, crossings } = makeFixture();
    assert.equal(openCrossings(sim.room(CROSSROADS)!, crossings).includes(SINKHOLE), false);
  });

  it('refuses a portal even when it is mutual, doorless and in the same Place', () => {
    // The Kobold Settlement's own 41299 ⇄ 41297 shape: graph reciprocity passes and the geometry does
    // not. `peek` peers through it on purpose — the graph is the truth there — but a *drawn* body needs
    // a shared coordinate frame, and `portal` means precisely that there is none.
    const { sim, crossings } = makeFixture();
    assert.deepEqual(openCrossings(sim.room(TOWER)!, crossings), []);
  });

  it('refuses a seam, whose far end is another Place', () => {
    // The IR classifies a seam `open` and draws no ring — 5,140 of the world's 5,142 portal edges are
    // seams — but both ends are different zones, so a body there would be drawn at coordinates
    // belonging to another grid. Named rather than left to fall out of the `portal` clause.
    const { sim, crossings } = makeFixture();
    assert.equal(openCrossings(sim.room(TOWER)!, crossings).includes(OVER_THE_BORDER), false);
  });

  it('refuses `up` and `down`, which are stairwells and not edges at all', () => {
    // Mutual, doorless, non-portal, and even on the same level — everything a cardinal crossing needs,
    // and still refused, because `RoomScene` has no vertical *edge*: a link up or down is a feature in
    // the floor, and there is no see-through geometry for a body to be drawn behind.
    assert.deepEqual([...CARDINALS], ['north', 'east', 'south', 'west']);
    const cellar = room(9200, 'A Cellar', 9, 9, { exits: { up: { to: 9201 } } });
    const hall = room(9201, 'A Hall', 9, 9, { exits: { down: { to: 9200 } } });
    const both = new Map([cellar, hall].map((r) => [r.id, r]));
    const deps: CrossingDeps = { roomOf: (id) => both.get(id), hasDoor: () => false };
    assert.deepEqual(openCrossings(cellar, deps), []);
    assert.deepEqual(openCrossings(hall, deps), []);
  });

  it('says nothing at the edge of the loaded world', () => {
    const { sim } = makeFixture();
    const nowhere: CrossingDeps = { roomOf: (id) => (id === CROSSROADS ? sim.room(id) : undefined), hasDoor: () => false };
    assert.deepEqual(openCrossings(sim.room(CROSSROADS)!, nowhere), []);
  });
});

/**
 * The safety property, stated against the renderer rather than against itself.
 *
 * The roadmap row names the IR's edge classes as the authority. `describeRoom` builds a whole scene and
 * cannot be called per observer per tick, so `openCrossings` re-derives the answer from the exit graph —
 * and this is what stops the two drifting: **every crossing this feature sends bodies through must be
 * one the renderer draws see-through.** The converse is deliberately not asserted; see the module
 * header on `SceneEdge.inbound`.
 */
describe('agreeing with the renderer', () => {
  it('sends bodies only through edges the IR classifies `open` and not solid', () => {
    const zone = testZone();
    const scene = sceneZone(zone);
    const cells = cellIndex(zone);
    const rooms = new Map(zone.rooms.map((r) => [r.id, r]));
    const deps: CrossingDeps = {
      roomOf: (id) => rooms.get(id),
      // Both sides, as `GameWorld.doorway` answers it.
      hasDoor: (from, dir) => {
        const here = rooms.get(from);
        const exit = here?.exits[dir];
        if (!here || !exit) return false;
        const back = rooms.get(exit.to)?.exits[{ north: 'south', south: 'north', east: 'west', west: 'east' }[dir] as typeof dir];
        return exit.door !== undefined || (back?.to === from && back.door !== undefined);
      },
    };

    let checked = 0;
    for (const here of zone.rooms) {
      const open = openCrossings(here, deps);
      const edges = describeScene(scene, here, neighboursOf(cells, here, rooms), sceneSeed(scene, here)).edges;
      for (const dir of CARDINALS) {
        const edge = edges[dir];
        const sends = here.exits[dir] !== undefined && open.includes(here.exits[dir]!.to);
        if (!sends) continue;
        checked++;
        assert.equal(edge.kind, 'open', `${here.name} ${dir}: sent bodies through a '${edge.kind}' edge`);
        assert.equal(edge.solid, false, `${here.name} ${dir}: sent bodies through a solid edge`);
        assert.equal(edge.seam, undefined, `${here.name} ${dir}: sent bodies across a seam`);
      }
    }
    assert.ok(checked > 0, 'the fixture must exercise at least one accepted crossing');
  });
});

describe('the far room’s light, never yours', () => {
  it('is answered by the room lighting itself', () => {
    const { sim } = makeFixture();
    assert.equal(farRoomLit(sim.room(FIELD)!, []), true, 'an unflagged room lights itself');
    assert.equal(farRoomLit(sim.room(CAVE)!, []), false, 'a `dark` one does not');
  });

  it('asks whether a body *holds* a source, not what its eyes are worth', () => {
    // **The trap this predicate exists to avoid.** `Simulation.recompute` floors every actor's
    // `lightRadius` at the bare eye's `DEFAULT_LIGHT_RADIUS`, which is 2 and never 0 — so a gate
    // written `lightRadius > 0` says "somebody is standing there", and every dark room in the world
    // with a kobold in it would light up. `Actor.light` is the fact being asked about.
    const { sim, put } = makeFixture();
    const miner = put('a kobold miner', CAVE);
    assert.ok(miner.lightRadius > 0, 'the bare eye is a positive radius, which is the trap');
    assert.equal(carriesLight(miner), false, 'and it is not a light');
    assert.equal(farRoomLit(sim.room(CAVE)!, [miner]), false);

    sim.setCarriedLight(miner, source('torch'));
    assert.equal(carriesLight(miner), true);
    assert.equal(farRoomLit(sim.room(CAVE)!, [miner]), true, 'their beacon is what you see by');
  });
});

/* -------------------------------------------------------------------------- */
/* The acceptance walk                                                          */
/* -------------------------------------------------------------------------- */

describe('standing still and seeing the next room', () => {
  it('puts a mob one open crossing away on the wire, flagged `revealed`', () => {
    const { player, put, see } = makeFixture();
    put('a kobold youth', FIELD);

    const wire = see(player);
    // Printed, because this is the acceptance walk and the wire is the deliverable.
    console.log('[nearby] standing in The Crossroads:', JSON.stringify(namesOf(wire)));
    assert.deepEqual(namesOf(wire), ['Scout', 'a kobold youth (revealed)']);
    assert.equal(wire.find((e) => e.name === 'a kobold youth')?.revealed, true);
  });

  it('sends nothing through a dark crossing, a door, a one-way link, or from two rooms away', () => {
    // All four refusals at once, and all four are invisible on the happy path above.
    const { player, put, see } = makeFixture();
    put('a kobold miner', CAVE);
    put('a gate guard', GATEHOUSE);
    put('something in the pit', SINKHOLE);
    put('a distant kobold', FAR_FIELD);

    const wire = see(player);
    console.log('[nearby] with only refused crossings around:', JSON.stringify(namesOf(wire)));
    assert.deepEqual(namesOf(wire), ['Scout']);
  });

  it('sends nothing across a Place boundary, however the crossing is dressed', () => {
    const { sim, player, put, see } = makeFixture();
    sim.relocate(player, TOWER);
    sim.refreshVisible(player);
    put('a border watcher', OVER_THE_BORDER);
    put('a tower sentry', TOWER_TOP);
    assert.deepEqual(namesOf(see(player)), ['Scout']);
  });

  it('lights the dark cave the moment somebody in it carries a torch', () => {
    // The runtime flip the light gate actually has today. Room flags are static — nothing in play
    // writes `dark` on or off a room, and there is no game-hour clock (settled 2026-08-13) — so a
    // carried light is the only thing that moves this answer while a player stands still.
    const { sim, player, put, see } = makeFixture();
    const miner = put('a kobold miner', CAVE);
    assert.deepEqual(namesOf(see(player)), ['Scout'], 'dark to begin with');

    sim.setCarriedLight(miner, source('torch'));
    assert.deepEqual(namesOf(see(player)), ['Scout', 'a kobold miner (revealed)'], 'their beacon is what you see by');

    sim.setCarriedLight(miner, undefined);
    assert.deepEqual(namesOf(see(player)), ['Scout'], 'and the dark closes again when it gutters');
  });

  it('does not need the *observer’s* room to be lit — The Crossroads is `dark` throughout', () => {
    const { sim, player, put, see } = makeFixture();
    assert.equal(sim.room(CROSSROADS)!.flags?.includes('dark'), true);
    put('a kobold youth', FIELD);
    assert.equal(namesOf(see(player)).includes('a kobold youth (revealed)'), true);
  });
});

/* -------------------------------------------------------------------------- */
/* Union, de-duplication, and which flag wins                                   */
/* -------------------------------------------------------------------------- */

describe('three sources, one list', () => {
  it('sends a body once when it is both peeked at and across an open crossing', () => {
    const { player, put, deps } = makeFixture();
    put('a kobold youth', FIELD);
    const wire = visibleBodies(player, { ...deps(player), revealed: new Set([FIELD]) });
    assert.deepEqual(namesOf(wire), ['Scout', 'a kobold youth (revealed)']);
  });

  it('**your own room wins the flag**, so a body you are standing next to stays nameable', () => {
    // The precedence that matters, and the only one that does. A self-loop exit or a stale reveal
    // naming your own room would otherwise mint a `revealed` copy of somebody in front of you — and
    // `nameable` strips those, so `kill kobold` would answer "you see no kobold here" about a kobold
    // filling the screen. Source order is the rule: your own room is claimed first.
    const { player, put, deps } = makeFixture();
    const here = put('the kobold shaman', CROSSROADS);
    // Stand them on the observer's own tile so the light gate certainly passes.
    here.x = player.x;
    here.y = player.y;

    const wire = visibleBodies(player, { ...deps(player), revealed: new Set([CROSSROADS]) });
    assert.deepEqual(namesOf(wire), ['Scout', 'the kobold shaman'], 'exactly once, and not flagged');
    assert.deepEqual(
      nameable(wire).map((e) => e.name),
      ['Scout', 'the kobold shaman'],
      'and therefore still targetable',
    );
  });

  it('keeps a peeked body that no open crossing would reach — `peek` is not superseded', () => {
    // Through the open gate to the west: `look west` still earns it, which is the whole reason `peek`
    // survives this change rather than being replaced by it.
    const { player, put, deps } = makeFixture();
    put('a gate guard', GATEHOUSE);
    const wire = visibleBodies(player, { ...deps(player), revealed: new Set([GATEHOUSE]) });
    assert.deepEqual(namesOf(wire), ['Scout', 'a gate guard (revealed)']);
  });

  it('refuses a peeked body standing in another Place, as it always has', () => {
    const { sim, player, put, deps } = makeFixture();
    sim.relocate(player, TOWER);
    sim.refreshVisible(player);
    put('a border watcher', OVER_THE_BORDER);
    const wire = visibleBodies(player, { ...deps(player), revealed: new Set([OVER_THE_BORDER]) });
    assert.deepEqual(namesOf(wire), ['Scout']);
  });
});

/* -------------------------------------------------------------------------- */
/* Seeing is not reaching                                                       */
/* -------------------------------------------------------------------------- */

describe('what the wider sight does **not** buy', () => {
  it('leaves a body one room away un-nameable, so no verb can reach it', () => {
    // `targetsFor` — which feeds `kill`, `get`, `look <keyword>`, `cast … <keyword>` and the click
    // menu — is `nameable(visibleEntities(...))`. Everything this feature adds carries `revealed`, so
    // it is stripped there by the rule `peek` already installed. One filter, two sources, no second
    // place to keep in step.
    const { player, put, see } = makeFixture();
    put('a kobold youth', FIELD);
    const wire = see(player);
    assert.equal(namesOf(wire).includes('a kobold youth (revealed)'), true, 'drawn');
    assert.deepEqual(nameable(wire).map((e) => e.name), ['Scout'], 'and out of reach');
  });

  it('does not let a mob notice you through the crossing', () => {
    // `perceives` gates on the room first and is not gated on light at all, so the only thing standing
    // between a mob and a target it can never reach is that room check. Nothing in this feature touches
    // it — but "nothing touches it" is exactly the claim that quietly stops being true.
    const { sim, player, put } = makeFixture();
    const kobold = put('a kobold youth', FIELD);
    assert.ok(isMob(kobold));
    assert.equal(perceives(kobold, player), false, 'a room away is out of its attention entirely');

    sim.relocate(kobold, CROSSROADS);
    kobold.x = player.x;
    kobold.y = player.y;
    assert.equal(perceives(kobold, player), true, 'and in the room it is not — the gate is the room');
  });
});

/* -------------------------------------------------------------------------- */
/* The diff                                                                     */
/* -------------------------------------------------------------------------- */

/** What `syncEntities` would send, through the very function it calls. */
function sync(shown: Set<number>, wire: readonly { readonly id: number; readonly name: string }[], self: number) {
  const diff = membershipDiff(shown, wire as never, self);
  return { entered: diff.entered.map((e) => e.name), left: [...diff.left], now: diff.now };
}

describe('the entity diff stays clean', () => {
  it('sends nothing at all for a body that was visible and still is', () => {
    const { player, put, see } = makeFixture();
    const kobold = put('a kobold youth', FIELD);
    const first = sync(new Set(), see(player), player.id);
    assert.deepEqual(first.entered, ['a kobold youth']);

    const second = sync(first.now, see(player), player.id);
    assert.deepEqual(second.entered, []);
    assert.deepEqual(second.left, []);
    assert.equal(second.now.has(kobold.id), true);
  });

  it('**does not leave-and-re-enter** a body that stays visible while the observer crosses a boundary', () => {
    // Walk east from The Crossroads into A Field. The kobold was visible from the far side of the
    // crossing and is now standing in the room; the diff must say nothing about it. Before the third
    // source it *had* to say something — the body was not on the wire at all until you arrived — so
    // this is the case the whole change turns on.
    const { sim, player, put, see } = makeFixture();
    const kobold = put('a kobold youth', FIELD);
    const before = sync(new Set(), see(player), player.id);
    assert.deepEqual(before.entered, ['a kobold youth']);

    sim.relocate(player, FIELD);
    // Stand on the kobold's own tile so the observer's own light certainly reaches it.
    player.x = kobold.x;
    player.y = kobold.y;
    sim.refreshVisible(player);

    const after = sync(before.now, see(player), player.id);
    assert.deepEqual(after.entered, [], 'no re-entry');
    assert.deepEqual(after.left, [], 'and no departure');
    // The flag *does* change — it is nameable now — and that rides `entityUpdate`, not the membership
    // diff. The diff's job is who, not how.
    assert.equal(see(player).find((e) => e.id === kobold.id)?.revealed, undefined);
  });

  it('says nothing when a mob crosses between two rooms the observer can see', () => {
    // One move, not a leave and an enter: the id is in the set before and after, so the position
    // reaches the client through the tick's `entityMoved` batch, which is sent to everyone watching it.
    const { sim, player, put, see } = makeFixture();
    const kobold = put('a kobold youth', FIELD);
    const first = sync(new Set(), see(player), player.id);

    sim.relocate(kobold, CROSSROADS);
    const second = sync(first.now, see(player), player.id);
    assert.deepEqual(second.entered, [], 'walking into your room is not an arrival on the wire');
    assert.deepEqual(second.left, []);
    assert.equal(second.now.has(kobold.id), true);
  });

  it('reports a departure when the mob walks somewhere the observer cannot see', () => {
    const { sim, player, put, see } = makeFixture();
    const kobold = put('a kobold youth', FIELD);
    const first = sync(new Set(), see(player), player.id);

    sim.relocate(kobold, FAR_FIELD);
    const second = sync(first.now, see(player), player.id);
    assert.deepEqual(second.entered, []);
    assert.deepEqual(second.left, [kobold.id], 'two rooms away is gone');
  });

  it('reports a departure when the far room goes dark under it', () => {
    const { sim, player, put, see } = makeFixture();
    const miner = put('a kobold miner', CAVE);
    sim.setCarriedLight(miner, source('torch'));
    const first = sync(new Set(), see(player), player.id);
    assert.deepEqual(first.entered, ['a kobold miner']);

    sim.setCarriedLight(miner, undefined);
    const second = sync(first.now, see(player), player.id);
    assert.deepEqual(second.left, [miner.id], 'the dark takes them back');
  });

  it('never puts the observer in their own watch set', () => {
    const { player, see } = makeFixture();
    const first = sync(new Set(), see(player), player.id);
    assert.equal(first.now.has(player.id), false);
    assert.deepEqual(first.entered, []);
  });
});

/* -------------------------------------------------------------------------- */
/* The notification fan-out                                                     */
/* -------------------------------------------------------------------------- */

describe('who has to be told when something happens in a room', () => {
  it('is the mirror of `openCrossings`, so the two cannot drift', () => {
    const { sim, crossings } = makeFixture();
    const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);
    // A Field can be seen into from The Crossroads and from A Far Field, and vice versa. The relation
    // is structural and therefore symmetric — the dark cave is in both lists, and its bodies are still
    // gated out one layer up.
    assert.deepEqual(sorted(roomsSeeingInto(FIELD, crossings)), sorted([CROSSROADS, FAR_FIELD]));
    assert.deepEqual(sorted(roomsSeeingInto(CROSSROADS, crossings)), sorted([FIELD, CAVE]));
    for (const room of [FIELD, CAVE]) {
      assert.equal(openCrossings(sim.room(room)!, crossings).includes(CROSSROADS), true);
    }
  });

  it('names nobody for a room reached only through a door, a portal or a one-way link', () => {
    const { crossings } = makeFixture();
    assert.deepEqual(roomsSeeingInto(GATEHOUSE, crossings), [], 'the gate hides it either way round');
    assert.deepEqual(roomsSeeingInto(SINKHOLE, crossings), [], 'and a one-way link is not a window');
    assert.deepEqual(roomsSeeingInto(TOWER_TOP, crossings), []);
  });

  it('names nobody for a room this server does not load', () => {
    const { crossings } = makeFixture();
    assert.deepEqual(roomsSeeingInto(4242, crossings), []);
  });
});

/* -------------------------------------------------------------------------- */
/* The walk, in the shipped world                                               */
/* -------------------------------------------------------------------------- */

/**
 * The same rules against the world the owner actually stands in — **where to go and look.**
 *
 * Skipped when `data/world` has not been generated, because it is git-ignored and reproducible
 * (`npm run worldgen`) rather than committed. Everything above runs on a fixture and is the real
 * safety net; this is the acceptance walk written down so it does not live only in a report.
 */
const HAVE_WORLD = builtZoneFileExists(168);

describe('the acceptance walk: the Kobold Settlement', { skip: HAVE_WORLD ? false : 'data/world not generated' }, () => {
  /** 41260, `An Overgrown Field` — where every new character starts. */
  const OVERGROWN_FIELD = 41260;
  /** 41261, `Northern End of an Overgrown Field` — three kobold youths spawn in it. */
  const NORTHERN_END = 41261;
  /** 41283 / 41284 — the mine tunnel: an open crossing into a `dark` room holding four kobolds. */
  const TUNNEL_BEND = 41283;
  const TUNNEL_END = 41284;
  /** 41273 / 41303 — a door, shut, behind the cave-in. */
  const DARK_TUNNEL_END = 41273;

  const marches = () => {
    const world = new GameWorld([loadZone(168)], { zone: 168, room: OVERGROWN_FIELD });
    const sim = new Simulation(world);
    const deps: CrossingDeps = {
      roomOf: (id) => sim.room(id),
      hasDoor: (from, dir) => world.doorway(from, dir) !== undefined,
    };
    return { sim, world, deps };
  };

  it('shows all four neighbours of the spawn room — stand in 41260 and look around', () => {
    const { sim, deps } = marches();
    const open = openCrossings(sim.room(OVERGROWN_FIELD)!, deps).sort((a, b) => a - b);
    console.log(
      '[nearby] 41260 An Overgrown Field opens onto:',
      open.map((id) => `${id} ${sim.room(id)?.name}`).join(' | '),
    );
    assert.equal(open.includes(NORTHERN_END), true, 'the field the kobold youths stand in');
    assert.equal(open.length, 4, 'the spawn room is a crossroads of four open field edges');
  });

  it('refuses the mine tunnel, which is open geometry into a `dark` room', () => {
    const { sim, deps } = marches();
    const open = openCrossings(sim.room(TUNNEL_BEND)!, deps);
    assert.equal(open.includes(TUNNEL_END), true, 'the crossing itself is open');
    assert.equal(
      farRoomLit(sim.room(TUNNEL_END)!, []),
      false,
      '41284 End of the Mine Tunnel is flagged `dark`, so its four kobolds stay hidden',
    );
  });

  it('refuses the door behind the cave-in', () => {
    const { sim, deps } = marches();
    assert.equal(openCrossings(sim.room(DARK_TUNNEL_END)!, deps).includes(41303), false);
  });

  it('refuses the seam out of the settlement into Evermeet', () => {
    // 41187 `A Game Trail` south to 41185, zone 321 — the settlement's one harvested neighbour, and a
    // seam, which the IR draws `open` and this refuses on the Place boundary.
    const { sim, deps } = marches();
    assert.deepEqual(openCrossings(sim.room(41187)!, deps).includes(41185), false);
  });
});
