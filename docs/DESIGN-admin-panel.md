# The admin panel

_Scoped 2026-08-02, off-roadmap at the owner's request. `HANDOFF.md` had carried it as "requested,
not scoped" since Phase 13._

A web panel for running the game: inspecting and editing players, zones, mobs, items and quests, and
speaking to the world — a global announcement, a line to one room, a line to one player. This
document is the whole plan; the **players section is built first** and the rest arrive in slices.

---

## 1. The one rule: the server is the only writer

Every admin operation goes through the running game server. The panel holds no game state and never
touches a file itself — it is a client, exactly as the game client is, just with a different
vocabulary of intents.

This is not a preference, it falls out of how persistence already works. `PlayerStore` caches every
record it has ever loaded for the life of the process and writes them back on a debounce
(`players.ts`); a character file edited behind a running server is silently overwritten by the next
flush. The only coherent copy of a loaded character is the server's copy, so the server has to be
the thing that edits it. The same holds harder for anything live: hit points set anywhere but the
simulation would be corrected by the next tick.

The corollary for *content* (zones, mobs, later items and quests): the base data under `data/world/`
is **generated** — `npm run worldgen` reproduces it from source, and a hand edit there is lost by
design. Content authoring therefore lands as **overlay files** (`data/world/overrides/`) that the
loaders merge on top of the harvest at boot: a new validated input the game reads, which is exactly
`HANDOFF.md`'s requirement that the suite "read and write the same validated data files the game
loads" — worldgen regenerates the floor, the overrides survive on top of it. No overlay exists yet;
the principle is recorded here so the zones and mobs slices do not each invent their own.

## 2. Architecture

```
packages/admin        the panel: Vite + vanilla TS, port 5274, no framework
packages/server/src/admin.ts   the admin API: routing, validation, audit — deps injected, unit-tested
packages/server/src/index.ts   mounts the router; implements the live-side operations
```

- **Transport is HTTP JSON** under `/admin/api/` on the game server's existing HTTP listener (the
  one already serving `/health`, loopback-only on `GAME_PORT` 8787). Admin operations are
  request/response and want to be `curl`-able; a WebSocket buys nothing at this size and costs
  session machinery. If a live feed is ever worth having (a tailing log pane), it can join the
  existing WS as an authenticated admin hello — not needed now, polling is fine for a dev tool.
- **The panel proxies.** `packages/admin/vite.config.ts` forwards `/admin` to `127.0.0.1:8787`, so
  the browser sees one origin and no CORS machinery exists anywhere. Port 5274 for the same reason
  the client is on 5273: this machine runs other dev servers on the defaults.
- **`admin.ts` is a pure router.** It takes a plain request shape and returns a plain response
  shape, with every capability that touches the live world injected (`AdminDeps`). `index.ts` — the
  file that starts a server on import and therefore cannot be unit-tested — contributes only the
  thin adapter and the dep implementations that genuinely need its helpers (`announceArrival`,
  `syncEntityState`, `send`). The router itself is tested the way `players.ts` is.

## 3. Auth, honestly sized

Three layers, cheapest first, announced at boot like every other switch:

1. **Loopback bind** — inherited. The server already listens on `127.0.0.1` explicitly and the
   admin API is only as reachable as the server.
2. **A mandatory `x-admin-token` header on every `/admin/api` request.** Its *presence* is the
   point, before its value: a custom header forces any cross-origin browser request into a CORS
   preflight, and the server grants CORS to nobody — so a hostile web page in the operator's own
   browser cannot ride it into `http://127.0.0.1:8787`. This is the CSRF defence, not just the
   token's envelope.
3. **`GAME_ADMIN_TOKEN`**, optional. Unset (the dev default) any header value passes; set, values
   must match. The day the server binds anything but loopback, the token stops being optional —
   `admin.ts` refuses to serve without one rather than trusting a bind it cannot see.

Requests from non-loopback addresses are refused outright regardless of token, as belt and braces
against a future bind change.

## 4. Audit

Every mutating call is logged twice from day one: an `[admin]` line on the server console in the
existing log voice, and a JSON line appended to `data/admin-audit.jsonl` (git-ignored with the rest
of `data/`). An admin tool's first bug report is "who changed this" — the answer should predate the
question. Reads are not logged; the file would be all polling.

## 5. Sections

In panel order. Each slice ships only what its underlying system can honestly do — a tab for a
mechanic that does not exist yet says so and does nothing, the same rule the inventory drawer
follows.

