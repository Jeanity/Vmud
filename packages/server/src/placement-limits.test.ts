/**
 * The rule an authored placement may not break: **a spawn limit is world-wide.**
 *
 * `reset.ts` gates an `M` on `countOf(vnum) < limit`, and `sim.countOf` counts that vnum everywhere.
 * A harvested zone's own commands carry a limit equal to its own population — zone 64 asks for three
 * faerie guards at limit 3 — so the moment a *second* zone stands more of the same vnum, the first
 * zone's resets stop firing. It is a one-way ratchet: the newcomer keeps what the original loses.
 *
 * That is not theoretical. The Faerie Courts first shipped reusing fifteen of zone 64's vnums, and a
 * replay of the merged tables had zone 64 respawning **zero** of vnum 14067 — whose third `M` carries
 * the chained `E` that is the only source of **Finn's signet ring**, the objective of a live quest. So
 * the courts were given their own cloned templates, and this test is what stops the shortcut coming
 * back the next time somebody wants a creature that already exists somewhere else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { WORLD_DIR } from './world.ts';

const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));

describe('authored placements and the world-wide limit', () => {
  it('never places a vnum a harvested zone already spawns', () => {
    const placements = read(join(WORLD_DIR, 'overrides', 'placements.json')) as Record<string, unknown>;
    const placed = Object.keys(placements).filter((k) => /^\d+$/.test(k)).map(Number);

    // Every vnum a harvested population file spawns, across the whole harvest rather than the loaded
    // subset: a zone switched on later must not retroactively break a placement written today.
    const spawned = new Set<number>();
    let files = 0;
    const index = read(join(WORLD_DIR, 'index.json')) as { zones: readonly { id: number }[] };
    for (const zone of index.zones) {
      let file: unknown;
      try {
        file = read(join(WORLD_DIR, 'spawns', `${zone.id}.json`));
      } catch {
        continue; // No harvest for this zone; nothing it can claim.
      }
      files++;
      for (const reset of (file as { resets: readonly { kind: string; what: number }[] }).resets) {
        if (reset.kind === 'mob') spawned.add(reset.what);
      }
    }
    assert.ok(files > 0, 'no harvested population files found — the check would pass vacuously');

    const collisions = placed.filter((vnum) => spawned.has(vnum));
    assert.deepEqual(
      collisions,
      [],
      `these placed vnums are also spawned by a harvested zone, which starves that zone: ${collisions.join(', ')}. ` +
        'Clone the template to an authored vnum and place the clone instead.',
    );
  });
});
