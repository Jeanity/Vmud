# Spells — Phase 20's design note

_Written 2026-08-07, before any code, the way `DESIGN-skills.md` was: the research turned up enough
places where the shipped source disagrees with genre memory — and with our own roadmap's wording —
that starting cold would have transcribed the wrong game. Six readers over ~900 KB of magic source
(`sparser.c`, `magic.c`, `memorize.c`, `skills.c`, `utility.c`, `innates.c`, `fight.c`); every claim
below carries its citation._

## 0. What the shipped source actually runs

The finding that shaped Phase 19 shapes this phase harder: **Duris' magic system is full of dead
branches, and the live ones are not the famous ones.**

1. **Memorization won; mana lost.** `do_cast` *refuses* mana users outright — psionicists are told
   *"Psionicists use the command will"* (`sparser.c:2200-2204`) — and `memorize.c:694-704` carries
   the note *"reverting psionicist to use mana"* over commented-out psionicist memorization. Every
   class that types `cast` spends either a **memorized copy** of the spell (a `TAG_MEMORIZE` affect,
   flipped un-full and re-queued on use, `memorize.c:1897-1930`) or a **per-circle slot** from an
   auto-refilling pool (`undead_spell_slots[]` — named for undead, live for druids, rangers, angels,
   harpies and ethermancers too, `utils.h:803-818`). Mana is a one-family carve-out costing
   `circle × 7`, whose own comment thinks it is for mobs (`config.h:68`) and whose overdraw
   punishment is commented out (`sparser.c:2883-2893`).
2. **Damage does not interrupt casting.** There is no concentration-on-damage roll anywhere in the
   live paths. What kills a cast: a **forced room exit** (`char_from_room` calls `StopCasting`
   unconditionally, `handler.c:1007`), **losing your feet** (the once-per-second revalidation
   requires standing, with a ground-casting skill roll to survive sitting/kneeling,
   `sparser.c:1223-1318`), **stun, silence, paralysis**, and a short roster of *specific* skill
   procs (anatomy strike, disruptive blow, garrote — each an isolated `StopCasting` call site).
   **Bash never calls StopCasting** — it sets `POS_SITTING` and lets the next one-second check
   decide (`actoff.c:6515`). Our bash already knocks down; the composition is free.
3. **Casting owns the caster.** While `AFF2_CASTING` is set the interpreter blocks every command
   (*"You're busy spellcasting!"*, `interp.c:1440-1467`) and `perform_violence` skips the caster's
   auto-attacks entirely (`fight.c:9616-9619`). A caster is a held piece, which is the whole
   tactical texture of the phase.
4. **Interruption is free.** Cost is paid at *completion* (`use_spell` runs only when the wind-up
   finishes), so breaking a cast loses time, never the spell — with one deliberate quirk kept:
   `use_spell` runs *before* the final target-validity check, so completing against a vanished
   target pays and then fizzles (`sparser.c:2612-2656`). Authentic; do not "fix" it.
5. **Fireball is not an area spell.** `skills.c:933` registers it single-target-rangeable. The room
   spells are `TAR_AREA`/`TAR_OFFAREA` — ice storm, earthquake, chain lightning, meteor swarm. Genre
   memory is wrong here and the roadmap's poster child with it.
6. **"Crowd thinning" thins players only.** The live `cast_as_damage_area` counts *PC* victims,
   rolls a hit count around `pc_count/2 + 5/pc_count`, floors it at `min_chance%` of PCs, and nulls
   the excess — never the named target, never any NPC (`utility.c:5961-5985`). A room of thirty
   mobs takes thirty full hits. The decaying-chance algorithm the property names describe is
   commented out; `chance_step` is fetched at ~25 call sites and read by none.
7. **Mob magic is its own machine.** `MobCastSpell` (`mobact.c:542-784`) never touches `do_cast`:
   it sets the casting state directly, checks slots directly, rolls quick-chant by level, and at
   level ≥ 60 casts *instantly*. Mob area spells cannot hit other mobs (`utility.c:5791-5792`).
   Transcribe the shortcut, not the player path — the feel of fighting a caster depends on it.
