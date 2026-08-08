/**
 * Per-recipient prose — the small version of the MUD's `act()`.
 *
 * ## Why this is not a `sendToRoom` with a string
 *
 * Entity *presence* has always been resolved per observer: you are told about the characters light
 * actually falls on, and nobody else. Log lines were not. `say` formatted `"Alice says, 'hi'"` once
 * and shipped that one string to everyone standing in the room, so an observer in the dark — whose
 * client had correctly never been told Alice was there — read her name off the text log. The gate was
 * doing its job and the prose was walking straight round it.
 *
 * The MUD solves this by never formatting a sentence for a room at all. `act()` takes a template
 * holding `$n` and re-expands it once per recipient, and `$n` resolves through `PERS(ch, to)`, which
 * is documented in `utility.c` as *"how does vict see ch?"* and answers `"someone"` when they cannot.
 * The name is not a property of the actor; it is a property of the **pair**.
 *
 * So this module renders a line once per observer. It is deliberately pure and knows nothing about
 * sockets, rooms, light or grids: the caller supplies the observers and the "can this one see that
 * one" test, which must be the *same* test entity presence is gated on — that identity is the whole
 * fix, and it is why the server keeps exactly one `canSee`.
 */

import type { EntityId } from '@mygame/shared';

/** All this module needs of a character. */
export interface Actor {
  readonly id: EntityId;
  readonly name: string;
}

/** One rendered line and who it is for. */
export interface ActLine {
  readonly to: EntityId;
  readonly text: string;
}

/**
 * What an observer calls someone they cannot see.
 *
 * The MUD's own word (`PERS`), and it is worth keeping rather than dropping the line: hearing is not
 * gated on light, so an unseen speaker must still be *heard*. Saying nothing would trade a leaked
 * name for a different lie — a silent room — and "someone says" is the sentence that makes an unlit
 * stranger a thing that happens to you rather than a thing that fails to.
 */
export const UNSEEN_NAME = 'someone';

/**
 * Renders one line about `actor`, once for each observer, and never for the actor themselves.
 *
 * The actor is skipped because they are told what *they* did, in the second person, by the caller —
 * "You say, 'hi'". That split is also what guarantees `someone` is never said to the one person who
 * certainly knows who it was.
 *
 * `render` receives the name this observer may use and returns the whole line, rather than this
 * module substituting into a template. A `$n` mini-language would have to be parsed, escaped — Duris
 * carries an `escape_act_dollars` for exactly that — and got right for player-supplied text, which
 * `say` is. A closure has no such surface.
 */
export function actLines<A extends Actor, O extends Actor>(
  actor: A,
  observers: Iterable<O>,
  canSee: (observer: O, actor: A) => boolean,
  render: (who: string) => string,
): ActLine[] {
  const lines: ActLine[] = [];
  for (const observer of observers) {
    if (observer.id === actor.id) continue;
    lines.push({
      to: observer.id,
      text: render(canSee(observer, actor) ? actor.name : UNSEEN_NAME),
    });
  }
  return lines;
}

/**
 * The same rule for a line about **two** characters — the MUD's `$n` *and* `$N`.
 *
 * `whisper` is the first line the game has that names two people to a third: *"X whispers something
 * to Y."* Rendering it through {@link actLines} gated only `X`, and `Y` was pasted in from the
 * actor's own record — which is the original leak wearing the other hat. An observer who cannot see
 * the person being whispered *to* still read their name off the log, while their client had never
 * been told that body was in the room.
 *
 * The source does not have this problem, because it never had one name to gate: `act()` expands `$n`
 * through `PERS(ch, to)` and `$N` through `PERS(vict, to)`, both against the same recipient. Two
 * subjects, one observer, one rule — which is all this is.
 *
 * Neither subject is written to. That is `TO_NOTVICT` exactly: `act()` already omits the actor, the
 * flag omits the victim, and both of them are told what happened in the second person by the caller.
 */
export function actLinesPair<A extends Actor, B extends Actor, O extends Actor>(
  actor: A,
  other: B,
  observers: Iterable<O>,
  canSee: (observer: O, subject: A | B) => boolean,
  render: (who: string, whom: string) => string,
): ActLine[] {
  const lines: ActLine[] = [];
  for (const observer of observers) {
    if (observer.id === actor.id || observer.id === other.id) continue;
    lines.push({
      to: observer.id,
      text: render(
        canSee(observer, actor) ? actor.name : UNSEEN_NAME,
        canSee(observer, other) ? other.name : UNSEEN_NAME,
      ),
    });
  }
  return lines;
}
