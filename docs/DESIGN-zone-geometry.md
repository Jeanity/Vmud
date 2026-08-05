# Zone geometry — adding and removing rooms

_Written 2026-08-05, before any code. `ROADMAP.md`'s A8 entry asks for exactly this, and says why:
**four of A8's five problems are decisions rather than work.** This note takes each one, measures it,
and picks an answer. Nothing here is built yet._

A5 already edits a room's **content** — name, prose, terrain, flags — and refuses its **geometry** by
name. That refusal is the thing this note exists to lift, and it was not squeamishness: id, position
and exits are the join key between every data source we have and the grid every client renders.

---

## The measurements this rests on

Everything below is counted from the shipped world rather than estimated.

| Fact | Number |
| --- | --- |
| Rooms in the generated world | **46,508** |
| Highest room id | **97,271** |
| Room ids above 1,000,000 | **0** |
| Exits | **118,170** |
| Exits already pointing at a room that does not exist | **5** |
| Reset commands | **8,427**, naming **2,196** distinct rooms |
| Reset commands that name a room, by kind | mob 2,016 · equip 2,354 · door 1,278 · object 773 · give 1,642 · follower 35 · put 329 |

---

## 1. A new room has no vnum

**The constraint.** `CLAUDE.md`: room and zone ids are the MUD's own numeric ids and are never
renumbered, because they are the join key between the zMUD map, the `.wld` files, the reset tables and
every save file that has ever recorded where somebody stood.

**The decision: authored rooms are numbered from 1,000,000 up, in a second overlay file.**

This is `items-authored.json`'s shape reused wholesale, and deliberately — A6b already argued it and
the argument holds unchanged. Three parts:

- **The range is safe with an order of magnitude to spare.** The highest real id is 97,271 and nothing
  is above a million. A re-harvest cannot collide with an authored room, and it cannot be made to by
  a builder adding an area.
- **The counter is stored, not derived.** A6b's reason applies exactly: deleting the highest room
  would otherwise free its number, and a recycled id silently changes what a saved `lastRoom`, a
  reset command or another room's exit is pointing at. A room id is a name, and names are not reused.
- **A second file, not a range check inside `rooms.json`.** The lifecycles are opposite, which is the
  same reason items needed two: a *partial* override that authors nothing must be deleted or the room
  wears a ✎ for ever, while a *created* room whose prose is blanked is a room with no prose, not a
  request to unmake it.

---

## 2. Resizing a grid invalidates every saved `seen` map — the sharp edge

**The constraint, in the code's own words** (`players.ts`):

> …tile indices are row-major, so regenerating a zone into a wider grid shifts every one of them.
> That invalidates saved maps by construction; all this guarantees is that it degrades into a
> wrong-looking map rather than an out-of-range write.

`ensure()` only ever *grows* a bitset and copies the old bytes in place. That is safe against a crash
and wrong about geography: every tile index past the first row now names a different tile.

**Why it bites here and not in A5.** `buildZoneTilemap` sizes a grid from `boundsOf(rooms)` **on that
level**, and a cell is `ROOM_STRIDE` = 11 tiles. So adding one room outside the current extent widens
the grid by 11 tiles and shifts every index below the first row. A5 cannot trigger it, because
changing prose or terrain never moves a bound. A8 triggers it on its very first new room.

**The decision: the overlay declares the Place's extent, and a change to it invalidates that Place's
`seen` explicitly.**

Two halves, and the second is the one that makes this liveable:

- **Store the grid's cell extent in the authored overlay**, not merely the rooms. Then "did the grid
  change" is a comparison of two small records rather than a re-derivation, and it can be answered
  before anything is rebuilt.
- **When it changes, clear that Place's `seen` for every character and say so.** Not silently
  degrade. A wrong-looking map is the worst of the three outcomes: a cleared map is honest and
  re-explorable, a preserved map is impossible, and a *shifted* map is a bug the player will report as
  the fog being broken.

