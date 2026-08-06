/**
 * A9b — mobs made here rather than harvested.
 *
 * What is worth pinning down is what makes this a different animal from `mob-overrides.ts`: a whole
 * record with nothing behind it, a number that is never handed out twice, and a file that is read back
 * through the same validator a form POST goes through — so a hand-edited level cannot leave a creature
 * hitting on the arithmetic of the level it used to be.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { AUTHORED_MOB_BASE, attackBonusFor, matchesAggro, pursues } from '@mygame/shared';

import {
  draftAuthoredMob,
  loadAuthoredMobs,
  readAuthoredMob,
  saveAuthoredMobs,
  type AuthoredMobStore,
} from './mob-authoring.ts';

const HOUND = {
  name: 'a bone hound',
  keywords: ['bone', 'hound'],
  level: 12,
  hp: '12d8+30',
  damage: '2d6+3',
  armourClass: 14,
  experience: 2400,
};

function tempFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-mob-authoring-'));
  const file = join(dir, 'mobs-authored.json');
  if (contents !== undefined) writeFileSync(file, contents);
  return file;
}

function made(draft: Record<string, unknown> = {}) {
  const drafted = draftAuthoredMob(AUTHORED_MOB_BASE, { ...HOUND, ...draft });
  assert.ok(!('error' in drafted), 'error' in drafted ? drafted.error : '');
  return drafted.mob;
}

describe('drafting a mob', () => {
  it('builds a whole template out of the fields a form can supply', () => {
    const mob = made();
    assert.equal(mob.vnum, AUTHORED_MOB_BASE);
    assert.equal(mob.name, 'a bone hound');
    assert.deepEqual(mob.keywords, ['bone', 'hound']);
    assert.equal(mob.level, 12);
    assert.deepEqual(mob.combat.damage, { count: 2, sides: 6, bonus: 3 });
    assert.equal(mob.combat.armourClass, 14);
  });

  it('derives the combat numbers a form has no business posting', () => {
    // The same arithmetic `readCombatStats` runs, so a created mob and a harvested one of the same level
    // swing on the same clock with the same accuracy — rather than a second scale nobody calibrated.
    assert.equal(made().combat.attackBonus, attackBonusFor(12));
    assert.equal(made({ level: 40 }).combat.attackBonus, attackBonusFor(40));
  });

  it('writes a room line in the source’s idiom when none is given', () => {
    assert.equal(made().room, 'a bone hound is standing here.');
    assert.equal(made({ room: 'It waits, patient as bone.' }).room, 'It waits, patient as bone.');
  });

  it('refuses a vnum below the reserved base, because that is the whole safety argument', () => {
    const drafted = draftAuthoredMob(1410, HOUND);
    assert.ok('error' in drafted);
    assert.match(drafted.error, /at or above 9000000/);
  });

  it('names what is wrong rather than merely refusing', () => {
    for (const [patch, pattern] of [
      [{ name: '   ' }, /name is required/],
      [{ keywords: [] }, /at least one keyword/],
      [{ level: 0 }, /level must be/],
      [{ level: 61 }, /level must be/],
      [{ hp: 'three d six' }, /hit points must be dice/],
      [{ damage: '' }, /damage must be dice/],
      [{ armourClass: 900 }, /armour class/],
    ] as const) {
      const drafted = draftAuthoredMob(AUTHORED_MOB_BASE, { ...HOUND, ...patch });
      assert.ok('error' in drafted, JSON.stringify(patch));
      assert.match(drafted.error, pattern, JSON.stringify(patch));
    }
  });

  it('writes a disposition and its clause together, or neither', () => {
    // A9 refused to author aggression at all because a form could set `aggressive` and leave the clauses
    // empty — a creature marked hostile that never attacks, since `matchesAggro` reads the clauses. One
    // boolean cannot reach that state, which is what makes it safe to offer.
    assert.equal(matchesAggro(made({ aggressive: true }).aggro, {}), true);
    assert.equal(matchesAggro(made().aggro, {}), false);
  });

  it('gives a hunter the memory it is inert without', () => {
    // §4.11's dependency, which `huntRule` refuses to let a caller forget: a HUNTER without MEMORY does
    // nothing in the source and nothing here. A form offering the two separately would be a trap.
    const hunter = made({ hunts: true });
    assert.equal(pursues(hunter.pursuit), true);
    assert.equal(hunter.aggro.remembers, true);
    assert.equal(pursues(made().pursuit), false);
  });
});

describe('the created-mob overlay on disk', () => {
  it('round-trips a record through save and load', () => {
    const file = tempFile();
    const store: AuthoredMobStore = {
      mobs: new Map([[AUTHORED_MOB_BASE, { mob: made({ aggressive: true }), at: 'test-time' }]]),
      next: AUTHORED_MOB_BASE + 1,
    };
    saveAuthoredMobs(store, file);
    const back = loadAuthoredMobs(file);
    assert.equal(back.next, AUTHORED_MOB_BASE + 1);
    const mob = back.mobs.get(AUTHORED_MOB_BASE)?.mob;
    assert.equal(mob?.name, 'a bone hound');
    assert.equal(matchesAggro(mob!.aggro, {}), true, 'the rule survives the trip, not just the flag');
  });

  it('recomputes the derived combat rather than trusting what is written', () => {
    // A hand-edited level with the old attack bonus still beside it is the failure this prevents: the
    // record is read back *through the draft*, so the arithmetic is redone from the level that is there.
    const file = tempFile();
    saveAuthoredMobs(
      { mobs: new Map([[AUTHORED_MOB_BASE, { mob: made(), at: 't' }]]), next: AUTHORED_MOB_BASE + 1 },
      file,
    );
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
    const record = raw.mobs![String(AUTHORED_MOB_BASE)]!;
    record.level = 40 as unknown as Record<string, unknown>;
    writeFileSync(file, JSON.stringify(raw));

    const mob = loadAuthoredMobs(file).mobs.get(AUTHORED_MOB_BASE)?.mob;
    assert.equal(mob?.level, 40);
    assert.equal(mob?.combat.attackBonus, attackBonusFor(40), 'not the level-12 bonus still on disk');
  });

  it('drops a record it could not validate rather than loading half a creature', () => {
    const file = tempFile(`{"next": 9000001, "mobs": {"9000000": {"name": "a wisp", "level": 3}}}`);
    // No keywords and no dice: a template that reached the map like this would be a creature nobody can
    // type at, with no hit points. Dropped, as every sibling loader drops a malformed row.
    assert.equal(loadAuthoredMobs(file).mobs.size, 0);
  });

  it('raises a counter that a hand edit left behind its own records', () => {
    // Wrong in the safe direction, which is the only direction a number allocator may be wrong in.
    const file = tempFile();
    saveAuthoredMobs(
      { mobs: new Map([[AUTHORED_MOB_BASE + 5, { mob: { ...made(), vnum: AUTHORED_MOB_BASE + 5 } }]]), next: AUTHORED_MOB_BASE },
      file,
    );
    assert.equal(loadAuthoredMobs(file).next, AUTHORED_MOB_BASE + 6);
  });

  it('reads nothing at all from a file that is not there', () => {
    const store = loadAuthoredMobs(join(tmpdir(), 'mygame-no-such-mobs.json'));
    assert.equal(store.mobs.size, 0);
    assert.equal(store.next, AUTHORED_MOB_BASE);
  });

  it('runs one validator for the file and the form', () => {
    // Two readers for one shape is how a field ends up legal through one door and not the other.
    assert.equal(readAuthoredMob(AUTHORED_MOB_BASE, { ...HOUND, hp: 'lots' }), undefined);
    assert.ok(readAuthoredMob(AUTHORED_MOB_BASE, HOUND));
  });
});
