# MyGame

A graphical, multiplayer, top-down / three-quarter-view RPG built on the world of **TorilMUD**
(formerly Sojourn), set in the Forgotten Realms.

> **Starting a session? Read [docs/HANDOFF.md](docs/HANDOFF.md) first.** It is the current state of
> play: what works, the decisions everything rests on, the known bugs, and what to do next. This file
> tells you the rules; the handoff tells you where things stand.
>
> This is a **graphical MUD**, not an action RPG with MUD flavour — MUD mechanisms are the
> specification. The best reference is the complete Duris MUD C source on disk at
> `data/zones-source/duris/src/` (same Sojourn lineage as TorilMUD); grep it rather than researching
> MUDs abstractly. [docs/REFERENCE-mud-mechanics.md](docs/REFERENCE-mud-mechanics.md) maps 106 of its
> mechanisms to what we have built.

> This project is **independent** of everything under `E:\` (Jeanity, InstaPost, SIG, Bannergen,
> EmailCampaignGen, …). Do not import context, conventions, or skills from those projects.

## Stack

- **Language:** TypeScript throughout, ESM, npm workspaces monorepo.
- **Client:** Phaser 3 + Vite.
- **Server:** Node 24, authoritative simulation, WebSocket transport.
- **Rules:** SRD 5e as the backbone; MUD-style tick-based combat rounds.
- **Art:** one cohesive style per client, never mixed. The **3D client** (the game's future) is
  **Quaternius stylized low-poly** — owner-confirmed 2026-08-13: the world should look like the
  Stylized Nature MegaKit's own screenshots. Kit models first; anything the kits lack is built to
  match (ez-tree output restyled to the kit palette) rather than borrowed from another style. CC0,
  under `assets/quaternius/` (git-ignored; its `PROVENANCE.md` records source and terms). The
  **2D Phaser client** is **LPC (Liberated Pixel Cup)**, frozen since the 3D pivot — 3/4-view
  humanoids with layered equipment so worn gear is visible. LPC licences are CC-BY-SA 3.0 /
  GPL 3.0 — attribution is mandatory, so every asset folder keeps its upstream `LICENSE` and
  `AUTHORS` file.
- **Presentation:** hybrid — graphical rooms with a collapsible MUD-style text log for room prose,
  combat rolls and chat.

## Packages

| Package | Role |
| --- | --- |
| `@mygame/shared` | Types, wire protocol, dice/rules maths. **No I/O, no Node or browser APIs.** Imported by everything. |
| `@mygame/server` | Authoritative world simulation and WebSocket server. Owns all game state. |
| `@mygame/client` | Phaser 3 renderer and input. Owns *no* game state — renders what the server says. |
| `@mygame/worldgen` | Offline pipeline: source map data → validated world JSON → tilemaps. Never runs at play time. |

## Architectural rules

1. **The server is authoritative.** The client sends *intents* ("I want to move north"), never
   outcomes. Anything the client computes is prediction and must be reconcilable.
2. **The room is the unit of interest management.** Players receive updates for their current room
   and its immediate neighbours only. This falls out of the MUD's own structure and keeps bandwidth
   flat regardless of world size.
3. **Simulation is deterministic.** All randomness goes through a seeded RNG from
   `@mygame/shared/rules`. Never call `Math.random()` in simulation code — it makes desyncs
   unreproducible and combat unauditable.
4. **Two clocks.** A 100 ms simulation tick drives movement and timers; a 3 s combat round drives
   auto-attacks and ability resolution. Round length is data, not a constant sprinkled through code.
5. **Content is separable from engine.** No third-party world data may be hardcoded into engine
   packages, and the engine must always be able to run against a synthetic world. See
   [docs/RESEARCH-map-data.md](docs/RESEARCH-map-data.md) for why.

## Conventions

- Coordinates: `x` east, `y` **south** (screen-space, so y grows downward), `z` up. One unit = one
  room cell.
- Room and zone ids are the MUD's own numeric ids — never renumber them; they are the join key
  between every data source we have.
- Prefer discriminated unions with a `t` tag for messages and events.

## Gotchas that have already cost time

1. **Three different direction encodings exist in this project.** Diku `.wld` uses
   `D0=N, D1=E, D2=S, D3=W, D4=U, D5=D`; zMUD `ExitTbl.DirType` uses
   `0=N, 2=E, 4=S, 6=W, 8=U, 9=D`; zMUD `DirTbl.DirId` is 1-based in yet another order. Getting one
   wrong produces output that looks entirely plausible. Always assert the n≈s / e≈w balance after
   mapping directions.
2. **Never read `PORT` in the game server** — use `GAME_PORT`. Dev harnesses set `PORT` for the web
   server and `concurrently` hands its environment to every child, so the game server silently
   steals Vite's port. Node sets `SO_REUSEADDR`, so on Windows the second bind *succeeds* and you
   get two processes on one port with no error anywhere.
3. **No TypeScript `enum` or `namespace` anywhere.** Node strips types at run time and rejects any
   construct that emits runtime code. Use `const X = {...} as const` with a matching type alias.
4. **`console.log` has no width specifiers.** `%7d` is printed literally; pad with `padStart`.
5. **Phaser input has two traps, and both have already bitten.**
   a. **Key capture eats characters out of text inputs.** `keyboard.addKeys('W,A,S,D,…')` registers
      those keys for *capture*, and the manager calls `preventDefault()` on each in a document-level
      listener that runs before the keystroke can reach a focused `<input>`. Typing `help` into the
      command line arrived as `hlp` — the `E` binding ate it — and `say` arrived as `y`. Gating the
      game's own reads (`WorldScene.typing`) is **not** enough; the loss happens below that, so
      `setTyping` must also call `disableGlobalCapture()` / `enableGlobalCapture()`. Every key you
      bind is a letter that vanishes from typed words unless it goes through that toggle.
   b. **`JustDown` polled in `update` loses chords and short taps.** Reading a key's edge and only
      *then* testing a modifier consumes the edge and throws it away — so `Q` pressed one frame before
      `Shift` produced nothing at all, a 16 ms window on a chord pressed as one gesture. And
      `Key.onUp` clears `_justDown`, so a tap where the down and up both land between two frames is
      never seen. Bind `keydown-<KEY>` and read `event.shiftKey` / `event.repeat` off the event
      instead: the modifier state at the moment of the press is what the player meant, and there is no
      stored edge left to fire late.
6. **npm eats unknown flags.** `npm run x -- --zone 390` through a nested `npm run --workspace`
   loses `--zone` to npm's own config parser. Root scripts that take flags must invoke `node`
   directly.
7. **A git worktree with no `node_modules` builds the *other* checkout, silently.** `node_modules/`
   is git-ignored, so a fresh worktree has none, and Node then resolves `@mygame/shared` upward into
   the main checkout's — where the workspace symlink points at `D:\MyGame\packages\shared`. Typecheck,
   tests and both Vite dev servers all then read main's source while you edit the worktree's, and
   nothing warns: everything passes, because the code being checked is real, just not yours. The tell
   arrives only when you *add* an export — `tsc` says the member does not exist and the browser says
   the module does not provide it. **`npm install` in the worktree first.** Then delete
   `packages/*/node_modules/.vite` and restart the dev servers: Vite caches the old resolution and a
   reload will not clear it.

8. **Node's type stripping rejects TypeScript parameter properties.** `constructor(private
   readonly x: T)` throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at run time — same family as the
   no-`enum`/`namespace` rule: it emits code. Any module a headless test can reach must declare
   fields explicitly and assign them in the constructor body. Found building `client3d`.

## Commands

```bash
npm install          # once
npm run dev          # server + client together
npm run typecheck    # tsc --build across all packages
npm run worldgen     # rebuild world JSON from source map data
```

## Data layout

- `data/zones-source/` — third-party source data, **git-ignored**, never committed or shipped.
- `data/world/` — generated world JSON, **git-ignored**, reproducible via `npm run worldgen`. Zones are
  geometry; `data/world/spawns/` is their harvested population, read only by the server.
- `assets/` — free art assets, each subfolder carrying its upstream `LICENSE`.
