# Roadmap

_Last updated 2026-08-02._

The order of work, cut so that **every phase ends with something you can see**. Numbers are stable: a
phase inserted later gets a letter (`5b`) rather than shifting everything after it, because these
numbers are referenced by name throughout the docs and the code comments. It is the schedule;
[REFERENCE-mud-mechanics.md](REFERENCE-mud-mechanics.md) is the specification, and its §2 status
index stays the authority on what any individual mechanism is doing. This file decides *when*.

> **Adding an idea?** Do not append it to the end and do not build it now. Go to
> [§4 Intake](#4-intake-where-a-new-idea-goes) — there is a three-question test that places it.

---

## 1. Why it is cut this way

`REFERENCE-mud-mechanics.md` §6 orders the same work by what unblocks the most. That order is
correct and it is *unusable as a schedule*, because its first four items — an affect system, a
posture axis, an event scheduler, generalising `Player` into an actor — produce, between them,
nothing on screen at all. Months of load-bearing work with no way to tell whether it is going well
is how a project this size gets lost.

So the rule here is: **a phase pairs mechanism with evidence.** Every phase names a thing you can do
in the running game when it is finished, and that thing is the test. The load-bearing work does not
disappear — it is folded into the first phase that genuinely needs it, so the affect system arrives
inside "your health can actually change" rather than as its own invisible milestone. Where a phase
really is mostly plumbing, it is paired with the smallest honest visual that proves the plumbing
runs, and the phase says so.

Three rules follow from that, and they are the ones worth defending when a phase looks tempting to
reorder:

1. **A phase is done when you can see it, not when the code exists.** `resolveAttack`, `rollDamage`,
   `SECTOR_MOVE_COST` and `RoomFlag` are all written, tested, and have zero callers. That is the
   failure mode this file exists to prevent: four mechanisms that are "done" and change nothing.
2. **Signature-changing work goes early, content goes late.** Adding a posture axis to every action
   costs a day now and a fortnight after there are forty actions. Adding a new mob does not get
   harder with time.
3. **Nothing is skipped by being invisible.** Where a phase carries plumbing, the plumbing is listed
   in *Carries* so it cannot quietly fall off.

---

## 2. Progress

25 phases. Seventeen done — Acts I–III complete, Act IV all but its progression half. Act V is
under way: **Phase 15 is done**, and Phase 16 has its balance half (16a damage bands, 16c mob
armour) with the phase proper — light, AC from material, encumbrance — still open.

| Act | Phases | State |
| --- | --- | --- |
| I — The world answers back | 1–3 | **3 of 3 ✅** |
| II — Bodies | 4, 5, 5b, 5c, 6 | **5 of 5 ✅** |
| III — Life | 7–10 | **4 of 4 ✅** |
| IV — Violence | 11–14, 14b, 14c | **6 of 6 ✅** |
| V — Things | 15–17 | 1 of 3 — 15 ✅, 16 part-done |
| VI — Together | 18–21 | not started |

Beside the phases run two lighter tracks, added 2026-08-02: **Track V** (the world on screen) and
**Track A** (the operator's panel, A1 of 7 done) — see §2b for how the three interleave, and the end
of §3 for their contents.

A phase is `done` only when its **Seen when** line is true in the running game.

---

## 2b. The cadence

Owner's rule, set 2026-08-02: **vary the work, so every stretch ends with something testable of a
different kind.** Work now proceeds in rounds of three — one item from each track, in this order:

1. **V — a visual MUD aspect.** Presentation of things that already exist: client work, at most an
   additive message field. No new rules. What it buys is that the game *reads* as the graphical MUD
   it is, and that there is always something to look at between systems.
2. **M — a mechanic.** The next numbered phase of §3, order unchanged. The phases are still the
   spine; the cadence decides what happens *between* them, not their sequence.
3. **A — an admin job.** The next slice of Track A. Each one makes the next mechanic cheaper to
   test, which is the point of interleaving them rather than batching the panel at the end.

A track with nothing unblocked skips its turn rather than inventing work. §4's intake is unchanged —
a new idea still answers the three questions; its second question now also picks the track
(presentation → V, rules → M, operator tooling → A).

**The next three rounds:**

| Round | V | M | A |
| --- | --- | --- | --- |
| 1 ✅ | V1 — the combat feed ✅ | Phase 14 — mercy and fear ✅ | A2 — messaging to a room or place ✅ |
| 2 ✅ | V2 — click a body, get its verbs ✅ | Phase 14c — the fight moves with you ✅ | A3 — zones, read-only ✅ |
| **3 ✅** | V6 — the world in its own colours ✅ | Phase 14b — a character worth keeping ✅ | A4b — the zone map ✅, then A5 — authoring ✅ |
| 4 | V3 — speech in the world | Phase 15 — inventory and worn equipment ✅ | A4 — zones and mobs, live ops |
| **5 ✅** | A7a/A7b — item art becomes data ✅ *(took the V slot: it is presentation of things that already exist)* | Phase 16 — gear that matters (16a bands ✅, 16c mob armour ✅) | A6 — items ✅, A6b — items you make yourself ✅ |
| **6 — under way** | A7c — the art picker ✅, then A7d — bag and floor icons | Phase 16 ✅ — light from what you hold, craftsmanship on AC, encumbrance, water you cannot wade | A4 ✅ — mobs live, then A4c — their loot |
| **7 — closed** | V3 — speech in the world ✅ | Phase 17 — shops ✅ | A8 — zone geometry ✅ (infill, deletion, extent changes) |
| **8 — closed** | V4 — Places as a graph ✅ | dropped-item decay ✅ and `junk` ✅ | A4c — loot on a mob ✅ |
| **9 ✅** | V5 — arrival cards ✅ | Phase 18 — following ✅, grouping ✅ | A4c — loot on a mob ✅ |
| **10 ✅** | V7 — attack verbs ✅ | Phase 19 — skills: slice 1 ✅ | A7d-bag ✅ |
| **11 ✅** | *(Track V complete again; §2b says it skips)* | Phase 19 — slice 3: `bash` and `kick` ✅, behind a `landBlow` extraction | A6c — authoring a light ✅ |
| **12 ✅** | *(skips)* | Phase 19 — slice 4: `rescue` ✅ | A7g quality — the model re-decided all 8,078 fallbacks ✅ (7,090 changed, 938 confirmed, 50 kept for a re-ask) |
| **13 ✅** | `look <direction>` ✅ *(the parked row, unblocked once doors and light settled)* | Phase 19 — slice 5: `swim` ✅, **and the phase with it** | A8d — a zone from nothing ✅ |

Round 3 ran long and out of order, and the reason is worth keeping: V6 (colour) had to land before
A5, because A5's prose editor is a colour editor and building the palette before the renderer would
have been guesswork. A4b and A5 then came as one piece — a map you can click and nothing to do when
you get there is half a feature. V3 and V4 slid a round rather than being dropped.

Two adjacencies are deliberate. A2 (round 1) takes the `announce` channel's protocol bump — a
decision `DESIGN-admin-panel.md` §5 says to take deliberately, not in passing — and V3 (round 3)
renders that channel in the world, so the seam is exercised from both sides a round apart. And
Phase 14's morale work lands beside V2's click-targeting, which is the tool for watching exactly
who breaks and runs.

---

## 3. The phases

Each phase carries:

- **Mechanic** — what is built.
- **Seen when** — the observable result. This is the completion test.
- **Carries** — load-bearing work folded in, which would otherwise be an invisible phase of its own.
- **Why here** — what it unblocks, or what gets more expensive if it slips.

---

### Act I — The world answers back

Making the world you can already walk through respond to you. Cheap, visible, and it gives every
later phase a way to be driven by hand.

#### Phase 1 — Doors that are doors ✅ **done**

- **Mechanic.** Door state (`closed`/`locked`) is geometry. `isWalkable` refuses a shut door, so
  WASD, hold-to-drag and click-to-move are all blocked by one fact rather than three checks; a shut
  door is opaque, so you cannot see through one either. `open`/`close` mutate both sides of the
  doorway and broadcast the change to the Place. Log lines about a person are rendered per recipient,
  so an unseen speaker is "someone".
- **Seen when.** You walk into a shut door and stop, press `O`, and watch it open and the room beyond
  light up. ✅
- **Carries.** Per-recipient message rendering (`act()`), which was Tier 1 #10 — done early because
  it was three call sites and would have been thirty after the command surface lands.
- **Why here.** It was a live bug, and door state is the smallest possible case of "world state the
  client must be told about", so it built the `door` message that later terrain changes reuse.

#### Phase 2 — A command line ✅ **done**

- **Mechanic.** A prompt in the log panel. The client sends the typed line **unparsed** (`command`)
  and the *server* resolves it: which command an abbreviation means is a game rule two clients must
  not be able to disagree about, and `2.orc` needs the room contents as this character may see them.
  Exact-first then leftmost-prefix lookup with **table order as the tie-break**, in Duris' own
  relative order, so `n` is north and `sa` is say. Target resolution by ordinal and **whole-word**
  keyword — commands abbreviate freely, content keywords do not.
- **Seen when.** You press Enter, type `look`, `exits`, `say hello`, `open east`, `n`, and the game
  answers — and the `O`/`C` keybinds from Phase 1 are the shortcut rather than the only way in. ✅
- **Carries.** The **dispatcher seam**: one named place every typed command passes through, where
  Phase 4's position gate and the stealth allowlist go. Today it holds a flood guard at Duris'
  sustained rate. Nothing was declared ahead of a mechanic to declare it for — a table column no code
  reads is how this project ended up with four tested-and-never-called mechanisms.
- **Why here.** This is what makes it a *graphical MUD* rather than an action RPG with a chat panel,
  and it is the tool every later phase is tested with. Building mobs before you can type `look mob`
  means building a debug UI you throw away.
- **Left for later, deliberately.** Duris dequeues one command per 250 ms *pulse*; a real input queue
  belongs with the event scheduler, which is now **Phase 11** (it moved out of Phase 5 — see there),
  and a queue with no scheduler to drain it is worse than none. So this ships the other half of what
  the pulse buys, the flood guard, at the same sustained rate. Keywords are derived from display names until items are authored (Phase 15), where
  the derivation is replaced by the field rather than extended.

#### Phase 3 — Rooms that read like rooms ✅ **done**

- **Mechanic.** `worldgen/src/duris.ts` harvests real sector types, room flags and prose from the
  Duris `.wld` files. **Room ids do not match** — Toril and Duris renumbered independently after the
  1995 split, and the best constant vnum offset for a matched zone is agreed by only 4–11 of its
  rooms out of 25–100. So the join is by *name*, in two stages: zone→file by voting (≥30% overlap,
  ≥2× margin over the runner-up), then room→room by name **within the winning file only**.
- **Seen when.** IceCrag Castle prints its own prose — *"the icy grasp of whatever seized the
  forest"* — the terrain under your feet is harvested rather than guessed, and Grumbiter's Inn is a
  `safe` room you can stand in. ✅
- **Carries.** `RoomFlag` had zero rooms carrying one. Now 3,911 rooms carry at least one.
- **Why here.** Pure data work, large payoff, no architectural risk. Prerequisite for pursuit's
  `respectsSafeRooms` in Phase 10.

**Measured yield, stated honestly.** 49 of 327 zones match; 5,919 rooms join (12.7% of the world);
3,686 sectors replaced, 5,889 descriptions added. Inside a matched zone coverage is near-total
(IceCrag: 216 of 219). It is a *partial* source and always will be — only 21% of Toril's distinct room
names occur in Duris at all.

**Two consequences that reshaped the phase mid-flight:**

1. **The zones we were playing in are Duris-orphans.** Zone 260 had 3 of 98 rooms with a name Duris
   knows (2% overlap, 1.0× margin — noise); 261 had zero. Harvesting produced *nothing visible* until
   the loaded set changed. `world.config.json` now loads **36 IceCrag Castle** and **168 Kobold
   Settlement** alongside them, and spawns on IceCrag's approach road. Adding a zone is data, not
   code, which is exactly what that config exists for.
2. **Sanctuary is inns, and nothing else.** The owner's rule: *"the only safe rooms should be inns. If
   you wander out of the inn you are in the world of the MUD and it comes with all the dangers."*
   That turned out to be the only rule that yields any sanctuary at all — `ROOM_SAFE` is set on **11
   of Duris' 781,053 rooms** and none is in a matched zone, while `ROOM_INN` gives two reachable ones.
   `peaceful` and `death_trap` have no upstream source whatsoever and stay empty. Temples and churches
   may be sprinkled in later as *authored* content — see the parking lot.

#### Act I amendments

Two changes landed after Phase 3 closed, recorded here rather than as phases of their own because
neither is a new mechanic — both are the same mechanic finally working. Kept in Act I because that is
where the work belongs in the story of the project, not appended to the end where it would read as
unrelated.

- **Vertical travel was broken, and invisible.** `Q`/`E` required `Shift`, and the step was read by
  polling `JustDown` in `update` *before* checking whether Shift was down — so the edge was consumed
  and discarded, and pressing the direction key a frame ahead of Shift lost the step silently. At
  60fps that is a 16 ms coin flip on a chord pressed as one gesture. Now: `Q`/`E` need **no modifier**
  (there is no way to steer vertically, so there is nothing for Shift to disambiguate), and the step
  is driven by the keydown event reading `event.shiftKey`, which removes the race at the root instead
  of widening the window. The compass keys still require Shift, because unmodified they steer.
- **Stairs are a 3x3 landmark, placed differently in every room.** They were a single marker tile on
  the room centre — invisible at play zoom, and always exactly where an arriving character lands.
  Vertical travel is the one movement the map *cannot* draw as a corridor (the far side is a different
  Place), so it has to be a landmark instead. Up and down now render as different tiles. Placement is
  a **hash of the room id**, not `Math.random()`: the client and server each build their own grid, and
  a block one tile apart on the two sides is terrain one of them will not let you stand on.

---

### Act II — Bodies

The character stops being a camera with a name. This act is where most of the load-bearing work
lives, so each phase is paired carefully with what proves it. Complete.

#### Phase 4 — Posture and status ✅ **done**

- **Mechanic.** Two orthogonal axes in `shared/src/position.ts` — `posture`
  (prone/sitting/kneeling/standing) and `status`
  (dead/dying/incapacitated/sleeping/resting/normal) — each an ordered ladder, compared
  **independently**. That is Duris' `MIN_POS`, which tests each half against its own minimum. Commands
  `stand`, `sit`, `kneel`, `rest`, `sleep`, `wake [someone]`.
- **Seen when.** `sit` then `north` answers *"You would have to stand up first."*; the HUD names your
  stance while it is worth naming; `sleep` while standing reads **"asleep on their feet"**. ✅
- **Carries.** The legality gate, at the dispatcher seam Phase 2 built for it. Every command declares
  a minimum on both axes in `COMMAND_REQUIREMENTS` and **that table is read in exactly one place**, so
  a new command cannot forget to check and an old one cannot be gated twice with two answers.
- **Why here.** Rule 2 exactly: it changed the signature of ~15 commands, and Act III/IV will add many
  more.

**Two things worth knowing.**

1. **Status is not a pure function of hit points**, though it is usually described as one — including
   in `REFERENCE-mud-mechanics.md` §1.3. `calculate_ch_state` is a *transition*: a fight force-wakes a
   sleeper, and recovering from the floor lands you at `resting`, never straight at `normal`. Treating
   it as a pure function would make `sleep` a command that appears to work and silently undoes itself
   on the next tick.
2. **Movement requiring `standing` is a deliberate divergence.** Duris gives movement
   `STAT_NORMAL + POS_PRONE` — any posture — which is fine when a room is a point and moving is a
   teleport between points. We have continuous steering, and a seated character gliding across the
   floor is a rendering fault rather than a mechanic. Gated in `Simulation.canMove`, mirrored to the
   client so prediction does not slide a sprite the server will hold still.

**Deferred, and why.** `update_pos`'s forced collapse — the rolls that make a wounded stander fall
over — needs hit points to move, which needs combat (Phase 11). Building it now would mean writing a
mechanic with no way to fire it, which is the failure this roadmap exists to avoid. `refreshStatus` is
the seam it will hang from and has a test.

#### Act II amendment — the key reference folds away

Not a phase: the top-right key card is a reference, not a HUD, and has a lifecycle a HUD does not —
indispensable for ten minutes, clutter for every hour after. It now collapses to its own title on a
click and remembers the choice in `localStorage`. Only the title bar takes pointer events; the rows
stay click-through, because the panel sits over the map.

#### Phase 5 — Health that moves ✅ **done**

- **Mechanic.** `shared/src/vitals.ts`. Regeneration as **fractional per-tick accumulators**, with
  rates from `limits.c` where **both position axes multiply**: status (`resting` ×1.25, `sleeping`
  ×1.5) times posture (`prone` ×1.25, `sitting` ×1.125, `kneeling` ×1.0625). `dying` and
  `incapacitated` are *absolute and negative* — −2 and −1 a minute — so the dying window is a clock,
  not a state. Persist the **wound** (`maxHp - hp`), never the value.
- **Seen when.** Walking drains the movement bar by terrain; `rest` refills it visibly faster than
  standing, and `sleep` faster again. ✅
- **Carries.** Movement point cost — `SECTOR_MOVE_COST` had been written, tested and **called by
  nothing** since the beginning, and `move`/`maxMove` were documented as decorative. Both are real now.
- **Why here.** It is what makes Phase 4 mechanical rather than cosmetic: the two-axis table is the
  reason posture exists.

**Two corrections to this phase as originally written.**

1. **Movement cost moved here from Phase 16.** Without it nothing damages a character, so regeneration
   had nothing to do and no bar would ever have moved — the phase could not have met its own
   completion test. Phase 16 keeps encumbrance and gets cheaper.
2. **The event scheduler is *not* carried here, and that was a mistake in the plan.** A scheduler earns
   its keep on sparse, future-dated work — a spell landing in three seconds, a per-actor combat clock,
   an item decaying in an hour. Regeneration is the opposite: every character, every tick, and we
   already have that loop. Building a queue for a consumer shaped like a loop is the abstraction this
   roadmap's rule 1 exists to prevent. It moves to Phase 11, where per-actor combat clocks are its
   first honest consumer.

**And one deferral.** The **affect system** does not ship here either. Its only real consumer today is
the carried light's burn timer, and collapsing carried light into a general derivation is already
Phase 16's job, where equipment makes it necessary. Building it now would mean building it twice —
once against a bespoke field and again against equipment. It has its own phase below, placed before
combat, which is the constraint that actually matters (`REFERENCE-mud-mechanics.md` §1.4: *"the cost of
adding it later is rewriting all of them"* — and "them" is combat states, buffs, poison and cooldowns,
none of which exist yet).

#### Phase 5b — The affect system ✅ **done**

Numbered `5b` rather than renumbering everything after it: the phase numbers are referenced by name
throughout these docs and in the code comments, and shifting sixteen of them to insert one would
invalidate every one of those references to no purpose. It is Phase 5's deferred half, and the label
says so.

- **Mechanic.** `shared/src/affects.ts`. One primitive for every timed modifier: `type`, `duration`,
  `modifier`, an `apply` selector, boolean flags. One list, one expiry pass, one persistence path, one
  removal path, one display path. Plus **full recompute from base** — no `unapply()`, ever;
  `Simulation.recompute` is the single derivation point and is this project's `affect_total`.
- **Seen when.** `rest`, and watch **`settling into rest · 0:24`** count down in the HUD; it turns into
  **`second wind`**, the health bar visibly fills faster, and a minute later it fades and the rate goes
  back to exactly what it was. `affects` prints the same list in the log. ✅
- **Why before combat.** Combat states, threat, poison, cooldowns and every buff are all instances of
  it. The cost of adding it after them is rewriting all of them.
- **Its first consumer.** The carried light's burn — which **deleted** a bespoke timer rather than
  adding a parallel one. `Player.lightRemainingMs` and `Player.lightWarned` are gone, `light` is now
  derived, and `PlayerStore` lost a bespoke pair of fields for one list. That was the test of whether
  the primitive was general enough, and it passed: the light is one row in the same table the rest
  cycle uses.

**Two things the second consumer was chosen to force.** The light migration exercises duration, expiry,
the expiry chain, persistence and display — but nothing in it would have populated `modifier` or
`apply`, which is the half combat and every buff will actually use. So the phase also ships the rest
cycle: half a minute of unbroken rest buys a minute of flat regeneration, and if you are still sitting
when it lapses the wait begins again. It is deliberately **three affect nodes of one type**, one per
pool, because §4.12's *"`type` is not a key"* only stays true in code if something really installs a
run — and it is the reason `removeType` and the display path both work on groups.

**Three divergences from the source, all deliberate.**

1. **One clock, not two.** Duris carries ordinary durations in game hours and `AFFTYPE_SHORT` ones in
   pulses, in the same field, with a scheduled event owning the short half — which is why removing one
   early has to find and neuter its event, and why that handler must re-verify both that the character
   is alive and that the affect is still listed or it is a use-after-free. We have no coarse hour clock,
   so there is no split, no second owner, and none of that hazard.
2. **The rebuild is immediate, not a coalesced delay-0 event.** Duris defers because its fold walks
   ~165 boolean flags and every worn item; ours walks a list of at most four. `recompute` names the spot
   where a delay-0 event belongs the day Phase 16 makes the fold expensive.
3. **`dead` is a hard zero for regeneration.** Duris reaches the same place via `die()` removing the
   character before the tail clauses run; we say it outright, because with a bonus in play `gain = 0`
   plus a modifier would have a corpse healing.

**Faithfully kept, though, is the part that is easy to mistake for a bug:** a flat hit-point bonus
lands *after* the position multipliers and applies **even while dying**, so regeneration really can slow
a bleed — and `if (gain == 0 && GET_STAT < STAT_SLEEPING) gain = -1` exists precisely so it can never
produce a stable unconscious body. The dying window stays a clock. Movement and mana take the opposite
rule (`if (gain || move_reg < 0)`): a zeroed pool stays zeroed, so nobody recovers stamina from having
had a good sit down while bleeding to death.

**The one thing knowingly left inert.** `AffectFlag.Offline` — "keep counting down while logged out" —
has a reader in the save loader and no setter. It is there so a later cooldown or PvP timer cannot be
dodged by closing the tab, and the alternative was a special case in the loader later. It is listed on
`HANDOFF.md`'s inert surface so it cannot quietly become furniture.

#### Phase 5c — Terrain that stops guessing ✅ **done**

Promoted out of the parking lot (the intake test placed it, not enthusiasm): every zone loaded from
here on benefits, it is purely offline, and the sectors it fixes now feed a live mechanic —
`SECTOR_MOVE_COST` has had a caller since Phase 5, so a wrong sector is a wrong walking cost, not
just wrong artwork.

- **Mechanic.** Three stages in `worldgen`, each catching what the previous cannot. **Words**
  (`terrain.ts`): the old table's biggest misses were mundane — no plurals (`\btunnel\b` fails on "a
  Maze of Tunnels", 546 rooms), missing vocabulary (`labyrinth`, `sewer`, `way`, `office`), and it
  ignored the zMUD mapper's own literal "(Water)" / "(No Ground)" annotations. **Suffixes**: compound
  place-names — Night**wood**, Ever**moor**, Skull**port**, Hul**burg** — which no `\b` word rule can
  see into; the table is short and high-precision because these seed the next stage, and `-ice` is
  the cautionary example (it classifies "An Off**ice**" as glacier). **Graph label-diffusion**
  (`diffuse.ts`): every room the rules still cannot name takes the majority sector of its labelled
  neighbours, seeded by the name rules *and* the Duris harvest, iterated synchronously to a fixpoint.
  "A Bend in the Passage" is deliberately vocabulary-free — a passage between city rooms is city and
  one between cave rooms is cave, and only the graph knows which.
- **Seen when.** The Stump Bog's rooms are swamp and standing water rather than generic field —
  walk them and the movement bar drains at swamp prices. ✅ (verified on the wire and in the running
  game: two steps cost 16 movement.)
- **Carries.** `DURIS_SECTOR` extended from 24 to all 40 Duris sector values. Phase 3's claim that
  "Duris has no swamp or arctic" was **this table's gap, not the data's** — the values are late
  additions the old mapping stopped short of, and 47k rooms' worth of evidence (5,162 arctic, 6,558
  swamp, 18k underworld-mountain) was being silently dropped. The blind-spot rule survives with its
  premise corrected: old zones predate the late sectors, so a Duris `field` against our `road` is
  still a builder with no word for it *at the time*.
- **Why here.** Cheap, offline, and every later phase that loads a zone inherits it. Before mobs
  (Phase 8) matters most: spawn tables will be authored against terrain, and terrain that is 23%
  placeholder would bake the guesswork into content.

**Measured, before → after.** Default-sector share **23.2% → 0.2%** (the parking-lot prototype
claimed 1.2%; the shipped version reaches 94 unreachable rooms out of 46,508 — components with no
seed at all). Word coverage 65.3% → 77.8% of rooms; suffixes add 3.0%; diffusion fills the remaining
7.6% from context in 22 rounds. Output is byte-identical across runs — no RNG, synchronous voting
rounds, ties broken by the zone's seed histogram then alphabetically.

**Accuracy, stated honestly.** Coverage is not correctness, so the report now validates against the
one ground truth we have: rooms the name rules defaulted but Duris settled are re-predicted blind
and compared. **15.7% agree exactly; 24.6% under the harvest's own blind-spot rule** — low, and the
confusion matrix says why without saying it is fine: the misses are overwhelmingly indoor-flavour
disagreements (`cave` vs `inside` vs `city`) in dungeon zones, where Duris' own vocabulary is coarse
— it has **no cave sector at all**, so everything roofed is `inside` there. Against the old
behaviour the comparison is still one-sided: blanket `field` scores ~10% on the same test and is
wrong *uniformly*, where diffusion's answers are at least locally coherent. The number is printed by
every `npm run worldgen` so it cannot quietly rot.

#### Phase 6 — The engagement decision ✅ **done**

- **Mechanic.** Not code — a written decision. It got **its own doc**,
  [DESIGN-engagement.md](DESIGN-engagement.md), rather than a section of the mobs design: it gates
  Phases 11–14 entirely, and the most load-bearing combat decision in the project should not be §2.6 of
  a document about mobs, which is exactly how it gets missed.
- **Seen when.** The doc exists and answers all three: what happens when a fighting character walks
  away (§4), what breaks engagement (§5, enumerated), and what "in combat" forbids (§6, a transcribed
  table). ✅
- **Carries.** Nothing. It is the one phase with no visual, deliberately, because it is a page of
  writing and half a day.
- **Why here.** A room is crossable in 2.4 s against a 3 s round. A range check per swing silently
  chooses action-RPG combat and quietly kills threat, tanking and rescue — and it does so *without
  anyone deciding it*. This gates all of Act IV and must not be discovered during it.

**What the source turned out to say, which is better than what would have been invented.** Reading
`set_fighting`/`stop_fighting` rather than reasoning from the phrase "a relationship between two
entities": engagement is **one directed pointer per actor**, and the *inbound* set is derived by
scanning. `set_fighting(ch, vict)` never touches the victim's pointer — mutuality is emergent, which is
why the mercy rule has to scan for everyone targeting the fallen character instead of reading a
participant list. Retargeting is stop-then-set, never set-again, which is what Phase 12's threat
switching has to call.

**Three decisions the phase had to make itself.**

1. **Movement while engaged — our one divergence.** Duris registers all six directions `CMD_N`,
   forbidden while fighting, because there a room was a point and "cannot move" and "cannot leave" were
   the same rule. We have continuous steering and sticky engagement makes intra-room position
   mechanically irrelevant, so: **steering works, every exit is refused.** Same divergence Phase 4 made
   for `canMove`, and for the same reason — a character rooted to the spot for a whole fight reads as a
   hung server, and we keep the rule the restriction was protecting rather than the restriction.
2. **No engagement timeout, ever.** A clock that lapsed engagement after inaction would be a free
   disengage available by standing still, which is the exact thing stickiness exists to prevent. It ends
   on an event.
3. **Pursuit stops at a `Place` boundary** — `DESIGN-mobs-and-movement.md` §2.5's open question, now
   closed. It gives the world's portal structure a tactical meaning it did not have, and a staircase
   counts, because a level change *is* a `Place` change.

---

### Act III — Life

The world stops being empty. This is the act with the largest visible payoff per unit of work.

#### Phase 7 — Something else is in the room ✅ **done**

- **Mechanic.** `Player` split into **`Actor`** (anything with a body) plus `Player` (an actor with a
  client) and `Mob` (an actor the world drives), all in **one map** with a `kind` discriminator. Then one
  hand-placed, motionless mob — a sentry from IceCrag's own roster — rendered as layered LPC.
- **Seen when.** You walk into The Base of Ice Crag Cliffs and there is nobody there; two steps
  north-east and a sentry in mail is standing against the cliff. He goes through the same
  `visibleEntities` gate you do. ✅
- **Carries.** The actor generalisation itself, and it paid immediately: **`viewOf` has no branch on
  `kind`** beyond passing it along, so a mob is named, health-barred and posture-described by the code
  that already did it for players.
- **Why here.** Before mobs, not during — and it is the first moment the game looks like a game to
  someone watching over your shoulder, which it now does.

**One map, and the measure of whether it worked.** Two maps would have meant every pass over the world
either iterating both or quietly forgetting one, and the one it forgets is always mobs, because mobs came
second. With one map, "everyone" is the default and "only players" is the thing you ask for by name — so
the honest metric is *how many places have to ask*. **Ten**, and each is a place a mob genuinely cannot
go: steering intent, a walked route, the lit set and its invalidation, the relit queue, `wake`'s reply,
the movement pass, log recipients, and the two halves of `relocate`. Everything else — regeneration,
affect expiry, presence, the visibility gate, `viewOf` — walks `Actor` and never asks.

**The visibility gate needed one word.** `visibleEntities` changed `playersIn` to `actorsIn`; `canSee`
already asked the right question of any body, because it tests the subject's *tile* against the
observer's lit set and a tile does not care what is standing on it. So the sentry is hidden by unlit
ground and revealed by a torch through code that was already running, with **no new message type and no
new gate** — which is what "same visibility gating" was supposed to buy.

**The `dark` room flag is still inert, and did not need to change.** Being unseen is the fog doing its
job: a body six tiles away is standing on ground you have no light on. Measured in the running game — walk
into his room at the bare radius 2 and he is not mentioned at all; `look` does not find him either; two
bursts of walking toward him and he appears.

**The art is real LPC, and both figures use it.** The player's coloured circle is gone: player and sentry
are both layered `Body/Base/Human_male` with clothing over it — slacks and a shirt for the player, mail
and greaves for the sentry — with facing driving which of the four sheet rows is drawn. Two details cost
real time and are worth knowing: **LPC's row order is north/west/south/east**, not Diku's
north/east/south/west, so the mapping is written out rather than indexed; and the **body sheets are two
frames wide where the mail and greaves are one**, so the column stride is read per texture. A hardcoded
stride draws a west-facing body under a north-facing shirt, which reads as a movement bug.

**Content is data, as the rules require.** The sentry is a placement in `world.config.json` — `CLAUDE.md`
forbids world content in an engine package — validated loudly on load, with the tile offset expressed
*inside* the room so a regenerated world cannot move him. Phase 8 replaces that array with mob templates
and zone reset tables, at which point the boot loop that reads it is deleted rather than extended.

#### Phase 8 — A populated world ✅ **done**

- **Mechanic.** Mob templates and reset tables **harvested from the Duris `.mob` and `.zon` files**, then
  spawning that is **additive**, limited per vnum, and clocked on a lifespan re-rolled from each zone's own
  band. Repop adds; it never restores an authored snapshot.
- **Seen when.** IceCrag Castle has 92 inhabitants where its builders put them. You kill nothing yet, but
  walking the map is a different experience — verified live: climbed the cliff road into the castle, swept
  the dark arch by hand, and found *a sentry, level 31*. ✅
- **Why here.** Reset semantics are easy to get subtly wrong (§4.9) and much cheaper to get right before
  mobs have state worth preserving.

**The Seen-when had to change, and Phase 3 set the precedent.** It named zones 260 and 261, but those are
Duris-orphans — 3 of 98 and 0 of 93 rooms join — so no `.mob` or `.zon` data can reach them at all. Phase 3
hit the identical wall and changed the loaded set for the identical reason. IceCrag is the zone that can be
populated from real data, and it is.

**The problem that made this a phase rather than an afternoon: reset tables name rooms by *Duris* vnum.**
Phase 3 established the room join is by *name* because the two worlds renumbered independently, which is
fine for terrain — the answer lands on the room you already have — but a reset command says *"load mob
97052 into room 97002"* and 97002 is a number we do not use. The name join supplies the pairs; what it does
not supply is uniqueness, because **116 of IceCrag's 216 joinable rooms share a name with another** ("A
Corner In the Ice Garden" exists four times). Picking one arbitrarily would cluster four mobs into one
corner.

So duplicated names are **paired positionally**, and the justification is measured rather than asserted: of
IceCrag's 37 duplicated names, **37 have exactly the same count on both sides.** Duris has four Ice Garden
corners and so do we. Sorting each side and zipping puts one mob in each — faithful as a *distribution*
even where it cannot be faithful about which corner is which, and for placing population that is the
property that matters.

**Measured yield, stated honestly.** Across all 49 matched zones: 1,503 templates kept of 2,936, 2,016 mob
spawns and 1,278 door resets translated, and **73.5% of reset commands dropped** for want of a room. That
is the same partial-source story Phase 3 told, one stage further on. IceCrag alone: 61 templates, 92 spawns,
18 doors, lifespan 55–65 ticks — so 68 to 81 minutes, never twice the same.

**Both of §4.9's subtler traps are implemented and tested, and the first is genuinely surprising.** An `M`
command below 100% **never fires on a timed repop** — the source's gate is
`if ((number < limit && arg4 == 100) || force)` — so mob spawns are deterministic in practice and
*equipment* is the random layer. That is the rare-drop mechanic, and it arrived by accident. Measured: all
332 harvested `M` commands are at 100, so nothing is lost by honouring it exactly. The second trap is the
chain cursor: an unimplemented command between two `M`s must not read as a failure, or one piece of a mob's
kit failing its roll silently suppresses the sword below it.

**Object commands are parsed and carried, not executed.** 773 `object`, 172 `put`, and the `give`/`equip`
rows wait for items in Phase 15. Keeping them is not idle completeness — `G`, `E` and `P` attach to *the
last mobile loaded*, so an executor never told they were there would lose the cursor and mis-attach the
first item Phase 15 turns on.

**Kobold Settlement is harvested and deliberately switched off**, which is a `populate` line in
`world.config.json` and not a code path. Its 39 surviving templates are kobolds, and Duris tags them with a
*humanoid* race code — so the race filter that correctly dropped its cows and chickens cannot catch them,
and they would all render as men. It switches on the day there is creature art.

**Phase 7's config array was deleted, as this phase's entry promised** — `MobPlacement`, the `mobs` array
and the boot loop that read it are gone, replaced by templates and reset tables. The hand-placed sentry was
superseded by IceCrag's own.

#### Phase 9 — It notices you ✅ **done**

- **Mechanic.** Aggression as a **predicate**, not a boolean — three dispositions. Delayed reaction
  (`reactionMs`) with **revalidation when the timer fires**, not when it is set. Mob memory keyed on
  the character.
- **Seen when.** You step into a room, a beat passes, and the thing turns toward you. Step back out
  within the beat and it does not. ✅ — verified live against *Malice, the half-breed son of Strife*
  (level 60, 1300 ms) in IceCrag's frozen gazebo, 40 rooms from the spawn point.
- **Why here.** Reaction time is what makes a room enterable and leavable rather than a trap, and
  memory is what turns an encounter into a relationship. §4.5 is explicit that instant aggression is
  the common mistake.

**The live verification is worth recording, because two of its three results were initially wrong for
reasons the 244 unit tests could not reach.**

| Claim | Measured |
| --- | --- |
| The reaction is a delay, not a frame | within 6 tiles at +18755 ms, noticed at +20070 ms — **1315 ms** against 1300 ms authored, i.e. one tick of granularity |
| Passing through is free | crossed into his room, **561 ms** inside it at 1.4 tiles, left — never noticed |
| …and that is the window, not a broken probe | *control*: same character, same threshold, stood still — noticed after **1262 ms** |
| It turns toward you | `facing south -> east` |
| Noticing is a transition | silent for a further 6 s |

**The dip test needed a control, and the first version of it was a false pass.** The mob *remembers*, so
`announceNotice` returns early for a character it has already announced — meaning "did it notice me" is
observable exactly **once** per character. The first probe swept the room to find him, which put it inside
his six-tile reach for seconds, and then reported the dip as a pass because no *new* line arrived. The
rebuilt probe does the dip across the **room boundary** — `perceives` gates on room before distance, so
next door is unperceived at any range — and ends by crossing in and standing still, which must produce a
notice or the silence proves nothing.

**It found a real defect: the turn never reached the client.** `syncEntities` is a *membership* diff —
`entityEnter` for whoever became visible, `entityLeave` for whoever dropped out, and **nothing** for an
entity that was visible before and is visible now. The tick's `entityMoved` batch is built from the
*players who moved*, and a mob that turns is neither. So a mob's `facing` reached a client only in its
`entityEnter` payload, and `turnToward`'s whole claim — that a mob turning toward you is a change on
screen rather than a line of text asserting one — was true in the simulation and false on the wire. Fixed
with `syncTurn`, which sends the mob's unchanged position and new facing to observers already watching it.
Unit tests could not have caught this: they assert the simulation, and **there is no wire-level test
harness** because `index.ts` starts a server on import. That gap is now the known reason.

**Reaction time is a stand-in and is documented as one.** Duris derives it from agility, which lives on
the *enhanced* `.mob` record; all 66 of IceCrag's mobs are the *simple* form, so the number is not on disk.
Level substitutes: 2500 ms base, −20 ms per level, 800 ms floor. A room crosses in about 2.4 s, so even the
sharpest mob in the world can be run past — which is the property §2.2 wants, and the only one that matters.

**Locked doors had to stop locking, and that is a Phase 15 gate rather than a design choice.** Honouring
the authored locks left **25 of IceCrag's 219 rooms** reachable and sealed all 13 aggressive mobs behind the
castle's front door, which the zone's very first reset command closes and locks. Measured across the shipped
world: **42 of 156 doors are locked and 0 carry a `keyId`** — worldgen has never harvested key ids, so a lock
is not a puzzle missing its piece but a wall that reads as a door. Nothing can be carried (Phase 15) and
nothing can be picked (Phase 19). So `LOCKS_HOLD` is off: locks are loaded, kept, shown by `exits` and
consulted by `open`, and cleared both at load and on every repop. Doors still shut, and still have to be
opened — five of them on the route to Malice.

#### Phase 10 — It follows you ✅ **done**

- **Mechanic.** Hunting and pursuit across the room graph, respecting `safe` rooms from Phase 3.
  **Mobs move at all** — this is the phase that gives them legs.
- **Seen when.** You retreat and it comes through the doorway after you, and keeps coming until its
  own rules say stop. ✅ — *"Malice, the half-breed son of Strife, arrives from the west."*, 1243 ms
  after fleeing his gazebo.
- **Why here.** Pursuit is what makes the room graph matter tactically, and it is the last piece of
  mob behaviour that can be built and watched *without* combat existing.

**The Seen-when's sanctuary clause had to go, for the third time in this project and the same reason.**
`respectsSafeRooms` is built and unit-tested, but it cannot be *shown*: `safe` is set on **exactly one
room in the shipped world** — 41238 "Grumbiter's Inn", in Kobold Settlement, which is not populated —
because Duris sets `ROOM_SAFE` on 11 of its 781,053 rooms. Authoring sanctuaries by hand is already
scheduled in §4's intake table for after this phase, and that is still where it belongs. Phases 3 and
8 amended their Seen-when lines on the same grounds.

**Assist and call-for-help moved to Phase 12**, where there is a blow for them to answer. See that
phase for the reasoning; the `ACT_PROTECTOR` data is harvested and waiting.

**Policy and motion are separate layers, and keeping them apart is the design.** The room graph answers
*which exit* — a breadth-first search, which is `find_first_step`'s own shape — and the tile grid answers
*how do I get there*, through the same `stepMovement` and the same collision a player walks with. A pure
tile-space chase was the tempting shortcut and it is wrong twice: tiles do not know what a room is, so it
would chase you *through* a sanctuary rather than stopping at the threshold, and it would home in on a
position rather than take an exit. A pure room-graph hop is wrong the other way — it teleports a body
between room centres, which in a game you can watch reads as a bug.

**The source specified more of this than expected, and three of its four flags are traps** —
`REFERENCE-mud-mechanics.md` §4.11 is about this exact branch:

| Flag | The trap |
| --- | --- |
| `ACT_HUNTER` | **Does nothing without `ACT_MEMORY`.** The whole hunt is inside `if (IS_SET(act, ACT_MEMORY))`, so a HUNTER alone is a mob that looks configured and never moves |
| `ACT_SENTINEL` | **Not "immobile".** The source reads `if ((SENTINEL \|\| STAY_ZONE) && zone differs) return` — a *zone leash*. A sentinel hunts you happily; it just will not leave home |
| `ACT2_NO_LURE` | Opts out of hunting entirely, whatever else is set. Not in the simple `.mob` header, so it cannot be read from the zones we load |
| `BFS_AVOID_NOMOB` | Set on every hunt: a hunter **routes around** `no_mob` rooms rather than stopping at them |

Harvested from IceCrag: **34 of 66 carry HUNTER, 56 carry MEMORY**, and it is the intersection that hunts
— 30 templates, of which 6 are also aggressive. 26 are `zone`-tier and **4 are `relentless`**, including a
gigantic werewolf that never gives up on time.

**One number is worth stating plainly: `PULSE_MOB_HUNT` is 6 pulses, and a pulse is 0.25 s, so a hunter
takes one room every 1.5 s.** A player crosses a 9-tile room in about 2.4 s at `PLAYER_SPEED` — **so a
hunter gains on you.** You cannot stroll away from one, which is what makes doors, distance and the edge
of a Place the counterplay rather than decoration. `trackRooms` and `giveUpMs` are *ours*: Duris caps its
search at `BFS_MAX_ROOMS` (12,000 — a runaway guard, not a leash) and never gives up on time at all,
which is right for 781,053 rooms and wrong for a zone of 219.

**A live ordering bug, found in the first chase and not by any test.** The arrival line is gated on what
the observer can see, read from `watching` — and `watching` is not updated until `syncEntities` runs later
in the same tick. Announcing when the hunt advanced therefore caught every observer exactly one tick too
early and printed nothing: the mob walked into the room on screen and the log stayed silent. The
announcement now runs after the entity sync, and the ordering is commented at both ends. This is the
second wire-level bug in two phases that only a running game could show, both for the same underlying
reason — `index.ts` starts a server on import, so none of it is unit-testable.

---

### Act IV — Violence

The largest system, and the one Phase 6 exists to protect.

#### Phase 11 — Blows land ✅ **done**

- **Mechanic.** Engagement as state per Phase 6. A **per-actor round clock**, not one global round.
  Auto-attacks resolved through `resolveAttack` and `rollDamage` — written and tested since the
  beginning, never once called.
- **Seen when.** You attack, the log rolls the dice where you can read them, and a health bar drops. ✅
  — *"You hit a sentry for 3 damage. [d20 17 → 19 vs AC 8]"*, with the mob's own bar shrinking over its
  head and turning amber as it goes.
- **Carries.** The **event scheduler**, moved here from Phase 5. A per-actor round clock is its first
  honest consumer: sparse, future-dated work with one timer per combatant, which is exactly the shape
  a queue is for and exactly what regeneration was not. The command input queue from Phase 2 lands on
  it too.
- **Why here.** Per-actor clocks are the thing that is nearly impossible to retrofit (§4.1), so the
  first swing must already have one.

**The two decisions Phase 6 exists to protect are both pinned by a test that says so in its own name.**
`combat.ts` contains **no distance check anywhere**: engagement is a pointer, so blows land wherever in
the room either party stands, and the only way out is an event. And the round is `Actor.roundMs`, not
`ROUND_MS` — a fast actor genuinely interleaves swings between a slow one's, which a single global round
cannot express without collapsing every speed stat into "extra attacks".

**Two of the three `.mob` combat columns are trustworthy and the third is a lie.** `db.c` `fscanf`s the
hitroll and overwrites it on the very next line — `BOUNDED(2, level >> 1, 25)` for warriors and elites,
`BOUNDED(0, level / 3, 25)` otherwise — so the number in the file has been ignored since 1995, and reading
it literally would be actively wrong: IceCrag's is often *negative* on its best fighters. Armour and
damage dice are real. Armour also runs the other way — Duris keeps AD&D-descending −250…250 — so it is
flipped and scaled into an ascending SRD class: measured on the zone's own numbers, 74 → AC 3 (a servant
in cloth), −122 → AC 22 (Malice, in the plate-and-shield band).

