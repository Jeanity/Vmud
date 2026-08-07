# Skills — the decisions Phase 19 cannot be started without

_2026-08-06. Written before any code, the way `DESIGN-zone-geometry.md` was written before A8, and for
the same reason: three of the six decisions below turn on **which branch of the source is actually
compiled**, and getting that wrong would produce a phase that looks transcribed and is not. **Slice 1
then landed the same day** and corrected two things in here — §0 gained a third finding and §4 changed
which skills exist because of it, which is the note earning its keep rather than failing._

`ROADMAP.md` Phase 19 is one sentence — *"percentages notched by use, per-category rate limits, a
level-driven floor; mobs derive proficiency from level and store nothing"* — and its **Seen when** is
*"a skill percentage rises because you used it."* Everything here serves that.

---

## 0. Three things are wired to code the shipped source does not compile

All three were found by grepping for the `#if` guards rather than by reading the functions, and each
changes what "transcribed from the source" means for this phase.

**`NEW_COMBAT` is defined** (`new_combat_def.h:2`). So `fight.c`'s combat — including
`required_weapon_skill`, `WeaponSkill` and the `chance_to_hit` path — sits inside `#ifndef NEW_COMBAT`
and **is compiled out**. The live combat is `new_combat.c` / `new_combat_util.c`, 6,377 lines of it.
`REFERENCE-mud-mechanics.md` §2 describes the hit roll from the dead branch, and §1.6's *"NPC
proficiency is `BOUNDED(0, level << 1, class_ceiling)`"* is the dead branch's formula too. The
reference is not wrong about the *shape* of anything; it is citing the wrong file for the arithmetic,
and this note supersedes it for skills. **Fix §1.6 and §2's citations when this phase lands.**

**And the live scheme's skills do not exist.** Found while writing the code, and it is the finding that
decided §4: `getWeaponSkillNumb` returns `SKILL_LONGSWORD`, `SKILL_DAGGER` and sixteen more, and **every
one of those ids appears exactly once in the whole source — as that function's return value.** None is
ever `SKILL_CREATE`d, so none has a name, a category or a `maxlearn`; `GET_LVL_FOR_SKILL` therefore
returns 0, `update_skills` zeroes both `learned` and `taught`, and the live combat's weapon-skill
contribution is **0 for every player character in the shipped game**, with `notch_skill` refusing at its
first branch (`l >= t` → `0 >= 0`). The eight **damage-class** skills the *dead* path uses are the ones
that are fully registered, with names, `TAR_PHYS` and per-class ceiling tables. Duris has two weapon-skill
schemes and they are wired to each other's opposite.

**`wipe2011` is defined nowhere.** `guild.c:183–233` is `#if wipe2011`, and it contains the whole of
the interesting behaviour: the intelligence bonus, the `level * 2.5 + 5` cap, the diminishing curve
`chance -= chance * learned / taught`, and — the important one — the **only two readers in the entire
source** of `TAG_PHYS_SKILL_NOTCH` and `TAG_MENTAL_SKILL_NOTCH`. As shipped, `notch_skill` sets the
cooldown affect and *nothing ever looks at it*. So the roadmap's "per-category rate limits" describes
an intention that the shipped game does not enforce. Decision 2 is what we do about that.

---

## 1. A skill is a percentage with a ceiling above it and a floor under it

`struct char_skill_data { byte learned; byte taught; }`, one per skill. `learned` is proficiency 0–100;
`taught` is the ceiling this character's class and specialisation allow. `update_skills` (`guild.c:57`)
runs the floor:

```
minlearn = MIN(40, (3 * level) / 2)
```

and drags **both** `taught` and `learned` up to it. That second half is the one to keep: a fresh
level-30 character is *functional for free* at 40%, and everything above 40 must be earned. It also
means the floor, not the grind, is what makes a character competent — the grind is what makes them
better than competent. At level 27 the floor caps out; below that it is `1.5` per level.

