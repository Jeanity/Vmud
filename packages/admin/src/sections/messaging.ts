/**
 * Messaging. The global announcement works today; the narrower targets are the next slice.
 *
 * A line to one *player* already ships inside the player editor, where it naturally lives — this
 * section is for speech that is not about one character.
 */

import { call } from '../api.ts';
import { el, render } from '../dom.ts';

export const messagingSection = {
  slug: 'messaging',
  title: 'Messaging',
  mount(root: HTMLElement): void {
    const flash = el('p', { class: 'flash' });
    const input = el('input', { type: 'text', size: '60', maxlength: '300', placeholder: 'The server restarts in five minutes.' });

    const announce = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text) return;
      flash.className = 'flash';
      flash.textContent = '…';
      const result = await call<{ ok: boolean; heard: number }>('POST', '/announce', { text });
      if (result.ok && result.body) {
        flash.className = 'flash ok';
        flash.textContent = `announced to ${result.body.heard} player${result.body.heard === 1 ? '' : 's'}`;
        input.value = '';
      } else {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'failed';
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') void announce();
    });

    render(
      root,
      el('h2', {}, 'Messaging'),
      el('p', { class: 'note' }, 'Speak to the world. Lines land on the system channel of the game log, marked as an announcement.'),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Global announcement'),
        el('div', { class: 'row' }, input, el('button', { onclick: () => void announce() }, 'Announce')),
        flash,
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'To a place · to a room'),
        el('p', { class: 'note' }, 'Next slice, with the zones section — targeting wants the room browser, so they arrive together. A line to one player is in the player editor.'),
      ),
    );
  },
};
