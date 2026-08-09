/**
 * The world model.
 *
 * A MUD stores its world as a *graph* of rooms joined by exits. A renderer needs a *grid*. These
 * types describe the grid form: every room carries an integer cell coordinate, and any link that
 * could not be reconciled with those coordinates is demoted to a portal rather than being forced
 * into a position it does not fit.
 *
 * Ids are the MUD's own numeric ids and are never renumbered — they are the join key between every
 * data source we have.
 */

export type RoomId = number;
export type ZoneId = number;

/* -------------------------------------------------------------------------- */
/* Directions                                                                  */
/* -------------------------------------------------------------------------- */

/** Diku direction order: north, east, south, west, up, down. */
export const DIRECTIONS = ['north', 'east', 'south', 'west', 'up', 'down'] as const;

export type Direction = (typeof DIRECTIONS)[number];

/**
 * Cell offset applied when travelling in each direction.
 *
 * `y` grows *southward* so that world coordinates and screen coordinates agree; this removes a
 * whole class of flipped-map bugs at the cost of looking upside-down to anyone expecting maths
 * convention.
 */
export const DIRECTION_DELTA: Readonly<Record<Direction, readonly [x: number, y: number, z: number]>> = {
  north: [0, -1, 0],
  east: [1, 0, 0],
  south: [0, 1, 0],
  west: [-1, 0, 0],
  up: [0, 0, 1],
  down: [0, 0, -1],
};

export const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
};

/** Single-letter forms as typed by MUD players: `n`, `e`, `s`, `w`, `u`, `d`. */
export const DIRECTION_ABBREV: Readonly<Record<string, Direction>> = {
  n: 'north',
  e: 'east',
  s: 'south',
  w: 'west',
  u: 'up',
  d: 'down',
};

export function isDirection(value: string): value is Direction {
  return (DIRECTIONS as readonly string[]).includes(value);
}

/** Accepts `"n"` or `"north"`; returns `undefined` for anything else. */
export function parseDirection(input: string): Direction | undefined {
  const key = input.trim().toLowerCase();
  if (isDirection(key)) return key;
  return DIRECTION_ABBREV[key];
}

/* -------------------------------------------------------------------------- */
/* Terrain                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Terrain classes, following Diku sector types. These drive auto-tiling, movement cost and
 * whether a room can be entered at all without special movement.
 */
export const SECTORS = [
  'inside',
  'city',
  'road',
  'field',
  'forest',
  'hills',
  'mountain',
  'swamp',
  'desert',
  'arctic',
  'cave',
  'shallow_water',
  'deep_water',
  'underwater',
  'air',
  'astral',
] as const;

export type Sector = (typeof SECTORS)[number];

/** Movement points charged on entering a room of this terrain. */
export const SECTOR_MOVE_COST: Readonly<Record<Sector, number>> = {
  inside: 1,
  city: 1,
  road: 1,
  field: 2,
  forest: 3,
  hills: 4,
  mountain: 6,
  swamp: 5,
  desert: 4,
  arctic: 5,
  cave: 3,
  shallow_water: 4,
  deep_water: 6,
  underwater: 6,
  air: 2,
  astral: 2,
};

/** Terrain a character cannot enter on foot alone. */
export const SECTOR_REQUIRES_MOVEMENT: Readonly<Record<Sector, 'swim' | 'fly' | undefined>> = {
  inside: undefined,
  city: undefined,
  road: undefined,
  field: undefined,
  forest: undefined,
  hills: undefined,
  mountain: undefined,
  swamp: undefined,
  desert: undefined,
  arctic: undefined,
  cave: undefined,
  shallow_water: undefined,
  deep_water: 'swim',
  underwater: 'swim',
  air: 'fly',
  astral: 'fly',
};

/* -------------------------------------------------------------------------- */
/* Rooms                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A door on an exit.
 *
 * `name` and `keyId` are *content*: they come from the source data and never change. `closed` and
 * `locked` are *state* — they are what `open`, `close`, `lock` and `unlock` act on — so they are the
 * two fields here that are not `readonly`. The distinction is the whole reason the game may mutate a
 * loaded zone at all: nothing writes the JSON on disk back out, and a fresh `npm run worldgen` is
 * still reproducible.
 *
 * The two sides of a two-way door are separate objects and must be kept in step. That is the
 * server's job — see `GameWorld.setDoorClosed` — and it is what the MUD does too (`actmove.c`
 * `do_open` clears the flag on the reverse exit as well, announcing it to the room on the far side).
 */
export interface Door {
  /** Display name, e.g. "an iron gate". */
  readonly name: string;
  closed: boolean;
  locked: boolean;
  /** Object id of the key that opens it, when known. */
  readonly keyId?: number;
  /** Not shown in the room description until searched for. */
  readonly hidden?: boolean;
}

export interface RoomExit {
  readonly to: RoomId;
  readonly door?: Door;
  /**
   * Set when the destination is not the geometric neighbour in this direction — one-way links,
   * teleports, and links the layout pass could not reconcile. Rendered as a portal rather than an
   * opening in a wall.
   */
  readonly portal?: boolean;
}

/**
 * Room flags, as a runtime catalogue rather than a bare union.
 *
 * Same shape as {@link SECTORS} and for the same reason: an editor has to *offer* the list, and a
 * loader has to reject anything not on it. A type-only union can do neither — it vanishes at run
 * time, so a hand-written `"peacful"` in an authored overlay would sail through into a room whose
 * peace flag is never read again. See `server/src/overrides.ts`.
 */
