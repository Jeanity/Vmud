# Velen — the capital

*Written 2026-08-08, the day the numbered schedule closed and the owner commissioned a city. This
is the plan for the game's first great settlement: what it is, what it is made of, which pieces
are mechanisms and which are content, and the order it gets built in. The roadmap's Act VII
(Phases 22–27) is this document with dates on it.*

The owner's brief, in one paragraph: a major city of **many zones stitched together** — walled
districts, an **underworld** of tunnels and sewers beneath, the **walls themselves an upper level**
with patrolling guards, **training areas** where classes learn skills, a **dock on the ocean
front**, roads leaving **north, east and south**, **roaming** guards and merchants and townsfolk, a
**mages' tower**, a couple of **inns**, **a lot of quests** in and around the city, **dangerous
districts** you don't wander unprepared, a **noticeboard in the town square** for announcements
from the gods, **stores** for weapons, armour, potions and food, maybe a **bank** if coin ever
gains weight, **weather and wind** that slow travel (*"this can wait until everything else is
done"* — the owner's own sequencing), and **rare-load mobs** carrying quests or a fight worth the
reward.

## 1. The three decisions (owner, 2026-08-08)

1. **The name is Velen** — owner, 2026-08-09, superseding Ironquay (2026-08-08), from the Realms
   map itself: the port on the Dragon's Head peninsula in Tethyr's Duchy of Velen. The first
   naming avoided famous cities so as not to borrow a setting; this one chooses a *minor canon
   town* for the opposite virtue — the famous cities stay on the map as **destinations**. Velen
   sits north of Calimport and south of Candlekeep and Waterdeep, so the roads someday lead to
   names a Toril veteran knows; the ocean is west and the great forest east, exactly the compass
   §2 already drew; and the Nelanther Pirate Isles and the Tusks lie offshore, which gives the
   docks somewhere to sail and the rough underbelly its business. Ironquay's dock-and-industry
   character survives the rename whole — Velen is still a quay town — and so does the Underquay,
   which never contained the old name. `velen` joins `names.ts`'s reserved list beside `ironquay`
   (history knows the old name; no player gets either).
2. **The geometry is authored, not harvested.** Velen is the first zone that is fully *ours* —
   committable to git, shippable, shaped exactly to the district plan. This is the other half of
   architectural rule 5: the rule keeps third-party content *out* of the engine, and an authored
   pipeline is what first-party content *in* looks like. We still transcribe Duris **mechanisms**
   (boards, guilds, patrols — cited per row in §4); what we stop borrowing is their streets.
3. **The first playable milestone is the town square** — small but alive, then districts grow
   outward. Phase 23 is that milestone; everything in it exercises a new system at small scale.

## 2. The shape of the city

**The street plan is an homage to TorilMUD's Waterdeep** — owner, 2026-08-09, from the zMUD map:
*"I would like some of this layout for familiarity and nostalgia reasons."* Decision 2 stands —
the geometry is authored, ours, hand-built — but its shape borrows the city the owner actually
lived in: a long north–south spine from gate to gate, one great east–west cross street to the
East Gate, the ship berths strung down the western dock edge, guilds scattered through the wards
rather than walled into one (cleric north of the crossing, mage west, warrior east, rogue south),
the graveyard off the east side, and the square itself at the great crossing where Waterdeep keeps
its central fountain and board. The map's legend even confirms the furniture: inns, boards,
fountains, a bank, shops along the streets — every one already in §4's ledger. What is *not*
borrowed is data: no room of Waterdeep's is imported, transcribed or renumbered; the homage is a
street plan held up beside a drafting table.

The ocean is **west** (the docks front it; the roads leave by the other three walls). Streets are
z = 0; the **Underquay** — sewers, smugglers' tunnels, things worse than smugglers — is z = −1;
the **wall walk** with its patrolling watch is z = +1, reached by gatehouse stairs; the mages'
tower climbs z = +1…+3 in its own corner. The coordinate system has carried z since Phase 1; this
is the content that finally spends it.

```
                              North Road
                                  ║
            ┌──────────╦════ North Gate ════╦──────────┐
       ~ ~  │ Mages'   │      Noble         │  Guild   │
       ~ ~  │ Tower    │     Terraces       │  Ward    │
       ~ D  ├──────────┼────────────────────┼──────────┤
       ~ o  │ Harbour- │    THE  SQUARE     ╞═East Gate═══ East Road
       ~ c  │ side     │  (the noticeboard) │  Market  │
       ~ k  ├──────────┼────────────────────┼──────────┤
       ~ s  │ The      │      Temple        │ Caravan  │
       ~ ~  │ Shambles │       Row          │  Yards   │
            └──────────╩════ South Gate ════╩──────────┘
                                  ║
                              South Road
         Underquay (z −1) beneath it all · Wall Walk (z +1) on the ring
```

**The districts were each their own zone until 2026-08-10, and then they stopped being.** The owner
asked the question that undid it — *"is it possible to just join zones without all the portals? If
I walk north out of the square it should just go to the next attached zone… from gate to road I
don't think it needs to be [a portal]"* — and the answer was that a zone's coordinates are
normalised **per zone**, so two zones can never share a plane and every district border was
therefore forced to be a portal. Velen is now **one zone on one plane across three levels**, which
is what §2's own diagram above always described (streets z 0, Underquay z −1, wall walk z +1) and
what the harvest does anyway: Tordraken is one zone of 219 rooms across eleven levels. A district
is a naming convention. The four edges into *harvested* rooms stay portals and always will — two
sources share no coordinate frame *as emitted*, measured at 0 of 991 — though see
DESIGN-open-world.md §5b, which found the mapper's raw coordinates are global and 54% of cross-zone
exits would be neighbours if worldgen stopped normalising per zone. The roads may yet lose their
portals.

The original reasoning, kept because its first two thirds still hold:

Each district was **its own zone** — the owner asked for a city of stitched zones, and it is also
simply correct here: the room stays the unit of interest management, cross-district doors are
ordinary exits, and a district can be built, populated and re-authored without touching its
neighbours. Authored zones take ids at **900001+** — the same convention Windsong opened for
authored items at #9,000,000: high, unmistakably ours, and permanently clear of every id the MUD
data owns (its highest live in the 93,000s).

| Zone | Id | What it is | Safe? |
| --- | --- | --- | --- |
| The Square | 900001 | The heart: noticeboard, well, the Anchor & Anvil inn, the first shops | Yes — watched |
| Market Ward | 900002 | Weapons, armour, potions, food, general goods; stalls and criers | Yes |
| Guild Ward | 900003 | The training halls: warriors' yard, rogues' den, priests' seminary doors | Yes |
| Noble Terraces | 900004 | Money, gossip, locked doors, quest-giving households | Yes |
| Mages' Tower | 900005 | The wizards' guild, vertical (z 0…+3); the tower library | Yes, until you touch something |
| Harbourside | 900006 | The docks, fishmarket, warehouses, the Wet Boot (the *other* inn) | Rough |
| The Shambles | 900007 | The poor quarter gone bad — **dangerous by day, worse by night** | **No** |
| Temple Row | 900008 | Shrines and the healers; quiet | Yes |
| The Wall Walk | 900009 | z = +1 ring, gatehouses at N/E/S, the watch on its beats | Yes |
| The Underquay | 900010 | z = −1 sewers and tunnels; grates in four districts; **dangerous** | **No** |
| North / East / South Roads | 900011–13 | The stitch to the wider world; roadside quests and ambushes | Escorted stretches only |

**The roads are the hard seam and are named as such**: they must end at exits into *harvested*
zones, which means authored rooms holding exits to room ids from another source entirely. The
worldgen validator currently assumes it can see both sides of every link; Phase 22 teaches it
that a cross-source edge is checked at *merge* time, when both worlds are in hand.

## 3. What already exists and just gets used

The city spends almost everything the 26 phases built, which is why it can be mostly content:
quests (+ counted `bring` in flight), quest-giver badges and untouchability, shops with
charisma pricing, the aggression system (dangerous districts are a *population*, not a
mechanism), locked doors and keys, day/night and vision, room prose via the text log, spawns and
zone resets, the admin panel for live authoring, and the name law for the city's own name.

## 4. The mechanism ledger

What the owner asked for, where the lineage already built it, and what is genuinely new. Duris
anchors are files under `data/zones-source/duris/src/`.

| Ask | Duris anchor | Status → phase |
| --- | --- | --- |
| Noticeboard in the square, gods post news | `boards.c` — the whole machine, deferred once already by the `read` row | **New mechanism** — board object, `read board` / `read 3`, admin panel posts; player writes decided in 23 |
| Class training areas | `guild.c` (`do_practice`), guildmasters per class | **New mechanism** — the skills table already stores 0 = *training never happened*; a trainer NPC is the thing that moves it, for coin, gated by class ceilings. Phase 24 |
| Patrolling wall guards, roaming merchants/townsfolk | `specs.mobile.c` cityguard, `mobact.c` wandering | **New mechanism** — mobs today stand still unless fighting or pursuing; patrol routes (waypoints on the tick) and bounded wander are one system worn two ways. Phase 25 |
| Underworld, dangerous districts | — (content) | Aggression + locks exist; the Underquay and the Shambles are population and geometry. Phase 26 |
| Dock on the ocean | — (content) | Harbourside district. Phase 27; ships are an open question, not a promise |
| Roads N/E/S to the world | — (content + one validator rule) | Phase 22 rule, Phase 27 zones |
| Inns for the night | `comm.c` receptionists (rent — we don't need rent) | **Small flag** — an `inn` room property: faster regen, and memorization already prefers `resting`. Phase 23 |
| Stores: weapons/armour/potions/food | Shop system live since Phase 17 | Content: one anchor shop per kind in 23, the full Market Ward in 27 |
| Rare-load mobs, great rewards | Zone reset chance loads (verify exact semantics in `db.c` when built) | **Small mechanism** — a spawn-chance field (Windsong's ranger already fakes it at 2%; promote that to data). Phase 27 |
| Bank, **if** coin gains weight | `actoth.c` `do_deposit`; coin weight is real in the lineage | **Parked behind a decision** — weight first or never; the Underquay vault room is built in 26 either way, doors locked, waiting |
| Weather and wind that slow travel | `weather.c` | **Parked last, by the owner's own words** — after everything else. Stormvane was nearly the city's name; the storms can wait to earn it |
| A lot of quests | Live system + the Duris catalogue | Every phase adds its district's; Phase 27 carries the wave, drawing on `REFERENCE-duris-quests.md` patterns |

## 5. The build order — Act VII, Phases 22–27

1. **Phase 22 — The authored world.** `data/authored/` (committed), worldgen merges it beside the
   harvest, ids 900001+, identical validation plus the cross-source edge rule. *Seen when:* a
   hand-written courtyard renders, walks, and fails validation as loudly as a harvested zone does.
2. **Phase 23 — Velen Square.** The milestone: the square, the noticeboard (mechanism), the
   Anchor & Anvil (inn flag), four anchor shops, static gate guards, the name reserved. *Seen
   when:* a player reads the gods' news on the board, buys bread, and wakes rested at the inn.
3. **Phase 24 — The guilds.** Trainers (mechanism), the Guild Ward, the Mages' Tower interior.
   *Seen when:* a skill sitting at 0 is bought into life at the yard and the next roll shows it.
4. **Phase 25 — Walls and watch.** Patrol/wander (mechanism), the Wall Walk, gatehouses, streets
   that move. *Seen when:* a guard walks his beat above while a merchant crosses the square below.
5. **Phase 26 — Underquay and the Shambles.** The city's dark half: sewers, grates, the locked
   vault, a district that punishes the unprepared. *Seen when:* the grate opens under Harbourside
   and an unwise shortcut through the Shambles becomes a story.
6. **Phase 27 — Harbourside and the roads.** The docks, three roads stitched to harvested
   wilderness, rare loads promoted to data, the quest wave. *Seen when:* you walk out the East
   Gate to somewhere the harvest built, and the gossip channel hears about a named mob somebody
   met on the way.

## 6. Open questions for the owner

1. **Do inns bind?** A `recall`/home-point at the inn you last slept in is the classic reason
   inns matter. Cheap once the flag exists — but it changes death's geography, so it is a choice.
2. **Does the watch enforce law?** Guards who attack players who attack citizens make Safe mean
   something. The aggression system can express it; whether Velen does is a design choice.
3. **Boards: may players write?** `boards.c` allows it. Phase 23 ships gods-post-players-read;
   player writes are one flag away when wanted.
4. **The second city.** Velen is built as *the* capital, but the pipeline is generic — when a
   dark-race or far-shore settlement is wanted, Phase 22 already paid for it.
