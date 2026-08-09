/**
 * `look <direction>` — seeing into the next room. Track V's parked row, unblocked the day doors and
 * light both settled, and built 2026-08-07.
 *
 * ## What the source actually does, which is not what the row assumed
 *
 * `actinf.c`'s look-direction case shows an ordinary mortal **the exit and nothing else**: the door's
 * state line, or the exit's own description, and then `if (!IS_TRUSTED(ch)) return;`. Seeing the far
 * room — `new_look(ch, NULL, CMD_LOOKAFAR, temp)`, description and occupants — sits behind
 * **`AFF_FARSEE`**, a spell. The owner's ask (*"look east… its description and a count of what is
 * standing in it — 1 sentry guard to the east"*) is precisely the farsee behaviour, so plain `look
 * east` opens it deliberately: a divergence recorded here rather than discovered later, and the day
 * Phase 20 wants farsee to mean something, this is the seam it tightens.
 *
 * What is kept is the farsee path's own gauntlet, in the source's order and mostly its words:
 *
 * - **No exit** → *"You see nothing special..."*
 * - **A closed door blocks it** — *"The closed %s blocks your farsight"*; ours prints the door's
 *   state line and stops, which is what the same door tells `stepRoom`.
 * - **A one-way exit blocks it**: the source requires the far room's reverse exit to point back
 *   (*"Something seems to be blocking your line of sight."*). Note what this does and does not catch,
 *   because the drive caught the overstatement: a **mutual** portal pair — Kobold's `41299 ⇄ 41297`,
 *   six cells apart on the grid — passes, and you peer straight through it, geometry notwithstanding.
 *   That is the source's own rule (`rev_dir`, graph reciprocity, nothing about coordinates), and it is
 *   the flee note's acceptance again: the graph is the truth and the grid is the rendering. Only a
 *   link whose far end does not point back refuses.
 * - **The gate is the far room's light, not yours** — `CAN_DAYPEOPLE_SEE(temp)`, the far room. You
 *   can see into a lit room from the dark and not into a dark room from the light, which is the whole
 *   reason the feature is interesting and the opposite of what a naive `canSee(you, them)` computes.
 *   Ours: the far room lights itself ({@link roomLightsItself}), or somebody standing in it carries a
 *   light — their beacon is what you are seeing by. **A light lying on the floor does not count**,
 *   named as dropped: the ground store is a different lookup and a torch someone abandoned lighting a
 *   room for onlookers can arrive with the room-scoped-light row it belongs to.
 *
 * Dropped with names: `ROOM_BLOCKS_SIGHT` (not in {@link ROOM_FLAGS} — the harvest never carried it),
 * the obscuring-mist and daylight-blindness affects (no such affects exist), and `EX_ILLUSION` /
 * `EX_SECRET` (no such exits are harvested). **Hidden and invisible stay hidden** is rule 4 of the
 * roadmap row, and today the room-light gate is the whole of visibility — the day stealth lands
 * (Phase 19's own tail), the occupant list here must pass the same predicate the entity feed uses,
 * or this becomes the wallhack the row warns about.
 *
 * ## Counts are the tactical information
 *
 * Three patrol members read as one name and a count, not three lines — *"the count is the tactical
 * information"*. Aggregation is by exact rendered name in encounter order, so two mobs that share a
 * name are two of one thing (which they are — one template) and a renamed one stands apart.
 *
 * Deliberately **not** `neighbourhood()`: that one is unbounded and ungated because an operator looks
 * at the world from outside it. This resolves one exit of one room, server-side, for somebody standing
 * in it — a client that could ask about any room would be asking about exactly the rooms it must not
 * see.
 */

import { roomLightsItself } from '@mygame/shared/light.ts';
import type { Direction, Room, RoomId } from '@mygame/shared';

/** The six, in `interp.c`'s own order — which makes `d` down and not something else, by table order. */
const DIRECTIONS: readonly Direction[] = ['north', 'east', 'south', 'west', 'up', 'down'];

/** `rev_dir`, transcribed rather than derived — six entries do not earn arithmetic. Exported for the
 * arrow's arrival line: a shot fired *west* streaks into the far room *from the east*. */
export const REVERSE: Readonly<Record<Direction, Direction>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
};

/**
 * The direction a typed word names, or nothing — **directions get first refusal**, which is Diku's own
 * `search_block` order: `look e` is east even in a room with an entity answering to `e`, because the
 * direction keywords sit at the top of the table. A prefix match, so `look nor` works the way every
 * other Diku abbreviation works; the empty string names nothing rather than north.
 */
export function directionFrom(word: string): Direction | undefined {
  const cleaned = word.trim().toLowerCase();
  if (!cleaned) return undefined;
  return DIRECTIONS.find((dir) => dir.startsWith(cleaned));
}

/** One name standing in the far room, with the count that makes twins one line. */
export interface PeekedOccupant {
  readonly name: string;
  readonly count: number;
}

