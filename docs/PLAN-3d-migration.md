# MyGame: 3D Client Migration Plan

*Prepared from the engine survey, the codebase audit, and four adversarial reviews. Every number below marked "measured" was re-derived directly from `D:\MyGame\data\world\zones\*.json` and the source files while writing this document; where reviewers disagreed, I re-ran the measurement myself and say which answer is right.*

---

## Amendments

*The plan below is kept as written. What follows corrects it against the tree it now describes.*

**2026-08-12, at the close of M1.** **M0 and M1 are delivered** (commits `7069ef3`, `9eab6b8`), both by delegated agents, both verified
independently against the full suite. M0: sparse 16x16 chunk storage — zone 317 fell from 521 MB
dense to 214 KB (x2,553) — plus the sector-0-void fix, stair metadata kept with `exit.to`, outdoor
rooms merging along their whole shared edge, and `space.ts` (in `shared`, not the §3 client
placement: the client has no test runner, and an axis map is a determinism contract). M1's headline
was that **§6-M1's own narrative was stale**: the baseline already held a suffix tier, graph
diffusion and a Duris sector harvest, and the world was at 0.2% defaulted before a line changed. The
real repairs were the rule order (landscape now outranks road/city — 4,427 rooms, 9.5% of the world,
changed sector) and an empirically-validated diffusion seed policy (zone-name guesses scored 48% on
held-out harvest truth; the graph vote scores 65–69%, so zone-tier rooms are now correctable).

**§2's figures re-measured.** `scene.ts` is **5,339 lines**, not 539 — the file grew 10x under two
weeks of V-track work after this plan was written. The salvage list survives unchanged and its
anchors are: `SNAP_DISTANCE` :213, `wireNetwork` :2112–2297 (~186 lines of message handlers now, up
from ~51), the input→`steer` mapping :4444, the prediction/reconciliation block :4444–4530, and
`hashTile` :5286. `net.ts` is 91 lines (was 84) and still carries over verbatim. `log.ts` is **241
lines** (was 55) — it grew the channel system and is *more* worth keeping, exactly as §2 predicted.
The ~85% figure still holds in spirit; the absolute discard is simply far larger.

**The write-off shrank in kind, not just in count.** Work landed since the plan deliberately put its
decisions in `shared`, where no pixel lives: `creatureSheets`/`mobpick` (a creature's look chosen
from its name — exactly what selects a 3D model), `scenery.ts` + `scatterFor` (what stands in a
room, that it is solid, deterministic placement), the seam ruling (`RoomExit.seam`), and M0's
`space.ts`. Only the sheet-staging halves are LPC-specific. The §5 art section's write-off maths is
unchanged; the *mechanics* write-off is near zero.

**One §4 correction for M2:** the edge-classification table predates seams. 5,328 of the world's
portals now carry `seam: true` — fiction-wise ordinary crossings whose entire point is not
announcing themselves — so a seam edge must NOT classify as `portal` (the emissive ring would
re-grow everything the seam work removed). The M2 implementation records the decision it takes.

