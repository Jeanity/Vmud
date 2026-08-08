/**
 * The `bring` arithmetic, and the back-compatibility it had to keep.
 *
 * These functions live in `quests.ts` rather than beside the verb that calls them **so that they can
 * be tested at all**. `doQuest` is `index.ts:5476`, and `index.ts` exports nothing and binds a socket,
 * starts the tick interval and installs a `process.exit` signal handler at module scope — importing it
 * from a test would boot a server. The rule the codebase already states for the art helpers (*"they
 * live outside `index.ts` precisely so they can be tested"*) is the one followed here: the counting and
 * the consuming are pure, so the half of the turn-in that can be wrong by arithmetic is covered, and
 * what stays uncovered is only the message-sending around it.
 *
 * Every case below is a way a counted fetch quest can be silently wrong, and two of them were real:
 * a `bring` matched on a keyword rather than a vnum and could never complete (`41aecce`), and a
 * turn-in never took the goods, so one onion satisfied the Viscount for ever.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STARTING_CAPACITY, type Inventory, type Item } from '@mygame/shared';

import { carriedForQuest, consumeBrought, draftQuest, loadQuests, objectivePhrase, saveQuests, type QuestDraft } from './quests.ts';

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** An instantiated item: `obj:<vnum>` is the whole of what `vnumOf` reads. */
function obj(vnum: number, name = 'a small nugget of silver'): Item {
  return { id: `obj:${vnum}`, name, ac: 0, size: 1 };
}

function bag(...stacks: { item: Item; count: number }[]): Inventory {
  return { stacks, capacity: STARTING_CAPACITY };
}

/** A valid draft with one field swapped, so each test states only the thing it is about. */
function draft(objective: Record<string, unknown>): QuestDraft {
  return {
    id: 'szxvu-smelts-the-nuggets',
    giver: 1420,
    name: "Szxvu's smelting",
    ask: 'I can take 8 silver nuggets and make a block of usable silver.',
    thanks: 'Much can be done with a good block of silver.',
    objective,
    reward: { xp: 0, copper: 0, item: 1448 },
  };
}

describe('counting what is carried', () => {
  it('sums a stack by its depth, because eight nuggets share one slot', () => {
    // The whole difference for a counted objective. Counting *stacks* would report 1 for a full stack
    // and make Szxvu's eight-nugget quest permanently unfinishable — the bag merges small identical
    // objects, which is exactly what a fetch quest asks for several of.
    assert.equal(carriedForQuest(bag({ item: obj(1447), count: 8 }), 1447), 8);
  });

  it('adds up across stacks, so a split pile still counts', () => {
    const split = bag({ item: obj(1447), count: 5 }, { item: obj(1447), count: 3 });
    assert.equal(carriedForQuest(split, 1447), 8);
  });

  it('counts nothing for a vnum the bag does not hold', () => {
    assert.equal(carriedForQuest(bag({ item: obj(1447), count: 8 }), 97115), 0);
    assert.equal(carriedForQuest(bag(), 1447), 0);
  });

  it('ignores an authored item, which has no vnum at all', () => {
    // A starter-kit item's id is not `obj:<n>`, so `vnumOf` returns nothing — and nothing must never
    // read as "matches vnum 0", which is a legal vnum.
    assert.equal(carriedForQuest(bag({ item: { id: 'starter-dagger', name: 'a dagger', ac: 0, size: 1 }, count: 3 }), 0), 0);
  });

  it('matches on the vnum and not on the words, which is the bug 41aecce fixed', () => {
    // The item's *name* is what a player types; its id is what the quest joins on. An item whose
    // display name shares no word with anything still counts, and one whose name matches but whose
    // vnum does not, does not.
    const unnamed = bag({ item: obj(1447, '&+La lump of something&N'), count: 2 });
    assert.equal(carriedForQuest(unnamed, 1447), 2);
    const lookalike = bag({ item: obj(9999, 'a small nugget of silver'), count: 4 });
    assert.equal(carriedForQuest(lookalike, 1447), 0);
  });
});

