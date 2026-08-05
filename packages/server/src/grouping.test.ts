/**
 * Who adventures with whom — Phase 18's second half.
 *
 * The rules under test are the ones that decide who is *in* a party, because everything downstream —
 * whose kill it is, who hears a `gsay`, whose health is on your roster — reads that one list. The
 * experience arithmetic is not here: it is pure maths over a member count and lives in
 * `@mygame/shared`'s `experience.test.ts` beside the split it modifies.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityId } from '@mygame/shared';

import {
  consentedTo,
  depart,
  disband,
  enrol,
  forgetGrouping,
  grantConsent,
  grouped,
  hasConsent,
  leaderFor,
  leads,
  MAX_GROUP_MEMBERS,
  membersWith,
  newGrouping,
  revokeConsent,
} from './grouping.ts';

const ANA = 1 as EntityId;
const BEN = 2 as EntityId;
const CAI = 3 as EntityId;
const DEV = 4 as EntityId;

/** Consent then enrol, which is the two-step handshake every group in the game is made of. */
function join(state: ReturnType<typeof newGrouping>, leader: EntityId, member: EntityId) {
  grantConsent(state, member, leader);
  return enrol(state, leader, member);
}

describe('consent', () => {
  it('is given by the joiner and needed by the leader, which is the direction that reads backwards', () => {
    const state = newGrouping();
    grantConsent(state, BEN, ANA);
    assert.equal(hasConsent(state, BEN, ANA), true);
    assert.equal(hasConsent(state, ANA, BEN), false, 'and it is not mutual');
  });

  it('revokes all of it at once, because bare `consent` is `clear_links`', () => {
    const state = newGrouping();
    grantConsent(state, BEN, ANA);
    grantConsent(state, BEN, CAI);
    assert.deepEqual(consentedTo(state, BEN), [ANA, CAI]);
    revokeConsent(state, BEN);
    assert.deepEqual(consentedTo(state, BEN), []);
  });

  it('cannot be given to yourself, and saying it twice is not news', () => {
    const state = newGrouping();
    assert.equal(grantConsent(state, BEN, BEN), false);
    assert.equal(grantConsent(state, BEN, ANA), true);
    assert.equal(grantConsent(state, BEN, ANA), false);
  });
});

describe('grouping', () => {
  it('refuses without consent, which is the whole difference from following', () => {
    const state = newGrouping();
    // Walking behind somebody costs them nothing; being in their group divides their experience.
    assert.deepEqual(enrol(state, ANA, BEN), { ok: false, why: 'no-consent' });
    assert.deepEqual(membersWith(state, ANA), []);
  });

  it('creates the group on the first enrolment, leader at the head', () => {
    const state = newGrouping();
    assert.deepEqual(join(state, ANA, BEN), { ok: true, merged: [] });
    assert.deepEqual(membersWith(state, ANA), [ANA, BEN]);
    assert.equal(leaderFor(state, BEN), ANA);
    assert.equal(leads(state, ANA), true);
    assert.equal(leads(state, BEN), false);
    assert.equal(grouped(state, ANA, BEN), true);
  });

  it('keeps members in join order, because promotion depends on it', () => {
    const state = newGrouping();
    join(state, ANA, CAI);
    join(state, ANA, BEN);
    assert.deepEqual(membersWith(state, ANA), [ANA, CAI, BEN]);
  });

  it('refuses a member of another group, whose leaving is theirs to do', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    grantConsent(state, BEN, CAI);
    assert.deepEqual(enrol(state, CAI, BEN), { ok: false, why: 'in-another-group' });
    assert.equal(leaderFor(state, BEN), ANA, 'and it costs them nothing');
  });

  it('refuses a leader who is not the head of their own group', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    grantConsent(state, CAI, BEN);
    assert.deepEqual(enrol(state, BEN, CAI), { ok: false, why: 'not-leader' });
  });

  it('merges when the joiner leads a group, bringing their members across', () => {
    const state = newGrouping();
    join(state, BEN, CAI);
    join(state, BEN, DEV);
    // ANA enrols BEN, who is somebody else's leader. The party comes with them.
    grantConsent(state, BEN, ANA);
    assert.deepEqual(enrol(state, ANA, BEN), { ok: true, merged: [CAI, DEV] });
    assert.deepEqual(membersWith(state, ANA), [ANA, BEN, CAI, DEV]);
    assert.equal(leaderFor(state, CAI), ANA);
  });

  it('caps at thirteen, and says so only to somebody who would otherwise be let in', () => {
    const state = newGrouping();
    for (let i = 0; i < MAX_GROUP_MEMBERS - 1; i++) join(state, ANA, (100 + i) as EntityId);
    assert.equal(membersWith(state, ANA).length, MAX_GROUP_MEMBERS);

    // Consent first: the refusal order is the source's, and checking size before consent would leak
    // the fact that a stranger has consented to you.
    const outsider = 200 as EntityId;
    assert.deepEqual(enrol(state, ANA, outsider), { ok: false, why: 'no-consent' });
    grantConsent(state, outsider, ANA);
    assert.deepEqual(enrol(state, ANA, outsider), { ok: false, why: 'full' });
  });

  it('refuses yourself and a member you already have', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    assert.deepEqual(enrol(state, ANA, ANA), { ok: false, why: 'self' });
    assert.deepEqual(enrol(state, ANA, BEN), { ok: false, why: 'already' });
  });
});

describe('leaving a group', () => {
  it('promotes the second in the list when the leader goes', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    join(state, ANA, CAI);

    assert.deepEqual(depart(state, ANA), { remaining: [BEN, CAI], promoted: BEN });
    assert.equal(leaderFor(state, CAI), BEN);
    assert.equal(leads(state, BEN), true);
  });

  it('dissolves at one member, because one person is not a group', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    // The one left is named rather than the caller having to work out who it was — they did nothing,
    // and a party that has quietly become a solo character must stop dividing their experience.
    assert.deepEqual(depart(state, BEN), { remaining: [], dissolved: ANA });
    assert.deepEqual(membersWith(state, ANA), []);
    assert.equal(leaderFor(state, ANA), undefined);
  });

  it('is a no-op for somebody in no group, so callers need no guard', () => {
    const state = newGrouping();
    assert.deepEqual(depart(state, ANA), { remaining: [] });
  });

  it('disbands from the leader, throwing everybody out and keeping nobody grouped', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    join(state, ANA, CAI);

    assert.deepEqual(disband(state, ANA), [BEN, CAI]);
    assert.deepEqual(membersWith(state, ANA), []);
    assert.equal(grouped(state, ANA, BEN), false);
    // The leader's own entry goes too. A group id left pointing at nothing is what a later `group`
    // command would read.
    assert.equal(leaderFor(state, ANA), undefined);
  });

  it('refuses to disband from somebody who does not lead', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    join(state, ANA, CAI);
    assert.deepEqual(disband(state, BEN), []);
    assert.deepEqual(membersWith(state, ANA), [ANA, BEN, CAI]);
  });

  it('forgets a disconnected character in every direction', () => {
    const state = newGrouping();
    join(state, ANA, BEN);
    join(state, ANA, CAI);
    grantConsent(state, DEV, ANA);
    grantConsent(state, ANA, DEV);

    // Entity ids are reissued: a leftover membership would put the next character handed this id into
    // a stranger's party, and a leftover consent would let a stranger enrol them unasked.
    assert.deepEqual(forgetGrouping(state, ANA), { remaining: [BEN, CAI], promoted: BEN });
    assert.deepEqual(consentedTo(state, ANA), []);
    assert.equal(hasConsent(state, DEV, ANA), false);
  });
});
