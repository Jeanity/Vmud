/**
 * Combat: the pointer, the round, and the mercy rule.
 *
 * Two tests in here are the reason Phase 6 and §4.1 exist, and if either ever fails the fix is not to
 * adjust the assertion:
 *
 * - **"blows land wherever you stand"** — engagement is a relationship, not a distance. The moment a
 *   `distance <= reach` test appears anywhere in `combat.ts`, walking away from a melee attacker becomes
 *   free, and threat, tanking and rescue all collapse (`DESIGN-engagement.md` §8).
 * - **"a fast actor swings more often"** — the round is per actor. A single global round turns every speed
 *   stat into "extra attacks" and a dagger into an ogre with a multiplier (§4.1).
 *
 * Everything else here is §5's enumeration of what ends a fight, which exists because "it ends when the
 * fight ends" is how a stale pointer survives into Phase 13.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ROUND_MS,
  TILE_SIZE,
  boundsOf,
  makeRng,
  noPursuit,
  passiveRule,
  addThreat,
  isParticipant,
  readCombatStats,
  threatOf,
  type MobTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import {
  advanceAssists,
  advanceCombat,
  attackersOf,
  canBeAttacked,
  canEngage,
  cannotDefend,
  clearEngagements,
  disengage,
  engage,
  incapacitated,
  forgetThreat,
  joinBySupporting,
  openingTarget,
  retaliate,
  threatTableFor,
  type LedgerBook,
  type ThreatBook,
} from './combat.ts';
import { Scheduler } from './scheduler.ts';
import { Simulation, type Actor, type Mob, type Player } from './sim.ts';
import { GameWorld } from './world.ts';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function arena(): Zone {
  const rooms: Room[] = [
    { id: 4000, zone: 400, name: 'The Arena', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 4001 } } },
    { id: 4001, zone: 400, name: 'The Antechamber', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 4000 } } },
  ];
  return { id: 400, name: 'Test Arena', rooms, bounds: boundsOf(rooms), entryRoom: 4000 };
}

/** A harmless opponent with a lot of hit points, so a test about pointers is not also a test about dying. */
const dummy = (over: Partial<MobTemplate> = {}): MobTemplate => ({
  vnum: 400_01,
  keywords: ['dummy'],
  name: 'a straw dummy',
  room: 'A straw dummy stands here.',
  level: 1,
  hp: '1d1+999',
  sprite: 'human',
  aggro: passiveRule(1),
  pursuit: noPursuit(),
  // AC 10 and a single point of damage: every roll is decidable by hand and nothing dies by accident.
  combat: readCombatStats({ level: 1, armour: 0, damage: '1d1+0' }),
  experience: 100,
  ...over,
});

interface Fixture {
  readonly sim: Simulation;
  readonly scheduler: Scheduler;
  readonly player: Player;
  readonly mob: Mob;
  readonly rng: () => number;
  readonly book: ThreatBook;
  readonly ledger: LedgerBook;
  /** Runs `ms` of simulation in `TICK_MS`-sized steps and returns every attack resolved. */
  readonly run: (ms: number) => ReturnType<typeof advanceCombat>['attacks'][number][];
}

