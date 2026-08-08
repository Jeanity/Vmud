# Spell memory — the economy Phase 21 handed forward

_2026-08-08, written before any code, the way the skills, spells, accounts and characters notes were.
`DESIGN-spells.md` ends by naming seven things Phase 21 would inherit — "the memorization economy
(slots, mem times, `spl_table`), class circle tables, spellbooks and scribing, the psionicist
question, ground-casting and concentration skills, spell penetration, globes and the modifier stack"
— and Phase 21 shipped without them, standing in a flat rule instead: two castings a circle, one more
each ten levels, one back per twenty seconds of rest. **This note settles all seven against the
source.** Its centre is `memorize.c` — 2,701 lines that `DESIGN-spells.md` cited twice and nobody had
read through — with `sparser.c`, `guild.c`, `fight.c`, `innates.c`, `skills.c`, the `Makefile` and the
live `lib/duris.properties`; every claim carries its citation, and the two tables below were produced
by transcribing the source's own generators into a scratch script and running them._

_**What is settled here**: that per-spell memorization times replace the flat twenty seconds and what
the formula is (§1); that slots per circle come from the source's own generator rather than our shape
(§2); that a spell's circle belongs to the **class**, not the spell (§3); that spellbooks and scribing
are cut (§4); that the psionicist stays out and mana stays a prop (§5); the exact order of the gate
stack and the three places our shipped code diverges from it (§6); and that ground casting is dead
code while **concentration** is live and worth adopting (§7). **What stays open**: nothing this note
raises — but three of its decisions are deliberately staged behind a trigger rather than a date, and
§8 says which._

_The precedent everything below rests on is `DESIGN-progression.md` §1 — **the SRD sets the shape,
Duris sets the magnitudes** — and it is invoked by name three times, because three of these decisions
are exactly a magnitude arriving on a scale it was not written for._

---

## 0. The found facts, so nobody re-digs them

**Duris has four casting economies, and our nine classes span three of them.** The cast gate reads
them in this order (`sparser.c:1709-1760`):

| Economy | Macro | Cost paid | Our classes |
| --- | --- | --- | --- |
| **Memorize / pray** | neither of the below | a specific memorized copy of a specific spell | Cleric, Paladin (pray); Sorcerer, Necromancer, Shaman (study) |
| **Commune slots** | `USES_SPELL_SLOTS` (`utils.h:818`) | one anonymous slot of the spell's circle | Druid, Ranger |
| **Mana** | `USES_MANA` (`utils.h:809`) | `circle × 7` at completion | *(none — psionicist family, §5)* |
| **Classless** | — | the item | `recite`, already built |

- **`spl_table` is generated at boot, not authored.** `SetSpellCircles` (`memorize.c:335-435`) builds
  `spl_table[63][12]` from **one number** — `pf = 125`, *"a pf of 125 gives 74 total spells at level
  50"* — under five stated rules (highest circle fewest, monotone down the circles, monotone up the
  levels, at least one new spell per level, no circle may run 3 clear of the next). It is **the same
  table for every class**; class differentiation is one division in `max_spells_in_circle`
  (`memorize.c:157-178`): a full caster gets `MAX(1, j)`, a semi caster `(int)((j + 1) / 2)`, a
  partial caster `(int)((j + 1) / 1.5)`.
- **Circles open every five levels for everyone.** `get_max_circle` is
  `BOUNDED(1, ((GET_LEVEL(ch) - 1) / 5) + 1, MAX_CIRCLE)` (`memorize.c:155`), `MAX_CIRCLE 12`
  (`config.h:122`). A paladin has circle 1 at level 1. Their lateness is not a class gate — it is that
  their spells sit at high circles (§3).
- **A spell's circle is per class.** `SPELL_ADD(Class, Level)` writes
  `skills[spell].m_class[classIdx].rlevel[0]` (`skills.c:60`), read back by `get_spell_circle`
  (`memorize.c:214-256`). Chill touch is circle 2 for a sorcerer and **6 for a cleric**
  (`skills.c:857-862`); cure light is 1 for a cleric and **3 for a paladin** (`skills.c:1306-1309`).
