# The seamless world — the graphics upgrade

*Drafted 2026-08-09, the day the owner asked for it, standing in Velen Square: "I think we need to
start planning the graphics upgrade. While I do like the grid layout for nostalgia reasons I don't
know if other players would, so I'm thinking a more open world — but we use our maps for the
layouts, and if we need to keep people on paths etc we can do that with trees, fences, rivers,
buildings etc." This document is the plan: what changes, what must not, and the order.*

## 1. What the ask actually is

Today the world renders as what it is underneath: discrete 9×9 room blocks floating in void,
joined by carved corridors. It is honest and it is nostalgic, and it looks like a diagram of a
world rather than a world. The ask is to render the **same rooms** as continuous terrain — one
unbroken ground, no visible cells, no corridors — while everything the MUD data says still holds.

The owner's sentence contains the whole design: **"we use our maps for the layouts"** — the room
graph stays the spec — and **"keep people on paths with trees, fences, rivers, buildings"** — the
constraint the void used to enforce becomes *diegetic*. Where two adjacent rooms have no exit
between them, the player must still not walk; what stops them changes from nothing-to-stand-on to
something-in-the-way that belongs to the world: a tree line in a forest, a fence or house wall in
a city, rock in the mountains, water by the shore.

This is a **presentation change wearing a worldgen change's clothes**. It is not a new world.

## 2. What must not move

The architectural rules survive untouched, and saying so up front is the point of this section:

1. **The room stays the unit of interest management.** Room membership already derives from tile
   position (`roomAtTile`); an open floor changes which tile art is drawn, not which room you are
   standing in or who receives updates.
2. **The room graph stays the law of movement.** Where the MUD says no exit, the seamless world
   must refuse passage — by blocker tiles instead of by void. This is checkable, and §5's
   validator is the whole safety story: **flood-fill the rendered tilemap and assert its
   reachability equals the graph's connectivity, both directions.** A blocker line with a one-tile
   hole is a wall-walk exploit; an over-eager blocker is a broken zone. Neither survives a test
   that compares the two truths.
3. **The server stays authoritative and deterministic**; `stepMovement` on grids, seeded RNG,
   Places, ids — none of it is touched. The tile *walkability map* changes shape; the machinery
   that reads it does not.
4. **Room prose and names stay.** Crossing a border still announces the room in the text log —
   that is the MUD soul, and in open terrain it becomes the game's way of naming *places* rather
   than cells. The graphical MUD keeps reading as a MUD.

## 3. How it works

`buildZoneTilemap` re-projects the same data. Rooms in a zone already carry integer positions on
a shared local grid — the zMUD map's own layout, which is why the owner's "use our maps" costs
nothing: adjacency is already knowable from `pos`.

