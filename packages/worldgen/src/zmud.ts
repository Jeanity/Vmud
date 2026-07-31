/**
 * Reader for the zMUD/CMUD mapper database (`TorilMud.dbm`, a plain SQLite 3 file).
 *
 * Schema notes established by inspecting the real data — none of this is documented upstream:
 *
 * - `ObjectTbl` holds **rooms**. zMUD calls everything on the map an "object".
 * - `ObjectTbl.RefNum` is the MUD's own room vnum (populated for 46,530 / 46,576 rooms). This is the
 *   join key back to the live game and must never be renumbered.
 * - `ExitTbl.DirType` is a **0-based** enum: 0=n, 1=ne, 2=e, 3=se, 4=s, 5=sw, 6=w, 7=nw, 8=up,
 *   9=down, 11=special ("enter portal" and friends). Note this is *not* `DirTbl.DirId`, which is
 *   1-based and ordered differently — an off-by-one here silently corrupts every direction.
 * - `DirTbl.Dx/Dy/Dz` are zMUD's *default drawing* deltas (200/100), **not** this map's actual grid
 *   pitch, which measures 240 horizontal and 1 vertical. We detect the pitch rather than trust it.
 * - `Y` grows southward, which happily matches our screen-space convention.
 * - There is no sector/terrain column; see `terrain.ts`.
 */

import { DatabaseSync } from 'node:sqlite';

import {
  DIRECTION_DELTA,
  boundsOf,
  cellKey,
  type Direction,
  type Door,
  type Room,
  type RoomExit,
  type RoomId,
  type World,
  type Zone,
  type ZoneId,
} from '@mygame/shared';

import { inferSector, type TerrainSource } from './terrain.ts';

/** zMUD's 0-based direction enum. Diagonals exist but are effectively unused world-wide. */
const DIRTYPE: Readonly<Record<number, Direction>> = {
  0: 'north',
  2: 'east',
  4: 'south',
  6: 'west',
  8: 'up',
  9: 'down',
};

const DIAGONAL_DIRTYPES = new Set([1, 3, 5, 7]);

/** `ExitKindTbl`: 0 = Normal Exit, 1 = Door, 2 = Locked Door. */
const EXIT_KIND_DOOR = 1;
const EXIT_KIND_LOCKED = 2;

interface RawZone {
  ZoneId: number;
  Name: string | null;
}

interface RawRoom {
  ObjId: number;
  Name: string | null;
  Desc: string | null;
  X: number | null;
  Y: number | null;
  Z: number | null;
  ZoneID: number | null;
  RefNum: number | null;
}

interface RawExit {
  FromID: number | null;
  ToID: number | null;
  DirType: number | null;
  ExitKindID: number | null;
  Name: string | null;
}

export interface WorldgenStats {
  zones: number;
  rooms: number;
  roomsSkippedNoZone: number;
  roomsSkippedNoCoords: number;
  exits: number;
  exactNeighbour: number;
  portals: number;
  crossZone: number;
  dangling: number;
  droppedDiagonal: number;
  droppedSpecial: number;
  duplicateDirection: number;
  cellCollisions: number;
  pitchXY: number;
  pitchZ: number;
  sectorCounts: Record<string, number>;
  /** How each terrain guess was reached — a high `default` share means the rule table needs work. */
  sectorSources: Record<string, number>;
}

export interface LoadOptions {
  /** Restrict output to these zone ids. Omit for the whole world. */
  readonly onlyZones?: readonly number[];
  /** Include room descriptions. Off by default — they are third-party prose and bulk up output. */
  readonly includeDescriptions?: boolean;
}

/**
 * Measures the grid pitch instead of trusting `DirTbl`.
 *
 * Takes the modal absolute delta across cardinal exits. Using the mode rather than a GCD matters:
 * a GCD is destroyed by a single hand-dragged room, whereas the mode shrugs it off.
 */
