/**
 * Ground pickups: where the light sources of `@mygame/shared/light.ts` are lying on the floor.
 *
 * There is no item system and no inventory, and this file must not become one. A light source is
 * found by **walking onto the tile it lies on**, which is the whole of the acquisition mechanic —
 * and it is the right one for this feature specifically, because it means you find torches by
 * exploring in the dark. A pickup list in a menu would hand you the upgrade; the floor makes you go
 * looking for it with a two-tile radius.
 *
 * ## Per character, not per world
 *
 * **A pickup is a property of a room, not an object in it.** Two characters standing in the same
 * room each see their own copy, and one taking it does not remove it for the other. Nothing is
 * "spawned"; taking one is recorded as a key in that *character's* `taken` set, and the scatter is
 * re-derived from the room id every time it is asked for.
 *
 * That is a deliberate simplification and not an oversight. A shared world object needs an owner, a
 * lifetime, a respawn rule and a race between two players reaching for the same tile — all of which
 * belong to the item system this task exists to avoid building. The version here has none of that
 * and still produces the intended feel, because in a dark zone what matters is whether *you* found a
 * torch. When a real item system arrives it replaces this file rather than extending it, and the
 * seam is exactly {@link pickupInRoom}.
 *
 * ## Determinism
 *
 * Placement is a **pure function of the room id**, run through the seeded `makeRng` from
 * `@mygame/shared/rules`. Never `Math.random()` — not as a shortcut and not "just for placement":
 *
 * - Every client and every server restart must agree on where a torch is, without persisting a
 *   single byte of world state. Nothing here is saved; the world is recomputed.
 * - A character who took the torch in room 26031 must still find it gone after a restart, which
 *   works only because the room still scatters the same torch to compare their `taken` key against.
 * - Two players must be able to compare notes. "There's a lantern in the fungus cave" has to be true
 *   for both of them.
 *
 * The rng is seeded per room and drawn from in a fixed order, so adding a draw to the end of
 * {@link rollScatter} leaves earlier decisions untouched while inserting one reshuffles the world.
 */

import {
  ROOM_TILES,
  TILE_SIZE,
  makeRng,
  randomInt,
  type EntityId,
  type EntityView,
  type RoomId,
  type TileGrid,
} from '@mygame/shared';
// A subpath import: `light` is not re-exported from the package barrel.
import { bestLight, rollScatteredLight, type LightSource } from '@mygame/shared/light.ts';

/**
 * Mixed into every room seed so the scatter is a property of *this* world rather than of the room
 * ids alone.
 *
 * Changing it re-rolls every room in the game, which is the point: it is the one knob that shuffles
 * the world without touching the algorithm. It is not a secret and does not need to be — a client
 * that predicts where the torches are is predicting the same thing the server will tell it.
 */
export const WORLD_SEED = 0x546f_7269; // "Tori", for Toril.

/**
 * How often a room holds a light source.
 *
 * **One room in eight**, chosen against the two numbers that actually constrain it rather than
 * picked for feel:
 *
 * 1. **You only find what your light falls on.** A pickup is a tile, and at the bare
 *    `DEFAULT_LIGHT_RADIUS` of 2 a straight crossing of a 9x9 room lights **45 of its 81 floor
 *    tiles** — measured off the real shadowcaster, not estimated, and pinned by `pickups.test.ts`.
 *    So a little over half of what is scattered is ever seen in passing: **1 room in 8 scattered is
 *    1 in 14.4 found.**
 * 2. **A room crossing is about 2.3 seconds** (`PLAYER_SPEED` 150 px/s over a `ROOM_STRIDE` of 352
 *    px). 14.4 crossings is therefore **~34 seconds of walking between finds**, against the candle's
 *    45-second burn — the cheapest source in the catalogue *just* carries you to the next one.
 *
 * That is where the mechanic is interesting. Above this rate the dark stops existing: at the 1-in-6
 * this was first sketched at, finds come every ~25 s and a candle covers the gap comfortably, so
 * light stops being a resource and becomes scenery. Below it the opening — bare radius, no light,
 * nothing found yet — outstays its welcome long before the first torch pays it off.
 *
 * ## Light compounds, which is why the rate can be this low
 *
 * The same measurement at the other radii: a torch (3) sweeps **63 of 81** tiles on that crossing
 * and a lantern (4) sweeps **all 81**. So a light source does not merely let you see further — it
 * makes you strictly better at finding the next one, and a lantern-bearer misses nothing at all in a
 * room they walk through. The first find is the hard one and every one after it is easier, which is
 * the shape a progression axis should have and is why the opening rate can afford to be stingy.
 *
 * It is self-limiting too, in a way a respawning world would not be: a character never finds the
 * same room's pickup twice, so a swept zone genuinely runs dry, and 10% of scatters (the lantern and
 * the everburning torch) end the resource game outright for whoever finds one.
 */