> **When each slice lands is no longer this file's call.** As of 2026-08-02 the panel is **Track A
> of `ROADMAP.md`**, interleaved with the phases one slice per round (§2b there). This table stays
> the spec of *what* each slice is; the roadmap owns *when*.

| Section | State | Contents |
| --- | --- | --- |
| **Dashboard** | with players slice | `/health` grown up: uptime, zones and places loaded, populated zones, players online, tick and round lengths, protocol version |
| **Players** | **built first** | §6 below |
| **Messaging** | **built (A2)** | global announcement, line to a place, line to a room, line to a player. One endpoint with an optional target rather than three, because the validation, the audit line and the "how many heard it" answer are identical and only the set of listeners differs. The player-targeted half lives in the player editor, where you can already see who you are talking to |
| **Zones** | **built (A3), read-only** | read first: zone list, room browser with flags/sector/prose, door states, repop clocks. Live ops second: force a repop, work a door. Authoring last, as §1 overlays: room prose, flags, sector |
| **Mobs** | with zones | live: instances by zone, slay, spawn from template. Authoring: template overrides (name, level, combat numbers, aggro) as §1 overlays over the harvested spawn files |
| **Items** | stub until Phase 15 | there is no item system. The light catalogue (`shared/src/light.ts`) is the one item-shaped thing in the game and is code, not data; the tab lists it read-only and says why |
| **Quests** | stub until Phase 17 | nothing exists to edit. The tab names the phase |

**The `announce` channel was taken, and it was a protocol bump (10).** A1 shipped announcements on
`system` with a prefix and this file said a dedicated channel would be a change to make on purpose
rather than in passing; A2 made it. The reason: `system` is the *machine's* voice — your torch
guttering, your rest paying out — and a client that cannot tell that apart from a human being
talking to it can neither style, filter nor alert on either. Every operator line now uses it,
including a tell, because the channel answers *who is speaking* while the prefix
(`[Announcement]` / `[Here]` / `[Admin]`) answers *how widely*.

**A room-scoped line is deliberately not gated on sight.** It is a voice from outside the world, so
a character standing in the dark hears it like everyone else — unlike `say`, which `act.ts` renders
per recipient. The two are different kinds of speech and only one of them is in the fiction.

## 6. The player editor (built now)

### What a player *is* here

Two stores, one character. The **live `Player`** in the simulation exists while connected: pools,
level, position, affects, engagement. The **`PlayerRecord`** on disk persists across sessions:
`seen` bitsets, `taken` pickups, savable affects, the wound (`missing` — the deficit, never the
value), `lastRoom`. The panel shows both and is explicit about which it is editing, because the
overlap has sharp rules:

- **Online, live state wins.** At disconnect `rememberAffects`/`rememberVitals` overwrite the
  record from the live player — so the API *refuses* record-side edits (wound, stored affects) for
  an online character rather than accepting an edit the disconnect will silently discard. Live
  edits go through the simulation's own seams and the client is told immediately.
- **Offline, the record is all there is.** Vitals are edited as the wound (a deficit against
  maxima that are derived at login, not stored); affects are edited as the stored list, validated
  by the same catalogue checks the loader already applies to hand edits.
- **Level and experience are persisted facts — the owner's rule, 2026-08-02.** An admin edit is
  permanent: the level on the file is the character's level, `restoreProgress` re-derives their
  numbers from it at every login, a saved level wins over the `GAME_DEV_LEVEL` rig, and login
  returns the character to `lastRoom` — which is what makes a teleport permanent too. Every admin
  live op flushes the record immediately rather than waiting for the disconnect. What is *not*
  pulled forward is the derivation: hit points and attack bonus still come from `devProfile`'s
  arithmetic until Phase 14b replaces that seam with real ability scores and hit dice — the
  storage is real, the numbers are still the rig's.

### Operations

| Operation | Online | Offline | Through |
| --- | --- | --- | --- |
| Inspect (pools, position, affects, seen/taken counts, save file) | ✓ | ✓ | merged view, provenance labelled |
| Set hp / mana / move | ✓ clamped to `[1..max]` / `[0..max]` | as wound | `sim` + `refreshStatus`; `store.setWound` |
| Heal fully | ✓ | ✓ (clear wound) | same |
| Set level (permanent) | ✓ | ✓ | `store.setProgress` both ways; live also re-profiles through `devProfile` — the derivation Phase 14b replaces. Experience is kept as it was |
| Grant / extinguish light | ✓ | ✓ | `sim.setCarriedLight`; a `light` affect written the way the pre-v9 migration writes one |
| Clear affects | ✓ | ✓ | `sim.restoreAffects(player, [])` — the wholesale replace that recomputes; `record.affects = []` |
| Teleport to room | ✓ | ✓ | live: `sim.relocate` + `announceArrival`, engagement cleared both ways first. Offline: `store.setLastRoom` — login returns a character to `lastRoom` (2026-08-02), so the write *is* the move |
| Send a line (tell) | ✓ | — | `send` on the `system` channel, named as from the operator |
| Kick | ✓ | — | socket close; the ordinary disconnect path does the bookkeeping |
| Reset pickups | ✓ | ✓ | `taken.clear()` — the found-torch state is per-character and this is the tester's "give me my torches back" |
| Delete character | — | ✓ with confirm | store cache evicted, file removed. Refused while online |

