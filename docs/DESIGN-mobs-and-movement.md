# Design: click-to-move, mobs, aggression and loot

_Captured 2026-07-29 from the project owner's specification. This is the target design; nothing here
is implemented yet. Sequencing is deliberately not decided in this document._

---

## 1. Click to move

Click a point on the map and the character walks there.

### The hard rule: you cannot click into the fog

Pathing must never route through, or terminate in, ground the character has not explored. This is an
anti-speedrun measure: without it, a player reveals a zone's shape once and then clicks straight
across the map, and exploration — the thing fog of war exists to create — stops mattering.

**This forces the pathfinder onto the server.** If the client computes the route, a modified client
simply paths through the fog and the rule is decoration. Fortunately the server already owns the
authoritative explored-room set per character (it drives fog, and persists to
`data/players/<name>.json`), so the constraint costs no new state:

> A* over the tile grid, with the successor test restricted to tiles belonging to rooms in
> *that character's* explored set.

Consequences worth stating plainly:

- A click on an explored tile can still legitimately **fail**, when every route to it crosses
  unexplored ground. That is correct behaviour, not a bug, and the client should say so rather than
  silently doing nothing.
- Two players clicking the same tile can get different answers. Paths are per-character, because
  explored maps are.
- The route is recomputed, not cached, when the explored set grows mid-walk.

### Shape of the implementation

1. Client sends an intent: `{ t: 'moveTo', tx, ty }` — a tile coordinate, never a path.
2. Server runs A* on the grid for that player's `Place`, gated on their explored set.
3. On success the server stores the path against the player and, each tick, derives the steering
   intent toward the next waypoint — reusing `stepMovement()` exactly as keyboard steering does, so
   collision and client prediction stay identical for both input methods.
4. Any keyboard input, or taking damage, cancels the path.
5. The client draws the route and the destination marker for feedback, and predicts along it.

### Open scope questions

- Within the current `Place` only, or across zone boundaries (auto-travel through portals)? Starting
  within a single `Place` is far simpler and is assumed below.
- Should the path be allowed through a *closed but unlocked* door? Assumed yes, opening it en route.

---

## 1b. Camera: scroll to zoom

Mouse wheel zooms, across several levels rather than the current binary `M` toggle between 1× and
fit-the-zone.

**Use discrete steps, not continuous zoom.** The renderer runs `pixelArt: true`, which forces
`NEAREST` texture filtering; at fractional scales that makes 32 px tiles shimmer and crawl as the
camera moves, and it is the single most common way a pixel-art game ends up looking cheap. Clean
ratios avoid it entirely. A reasonable ladder:

| Level | Scale | Shows | Purpose |
| --- | --- | --- | --- |
| 0 | 2× | part of a room | Character and equipment detail |
| 1 | 1× | ~2 rooms | Default |
| 2 | 0.5× | ~8 rooms | Local navigation |
| 3 | 0.25× | ~30 rooms | Route planning |
| 4 | 0.125× | most of a `Place` | Getting your bearings |

**`'fit'` is deliberately not on the wheel — it is <kbd>M</kbd> only.** It does not merely change
scale: it stops following the character and centres the *map*. Reaching it by wheeling meant the last
notch silently changed what the camera was doing, which is what made zooming out lurch.

Notes, as shipped:

- Animate between steps (~150 ms ease); snap the final value to the exact ratio so filtering stays
  clean at rest.
- **The character stays dead centre at every wheel level.** The wheel deliberately does *not* zoom
  toward the cursor — anchoring on the pointer is the same thing as pushing the character off centre.
- **Camera bounds carry half a viewport of slack on every side**, so the camera can centre on a
  character standing anywhere, including the map's corner. Clamping to the map edge instead made a
  character near an edge drift off centre as the view widened. Seeing past the edge costs nothing:
  never-seen ground is painted full black by the fog and the camera clears to near-black.
- Room labels show only at 1× and 0.5×; unreadable at 0.25× and noise beyond.

**Zoom does not leak information.** Fog is authoritative and keyed on tiles the character has
actually *seen*, not on view distance, so zooming out reveals only what has already been explored.
The overview is effectively a fog-limited minimap, which is a feature — and it means zoom needs no
anti-cheat treatment, unlike click-to-move.

---

## 2. Mobs

### 2.1 Identity and statistics

| Field | Meaning |
| --- | --- |
| `id` | Stable template id, ideally the MUD's own mob vnum |
| `name`, `shortDesc`, `longDesc` | Display and room prose |
| `level` | Drives XP, and the SRD proficiency curve |
| `abilities` | `str`, `dex`, `con`, `int`, `wis`, `cha` |
| `hitDice`, `maxHp` | SRD hit dice |
| `ac` | Armour class |
| `attacks[]` | Name, damage dice, and **reach** — see 2.4 |
| `speed` | Movement rate, in the same units as `PLAYER_SPEED` |

