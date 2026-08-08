/**
 * The creation card's reconnect recovery — protocol 24, decided apart from the socket and the DOM
 * so it can be unit-tested rather than only driven live.
 *
 * The server's half of the `charCreate`/`charConfirm` conversation (`creating`/`adopting` in
 * `server/src/index.ts`'s connection handler) lives in a closure over the WebSocket and dies with
 * it — a restart, a dropped wifi connection, anything that closes the socket loses it. The client's
 * half (`LoginGate`'s private `chargen` field) is an ordinary object in a page that never reloaded,
 * so it survives untouched: the card the player is looking at is still exactly the one they left.
 * The only question a reconnect has to answer is how much of the *server's* half needs rebuilding
 * before the next click on that card can mean anything again.
 */

import type { ClassId } from './classes.ts';
import type { RaceId } from './races.ts';

/**
 * The creation card's held state, as much of it as the decisions below need — a subset of
 * `LoginGate`'s private `chargen` field, named here so it can be built as a plain object in a test
 * instead of driven through a live card.
 */
export interface ChargenHold {
  readonly name?: string;
  readonly adoptName?: string;
  readonly race?: RaceId;
  readonly class?: ClassId;
}

/** What a reconnect should do about an open creation card. */
export type ChargenResumeAction =
  /** Nothing sent so far is stale — the player is still only choosing, so there is nothing to rebuild. */
  | { readonly kind: 'none' }
  /** Adoption's `adopting` died with the old socket; `enter` rebuilds it before anything else can go. */
  | { readonly kind: 'reopenAdoption'; readonly name: string }
  /** A fresh mint's `charCreate` needs nothing the old connection held — just resend it. */
  | { readonly kind: 'sendCreate' };

/**
 * Decides how to recover an open creation card after a reconnect.
 *
 * Adoption is checked first because its eventual `charCreate` is *nameless* and therefore depends
 * on server state (`adopting`) no matter what else is already chosen; `enter` has to run again
 * before anything else can. A fresh mint's `charCreate` carries its own name, race and class in one
 * message and needs nothing from before, so it is only worth resending once there is something to
 * send — reopening cards nobody has finished choosing yet would just be motion.
 */
export function chargenResumeAction(held: ChargenHold): ChargenResumeAction {
  if (held.adoptName !== undefined) return { kind: 'reopenAdoption', name: held.adoptName };
  if (held.race !== undefined && held.class !== undefined) return { kind: 'sendCreate' };
  return { kind: 'none' };
}

/** What a `charAdopt` reply means once it arrives. */
export type ChargenAdoptReplyAction =
  /** Not a replay at all — the ordinary first arrival at the cards. */
  | { readonly kind: 'openCards' }
  /** The replay's whole point: race and class were already chosen, so `charCreate` can go now. */
  | { readonly kind: 'sendCreate' }
  /** Server state is rebuilt; no class chosen yet, so there is nothing left to send. */
  | { readonly kind: 'wait' };

/**
 * Decides what an incoming `charAdopt` means: the ordinary first answer to a picker click, or the
 * reply to {@link chargenResumeAction}'s replayed `enter`. Only the replay case may leave the cards
 * alone — the ordinary path (`openCards`) resets whatever was chosen, which is correct for a fresh
 * arrival and would throw away a live choice if applied to a reconnect.
 */
export function chargenAdoptReplyAction(
  held: ChargenHold | undefined,
  adoptedName: string,
): ChargenAdoptReplyAction {
  if (held?.adoptName !== adoptedName) return { kind: 'openCards' };
  if (held.race !== undefined && held.class !== undefined) return { kind: 'sendCreate' };
  return { kind: 'wait' };
}
