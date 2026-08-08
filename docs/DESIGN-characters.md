# Characters — the decisions Phase 21 cannot be started without

_2026-08-08, written before any code, the way the skills, spells and accounts notes were. Three
decisions are the owner's, taken today: **nine races** (the Toril seven plus Drow and Duergar,
racewar excluded — races are stats, senses and flavour, and everyone may group); **nine classes**
(the Toril core: Warrior, Ranger, Paladin, Cleric, Druid, Shaman, Sorcerer, Necromancer, Rogue);
**words to roll, numbers to play** (creation shows Duris's stat words, the sheet afterwards shows
5e scores and modifiers). Everything else below follows from the project's settled precedent —
**the SRD sets the shape, Duris sets the magnitudes** (`DESIGN-progression.md`) — applied to the
tables actually found in the source, properties files included, which this note transcribes rather
than paraphrases._

_What already exists and is waiting: accounts (Phase 20b — creation now has somebody to create
for); `proficiencyBonus` in shared with zero non-test callers; `devProfile`/`restoreProgress` in
`index.ts` as the named derivation seam 14b left; `shrugChance(raceCode, …)` pinned by tests and
rolling for nobody, because no player has a race code yet. This phase is largely the act of giving
those seams their inputs._

---

## 0. The found facts, so nobody re-digs them

