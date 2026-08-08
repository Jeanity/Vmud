# The quests already in the Duris source

*"There are more than likely already quests in the duris code — find them so I can use them in the
game or use them as examples."*

There are. **1,273 quest-giving mobs across 262 files, offering 3,275 separate exchanges**, and they
are not in the C at all — they are in a data file the C merely loads. This is the map of where they
live, what shape they are, which ones are running in our game today, and what stands between us and
the rest.

Companion to [REFERENCE-mud-mechanics.md](REFERENCE-mud-mechanics.md); the schema these feed is
`packages/server/src/quests.ts` and the editor over it is
[DESIGN-admin-panel.md §11](DESIGN-admin-panel.md).

---

## 1. Where quests actually live — five systems, one of them the real one

| System | Files | What it is | Yield |
| --- | --- | --- | --- |
| **The quest database** | `src/quest.c` + `areas/qst/*.qst` | `quest.c` is only a **loader**. Every authored quest in the game is data: 262 `.qst` files, one per area. | **1,273 givers / 3,275 exchanges** — the whole payload |
| **Generated world quests** | `src/world_quest.c`, `world_quest.h` | A quest master hands out procedural *"find and kill 7–9 of mob X in zone Z"* or *"find and ask mob X"* jobs, picked at run time from the zone tables. | A **mechanism**, no authored content — this is the system our `kill` shape already mirrors |
| **The XML quest engine** | `src/nq.c` | Tharkun's *"alternative quest system"*: actors, phrases, rewards, timed instances, read from `quest/*.xml`. | **Nothing shipped** — no XML data exists anywhere in the tree, so it is dead code |
| **Spec procs** | `src/specs.*.c` (~81k lines) | Scripted mob behaviour. A few are quests in code rather than data — a handler on `CMD_GIVE` or `CMD_ASK` that hands something back. | **Thin**: 23 `CMD_GIVE` and 12 `CMD_ASK` handlers in the whole corpus, against 3,275 data-driven exchanges. Concentrated in `specs.mobile.c` (8 give / 11 ask), `specs.myranth.c` (5), `specs.grove.c` (4) |
| **The offline editor** | `areas/de/src/quest/*.cpp` | A C++ builder tool (`editqst`, `readqst`, `writeqst`) that *writes* the `.qst` files. | Confirms the format below; no quests of its own |

The headline is the first row. Anybody grepping `quest.c` for content finds a parser and concludes
there is nothing there — the memorisation research's *"thousands of lines of tokens, bits and
specials"* is exactly that impression. The quests are one directory over.

The fourth row is worth stating as a negative result, because it is the row everyone expects to be
full: **the spec-proc files are not where the quests are.** 81,000 lines of scripted mob behaviour
yield 35 handlers that could be quest-shaped at all, against a data file holding ninety times as many.
Anything harvested from `specs.*.c` is a bonus on top of `areas/qst/`, never a substitute for it, and
the vnum→proc mapping needed to resolve their givers lives in `specs.assign.c`.

### The `.qst` format

From `quest.c:591-789` (`boot_the_quests`). Each block is one **giver**, keyed by mob vnum:

```
#<mob vnum>
M | MA        keywords~   message~        a keyword the player can ASK/TELL about; MA echoes to the room
Q | QA        completion message~         one completable exchange; QA echoes to the room
G <I|T|C> <n>                             what the player must GIVE: Item vnum, item Type, or Coins
R <I|C|S|E> <n>                           what they RECEIVE: Item vnum, Coins, Skill, or Exp
D             message~                    the giver vanishes after this one
S                                         end of giver
```

Repeated `G I 1447` lines mean *several of that item* — `quest_completion` (`quest.c:114-176`) counts
duplicates to get the quantity. Coins are **copper**: the Ashrumite mage charges `G C 25000` for what
his dialogue calls *"25 platinum"*, and `G C 20` for *"2 silver"*, so 1 silver = 10, 1 gold = 100,
1 platinum = 1000. That makes `R C` and `R E` map onto our `reward.copper` and `reward.xp` exactly.

