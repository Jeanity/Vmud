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

25 phases. Seventeen done — Acts I–III complete, Act IV all but its progression half.

| Act | Phases | State |
| --- | --- | --- |
| I — The world answers back | 1–3 | **3 of 3 ✅** |
| II — Bodies | 4, 5, 5b, 5c, 6 | **5 of 5 ✅** |
| III — Life | 7–10 | **4 of 4 ✅** |
| IV — Violence | 11–14, 14b, 14c | 5 of 6 |
| V — Things | 15–17 | not started |
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
| **5 — current** | V4 — the world as a graph of Places | Phase 16 — gear that matters (16a bands ✅, 16c mob armour ✅) | A6 — items ✅, A6b — items you make yourself ✅ |
| 6 | A7a/A7b — item art as data | Phase 16 proper — light, AC, encumbrance | A4 + A4c — mobs live, and their loot |

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

#### Phase 16 — Gear that matters

- **Mechanic.** Light as an equipped-item property with best-of-equipped (`bestLight` already takes a
  candidate list; the list is currently one carried item). AC derived from material × slot ×
  condition. Movement points and encumbrance — `SECTOR_MOVE_COST` and `SECTOR_REQUIRES_MOVEMENT` are
  written with zero callers, and `move`/`maxMove` are already on the wire and decorative.
- **Seen when.** A lantern in your hand rather than a `carriedLight` field; heavy armour visibly
  slows you across swamp; deep water refuses you until you can swim.
- **Why here.** It collapses the interim carried-light field, which the design docs already say
  *should* collapse, and it retires three built-but-uncalled mechanisms in one pass.

#### Phase 17 — Containers, money and shops

- **Mechanic.** Containers with nesting depth and type restriction, money as both scalar and object,
  shopkeepers.
- **Seen when.** You put a thing in a bag, and buy a thing from someone.
- **Open question.** Container nesting depth — proposed max 2, not agreed. See `HANDOFF.md`.

---

### Act VI — Together

Everything from here is content or depth, and the acts above are what made it cheap.

#### Phase 18 — Following and grouping

Consent, a shared list, the **superlinear** exp split (§4.4 — dividing by group size is the mistake).
Followers move by re-issuing the movement intent, never by teleporting.
**Seen when.** Two clients walk the map as one train and share a kill.

#### Phase 19 — Skills

Percentages notched by use, per-category rate limits, a level-driven floor. Mobs derive proficiency
from level and store nothing.
**Seen when.** A skill percentage rises because you used it.

#### Phase 20 — Spells

Cast time as a self-rescheduling event on Phase 11's scheduler, environmental interruption, two
independent resistance gates, area targeting with crowd thinning.
**Seen when.** You cast something with a visible wind-up that can be interrupted.

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
- **V3 — Speech in the world.** `say` exists only as a log line; nothing in the world shows who
  spoke. A short-lived speech bubble over the speaker — rendered per recipient exactly as the log
  line is, so an unseen speaker's bubble is not drawn (the `act()` gate already answers who may
  know). Announcements land as a distinct banner — A2's channel, rendered.
  **Seen when:** someone says something and you watch them say it, in the world, not the log.
- **V4 — The world as a graph of Places.** The `M` overview shows the Place you are on; there is no
  view of anywhere else. Decision 1 in `HANDOFF.md` constrains this hard: zones overlap and share no
  coordinate space, so any wider map **must be a graph of Places, not a map of them** — nodes you
  have visited, edges you have walked, laid out as a diagram rather than geography.
  **Seen when:** you open the map and see where you have been as a web, and how the castle joins
  the bog.
- **V5 — Arrival cards.** Crossing into a new Place is currently a change of floor tiles. A brief
  title card — zone name, level — gives travel the sense of arrival every MUD gets from its room
  header line. **Seen when:** you climb the stairs and the game tells you where you have arrived,
  then gets out of the way.
- **V6 — The world in its own colours** ✅ **done 2026-08-02, owner-requested.**
  `shared/src/colour.ts` parses the MUD's own `&+R` / `&n` notation into spans, and the client
  renders them.
  **Seen when:** room prose arrives coloured the way its builder wrote it ✅ — IceCrag's approach
  road draws in the dim yellow `&+y` its author chose, with no literal codes on screen.

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
- **A4 — Zones and mobs, live ops.** Force a repop, work a door; live mob instances by zone, slay,
  spawn from a harvested template. The mob-testing loop Phase 14's morale work will want.
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
  and the largest thing in this track. **It needs a design note before any code**, because four of
  its five problems are decisions rather than work:

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
  - **A7c — the picker.** Browse by category with previews, assign, see it on a body. `GET /art`
    already serves the index, filtered by slot; what is missing is the panel half.
  - **A7d — icons.** Bag and floor sprites from the catalogue's preview frame, retiring the
    procedural placeholder. The definitions carry `preview_row`/`preview_column` for exactly this.
