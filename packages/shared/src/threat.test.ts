/**
 * Threat: the table, and the margin that makes tanking possible.
 *
 * The hysteresis tests are the ones that matter. §2.7 says the detail *"is not optional"* — with a bare
 * `>` two similar attackers make a mob spin between them every round, which looks broken and makes
 * holding aggro impossible. If those tests ever fail, the fix is not to relax the margin.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  THREAT_SWITCH_MARGIN,
  addThreat,
  dropThreat,
  isParticipant,
  markParticipant,
  pickByThreat,
  pickByWeakness,
  threatOf,
  toughnessOf,
  type ThreatTable,
} from './index.ts';

const table = (entries: Record<number, number> = {}): ThreatTable =>
  new Map(Object.entries(entries).map(([id, value]) => [Number(id), value]));

describe('the table', () => {
  it('accumulates', () => {
    const t: ThreatTable = new Map();
    addThreat(t, 1, 10);
    addThreat(t, 1, 5);
    assert.equal(threatOf(t, 1), 15);
  });

  it('ignores nothing and negatives, rather than letting a heal-for-zero erase a tank', () => {
    const t = table({ 1: 10 });
    addThreat(t, 1, 0);
    addThreat(t, 1, -100);
    assert.equal(threatOf(t, 1), 10);
  });

  it('answers zero for somebody it has never heard of', () => {
    assert.equal(threatOf(new Map(), 42), 0);
  });

  it('forgets on request, for the disconnect path', () => {
    const t = table({ 7: 99 });
    assert.equal(dropThreat(t, 7), true);
    assert.equal(threatOf(t, 7), 0);
  });
});

describe('hysteresis — the reason tanking can exist', () => {
  it('holds its target against a challenger inside the margin', () => {
    // The failure §2.7 describes: two attackers of similar output, and a mob that spins between them
    // every round. 100 versus 105 is a five per cent lead and must not move it.
    const t = table({ 1: 100, 2: 105 });
    assert.equal(pickByThreat(t, [1, 2], 1), 1);
  });

  it('turns once the challenger clears the margin', () => {
    // The owner's own example: the warrior deals twice the damage and the dragon drops the ranger.
    const t = table({ 1: 100, 2: 111 });
    assert.equal(pickByThreat(t, [1, 2], 1), 2);
  });

  it('treats an exact tie at the margin as not worth turning for', () => {
    const t = table({ 1: 100, 2: 100 * THREAT_SWITCH_MARGIN });
    assert.equal(pickByThreat(t, [1, 2], 1), 1, 'strictly greater, not greater-or-equal');
  });

  it('does not spin when two attackers trade the lead repeatedly', () => {
    // The regression test for the bug the margin exists to prevent. Two attackers alternating small
    // amounts of damage: with a bare `>` this flips every single round.
    const t = table({ 1: 100, 2: 98 });
    let current: number | undefined = 1;
    let flips = 0;
    for (let round = 0; round < 20; round++) {
      addThreat(t, round % 2 === 0 ? 2 : 1, 3);
      const next = pickByThreat(t, [1, 2], current);
      if (next !== current) flips++;
      current = next;
    }
    assert.ok(flips <= 2, `held its target through twenty rounds of trading (${flips} switches)`);
  });
});

describe('falling through when a target is gone', () => {
  it('takes the top of the table with no margin when it has no current target', () => {
    const t = table({ 1: 10, 2: 5 });
    assert.equal(pickByThreat(t, [1, 2], undefined), 1);
  });

  it('falls to the next entry when the leader becomes unreachable', () => {
    // §2.7: on target death, or when the top-threat target cannot be reached, the mob falls through. The
    // margin is deliberately *not* applied here — there is nothing to defend.
    const t = table({ 1: 1000, 2: 5 });
    assert.equal(pickByThreat(t, [2], 1), 2);
  });

  it('answers nothing when there is nobody left', () => {
    assert.equal(pickByThreat(table({ 1: 10 }), [], 1), undefined);
  });

  it('never picks somebody who has done nothing to it', () => {
    // **The bar-fight rule.** Start a brawl, go down, and the thing you picked the fight with must not
    // round on the other drinkers. An aggressive mob still attacks strangers on sight — but through the
    // aggression predicate and Phase 9's reaction, not through the threat table.
    assert.equal(pickByThreat(new Map(), [9], undefined), undefined);
  });

  it('does keep fighting whoever waded in on your side', () => {
    // The other half of the same rule, and the reason it is not simply "stop when your target dies": an
    // assister has dealt damage, so they are on the table and the fight carries on with them.
    const t = table({ 1: 400, 2: 60 });
    assert.equal(pickByThreat(t, [2], 1), 2, 'the helper is still owed a fight');
  });

  it('ignores bystanders while choosing among real aggressors', () => {
    const t = table({ 1: 50 });
    assert.equal(pickByThreat(t, [1, 2, 3], undefined), 1, 'and not the two who did nothing');
  });

  it('keeps a healer in the fight, even on zero threat', () => {
    // **The rule that keeps a mob from walking away from the one who kept the party standing.** Support
    // is participation: a heal, a protection spell, anything that helps the aggressor puts you on the
    // table. Damage decides the *ordering*; presence decides whether you are in the fight at all.
    const t: ThreatTable = new Map();
    markParticipant(t, 5);
    assert.equal(isParticipant(t, 5), true);
    assert.equal(threatOf(t, 5), 0);
    assert.equal(pickByThreat(t, [5], undefined), 5, 'the front line died; the healer is still owed');
  });

  it('still tells a healer apart from somebody who walked in off the street', () => {
    const t: ThreatTable = new Map();
    markParticipant(t, 5);
    assert.equal(pickByThreat(t, [5, 6], undefined), 5, 'and not the passer-by');
  });

  it('prefers a real attacker over a healer, since threat orders and presence only qualifies', () => {
    const t: ThreatTable = new Map();
    markParticipant(t, 5);
    addThreat(t, 6, 200);
    assert.equal(pickByThreat(t, [5, 6], undefined), 6);
  });

  it('marks a healer whose heal restored nothing', () => {
    // A heal on somebody already at full health still joined the fight.
    const t: ThreatTable = new Map();
    addThreat(t, 5, 0);
    assert.equal(isParticipant(t, 5), true);
  });

  it('breaks ties on entity id, so a fight replays identically', () => {
    const t = table({ 5: 10, 3: 10, 8: 10 });
    assert.equal(pickByThreat(t, [5, 3, 8], undefined), 3);
    assert.equal(pickByThreat(t, [8, 5, 3], undefined), 3, 'and not on iteration order');
  });
});

describe('weakness, for the opening choice', () => {
  it('prefers the softer target', () => {
    assert.ok(toughnessOf({ hp: 20, fighting: true }) < toughnessOf({ hp: 200, fighting: true }));
  });

  it('halves anyone not already fighting, which is what makes a fresh arrival dangerous', () => {
    // Duris' own rule, and its consequence: a mob walking in goes for the bystander rather than the
    // person already locked in combat with something else.
    assert.equal(toughnessOf({ hp: 100, fighting: false }), toughnessOf({ hp: 100, fighting: true }) / 2);
  });

  it('carries the class weighting, inert until there are classes', () => {
    assert.equal(toughnessOf({ hp: 90, fighting: true, bloc: 'caster' }), 60);
    assert.equal(toughnessOf({ hp: 90, fighting: true, bloc: 'warrior' }), 180);
    assert.equal(toughnessOf({ hp: 90, fighting: true }), 90, 'and no weighting when nothing is known');
  });

  it('picks the lowest score, because lower is more attractive', () => {
    const chosen = pickByWeakness([
      { id: 1, subject: { hp: 300, fighting: true } },
      { id: 2, subject: { hp: 40, fighting: true } },
      { id: 3, subject: { hp: 120, fighting: true } },
    ]);
    assert.equal(chosen, 2);
  });

  it('answers nothing for an empty room', () => {
    assert.equal(pickByWeakness([]), undefined);
  });

  it('never returns a negative score for a body already below zero', () => {
    // Hit points go negative in the dying window; a score of −40 would make a corpse the most attractive
    // thing in the room by a mile.
    assert.equal(toughnessOf({ hp: -8, fighting: false }), 0);
  });
});