Two things worth knowing before anyone parses these:

- **`qc_action <n>` keywords are not quests.** They are ambient room emotes on a timer
  (`execute_quest_routine`, `quest.c:45-71`) — *"A kobold miner chips away at a rock."* 654 of the
  1,927 blocks are dialogue and emotes with no `Q` at all.
- **`kobold.qst:14` is a live landmine.** A `~` inside kobold gibberish (`tells you, 'a~q!`) ends
  `fread_string` mid-sentence, and the next token `q!` hits `boot_the_quests`'s `default:` case, which
  is `logit(LOG_EXIT, …); exit(1)`. Real Duris would refuse to boot on this file as it stands.

---

## 2. What is live in our game today

Seven quests are live. Three shipped with the first harvest alongside Gwark's; **three more arrived
2026-08-08 with zone 64 Faerie Realm**, the first zone loaded *for* its quests rather than for its
geography. All seven load and were checked against a running server:
`[quests] 7 authored quest(s) loaded`, every giver resolving with `standing: 1`.

| id | zone | giver | objective | reward | source |
| --- | --- | --- | --- | --- | --- |
| `the-viscounts-onion` | 36 IceCrag | 97023 the Viscount (room 5818) | bring **97115** *an onion* — lies on the floor of Masha's kitchen, room 5728 | item **97135** *a root vial filled with bubbling purple liquid* | `icecrag.qst:483` |
| `the-commanders-lost-book` | 36 IceCrag | 97021 the Commander (room 5804) | bring **97006** *an ancient crumbling book* — carried by the Archivist (97030) and a sentinel private (97059) | item **97144** *a blue earthstone ring* | `icecrag.qst:429` |
| `the-jewelers-raw-gem` | 24 Ashrumite | 66021 the jeweler (room 4880) | bring **66039** *a raw gem* — on the floor of room 4902 | item **66044** *an amethyst* | `ashrumite.qst:57` |
| `finns-mammoth-key` | 64 Faerie Realm | 14015 The Legendary Finn (room 7653) | bring **14037** *a mammoth key of crafted iron* — carried by the buttercup faerie of room 7744 (lvl 6, passive) | **500,000 copper** + item **14023** *a gigantic, steel-blue sword of power* | `realm.qst:60` |
| `finns-signet-ring` | 64 Faerie Realm | 14015 The Legendary Finn (room 7653) | bring **14036** *Finn's signet ring* — worn by a faerie guard of the Seelie Court (14067, lvl 26, three of them in room 7663) | item **14018** *a glowing faerie ring* | `realm.qst:41` |
| `celriyas-brothers-sword` | 64 Faerie Realm | 14028 Celriya (room 7730) | bring **14001** *an elvish sword of great antiquity* — on the floor of room 45373, 36 rooms from her garden | item **14011** *a pair of goggles of faerie sight* | `realm.qst:94` |

**`finns-mammoth-key` is the first quest in the corpus that ports at full fidelity** — the source pays
`R I 14023` *and* `R C 500000`, and `reward` already carries an item beside a number, so nothing was
dropped. It is also the only live quest whose objective a low-level character can take: the bearer is
a level-6 passive faerie, against IceCrag's level-15-to-60 population and Ashrumite's level-50 guards.

Each was chosen against four tests: the giver **spawns** (a `mob` reset puts a body in a room, not
merely a template in the file), the objective is a **single item** our `bring` shape can express, that
item is **actually obtainable** in a populated zone, and the giver's own words carry the ask.

**Zones 260 and 261 can host nothing.** They are in `world.config.json`'s `zones` but not its
`populate`, so they have rooms and no mobs at all.

**Zone 168 gained its giver once `bring` could count.** Szxvu the kobold blacksmith (mob 1420, room
41221) was blocked on nothing else — his smelting quest is §5's first entry, and it shipped the day
`objective.count` landed on a `bring`. The newbie zone now has both Gwark's kill and Szxvu's fetch.
His three remaining exchanges are chain steps or multi-*vnum*, so they still wait on §4's first row.

