/**
 * Accounts — who may connect, and which characters are theirs.
 *
 * One JSON file per account under `data/accounts/`, sibling of `data/players/` and git-ignored the
 * same way. The account is the unit of authentication, the character the unit of play: one account
 * owns up to {@link MAX_CHARACTERS_PER_ACCOUNT} characters, transcribed from the source's
 * `MAX_CHARS_PER_ACCOUNT 16` (`account.h:15`). See `docs/DESIGN-accounts.md` for every decision
 * this file is built on.
 *
 * ## Ownership lives here and only here
 *
 * A character file stays pure character state; the account lists its character slugs, exactly as
 * the source's `acct_character_list` does. The `owners` index (character slug → account slug) is
 * rebuilt from those lists at boot, which is what makes {@link AccountStore.ownerOf} cheap and
 * global uniqueness enforceable — two accounts can never hold the same character because every
 * claim goes through one map.
 *
 * ## Randomness
 *
 * Salts and resume tokens come from `crypto.randomBytes`, deliberately outside the seeded-RNG rule:
 * that rule exists to keep the *simulation* reproducible, and authentication is not simulation — a
 * predictable salt would be a vulnerability, not a desync.
 *
 * ## Passwords
 *
 * scrypt via Node's own crypto — memory-hard, OpenSSL's implementation, zero new dependencies. The
 * parameters ride with the hash (`scrypt$logN$r$p$salt$key`), so they can be raised later and every
 * old hash still verifies. Comparison is `timingSafeEqual`, and an unknown account burns a hash on
 * a throwaway record so "no such account" and "wrong password" cost the same time.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { slugify } from './players.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_ACCOUNT_DIR = join(REPO_ROOT, 'data', 'accounts');

/** `account.h:15` — the source's cap, kept as-is. */
export const MAX_CHARACTERS_PER_ACCOUNT = 16;

/** Longest password accepted, in UTF-8 bytes. A cap, not a policy — see the design note §2. */
export const MAX_PASSWORD_BYTES = 72;

/** How long a resume token survives after issue. */
const RESUME_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Hashing                                                                     */
/* -------------------------------------------------------------------------- */

// N=2^15, r=8, p=1 — 32 MiB per hash, interactive-login territory. maxmem sits at double the
// requirement because Node's default (32 MiB) is *exactly* 128·N·r and rejects the call.
const SCRYPT_LOG_N = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 32;
const SCRYPT_MAX_MEM = 64 * 1024 * 1024;

/** Hashes a password into a self-describing `scrypt$logN$r$p$salt$key` string. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT_KEY_BYTES, {
    N: 1 << SCRYPT_LOG_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAX_MEM,
  });
  return [
    'scrypt',
    String(SCRYPT_LOG_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash, reading the parameters out of the hash itself so a
 * future cost raise leaves old records verifiable. Unparseable hashes verify as false rather than
 * throwing — a corrupted record must read as "wrong password", not crash a login.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(logN) || logN < 1 || logN > 24) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;
  try {
    const salt = Buffer.from(parts[4] ?? '', 'base64');
    const expected = Buffer.from(parts[5] ?? '', 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const key = scryptSync(password, salt, expected.length, {
      N: 1 << logN,
      r,
      p,
      maxmem: SCRYPT_MAX_MEM,
    });
    return timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/**
 * A password an account can be created with: non-empty once trimmed (a run of spaces is a typo, not
 * a secret), at most {@link MAX_PASSWORD_BYTES} UTF-8 bytes. The password is hashed *as given* —
 * the trim is only the emptiness test.
 */
