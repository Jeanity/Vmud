/**
 * The authored world — Phase 22. First-party zones, written by hand, **committed to git** where
 * the harvest never is, and merged beside it under the same roof.
 *
 * `data/authored/zones/<id>.json` is the source: one file per zone, in the emitted `Zone` shape —
 * no intermediate format, because the emitted shape *is* hand-writable and inventing a second
 * dialect would mean maintaining a translator between two things we own. What a file cannot carry
 * by being hand-written is trust, so every rule the harvest earns by construction is **checked**
 * here instead, and a violation names the file, the room and the rule rather than surfacing three
 * systems later as a door into nothing.
 *
 * ## The id law
 *
 * Zone ids at {@link AUTHORED_ZONE_BASE}+ (A8d's band — the design note's 900001+ predates the
 * shipped constant and defers to it). Room ids are **derived, not chosen**: `zone × 1000 + n`,
 * n 0–999 — so 100001's rooms live at 100001000–100001999. Derivation is the collision proof: two
 * authored zones cannot share a room id without sharing a zone id, the band sits nine digits up
 * where neither the harvest (ids to 97,271) nor A8's runtime allocator (1,000,004 and counting by
 * ones) will ever reach, and a nine-digit id names its zone on sight in any log line.
 *
 * ## The cross-source rule
 *
 * An authored exit may land in the harvested world — a Velen road ending in wilderness — and
 * that edge is checked **at merge time, when both worlds are in hand**, because neither side alone
 * can see it whole. Three rules, inherited from `links.json` (the overlay that was this rule
 * arriving early, and stays for *runtime* authoring):
 *
 * 1. **It is a portal.** Two rooms in different sources share no coordinate frame, so the exit is
 *    declared `portal: true` or refused. The same is required across two *authored* zones for now —
 *    each zone is its own grid — and can soften when a district plan wants seamless doors.
 * 2. **The return half is injected, never assumed.** The harvested file is regenerated and cannot
 *    be edited, so the merge writes the reciprocal exit into the harvested room in the emitted
 *    output. A door you cannot come back through is the failure the injection exists to prevent.
 * 3. **It never overwrites.** A harvested room that already has an exit where the return half must
 *    go refuses the merge loudly — silently re-routing a harvested door would be a zone-shape
 *    change invisible in the authored file.
 *
 * Prose note: `Room.description` documents itself as third-party and strippable. Authored prose is
 * **first-party** — it ships, and it is exactly the point of this pipeline.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUTHORED_ZONE_BASE,
  DIRECTIONS,
  ROOM_FLAGS,
  SECTORS,
  boundsOf,
  cellKey,
  isGeometricallyConsistent,
  type Direction,
  type Room,
  type RoomExit,
  type RoomId,
  type Zone,
  type ZoneId,
} from '@mygame/shared';

/** Rooms per authored zone — the derivation `zone × 1000 + n` gives each zone this many slots. */
export const AUTHORED_ROOMS_PER_ZONE = 1000;

const REVERSE: Readonly<Record<Direction, Direction>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
  up: 'down',
  down: 'up',
};

