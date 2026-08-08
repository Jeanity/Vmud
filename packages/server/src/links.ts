/**
 * Authored links between rooms the harvest never joined.
 *
 * ## Why this is not `rooms.json`
 *
 * The room override file refuses exits by name, and says why: *"those are geometry, they are the
 * join key and the grid."* That rule is right and stays. This is the other half of it — a file that
 * does **nothing but** geometry, so the two overlays cannot be confused for each other and neither
 * has to grow a mode. `rooms.json` re-describes a room the harvest gave us; this joins two rooms the
 * harvest left apart.
 *
 * ## Why it exists at all
 *
 * The world we load is not one landmass. Measured across all 327 harvested zones, the Faerie Realm
 * and its five neighbours — both Courts, Finn's Keep, Leuthilspar's forest, the Valley of Graydawn —
 * form a **six-zone island with no walking route to the other 268 zones from anywhere**. That is not
 * a gap in the loading config; it is the shape of the map data. In the MUD the Feywild was reached by
 * magic, and our source is a player-made map, which records the routes somebody walked.
 *
 * So a crossing has to be authored, and the owner asked for one (2026-08-08): *"can we make the
 * faerie realm walkable from the kobold zone?"*
 *
 * ## The three rules
 *
 * **A link is a pair, and both halves live in one record.** The failure this prevents is the obvious
 * one: an author writes the way in, ships, and nobody can get back. Both directions are stated
 * explicitly rather than derived by flipping the compass, because a ring that puts you out somewhere
 * other than where you came in is a thing a builder is allowed to want.
 *
 * **It may never overwrite an exit the harvest already has.** Silently re-routing a door is a change
 * to a zone's shape that would be invisible in this file and inexplicable in the game — you would
 * walk north out of a room you know and arrive somewhere new. A collision is refused and said out
 * loud.
 *
 * **Every authored link is a `portal`.** {@link RoomExit.portal} already means *"the destination is
 * not the geometric neighbour in this direction"*, and the client already draws those as a portal
 * rather than an opening in a wall. Two rooms in different zones can never be geometric neighbours —
 * worldgen normalises coordinates per zone, so they share no coordinate space at all — so the flag is
 * not a choice this file makes, it is a fact about what it does.
 *
 * The loader takes `quests.ts`' posture exactly: a missing file is a world with no authored links, not
 * a server that will not boot, and a bad record is skipped **loudly** rather than half-applied.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DIRECTIONS, type Direction, type Room, type RoomId } from '@mygame/shared';

// Its own root rather than `world.ts`'s `WORLD_DIR`, which is what `overrides.ts` and every other
// overlay in this directory does — and here it is load-bearing rather than stylistic: `world.ts`
// imports *this* module, so importing it back would put `WORLD_DIR` in the temporal dead zone on the
// way through and throw at boot.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const LINKS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'links.json');

/** One two-way crossing. `a`/`b` name rooms; `aDir` is the way out of `a`, `bDir` the way back. */
export interface LinkDef {
  readonly a: RoomId;
  readonly aDir: Direction;
  readonly b: RoomId;
  readonly bDir: Direction;
  /** What the author was doing, for the same reason every overlay in this project records it. */
  readonly brief?: string;
}

/** The fields a form or a hand-edited file posts, before validation. Nothing is trusted. */
export interface LinkDraft {
  readonly a?: unknown;
  readonly aDir?: unknown;
  readonly b?: unknown;
  readonly bDir?: unknown;
  readonly brief?: unknown;
}

const BRIEF_MAX = 200;

/** A draft turned into a link, or the sentence saying why it is not one. **Shape only** — whether the
 * world has these rooms is {@link applyLinks}' question, because only it has a world to ask. */