**A fifth test was considered and could not be met: none of these quests is walkable to.** Faerie
Realm's exits leave for zones 423, 226, 367 and 193, none of them loaded, so it is an island. That
was checked before it was chosen and accepted, because **the loaded world is already four islands**:
breadth-first search from the spawn room (41260, zone 168) over the loaded set reaches 99 rooms and
stops, all of them in 168. Ashrumite and IceCrag — which host four of the seven live quests — have
been reachable only by admin teleport since the day they were added, and the single zone that would
extend the walk is 321 Evermeet-Ancient Forest-1, which has neither population nor a `.qst`. Of the
six zones with an exit touching the loaded set, exactly one (117 Ako Village) has harvested spawns,
and it has no quest file at all. So there was no choice that made a quest zone walkable, and the
honest framing is that this adds a fifth island to four, not a stranded zone to a connected world.

### Where the words came from

Duris has no single "here is the job" string: the ask is spread across keyword responses a player
discovers by asking. Each `ask` below is stitched from that giver's own lines, and every departure
from the source is listed.

| quest | adapted how |
| --- | --- |
| the Viscount | `ask` is the `sample` keyword response verbatim (`icecrag.qst:475`). `thanks` is the `Q` message with the source's own misspelling *"Magificent"* corrected and its `Here.....drink` ellipsis normalised. |
| the Commander | `ask` stitches three keyword responses — `book` (`icecrag.qst:390`), `lost` (`:396`), and the closing line of `man fellow strange` (`:424`), whose *"that bastard stole the book"* is softened to the *"shifty-eyed loon"* the `Q` message itself uses. `thanks` is the `Q` message verbatim but for the same ellipsis normalisation. |
| the jeweler | `ask` is the `gem gems cutting` response verbatim (`ashrumite.qst:41`). `thanks` is the `Q` message verbatim. The source also charges **2 silver** for the work (`G C 20`); our schema cannot charge for an objective, so the fee is dropped and the price line is left out of the ask rather than quoted as a lie. |
| Finn (both) | Finn's lines are **narrated speech** — *"Finn scowls in anger and says, …"* — where IceCrag's givers spoke plainly, so the adaptation is the same one every time: the narration is cut and Finn's own quoted words are kept, because `doQuest` already wraps the string in `says, '…'` and a stage direction inside it reads as a bug. `finns-signet-ring`'s `ask` is the `ring home leave realm` response (`realm.qst:10`) minus its closing teleport-scroll question, which belongs to a *different* exchange (`G I 14018`) that we do not ship. `finns-mammoth-key`'s `ask` is the `key castle` response (`realm.qst:21`) and its `thanks` is the `Q` message (`:61`), both verbatim once the narration is removed. |
| Finn's `thanks` on the ring | The source's `Q` block (`realm.qst:42`) spends five lines on Finn ransacking his luggage before he shouts *"My key!"*. Compressed to *"Now let me just find… no. No! My key!"* — the beat matters, because it is the source's own hand-off from the first quest to the second, and both are on the same giver. |
| Celriya | `ask` is the `brother tvelor` response (`realm.qst:84`) with the narration cut and the closing *"I have the grounds to keep as well. If Oberon should ever return…"* dropped, being scene-setting rather than the job. `thanks` is the `Q` message (`:95`) with *"please accept these"* corrected to *"this"*: the source pays two objects and we pay one. |

Three departures are worth stating plainly, because they are losses rather than tidying. **Two of the
three pay a second item we cannot express** — Finn's ring quest also gives 14041 *a map of the Faerie
Realm*, and Celriya's also gives 14076 *her wand of restoration*; `reward.item` is singular, so the
wearable was kept and the second object dropped in both. And **`finns-mammoth-key` carries a `D`
block** — Finn is meant to leave for home once he has his key. §4 recommends not porting departures
in a persistent world, so he stays, which makes his farewell the one line of his the file does not
use.

