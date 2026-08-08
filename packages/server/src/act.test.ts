import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { UNSEEN_NAME, actLines, actLinesPair, type Actor } from './act.ts';

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

describe('actLinesPair — the leak, on the other name', () => {
  const dave: Actor = { id: 4, name: 'Dave' };
  const whispers = (who: string, whom: string): string => `${who} whispers something to ${whom}.`;

  it('gates both names against the same observer, independently', () => {
    // `whisper` is the first line that names two people to a third. Rendering it through `actLines`
    // gated the whisperer and pasted the recipient's name in from their own record — the original
    // leak wearing the other hat. `act()` never had the bug: `$n` goes through `PERS(ch, to)` and
    // `$N` through `PERS(vict, to)`, both against the recipient.
    const room = [alice, bob, carol, dave];
    // Carol sees only Alice; Dave sees only Bob.
    const sight = (observer: Actor, subject: Actor): boolean =>
      (observer.id === 3 && subject.id === 1) || (observer.id === 4 && subject.id === 2);

    assert.deepEqual(actLinesPair(alice, bob, room, sight, whispers), [
      { to: 3, text: `Alice whispers something to ${UNSEEN_NAME}.` },
      { to: 4, text: `${UNSEEN_NAME} whispers something to Bob.` },
    ]);
  });

  it('never lets an unseen subject’s name reach an observer, in either position', () => {
    // The property, over every combination of who is lit, rather than one example of it.
    const room = [alice, bob, carol];
    for (const lit of [[], [1], [2], [1, 2]]) {
      const sight = (_observer: Actor, subject: Actor): boolean => lit.includes(subject.id);
      const [line] = actLinesPair(alice, bob, room, sight, whispers);
      assert.equal(line!.text.includes(alice.name), lit.includes(1), line!.text);
      assert.equal(line!.text.includes(bob.name), lit.includes(2), line!.text);
    }
  });

  it('writes to neither subject, which is what TO_NOTVICT means', () => {
    // The actor is omitted by `act()` itself and the victim by the flag; both are told what happened
    // in the second person by the caller, so a "someone" line can never reach either of the two
    // people who certainly know who was involved.
    const lines = actLinesPair(alice, bob, [alice, bob, carol, dave], () => true, whispers);
    assert.deepEqual(lines.map((l) => l.to), [3, 4]);
  });

  it('says "someone" twice rather than dropping the line', () => {
    // Whispering in company is an audible, visible act even when you cannot see who is doing it —
    // and the room hearing nothing at all is the version that would make conspiracy invisible.
    const lines = actLinesPair(alice, bob, [carol], seenBy([]), whispers);
    assert.deepEqual(lines, [{ to: 3, text: `${UNSEEN_NAME} whispers something to ${UNSEEN_NAME}.` }]);
  });

  it('sends nothing to a room holding only the two of them', () => {
    assert.deepEqual(actLinesPair(alice, bob, [alice, bob], () => true, whispers), []);
    assert.deepEqual(actLinesPair(alice, bob, [], () => true, whispers), []);
  });
});
