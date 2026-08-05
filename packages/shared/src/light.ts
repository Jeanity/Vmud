/**
 * The light catalogue: what a character can be carrying, and how bright that makes them.
 *
 * `vision.ts` answers "given a radius, which tiles are lit". This file answers the question one step
 * up: *where does that radius come from*. Light is an early progression axis rather than a constant —
 * the bare eye sees {@link DEFAULT_LIGHT_RADIUS} tiles, and everything above that is something you
 * found and are carrying, which can run out.
 *
 * It lives in `shared` for the usual reason: the server owns which source a character holds and when
 * it burns out, but the client re-derives the lit set every frame from its predicted position, and a
 * beacon that lights whole rooms on one side and a disc on the other is a desync you can see. One
 * catalogue, one derivation, both sides.
 *
 * ## The number that is load-bearing
 *
 * `ROOM_GAP` is 2, so a room's last floor column and its neighbour's first are 3 tiles apart. The
 * bare radius of 2 therefore cannot see across the gap and a radius of 3 exactly can. **Finding a
 * light is what lets you see into the next room from your own doorway.** The torch sits at 3 for that
 * reason and for no other; `tilemap.ts`, `vision.test.ts` and `light.test.ts` all pin the
 * relationship from their own side. Do not tune it in isolation.
 *
 * ## Distances, in seconds
 *
 * The durations below are quoted in rooms crossed, since that is what a player actually experiences.
 * `PLAYER_SPEED` is 150 px/s and a room-to-room step is `ROOM_STRIDE * TILE_SIZE` = 352 px, so **one
 * room crossing is about 2.3 seconds** of walking. That is the conversion used throughout.
 *
 * ## What is *not* here
 *
 * Inventory, ground placement, and burn-down timers. This module is pure data plus derivation: it
 * knows what a lantern is, not who is holding one or where one lies. Placement is the server's, and
 * is seeded from the room id so that every client and every restart agrees.
 */

import { UNLIMITED_DURATION, affectsFor, type Affect } from './affects.ts';
import type { CarriedLight } from './protocol.ts';
import type { Rng } from './rules.ts';
import { ROOM_GAP, ROOM_STRIDE, ROOM_TILES, Tile, tileAt, type TileGrid } from './tilemap.ts';
import { DEFAULT_LIGHT_RADIUS } from './vision.ts';
import { DIRECTIONS, DIRECTION_DELTA, type Room, type RoomId, type Zone } from './world.ts';

/**
 * How a source illuminates.
 *
 * - `radius` — a disc of light around the bearer, blocked by walls. `radius` is in **tiles** and is
 *   handed straight to {@link computeVisible}.
 * - `rooms` — a magical beacon. It lights every tile of every room within `radius` **room-steps**
 *   through the room graph, ignoring line of sight entirely: you see behind the pillar, around the
 *   corner and into the room next door, all at once. This is a different mode, not a bigger number,
 *   and it is derived by {@link roomLightTiles} rather than by a field-of-view cast.
 *
 * Kept structurally identical to `CarriedLight['mode']` in the protocol, which cannot import this
 * module (the wire format must not depend on the content catalogue).
 */
export type LightMode = 'radius' | 'rooms';

export interface LightSource {
  readonly id: string;
  readonly name: string;
  /** Tiles for `radius` mode; room-steps through the room graph for `rooms` mode. */
  readonly radius: number;
  readonly mode: LightMode;
  /** Burn time in milliseconds. Absent means it never goes out. */
  readonly durationMs?: number;
  /** What it leaves behind when it burns out. Absent means nothing — you are in the dark. */
  readonly expiresTo?: string;
  /** Relative likelihood of appearing as a ground pickup. 0 = never scattered. */
  readonly scatterWeight: number;
}

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Five sources, arranged so the progression is legible in one reading:
 * *brief 3 → sustained 3 → permanent 3 → permanent 4 → the whole room lights up*.
 *
 * Note what does **not** vary: three of the five sit at radius 3. That is deliberate. Radius 3 is the
 * threshold that lets you see across `ROOM_GAP`, and anything between 2 and 3 is mechanically
 * indistinguishable from carrying nothing at all — there is no such thing as a slightly-better-than-
 * blind light. So the early game is not a ramp of radii, it is one step up to 3 followed by a long
 * argument about *how long you get to keep it*. Duration is the axis; radius is the gate.
 */
