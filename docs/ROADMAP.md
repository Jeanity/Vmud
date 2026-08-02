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

24 phases. Sixteen done — Acts I–III complete, Act IV all but its progression half.

| Act | Phases | State |
| --- | --- | --- |
| I — The world answers back | 1–3 | **3 of 3 ✅** |
| II — Bodies | 4, 5, 5b, 5c, 6 | **5 of 5 ✅** |
| III — Life | 7–10 | **4 of 4 ✅** |
| IV — Violence | 11–14, 14b | 4 of 5 |
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
| 1 | V1 — the combat feed ✅ | Phase 14 — mercy and fear ✅ | A2 — messaging to a room or place (next) |
| 2 | V2 — click a body, get its verbs | Phase 14b — a character worth keeping | A3 — zones, read-only |
| 3 | V3 — speech in the world | Phase 15 — inventory and worn equipment | A4 — zones and mobs, live ops |

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

**Nothing comes out of a corpse yet, and it says so.** Items are Phase 15. What looting does today is
flip the flag and change the sprite, which is the whole of what can honestly happen — and when items
arrive the transfer goes in beside the flag.

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

#### Phase 14b — A character worth keeping

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
  dying costs something you can point at in the log.
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

---

### Act V — Things

#### Phase 15 — Inventory and worn equipment

- **Mechanic.** The item type/instance split, inventory with variable item sizes, equipment slots —
  `DESIGN-inventory.md` is the spec.
- **Seen when.** **Worn gear is visible on the character**, layered LPC over the body — the art
  requirement `CLAUDE.md` names explicitly. You pick something up, wear it, and see it.
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
- **V2 — Click a body, get its verbs.** Owner-requested: click a mob or a corpse and a small menu
  offers what you can do to it — `look`, `kill`, `loot` — issuing the same typed commands the
  prompt would, with the target already resolved. The point is target *identity*: in a room of
  same-named patrol members, "which one am I about to hit" currently has no answer on screen. The
  menu grows a row per mechanic as later phases land (bash arrives with Phase 19's skills, and is
  recorded there); the menu itself stays presentation.
  **Seen when:** you click the mob you mean and act on that one, never the wrong twin.
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
- **A2 — Messaging to a room or a place.** The remaining targets, plus the dedicated `announce`
  `LogChannel` — a protocol bump taken deliberately, and the seam V1's banner renders.
- **A3 — Zones, read-only.** Zone list, room browser with sector/flags/prose, door states, repop
  clocks. The room browser is what A2's targeting and every later authoring job navigate with.
- **A4 — Zones and mobs, live ops.** Force a repop, work a door; live mob instances by zone, slay,
  spawn from a harvested template. The mob-testing loop Phase 14's morale work will want.
- **A5 — Authoring overlays.** `data/world/overrides/`: room flags and prose first — **hand-authored
  sanctuaries land here**, the parked item §4 has carried since Phase 10 — then mob template
  overrides (name, level, combat numbers, aggression). After Phase 14, so a template's behaviour
  surface is settled before it is authorable; overlays survive `npm run worldgen` by design.
- **A6 — Items.** After Phases 15–16 exist to give it something to edit. Until then the tab stays a
  stub and the light catalogue stays read-only on the dashboard.
- **A7 — Quests.** After Phase 21, same rule.

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
| **Content editors: mobs, items, zones, quests** | **Done in principle — became Track A.** The admin panel (built 2026-08-02, off-schedule at the owner's request; `DESIGN-admin-panel.md`) is the delivery vehicle for all four, and it keeps this row's one rule: the server is the only writer, and authoring lands as overlay files the game loads — content that can only be edited through a tool is hostage to that tool. The landing order this row chose survives as Track A's order: mob authoring after Phase 14 (A5), items after 16 (A6), quests after 21 (A7). The full zone *geometry* editor — room graph, three direction encodings, per-zone normalisation — remains the largest and last, and is **not** any current A slice | Track A; geometry editor still last, unscheduled |
| Authoring sanctuaries and other room flags by hand | Lands in **A5**, the first authoring overlay — `safe` is set on one room in the shipped world, so sanctuary has been built and untestable since Phase 10 | Track A5 |
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
