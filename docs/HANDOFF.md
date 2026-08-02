# Handoff

_Last updated 2026-07-30. Read this first; it is the shortest path back into the project._

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
npm run dev          # server + client together
npm run typecheck    # tsc across all four packages
npm test             # 714 tests
npm run worldgen     # rebuild world JSON from the zMUD source DB
```

Client on **5273**, game server on **8787**, admin panel on **5274** (`npm run dev` starts all
three). The server reads **`GAME_PORT`, never `PORT`** — dev harnesses set `PORT` for the web server
and `concurrently` passes it to every child.

Which zones load is **data, not code**: `world.config.json` at the repo root. Adding a zone id there
and restarting is the whole of "installing" a zone.

## State: green

- **714 tests** (363 server, 278 shared, 73 worldgen), typecheck clean across all packages.
- `data/` is git-ignored and reproducible. `npm run worldgen` regenerates it.
- Four zones loaded, 23 places: **36 IceCrag Castle** (219 rooms, 11 levels) and **168 Kobold
  Settlement** (99 rooms, 6 levels), both Duris-matched and carrying harvested prose, flags and real
  terrain; plus **260 The Stag Forest** and **261 The Stump Bog** (98 + 93 rooms), unmatched but joined
  by 13 exits each way, which is what cross-zone travel is tested against. Spawn is room 281, IceCrag's
  approach road.

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
| Combat log | The d20, the total and the target's AC on every swing, rendered per recipient — second person for the participants, third for onlookers |
| Mercy | **Players only.** A downed character stops being a target; a mob fights to the death. A body that cannot defend itself is never missed |
| Health bars | Over every body but your own, hidden at full health, green → amber → red |
| Threat | A table per fighting mob, 110% hysteresis so a tank can hold aggro. **Aggressors only** — a mob never rounds on a bystander |
| Participation | Separate from threat: helping an aggressor in any way joins the fight, so a healer on zero threat is still a target |
| Assist | `ACT_PROTECTOR`, room-scoped as the source has it. 34 of IceCrag's 61 templates |
| Death | A mob dies, is removed, and leaves a corpse where it fell. Players stop at the dying window |
| Corpses | Decay on a clock (5 min; 30 for a player's), lootable within reach, `loot` refused in combat |
| Corpse sprites | A pile of bones, and a **single bone once picked clean** — so "has anyone been here" reads from across the room |
| Experience | Divided by contribution: damage **dealt**, damage **taken**, and support. Pool harvested from the `.mob` record. The breakdown is printed |
| Event scheduler | A deterministic min-heap, ties broken on insertion order. One timer per combatant; most actors have none |
| Testing switches | `GAME_DEV_LIGHT`, `GAME_DEV_LEVEL`, `GAME_DEV_DAMAGE` — all default-off, all announced at boot. A test rig, **not** a progression |
| Locked doors | **Locks do not hold.** No door in the world carries a `keyId`, so honouring them walled off 194 of IceCrag's 219 rooms. Doors still shut. See `LOCKS_HOLD` |
| Character art | Real layered LPC — body plus clothing, facing driving the sheet row. The placeholder circles are gone |
| UI shell | Three columns — log, map, character sheet. Both side panes collapse to a rail and remember it; collapsing one gives the map two thirds |
| Vitals | Pinned **over the map**, not in the sheet — pools, light, stance, affects and room are on screen whatever the panes are doing |
| Equipment panel | Paper doll, `DESIGN-inventory.md` §6's eleven slots. Only the main hand can fill today, from the carried light |
| Admin panel | `@mygame/admin` on 5274, a client of `/admin/api` on the game server. Players section built: live edits through the sim's own seams, offline edits through the store, refusal over pretence, every mutation audited to `data/admin-audit.jsonl`. Global announce works; zones/mobs/items/quests are honest stubs. See `DESIGN-admin-panel.md` |

### Not built

Items, inventory, equipment, quests, classes, races, skills, spells, grouping, shops, chat beyond
room-scoped `say`. A corpse holds **nothing** — items are Phase 15 — so looting changes how it looks and
nothing else, and it says so rather than pretending.

**A dead player is not returned anywhere yet.** They stay in the dying window with a corpse on the floor;
there is no respawn, no experience loss and no resurrection. That is the half of Phase 13 the roadmap
calls *corpse retrieval*, and it needs a decision about what death costs before it can be built.

**The largest hole is character progression** — no ability scores, no hit dice, no levelling, and nowhere
to start. A new character is level 1 with 9 hit points and the only populated zone is levels 15–60, so
combat is correct and unsurvivable. It is recorded in `ROADMAP.md` §4 and the `GAME_DEV_*` switches are
the stopgap.

**Be aware of the inert surface.** `SECTOR_REQUIRES_MOVEMENT` and `proficiencyBonus` still have **zero
non-test callers**. `resolveAttack` and `rollDamage` came off this list in Phase 11 — they had been
written and tested since the beginning and never once called, which is the exact failure `ROADMAP.md`
rule 1 exists to prevent. `ROUND_MS` is now read through `roundLengthFor` and stored per actor, which is
§4.1's requirement rather than a tidy-up. `SECTOR_MOVE_COST` came off in Phase 5.

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
   melee, `flee` as the only voluntary exit, and no timeout ever. Decided, not built.

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
`{t:'hello',protocol:9,name:'Prober'}` and drives the game with `{t:'command',text:'kill sentry'}` and
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

**The schedule now lives in [ROADMAP.md](ROADMAP.md)** — 23 phases, each pairing a mechanic with
something you can see, so progress is legible rather than inferred. Read that for *what next and
why*; this file stays the answer to *where things stand*.

**Fifteen of 23 done — Acts I–III complete, Act IV nearly.** Next is **Phase 14, mercy and fear**: morale,
`wimpyAt`, fleeing toward allies, and the `flee` command — which is also the **only voluntary way out of a
fight** (`DESIGN-engagement.md` §5) and currently does not exist, so leaving a fight means winning it,
dying, or disconnecting.

`ACT_WIMPY` is harvested by `isWimpy` in `worldgen/src/mobs.ts` and has **no caller**. §2.8 wants a
high-intelligence mob to flee *toward* its allies rather than randomly, which turns a fleeing mob into a
developing problem rather than an escape — and `firstStepToward` in `hunt.ts` is the pathing that needs.

**Two things Phase 13 deliberately left open**, both needing a decision rather than more code: what death
*costs* a player (respawn point, experience loss, whether a corpse can be resurrected), and character
progression generally — see `ROADMAP.md` §4, where it is recorded as the largest hole in the schedule.

**Have an idea?** `ROADMAP.md` §4 places it — do not append it to the end and do not build it now.

### Just landed: Phase 13, death and corpses

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