---

## 3. What this cost the schema, and why it was worth it

`reward` gained an optional **`item`** vnum. The argument is arithmetic: of 3,275 exchanges,
**2,517 pay an object and 2,169 pay nothing else**. Coins and experience are the exception in this
corpus, not the rule — and among the givers who actually stand in a loaded, populated zone, *every
single one* whose objective is reachable pays an item and no coin at all. Without the field there was
not one faithful quest to import; with it, three shipped the same day. See §11 of the admin design for
the field's own rules.

Two bugs fell out of shipping the first `bring` quests, both invisible until now because the only
quest that had ever existed was a `kill`:

- **`bring` could never complete.** `doQuest` asked `matchInventory` for `String(vnum)` — the bare
  digits — but an instance's id is `obj:<vnum>` and its keyword list is the catalogue's words unioned
  with its display name. Neither is ever the number, so the check returned "not carried" for an item
  sitting in the bag. It now matches on `vnumOf`, the join the death spoils already use.
- **A quest paying only an object printed "You gain 0 experience."** The line is now sent only when
  there is a number worth reporting; `giveItem` announces the object itself.

---

## 4. The shapes our schema still lacks

Ranked by how much of the corpus each one unlocks.

| Shape | How common | What it is | Recommendation |
| --- | --- | --- | --- |
| **Several of one item** | **~1,154 exchanges** | `G I 1447` eight times over — Szxvu smelting eight silver nuggets. | **Done.** `objective.kind: 'bring'` carries a `count`, optional and defaulting to 1 so the quests authored before it are untouched. Szxvu's smelting shipped with it. What is still missing is the **list form for distinct vnums** — the priest's three *different* pages, the sergeant's three-piece fur suit — which is the remainder of this row and wants an objective holding several vnums rather than one. |
| **A fee as part of the ask** | **329 exchanges** | `G C 20` — the jeweler's 2 silver, the smith's 170 platinum. The player pays *into* the quest. | **Next.** A `cost` on the objective, charged at turn-in and refused if the purse is short. Cheap, and it makes every crafting giver honest — including Szxvu, whose ask still quotes a 10-platinum fee nothing charges. |
| **The item is consumed** | all of them | `quest_completion` does `obj_from_char` + `extract_obj` (`quest.c:145-160`). | **Done**, folded into the counting work as recommended. The turn-in takes exactly `count` before it pays, so the Viscount no longer eats an onion you keep, and bringing ten of an eight-nugget quest leaves you two. |
| **Chains** | pervasive | Szxvu wants gem eyes, hands them back, and asks for frames; the ice artist's shoes are the siege master's objective. | Needs a `requires: <quest id>` gate. Wait until there is a chain worth walking. |
| **The giver vanishes** | **574 exchanges** | The `D` block — the servant, the priest, the sergeant all leave once served. | Low value for us: a one-shot giver in a persistent multiplayer world means the *first* player takes the quest and nobody else ever can. Recommend **not** porting it. |
| **Teaching a skill** | 1 exchange | `R S <skill>`. | Ignore. One instance in 3,275. |
| **Item *type* rather than vnum** | 2 exchanges | `G T <type>` — "any weapon". | Ignore. |

---

## 5. Ready to paste, for the day their zone lights up

Every entry below is a real quest with a citation, blocked on something named. Zone numbers are ours;
vnums are the MUD's own and never change.

### ~~Blocked only on a `count` for `bring`~~ — **shipped**, zone 168

Szxvu the kobold blacksmith (mob **1420**, room 41221) is the newbie zone's only quest giver. The
silver he wants is carried by kobold miners (1441) and mine leaders (1443) who stand two rooms away.
This is now **live** — it is the quest `objective.count` was built for, and the JSON below is what
sits in `data/world/overrides/quests.json` today.

