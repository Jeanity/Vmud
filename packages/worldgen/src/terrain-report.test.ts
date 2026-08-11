/**
 * M1 acceptance: the repaired sector-inference pipeline against the real generated world.
 *
 * Reads `data/world/terrain-report.json`, the per-zone/world-wide provenance sidecar `npm run
 * worldgen` now writes (see `index.ts`'s `buildProvenanceReport`/`reportSectorProvenance`), plus the
 * zone files themselves for the one assertion that needs actual sector values rather than provenance
 * counts. `data/world` is git-ignored and reproducible — this follows the same skip-if-absent shape
 * as `packages/server/src/world.test.ts`'s "GameWorld against the generated world" block.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORLD_DIR = join(REPO_ROOT, 'data', 'world');
const REPORT_PATH = join(WORLD_DIR, 'terrain-report.json');

interface ZoneProvenance {
  readonly id: number;
  readonly name: string;
  readonly rooms: number;
  readonly byBucket: Readonly<Record<string, number>>;
}

interface ProvenanceReport {
  readonly totalRooms: number;
  readonly worldwide: Readonly<Record<string, number>>;
  readonly zonesFullyDefaulted: number;
  readonly zones: readonly ZoneProvenance[];
}

describe('M1: sector inference against the generated world', () => {
  const dataPresent = existsSync(REPORT_PATH);

  if (!dataPresent) {
    it('skips: data/world/terrain-report.json is absent', (t) => {
      t.skip(`no generated world data at ${REPORT_PATH} (git-ignored) — run \`npm run worldgen\` first`);
    });
    return;
  }

  const report = JSON.parse(readFileSync(REPORT_PATH, 'utf8')) as ProvenanceReport;
  const defaultedPct = (z: ZoneProvenance): number => (z.rooms === 0 ? 0 : (100 * z.byBucket.default!) / z.rooms);
  const zoneNamed = (name: string): ZoneProvenance => {
    const zone = report.zones.find((z) => z.name === name);
    assert.ok(zone, `zone ${JSON.stringify(name)} not found in the built world — renamed, removed, or not built?`);
    return zone!;
  };

  it('defaults fewer than 2% of rooms world-wide after the full pass', () => {
    const pct = (100 * report.worldwide.default!) / report.totalRooms;
    assert.ok(pct < 2, `world default share is ${pct.toFixed(2)}%, want < 2%`);
  });

  /**
   * Six zones stay 100% defaulted, and every one is verified structurally unfixable rather than a
   * gap in this milestone: each is a connected component with zero cross-zone exits (checked by hand
   * against the built zone files, 2026-08-11), so `diffuseSectors` counts it as *residual* by design
   * — "leaves a seedless component exactly as it was" is `diffuse.test.ts`'s own documented behaviour,
   * not a bug here. The name tier has nothing to work with either:
   *
   * - zone 35 "Color legend" — 18 rooms, every one literally named "An unnamed place" (no `Name` in
   *   the source row at all) and with zero exits, not even to each other. A mapper scratch area.
   * - zones 350 and 407 "Pirate Ship, Captain's Fancy" — a movable vehicle, 3 rooms each (Foredeck /
   *   Maindeck / Aft Deck) linked only to one another. "Deck" is correctly not a biome word.
   * - zone 378 "Scornubel Ferry" and zone 392 "The Chionthar Ferry" — the same shape, a self-contained
   *   dock/ferry structure with no link into the walking world.
   * - zone 412 "Rimi Greatoath dagger quest" — a 2-room quest lair, reached by trigger rather than by
   *   walking in, so it carries no graph evidence either.
   *
   * A name+graph pipeline cannot label a component that offers it neither kind of evidence without
   * inventing one — that is what the hand-authored override layer under `data/world/overrides/` is
   * for, out of scope for this milestone. Every *other* zone, however small, must still resolve,
   * which is what this assertion actually checks; and the exception list is closed, not open-ended —
   * if a seventh zone turns up fully defaulted, that is a real regression, not a new exhibit for this
   * list.
   */
  it('leaves no zone 100% defaulted, except the six verified-isolated non-standard ones', () => {
    const knownUnfixable = new Set([35, 350, 378, 392, 407, 412]);
    const stillFullyDefaulted = report.zones.filter(
      (z) => z.rooms > 0 && z.byBucket.default === z.rooms && !knownUnfixable.has(z.id),
    );
    assert.deepEqual(
      stillFullyDefaulted.map((z) => `${z.id} ${z.name}`),
      [],
      'a zone outside the documented exception list is now 100% defaulted',
    );
    // The exception list itself must not grow silently — if it does, a real zone regressed.
    assert.equal(report.zonesFullyDefaulted, knownUnfixable.size);
  });

  it('resolves The Nightwood (zone 390, the flagship symptom) to forest', () => {
    const zone = zoneNamed('The Nightwood');
    const data = JSON.parse(readFileSync(join(WORLD_DIR, 'zones', `${zone.id}.json`), 'utf8')) as {
      rooms: readonly { id: number; name: string; sector: string }[];
    };
    assert.equal(data.rooms.length, zone.rooms, 'zone file and provenance report disagree on room count');
    for (const room of data.rooms) {
      assert.equal(room.sector, 'forest', `room ${room.id} (${JSON.stringify(room.name)}) is ${room.sector}, not forest`);
    }
  });

  for (const name of ['The Labyrinth', 'The Ruins of Undermountain I', 'Silverymoon, Gem of the North']) {
    it(`fixes the named regression case: ${name}`, () => {
      const zone = zoneNamed(name);
      const pct = defaultedPct(zone);
      assert.ok(pct < 5, `${name} (zone ${zone.id}) is ${pct.toFixed(1)}% defaulted, want < 5%`);
    });
  }

  it('fixes the named regression case: the Grid-UD-* zones (auto-generated Underdark travel grids)', () => {
    const grids = report.zones.filter((z) => z.name.startsWith('Grid-UD-'));
    assert.ok(grids.length > 0, 'no Grid-UD-* zones found in the built world');
    for (const zone of grids) {
      const pct = defaultedPct(zone);
      assert.ok(pct < 5, `${zone.name} (zone ${zone.id}) is ${pct.toFixed(1)}% defaulted, want < 5%`);
    }
  });
});