export const LIGHT_SOURCES: Readonly<Record<string, LightSource>> = {
  /**
   * The cheap find. Radius 3 for about 45 seconds — twenty room crossings, enough to work out which
   * way you came in and get back out of a dead end, not enough to explore on.
   *
   * It is at radius 3 rather than something lower because a dimmer light would be a *non-event*: the
   * player would pick it up, see nothing change, and learn that light pickups are noise. Instead the
   * candle gives you the real thing, briefly, and teaches what the torch is for.
   */
  candle: {
    id: 'candle',
    name: 'a stub of tallow candle',
    radius: 3,
    mode: 'radius',
    durationMs: 45_000,
    scatterWeight: 60,
  },

  /**
   * The workhorse, and the source the geometry is tuned against. Radius 3 sees exactly one room
   * ahead through a doorway; four minutes is roughly a hundred room crossings, which is a real
   * expedition into a dark zone with a real decision at the end of it.
   *
   * Expires to nothing, on purpose: the moment a torch gutters out you are back to radius 2 and the
   * room you were about to walk into is gone again. That drop is the whole tension of the resource,
   * so it must be announced in the log — a radius that silently shrinks reads as a bug.
   */
  torch: {
    id: 'torch',
    name: 'a pitch-soaked torch',
    radius: 3,
    mode: 'radius',
    durationMs: 240_000,
    scatterWeight: 30,
  },

  /**
   * The same light, forever. No brighter than a torch and deliberately so — its value is that you
   * stop counting minutes, which is a bigger change to how a dark zone feels than one more tile
   * would be. Rare enough (weight 2 against the torch's 30) that finding one is an event.
   */
  everburning_torch: {
    id: 'everburning_torch',
    name: 'an everburning torch',
    radius: 3,
    mode: 'radius',
    scatterWeight: 2,
  },

  /**
   * Radius 4, unlimited. The second real threshold: `ROOM_TILES` is 9, so a room's centre tile is 4
   * from each wall, and a radius-4 disc standing on that centre reaches all four wall midpoints at
   * once — **every exit of the room you are in, without walking to look for it**. The corners stay
   * dark (5.7 away), so a room still has somewhere to hide something.
   *
   * That is what makes it the expensive one, not the extra tile of corridor.
   */
  lantern: {
    id: 'lantern',
    name: 'a hooded lantern',
    radius: 4,
    mode: 'radius',
    scatterWeight: 8,
  },

  /**
   * The owner's own example, and the one source that changes the *kind* of seeing you get.
   *
   * Room-radius **1**: your room and every room one exit away, entirely, walls and corners and all,
   * with no line of sight involved. One is not a placeholder — it is exactly the interest-management
   * radius (`current room + immediate neighbours`), so for thirty seconds you can see precisely the
   * region the server is already streaming you and not one room further. The beacon shows you
   * everything you are being told about; there is nothing beyond it to show.
   *
   * Thirty seconds is about a dozen room crossings: long enough to read the junction you are standing
   * in and choose a direction, far too short to travel by. Then it crumbles to a torch, so the
   * aftermath is a working light rather than a punishment.
   */
  /**
   * **A testing tool, not content.** Lights the room you are standing in and everything one exit away,
   * entirely and permanently, so a mechanic can be watched without first solving the lighting puzzle
   * that Phase 5 deliberately made hard.
   *
   * Room-radius 1 and unlimited, which is a `beacon_of_hope` that never crumbles. It is in the
   * catalogue rather than hidden behind a special case because the carried-light path is one code path
   * and a tester who is on a *different* path is testing something nobody plays — but it has
   * `scatterWeight: 0`, so the world never produces one, and it is only ever granted by
   * `GAME_DEV_LIGHT`. See that switch in `server/src/index.ts`.
   */
  glowing_ring_of_testing: {
    id: 'glowing_ring_of_testing',
    name: 'the glowing ring of testing',
    radius: 1,
    mode: 'rooms',
    scatterWeight: 0,
  },

  beacon_of_hope: {
    id: 'beacon_of_hope',
    name: 'the Beacon of Hope',
    radius: 1,
    mode: 'rooms',
    durationMs: 30_000,
    expiresTo: 'torch',
    // Never scattered. A beacon lying in the mud next to a rock would say the wrong thing about it.
    scatterWeight: 0,
  },
};