- **A4c — Loot: assigning items to mobs** (owner, 2026-08-04). *"we also need to be able to assign
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
`@mygame/client`, not a new project, and nothing above is invalidated by it.

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
| **A fled mob should remember, heal, and be waiting for you** (owner, 2026-08-04) | **Two halves: one is already the behaviour and should be written down, the other is the best idea in the exchange.** Owner asked whether a mob that flees mid-fight *"gets off scot free because I got distracted"* by a second attacker. **It does not, and that is already correct.** `pursuitTarget` bails while `player.fighting` is set — *"a fight in progress owns the player"* — but it **does not clear `player.pursuing`**. Kill the interloper, walk into the first one's room, see it, and the chase closes. Worth keeping: the alternative punishes a player for something outside their control, and it makes fleeing *strictly better for mobs in busy rooms*, which is where fights are already hardest. **The limitation to record rather than let somebody discover**: there is **one pursuit slot**, so a second mob fleeing overwrites the pointer and the first is genuinely lost. That is defensible — you can chase one thing — but it is undocumented today. **The half worth building** is the owner's own: *"a fleeing mob may also heal back up enough to want to attack me… when I enter the room it could try and jump me as the aggressor."* Agreed, for three reasons. It turns fleeing into a **tactical retreat** instead of a delayed death — a fled mob is a chore you walk to today. It **pairs exactly with the no-regeneration-while-fleeing lever** the owner picked in Phase 14: the mob only heals once it *stops* running, so there is a real clock to race, and the distraction becomes a genuine decision — chase now while it is weak, or handle the new threat and meet a healthier one. And the cost lands on a choice the player made, which is the kind of danger that reads as fair rather than arbitrary. **Memory should decide it, not a blanket rule.** `perception.ts` already keeps a `noticed` set per mob, populated **only when the template says `remembers`** — Duris' `ACT_MEMORY`, harvested and live. So a mob that remembers you ambushes and one that does not is merely standing there, which makes two kinds of enemy feel different using the source's own answer rather than an invention. **One thing to check before estimating**: whether `noticed` currently *triggers* aggression on entry or only feeds the reaction delay — that is the difference between "already works" and one piece of wiring, and it is ten minutes with `advancePerception` | **Phase 18**, with wandering mobs — a mob that remembers you and one that roams want the same pass over `perception.ts`, and the ambush is far more interesting once the mob might not be where you left it |
| **A marker over the mob you are fighting, and animations for what happens in a fight** (owner, 2026-08-04) | **Agreed, and the marker is the cheap half that should not wait for the animations.** Owner's reason is the one that matters: *"so you know which one you are focused on… it will also help when you switch to know you switched."* **The data is already on the wire and has been since Phase 7** — `EntityView.fighting` carries the entity id its owner is swinging at, and the client reads it today only to decide whether to show a combat indicator. So "which one am I fighting" is answerable in the renderer with no protocol change at all: the marker is a sprite pinned above the entity whose id equals your own `SelfView`'s target. Three things to get right, and the third is the one that makes it worth doing. **(1)** It must mark *your* target, not "anything in combat" — a room where four things are fighting must still show one marker. **(2) It has to stick to a mob that flees, and this is the requirement that decides the implementation** (owner, 2026-08-04): *"in case they flee into a room with a bunch of similar mobs that may have been damaged by other players."* That is exactly right and it rules out the obvious approach. `EntityView.fighting` is cleared the instant the fight breaks — `attemptFlee` calls `clearEngagements`, which is the whole point of the exit — so a marker driven by `fighting` alone goes out at precisely the moment it is most needed. **The pointer that survives already exists**: `markPursuers` sets `player.pursuing` to the fled body's **entity id** on every flight, for this exact reason — `HANDOFF.md` puts it as *"arriving where it stands re-engages that body, `kill youth` would pick the freshest youth instead."* So the marker is a *view of the pursuit pointer* rather than a new concept, and the owner's damaged-twins case is the one it was built for. **It is not on the wire yet** — `SelfView` carries no `pursuing` — so this is the one protocol addition the marker needs, and it is a single optional entity id. Note also that health fractions **cannot** be relied on to tell twins apart: they are on the wire, but another player's damage makes two youths look different for reasons that have nothing to do with which one is yours. **(3) It should move when the target changes**, because that is the owner's real ask — the marker *is* the feedback that a switch happened, which makes it the natural companion to the target-switching row above rather than a separate piece of polish. **A `Set focus` row on the target menu is the possible third piece** (owner, 2026-08-04), and it is filed as *potential* rather than agreed because the owner's own condition for it is right: *"this may only be required once mobs start roaming around."* Today a mob you clicked is still standing where you clicked it, so picking it and hitting it are one gesture and a separate focus step would be ceremony. The moment the wandering-mobs row lands — Phase 18, and the in-room drift before it — that stops being true: you click a kobold, it takes a step, and `kill kobold` may now find a different one. Focus would be the fix, and it is the same argument protocol 11 already made for clicking a body at all — **an entity id is the one thing that says *which* without either side guessing**, where a keyword in a room of three patrol members is ambiguous by construction. Two things to settle if it is built. **Where focus lives**: purely client-side is enough for a marker, but the moment `attack` uses it the server must still resolve it through the same visibility gate a typed word passes, or a click becomes more powerful than a word. **What clears it**: the target dying, leaving the room, or going out of sight — and it should clear *visibly*, because a focus marker that lingers on something you can no longer see is worse than none. Revisit when mobs move; do not build it before. **The animations are the other half and are a different size entirely**, sharing a root with the visible-weapons row: the LPC pack ships Swing, Thrust and Shoot sheets and our combat is a log line, so a swing has no motion to play. Doing weapons and combat animation together is what that row already recommends, and a bash or a switch would be more frames in the same pass rather than a new problem | **Marker: Track V, and it could go any time** — it needs nothing that does not exist. **Animations: Phase 16's weapon-art slice**, with the visible-weapons row, and a bash animation lands with the bash skill in Phase 19 |
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
| **`look <direction>` — see into the next room** (owner, 2026-08-02) | **Agreed, and it is a MUD mechanism rather than a nicety** — Duris has `do_look` with a direction argument, so grep `act.informative.c` before designing it. The owner's shape: look east, and if that room is lit you get its description and a count of what is standing in it — *"1 sentry guard to the east"*. Four rules decide whether it is right, and three of them are about light. **(1) The gate is the *far* room's light, not yours** — you can see into a lit room from a dark one and not into a dark room from a lit one, which is the whole reason the feature is interesting and the opposite of what a naive `canSee(you, them)` computes. **(2) A shut door blocks it**, and `doorway()` already answers that from both sides. **(3) Mobs aggregate by name with counts**, not one line each: three patrol members read as "3 members of the Court Patrol", and the count is the tactical information. **(4) Hidden and invisible stay hidden** — this must go through the same visibility gate the entity feed uses, or it becomes a wallhack. **Do not reuse A5's `neighbourhood()`** despite the resemblance: that one is deliberately unbounded and ungated because an operator looks at the world from outside it, and wiring it to a player command would leak the whole castle. Interest management already ships neighbouring rooms, so the data is at hand — but resolution stays server-side, because a client that could ask for any room would be asking for exactly the rooms it should not see | **Track V, after Phase 15** — it wants doors and light to be settled, both of which they now are, but V3 and V4 are already queued ahead of it |
| Terrain inference quality (23.2% fall back to a default sector) | **Done — became Phase 5c.** Suffix rules plus graph label-diffusion took the default share from 23.2% to 0.2%; see the phase for what the held-out validation says about accuracy | Phase 5c ✅ |
| Temples or churches as sanctuary | Agreed in principle, not scheduled. Must be **authored**: nothing upstream marks them, and `ROOM_SAFE` is set on 11 of Duris' 781,053 rooms | After Phase 10, once pursuit gives sanctuary a mechanical meaning worth placing by hand |
| Container nesting depth (proposed max 2) | Open, not decided | Decide during Phase 17 |
| Room-scoped shared light (one player lights the room for all) | Real Duris mechanism (`char_light` → `room_light`), and a change to a tuned relationship — see `ROOM_GAP` in `tilemap.ts` | Not scheduled; needs a design note before it gets a phase |
| **Character progression: ability scores, hit dice, levelling, and somewhere to start** | **Done — became Phase 14b**, on exactly the placement this row had already argued: after Phase 14, before Act V, signature work by §4's first question. The "what death costs" decision Phase 13 left open moves there with it, because it needs progression's numbers to mean anything | Phase 14b |
| **Mob health bars on screen** | **Agreed — and it is arguably Phase 11's own Seen-when.** `EntityView.healthFraction` has been on the wire since Phase 7 and *no client code reads it*, so "a health bar drops" is currently true of the data and false of the screen. Open question the owner raised: shown on `look` or only once engaged | Phase 11, as the rendering half of its own completion test |
| **Combat outcome vocabulary — dodged, parried, shield blocked, casting** | **Agreed, and it splits.** The *mechanisms* are later: dodge, parry and shield block are defence skills (Phase 19) and casting is Phase 20. But the *wire shape* is §4's first question exactly — a reason on `attackResolved` costs one optional field now and a rewrite of every combat message site later, so the field is reserved in Phase 11 and the rolls that can populate it arrive with the skills | Field in Phase 11; dodge/parry/block in Phase 19; casting in Phase 20 |
| **`loot` targets the nearest unlooted corpse** (owner, 2026-08-02) | **Done — landed with Phase 14**, as a targeting refinement of Phase 13's own command rather than a phase of its own. Nearest unlooted first, then next-nearest, and only then a looted one, which keeps the "already picked clean" line reachable. `nearestLootable` in `corpses.ts` | Phase 14 ✅ |
| **Bash — a warrior's shield opening that knocks the target down, doubling damage until it stands** (owner, 2026-08-02) | **Agreed, and it is two things.** The *skill* is Phase 19's shape exactly: an opening attack, a knockdown roll, and it needs posture (built), the dying-window damage rules (built) and a skill system (Phase 19) to hang from — inventing it early would be the fifth tested-and-never-called mechanism. The *surface* — a menu offering it on a click — is V2, which grows a row per mechanic as the mechanics land | Skill in Phase 19; its button arrives with whatever V2 offers by then |

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
