# M5b brief — the world in its clothes

_Staged 2026-08-13, while M5a was still in flight, so the milestone can start the minute it lands.
The mission sentence is the owner's, eyes on the Stylized Nature MegaKit: **"lets work with that
and build my game in a world that looks like that."**_

Scope, from the plan's §5 and the 2026-08-13 amendment: import the Nature kit and scatter the
world with it; a real water surface; wetness; and a **daylight recipe** — M4 tuned only the night,
and the look the owner confirmed is the kit's own sunlit screenshots. M5c (the domain warp) comes
after and displaces whatever this milestone plants, so nothing here needs to know about it.

## Start by reading

- `docs/PLAN-3d-migration.md` §5 (art, delivery, the wetness/water cost note, tone-mapping note)
  and the **2026-08-13 amendment** at the top.
- **M5a's commit message and diff** — it owns `chunkPlan/streamer/pool/prototypes/world3d` today
  and was steered mid-flight to keep its scatter/instancing **mesh-source-agnostic**. Whatever
  layout it established under `packages/client3d/public/` is the layout to extend, and wherever it
  put its per-sector palette table is where the kit palette goes (lift it to `shared` if it grew
  inside `client3d` — palettes are decisions, and decisions live where tests can reach them).
- `CLAUDE.md` gotchas 3 and 8 (no `enum`/`namespace`, no constructor parameter properties — Node
  strips types and both emit code) and rule 3 (no `Math.random()` anywhere the simulation can see).

## The kit, measured on disk (2026-08-13, all 68 GLTF models)

`assets/quaternius/nature/` (git-ignored, CC0, `../PROVENANCE.md`). 148,947 tris across the whole
kit; gltf+bin ≈ 50 MB, 24 textures ≈ 41 MB (two 5.7 MB normal maps — DeadTree, TwistedTree — are
half of that).

| family | n | tris | XZ footprint | height | notes |
| --- | --- | --- | --- | --- | --- |
| CommonTree | 5 | 3.2–6.3k | ~4 m | 7.0–9.4 m | the forest workhorse |
| Pine | 5 | 1.6–5.0k | 3.6–6.4 m | 7.3–10.2 m | conifer counterpart to M5a's ez-trees |
| DeadTree | 5 | 5.6–6.6k | 6–8 m | 9.5–16.4 m | swamp / blasted land |
| TwistedTree | 5 | **9.1–10.1k** | **9.5–13.5 m** | **15.7–18.9 m** | landmark accents, ≤1 per room, never bulk scatter |
| Bush_Common (+Flowers) | 2 | 0.9–1.4k | ~2 m | 1.6 m | |
| Grass ×4 kinds | 4 | 155–622 | 0.6–1.6 m | 1.1–1.9 m | ground layer, distance-faded |
| Flower singles/groups | 4 | 285–1,690 | 0.8–1.8 m | ~2 m | field colour |
| Clover, Plant, Plant_Big | 5 | 48–360 | 0.8–3.1 m | 0.2–3.8 m | |
| Mushroom ×2 | 2 | 880 / 3,216 | ~1 m | 0.5–0.8 m | forest floor / swamp |
| Rock_Medium | 3 | 244–522 | ~3 m | ~2 m | hills, mountain edges |
| Pebble ×11 | 11 | 48–136 | ~0.4 m | 0.1 m | everywhere, cheap |
| RockPath ×10 | 10 | 0.6–3.5k | 0.8–2.1 m | 0.1 m | **road-edge dressing** |
| Petal | 5 | 13–30 | ~0.5 m | — | falling-petal particles, optional garnish |

Facts that shape the work:

- **The kit is already at world scale.** One room cell is 9 m; a CommonTree is 7–9.4 m tall on a
  ~4 m crown. **No normalization pass** — apply only per-instance jitter (scale ~0.85–1.15,
  yaw random, tiny tilt) through the seeded RNG.
- **One anomaly: `Fern_1` claims a 9.0×8.5 m bbox at 288 tris.** It is either a multi-frond ground
  patch or a bad export. Inspect it in the browser first; if it is a patch, scatter it at 0.3–0.5
  scale as forest-floor fill; if it is broken, drop it — do not ship a two-storey fern.
- **Leaf materials are the wind hook.** Tree GLTFs carry 2 materials (bark + leaves; leaf textures
  named `Leaves_*.png`/`Grass.png`/`Flowers.png`). M5a's foliage material (wind sway keyed on
  instance-position hash, `customDepthMaterial` matched — plan §5 trap) must be patched onto kit
  leaf primitives too, matched by material/texture name, or kit trees will stand rigid beside
  swaying ez-trees. Bark stays unpatched.
