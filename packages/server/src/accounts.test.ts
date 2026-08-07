/**
 * The account store: hashing, refusals, ownership, resume tokens.
 *
 * Every refusal in DESIGN-accounts.md §5–§6 that the store itself owns is here; the ones that need
 * a socket (second `enter`, the loopback claim gate) live with the connection tests.
 */

import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AccountStore,
  MAX_CHARACTERS_PER_ACCOUNT,
  hashPassword,
  passwordProblem,
  verifyPassword,
  type AccountStoreOptions,
} from './accounts.ts';

function makeStore(options: Omit<AccountStoreOptions, 'dir'> = {}): { store: AccountStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-accounts-'));
  return { store: new AccountStore({ dir, ...options }), dir };
}

/** Runs `body` with `console.warn` captured rather than printed. */
function quietly<T>(body: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]): void => void warnings.push(args.join(' '));
  try {
    return { result: body(), warnings };
  } finally {
    console.warn = real;
  }
}

describe('password hashing', () => {
  it('round-trips, and rejects the wrong password', () => {
    const hash = hashPassword('correct horse');
    assert.equal(verifyPassword('correct horse', hash), true);
    assert.equal(verifyPassword('correct  horse', hash), false);
    assert.equal(verifyPassword('', hash), false);
  });

  it('writes self-describing hashes and verifies foreign parameters', () => {
    const hash = hashPassword('secret');
    assert.match(hash, /^scrypt\$15\$8\$1\$/);
    // A hash written under cheaper parameters — as if by an older build — still verifies, because
    // the parameters ride with the hash rather than living in the code.
    const cheap = hash.replace(/^scrypt\$15\$/, 'scrypt$14$');
    assert.equal(verifyPassword('secret', cheap), false); // different N ⇒ different key…
    const salt = Buffer.from('c2FsdHNhbHRzYWx0c2FsdA==', 'base64');
    const key = scryptSync('secret', salt, 32, { N: 1 << 14, r: 8, p: 1 });
    const handMade = `scrypt$14$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    assert.equal(verifyPassword('secret', handMade), true); // …but honestly-made cheap hashes pass.
  });

  it('refuses garbage hashes without throwing', () => {
    assert.equal(verifyPassword('x', ''), false);
    assert.equal(verifyPassword('x', 'bcrypt$whatever'), false);
    assert.equal(verifyPassword('x', 'scrypt$99$8$1$AA$AA'), false);
    assert.equal(verifyPassword('x', 'scrypt$15$8$1$$'), false);
    assert.equal(verifyPassword('x', 'scrypt$15$8$1$notbase64!!$AA'), false);
  });

  it('draws the password lines where the design note says', () => {
    assert.equal(passwordProblem('a'), undefined);
    assert.notEqual(passwordProblem(''), undefined);
    assert.notEqual(passwordProblem('   '), undefined);
    assert.equal(passwordProblem('x'.repeat(72)), undefined);
    assert.notEqual(passwordProblem('x'.repeat(73)), undefined);
    // Bytes, not characters: 25 three-byte runes exceed the cap that 72 ASCII letters meet.
    assert.notEqual(passwordProblem('魔'.repeat(25)), undefined);
  });
});

describe('AccountStore', () => {
  it('creates, verifies, and refuses the wrong password with one indistinct reason', () => {
    const { store } = makeStore();
    const created = store.create('Danny', 'hunter2!');
    assert.equal(created.ok, true);
    const good = store.verify('Danny', 'hunter2!');
    assert.equal(good.ok, true);
    const bad = store.verify('Danny', 'hunter3!');
    const missing = store.verify('Nobody', 'hunter2!');
    assert.equal(bad.ok, false);
    assert.equal(missing.ok, false);
    if (!bad.ok && !missing.ok) assert.equal(bad.reason, missing.reason);
  });

  it('keys on the same slugify characters use, so case and punctuation cannot mint duplicates', () => {
    const { store } = makeStore();
    assert.equal(store.create('Sir Reginald', 'pw-pw-pw').ok, true);
    const dupe = store.create('sir reginald!', 'other-pw');
    assert.equal(dupe.ok, false);
    assert.equal(store.verify('SIR REGINALD', 'pw-pw-pw').ok, true);
  });

  it('refuses unsluggable names and bad passwords at creation', () => {
    const { store } = makeStore();
    assert.equal(store.create('!!!', 'fine-password').ok, false);
    assert.equal(store.create('Fine', '').ok, false);
    assert.equal(store.create('Fine', '   ').ok, false);
  });

  it('persists across a restart, characters included', () => {
    const { store, dir } = makeStore();
    store.create('Danny', 'hunter2!');
    const account = store.verify('Danny', 'hunter2!');
    assert.equal(account.ok, true);
    if (account.ok) {
      assert.deepEqual(store.claim(account.account.slug, 'aldric'), { ok: true });
    }
    const reborn = new AccountStore({ dir });
    const again = reborn.verify('Danny', 'hunter2!');
    assert.equal(again.ok, true);
    if (again.ok) assert.deepEqual(again.account.characters, ['aldric']);
    assert.equal(reborn.ownerOf('aldric'), 'danny');
  });

  it('shrugs at an unreadable file and loads the rest', () => {
    const { store, dir } = makeStore();
    store.create('Keeper', 'safe-and-sound');
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'hashless.json'), JSON.stringify({ name: 'Hashless' }));
    const { result: reborn, warnings } = quietly(() => new AccountStore({ dir }));
    assert.equal(reborn.verify('Keeper', 'safe-and-sound').ok, true);
    assert.equal(reborn.get('broken'), undefined);
    assert.equal(reborn.get('hashless'), undefined);
    assert.equal(warnings.length, 2);
  });

  it('enforces one owner per character, across accounts and restarts', () => {
    const { store, dir } = makeStore();
    store.create('First', 'pw-first');
    store.create('Second', 'pw-second');
    assert.deepEqual(store.claim('first', 'aldric'), { ok: true });
    assert.deepEqual(store.claim('first', 'aldric'), { ok: true }); // already yours: quiet success
    const stolen = store.claim('second', 'aldric');
    assert.equal(stolen.ok, false);
    const reborn = new AccountStore({ dir });
    assert.equal(reborn.claim('second', 'aldric').ok, false);
    assert.equal(reborn.ownerOf('aldric'), 'first');
  });

  it('holds the sixteen-character line from account.h', () => {
    const { store } = makeStore();
    store.create('Full', 'pw-full!');
    for (let i = 0; i < MAX_CHARACTERS_PER_ACCOUNT; i++) {
      assert.deepEqual(store.claim('full', `char-${i}`), { ok: true });
    }
    const seventeenth = store.claim('full', 'one-too-many');
    assert.equal(seventeenth.ok, false);
  });

  it('keeps first claim and warns when two files name one character', () => {
    const { store, dir } = makeStore();
    store.create('Alpha', 'pw-alpha');
    store.create('Beta', 'pw-beta!');
    store.claim('alpha', 'shared');
    const betaFile = join(dir, 'beta.json');
    const beta = JSON.parse(readFileSync(betaFile, 'utf8')) as { characters: string[] };
    beta.characters = ['shared'];
    writeFileSync(betaFile, JSON.stringify(beta));
    const { result: reborn, warnings } = quietly(() => new AccountStore({ dir }));
    assert.equal(reborn.ownerOf('shared'), 'alpha');
    assert.equal(warnings.length, 1);
  });

  it('setPassword swaps the credential and kills outstanding resumes', () => {
    const { store } = makeStore();
    store.create('Danny', 'old-password');
    const token = store.issueResume('danny');
    assert.equal(store.resume(token)?.slug, 'danny');
    assert.deepEqual(store.setPassword('danny', 'new-password'), { ok: true });
    assert.equal(store.verify('Danny', 'old-password').ok, false);
    assert.equal(store.verify('Danny', 'new-password').ok, true);
    assert.equal(store.resume(token), undefined);
    assert.equal(store.setPassword('nobody', 'whatever!').ok, false);
  });

  it('resume tokens are real until they expire, and garbage never resumes', () => {
    let clock = 1_000_000;
    const { store } = makeStore({ now: () => clock });
    store.create('Danny', 'hunter2!');
    const token = store.issueResume('danny');
    assert.equal(store.resume(token)?.slug, 'danny');
    assert.equal(store.resume('not-a-token'), undefined);
    clock += 7 * 24 * 60 * 60 * 1000 + 1;
    assert.equal(store.resume(token), undefined);
  });
});