- **The mem-time formula** (`get_circle_memtime`, `memorize.c:638-855`):
  `time = (time_mult × lfactor[circle-1]) / (clevel_mod × tick_factor)`, in **pulses**, `WAIT_SEC 4`
  (`config.h:105`) — so real seconds, not game ticks. `lfactor` is `400·√circle` to the last two
  entries, which are hand-shaved (`{400, 565.6854, 692.8203, 800, 894.4272, 979.7959, 1058.3005,
  1131.3708, 1200, 1264.9110, 1324.0000, 1370.1234}` — √11 and √12 want 1326.65 and 1385.64).
  `clevel_mod` is `fake_sqrt_table[level-1]`, which is `10^((level−25)/50)` precalculated, "*coolest
  thing since sliced bread*". `tick_factor` is `MAX(1, STAT_INDEX(stat))` plus one per point of the
  stat above the character's **racial** baseline — **INT for book classes, WIS for everyone else**
  (`memorize.c:676-731`). `time_mult` is **1.25** for a single-class full caster (*"Why we have a 1.25
  base instead of 1.00 I have no idea"*) and **2.25** for a semi caster, who also has their circle
  index shifted down two and floored at 1 — so a paladin's circles 1 through 4 all cost the same.
- **Below level 25 the timer is halved toward level 26's.** `if (level < memorize.lowlvl.cap /* 25 */)
  clevel_mod += (fake_sqrt_table[25] − clevel_mod) / 2` (`memorize.c:736-740`) — an explicit newbie
  clemency, and the property is unset in the live file so the default of 25 is the live value.
- **Memorization requires both position axes.** `handle_memorize` (`memorize.c:1079`) stops on
  `GET_STAT(ch) != STAT_RESTING || (GET_POS(ch) != POS_SITTING && GET_POS(ch) != POS_KNEELING)`.
  `commune` has **no such gate** — `handle_undead_mem` (`memorize.c:913-1050`) refills anywhere, and
  the only bar is `IS_CASTING(ch) || GET_OPPONENT(ch)`.
- **Commune refills the highest empty circle first** — `memorize.c:939`, which is the compiled arm of
  `#ifdef REVERSE_DRAGOON_COMMUNE` and walks `max_circle` down to 1 for everyone but a dragoon, one
  slot per `get_circle_memtime(ch, highest_empty)`.
- **A fresh circle arrives empty.** `advance_level`: `if ((GET_LEVEL(ch) % 5 == 1) && USES_SPELL_SLOTS(ch))
  ch->specials.undead_spell_slots[(GET_LEVEL(ch) + 4) / 5] = 0;` (`limits.c:688-694`).
- **`stop_memorizing` throws the progress away**, and `set_fighting` calls it on **both** parties
  (`fight.c:8014-8017`). Movement calls it six times over in `actmove.c`.
- **The shipped Makefile builds a chaos-event configuration**, and this is the note's largest
  finding — see §4.

## 1. Real mem times, yes — and the model we already have is the right one to hang them on

**Decided: the flat `MEMORIZE_SLOT_MS = 20_000` is replaced by the source's formula — which is
per *circle*, not per spell — and the anonymous per-circle casting stays.** That distinction is the
decision, not a hedge: `handle_undead_mem` itself calls `get_circle_memtime(ch, highest_empty)`, so a
per-circle timer over anonymous slots is not a simplification of Duris, it **is** one of Duris' three
economies, taken whole.

The flat twenty seconds is not wrong in *magnitude*. Transcribed and run, the source's own numbers for
a caster whose casting stat sits at their racial baseline are:

| Level | circle 1 | 2 | 3 | 4 | 5 | 6 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 11.3 s | 16.0 | 19.6 | 22.7 | 25.4 | 27.8 |
| 10 | 10.1 s | 14.3 | 17.5 | 20.2 | 22.6 | 24.7 |
| 20 | 8.5 s | 12.0 | 14.7 | 17.0 | 19.0 | 20.8 |
| 30 | 6.2 s | 8.8 | 10.7 | 12.4 | 13.9 | 15.2 |
| 50 | 2.5 s | 3.5 | 4.3 | 4.9 | 5.5 | 6.1 |

Twenty seconds sits in the middle of the low band. What is wrong is that it is **flat in all three
directions the source varies**: a circle-6 nuke costs the same as a cantrip, a level-50 archmage
refills no faster than a novice, and the casting ability the character sheet spent five bonus points
on does nothing. The consequence is measurable and backwards — a full book takes **12.7 minutes at
level 50 under our rule and 6.2 under the source's**, because Duris' level term outruns its own slot
table while ours cannot.

**The formula, converted once.** Circle and level need no conversion — `400·√circle` and
`10^((level−25)/50)` are pure. The casting stat does, and this is `DESIGN-progression.md` §1 in its
plainest form: the *shape* is the source's (linear in the casting ability, from a baseline of 16 at
the racial norm) and the *step* is chosen to reproduce the source's own achievable span on our
narrower scale. Duris' casting stat runs about 100 to 140, taking the tick factor 16 → ~60 and the
times to roughly a quarter; ours runs from the racial baseline `10 + racialBonus` to 20, a span of
eight to ten. So **each of our points is worth five**:

```
memoriseMs(circle, level, score, racialBaseline) =
    1000 × (timeMult × 400·√circle) / (levelFactor(level) × statFactor(score, racialBaseline)) / 4

  levelFactor(level) = 10^((level − 25) / 50),  and if level < 25:  f += (10^(1/50) − f) / 2
  statFactor(score, base) = 16 + 5 × max(0, score − base)          base = 10 + racialBonus(ability)
  timeMult = 1.25 full casters; 2.25 half casters, whose circle index is max(1, circle − 3)
```

**The 5 is ours and is named as ours.** Everything else is transcribed, including the 1.25 nobody in
Duris could explain.

**Which score**: INT for arcane, WIS for divine. `CharClass.casting.kind` already carries exactly that
discriminator, because `maxManaFor` needed it — the field gets its second reader and its first one
that changes an outcome.

**Three rules that come with the timer, all transcribed:**

1. **Highest circle first**, not lowest (`memorize.c:939`). Combined with per-circle times this is the
   whole texture: the spell you most want back is the slowest to arrive, so resting becomes a
   decision — a short sit buys nothing, a long one buys your best.
2. **Both position axes**, for the classes that pray or study. Our pass reads `player.status ===
   'resting'` alone; the source wants resting **and** sitting or kneeling. This is the first spell-side
   reader the posture ladder has ever had. The cost is one keystroke — `rest` keeps you standing
   (Phase 5), so a caster types `sit` then `rest` — and the refusal line should say so rather than
   leaving a player watching a number that never moves.
3. **Commune does not require rest at all.** Druid and Ranger refill walking, and stop only in a
   fight. That is a free, cited, three-way class differentiation: *the priest kneels, the wizard sits
   with a book, the druid just keeps walking.*

**What is deliberately dropped.** The **per-spell memorize queue** — Duris' book and prayer classes
memorize *named spells*, not anonymous castings (`TAG_MEMORIZE` affects, flipped un-full by
`use_spell`, `memorize.c:1843-1935`). Ours stays anonymous, because the choice it exists to make does
not exist yet: a cleric knows five spells and holds castings in three circles, so "which do I carry"
has one answer. Named with its trigger: **build the queue the first time any class list passes about
twelve spells**, which is when `memorize magic missile` starts meaning something. (The mechanism, for
whoever builds it: a `TAG_MEMORIZE` affect per queued spell, flipped un-full by `use_spell` and
re-queued rather than removed — `memorize.c:1843-1935`, the toggle at `1921`.) Also dropped:
`AFF_MEDITATE` halving the timer (no such skill), the multiclass ×1.75, the druid's terrain and
alignment multipliers (`druid_memtime_terrain_mod`, and *"0 align reduces time by 1/3"*), the
`SKILL_DEVOTION` refund that sometimes makes a casting free.

**Changes**: `MEMORIZE_SLOT_MS` (`server/src/index.ts:1018`) becomes a function in `shared`; the
memorization pass at `index.ts:9203-9222` swaps its ascending `sort` for a descending one and its
constant for `memoriseMs(...)`; `Player.memorizeMs` (`sim.ts:426`) keeps its meaning but is compared
against a per-circle target; `restoreProgress` (`index.ts:1583`) and `rememberProgress`
(`index.ts:1550`) are untouched — the accumulator is deliberately not saved, exactly as today.

## 2. Slots per circle: take the source's generator, not its output

**Decided: transcribe `SetSpellCircles` and delete our `2 + level/10` shape.**

The task of "transcribe the actual table for our nine classes" has a surprising answer: **there is one
table, and six of our nine classes read it unchanged.** Warriors and rogues have no casting; Cleric,
Druid, Shaman, Sorcerer and Necromancer are `IS_PURE_CASTER_CLASS` (`utils.h:793-795`) and take
`MAX(1, j)`; Paladin and Ranger are `IS_SEMI_CASTER_CLASS` (`utils.h:797`) and take `(int)((j + 1) / 2)`.
Run against `pf = 125`:

