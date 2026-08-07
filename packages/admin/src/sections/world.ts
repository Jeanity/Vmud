/**
 * World rules — the switches an operator throws, and what throwing one costs.
 *
 * One switch today: **player killing.** Owner's rule (2026-08-03): *"I am not a fan of pkill at all
 * but I understand some people are, so having it so I can turn it off or on would be a nice feature.
 * I could have pkill days where I save all the players' information in backup and turn on pkill and
 * let them go at it, and after the event I restore the player files."*
 *
 * Two things the design here takes seriously:
 *
 * 1. **Nothing is armed by a stray click.** The toggle does not act on change; it stages a value and
 *    a second, explicitly labelled button commits it. This decides whether a player can be killed by
 *    another player, and a switch of that weight should take a deliberate second gesture.
 * 2. **The world is told.** The server announces the change on the `announce` channel, and this
 *    reports how many heard. Finding out that PvP is on by dying to it is not acceptable, and the
 *    count is what tells an operator whether the people currently online actually got the warning.
 *
 * The backup half of the owner's workflow is deliberately **not** a button — see the note in the
 * page, and `settings.ts` for why.
 */

import { call } from '../api.ts';
import { el, render } from '../dom.ts';

interface WorldSettings {
  readonly pvp: boolean;
  readonly movementCosts: boolean;
}

interface SettingsBody {
  readonly settings: WorldSettings;
}

interface PatchBody {
  readonly ok: boolean;
  readonly settings: WorldSettings;
  readonly changed: boolean;
  readonly heard?: number;
}

export const worldSection = {
  slug: 'world',
  title: 'World rules',
  mount(root: HTMLElement): void {
    const flash = el('p', { class: 'flash' });
    const state = el('p', { class: 'note' }, 'reading…');
    const toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const commit = el('button', {}, 'Apply') as HTMLButtonElement;
    // The event switch — same pattern as PvP, its own card. Note the polarity: this box is
    // "movement is FREE", the inverse of the stored flag, because the panel's question is what the
    // operator is about to grant, not how the field is spelled.
    const moveFlash = el('p', { class: 'flash' });
    const moveState = el('p', { class: 'note' }, 'reading…');
    const moveToggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const moveCommit = el('button', {}, 'Apply') as HTMLButtonElement;
    let current: WorldSettings | undefined;

    /** Keeps the buttons honest: each is only live while its box disagrees with the server. */
    const refreshCommit = (): void => {
      const dirty = current !== undefined && toggle.checked !== current.pvp;
      commit.disabled = !dirty;
      commit.textContent = !dirty
        ? 'Apply'
        : toggle.checked
          ? 'Turn player killing ON'
          : 'Turn player killing OFF';
      commit.className = dirty && toggle.checked ? 'danger' : '';
      const moveDirty = current !== undefined && moveToggle.checked !== !current.movementCosts;
      moveCommit.disabled = !moveDirty;
      moveCommit.textContent = !moveDirty
        ? 'Apply'
        : moveToggle.checked
          ? 'Make movement FREE'
          : 'Charge for movement again';
      moveCommit.className = '';
    };

    const paint = (settings: WorldSettings): void => {
      current = settings;
      toggle.checked = settings.pvp;
      state.className = settings.pvp ? 'note warn' : 'note';
      state.textContent = settings.pvp
        ? 'Player killing is ON. Players can attack each other, and any player’s corpse can be looted by anyone.'
        : 'Player killing is OFF. Players cannot attack each other, and a player’s corpse can only be looted by its owner.';
      moveToggle.checked = !settings.movementCosts;
      moveState.className = settings.movementCosts ? 'note' : 'note warn';
      moveState.textContent = settings.movementCosts
        ? 'Movement costs are ON. Terrain and load drain the movement pool, deep water needs a boat or the swim skill, and exhaustion in deep water drowns.'
        : 'Movement is FREE. No terrain costs, no exhaustion, no drowning — and nothing stops anyone crossing an ocean for nothing until this is switched back.';
      refreshCommit();
    };

    toggle.addEventListener('change', refreshCommit);
    moveToggle.addEventListener('change', refreshCommit);

    const apply = async (flashInto: HTMLElement, patch: Record<string, boolean>): Promise<void> => {
      flashInto.className = 'flash';
      flashInto.textContent = '…';
      const result = await call<PatchBody>('PATCH', '/settings', patch);
      if (result.ok && result.body) {
        paint(result.body.settings);
        flashInto.className = 'flash ok';
        flashInto.textContent = !result.body.changed
          ? 'already set that way — nothing changed'
          : `saved · ${result.body.heard ?? 0} player${result.body.heard === 1 ? '' : 's'} were told`;
      } else {
        flashInto.className = 'flash err';
        flashInto.textContent = result.error ?? 'failed';
        // Put the boxes back to what the server actually holds, so a failed write cannot leave the
        // panel showing a rule that is not in force.
        if (current) paint(current);
      }
    };

    commit.addEventListener('click', () => void apply(flash, { pvp: toggle.checked }));
    moveCommit.addEventListener('click', () => void apply(moveFlash, { movementCosts: !moveToggle.checked }));

    render(
      root,
      el('h2', {}, 'World rules'),
      el(
        'p',
        { class: 'note' },
        'Switches that change how the world behaves for everyone. They are saved to disk, so they ' +
          'survive a restart.',
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Player killing'),
        state,
        el('div', { class: 'row' }, el('label', {}, toggle, ' allow players to attack each other'), commit),
        flash,
        el(
          'p',
          { class: 'note' },
          'One switch covers both halves: while it is off, a player cannot open a fight on another ' +
            'player and cannot take anything from their corpse. Turning it on announces the change to ' +
            'everyone online.',
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Movement costs'),
        moveState,
        el('div', { class: 'row' }, el('label', {}, moveToggle, ' movement is free (special events)'), moveCommit),
        moveFlash,
        el(
          'p',
          { class: 'note' },
          'One switch covers the whole economy of exhaustion: terrain costs, the load multiplier, the ' +
            'swim surcharge and drowning all pause together, because a world where walking is free but ' +
            'the water still kills is a rule nobody can hold in their head. Throwing it announces the ' +
            'change to everyone online, both ways.',
        ),
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Running a PvP event'),
        el(
          'p',
          { class: 'note' },
          'There is no backup button, on purpose — a snapshot taken at a moment the panel chose is ' +
            'worse than one you took yourself. Character files are plain JSON under data/players/. ' +
            'Copy that directory aside, turn the switch on, and copy it back when the event is over.',
        ),
        el(
          'p',
          { class: 'note' },
          'Restore with the server stopped: character records are held in memory while someone is ' +
            'online and written out afterwards, so a file replaced under a running server is ' +
            'overwritten by what the server still holds.',
        ),
      ),
    );

    void (async () => {
      const result = await call<SettingsBody>('GET', '/settings');
      if (result.ok && result.body) {
        paint(result.body.settings);
      } else {
        state.className = 'note';
        state.textContent = result.error ?? 'could not read the world settings';
      }
    })();
  },
};
