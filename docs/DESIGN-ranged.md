# Ranged combat — the decisions this cannot be started without

_2026-08-08. Written before any code, the way `DESIGN-skills.md` and `DESIGN-zone-geometry.md` were, and
for the same reason: **four of the five findings in §0 change what "transcribed from the source" means
here**, and one of them changes whether the headline feature works at all for 83% of the world. The
owner asked for a plan rather than an implementation — "*tomorrow I get back my fable usage and will put
fable in charge but if you can create the plan it would be a good start*" — so this is written to be
picked up cold._

---

## 1. What was asked for, verbatim

Quoted rather than paraphrased, because the detail is the specification.

> "we also need to add ranged weapons as rangers use bows and rogues will throw knives"

> "with that comes the ability to fire east or throw dagger west and try and tag a mob to make it come
> to you so you don't have to enter a crowded room"

> "when I look west and see a mob or 3 it should show the mobs on the map"

> "have them visible until I leave the room I am in. if I go west then obviously I see the 3 mobs but I
> shouldn't be able to see from 2 rooms away"

> "and if I can see what is in the next room when I look I should be able to target them with my ranged
> weapons .. bow, throwing knives etc. so shoot kobold west should target a kobold to the west. this is
> skill based also I shouldn't hit 100% of the time. especially when I first start using a bow. also
> arrows that miss land on the ground for collection and the ones that hit the mob should remain in
> their corpse for looting once they die. arrows and throwing daggers need a small chance of breaking
> also so it is risk you take. the chance should increase if you are shooting into another room. also
> there should be a chance of hitting the wrong mob so if I shoot west at the kobold youth and there
> happens to be a shaman in there also I might accidently hit the shaman until my skill increases"

Nine mechanisms, in dependency order:

1. Ranged weapons and ammunition as **item concepts** — bows, thrown daggers, arrows as consumables.
2. **Adjacent-room occupant reveal**, and its memory: `look west` reveals who is there, the reveal lasts
   while you stay put, and it **does not chain** — standing where you looked does not reveal the room
   beyond.
3. The **map** shows revealed mobs, not just the log.
4. **Directional ranged attack** — `shoot kobold west`, gated on having revealed the target.
5. **Skill, and a real miss chance**, low when new to a bow.
6. **Ammunition physics** — a miss lands on the target room's floor; a hit stays in the victim and is
   looted from the corpse.
7. **Breakage**, small, and **higher when firing into another room**.
8. **Wrong-target risk**, falling as skill rises.
9. **The pull** — the tagged mob comes, and *its room-mates do not*.

**(9) is not a feature, it is a restriction on existing behaviour.** If threat or aggression spreads to
room-mates, a pull drags the crowd and the feature is worse than useless — the owner's whole stated
reason is "*so you don't have to enter a crowded room*". Settle it before building anything else here.

---

## 0. Five findings that change what "transcribed" means

All five were found by grepping the source and measuring our own data rather than by reasoning about
MUDs, per `CLAUDE.md`. Each one would have cost a rewrite if discovered during implementation.

### 0.1 There is no bow in the weapon-class ladder. Ranged is an item *type*.

`objmisc.h:363-384` is the complete ladder — `WEAPON_NONE 0` … `WEAPON_NUMCHUCKS 20`, with
`#define WEAPON_HIGHEST 20`. We transcribed all 21 rows verbatim in **both** copies
(`shared/src/skills.ts:163-184`, `shared/src/attacks.ts:116-137`). Nothing was omitted, because **there
is no bow, crossbow, sling or thrown class in it and never was**.

Ranged lives in the *type* enum instead, and we already name all three:

```
defines.h:105   ITEM_FIREWEAPON  6   /* bows, slings — a weapon used to fire others */
defines.h:106   ITEM_MISSILE     7   /* arrow, bolt, ballista missile */
defines.h:129   ITEM_QUIVER     30   /* container for MISSILEs only */
```