/* -------------------------------------------------------------------------- */
/* Lights the world ships                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The slots a light has to be in before it lights you — **Duris' own rule, not ours.**
 *
 * `handler.c:431` is the whole of it: `if (((i >= WIELD) && (i <= HOLD)) && (ch->equipment[i]->type
 * == ITEM_LIGHT) && ch->equipment[i]->value[2])`. A lantern in your bag lights nothing; a lantern in
 * your hand lights the room. That single line is what Phase 16 is transcribing, and it is why the
 * interim `carriedLight` — a field beside the inventory rather than a fact about it — had to go.
 *
 * Two slots rather than Duris' three, because `WIELD`, `HOLD` and the light position between them
 * collapse onto the two hands we model. A shield in the off hand therefore costs you your lantern,
 * which is the trade the rule exists to create.
 */
export const LIGHT_BEARING_SLOTS = ['mainHand', 'offHand'] as const;

/**
 * A catalogue item turned into a light source, or nothing for anything that is not one.
 *
 * The id is the item's own `obj:<vnum>`, so a source derived here can never collide with one of the
 * six hand-authored ids above — and so a log line naming what went out can be traced back to the
 * record it came from. `scatterWeight` is 0: {@link SCATTERABLE_LIGHTS} is the ground-pickup ladder,
 * which is authored progression, and dropping sixty-four harvested torches into it would flood the
 * one place the candle-to-lantern climb is legible.
 *
 * Takes the two fields it needs rather than an `ItemTemplate`, because `light.ts` must not depend on
 * the catalogue module to know what a light is — the same separation `CarriedLight` keeps from
 * `LightMode` a few lines up.
 */
export function lightSourceFrom(
  id: string,
  name: string,
  light: { readonly radius: number; readonly durationMs?: number } | undefined,
): LightSource | undefined {
  if (!light) return undefined;
  return {
    id,
    name,
    radius: light.radius,
    mode: 'radius',
    ...(light.durationMs === undefined ? {} : { durationMs: light.durationMs }),
    scatterWeight: 0,
  };
}

/**
 * Catalogue lookup.
 *
 * The own-property check is not paranoia: `LIGHT_SOURCES` is typed as a `Record<string, …>`, so
 * `lightSource('toString')` would otherwise hand back `Object.prototype.toString` typed as a
 * `LightSource` and the first read of `.radius` would produce `undefined` several frames from here.
 * Ids reach this function off the wire and out of save files.
 */
export function lightSource(id: string): LightSource | undefined {
  return Object.hasOwn(LIGHT_SOURCES, id) ? LIGHT_SOURCES[id] : undefined;
}

/** What a source leaves behind when it burns out, resolved through the catalogue. */
export function expiresTo(source: LightSource): LightSource | undefined {
  return source.expiresTo === undefined ? undefined : lightSource(source.expiresTo);
}

/* -------------------------------------------------------------------------- */
/* Ranking                                                                     */
/* -------------------------------------------------------------------------- */

/** Unlimited sources sort above every finite one without a special case at each comparison. */
function lifetime(source: LightSource): number {
  return source.durationMs ?? Infinity;
}

/**
 * The ranking rule, in order:
 *
 * 1. **`rooms` beats `radius`, always, whatever the numbers say.** The two are not on one scale and
 *    comparing their `radius` fields directly is simply wrong — 1 room-step is not dimmer than 4
 *    tiles. The ordering is not a judgement call either: the weakest possible `rooms` source lights
 *    every tile of a 9x9 room *plus* every neighbouring room, through walls. To match that with a
 *    disc you would need a radius past 11 and it still would not see round the corner. No `radius`
 *    source we would ever ship can beat one.
 * 2. **Larger radius wins**, within a mode. Same units, so the comparison means something.
 * 3. **Longer lasting wins**, at equal radius — unlimited beating any finite burn. This is what
 *    separates the candle from the torch and the torch from the everburning one.
 * 4. **Ties keep the incumbent**, so the result depends only on the set of candidates and their
 *    order, never on object identity or key iteration.
 */
function outranks(candidate: LightSource, incumbent: LightSource): boolean {
  if (candidate.mode !== incumbent.mode) return candidate.mode === 'rooms';
  if (candidate.radius !== incumbent.radius) return candidate.radius > incumbent.radius;
  return lifetime(candidate) > lifetime(incumbent);
}

