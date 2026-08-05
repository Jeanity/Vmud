/**
 * Rooms that were **made here** — A8's first slice, and `item-authoring.ts`'s argument applied to
 * geometry.
 *
 * `overrides.ts` patches the harvest: a few changed fields keyed by vnum, folded over a room that
 * already exists. That shape is exactly right for rewriting a Duris room and exactly wrong for
 * inventing one, because a patch presupposes something to patch. A room with no `.wld` record behind
 * it *is* its record, and the two differ in every rule that matters:
 *
 * | | `overrides.ts` | here |
 * | --- | --- | --- |
 * | Shape | a few optional fields | a complete {@link Room} |
 * | Composed by | folding over a generated room | being added to the zone |
 * | Empty entry means | *nothing is authored* — delete it, take the ✎ off | nothing; the room stays |
 * | Re-harvest | flows through wherever it was not authored | cannot touch it at all |
 * | May change geometry | **no** — id, position and exits are refused by name | that is the whole point |
 *
 * ## The id is the whole safety argument
 *
 * See {@link AUTHORED_ROOM_BASE}. Every created room is numbered at a million or above, which no
 * generated room reaches — the harvest's highest is 97,271 — so `npm run worldgen` can be re-run for
 * ever without a created room and a harvested one contending for the same key. Nothing else here
 * would survive a collision: a room id is the join between the zMUD map, the `.wld` files, every
 * reset command and every `lastRoom` ever saved.
 *
 * ## Infill only, and the refusal is the feature
 *
 * `DESIGN-zone-geometry.md` decision 2 is the sharp edge of this whole track: a grid is sized from
 * `boundsOf` the rooms on its level, tile indices are row-major, and **widening a grid shifts every
 * saved `seen` index below the first row**. So this slice places rooms *inside* a level's current
 * extent and refuses anything outside it by name. That is not a stub — it is the build order the
 * design note picks, because it reaches A8's completion test without being able to take an explored
 * map away from a player who was not consulted.
 *
 * The same check runs at load, not only at creation: this file is hand-editable like its siblings,
 * and a room typed in outside the extent would otherwise widen a grid on the next boot with nothing
 * to say it had.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_ROOM_BASE,
  DIRECTION_DELTA,
  OPPOSITE,
  ROOM_FLAGS,
  SECTORS,
  boundsOf,
  cellKey,
  isDirection,
  isGeometricallyConsistent,
  type Direction,
  type Room,
  type RoomExit,
  type RoomFlag,
  type RoomId,
  type Sector,
  type Zone,
  type ZoneId,
} from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where created rooms live — beside `rooms.json`, and exported for the same reason it is. */
export const AUTHORED_ROOMS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'rooms-authored.json');

/**
 * Which way an authored room may be joined to its neighbours.
 *
 * **The four compass points, and `up`/`down` are refused by name.** A vertical link lands on a
 * different level, which is a different Place with its own grid and its own stair tiles — carving one
 * means dropping and republishing a second grid, and `stairPlacement` decides both flights of a room
 * together. That is real work with its own drive, and bundling it into the slice whose whole claim is
 * *"this cannot invalidate anybody's map"* would be the way to break that claim by accident.
 */
export const LINKABLE: readonly Direction[] = ['north', 'east', 'south', 'west'];

/**
 * A created room, plus the provenance every overlay in this project records.
 *
 * `room` is a whole {@link Room} rather than a patch — see the table above. `brief` rides along for
 * the same reason it does on an override: the prose is on disk, but what the author actually decided
 * is not, and re-drafting without it means starting the thought again.
 */
export interface AuthoredRoom {
  readonly room: Room;
  readonly at?: string;
  readonly by?: string;
  readonly brief?: string;
}

export type AuthoredRooms = Map<RoomId, AuthoredRoom>;

