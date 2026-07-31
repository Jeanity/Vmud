/**
 * The scheduler: order, determinism, and lazy cancellation.
 *
 * The tie-break test is the one that matters. Two events due at the same millisecond is the *common* case
 * — every actor engaged on the same tick shares a deadline — and a heap left to order them by whatever the
 * sift happened to do would make the same seed produce two different fights. `CLAUDE.md` rule 3 is not
 * only about `Math.random()`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Scheduler } from './scheduler.ts';

describe('ordering', () => {
  it('returns work in due order regardless of insertion order', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 3, 300);
    scheduler.schedule('swing', 1, 100);
    scheduler.schedule('swing', 2, 200);

    assert.deepEqual(scheduler.advance(1_000).map((e) => e.actor), [1, 2, 3]);
  });

  it('breaks ties on insertion order, so a replay is identical', () => {
    // Three actors engaging on the same tick. Without the sequence number the heap's internal shape
    // decides who swings first, and the same seed can produce two different fights.
    const scheduler = new Scheduler();
    for (const actor of [7, 4, 9, 1]) scheduler.schedule('swing', actor, 500);
    assert.deepEqual(scheduler.advance(500).map((e) => e.actor), [7, 4, 9, 1]);
  });

  it('holds work back until it is actually due', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 1_000);
    assert.deepEqual(scheduler.advance(999), []);
    assert.equal(scheduler.advance(1).length, 1, 'due on the exact millisecond');
  });

  it('accumulates small ticks into one deadline', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 3_000);
    let fired = 0;
    for (let i = 0; i < 30; i++) fired += scheduler.advance(100).length;
    assert.equal(fired, 1, 'one swing out of thirty 100 ms ticks');
  });

  it('carries a payload through untouched', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('command', 5, 0, { text: 'north' });
    assert.deepEqual(scheduler.advance(0)[0]?.data, { text: 'north' });
  });

  it('never schedules into the past', () => {
    // A negative delay would sit at the top of the heap firing every tick for ever.
    const scheduler = new Scheduler();
    scheduler.advance(5_000);
    scheduler.schedule('swing', 1, -1_000);
    assert.equal(scheduler.advance(0).length, 1, 'due immediately, not repeatedly');
    assert.equal(scheduler.advance(10_000).length, 0);
  });

  it('reads time only from advance', () => {
    // Nothing here calls `Date.now()`. A test can therefore run an hour of simulation in no time, and a
    // replay lands on the same events in the same order.
    const scheduler = new Scheduler();
    assert.equal(scheduler.now, 0);
    scheduler.advance(3_600_000);
    assert.equal(scheduler.now, 3_600_000);
  });
});

describe('cancellation', () => {
  it('drops cancelled work when its time comes', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 100);
    scheduler.schedule('swing', 2, 100);
    assert.equal(scheduler.cancel(1), 1);
    assert.deepEqual(scheduler.advance(200).map((e) => e.actor), [2]);
  });

  it('cancels by kind when asked', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 100);
    scheduler.schedule('command', 1, 100);
    assert.equal(scheduler.cancel(1, 'swing'), 1);
    assert.deepEqual(scheduler.advance(200).map((e) => e.kind), ['command']);
  });

  it('cancels everything for one actor when no kind is given', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 100);
    scheduler.schedule('command', 1, 100);
    scheduler.schedule('swing', 2, 100);
    assert.equal(scheduler.cancel(1), 2);
    assert.deepEqual(scheduler.advance(200).map((e) => e.actor), [2]);
  });

  it('answers whether an actor has live work pending', () => {
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 100);
    assert.equal(scheduler.has(1, 'swing'), true);
    assert.equal(scheduler.has(1, 'command'), false);
    scheduler.cancel(1, 'swing');
    assert.equal(scheduler.has(1, 'swing'), false, 'a cancelled entry is not live');
  });

  it('does not leak cancelled entries', () => {
    // Lazy cancellation flags rather than removes, so the only guarantee that matters is that a flagged
    // entry is discarded when its time comes rather than sitting in the heap for ever.
    const scheduler = new Scheduler();
    for (let i = 0; i < 100; i++) scheduler.schedule('swing', i, 50);
    for (let i = 0; i < 100; i++) scheduler.cancel(i);
    assert.equal(scheduler.countLive(), 0);
    assert.deepEqual(scheduler.advance(100), []);
    assert.equal(scheduler.size, 0, 'and the heap is empty afterwards');
  });
});

describe('under load', () => {
  it('keeps due order across many reschedules', () => {
    // The real combat pattern: every fired event schedules itself again. Two actors on different rounds
    // must interleave correctly over a long fight, which is the property `combat.test.ts` depends on.
    const scheduler = new Scheduler();
    scheduler.schedule('swing', 1, 1_000);
    scheduler.schedule('swing', 2, 3_000);
    const order: number[] = [];
    for (let t = 0; t < 12_000; t += 100) {
      for (const event of scheduler.advance(100)) {
        order.push(event.actor);
        scheduler.schedule('swing', event.actor, event.actor === 1 ? 1_000 : 3_000);
      }
    }
    assert.equal(order.filter((a) => a === 1).length, 12);
    assert.equal(order.filter((a) => a === 2).length, 4);
    // The fast actor gets three swings to the slow one's first — and on the tick where both are due, the
    // slow one goes first, because its entry was inserted earlier and that is the tie-break. Worth pinning
    // rather than glossing: it is the visible consequence of the rule that makes replays identical.
    assert.deepEqual(order.slice(0, 4), [1, 1, 2, 1]);
  });
});