- **Ground:** fill every room's 9×9 block with its sector's floor as today, but lay the blocks
  **edge to edge with no void row between adjacent rooms**. Different sectors meet at a hard edge
  first; transition tiles (LPC's own grass-to-dirt edges and kin) are a later polish pass.
- **Open borders:** where adjacent rooms share an edge *and* an exit in that direction, the seam
  is open floor — the full shared edge or a generous gap, not today's one-tile corridor. A
  **door** narrows the seam to a gate and draws as the door object it is.
- **Blocked borders:** adjacent rooms with *no* exit get a blocker line along the shared edge,
  chosen by the sectors it separates: tree trunks in forest, fence or wall in city, boulders in
  hills and mountain, a water strip where either side is water (a bridge tile where an exit
  crosses it — the river the owner named, keeping people on the path). Blockers are solid tiles
  in the walkability map — the same solidity the void used to provide, now wearing art.
- **Portals stay portals:** exits the layout could never reconcile geometrically (`portal: true`,
  cross-zone links, cross-source roads) keep their current rendering. Seamlessness is for
  neighbours; a faerie ring is *supposed* to look like magic.
- **Interiors:** a building interior (`inside` sector, dungeons, the Anchor & Anvil) keeps the
  enclosed look — walls are already diegetic there. The open world is for outdoors. Where an
  outdoor room adjoins an indoor one, the building's exterior wall *is* the blocker, and its door
  is the seam.

## 4. The one real risk: seeing further than the server tells

Interest management sends the current room and its neighbours. Today the void means there is
nothing visible beyond that anyway. An open floor changes the question: a player on a hill with
the camera out could *see ground* two rooms away while receiving no entities for it — an empty
world at the horizon that is actually full.

Three dials exist and the plan is to reach for them in this order: **camera zoom bounds** (cheap,
ship first — the current zoom already roughly matches the update horizon), **the fog/light system**
(vision is already tile-granular with light radius and line of sight; distance can simply darken
honestly), and only if the first two chafe, **widening interest to radius two** for open zones —
a bandwidth decision to measure, not assume, and the one item here that touches the server at all.

## 5. The build order

Track V work throughout — presentation of things that already exist — sliced so every step is
visible and reversible, and Velen is deliberately the testbed: authored, six rooms, ours.

1. **V8a — the seam.** ✅ **Built 2026-08-09, the evening this document was written.** Velen Square rendered seamless: adjacent blocks fused, open borders where
   its exits are, the inn door as a gate in a wall line. Smallest possible proof; the square is
   all connected rooms, so no blockers are even needed yet.
2. **V8b — the law.** Blocker lines by sector pair, and **the validator**: flood-fill equals
   graph, asserted in tests over every open-rendered zone. This slice is what makes the pretty
   world still be the MUD's world.
3. **V8c — the wilderness.** ✅ **Built 2026-08-10, and measurement chose the zones rather than
   taste.** The choice needed a mechanism first: an authored zone declares `seamless` in its own
   file, but a harvested one cannot, because `data/world/zones/` is regenerated by every worldgen
   run — so the flag joined `zone-overrides.ts` beside the Tordraken rename, composed at boot, and
   is exactly the *"per-zone rendering choice, not a fork of the pipeline"* this row asked for.

   **The rule is: a zone may go seamless when it has no dark rooms.** `ROOM_GAP` is tuned against
   `DEFAULT_LIGHT_RADIUS` so the next room sits outside a starting radius and inside a torch's —
   that relationship is what makes finding a light an upgrade, and a one-tile seam puts the next
   room within reach of anything. Where there is no darkness there is nothing to protect. Six
   zones qualified — **the Stag Forest, the Stump Bog, Evermeet, Leuthilspar, the Valley of
   Graydawn and the Unseelie Court**, 851 rooms — and the rule *overruled this row's own guess*:
   the kobold settlement was named here as the first candidate and has 37 dark rooms, so it stays
   enclosed along with Ashrumite (33) and the Faerie Realm (48).

   Two things the trial caught before any of it shipped. The grids **shrink**: a seamless zone
   strides 10 tiles instead of 12, so every one of the six got smaller, and the 4096-pixel texture
   cap that `world.ts` once lost a day to is further away than it was. And the validator reported
   two Stump Bog rooms as wall-walk exploits, which turned out to be the *test* being wrong —
   see `seamless.test.ts` on why reachability here is undirected.
4. **V8d — the dressing.** **Scenery built 2026-08-10; the rest of this row is still open.**
   Sector transition tiles, scatter (the existing rock/tree decoration
   grows into copses and hedgerows), rivers with bridges, and the city's walls and house fronts —
   which is where this plan meets DESIGN-city.md: Velen's districts are drawn as streets between
   buildings rather than blocks beside blocks. **And plaza furniture** — owner, 2026-08-09, on
   first walking the open square: *"some scenery... a fountain or pothole or something like that,
   just for atmosphere."* The square's prose already promises the fountain and the plinth; drawing
   them makes the text true on screen, and the terrain-v7 pack's decoration sheets are the obvious
   source. Atmosphere props are per-room authored content (a `scenery` field on authored rooms,
   perhaps), so the fountain stands where its `read fountain` text says it does.

   **What was built.** The `scenery` field, and the *perhaps* resolved into a rule worth stating:
   **a prop is a thing in the way.** That one sentence decides everything else. Paint — the grass
   tufts, the cobble mix, the scattered rock — is chosen by a hash of the coordinate, lives in the
   client, and can never desync because it changes nothing. A prop occupies ground, so it is a rule,
   so the catalogue is in `shared` and both sides stamp the same footprint. It is also why a prop
   has no `solid` flag: everything in `scenery.ts` is solid, and decoration that is *not* in the way
   belongs in the client's variant tables instead. Protocol 31 carries it, on the `zone` message
   that already sends whole rooms.

   Two things fell out of building it that this row had not anticipated.

   **`Tile.Prop` had to be a second solid kind, because solidity and opacity are different
   questions.** `Blocker` is a wall: you neither cross it nor see past it. A fountain is something
   you walk around and look straight over, and a plaza casting walls of shadow from its own
   furniture would read worse than a bare one. One extra tile number buys the distinction, and the
   catalogue names which each prop is — the hay bale is the only one that chooses `Blocker`, being
   three tiles of straw and taller than the person looking at it.

   **`Blocker` was never in `isOpaqueTile`, and that was a live bug.** Its own docblock promised it
   was *"as solid and as sight-stopping as void"* and `tilemap.test.ts` said "still solid, still
   opaque", but nothing had ever asked the function — so every wall, hedge and tree line V8b stamped
   between rooms was see-through, banking rooms into `seen` through solid masonry. Found only
   because adding a deliberately *transparent* solid meant reading the opaque one first, and fixed
   in the same slice.

   The client learnt to y-sort while it was there. Every character sat at one flat `ENTITY_DEPTH`,
   which is invisible while nothing occludes anything and wrong the moment a two-tile fountain
   exists. `groundDepth` now sorts characters and props together on the standard three-quarter rule,
   **whatever is further south is nearer**. For a prop that is the southern edge of its *footprint* —
   the front of the thing, where it meets the floor — not the top of its picture, which would put a
   tall prop behind someone it should be hiding.

   Ten props stand in Velen: the fountain and the plinth the Great Crossing's prose promised, two
   statues in the Guildhall Court, a well outside the North Gate, handcarts in the Fish Market, on the
   Long Quay and at the Mouth of the Shambles, and hay bales on the two road rooms outside the
   walls. The check that none of them walls a room in half is not a new one — it is V8b's law, the
   flood-fill that must equal the room graph, and it passed.

   **One placement was wrong and the owner caught it on sight:** the well started on the Cross
   Street and was invisible there. Not a hue problem — the well is drawn in the *same cobblestone
   masonry* as a city street, so on cobbles its silhouette dissolves entirely. Checked all six props
   against that ground before reaching for a general fix, and the well is the only one affected; the
   rest carry darker outlines or brighter tones and read fine. So the fix is the placement, not a
   tint or a contact shadow: it now stands outside the North Gate on brown road dirt, where carters
   would water anyway. **A prop has to be legible against the sector it stands on**, and that is
   worth checking at authoring time rather than discovering in play.

   **Wilderness scatter built 2026-08-11.** V8c turned 851 rooms seamless and every one of them read
   as flat lawn: the graph gave them borders and the sector gave them a colour, and nothing gave them
   anything to stand behind. `scatterFor` fills them from the room id — four new props (stump, log,
   bush, toadstools) placed by a pure function of the id and the sector, so the server and every
   client agree without a byte on the wire. **571 props across the six seamless zones**, 251 rooms
   dressed and a quarter left as clearings so the result does not read as a pattern.

   Solid, like every other prop, which is the whole reason it lives in `shared`: a bush you walk
   through is paint pretending to be terrain. The safety property is **geometry rather than trust** —
   scatter may only stand in the four 4x4 quadrants, so row 4 and column 4 of every room stay clear
   and a plus-shaped path always crosses edge to edge. No roll of the hash can seal an exit. The
   flood-fill validator confirms it over all six zones, but it could not fail in the first place.

   `sceneryOf` is now the one accessor both sides read: authored scenery if a room has any, otherwise
   what grew there. **A room that was authored keeps exactly what it was given** — mixing the two
   would put hand-placed props in competition for tiles with generated ones.

   Two fixtures had to change, and the reason is worth keeping: `tilemap.test.ts` and
   `pathfind.test.ts` both defaulted their synthetic rooms to `sector: 'forest'`, which had been an
   arbitrary choice and suddenly meant something. Both now use `inside`, because a test about block
   geometry should not be growing bushes into its own assertions.

   **Still open in this row:** sector transition tiles, rivers and bridges, and the city drawn as
   streets between buildings.

## 5a. Portals are for magic and distance — seams are for steps

**Owner's ruling, 2026-08-10:** *"portals should only be used to traverse large distances or for
magic reasons — enter the underworld or upper planes or a mage's secret chamber."*

That sorts every crossing in the game into two kinds, and the sorting is the design.

A **portal** is an event. It goes somewhere far or somewhere impossible, it is allowed to announce
itself with a violet ring, and stepping through it should feel like a thing you did: the faerie
ring, the smugglers' crawl from the Underquay to the kobolds' pit, whatever the Mages' Tower is
hiding.

A **seam** is a step. A road runs out of one zone and into the trees of the next; a bridge carries
you over a brook and the far bank happens to belong to somebody else's map. `RoomExit.seam` marks
those, and three things follow: the client draws no marker and offers no click, the server carries
you across when you press against the last tile of the room, and the return half inherits the flag
so the boundary does not announce itself in one direction only. Underneath it is still
`portal: true` — no corridor can be carved between two coordinate frames — it simply stops saying so.

**Dress both sides.** The owner's own framing: *"we create rooms that are the same in the zones so
it doesn't actually visually change anything… standing on a bridge that if I go east I am in the
woods, if I go west I am back on the road to Velen."* A seam is only invisible if what you see after
the step continues what you saw before, so a crossing wants a bridge, a gate, a ford or a gap in a
treeline written on both sides of it. **Filler rooms are welcome** where the fiction needs room to
breathe — owner, same conversation: *"if we have to add filler roads or paths to make it work that
is fine also, a little stroll has never hurt anyone. Unless we put bandits on the roads of course."*

**Applied to the whole world 2026-08-10**, and the default is the ruling read literally: worldgen
marks **every horizontal portal a seam**, cross-zone and in-zone alike, because neither is distance
and neither is magic. Magic is the exception and has to be *authored* — which is the right way
round, since the harvest cannot tell a teleporter from a track, and everything we actually know to
be magic (the faerie ring in `links.json`, the smugglers' crawl under Velen) is authored anyway.
**5,328 of 6,453 portals** stopped announcing themselves; in the loaded world the count of visible
rings fell from **109 to 21**.

The 21 are all honest. Eight are staircases. Eleven are `up`/`down` exits the mapper drew between
rooms at the *same* height — clambering onto a stump, onto a hilltop — and a marker that says
*there is a way up here* is worth keeping, which is also why the seam rule excludes the vertical:
a seam is walked into by pressing against a room's edge, and `up` has no edge to press. The last
two point at zones the config does not load, and are a ring to nowhere worth cleaning up later.

**What a seam does not fix: the camera.** The far side is a different grid, so the view still cuts
even where the fiction does not — twinned dressing hides it well and does not remove it. That is
§5b's slice, and the two are complementary: seams make crossings *read* right now, and one plane
makes them *look* right later.

## 5b. The world is one plane after all — measured 2026-08-10

**This section corrects a belief the project has held since Phase 1, and it is the most useful
thing V8b and V8c turned up.**

The belief, stated in `placegraph.ts`, `HANDOFF.md`, `DESIGN-city.md` and this document's own §3:
*"worldgen normalises coordinates per zone and per level, so no two Places share a coordinate space
and 0 of 991 cross-zone exits is a geometric neighbour. There is no plane to draw the world on."*

Every clause of that is true **of the emitted data**, and the last one does not follow. The owner
asked, walking east out of Velen, *"is there still supposed to be a portal?"* — and the honest way
to answer it was to go back past the emitted world to the mapper's database.

`zmud.ts` computes `minX`/`minY`/`minZ` **inside a per-zone loop** and subtracts them, so each zone
is normalised to its own origin. That is what destroys cross-zone adjacency. The raw `ObjectTbl`
coordinates are **global** — one canvas for the whole map — and read that way, at the same detected
pitch of 240:

| | geometric neighbours |
| --- | --- |
| within a zone, one global frame | **111,765 of 116,699** (95.8%) |
| across zones, one global frame | **547 of 1,006** (54%) |
| across zones, as currently emitted | **0 of 991** |

Among the zones the server actually loads it is **17 of 19** horizontal cross-zone exits — including
every one of the thirteen between the Stag Forest and the Stump Bog, the kobold settlement's border
with Evermeet, and the Faerie Realm's with Leuthilspar and the Unseelie Court. Those are not
portals because the world lacks a plane. They are portals because we threw the plane away.

### What this does and does not mean

It does **not** mean one grid for the world: a global grid would be enormous, and zones load and
unload independently on purpose. It means the *offsets are knowable*, which is the missing piece
under everything in §5 — a grid may span several zones once each zone knows where it sits relative
to its neighbours.

The remaining 46% are genuinely not neighbours, and the misses scatter across 357 distinct offsets
rather than clustering, so there is no single correction that rescues them. Those stay portals and
should: the mapper drew some areas on separate canvases, and a faerie ring is *supposed* to look
like magic.

### The slice this implies

**V8e — the world on one plane.** worldgen records each zone's global origin in its zone file
(it already computes the per-zone minimum; this is the number it currently discards). `GameWorld`
gains the ability to build one grid from several zones by placing each at its own offset, which is
the same merge Velen's districts got by hand in the V8b work — generalised, and driven by data
rather than by an author choosing coordinates. Then a border between two adjacent harvested zones
is a seam like any other, and the 17 of 19 stop being transitions.

Not attempted in V8c: `Place` is `(zone, level)` in about a hundred places, and the change wants
its own slice with its own tests rather than riding on a rendering change.

## 6. Open questions for the owner

1. **How far does open go?** Proposal above: outdoors open, interiors and dungeons enclosed. Is
   that the instinct, or should even caves breathe?
2. **The camera.** How far out may a player zoom? The answer sets how urgent §4's third dial is.
3. **The minimap** (`M`) currently draws the room grid — in an open world it could stay
   diagrammatic (the nostalgia surface, the MUD's own map) or go terrain. Keeping it diagrammatic
   is free and honestly charming; a terrain minimap is real work.
4. **Order against Act VII.** Phase 23 (the square's noticeboard, shops, inn) and V8a (the square
   goes seamless) both want Velen next. Either order works; doing V8a first means Phase 23's
   content lands on the world's new face and is only walked once.