export type PeekOutcome =
  | { readonly t: 'no-exit' }
  /** A door in the way, shut. The state line is the whole answer, exactly as it is to a step. */
  | { readonly t: 'closed-door'; readonly door: string }
  /** The far end is a room this server does not run — the loaded world's edge, wearing the source's mists. */
  | { readonly t: 'nowhere' }
  /** No reverse exit pointing back — one-way links and every portal fail here. */
  | { readonly t: 'one-way' }
  | { readonly t: 'dark' }
  | {
      readonly t: 'view';
      readonly room: Room;
      /** The door you are peering through, when there is an open one — the line still gets said. */
      readonly door?: string;
      readonly occupants: readonly PeekedOccupant[];
    };

/**
 * What a peek is still showing, and where it was made from — ranged slice 2, `DESIGN-ranged.md`.
 *
 * Kept beside {@link peek} and pure, for the same reason the gauntlet is: the two rules that matter
 * here are both *restrictions*, and a restriction never shows up on the happy path. `look west` naming
 * three kobolds looks identical whether or not the set correctly dies when you walk — right up until a
 * player is reading a room two away, which is the one thing the owner ruled out.
 */
export interface Reveal {
  readonly from: RoomId;
  readonly rooms: ReadonlySet<RoomId>;
}

/**
 * The reveal after looking into `saw` while standing in `standingIn`.
 *
 * **Additive only while you have not moved.** Looking west and then north from one spot shows both;
 * looking from somewhere else starts over rather than accumulating a trail of rooms behind you.
 */
export function afterLook(prev: Reveal | undefined, standingIn: RoomId, saw: RoomId): Reveal {
  const keep = prev?.from === standingIn ? prev.rooms : undefined;
  return { from: standingIn, rooms: new Set([...(keep ?? []), saw]) };
}

/**
 * What that reveal shows to somebody standing in `standingIn` — **empty unless they have not moved.**
 *
 * This is the no-chaining rule and it falls out rather than being enforced: walk into the room you
 * peeked at and `from` no longer matches, so the set goes dark *including the room you are now in*,
 * which is right — you can see that one by standing in it, and you have earned nothing beyond it.
 */
export function revealShownIn(prev: Reveal | undefined, standingIn: RoomId): ReadonlySet<RoomId> {
  return prev && prev.from === standingIn ? prev.rooms : EMPTY_REVEAL;
}

const EMPTY_REVEAL: ReadonlySet<RoomId> = new Set();

/**
 * Of everything a character can see, the ones a verb may name — **seeing into a room is not reaching
 * into it.**
 *
 * A named function for a one-line filter, because the line is a rule and the rule already broke once.
 * Slice 2 put peeked bodies into the visible set, which every targeted verb resolves through, and for
 * one commit `kill kobold` reached through a wall at something one room west. The pointer path had the
 * same hole independently — two call sites, one rule, and nothing tying them together.
 *
 * So they are tied together here. A new reader of the visible set is now choosing, visibly, between
 * "everything I can see" and "everything I can touch", rather than defaulting into the wrong one by
 * writing the obvious thing. Ranged is the single verb that wants the other list, and it asks for it.
 */
export function nameable<T extends { readonly id: unknown; readonly revealed?: true }>(visible: readonly T[]): T[] {
  return visible.filter((entity) => entity.revealed !== true);
}

/**
 * What lies one exit away. Pure over its lookups, so the whole gauntlet is testable without a world:
 * the caller supplies rooms, doors and occupants, and this supplies the order the rules fire in.
 */
export function peek(
  from: Room,
  dir: Direction,
  deps: {
    readonly roomOf: (id: RoomId) => Room | undefined;
    /** Every body standing in a room, with the light it casts — 0 for none. */
    readonly occupantsOf: (id: RoomId) => readonly { readonly name: string; readonly lightRadius: number }[];
    /** The door governing this exit as `stepRoom` sees it, or nothing where geometry is bare. */
    readonly doorAt: (id: RoomId, dir: Direction) => { readonly name: string; readonly closed: boolean } | undefined;
  },
): PeekOutcome {
  const exit = from.exits[dir];
  if (!exit) return { t: 'no-exit' };

  const door = deps.doorAt(from.id, dir);
  if (door?.closed) return { t: 'closed-door', door: door.name };

  const far = deps.roomOf(exit.to);
  if (!far) return { t: 'nowhere' };

  // The source's farsee rule, and the portal-proofing: the far room must point back.
  if (far.exits[REVERSE[dir]]?.to !== from.id) return { t: 'one-way' };

  const bodies = deps.occupantsOf(far.id);
  const lit = roomLightsItself(far) || bodies.some((body) => body.lightRadius > 0);
  if (!lit) return { t: 'dark' };

  const counts = new Map<string, number>();
  for (const body of bodies) counts.set(body.name, (counts.get(body.name) ?? 0) + 1);
  const occupants = [...counts.entries()].map(([name, count]) => ({ name, count }));

  return { t: 'view', room: far, ...(door ? { door: door.name } : {}), occupants };
}
