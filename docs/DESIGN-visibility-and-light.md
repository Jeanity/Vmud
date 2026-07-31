# Design: visibility, light sources and pointer movement

_Captured 2026-07-29. This **replaces** the room-granular fog currently implemented, and it is a
redesign rather than a tweak._

---

## 1. Why the current model is wrong

Fog today is **room-granular and binary**: entering a room flips its whole 9×9 block plus its
corridor stubs permanently visible, and nothing between rooms exists as a concept. The room boundary
is therefore a hard cliff — you stand at the edge of a corridor and the next room is pure black,
which the project owner described exactly:

> *like walking up to a darkened room and not being able to see inside it even though I am carrying a
> torch.*

It also broke click-to-move in practice: you could only click as far as the room edge, then had to
step across the threshold with the keyboard before the next room became clickable.

## 2. The model that replaces it

**Tile-granular visibility, with a light radius and line of sight.** Three states per tile:

| State | Rendering | Meaning |
| --- | --- | --- |
| **Lit** | Full brightness | Within the light radius *and* in line of sight right now |
| **Remembered** | Dimmed | Seen before, not currently lit |
| **Unknown** | Black | Never seen |

Two pieces of state, and they are different things:

- **`visible`** — recomputed as the character moves. Transient, never stored.
- **`seen`** — the union of every `visible` set so far. Persistent per character, per Place.

### Line of sight

Light is **blocked by walls**, computed by recursive shadowcasting over the tile grid with
`Tile.Void` as the opaque value.

This is what produces the torch behaviour, and the important part is that it needs **no special
case**: as a character approaches a corridor mouth, light spills through the opening into the next
room, because that is simply where the unobstructed rays go. Approaching a solid wall reveals
nothing beyond it. Moving around inside a room progressively reveals its shape and its exits.

### What is remembered

**Terrain is remembered; creatures are not.** You keep the shape of a room, its doors, and a chest
you saw. A mob that wanders in while you are away is invisible until you light it again.

This is the roguelike convention and it is the right one here: it keeps darkness genuinely
dangerous, and it stops explored ground from becoming a live radar.

---

## 3. Light sources

The starting radius is **2 tiles** — a 5×5 lit area inside a 9×9 room, so a character must move
toward each wall to discover its exits. This is deliberately tight, because **light is an early
progression axis rather than a constant**: a torch found quickly takes it to 3, and better sources go
further. The small start is what makes the first torch feel like a real upgrade.

`lightRadius` is therefore a **derived stat**, not a tuning constant:

```
interface LightSource {
  id: ItemId
  name: string
  radius: number
  mode: 'radius' | 'rooms'    // see below
  durationMs?: number         // absent = never expires
  expiresTo?: ItemId          // what remains when it burns out
}
```

- **Duration and expiry.** Some sources burn out. The owner's example: a *Beacon of Hope* carried for
  more than 30 seconds crumbles to dust and drops back to ordinary torch range. Expiry must be
  server-authoritative and must announce itself clearly — a light radius silently shrinking mid-fight
  in a dark zone is the kind of thing that reads as a bug rather than a mechanic.
- **`mode: 'rooms'`.** Powerful sources illuminate at *room* granularity rather than by tile radius —
  lighting whole rooms in a block around the character rather than a small circle. A different
  illumination mode, not merely a larger number.
- **Stacking.** A character's effective light is the **best active source**, not a sum. Two torches
  are not a lantern.

Because light is a stat, everything else follows for free: spells that grant light, cursed items that
reduce it, zones that suppress it, races with darkvision.

### Light comes from equipped items, and there is no light slot

**Any equipped item may emit light**, and the radius is the best among everything equipped. There is
deliberately no dedicated light slot — that would be free light forever, and the cost is the
interesting part.

A torch or lantern occupies a **hand**, so carrying one costs you a weapon or a shield. A glowing
amulet occupies the **neck**, so it costs you nothing you were fighting with. The owner's framing: a
glowing necklace replacing a lantern frees a hand, which opens up dual wielding or a shield.

So light has *two* progression axes, not one: how far it reaches, and **what it costs you to carry**.
A body-slot light at the same radius as a torch is still a significant upgrade, and should be much
rarer. See `docs/DESIGN-inventory.md` §6.

Until equipment exists, the carried-light field is an interim stand-in for "the best light among your
equipment", and should collapse into that rather than surviving alongside it.

---

## 4. Consequences for click-to-move

**The permission rule changes from "rooms you have entered" to "tiles you have seen".**

That is the direct fix to the reported problem: the ground your torch falls on is ground you can
click onto, whether or not it belongs to a room you have set foot in. It still prevents
speed-running, because you can only ever see one lit radius beyond your position — there is no way to
reveal a distant destination without walking most of the way to it.