```json
{
  "id": "szxvu-smelts-the-nuggets",
  "giver": 1420,
  "name": "Szxvu's smelting",
  "ask": "For say, 10 platinum coins, I can take 8 silver nuggets and make it into a block of usable silver. With that block of silver I could make many great things.... for a price.",
  "thanks": "There's much can be done with a couple good block of silver ... could make a great shield!",
  "objective": { "kind": "bring", "vnum": 1447, "count": 8, "what": "small nuggets of silver" },
  "reward": { "xp": 0, "copper": 0, "item": 1448 }
}
```

*`kobold.qst:65`. Ask and thanks are the `nugget nuggets` keyword and the tail of the `Q` message.*

*One honest wart, kept deliberately rather than fixed by paraphrase: the ask **quotes the
10-platinum fee** (`G C 10000`) that our schema cannot charge, where the jeweler's entry in §2 had
its price line cut for exactly that reason. It is left in because this text is the acceptance target
recorded here, and cutting it silently would make the document disagree with the shipped file. It
should be trimmed to `"I can take 8 silver nuggets and make it into a block of usable silver…"` the
day the fee lands (§4, row two) — or before, if the promise reads as a lie first.*

### Blocked on a placement — zone 36, populated

Myrke the Stalker (mob **97039**) has a template in `icecrag.wld` and **no `mob` reset**: nothing puts
a body in a room, so nobody can ever meet him. He is the corpus's best kill-shaped quest — carve the
hearts out of two named mobs, both of which do spawn — and he pays 250,000 copper. One placement
through the admin panel makes him real.

```json
{
  "id": "myrke-wants-two-hearts",
  "giver": 97039,
  "name": "Two hearts for Myrke",
  "ask": "Perhaps you are interested in a job? It's dirty of course, but someone like you shouldn't care too much about that. Go pay the Captain and that woman Strife a visit and carve their hearts out from their bloody carcasses. Of course, there is a reward for such services if you can prove your success.",
  "thanks": "I can't believe you did it! Oh this will make my life much easier indeed. For your services, I offer you the contents of my pockets!",
  "objective": { "kind": "bring", "vnum": 97016, "what": "the bloody heart of the Captain" },
  "reward": { "xp": 0, "copper": 250000, "item": 55032 }
}
```

*`icecrag.qst:589`. The source wants **both** hearts — 97016 from the Captain and 97017 from Strife
— so this single-objective form is half the quest until multi-item lands. The ask is the `killed`
keyword response with its colour codes stripped and one epithet softened.*

### Blocked on multi-item — zone 36, populated, all sources spawn

```json
{
  "id": "the-priests-speech-notes",
  "giver": 97008,
  "name": "The priest's speech notes",
  "ask": "If you should by any chance come across three sheets of paper with some speech notes on them, you are to bring them back to me immediately! They could be anywhere in the castle by now, anyone could have picked them up!",
  "thanks": "By the grace of Auril! Here, take these, its the least I can do. They were handed down to me from my great grandfather who wrested them from a swamp troll down in the bogs south of Verzanan.",
  "objective": { "kind": "bring", "vnum": 97137, "what": "three sheets of speech notes" },
  "reward": { "xp": 0, "copper": 0, "item": 97139 }
}
```

*`icecrag.qst:180`. Wants 97137, 97138 and 97149 — three distinct vnums, worn by a sentinel private
(97059) and a member of the cleaning crew (97001), both of whom spawn.*

```json
{
  "id": "the-sergeants-fur-suit",
  "giver": 97020,
  "name": "The sergeant's fur suit",
  "ask": "Damn straight its cold out here! Id give almost anything for a suit of fur right about now! Yeah...a nice jacket, some pants maybe, and one of those big furry hats with the flaps for your ears! If you can find me a three piece suit like that, i'll give you my favorite knapsack!",
  "thanks": "Thank you! Thank You! You have saved my fingers and toes from eternal frostbite! Toss your belongings in here and you'll never know your carrying them! For your kindness, I threw in the key pouch.",
  "objective": { "kind": "bring", "vnum": 97047, "what": "a three-piece fur suit" },
  "reward": { "xp": 0, "copper": 0, "item": 97143 }
}
```

