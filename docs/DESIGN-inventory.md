# Design: inventory, containers and equipment

_Captured 2026-07-29 from the project owner's specification. Nothing here is implemented yet._

---

## 1. Three separate stores

A character holds things in three places, and they are deliberately different kinds of thing:

| Store | Capacity | Can it be lost? |
| --- | --- | --- |
| **Equipment slots** | Fixed set of named slots | Only by unequipping |
| **Inventory** | `capacity` slots, a character property, starting at **20** | No — see §5 |
| **Gold purse** | Bottomless | No |

Gold is a number on the character, never an item, and never occupies a slot.

## 2. Slots are size, not count

**An item costs a number of slots, and that number varies by item.** The owner's example: a
breastplate might cost **10** of your 20. A dagger costs 1.

This is a bulk model wearing a slot model's clothes, and it is the right one: it makes armour a
genuine logistical decision without asking a player to do arithmetic with pounds. Capacity is
consumed as the sum of the sizes of what you carry.

> **Note the departure.** Diku and SRD both derive carrying capacity from Strength. This does not —
> capacity comes from your bag, and Strength governs nothing here. That is a deliberate trade: a grid
> you can see beats a weight budget you have to compute. Flagged because the rules backbone is
> otherwise SRD.

## 3. Stacking and uses

Two independent numbers per item type, and conflating them is the easy mistake:

- **`stackLimit`** — how many of this item share one slot.
- **`uses`** — how many charges a *single* item carries.

The owner's worked example, which the model must reproduce exactly:

| Item | `uses` each | `stackLimit` | A full stack is |
| --- | --- | --- | --- |
| Regular potion | 1 | 5 | 5 uses in one slot |
| Large potion | 5 | 5 | **25 uses** in one slot |
| Arrows | — | 20 | 20 arrows in one slot |

So a large potion is not "a potion worth more"; it is five draughts in one bottle, and five bottles
stack. Total uses is `count × uses`, and partially-consumed items must be representable — a
half-used large potion is 3 of 5, and cannot merge with a full one into a clean stack.

## 4. Containers

Containers are **items that hold other items**, they nest Diku-style, and a container's contents do
**not** count against the capacity holding it. That last rule is the entire point — it is what the
owner meant by a quiver letting arrows "free up the spot in the inventory".

- A **quiver** costs its own slots, holds only arrows, and holds far more than a slot of loose
  arrows would.
- Containers may be **type-restricted** (quiver → arrows, scroll case → scrolls) or general.
- Containers are ordinary items: findable, droppable, losable.

### The nesting exploit, and how it is bounded

Unbounded nesting is unbounded storage: a bag in a bag in a bag, forever. Diku has this problem.

**Proposed: a maximum nesting depth of 2** — your inventory may hold containers, and those containers
hold items, but not further containers. This preserves the quiver and the belt pouch, which is what
nesting is actually *for*, while removing the exploit entirely rather than mitigating it.

This is a proposal, not a decision taken, and it is cheap to change in either direction. If deeper
nesting is wanted later, the alternative is propagating bulk upward so a full bag costs more slots
than an empty one — which closes the exploit but makes capacity arithmetic much harder to explain.

**Owner confirmed depth 2 on 2026-08-03**, so the proposal above is now the rule. `putRefusal` returns
`'too-deep'` for *any* container going into a container, and `readInventory` refuses the same shape on
the way in — a save file is hand-editable, and a bag that loads deeper than the rules allow is a bag
whose rules are decoration.

### The verbs

`put <item> <container>` and `get <item> from <container>` move things in and out; `look in <container>`
reads one without disturbing it. All three take **the bag first and then what is in reach on the floor**
— `put arrow sack` while standing on an identical sack means the one you are holding, which is the one
`inventory` just told you about — and all three go through one resolver, so the precedence cannot drift
between them. A container you are *holding* by that name settles the question: if it turns out not to be
a container you are told so, rather than having a different object with the same name quietly used
instead.

**A container on the floor is usable, not just readable.** That makes a chest by the door into storage
you never carry, which is a different thing from a quiver and worth having. The floor half uses `get`'s
reach gate rather than `look`'s: you can look *at* something across the room and not reach into it. The
*item* still comes from the bag either way — `put` moves one thing from your hands into a container, and
something already on the floor is a `get` away from being in your hands.

**The order of the two writes is the whole safety argument.** Both verbs write the container first and
the bag last, and abandon the move if the container has gone. The other order hands an item to a sack
that no longer exists, and the item is then in neither place — the one inventory bug you cannot
apologise your way out of.

`inventory` already lists contents indented under each container, so `look in` is for the container you
want to read *alone*. Bare `look <container>` answers the same way, because "what is in it" is the only
interesting thing to say about one.

