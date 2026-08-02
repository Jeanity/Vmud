/**
 * The set of zones this server runs, and the grids they are rendered on.
 *
 * Worldgen normalises room coordinates *per zone*, and independently per vertical level of a zone,
 * so neither shares a coordinate space with anything else. That makes a `Place` — one zone at one
 * level — the unit of collision and rendering, and it makes travelling between zones and travelling
 * between levels the same operation: leave one Place, arrive at a room inside another. Measured on
 * the generated world, 0 of 991 cross-zone exits are geometric neighbours, so there is no case where
 * two zones could share a grid even if we wanted them to.
 *
 * Which zones are in play is data, not code: `world.config.json` lists them, and adding an id there
 * is the whole of "installing" a zone.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OPPOSITE,
  buildZoneTilemap,
  placeKey,
  setDoorTiles,
  type Direction,
  type Door,
  type Place,
  type Room,
  type RoomFlag,
  type RoomId,
  type Sector,
  type TileGrid,
  type Zone,
  type ZoneId,
} from '@mygame/shared';

import {
  applyOverridesToZone,
  applyRoomOverride,
  loadRoomOverrides,
  mergeOverride,
  type RoomOverride,
  type RoomOverrides,
} from './overrides.ts';


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const WORLD_DIR = join(REPO_ROOT, 'data', 'world');
export const CONFIG_PATH = join(REPO_ROOT, 'world.config.json');

/**
 * Whether a lock can hold a door shut yet. **It cannot, and that is a gate on Phase 15, not a design
 * choice.**
 *
 * A locked door is meant to be a question — find the key, pick it, or go round. Today it is none of
 * those, because there is nothing to find: measured on the shipped world, **42 of 156 doors are
 * locked and 0 of them carry a `keyId`**. Worldgen has never harvested key ids, so the data does not
 * even record which object would open one. Nothing can be carried (objects are Phase 15) and nothing
 * can be picked (skills are Phase 19). A lock is therefore not a puzzle missing its piece; it is a
 * wall that reads as a door.
 *
 * The cost of pretending otherwise is not theoretical. IceCrag's approach ends at "Before the Doors
 * of Ice Crag Castle", whose north exit the zone file locks on reset. Honouring it leaves **25 of 219
 * rooms** reachable and seals all 13 aggressive mobs — the entire castle, and every inhabitant worth
 * meeting, behind one flag. Clearing it restores all 219.
 *
 * So locks are *loaded, kept, and ignored*: {@link Door.locked} is still parsed, still stored, still
 * shown by `exits`, and `open` still consults it. This one switch is what decides whether it bites.
 * When Phase 15 gives worldgen key ids and the world objects to hold them, flip it to `true` and the
 * 42 doors become content in the same motion.
 *
 * Typed `boolean` rather than left to infer `false` on purpose: the literal type would make every
 * branch behind it unreachable, and the branches are the thing being kept alive.
 */
export const LOCKS_HOLD: boolean = false;

/**
 * Clears the locks a zone was authored with, and says how many it cleared.
 *
 * Applied once at load, to the zone objects the server then mutates for the rest of the session —
 * the JSON on disk keeps its locks, so this is a policy the engine applies to faithful data rather
 * than a rewrite of it. See {@link LOCKS_HOLD}.
 *
 * Both ends are separate `Door` objects and both are visited: a doorway unlocked from one side only
 * is the asymmetry `doorway()` exists to prevent.
 */
function relaxLocks(zone: Zone): number {
  let cleared = 0;
  for (const room of zone.rooms) {
    for (const exit of Object.values(room.exits)) {
      if (!exit.door?.locked) continue;
      exit.door.locked = false;
      cleared += 1;
    }
  }
  return cleared;
}

export interface SpawnConfig {
  readonly zone: ZoneId;
  /** `null` means "wherever the zone says its own entrance is". */
  readonly room: RoomId | null;
}