export const PICKUP_ROOM_CHANCE = 1 / 8;

/** Floor tiles in a room block. The pickup goes on exactly one of them. */
const FLOOR_TILES = ROOM_TILES * ROOM_TILES;

/**
 * The room's true centre, as an index into its floor.
 *
 * Excluded from the candidate slots, because it is where `relocate` puts a character stepping in
 * through an exit and where `buildZoneTilemap` paints stair markers. A pickup there would be
 * collected by the act of arriving, which is the one way of finding a light that involves no
 * exploring at all.
 */
const CENTRE_SLOT = ((ROOM_TILES - 1) / 2) * ROOM_TILES + (ROOM_TILES - 1) / 2;

/** Candidate slots: every floor tile of the block except the centre. */
export const PICKUP_SLOTS = FLOOR_TILES - 1;

/**
 * What a room scatters, in room-local terms.
 *
 * Deliberately grid-free. The decision depends on the room id alone, so it is the same on every
 * level of every zone and can be memoised without a `Place` in the key; only turning `slot` into a
 * tile needs a grid, and that is {@link pickupInRoom}'s job.
 */
interface RoomScatter {
  readonly source: LightSource;
  /** Index into the room block's floor, row-major, with {@link CENTRE_SLOT} skipped. */
  readonly slot: number;
}

/**
 * Memo of the scatter roll.
 *
 * Safe because {@link rollScatter} is pure: this is a cache of arithmetic, not a store of world
 * state, and dropping it entirely would change nothing but the CPU cost. `null` records "rolled, and
 * this room has nothing" so a negative result is not re-rolled on every visibility pass — which is
 * seven rooms in eight.
 */
const scatterCache = new Map<RoomId, RoomScatter | null>();

/**
 * Room id to rng seed.
 *
 * The room id is *hashed* into the seed rather than handed to `makeRng` directly. MUD room ids run
 * in dense consecutive blocks — a zone is 26000, 26001, 26002 — and while mulberry32 avalanches its
 * state well, seeding a generator with a counter and reading one number out of each is exactly the
 * usage pattern where a weak seeding step shows up as a visible stripe along a corridor. This is the
 * fmix32 finaliser from MurmurHash3: four instructions, and the neighbouring-seed correlation is
 * gone before the generator is even constructed.
 */