function makeFixture(template: MobTemplate = dummy()): Fixture {
  const world = new GameWorld([arena()], { zone: 400, room: 4000 });
  const sim = new Simulation(world);
  const player = sim.spawn('Fighter');
  const mob = sim.spawnMob(template, 4000, makeRng(0xa4e4a));
  assert.ok(mob);
  const scheduler = new Scheduler();
  const rng = makeRng(0xd1ce);
  const book: ThreatBook = new Map();
  const ledger: LedgerBook = new Map();

  return {
    sim,
    scheduler,
    player,
    mob,
    rng,
    book,
    ledger,
    run: (ms) => {
      const out: ReturnType<typeof advanceCombat>['attacks'][number][] = [];
      for (let elapsed = 0; elapsed < ms; elapsed += 100) {
        out.push(...advanceCombat(sim, scheduler, book, ledger, rng, 100).attacks);
      }
      return out;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The two that matter most                                                    */
/* -------------------------------------------------------------------------- */

describe('engagement is a relationship, not a distance', () => {
  it('lands blows wherever in the room either party stands', () => {
    // §8's trap, as an assertion. If a reach check is ever added to `combat.ts` this fails — and the fix
    // is to remove the check, not to move the dummy closer. Walking away from a melee attacker must cost
    // something (a flee that can fail), or there is no reason to hold aggro and no such thing as a tank.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);

    // Put them at opposite corners of the room — further apart than any plausible weapon reach, and
    // further than Phase 9's six-tile perception.
    fixture.player.x = fixture.mob.x + TILE_SIZE * 8;
    fixture.player.y = fixture.mob.y + TILE_SIZE * 8;

    const attacks = fixture.run(ROUND_MS * 2 + 200);
    assert.ok(attacks.length >= 2, `blows kept landing across the room (got ${attacks.length})`);
    assert.equal(fixture.player.fighting, fixture.mob.id, 'and the engagement survived the distance');
  });

  it('ends the moment the target is in another room, and not before', () => {
    // The one spatial rule there is: containment, not range. §5 — leaving the room ends engagement.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    fixture.sim.relocate(fixture.mob, 4001);

    fixture.run(ROUND_MS + 200);
    assert.equal(fixture.player.fighting, undefined);
    assert.equal(fixture.player.wasFighting, fixture.mob.id, 'and it remembers who that was');
  });
});

describe('the round is per actor', () => {
  it('swings a fast actor more often than a slow one in the same fight', () => {
    // §4.1's warning, as an assertion. With one global round this is impossible to express: both actors
    // would resolve on the same beat and every speed difference would have to become "extra attacks".
    const fixture = makeFixture();
    const quick = fixture.player;
    const slow = fixture.mob;
    quick.roundMs = 1_000;
    slow.roundMs = 3_000;

    engage(fixture.scheduler, quick, slow);
    engage(fixture.scheduler, slow, quick);

    const attacks = fixture.run(6_200);
    const byQuick = attacks.filter((a) => a.attacker.id === quick.id).length;
    const bySlow = attacks.filter((a) => a.attacker.id === slow.id).length;
    assert.ok(byQuick > bySlow, `fast ${byQuick} vs slow ${bySlow}`);
    assert.ok(byQuick >= 5, `about one a second over six seconds (got ${byQuick})`);
    assert.ok(bySlow <= 3, `about one every three seconds (got ${bySlow})`);
  });

  it('reads the actor field rather than the global constant', () => {
    // A guard against the specific regression §4.1 predicts: someone reaches for `ROUND_MS` because it is
    // exported and right there. Halving one actor's round must change that actor's rate.
    const fixture = makeFixture();
    fixture.player.roundMs = ROUND_MS / 2;
    engage(fixture.scheduler, fixture.player, fixture.mob);
    const attacks = fixture.run(ROUND_MS * 2 + 200);
    assert.ok(attacks.length >= 4, `half a round means twice the swings (got ${attacks.length})`);
  });
});

/* -------------------------------------------------------------------------- */
/* The pointer                                                                 */
/* -------------------------------------------------------------------------- */

describe('the shape of engagement', () => {
  it('points one way only — the victim is not automatically fighting back', () => {
    // §2's mutuality rule. `set_fighting(ch, vict)` does not touch the victim's pointer, and a
    // symmetric implementation would make it impossible for three actors to gang up on one.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    assert.equal(fixture.player.fighting, fixture.mob.id);
    assert.equal(fixture.mob.fighting, undefined, 'the dummy has not decided anything');
  });

  it('derives the inbound set by scanning', () => {
    const fixture = makeFixture();
    const second = fixture.sim.spawnMob(dummy({ vnum: 400_02 }), 4000, makeRng(0xbee5));
    assert.ok(second);
    engage(fixture.scheduler, fixture.player, fixture.mob);
    engage(fixture.scheduler, second, fixture.mob);

    const inbound = attackersOf(fixture.sim, fixture.mob.id).map((a) => a.id).sort();
    assert.deepEqual(inbound, [fixture.player.id, second.id].sort());
  });

  it('refuses to retarget, so a switch must disengage first', () => {
    // §2's first consequence. `set_fighting` on an already-fighting actor is an assertion failure
    // upstream, not a re-target — one code path, so a switch cannot leave a stale pointer.
    const fixture = makeFixture();
    const second = fixture.sim.spawnMob(dummy({ vnum: 400_02 }), 4000, makeRng(0xbee5));
    assert.ok(second);
    engage(fixture.scheduler, fixture.player, fixture.mob);

    assert.equal(engage(fixture.scheduler, fixture.player, second), false, 'refused');
    assert.equal(fixture.player.fighting, fixture.mob.id, 'still on the first');

    disengage(fixture.scheduler, fixture.player);
    assert.equal(engage(fixture.scheduler, fixture.player, second), true, 'stop-then-set works');
    assert.equal(fixture.player.fighting, second.id);
  });

  it('never engages itself', () => {
    const fixture = makeFixture();
    assert.equal(engage(fixture.scheduler, fixture.player, fixture.player), false);
  });

  it('refuses across a room boundary', () => {
    const fixture = makeFixture();
    fixture.sim.relocate(fixture.mob, 4001);
    assert.equal(engage(fixture.scheduler, fixture.player, fixture.mob), false);
  });

  it('refuses a sleeper, in either role', () => {
    // §3: you cannot open a fight you are not conscious for.
    const fixture = makeFixture();
    fixture.sim.setStance(fixture.player, { status: 'sleeping' });
    assert.equal(canEngage(fixture.player), false);
    assert.equal(engage(fixture.scheduler, fixture.player, fixture.mob), false);
  });

  it('clears one pointer and not the other, because breaking is not symmetric', () => {
    // §2's third consequence, and the reason §5 has to enumerate. A mob whose target ran is *still
    // engaged* until something clears it.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    retaliate(fixture.scheduler, fixture.mob, fixture.player);
    assert.equal(fixture.mob.fighting, fixture.player.id);

    disengage(fixture.scheduler, fixture.player);
    assert.equal(fixture.player.fighting, undefined);
    assert.equal(fixture.mob.fighting, fixture.player.id, 'the dummy is still swinging');
  });

  it('records who it just stopped fighting', () => {
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    disengage(fixture.scheduler, fixture.player);
    assert.equal(fixture.player.wasFighting, fixture.mob.id);
  });

  it('cancels the pending swing when it disengages', () => {
    // Or a stopped fight resolves one more blow a beat later, which reads as the game hitting you after
    // you got away.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    assert.equal(fixture.scheduler.has(fixture.player.id, 'swing'), true);
    disengage(fixture.scheduler, fixture.player);
    assert.equal(fixture.scheduler.has(fixture.player.id, 'swing'), false);
  });
});

/* -------------------------------------------------------------------------- */
/* Blows                                                                       */
/* -------------------------------------------------------------------------- */

describe('blows', () => {
  it('waits a round before the first one', () => {
    // Opening a fight is not a free hit: the person you jumped gets the same beat to answer in that
    // Phase 9's reaction gave them to run.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    assert.equal(fixture.run(ROUND_MS - 200).length, 0, 'nothing yet');
    assert.ok(fixture.run(400).length >= 1, 'and then a swing');
  });

  it('swings at once when told to, which is what `kill` does', () => {
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    assert.equal(fixture.run(150).length, 1);
  });

  it('takes hit points off, and reports the roll', () => {
    const fixture = makeFixture();
    const before = fixture.mob.hp;
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    const [attack] = fixture.run(150);
    assert.ok(attack);
    assert.ok(attack.natural >= 1 && attack.natural <= 20, 'a d20 was rolled and is reported');
    if (attack.hit) {
      assert.ok(attack.damage > 0);
      assert.equal(fixture.mob.hp, before - attack.damage);
    } else {
      assert.equal(attack.damage, 0);
      assert.equal(fixture.mob.hp, before);
    }
  });

  it('makes the fight mutual by being swung at', () => {
    // Not by being *hit*: being swung at is enough to notice. So a missed opening blow still starts a
    // fight, which is what stops a whiffed attack being consequence-free.
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    fixture.run(150);
    assert.equal(fixture.mob.fighting, fixture.player.id);
  });

  it('does not drop an existing opponent to answer a new attacker', () => {
    // What makes holding aggro possible before there is a threat table to do it with.
    const fixture = makeFixture();
    const second = fixture.sim.spawnMob(dummy({ vnum: 400_02 }), 4000, makeRng(0xbee5));
    assert.ok(second);
    engage(fixture.scheduler, fixture.mob, second);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    fixture.run(150);
    assert.equal(fixture.mob.fighting, second.id, 'still on the one it chose');
  });
});

/* -------------------------------------------------------------------------- */
/* The mercy rule                                                              */
/* -------------------------------------------------------------------------- */

describe('the mercy rule', () => {
  /** A fight where the player is one point from the floor and cannot win it. */
  function doomed(): Fixture {
    const fixture = makeFixture(dummy({ combat: readCombatStats({ level: 1, armour: -200, damage: '20d6+50' }) }));
    fixture.player.hp = 1;
    return fixture;
  }

  it('stops everyone the moment the target goes down', () => {
    // §5, and the reason the dying window is not dead code: auto-attacks cross the threshold and keep
    // going, so without this the interval between standing and dead is one tick nobody ever sees.
    const fixture = doomed();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const attacks = fixture.run(ROUND_MS * 2);

    assert.ok(attacks.some((a) => a.incapacitated), 'the blow that ended it is flagged');
    assert.ok(incapacitated(fixture.player), 'and they are down');
    assert.equal(fixture.mob.fighting, undefined, 'the attacker stopped');
    assert.equal(fixture.player.fighting, undefined);
  });

  it('stops every attacker, not only the one that landed the blow', () => {
    // Found by *scanning*, because there is no fight object to read a participant list from — §2's second
    // consequence, and the reason `attackersOf` exists.
    const fixture = doomed();
    const second = fixture.sim.spawnMob(dummy({ vnum: 400_02 }), 4000, makeRng(0xbee5));
    assert.ok(second);
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    engage(fixture.scheduler, second, fixture.player);

    fixture.run(ROUND_MS * 2);
    assert.equal(fixture.mob.fighting, undefined);
    assert.equal(second.fighting, undefined, 'the bystander stopped too');
  });

  it('leaves the fallen character alive, in the dying window', () => {
    // Phase 13 turns this into death and corpses. Today it is where a fight stops, and the character is
    // still there to be found — which is what makes rescue a thing that can exist at all.
    const fixture = doomed();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    fixture.run(ROUND_MS * 2);
    assert.ok(fixture.sim.get(fixture.player.id), 'still in the world');
    assert.ok(['incapacitated', 'dying', 'dead'].includes(fixture.player.status), fixture.player.status);
  });

  it('will not let a downed body be re-engaged', () => {
    const fixture = doomed();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    fixture.run(ROUND_MS * 2);
    assert.equal(engage(fixture.scheduler, fixture.mob, fixture.player), false);
  });
});

describe('mercy is a player protection, and a mob has none', () => {
  /** A mob with almost no hit points, so one blow decides it. */
  function glassJaw(): Fixture {
    const fixture = makeFixture(dummy({ hp: '1d1+1' }));
    return fixture;
  }

  it('keeps a downed mob attackable, because it fights to the death', () => {
    // The owner's rule, and the reasoning is that a mob has no dying window to protect. Stopping at
    // "incapacitated" would leave a creature standing at −4 hit points that nobody is allowed to finish.
    const fixture = glassJaw();
    fixture.mob.hp = -4;
    fixture.sim.refreshStatus(fixture.mob);
    assert.equal(incapacitated(fixture.mob), true, 'it is down');
    assert.equal(canBeAttacked(fixture.mob), true, 'and still a target');
    assert.equal(engage(fixture.scheduler, fixture.player, fixture.mob), true);
  });

  it('stops only once the mob is actually dead', () => {
    const fixture = glassJaw();
    fixture.mob.hp = -50;
    fixture.sim.refreshStatus(fixture.mob);
    assert.equal(fixture.mob.status, 'dead');
    assert.equal(canBeAttacked(fixture.mob), false, 'nothing left to swing at');
    assert.equal(engage(fixture.scheduler, fixture.player, fixture.mob), false);
  });

  it('stops a player the moment they are incapacitated, not at death', () => {
    // The asymmetry, stated as an assertion. A character at −4 is alive, findable and rescuable, and
    // Phase 13 turns that window into death or recovery. A mob at −4 is just something still to kill.
    const fixture = makeFixture();
    fixture.player.hp = -4;
    fixture.sim.refreshStatus(fixture.player);
    assert.equal(fixture.player.status, 'incapacitated');
    assert.equal(canBeAttacked(fixture.player), false);
  });

  it('fights a mob through its dying window rather than stopping at it', () => {
    // End to end: a mob taken below the incapacitation threshold keeps being swung at until it is dead,
    // where a player in the same state would have ended the fight.
    const fixture = makeFixture(dummy({ hp: '1d1+9', combat: readCombatStats({ level: 1, armour: 0, damage: '1d1+0' }) }));
    fixture.player.combat = { ...fixture.player.combat, damage: { count: 1, sides: 1, bonus: 3 } };
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });

    // Run to a conclusion rather than for a fixed number of rounds: the attacker misses about a third of
    // the time, so a fixed count makes the test a dice roll.
    const attacks: ReturnType<typeof advanceCombat>['attacks'][number][] = [];
    for (let round = 0; round < 30 && fixture.mob.status !== 'dead'; round++) {
      attacks.push(...fixture.run(ROUND_MS));
    }
    assert.equal(fixture.mob.status, 'dead', 'fought all the way to the death');
    // The proof it did not stop early: a player would have ended the fight at −3, and this one kept
    // landing blows well past that.
    const past = attacks.filter((a) => a.hit).length;
    assert.ok(past >= 4, `kept swinging past the point a player would have been spared (${past} hits)`);
    assert.ok(attacks.some((a) => a.incapacitated), 'and the blow that finished it is flagged');
  });
});

describe('a body that cannot defend itself', () => {
  it('is never missed', () => {
    // The owner's rule: no dodging and no armour roll against something already on the floor. Asserted
    // over many swings rather than one, because a single hit proves nothing about a d20.
    const fixture = makeFixture(dummy({ hp: '1d1+999', combat: readCombatStats({ level: 60, armour: -300, damage: '1d1+0' }) }));
    assert.ok(fixture.mob.combat.armourClass >= 30, 'an armour class nothing at level 1 could beat');
    fixture.mob.hp = -4;
    fixture.sim.refreshStatus(fixture.mob);
    assert.equal(cannotDefend(fixture.mob), true);
    // A weapon that does nothing, so the target stays helpless instead of dying after two blows — the
    // dying window is only seven points wide and this test is about the *roll*, not about damage.
    fixture.player.combat = { ...fixture.player.combat, damage: { count: 1, sides: 1, bonus: -1 } };

    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    const attacks: ReturnType<typeof advanceCombat>['attacks'][number][] = [];
    for (let round = 0; round < 15; round++) attacks.push(...fixture.run(ROUND_MS));
    assert.ok(attacks.length >= 8, `enough swings to be meaningful (${attacks.length})`);
    assert.equal(attacks.every((a) => a.hit), true, 'every one landed');
    assert.equal(attacks.every((a) => a.helpless), true, 'and each is flagged as such');
  });

  it('still rolls a die, so the fight stays auditable', () => {
    const fixture = makeFixture(dummy({ hp: '1d1+999' }));
    fixture.mob.hp = -4;
    fixture.sim.refreshStatus(fixture.mob);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    const [attack] = fixture.run(150);
    assert.ok(attack);
    assert.ok(attack.natural >= 1 && attack.natural <= 20);
  });

  it('never counts a natural 1 as a fumble against it', () => {
    // A 1 against something that cannot stop the blow is not a fumble; it is a hit on a body that was
    // not going to defend either way.
    const fixture = makeFixture(dummy({ hp: '1d1+999' }));
    fixture.mob.hp = -4;
    fixture.sim.refreshStatus(fixture.mob);
    fixture.player.combat = { ...fixture.player.combat, damage: { count: 1, sides: 1, bonus: -1 } };
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    const attacks: ReturnType<typeof advanceCombat>['attacks'][number][] = [];
    for (let round = 0; round < 60; round++) attacks.push(...fixture.run(ROUND_MS));
    assert.equal(attacks.some((a) => a.natural === 1), true, 'a 1 came up over sixty rounds');
    assert.equal(attacks.every((a) => !a.fumble), true, 'and none of them was a fumble');
  });

  it('applies to a sleeper too', () => {
    const fixture = makeFixture();
    fixture.sim.setStance(fixture.mob, { status: 'sleeping' });
    assert.equal(cannotDefend(fixture.mob), true);
  });

  it('leaves a defending body to the ordinary roll', () => {
    const fixture = makeFixture(dummy({ combat: readCombatStats({ level: 60, armour: -300, damage: '1d1+0' }) }));
    assert.equal(cannotDefend(fixture.mob), false);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    const attacks: ReturnType<typeof advanceCombat>['attacks'][number][] = [];
    for (let round = 0; round < 15; round++) attacks.push(...fixture.run(ROUND_MS));
    assert.equal(attacks.some((a) => !a.hit), true, 'an armour class that high is missed sometimes');
  });
});

describe('threat decides who a mob fights', () => {
  /** A second player, so there is somebody to take aggro from. */
  function pair(): Fixture & { readonly other: Player } {
    const fixture = makeFixture(dummy({ hp: '1d1+9999' }));
    const other = fixture.sim.spawn('Other');
    return { ...fixture, other };
  }

  it('credits threat to whoever dealt the damage', () => {
    const fixture = pair();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    fixture.run(ROUND_MS * 3);
    const table = fixture.book.get(fixture.mob.id);
    assert.ok(table);
    assert.ok(threatOf(table, fixture.player.id) > 0, 'the attacker is on the table');
    assert.equal(threatOf(table, fixture.other.id), 0, 'the bystander is not');
  });

  it('turns on a challenger who clears the margin', () => {
    // The payoff, end to end: two attackers, one hitting far harder, and the mob changes its mind.
    const fixture = pair();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const table = threatTableFor(fixture.book, fixture.mob);
    addThreat(table, fixture.player.id, 100);
    addThreat(table, fixture.other.id, 500);

    fixture.run(ROUND_MS + 200);
    assert.equal(fixture.mob.fighting, fixture.other.id, 'it turned');
  });

  it('holds its target against a challenger inside the margin', () => {
    const fixture = pair();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const table = threatTableFor(fixture.book, fixture.mob);
    addThreat(table, fixture.player.id, 100);
    addThreat(table, fixture.other.id, 104);

    fixture.run(ROUND_MS * 3);
    assert.equal(fixture.mob.fighting, fixture.player.id, 'five per cent is not enough to pull it off');
  });

  it('reports the switch so it can be announced', () => {
    const fixture = pair();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const table = threatTableFor(fixture.book, fixture.mob);
    addThreat(table, fixture.other.id, 900);

    const switches: ReturnType<typeof advanceCombat>['switches'][number][] = [];
    for (let i = 0; i < 40; i++) {
      switches.push(...advanceCombat(fixture.sim, fixture.scheduler, fixture.book, fixture.ledger, fixture.rng, 100).switches);
    }
    assert.equal(switches.length >= 1, true);
    assert.equal(switches[0]?.to.id, fixture.other.id);
    assert.equal(switches[0]?.from?.id, fixture.player.id);
  });

  it('switches through disengage, so no stale pointer survives', () => {
    // Section 2's first consequence, at the one call site that actually retargets. `engage` refuses an
    // actor that is already fighting, so a switch that forgot to disengage would silently do nothing.
    const fixture = pair();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    addThreat(threatTableFor(fixture.book, fixture.mob), fixture.other.id, 900);
    fixture.run(ROUND_MS * 2);
    assert.equal(fixture.mob.fighting, fixture.other.id);
    assert.equal(fixture.mob.wasFighting, fixture.player.id, 'and it remembers who it dropped');
  });

  it('falls to the next entry when the leader leaves the room', () => {
    const fixture = pair();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const table = threatTableFor(fixture.book, fixture.mob);
    addThreat(table, fixture.player.id, 900);
    addThreat(table, fixture.other.id, 10);

    fixture.sim.relocate(fixture.player, 4001);
    fixture.run(ROUND_MS * 2);
    assert.equal(fixture.mob.fighting, fixture.other.id, 'no margin defended a target that is gone');
  });

  it('forgets a character everywhere when they leave the world', () => {
    const fixture = pair();
    addThreat(threatTableFor(fixture.book, fixture.mob), fixture.player.id, 500);
    forgetThreat(fixture.book, fixture.player.id);
    assert.equal(threatOf(fixture.book.get(fixture.mob.id)!, fixture.player.id), 0);
  });
});

describe('opening on the weakest thing in the room', () => {
  it('prefers the softer of two candidates', () => {
    // Duris' rule, used only where there is no threat to read. The bystander is on far fewer hit points,
    // so that is who a fresh arrival goes for.
    const fixture = makeFixture();
    const weak = fixture.sim.spawn('Weakling');
    weak.hp = 3;
    assert.equal(openingTarget(fixture.sim, fixture.mob)?.id, weak.id);
  });

  it('answers nothing in an empty room', () => {
    const fixture = makeFixture();
    fixture.sim.remove(fixture.player.id);
    assert.equal(openingTarget(fixture.sim, fixture.mob), undefined);
  });

  it('ignores anybody already past saving', () => {
    const fixture = makeFixture();
    fixture.player.hp = -5;
    fixture.sim.refreshStatus(fixture.player);
    assert.equal(openingTarget(fixture.sim, fixture.mob), undefined);
  });
});

describe('assist -- the room that comes to help', () => {
  const protector = (over: Partial<MobTemplate> = {}): MobTemplate =>
    dummy({ vnum: 400_09, name: 'a castle guard', aggro: { ...passiveRule(1), assists: true }, ...over });

  /** Everything can see everything, so a test about assisting is not a test about light. */
  const sighted = () => true;

  it('joins a fight beside it', () => {
    const fixture = makeFixture();
    const guard = fixture.sim.spawnMob(protector(), 4000, makeRng(0x9a12));
    assert.ok(guard);
    // The player is attacking the dummy; the guard should turn on the player.
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    const events = advanceAssists(fixture.sim, fixture.scheduler, sighted);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.helper.id, guard.id);
    assert.equal(events[0]?.foe.id, fixture.player.id);
    assert.equal(guard.fighting, fixture.player.id);
  });

  it('does nothing without ACT_PROTECTOR', () => {
    const fixture = makeFixture();
    const bystander = fixture.sim.spawnMob(dummy({ vnum: 400_08 }), 4000, makeRng(0x9a13));
    assert.ok(bystander);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    assert.deepEqual(advanceAssists(fixture.sim, fixture.scheduler, sighted), []);
    assert.equal(bystander.fighting, undefined);
  });

  it('does not go looking for a second fight while already in one', () => {
    // The source's first refusal: `if (IS_FIGHTING(ch)) return NULL`.
    const fixture = makeFixture();
    const guard = fixture.sim.spawnMob(protector(), 4000, makeRng(0x9a12));
    assert.ok(guard);
    const other = fixture.sim.spawn('Other');
    engage(fixture.scheduler, guard, other, { immediate: true });
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    assert.deepEqual(advanceAssists(fixture.sim, fixture.scheduler, sighted), []);
    assert.equal(guard.fighting, other.id, 'still on the one it chose');
  });

  it('refuses when it cannot make the foe out', () => {
    const fixture = makeFixture();
    const guard = fixture.sim.spawnMob(protector(), 4000, makeRng(0x9a12));
    assert.ok(guard);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    assert.deepEqual(advanceAssists(fixture.sim, fixture.scheduler, () => false), []);
  });

  it('does not reach into the next room', () => {
    // Room-scoped, which is `find_protector_target`'s own limit. The cry-for-help that carries further is
    // ACT2_COMBAT_NEARBY, and the simple .mob record has no second action word to read it from.
    const fixture = makeFixture();
    const guard = fixture.sim.spawnMob(protector(), 4000, makeRng(0x9a12));
    assert.ok(guard);
    fixture.sim.relocate(guard, 4001);
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    assert.deepEqual(advanceAssists(fixture.sim, fixture.scheduler, sighted), []);
  });

  it('will not help a player, because nothing models allegiance yet', () => {
    // A mob wading in on a player's side needs charm or grouping, which are Phases 18 and 20.
    const fixture = makeFixture();
    const guard = fixture.sim.spawnMob(protector(), 4000, makeRng(0x9a12));
    assert.ok(guard);
    const other = fixture.sim.spawn('Other');
    // Two players fighting each other, and no mob involved at all.
    engage(fixture.scheduler, fixture.player, other, { immediate: true });
    retaliate(fixture.scheduler, other, fixture.player);

    assert.deepEqual(advanceAssists(fixture.sim, fixture.scheduler, sighted), []);
  });
});

