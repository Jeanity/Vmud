# Reference: what a graphical MUD has to reproduce

_Written 2026-07-29 from seven subsystem studies of the **Duris: Land of BloodLust** C source at
`data/zones-source/duris/src/` (228 `.c`, 145 `.h`), cross-checked against this repository as it
stands today._

This is a reference, not a plan. It answers two questions: *how does a MUD of this lineage actually
work?* and *which of those mechanisms do we have?* The second question is the one that earns the
document its place — the mapping in §2 and the per-subsystem status tables are the part to keep
current.

---

## 0. Before anything else: three caveats

**Duris is not TorilMUD.** Sojourn split in 1995; Duris and Toril have diverged for thirty-one
years. `docs/RESEARCH-map-data.md` measured the overlap: only **21% of Toril's 15,536 distinct room
names occur anywhere in Duris**, giving 44 confident zone matches out of 327. Duris is therefore an
authoritative source on *how a MUD of this family is built* and a **partial** source on TorilMUD's
actual content. Every mechanism below is trustworthy as a mechanism. Every *number* below —
`PULSE_VIOLENCE` 16, `exp.death.level.loss` 0.10, ogre Str factor 230 — is a Duris tuning value, not
a TorilMUD one. Do not import them as if they were.

**We have already chosen a different rules backbone.** `CLAUDE.md` says SRD 5e, and
`@mygame/shared/rules` implements it: `resolveAttack` is a d20 against AC with natural-20 crit and
natural-1 fumble. Duris resolves to-hit on a **percentile** scale with AC as an additive percentage
penalty and crit/fumble on a *separate axis entirely*. These are not reconcilable and we are not
going to reconcile them. What transfers from Duris is the **shape** — that defence is an active
layered check owned by the defender, that crit and fumble are a different question from hit and
miss, that a fumble should have physical consequences — not the arithmetic. Where this document
quotes a Duris formula it is to show the shape.

**The source is unlicensed third-party code.** We describe mechanisms and name constants. We do not
copy code, and nothing derived from it ships.

A fourth, smaller correction while we are here: the brief that commissioned this document says the
project has 145 tests. Measured today, `npm test` reports **214 passing** — 95 in `@mygame/shared`,
119 in `@mygame/server`, 0 in `@mygame/worldgen` (which has no test files) and none in the client.

---

## 1. The mental model

A modern game developer arrives with a set of assumptions that are all individually reasonable and
collectively wrong for this genre. Here is the reframing, in the order the assumptions usually bite.

### 1.1 There is no frame. There is a pulse, and it is slow.

Duris runs at `OPT_USEC = 250000` — **four pulses per second**. Every timed thing in the game is
counted in pulses: `PULSE_VIOLENCE` is 16 pulses (4 s), `PULSE_MOBILE` is 30 (7.5 s),
`PULSES_IN_TICK` is 300 (75 s, one MUD hour). A tick is not a frame; it is an *hour of game time*.

The consequence is that a MUD's simulation is **event-scheduled, not polled**. There is no
`for (entity of world) entity.update(dt)`. Each mob owns a self-rescheduling event
(`event_mob_mundane`) that fires, acts, and re-arms itself; each regenerating pool owns
`event_hit_regen`, which applies the integer part of a fractional accumulator and reschedules;
each item decay is a scheduled `TAG_OBJ_DECAY`. `add_event` is a **300-slot timing wheel** indexed
by `(delay + pulse) % PULSES_IN_TICK` with a `timer` field counting wheel revolutions.

This is not an optimisation, it is what makes 46,508 rooms affordable. Idle regions cost nothing;
`remember_array[zone]` (the list of logged-in PCs per zone) gates mob AI to a third speed when no
player is present. **We have exactly one `setInterval` at 100 ms that walks every player.** That is
correct for four players and wrong for a world.

### 1.2 The room is a point, not a place — and ours is not.

In a MUD a room has no interior geometry. Everyone in it is at the same location; "distance" within
a room does not exist. `act()` broadcasts to `world[room].people`; an area spell hits everyone
there; a melee attack needs no range check. Any spatial structure inside a room is *emergent from a
data structure*, not from coordinates: `ROOM_SINGLE_FILE` rooms make the occupant linked list a
literal corridor queue with a swap operation when two characters jostle, and `PLR2_BACK_RANK` plus
`on_front_line()` gives a room a front line and a back line out of one bit and a counting rule.

**Our rooms are 9×9 tile blocks, 288 px on a side, and a character crosses one in about 1.9 s at
`PLAYER_SPEED` 150.** That is not a smaller version of a MUD room; it is a different object. Every
room-scoped mechanic in this document has to be re-decided against that fact, and §5 is where the
bill comes due.

### 1.3 Position is a two-axis state machine, and it gates everything.

Stock Diku has one `POSITION_*` ladder and every clone copies it. Duris does not. It packs **two
orthogonal fields into one byte**:

| Axis | Values | Stored | Changed by |
| --- | --- | --- | --- |
| **Posture** | `POS_PRONE 0`, `POS_SITTING 1`, `POS_KNEELING 2`, `POS_STANDING 3` | low 2 bits | commands, bash/trip, involuntary collapse |
| **Status** | `STAT_DEAD 4`, `STAT_DYING 8`, `STAT_INCAP 16`, `STAT_SLEEPING 32`, `STAT_RESTING 64`, `STAT_NORMAL 128` | bits 3–8, `STAT_MASK 252` | derived from HP by `calculate_ch_state()` |

`MIN_POS(ch, v)` compares **both halves independently**. Every command in the interpreter carries a
minimum expressed as a sum — `CMD_HIT` needs `STAT_NORMAL + POS_STANDING`, `CMD_FLEE` needs
`STAT_NORMAL + POS_PRONE`, `CMD_DROP` needs `STAT_RESTING + POS_PRONE` — plus a separate `in_battle`
boolean.

There is **no `POSITION_FIGHTING`**. Fighting is a pointer (`specials.fighting`); stunned is an
affect bit. So posture, consciousness and engagement are three independent axes, and "prone while
fighting", "standing while bleeding out" and "kneeling and resting" are all expressible. Collapse
them into one enum — the natural modern instinct — and none of them are.

Status is a **pure function of HP**: `< -10` dead, `<= -6` dying, `<= -3` incapacitated. Posture is
the thing that gets *forced*: `update_pos()` rolls to make wounded standers collapse (5-in-6 when
dying, 1-in-10 from kneeling, 1-in-8 from sitting), and a rider who falls takes `dice(3,4)*4` stun.

### 1.4 Everything temporary is one data structure.

Duris has exactly one primitive for a timed modifier — `struct affected_type` — and builds *all* of
these out of it: buffs, debuffs, damage-over-time markers, damage-absorption pools, spell
memorisation slots, innate cooldowns, PvP timers, quest state, achievement flags, plain counters.

```
type        skill/spell id, or a TAG_* pseudo-id above 2000
duration    game hours, or pulses when AFFTYPE_SHORT is set
modifier    the amount
location    APPLY_* — which derived stat it feeds
bitvector   five 32-bit words of boolean flags
flags       AFFTYPE_* behaviour bits (NOSAVE, NODISPEL, NOAPPLY, PERM, SHORT, OFFLINE, …)
context     optional pointer
```

One list, one expiry loop, one persistence path, one dispel path, one display path. Adding a new
timed mechanic costs a constant and zero infrastructure. **This is the single most transferable idea
in the whole study set**, and roadmap Phase 5b took it: see `shared/src/affects.ts` and §3.5 below for
what was kept, what was simplified, and what is still waiting for a consumer.

### 1.5 Stats are recomputed from base, never adjusted incrementally.

There is no `unapply()`. Any change — equip, unequip, spell landing, timer expiry, level-up — calls
`affect_total()`, which runs `all_affects(ch, FALSE)` to strip the character back to base and
`all_affects(ch, TRUE)` to re-sum every worn item and every affect into a scratch accumulator, then
commits. The source comments say it outright: *"for stats, it just flat out recalcs them, no +/-
about it, safer that way."*

Two consequences worth internalising:

- **The player file stores `max_hit - hit`, not `hit`.** Max HP is derived from level, Con, class,
  gear, age and epic skills. Persisting current HP means a gear change silently heals or kills you.
  Every recompute saves `missing_hps` first and restores it after.
- Rebuilds are **deferred and coalesced**: `affect_to_char`, `affect_remove` and `affect_join` all
  schedule `event_balance_affects` at delay 0 and only if one is not already pending, so N changes
  in one pulse cost one rebuild.

This generalised in Phase 5b. `lightRadius` had been the one derived stat, with a single derivation
point documented as *"the one place `lightRadius` is derived"*; that point is now
`Simulation.recompute`, which folds the whole affect list and derives every stat that comes off it. The
rebuild is immediate rather than a coalesced delay-0 event, and deliberately so — Duris defers because
its fold walks ~165 flags and every worn item, while ours walks a list of at most four. That comment
names the spot where the deferral goes when Phase 16 makes it worth having.

### 1.6 Skills are percentages you grind by using, not levels you buy.

`struct char_skill_data { byte learned; byte taught; }` per skill. `learned` is your current
proficiency 0–100; `taught` is the ceiling your class and spec allow at your level. Levelling drags
a *floor* — `minlearn = MIN(40, 3*level/2)` — under both, so a fresh level-30 character is
functional for free and everything above 40% must be earned. `notch_skill()` raises `learned` by
exactly 1, on a roll, **rate-limited by a global per-category affect**: 5 real minutes for physical,
10 for mental, regardless of how much you swing. Practice at a teacher costs
`((s/10)² - 2*(s/10) + 2) * 5111` gold and stops well short of the ceiling.

Mobs store **no skills at all**. NPC proficiency is a pure function of level and class — zero bytes per
mob.

> **Corrected 2026-08-06, and the correction is the interesting part.** The `level << 1` this entry used
> to quote, and the rate limit described above, are both read from branches the shipped source **does not
> compile**: `fight.c`'s combat is inside `#ifndef NEW_COMBAT` and `NEW_COMBAT` is defined, while
> `notch_skill`'s curve and the *only two readers* of the cooldown affect are inside `#if wipe2011`,
> which is defined nowhere. The live NPC formula is `getNPCweaponSkillLevel`
> (`new_combat_util.c:905`) — `level × 1.75` for `CLASS_NONE`, which is what every mob in our world is —
> and as shipped there is no rate limit at all. See [DESIGN-skills.md](DESIGN-skills.md) §0 and §2. The
> shape this entry describes is right; the arithmetic came from the wrong file.

### 1.7 The world repopulates by adding, never by removing.

Each zone owns a table of `reset_com{command, if_flag, arg1..arg4}` parsed from a `.zon` file — a
tiny stack machine: `M` load mobile, `O` load object into room, `G` give to the last mob loaded, `E`
equip the last mob loaded, `P` put inside, `D` set door state, `F` load a follower, `R` load a
mount, `S` end. `if_flag` chains a command to the previous one's success.

