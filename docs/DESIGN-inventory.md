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