**Note on "agility".** The spec says "int, agi, str etc". SRD 5e — which `@mygame/shared/rules`
already implements and tests — names that stat **Dexterity**. Treating `agi` as `dex` keeps one stat
system rather than two, and every existing function (`abilityMod`, `resolveAttack`) applies
unchanged. Displaying it as "Agility" in the UI is free if preferred.

### 2.2 Perception and reaction time

`reactionMs` — how long a mob takes to notice an intruder.

A character who enters and leaves a mob's perception inside that window is **never noticed**, so a
room can be run through without triggering an encounter. This is the most mechanically valuable field
in the whole model: it produces speed-running, sneaking past dangerous rooms, and the tension of
deciding whether to risk it — from a single number.

Implied bookkeeping: per (mob, character) dwell timers, started when the character enters perception
and discarded when they leave. Modifiers to fold in later: character stealth, mob `wis`, light level,
and whether the character is already in combat.

### 2.3 Aggression

Three dispositions:

| Disposition | Behaviour |
| --- | --- |
| `passive` | Never initiates. Fights back when struck. |
| `aggressive` | Attacks on sight, once `reactionMs` has elapsed and the target is within `aggroRange`. |
| `territorial` | *"Get off my lawn."* Tolerates presence for `graceMs`, then rolls each combat round with probability `provokeChance` to attack. The longer you linger, the likelier it is. |

`territorial` is the interesting one and should not be modelled as a timer that flips to
`aggressive` — the per-round roll is what makes lingering feel risky rather than merely timed. The
roll goes through the seeded RNG in `@mygame/shared/rules`, never `Math.random()`, so encounters stay
reproducible and auditable.

Additional flags worth carrying from MUD tradition: `assistsOthers` (joins any fight involving its
faction), `attacksWeakOnly`, `sentinel` (never leaves its room).

### 2.4 Attack range

`reach`, per attack, in tiles — **for ranged attacks and spells only**. Melee does not range-check
inside a room; see §2.6, which decides this and explains why.

So `reach` distinguishes a bow, a breath weapon or a spell that can strike across a room from a
melee attack that simply connects once engaged. A ranged attacker should prefer to hold distance,
which needs a little steering AI rather than a pure melee lunge — and holding distance is meaningful
precisely because closing it does not stop the melee it is avoiding.

### 2.5 Tracking and pursuit

When a character flees, a mob may follow.

| Field | Meaning |
| --- | --- |
| `trackRooms` | How many rooms it will pursue through. 0 = never leaves. |
| `trackPersistenceMs` | How long it keeps hunting after losing sight |
| `callsForHelp` | On engaging or being hurt, alerts nearby mobs |
| `assistRange` | Radius, in rooms, over which the call is heard |

Pursuit is a **room-graph** walk, not a tile-space chase: the mob follows the exits the character
took. This matters because the room graph is the only structure that is correct across `Place`
boundaries, and it is already the unit of interest management.

The "gathers all its friends" case is the emergent product of `callsForHelp` plus `assistRange` — a
fleeing character trailing a growing pack is a chain of independent assist rolls, not a special case.
It should be possible to be genuinely, memorably overwhelmed by it.

**Settled (Phase 6): pursuit stops at the edge of a `Place`.** A mob follows freely through the room
graph of the zone-and-level it is in, and never up a staircase or across a zone boundary. See
[DESIGN-engagement.md](DESIGN-engagement.md) §7 — note that a staircase is a `Place` change too, so
this is not "chases you anywhere inside the zone".

**Amended (15c): a *portal* is no longer a reason on its own.** Phase 6 also refused any exit flagged
`portal`, reading the flag as "leads to another `Place`". Measured: of the **7,261 portals** in the
shipped world the great majority are not — they are same-level links the layout pass could not
reconcile with the map's coordinates, and **4,996 same-level exits are simply not axis-aligned** with
their destination's grid position. So the flag conflated *"leads somewhere else entirely"* with *"the
map cannot draw this"*, and refusing on it meant a player could shake any pursuer by stepping through
an ordinary door. That was invisible and harmless until 15c drew portals on the wall; the moment they
became clickable it was a discoverable exploit. The rule is now the `Place` comparison alone, which
was already doing the real work — a portal that genuinely crosses a `Place` is still refused by it.

### 2.6 Engagement is sticky — decided, and load-bearing

**Measured:** a room is 9×9 tiles, so its longest internal distance is ~11.3 tiles = 362 px, which at
`PLAYER_SPEED` (150 px/s) takes **2.4 seconds**. A combat round is **3 seconds**. A character can
therefore cross an entire room in less than one round.