`event_reset_zone` increments `zone_table[z].age` once per 75-second tick and resets when
`age >= lifespan`, where `lifespan` is **re-rolled from a `[lifespan_min, lifespan_max]` band after
every reset** so repop is never on a timetable.

**Reset never despawns anything.** Population converges purely because `mob_index[].limit` blocks
over-spawning. A mob you lured three zones away is still alive, still counts against the limit, and
is still walking home.

### 1.8 Visibility is per-observer, resolved at render time.

`ac_can_see(sub, obj)` is deliberately asymmetric and is evaluated freshly for every pair at every
event. It checks the observer's blindness, the target's invisibility/hide/wraithform, then light
**twice** — once for the observer's room and once for the target's — testing day-blindness and
night-blindness separately, with infravision and race-specific infra-invisibility on top.

`act()` takes one authored format string and **re-expands it separately for every recipient in the
room**. `$n` becomes "you" for the actor and `PERS(ch, to)` for everyone else — and `PERS()` returns
"someone" when unseen, "a red shape" under infravision in the dark, a race name across racewar lines
or before introduction, and the real name only otherwise.

The deep consequence: **there is no such thing as a broadcast event payload.** Send one structured
event to a room and let clients render it, and you leak identities the game deliberately hides.

---

## 2. Status index

One line per mechanism. `Built` = working and in the running game. `Partly` = the data or the
plumbing exists but the mechanic does not. `Designed` = specified in a design doc, no code.
`None` = not considered yet.

| # | Mechanism | Status | Where |
| --- | --- | --- | --- |
| **Time** | | | |
| 1 | Simulation tick | **Built** | `TICK_MS` 100, one `setInterval` in `server/src/index.ts` |
| 2 | Combat round | **Built** | **Per actor** (`Actor.roundMs`), never the global constant — §4.1. Driven by the scheduler |
| 3 | Per-actor combat clock | **None** | Duris `combat_tics` / `base_combat_round` |
| 4 | Event scheduler / timing wheel | **Built** | `server/src/scheduler.ts` — min-heap, ties on insertion order so replays are identical. Combat is its first consumer |
| 5 | Fractional per-tick accumulators (regen, bleed) | **Built** | `accrue` in `shared/src/vitals.ts`; carry is bounded to one point over any window |
| **World** | | | |
| 6 | Room graph with typed exits | **Built** | `shared/world.ts` |
| 7 | Doors: name / closed / locked / key / hidden | **Built** | a shut door is not walkable and not transparent; `open`/`close` mutate both sides and broadcast `door`. `key`/`hidden` still unused |
| 8 | Sectors (16 kinds) | **Built** | harvested where Duris matches (all 40 `SECT_*` values mapped since Phase 5c); everywhere else inferred by word + suffix rules then graph label-diffusion. Default share 0.2%, was 23.2% |
| 9 | Sector movement cost | **Partly** | `SECTOR_MOVE_COST` declared, **zero callers** |
| 10 | Terrain that requires swim/fly | **Partly** | `SECTOR_REQUIRES_MOVEMENT` declared, **zero callers** |
| 11 | Room flags (safe, peaceful, no_magic, dark…) | **Partly** | harvested from the Duris `.wld` bitfield — 3,911 rooms carry one (indoors 2696, dark 2283, no_recall 2125, no_magic 311, no_mob 251, safe 1). `peaceful`/`death_trap` have no upstream source. **No flag changes a rule yet** |
| 12 | Room prose | **Built** | 5,889 rooms carry harvested Duris prose, unwrapped from its 78-column hard wrapping; printed on entering a room |
| 13 | Zone reset tables / repop | **Built** | harvested from Duris `.zon`; `server/src/reset.ts`. Additive — nothing despawns. `M` and `D` execute; the object commands are parsed and carried for Phase 15 |
| 14 | Per-vnum instance limits | **Built** | `Simulation.countOf`, counted **world-wide** so a lured mob suppresses its own replacement |
| 15 | Place = (zone, level) as unit of grid | **Built** | `server/src/world.ts` |
| 15b | Actor generalisation (players and mobs one kind of thing) | **Built** | `Actor` / `Player` / `Mob` in `sim.ts`, one map; ten narrowing points, each a place a mob genuinely cannot go |
| **Character** | | | |
| 16 | Ability scores + SRD modifiers | **Built** | `abilityMod`, `proficiencyBonus` — tested, **no non-test callers** |
| 17 | HP / mana / move / exp / level fields | **Partly** | hp/mana/move now regenerate and movement is spent walking; `exp`/`level` still never change |
| 18 | Derived max HP | **Partly** | `maxHitPoints(8,1,1)` called once at spawn |
| 19 | Regeneration of any pool | **Built** | `Simulation.regenerate`, rates from `limits.c` with both position axes multiplying |
| 20 | Persisting the *wound*, not the value | **Built** | `PlayerStore.setMissing` stores `max - current` per pool |
| 21 | Posture × status state machine | **Built** | `shared/src/position.ts` — two ordered ladders compared independently, as `MIN_POS` does |
| 22 | Command legality gated on position | **Built** | `COMMAND_REQUIREMENTS`, read at the one dispatcher seam in `runCommand` |
| 23 | Classes / races / multiclass | **None** | |
| 24 | Skills as percentages, notch-by-use | **None** | |
| 25 | Saving throws (either system) | **None** | |
| 26 | Alignment | **None** | |
| 27 | Experience as a decrementing pool | **Partly** | There is a gain path as of Phase 13; `experienceToLevel` is still a *cumulative* curve with no levelling that reads it |
| **Affects** | | | |
| 28 | Generic timed-modifier record | **Built** | `shared/src/affects.ts` — `type`/`duration`/`modifier`/`apply`/flags/`context`, one list per character, one expiry pass on the 100 ms tick. Three types: the carried light, and the two stages of the rest cycle |
| 29 | Full stat recompute from base | **Built** | `Simulation.recompute` is the single derivation point — `affect_total`. No `unapply` anywhere. Immediate rather than a coalesced delay-0 event, and the comment says where that goes when Phase 16 makes the fold expensive |
| 30 | `APPLY_*` modifier taxonomy | **Partly** | five locations, every one with a reader: `none`, `light` (a **selector**, best-of rather than a sum), and `hpRegen`/`manaRegen`/`moveRegen` off `APPLY_HIT_REG` and friends. Duris has 58; rows arrive with consumers |
| 31 | Boolean state bit-words | **Partly** | `AffectFlag` is a bit field with three behaviour bits (`NoSave`, `NoShow`, `Offline`), which is Duris' `AFFTYPE_*`. The five 32-bit `AFF_*` **state** words — sanctuary, blindness, the elemental auras — have no consumer yet |
| 32 | Room affects | **None** | |
| 33 | Character-to-character links with room-proximity break | **None** | |
| **Combat** | | | |
| 34 | Dice notation, seeded RNG | **Built** | `parseDice`, `rollDice`, `makeRng` (mulberry32) |
| 35 | Attack resolution (d20 vs AC) | **Partly** | `resolveAttack` built + tested, **no non-test callers** |
| 36 | Crit / fumble on a separate axis | **None** | ours are folded into the d20 |
| 37 | Damage rolling with crit doubling | **Built** | `rollDamage` finally has a caller. Damage dice harvested per mob from the `.mob` fifth column |
| 38 | Engagement as state (`fighting` pointer) | **Built** | `server/src/combat.ts` — one directed pointer per actor, inbound set derived by scanning, no range check anywhere in the module. Mercy is player-only; a mob fights to the death |
| 39 | Attack list as equipment slots | **None** | |
| 40 | Defensive gauntlet (parry/block/dodge/riposte) | **None** | |
| 41 | Threat table with hysteresis | **Designed** | `DESIGN-mobs-and-movement.md` §2.6 |
| 42 | Mercy rule (stop attacking the helpless) | **None** | |
| 43 | Death, corpses, full loot, corpse retrieval | **Partly** | `server/src/corpses.ts` — mob death, decay, a looted-state sprite. **Contents wait for Phase 15**, and a dead *player* is not returned anywhere yet |
| 44 | Experience from damage / tanking / healing | **Built** | `shared/src/experience.ts` — dealt, taken and support each earn a share, so tanking and healing pay with no role system |
| 45 | Fleeing with a chance and a cost | **Partly** | `flee` message exists → "Combat is not implemented yet." |
| 46 | Crowding budget / front rank / back rank | **None** | |
| 47 | Special attacks with expensive failure | **None** | |
| **Movement** | | | |
| 48 | Continuous steering + collision | **Built** | `stepMovement`, shared by server and client predictor |
| 49 | Single-room step ("go north") | **Built** | `stepRoom`, Shift+WASD in the client |
| 50 | Server-side A* gated on explored tiles | **Built** | `pathfind.ts` + `moveTo` in `index.ts` |
| 51 | Hold-to-drag steering | **Built** | client input mode, produces ordinary `steer` |
| 52 | Movement-point cost per step | **Built** | `moveCost` averages the two sectors; `SECTOR_MOVE_COST` finally has a caller |
| 53 | Encumbrance | **None** | |
| 54 | Following (parent pointer + follower list) | **None** | |
| 55 | Grouping (shared list, consent, exp split) | **None** | |
| 56 | Tracks / footprints | **None** | |
| 57 | Movement noise broadcast by distance | **None** | |
| **Objects** | | | |
| 58 | Item type/instance split | **Designed** | `DESIGN-inventory.md` §8 |
| 59 | Inventory with variable item sizes | **Designed** | `DESIGN-inventory.md` §2 |
| 60 | Containers, nesting, type restriction | **Designed** | `DESIGN-inventory.md` §4 |
| 61 | Equipment slots | **Designed** | `DESIGN-inventory.md` §6 |
| 62 | Light as an item property, best-of-equipped | **Partly** | `bestLight()` works and takes a candidate list; the candidate list is one carried item |
| 63 | Ground pickups | **Built** | `server/src/pickups.ts` — deterministic scatter, **per-character** `taken` set |
| 64 | AC derived from material × slot × condition | **None** | |
| 65 | Item condition / durability | **None** | |
| 66 | Item decay by scheduled event | **Partly** | only carried light burn-down exists |
| 67 | Money as both scalar and object | **None** | |
| **Mobs** | | | |
| 68 | Mobs of any kind | **Designed** | `DESIGN-mobs-and-movement.md` §2 |
| 69 | Action flag bitfield (sentinel, scavenger, …) | **Partly** | 5 of 32 read: `MEMORY`, `SENTINEL`, `STAY_ZONE`, `HUNTER`, `WIMPY`. See §4.11 — three of them are traps |
| 70 | Aggression as a predicate, not a boolean | **Built** | `shared/src/aggression.ts`; only `all` evaluable until Phase 21 |
| 71 | Delayed aggression / reaction time | **Built** | `server/src/perception.ts`; revalidated on firing. Level-scaled: agility is not on the simple `.mob` record |
| 72 | Mob memory keyed on character | **Built** | `MobAwareness.noticed`, gated on Duris' `ACT_MEMORY`. Cleared on disconnect — ids are reissued |
| 73 | Hunting / pursuit on the room graph | **Built** | `server/src/hunt.ts`; BFS for the exit, tiles for the motion. One room per 1.5 s |
| 74 | Assist / call for help | **Partly** | `ACT_PROTECTOR` built and room-scoped, as the source has it. The cross-room cry (`ACT2_COMBAT_NEARBY`) needs a second action word the simple `.mob` record lacks |
| 75 | Target selection by weakness | **Built** | `CountToughness` ported for the *opening* pick only; a threat table governs switches after — the one deliberate divergence. See `threat.ts` |
| 76 | Morale / wimpy | **Designed** | §2.7 |
| 77 | Loot tables | **Designed** | §2.10 |
| 78 | Quest hooks (`questDrops`, `questTags`) | **Designed** | §2.11 |
| 79 | Special procedures / command interception | **None** | |
| 80 | Shopkeepers | **None** | |
| **Magic** | | | |
| 81 | Spells of any kind | **None** | |
| 82 | Cast time as a self-rescheduling event | **None** | |
| 83 | Interruption / concentration | **None** | |
| 84 | Spell circles and memorisation | **None** | |
| 85 | Magic resistance separate from saves | **None** | |
| 86 | Area targeting with crowd thinning | **None** | |
| 87 | Absorption pools (wards) | **None** | |
| 88 | Damage over time | **None** | |
| 89 | Innates (derived racial/class abilities) | **None** | |
| **Visibility** | | | |
| 90 | Tile-granular line of sight (shadowcasting) | **Built** | `shared/vision.ts` |
| 91 | `visible` vs `seen` split | **Built** | `seen` persisted as a bitset per Place |
| 92 | Light radius as a derived stat | **Built** | `DESIGN-visibility-and-light.md` §3 |
| 93 | Light duration, expiry, `expiresTo` | **Built** | with a 10 s warning |
| 94 | `rooms`-mode illumination | **Built** | `roomLightTiles` |
| 95 | Per-observer entity visibility | **Built** | `visibleEntities` / `syncEntities` in `index.ts` |
| 96 | Terrain remembered, creatures not | **Built** | the roguelike rule, deliberately |
| 97 | Room-scoped shared light (one player lights the room for all) | **None** | Duris `char_light` → `room_light` |
| 98 | Vision *modes* (infra / too bright / dayblind) | **None** | we have one radius, not six renderers |
| **Interface** | | | |
| 99 | Text log with channels | **Built** | `client/src/log.ts`, 5 channels |
| 100 | Any text command input at all | **Built** | a command line in the log panel; the client sends the raw line as `command` and the server parses it |
| 101 | Command table with abbreviation priority | **Built** | `server/src/commands.ts` — exact-first then leftmost prefix, table order as tie-break, in Duris' own relative order |
| 102 | Target resolution ("2.orc", keyword lists) | **Partly** | ordinals and whole-word matching built and gated on visibility; keywords are *derived from display names* until items are authored |
| 103 | Per-recipient message rendering (`act()`) | **Built** | `server/src/act.ts`; an unseen actor is "someone", resolved through the same `canSee` as entity presence |
| 104 | Channels beyond room-scoped `say` | **Partly** | `say` works end to end and renders per recipient; no other channel exists yet |
| 105 | Prompt / HUD as a configurable bitmask | **None** | |
| 106 | Paging | **None** | DOM scroll instead — legitimately better |