- **Instancing by (family, variant).** 68 static meshes → one InstancedMesh per variant per chunk
  bucket, through M5a's pooling. Understory is cheap (usually <700 tris); the budget worry is only
  TwistedTree/DeadTree, which are rationed by palette anyway.

## Pipeline — dev-first, optimize later

1. `packages/worldgen/src/modelgen.ts` (new file; worldgen owns offline steps): read
   `assets/quaternius/nature/`, emit into `packages/client3d/public/models/nature/` —
   **git-ignored, reproducible**, same standing as `data/world/`. Copy GLTF+bin+textures as-is for
   now; normalize file names to model ids (`common-tree-1`, …). Emit a `manifest.json` (id →
   url, footprint, height, tris, blocking radius) — the client reads the manifest, never globs.
2. **Defer Draco/KTX2/meshopt** (`@gltf-transform`) to a follow-up slice — plan §5's delivery rule
   stands, but the first "world in clothes" moment should not wait on a compression toolchain, and
   `package.json` is M5a's file today. Note the deferral in the commit message. The 5.7 MB normal
   maps are the first candidates when it lands.
3. Loading: `GLTFLoader` from `three/examples/jsm` — already in the dependency tree, no new
   packages. Load on demand per streaming ring, decompose into pooled BufferGeometry +
   shared materials (kit textures via one `TextureLoader` cache), register every byte in the
   **allocation ledger** — the flatness assertion is the project's CI proxy for GPU memory and it
   must stay flat when kit chunks stream in and out. Serve from stable URLs, never Vite imports
   (plan §5: `.glb`/`.ktx2` are not in Vite's asset list and the streamer wants stable paths).

## Palette draft (tune by eye against the kit's screenshots)

forest: CommonTree (bulk), Bush, Clover, Mushroom_Common, Flower singles, Grass_Common, Fern-patch
· pine belts / mountain aprons: Pine, Rock_Medium, Pebbles, Grass_Wispy_Short
· swamp: DeadTree, TwistedTree (≤1/room), Plant_1_Big, Grass_Wispy_Tall, Mushroom_Laetiporus
· field: Grass tall kinds, Flower groups, Clover, lone CommonTree
· hills: Rock_Medium, Pebbles, sparse lone trees
· road: RockPath pieces + Grass_Common_Short along edges — the road *reads* as a road before M5c
ever bends it
· desert/arctic: rocks + DeadTree only — **thin, and named as a gap**; do not pad with off-palette
models.

Blocking: trees and Rock_Medium block (reuse the shared scatter-block discipline — centre cross
and arrival tiles stay clear; the 2D scatter's SCATTER_BLOCKS rule exists because the owner got
wedged behind a log once). Understory never blocks.

## Water, wetness, daylight

- **Water**: one surface per chunk where the IR says water; depth-fade by ground depth below the
  plane, a foam line where water meets land cells, gentle normal scroll. Not a blue plane (plan
  §5's exact warning), and not a whole-world mesh.
- **Wetness**: rain already exists and is gated on `roofed`. Add the wet response: roughness drop
  + streaked specular on ground materials while (and shortly after) it rains, and a few instanced
  puddle decals on road/city ground. Plan §5: a roughness drop alone reads as "slightly darker",
  not wet.
- **Daylight**: the confirmation image is sunlit. Build a day recipe beside the night one — warm
  sun (one directional, same per-frame shadow refit), sky-blue hemisphere, fog pushed back and
  brightened, tone mapping stays **Neutral** (M4 finding: AgX sheds chroma). Wire a debug key to
  sweep time of day; if the server already ticks MUD game-hours, drive it from that and say so in
  the commit; if not, leave the hook named and keep the toggle.

## Acceptance

- Typecheck green; full suite green (baseline 2,284 + whatever M5a adds); ledger flat over the
  1,000-room traversal with kit streaming on.
- The Nightwood (zone 390) and the Heartland roads dressed automatically — screenshots day and
  night, beside the kit's own screenshots, judged on the owner's monitor (a hidden browser pane
  gets no frames — front it first; the fps/drawCalls counters read 0 otherwise).
- Draw calls: report per-view counts with shadow casting counted (it roughly doubles draws);
  instanced families, not per-model draws.
- No protocol change, no server change, 2D client untouched, `assets/` stays git-ignored,
  provenance files untouched.