`DURIS_ITEM` (`shared/src/items.ts:37-60`) already has `fireweapon: 6, missile: 7, quiver: 30`;
`stackLimitFor` already returns 20 for missiles; `CONTAINER_ACCEPTS` already includes `'missile'`; wear
bit `1 << 20` and wear position 23 already resolve to the `quiver` slot. **No item-type work is needed.**
`weaponSkillFor` is the wrong seam for this feature and must not be extended with a fake class.

What *is* untranscribed is the compatibility key, `objmisc.h:392-399`:

```
MISSILE_ARROW 1 · LIGHT_CBOW_QUARREL 2 · HEAVY_CBOW_QUARREL 3
MISSILE_HAND_CBOW_QUARREL 4 · SLING_BULLET 5 · DART 6
```

A fireweapon's `value[3]` is what it fires, a missile's `value[3]` is what it is, a quiver's `value[2]`
is what it holds. We keep `capacity/5` and discard `value[2]`, so **today every quiver accepts every
missile** — and shop 36439 sells a hand crossbow (type 4) next to a drow bolt (type 2), so "any missile
fires from any launcher" produces visible nonsense on day one.

### 0.2 `do_throw` is a stub whose skill does not exist. Model throwing on `do_fire`.

Duris has two unrelated ranged systems in `range.c`, and only one is real.

| | `do_fire` (`range.c:347`) | `do_throw` (`range.c:1092`) |
| --- | --- | --- |
| command row | `CMD_Y` — **legal in combat** | `CMD_N` — **refused in combat** |
| skill read | `SKILL_ARCHERY` | `SKILL_RANGE_WEAPONS` |
| that skill is | created + granted to 4 classes | **never `SKILL_CREATE`d, never granted to anyone** |

`SKILL_RANGE_WEAPONS = 1042` (`spells.h:776`) appears exactly twice in the whole tree: that define, and
the read at `range.c:1221`. So shipped Duris' throwing accuracy is dexterity times a flat 1.1 and
nothing else, and `SKILL_DARTS` poison never fires either. **Throwing is unimplemented in the source,
not merely simpler.** The owner's "rogues throw knives" must be built on `do_fire`'s shape, with throwing
as a *range-2 variant* rather than a second system.

### 0.3 Every ranged item in our world is already parsed, then thrown away.

Measured over the loaded `data/world/items.json` (16,421 entries):

| type | count | with `damage` | with `weaponClass` |
| --- | --- | --- | --- |
| fireweapon (6) | **50** | **0** | 0 |
| missile (7) | **58** | **0** | 0 |
| quiver (30) | **53** | 0 | 0 |
| throwable melee (type 5 + throw flag) | **295** (110 daggers) | 295 | 295 |

Every bow and arrow in the world is a nameless zero-damage stick. The cause is four type gates in one
function, `worldgen/src/objects.ts`:

```ts
const isWeapon = raw.type === DURIS_ITEM.weapon;                                  // :286  type 5 only
const damage = isWeapon && count > 0 && sides > 0 ? {...} : undefined;            // :289
...(isWeapon && (raw.values[0] ?? 0) > 0 ? { weaponClass: raw.values[0] } : {}),  // :354
// :302-305 twoHanded is also gated on isWeapon — so none of the 19 two-handed bows is marked as one
```

`RawObject` **already carries** `values: numbers.slice(11,19)` and `extraFlags: numbers[6]`, so every
number needed is parsed and then dropped. This is a harvest edit plus `npm run worldgen`, **not authored
content**. Value semantics, from the source's own stat display (`actwiz.c:2050-2100`):

- fireweapon — `value[0]` rate of fire, `value[1]` range, `value[3]` missile type it fires
- missile — damage is `value[1] d value[2]`, `value[3]` its own type
- quiver — `value[0]` capacity, `value[2]` accepted missile type

Throwables need no damage data at all: the two `extra_flags` bits are already in `raw.extraFlags` —
`ITEM_CAN_THROW1 = 1<<24`, `ITEM_CAN_THROW2 = 1<<4` (**and the second one *is* the range: 2 rooms rather
than 1**, `range.c:1188`), plus `ITEM_RETURNING = 1<<8` on 356 objects.