describe('taking what was brought', () => {
  it('takes exactly the count and leaves the remainder', () => {
    const left = consumeBrought(bag({ item: obj(1447), count: 10 }), 1447, 8);
    assert.equal(carriedForQuest(left, 1447), 2);
  });

  it('drains across stacks in order, and drops one it empties', () => {
    const left = consumeBrought(bag({ item: obj(1447), count: 5 }, { item: obj(1447), count: 3 }), 1447, 6);
    assert.equal(carriedForQuest(left, 1447), 2);
    // The emptied stack is gone rather than kept at zero — `removeAt`'s own rule: a bag must never
    // hold a stack of nothing, or every slot count downstream is wrong.
    assert.equal(left.stacks.length, 1);
    assert.equal(left.stacks[0]?.count, 2);
  });

  it('leaves everything else in the bag alone', () => {
    const before = bag({ item: obj(97115, 'an onion'), count: 1 }, { item: obj(1447), count: 8 });
    const left = consumeBrought(before, 1447, 8);
    assert.equal(carriedForQuest(left, 1447), 0);
    assert.equal(carriedForQuest(left, 97115), 1, 'the onion was not the quest');
    assert.equal(left.capacity, STARTING_CAPACITY, 'capacity is a property of the character, not the contents');
  });

  it('takes exactly one for a bring that never named a count', () => {
    // The back-compatible case, and the one three shipped quests are: the Viscount takes the onion and
    // takes only the onion, where before this he took nothing and you kept it.
    const left = consumeBrought(bag({ item: obj(97115, 'an onion'), count: 3 }), 97115, 1);
    assert.equal(carriedForQuest(left, 97115), 2);
  });

  it('does not mutate the inventory it was handed', () => {
    const before = bag({ item: obj(1447), count: 8 });
    consumeBrought(before, 1447, 8);
    assert.equal(carriedForQuest(before, 1447), 8, 'the caller assigns the result through sim.setInventory');
  });

  it('takes what there is rather than refusing, when handed more than the bag holds', () => {
    // Callers check `carriedForQuest` first, so this is the defensive path. Taking what is there is
    // the safe failure: a consume that silently refused would close a quest and leave the goods behind.
    const left = consumeBrought(bag({ item: obj(1447), count: 2 }), 1447, 8);
    assert.equal(carriedForQuest(left, 1447), 0);
    assert.equal(left.stacks.length, 0);
  });
});

describe('a bring objective that counts', () => {
  it('defaults a missing count to one, which is what every quest authored before counting means', () => {
    const made = draftQuest(draft({ kind: 'bring', vnum: 97115, what: 'an onion' }));
    assert.ok('quest' in made);
    assert.deepEqual(made.quest.objective, { kind: 'bring', vnum: 97115, count: 1, what: 'an onion' });
  });

  it('reads null as absent, the way reward.item does — a form that cleared the box', () => {
    const made = draftQuest(draft({ kind: 'bring', vnum: 97115, count: null, what: 'an onion' }));
    assert.ok('quest' in made);
    assert.equal(made.quest.objective.count, 1);
  });

  it('takes a real count', () => {
    const made = draftQuest(draft({ kind: 'bring', vnum: 1447, count: 8, what: 'small nuggets of silver' }));
    assert.ok('quest' in made);
    assert.deepEqual(made.quest.objective, { kind: 'bring', vnum: 1447, count: 8, what: 'small nuggets of silver' });
  });

  it('refuses a count that is not a whole number from 1 to 100', () => {
    for (const count of [0, -1, 2.5, 101, '8', Number.NaN]) {
      const made = draftQuest(draft({ kind: 'bring', vnum: 1447, count, what: 'nuggets' }));
      assert.ok('error' in made, `count ${String(count)} should be refused`);
      assert.match(made.error, /count must be a whole number from 1 to 100/);
    }
  });

  it('still requires the count on a kill, where it has never been optional', () => {
    const made = draftQuest(draft({ kind: 'kill', vnum: 1422, what: 'kobold youths' }));
    assert.ok('error' in made);
    assert.match(made.error, /count must be a whole number from 1 to 100/);
  });
});