*`icecrag.qst:365`. Wants 97041 (hat), 97047 (jacket) and 97048 (pants), worn by ice garden attendants
(97011) and off-duty patrol guards (97017); also charges 25 platinum. The `and maybe 25 platinum
coins` clause is cut from the ask because we cannot charge it.*

### Blocked on the objective items not existing in a loaded zone

These givers stand in our world; what they want does not spawn in it. They come alive when the zone
holding the item is added to `world.config.json`.

| quest | giver | wants | pays | citation |
| --- | --- | --- | --- | --- |
| The ice artist's tools | 97002 the ice artist, room 5751 | 11606 *a stonecutters hammer* + 11607 *a stonecutters chisel* | 97029 *a pair of calf-skin shoes* **+ 50,000 xp** | `icecrag.qst:61` |
| The siege master's shoes | 97029 the siege master, room 5820 | 97029 *calf-skin shoes* — the ice artist's reward, so this is the chain's second link | 97140 *a tribal mask* | `icecrag.qst:539` |
| The stolen wine | 97014 a raucous guest **(no placement)** | 2× 90017 + 2× 92048 wine | **75,000 copper + 30,000 xp** + 97141 | `icecrag.qst:309` |
| Masha's compendium | 97006 Masha the dicer, room 5728 | seven foods from seven cultures | 97110 *map of Icecrag Castle* + 3× 97136 | `icecrag.qst:141` |
| The magical necklace | 66017 the mage shopkeeper, room 4879 | 66050 + 4372 + 25 platinum | 66051 | `ashrumite.qst:18` |

### Quests whose objective is coins alone

Our schema has no objective for *"pay me"*, and two are pure lore payoffs worth keeping in mind:

- **66041 the bartender**, Ashrumite room 4895 — `G C 1000` and the reward is **nothing but the
  words**: where the platinum disc went, who was carrying it, and why he lost it in Tethir forest.
  A paid rumour (`ashrumite.qst:157`).
- **97001 a member of the cleaning crew**, IceCrag — 10 gold for *the guard's walk key* to a
  restricted hall, sold with *"you DIDN'T get it from me, got that?"* (`icecrag.qst:22`).

---

## 6. Where to harvest next

31 of the 49 zones with harvested spawn data have a `.qst` file beside them — **quest givers already
sitting behind population we have generated.**

**Correction, 2026-08-08 — what "adding a zone" actually is.** An earlier draft of this section said
*"adding a zone id to `world.config.json`'s `populate` is most of the work"*, which reads as though
the worldgen pipeline consults that file. It does not. `packages/worldgen/src/index.ts` never opens
`world.config.json` — it takes `--zone` on the command line (`index.ts:89-97`), and with no flag it
writes **all 327 zones and all 49 population files every run**. The config is read by the *server*,
`loadWorldConfig` in `packages/server/src/world.ts:67-69`, and it is a runtime filter over output
that already exists on disk. So loading a zone is genuinely two edits and a restart, with **no
worldgen run required at all**: the id goes in `zones` to get the rooms and in `populate` to get the
inhabitants, and a zone listed in `populate` but not in `zones` is refused at boot.

**Correction — Ashstone Refugee Camp (326) is not the prize this table implies.** Its `bs.qst` really
does hold 20 givers and 65 exchanges, and its population really is harvested. But the *geometry* is
not: the zMUD map contributes **four rooms** for zone 326 and its spawn file resolves **two** mob
resets out of 202 templates, so **not one of its twenty givers has a body anywhere in the world**.
Counting givers in the `.qst` measures the MUD; what we can ship is bounded by the rooms our map
recovered. The column that predicts shippability is not "givers" — it is *givers who spawn, wanting a
single item that also spawns*, and by that measure 326 scores zero.