If reach were checked on every swing, walking away from a melee attacker would be free: you would be
out of range before its next swing landed, at no cost, using ordinary movement. Everything in §2.7
and §2.8 collapses at that point — there is no reason to hold aggro if aggro cannot hold you, no such
thing as a tank, no rescue, and the "lure one dragon out" tactic degenerates into kiting all three.

**The decision: engagement is sticky.**

- Once two combatants are engaged, **melee connects regardless of where either stands inside the
  room**. Position within a room is not a melee range check.
- **Reach matters for ranged attacks and spells only** — the `reach` field in §2.4 governs those, and
  a ranged attacker still wants to hold distance.
- **Disengaging is a deliberate act with a cost**: `flee`, which may fail, may provoke, and hands the
  initiative to whatever you were fighting. Not something that happens by walking.
- **Leaving the room** ends engagement, and is what pursuit (§2.10) responds to.

This keeps the whole tactical model intact while losing nothing the owner asked for: pulling is a
*room-level* decision about which mobs aggro (§2.9), not about kiting inside one, so it is unaffected.

> **The trap.** This is the decision that gets made by accident. Writing `if (distance <= reach)`
> into the first attack handler silently chooses positional action-RPG combat, and by the time anyone
> notices, threat and tanking have been built on top of something that cannot support them. The first
> combat code written must make stickiness explicit — an engagement relationship between two
> entities, not a distance test.

**The full model is [DESIGN-engagement.md](DESIGN-engagement.md)** (roadmap Phase 6), which is where
this decision was finished. It settles what the relationship *is* — a directed pointer with a derived
inbound set, not a symmetric object — what starts and ends engagement, what "in combat" forbids
command by command, and the one place we diverge: **steering still works inside the room, only the
exits are refused.** Duris forbids movement outright, but Duris had no continuous movement to make a
frozen character look like a hung server.

### 2.7 Threat, target selection and group combat

**This is the mechanic that decides whether combat is tactical or a stat check.** A mob does not
simply attack whoever hit it first; it attacks whoever is the biggest threat, and it re-evaluates.

Each engaged mob keeps a threat table:

```
threat: Map<EntityId, number>
```

- Damage dealt adds threat, 1:1 as a baseline.
- **Healing an engaged ally also adds threat** — typically half the amount healed. This is why
  healers get attacked, and it is what forces a group to protect them.
- The mob targets the highest-threat entity it can reach.

**Switching requires hysteresis, and this detail is not optional.** A mob must only change target
when the challenger exceeds the current target's threat by a margin — around 110% — because with a
bare `>` comparison two similar attackers make the mob spin between them every single round. That
looks broken, and it makes holding aggro deliberately impossible, which kills tanking outright.

The owner's example is the specification: a ranger shoots and flees; a warrior then deals twice the
damage; the dragon drops the ranger and turns on the warrior. That single behaviour produces:

- **Tanking** — someone can hold a mob's attention on purpose.
- **Kiting and off-tanking** — threat can be deliberately traded between players.
- **Leading mobs to chosen ground** — pull something to terrain that suits you, then have the group
  take it over.
- **Protecting healers and casters** — threat generated from the back line is a real liability.

Threat decays when a target becomes unreachable or leaves combat, otherwise whoever landed the first
blow keeps aggro forever after running away. On target death, or when the top-threat target cannot be
reached, the mob falls to the next entry.

### 2.8 Morale and self-preservation

Mobs decide whether a fight is still worth having, evaluated on round boundaries:

| Field | Meaning |
| --- | --- |
| `wimpyAt` | HP fraction below which it attempts to flee. Diku's `WIMPY`, and most mobs should have one. |
| `courage` | Willingness to stay engaged while outnumbered |
| `callsWhenAfraid` | Shouts for help rather than simply running |

A high-`int` mob should flee *toward its allies* rather than in a random direction, which turns a
fleeing mob into a developing problem instead of an escape. A cornered or cocky mob may choose to
press on regardless — the owner's "continue the pursuit or recognise danger".

### 2.9 Pulling — emergent, not a system

Separating one mob from a group is the clearest expression of tactical play, and **it needs no
dedicated mechanic**. It falls out of three fields already in the model being independent numbers:

| Field | What tuning it does to encounter design |
| --- | --- |
| `aggroRange` | How close you can get before being noticed |
| `assistRange` | How far its cry for help reaches |
| `reactionMs` | How long you have to tag and withdraw before it responds |

When `assistRange < aggroRange`, singles can be pulled. When `reactionMs` is generous, a fast player
can strike and retreat before the room wakes up. When the numbers are inverted, the whole room comes
at once and the encounter is a wall.

**Those three numbers per template are the encounter design.** Three dragons in one room become a
puzzle rather than an arithmetic problem, exactly as intended.

### 2.10 Pursuit configuration is per-encounter