export function detectPitch(db: DatabaseSync): { xy: number; z: number } {
  const rooms = db.prepare('SELECT ObjId, X, Y, Z, ZoneID FROM ObjectTbl').all() as unknown as RawRoom[];
  const byId = new Map<number, RawRoom>();
  for (const r of rooms) byId.set(r.ObjId, r);

  const exits = db
    .prepare('SELECT FromID, ToID, DirType FROM ExitTbl WHERE DirType IN (0, 2, 4, 6, 8, 9)')
    .all() as unknown as RawExit[];

  const horizontal = new Map<number, number>();
  const vertical = new Map<number, number>();

  for (const e of exits) {
    const from = e.FromID === null ? undefined : byId.get(e.FromID);
    const to = e.ToID === null ? undefined : byId.get(e.ToID);
    if (!from || !to || from.ZoneID !== to.ZoneID) continue;
    if (from.X === null || from.Y === null || from.Z === null) continue;
    if (to.X === null || to.Y === null || to.Z === null) continue;

    const dx = Math.abs(to.X - from.X);
    const dy = Math.abs(to.Y - from.Y);
    const dz = Math.abs(to.Z - from.Z);
    if (dx > 0) horizontal.set(dx, (horizontal.get(dx) ?? 0) + 1);
    if (dy > 0) horizontal.set(dy, (horizontal.get(dy) ?? 0) + 1);
    if (dz > 0) vertical.set(dz, (vertical.get(dz) ?? 0) + 1);
  }

  return { xy: mode(horizontal) ?? 240, z: mode(vertical) ?? 1 };
}

function mode(counts: ReadonlyMap<number, number>): number | undefined {
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Per-room provenance for every sector guess, alongside the world itself.
 *
 * The `sources` map exists for the diffusion stage: it has to know which rooms are *evidence* and
 * which merely carry the loader's fallback, and the room record deliberately does not say — a
 * shipped `Room` carries a sector, not an apology for one. Provenance is a build-time concern, so
 * it travels beside the world rather than inside it.
 */
export function loadWorld(
  dbPath: string,
  options: LoadOptions = {},
): { world: World; stats: WorldgenStats; sources: Map<RoomId, TerrainSource> } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return build(db, dbPath, options);
  } finally {
    db.close();
  }
}