- **The roll** (`roll_basic_attributes`, `actwiz.c`): ten stats on 1–100, a normal player roll is
  `3d6 + 77` per stat. Class is fixed *before* the roll (Krov's comment), and the roll respects
  `min_stats_for_class[class][8]` (`constant.c:1379`).
- **Racial magnitudes are data, not code**: `stat_factor[race]` loads from `lib/duris.properties`
  (`db.c:737`, default 100). The live values for our nine races are transcribed in §3 — Human is
  the all-100 baseline; Barbarian Str 155 / Con 165 / Int 70 is the loudest row.
- **Five bonus points after the roll** (`stats.bonus.Human=5.000`) — a bad roll is a starting
  point, not a reason to disconnect.
- **Words, not numbers** (`stat_to_string2`, `actinf.c:193`): the ladder is *lame → poor → below
  average → average → above average → good → very good → excellent → quite excellent*.
- **A new spell circle every five levels** (`advance_level`, `limits.c`: `level % 5 == 1`) —
  circles open at 1, 6, 11, 16, 21….
- **Racial innates arrive at levels** (`innates.c:469–560`): Drow get ultravision at 1, levitate
  at 11, globe of darkness at 26, plus magic resistance, faerie fire and **sun vulnerability**;
  Duergar get ultravision, underdark invisibility/sneak, enlarge at 26, battle frenzy at 16 —
  and sun vulnerability. Magic resistance is *not* underdark-only: Grey Elves, Half-elves and
  Wood Elves carry it too.
- **Sizes** (`race_size`, `common.c`): Halfling and Gnome are SMALL; the other seven are MEDIUM —
  including both dwarves.
- **Which race/class combinations exist is a boot-time data file**
  (`lib/creation_availability.cfg`) — a pattern worth keeping: our lists are data too.

## 1. Six abilities, folded from ten

SRD shape: **STR, DEX, CON, INT, WIS, CHA**, scores on 3–20, modifier `floor((score − 10) / 2)`,
and the modifier is what every rule consults. The fold from Duris's ten:

- **Agi folds into DEX** — the racial factor is the *mean* of the source's Dex and Agi factors
  (Drow 110/130 → 120). One stat where the source had reflexes and fine hands apart.
- **Pow is dropped as a score** — its job (mana size) survives as §3's per-race mana column,
  which is where `racial_data` already kept it.
- **Kar and Luk are dropped entirely** — the player never saw them, and a hidden stat is a debug
  session waiting to happen.

**The roll**: **4d6 drop the lowest** per ability — the owner's follow-up (2026-08-08, *"stats
rolls that can be rerolled according to DnD rules"*) naming the SRD's own standard method, which
supersedes this note's first draft of a flat 3d6 — **racial bonus applied inside the roll** (the
source's own keeper: no combination can produce an impossible score), clamped 3–20. The racial
bonus derives
from the live factor table: **bonus = round((factor − 100) / 15)** — chosen so the loudest row in
the data (Barbarian Con 165) lands at **+4** and ordinary favours (110–120) land at +1, which is
5e's own racial range. **Five bonus points** follow, +1 each, no score past 18 + racial bonus.
Rerolls are unlimited — this is a friends server, and the bonus points already make a mediocre
roll playable; the points reset with each roll.

**Class minimums** transcribe by dividing the 100-scale table by five: Warrior needs Str 11 /
Con 11; Sorcerer and Necromancer need Int 15; Rogue needs Dex 15 / Agi-folded-DEX high; Paladin
needs Wis 13 / Cha 10. The roll re-rolls any ability under its class minimum up to it — the
source's own behaviour, and why class comes before the roll.

**Words to roll — and, by the owner's third ask (2026-08-08), numbers beside them**: *"the actual
number as well… so they don't spend all day trying for a maxed out character or accepting a dud."*
The card shows "good 15", both halves tracking the bonus spend live, over a plain paragraph naming
the dice, the range and the average; the sheet afterwards stays numbers alone. The card renders
each score through the word ladder
mapped onto 3–20 (3–4 *lame*, 5–7 *poor*, 8–9 *below average*, 10–11 *average*, 12–13 *above
average*, 14–15 *good*, 16–17 *very good*, 18–19 *excellent*, 20 *quite excellent*). The character
sheet after creation shows `16 (+3)`.

## 2. What the scores do — the readers, which are the point

A score nobody reads is decoration. Each ability gets at least one reader wired **in this phase**,
each onto a system that already exists:

| Ability | First readers |
| --- | --- |
| STR | melee damage bonus (into `landBlow`'s damage, beside the gear bonuses); carry capacity (`STARTING_CAPACITY` becomes STR-derived) |
| DEX | AC contribution (beside Phase 16's armour); dodge/parry chance feeds (Phase 19's defence rolls) |
| CON | hit points per level (§4's hit dice); the drowning clock (Phase 19's swim) |
| INT | arcane mana pool (Sorcerer, Necromancer) |
| WIS | divine mana pool (Cleric, Druid, Shaman; Paladin/Ranger half-pools) |
| CHA | shop prices (Phase 17's buy/sell spread tilts by modifier) |

`derive(record)` replaces `devProfile`: hp = class hit die per level + CON mod (rolled once per
level and stored, 14b's rule); mana = class pool × race's mana factor; attack bonus =
`proficiencyBonus(level)` + STR mod — **the zero-caller finally gets its caller.**

## 3. The nine races, one table

Live factors from `duris.properties`; folded bonus per §1's formula; senses/quirks from
`innates.c`; mana/vitality from `racial_data`.

| Race | Code | Folded bonuses | Size | Senses & quirks |
| --- | --- | --- | --- | --- |
| Human | PH | none | M | none — the baseline, and the only race with **no** MR |
| Barbarian | PB | +4 STR, +4 CON, −2 INT, −1 DEX, −2 CHA | M | none; mana 45%, the non-caster's race |
| Grey Elf | PE | +1 DEX, +1 INT, +1 WIS, +1 CHA, −1 STR, −1 CON | M | infravision, **MR** |
| Wood Elf¹ | WE | — | M | — |
| Mountain Dwarf | PM | +2 STR, +1 CON, +2 WIS, −1 DEX, −1 INT, −1 CHA | M | infravision, **magical reduction** — 20% off *generic* spell damage |
| Duergar | PD | +2 STR, +2 CON, +2 WIS, −2 INT, −2 CHA, −1 DEX | M | ultravision, **no MR**; **magical reduction** instead — 20% off *generic* spell damage; underdark sneak, **sun-vulnerable** |
| Halfling | PF | +2 DEX, +1 WIS, +1 CHA, −1 POW→— , −0 STR | S | infravision-less; the sneak race |
| Gnome | PG | +2 INT, +1 DEX, +1 AGI→DEX, −1 STR, −1 CON | S | infravision |
| Half-elf | P2 | +1 everywhere but STR/CON (the generalist) | M | infravision, **MR** |
| Drow | PL | +2 DEX (110/130), +1 INT, +1 WIS, +1 CHA, −1 STR, −1 CON | M | **ultravision, MR, faerie fire, levitate@11, globe@26, sun-vulnerable** |

¹ Wood Elf is **out**: the owner picked nine and Wood Elf was not among them; the row exists in
the source table should it ever be wanted. (Codes are the source's mob race codes — the same
namespace `shrugChance` already keys on, which is the whole trick of §5.)

_Corrected 2026-08-08, `DESIGN-spell-memory.md` §6's true-up: **the duergar row said "MR-adjacent
(magical reduction)" and the code read that hedge as `true`.** They are not the same gate.
`assign_innates` gives duergar — and mountain dwarves — `MAGICAL_REDUCTION` (`innates.c:552`,
`473`), and its only reader in the whole source is a damage-modifier predicate that takes 20% off
**generic** spell damage (`fight.c:3817`); `resists_spell` tests `INNATE_MAGIC_RESISTANCE` and
nothing else (`innates.c:3757`). So a duergar never rolls the shrug, and `races.ts` now says
`magicResistant: false`. Damage reduction is real and unbuilt — parked in §6 of that note. Of our
nine, three carry MR: Grey Elf, Half-elf, Drow._

_Completed the same day: **the dwarves have their armour.** `Race.magicalReduction` is built and
wired, so the two rows above no longer point at an unbuilt mechanism — a duergar or mountain dwarf
takes **20% less generic spell damage**, multiplicatively, silently, after the gates have already
decided the spell lands. **Generic and nothing else**: the reader is a `switch` with one `case` and
no `default` (`fight.c:3817`), so fire, cold, lightning and the other eight `SPLDAM_` types
(`damage.h:91-103`) land on a dwarf in full. Of our own six damaging spells only magic missile and
earthquake qualify — a duergar takes burning hands whole, which is the half nobody guesses. Both
grants are level 1 (`innates.c:473`, `552`) so there is no level column to add. **It keys on the race
code, not on being a player**, exactly as the shrug gate does, which arms the 25 dwarves and duergar
already standing in the harvested world. So of our nine, three shrug and two are armoured, and no
race does both — the source gives each of these two families one and only one answer to magic.
`DESIGN-spell-memory.md` §6 carries the citations and the drive numbers._

Exact folded numbers are computed from the factor table *in code* at boot, not hand-copied into a
second table that can drift — the rows above are what the formula yields today, recorded for
review.

## 4. The nine classes, one table

| Class | Group | Hit die | Mins (folded) | Casts | Circles |
| --- | --- | --- | --- | --- | --- |
| Warrior | warrior | d10 | STR 11, CON 11 | — | — |
| Ranger | warrior | d10 | STR 8, DEX 8, CON 8, INT 8 | divine, half | opens at 11 |
| Paladin | warrior | d10 | STR 11, CON 10, WIS 13, CHA 10 | divine, half | opens at 11 |
| Cleric | priest | d8 | STR 8, WIS 11, CHA 10 | divine, full | every 5 levels |
| Druid | priest | d8 | INT 10, WIS 13, CHA 8 | divine, full | every 5 levels |
| Shaman | priest | d8 | INT 10, WIS 10, CHA 8 | divine, full | every 5 levels |
| Sorcerer | wizard | d6 | INT 15, WIS 3 | arcane, full | every 5 levels |
| Necromancer | wizard | d6 | INT 15 | arcane, full | every 5 levels |
| Rogue | rogue | d8 | DEX 15, INT 6, CHA 6 | — | — |

**Spell knowledge, the cut that makes nine classes buildable now**: a caster *knows* every
registry spell of their class list whose circle has opened — no spellbooks, no scribing, no
per-spell memorization times (all recorded as follow-ons in `DESIGN-spells.md`'s inheritance
list). What limits casting is **slots per circle**, refilled by the rest/regen system that
already ticks: SRD's slot shape, Duris's five-level circle cadence.

**Who casts what, from the registry Phase 20 shipped**: Cleric — cure light, cure serious, bless,
armor, earthquake, continual light. Druid — cure light, barkskin-shaped `armor`, earthquake, ice
storm. Shaman — cure light, cure serious, bless, chill touch. Sorcerer — magic missile, burning
hands, shocking grasp, stone skin, fireball, ice storm. Necromancer — chill touch, magic missile,
burning hands. Paladin/Ranger at 11+ — cure light; bless for the Paladin. The lists are data
(`classes.ts`), sized to today's registry, and grow as the registry does.

**Skills fold in by group**: Phase 19's built skills map to groups — bash/rescue/kick to
warriors (and Rogue kick), dodge to all, parry to warriors/rogues, swim to everyone — with
per-group ceilings in the class table, replacing today's flat level-driven floor.

## 5. Magic resistance goes live

`shrugChance(raceCode, level)` rolls for whatever `MAGIC_RESISTANT_RACES` names. A player character
gains `race.code`, and the shrug gate — dormant since Phase 20 because "players are raceless" —
fires for drow, grey elves and half-elves. **No new arithmetic**; the tests that pinned it stay the
authority.

_Corrected in the building (slice 1's drive, 2026-08-08): this section originally claimed the
player codes enter "the same namespace" the gate already keyed on. **There are two namespaces.**
The gate's set held the *harvest's* mob codes (`DR`, `DE`, …); `defines.h`'s player codes (`PL`,
`PD`, `PE`, `P2`) are a different dialect, and the first live drow arrived at the gate as `PL` and
shrugged nothing — found by a temporary chance-log at the call site, chance=0 where 5 was owed.
The set now speaks both dialects, additively, with the pinned mob expectations untouched._

_Amended 2026-08-08 (`DESIGN-spell-memory.md` §6's true-up), on three counts._ **Duergar are not
one of them** — see the note under §3's table; the gate's set held `PD` on a hedge and now does
not. **The gate held no racial bases at all**, so every race it did name sat on the source's 5%
floor: a drow was exactly as hard to nuke as a wood elf, and this section's "goes live" was live at
one twentieth of its intended strength. The bases are the live server's own — `innate.shrug.DrowElf`
and friends, `duris.properties:1899-1938` — and they now ride the same table as the codes, so a code
and its number can never drift apart. At the top of our band, level 30: **drow and grey elf 17%,
half-elf 8%**, all three up from 5. And **the mob half of that "second dialect" was not a dialect at
all** — four of its eight codes matched no race in `race_names_table`, which is the correction the
note's §6 records. None of it was reachable: no mob in the loaded world carries one._

**Sun vulnerability** is the one racial *penalty* built now (both underdark races): in a sunlit
outdoor room, −2 to hit and a system-channel line on entry (*"The cursed sun of the surface world
burns into your skin!"* — the source's own words, `handler.c:294`). The light system knows what
sunlit means; this is a reader, not a mechanism. Levitate, faerie fire, globe of darkness and the
duergar actives are **follow-ons** — innate *actives* need the innate-command surface, and
passive senses (ultravision = see in darkness the way infravision already works) ride the
existing vision system.

## 6. Creation, on the wire — protocol 24

The 20b handshake grows a conversation between `account` and `enter`:

```
C→S  charCreate { name, race, class }     name passes the name law; combination passes the matrix
S→C  charRolled { words: {str:'good',…}, bonus: 5, mins: {...} }
C→S  charConfirm { spend: {str:2, con:3} }  — or —  charCreate again (reroll, bonus resets)
S→C  account …                            the new character in the list; client enters it
```

_Corrected in the building (slice 3): `charBonus` folded into `charConfirm` — the spend rides the
confirm, one refusal path instead of two. And one wire lesson: the client's send-queue must treat
the whole creation conversation as handshake traffic, or `charCreate` queues behind the `welcome`
it exists to cause._

The picker's "a new name" form becomes the door into this: name → race card (art, one line of
flavour, the word-bonuses) → class card → the roll, in words, with reroll and five points to
spend. `authFailed` stays the refusal carrier throughout.

**Legacy characters adopt on entry**: a record with no `race`/`class` (every save that predates
this phase) routes into the same conversation minus the name step on its next `enter`, keeping
its level, map, kit and purse. Aldric16 walks in as whatever Danny decides Aldric16 always was.

## 7. Channels — the phase's third word

Four, all thin, all one slice: **gossip** (world-wide, the social hum), **tell/reply**
(person-to-person anywhere — the whisper row's second half), **gsay** (the group the roster
already draws), **who** (who is on, with race/class now worth showing). `LogChannel` gains
`gossip` and `tell`; everything else is command parsing and routing through fan-outs that exist.
Room-scoped `whisper` stays with its parking-lot row (it is presentation, Track V's kind).

## 8. Quests — the fourth word, cut honestly

Duris's quest system is thousands of lines of tokens, bits and specials. The phase ships **one
mechanism and one authored quest**: a questmaster mob flag, `quest` to hear the ask, an objective
(kill N of a vnum / bring an item), `quest done` to turn in, XP + coin from the pools that exist,
state on `PlayerRecord.quests`. Authored as override data so the admin panel can grow an editor
(Track A row). The full token economy is post-phase content work, recorded in §10.

## 9. Slices, in order

1. **Abilities** — `shared/src/abilities.ts` grows scores/mods/words/roll-with-race;
   `races.ts` + `classes.ts` data tables; `PlayerRecord` stores `race`, `class`, `abilities`;
   `derive()` replaces `devProfile`; the §2 readers wired; race codes onto entity views →
   **the shrug gate lives**. The mandatory first commit.
2. **Slots and class lists** — circles from level, slots per circle, `cast` refuses what your
   class does not know; mob casters unaffected.
3. **Creation** — protocol 24, the conversation, the client cards, legacy adoption.
4. **Skills by class** — group ceilings replace the flat floor.
5. **Channels** — gossip/tell/gsay/who.
6. **Sun and senses** — vuln-sun reader, ultravision-as-infravision.
7. **The quest** — mechanism + the one authored quest.

## 10. Explicitly not in this phase

Memorization times and spell slots-as-mem, spellbooks and scribing, ground-casting, penetration
and globes (all `DESIGN-spells.md` inheritance, still parked); multiclassing (`class` is stored
as a single value; Duris's bitmask shape is why the field is not an enum); Wood Elf and every
race past the nine; racial actives (levitate, faerie fire, enlarge, frenzy); homelands and
per-race spawn points (one spawn, as today); race-gated equipment (`ITEM_ALLOWED_RACES` exists in
the source and our items carry no such field yet); the racewar, still and deliberately.