**Two rules the owner corrected mid-build, and both are better than what was written:**

- **Mercy is a player's protection; a mob fights to the death.** A character who goes down enters the
  dying window — alive, findable, rescuable, and Phase 13's subject. A mob has no such window in play, so
  stopping at "incapacitated" would leave a creature standing at −4 hit points that nobody is allowed to
  finish. So a player stops being a target the moment they are incapacitated; a mob stops only when dead.
- **A body that cannot defend itself is never missed.** No dodging, no parry, no armour roll against
  something already on the floor. The d20 is still rolled and still printed — a fight has to stay
  auditable — but it cannot produce a miss, and a natural 1 is not a fumble. The SRD reaches the same
  place from the other direction; its automatic-critical half is deliberately *not* taken, because
  doubling every finishing blow makes the last hit of every fight the biggest number in the log.

**The dying window was nearly built as dead code, twice over.** Damage was first clamped at zero hit
points — but Phase 4's thresholds are negative in the Diku manner (`incapacitated` at −3, `dying` at −6,
`dead` below −10), so a floor of 0 made the entire ladder between standing and dead unreachable and the
mercy rule unfireable. And without the mercy rule at all, auto-attacks cross the threshold and keep going,
so the interval between standing and dead is one tick nobody ever sees.

**Mob health bars were the rendering half of this phase's own Seen-when.** `EntityView.healthFraction`
had been on the wire since Phase 7 and **no client code read it**, so "a health bar drops" was true of the
protocol and false of the screen. Bars now show above every body but your own — yours is already in the
vitals overlay in numbers — and are hidden at full health, so a castle of ninety-two untouched servants is
not ninety-two green bars.

**A field is reserved that nothing can populate yet, on purpose.** `attackResolved.outcome` admits
`dodged`, `parried`, `blocked`, `absorbed` and `resisted` alongside the four that exist. Those are defence
skills (Phase 19) and spells (Phase 20) — but §4's first question is about signatures, and a reason on a
combat message costs one optional field now against a rewrite of every message site, client renderer and
replay later.

**Testing switches, all default-off and all announced at boot.** `GAME_DEV_LIGHT` grants a light —
`glowing_ring_of_testing` lights the room and its neighbours entirely — `GAME_DEV_LEVEL` gives a
survivable stat profile, and `GAME_DEV_DAMAGE` overrides the weapon. They exist because a level-1
character has 9 hit points and IceCrag's weakest inhabitant has about 150, so without them every combat
mechanic is observable for roughly six seconds. **They are a test rig and not a progression** — see §4's
entry on character progression, which is the real work these stand in for.

#### Phase 12 — Threat, and the room that comes to help ✅ **done**

- **Mechanic.** The threat table with hysteresis from `DESIGN-mobs-and-movement.md` §2.6. Target
  selection, and switching that costs something. **Plus assist and call-for-help** — `callsForHelp`
  and `assistRange` from §2.5, and Duris' `ACT_PROTECTOR`.
- **Seen when.** A mob visibly holds its target, and you can watch it change its mind — the combat
  indicator on the entity says who it is on. Strike one of a pair and **both** come at you. ✅ —
  *"A sergeant assists a sentry heroically, and turns on you!"*, and a sentry that held its target
  against a second attacker of equal strength.
- **Why here.** Threat is what makes tanking a role without a class system, and it is the payoff of
  having chosen relationship-engagement in Phase 6.

**The one place this project knowingly picks a different rule from the MUD it is built on.** Duris has no
threat table: `PickTarget` scores every legal victim with `CountToughness` and takes the **minimum** — it
attacks whoever is *weakest*. That is a fine predator's rule and it cannot produce **tanking**, because
nothing a player does can make a mob prefer them. §2.7 chose a threat table instead. **Both rules are
kept, at different moments**: weakness picks who a mob *opens* on, when it has no history to read; threat
governs every switch after.

**Hysteresis is the mechanic, not a refinement.** A challenger must exceed the current target by 110%
before the mob turns. With a bare `>` two attackers of similar output make it spin every round, which
looks broken and makes holding aggro impossible. Verified live: two level-35 characters with identical
weapons, and the sentry held the one who started first.

**Three rules the owner set during the build, and each closed a real hole:**

| Rule | What it fixed |
| --- | --- |
| **A mob fights its aggressors, and nobody else** | Start a brawl in an inn, go down, and it must not round on the other drinkers. The fall-through picked *anyone reachable* — a bar fight would have spilled onto bystanders |
| **…but whoever waded in is an aggressor** | An assister is on the table, so the fight carries on with them. Both halves verified live |
| **Support is participation** | Threat keyed on *damage* would leave a healer off the table entirely — the front line dies and the mob **walks away from the person who kept the party standing for five minutes**. Presence and threat are now separate facts: an entry may sit at zero, and `pickByThreat` tests for presence, never for a positive score |

`joinBySupporting` is the seam a heal, a buff or a protection spell calls. Nothing calls it yet — spells
are Phase 20 — and it lives beside the table it writes to so the rule cannot be re-derived differently
next to the first spell.

**A bug live testing found that no unit test would have.** Retargeting ran only inside the swing loop, and
a mob whose target dies or disconnects has been *disengaged* — so it has no swing scheduled, and simply
stopped, standing in a room with somebody still hitting it. Found by disconnecting a tank mid-fight and
watching a sergeant lose interest in the entire room. There is now an explicit pass over mobs that have
fought and are not fighting.

**Assist is room-scoped, which is the source's own limit rather than a simplification.**
`find_protector_target` scans the people in the room and looks no further. §2.5's `assistRange` — a cry
for help carrying across several rooms — is a *different* flag, `ACT2_COMBAT_NEARBY`, in a second action
word the simple `.mob` record does not carry. Same wall `ACT2_NO_LURE` hit in Phase 10. Harvested:
**34 of IceCrag's 61 templates assist**, and 22 rooms hold a pair where at least one will.

**Assist moved here from Phase 10, and it is a scheduling change rather than a cut.** §2.5 defines
the call as firing "on engaging or **being hurt**", and §2.9 makes `assistRange` one of the three
numbers that *are* the encounter design — both of which are statements about a fight. In Phase 10
there is no engaging and no being hurt, so an assist could only have fired on noticing, which is a
different mechanic wearing its name. The data is harvested and waiting: **36 of IceCrag's 66 mobs
carry `ACT_PROTECTOR`**, and §2.9's pulling — `assistRange` against `aggroRange` against `reactionMs`
— becomes real the moment there is a blow to answer.

#### Phase 13 — Death and corpses ✅ **done**

- **Mechanic.** Death → corpse → **full loot** → corpse retrieval. Experience awarded from damage
  dealt *and taken*, not only from the killing blow.
- **Seen when.** Something dies, leaves a corpse sprite you can loot, and you gain experience for
  having held it rather than only for landing the last hit. ✅ — *"You have slain a sentry!"*, then
  *"You gain 5828 experience (272 dealt, 14 taken)"*, and a pile of bones on the floor that becomes a
  single bone once it has been gone through.
- **Why here.** Experience-from-damage is the single choice that makes tanking and healing viable
  with no role system (§4.4), and it is far easier to award correctly from the start.

**Experience is divided by contribution, and the breakdown is printed.** Three ways to earn a share —
damage **dealt**, damage **taken**, and support given — because a last-hit rule pays a tank and a healer
nothing and quietly makes solo damage the only way to play. Damage taken is worth exactly as much as
damage dealt: any discount there tells players that tanking is the lesser job. Support is paid per *act*
rather than per point, because paying by amount healed would make a healer's share depend on how badly
the tank was playing.

**The group divisor is written and unused, deliberately.** §4.4 is emphatic that almost everyone assumes
`exp / N` and that Duris divides by **`(N + 3) / 4`** — so party *total* rises with size and every member
still beats a fraction of solo, which is why MUD populations organise into parties with no matchmaking
anywhere. Grouping is Phase 18; `groupDivisor` exists now so that nobody reaches for the obvious wrong
formula on the day it lands.

**The experience pool is harvested, not derived.** The `.mob` record carries a real curve — 1,036 for a
level 15 castle servant against 243,000 for Malice — and any formula invented here would have flattened
twenty-five years of a builder's tuning into `level * something`. Coins sit in the same line and are
**not** taken: money is Phase 17 and a field with no reader is what rule 1 warns about.