So the table below is ranked by the last column, not the first. **Givers** is what the `.qst` holds;
**spawn** is how many of those have a `mob` reset that puts a body in a room we kept; **ready** is
single-item objectives on a spawning giver whose objective item *also* enters the world, by an
`object` reset onto a floor or a `give`/`equip` onto a mob that spawns. Only the last number is a
quest somebody could ship this afternoon.

| zone | name | `.qst` file | givers | spawn | ready | note |
| --- | --- | --- | --- | --- | --- | --- |
| 24 | Ashrumite_Village *(loaded)* | `ashrumite.qst` | 4 | 4 | 6 | 1 live; the other 5 are the jeweler's other gems |
| 232 | The Basin Wastes | `basin_wa.qst` | 1 | 1 | 5 | **mirage** — the witch carries all five herself, and a giver is untouchable |
| 64 | Faerie Realm *(loaded 2026-08-08)* | `realm.qst` | 4 | 2 | 4 | **3 live**; the 4th is a joke exchange, Finn hands the walnut straight back |
| 225 | Jotunheim | `jotun.qst` | 10 | 3 | 4 | best unloaded candidate; 2 of the 4 charge 250,000 copper, and the bearers are level 52-59 |
| 257 | Myrloch Vale | `myrloch_vale.qst` | 3 | 2 | 3 | **mirage** — no path inside the zone from the giver to any of the three items |
| 36 | IceCrag Castle *(loaded)* | `icecrag.qst` | 12 | 8 | 2 | both live |
| 198 | The Defense of Longhollow | `long.qst` | 41 | 30 | 2 | most givers of any harvested zone; nearly all want several items |
| 256 | New Moonshae Island I | `moonshae.qst` | 2 | 2 | 2 | |
| 25 / 120 / 168 / 204 / 118 / 259 | Troll Hills, Labyrinth, Kobold *(loaded)*, Mosswood, Elemental Groves, Newhaven | | | | 1 each | 168's is Szxvu, still blocked on `count` |
| 121 | Desert City of Nizari | `nizari.qst` | 25 | 18 | 0 | 180 mob resets and not one single-item objective |
| 85 | The Citadel | `citadel.qst` | 20 | 14 | 0 | |
| 326 | Ashstone Refugee Camp | `bs.qst` | 21 | **0** | **0** | 4 rooms in our map; see the correction above |
| 296 | The Northern High Road | `goblinht.qst` | 8 | 0 | 0 | 4 templates, zero mob resets |

**Jotunheim (225) is the one to load next** if quests are again the reason. It is the only unloaded
zone with several ready objectives whose sources all spawn, and it is large and genuinely populated
(272 rooms, 62 templates, 164 mob resets). The price is honesty about two things: its bearers are
level 52-59, and two of its four exchanges charge a 250,000-copper fee that today has to be dropped
rather than collected — a much larger lie than the jeweler's two silver, and an argument for doing
§4's `cost` before loading it rather than after.

And the biggest quest files in the corpus, for when their zones are matched at all — `alatorin.qst`
(82 givers / 495 exchanges), `wh.qst` Winterhaven (86 / 221), `dalvik.qst` (2 / 420),
`vehicles.qst` (8 / 255), and **`newbie.qst` (22 / 116)**, which is worth reading on its own for how
Duris introduced questing to a new player.

---

## 7. Reproducing this

No tool ships with this document; the format in §1 is complete enough to re-derive the numbers, and
the counts above come from parsing all 262 files with those rules. Two things a parser must handle or
its totals will be wrong: `fread_string` reads to the next `~` **wherever it falls**, including
mid-sentence (`kobold.qst:14`), and `boot_the_quests` builds its lists by prepending, so the *last*
`Q` block in a giver is the *first* one tested at turn-in.

---

## Appendix: scripted quests in the C spec-procs