/**
 * The overlay as a whole: the records, and the number to hand out next.
 *
 * **The counter is stored rather than derived**, and A6b's reason applies unchanged: "highest plus
 * one" looks like it never repeats until you delete the highest room, at which point the next
 * creation gets the number just freed — and a room id is an identity. A recycled one silently
 * changes what a saved `lastRoom`, a reset command or another room's exit is pointing at.
 */
export interface AuthoredRoomStore {
  readonly rooms: AuthoredRooms;
  /** The next room id to allocate. Only ever increases, including across a delete. */
  next: number;
}

/**
 * What a form must supply. Deliberately **not** `Partial<Room>`: the id is the server's to allocate,
 * and an exit's *destination* is not a free parameter for an infill room — see {@link resolveExits}.
 */
export interface RoomDraft {
  readonly zone?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly sector?: unknown;
  readonly flags?: unknown;
  readonly x?: unknown;
  readonly y?: unknown;
  readonly level?: unknown;
  /** The directions to join to the neighbouring cells, as a list of names. */
  readonly exits?: unknown;
}

/**
 * What a caller gets back: the room and the directions it asked to be joined in, or the reason there
 * is not one.
 *
 * The two travel together and stay apart. A validated draft cannot carry its own exits — their far
 * ends are a fact about the zone, not about the draft — so `room.exits` is empty here by
 * construction and `dirs` is what {@link resolveExits} then answers. Folding the directions into the
 * room would make a half-resolved `Room` a thing that exists, and it is the shape that reaches disk.
 */
export type Drafted = { readonly room: Room; readonly dirs: readonly Direction[] } | { readonly error: string };

const SECTOR_SET = new Set<string>(SECTORS);
const FLAG_SET = new Set<string>(ROOM_FLAGS);

export const ROOM_NAME_MAX = 80;
export const ROOM_PROSE_MAX = 4000;

function readInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : undefined;
}

/**
 * Where a room may stand, or the reason it may not.
 *
 * Takes the rooms rather than the `Zone` so the loader, the API and a test can all ask the same
 * question of the same three facts, and so the answer is computed from the world **as it stands** —
 * including authored rooms already accepted this pass, which is what lets two of them sit side by
 * side.
 *
 * Three refusals, each naming what it saw, because "it will not go there" tells an author nothing
 * about which of the three rules they hit.
 */
export function placementRefusal(
  rooms: readonly Room[],
  pos: { readonly x: number; readonly y: number; readonly z: number },
): string | undefined {
  const level = rooms.filter((room) => room.pos.z === pos.z);
  if (level.length === 0) {
    return (
      `level ${pos.z} has no rooms, so it has no grid to put one inside. A new level is a new ` +
      `Place, which resizes nothing but creates something — and that is the extent work, not infill.`
    );
  }

  const bounds = boundsOf(level);
  if (pos.x < bounds.minX || pos.x > bounds.maxX || pos.y < bounds.minY || pos.y > bounds.maxY) {
    return (
      `(${pos.x},${pos.y}) is outside level ${pos.z}'s extent, which runs ` +
      `${bounds.minX}..${bounds.maxX} by ${bounds.minY}..${bounds.maxY}. Widening it would shift ` +
      `every tile index in every saved map of this Place, so this slice fills gaps only.`
    );
  }

  const occupant = level.find((room) => room.pos.x === pos.x && room.pos.y === pos.y);
  if (occupant) return `(${pos.x},${pos.y}) already holds room ${occupant.id}, "${occupant.name}"`;
  return undefined;
}

/**
 * Turns a list of directions into the exits they mean, or the reason one of them cannot be made.
 *
 * **The destination is derived, never posted.** For an infill room an exit's far end is not a
 * choice — it is whatever room is in the adjacent cell — and asking a form for it invites a link
 * that says `east` and lands somewhere else, which is precisely the portal-shaped lie the zone map
 * refuses to draw. Deriving it means the geometry and the graph agree by construction.
 *
 * A neighbour that already has an exit facing back here is refused rather than overwritten. Decision
 * 3 says the editor writes both sides; it does not say it may rewrite a side somebody else authored,
 * and silently replacing a Duris exit is how a zone loses a corridor nobody was looking at.
 */