/**
 * The best of several sources. **Never summed** — two torches are not a lantern, they are a torch
 * and a spare.
 *
 * This ranks sources by *what they are*, not by how much is left in the one you are holding: a
 * `LightSource` is catalogue data and carries no remaining time. A holder juggling two half-burnt
 * torches is making a different decision, and it is the holder's to make.
 *
 * `undefined` entries are skipped so callers can pass unresolved ids straight through
 * {@link lightSource} without filtering first.
 */
export function bestLight(candidates: Iterable<LightSource | undefined>): LightSource | undefined {
  let best: LightSource | undefined;
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!best || outranks(candidate, best)) best = candidate;
  }
  return best;
}

/**
 * What is lighting a character, derived from their affect list.
 *
 * **This is the phase-5b migration, and it is the interesting half of it.** Light used to be a field
 * with a hand-wound timer beside it. It is now an affect at `apply: 'light'` whose `context` is a
 * catalogue id, and the radius is *recomputed from base* by folding the list — `REFERENCE-mud-mechanics.md`
 * §1.5, no `unapply` anywhere. The bespoke burn timer was deleted rather than wrapped, which is the
 * only honest test of whether the primitive was general enough to be worth building.
 *
 * It returns the affect as well as the source because they answer two different questions: the source
 * is *what* you are holding and the affect is *how long you have it for*. Reuniting them at each call
 * site would mean every caller re-finding the winning node, and the second implementation would
 * eventually pick a different one.
 *
 * A list of candidates when the list is never longer than one, deliberately. `bestLight` has always
 * taken a list, and Phase 16 makes equipped items further candidates — so the general fold is written
 * once, now, rather than written narrowly and rewritten then. An id the catalogue no longer knows is
 * skipped: content can be removed between one login and the next, and the answer to "you were holding
 * something that no longer exists" is the dark, not a crash.
 */
export interface LitBy {
  readonly source: LightSource;
  readonly affect: Affect;
}

export function brightestLight(
  affects: Iterable<Affect>,
  // Phase 16: a held lantern's burn is an affect too, and its `context` is an `obj:<vnum>` that the
  // hand-authored catalogue has never heard of. Injected rather than looked up here, because the item
  // catalogue must not live in `@mygame/shared` — the same shape `keywords.ts` and `artClassOf` take,
  // and for the same reason. Defaulted, so every caller that only ever meant the six authored sources
  // keeps working untouched.
  resolve: (id: string) => LightSource | undefined = lightSource,
): LitBy | undefined {
  let best: LitBy | undefined;
  for (const affect of affectsFor(affects, 'light')) {
    if (affect.context === undefined) continue;
    const source = resolve(affect.context);
    if (!source) continue;
    if (!best || outranks(source, best.source)) best = { source, affect };
  }
  return best;
}

/**
 * How much burn a light affect has left, in the form the wire and the HUD want.
 *
 * The sentinel is translated here and nowhere else: {@link UNLIMITED_DURATION} is `-1` on the record
 * so it survives JSON, and `undefined` above it so that "never expires" and "no time left" cannot be
 * confused by anything that only does arithmetic.
 */
export function burnRemaining(affect: Affect | undefined): number | undefined {
  if (!affect || affect.durationMs === UNLIMITED_DURATION) return undefined;
  return affect.durationMs;
}

/**
 * The tile radius a source is worth — the number that goes on the wire as `SelfView.lightRadius` and
 * into {@link computeVisible}.
 *
 * With no source at all this is {@link DEFAULT_LIGHT_RADIUS}, the bare eye.
 *
 * Two things it deliberately does:
 *
 * - **It never returns less than the bare radius.** A light cannot make you blinder than no light;
 *   if something is meant to (a darkness effect), it is not a light source and does not belong here.
 * - **It converts `rooms` mode into tiles rather than returning its room-step count.** Returning 1
 *   for the Beacon of Hope would ship a *downgrade* to every consumer that only understands a
 *   radius. `radius * ROOM_STRIDE` is the straight-line tile distance spanned by that many room
 *   steps, so it is a safe floor. It is only a floor: the authoritative lit set for a `rooms` source
 *   is {@link roomLightTiles}, which sees round corners and through walls where this cannot.
 */
