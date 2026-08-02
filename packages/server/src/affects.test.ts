/**
 * Affects in the running simulation: the rest cycle, and the recompute discipline.
 *
 * The primitive is `shared`'s and is tested there. What is tested here is the part the server owns and
 * can get wrong alone:
 *
 * - **The rest cycle is driven by the one writer of `status`.** Nothing may settle into a rest the
 *   mechanism does not know about, and nothing may keep a wait it has broken.
 * - **Derived stats follow the list, in the same breath.** `recompute` is this project's
 *   `affect_total`, and the whole value of it is that no path can change the list without the stats
 *   moving with it.
 * - **Expiry events are per cause.** `second_wind` is three nodes and ends once — three events would be
 *   three log lines and three re-armings of the clock.
 * - **The regeneration bonus actually reaches a pool.** The point of Phase 5b's second consumer is that
 *   `modifier` and `apply` have a caller, so a bar has to visibly move faster because of one.
 *
 * Everything is driven by the 100 ms tick, so every duration below is expressed in ticks and there is
 * no clock to make these flake.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  SECOND_WIND_AFTER_MS,
  SECOND_WIND_BONUS,
  SECOND_WIND_DURATION_MS,
  TICK_MS,
  boundsOf,
  hasType,
  newAffect,
  summariseAffects,
  type Affect,
  type Room,
  type Zone,
} from '@mygame/shared';
import { makeRng } from '@mygame/shared';
import { LIGHT_SOURCES } from '@mygame/shared/light.ts';
import { DEFAULT_LIGHT_RADIUS } from '@mygame/shared/vision.ts';

import { Simulation, type Player, type TickResult } from './sim.ts';
import { GameWorld } from './world.ts';

/** Two rooms, which is all a test about time needs. */
function testZone(): Zone {
  const rooms: Room[] = [
    { id: 7000, zone: 700, name: 'A Quiet Corner', sector: 'inside', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 7001 } } },
    { id: 7001, zone: 700, name: 'Another', sector: 'inside', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 7000 } } },
  ];
  return { id: 700, name: 'Test Rest', rooms, bounds: boundsOf(rooms), entryRoom: 7000 };
}

function makeSim(): { sim: Simulation; player: Player } {
  const sim = new Simulation(new GameWorld([testZone()], { zone: 700, room: null }));
  return { sim, player: sim.spawn('Sitter', makeRng(1)) };
}

function run(sim: Simulation, ticks: number): TickResult[] {
  const results: TickResult[] = [];
  for (let i = 0; i < ticks; i++) results.push(sim.tick());
  return results;
}

const ticksFor = (ms: number): number => Math.ceil(ms / TICK_MS);

/* -------------------------------------------------------------------------- */