> **What this buys at the numbers actually shipped.** Room blocks are 9 tiles on a stride of 11, so
> `ROOM_GAP` is 2 and the next room's near column is *three* tiles past your room's last floor
> column. A light of radius `r` reaches `r` tiles, so radius 3 — the first torch — is the first that
> crosses that gap. Measured, standing at your own room's east edge of a two-room fixture: **0** tiles
> of the far room lit at the starting radius of 2, **3** at radius 3. Walking still buys more than
> standing: at radius 2 the two corridor tiles light 3 and 8 tiles of the far room respectively.
>
> So without a light source, crossing a room boundary is two clicks — into the corridor, then into
> the room — and **with the first torch it is one**, because the room beyond lights up from your own
> doorway. That is deliberate. `ROOM_GAP` was 3 when this was written, which put the next room four
> tiles off and out of reach of any early light: you walked up to a doorway carrying a torch and the
> room beyond was still black, which is the complaint that started this. The content decision between
> `ROOM_GAP`, `DEFAULT_LIGHT_RADIUS` and this paragraph **has now been taken** — the gap moved rather
> than the radius, so *finding a light source* is what opens up seeing into the next room. The
> relationship is pinned by `visibility.test.ts` — *shows nothing of the next room at the bare radius,
> and reaches it at the first torch* — so whichever of the three moves next, it announces itself.

Implementation impact is small, and deliberately so. `findPath` already takes an opaque
`allowed: ReadonlySet<number>` of tile indices. **Only the construction of that set changes** — from
a union of room reveal-maps to the character's `seen` bitset for the current Place. The pathfinder,
the path following, the smoothing pass and the client rendering are all unaffected.

> The smoothing pass must continue to test membership of `allowed`, not merely walkability. A
> line-of-sight simplification that only checks walls would straighten a legal route into one that
> cuts a corner through unseen ground, silently defeating the rule while every test still passes.

---

## 5. Pointer movement

Three input modes, all resolving to the same authoritative movement:

| Input | Behaviour |
| --- | --- |
| **WASD / arrows** | Direct steering. Cancels any active path. |
| **Click** | Path to that tile once. |
| **Click and hold** | Follow the pointer continuously while the button is down. |

**Hold is a virtual joystick, not a route.** This was originally specified as continuous re-pathing
and that was wrong; the owner corrected it, and the correction is the better design.

While the button is held, the character walks **in a straight line toward the pointer**, wherever the
pointer is — lit or unlit, one tile away or across the map. Moving the pointer changes the heading
immediately. There is **no pathfinding and no routing around corners**: a wall in the way means the
character does not get there, and the player moves the pointer somewhere reachable. Releasing stops.

Walls are handled by **sliding**, not sticking, because it is the identical collision routine WASD
already uses — the two inputs must not behave differently against the same wall. Holding the pointer
past a corner can therefore carry a character round it, but only because they held it there, not
because anything routed on their behalf.

### Why this is not fog-gated, when clicking is

This looks like a contradiction — you may *steer* into darkness but not *click* into it — and it is
not. **Steering has never been gated: WASD already walks you into the dark.**

The anti-speedrun rule was never about where a character may go. It is about **pathfinding**, which
hands a player instant traversal of a known route without walking it. Steering toward a cursor earns
every tile at walking pace and cannot route around anything the player cannot see. It is a different
input device for the same walk, so it inherits WASD's rules, not click-to-move's.

Tap and hold are therefore two genuinely different verbs:

| Input | Verb | Gated on `seen`? |
| --- | --- | --- |
| Tap | Pathfind to that tile | **Yes** |
| Hold | Steer toward the pointer | No — same as WASD |

Implementation note: this needs **no protocol change at all**. `steer` already carries a normalised
direction vector and the server already resolves it through `stepMovement`. Hold-to-drag is a client
input mode that produces `steer` messages; the simulation cannot tell it apart from a keyboard, which
is exactly right.

---

## 6. Storage and protocol

**`seen` becomes tile-granular per Place**, which is more data than the current room-id set but not
much: a 168×156 grid is 26,208 tiles, or **3.3 KB as a bitset** — trivially persistable per Place
alongside the existing `data/players/<name>.json`.

Protocol shape:

- `SelfView.lightRadius` — so the client knows how far to light.
- Full `seen` bitset for a Place on arrival; **deltas of newly-seen tiles thereafter**, batched with
  the existing per-tick movement message.

Deltas rather than letting the client derive `seen` itself: the client's position is *predicted*, so
a client-derived set would drift from the server's by a tile here and there, and the server's copy is
the one that gates click-to-move. Sending the authoritative delta removes the divergence entirely,
and costs a handful of integers per tick while moving.

The client still computes **`visible`** locally each frame from its predicted position, because that
layer must be perfectly smooth and is cosmetic — being a frame or a pixel out does not matter.

---

## 7. What this obsoletes

`TileGrid.reveal` — the per-room map of "tiles this room uncovers", added for the room-granular fog —
has no remaining consumer once visibility is tile-based. Remove it rather than leaving it as a second,
subtly different notion of visibility for someone to reach for by mistake.

**Done.** `TileGrid.reveal` and `allowedTiles` (the `pathfind` export that built the old gate from it)
are both gone. The one thing that still needs the old rule is converting a pre-v4 save's room-id list
into tiles, and that now lives in `server/src/legacy-fog.ts` as `legacyRoomReveal` — named for what it
is, off the shared `TileGrid` type where new code would meet it, and deleted together with
`PlayerStore.migrateExplored` when the `explored` field is finally dropped.

Interest management is **unaffected**: which entities a player is told about stays room-scoped. Only
*rendering* visibility becomes tile-based. These are different questions and should stay that way.
