/**
 * `hair` — the happy path, the numbering, and every refusal by name.
 *
 * The command's decision is pure (`hair.ts`) precisely so this file can exist: the handler in
 * `index.ts` is unreachable from a unit test — that file binds a socket at import — so anything worth
 * asserting about *what the command does* has to live where no socket does. What is left in `index.ts`
 * is four lines: send, set the field, `afterKitChange`, announce. The resync those four lines ride is
 * covered in `appearance.test.ts`, and the persistence in `players.test.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BALD, HAIR_STYLES, defaultHairFor, isHairStyle } from '@mygame/shared';

import { COMMANDS, COMMAND_REQUIREMENTS, lookupCommand } from './commands.ts';
import { hairChoices, hairCommand, hairLabel, type HairOutcome } from './hair.ts';

/** The command with nothing covering it, which is the interesting case for everything but the list. */
const run = (argument: string, current = 'buzzed'): HairOutcome => hairCommand(argument, current, false);

/** Narrow to one arm of the union, or fail with which arm actually came back. */
function change(out: HairOutcome): Extract<HairOutcome, { t: 'change' }> {
  if (out.t !== 'change') assert.fail(`expected a change, got ${out.t}`);
  return out;
}
function refuse(out: HairOutcome): Extract<HairOutcome, { t: 'refuse' }> {
  if (out.t !== 'refuse') assert.fail(`expected a refusal, got ${out.t}`);
  return out;
}
function listed(out: HairOutcome): Extract<HairOutcome, { t: 'list' }> {
  if (out.t !== 'list') assert.fail(`expected the list, got ${out.t}`);
  return out;
}

describe('the `hair` command in the table', () => {
  it('lands on `ha` without moving a single abbreviation anybody uses', () => {
    // Table order is the whole mechanism (see `COMMANDS`), so an appended command has to be checked
    // rather than assumed: `h` and `he` belong to `help`, near the top of the inherited block.
    assert.equal(lookupCommand('hair'), 'hair');
    assert.equal(lookupCommand('ha'), 'hair');
    assert.equal(lookupCommand('h'), 'help');
    assert.equal(lookupCommand('he'), 'help');
    assert.equal(COMMANDS.at(-1), 'hair', 'appended, where ours belong');
  });

  it('asks for a conscious body and refuses mid-fight', () => {
    // No source row to transcribe — Duris has no such verb — so the row is reasoned to and pinned
    // here. Restyling your hair with something swinging at you is `wear`'s own absurdity.
    assert.deepEqual(COMMAND_REQUIREMENTS.hair, { status: 'resting', posture: 'prone', inCombat: false });
  });
});

describe('the list', () => {
  it('numbers every style and puts `bald` last', () => {
    const rows = hairChoices();
    assert.equal(rows.length, HAIR_STYLES.length + 1);
    assert.deepEqual(rows.map((row) => row.n), rows.map((_, i) => i + 1));
    assert.equal(rows.at(-1)?.id, BALD);
    for (const row of rows) assert.ok(isHairStyle(row.id), row.id);
  });

  it('prints what you have, and marks it in the list', () => {
    const out = listed(run('', 'long'));
    assert.ok(out.text.startsWith(`Your hair is ${hairLabel('long')}.`));
    const marked = out.text.split('\n').filter((line) => line.includes('(yours)'));
    assert.equal(marked.length, 1, 'exactly one row is yours');
    assert.ok(marked[0]!.includes('long'));
    for (const row of hairChoices()) assert.ok(out.text.includes(row.id), `${row.id} is missing from the list`);
  });

  it('says when the hair it just listed is under a hood', () => {
    // Every starter kit fills the head slot, so this is the *common* case for a fresh character and
    // the difference between a working command and one that appears to do nothing.
    assert.ok(listed(hairCommand('', 'long', true)).text.includes('covering it'));
    assert.ok(!listed(hairCommand('', 'long', false)).text.includes('covering it'));
  });
});

describe('choosing one', () => {
  it('takes the exact name, and says so in both persons', () => {
    const out = change(run('long'));
    assert.equal(out.id, 'long');
    assert.equal(out.you, 'You wear your hair worn long.');
    // Rendered per observer — `act.ts`'s rule — so a watcher in the dark gets "Someone", not a name.
    assert.equal(out.room('Azder'), 'Azder now wears their hair worn long.');
    assert.equal(out.room('someone'), 'Someone now wears their hair worn long.');
  });

  it('takes a unique prefix, and a number', () => {
    assert.equal(change(run('lo')).id, 'long');
    // The numbering is the catalogue's own order with `bald` appended.
    for (const row of hairChoices()) {
      assert.equal(change(run(String(row.n), row.id === 'buzzed' ? 'long' : 'buzzed')).id, row.id, `hair ${row.n}`);
    }
  });

  it('shaves a head when asked, in the words that suit it', () => {
    const out = change(run('bald'));
    assert.equal(out.id, BALD);
    assert.equal(out.you, 'You shave your head bare.');
    assert.equal(out.room('Azder'), 'Azder shaves their head bare.');
  });

  it('ignores case and surrounding space, because a player types both', () => {
    assert.equal(change(run('  LoNg  ')).id, 'long');
  });
});

describe('the refusals', () => {
  it('refuses a style that does not exist, and says where the list is', () => {
    const out = refuse(run('mohawk'));
    assert.equal(out.reason, 'unknown');
    assert.ok(out.text.includes('"mohawk"'));
    assert.ok(out.text.includes('hair'), 'a refusal that does not say the way back is half a refusal');
  });

  it('refuses an ambiguous prefix by naming both, rather than picking one', () => {
    // The one place this parts company with `lookupCommand`: the command table's order is a rule
    // players learn with their fingers, and a cosmetic list that may be appended to is not.
    const out = refuse(run('bu'));
    assert.equal(out.reason, 'ambiguous');
    assert.ok(out.text.includes('buns'));
    assert.ok(out.text.includes('buzzed'));
  });

  it('refuses a number out of range and says what the range is', () => {
    const count = hairChoices().length;
    for (const word of ['0', String(count + 1), '99']) {
      const out = refuse(run(word));
      assert.equal(out.reason, 'range', word);
      assert.ok(out.text.includes(`1-${count}`), out.text);
    }
  });

  it('refuses the hair you already have, which is also what stops a pointless resync', () => {
    const out = refuse(run('buzzed', 'buzzed'));
    assert.equal(out.reason, 'already');
    assert.ok(out.text.includes(hairLabel('buzzed')));
    // …including through a prefix and a number, so there is no back door to a no-op change.
    assert.equal(refuse(run('buzz', 'buzzed')).reason, 'already');
    assert.equal(refuse(run('1', 'buzzed')).reason, 'already');
  });

  it('refuses rather than crashing on the things a player actually mistypes', () => {
    for (const word of ['-1', '1.5', '???', 'bald bald']) {
      assert.equal(run(word).t, 'refuse', word);
    }
  });
});

describe('the default a character starts with', () => {
  it('is a real style for every name, and never bald', () => {
    // The command's `current` is `player.hair ?? defaultHairFor(player.name)`, so a character who has
    // never typed the verb still has a row marked `(yours)` in the list.
    for (const name of ['Azder', 'a', '', 'Zzzzzzzzzzzz', 'Ælfwine']) {
      const id = defaultHairFor(name);
      assert.ok(isHairStyle(id), `${name} -> ${id}`);
      assert.notEqual(id, BALD);
      assert.ok(hairChoices().some((row) => row.id === id));
      assert.ok(listed(hairCommand('', id, false)).text.includes('(yours)'));
    }
  });
});