export function effectiveRadius(source: LightSource | undefined): number {
  if (!source) return DEFAULT_LIGHT_RADIUS;
  const tiles = source.mode === 'rooms' ? source.radius * ROOM_STRIDE : source.radius;
  return Math.max(DEFAULT_LIGHT_RADIUS, tiles);
}

/** Whether this source needs the lit set from {@link roomLightTiles} rather than a field-of-view cast. */
export function isRoomMode(source: LightSource | undefined): boolean {
  return source?.mode === 'rooms';
}

/* -------------------------------------------------------------------------- */
/* Room-mode illumination                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every tile lit by a `rooms`-mode source standing in `fromRoomId`.
 *
 * Breadth-first over the **room graph** — not over tiles — out to `roomSteps` exits, then the whole
 * floor of every room reached, plus the corridors joining them. Line of sight is not consulted: this
 * is a magical beacon, and the point of it is that walls stop mattering for a few seconds.
 *
 * ## What it will not cross
 *
 * - **Unlinked neighbours.** Two rooms can sit next to each other on the grid with no exit between
 *   them; `buildZoneTilemap` leaves void there, and the beacon respects the topology, not the
 *   geometry.
 * - **Portals.** A portal exit is not a corridor, it is a transition, and its far side may be a
 *   different Place entirely. Following one would paint tiles on a grid the destination does not
 *   live on.
 * - **Other levels and other zones.** A room is illuminable only if it has an origin on *this* grid,
 *   which is exactly the set `buildZoneTilemap` laid out for this level. `up`/`down` exits therefore
 *   go nowhere here, which is correct — they are transitions too.
 *
 * ## Determinism
 *
 * The server folds this into `seen` and the client paints from it, so the two must agree tile for
 * tile *and* the sets must be built in the same order. Exits are walked in fixed {@link DIRECTIONS}
 * order rather than in whatever order the room's `exits` object happens to enumerate, so insertion
 * order — and therefore `Set` iteration order — is a function of the world data alone.
 *
 * Pure and allocation-light: one `Set`, one queue, one room index. Nothing here reads a clock, an
 * RNG or a file.
 */
export function roomLightTiles(
  grid: TileGrid,
  zone: Zone,
  fromRoomId: RoomId,
  roomSteps: number,
): Set<number> {
  const out = new Set<number>();
  if (!grid.roomOrigins.has(fromRoomId)) return out;

  const byId = new Map<RoomId, Room>();
  for (const room of zone.rooms) byId.set(room.id, room);
  if (!byId.has(fromRoomId)) return out;

  const limit = Number.isFinite(roomSteps) ? Math.max(0, Math.floor(roomSteps)) : 0;

  // BFS over the room graph. `queue` is walked with an index rather than shifted: these are short
  // (radius 1 is a handful of rooms) but a `shift` on an array is O(n) and this runs per frame on
  // the client while a beacon is lit.
  const litRooms: RoomId[] = [fromRoomId];
  const depth = new Map<RoomId, number>([[fromRoomId, 0]]);
  for (let head = 0; head < litRooms.length; head++) {
    const roomId = litRooms[head]!;
    const distance = depth.get(roomId)!;
    if (distance >= limit) continue;

    const room = byId.get(roomId);
    if (!room) continue;

    for (const dir of DIRECTIONS) {
      const exit = room.exits[dir];
      if (!exit || exit.portal) continue;
      if (depth.has(exit.to)) continue;
      // Not on this grid means not on this level, or not in this zone. Either way, unreachable.
      if (!grid.roomOrigins.has(exit.to) || !byId.has(exit.to)) continue;
      depth.set(exit.to, distance + 1);
      litRooms.push(exit.to);
    }
  }

  // Room floors.
  for (const roomId of litRooms) {
    const origin = grid.roomOrigins.get(roomId)!;
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      const ty = origin.ty + dy;
      if (ty < 0 || ty >= grid.height) continue;
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        const tx = origin.tx + dx;
        if (tx < 0 || tx >= grid.width) continue;
        out.add(ty * grid.width + tx);
      }
    }
  }

  // The corridors between them. Only where *both* ends are lit: a lit corridor running away into an
  // unlit room would draw a bright stub pointing at nothing, which reads as a rendering fault.
  for (const roomId of litRooms) {
    const room = byId.get(roomId);
    const origin = grid.roomOrigins.get(roomId);
    if (!room || !origin) continue;
    for (const dir of DIRECTIONS) {
      const exit = room.exits[dir];
      if (!exit || exit.portal) continue;
      if (!depth.has(exit.to)) continue;
      const [dx, dy] = DIRECTION_DELTA[dir];
      addGapTiles(grid, out, origin, dx, dy);
    }
  }

  return out;
}