A follow-up sweep (2026-08-08) checked every `CMD_GIVE`/`CMD_ASK` handler across all of `specs.*.c` —
35 raw hits collapsing to 27 distinct functions once duplicates and one false positive
(`CMD_GIVEPET` substring-matching `CMD_GIVE`) are removed — against `specs.assign.c`'s vnum→proc
wiring, including its dozen disabled `#if 0` blocks and the one handler (`teacher`) that bypasses
`specs.assign.c` entirely via a dynamic attach in `db.c`. The headline confirms §1: of the 27, only
**11** are genuine, live, player-completable give/ask exchanges, tabulated below. The rest are two
pay-tolls, a shop mechanic, dialogue with no payoff, an informational hook, a broken reward, a
keyword death-trap — and **seven** with no live wiring at all. The `.qst` data in §1 remains the real
quest corpus; this is the whole of what the C side adds on top of it.

### Live and player-completable

| Handler | File:line | Vnum(s) | Objective → reward |
| --- | --- | --- | --- |
| `harpy_evil` | `specs.mobile.c:127` | 31124 | Give the Choosing Feather (31112) → race becomes harpy, evil-aligned |
| `harpy_good` | `specs.mobile.c:175` | 31109 | Give the Choosing Feather (31112) → race becomes harpy, good-aligned |
| `claw_cavern_drow_mage` | `specs.mobile.c:10037` | 80726 | Give the Rainbow Key (80733) → mage dies, drops Rainbow Shards (80734) |
| `world_quest` | `specs.mobile.c:10377` | 36 vnums, many zones | Ask "quest" → procedural kill-task; the live wiring for §1's "Generated world quests" row |
| `newbie_paladin` | `specs.mobile.c:10616` | 22801 | Ask about "racewar" as a newbie → blessed sword + full starter gear set |
| `clear_epic_task_spec` | `specs.mobile.c:14852` | 22428 | Ask for "prayer", pay ~10,000,000 copper → epic-task debuff cleared |
| `smelter` | `specs.mobile.c:15277` | 83187 | Give 2 matching ore + a fee → smelted into the next size up |
| `sex_crazed_prostitute` | `specs.grove.c:425` | 93602 | Give ≥500 copper → temporary follower |
| `well_built_prostitute` | `specs.grove.c:619` | 93603 | Give ≥500 copper → temporary follower |
| `sleezy_prostitute` | `specs.grove.c:813` | 93611 | Give ≥500 copper → temporary follower |
| `burbul_map_obj` (object) | `specs.ailvio.c:27` | 29328 | Ask about "burbul map" → free map handed over |

`harpy_evil`/`harpy_good` are one choice split across two mobs — the same feather, either mob, for the
opposite alignment. The three `*_prostitute` handlers are copy-pasted from one template; a fourth
sibling exists (`topless_prostitute`) but was never assigned — see below.

### Dead, orphaned, or otherwise not worth chasing

- `monk_remort` (`specs.mobile.c:15179`) — individually commented out at `specs.assign.c:194`.
- `myranth_key` (`specs.myranth.c:3438`) — a four-key combine puzzle never assigned to any object vnum.
- `topless_prostitute` (`specs.grove.c:230`) — identical to its three live siblings above, never assigned.
- `bs_tax` (`specs.bloodstone.c:2541`) and `bs_bouncer` (`specs.bloodstone.c:3072`) — toll-gate
  handlers, never assigned anywhere.
- `prostitute_one` (`specs.verzanan.c:2395`) — both its assignment attempts sit inside disabled
  `#if 0` blocks in `specs.assign.c`.
- `um_mezzoloth` (`specs.undermountain.c:1775`) — assigned inside a `#if 0` block that disables all
  17 Undermountain spec procs at once.

Two more are live, not dead, but worth flagging as near-misses so nobody mistakes them for working
quests: `gargoyle_master` (`specs.mobile.c:223`, vnum 31108) correctly tracks a harpy-corpse count,
but its payoff — the actual race change — is commented out, so asking again past the threshold does
nothing; `shabo_palle` (`specs.mobile.c:12742`, vnum 32842) isn't really `CMD_ASK`-gated despite the
token match — it's a keyword trap on any command that spawns a killer after ten repeats of
"pallistren darkaland".
