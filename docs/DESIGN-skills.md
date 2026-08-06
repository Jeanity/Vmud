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
2. **Being attacked teaches you too** — `dodge` and `parry`, notched on the defender (17 and 25 in the
   source). Both need a *defence roll* we do not have: our AC is passive, and dodge/parry are an active
   second gate. That is a combat change, not a skill change, and it wants its own slice.
3. **`bash` and `kick`**, the first skills with verbs of their own. Cheaper than they look: the handoff
   already notes that a knocked-down body stays down because `canMove` is the gate, so bash's
   *consequence* is built and what is missing is the roll and the verb.
4. **`rescue`**, which needs a group — and now has one (Phase 18). Taking a blow meant for somebody
   else is a threat-table operation, and the threat table exists.
5. **`swim`**, last, because it is not really a skill problem. Phase 16 made deep water a wall that says
   *"you need to swim"*; opening it means deciding what swimming costs and what drowning is, and
   `specials.c:191` is the only thing the source spends the skill on (a vitality drain reduced by
   `skill / 25`). The skill is the easy half.
