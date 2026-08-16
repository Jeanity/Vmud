# The dungeon-crawl pivot — decided 2026-08-15

**Read this before doing any client work.** It supersedes `PLAN-3d-migration.md`'s renderer choice and
leaves everything else in that document standing.

## The decision, in the owner's words

> *"we are going to make a dungeon crawl game using unreal engine or something like it. we will
> integrate our maps and play style but more user friendly if possible."*

Two changes at once, and they are independent — either would be worth doing alone:

1. **Genre and scope**: a dungeon crawl rather than a 46,544-room open world.
2. **Engine**: Unreal (or comparable) rather than the Three.js `client3d`.

## Why — and the reasoning matters more than the conclusion

The owner's verdict on the Three.js client, 2026-08-15:

> *"the whole thing looks too plain and amateurish… it looks more like a prototype than a finished
> product. a proof of concept even. like this is how it plays and moves but ignore how it looks, we
> will make it better."*

That reading is **accurate and was by design** — M3 was literally *"the grey-box renderer"* and the
art direction was chosen partly because Quaternius is free and CC0. Three findings led from there:

- **It is not a polygon problem.** A vanilla WoW character is roughly 1,000–1,500 triangles; the
  troll authored this week is **4,644** and the kobold **4,108**. Doubling them changes nothing.
  What separates the two is **hand-painted texture** — light, shadow, wear and colour variation baked
  into the albedo by an artist — against Quaternius' deliberately clean, generic, flat style.
- **The assets are the ceiling, not the renderer.** You cannot light in detail that is not in the
  texture. Better lighting yields *well-lit generic assets*. This is why the ambient-occlusion slice
  was started and then killed: it was polish on the wrong layer.
- **The constraint is no budget** — this is a hobby project. Under that constraint **Epic's free
  ecosystem (Fab's free tier, Megascans, the monthly giveaways) is realistically the largest legal
  source of high-quality free assets that exists**, and nothing comparable exists for a plain
  Three.js project. That, and not the renderer, is the real argument for Unreal.

**Scope is the larger lever of the two and it is free.** Nobody art-directs 46,544 rooms — not one
person, not a studio. An open world dressed by procedural rules reads as procedural *in any engine*.
Thirty hand-dressed rooms can look finished. Choosing a scope one person can bring to a standard they
are proud of is the whole point, and it would be worth doing even if the engine never changed.

## What survives, measured

Counted at `4d7d454`, lines of `.ts` under each `packages/*/src`:

| package | source | tests | fate |
| --- | ---: | ---: | --- |
| `server` — sim, combat, the Duris transcription | 35,364 | 21,050 | **survives untouched** |
| `shared` — rules, protocol, world model | 19,183 | 12,222 | **survives untouched** |
| `worldgen` — the harvest pipeline | 10,480 | 4,019 | **survives untouched** |
| `admin` — the operator panel | 6,368 | — | survives |
| **survives** | **71,395** | **37,291** | |
| `client3d` — the Three.js renderer | 27,802 | 17,438 | **rebuilt** |
| `client` — the 2D Phaser client | 7,593 | — | already frozen before the pivot |

Plus **46,544 rooms across 328 zones** of harvested world data, which is engine-agnostic JSON —
verified by counting, not remembered.

**72% of the live source survives** — 71,395 of the 99,197 lines that are still in play, the rest
being `client3d`. Counting tests too it is 71%; counting the already-frozen 2D client as a loss it is
67%. Whichever framing, **it is the part that took longest**: the server speaks WebSocket JSON to a
client that knows nothing about it. This week proved the principle in miniature — two hand-authored
creature models dropped into a pipeline built for Quaternius humans with zero engine changes.

## The four hard problems, in the order they must be answered

### 1. Unreal's networking assumes Unreal owns the server — ours does not

This is the first thing to prove and the least discussed in any tutorial. UE's replication model —
what every course, template and sample teaches — is built around a UE authoritative server
replicating UE actors. MyGame's server is an external TypeScript authority speaking JSON over a
WebSocket, and **that is not changing**: it is the 35,313 lines the whole project rests on.

So a UE client must bypass replication entirely and hand-roll the transport, the entity layer and the
interpolation. That is the advanced case, not the beginner one. **Prove it before anything else** —
a UE project that connects to `ws://localhost:8787`, sends `auth` and `enter`, and prints the room
name it gets back is the single most valuable hour available.

### 2. World data to levels

`data/world/zones/*.json` is 328 zones of rooms with exits, sectors, elevations and flags;
`worldgen` turns them into tilemaps. `client3d` assembles geometry from that at run time
(`chunkPlan.ts`, `interior.ts`). Unreal needs the equivalent — procedural mesh, or generated level
assets, or a hybrid. **`roomScene.ts`'s IR is the right input** and is engine-agnostic by
construction: it already answers what a room is, what encloses it, where its mouths are, how high its
ceiling is and what props stand in it.

### 3. Assets — the actual reason for the move

Survey Fab's free tier and Megascans against the target look **before** committing a month. Two
traps: Megascans is photoreal, not stylized, and mixing photoreal rock with stylized characters is
its own coherence problem; and one cohesive style per client remains the rule (`CLAUDE.md`).

### 4. "More user-friendly if possible"

The owner's words, and **not yet defined** — ask before designing. Candidate readings: fewer typed
commands, more direct manipulation; clearer feedback for MUD mechanics that are currently text-only;
onboarding that does not assume MUD literacy. Worth its own conversation.

## The risks, stated rather than buried

- **The owner has never used Unreal** and has roughly a month of concentrated time. A month from zero
  gets competence in the editor, levels, assets and Blueprints — not a 27,751-line streaming client
  reproduced against a non-standard network layer.
- **Switching engines mid-flight is how hobby projects die.** The current game *works and is
  playable*. Protect that: do not delete `client3d` until the replacement plays.
- **Unreal does not fix assets.** Moving with the same kits yields beautifully-lit Quaternius. If the
  asset question is not answered, the move does not solve the problem that prompted it.

## The de-risking move

**Spike, do not commit.** In order, stopping at any point that fails:

1. Install UE. Build one room by hand. Import one free asset. *Does the owner enjoy this?*
2. Connect a UE client to the running MyGame server over WebSocket. Print the room name.
3. Walk a character in that room, driven by the server's position updates.
4. Generate one real dungeon's geometry from `roomScene.ts`'s IR.

Steps 1–3 are the whole question. If they land, the month is well spent. If step 2 fights back, that
is the signal to reconsider — and `client3d` is still there, still playing.

## What is explicitly NOT abandoned

The server, the rules, the world, the harvest, the admin panel, and every mechanic transcribed from
the Duris source. The pivot is a **renderer and a scope**, not a rewrite. Anything in
`docs/REFERENCE-mud-mechanics.md` remains the specification.

## State at the pause

Everything is committed and pushed; the branch, local `main` and `origin/main` all sit at `4d7d454`.
**3,127 tests, 3,124 pass, 0 fail, 3 skipped** — the three skip themselves by design. The abandoned
ambient-occlusion slice is parked as a patch in a session scratchpad that **expires with the
session**; it was deliberately abandoned, so let it go.

Open tasks that still make sense under the pivot, because they are server-side or data-side: **#55**
blood spatter (design only — needs two owner rulings), **#57** dropped items surviving a restart
(needs one ruling), **#53** the 2D client's in-flight confirm (moot if that client is dropped), **#54**
`programKeys()` under-reporting (Three.js only — moot after the pivot).
