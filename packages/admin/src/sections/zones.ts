/**
 * Zones — read-only. Track A3.
 *
 * Three columns, narrowing left to right: which zones are loaded, which rooms are in one, and what
 * one room actually is. Read-only on purpose and by the design doc's §1: the base world data is
 * *generated*, so anything editable here would be lost by the next `npm run worldgen` — authoring
 * lands in A5 as overlay files that survive it.
 *
 * **What makes it worth having open while testing is the live half.** The room list says where the
 * population actually *is*, not where the reset table meant to put it; the zone list counts down to
 * the next repop; and a room's exits carry the door state as it stands this second. None of those
 * can be read off the world files.
 */

import { call, type RoomDetail, type ZoneRoomsBody, type ZonesBody, type ZoneRow } from '../api.ts';
import { duration, el, render } from '../dom.ts';
import { drawZoneMap } from '../zonemap.ts';

let timer: number | undefined;
let pickedZone: number | undefined;
let pickedRoom: number | undefined;
/** Only rooms on this level are listed, or every one when undefined. */
let pickedLevel: number | undefined;

export const zonesSection = {
  slug: 'zones',
  title: 'Zones',
  mount(root: HTMLElement): void {
    const zonePane = el('div', {});
    const roomPane = el('div', {});
    const detailPane = el('div', {});

    render(
      root,
      el('h2', {}, 'Zones'),
      el(
        'p',
        { class: 'note' },
        'What is loaded, what is in it, and what is happening in it right now — repop clocks, who is ' +
          'standing where, and which doors are shut. Read-only: the world data is generated, so ' +
          'authoring lands in A5 as overlay files that survive a rebuild.',
      ),
      el('div', { class: 'columns3' }, zonePane, roomPane, detailPane),
    );

    const showRoom = async (id: number): Promise<void> => {
      pickedRoom = id;
      const result = await call<RoomDetail>('GET', `/rooms/${id}`);
      if (!result.ok || !result.body) {
        render(detailPane, el('div', { class: 'card' }, el('p', { class: 'flash err' }, result.error ?? 'gone')));
        return;
      }
      renderRoom(detailPane, result.body);
    };

    const showZone = async (id: number): Promise<void> => {
      pickedZone = id;
      const result = await call<ZoneRoomsBody>('GET', `/zones/${id}/rooms`);
      if (!result.ok || !result.body) {
        render(roomPane, el('div', { class: 'card' }, el('p', { class: 'flash err' }, result.error ?? 'gone')));
        return;
      }
      const body = result.body;
      // Redrawn from the body already in hand rather than refetched: changing level or picking a
      // room is a change of *view*, and going back to the server for it would make the map flicker
      // and the selection arrive a round-trip late.
      const redraw = (): void => {
        renderRooms(
          roomPane,
          body,
          (room) => {
            void showRoom(room);
            redraw();
          },
          redraw,
        );
      };
      redraw();
    };

    const refreshZones = async (): Promise<void> => {
      const result = await call<ZonesBody>('GET', '/zones');
      if (!result.ok || !result.body) {
        render(zonePane, el('p', { class: 'flash err' }, result.error ?? 'unreachable'));
        return;
      }
      renderZones(zonePane, result.body.zones, (id) => {
        pickedLevel = undefined;
        pickedRoom = undefined;
        render(detailPane);
        void showZone(id);
      });
    };

    void (async () => {
      await refreshZones();
      // Reopen whatever was being looked at, so switching tabs and back does not lose your place.
      if (pickedZone !== undefined) await showZone(pickedZone);
      if (pickedRoom !== undefined) await showRoom(pickedRoom);
    })();
    // Only the zone list polls: it is the one with a clock in it, and re-rendering the room list
    // under the operator's cursor while they are reading it would be its own small hell.
    timer = window.setInterval(() => void refreshZones(), 5000);
  },
  unmount(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  },
};

