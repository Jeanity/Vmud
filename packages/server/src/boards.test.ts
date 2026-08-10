/**
 * The noticeboard's contract — Phase 23, `boards.c` behaviours held by number: the caps are the
 * source's caps, the numbering is storage order shown newest-first, and the famous sentence is
 * word-for-word.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  MAX_BOARD_MESSAGES,
  MAX_HEADLINE,
  addPost,
  boardListing,
  boardMessage,
  loadBoards,
  postRefusal,
  removePost,
  saveBoards,
  type BoardStore,
} from './boards.ts';

const scratch = mkdtempSync(join(tmpdir(), 'boards-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const AT = Date.UTC(2026, 7, 10, 14, 30);

function seeded(posts: number): BoardStore {
  const store: BoardStore = new Map();
  for (let i = 1; i <= posts; i++) addPost(store, 'velen-square', `Headline ${i}`, `Body ${i}`, 'The Gods', AT);
  return store;
}

describe('the store', () => {
  it('survives a save and load round trip', () => {
    const file = join(scratch, 'round.json');
    const store = seeded(3);
    saveBoards(store, file);
    const back = loadBoards(file);
    assert.equal(back.get('velen-square')?.length, 3);
    assert.equal(back.get('velen-square')?.[0]?.headline, 'Headline 1');
    assert.equal(back.get('velen-square')?.[2]?.body, 'Body 3');
  });

  it('loads nothing from a missing file — the ordinary first day', () => {
    assert.equal(loadBoards(join(scratch, 'never-written.json')).size, 0);
  });

  it('refuses the full board with the source’s own sentence', () => {
    const store = seeded(MAX_BOARD_MESSAGES);
    assert.equal(postRefusal(store, 'velen-square', 'One more', 'body'), 'The board is full.');
  });

  it('refuses an empty headline the way the source does', () => {
    assert.equal(postRefusal(new Map(), 'velen-square', '   ', 'body'), 'We must have a headline!');
  });

  it('truncates a rambling headline at the source’s seventy', () => {
    const store: BoardStore = new Map();
    const long = 'x'.repeat(200);
    assert.ok(postRefusal(store, 'b', long, 'body') !== undefined, 'over-long headline is refused, not silently cut');
    const post = addPost(store, 'b', 'y'.repeat(MAX_HEADLINE), 'body', '', AT);
    assert.equal(post.headline.length, MAX_HEADLINE);
    assert.equal(post.by, 'The Gods', 'an empty signature falls to the pantheon');
  });

  it('removal compacts and renumbers exactly as Board_remove_msg does', () => {
    const store = seeded(3);
    const removed = removePost(store, 'velen-square', 2);
    assert.equal(removed?.headline, 'Headline 2');
    const posts = store.get('velen-square')!;
    assert.equal(posts.length, 2);
    assert.equal(posts[1]?.headline, 'Headline 3', 'what was message 3 is now message 2');
    assert.equal(removePost(store, 'velen-square', 9), undefined, 'out of range removes nothing');
  });
});

describe('what the reader sees', () => {
  it('lists newest first with true storage numbers', () => {
    const posts = seeded(3).get('velen-square')!;
    const lines = boardListing(posts);
    assert.match(lines[1]!, /There are 3 messages/);
    assert.match(lines[2]!, /^ 3 : \[/, 'the newest message tops the list wearing its real number');
    assert.match(lines[4]!, /^ 1 : \[/);
    assert.match(lines[2]!, /\(The Gods\)\] Headline 3$/);
  });

  it('shows the empty board plainly', () => {
    assert.ok(boardListing([]).some((line) => line === 'The board is empty.'));
  });

  it('prints one message with its stamp, and the imagination line for the rest', () => {
    const posts = seeded(2).get('velen-square')!;
    const message = boardMessage(posts, 2);
    // The stamp is local time, as the source's `localtime` was — so the test checks the shape
    // (`[Mon D HH:MM (author)]`) rather than pinning a date that shifts with the machine's zone.
    assert.match(message[0]!, /^Message 2 : \[[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2} \(The Gods\)\] Headline 2$/);
    assert.equal(message[2], 'Body 2');
    assert.deepEqual(boardMessage(posts, 7), ['That message exists only in your imagination.']);
    assert.deepEqual(boardMessage([], 1), ['The board is empty!']);
  });
});
