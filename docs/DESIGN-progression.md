# Design: progression, and the two scales that collided

Phase 14b. Written before the code, because four of its five problems are decisions and the roadmap
says so: *"a design pass, not an evening."*

## 0. The finding that started it

**A brand-new character cannot win a single fight anywhere in the world.** Not "struggles" — cannot.

| | Level-1 player | A baby kobold (level 2, the weakest thing that exists) |
| --- | --- | --- |
| Hit points | **9** | **23** average (`2d15+7`) |
| Damage | 1d6 → 3.5/round | 1d5 → 3/round |
| To hit | +2 | +0 |
| Armour class | 10 | 1 |

The player needs about **7 rounds** to kill it and dies in about **5.5**. And a baby kobold is the
gentlest inhabitant of 46,508 rooms.

This is not tuning. It is two number systems meeting.

## 1. The decision: SRD sets the shape, Duris sets the magnitudes

The player was built on SRD 5e *magnitudes* — `maxHitPoints(8, 1, 1)` is literally the d8-plus-Con
rule, giving 9. Every mob was harvested on Duris' magnitudes. They differ by ~2.5× at level 1 and the
gap widens with level.

**Resolved:** the SRD keeps the *shape* of the rules — d20 against AC, advantage, damage dice,
ability modifiers, criticals on a natural 20. Duris keeps the *magnitudes* — hit points, the
experience curve, the level band, what a fight costs.

Three reasons, in order of weight:

1. **`CLAUDE.md` already says so**: *"this is a graphical MUD, not an action RPG with MUD flavour —
   MUD mechanisms are the specification."*
2. **Changing the player is one function; changing the mobs is rewriting the world.** 49 populated
   zones and every creature in them are calibrated to the Duris curve.
3. **There is already precedent in the code.** `armourToAc` exists for no other purpose than to
   convert the Duris armour scale into SRD armour class. This decision generalises what that
   function already does.

## 2. What the world is actually calibrated to

Measured across **1,499 mob templates** in the shipped world — the median of each band:

| Level band | Mobs | Median hp | Damage/round | AC |
| --- | --- | --- | --- | --- |
| 1–5 | 110 | 46 | 3 | 1 |
| 6–10 | 179 | 91 | 5 | 3 |
| 11–15 | 126 | 115 | 5 | 5 |
| 16–20 | 118 | 410 | 10 | 7 |
| 21–30 | 207 | 656 | 12 | 10 |
| 31–40 | 182 | 938 | 15 | 10 |
| 41–50 | 216 | 3,549 | 33 | 15 |
| 51–60 | 361 | 8,154 | 55 | 21 |

Hit points rise **177×** from the bottom band to the top; damage only **18×**. Fights get longer and
grindier with level, which is recognisably a MUD.

### The part that explains everything else

Duris' own `advance_level` (`limits.c`) grants a startlingly flat gain: `base_hit += number(0,3)`
below level 26, then `+= 1`, and nothing else. A level-50 character's *base* is therefore under 120.

That cannot fight an 8,154-hp mob — which means in the real MUD **high-level hit points come almost
entirely from equipment**. The flat base is not an oversight; it is the design leaving room for gear
to be the whole story.

**Consequence for us, stated plainly:** we have no equipment system (Phase 15) and no gear worth
wearing (Phase 16). So this phase calibrates **levels 1–15 honestly and leaves 16+ visibly
unfinished**, rather than inventing a fake power curve that Phase 16 would then have to unpick. The
playable band is the newbie band, which is exactly what 14b's *seen when* asks for.

## 3. Hit points

- **Level 1: 22.** Enough to survive ~7 rounds against the level 1–5 band's 3 damage per round, with
  margin for a bad opening. Chosen against the measured band, not from taste.
- **Below 26: +1d4 per level** (average 2.5) — Duris' `number(0,3) + 1` exactly.
- **26 and above: +1 per level** — Duris' rule again.
- **Rolled once per level and stored**, never recomputed, so a character's hit points are a fact
  about them rather than a function that changes when the function changes.

That gives ~46 at level 10 and ~82 at level 25 against band medians of 91 and 656. The player is
behind on purpose: **that gap is Phase 16's job**, and naming it here stops it being tuned away with
the wrong lever.

## 4. The experience curve is Duris', including its shape