export interface WorldConfig {
  readonly zones: readonly ZoneId[];
  readonly spawn: SpawnConfig;
  /**
   * Which loaded zones spawn their inhabitants.
   *
   * Separate from `zones` because they answer different questions: a zone can be walkable without being
   * populated, and today one is. Worldgen harvests population for every matched zone, so this is the
   * switch that decides which of it reaches the world — and the reason it exists is art rather than data.
   * See the comment in `world.config.json`.
   *
   * Absent means **none**, not all. A silent default of "everything" would have a zone start spawning the
   * moment worldgen learned how to harvest it, which is the opposite of a pluggable bit.
   */
  readonly populate: readonly ZoneId[];
}

/** Where a room sits: its zone, and the level of that zone its coordinates are normalised against. */
export function placeOf(room: Room): Place {
  return { zone: room.zone, level: room.pos.z };
}

export function loadZone(id: ZoneId): Zone {
  const path = join(WORLD_DIR, 'zones', `${id}.json`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Zone;
  } catch (cause) {
    throw new Error(
      `could not load zone ${id} from ${path}. Run \`npm run worldgen\` first.`,
      { cause },
    );
  }
}

function malformed(path: string, why: string): never {
  throw new Error(`${path} is malformed: ${why}`);
}

/**
 * Reads and validates the zone list.
 *
 * This fails loudly rather than falling back to a default world: a typo here silently produces a
 * game missing half its map, which is far harder to diagnose than a refusal to start.
 */