Escape conditions are not global rules — they are per-template, so different creatures feel
genuinely different to escape:

```
pursuit: {
  tier: 'sentinel' | 'local' | 'zone' | 'relentless',
  trackRooms: number,
  giveUpMs: number | null,        // null = never gives up on time alone
  respectsSafeRooms: boolean,     // needs room flags — see below
  losesTrail: boolean,
  trailDecayMs: number,
}
```

Worked examples:

| Creature | Configuration | How it plays |
| --- | --- | --- |
| Dire wolf | `local`, 3 rooms, gives up 30 s, respects safe rooms | Outrun it |
| Zone elite | `zone`, gives up 2 min, respects safe rooms, loses trail | Escape within the zone |
| **Dragon** | `relentless`, never gives up on time, **ignores safe rooms**, can lose trail | Running into a village does not save you. Outwitting it does. |
| Quest nemesis | `relentless`, ignores everything | One of you dies |

Tracking for `relentless` mobs is a **scent trail with decay**: the mob follows the room path the
target actually walked, and the trail fades. Doubling back, portals, water and raw speed all become
real counterplay, so a clever player escapes a dragon where a panicking one does not.

A world-crossing hunt is **broadcast beyond normal room scope** — other players see the dragon
tearing through their zone and can help, flee, or watch. One player's mistake becomes everyone's
content, which is the sort of thing MUDs are remembered for.

> **Prerequisite:** `respectsSafeRooms` depends on room flags that **do not exist in the data yet**.
> `RoomFlag` declares `safe` and `peaceful` in `packages/shared/src/world.ts`, but
> `packages/worldgen/src/zmud.ts` never populates them — the zMUD mapper database has no flags
> column. They must come from the Duris `.wld` room-flags bitfield, which does carry them. Until
> then, `respectsSafeRooms` has nothing to respect.

### 2.11 Loot

Each template carries a loot table:

```
loot: {
  coins: { min, max },                     // rolled through the seeded RNG
  entries: [
    { itemId, chance, quantity: { min, max } },
    ...
  ]
}
```

Design decisions still open: whether entries are independent rolls or weighted-pick-one; whether
tables are shared and referenced by id (strongly preferable once there are hundreds of mobs); and
whether level scaling applies.

### 2.12 Quest hooks

Mobs must be able to participate in quests without quest logic leaking into the mob model:

- `questDrops[]` — items dropped **only** while the killer has an active quest requiring them, so
  quest items do not flood the economy.
- `questTags[]` — opaque string tags a kill counts against, e.g. `kill:goblins:moonwood`. Kill
  counters increment by tag rather than by mob id, so "kill 10 goblins" works across several goblin
  templates without enumerating them.

Keeping both as data on the mob, and all evaluation in a separate quest system, means the mob model
never needs to know what a quest is.

---

## 3. Where the data comes from

Two candidate sources exist for real TorilMUD-lineage mob data, and this is the largest open
question in the design — it decides whether mobs are authored or imported.

1. **Duris `.mob` files** — 447 of them, already on disk at
   `data/zones-source/duris/areas/mob/`, in Diku format. Diku mob records carry level, hit dice, AC,
   damage dice, gold, XP and an action-flags bitfield that already encodes `AGGRESSIVE`, `SENTINEL`,
   `SCAVENGER`, `STAY_ZONE`, `ASSIST` and similar. That is a large fraction of this model for free —
   though `reactionMs`, `graceMs`, `provokeChance`, `reach` and `trackRooms` are all **ours** and
   have no Diku equivalent, so they need defaults derived per archetype.
2. **Hand-authored JSON** per zone, for the prototype only.

The same room-name matching that identified 44 zones across the Sojourn/Duris split
(see `docs/RESEARCH-map-data.md`) is the likely route for attaching Duris mobs to TorilMUD rooms.

---

## 4. Architectural fit

Everything above is **server-side simulation**. It is renderer-agnostic, so none of it is affected by
the 2D-versus-3D question in `docs/PLAN-3d-migration.md`, and none of it is wasted if the renderer
changes later.

It also lands squarely on infrastructure that already exists and is tested:

- `resolveAttack`, `rollDamage`, `abilityMod`, `proficiencyBonus`, dice parsing — done, in
  `@mygame/shared/rules`, with 12 passing tests.
- `ROUND_MS` (3 s) and `TICK_MS` (100 ms) — the two clocks aggression and pursuit run on.
- Seeded deterministic RNG — required for every aggression, loot and attack roll.
- Room-scoped interest management — already the unit pursuit and assist calls operate over.
- The per-character explored set — already the gate click-to-move needs.

The genuinely new machinery is: an A* pathfinder over the tile grid, per-mob AI state, dwell-timer
bookkeeping, spawn and respawn management, and loot/quest tables.
