/**
 * Authored world content — the overlay that survives `npm run worldgen`.
 *
 * Track A5, and the rule it exists to keep is `DESIGN-admin-panel.md` §1: **the base data under
 * `data/world/` is generated**, so an edit made there is destroyed by the next rebuild. Authoring
 * therefore lands *beside* the harvest rather than inside it, and the loader composes the two. The
 * harvest is the floor; this is what somebody wrote on top of it.
 *
 * ## Why this file is git-tracked when everything else under `data/` is not
 *
 * `data/zones-source/` is third-party and `data/world/` is reproducible, so both are ignored. This
 * directory is neither: it is the only thing under `data/` that **no command can regenerate**, and
 * leaving hand-authored prose in an ignored directory is how you lose it to a fresh clone. The
 * `.gitignore` carries a negation for exactly this path.
 *
 * **One caveat worth stating rather than discovering.** An override that *edits* a harvested
 * description is derived from the Duris text, so it inherits the same distribution restriction as
 * the rest of the harvest — `CLAUDE.md`'s rule that third-party prose is stripped from anything we
 * ship applies to a lightly-edited copy of it too. A room written from nothing is ours.
 *
 * ## What it may override
 *
 * Only the fields a builder authors: the room's name, its prose, its terrain and its flags.
 * **Never its id, its position or its exits** — those are geometry, they are the join key and the
 * grid, and changing them is A8's problem with four decisions in front of it (see `ROADMAP.md`).
 * Refusing them here is what keeps this slice honest rather than half of a geometry editor.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOM_FLAGS, SECTORS, type Room, type RoomFlag, type RoomId, type Sector, type Zone } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OVERRIDES_DIR = join(REPO_ROOT, 'data', 'world', 'overrides');

/** Where authored rooms live. Exported so the reader and the writer cannot drift onto two files. */
export const ROOMS_FILE = join(OVERRIDES_DIR, 'rooms.json');

/** What an author may change about a room. Every field optional — an override is a *patch*. */
export interface RoomOverride {
  readonly name?: string;
  readonly description?: string;
  readonly sector?: Sector;
  readonly flags?: readonly RoomFlag[];
  /** When it was last written, so the panel can say how stale a room's authoring is. */
  readonly at?: string;
}

export type RoomOverrides = Map<RoomId, RoomOverride>;

const SECTOR_SET = new Set<string>(SECTORS);
const FLAG_SET = new Set<string>(ROOM_FLAGS);

/**
 * Reads the overlay, tolerating anything.
 *
 * Hand-editable by design — it is a small JSON file of authored content and somebody will open it —
 * so every field is validated against its own catalogue rather than trusted. A sector the game does
 * not have or a flag it does not read is dropped with a warning, because the alternative is a room
 * whose terrain is `"forrest"` and whose movement cost is therefore `undefined`, which propagates
 * as `NaN` into a pool and makes every later comparison false. Same posture as `players.ts`.
 */
export function loadRoomOverrides(file = ROOMS_FILE): RoomOverrides {
  const out: RoomOverrides = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been authored yet.
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = Number(key);
    if (!Number.isInteger(id) || typeof value !== 'object' || value === null) continue;
    const patch = value as Record<string, unknown>;
    const override: RoomOverride = {
      ...(typeof patch.name === 'string' && patch.name.trim() ? { name: patch.name.trim() } : {}),
      ...(typeof patch.description === 'string' ? { description: patch.description } : {}),
      ...(typeof patch.sector === 'string' && SECTOR_SET.has(patch.sector) ? { sector: patch.sector as Sector } : {}),
      ...(Array.isArray(patch.flags)
        ? { flags: (patch.flags as unknown[]).filter((f): f is RoomFlag => typeof f === 'string' && FLAG_SET.has(f)) }
        : {}),
      ...(typeof patch.at === 'string' ? { at: patch.at } : {}),
    };
    if (Object.keys(override).length > 0) out.set(id as RoomId, override);
  }
  return out;
}

/** Writes the whole overlay. Small enough that rewriting beats a partial update it could get wrong. */
export function saveRoomOverrides(overrides: RoomOverrides, file = ROOMS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, RoomOverride> = {};
  // Sorted by id, so a hand-read diff of this file shows what changed rather than a reshuffle.
  for (const id of [...overrides.keys()].sort((a, b) => a - b)) out[String(id)] = overrides.get(id)!;
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * Folds the overlay into a freshly-loaded zone, in place.
 *
 * At load rather than at read time: the world is read thousands of times a tick and authored once in
 * a while, so composing on every lookup would pay for authoring forever. The live editor mutates the
 * same room objects afterwards through {@link applyRoomOverride}, which is why the two must agree
 * about what a patch means — hence one function.
 */
export function applyOverridesToZone(zone: Zone, overrides: RoomOverrides): number {
  let applied = 0;
  for (const room of zone.rooms) {
    const override = overrides.get(room.id);
    if (!override) continue;
    applyRoomOverride(room, override);
    applied++;
  }
  return applied;
}

/**
 * Applies one patch to one room.
 *
 * **The single writer of authored world content**, and the cast is the reason it is a named function
 * rather than four assignments at the call site: `Room`'s fields are `readonly` because nothing in
 * the simulation may change them, and authoring is the one exception the type cannot express. Keeping
 * it here means there is exactly one place to look for "what can an author change", and the answer is
 * visible in four lines — no id, no position, no exits.
 */
export function applyRoomOverride(room: Room, override: RoomOverride): void {
  const mutable = room as {
    name: string;
    description?: string;
    sector: Sector;
    flags?: readonly RoomFlag[];
  };
  if (override.name !== undefined) mutable.name = override.name;
  if (override.description !== undefined) mutable.description = override.description;
  if (override.sector !== undefined) mutable.sector = override.sector;
  if (override.flags !== undefined) mutable.flags = [...override.flags];
}

/** Merges a patch onto whatever was already authored for a room, stamping the time. */
export function mergeOverride(
  overrides: RoomOverrides,
  id: RoomId,
  patch: RoomOverride,
  now: string,
): RoomOverride {
  const merged: RoomOverride = { ...overrides.get(id), ...patch, at: now };
  overrides.set(id, merged);
  return merged;
}