function scatterSeed(roomId: RoomId): number {
  let h = (roomId ^ WORLD_SEED) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85eb_ca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2_ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Rolls one room, consuming the rng in a fixed order: **present, which, where.**
 *
 * The order is part of the contract. Appending a draw leaves every existing room's presence, source
 * and position untouched; inserting one re-rolls the entire world. Say so in the commit if you ever
 * do the latter deliberately.
 */
function rollScatter(roomId: RoomId): RoomScatter | undefined {
  const rng = makeRng(scatterSeed(roomId));
  if (rng() >= PICKUP_ROOM_CHANCE) return undefined;
  const source = rollScatteredLight(rng);
  // Only if the catalogue has nothing scatterable at all. Treated as "this room is empty" rather
  // than as an error: a catalogue with every weight at 0 is a legitimate world with no free light
  // in it, not a broken one.
  if (!source) return undefined;
  return { source, slot: randomInt(rng, 0, PICKUP_SLOTS - 1) };
}

function scatterInRoom(roomId: RoomId): RoomScatter | undefined {
  const cached = scatterCache.get(roomId);
  if (cached !== undefined) return cached ?? undefined;
  const rolled = rollScatter(roomId);
  scatterCache.set(roomId, rolled ?? null);
  return rolled;
}

/** Slot to an offset within the room block, stepping over the excluded centre. */
function slotOffset(slot: number): { readonly dx: number; readonly dy: number } {
  const index = slot >= CENTRE_SLOT ? slot + 1 : slot;
  return { dx: index % ROOM_TILES, dy: Math.floor(index / ROOM_TILES) };
}

export interface GroundPickup {
  readonly roomId: RoomId;
  readonly source: LightSource;
  /** Tile coordinates on the grid of the Place this room sits on. */
  readonly tx: number;
  readonly ty: number;
  /** The key stored in a character's `taken` set. See {@link pickupKey}. */
  readonly key: string;
  readonly id: EntityId;
}

/**
 * The key a character's `taken` set records.
 *
 * Room-scoped because a room holds at most one pickup, so the room is the pickup's identity. It is a
 * string rather than the bare number so that a room holding two of something later extends the key
 * (`"r26031:2"`) instead of changing its type everywhere it is persisted.
 *
 * The key survives a re-roll of the catalogue on purpose: if room 26031 scatters a lantern tomorrow
 * where it scattered a torch today, a character who already emptied that room still finds it empty.
 * "I have searched this room" is the durable fact; which object was in it is not.
 */
export function pickupKey(roomId: RoomId): string {
  return `r${roomId}`;
}

/**
 * The entity id a pickup appears under.
 *
 * **Negative, so it can never collide with a player id.** `Simulation` hands out ids from 1 upward,
 * so the two spaces are disjoint by arithmetic rather than by a base constant chosen to be big
 * enough — and "big enough" is the kind of assumption that holds until it does not. It is also
 * stable across restarts, which a counter is not: the same torch keeps the same id.
 *
 * `roomId + 1` rather than `roomId` so that a room id of 0, if one ever exists, does not produce 0
 * and collide with "no entity".
 */
export function pickupEntityId(roomId: RoomId): EntityId {
  return -(roomId + 1);
}

/**
 * The pickup lying in a room, or `undefined` if that room scattered nothing.
 *
 * Knows nothing about who is asking: whether a *character* can see it, and whether they have already
 * taken it, are both the caller's questions. This answers only "what does this room hold", which is
 * a property of the world.
 *
 * Rooms with no origin on this grid — another level, another zone — hold nothing here, so a caller
 * cannot accidentally place a torch by indexing one grid with another's room.
 */
export function pickupInRoom(grid: TileGrid, roomId: RoomId): GroundPickup | undefined {
  const scatter = scatterInRoom(roomId);
  if (!scatter) return undefined;
  const origin = grid.roomOrigins.get(roomId);
  if (!origin) return undefined;
  const { dx, dy } = slotOffset(scatter.slot);
  return {
    roomId,
    source: scatter.source,
    // Every tile of a room block is *walkable*, so no walkability test is needed here. If that ever
    // stops being true this is where a pickup starts appearing inside a wall.
    //
    // Walkable rather than `Tile.Floor`, which would be the stronger claim and is not true:
    // `buildZoneTilemap` fills the block with floor and `carve` refuses to downgrade a floor tile,
    // but the stair pass afterwards overwrites a **3x3 block** with `StairsUp`/`StairsDown` for any
    // vertical exit, at an offset that varies per room (`stairPlacement`).
    //
    // So a scattered light can now share a tile with a flight of stairs, where it previously could
    // not — the stairs used to be one tile on `roomCentre`, which is exactly {@link CENTRE_SLOT} and
    // already excluded. That is left alone rather than adding a second exclusion: stair tiles are
    // walkable, the entity is drawn above the terrain either way, and a torch lying on a stair
    // landing is a perfectly ordinary thing to find. The invariant that matters here is walkability.
    tx: origin.tx + dx,
    ty: origin.ty + dy,
    key: pickupKey(roomId),
    id: pickupEntityId(roomId),
  };
}

/* -------------------------------------------------------------------------- */
/* What a light on the floor is worth to whoever steps on it                   */
/* -------------------------------------------------------------------------- */

/**
 * What happens when a character walks onto a light source.
 *
 * - `equip` — better than what they hold, or they hold nothing.
 * - `refresh` — the same source they are already carrying, with a burn to reset. A fresh torch for
 *   a burnt-down one.
 * - `replace` — not an upgrade in the catalogue's terms, but it will *outlast* what is in hand.
 * - `spare` — no use to them. Taken all the same; there is nowhere to put it.
 */
export type PickupOutcome = 'equip' | 'refresh' | 'replace' | 'spare';

/**
 * Whether a source found on the floor will outlast the one already in hand, at no loss of kind.
 *
 * `bestLight` deliberately ranks sources by *what they are* and not by how much is left in the one
 * being carried — a `LightSource` is catalogue data, and "the holder is juggling two half-burnt
 * torches" is a decision the catalogue has no business making for them.
 *
 * At this tile, though, the holder has no decision to make. There is no inventory, so a source that
 * is not taken is destroyed. The question that actually matters is therefore *light from now on*,
 * and by that measure a torch with half a second left loses to the fresh candle it outranks by
 * lifetime. That is the sharpest moment in the whole resource game — a guttering torch and a candle
 * on the floor — and it used to resolve by destroying the candle and dropping the character to the
 * bare radius five ticks later, having just told them the candle was no use to them.
 *
 * Narrow on purpose:
 *
 * - **Same mode.** A Beacon of Hope's last two seconds are still a different *kind* of seeing.
 *   Trading them for four minutes of torch is not an improvement, and the beacon expires to a torch
 *   by itself anyway.
 * - **No smaller radius.** A downgrade in what you can reach stays a downgrade however long it
 *   burns. Only an equal-or-wider source can win on time alone.
 * - **Nothing outlasts a source that never expires.** No remaining time means unlimited, not zero.
 */
function outlasts(
  carried: LightSource,
  carriedRemainingMs: number | undefined,
  found: LightSource,
): boolean {
  if (carriedRemainingMs === undefined) return false;
  if (found.mode !== carried.mode || found.radius < carried.radius) return false;
  return (found.durationMs ?? Infinity) > carriedRemainingMs;
}

/**
 * The decision, with no prose attached: facts here, sentences in `index.ts`. Same split as the
 * simulation's light events, and for the same reason — there is one right answer and several
 * reasonable ways to word it.
 *
 * The same-source case is checked before {@link bestLight} rather than after, and has to be:
 * `bestLight` keeps the incumbent on a tie and the incumbent is the *same catalogue object*, so a
 * second torch reads as strictly better than itself and used to be announced as outshining itself.
 */
export function pickupOutcome(
  carried: LightSource | undefined,
  carriedRemainingMs: number | undefined,
  found: LightSource,
): PickupOutcome {
  if (!carried) return 'equip';
  // A second of what you already hold. Worth taking only if it resets a burn; a spare lantern is
  // exactly as bright as the one in your hand.
  if (carried.id === found.id) return found.durationMs === undefined ? 'spare' : 'refresh';
  if (bestLight([carried, found]) === found) return 'equip';
  if (outlasts(carried, carriedRemainingMs, found)) return 'replace';
  return 'spare';
}

/** Whether a character standing on this tile is standing on this pickup. */
export function standingOn(pickup: GroundPickup, x: number, y: number): boolean {
  return (
    Math.floor(x / TILE_SIZE) === pickup.tx && Math.floor(y / TILE_SIZE) === pickup.ty
  );
}

/**
 * The wire form.
 *
 * `kind: 'item'` was already in `EntityKind` and `EntityView` already carries a position, so a torch
 * on the floor needs no new message type at all: it enters and leaves a client's world through the
 * same `entityEnter`/`entityLeave` that a player does, and therefore through the same visibility
 * gate. A torch you have not lit is a torch you have not been told about.
 *
 * `x`/`y` are world pixels at the centre of the tile, matching `Simulation.viewOf`. `facing` is
 * required by the type and meaningless for an object; south is the neutral value the client already
 * treats as "no particular direction".
 */
export function pickupViewOf(pickup: GroundPickup): EntityView {
  return {
    id: pickup.id,
    kind: 'item',
    name: pickup.source.name,
    // The catalogue id doubles as the sprite key, so adding a source to the catalogue and adding art
    // for it is one decision rather than two, and a missing sprite names the source that lacks one.
    sprite: pickup.source.id,
    x: pickup.tx * TILE_SIZE + TILE_SIZE / 2,
    y: pickup.ty * TILE_SIZE + TILE_SIZE / 2,
    facing: 'south',
  };
}