export function resolveExits(
  rooms: readonly Room[],
  pos: { readonly x: number; readonly y: number; readonly z: number },
  dirs: readonly Direction[],
): { readonly exits: Partial<Record<Direction, RoomId>> } | { readonly error: string } {
  const byCell = new Map<string, Room>();
  for (const room of rooms) byCell.set(cellKey(room.pos.x, room.pos.y, room.pos.z), room);
  const byId = new Map<RoomId, Room>();
  for (const room of rooms) byId.set(room.id, room);

  const exits: Partial<Record<Direction, RoomId>> = {};
  for (const dir of dirs) {
    if (!LINKABLE.includes(dir)) {
      return { error: `${dir} is not linkable yet — an authored room joins its neighbours on its own level` };
    }
    const delta = DIRECTION_DELTA[dir];
    const neighbour = byCell.get(cellKey(pos.x + delta[0], pos.y + delta[1], pos.z + delta[2]));
    if (!neighbour) return { error: `nothing lies ${dir} of (${pos.x},${pos.y}) on level ${pos.z}` };

    const facing = neighbour.exits[OPPOSITE[dir]];
    if (facing) {
      const to = byId.get(facing.to);
      return {
        error:
          `room ${neighbour.id} already has a ${OPPOSITE[dir]} exit, to ` +
          `${to ? `${facing.to} "${to.name}"` : String(facing.to)} — joining it here would replace one`,
      };
    }
    exits[dir] = neighbour.id;
  }
  return { exits };
}

/**
 * A draft turned into a whole room, or the reason it cannot be.
 *
 * Returns the *reason* rather than a bare `undefined` for the same purpose `draftAuthoredItem` does:
 * this validator's failures are read by a person filling in a form, and a refusal with no cause is
 * the difference between an editor somebody can use and one they file a bug about.
 *
 * Shape only. Whether the room may stand where it says is {@link placementRefusal}'s question and
 * needs the rest of the zone to answer; the exits it carries are {@link resolveExits}' and need the
 * same. Keeping the three apart is what lets the loader and the API run all three in one order.
 */