From `duris.properties` via `update_exp_table()`, which falls back to the previous level when a step
is unset — so the curve is a **step function**:

| Levels | Experience per level |
| --- | --- |
| 1–5 | 2,000 |
| 6–10 | 8,000 |
| 11–15 | 25,000 |
| 16–20 | 100,000 |
| 21–25 | 400,000 |
| 26–30 | 1,600,000 |
| 31–35 | 3,000,000 |
| 36–40 | 6,000,000 |
| 41–45 | 12,600,000 |
| 46–50 | 20,000,000 |
| 51+ | 40,000,000 |

**Per level, and subtractive.** `advance_level` does `GET_EXP(ch) -= new_exp_table[i]` in a loop, so
experience is a running balance toward the next level rather than a lifetime total, and a single kill
can carry you up more than one level. We keep both properties: they make *"experience to next level"*
directly readable, which is what a player actually wants to know.

The existing `experienceToLevel()` in `rules.ts` — a smooth SRD-ish quadratic — is retired by this.
It was never wired to anything.

**The economy already works.** A baby kobold is worth 259 experience and level 1→2 costs 2,000: about
**eight kills**. Nothing had to be invented.

## 5. Starting equipment, and why it is here rather than in Phase 15

Owner's, 2026-08-02: *"give new players some basic equipment… something with a tiny AC boost so not
every level 1 is a cookie-cutter version of every other one."*

It belongs in this phase and not the next one because **variance at level 1 is a progression
question, not an inventory question**. Two characters who roll differently have different first
hours; that is the difference between a starting band and a starting number.

Scope, bounded deliberately:

- **In:** an item type with a slot and an armour value, a starter kit rolled at creation and
  persisted, armour class and weapon damage derived from what is worn, and the kit shown in the
  character pane's existing paper-doll slots.
- **Out, and still Phase 15:** picking things up, dropping, containers, capacity, trading, and any
  item that is not the kit you started with.

Slots are `DESIGN-inventory.md` §6's exactly — head, neck, chest, legs, feet, hands, main hand, off
hand, back, two rings — because that document already settled them and they map onto LPC's layers.

### Damage is on the MUD's scale too, and that was learned by playing it

The first build fixed hit points and left weapon damage at the SRD's `1d6`. A level-1 character then
dealt about **2 damage per round to a 35-hit-point kobold**: they survived the fight easily and could
never finish it, because the kobold reached its morale threshold and fled long before it died.

Correcting one half of a scale collision produces a character who cannot lose *and* cannot win.
Starter weapons are therefore `2d4`–`2d6`, which puts a same-level fight at six to eight rounds — long
enough to be a fight, short enough to get past the flee threshold.

### The roll

Each kit item rolls its armour independently within a band, so the *total* is a small distribution
rather than a constant. A lucky character starts meaningfully sturdier than an unlucky one, and both
are viable. Weapons vary too, in damage die rather than armour.

**Through the seeded RNG**, never `Math.random()` — `CLAUDE.md` rule 3, and character creation is
simulation. **Rolled once and stored on the record**, which is what stops a player rerolling a kit by
reconnecting, and is the same reason hit points are stored rather than derived.

### Note for Phase 15

`DESIGN-inventory.md` §6 already says the carried-light field is *"an interim stand-in for the best
light among your equipment"* and should collapse into equipment rather than survive beside it. This
phase does not do that — it adds worn items without disturbing `CarriedLight` — but it is the first
step toward it, and the merge is Phase 15's.

## 5b. Pursuit that closes — option 2, built (owner's pick, 2026-08-02)

The problem, found by playing: a kobold youth flees at half health, and `kill youth` resolves by
keyword — it picks the freshest youth in the room, so the wounded one that ran walked away from every
chase. A level-1 character could not land a kill on anything that flees.

**The fix is two rules in `server/src/pursue.ts`.** A mob that flees from you leaves you pointing at
it — at its **entity id**, the identity a keyword cannot express. And arriving in a room where that
body stands, visible and alive, re-engages it automatically: *"You close in on a kobold youth!"* The
sighting passes the same watch-set gate a typed `kill` does, so a mob that flees into darkness is
gone, not tracked through a wall. Engaging anything clears the pointer; so does fleeing yourself —
running away is not a claim on the kill.