describe('the armour, which is off unless asked for', () => {
  /** The same valid draft, with the flag in whatever state the test is about. */
  const withFlag = (protectGiver: unknown): QuestDraft => ({
    ...draft({ kind: 'bring', vnum: 1447, count: 8, what: 'small nuggets of silver' }),
    protectGiver,
  });

  it('leaves a giver killable when nothing asks otherwise, which is every quest authored before the flag', () => {
    const made = draftQuest(draft({ kind: 'bring', vnum: 97115, what: 'an onion' }));
    assert.ok('quest' in made);
    // Absent, not `false` — the owner's correction was that killable is the ordinary state of a
    // body, so the file says nothing at all about the ones that have no armour.
    assert.equal('protectGiver' in made.quest, false);
  });

  it('records the armour when it is asked for', () => {
    const made = draftQuest(withFlag(true));
    assert.ok('quest' in made);
    assert.equal(made.quest.protectGiver, true);
  });

  it('treats false and null as no armour rather than as a second way of writing it', () => {
    for (const value of [false, null, undefined]) {
      const made = draftQuest(withFlag(value));
      assert.ok('quest' in made, `${String(value)} should be accepted`);
      assert.equal('protectGiver' in made.quest, false, `${String(value)} should leave the field absent`);
    }
  });

  it('refuses anything that is not a boolean, so a truthy string cannot arm a giver by accident', () => {
    for (const value of ['true', 1, {}]) {
      const made = draftQuest(withFlag(value));
      assert.ok('error' in made, `${JSON.stringify(value)} should be refused`);
      assert.match(made.error, /protectGiver must be true or false/);
    }
  });
});

describe('saying what the objective is', () => {
  it('speaks the count, and stays quiet about one', () => {
    // Measured on the wire before it was fixed: the Viscount announced *"Quest taken: 1 an onion."*
    // A `what` written before counting existed carries its own article, because there was never a
    // number to put in front of it — and those are exactly the quests whose wording must not change.
    assert.equal(objectivePhrase({ kind: 'bring', vnum: 97115, count: 1, what: 'an onion' }), 'an onion');
    assert.equal(
      objectivePhrase({ kind: 'bring', vnum: 1447, count: 8, what: 'small nuggets of silver' }),
      '8 small nuggets of silver',
    );
    // The `kill` that shipped this wording keeps it, unchanged.
    assert.equal(objectivePhrase({ kind: 'kill', vnum: 1422, count: 3, what: 'kobold youths' }), '3 kobold youths');
  });
});

describe('the file a person edits', () => {
  it('round-trips a counted bring, and leaves a bring of one uncounted', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'mygame-quests-')), 'quests.json');
    const counted = draftQuest(draft({ kind: 'bring', vnum: 1447, count: 8, what: 'small nuggets of silver' }));
    const single = draftQuest({ ...draft({ kind: 'bring', vnum: 97115, what: 'an onion' }), id: 'the-viscounts-onion' });
    assert.ok('quest' in counted && 'quest' in single);
    saveQuests([counted.quest, single.quest], file);

    const text = readFileSync(file, 'utf8');
    assert.match(text, /"objective": \{ "kind": "bring", "vnum": 1447, "count": 8, "what": "small nuggets of silver" \}/);
    // The silence that keeps the shipped file's diff honest — see `saveQuests`'s own note.
    assert.match(text, /"objective": \{ "kind": "bring", "vnum": 97115, "what": "an onion" \}/);

    const back = loadQuests(file);
    assert.equal(back.get('szxvu-smelts-the-nuggets')?.objective.count, 8);
    assert.equal(back.get('the-viscounts-onion')?.objective.count, 1);
  });

  it('round-trips the armour, so an operator editing a typo cannot disarm a giver', () => {
    // The failure this guards is silent and remote from its cause: `PATCH` lays a form's fields over
    // the record and re-validates the whole, so a writer that dropped the flag would turn a fix to
    // the giver's *ask* into a giver anybody can kill — discovered days later, by a dead one.
    const file = join(mkdtempSync(join(tmpdir(), 'mygame-quests-')), 'quests.json');
    const armoured = draftQuest({
      ...draft({ kind: 'kill', vnum: 1422, count: 3, what: 'kobold youths' }),
      id: 'gwark-culls-the-warren',
      protectGiver: true,
    });
    const ordinary = draftQuest({ ...draft({ kind: 'bring', vnum: 97115, what: 'an onion' }), id: 'the-viscounts-onion' });
    assert.ok('quest' in armoured && 'quest' in ordinary);
    saveQuests([armoured.quest, ordinary.quest], file);

    const text = readFileSync(file, 'utf8');
    assert.match(text, /"protectGiver": true/);
    // Once, on the one row that asked — the killable giver says nothing.
    assert.equal(text.match(/protectGiver/g)?.length, 1);

    const back = loadQuests(file);
    assert.equal(back.get('gwark-culls-the-warren')?.protectGiver, true);
    assert.equal(back.get('the-viscounts-onion')?.protectGiver, undefined);
  });
});
