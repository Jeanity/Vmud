/**
 * Loading a zone's population — and the case where there is no file to load.
 *
 * The interesting half is {@link emptyZoneSpawns}, because it is where *this zone has no harvest* stopped
 * meaning *this zone can never be populated*. A zone reaches the reset clock only by way of a
 * `ZoneSpawns`, and authored placements are **merged into** a zone's table rather than being a table of
 * their own — so before the shell, a placement into an unharvested zone was counted homeless and never
 * spawned, and the symptom pointed at the placement rather than at the absent zone.
 *
 * What is pinned here is that the shell is a *real* entry — empty tables, but a lifespan a clock can roll
 * — and that it stays empty, since anything it carried would be population nobody authored.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { RoomId, ZoneId } from '@mygame/shared';

import { placementResets, type Placements } from './placements.ts';
import {
  AUTHORED_LIFESPAN_MAX,
  AUTHORED_LIFESPAN_MIN,
  emptyZoneSpawns,
  indexTemplates,
  loadItemCatalogue,
} from './spawns.ts';

describe('a zone populated without a harvest', () => {
  it('is a real entry rather than nothing, so its clock can run', () => {
    const spawns = emptyZoneSpawns(423 as ZoneId);
    assert.equal(spawns.zone, 423);
    assert.deepEqual(spawns.templates, []);
    assert.deepEqual(spawns.resets, []);
  });

  it('carries a lifespan a repop can be rolled from', () => {
    // A zone whose lifespan window were zero-width, or inverted, would either never repop or throw when
    // the clock rolled it. Both failures are invisible until the first repop is due.
    const spawns = emptyZoneSpawns(226 as ZoneId);
    assert.ok(spawns.lifespanMin > 0, 'a zero lifespan is a clock that repops every tick');
    assert.ok(spawns.lifespanMax >= spawns.lifespanMin, 'the window must not be inverted');
    assert.equal(spawns.lifespanMin, AUTHORED_LIFESPAN_MIN);
    assert.equal(spawns.lifespanMax, AUTHORED_LIFESPAN_MAX);
  });

  it('names its source rather than leaving it blank, so a trace can say where it came from', () => {
    // Also: `authored` can never collide with a `.wld` filename, which is what every harvested zone
    // puts in this field.
    assert.equal(emptyZoneSpawns(423 as ZoneId).source, 'authored');
    assert.ok(!emptyZoneSpawns(423 as ZoneId).source.endsWith('.wld'));
  });

  it('contributes no templates, because a template is world-wide and belongs to whoever defined it', () => {
    const templates = indexTemplates([emptyZoneSpawns(226 as ZoneId), emptyZoneSpawns(423 as ZoneId)]);
    assert.equal(templates.size, 0);
  });

  it('is the same shape for any zone — it is a rule, not a faerie special case', () => {
    // Phase 22's authored city zones will have no harvested file either. Nothing here may key off which
    // zone is asking.
    const { zone: _faerie, ...faerie } = emptyZoneSpawns(423 as ZoneId);
    const { zone: _city, ...city } = emptyZoneSpawns(999_001 as ZoneId);
    assert.deepEqual(faerie, city);
  });
});

describe('placements reaching a zone that has no harvest', () => {
  it('lands in the shell’s zone, so nothing authored into it is homeless', () => {
    // The bug this closes: the zone had no `ZoneSpawns`, so there was no table for these commands to be
    // merged into and the boot counted them as placed in rooms the server had not loaded.
    const spawns = emptyZoneSpawns(423 as ZoneId);
    const placements: Placements = new Map([
      [9_000_100, [{ room: 96_956 as RoomId, limit: 2 }]],
      [9_000_101, [{ room: 97_233 as RoomId, limit: 1 }]],
    ]);
    const byZone = placementResets(placements, (room) => (room === 96_956 || room === 97_233 ? 423 : undefined));

    const merged = { ...spawns, resets: [...spawns.resets, ...(byZone.get(spawns.zone) ?? [])] };
    assert.equal(merged.resets.length, 2);
    assert.deepEqual(
      merged.resets.map((r) => r.what),
      [9_000_100, 9_000_101],
    );
    const placed = [...placements.values()].reduce((sum, rows) => sum + rows.length, 0);
    const homed = [...byZone.values()].reduce((sum, rows) => sum + rows.length, 0);
    assert.equal(placed - homed, 0, 'every placement found a zone');
  });

  it('leaves the shell empty when nothing is authored into it', () => {
    const spawns = emptyZoneSpawns(226 as ZoneId);
    const byZone = placementResets(new Map(), () => 226);
    const merged = { ...spawns, resets: [...spawns.resets, ...(byZone.get(spawns.zone) ?? [])] };
    assert.equal(merged.resets.length, 0);
  });
});

describe('the item catalogue', () => {
  it('is empty rather than fatal when there is no file, as an absent population file is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-spawns-'));
    assert.equal(loadItemCatalogue(join(dir, 'nothing-here.json')).size, 0);
  });

  it('refuses a malformed file rather than half-loading it, because that means the pipeline is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-spawns-'));
    const file = join(dir, 'items.json');
    writeFileSync(file, '{"not":"an array"}');
    assert.throws(() => loadItemCatalogue(file), /malformed/);
  });

  it('drops a row missing the fields everything downstream assumes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-spawns-'));
    const file = join(dir, 'items.json');
    // The second row has no `size`; without the check it would surface as an item with no name on a floor.
    writeFileSync(file, JSON.stringify([{ vnum: 1, name: 'a torch', size: 2 }, { vnum: 2, name: 'a ghost' }]));
    const out = loadItemCatalogue(file);
    assert.deepEqual([...out.keys()], [1]);
  });
});