**We take this exactly**, including that it applies at every level gain rather than only at creation —
with one divergence the implementation forced and it is worth stating precisely. Duris **writes** the
floor into `learned`, so a character who loses a level keeps the higher number; we **derive** it
(`learnedAt` takes the maximum of the floor and what is stored), which is what lets storage be sparse and
a level-up cost no writes at all. The two differ only below level 27, where a lost level costs 1.5% of
every unpractised skill — consistent with Phase 14b, where a lost level costs what a level is worth.

## 2. The rate limit: we adopt the compiled-out branch, deliberately

The shipped notch is a bare roll — `number(1, 10000) > chance * 100`, so `chance` is a percentage —
and then the cooldown affect is written for 5 minutes (physical) or 10 (mental) and never read.

Measured against the live notch sites, that is a very fast grind. In `new_combat.c:2064–2077` a
landing blow notches the weapon skill on a **1-in-5 gate at 33.33% chance**, so ~6.7% of hits; at a 3 s
round that is a notch roughly every 45 seconds of continuous fighting, and **0 → 100 in about 25
minutes**. A number you can max in one sitting is decorative.

So we implement `#if wipe2011`'s two rules, which are the source's own later thinking and carry a
comment explaining the first of them (*"Instead of simply not allowing notches, we just make it
harder"*):

- **On cooldown, `chance / 4`** rather than refused. A player who keeps fighting is not stopped, they
  are slowed — which is the difference between a rate limit and a punishment.
- **`chance × (1 − learned / ceiling)`**, so the last ten points cost more than the first fifty and the
  ceiling is approached rather than arrived at. This is also what leaves room for `practice` to exist
  later (Duris' teachers cost gold and stop well short of the ceiling), without practice being the only
  way up.

**Recorded as a divergence in the code**, in the same words as the `do_junk` level column and V6's
craftsmanship: the source contains this and does not run it, and we are choosing to run it.

The two categories come from the skill table itself — `SKILL_CREATE("swim", SKILL_SWIM, TAR_PHYS)` —
so a skill's category is data, not a rule, and **every skill this phase's first slice touches is
`TAR_PHYS`**. The mental category exists from the start anyway, because a cooldown shared by
everything would make the two-category design unobservable and then unbuildable later.

## 3. The ceiling, with no classes to ask

`taught` is `maxlearn[spec]` per class per skill — and classes are **Phase 21**. Three options were
weighed and only one keeps the phase honest:

- Ceiling 100 for everyone: the floor and the curve both stop meaning anything at the top, and every
  character is identical at max.
- No ceiling at all: `notch_skill`'s first branch (`learned >= taught`) is the thing that stops a
  notch, and removing it means rewriting the function when Phase 21 arrives.
- **One ceiling for everyone, read through a single function.** Chosen. `ceilingFor(skill, character)`
  returns 95 today and consults a class table the day there is one — so Phase 21 replaces one body and
  no caller.

**95, not 100**, because Duris' practice stops short of the ceiling and the top of a skill should be
somewhere the game can later put a teacher, a quest or a class specialisation. A ceiling reached by
grinding alone leaves nothing for any of them.

## 4. Which skills exist: the eight damage classes, not the eighteen weapon shapes

The two schemes are described in §0. We take `required_weapon_skill`'s (`fight.c:6896`) — 1h and 2h ×
slashing / piercing / bludgeon / flaying, plus **reach weapons** for a two-handed spear, trident or
polearm, plus **unarmed** for bare hands. Nine in all, and the reasons are cumulative:

- They are **the only weapon skills the source defines**. The per-type ids have no name, no category and
  no ceiling — transcribing them would faithfully reproduce a mechanism that does nothing.
- Their **ceiling table is real data** (warrior 100, ranger 100, bard 90, assassin 85, ethermancer 70 …),
  which is exactly what {@link ceilingFor} grows into at Phase 21.
- **Nine categories is a shape a player can hold in their head** where eighteen weapon shapes is a
  spreadsheet — and a *category* of weapon as your proficiency is the SRD's own instinct too.

Measured over all 2,841 harvested weapons:

| Skill | Weapons | | Skill | Weapons |
| --- | --- | --- | --- | --- |
| 1h slashing | 851 | | 1h flaying | 128 |
| 1h piercing | 728 | | reach weapons | 81 |
| 1h bludgeon | 571 | | 2h flaying | 7 |
| 2h slashing | 310 | | *(no skill)* | 7 |
| 2h bludgeon | 158 | | | |

Three skills cover **76%** of the world, which is why a player realistically has a main and a sideline.
The seven with no skill are six weapons carrying no class at all and **one two-handed dagger**, which
`required_weapon_skill` refuses after writing a builder-error log line — both get no skill rather than a
wrong one, and swing perfectly well without one.

**One deliberate divergence, toward our own consistency.** Duris asks `IS_SET(extra_flags, ITEM_TWOHANDS)`
here while `wield` asks its *other* question, `flag || class == WEAPON_2HANDSWORD` — and those disagree
about **22 two-handed swords that carry no flag**. We use the disjunction in both places, so which hand a
weapon takes and which skill it trains can never disagree; a greatsword that needed both hands and trained
the one-handed skill would be indefensible in a way the source's own inconsistency is not.

**Two things our data did not have.** `ItemTemplate` and `Item` now carry `weaponClass` — worldgen has read
`values[0]` since the harvest landed (for the two-handed disjunction) and kept nothing, and this gives it a
reader. And the **four starter weapons** carry a class of their own, chosen from the names they already
have (dagger 2, shortsword 9, club 10, hand axe 1): without it a fresh character's entire first level
would train nothing, because a synthesised item has no `.obj` file to read a class from.

## 5. A percentage meeting a d20, and the arithmetic is not a choice

Duris' contribution is one line: `getChartoHitSkillMod(wpn_skl_lvl) { return wpn_skl_lvl >> 1; }` —
**half the skill percentage, added to a to-hit total that is rolled against `number(1, 100)`**. Ours is
SRD: `d20 + attackBonus` against AC. Converting is division, not invention:

```
half of 0..95 on a 100-point scale  =  0..47 points of 100
0..47 of 100 scaled to a d20        =  0..9        →  floor(learned / 10)
```

So **weapon skill contributes `floor(learned / 10)` to the attack bonus**, +0 to +9.

The floor is what keeps that from being wild. Everyone at level 27+ starts at 40% for free, which is
`+4` that costs nothing, so the *earned* spread between a novice and a master of the same level is at
most **+5** — squarely SRD-shaped, and the same size as the proficiency bonus it resembles. Below level
6 the floor is under 10, so a level-1 character gets `+0` or `+1`, which leaves 14b's calibration of
that band alone. **It still wants the measurement `DESIGN-progression.md` §8 made for damage** — rounds
to kill, before and after, at levels 1, 15 and 30 — before the slice is called done.

## 6. Mobs store nothing, and the live formula is class-scaled

`getNPCweaponSkillLevel` (`new_combat_util.c:905`), the live one: `level × 2.0` for warriors down to
`level × 1.2` for mages, capped at 100, plus small per-class bonuses for a rogue with a dagger and a
mage with a staff. **`CLASS_NONE` is `level × 1.75`** — and `CLASS_NONE` is what every mob in our world
is, because we have no classes. So:

```
mobWeaponSkill(level) = min(100, floor(level * 1.75))
```

Zero bytes per mob, exactly as §1.6 says, and one function to grow a class table into at Phase 21
alongside `ceilingFor`. Note this is **not** the `level << 1` our reference doc quotes — that is the
dead branch again, and the difference is real: a level-30 mob is 52% rather than 60%.

## 7. Storage: sparse, with a reader line

A character's skills persist. The rule from the gotchas applies in full — *every field of a persisted
shape needs a reader line and a whole-value round-trip test* — and one shape decision comes with it:

**Store only skills whose `learned` has moved off the floor.** The floor is a pure function of level, so
a character who has never swung an axe has an axe skill that is derivable and does not need a row; an
absent skill reads as "at the floor", the same rule `SelfView.bag` follows for an empty bag and
`PlayerStore.save` for default capacity. That keeps a level-1 character's record unchanged by this
phase, which is also how the migration is free.

---

## 8. Build order

Each slice is driveable on its own, and the first cannot break anything that exists.

1. **Skills exist and combat notches them** ✅ **done 2026-08-06.** `weaponClass` harvested and carried
   onto the instance; `shared/src/skills.ts`; per-character `learned`, sparse and persisted; the notch on
   a landing blow through the sim's seeded RNG; the two cooldowns as ordinary Phase 5b affects, **saved**
   so a reconnect is not a way to grind; a `skills` command; and `floor(learned / 10)` folded into
   `refitCombat`, which was already the one seam every kit change passes through.
   **Driven live:** at level 5 every skill read 7% (the floor), seven landing blows later *"You feel your
   skill in 1h slashing improving"* and that row alone read **8%** with its floor marker gone, the
   cooldown said so in the `skills` output, and the save file held `{"slashing-1h": 8}` plus a surviving
   `notch_physical` — one row, because the other eight were exactly what the level already gave.
   **The bonus was read straight out of the combat log**, where `[d20 natural → total]` makes it
   arithmetic: **+19 at level 30** (15 from the level, **+4** from the 40% floor) against **+2 at level
   1** (2 + **0**) — §5's claim that the bottom band 14b calibrated is untouched, observed rather than
   argued.
2. **Being attacked teaches you too** ✅ **done 2026-08-06** — `dodge` and `parry`, notched on the
   defender (17 and 25). This entry was right that it is a combat change rather than a skill one: the
   rolls are an **active second gate** that fires only once the to-hit has already beaten the armour
   class, exactly as `new_combat.c` runs them inside the branch the to-hit won. Dodge first, parry only
   if the dodge failed, and the notch attaches to whichever failed you — on the source's own coin flip,
   so you learn from the blow that got through rather than from the one you avoided. **Parry needs a
   weapon** (`getCharParryVal` returns 0 without one) and is half the parry skill, half the skill of the
   thing in your hand. Four things the build found that this entry did not raise: the crowd penalty's
   `else` **charges a lone attacker 14%**, because the chain is `if`/`else if`/`else` and being attacked
   at all is the default case; the critical bonus is added **after** the modifiers and not before, which
   a test caught; `number(1, 101)` means even a perfect score fails one time in 101; and **`DODGE_CAP` is
   unreachable** — the arithmetic ceiling is 50, and the 60 exists for the drow/halfling doubling we have
   no races for. Dropped and named: ability scores, size, haste/slow, terrain, riposte.
3. **`bash` and `kick`** ✅ **done 2026-08-06** — the first skills with verbs of their own, and the crux
   was not the verbs. Researched, written up, and then built in two commits: the seam, then the abilities.

   **What the source gives, transcribed.** Both are `CMD_Y(… STAT_NORMAL + POS_STANDING …)`: on your
   feet, allowed mid-fight. `chance_kick` (`actoff.c`) is the **skill percentage itself**, scaled by
   `BOUNDED(80, DEX, 125) / 100` — we have no ability scores, so the scaling is dropped and named as
   dropped. Kick damage is `MAX(STR/2, martial_arts) + kick_skill`, then `number(dam/2, dam)`; bash's is
   `MAX(1, dam)`, which says what bash is *for* — the knockdown, not the damage. **Bash sits the victim
   down** (`SET_POS(victim, POS_SITTING + GET_STAT(victim))`) and lags them a round (`CharWait(victim,
   PULSE_VIOLENCE)`), while the basher takes a `SKILL_BASH` self-affect for **two** rounds that blocks a
   follow-up kick — *"you haven't reoriented yourself yet enough for another kick"*. Kick lags its user
   `PULSE_VIOLENCE * 3/2 ± 1s`. **One quirk worth keeping**: the hit test is
   `if (!notch_skill(...) && (chance < number(1,100) || …))`, so **a successful notch forces the blow to
   land**. Learning something and landing it are the same event.

   **Three of the four pieces already exist.** A knocked-down body stays down because `canMove` is the
   gate (the handoff says so). "Lag" is `scheduler.cancel(id, 'swing')` plus a fresh `schedule` — exactly
   what `engage` does to make an opening blow wait a round. And the notch is slice 1's, unchanged.

   **The missing piece is a shared way to land a blow, and it is the whole slice.** Damage application,
   the contribution ledger, the threat table and death are all *inside* `advanceCombat`'s swing loop:
   `swing` clamps to `HP_DEAD_BELOW - 1`, the loop records the ledger and threat, and `deaths` is
   collected for `resolveDeath`. An ability that applied damage itself would be a **second damage path** —
   which is how a mob ends up dying without paying experience, or a bash that kills leaving no corpse. So
   the first commit of this slice is extracting `landBlow(...)` from that loop and having the swing use
   it, with **no behaviour change and the existing combat tests as the proof**. Then the abilities are
   small.

   **Phase 20 needs the same seam**, which is the argument for extracting it properly rather than
   threading an ability through the loop: a spell that does damage is the same question with a different
   verb, and `DESIGN-progression.md` §8's calibration is what both have to stay inside.

   **What shipped.** `landBlow` came out of the swing loop first, with no behaviour change and the whole
   suite as its proof; then `abilities.ts` (the two abilities as data), two skills, two commands and one
   handler. The lag is an **affect** rather than a scheduler entry, which is what the source does
   (`set_short_affected_by(ch, SKILL_BASH, 2 * PULSE_VIOLENCE)`) and means the player can *see* the
   recovery counting down instead of being told no. The notch was factored so a blow and a verb share it
   at different base chances — two copies would have been two places to forget the `refitCombat` that
   makes a point of skill worth anything. **Driven live**: a veteran (bash 95 from a save file, which also
   proved the persistence round-trip in the running game) bashed the kobold shaman for **11** — `1d4+9` —
   and *"you knock the kobold shaman to the ground!"*; a second ability came back *"you have not recovered
   your balance yet"* with `off balance` on the affect list for six seconds; and once it lapsed the kick
   landed for **12** (`1d6+9`). The drive found one real gap: the knockdown line reached the target and the
   room but not the **basher**, because `actToRoom` excludes the actor — so the one person who did it was
   the only one not told.

   **One scale decision to take before writing damage.** Duris' numbers are on its own 1–100 skill scale
   and ours are SRD: a kick doing `skill` damage would hit for 95 at mastery where a level-30 weapon swing
   does about 25. The established conversion is `floor(learned / 10)` (`toHitFrom`, §5), so a kick of
   `1d6 + floor(learned/10)` and a bash of `1d4 + floor(learned/10)` stay inside the band 14b calibrated —
   but the number wants the same rounds-to-kill measurement §5 asked for, and the alternative worth
   weighing is scaling off the character's own damage bonus instead.
4. **`rescue`** ✅ **built 2026-08-07**, which needs a group — and now has one (Phase 18). Taking a blow
   meant for somebody else is a threat-table operation, and the threat table exists. Two things the
   build settled: the redirect must also seat the rescuer at the rescuee's threat standing, because
   `pickByThreat` re-decides every round and a bare pointer flip hands the mob straight back; and the
   notch roll is `notch_skill(…) || roll > skill` — **backwards from bash and kick's** `!notch && miss` —
   so a successful notch forces the fumble and short-circuits past the success roll. Kept, not tidied.
5. **`swim`** ✅ **built 2026-08-07**, last, because it is not really a skill problem. Phase 16 made deep
   water a wall that says *"you need to swim"*; opening it meant deciding what swimming costs and what
   drowning is, and `specials.c:191` is the only thing the source spends the skill on (a vitality drain
   reduced by `skill / 25`). **The build found that even that is dead**: `swimming_char`'s whole body is
   commented out — the phase's fifth mechanism wired to code the shipped game does not run — and the
   live gate is `ITEM_BOAT`. The owner composed the two: strokes cost terrain plus the dead drain's
   curve, boats exempt the whole swimming bundle, drowning is exhaustion at zero movement (with move
   regen paused while treading, which the drive proved is the rule that makes drowning possible at
   all), and the drowned wash ashore **at their entry shore** — the ferry rule.
