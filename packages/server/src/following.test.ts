/**
 * Who walks behind whom — Phase 18's first half.
 *
 * The rules under test are the ones that stop a train being pathological: no rings, one leader at a
 * time, and nothing left behind when somebody disconnects. Movement itself is not here — the whole
 * point of re-issuing the intent is that a follower's step is an ordinary step, so it is `stepRoom`'s
 * own rules that decide whether it happens and they are already tested.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { EntityId } from '@mygame/shared';

import {
  followersOf,
  forgetFollower,
  leaderOf,
  newFollowing,
  startFollowing,
  stopFollowing,
  wouldLoop,
} from './following.ts';

const ANA = 1 as EntityId;
const BEN = 2 as EntityId;
const CAI = 3 as EntityId;

describe('following', () => {
  it('records both directions, because both are asked on the hot path', () => {
    const state = newFollowing();
    assert.equal(startFollowing(state, BEN, ANA), true);
    assert.equal(leaderOf(state, BEN), ANA);
    assert.deepEqual(followersOf(state, ANA), [BEN]);
  });

  it('keeps a train in the order it formed', () => {
    const state = newFollowing();
    startFollowing(state, CAI, ANA);
    startFollowing(state, BEN, ANA);
    assert.deepEqual(followersOf(state, ANA), [CAI, BEN]);
  });

  it('holds one leader at a time, dropping the old link rather than refusing', () => {
    const state = newFollowing();
    startFollowing(state, CAI, ANA);
    startFollowing(state, CAI, BEN);
    assert.equal(leaderOf(state, CAI), BEN);
    assert.deepEqual(followersOf(state, ANA), [], 'and the first leader keeps nobody');
  });

  it('refuses a ring, which is a movement intent that never terminates', () => {
    const state = newFollowing();
    startFollowing(state, BEN, ANA);
    startFollowing(state, CAI, BEN);

    assert.equal(wouldLoop(state, ANA, CAI), true, 'closing a three-link chain');
    assert.equal(startFollowing(state, ANA, CAI), false);
    // **And the refusal costs nothing.** A request that cannot be honoured must not also take away
    // the relationship the character already had.
    assert.equal(leaderOf(state, CAI), BEN);
    assert.equal(leaderOf(state, ANA), undefined);
  });

  it('refuses following yourself, and following the same person twice is not a change', () => {
    const state = newFollowing();
    assert.equal(startFollowing(state, BEN, BEN), false);
    assert.equal(startFollowing(state, BEN, ANA), true);
    // Not an error — a repeated statement of a fact. Reporting it as a change would make the room
    // hear about it twice.
    assert.equal(startFollowing(state, BEN, ANA), false);
  });

  it('says who you stopped following, so the caller can name them', () => {
    const state = newFollowing();
    startFollowing(state, BEN, ANA);
    assert.equal(stopFollowing(state, BEN), ANA);
    assert.equal(stopFollowing(state, BEN), undefined, 'and nothing the second time');
  });

  it('forgets a character in both directions, and hands back who was orphaned', () => {
    const state = newFollowing();
    startFollowing(state, BEN, ANA);
    startFollowing(state, CAI, ANA);

    // Entity ids are reissued, so a leftover link would drag the next character handed this id along
    // behind a stranger — the same argument `forgetTarget` makes about a mob's memory.
    assert.deepEqual([...forgetFollower(state, ANA)].sort(), [BEN, CAI]);
    assert.equal(leaderOf(state, BEN), undefined);
    assert.equal(leaderOf(state, CAI), undefined);
    assert.deepEqual(followersOf(state, ANA), []);
  });

  it('leaves no empty sets behind, so the index does not grow one entry per ex-leader', () => {
    const state = newFollowing();
    startFollowing(state, BEN, ANA);
    stopFollowing(state, BEN);
    assert.deepEqual(followersOf(state, ANA), []);
    // The map itself is empty, not merely reporting empty — checked through the public read because
    // the shape is the point, not the field.
    assert.equal(leaderOf(state, BEN), undefined);
  });
});