### 0.4 Only **17%** of the world can be pulled. This is the big one.

The pull is the owner's stated reason for the whole feature, so it is worth knowing before building that
most of the world will not answer it. Measured over all 1,503 mob templates in the 45 populated zones:

| `pursuit.tier` | `trackRooms` | templates | share |
| --- | --- | --- | --- |
| `sentinel` | **0 — will never follow** | **1,248** | **83%** |
| `zone` | 40 | 195 | 13% |
| `relentless` | 500 | 60 | 4% |

So **255 of 1,503 mobs (17%) can be pulled**. For the other 83%, firing into the next room tags a mob
that then stands exactly where it was. (Separately, `aggro.sentinel` is set on 880 — 59% — which is a
*different* flag from `pursuit.tier`; do not conflate them.)

Duris does not have this problem, and the reason is a deliberate divergence we already made. Its ranged
retaliation goes through `MobRetaliateRange` (`mobact.c`) using `HUNT_JUSTICE_INVADER`, which **bypasses
the hunter gate entirely** — Duris lures nearly everything. Our `pursuit` tiers are harvested per mob.

**This forces a decision (§2.1) and it is the first thing to settle.** Note also that a tagged mob's
threat does not currently survive the arrow: `advanceCombat`'s retarget pass deletes a mob's whole threat
table within one tick when nothing is reachable (`combat.ts:784-791`).

### 0.5 The bow art exists upstream and is refused by a geometry check.

Not a licensing or availability problem — a measurement. `artgen`'s `isWalkSheet` demands exactly
**576×256** (`worldgen/src/artgen.ts:57-59`), and:

- `crossbow/…/walk/crossbow.png` → 576×256 ✅ staged as `weapon-ranged-crossbow-crossbow`
- `slingshot/walk/slingshot.png` → 576×256 ✅ staged
- **bow** → no 64px walk at all; its only walk is a `walk_128` at **1664×512** ❌ refused

So we have crossbow and sling art and **no bow and no arrow**, and none of the 108 ranged catalogue items
has an `art` id. The encouraging half: the bow's firing sheets are
`bow/normal/universal/…/shoot/<variant>.png` at **832×256** and `bow/arrow/shoot/arrow.png` at 832×256 —
13 columns × 64px, which `actionGeometry` (artgen.ts:265-276) **already accepts**. What blocks the
animation is vocabulary in two places: `ACTION_DIRS` knows only `slash`/`thrust` (artgen.ts:284-287) and
`protocol.ts:995` types the field `swing?: 'slash' | 'thrust'`.

---

## 2. Decisions before writing code

**§2.1 is settled** (provoked, owner 2026-08-08) — it was the pivot and the plan is no longer blocked on
it. §2.2 was never really a choice and is recorded as a requirement. §2.3–2.5 are ordinary calls the
implementer can make, with a recommendation on each.

### 2.1 What does a pulled mob do when its `pursuit.tier` is `sentinel`? ✅ **DECIDED — provoked**

83% of the world, so this was the plan's pivot. Three options were costed:

- **(a) Accept it.** A sentinel takes the arrow and stays. Ranged becomes free damage on approach rather
  than a pull, and the crowded-room problem stays unsolved for most of the world.
- **(b) Diverge like Duris.** Being hit from outside overrides `sentinel` entirely, as
  `HUNT_JUSTICE_INVADER` does. Works everywhere, and silently rewrites 1,248 mob rules — every
  shopkeeper, guard and quest giver becomes lurable.
- **(c) Provoked.** Will not wander, *will* cross one room to answer an attacker, then go back.

**The owner chose (c), 2026-08-08.** (a) fails the stated purpose and (b) makes the whole world lurable,
including the quest givers Phase 21 spent a slice making un-attackable.

#### What provoked means, precisely

> **Being shot provokes you. It does not change what kind of creature you are.**

