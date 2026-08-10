/**
 * Noticeboards — Phase 23, transcribed from `boards.c`.
 *
 * The source's machine is a registry of board objects (vnum → read/write/remove levels → a file of
 * messages), found by scanning the room's contents, driven by READ/LOOK/WRITE/REMOVE. Ours keeps
 * every behaviour a player can feel and moves the bookkeeping to this project's own seams:
 *
 * - **A board is a field on a room** (`Room.board`, a slug) rather than an object in its contents.
 *   The source scans `world[room].contents` for a registered vnum because objects were its only way
 *   to put a thing in a room; our rooms are authored records that can simply say what stands in
 *   them. What survives is the semantic: the board is *of the room*, `read` finds it by being there.
 * - **Gods post, players read** — the city design's own decision (§4's ledger; player writes are
 *   "one flag away when wanted"). So the write path is an admin route rather than `do_write`'s
 *   string editor, and the remove path likewise. `boards.c`'s level gates (READ_LVL/WRITE_LVL)
 *   collapse to: reading is level 0, writing is the panel.
 * - **Numbering is storage order and stays stable** — the source's own rule. Message 3 is the third
 *   post ever still standing, the listing walks newest-first showing true indices (`boards.c:317`,
 *   the reversed loop), and a removal shifts everything above it down one, exactly as
 *   `Board_remove_msg` compacts its array.
 * - **The caps are the source's caps**: 199 messages a board (`MAX_BOARD_MESSAGES`), a headline
 *   truncated at 70 (`boards.c:252`, the famous `arg[71] = '\0'`), 4000 characters of body
 *   (`MAX_MESSAGE_LENGTH`).
 *
 * Posts live beside the operator switches (`settings.ts`'s argument): nothing regenerates them, a
 * restart must not eat them, and they are runtime state rather than authored content — so the file
 * sits in the overrides directory and the gitignore, not in `data/authored/`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where the posts live. Beside `settings.json`, for its reason: nothing regenerates this. */
export const BOARDS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'boards.json');

/** The source's own caps, kept by number. */
export const MAX_BOARD_MESSAGES = 199;
export const MAX_HEADLINE = 70;
export const MAX_BODY = 4000;

export interface BoardPost {
  readonly headline: string;
  readonly body: string;
  /** Who signed it — the panel's "signed as" field, default the pantheon itself. */
  readonly by: string;
  /** Epoch millis of the posting, for the heading stamp. */
  readonly at: number;
}

/** Every board's posts, oldest first — the numbering the reader sees is this array's own. */
export type BoardStore = Map<string, BoardPost[]>;

export function loadBoards(file = BOARDS_FILE): BoardStore {
  const store: BoardStore = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return store; // no file is the ordinary first day
  }
  if (typeof raw !== 'object' || raw === null) return store;
  const boards = (raw as { boards?: unknown }).boards;
  if (typeof boards !== 'object' || boards === null) return store;
  for (const [id, posts] of Object.entries(boards)) {
    if (!Array.isArray(posts)) continue;
    const kept: BoardPost[] = [];
    for (const post of posts) {
      if (typeof post !== 'object' || post === null) continue;
      const { headline, body, by, at } = post as Record<string, unknown>;
      if (typeof headline !== 'string' || typeof body !== 'string') continue;
      kept.push({
        headline: headline.slice(0, MAX_HEADLINE),
        body: body.slice(0, MAX_BODY),
        by: typeof by === 'string' && by.trim() ? by : 'The Gods',
        at: typeof at === 'number' && Number.isFinite(at) ? at : 0,
      });
    }
    if (kept.length > 0) store.set(id, kept.slice(0, MAX_BOARD_MESSAGES));
  }
  return store;
}

export function saveBoards(store: BoardStore, file = BOARDS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const boards: Record<string, BoardPost[]> = {};
  for (const id of [...store.keys()].sort()) boards[id] = store.get(id)!;
  writeFileSync(file, `${JSON.stringify({ boards }, null, 2)}\n`, 'utf8');
}

/** Why a post was refused, or nothing. The route turns these into its 400s. */
export function postRefusal(store: BoardStore, board: string, headline: string, body: string): string | undefined {
  if (headline.trim().length === 0) return 'We must have a headline!'; // the source's own sentence
  if (headline.trim().length > MAX_HEADLINE) return `headline over ${MAX_HEADLINE} characters`;
  if (body.trim().length === 0) return 'the message body is empty';
  if (body.length > MAX_BODY) return `body over ${MAX_BODY} characters`;
  if ((store.get(board)?.length ?? 0) >= MAX_BOARD_MESSAGES) return 'The board is full.'; // and this one
  return undefined;
}

/** Appends a post. The caller has consulted {@link postRefusal}; this trusts and stamps. */
export function addPost(store: BoardStore, board: string, headline: string, body: string, by: string, at: number): BoardPost {
  const post: BoardPost = {
    headline: headline.trim().slice(0, MAX_HEADLINE),
    body: body.slice(0, MAX_BODY),
    by: by.trim() || 'The Gods',
    at,
  };
  const posts = store.get(board) ?? [];
  posts.push(post);
  store.set(board, posts);
  return post;
}

/**
 * Removes post `number` (1-based, storage order) — the source's compaction: everything above
 * shifts down one, so the listing renumbers exactly as `Board_remove_msg` renumbers.
 */
export function removePost(store: BoardStore, board: string, number: number): BoardPost | undefined {
  const posts = store.get(board);
  if (!posts || number < 1 || number > posts.length) return undefined;
  const [removed] = posts.splice(number - 1, 1);
  if (posts.length === 0) store.delete(board);
  return removed;
}

/** The heading stamp: the source's `[time (author)]`, seconds and year killed just as it kills them. */
export function postStamp(post: BoardPost): string {
  const when = new Date(post.at);
  const month = when.toLocaleString('en-US', { month: 'short' });
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return `[${month} ${when.getDate()} ${time} (${post.by})]`;
}

/**
 * The listing `read board` prints — `Board_show_board` reworded for a board players cannot write
 * on, newest first with true numbers, exactly as the source's reversed loop shows them.
 */
export function boardListing(posts: readonly BoardPost[]): string[] {
  const lines = ['This is a bulletin board. Usage: &+Wread <message #>&N.'];
  if (posts.length === 0) {
    lines.push('The board is empty.');
    return lines;
  }
  lines.push(`There are ${posts.length} message${posts.length === 1 ? '' : 's'} on the board.`);
  for (let index = posts.length - 1; index >= 0; index--) {
    const post = posts[index]!;
    lines.push(`${String(index + 1).padStart(2)} : ${postStamp(post)} ${post.headline}`);
  }
  return lines;
}

/**
 * One message, or the refusal the source made famous. `read 3` against a board with two posts has
 * earned its sentence since CircleMUD: *"That message exists only in your imagination."*
 */
export function boardMessage(posts: readonly BoardPost[], number: number): string[] {
  if (posts.length === 0) return ['The board is empty!'];
  if (number < 1 || number > posts.length) return ['That message exists only in your imagination.'];
  const post = posts[number - 1]!;
  return [`Message ${number} : ${postStamp(post)} ${post.headline}`, '', post.body];
}
