/**
 * Where an authored creature **lives** — **A9c**, the sixth overlay.
 *
 * Owner's ask, 2026-08-06: *"the mob needs to be assigned a room in a zone and not just dropped by hand."*
 * A9b made a creature that could be spawned; without this it could only be *put* somewhere, once, by an
 * operator, and lost on the next restart. A mob that has to be placed by hand is scenery an operator
 * maintains rather than population a zone has.
 *
 * ## Why this cannot be written into `data/world/spawns/`
 *
 * That is where a zone's population actually lives, and it is a **build output of `npm run worldgen`** —
 * `data/world/*` is git-ignored and reproducible by design. A reset written there would be erased by the
 * next harvest, which is the exact rule A4c's overlay exists to obey: *authoring lands as overlay files
 * the game loads, never as edits to generated data*. So placements live here, beside the other five, and
 * are merged into a zone's reset table at load.
 *
 * ## A placement is an `M` command, and nothing more
 *
 * That is the whole trick. `runReset` already reads its templates out of the same map A9b adds created
 * mobs to, so a reset naming vnum 9,000,000 needs **no** change to the executor: it finds the template,
 * checks the limit, and spawns. The case the roadmap flagged as unprecedented — *a reset naming a mob
 * vnum with no `.mob` record behind it* — turns out to be unprecedented only in the **harvester**, which
 * never runs against these.
 *
 * **Appended rather than interleaved**, and it matters. A zone file's order is load-bearing: `G` and `E`
 * attach to *the last mobile loaded*, so inserting an `M` in the middle of a harvested table would hand
 * somebody else's sword to a creature we added. Every authored placement therefore lands at the end with
 * `ifPrevious: false`, where it can neither steal a cursor nor be skipped by one. Authored *loot* is
 * unaffected, because A4c applies it per template after the whole pass.
 *
 * ## Keyed by mob, executed by zone
 *
 * The file is keyed by **vnum**, because that is the question an operator asks — *where does this thing
 * live?* — and it means a creature's placements travel with it rather than being scattered across the
 * zones they happen to fall in. The zone is **derived** from the room at merge time, so it is not a field
 * anybody can get wrong, and a room that moves zone takes its placements with it.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ResetCommand, RoomId } from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Where placements live — beside the other five overlays, and exported for the same reason. */
export const PLACEMENTS_FILE = join(REPO_ROOT, 'data', 'world', 'overrides', 'placements.json');

/** One room a mob is authored to appear in, and how many of it the world may hold. */
export interface Placement {
  readonly room: RoomId;
  /**
   * The **world-wide** cap on this vnum, Duris' `arg2` — not a per-room one.
   *
   * `mob_index[].number` is a global count in the source, which is what makes a lured mob suppress its
   * own replacement: walk the sentry away from its post and the zone will not quietly mint a second one
   * behind you. Two placements of one vnum therefore share a budget, and that is the source's behaviour
   * rather than a simplification of it — so the highest limit among a vnum's placements is the number of
   * them that can stand at once, however many rooms they are spread across.
   */
  readonly limit: number;
}

/** Every authored placement, by mob vnum. */
export type Placements = Map<number, readonly Placement[]>;

/** The most rooms one creature may be authored into. Past this it is a zone, not a placement. */
export const MAX_PLACEMENTS_PER_MOB = 24;

/** The most of one vnum the world may be authored to hold. The harvest's own highest is well under this. */
export const MAX_PLACEMENT_LIMIT = 99;

/** One placement row off disk, or nothing. */
function readPlacement(raw: unknown): Placement | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.room !== 'number' || !Number.isInteger(row.room)) return undefined;
  const limit = typeof row.limit === 'number' && Number.isInteger(row.limit) ? row.limit : 1;
  return { room: row.room as RoomId, limit: Math.min(MAX_PLACEMENT_LIMIT, Math.max(1, limit)) };
}

/**
 * Reads the overlay, tolerating anything — the posture every sibling loader takes.
 *
 * A malformed row is dropped rather than guessed at: a placement with no room is a reset that would spawn
 * nothing, and one that silently never fires is indistinguishable from the feature not working.
 */
export function loadPlacements(file = PLACEMENTS_FILE): Placements {
  const out = new Map<number, readonly Placement[]>();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No overlay is the ordinary case — nothing has been placed yet.
    return out;
  }
  if (typeof raw !== 'object' || raw === null) return out;

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum) || !Array.isArray(value)) continue;
    const rows = (value as unknown[])
      .map(readPlacement)
      .filter((row): row is Placement => row !== undefined)
      .slice(0, MAX_PLACEMENTS_PER_MOB);
    if (rows.length > 0) out.set(vnum, rows);
  }
  return out;
}

/**
 * Writes the whole overlay, sorted by vnum so a hand-read diff shows what changed.
 *
 * A vnum with no rows is **dropped rather than written**, the rule every overlay here keeps: an empty
 * list is not a placed mob, it is the record of one having been placed and then unplaced.
 */
export function savePlacements(placements: Placements, file = PLACEMENTS_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const out: Record<string, readonly Placement[]> = {};
  for (const vnum of [...placements.keys()].sort((a, b) => a - b)) {
    const rows = placements.get(vnum)!;
    if (rows.length === 0) continue;
    out[String(vnum)] = rows;
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
}

/**
 * Every authored placement as a reset command, grouped by the zone whose table it belongs in.
 *
 * `zoneOf` is passed in rather than imported so this file stays free of the world machinery — the same
 * injection `mob-overrides.ts` uses for `instantiate`, and for the same reason.
 *
 * A room the world does not know yields **no** command rather than a command with a bad room: a reset
 * that points nowhere would fail silently on every repop for ever, and the write path refuses such a room
 * up front so this case only arises when a zone is unloaded underneath an overlay written earlier.
 *
 * `percent: 100` because that is not a tuning knob. `runReset` fires an `M` on a timed repop **only** at
 * exactly 100 — measured across both matched zones, all 332 harvested `M` commands are at 100, so mob
 * spawns are deterministic and the randomness lives in the loot. Anything less here would be a placement
 * that mostly did not happen.
 */
export function placementResets(
  placements: Placements,
  zoneOf: (room: RoomId) => number | undefined,
): Map<number, ResetCommand[]> {
  const byZone = new Map<number, ResetCommand[]>();
  for (const [vnum, rows] of placements) {
    for (const row of rows) {
      const zone = zoneOf(row.room);
      if (zone === undefined) continue;
      const commands = byZone.get(zone) ?? [];
      commands.push({
        kind: 'mob',
        // Never chained: an authored placement must not be skipped because a harvested command above it
        // failed, and must not become the cursor a harvested `G` attaches to.
        ifPrevious: false,
        what: vnum,
        limit: row.limit,
        room: row.room,
        percent: 100,
      });
      byZone.set(zone, commands);
    }
  }
  return byZone;
}
