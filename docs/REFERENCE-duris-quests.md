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

Three new quests shipped with this harvest, alongside Gwark's. All four load and were checked against
a running server: `[quests] 4 authored quest(s) loaded`, every giver resolving with `standing: 1`.

| id | zone | giver | objective | reward | source |
| --- | --- | --- | --- | --- | --- |
| `the-viscounts-onion` | 36 IceCrag | 97023 the Viscount (room 5818) | bring **97115** *an onion* — lies on the floor of Masha's kitchen, room 5728 | item **97135** *a root vial filled with bubbling purple liquid* | `icecrag.qst:483` |
| `the-commanders-lost-book` | 36 IceCrag | 97021 the Commander (room 5804) | bring **97006** *an ancient crumbling book* — carried by the Archivist (97030) and a sentinel private (97059) | item **97144** *a blue earthstone ring* | `icecrag.qst:429` |
| `the-jewelers-raw-gem` | 24 Ashrumite | 66021 the jeweler (room 4880) | bring **66039** *a raw gem* — on the floor of room 4902 | item **66044** *an amethyst* | `ashrumite.qst:57` |

Each was chosen against four tests: the giver **spawns** (a `mob` reset puts a body in a room, not
merely a template in the file), the objective is a **single item** our `bring` shape can express, that
item is **actually obtainable** in a populated zone, and the giver's own words carry the ask.

**Zones 260 and 261 can host nothing.** They are in `world.config.json`'s `zones` but not its
`populate`, so they have rooms and no mobs at all. Zone 168's only quest giver is Szxvu, whose four
exchanges are all multi-item or chain steps (§4) — so the newbie zone keeps Gwark's kill quest and
gains nothing here.

### Where the words came from

Duris has no single "here is the job" string: the ask is spread across keyword responses a player
discovers by asking. Each `ask` below is stitched from that giver's own lines, and every departure
from the source is listed.

| quest | adapted how |
| --- | --- |
| the Viscount | `ask` is the `sample` keyword response verbatim (`icecrag.qst:475`). `thanks` is the `Q` message with the source's own misspelling *"Magificent"* corrected and its `Here.....drink` ellipsis normalised. |
| the Commander | `ask` stitches three keyword responses — `book` (`icecrag.qst:390`), `lost` (`:396`), and the closing line of `man fellow strange` (`:424`), whose *"that bastard stole the book"* is softened to the *"shifty-eyed loon"* the `Q` message itself uses. `thanks` is the `Q` message verbatim but for the same ellipsis normalisation. |
| the jeweler | `ask` is the `gem gems cutting` response verbatim (`ashrumite.qst:41`). `thanks` is the `Q` message verbatim. The source also charges **2 silver** for the work (`G C 20`); our schema cannot charge for an objective, so the fee is dropped and the price line is left out of the ask rather than quoted as a lie. |

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
| **Several items, or several of one** | **1,154 exchanges** | `G I 1447` eight times over — Szxvu smelting eight silver nuggets; the priest's three pages of speech notes; the sergeant's three-piece fur suit. | **Add this next.** `objective.kind: 'bring'` wants a `count`, exactly as `kill` has one, plus a list form for distinct vnums. It is the single biggest unlock and the smallest conceptual step — `kill` already proves the counting UI. |
| **A fee as part of the ask** | **329 exchanges** | `G C 20` — the jeweler's 2 silver, the smith's 170 platinum. The player pays *into* the quest. | Second. A `cost` on the objective, charged at turn-in and refused if the purse is short. Cheap, and it makes every crafting giver honest. |
| **The item is consumed** | all of them | `quest_completion` does `obj_from_char` + `extract_obj` (`quest.c:145-160`). Our `bring` only checks that you *hold* the thing and never takes it — so the Viscount eats an onion you keep. | Fold into the `bring` work above. It is one line and a design decision, not a schema change. |
| **Chains** | pervasive | Szxvu wants gem eyes, hands them back, and asks for frames; the ice artist's shoes are the siege master's objective. | Needs a `requires: <quest id>` gate. Wait until there is a chain worth walking. |
| **The giver vanishes** | **574 exchanges** | The `D` block — the servant, the priest, the sergeant all leave once served. | Low value for us: a one-shot giver in a persistent multiplayer world means the *first* player takes the quest and nobody else ever can. Recommend **not** porting it. |
| **Teaching a skill** | 1 exchange | `R S <skill>`. | Ignore. One instance in 3,275. |
| **Item *type* rather than vnum** | 2 exchanges | `G T <type>` — "any weapon". | Ignore. |

---

## 5. Ready to paste, for the day their zone lights up

Every entry below is a real quest with a citation, blocked on something named. Zone numbers are ours;
vnums are the MUD's own and never change.

### Blocked only on a `count` for `bring` — zone 168, already populated

Szxvu the kobold blacksmith (mob **1420**, room 41221) is the newbie zone's only quest giver. The
silver he wants is carried by kobold miners (1441) and mine leaders (1443) who stand two rooms away,
so this becomes live the moment `bring` can count.

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

*`kobold.qst:65`. Needs `objective.count` on a `bring`, and the 10-platinum fee (`G C 10000`) is
dropped. Ask and thanks are the `nugget nuggets` keyword and the tail of the `Q` message.*

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

30 of the 49 zones with harvested spawn data have a `.qst` file with quests in them — **114 quest
givers already sitting behind population we have generated.** Adding a zone id to
`world.config.json`'s `populate` is most of the work.

| zone | name | `.qst` file | givers | exchanges |
| --- | --- | --- | --- | --- |
| 326 | Ashstone Refugee Camp | `bs.qst` | 20 | 65 |
| 225 | Jotunheim | `jotun.qst` | 10 | 15 |
| 198 | The Defense of Longhollow | `long.qst` | 5 | 15 |
| 24 | Ashrumite_Village *(loaded)* | `ashrumite.qst` | 4 | 12 |
| 296 | The Northern High Road | `goblinht.qst` | 8 | 11 |
| 36 | IceCrag Castle *(loaded)* | `icecrag.qst` | 11 | 11 |
| 232 | The Basin Wastes | `basin_wa.qst` | 1 | 10 |
| 259 | The Curse of Newhaven | `newhaven.qst` | 5 | 9 |
| 6 | Caves of Mt. Skelenak | `caves_skelenak.qst` | 2 | 9 |
| 64 | Faerie Realm | `realm.qst` | 4 | 7 |
| 257 | Myrloch Vale | `myrloch_vale.qst` | 2 | 4 |
| 168 | Kobold Settlement *(loaded)* | `kobold.qst` | 1 | 4 |

Ashstone Refugee Camp is the standout: twenty givers and sixty-five exchanges behind a zone whose
population is already harvested.

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