**It is on the click menu too, and that is the point rather than a garnish.** A container on the floor
offers *Look inside* above *Get* — reading a sack is what you do before deciding to carry it — and the
row exists only for containers, so a dropped dagger's menu is unchanged. The owner's rule for the floor
generally applies here: *"not everyone reads every description"*, and a verb reachable only by typing
`look in` is one most players never find. `EntityView.container` is what makes it possible; it says
**is a container** and deliberately not *what is in it*, because sending contents to everyone in the
room would hand out the answer to the verb before anybody looked.

**A container on the floor is still full.** The ground store carries `held` through a drop and back up
through a pickup; without that, putting a quiver of twenty arrows down destroyed the arrows and left the
quiver — the same silent loss §8 records for the save reader, one store over. What is inside a floor
container still counts against an `O` command's world-wide instance limit, or leaving something in a
dropped sack would be a way to make the world mint another one.

## 5. Capacity is a character property, not an item

**The base bag is a number on the character, not something you wear.** Larger bags found or purchased
raise that number.

The owner's reasoning, which is the whole justification and should not be quietly optimised away:

> *there is nothing worse than playing a game of months and losing everything due to 1 mistake.*

So the core carrying capacity cannot be stolen, dropped, destroyed, or lost on death. Everything
*inside* it can be — and so can any container you are carrying — but the floor never falls out.

This is why the model is not "bag as a worn item in a back slot", despite that being the more
conventional RPG choice. It is a deliberate trade of flavour for safety.

## 6. Equipment slots

Separate from inventory: worn and wielded gear never consumes bag capacity.

Slots: head, neck, chest, legs, feet, hands, **main hand**, **off hand**, back, two rings.

The slot set maps directly onto LPC's layered sprite system, which is what makes worn equipment
visible on the character rather than merely listed. That was a stated goal of the art direction.

### `wear` and `wield`, and the weapons that need both hands

15b shipped one verb on the argument that the split earns its keep only when a character has enough
gear for it to save typing. The harvest is what expired that argument: **557 of the catalogue's 2,841
weapons need two hands**, so which hand a thing occupies became a question with consequences.

- `wield <weapon>` puts a weapon in the main hand and **refuses anything that is not a weapon**.
- `wear <anything>` still accepts a weapon. The asymmetry is deliberate — Duris refuses both ways, and
  a beginner who types the wrong verb at the right item should get their sword in their hand rather
  than a lecture.
- **A two-handed weapon takes the off hand too**, and whatever was there goes into the bag. Duris
  refuses outright; displacing follows §7's rule that a character cannot end an equip holding less than
  they started. The refusal survives only where displacing would lose something: a bag with no room.
- **The rule runs both ways.** Strapping on a shield sheds the greatsword. Forgetting that direction is
  a character quietly fighting with a two-hander *and* a shield.

The in-combat rule differs between the two and is transcribed rather than chosen: `interp.c` has
`CMD_N` for wear at sitting and **`CMD_Y` for wield at prone**. Drawing a weapon is one motion you can
manage flat on your back with something standing over you; buckling on a breastplate is not.

### There is no light slot — light is a property of items

A dedicated light slot would be free light forever. Instead, **any equipped item may emit light**,
and a character's radius is the best light among everything they have equipped.

That makes light a *trade-off against combat capability*, which is the whole point:

| Source | Slot it costs | What you give up |
| --- | --- | --- |
| Torch, lantern | Main or off hand | A weapon, or a shield |
| Glowing amulet | Neck | Whatever that neck slot held |
| Glowing ring | Ring | A ring |

The owner's framing: a glowing necklace replacing a lantern **frees a hand**, which opens up dual
wielding or a shield. So a body-slot light is not merely a brighter light — it is a different class
of item, and finding one is a real power spike even at the *same* radius.

This gives light a second progression axis beyond how far it reaches: **what it costs you to carry.**
An early character chooses between seeing and fighting well; a later one stops having to. Body-slot
lights should therefore be correspondingly rare, and a hand-slot light at a given radius should be
much easier to come by than a neck-slot one at the same radius.

Consequences for the implementation:

- Light is a **property on an item type**, not a slot on a character: `{ radius, mode, durationMs,
  expiresTo }` hanging off any equippable.
- `bestLight()` gathers candidates from **every equipped item** and picks the best. It already takes
  a candidate list rather than a single source, so this needs no change to its shape.
- The carried-light field being built right now is an interim stand-in for "the best light among your
  equipment". It should collapse into that when equipment lands, not survive alongside it.
- Two-handed weapons implicitly forbid a hand-held light, which is a real and interesting cost that
  falls out for free.

## 7. A full inventory refuses

Picking something up with no room **fails, says so, and leaves the item on the ground.** It never
auto-drops and never silently discards — losing a quest item to an invisible heuristic is exactly the
failure this design is trying to avoid.

The refusal message should name what would not fit and how many slots it needed.

## 8. Persistence