function renderZones(pane: HTMLElement, zones: readonly ZoneRow[], pick: (id: number) => void): void {
  render(
    pane,
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `Loaded — ${zones.length}`),
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, el('th', { class: 'num' }, 'id'), el('th', {}, 'zone'), el('th', { class: 'num' }, 'rooms'), el('th', {}, 'repop')),
        ),
        el(
          'tbody',
          {},
          ...zones.map((zone) =>
            el(
              'tr',
              { class: `pick${pickedZone === zone.id ? ' picked' : ''}`, onclick: () => pick(zone.id) },
              el('td', { class: 'num' }, String(zone.id)),
              el(
                'td',
                {},
                zone.name,
                el(
                  'div',
                  { class: 'muted', style: 'font-size:11px' },
                  `${zone.levels.length} level${zone.levels.length === 1 ? '' : 's'} · ` +
                    `${zone.described} with prose · ${zone.flagged} flagged`,
                ),
              ),
              el('td', { class: 'num' }, String(zone.rooms)),
              // A dash, not a zero: a zone with no population never repops, which is a different
              // fact from one that is about to.
              el('td', {}, zone.repopInMs === null ? el('span', { class: 'muted' }, '—') : duration(zone.repopInMs)),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderRooms(
  pane: HTMLElement,
  body: ZoneRoomsBody,
  pick: (id: number) => void,
  rerender: () => void,
): void {
  const levels = [...new Set(body.rooms.map((room) => room.level))].sort((a, b) => a - b);
  const shown = pickedLevel === undefined ? body.rooms : body.rooms.filter((room) => room.level === pickedLevel);

  const levelButton = (level: number | undefined, label: string): HTMLElement =>
    el(
      'button',
      {
        class: pickedLevel === level ? 'on' : '',
        onclick: () => {
          pickedLevel = level;
          rerender();
        },
      },
      label,
    );

  // **The map, when one level is chosen.** A level is a grid; "all" is eleven grids stacked on top of
  // each other, which is not a drawing of anything — so the map appears exactly when it means
  // something, and the table is always there underneath for finding a room by name.
  const map =
    pickedLevel === undefined
      ? el(
          'p',
          { class: 'note' },
          'Pick a level to see it drawn — a zone is up to eleven of them, and stacking them would ' +
            'be a picture of nothing.',
        )
      : el(
          'div',
          { class: 'zone-map-frame' },
          drawZoneMap({ rooms: body.rooms, level: pickedLevel, selected: pickedRoom, onPick: pick }),
        );

  render(
    pane,
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `${body.zone.name} — ${shown.length} room${shown.length === 1 ? '' : 's'}`),
      // A zone is up to eleven levels and two hundred rooms; without this the list is a wall.
      el('div', { class: 'row' }, levelButton(undefined, 'all'), ...levels.map((l) => levelButton(l, `L${l}`))),
      map,
      el(
        'table',
        {},
        el(
          'thead',
          {},
          el('tr', {}, el('th', { class: 'num' }, 'id'), el('th', {}, 'room'), el('th', {}, 'sector'), el('th', {}, 'in it')),
        ),
        el(
          'tbody',
          {},
          ...shown.map((room) => {
            const here = [...room.occupants.mobs, ...room.occupants.players];
            return el(
              'tr',
              { class: `pick${pickedRoom === room.id ? ' picked' : ''}`, onclick: () => pick(room.id) },
              el('td', { class: 'num' }, String(room.id)),
              el(
                'td',
                {},
                room.name,
                room.flags.length > 0 ? el('span', { class: 'pill' }, room.flags.join(' ')) : null,
              ),
              el('td', { class: 'muted' }, room.sector),
              el(
                'td',
                { class: 'muted' },
                here.length === 0 && room.occupants.corpses.length === 0
                  ? ''
                  : `${here.length > 0 ? here.length : ''}${room.occupants.corpses.length > 0 ? ` ☠${room.occupants.corpses.length}` : ''}`,
              ),
            );
          }),
        ),
      ),
    ),
  );
}

function renderRoom(pane: HTMLElement, room: RoomDetail): void {
  const here = [
    ...room.occupants.players.map((name) => `${name} (player)`),
    ...room.occupants.mobs,
    ...room.occupants.corpses,
  ];
  render(
    pane,
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `${room.name} `, el('span', { class: 'pill' }, `#${room.id}`)),
      el(
        'dl',
        { class: 'kv' },
        el('dt', {}, 'place'),
        el('dd', {}, `${room.place} — cell ${room.pos.x},${room.pos.y}`),
        el('dt', {}, 'sector'),
        el('dd', {}, room.sector),
        el('dt', {}, 'flags'),
        el('dd', {}, room.flags.length > 0 ? room.flags.join(', ') : el('span', { class: 'muted' }, 'none')),
        el('dt', {}, 'standing here'),
        el('dd', {}, here.length > 0 ? here.join(', ') : el('span', { class: 'muted' }, 'nothing')),
      ),
      el('h3', {}, 'Exits'),
      room.exits.length === 0
        ? el('p', { class: 'note' }, 'None — this room is a dead end.')
        : el(
            'table',
            {},
            el(
              'tbody',
              {},
              ...room.exits.map((exit) =>
                el(
                  'tr',
                  {},
                  el('td', {}, exit.dir),
                  el('td', {}, `${exit.toName} (${exit.to})`),
                  el(
                    'td',
                    { class: 'muted' },
                    exit.portal ? 'portal ' : '',
                    // The live half: shut is what stops you walking through, locked is what stops
                    // you opening it. `LOCKS_HOLD` is off, so locked is shown and does not bite.
                    exit.door
                      ? `${exit.door.name} — ${exit.door.closed ? 'shut' : 'open'}${exit.door.locked ? ', locked' : ''}`
                      : '',
                  ),
                ),
              ),
            ),
          ),
      el('h3', {}, 'Prose'),
      room.description
        ? el('p', { class: 'prose' }, room.description)
        : el(
            'p',
            { class: 'note' },
            'None. Most rooms have none — 5,889 of 46,508 carry prose, all of it from the Duris harvest.',
          ),
    ),
  );
}
