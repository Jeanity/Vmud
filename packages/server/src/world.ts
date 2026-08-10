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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_ROOM_BASE,
  AUTHORED_ZONE_BASE,
  OPPOSITE,
  boundsOf,
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
  authorsAnything,
  loadRoomOverrides,
  mergeOverride,
  type RoomOverride,
  type RoomOverrides,
} from './overrides.ts';
import { applyLinks, loadLinks, type LinkDef } from './links.ts';
import {
  applyDeletions,
  attachAuthoredRoom,
  composeAuthoredRooms,
  extentOf,
  loadAuthoredRooms,
  narrowsExtent,
  placementRefusal,
  removalRefusal,
  resolveExits,
  sameExtent,
  takeAuthoredRoomId,
  widensExtent,
  type AuthoredRoomStore,
  type Extent,
} from './room-authoring.ts';
import { AUTHORED_ZONES_FILE, loadAuthoredZones, type AuthoredZoneStore } from './zone-authoring.ts';


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

/** Whether worldgen has built a zone file for this id — the routing fact `GameWorld.load` needs. */
export function builtZoneFileExists(id: ZoneId): boolean {
  return existsSync(join(WORLD_DIR, 'zones', `${id}.json`));
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

/**
 * The `Zone` record an **authored** zone boots from — A8d. A shell on purpose: its rooms live in
 * `rooms-authored.json` and are attached by `composeAuthoredRooms` exactly as created rooms attach to
 * a harvested zone, with the origin exception standing in for the neighbour rule on the first one.
 * The bounds are zeroed rather than computed because nothing at runtime reads `zone.bounds` — grids
 * are sized per level from the rooms themselves (`tilemap.ts` says why in as many words).
 *
 * **Refuses loudly** when the config names an authored id the overlay does not hold — `loadZone`'s
 * own posture, because a typo silently skipped is a world missing a map with nothing to say why.
 */
export function authoredZoneShell(id: ZoneId, store: AuthoredZoneStore): Zone {
  const authored = store.zones.get(id);
  if (!authored) {
    throw new Error(
      `world.config.json names zone ${id}, which is in the authored range (${AUTHORED_ZONE_BASE}+) ` +
        `but not in ${AUTHORED_ZONES_FILE}. Remove the id from the config, or restore the overlay.`,
    );
  }
  return { id, name: authored.name, rooms: [], bounds: boundsOf([]) };
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
   * Rooms that were **created** here, as opposed to edited. A8, and a different overlay entirely —
   * see `room-authoring.ts` for the four rules that differ.
   *
   * Held for the same reason {@link overrides} is: the panel writes *this*, not the zone files, and a
   * creation adds to this store, saves it, and hangs the room in the live zone in one motion.
   */
  readonly authoredRooms: AuthoredRoomStore;

  /**
   * Zones that were **created** here — A8d, the seventh overlay. Held for the sibling reason: the
   * panel's create route writes this store and saves it, and `load` is what reads it back into a
   * bootable `Zone` when the config finally names the id.
   */
  readonly authoredZones: AuthoredZoneStore;

  /**
   * What the overlay asked for and could not have, said once at boot.
   *
   * Empty in every ordinary session. It fills when a hand-edited record puts a room outside its
   * level's extent, on a cell somebody else took, or against a neighbour that has since moved — all
   * three of which are silent otherwise, and the last of which is what storing an exit's far end
   * exists to make visible.
   */
  readonly authoredRefusals: readonly { readonly id: RoomId; readonly why: string }[];

  /**
   * Places whose grid is not the one the overlay was last written against — A8 slice 3.
   *
   * Every saved `seen` for these is indexed against a grid of a different size and is therefore
   * **wrong, not merely incomplete**. The caller must clear them before anybody connects; see
   * `index.ts`, which is where the store lives. Empty in every ordinary session.
   */
  readonly staleExtents: readonly Place[];

  /** Authored crossings carved into the composed world — see `links.ts`. */
  readonly linksApplied: number;

  /** Why an authored link did nothing: a room in an unloaded zone, or a direction already taken. */
  readonly linkRefusals: readonly string[];

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
    authoredRooms: AuthoredRoomStore = { rooms: new Map(), next: AUTHORED_ROOM_BASE, deleted: new Set(), extents: new Map() },
    authoredZones: AuthoredZoneStore = { zones: new Map(), next: AUTHORED_ZONE_BASE as ZoneId },
    links: readonly LinkDef[] = [],
  ) {
    this.authoredZones = authoredZones;
    this.populate = populate;
    this.spawn = spawn;
    this.overrides = overrides;
    this.authoredRooms = authoredRooms;
    const refusals: { id: RoomId; why: string }[] = [];
    let relaxed = 0;
    let authored = 0;
    for (const zone of zones) {
      if (this.zonesById.has(zone.id)) continue;
      this.zonesById.set(zone.id, zone);
      this.zoneList.push(zone);
      // Before the grids are built from it: `buildZoneTilemap` reads `closed`, so a later unlock would
      // leave a cached grid disagreeing with the door it was carved from.
      // **Authored zones keep their locks** — Phase 26. `LOCKS_HOLD`'s argument was never "locks are
      // a bad mechanic"; it was that the *harvest* has 42 locked doors and zero key ids, so honouring
      // them walls off content nobody can open (IceCrag loses 194 of 219 rooms). An authored lock is
      // the opposite case by construction: we wrote the door, so we wrote the key, and the vault
      // under Velen is *supposed* to be shut. The flag stays false for the harvest until worldgen
      // learns to read key ids; ours are already content.
      if (!LOCKS_HOLD && zone.id < AUTHORED_ZONE_BASE) relaxed += relaxLocks(zone);
      // Also before the grids: an override can change a room's sector, and the tilemap is carved from
      // sectors. Composing after the fact would leave the map showing the terrain the harvest had.
      // The snapshot is taken first, inside, so `revertRoom` can undo what is about to be applied.
      authored += applyOverridesToZone(zone, overrides, (room) => this.remember(room));
      // **Deletions before additions**, because both are checked against the level's extent and the
      // extent has to be the one the world will actually have. Composing first would let a room be
      // infilled against a boundary that a tombstone in the same file was about to move.
      const cleared = applyDeletions(zone, authoredRooms.deleted);
      refusals.push(...cleared.refused);
      if (cleared.removed.length > 0) {
        console.log(
          `[world] zone ${zone.id}: ${cleared.removed.length} room(s) removed by the authored overlay, ` +
            `${cleared.dangling} exit(s) now lead nowhere`,
        );
      }
      // **After the patches and before the index**, which is `DESIGN-zone-geometry.md` decision 5's
      // order exactly: the harvest, then what was written over it, then whole records appended. A
      // created room is not patched by `rooms.json` and never will be — an edit to one is a re-draft
      // of its own record, which `reauthorRoom` does, so the two overlays cannot both claim a room.
      const composed = composeAuthoredRooms(zone, authoredRooms.rooms, authoredRooms.deleted);
      refusals.push(...composed.refused);

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
    this.authoredRefusals = refusals;

    // **After every zone, because a link's two ends are in two zones by definition** — carving one
    // inside the loop above would ask for a room whose zone has not been read yet. See `links.ts`.
    const linked = applyLinks((id) => this.index.get(id)?.room, links);
    this.linksApplied = linked.applied;
    this.linkRefusals = linked.refused;

    // **A8 slice 3: has any Place's grid moved since this overlay was last written?**
    //
    // Asked here, once, against the world as finally composed — after deletions, additions and
    // overrides have all had their say — because that is the grid the next `buildZoneTilemap` will
    // produce and therefore the one every saved `seen` is about to be indexed against.
    //
    // Only Places the overlay *touches* are considered. A world nobody has authored has no stored
    // extents, nothing to compare, and nothing to clear — which is what keeps an ordinary boot from
    // writing to a git-tracked file. A Place the overlay touches with **no** stored extent is treated
    // as stale rather than as fine: that state can only come from a hand edit, and assuming the best
    // there is exactly the silent shift decision 2 exists to prevent.
    const stale: Place[] = [];
    for (const place of this.places) {
      const key = placeKey(place);
      const touched = this.overlayTouches(place);
      if (!touched && !authoredRooms.extents.has(key)) continue;
      const now = extentOf(this.zonesById.get(place.zone)?.rooms ?? [], place.level);
      if (!sameExtent(now, authoredRooms.extents.get(key))) stale.push(place);
    }
    this.staleExtents = stale;
  }

  /** Whether the authored overlay has anything to say about this Place. See the constructor. */
  private overlayTouches(place: Place): boolean {
    for (const authored of this.authoredRooms.rooms.values()) {
      if (authored.room.zone === place.zone && authored.room.pos.z === place.level) return true;
    }
    // A tombstone is checked against the zone file rather than the live world, because the room it
    // names is by definition no longer in the live world to be asked about.
    for (const id of this.authoredRooms.deleted) {
      const zone = this.zonesById.get(place.zone);
      if (!zone) continue;
      // The room is gone from `zone.rooms`; the only surviving fact is that this zone owned it.
      if (this.zoneOf(id) === place.zone) return true;
    }
    return false;
  }

  /** The Place's extent as it stands now, for the overlay to remember it by. */
  extentNow(place: Place): Extent | undefined {
    return extentOf(this.zonesById.get(place.zone)?.rooms ?? [], place.level);
  }

  /**
   * Records a Place's current extent in the overlay, so the next boot compares against this grid.
   *
   * Called after the invalidation rather than before it, and by the caller rather than here: writing
   * the file is I/O and this class does none, and recording an extent whose `seen` clearing then
   * failed would leave the maps shifted with nothing left to notice it.
   */
  recordExtent(place: Place): void {
    const extent = this.extentNow(place);
    if (extent) this.authoredRooms.extents.set(placeKey(place), extent);
    else this.authoredRooms.extents.delete(placeKey(place));
  }

  /** Loads every zone named in the config, with all four authored overlays composed on top. */
  static load(configPath: string = CONFIG_PATH): GameWorld {
    const config = loadWorldConfig(configPath);
    const authoredZones = loadAuthoredZones();
    return new GameWorld(
      // An authored id resolves **file first** — Phase 22: a committed zone that worldgen built
      // (`data/authored/` merged into `data/world/zones/`) loads exactly as a harvested one does,
      // and only an id with no built file falls back to A8d's shell-and-overlay. The order matters:
      // the shell throws on ids it does not hold, and a committed zone is legitimately absent from
      // the runtime overlay for ever.
      config.zones.map((id) =>
        id >= AUTHORED_ZONE_BASE && !builtZoneFileExists(id) ? authoredZoneShell(id, authoredZones) : loadZone(id),
      ),
      config.spawn,
      config.populate,
      loadRoomOverrides(),
      loadAuthoredRooms(),
      authoredZones,
      loadLinks(),
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
    if (!authorsAnything(kept)) this.overrides.delete(roomId);
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

  /**
   * Builds a room and hangs it in its zone, live — A8's one write.
   *
   * Everything is checked before anything is joined, so a refusal leaves the world exactly as it was:
   * a half-added room would be in the index and off the grid, which is a room a player can be told
   * about and cannot walk to. The three questions are asked in the order that makes each answer
   * meaningful — the zone must be loaded before its extent means anything, the cell must be free
   * before the neighbours are worth looking at, and the exits must all resolve before one of them is
   * written.
   *
   * **The id comes from the store's counter, and only once the room is certain to be built.** An
   * allocation spent on a refused draft would leave a gap in the numbering, which costs nothing, but
   * it would also advance a counter for a room that never existed — and this is the one number the
   * whole overlay's safety rests on.
   *
   * Persisting is the caller's job, as it is for {@link authorRoom}: this class does no I/O. Dropping
   * the Place's grid is *not* — the room is on it, and a cached tilemap carved before it existed has
   * no floor where the room stands.
   */
  createRoom(
    zoneId: ZoneId,
    draft: { readonly room: Room; readonly dirs: readonly Direction[] },
    meta: { readonly at: string; readonly by?: string; readonly brief?: string },
  ): { room: Room; place: Place; extentChanged: boolean } | { error: string } {
    const zone = this.zonesById.get(zoneId);
    if (!zone) return { error: `zone ${zoneId} is not loaded` };

    const pos = draft.room.pos;
    // **Asked before the room is added, and it is the whole of slice 3.** Building against the edge
    // moves the extent, which resizes the grid, which shifts every saved tile index for this Place.
    // The room is still built — what changes is that the caller has to clear the maps and say so.
    const extentChanged = widensExtent(zone.rooms, pos);
    const refusal = placementRefusal(zone.rooms, pos);
    if (refusal) return { error: refusal };

    const resolved = resolveExits(zone.rooms, pos, draft.dirs, (id) => this.destinationLives(id));
    if ('error' in resolved) return resolved;

    const id = takeAuthoredRoomId(this.authoredRooms);
    const room: Room = {
      ...draft.room,
      id,
      zone: zoneId,
      exits: Object.fromEntries(Object.entries(resolved.exits).map(([dir, to]) => [dir, { to }])),
    };

    // The store holds the room the zone holds, not a copy of it. One object means a later re-draft
    // cannot leave the file and the running world disagreeing, and it means a reverse exit written
    // by a room authored *next* to this one is part of the record rather than derived twice.
    this.authoredRooms.rooms.set(id, {
      room,
      at: meta.at,
      ...(meta.by ? { by: meta.by } : {}),
      ...(meta.brief ? { brief: meta.brief } : {}),
    });
    attachAuthoredRoom(zone, room);

    const place = placeOf(room);
    this.index.set(id, { room, place });
    this.dropGrid(place);
    return { room, place, extentChanged };
  }

  /**
   * Rewrites a created room's own record, which is what an edit to one *is*.
   *
   * A6b's dispatch, in its second home: a created thing has no harvest underneath it, so there is
   * nothing to patch and `rooms.json` must never gain an entry for it — two overlays claiming one
   * room is a state where the answer depends on load order. The id range is the discriminator, here
   * as on disk.
   *
   * Only content, never geometry: position and exits are what {@link createRoom} settled against the
   * zone's extent and its neighbours, and moving a room is a delete and an add against the same id —
   * `DESIGN-zone-geometry.md`'s own note on what it does not decide.
   */
  reauthorRoom(roomId: RoomId, patch: RoomOverride, now: string): { room: Room; place: Place } | undefined {
    const located = this.index.get(roomId);
    const authored = this.authoredRooms.rooms.get(roomId);
    if (!located || !authored) return undefined;
    applyRoomOverride(located.room, patch);
    this.authoredRooms.rooms.set(roomId, {
      ...authored,
      at: now,
      ...(patch.by !== undefined ? { by: patch.by } : {}),
      ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
    });
    return { room: located.room, place: located.place };
  }

  /** Whether this room was created here rather than harvested. The one question the API dispatches on. */
  isAuthoredRoom(roomId: RoomId): boolean {
    return this.authoredRooms.rooms.has(roomId);
  }

  /**
   * Whether an exit's destination is still somewhere, as opposed to debris a delete left behind.
   *
   * **Three states, not two, and conflating the outer pair is the bug this exists to avoid.** A room
   * in the live index is obviously there. A room in a zone this server does not *run* is also there —
   * every one of the 991 cross-zone exits leads to one, and treating those as debris would let a new
   * room quietly steal a portal. What is left — an id belonging to a zone we did load, that is not in
   * the index — is a room that was deleted, and an exit still pointing at it is dead.
   *
   * `zoneOf` answers the middle case from the generated directory, which spans all 327 zones and is
   * read at most once per process. It cannot be used alone: a tombstoned room is still in its zone
   * *file*, so the directory says it exists long after the world stopped agreeing.
   */
  private destinationLives(id: RoomId): boolean {
    if (this.index.has(id)) return true;
    // **What we took out beats what the directory remembers, and the order is not cosmetic.** A
    // tombstoned room is still in its zone *file* — that is the whole point of a tombstone — so
    // `zoneOf` finds it there long after the world stopped agreeing, and asking the disk first would
    // report a room we deleted as alive and well in whichever zone happens to own that number.
    if (this.authoredRooms.deleted.has(id)) return false;
    const zone = this.zoneOf(id);
    return zone !== undefined && !this.zonesById.has(zone);
  }

  /**
   * Takes a room out of the world — A8 slice 2.
   *
   * **Two deletions wearing one verb, and the difference is which file remembers.** A created room is
   * removed by deleting its record, because the record *is* the room. A harvested one is removed by
   * writing a tombstone, because the zone file is generated and the next `npm run worldgen` would put
   * it back. The id range decides which, here as everywhere else in this pair of overlays.
   *
   * **What happens to exits pointing at it is the interesting half, and it is deliberately not
   * uniform.** An exit that exists *because of us* is removed: every reverse link a created room's
   * declaration caused, and every declared exit on another created room. An exit the harvest wrote is
   * left dangling and reported — decision 3's measured call, since the shipped world already has 5 of
   * those and the engine simply does not walk them. Rewriting a neighbour the operator was not
   * looking at is the alternative, and it is the worse one.
   *
   * Persisting is the caller's, as ever. Dropping the grid is not: the floor this room stood on has
   * to stop being floor, or a player walks onto tiles belonging to a room that no longer exists.
   */
  deleteRoom(roomId: RoomId):
    | {
        room: Room;
        place: Place;
        orphans: readonly { from: RoomId; dir: Direction }[];
        /**
         * Whether an A5 override went with it, so the caller knows whether `rooms.json` needs saving.
         *
         * Reported rather than assumed because that file is **git-tracked authored prose**, 200 KB of
         * it, and rewriting it reorders every key — a delete that touched none of it would otherwise
         * show up as a 279-line diff with no change in it.
         */
        droppedOverride: boolean;
        /** Whether the level's grid shrank with it — A8 slice 3. See `createRoom`. */
        extentChanged: boolean;
      }
    | { error: string } {
    const located = this.index.get(roomId);
    if (!located) return { error: `no room ${roomId} in the loaded world` };
    const zone = this.zonesById.get(located.place.zone);
    if (!zone) return { error: `zone ${located.place.zone} is not loaded` };

    const refusal = removalRefusal(zone.rooms, roomId);
    if (refusal) return { error: refusal };

    // Asked before the room goes, for the same reason the additive half asks first: once it is out
    // of the array the old extent cannot be measured.
    const extentChanged = narrowsExtent(zone.rooms, roomId);

    const room = located.room;
    const authored = this.authoredRooms.rooms.get(roomId);

    // **Ours first.** A created room's own declaration is what caused the reverse link on each of its
    // neighbours, so those come out with it — they are not part of any harvest and leaving them would
    // be inventing a dangling exit rather than tolerating one.
    if (authored) {
      for (const [dir, exit] of Object.entries(room.exits)) {
        const neighbour = this.index.get(exit.to)?.room;
        const back = neighbour?.exits[OPPOSITE[dir as Direction]];
        if (neighbour && back?.to === roomId) delete (neighbour.exits as Record<string, unknown>)[OPPOSITE[dir as Direction]];
      }
    }

    // Everything still pointing here, across the whole loaded world rather than this zone alone —
    // a cross-zone exit is a portal, but it is still an exit somebody authored.
    const orphans: { from: RoomId; dir: Direction }[] = [];
    for (const { room: other } of this.index.values()) {
      if (other.id === roomId) continue;
      for (const [dir, exit] of Object.entries(other.exits)) {
        if (exit.to !== roomId) continue;
        const owner = this.authoredRooms.rooms.get(other.id);
        if (owner) {
          // Another created room's declared exit. Ours, so it goes — and the record goes with it,
          // since the record and the live room are one object.
          delete (other.exits as Record<string, unknown>)[dir];
        } else {
          orphans.push({ from: other.id, dir: dir as Direction });
        }
      }
    }

    const index = zone.rooms.findIndex((candidate) => candidate.id === roomId);
    if (index >= 0) (zone.rooms as Room[]).splice(index, 1);
    this.index.delete(roomId);
    if (authored) this.authoredRooms.rooms.delete(roomId);
    else this.authoredRooms.deleted.add(roomId);
    // The override is dropped too when there was one: an entry patching a room that no longer exists
    // would apply to nothing forever, and would come back to life if a re-harvest ever reused the id.
    const droppedOverride = this.overrides.delete(roomId);
    this.pristine.delete(roomId);

    this.dropGrid(located.place);
    return { room, place: located.place, orphans, droppedOverride, extentChanged };
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