That sentence is the design, and it is why this is **a temporary state rather than a fourth
`pursuit.tier`** — a refinement of the recommendation as approved, with identical behaviour, made while
writing it up:

- A tier is a *trait*, harvested per mob from the `.wld` data and true of the creature for ever. Nothing
  in Duris harvests "provoked", so a fourth tier would be a value the harvest can never produce and only
  runtime can set — a field that lies about where it comes from.
- The existing `pursuit` object is `{ tier, trackRooms, giveUpMs, opensDoors, respectsSafeRooms,
  staysInZone }`. Provocation only needs to lift `trackRooms` to `max(trackRooms, 1)` for a while, which
  the shape already expresses without a new tier.
- Keeping the harvested tiers untouched means the 1,248 sentinels are still sentinels on their sheet, and
  a reader can still see that a shopkeeper does not chase people. That is worth preserving.

So: **a `provoked` affect**, granted to a mob that takes damage from an attacker who is not in its room.

| | |
| --- | --- |
| **trigger** | ranged damage from a non-co-located attacker |
| **grants** | `trackRooms = max(trackRooms, 1)` — exactly one room, never two |
| **target** | the attacker only. Never shared with room-mates (§2.2) |
| **duration** | the mob's own `giveUpMs`, so the harvested patience is still what decides |
| **on expiry or losing the target** | walks back to the room it was provoked in |
| **respects** | `staysInZone` and `respectsSafeRooms` unchanged — a provoked mob still will not follow into a sanctuary or across a zone edge |
| **does not** | stack, chain, or let a second shot buy a second room |

**The one-room cap is the whole safety property.** It means a player cannot walk a sentinel across a zone
by shooting it repeatedly, and it means a pull is a pull rather than a tow. Write the test for that before
the feature: shoot a sentinel from two rooms away through an intermediate room and assert it does not
arrive.

#### Re-ruled 2026-08-09: the cap becomes a leash, because kiting is a tactic worth having

> "sometimes being able to kite a mob a couple rooms is required. if for example there is a no magic room
> 5 rooms away from a very dangerous caster it would be good if players could kite the mob there and stop
> the mob casting and turn it into a melee fight instead" … "maybe set a max move. no out of zone and no
> more than 5 rooms sort of thing"

The owner weighed the tow risk against the kite tactic after playing the one-room version, and the ruling
is a **leash**: a provoked mob may be drawn up to **five rooms from the room it was provoked in**, and
never out of its zone. The distinction that keeps this from becoming the tow the original cap refused is
the **anchor**: the leash is a ball computed once, at provocation, around the mob's *post* — a re-shot
re-lights the anger (the duration refreshes, which is what makes a five-room kite sustainable at all) but
never moves the anchor, so five minutes of sustained archery still measures five rooms from where the
creature stood. `provokedLeash` in `hunt.ts` is the fence; the two-room test became the sixth-room test.

The tactic's other half turned out to be unbuilt: **311 harvested rooms carry `no_magic` and nothing read
the flag** — not the mob's cast, not the player's. Both gates exist now, symmetric on purpose: a caster
dragged into the smothered room falls through to its swing, and so does the ranger who dragged it there.
(`recite` and wands still ignore the flag; decide deliberately when scrolls matter.)

Kiting a *tracker* never needed any of this: `effectivePursuit` lifts by `max`, so the 17% that pursue
keep their own forty-room reach and always could be led anywhere their harvested rule allows.

**Sub-decision left open, deliberately:** whether walking back is instant, tick-paced, or interruptible.
Tick-paced is right — a guard trudging back to his post is readable and a teleporting one is not — but it
needs `DESIGN-mobs-and-movement.md`'s vocabulary and can be settled in slice 5 rather than now.

### 2.2 Ranged aggro must never reach room-mates — **a requirement, not a choice**

Kept in this section because it is the constraint everything else is built inside, but there is nothing
to decide: *"so you don't have to enter a crowded room"* is the stated purpose, and a pull that wakes the
crowd is worse than no pull at all. Confirm against `aggression.ts` and the threat book before building;
if any spread exists, the ranged path needs an explicit single-target flag.