**2026-08-13, M5 under way — the art direction is confirmed, and the M7 armature risk is dead.**
The owner confirmed §5's direction eyes-on — *"lets work with that and build my game in a world
that looks like that"* — so the Quaternius look is a ruling now, not a proposal. All five §5 packs
are on disk under `assets/quaternius/` (CC0, provenance noted), with three Standard-tier
corrections to §5's listing figures, measured on disk: the Nature MegaKit's textured GLTF line is
**68 models**, not 116 (the larger number counts other tiers and formats); *Animation Library 2*
is **43 clips**, not 130+, and has **no plain walk, run or death** — closed the same hour by
adding **UAL1 [Standard]** (15.9 MB: `Walk_Loop`, `Jog_Fwd_Loop`, `Sprint_Loop`, `Death01`,
`Hit_Chest`/`Hit_Head`, and a `Spell_Simple_*` casting set), the two libraries together covering
M7's whole idle/walk/run/attack/hit/die machine; and *Ultimate Monsters* is **not on itch**
("invalid game" — likely Patreon-only), so monster models stay an open M7 question. **§6-M7's
"test in Blender before M5" armature risk is retired without Blender**: GLTF is JSON, so the
skeletons were diffed headlessly — every rigged file in all four packs (both base bodies, all 24
outfit parts, all five animation files) binds within the **same 65 joints by name**; zero
violations; no retargeting project hides inside M7. M5 runs as three slices: **M5a** (ez-tree
bake, foliage shader, scatter, ground blend — delegated, in flight), **M5b** (kit import, water,
wetness, and a daylight recipe — M4 tuned only the night, and the kit's own look is sunlit),
**M5c** (the domain warp, ROADMAP 2026-08-13). M5b goes before M5c on the owner's confirmation:
the warp displaces kit instances exactly as it displaces grey boxes, so bending the roads loses
nothing by coming after the world gets its clothes.

---

## 1. Direct answer

**Yes — with Three.js (r185, MIT), on the Vite build you already have.** You can get the reference image's register: the steep 60–70° perspective camera, blue-teal night ambient, a lit clearing walled by conifers, rain streaks, soft moon shadows, an emissive portal ring, and a small character seen from above. Realistically you land at **80–90% of that frame for outdoor forest rooms**, and the shortfall will be in the *softness* of the foliage — the reference's painterly leaf masses are hand-painted texture work that no free asset pack ships and that I cannot promise you will reproduce from shader tricks alone. That is the one genuinely uncertain item in this plan and I flag it again in §7. Everything else in that screenshot — the lighting, the fog, the rain, the shadows, the portal glow, the tone grade — is renderer configuration you will get right in a few weeks, not art you have to buy. The much bigger honest caveat is not about the forest at all: **forest is 8.6% of your world** (measured). `inside` 15.2%, `cave` 10.6% and `city` 9.9% together are 35.7%, and those rooms need a *second* rendering mode (roofs, roof culling, interior lights, no sky, no weather), not a colour-palette variant. This plan schedules that early rather than pretending it's a table row.

---

## 2. What it costs you

### Preserved, untouched
| Path | Why it survives |
|---|---|
| `D:\MyGame\packages\shared\src\rules.ts` | Pure SRD maths + seeded RNG. Zero coordinates. |
| `D:\MyGame\packages\shared\src\world.ts` | Room graph, cell coords, sectors, `DIRECTION_DELTA`. Zero 2D. |
| `D:\MyGame\packages\server\src\players.ts`, `world.ts` | Persistence and zone loading. Draw nothing. |
| `D:\MyGame\packages\worldgen\src\zmud.ts`, `index.ts` | Offline pipeline. Output is a room graph, not pixels. |
| `D:\MyGame\packages\client\src\net.ts` (84 lines) | Zero Phaser imports, no state. Carries over verbatim. |
| `D:\MyGame\packages\client\src\log.ts` (55 lines) | Plain DOM. Becomes *more* valuable in 3D — combat rolls and room prose are unreadable as floating 3D text. |
| `D:\MyGame\packages\client\vite.config.ts`, `tsconfig.json` | Vite is right for Three.js too. Port 5273 stays. |
| `D:\MyGame\packages\shared\src\rules.test.ts` | Stays green through the whole port. Your regression net. |

### Modified, small
- `D:\MyGame\packages\shared\src\tilemap.ts` — the central rewrite (§4). `stepMovement`, `canStand`, `isWalkableAt`, `normaliseIntent`, `PLAYER_SPEED`, `PLAYER_RADIUS` survive **verbatim**, because they only ever touch the grid through `tileAt`. The one-implementation-both-sides prediction guarantee is preserved by construction.
- `D:\MyGame\packages\server\src\sim.ts` — ~15–25 lines. `TILE_SIZE` at lines 106–107/161–162 is pure unit scale; reinterpreting "32 px" as "32 world units" is a rename. `sprite: 'player'` (line 188) and the 4-cardinal `facingOf` (line 216) are cosmetic.
- `D:\MyGame\packages\shared\src\protocol.ts` — three fields (§ milestone M7). Cheap now, expensive later.
- `D:\MyGame\packages\worldgen\src\terrain.ts` — gets a real repair pass (§ milestone M1). This file stops being a cosmetic detail and becomes the thing that decides what your world looks like.
- `D:\MyGame\CLAUDE.md` — the "**Art:** LPC only" rule becomes actively misleading and must be rewritten in the same commit that deletes the tiles.

### Thrown away
- **`D:\MyGame\packages\client\src\scene.ts` — 539 lines, ~85% dies.** Lift four things out *before* deleting: `wireNetwork()` (174–225), the prediction/reconciliation block with `SNAP_DISTANCE` (422–463, the 0.12 self-ease and 0.22 remote lerp are exactly as valid in 3D), the input→intent→`net.send('steer')` mapping (426–434), and `hashTile()` (521–526) — that deterministic positional hash is precisely what places scatter geometry identically for every player, and it gets promoted to `@mygame/shared` as a determinism contract.
- **All ten tile sheets in `D:\MyGame\packages\client\public\tiles\`.** Measured: 96×192 px = a 3×6 grid of 32×32 frames (`rock.png` 64×32, `treetop.png` 192×224, `trunk.png` 192×96). These are albedo-only sprites with lighting *baked in* at a fixed light direction. They will fight every dynamic light in the target — the emissive portal, the moon shadows, the lit clearing. No normal or roughness map is derivable from 32 px art. `treetop.png` + `trunk.png` is the LPC convention for *faking* a tree by stacking two sprites; nothing there converts to a conifer that shows its sides.
- **`D:\MyGame\assets\lpc-opengameart` — 183 MB, referenced by zero code** (grep confirms only `public/tiles` is ever loaded, via `scene.ts:141`). Characters are 4-direction 64 px sheets. A free 3D camera has infinitely many view angles; a 4-direction sheet cannot serve one.

**Be clear-eyed: the LPC investment is a write-off.** Not partially — entirely. The tiles, the 3×6 transition templates, the tinting logic, the 183 MB character set. The only thing that survives is the *idea* of layered visible equipment, which has a direct 3D analogue (attachment slots on a rigged mesh) and which you should keep as a hard requirement.

Two consolations, both real. First, the licence direction is in your favour: LPC is CC-BY-SA 3.0 / GPL 3.0, both share-alike, meaning derived artwork you ship must be released under compatible terms. The CC0 3D sets carry no attribution and no share-alike at all. Second, **read `D:\MyGame\packages\client\public\tiles\ATTRIBUTION.md` before you delete it** — its "files used" table maps each sheet to the sectors it dressed, and it's the best existing record of your sector→biome intent. Keep the `LICENSE`/`AUTHORS` files as long as any LPC file remains in-repo, then remove them in the same commit as the last PNG.

---

## 3. Engine

**Three.js r185 (`three@0.185.1`, MIT) + `@types/three@0.185.1`, WebGL2 only, no WebGPU path.** Supporting stack, all permissive: `postprocessing@6.39.4` (pmndrs, Zlib) for the effect chain — **pick this one and do not also use `UnrealBloomPass` from `three/examples`; they are two different composer stacks and do not compose**; `three-mesh-bvh` (MIT) for click-to-move raycasts; `troika-three-text` for nameplates and damage numbers; `@gltf-transform/cli` (MIT) and `@dgreenheck/ez-tree` (MIT) run offline in `packages/worldgen`.

| | Three.js | Babylon.js 9 | Godot 4.7 |
|---|---|---|---|
| Preserves `stepMovement()` as one shared implementation | Yes — TypeScript both sides | Yes | **No.** C# still cannot export to web in 2026, so web forces GDScript. Permanent bilingual port of the one routine your prediction model depends on. `Vector2` is float32 vs JS float64 → silent desync as intermittent rubber-banding. |
| Bundle | ~155 KB gz (three) / ~280–350 KB gz with the stack above | ~300–400 KB gz tree-shaken, and only if deep-path + side-effect import discipline holds — failure mode is a *runtime* error, not a compile error | ~5 MB Brotli engine wasm; real 3D web games 30–100 MB total |
| Prior art for **stylised painterly** foliage/wind/weather | Overwhelming. This is ~70% of your actual work. | Thin. You will port, not copy. | N/A on web tier |
| Shader authoring reviewable in git | `onBeforeCompile` patches, plain TS | NodeMaterial serialises to undiffable JSON blobs | GDScript shaders, fine |
| Night/rain feature kit on the target platform | HemisphereLight + ACES/AgX + FogExp2 + PCFSoft + bloom, all WebGL2 | Same plus CSM, GPU particles, WaterMaterial first-party | **Web export is Compatibility/WebGL2 with an RGBA8 LDR buffer.** No volumetric fog, no PCSS, no decals, no SSR — exactly the rainy-night kit. Desktop Forward+ is genuinely better than both, but then you ship a desktop client. |
| Editor / tooling | None. You write input, streaming, animation state machines yourself. | Inspector v2, GUI editor, Babylon Editor | Best of the three |

Two Babylon arguments that sound decisive and are not, for *this* codebase: **Large World Rendering / floating origin** solves a problem you don't have — interest management is already room-scoped, the client holds one zone, and measured, only **991 of 118,170 exits (0.84%) point outside their own zone**, so the client never spans two coordinate origins. **Clustered Lighting** solves a problem you can avoid — a fixed startup pool of 8 point lights that are *re-parented and re-coloured, never created or destroyed*, is the correct design on forward WebGL anyway, because three recompiles a shader permutation per light count and a mid-frame compile is a visible hitch.

Costs you're accepting knowingly: `@types/three` is DefinitelyTyped, not first-party, and lags releases by days-to-weeks; `postprocessing` peers `three >=0.168.0 <0.186.0`, which is one minor version of headroom from your pin and *will* periodically brake upgrades; three ships breaking changes roughly every two months; nothing tree-shakes meaningfully.

### The coordinate adapter — write this first, in one file, with a test

New `packages/client/src/space.ts`, ~40 lines. This is the single most likely source of a plausible-looking mirrored world — the same class of bug as the three-direction-encoding trap already in your CLAUDE.md.

```
WORLD_SCALE = 1/32           // renderer metres = simulation pixels / 32
three.x =  sim.x / 32        // east  → +X, screen-right
three.z =  sim.y / 32        // south → +Z, screen-down.  NOT negated.
three.y =  elevation(room)   // up
camera: PerspectiveCamera, fov 30°, pitch 64°, pulled back along +Z, up = (0,1,0)
```

`shared/src/world.ts:28` fixes y growing south for screen-space agreement; that survives untouched. A room becomes 9 m across, the stride 11 m, `PLAYER_RADIUS` 0.31 m, `PLAYER_SPEED` 4.69 m/s (a fast run — a tuning dial, not an architecture problem). **Test: walking north must move −Z.** Pitch must stay strictly under 90° or the up vector degenerates.

Perspective, not orthographic. Rain streaks under ortho become identical parallel lines with no depth spread, trees don't lean outward at frame edges, and post-processing support for ortho is patchier. That parallax is most of what reads as "modern indie 3D".

---

## 4. How the room graph becomes 3D scenes

This is the heart of it, and the port is the easy half. What you are actually building is a **procedural scene generator**. Three layers, and only the third touches the GPU.

### Layer A — sparse collision (`shared/src/tilemap.ts`, rewritten)

`buildZoneTilemap` currently allocates densely over the zone's *bounding box*, not its occupancy. Measured: zone 317 "The Roads of the Heartland" is 358 rooms in a 569×751 cell box and asks for ~352 MB of typed arrays; **50 of 327 zones exceed 16,384 px on an axis**, past typical WebGL max texture, so `scene.ts:249`'s whole-zone RenderTexture physically cannot build them. The current client only works because `ZONE_ID` defaults to 390 (`server/src/index.ts:43`), a 49-room zone.

Replace with chunks keyed by stride cell `(cx, cy) = (tx div 12, ty div 12)`, each a 12×12 `Uint8Array` (144 bytes), allocated lazily. `setTile(tx,ty,kind)` resolves any absolute tile to its owning cell and creates it on demand, which handles corridors carved into a neighbour's cell. `tileAt()` becomes a Map lookup plus an offset — so `stepMovement`, `canStand`, `isWalkableAt`, `normaliseIntent` are unchanged source. `roomAtTile` becomes a direct cell→room lookup and stops needing an `Int32Array` per tile.

Fix two latent bugs while you're in there. `sectors` is zero-filled and never written for void cells, so every void cell reads back as sector 0 = `'inside'` (`SECTOR_INDEX`, line 80) — harmless while void is skipped, fatal the moment anything dresses the gaps, which is the entire point of Layer B. And the stair encoding (lines 150–154) stamps the room's *centre* tile, overwriting `Tile.Floor`, collides up-with-down in one cell, and discards `exit.to`.

**And one deliberate change to the carve rules — this is the fix for the biggest visual criticism of this whole approach.** Right now `CONNECTOR_WIDTH = 3` for every link, so at 1 tile = 1 m your world is a lattice of 9 m squares joined by 3 m necks, repeating on a hard 12 m beat. Your camera sees roughly 2–3 rooms wide, so two to four of those beats are on screen at all times, and the reference image contains no regular structure anywhere. Dressing the gaps does not fix this; it decorates it.

Make `CONNECTOR_WIDTH` **sector-dependent**: when two linked rooms are both outdoor (`field`/`forest`/`road`/`hills`/`swamp`/`desert`), carve the *full 9-tile edge*, so adjacent outdoor rooms merge into one contiguous walkable field. Interiors, caves and city keep 3 m doorways, where a corridor is correct and wanted. This is a *collision* change, so it stays authoritative and both sides still run one routine — the server is entirely happy with it. Then the tree line simply follows the outer boundary of the merged walkable region, jittered ±1.5 m by the room seed, and the lattice disappears for the biomes that need it to.

Flag it as the design decision it is: outdoor room-to-room movement loses its pinch point. I think that's correct for the target look and harmless for MUD-style room semantics (the room is still the unit of interest management and prose), but it is your call and it should be made consciously at M0, not discovered at M5.

### Layer B — the scene IR (`shared/src/roomScene.ts`, new)

`describeRoom(zone, room, neighbours, seed): RoomScene`. **Pure, deterministic, no I/O, no `three` import.** It runs in `worldgen` for offline baking, in the client at runtime, and in plain Node tests with no GPU. This is the single decision that makes 46,500 procedurally dressed rooms tractable — every reviewer independently picked it as the best idea in the field, and it survives being wrong about the engine, the art or the look.

It emits, per room:

**1. Biome** — from the repaired sector (§M1), plus a per-zone theme so two forest zones aren't identical, plus blend weights toward each linked neighbour's biome. Measured: **40.7% of rooms have at least one cardinal neighbour with a different sector**, and 98 distinct sector-pairs actually occur in the world with 61 of them fewer than 50 times each. That rules out hand-authored transition sets absolutely. Instead the ground material blends two biome layers by *vertex weight* across the boundary — one shader handles all 98 pairs.

**2. Ground surface** — not per room. Run connected components over (linked ∧ same-z ∧ both-outdoor) and build ground per *component region*, subdivided at ~0.5 m, displaced ±0.15 m by low-frequency value noise keyed on **world position** so neighbouring chunks agree at their seams without communicating. Flat indoors.

**3. Boundary edges — four per room, and this is the highest-value derivation in the whole design.** In 2D the void means "don't draw". In 3D **the void is the scene**: the pines, the shrubs, the water and the shoreline all live in the gap. I classified all 186,032 edges in the world:

| Class | Count | % | What it becomes |
|---|---|---|---|
| `open` | 98,263 | 52.8% | Ground continues through. No geometry. |
| `edge` (no neighbour cell exists at all) | 59,977 | 32.2% | Dressed by biome: forest→tree wall, cave→rock, city→facade, water→shoreline. **One rule, a third of all edges** — this is what sells the reference's dense treeline. |
| `barrier` (neighbour room exists, no exit links them) | 17,023 | 9.2% | **Correctness requirement, not aesthetics.** Must be visually solid and thicker than an `edge`, because the player can otherwise see into a room they cannot reach. |
| `portal` | 5,934 | 3.2% | The glowing emissive ring from your reference image. **It is already in your data.** 7,261 portal exits exist and currently render as nothing. |
| `door` | 4,835 | 2.6% | Real door geometry with open/closed state. |

This classification is safe because measured, **all same-level non-portal exits land on exact grid neighbours with zero mismatches** — so "no exit in this direction" unambiguously means "there is a boundary here".

**4. Enclosure class** — count of solid sides. This selects the *lighting recipe*, not just the kit: 0 solid → hemisphere + moon shadows; 3–4 solid → interior probe, no sky contribution, no weather. Getting this into the IR at M2 is what stops interiors being a retrofit.

**5. Elevation — and this is where a naive design breaks.** Do **not** use `pos.z * LEVEL_HEIGHT` as terrain height. Measured: **13.0% of occupied columns hold rooms at more than one z, and the deepest stack is 21 rooms on a single (x,y)** (The Comarian Mines). At a 64° camera that is either a floating layer cake or interpenetrating geometry. The policy is:
   - Outdoor rooms take a *continuous* terrain height from the noise field plus a per-component base offset. Z-levels outdoors mean "a different part of the hill", not "a slab 4 m up".
   - Where a stack is genuinely interior/cave, levels get real vertical separation *with a floor slab and ceiling between them*.
   - The camera renders the player's level plus one below (faded, for the cliff/shaft read) and **hard-culls everything above**. This is a per-level visibility toggle, decided at M3, before shadows and lighting are tuned at M4 — not at M8.

**6. Openings, features, seed** — corridor mouth position and kind; the 9,138 vertical exits become real ramps or stairwells keeping `exit.to`; an optional landmark slot (well, shrine, campfire, statue, ruin) chosen by hash and weighted by biome, which is the cheapest single defence against 46,500 rooms feeling identical; and `seed = hashCell(x,y,z)` — the lifted `hashTile()` — so every client places the same tree in the same spot with zero server traffic.

### Layer C — chunk builder and streaming (client)

**Streaming must be spatial, not graph-BFS.** Several designs propose BFS over the room graph on the grounds that "you never load a room across a barrier the player can't see through". That is a 2D fog-of-war assumption and the 64° camera invalidates it — you see *over* barriers. I measured it: sampling 6,797 rooms across all 327 zones against a 5×3-stride-cell camera footprint, the footprint contains **8.2 rooms on average**, of which **15.0% are not reachable within 3 graph hops** — those render as visible holes where a room should be. Meanwhile **43.4% of what BFS-3 loads is outside the footprint entirely** — pure waste. So: load geometry by **spatial radius** (a 5×3 cell rectangle plus one ring of margin), and keep the room graph for gameplay interest management, where it is correct and already works.

That also settles a related worry. One review argued the world is so sparse that most rooms are lone dioramas in kilometres of fog, based on occupancy over the *zone* bounding box (which is misleading, because different z-levels occupy disjoint regions of one big box). I re-measured locally: **the mean 5×5 neighbourhood around a room has 12.6 of 25 cells occupied, median 12; the 3×3 has 5.6 of 9.** Your world is roughly half-dense at the scale the camera actually sees. The frame will be full. Sparse zones exist and fog handles them, but they are the tail, not the norm.

**Memory is the thing that will actually kill this if you get it wrong.** Geometries and materials are pooled per `(biome, archetype)` and **never** created per room or per zone — bound the pool key set explicitly and assert its size in a test. Only per-chunk `InstancedMesh` wrappers and their instance attribute buffers are allocated, and unloading returns those to a free list. One `InstancedMesh` per `(chunk, prototype)`, deliberately per chunk and not one world-spanning batch, or frustum culling never fires. This inverts the usual Three.js streaming failure mode: instead of thousands of `dispose()` calls to get right, there is a small fixed pool created once. Warm every archetype with `renderer.compileAsync()` at load and hold the light count stable thereafter, so nothing compiles mid-frame.

### Verification — exhaustive, not sampled

Because Layer B is pure and GPU-free, do **not** use snapshot tests over a fixed room sample; they rot on the first density tweak and say nothing about the other 46,000 rooms. Assert invariants over **all 46,508 rooms** — my analysis scripts above swept the whole world in seconds, so this is cheap:
- every `barrier` edge produces solid geometry;
- no scatter prop intersects a walkable tile;
- forward and reverse iteration of a room's scatter produce byte-identical positions;
- no room's ground surface is more than X metres from its neighbours' at a shared seam;
- `describeRoom` is pure in the 1-neighbourhood — note this explicitly, because blend weights and edge density ramps read neighbours, so editing one room's sector silently changes up to four neighbours' geometry. Your later per-zone override layer must account for that.

---

## 5. Art

**All-CC0, single-vendor-dominant.** Mixing stylised 3D vendors reads as two different games; one must dominate and the others fill named gaps only.

**Primary — Quaternius** (CC0: no attribution, no share-alike, commercial use and modification permitted; paid Patreon/Source tiers carry the same terms — payment buys access, not a licence). Use **only the post-2022 textured line**; the pre-2022 packs are untextured flat-shaded vertex colour and mixing eras inside one vendor looks as wrong as mixing vendors.
- *Stylized Nature MegaKit* — 116 models (40 trees, 35 plants, 27 rocks, grass, bushes). Field/forest/hills.
- *Medieval Village MegaKit* — 304 grid-snapping modular walls, roofs, stairs, doors, windows, with both exterior and interior faces. Covers `inside` + `city` = 25.1% of rooms.
- *Universal Base Characters* + *Modular Character Outfits – Fantasy* (62 swappable parts across 12 outfits, humanoid retarget rig) — the direct 3D analogue of LPC layered equipment.
- *Universal Animation Library 2* — 130+ animations, melee combos split into hits and recoveries, which suits a 3 s combat round.
- *Ultimate Monsters* — 50 animated creatures.

**Gap 1 — conifers.** No free pack advertises pine species, and pine is the defining silhouette of your reference. Close it with **EZ-Tree** (`@dgreenheck/ez-tree`, MIT) — a Three.js-native procedural tree generator with pine and aspen presets, GLB export and `generateLODs()`. Run it **offline in `packages/worldgen`** to bake ~6 variants × 3 LODs per biome theme into `data/models`. Trees become build artefacts, which is the only answer that scales to 46,500 rooms, and because the generator is the same library as the renderer, your material patches carry over. Note the tension honestly: this is a third foliage source in a plan whose own rule is "don't mix vendors" — mitigate by restyling EZ-Tree output to the Quaternius palette and texel density at bake time, and by checking silhouettes on a contact sheet.

**Gap 2 — soft painterly foliage. This is shader work, not a purchase, and it is the least certain part of this plan.** The spec: conifer canopies as ~14 intersecting alpha-clipped cards (`alphaTest ~0.4` with `AlphaToCoverage` + MSAA — clip, not blend, so they shadow-map and sort correctly), `MeshStandardMaterial` patched via `onBeforeCompile` with wind sway in the vertex shader keyed on an instance-position hash, a two-sided translucency term so the moon rims the canopy, and normals bent toward the canopy volume so 14 flat cards light as one soft mass rather than 14 planes. Two traps that will cost you a day each if unwarned: **the wind displacement must be duplicated into `customDepthMaterial` or shadows visibly detach from the animated foliage**, and the "bend normals toward the sphere centre" recipe is the *broadleaf* one — a conifer is a cone of tiered drooping branches, and spherical normals will flatten it into a lit blob and destroy the silhouette that makes it read as pine. Budget iteration here.

**Two things the reference has that no proposal costed properly:** *wetness* — a roughness drop alone renders as "slightly darker", not "wet". You need a streaked specular response and instanced puddle decals with the portal reflected as a cheap approximation, or the rain will read as animated fog over dry ground within one second. And *water* — the top-left lake with a shoreline transition is a real water surface with depth fade and a foam line, not a blue plane and not a vertex blend of two ground materials. Budget both as explicit work in M5.

**Tone mapping: do not reflexively reach for `ACESFilmicToneMapping`.** ACES desaturates and hue-shifts exactly the saturated blue-teal your reference lives on. Try `AgXToneMapping` or `NeutralToneMapping` plus a grading LUT and compare against the reference before committing. This is a five-minute experiment with a large effect.

**Secondary, gaps only.** KayKit Forest Nature Pack (CC0, ~1,588 models on a single 1024² gradient atlas — a real instancing win, but adopting it wholesale locks your palette, and KayKit's stubby big-headed characters are visually incompatible with Quaternius's near-realistic proportions). Kenney 3D kits (CC0) for greybox in M3–M4 only. Kenney Particle Pack for rain and portal sprites. Poly Haven (CC0) for one moonlit night HDRI as low-intensity environment lighting — not for reflections, its photoreal materials won't sit next to toon foliage.

**Explicitly avoid.** *Mixamo* — free commercial use but its terms forbid distributing raw character/animation files, and a browser client serves GLBs any user can pull from the network tab; Adobe also calls it a "limited duration technology preview" and it is effectively unmaintained. Prototype with it, ship the CC0 libraries. *Fab / Quixel Megascans* — Fab Standard License, not CC0, redistribution-restricted, mostly paid since 2024, photoreal. *Sketchfab* — being wound into Fab; the Store closed Oct 2024 and CC-BY-SA models were declared ineligible for migration. Mirror anything you take; never build a pipeline dependency on it.

**Is one coherent style achievable? Yes, but only with a process.** Quaternius post-2022 dominates; EZ-Tree output is restyled to match at bake time; everything else fills a named gap. Generate a rendered contact sheet of every prop in the build, regenerate it on every asset change, and look at it. With 46,500 procedurally dressed rooms, style drift is the slow failure mode that turns a world into asset-flip patchwork zone by zone.

**Delivery:** `@gltf-transform/cli` for Draco + KTX2/Basis + meshopt + quantisation, in a worldgen step. Serve from `packages/client/public/models/` with stable runtime-fetched URLs, **not** Vite bundler imports — `.glb`/`.ktx2` aren't in Vite's default asset list and the streamer wants stable paths anyway.

---

## 6. Milestones

Effort figures are **focused developer-weeks** at roughly 20–25 hours each, with AI assistance, for someone who is not a 3D specialist. Ranges are wide where I mean them to be. **AI assistance helps most in M0–M3 (deterministic, test-driven, headless) and least in M5–M8 (visual convergence, where the feedback signal is "it looks wrong" and every loop costs a human look). Plan your energy accordingly.**

### M0 — Sparse collision + the space adapter. No 3D, no new dependency. *(2–3 weeks)*
Rewrite `tilemap.ts` into per-stride-cell sparse chunks. Fix the sector-0-void bug and the stair encoding. Add sector-dependent `CONNECTOR_WIDTH`. Write `space.ts` with the axis map and its test.
**Visible/testable:** the 10 existing tilemap tests re-expressed against the sparse structure, all 22 tests green, plus a new case building zone 317 (358 rooms in 569×751 cells) **under an explicit memory ceiling** — measured, ~6.4 MB raw for the entire 46,508-room world versus ~352 MB for that one zone today.
**Do not claim "zone 317 now opens in the Phaser client".** It won't. `scene.ts:249` still builds one whole-zone RenderTexture (218,496 × 288,384 px for that zone), the fog canvas at `scene.ts:290/301` is one pixel per tile (~235 MB of ImageData), and `reveal` stores absolute dense indices (lines 133/205/326) which sparse chunks break outright. The acceptance criterion is the memory assertion, not a screenshot. This milestone is owed regardless of the 3D decision, which is exactly why it goes first — it de-risks everything downstream while betting nothing.

### M1 — Repair sector inference. *(1–2 weeks)*
`inferSector()` in `D:\MyGame\packages\worldgen\src\terrain.ts` is a first-match-wins regex over the room name, then the zone name, then `return { sector: 'field', source: 'default' }`. I confirmed the flagship symptom: **zone 390 "The Nightwood" is 49 rooms, one distinct name, and all 49 are `sector: 'field'`** — because `/\b(forest|wood(s|land)?|...)\b/i` finds no word boundary inside "Nightwood". Your demo zone is classified as open grassland. `road` and `city` are also ordered ahead of `forest`, so "A Forest Path" resolves to `road`.
Add trailing-suffix rules for fantasy compounds (`-wood`, `-shire`, `-dale`, `-fell`, `-moor`, `-holt`) and iterated majority-vote label diffusion across the room graph — a room surrounded by forest is forest even if its name says nothing. A reviewer prototyped this and measured the blind-default rate falling from 23.2% to 1.2%.
**Visible/testable:** a worldgen report printing per-zone label source counts; assert <2% unlabelled world-wide, zero fully-defaulted zones, and The Nightwood resolving to `forest`. Named regression cases: The Labyrinth (86% defaulted today), Undermountain I (80%), Silverymoon (57%), the `Grid-UD-*` zones (100%).
Do this before M2, because sector now selects ground material, tree species, prop tables, scatter density, fog and light budget. It is no longer a cosmetic detail; it is art direction.

### M2 — `roomScene.ts` IR + whole-world invariant tests. *(2–3 weeks)*
Pure `describeRoom`. Biome + blend weights, ground component regions, four classified edges, enclosure class, elevation policy, openings, features, seed. No renderer, no GPU. Build an ASCII/SVG dump tool so you can look at derived scenes for any zone without a graphics stack.
**Visible/testable:** exhaustive invariants over all 46,508 rooms (see §4), running in seconds in CI. Getting this right before any GPU work is what keeps everything after it cheap.

### M3 — Three.js grey-box renderer, spatial streaming, vertical policy. *(3–4 weeks)*
New `packages/client` on three 0.185.1. Camera rig (30° FOV, 64° pitch, fixed yaw). Boxes, cylinders and cones driven entirely by `RoomScene`. Salvage `net.ts`, `log.ts`, the prediction/reconciliation block, the input→intent mapping. Spatial-radius chunk streaming with pooled-per-archetype geometry and explicit dispose. **The multi-level camera policy lands here** — level above hard-culled, level below faded — because it must be settled before shadows and lighting are tuned.
**Visible/testable:** walk a real zone in 3D against the unmodified server, with client prediction working and zero art assets in the build. Automated 1,000-room traversal with `renderer.info.memory` **flat** — make this an explicit CI assertion now, while it's cheap to fix. It is the single most likely way this design dies quietly.

### M4 — **GO / NO-GO. Night lighting, rain, fog, portals — on grey geometry.** *(2–3 weeks)*
`HemisphereLight` (sky ~`0x163a52`, ground ~`0x0a1a18`, no `AmbientLight`), one moon `DirectionalLight` with an orthographic shadow camera refitted per frame to the loaded ring (~40×26 m — which is why you need no cascaded shadow maps at all), `PCFSoftShadowMap`, `FogExp2` in the night colour, AgX/Neutral tone mapping + LUT, the fixed pool of 8 point lights, per-room clearing light, camera-parented rain as one `InstancedMesh` of ~6,000 elongated quads modulo-wrapped in a custom vertex shader (one draw call, zero CPU per frame, additive, `depthWrite` off), emissive portal rings on the 5,934 portal edges, selective bloom via pmndrs `postprocessing`, three-state fog of war as a per-chunk uniform rather than the blurred 1 px-per-tile canvas.

**This is the decision point.** Roughly 70% of why the reference image looks the way it does is renderer, lighting, fog and grade — not meshes. If a grey-box scene at the end of M4 already reads as "night, rain, mood, place" when you put it beside the reference, the bet is good and the remaining work is art and breadth. If it reads as grey cylinders under a blue filter, **stop and reconsider before spending a single hour on assets.** Judge it side by side with the reference on the same monitor, and be strict: the useful question is not "is this nice" but "does the *light* match".

Cumulative to here: **10–15 weeks.** That is what it costs to find out.

### M5 — Outdoor art pass. *(4–6 weeks)*
EZ-Tree conifer bake in worldgen; Quaternius Nature MegaKit imported, Draco/KTX2-compressed, served from `public/models`; the three-layer instanced scatter (boundary vegetation, interior clutter, ground detail with distance fade); the card-foliage material with bent normals, wind and translucency, **with `customDepthMaterial` matched**; the two-layer blended ground; the water surface and shoreline; wetness response.
**Visible/testable:** The Nightwood and The Roads of the Heartland dressed automatically, side by side with the reference. Draw-call and frame-time budget report on your actual GPU, with shadow casting counted (it roughly doubles draws).

### M6 — Interiors and caves. *(4–6 weeks)*
`inside` + `cave` + `city` = **35.7% of rooms, measured.** This is a second rendering mode, not a palette: roof and ceiling geometry, camera-aware roof culling and wall fading, interior light sources, no sky term, no weather, a different shadow setup. Quaternius Medieval Village MegaKit for the kit.
**It goes here, before characters, deliberately** — after the material/shader stack is locked at M5 so you're not re-authoring it, but before you've spent months on anything that assumes an open sky. Every prior version of this plan put it last and every reviewer independently predicted that's where the project dies.
**Visible/testable:** walk Skullport (1,466 rooms, 18 levels) and a cave zone end to end without seeing sky, floating slabs, or a camera looking at the top of a roof.

### M7 — Characters, equipment, animation, protocol v2. *(5–7 weeks)*
Quaternius base mesh + modular outfits as real equipment slots; `AnimationMixer` state machine (idle/walk/run/attack/hit/die) driven by the 3 s round but interpolated at frame rate; troika nameplates and damage numbers; the dark hotbar strip in `index.html`; **combat visuals — note the current client has no `attackResolved` or `died` handler at all, the server emits them and the client discards them.**
Three `protocol.ts` changes, bump `PROTOCOL_VERSION`: `EntityView.sprite` (2D-atlas vocabulary, hardcoded `'player'` server-side at `sim.ts:188` so it costs nothing today) → model id + equipment slots; `EntityView.facing` → float yaw, because a 6-value cardinal enum makes a 3D character snap visibly while strafing (`Direction` stays for room exits — it's the MUD's own encoding and the join key); and the `x`/`y` doc comment, which currently lies (it says "within the room cell, in tiles" while `sim.ts:106-107` sends zone-grid pixels).
**Disclose to yourself now:** this milestone is where the Phaser client stops compiling against the protocol. Up to M6 you can run both renderers against one server and diff prediction behaviour live; after M7 that safety net is gone. That's fine, but decide it deliberately.
**Risk I could not verify:** this assumes Quaternius's *Universal Base Characters*, *Modular Character Outfits* and *Universal Animation Library 2* share one armature and bone ordering. Plausible from one vendor, unchecked. **Test this in Blender in an afternoon before M5, not at M7** — if it's false, M7 roughly doubles into a retargeting project.

### M8 — Breadth and polish. *(6+ weeks, open-ended)*
Remaining biomes (`desert` 4.1%, `hills` 3.4%, `astral` 2.3%, water 2.3%, `swamp`, `mountain`, `arctic`, `air`); the per-zone JSON override layer for hand-tuning important zones — **design its format at M2, while `roomScene.ts` is being written, not as a retrofit**; LOD and distance culling; `compileAsync` warm-up over every archetype; frame-time and bundle-size budgets in CI.

**Honest total: roughly 25–40 focused weeks to a world that looks intentional everywhere.** At hobby pace that is one to three years. M0–M4 alone — the part that tells you whether the look is achievable — is 10–15 weeks, and it is the only part you have to commit to now.

---

## 7. Risks, and when to abandon

**1. Building for the screenshot instead of for the world.** The reference is one biome under one lighting condition, and forest is 8.6% of your rooms. The failure mode is seductive: M4 and M5 look superb, everyone celebrates, then someone walks into Skullport and finds a grey box with a blue tint. Mitigations are already in the plan — enclosure class in the IR from M2, interiors at M6 rather than last — but add the cheap process one: **pick one indoor zone and one cave zone as permanent acceptance targets alongside the forest, and require every milestone from M3 onward to show all three.** The forest will take care of itself because it's what you want to look at.

**2. Painterly foliage may not come out of a shader.** This is the item I am least confident about. Quaternius's textured line is flat stylised low-poly; KayKit is explicitly a gradient atlas (i.e. texture-free); EZ-Tree's stock leaf cards are simple. Bent normals, translucency and wind change how a card is *lit* — they cannot invent hand-painted colour variation inside the card. You may end up commissioning or painting a small set of leaf/needle atlases yourself, which is real 2D art work you thought you'd escaped. Budget a week of experimentation inside M5 and decide there.

**3. GPU memory leak from streaming.** With continuous traversal of a 46,500-room world, unpooled geometry and materials will leak until the tab dies after 20–40 minutes. The pooled-per-archetype rule is architecture, not optimisation, and the flat-`renderer.info.memory` test at M3 is not optional.

**4. Procedural monotony.** Measured: **74.0% of rooms share their name with another room in the same zone** (zone 390 is 49 rooms with *one* distinct name). For three quarters of the world your generator's entire input is a duplicate name, a cell coordinate and up to four exits. `hashCell` is the only source of variation. The landmark slot, per-zone theming and the override layer are the defences; expect to iterate on this and don't be surprised when the first forest looks like every other forest.

**5. Dependency churn.** three ships breaking changes roughly every two months; `@types/three` lags; `postprocessing` pins `three <0.186.0`, which is one minor version from your pin. Pin everything, upgrade deliberately, and expect a maintenance day every couple of months for the life of the project.

**6. No playable client for months.** From M3 to roughly M6 you have a grey-box world. The Phaser client can run alongside behind a URL flag until M7 kills the protocol compatibility — use that, it costs almost nothing and it protects your morale.

### What would make me tell you to stay 2D

Concrete, falsifiable triggers. Any one of these and the honest answer is to stop:

- **M4 fails the side-by-side.** Grey geometry under your full night lighting does not read as the reference's mood. This is the designed exit and it costs you 10–15 weeks, of which M0, M1 and M2 (5–8 weeks) are useful work you keep either way.
- **The flat-memory test at M3 cannot be made to pass** after a serious attempt at pooling. A world this size that leaks is not shippable, and the fix is architectural, not incremental.
- **Frame time on your own machine exceeds ~16 ms at M5** in a dense forest zone with shadows on, and the only path back under it is cutting the scatter density that makes it look like the reference. At that point you're shipping a worse-looking 3D game than your 2D one.
- **The foliage experiment in M5 concludes you need bespoke painted atlases** and you don't want to make or buy them. A 3D world in flat toy-register low-poly is a perfectly good game — but it isn't the image you asked for, and if that image is the point, 2D with better art may get you closer for less.
- **Interiors at M6 turn out to need a genuinely separate renderer** rather than a second mode. 35.7% of the world is a lot to render badly.

And the fallback is not nothing. **M0, M1 and M2 are renderer-independent and worth doing whatever you decide.** M0 fixes a live bug that makes 50 of your 327 zones unreachable today. M1 fixes an art-direction input that is wrong for a quarter of your world and is wrong in 2D as well. M2 gives you a tested, headless description of every room that a *2D* renderer could use just as happily to place better tiles, draw real boundaries, and dress the void. If you get to the end of M4 and say no, you will have spent five to eight weeks improving the game you already have and three to seven weeks buying certainty on a question you would otherwise have wondered about for years.

---

## Appendix: how this plan was produced

18 agents: 4 parallel engine/asset surveys, 1 codebase audit, 3 independent migration
proposals, 9 adversarial judges (3 lenses x 3 proposals), 1 synthesis.

### Proposal ranking

| Proposal | Engine | Mean judge score |
|---|---|---|
| lowest-risk | **Three.js r185 (MIT), `three@0.185.1` + `@types/three@0.185 | 5.0/10 |
| best-looking | Three.js r185 (three@0.185.1, MIT) + @types/three@0.185.1, W | 5.0/10 |
| scales-to-46k | Three.js r185 (three@0.185.1, MIT — verified on the npm regi | 4.7/10 |

### Survey verdicts

- **threejs**: strong-fit
- **babylonjs**: strong-fit
- **godot**: workable
- **assets3d**: workable
