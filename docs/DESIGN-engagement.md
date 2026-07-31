# Design: engagement

_Roadmap Phase 6. No code — this is the decision, written down before anything depends on it._

This is the one design decision in the project that **gets made by accident**. Writing
`if (distance <= reach)` into the first attack handler silently chooses positional action-RPG combat,
and by the time anyone notices, threat, tanking and rescue have been built on top of something that
cannot support them. `DESIGN-mobs-and-movement.md` §2.6 called that out and settled the core question;
this doc is the whole answer, because "engagement is sticky" is one sentence and Act IV needs a model.

**Why its own doc.** It gates Phases 11–14 entirely, and it is referenced from the roadmap, the
mechanics reference and the handoff. The most load-bearing combat decision in the project should not be
§2.6 of a document about mobs — that is exactly how it gets missed.

---

## 1. Engagement is a relationship, not a distance

**The measurement that forces this.** A room is 9×9 tiles, so its longest internal distance is ~11.3
tiles = 362 px. At `PLAYER_SPEED` (150 px/s) that is **2.4 seconds**. A combat round is **3 seconds**.
A character can cross an entire room in less than one round.

So if reach were checked per swing, walking away from a melee attacker would be free — out of range
before its next swing lands, at no cost, using ordinary movement. Everything downstream collapses:
there is no reason to hold aggro if aggro cannot hold you, no such thing as a tank, no rescue, and
"lure one dragon out" degenerates into kiting all three.

**Decided: once two combatants are engaged, melee connects regardless of where either stands inside
the room.** Position within a room is not a melee range check. `reach` (`§2.4`) governs ranged attacks
and spells only, which is what still makes a ranged attacker want to hold distance.

The source is unambiguous that this is how a MUD works, and blunt about why: `set_fighting()` sets an
opponent pointer and **there is no range check anywhere, because there is no range**.

## 2. The shape: a directed pointer, plus a derived inbound set

Read from `set_fighting` / `stop_fighting` in `fight.c`, and it is *not* the symmetric relationship
object the phrase "a relationship between two entities" suggests:

| | |
| --- | --- |
| **Outbound** | Exactly **one** target per actor. `fighting: EntityId \| undefined` — who I am swinging at. |
| **Inbound** | **Many**, and **derived**. "Who is fighting me" is the set of actors whose `fighting` points at me. It is not stored. |
| **Mutuality** | **Emergent, not enforced.** `set_fighting(ch, vict)` does not touch the victim's pointer. A is fighting B, and B fights back only because retaliation calls `set_fighting(B, A)` separately. |

Three consequences worth stating, because each is a bug avoided:

1. **Retargeting is stop-then-set, never set-again.** `set_fighting` on an already-fighting actor is an
   *assertion failure* upstream, not a re-target. Switching target — which is exactly what Phase 12's
   threat table does every time hysteresis is exceeded — must disengage first. One code path, so a
   switch cannot leave a stale pointer.
2. **Nothing may iterate "the fight" as an object**, because there is no such object. A fight is a set
   of actors that happens to point at each other. This is why the mercy rule has to *scan* for everyone
   whose target is the fallen character rather than reading a participant list.
3. **The pointer breaking is not symmetric.** `stop_fighting(ch)` clears `ch`'s pointer and nobody
   else's. A mob whose target flees is still engaged until something clears it — which is what §5's
   enumeration is for.

**Keep `wasFighting`.** `stop_fighting` records the opponent it just dropped, and that single field is
what makes assist, post-flee re-engagement and "who were you just fighting" answerable at all. Cheap,
and impossible to reconstruct later.

**Already on the wire.** `EntityView.fighting` exists as an optional `EntityId` and drives the combat
indicator. The wire form is therefore already the outbound pointer, and needs no change.

## 3. What starts engagement, and what starting it breaks

An attack starts it — and `set_fighting` refuses in more cases than it accepts, which is the
interesting half:

- **Never yourself.** `ch == victim` is refused outright.
- **Never while asleep or immobilised.** You cannot open a fight you are not conscious for.
- **Refused when there is no room** — `can_hit_target`, answering *"You can't seem to find room!"*
  That is the crowding budget (front rank / back rank), and it is the one gate that makes engagement
  *fail* for a spatial reason. Not scheduled; noted here so it is understood as a **cardinality**
  limit rather than a distance one.

And engaging **breaks** things, in the source and for us:

- **Sleep**, from every source that can cause it, plus the flag itself. A fight wakes you — which
  `statusFor` in `position.ts` already implements: `fighting && (sleeping || resting) → normal`.
- **Sneak and hide.** Attacking reveals you.
- **Spell memorisation**, and any charm on the person you just attacked.

## 4. Movement while engaged — our one divergence, and it is deliberate

**The source forbids movement outright.** Every one of the six directions is registered `CMD_N` — "may
NOT be used while fighting". That is the cleanest possible confirmation of stickiness: in Duris you
literally cannot walk out of a fight, and `flee` is the only exit.

But Duris had no continuous movement. A room was a point and moving was a teleport between points, so
"cannot move" and "cannot leave" were the same rule. We have WASD and hold-to-drag, and — because
engagement is sticky — **where you stand inside a room is already mechanically irrelevant**.

**Decided: free inside the room, cannot leave it.**

- Steering works normally while engaged. Circle, back off, reposition; none of it affects melee,
  because §1 says position does not.
- **Every room exit is refused** while engaged — the six direction commands, and click-to-move routes
  that would cross a room boundary. The refusal must name `flee` as the way out.
- `flee` is the only thing that ends it voluntarily, and it keeps its cost: it may fail, it may
  provoke, and it hands the initiative to whatever you were fighting.

