/**
 * Messaging — the operator's voice, at whatever range they choose. Track A2.
 *
 * One form with a scope rather than three forms, mirroring the API: the three scopes differ only in
 * who hears them, so three separate forms would be three places to make the same typo. Lines land on
 * the **`announce` channel** (protocol 10), which is what lets the client style a person's voice
 * apart from the machine's.
 *
 * A line to *one player* is deliberately not here — it lives in the player editor, where you are
 * already looking at who you are about to talk to and what state they are in.
 */

import { call, type RoomsBody, type StatusBody } from '../api.ts';
import { el, render } from '../dom.ts';

type Scope = 'world' | 'place' | 'room';

export const messagingSection = {
  slug: 'messaging',
  title: 'Messaging',
  mount(root: HTMLElement): void {
    const flash = el('p', { class: 'flash' });
    const input = el('input', {
      type: 'text',
      size: '52',
      maxlength: '300',
      placeholder: 'The server restarts in five minutes.',
    });

    const scopePick = el(
      'select',
      {},
      el('option', { value: 'world' }, 'the whole world'),
      el('option', { value: 'place' }, 'everyone on one place'),
      el('option', { value: 'room' }, 'everyone in one room'),
    );
    const placePick = el('select', {});
    const roomInput = el('input', { type: 'number', list: 'msg-rooms', placeholder: 'room id' });
    const roomList = el('datalist', { id: 'msg-rooms' });

    // Only the control the chosen scope actually uses is on screen. A room box sitting inert while
    // "the whole world" is selected is an invitation to fill it in and wonder why it was ignored.
    const targetRow = el('div', { class: 'row' });
    const retarget = (): void => {
      const scope = scopePick.value as Scope;
      render(
        targetRow,
        scope === 'place' ? el('label', {}, 'place') : null,
        scope === 'place' ? placePick : null,
        scope === 'room' ? el('label', {}, 'room') : null,
        scope === 'room' ? roomInput : null,
        scope === 'room' ? roomList : null,
        scope === 'world' ? el('span', { class: 'muted' }, 'everyone connected, wherever they are standing') : null,
      );
    };
    scopePick.addEventListener('change', retarget);

    const speak = async (): Promise<void> => {
      const text = input.value.trim();
      if (!text) return;
      const scope = scopePick.value as Scope;
      const body: Record<string, unknown> = { text };
      if (scope === 'place') body.place = placePick.value;
      if (scope === 'room') body.room = Number(roomInput.value);

      flash.className = 'flash';
      flash.textContent = '…';
      const result = await call<{ ok: boolean; heard: number; where: string }>('POST', '/announce', body);
      if (result.ok && result.body) {
        flash.className = 'flash ok';
        // The count is the useful half. World-wide it is trivia; for a room it is the difference
        // between having said something and having said it to an empty floor.
        flash.textContent =
          `sent to ${result.body.where} — ` +
          (result.body.heard === 0
            ? 'nobody was there to hear it'
            : `${result.body.heard} player${result.body.heard === 1 ? '' : 's'} heard it`);
        input.value = '';
      } else {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'failed';
      }
    };

    input.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') void speak();
    });

    render(
      root,
      el('h2', {}, 'Messaging'),
      el(
        'p',
        { class: 'note' },
        'Speak to the world, to one place, or to one room. Lines land on the game log’s announce ' +
          'channel — a person’s voice, styled apart from the machine’s.',
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Say something'),
        el('div', { class: 'row' }, el('label', {}, 'to'), scopePick),
        targetRow,
        el('div', { class: 'row' }, input, el('button', { onclick: () => void speak() }, 'Send')),
        flash,
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'To one player'),
        el(
          'p',
          { class: 'note' },
          'In the player editor, under Live — where you can already see where they are standing and ' +
            'what state they are in before you say anything to them.',
        ),
      ),
    );

    retarget();

    // The pickers, fetched once: which places and rooms exist changes on a restart, not mid-session.
    void (async () => {
      const status = await call<StatusBody>('GET', '/status');
      if (status.ok && status.body) {
        const places = status.body.zones.flatMap((zone) =>
          zone.levels.map((level) => ({ key: `${zone.id}:${level}`, label: `${zone.name} — level ${level}` })),
        );
        render(placePick, ...places.map((place) => el('option', { value: place.key }, place.label)));
      }
      const roomsBody = await call<RoomsBody>('GET', '/rooms');
      if (roomsBody.ok && roomsBody.body) {
        render(
          roomList,
          ...roomsBody.body.rooms.map((room) =>
            el('option', { value: String(room.id) }, `${room.name} — z${room.zone} L${room.level}`),
          ),
        );
      }
      retarget();
    })();
  },
};