| Level | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | | | | | | | | **1** |
| 5 | 6 | | | | | | | | **6** |
| 10 | 6 | 6 | | | | | | | **12** |
| 15 | 8 | 7 | 5 | | | | | | **20** |
| 20 | 8 | 7 | 6 | 5 | | | | | **26** |
| 26 | 9 | 8 | 7 | 6 | 5 | 1 | | | **36** |
| 30 | 9 | 8 | 8 | 7 | 6 | 4 | | | **42** |
| 40 | 10 | 9 | 9 | 8 | 7 | 6 | 5 | 4 | **58** |
| 50 | 11 | 10 | 9 | 9 | 8 | 7 | 6 | 5 | **74** |

A half caster at 30 reads `5 4 4 4 3 2` — **22**. Ours today reads `4 4 3 3 2 2` — **18** — for a
*full* caster, and 2 at level 1 where the source gives 1, and 2 at level 5 where the source gives 6.
Our curve is flat and late where the source's is steep and early; the source pays for that with mem
times that start at eleven seconds and our flat twenty could not.

**This is `DESIGN-progression.md` §1 pointing at itself**: the shape (a pyramid of castings by circle,
opening on a five-level cadence) is what both systems have; the magnitudes are Duris' and we have been
inventing our own beside a world calibrated to theirs.

**Transcribe the generator, not the numbers.** Forty lines with five rules stated in its own comment
beats a 63×12 literal that nobody can check, and it means `pf` stays one tunable number with the
source's own note about what it buys. Pin it with a test asserting the rows above.

**One rider, cheap and flavourful**: a newly opened circle arrives **empty** (`limits.c:692`), so
reaching a new circle gives a caster room for something greater rather than a free casting.

**What is deliberately dropped**: `MAX_CIRCLE` stays 12 in the data and unreachable in play (our band
is 1–30, so circle 6); `IS_PARTIAL_CASTER` (`(j+1)/1.5`) has no class of ours; `get_power_level`'s
dragoon percentage bar; the specialisation column (`rlevel[spec]`) — we have no specs.

**Changes**: `slotsForCircle` (`shared/src/classes.ts:188`) keeps its name and loses its body;
`circleOpensAt` (`classes.ts:177`) is deleted with `opensAt` (§3); `listSpells`
(`server/src/index.ts:6782`) and `castClassSpell` (`index.ts:3657`) read it unchanged.

## 3. A spell's circle belongs to the class, not to the spell

**Decided: `circle` moves off `Spell` and onto the class list; `casting.opensAt` is deleted.**

Our `Spell.circle` is a single global number (`shared/src/spells.ts:50`). The source has no such
field — the circle lives in `skills[spell].m_class[class].rlevel[0]`, one per class, and the spread is
not decorative:

| Spell | Duris circles, by class | Ours |
| --- | --- | --- |
| magic missile | sorcerer **1**; illusionist 1, bard 3, reaver 2 — necromancer's line is **commented out**, *"removing it, since they now get slashing darkness"* (`skills.c:850`) | 1 |
| burning hands | sorcerer **2** (`skills.c:868`) | 2 |
| chill touch | necromancer **2**, sorcerer 2, **cleric 6** (`skills.c:858-862`) | 2 |
| shocking grasp | sorcerer **3** (`skills.c:878`) | 3 |
| cure light | cleric **1**, paladin **3**; druid's and ranger's lines commented out (`skills.c:1306-1309`) | 1 |
| cure serious | cleric **2**, paladin **5** (`skills.c:1327-1330`) | 2 |
| armor | cleric **1**, paladin **3** (`skills.c:619-622`) | 1 |
| bless | cleric **1**, paladin **2**; druid's and ranger's commented out (`skills.c:1113-1118`) | 1 |
| earthquake | cleric **3**, druid **5** (`skills.c:1017-1021`) | 3 |
| ice storm | sorcerer **6**, ethermancer 5 (`skills.c:1999-2004`) | 6 |

Two of our rows are already wrong because a single number cannot hold two answers: our **druid** gets
earthquake at circle 3 (level 11) where Duris makes a druid wait for circle 5 (level 21), and our
**shaman** gets chill touch at circle 2 where the source's shaman does not get it at all — the shaman
has eighty registrations of its own and none of our ten among them.

**And the half-caster gate is not a gate.** `opensAt: 11` is our invention standing in for a class
lateness the source expresses through the circle table. Measured across every `SPELL_ADD`: a
**ranger's** lowest circle is **3**, which opens at level 11 — exactly what we ship, arrived at by
accident. A **paladin's** lowest is **2** (bless), which opens at level **6**. So the field is right
once and wrong once, and deleting it fixes both: circles open at 1, 6, 11, 16 for every caster, and
lateness is a property of where a class's spells sit. What replaces `opensAt`'s *other* job — keeping
half-casters weaker — is §2's `(j + 1) / 2`, which is the source's own answer.

**What is deliberately dropped**: the six commented-out registrations that touch our nine — the
necromancer's magic missile, the druid's cure light, cure serious and bless, the ranger's cure light
and bless — are *not* transcribed as absences. Our class lists were sized so that nine classes each
have something to do against a ten-spell registry, and a druid with no cure light is a druid with
three spells. The lists stay **ours**, and this note is the place that records which rows are
transcription and which are authorship.

**Changes**: `Spell.circle` (`shared/src/spells.ts:50`) is removed and `CharClass.spells` becomes
`Readonly<Partial<Record<SpellId, number>>>`; `CharClass.casting.opensAt` (`classes.ts:60`) is
deleted; `circleAt` (`classes.ts:72`) loses its second argument; `knownSpells` / `knowsSpell`
(`classes.ts:194, 201`) read the class's own circle; `castClassSpell` (`index.ts:3657-3661`) and
`completeCast` (`index.ts:4191-4193`) take the circle from the caster's class rather than from
`SPELLS[id].circle`; `listSpells` (`index.ts:6782`) groups by it; the admin panel's mob spell picker
(`packages/admin/src/sections/mobs.ts:606`) is unaffected — a mob's circle comes from its own class.

## 4. Spellbooks and scribing are cut — and the shipped Makefile cut them first

**Decided: no spellbook item, no `scribe`, no `SKILL_SCRIBE`. A caster knows their class list.**

**Does an arcane caster need the book present to memorize?** In the C, yes, twice:
`handle_memorize` refuses a spell not found in a book in inventory, at hand, on belt or on the ground
and stops the whole trance — *"You have managed to misplace your spellbook!"* (`memorize.c:1091-1096`,
`1103-1106`) — and `do_memorize` refuses at queue time, *"Sorry, but you haven't got that spell in any
available spellbooks!"* (`memorize.c:1628-1650`).

