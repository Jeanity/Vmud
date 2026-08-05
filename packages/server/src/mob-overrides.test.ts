/**
 * A4c — loot authored onto a mob template.
 *
 * The two things worth pinning down are the ones a reader would otherwise have to infer: that
 * authoring is **additive** rather than a replacement, and that a slot somebody typed is refused when
 * the game does not model it rather than quietly becoming a carried item.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Item, ItemTemplate } from '@mygame/shared';

import {
  applyOutfit,
  loadMobOverrides,
  outfitFor,
  saveMobOverrides,
  type MobOverrides,
} from './mob-overrides.ts';

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-mob-overrides-'));
  const file = join(dir, 'mobs.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

function template(vnum: number, name = `item ${vnum}`): ItemTemplate {
  return { vnum, keywords: [name], name, roomLine: `${name} is here.`, type: 9, ac: 0, size: 1, cost: 0, stackLimit: 1 } as ItemTemplate;
}

const CATALOGUE = new Map<number, ItemTemplate>([
  [100, template(100, 'a rusty key')],
  [200, template(200, 'a battered helm')],
]);

/** Instances are copies, so two mobs authored the same loot do not share one object. */
const instantiate = (t: ItemTemplate): Item => ({ ...t }) as unknown as Item;

describe('the mob overlay', () => {
  it('drops a slot the game does not model, rather than downgrading it to carried', () => {
    // The opposite of what `reset.ts` does with a harvested `E`, and deliberately: a harvested
    // position is data we inherited and worth keeping on the body, while a slot typed here is a
    // choice somebody just made — doing something else with it silently is how an author ends up
    // believing a hat is on a head it is not on.
    const file = tempFile(JSON.stringify({ 61: { loot: [{ vnum: 100, slot: 'tail' }, { vnum: 200 }] } }));
    const loot = loadMobOverrides(file).get(61)?.loot;
    assert.deepEqual(loot, [{ vnum: 200 }]);
  });

  it('round-trips, and an entry that authors nothing is not written back', () => {
    const overrides: MobOverrides = new Map();
    overrides.set(61, { loot: [{ vnum: 100, slot: 'head' }], at: '2026-08-05T00:00:00.000Z' });
    overrides.set(62, { loot: [] });

    const file = tempFile();
    saveMobOverrides(overrides, file);
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ['61'], 'an emptied record is not an authored mob');

    const back = loadMobOverrides(file);
    assert.deepEqual(back.get(61)?.loot, [{ vnum: 100, slot: 'head' }]);
    assert.equal(back.get(61)?.at, '2026-08-05T00:00:00.000Z');
  });

  it('reports a vnum the catalogue does not have rather than swallowing it', () => {
    const outfit = outfitFor({ loot: [{ vnum: 100 }, { vnum: 999 }] }, CATALOGUE, instantiate);
    assert.equal(outfit.carried.length, 1);
    // An authored piece that silently never appears is indistinguishable from the feature not working.
    assert.deepEqual(outfit.missing, [999]);
  });

  it('gives every instance its own copy', () => {
    const first = outfitFor({ loot: [{ vnum: 100 }] }, CATALOGUE, instantiate);
    const second = outfitFor({ loot: [{ vnum: 100 }] }, CATALOGUE, instantiate);
    assert.notEqual(first.carried[0], second.carried[0], 'looting one must not empty the other');
  });

  it('is additive: a contested slot displaces to the hands rather than destroying', () => {
    const harvested = { ...template(500, 'a harvested cap') } as unknown as Item;
    const mob = { equipped: { head: harvested } as Record<string, Item>, carrying: [] as Item[] };

    const added = applyOutfit(mob, outfitFor({ loot: [{ vnum: 200, slot: 'head' }] }, CATALOGUE, instantiate));
    assert.equal(added, 1);
    // The authored piece wins the slot...
    assert.equal((mob.equipped['head'] as unknown as { vnum: number }).vnum, 200);
    // ...and what it displaced is still on the body, so the corpse holds both. The count on a mob
    // only ever goes up, which is what makes "additive" true rather than merely intended.
    assert.deepEqual(mob.carrying, [harvested]);
  });

  it('adds nothing at all for a template nobody has authored', () => {
    const mob = { equipped: {} as Record<string, Item>, carrying: [] as Item[] };
    assert.equal(applyOutfit(mob, outfitFor(undefined, CATALOGUE, instantiate)), 0);
    assert.deepEqual(mob.carrying, []);
  });
});