function build(
  db: DatabaseSync,
  dbPath: string,
  options: LoadOptions,
): { world: World; stats: WorldgenStats; sources: Map<RoomId, TerrainSource> } {
  const pitch = detectPitch(db);

  const zoneFilter = options.onlyZones ? new Set(options.onlyZones) : undefined;

  const rawZones = db
    .prepare('SELECT ZoneId, Name FROM ZoneTbl ORDER BY ZoneId')
    .all() as unknown as RawZone[];
  const zoneNames = new Map<ZoneId, string>();
  for (const z of rawZones) zoneNames.set(z.ZoneId, z.Name?.trim() || `Zone ${z.ZoneId}`);

  const rawRooms = db
    .prepare('SELECT ObjId, Name, Desc, X, Y, Z, ZoneID, RefNum FROM ObjectTbl')
    .all() as unknown as RawRoom[];

  const stats: WorldgenStats = {
    zones: 0,
    rooms: 0,
    roomsSkippedNoZone: 0,
    roomsSkippedNoCoords: 0,
    exits: 0,
    exactNeighbour: 0,
    portals: 0,
    crossZone: 0,
    dangling: 0,
    droppedDiagonal: 0,
    droppedSpecial: 0,
    duplicateDirection: 0,
    cellCollisions: 0,
    pitchXY: pitch.xy,
    pitchZ: pitch.z,
    sectorCounts: {},
    sectorSources: {},
  };

  // Group usable rooms by zone.
  const roomsByZone = new Map<ZoneId, RawRoom[]>();
  const rawById = new Map<number, RawRoom>();
  for (const r of rawRooms) {
    rawById.set(r.ObjId, r);
    if (r.ZoneID === null || r.ZoneID === 0) {
      stats.roomsSkippedNoZone++;
      continue;
    }
    if (zoneFilter && !zoneFilter.has(r.ZoneID)) continue;
    if (r.X === null || r.Y === null || r.Z === null) {
      stats.roomsSkippedNoCoords++;
      continue;
    }
    let bucket = roomsByZone.get(r.ZoneID);
    if (!bucket) {
      bucket = [];
      roomsByZone.set(r.ZoneID, bucket);
    }
    bucket.push(r);
  }

  // Normalise coordinates to a zero-based integer cell grid, per zone.
  const cellOf = new Map<RoomId, { x: number; y: number; z: number }>();
  for (const [zoneId, bucket] of roomsByZone) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    for (const r of bucket) {
      minX = Math.min(minX, r.X!);
      minY = Math.min(minY, r.Y!);
      minZ = Math.min(minZ, r.Z!);
    }
    const seen = new Set<string>();
    for (const r of bucket) {
      const cell = {
        x: Math.round((r.X! - minX) / pitch.xy),
        y: Math.round((r.Y! - minY) / pitch.xy),
        z: Math.round((r.Z! - minZ) / pitch.z),
      };
      cellOf.set(r.ObjId, cell);
      const key = `${zoneId}:${cellKey(cell.x, cell.y, cell.z)}`;
      if (seen.has(key)) stats.cellCollisions++;
      seen.add(key);
    }
  }

  // Exits, bucketed by source room.
  const exitsByRoom = new Map<RoomId, Map<Direction, RoomExit>>();
  const rawExits = db
    .prepare('SELECT FromID, ToID, DirType, ExitKindID, Name FROM ExitTbl')
    .all() as unknown as RawExit[];

  for (const e of rawExits) {
    if (e.DirType !== null && DIAGONAL_DIRTYPES.has(e.DirType)) {
      stats.droppedDiagonal++;
      continue;
    }
    const dir = e.DirType === null ? undefined : DIRTYPE[e.DirType];
    if (!dir) {
      stats.droppedSpecial++;
      continue;
    }
    if (e.FromID === null || e.ToID === null) {
      stats.dangling++;
      continue;
    }
    const fromCell = cellOf.get(e.FromID);
    const toCell = cellOf.get(e.ToID);
    const fromRaw = rawById.get(e.FromID);
    const toRaw = rawById.get(e.ToID);
    if (!fromRaw || !toRaw) {
      stats.dangling++;
      continue;
    }
    // A zone-filtered run legitimately cannot see the far side of a boundary exit.
    if (!fromCell) continue;

    let bucket = exitsByRoom.get(e.FromID);
    if (!bucket) {
      bucket = new Map();
      exitsByRoom.set(e.FromID, bucket);
    }
    if (bucket.has(dir)) {
      // The mapper allows two exits in one direction; the game does not. Keep the first.
      stats.duplicateDirection++;
      continue;
    }

    const crossZone = fromRaw.ZoneID !== toRaw.ZoneID;
    let portal: boolean;
    if (crossZone) {
      stats.crossZone++;
      portal = true;
    } else if (!toCell) {
      portal = true;
    } else {
      const delta = DIRECTION_DELTA[dir];
      const consistent =
        toCell.x === fromCell.x + delta[0] &&
        toCell.y === fromCell.y + delta[1] &&
        toCell.z === fromCell.z + delta[2];
      portal = !consistent;
      if (consistent) stats.exactNeighbour++;
      else stats.portals++;
    }

    const door = doorFrom(e);
    bucket.set(dir, {
      to: e.ToID,
      ...(door ? { door } : {}),
      ...(portal ? { portal: true } : {}),
    });
    stats.exits++;
  }

  // Assemble.
  const zones: Zone[] = [];
  const sources = new Map<RoomId, TerrainSource>();
  for (const [zoneId, bucket] of [...roomsByZone].sort((a, b) => a[0] - b[0])) {
    const zoneName = zoneNames.get(zoneId) ?? `Zone ${zoneId}`;
    const rooms: Room[] = [];

    for (const r of bucket) {
      const cell = cellOf.get(r.ObjId)!;
      const name = r.Name?.trim() || 'An unnamed place';
      const guess = inferSector(name, zoneName);
      sources.set(r.ObjId, guess.source);
      stats.sectorCounts[guess.sector] = (stats.sectorCounts[guess.sector] ?? 0) + 1;
      stats.sectorSources[guess.source] = (stats.sectorSources[guess.source] ?? 0) + 1;

      const description = options.includeDescriptions ? r.Desc?.trim() : undefined;
      rooms.push({
        id: r.ObjId,
        zone: zoneId,
        name,
        sector: guess.sector,
        pos: cell,
        exits: Object.fromEntries(exitsByRoom.get(r.ObjId) ?? []),
        ...(description ? { description } : {}),
      });
      stats.rooms++;
    }

    rooms.sort((a, b) => a.pos.z - b.pos.z || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    zones.push({
      id: zoneId,
      name: zoneName,
      rooms,
      bounds: boundsOf(rooms),
      ...(rooms[0] ? { entryRoom: rooms[0].id } : {}),
    });
    stats.zones++;
  }

  const world: World = {
    zones,
    meta: {
      generatedAt: new Date().toISOString(),
      source: `zMUD mapper database: ${dbPath}`,
      roomCount: stats.rooms,
      zoneCount: stats.zones,
    },
  };

  return { world, stats, sources };
}

function doorFrom(e: RawExit): Door | undefined {
  if (e.ExitKindID !== EXIT_KIND_DOOR && e.ExitKindID !== EXIT_KIND_LOCKED) return undefined;
  const locked = e.ExitKindID === EXIT_KIND_LOCKED;
  return {
    name: e.Name?.trim() || 'a door',
    // The mapper records a door's *nature*, not its live state; a fresh world starts them shut.
    closed: true,
    locked,
  };
}