**Both sit inside `#if !defined(CHAOS_MUD) || (CHAOS_MUD != 1)`, and `Makefile:18` reads
`CFLAGS += -DCHAOS_MUD=1`.** In the build the on-disk source produces, neither runs. Under that flag
the only surviving gate at `do_memorize` is `maxlearn` — the class table — and the max-circle refusal
survives only indirectly, through `max_spells_in_circle` returning 0 for an unopened circle and the
message coming out as *"You can't hold any more spells in your thought."*

**And here the §0 doctrine needs judgment rather than obedience, which is worth writing down.**
`DESIGN-skills.md` §0 found `NEW_COMBAT` and `wipe2011` — a build flag and a wipe that never
happened, both facts about *the* game. `CHAOS_MUD` is different: it is a **mode**. The same flag makes
`update_skills` set every class skill to `learned = taught = 100` (`guild.c:73-140`), levels every new
character to 56 in `nanny.c:2406-2421`, and multiplies mob hit points by `(1 / 10)` in integer
arithmetic — which is zero — then adds one, so **every mob in that build has one hit point**
(`mobconv.c:390-392`). Nobody plays that. So the honest reading is: *the checkout is configured for a
chaos event, and the flag is evidence about what Duris was willing to switch off, not about what the
game is.* Two consequences, both recorded:

- The spellbook cut rests on **its own argument**, corroborated and not proven: a spellbook needs an
  item type, a pen item type, both hands occupied, a page economy (`GetSpellPages` = the spell's
  circle, minus `max(1, scribeMastery / 5)`, against `value[2]` capacity, `memorize.c:274-296`), a
  per-page event chain at `4 − SKILL_SCRIBE/33` pulses, a teacher mob, and a guildhall library — and
  the source itself automated the friction away with `scribe all` and a room whose description
  promises *"a library with a tome from which you can memorize all spells"*
  (`guildhall_cmds.c:638`, `prac_all_spells` at `guild.c:880`, `do_scribe` at `memorize.c:2342`). A
  system that ships its own bypass is telling you what its friction was worth.
- **`DESIGN-skills.md` §1's `minlearn = MIN(40, (3 × level) / 2)` floor is inside the `#else` of that
  same guard.** The note's rule stands on its merits — we chose to run `wipe2011` for exactly this
  kind of reason — but its "we take this exactly" should read "we adopt this, from a branch the
  on-disk configuration does not build". Recorded here rather than edited there; the reference is
  `DESIGN-skills.md` §0's own list, and this is a third entry for it.

**The half-measure to keep in the back pocket**, so "find a spell in the world" is not lost with the
book: the source already has `quested_spell(ch, spl)`, a per-character exception checked *beside*
`maxlearn` at every gate. One boolean set on `PlayerRecord`, costing nothing until there is a quest
that sets it, and the quest mechanism landed with Phase 21 §8.

**What is deliberately dropped**: `ITEM_SPELLBOOK`, `ITEM_PEN`, `SKILL_SCRIBE`,
`SKILL_SCRIBE_MASTERY`, `do_teach`, `INNATE_ARCANE_RUDIMENTS`, and the spellbook's language and class
locks — which the source itself has commented out (`memorize.c:2203-2213`).

## 5. The psionicist stays out, and mana stays a prop

**Decided: no tenth class, and `maxManaFor` continues to meter nothing — but the seam §1 builds is
what would let it in cheaply.**

The psionicist is not a class with a different spell list. It is **a second verb, a second resource, a
second speed, and a refusal in the first line of `do_cast`**:

- `do_cast` refuses them outright: *"Psionicists use the command &+Bwill&n to use their abilities."*
  (`sparser.c:2202`).
- `USES_MANA(ch)` is a **race** gate as much as a class one — Pillithid or Illithid by blood, or
  Psionicist or Mindflayer by class (`utils.h:809-811`).
- Their cost is `circle × MANA_PER_CIRCLE` (7, `config.h:68`) at completion, or `circle × 3.5` on a
  Spatial Focus proc (`memorize.c:1855-1868`) — but the *gate* is only `GET_MANA(ch) >= 1`
  (`sparser.c:1719-1726`), so a psionicist may always overdraw into negative mana, and the punishment
  for it (`KnockOut` at `-1.5 × mana`) is commented out (`sparser.c:2883-2893`).
- `do_will` halves the wind-up unconditionally — `dura >>= 1` at `sparser.c:1959`, *"they're all
  fast-thinkers"* — and Spatial Focus can cut it to a single pulse.
- Their memorization branch exists and is commented out in **five** places, each carrying the note
  *"reverting psionicist to use mana"* (`memorize.c:694`, `827`, `970`, `1035`; `sparser.c:1735-1741`).
  The class changed economies mid-life and the source kept both.

For nine classes against a ten-spell registry, that doubles the casting surface for one class. **Out.**

**What would bring it in, named**: not a tenth class — the door is Phase 21's **races**, because
`USES_MANA` opens on blood first. And the reason it would then be small is §1: once the cost function
sits behind one seam (`castClassSpell`'s debit and the refill pass's credit), a mana class is one
branch in each plus `will` as a command-table alias. **The seam is the deliverable; the class is
content.**

**One honesty item while we are here.** `maxManaFor` (`classes.ts:212`) gives every caster a pool that
nothing spends and the HUD displays. That is the inert surface `HANDOFF.md` warns about, wearing a
number a player will reasonably plan around. Either the sheet should say what mana is for, or the
pool should wait for the thing that spends it.

## 6. The gate stack: save, ward, globe, deflect, procs, shrug — and three live divergences

**Decided: our save-then-shrug order is correct and incomplete; the globes land with the first globe
spell and not before; the three divergences below are bugs today.**

`DESIGN-spells.md` §1 said damage spells roll save-then-shrug and effect spells shrug-then-save. Both
verified — fireball rolls `NewSaves` then calls `spell_damage` (`magic.c:3046-3051`); major paralysis
calls `resists_spell` then `NewSaves` (`magic.c:7064-7080`). What §1 could not see is that **there are
eight layers between them**. The compiled order, `spell_damage` (`fight.c:4329-4680`):

1. **The save** — in the handler, before `spell_damage` is ever called, doubling or halving the dice.
2. **`check_damage_ward`** — a flat absorb pool subtracted. This is stone skin's family and our
   reserved `'absorbed'` outcome.
3. **Elemental vamp** — a fire spell on a fire-aura-plus-fireshield victim *heals* them `dam / 4`.
4. **`remember(victim, ch)`** — aggro is recorded **before any mitigation**, so a spell blocked
   entirely still makes an enemy. Keep this: it is `joinBySupporting`'s aggressive twin, and getting it
   the other way round means a shrugged nuke is free.