8. **`recite` is a live, classless casting path.** Scrolls cast up to three stored spells at the
   scroll's level with **no class, mana, or memorization check**, destroying the scroll
   (`actoth.c:4166-4260`). This is the finding the build order turns on — see §2.

## 1. The two gates

Both real, both live, genuinely independent — and composed in **two different orders** by
convention (`magic.c:3045-3051` vs `7050-7080`):

- **The save** (`NewSaves`/`find_save`, `sparser.c:1034-1161`): a *failure percentage*, linear in
  level from a data-driven 70 down to 20 over 60 levels, five save types, race/class adjustments,
  clamped 1–99 so both ends always have a 1% surprise. **Every modifier is silently ×5** — the
  scale changed and the call sites did not (`sparser.c:1142`); transcribe the multiplier or ship
  saves five times too weak. The standard offensive mod is level-difference bounded ±3 below
  circle 7 (`get_default_save_mod`). Save-for-half exists in *two inverse spellings* — fireball
  doubles on a failed save, prismatic ray halves on a made one — so a spell's dice are only
  meaningful beside its convention.
- **The shrug** (`resists_spell`, `innates.c:3722-3812`): a flat all-or-nothing percentage, rolled
  only for victims with `INNATE_MAGIC_RESISTANCE` (a race list plus one class), floored at 5%,
  bypassed for self-casts and consent, pierced only by an epic skill. **Damage spells roll
  save-then-shrug; effect spells roll shrug-then-save.** Keep both orders; merging them breaks the
  documented case where a save-proof cast is still shrugged (`magic.c:7073-7080`).

Spell damage does **not** ride the melee path: `spell_damage` is its own gauntlet (globes, wards,
deflect — all deferrable layers) converging on the same bottom (`raw_damage`). Ours converges on
`landBlow`, whose header has named this phase since slice 3.

## 2. The decisions

1. **Cost waits for classes; scrolls and mobs carry the phase.** Transcribing the memorization
   economy now would build slots, mem queues and INT-driven timers for a world where every
   character is `CLASS_NONE` and the class tables that give the system meaning arrive in Phase 21.
   The source itself offers the honest interim: **`recite`**, the classless path that already
   exists, costing exactly one consumed item — an economy we already have. So Phase 20 ships the
   *machinery* (wind-up, interruption, gates, areas, both damage/heal seams), **mob casters** make
   it visible everywhere shamans already stand, and **scrolls** put it in players' hands. The
   memorization system lands with Phase 21 as *the class economy*, exactly as `maxlearn` waits
   there for skills. Mana stays a prop until the psionicist family exists, if it ever does.
2. **The scheduler restructure is slice 1, alone.** The codebase's single `scheduler.advance()`
   call sits inside `advanceCombat` and **discards every non-`swing` event**
   (`combat.ts:742-743`). A `cast` event scheduled today would pop there and vanish. Hoisting the
   advance to the tick and dispatching by kind is the `landBlow` extraction again: one commit, no
   behaviour change, the whole suite as proof — and Phase 20 cannot start until it lands.
3. **The wind-up is an affect.** `SelfView.affects` already renders rows with live countdowns, so
   the caster's own progress bar costs zero client work; the source's per-second star meter maps
   to the affect's remaining time. The *room's* view of a wind-up is an `act()` line at cast start
   ("X begins casting…") — `EntityView` carries no affects by design, and a full visible-states
   field is its own row, not this phase's.
4. **The interruption set is the source's, minus what we lack.** Forced exit interrupts (flee,
   teleport, current); knockdown interrupts through the once-per-second revalidation *unless* a
   concentration-style roll saves it — but we have no ground-casting skill yet, so the first
   version knocks the cast out plainly and the skill arrives as its own later row; stun interrupts;
   damage does **not**. The max-circle agility abort is dropped-and-named: no ability scores.
   Interruption costs nothing, pay-then-fizzle kept.