export function draftLink(draft: LinkDraft): { link: LinkDef } | { error: string } {
  for (const key of ['a', 'b'] as const) {
    const value = draft[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      return { error: `${key} must be a whole room id` };
    }
  }
  for (const key of ['aDir', 'bDir'] as const) {
    const value = draft[key];
    if (typeof value !== 'string' || !(DIRECTIONS as readonly string[]).includes(value)) {
      return { error: `${key} must be one of: ${DIRECTIONS.join(', ')}` };
    }
  }
  const a = draft.a as RoomId;
  const b = draft.b as RoomId;
  // **A room may not be linked to itself.** It is the one pair where the two halves would collide on
  // the same room, and an exit that leads where you already are is never what somebody meant.
  if (a === b) return { error: 'a link joins two different rooms' };
  if (draft.brief !== undefined && draft.brief !== null) {
    if (typeof draft.brief !== 'string' || draft.brief.length > BRIEF_MAX) {
      return { error: `brief must be text of at most ${BRIEF_MAX} characters` };
    }
  }
  return {
    link: {
      a,
      aDir: draft.aDir as Direction,
      b,
      bDir: draft.bDir as Direction,
      ...(typeof draft.brief === 'string' && draft.brief.length > 0 ? { brief: draft.brief } : {}),
    },
  };
}

export function loadLinks(file = LINKS_FILE): LinkDef[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const out: LinkDef[] = [];
  for (const entry of raw as unknown[]) {
    // The API's own validator rather than a second, laxer one — `quests.ts`' rule: a file somebody
    // edited by hand deserves exactly the checks a form POST would get.
    const drafted = draftLink((entry ?? {}) as LinkDraft);
    if ('error' in drafted) {
      console.warn(`[links] skipping a record: ${drafted.error}`);
      continue;
    }
    out.push(drafted.link);
  }
  return out;
}

/** What a link did, or why it did nothing. */
export interface LinkOutcome {
  readonly applied: number;
  readonly refused: readonly string[];
}

/**
 * Carves the links into a composed world.
 *
 * **Called after every zone is loaded and indexed, never during**, because the two ends of a link are
 * by definition in different zones and one of them does not exist yet while the other is being built.
 * That ordering is the whole reason this is a separate pass rather than another step inside the zone
 * loop.
 *
 * A room that is not loaded is a refusal rather than a crash: the config decides which zones run, and
 * a link naming a zone somebody switched off should say so and leave the world standing.
 */
export function applyLinks(lookup: (id: RoomId) => Room | undefined, links: readonly LinkDef[]): LinkOutcome {
  const refused: string[] = [];
  let applied = 0;
  for (const link of links) {
    const a = lookup(link.a);
    const b = lookup(link.b);
    if (!a || !b) {
      refused.push(`link ${link.a} <-> ${link.b}: room ${!a ? link.a : link.b} is not in a loaded zone`);
      continue;
    }
    if (a.exits[link.aDir]) {
      refused.push(`link ${link.a} <-> ${link.b}: room ${link.a} already has a ${link.aDir} exit`);
      continue;
    }
    if (b.exits[link.bDir]) {
      refused.push(`link ${link.a} <-> ${link.b}: room ${link.b} already has a ${link.bDir} exit`);
      continue;
    }
    // **Both halves or neither.** Checked above rather than written as we go, so a refusal on the way
    // back cannot leave a one-way door behind — which is the failure that would be hardest to see,
    // because the way in works.
    write(a, link.aDir, link.b);
    write(b, link.bDir, link.a);
    applied++;
  }
  return { applied, refused };
}

/**
 * The single writer, and the cast is why it is a named function.
 *
 * `Room.exits` is `Readonly` so that nothing edits a room by accident; the composed world is built
 * from parsed JSON that nobody else holds a reference to, so writing here is safe and writing
 * anywhere else is the bug. `portal` is unconditional — see the header's third rule.
 */
function write(room: Room, dir: Direction, to: RoomId): void {
  (room.exits as Record<Direction, { to: RoomId; portal: boolean }>)[dir] = { to, portal: true };
}