5. **Globes** — four wards, all-or-nothing, `attack_back` and out (`fight.c:4416-4432`).
6. **Deflect** — the spell is thrown back at the caster at `dam × 0.7` and the affect is consumed.
7. **Equipment and mob `CMD_GOTNUKED` procs.**
8. **The shrug** (`resists_spell`, `fight.c:4614`), then a **slot-refund absorb** for `USES_SPELL_SLOTS`
   victims with `INNATE_SPELL_ABSORB`.
9. Type shields (ice armor vs fire, neg armor vs holy), then the damage-modifier table, then
   `raw_damage`.

**Globes, precisely.** Four: `AFF_MINOR_GLOBE`, `AFF2_GLOBE` (major), `AFF3_SPIRIT_WARD`,
`AFF3_GR_SPIRIT_WARD` (`defines.h:647, 690`). Which one stops which spell is a **per-spell flag** in
the direct-call path — magic missile and chill touch pass `SPLDAM_ALLGLOBES` (everything stops them),
fireball passes only `SPLDAM_GLOBE`. But the legacy `damage()` wrapper derives the flags from the
circle, and that is the rule worth adopting because it needs no new per-spell data
(`fight.c:3714-3722`):

```
circle < 4  → minor globe stops it
circle < 5  → spirit ward stops it
circle < 6  → greater spirit ward stops it
circle < 7  → major globe stops it   (detonate excepted)
```

A globe that applies eats the **whole** spell and does not wear off. So a major globe is total immunity
to everything below circle 7 — which is every spell in our registry — and that is exactly why it does
not ship now: **a ward with no source is inert surface, and a ward this absolute is worse than inert if
a mob ever gets one.** Named with its trigger: the hook, the circle-derived flags and the `'absorbed'`
outcome land **with the first globe spell in the registry**, not before.

**Spell penetration** is an **epic** skill (`epic_skills.c:170`, `TAR_EPIC`), bought for 2,000,000 by
arcane classes only (`epic_skills.c:51`). Inside `resists_spell` (`innates.c:3722-3812`): consent and
self-casts never shrug; a victim already carrying the penetration affect never shrugs; otherwise
`number(1, 101)` against `get_innate_resistance(victim)`; a beholder always shrugs; and on a shrug the
caster rolls `number(0, 110) < BOUNDED(10, skill / 2, 60)` to burst through, which installs the
penetration affect on the victim. **The half nobody remembers**: that affect then cuts the *next*
spell's damage by `number(20, 70)` percent and is consumed (`fight.c:4215-4222`) — which is why the
messages say *"partially"*. Not now, we have no epic economy. **But one branch of it is worth having
early**: an NPC caster that is elite or a greater race substitutes `skill = GET_LEVEL(caster)`, so a
level-56 boss penetrates at the 60 cap. That is what makes a boss caster frightening to a drow, and
`shrugChance` already exists to take the argument.

**Three divergences in code shipped today:**

1. **`shrugChance(raceCode, level, base = 0)` (`spells.ts:341`) defaults the racial base to zero**, so
   every magic-resistant race shrugs at the 5% floor. The live config has real numbers:
   `innate.shrug.DrowElf=35`, `GreyElf=35`, `Half-Elf=20`, `WoodElf=5`, `Human=0`
   (`lib/duris.properties:1899-1933`). At level 30 a drow should shrug **17%**, at 50+ **29%**. Nobody
   passes `base` from anywhere.
2. **Duergar is not magic resistant in the source.** `assign_innates` grants
   `INNATE_MAGIC_RESISTANCE` to eladrin, tiefling, githzerai, grey elf, half-elf, wood elf, drider,
   drow, githyanki, pillithid, lich, both vampires, phantom, angel, dragon, dragonkin, devil,
   dracolich and undead (`innates.c:477-770`) — no duergar, no dwarf. Our `MAGIC_RESISTANT_RACES`
   (`spells.ts:324`) includes `'PD'`. `DESIGN-characters.md` §3 hedges it as "MR-adjacent (magical
   reduction)", which is a *different* mechanism; either drop `'PD'` or record it as chosen.
3. **`ICE_STORM_MIN_CHANCE = 90` (`spells.ts:173`) is the C default, not the live value.** The
   properties file sets `spell.area.minChance.iceStorm=0.000` (`duris.properties:821`) against the
   `get_property(..., 90)` fallback at `magic.c:12894`. Ours floors an ice storm at hitting 90% of the
   players present; the live server floors it at none.

### Resolved — §8 slice 3, 2026-08-08

**All three are fixed, and a fourth was found in the fixing.** Each decision and what it cost:

**1. The bases are in, and `MAGIC_RESISTANT_RACES` is a map.** The set became
`ReadonlyMap<string, number>`, code → live base, because membership and magnitude come from two
different sources and both had to be transcribed: *who rolls* is the C (`resists_spell` tests
`has_innate(victim, INNATE_MAGIC_RESISTANCE)` and nothing else, `innates.c:3757`), *how much* is a
runtime property (`update_racial_shrug_data` fills `racial_shrug_data[race]` from
`innate.shrug.<race>` with a default of 0, `sparser.c:2942-2952`, read by `get_innate_resistance` at
`innates.c:3696`). That is `DESIGN-spells.md` §2.6's *"the property names recorded beside each
number"*, so every row carries its property line and its `innates.c` grant. The level arithmetic is
untouched — the third parameter is gone because the map is now the only source of a base, and
nothing ever passed it.

What a player feels, at the top of our band (level 30) and at the source's own ceiling:

| Race | Code | Base | L30 before | L30 after | L50 after |
| --- | --- | --- | --- | --- | --- |
| Drow | `PL` | 35 | 5% | **17%** | 29% |
| Grey Elf | `PE` | 35 | 5% | **17%** | 29% |
| Half-elf | `P2` | 20 | 5% | **8%** | 14% |
| Duergar | `PD` | — | 5% | **0% — removed** | — |
| Dragon | `D` | 45 | 5% | 23% | 39% |
| Water elemental | `EW` | 55 | 5% | 29% | 49% |
| Demon / Devil | `X` / `Y` | 50 | 5% | 26% | 44% |
| Dracolich | `UD` | 30 | 5% | 14% | 24% |
| Fire / Air / Earth elemental | `EF` / `EA` / `EE` | 20 | 5% | 8% | 14% |