describe('the rest cycle', () => {
  it('starts the clock when rest starts, and not before', () => {
    const { sim, player } = makeSim();
    // `equal` on the length rather than `deepEqual` against `[]`: the strict assert's signature is
    // `asserts actual is T`, so comparing to an empty literal narrows the field to `never[]` and every
    // read of it below this line becomes a type error.
    assert.equal(player.affects.length, 0, 'standing about earns nothing');

    sim.setStance(player, { status: 'resting' });
    assert.deepEqual(player.affects.map((a) => a.type), ['settling']);
    assert.equal(player.affects[0]?.durationMs, SECOND_WIND_AFTER_MS);
  });

  it('drops the clock the moment rest is broken', () => {
    // The cost of the reward is sitting still. A wait that survived standing up could be collected by
    // resting for three seconds a dozen times.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    run(sim, ticksFor(SECOND_WIND_AFTER_MS) - 5);
    assert.ok(hasType(player.affects, 'settling'), 'nearly there');

    sim.setStance(player, { status: 'normal' });
    assert.deepEqual(player.affects, [], 'and all of it is gone');
  });

  it('does not restart the clock when rest deepens into sleep', () => {
    // Otherwise a player alternating `rest` and `sleep` would never finish it, which is a mechanic that
    // punishes exactly the person paying attention to it.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    run(sim, 100);
    const left = player.affects[0]?.durationMs;

    sim.setStance(player, { status: 'sleeping' });
    assert.equal(player.affects.length, 1);
    assert.equal(player.affects[0]?.durationMs, left, 'the same clock, not a fresh one');
  });

  it('turns the wait into the reward, once, with one event', () => {
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });

    const results = run(sim, ticksFor(SECOND_WIND_AFTER_MS));
    const expired = results.flatMap((r) => r.affectEvents).filter((e) => e.kind === 'expired');

    assert.equal(expired.length, 1, 'the wait ended once');
    assert.equal(expired[0]?.affect.type, 'settling');
    // Three nodes of one cause — the multi-apply idiom. The event carries them because the sentence the
    // player reads ("you catch your second wind") is about the successor.
    assert.equal(expired[0]?.chained.length, 3);
    assert.deepEqual(new Set(expired[0]?.chained.map((a) => a.type)), new Set(['second_wind']));

    assert.equal(sim.affectsOf(player, 'second_wind').length, 3);
    assert.equal(sim.affectsOf(player, 'settling').length, 0);
  });

  it('reports the reward ending once, not once per node', () => {
    // The §4.12 rule in the place it would actually hurt: three log lines saying "your second wind
    // fades" and three re-armings of the wait.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    run(sim, ticksFor(SECOND_WIND_AFTER_MS));

    const results = run(sim, ticksFor(SECOND_WIND_DURATION_MS));
    const faded = results
      .flatMap((r) => r.affectEvents)
      .filter((e) => e.kind === 'expired' && e.affect.type === 'second_wind');
    assert.equal(faded.length, 1);
  });

  it('re-arms the wait when the reward lapses and rest continues', () => {
    // A long rest is a rhythm rather than one bonus and then nothing: 30s of waiting, 60s of reward,
    // repeat. It also means a character who sits down and goes away is visibly doing something.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    run(sim, ticksFor(SECOND_WIND_AFTER_MS) + ticksFor(SECOND_WIND_DURATION_MS));

    assert.equal(sim.affectsOf(player, 'second_wind').length, 0);
    assert.equal(sim.affectsOf(player, 'settling').length, 1, 'and the wait has begun again');
    assert.equal(player.affects[0]?.durationMs, SECOND_WIND_AFTER_MS);
  });

  it('lets the reward be carried into standing up, and does not re-arm after it', () => {
    // The one part meant to be spent elsewhere. A bonus that only applied while resting would be adding
    // regeneration to the state that already has the most of it.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    run(sim, ticksFor(SECOND_WIND_AFTER_MS));
    assert.equal(sim.affectsOf(player, 'second_wind').length, 3);

    sim.setStance(player, { status: 'normal' });
    assert.equal(sim.affectsOf(player, 'second_wind').length, 3, 'you take it with you');

    run(sim, ticksFor(SECOND_WIND_DURATION_MS));
    assert.deepEqual(player.affects, [], 'and when it lapses on your feet, nothing follows it');
  });

  it('shows the player one row for each stage, with a clock on it', () => {
    // The phase's own completion test: a timed effect you can watch expire.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });

    const waiting = sim.selfViewOf(player).affects;
    assert.deepEqual(waiting.map((a) => a.type), ['settling']);
    assert.equal(waiting[0]?.remainingMs, SECOND_WIND_AFTER_MS);

    run(sim, ticksFor(SECOND_WIND_AFTER_MS));
    const rewarded = sim.selfViewOf(player).affects;
    assert.deepEqual(rewarded.map((a) => a.type), ['second_wind'], 'one row, though it is three nodes');
    assert.equal(rewarded[0]?.remainingMs, SECOND_WIND_DURATION_MS);
  });
});

describe('the bonus reaching a pool', () => {
  /**
   * Ticks to gain one hit point, from a wound and a carry both put back to a known state.
   *
   * Resetting both is what makes two of these comparable: left alone, the second measurement would
   * start on whatever fraction of a point the first left in the accumulator. The wound is deliberately
   * **one** point rather than a dramatic number — a level-1 character's maximum is single digits, so a
   * wound of fifty puts them past the death floor, `statusFor` calls them dead, and a corpse does not
   * regenerate at any rate at all.
   */
  function ticksToHeal(sim: Simulation, player: Player): number {
    player.hp = player.maxHp - 1;
    player.regenCarry.hp = 0;
    for (let i = 1; i <= 2_000; i++) {
      sim.tick();
      if (player.hp === player.maxHp) return i;
    }
    return Infinity;
  }

  it('makes a wound close visibly faster, which is the whole point of the demonstrator', () => {
    // `modifier` and `apply` with a live caller. Without this the record would have a field nothing
    // populated — the exact failure ROADMAP rule 1 exists to prevent.
    const plain = makeSim();
    plain.sim.setStance(plain.player, { status: 'resting' });
    const slow = ticksToHeal(plain.sim, plain.player);

    const buffed = makeSim();
    buffed.sim.setStance(buffed.player, { status: 'resting' });
    buffed.sim.addAffect(
      buffed.player,
      newAffect({ type: 'second_wind', durationMs: 60_000, apply: 'hpRegen', modifier: SECOND_WIND_BONUS.hp }),
    );
    const fast = ticksToHeal(buffed.sim, buffed.player);

    assert.ok(fast < slow, `buffed ${fast} ticks should beat plain ${slow}`);
  });

  it('stops helping the moment it lapses', () => {
    // The property `unapply` cannot promise: the rate has to come back to exactly where it started, not
    // near it. Measured as a rate rather than as a total, because a leftover bonus would look like a
    // rounding difference in a total and like a plainly wrong number in a rate.
    const { sim, player } = makeSim();
    sim.setStance(player, { status: 'resting' });
    const before = ticksToHeal(sim, player);

    sim.addAffect(
      player,
      newAffect({ type: 'second_wind', durationMs: 2_000, apply: 'hpRegen', modifier: 99 }),
    );
    const during = ticksToHeal(sim, player);
    assert.ok(during < before, `a huge bonus should be fast: ${during} against ${before}`);

    run(sim, ticksFor(2_000) + 1);
    assert.equal(sim.affectsOf(player, 'second_wind').length, 0, 'it has gone');
    assert.equal(ticksToHeal(sim, player), before, 'the rate is back to base, not merely close to it');
  });
});