/**
 * Adds the walkable tiles in the gap band between a room block and its neighbour in one direction.
 *
 * The band is scanned and filtered on `Tile.Void` rather than reconstructing the connector's
 * geometry from `CONNECTOR_WIDTH`: whatever `buildZoneTilemap` actually carved is what gets lit,
 * doors included, and a change to the carve shape cannot leave this function quietly lighting void
 * or missing a strip. Vertical directions have no band at all and fall out on the first test.
 */
function addGapTiles(
  grid: TileGrid,
  out: Set<number>,
  origin: { readonly tx: number; readonly ty: number },
  dx: number,
  dy: number,
): void {
  if (dx === 0 && dy === 0) return;

  let x0: number;
  let x1: number;
  let y0: number;
  let y1: number;
  if (dx !== 0) {
    x0 = dx > 0 ? origin.tx + ROOM_TILES : origin.tx - ROOM_GAP;
    x1 = x0 + ROOM_GAP - 1;
    y0 = origin.ty;
    y1 = origin.ty + ROOM_TILES - 1;
  } else {
    y0 = dy > 0 ? origin.ty + ROOM_TILES : origin.ty - ROOM_GAP;
    y1 = y0 + ROOM_GAP - 1;
    x0 = origin.tx;
    x1 = origin.tx + ROOM_TILES - 1;
  }

  for (let ty = y0; ty <= y1; ty++) {
    if (ty < 0 || ty >= grid.height) continue;
    for (let tx = x0; tx <= x1; tx++) {
      if (tx < 0 || tx >= grid.width) continue;
      if (tileAt(grid, tx, ty) === Tile.Void) continue;
      out.add(ty * grid.width + tx);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Scattering                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The sources that can turn up on the ground, in a fixed order.
 *
 * Sorted by id rather than left in catalogue order so that the weighted roll below depends on the
 * *contents* of the catalogue and not on where in the file an entry was typed. Adding a sixth source
 * will move the existing ones anyway — this only guarantees that two builds of the same catalogue
 * scatter identically.
 */
export const SCATTERABLE_LIGHTS: readonly LightSource[] = Object.values(LIGHT_SOURCES)
  .filter((source) => source.scatterWeight > 0)
  .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const SCATTER_TOTAL = SCATTERABLE_LIGHTS.reduce((sum, source) => sum + source.scatterWeight, 0);

/**
 * Picks *which* light source a ground pickup is, weighted by `scatterWeight`.
 *
 * It deliberately does not decide *whether* a room has one or *where* in the room it lies — that is
 * the server's placement pass, seeded from the room id. This exists so the weighting lives next to
 * the weights, and consumes exactly one number from `rng` so a caller can reason about the stream.
 *
 * Seeded `Rng` only. `Math.random()` here would put a different torch in the same room on every
 * client and survive no restart.
 */
export function rollScatteredLight(rng: Rng): LightSource | undefined {
  if (SCATTER_TOTAL <= 0) return undefined;
  let roll = rng() * SCATTER_TOTAL;
  for (const source of SCATTERABLE_LIGHTS) {
    roll -= source.scatterWeight;
    if (roll < 0) return source;
  }
  // Only reachable if `rng` returns exactly 1, which the contract forbids; take the last rather than
  // returning nothing, so a bad Rng costs a skewed distribution and not a missing item.
  return SCATTERABLE_LIGHTS[SCATTERABLE_LIGHTS.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Wire form                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `SelfView.light` payload for a source.
 *
 * `remainingMs` is *omitted* rather than set to `undefined` when a source never expires:
 * `exactOptionalPropertyTypes` is on, and the difference is also visible on the wire — `JSON`
 * drops an undefined value, so a client cannot tell "no field" from "field I forgot to fill in"
 * unless the server is consistent about which it means.
 */
export function toCarriedLight(source: LightSource, remainingMs?: number): CarriedLight {
  return {
    id: source.id,
    name: source.name,
    radius: source.radius,
    mode: source.mode,
    ...(remainingMs === undefined ? {} : { remainingMs: Math.max(0, Math.round(remainingMs)) }),
  };
}