export function draftAuthoredRoom(id: RoomId, draft: RoomDraft): Drafted {
  if (!Number.isInteger(id) || id < AUTHORED_ROOM_BASE) {
    return { error: `an authored room id must be an integer at or above ${AUTHORED_ROOM_BASE}` };
  }

  const zone = readInt(draft.zone);
  if (zone === undefined) return { error: 'zone must be an integer zone id' };

  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) return { error: 'name is required' };
  if (name.length > ROOM_NAME_MAX) return { error: `name must be at most ${ROOM_NAME_MAX} characters` };

  if (draft.description !== undefined && draft.description !== null && typeof draft.description !== 'string') {
    return { error: 'description must be a string' };
  }
  const description = typeof draft.description === 'string' ? draft.description : undefined;
  if (description !== undefined && description.length > ROOM_PROSE_MAX) {
    return { error: `description must be at most ${ROOM_PROSE_MAX} characters` };
  }

  if (typeof draft.sector !== 'string' || !SECTOR_SET.has(draft.sector)) {
    return { error: `sector must be one of: ${SECTORS.join(', ')}` };
  }

  let flags: readonly RoomFlag[] | undefined;
  if (draft.flags !== undefined && draft.flags !== null) {
    if (!Array.isArray(draft.flags)) return { error: 'flags must be an array' };
    const bad = (draft.flags as unknown[]).filter((f) => typeof f !== 'string' || !FLAG_SET.has(f));
    if (bad.length > 0) {
      return { error: `unknown flags ${JSON.stringify(bad)} — one of: ${ROOM_FLAGS.join(', ')}` };
    }
    flags = [...new Set(draft.flags as RoomFlag[])];
  }

  const x = readInt(draft.x);
  const y = readInt(draft.y);
  const z = readInt(draft.level);
  if (x === undefined || y === undefined || z === undefined) {
    return { error: 'x, y and level must be whole numbers — they are the room\'s cell on its zone grid' };
  }

  // **At least one, and that is a rule rather than a nicety.** This slice has no way to add an exit
  // to a room after the fact, so a room created with none is unreachable for ever — and an
  // unreachable room is indistinguishable from the save having failed.
  if (!Array.isArray(draft.exits) || draft.exits.length === 0) {
    return { error: 'a room needs at least one exit — one you cannot walk into is not a room yet' };
  }
  const dirs: Direction[] = [];
  for (const raw of draft.exits as unknown[]) {
    if (typeof raw !== 'string' || !isDirection(raw)) {
      return { error: `"${String(raw)}" is not a direction — one of: ${LINKABLE.join(', ')}` };
    }
    if (!dirs.includes(raw)) dirs.push(raw);
  }

  return {
    room: {
      id,
      zone: zone as ZoneId,
      name,
      sector: draft.sector as Sector,
      pos: { x, y, z },
      // Filled by the caller from {@link resolveExits}, which needs the zone this room is joining.
      // Left empty here rather than half-resolved: a room carrying exits nothing checked is exactly
      // the record that reaches disk and fails three systems away.
      exits: {},
      ...(flags && flags.length > 0 ? { flags } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    dirs,
  };
}

/**
 * One record off disk, or nothing.
 *
 * Runs the same {@link draftAuthoredRoom} the API does rather than a second, laxer reader — a file
 * somebody edited by hand deserves exactly the validation a form POST gets, and two validators for
 * one shape is how a field ends up legal through one door and not the other.
 *
 * The stored `exits` are read as **destinations**, not directions, because that is what makes the
 * file self-describing: `{"north": 41297}` says which room it means, so a neighbour that moved in a
 * re-harvest is a discrepancy something can *see* rather than a link that quietly re-points. The
 * check is composition's, at load — see `GameWorld`.
 */
export function readAuthoredRoom(id: RoomId, raw: unknown): AuthoredRoom | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;

  const stored = typeof record.exits === 'object' && record.exits !== null ? (record.exits as Record<string, unknown>) : {};
  const dirs = Object.keys(stored).filter((key) => isDirection(key));
  const drafted = draftAuthoredRoom(id, { ...record, exits: dirs } as RoomDraft);
  if ('error' in drafted) return undefined;

  const exits: Partial<Record<Direction, RoomExit>> = {};
  for (const dir of drafted.dirs) {
    const to = readInt(stored[dir]);
    if (to === undefined) return undefined;
    exits[dir] = { to: to as RoomId };
  }

  return {
    room: { ...drafted.room, exits },
    ...(typeof record.at === 'string' ? { at: record.at } : {}),
    ...(typeof record.by === 'string' ? { by: record.by } : {}),
    ...(typeof record.brief === 'string' ? { brief: record.brief } : {}),
  };
}

/**
 * Why one authored exit cannot be hung, or nothing.
 *
 * The load-time counterpart to {@link resolveExits}, and it asks a *different* question on purpose.
 * `resolveExits` derives a destination from a cell; this one is handed a destination that was written
 * down some time ago and checks it is still the truth — the room exists, it is still the cell in that
 * direction, and nothing has since claimed the exit facing back. That is what makes storing the far
 * end worth the redundancy: a neighbour whose coordinates moved in a re-harvest becomes a discrepancy
 * something can *see* and drop, rather than a link that silently re-points at whatever is there now.
 *
 * A neighbour already pointing back **at this very room** is not a failure — it is the link, found
 * already made. Both ends of one doorway can be declared (nothing stops a hand-edited file doing it),
 * and refusing the second one would report a conflict between an exit and itself.
 */