**It is a restriction, so it will never show up in a happy-path test** — shoot one of three and watch one
come is indistinguishable from correct until the day all three do. Hence the test written first, in
slice 5.

### 2.3 Which skill, and granted to whom?

Duris' single row covers both halves of the ask, and its display name is already the right words:

```
skills.c:3457  SKILL_CREATE("ranged weapons", SKILL_ARCHERY, TAR_PHYS);
skills.c:3458  SKILL_ADD(CLASS_RANGER,   1, 100);
skills.c:3459-61  SKILL_ADD(CLASS_THIEF/ROGUE/ASSASSIN, 1, 75);
```

So: **ranger 100, rogue 75, from level 1, nobody else.** That maps onto our nine classes as ranger 95
(house cap) and rogue 75, and it is exactly "rangers use bows and rogues throw knives". Do **not**
transcribe `SKILL_RANGE_WEAPONS` for throwing (§0.2) — one skill, both delivery methods.

Consequence to note: adding a skill row changes the level-1 kit balance, because `equipment.test.ts` now
pins the spread. A bow in the ranger's starting kit would need the parity table re-measured.

### 2.4 Do arrows occupy a slot?

29 of 58 missiles currently arrive with `slot: 'offHand'`, because arrow wear flags are `HOLD|TAKE` and
`WEAR_BITS` maps `ITEM_HOLD` to `offHand`. An arrow you equip in your off hand is not what anyone means.
Choose: give missiles no slot at harvest, or resolve them to `quiver`. The 7 that arrive `mainHand` are
exactly the hand-thrown darts, which is the case `IS_DART` exists for — so this is a real decision, not
a bug to silently fix.

### 2.5 What is a "room" of range, in the source's units?

`do_throw` caps at `max_range` 1–2 rooms; the fireweapon data carries ranges of 60–150 and `do_fire`
computes `range = strength / get_property("archery.strPerRoomRange", 40)` rooms. **Those are not the same
unit.** Pick our own: the owner's ask is one room ("*fire east*", "*throw dagger west*"), and one room is
also exactly what the interest-management rule already puts on the wire (§3.2). Recommend **range 1 for
throwing, range 1–2 for bows**, and treat the harvested `value[1]` as flavour text until someone wants
more.

---

## 3. The slices

Each is separately visible, in the roadmap's own idiom. Nothing here needs the slice after it.

### Slice 1 — the data stops being thrown away

Un-gate the four type checks in `objects.ts` so fireweapons, missiles and quivers arrive with their
numbers; add the fields to `ItemTemplate` (`missileType`, `fires`, `range`, `rateOfFire`, `canThrow`,
`throwRange`, `returning`); transcribe `MISSILE_*`; keep the quiver's `value[2]`. Then `npm run worldgen`.

**Seen when:** the admin panel's item editor shows "an arrow" as 1d6, missile type 1, and a bow as range
60 firing missile type 1 — where today both are blank.

**Trap:** five missile records are broken by the source's own validity check (`178`, `179` at `mtype 0`;
blowgun needles `163`/`164`/`165` at `0d0`). Guard `sides === 0` and `mtype` outside 1..6. And do not
index `shot_types[]` (`constant.c:378`) with a `missile_types[]` number — they are two differently-ordered
display tables and an arrow prints as "a bullet".

### Slice 2 — you can see into the next room, and it is on the map

The owner's (2), (3) and (4). `look <direction>` already reaches into the neighbouring room and is the
seam to reuse. Add a per-player **revealed set**: looking a direction records that room's occupants,
they go on the wire and onto the map, and **the set clears when the player leaves the room** — no
chaining, exactly as asked ("*I shouldn't be able to see from 2 rooms away*").

The interest-management rule already sends the player their room *and its immediate neighbours*, so the
entities are likely on the wire already; this slice may be mostly client work plus a reveal flag.