**2. `'PD'` is out — magical reduction is a damage mechanism, not this one.** Grepped whole:
`MAGICAL_REDUCTION` occurs **four times in the entire source** — the `#define` at `structs.h:417`,
two grants (`RACE_MOUNTAIN` and `RACE_DUERGAR`, both at level 1, `innates.c:473` and `552`), and
exactly one reader: a damage-modifier predicate in `spell_damage_modifiers[]` that does
`dam_mod->mod += -0.2; dam_mod->type = More` on `case SPLDAM_GENERIC` (`fight.c:3817`). It never
appears in `innates.c`'s resist path. **And it is live, not a dead branch** — the §0 doctrine's own
test, run: there is not a single preprocessor directive between `fight.c:3600` and `3900`, and the
table is iterated unconditionally by `spell_damage` at `fight.c:4659-4662`. So this is not a
`NEW_COMBAT` / `wipe2011` / `CHAOS_MUD` ghost; it is a real mechanism we simply do not have. `'PD'`
leaves the map, `races.ts` reads `magicResistant: false`, and `DESIGN-characters.md` §3's
"MR-adjacent" hedge — which is what put it there — is corrected in place.

**Parked, with its trigger: spell damage reduction.** A flat −20% multiplicative band on generic
spell damage, carried by duergar *and mountain dwarves*. Not built now, because the shape it wants
is the ward stack §6 already parks — `check_damage_ward`'s absorb pool and the `'absorbed'` outcome
— and building a one-race percentage beside it invites two mechanisms where the source has one.
**Build it with the damage-modifier stack**, i.e. whenever `check_damage_ward` or the globes land;
that is the pass where a −20% racial band is one row rather than a special case. Until then both
dwarves take spells whole, which is the honest under-implementation rather than a wrong gate.

#### Built — 2026-08-08, and the parking reason did not survive the reading

_`reduceSpellDamage` (`shared/src/spells.ts`), `Race.magicalReduction` (`shared/src/races.ts`),
wired at all three spell-damage deliveries in `server/src/index.ts`._

The park above said *build it with the ward stack, or you will have two mechanisms where the source
has one*. Going back to the C to do that found the opposite: **the source already has two, and it
keeps them apart on purpose.** `check_damage_ward` is subtracted at the very top of `spell_damage`,
before any gate (`fight.c:4349`); the modifier table runs at the very bottom, after every gate has
had its early return (`fight.c:4648-4682`). A ward is an absorb pool measured in hit points; this is
a percentage. Waiting for the first would have delayed the second for nothing, so it shipped alone.

**The finding that changed the shape: it is not a flat racial band.** The predicate is a `switch`
with one `case` and no `default` (`fight.c:3817`), so only `SPLDAM_GENERIC` — type **1**, the
source's name for force — is reduced. All eleven other `SPLDAM_` types (`damage.h:91-103`) pass
through untouched, and `ELEMENTAL_DAM` (`damage.h:105`) excludes generic from the other side. Our own
registry splits **two to four** on exactly that line, which is why `Spell` now carries a
`damageType` read off each handler's own call:

| Spell | Source call | Type | Reduced |
| --- | --- | --- | --- |
| magic missile | `magic.c:510` | `SPLDAM_GENERIC` | **yes** |
| earthquake | `magic.c:3485` | `SPLDAM_GENERIC` | **yes** |
| burning hands | `magic.c:623` | `SPLDAM_FIRE` | no |
| chill touch | `magic.c:539` | `SPLDAM_COLD` | no |
| shocking grasp | `magic.c:644` | `SPLDAM_LIGHTNING` | no |
| ice storm | `magic.c:12868` | `SPLDAM_COLD` | no |

A duergar shrugs off part of a magic missile and takes *burning hands* whole. That is the
counter-intuitive half, it is what the source says, and it is the test that would have been written
wrong from memory.

**Arithmetic, transcribed.** `dam_mod->mod += -0.2` with `dam_mod_type::More`, folded as
`moreMod *= (1 + mod)` (`fight.c:4676`) — multiplicative ×0.8, not a flat −20. It cannot stack:
a fresh `damage_mod` is zeroed per predicate (`fight.c:4661`) so the `+=` starts from 0, a racial
innate is granted once, and no other row in the table reads generic damage — which also puts the
source's `BOUNDEDF(0.1, moreMod, 2.0)` clamp out of reach through this path, so it is not modelled.

**Order, and it is the point.** This is *not* a gate. Every gate in `spell_damage` returns early —
ward, elemental vamp, globes, deflect, procs, the shrug, spell absorb, type shields
(`fight.c:4349-4646`) — and the modifier table only runs on damage that has already been decided to
land. So the reduction sits after the shrug, in our code as in the C: the gates say *whether*, this
says *how much*. It is layer 9 of the stack this section maps, arriving.

**Silent, verified.** The predicate calls no `act()`. Its neighbour at `fight.c:3810` — arcane block,
doing the same job — prints three lines, which is how we know the absence is a choice and not an
oversight. Nothing in our combat feed announces it either: a duergar simply sees a smaller number.

**It is a race fact, not a player fact, and the world made that decision.** `has_innate` reads
`ch->player.race` for anything with a race — `innate_char_race` (`innates.c:362`) is consulted by
`innate_unlock_level` (`innates.c:420-428`) with no PC/NPC branch — and racial innates unlock at
level 1. The harvest settles the question: **25 mobs already carry these codes**, 16 `PM` (dwarven
soldiers, Olaf Forkbeard, Surak) and 9 `PD` (duergar slaves, Bregnar the duergar King), across eight
zones — none of them in `world.config.json` today, every one of them a line away. Keying on the code
arms all of them the day their zone loads; keying on player identity would have quietly exempted them
from the mechanism their own kin gave the name to. So it reads the same `raceCodeOf` the shrug gate
does — extracted into one function the day the second reader arrived, because two copies of that
expression is how they come to disagree.

**The roster is derived, not listed.** `MAGICAL_REDUCTION_RACES` is built from `RACES` by the
`magicalReduction` flag, unlike `MAGIC_RESISTANT_RACES` which is hand-written. The difference is
warranted: MR has a roster of thirty-odd races most of which we cannot draw, while `MAGICAL_REDUCTION`
occurs four times in the whole source and grants to exactly two races, both of them ours. There is no
third to add later, so a set that can drift from the flag would be pure liability.

**Drive, 2026-08-08** (`GAME_PORT=8796`, PvP on). Six level-30 necromancers spending their memorised
castings on two level-30 victims identical in level, scores and hit points and differing in exactly
one fact — **Softskin is human, Stonehide is duergar**. Six casters and not one because *a caster who
lands a spell is in combat and cannot rest*, so there is no refilling mid-drive; that cost the first
attempt an hour of nothing and is worth writing down.