function linkFailure(rooms: readonly Room[], room: Room, dir: Direction, to: RoomId): string | undefined {
  const neighbour = rooms.find((candidate) => candidate.id === to);
  if (!neighbour) return `room ${to} is not in this zone`;
  if (!isGeometricallyConsistent(room, dir, neighbour)) {
    return `room ${to} is no longer the cell ${dir} of (${room.pos.x},${room.pos.y}) on level ${room.pos.z}`;
  }
  const facing = neighbour.exits[OPPOSITE[dir]];
  if (facing && facing.to !== room.id) {
    return `room ${to} already has a ${OPPOSITE[dir]} exit, to ${facing.to}`;
  }
  return undefined;
}

/**
 * Hangs one validated room in its zone, and writes the reverse of every exit it carries.
 *
 * **Both ends, and `world.doorway` is the precedent** — A4's door ops work both sides for the reason
 * decision 3 restates: a doorway worked from one side only is a wall from the other. One function
 * owns the pairing so that the loader and the live editor cannot drift onto two answers.
 *
 * The casts are the same exception `applyRoomOverride` makes and are the reason this is a named
 * function rather than two lines at each call site: a zone's rooms and a room's exits are `readonly`
 * because *nothing in the simulation* may change them, and authoring is the one thing the type cannot
 * express.
 */
export function attachAuthoredRoom(zone: Zone, room: Room): void {
  (zone.rooms as Room[]).push(room);
  for (const [dir, exit] of Object.entries(room.exits)) {
    const neighbour = zone.rooms.find((candidate) => candidate.id === exit.to);
    if (!neighbour) continue;
    (neighbour.exits as Record<string, RoomExit>)[OPPOSITE[dir as Direction]] = { to: room.id };
  }
}

/**
 * Folds every authored room belonging to this zone into it, in place.
 *
 * **Two passes, and the order is load-bearing.** Placement first for all of them, linking second, so
 * that two authored rooms next to each other can be joined to each other — in one pass the first
 * would be asked to link to a room that had not been added yet. Ids are visited in order so that a
 * pair contending for one cell is refused deterministically rather than by map iteration order.
 *
 * Refusals are **returned rather than thrown**, and a refused room is left out of the world entirely
 * rather than placed somewhere else. Both halves matter: this file is hand-editable, one bad record
 * must not cost the rest of the overlay, and a room quietly relocated is worse than a room missing —
 * the boot log names what it dropped and why, which is the only moment anybody will see it.
 */
export function composeAuthoredRooms(
  zone: Zone,
  rooms: AuthoredRooms,
): { readonly added: readonly Room[]; readonly refused: readonly { readonly id: RoomId; readonly why: string }[] } {
  const mine = [...rooms.values()]
    .filter((authored) => authored.room.zone === zone.id)
    .sort((a, b) => a.room.id - b.room.id);

  const added: Room[] = [];
  const refused: { id: RoomId; why: string }[] = [];

  for (const authored of mine) {
    if (zone.rooms.some((room) => room.id === authored.room.id)) {
      refused.push({ id: authored.room.id, why: 'a room with this id is already in the zone' });
      continue;
    }
    const why = placementRefusal(zone.rooms, authored.room.pos);
    if (why) {
      refused.push({ id: authored.room.id, why });
      continue;
    }
    // A fresh copy, because the record on disk is the author's and the room in the zone is about to
    // be mutated by the simulation, by `relaxLocks`, and by A5's overrides.
    const room: Room = { ...authored.room, exits: { ...authored.room.exits } };
    (zone.rooms as Room[]).push(room);
    added.push(room);
  }

  for (const room of added) {
    for (const [dir, exit] of Object.entries(room.exits)) {
      const why = linkFailure(zone.rooms, room, dir as Direction, exit.to);
      if (why) {
        // The room stands; only the bad exit goes. A room with one of its two doorways missing is
        // still somewhere you can walk, and deleting it over a neighbour that moved would throw away
        // the prose as well as the link.
        delete (room.exits as Record<string, RoomExit>)[dir];
        refused.push({ id: room.id, why: `${dir} exit dropped: ${why}` });
        continue;
      }
      const neighbour = zone.rooms.find((candidate) => candidate.id === exit.to)!;
      (neighbour.exits as Record<string, RoomExit>)[OPPOSITE[dir as Direction]] = { to: room.id };
    }
  }

  return { added, refused };
}

