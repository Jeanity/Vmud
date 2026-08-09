/**
 * Zones that were **made here** — A8d, the seventh overlay, and the smallest: a name against a
 * number.
 *
 * A8 builds rooms *inside* a Place that already exists; this is the record that lets a Place exist to
 * build in. It is deliberately thin, because almost everything about a zone lives elsewhere and the
 * roadmap's three cases say where the weight actually went:
 *
 * 1. **The id** comes from {@link AUTHORED_ZONE_BASE} with a **stored** counter — A6b's argument, for
 *    the third time: derived-from-highest recycles the number of whatever was deleted last, and a
 *    zone id is a join key, a spawns directory name and a `world.config.json` line all at once.
 * 2. **A zone with no rooms has no extent**, so its *first* room is placed by `composeAuthoredRooms`'
 *    origin exception rather than by the join-a-neighbour rule — see the note there. This store never
 *    holds geometry; the rooms live in `rooms-authored.json` like every other created room, keyed to
 *    the zone by their own `zone` field.
 * 3. **Which zones load stays a file.** Creating a zone writes this overlay and nothing else; the id
 *    must then be added to `world.config.json` and the server restarted, and the response says so in
 *    those words. A panel that wrote the config would need a restart to matter anyway, and one that
 *    taught `GameWorld` to add a zone live is a different size of job — the roadmap's own sizing,
 *    kept. The one concession to liveness: {@link GameWorld.load} refuses **loudly** when the config
 *    names an authored zone this file does not hold, exactly as `loadZone` refuses a missing harvest
 *    file, because a typo'd id silently skipped is a world missing a map with nothing to say why.
 *
 * A zone created here is an island until somebody links it: A8 refuses vertical links by name and
 * infill only joins rooms inside one Place, so the first exit *into* an authored zone is its own
 * problem and is not solved in this slice. An operator reaches it by teleport, which is honest — it
 * is a building site, not a destination.
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHORED_ZONE_BASE, type ZoneId } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Beside its six siblings, and exported for the same reason they are. */
export const AUTHORED_ZONES_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'zones-authored.json');

/** A created zone: the name, and the provenance every overlay records. Geometry lives with the rooms. */
export interface AuthoredZone {
  readonly name: string;
  readonly at?: string;
  readonly by?: string;
}

export interface AuthoredZoneStore {
  readonly zones: Map<ZoneId, AuthoredZone>;
  /** The next id to hand out. Stored, never derived — see the header. */
  next: ZoneId;
}

/** How long a zone's name may be. The panel clamps too; the store is the gate. */
export const ZONE_NAME_MAX = 60;

/** A well-formed name, or nothing. One rule, shared by the loader and the route. */
export function readZoneName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim();
  if (!name || name.length > ZONE_NAME_MAX) return undefined;
  return name;
}

/**
 * Reads the overlay, tolerating anything — the posture of every sibling loader, and the same counter
 * rule `loadAuthoredRooms` states: the stored `next` is trusted only so far as it is *ahead* of the
 * records, so a hand-edited file cannot hand out an id already in use. Wrong in the safe direction,
 * the only direction an allocator may be wrong in.
 */
export function loadAuthoredZones(file = AUTHORED_ZONES_FILE): AuthoredZoneStore {
  const zones = new Map<ZoneId, AuthoredZone>();
  let next = AUTHORED_ZONE_BASE;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been created yet.
    return { zones, next: next as ZoneId };
  }
  if (typeof raw !== 'object' || raw === null) return { zones, next: next as ZoneId };
  const parsed = raw as Record<string, unknown>;

  const records =
    typeof parsed.zones === 'object' && parsed.zones !== null ? (parsed.zones as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(records)) {
    const id = Number(key);
    // Below the base is either a typo or an attempt to claim a harvested id; both are dropped, because
    // honouring one would let a hand edit shadow a real zone.
    if (!Number.isInteger(id) || id < AUTHORED_ZONE_BASE) continue;
    if (typeof value !== 'object' || value === null) continue;
    const record = value as Record<string, unknown>;
    const name = readZoneName(record.name);
    if (!name) continue;
    zones.set(id as ZoneId, {
      name,
      ...(typeof record.at === 'string' ? { at: record.at } : {}),
      ...(typeof record.by === 'string' ? { by: record.by } : {}),
    });
    if (id >= next) next = id + 1;
  }

  if (typeof parsed.next === 'number' && Number.isInteger(parsed.next) && parsed.next > next) {
    next = parsed.next;
  }
  // **Committed zones claim their ids too** — Phase 22. `data/authored/` zones share this band and
  // declare their ids by hand, so the counter must vault past any the built world already holds, or
  // the panel's next created zone would silently *become* a Velen district across three files.
  // Read from the built zones directory beside this overlay rather than from `data/authored/`,
  // because this module's survival posture is importing nothing and trusting only what the server
  // already boots from; a missing directory is a world not yet generated, which allocates nothing.
  try {
    for (const entry of readdirSync(join(dirname(file), '..', 'zones'))) {
      const id = Number(entry.replace(/\.json$/, ''));
      if (Number.isInteger(id) && id >= AUTHORED_ZONE_BASE && id >= next) next = id + 1;
    }
  } catch {
    /* no built world, nothing to skip */
  }
  return { zones, next: next as ZoneId };
}

/** Writes the whole overlay, ids ascending so a diff shows the change rather than a reshuffle. */
export function saveAuthoredZones(store: AuthoredZoneStore, file = AUTHORED_ZONES_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const zones: Record<string, AuthoredZone> = {};
  for (const id of [...store.zones.keys()].sort((a, b) => a - b)) zones[String(id)] = store.zones.get(id)!;
  writeFileSync(file, `${JSON.stringify({ next: store.next, zones }, null, 2)}\n`);
}

/** Takes the next id and advances the counter — `takeAuthoredRoomId`'s contract, one level up. */
export function takeAuthoredZoneId(store: AuthoredZoneStore): ZoneId {
  const id = Math.max(store.next, AUTHORED_ZONE_BASE);
  store.next = (id + 1) as ZoneId;
  return id as ZoneId;
}