**Rejected, with reasons.** *Re-mapping the bitset* — walking old indices to new — is possible in
principle and wrong in practice: it needs the old grid's width, which is not stored, and it would have
to be right for every character offline as well as online. *Padding every grid to a fixed size* trades
a rare invalidation for a permanent memory cost on 327 zones and re-opens the 4992×5760 render texture
that tightening the bounds was introduced to fix. *Refusing to add a room outside the extent* is the
cheapest and is worth keeping as a **first slice** — it makes infill free — but it cannot be the whole
answer, because the interesting rooms to add are on the edge.

---

## 3. Exits are two-sided

**The constraint.** An exit is one direction on one room; a doorway is two. Deleting a room leaves its
neighbours pointing at nothing, and adding one has to wire the reverse direction — through
`CLAUDE.md` gotcha 1's three direction encodings.

**The decision: the editor writes both sides, and `world.doorway`'s precedent is the model.**

A4's door ops already work both ends for exactly this reason, and the phrasing there applies here:
*a doorway worked from one side only is a wall from the other.* One helper owns the pairing, and the
UI never offers a one-sided exit.

**Dangling exits are tolerated rather than forbidden, and that is measured.** The shipped world
already has **5** exits pointing at rooms that do not exist, and the engine handles them — they are
simply not walkable. So deleting a room does not create a new failure mode, it creates more of one
that already works. The editor should **report** the exits it orphaned rather than refuse the delete
or silently rewrite five neighbours the operator was not looking at.

---

## 4. Reset tables name rooms

**The constraint, measured.** 8,427 reset commands name **2,196 distinct rooms** — mob placements,
equipment, doors, objects. Deleting a room orphans every command pointing at it.

**The decision: `reset.ts` already skips what it cannot place; make that visible rather than silent.**

This is the smallest of the five, because the executor is already defensive — a reset naming a room
the server has not loaded is a normal state of a partial world, not an error. What is missing is
**telling somebody**. The delete path should count the reset commands it orphaned and report them, the
same way the repop button reports what it placed.

Worth stating so nobody discovers it: the spawn files are a **worldgen output**, so an authored delete
cannot edit them. The orphaned commands come back on every rebuild and are skipped on every boot.
That is correct and it is also why the count has to be shown at delete time — it is the only moment
anybody will see it.

---

## 5. The overlay must *add*, not merely override

**The constraint.** A5's `rooms.json` is a map of vnum → partial patch, composed over a room the
harvest produced. There is no harvest under an authored room, so there is nothing to patch.

**The decision: two files, `rooms.json` and `rooms-authored.json`, merged in that order** — the
harvest, then A5's patches over it, then whole authored records appended. `GameWorld` gains one
composition step and `overrides.ts` gains a sibling; nothing else changes shape.

This falls out of decision 1 and needs no separate argument: the id range and the file are the same
choice seen from two directions.

---

## What to build first

The five decisions do not have to land together, and the order that keeps every step drivable is:

1. **Infill only** — authored rooms whose position is *inside* the Place's current extent. This needs
   decisions 1, 3 and 5 and side-steps 2 entirely, so the first slice cannot invalidate anybody's map.
   **Seen when:** you draw a room in a gap Duris left, walk into it, and it survives `npm run worldgen`
   — which is A8's own completion test, reached without touching the sharp edge.
2. **Deletion**, with the orphan report from decision 4.
3. **Extent changes**, with the explicit `seen` invalidation from decision 2 — last, because it is the
   only one that can take something away from a player who was not consulted.

---

## What this note does not decide

- **Whether the map editor is drag-and-drop or coordinate entry.** A4b's zone map already draws a cell
  per room at its own grid position and takes clicks, so it is the obvious host; how a room is
  *placed* is a UI question and does not constrain any of the five decisions above.
- **Cross-zone exits.** Every one of the 991 is a portal by construction (`HANDOFF.md` decision 1), so
  authoring one is a different job with a different rule, and it is not in A8's scope.
- **Whether authored rooms can be moved after creation.** Moving is a delete and an add against the
  same id, so it inherits decision 2's edge; deferring it costs nothing and settles nothing wrongly.
