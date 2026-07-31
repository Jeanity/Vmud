import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNSEEN_NAME, actLines, type Actor } from './act.ts';

const alice: Actor = { id: 1, name: 'Alice' };
const bob: Actor = { id: 2, name: 'Bob' };
const carol: Actor = { id: 3, name: 'Carol' };

/** "Everyone in this set can see the actor; nobody else can." */
function seenBy(ids: Iterable<number>): (observer: Actor) => boolean {
  const lit = new Set(ids);
  return (observer) => lit.has(observer.id);
}

const says = (who: string): string => `${who} says, 'hi'`;

describe('actLines — the leak', () => {
  it('gives the name only to observers who can see the speaker', () => {
    // The bug: `say` formatted one string and `sendToRoom` shipped it to everyone standing in the
    // room, so an observer in the dark read the speaker's name off the text log — while their client
    // had correctly never been told that character was there at all. Entity presence was gated per
    // observer; prose was not.
    const lines = actLines(alice, [alice, bob, carol], seenBy([2]), (who) => `${who} says, 'hello'`);

    assert.deepEqual(lines, [
      { to: 2, text: "Alice says, 'hello'" },
      { to: 3, text: "someone says, 'hello'" },
    ]);
  });

  it('never names the speaker to anyone who cannot see them, whatever the render does', () => {
    // The guarantee stated as a property rather than as one example: across every subset of the room
    // that can see the speaker, their name reaches exactly that subset and no one else.
    const room = [alice, bob, carol];
    for (const lit of [[], [2], [3], [2, 3]]) {
      const lines = actLines(alice, room, seenBy(lit), (who) => `${who} does something`);
      for (const line of lines) {
        const canSee = lit.includes(line.to);
        assert.equal(
          line.text.includes(alice.name),
          canSee,
          `observer ${line.to} (lit=${canSee}) got "${line.text}"`,
        );
      }
    }
  });

  it('says "someone" rather than dropping the line', () => {
    // Hearing is not gated on light. Dropping the line would trade a leaked name for a silent room,
    // which is a different lie — an unlit stranger should be a thing that happens to you.
    const lines = actLines(alice, [alice, bob], seenBy([]), (who) => `${who} says, 'hello'`);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.text.startsWith(UNSEEN_NAME));
  });

  it('never addresses the actor, who is told in the second person instead', () => {
    // Also what guarantees "someone" is never said to the one person who certainly knows who it was.
    const lines = actLines(alice, [alice, bob, carol], seenBy([1, 2, 3]), says);
    assert.deepEqual(lines.map((l) => l.to), [2, 3]);
  });

  it('sends nothing to an empty room', () => {
    assert.deepEqual(actLines(alice, [alice], seenBy([]), says), []);
    assert.deepEqual(actLines(alice, [], seenBy([]), says), []);
  });
});