Counting the 106 rows above: **30 built, 14 partly built, 16 designed but not built, 46 not
considered yet.** Roughly a third of the mechanisms a MUD of this lineage runs on are present in some
form, and the third that is missing entirely is concentrated in combat, affects, magic and the
command interface.

---

## 3. The subsystems

### 3.1 Time

| Constant | Duris | Meaning | Ours |
| --- | --- | --- | --- |
| `OPT_USEC` | 250,000 µs | base pulse, 4/sec | `TICK_MS` 100 (10/sec) |
| `PULSE_VIOLENCE` | 16 pulses = 4 s | combat *lag unit*, not a round | `ROUND_MS` 3000, unused |
| `PULSE_MOBILE` | 30 pulses = 7.5 s | mob AI cadence | — |
| `PULSE_MOB_HUNT` | 6 pulses = 1.5 s | pursuit step | — |
| `PULSES_IN_TICK` | 300 = 75 s | one MUD hour; affect durations | — |
| `WAIT_SEC` | 4 pulses = 1 s | command lag unit | — |

The important structural facts:

1. **Combat is not a global round.** `perform_violence()` is called unconditionally every pulse. It
   walks a global `combat_list` and decrements each combatant's own `specials.combat_tics`; when a
   fighter's counter reaches zero it acts and resets to `specials.base_combat_round` — a **per-character
   float**, derived from race + class + `APPLY_COMBAT_PULSE` affects, floored at 3.0 pulses (0.75 s)
   and defaulting to 16. Whirlwind halves the remaining tics; `AFF2_FLURRY` multiplies by 0.70.
   Fights are staggered, not lockstep.
2. **Command lag is a separate mechanism.** `CharWait(ch, delay)` sets `PLR2_WAIT` and schedules an
   event to clear it. The interpreter skips the input dequeue while it is set, so queued commands
   execute **late but in order**. Waits do not stack — the longer of old and new wins.
3. **Flood control is structural.** The loop dequeues exactly one line per descriptor per pulse. A
   player who pastes twenty commands executes them at four per second. There is no rate limiter.

> **Status.** Tick built; round declared and inert; per-actor clock and scheduler absent. `ROUND_MS`
> being a bare exported constant is precisely the shape `CLAUDE.md` warns against — *"Round length is
> data, not a constant sprinkled through code"* — and it is currently a constant with one consumer
> (the `welcome` message) and no behaviour.

### 3.2 The world: rooms, zones, resets

**Room record** (Diku `.wld`, verified against `data/zones-source/duris/areas/wld/`):

```
#<vnum>
<name '~'>
<description '~'>
<zone_number> <room_flags bitfield> <sector_type>
D<0-5>  <exit description '~'> <keywords '~'> <door_flag> <key_vnum> <to_room>
E       <extra description keywords '~'> <text '~'>
S
```

We have the vnum, the name, the exits and the door kind. We do **not** have the flags bitfield or
the sector byte, because our source is the zMUD mapper DB, which has neither. Sectors are inferred
from room and zone names by `worldgen/src/terrain.ts` (word rules then compound suffixes), and what
the names cannot answer is filled by graph label-diffusion in `worldgen/src/diffuse.ts` — since
Phase 5c the default share is 0.2%, from 23.2%. Room flags are 100% absent — measured on the generated zone 260, **0 of 98 rooms carry
any**, and `RoomFlag` has no producer anywhere in the codebase.

That gap is load-bearing for more than cosmetics. `DESIGN-mobs-and-movement.md` §2.9 already flags
it: `respectsSafeRooms` has nothing to respect. Add to that list: `ROOM_NO_MAGIC`, `ROOM_PRIVATE`,
`ROOM_TUNNEL`, `ROOM_SINGLE_FILE`, `ROOM_SAFE`, heal rooms, and the `chance_fall` / `current_speed`
fields that make a room actively do something to you when you type a command in it.

**Zone reset commands**, in full:

| Cmd | Effect | Notes |
| --- | --- | --- |
| `M` | load mobile `arg1`, global limit `arg2`, into room `arg3`, at `arg4`% | see the gotcha in §4.9 |
| `O` | load object into a room | honours its percentage every reset |
| `G` | give object to the last mobile loaded | bypasses the percentage roll for shopkeepers |
| `E` | equip the last mobile loaded at wear position `arg3` | the random layer of loot |
| `P` | put object `arg1` inside object `arg3` | |
| `D` | set door state: `arg3 & 3` → open/closed/locked, `\|4` secret, `\|8` blocked | |
| `F` | load a mobile that *follows* the last one — force-flagged `ACT_SENTINEL`, grouped by literally running `group all` through the command interpreter | |
| `R` | load a mobile the last one then mounts — force-flagged `SENTINEL\|MOUNT\|ISNPC` | |
| `S` | end | |

The executor carries an implicit cursor (`last_mob_load`) across iterations, which is the source of
most zone-file authoring bugs and needs to be **explicit** in any reimplementation. A command whose
vnum lookup fails at boot is disabled permanently by overwriting its opcode with `!` — one bad
reference degrades one line forever rather than crashing the zone.

Mob stats are not a property of the vnum: `reset_zone` calls `apply_zone_modifier(mob)` after
setting the birthplace, scaling HP, exp and damage by the zone's `difficulty` field. The same
skeleton is genuinely tougher in a hard zone. Separately `mobconv.c` rewrites almost every mob at
load — assigning a class if none, clamping levels, applying the `ACT_ELITE` 2.5× HP / 1.2× damage
multipliers — unless `ACT_IGNORE` is set. **The numbers in a `.mob` file are an input to a pipeline,
not the final stats.**

> **Status.** Room graph, exits, portals, Places: built. Sectors: built but guessed. Room flags,
> descriptions, resets, repop, instance limits: absent. Doors are the worst of the partials — the
> type carries `closed`, `locked`, `keyId` and `hidden`, `stepRoom` refuses a locked door, and yet
> `Tile.Door` is walkable (`isWalkable` is `tile !== Void`), so a closed door stops the MUD-style
> step and does not stop continuous movement through the same doorway. The `open`/`close` handlers
> broadcast a sentence and change nothing.

### 3.3 The character

Duris' model has three ideas worth stealing and one worth admiring from a distance.

**Two stat scales.** `base_stats` (ten stats, 1–100, "percent of your race's potential", persisted)
and `curr_stats` (1–511, what every rule actually reads, derived). `curr = stat_factor[race].X *
base / 100`, recomputed wholesale on every `affect_total()`. Racial identity is a **per-stat
multiplier table** loaded from a properties file at boot — Ogre Str 230 / Con 200, Illithid Str 70,
Human 100 across the board. One number then expresses both "how good is this individual for their
kind" and "how good is this kind", and +1 Con is worth 2.0 real points to an Ogre and 0.85 to an
Illithid *for free*.

**Effects read out of hand-authored tables, not formulas.** `STAT_INDEX()` buckets 0–511 into 0–51
(≈6-point buckets below 100, ≈12 above), and 52-row tables give the answer: `str_app{tohit, todam,
carry_w, wield_w}`, `dex_app{reaction, miss_att, p_pocket, p_locks, traps}`, `agi_app{defensive,
sneak, hide}`, `int_app{learn}`, `wis_app{bonus}`, `cha_app{modifier}`. Dexterity's pick-locks bonus
saturates at index 24 while its pickpocket bonus climbs to index 51. `bonus = floor((stat-10)/2)`
cannot express a plateau.

