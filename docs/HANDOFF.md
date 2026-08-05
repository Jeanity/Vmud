# Handoff

_Last updated 2026-08-02. Read this first; it is the shortest path back into the project._

---

## What this is

A **graphical MUD** — not an action RPG with MUD flavour. The owner's framing: *"this is what I am
going for — a graphical MUD."* MUD mechanisms are the specification. It renders the world of
**TorilMUD** (formerly Sojourn), a Forgotten Realms MUD.

Entirely independent of anything under `E:\` (Jeanity, InstaPost, SIG, …). Do not import context or
skills from those projects.

## Run it

```bash
npm install          # once
npm run dev          # server + client + admin panel together
npm run typecheck    # tsc across all five packages
npm test             # 912 tests
npm run worldgen     # rebuild world JSON from the zMUD source DB
```

Client on **5273**, game server on **8787**, admin panel on **5274** (`npm run dev` starts all
three). The server reads **`GAME_PORT`, never `PORT`** — dev harnesses set `PORT` for the web server
and `concurrently` passes it to every child.

Which zones load is **data, not code**: `world.config.json` at the repo root. Adding a zone id there
and restarting is the whole of "installing" a zone.

## State: green

- **1,309 tests** (746 server, 468 shared, 95 worldgen), typecheck clean across all five packages.
  Four of the server's are `world.test.ts`'s, which **skip themselves when `data/world` is absent** —
  a fresh clone or a new worktree reports 1,210 until `npm run worldgen` has run.
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
| Zone + level travel | One operation — see `Place` below |
| Visibility | Tile-granular shadowcasting line of sight, three states, persisted per character |
| Light sources | Catalogue, durations, expiry chains, ground pickups, room-mode illumination |
| Click-to-move | Server-side A*, gated on tiles you have **seen** |
| Hold-to-drag | Virtual joystick — straight-line steering, **not** gated |
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
| Fleeing | One `do_flee` for players and mobs. 78–86% by exits, automatic when not engaged, costs 20–30 movement, a closed door is not a way out. A mob that can path runs **toward its allies**; whatever it fled starts hunting it. **Escaping a fight also leaves you winded for 60 s — nothing mends.** Refreshed on every flight so a pursuit cannot be out-waited, paid by mob and player alike, and not charged for a flight from nothing |
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
| Equipment panel | Paper doll, `DESIGN-inventory.md` §6's eleven slots. Only the main hand can fill today, from the carried light |
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
| Two people walk the map as one train | **Phase 18's first half — following.** `ROADMAP.md` gives the phase one rule that decides nearly everything: *"followers move by re-issuing the movement intent, never by teleporting."* A follower who is **moved** arrives wherever the leader is — through closed doors, across deep water, out of a fight, without paying a step's stamina. A follower who is **asked** meets every rule the leader met, separately. So a train that breaks because one member was too tired is the correct outcome and needs no code of its own: it falls out of asking rather than telling, and `walkFollowers` knows about none of those rules. Recursion is free for the same reason — a follower's own followers are picked up when *they* step. **Transcribed from `do_follow` (`actmove.c:3116`), including the two forms that read oddly**: `follow <your own name>` is how you stop, and **`follow stop` is the *leader's* command**, throwing off everyone **in the room** — scoped that way because you can only shake off what you can see, so somebody trailing you from three rooms back keeps following. The follower chooses and the leader does not consent, which reads wrong until you notice the leader's remedy is one word away. One leader at a time, the old link dropped rather than the request refused; but a **ring is refused and costs nothing** — `wouldLoop` walks the chain, and a request that cannot be honoured must not also take away the relationship the character already had. A ring is not a strange state to be in, it is a movement intent that never terminates. Forgotten in **both directions** on disconnect, and whoever was orphaned is told: entity ids are reissued, so a leftover link would drag the next character handed that id along behind a stranger — the same argument `forgetTarget` makes about a mob's memory. `follow` is allowed **mid-fight** (`CMD_Y`), which is the source's call and the right one: it is the only way to arrange a retreat with somebody while the fight that makes you want one is still going. **Driven live 2026-08-05 with two sockets**, which is the only way to see it: Wick followed Sarn, Sarn walked north then east, and Wick was issued each step and arrived behind him; `follow stop` broke it and Sarn's next step left Wick where he stood. **The phase is not done** — consent, the shared list and §4.4's superlinear experience split are its other half, and whisper-to-group carries on that. `server/src/following.ts` |
| You can decide what a mob is carrying | **A4c**, owner's ask 2026-08-04: *"assign items to mobs as loot."* A4 built the live half — spawn one, watch it, slay it, see what its corpse holds — and this is the authoring half. `server/src/mob-overrides.ts`, the fourth overlay in `data/world/overrides/` and the same shape the other three take. **Per template, and the panel says so in as many words**: a *harvested* kit is per reset command (an `E` attaches to the last mobile the zone file loaded, so one vnum in two rooms can carry two different things), while this changes **every** instance the world spawns from now on and **none** of the ones already standing. The save reports how many those are, because *"I authored it and nothing changed"* is otherwise the first bug report — and A4's Repop button is what turns it into something to go and look at. **Additive, and provably so.** It is applied *after* the reset table has dressed the mob, so an authored piece wins a contested slot and the harvested one it displaces goes to the mob's **hands** rather than being destroyed. What is on a body only ever goes up, which is what makes "additive" true rather than merely intended — and it is the rule `reset.ts` already uses for a wear position we do not model. Subtraction is deliberately impossible: it would mean naming things that are *not* in the overlay, and a re-harvest that changed a zone's `E` list would silently change what the subtraction meant. **A slot the game does not model is refused rather than downgraded to carried** — the opposite of what `reset.ts` does with a harvested `E`, and the asymmetry is the point: harvested data is inherited and worth keeping on the body, while a slot typed here is a choice somebody just made, and quietly doing something else with it is how an author ends up believing a hat is on a head it is not on. Loot is instantiated **per instance**, so two guards authored a key carry two keys rather than sharing one. Applied at both spawn paths — the zone reset and the panel's own Spawn button, which is the first place anybody will look. **Driven live 2026-08-05**: authored a rusted iron key (carried) and a small iron key (offHand) onto kobold guard 1410, which reported **8 already standing and unaffected**; spawned a fresh one, slew it, and looted **both** pieces off the corpse |
| The floor empties itself | **Round 8's mechanic slot**, owner's ask 2026-08-05: *"dropped items need to decay so we don't have rooms full of discarded items everywhere."* Ten minutes, then it goes — with a warning a minute before, latched so it is said once rather than every tick. **The reason is not tidiness, and that is the part worth keeping**: `reset.ts` caps object instances **world-wide** and the census counts what lies on floors and inside floor containers, so a room ankle-deep in discards quietly holds a zone's repop at its ceiling — the sword nobody picked up is why the table upstairs has none. Clutter is the symptom; a zone that stops repopulating is the cost. **Nothing to transcribe**: Duris does not decay dropped objects at all (`ITEM_TIMER` is repurposed for traps, and `point_update`'s timer is a *character* idle counter), so the number is ours, anchored on our own corpse clocks — **twice a mob's corpse** because you chose to put this down, **a third of a player's** because that is a disaster you are running back to. A container **spills rather than taking its contents with it**, the corpse rule one store over, and the spill walks each stack's `count` so a quiver does not destroy nineteen of twenty arrows. The clock restarting on a fresh drop is free *because the floor is not persisted* — a restart clears it outright, so there is no long-lived object whose age anybody could game; if `ground.ts` ever gains a save file that is the line to revisit. **`GAME_DEV_DECAY_MS` is the rig**, default-off and announced at boot like its three siblings, because watching a ten-minute clock is not a drive. **Driven live 2026-08-05** at 5 s: dropped, *"A leather tunic is starting to fall apart"*, then `entityLeave` and *"A leather tunic crumbles away"* |
| Getting rid of something, on purpose | **`junk`**, owner's ask the same day, and the source had already decided both halves: `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)` is *requires confirmation, and may not be used while fighting* — so the confirmation the owner wanted is a property of the command in Duris' own table, beside the posture requirement. Even the wording is transcribable: `do_junk` writes **"WARNING: JUNK permanently destroys the specified object(s)"** and offers `(Yes/No) [No]`. **Why it exists when `drop` does**: dropping is not disposal. Phase 15b put things on a real floor where they remain an entity, remain visible, and remain counted against their vnum's world-wide limit — getting rid of something by dropping it makes it the zone's problem. This makes it nobody's. **The confirmation is intercepted before the command table, which is `interp.c:1343` exactly**, and that placement is the whole trick: `n` is north, so a `no` in the table would either steal it or force the refusal onto a second-choice word. Read while an answer is pending, `n` means no — and means north the rest of the time. **What is stored is the command line, not the resolved item** (the source's `last_command`), so confirming re-asks the question and a bag that changed in between produces an honest refusal rather than destroying whatever slid into that slot. **One deliberate divergence**: Duris leaves the confirmation armed when the answer is neither yes nor no; ours clears it, because an armed destroy that survives ten minutes of play and then fires on a stray `y` is precisely the accident a confirmation exists to prevent. It is also dropped on disconnect — entity ids are reissued, and an inherited armed junk would destroy something of the next character's. **What was inside goes with it**, which is the one place this parts company with corpses, decay and drops: in all three of those the player has not asked for the contents to stop existing, and here they have. The level column reads 56 and is **deliberately not transcribed** — `do_junk`'s own body contradicts itself about `IS_TRUSTED`, and a verb for tidying your own bag has no business being gated. **Driven live**: armed, cancelled by an `exits` that still printed the exits, cap still in the bag; armed again, `yes`, *"You destroy a plain leather cap"*, bag empty |
| A map of everywhere you have been | **V4**, and **protocol 18**. `M` frames the Place you are standing on and there has never been a view of anywhere else; this is the other question. `HANDOFF.md`'s first decision fixes the form it may take — coordinates are normalised per zone *and* per level, so no two Places share a coordinate space and 0 of 991 cross-zone exits is a geometric neighbour. **There is no plane to draw the world on**, so it is a graph: discs for Places, lines for links, on concentric rings by how many boundaries you crossed to reach them. Rings rather than physics because the layout must be a **pure function of the graph** — a force-directed one would look better on a big graph and wobble on this one, and a map that rearranges while you read it is worse than a plain one. Verified by drawing the same graph twice with the nodes supplied in a different order: identical positions. **It adds no persisted field**, which is the design rather than a saving: a character's `seen` bitsets already record which Places they have stood in, so the whole thing is derived. **The edge rule is where the care went, and a test killed the first version of it.** "Source room seen, far Place visited" reads as sufficient and is not — a character who has stood in the marsh and, separately, in the keep would be shown the passage joining them, because the marsh room they *did* see has an exit into a Place they *have* been. They never found that passage. It now needs **both of its rooms seen**, which says exactly *you have stood on this side and on that side* — what walking a link gives you, and all it may give you. A node also carries **rooms explored, never rooms that exist**: telling somebody there are ninety rooms on a level they have found four of is handing them the answer. That count is why there is a **request** message as well as the push — the graph is pushed on every Place change, which is when a node or line can appear, but the count climbs with every step inside a Place, so the view asks when it opens. Shares **`M`** with the zoom rather than taking a key: gotcha 5a says every bound key is a letter that can vanish from the command line, and gotcha 5b says read the modifier off the event rather than polling it. **Driven live 2026-08-05**: joining gave one node and no lines; descending into level 4 of the Kobold Settlement produced the second node and the edge `168:4 --up-- 168:5` in the same push; and the overlay drew four Places on two rings with the current one picked out. `client/src/placemap.ts`, `server/src/placegraph.ts` |
| Moving the edge of a zone, and paying for it | **A8's third and last slice, and the sharp edge the other two were built to avoid.** A grid is sized from `boundsOf` the rooms on its level and tile indices are row-major, so a resize does not make a saved `seen` map *incomplete* — it makes it **wrong**, lifting fog off tiles nobody has visited and drawing it over ones they have. Slices 1 and 2 refused to resize at all; this one allows it and **clears the Place's explored map for every character, then says so**. Of the three possible outcomes it is the only honest one: preserving is impossible, re-mapping needs the old grid's width (never stored) and would have to be right for every offline save too, and a *shifted* map is the version a player reports as the fog being broken. **The comparison is against a stored extent, and that is the whole trick** — `rooms-authored.json` records what each Place measured when the overlay was last written, so the question is "has it changed *since the maps were written*" rather than "is it different from the harvest"; the second stays true for ever after one edit and would clear every map on every boot. Only Places the overlay touches are recorded, so an unauthored world writes nothing and a boot never dirties a tracked file. **The growth is bounded by a rule slice 1 already had**: a created room must join a neighbour, so it can never be more than *one cell* past the edge — there is no way to ask for a grid a thousand wide, which is why nothing checks for one. Three things the build found that the note did not. **Actors are positioned in tiles measured from the extent's corner** (`(room.pos.x - bounds.minX) * ROOM_STRIDE`), so a grid that grew leftward moves every body on the Place without anybody touching them — `forgetPlace` re-seats them all. **The clearing must be flushed, not debounced**: `touch` schedules a write and `unref`s the timer, so a restart inside that window keeps the stale file — and the boot check would *not* catch it, because by then the stored extent matches and the two agree nothing changed. The one character left holding a wrong map would be whoever was online. **And the warning has to precede the act**: the panel colours the build button red and says what it will cost before the press, and `RoomDetail.holdsExtent` lets the delete control do the same — a warning that arrives with the response is a warning about something that already happened. **Driven live 2026-08-05**: two characters walked a real 2,624-char map of 168:5 and logged out; building a room at cell (13,5), one past the edge, reported `mapsCleared: 2, told: 1` and **both save files were empty of that Place when read straight off disk with no flush in between**. Deleting it again shrank the grid back, and a connected client received a fresh `seen` snapshot that went **2,824 → 2,624 characters** — the grid genuinely narrowing — plus the announcement. A hand edit that added a room past the edge *without* updating the extents record was caught at the next boot, cleared one map, recorded the new extent, and **did not fire again on the boot after that** |
| You can take a room out again | **A8's second slice**, and it is where the design note's two "tolerated, not repaired" decisions finally have to be honoured rather than agreed with. **Deletion is two operations wearing one verb**: a created room is removed by deleting its record, because the record *is* the room; a harvested one by writing a **tombstone**, because the zone file is generated and the next `npm run worldgen` would put it straight back. **The extent is guarded the same way slice 1 guards it, from the other side** — `removalRefusal` compares the level's bounds with and without the room, so a room *the extent rests on* is refused while one merely *sitting on* a shared boundary is fine (a wall of five rooms would otherwise be undeletable for no reason). Two more refusals live in the router because they are about the world in use rather than its geometry: the **spawn room**, since deleting where characters arrive breaks joining for everybody, and a room **somebody is standing in**, named — the operator has `teleport` and `kick`, and moving a player without telling them is the worse answer. **What is left behind is reported and not repaired.** Neighbours keep pointing at nothing (decision 3 — the shipped world already has 5 such exits and the engine simply does not walk them) and reset commands naming the room are skipped in silence for ever (decision 4 — the spawn files are a worldgen output, so they come back on every rebuild). Both are counted and shown at the moment of deletion, **which is the only moment anybody will ever be told**, and the panel says so in those words. Mobs, corpses and floor items are cleared out first — `clearRoom`, deliberately **not** `slayMob`, because a slay leaves a corpse and a corpse in a room that is about to stop existing is the thing this avoids: nothing died, the room did. **One interaction the build found and the note did not predict**: a delete leaves debris, and debris was then blocking the cell for ever — `resolveExits` refused to build back into the hole because the neighbour "already had" an exit that way, pointing at the room just removed. A dangling exit is not a link somebody authored, so it is now overwritable and a live one is not; telling the two apart needs three states, not two (`destinationLives`), because an exit into a zone this server does not *run* is real content and must not be stolen. **The tombstone beats the directory** in that test, and it has to: a tombstoned room is still in its zone file, so asking the disk first reports a room we deleted as alive. **Driven live 2026-08-05**: the spawn and the extent were both refused by name; The Pantry (41300) came out with 2 dangling exits reported (41299 up, 41301 east — note one is vertical, so the scan is world-wide rather than per-level), 2 orphaned resets (1 door, 1 mob) and 1 mob cleared; the created room came out clean, with **no** dangling exits, because the reverse links it wrote were its own and came out with it. The control is two gestures — `Remove room…`, then `Yes, remove it` — the same staged-then-committed shape the PvP switch uses, and for a stronger reason: every other write in this panel can be undone by writing again |
| You can build a room in a gap the world left | **A8's first slice, infill**, and the thing A5 spent five phases refusing by name. `DESIGN-zone-geometry.md`'s five decisions, three of them in code and the sharp one **side-stepped by construction rather than by care**: a grid is sized from `boundsOf` the rooms on its level and tile indices are row-major, so widening one shifts every saved `seen` index — and `placementRefusal` will not accept a cell outside the level's extent, so no code path here can widen a grid. Measured on the drive: level 168:5's tilemap is **143×110 with the new room and 143×110 without it**. `server/src/room-authoring.ts` is the overlay — `rooms-authored.json`, whole records rather than patches, a **stored** counter from 1,000,000 (the highest harvested id is 97,271 and none is above a million), which A6b's argument says must not be derived because deleting the highest room would recycle its number and a room id is a name. Four things the build settled that the note left open. **An infill exit's destination is derived, never posted** — it is whatever stands in the adjacent cell, so the panel offers a tick per real neighbour and a direction that would be refused is never on screen; but the resolved far end **is stored**, so a neighbour that moved in a re-harvest is a discrepancy the loader can see and drop rather than a link that silently re-points. **A neighbour's existing exit is refused, not replaced**: decision 3 says write both sides, which is not permission to overwrite a side somebody else authored. **An edit to a created room re-drafts its own record**, A6b's dispatch in its second home — two overlays claiming one room is a state where the answer depends on load order — and `null` (unauthor) is refused there because there is no harvest underneath to restore. **Up and down are refused by name**: a vertical link lands on a second Place with its own grid and its own `stairPlacement`, which is real work with its own drive. The gesture is **clicking an empty cell on A4b's map**, because "which cell" is the one question a map answers better than a form; only gaps that touch a room are drawn, which is both the performance bound on a sparse level and the honest set, since a room must be joined to something. **Driven live 2026-08-05**: built "A Trampled Hollow in the Wheat" at cell 1,7 of the Kobold Settlement from the panel, and walked into it from the spawn two rooms away — the room described itself, reported its one exit north, and 41263 had gained the matching south exit **with no restart**. A cold load from disk brings all of it back with no refusals |

### Not built

Quests, classes, races, skills, spells, grouping, shops, chat beyond room-scoped `say`.

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
| `DESIGN-zone-geometry.md` | **Read before starting A8.** Adding and removing rooms: the id space, the `seen`-invalidation edge, two-sided exits, orphaned resets, and the build order whose first slice is safe |
| `PLAN-3d-migration.md` | If the 3D question returns: engine choice, costs, milestones, go/no-go |

**The single best reference is on disk, not on the web:** the complete Duris MUD C source at
`data/zones-source/duris/src/` (228 `.c` files) — the same Sojourn lineage as TorilMUD. Grep it
rather than researching MUDs abstractly. Files are large; `magic.c` is 667 KB.

## How a phase is proved done

`ROADMAP.md` rule 1: **a phase is done when you can see it, not when the code exists.** That rule has
teeth only because every phase is driven in the running game before it is ticked, and the method is worth
writing down because it is not obvious and it has caught bugs no test could.

**Write a throwaway WebSocket client.** `node --experimental-strip-types packages/server/src/index.ts`
with `GAME_PORT=8787`, then a script that opens `ws://127.0.0.1:8787`, sends
`{t:'hello',protocol:17,name:'Prober'}` and drives the game with `{t:'command',text:'kill sentry'}` and
`{t:'steer',dx,dy}`. Read `log`, `self`, `room`, `entityEnter/Update/Moved/Leave`, `attackResolved` and
`died` back off the socket. These live in a scratch directory and are deliberately disposable.

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

### Start here — round 9, and Act VI has opened (2026-08-05)

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

**Twenty of 25 phases done — Acts I–V complete.** Act VI is following and grouping, skills, spells,
and the content layer. **Track A** has landed A2, A3, A4, A4b, A5, A6, A6b, A7a, A7b, A7c, A7d and
**all three A8 slices** and **A4c**; what is left there is A7e, A7f and A7d-bag.
**Track V** has V1, V2, V3, V4 and V6, with V5 outstanding. Round 1 is complete: **V1 the combat feed** (the `combat` channel now
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
