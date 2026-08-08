/**
 * The creation card's reconnect recovery, tested as the pure decision it is — no socket, no DOM.
 * See `chargen-resume.ts` for why this exists apart from `login.ts`.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chargenAdoptReplyAction, chargenResumeAction, type ChargenHold } from './chargen-resume.ts';

describe('chargenResumeAction', () => {
  it('does nothing for a fresh mint still choosing — nothing sent yet is stale', () => {
    assert.deepEqual(chargenResumeAction({ name: 'Brunhild' }), { kind: 'none' });
    assert.deepEqual(chargenResumeAction({ name: 'Brunhild', race: 'gnome' }), { kind: 'none' });
  });

  it('resends charCreate for a fresh mint once race and class are both chosen', () => {
    const held: ChargenHold = { name: 'Brunhild', race: 'gnome', class: 'cleric' };
    assert.deepEqual(chargenResumeAction(held), { kind: 'sendCreate' });
  });

  it('reopens adoption before anything else, whether or not race and class are chosen', () => {
    assert.deepEqual(chargenResumeAction({ adoptName: 'Weststar' }), {
      kind: 'reopenAdoption',
      name: 'Weststar',
    });
    assert.deepEqual(
      chargenResumeAction({ adoptName: 'Weststar', race: 'mountain-dwarf', class: 'cleric' }),
      { kind: 'reopenAdoption', name: 'Weststar' },
    );
  });
});

describe('chargenAdoptReplyAction', () => {
  it('opens the cards for the ordinary first arrival — nothing held yet', () => {
    assert.deepEqual(chargenAdoptReplyAction(undefined, 'Weststar'), { kind: 'openCards' });
  });

  it('opens the cards when the incoming name does not match what is held', () => {
    const held: ChargenHold = { adoptName: 'Someone Else' };
    assert.deepEqual(chargenAdoptReplyAction(held, 'Weststar'), { kind: 'openCards' });
  });

  it('waits when the replay restores state before a class is chosen', () => {
    const held: ChargenHold = { adoptName: 'Weststar' };
    assert.deepEqual(chargenAdoptReplyAction(held, 'Weststar'), { kind: 'wait' });
    const withRace: ChargenHold = { adoptName: 'Weststar', race: 'mountain-dwarf' };
    assert.deepEqual(chargenAdoptReplyAction(withRace, 'Weststar'), { kind: 'wait' });
  });

  it('sends create when the replay restores state after race and class are already chosen', () => {
    const held: ChargenHold = { adoptName: 'Weststar', race: 'mountain-dwarf', class: 'cleric' };
    assert.deepEqual(chargenAdoptReplyAction(held, 'Weststar'), { kind: 'sendCreate' });
  });
});