5. **Both reserved outcomes get their producers; one reservation was never made.**
   `attackResolved` has carried `'absorbed'` and `'resisted'` since Phase 11; the shrug produces
   `'resisted'`, stone skin's pool produces `'absorbed'`. The roadmap's promised `'casting'`
   outcome **does not exist on the wire** — the wind-up announcement is a log line and an affect,
   not an attack outcome, and the roadmap row should be corrected rather than the vocabulary grown.
6. **Numbers ride data files where the source kept them in properties.** Base saves (70/20), race
   save adjustments and shrug percentages are runtime properties in Duris — the C alone cannot say
   what a drow shrugs. Ours land beside the other tuned tables in `shared`, one catalogue, with
   the property names recorded beside each number.

## 3. The first spell list

Verified live handlers, dice cited, chosen for a level-1-to-30 warriors-plus-scrolls world
(`skills.c` registrations; `magic.c` handlers):

| Spell | Circle | Shape | Notes |
| --- | --- | --- | --- |
| magic missile | 1 | 1–5 bolts, `d4×4 + 1..level` each | no save; each bolt shrugs separately |
| burning hands | 2 | `dice(level/10+5, 6) × 4` fire | no save |
| chill touch | 2 | `dice(1,6) + 20 + level` cold | doubles on failed save; the precedence quirk is the number |
| shocking grasp | 3 | `dice(level/6+5, 6) × 4` lightning | **doubles on failed save** |
| cure light | 1 | heals `2..10` | first `joinBySupporting` producer |
| cure serious | 2 | heals `dice(3,8)` | |
| armor | 1 | AC affect, 20 ticks | new `ac` ApplyLocation |
| bless | 1 | +hit, +saves | `TAR_NOCOMBAT` |
| stone skin | 6 | absorb pool `level/4 + 1d4` | `'absorbed'`'s producer |
| earthquake | 3 | area, `dice(1,30)+level` + knockdown | bespoke loop; the one first-slice area spell |
| continual light | 6/2 | lights an item or the room | meets Phase 5's light system head-on |

Fireball and ice storm are cheap follow-ons once the gates and the area loop exist.

## 4. Build order

1. **The scheduler learns kinds.** Hoist `advance()` out of `advanceCombat`, dispatch by kind, no
   behaviour change, suite as proof. (Also reconcile the notch NoShow contradiction and correct the
   two stale roadmap claims — corpse decay's scheduler line, the `'casting'` outcome — while in
   those files, before this phase copies the wrong precedent.)
2. **The wind-up.** `cast` state as a shown affect; command lockout; auto-attack suppression;
   per-second revalidation; the interruption set; free interruption. Driven with a dev-rig spell
   before any real one: *Seen when* is a wind-up with stars that a bash can break.
3. **The gates + the first nukes.** `NewSaves`/`resists_spell` as data; `spell_damage`-lite through
   `landBlow`; `'resisted'` on the wire; magic missile through shocking grasp, cast by **mob
   shamans** via the `MobCastSpell` shortcut. The Kobold Settlement's shaman finally deserves its
   name.
4. **Scrolls.** Harvest `ITEM_SCROLL` (stored level + up to three spell ids), `recite` with the
   source's own no-gate rule, scroll consumption. Players cast for the first time.
5. **Heals and buffs.** `joinBySupporting` + `THREAT_PER_HEAL` get their producers; the affect
   registry grows `ac`/`hit`/`saves` locations with readers; the group roster's exact-pools
   protocol change lands with the first aimable heal.
6. **Areas.** `cast_as_damage_area` + `should_area_hit` + player-count thinning (the corrected
   name); earthquake first, ice storm after; mob-area-cannot-hit-mobs kept.

What Phase 21 inherits, recorded now: the memorization economy (slots, mem times, `spl_table`),
class circle tables, spellbooks and scribing, the psionicist question, ground-casting and
concentration skills, spell penetration, globes and the modifier stack.
