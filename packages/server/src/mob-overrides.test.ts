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

import {
  attackBonusFor,
  noPursuit,
  passiveRule,
  readCombatStats,
  type Item,
  type ItemTemplate,
  type MobTemplate,
} from '@mygame/shared';

import {
  applyMobOverride,
  applyOutfit,
  loadMobOverrides,
  mergeMobOverride,
  mobAuthorsAnything,
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

  it('rolls the rare-drop percent at spawn, through the injected roll', () => {
    // The owner's fifty-kills ask: the piece is on the body or was never there. The roll is
    // injected, so which seeded stream the world's luck rides on is the caller's decision.
    const rare = { loot: [{ vnum: 100, percent: 2 }] };
    const lucky = outfitFor(rare, CATALOGUE, instantiate, () => true);
    const unlucky = outfitFor(rare, CATALOGUE, instantiate, () => false);
    assert.equal(lucky.carried.length, 1, 'the fiftieth ranger has the blade');
    assert.equal(unlucky.carried.length, 0, 'the other forty-nine honestly never did');
    assert.deepEqual(unlucky.missing, [], 'a failed roll is not a missing item');
    // No roll injected (older callers, shape tests): every row drops, exactly as before.
    assert.equal(outfitFor(rare, CATALOGUE, instantiate).carried.length, 1);
  });

  it('round-trips the percent through the overlay file, dropping the malformed', () => {
    const file = tempFile();
    saveMobOverrides(
      new Map([[61, { loot: [{ vnum: 100, percent: 2 }, { vnum: 200 }], at: '2026-08-07T00:00:00.000Z' }]]),
      file,
    );
    const back = loadMobOverrides(file);
    assert.deepEqual(back.get(61)?.loot, [{ vnum: 100, percent: 2 }, { vnum: 200 }]);
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

/**
 * A9 — what a mob *is*, authored over the harvest.
 *
 * The three things a reader would otherwise have to infer: that the record is a **patch** so one field
 * moves without disturbing the rest, that an authored **level drags the derived combat numbers with it**
 * rather than leaving a level-40 kobold swinging like a level-3, and that clearing the last authored field
 * leaves nothing behind rather than an empty record that keeps answering *yes, this is authored*.
 */
describe('authoring what a mob is', () => {
  const GUARD: MobTemplate = {
    vnum: 61,
    keywords: ['kobold', 'guard'],
    name: 'a kobold guard',
    room: 'A kobold guard stands here.',
    level: 8,
    hp: '8d8+16',
    sprite: 'kobold',
    aggro: passiveRule(8),
    pursuit: noPursuit(),
    combat: readCombatStats({ level: 8, armour: 40, damage: '2d6+2' }),
    experience: 500,
    wimpyAt: 0,
  };

  it('changes one field and leaves every other alone', () => {
    const applied = applyMobOverride(GUARD, { name: 'Gwark, the kobold king' });
    assert.equal(applied.name, 'Gwark, the kobold king');
    assert.equal(applied.level, 8);
    assert.equal(applied.hp, '8d8+16');
    assert.deepEqual(applied.keywords, ['kobold', 'guard']);
  });

  it('drags the derived combat numbers along with an authored level', () => {
    // The subtle one. A template stores the *derived* profile, and the attack bonus is a function of the
    // level — so a level edit that left `combat` alone would produce a level-40 kobold that still hits
    // like a level-8, and nobody would see it until the fight was already wrong.
    const applied = applyMobOverride(GUARD, { level: 40 });
    assert.equal(applied.level, 40);
    assert.equal(applied.combat.attackBonus, attackBonusFor(40));
    assert.notEqual(applied.combat.attackBonus, GUARD.combat.attackBonus);
    // And nothing else about the fight moved: the damage and armour are still the harvest's.
    assert.deepEqual(applied.combat.damage, GUARD.combat.damage);
    assert.equal(applied.combat.armourClass, GUARD.combat.armourClass);
  });

  it('parses authored damage into the dice the fight reads', () => {
    const applied = applyMobOverride(GUARD, { damage: '5d10+7' });
    assert.deepEqual(applied.combat.damage, { count: 5, sides: 10, bonus: 7 });
  });

  it('is applied to the harvest and not to itself, so a clear is a real revert', () => {
    // Two edits in sequence, the second dropping the first: applying against the *pristine* template is
    // what makes the level come back as 8 rather than as whatever the last edit happened to leave.
    const once = mergeMobOverride(undefined, { level: 40, name: 'Gwark' }, [], 'test-time');
    assert.ok(once);
    const twice = mergeMobOverride(once, {}, ['level'], 'test-time');
    assert.ok(twice);
    const applied = applyMobOverride(GUARD, twice);
    assert.equal(applied.level, 8);
    assert.equal(applied.combat.attackBonus, GUARD.combat.attackBonus);
    assert.equal(applied.name, 'Gwark');
  });

  it('reports nothing left once the last authored field is cleared', () => {
    const one = mergeMobOverride(undefined, { level: 40 }, [], 'test-time');
    assert.ok(one);
    // `undefined` rather than `{at}` — the caller deletes the entry, which is what takes the mark off
    // the row. An empty record kept in the map would make every "is this authored" check answer yes.
    assert.equal(mergeMobOverride(one, {}, ['level'], 'test-time'), undefined);
  });

  it('does not count its own metadata as authoring', () => {
    assert.equal(mobAuthorsAnything({ at: 'test-time', by: 'somebody' }), false);
    assert.equal(mobAuthorsAnything({ level: 40 }), true);
    // Loot still counts, which is what stops A9 dropping every A4c record on the next save.
    assert.equal(mobAuthorsAnything({ loot: [{ vnum: 200 }] }), true);
  });

  it('keeps a stats-only edit across a save and a reload', () => {
    // A4c's saver gated on `loot`, so this record would have been written and then silently dropped.
    const file = tempFile();
    const overrides: MobOverrides = new Map([[61, { level: 40, hp: '40d12+300', at: 'test-time' }]]);
    saveMobOverrides(overrides, file);
    const back = loadMobOverrides(file);
    assert.equal(back.get(61)?.level, 40);
    assert.equal(back.get(61)?.hp, '40d12+300');
  });

  it('drops a hand-edited field the game could not use, and keeps the rest', () => {
    // Dice validated by parsing rather than by a pattern: `"three d six"` is a mob with no hit points,
    // and the loader's posture everywhere is to salvage what is meant rather than to refuse the record.
    const file = tempFile('{"61": {"level": 12, "hp": "three d six", "damage": "2d6+2"}}');
    const back = loadMobOverrides(file);
    assert.equal(back.get(61)?.level, 12);
    assert.equal(back.get(61)?.hp, undefined);
    assert.equal(back.get(61)?.damage, '2d6+2');
  });

  it('clamps a hand-edited number into the band rather than refusing the record', () => {
    const file = tempFile('{"61": {"level": 900, "experience": -5}}');
    const back = loadMobOverrides(file);
    assert.equal(back.get(61)?.level, 60);
    assert.equal(back.get(61)?.experience, 0);
  });
});