**Four pools, all derived, all regenerated by self-rescheduling events with fractional
accumulators.** `hit`, `mana`, `vitality` (movement), `ward` (a shield pool). Rates are non-linear —
`mana_regen` returns `gain²/8`, `move_regen` returns `gain·|gain|/5` — so a modifier that looks like
+25% is +56% after squaring. Resting is a 1.33× input and a 1.77× output.

**Levels 1–56 mortal**, and `new_exp_table[n]` is the cost *of* level n, not a cumulative threshold:
`GET_EXP` is a **pool that is decremented** when you level, so "exp to next level" is literally a
countdown with no big-number drift. Only 11 of the 56 entries are authored; a missing property
inherits the previous one, producing five-level plateaus for free.

The thing to admire from a distance: hunger, thirst and aging are all **fully coded and switched
off** — `gain_condition()` forces the counters to -1 before its loop, and `graf()` returns its
midpoint parameter on line 1, flattening every age curve. They were built, shipped, and turned off.
Take the hint.

> **Status.** We have SRD ability scores (six, not ten; a flat scale, not two) with `abilityMod` and
> `proficiencyBonus` tested but called from nothing. `maxHitPoints` is called exactly once, at spawn,
> with hardcoded `(8, 1, 1)`. The four pools exist as fields on `Player` and on the wire, and nothing
> in the codebase ever writes to `hp`, `mana`, `move` or `experience` after spawn. There is no regen,
> no race, no class, no skill, and no saving throw of either kind. The `experienceToLevel` curve we
> do have is cumulative, which is the shape Duris deliberately avoids.

### 3.4 Position, and why it is worth doing before anything else

Covered in §1.3. The reason it belongs near the top of the build order rather than "with combat" is
that it changes the **signature of every action in the game**. Duris expresses it as one byte on the
character and one packed minimum on each command row, and gets, for free:

- Knockdown as a real combat effect rather than a status bolted on the side.
- A downed player who is on a visible timer allies can beat.
- `flee` legal from prone (it consumes the attempt to scramble up) while `hit` is not.
- Regeneration that varies by posture *and* by consciousness independently — sleeping ×1.75,
  resting ×1.33, prone ×1.25 on top.
- A single honest answer to "what can I do right now?"

Retrofit it after combat and mobs exist and you are editing every handler you wrote.

### 3.5 Affects

The record is in §1.4. What matters for implementation:

