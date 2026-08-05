/**
 * The sheet route's two halves — A7c.
 *
 * Both live in `art.ts` rather than inline in `index.ts` precisely so they can be tested: `index.ts`
 * starts a server on import and has no harness, which is why the three bugs listed in `HANDOFF.md`
 * had to be found by driving the game rather than by a unit test. A path parser and a traversal
 * guard are exactly the kind of thing that must not need a running server to check.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LPC_ART } from '@mygame/shared';

import { SHEET_DIR, artIdFromPath, artSheetPath } from './art.ts';

describe('the staged sheet route', () => {
  it('resolves an indexed id to its staged file', () => {
    const entry = LPC_ART[0]!;
    const path = artSheetPath(entry.id);
    assert.ok(path, 'an id the index has must resolve');
    assert.ok(path.startsWith(SHEET_DIR), 'and land inside the staging directory');
    assert.ok(path.endsWith(`${entry.sheet}.png`));
  });

  it('refuses anything the index does not name, traversal included', () => {
    // **The point is that none of these are special cases.** The id is looked up rather than joined,
    // so a path that escapes the directory is refused for the same reason a typo is: it is not an
    // art id. There is no filter here to get wrong and no encoding to slip past one.
    for (const hostile of [
      '../../../etc/passwd',
      '..\\..\\..\\windows\\system32\\config\\sam',
      '/etc/shadow',
      '%2e%2e%2fsecrets',
      'belt-leather-brown/../../../secrets',
      '',
    ]) {
      assert.equal(artSheetPath(hostile), undefined, `must not resolve ${JSON.stringify(hostile)}`);
    }
  });

  it('reads the id out of a sheet request', () => {
    assert.equal(artIdFromPath('/lpc/belt-leather-brown.png'), 'belt-leather-brown');
    // A cache-buster is a thing a browser or a proxy adds, and dropping the request over one would
    // look like the art failing to load.
    assert.equal(artIdFromPath('/lpc/belt-leather-brown.png?v=2'), 'belt-leather-brown');
  });

  it('ignores every other request, so the game server keeps answering them', () => {
    // `/health` and `/admin/api` share this listener. A prefix test that matched too widely would
    // swallow one of them and the symptom would be a panel that could not reach its own API.
    for (const other of ['/health', '/admin/api/items', '/lpc/', '/lpc/no-extension', '/', '/lpcx/a.png']) {
      assert.equal(artIdFromPath(other), undefined, `must not claim ${other}`);
    }
  });
});
