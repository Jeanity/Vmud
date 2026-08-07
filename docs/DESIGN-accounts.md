# Accounts — the decisions login cannot be built without

_2026-08-08. Written before any code, the way `DESIGN-skills.md` and `DESIGN-zone-geometry.md` were,
and pulled **ahead of Phase 21** on the roadmap's own argument: the parking-lot row (owner,
2026-08-05, re-affirmed 2026-08-07) calls this the most misplaced thing on the schedule, because it
changes the protocol's first message and the meaning of every save file, and its cost grows with
every persisted field added before it lands. Phase 21's character creation also needs somebody to
create *for*. This note settles the parking lot's four open questions and one it did not ask._

_Built the same day, whole — and the drive corrected three §5 details, which is the note earning
its keep: the picker reads the store's **live cache** before the disk (`PlayerStore.nameOf`; a
character minted this boot has a name before it has a file); the hands-free path **holds `enter`
until the scene's handlers exist** (`scene.onReady` → `LoginGate.setReady` — the world answers
`enter` immediately, and a message with no listener is a message that never was); and an
auto-`enter` refusal **raises the picker it skipped** rather than writing its reason into a hidden
panel. One rule arrived mid-build by owner's order and lives beside this file's §5: the
**character name law** (`shared/src/names.ts`, tested with the owner's own examples) — letters
only, 2–12, the source's reserved words, rude roots matched through their evasion spellings,
famous names refused. Mints only; the flotsam of §6 keeps its digits._

**What exists today, precisely.** The name *is* the identity: the client's first message is
`hello {protocol, name}` (`protocol.ts:593`), the server does `store.load(name)` and you are that
character (`index.ts:8255`). Two tabs typing `Aldric` are one character. No password, no account, no
creation step. The one reason this has not mattered is `http.listen(PORT, '127.0.0.1')` — nothing
off this machine can reach the game. **The bind and the authentication are one decision and must
never become two**; this phase builds the authentication and explicitly does *not* touch the bind
(§8).

---

## 1. The shape is account-then-character, sixteen to one

Transcribed, not invented. `account.h:15` says `MAX_CHARS_PER_ACCOUNT 16`; `acct_entry` owns a list
of `acct_chars`, each carrying name, level, class and racewar side. So: **one account, a password,
up to sixteen characters.** A character still has no password of its own — the account is the unit
of authentication, the character the unit of play. The account remembers when each side of the
racewar was last played (`acct_good` / `acct_evil`, enforced with a one-hour switch timer at
`account.c:940–955`) — nothing here uses that yet, but the field layout leaves room, because Phase
21's race-list decision will want it.

**Account names get the same `slugify` as character names** and live in their own namespace
(`data/accounts/` vs `data/players/`), so an account and a character may share a name without
colliding. An empty slug is rejected the same way the store rejects it.

## 2. The hash is scrypt, from Node's own crypto — a documented deviation

The parking lot offered bcrypt (what `account.c:62–77` does, via `crypt()`) or argon2id (the modern
choice), with the one hard rule *neither should be hand-rolled*. Both are dependencies — argon2 a
native module, painful on Windows; bcrypt a package this project otherwise does not need. **Node
ships `crypto.scrypt`**: memory-hard, OWASP-listed, OpenSSL's implementation, zero new
dependencies. That satisfies the rule's intent — we write no crypto, we only call it.

- Parameters: `N=2^15, r=8, p=1`, 16-byte random salt, 32-byte key.
- Stored as `scrypt$15$8$1$<salt b64>$<key b64>` — parameters ride with the hash, so they can be
  raised later and old hashes still verify; a future login under a raised cost re-hashes.
- Comparison through `timingSafeEqual`, never `===`.
- Password rules: non-empty after trim, ≤ 72 bytes, and nothing else. Policy is an operator
  decision for a public server; a floor invented today would only be a guess.

## 3. No email — the operator is the reset path

The parking lot's second question, answered: **accounts store no email address.** Duris verifies
one (`acct_confirmation`, `account.c:687`); we deliberately do not. An email is a password-reset
path, and also a thing to store, protect, and regret — the row itself calls a no-email server a
defensible choice, and this server is one operator and their friends. The reset path that replaces
it is the admin API (§7): the operator sets a new password over loopback, exactly as trusted as the
person running the process. If this game ever grows past "the operator knows every player", email
is the feature to revisit — as its own row, with its own storage argument.

## 4. Where accounts live

`data/accounts/<slug>.json`, sibling of `data/players/`, git-ignored the same way (they are runtime
state, not world data — the `overrides/` tracking argument does not apply, and an account file must
never be committed). One file per account:

```json
{ "name": "Danny", "hash": "scrypt$15$8$1$…$…", "createdAt": "…", "lastSeen": "…",
  "characters": ["aldric", "borin"] }
```

**Ownership lives here and only here.** A character file stays pure character state; the account
lists its character slugs, exactly as `acct_character_list` does. One source of truth, and the
in-memory index (slug → owning account) built at boot is what makes `ownerOf` cheap and global
uniqueness enforceable. All account files load at boot — they are tiny, and it means `verify`
never touches disk on the hot path.

## 5. The wire flow — protocol 23, and `hello` does not survive it

The first message changes, which is the whole reason this phase is early. `hello` is **removed**,
not deprecated: a protocol bump is the mechanism that makes half-migrated clients impossible, and
the probe scripts that send `hello` are disposable by design (HANDOFF's proof method gets updated
with this note).

```
C→S  auth   { protocol, account, password, create? }   — or —  { protocol, resume }
S→C  authFailed { reason }          socket stays open; a small per-socket budget, then close
S→C  account    { account, characters: [{name, level?, lastSeen?}], max, resume }
C→S  enter  { name }                an owned name, or a claimable/new one (§6)
S→C  welcome …                      everything from here is exactly today's sequence
```

- `create: true` is an explicit flag off the login form's toggle — login for an unknown account
  fails rather than auto-creating, because a typo must not mint an empty account.
- `authFailed` exists apart from `rejected` because `rejected` closes the socket (right for a
  protocol mismatch, wrong for a mistyped password).
- After `enter`, the server runs the same spawn/restore/welcome path as today, moved not changed.
- **A character already in the world refuses a second `enter`** ("already playing"). Today two tabs
  on one name share one record by accident; under accounts that becomes an explicit refusal.
- Five failed `auth`s close the socket. Per-IP throttling is go-live work (§8) — every address is
  loopback today, so counting by it would count nothing.

## 6. Existing characters: unowned, and claimable only over loopback

There are ~114 character files with no owner. They stay **unowned** until claimed — no migration
script guesses at ownership.

- `enter` with a name that is **yours** → play.
- `enter` with a name that is **free** (no file, no owner) → created and claimed by your account,
  if you have room among the sixteen.
- `enter` with a name that **exists but is unowned** → claimed by your account **only if the
  connection's remote address is loopback** — the same gate the admin API trusts, checked before
  anything else. Over loopback this makes the whole migration story a no-op: the operator logs in
  and touches a character, and it is theirs. The moment the bind opens, unowned names are simply
  not enterable remotely, and assignment is the operator's job (§7). Guess-a-name-take-a-character
  — the exact attack the parking lot names — is dead before the bind ever changes.
- `enter` with a name **owned by someone else** → refused, no matter who asks.

## 7. The admin surface is the reset path, so it ships in the phase

Three endpoints, because §3's no-email decision is only honest if the reset path exists the day a
password can be forgotten:

- `GET /accounts` — list: slug, name, character count, last seen. Read-only.
- `POST /accounts/<slug>/password` — set a new password. The operator-mediated reset.
- `POST /accounts/<slug>/claim` — assign an unowned character to an account. The post-bind
  migration path.

All behind the existing loopback-then-token gate, audited like every other admin write. Panel UI
for these is a Track A row, not this phase — the endpoints are the mechanism; curl is an acceptable
operator experience for a password reset that happens once a month.

## 8. What this phase deliberately does not do

- **The bind does not change.** `127.0.0.1` stays. Going live is its own decision with its own
  order — accounts, then bind, then tunnel — and this phase is only the first word of it.
- **No per-IP throttling, no lockouts** — loopback makes them theatre today. A go-live checklist
  item, recorded here so it is not forgotten: rate-limit `auth` by address before the bind opens.
- **No racewar timer, no per-account IP history** (`acct_ip`) — Phase 21 hooks, transcribed in §1
  so their place is held.
- **No password strength policy, no email, no MFA.** §2 and §3 say why.
- **Character deletion stays out** — Duris has it behind confirmation; it belongs with the
  destroy-an-item confirmation pattern already in the parking lot.

## 9. Slices

1. **The store** — `accounts.ts`: create/verify/claim/ownerOf, scrypt behind it, sessions
   (32-byte resume tokens, in-memory, 7-day TTL), tests for every refusal in §5–§6.
2. **The gate** — protocol 23, `hello` removed, the auth→enter state machine in `index.ts`, the
   spawn path moved behind it untouched. `GAME_DEV_ACCOUNT=name:pass` boots a standing dev account,
   announced and default-off like every `GAME_DEV_*`.
3. **The door** — the client login overlay: account/password with a create toggle, then the
   character list; resume token in `sessionStorage` (per-tab, like the name it replaces);
   `?account=&password=` as the dev-convenience successor to `?name=`.
4. **The reset path** — §7's three endpoints, with tests beside the other admin tests.
5. **The proof** — drive it: wrong password refused and the socket survives, right password lists
   characters, an unowned name claims over loopback, a second `enter` on a live character refuses,
   and the resume token survives a reload. Then the docs: this note's corrections if the build
   disagrees with it, ROADMAP's cadence row and parking-lot verdict, HANDOFF's proof method taught
   to speak `auth`.