**Two duration clocks, and they share a field.** Ordinary affects decrement `duration` by one per
game hour in `affect_update()` — a single list walk per 75 s for the whole world. Affects flagged
`AFFTYPE_SHORT` **never appear in that loop**; their `duration` is in pulses and a scheduled
`event_short_affect` owns them. Removing one early must find and neuter that event (Duris frees the
event's payload and sets its timer rather than deleting the event), and the handler must re-verify
both that the character is still alive and that the affect is still in the list before touching
either. Skip either half and it is a use-after-free.

**Stacking is per-spell policy, not a system rule.** Three idioms coexist: refuse (sanctuary checks
the bit and bails), refresh in place (armor walks the list overwriting `duration`), and merge
(`affect_join` sums durations and modifiers). Multi-apply spells deliberately install *several nodes
of the same `type`* — one per `APPLY_*` location — so dispel has an inner loop to skip runs of
identical types and `affect_from_char(ch, type)` removes all of them. **`type` is not a key.**

**Five 32-bit boolean words** (~165 flags) with union semantics: `affect_to_char` ORs them in, the
rebuild re-ORs them, and `apply_affs` then *arbitrates* incompatible states — coldshield removes
fireshield, the elemental auras form a strict priority chain. Booleans are a bit test rather than a
list walk, which is why combat and visibility code can query them thousands of times per round.

**Links.** `link_char_with_affect` registers a relationship in both directions with flags:
`LNKFLG_ROOM` links break automatically when either party leaves, `LNKFLG_EXCLUSIVE` replaces any
existing link of that type. ~20 types — consent, riding, guarding, pet, grappled, song, paladin
aura, tether, flanking, circling. Every move calls `check_room_links()`, which fires each broken
type's callback. That is how "this only exists while we are together" is one flag instead of twenty
scattered cleanup paths.

> **Status.** Built in roadmap Phase 5b — `shared/src/affects.ts`, with `Simulation.recompute` as the
> single derivation point. The carried light's burn was **migrated onto it and its bespoke timer
> deleted**, which was the test of whether the primitive was general enough; the rest cycle is the
> second consumer and exists to give `modifier` and `apply` a caller, because the light alone would not
> have had one.
>
> Three parts of this section are deliberately *not* built, and each is waiting on a consumer rather
> than on a decision. **The two duration clocks are one clock:** we have no coarse hour tick, so
> `AFFTYPE_SHORT`, `event_short_affect` and the use-after-free it guards against all have no analogue.
> **The five boolean state words** are absent — `AffectFlag` covers Duris' `AFFTYPE_*` behaviour bits,
> but nothing yet needs `AFF_SANCTUARY` or an aura priority chain to arbitrate. **Links** are absent
> entirely and stay so until grouping (Phase 18), which is their first honest consumer.
>
> Stacking, though, is here in full, because that one *is* a decision: `keep`, `replace` and `join`
> are all expressible and the caller chooses, exactly as the three idioms above require.

### 3.6 Combat

**The turn.** A fighter whose `combat_tics` reaches zero builds an **array of attacks** —
`calculate_attacks()` pushes *wear-slot indices* into `attacks[]`: primary, secondary, third and
fourth hands (four-armed races), plus swings from dual wield, double/triple/quadruple attack rolled
independently against skill, haste, class procs, and a dexterity-threshold bonus swing. Multipliers
(inertial barrier, armlock) change **how the list is consumed**, not the list itself: `real_attacks
= ceil(n * mult)`, `div_attacks = 1/mult`, indexed as `attacks[i / div_attacks]`, so halving attacks
makes each listed slot swing twice at half count rather than truncating the list and losing your
third-weapon proc.

**Per attack, in order:**

1. **Defensive gauntlet**, short-circuiting: mangle → parry → divine parry → block → dodge → leap →
   monk riposte. Any success returns early and the attack never reaches the hit roll. Skipped if the
   defender is immobile or not in `STAT_NORMAL`. `dodgeSucceed()` is representative:
   `learned = agi * 1.5 - attacker_weapon_skill`, plus a stat-index difference, plus a level
   difference, bounded `[agi/10, 50]`, halved while down, ÷5 while dazzled, **×0.06 while stunned**.
2. **Item and mob `CMD_GOTHIT` procs**, which can also cancel.
3. **Crit/fumble on a separate axis.** `CRITRATE` is 8% below 105 Int, else `(Int-100)/5 + 8`. A
   crit is demoted to a normal hit if `number(30,101) > weapon_skill + luck/4`; a fumble is demoted
   if `number(1,101) <= weapon_skill + agility/2`. Skill converts luck into consistency in *both*
   directions. A confirmed fumble is physical: 1-in-5 your weapon is unequipped and lands on the
   floor, another 1-in-5 you stop fighting and jab a random bystander.
4. **The hit roll**, percentile. `calculate_thac_zero()` yields a class tier (mage 4 … greater race
   13) × level/6, plus weapon skill, then `MAX(2x/3, 30)`, then `+= BOUNDED(-10, hitroll*2, 90)`.
   `chance_to_hit()` adds `victim_ac * 85/100` (AC is negative when good — it is an **additive
   percentage penalty**, not a target number), `+100` if the victim is asleep or immobile, `+10` per
   posture step the victim is below standing, `-15` per step the *attacker* is, and bounds to 1–100.
   A `number(1,100)` roll misses if it meets or exceeds that. No natural 20, no natural 1 — the
   bound guarantees a 1% floor and ceiling instead.

**Engagement is a state, not a distance.** `set_fighting(ch, vict)` breaks sneak/hide/sleep, sets
the opponent pointer, pushes onto `combat_list`, stops spell memorisation, wakes sleepers, and
triggers `remember()`. `stop_fighting()` unlinks and calls `update_pos()`. There is no range check
anywhere, because there is no range.

**The mercy rule.** When a victim drops below −2 HP, falls asleep, or is immobilised,
`StopMercifulAttackers()` disengages **everyone** whose target is that character — unless they are
berserk, an aggressive NPC, or a PC who has explicitly toggled `PLR_VICIOUS`. Without this the
incap/dying window is dead code, because auto-attacks cross −10 immediately. Damage is separately
clamped so HP can never fall below −11 in one blow: death is a *state* reached by crossing a
threshold, not an arithmetic consequence.

**Bleeding out** is a fractional accumulator. `hit_regen()` returns −2/tick dying, −1/tick
incapacitated; `event_hit_regen` fires every pulse adding `per_tick / 300`, applies only the integer
part, keeps the fraction, and calls `die()` below −10. The same code handles +14/tick regen and
−2/tick bleeding with no special-casing, and slow rates never round to zero.

**Death** dumps everything worn and carried into a corpse object (`make_corpse` relinks the whole
carry list from `loc.carrying` to `loc.inside`), applies 10% of the next level's exp as a loss, and
respawns the PC at their birthplace with nothing. Corpse retrieval is a whole gameplay loop that
exists *only* because death separates you from your gear geographically.

**Experience comes from four independent streams**: `EXP_KILL`, `EXP_DAMAGE` (proportional to damage
dealt, gated by a `GET_LOWEST_HIT` watermark so healing a mob cannot be farmed), `EXP_MELEE`
(awarded to the character *being attacked*, every `PULSE_VIOLENCE` — this is tanking exp), and
`EXP_HEALING`. That is what makes tank and healer economically viable without any explicit role
system.

**Formation.** `PLR2_BACK_RANK` marks a grouped character as back-ranked; they cannot melee or be
meleed without a reach weapon, and `free_back_slots` forces people forward when the front line
thins (the invariant is that front must outnumber back). `can_hit_target()` imposes a crowding
budget: at most 3 other PC attackers on one PC target, and `sum(2^attacker_size) <= 8 *
2^victim_size`, so four halflings can pile on where two giants cannot.

**Special attacks trade guaranteed self-lag for a chance at a state change.** `bash()`: chance is
`0.70 * skill + 0.30 * (100 + Str/2 + Dex - victim_Agi)`, scaled by level difference, ×0.70 against
a larger victim, ÷2 against a back-ranked target, bounded 1–99, and **forced to 0 if the victim is
not standing**. On *failure* the attacker goes kneeling for 2 rounds, or prone for 3 if the roll was
badly missed. On success the victim sits for 2 rounds and the attacker eats 2 rounds anyway.

> **Status.** We have dice, a seeded RNG, a d20 attack resolver and a damage roller — all tested,
> **none of them called by anything**. `attack` and `flee` reach the server and produce "Combat is not
> implemented yet." `EntityView.fighting` and `attackResolved` exist on the wire with no producer.
> The threat table with hysteresis is designed (`DESIGN-mobs-and-movement.md` §2.6) and is a
> *different* rule from Duris', which re-scans and picks the weakest target every time rather than
> accumulating threat — that divergence is deliberate and should stay, because a threat table is what
> makes tanking a player skill.

### 3.7 Movement, following and grouping

**Cost.** `move_cost = movement_loss[from_sector] + movement_loss[to_sector]`, scaled by
`load_modifier(ch)/200` (75 for near-empty, 300 for near-capacity, in 10-point bands), then: down
×2/3, up ×3/2, flying or mounted `MAX(4, moves/3)`, floored at 1. Posture surcharges are added by
the caller: prone +6, kneeling +3, crippled +5.

**Three separate gates**, each answering a different question:

| Function | Question | Examples |
| --- | --- | --- |
| `do_simple_move_skipping_procs` | general | immobile, no exit, closed door, sitting, bound, over-encumbered, water current, **exhausted** |
| `leave_by_exit` | can I get OUT? | no-ground/air needs fly; mount must be standing; single-file queue blocks you |
| `can_enter_room` | can I get IN? | water needs a boat; ocean needs a dock; low ceiling forces kneeling; `ROOM_TUNNEL` refuses anyone flying; `ROOM_PRIVATE` refuses a third |

The split matters because teleports, summons and mob AI reuse the same three functions, so a spell
cannot put you somewhere walking could not.

**Following is a parent pointer plus a follower list.** `circle_follow` walks the chain upward to
reject loops. The crucial detail: after the leader is placed in the new room, the code walks the
follower list and, for each follower, builds the string `"<command> <direction>"` and **feeds it
back through `command_interpreter`**. So every follower independently pays movement points, is
independently blocked by a closed door or exhaustion, independently triggers aggro on arrival, and
independently gets lost in forests (a 5% roll on wilderness map rooms). That is why MUD groups
visibly string out and get separated. Teleport your followers and you lose all of it.

**Grouping is a separate system** — a separately allocated shared linked list every member points
at, gated by an exclusive `LNK_CONSENT` link (consenting to someone new silently revokes the
previous consent). It governs experience, group chat, ranks and auras. You can follow without being
grouped and be grouped without following.

**Group experience is superlinear, and this is the single most consequential number in the social
design.** `exp_divider = (group_size + 3) / 4.0`, and each PC **in the killer's room** receives
`(his_level / highest_level) * (gain / exp_divider)`. Solo divides by 1, a duo by 1.25 *each*, five
players by 2 each, thirteen by 4 each. **Total party payout always exceeds the solo award.** Getting
the sign of this wrong — dividing by group size, as almost everyone assumes — produces a game where
everyone solos, and the entire social layer the rest of the design depends on never forms. Members
outside the room get nothing (anti-leech), and a member 15/20/30/40 levels below the highest has his
share divided by 40/150/1000/5000 (anti-powerlevel).

**Fleeing.** `chance_when_engaged = 78% + MIN(3, exits-1) * (86-78)/3` — so 78% from a dead end up
to 86% with four exits. Room topology becomes tactically meaningful. It costs 20–30 vitality, strips
sneak, and grants a one-tick "twitchy" awareness affect. Pursuit is deliberately throttled: the
abandoned NPC's AI event is rescheduled half a second later, with a source comment saying that
allows *"fast, but not impossible chases"*.

> **Status.** Movement itself is our strongest subsystem — continuous steering with axis-separated
> sliding, one shared implementation for server and client predictor, single-room stepping, server-side
> A* gated on the explored bitset, and hold-to-drag, all built and heavily tested. Everything *around*
> movement is absent: no movement-point cost (`SECTOR_MOVE_COST` has zero callers), no encumbrance, no
> following, no grouping, no group exp, no tracks. Fleeing does not exist because combat does not.

### 3.8 Objects

One `struct obj_data`, 41 `type` values, and a generic `int value[8]` reinterpreted per type. There
are no subclasses: a corpse, a coin pile, a wand and a ship are the same struct. Selected decodes:

| Type | value[0] | [1] | [2] | [3] | Notes |
| --- | --- | --- | --- | --- | --- |
| LIGHT | colour | type | **hours left** (−1 = infinite) | | only hand slots burn fuel |
| WEAPON | class | numdice | sizedice | message | [5] packs up to 3 proc spell ids |
| ARMOR | **AC floor** | warmth | prestige | | authored value is a MAX, not the answer |
| CONTAINER | weight capacity (−1 = ∞) | lock flags | key vnum | size capacity (compiled out) | |
| MONEY | cp | sp | gp | pp | |
| CORPSE | contents weight | flags | level | mob vnum / PC pid | [4] exp loss, [5] racewar, [7] race |

Four parallel bitfields carry orthogonal concerns: `wear_flags` (where it goes), `extra_flags`
(glow/hum/nodrop/artifact/two-handed), `extra2_flags` (spell-grantable properties), and
`anti_flags`/`anti2_flags` (class and race gating) — which **invert from blacklist to whitelist**
when `ITEM_ALLOWED_CLASSES`/`ITEM_ALLOWED_RACES` is set in a *different* word.

**Location is a tagged union and NOWHERE is a mandatory waypoint.** `loc_p` ∈
`NOWHERE/ROOM/CARRIED/WORN/INSIDE`. Every mover refuses an object that is not already NOWHERE, and
every remover sets it back. Two-phase remove-then-add with a checkable invariant is what prevents
the classic duplication bug where a failed move leaves an object in two lists.

**AC is derived, not authored**: `apply_ac()` maps `material` to a base 0–9 (cloth 1, leather 3,
iron 5, steel 6, dragonscale 8, mithril 9), multiplies by a **wear-slot factor** (shield ×15, body
×4 or ×8, head ×1.5/×3, wrists/neck ×0.7, eyes ×0.4), takes `MAX` with the builder's authored
number, then scales linearly by `condition/100`. Builders pick a material and a slot and get a
plausible AC for free, and damaged gear degrades smoothly.

**Two carrying limits from two stats**: weight from a 52-row strength table (`str_app[].carry_w`,
5 lb at index 1 to 3,800 at index 51), and item **count** from dexterity
(`STAT_INDEX(dex)/3 + 6`). Worn items count **half** weight; coins are `#define`d to weigh literally
0 because of currency inflation. Container contents fold into the container's own `weight`, so a
prototype with a *negative* base weight is a bag of holding with no special case (`GET_OBJ_WEIGHT`
clamps at 0). There is a `recalc_container_weight()` repair pass, which is the tell that a
maintained cache like this drifts over a decade.

**"Stacking" is not a data structure.** `list_obj_to_char` renders each object, compares the string
to the previous one, and prints `[3] a torch` when they match — only for *adjacent* runs in list
order. Only coin piles genuinely merge.

> **Status.** Nothing here is built. Inventory, containers, equipment slots and the type/instance
> split are all specified in `DESIGN-inventory.md`, and that design **deliberately departs** from
> Duris in two places worth restating: capacity is a slot budget on the character rather than a
> Strength-derived weight budget (§2, flagged in the doc itself), and nesting is capped at depth 2
> rather than unbounded (§4). Both are defensible; the second closes a real Diku exploit outright
> rather than mitigating it. What we *do* have is `bestLight()`, which already takes a candidate list
> rather than a single source — so the "light is a property of any equipped item" rule in
> `DESIGN-inventory.md` §6 needs no change to its shape when equipment lands.

### 3.9 Mobs

**The action bitfield.** ~20 booleans on `specials.act` are the entire personality vocabulary of a
MUD monster. The combinations are what produce recognisable creatures.

| Flag | Effect |
| --- | --- |
| `ACT_SENTINEL` | will not random-wander — but see §4.11, it is not "immobile" |
| `ACT_SCAVENGER` | picks objects off the floor, evaluates them, and *wears the upgrades* |
| `ACT_STAY_ZONE` | leash: will not wander or hunt across a zone boundary |
| `ACT_WIMPY` | flees below `level * 6` HP |
| `ACT_MEMORY` | enables the grudge list — **and gates the entire hunt branch** |
| `ACT_HUNTER` | paths after remembered players, *overriding* SENTINEL and STAY_ZONE |
| `ACT_PROTECTOR` | assists |
| `ACT_PATROL` | replaces wandering with a route walker |
| `ACT_ELITE` | ×2.5 HP, ×1.2 damage dice, ×2.5 exp, ignores calming |
| `ACT_BREAK_CHARM` | rolls every AI pulse to break charm and turn on the charmer |
| `ACT_MOUNT`, `ACT_TEACHER`, `ACT_SPEC`, `ACT_SPEC_DIE`, `ACT_NO_BASH`, `ACT_NO_SUMMON`, … | |

**Aggression is a predicate, not a boolean.** Three separate 32-bit words on the NPC name
alignments, racewar sides, playable races, classes and sexes — `AGGR_ALL`, `AGGR_DAY_ONLY`,
`AGGR_NIGHT_ONLY`, `AGGR_GOOD_ALIGN`, one bit per race, one bit per class. `IS_AGGRESSIVE(m)` is
just "any aggro word is non-zero". This is what gives a world faction texture for free: orc camps
that ignore orcs, undead that rouse only at night, temple guards that attack anti-paladins
specifically. And critically, `CheckFor_remember()` makes a remembered player aggro-worthy **even
for a mob with no aggro bits at all** — so memory and aggression are mechanically the same thing,
which is why memory alone creates a nemesis.

**Aggression is never instant.** Entering a room schedules `event_agg_attack` some pulses in the
future, with the delay derived from the *mob's* agility:
`number(0, MAX(1, (22 - STAT_INDEX(agi))/2))`, longer again if the entrant was sneaking and got
detected. The event **re-validates everything** when it fires. This is the most-felt mechanic in a
MUD and the least likely to be reinvented: it is why you can run through a room of aggro mobs if you
are fast, and why the room description scrolls before the ambush lands.

**Target selection by weakness.** `PickTarget` scores every legal victim with `CountToughness` —
starting from HP, ×2/3 if a caster, ×2 if a warrior, ÷2 (÷4 for a thief attacker) if not yet
fighting — then applies a level-dependent random smear `val * 100 / number(100-foo, 100+foo)` where
`foo = MAX(0, 60 - victim_level)`, and picks the **lowest**. Low-level fights feel chaotic; high-level
fights feel deliberate. Aggro "stickiness" comes not from accumulated threat but from the
`number(1,400) <= Int/4 + level` check that gates mid-combat switching.

**Memory** is a linked list of player *ids* (so it survives logout), appended by `damage()` on
essentially every hit — including remembering the *master* when the attacker was a pet. It has no
timer. `forget()` exists and is called only by explicit gameplay: charm, bribery, spells.

**Hunting runs on its own faster clock.** `InitNewMobHunt` refuses if already fighting or below a
third HP, walks the zone's player list for a remembered target, builds BFS hints
(`BFS_CAN_FLY`, `BFS_AVOID_NOMOB`, `BFS_STAY_ZONE`, and — only if `level*2 + Int >= 190` —
`BFS_CAN_DISPEL` or `BFS_BREAK_WALLS`), **verifies reachability before committing**, then schedules
movement at 1.5 s against a 7.5 s deliberation clock. `TryToGetHome` sends a displaced sentinel back
to its birthplace, which is what stops a zone's population slowly draining into the road outside
after a night of players kiting things.

**Assist** uses a neat trick: `find_protector_target` scores candidates by *setting bits* in an
unsigned integer and taking the maximum — `BIT_32` my leader, `BIT_31` same vnum as me, `BIT_20`
justice guard defending same race, `BIT_1` charmed attacker. Precedence is positional, with no
comparator code and nothing to tune. "Same vnum as me" is what makes a room of six identical guards
behave as a squad without anyone authoring a squad.

> **Status.** Everything above is designed and none of it is built.
> `DESIGN-mobs-and-movement.md` covers §2.1 statistics, §2.2 reaction time, §2.3 three dispositions,
> §2.4 reach, §2.5 pursuit, §2.6 threat, §2.7 morale, §2.8 pulling as emergent, §2.9 pursuit tiers,
> §2.10 loot, §2.11 quest hooks. Two Duris mechanisms it does *not* cover and probably should: mob
> **memory keyed on character id** (the design implies pursuit but never names the grudge list that
> makes a mob aggro to you specifically), and **scavenging with equipment adoption** — a mob that
> reads your dropped gear, decides it is an upgrade, wears it and walks away with it is about 200
> lines and is memorable out of all proportion.

### 3.10 Magic and skills

Casting is not an instantaneous call. `do_cast` validates, applies command lag, sets `AFF2_CASTING`,
and schedules `event_spellcast`, which **reschedules itself every ≤4 pulses** — printing one `*` per
4 remaining pulses as a progress bar — and re-validates target, room, position and silence each time
before finally invoking the spell function. Cast time is
`skills[spl].beats * race_pulse_data * (1 + 0.03 * spell_pulse)`, ×0.3 under flurry, ×0.8 under
haste.

There is **no abort verb**: the interpreter refuses every command except `petition` and `return`
while casting. Interruption is entirely environmental — leaving the room, being bashed, stunned or
headlocked, an enemy's disruptive blow to the throat, or a **random fizzle**: a spell at the
caster's maximum circle rolls `number(0,100) > agility/2 + 50` and, if it hits, schedules an abort
at a random point during the cast. Your best spell is your least reliable one, and the mitigating
stat is Agility.

**Memorisation slots are affects.** A `TAG_MEMORIZE` node whose `modifier` is the spell id and whose
`MEMTYPE_FULL` bit means "ready"; casting either clears the bit and moves the node to the end of the
list (preserving mem order) or removes it. So mem state gets persistence, dispel, display and
partial death-punishment for free — death clears the ready bit rather than deleting the slot, so you
keep your slots and must re-memorise.

**Two independent gates, with different shapes.** Saving throws are a target number falling with
level (`starting - level*(starting-top)/60`, e.g. spell 70→30) with race and class deltas amplified
×5, rolled against d100, always leaving 1% either way. **Magic resistance** ("shrug") is separate and
binary — and `SKILL_SPELL_PENETRATION` punching through installs a short affect **on the victim**, so
subsequent spells in that window bypass resistance automatically.

**Area spells deliberately thin the crowd.** `cast_as_damage_area` builds the list of everyone
eligible, then computes a median around `pc_count/2` and randomly *skips* the surplus PCs (never the
explicit target). Stacking bodies is a defence, not a liability.

**Innates are purely derived.** Nothing is stored on the character: `has_innate()` computes an
unlock level from race/class/spec tables and compares it to level — respecting disguise and
race-change effects, so racial identity follows shapechanges for free. Passive innates re-set their
AFF bits on every stat rebuild. Active ones are gated by a `TAG_INNATE_TIMER` affect whose
`location` holds the innate id and whose `modifier` counts remaining **charges** that all refresh
together when the window expires — a burstier model than per-use cooldowns.

> **Status.** None of this exists, and it is the right thing to build last. Note the dependency
> though: with the affect system from §1.4 in place, most of a spell list is **content**. Without it,
> every spell is engineering.

### 3.11 Visibility and light

This is the one subsystem where we are ahead of the reference in some respects and behind in others.

**Ahead:** our visibility is tile-granular recursive shadowcasting with `Tile.Void` as the opaque
value, split correctly into transient `visible` and persistent per-Place `seen`, with `seen` shipped
as a base64 bitset and maintained by authoritative deltas rather than derived client-side. Light
radius is a genuinely derived stat with duration, expiry, an `expiresTo` chain and a warning ten
seconds out. Entity presence is resolved **per observer** — `visibleEntities` gates on the observer's
own lit set, so walking out of someone's torchlight produces the same `entityLeave` as walking out
of their room. Terrain is remembered and creatures are not. All of that is built, tested, and
documented in `DESIGN-visibility-and-light.md`.

**Behind, in two specific ways:**

1. **Light is not shared.** In Duris, `char_light(ch)` sums lights on a character into `ch->light`
   and then calls `room_light()`, which sums every occupant's light plus lit floor objects into
   `world[room].light`. One player's spell changes what **everyone else in the room** can see, and
   `get_vis_mode` scans the room's occupants for `AFF4_MAGE_FLAME` and `AFF4_GLOBE_OF_DARKNESS`.
   Ours is entirely per-carrier — even `rooms` mode illuminates only for the person holding the
   beacon. Group light management, the reason a party carries a lantern-bearer, does not exist.
2. **Vision is a scalar, not a classification.** `get_vis_mode()` returns one of six modes — god,
   normal, infravision, wraith, **too dark**, **too bright** — and `new_look()` branches to a
   different renderer for each, censoring a different category of content. Undead races are
   *dayblind* and fail in sunlight; ultravision races see only in the dark; infravision suppresses
   the room description entirely and refuses `look at`. A single `lightRadius` cannot express any of
   that, and races will want it.

One inherited detail worth copying deliberately rather than by accident: **a lit torch in your
backpack emits nothing.** Only lights in the wield/hold slots count, and only those burn fuel. The
inventory-scanning branch is commented out as "too cheesy". Light is a hand-occupancy cost, which is
exactly the trade `DESIGN-inventory.md` §6 is built around.

### 3.12 The interface

The pipeline is: socket bytes → line assembly → per-descriptor input queue → **one command dequeued
per 250 ms pulse** → command table lookup → a state-transition gauntlet → handler → per-recipient
rendering via `act()` → output queue → ANSI/paging/prompt at flush.

**The parser** is a single flat array of 855 command names searched exact-first, then
leftmost-prefix. **Table order is the tie-break**, which is why `n` is north and `sa` is say in every
Diku descendant. There is no scoring and no per-command alias list. Replace it with a hash map or
sort it alphabetically and every player's muscle memory breaks invisibly.

**Target resolution**: `get_number()` splits `"2.orc"` into ordinal and keyword; `isname()` then
matches **whole-word, no abbreviation** against an authored keyword list. `kill or` does not find an
orc. Commands abbreviate freely; *content keywords do not*. `generic_find()` searches in a fixed
order — chars in room, inventory, equipment, room objects, world chars, world objects — so
`wear ring` grabs yours rather than the floor's.

**Typing a command mutates the world.** Between lookup and dispatch sit ~300 lines of state machine:
falling rolls, water currents sweeping you, casting refusing everything, hide broken by an
**allowlist** of commands (look, listen, sneak, glance, read, steal, scan), meditation broken,
charmed NPCs rolling to disobey aggressive orders, and finally — if the command's row says
`check_aggro` — every aggressive mob in the room rolling to attack you. **Merely acting can start a
fight.**

Centralising the stealth break at the dispatcher rather than at each action site is the design
lesson: an allowlist at the one place every action passes through is auditable; scattered
`breakStealth()` calls will always be forgotten somewhere and players will find it.

**Channels are structural, not a subscription system.** `say` is the room filtered by altitude;
`yell` is the zone, or just the room if you are indoors, or a squared-distance radius on wilderness
maps; `gshout` is every descriptor; `tell` scans the descriptor list by exact name and applies
racewar, ignore lists, deafness and sleep; `gsay` iterates the group list so range is irrelevant.
Each channel's reach is derived from world structure, which is why they feel like different social
spaces rather than tabs. And `who` and `tell` are both **faction-filtered** — the enemy racewar side
is not merely hostile, it is invisible and unreachable through the interface.

> **Status.** We have a text log with five channels and no way to type into it. The protocol declares
> `say`, `look`, `open`, `close`, `attack`, `flee` and `ping`; the client sends **none of them** — only
> `moveTo`, `move`, `stop`, `steer` and the `hello` handshake. The MUD half of the hybrid is currently
> output-only. Note that our DOM log panel is genuinely *better* than the MUD's pager for reading
> scrollback, so §106 in the status index is a deliberate non-goal rather than a gap. Everything else
> in this subsystem is a gap.

---

## 4. What a modern developer gets wrong

Twelve of these, each with the argument for why the wrong answer is tempting.

### 4.1 Building one global combat round

`CLAUDE.md` says *"a 3 s combat round drives auto-attacks and ability resolution"*, and `ROUND_MS`
is already a constant. The natural implementation is a world-wide 3-second tick that resolves every
fight together.

Duris does not do this and the reason is worth taking seriously: with a global round, **every speed
stat collapses into "extra attacks"**. A fast dagger rogue and a slow ogre become the same actor with
different multipliers, haste becomes a damage buff, and the fight loses its texture. Duris gives each
character its own float `base_combat_round` and counts it down every pulse, so a fast fighter
genuinely interleaves swings between a slow one's.

`CLAUDE.md` already contains the escape hatch — *"Round length is data, not a constant sprinkled
through code"* — but `ROUND_MS = 3000` as a bare export is the constant, and the first combat
implementation will read it. **Make the round a per-actor field before writing the first attack.**

### 4.2 Collapsing position into one enum

Because stock Diku ships one, every clone copies it, and it looks like the obvious model. It cannot
express "prone and fighting" or "standing and bleeding out", which forces knockdown to become a
status effect bolted on the side, and then flee-from-prone and attack-from-prone need special cases
that contradict each other. Two orthogonal axes, one byte, and a packed minimum on each command. See
§1.3.

### 4.3 Applying and unapplying stat modifiers incrementally

`equip() { str += 2 }` / `unequip() { str -= 2 }` is the obvious pattern and it drifts the moment two
systems touch the same stat, or an item is destroyed while worn, or an affect expires mid-swap.
Duris' answer is total: strip to base, re-sum everything, every time — deferred and coalesced so N
changes cost one rebuild.

Two corollaries that are easy to miss:

- **Persist the wound, not the value.** If you store current HP and derive max HP, a gear change
  silently heals or kills the character. Store `maxHp - hp`.
- **The rebuild can kill.** Removing +hp gear during a recompute can drop HP below the death
  threshold; Duris' `affect_total` checks for it and calls `die()`, and every caller must be prepared
  for the character to no longer exist.

### 4.4 Dividing group experience by group size

Almost everyone assumes exp/N. Duris divides by `(N+3)/4`, so total party payout **rises** with size
and every member beats a fraction of solo. This is not a balance detail — it is the reason MUD
populations self-organise into parties with no matchmaking system. Get the sign wrong and solo play
is optimal, and the whole social layer that grouping, following, tanking, healing and consent exist
to support never forms.

### 4.5 Making aggression instant

A mob that attacks the frame you enter its room removes all skill from movement. Duris schedules the
attack some pulses out, with the delay derived from the mob's own agility, and re-validates when it
fires. That one number produces speed-running, sneaking past dangerous rooms, and the tension of
deciding whether to risk a corridor. `DESIGN-mobs-and-movement.md` §2.2 already has this right and
calls it *"the most mechanically valuable field in the whole model"* — the risk is that it gets
dropped as an optimisation during implementation.

### 4.6 Letting auto-attacks finish the helpless

If nothing stops attackers when a target drops below −2 HP, the incapacitated and dying states are
dead code: HP crosses −10 in the same round it crossed −3. `StopMercifulAttackers()` disengages
everyone except berserkers, aggressive NPCs and PCs who have explicitly opted in via `vicious`.
Killing a downed opponent becomes a *choice*, which is what makes the dying window a social mechanic
— allies can drag and heal you, and the killer had to decide.

Pair it with the damage clamp: HP can never fall below −11 in one blow. Death is a state reached by
crossing a threshold, not an arithmetic overshoot.

### 4.7 Assuming `wimpy` means auto-flee

It does not, on a PC. `GET_WIMPY(ch) > GET_HIT(ch)` in `aggressive_to()` merely suppresses **your
own auto-engagement** when you are hurt. Only mobs with `ACT_WIMPY` actually run away (below
`level * 6` HP). Everyone assumes the opposite, including, probably, the player who asks for it.

### 4.8 Treating item timers as a per-tick countdown field

Scanning every object every tick is O(all objects); a scheduled event is O(1) per expiry. Duris uses
scheduled `TAG_OBJ_DECAY` affects for everything, with exactly one exception — light fuel, on a
20-second loop, and only because it needs graduated warning messages ("flickers", "glows dimly",
"just went out"). Our carried-light burn is the same exception for the same reason, which is a good
sign; the general case still needs the scheduler.

### 4.9 Assuming repop means "restore the authored state"

Zone reset in Duris **only loads**. Nothing is ever despawned. Population converges because per-vnum
instance limits block over-spawning. Write a despawn pass and you change the game profoundly: a mob
lured three zones away is supposed to still be alive, still counting against the limit, and still
walking home.

Two subtler traps in the same code. First, an `M` command with a percentage below 100 **never fires
on a normal timed repop** — the gate requires `arg4 == 100` unless the repop is forced — so in
practice mob spawns are deterministic and *equipment* is the random layer. That is exactly the
rare-drop mechanic, and it arrived by accident. Second, a failed equipment percentage roll
deliberately sets `last_cmd = 1` before breaking, so one piece of a mob's kit failing its roll does
not suppress the rest of the chain. Reimplement the `if_flag` chain naively and a 5% helmet silently
suppresses the sword and shield below it.

### 4.10 Rendering one event and broadcasting it

`act()` re-expands the same authored string separately for every recipient, and `PERS()` returns
"someone", "a red shape", a race name, or a real name for the same character depending on who is
looking. **Send one structured event to a room and let clients render it, and you leak identities the
game deliberately hides.**

This is a live issue for us right now, not a future one. `sendToRoom` in `server/src/index.ts` sends
a **pre-rendered string**: `` `${player.name} says, '${text}'` ``. Every observer gets the same
sentence with the same name, including one who cannot see the speaker. Our *entity* visibility is
correctly per-observer; our *log lines* are not. Fixing it before there are twenty message sites is
much cheaper than after.

### 4.11 Believing a flag's name

`ACT_SENTINEL` does not mean immobile: the wander block runs anyway for a sentinel that is sitting
in a safe room, aggressive and above half health, on the design intent that a predator parked
somewhere safe should go looking for prey. `ACT_HUNTER` overrides both `ACT_SENTINEL` and
`ACT_STAY_ZONE`. And `ACT_HUNTER` **does nothing at all without `ACT_MEMORY`**, because the entire
hunt branch is inside an `if (IS_SET(act, ACT_MEMORY))` — a mob flagged HUNTER alone just wanders.
Flag dependencies like that are invisible in the data files and silently produce mobs that look
configured and are inert.

Related: comments lie about timings. `PULSE_MOBILE` is documented "10 seconds" and is 7.5. Zone
`lifespan` is documented in minutes but `age` increments once per 75-second tick, so a zone with
lifespan 40–50 actually repops every **50–62 real minutes**. Builders authored against the comment.

And some of the source is dead code that reads as live: `mobact_rescueHandle` opens with an
unconditional `return;` above ~80 lines of comrade-rescue logic, so the "shout for help and nearby
comrades charge in" mechanic the code appears to implement **is not running**. Check reachability
before inferring behaviour from a function body.

### 4.12 Assuming one affect per spell, and one meaning per field

`type` is not unique in the affect list — multi-apply spells install one node per `APPLY_*` location,
so dispel has an inner loop to skip runs and `affect_from_char(ch, type)` removes all of them. The
same `int duration` field silently changes units from game hours to pulses when `AFFTYPE_SHORT` is
set. `anti_flags` means "denied" or "the only ones allowed" depending on a bit in a *different* word.
`obj->value[8]` means eight different things per item type. `rlevel` is a required level for a skill
and a *circle* for a spell, disambiguated by `IS_SPELL()`.

The general lesson: this codebase reuses fields aggressively because 1995 memory was expensive. We
have no such constraint, and a discriminated union with a `t` tag — which `CLAUDE.md` already
mandates for messages and events — should be the default everywhere the MUD packs meanings into one
integer.

---

## 5. What our architecture makes easy, and what it makes hard

### 5.1 Genuinely easy

**Server authority and the intent/fact split are already right.** The protocol header states it
plainly and the code honours it: `moveTo` sends a destination, never a route, and the pathfinder runs
server-side precisely so a modified client cannot path through fog. Every MUD mechanic is
server-authoritative by nature, so nothing in this document fights that.

**Room-scoped interest management is already the MUD's own unit**, and it is already implemented
with the correct second gate layered on top: room scope for bandwidth, tile-level light for
gameplay. `visibleEntities` resolving presence **per observer** is the same instinct as `ac_can_see`,
and it means "standing still in the dark works" is true today rather than aspirational.

**Determinism is in place and is used.** Seeded mulberry32 RNG in `shared/rules`, a `WORLD_SEED` in
`pickups.ts`, and a stated ban on `Math.random()` in simulation. Every aggression roll, loot roll and
combat roll can be replayed. `DESIGN-mobs-and-movement.md` §2.3 already routes the territorial
provoke roll through it.

**Room ids are the MUD's own vnums.** That is the join key to 447 `.wld`, 446 `.mob`, 443 `.obj`,
443 `.zon` and 265 `.qst` files sitting on disk right now. Every taxonomy in this document has real
authored data behind it — subject to the 21%-overlap caveat in §0.

**We have a tile grid, which the MUD did not.** Line of sight, reach, area-of-effect shapes, facing,
and cover are all *free* for us and were impossible there. `DESIGN-mobs-and-movement.md` §2.4 already
banks this: a spear or breath weapon striking across a 9×9 room is a real tactical quantity that no
MUD could express.

**The derived-stat discipline exists, on a sample of one.** `lightRadius` is documented as derived,
with a single derivation point and a cache key that includes the radius so there is no separate
invalidation to forget. Generalising that to a full affect system is extending a pattern already in
the codebase, not importing a foreign one.

### 5.2 Genuinely hard

This is the honest half. Our rooms are 288 px squares crossed in 1.9 seconds; a MUD room is a point.
Five specific collisions follow, in descending order of how much they will hurt.

#### (a) Combat range destroys engagement unless we decide otherwise

In a MUD there is no distance inside a room. Engagement is a *pointer*: once `set_fighting` runs, you
are in that fight until someone dies, flees, or is rescued. Disengaging is a **verb with a chance and
a cost** — 78–86% depending on exit count, 20–30 vitality, sneak stripped.

With continuous movement, "walking away" is free. Max intra-room distance is ~11.3 tiles (362 px);
at `PLAYER_SPEED` 150 that is 2.4 seconds to close or open, which is **less than one 3-second combat
round**. A player who kites at melee reach never gets hit, and the moment that is true, tanking,
threat, rescue, front/back rank and the entire mercy-rule/dying window stop meaning anything —
because nobody is ever pinned.

There are three coherent answers and no coherent middle:

1. **Engagement is sticky (MUD-like).** Being in a fight is a state. While engaged, melee resolves
   regardless of distance within the room, and leaving requires the `flee` verb with its roll and its
   cost. Distance then affects *approach and positioning*, not whether you can be hit.
2. **Pure distance (action-RPG).** Attacks require reach every round. This is coherent but it deletes
   most of §3.6 — accept that combat becomes positional and drop threat, rank and rescue.
3. **Sticky with a leash.** Engaged until distance exceeds some threshold for some duration, at which
   point a flee roll fires automatically.

**This decision blocks combat and should be taken explicitly and written down.** Making it
implicitly, by writing a range check into the first attack handler, is how option 2 wins by default.

#### (b) "In a room" is ambiguous, and it is ambiguous *today*

`roomAtTile` returns −1 in a corridor, and `Player.roomId` deliberately keeps the last real room. So
a character standing between two rooms is, for interest-management purposes, in the room they left.
That is a good decision for entity sync. It is an unresolved one for:

- **Area spells.** Do they hit "everyone in the room" (including a character 3 tiles down a corridor
  who is nominally still in it) or "everyone within a radius"? The two disagree at every room edge.
- **Room affects.** A `no_magic` or `heal` room whose boundary is 9 tiles wide is a place you can
  stand half-in.
- **Aggro on room entry.** Which tile fires it? Crossing into the first floor tile, or the corridor
  before it?
- **Assist calls and `assistRange`** measured in rooms, from an actor who is in a corridor.
- **`ROOM_SINGLE_FILE`, crowding budgets, front/back rank.** All of these are structures over a room's
  occupant *list*. We have 81 tiles and real positions, so they are either unnecessary or need
  reinterpreting as geometry.

The cheapest fix is to decide, once, that **room membership is `Player.roomId`** — the room-graph
answer, not the geometric one — and that every room-scoped mechanic reads it, with radius-based
effects being a separate and clearly named category. Deciding it per-mechanic guarantees
inconsistency.

#### (c) Fleeing has nothing to be a verb about

`do_flee` picks an exit, rolls against a chance derived from **how many exits the room has**, and
teleports you one room. That makes dead ends traps and room topology tactical. In our world you just
walk, and every room is a dead end only in the sense that a wall is 288 px away.

If engagement goes sticky (option (a) above), flee recovers its meaning as "the action that breaks
engagement" and the exit-count formula can stay. If it does not, flee is decoration.

#### (d) Light is per-character, and a party needs shared light

Our whole light model is per-carrier: `Player.light` → `lightRadius` → `player.visible`. Duris
computes `char_light` → `room_light` and every occupant reads the room's total. That is why a party
has a lantern-bearer and why a *globe of darkness* is a weapon.

Making light shared is not a small change here: `computeVisible` is keyed on one character's tile and
radius, `visible` is per-player and cached against that key, and `seen` is folded per character. A
shared model means visibility becomes a function of the room's occupant set, and the cache key grows
a dependency on other players' state. It is doable — the `rooms`-mode branch already keys on room
rather than tile — but it should be scoped before it is promised.

#### (e) Nine-by-nine rooms make some MUD structures unnecessary and others incoherent

`ROOM_SINGLE_FILE` — where the occupant linked list *is* a corridor queue and two characters swap
places when they bump — is genuinely elegant and completely redundant for us: we have a 3-tile-wide
connector and real collision, so a corked corridor is emergent. Good.

But the crowding budget (`sum(2^attacker_size) <= 8 * 2^victim_size`) and the front/back rank
invariant exist to give a *point-like* room an interior. Ours has one. So either we drop them and let
geometry do the work — which loses the deliberate, readable "the healer is in the back line" that
players think in — or we reimplement them as spatial rules, which is new design rather than porting.

There is also a pacing consequence nobody has costed: **a MUD room is a decision and ours is a walk.**
`describeRoom` fires on entry; at 1.9 s per room, prose that reads well once every few seconds in a
MUD becomes a wall of text. `PLR_BRIEF` existed for exactly this reason, and we have no room
descriptions at all yet to be brief about.

---

## 6. What to build next

> **The schedule is [ROADMAP.md](ROADMAP.md).** This section is the *dependency* argument — what
> unblocks what — and it stays here because the reasoning is worth keeping. The roadmap re-cuts the
> same work so that every phase ends in something visible, and folds the load-bearing items below
> into the first phase that needs them. Where the two disagree about order, the roadmap is the plan.

Ordered by what unblocks the most, not by what is most visible. Tiers 0 and 1 are load-bearing;
tier 2 is largely content once tier 0 exists.

### Tier 0 — load-bearing. Everything else is cheaper after these, and more expensive before.

**1. A generic timed-effect ("affect") system with full recompute from base.**
This is first because it is the substrate for combat states, buffs, debuffs, poison, cooldowns,
skill-notch rate limits, item durations, quest state, PvP timers and mob AI markers — and because
retrofitting it means rewriting every one of them. Concretely: one record with `type`, `duration`,
`modifier`, an `apply` selector and boolean flags; one list per entity; deferred coalesced rebuild;
persistence with a "do not save" flag. Preserve the *wound* (`maxHp - hp`) rather than the value.
Extend the existing `lightRadius` derivation into it rather than alongside it — the design docs
already say the carried-light field *"should collapse into"* the equipment-derived one.

**2. Posture and status as two orthogonal axes, plus a legality gate on every action.**
Cheap now, invasive later, because it changes the signature of every action. Add
`posture: 'prone'|'sitting'|'kneeling'|'standing'` and
`status: 'dead'|'dying'|'incapacitated'|'sleeping'|'resting'|'normal'` to the character, derive
status from HP by a pure function, and give every client message a declared minimum of both. Movement
already exists and will be the first consumer.

**3. A server-side event scheduler.**
One `setInterval` walking every player is correct for four players and wrong for a world with mobs,
decay, cooldowns, per-actor combat clocks and spell casts. A timing wheel or a binary heap keyed on
tick, with self-rescheduling handlers, is maybe 150 lines and it is the mechanism that makes
mechanisms 1, 5, 6 and 8 all one shape instead of four. It also fixes the per-actor-round problem in
§4.1 by construction.

**4. Generalise `Player` into an actor.**
`sim.ts` is written in terms of `Player`; `playersIn`, `viewOf`, `visibleEntities` and `syncEntities`
all assume it. Mobs need to be the same kind of thing — same position, same room membership, same
visibility gating — or every one of those functions grows a second branch. Do this before mobs, not
during.

**5. Decide the engagement model, and write it down.** §5.2(a). This is a design decision, not code,
and it gates the entire combat subsystem. It should become a short design doc of its own, or a
section appended to `DESIGN-mobs-and-movement.md`.

### Tier 1 — what makes it recognisably a MUD

**6. Mobs, with spawn and reset.**
`DESIGN-mobs-and-movement.md` §2 is the spec and it is good. Build in this order: template loading →
spawning from a zone reset table (additive, per-vnum limits, randomised lifespan band) → the
aggression predicate → **delayed reaction with revalidation on fire** → memory keyed on character →
pursuit on the room graph. Add mob memory to the design doc first; it is the mechanism that turns an
encounter into a relationship and it is currently missing from §2.

**7. Combat.**
Engagement as a state per the tier-0 decision; a **per-actor round clock** rather than a global one;
the threat table with hysteresis from §2.6; the mercy rule and the damage clamp so the dying window
is real; death → corpse → full loot → corpse retrieval. Use `resolveAttack` and `rollDamage`, which
are already written and tested and have never been called. Award experience from damage and from
being attacked, not only from the killing blow — that one choice is what makes tanking and healing
viable with no role system.

**8. Items, inventory and equipment.**
`DESIGN-inventory.md` is the spec. The forcing function is that light must come from equipped items
(`DESIGN-inventory.md` §6, `DESIGN-visibility-and-light.md` §3), AC must come from gear, and corpses
in mechanism 7 need something to hold. Also replace the deliberately-interim per-character ground
pickup with real world objects — `pickups.ts` documents its own simplification as temporary.

**9. A command input surface.**
This is what makes it a *graphical MUD* rather than an action RPG with a chat panel, and it is
currently a hole: the client sends four message types and cannot say a word. It needs a text entry
that produces intents, a command table with deliberate abbreviation priority, and target resolution
by ordinal and keyword. Note the two rules worth copying exactly: content keywords match whole-word
and do not abbreviate, and stealth breaks at the **dispatcher** by an allowlist, never at each
action site.

**10. Per-recipient message rendering.**
Replace `sendToRoom(pre-rendered string)` with an authored template rendered once per observer, so an
unseen actor is "someone". §4.10. Do it while there are three message sites rather than thirty.

### Tier 2 — depth and content

Once the affect system and the scheduler exist, most of this is content authoring rather than
engineering.

11. **Skills as percentages** with notch-by-use, the per-category rate limit, and the level-driven
    floor. Mobs derive proficiency from level and class and store nothing.
12. **Following and grouping**, with consent, and the superlinear exp split from §4.4. Move followers
    by re-issuing the movement intent, not by teleporting them.
13. **Movement points and encumbrance.** `SECTOR_MOVE_COST` and `SECTOR_REQUIRES_MOVEMENT` are
    already written and have zero callers; `move`/`maxMove` are already on the wire.
14. **Room flags, harvested from the Duris `.wld` bitfield** for the 44 matched zones, hand-authored
    for the rest. This unblocks `respectsSafeRooms` in `DESIGN-mobs-and-movement.md` §2.9,
    `no_magic`, `peaceful`, `indoors` and `dark`. Do the same pass for `sector_type` — it replaces
    the 23.2% of rooms currently guessing their terrain — and for room descriptions, of which we
    presently have zero.
15. **Spells**, which the affect system makes mostly declarative: cast time as a self-rescheduling
    event, environmental interruption, two independent resistance gates, area targeting.
16. **Channels, shops, quests, classes and races.**

### Explicitly not yet

Hunger, thirst and aging. Duris built all three, shipped them, and switched them off. Racewar
faction filtering on `who` and `tell`. Paging — our DOM log is better. Charm with a betrayal clause,
mounts, and tradeskills are all fine content, later.

---

## Appendix: where each mechanism lives in the source

For anyone re-reading the original. Paths are relative to
`D:\MyGame\data\zones-source\duris\src\`. **These files are large — `magic.c` is 667 KB. Grep and
sample; do not read whole files.**

| Subsystem | Files | Key symbols |
| --- | --- | --- |
| Combat | `fight.c`, `actoff.c` | `perform_violence`, `calculate_attacks`, `pv_common`, `chance_to_hit`, `calculate_thac_zero`, `raw_damage`, `StopMercifulAttackers`, `die`, `make_corpse`, `kill_gain`, `bash`, `backstab`, `do_flee` |
| Position | `defines.h`, `utils.h`, `fight.c` | `POS_*`, `STAT_*`, `GET_POS`, `GET_STAT`, `MIN_POS`, `calculate_ch_state`, `update_pos` |
| Affects | `affects.c`, `structs.h` | `affected_type`, `affect_to_char`, `affect_remove`, `affect_join`, `all_affects`, `affect_total`, `apply_affs`, `affect_update`, `initialize_links`, `check_room_links` |
| Character | `structs.h`, `constant.c`, `limits.c`, `guild.c`, `nanny.c` | `stat_data`, `str_app`..`cha_app`, `STAT_INDEX`, `calculate_hitpoints2`, `hit_regen`, `advance_level`, `update_skills`, `notch_skill`, `do_practice` |
| Movement | `actmove.c`, `group.c`, `sparser.c` | `move_cost`, `load_modifier`, `leave_by_exit`, `can_enter_room`, `do_simple_move_skipping_procs`, `add_follower`, `group_add_member`, `on_front_line` |
| Objects | `handler.c`, `affects.c`, `condition.c`, `db.c` | `obj_data`, `obj_to_char`, `equip_char`, `apply_ac`, `char_light`, `room_light`, `obj_can_nest`, `DamageOneItem`, `read_object` |
| Mobs | `mobact.c`, `db.c`, `utility.c`, `shop.c` | `event_mob_mundane`, `PickTarget`, `CountToughness`, `remember`, `InitNewMobHunt`, `event_agg_attack`, `aggressive_to`, `reset_zone`, `shop_keeper` |
| Magic | `sparser.c`, `memorize.c`, `magic.c`, `innates.c` | `do_cast`, `event_spellcast`, `NewSaves`, `find_save`, `use_spell`, `handle_memorize`, `spell_dispel_magic`, `has_innate`, `resists_spell` |
| Interface | `interp.c`, `comm.c`, `actinf.c`, `handler.c` | `command_interpreter`, `old_search_block`, `special`, `act`, `make_prompt`, `new_look`, `get_vis_mode`, `isname`, `generic_find` |
| Timing | `config.h`, `new_events.c`, `events.c` | `OPT_USEC`, `PULSE_VIOLENCE`, `PULSES_IN_TICK`, `add_event`, `CharWait`, `StartRegen` |
| Data files | `../areas/{wld,mob,obj,zon,qst}/` | 447 / 446 / 443 / 443 / 265 files |
