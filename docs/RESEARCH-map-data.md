# World data sources — research notes

_Last updated 2026-07-28._

## Question

Where do we get the ~325 zones / ~60,000 rooms of TorilMUD's world in a machine-readable form?

## Finding: NyyLIB ships the whole map

The community Mudlet client script **NyyLIB** (`https://github.com/Nyyrazzilyss/NyyLIB`) contains a
complete, actively-maintained map of TorilMUD.

| File | Size | Notes |
| --- | --- | --- |
| `map/toril.map` | 10,222,486 B (~10.2 MB) | Mudlet serialised map — rooms, areas, coordinates, exits |
| `map/TorilMud.dbm` | 47,104,000 B (~47.1 MB) | Larger companion DB; format to be confirmed on inspection |
| `arealist.txt` | small | ~350 lines, `<zone id>  <zone name>`, whitespace-delimited |

Repository metadata: license **GPL-2.0**, description "Mudlet client script for Torilmud", last
updated 2026-05-27. It is maintained, not abandonware.

### Why this is the best source

A Mudlet map already stores, per room: room id, area (zone) id, room name, **x/y/z coordinates**,
exit links, and an environment/terrain id. That means:

1. We skip writing a Diku `.wld`/`.zon` parser entirely.
2. **The hard part is already solved for us.** The layout problem — turning a room *graph* into a
   consistent 2D/3D *grid* — has been done by hand, by players, over years of play. Our layout pass
   degrades from "solve it from scratch" to "validate and clean up", which is a much smaller and much
   more reliable job.
3. Coordinates are human-curated, so the resulting maps will look *right* rather than merely
   topologically correct.

### Resolved on inspection

`toril.map` turned out to be irrelevant. It is a Mudlet binary map, **format version 20**
(big-endian QDataStream) — parseable but version-fragile. We do not need it, because:

**`TorilMud.dbm` is a plain SQLite 3 database** (8 KB pages × 5,750 = exactly 47,104,000 bytes) in
**zMUD/CMUD mapper** schema. It is strictly better: queryable with `node:sqlite`, no native
dependency, no binary parsing. `toril.map` is retained only as a cross-check if the DB ever looks
wrong.

#### Schema, as established by inspecting real data (none of it documented upstream)

| Table | Rows | Meaning |
| --- | --- | --- |
| `ObjectTbl` | 46,576 | **Rooms.** zMUD calls every map entity an "object". |
| `ExitTbl` | 118,885 | **Exits.** |
| `ZoneTbl` | 327 | **Zones**, with names and bounds. |
| `DirTbl` | 10 | Direction definitions — but see the trap below. |
| `ExitKindTbl` | 3 | `0` Normal Exit, `1` Door, `2` Locked Door. |

Key columns: `ObjectTbl.{ObjId, Name, Desc, X, Y, Z, ZoneID, RefNum}`,
`ExitTbl.{FromID, ToID, DirType, ExitKindID, Name}`.

- **`ObjectTbl.RefNum` is the MUD's own room vnum** — populated for 46,530 / 46,576 rooms, range
  `[0, 97271]`. This is the join key back to the live game. Never renumber it.
- 46,439 rooms have names; 25,454 have descriptions.

#### Two traps that silently corrupt everything

1. **`ExitTbl.DirType` is 0-based and is _not_ `DirTbl.DirId`.** `DirType` runs
   `0=n, 1=ne, 2=e, 3=se, 4=s, 5=sw, 6=w, 7=nw, 8=up, 9=down, 11=special`, while `DirTbl.DirId` is
   1-based in a different order. Joining one to the other rotates every direction by one step and
   the result still *looks* plausible. The tell that you have it right: cardinal counts come out at
   ~27,000 each and balanced (n≈s, e≈w, up≈down). Diagonals are essentially unused — 32 exits in
   the entire world.
2. **`DirTbl.Dx/Dy/Dz` (200/100) are zMUD's default _drawing_ deltas, not this map's grid pitch.**
   The real pitch measures **240 horizontal, 1 vertical**. `worldgen` detects it by taking the modal
   exit delta rather than trusting the table — a mode survives hand-dragged rooms, where a GCD would
   collapse to 12.

`Y` grows southward, which matches our screen-space convention exactly. No conversion needed.

#### Data quality — better than hoped

Across the full world: **93.9% of exits land on the exact neighbouring cell**, 5.3% need an in-zone
portal, 0.8% cross a zone boundary. Discards are negligible (32 diagonal, 306 special "enter x",
236 duplicate-direction, 2 dangling, 31 cell collisions). The hand-curated coordinates are good.

#### No terrain column exists

There is no sector field. `ObjectTbl.Color` looked promising but 93% of rooms carry the default
`536870911`, so it is mapper annotation rather than data — and zone 35 "Color legend" stores no
labels alongside its swatches, so it cannot be decoded either. Terrain is therefore **inferred from
room and zone names** by the rule table in `packages/worldgen/src/terrain.ts`. Current split: 65.3%
matched on room name, 11.6% on zone name, **23.2% fell back to the default** — that last figure is
the number to drive down as the rules improve.

