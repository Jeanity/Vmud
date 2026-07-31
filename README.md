# MyGame

A **graphical MUD** — a multiplayer, top-down/three-quarter-view RPG built on the world of
**TorilMUD** (formerly Sojourn), set in the Forgotten Realms.

Not an action RPG with MUD flavour. MUD mechanisms are the specification: tick-based combat rounds,
room-scoped interest management, aggression as a predicate, threat tables, zone repopulation on a
re-rolled clock. The presentation is hybrid — graphical rooms you walk around, beside a MUD-style text
log carrying room prose, combat rolls and chat.

> **Status: in development, and honest about it.** Fifteen of twenty-three planned phases are done.
> You can explore a real castle, be hunted through it, fight things, kill them and loot their corpses.
> There are no items, no character progression, and a new character cannot survive the only populated
> zone. See [What works today](#what-works-today).

---

## Running it

```bash
npm install
npm run dev          # server + client together
```

Client on **5273**, game server on **8787**.

```bash
npm test             # 714 tests
npm run typecheck    # tsc --build across all four packages
npm run worldgen     # rebuild world JSON from the source map data
```

Node 22 or newer. TypeScript throughout, ESM, npm workspaces.

### ⚠️ A fresh clone will not build a world

`data/zones-source/` — the third-party MUD source data everything is derived from — is **not in this
repository** and is **not reproducible**. It is 318 MB of someone else's content; committing or shipping
it is not ours to do.

Without it, `npm run worldgen` fails and the server has no world to load. If you are restoring this
project from the repository alone, that directory has to be put back by hand from a separate copy.

`data/world/` (generated) and `data/players/` (live save state) are likewise excluded — the first is
rebuilt by `npm run worldgen`, the second is yours.

---

## What works today

| | |
| --- | --- |
| **World** | 327 zones / 46,508 rooms harvested from a zMUD mapper database; 4 loaded, 219-room IceCrag Castle among them, with real prose, sector types and room flags |
| **Movement** | WASD, hold-to-drag steering, and click-to-move on server-side A* — gated on ground you have actually seen |
| **Light and sight** | Tile-granular shadowcasting, three visibility states, fog remembered per character. Torches burn down and gutter out |
| **Doors** | Openable, closable, opaque when shut, and shared correctly between both rooms |
| **Command line** | Server-resolved abbreviations in Diku's own table order, so `n` is north and `sa` is say |
| **Mobs** | 92 in IceCrag, harvested from the source's own `.mob`/`.zon` files, repopulating on a re-rolled clock |
| **Aggression** | A predicate over *you*, not a boolean on the mob. Delayed reaction, re-validated when it fires, so you can run past |
| **Pursuit** | It follows you through the room graph — one room per 1.5 s, which is faster than you walk |
| **Combat** | Engagement is a relationship, not a distance. Per-actor round clocks. The d20 is printed so fights are auditable |
| **Threat** | A table per mob with hysteresis, so a tank can hold aggro — and a mob only ever fights people who actually did something to it |
| **Death** | Corpses that decay, and experience divided by contribution — damage dealt, damage taken *and* support |

### Not built yet

Items, inventory, equipment, shops, money, quests, classes, races, skills, spells, grouping, and any
chat beyond room-scoped `say`. A corpse holds nothing, because nothing can be carried.

**The largest gap is character progression.** A new character is level 1 with 9 hit points; the only
populated zone runs from level 15 to 60. Combat is correct and unsurvivable. There are `GAME_DEV_*`
environment switches to make it testable, and they are a test rig rather than a design.

---

## Architecture

Four packages, and the boundaries are the point:

| Package | Role |
| --- | --- |
| `@mygame/shared` | Types, wire protocol, dice and rules maths. **No I/O, no Node or browser APIs.** |
| `@mygame/server` | Authoritative simulation and WebSocket server. Owns all game state |
| `@mygame/client` | Phaser 3 renderer and input. Owns *no* game state — draws what the server says |
| `@mygame/worldgen` | Offline pipeline: source map data → validated world JSON. Never runs at play time |

Five rules everything else follows:

1. **The server is authoritative.** Clients send *intents*, never outcomes.
2. **The room is the unit of interest management** — you hear about your room and its neighbours, so
   bandwidth is flat regardless of world size.
3. **Simulation is deterministic.** All randomness comes from a seeded RNG, so any fight can be replayed.
4. **Two clocks**: a 100 ms tick for movement and timers, a 3 s round for combat — and round length is
   *per actor*, not global, or every speed stat collapses into "extra attacks".
5. **Content is separable from engine.** No third-party world data is hardcoded anywhere, and the engine
   can run against a synthetic world.

---

## Documentation

The docs are the real record of this project, and they carry the reasoning rather than only the result.

| File | What it is |
| --- | --- |
| [docs/HANDOFF.md](docs/HANDOFF.md) | **Start here.** Current state, the decisions everything rests on, gotchas that have already cost time, and what to do next |
| [docs/ROADMAP.md](docs/ROADMAP.md) | The schedule. Twenty-three phases, each pairing a mechanic with something you can *see* — a phase is done when it is visible, not when the code exists |
| [docs/REFERENCE-mud-mechanics.md](docs/REFERENCE-mud-mechanics.md) | 106 MUD mechanisms mapped to what we have built, and the traps in each |
| `docs/DESIGN-*.md` | Settled designs: engagement, mobs and movement, visibility and light, inventory |
| [CLAUDE.md](CLAUDE.md) | Conventions, architectural rules, and the gotchas that have bitten more than once |

---

## Credits and licences

**World and mechanics** derive from **TorilMUD** (formerly Sojourn) and its Duris lineage. Room names,
prose, mob statistics and zone layouts are the work of that community's builders over some thirty years.
The source data is not redistributed here.

**Artwork** is from the **Liberated Pixel Cup** set, licensed **CC-BY-SA 3.0** and **GPL 3.0**.
Attribution is a licence obligation, not a courtesy: every artist is named in
[`packages/client/public/lpc/ATTRIBUTION.md`](packages/client/public/lpc/ATTRIBUTION.md), which also
records how to add more sets and where to get them. Anything LPC lacks is *drawn to match* rather than
borrowed from another style, so the game keeps one cohesive look.

**Rules** use the SRD 5e as a backbone, with MUD-style tick-based rounds over the top.