Hit points clamp at 1, not the death floor: an admin-induced dying window would enter the mercy and
engagement machinery from a path no design covers, and what death costs is still Phase 13's open
question. When that is decided, the clamp is one line.

**Not offered, deliberately:** rename (the slug is the file's identity and every store key);
seen-map editing beyond counts (a reveal-all is a worldgen-sized bitset op, worth doing when the
zones slice can show the result); anything touching `experience` (nothing spends it yet).

### API

All under `/admin/api`, token header required, mutations audited. `:slug` is `slugify(name)` — the
same function, so the panel and the store cannot disagree about identity.

```
GET    /status                       dashboard numbers
GET    /players                      roster: online (live view) + on disk (file summary)
GET    /players/:slug                one character, both halves, provenance labelled
PATCH  /players/:slug                {hp?|mana?|move?|level?|light?|clearAffects?|wound?|healed?}
POST   /players/:slug/teleport       {room}
POST   /players/:slug/tell           {text}
POST   /players/:slug/kick
POST   /players/:slug/reset-pickups
DELETE /players/:slug
GET    /rooms                        id/name/zone/level list, for the teleport picker
POST   /announce                     {text} — world-wide, the one messaging op shipping early
```

Refusals are `409` with a reason a person can read (`"Ravi is online; edit the live character
instead"`), because the operator is a person mid-task, not a client library.

## 7. What the first slice proves

The pattern the other sections copy: a read view that labels where every fact lives, mutations that
go through the owning system's own seams, refusal over pretence when a fact cannot honestly be
edited, an audit line for everything that changed, and a UI stub for everything that waits on a
phase — named, with the phase number, doing nothing.

## 8. Generating prose, and the copy cascade

Track A's drafting (`server/src/ollama.ts`) shows the model two kinds of borrowed text: **style
examples** from elsewhere in the world, under *"match the voice, rhythm and level of detail exactly"*,
and the **adjacent rooms**, to tie a room to where it stands. Both were unfiltered, and both became
loops the moment the world contained machine-written prose.

**How it presented.** A per-room pass over The Stump Bog's 93 rooms produced **one description for all
37 rooms sharing a title** — word-for-word, adjacent and non-adjacent alike, with 46 of 60 adjacent
same-title pairs over 95% identical. A two-room pilot had shown the opposite (26% overlap, genuinely
different bodies) and missed it entirely, because the pilot ran against an *empty* zone: with no
described neighbours there was nothing to copy.

**The mechanism, both halves.** As the run progressed each room was shown neighbours the same model
had written minutes earlier and told to stay consistent with them, so it reproduced them, and the text
propagated outward from the first room until it saturated the zone. Worse, the *style samples* are
chosen by nearest sector across the whole loaded world — so once The Stag Forest was filled, its swamp
rooms became the Stump Bog's swamp examples, and the strongest copy instruction in the prompt was
pointed at the model's own output from an hour before.

**The rule this settles: never show a generator its own output as an exemplar.** Concretely, and both
turn on `by`, the model name already recorded in the overlay when a draft is saved:

- **Style samples** exclude machine-written rooms outright. A further-away *human* sample beats an
  exactly-matching machine one — few-shot exists to transmit the Duris builders' voice, and a copy of
  a copy transmits drift.
- **Neighbours are named always but quoted only when a human wrote them.** Re-reading the result that
  first suggested neighbours were valuable — a room beside the Gigantic Duskwood writing about
  duskwood — it was the neighbour's *name* carrying the information, never its prose. So the linkage
  survives the fix at no cost.

**The panel is deliberately not filtered.** An author must be able to read their own zone back;
`AdminApi.promptNeighbours` filters what the *model* sees and nothing else. A test pins that
distinction, because "helpfully" widening the fix would hide an author's work from them.