export function passwordProblem(password: string): string | undefined {
  if (password.trim().length === 0) return 'password must not be empty';
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export interface AccountRecord {
  /** The filename's identity — what every store operation keys on. */
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
  lastSeen: string | undefined;
  hash: string;
  /** Character slugs, in claim order. The single source of ownership truth. */
  readonly characters: string[];
}

/** What a stored file looks like. Everything optional: a partial record loads as far as it can. */
interface StoredAccount {
  name?: string | undefined;
  hash?: string | undefined;
  createdAt?: string | undefined;
  lastSeen?: string | undefined;
  characters?: unknown;
}

export type AuthFailure = { readonly ok: false; readonly reason: string };
export type AuthSuccess = { readonly ok: true; readonly account: AccountRecord };
export type AuthResult = AuthSuccess | AuthFailure;

export interface AccountStoreOptions {
  dir?: string;
  /** Injected clock for expiry tests. Wall time, not the simulation tick. */
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export class AccountStore {
  private readonly accounts = new Map<string, AccountRecord>();
  /** character slug → account slug. Rebuilt from the account files at boot. */
  private readonly owners = new Map<string, string>();
  private readonly resumes = new Map<string, { slug: string; expires: number }>();
  private readonly dir: string;
  private readonly now: () => number;
  /** Burned for unknown accounts so their failures cost the same as a wrong password. */
  private readonly dummyHash = hashPassword(randomBytes(16).toString('base64'));

  constructor(options: AccountStoreOptions = {}) {
    this.dir = options.dir ?? DEFAULT_ACCOUNT_DIR;
    this.now = options.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true });
    this.loadAll();
  }

  /** Every account file loads at boot — they are tiny, and `verify` must never touch disk. */
  private loadAll(): void {
    for (const file of readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue;
      const slug = file.slice(0, -'.json'.length);
      try {
        const stored = JSON.parse(readFileSync(join(this.dir, file), 'utf8')) as StoredAccount;
        if (typeof stored.hash !== 'string' || stored.hash.length === 0) {
          throw new Error('no password hash');
        }
        const characters = Array.isArray(stored.characters)
          ? stored.characters.filter((c): c is string => typeof c === 'string' && c.length > 0)
          : [];
        const record: AccountRecord = {
          slug,
          name: typeof stored.name === 'string' && stored.name.length > 0 ? stored.name : slug,
          createdAt: stored.createdAt ?? new Date(0).toISOString(),
          lastSeen: stored.lastSeen,
          hash: stored.hash,
          characters,
        };
        this.accounts.set(slug, record);
        for (const character of characters) {
          const holder = this.owners.get(character);
          if (holder && holder !== slug) {
            // Two files claiming one character is operator surgery gone wrong; first wins, loudly.
            console.warn(`[accounts] ${character} claimed by both ${holder} and ${slug}; keeping ${holder}`);
            continue;
          }
          this.owners.set(character, slug);
        }
      } catch (error) {
        // An unreadable account locks itself until the operator looks, which beats deleting it or
        // refusing to boot the server over one bad file.
        console.warn(`[accounts] skipping unreadable ${file}: ${String(error)}`);
      }
    }
  }

  private flush(record: AccountRecord): void {
    const stored: StoredAccount = {
      name: record.name,
      hash: record.hash,
      createdAt: record.createdAt,
      lastSeen: record.lastSeen,
      characters: record.characters,
    };
    writeFileSync(join(this.dir, `${record.slug}.json`), JSON.stringify(stored, null, 2));
  }

  /** Creates an account. Refuses an unsluggable name, a taken slug, or a bad password. */
  create(name: string, password: string): AuthResult {
    const trimmed = name.trim().slice(0, 24);
    const slug = slugify(trimmed);
    if (!slug) return { ok: false, reason: 'that name cannot be used' };
    if (this.accounts.has(slug)) return { ok: false, reason: 'that account already exists' };
    const problem = passwordProblem(password);
    if (problem) return { ok: false, reason: problem };
    const record: AccountRecord = {
      slug,
      name: trimmed,
      createdAt: new Date(this.now()).toISOString(),
      lastSeen: undefined,
      hash: hashPassword(password),
      characters: [],
    };
    this.accounts.set(slug, record);
    this.flush(record);
    return { ok: true, account: record };
  }

  /**
   * Checks a name and password. One reason string for both failure modes, on purpose: which half
   * was wrong is exactly what a guesser wants told apart.
   */
  verify(name: string, password: string): AuthResult {
    const record = this.accounts.get(slugify(name.trim()));
    if (!record) {
      verifyPassword(password, this.dummyHash);
      return { ok: false, reason: 'wrong account or password' };
    }
    if (!verifyPassword(password, record.hash)) {
      return { ok: false, reason: 'wrong account or password' };
    }
    record.lastSeen = new Date(this.now()).toISOString();
    this.flush(record);
    return { ok: true, account: record };
  }

  get(slug: string): AccountRecord | undefined {
    return this.accounts.get(slug);
  }

  all(): readonly AccountRecord[] {
    return [...this.accounts.values()];
  }

  /** Which account holds this character, if any. */
  ownerOf(characterSlug: string): string | undefined {
    return this.owners.get(characterSlug);
  }

  /**
   * Puts a character under an account. Refuses a character someone else holds and a sixteenth-plus
   * character; claiming what you already hold is a quiet success, so `enter` needs no pre-check.
   */
  claim(accountSlug: string, characterSlug: string): { ok: true } | AuthFailure {
    const record = this.accounts.get(accountSlug);
    if (!record) return { ok: false, reason: 'no such account' };
    if (!characterSlug) return { ok: false, reason: 'that name cannot be used' };
    const holder = this.owners.get(characterSlug);
    if (holder === accountSlug) return { ok: true };
    if (holder) return { ok: false, reason: 'that character belongs to someone else' };
    if (record.characters.length >= MAX_CHARACTERS_PER_ACCOUNT) {
      return { ok: false, reason: `an account may hold ${MAX_CHARACTERS_PER_ACCOUNT} characters` };
    }
    record.characters.push(characterSlug);
    this.owners.set(characterSlug, accountSlug);
    this.flush(record);
    return { ok: true };
  }

  /** The operator-mediated reset — the design note's answer to having no email. */
  setPassword(accountSlug: string, password: string): { ok: true } | AuthFailure {
    const record = this.accounts.get(accountSlug);
    if (!record) return { ok: false, reason: 'no such account' };
    const problem = passwordProblem(password);
    if (problem) return { ok: false, reason: problem };
    record.hash = hashPassword(password);
    this.flush(record);
    // A reset means the old credential is dead everywhere, resumes included.
    for (const [token, resume] of this.resumes) {
      if (resume.slug === accountSlug) this.resumes.delete(token);
    }
    return { ok: true };
  }

  /**
   * Issues a resume token: 32 random bytes, in memory only, dead after {@link RESUME_TTL_MS} or a
   * restart. What the client stores instead of a password; a lost one just means the login form.
   */
  issueResume(accountSlug: string): string {
    const token = randomBytes(32).toString('base64url');
    this.resumes.set(token, { slug: accountSlug, expires: this.now() + RESUME_TTL_MS });
    return token;
  }

  /** The account a resume token names, if the token is real and alive. */
  resume(token: string): AccountRecord | undefined {
    const found = this.resumes.get(token);
    if (!found) return undefined;
    if (found.expires <= this.now()) {
      this.resumes.delete(token);
      return undefined;
    }
    return this.accounts.get(found.slug);
  }
}