**Seen when:** `look west` names three kobolds, they appear on the map, and they are still there a minute
later — then vanish the moment you walk anywhere.

### Slice 3 — the shot itself

`shoot <target> <direction>` and `throw <weapon> <direction>`, gated on the revealed set from slice 2.
The skill from §2.3, a real miss chance at low skill, and the wrong-target roll (the owner's (8)) —
which is a *reroll of the target within the room*, weighted by skill, not a damage penalty.

Doors block: Duris terminates its range walk on `EX_CLOSED | EX_LOCKED | EX_SECRET | EX_BLOCKED`, and
`RoomExit` already carries `door?`. Never cross a zone boundary (`get_char_ranged`'s own last check).

**Seen when:** a level-1 ranger fires west at a kobold youth, misses more often than not, and sometimes
hits the shaman standing next to it.

#### Firing in a group must not pull the mob off the tank — owner, 2026-08-08

> "if they are in a group they will want to step back and fire instead of going melee if can. I used to
> play a ranger and I preferred firing.. less chance of a mob switching to you"

**This is a threat rule and it points the opposite way to §2.1, deliberately.** The two ranged cases are
not the same act:

- **From an adjacent room** — the shot is *meant* to grab the mob. That is the pull, and `provoked` is
  what makes it work.
- **From inside the room, in a group** — the shot must *not* grab it. A ranger who out-threats the tank
  by standing at the back and firing has been punished for playing their class correctly.

So threat from a ranged attack should be lower than threat from the equivalent melee blow, and the
distinction is co-location rather than weapon. Settle the multiplier against the threat book in
`combat.ts` when slice 3 is built; do not invent a number here.

Worth noting the shape this gives the class: a ranger's damage is unchanged, but their *threat per point
of damage* is lower, which is what makes "step back and fire" a real tactical choice rather than a
flavour preference.

#### Slices 3 and 4 are one slice — owner, 2026-08-08

> "arrows shouldn't be consumed.. there is a chance they break but they should be recoverable from either
> the ground if you miss or from the corpse if you kill the mob you shot"

**So there is no intermediate state where a shot spends an arrow and the arrow goes nowhere.** The plan
had slice 3 resolve the shot and slice 4 give the arrow its destination, which quietly assumes a version
of the game where firing deletes ammunition — and that is the one behaviour the owner has ruled out. An
arrow leaves the quiver, but leaving the quiver *is a move to somewhere*: the far room's floor on a miss,
the victim on a hit, and only the breakage roll destroys anything.

Build them together. The cost is small — `ground.ts` already has a per-room item store and corpses
already hold lootable inventory (§ slice 4), so both destinations exist and neither is new mechanism.
The alternative is shipping a slice whose only visible behaviour is ammunition evaporating, then fixing
it, which is worse than one larger slice.

### Slice 4 — the arrow is an object with a fate

The owner's (6) and (7), and Duris does all of this already: a spent arrow moves to the victim
(`range.c:841-859`) or to the far room's floor (`:958-961`), and `gather` (`range.c:65`, min position
`POS_PRONE` — you may pick arrows up lying down) collects them. Our `ground.ts` already has a per-room
item store and corpses already hold lootable inventory, so both destinations exist.

Breakage is ours to invent: small per shot, **higher across a room boundary**, as asked.

**Seen when:** you fire six arrows west, walk in, pick four off the floor, kill the kobold and loot the
other two out of its corpse — and one of the six is gone for good.

### Slice 5 — the pull

The `provoked` affect from §2.1: granted on ranged damage from outside the room, lifts `trackRooms` to
exactly 1, expires on the mob's own `giveUpMs`, walks home afterwards. Single-target by construction
(§2.2). Plus the threat that survives the arrow — `advanceCombat`'s retarget pass deletes a mob's whole
threat table within one tick when nothing is reachable (`combat.ts:784-791`), so threat has to be seeded
at the moment the arrow lands or hunting mobs exempted from that pass.

**Seen when:** three kobolds in the room west; you tag one; **one** walks out to you and the other two
stay put. Then you let it go, and it walks back.

**Write these two tests first, because both failures are invisible on the happy path:**

1. Shoot a sentinel from **two** rooms away, through an intermediate room. It must not arrive — the
   one-room cap is what stops a pull becoming a tow across the zone.
2. Shoot one of three mobs in a room. The other two must not acquire threat. This is §2.2 and it is a
   restriction, so nothing in a normal play session will reveal it broken.

### Slice 6 — the art

Bow and arrow sheets, which is the one part needing a person rather than a field (§0.5). The `shoot`
geometry already passes; the walk needs re-slicing or drawing, and `swing` needs a third value in
`protocol.ts:995`, `SWING_ANIMATION` and `ACTION_DIRS`. Crossbow and sling are already staged and could
ship first.

**Seen when:** a ranger on screen draws a bow and an arrow crosses the room.

### Melee with a bow in hand — the source's answer, grepped 2026-08-09

The owner asked how Duris runs a fight when the tank or a solo fighter is wielding a bow, whether fire
is a per-round act, and whether the bow should fire unwielded, the way a spell casts around the dagger
in your hand. The source is unambiguous on all three:

- **The bow is wielded, full stop.** `do_fire` reads `ch->equipment[WIELD]` (`range.c:408`) — the main
  hand, exactly the slot ours uses. Nothing fires from the bag or the belt.
- **Fire is an act you take, not a round that happens.** One `fire` command looses *up to several*
  arrows — `speed = min(bow's rof, dex × 1.5, 2 × archery skill)`, plus haste and the rogue's
  sharpshooter spec, **minus 60 while fighting** — divided by `speedPerShot` (30), then a wait-state.
  Our one-arrow-per-`off_balance`-round is the same rhythm at low speed; the multi-shot ceiling and the
  in-combat penalty are recorded here as future fidelity, not built.
- **Standing in melee with a bow wielded is permitted and punished.** A non-weapon wield reads as
  **skill zero** in the swing path (`fight.c:6903`) — you flail, untrained — and parry is **divided by
  ten** (`fight.c:8763`, *"much harder to parry with fireweapons like a bow"*). Duris' archers stand in
  the back ranks; the bow-tank is a tank who cannot parry.

So the mage analogy fails on the source's own terms, and on ours: casting needs no free hand here
either (consistent), but an arrow comes from arms, and the hands are the price that makes the ranger's
choice a choice. Firing from the bag would hand every sword-and-board tank a free pull and make the
catalogue's 22 two-handed bows meaningless.

**What we take from it:** wield-to-fire stays; `wield <sword>` is already combat-legal here (one
command mid-fight — `wear` armour is refused in combat, weapons are not), which is the switch the
owner asked for, already built. **What we currently get wrong in the other direction:** melee with a
bow wielded uses the full trained unarmed skill — the owner punched a level-23 shaman to death around
his bow at 89 a blow, which Duris would have made a flailing, parryless embarrassment. The transcription
(swing skill zeroed and parry gutted while a fireweapon is wielded) landed the same day:
`defenceOf` divides parry by ten when the main hand carries a launcher — the swing half was already
true by construction, since a launcher trains no weapon class and so folds no to-hit and no `weapon`
half into the parry chance. Dodge is untouched, exactly as the source leaves it.

### Slice 7 — the bow that needs no arrows

The one request here the world cannot already answer. Owner, 2026-08-08:

> "we need a magic bow or 2 that has its own arrows that never run out. it is going to be a very rare and
> very hard to get bow though"

Two halves, and only the first is new mechanism:

1. **A launcher that supplies its own ammunition.** A flag on the template — the fire path skips the
   quiver lookup and the spend, and slice 4's breakage and recovery never run because there is no object
   to land. Cleanest as a field on the launcher rather than a phantom missile: an arrow that exists only
   while in flight would have to be excluded from the floor, the corpse and the loot table one call site
   at a time.
2. **Very rare and very hard to get** is placement, and it is the harder half — ranged gear is currently
   placed *nowhere* (§4), so this needs an acquisition story rather than a vnum. It should wait for
   whatever answers that for ordinary bows, or it becomes the only bow anyone can get.

Authored, at or above `AUTHORED_VNUM_BASE` — the source ships no such object, and inventing a Duris vnum
for it would put our content in their number space.

**Deliberately last.** It is the reward at the end of the mechanic, and building it before the mechanic
means the rare bow is the thing being debugged.

**Closed 2026-08-09, both halves.** The mechanism is the `conjures` field — the conjured missile's
display name, which is also the flag; the shot path simply never has a missile object, so the spend,
the landing, the corpse and the breakage all skip themselves. The acquisition is the owner's ruling,
*"loot on a named boss"*: **the Whisperwind (vnum 9000001, 3d6+2, +3, conjures a shimmering arrow)
is wielded by Malice, the half-breed son of Strife** — level 60, 60d143+6600 hit points, forty rooms
deep in IceCrag, the same mob the aggression system was verified against. Wielded rather than carried,
so the bow is visible on the body of the thing you have to kill for it, and the corpse fold already
takes worn gear. Instances standing before the ruling carry nothing; the next repop arms him.

### Already answered by slice 1 — do not build these

Three of the owner's follow-ups (2026-08-08) turned out to be requests for data the harvest was already
carrying and discarding. Recorded so nobody builds them twice:

- *"quivers that hold up to 50 arrows for higher levels"* — **50 of the 53 quivers already hold 50 or
  more.** Capacity is in slots and a full stack of 20 missiles costs one, so the range is 20 arrows
  (vnum 22259) to 2,400 (vnum 94017). What was wrong was the panel, which printed the slot count and
  read as "holds 5"; it now says arrows.
- *"different types of arrows that do different damage"* — **19 distinct damage dice across the 53
  missiles that carry them**, 1d1 to 4d6, including `45012` an arrow of slaying (4d6) and `184` an arrow
  of mortal-slaying (5d4).
- *"same goes for throwing knives for rogues"* — **68 throwable knives and daggers, 23 distinct dice**,
  2d4 the commonest, up to 5d10. (`10d100` on one record is almost certainly a builder's typo and worth
  a look before anyone tunes against it.)

---

## 4. Numbers worth having to hand

- **Catalogue:** 50 fireweapons, 58 missiles, 53 quivers, 334 throwables (295 type-5 weapons, 110 of them
  daggers, 177 range-2 capable). Real vnums — `180` a bow (rof 60, range 60, mtype 1), `182` an arrow
  (1d6, mtype 1), `181` a quiver (cap 25, mtype 1), `37704` a throwing dagger (1d4, range 2).
- **Acquisition:** ranged gear is placed **nowhere** in the world. `spawns/*.json` are mob templates with
  no equipment or inventory, and zone JSON carries no item resets. The only sources are two archery shops
  — 36439 in room 36589 (crossbow kit) and 132611 in room 132979 (bow kit). Whether shop stock is
  instantiated at run time is unverified and worth five minutes before slice 1.
- **Pull population:** 255 of 1,503 (17%). See §0.4.
- **Art:** `quiver-quiver`, `weapon-ranged-crossbow-crossbow`, `weapon-ranged-slingshot-slingshot` staged;
  no bow, no arrow; zero ranged items have an `art` id.

## 5. Two smaller traps

1. **`reload` is vestigial.** `do_load_weapon` (`range.c:1363`) reads `equipment[HOLD]` and treats
   `value[1] - value[2]` as capacity-minus-loaded, which collides with `do_fire`'s use of the same slots.
   `do_fire` never consults it. Its only live users are siege-engine specprocs. Do not transcribe it.
2. **`throw` is refused in combat in the source** (`CMD_N`) while `fire` is allowed (`CMD_Y`). That is
   probably an artefact of throwing being unfinished rather than a rule worth keeping — but it is a
   divergence either way, so decide it deliberately.