describe('recompute — the one derivation point', () => {
  const torch = LIGHT_SOURCES['torch']!;

  it('derives the carried source and the radius from the list, not from a field', () => {
    const { sim, player } = makeSim();
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);

    // Installed as a raw affect rather than through `setCarriedLight`, precisely to prove that the list
    // is the truth: nothing else was told about this torch.
    sim.addAffect(
      player,
      newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'torch' }),
    );
    assert.equal(player.light?.id, 'torch');
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1);

    sim.removeAffects(player, 'light');
    assert.equal(player.light, undefined);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS, 'back to base, by recompute rather than by undo');
  });

  it('takes the best of several light affects rather than the last one added', () => {
    // The list is never longer than one today — `setCarriedLight` uses `replace`, so a second torch
    // throws the first away. Phase 16 makes equipped items further candidates, so the general fold is
    // written now rather than written narrowly and rewritten then. Installed in one call to get both on
    // the list at once, which is the shape equipment will arrive in.
    const { sim, player } = makeSim();
    sim.addAffect(player, [
      newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'lantern' }),
      newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'candle' }),
    ]);
    assert.equal(player.affects.length, 2);
    assert.equal(player.light?.id, 'lantern', 'a candle does not outshine a lantern by arriving later');
    // And the answer does not depend on the order they were installed in.
    sim.removeAffects(player, 'light');
    sim.addAffect(player, [
      newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'candle' }),
      newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'lantern' }),
    ]);
    assert.equal(player.light?.id, 'lantern');
  });

  it('ignores a light affect naming a source the catalogue does not have', () => {
    // Content can be removed between one login and the next. The answer to "you were holding something
    // that no longer exists" is the dark, not a crash.
    const { sim, player } = makeSim();
    sim.addAffect(player, newAffect({ type: 'light', durationMs: 60_000, apply: 'light', context: 'sunbeam' }));
    assert.equal(player.light, undefined);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS);
  });

  it('keeps the carried light out of the display path', () => {
    // It has had its own HUD line and its own log prose since Phase 1. Saying it twice in two
    // vocabularies is worse than saying it once.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, torch);
    assert.deepEqual(summariseAffects(player.affects), []);
    assert.deepEqual(sim.selfViewOf(player).affects, []);
    assert.equal(sim.selfViewOf(player).light?.id, 'torch', 'but the light line still says it');
  });

  it('queues the client for a resync on any change, radius or not', () => {
    // `SelfView.light` and the affect list have both changed by definition, and the client counts their
    // clocks down itself — so it has to be told even when the number it renders for the radius is the
    // same.
    const { sim, player } = makeSim();
    sim.setCarriedLight(player, torch);
    sim.tick();

    sim.addAffect(player, newAffect({ type: 'settling', durationMs: 30_000 }));
    assert.deepEqual(sim.tick().relit.map((p) => p.id), [player.id]);
  });
});

describe('restoring a saved list', () => {
  it('assigns the list and folds once, rather than re-stacking it', () => {
    // A saved list is already a coherent set. Feeding it back through the stacking policies would apply
    // `replace` to nodes that were never stacked, and a three-node cause would arrive as one.
    const { sim, player } = makeSim();
    const saved: Affect[] = [
      newAffect({ type: 'light', durationMs: 12_000, apply: 'light', context: 'torch' }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'hpRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'manaRegen', modifier: 6 }),
    ];
    sim.restoreAffects(player, saved);

    assert.equal(player.affects.length, 3, 'all three, not one');
    assert.equal(player.light?.id, 'torch');
    assert.equal(sim.lightRemaining(player), 12_000);
    assert.equal(player.lightRadius, DEFAULT_LIGHT_RADIUS + 1);
  });

  it('leaves the rest clock agreeing with the ladder after a wholesale replace', () => {
    // Nothing persists the status today, so a real login always arrives `normal` and this never fires in
    // production. It is tested because the invariant belongs to the method rather than to logging in:
    // replacing the whole list must not leave a resting character without a clock.
    const { sim, player } = makeSim();
    player.status = 'resting';
    sim.restoreAffects(player, []);
    assert.ok(hasType(player.affects, 'settling'));
  });
});