| Spell | Type | Casts each | Softskin (human) | Stonehide (duergar) | Ratio |
| --- | --- | --- | --- | --- | --- |
| magic missile | `SPLDAM_GENERIC` | 24 | **696** | **548** | **0.787** |
| burning hands | `SPLDAM_FIRE` | 12 | **340** | **333** | **0.979** |

The generic spell lands 21% lighter on the duergar against the 20% the C asks for — 120 bolts a side,
each one twice floored (the ×0.8, then the player-pool divide), so the last percent is sampling and
rounding rather than mechanism. **The fire spell shows no gap**, which is the half that matters: it is
the control that proves the `switch` was transcribed and not flattened into "dwarves take less magic".

And the silence was checked rather than assumed — one cast at each victim with **every** line both
of them received printed in full. The two feeds are the same shape and differ only in the number:

```
Softskin  (human)   -=[ Boltalpha's magic missile strikes you for 28! ]=-
Stonehide (duergar) -=[ Boltalpha's magic missile strikes you for 21! ]=-
```

No extra line, no colour, no hint. A duergar player is never told they are armoured; they only ever
see a smaller number, exactly as `fight.c:3817` leaves it.

_Still parked from here: the ward stack itself (`check_damage_ward`, the `'absorbed'` outcome and the
four globes) is untouched — it was never this mechanism's blocker and it still waits on its first
globe spell. And spell penetration's damage half (`fight.c:4215-4222`), a second `More` row on the
same table, still waits on an epic economy._

**3. `ICE_STORM_MIN_CHANCE` is 0.** `get_property` `bsearch`es the loaded property table and returns
its default **only when the key is missing** (`properties.c:59-72`) — a present key worth `0.000` is
returned as 0, not treated as unset. The key is present (`duris.properties:821`), so the running
server reads **0** and the `90` at `magic.c:12894` is unreachable for this spell. Ours now matches:
an ice storm no longer floors at nine of ten players in the room, it lets `areaHitCount`'s own draw
decide, which for ten players is four to six. The 90 stays pinned in the tests as the shape a
*floored* area spell has — fire storm and nova still read it (`magic.c:3562`, `4033`).

**4. Found in the fixing: four of the eight mob codes named no race.** The keys are meant to be the
source's own mob race codes — `race_names_table`'s fourth column (`common.c:67`), echoed in
`defines.h`'s per-race comments, and the same string a `.mob` file's second line carries and
`worldgen/src/mobs.ts:299` reads. Measured against that table, Phase 20's set was: `DR` is
**drider**, not dragon (`D`); `DV` is **deva**, not devil (`Y`); `WE` is **wood elf**, not water
elemental (`EW`); `AE` is a **quadruped**, not air elemental (`EA`); and `DL`, `DE`, `FE` name
nothing at all — dracolich is `UD`, demon is `X`, fire elemental is `EF`. Corrected to the races
Phase 20 meant, under their real codes.

**Nothing was reachable, which is why it stayed quiet**: every race code in the loaded world is a
humanoid (`PH`, `H`, `G`, `PT`, `PE`, `PG`, `PL`, `PB`, `PO`, `PM`, `P2`, `PF`, `PD`), because
`spriteFor` refuses to spawn a body we cannot draw. **Parked, with its trigger**: the *rest* of the
`assign_innates` roster — drider, wood elf, deva, eladrin, tiefling, both gith, pillithid, lich,
both vampires, phantom, angel, dragonkin, beholder, illithid, wraith, shadow, spectre, undead and
the void and ice elementals, all with bases in the same property block — joins the map **when the
art set can draw one of them**, since a resistant race that cannot spawn is a row nobody can test.
One caution recorded for that day: `RACE_BEHOLDERKIN` is granted MR at **level 51**
(`innates.c:772`), the only level-gated grant in the list, and our function has no notion of when an
innate arrives.

_Resolved 2026-08-08, in its own pass: `attacks.ts`'s `RACE_ATTACK` (`attacks.ts:210`) is now measured
against the fourth-column vocabulary it always claimed to use. 24 of its 39 codes named the wrong race
or none at all — the same class of error this section's own fourth point found in
`MAGIC_RESISTANT_RACES`, and some of the very same mistakes: `QU` for quadruped, which is `AE`; `BE`
for beholder, which is `BH`; `DR`/`DL` for dragon and dracolich, where `DR` is the **drider**'s own
code and dracolich is `UD`. Beyond the three this note named: `PI` for "the illithid's tentacles" is
the **planetbound** illithid, not the plain one `GetFormType` actually cases on (`MF`); `TR` and `GO`
duplicated troll and golem where the table already had them right; primate and firbolg had no code at
all (`AA`, `FB`); and `AE` itself — wrongly `crush`, standing in for air elemental — moves to its
rightful `thrash`, since the code is the quadruped's own. Fourteen of the thirty-nine were already
correct and are untouched. Cosmetic either way, exactly as this note said: `spriteFor` draws a body for
only thirteen humanoid race codes, and none of the codes gone or added are among them — the fix changes
no swing a player has ever seen. `attacks.test.ts` pins the four codes this note itself named, and the
table's own header comment carries the full accounting._

## 7. Ground casting is dead code; concentration is live, and it is the one to adopt

**Decided: adopt `concentration`; drop `ground casting` by name.**

`cast_common_generic` revalidates once a second, and a caster who has lost their feet gets one chance
(`sparser.c:1223-1234`):

```c
IS_SET(ch->specials.affected_by2, AFF2_CASTING) && !IS_SET(skills[spl].targets, TAR_NOCOMBAT) &&
  ((number(0, 100) < (int)(GET_CHAR_SKILL(ch, SKILL_GROUND_CASTING) / 2)) ||
   (number(0, 120) < (int)(GET_CHAR_SKILL(ch, SKILL_CONCENTRATION) / 2)))
```

**The first half never fires.** `SKILL_GROUND_CASTING` is `#define`d (`spells.h:946`) and read here —
and its `SKILL_CREATE` plus its one `SKILL_ADD(CLASS_SORCERER, 41, 100)` sit inside a `/* */` at
`skills.c:354-357`. It is never registered, so it has no name, no category and no `maxlearn`,
`GET_LVL_FOR_SKILL` returns 0, `update_skills` zeroes it, and `number(0, 100) < 0` is false for every
character in the game. **This is `DESIGN-skills.md` §0's weapon-skill finding in a second place**, and
it is why the roadmap's inherited phrase "ground-casting and concentration skills" names one skill and
one ghost.

**`SKILL_CONCENTRATION` is real** — `SKILL_CREATE("concentration", SKILL_CONCENTRATION, TAR_MENTAL)`
(`skills.c:3954`), granted at level 1 with a ceiling of 100 to bard, psionicist, cleric, conjurer,
summoner, druid, blighter, necromancer, shaman, ethermancer and sorcerer. **Every full caster and no
half-caster** — so on our nine that is Cleric, Druid, Shaman, Sorcerer and Necromancer, and a paladin
who gets bashed loses the spell.