**A corpse is a place, not a body.** The dead actor is removed from the simulation entirely and a corpse
takes its position — so the hunt, the threat table, perception and the combat round do not each need a
guard for "is this one actually dead", one of which would have been forgotten. It lies **where it fell**
rather than at the room centre, which is what makes walking back to a particular corpse a mechanic.

**The looted state is visible, which is the owner's rule and a good one.** A fresh corpse is drawn as a
pile of bones; one that has been gone through is a single bone. So "has anyone been here" is answerable
from across the room, and a corridor of corpses tells a story. The sprites are **generated in code**, as
the ground items are, because the vendored LPC set has no bones in it and `CLAUDE.md` requires that what
LPC lacks is drawn to match rather than borrowed from another style.

**`loot` is refused in combat**, by analogy with the source's `get` (`CMD_N`), and a corpse must be
*reached* rather than merely seen — it lies where its owner fell, which in a nine-tile room is routinely
across the floor. The refusal distinguishes the two cases, because "there is nothing here to loot" while
a corpse is plainly visible reads as the game being broken rather than as a reason to take three steps.

**Things come out of a corpse since 15b.** `lootCorpse` moves what fits into the bag and leaves the
rest, and `looted` was redefined from *searched* to **empty** — so a body still holding the one thing
you could not carry stays drawn as a pile rather than hiding it behind a picked-clean sprite. What
still comes out of nothing is a *mob's* corpse: no object data has been harvested, so the only things
on any floor are things a player put there. See 15c.

#### Phase 14 — Mercy and fear ✅ **done**

- **Mechanic.** The mercy rule (stop auto-attacking the helpless), the damage clamp that makes the
  dying window real, morale and wimpy, fleeing with a chance and a cost.
- **Seen when.** A wounded mob breaks and runs; you go *dying* rather than straight to dead, and can
  be saved. ✅ — *"A masonary craftsman tries to flee, but cannot get away!"*, and the round after,
  *"A masonary craftsman flees east!"*
- **Why here.** Without these, combat is a damage race. §4.6 and §4.7 are both about exactly this,
  and both are cheap once Phase 11's clock exists.

**The first two items arrived early**, inside Phase 11: building the dying window without the mercy
rule and the negative-floor clamp would have built it as dead code, and that phase says so. What
landed here is the *fear* half — `shared/src/morale.ts` for the numbers, `server/src/flee.ts` for
the attempt. What death *costs* is deliberately still not here; it needs progression's numbers to
mean anything and moved to Phase 14b with them.

**One `do_flee` for players and mobs**, which is the source's own shape: a player typing `flee`, a
mob whose nerve broke, and half a dozen Duris spells all reach the same function. Two copies would
drift, and the half that drifted would be the mob's.

**§4.7's trap, avoided by transcribing rather than assuming.** *"`wimpy` means auto-flee"* is what
everyone believes and it is wrong: on a player it merely suppresses your own auto-engagement while
hurt, and the only thing that actually runs away is a mob with `ACT_WIMPY`, below `level * 6` hit
points. So there is no player wimpy setting and there will not be one — a player leaves a fight by
typing `flee`, which is what §5 makes it.

**The threshold is absolute, and §2.8's "HP fraction" wording is what changed.** Hit points are
*rolled per instance* (Phase 8), so a fraction of `maxHp` would break two guards of one vnum at
different wounds — one at 180 and one at 240 — for no reason a player could ever read. The source's
flat `level * 6` breaks every guard of a template at the same number of points *taken*, which is
what makes "this one is nearly done" a thing you can learn.

**Failing to get out is not the same as being switched off.** A cornered coward fights on that
round, which is what stops "block the only exit" from being a way to disarm a mob. Seen in the first
live drive: the craftsman panicked, swung anyway, and left the round after.

**Our one divergence is §2.8's, and its predicate is a capability rather than a stand-in.** A mob
that can path flees **toward its allies**; the test is `pursues(rule)` — the same faculty hunting
needs — because fleeing toward allies *is* a room-graph search, so a mob that cannot search cannot
search toward anything either. `firstStepToward` was generalised into `firstStepWhere` for it, since
the destination is not known before the search runs: the question is which friend is nearest. It
lands well in the shipped world — of IceCrag's five placed cowards the Archivist's two assistants
run for help while the cleaning crew, the garden attendant and the mason scatter. **Verified live:**
the assistant in 5793 broke and ran *west*, into the room its colleague was standing in, with both
rooms to its east empty.

**Fleeing buys distance from the blow, not from the encounter.** A pursuer that can chase begins a
hunt on the spot — Phase 10's machinery answering Phase 14's exit, and our version of the source
rescheduling the mob half a second later *"to allow fast, but not impossible chases"*. Measured:
fled west from Malice, and *"Malice, the half-breed son of Strife, arrives from the east."*
**1,731 ms** later.

**Harvested honestly: 204 of 1,503 templates flee (13.6%); 8 of IceCrag's 61, of which 5 are
placed.** They are the castle's *staff* rather than its guards — cleaning crew, an ice garden
attendant, a mason, the Archivist's assistants. Nobody chose that; it is the builder's own flags
read back, and it is the kind of texture the harvest keeps producing for free. The count prints on
every `npm run worldgen` for the same reason the `safe` room count does: a morale mechanic that
nothing in the shipped world carries the flag for would look built and be invisible.

**A live bug no test could have caught, and the third of its exact kind.** The departure line came
out as *"Someone flees west!"* — `canSee` tests the subject's **tile**, and by the time the line was
rendered the body was already in the next room, so every escape was anonymous. The fix is to
snapshot who could see it while it was still standing there. Phases 9 and 10 each hit this same
ordering hazard once, for the same underlying reason: `index.ts` starts a server on import, so its
message-emitting layer has no test harness.

**Left for later, both by the same rule.** `courage` and `callsWhenAfraid` from §2.8 have no `.mob`
bit to read, so they are not built rather than invented — the wall `ACT2_NO_LURE` hit in Phase 10.
And the direction argument (`flee west`) is a rogue skill in the source (`SKILL_CONTROL_FLEE`), so
until Phase 19 flight is panicked by definition and the way out is not yours to choose.

**Riding along, at the owner's request:** `loot` now takes the **nearest unlooted** corpse, then the
next-nearest, and only then a looted one. A corpse lies where it fell, so three dead guards leave
three on the floor — and taking whichever the graveyard happened to store first meant `loot` twice
running searched the same body while the one at your feet stayed untouched.

#### Phase 14b — A character worth keeping ✅ **done**

Promoted out of §4's parking lot, where it has sat since Phase 11 as "the largest hole in the
schedule"; lettered rather than renumbering, per this file's own rule. The `GAME_DEV_*` switches
are the stopgap it retires.

- **Mechanic.** Character progression: ability scores, hit dice, levelling with a curve worth
  climbing, and a starting band a new character can survive — either a starter zone or spawn-side
  tuning. Plus the decision Phase 13 left open, which needs these numbers to mean anything: **what
  death costs** — respawn point, experience loss, and whether a corpse can be retrieved for
  something (`ROADMAP` rule: decide, then build; the corpse and its clock already exist).
- **Seen when.** A brand-new character, with **no `GAME_DEV_*` switch set**, survives their first
  fight in the world they spawn into, levels from the experience the game already divides — and
  dying costs something you can point at in the log. ✅ **all three, verified live**: Freshstart
  spawned into the Kobold Settlement at 22 hit points in a rolled starter kit, took a kobold youth
  through a pursuit to the first level in the game's history, then attacked something forty levels
  above them and was told *"It cost you 200 experience and 1 level. Your corpse lies where you
  fell."* The whole of it rests on one decision — **the SRD sets the shape of the rules and Duris
  sets their magnitudes** — which has its own note, `DESIGN-progression.md`, because four of the
  five problems here were decisions rather than work.
- **Carries.** ~~Persisting `level` and `experience` at all~~ — **done early, 2026-08-02, by the
  owner's decision**: an admin edit must be permanent, so the storage half was pulled forward.
  `PlayerRecord.progress` holds both, login restores them (and returns the character to `lastRoom`),
  and a saved level wins over the `GAME_DEV_LEVEL` rig. What this phase still carries is the
  **derivation**: `devProfile`'s arithmetic is the placeholder that turns a stored level into hit
  points and attack bonus, and `restoreProgress` in `index.ts` is the named seam where real ability
  scores and hit dice replace it. And the numbers decision itself: SRD 5e ability scores and hit
  dice against the `.mob` records' own 15–60 curve, which is a design pass, not an evening.
- **Why here.** §4's own placement — after Phase 14, before Act V — and its first question lands the
  same way: gear (Phase 16) reads ability modifiers off the character, so the scores must exist
  before the things that modify them. Every phase after this is authored against real numbers
  instead of the rig.

#### Phase 14c — The fight moves with you ✅ **done**

Owner's, 2026-08-02, and it arrived as a question — *"does combat lock the player in the room?"* Half
of it turned out to be built and unenforced, and that half was fixed on the spot as a bug rather than
scheduled (see below). The other half was a real mechanic, got this phase, and was pulled forward
into round 2 ahead of 14b at the owner's word, because it and V2 are companions: the click menu is
how you watch positioning work.

- **Mechanic.** An engaged mob **keeps station on its target inside the room**. Before this, a mob
  only ever moved through the room *graph* (`advanceHunts`); once you were both in one room it was
  nailed to the tile it spawned on, so walking to the far corner left it swinging at you from across
  the floor. It now closes to reach and follows — and a body that has been knocked down stays where
  it lies until it is on its feet. `server/src/station.ts`.
- **Seen when.** You back away across the room mid-fight and the thing you are fighting *comes with
  you*, keeping its distance rather than teleporting or standing still. ✅ — steered back and forth
  across the Court of the Icess three times mid-fight and the gap held at **32 px, one tile, every
  time**.
- **Carries.** A default reach, and the threat table finally driving *position* as well as target
  selection: a mob with a tank on the top of its table closes on the tank, so pulling it off you is
  something you can watch happen on the floor rather than infer from the log.
- **Why here.** It is the last piece of Phase 6's engagement model that is still only half true.
  Blows already land at any range in the room, which was the important half and is what makes this
  safe to add: the mob closing is *presentation of a relationship that already exists*, so nothing
  about threat, tanking or rescue depends on it landing correctly.

**Facing became a rule, and the client stopped guessing it.** The owner's follow-on, same day: *"it
is face-to-face combat"* — and then, more generally, *"player facing should always happen when there
is an interaction."* So facing no longer means *the way you are walking*; it means **what has your
attention**. You turn to the door you open, the corpse you go through, the person you look at, and
your opponent — and movement is only the default, for when nothing else has a claim. In a fight both
parties turn, so backing away from something north of you walks you backwards with your eyes on it
rather than turning your back.

The consequence is the interesting part: **`facingOf` is deleted from the client.** It had its own
copy of "which way am I looking", derived from the movement keys, and that was correct exactly while
facing meant movement. It cannot be correct now — the client does not know which corpse `loot` picked
or where the door is — so the client draws the row the server names, and `syncTurn` grew the one line
that tells a character about their *own* turn (they are never in their own `watching` set, which had
never mattered before). Facing costs a tick of lag now and tolerates it where position does not: a
sprite a tick late to turn is invisible, a sprite a tick late to move is why prediction exists.

**Nothing here is a range check, and that is the load-bearing sentence.** `combat.ts` still contains
no distance test anywhere, and a test is named after that fact. This moves a body toward a fight it is
*already* in; whether the blow connects was settled in Phase 6 and stays settled. That is exactly what
made it safe to add this late — nothing about threat, tanking or rescue depends on the mob arriving,
so a bug in it is cosmetic rather than structural.

**The threat table drives position for free.** Nothing in `station.ts` reads it: a mob closes on
`fighting`, and *that* is what threat already chooses. So pulling something off a healer moves the
body as well as the pointer, and a tank holding aggro holds the thing **in place beside them** —
which is the first time in this project that tanking is a fact about the floor rather than an
inference from the log.

**It moves at a hunter's pace, not a walker's**, because it is the same creature with the same legs:
a mob that crossed three rooms at `HUNT_SPEED` and then ambled the last few feet would read as two
different animals. Being faster than a player is not exploitable in either direction *because* there
is no range check — outrunning it inside the room wins nothing and losing the race costs nothing.

**Deliberately not in it, both by §4's second question.** **Per-weapon reach** — fists against the
body, a sword a tile off, a bow across the room — needs weapons to be items with properties, so it
rides with **Phase 16**, where `reach` (reserved in `DESIGN-engagement.md` §8 for ranged attacks and
spells) gets its first real reader; until then there is one number, `MELEE_STATION`, and it is a tile.
And **a knocked-down mob's stand-up time feeding the hunt**, so that bashing something buys you the
seconds to get out of its range, needs `bash` — a defence skill, so **Phase 19**. What this phase
does carry is the *holding still*: `canMove` is the authority, so a prone or stunned mob is pinned by
the same test that holds a sitting player, and Phase 19 will need no code here at all.

**The half that was a bug, fixed 2026-08-02 rather than scheduled.** `DESIGN-engagement.md` §4 and §6
already say exits are refused in combat, and `COMMAND_REQUIREMENTS` already carried
`north: { inCombat: false }` — but that table is read in `runCommand`, which only the *typed* command
passes through. Three other ways out ignored it: the `move` intent a keybind sends, the `moveTo`
intent a click sends, and steering, which is pure geometry and treats a doorway tile as walkable like
any other. So the refusal was a formality you could step around with WASD. There is now a gate on
each of the three, and the steering one is in `Simulation.tick` because it is the only place that can
see a step *about to leave* — the threshold counts as outside, so you stop in the doorway.

---

### Act V — Things

#### Phase 15 — Inventory and worn equipment

- **Mechanic.** The item type/instance split, inventory with variable item sizes, equipment slots —
  `DESIGN-inventory.md` is the spec.
- **Seen when.** **Worn gear is visible on the character**, layered LPC over the body — the art
  requirement `CLAUDE.md` names explicitly. You pick something up, wear it, and see it.
  ✅ **the "see it" half is done (15a)**: the rolled starter kit is drawn on the body, and two
  characters with different rolls look different. The "pick something up" half is 15b.
- **Sliced, because the spec is multi-session.** **15a — worn gear is visible** ✅ (the visual jump,
  and it needed no new mechanics: 14b's kit already existed). **15b** ✅ — a real ground-object store
  per the note below, `get`/`drop`/`wear`/`remove`/`inventory`, inventory capacity and item sizes,
  corpses holding contents and spilling on decay. **15c** — stacking, uses, containers at depth 2,
  gold, and **the thing 15b could not do: item content.** Every item in the world is still the rolled
  starter kit, because nothing has been harvested from Duris' `.obj` files — so mob corpses hold
  nothing and the Items panel has nothing to edit. ✅ **done** — 16,421 items catalogued and mob
  corpses drop what their owner was wearing; the harvest also uncovered that every `G` and `E` command
  in the world was being deleted by a mis-mapped `arg3`. Remaining in 15c: stacking, uses, containers,
  gold, and executors for `O` and `P` (which need an object-instance census before they can honour
  their limits). `wield` is **done**, and the premise held up under measurement: 557 of the catalogue's
  2,841 weapons need two hands, harvested from Duris' own `ITEM_TWOHANDS || WEAPON_2HANDSWORD`
  disjunction — twenty-two two-handed swords carry no flag, so reading the flag alone would have missed
  them. Still open in 15c: persisting the ground across a restart, which needs a world-state file that
  survives `npm run worldgen` rebuilding the rooms underneath it.
- **Weapons are not drawn, and it is an art gap rather than an oversight.** The LPC pack ships weapon
  sprites as *attack animations only* — Swing, Thrust and Shoot sheets — with no idle-hold frame,
  while characters are drawn from the walk rows. A visible dagger therefore needs either an attack
  animation (a swing is a log line today, not a motion) or custom art. **Phase 16's**, with the gear
  that makes a weapon worth showing. Owner asked for it explicitly on 2026-08-03 — weapons, shields
  and *"everything except rings, neckwear or other obviously small or insignificant item"* — and the
  parking-lot row below costs the three ways out. **Shields are separable and cheaper**: LPC has the
  art, a shield is held rather than swung, and the off hand is already a slot.
- **Why here.** This is the largest single visual jump in the whole roadmap, and Phase 13's corpses
  need something to hold.

**A corpse must spill its contents when it decays**, or a mob's loot is destroyed by a player being slow
rather than by anything they did — and "I came back and it was gone" is a different, worse feeling from
"somebody else got there first". Phase 13 built the corpse and its five-minute clock; the `gone` event it
already reports is where the drop hangs.

**This needs a real ground-object store, and the one that exists cannot be extended into it.**
`pickups.ts` is a *deterministic scatter*, not a container: what a room holds is derived from
`scatterSeed(roomId)` through a seeded RNG, there is exactly one per room, its entity id **is**
`-(roomId + 1)`, and having taken it is recorded per character rather than by removing anything. Nothing
places a pickup at run time. A dropped object is the opposite on every count — created by an event,
several per room, at the position the corpse lay — so it wants the shape `corpses.ts` already has: its
own store, its own id counter, and entities that come and go. The scatter stays as it is, for what it is
good at.

---

#### Phase 16 — Gear that matters ✅ **done 2026-08-05**

- **Mechanic.** Light as an equipped-item property with best-of-equipped; gear quality on AC;
  movement points and encumbrance; terrain you cannot cross on foot.
- **Seen when.** A lantern in your hand rather than a `carriedLight` field ✅; heavy armour visibly
  slows you across swamp ✅; deep water refuses you until you can swim ✅.
- **Why here.** It collapses the interim carried-light field, which the design docs already say
  *should* collapse, and it retires the built-but-uncalled mechanisms in one pass.

Landed in three slices, and **the AC one is not what this entry originally said**. It read *"AC
derived from material × slot × condition"*, and measuring the 21,474 `.obj` records first turned two
thirds of that into arithmetic dressed as a mechanic:

- **Condition is `100` on 99.0% of objects** — 21,262 of 21,474. `structs.h` calls the field *"items
  condition or level"*, and nothing here wears an item down, so the term is ×1 for the whole world.
- **Material is on 100% of them and is still not carried.** `common.c`'s `materials[]` makes it a
  **damage-resistance** row (phys, fire, cold, light, gas, acid, negative, holy, psi, spirit) and we
  have no damage types to resist. It would double-count too: the builders already wrote it into
  `value[0]`, which runs median 12 for dragonscale, 7 for iron, 5 for leather. Harvest it the day
  damage types arrive — a field with no reader is what rule 1 exists to prevent.
- **Craftsmanship is the axis with signal, and taking it is a divergence stated as one.** In Duris
  the 0–15 ladder does nothing: every mechanical use is commented out (`db.c`'s `max_condition`,
  marked `wipe2011`, and `fight.c`'s extra attack), and it survives only as prose in `identify`. Same
  call V6 made about colour — the builders used the scale and the engine threw it away. Thirds of a
  rung, bounded ±2 against a base of 0–8; **thirds rather than quarters because quarters leave only
  1.3% of the world below average**, the one heavily-used low rung being 5 on 1,041 objects. 5,802
  entries carry a rung and 2,088 armour pieces moved.

**Light** transcribes `handler.c:431` — a light lights you between `WIELD` and `HOLD` and only while
`value[2]` is non-zero, so a lantern in your bag lights nothing. The world's 64 lights are harvested,
32 unlimited and 32 finite; radius is ours (Diku light is a boolean, and `light.ts` already found that
`ROOM_GAP` makes 3 the gate) and duration is Duris', at ten seconds an hour — pinned by making the two
catalogues agree where they overlap, Duris' 24-hour redwood torch against our 240-second one.

**Encumbrance** transcribes `load_modifier` (`actmove.c:79`) — ten bands from **75** under a tenth
full to **300** past 95%, widening as they climb. Note the bottom band is *below* 100, so travelling
light is a choice rather than the absence of a penalty. **Where it is applied is ours**: Duris uses it
for combat (`fight.c:6414`, `victim_ac += load_modifier(ch) - 75`) and for the prose that makes
somebody *"stagger in"*, and charges movement flat. Load counts **worn bulk as well as bag bulk**
against the bag's capacity, which looks lopsided and is the point — `DESIGN-inventory.md` §6 puts worn
gear outside *capacity* because what you have on is not luggage, and says nothing about *effort*.

`SECTOR_REQUIRES_MOVEMENT` finally has its caller, and the refusal lands **before** stamina is
charged: being unable to enter deep water is a different no from being too tired, and paying for a
step you were never going to take would drain the pool of somebody standing on a riverbank.

#### Phase 17 — Containers, money and shops ✅ **done 2026-08-05**

- **Mechanic.** Containers with nesting depth and type restriction, money as both scalar and object,
  shopkeepers.
- **Seen when.** You put a thing in a bag ✅ (15c), and buy a thing from someone ✅.
- **Open question — settled.** Container nesting depth is 2, owner-confirmed 2026-08-03.

Containers and money landed early, in 15c, so what this phase actually had left was **shopkeepers**.
Harvested **694** of them out of Duris' `.shp` files, and a keeper is a **mob vnum and nothing else** —
which is why A4's spawn endpoint could place a working shop without knowing shops exist, and is how
this was driven. `list`, `buy`, `sell` and `value`, priced off `utils.h`'s own coin ladder: copper,
then ten, a hundred, a thousand, with an item's `cost` in copper.

**The command table imposes nothing, and that is transcribed rather than tidied.** All four verbs are
`CMD_TRIG` in `interp.c` — *"reserved keywords that don't DO anything, but are used to trigger
specials"* — which sets `minimum_position = STAT_DEAD + POS_PRONE` and `in_battle = TRUE` on each. The
shopkeeper is the gate, so the two rules that matter live in `keeperFor` where a keeper can own them:
**awake and on your feet**, and **a keeper you are fighting will not serve you**.

Three numbers worth keeping. Rounding goes the keeper's way on both sides, but the floors differ on
purpose — a sale floors at 1 because free is not a price, a purchase floors at **0** because inventing
a penny for worthless goods would make every piece of trash in the world a slow income. An empty
`buysTypes` means the keeper buys **nothing**, which is 261 of the 694; reading it as "anything" would
turn every one of them into a fence for the whole catalogue. And `shop.c`'s inverted-spread repair is
**unreachable** — its own clamps guarantee the spread — which is asserted rather than exercised.

---

### Act VI — Together

Everything from here is content or depth, and the acts above are what made it cheap.

#### Phase 18 — Following and grouping ✅ **done 2026-08-06**

Consent, a shared list, the **superlinear** exp split (§4.4 — dividing by group size is the mistake).
Followers move by re-issuing the movement intent, never by teleporting.
**Seen when.** Two clients walk the map as one train and share a kill. ✅ — they walked as one train
(slice 1), and one kobold paid *"You gain 300 experience (18 dealt, group of 2)"* to both screens
(slice 2).

**Following** — `server/src/following.ts`, and the re-issued intent is what keeps it small:
each follower goes through the whole of `stepRoom`, so a closed door, an empty stamina pool or a
fight of their own breaks the train with no rule of its own. Transcribed from `do_follow`, including
`follow stop` being the *leader's* command and scoped to the room. Rings are refused and the refusal
costs the character nothing. **Driven with two sockets: they walked as one train.**

**Grouping** — `server/src/grouping.ts`, `client/src/grouproster.ts`, protocol 19. `consent`, `group`,
`gsay` and `disband`, transcribed from `group.c` / `actnew.c` rather than designed, including the two
rules that read backwards and are right: **the joiner consents and the leader enrols**, and **`group <a
member>` kicks them** — one verb whose act follows from the state. `group all` enrols your *followers*,
which is the source's own bridge between this phase's two halves. Thirteen members; the leader leaving
promotes the second; a group of one dissolves; grouping another leader merges both groups.

**The experience rule is a composition, and the owner chose it (2026-08-06).** Duris pays every member
in the room by membership; we pay by contribution; both cannot decide one kill. A group now
**multiplies** each contributor's share by `4N/(N+3)`, with `N` counting only members who were in the
room *and* contributed — so the party total is the source's (160% at two, 229% at four) while who earns
it stays ours, and twelve idle alts parked in the room are worth nothing to anybody. What survives from
`fight.c` untouched is the power-levelling wall (`÷40/150/1000/5000` at level gaps of 15/20/30/40),
because taking one hit from a level 50 mob *is* contribution and a share of that kill would be a level
1's entire career. Verified live in a single fight with three contributors, two grouped and one not:
the ungrouped one earned exactly its contribution share and the grouped pair exactly 1.6× theirs.

#### Phase 19 — Skills ✅ — **complete 2026-08-07**

Percentages notched by use, per-category rate limits, a level-driven floor. Mobs derive proficiency
from level and store nothing.
**Seen when.** A skill percentage rises because you used it.

**Slice 1 landed 2026-08-06: skills exist and combat notches them.** A landing blow can raise the skill
its weapon trains, the raise is announced in the source's own words, the value persists sparsely, and the
skill is worth `floor(learned / 10)` on the attack bonus. Driven live — see the note's §8 for the numbers,
including the bonus read straight out of the combat log at levels 30 and 1.

**Slice 2 landed 2026-08-06: dodge and parry**, the active defence roll — and it shipped broken for a
day (*every* blow missed; see the handoff's combat-regression row for the lesson). **Slice 3 landed
2026-08-06: `bash` and `kick`**, behind the `landBlow` extraction that keeps an ability from becoming a
second damage path. **Slice 4 landed 2026-08-07: `rescue`** — the first ability that makes grouping mean
something mechanically, and `joinBySupporting`'s first caller. Two transcription notes worth keeping: a
bare pointer flip would un-rescue itself at the next round boundary, so the redirect seats the rescuer at
the rescuee's threat standing (the grudge transfers with the fight); and rescue's notch runs **backwards**
from bash and kick's — `notch || fail`, so the moment you learn is a moment you fumble, where theirs is
`!notch && miss`.

**Slice 5 landed 2026-08-07: `swim`, and it closed the phase** — with the phase's *fifth* dead
mechanism as its headline: `SKILL_SWIM` is registered in the shipped source and read only by a function
whose entire body is commented out; the live deep-water gate is a **boat item**. The owner composed
both: deep water is *priced, not gated* — each stroke costs the terrain rate plus the dead drain's own
curve (`4 − skill/25`), a stroke notches, and an `ITEM_BOAT` carried or worn means you are not swimming
(no surcharge, no notch, no drowning). Drowning is exhaustion with consequences: at zero movement in
deep water, a beat every two seconds until ground, a boat, or the ordinary death — made real by the
rule the drive found (move regen pauses while treading, the commented source's own `StartRegen`
placement). **The drowned wash ashore at the shore they entered from** — the owner's ferry rule, so a
death never strands loot mid-ocean and never carries a bag across one free. The same slice closed the
step-cost gap: WASD and click crossings now pay the `SECTOR_MOVE_COST` bill typed steps have paid since
Phase 16. `underwater` keeps its wall by name — diving is the source's *breath* mechanism, for the day
one of its 192 rooms loads.

**[DESIGN-skills.md](DESIGN-skills.md) is the thing to read first**, and it exists because three of its
six decisions turn on **which branch of the source is compiled**. Two findings shaped the whole phase:
`NEW_COMBAT` is defined, so `fight.c`'s weapon-skill path — the eight damage-class skills — is compiled
out and the live mapping is `getWeaponSkillNumb`'s **per weapon type** (18 skills over 2,841 weapons,
measured); and `wipe2011` is defined nowhere, so the notch cooldown affect is written and **never read**,
which means the "per-category rate limits" in the line above describe an intention the shipped game does
not enforce. We adopt the compiled-out branch deliberately — without it, 6.7% of hits notching at a 3 s
round maxes a skill in 25 minutes. The note also settles the ceiling with no classes to ask (95, through
one function Phase 21 replaces), the floor (`MIN(40, 3*level/2)`, dragging `learned` as well as the
ceiling), how a 0–100 percentage meets our d20 (`floor(learned / 10)`, derived not chosen), the live NPC
formula (`level × 1.75`, not the `level << 1` our reference quotes), and a five-slice build order whose
first slice cannot break anything.

#### Phase 20 — Spells ✅ — **designed and built whole, 2026-08-07**

Cast time as a self-rescheduling event on Phase 11's scheduler, environmental interruption, two
independent resistance gates, area targeting with crowd thinning.
**Seen when.** You cast something with a visible wind-up that can be interrupted. ✅ — and, slice 3,
a kobold shaman casts it *at you*, and a bash mid-wind-up breaks it.

**Slice 1 ✅ (2026-08-07)** — the mandatory first commit: the tick drains the scheduler once and
routes by kind; `advanceCombat` is handed the due events. No behaviour change.
**Slice 2 ✅ (2026-08-07)** — the wind-up: `Actor.casting`, the shown `casting` affect, the star
meter, `permits()` lockout, once-per-second beat revalidation (room / footing / target) as the
whole interruption system, swing held and returned. Free interruption, costs at completion.
**Slice 3 ✅ (2026-08-07)** — the registry and the gates (`shared/src/spells.ts`: four nukes,
transcribed dice, the ×5 save-mod trap, save-then-shrug in the damage order, per-bolt shrug) and
mob casters (`MobCastSpell`'s 50% + level-rolled quick chant, `tryCast` injected into
`advanceCombat`, `MobTemplate.spells` live-authorable; the kobold shaman ships casting). The drive
found and fixed `mundane_autostand` — see the handoff.
**Slice 4 ✅ (2026-08-07)** — scrolls: `ItemTemplate.scroll` harvested on all 135 (`value[0]` level,
`value[1..3]` raw Duris spell numbers — 37 is shocking grasp, not 48), `recite` with the source's
own no-gate rule (`CMD_N` mid-fight refusal kept), cast at the scroll's level, per-slot targets and
saves, duplicates cast twice, burnt on recital even at nothing. Players cast for the first time.
**Slice 5 ✅ (2026-08-07)** — heals and buffs: the cures (`number(2,10)`, `dice(3,8)`, level-blind),
armor and bless as affect nodes on the new `ac`/`hit`/`saves` locations **with their readers**
(`refitCombat` folds, the save roll sums), durations at the torch calibration, re-cast refreshes
and never re-rolls, `joinBySupporting` + `THREAT_PER_HEAL` produced at last, **protocol 21** (exact
group pools, pushed when a heal lands), and mob casters healing themselves when hurt — buffs
skipped by name until a mob profile fold exists.
**Slice 6 ✅ (2026-08-07)** — areas, and the phase closed: earthquake's bespoke loop (ground gate,
bystander knockdowns without damage, `dice(1,30)+level` felled / sector-scaled graze upright), ice
storm through `should_area_hit` (fighting-outranks-everything, mob-areas-cannot-hit-mobs — driven
with a spawned control mob standing untouched through three storms — group exempt, default yes) and
the **player-count thinning** under its corrected name (`pc/2 + 5/pc ± 0.75`, min-chance floor 90,
NPCs never thinned), `TAR_OFFAREA` honoured (a named victim dying mid-wind-up does not stop the
room shaking). **What Phase 21 inherits — the memorization economy, circle tables, spellbooks and
scribing, ground-casting and concentration, penetration, globes — is recorded at the end of
`DESIGN-spells.md`.**

**[DESIGN-spells.md](DESIGN-spells.md) is the thing to read first** — six readers over the magic
source, and the findings bend the phase: memorization beat mana in the shipped fork and both wait
for Phase 21's classes (**scrolls' classless `recite` path and mob casters carry Phase 20**);
damage does *not* interrupt casting (knockdown, forced exits and stun do); fireball is
single-target and the real area spells thin **players only** — this row's "crowd thinning" was the
dead algorithm's name; and the one `scheduler.advance()` call sits inside `advanceCombat`
discarding every non-swing event, which makes a no-behaviour-change dispatch restructure the
phase's mandatory first commit. Two stale promises corrected by the note: the `'casting'` outcome
was never reserved on the wire (only `'absorbed'`/`'resisted'` were), and corpse decay does not in
fact run on the event scheduler.

