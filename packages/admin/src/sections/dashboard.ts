/**
 * The dashboard: `/health` grown up. Read-only, polled while visible.
 */

import { call, type StatusBody } from '../api.ts';
import { duration, el, render } from '../dom.ts';

let timer: number | undefined;

export const dashboardSection = {
  slug: 'dashboard',
  title: 'Dashboard',
  mount(root: HTMLElement): void {
    const refresh = async (): Promise<void> => {
      const result = await call<StatusBody>('GET', '/status');
      if (!result.ok || !result.body) {
        render(root, el('h2', {}, 'Dashboard'), el('p', { class: 'flash err' }, result.error ?? 'unreachable'));
        return;
      }
      const s = result.body;
      render(
        root,
        el('h2', {}, 'Dashboard'),
        el('p', { class: 'note' }, 'The server as it stands. Read-only; everything here is the admin API’s /status.'),
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Server'),
          el(
            'dl',
            { class: 'kv' },
            el('dt', {}, 'uptime'), el('dd', {}, duration(s.uptimeMs)),
            el('dt', {}, 'players online'), el('dd', {}, String(s.playersOnline)),
            el('dt', {}, 'protocol'), el('dd', {}, `v${s.protocol}`),
            el('dt', {}, 'clocks'), el('dd', {}, `${s.tickMs} ms tick · ${s.roundMs} ms combat round`),
            el('dt', {}, 'places'), el('dd', {}, String(s.places)),
            el('dt', {}, 'spawn'), el('dd', {}, `room ${s.spawn.room} — ${s.spawn.name}`),
            el('dt', {}, 'admin'), el('dd', {}, s.token),
          ),
        ),
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Zones'),
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el('tr', {}, el('th', {}, 'id'), el('th', {}, 'name'), el('th', { class: 'num' }, 'rooms'), el('th', {}, 'levels'), el('th', {}, 'populated')),
            ),
            el(
              'tbody',
              {},
              ...s.zones.map((zone) =>
                el(
                  'tr',
                  {},
                  el('td', { class: 'num' }, String(zone.id)),
                  el('td', {}, zone.name),
                  el('td', { class: 'num' }, String(zone.rooms)),
                  el('td', {}, zone.levels.join(', ')),
                  el('td', {}, zone.populated ? 'yes' : el('span', { class: 'muted' }, 'no')),
                ),
              ),
            ),
          ),
        ),
        el(
          'div',
          { class: 'card' },
          el('h3', {}, 'Light catalogue'),
          el('p', { class: 'note' }, 'The one item-shaped thing in the game (code, not data — items are Phase 15). Read-only.'),
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, el('th', {}, 'id'), el('th', {}, 'name'), el('th', { class: 'num' }, 'radius'), el('th', {}, 'mode'), el('th', {}, 'burn'))),
            el(
              'tbody',
              {},
              ...s.lights.map((light) =>
                el(
                  'tr',
                  {},
                  el('td', {}, light.id),
                  el('td', {}, light.name),
                  el('td', { class: 'num' }, String(light.radius)),
                  el('td', {}, light.mode),
                  el('td', {}, light.durationMs === null ? 'never goes out' : duration(light.durationMs)),
                ),
              ),
            ),
          ),
        ),
      );
    };
    void refresh();
    timer = window.setInterval(() => void refresh(), 5000);
  },
  unmount(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  },
};