Inventory, equipment and gold persist per character in `data/players/<name>.json`, alongside the
existing `seen` bitsets. Item instances need stable ids so a partially-used potion or a named piece
of equipment survives a restart as *itself* rather than as a fresh copy of its type.

That implies the distinction the rest of this document assumes: an **item type** (the catalogue entry
— name, size, stack limit, uses) versus an **item instance** (this particular sword, with its own
remaining uses and eventual enchantments).

**As built (15b):** `PlayerRecord.inventory` and `.equipped` persist; gold does not exist yet. The
type/instance split is **not** built — an `Item` today is a flat record copied wherever it goes, which
is honest while nothing has per-instance state to lose. It becomes wrong the moment 15c's charges land,
and that is the seam to cut.

**As built (15c):** the purse persists too, and stacks persist *as stacks* — `count` and `remaining`
are on the wire to disk, so twenty arrows come back as twenty arrows in one slot rather than as twenty
loose ones that no longer fit.

> **A reader that ignores a field deletes it.** §4's containers shipped with `readInventory` reading
> `item`, `count` and `remaining` and simply not knowing about `held`, so everything a player had *put
> somewhere* was gone at the next login — and gone before it reached the disk as well, because
> `PlayerStore.setInventory` normalises through that same reader. Nothing failed, nothing logged, and
> the bag looked right until you opened the quiver. The lesson is structural rather than a one-off fix:
> **every field of a persisted shape needs a line in its reader and a round-trip test**, because the
> failure mode of forgetting one is silent destruction rather than a crash. `readInventory` also
> enforces §4's depth limit *on the way in* — a save file is hand-editable, and a bag that loads deeper
> than the rules allow is a bag whose rules are decoration.
>
> The same omission had a second face: `loose`, which empties a bag onto a corpse when its owner dies,
> also stopped at the top level — so dying with a full quiver left the quiver on the body and destroyed
> every arrow in it. Both are fixed and both now have tests.

**The floor does not persist.** `server/src/ground.ts` is in memory, so a restart clears every dropped
object. A character's own things are safe — they are in their save file — and only what somebody chose
to put down is lost. Persisting it is not a matter of writing another JSON file: the ground is keyed by
room and position, and `npm run worldgen` can rebuild the rooms underneath it, so a saved floor needs an
answer for objects whose room moved, changed terrain, or stopped existing. Same class of problem
`data/world/overrides/` solves for prose, and it wants the same kind of deliberate answer.

---

## 8b. What death does to your bag

**Added 15b**, because 14b deferred it and 15b is what made the question answerable: a corpse can now
hold things and be looted, so *"equipment stays on the body"* stopped being a scope line and became a
choice.

**Your inventory goes into the corpse. Your worn equipment stays on you.**

The two clean answers are both worse. *Everything drops* is the conventional MUD rule, and it collides
head-on with the owner's stated constraint — *"there is nothing worse than playing a game of months and
losing everything due to one mistake"* — because a naked corpse run back through the zone that just
killed you is that one mistake compounding into several. *Nothing drops* makes death a teleport with an
experience bill attached, and then the thirty-minute player-corpse clock in `corpses.ts` is decoration.

The split costs you exactly what you chose to be carrying, leaves you able to fight your way back to
it, and makes that clock a deadline. It also gives the bag a real risk profile without giving it a
catastrophic one, which is what makes *what to carry* a decision rather than a formality.

## 8c. Whose corpse you may open

**A player's corpse is theirs, unless an operator has switched player killing on.** Owner's rule
(2026-08-03): *"we should not be able to loot other players' corpses as this is not a pkill game… but
having it so I can turn it off or on would be a nice feature."*

One flag covers **both** attacking another player and looting their corpse, deliberately: they are the
same question asked at two moments, and a world where you may kill someone but not take what they
dropped is a rule nobody can hold in their head. It lives in `server/src/settings.ts` as a file rather
than a constant, because the point is that it is thrown for an evening and thrown back — and a switch
that silently reverts on restart is one that gets somebody killed by a rule nobody meant to be in force.

Note what this **replaced**: nothing refused player-versus-player combat at all before it. `startFight`
checked only that you were not attacking yourself, so the game shipped as a PvP game by omission. Off
is therefore a correction rather than a preference.

---

## 9. Future work: an admin suite

The owner has asked for a **creator tool for mobs, equipment, items and quests**, noted here so it is
not lost.

The case for it grows with every system: mobs alone need level, six ability scores, reaction time,
three aggression dispositions, aggro and assist ranges, tracking tiers, loot tables and quest tags
(`docs/DESIGN-mobs-and-movement.md`), and items now need size, stack limit, uses, container rules and
slot compatibility. Authoring that as hand-written JSON across hundreds of entries is where content
projects stall.

Worth stating early: the tool should read and write the **same validated data files the game loads**,
never a separate database. Content that can only be edited through a tool is content that is hostage
to the tool.
