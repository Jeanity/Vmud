/**
 * A harvested zone's **name**, re-authored — the one field no overlay could reach.
 *
 * Every other piece of a harvested zone has had an overlay since Phase 15c: rooms have
 * `rooms.json` (name, prose, sector, flags), mobs have `mobs.json`, items have `items.json`. A
 * *zone's* name had none, because nothing had ever needed one: `zones-authored.json` names zones
 * we created, and the harvest's own names came off the zMUD map and were treated as fact.
 *
 * The Tordraken rewrite is what needed it (owner, 2026-08-09: *"I would also like to rename Icecrag
 * Castle to Tordraken Castle… so it will need a rewrite"*). The zone name is what the client prints
 * on the place card and what the admin panel lists, so a castle re-themed room by room while its
 * zone still announced itself as IceCrag would be a rename that stopped at the door.
 *
 * Deliberately thin, and deliberately *not* merged into `rooms.json`: that file is keyed by room id
 * and a zone id in it would be a second id space sharing one map. Composed at boot exactly as room
 * overrides are — see `GameWorld.load` — so `npm run worldgen` can rebuild the harvest underneath a
 * rename for ever, which is the property every overlay in this project exists to have.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Zone, ZoneId } from '@mygame/shared';

// The path is computed here rather than imported from `world.ts` — `world.ts` composes *this*
// module at load, and an import back would be a cycle. `settings.ts` does the same for the same
// reason, and the duplication is three lines against a knot.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Beside its siblings, and for their reason: nothing regenerates it. */
export const ZONE_OVERRIDES_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'zones.json');

/** How long a zone's name may be — `zone-authoring.ts`'s own bound, shared by hand rather than imported to keep this module standalone. */
export const ZONE_NAME_LIMIT = 60;

export interface ZoneOverride {
  readonly name?: string;
  readonly at?: string;
  readonly by?: string;
}

export type ZoneOverrideStore = Map<ZoneId, ZoneOverride>;

/**
 * Reads the overlay, tolerating anything — every sibling loader's posture. A malformed row is
 * dropped rather than thrown on: a hand-edited file must not be able to stop the server booting,
 * and a zone that keeps its harvested name is a cosmetic loss, not a broken world.
 */
export function loadZoneOverrides(file = ZONE_OVERRIDES_FILE): ZoneOverrideStore {
  const store: ZoneOverrideStore = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return store;
  }
  if (typeof raw !== 'object' || raw === null) return store;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id)) continue;
    if (typeof value !== 'object' || value === null) continue;
    const row = value as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > ZONE_NAME_LIMIT) continue;
    store.set(id as ZoneId, {
      name,
      ...(typeof row.at === 'string' ? { at: row.at } : {}),
      ...(typeof row.by === 'string' ? { by: row.by } : {}),
    });
  }
  return store;
}

export function saveZoneOverrides(store: ZoneOverrideStore, file = ZONE_OVERRIDES_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, ZoneOverride> = {};
  for (const id of [...store.keys()].sort((a, b) => a - b)) out[String(id)] = store.get(id)!;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

/**
 * Applies a rename to a zone in place, returning whether it changed anything.
 *
 * In place because `GameWorld` already mutates the zone objects it loads (see `relaxLocks`), and a
 * rebuilt record here would be a second copy for every consumer to disagree over.
 */
export function applyZoneOverride(zone: { name: string; id: ZoneId }, store: ZoneOverrideStore): boolean {
  const override = store.get(zone.id);
  if (!override?.name || override.name === zone.name) return false;
  zone.name = override.name;
  return true;
}

/** Convenience for callers holding a whole `Zone`. */
export function renameZones(zones: readonly Zone[], store: ZoneOverrideStore): number {
  let renamed = 0;
  for (const zone of zones) {
    if (applyZoneOverride(zone as { name: string; id: ZoneId }, store)) renamed += 1;
  }
  return renamed;
}