/** One refusal. The file and the rule, always; the room when one is at fault. */
function refuse(file: string, message: string): never {
  throw new Error(`authored zone ${file}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/**
 * One zone file, checked to the letter. Everything zone-local is validated here; what needs the
 * other side of the world — cross-source and cross-authored targets — is deferred to
 * {@link mergeAuthoredZones}, which is the only place both sides exist.
 */
export function validateAuthoredZone(raw: unknown, file: string): Zone {
  if (!isRecord(raw)) refuse(file, 'not a JSON object');
  const { id, name, entryRoom, rooms } = raw;
  if (!isInteger(id) || id < AUTHORED_ZONE_BASE) {
    refuse(file, `zone id must be an integer >= ${AUTHORED_ZONE_BASE} (got ${JSON.stringify(id)})`);
  }
  if (typeof name !== 'string' || name.trim().length === 0) refuse(file, 'zone name must be a non-empty string');
  if (!Array.isArray(rooms) || rooms.length === 0) refuse(file, 'rooms must be a non-empty array');

  const base = id * AUTHORED_ROOMS_PER_ZONE;
  const seenIds = new Set<number>();
  const seenCells = new Map<string, number>();
  const validated: Room[] = [];

  for (const entry of rooms) {
    if (!isRecord(entry)) refuse(file, 'every room must be an object');
    const rid = entry.id;
    if (!isInteger(rid)) refuse(file, `room id ${JSON.stringify(rid)} is not an integer`);
    if (rid < base || rid >= base + AUTHORED_ROOMS_PER_ZONE) {
      refuse(file, `room ${rid}: id must be ${base}..${base + AUTHORED_ROOMS_PER_ZONE - 1} (zone × 1000 + n)`);
    }
    if (seenIds.has(rid)) refuse(file, `room ${rid} declared twice`);
    seenIds.add(rid);
    if (entry.zone !== id) refuse(file, `room ${rid}: zone field must be ${id}`);
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) refuse(file, `room ${rid}: name must be a non-empty string`);
    if (typeof entry.sector !== 'string' || !(SECTORS as readonly string[]).includes(entry.sector)) {
      refuse(file, `room ${rid}: sector ${JSON.stringify(entry.sector)} is not one of the SECTORS catalogue`);
    }
    const pos = entry.pos;
    if (!isRecord(pos) || !isInteger(pos.x) || !isIntegers(pos.y, pos.z)) {
      refuse(file, `room ${rid}: pos must be integer {x, y, z}`);
    }
    const cell = cellKey(pos.x as number, pos.y as number, pos.z as number);
    const occupant = seenCells.get(cell);
    if (occupant !== undefined) refuse(file, `room ${rid}: shares cell (${cell}) with room ${occupant}`);
    seenCells.set(cell, rid);
    if (entry.flags !== undefined) {
      if (!Array.isArray(entry.flags)) refuse(file, `room ${rid}: flags must be an array`);
      for (const flag of entry.flags) {
        if (!(ROOM_FLAGS as readonly string[]).includes(flag as string)) {
          refuse(file, `room ${rid}: flag ${JSON.stringify(flag)} is not one of the ROOM_FLAGS catalogue`);
        }
      }
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      refuse(file, `room ${rid}: description must be a string`);
    }
    if (entry.extras !== undefined) {
      if (!Array.isArray(entry.extras)) refuse(file, `room ${rid}: extras must be an array`);
      for (const extra of entry.extras) {
        if (!isRecord(extra) || typeof extra.keywords !== 'string' || typeof extra.text !== 'string') {
          refuse(file, `room ${rid}: every extra must be { keywords, text }`);
        }
      }
    }
    if (!isRecord(entry.exits)) refuse(file, `room ${rid}: exits must be an object (may be empty)`);
    for (const [dir, exit] of Object.entries(entry.exits)) {
      if (!(DIRECTIONS as readonly string[]).includes(dir)) refuse(file, `room ${rid}: ${JSON.stringify(dir)} is not a direction`);
      if (!isRecord(exit) || !isInteger(exit.to)) refuse(file, `room ${rid}: exit ${dir} must be { to: <room id> }`);
      if (exit.portal !== undefined && typeof exit.portal !== 'boolean') refuse(file, `room ${rid}: exit ${dir}: portal must be boolean`);
      if (exit.door !== undefined) {
        const door = exit.door;
        if (!isRecord(door) || typeof door.closed !== 'boolean' || typeof door.locked !== 'boolean') {
          refuse(file, `room ${rid}: exit ${dir}: door must carry closed and locked booleans`);
        }
      }
    }
    validated.push(entry as unknown as Room);
  }

  if (!isInteger(entryRoom) || !seenIds.has(entryRoom)) {
    refuse(file, `entryRoom ${JSON.stringify(entryRoom)} is not a room of this zone`);
  }

  // The in-zone half of the exit law: targets inside this zone resolve now; geometry or an honest
  // portal; and every edge has its return half. Cross-zone targets wait for the merge.
  const byId = new Map(validated.map((room) => [room.id, room]));
  for (const room of validated) {
    for (const [dir, exit] of Object.entries(room.exits) as [Direction, RoomExit][]) {
      const target = byId.get(exit.to);
      if (target === undefined) continue; // another zone's — the merge owns it
      if (!exit.portal && !isGeometricallyConsistent(room, dir, target)) {
        refuse(file, `room ${room.id}: exit ${dir} to ${exit.to} is not the geometric neighbour and not declared a portal`);
      }
      const back = target.exits[REVERSE[dir]];
      if (back === undefined || back.to !== room.id) {
        refuse(file, `room ${room.id}: exit ${dir} to ${exit.to} has no return exit ${REVERSE[dir]} — a door you cannot come back through`);
      }
    }
  }

  return {
    id: id as ZoneId,
    name: name.trim(),
    rooms: validated,
    bounds: boundsOf(validated),
    entryRoom: entryRoom as RoomId,
  };
}

/** `pos.y`/`pos.z` share `pos.x`'s rule; a helper so the check reads as one line. */
function isIntegers(...values: unknown[]): boolean {
  return values.every((value) => isInteger(value));
}

/** Every zone file under the authored directory, validated. Missing directory = no authored world yet. */
export function loadAuthoredZoneDir(dir: string): Zone[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const zones: Zone[] = [];
  const seen = new Map<number, string>();
  for (const file of files.sort()) {
    const zone = validateAuthoredZone(JSON.parse(readFileSync(join(dir, file), 'utf8')), file);
    const named = `${zone.id}.json`;
    if (file !== named) refuse(file, `file must be named ${named} to match its zone id`);
    const holder = seen.get(zone.id);
    if (holder !== undefined) refuse(file, `zone id ${zone.id} already declared by ${holder}`);
    seen.set(zone.id, file);
    zones.push(zone);
  }
  return zones;
}

/** What the merge did, for the build report. */
export interface AuthoredMergeReport {
  readonly zones: number;
  readonly rooms: number;
  readonly crossSource: number;
  readonly crossAuthored: number;
}

/**
 * The merge — the one moment both worlds are in hand. Resolves every exit that leaves its own
 * zone, enforces the portal law on it, and **injects the return half** of each cross-source edge
 * into the harvested room it lands in, rebuilding that room rather than mutating it. Returns the
 * harvested zones (with injections applied) followed by the authored ones, and the tally.
 */
export function mergeAuthoredZones(harvested: Zone[], authored: Zone[]): { zones: Zone[]; report: AuthoredMergeReport } {
  const authoredRooms = new Map<RoomId, ZoneId>();
  for (const zone of authored) for (const room of zone.rooms) authoredRooms.set(room.id, zone.id);
  const harvestIndex = new Map<RoomId, { zone: Zone; room: Room }>();
  for (const zone of harvested) for (const room of zone.rooms) harvestIndex.set(room.id, { zone, room });

  let crossSource = 0;
  let crossAuthored = 0;
  const injections = new Map<RoomId, Map<Direction, RoomExit>>();

  for (const zone of authored) {
    const file = `${zone.id}.json`;
    const own = new Set(zone.rooms.map((room) => room.id));
    for (const room of zone.rooms) {
      for (const [dir, exit] of Object.entries(room.exits) as [Direction, RoomExit][]) {
        if (own.has(exit.to)) continue; // settled by validateAuthoredZone

        if (authoredRooms.has(exit.to)) {
          // Authored to authored: both files are ours, so the return half is *demanded*, not injected
          // — an injection would put content in a file a person then edits without seeing it.
          if (!exit.portal) refuse(file, `room ${room.id}: exit ${dir} crosses into zone ${authoredRooms.get(exit.to)} and must be a portal`);
          const target = authored.flatMap((z) => z.rooms).find((r) => r.id === exit.to);
          const back = target?.exits[REVERSE[dir]];
          if (back === undefined || back.to !== room.id) {
            refuse(file, `room ${room.id}: exit ${dir} to ${exit.to} has no return exit in zone ${authoredRooms.get(exit.to)}`);
          }
          crossAuthored++;
          continue;
        }

        const landing = harvestIndex.get(exit.to);
        if (landing === undefined) {
          refuse(file, `room ${room.id}: exit ${dir} to ${exit.to} lands in no harvested or authored room`);
        }
        if (!exit.portal) {
          refuse(file, `room ${room.id}: exit ${dir} to harvested ${exit.to} must be a portal — two sources share no coordinate frame`);
        }
        const returnDir = REVERSE[dir];
        if (landing.room.exits[returnDir] !== undefined) {
          refuse(
            file,
            `room ${room.id}: exit ${dir} to harvested ${exit.to} needs its return ${returnDir}, but that room already has one — an authored edge never overwrites a harvested exit`,
          );
        }
        const queued = injections.get(exit.to) ?? new Map<Direction, RoomExit>();
        if (queued.has(returnDir)) {
          refuse(file, `room ${room.id}: two authored edges both need ${returnDir} out of harvested ${exit.to}`);
        }
        queued.set(returnDir, { to: room.id, portal: true });
        injections.set(exit.to, queued);
        crossSource++;
      }
    }
  }

  const zones = harvested.map((zone) => {
    if (!zone.rooms.some((room) => injections.has(room.id))) return zone;
    return {
      ...zone,
      rooms: zone.rooms.map((room) => {
        const queued = injections.get(room.id);
        if (queued === undefined) return room;
        return { ...room, exits: { ...room.exits, ...Object.fromEntries(queued) } };
      }),
    };
  });
  zones.push(...authored);

  return {
    zones,
    report: {
      zones: authored.length,
      rooms: authored.reduce((n, zone) => n + zone.rooms.length, 0),
      crossSource,
      crossAuthored,
    },
  };
}