#### Phase 21 — Classes, races, quests, channels

The content layer the previous twenty phases exist to support.

---

### Track V — the world on screen

Presentation of what already exists: client work, at most an additive message field, no new rules.
One per round (§2b). Each entry is small on purpose — a V item that grows a mechanic has answered
§4's second question wrongly and belongs in a phase.

- **V1 — The combat feed** ✅ **done 2026-08-02, owner-requested and owner-corrected twice in the
  building.** The `combat` channel's one destination is now its own section of the character pane,
  docked below the display controls — first built as a fading ticker over the map, moved on the
  owner's direction, then made a **split rather than a mirror** on the owner's direction: the log
  no longer carries combat lines at all, so the reading rule is spatial — prose and speech on the
  left, violence on the right. `combatfeed.ts`; the scene routes the channel.
  **Seen when:** a fight streams down the right pane, and the log stays prose. ✅
- **V2 — Click a body, get its verbs** ✅ **done 2026-08-02, owner-requested.** Click a mob or a
  corpse and a small menu names it and offers what you can do to it — Look at, Attack, Loot. The
  point is target *identity*: in a room of same-named patrol members "which one am I about to hit"
  had no answer on screen, and since Phase 14c they **move**, so "the one on the left" stops being
  true a second after you say it. `client/src/targetmenu.ts`.
  **Seen when:** you click the mob you mean and act on that one, never the wrong twin ✅ — clicked
  one of the Court Patrol, the menu named it, and Attack opened the fight with that body.

  **It needed the protocol (11), and that is the honest part.** A keyword *cannot* express "this
  one": `kill patrol` is ambiguous by construction and `2.patrol` only helps if the player can see
  the ordering the server used. So a click sends an **entity id** — `look` and `attack` had carried
  an optional `target` since before there was anything to do with it, and `loot` joins them. The
  server resolves the id through the same visible-set gate a typed word passes, so pointing is a
  *more precise* way to ask and not a more powerful one.

  **Phase 2's dispatcher seam moved from a location to a name.** The rule has always been that the
  position and in-combat gates are read in exactly one place; a clicked verb would have broken that
  either by skipping the gate (opening a fight while asleep) or by copying it. `permits()` is that
  block extracted, and both entry points now pass through it. `kill` and `loot` were split the same
  way — resolution from act — so the typed word and the click cannot come to mean two different
  things.
- **V3 — Speech in the world** ✅ **done 2026-08-05.** A short-lived bubble over the speaker, and the
  operator's channel finally rendered as a banner.
  **Seen when:** someone says something and you watch them say it, in the world, not the log ✅.

  **Protocol 17, and additive on the message that already exists.** `log` gains `from` and `speech`,
  set only on the `say` channel. A second message type was the obvious shape and the wrong one: the
  speech line is *already* rendered per recipient and already passes the `act()` gate, so a separate
  send path would be a second answer to *"who may hear this"*, and two answers drift. Riding along
  means the bubble reaches exactly the people the sentence does, by construction.

  **The sight gate is not applied twice — it is applied once and the renderer cannot disobey it.** The
  client draws on an entity it holds, so a speaker outside your light has nothing to attach a bubble
  to, while the log line they do get still reads *"someone says"*. Same fall-out protocol 16 uses for
  the target chevron.

  Three things the drive corrected, and the second is the owner's:

  1. **The bubble is counter-scaled against the camera.** It lives in world space — it must, to follow
     a body that walks — and world space is scaled by a zoom ladder running 0.25 to 2. Left alone one
     sentence covered a quarter of the map at close zoom and would have been three unreadable pixels
     at `fit`. `setScale(1 / camera.zoom)` cancels the camera exactly.
  2. **It draws above the fog** (owner, 2026-08-05: *"the bubble should be fully visible even in the
     dark. darkness doesn't affect what can be heard unless it is a silenced room"*). The fog is one
     image at depth 50; a bubble beneath it was dimmed by the darkness of the tiles behind the *text*,
     which is the unlit air above the speaker's head rather than the speaker. So a perfectly visible
     person's words faded out because of the ceiling. The rule is now exactly *"if you can see who is
     talking, you can read what they said"*. A **silenced room** is the thing that would stop a line
     being heard at all, and that is a server-side rule about recipients rather than a rendering one —
     there is no such flag yet.
  3. **The banner went to the bottom of the map.** Top-centre collided with `#status`, which is pinned
     top-left and runs most of the width of a narrow map column — and `#status` comes later in the
     document, so it painted straight through the banner's background.

  **The banner is a mirror where V1's combat feed is a split**, and the difference is deliberate.
  Combat lines land in the feed and nowhere else, because a fight is a stream and duplicating it
  doubles the noise exactly when there is most of it. A banner is transient by necessity, and an
  announcement you happened to be looking away for must still be findable — so it shows *and* stays
  in the log, and the log is the record. `client/src/announce.ts`.
- **V4 — The world as a graph of Places** ✅ **done 2026-08-05.** The `M` overview shows the Place you
  are on; there was no view of anywhere else. Decision 1 in `HANDOFF.md` constrains this hard: zones
  overlap and share no coordinate space, so any wider map **must be a graph of Places, not a map of
  them** — nodes you have visited, edges you have walked, laid out as a diagram rather than geography.
  **Seen when:** you open the map and see where you have been as a web, and how the castle joins
  the bog ✅ — `Shift`+`M`, four Places on two rings with the current one picked out.

  **Protocol 18, and it persists nothing.** A character's `seen` bitsets already record which Places
  they have stood in, so the graph is derived rather than stored — no new saved field, and so none of
  the reader-line and round-trip work every persisted field costs.

  **The edge rule is the part that needed care, and the first version of it leaked.** "Source room
  seen, far Place visited" reads as sufficient: it is not. A character who has stood in the marsh and,
  separately, in the keep would be shown the passage joining them, because the marsh room they *did*
  see has an exit into a Place they *have* been — a passage they never found. An edge now needs
  **both** of its rooms seen, which says exactly *you have stood on this side and on that side*.

  Two smaller decisions worth keeping: a node reports **rooms explored, never rooms that exist**, and
  the layout is **rings by boundary-distance** rather than a force simulation, so the same graph always
  draws the same picture.
- **V5 — Arrival cards** ✅ **done 2026-08-05.** Crossing into a new Place was a change of floor tiles.
  A brief title card — zone name, and the level under it — gives travel the sense of arrival every MUD
  gets from its room header line. **Seen when:** you climb the stairs and the game tells you where you
  have arrived, then gets out of the way ✅.

  **No protocol change and no new rules**, which is what kept it a V item: `announceArrival` already
  held every fact needed, so the card fires on exactly the two occasions that already write a log line
  and never on a **resync** — a `zone` for the Place you are standing in is A5's terrain edit or A8's
  regrid, not travel. The level is omitted for a one-level zone, answered from the `Zone` the client
  already holds. Positioned a third of the way down after the first attempt collided with the vitals
  HUD, which is the one readout that must never be covered.
- **V6 — The world in its own colours** ✅ **done 2026-08-02, owner-requested.**
  `shared/src/colour.ts` parses the MUD's own `&+R` / `&n` notation into spans, and the client
  renders them.
  **Seen when:** room prose arrives coloured the way its builder wrote it ✅ — IceCrag's approach
  road draws in the dim yellow `&+y` its author chose, with no literal codes on screen.

- **V7 — Attack verbs** ✅ **done 2026-08-06, owner-requested.** *"If I swing an axe or a sword it should say You slash the
  mob for 200 damage; if it was a club it should be bludgeon."* A V item by §2b's test — presentation of
  something that already exists, no new rules, and **no protocol change at all**, because the combat line
  is already rendered server-side per recipient.

  **It is transcribed, not invented.** `attack_hit_text[]` (`fight.c:132`) is Diku's own table of eleven
  types with singular, plural and past forms; `get_weapon_msg` (`objmisc.c:63`) picks one from the
  weapon's `value[0]`, which is the `weaponClass` Phase 19 harvested on the same day this was asked for.
  Six verbs are reachable: **slash**, **pierce**, **crush**, **bludgeon**, **whip**, and **hit** for
  everything else.

  Two things to carry from the parking-lot row. **The verb grouping is not the skill grouping** — hammer
  and mace share `bludgeon-1h` as a skill but split into crush and bludgeon as prose, and a polearm is
  `reach` for skills and always *slash* here; merging them would silently change one. And **the mob half
  needs a harvest**: an unarmed mob's verb is a function of its **race** (`GetFormType`, not the
  `attack_type` field the first write-up guessed) — which is how a spider stings and a troll mauls.

  **Built, and both halves driven.** `shared/src/attacks.ts` holds the eleven-row table and the two
  mappings; `MobTemplate` gained the **race code** (`raceCode`, which `spriteFor` had been reading and
  discarding since the harvest landed) and it is **optional**, so a stale `data/world` punches rather than
  crashes. `announceAttack` now builds the sentence from an explicit second/third-person pair, which
  **deleted the regex** that used to rewrite "You hits" into "You hit" — four fixed verbs could be
  patched afterwards and eleven cannot. Driven live: dagger → *pierce*, battlehammer → *crush*, mace →
  *bludgeon*, whip → *whip*, mithril sword → *slash*, and **the Archivist — race `G`, a giant — crushes**
  where every humanoid punches. **The gotcha the drive found**: spawn files are a worldgen output, so the
  race does not exist until they are regenerated, and the first run showed the giant punching because the
  server had booted on the old files.

  **The finding, not the feature, is the point.** The owner asked for a way to add colour; the world
  *already had* colour and we were deleting it. `cleanDescription` called `stripColour`, and there
  are **4,588,357 codes across the 447 `.wld` files** — 4,199 in IceCrag alone. Stripping was right
  while nothing could render one and became wrong the moment something could. One line of worldgen,
  and all 216 of IceCrag's descriptions keep their colour.

  **Adopted rather than invented**, because the content is already written in it, it is what a MUD
  player expects, and `duris.ts` had to recognise the same four shapes in order to strip them. The
  **join key still strips** — a name carrying codes will not match one without — which was always
  the same function and never the same decision.

  **Backgrounds are parsed and dropped**: the palette is tuned to a dark ground, and a builder's
  black-terminal `&-B` would be an unreadable block mid-paragraph. And the parser emits **segments,
  never markup** — everything through it is untrusted and half of it is other players' `say`, so
  text only ever reaches the DOM through `textContent` on a node the renderer made.

- **Parked, needs the owner's taste before scheduling:** floating combat numbers over heads (the
  rolls are deliberately in the log; duplicating them in the world is a tone decision), day/night
  tinting (touches the tuned light model — same caution as room-scoped shared light in §4).

### Track A — the operator's panel

The admin suite, `DESIGN-admin-panel.md`. One slice per round (§2b); a slice is done when its
operations verifiably land in the running game — the audit line, the wire message, or the file
change, per §6 of the design doc. The section-by-section detail lives there; this list is the
order.