This is the same divergence Phase 4 already made and for the same reason: `Simulation.canMove`
requires standing because a seated character gliding across the floor is a rendering fault rather than
a mechanic. A character rooted to the spot for the length of a fight is the same kind of fault — it
reads as the server having stopped responding. We keep the rule Duris' restriction *protects* (no free
disengage) and drop the restriction's incidental consequence.

**What this costs us: nothing tactical.** Pulling is a *room-level* decision about which mobs aggro
(§2.9), not about kiting inside one, so it is unaffected.

## 5. What ends engagement

Enumerated, because "it ends when the fight ends" is how a stale pointer survives into Phase 13:

| Ends it | Notes |
| --- | --- |
| **`flee`, on success** | The only voluntary exit. Failure leaves you engaged and worse off. |
| **Leaving the room** | Only reachable *via* flee or by being moved, per §4. This is what pursuit responds to. |
| **Death** of either party | The corpse is not a combatant. |
| **The mercy rule** | The target drops below the incapacitation threshold, falls asleep, or is immobilised → **everyone** targeting them disengages, found by scanning. Without this the dying window is dead code, because auto-attacks cross the death threshold immediately. |
| **Target becomes unreachable** | Changed Place, disconnected, despawned. The pointer must not outlive the entity. |
| **Retargeting** | Stop-then-set, per §2. |

**And what deliberately does not end it: time.** There is no engagement timeout. A clock that lapsed
engagement after N seconds of inaction would be a free disengage available by standing still, which is
precisely what §1 exists to prevent. Engagement ends on an **event**, always.

## 6. What "in combat" forbids

Duris carries this as a **separate boolean per command**, alongside the two-axis position minimum —
`CMD_Y` may be used while fighting, `CMD_N` may not. It is a third independent gate, not a posture
consequence, and the rows below are transcribed from `interp.c` rather than chosen:

| Command | In combat | Read from |
| --- | --- | --- |
| `north` … `down` | **Refused** | `CMD_N` — and see §4: steering stays, exits go |
| `flee` | Allowed | `CMD_Y`. Obviously — it is the exit |
| `kill` | Allowed | `CMD_Y` (`CMD_HIT`, `CMD_KILL`) |
| `look`, `exits` | Allowed | `CMD_Y` |
| `say` | Allowed | `CMD_Y` |
| `help` | Allowed | `CMD_Y` |
| `affects` | Allowed | ours; `CMD_SCORE` is `CMD_Y` and it is the same kind of thing |
| `stop` | Allowed | ours. Refusing a *cancel* is never right |
| `stand`, `sit`, `kneel` | Allowed | `CMD_Y` |
| `rest`, `sleep` | **Refused** | `CMD_N` |
| `open` | Allowed | `CMD_Y` |
| `close` | **Refused** | `CMD_N` |
| `who` | **Refused** | `CMD_N` |

Four of these rows are more interesting than the rule they state, and they are why this was worth
transcribing instead of guessing:

- **Posture yes, status no.** `sit`, `kneel` and `stand` are all allowed; `rest` and `sleep` are not.
  You can be knocked about, and you can get back up — but you cannot opt *out of consciousness* mid
  fight. That is Phase 4's two axes earning their keep a second time: the gate lands on one axis and
  not the other, which a single collapsed `POSITION_*` enum could not express.
- **`open` allowed, `close` refused.** You may flee through a door. You may not slam it behind you.
- **`wield` and `remove` allowed, `wear` refused.** Draw a weapon or drop a shield mid-fight; do not
  armour up. (Neither exists yet — recorded for Phase 15.)
- **`who` refused**, though it is pure interface and works while *dead*. The source's judgement is
  that a global out-of-world scan is not a thing you do mid-swing. Followed rather than argued with,
  and cheap to revisit if it ever reads as an annoyance rather than as focus.

**Where this lives: `COMMAND_REQUIREMENTS`, as a third field.** Phase 4 built the gate at the one
dispatcher seam in `runCommand`, read in exactly one place. An `inCombat: boolean` column on the same
table is the whole implementation — and it must go *there*, not into individual handlers, for the
reason that seam exists: scattered checks will be forgotten somewhere, and players find the one you
forgot.

## 7. Pursuit reaches to the edge of a Place, and stops

`DESIGN-mobs-and-movement.md` §2.5 left this open. **Decided: a mob pursues freely through the room
graph within its own `Place`, and stops at any portal or level change.**

- MUD tradition, and much simpler.
- It gives the world's portal structure a **tactical meaning it currently lacks**: a zone entrance
  becomes a genuine refuge, which is a use for the fact that all 991 cross-zone exits are portals.
- It avoids a mob stranded in a zone it has no business in, still counting against its own spawn
  limit, walking home across a `Place` boundary it should never have crossed.

Note that *level* changes are the same operation as zone changes here — both are a change of `Place`,
which is the whole point of that abstraction — so "a castle's guards chase you up the stairs" is
explicitly **not** what this says. If that turns out to be wanted, it is a change to what `Place` means
for pursuit and it needs its own note, not a special case.

## 8. The trap, restated

The first combat code written must make stickiness **explicit** — an engagement relationship between
two entities, per §2. Not a distance test that happens to be generous. The difference is invisible on
the first swing and unrecoverable by Phase 12.

Concretely, in Phase 11:

1. `fighting: EntityId | undefined` on the actor, and `wasFighting` beside it.
2. `engage()` / `disengage()` as the only writers, with §3's refusals and §5's enumeration inside them.
3. **No call to any distance function anywhere in melee resolution.** `reach` is consulted by ranged
   attacks and by nothing else.
4. The `inCombat` column on `COMMAND_REQUIREMENTS`, read at the dispatcher seam.