/**
 * Reads the overlay, tolerating anything. The same posture as every sibling loader.
 *
 * The stored counter is trusted only so far as it is *ahead* of the records: a hand-edited file whose
 * `next` is behind a room it contains would hand out an id already in use, so the floor is raised to
 * clear whatever is actually there. Wrong in the safe direction, which is the only direction a number
 * allocator may be wrong in.
 */
export function loadAuthoredRooms(file = AUTHORED_ROOMS_FILE): AuthoredRoomStore {
  const rooms: AuthoredRooms = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been created yet.
    return { rooms, next: AUTHORED_ROOM_BASE };
  }
  if (typeof raw !== 'object' || raw === null) return { rooms, next: AUTHORED_ROOM_BASE };
  const parsed = raw as Record<string, unknown>;

  const records =
    typeof parsed.rooms === 'object' && parsed.rooms !== null ? (parsed.rooms as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(records)) {
    const id = Number(key);
    if (!Number.isInteger(id)) continue;
    const authored = readAuthoredRoom(id as RoomId, value);
    if (authored) rooms.set(id as RoomId, authored);
  }

  let next = readInt(parsed.next) ?? AUTHORED_ROOM_BASE;
  for (const id of rooms.keys()) if (id >= next) next = id + 1;
  return { rooms, next: Math.max(next, AUTHORED_ROOM_BASE) };
}

/**
 * Writes the whole overlay: the counter, then the records sorted by id.
 *
 * Each record is flat rather than `{ room: {...}, at }`, like `items-authored.json` — the file is
 * meant to be read and hand-edited, and a second level of nesting per entry buys nothing a reader
 * wants. Exits are written as direction → destination, which is the room's own shape with the
 * `RoomExit` wrapper dropped: an authored exit has no door and no portal, so the wrapper would be one
 * key holding one key.
 */
export function saveAuthoredRooms(store: AuthoredRoomStore, file = AUTHORED_ROOMS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const records: Record<string, unknown> = {};
  for (const id of [...store.rooms.keys()].sort((a, b) => a - b)) {
    const authored = store.rooms.get(id)!;
    const { room } = authored;
    const exits: Record<string, RoomId> = {};
    for (const [dir, exit] of Object.entries(room.exits)) exits[dir] = exit.to;
    records[String(id)] = {
      id: room.id,
      zone: room.zone,
      name: room.name,
      ...(room.description !== undefined ? { description: room.description } : {}),
      sector: room.sector,
      ...(room.flags && room.flags.length > 0 ? { flags: room.flags } : {}),
      x: room.pos.x,
      y: room.pos.y,
      level: room.pos.z,
      exits,
      ...(authored.at ? { at: authored.at } : {}),
      ...(authored.by ? { by: authored.by } : {}),
      ...(authored.brief ? { brief: authored.brief } : {}),
    };
  }
  writeFileSync(file, `${JSON.stringify({ next: store.next, rooms: records }, null, 2)}\n`);
}

/**
 * Takes the next id, and advances the counter past it.
 *
 * Mutates deliberately: allocation and recording that the allocation happened must not be separable,
 * or a caller that forgets the second half hands the same id out twice.
 */
export function takeAuthoredRoomId(store: AuthoredRoomStore): RoomId {
  const id = Math.max(store.next, AUTHORED_ROOM_BASE);
  store.next = id + 1;
  return id as RoomId;
}