describe('a mob fights its aggressors, and nobody else', () => {
  /**
   * The owner's rule, in their own scenario: start a bar fight, get killed, and the thing you picked the
   * fight with must not round on the other drinkers. But somebody who waded in on your side *has* touched
   * it, and that fight carries on.
   *
   * A passive mob throughout, so nothing here can be explained away by aggression — the only reason it
   * ever swings at anybody is that they hit it first.
   */
  function inn(): Fixture & { readonly drinker: Player } {
    const fixture = makeFixture(dummy({ hp: '1d1+9999' }));
    const drinker = fixture.sim.spawn('Drinker');
    return { ...fixture, drinker };
  }

  it('does not round on a bystander when the aggressor goes down', () => {
    const fixture = inn();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);
    fixture.run(ROUND_MS * 2);
    assert.equal(fixture.mob.fighting, fixture.player.id, 'it is fighting the one who started it');

    // The brawler goes down. The drinker has done nothing at all.
    fixture.player.hp = -20;
    fixture.sim.refreshStatus(fixture.player);
    fixture.run(ROUND_MS * 3);

    assert.equal(fixture.mob.fighting, undefined, 'the fight is over');
    assert.notEqual(fixture.mob.fighting, fixture.drinker.id, 'and the bystander was left alone');
  });

  it('does not round on a bystander when the aggressor simply leaves', () => {
    const fixture = inn();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);
    fixture.run(ROUND_MS * 2);

    fixture.sim.relocate(fixture.player, 4001);
    fixture.run(ROUND_MS * 3);
    assert.equal(fixture.mob.fighting, undefined);
  });

  it('keeps fighting whoever waded in, once the one who started it is down', () => {
    // The other half. The drinker joins the brawl and lands a blow, so they are on the table — and when
    // the instigator drops, the mob turns to the person who is still hitting it.
    const fixture = inn();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);
    engage(fixture.scheduler, fixture.drinker, fixture.mob, { immediate: true });
    fixture.run(ROUND_MS * 3);
    assert.ok(threatOf(threatTableFor(fixture.book, fixture.mob), fixture.drinker.id) > 0, 'the helper is on the table');

    fixture.player.hp = -20;
    fixture.sim.refreshStatus(fixture.player);
    fixture.run(ROUND_MS * 3);

    assert.equal(fixture.mob.fighting, fixture.drinker.id, 'the fight carries on with the one who helped');
  });

  it('drops the table once there is nobody left who touched it', () => {
    // Otherwise walking back into the inn an hour later means being attacked over a grudge, which is
    // memory's job (`MobAwareness`) and not threat's.
    const fixture = inn();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    retaliate(fixture.scheduler, fixture.mob, fixture.player);
    fixture.run(ROUND_MS * 2);
    fixture.sim.relocate(fixture.player, 4001);
    fixture.run(ROUND_MS * 3);
    assert.equal(fixture.book.has(fixture.mob.id), false, 'no grudge kept for an empty room');
  });
});