export const ROOM_FLAGS = [
  'dark',
  'no_mob',
  'indoors',
  'peaceful',
  'no_magic',
  'no_recall',
  'death_trap',
  'safe',
] as const;

export type RoomFlag = (typeof ROOM_FLAGS)[number];

/**
 * Where **our own** room ids start. Nothing the MUD ships may ever reach here.
 *
 * A8, decision 1, and the same argument `AUTHORED_VNUM_BASE` makes about items — a room id is the
 * join key between the zMUD map, the `.wld` files, every reset command and every save file that has
 * ever recorded where somebody stood, so a collision is not a merge conflict, it is two rooms
 * silently becoming one.
 *
 * **Measured rather than assumed:** the generated world's 46,508 rooms run to **97,271**, and **0**
 * of them are above a million. That is an order of magnitude of headroom, which is enough that a
 * re-harvest cannot collide with an authored room and a builder adding an area cannot make it. It is
 * also large enough to be obvious on sight: a seven-digit room id is ours.
 */
export const AUTHORED_ROOM_BASE = 1_000_000;

/**
 * Where **our own** zone ids start — A8d, and {@link AUTHORED_ROOM_BASE}'s argument one level up.
 *
 * A zone id is the other half of the join key (`CLAUDE.md`: room *and zone* ids are the MUD's own
 * numbers), and it is also a directory name under `data/world/spawns/` and a line in
 * `world.config.json`, so a collision would be two zones quietly becoming one across three files.
 *
 * **Measured rather than assumed:** the harvest holds 327 zones and their ids run **1 to 423**. Six
 * digits is two orders of magnitude of headroom over anything a future Duris drop could plausibly
 * bring, and — the same virtue the room base has — obvious on sight: a six-digit zone id is ours.
 */
export const AUTHORED_ZONE_BASE = 100_000;

/**
 * One `E` block — prose the world offers only when asked by name. A sign on a wall, the writing on
 * a note, the inscription on a blade: `read <keyword>` (and Diku's `look at <keyword>`, which is
 * the same function in the source) finds these and prints the text.
 *
 * `keywords` is the block's own space-separated word list, lowercased at harvest. Matching is
 * **exact word, case-insensitive** — `handler.c`'s live `isname` returns true only when the search
 * word ends exactly where a keyword does, so `read sig` does not find a `sign`. Rooms and items
 * carry the same shape because the source stores them in the same `extra_descr_data` list.
 */
export interface ExtraDescription {
  readonly keywords: string;
  readonly text: string;
}

export interface Room {
  readonly id: RoomId;
  readonly zone: ZoneId;
  readonly name: string;
  readonly sector: Sector;
  /** Integer cell position within the zone's local grid. */
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
  readonly exits: Readonly<Partial<Record<Direction, RoomExit>>>;
  readonly flags?: readonly RoomFlag[];
  /**
   * Prose shown in the text log. Third-party content — always optional so the engine runs without
   * it, and stripped from any build we distribute.
   */
  readonly description?: string;
  /**
   * Prose shown only on request — `read sign` where {@link description} is what `look` volunteers.
   * Same third-party posture as `description`, and gated on the same `--descriptions` switch.
   */
  readonly extras?: readonly ExtraDescription[];
}

/* -------------------------------------------------------------------------- */
/* Zones                                                                       */
/* -------------------------------------------------------------------------- */

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

export interface Zone {
  readonly id: ZoneId;
  readonly name: string;
  readonly rooms: readonly Room[];
  readonly bounds: Bounds;
  /** Where a player arrives when entering the zone without a specific destination. */
  readonly entryRoom?: RoomId;
  /**
   * Rendered seamless — the open world's first dial (V8a, DESIGN-open-world.md). Room blocks lie
   * flush with a one-tile seam line instead of the void gap: an open exit fills its whole shared
   * edge with floor, a door narrows it to a gate in a wall, and no exit leaves the seam solid.
   * Declared by authored zone files and carried through worldgen; the harvest never sets it, so
   * absent means the classic block-and-corridor projection unchanged.
   */
  readonly seamless?: boolean;
}

export interface World {
  readonly zones: readonly Zone[];
  /** Provenance of the source data and the worldgen run that produced this file. */
  readonly meta: {
    readonly generatedAt: string;
    readonly source: string;
    readonly roomCount: number;
    readonly zoneCount: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function boundsOf(rooms: readonly Room[]): Bounds {
  if (rooms.length === 0) {
    return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const room of rooms) {
    const { x, y, z } = room.pos;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

/** Stable key for a cell coordinate, for collision detection during layout. */
export function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * True when `exit` lands on the cell you would expect from walking `dir` out of `from`. Links that
 * fail this test are the ones the layout pass marks as portals.
 */
export function isGeometricallyConsistent(from: Room, dir: Direction, to: Room): boolean {
  const delta = DIRECTION_DELTA[dir];
  return (
    to.pos.x === from.pos.x + delta[0] &&
    to.pos.y === from.pos.y + delta[1] &&
    to.pos.z === from.pos.z + delta[2]
  );
}

/** Index rooms by id for O(1) lookup. */
export function indexRooms(zones: readonly Zone[]): Map<RoomId, Room> {
  const index = new Map<RoomId, Room>();
  for (const zone of zones) {
    for (const room of zone.rooms) index.set(room.id, room);
  }
  return index;
}