- **A1 — Players, messaging's first line, the shell** ✅ **done 2026-08-02.** The player editor end
  to end (live edits through the sim's seams, offline through the store, refusal over pretence),
  global announcements, per-player tells, the audit trail, honest stubs for everything else.
- **A2 — Messaging to a room or a place** ✅ **done 2026-08-02.** The remaining targets — world, a
  Place, a room — as one endpoint with an optional target, since only the set of listeners differs.
  Plus the dedicated **`announce` `LogChannel`, protocol 10**: `system` is the machine's voice and an
  operator's is a person's, and a client that cannot tell them apart can style neither. **Seen when:**
  a line aimed at one room reaches the character standing in it and nobody else ✅ — verified with two
  probes on different levels, and an empty room answering *"nobody was there to hear it"*.
- **A3 — Zones, read-only** ✅ **done 2026-08-02.** Three columns narrowing left to right: which
  zones are loaded, which rooms are in one (filtered by level), and what one room actually is —
  sector, flags, prose, and every exit with its destination named. The room browser is what A4's
  live ops and A5's authoring will both navigate with.
  **Seen when:** the panel tells you something the world files cannot ✅ — IceCrag counting down
  **71 minutes to its next repop** while the other three read "—" (no population at all, which is a
  different fact from "due now"), a Court Patrol member shown standing in room 5699, and a door
  opened *in the game* reading back as **open** in the panel a second later.

  **The live half is what makes it worth having open.** Three of the four things on screen cannot be
  read off `data/world/`: the repop clock is re-rolled from each zone's own band after every reset,
  the occupants are where the population actually *is* rather than where the reset table meant to
  put it, and door state is mutated by `open`/`close` and put back by the repop. The static half —
  prose, flags, sector — is there so the two can be compared, which is the job of a browser.

  **Read-only, and §1 is the reason rather than the effort.** The base data is generated, so an edit
  here would be lost by the next `npm run worldgen`. Authoring lands in A5 as overlay files that
  survive a rebuild.
- **A4 — Zones and mobs, live ops** ✅ **done 2026-08-05.** Force a repop, work a door; live mob
  instances by zone, slay, spawn from a harvested template.
  **Seen when:** you can set the world up for a test without restarting the server ✅ — slew a
  sentinel private from the panel and watched the count go 92 → 91, forced IceCrag's repop and the
  button reported *"+5 mobs, 97 at limit"*, opened and shut a door and saw both ends agree.

  **Instances, not templates, and that is why it is its own section.** Zones says what a zone is
  *authored* to contain; this says what is standing in it — two sentinel privates of vnum 97022 with
  1,182 and 1,274 hit points, because the roll is per instance. Every row carries an **entity id**,
  the same argument protocol 11 made for clicking a body: a keyword cannot say *which*.

  Three things the implementation is deliberate about. **Slay runs `resolveDeath`**, so the body
  leaves a corpse holding what it carried and the room is told — an admin kill that made a mob vanish
  would exercise a path the game does not have, and watching the real one is the point. Nobody is
  paid experience or coin, because nobody hurt it. **Repop passes `runReset`'s `force` flag**, which
  has existed since Phase 8 with boot as its only caller, and it is additive exactly as the timed one
  is: the second press reported **+0 mobs, 98 at limit**, which is the per-vnum world-wide limit
  doing its job and what makes the button safe to hand an operator. **A door is worked at both ends**
  through `world.doorway`, because a doorway shut from one side only is a wall from the other; and
  `closed` and `locked` are set independently, since `LOCKS_HOLD` is off and testing the day it goes
  on needs them apart.
- **A4b — The zone map** ✅ **done 2026-08-02, owner-requested.** A *spatial* view of one level of a
  zone: a cell per room at its own `pos.x, pos.y`, exits as the lines between them, colour by
  sector, flags and live occupants as marks, click a cell to select. `admin/src/zonemap.ts`.
  **Seen when:** you pick a room by pointing at where it is rather than finding its name in a list
  ✅ — clicked a cell on IceCrag's level 9 and got *The Northwestern Corner of the Court of the
  Icess*, whose detail confirmed **cell 1,5**, a player and a patrol member standing in it, and a
  shut door to the north.

  **Cheap, because the data was already this shape.** Worldgen normalises coordinates per zone, so
  every room carries a small integer cell — level 9 is 110 rooms inside 13×14 — and nothing in the
  map computes a position, it reads one. That is a decision made in Phase 1 for other reasons paying
  out years later.

  **The one thing it refuses to assert: east is not always the cell to the right.** `HANDOFF.md`'s
  first decision is that zones are joined by portals rather than roads, so a staircase or a
  cross-zone exit leaves the grid entirely. An exit is drawn as a **line** only when its destination
  really is the room the direction points at; everything else is a **stub** — there is a way out
  here, and this drawing cannot say where it lands. Measured on the shipped world: level 9 draws 260
  links, 0 stubs and 10 stair carets; level 0 draws 10 links and **1 stub**, which is precisely the
  exit that leaves the map.

  **A level at a time, and "all" draws nothing.** Eleven levels stacked on one grid is a picture of
  nothing, so the map appears only once a level is chosen; the table stays underneath for finding a
  room by name.
- **A5 — Authoring overlays** ✅ **rooms done 2026-08-02.** `data/world/overrides/rooms.json` holds
  hand-authored **name, prose, terrain and flags**, composed over the generated zones at load and
  edited from the room you clicked on the A4b map. **Hand-authored sanctuaries land here** — the
  parked item §4 has carried since Phase 10, and `safe` is now a checkbox.

  Four things it settled that are worth not re-deciding:

  1. **The overlay is git-tracked, and `data/world/` is not.** It is the only thing under `data/`
     that no command can regenerate, and it was heading for an ignored directory. The ignore carries
     a negation for exactly this path.
  2. **Geometry is refused, not ignored.** A room's id, position and exits are the join key and the
     grid; posting them gets a 400 naming why. Silently dropping them would tell an operator the
     room moved. That is A8's, below.
  3. **Revert restores from a snapshot, not from disk.** `GameWorld` keeps each edited room's
     generated values from before the first edit, so undo cannot fail and needs no fixture to test.
     It must be able to express *absent* — most rooms have no prose, and reverting to `''` is a
     different room from reverting to none.
  4. **Whether the tilemap must be re-carved is decided by comparing the room's terrain before and
     after, never by inspecting the patch.** A revert restores a sector without setting one; the
     patch-shaped test said "no change" and left the server holding a water grid under a floor of
     ice that every client had correctly redrawn.

  The **colour picker** rides here as promised in §4: one component (`admin/src/colourbox.ts`),
  sixteen swatches and a live preview rendered through the client's own `parseColour`. A6 and A7
  reuse it unchanged.

  **Still to come on this line:** mob template overrides — name, level, combat numbers, aggression —
  which wait on the Mobs tab (A4) rather than on anything here.
- **A8 — Zone geometry: adding and removing rooms.** The rest of what "a complete zone editor" means,
  and the largest thing in this track. **The design note it asked for is written**:
  [DESIGN-zone-geometry.md](DESIGN-zone-geometry.md), 2026-08-05, all five decided and measured.
  The headlines: authored rooms are numbered **from 1,000,000** in a second overlay (the highest real
  id is 97,271 and nothing is above a million); a grid resize **clears that Place's `seen` explicitly**
  rather than silently shifting every row-major index; orphaned exits are **reported, not forbidden**,
  because the shipped world already has 5 of them and the engine handles it. It also picks a build
  order whose **first slice cannot invalidate anybody's map** — infill inside the current extent,
  which reaches A8's own completion test without touching the sharp edge.

  **Slice 1, infill, is built (2026-08-05).** Decisions 1, 3 and 5 in code, and 2 side-stepped by
  construction rather than by care: `placementRefusal` will not accept a cell outside the level's
  extent, so no code path can widen a grid. `server/src/room-authoring.ts` is the overlay —
  `rooms-authored.json`, a stored counter from 1,000,000, whole records rather than patches — and the
  panel's gesture is **clicking an empty cell on A4b's map**, because "which cell" is the one question
  a map answers better than a form. Three things the build settled that the note left open. **An
  infill exit's destination is derived, never posted**: it is whatever stands in the adjacent cell, so
  the panel offers a tick per real neighbour and a direction that would be refused is never on screen.
  **A neighbour's existing exit is refused rather than replaced** — decision 3 says write both sides,
  not overwrite a side somebody else authored. And **an edit to a created room re-drafts its own
  record** rather than writing a `rooms.json` patch, which is A6b's dispatch in its second home: two
  overlays claiming one room is a state where the answer depends on load order. Up and down are
  refused by name, because a vertical link lands on a second Place with its own grid and its own
  stair placement.

  **Slice 2, deletion, is built (2026-08-05).** Decision 4 delivered, and decisions 3 and 4 both moved
  from *agreed with* to *honoured*. Deletion is two operations under one verb — a created room goes by
  deleting its record, a harvested one by writing a **tombstone**, since the zone file is generated and
  a rebuild would restore it. `removalRefusal` guards the extent from the other side to
  `placementRefusal`, comparing the level's bounds with and without the room, so a boundary *shared*
  with another room is deletable and one the extent *rests on* is not. Two refusals live in the router
  because they are about the world in use: the spawn room, and a room somebody is standing in. Orphaned
  exits and orphaned reset commands are **counted and shown at the moment of deletion** — the only
  moment anybody is told, since both are then skipped in silence for ever. **One interaction the note
  did not predict and the build had to settle**: the debris a delete leaves was blocking its own cell,
  because a neighbour's dead exit read as a link worth protecting. It is not — but telling debris from
  a real destination needs *three* states, since an exit into a zone this server does not run is real
  content, and a tombstoned room is still in its zone file so the disk must not be asked first.

  **Slice 3, extent changes, is built (2026-08-05), and A8 is done.** Decision 2 honoured rather than
  sidestepped: building on the edge or clearing the edge is allowed, and when the extent moves the
  Place's `seen` is cleared for **every** character, online or not, and announced to whoever is there.
  The comparison is against an extent stored in the overlay, which is what makes the question "has it
  changed since the maps were written" rather than "is it different from the harvest" — the second
  answer stays true for ever after one edit and would clear every map on every boot. The same
  comparison runs at load, so a hand edit is caught before anybody connects, and it is idempotent.
  Growth is bounded to one cell by slice 1's own rule that a room must join a neighbour.

  Three things the build found that this note did not predict. **Actors are positioned in tiles
  measured from the extent's corner**, so a grid that grew leftward moves every body on the Place —
  they are re-seated. **The clearing must be flushed rather than debounced**, or a restart inside the
  window keeps a stale map that the boot check can no longer detect, because by then the stored extent
  matches. And **the warning has to precede the act**: the panel says what a resize will cost before
  the button, since a warning delivered with the response describes something that already happened.

  The five problems, four of which were decisions rather than work:

  1. **A new room has no vnum.** `CLAUDE.md`: ids are the MUD's own and are never renumbered, because
     they are the join key between every data source we have. Authored rooms therefore need an id
     space that cannot collide with the 46,508 real ones and stays stable across a rebuild.
  2. **Changing a zone's bounds resizes its grid, and that invalidates every saved `seen` map for
     that Place.** `players.ts` says so outright — tile indices are row-major, so a wider grid shifts
     every one of them. Adding a single room outside the current extent would silently wipe explored
     maps unless something is decided about it. The sharpest edge here, and the least obvious.
  3. **Exits are two-sided.** Deleting a room leaves dangling exits in its neighbours; adding one has
     to wire the reverse. Any UI for it meets gotcha 1, the three direction encodings.
  4. **Reset tables name rooms.** Deleting one orphans the spawn commands pointing at it.
  5. **The overlay has to *add*, not merely override** — a different merge shape from A5's, which
     only replaces fields on rooms the harvest already produced.

  **Seen when:** you draw a room Duris never had, walk into it, and it is still there after
  `npm run worldgen`.
- **A6 — Items** ✅ **editing done 2026-08-04.** Search over the 16,421-entry harvest, and a partial
  overlay in `data/world/overrides/items.json` carrying **name, keywords, AC, damage dice and cost**.
  Behaviour — `slot`, `type`, `container`, `stackLimit` — is refused by name with the reason, because
  each is derived from the source's own bits and carries rules an item editor would have to
  re-validate.
- **A6b — Items you make yourself** ✅ **done 2026-08-04, owner-reported.** *"I can currently edit
  existing items but I can't create completely new ones."* Right, and the missing half is the harder
  one: a patch presupposes something to patch. Created items are **whole records** in
  `data/world/overrides/items-authored.json`, a second overlay rather than a range check inside the
  first, because the lifecycles are opposite — a partial override that authors nothing must be
  deleted or the item wears a ✎ for ever, while a created item whose name is blanked is a bug rather
  than a request to delete it.

  **The vnum range is the whole safety argument, and it is measured.** The harvest's vnums run 4 to
  **700,008**, in blocks to 90k with outliers at 120k, 130k, 200k, 400k, 420k, 500k and 700k. Created
  items start at **9,000,000** — an order of magnitude clear, 1M–8M left for a future Duris drop, and
  large enough that a seven-digit vnum beginning with 9 is ours on sight. The allocator's counter is
  **stored, not derived**: "highest existing plus one" never repeats until you delete the highest
  item, and a recycled vnum would silently change what a spawn overlay names.

  Marks are two, not one: **✎** is a harvested item with changes over it and its editor offers
  *Restore harvested*; **✦** is an item with no harvest under it and its editor offers *Delete*.
  `POST /players/:slug/give` came with it — an item that can be authored and never held cannot be
  checked at all.

  **Seen when:** you invent a sword in the panel, put it in a character's hands, wield it, and it is
  still in the catalogue after a restart ✅ — created *the Sunlit Brand* (3d8+4, `mainHand`), gave it
  to a character, `wield brand` displaced their club, and a cold boot logged
  `16422 item types loaded, 1 created here`.
- **A7 — Item art: assigning LPC sheets** (owner, 2026-08-04). *"we also need the ability to assign a
  LPC graphic to an item"*, and — the half that decides the shape — *"we also need the ability to
  assign LPC art to the existing items."* So this is not a field on the create form; it is a property
  of **any** item, harvested or made here, and 16,421 of them are harvested.

  **The blocker is not the picker, it is `ITEM_LAYER`** — ten hardcoded rows in `client/src/scene.ts`
  mapping item id → sheet name. It cannot hold the catalogue and cannot hold a created item at all.
  That table has to become data before a picker is worth building.

  **The catalogue already exists and we already have it.** `assets/ulpc` is the Universal LPC
  Spritesheet Generator, whose `sheet_definitions/` holds **769 JSON definitions** (34 of them
  weapons, across blunt / magic / polearm / ranged / shields / sword), each carrying a display name,
  category, per-body-type paths, **`zPos` layer order**, colour variants, the preview frame
  coordinates, and a **credits block with authors, licences and URLs** — which is the attribution
  `CLAUDE.md` requires, machine-readable. The pack is git-ignored at 1.5 GB, so what we commit is a
  derived index plus the sheets actually staged into `client/public/lpc/`.

  **Two surfaces, routinely conflated and worth separating:** the *icon* (bag row, floor tile —
  today a procedurally drawn placeholder) and the *worn layer* (sheets on the body).

  **A caveat this row carried and the measurement disproved.** It said ULPC ships weapons as attack
  animations with no idle-hold frame, so a sword could never be drawn on a standing character. That
  generalised from one weapon: the club's `"custom_animation": "slash_reverse_oversize"`. Counted
  across the pack, **461 sheets in 49 groups are already at LPC's 576×256 walk geometry** — every
  shield family, and sword, dagger, rapier, saber, mace, waraxe, flail, halberd, scythe, spear and the
  magic staves. A character walks around holding an arming sword today. What genuinely lacks a walk
  cycle is the *oversize* weapons, 47 definitions, and those are the ones `artgen` skips.

  Split four ways because the costs are nothing alike:
  - **A7a — index the pack** ✅ **done 2026-08-04.** `npm run artgen` reads the definitions, probes for
    a real walk sheet, and emits `shared/src/lpc-art.ts` plus the staged PNGs and a generated
    attribution file. **319 pieces of art** across every slot — 50 hats, 34 clothes, 26 weapons, 31
    shield pieces, 18 legs, 12 shoes. 3.5 MB staged.
  - **A7b — art as data** ✅ **done 2026-08-04.** `art` is an authorable field on any item, harvested
    or created, validated against the index. `sim.artClassOf` hands the id straight to the wire, so
    protocol 14's shield special case became the whole mechanism and needed no bump. `ITEM_LAYER` is
    now `KIT_ART`, covering only the nine starter-kit ids that have no template to carry an `art`.
    **Seen when:** a sword you chose art for is drawn in the hand of the character wielding it ✅.
  - **A7c — the picker** ✅ **done 2026-08-05.** A grid of thumbnails beside the item editor's `art`
    field, filtered to the item's own slot and openable onto all 319. The tile is a 64×64 window onto
    the staged sheet at column 0 of row 2 — LPC's south-facing standing frame — drawn with
    `background-position`, so there is no canvas and no fetch and the browser caches one image per
    sheet however often it is drawn. `itemRow` carries `art` now, which is what lets the search list
    say **which** of 16,421 items have been given a picture.

    **The sheets had to be reachable from the panel's origin at all**, and that was the real work:
    `artgen` stages them into `packages/client/public/lpc/`, served by the *client's* 5273, while the
    panel is 5274 proxying only `/admin`. A picker pointed at the client's port would break whenever
    somebody ran the server and the panel without the game — the exact case the admin suite exists
    for. So the **game server** serves them, from the same files rather than a copy, and the path is
    closed by looking the id up in `LPC_ART_BY_ID` rather than joining it: traversal is refused for
    the same reason a typo is, and there is no filter to get wrong. Ungated, deliberately — the gate's
    defence is that `x-admin-token` must be *present*, an `<img>` cannot send a header, and these are
    CC-BY-SA sheets of boots the game already serves unauthenticated to every player. `server/src/art.ts`.
    **Seen when:** an operator picks boots from pictures and a body walks around in them ✅ — chose
    `feet-boots-fold` for vnum 246, gave it to a character, and an observer's `EntityView.wearing`
    carried `feet: "feet-boots-fold"` beside the starter kit's own classes.
  - **A7d — floor icons** ✅ **done 2026-08-05, with one known flaw below.** An item with authored art
    draws that art on the ground instead of one of nine category glyphs shared between 16,421 entries.
    The placeholder is demoted rather than retired — an item nobody has dressed still reads as the
    *kind* of thing it is. No protocol change: `sprite` was already a string the client resolves.

    **Not from the pack's preview coordinates, which this entry expected.** Only **24 of 657**
    definitions carry `preview_row`/`preview_column`, so building on them would have dressed 3.6% of
    the pack and left the rest looking broken beside it.

    Two owner corrections landed with it and both improved on the plan: **no name label over a
    dropped thing** — the picture identifies it now, and `look` is the verb for the detail, and three
    items on one tile had turned their names into an unreadable smear — and **dropped things land 1–2
    tiles away in a seeded random direction**, bounded by the three-tile pickup reach so nothing can
    land somewhere you have to walk to.

    **The flaw the owner caught, and its fix** ✅ (2026-08-05). *"It had the shoulder part at the
    bottom of the image instead of the top"* — an icon was a body-shaped frame with an empty top half.

    Measured, and the first diagnosis — *"south is the wrong facing"* — was wrong. The two cape layers
    are complementary **by facing**, because `fg`/`bg` is foreground/background *relative to the body*
    and which one holds the art depends on which way the figure turns:

    | | north (back to camera) | south (facing camera) |
    | --- | --- | --- |
    | `cape-solid` (fg, z 85) | 0,0,0,0,108,156,184,78 | 0,0,0,0,0,0,40,22 |
    | `cape-solid-l2` (bg, z 5) | all zeros | 0,0,0,0,108,156,184,34 |

    So south already shows the whole cloak. What both facings share is the real fault: **nothing in
    bands 0–3**. A cloak hangs from the shoulders *down*, so it occupies the lower half of a 64×64
    frame sized for a whole person — and centred as an icon it sits low with a void above it, reading
    as sunken rather than as an object. The nubs the owner saw at the bottom are the hem, drawn by the
    fg layer over the bg one.

    **Fixed by cropping to the content's bounding box**, not by changing the facing — and it needed
    **no PNG decoder in `artgen`**, which the first write-up had assumed. The client measures the alpha
    bounds of a texture it has already loaded, once per sheet-set and cached, so a floor with twenty
    daggers on it scans once. The **union** across an art's layers rather than each separately, since
    cropping a cloak's two sheets independently would slide its halves apart. `setCrop` does not move
    an object, so each image is also shifted by the crop's offset from the frame centre; that shift is
    what actually centres the content.
  - **A7d-bag — icons in the drawer** ✅ **done 2026-08-06.** It wanted exactly what this entry said:
    an art id per `BagRow`, which **protocol 20** adds — filled through `artClassOf`, the resolver
    `index.ts` already injects for `EntityView.wearing`, so an item in your bag and the same item on
    your shoulders cannot draw differently. The icon is DOM (`client/src/bagicon.ts`), cropped to its
    own alpha bounding box the way A7d's floor icons are, and it **also pays off A7d's deferred
    finding**: the facing is *measured* rather than assumed to be south, because a cloak facing you is
    only its hem. Live, that took `cape-solid`'s icon from an 11-pixel sliver to the whole hanging
    cloak. The floor icons still use row 2 and want the same treatment, in `artgen` where it can be
    measured once per sheet.
  - **A7e — recolour** ✅ **done 2026-08-06.** Built as **render-time**, not staged: see the handoff row for the four reasons and for the three measurements that changed. Original entry follows.
  - ↳ *(original entry)* (owner, 2026-08-05). Pick a sheet and a named colour ramp, and stage the
    result as new authored art: *"if I need a fiery red cloak I can select the black one and change
    the colors."* **Not an image editor** — ULPC ships the whole palette system
    (`PALETTE_RECOLOR_GUIDE.md`, `palette_definitions/`). See the parking lot for the four things to
    settle first, and **five measurements taken 2026-08-06 that make it startable cold**:

    1. **The field is `recolors`, not `palettes`** — `{ material, palettes: [...] }`, and the earlier
       count was of the inner array. **424 of the 657 definitions carry it**, confirmed.
    2. **A palette entry is `[family.]version`** — `"ulpc"` resolves against the declared `material`,
       `"cloth.ulpc"` and `"all.lpcr"` name a family explicitly. So one art can offer ramps from more
       than one family.
    3. **The source ramp is named in the family's own metadata** — `meta_cloth.json` carries
       `"base": "white"`, `body` is `light`, `hair` is `orange`, `wood` is `maple`. That is the whole
       recolour: map the base ramp's colours to the target ramp's, **index by index**, at the guide's
       tolerance of ±1 per channel. Ramps are 6 colours everywhere except `eye`, which is 3.
    4. **`metal` declares a base (`steel`) and has no palette files at all.** So an art can declare
       recolours that resolve to nothing — `arms_armour` is one — which is the parking lot's point (3)
       in a sharper form: the picker must refuse by name, and the *harvest* should only list ramps whose
       file exists rather than leaving the panel to discover it.
    5. **The whole palette set is 13.7 KB of JSON** (75 ramps in `all`, 24 in cloth, 26 in hair …), so
       baking it into the generated index costs nothing and needs no route.

    **One architectural note the parking lot's guess should be weighed against.** It assumed the
    recolour runs server-side and stages a new PNG, which needs a decoder and an encoder the project
    does not have (`artgen` reads IHDR only). The pack itself recolours **at render time**, and our
    client already reads pixels back off a loaded texture — that is what A7d's icon crop does. A ramp
    is also arguably part of *what the thing is*, so `cape-solid#red` in `wearing` would need no
    protocol change at all. Cheaper, and closer to what ULPC ships; decide it before writing code.
  - **A7f — Ollama picks the ramp from a description** ✅ **done 2026-08-06.** Built with the model as the *fallback* rather than the first resort — see the handoff row. Original entry follows.
  - ↳ *(original entry)* Strictly after A7e: a model cannot draw, but
    mapping *"a fiery red cloak"* onto one of two dozen ramp names is classification over a closed
    vocabulary, which is what a small local model is good at — and it is §8's rule again, **the model
    drafts and the human commits**. The prize beyond one item: every catalogue entry already carries
    the builder's own name, so a pass could propose art *and* ramp for a whole zone's loot without
    anybody retyping a description.
- **A8d — A zone from nothing** (owner, 2026-08-06). Create a whole zone in the panel, not just rooms
  inside one. **Three cases A8's rules cannot express**: an authored *zone* id from a reserved base with
  a stored counter (ids are the join key and must never be recycled), a Place with **no rooms and
  therefore no extent** — the first room has no neighbour to touch, which is the one placement A8
  refuses — and `world.config.json`, which is deliberately *data*, so either the operator adds the id or
  `GameWorld` learns to load a zone live. See the parking lot for the fourth thing: a zone nobody can
  walk to is invisible.
- **A9 — Editing a mob** ✅ **done 2026-08-06.** `MobOverride` grew from loot to ten fields — name, room
  line, keywords, level, hit points, damage, armour class, experience, wimpy threshold and sprite — with
  `applyMobOverride` folding them over the **pristine** harvest and `pristineMobs` stashing it, so
  *Restore harvested* is a real revert rather than whatever the last edit left. **Four things the build
  decided that this entry did not raise.** (1) **`combat` is re-derived, not patched**: a template stores
  the *derived* profile and the attack bonus is a function of the level, so authoring a level and leaving
  `combat` alone gives a level-40 kobold that hits like a level-8 — driven live, where the edited mob
  rolled `d20 4 → 17`, the +13 of its new level. (2) **Aggression is deliberately not offered**, though
  this entry lists it: it is a rule rather than a field, and `matchesAggro` can evaluate exactly one of
  its clauses (`all`) until races and alignment arrive at Phase 21 — a dropdown setting *aggressive* with
  no clause under it would mark a mob hostile that never attacks. (3) **The routes are `/mobs/:vnum/
  template`, not `/mobs/:vnum`**, because `DELETE /mobs/:id` already took that path for an *entity id*
  and A4c's own note says not to build one path whose id space depends on the verb. (4) **The panel posts
  only what changed**, so the ✎ mark names one field rather than all ten — and an untouched room line
  stays unauthored, which is what lets a re-harvest keep flowing through it. `writeDice` was added to
  `shared/rules.ts` as `parseDice`'s exact inverse: the damage box round-trips through it, and a printer
  that dropped the bonus would quietly cost a mob eight damage a swing the first time somebody opened the
  editor and pressed Save. Original entry follows.
- ↳ *(original entry)* (owner, 2026-08-06). Name, keywords, level, hit points, damage, sprite,
  aggression and flags, through the overlay A4c already built for loot. **Per template**, so it changes
  every instance the world spawns and none of those already standing — the sentence A4c had to put in
  the panel, and for the same reason. Note what it also is: level, hit points and damage are what 14b
  calibrated combat against, so this is the fastest way to make a zone unwinnable, and the panel should
  say so where somebody can read it.
- **A9b — Mobs you make yourself** ✅ **done 2026-08-06, the record half.** `server/src/mob-authoring.ts`
  is the fifth overlay and A6b's shape exactly: a **whole** `MobTemplate` rather than a patch, its own
  file with the opposite lifecycle rule (an emptied override is deleted; a created mob whose name is
  blanked is a bug), `AUTHORED_MOB_BASE = 9,000,000` measured against a harvest that runs 1,400–200,319,
  and a **stored** counter that never reissues a freed number. **Three things the build decided.** (1)
  **Aggression is offered here, which A9 refused** — and the objection is answered rather than dodged:
  A9's problem was a form that could set a disposition while leaving `clauses` empty, marking a creature
  hostile that never attacks. One boolean cannot reach that state, because `true` writes the disposition
  *and* the `all` clause together — the one clause fully evaluable before Phase 21. `hunts` carries the
  memory bit with it for the same reason `huntRule` refuses to let a caller forget it: a hunter without
  memory is inert in the source and inert here. (2) **`PATCH /mobs/:vnum/template` dispatches on the vnum
  range**, so the panel has one route and cannot pick the wrong store — above the base it is a re-draft
  of a whole record, below it a patch over the harvest. (3) **A harvested mob cannot be deleted and the
  refusal says why**: the next worldgen would restore it, so a delete that appeared to work would be a
  lie with a restart's fuse on it. Deleting a created one leaves what is already standing standing —
  those are ordinary actors in ordinary fights. **What is left is placement**, below. Original entry
  follows.
- ↳ *(original entry)* (owner, 2026-08-06), after A9. A6b's shape for mobs: an authored vnum
  from a reserved base, a **stored** counter, and a spawn-table entry with no `.mob` file behind it —
  which is a case `buildZoneSpawns` has never had to handle.
- **A9c — Putting a made creature in the world permanently** ✅ **done 2026-08-06**, on the owner's word:
  *“the mob needs to be assigned a room in a zone and not just dropped by hand.”* `server/src/placements.ts`
  is the sixth overlay, keyed by **mob vnum** — the question an operator actually asks is *where does this
  thing live* — with the **zone derived from the room** rather than typed, so it is not a second field
  anybody can get wrong. **The whole trick is that a placement is an `M` command and nothing more**:
  `runReset` looks a command's vnum up in the same map A9b adds created mobs to, so a reset naming
  9,000,000 needed **no** change to the executor at all. The case this entry called unprecedented turned
  out to be unprecedented only in the *harvester*, which never runs against these. **Four decisions.** (1)
  **Appended, never interleaved**, with `ifPrevious: false` — a zone file's order is load-bearing because
  `G` and `E` attach to *the last mobile loaded*, so an authored `M` in the middle of a harvested table
  would hand somebody else's sword to a creature we added. (2) `percent: 100`, because `runReset` fires an
  `M` on a timed repop **only** at exactly that; anything less is a placement that mostly does not happen.
  (3) **`ZoneClock.spawns` became mutable**, since a clock copies its table at boot — writing only the
  overlay would be a change that took effect on the next restart and not before. Rebuilt from the harvest
  on every write rather than appended, or the table would grow by one per save. (4) **The limit is
  world-wide, not per room** — Duris' `arg2` is `mob_index[].number` — which is what makes a lured mob
  suppress its own replacement, and surprising enough that the panel says it out loud. **Driven live**: a
  bone hound placed in two rooms, arriving in both on repop, holding at its limit of two across a second
  repop, and — the point of the whole row — **standing in both rooms after a full server restart with
  nobody having spawned anything**. Original entry follows.
- ↳ *(original entry)* (2026-08-06, out of A9b). A created mob is
  an ordinary template the moment it exists — searchable, editable, lootable, spawnable by A4's own
  button — and it does everything a harvested one does **except repop**. A zone's population comes from
  `data/world/spawns/*.json`, which is a **worldgen output**: writing a reset there would be undone by
  the next harvest, which is the exact rule A4c's overlay exists to obey. So placement needs the sixth
  overlay — authored reset commands per zone, merged into `loadedSpawns` at load, ahead of `runReset`.
  Worth doing next, because until it lands a made creature is something an operator puts down by hand
  and loses on restart. Note the case that has no precedent: a reset naming a **mob vnum with no `.mob`
  record**, which every existing reader assumes cannot happen.
- **A4c — Loot: assigning items to mobs** ✅ **done 2026-08-05, round 8.** `server/src/mob-overrides.ts`
  is the fourth overlay, and the two things this entry said to settle were both settled the way it
  guessed. Kit is per **template** and the panel says so out loud, reporting how many instances are
  already standing and unaffected. The overlay **composes over** harvested kit — applied *after* the
  reset table, so an authored piece wins a contested slot and the harvested one it displaces goes to
  the mob's hands rather than being destroyed. That makes "additive" literally true: what is on a body
  only ever goes up. One thing the build decided that this entry did not raise: **a slot the game does
  not model is refused rather than downgraded to carried**, which is the opposite of what `reset.ts`
  does with a harvested `E`, because inherited data is worth keeping while a slot somebody just typed
  should not silently mean something else. Original entry follows.
- ↳ *(original entry)* (owner, 2026-08-04). *"we also need to be able to assign
  items to mobs as loot."* Agreed, and it belongs with **A4** rather than with A6b: the item side is
  done — anything in the catalogue, created or harvested, can already be instantiated — and what is
  missing is a **mob overlay**, the same shape `items-authored.json` gave items, carrying the `G`
  (carried) and `E` (worn) kit a template hands its instances. Two things to settle before building.
  **Kit is per *template*, not per instance**, so authoring it changes every kobold guard the world
  spawns, which is almost certainly what is wanted but should be said out loud. And **the harvest
  already produces kit** — `data/world/spawns/*.json` carries `G`/`E`/`P` resets — so this overlay
  composes over harvested kit exactly as the item overlay composes over harvested fields, with the
  same partial-versus-whole question answered the same way.
- **A7q — Quests.** After Phase 21, same rule as the old A7.

---

### Explicitly not scheduled

Hunger, thirst and aging — Duris built all three, shipped them, and switched them off. Racewar
faction filtering. Paging (our DOM log is better). Charm, mounts and tradeskills are fine content,
later. The 3D client — see [PLAN-3d-migration.md](PLAN-3d-migration.md); it is a new
`@mygame/client`, not a new project, and nothing above is invalidated by it. (Owner re-affirmed
2026-08-07: everything being built now is the proof of concept that the mechanics survive that
port — think about it, build none of it yet. The plan is the thinking; the architecture rule it
rests on — no pixels in `shared` or `server` — is already CLAUDE.md law.)

---

## 4. Intake: where a new idea goes

The failure this section prevents is the two easy answers — *"do it now"* and *"add it to the end"* —
which are the same mistake in opposite directions. Three questions, in order.

**1. Does an already-scheduled phase get more expensive if this lands after it?**

If yes, it goes **before** that phase, or into it. This is the only reason to move something early,
and it is almost always about *signatures*: a new axis on the character, a new argument to every
action, a new field every message must carry. Posture (Phase 4) is the type case.

**2. Is it a mechanism, or is it content?**

Content — a mob, an item, a zone, a spell, a room description — slots **after the phase that makes
its kind possible**, and it does not need a phase of its own. Twelve new mobs is not twelve phases;
it is Phase 8 being used. Only write a new phase when nothing existing can hold the idea.

**3. Can it be seen on its own?**

If yes, it can be its own phase. If no, it is *Carries* on the first phase that needs it — never a
phase of its own, however large it is. That is the rule that keeps the progress bar honest.

### Recording the decision

Every idea gets a line in the parking lot below, **with the answer written down**, even when the
answer is "not doing this". An idea that was considered and placed is settled; an idea that was
mentioned and forgotten comes back every month.

| Idea | Verdict | Where |
| --- | --- | --- |
| **Either-hand weapons — light blades wieldable in main OR off hand, Windsong among them** (owner, 2026-08-07) | **Agreed, and it is the doorway to dual-wield, which decides its size.** The *flag* is small — a `handedness: 'either'` beside `twoHanded`, a `wield <weapon> offhand` form, the paper doll already has the slot — but an offhand weapon that never swings is a stat stick wearing a sword's name: the thing that makes it *matter* is the **offhand attack**, which is a combat-round change (the source rolls the second attack off `SKILL_DUAL_WIELD` with its own to-hit penalty, and our round grants one swing per actor by design). So the flag, the wield form and the Windsong/dagger data land **with** the dual-wield skill, as one visible slice — not before it, where the flag would sit tested-and-meaningless, which is the four-mechanisms failure `ROADMAP.md` rule 1 exists to prevent | **One slice, with Phase 21's early skills or beside them**: `SKILL_DUAL_WIELD` from the source, the second swing on the round boundary, the either-hand flag, and Windsong's own entry — she was born for the off hand and should demonstrate it |
| **`quaff`/`drink` for potions, `read` for notes, `eat` for buff foods** (owner, 2026-08-07) | **Agreed, and they are three different sizes.** **`quaff` ✅ built 2026-08-07, the same night**: the scroll layout, the scroll reader, 662 potions harvested (150 castable) — plus the three drinking rules that make it its own verb: everything on the drinker, one draught per thirty-second timer, and a flat-50% mid-fight spill (`CMD_Y` where recite is `CMD_N`). **`read` needs the extra-description harvest**: the `.obj` parser already walks `E` blocks and `toTemplate` drops the text — carrying it is a catalogue-size decision (16k items × prose) worth measuring first; boards are their own machine (`boards.c`) and wait. **`eat` ✅ built 2026-08-07, same night** — and the guess about its shape was wrong in the best way: the source's foods do not cast spells, they grant **regeneration** (`value[1] × 15` hp/min for `1 + value[0]` ticks), which IS the owner's fast-heal memory, riding second wind's own apply locations. 541 harvested, 36 poisoned traps kept, hunger still explicitly off. The drive also flushed a latent affect-stacking bug that had been eating bless's hit node since slice 5 | `read` after the extra-description measurement — the last of the three still parked |
| **Weapon procs — weapons with their own special attacks** (owner, 2026-08-07) | **Agreed, and it is a mechanism plus transcription content, cleanly split by §4 question 2.** Owner's memory of the mechanic is precise and worth keeping verbatim: *"some weapons came with buffs or special abilities like extra attacks etc. in game we called it proccing. when a weapon procced for example the elven sword named windsong would do an extra 2-4 slashes that round with a special text… and it could proc on a proc."* In the source these are **object special procedures** — C functions bound to weapon vnums (`specs.object.c`), fired from the combat loop with their own odds, their own `act()` prose, and nothing stopping recursion — so the data is not in the `.obj` files and cannot be harvested; each named weapon is a transcription. **The mechanism is small and everything it needs now exists**: an on-swing chance hook beside the round loop, extra blows through `landBlow` (Phase 19's seam), the weapon's own line through `actAround`, `attackResolved.swing` so the extra slashes *animate* (protocol 22 landed first, which is the right order), and proc-on-proc is just the hook firing on its own blows with the source's own unbounded odds. **What it waits for**: nothing structural — it is a good next mechanic slice. Transcribe 3–5 named weapons from `specs.object.c` as the first content, Windsong first if it is in there | **✅ Built 2026-08-07, the same day it was asked** — and the research overturned the row's own premise: most procs are *not* C, they are **data in the `.obj` records** (`value[5..7]`, read by `weapon_proc` before it ever consults a C spec), so 151 weapons harvested theirs and ride `deliverSpell`. The C-spec family became `procs.ts`'s special registry, opened by **Windsong** (#9000000, from the owner's Sojourn memory, on an elven master ranger at a 2% spawn-time drop — the rare-drop ask landing in the same slice). Left for later, named: defensive GOTHIT/riposte procs (a pre-damage seam in `combat.ts`), procs on ability blows, `value[4]` poison |
| **Accounts and login — letting a real person connect and own a character** (owner, 2026-08-05) | **Agreed, and by §4's first question it is the most misplaced thing on this schedule: it is signature work and nothing has been written down about it at all.** Today **the name *is* the identity**. `hello` carries a name, the server does `store.load(name)`, and you are that character — there is no password, no account, and no creation step. Two people typing `Aldric` are one character. **The reason that has not bitten is a single line**: `http.listen(PORT, '127.0.0.1')`, so nothing off this machine can reach the game at all; both Vite servers bind localhost too. **The bind and the authentication are therefore one decision and must never be two** — exposing the port without accounts means anybody who guesses a name takes that character, gear, explored map and all. (The admin API would survive it: its gate refuses any request whose remote address is not loopback, and that runs *before* the token — but `GAME_ADMIN_TOKEN` is unset, so loopback is the only thing standing.) **Why it is signature work, precisely**: a character is keyed by `slugify(name)` in `data/players/*.json`, and that key is also what `hello` sends. Adding accounts later changes the protocol's first message, the save-file key, and every file on disk — the exact "a new argument to every action" shape §4 question 1 exists to catch. Every phase that adds a persisted field before this lands is another field to migrate. **The lineage has an answer worth transcribing rather than inventing**: `account.c` is 2,675 lines and does account-then-character, with **bcrypt** hashing (`bcrypt_hash_password`/`bcrypt_verify_password`), email validation and verification, a per-account IP list, and **`MAX_CHARS_PER_ACCOUNT 16`**. So the shape is one account owning up to sixteen characters, not one password per character. **Four things to settle.** (1) **Which hash** — bcrypt is what the source uses and argon2id is what one would choose today; either is fine and neither should be hand-rolled. (2) **Whether email is wanted at all.** Duris verifies one; an email is a password-reset path and also a thing to store, protect and regret. A game with no reset path and no stored addresses is a defensible choice for a small server. (3) **Where accounts live** — beside `data/players/`, and note they are *not* world data, so the `data/world/overrides/` git-tracking argument does not apply; an account file must never be committed. (4) **The order of operations for going live**: accounts, then a bind change, then a tunnel or port-forward — and never the bind first | **Its own phase, and it should be pulled *early* rather than left near 21.** It blocks character creation (which needs somebody to create *for*), it is independent of every other phase, and its cost grows with every persisted field added before it. The natural slot is the next mechanic slot that is not already spoken for; the alternative — leaving it until Phase 21 with races and classes — is the one §4 question 1 explicitly warns against. **Owner re-affirmed 2026-08-07**: *"we will need a player creation/login mechanism at some point"* |
| **Character creation: choosing a race and a class, and rolling stats** (owner, 2026-08-05) | **Agreed, and it belongs at Phase 21 where races and classes already live — but the ask contains a real tension that has to be settled before anybody writes a roll, because D&D and Duris are measurably not the same system.** Owner's words: *"select a race and class and then do a stats roll within the rules of Dungeons and Dragons and still fitting the Duris model."* Measured, those are two different things. **5e**: six abilities, 3–18, modifier `floor((score − 10) / 2)`. **Duris** (`roll_basic_attributes`, `actwiz.c:5139`): **ten** stats — Str, Dex, **Agi**, Con, **Pow**, Int, Wis, Cha, plus **Kar and Luk that the player never sees** — on a **1–100** scale, where a normal roll is `3d6 + 77`, i.e. **80 to 95**. Agility is a stat distinct from Dexterity, Power is not a 5e ability at all, and two of the ten are hidden. So "within the rules of D&D" and "fitting Duris" cannot both be taken literally. **The project has already settled this exact conflict once and the precedent should be applied rather than re-argued**: `DESIGN-progression.md`'s rule is **SRD sets the shape, Duris sets the magnitudes** — which is how Phase 16a/16b did damage. Here that reads: take 5e's *shape* (which abilities exist, that a score yields a modifier, that the modifier is what rules consult) and Duris' *magnitudes and content* (the races, the classes, the feel of a roll). **Three decisions Duris made that are better than the obvious ones and are worth transcribing.** (1) **The roll is per race** — `ws_cmd_roll_stats` takes a race id and rolls *with* it, so racial modifiers are inside the roll rather than added afterwards, and no combination can produce an impossible score. (2) **The player is shown words, not numbers** — `build_chargen_stats_json` sends `stat_to_string2()` labels for every stat, so you learn your character is *strong*, not that it is 88. That is a real design choice about what a number is for, and it survives a change of scale. (3) **Five bonus points to spend after the roll** (`chargen_bonus_remaining = 5`), so a bad roll is a starting point rather than a reason to disconnect and try again. **The sharp problem, and it is not the numbers.** Duris ships **21 playable races** — 9 good, 9 evil, 3 neutral — and about **23 classes held as a bitmask**, so multiclassing is a *set* rather than 5e's level split. But that race list is organised entirely around the **racewar**, which this roadmap's *Explicitly not scheduled* section already excludes — and the racewar is load-bearing in the source, where `do_follow` refuses outright `if (racewar(leader, ch))`. Adopting the list wholesale would import a structure whose organising principle we have said we are not building. **That has to be decided rather than discovered**: either a smaller race list chosen for what it does to play, or the racewar comes back onto the schedule. **And note there is no foundation under any of this yet**: nothing in `shared` has a strength or a constitution, `DESIGN-progression.md` never mentions ability scores, and Phase 14b shipped its *storage* half (hit points rolled once and stored, Duris' experience table, the rolled starter kit) while the **derivation** half it was given — ability scores, hit dice, a way to earn a level — was never built. `proficiencyBonus` is the one 5e-shaped hook already sitting there, and it still has **zero non-test callers** | **Phase 21**, which already owns classes and races, with the ability-score half of **Phase 14b** as its prerequisite — a roll needs something to roll *into*, and there are no ability scores today. It also needs **accounts** (the row above) to exist first: creation presupposes somebody to create for |
| **Dropped items should decay, so rooms do not fill up with discards** (owner, 2026-08-05) | **Agreed, and the reason to do it is bigger than tidiness — it is currently a slow leak in zone repop.** Owner's ask: *"dropped items need to decay so we don't have rooms full of discarded items everywhere."* **The mechanism is already written, in our own code rather than the source's.** `corpses.ts` decays on a clock — 5 minutes, 30 for a player's — *(a per-corpse countdown on the tick, not a Scheduler consumer: Phase 20's research corrected this line, and anyone modelling a cast timer on "how corpses do it" would find a different mechanism)* — and it already gets the hard part right (`HANDOFF.md`: *a corpse spills before it decays*, because loot destroyed by a player being slow is the worse feeling). `ground.ts` is the store that has no clock, and it was deliberately built as its own store rather than an extension of `pickups.ts`, so it is the one file this lands in. **There is nothing to transcribe, and that is worth knowing before somebody greps for it.** Duris does not decay dropped objects: `ITEM_TIMER` is bit 26 of `extra_flags` and `defines.h:125` says it is *"used chiefly to load/activate traps"*, while the `timer` that `point_update` increments (`limits.c:1649`) is a **character** idle counter, not an object's. So the duration is a design decision, and the honest place to take it from is our own corpse clock, which was itself chosen rather than harvested. **The argument for priority is the `O` reset census.** `reset.ts` caps object instances **world-wide**, and the census counts what is lying on the floor and what is inside a container on the floor — that is what stops a repop minting another sword. So a room ankle-deep in discards does not merely look bad: it silently holds the zone's own limit at ceiling, and the sword nobody picked up is the reason the table upstairs has none. Clutter is the symptom; a zone that quietly stops repopulating is the cost. **Three things to settle.** (1) **What is exempt.** A corpse already has its own clock and must not get a second one; a quest object evaporating on the floor is the failure mode this must not create, and there is no "quest object" concept until Phase 21. (2) **What restarts the clock** — picked up and put down again is the ordinary case, and a clock that survives a pickup makes a bag a hiding place with a fuse in it. (3) **It wants `ground.ts` persistence decided in the same pass or not at all**: *Ground objects do not survive a restart* is on the Not-built list, and a decay clock that silently resets to zero every boot is a different rule from the one written down. §4 question 3 says it can be seen on its own — drop something, walk away, come back to nothing | ✅ **Done 2026-08-05, round 8.** Ten minutes, warned at one. **Persistence turned out not to be paired with it after all** — the floor is not saved, so a restart clears it outright and there is no long-lived object whose age a clock reset could be used to game. That resolves the third open question rather than deferring it |
| **A command that destroys an item outright, with a confirmation** (owner, 2026-08-05) | **Agreed, and the source has already decided both halves — including the confirmation, which is the interesting part.** Owner's ask: *"some other kind of command other than drop that will just destroy an item… might want to have a confirmation… so people aren't getting rid of items they didn't mean to."* **The verb is `junk`** — `do_junk` at `actobj.c:1630` — and its command-table row settles the two rules that were the open questions: `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)`, where `interp.c:2243` defines `CMD_CNF_N` as *"REQUIRES confirmation, and may NOT be used while fighting"*. So the owner's instinct and the lineage's agree exactly, and the confirmation is not a nicety somebody bolted on — it is a property of the command in the table, beside the posture requirement. The source even writes the prompt: *"WARNING: JUNK permanently destroys the specified object(s). Please confirm that you wish to JUNK %s (Yes/No) [No]:"* — **defaulting to No**, which is the right default and the one worth keeping. **The new thing is the confirmation mechanism, and by §4 question 1 that is what places this row.** Nothing in our command pipeline can ask a question and wait for the answer: a command is dispatched, it acts, it replies. Duris keeps a `confirm_state` on the **descriptor** — the connection, not the character (`comm.c:2556`, consumed at `interp.c:1228`) — so the state is per-session and the *next* line typed is read as the answer. That is a small, general mechanism, and it is **measured as being used exactly twice in the whole command table**: `junk` and `suicide` (`interp.c:2464`, `2467`). Which cuts both ways — it is not much machinery, and building it generally to serve one verb is over-building unless a delete-character verb is wanted too. **Two things to settle.** (1) **Read the guard before transcribing it**: `do_junk` opens with `if (!IS_ALIVE(ch) || !IS_TRUSTED(ch)) return;` and then later asks to confirm inside `else if (ch->desc && !IS_TRUSTED(ch))` — the two branches disagree about `IS_TRUSTED`, and the level column reads `56`, so what this command is actually available to in Duris needs settling rather than copying. Ours should be available to everyone; that is the whole point of the ask. (2) **The confirm state is the server's, and the client may only render it.** We have a surface Duris did not — a target menu and a modal — and a dialog is the better shape for *"are you sure"*. But a client that could answer its own question would be a client that destroys items with no round trip, so the state lives on the connection exactly as the source has it, and the dialog is a *view* of it. That is `HANDOFF.md` decision 1 in its smallest form | ✅ **Done 2026-08-05, round 8.** The confirmation is intercepted before the command table,  exactly, which is what keeps  meaning north when nothing is pending. One divergence: an unanswered confirmation is **cleared** by the next command rather than left armed |
| **Recolour LPC art from the item editor, and let Ollama pick the colour from a description** (owner, 2026-08-05) | **Agreed, and it is far cheaper than it sounds because the pack already does the hard half.** Owner's ask: *"we are going to need a lpc art editor eventually… so if I need a fiery red cloak I can select the black one and change the colors"*, and then *"it would be great if we can have ollama do the edits based on the description. if that is even possible."* **It is possible, and the reason is that this is not a paint program.** ULPC ships a whole palette-recolour system — `PALETTE_RECOLOR_GUIDE.md`, `palette_definitions/`, and a reference implementation in `sources/canvas/palette-recolor.ts`. Colour variants are **not** separate images there: one source sheet plus a named ramp, applied as a colour mapping. Measured: **424 of 657 sheet definitions (64.5%) declare `palettes`**, and the cloth family alone offers **24 named ramps** — brown, leather, walnut, yellow, tan, orange, rose, maroon, red, pink, lavender, purple, blue, navy, teal, bluegray, forest, green, white, sky, slate, gray, black, charcoal — with families for body, hair, eye, metal, wood and cloth. So "a fiery red cloak" is *pick `cape-solid`, apply cloth ramp `red`*, and the job is a generator step plus a picker control, not an image editor. **The Ollama half is a classification over a closed vocabulary, which is the one thing a small local model is reliably good at** — and it is the shape `DESIGN-admin-panel.md` §8 already established for prose: **the model drafts, the human commits.** Be precise about what it is choosing, though: a model **cannot draw pixels**; it maps a description to a *ramp name* out of two dozen. That is genuinely useful and it is also the whole of it. The richer version is the one worth building toward — items already carry the builder's own authored names (*"a hooded black cape"*, *"&+La long thin flaming rapier"*), so a pass could propose **art *and* ramp for a whole zone's loot** from names nobody has to retype, which is `describe-zone.ts` pointed at pictures. **Four things to settle before building.** (1) **The recolour runs server-side and stages a new art id**, the same rule the prose generator follows (§1's line, and `ollama.ts` must never be imported by simulation code) — a recoloured sheet is a new file under a new id, so it needs staging, an `ATTRIBUTION` line and the `previouslyGenerated` ownership check, or the next `npm run artgen` eats it. (2) **What the id is called.** Derived (`cape-solid-red`) is guessable and collides with a future pack entry of that name; allocated from a range like authored item vnums is safe and opaque. §1's overlay rule says the answer: it is authored content, so it belongs beside `items-authored.json`, not in the generated index. (3) **The 233 definitions with no `palettes`** need to be refused by name in the picker, exactly as the overlay mark now warns — an operator must not be offered a recolour that silently does nothing. (4) **Which ramp family a sheet uses** is declared per definition and has to be harvested with it; `artgen` does not read it today | **Track A, as A7e**, after A7d's icons — it is operator tooling and it can be seen on its own (§4 question 3), so it is a slice rather than a *Carries*. **The Ollama half is A7f and strictly second**: the recolour has to exist and be trustworthy before anything automates choosing one, and the bulk-from-item-names pass wants A4c's loot authoring beside it |
| **Whisper, so a room of people is not everyone shouting at once** (owner, 2026-08-05) | **Agreed, and it splits cleanly in two on §4's third question.** Owner's ask, immediately after watching V3's first bubble: *"we will need a whisper option so we can talk to just one person in the room or the group if we are grouped with other players. so we aren't all just talking over each other and filling the room with speech bubbles."* The motivation is the important part and it is a **real consequence of V3 that shipped with it**: bubbles are keyed per speaker, so six people talking is six bubbles, and the crowding the owner predicts is exactly what the implementation does. **Whisper to one person is available now and needs no phase.** Everything it wants exists: `actLines` already renders per recipient, the admin `tell` already proves a single-recipient path, and protocol 17's `from`/`speech` already carry what a targeted line needs — so this is a command and a recipient rule, not a mechanism. §4 question 2 says content-shaped work slots after the phase that makes its kind possible, and that phase was Phase 2. **Whisper to a group cannot be seen without a group**, so by question 3 it is *Carries* on **Phase 18** rather than a phase of its own, however obvious it looks — there is no list to send it to until following and grouping exist. **Three things to settle before building, and the first is the interesting one.** (1) **Does a whisper draw a bubble at all?** It should not draw the ordinary one: a private line with a bubble over your head announcing that you said *something* to *somebody* is the shape of a leak, and the crowding this feature exists to fix would come straight back. The candidates are no bubble at all, or a small distinct mark on the **recipient's** screen only — which is the one that still answers *"who is talking to me"* without telling the room. (2) **What an unseen whisperer reads as.** The `act()` gate already answers it — *"someone whispers to you"* — and it should be reused rather than reinvented, since a whisper from the dark is a real and interesting event. (3) **Whether the room learns anything.** Duris' own `whisper` tells onlookers that *"$n whispers something to $N"*, which is a deliberate design: whispering in company is itself a visible act. Worth transcribing rather than deciding — grep `actcomm.c`. **Also worth doing whatever whisper does:** V3 shipped with no cap on simultaneous bubbles, and a crowded room wants one — oldest retired first, or a count past which they shrink | **Whisper to one: ✅ done 2026-08-05.** The privacy needed no new mechanism — V3 put `from`/`speech` on the log line itself, so the recipient's line carries them and the room's does not. **Whisper to a group: Carries on Phase 18**, with following and grouping. **The bubble cap is V3's own loose end** and should land with the first of them |
| **A fled mob should remember, heal, and be waiting for you** (owner, 2026-08-04) | **Two halves: one is already the behaviour and should be written down, the other is the best idea in the exchange.** Owner asked whether a mob that flees mid-fight *"gets off scot free because I got distracted"* by a second attacker. **It does not, and that is already correct.** `pursuitTarget` bails while `player.fighting` is set — *"a fight in progress owns the player"* — but it **does not clear `player.pursuing`**. Kill the interloper, walk into the first one's room, see it, and the chase closes. Worth keeping: the alternative punishes a player for something outside their control, and it makes fleeing *strictly better for mobs in busy rooms*, which is where fights are already hardest. **The limitation to record rather than let somebody discover**: there is **one pursuit slot**, so a second mob fleeing overwrites the pointer and the first is genuinely lost. That is defensible — you can chase one thing — but it is undocumented today. **The half worth building** is the owner's own: *"a fleeing mob may also heal back up enough to want to attack me… when I enter the room it could try and jump me as the aggressor."* Agreed, for three reasons. It turns fleeing into a **tactical retreat** instead of a delayed death — a fled mob is a chore you walk to today. It **pairs exactly with the no-regeneration-while-fleeing lever** the owner picked in Phase 14: the mob only heals once it *stops* running, so there is a real clock to race, and the distraction becomes a genuine decision — chase now while it is weak, or handle the new threat and meet a healthier one. And the cost lands on a choice the player made, which is the kind of danger that reads as fair rather than arbitrary. **Memory should decide it, not a blanket rule.** `perception.ts` already keeps a `noticed` set per mob, populated **only when the template says `remembers`** — Duris' `ACT_MEMORY`, harvested and live. So a mob that remembers you ambushes and one that does not is merely standing there, which makes two kinds of enemy feel different using the source's own answer rather than an invention. **One thing to check before estimating**: whether `noticed` currently *triggers* aggression on entry or only feeds the reaction delay — that is the difference between "already works" and one piece of wiring, and it is ten minutes with `advancePerception` | **Phase 18**, with wandering mobs — a mob that remembers you and one that roams want the same pass over `perception.ts`, and the ambush is far more interesting once the mob might not be where you left it |
| **A marker over the mob you are fighting, and animations for what happens in a fight** (owner, 2026-08-04) | **Agreed, and the marker is the cheap half that should not wait for the animations.** Owner's reason is the one that matters: *"so you know which one you are focused on… it will also help when you switch to know you switched."* **The data is already on the wire and has been since Phase 7** — `EntityView.fighting` carries the entity id its owner is swinging at, and the client reads it today only to decide whether to show a combat indicator. So "which one am I fighting" is answerable in the renderer with no protocol change at all: the marker is a sprite pinned above the entity whose id equals your own `SelfView`'s target. Three things to get right, and the third is the one that makes it worth doing. **(1)** It must mark *your* target, not "anything in combat" — a room where four things are fighting must still show one marker. **(2) It has to stick to a mob that flees, and this is the requirement that decides the implementation** (owner, 2026-08-04): *"in case they flee into a room with a bunch of similar mobs that may have been damaged by other players."* That is exactly right and it rules out the obvious approach. `EntityView.fighting` is cleared the instant the fight breaks — `attemptFlee` calls `clearEngagements`, which is the whole point of the exit — so a marker driven by `fighting` alone goes out at precisely the moment it is most needed. **The pointer that survives already exists**: `markPursuers` sets `player.pursuing` to the fled body's **entity id** on every flight, for this exact reason — `HANDOFF.md` puts it as *"arriving where it stands re-engages that body, `kill youth` would pick the freshest youth instead."* So the marker is a *view of the pursuit pointer* rather than a new concept, and the owner's damaged-twins case is the one it was built for. **It is not on the wire yet** — `SelfView` carries no `pursuing` — so this is the one protocol addition the marker needs, and it is a single optional entity id. Note also that health fractions **cannot** be relied on to tell twins apart: they are on the wire, but another player's damage makes two youths look different for reasons that have nothing to do with which one is yours. **(3) It should move when the target changes**, because that is the owner's real ask — the marker *is* the feedback that a switch happened, which makes it the natural companion to the target-switching row above rather than a separate piece of polish. **A `Set focus` row on the target menu is the possible third piece** (owner, 2026-08-04), and it is filed as *potential* rather than agreed because the owner's own condition for it is right: *"this may only be required once mobs start roaming around."* Today a mob you clicked is still standing where you clicked it, so picking it and hitting it are one gesture and a separate focus step would be ceremony. The moment the wandering-mobs row lands — Phase 18, and the in-room drift before it — that stops being true: you click a kobold, it takes a step, and `kill kobold` may now find a different one. Focus would be the fix, and it is the same argument protocol 11 already made for clicking a body at all — **an entity id is the one thing that says *which* without either side guessing**, where a keyword in a room of three patrol members is ambiguous by construction. Two things to settle if it is built. **Where focus lives**: purely client-side is enough for a marker, but the moment `attack` uses it the server must still resolve it through the same visibility gate a typed word passes, or a click becomes more powerful than a word. **What clears it**: the target dying, leaving the room, or going out of sight — and it should clear *visibly*, because a focus marker that lingers on something you can no longer see is worse than none. Revisit when mobs move; do not build it before. **The animations are the other half and are a different size entirely**, sharing a root with the visible-weapons row: the LPC pack ships Swing, Thrust and Shoot sheets and our combat is a log line, so a swing has no motion to play. Doing weapons and combat animation together is what that row already recommends, and a bash or a switch would be more frames in the same pass rather than a new problem | **Marker: Track V, and it could go any time** — it needs nothing that does not exist ✅ built. **Animations: ✅ built 2026-08-07** on the owner's re-ask (*"attacks/spellcasts/bashed/sitting…"*), overtaking the Phase 16/19 assignments those phases closed without: protocol 22 (`attackResolved.swing`, `EntityView.casting`, posture finally read), the down pose for every non-standing body, 56 action sheets staged by byte-identity from the 15a pack. **What remains of this row is exactly what it always said**: weapon-in-hand frames share a root with the visible-weapons row (192px oversize sheets, the multi-layer ArtEntry fix "not to rush") and land together, later |
| **Weapons and shields drawn on the body, along with everything else worth seeing** (owner, 2026-08-03) | **Agreed, and it is the completion of what 15a started rather than a new idea — but it is an *art* problem wearing a code problem's clothes, and that is the whole reason it has not happened yet.** The engine half already exists and shipped in 15a: `EntityView.wearing` carries **slot → item id** for every character in the room, the client layers sheets in dressing order (feet → legs → chest → head), and adding a layer is a row in a table. Two counts say where the work actually is. **We have no weapon or shield art at all** — 37 files staged under `client/public/lpc/`, every one a body or a garment (head, chest, hands, legs, feet), and not a sword among them. And **the LPC pack ships weapons as attack animations only**: Swing, Thrust and Shoot sheets, with **no idle-hold frame**, while characters are drawn from the walk rows. So a visible sword is not a matter of pointing at a file that exists; the frame where a character simply *stands there holding it* is the one frame the pack does not have. Three ways out, and they should be costed before one is picked: **(1)** draw the hold frames ourselves to match, which is the `CLAUDE.md` art rule anyway (*creatures LPC lacks get drawn to match rather than borrowed from another style*) and is a handful of frames per weapon class rather than per weapon; **(2)** use the attack sheets and give combat a *motion* — a swing is a log line today, not an animation, so this buys the visible weapon and the missing combat animation in one pass, and is the larger and better prize; **(3)** ship weapons as a static overlay pinned to the hand position, cheapest and the one most likely to look wrong the moment the character turns. **Shields are the easy half and worth doing first**: LPC does have shield art, a shield is held rather than swung, and the off hand is already a slot — so shields could land ahead of the weapon-animation decision entirely. Two things to settle whichever way it goes. **What counts as worth drawing** is the owner's own line — *"except rings, neckwear or other obviously small or insignificant item"* — which is a per-slot decision, so the layer table needs a "drawn" column rather than every slot being assumed visible. And **which sprite an item maps to stays the client's business**: `wearing` sends ids, never sheet names, precisely so a re-skin is not a protocol change, and 2,841 weapons must resolve to a handful of *classes* (sword, axe, staff, bow) rather than 2,841 sheets — the catalogue's `type` and the weapon class in `value[0]` are the join, and `value[0]` is already read for the two-handed rule | **Phase 16 — gear that matters**, where it already sat as a known art gap; shields are separable and could go earlier. Pair the weapon half with the combat animation rather than doing it twice |
| **Target switching in a fight, with a chance of failing — for players and for mobs** (owner, 2026-08-03) | **Half of this is already built and running, and the half that is not is a smaller decision than it looks.** Taking the owner's two paragraphs in turn. **The mob half — *"if more than one player is attacking the mob it should take a chance at switching to the more damaging one… tanks obviously have some way to hold the mob's focus so the chance of switching off of a tank is reduced"* — is Phase 12, shipped.** `shared/src/threat.ts` and `server/src/combat.ts` keep a threat table per engaged mob: damage adds threat 1:1, **healing an engaged ally adds threat too** (which is why healers get attacked and why protecting them is a real job), and the mob targets the highest-threat entity it can reach. Holding focus is not a separate mechanism — it *is* the table, and `THREAT_SWITCH_MARGIN = 1.1` is the "reduced chance of switching off a tank" the owner is describing, spelled as hysteresis rather than as a roll: **a challenger must exceed the current target by ten per cent before the mob turns**. `DESIGN-mobs-and-movement.md` §2.7 says why that detail is not optional — with a bare `>` two similar attackers make a mob spin between them every round, which looks broken and makes tanking impossible by construction. Worth noting this is **the one place the project knowingly diverges from Duris**: `PickTarget` scores every victim with `CountToughness` and attacks the *weakest*, a predator's rule that cannot produce tanking at all. Both rules are used — weakness picks who a mob opens on when it has no history, threat governs every switch after. **So what is actually new is the player half**, and it is not a missing feature but a change to a working one: `startFight` already retargets freely — §2's stop-then-set, so `disengage` then `engage`, always succeeding — and **Duris is the same**, `do_hit` simply sets the new opponent and refuses only "you are already fighting them". Nobody in the lineage charges a player for turning. So the ask is: **make it possible to fail.** Three things to settle, and the first is the real one. **(1) What is it rolled against?** Every other roll in this game is an ability score or a skill, and a flat constant here would be a magic number that Phase 19 immediately replaces — so this wants to be a skill, or to wait for one. **(2) Duris already has the roll shape, in the other direction.** `SKILL_RESCUE` in `actoff.c` pulls a mob off a friend and fails on `number(1, 100) > GET_CHAR_SKILL(ch, SKILL_RESCUE)` — and `mobact.c:6655` gives the same skill to *mobs*, so a follower rescues its leader when the leader has more attackers. That is the same tactical idea the owner is reaching for, it is authored content we already harvest, and it may be the better verb to build. **(3) A failed switch has to cost something or it is free retrying** — a wasted round is the obvious cost and matches the round-based clock, but it means the failure is felt as "I did nothing this round", which is the least popular thing a combat system can do; the alternative is that you switch but the old target gets a free swing | **Phase 19 — skills**, with `rescue` as its sibling. The mob half needs nothing. Building the player half before there is a skill to roll against would mean inventing a number and then throwing it away |
| **A mob should wander inside the room it is standing in** (owner, 2026-08-03) | **Agreed, and small — but it needs the arrival fix first.** `Simulation.relocate` puts every body on the room centre, so mobs already stack there; adding idle drift before that is fixed makes the stacking more visible rather than less. Duris has no notion of position within a room at all, so there is no source behaviour to transcribe — this one is ours. Shape: a slow random walk bounded by the room own tiles, with Phase 14c`s `station.ts` already holding a *fighting* mob still. Two things to watch: it must not walk a mob out from under a player mid-swing, and 92 mobs drifting every tick is 92 entity updates a tick where there are almost none now | **Track V, after the arrival fix** |
| **Start, restart and stop the server from the admin dashboard** (owner, 2026-08-03) | **Agreed, and it needs one architectural decision first, because two of the three verbs cannot be served by the thing they act on.** `DESIGN-admin-panel.md` §1's rule is that the game server is the only writer and the panel is a client of it — which works for every operation so far and breaks here: a **stop** button is served by the process it is about to kill, and a **start** button has to be answered by something that is running when the server is not. Only **restart** is nearly self-serving, and even that needs a survivor to bring it back. So this wants a **supervisor**: a small long-lived process that owns the game server as a child, exposes the three verbs on its own port, and is what the panel actually talks to for lifecycle. That is a new component rather than a route, which is why it is worth writing down rather than attempting inline. Three things to settle with it: **(1)** the supervisor is now the most security-sensitive surface in the project — it starts processes — so it wants the loopback bind and the token treatment §3 already describes, and arguably a token that is *mandatory* rather than optional; **(2)** `npm run dev` currently runs server, client and admin under `concurrently`, so the supervisor has to know which of those it owns or a restart leaves Vite pointing at nothing; **(3)** a restart drops every player, so the panel should announce it first — A2's world announce already exists and this is exactly what it is for. Worth pairing with a **graceful shutdown**: `PlayerStore` flushes on a debounce, so a hard kill can lose up to two seconds of progress, and a restart button that quietly costs players their last kill would be worse than no button | **Track A, after A4** — it is infrastructure rather than content, and A4's live ops are the last thing that wants the panel's current shape settled first |
| **Light should be shared — one person's lamp lights the room for everyone in it** (owner, 2026-08-03) | **Agreed, and it is the right model rather than a convenience.** Today light is strictly *per character*: `Actor.lightRadius` feeds a per-observer `visible` tile set, and `canSee` tests the subject's tile against **the observer's own** set — so two people standing together, one holding a torch, see different rooms. That is indefensible as fiction and it quietly punishes the thing the game most wants to encourage, which is travelling together. **The change is to make the lit set a property of the room rather than of the observer**: the union of every light source standing in it, so a level 50 in a glowing helmet lights the place for the level 1 beside them. Three things it collides with, and none are blockers. **(1) The cache.** `visibleTx`/`visibleTy`/`visibleRadius`/`visibleRoom` key a per-character recompute on that character's own movement; a shared set has to invalidate when *anyone* with a light enters, leaves or has their light change, which is a different trigger and wants its own key. **(2) Interest management stays room-scoped** — the union is over one room, never a neighbourhood, or a lamp two rooms away starts revealing things through walls. **(3) Hidden and invisible are unaffected**: shared light says which *tiles* are lit, and whether a particular body on a lit tile can be seen is still its own question, which is what keeps this from becoming a wallhack when stealth arrives in Phase 19. Worth doing at the same time: `light` is already an *affect* (Phase 5b), so a shared source is a fold over the affects of everyone in the room rather than a new kind of thing | **Track V, with or just after `look <direction>`** — both are about what you can see from where you stand, and both want `DESIGN-visibility-and-light.md` amended once rather than twice |
| **Damage should scale with level, so a level 50 kills a level 10 in a blow or two** (owner, 2026-08-03) | ✅ **Settled 2026-08-04 — `DESIGN-progression.md` §8 has the bands, the measurements and the argument.** Three things the analysis changed. **(1) It is a divergence from Duris**, which has no per-level damage bonus at all: `specials.damage_mod` looks like one and is a *race* multiplier. **(2) The three open questions are answered** — bands are 2–3 per level for 6–15, **8–10 for 16–20** (the world's own hit points jump 2.5× there, so the spike is content-tracking rather than taste), 3–5 thereafter; nothing below level 6 because 14b already got the newbie band right; rolled once per level and stored, like hit points. **(3) The magnitude question resolved the opposite way to this row's earlier guess.** It is not that the owner's proposal was 2.5× too small — a bonus big enough to make a level-50 *same-level* fight seven rounds is **+771**, at which point the weapon's seven average damage is **0.9% of a swing**, and this is the gear phase. Duris bounds its own flat term at ±100 for the same reason and does the rest multiplicatively. So the bands hold the six-to-eight target to **level 25** (14b's honest band was 1–15), degrade visibly above it, and the closing factor is Phase 19 skills, Phase 20 buffs and a group — which is what the owner said. The unequipped level-50-versus-level-10 test lands at **0.69 rounds**. Original entry follows | **Phase 16**, and §8 also flags two things that must go in the same pass: the mob-armour question, and the fact that `toTemplate` silently drops every `APPLY_DAMROLL`/`HITROLL`/`HIT` the parser already reads |
| ↳ *(original entry)* | **Agreed, and the owner’s proposed shape is right — the magnitude needed one more decision, which the owner has now made.** Proposal: a per-level damage bonus in widening bands, roughly 1-2 a level to 20, 2-4 to 30, 5-10 to 40, 10-20 to 50, landing near +220 at level 50. Measured against the harvested world (median mob hit points: **130 at level 10, 500 at 20, 1,170 at 30, 2,660 at 40, 5,175 at 50, 10,005 at 60**) it does the first thing easily — +285 average one-shots a 130-hit-point level 10 — and the *bands widen at close to the right rate*, holding a same-level fight at a near-flat 13 to 19 rounds from level 20 up rather than letting it blow out. That flatness is the hard part and the proposal already has it. **What it misses is the target.** `DESIGN-progression.md` §2 asks for a same-level fight of **six to eight rounds**, which 14b tuned the starter zone against; this curve gives 5.9 rounds at level 10 and then 13 to 19 for the rest of the game, so fights get twice as long as you level and never come back. **And the owner’s answer to that is the one that reframes it (2026-08-03): "the slog fights would be offset by teaming up along with other modifiers such as buffs."** That is right, and it means the 13-to-19-round figure above is a *solo* number being measured against a target that was set for solo play at level 1. A group of four at 17.7 rounds each is **4.4 rounds**, which is inside the six-to-eight band and arguably past it; add buffs and it goes further. So the curve may not be too shallow at all — what is actually missing is a statement of **what party size each decade assumes**, which is a design decision nobody has made yet and which every number here depends on. `DESIGN-progression.md` §2 needs that qualifier before its target means anything above level 10, and the honest reading of the measurement is that the proposal is close to right for grouped play and deliberately punishing for solo play at level 40+. **Answered by the owner the same day, and it settles the magnitude after all: ordinary mobs stay soloable at every level; the group content is *bosses inside those zones*, plus some super-high-level zones where everything needs a team — "a level 200 bunny would annihilate a level 50 player".** So the assumed party size for a *normal* fight is one, all the way up, and the solo curve really does have to reach six to eight rounds at every level — the 2.5x reading was right for ordinary mobs and wrong only about its reason. Two consequences worth writing down now: **bosses need a hit-point multiplier of their own** rather than being the top of the same curve, or "a team of skilled players" has nothing to bite on; and **a level 200 mob is authored content, not harvested** — every mob in the shipped world tops out at 60, which is also `MAX_LEVEL` for players, so mob level has to be allowed past the player cap and the experience award and to-hit maths both need checking at that range. Three things to settle before building it: **(1)** size the bands to that soloable target — roughly 2.5x the proposal above the twenties; **(2)** check the 10-to-20 stretch specifically, where mob hit points jump 3.8x in ten levels and a 1-2 band cannot keep up even for a group; **(3)** decide whether the roll is per level *once, stored* — like hit points and the starter kit, so a character’s damage is a fact about them — or rolled per swing, which makes the band a variance mechanic instead of a progression one. The first is consistent with everything 14b did. Also worth doing at the same time: mob **worn gear currently does not affect its armour class** (15c left that deliberately, see `reset.ts`), so any rebalance should decide whether to turn that on rather than tune around its absence | **Phase 16 — gear that matters**, with the mob-armour question; it is one balance conversation and splitting it means tuning twice |
| **Wandering mobs — a set patrol path, or free roaming within a zone** (owner, 2026-08-03) | **Agreed, and a real MUD mechanism rather than a nicety: grep `mobile_activity` and `ACT_SENTINEL` before designing it.** Duris moves a mob one room per MUD tick unless it is sentinel, and the flags that govern it — `ACT_SENTINEL`, `ACT_STAY_ZONE` — are in the `.mob` files we already harvest and are being dropped on the floor today, so the data for **free roaming exists**. A **set path** is different and has no source support: Duris does patrols with mob procedures in C, so ours needs authored route data, which is A4`s to edit. Three things it collides with, all already built: the hunt (a wanderer must not wander out of a chase), `station.ts` (a fighting mob holds its ground), and instance limits (a mob that wanders into another zone still counts against its own). Free roaming off the harvested flags first; patrol routes want the mob editor | **Phase 18**, and pull `ACT_SENTINEL` into the harvest whenever mobs are next touched |
| **Content editors: mobs, items, zones, quests** | **Done in principle — became Track A.** The admin panel (built 2026-08-02, off-schedule at the owner's request; `DESIGN-admin-panel.md`) is the delivery vehicle for all four, and it keeps this row's one rule: the server is the only writer, and authoring lands as overlay files the game loads — content that can only be edited through a tool is hostage to that tool. The landing order this row chose survives as Track A's order: mob authoring after Phase 14 (A5), items after 16 (A6), quests after 21 (A7) | Track A |
| **A colour picker in every editable text field** (owner, 2026-08-02) | ✅ **Done with A5**, as planned. The notation and the renderer landed as **V6**; the authoring half is `admin/src/colourbox.ts` — sixteen swatches above the box, insert-at-caret (wrapping a selection, opening at a bare caret), and a live preview rendered through the client's own `parseColour` so what is shown is what the player gets. Built as one component from the start, so A6 and A7 reuse it rather than reimplementing it | ✅ A5 |
| **Colour a name by what the character *is* — race, level, carried item** (owner, 2026-08-02) | **Agreed, and it is a different mechanism from the one V6 built.** V6 is *authored* colour: text that carries codes because somebody wrote them. This is **derived** colour — a rule that says what a name should look like — and it needs the facts to derive from: races and alignment are **Phase 21**, and "carrying a certain item" is Phase 15. Deciding it early would also mean choosing where it happens, and there is a right answer worth writing down now: the **server** paints the name, because who you may know a thing about is already a server question (`act.ts` renders an unseen speaker as "someone"), and a client colouring by race would be telling players a fact the server had deliberately withheld | After Phase 21 |
| **Creating whole new zones, with a local Ollama model writing the prose** (owner, 2026-08-02) | **Agreed, and explicitly last — the owner's own placement: *"that can wait until we do everything else first."*** It sits on top of **A8**: you cannot generate a zone until you can create one room, so nothing about it can start before geometry exists. Two things to settle when it comes up, neither of them about the model. **Where the text goes**: generated prose is authored content, so it lands in the same `data/world/overrides/` overlays A5 built and is reviewable and editable afterwards — a zone that can only be regenerated is hostage to the generator, which is this row's parent rule. **Where the model runs**: locally, and *offline of the game* — worldgen is an offline pipeline by design and generation belongs there or in the panel, never in the simulation, which `CLAUDE.md` rule 3 requires to stay deterministic. A model in the tick is a desync nobody can reproduce. **Which model is a picker, not a constant** — owner, 2026-08-02: *"will need to have a selectable model drop down as I have a few models installed."* Read the list from Ollama's own `/api/tags` when the panel opens rather than hardcoding names, so pulling or deleting a model on the machine needs no change here; remember the last choice; and **record which model wrote a room beside its prose in the overlay**, because *"why does this one read differently"* is otherwise unanswerable a month later — the same reason the audit trail exists | After A8. Not scheduled |
| **A complete zone editor, with a visual map** (owner, 2026-08-02) | **Agreed, and this row exists because the scoping above was too thin.** "Zone editor" was carried as one line — *the geometry editor is largest and last* — and A3 shipped a read-only browser against it. That is not what the owner means: they want to **see** the zone, **select** rooms on it, and **add and remove** them. Split three ways, because the costs are wildly different: the **map** is cheap and the room data is already a per-zone integer grid (**A4b**); **field editing** was already scheduled and just needs driving from the map (**A5**); **geometry** is a real phase-sized piece with four decisions in front of it, chief among them that resizing a zone's grid invalidates every saved `seen` map for that Place (**A8**) | A4b next, then A5; A8 after a design note |
| Authoring sanctuaries and other room flags by hand | ✅ **Done with A5.** `safe` is a checkbox on the room editor, and it was set on exactly one room in the shipped world — so sanctuary, built in Phase 10, is testable for the first time | ✅ A5 |
| **Rooms should say so when they have no description, and later be given one from a short prompt via Ollama** (owner, 2026-08-02) | ✅ **Both halves done, 2026-08-02.** The generation half became `server/src/ollama.ts` + `POST /rooms/:id/describe`: type a brief, pick a model, get prose in the house style. **The model drafts and the human commits** — generation saves nothing, the draft lands in the editor's box, and the ordinary Save writes it. The style is *shown, not described*: three real descriptions sampled across the same zone, plus the four nearest rooms for content. The numeric rules are measured rather than chosen — 90–140 words and ~7 sentences from IceCrag's median of 115 and 7; "never write you" because 1 of 216 does; "do not mention exits" because 16 of 216 do and the game prints them separately. Colour codes are stripped from the samples and forbidden in the output, because a malformed code is a literal ampersand mid-sentence in the game and the palette is six inches away. Punctuation is normalised to ASCII: the 315 shipped descriptions contain 110 straight quotes and **zero** curly quotes or em dashes. Model and brief are recorded in the overlay. Original entry follows | ✅ Done |
| ↳ **Would a different seed make same-named rooms unique?** (owner, 2026-08-03) | **No — and the premise is already true.** `draftDescription` sends `{model, prompt, stream:false}` and sets **neither seed nor temperature**, so sampling already free-runs: the same prompt gives different text on every call. Forcing a seed would make generation *reproducible*, not varied. Measured instead, three ways. **Same room ×3 on qwen2.5:14b**: 24–33% content overlap but a **12–14 word identical opening**. **Same title, different neighbours**: 26% overlap, **16 word identical opening** — and yet the bodies diverged *correctly*, the room beside the Gigantic Duskwood writing about duskwood and the one beside three oaks writing about oaks. So the owner's instinct about linkage is right and it works; what does not vary is the first sentence, because the model opens by restating the room's title. Instructing against that made it **worse** (overlap 26% → 51%). **The lever is the model, not the seed**: `gemma3:12b` halves the identical run (7–9 words) at the same overlap and produced one genuinely different room out of three. Root cause is our own prompt — the tight style rules (7 sentences, physical detail only, no exits, no second person) buy house-style consistency and per-room variety is what they cost. Near-identical is the one outcome worse than identical: with copies you read "the same kind of place", with paraphrases you cannot tell whether you moved | Measured, not scheduled |
| ↳ *(original entry)* | **Split, because the halves are days apart in cost.** The *placeholder* is done now — a room with no prose says so in the log, in dim text that reads as a builder's note rather than as the world's voice. Deliberately **rendered, not stored**: writing "description needed" into 40,619 override entries would mark every room authored, destroy the ✎ mark's meaning, and have to be undone one room at a time. It costs nothing and vanishes the instant real prose is written. The *generation* half — select a room, type `forest by a stream`, get prose in the house style — is **the first genuinely useful piece of the Ollama work** and is much cheaper than the zone-creation row below it: it needs no new geometry, no vnum space, and no new storage, because it writes into A5's existing overlay through A5's existing editor. Two things to settle: the **style prompt** is few-shot rather than described — sample real descriptions from the same zone, since "the style of the rest of the game" is Duris' style and it is on disk in quantity — and **which model wrote it is recorded beside the prose**, for the same reason the audit trail exists. Model choice is the `/api/tags` picker the zone-creation row already specifies | **Next A slice after A4** — before the zone-creation row, which needs A8 |
| **`look <direction>` — see into the next room** (owner, 2026-08-02) ✅ **built 2026-08-07** | **Built as the four rules said, with one source finding that reshaped it**: an ordinary mortal's `look <dir>` in Duris shows the *exit* and stops — the far room (description, occupants) is what **`AFF_FARSEE`** grants, and the owner's ask is the farsee behaviour, so plain look opens it deliberately; the day Phase 20 wants farsee to mean something, `peek.ts` is the seam it tightens. The far room's light gates it (never yours), a closed door and a one-way link refuse in the source's own words, counts aggregate (*"a kobold youth [x3]"*), and a **mutual** portal pair passes graph reciprocity so you peer through it six cells notwithstanding — the flee note's acceptance again. Original entry follows. **Agreed, and it is a MUD mechanism rather than a nicety** — Duris has `do_look` with a direction argument, so grep `act.informative.c` before designing it. The owner's shape: look east, and if that room is lit you get its description and a count of what is standing in it — *"1 sentry guard to the east"*. Four rules decide whether it is right, and three of them are about light. **(1) The gate is the *far* room's light, not yours** — you can see into a lit room from a dark one and not into a dark room from a lit one, which is the whole reason the feature is interesting and the opposite of what a naive `canSee(you, them)` computes. **(2) A shut door blocks it**, and `doorway()` already answers that from both sides. **(3) Mobs aggregate by name with counts**, not one line each: three patrol members read as "3 members of the Court Patrol", and the count is the tactical information. **(4) Hidden and invisible stay hidden** — this must go through the same visibility gate the entity feed uses, or it becomes a wallhack. **Do not reuse A5's `neighbourhood()`** despite the resemblance: that one is deliberately unbounded and ungated because an operator looks at the world from outside it, and wiring it to a player command would leak the whole castle. Interest management already ships neighbouring rooms, so the data is at hand — but resolution stays server-side, because a client that could ask for any room would be asking for exactly the rooms it should not see | **Track V, after Phase 15** — it wants doors and light to be settled, both of which they now are, but V3 and V4 are already queued ahead of it |
| Terrain inference quality (23.2% fall back to a default sector) | **Done — became Phase 5c.** Suffix rules plus graph label-diffusion took the default share from 23.2% to 0.2%; see the phase for what the held-out validation says about accuracy | Phase 5c ✅ |
| Temples or churches as sanctuary | Agreed in principle, not scheduled. Must be **authored**: nothing upstream marks them, and `ROOM_SAFE` is set on 11 of Duris' 781,053 rooms | After Phase 10, once pursuit gives sanctuary a mechanical meaning worth placing by hand |
| Container nesting depth (proposed max 2) | Open, not decided | Decide during Phase 17 |
| Room-scoped shared light (one player lights the room for all) | Real Duris mechanism (`char_light` → `room_light`), and a change to a tuned relationship — see `ROOM_GAP` in `tilemap.ts` | Not scheduled; needs a design note before it gets a phase |
| **Character progression: ability scores, hit dice, levelling, and somewhere to start** | **Done — became Phase 14b**, on exactly the placement this row had already argued: after Phase 14, before Act V, signature work by §4's first question. The "what death costs" decision Phase 13 left open moves there with it, because it needs progression's numbers to mean anything | Phase 14b |
| **Mob health bars on screen** | **Agreed — and it is arguably Phase 11's own Seen-when.** `EntityView.healthFraction` has been on the wire since Phase 7 and *no client code reads it*, so "a health bar drops" is currently true of the data and false of the screen. Open question the owner raised: shown on `look` or only once engaged | Phase 11, as the rendering half of its own completion test |
| **Combat outcome vocabulary — dodged, parried, shield blocked, casting** | **Agreed, and it splits.** The *mechanisms* are later: dodge, parry and shield block are defence skills (Phase 19) and casting is Phase 20. But the *wire shape* is §4's first question exactly — a reason on `attackResolved` costs one optional field now and a rewrite of every combat message site later, so the field is reserved in Phase 11 and the rolls that can populate it arrive with the skills | Field in Phase 11; dodge/parry/block in Phase 19; casting in Phase 20 |
| **`loot` targets the nearest unlooted corpse** (owner, 2026-08-02) | **Done — landed with Phase 14**, as a targeting refinement of Phase 13's own command rather than a phase of its own. Nearest unlooted first, then next-nearest, and only then a looted one, which keeps the "already picked clean" line reachable. `nearestLootable` in `corpses.ts` | Phase 14 ✅ |
| **Bash — a warrior's shield opening that knocks the target down, doubling damage until it stands** (owner, 2026-08-02) | **Agreed, and it is two things.** The *skill* is Phase 19's shape exactly: an opening attack, a knockdown roll, and it needs posture (built), the dying-window damage rules (built) and a skill system (Phase 19) to hang from — inventing it early would be the fifth tested-and-never-called mechanism. The *surface* — a menu offering it on a click — is V2, which grows a row per mechanic as the mechanics land | Skill in Phase 19; its button arrives with whatever V2 offers by then |
| **A light costs nothing: no hand, no slot, no bulk** (owner, 2026-08-06) ✅ **built 2026-08-06** | The first ask was *"move the ring of testing out of my main hand"*; the ruling that followed is broader and clearer: **light should come with no space, weight or slot cost.** So a light lights you from wherever it is — worn, held, or in the bag — and it is not charged against the twenty slots either. **That is a rules change, and it contradicts `DESIGN-inventory.md` §6 by name**, which argued that a light nobody has to hold is *free light for ever* and that a dedicated light slot would be the same mistake. §6 has to be **rewritten rather than quietly bypassed**, and the argument for rewriting it is the row below: once 95% of the world lights itself, light stops being a resource you ration and becomes a key to the 5% that is dark. That is a better mechanic than the one §6 was protecting, and it is the owner's design. **The measurement that made the old rule untenable anyway**: of the 64 catalogue entries that emit light, `LIGHT_BEARING_SLOTS` (hands only) leaves **11 that can never work** — 5 glowing earrings, a set of golden horseshoes, and 5 with no wear slot at all. **What it touches**: `LIGHT_BEARING_SLOTS` widens to every slot *and* the bag (`syncHeldLight` already recomputes on `afterKitChange`, which a bag change goes through, so the seam exists); the bag must stop charging bulk for a light, which is `limitOf`/`stackSlots` and not the item's `size` — a *lantern* still weighs something conceptually, it just does not cost you carrying capacity; and containers hold lights, so the scan is recursive or a lantern in a quiver goes dark. The paper doll's `lit` mark simply finds nothing to mark for a bag light, which is correct — the HUD line names it **Built, and §6 is rewritten rather than bypassed** — it now states the reversal, why the old argument held (every room was pitch black) and why it stopped (95% of the world lights itself), and what is lost: light's *second* progression axis, with duration named as where to put a cost back if it turns out to matter. `Item.light` carries the radius and burn so the bag and the light scan can answer locally; `LIGHT_BEARING_SLOTS` is **deleted** rather than left describing a rule nothing follows. **The bag write became the seam**: a light in the bag turned all twelve `player.inventory = …` assignments into light changes and only four re-derived — so there is now one writer, `sim.setInventory`, and assigning around it is the bug. **Driven live** in a dark mine: nothing carried → radius 2, **a torch in the bag and never wielded → radius 3**, a glowing earring worn in an ear → radius 3, and the bag reading **0 of 20 slots** with the torch in it |
| **Rooms that are naturally lit** (owner, 2026-08-06) ✅ **built 2026-08-06** | **Done, and it was the deletion of an assumption rather than a new mechanism — the data is already harvested and nothing reads it.** `'dark'` is a room flag in `world.ts`'s catalogue and **its only occurrence in the codebase is that declaration**: no server, shared or client file consults it. So the visibility model treats every room in the world as pitch black and a personal light is always required. Measured over the harvest: **2,283 of 46,508 rooms carry `dark` — 4.9%**, which means Duris' own builders marked **95.1% of the world as naturally lit**. In the loaded zones it is **41 of IceCrag's 219** and **37 of the Kobold Settlement's 99** (the two unmatched forest zones have none, because unmatched zones carry no harvested flags). That is exactly the owner's description: *"newbie zones probably won't need torches other than if there is a darkened room in the area, so if they find a torch they can explore it."* **The rule to transcribe, and how much of it.** Duris' own answer is `IS_LIGHT_ROOM` / `IS_TWILIGHT_ROOM` (`utility.c:6199`) and it is richer than one flag: twilight as a third state, `ROOM_MAGIC_LIGHT`/`ROOM_MAGIC_DARK` from spells, sector defaults (forest and swamp are twilight *only while the sun is up*), and `IS_NIGHT` — which we cannot transcribe because **there is no clock**. The honest slice is the **flag half now**: not-`dark` means the room lights itself, `dark` means bring your own, and the sector/time/magic layers are recorded as available the day there is a day-night cycle (which would make torches matter again outdoors, and is a mechanic in its own right). **What it touched**: two `roomLightsItself` / `naturalLightTiles` helpers in `light.ts` — the second is `roomLightTiles` at **zero** room-steps, so natural light and a beacon are one derivation at different reaches and there is no second lighting model — unioned into the lit set on **both** sides, because the server folds it into `seen` and gates clicks on it while the client paints fog from it. A union rather than a branch: your own light still reaches past the room's floor, so the two are additive and neither can subtract. **Driven live**: 81 tiles visible (a whole 9×9 floor) in the lit spawn field with **no light at all**, 21 (the bare-eye disc) in the dark Kobold Mines, and 58 in a dark room once a torch was in hand. Eight fixtures had to be marked `dark` — their subject is what a *carried* light reveals, and "no flags" had happened to mean that | **M track**, paired with the row above — and it is the half that makes that one right, because light stops being a tax and becomes the key to the 5% |
| **A new character starts with no light, and a dark room is pitch black** (owner, 2026-08-06) | **Already true, and the reason it is worth recording is that the two rows above are what make it *good* rather than punishing.** `Simulation.spawn` has said so since Phase 5: *"Everyone starts in the dark. Light is something you find, so there is no starting torch and no 'first light source' to configure — the bare radius is the whole of a new character's vision until they walk onto something."* The bare eye is `DEFAULT_LIGHT_RADIUS = 2`, a 5×5 patch inside a 9×9 room, chosen so *"you must walk toward each wall to find its exits, which is what makes the first torch a real upgrade"*. **What is wrong today is not the newbie rule, it is that the rule applies everywhere**: a level-1 character standing in an open field at noon can see 5×5 tiles, which is the same experience as standing in a sealed crypt. With natural room light the field is simply visible, the crypt is not, and the torch a newbie finds is a key rather than a permanent tax. **Nothing to build** beyond the two rows above; kept here so that nobody "fixes" the starting-light rule later by handing out a torch | **No work** — it is the existing rule, and the rows above are its point |
| **Authoring a light on an item** (owner, 2026-08-06) ✅ **built 2026-08-06 as A6c** | **Done, and it was a small A6 follow-on rather than a new capability.** The item overlay already exists (`item-overrides.ts`, `items-authored.json`) and `ItemTemplate.light` is a real field the loader reads — `lightSourceFrom(id, name, light)` — so this is two numbers in the editor (**radius** and **duration**) plus the same validation A6 gives every other field. Three things worth deciding with it, and all three are already answered elsewhere in the project so they only need transcribing into the form: the **radius is ours, not Duris'** (Diku light is a boolean, and `light.ts` deliberately gives every light a torch's reach so that what separates a candle from a lantern is *how long you keep it*, which means an author choosing 11 would be overriding a tuned relationship — the editor should say so or clamp); **duration is in Duris' own hours** where one hour is ten seconds (`light.ts` pinned that by making the two catalogues agree), so the field wants a unit label or it will be typed in milliseconds; and above about a thousand hours a light is **unlimited**, which is a real state rather than a big number and the form should offer it as one. Worth pairing with the row above: authoring a glowing helmet is pointless while only hands can light **Built, and it landed after the light rules on purpose** — before them, authoring a glowing helmet produced an item the game could not use. All three decisions above are in the code and said out loud in the form: the radius is **clamped to 4** with the reason on screen (*tiles, max 4*), duration is typed in **Duris' own hours** at ten seconds each, and blank means **never burns out** rather than zero. The server clamps too — a form is a convenience, never the gate — and its refusal names which half was wrong. **Driven end to end**: authored radius 4 / 600 s onto a long black dagger (nothing in the harvest lit it), and a character carrying it **in the bag** in a dark mine went from radius 2 to **radius 4 with 600 s left**; clearing the authoring put the template back to no light, and a fresh character with a fresh dagger stayed at radius 2 — while the *already-instantiated* one kept its light, which is `Item.light`'s own rule that the object carries what it was made with |
| **Looking at a corpse lists what can be taken from it** (owner, 2026-08-06) ✅ **built 2026-08-06** | **Done, and it was a refinement rather than a phase** — §4 question 2. `loot` targeting the nearest unlooted corpse went in the same way (*"a targeting refinement of Phase 13's own command rather than a phase of its own"*), and every piece this needs is built: `Corpse.contents` is real since 15b, `looted` already means *empty* rather than *searched*, and 15c gave `look <container>` a listing to copy — *"what is in it is the only interesting thing to say about one"*. So this is that sentence applied to a corpse. **One thing to decide rather than assume, because the project has already argued the other way once.** V2's target menu carries `EntityView.container` and the note is emphatic that the flag says *is a container* and **not** *what is in it*, because *"sending contents to everyone in the room would hand out the answer to the verb"*. A corpse is the opposite case and should be: a mob's worn kit **is** the reward (that is why a mob's corpse holds what it wore and a player's does not), and seeing a steel long sword on the body is what makes walking across the room worth doing. So the listing is on `look`, which is a deliberate act aimed at one body — not on the entity feed, which would put every corpse's contents on every screen in the room. **And it must list the *visible* subset from the start**, even before there is anything hidden, or the hidden-item row below becomes a change to what this row promised **Built as decided**: on `look`, never on the entity feed; the *visible subset* from the first version, so the hidden-items row cannot later change what this one promised; and **at any distance**, unlike a container — `lookInsideEntity` gates on reach because a container's contents are *inside* it, while a corpse's are *on* it, which is the same distinction that makes the verb `search` rather than `look inside`. It also puts the choice where the ask wanted it: you learn there is something worth having, then decide to walk over. An empty body **says so** (*“it has been picked clean”*), because otherwise silence means either *nothing on it* or *the feature did not fire* and a player cannot tell those apart. **Driven live**: six corpses on one floor, four picked clean and two listing a hooded black cape, a redwood torch and a long black dagger — the A4c-authored loot, which also demonstrated that rule in passing, since only the instances spawned after the edit carry it |
| **Take one named item off a corpse** (owner, 2026-08-06) ✅ **built 2026-08-06** | **Done, and it is the other half of the row above.** The ask: *“we need another command so we can just loot certain items from corpses — like `get axe corpse` — so it just gets the axe and leaves everything else, as a way to not overload your inventory.”* With the listing but without this, `loot` stays all-or-nothing and a twenty-slot bag turns a rich body into a problem rather than a reward. **No new verb**: Duris' `do_get` already takes `get <obj> <container>` where the container may be a corpse, so `get axe corpse` and `get axe from corpse` both route through the `from` split `get` had for containers. **Three decisions.** The refusals are `searchCorpse`'s, *called* rather than restated — `lootRefusal` for whose body it is and the same reach test around it — because two loot verbs with two ideas of whose corpse it is would be a way to rob a protected body by typing the longer command. `corpseAnswersTo` was extracted to `corpses.ts` so both verbs match names by one rule; it also fixed `loot corpse`, which read the bare word as a *dead thing's name* and so found nobody. And **coin comes off as coin even when named** (`get pile corpse` → the purse, no slot), or this would be the one path in the game that carries money against `DESIGN-inventory.md` §8. `get <a> <b>` is only read as the two-word form when `<b>` names something to take *from*, so `get long sword` on a floor holding one stays a pickup. **Driven live**: a temple guard's four pieces taken one at a time with the listing shrinking between each, the body flipping to *picked clean* on the last, a refusal for an item not on it, the reach refusal from across the same room while `look` stayed distance-free, and a sentinel private's pile of coins going 8→12 platinum with no bag slot spent |
| **A picture for every item that has none** (owner, 2026-08-06) ✅ **built 2026-08-06 as A7g** | *“go through all the items that don't have an LPC image and assign a best guess — I can manually review them later if some get a weird image.”* That last clause is the specification: being wrong visibly beats 16,421 items with no picture. `npm run artassign` (dry by default, `--write` to apply) matched **13,248** — 5,171 on a shared word, 8,077 on a per-slot fallback. **The slot is the join**: `artgen` tags every art entry with one, so the worst case inside a slot is *the wrong hat* rather than *a hat where a sword should be*. Guesses land in the **overlay**, so the run is one git diff, a re-harvest flows through underneath, and *Restore harvested* un-guesses one item at a time; an item somebody already authored is never touched, which makes a re-run safe. **Left alone and reported**: 2,652 carried-not-worn items (every art entry is equipment — a brass key with a bracer's icon is noise, not a guess) and 514 in `eyes`, `face` and `ioun`, which the pack has nothing for. The dry run earned its keep twice: the first fallback rule gave every unmatched sword a **farming hoe**, every cuirass a **bodice** and every amulet a **bow tie** |
| **A generator that makes the sprites we need from a description** (owner, 2026-08-06) | *“set up an LPC image generator that uses Ollama to pull the description (item or mob) and generate the images we need — the different angles or motions.”* **Worth splitting, because one half is nearly free and the other is the hard problem.** ① **Ollama for *choosing*, not drawing — buildable now.** `server/src/ollama.ts` already exists and already keeps the three rules this would need (the model drafts and the human commits, the server calls Ollama rather than the browser, never in the tick). Pointing it at A7g's **8,077 fallback guesses** is text→classification, which is what an LLM is actually good at, and it would turn *“some plausible thing in the right slot”* into *“the closest of the 62 shields”*. Same for drafting a mob's room line, which is A5's room prose with a different noun. ② **Generating the sheets is a different tool and a harder problem.** Ollama runs language models; pixels need a diffusion runtime, and even with one the blocker is not the model but LPC itself: a walk is **9 frames × 4 directions in a 576×256 sheet of 64×64 cells**, every layer must register pixel-exactly against one shared skeleton (that is the whole layered-equipment promise), the palette is tiny and fixed, and the same garment has to survive 36 frames unchanged. Diffusion is weak at all four — it has no notion of *frame 4 of the same cycle*. ③ **The high-value case needs no model at all**: the overwhelmingly common need is *the same tunic in another colour*, which is **A7e/A7f**, already parked, deterministic, and with the measurements taken — the pack declares `recolors`, names its source ramp per family, and our client already reads pixels back off a loaded texture. ④ **With a reference image in hand it changes shape, and for the better** (owner, 2026-08-06: *“if I have a reference image such as the kobold it would be good if it could generate the mob or item sprite based on the reference”*). A reference fixes colour, silhouette, proportions and features, which removes the single worst failure of text→sprite: a model inventing a *different* kobold on every frame. **And the frames do not have to be invented at all** — this is the insight the whole thing turns on. Every one of the 300+ LPC sheets shares **one rig and one frame layout**, so the job is not *generate 36 frames* but *repaint 36 frames whose anatomy and timing are already correct by construction*: take an existing base-body sheet as the control, let the reference supply subject and palette, then quantise and pixel-snap — and that last pass is deterministic and is where most of *“looks like real pixel art”* actually comes from. It also preserves the layering promise for free, because the rig is never left. **A vision model earns its place here reading rather than drawing**: turning the reference into structured attributes (scaled red-brown hide, horns, snout, tail, digitigrade legs) that then drive layer choice and recolour ramps — which is ③'s machinery again. **One consequence worth naming before somebody hits it**: a *tail* is cheap, because `bg/`-style layers behind the body already exist and are staged (A7a found cloaks and swords using them at z 5), but **digitigrade legs change the silhouette inside the rig** — the leg frames themselves differ, so every worn leg and foot piece would misregister against them. A kobold with human legs is a smaller lie than a kobold whose boots float. ⑤ **ComfyUI is the right tool for the raster stage** (owner, 2026-08-06: *“could ComfyUI be used for the pixel part?”*), and the answer turns on drawing the line in the right place. Its graph model is built for precisely the job ①–④ describe: **the existing LPC frame as the control** (pose and silhouette, at a denoise low enough to keep registration), **the reference as the conditioning** (subject, palette — this is what makes *from a reference* work rather than *from a prompt*), and the 36 tiles run as one batch under one seed and one conditioning, which is where frame-to-frame consistency comes from. **But the pixel stage must not be a model.** Quantising to the palette, snapping to the grid and re-tiling to 576×256 is arithmetic, and it is where *“looks like real pixel art”* actually comes from — let the model quantise and you get thirty-six slightly different palettes. That half belongs in `worldgen/` as a plain script, reproducible and tested, beside `artgen`. **`artgen`'s existing probe becomes the acceptance gate**, which is the part that makes this shippable rather than a demo: it already refuses a sheet without a real 576×256 walk cycle, so the same check rejects a generated one — wrong size, a frame gone empty where the base had pixels, palette over budget — and regenerates instead of shipping mush. **The determinism rule is not violated and it is worth saying why**: `CLAUDE.md` §3 binds the *simulation*, and this is offline asset generation whose output is staged and committed, exactly as `artgen` and `worldgen` are. The game reads sheets; it never runs a model. Same line `ollama.ts` draws with *never in the tick*. ⑤ **Licensing is a real input, not a footnote**: `CLAUDE.md` requires CC-BY-SA 3.0 / GPL 3.0 attribution with `LICENSE` and `AUTHORS` kept beside every asset folder, and art derived from LPC — by a model or otherwise — inherits that. Worth settling before a pipeline ships rather than after. | **Split: ① is Track A and unblocked; ③ is A7e/A7f and already placed; ②/④ wait on ③ proving the pixel plumbing** |
| **Propose art and colour for a whole zone's loot** (roadmap's own prize, held since A7e) ✅ **built 2026-08-06 as A7h** | The line A7e and A7f both pointed at: *“a pass could propose art **and** ramp for a whole zone's loot from names nobody has to retype.”* A7g did the art half catalogue-wide; `npm run colourassign` does the colour half, **scoped to a zone**. Why a zone and not the catalogue: art wants a picture on *every* item, so a fallback and a review-later was right, but **most items should have no colour at all** — a ramp is only correct when the name says one, so a catalogue-wide run is mostly *no opinion* and the interesting output is a short list. A zone is also the unit an operator's attention has (1–131 items across the shipped world, measured). **The model is deliberately not called**: a hundred items is a hundred round trips at 0.6 s warm and 67 s cold to answer what the name usually answers free, so the bulk pass takes the cheap majority and the panel's Suggest button takes the interesting remainder, one item at a time, when somebody decides it is worth the wait. **361 items across 49 zones**, and the dry run earned its keep three times — see the handoff row |
| **Mobs need to look like what they are** (owner, 2026-08-06) | *“a kobold does not look like a human in D&D — they look like the image I shared”* (a reptilian biped: snout, horns, scaled hide, tail, digitigrade legs). **Agreed, and it is three jobs rather than one.** (1) **A measurement taken today that changes the shape of it**: every one of the 1,503 harvested templates in the loaded zones carries **no race code at all**, so `spriteFor` falls through to `human` for the entire world — that is the actual cause, and fixing the harvest to carry `race` is the cheap first step, not new art. (2) **The art has to be drawn, not picked.** `CLAUDE.md`'s rule is explicit: *creatures LPC lacks get drawn to match rather than borrowed from another style*, and LPC ships humanoid bodies — there is no kobold, gnoll or lizardfolk base. A tail and a snout are new sheets in the walk cycle's own 4×9 grid, and the layered-equipment promise means a body that can still wear the kit. (3) **Then the bulk assignment**, which is A7g's shape pointed at mobs: `sprite` is already an authorable field (A9), so a matcher over race code → body needs no new mechanism. Worth noting the ordering — (1) alone turns *every creature is a man* into *every creature we have a body for*, which is most of the complaint for a fraction of the work | **Track V/A**, after the race column is harvested |
| **Hidden items in corpses, found by searching** (owner, 2026-08-06) | **The source has all of it, and it has one prerequisite we have not built.** `search` is a real command — `CMD_N(CMD_SEARCH, STAT_NORMAL + POS_STANDING, do_search, 0, TRUE)`, so standing and refused in combat — and `do_search` (`actobj.c:5771`) searches the room bare or a named thing with an argument, **explicitly including containers and corpses**. Hidden is `ITEM_SECRET`, `BIT_13` of `extra_flags`, and it is revealed by `find_chance` (`actobj.c:5758`): `(INT + WIS + LUK) / 3 > number(1, 101)`. **That roll is the prerequisite: there are no ability scores.** Phase 14b shipped its storage half and never built the derivation half it was given, so INT, WIS and LUK do not exist — see the character-creation row below, which has the same dependency. Two ways forward and they should be chosen deliberately rather than drifted into: wait for ability scores (which puts this after Phase 14b's remainder or Phase 21), or ship it on a **flat chance** first and swap the roll in later — cheap, and honest as long as the flat number is written down as a placeholder rather than tuned. Worth noting `ITEM_SECRET` is a flag we do **not** harvest today, so the item side is a worldgen field with a reader, the discipline `weaponClass` just went through. Also note what makes this good: it gives the `look` listing above a reason to be a *subset*, and it is the first thing in the game that rewards patience at a corpse rather than speed | **After ability scores** — or on a placeholder roll immediately, if the owner would rather have the mechanic than the arithmetic. The item flag can be harvested any time |
| **Attack verbs: "You slash the kobold" rather than "You hit"** (owner, 2026-08-06) | **It is already in the source, the mapping is one function, and the data landed today.** `attack_hit_text[]` (`fight.c:132`) is Diku's own table of **eleven** types with singular, plural and past-tense forms: punch, bludgeon, pierce, slash, whip, claw, bite, sting, crush, maul, thrash. `get_weapon_msg` (`objmisc.c:63`) chooses one from the weapon's `value[0]` — **the very field Phase 19 harvested onto `ItemTemplate` and `Item` on 2026-08-06 for the skill mapping** — so the weapon half of this is a lookup table and a sentence, with no new harvest and no protocol change (the combat line is already rendered server-side per recipient). Six verbs are reachable from the twenty weapon classes: **slash** (axe, shortsword, two-handed sword, sickle, polearm, longsword), **pierce** (dagger, spear, trident, horn), **crush** (hammer, flail, club, spiked club, lance), **bludgeon** (mace, spiked mace, staff, numchucks), **whip** (whip), and **hit** for anything else. **Do not merge this with Phase 19's grouping, and that is the trap worth naming**: the skill mapping puts hammer *and* mace both in `bludgeon-1h`, while the verb table splits them into crush and bludgeon, and a polearm is `reach` for skills but always *slash* for prose. Two different groupings of one field, both the source's, and tidying them into one would silently change one of them. **The mob half is a second, smaller job**: an unarmed mob uses `npc->attack_type` (which is how a kobold bites and a spider stings), and we do **not** harvest it — so without it every clawed thing in the world punches. That is one field in the `.mob` parse with an obvious reader. Stretch, and free once the type exists: `melee_death_messages_table` gives two authored killing-blow lines *per type* — *"Your final slash sends $N's head bouncing along the ground"* — which would make a kill read like a kill | **Buildable now** for weapons; the mob attack type is a worldgen field to harvest alongside it. A presentation slice, so it fits **Track V's slot** — which is otherwise skipping its turn now that V1–V6 are done |
| **Create a new zone from the panel** (owner, 2026-08-06) ✅ **built 2026-08-07 as A8d** | **Built on the three answers this row wrote down**: the id from `AUTHORED_ZONE_BASE` (100,000 — measured against harvested ids 1–423) with a **stored** counter; the first room written in the same motion at the origin, placed by `composeAuthoredRooms`' one new exception (an empty authored zone's first room has nothing to join); and **which zones load stays a file** — the response tells the operator, in words, to add the id to `world.config.json` and restart, and the panel shows a *Created, not loaded* card so a creation is never invisible. The drive caught the first version validating the origin room beside the drafting rules instead of through them — the loader dropped it on the next boot — so the rule now lives at both doors with the allowance stated once. *The Sunken Stair* (100000, two rooms) ships in the overlay as the standing example, pending its config line. Original entry follows. **Agreed, and it is A8's next question rather than a repeat of it.** A8 builds rooms *inside* a Place that already exists; a zone from nothing hits three cases its rules cannot express. **(1) The id.** Zone and room ids are the MUD's own numbers and are the join key between every data source we have (`CLAUDE.md`), so an authored zone needs an id no future Duris drop can claim — the argument `AUTHORED_VNUM_BASE` settled for items and `rooms-authored.json`'s stored counter settled for rooms, and the answer is the same shape: a reserved base, and a counter that is **stored rather than derived** so deleting the highest zone cannot recycle its number. **(2) A Place with no rooms has no extent.** Every grid is sized from `boundsOf` the rooms on its level, and `placementRefusal` requires a new room to touch an existing one — so the *first* room of a new zone is the one case A8 has no rule for, and it needs an explicit origin rather than a neighbour. **(3) Which zones load is a file, not a route.** `world.config.json` is data by design; a panel that wrote it would either need a restart to matter or would have to teach `GameWorld` to add a zone live, and those are different sizes of job. Also worth deciding before building: a zone nobody can walk to is invisible, and A8 refuses vertical links by name, so **the first exit into a new zone is its own problem** — probably the honest first version is *the panel creates it, the operator adds the id to the config, and the first link is authored like any other exit* | **Track A, as A8d** — after A7e/A7f, because it is the largest remaining geometry job and the three A8 slices are what make it safe |
| **Edit existing mobs, and create new ones** (owner, 2026-08-06) ✅ **all three built 2026-08-06 — A9 (editing), A9b (creating), A9c (placing in a zone)** | **Agreed, and half the machinery is already built.** A4c wrote `server/src/mob-overrides.ts` — the fourth overlay — to author a mob's *loot*, and everything about its shape (per template, additive, refuses a slot the game does not model, reports how many instances are already standing) applies unchanged to a mob's own fields. So **editing** is A5-for-mobs: extend the existing overlay past `outfit` to name, keywords, level, hit points, damage, sprite, aggression and flags, with the same before/after snapshot A5 uses for revert. Two things to say out loud in the panel, both learned from A4c: an edit is **per template**, so it changes every instance the world spawns from now on and **none** of the ones already standing (A4's Repop is what turns it into something to look at); and level, hit points and damage are what 14b calibrated the whole combat scale against, so the editor is also the fastest way to make an unwinnable zone. **Creating** a mob is A6b's shape for mobs — an authored vnum from a reserved base, a stored counter, and a `spawns/` entry with no `.mob` file behind it, which is the case `buildZoneSpawns` has never seen | **Track A, as A9 (editing) and A9b (creating)**, in that order and after A8d: editing is a field editor over an overlay that exists, creating needs an id space and a reset-table entry that does not |
| **Corpse retrieval as a paid service — a money sink** (owner, 2026-08-07) | **Agreed in principle, and the timing of the ask is the interesting part**: it arrived while deciding what drowning is, as the answer to *"a corpse mid-ocean may be unretrievable"* — and then the wash-ashore rule answered that case for free, which sharpens what this row actually is. It is not a retrieval mechanic; it is an **economy** mechanic wearing one: mobs (a dockside salvager, a temple's corpse-bearer) who will fetch your corpse for a fee, taking coin *out* of the economy — the owner's own framing, and the first proposed sink since shops began putting prices on things. Three placements it depends on: **coin has to matter enough to sink** (shops are the only faucet-and-drain pair today), the **service-mob shape is Phase 21's** (a mob you talk to, with a verb and a price, is a quest hook wearing an apron — `DESIGN-mobs-and-movement.md` already reserves the hooks), and the fee wants pricing against what death already costs, or paying it is strictly worse than the corpse run 14b tuned. Note the sibling flavour the swim slice already leans on: *"paying the ferryman"* — a boat-keeper who charges for crossings is the same shape as a salvager who charges for retrievals, and both belong to the same pass | **Phase 21, with the quest hooks** — recorded now so the drowning conversation's best idea is not lost to it |
| **Quest authoring in the panel** (owner, 2026-08-06) | **Already placed, and the placement is the answer: it cannot come first.** Quests are Phase 21's mechanism (§3, Act VI — *classes, races, quests, channels*) and the original *"content editors: mobs, items, zones, quests"* row above already routed the authoring half into Track A **after** the phase that gives a quest a shape: you cannot write a field editor for a record whose fields nobody has decided. What this row adds is the sequence, so nobody has to rediscover it — **Phase 21 defines what a quest is, then Track A gets the editor**, exactly as A5 followed rooms, A6 followed items and A9 follows mobs. Worth noting the one thing already in place: `DESIGN-mobs-and-movement.md` reserves the quest *hooks* on a mob, so a quest that starts by talking to somebody has somewhere to attach | **Track A, after Phase 21** — recorded now so the order is not re-litigated when it comes up |

---

## 5. Keeping this file true

- A phase moves to `done` only when its **Seen when** line is true in the running game — not when the
  code merges.
- When a phase completes, update §2, tick the phase heading, and update the matching rows in
  `REFERENCE-mud-mechanics.md` §2 so the two files cannot drift.
- Track items follow the same rule: a V or A item is done when its **Seen when** is true — in the
  game for V, in the panel against the running server for A. When one completes, tick it in its
  track list and advance §2b's rounds table so the next round is always written down.
- `HANDOFF.md` says where things stand *right now*; this file says what is next and why. If they
  disagree, `HANDOFF.md` is right about the present and this file is right about the order. For the
  panel's internals, `DESIGN-admin-panel.md` is the spec and this file's Track A is the order.