**Verified live**: four kills landed, two of them through long multi-room chases in which the pursuit
re-engaged the same wounded body six times and finished it when its flee roll finally failed
(`fleeChance` ≈ 80% per attempt).

### The regen lever — no regeneration while fleeing (owner's pick, 2026-08-02)

A youth regenerated while it ran, so with level-1 damage against 35 hit points the practical kill
window was the ~20%-per-attempt failed flee: a chase could cross four rooms and end near full health.

**Escaping a fight now leaves you winded for {@link WINDED_AFTER_FLEE_MS} — sixty seconds in which
nothing mends.** It refreshes on every flight, so a pursuit can never out-wait it, and it is paid by
**whoever flees, player or mob**: `attemptFlee` is one code path and so is its price. Sixty seconds
is chosen against the chase's own cadence — a catch cycle (follow, close, swing until it runs again)
is five to twenty seconds — so the window holds across any real pursuit while a mob that genuinely
escapes starts healing a minute later rather than being found half-dead an hour on.

Four rules the implementation earned, three of them from adversarial review:

1. **It suppresses only a *positive* rate, and does so before the standstill clause.** A dying body
   carrying a rescue bonus computes `-2 + 6 = +4`; a gate placed after that clause froze it at
   exactly 0 — a stopped death clock, which `HANDOFF.md`'s invariant forbids. Zeroing the mend first
   lets the `-1` floor bite. Winded means *too spent to mend*, never *too spent to get worse*.
2. **`fighting` was wired up in the same motion, and takes the same narrow gate.** `regenPerMinute`
   had authored "fighting means zero" since it was written and the one call site never passed it —
   every combatant quietly trickled 13 hp a minute through their own fights. Its old flat zero rested
   on "a fighting actor cannot be dying", which is enforced for players but not for a downed mob that
   stays engaged until the round boundary, so it now zeroes positive gain rather than everything.
3. **A flight from nothing is not winded.** Outside combat `flee` always succeeds and costs one
   keypress; the price belongs to breaking away from something swinging at you.
4. **The player is told.** *"You flee west! You are winded, and will not recover until you catch your
   breath."* A cost the player cannot see is indistinguishable from a bug.

**Verified live**: after a flee, hit points sat flat for ~53 seconds and then resumed at the full
~13/minute. And the lever closed the loop it was picked for — **Freshstart reached level 2**, the
first time in the game's history, on the fourth chased kill.

Known and accepted: `windedMs` is transient, so a reconnect sheds it while the wound persists. Today
a disconnect also destroys the pursuit entirely, so the wind is the smaller half of what a relog
erases — but it becomes a real loophole the day pursuits survive reconnection, which is where PvP
would take it.

### A real bug the chase found: experience lost across a reload

Experience was checkpointed only at level-up and at disconnect — and a browser reload races the
dying socket's close handler against the new session's join, which can read the record *before* the
close writes it. **388 experience evaporated exactly that way, live.** The award now flushes the
record the moment it lands, which is also what the owner's progress-is-permanent rule implied all
along. (`levelUpIfEarned`'s caller in `index.ts`.)

Still true and still useful: **half the low-level population never flees at all** — `wimpyAt: 0` on
the fisherman (91 hp), the wet nurse (57) and one guard (132). Too tough for level 1 today, but they
become the efficient prey the moment a character has a level or two.

## 6. What death costs — deferred, with the options recorded

Phase 13 left this open and it needs these numbers to mean anything. It now has them, so it is the
next slice rather than this one. Duris' own answer is `lose_level` in `limits.c`: you drop a level,
and below 26 you lose 3 base hit points and 3 base mana with it.

That is harsh in a way modern players may not accept, and the decision is the owner's. The corpse and
its clock already exist (Phase 13), so *"retrieve your corpse for something"* is available without
new machinery.

## 7. Not in this phase

**Ability scores.** They are named in 14b's *carries*, and gear (Phase 16) reads modifiers off them,
so they must exist before Phase 16 — but nothing in the fight loop reads them today, and adding six
numbers that modify nothing would be ceremony. They land with the first thing that consumes them.

**Classes and races.** Duris' hit points multiply by both. Until there is a class system, one curve
serves everybody, and the curve above is deliberately the shape a class system would later scale
rather than replace.
