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

## 5b. Open: a level-1 character still cannot land a kill

Found by playing it, and recorded rather than papered over.

A fresh character now **survives** comfortably — 22 hit points, armour class 14 from the kit, taking
1–4 a round from a level-3 kobold and finishing fights at full health. That was the phase's main
target and it is met. But **no kill happened**, across many attempts, and the reason is a genuine
interaction between this phase and Phase 14's morale:

- A kobold youth averages 35 hit points and its `wimpyAt` is ~18 — it **flees at about half health**.
- A level-1 character deals 3–8 a round, so it takes ~4 rounds to push a mob to its threshold and
  another ~4 to finish it. The mob leaves after the first four.
- Re-attacking picks a *fresh* target rather than the wounded one, and following a flight by hand
  does not reliably re-engage the same body.

Three ways out, none of them chosen yet because it is a balance decision rather than a bug:

1. **More burst at level 1**, so the window between "flees" and "dead" is one round rather than four.
   Simple, and risks trivialising the starter zone.
2. **Pursuit that closes** — `flee.ts` already models a cornered mob, and a player who follows should
   re-engage the body they were fighting rather than the nearest one with the same name.
3. **Leave it to Phase 19.** `bash` and `trip` are exactly the skills that stop a fleeing enemy in a
   MUD, and this may simply be what level 1 feels like without them.

Worth noting for whoever picks it up: **half the low-level population never flees at all** —
`wimpyAt: 0` on the kobold fisherman (91 hp), the wet nurse (57) and one of the two guards (132).
Those are a level-1 character's real prey, and the first kill probably wants to come from there.

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