#### Chosen first slice

**Zone 390, The Nightwood** — 49 rooms, single Z-level, 8×9 grid at 68% fill, and it parses at
**99.2% exact neighbours with zero in-zone portals**. Forest terrain, which is LPC's strongest
tileset. Its neighbour **zone 157, Nightwood Border** (31 rooms) is the natural second zone for
testing zone-to-zone travel.

## Second source: Duris, for descriptions and real sector data

Sojourn split in 1995 into Toril and **Duris: Land of BloodLust**. The Duris source is public at
[Community-Duris/DurisMUD](https://github.com/Community-Duris/DurisMUD) (updated daily; **no licence
file — all rights reserved**, so same personal-use posture as everything else here). Cloned shallow
to `data/zones-source/duris/`.

`areas/wld/` holds **447 `.wld` files, 141 MB** in classic Diku format, plus 447 `.mob`, 443 `.obj`,
443 `.zon` and 265 `.qst`. Record layout:

```
#<vnum>
<name, colour-coded, '~' terminated>
<description ... '~'>
<zone_number> <room_flags> <sector_type>
D<0-5>
<exit description '~'>
<exit keywords '~'>
<door_flag> <key_vnum> <to_room>
S
```

**Third direction encoding in this project — Diku uses `0=N, 1=E, 2=S, 3=W, 4=U, 5=D`.** That is
different from zMUD's `DirType` *and* from `DirTbl.DirId`. Three encodings, three chances to be
silently off by one. Always assert the n≈s / e≈w balance after mapping.

Room names carry Duris colour codes (`&+L`, `&n`, `&-R`) which must be stripped before use.

### Identifying zones across the split

Duris renamed many inherited zones, so names cannot be joined directly. **Room names can be** — they
are the world's actual prose and largely survived on both sides. Matching normalised room names and
voting per zone pair identifies zones regardless of renaming:

| Toril zone | Duris file | overlap | margin |
| --- | --- | --- | --- |
| Lake Skeldrach Island | `skulldrach` | 100% | — |
| IceCrag Castle | `icecrag` | 96% | 161× |
| The Sedawi Mountain Village | `pharrvly` | 75% | 80× |
| Yggdrasil | `jotun` | 75% | — |

Topology matching was considered and is not needed — name voting is stronger and far cheaper.

**Yield, stated honestly:** only **21%** of Toril's 15,536 distinct room names occur anywhere in
Duris (3,270 shared). That gives **44 confident zone matches** (≥30% overlap, ≥2× margin), 19 weak,
and **242 with no usable match**. Duris now has ~782k room records to Toril's 46.5k, having grown
mostly through large wilderness zones with heavily repeated room names.

So Duris is a **partial** enrichment source, not a replacement. What it is worth harvesting for, in
priority order:

1. **`sector_type` — real terrain data**, replacing the name-guessing in `terrain.ts` for every room
   we can join. This is the single most valuable thing here, because 23.2% of rooms currently fall
   back to a default sector.
2. Room descriptions for the ~3,270 shared names.
3. Door names, keys and flags from the exit records.
4. `.mob` / `.obj` data for populating matched zones.

## Fallback sources, in preference order

1. **Local Mudlet profile** — if NyyLIB is already installed, the map is on disk and current.
2. **Live capture** — connect a client, walk, and record room name/exits per room. Slow, but it is
   ground truth and it validates whatever the static map claims.
3. **Diku-format zone files** — the `.wld`/`.zon`/`.mob`/`.obj` originals. Richest data by far
   (mobs, objects, resets, door keys), but not located publicly so far.
4. **Official map page** — `https://www.torilmud.com/news/maps/`, human-readable maps only.

## Licensing position

NyyLIB's *code* is GPL-2.0. The *world data* inside it is derived from TorilMUD's copyrighted world,
and the Forgotten Realms setting is Wizards of the Coast's. Personal, non-distributed use is the
working assumption. Consequences for how we build:

- Keep world data out of the engine packages and out of any published build.
- `data/` is git-ignored; the pipeline reads source data and emits derived data, and neither is
  committed.
- The engine must run on a synthetic/aut-generated world too, so the project stays viable and
  demoable without third-party content. This is a hard architectural requirement, not a nicety.

## Sources

- [NyyLIB on GitHub](https://github.com/Nyyrazzilyss/NyyLIB/)
- [Mudlet Script v011rc2 — TorilMUD Forums](https://www.torilmud.com/phpBB3/viewtopic.php?t=26684)
- [TorilMud — Mudlet Forums](https://forums.mudlet.org/viewtopic.php?t=22489)
- [TorilMUD maps page](https://www.torilmud.com/news/maps/)
- [Wld File — TorilMUD wiki](http://torilmud.wikidot.com/wld)
- [TorilMUD — Wikipedia](https://en.wikipedia.org/wiki/TorilMUD)