**What it gates**: exactly the row `DESIGN-spells.md` §2.4 parked. Bash already knocks a caster down
and the knockdown already ends the cast plainly; this is the roll that sometimes saves it. It applies
to **sitting and kneeling only** — prone is *"Standing would be a good first step"* — and never to a
`TAR_NOCOMBAT` spell.

**Why it is the right next skill rather than a nice one.** `SKILL_CATEGORIES` has had a `mental`
member since Phase 19 shipped, with its own ten-minute cooldown and **zero skills in it**
(`shared/src/skills.ts:61-73, 123-139` — all fifteen are `physical`). §2 of that note argued the
category had to exist from the start "because a cooldown shared by everything would make the
two-category design unobservable". Concentration is the first thing that observes it.

**The arithmetic, and `DESIGN-progression.md` §1 a third time.** The roll is the source's own:
`number(0, 120) < learned / 2` — half the percentage against a d121, keeping the off-by-one that makes
even a perfect score fail, exactly as Phase 19 kept `number(1, 101)`. On our 0–95 scale with the 40%
floor that is 16.5% for a level-27 caster and 39% at the ceiling. No conversion is needed because the
skill is already a percentage on both sides; only the *ceiling* is ours (95, `ceilingFor`).

**One thing the source does not have and we need**: a notch site. `notch_skill(ch,
SKILL_GROUND_CASTING, get_property("skill.notch.groundCasting", 60))` is **commented out** on the line
above the check (`sparser.c:1226`), so the shipped game never teaches it. Ours should notch on the
*save* — you learn from the cast you kept — which is `rescue`'s own shape (`DESIGN-skills.md` §8.4).

**Changes**: `SKILLS` and `SkillId` (`shared/src/skills.ts:123-139`) gain `concentration`, category
`mental`; `CLASSES` (`classes.ts:77`) grows the per-group ceiling row that Phase 21 slice 4 built for
the physical skills; the once-per-second revalidation in the cast pass (`server/src/index.ts`, the
`cast` scheduler case) gains the roll before it cancels; `ceilingFor` is untouched.

## 8. Slices, in order

Each is driveable on its own, and slices 1 and 2 are a pair — the table without the timer is a caster
who never refills, and the timer without the table is a caster with nothing to refill.

1. **The class owns the circle.** §3: `Spell.circle` off, `CharClass.spells` becomes a map,
   `opensAt` deleted, `circleAt` loses an argument. No behaviour change except the paladin opening at
   6 and the druid's earthquake moving to 21, both of which the tests should assert. The mandatory
   first commit, because §2 and §1 both index on a circle and doing it after means doing it twice.
2. **The table and the timer, together.** §2's `SetSpellCircles` transcription and §1's
   `memoriseMs`, plus highest-circle-first, the posture gate, commune-walks-and-refills, and the
   empty new circle. *Seen when*: a level-5 cleric has six castings instead of two, spends them,
   sits, rests, and gets one back in eleven seconds — and a level-5 ranger gets theirs back while
   walking.
3. ~~**The three divergences.**~~ **Done, 2026-08-08** — and it was four, not three; §6's "Resolved"
   block is the record. `shrugChance` reads live racial bases from the map that replaced
   `MAGIC_RESISTANT_RACES`; `'PD'` is out, with damage reduction parked behind the ward stack;
   `ICE_STORM_MIN_CHANCE` is the live 0; and four mob codes that named no race are corrected. A
   level-30 drow went from 5% to 17%. **Landed out of order, ahead of slices 1 and 2** — it touches
   no circle, so it does not owe them anything.
4. **Concentration.** §7: the first mental skill, the roll on knockdown, the notch on the save.
   *Seen when*: a bashed cleric sometimes keeps the spell, and `skills` shows a second cooldown.
5. **The elite penetration branch.** §6: `shrugChance` takes a caster, an elite or greater-race NPC
   substitutes its level, and the drow who has been shrugging everything finally meets something that
   does not care.

**Staged behind a trigger, not a date** — each with the condition written down so nobody builds it
early or forgets it: the **per-spell memorize queue** when a class list passes twelve spells (§1); the
**globes** with the first globe spell in the registry (§6); the **mana branch** if a psionicist or an
illithid race is ever wanted (§5).

**The checklist**, for the session that implements this:

| File | What changes |
| --- | --- |
| `shared/src/spells.ts` | `Spell.circle` removed; `MAGIC_RESISTANT_RACES`; `shrugChance` (racial base, caster penetration); `ICE_STORM_MIN_CHANCE` |
| `shared/src/classes.ts` | `CharClass.spells`, `CharClass.casting.opensAt` (deleted), `circleAt`, `circleOpensAt` (deleted), `slotsForCircle`, `knownSpells`, `knowsSpell`, `maxManaFor` (§5's honesty item) |
| `shared/src/skills.ts` | `SKILLS` gains `concentration` (`mental`) |
| new, in `shared` | `SetSpellCircles` transcription + `memoriseMs`, with the §1 and §2 tables as their tests |
| `server/src/index.ts` | `MEMORIZE_SLOT_MS:1018` (deleted), the memorization pass at `9203`, `castClassSpell:3657`, `completeCast:4182`, `listSpells:6782`, the `cast` scheduler case (§7's roll) |
| `server/src/sim.ts` | `Player.memorizeMs:426` — same field, per-circle target |
| `server/src/players.ts` | untouched: `spentSlots` keeps its shape, so there is no migration |

## 9. Explicitly not in this note

Spellbooks, pens, pages, `scribe`, `teach` and the guildhall library (§4); the per-spell memorize
queue and the `memorize <spell>` verb (§1); the psionicist, `will`, mana as a cost, Spatial Focus and
Advanced Meditation (§5); `AFF_MEDITATE` and the meditate skill that halves every timer; the druid's
terrain and alignment memtime modifiers and `balance_align`; multiclassing's ×1.75 and the whole
secondary-class circle fallback; specialisations (`rlevel[spec]`, `maxlearn[spec]`) and therefore
spec-only spells; `SKILL_DEVOTION`'s free-casting refund; epic skills, and with them spell penetration
as a *player* skill (§6 keeps only the NPC branch); the four globes until there is a globe spell (§6);
`INNATE_SPELL_ABSORB`'s slot refund; the harpy `tupor` and undead `assimilate` economies and every
class that reads them; `forget`; and casting circles above 6, which our level band cannot reach.
