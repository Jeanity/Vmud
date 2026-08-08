# Handoff

_Last updated 2026-08-08, at the end of the owner's marathon play-and-fix night. Read this first;
it is the shortest path back into the project._

---

## What this is

A **graphical MUD** — not an action RPG with MUD flavour. The owner's framing: *"this is what I am
going for — a graphical MUD."* MUD mechanisms are the specification. It renders the world of
**TorilMUD** (formerly Sojourn), a Forgotten Realms MUD.

Entirely independent of anything under `E:\` (Jeanity, InstaPost, SIG, …). Do not import context or
skills from those projects.

## Where the project lives

**`D:\MyGame` is the checkout** — again. The whole story is one disk changing letters twice, and it is
kept here because both halves cost a session time:

- **2026-08-06**: a newly installed internal HDD took `D:`, pushing the Sett drive (which holds this
  repo) to `F:`. "`D:\MyGame` disappeared mid-session"; nothing was lost — the same directory was simply
  at `F:\MyGame`.
- **2026-08-07**: the owner swapped the letters back. The Sett is `D:` again, the interloper HDD is
  `Z:`, and `F:` no longer exists — that dismount also happened mid-session, taking a running art sweep
  and a worktree with it. Again nothing was lost: work in flight was committed to its branch
  (`claude/quirky-pare-da7d05`) once `D:` was back, and `git worktree repair <path>` re-pointed the
  registration.

Two standing lessons for anyone picking this up after the next letter shuffle:

- `git worktree repair D:\MyGame\.claude\worktrees\<name>` fixes a registration that names a dead
  letter; `git worktree prune` clears ones whose directories are genuinely gone. Branches and commits
  are untouched either way.
- **`npm install` first, in the checkout *and* in any worktree.** The workspace links under
  `node_modules/@mygame/` are junctions with **absolute paths**, so every letter change strands them and
  builds fail with *"Cannot find package '@mygame/shared'"* until they are rebuilt. Gotcha 7 in yet
  another hat. Then delete `packages/*/node_modules/.vite` so the dev servers drop the old resolution.

## Run it

```bash
npm install            # once
npm run dev            # server + client + admin panel together
npm run dev:supervised  # the same, but the server runs under the supervisor (A10)
npm run typecheck      # tsc across all five packages
npm test               # 1,739 tests
npm run worldgen       # rebuild world JSON from the zMUD source DB
```

Client on **5273**, game server on **8787**, admin panel on **5274** (`npm run dev` starts all
three). The server reads **`GAME_PORT`, never `PORT`** — dev harnesses set `PORT` for the web server
and `concurrently` passes it to every child.

**`npm run dev` and `npm run dev:supervised` are alternatives, never both.** The first runs the
server under `node --watch`, which is what you want while editing code. The second runs it under the
**supervisor** on **8790** (`SUPERVISOR_PORT`, and it reads that and never `PORT` either), which is
what you want while *operating* it — the panel's Server tab can then stop and start it, and it comes
back on its own when it crashes. Running both would put two things on `GAME_PORT`, and gotcha 2 says
Windows would tell you that succeeded.

Which zones load is **data, not code**: `world.config.json` at the repo root. Adding a zone id there
and restarting is the whole of "installing" a zone.

## State: green

- **1,739 tests** (952 server, 644 shared, 143 worldgen), typecheck clean across all five packages.
  Four of the server's are `world.test.ts`'s, which **skip themselves when `data/world` is absent** —
  a fresh clone or a new worktree reports fewer until `npm run worldgen` has run.
- **Connecting now takes an account** — protocol 23, `DESIGN-accounts.md`. In dev:
  `GAME_DEV_ACCOUNT=dev:devpass` on the server and `?account=dev&password=devpass` on the client
  reproduce the old walk-straight-in flow; `data/accounts/` is git-ignored runtime state beside
  `data/players/`.
- `data/` is git-ignored and reproducible by `npm run worldgen` — **except `data/world/overrides/`**,
  which is hand-authored content no command can regenerate and is therefore the one thing under
  `data/` that git tracks. See `server/src/overrides.ts`.
- Four zones loaded, 23 places: **36 IceCrag Castle** (219 rooms, 11 levels) and **168 Kobold
  Settlement** (99 rooms, 6 levels), both Duris-matched and carrying harvested prose, flags and real
  terrain; plus **260 The Stag Forest** and **261 The Stump Bog** (98 + 93 rooms), unmatched but joined
  by 13 exits each way, which is what cross-zone travel is tested against. **Spawn moved in Phase 14b**
  to room 41260, An Overgrown Field, in the Kobold Settlement — IceCrag's population runs level 15–60
  and a new character could not win a fight anywhere they could walk to. 168 is populated now too.

### Built and verified

| Area | State |
| --- | --- |
| World pipeline | 327 zones / 46,508 rooms from a zMUD mapper SQLite DB |
| Multi-zone server | Authoritative, 100 ms tick, room-scoped interest management |
| Accounts and login | Protocol 23 handshake (`auth`→`account`→`enter`), scrypt accounts owning ≤16 characters, resume tokens, the character name law, admin reset path — see DESIGN-accounts.md |
| Zone + level travel | One operation — see `Place` below |
| Visibility | Tile-granular shadowcasting line of sight, three states, persisted per character |
| Light sources | Catalogue, durations, expiry chains, ground pickups, room-mode illumination |
| Click-to-move | Server-side A*, gated on tiles you have **seen**. One `moveTo` per press, unfiltered — the client-side drag filter was removed 2026-08-08, see below |
| Hold-to-drag | Virtual joystick — straight-line steering, **not** gated. **Measured on the wire 2026-08-08**: press → one `moveTo`; the hold crosses `DRAG_HOLD_MS` at 146 ms → `stop`; then 55 `steer` frames over 1.5 s ending `dx:0, dy:0` on release — and **no `moveTo` at all while held**. That last absence is the point: a drag re-paths nothing, so the `dragging` filter `requestMoveTo` used to carry was unreachable and is gone |
| Camera | Discrete zoom ladder (defaults to 0.5), follows the character; right-drag pans and lets go, driving re-attaches; `M` for the map overview |
| Fog brightness | Live slider, persisted |
| Affects | One timed-modifier record for everything; the carried light is now one row of it |
| Actors | Players and mobs are one kind of thing in one map — `Actor` / `Player` / `Mob` in `sim.ts` |
| Mobs | 92 in IceCrag, harvested from Duris' own `.mob`/`.zon` and repopping on a re-rolled clock. **They move now** — but only to hunt |
| Zone reset | Additive — nothing despawns. Per-vnum limits, world-wide, so a lured mob leaves a hole |
| Aggression | A **predicate** over the target, not a boolean. 13 aggressive spawns in IceCrag; only `all` is evaluable until races and alignment exist (Phase 21) |
| Noticing | Delayed reaction, **revalidated when the timer fires**. It turns toward you and says so; it cannot attack yet (Phase 11) |
| Mob memory | Per-character, so a mob announces you once. Cleared on disconnect — entity ids get reissued |
| Pursuit | Room-graph BFS for the exit, tile movement to get there. One room per 1.5 s, which is faster than you walk. 30 of IceCrag's 61 templates hunt |
| What stops a chase | A Place boundary, `trackRooms`, the give-up timer, or no route. `safe` and `no_mob` rooms are cut out of the graph, so a hunter routes *around* them |
| Combat | Engagement is a **pointer**, not a distance — blows land wherever you stand in the room. Per-actor round clocks. `kill <target>` starts it |
| Leaving a fight | **You cannot walk out**, on all four movement paths: the typed direction, the `move` intent a keybind sends, the `moveTo` a click sends, and steering (gated in `Simulation.tick`, the only place that sees a step about to cross). Moving *inside* the room stays free. `flee` is the way out |
| Station-keeping | An engaged mob closes to one tile and **follows you around the room** at a hunter's pace — the fight moves with you. Knocked-down bodies stay down (`canMove` is the gate, so Phase 19's bash needs no code). No range check anywhere: this walks a body toward a fight it is already in. Threat drives it for free, so a tank holds the thing beside them. `server/src/station.ts` |
| Target menu | Click a body: a menu names it and offers Look at / Attack / Loot. Verbs send an **entity id** (protocol 11) — the thing a keyword cannot say, since three patrol members share a name and now move. Resolved server-side through the same visible-set gate a typed word passes. A container on the floor also offers **Look inside**, above Get, since reading a sack is what you do before deciding to carry it; the row needs `EntityView.container` (protocol 13) because which of 16,421 catalogue entries hold things is content, and content stays server-side. The flag says *is a container* and not *what is in it* — sending contents to everyone in the room would hand out the answer to the verb. `client/src/targetmenu.ts` |
| Facing | **You face what you are dealing with**, not the way you are walking: the door you open, the corpse you loot, the person you `look` at, and in a fight your opponent — *both* parties, so retreating walks you backwards with your eyes on it. Movement is the fallback. **Server-authoritative**: the client's own `facingOf` is deleted, and `syncTurn` tells a character about their own turn |
| Combat log | The d20, the total and the target's AC on every swing, rendered per recipient — second person for the participants, third for onlookers |
| Mercy | **Players only.** A downed character stops being a target; a mob fights to the death. A body that cannot defend itself is never missed |
| Health bars | Over every body but your own, hidden at full health, green → amber → red |
| Threat | A table per fighting mob, 110% hysteresis so a tank can hold aggro. **Aggressors only** — a mob never rounds on a bystander |
| Participation | Separate from threat: helping an aggressor in any way joins the fight, so a healer on zero threat is still a target |
| Assist | `ACT_PROTECTOR`, room-scoped as the source has it. 34 of IceCrag's 61 templates |
| Death | A mob dies, is removed, and leaves a corpse where it fell. Players stop at the dying window |
| Morale | `ACT_WIMPY` below `level * 6` hit points — **absolute, not a fraction**, because hp is rolled per instance. Checked on the mob's own round boundary; a cornered one fights on. 8 of IceCrag's 61 templates, 5 of them placed, and they are the castle's *staff* rather than its guards |
| Fleeing | One `do_flee` for players and mobs. 78–86% by exits, automatic when not engaged, costs 20–30 movement, a closed door is not a way out. A mob that can path runs **toward its allies**; whatever it fled starts hunting it. **Escaping a fight also leaves you winded for 60 s — nothing mends.**
| Casting | A wind-up as a `cast` event on the scheduler, revalidated once a second — a changed room, lost footing or a lost target breaks it, free (the price is paid at completion). Registry of **eight spells in three kinds** with transcribed dice; **one save per cast** (the ×5-mod trap kept), **one shrug per blow** (rolled by race code for mobs and players alike since Phase 21, at the live per-race bases since the true-up — drow 35). Mobs cast what `MobTemplate.spells` authors, 50% per round boundary, level-rolled quick chant, healing themselves when hurt. Players cast by **`recite`** — 135 harvested scrolls, cast at the scroll's level, no gate of any kind, burnt on recital, refused mid-fight. Buffs are affect nodes (`ac`/`hit`/`saves`) folded beside gear; heals pay threat through `joinBySupporting`; the group roster carries exact hit points (protocol 21) so a heal can be aimed | Refreshed on every flight so a pursuit cannot be out-waited, paid by mob and player alike, and not charged for a flight from nothing |
| A marker over the one you are fighting | Owner's ask (2026-08-04). A downward chevron floating over the body you are engaged with — or **chasing**, which is the requirement that shaped it: *"in case they flee into a room with a bunch of similar mobs that may have been damaged by other players."* `EntityView.fighting` is cleared the instant the fight breaks (`clearEngagements` is the point of the exit), so a marker driven by that alone goes dark exactly when it matters most. **Protocol 16** puts one `SelfView.target` on the wire instead, and the *server* resolves the precedence — the fight while there is one, the pursuit pointer after — because "which body is mine" has a single answer and a marker flickering between two sources is worse than none. The client draws it on an entity **it already holds**, so an id naming a body that fled somewhere unlit simply has nothing to mark; no rule needed, it falls out. Positioned each frame beside the sprite rather than parented to it, so the sprite's own flip cannot mirror the arrow. **Driven live 2026-08-04** against two identical kobold guards: the chevron sat over the one being fought and not its twin. Three things were wrong on that first drive and are now fixed — see the row below |
| The chevron appears on the swing, not on the reply — **fixed 2026-08-04** | Owner's report: *"the chevron does not appear straight way. it takes a round of combat to appear. it should appear instantly."* The cause was not the marker at all. The tick's only routine `self` push walks `vitalsChanged` (`index.ts`), so a player is sent a fresh `SelfView` **when their own pools move** — and your opening swing moves the *mob's* hit points, not yours. The first `self` carrying `target` therefore waited for the mob to hit you back: up to a full 3 s round, and for ever against anything that missed. `startFight` now sends one itself, which is right on its own terms — pointing at something is the player's own act and belongs on their screen in the same beat, not on a timer. Two siblings went with it: the `fled` case pushes `self` to everyone whose pointer the escape broke (`fighting` cleared and `pursuing` set are *both* inputs to `target`), and client-side the chevron is now built **before** the body is looked up and re-shown by `update` whenever its body renders — so a quarry chased into the next room gets its marker back the frame it comes into view, which is the case the whole feature exists for. Verified live: the chevron was up over a kobold guard in a frame whose combat log still showed only the *previous* fight |
| Pursuit that closes — **driven live 2026-08-04** | Verified end to end rather than from the wiring: attacked a kobold guard at level 30, it broke morale and fled west, followed west, and **combat resumed on its own** — no second `kill`. The pointer also survives a distraction: `pursuitTarget` bails while `player.fighting` is set (*"a fight in progress owns the player"*) but does **not** clear `player.pursuing`, so a mob that flees while a second one jumps you is still yours once the interloper is down. **One pursuit slot**, though — a second flight overwrites the pointer and the first quarry is genuinely lost. **Observed and not yet explained**: the resumed blow rendered as *"You hit **something** for 115 damage"* rather than naming the guard, so the re-engage gate (`canSee` at `pursuitTarget`) and `act.ts`'s naming disagreed about whether the body was visible at that instant. Harmless-looking and possibly just message ordering against the watch set `describeRoom` re-seeds — but it is exactly the class of thing that turns out to matter, and it wants ten minutes before anyone builds the target marker on top of this. | A mob that flees leaves you pointing at its **entity id**; arriving where it stands re-engages *that* body — `kill youth` would pick the freshest youth instead. Passes the same watch-set gate a typed kill does, so a mob that flees into darkness is gone. `server/src/pursue.ts` |
| A flee moves exactly one room, and sometimes it does not look like it | Owner reported (2026-08-03) mobs fleeing "several rooms" and "east when there is only a north". **Both are one fact and neither is a flee bug** — settled 2026-08-04 and written up in `RESEARCH-map-data.md`. The graph comes from Duris' `.wld` exits and the layout from the zMUD map's coordinates; they are joined by name and they disagree for **1 exit in 22**. Of 108,094 same-level exits, 95.4% move exactly one cell in the named direction, 4,996 do not (all already marked `portal`), 4,100 move **two or more cells**, and **624 land on the source's own grid square** — which proves the graph is not embeddable in a grid at all, so no worldgen pass can reconcile it. Kobold Settlement's `41299 --south--> 41297` moves six cells, which is exactly the "several rooms" sighting. `attemptFlee` does one `relocate` and then `clearEngagements`, so re-engaging needs somebody to walk after it. **Accepted rather than fixed** (owner, 2026-08-04): a partial straightening would also invalidate every saved `seen` bitset |
| Progression | **SRD sets the shape, Duris sets the magnitudes** (`DESIGN-progression.md`). 22 hit points at level 1 against the SRD's 9; +1d4 a level below 26, +1 above, rolled once and **stored**. Duris' own step experience table, per level and subtractive. Experience finally buys something |
| Starting equipment | A kit rolled at creation into `DESIGN-inventory.md` §6's slots — tunic, leggings, boots, cap, gloves, a weapon — each with its own armour band, so two level-1 characters are genuinely different (AC 12–19). Seeded and stored, so reconnecting is not a reroll |
| Corpses | Decay on a clock (5 min; 30 for a player's), lootable within reach, `loot` refused in combat, and `loot` takes the **nearest unlooted** body |
| Corpse sprites | A pile of bones, and a **single bone once picked clean** — so "has anyone been here" reads from across the room |
| Experience | Divided by contribution: damage **dealt**, damage **taken**, and support. Pool harvested from the `.mob` record. The breakdown is printed |
| Event scheduler | A deterministic min-heap, ties broken on insertion order. One timer per combatant; most actors have none |
| Testing switches | `GAME_DEV_LIGHT`, `GAME_DEV_LEVEL`, `GAME_DEV_DAMAGE`, `GAME_DEV_DECAY_MS` — all default-off, all announced at boot. A test rig, **not** a progression |
| Locked doors | **Locks do not hold.** No door in the world carries a `keyId`, so honouring them walled off 194 of IceCrag's 219 rooms. Doors still shut. See `LOCKS_HOLD` |
| Character art | Real layered LPC — body plus clothing, facing driving the sheet row. The placeholder circles are gone |
| UI shell | Three columns — log, map, character sheet. Both side panes collapse to a rail and remember it; collapsing one gives the map two thirds |
| Vitals | Pinned **over the map**, not in the sheet — pools, light, stance, affects and room are on screen whatever the panes are doing |
| Equipment panel | Paper doll, `DESIGN-inventory.md` §6's eleven slots, filled from the worn kit. **A light no longer takes the main hand** (owner, 2026-08-06): 15a made a carried light override that cell and its own comment predicted the removal, but Phase 16 is what made it *wrong* — light is derived from what is in a light-bearing slot, so a torch you hold **is** `equipped.mainHand` and the doll draws it unaided, while a light that is *not* an equipped item (the dev ring, a scattered pickup — both of which `syncHeldLight` deliberately leaves alone) was painting itself into a hand that held a sword and hiding the sword. The useful half is kept: the slot holding the item the light came from is marked **lit**, matched on the id the wire already carries, so a torch glows in the hand it occupies and a ring that occupies nothing glows nowhere. Two more bugs fell out of the drive and are fixed: the HUD's light line **printed raw colour codes** (`&+ra redwo&+yod torc&+Yh&N`) where the doll three inches away painted them — V6's rule, missed because the six hand-authored lights carry no codes and the catalogue's 64 do; and **login did not re-derive the held light**, so a character who logged out wielding a torch came back at the bare radius of 2 with the torch still in their hand. Phase 5b fixed that for a *finite* light by persisting its burn; an unlimited one has no affect by design, so only re-deriving from the kit can restore it, and login was the one kit path that never called `afterKitChange` |
| Admin panel | `@mygame/admin` on 5274, a client of `/admin/api` on the game server. Players section built: live edits through the sim's own seams, offline edits through the store, refusal over pretence, every mutation audited to `data/admin-audit.jsonl`. **Edits are permanent** — level/experience persist and beat the `GAME_DEV_LEVEL` rig, teleports stick because login returns to `lastRoom`, and every live op flushes the file at once. Global announce works; zones/mobs/items/quests are honest stubs. See `DESIGN-admin-panel.md` |
| Combat feed | The `combat` channel's only destination: a capped, self-scrolling section of the character pane below the display slider. A split, not a mirror — the log no longer carries combat lines. `client/src/combatfeed.ts`; the scene routes the channel |
| Colour | **The MUD's own `&+R` / `&n` notation, kept rather than invented.** `shared/src/colour.ts` parses it; the client log renders spans. The harvest used to strip every code — there are **4.6M of them across the world files** — and now keeps them, so all 216 of IceCrag's descriptions carry the colour their builder wrote. The **join key still strips**. Backgrounds are parsed and dropped (dark ground); the parser emits segments, never markup, because half of what passes through it is other players' `say` |
| Zone browser | Panel section A3/A4b: zones with a **live repop countdown**, and a **drawn map** of one level at a time — a cell per room at its own grid position, exits as lines, sector as colour, flags, live occupants and authoring state as marks, click to select. An exit that leaves the grid is a stub, never a neighbour line. Plus one room in full: sector, flags, prose, every exit with its **live door state**. `admin/src/zonemap.ts` |
| Room authoring | A5. Pick a room on the map and rewrite its **name, prose, terrain and flags**; it takes effect with no restart and is saved to `data/world/overrides/rooms.json`, which **survives `npm run worldgen`** and is the one thing under `data/` that git tracks. **Geometry is refused, not ignored** — id, position and exits are the join key and the grid, and they are A8's. Revert restores from a snapshot `GameWorld` took before the first edit, so undo cannot fail. A sector change re-carves the tilemap and resends `zone` to everyone on the Place; whether it did is decided by comparing the room's terrain **before and after**, never by inspecting the patch. `server/src/overrides.ts` |
| Colour authoring | A palette above every prose box — sixteen swatches, insert-at-caret, wrapping a selection — with a **live preview rendered through the client's own `parseColour`**, because a code you cannot see rendered is a code you get wrong. One component (`admin/src/colourbox.ts`); A6 and A7 reuse it |
| Writing context | The editor shows the **rooms within two steps, with their prose**, above the box. A room cannot be written from its own name: "Southwestern Corner Of the Banquet Hall" does not say whether the hall is laid for a feast or in ruins, and the room next door does. The walk **crosses zone boundaries** — IceCrag's stairs lead into zone 219, which this server does not run, and `GameWorld.referenceRoom` reads it from disk for reading only, never indexed and never reachable. Exits name the real destination now instead of `(not loaded)`. This is the shape the Ollama slice needs, built once so the panel and the generator read the same neighbourhood |
| Drafting prose with a local model | Type a brief — *"a war room high in the guard tower, maps and a cold draught"* — pick from the models Ollama reports at `/api/tags`, and get a description in the house style. **The model drafts; the human commits**: generation saves nothing, the draft lands in the editor's box to be read, rewritten or thrown away, and only Save writes it. The **server** calls Ollama, not the browser — no CORS, and the thing writing prose stays on the server's side of §1's line. **Never in the tick**: it runs on the admin router's async path, and `ollama.ts` must never be imported by simulation code. Style is *shown* — three real descriptions sampled across the zone — and the numeric rules are measured from the world, not chosen. Model and brief are recorded in the overlay, because *"why does this one read differently"* is otherwise unanswerable. `server/src/ollama.ts` |
| Mobs carry what they were authored to carry | Phase 15c, and the reason corpses were empty was **not** missing data. `buildZoneSpawns` looked `arg3` up in the room map for every reset letter; `renum_zone` in `db.c` says `arg3` is a room for `M`, `O`, `F` and `R` and for nothing else. On `E` it is the **wear position**, on `P` the **container's object vnum**, on `G` unused. So "room 16" was looked up 16,263 times, missed every time, and every mob's equipment in the world was deleted without a log line; all 10,409 `G` commands went with it, and of 8,858 `P` commands the 172 that survived were coincidences where a container vnum collided with a room vnum. `CLAUDE.md` gotcha 1 exactly. Fixed, re-harvested, **4,153 commands recovered** — IceCrag now loads 275 pieces of kit and the Kobold Settlement 70. The Phase 8 cursor discipline (`lastMob` separate from `lastSucceeded`) was written for this and needed no change: a mob whose sword is missing from the catalogue still gets its boots |
| Killing something leaves loot | A mob's corpse holds **everything it had, carried and worn** — note the deliberate asymmetry with a player's, which keeps the gear on the body. A player's worn kit is theirs and losing it to one mistake is the feeling the owner named as the worst in a game; a mob's worn kit **is** the reward, and a guard that kept its sword would make the fight pointless. Verified live: killed a kobold guard, looted a steel long sword, a leather jacket and a girth of thick rawhide, wore the first two. The girth is a `WEAR_WAIST` piece and we have no waist slot, so it went to the mob's hands rather than being destroyed, and `wear` refused it by name — which is why `Item.slot` became optional in 15c |
| The catalogue is 16,421 items | Harvested from 454 `.obj` files against `read_object` in `db.c`. Two traps, both tested: the numeric run **flows across line breaks** because the source reads it with `fscanf(" %d ")`, and three header fields are read and thrown away by the source itself, so the flags are at positions 6 and 7 and miscounting reads `extra_flags` as a craftsmanship rating. **Armour is compressed, damage is not** — `DESIGN-progression.md` §1 cutting both ways. Weapon dice are verbatim because 14b proved our scale against them; armour runs median 7 / p90 16 / max 200 against a starter kit authored at +0–3, so `floor(sqrt(v))` capped at 8 lands on all three measured points while keeping the whole catalogue's ordering intact. One file for the world, not one per zone: `real_object` is a global lookup, so there is no per-zone answer to "what is object 91000" |
| Item names carry the builder's colours | Found the moment harvested items reached a client: an item's name is **authored text** with the MUD's own codes in it — `&+ma steel long sword` — and the character sheet printed them verbatim. The starter kit's names have none, which is exactly why it survived 15a and 15b. DOM surfaces (log, sheet) now **paint** through `parseColour`; the Phaser world label and the target menu **strip**, because a Phaser text object renders one colour and cannot hold spans |
| Things you can pick up | Phase 15b, and the half of Phase 15 that makes Phase 13's corpses mean something. `get`, `drop`, `wear`, `remove`, `inventory` — all five appended to the command table **below** the words they share a prefix with, so `d` is still down, `w` still west and `r` still rest, and the free letters `g` and `i` land where a Diku player's fingers put them. Their in-combat rules are transcribed from `interp.c` rather than chosen, and the shape is worth reading: four of the five are `CMD_Y` and **`wear` is the only refusal** — you may shed armour mid-fight but not don it. That reading also corrected a comment Phase 14 shipped: it claimed the source refuses `get` in combat, and `CMD_Y(CMD_GET, …)` means the opposite, so `loot` is now allowed mid-fight too. Slots are **bulk, not count** (`DESIGN-inventory.md` §2) — a dagger is 1 of your 20, a tunic 3 — and a full bag **refuses and names what would not fit**, because the alternatives both lose a quest object to something invisible |
| A real floor, not the scatter | `server/src/ground.ts` is a **new store**, which the roadmap insisted on rather than extending `pickups.ts`, and the two are opposites on every count: a pickup is derived from `scatterSeed(roomId)`, one per room, its entity id **is** `-(roomId + 1)`, and being taken is recorded per character; a dropped object is created by an event, there can be any number per room, and taking it removes it. A deterministic scatter cannot represent a thing that was *put* somewhere, and bending it into one would cost the property that makes it good. Same shape `corpses.ts` proved — own store, own ids from −2,000,000, and `EntityView` with `kind: 'item'`, so the renderer needed no new concept. Objects go through the **same light gate as bodies**, so a dagger on the floor of a dark room is genuinely lost. **Not persisted** — see *Not built* |
| Arrows stack; wands run out | Phase 15c §3. `Inventory.items` became `Inventory.stacks` — **a rename on purpose**, so every reader had to be revisited rather than silently compiling against a different meaning. A `Stack` is homogeneous, which is what lets `count` mean anything, and `mergeable` enforces the consequence: a part-used potion will not hide in a stack of full ones, and a container holding anything cannot stack at all. The subtle half is `fits`, which **can no longer be `size <= free`** — the twentieth arrow fills a slot already paid for, so it asks by *simulating the carry*, and `fits` and `carry` then cannot disagree by construction rather than by keeping two branches in step |
| Containers, at depth 2 | §4, owner-confirmed 2026-08-03: your bag holds containers, those containers hold items, and no further. Unbounded nesting is unbounded storage, and Diku has exactly that bug. **A container's contents do not count against the bag holding it** — that is the whole point of carrying one, and without it a quiver is a decoration. `put` and `get … from` are the verbs; refusals are four distinct answers (`not-a-container`, `wrong-kind`, `full`, `too-deep`) rather than one boolean, because a player told *"it will not go in"* learns nothing about which. Verified live: six chicken eggs merged into one stack inside an ironshod mining cart. `look in <container>` reads one alone. **All three verbs work on a container in your bag *or* one at your feet** — a chest by the door is storage you never carry — through one resolver taking **bag first, then your feet**, since `put arrow sack` while standing on an identical sack means the one you are holding. Both writes go **container first, bag last**, and abandon the move if the container has gone: the other order hands an item to a sack that no longer exists and the item is then in neither place. The floor half uses `get`'s reach gate rather than `look`'s — you can look at something across the room and not reach into it. Bare `look <container>` answers the same way, because "what is in it" is the only interesting thing to say about one; a bare `look` at anything else still falls through to the entity, so a kobold doll on the floor cannot swallow `look kobold`. **A container put down is still full** — the ground store carries `held` through a drop and a pickup, and what is inside a floor container counts against the `O` instance census, or a dropped sack would be a way to make the world mint another sword |
| Coin, in all four metals | §8, and Duris has platinum/gold/silver/copper already, so all four are used rather than flattening to gold. Coin is **awarded on the kill** rather than looted from a body — the owner's own simplification (*"you slay a kobold fisherman — you receive 1g 8s 3c"*), which skips a whole class of fiddling. Split by **contribution, not evenly**: weighted by damage dealt and healing done, via largest-remainder `apportion` so a purse of 3 copper across two fighters loses nothing. An earlier even-split-then-floor was caught live by the owner — *"Brynn93 only received 1 copper"* — and it was destroying a third to a half of every small purse |
| `wield`, and weapons that need both hands | The verb 15b deferred, and what makes it more than an alias: **557 of the catalogue's 2,841 weapons are two-handed**, so which hand a thing occupies is finally a question with consequences. Harvested from Duris' own disjunction — `extra_flags & ITEM_TWOHANDS \|\| value[0] == WEAPON_2HANDSWORD` — which is not the same as either half: 535 carry the flag, 223 are weapon class 13, and only 201 are both, so **twenty-two two-handed swords have no flag on them**. `ITEM_TWOHANDS` is `BIT_23` of *`extra_flags`*, where the same bit in `wear_flags` is `ITEM_WEAR_BACK`; reading the wrong field would make every backpack a greatsword. Wielding one sheds whatever is in the off hand **into the bag** rather than refusing as Duris does — the house rule `wear` already follows, since a character must not end an equip holding less than they started — and the rule runs **both ways**, so strapping on a shield sheds the greatsword. The split is deliberately asymmetric: `wield` refuses anything that is not a weapon, `wear` still accepts one, because a beginner who types the wrong verb at the right item should get their sword in their hand. `interp.c` also settles the in-combat rule and it is the reason the two verbs differ at all: `CMD_N` for wear at sitting, **`CMD_Y` for wield at prone** — drawing a weapon is one motion you can manage flat on your back, and buckling on a breastplate is not |
| The Items panel | The catalogue, searchable — the stub's blocker was never the editor, it was the data. 16,421 entries **searched rather than listed**, because that is three megabytes of JSON and the panel's first paint should not wait on it; the total is reported beside the page so a too-broad search is visible instead of silently truncated. Matched on **keywords, name and vnum**: keywords are Duris' authored list and the thing a player types, the name is matched with colour codes stripped (or `silver` misses `&+Ca silver dagger&N`), and the vnum is exact because a reset table names items by number and nothing else. Filters for weapons, two-handed, armour and containers. Names are **painted through `parseColour` into spans, never `innerHTML`** — this is third-party authored text. Read-only on purpose: the catalogue is a worldgen output, so editing it here would be editing a build artefact; item overlays are A6. `GET /admin/api/items` is the first admin read that needed a **query string**, since a free-text term is not a path segment |
| Things answer to their authored keywords | Every harvested item and mob carries Duris' own keyword list, and until this landed **nothing player-facing read either** — every matcher split the display name, so `wield two-handed` failed on a sword authored `sword two-handed black` and `kill watch` found nothing with `['sentry', 'guard', 'watch']` authored on the sentry guard. The rule is now **authored ∪ name-split**, both halves colour-stripped, and the union was measured rather than chosen: authored-only strips a working name word from **6,121 items** (`pair` alone is 565 — `remove pair` dies on every pair of gloves) and **129 mobs**, and leaves 8 mobs answering to no word on screen at all. The matchers take the list **injected** (`server/src/keywords.ts` builds it; `matchInventory` and `nearestMatching` accept a `wordsOf`), the same shape as the reset census and for the same reason — the catalogue must not live in `@mygame/shared`, and a field copied onto every `Item` instance would be the fourth entry in the a-reader-line-or-it-is-deleted ledger. Two guards, each against a measured fault: `keywords ?? []` because the loader blind-casts a hand-editable file and a throw inside `wear` takes the whole server down, and `stripColour` on the *authored* half because ten authored keywords carry colour codes (`book&n`, vnum 134032) |
| Every slot a humanoid has | Owner's call (2026-08-04): *"we should add all the slots… items like eyepatches are rare but they should be usable when found by a player."* 15a modelled eleven; Phase 16 takes it to Duris' own **twenty-four**, adding eyes, face, nose, both ears, a second neck, about (cloaks), arms, both wrists, waist, quiver and the ioun stone. Measured: `E` placements landing on a slot we model go from **2,039 of 2,354 (87%) to 2,347 (100%)** — 308 recovered from falling into mobs' hands — and wearable catalogue entries from 11,453 to **13,769**. The waist alone was 94 of the gap. **Paired slots mirror Duris' paired positions** (`FINGER_R`/`_L`, `NECK_1`/`_2`, `WRIST_R`/`_L`, `EARRING_R`/`_L`): one `ITEM_WEAR` bit says what kind of place, the position says which one. Still missing on purpose: tails, horns and the four-arm positions want a **race** that has them (Phase 21), barding wants mounts, and `ATTACH_BELT_1..3` has no `ITEM_WEAR` bit at all so no item can declare it — the whole world uses it twice. The paper doll keeps its eleven cells and the rest render as a line underneath, shown only when filled: a permanently empty "eyes" row would make a rare find look like a missing feature. **Two duplicate slot tables were deleted in the process** — worldgen had its own copy of the wear-bit order and the client its own copy of the slot list, and both went stale the instant the shared one grew. The worldgen one was silent: every bracer, cloak and eyepatch stayed slotless and the only symptom was a number in a report |
| A shield is drawn on the body | Phase 16, and the first thing a character *carries* that is visible. LPC's heater shield (wooden face) from the Universal LPC Spritesheet Generator, dropped in byte-for-byte — the generator's sheets are the same 576x256 / 128x256 geometry at 64 px a frame that every 15a garment uses, so it needed no processing. Drawn **last**, over everything: LPC ships shields as a foreground layer with each facing already drawn correctly, so no per-facing rule of ours is needed. **Protocol 14 is what made it possible**: `EntityView.wearing` carried slot → *item id*, and a client holding `obj:32` cannot know it is a shield rather than a lantern — there are 419 shields in the catalogue. The value is now an **art class**, which is *what the thing is* rather than which sheet draws it, so swapping the heater for a kite is one line in the client and no protocol change. The class comes from `DURIS_ITEM.shield` and is **injected into `Simulation` from `index.ts`**, because the catalogue is not `sim.ts`'s business. It cannot be derived from the `Item` alone and that was measured: of 4,820 off-hand items, "has armour and no damage" catches 417 — but **177 of those are sleeves and bracers**, and a character in studded leather sleeves would have grown a shield |
| Damage rises with level, and gear finally carries stats | **Phase 16a/16b** — `DESIGN-progression.md` §8 has the measurements. A per-level flat bonus, **rolled once at the level-up and stored** like hit points, landing on `Dice.bonus` so a critical does not double it (the SRD's rule, and the right one: a crit should reward the weapon rather than the character sheet). Bands are **nothing below 6** (14b already calibrated that band and a bonus there breaks it), 2–3 a level to 15, **8–10 across 16–20** because the world's own median hit points jump 203 → 500 there, 3–5 after. Holds the six-to-eight round target to **level 25**, where 14b's honest band ended at 15. **It is a divergence from Duris**, which has no per-level damage bonus at all — `specials.damage_mod` is a *race* multiplier — and the size was decided by one number: a bonus big enough to make a level-50 *same-level* fight seven rounds is **+771**, at which point the weapon is 0.9% of a swing and this is the gear phase. Above 25 the closing factor is multiplicative and belongs to Phase 19/20 and grouping. Verified live: an unequipped level 50 hit a baby kobold for **195** and killed it in one blow, where the same character needed 18.6 rounds before. Records written before this get the band midpoints rather than zero, or a level-40 veteran would return hitting like a novice |
| Gear carries hitroll and damroll | The `.obj` parser had been reading Duris' `A <location> <modifier>` blocks into `RawObject.affects` since the harvest landed and **`toTemplate` dropped every one** — so a level-40 sword beat a level-10 one only by its dice. Now carried: `APPLY_HITROLL` on 3,160 catalogue entries and `APPLY_DAMROLL` on 3,149 (median +2, p90 +4, max +100). **Summed across every slot**, which is what the apply means in the source and why a ring is worth wearing. Negatives are kept — a banana at −10 damroll is content, not corruption. `APPLY_HIT` (2,458 entries) is deliberately **not** carried: maximum hit points are rolled once and stored per §3, and letting a hat change them raises a real question about a wounded character taking it off that this phase does not answer. Verified live: 1d6 unarmed plus a +5 damroll wrap produced 6, 9 and 11 — both endpoints of the range |
| Objects lie in rooms from the zone files | The `O` reset executor, 773 commands. The limit is the whole difficulty: `arg2` caps how many of a vnum exist **world-wide**, so honouring it means counting every instance on every floor, in every bag, inside every container, on every mob and in every corpse — a six-place census, injected into `reset.ts` because that file has no business knowing where an object can hide. Without it every repop adds another sword to the same table and a zone left running overnight is ankle-deep |
| A corpse holds what you were carrying | The Phase 13 `TODO` closed. `Corpse.contents` is real, and `looted` now means **empty** rather than *searched*: a body still holding the one thing you could not carry stays drawn as a pile, and a mob that drops nothing is drawn picked-clean from the moment it falls. Looting is **per item** — each is offered to the bag in turn, so a big thing being skipped does not stop a small one behind it, and what you get never depends on the order somebody died holding things. **A corpse spills before it decays**, the roadmap's own rule: loot destroyed by a player being slow is *"I came back and it was gone"*, which is a worse feeling than *"somebody else got there first"* |
| What death costs, revisited | 14b deferred this with *"a corpse you cannot loot is a character permanently disarmed"*; 15b makes the corpse lootable, so the question went live. **Your bag goes into the corpse; what you are wearing stays on you.** Taking everything is the conventional MUD answer and is wrong here — the owner's stated horror is *"there is nothing worse than playing a game of months and losing everything due to one mistake"*, and a naked corpse run through the zone that just killed you is that mistake compounding. Taking nothing makes death a teleport with an experience bill. The split costs you what you chose to carry, leaves you able to fight back to it, and makes the thirty-minute player-corpse clock a deadline that means something |
| Player killing is off, and it is a switch | Owner's rule (2026-08-03): *"we should not be able to loot other players' corpses as this is not a pkill game… but having it so I can turn it off or on would be a nice feature."* **The default is a fix, not a preference** — nothing refused player-vs-player combat before this: `startFight` checked only that you were not attacking yourself, so the game shipped as a pkill game by omission. One flag gates both halves, because a world where you may kill someone but not take what they dropped is a rule nobody can hold in their head. It is a **file** (`data/world/overrides/settings.json`) rather than a constant, because a switch that reverts on restart kills somebody by a rule nobody meant to be in force; only a real `true` turns it on, since these files are hand-editable and `"yes"` is not consent. Thrown from the panel's **World rules** section: staged on a checkbox, committed by a second explicitly-labelled button, and **announced to everyone online** — finding out PvP is on by dying to it is not acceptable. `server/src/settings.ts` |
| Worn gear is visible | Phase 15a, and the roadmap's own completion test for the phase: what a character wears is drawn on their body, layered LPC over the base. The rolled starter kit from 14b now reaches every client — `EntityView.wearing` carries **slot → item id**, never sheet names, so which LPC garment a leather tunic *is* stays the client's business and a re-skin is not a protocol change. Two characters with different rolls look different: a brown leather tunic and cap against a navy quilted vest and woollen breeches. Layers paint feet → legs → chest → head, the order a person dresses. `mainHand` is **not** drawn — the pack's weapon art is attack animations only (Swing, Thrust, Shoot) with no idle-hold frame, so a visible weapon needs either an attack animation the combat system does not have or custom art. Phase 16's |
| Standing is a different sheet, not a column | Third defect the owner caught: turning on the spot left the legs mid-stride. **There is no rest pose in the walk sheet.** Measured against the pack's own `idle.png`, the *closest* walk column still differs by 173 pixels, and the cycle is eight genuine strides — columns 0–3 leading with one leg, 4–7 with the other — so every column is mid-stride and column 0 was never the neutral frame I had assumed. LPC ships `idle.png` beside `walk.png` for exactly this, so both are loaded and a layer swaps *texture* when it stops. 14 more sheets, ~250 KB, and the cheapest correct answer available |
| The walk cycle is 8 frames, not 9 | Two defects the owner caught by watching. **Stopping left a character frozen mid-stride**: the settle branch tested for *exactly* zero movement, but easing toward the server's position is asymptotic and never arrives, so a stopped sprite always kept sub-pixel residue and never qualified as stopped. One threshold now decides both states with no gap between them. **And a "box flashed every few steps"**: measuring the alpha of every frame of all fourteen staged sheets, **seven have a completely empty column 8** and one is physically 8 columns — column 8 is padding to a common width in half the pack, not a frame. Cycling through it made the boots and cap *vanish* for one frame, exposing a bare head and feet. The cycle is columns 0–7 now, with 0 doubling as the rest pose, which costs nothing because LPC's frame 0 is the both-feet-down contact pose. Verified by rendering all 8 columns × 4 facings × 14 layers and asserting none is empty |
| Characters walk instead of sliding | Owner-reported: *"it looks like the players are ice skating."* They were. Every layer had been staged from the pack's `idle.png` — 2 columns — and drawn at column 0 for ever, so a body slid across the floor in a fixed pose. Re-staged all fourteen sheets from `walk.png` (9 columns × 4 rows: column 0 standing, 1–8 the cycle) and the column now advances with **distance travelled, not wall time** — tie a walk cycle to a timer and the feet run at their own rate while the body moves at another, which reads as sliding just as badly. Measured after prediction, snapping and easing have all had their say, so a character being dragged back by a server correction still walks; a snap past `SNAP_DISTANCE` is a teleport and deliberately does not count |
| What dying costs | Phase 14b's last clause, and the first finding was that **nothing happened at all**: `combat.ts` routes only mobs to `resolveDeath`, so a player who bled past the floor lay at negative hit points for ever and only an admin edit brought them back. Death is now Duris' own charge — **a tenth of the level you were climbing toward** (`exp.death.level.loss`, 0.10), which is far gentler than the `lose_level` sitting in the same file suggests. Level 1 is exempt by Duris' own guard; a level goes only when the charge overdraws the balance, so dying near the top of a level is cheap and near the bottom costs it. The hit points a lost level bought are **kept** — they were rolled and stored, so there is no formula to invert and subtracting an average would let a character farm a maximum by dying. You wake at the configured spawn room, whole and no longer winded, with a real corpse where you fell. **Since 15b, your bag goes into the corpse and your worn gear stays on you** — see the inventory row for why that middle. `DESIGN-progression.md` §6 |
| Never show a generator its own output | A per-room pass over The Stump Bog produced **one description for all 37 rooms sharing a title** — a copy cascade, not sampling convergence. The prompt showed each room neighbours the same model had written minutes earlier, and the style samples were picked by nearest sector across the world, so once The Stag Forest was filled its swamp rooms became the bog's swamp *exemplars*. Both now turn on `by`, the model name recorded in the overlay: style samples exclude machine-written rooms outright, and neighbours are **named always but quoted only when a human wrote them** — the linkage was always carried by the neighbour's name, never its prose. The panel is deliberately unfiltered, because an author must read their own zone back. Result: 93 distinct descriptions for 93 rooms, adjacent same-title overlap **84% → 18%**, effectively-identical pairs **46 → 0**. `DESIGN-admin-panel.md` §8 |
| A zone filled in one pass | `tools/describe-zone.ts` writes a whole zone's missing prose — **one draft per distinct title**, because of 51 repeated titles in the shipped world, 51 share exactly one description and 0 differ. The Stag Forest went from 0 of 98 described to 98 of 98 in 17 minutes over 25 titles, at a mean of 106 words against the house median of 115. Resumable: a title already written is skipped, and failures get a second pass. It **saves**, unlike the panel — named in the file as a departure, because the alternative is not "a human writes it" but "the room stays blank forever" |
| Undescribed rooms say so | A room with no prose logs a dim `[ No description yet. ]`. **Rendered, never stored**: writing it into 40,619 override entries would mark every room authored and destroy the ✎ mark's meaning. The panel has the matching **"needs prose"** filter, which is the authoring queue — 3 rooms in IceCrag, all 98 in The Stag Forest. Giving them prose from a short prompt via a local model is the next A slice |
| Picking art from pictures, not ids | A7c, and the half of A7b that made the field usable. `torso-tunic-brown` and `torso-shirt-brown` are one word apart and look nothing alike — **the id does not describe the picture**, so a dropdown of 319 ids is a list of guesses and the control shows images. The tile is a 64×64 window onto the staged sheet at **column 0 of row 2** (LPC's south-facing standing frame, `scene.ts`'s own row order) done with `background-position`: no canvas, no fetch, one cached image per sheet however often it is drawn, and `pixelated` because 64 px art smoothed at any scale but 1:1 is a smudge. Opens on the item's own slot — 17 sheets for `feet` rather than 319 — with a tick to see everything, since `artgen`'s slot mapping is a hint the server enforces nowhere. `itemRow` carries `art` now, so the search list shows **which** of 16,421 items have a picture; that was a recorded loose end and it is what makes the picker's work visible after Save. `admin/src/artpicker.ts` |
| Getting a sheet to the panel at all | The real work behind A7c. `artgen` stages the PNGs into `packages/client/public/lpc/`, which the **client's** 5273 serves; the panel is 5274 and proxies only `/admin`. A picker pointed at the client's port would break whenever somebody ran the server and the panel without the game — the exact case the admin suite exists for. So the **game server** serves them, from the same files rather than a copy, so a re-stage cannot leave the picker offering art the game no longer has. **Ungated, and mechanically rather than as a relaxation**: the admin gate's first defence is that `x-admin-token` must be *present* (a custom header forces a CORS preflight nothing here answers), an `<img>` cannot send a header, and gating would mean fetching several hundred blobs onto a canvas to protect CC-BY-SA sheets of boots the game already serves unauthenticated to every player. The path is closed by **looking the id up in `LPC_ART_BY_ID`**, never by joining it — traversal is refused for the same reason a typo is, so there is no filter to get wrong. `server/src/art.ts`, whose two halves are split out of `index.ts` precisely so they have a test |
| A lantern in your bag lights nothing | **Phase 16**, and the collapse of the interim `carriedLight` — a field *beside* the inventory rather than a fact about it, so you could own a lantern and be in the dark. Duris settles it in one line (`handler.c:431`): a light lights you between `WIELD` and `HOLD` and only while `value[2]` is non-zero. The world's **64 lights are harvested**, 32 that never go out and 32 that burn. **Radius is ours, duration is Duris'** — Diku light is a boolean so there is no radius to transcribe, and inventing a ladder would contradict `light.ts`'s own finding that `ROOM_GAP` makes **3 the gate**; so every light sees as far as a torch and what separates a candle from a lantern is how long you keep it. The hour is **ten seconds**, pinned by making the two catalogues agree where they overlap: Duris' 24-hour redwood torch against our 240-second one. Above a thousand hours a light is unlimited, because one redwood torch is authored at **99,999,999** hours. Two contributors to the fold: an unlimited held light is a standing fact and needs no clock, a finite one is *only* its burn affect so that expiry actually stops it with the item still in hand. Hangs off `afterKitChange`, the one seam every kit change passes through — a lantern reaches a hand by `wear`, `wield`, `get`, a shield displacing it, an admin `give` or a login. Driven: bag → radius 2, hand → radius 3 and 960 s, off → radius 2 and *"You are in the dark."* |
| Gear quality, where the roadmap asked for material | **Phase 16**, and the measurement changed the plan — see `ROADMAP.md`. Condition is `100` on **99.0%** of objects so it is not an axis; material is a **damage-resistance** row in `common.c` and we have no damage types, and it is already baked into `value[0]` anyway. **Craftsmanship** is what carries signal, and using it is a divergence: in Duris the 0–15 ladder does *nothing* — every mechanical use is commented out and it survives only as prose in `identify` — while the builders set it deliberately on a third of the world. Same call V6 made about colour. Thirds of a rung, ±2 against a base of 0–8; **thirds not quarters, because quarters leave only 1.3% of the world below average**. 2,088 armour pieces moved, 1,834 up and 254 down; an earring of mist made by a master artisan went +5 to +7, and the panel's row says so in Duris' own words |
| What you are hauling slows you down | **Phase 16.** `load_modifier` (`actmove.c:79`) transcribed: ten bands from **75** under a tenth full to **300** past 95%, widening as they climb so the *last* thing you pick up costs far more than the first. The bottom band being *below* 100 is Duris' and is the good part — travelling light is a choice, not the absence of a penalty. **Where it is applied is ours and the source says so**: Duris uses this for combat (`fight.c:6414`) and for the prose that makes somebody *"stagger in"*, and charges movement flat. Load counts **worn bulk as well as bag bulk** against the bag's capacity, which looks lopsided and is the point — `DESIGN-inventory.md` §6 puts worn gear outside *capacity* because what you have on is not luggage, and says nothing about *effort*. Mobs are never encumbered: their kit is loot they never chose. Driven: the same field step cost **3 unburdened and 6 loaded** |
| Water you cannot wade into | **Phase 16**, and `SECTOR_REQUIRES_MOVEMENT`'s first caller after five phases on the inert list. Deep water and underwater want `swim`, air and astral want `fly`, and nothing grants either yet — both are Phase 19/20 — so today it is a wall that **says which wall it is** rather than an exit that silently fails. Refused **before stamina is charged**, because being unable to enter deep water is a different no from being too tired and paying for a step you were never going to take would drain the pool of somebody standing on a riverbank pressing east. Driven by making a room deep water through **A5's own authoring**, with no restart: the step was refused, the pool did not move, and every other exit still worked |
| Setting the world up without restarting it | **A4**, and the mob-testing loop every later phase wants. **Live instances, not templates** — Zones says what a zone is *authored* to hold, the Mobs section says what is standing in it, and two sentinel privates of one vnum carry 1,182 and 1,274 hit points because the roll is per instance. Every row has an **entity id**, protocol 11's argument again: a keyword cannot say *which*. **Slay runs `resolveDeath`**, so the body leaves a corpse holding what it carried and the room is told — an admin kill that made a mob vanish would exercise a path the game does not have, and watching the real one is the whole point; nobody is paid experience or coin because nobody hurt it. **Repop passes `runReset`'s `force` flag**, which had existed since Phase 8 with boot as its only caller, and stays additive: the first press reported *+5 mobs, 97 at limit*, the second *+0, 98* — the per-vnum world-wide limit doing its job, which is what makes the button safe to hand somebody. **A door is worked at both ends** through `world.doorway`, since a doorway shut from one side only is a wall from the other, with `closed` and `locked` set independently because `LOCKS_HOLD` is off and testing the day it bites needs them apart. `admin/src/sections/mobs.ts`; doors and Repop live on the Zones page beside what they act on |
| A sword on the ground looks like a sword | **A7d.** An item with authored art draws that art on the floor instead of one of nine category glyphs shared between 16,421 entries; the placeholder is **demoted, not retired**, so an undressed item still reads as the *kind* of thing it is. No protocol change — `sprite` was already a client-resolved string and A7b made the art id the texture key. **Not** from the pack's `preview_row`/`preview_column`, which only **24 of 657** definitions carry. Two owner rules landed with it: **no name label over a dropped thing** (the picture identifies it; `look` is the verb for the detail, and three items on one tile had smeared their names together), and **drops land 1–2 tiles away in a seeded random direction**, bounded by the three-tile pickup reach so nothing lands somewhere you must walk to. Then a third: **icons are cropped to their content's bounding box**, because an LPC frame is person-shaped and a cloak fills only its lower half, so a centred frame put the object low under a void. The crop needed **no PNG decoder in `artgen`** — the client measures a texture it has already loaded, once per sheet-set, cached. Two traps in that: the box must be the **union** across an art's layers or a cloak's halves slide apart, and **`setCrop` does not move the object**, so each image is shifted by the crop's offset from the frame centre |
| Whisper, so a room is not everyone shouting | Owner's ask (2026-08-05) the moment V3's first bubble went up: *"so we aren't all just talking over each other and filling the room with speech bubbles."* **The privacy needed no new mechanism, and that is V3's design paying off**: `from`/`speech` ride the log line itself, so the recipient's line carries them and their client draws a bubble, while the room's line — *"X whispers something to Y"* — carries neither and draws nothing. Nobody wrote a rule saying a whisper is private; it falls out of who receives which sentence. **The room learning *that* it happened is Duris' call**, transcribed: `do_whisper` sends `"$n whispers something to $N."` `TO_NOTVICT`, because whispering in company is itself a visible act. The requirement row is **stricter than `say` on both axes** and that is the source's too — `CMD_N(CMD_WHISPER, STAT_RESTING + POS_SITTING)`: speaking aloud works flat on your back and mid-swing, leaning in to murmur does not. Driven with three sockets: the speaker got their echo, the listener got the words *with* the bubble fields, the bystander got the fact *without* them |
| You watch somebody say it | **V3**, and **protocol 17** — `log` gains `from` and `speech`, set only on the `say` channel. **Additive on the message that already exists, and that is the design rather than thrift**: the speech line is already rendered per recipient and already passes the `act()` gate, so a second send path would be a second answer to *"who may hear this"* and two answers drift. **The sight gate is applied once and the renderer cannot disobey it** — the client draws on an entity it holds, so a speaker outside your light has nothing to attach a bubble to, while the log line they do get still reads *"someone says"*. Same fall-out protocol 16 uses for the chevron. Two things the drive corrected: the bubble is **counter-scaled against the camera** (`setScale(1 / zoom)`), because world space is scaled by a ladder running 0.25 to 2 and one sentence covered a quarter of the map at close zoom; and it draws **above the fog** at depth 60 — owner's rule, *"darkness doesn't affect what can be heard"* — since a bubble beneath the depth-50 fog was dimmed by the unlit air above the speaker's head rather than by anything about the speaker. `sayInWorld` / `advanceBubbles` in `scene.ts` |
| The operator's voice, on screen | **V3's other half**: A2 took the protocol to 10 to give an administrator a channel of their own, and until now this client could tell it from `system` and did nothing with the difference. A banner along the **bottom** of the map — top-centre collided with `#status`, which is pinned top-left, runs most of a narrow map column and comes later in the document so it painted straight through. **A mirror where V1's combat feed is a split**, deliberately: combat lands in the feed and nowhere else because a fight is a stream and duplicating it doubles the noise, while a banner is transient by necessity and an announcement you were looking away for must still be findable — so it shows *and* stays in the log. One at a time, replaced rather than queued, because *"restarts in one minute"* after *"in five minutes"* is exactly where a queue shows the wrong number. `client/src/announce.ts` |
| You can buy a thing from someone | **Phase 17**, and Act V's last. Containers and money landed early in 15c, so what the phase had left was shopkeepers: **694 harvested** from Duris' `.shp` files. **A keeper is a mob vnum and nothing else** — no flag on the instance, no second kind of actor — so a keeper that wanders is still a keeper, one killed and repopped still trades, and **A4's spawn endpoint placed a working shop without knowing shops exist**, which is how it was driven. `list`, `buy`, `sell`, `value`. Coin comes from `utils.h`'s ladder (copper, ×10, ×100, ×1000) and an item's `cost` is in copper, which is why the panel has printed `63185c` since 15c without anyone deciding what the `c` meant; the ladder being decimal makes re-denomination lossless, so `spendCoins` breaks a platinum piece for a one-copper price without charging a rounding error. **The command table imposes nothing** — all four verbs are `CMD_TRIG` in `interp.c`, at `STAT_DEAD + POS_PRONE` and `in_battle = TRUE` — so the two rules that matter live on the keeper: awake and on your feet, and a merchant you are fighting will not serve you. Driven: listed six items, bought a chicken egg for 2 silver 6 copper, and was told *"I will not buy that"* offering it back — because an empty `buysTypes` means **buys nothing**, which is 261 of the 694 |
| Operator messaging | World, a Place, or one room — one endpoint with an optional target, reporting how many heard it. On the **`announce`** channel (protocol 10), a person's voice styled apart from the machine's. A room line is **not** sight-gated: it comes from outside the world |
| Arriving somewhere feels like arriving | **V5**, and Track V's rule holds: no protocol change, no new rules, one client file. Crossing into a new Place was a change of floor tiles and a line in the log; it is now also a brief title card — zone name, and the level under it. **Nothing new had to be sent**, which is the whole reason this is a V item: `announceArrival` already knew the zone, the Place, the previous Place and whether the two differ, because it is the thing that writes the log line. The card fires on **exactly** the two occasions that line is written — walking into somewhere new, and logging in, which is arriving as far as the player is concerned — and on nothing else. That third case is the one that matters: a `zone` message for the Place you are already standing in is a **resync**, not travel, and A5's terrain edit and A8's regrid both send one. A card that flashed every time an operator re-carved a tilemap would be wrong in exactly the way that is hard to notice. **A mirror of `announce.ts`'s shape but not its job** — an announcement is addressed to you and arrives unbidden, so it dwells nine seconds and is kept in the log; an arrival is a caption on something you did on purpose, so it is 2.6 s and is **not** mirrored, because the log already carries the sentence and one keystroke should not print it twice. **The level is omitted for a one-level zone**, answered client-side from the `Zone` it already holds (the distinct `z` values of its rooms): *"level 0"* under a place with no other floors is furniture, not information. **Two things the drive corrected.** The card first sat top-centre and **landed on the vitals** — the same collision V3's banner hit, and worse here, since `#status` is the one readout the handoff says must survive anything; it is a third of the way down now, which is where a title card belongs and is clear of both the HUD and the announce banner. And the constructor **appended** its children rather than replacing them, so building it twice left two pairs in one element with every later write landing on the second — found because a test built a second one. `pointer-events: none` throughout: it floats over the ground you are about to click |
| Two people walk the map as one train | **Phase 18's first half — following.** `ROADMAP.md` gives the phase one rule that decides nearly everything: *"followers move by re-issuing the movement intent, never by teleporting."* A follower who is **moved** arrives wherever the leader is — through closed doors, across deep water, out of a fight, without paying a step's stamina. A follower who is **asked** meets every rule the leader met, separately. So a train that breaks because one member was too tired is the correct outcome and needs no code of its own: it falls out of asking rather than telling, and `walkFollowers` knows about none of those rules. Recursion is free for the same reason — a follower's own followers are picked up when *they* step. **Transcribed from `do_follow` (`actmove.c:3116`), including the two forms that read oddly**: `follow <your own name>` is how you stop, and **`follow stop` is the *leader's* command**, throwing off everyone **in the room** — scoped that way because you can only shake off what you can see, so somebody trailing you from three rooms back keeps following. The follower chooses and the leader does not consent, which reads wrong until you notice the leader's remedy is one word away. One leader at a time, the old link dropped rather than the request refused; but a **ring is refused and costs nothing** — `wouldLoop` walks the chain, and a request that cannot be honoured must not also take away the relationship the character already had. A ring is not a strange state to be in, it is a movement intent that never terminates. Forgotten in **both directions** on disconnect, and whoever was orphaned is told: entity ids are reissued, so a leftover link would drag the next character handed that id along behind a stranger — the same argument `forgetTarget` makes about a mob's memory. `follow` is allowed **mid-fight** (`CMD_Y`), which is the source's call and the right one: it is the only way to arrange a retreat with somebody while the fight that makes you want one is still going. **Driven live 2026-08-05 with two sockets**, which is the only way to see it: Wick followed Sarn, Sarn walked north then east, and Wick was issued each step and arrived behind him; `follow stop` broke it and Sarn's next step left Wick where he stood. **The phase is not done** — consent, the shared list and §4.4's superlinear experience split are its other half, and whisper-to-group carries on that. `server/src/following.ts` |
| The square was a filler column, played as a frame | **The owner's round-end square, finally cornered (2026-08-08) — by his own observation**: *"the square sits on my body… equipment is still visible but the player disappears for that 1 frame."* Body only, swing time, no errors — and this file's founding trauma already named the disease: a padding column played as a frame. The twist that hid it twice: the kit action sheets' final columns are not *empty* padding but **solid filler blocks** — 100% opaque where a real frame is ~20% — invisible to the emptiness check the first measurement used, and pixel-perfect skin-toned when the body sheet drew its own. Every swing played it for its final 90 ms (`ACTION_COLUMNS` slash 7 on a 6-real-frame sheet), and the **down pose had been the hurt sheet's filler outright** (`columns - 1`). Fixed at the root: the filler columns are **cropped off the staged files** (alpha-ratio measured per sheet — 24 cropped, 322 clean; two false positives caught by inspection and restored, because a body lying flat is legitimately dense and a near-empty sheet trips any ratio), and the clocks are the real counts — swing 6, thrust 8, chant 7. Verified live: the served slash sheet is 384 wide and the filler physically cannot draw. **Named debt**: `kit-actions.ts` stages by byte-identity, so a re-run restores the fillers and the crop must re-run after it — the clocks protect every pose but the down one. **And the blade's own d20** (owner, same night: *"procced attacks are also supposed to be able to crit"*): proc blows rolled no die at all — `natural: 0`, always-hit, crit-never. The source's extra hits re-enter `hit()` whole, so each blow now rolls `resolveAttack` — it can miss, it can crit, and the crit doubles the whole roll. Dropped and named: dodge/parry against a possessed blade waits with the defensive-proc row, and the fumble is skipped — a blade that takes over does not drop itself. Driven: a four-blow volley on real d20s. **Postscript — the crop itself shipped broken and was redone within the hour.** The first crop used System.Drawing, which loads the sheets at their authored 72 dpi, builds canvases at the screen's 96, and `DrawImage` silently **rescales between them**: all 24 sheets went out as scaled garbage and every fight pose on the live client became a jumble of fragments. The verification had measured widths and never looked at a pixel — this project's oldest lesson, paid a third time in one night. The redo (`dd1817e`) owes nothing to any image pipeline: ~100 lines of the PNG spec against node's zlib (inflate, unfilter, row-slice, refilter, deflate, CRC), and the tool **refuses to write any file whose decoded output is not byte-identical to the kept region of its source** — 24 of 24 passed, and the probe was photographed mid-swing before the merge. The script lives in the session scratchpad (`crop-png.mjs`); promote it into the repo if sheets ever need surgery again |
| Worn gear rides the swing | **Owner, 2026-08-08: "my character seems to move out of his armour when he swings" — the last artifact of the swing-frames night, and the fix is measured, not drawn.** A worn piece with no swing sheet held its standing frame while the body leaned into the blow. `POSE_SHIFTS` (scene.ts) is the body's own pose sheets measured: the **head-point** drift of every frame against the standing pose — head rather than centroid, because the swinging arm drags a centroid around and the head tracks the skeleton. Twin-less layers ride the offsets in `poseLayers`: helm with the head, plate with the lean, and — the quiet half — a **downed body's gear now crumples the 13 px down with it** instead of floating at standing height, which had been true of every bashed body since protocol 22. Layers with sheets of their own sit at rest and animate themselves; the walk path resets every position so a finished swing leaves nothing askew. **Translation only, deliberately**: arms rotate in ways a slide cannot follow, so a shield mid-swing still holds its angle — the honest fix for that is drawn gear-swing sheets, named on the visible-weapons row. Photographed at zoom 3 with the owner's exact loadout: the closed helm square on the head clear through the pose frame |
| A critical doubles the blow, not the dice | **Owner's report, 2026-08-07**: *"crits are only a few more damage than normal attacks — check the duris code for the multiplier."* He was right on both counts. Ours was the SRD's shape (dice rolled twice, flat bonus untouched), and in our fold the bonus dominates a high-level swing — a 2d6+2 blade folded to 144 gained a seven-ish on a crit. The source is one line: `fight.c:7497`, ordinary critical, `dam = (int)(dam * 2.0)` — **the accumulated damage as a whole**, with only small level-riders added after; in Duris' economy dice-doubling and whole-doubling were nearly the same number, and in ours only the whole-double means what the word says. `rollDamage` now doubles the roll. Dropped and named: `SKILL_DEVASTATING_CRITICAL`'s ×(300+skill)/150 and the monk's ×1.5 land with their skills. Also from the same evening: **rings go on any finger** (`resolveWearSlot` — first free slot of a pair, displacement only when both are full, same table for ears, wrists and neckwear) and the **worn grid folds** (the inventory's own drawer pattern; the combat feed no longer scrolls away mid-fight) |
| The blade swings with the arm that holds it | **Visible weapons — the owner's ask twice in one evening, and the half the animations row always said would land together with it.** Weapons already walked (A7b staged 41 weapon walk sheets); a swing froze them, because artgen staged nothing but walks and the client sliced everything at 64. Three parallel readers measured first: the pack ships attack art in **three cell sizes** (64, and the 128/192 *oversize* grids where the 64px body sits centred and the blade overdraws the surround), nested **four different ways** on disk. What landed: **(1) artgen stages the swing twins** — `resolveAction` probes each layer's own base for `attack_slash`/`slash`/`attack_thrust`/`thrust` through a four-candidate ladder (plain, fg/bg-split, the arming sword's grandparent shape, and the behind-copy that nests *inside* the attack dir where the walk-behind nests outside it), validates every hit **by measurement** (4 facing rows of square 64/128/192 cells — `actionGeometry`, `isWalkSheet`'s doctrine), and names them `<sheet>-slash`/`-thrust` — the exact key `poseLayers` already composes, so the swap logic needed no new rule: **334 staged** (300 at 64, 2 at 128, 32 at 192 — weapons *and* every garment the pack drew swing frames for). **(2) `LPC_SHEET_GEOMETRY`**, generated: frame size per action sheet, read by the loader (a 192 sheet sliced at 64 is eighteen columns of broken tiles with no error anywhere) and by `ensureSheet` as the existence table, so twins queue beside their walks and the first swing of a session has its texture. **(3) The client strides by the texture's own frame width** (`texture.get(0).width`) in `layerFrame` and the down-pose branch — the oversize grid centres the body, so a centred origin needed **no positional change at all**. Driven on the rig browser and photographed: Windsong raised mid-arc over Gwynne45's shoulder at zoom 3, both saber layers sampled live on the 192-cell slash sheets (frame width 192, six columns) and back on their walks after expiry. **Named and kept**: recoloured weapons hold their walk frame mid-swing (ramp twins are their own canvas problem); the frame-count mismatch between the kit body's 7-frame slash and ULPC's 6-frame weapons is absorbed by `layerFrame`'s clamp (the blade holds its final pose for the last 90 ms); the 47 oversize-only weapons with no walk cycle stay unstaged, exactly as A7's measurement said |
| Four gaps between `wear` and the pixels, found chasing one shield | **Owner's reports, same evening (2026-08-07): green and red boxes over bodies in fights, and *"it is also not loading the sprite for the shield I am wearing even though an image is assigned to it."* One investigation, four real defects, each hiding the next.** **(1) `sheetsFor` was ramp-blind**: it looked the art id up raw, so `shield-…#all_lpcr.black` missed the index, missed the kit table, and returned nothing — every *recoloured* item on every body was silently dropped while its plain siblings drew fine. It now parses the id first and gates on `layerKeysFor`'s ramp-carrying keys, the same names A7e's loader queues and the canvas build registers. **(2) The base body stack was unguarded**: `characterLayers` handed Phaser the body's own sheet keys without an exists check, and in a session whose loader was interrupted mid-preload — a hot reload landing mid-fight, which tonight's merges provided — that painted the missing-texture placeholder at body size: the boxes in the owner's screenshots. The base stack now passes the same skip-and-queue gate worn art always had. **(3) `syncEntityState` skipped the wearer**: a character is never in their own `watching` set — `syncTurn` documents exactly this gap and self-sends, but the kit path never got the fix, so a `wear` reached every onlooker except the person wearing the thing, and the panel doll updating (it rides `self`) made the body's silence read as an art bug. Self-send added, `syncTurn`'s own shape. **(4) `upsertEntity`'s update branch never redressed**: it stored the new `wearing` and rebuilt nothing, so even with (3) fixed the body kept its old clothes until a membership event rebuilt the room. A shallow outfit comparison now triggers `redressEntity` on change. Also: `redressWearers` now matches a worn art by any of its **layer keys** (a two-layer shield's behind-the-body copy completing must redress its wearer) and by the **base stack** (for (2)'s queued bodies). **Verified end-to-end on the rig browser**: a fresh character wore Cision's black apron and the iron key that carries shield art — `wearing` updated on the self view immediately, and the layer stack held all three recoloured canvases (`shield…#all_lpcr.black`, its `-l2`, `legs-skirt-overskirt#cloth_ulpc.black`) within the wear. Named and kept: mobs still send no `wearing` (their gear on bodies is its own phase, and the naked spawned Cision that killed three probes tonight renders exactly as designed) |
| Two hit-point economies, and the shaman was billing the wrong one | **Owner's ask 2026-08-07: "look at the shaman tuning" — after the kobold shaman killed a level-30 rig character.** Twice, in fact: the autopsy drive recorded **magic missile for 109 and burning hands for 120** against a 360-hp character, timestamped kill in under fifty seconds. The research (three parallel readers: our engine, the Duris source, the numbers) cleared the usual suspects — the nuke formulas are **transcribed verbatim** (`dice(1,4)*4 + number(1,level)` per missile IS `magic.c:495-512`; the `×4`s are the source's own), the mob casts at its own level exactly as `sparser.c:2852` does, and the wind-up is `mobact.c`'s own quick chant. **The divergence is the pools**: Duris wrote those dice against Duris-scale hit points, and our harvested mobs still stand on them (the shaman's `23d44+207` averages 725) — but our players walk on SRD-scale pools a quarter the size (~87 at a real level 30). A volley the source costed as a third of a pool was **all** of ours. Fix: `PLAYER_POOL_DIVISOR = 4` (`shared/spells.ts`) — formulas stay verbatim per transcription doctrine, and the **delivery layer** translates once, keyed on whose pool is struck: mobs take the number as written (player nukes vs 725-hp mobs were tuned on exactly that), players take a quarter, floored, never under 1 a blow, composed **after** the save doubling. All four delivery sites: `completeSpellStrike`, earthquake's felled/grazed, ice storm's per-victim blows. Melee needs no counterpart — mob swing dice are harvested small and were already proportionate. **Re-driven**: missiles land 17–29 where they landed 109; the same fight is now a fight (275/360 after a full minute, the shaman comically wasting rounds on 6-hp self-heals, which is the source's own comedy). **Named divergences kept**: `MOB_CAST_CHANCE` 50% where the source's single-class casters try every round *and* melee in the same round (`fight.c:9762`, `mobact.c:5937`) — ours is deliberately gentler, revisit on playtest; and mob rounds run our 3 s where the source's run ~4.5 s (18 pulses), which is already the two-clock rule's data |
| The swing that was staged and never loaded | **Owner's report, 2026-08-07, on the animations slice**: *"the legs move but I am not seeing any weapon slashing or arms moving for casting."* He was right and the drive had been wrong to call it done: protocol 22's client shipped 56 action sheets into `public/lpc/` and **grew no load list** — `LPC_SHEETS` still held walk + idle only, nothing ever queued a `-slash`/`-thrust`/`-spellcast`/`-hurt` twin, and `poseLayers`' `textures.exists` guard fell back to holding the walk frame on every pose, silently, by design — the graceful-degradation contract hid the omission, which is exactly why a **visual claim needs a visual check**, and that drive only read `attackResolved.swing` off the wire. One-constant fix: the four action twins join the preload for all 14 idle-listed sheets (56 = 14 × 4, byte-counted; `offhand-shield` has no twins in the pack and keeps its held frame). **Verified on the screen this time**, in-app browser against the rig: mid-fight layer sampling caught Brynn21's stack swapping to `-slash` and the kobold shaman cycling `-slash` *and* `-spellcast` — the chant loop, live. What still does not move is the **weapon in the hand** — sword-in-fist frames are the visible-weapons row's 192px oversize sheets and land with it, exactly as the roadmap's animations row always said | 
| Reading is looking at, and the world had fifteen thousand things to say | **`read` — one line in the source** (`do_read`, `actinf.c:3206`, builds `"at <arg>"` and calls `do_look`): reading IS looking at an extra description, so the slice was never a new mechanism — it was carrying the prose the parsers had always stepped over. **The measurement said yes**: 14,936 real `E` blocks on objects (2.8 MB onto `items.json`, a server-only file — **10,591 catalogue templates now carry prose**) and 3,960 on rooms (1 MB in the `.wld`s; **639 attach today** across the 49 matched zones, riding the same name join the spawns use and gated on the same `--descriptions` switch as the zMUD prose, because one flag should govern all third-party text). The `.wld` walker steps over `D` records string by string precisely so a door description containing a bare `E` line cannot become a phantom sign. **Search order transcribed from `new_look` case 7** (`actinf.c:2632-2712`): the room's own sign answers before worn equipment, worn before the bag, the bag before the ground. Matching is `find_ex_description` over the live `isname` (`handler.c:908`) — **exact word, case-insensitive**: `read ju` does not find the jug, and the `_id_name_` markers the source refuses by name are dropped at harvest instead of at every lookup. **Two refusals carrying different information**, both the source's: *"You see nothing special about it."* when something answered to the word and is mute, *"You do not see that here."* when nothing owns it. `CMD_N` at resting + prone — readable flat on your back, refused under a sword, where `look` beside it stays combat-legal: a glance is free, reading is attention. `rea` is the shortest form (rest owns `r`/`re`, the crowded neighbourhood now pinned in the muscle-memory test). Driven in IceCrag: the caustic jugs read off the wall, the strange monocle's crystal read *worn*, the ebonwood key read from the bag and again off the ground after dropping it, both refusals, and the prefix. Builders who double-spaced their prose stay double-spaced — the blank lines are theirs. Boards (`boards.c`) remain their own machine, parked |
| A meal is a fast-heal, and the drive caught a two-for-one bug | **`eat` — the owner's fast-heal memory, and it was in the source all along** (`do_eat`, `actobj.c:3318-3357`): food grants **regeneration** — `value[1] × 15` hp a minute (15 flat unset), `value[2]` movement defaulting to the hp figure — for `1 + value[0]` ticks, as `eaten` nodes on the same `hpRegen`/`moveRegen` locations second wind rides, so the vitals fold needed nothing. **541 meals harvested, 70 boosted, 36 poisoned** (`value[3]` drains — *"You feel sick"* — at `−poison − base`); the white dragon egg soup's ×30 lands near 85/min because `regenBonus`'s soft cap is the source's own anti-stacking clause, and fighting still zeroes everything. One meal at a time (*"You feel sated already"* — the `well fed` affect is shown where the source hides it, because a fast-heal nobody can see is one nobody shops for), eaten lying down, refused mid-fight (`CMD_N` — no dinner under a sword, where the potion's one motion is worth a spill roll). **Takes all three letters**: `ea` is east — the drive that assumed otherwise walked the taster two rooms up the trail. Stat-foods (`value[4..6]`) wait on ability scores, named. **And the drive earned its keep twice**: the fed window first measured *no faster than base* because two `addAffect` calls with one type evict each other under the replace policy — second wind always knew (its three nodes arrive as one array) — and the same latent bug had **bless's `saves` node silently deleting its `hit` node since slice 5**. Both callers batched; +4 unfed vs +8 well-fed over the same window, measured |
| A potion is a scroll you drink, and drinking under a sword is a bet | **`quaff` — owner's ask 2026-08-07, built the same night, and the harvest was already waiting.** A potion's `.obj` record carries the scroll's exact layout (`value[0]` level, `value[1..3]` spell numbers — `do_quaff` reads them as `do_recite` does, `actoth.c:4145`), so the reader is the scroll's reader and **662 potions harvested their draughts, 150 castable today** — a cure-light vial sits in kobold country at vnum 1348, a bless-and-armor one at 33506. What makes a potion not a scroll is three drinking rules, all the source's: **everything casts on the drinker** (a bottled burning hands burns *you*; areas are skipped — *"unless the quaffer explodes"*), **one draught per timer** (`TAG_POTION_TIMER`, three ticks — thirty seconds at the torch calibration, the `potion-sated` affect shown with a countdown so the refusal explains itself), and **quaffing is legal mid-fight where reciting is refused** (`CMD_Y` vs `CMD_N` — one motion versus a paragraph) at a **flat 50% spill**: the bottle gone, nothing gained, the room told. The dex/agi/luck sweeteners on the odds are ability scores, dropped and named for Phase 21. `q` alone reaches it — nothing else in the table starts with one. Driven: 40 hp → 54 off two draughts, the timer refusing and announcing its end, bless + armor landing from one vial, and a live *"Whoops! You spilled it!"* on the second mid-fight bet. `settleStrike` gained the self-guard a drinker needs: a bottled nuke damages the body but must never point the fight loop at it |
| A weapon says how it swings, and gear says where it sits | **Three owner reports in one evening (2026-08-07), one root each.** *"It said I punched"* — an authored weapon had no way to carry a **weapon class**, and the class is the verb, the trained skill and the swing animation in one number; now it is authorable on every weapon (a labelled dropdown on the panel — `WEAPON_CLASS_CHOICES`, each rung with its verb), required knowledge the item editor makes hard to skip, and **instances minted before their template knew heal themselves** (instance-then-template fallback in `attackTypeOf` and the skill fold — Brynn93's own looted Windsong slashes without touching his save). No scimitar in Duris' twenty, so a scimitar is the longsword family, which is now Windsong's row. *"Procs only did 6–12 while I punch for 144"* — proc blows rolled the bare weapon dice; they now roll `combat.damage`, the same folded profile every ordinary swing uses, so the blade taking over swings with the arm that holds it (driven: ordinary and proc blows read the same band). *"The shroud should be worn on the back"* — **`slot` crossed the behaviour line on the owner's ruling**: authorable on every item (`item-overrides.ts`'s header records the reversal), a *worn* dropdown on every editor row, and the **next wear follows the template** (template-then-instance at wear time, deliberately the reverse precedence of the class heal — a slot edit is a statement about where the thing belongs). Plus `get all corpse`, which IS `loot` and routes through it. Parked from the same conversation: `quaff` (potions carry the scroll shape in their values — nearly free), `read` (needs the extra-description harvest), `eat` (buff foods; hunger itself stays unscheduled) |
| A blade that acts on its own, and the fifty-kill hunt for it | **Weapon procs and rare drops, owner's asks 2026-08-07 — and the research found the mechanism was half data all along.** `weapon_proc` (`fight.c:7764`) dispatches two ways, and both are ours now. **The data path is harvested**: a weapon's `.obj` record carries the whole proc in `value[5..7]` — 1-in-N odds per landed hit, packed spell numbers (decimal thousands, transcribed digit for digit; a tenth digit means *cast one at random*), the casting level — and **151 of the catalogue's weapons now carry theirs**, riding Phase 20's own `deliverSpell` (the forge hammer of Urtengor's proc is *earthquake*; aggressive magic strikes the victim, the rest tends the wielder, spell numbers raw and inert until the registry knows them — the scroll rule, third use). Even the khopis test fixture turned out to be a proc weapon nobody had noticed. **The special path is the registry** (`shared/src/procs.ts`) for what was C bound to vnums in the source — and its first entry is **Windsong** (`#9000000`, the first authored item number), rebuilt from the owner's Sojourn memory since that source was never released: an elven scimitar, 1-in-8 on a landed hit, **2–4 extra slashes** through `landBlow` with the remembered prose, every extra blow animating via protocol 22, and **proc-on-proc allowed** (`fireWeaponProc` re-enters off its own volley exactly as the source's extra hits re-reached `weapon_proc`; `PROC_DEPTH_CAP` is the belt the source never wore). The proc walk runs **after** every announce and notch walk with all gates re-checked — the source's own rule kept: a killing blow does not proc. **The hunt**: authored loot rows gain `percent` (1–99, rolled at spawn on the seeded stream — the Diku way, so the piece is on the body or honestly never was), a `%` box on the panel's loot editor, and **an elven master ranger (`#9000005`) walks the Kobold Settlement's muddy trail carrying Windsong one spawn in fifty**. Driven: she sang twice in a fifty-second fight (blows 6–11 inside her 2d6+2), a fresh 99% spawn's corpse yielded her by name, and 2% spawns came up bare. Named as out: defensive procs (GOTHIT/riposte need a pre-damage seam in `combat.ts`), procs on ability blows, and the one-shot `value[4]` poison |
| Travel stops hurting, and the operator can make it free | **The owner's fatigue report and event ask, 2026-08-07, answered by the source rather than by a knob.** The report — *"I get worn out quickly"* — sent the investigation to `vitality_limit` (`limits.c:115-149`), which settled it: **Duris' movement pool never grows with level** (it is racial base + an age curve + the endurance epic; `advance_level` gains hp and mana only), so the earlier level-curve idea was an invention and is withdrawn. What was actually wrong: our pool was the level-1 placeholder **100**, emptied in a minute of continuous walking at Duris' own per-room rates. Now `MAX_MOVE_POOL = 200`, static because the source's is, standing in for racial base + adult age until Phase 21's races. And the **event switch**: `movementCosts` joins `pvp` in the world rules — one flag for the whole economy of exhaustion (terrain, load multiplier, swim surcharge, **and drowning**, because a world where walking is free but the water still kills is a rule nobody can hold in their head; yes, an event night's oceans are crossable for nothing — that is what an event is). Injected into the sim like the swim aid, thrown live from the panel's own card, announced to the world both ways, defaulting on with the mirrored polarity rule (only an explicit `false` frees anything). Plus two interface asks the same evening: **`skills` now reads `dodge 12/50`** (learned over ceiling, the owner's own format) and **`spells`** lists what magic the world knows by circle, says honestly that nobody knows any until classes, and prints your scrolls with their stored cast levels — `sp` reaches it, nothing above starts with those letters |
| The body moves for what it does | **The animations half of the 2026-08-04 marker row, owner re-asked 2026-08-07** (*"attacks/spellcasts/bashed/sitting and whatever else requires a visual queue animated"*) — **protocol 22**, two additive fields and no new message. **Swings**: `attackResolved` — which announceAttack has sent since Phase 11 with a comment promising exactly this reader — gains `swing`, derived from the attack-type table beside the verbs (`SWING_ANIMATION`: pierce, sting and bite lunge, everything else swings; misses animate too — you swing and miss), and bash/kick now send the structured form from their own site (hits *and* misses, driven). **Casting**: `EntityView` gains a `casting` flag — a held loop, opened at wind-up and closed at either ending, which also closed the stale-comment gap where `mobStartCast` never synced the view at all. **Sitting/bashed/sleeping**: needed *nothing on the wire* — posture has ridden the view since protocol 8 promising "a sleeping stranger looks asleep", and this is the version where the client finally reads it: any non-standing posture draws the **down pose**, the hurt sheet's final frame, flat on the ground for every facing (a body on the ground has no facing worth drawing). **Art**: `kit-actions.ts` staged 56 sheets — slash/thrust/spellcast/hurt for the 14 idle-twinned starter layers — from `assets/lpc-opengameart`, found by **byte identity** (the ULPC pack was measured 79%-different on the body and is *not* where 15a staged from; its sit sheet cannot be mixed in, hence the down pose). Frame counts measured, none padded (the walk sheet's ninth-column trauma). The renderer gains one pose seam (`poseLayers`): suffix-swap guarded per layer on `textures.exists` — indexed/recoloured gear holds its walk frame during a pose exactly as it always has when standing — with one-shots expiring in the update loop and pose re-derived, never transitioned. Weapon-in-hand swing sheets stay out (192px oversize frames, the known multi-layer ArtEntry row); a second `attackResolved` mid-swing restarts the motion, named |
| The room is the target — and Phase 20 closed | **Slice 6 — areas, 2026-08-07, the phase's last mechanism.** Two shapes under one seam, both the source's. **Earthquake** (`magic.c:3318`) is its own loop and always was: the ground refuses water and air (*"No earth to quake here"* — driven in the flooded Stair), mountains and indoor ceilings scale the debris (`damFlag` 2 and 3), **bystanders are knocked about and never harmed** (the agility save — ours stands in through the save machinery at the source's +4 until ability scores exist — or down they go with a round of lag), and true targets take `dice(1,30)+level` felled or the sector-scaled graze upright. Driven with **the scroll of Earthmother** (level 56, earthquake stored three times) in a den of eight kobolds: felled damage read 64–86 inside the 57–86 band, corpses, coin and split experience all down the one `landBlow` seam. **Ice storm** is the `cast_as_damage_area` family (`utility.c:5916`): `should_area_hit` transcribed in its own order — *fighting each other outranks every exemption*, *mob casters cannot catch mobs* (`utility.c:5791`), your group is exempt, and the default is **yes**, because an area is indiscriminate — then **players thinned** by the live algorithm under its corrected name (`pc/2 + 5/pc ± 0.75`, floored at `min_chance%` — 90 for ice storm, so it barely thins; NPCs never thinned, a room of thirty mobs takes thirty full hits), `dice(min(level,36), 8)` per survivor. Driven from the mob side: the shaman authored ice storm crushed the player for 93 and 103 while **Gwark the clan leader, spawned beside it as the control, stood untouched through three storms**. An area's named victim is incidental (`TAR_OFFAREA`): dying mid-wind-up does not stop the room from shaking |
| A heal aims by a number, and a buff is a fact on your sheet | **Phase 20 slice 5 — heals and buffs, 2026-08-07.** The registry grows a `kind` and four spells, every number the handler's own: **cure light** `number(2,10)` and **cure serious** `dice(3,8)` (level-blind — a first-circle heal is a bandage, not a percentage); **armor** `-(level + 0..10)` Duris AC for 20 ticks, compressed through `armourBonusFrom` so a spell and a breastplate speak one armour language; **bless** `+(level/20+1)` hitroll and `-(level/30+1)` on the spell save for `max(5, level/2)` ticks — two affect nodes of one cause, the shape `affects.ts` was built for. Ticks convert at the **torch calibration** (a Duris hour is ten of our seconds). Re-casting refreshes duration and never re-rolls — the source's own else-branch, *"the bands of magic armor glow as new"*. The affect registry's `ac`/`hit`/`saves` locations land **with their readers**: `refitCombat` folds the first two beside gear, the save roll sums the third (and bless's −1 is worth five points, because the ×5 applies to it too). `joinBySupporting` and `THREAT_PER_HEAL` get their second producer — healing a combatant joins their fight at `THREAT_PER_HEAL × restored`. **Protocol 21**: `GroupMemberView` carries exact `hp`/`maxHp` — the aimable-heal change the design note promised, group-members-only by design, pushed the moment a heal lands (the tick's own push rides regeneration, found by the drive). Mob casters heal **themselves** when hurt and skip buffs by name (no mob profile fold yet); the drive watched the shaman, knowing only cure light, glow mid-fight three times. Scrolls carry all of it — *a holy scroll* (49193) recites both cures, *a holy book of prayers* (29261) blesses and armours |
| A scroll casts for anyone | **Phase 20 slice 4 — `recite`, 2026-08-07, and the first way a *player* casts a registry spell.** `do_recite` (`actoth.c:4166`), transcribed: **no class, mana or memorization check of any kind** — the classless path is why scrolls carry this phase while the memorization economy waits for Phase 21's classes. The catalogue's **135 scrolls** now carry their recitations (`ItemTemplate.scroll`: `value[0]` as the cast level, `value[1..3]` as Duris' own spell numbers, kept raw exactly as `type` is — shocking grasp is **37** here, not the 48 folk memory expects, read off `spells.h`). Up to three stored spells cast **at the scroll's level**, duplicates legal and meaningful — the shipped *scroll of ice* stores chill touch twice and casts it twice, **each slot saving separately** (the drive read 94-doubled then 49-saved off one recital). The scroll burns the moment the recital starts, spells or no spells — a scroll aimed at nobody is a scroll wasted, §0.4's pay-then-fizzle quirk in its third appearance. No wind-up (the source's recite is instant — a scroll trades the interruption window for the consumed item), one round of lag, and **refused mid-fight** (`CMD_N`, the source's own registration): an opener and a utility, not combat spam. A slot naming a spell the registry does not model yet is skipped and said once — recorded raw, it starts working the day its spell lands |
| One bash silenced a caster for ever | **Drive-found during Phase 20 slice 3, fixed with the source's own rule.** Bash sits its victim down and *nothing in this codebase ever stood a mob back up* — harmless for two phases because a sitting mob swings fine; the cast beat is the **first mechanic to read a mob's posture**, and it found every once-bashed shaman fizzling every cast from the floor, permanently. `mobact.c:7091` (`mundane_autostand`): a fighting mob below standing stands the moment it acts and **carries on with its round** (`goto normal` — the bash's lag was the whole cost, so the knockdown is not paid twice). Transcribed into `advanceCombat`'s round boundary, reported on `CombatTick.stood`, told to the room in the source's own sentence (*"$n clambers to $s feet."*, `actmove.c:3586`), and pinned with a regression pair — a **player** is deliberately not stood: standing back up is their decision, and their command |
| A shaman reaches for a spell instead of its swing | **Phase 20 slice 3 — the registry, the gates, and mob casters, 2026-08-07.** `shared/src/spells.ts`: the four first nukes transcribed with their dice and their save conventions — including chill touch's precedence quirk (`magic.c:529` writes `dice(1,6) + 5 * 4 + level`, so it is `1d6+20+level` and not its siblings' `×4` shape) and the **×5 every save modifier silently gets** (`sparser.c:1142` — transcribe it or ship saves five times too weak). The two gates, in the damage order: **one save per cast** (`double-on-fail` doubles the written amount on a failure), then **a shrug per blow** — magic missile's 1–5 bolts each face it alone (`magic.c:495-512`), and a raceless victim — every player until Phase 21 — never shrugs, which is the source's own shape (MR is an innate, and innates ride races). Mob casting is `MobCastSpell`'s (`mobact.c:542-784`): 50% on the round boundary instead of the swing, the **level-rolled quick chant** (a young shaman telegraphs a full wind-up, an old one halves it), injected into `advanceCombat` as `tryCast` because what a shaman knows is **content** — `MobTemplate.spells`, live-authorable (`PATCH /mobs/:vnum/template`, whole names or ids, capped at 8), and **the kobold shaman ships knowing magic missile and burning hands** (`overrides/mobs.json`, the eighth thing the overlay directory carries). Driven end to end on a rig: the telegraph, burning hands 84–116 inside its band, missile volleys 93–143, the chill-touch save split read off the log (45–49 saved / 88–94 doubled), a bash mid-wind-up breaking the cast, and a mid-fight live re-author switching what it casts |
| Casting you can watch, and break | **Phase 20 slice 2 — the wind-up, 2026-08-07.** `Actor.casting` plus a shown `casting` affect, so the caster's progress bar rides `SelfView.affects` with zero client work; the source's star meter prints each beat. Casting owns the caster: **one check in `permits()`** locks every typed command and clicked verb, the three raw movement intents are gated where they land (steer silently — sixty refusals a second is not a sentence), and the swing is cancelled at cast start and given back at either ending, because a caster is a held piece. **The beat is the interruption system**, on the source's own once-per-second cadence and its own admission (*"this is simplistic part... called once / second"*): a changed room catches every forced exit with no hook in `relocate`, lost footing catches bash through the knockdown, a lost target catches death and flight. Interruption costs nothing — the price is paid at completion, so a broken cast loses time and never the spell. The drive also caught bash's knockdown double-telling its target — fixed with rescue's own TO_VICT/TO_NOTVICT split |
| The tick drains the scheduler and routes by kind | **Phase 20 slice 1 — the design note's mandatory first commit, 2026-08-07.** The codebase's only `scheduler.advance()` call lived inside `advanceCombat` and silently discarded every kind it did not know — a cast event scheduled that day would have popped there and vanished. The tick now drains once and routes by kind, **out loud for any kind nothing claims**; `advanceCombat` is handed the due list and keeps exactly its old behaviour, filtering for the one kind that is its business. No behaviour change, and that was the point — the restructure had to land before anything could be built on it |
| Deep water, priced — and Phase 19 closed | **Slice 5, `swim`, 2026-08-07 — and the phase's fifth dead mechanism closed the phase**: `SKILL_SWIM` is registered in the shipped source and read only by `swimming_char`, whose **entire body is a comment**; the live gate is a boat item (*"You need a boat to go there"*). The owner composed both: **anyone may swim** — a deep-water stroke costs the terrain rate plus the dead drain's own curve (`4 − skill/25`, +4 at the floor, +0 at 100) and notches `swim`; an **`ITEM_BOAT` carried at the top level or worn** (29 in the harvest — canoes, rafts, boots of water-walking) means you are not swimming: no surcharge, no notch, no drowning. **Drowning is exhaustion with consequences**: at zero movement in deep water, a beat every 2 s takes a sixteenth of your health until ground, a boat, or the ordinary death — and the rule that makes it real is the one the drive found missing: **move regen pauses while treading** (the commented source's own `StartRegen`-on-exit), or the pool ticks back and the water lets go for ever. Mercy does not apply; water is not swinging at anyone. **The drowned wash ashore at the shore they entered from** — the owner's ferry rule: nearest-shore alone would make drowning a free crossing with your bag, so the entry shore is tracked per player, with BFS through the water (in-Place, bounded 400) as the fallback and for mobs. The death line reads the corpse's room *after* the wash. The same slice **closed the step-cost gap**: WASD and click crossings now pay the same `SECTOR_MOVE_COST` bill the typed step has paid since Phase 16, refused at the boundary with an edge-triggered message. `underwater` keeps its wall by name (diving is breath, not swimming — for the day one of the harvest's 192 such rooms loads). **Driven over sockets**: the 9-point unskilled stroke against the 5-point boated one (the canoe's own **encumbrance** eating most of the saving is honest comedy — water-walking boots are the elegant key), the shoreline refusal, six drowning beats through death and the 800-experience bill, and **the corpse of Thorn lying at A Flooded Landing, the entry shore**, one room north of the water that killed him. The Sunken Stair floods and ships loaded. `swimSurcharge` in `shared/skills.ts`, `shoreFor` in `corpses.ts` |
| A8d — a zone from nothing | **The seventh overlay, and the thinnest: a name against a number.** `POST /zones` allocates from `AUTHORED_ZONE_BASE` (100,000 — the harvest runs 1–423) with a **stored** counter, writes the zone and its **origin room** in one motion, and answers with the sentence that matters: add the id to `world.config.json` and restart. The origin room is the one case A8's join-a-neighbour rule opens for — `composeAuthoredRooms` places an empty authored zone's first room bare, and every later room joins it under the ordinary rule. **The drive caught the second-validator bug the docs warn about**: the first version hand-built the origin record beside `draftAuthoredRoom` instead of through it, and the loader — running the real rules — dropped the exit-less room on the next boot; the zone booted `0 rooms` with nothing to say why. The rule now lives at both doors with the allowance stated once (`allowNoExits`, passed only for the origin case), and a regression test round-trips the record through the file where it died. The panel gains the create form and a *Created, not loaded* card. **Driven end to end**: *The Sunken Stair* created at 100000, config line added, boot said *"1 rooms on 1 level"* and a 24th place; teleported in, logged back into it, **`look east` peered through the same morning's peek slice** into a second room built live by ordinary A8 infill, walked east, and both rooms survived a cold restart. Ships as the pending card — the config line is the owner's to add. `server/src/zone-authoring.ts` |
| Seeing into the next room | **`look <direction>`** — Track V's parked row, built 2026-08-07. **The source finding**: an ordinary mortal's `look <dir>` in Duris shows the *exit line* and stops; the far room — description and occupants — is **farsee's** (`new_look(…, CMD_LOOKAFAR)` behind `AFF_FARSEE`). The owner's ask (*"1 sentry guard to the east"*) is the farsee behaviour, so plain look opens it deliberately, and `peek.ts` is the seam Phase 20 tightens if farsee should ever mean something. The farsee gauntlet is kept in the source's order and mostly its words: no exit → *"You see nothing special..."*; a closed door → the same sentence a step gets; the loaded world's edge → *"Swirling mists block your sight."* (real for us — 323 of 327 zones are not loaded); a one-way link → *"Something seems to be blocking your line of sight."*; a dark far room → *"It's much too dark there for you to see!"* — **the far room's light, never yours**, which is the rule that makes the feature interesting: you see into a lit room from the dark and not the reverse, and somebody's carried torch in there is what you see by. **The drive corrected the doc**: a *mutual* portal pair (41299 ⇄ 41297, six cells apart) passes graph reciprocity and you peer straight through it — the source's own `rev_dir` check knows nothing of coordinates, and the flee note already accepted that the graph is the truth. Counts are the tactical information: *"You can make out: a kobold youth [x3]"*. Directions get first refusal on the argument (Diku's `search_block` order), you turn to face what you peer at, and hidden-when-stealth is named in `peek.ts` as the predicate this must share with the entity feed the day it exists. Dropped by name: `ROOM_BLOCKS_SIGHT` (never harvested), mists/dayblind affects (none exist), ground-light glow (the room-scoped-light row's business). `server/src/peek.ts` |
| `inventory` carries, `equipment` wears | **Owner's report, 2026-08-07**: *"when I type inventory it is showing what I am wearing."* It was showing both — the worn kit printed under the carried list, and a dressed character with an empty bag reads that as the wrong answer. Diku's own split, verbs and all: `inventory`/`i` is the bag and the purse, **`equipment`/`eq`** is the worn list (with the AC readout that only your own sheet may show). The source's own table row makes equipment readable while *asleep* (`STAT_SLEEPING + POS_PRONE`, laxer than inventory's resting) — checking what you are wearing is interface, and the sleeper-command test enumerates it beside `skills` and `affects` |
| Somebody else's fight becomes yours | **Phase 19 slice 4 — `rescue`**, the first ability that makes grouping mean something mechanically, from `rescue()` (`actoff.c:7261`). **One attacker peeled per use** — the first found, the source's own rule; peeling everyone is `rescue all`, a level-46 Guardian spec that waits for Phase 21's classes. The peel is three pointer moves through `disengage`-then-`engage` (stop-then-set, so the attacker's next blow waits a fresh round): the rescuee's pointer clears **only** when it aimed at the peeled attacker, the attacker turns onto the rescuer, the rescuer engages if free. **`set_fighting` alone would not survive here, and that is the transcription decision**: our mobs re-pick from the threat table every round boundary, and the rescuee usually tops it — a bare pointer flip un-rescues itself in three seconds. So the redirect also **seats the rescuer at the rescuee's threat standing**; the grudge transfers with the fight, and winning the mob back costs 10% more threat, which is tanking working as §2.7 designed rather than a new rule. **`joinBySupporting` got its first caller** two phases after it was written: a rescue marks the rescuer on every foe's table and pays a support share of the kill. **The notch runs backwards from bash and kick's and is kept that way**: theirs is `!notch && miss` (learning forces the blow home), rescue's is `notch \|\| fail` with the `\|\|` short-circuiting past the success roll — the moment you learn is a moment you fumble. Refusals kept word for word down to *"What about fleeing instead?"*; one round of lag paid on the attempt, success or fumble, never on *"But nobody is fighting them?"*. Dropped and named: `ROOM_SINGLE_FILE` (not harvested), the blind check (our visibility gate *is* it — a rescuee you cannot see is one `resolveTarget` will not resolve). **Driven live 2026-08-07 over two sockets reading room views** (the corrected-probe rule): Bramble at level 5 opened on the kobold shaman; Thorn's first try landed — *Banzai!* — the shaman's **very next punch hit Thorn**, seen second-person on one socket and third-person on the other, and the redirect held across rounds. Self views flipped in the same beat (Thorn `target=129`, Bramble cleared — protocol 16's chevron on the wire). A level-1 Thorn then fumbled twice, *"Thorn fails miserably in their attempt to rescue you"*, with the shaman never turning — the failure path moves nothing. `server/src/combat.ts` `rescueFrom`; 861 server tests |
| **Every blow missed, and a rebuild lit up the attack verbs** | **Two things, found together while doing the cheapest step of the mob-art row.** ① **A critical regression from Phase 19 slice 2, shipped and now fixed.** `rollDefence` returns a *wrapper* carrying the notch, and `swing` tested that wrapper for truthiness — so with a defence lookup wired, `hit` was **false on every single swing**. The live symptom was a natural 20 reading `critical hit=false dmg=0`. **The unit tests could not see it** because every one of them leaves `defence` undefined, which is exactly the shape that skips the branch. Worse, slice 2's own drive *showed* it: the outcome tally read `{miss: 40, parried: 1, dodged: 2, critical: 1, fumble: 2}` — **no `hit` at all** — and it was read as *dodge and parry work* because those were the two words being looked for. That is this file's own lesson a second time: **when a drive shows what you went looking for, read the rest of it.** Fixed, and `combat.test.ts` now runs the loop **the way `index.ts` runs it**, with a defender who cannot dodge or parry, asserting the dull thing: blows still land. Verified by reintroducing the bug — the new tests fail, the other 63 pass. ② **`race` was already harvested; the spawn files were stale.** The mob-art row's cheap first step turned out to be `npm run worldgen`: `mobs.ts` has emitted `race: raceCode.toUpperCase()` since V7, and all 1,503 templates now carry one (`PH` 549, `H` 382, `G` 168, `PT` 104, and nine more). **Sprites are unchanged — every code still maps to `human`, because LPC has no non-human body** — so a kobold still looks like a man and the art remains the blocker, exactly as the roadmap says. What it *did* light up is V7's `attackTypeForRace`: 289 templates stop saying *hit*. Driven: Malice (race `G`) now **crushes** you for 57. |
| A colour for a whole zone's loot | **A7h**, and the prize the roadmap had been pointing at since A7e: *“a pass could propose art **and** ramp for a whole zone's loot from names nobody has to retype.”* A7g did art catalogue-wide; `npm run colourassign [-- --zone N] [--write]` does colour, **by zone**. `artassign`'s shape exactly — dry by default, a report that names what it skipped, and every change in the overlay the panel already edits. **Why a zone rather than the catalogue**: art wants a picture on every item, so a fallback plus review-later was right; **most items should have no colour at all**, since a ramp is only correct when the name says one — so a catalogue-wide run is mostly *no opinion* and the useful output is a short list. **The model is not called**, deliberately: a hundred items is a hundred round trips at 0.6 s warm / 67 s cold to answer what the name answers free. Bulk takes the cheap majority; the Suggest button takes the remainder one item at a time. **Result: 361 items across 49 zones.** The matcher moved `server/src/artcolour.ts` → `shared/` on the way, because worldgen needed it and a worldgen→server dependency is one this monorepo does not have; it is pure string logic, which is what `CLAUDE.md` says `shared` is for. **The dry run earned its keep three times, and all three are in the code as comments.** (1) *“a silver-threaded satchel”* came out **brown** — its keywords are `[satchel, silver, threaded, leather]` and one pooled bag of words let the ramp list's order decide, so the **display name now gets first refusal and keywords are the fallback**; *“a large tar dipped torch”* still reaches `oak` through its `wooden` keyword, which is the other half of the same rule. (2) The total said **409** where 361 items change — a catalogue entry can be loot in three zones, so proposals pool by vnum while the per-zone listing still shows each under every zone. (3) *“a heavy black nosering”* wears `head-nose-big`, the only `nose` art, whose material is **`body`** — skin tones — so *black* would have **blackened the nose rather than the ring**; the unattended pass now refuses `body`-material art, while the Suggest button keeps the control, which is §8's split everywhere else. **It also read as a review of A7g**: *“silver-plated leg plates”* correctly wears `legs-armour` (metal) while *“arm plates”* wears `torso-clothes-longsleeves` (cloth) — an art mismatch the colour pass made visible and the panel is where it gets fixed. **Driven end to end**: *“a mottled brown cloak”* resolves to `cape-solid#cloth_ulpc.brown` through the API and moves **5,450 pixels** on the real sheet, landing on `cloth_ulpc.brown[0]`. Re-running proposes **0** — it never overwrites a choice, so hand-fixes survive a re-run |
| A colour picked from the description | **A7f**, owner's ask 2026-08-05: *“it would be great if we can have ollama do the edits based on the description — if that is even possible.”* It is, and the roadmap was precise about what it is: a model **cannot draw pixels**, it maps a description onto one of a closed list of ramp names. A7e made that list real, so this is classification over a fixed vocabulary — the one thing a small local model is reliably good at. **The design decision is that the model is the *fallback*, not the first resort.** A builder's own name very often contains the answer (*“a hooded black cape”* → `black`), so the 215 ramp names are matched against the name and keywords first and Ollama is asked only when that finds nothing. Three things follow, each worth more than the cleverness it replaces: it **works with Ollama switched off**, which is most machines most of the time; it is **deterministic and unit-tested**, so the common case has a test rather than a vibe; and it is three orders of magnitude faster, which is what makes the roadmap's bulk pass a loop rather than a hundred round trips. **Note the inversion against A7g** — that put colour words in its *noise* list, because the pack's ids carry colours (`belt-belly-brown`) that say nothing about the item; here the colour word is the entire signal. Same corpus, opposite question. **§8's rule throughout**: it suggests into the dropdown and writes nothing, so keeping costs a Save and dropping costs nothing. The model's answer is **validated against the closed list** rather than trusted — a model answering *crimson* to a list containing *red* has failed, and inventing `cloth_ulpc.crimson` would only be refused three layers away by `isKnownArt` with nothing left to say why. **One ordering subtlety a test caught**: compound ramps (`blue_violet`, `red_orange`) must be tried **before** plain ones, or *“a blue violet robe”* takes plain `blue` and the specific reading never gets a turn — and running compounds first costs the plain case nothing, since a compound needs both halves present. **No model dropdown**, deliberately: the picker asks the server what is installed on first use and sends the first one. Which model writes your world's prose is a real choice; which model picks between *red* and *maroon* is not. **Driven live**: *a hooded black cape* → `cloth_ulpc.black` with *from the name: “black”* on screen, *a purple dress* → `purple`, a longsword refused by name because its sheet declares no palettes, and *a pair of jewelled sleeves* answering `ramp: null` with a reason rather than an error. **The model half was driven a few minutes later**, once the owner's `OLLAMA_MODELS` was repointed at the drive its 50 GB of models were actually on: *a pair of jewelled sleeves* → `cloth_ulpc.purple`, `how: "model"`. **Three measurements came out of it, and one changed the code.** Latency is **67 s cold and 0.64 s warm** for an 8B, against 13 s cold for a 1.5B — all inside the 120 s timeout, but the first call is a long wait. And `qwen2.5-coder:1.5b-base` answered with prose naming no ramp at all: a **base** model completes text and does not follow *“reply with exactly one word”*, which is what the instruct tune adds. The closed-list validation caught it and returned nothing — the right failure, and proof the validation earns its place — but it exposed a real weakness in what had just shipped, since the picker took `models[0]` and that could be a base model. It now **skips base models and takes the smallest of the rest**, which is the opposite of what a prose draft wants and right for the same reason: a one-word choice from a list already in the prompt gives a larger model nothing to be better at, and only the cold start differs |
| The same garment in another colour | **A7e**, owner's ask 2026-08-05: *“if I need a fiery red cloak I can select the black one and change the colors.”* **Not an image editor** — ULPC ships the palette system, so a colour variant is one source sheet plus a named ramp. **The architectural fork the roadmap said to settle first went the other way from its own guess.** It assumed a server-side recolour staging a new PNG; this is **render-time**, for four compounding reasons: it needs no PNG codec (`artgen` reads an IHDR and stops, while the browser has a decoder *and* an encoder and `bagicon.ts` already reads pixels back); it needs **no protocol change**, because `cape-solid#cloth_ulpc.red` fits the `art` field an item already carries; it creates **no ids to own**, so nothing needs an `ATTRIBUTION` line or the `previouslyGenerated` check; and it is what the pack itself does. **Three measurements corrected or added.** The roadmap said `metal` *“declares a base and ships no palette files at all”* — **wrong**: it ships two, with 8 and 7 ramps including its own `steel`. And **all 1,048 palette references in the pack resolve**, which retires the worry that an art could declare recolours resolving to nothing and *removed* work rather than adding it. The one genuinely new measurement: **a sheet definition may override its family's base** — `arms_hands_ring_stud` is `cloth` but declares `"base": "teal"` — so reading the family first recolours the wrong six colours. **What shipped**: `artgen` harvests `recolors` and bakes all **215 ramps across 12 tables** into the generated index (28 KB, cheaper than a route with its own boot ordering); `shared/recolour.ts` is the index-by-index swap at the guide's ±1 tolerance; the client builds the recoloured texture on a canvas and registers it under the recoloured key, so every layer, sort and redress path works unchanged; and the picker grows a colour dropdown **only for the 178 of 346 sheets that can take one**. **The drive caught the bug that mattered**: three separate writers validated art with `LPC_ART_BY_ID.has(value)`, which a recoloured id fails — so the picker offered 99 colours, the operator chose one, and the router refused it silently. One `isKnownArt` now gates all three and checks **both halves**, refusing a ramp the art does not offer rather than ignoring it. Also worth knowing: the picker used to fetch the art index on the chooser's *first open*, deliberately — but the colour control is the one thing reached for *without* re-picking art, so it now loads eagerly when an item already has art and still costs nothing when it does not. **Driven live**: 5,450 pixels moved on the real 576×256 `cape-solid` sheet, first opaque pixel landing exactly on `cloth_ulpc.red[0]`. **And gotcha 7 bit again** — Vite served the pre-edit module until `packages/admin/node_modules/.vite` was deleted and the server restarted with `--force`; a reload did not clear it |
| A picture for every item | **A7g**, owner's ask 2026-08-06: *“assign a best guess image to the items that don't have one — I can manually review them later.”* `npm run artassign` matched **13,248** of 16,421 — 5,171 on a word shared with the art id, 8,077 on a per-slot fallback. **The slot is the join and it is the whole reason this works**: `artgen` tags every entry with one, so the worst case is *the wrong hat*. Guesses land in `overrides/items.json` — the same file the editor writes — so the run is **one git diff**, a re-harvest flows through underneath anything untouched, and *Restore harvested* un-guesses per item; an already-authored `art` is never overwritten, so a re-run picks up only what is new. **Left alone, and reported rather than silent**: 2,652 carried-not-worn items (every art entry is equipment; a brass key with a bracer's icon is noise, not a guess — and A7d-bag deliberately leaves that cell empty), plus 514 in `eyes`, `face` and `ioun` where the pack has nothing. **The dry run earned its keep twice.** The first fallback rule was *shortest id*, which gave every unmatched sword a **farming hoe**, every cuirass a **bodice** and every amulet a **bow tie**; commonest-kind fixed two, and the third needed one more rule — the pack files its tools under the same `weapon` kind as its swords, so an id in the family the kind is *named after* wins. A second attempt at that rule (counting families) made four other slots worse — a jetpack, a skirt, a wand — and was reverted. `by: 'artassign'` marks every row, so the panel's authored line tells a reviewer a guess from a choice |
| Getting out of the way | **Phase 19 slice 2**, and the cadence's mechanic slot: `dodge` and `parry`, the first skills notched on the **defender**. The design note parked this with one sentence that turned out to be the whole design — *“our AC is passive, and dodge/parry are an active second gate”* — and `new_combat.c` confirms it: both rolls happen **inside** the branch the to-hit already won, so a blow that missed stays a miss and cannot be dodged. **Dodge first, parry only if the dodge failed**, and the notch attaches to whichever failed you, on the source's own coin flip: you learn from the blow that got through, not the one you avoided. **Parry needs a weapon** — `getCharParryVal` returns 0 without one, *you do not parry a sword with your arm* — and is half the parry skill, half the skill of the thing in your hand. A defended blow has `hit: false` and no damage, so nothing downstream learned a third state; the protocol's `dodged`/`parried`, **declared and unproduced since Phase 11**, now have a producer. **Four findings the design note did not have.** The crowd penalty's `else` **charges a lone attacker 14%** — the chain is `if`/`else if`/`else`, so being attacked at all is the default case. The critical bonus is added **after** the modifiers rather than before, which a test caught and which would otherwise have been a quietly smaller number nothing checked. `number(1, 101)` means even a perfect score fails one time in 101. And **`DODGE_CAP` is unreachable**: the arithmetic ceiling is 50, and the 60 exists for a drow/halfling doubling we have no races for — dead code today, live the day Phase 21 lands. **Dropped and named rather than approximated**: ability scores (no stats), size (*“very important”* in the source's own comment, and the largest known omission), haste/slow/blur (no such affects), terrain (the source's list is underwater types no loaded zone has — it belongs with slice 5), riposte. **Mobs dodge but never parry**, which is transcription: `else if (IS_WARRIOR(vict))`, and every mob takes the `else` until classes exist — the same untaken branch `attackBonusFor`'s `martial` has. **Driven live**: a level-40 character against the Kobold Settlement's mine crew, both outcomes observed in one fight, and the log reading *“You narrowly parry a kobold mine leader's attack”* and *“You narrowly miss being hit by a kobold mine leader's attack”* — the source's own phrasing for the narrowest dodge, which describes the blow nearly landing rather than a thing you did. The drive caught one real fault: the attacker's name arrives capitalised for sentence-start use and this is the one line where it sits mid-sentence, so *“A kobold mine leader's attack”* needed the plain form |
| A9c — where a creature lives | **Owner's ask, 2026-08-06**: *“the mob needs to be assigned a room in a zone and not just dropped by hand.”* A9b's Spawn button puts one body down once and loses it on the next restart; this says where a creature **belongs**. `placements.ts` is the sixth overlay, keyed by **mob vnum** — the question an operator asks is *where does this thing live* — with the **zone derived from the room**, so it is not a second field anybody can get wrong. **It could not go in `data/world/spawns/`**: that is a worldgen output, and a reset written there would be erased by the next harvest — the exact rule A4c's overlay exists to obey. **The whole trick is that a placement is an `M` command and nothing more.** `runReset` looks a command's vnum up in the same map A9b adds created mobs to, so a reset naming 9,000,000 needed **no** change to the executor; the case the roadmap flagged as unprecedented is unprecedented only in the *harvester*, which never runs against these. **Four decisions.** (1) **Appended, never interleaved**, with `ifPrevious: false` — a zone file's order is load-bearing because `G` and `E` attach to *the last mobile loaded*, so an authored `M` mid-table would hand somebody else's sword to a creature we added. (2) `percent: 100`, because `runReset` fires an `M` on a timed repop **only** at exactly that. (3) **`ZoneClock.spawns` became mutable** — a clock copies its table at boot, so writing only the overlay would take effect on the next restart and not before; rebuilt from the harvest on every write rather than appended, or the table grows by one per save. (4) **The limit is world-wide, not per room** (Duris' `arg2` is `mob_index[].number`), which is what makes a lured mob suppress its own replacement — surprising enough that the panel says it. **Driven live**: a bone hound placed in two rooms, arriving in both on repop, holding at two across a second repop, unplaced without vanishing what was standing, and — the point of the whole row — **standing in both rooms after a full server restart with nobody having spawned anything**. The panel's *Lives in…* drawer was driven too, which caught a real bug: the reopen intent named only a vnum, so saving a placement reopened the **field** editor with the placement's confirmation under it. It carries which drawer now |
| A9b — mobs you make yourself | **Owner's ask, 2026-08-06**, the other half of A9. `mob-authoring.ts` is the fifth overlay and A6b's shape for mobs: a **whole** `MobTemplate` rather than a patch, in its own file with the opposite lifecycle rule — an emptied override is deleted, while a created mob whose name is blanked is a bug rather than a request to delete the creature. Numbered from **`AUTHORED_MOB_BASE` = 9,000,000**, measured against a harvest that runs 1,400–200,319, with a **stored** counter that never reissues a freed number — *“highest plus one”* recycles whatever was deleted last, and a vnum is an identity. **Three decisions.** (1) **Aggression is offered here, which A9 refused**, and the objection is answered rather than dodged: A9's problem was a form that could set a disposition while leaving `clauses` empty — a creature marked hostile that never attacks, since `matchesAggro` reads the clauses. One boolean cannot reach that state, because `true` writes the disposition **and** the `all` clause together, the one clause fully evaluable before Phase 21. `hunts` drags the memory bit with it, §4.11's dependency that `huntRule` refuses to let a caller forget. (2) **`PATCH /mobs/:vnum/template` dispatches on the vnum range**, so the panel has one route and cannot pick the wrong store: above the base a re-draft of a whole record, below it a patch over the harvest — `authorItem`'s dispatch, for `authorItem`'s reason. (3) **A harvested mob cannot be deleted and the refusal says why** — the next worldgen would restore it, so a delete that appeared to work would be a lie with a restart's fuse on it; deleting a created one leaves what is standing standing, because those are ordinary actors in ordinary fights. **Driven live**: *a bone hound* created at 9000000, spawned, fixing its eyes on a player (the aggression flag is real), fought, killed for its authored 2,400 experience and leaving a corpse; re-drafted to level 30; the harvested 1410 refused deletion; and the panel driven in the browser — the row marked **✦ made here**, its editor offering **Delete** and the two rule boxes where a harvested one offers **Restore harvested** and neither. **What is left is A9c**: a created mob does everything a harvested one does *except repop*, because a zone's population is a worldgen output and placing one permanently needs the sixth overlay |
| A9 — editing what a mob is | **Owner's ask, 2026-08-06**: *“we need to be able to edit existing mobs and create new mobs.”* This is the first half; creating is **A9b**, which still needs an id space and a reset-table entry nothing has written yet. A4c's overlay grew from loot to **ten fields** — name, room line, keywords, level, hp, damage, armour class, experience, wimpy threshold, sprite — folded over a **pristine** copy stashed in `pristineMobs`, so *Restore harvested* restores the harvest rather than the last edit. `authorItem`'s shape throughout. **Four decisions worth knowing.** (1) **`combat` is re-derived rather than patched**: a template stores the *derived* profile and `attackBonus` is a function of the level, so a level edit that left `combat` alone would give a level-40 kobold a level-8's accuracy — driven live, where the edited mob rolled `d20 4 → 17`, its new +13. (2) **Aggression is not offered**, though the roadmap row lists it: it is a *rule* rather than a field and `matchesAggro` can evaluate one clause (`all`) until races and alignment land at Phase 21, so a dropdown would mark a mob hostile that never attacks — an editor that lies. (3) The routes are **`/mobs/:vnum/template`**, not `/mobs/:vnum`, because `DELETE /mobs/:id` already took that path for an **entity id** — A4c's own note says not to build one path whose id space depends on the verb, and a test pins both directions. (4) The panel **posts only what changed**, so the ✎ mark names one field rather than all ten, and an untouched room line stays unauthored — which is what lets a re-harvest keep flowing through it. `writeDice` went into `shared/rules.ts` as `parseDice`'s exact inverse, because the damage box round-trips through it and a printer that dropped the bonus would cost a mob eight damage a swing on a save nobody made a decision in. **Driven live**: kobold guard 1410 turned into a level-40 *Gwark, the kobold king* with 566 hp answering to `kill gwark`, spawned from the edit; every refusal (level 900, `“three d six”`, `aggro`) named; the harvest restored with its loot left standing; and the panel's own form driven in the browser through save, reopen and restore |
| One item off a body | **Owner's ask, 2026-08-06**: *“we need another command so we can just loot certain items from corpses — like `get axe corpse` — so it just gets the axe and leaves everything else, as a way to not overload your inventory.”* The other half of the corpse listing shipped an hour before it: see what is on a body, then take the one thing you came for. **No new verb** — Duris' `do_get` already takes `get <obj> <container>` where the container may be a corpse, so both `get axe corpse` and `get axe from corpse` route through the `from` split `get` had for containers. **Refusals are `searchCorpse`'s, called rather than restated**: `lootRefusal` for whose body it is, plus the reach test the pure function deliberately leaves to its caller — two loot verbs with two ideas of whose corpse it is would be a way to rob a protected body by typing the longer command. That pushed `corpseAnswersTo` down into `corpses.ts`, which **fixed `loot corpse`** in passing: the bare word was matched against the *dead thing's name*, and `of` never contains “corpse”, so it found nobody. **Coin comes off as coin even when named** — `get pile corpse` goes to the purse and costs no slot, or this would be the one path in the game that carries money against `DESIGN-inventory.md` §8. **`get <a> <b>` is only read as the two-word form when `<b>` names something to take from**, so `get long sword` on a floor holding one stays a pickup rather than becoming *“there is no long in your sword”*. **Driven live**: a temple guard's four pieces taken one at a time with the listing shrinking between each and the body flipping to *picked clean* on the last; a refusal for an item not on it; the reach refusal from across the same room while `look` stayed distance-free; and a sentinel private's pile of coins taking the purse 8→12 platinum with no bag slot spent. **Not driven**: the bag-full refusal, which is `getFromContainer`'s three lines over the same `carry` |
| A body says what is on it | **Owner's ask, 2026-08-06**: *"when looking at a corpse it should list what items the mob has that is lootable."* A refinement rather than a phase — the shape `loot`-targets-the-nearest took — because every piece existed: `Corpse.contents` since 15b, and 15c's `look <container>` listing to copy. **Three decisions, two of them already argued elsewhere.** It goes on **`look`** and never on the entity feed: V2's target menu deliberately says *is a container* and not *what is in it*, because *“sending contents to everyone in the room would hand out the answer to the verb”* — but a corpse is the opposite case, since a mob's worn kit **is** the reward (which is why `resolveDeath` puts a mob's gear in its corpse and a player's on their body). It works **at any distance**, unlike `lookInsideEntity` which gates on reach: a container's contents are *inside* it and a corpse's are *on* it, the same distinction that makes the verb `search` rather than `look inside` — and it puts the choice where the ask wanted it, since learning there is something worth having and *then* crossing the room is a decision where “walk over to find out” is a chore. And it lists the **visible subset** from the first version, stated now though nothing is hidden yet, so that the placed hidden-items row cannot later change what this one promised — with no field invented before it has a writer. An empty body **says so**, because silence would mean either *nothing on it* or *the feature did not fire*. **Driven live**: six corpses on one floor, four reading *“it has been picked clean”* and two listing a hooded black cape, a redwood torch and a long black dagger |
| Something to do in a fight besides swing | **Phase 19's third slice — `bash` and `kick`**, the first abilities in the game, and the interesting part is what had to exist first. **`landBlow` was extracted from `advanceCombat`'s swing loop** in its own commit, with no behaviour change and all 1,379 tests as the proof: damage application, the threat table, both halves of the contribution ledger, retaliation, the status refresh, the mercy rule and death all lived in there, and an ability that applied damage itself would have been a **second damage path** — a mob dying without paying experience, a bash that kills leaving no corpse, a felled target everyone keeps swinging at. `rescue` needs the same seam and every damaging spell in Phase 20 needs it after that. One thing genuinely moved rather than being copied: `swing` no longer applies the damage it rolled, because *what a landed blow does to the world* has the same answer however it was thrown. **Then the abilities were small**, because their consequences already existed: a knocked-down body stays down since `canMove` is the gate (the handoff predicted *“Phase 19's bash needs no code”*), and the recovery is a **timed affect** — which is what the source does (`set_short_affected_by(ch, SKILL_BASH, 2 * PULSE_VIOLENCE)`) and means a player *sees* the lag counting down instead of being told no. Bash is two rounds and takes the victim's round too; kick is one and a half. **The damage is converted, not copied**: Duris' is skill-derived on a 1–100 scale (95 at mastery, where a level-30 swing does 25), so it reuses `floor(learned / 10)` — the same conversion as the to-hit bonus — leaving bash at `1d4+skill/10` and kick at `1d6+skill/10`, which is the source's own shape: `do_bash` passes `MAX(1, dam)` because a bash is for the knockdown. The notch was factored so a blow and a verb share one path at different base chances (7 for a verb, the source's `skill.notch.offensive`), because two copies would be two places to forget the `refitCombat` that makes a point of skill mean anything. **Driven live**: a veteran with bash 95 written into a save file — which also proved the skill persistence round-trip in the running game, reading *95% (mastered)* — bashed the kobold shaman for **11** and *“you knock the kobold shaman to the ground!”*, was refused a second ability with *“you have not recovered your balance yet”* and `off balance` on the affect list for six seconds, then kicked for **12** once it lapsed. **The drive found a real gap**: the knockdown line reached the target and the room but not the basher, because `actToRoom` excludes the actor — so the one person who did it was the only one not told |
| You can make a thing glow | **A6c**, owner's ask 2026-08-06: *"some equipment will be light sources so that needs to be added to the item editor."* Two boxes in the item editor — radius and burn — on the overlay that until now authored exactly one field (`art`). **It landed after the light rules on purpose**: before them a light only lit you from a hand, so authoring a glowing helmet made an item the game could not use. Three decisions, each already settled elsewhere in the project and only transcribed into the form. The **radius is clamped to 4 and the form says why** (*tiles, max 4*): `light.ts` gives every light the same reach on purpose, because Diku light is a boolean and `ROOM_GAP` makes 3 the distance at which a room's exits become findable — so an author typing 11 would be overriding a tuned relationship from a text box. **Duration is typed in Duris' own hours**, ten seconds each, which is the unit the source's 64 lights are authored in and the unit `light.ts` pinned by making the two catalogues agree. And **blank means never burns out** — a state rather than a big number, which is what 32 of the 64 are; a zero would gutter on the first tick, which nobody wants to author. The **server clamps as well and its refusal names the half that was wrong**, because a form is a convenience and never the gate. **Driven end to end**: radius 4 / 600 s authored onto a long black dagger that nothing in the harvest lit, and a character carrying it **in the bag** in a dark mine went from radius 2 to radius 4 with 600 s left; clearing the authoring restored the harvest's no-light and a fresh dagger left a fresh character at radius 2, while the dagger already in a bag kept its light — which is `Item.light`'s own rule that an object carries what it was made with |
| A light costs nothing | **Owner's rule, 2026-08-06**: *"light should come with no space, weight or slot cost"* — so a light lights you from wherever it is (worn, wielded, or the bottom of your bag) and the bag charges no bulk for it. **This reverses `DESIGN-inventory.md` §6, which is rewritten rather than bypassed**: it now states what it used to say (a light slot would be *free light for ever*, so light lived in a hand and was a trade against a weapon or a shield), why that held — **every room was pitch black**, so light was the resource that let you play — and why it stopped: 95% of the world lights itself now, so light is not rationed to *see*, it is the key to the 5% that is dark. What is lost is named too: light's **second** progression axis, with duration flagged as where to put a cost back if it matters (every one of the harvested 64 has the same radius of 3, and `light.ts` already makes duration the thing separating a candle from a lantern). **The measurement that made the old rule untenable anyway**: hands-only left **11 of the 64 lights unable to work at all** — five glowing earrings, a set of golden horseshoes, five with no wear slot. **`Item.light` is what made it possible**: the radius and burn ride the item, so `stackSlots` (pure arithmetic in `shared`) and the light scan can both answer *"is this a light"* with no catalogue in hand — and an authored item works with no entry in one. Same argument `weaponClass` and `twoHanded` make. `LIGHT_BEARING_SLOTS` is **deleted**, not left describing a rule nothing follows. **The bag write became the seam, and that is the interesting part**: a light in the bag turned all twelve `player.inventory = …` assignments into light changes and only four re-derived — so rather than adding eight calls (*"a rule installed at any one of those would be missing from the other five"*, which `afterKitChange` warns about in as many words), there is now **one writer**, `sim.setInventory`, and assigning around it is the bug. **Driven live** in a dark mine: nothing carried → radius 2, **a torch in the bag, never wielded → radius 3**, a glowing earring worn in an ear → radius 3, bag reading **0 of 20 slots** throughout |
| Most of the world lights itself | **Owner's ask 2026-08-06, and the data had been on disk the whole time.** `'dark'` is a room flag in `world.ts`'s catalogue and until now **its only occurrence in the entire codebase was that declaration** — nothing read it, so the visibility model treated all 46,508 rooms as pitch black and a personal light was always required. Measured: **2,283 rooms carry it, 4.9%**, so Duris' own builders marked **95.1% of the world naturally lit**; 41 of IceCrag's 219 and 37 of the Kobold Settlement's 99. **Two helpers in `light.ts` and a union on each side.** `naturalLightTiles` is `roomLightTiles` at **zero** room-steps, so natural light and a beacon are *one* derivation at different reaches — a lit hall does not light the passage off it. **Both sides call it**, which is not a convenience: the server folds the result into `seen` and gates clicks on it while the client paints fog from it, so a tile they disagreed about would be ground you can see and cannot walk to. A **union, not a branch** — your own light still reaches past the room's floor through a doorway, so the two are additive and neither can subtract; in a lit room the disc adds nothing, in a dark one the room adds nothing, and in a lit room with a torch you get both. **How much of Duris' rule this is**: the flag half only. `IS_TWILIGHT_ROOM` also has twilight as a third state, `ROOM_MAGIC_LIGHT`/`DARK` from spells, and sector defaults where forest and swamp are lit *only while the sun is up* — all of which turn on `IS_NIGHT`, and **there is no clock**. An unmatched zone carries no flags and is therefore lit, which is right for the two inferred forest zones and is the honest default: absent data must not become a claim that somewhere is dark. **Driven live**: **81 tiles** visible — a whole 9×9 floor — in the lit spawn field with **no light source at all**, against **21** (the bare-eye disc) in the dark Kobold Mines, rising to 58 there with a torch in hand. On screen the difference is the whole point: the same room that was a small green blob in a sea of black now reads end to end, and the level-23 shaman standing in it is visible from the doorway. **Eight tests had to say `dark` out loud** — their subject is what a *carried* light reveals, and "no flags" had silently meant that |
| A blow says what it was | **V7**, owner's ask 2026-08-06: *"if I swing an axe or a sword it should say You slash the mob for 200 damage; if it was a club it should be bludgeon."* Transcribed, not invented — `attack_hit_text[]` (`fight.c:132`) is Diku's own table of **eleven** types with second-person, third-person and past forms, and it needed **no protocol change**, because the combat line was already rendered per recipient. **Two mappings, and they must not be merged.** A weapon's verb comes from its class (`get_weapon_msg`) — the `weaponClass` Phase 19 harvested hours earlier for skills — and an **unarmed body's comes from its race** (`GetFormType`), which is how a spider stings and a troll mauls. The trap is that they *look* mergeable: hammer and mace share the skill `bludgeon-1h` but split into **crush** and **bludgeon** as prose, and a polearm is `reach` for skills and always *slash* here. A test states the difference so nobody tidies it away. **The verb appears only on a hit** — you do not slash and miss, so a miss keeps "miss" and a fumble its own phrase; the table describes the blow that landed. `MobTemplate` gained the **race code**, which `spriteFor` had been reading and throwing away since the harvest: **optional**, so a stale `data/world` punches rather than crashes, and it already has its Phase 21 reader waiting (aggression predicates and the racewar both need it). **The regex is gone**, and that is the refactor the feature forced: the old line rendered third person and then rewrote "You hits" into "You hit" with the four verb forms *and their colour codes* in the pattern — survivable for four verbs, impossible for eleven. The sentence is now handed the person it needs. **Driven live 2026-08-06**: dagger → *pierce*, battlehammer → *crush*, mace → *bludgeon*, whip → *whip*, mithril sword → *slash*; and the Archivist (race `G`, a giant) **crushes** for 52 where every humanoid in the world punches, with *"critically punches you for 78"* reading correctly on a natural 20. **A gotcha worth keeping**: the first drive showed the giant punching, because spawn files are a worldgen output and the server had booted before they were regenerated — the same class of thing as the world not being rebuilt after V6 |
| The bag has pictures in it | **A7d-bag, and protocol 20** — the half of A7d the roadmap had waiting on one field: *"it wants an art id per `BagRow`, which is a protocol addition rather than a rendering change."* `BagRow.art` is filled through **`artClassOf`**, the resolver `index.ts` already injects for `EntityView.wearing`, so a leather cap in your bag and one on your head are the same string and cannot draw differently — and `sim.ts` still knows nothing about a catalogue. Optional, because a few hundred of 16,421 entries have art: a row for anything else says nothing and falls back to the name it always showed. The icon is **DOM** (`client/src/bagicon.ts`), like the combat feed and the group roster, so it cannot come out of a Phaser texture — a plain canvas loads the sheet from the client's own origin (which is what keeps `getImageData` legal), crops, and caches one data URL per art for the life of the tab. **It also pays off the finding A7d recorded and deferred.** A7d used column 0 of row 2 and wrote down the flaw: *"south is the wrong frame for a garment — `cape-solid` has 526 opaque pixels in its north row vs 62 in south."* The fix it named — pick the facing with the most content — needed a PNG decoder in `artgen`, but the browser has already decoded the sheet, so here it is a loop: all four facings are counted and **the most opaque pixels wins, not the largest box**, because a hem is wide and flat and a box comparison would choose the very sliver being avoided. Measured live: the cape went from **26×11** to **26×29** — hem to whole cloak. The floor icons still use row 2 and want the same treatment, and the honest home for it is still `artgen`, measured once per sheet rather than once per client. **Driven live 2026-08-06** on four items: cape, rapier and boots each drew their own picture at their own crop (26×29, 38×21, 26×14 — different sizes, which is the point), and a long black dagger with no authored art kept its row and drew nothing |
| You get better at what you do | **Phase 19's first slice — skills.** `shared/src/skills.ts`, and the phase's *Seen when* is now true: a landing blow can raise the skill its weapon trains, and the raise is the source's own sentence — *"You feel your skill in 1h slashing improving."* **Three things in the source are wired to code it does not compile, and finding them is what the design note was for.** `NEW_COMBAT` is defined, so `fight.c`'s whole combat is `#ifndef`'d out; `wipe2011` is defined nowhere, so `notch_skill`'s diminishing curve and the **only two readers** of its cooldown affects are dead — the shipped game writes a 5-minute cooldown that nothing ever looks at; and the live path's per-weapon-type skills (`SKILL_LONGSWORD` and seventeen more) **appear exactly once each in the entire source, as that function's return value** — never registered, so `update_skills` zeroes them and the live weapon-skill contribution is **0 for every player character in Duris**. So we take the **damage classes** the dead path uses, which are the ones with names, categories and per-class ceiling tables: 1h/2h × slashing/piercing/bludgeon/flaying, plus reach and unarmed. Measured over 2,841 weapons, three of them cover **76%** of the world; seven weapons train nothing (six with no class, and one two-handed dagger the source itself logs as a builder error). **The floor does the heavy lifting**, and it is Duris': `MIN(40, 3 × level / 2)`, dragging the learned value as well as the ceiling, so a fresh level-30 is competent for free and everything above 40% is earned. **Derived rather than written**, which is why storage is sparse — a skill with no row is *at the floor*, so a level-up drags all nine with no write at all, and `update_skills` costs nothing. **The rate limit is the compiled-out branch, adopted on purpose**: `chance / 4` while the category's cooldown is up (the source's own later wording — *"we just make it harder"*) and `chance × (1 − learned / ceiling)` so the ceiling is approached rather than reached. Without them the measurement is damning — a 1-in-5 gate at 33.33% is 6.7% of hits, which at a 3 s round maxes a skill in 25 minutes. The two cooldowns are ordinary Phase 5b affects and are **saved**, so reconnecting is not a way to grind. **What a skill is worth is a division, not a choice**: `getChartoHitSkillMod` is `skill >> 1` against a 1–100 roll, so on a d20 it is `floor(learned / 10)`, +0 to +9 — and because everyone at level 27+ has 40% free, the *earned* spread between a novice and a master of the same level is at most +5. Folded in `refitCombat`, which was already the one seam every kit change passes through, so the fight loop learns nothing and a notch just calls it again. `weaponClass` is now harvested (worldgen read `values[0]` and discarded it since the harvest landed) and carried onto the **instance**, because a greatsword in a save file has to still train the two-handed skill and an authored item has no catalogue entry at all; the four starter weapons carry a class of their own, or a fresh character's whole first level would train nothing. **Driven live 2026-08-06**: at level 5 all nine skills read 7% — the floor — and seven landing blows later *1h slashing* alone read **8%** with its floor marker gone, the `skills` output said *"you have learnt something physical recently, and are learning more slowly"*, and the save file held `{"slashing-1h": 8}` and a surviving `notch_physical`. The bonus was then read **out of the combat log**, where `[d20 natural → total]` makes it arithmetic: **+19 at level 30** (15 from the level, +4 from the floor) against **+2 at level 1** (2 + 0) — the promise that 14b's bottom band is untouched, observed rather than argued. `DESIGN-skills.md` has the six decisions and the four slices still to come |
| A party, and a kill worth more because you shared it | **Phase 18's second half — grouping**, and the phase's *Seen when* is now true on both clauses. `server/src/grouping.ts`, `client/src/grouproster.ts`, **protocol 19**. Four verbs transcribed from `group.c` / `actnew.c` rather than designed, and the two that read backwards are the two that are right: **the joiner consents and the leader enrols** (`group_add_member` refuses PC→PC without `LNK_CONSENT`), and **`group <a member>` kicks them** — one verb whose act follows from the state, which is what a Diku player's fingers already do. The asymmetry with `follow` is deliberate and the right way round: walking behind somebody costs them nothing, being in their group divides their experience. `group all` enrols your **followers**, which is the source's own bridge between this phase's two halves and the reason following was built first — somebody who chose to walk behind you has already said something about wanting to be with you, so it is the one bulk enrolment that is not a way to conscript a room. Thirteen members (`groups.size.max.*`); the leader leaving **promotes the second in the list**, which is why members are ordered and not a set; a group of one dissolves silently; grouping another group's leader **merges** both, because stealing a leader off the front of a party leaves it with nobody to lead it. Refusals are **five distinct answers** rather than a boolean, the rule 15c's containers set — and consent is checked *before* size, or a full group leaks the fact that a stranger has consented to you. `gsay` reaches the whole group **regardless of room** (`do_gsay` walks the list with no room check) and therefore deliberately carries **no** protocol-17 bubble fields: most of a party is not on your screen, and drawing bubbles only for the members who happen to be beside you would read as the far ones being ignored. Forgotten in every direction on disconnect — membership *and* consent given *and* consent received — the reissued-id argument for the third time, and the one that closes a real hole: consent keyed to an id would otherwise let a stranger enrol the next character handed it. **The experience rule is a composition and the owner chose it (2026-08-06)**: Duris pays every member in the room by membership, we pay by contribution, and both cannot decide one kill — so a group **multiplies** each contributor's share by `4N/(N+3)`, with `N` counting only members who were in the room **and** contributed. The party total is then the source's own (160% at two, 229% at four) while who earns it stays ours, and twelve idle alts parked in the room are worth nothing to anybody — which is what makes it exploit-free by construction rather than by a cap. `fight.c`'s power-levelling wall survives untouched (`÷40/150/1000/5000` at level gaps of 15/20/30/40) because it is the one thing contribution cannot police: taking a single hit from a level 50 mob *is* contribution, and a share of that kill would be a level 1's entire career. Coin is deliberately **not** multiplied — a purse is a thing the body was carrying, and paying out more than it held would mint money, where paying more experience than the mob was worth is exactly what Duris does on purpose. **The roster is a message, not a field on `SelfView`**, and the reason is whose data it is: `self` is pushed when *your* pools move, and a roster goes stale when *somebody else's* do — the same trap protocol 16's chevron fell into. `here` is on the wire because it is a rule and not a decoration: only members in the room share a kill, so a row drawn identically for a distant member would hide why their share went missing. **Driven live 2026-08-06.** Two sockets: the refusal without consent, the handshake, the roster printout, `gsay` both ways, the train, and a shared kobold paying *"You gain 300 experience (18 dealt, group of 2)"* to both. Then the control, in **one** fight with three contributors — two grouped, one not: pool 648, damage 17 / 20 / 39, and the payouts were **230 / 272 / 332**, which is 1.6× the first two contribution shares and exactly 1.0× the third. And in the browser: the panel drew both rows with the leader marked, updated a member's bar because the *other* character was wounded (50.8% amber, 27.3% red), greyed the row with the tooltip *"not in the room — no share of a kill here"* when the leader was moved next door, and emptied itself the moment the leader disconnected |
| You can decide what a mob is carrying | **A4c**, owner's ask 2026-08-04: *"assign items to mobs as loot."* A4 built the live half — spawn one, watch it, slay it, see what its corpse holds — and this is the authoring half. `server/src/mob-overrides.ts`, the fourth overlay in `data/world/overrides/` and the same shape the other three take. **Per template, and the panel says so in as many words**: a *harvested* kit is per reset command (an `E` attaches to the last mobile the zone file loaded, so one vnum in two rooms can carry two different things), while this changes **every** instance the world spawns from now on and **none** of the ones already standing. The save reports how many those are, because *"I authored it and nothing changed"* is otherwise the first bug report — and A4's Repop button is what turns it into something to go and look at. **Additive, and provably so.** It is applied *after* the reset table has dressed the mob, so an authored piece wins a contested slot and the harvested one it displaces goes to the mob's **hands** rather than being destroyed. What is on a body only ever goes up, which is what makes "additive" true rather than merely intended — and it is the rule `reset.ts` already uses for a wear position we do not model. Subtraction is deliberately impossible: it would mean naming things that are *not* in the overlay, and a re-harvest that changed a zone's `E` list would silently change what the subtraction meant. **A slot the game does not model is refused rather than downgraded to carried** — the opposite of what `reset.ts` does with a harvested `E`, and the asymmetry is the point: harvested data is inherited and worth keeping on the body, while a slot typed here is a choice somebody just made, and quietly doing something else with it is how an author ends up believing a hat is on a head it is not on. Loot is instantiated **per instance**, so two guards authored a key carry two keys rather than sharing one. Applied at both spawn paths — the zone reset and the panel's own Spawn button, which is the first place anybody will look. **Driven live 2026-08-05**: authored a rusted iron key (carried) and a small iron key (offHand) onto kobold guard 1410, which reported **8 already standing and unaffected**; spawned a fresh one, slew it, and looted **both** pieces off the corpse |
| The floor empties itself | **Round 8's mechanic slot**, owner's ask 2026-08-05: *"dropped items need to decay so we don't have rooms full of discarded items everywhere."* Ten minutes, then it goes — with a warning a minute before, latched so it is said once rather than every tick. **The reason is not tidiness, and that is the part worth keeping**: `reset.ts` caps object instances **world-wide** and the census counts what lies on floors and inside floor containers, so a room ankle-deep in discards quietly holds a zone's repop at its ceiling — the sword nobody picked up is why the table upstairs has none. Clutter is the symptom; a zone that stops repopulating is the cost. **Nothing to transcribe**: Duris does not decay dropped objects at all (`ITEM_TIMER` is repurposed for traps, and `point_update`'s timer is a *character* idle counter), so the number is ours, anchored on our own corpse clocks — **twice a mob's corpse** because you chose to put this down, **a third of a player's** because that is a disaster you are running back to. A container **spills rather than taking its contents with it**, the corpse rule one store over, and the spill walks each stack's `count` so a quiver does not destroy nineteen of twenty arrows. The clock restarting on a fresh drop is free *because the floor is not persisted* — a restart clears it outright, so there is no long-lived object whose age anybody could game; if `ground.ts` ever gains a save file that is the line to revisit. **`GAME_DEV_DECAY_MS` is the rig**, default-off and announced at boot like its three siblings, because watching a ten-minute clock is not a drive. **Driven live 2026-08-05** at 5 s: dropped, *"A leather tunic is starting to fall apart"*, then `entityLeave` and *"A leather tunic crumbles away"* |
| Getting rid of something, on purpose | **`junk`**, owner's ask the same day, and the source had already decided both halves: `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)` is *requires confirmation, and may not be used while fighting* — so the confirmation the owner wanted is a property of the command in Duris' own table, beside the posture requirement. Even the wording is transcribable: `do_junk` writes **"WARNING: JUNK permanently destroys the specified object(s)"** and offers `(Yes/No) [No]`. **Why it exists when `drop` does**: dropping is not disposal. Phase 15b put things on a real floor where they remain an entity, remain visible, and remain counted against their vnum's world-wide limit — getting rid of something by dropping it makes it the zone's problem. This makes it nobody's. **The confirmation is intercepted before the command table, which is `interp.c:1343` exactly**, and that placement is the whole trick: `n` is north, so a `no` in the table would either steal it or force the refusal onto a second-choice word. Read while an answer is pending, `n` means no — and means north the rest of the time. **What is stored is the command line, not the resolved item** (the source's `last_command`), so confirming re-asks the question and a bag that changed in between produces an honest refusal rather than destroying whatever slid into that slot. **One deliberate divergence**: Duris leaves the confirmation armed when the answer is neither yes nor no; ours clears it, because an armed destroy that survives ten minutes of play and then fires on a stray `y` is precisely the accident a confirmation exists to prevent. It is also dropped on disconnect — entity ids are reissued, and an inherited armed junk would destroy something of the next character's. **What was inside goes with it**, which is the one place this parts company with corpses, decay and drops: in all three of those the player has not asked for the contents to stop existing, and here they have. The level column reads 56 and is **deliberately not transcribed** — `do_junk`'s own body contradicts itself about `IS_TRUSTED`, and a verb for tidying your own bag has no business being gated. **Driven live**: armed, cancelled by an `exits` that still printed the exits, cap still in the bag; armed again, `yes`, *"You destroy a plain leather cap"*, bag empty |
| A map of everywhere you have been | **V4**, and **protocol 18**. `M` frames the Place you are standing on and there has never been a view of anywhere else; this is the other question. `HANDOFF.md`'s first decision fixes the form it may take — coordinates are normalised per zone *and* per level, so no two Places share a coordinate space and 0 of 991 cross-zone exits is a geometric neighbour. **There is no plane to draw the world on**, so it is a graph: discs for Places, lines for links, on concentric rings by how many boundaries you crossed to reach them. Rings rather than physics because the layout must be a **pure function of the graph** — a force-directed one would look better on a big graph and wobble on this one, and a map that rearranges while you read it is worse than a plain one. Verified by drawing the same graph twice with the nodes supplied in a different order: identical positions. **It adds no persisted field**, which is the design rather than a saving: a character's `seen` bitsets already record which Places they have stood in, so the whole thing is derived. **The edge rule is where the care went, and a test killed the first version of it.** "Source room seen, far Place visited" reads as sufficient and is not — a character who has stood in the marsh and, separately, in the keep would be shown the passage joining them, because the marsh room they *did* see has an exit into a Place they *have* been. They never found that passage. It now needs **both of its rooms seen**, which says exactly *you have stood on this side and on that side* — what walking a link gives you, and all it may give you. A node also carries **rooms explored, never rooms that exist**: telling somebody there are ninety rooms on a level they have found four of is handing them the answer. That count is why there is a **request** message as well as the push — the graph is pushed on every Place change, which is when a node or line can appear, but the count climbs with every step inside a Place, so the view asks when it opens. Shares **`M`** with the zoom rather than taking a key: gotcha 5a says every bound key is a letter that can vanish from the command line, and gotcha 5b says read the modifier off the event rather than polling it. **Driven live 2026-08-05**: joining gave one node and no lines; descending into level 4 of the Kobold Settlement produced the second node and the edge `168:4 --up-- 168:5` in the same push; and the overlay drew four Places on two rings with the current one picked out. `client/src/placemap.ts`, `server/src/placegraph.ts` |
| Moving the edge of a zone, and paying for it | **A8's third and last slice, and the sharp edge the other two were built to avoid.** A grid is sized from `boundsOf` the rooms on its level and tile indices are row-major, so a resize does not make a saved `seen` map *incomplete* — it makes it **wrong**, lifting fog off tiles nobody has visited and drawing it over ones they have. Slices 1 and 2 refused to resize at all; this one allows it and **clears the Place's explored map for every character, then says so**. Of the three possible outcomes it is the only honest one: preserving is impossible, re-mapping needs the old grid's width (never stored) and would have to be right for every offline save too, and a *shifted* map is the version a player reports as the fog being broken. **The comparison is against a stored extent, and that is the whole trick** — `rooms-authored.json` records what each Place measured when the overlay was last written, so the question is "has it changed *since the maps were written*" rather than "is it different from the harvest"; the second stays true for ever after one edit and would clear every map on every boot. Only Places the overlay touches are recorded, so an unauthored world writes nothing and a boot never dirties a tracked file. **The growth is bounded by a rule slice 1 already had**: a created room must join a neighbour, so it can never be more than *one cell* past the edge — there is no way to ask for a grid a thousand wide, which is why nothing checks for one. Three things the build found that the note did not. **Actors are positioned in tiles measured from the extent's corner** (`(room.pos.x - bounds.minX) * ROOM_STRIDE`), so a grid that grew leftward moves every body on the Place without anybody touching them — `forgetPlace` re-seats them all. **The clearing must be flushed, not debounced**: `touch` schedules a write and `unref`s the timer, so a restart inside that window keeps the stale file — and the boot check would *not* catch it, because by then the stored extent matches and the two agree nothing changed. The one character left holding a wrong map would be whoever was online. **And the warning has to precede the act**: the panel colours the build button red and says what it will cost before the press, and `RoomDetail.holdsExtent` lets the delete control do the same — a warning that arrives with the response is a warning about something that already happened. **Driven live 2026-08-05**: two characters walked a real 2,624-char map of 168:5 and logged out; building a room at cell (13,5), one past the edge, reported `mapsCleared: 2, told: 1` and **both save files were empty of that Place when read straight off disk with no flush in between**. Deleting it again shrank the grid back, and a connected client received a fresh `seen` snapshot that went **2,824 → 2,624 characters** — the grid genuinely narrowing — plus the announcement. A hand edit that added a room past the edge *without* updating the extents record was caught at the next boot, cleared one map, recorded the new extent, and **did not fire again on the boot after that** |
| You can take a room out again | **A8's second slice**, and it is where the design note's two "tolerated, not repaired" decisions finally have to be honoured rather than agreed with. **Deletion is two operations wearing one verb**: a created room is removed by deleting its record, because the record *is* the room; a harvested one by writing a **tombstone**, because the zone file is generated and the next `npm run worldgen` would put it straight back. **The extent is guarded the same way slice 1 guards it, from the other side** — `removalRefusal` compares the level's bounds with and without the room, so a room *the extent rests on* is refused while one merely *sitting on* a shared boundary is fine (a wall of five rooms would otherwise be undeletable for no reason). Two more refusals live in the router because they are about the world in use rather than its geometry: the **spawn room**, since deleting where characters arrive breaks joining for everybody, and a room **somebody is standing in**, named — the operator has `teleport` and `kick`, and moving a player without telling them is the worse answer. **What is left behind is reported and not repaired.** Neighbours keep pointing at nothing (decision 3 — the shipped world already has 5 such exits and the engine simply does not walk them) and reset commands naming the room are skipped in silence for ever (decision 4 — the spawn files are a worldgen output, so they come back on every rebuild). Both are counted and shown at the moment of deletion, **which is the only moment anybody will ever be told**, and the panel says so in those words. Mobs, corpses and floor items are cleared out first — `clearRoom`, deliberately **not** `slayMob`, because a slay leaves a corpse and a corpse in a room that is about to stop existing is the thing this avoids: nothing died, the room did. **One interaction the build found and the note did not predict**: a delete leaves debris, and debris was then blocking the cell for ever — `resolveExits` refused to build back into the hole because the neighbour "already had" an exit that way, pointing at the room just removed. A dangling exit is not a link somebody authored, so it is now overwritable and a live one is not; telling the two apart needs three states, not two (`destinationLives`), because an exit into a zone this server does not *run* is real content and must not be stolen. **The tombstone beats the directory** in that test, and it has to: a tombstoned room is still in its zone file, so asking the disk first reports a room we deleted as alive. **Driven live 2026-08-05**: the spawn and the extent were both refused by name; The Pantry (41300) came out with 2 dangling exits reported (41299 up, 41301 east — note one is vertical, so the scan is world-wide rather than per-level), 2 orphaned resets (1 door, 1 mob) and 1 mob cleared; the created room came out clean, with **no** dangling exits, because the reverse links it wrote were its own and came out with it. The control is two gestures — `Remove room…`, then `Yes, remove it` — the same staged-then-committed shape the PvP switch uses, and for a stronger reason: every other write in this panel can be undone by writing again |
| You can build a room in a gap the world left | **A8's first slice, infill**, and the thing A5 spent five phases refusing by name. `DESIGN-zone-geometry.md`'s five decisions, three of them in code and the sharp one **side-stepped by construction rather than by care**: a grid is sized from `boundsOf` the rooms on its level and tile indices are row-major, so widening one shifts every saved `seen` index — and `placementRefusal` will not accept a cell outside the level's extent, so no code path here can widen a grid. Measured on the drive: level 168:5's tilemap is **143×110 with the new room and 143×110 without it**. `server/src/room-authoring.ts` is the overlay — `rooms-authored.json`, whole records rather than patches, a **stored** counter from 1,000,000 (the highest harvested id is 97,271 and none is above a million), which A6b's argument says must not be derived because deleting the highest room would recycle its number and a room id is a name. Four things the build settled that the note left open. **An infill exit's destination is derived, never posted** — it is whatever stands in the adjacent cell, so the panel offers a tick per real neighbour and a direction that would be refused is never on screen; but the resolved far end **is stored**, so a neighbour that moved in a re-harvest is a discrepancy the loader can see and drop rather than a link that silently re-points. **A neighbour's existing exit is refused, not replaced**: decision 3 says write both sides, which is not permission to overwrite a side somebody else authored. **An edit to a created room re-drafts its own record**, A6b's dispatch in its second home — two overlays claiming one room is a state where the answer depends on load order — and `null` (unauthor) is refused there because there is no harvest underneath to restore. **Up and down are refused by name**: a vertical link lands on a second Place with its own grid and its own `stairPlacement`, which is real work with its own drive. The gesture is **clicking an empty cell on A4b's map**, because "which cell" is the one question a map answers better than a form; only gaps that touch a room are drawn, which is both the performance bound on a sparse level and the honest set, since a room must be joined to something. **Driven live 2026-08-05**: built "A Trampled Hollow in the Wheat" at cell 1,7 of the Kobold Settlement from the panel, and walked into it from the spawn two rooms away — the room described itself, reported its one exit north, and 41263 had gained the matching south exit **with no restart**. A cold load from disk brings all of it back with no refusals |

### Not built

Quests, classes, races, skills, spells, chat beyond the room and the group (`say`, `whisper`, `gsay`).

**Every reset letter now has an executor.** `M`, `D`, `G`, `E`, `O` and `P` all run.

**A mob's worn kit does not make it harder to hit.** Its combat profile is the harvested one 14b tuned
against player capability, and folding worn armour in would quietly add several points of AC to every
equipped guard in IceCrag — 247 `E` commands in that zone alone. A mob's kit is loot, not armour, and
making it count needs a rebalance pass rather than a line in `reset.ts`.

**Ground objects do not survive a restart.** `ground.ts` is in memory only. A character's own things
are safe — they are in their save file — and only what somebody chose to put down is lost. Persisting
the floor needs a world-state file that also has to survive `npm run worldgen` rebuilding the rooms
underneath it, which is a real design question and not one to answer by accident.

**Item authoring — done, both halves.** A6 edits a harvested item through a partial overlay; **A6b**
creates one outright. The two are separate files because their rules are opposite, and the table in
`item-authoring.ts` says why in four lines. **Art landed too, as A7a/A7b.** `npm run artgen` indexes the ULPC pack into
`shared/src/lpc-art.ts` — 319 sheets, each probed for a real 576×256 walk cycle — and `art` is an
authorable field on any item. Three things worth not rediscovering:

1. **`LoaderPlugin.start()` during scene creation stops the scene dead.** The client sat on
   "connecting…" with the socket open, the whole join sequence sent, and **no error anywhere**. Sheets
   are queued and the loader is kicked from `update`, which cannot run until creation is finished.
2. **`mainHand` was never in the client's layer order.** A wielded weapon had no path to the screen at
   all, whatever the wire said. Layers now sort by the `zPos` the artist gave them.
3. **The idle-sheet swap assumed every sheet has an `-idle` twin.** The starter kit does; indexed art
   does not, so standing still turned an authored sword into Phaser's `__MISSING` box. It falls back
   to the walk sheet now.

Still to do on art: **A7d**, bag and floor icons. **A7c, the picker, landed 2026-08-05** — see the
table row below.

**A7a stages one layer per ULPC definition, and 168 of 657 have more than one.** Found 2026-08-05
from three separate owner reports that turned out to be one fault:

- *"if I walk north the weapon in my hand disappears"* — `weapon_sword_rapier.json` has **four**
  layers: `layer_1` at z 140 (the sword in front of the body), **`layer_2` at z 9,
  `universal_behind/`** — the sword drawn *behind* the body — and two more for the attack animation.
  Facing north your back is to the camera, so the sword belongs to the behind layer, and that layer
  was never staged. Measured: `weapon-sword-rapier-rapier.png` has **zero opaque pixels in its
  north row**.
- *"the cloak only really shows the shoulder connection"* — `cape_solid.json` is `layer_1` z 85
  (`fg/`, the shoulders and clasp) plus **`layer_2` z 5 (`bg/`, the cloak that hangs behind you)**.
  Only the shoulders were staged.
- The cape the owner had picked was `cape-trim`, which is a third thing again: `kind: cape_trim`, the
  decorative *hem* meant to layer over `cape-solid`. Its pixels sit only in the bottom 16 px of the
  frame, the same band as boots — so it drew exactly where it was painted, around the ankles. Not a
  bug; the picker just gives no hint that an entry is an overlay rather than a garment.

**The fix is not small and should not be rushed**: `ArtEntry` carries one `sheet`, and it needs to
carry a *list* of (sheet, z) — which changes `artgen`'s staging, the index, and the client's stack
expansion from one image per art id to several. The z values already say where each goes, so the
sorting the client does is unchanged. **25.6% of the pack is affected**, so this is the difference
between the art pack half working and working.

**Be aware of the inert surface.** `proficiencyBonus` still has **zero non-test callers**.
**`SECTOR_REQUIRES_MOVEMENT` came off this list in Phase 16** — deep water and thin air now refuse a
step, before stamina is charged for it. `resolveAttack` and `rollDamage` came off this list in Phase 11 — they had been
written and tested since the beginning and never once called, which is the exact failure `ROADMAP.md`
rule 1 exists to prevent. `ROUND_MS` is now read through `roundLengthFor` and stored per actor, which is
§4.1's requirement rather than a tidy-up. `SECTOR_MOVE_COST` came off in Phase 5, and **`isWimpy` came
off it in Phase 14** — harvested since Phase 8 with no reader, it now resolves to `wimpyAt` on every
template and is what breaks a mob's nerve.

Phase 5b added exactly one thing to it, knowingly: **`AffectFlag.Offline`** — "keep counting down while
logged out" — has a reader in the save loader and no setter, because the default (a saved affect
resumes with the time it had) is what the carried light has always done and what a player expects of a
torch they were not holding. It is there so that the first cooldown or PvP timer cannot be dodged by
closing the tab; the alternative was a special case in the loader on the day one arrives.

`RoomFlag` and `Room.description` came off that list in Phase 3 — 3,911 rooms now carry a flag and
5,889 carry prose. Phase 10 made the first two of them **change a rule**: `no_mob` and `safe` are cut out
of the hunt's search graph, so a pursuer routes around them. Note the asymmetry that remains — `safe` is
read by exactly one mechanism and set on exactly one room in the shipped world, which is why the sanctuary
half of pursuit is tested rather than demonstrated.

## The decisions that everything rests on

1. **`Place` = (zone, level)** is the unit of rendering and collision. Worldgen normalises room
   coordinates *per zone*, so 0 of 991 cross-zone exits are geometric neighbours — every one is a
   portal. Travelling between zones and between levels is therefore the **same operation**.

   Two facts about the source world make this the right call rather than a convenient one, and both
   come from the owner:
   - **Zones are joined by portals, not by roads.** There is no gravel path running from one zone into
     the next, so a shared global coordinate space would be modelling a continuity the world does not
     have.
   - **Zones can overlap.** Some exist on different planes of existence, so two zones may occupy the
     *same* map position and which one you are in depends on the state of the character. Per-zone
     coordinates make that free — they are simply two Places, and a character is in exactly one.

   The consequence to remember: **do not lay zones out on shared world coordinates.** An overworld or
   minimap that tried to place all 327 zones on one plane would have overlapping planar zones collide,
   and would be asserting adjacency that no exit backs up. Any such view has to be a graph of Places,
   not a map of them.
2. **The server is authoritative and renderer-agnostic.** Clients send intents, never outcomes. This
   is why a 3D client would be a new `@mygame/client`, not a new project.
3. **`shared` holds anything both sides must agree on** — the tile grid, `stepMovement`, the
   pathfinder, shadowcasting. One implementation means client prediction cannot drift from the
   simulation by construction rather than by discipline.
4. **`ROOM_GAP` is tuned against `DEFAULT_LIGHT_RADIUS`**, not chosen for looks. The next room's
   floor is `ROOM_GAP + 1` tiles away and a light of radius `r` reaches `r`, so at gap 2 the next
   room is invisible at the bare radius 2 and visible at radius 3 — *the first torch*. Moving either
   constant re-tunes the game's opening. `vision.test.ts` pins it.
5. **Fog gates pathfinding, not movement.** Click-to-move is restricted to tiles you have seen;
   steering (WASD *and* hold-to-drag) is not, because steering earns every tile at walking pace and
   cannot route round anything you cannot see.
6. **Engagement is sticky, and fully specified.** [DESIGN-engagement.md](DESIGN-engagement.md) — one
   directed `fighting` pointer per actor with the inbound set *derived*, no range check anywhere in
   melee, `flee` as the only voluntary exit, and no timeout ever. **All of it built now** — the
   pointer in Phase 11, the exit in Phase 14.

## Gotchas that have already cost time

See `CLAUDE.md` for the full list. The ones that bite hardest:

- **Three direction encodings** exist: Diku `.wld` (`0=N,1=E,2=S,3=W`), zMUD `DirType`
  (`0=N,2=E,4=S,6=W`), zMUD `DirId` (1-based, different order). Getting one wrong produces entirely
  plausible output. Always assert the n≈s / e≈w balance after mapping.
- **Phaser input has two traps.** Bound keys are *captured* and `preventDefault`ed, so every key you
  bind is a letter that disappears from anything typed into the command line (`setTyping` toggles
  global capture). And polling `JustDown` in `update` loses chords and sub-frame taps — bind
  `keydown-<KEY>` and read the modifier off the event. Both are gotcha 5 in `CLAUDE.md`.
- **No TypeScript `enum` or `namespace`** — Node strips types at run time and rejects anything that
  emits runtime code.
- **A persisted field with no line in its reader is deleted, silently.** 15c's containers shipped with
  `readInventory` not knowing about `held`, so everything a player had *put somewhere* vanished at the
  next login — and before it reached the disk too, because `setInventory` normalises through that same
  reader. Nothing crashed and nothing logged. `loose` had the same omission on the death path and was
  destroying every arrow in a quiver. **Every field of a persisted shape needs a reader line and a
  round-trip test**, and the test has to assert the *whole* value rather than the fields you remembered.
- **`console.log` has no width specifiers.** `%7d` prints literally.
- **npm eats unknown flags** through nested `npm run --workspace`. Root scripts taking flags must
  invoke `node` directly.

## Documents

| Doc | What it is |
| --- | --- |
| `ROADMAP.md` | **The schedule.** 23 phases, each a mechanic paired with a visible result, plus the rule for where a new idea slots in |
| `REFERENCE-mud-mechanics.md` | **Read this before building any game system.** 106 mechanisms extracted from the real Duris MUD source, each mapped to built / partly / designed / not considered |
| `DESIGN-engagement.md` | **Read before writing any combat code.** The engagement model: what it is, what starts and ends it, what "in combat" forbids |
| `DESIGN-mobs-and-movement.md` | Mobs, reaction time, aggression, threat, pursuit, loot, quest hooks |
| `DESIGN-inventory.md` | Slots, item sizes, stacking vs uses, containers, equipment |
| `DESIGN-visibility-and-light.md` | The visibility model, light as progression, pointer movement |
| `DESIGN-admin-panel.md` | The admin suite: architecture, auth, the section-by-section plan, and what the built players slice proves |
| `RESEARCH-map-data.md` | Where the world data comes from, and the traps in it |
| `DESIGN-skills.md` | **Read before starting Phase 19.** What a skill is, the floor and the ceiling, the per-weapon-type mapping, how a 0–100 percentage meets a d20 roll — and the two places our own reference doc cites code the shipped source does not compile |
| `DESIGN-zone-geometry.md` | **Read before starting A8.** Adding and removing rooms: the id space, the `seen`-invalidation edge, two-sided exits, orphaned resets, and the build order whose first slice is safe |
| `DESIGN-spell-memory.md` | **Read before touching casting costs.** The seven things `DESIGN-spells.md` handed forward, settled: real mem times, the `spl_table` generator, a spell's circle belonging to its class, spellbooks and scribing cut, the psionicist, the full gate stack — and a third build flag our own code cites the wrong side of |
| `PLAN-3d-migration.md` | If the 3D question returns: engine choice, costs, milestones, go/no-go |

**The single best reference is on disk, not on the web:** the complete Duris MUD C source at
`data/zones-source/duris/src/` (228 `.c` files) — the same Sojourn lineage as TorilMUD. Grep it
rather than researching MUDs abstractly. Files are large; `magic.c` is 667 KB.

## How a phase is proved done

`ROADMAP.md` rule 1: **a phase is done when you can see it, not when the code exists.** That rule has
teeth only because every phase is driven in the running game before it is ticked, and the method is worth
writing down because it is not obvious and it has caught bugs no test could.

**Write a throwaway WebSocket client.** `node --experimental-strip-types packages/server/src/index.ts`
with `GAME_PORT=8787` and `GAME_DEV_ACCOUNT=dev:devpass`, then a script that opens
`ws://127.0.0.1:8787`, sends `{t:'auth',protocol:23,account:'dev',password:'devpass'}`, waits for
`account`, sends `{t:'enter',name:'Prober'}` (protocol 23 — two steps where `hello` was one), and
drives the game with `{t:'command',text:'kill sentry'}` and `{t:'steer',dx,dy}`. Read `log`, `self`,
`room`, `entityEnter/Update/Moved/Leave`, `attackResolved` and `died` back off the socket. These live
in a scratch directory and are deliberately disposable.

**Four things that will bite:**

1. **Pace commands.** `COMMAND_BURST` is 6 refilling one per 250 ms. A 40-step walk sent flat out is
   silently truncated and looks like the route diverging. Leave ≥320 ms between commands.
2. **Use the `GAME_DEV_*` switches.** A level-1 character has 9 hit points against a level 15–60 castle,
   and a bare radius of 2 tiles sees almost nothing. `GAME_DEV_LIGHT=glowing_ring_of_testing`,
   `GAME_DEV_LEVEL=35`, `GAME_DEV_DAMAGE=40d20+300`. All default-off and announced at boot.
3. **Mobs do not respawn** until the zone reset comes due, about seventy minutes out. A sentry killed by
   the previous run stays killed — **restart the server between runs.**
4. **Move the spawn point** rather than walking 40 rooms every time: `world.config.json`'s `spawn` is
   data. Put it back afterwards.

**Include a control.** The single most useful lesson of Phases 9–13: a negative result proves nothing
without a positive one from the same setup. "The mob did not notice me" was a *false pass* until the same
character stood still and was noticed — the mob remembered it from an earlier sweep.

**Three bugs were found this way and none of them could have been unit-tested**, all for the same reason:
`index.ts` starts a server on import, so its message-emitting layer has no test harness. A mob's turn
never reaching the client, an arrival line announced one tick before the observer could see the arrival,
and a mob that stopped fighting entirely when its target disconnected. **If you change anything in
`index.ts`, drive it.**

---

## Next, in order

**The schedule now lives in [ROADMAP.md](ROADMAP.md)** — 25 phases, each pairing a mechanic with
something you can see, plus two lighter tracks and a **cadence** (its §2b, owner's rule 2026-08-02):
work proceeds in rounds of three — one visual MUD aspect, one mechanic, one admin-panel job — so
every stretch ships something testable of a different kind. Read that for *what next and why*; this
file stays the answer to *where things stand*.

### Start here — where 2026-08-08 ended: the numbered schedule is complete

**Last in: skill ceilings re-keyed from four class groups to the nine classes** (owner's ask, after
asking why a mage could bash). Slice 4 keyed `ceilingFor` on a temperament and the fold was lossy in
the one direction that matters — a group row grants a skill to *every* class in the group, so
`priest: { bash: 60 }` armed cleric, druid and shaman, and the warrior group's default armed the
ranger, when `skills.c:3727` grants bash to **paladin, antipaladin and warrior and nobody else**.
Four of nine classes could bash and none should. `CLASS_SKILLS` now holds `skills.c`'s own two
columns per class — `{ level, max }` from `SKILL_ADD(CLASS_X, level, maxlearn)` — and **absent means
0, which the verbs already read as a refusal**. That is the sharp end: under groups every class had a
number for every skill; under the source most classes have most skills at nothing, which is what
class-specific means. Three level gates now bite — **warrior reach at 25, ranger rescue at 10, rogue
parry at 20** — so `ceilingFor` takes an optional level and returns 0 below it (omit it to ask "may
this class *ever*", which is what the click-menu needs). Four decisions worth knowing: **95 is now a
cap applied in `ceilingFor`, not a default**, so the table stores the source's number and stays
auditable line by line; **specialisations are excluded** (`SPEC_SKILL_ADD` grants to a spec, we have
none — so the zealot's dual wield that slice 4 folded into a flat priest 40 is gone); **dodge is
adopted from inside its own comment**, because `skills.c:3968` comments its entire class list out and
reading that literally would delete the skill — the third time this file has found the source's
intent parked behind a preprocessor, after `notchChance` and `swimSurcharge`; and **rogue dual wield
is 75, the rogue's own row**, not the assassin's 80 the fold had handed them. One transcription that
looks wrong and is not: **a rogue has no 1h slashing** — the source's row is commented out above the
note *"Thieves get 1h slash skill for shortswords only. Hardcoded in fight.c"*, an exception we have
not built, so the skill is absent rather than invented. `ClassGroup` and `CharClass.group` are
deleted; `groupOf` is `classOf`.

**And then the paladin was overruled, which is the table's one sanctioned deviation.** The re-key
surfaced that `skills.c` gives `CLASS_PALADIN` no one-handed weapon skill at all — it appears in both
2h rows and in none of the four 1h rows — and the source means it: `paladins.h:4` defines
`IS_PALADIN_SWORD` as `ITEM_TWOHANDS || WEAPON_2HANDSWORD`, so a paladin's sword in Duris *is* a
two-hander by definition, which is why `bash()` pays a shieldless paladin a bonus for holding one.
Duris' paladin is a two-handed class. Ours is not: the owner's ruling is that a paladin is a shield
user by the SRD's description, so they get **all four 1h rows at 95** — mirroring their own 2h rows,
which is the only weapon-skill number `skills.c` gives the class — while **dual wield stays refused**,
which the ruling named and the source agrees with. Pinned by a test, because the danger is a later
pass re-transcribing from the source and quietly taking the shield hand back. **And the starting kit
now matches the ruling**: `CLASS_KIT` in `equipment.ts` overrides the common roll per class, and the
paladin — its only entry — always starts with a plain steel longsword (`weaponClass` 5, so it trains
the `slashing-1h` the ruling granted, from the first swing) and a kite shield in the off hand at
**+0..+2 AC** — the table's lightest band, trimmed from +1..+3 on the owner's call so a paladin's
armour *floor* matches everyone else's and only their ceiling moves. Only those two slots are fixed; tunic, breeches and boots still vary as everyone else's
do. Every other class falls through to the common table unchanged, and the common table has no off
hand at all, which is what makes the shield the paladin's own. At +0..+2 the two kits overlap rather than stack:
an unlucky paladin sits inside the common +2..+9 band and only a lucky one clears it.

**Then the kit went to all nine classes, because the paladin was the buffed class and the owner said
so before it got worse.** Asking for "a chest piece worth wearing" surfaced that the paladin was
already 29% ahead of the field on gear — and the re-key had left a worse problem underneath: because
the common `mainHand` rolls at random and most classes now have most weapon skills at 0, a **cleric,
shaman, necromancer or rogue had a 75% chance of starting with a weapon they could never train**
(ranger 25%, sorcerer 50%, druid 25%). That is the correctness half and it mattered more than the
balance half. `CLASS_KIT` now has a row for every class; every `mainHand` maps to a skill that class
actually has, pinned by a test.

Balance is argued in the only currency level 1 has. Weapon skill is **+0 for every class** at level 1
(it first bites at 7) and dual wield swings **0% of rounds**, so a kit can only be worth armour class
and weapon damage. Fitness `F = 20·D/(11−AC)`, measured over the real roll: martials
**18.52–19.00** (spread 2.6%), casters **17.42–17.85** (2.5%), common table 19.11. The ~6% martial
lead is the one deliberate inequality — the five casters hold circle-1 spells at level 1 and the four
martials hold none until 11 or never. **No class is best on both axes**: the paladin tops armour, the
warrior tops damage, and a test fails if that ever stops being true. The paladin's damage came *down*
to 2d4 to pay for the mail; that is the trade, and it puts them on the line at 19.00.

Two traps worth carrying forward. **`KIT_ART` maps ids to sheets and an id with no row does not draw**
— a chest piece added to `equipment.ts` without a line in `scene.ts` is invisible, which would have
silently defeated the request; `mail_shirt` ships with its mapping to the already-staged
`torso-chainmail`. And the docblock above `STARTER_KIT` **used to claim AC 19 is hit ~30% of the
time**; it is 10% (30% is AC 15), an error that under-prices armour by more than double and that a
design pass took at face value before it was caught. Corrected in place. Note the house 95 cap
already levels paladin with warrior here, exactly as it does in 2h; the source's 95-vs-100 gap does
not survive `SKILL_CEILING`, and that is the cap's doing rather than this ruling's.

Verified beyond the suite (**1,843 green**) by re-deriving the whole table from `skills.c` and diffing
it against `ceilingFor`: **144 class/skill pairs, 65 source grants, 4 sanctioned deviations honoured,
no discrepancies.** The verifier carries an allowlist rather than a blanket exemption, so a *fifth*
disagreement with the source would still fail it.

**The world became one place that night, and the measurement is the part worth keeping.** The owner
asked whether the Faerie Realm could be walked to from the kobold zone. Measured across all 327
harvested zones, it could not: zones **64, 190, 193, 226, 367 and 423 form a six-zone island with no
walking route to the mainland's 268 from anywhere**, so no amount of loading could ever have joined
them — in the MUD the Feywild was reached by magic, and our map is a record of routes somebody
walked. Worse, the *loaded* world was six disconnected pieces and the kobold settlement was joined to
nothing at all: a new character could reach 99 rooms, full stop. Two things fixed it. **321 Evermeet-
Ancient Forest** was switched on — 100 rooms that already border the settlement in the harvest, its
only harvested neighbour — and a **faerie ring** was authored through the new `links.json` overlay
(`server/src/links.ts`) from deep in that wood to **7691 "A Ring of Rowan Trees"**, a room the map had
already named, which already drops through a closed door into Finn's Keep, whose key one of the live
quests pays. It is **17 rooms from the spawn point to the Feywild**, walked end to end by a client
that discovered the route from nothing but the exits the server sent it. The whole faerie cluster is
loaded on the owner's call — 906 rooms — and **only zone 64 has harvested population**, so
Leuthilspar's forest and the two courts were 471 rooms of fully-described, entirely empty world.

**The courts are populated now** (2026-08-08, *"yes populate the courts"*), and the interesting part
is that almost none of it had to be invented. The zMUD capture keeps each room's contents **below its
`Exits:` line**, which means the mapper recorded the population as it walked: 12 creatures across the
Seelie court's three inner chambers — **Tiaronn, King of the faeries** and **Sysoria, the faerie
Princess** among them, by name — and 55 content lines across all 288 Unseelie rooms. So this is
transcription, not authorship — **where the capture speaks**, and that distinction is worth keeping.
Every creature's name and description comes off a capture line, and in a room the mapper recorded, the
population is reproduced line for line: all 23 placements into the Seelie court's three captured rooms
and all 61 into the Unseelie court match their room's own text exactly. But **55 of 58 Seelie rooms
were never captured at all** — zMUD holds no `Desc` for them — so the 29 placements filling the
approach and the halls are ours, arranged in the spirit of the three rooms that do speak. The capture
is silent there rather than contradicted. Stat blocks are ours throughout, each copied verbatim from a
harvested template at the same level, so a created faerie is hit by the same arithmetic as a Duris one.
**31 creatures authored, 15 harvested templates cloned, 113 placements, none homeless.** Two rules kept it
honest: a creature whose whole point is a non-humanoid silhouette was left out (the stags, ravens and
displacer beast the capture also holds — LPC has humanoid bodies only), and a **named unique already
standing in zone 64 was never placed a second time**, since limits are world-wide and Robin
Goodfellow twice is one Robin Goodfellow too many. Levels rise with depth and fit each creature's
*shallowest* room: the Seelie approach is 15 rooms of level 4–9 fae with nothing aggressive in them,
and the one aggressive Seelie creature holds the gate rather than the hall. **183 rooms of
Leuthilspar's forest (367) are the empty ones now.**

The blocker that had to move first is general, and deliberately so: a zone reached the reset clock
only through a harvested `ZoneSpawns`, so a zone with no `.wld` behind it could never be populated at
all, and a placement into one was silently counted homeless. `emptyZoneSpawns` in `server/src/spawns.ts`
gives such a zone an empty table with a lifespan, which separates two facts that were tangled —
**having a harvest** and **being populated**. `DESIGN-city.md`'s Phase 22 city zones will need exactly
this, so it is written as *a zone can be populated without a harvest*, not as a faerie special case.

**And then the fleet finished the week's backlog in one delegated evening** — eleven agent
branches reviewed and landed serially, ~65 new tests, the suite at 1,814. Beyond the paragraphs
below that individual agents left: the **shrug bases went live** (drow and grey elves 35, half-elf
20 — the flat 5% floor was a defaults bug; duergar left the shrug set entirely and got the
mechanism they actually own, **magical reduction**: −20% *generic force* only, magic missile and
earthquake glance off both dwarven races, fire never does); the **attack-verb race codes** were
trued against the source's own table (24 of 39 wrong, all inert in the loaded world);
**dual-wield** landed with the finding that no off-hand penalty exists in the live branch and the
price is the skill roll plus the light-blade rule (`wield <weapon> offhand`; Windsong waits for
the operator's blessing by hand); the **click menu grew opening moves** (Bash/Kick/Cast▸ gated by
the same shared tables the server consults — and note bash has *no* shield requirement
server-side, checked rather than assumed); the **admin panel got a quest editor** whose writes
re-badge and re-armour givers on live clients without a restart; and the **Duris quests were
found** — not in the C but in `areas/qst/`: 1,273 givers, 3,275 exchanges, three now live
(the Viscount's onion among them), the rest catalogued in
[REFERENCE-duris-quests.md](REFERENCE-duris-quests.md) with `reward.item` added to the schema on
the corpus's own argument (2,517 of 3,275 exchanges pay an object) — which also surfaced that
`bring` could never have completed, now fixed. Chips open: counted `bring` (the biggest unlock —
1,154 exchanges want several of a thing), and the stacked orphan docblocks in scene.ts.

**Phase 21 closed the same day it opened, and with it every numbered phase but Phase 15's art
tail.** The evening's slices 4-7: **skills by temperament** (the `ceilingFor` seam got its four
`maxlearn` rows; zero means the training never happened and the verbs refuse it — the wizard's
sheet lists no bash at all) — **since re-keyed to the nine classes, see below**, **channels** (gossip/tell/reply/gsay + a `who` with race and class —
protocol 25), **sun and senses** (the underdark races wear a visible `sun_scorched` −2 under the
open sky, off in shade, via an idempotent tick pass; ultravision/infravision floor the bare eye
at 4/3), and **the quest** (*Gwark thins the warren* — `quests.json` overrides, one `quest` verb
holding the whole giver conversation, kill-counts hooked into the award path, 500 xp + 50 copper
at the turn-in, `done` persisted). **The roll card gained numbers beside its words the same
evening** (owner's third ask): "good 15", live, under a plain 4d6-drop-lowest explainer. 1,708
tests. Lessons paid for: the command table's order *is* abbreviation priority (`gossip` stole
`g`, `quest` stole `q`; the test wall caught both — the channels live at the table's tail now),
`resting` is a *status* (bitten twice now), and a probe that leaves 3.2 seconds after `kill` has
killed nothing — the opening blow waits a round, and wimpy youths flee weak hitters, which made
the quest drive honest.

**The giver got his badge and his armour the next morning** (owner's fourth ask of 2026-08-08) —
**and the armour came back off the same evening, which is the part to read.** `EntityView` carries
`questGiver`, protocol 26, and the client hangs a gold `?` over that head. The armour is a registry
of untouchable *vnums* in `combat.ts`, seeded at boot from the `quests.json` rows: `canBeAttacked`
refuses, which is how
`shouldAreaHit` inherits it for nothing, and `landBlow` refuses again for any path that composed a
blow without asking. Testing the area case exposed a real gap on the way: `castClassSpell` demanded
a named target before it would cast anything, so an area spell could never be aimed at a room —
`spell.kind === 'area'` now casts with no target at all. 1,714 tests.

**But it armoured *every* giver, and that was wrong** — the owner said so the same evening: *"the
viscount for example should be killable."* The mistake was hanging two facts on one bit, so
offering work made a body immortal and there was no way to say *asks for help, and can be murdered
for it*. Since **protocol 27** they are two: `QuestDef.protectGiver` — **absent by default** —
seeds the registry, `questGiver` keeps only the badge, and `EntityView.untouchable` tells the
client which it is, because a menu must never offer a blow the server will refuse. A killable
giver's click menu now shows *Quest*, the openers **and** *Attack*; an armoured one shows only
*Quest*. `untouchable` deliberately says nothing about quests, so a shopkeeper can carry it later
without being handed a quest to justify it. The flag is OR-ed across a giver's rows, round-trips
through `saveQuests` (a writer that dropped it would turn a typo fix into a dead giver — tested),
and is a tick-box in the admin editor that re-arms the **live** world with no restart. **All eight
shipped quests are unflagged**: Gwark, the Viscount and Finn are ordinary bodies who can be killed
for their trouble. **One trap worth knowing
before you probe this**: `describeRoom` re-seeds the watch set from the `RoomView` it just sent, so
a character *arriving* anywhere is never sent `entityEnter` for the bodies already standing there —
they come in `t:'room'`'s `view.entities`. A probe listening only on `entityEnter`/`entityUpdate`
sees nothing for a mob that never moves and never fights, and reads as a server bug that is not
there. All three paths build their views through `sim.viewOf`, which is the only thing in the
project that constructs an `EntityView`.

**`whisper`'s two loose ends were tied the same day**: `reply` answers a whisper *with* a whisper
rather than lifting the answer out of the room as a tell (the manner now rides beside the name in
`replyTo`), and the room's *"X whispers something to Y"* line was naming **Y** ungated — the original
`say` leak on the second subject, now closed by `actLinesPair`. Whisper stays on the `say` channel and
the protocol stays **26**: it is a sound in a room, not a voice over the world. 1,755 tests.

**Track A's biggest operator row is now closed: the server-lifecycle supervisor landed as A10.** The
panel can start, stop and restart the game server, and it keeps answering while the game server does
not — which is the whole of why lifecycle could not be a route on the thing it restarts. A **separate
process** (`server/src/supervisor.ts`) owns the game server as a child and serves `/supervisor/api`
on **8790**; `supervisor-policy.ts` holds the decisions and **imports nothing**, because a supervisor
that reached into `@mygame/shared` would die of the parse error it exists to report. Crash detection
restarts on a **1-2-4-8-16 s** ladder and **gives up after 5**, with the count resetting after 60 s of
healthy uptime — without that reset the counter is a lifetime tally and a server that crashed once in
a week would be judged against restarts from the week before. Driven end to end: five kills by pid
walked the whole ladder and then *gave up*; a stop exits **code 0** in 395 ms; and with the server
down, `/admin/api/status` answered nothing at all while the Server tab answered **200 · stopped by
the operator** through the same panel origin.

**Two things it taught that are worth carrying.** The game server's `SIGINT`/`SIGTERM` flush
**cannot be reached from a parent on Windows** — `child.kill` is `TerminateProcess` there and no
handler runs — so the polite stop goes over an **IPC channel** (`index.ts` wires it when
`process.channel` exists) with the signals as escalation behind it; the exit code is how you tell
which path ran, `0` against `4294967295`. And a forced kill on Windows *reports* `4294967295`, which
is why the status card renders large codes beside their hex. `docs/DESIGN-admin-panel.md` §10 has the
rest, including why the token stays optional (the argv is fixed in the file, so no route can ask it to
run a command).

**The off hand swings now — either-hand weapons and dual wield landed as one slice**, which is what
the parking-lot row insisted on: the flag alone would have been a stat stick wearing a sword's name.
**The research overturned that row's own premise, and it is worth knowing before you touch this.**
The row assumed the second attack carries *"its own to-hit penalty"*; in the live branch it carries
none at all — `new_combat.c:2343` is `hit(ch, opponent, ch->equipment[WIELD2], …)`, identical to the
main hand's call but for the weapon argument. The price is paid entirely up front: a skill roll for
whether the hand moves (`skill > number(1, 101)`, inclusive at both ends, so `(skill − 1) / 101` and a
perfect 100 still fails one round in fifty), and a wield-time gate that only lets light blades in
there, so the second die is a dagger's. A related trap: **`PhasedAttack`, which the live round
actually calls, is declared at `prototypes.h:950` and defined nowhere in the tree** — the inline form
its own commented-out predecessor and the two live haste/blur branches all spell is the only version
of the rule the source contains, so that is what we took. `dual-wield` is a `SkillId` whose class table
is now **per class** (see the re-key below; it was folded onto four temperaments when this shipped,
which cost the rogue 5 points and handed priests a grant they never had), and **the arcane row is 0
rather than small**: no mage class appears in `skills.c`'s list at all, so `wield … offhand` refuses
them in the source's own sentence. Handedness is derived at `instantiate` from Duris' own `IS_DIRK` — dagger and short sword,
one-handed, under three slots of bulk (the bulk ceiling is `actobj.c:4918`'s strength gate carried
across as far as it honestly goes) — and it is **authorable** in both the authored-item and override
paths, which is how Windsong rides the off hand at all: she is a `weaponClass` 5 scimitar and the
automatic rule rightly declines her, so an operator says otherwise. The second blow goes through
`advanceCombat`'s existing round and the same `swing`/`landBlow` pair as the first, so there is no
second damage path to forget the ledger in. **`wield <weapon> offhand` is a suffix on the existing
verb, not a new command word** — deliberately, because the command table's order is abbreviation
priority and this needed none of it. 1,776 tests. The drive: two daggers, both blows **0 ms apart
inside a 3,200 ms round**, the second line marked `(off hand)` in cyan, and `dual wield` notching
40 → 41 off `notch_skill(…, 17)` — which fires on the *roll*, not on the hit, because the source
notches on the line above its `hit()` call and what the skill governs is getting the hand moving.

**What next, with no numbered phase left**: the parking lot's agreed rows (opening moves on the mob
click menu, whisper's room half), the **mob and worn-gear art
drawing problem** (Phase 15's tail, and the whole visual ceiling now), and the spells inheritance
(memorization times, spellbooks, penetration, globes). Two chips were open: does admin-spawn merge
authored spells, and the creation card's mid-disconnect recovery — the second is now closed, a
reconnect replaying whatever protocol 24 state the old socket held (`login.ts`'s `resumeChargen`,
decided by the pure `chargenResumeAction` in `shared/src/chargen-resume.ts`) rather than leaving the
card stuck over a dead connection.

**Phase 21 opened the same day accounts closed — designed whole, slice 1 built and driven.** The
owner took the three decisions ([DESIGN-characters.md](DESIGN-characters.md)): nine races (the
Toril seven + Drow and Duergar, racewar still excluded), the Toril core nine classes, words to
roll and numbers to play. Slice 1 landed: the six abilities folded from the live `duris.properties`
factor table, `PlayerRecord.identity` (race + class + scores, minted together, grandfathered as
`undefined`), CON/race/class on every level's hp roll, STR on the swing, DEX on AC, CHA on shop
prices — and **the shrug gate finally rolls for players**: the drive's hand-minted drow entered at
`chance=5` beside a human control at `chance=0`, after the drive caught `MAGIC_RESISTANT_RACES`
speaking only the harvest's race-code dialect and not `defines.h`'s player codes (two namespaces;
the design note's §5 correction tells it). **Slice 2 landed the same
evening**: circles open on the five-level cadence, casting debits a slot at completion
(pay-then-fizzle, the source's order), `rest` memorizes them back — the drive caught the gate
reading `status !== 'normal'` where **`resting` is a status, not a posture** (§1.3's two-axis trap,
again) — `spells` reads the book, INT/WIS size the mana pool, and the roll is **4d6-drop-lowest**
(owner's second ask). **Slice 3 landed the same night — creation is on screen.** Protocol 24: the
picker's new-name form opens race cards, class cards, then the roll in the source's words with
reroll and the five points; `charConfirm` carries the spend; a pre-identity save entered bare gets
`charAdopt` and the same cards minus the name (Weststar is now a Mountain Dwarf Cleric, level and
map kept). The HUD gained `#hud-who` — race and class under the name, the six scores as numbers on
hover. Driven whole in the browser (adoption, reroll, spend, refusals) and over the wire (fresh
mint: Brunhild the gnome cleric entered level 1 with `circle 1 — 2 of 2 castings` and a swollen
pool). The drive's catch: `Net`'s queue held `charCreate` hostage for a `welcome` it was meant to
cause — creation is handshake traffic now. 1,705 tests. **Next in the phase**: skills-by-class,
channels, sun/senses, the one quest. **The admin-spawn casting suspicion is
closed — not a bug (verified live, 2026-08-08).** A fresh server, a bot player, the drive's exact
action (`POST /admin/api/mobs {vnum: 1400}` into the spawn field, fight opened by the returned
entity id): the admin-spawned shaman rolled past its first round boundary and **opened its wind-up
on the second, burning hands for 33** — because both spawn doors read the one folded `mobTemplates`
map (`spawnMob` in `index.ts`, `templates.get` at `reset.ts:313`) and `mobStartCast` re-reads it
through `mob.vnum` on every round, so even a mob standing since before an authoring session casts
from the newest list. The drive's fifty castless seconds were the confound the note suspected:
three same-named shamans, and this template is passive with `assists: false` — a bystander twin
does *nothing* while its sibling fights, whereas fifty seconds of actual fighting without one cast
is a 1-in-65,000 run against `MOB_CAST_CHANCE` 50. Pinned so it stays true: both doors resolve the
folded list through the instance's vnum (`reset.test.ts`), and the spells fold — including a later
damage edit *not* unauthoring the spells — in `mob-overrides.test.ts`. Still true and still worth
remembering: `PlayerStore`'s cache means save-file surgery needs the server down.

**Earlier the same day: accounts and login — Phase 20b, pulled out of the parking lot exactly as
the owner ordered — and the character name law with them.** 1,680 tests (919 server / 618 shared / 143
worldgen), typecheck clean. All five slices of [DESIGN-accounts.md](DESIGN-accounts.md) §9 landed
in one day:

- **Protocol 23: `hello` is gone.** The handshake is `auth` (credentials, or a resume token) →
  `account` (your characters, the sixteen cap from `account.h:15`, a fresh resume token) → `enter`
  (pick or mint a body) → the old `welcome` burst, unchanged. `authFailed` refuses without hanging
  up — a mistyped password is not a protocol violation — and five failures hang up. One reason
  string for wrong-name and wrong-password, on purpose.
- **The store** (`server/src/accounts.ts`): scrypt via Node's own crypto, parameters riding each
  hash (`scrypt$logN$r$p$salt$key`); `data/accounts/<slug>.json` git-ignored beside the players;
  **ownership lives in the account file and nowhere else**; resume tokens in memory, seven days,
  dead on restart.
- **No email, on purpose — the admin API is the reset path**: `GET /accounts`,
  `POST /accounts/<slug>/password`, `POST /accounts/<slug>/claim`, all audited, hashes never in a
  response. The claim endpoint is what character assignment becomes the day the bind opens.
- **The door** (`client/src/login.ts`, overlay in `index.html`): credentials, then the picker —
  name, level, day, the *local* day. The tab keeps its resume token and last body in
  sessionStorage, so **F5 puts you back where you stood** and a second tab is still a second
  character. `?account=&password=` (+`&create=1`, `&character=`) succeeds `?name=` for the
  two-window flow; `GAME_DEV_ACCOUNT=name:pass` stands a dev account up at boot, announced,
  default-off.
- **Existing saves are grandfathered flotsam**: unowned until claimed, claimable only over
  loopback, refused to everyone else — so the moment the bind opens, guess-a-name-take-a-character
  is already dead. One account can hold a body; a held body cannot be entered twice; `aldric16`
  still walks with its digits.
- **The name law** (owner's rule, mid-build — `shared/src/names.ts`, its own §4 intake row):
  letters only, 2–12, `_parse_name`'s reserved list transcribed, rude roots matched through the
  evasion spellings — **`Schitthead` and `PhuckPhace` die as typed**, the owner's own examples,
  tested verbatim — and the famous of the Realms refused by exact match, Drizzt to Astarion.
  Mints only. A fence, not a wall, and the file says so.
- **The bind did not move.** Accounts-then-bind-then-tunnel is the go-live order; only the first
  word of it exists, deliberately.

**The drive earned its keep three times over** — all client bugs, all found in the browser, none
reachable by a unit test: a `display:flex` that outranked `[hidden]` so the credentials form
haunted the picker; the hands-free resume **racing Phaser's `create()`**, so the world's answer to
`enter` arrived before any handler existed (fixed by `scene.onReady` gating `enter` — the same
class of bug as the three in the list below, and the same lesson: *if you change the join path,
drive it*); and an auto-enter refusal writing its reason into a panel that was hidden. One wire
find besides: a character minted this boot listed as its lowercase slug until `PlayerStore.nameOf`
let the picker read the live cache before the disk.

**Next, by the cadence**: unchanged — **Phase 21 (classes, races, quests, channels) is the last M
standing**, and accounts no longer block it; its remaining prerequisites are the ability-score
half of 14b and the race-list decision the racewar exclusion forces (the account file already
leaves room for `acct_good`/`acct_evil` and the one-hour switch timer, `account.c:940`). Track A's
biggest row is the **server-lifecycle supervisor**; Track V still holds only the bubble cap loose
end and the mob-art *drawing* problem.

### Before that — the marathon of 2026-08-07

**Rounds 12 and 13 closed in one day, Phase 19 with them — and then Phase 20, whole, in the same
day: 23 of 25 phases.** 1,637 tests (901 server / 599 shared / 137 worldgen), typecheck clean. The
day's landings, newest first:

- **Phase 20 — spells, all six slices, designed and built 2026-08-07** (six table rows): the tick
  drains the scheduler and routes by kind (slice 1, the design note's mandatory first commit); the
  wind-up you can watch and break (slice 2 — the beat *is* the interruption system); the registry,
  the two gates and mob casters (slice 3 — save-then-shrug in the damage order,
  `MobTemplate.spells` as live-authorable content); `recite` (slice 4 — the classless path, 135
  scrolls harvested, the scroll burnt whether or not anything answers); heals and buffs (slice 5 —
  the first affect-borne `ac`/`hit`/`saves` nodes, `joinBySupporting`'s second producer, **protocol
  21's exact group pools**, mobs that heal themselves); and areas (slice 6 — earthquake's bespoke
  loop with its bystander knockdowns, ice storm through `should_area_hit` and the players-only
  thinning, mob areas that cannot catch mobs). **The kobold shaman ships casting magic missile,
  burning hands and cure light.** The slice-3 drive found one bash silencing a caster permanently —
  `mundane_autostand` transcribed; see its own row. What Phase 21 inherits is recorded at the end
  of `DESIGN-spells.md`: the memorization economy, class circle tables, spellbooks, ground-casting,
  penetration, globes.
- **`swim` — Phase 19's last slice, and the phase's fifth dead mechanism closed it** (see the table
  row): deep water priced not gated, boats exempt, exhaustion drowns, the drowned wash ashore at
  their **entry** shore (the ferry rule), WASD/click crossings finally pay the typed step's bill, and
  **The Sunken Stair ships flooded and loaded** — the game's first swimmable water.
- **A8d — a zone from nothing** (round 13's A): the seventh overlay, the origin-room exception, and
  *The Sunken Stair* itself as the drive that then became content.
- **`look <direction>`** (round 13's V): the farsee finding, the far room's light as the gate, counts
  as the tactical information.
- **Phase 19 slice 4 — `rescue`**: one attacker peeled onto you, the grudge transferred on the threat
  table, `joinBySupporting`'s first caller, and the notch that runs backwards on purpose.
- **The A7g quality sweep is complete**: `npm run artsweep` re-decided **all 8,078 fallback art
  guesses** with qwen2.5:14b against each slot's closed candidate list — **7,090 changed, 938
  confirmed** across the two runs (the F: dismount split it; `by: 'artsweep'` is the resume marker
  and 800 were banked mid-flight), 50 unreadable answers kept their fallback for a future re-ask, 31
  colours dropped where the new sheet cannot wear them — and colours that *could* cross did:
  *"silver-plated arm plates"* went to `arms-bracers#all_lpcr.silver`, sheet and ramp both. The
  flagships all landed: stiletto **rapier**, butcherknife **dagger**, platemail of BloodLust
  **plate**, steel arm plates **arms-armour**. Calibration said trust it: where model and word-matcher
  disagreed, the word-matcher owned most of the embarrassments (an apron for studded leather, a
  bodice for a combat vest, a farm tool for a notched axe).
- **Small and driven**: `inventory` carries / `equipment` wears (owner's report, Diku's own split); a
  mob near a portal no longer steals the click on it (distance contest, bodies win only real ties); a
  bystander's dodge line reads in the third person.
- **The morning was a drive-letter swap** — the Sett is `D:` again; see *Where the project lives*.

**Next, by the cadence**: **Phase 20 closed 2026-08-07 — round 14's M is done, and Phase 21
(classes, races, quests, channels) is the last M standing** beside Track A's remaining rows and the
mob-art drawing problem. Phase 21's own prerequisites are already parked in the roadmap: **accounts
pulled early** (the most misplaced row on the schedule — see the parking lot), the ability-score
half of 14b, and the race-list decision the racewar exclusion forces. (The shrug gate still has no
live path — players are raceless and mobs do not cast at mobs — its first real workout arrives with
MR-race player targets in Phase 21; the arithmetic is pinned by tests.) The mob editor grew its
**casts** row the same day — one checkbox per registry spell, kind-labelled, verified against the
live panel with the shaman's own kit — so the `spells` field is authored the way every other field
is, not by curl. Track V has no numbered item left — the bubble cap loose end and
the mob-art *drawing* problem are what remain. Track A's biggest remaining rows are the
**server-lifecycle supervisor** and the post-Phase-21 editors (the mob editor also wants a UI for
the new `spells` field — API-only today); §2b says a track with nothing unblocked skips. The
**corpse-retrieval-fee / ferryman** economy idea is placed at Phase 21. The owner re-affirmed
2026-08-07 (going to sleep, work continuing): **accounts/login** stays the most misplaced row on
the schedule (see the parking lot — pull it early), and the 3D port stays *thinking-only* —
[PLAN-3d-migration.md](PLAN-3d-migration.md) is the thinking, and everything current is the proof
that the mechanics survive it.

### Before that — the evening of 2026-08-06

**`main` at `abd3d90`, tree clean, 1,539 tests green** (854 server / 570 shared / 115 worldgen).

**Read the combat regression row first.** Phase 19 slice 2 shipped earlier the same day with *every blow
missing* — `swing` tested `rollDefence`'s wrapper instead of its `defended` field — and it survived a
drive because the tally said `{miss: 40, parried: 1, dodged: 2, …}` and **nobody read past the two words
they went looking for.** Fixed, with a test that runs the loop the way `index.ts` runs it. The reusable
part is the habit, not the line: *when a drive shows what you went looking for, read the rest of it.*

**What landed today, newest first.** The whole A7 art thread closed — **A7e** recolour (render-time, not
staged), **A7f** colour from a description (name first, model only as fallback), **A7g** art for all
13,248 slotted items, **A7h** colour for 361 items across 49 zones. Track A's mob work closed too —
**A9** editing, **A9b** creating, **A9c** placing in a zone so a made creature repops and survives a
restart. Plus `get <item> <corpse>`, and **Phase 19 slice 2** (dodge and parry).

**Three things to pick from tomorrow, cheapest first.**

1. **A7g quality, surfaced by A7h.** *"silver-plated leg plates"* correctly wears `legs-armour` (metal)
   while *"arm plates"* wears `torso-clothes-longsleeves` (cloth). The colour pass reads as a review of
   the art pass, and there are likely more like it — worth a sweep of the 8,077 fallback assignments
   before trusting them. Cheap, and the panel is the tool.
2. **A8d — a zone from nothing.** The largest remaining Track A piece; three cases A8's rules cannot
   express, all written up in the roadmap entry.
3. **Mob art.** The cheap half is done — `race` is now on all 1,503 templates and 289 of them stopped
   saying *hit*. What is left needs **drawing**, not code: LPC ships no non-human body, so a kobold looks
   like a man until somebody makes a kobold. See the reference-image and ComfyUI rows for the pipeline
   that was designed but not built.

**Machine note.** The Sett drive is **D:** again — the owner reversed 2026-08-06's letter shuffle on
2026-08-07 (the interloper HDD is `Z:` now). Everything that had been repointed to F: was repointed
back: both backup chains and `sitrep.mjs` in `E:\ClaudeDen`, `OLLAMA_MODELS` (→ `D:\ollama\models`),
and this file. `MyGame` lives at **D:\MyGame**; see *Where the project lives* for the worktree-repair
and npm-install consequences.

### Before that — round 9 is closed, and Phase 18 with it (2026-08-06)

**Grouping landed 2026-08-06**, so **Phase 18 is done** — 21 of 25 phases — and round 9 has all three
of its slots: V5 the arrival cards, Phase 18 (following, then grouping), and A4c. See the table row for
what it settled; the composition of the group bonus with our contribution split was the owner's call
and is written down in three places (`experience.ts`, the row, `ROADMAP.md`).

**A7d-bag landed 2026-08-06** — see the table row — so **what is left in Track A is A7e/A7f**, plus the
three items placed below. A7e starts colder than it did: five measurements were taken on 2026-08-06 and
written into its roadmap entry, including that the field is `recolors` rather than `palettes`, that the
source ramp is named in each family's own metadata (`meta_cloth.json` carries `"base": "white"`), and
that **`metal` declares a base and ships no palette files at all** — so an art can declare recolours that
resolve to nothing. The entry also records an architectural note worth weighing before code: the parking
lot assumed a server-side recolour staging a new PNG, which needs a decoder and encoder the project does
not have, while the pack itself recolours at render time and our client already reads pixels back off a
loaded texture. Track V is complete, so round 10 has no visual slot to fill and §2b says a track
with nothing unblocked skips its turn rather than inventing work.

**Round 11 is closed**: A6c filled the admin slot, `bash` and `kick` the mechanic slot, and Track V skipped
its turn (V1–V7 are all done, and §2b says a track with nothing unblocked skips rather than inventing work).

**A correction, and it retracts two notes this file carried earlier today.** Both claimed a bug in how a
client learns what is in a room — that an admin teleport left `visible` stale, and that no entity reached
the client on arrival. **Neither is true.** They were diagnosed with a probe that listened for
`entityEnter` and never read the message the server actually uses: `describeRoom` sends the room's
occupants **inside the `room` message** (`view.entities`), which the client replaces its entity list from
wholesale, and `entityEnter` exists only for things that arrive *afterwards*. Measured with a corrected
probe: on login the room view lists *the kobold shaman*, and after a **bare** teleport — no light patch,
nothing forcing a recompute — it lists *three kobold youths*. The light patch that appeared to "fix" it was
only making `applyRelight` emit the one message the probe was watching for.

**The lesson is the reusable part**, and it cost four drives: a socket probe must read the room view, not
just the entity deltas — `{ t: 'room', view: { room, entities, adjacent } }`. The two suspicious signs were
both visible at the time and both misread: the *server* resolved `bash kobold` against a mob the probe
claimed was not there, and `visible` measured correct (81 tiles on the lit spawn field, 162 after a
teleport into a second lit room). When the server can see something the client "cannot", suspect the
instrument.

**Round 11 was, as it was open:** — V1–V7 are all done, and §2b says a track with nothing
unblocked skips rather than inventing work. **A6c filled the admin slot** (see the table row). The mechanic
slot is Phase 19's next slice, and the design note now says which one and why: `bash` and `kick` are the
cheap-looking pair whose *crux* is a shared `landBlow` — damage, the contribution ledger, threat and death
all live inside `advanceCombat`'s swing loop today, and an ability that applied damage itself would be a
second damage path (a mob dying without paying experience, a bash that kills leaving no corpse). So the
first commit there is extracting that seam with **no behaviour change and the existing combat tests as the
proof**; Phase 20's spells need the same one. `DESIGN-skills.md` §8.3 carries the source's specs — bash sits
the victim down and lags them a round while the basher takes a two-round self-lag, kick lags its user 1.5
rounds, and a successful notch *forces* the blow to land.

**Round 10's mechanic was Phase 19, skills, and its first slice landed 2026-08-06** — see the table row.
What is left of the phase is four slices, and the next one is not really a skill problem: `dodge` and
`parry` are notched on the **defender** in the source (17 and 25), and both need an *active defence roll*,
where our AC is passive. That is a combat change with its own drive.

**The light redesign is built** (owner, 2026-08-06) — all three rows; see the two table rows above for what
each settled. In short: a light costs nothing and lights you from anywhere, 95% of the world lights itself,
and a new character still starts with none — which is what makes the first torch a key rather than a tax.
`DESIGN-inventory.md` §6 carries the reversal in writing. What remains of the design is the part that needs
a clock: Duris' twilight, magic light and dark, and the sector rules that turn on `IS_NIGHT`.

The three rows as they were placed:

- **A light costs nothing: no hand, no slot, no bulk.** It lights you from wherever it is — worn, held or
  in the bag. **This contradicts `DESIGN-inventory.md` §6 by name** (a light nobody holds is *free light
  for ever*), so §6 must be rewritten in the same commit rather than quietly bypassed. The measurement
  that made the old rule untenable anyway: `LIGHT_BEARING_SLOTS` is hands only, which leaves **11 of the
  64 harvested lights unable to work at all** — 5 glowing earrings, a set of golden horseshoes, and 5 with
  no wear slot.
- **Rooms that are naturally lit, and this is the half that makes the above right.** `'dark'` is a room
  flag we harvest and **its only appearance in the codebase is its own declaration** — nothing reads it,
  so every room in the world is treated as pitch black. Measured: **2,283 of 46,508 rooms carry it,
  4.9%**, so Duris' builders marked **95% of the world naturally lit**; in the loaded zones it is 41 of
  IceCrag's 219 and 37 of the Kobold Settlement's 99. Transcribe the **flag half only** — Duris'
  `IS_TWILIGHT_ROOM` also has twilight, magic light/dark and sector rules that depend on `IS_NIGHT`, and
  there is no clock. The machinery exists: a `rooms`-mode light already lights a whole room, so the room
  becomes a light source rather than a special case, and fog, `seen` and the click gate follow for free.
- **A new character starts with no light.** Already true since Phase 5 and recorded so nobody "fixes" it
  by handing out a torch. What is wrong today is that the bare 5×5 eye applies *everywhere*, so an open
  field at noon reads like a sealed crypt.

**Three more were placed on 2026-08-06 and not built** (owner), and two of them are cheap:

- **Looking at a corpse should list what can be taken from it.** A refinement, not a phase — the same
  shape `loot`-targets-the-nearest was. Every piece exists: `Corpse.contents` since 15b, and 15c's
  `look <container>` listing to copy. The one decision: it goes on **`look`**, a deliberate act aimed at
  one body, and *not* on the entity feed — V2's target menu deliberately says *is a container* rather than
  *what is in it*, and a corpse is the opposite case because a mob's kit **is** the reward. It must list
  the **visible subset** from the first version, or the hidden-item work below changes what it promised.
- **Hidden items you find by searching a corpse.** The source has all of it — `search` is a real command
  (standing, refused in combat), `do_search` covers containers and corpses, hidden is `ITEM_SECRET`
  (`BIT_13`), and the reveal is `find_chance`: `(INT + WIS + LUK) / 3 > number(1, 101)`. **That roll is
  the blocker: there are no ability scores.** Either wait for them, or ship a flat placeholder chance and
  swap the roll in — the owner's call. `ITEM_SECRET` is not harvested today.
- **Attack verbs — V7, and the data landed the same day it was asked for.** *"You slash the kobold"*
  rather than *"You hit"*. `attack_hit_text[]` is Diku's own eleven-type table and `get_weapon_msg` picks
  from `value[0]` — the `weaponClass` Phase 19 harvested hours earlier — so the weapon half is a lookup
  and a sentence with **no protocol change**. Six verbs: slash, pierce, crush, bludgeon, whip, hit. **Do
  not merge it with Phase 19's grouping**: hammer and mace share one *skill* but split into crush and
  bludgeon as *prose*, and a polearm is `reach` for skills and always slash here. The mob half wants one
  more harvested field (`npc->attack_type`) or every clawed thing punches.

**And three placed earlier the same day** (owner): **create a new zone from the
panel** (A8d — it is A8's next question rather than a repeat: an authored zone id from a reserved base, a
Place with no rooms and therefore no extent for the first room to be placed in, and `world.config.json`
being deliberately *data*), **edit and create mobs** (A9 and A9b — the overlay A4c built for loot already
holds half of it, and an edit is per *template*, so it changes every instance the world spawns and none of
those already standing), and **quest authoring**, which was already placed: Phase 21 defines what a quest
is, then Track A gets the editor, exactly as A5 followed rooms and A6 followed items.

**The note that opened the phase, for the record** —
[DESIGN-skills.md](DESIGN-skills.md), 2026-08-06, six decisions and a five-slice build order. It was
written first for the reason A8's was: **three of the six turn on which branch of the source is
compiled**, and the research found two places where our own documents cite code the shipped game does
not build. `NEW_COMBAT` is defined, so `fight.c`'s weapon-skill path is dead and the live mapping is per
*weapon type* — 18 skills over 2,841 weapons, measured and tabulated. And `wipe2011` is defined nowhere,
so `notch_skill` writes a cooldown affect that **nothing in the source ever reads**: the roadmap's
"per-category rate limits" are an intention, not shipped behaviour, and the note decides to run the dead
branch on purpose (without it, 6.7% of hits notching at a 3 s round maxes a skill in 25 minutes).
`REFERENCE-mud-mechanics.md` §1.6 now carries the correction rather than the old citation. **Slice 1 is
startable cold**: harvest `weaponClass` (worldgen parses it today and throws it away), a pure
`shared/src/skills.ts`, the notch on a landing blow through the seeded RNG, the cooldown as an ordinary
Phase 5b affect, a `skills` command, and `floor(learned / 10)` on the attack bonus — with the
rounds-to-kill measurement §5 asks for before it is called done.

**Three things this session found and did *not* fix**, each cheap and each recorded here because they
will otherwise be rediscovered:

1. **The power-levelling wall only applies inside a group.** It is measured over the contributing
   members *of a group*, which is where Duris measures it — so two characters 40 levels apart who
   fight together **without** grouping are unwalled, and the low one earns a full contribution share.
   The hole is older than this phase (contribution has paid strangers since Phase 13) and closing it
   means changing what an *ungrouped* kill pays, which is a decision, not a patch.
2. ~~**An admin teleport can leave a character's `visible` set describing the room they left.**~~
   **Retracted 2026-08-06** — there was no such bug. See the correction in the *start here* section: the
   drive probe was reading `entityEnter` and ignoring the room view, which is where a room's occupants
   actually arrive. A teleport tells the client exactly what is there, with nothing forcing it.
3. **A death prints two lines.** *"X is dead!"* comes from the blow that drops the body (`index.ts`
   around the engagement break) *and* from `resolveDeath`, so an onlooker reads it twice. Pre-existing,
   harmless, and one of the two is redundant.

### Before that — round 9 opening, and Act VI (2026-08-05)

**All three A8 slices landed 2026-08-05** — infill, deletion, and extent changes — so **Track A's
largest piece is closed** and round 7 is complete on all three of its tracks. See the three table
rows for what each settled.

**Round 8 is under way**, and the cadence (§2b) wants one of each kind:

- **Visual: V4, Places as a graph** ✅ **done** — see the table row.
- **Mechanic: the owner's two 2026-08-05 ideas, placed in `ROADMAP.md` §4 and not built** —
  **dropped-item decay**, whose real cost is not clutter but the `O` reset census (floor objects
  count against a vnum's world-wide limit, so a room of discards holds a zone's repop at ceiling),
  and **a `junk` verb with a confirmation**, which the source already has as
  `CMD_CNF_N(CMD_JUNK, …)` along with a general per-connection confirm mechanism it uses for exactly
  two commands. They are one conversation about how a thing leaves the world.
- **Admin: A4c** ✅ **done** — see the table row. What is left in Track A is **A7e/A7f** (recolour
  from a named palette ramp, then Ollama picking it — 424 of 657 ULPC sheets already declare
  `palettes`) and **A7d-bag**.

**The drives left nothing behind.** Every room built across the three slices was removed again, the
one harvested room removed to prove the orphan report (41300, The Pantry) was restored by clearing its
tombstone, and the explored maps cleared along the way were re-walked. `rooms-authored.json` is
therefore empty **except for `next: 1000004`**, which is not noise: it records which ids have been
handed out, and the counter must never hand one out twice even though every room is gone. Deleting the file would reset that.

**Two ideas were placed in `ROADMAP.md` §4 on 2026-08-05 and not built** (owner): **dropped items
should decay**, whose real cost is not clutter but the `O` reset census — floor objects count against
a vnum's world-wide limit, so a room full of discards quietly holds a zone's repop at ceiling — and
**a `junk` verb with a confirmation**, which the source already has, `CMD_CNF_N(CMD_JUNK, …)`, along
with a general per-connection confirm mechanism it uses for exactly two commands.

### The rest of round 7 (2026-08-05)

Round 6 closed on all three tracks — A7c the art picker, **Phase 16** (light from what you hold,
craftsmanship on AC, encumbrance, water you cannot wade into), and **A4** (repop, doors, live mob
instances, slay, spawn). Round 7 has since landed **V3, speech in the world** and **Phase 17,
shops** — which closes **Act V**, and with it every numbered phase up to Act VI. Three smaller pieces
went with them: **whisper**, **A7d floor icons**, and the **icon crop** that followed from it.

**A8, zone geometry** was what round 7 had left — the last big piece of Track A, and the one A5
deliberately refuses because id, position and exits are the join key and the grid. **Its design note
is the thing to read first**: [DESIGN-zone-geometry.md](DESIGN-zone-geometry.md), 2026-08-05, all
five of its problems decided and measured. It picks a build order whose **first slice cannot
invalidate anybody's explored map** — authored rooms *inside* a Place's current extent — and **that
slice is now built and driven**. Its other two remain.

**V4, Places as a graph** opened round 8 and is done; **Phase 18, following and grouping** opens Act VI.

Three smaller things are unblocked and cheaper than any of those:

1. **A7e — recolour, then A7f — Ollama picking the ramp.** Both specified in the parking lot **with
   the measurements**, so they start cold: ULPC ships the whole palette system, **424 of 657**
   definitions declare `palettes`, and cloth alone has **24 named ramps** — so *"a fiery red cloak"*
   is `cape-solid` plus ramp `red`, a generator step rather than a paint program. A7f is
   classification over a closed vocabulary, which is what a small local model is good at, and it is
   §8's rule again: the model drafts, the human commits.
2. **A4c — loot on a mob** (owner, 2026-08-04: *"assign items to mobs as loot"*). A4 built the live
   half; this is the authoring half and needs a **mob overlay** first, the same shape
   `items-authored.json` gave items. Note the thing to say out loud before building it: kit is per
   *template*, not per instance, so authoring it changes every kobold guard the world spawns.

**One loose end left, not blocking.** The newbie spawn room (41260) still holds a level-23 kobold
shaman that answers to `kobold`; it is passive, so the hazard is a level-1's first `kill kobold`, not
aggro. (`itemRow` omitting `art` was the other, and A7c closed it.)

**One thing Phase 16 did not build, deliberately.** A finite held light's burn is on its **affect**,
not on the item, so it is not per-instance: take a half-burnt torch off and put it back on and the
clock restarts. Fixing it means a `burnMs` on the persisted `Item`, which is the reader-line trap in
the gotchas below — every field of a persisted shape needs a reader line and a whole-value round-trip
test — and it deserves that pass rather than a line here.

**Twenty-one of 25 phases done — Acts I–V complete and Act VI opened.** What is left of Act VI is skills, spells,
and the content layer. **Track A** has landed A2, A3, A4, A4b, A5, A6, A6b, A7a, A7b, A7c, A7d and
**all three A8 slices** and **A4c**; what is left there is A7e, A7f and A7d-bag.
**Track V** has V1, V2, V3, V4, V5 and V6 — the track is complete. Round 1 is complete: **V1 the combat feed** (the `combat` channel now
renders *only* in its own section of the character pane — the owner's split: prose and speech on the
left, violence on the right) and **Phase 14, mercy and fear**.

**Round 1 is closed** — A2 landed with it: messaging to the world, a Place or a room, and the
dedicated `announce` channel that took **protocol to 10**. `system` is the machine's voice; an
operator's is a person's, and a client that cannot tell them apart can style neither.

**Rounds 1 and 2 are both closed.** Round 2's mechanic slot went to **Phase 14c, the fight moves
with you** — pulled ahead of 14b at the owner's word, because it and V2 are companions — alongside
**V2 (click a body, get its verbs)** and **A3 (zones, read-only)**.

**Round 3 ran long and out of order, and both A slices are done: A4b (the map) and A5 (authoring).**
V6 took the round's visual slot ahead of V3, because A5's prose editor *is* a colour editor and
building the palette before the renderer would have been guesswork. What is left in the round is
**Phase 14b (a character worth keeping)**; **V3 (speech in the world)** and **V4** slid a round
rather than being dropped.

**The zone editor was under-scoped, and the owner called it (2026-08-02.)** A3 shipped a read-only
*browser*; what is wanted is a **complete editor** — see the zone, select rooms on it, add and
remove them. Split three ways in `ROADMAP.md` because the costs are nothing alike: **A4b** the
visual map ✅, **A5** field editing driven from that map ✅, and **A8** geometry. Two of the three
are now done, and what is left is the expensive one. A8 needs a design note before code, and its
sharpest problem is not the room graph: **resizing a zone's grid invalidates every saved `seen` map
for that Place**, so adding one room outside the current extent would quietly wipe explored maps.

**Two things A5 found that are worth not rediscovering.** First, the world data had never been
rebuilt after V6 — the code kept the Duris colour codes and the JSON on disk still had them
stripped, so nothing was coloured in game until `npm run worldgen` ran again. **A code change to
worldgen is not visible until the world is regenerated, and in a worktree the result has to be
copied across.** Second, `data/world/` was git-ignored wholesale, which would have sent every
hand-authored room to a fresh clone's oblivion; the ignore now carries a negation for
`data/world/overrides/` and nothing else.

**What death costs, and progression generally, are Phase 14b** — promoted from ROADMAP §4's parking
lot onto the schedule (round 2). Its storage half already arrived early (see progression above);
what it still owns is the *derivation* — ability scores, hit dice, a way to earn a level — and the
decision about what dying takes from you.

**Have an idea?** `ROADMAP.md` §4 places it — do not append it to the end and do not build it now.

### Just landed: Phase 14, mercy and fear

`shared/src/morale.ts` holds the numbers, `server/src/flee.ts` the attempt. **A fight can now be
left** — until today, leaving one meant winning it, dying, or closing the tab.

- **One `do_flee` for players and mobs**, as the source has it: the player's `flee` command, a mob
  whose nerve broke, and (later) any spell that makes something run all reach the same function.
- **§4.7's trap, transcribed rather than assumed.** `wimpy` does *not* mean auto-flee, and on a
  player it never did — it suppresses your own auto-engagement while hurt. Only `ACT_WIMPY` mobs run,
  below `level * 6` hit points. There is no player wimpy setting and there will not be one.
- **The threshold is absolute, not a fraction of maximum**, which is a divergence from
  `DESIGN-mobs-and-movement.md` §2.8's wording and the right one: hit points are rolled per instance,
  so a fraction would break two guards of one vnum at different wounds.
- **A cornered coward is not a harmless one.** A failed attempt spends the round *and* swings, so
  blocking the only exit is not a way to switch a mob off.
- **A mob that can path flees toward its allies** — §2.8's rule, and the predicate is `pursues(rule)`
  rather than a stand-in for the intelligence the simple `.mob` record lacks: fleeing toward allies
  *is* a room-graph search. `firstStepToward` was generalised into `firstStepWhere` for it.
- **Fleeing escapes the blow, not the encounter.** Whatever you fled begins a hunt. Measured: Malice
  arrived one room behind, 1,731 ms later.
- **Third wire-level bug of the same kind.** Departures read "Someone flees west!" because `canSee`
  tests the subject's *tile* and the body had already moved. Who could see it has to be snapshotted
  before the move. `index.ts` still has no test harness; that is still the reason.
- **`loot` now takes the nearest unlooted corpse** — the owner's request, riding along.

### Before that: Phase 13, death and corpses

`server/src/corpses.ts` holds the corpse, `shared/src/experience.ts` the division rule.

- **Experience is divided by contribution, not handed to the last hit.** Damage **dealt**, damage
  **taken**, and support given are three separate ways to earn a share — which is what makes tanking and
  healing viable with no role system at all. Damage taken is worth exactly as much as damage dealt.
- **The pool is harvested** from the `.mob` record's own field: 1,036 for a level 15 servant against
  243,000 for Malice. Any formula invented here would have flattened a builder's tuning into
  `level * something`.
- **`groupDivisor` is written and unused**, on purpose. §4.4 is emphatic that `exp / N` makes solo play
  optimal and stops the social layer forming; Duris uses `(N + 3) / 4`. Grouping is Phase 18.
- **A corpse is a place, not a body.** The dead actor leaves the simulation entirely, so nothing else
  needs an "is this one dead" guard. It lies where it fell.
- **The looted state is visible** — a pile of bones, and a single bone once gone through. Generated in
  code, because the vendored LPC set has no bones and `CLAUDE.md` requires what LPC lacks to be drawn to
  match rather than borrowed.

### Before that: Phase 12, threat and the room that comes to help

`shared/src/threat.ts` holds the table and the margin; assist lives in `server/src/combat.ts`.

- **The one deliberate divergence from Duris.** The source has no threat table — `PickTarget` takes the
  *weakest* body in the room. That cannot produce tanking, so §2.7 chose a threat table. **Both rules are
  kept**: weakness picks who a mob opens on, threat governs every switch after.
- **110% hysteresis**, and it is the mechanic rather than a refinement. Verified live: two identical
  level-35 characters, and the sentry held the one who started first.
- **A mob fights its aggressors and nobody else.** Start a brawl, go down, and it does not round on the
  bystanders — but anyone who waded in is on the table and the fight carries on with them.
- **Support is participation, and it is a separate fact from threat.** A healer contributes no damage and
  is every bit in the fight; a rule keyed on damage would have a mob walk away from the person who kept
  the party standing. An entry may legitimately sit at zero. `joinBySupporting` is the seam Phase 20's
  spells call.
- **Assist is room-scoped**, which is `find_protector_target`'s own limit. The cross-room cry for help is
  `ACT2_COMBAT_NEARBY` — a second action word the simple `.mob` record does not carry, the same wall
  `ACT2_NO_LURE` hit in Phase 10.
- **Live testing found a bug no unit test would have**: retargeting ran only inside the swing loop, so a
  mob whose target disconnected had no swing scheduled and stopped fighting entirely, standing in a room
  with somebody still hitting it. There is now an explicit pass for it.

### Before that: Phase 11, blows land

`shared/src/combat.ts` holds the statistics, `server/src/combat.ts` the engagement and the round,
`server/src/scheduler.ts` the queue that drives it.

- **There is no distance check anywhere in `combat.ts`, and that is the point.** Engagement is a pointer:
  once two actors are engaged, blows land wherever in the room either stands, and the only way out is an
  event. `DESIGN-engagement.md` §8 is explicit that writing `if (distance <= reach)` into the first attack
  handler silently chooses action-RPG combat and collapses threat, tanking and rescue with it.
- **The round is per actor** (`Actor.roundMs`), never the global `ROUND_MS`. A fast actor genuinely
  interleaves swings between a slow one's — §4.1's warning, and the thing that is near-impossible to
  retrofit.
- **Mercy is a player's protection; a mob fights to the death.** A downed character enters the dying
  window and everyone targeting them stops. A mob has no such window: it stops being a target only when
  dead, or it would stand at −4 hit points that nobody may finish.
- **A body that cannot defend itself is never missed.** The die is still rolled and still printed, but it
  cannot produce a miss and a natural 1 is not a fumble.
- **Two of the three `.mob` combat columns are trustworthy.** The hitroll is `fscanf`'d and immediately
  overwritten from level in `db.c`, so it has been ignored since 1995 and is often negative on the best
  fighters. Armour and damage are real; armour is flipped from AD&D-descending to ascending SRD.
- **The dying window was nearly dead code twice** — once by clamping damage at 0 hit points when the
  thresholds are negative, once by having no mercy rule at all.

**Testing switches, default-off and announced at boot:** `GAME_DEV_LIGHT=glowing_ring_of_testing` lights
the room and its neighbours, `GAME_DEV_LEVEL=35` gives a survivable profile, `GAME_DEV_DAMAGE` overrides
the weapon. Without them a level-1 character survives IceCrag for about six seconds. **A test rig, not a
progression** — the real work is in `ROADMAP.md` §4.

### Before that: Phase 10, it follows you

`shared/src/pursuit.ts` holds the rule, `server/src/hunt.ts` the chase. A mob that has noticed you now
comes after you through the map.

- **Two layers, kept apart on purpose.** The **room graph** decides which exit (a BFS, which is
  `find_first_step`'s own shape); the **tile grid** moves the body there, through the same `stepMovement`
  and collision a player uses. A pure tile-space chase would walk through a sanctuary, because tiles do not
  know what a room is; a pure room-graph hop would teleport a body between room centres.
- **A hunter is faster than you.** `PULSE_MOB_HUNT` is 6 pulses at 0.25 s = **one room per 1.5 s**, against
  ~2.4 s for a player to cross one. You cannot walk away from a chase — doors, distance and the edge of a
  Place are the counterplay.
- **§4.11's flag traps are all honoured and all tested.** `ACT_HUNTER` is inert without `ACT_MEMORY`;
  `ACT_SENTINEL` is a *zone leash* and not immobility; `no_mob` and `safe` rooms are cut out of the search
  so a hunter routes around them rather than piling up against one.
- **Found a live ordering bug no test could.** The arrival line is gated on `watching`, which
  `syncEntities` does not update until later in the same tick — so announcing when the hunt advanced
  printed nothing at all, and the mob walked in silently. Second wire-level bug in two phases, same root
  cause: `index.ts` starts a server on import, so none of it is unit-testable.
- **`entityMoved` now carries actors, not players.** Before this it was built from the simulation's
  players-only `moved` list, so nothing a mob did could be drawn. `syncTurn` had found the facing half of
  the same hole in Phase 9.

**The sanctuary clause came out of the Seen-when, for the third time and the same reason.**
`respectsSafeRooms` is built and tested, but `safe` is set on **exactly one room in the shipped world** —
Grumbiter's Inn, in a zone that is not populated — because Duris sets `ROOM_SAFE` on 11 of its 781,053.
Authoring sanctuaries stays scheduled where `ROADMAP.md` §4 already put it: after this phase.

### Before that: Phase 9, it notices you

`shared/src/aggression.ts` holds the predicate, `server/src/perception.ts` the timer. A mob turns toward you
and says so; it cannot attack, because engagement is Phase 11 and `DESIGN-engagement.md` requires the first
combat code to make stickiness explicit rather than grow out of something adjacent.

- **Aggression is a predicate over *you*, not a boolean on the mob.** Duris carries three 32-bit words of
  `AGGR_*` bits and `IS_AGGRESSIVE` is merely "any of them is set", so whether a thing attacks you is a
  question about your race, alignment and standing. Only `all` is evaluable today, and `matchesAggro`
  **refuses a clause it cannot evaluate** rather than defaulting one — so a mob that objects to elves objects
  to nobody, which is honest, because nobody is an elf until Phase 21.
- **The reaction is the mechanic.** The timer is re-validated **when it fires**, against the world as it then
  is, and the dwell is discarded the moment you leave perception — so two half-visits never add up to one
  noticing. Verified live: **1315 ms** measured against 1300 ms authored, and **561 ms** inside the room left
  it none the wiser.
- **Noticing is an edge, not a threshold.** Only the tick that *crosses* the reaction counts. Testing `>=`
  re-notices every tick; clearing the timer to avoid that re-notices once per reaction period forever. My own
  test caught the second version — 3 extra events over 30 ticks.
- **Perception is not light-gated, deliberately.** A guard in a hall it has stood in for years is not blind
  in it; you are the one carrying a torch. Its reach is 6 tiles, your bare sight is 2 — so it sees you first,
  and creeping past unseen is what stealth is for (Phase 19).
- **It found a wire bug the unit tests could not.** `syncEntities` is a *membership* diff and the tick's
  `entityMoved` batch is built from players who moved, so a mob that merely **turned** was never transmitted
  to anyone already watching it. The turn is half of what this phase was supposed to make visible. Fixed with
  `syncTurn`; the reason it went unnoticed is that **there is no wire-level test harness** — `index.ts` starts
  a server on import — and that remains true.
- **The live probe needed a control to be worth anything.** Because the mob *remembers*, "did it notice me"
  is observable exactly once per character, so the first dip test passed for the wrong reason: the sweep that
  found the mob had already put the prober inside its reach. The rebuilt probe dips across the **room
  boundary** — `perceives` gates on room before distance — and finishes by standing still, which must produce
  a notice.
- **Reaction time is a stand-in.** Duris derives it from agility, which lives on the *enhanced* `.mob` record;
  every mob in the loaded zones is the *simple* form. Level substitutes: 2500 ms base, −20 ms/level, 800 ms
  floor, and the floor is chosen so the sharpest mob alive can still be run past.

**Locked doors stopped locking, and it is worth knowing why before it surprises you.** Honouring the authored
locks left **25 of IceCrag's 219 rooms** reachable — the castle's front door is closed *and locked* by its
zone's very first reset command, and all 13 aggressive mobs are behind it. Across the shipped world **42 of
156 doors are locked and none carries a `keyId`**: worldgen has never harvested key ids, so there is no object
to find even in principle, and nothing can be carried (Phase 15) or picked (Phase 19). `LOCKS_HOLD` in
`server/src/world.ts` is therefore `false`, applied at load *and* in `resetDoor` — the second one matters,
because a repop 75 seconds later would otherwise re-seal the castle. Doors still shut and still have to be
opened; the route to Malice opens five.

### Before that: Phase 8, a populated world

IceCrag has 92 inhabitants where its builders put them, and they come back on their own schedule.
`worldgen/src/mobs.ts` harvests, `server/src/reset.ts` executes.

- **Reset only loads. Nothing despawns.** Population converges because per-vnum limits block
  over-spawning, and the limit is counted **world-wide** — so a mob lured three zones away still counts,
  its replacement does not appear, and what you dragged away stays dragged away. §4.9 is a warning about
  getting this wrong and it is the whole mechanic.
- **The hard part was that reset tables name rooms by *Duris* vnum.** Phase 3's name-join supplies the
  pairs but not uniqueness: 116 of IceCrag's 216 joinable rooms share a name. Duplicated names are
  **paired positionally**, justified by measurement — of the 37 duplicated names, **all 37 have the same
  count on both sides**, so Duris' four Ice Garden corners are our four and zipping them sorted puts one
  mob in each. Faithful as a distribution even where it cannot be about identity.
- **§4.9's surprise, implemented exactly:** an `M` below 100% **never fires on a timed repop**. So mob
  spawns are deterministic and *equipment* is the random layer — the rare-drop mechanic, arrived at by
  accident. All 332 harvested `M` commands are at 100, so honouring it costs nothing.
- **Hit points are rolled per instance** through the seeded RNG, so two guards of one vnum differ — and a
  restart reproduces the world it had (`CLAUDE.md` rule 3).
- **Yield, honestly: 73.5% of reset commands dropped** for want of a room, across 49 zones. 1,503
  templates kept of 2,936; 2,016 spawns and 1,278 door resets translated. Same partial-source story Phase 3
  told, one stage on.
- **Object commands are parsed and carried, not executed.** They must be: `G`/`E`/`P` attach to *the last
  mobile loaded*, so an executor never told they were there would lose the cursor and mis-attach the first
  item Phase 15 turns on.
- **Kobold Settlement is harvested and switched off** via `populate` in `world.config.json`. Duris tags
  kobolds with a *humanoid* race code, so the filter that correctly dropped its cows cannot catch them and
  they would all render as men. One line changes when there is creature art.
- **Phase 7's config array is gone**, as its own roadmap entry promised — `MobPlacement` and the boot loop
  that read it, replaced by templates and reset tables.

### Before that: Phase 7, something else is in the room

`Actor` / `Player` / `Mob` in `sim.ts`, and a sentry standing at the base of the IceCrag cliffs.

- **One map, not two**, keyed by a `kind` discriminator. Two maps would have meant every pass over the
  world either iterating both or quietly forgetting one — and the one it forgets is always mobs, because
  mobs came second. So "everyone" is the default and "only players" is what you ask for by name.
- **Ten narrowing points, and that is the metric.** `grep -c 'isPlayer\|isMob'` is 7 in `sim.ts` and 3 in
  `index.ts`, and every one is a place a mob genuinely cannot go: steering intent, a walked route, the lit
  set and its invalidation, the relit queue, `wake`'s reply, the movement pass, log recipients, and the two
  halves of `relocate`. Regeneration, affect expiry, presence, the visibility gate and `viewOf` never ask.
- **The visibility gate needed one word.** `visibleEntities` went from `playersIn` to `actorsIn`. `canSee`
  already asked the right question of any body — it tests the subject's *tile* against the observer's lit
  set, and a tile does not care what stands on it — so the sentry is hidden and revealed by code that was
  already running. **No new message type, no new gate.**
- **`dark` is still inert and did not need to change.** Being unseen is the fog: a body six tiles off is on
  ground you have no light on. Measured live — walk into his room at radius 2 and he is not mentioned,
  `look` does not find him, two bursts toward him and he appears.
- **Both figures are real layered LPC now**; the placeholder circles are gone. Two traps cost time and are
  written down: **LPC's sheet rows are north/west/south/east**, not Diku's north/east/south/west, so the
  facing map is spelled out; and the **body sheets are two frames wide where the mail and greaves are
  one**, so the column stride is read per texture. A hardcoded stride puts a west-facing body under a
  north-facing shirt, which reads as a movement bug. Attribution and both licences live beside the art in
  `packages/client/public/lpc/`.
- **The sentry is data**, in `world.config.json`, validated loudly on load — `CLAUDE.md` forbids world
  content in an engine package. His tile offset is expressed **inside the room**, so regenerating the world
  cannot move him. He is from IceCrag's own roster (`icecrag.mob` vnum 97018) rather than invented.

### Before that: Phase 6, the engagement decision

[DESIGN-engagement.md](DESIGN-engagement.md). No code — this is the decision that **gets made by
accident**, and Act IV is built on it.

- **The source's model is better than the obvious one.** Reading `set_fighting`/`stop_fighting` rather
  than reasoning from "a relationship between two entities": it is **one directed pointer per actor**,
  and who-is-fighting-me is *derived by scanning*. `set_fighting(ch, vict)` never touches the victim's
  pointer, so mutuality is emergent — which is why the mercy rule must scan rather than read a
  participant list, and why retargeting is stop-then-set and never set-again.
- **No range check in melee, anywhere.** A room crosses in 2.4 s against a 3 s round, so a per-swing
  reach test makes walking away free and kills threat, tanking and rescue without anyone deciding it.
  `reach` is for ranged attacks and spells only.
- **Our one divergence: steering works inside the room, every exit is refused.** Duris registers all six
  directions `CMD_N` — forbidden while fighting — but there a room was a point, so "cannot move" and
  "cannot leave" were one rule. Same call Phase 4 made for `canMove`, same reason: a character frozen for
  a whole fight reads as a hung server.
- **What "in combat" forbids is transcribed, not invented** — Duris carries it as a third independent
  gate (`CMD_Y`/`CMD_N`) beside the two-axis position minimum. It lands as one `inCombat` column on
  `COMMAND_REQUIREMENTS`, read at the dispatcher seam Phase 2 built. The rows are more interesting than
  the rule: `sit`/`kneel`/`stand` allowed but `rest`/`sleep` refused (posture yes, *status* no — the two
  axes earning their keep again); `open` allowed but `close` refused (flee through a door, do not slam
  it); `wield`/`remove` allowed but `wear` refused.
- **No engagement timeout, ever.** A clock that lapsed it after inaction is a free disengage available
  by standing still — exactly what stickiness exists to prevent.
- **Pursuit stops at a `Place` boundary**, closing §2.5's open question. It gives the world's portal
  structure a tactical meaning it lacked, and a staircase counts, because a level change *is* a Place
  change.

### Also landed: the three-column shell

Owner's request, and not a phase — chrome rather than a mechanic, so it carries no roadmap number.
`packages/client/index.html` is now a CSS grid: **log | map | character sheet**, equal thirds, both side
panes collapsing to a 26px rail and remembering it in `localStorage`.

- **The canvas is a grid cell now, not an overlay.** That retired a whole class of bug rather than
  guarding against it: `UI_PANELS` — the list of DOM panels a world click has to be hit-tested against —
  went from four entries to two, because the log and the sheet no longer sit on top of the world.
- **One trap, and it is worth knowing.** Phaser's `Scale.RESIZE` listens for **window** resizes, and
  collapsing a pane resizes a *grid column*. Worse, `scale.refresh()` alone applies the scale manager's
  *cached* parent size — measured, collapsing the log took the stage to 707px and left the canvas at 480,
  one collapse behind for ever. `scale.getParentBounds()` must run first. See `refreshViewport`.
- **Right-drag pans the camera**, because the left button is already the joystick. Panning detaches the
  follow — it has to, since Phaser's follow hard-sets the scroll every frame — and a click or a movement
  key re-attaches it. Zoom now defaults to **0.5** rather than 1: at 1 a 9x9 room filled the view and the
  doorway you were walking towards was off screen.
- **The keys card defaults to hidden** and is anchored to the map rather than the window. It reads
  `!== '0'` so "never chosen" lands on hidden while an explicit "show me" survives.
- **The vitals are map chrome, not sheet content.** Pools, light, stance, affects and the room label
  live in a click-through `#status` overlay pinned to the top of the map panel. They were briefly in the
  sheet and that was wrong: the sheet collapses to a 26px rail, and a pool you cannot see is a pool you
  find out about by dying. Pinned to the map they survive any pane state, so the map can take two thirds
  or the whole width and the numbers come with it. `UI_PANELS` carries the hit-test, which matters more
  here than for the room label it replaced — the vitals are what a player looks at most, so they are what
  they would most often click by accident.
- **The equipment paper doll** is `DESIGN-inventory.md` §6's eleven slots in the owner's own
  arrangement, with inline-SVG line-art glyphs and a silhouette in the middle. **Only the main hand can
  be filled today** — by the carried light, which §6 already calls the interim stand-in for "the best
  light among your equipped items". Every other slot is empty because it is empty; nothing is faked. The
  silhouette is replaced by the layered LPC character in Phase 15, which is the point of the slot set.
- **The inventory button** opens a drawer that honestly says "You are carrying nothing." No capacity
  number, because `0/20` from a design document is a fact the server has never asserted.

### Before that: Phase 5c, terrain that stops guessing

`worldgen/src/terrain.ts` (rewritten) and `worldgen/src/diffuse.ts` (new). **Default-sector share
23.2% → 0.2%**, byte-identical output across runs, and the numbers print on every `npm run worldgen`.

- **The old table's misses were mundane, measured against a survey of all 10,773 defaulted rooms:**
  no plurals (`\btunnel\b` fails on "a Maze of Tunnels" — 546 rooms), missing vocabulary
  (`labyrinth`, `sewer`, `way`, `office`, `passage`), and the zMUD mapper's own literal "(Water)" /
  "(No Ground)" annotations ignored. Fixing vocabulary did more than the clever parts.
- **Suffixes see into compounds** — Night**wood**, Ever**moor**, Skull**port** — with a short,
  high-precision table because suffix guesses seed diffusion and a wrong seed spreads. `-ice` is the
  recorded trap: it classifies "An Off**ice**" as glacier. `-ton` likewise ("skele**ton**").
- **Diffusion fills the connective tissue.** "A Bend in the Passage" has no vocabulary *on purpose*;
  it takes the majority sector of its labelled neighbours (seeded by name rules + the Duris harvest),
  synchronous rounds to a fixpoint, ties broken by the zone's seed histogram then alphabetically.
  Cross-zone exits count as edges — the auto-generated Underdark grids have no classifiable names at
  all and can only be labelled from next door.
- **`DURIS_SECTOR` now maps all 40 Duris sector values, not 24.** Phase 3's "Duris has no swamp or
  arctic" was the mapping's gap, not the data's — 47k rooms of evidence (5,162 arctic, 6,558 swamp)
  were being dropped. The blind-spot rule survives with its premise corrected: the late sectors
  postdate most zones, so a Duris `field` against our `road` is still a builder with no word *at the
  time*.
- **Accuracy is measured and low, honestly:** held-out rooms (name-defaulted, Duris-settled),
  re-predicted blind, agree 15.7% exactly / 24.6% under the harvest's own blind-spot rule — against
  ~10% for the old blanket-field behaviour. The confusion is dominated by `cave`/`inside`/`city`
  flavour in dungeon zones, where Duris' vocabulary is coarse (it has no cave sector at all).
  Coverage is the win; the validation line exists so nobody mistakes it for truth.
- **Verified in the running game:** the Stump Bog ships `swamp` and `shallow_water` on the wire, and
  walking two bog rooms cost 16 movement — `SECTOR_MOVE_COST` charging real terrain.

### Before that: Phase 5b, the affect system

`shared/src/affects.ts`. **One record for everything temporary**, and the carried light's hand-wound
timer was deleted rather than wrapped — which was the whole test of it.

- **`Simulation.recompute` is the single derivation point**, this project's `affect_total`. It strips to
  base and re-folds the list; there is no `unapply` and there must never be one. `Player.light` and
  `lightRadius` are both derived from it now, `lightRemainingMs` and `lightWarned` are **gone**, and
  `PlayerStore` swapped a bespoke pair of light fields for one affect list (with the old shape read as a
  migration, exactly as `explored` → `seen` was).
- **`type` is not a key.** One cause installs one node per stat it touches — `second_wind` is three, one
  per pool — so `removeType` takes runs, expiry reports one event per *cause* only once its last node has
  gone, and the display path groups. Getting this wrong once is most of §4.12's failure list.
- **The visible half is the rest cycle.** `rest` and watch `settling into rest` count down; it becomes
  `second wind`, the bar fills faster, and a minute later it fades and the rate returns to exactly what
  it was. Still resting? The wait re-arms. `affects` prints the same list in the log.
- **Stacking is the caller's choice** — `keep`, `replace`, `join` — because Duris has all three live at
  once and picking one would make two thirds of a spell list unimplementable.
- **A flat regen bonus lands after the position multipliers**, so posture is multiplicative and
  gear-style bonuses are additive and they do not compound. It applies while *dying* too, faithfully —
  and `gain == 0` below `sleeping` is forced to `-1` precisely so it can never produce a stable
  unconscious body. Movement and mana take the opposite rule and stay zeroed.
- **One clock, not two.** No `AFFTYPE_SHORT`, no scheduled per-affect event, and therefore none of the
  use-after-free care Duris needs around removing one early. We have no coarse hour tick for it to be
  the exception to.
- **`PROTOCOL_VERSION` is 9** — `SelfView.affects`, already grouped and filtered server-side. The
  carried light is **not** in that list: it has had its own HUD line since Phase 1.

**Verified against a real pre-v9 save**, not only in tests: logging in as a character stored with
`light: candle, lightRemainingMs: 500` produced a radius-3 candle, warned immediately (the
resumed-below-the-threshold case a bare edge test would miss — which is why the warning latch lives on
the affect), then guttered out and dropped the radius to 2. The save rewrote itself in the new shape.

### Before that: Phase 5, health that moves

`shared/src/vitals.ts`. **Walking now costs movement, and resting refills it faster than standing** —
which is the moment posture stopped being cosmetic.

- **Both position axes multiply.** Status (`resting` ×1.25, `sleeping` ×1.5) times posture (`prone`
  ×1.25, `sitting` ×1.125, `kneeling` ×1.0625), straight from `hit_regen` in `limits.c`. Measured in
  the running game: standing 16/min, resting 20/min — exactly 16 × 1.25, because `rest` keeps you
  standing.
- **`dying` and `incapacitated` are absolute and negative**, −2 and −1 a minute. The dying window is a
  clock, so a rescue is a race. Only hit points bleed; you do not lose stamina from a wound.
- **Fractional per-tick accumulators.** 13/min is 0.0217 of a point per 100 ms tick — round per tick
  and every rate in the game is zero for ever. The carry is bounded: measured, the lag is one point at
  1 minute and still one point at 20.
- **`SECTOR_MOVE_COST` has a caller.** Averaged over the terrain you leave and the terrain you enter,
  so a road is worth following. Out of movement means "too exhausted to go on", not "unable to walk".
- **The wound is persisted, never the value** (`PlayerStore.setMissing`). `maxHp` is derived, so saving
  the value would have a gear change silently heal or kill you.
- **Two plan corrections.** Movement cost moved here from Phase 16 — without it nothing drains a pool
  and no bar would ever move. And **the event scheduler is not here**: regen is dense and uniform, and
  a queue for a consumer shaped like a loop is the wrong abstraction. It moves to Phase 11 with
  per-actor combat clocks. The **affect system** became its own phase, **5b**, placed before combat.

### Before that: Phase 4, posture and status

`shared/src/position.ts`. Two **orthogonal ordered ladders**, compared independently — that is Duris'
`MIN_POS`, and collapsing them into one enum is the mistake it exists to prevent.

- `posture`: prone → sitting → kneeling → standing.
- `status`: dead → dying → incapacitated → sleeping → resting → normal.

Commands: `stand sit kneel rest sleep wake [someone]`. Note **`st` is now `stand`, not `stop`** —
table order decides it and `st` is stand in every Diku descendant; `stop` is still `sto`.

- **The gate lives in one place.** `COMMAND_REQUIREMENTS` gives every command a minimum on both axes,
  transcribed from `interp.c`'s own rows, and `runCommand` is the only reader. `help`/`who` sit at the
  `dead` floor so they always work; `wake` is the only thing a sleeper can do; `look`/`say` need only
  `prone`, which is what will make the dying window playable.
- **Status is a transition, not a function of hit points.** A fight force-wakes a sleeper, and coming
  back from the floor lands you at `resting`. Recomputing it from hp each tick would make `sleep`
  silently undo itself.
- **Movement requires standing — our one divergence.** Duris allows `POS_PRONE` movement; we have
  continuous steering and a seated character must not glide. `Simulation.canMove` is the authority and
  the client mirrors it so prediction does not slide a sprite the server holds still.
- **Deferred:** `update_pos`'s forced collapse needs hp to move, so it waits for combat.
  `refreshStatus` is the seam, and it has a test.

### Before that: Phase 3, rooms that read like rooms

`worldgen/src/duris.ts` harvests real sector types, room flags and prose from the Duris `.wld` files.
`npm run worldgen` runs it automatically; `--no-duris` skips it, and a checkout with no
`data/zones-source/` still builds.

- **The join is by room *name*, not id.** Toril and Duris renumbered independently after the 1995
  split — the best constant vnum offset for a matched zone is agreed by 4–11 rooms out of 25–100,
  across 20–68 candidate offsets. Zone→file by voting (≥30% overlap, ≥2× margin), then room→room by
  name **within the winning file only**; a global name lookup would import another zone's terrain,
  because "Gravel Path" exists in hundreds of them.
- **Yield: 49 of 327 zones, 5,919 rooms (12.7%).** 3,686 sectors replaced, 5,889 descriptions, 3,911
  rooms flagged. Near-total inside a matched zone — IceCrag is 216 of 219.
- **The world now loads four zones.** 36 IceCrag Castle and 168 Kobold Settlement are matched and
  carry the harvest; 260/261 are Duris-orphans (3 of 98 and 0 of 93 rooms) and keep inferred terrain,
  but stay loaded because they are the only adjacent pair with cross-zone exits. Spawn is IceCrag's
  approach road, room 281.
- **Sanctuary is inns only** — the design rule. It is also the only rule that yields any: `ROOM_SAFE`
  is set on 11 of Duris' 781,053 rooms and none is in a matched zone, while `ROOM_INN` gives us
  Grumbiter's Inn (168/41238). `peaceful` and `death_trap` have **no upstream source at all**.
- **Where Duris is coarser than us, our guess survives.** Duris has no `road`, `swamp` or `arctic`
  sector, so its builders reached for `field`. That is an absence of vocabulary, not a finding, so a
  blind-spot guess is kept when the harvested value is generic. 149 rooms took that path.

### Before that: Phase 2, the command line

Press <kbd>Enter</kbd> for a prompt in the log panel. The client sends the line **unparsed**; the
server owns every step of turning it into an action (`server/src/commands.ts`).

- **Abbreviation is table order.** Exact match first, then leftmost prefix, first row wins — so `n`
  is north, `sa` is say, `ex` is exits. **Do not sort `COMMANDS` and do not make it a hash map**:
  every command still works typed in full and every abbreviation quietly means something else.
- **Target resolution.** `2.orc` is an ordinal plus a keyword; keywords match **whole-word, never
  abbreviated** (`kill or` does not find an orc), and candidates come from `visibleEntities`, so you
  cannot name what you cannot see. A malformed ordinal (`foo.orc`) matches *nothing* rather than
  falling back to the first candidate.
- **One dispatcher.** `runCommand` is the single place every typed command passes through. Phase 4's
  position gate and the stealth allowlist go there and nowhere else — scattered checks at each action
  site are the failure mode.
- **Phaser's key capture had to be switched off while typing**, not just the game's own reads. See
  gotcha 5 in `CLAUDE.md` — it is the one that will bite the next person who adds a key binding.
- **While the caret is in the prompt the game is deaf to the keyboard**, or typing `west` walks you
  west. `WorldScene.setTyping` gates `down()` for every consumer at once.

Commands: `north east south west up down exits kill look say help who open close stop`.

**Vertical travel changed after Phase 3.** `Q`/`E` need no modifier now, and stairs are a 3x3
landmark placed by a hash of the room id rather than one marker tile on the room centre. See the Act I
amendments in `ROADMAP.md`.

### Before that: the two live bugs are fixed

Both were found by the MUD study, both verified against the code before being touched, and both are
now pinned by tests plus an end-to-end run against the real server.

- **Doors are geometry.** `isWalkable` was `tile !== Void`, so `Tile.Door` was walkable and door
  state reached the grid only at build time — `stepRoom` refused a locked door while WASD,
  hold-to-drag and click-to-move walked through the same doorway. A shut door is now refused by all
  four, and is opaque as well. Movement blocks on **closed**, not locked, matching `actmove.c:1220`;
  locked is what refuses `open`. `open`/`close` mutate both sides and broadcast a `door` message.
  `O` and `C` work the door you are facing.
- **`say` no longer leaks who you cannot see.** Lines naming an actor are rendered **per recipient**
  (`server/src/act.ts`, the small version of Duris' `act()`), so an unlit speaker is "someone" — the
  same answer the entity gate already gives that client. `canSee` in `index.ts` is now the single
  authority both presence and prose resolve through.

Two consequences worth knowing:

- **`PROTOCOL_VERSION` reached 7 here** — it is 9 now; see Phase 5b above. `command` (a raw typed line)
  was added by Phase 2; `door` by Phase 1, where `open`/`close` also lost their required `dir` and
  default to the character's facing.
- **A shut door blocks sight.** Deliberate — a wall you can see through reads as a rendering fault,
  and `seen` is permanent, so light through a barred gate would bank the room behind it forever.

## Open, not decided

- **There is no authentication, and the name *is* the identity.** Asked by the owner 2026-08-05 and
  worth not rediscovering: `hello` carries a name, the server does `store.load(name)`, and you are
  that character. No account, no password, no creation step — two people typing `Aldric` are one
  character. **The only thing standing between that and a problem is one line**:
  `http.listen(PORT, '127.0.0.1')`, so nothing off this machine can reach the game; both Vite servers
  bind localhost too. **So the bind change and the authentication are one decision and must never be
  two** — an exposed port without accounts hands any character to whoever guesses its name. (The
  admin API is safer than it looks: its gate refuses a non-loopback remote address *before* it looks
  at the token. But `GAME_ADMIN_TOKEN` is unset, so that check is the only thing there.) Placed in
  `ROADMAP.md` §4 as **two** entries — **accounts and login**, argued for landing *early* because it
  is signature work (the save-file key and the protocol's first message both change), and
  **character creation** at Phase 21 with races and classes. Neither is built.

- **A stat roll cannot be both 5e and Duris literally, and §4 records why.** 5e is six abilities on
  3–18; Duris is **ten** stats on **1–100** (`3d6 + 77` for a normal roll), two of which the player
  never sees. `DESIGN-progression.md`'s existing rule settles it — *SRD sets the shape, Duris sets
  the magnitudes* — and there are **no ability scores in the codebase at all** today, so Phase 14b's
  unbuilt *derivation* half is the prerequisite.

- **Container nesting depth.** Proposed max 2 (inventory → container → items), which kills the
  infinite-storage exploit outright rather than mitigating it. Not agreed.

- **The admin suite is scoped and its first slice is built** — see
  [DESIGN-admin-panel.md](DESIGN-admin-panel.md), off-roadmap at the owner's request (2026-08-02).
  The players section works end to end (verified live: pools, the level rig, lights, cross-Place
  teleport, tell, kick, offline wound edits round-tripped through a real login, delete, announce).
  Open within it, in order: **messaging to a place or room** (wants the zones section's room
  browser), then **zones and mobs** — reads and live ops first, authoring as overlay files under
  `data/world/overrides/` so `npm run worldgen` cannot clobber hand-authored content. Items and
  quests tabs stay stubs until Phases 15 and 17 exist to give them something to edit. The original
  principle stands and is §1 of the doc: the server is the only writer, and content that can only
  be edited through a tool is hostage to the tool.