describe('helping somebody is joining their fight', () => {
  /**
   * The seam Phase 20's heals and protection spells call. Nothing calls it yet, so these tests are the
   * only consumer — and they are worth having now, because the rule is the owner's and easy to get wrong
   * in a way that only shows up when a party wipes and the mob strolls off.
   */
  function party(): Fixture & { readonly healer: Player } {
    const fixture = makeFixture(dummy({ hp: '1d1+9999' }));
    const healer = fixture.sim.spawn('Healer');
    return { ...fixture, healer };
  }

  it('puts a healer on the table of whatever their ally is fighting', () => {
    const fixture = party();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });

    const joined = joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player);
    assert.deepEqual(joined.map((m) => m.id), [fixture.mob.id]);
    assert.equal(isParticipant(threatTableFor(fixture.book, fixture.mob), fixture.healer.id), true);
  });

  it('counts a heal that restored nothing', () => {
    const fixture = party();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player, 0);
    assert.equal(threatOf(threatTableFor(fixture.book, fixture.mob), fixture.healer.id), 0);
    assert.equal(isParticipant(threatTableFor(fixture.book, fixture.mob), fixture.healer.id), true);
  });

  it('credits threat when there is some to credit', () => {
    const fixture = party();
    engage(fixture.scheduler, fixture.player, fixture.mob, { immediate: true });
    joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player, 40);
    assert.equal(threatOf(threatTableFor(fixture.book, fixture.mob), fixture.healer.id), 40);
  });

  it('works in both directions — helping the attacked and helping the attacker', () => {
    // A mob swinging at your ally is a foe even if the ally never swung back.
    const fixture = party();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    const joined = joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player);
    assert.deepEqual(joined.map((m) => m.id), [fixture.mob.id]);
  });

  it('leaves the mob able to turn on the healer once the front line is gone', () => {
    // The whole point, end to end. The healer deals no damage at all; the mob must still have somebody
    // to fight when the person it was fighting drops.
    const fixture = party();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player);

    fixture.player.hp = -20;
    fixture.sim.refreshStatus(fixture.player);
    fixture.run(ROUND_MS * 3);

    assert.equal(fixture.mob.fighting, fixture.healer.id, 'it turned on the healer, as it should');
  });

  it('does nothing for somebody who is in no fight', () => {
    const fixture = party();
    assert.deepEqual(joinBySupporting(fixture.book, fixture.ledger, fixture.sim, fixture.healer, fixture.player), []);
  });
});

describe('tearing a fight down', () => {
  it('clears both directions for a departing actor', () => {
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.player, fixture.mob);
    retaliate(fixture.scheduler, fixture.mob, fixture.player);

    const changed = clearEngagements(fixture.scheduler, fixture.sim, fixture.player);
    assert.equal(changed.length, 2);
    assert.equal(fixture.player.fighting, undefined);
    assert.equal(fixture.mob.fighting, undefined);
  });

  it('stops swinging at something that has left the world', () => {
    const fixture = makeFixture();
    engage(fixture.scheduler, fixture.mob, fixture.player, { immediate: true });
    fixture.sim.remove(fixture.player.id);
    fixture.run(ROUND_MS + 200);
    assert.equal(fixture.mob.fighting, undefined, 'the pointer did not outlive the entity');
  });
});

/** Nothing in here should ever need this, but a stray `Actor` import would otherwise be unused. */
const _typecheck: (a: Actor) => number = (a) => a.id;
void _typecheck;