export function loadWorldConfig(path: string = CONFIG_PATH): WorldConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `no world configuration at ${path}. It must list the zone ids this server loads, ` +
        `e.g. { "zones": [260, 261], "spawn": { "zone": 260, "room": null } }.`,
      { cause },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${path} is not valid JSON.`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) malformed(path, 'expected a JSON object.');

  const { zones, spawn } = parsed as { zones?: unknown; spawn?: unknown };
  if (!Array.isArray(zones) || zones.length === 0) {
    malformed(path, '"zones" must be a non-empty array of zone ids.');
  }
  const ids: ZoneId[] = [];
  for (const id of zones) {
    if (!Number.isInteger(id)) {
      malformed(path, `"zones" contains ${JSON.stringify(id)}, which is not an integer zone id.`);
    }
    if (!ids.includes(id as ZoneId)) ids.push(id as ZoneId);
  }

  const populate = readZoneList(path, (parsed as { populate?: unknown }).populate, '"populate"', ids);

  const first = ids[0];
  if (first === undefined) malformed(path, '"zones" must be a non-empty array of zone ids.');
  if (spawn === undefined) return { zones: ids, spawn: { zone: first, room: null }, populate };

  if (typeof spawn !== 'object' || spawn === null) {
    malformed(path, '"spawn" must be an object with "zone" and "room".');
  }
  const { zone: spawnZone, room: spawnRoom } = spawn as { zone?: unknown; room?: unknown };
  if (!Number.isInteger(spawnZone)) malformed(path, '"spawn.zone" must be an integer zone id.');
  if (!ids.includes(spawnZone as ZoneId)) {
    malformed(path, `"spawn.zone" is ${String(spawnZone)}, which is not listed in "zones".`);
  }
  if (spawnRoom !== null && spawnRoom !== undefined && !Number.isInteger(spawnRoom)) {
    malformed(path, '"spawn.room" must be an integer room id, or null for the zone\'s entrance.');
  }

  return {
    zones: ids,
    spawn: { zone: spawnZone as ZoneId, room: (spawnRoom ?? null) as RoomId | null },
    populate,
  };
}

/**
 * Reads a list of zone ids, refusing one that names a zone this server does not load.
 *
 * That last check is the useful half: populating a zone that is not loaded is a typo with no symptom —
 * nothing spawns and nothing complains — and it is exactly the mistake trimming the `zones` list invites.
 */
function readZoneList(path: string, raw: unknown, where: string, loaded: readonly ZoneId[]): ZoneId[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) malformed(path, `${where} must be an array of zone ids.`);
  const out: ZoneId[] = [];
  for (const id of raw as unknown[]) {
    if (!Number.isInteger(id)) {
      malformed(path, `${where} contains ${JSON.stringify(id)}, which is not an integer zone id.`);
    }
    if (!loaded.includes(id as ZoneId)) {
      malformed(path, `${where} lists zone ${String(id)}, which is not in "zones".`);
    }
    if (!out.includes(id as ZoneId)) out.push(id as ZoneId);
  }
  return out;
}

export interface LocatedRoom {
  readonly room: Room;
  readonly place: Place;
}

/** One end of a doorway: the exit it hangs on, and where that exit is. */
export interface DoorSide {
  readonly roomId: RoomId;
  readonly dir: Direction;
  readonly place: Place;
  readonly door: Door;
}

/**
 * A doorway, as both ends of it.
 *
 * `near` is the side the character is standing on. `far` is the matching reverse exit when there is
 * one, and it is what makes a two-way door behave like one object: opening it has to clear the flag
 * on both sides, or walking through and looking back shows a door that shut itself.
 *
 * `near.door` may be the *far* side's `Door` object. On 5 exits in the shipped world one room
 * declares a door and the room facing it declares a plain exit, and both sides share one carved strip
 * of tiles — so the side without the door must still be refused, or that doorway is a wall from one
 * room and an open corridor from the other.
 */
export interface Doorway {
  readonly near: DoorSide;
  readonly far?: DoorSide;
}

export class GameWorld {
  private readonly zonesById = new Map<ZoneId, Zone>();
  private readonly zoneList: Zone[] = [];
  /**
   * One grid per Place, built on first use. A four-level zone needs four grids, and most of them
   * are never walked on in a given session.
   */
  private readonly grids = new Map<string, TileGrid>();
  /**
   * Room ids are the MUD's own ids and are unique across the entire world, so one flat index spans
   * every loaded zone. This is what makes an exit's destination resolvable without knowing, or
   * caring, which zone it belongs to.
   */
  private readonly index = new Map<RoomId, LocatedRoom>();
  private readonly levels = new Map<ZoneId, readonly number[]>();
  private readonly places: Place[] = [];
  private readonly spawn: SpawnConfig;
  private directory: Map<RoomId, ZoneId> | undefined;
  /** Zone names for every zone that exists, loaded or not. See {@link zoneName}. */
  private zoneNames: Map<ZoneId, string> | undefined;
  /**
   * Zones read from disk for *reading* rather than for playing. See {@link referenceRoom}.
   *
   * Kept apart from `zonesById` on purpose: nothing in here is indexed, gridded, populated, or
   * reachable by any path a player can take. It exists so an author can read across a zone boundary.
   */
  private readonly reference = new Map<ZoneId, Zone>();

  /** Which zones spawn inhabitants. See {@link WorldConfig.populate}. */
  readonly populate: readonly ZoneId[];

  /** How many authored locks were cleared at load. See {@link LOCKS_HOLD}. */
  readonly locksRelaxed: number;

  /**
   * Hand-authored room content, composed over the generated zones at construction.
   *
   * Held rather than discarded because the admin panel edits *this*, not the zone files — a write
   * merges into this map, saves it, and applies the patch to the live room in one motion. See
   * `overrides.ts` for why authoring cannot live in the generated data.
   */
  readonly overrides: RoomOverrides;

  /** How many rooms carry authored content. Reported at boot so a lost overlay is visible. */
  readonly roomsAuthored: number;

  /**
   * What each authored room said *before* anybody wrote on it.
   *
   * The whole of "revert", and the reason it cannot fail. The alternative — re-reading the zone file
   * when an operator asks to undo — needs the disk at the worst possible moment, invents a failure
   * mode with no good answer ("the override is gone but the running room still shows the old text"),
   * and cannot be unit-tested without a fixture on disk. Snapshotting instead costs four fields per
   * *edited* room, which for a session's worth of authoring is nothing.
   *
   * Filled lazily, immediately before a room is first changed: at boot for the rooms the overlay
   * already covers, and in {@link authorRoom} for one being edited now. A room nobody has touched has
   * no entry, which is exactly right — there is nothing to restore it to but itself.
   *
   * **Not a {@link RoomOverride}**, though it holds the same four fields, because a patch cannot say
   * "absent". In a patch `description: undefined` means *leave it alone*; here it has to mean *this
   * room had no prose*, and restoring it must remove the field rather than set it to `''`. Most rooms
   * are in that state — 5,889 of 46,508 carry prose — so it is the ordinary case, not a corner.
   */
  private readonly pristine = new Map<
    RoomId,
    {
      readonly name: string;
      readonly description: string | undefined;
      readonly sector: Sector;
      readonly flags: readonly RoomFlag[];
    }
  >();

  constructor(
    zones: readonly Zone[],
    spawn: SpawnConfig,
    populate: readonly ZoneId[] = [],
    overrides: RoomOverrides = new Map(),
  ) {
    this.populate = populate;
    this.spawn = spawn;
    this.overrides = overrides;
    let relaxed = 0;
    let authored = 0;
    for (const zone of zones) {
      if (this.zonesById.has(zone.id)) continue;
      this.zonesById.set(zone.id, zone);
      this.zoneList.push(zone);
      // Before the grids are built from it: `buildZoneTilemap` reads `closed`, so a later unlock would
      // leave a cached grid disagreeing with the door it was carved from.
      if (!LOCKS_HOLD) relaxed += relaxLocks(zone);
      // Also before the grids: an override can change a room's sector, and the tilemap is carved from
      // sectors. Composing after the fact would leave the map showing the terrain the harvest had.
      // The snapshot is taken first, inside, so `revertRoom` can undo what is about to be applied.
      authored += applyOverridesToZone(zone, overrides, (room) => this.remember(room));

      const levels = new Set<number>();
      for (const room of zone.rooms) {
        levels.add(room.pos.z);
        this.index.set(room.id, { room, place: placeOf(room) });
      }
      const sorted = [...levels].sort((a, b) => a - b);
      this.levels.set(zone.id, sorted);
      for (const level of sorted) this.places.push({ zone: zone.id, level });
    }
    this.locksRelaxed = relaxed;
    this.roomsAuthored = authored;
  }

  /** Loads every zone named in the config, with the authored overlay composed on top. */
  static load(configPath: string = CONFIG_PATH): GameWorld {
    const config = loadWorldConfig(configPath);
    return new GameWorld(
      config.zones.map((id) => loadZone(id)),
      config.spawn,
      config.populate,
      loadRoomOverrides(),
    );
  }

  zone(id: ZoneId): Zone | undefined {
    return this.zonesById.get(id);
  }

  allZones(): readonly Zone[] {
    return this.zoneList;
  }

  /** Levels of a zone that actually contain rooms, ascending. */
  levelsOf(zoneId: ZoneId): readonly number[] {
    return this.levels.get(zoneId) ?? [];
  }

  allPlaces(): readonly Place[] {
    return this.places;
  }

  grid(place: Place): TileGrid | undefined {
    const zone = this.zonesById.get(place.zone);
    if (!zone || !this.levelsOf(place.zone).includes(place.level)) return undefined;
    const key = placeKey(place);
    const cached = this.grids.get(key);
    if (cached) return cached;
    const built = buildZoneTilemap(zone, place.level);
    this.grids.set(key, built);
    return built;
  }

  locate(roomId: RoomId): LocatedRoom | undefined {
    return this.index.get(roomId);
  }

  /**
   * Writes authored content onto a room, live.
   *
   * The one entry point for A5's editor, and it does three things that must happen together or not
   * at all: merge the patch into {@link overrides} so it survives a restart, apply it to the room the
   * simulation is holding so it takes effect without one, and **drop the cached tilemap when the
   * terrain changed** — the grid is carved from sectors, so a cached one would keep rendering, and
   * keep charging movement for, the terrain the harvest had.
   *
   * Persisting is the caller's job — it is I/O, and this class does none. So is deciding whether the
   * terrain moved: see {@link dropGrid}, which the caller invokes after comparing the room's sector
   * across the whole operation rather than across this one call.
   */
  authorRoom(roomId: RoomId, patch: RoomOverride, now: string): { room: Room; place: Place } | undefined {
    const located = this.index.get(roomId);
    if (!located) return undefined;
    // **An empty patch must not create an entry.** A full revert arrives here with nothing left to
    // apply, and merging it anyway would stamp a timestamp onto a room with no authored fields —
    // leaving `{"5753": {"at": …}}` behind, which reads as authored everywhere it is checked. The
    // room would wear the editor's mark forever for having once been edited and then un-edited.
    if (Object.keys(patch).length > 0) {
      this.remember(located.room);
      applyRoomOverride(located.room, mergeOverride(this.overrides, roomId, patch, now));
    }
    return { room: located.room, place: located.place };
  }

  /**
   * Drops named authored fields from a room and puts the generated values back.
   *
   * Restores from {@link pristine} rather than from disk, which is what makes it total: there is no
   * "could not re-read the zone" branch, because the values were kept from before the first edit.
   * Fields not named are left authored — reverting the prose of a room whose name you also wrote
   * should not silently rename it back.
   */
  revertRoom(roomId: RoomId, fields: readonly string[]): { room: Room; place: Place } | undefined {
    const located = this.index.get(roomId);
    if (!located) return undefined;
    const existing = this.overrides.get(roomId);
    if (!existing) return { room: located.room, place: located.place };

    const kept = { ...existing };
    for (const field of fields) delete (kept as Record<string, unknown>)[field];
    // An override of nothing but a timestamp is not an override. See `authorRoom`.
    if (Object.keys(kept).filter((k) => k !== 'at').length === 0) this.overrides.delete(roomId);
    else this.overrides.set(roomId, kept);

    const original = this.pristine.get(roomId);
    if (original) {
      // Everything back to as-generated, then whatever override survived on top. Wholesale rather
      // than per-field: one code path regardless of which fields were dropped.
      const mutable = located.room as {
        name: string;
        description?: string;
        sector: Sector;
        flags?: readonly RoomFlag[];
      };
      mutable.name = original.name;
      // **Deleted, not blanked.** A room the harvest gave no prose must go back to having none: `''`
      // would read as "deliberately silent" and the API would report an empty string where it should
      // report null. This is the one restore a patch cannot express, which is why it is written out.
      if (original.description === undefined) delete mutable.description;
      else mutable.description = original.description;
      mutable.sector = original.sector;
      mutable.flags = [...original.flags];

      const surviving = this.overrides.get(roomId);
      if (surviving) applyRoomOverride(located.room, surviving);
    }
    return { room: located.room, place: located.place };
  }

  /** Snapshots a room's authorable fields, once, before the first thing is written over them. */
  private remember(room: Room): void {
    if (this.pristine.has(room.id)) return;
    this.pristine.set(room.id, {
      name: room.name,
      description: room.description,
      sector: room.sector,
      flags: room.flags ?? [],
    });
  }

  /**
   * Throws away a Place's cached tilemap, so the next reader rebuilds it from the rooms as they
   * stand now.
   *
   * **Called when a sector changes, and the caller decides that by comparing the room's terrain
   * before and after — not by looking at what the patch asked for.** The distinction cost a live
   * desync to find: reverting an authored sector restores the room's terrain without *setting* a
   * sector, so a patch-shaped test says "no terrain change" while the terrain has in fact changed
   * back. The grid kept the water. The clients, correctly resynced, kept the ice, and the server
   * would then have refused every step across a floor the player could see was solid.
   */
  dropGrid(place: Place): void {
    this.grids.delete(placeKey(place));
  }

  /**
   * The doorway leading `dir` out of `roomId`, from both ends, or nothing if there is no door there.
   *
   * The single answer to "is there a door in the way", so that `stepRoom`, `open` and `close` cannot
   * drift apart on the asymmetric cases. It deliberately looks at the reverse exit too: a door
   * declared on only one side still carved one shared strip of tiles, and geometry has no notion of
   * which room you happen to be standing in.
   */
  doorway(roomId: RoomId, dir: Direction): Doorway | undefined {
    const here = this.index.get(roomId);
    const exit = here?.room.exits[dir];
    if (!here || !exit) return undefined;

    const there = this.index.get(exit.to);
    // Only a reverse exit that actually links back is the same doorway. A one-way door — 123 of them
    // in the shipped world — has no far side to keep in step, and a reverse exit pointing somewhere
    // else is a different door that merely happens to face this way.
    const back = there?.room.exits[OPPOSITE[dir]];
    const far: DoorSide | undefined =
      there && back?.door && back.to === roomId
        ? { roomId: exit.to, dir: OPPOSITE[dir], place: there.place, door: back.door }
        : undefined;

    const door = exit.door ?? far?.door;
    if (!door) return undefined;
    return {
      near: { roomId, dir, place: here.place, door },
      ...(far ? { far } : {}),
    };
  }

  /**
   * Opens or shuts a doorway, both ends of it, and patches every grid holding its tiles.
   *
   * Returns the sides that actually moved, each with the tile indices its grid changed — which is
   * what the caller broadcasts, and what makes shutting a door that is already shut cost nothing.
   * Both ends are set even when only one declares a `Door`, because both ends were carved from the
   * same cells and a half-open door is a tile the two rooms disagree about.
   *
   * A grid is patched only if it has already been built. One that has not been walked on yet will be
   * built from this same zone data on first use, and this has already written the state into it.
   */
  setDoorClosed(doorway: Doorway, closed: boolean): { side: DoorSide; tiles: number[] }[] {
    const changed: { side: DoorSide; tiles: number[] }[] = [];
    for (const side of [doorway.near, doorway.far]) {
      if (!side) continue;
      side.door.closed = closed;
      const grid = this.grids.get(placeKey(side.place));
      const tiles = grid ? setDoorTiles(grid, side.roomId, side.dir, closed) : [];
      changed.push({ side, tiles });
    }
    return changed;
  }

  /**
   * Which zone owns a room, answering for zones this server has *not* loaded too.
   *
   * The generated index carries no room-to-zone mapping, so the only way to name the zone behind an
   * exit leading out of the configured world is to scan the zone files. That happens at most once
   * per process, and only when a player actually walks into such an exit, so start-up stays
   * proportional to the zones in play rather than to the 327 that exist.
   */
  zoneOf(roomId: RoomId): ZoneId | undefined {
    const loaded = this.index.get(roomId);
    if (loaded) return loaded.place.zone;
    this.directory ??= readRoomDirectory();
    return this.directory.get(roomId);
  }

  /**
   * A room from a zone this server does not run, **for reading only**.
   *
   * The generated world holds all 327 zones on disk; `world.config.json` decides which four are
   * *played*. Those are different questions, and this answers the second one: an authoring tool
   * standing at the top of IceCrag's stairs should be able to read what is at the bottom, in zone
   * 219, even though nothing there is simulated. Owner's reason, 2026-08-02 — a description written
   * without the neighbouring prose is written blind, and that is as true across a zone boundary as
   * within one.
   *
   * **Deliberately not `locate`, and deliberately not added to the index.** A room reached this way
   * has no Place, no tilemap, no population and no business being walked into; conflating the two
   * would let a teleport or an exit resolve into an unloaded zone and put a player somewhere the
   * simulation cannot tick. The name says reference, and the return type is a bare `Room` with no
   * `place` beside it, so a caller cannot use it as a destination by accident.
   *
   * Caches the whole zone it came from, which is the right granularity: authoring walks a
   * neighbourhood, so the next lookup is nearly always in the same file. Reference zones are never
   * mutated and never composed with overrides — they are not the world, they are notes about it.
   */
  referenceRoom(roomId: RoomId): Room | undefined {
    if (this.index.has(roomId)) return this.index.get(roomId)!.room;
    const zoneId = this.zoneOf(roomId);
    if (zoneId === undefined || this.zonesById.has(zoneId)) return undefined;

    let zone = this.reference.get(zoneId);
    if (!zone) {
      try {
        zone = loadZone(zoneId);
      } catch {
        return undefined;
      }
      this.reference.set(zoneId, zone);
    }
    return zone.rooms.find((room) => room.id === roomId);
  }

  /**
   * What a zone is called, **including one this server has not loaded**.
   *
   * Read from the generated `index.json`, which names all 327 of them. The reason it exists is that
   * `(not loaded)` is a true answer and a useless one: IceCrag's stairs go *down* into zone 219,
   * "IceCrag Castle - Lower Level", which is a different zone file and not in `world.config.json` —
   * so every up and down exit off the loaded levels reported nothing at all. Naming the zone turns a
   * dead end back into a fact about the world, which is what an author standing at the top of those
   * stairs actually needs.
   *
   * Cached on first use, like the room directory, and for the same reason: it is one small file, read
   * at most once per process and only when something asks about a room off the map.
   */
  zoneName(id: ZoneId): string | undefined {
    if (this.zoneNames === undefined) {
      this.zoneNames = new Map();
      try {
        const index = JSON.parse(readFileSync(join(WORLD_DIR, 'index.json'), 'utf8')) as {
          zones?: readonly { id: ZoneId; name: string }[];
        };
        for (const zone of index.zones ?? []) this.zoneNames.set(zone.id, zone.name);
      } catch {
        // No index is survivable — every caller falls back to the bare id, which is still a fact.
      }
    }
    return this.zonesById.get(id)?.name ?? this.zoneNames.get(id);
  }

  /**
   * Where a new character starts: the configured room, else the spawn zone's own entrance.
   *
   * A configured room that does not resolve is an error, not something to paper over. Silently
   * landing on `zone.rooms[0]` — whichever room the source data happened to list first, on whichever
   * level — is exactly the "typo produces a subtly wrong world" failure this module exists to
   * prevent, and a transposed digit in a six-digit MUD room id is the likeliest way to make one.
   */
  spawnRoom(): Room {
    const zone = this.zonesById.get(this.spawn.zone);
    if (!zone) {
      throw new Error(`spawn zone ${this.spawn.zone} is not among the loaded zones`);
    }

    const configured = this.spawn.room;
    if (configured !== null) {
      return this.resolveSpawn(configured, zone, '"spawn.room"');
    }
    if (zone.entryRoom !== undefined) {
      return this.resolveSpawn(zone.entryRoom, zone, `zone ${zone.id}'s entryRoom`);
    }

    // Only when the zone declares no entrance at all is picking a room a judgement call rather than
    // a silent override of something the operator asked for.
    const fallback = zone.rooms[0];
    if (!fallback) throw new Error(`zone ${zone.id} has no rooms`);
    return fallback;
  }

  /** Resolves a spawn room id within `zone`, naming where it actually lives when it is elsewhere. */
  private resolveSpawn(roomId: RoomId, zone: Zone, what: string): Room {
    const found = this.index.get(roomId);
    if (found && found.place.zone === zone.id) return found.room;

    const elsewhere = found?.place.zone ?? this.zoneOf(roomId);
    throw new Error(
      elsewhere === undefined
        ? `${what} is room ${roomId}, which does not exist in any zone. ` +
          `Spawn zone ${zone.id} "${zone.name}" has ${zone.rooms.length} rooms.`
        : `${what} is room ${roomId}, which belongs to zone ${elsewhere}, not spawn zone ` +
          `${zone.id} "${zone.name}".`,
    );
  }
}

function readRoomDirectory(): Map<RoomId, ZoneId> {
  const directory = new Map<RoomId, ZoneId>();
  const dir = join(WORLD_DIR, 'zones');
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return directory;
  }
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const zone = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Zone;
      if (!Array.isArray(zone.rooms)) continue;
      for (const room of zone.rooms) directory.set(room.id, zone.id);
    } catch {
      // One unreadable zone file must not cost us the rest of the directory; the worst case is that
      // a single exit is described as unmapped instead of naming its zone.
    }
  }
  return directory;
}
