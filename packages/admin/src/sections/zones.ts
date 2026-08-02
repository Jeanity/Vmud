/**
 * Zones — browse at A3, author at A5.
 *
 * Three columns, narrowing left to right: which zones are loaded, which rooms are in one, and what
 * one room actually is — with, since A5, the form that changes it. The design doc's §1 is what shapes
 * the write half: the base world data is *generated*, so an edit made there would be lost by the next
 * `npm run worldgen`. Authoring therefore lands in `data/world/overrides/rooms.json` and is composed
 * over the generated zones at load. The panel never writes a world file.
 *
 * **What makes it worth having open while testing is the live half.** The room list says where the
 * population actually *is*, not where the reset table meant to put it; the zone list counts down to
 * the next repop; and a room's exits carry the door state as it stands this second. None of those
 * can be read off the world files.
 */

import { ROOM_FLAGS, SECTORS } from '@mygame/shared';

import { call, type RoomDetail, type ZoneRoomsBody, type ZonesBody, type ZoneRow } from '../api.ts';
import { colourBox } from '../colourbox.ts';
import { ago, duration, el, render } from '../dom.ts';
import { drawZoneMap } from '../zonemap.ts';

let timer: number | undefined;
let pickedZone: number | undefined;
let pickedRoom: number | undefined;
/** Only rooms on this level are listed, or every one when undefined. */
let pickedLevel: number | undefined;
/** Narrow the list to rooms nobody has written yet — the authoring queue. */
let needProse = false;

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
          'standing where, and which doors are shut. Pick a room to rewrite its name, prose, terrain ' +
          'and flags: edits land in an overlay that survives npm run worldgen and take effect without ' +
          'a restart.',
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
      // Re-fetched after a save rather than patched in place: the server decides what an edit
      // actually became — a trimmed name, a flag list deduplicated — and the form must show that
      // rather than what was typed. The zone is refetched too, so the map's authored marks follow.
      renderRoom(detailPane, result.body, () => {
        void showRoom(id);
        if (pickedZone !== undefined) void showZone(pickedZone);
      });
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
  const onLevel = pickedLevel === undefined ? body.rooms : body.rooms.filter((room) => room.level === pickedLevel);
  // **The work queue.** Two thirds of the loaded world has no prose, so "which rooms still need
  // writing" is the question an author actually opens this pane with — and without a filter the
  // answer is scrolling 219 rows looking for a blank column.
  const shown = needProse ? onLevel.filter((room) => !room.described) : onLevel;
  const undescribed = onLevel.filter((room) => !room.described).length;

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
      el(
        'div',
        { class: 'row' },
        el(
          'button',
          {
            class: needProse ? 'on' : '',
            onclick: () => {
              needProse = !needProse;
              rerender();
            },
          },
          `needs prose — ${undescribed}`,
        ),
      ),
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
                // The one mark that says "somebody wrote this" — without it, finding your own work
                // again in a 219-room zone means opening rooms until you recognise one.
                room.authored ? el('span', { class: 'pill authored' }, '✎') : null,
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

function renderRoom(pane: HTMLElement, room: RoomDetail, reload: () => void): void {
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
      roomEditor(room, reload),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* The editor — A5                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The authoring half: name, terrain, flags and prose, saved to the overlay and applied live.
 *
 * **What is missing is deliberate.** No exits, no position, no id — those are geometry, they are the
 * join key into every data source we have and the grid the tilemap is carved from, and the server
 * refuses them rather than ignoring them. A5 is content; A8 is geometry, and it has four decisions in
 * front of it.
 *
 * The save button stays disabled until something actually changes, which is not politeness: an
 * unchanged save would still stamp the overlay and mark the room authored, so a room could acquire a
 * permanent override by being *looked at*. Comparing against what was loaded is the whole guard.
 */
function roomEditor(room: RoomDetail, reload: () => void): HTMLElement {
  const authored = room.authored;
  const flash = el('p', { class: 'note' });

  const name = colourBox({ value: room.name, placeholder: 'the room’s name' });
  const prose = colourBox({
    value: room.description ?? '',
    multiline: true,
    rows: 10,
    placeholder: 'What a player reads on walking in. Colour it with the swatches above.',
  });

  const sector = el(
    'select',
    {},
    ...SECTORS.map((s) => el('option', { value: s, ...(s === room.sector ? { selected: true } : {}) }, s)),
  );

  const flagBoxes = ROOM_FLAGS.map((flag) => {
    const box = el('input', { type: 'checkbox', id: `flag-${flag}` });
    box.checked = room.flags.includes(flag);
    return { flag, box };
  });

  const save = el('button', { class: 'primary', disabled: true }, 'Save');

  // Compared against what was loaded rather than tracked as a dirty bit, so undoing an edit by hand
  // correctly disables the button again.
  const changed = (): boolean =>
    name.value() !== room.name ||
    prose.value() !== (room.description ?? '') ||
    sector.value !== room.sector ||
    flagBoxes.some(({ flag, box }) => box.checked !== room.flags.includes(flag));

  const retest = (): void => {
    if (changed()) save.removeAttribute('disabled');
    else save.setAttribute('disabled', '');
  };
  name.field.addEventListener('input', retest);
  prose.field.addEventListener('input', retest);
  sector.addEventListener('change', retest);
  for (const { box } of flagBoxes) box.addEventListener('change', retest);

  save.addEventListener('click', () => {
    void (async () => {
      save.setAttribute('disabled', '');
      flash.className = 'note';
      flash.textContent = 'saving…';
      // Only what moved. Sending the whole form would author every field of a room whose prose was
      // the only thing touched, and "authored" is what the revert button acts on.
      const patch: Record<string, unknown> = {};
      if (name.value() !== room.name) patch.name = name.value();
      if (prose.value() !== (room.description ?? '')) patch.description = prose.value();
      if (sector.value !== room.sector) patch.sector = sector.value;
      if (flagBoxes.some(({ flag, box }) => box.checked !== room.flags.includes(flag))) {
        patch.flags = flagBoxes.filter(({ box }) => box.checked).map(({ flag }) => flag);
      }
      const result = await call('PATCH', `/rooms/${room.id}`, patch);
      if (!result.ok) {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'refused';
        retest();
        return;
      }
      flash.className = 'flash ok';
      flash.textContent = 'Saved. Anyone standing there has been re-shown the room.';
      reload();
    })();
  });

  const revert = (fields: readonly string[], label: string): HTMLElement =>
    el(
      'button',
      {
        onclick: () => {
          void (async () => {
            // `null` per field is how the server is told to *unauthor* rather than to blank — an
            // empty description is a room deliberately left silent, which is a different thing.
            const patch = Object.fromEntries(fields.map((f) => [f, null]));
            const result = await call('PATCH', `/rooms/${room.id}`, patch);
            flash.className = result.ok ? 'flash ok' : 'flash err';
            flash.textContent = result.ok ? `Reverted ${label} to the generated world.` : result.error ?? 'refused';
            if (result.ok) reload();
          })();
        },
      },
      `Revert ${label}`,
    );

  const authoredFields = authored ? Object.keys(authored).filter((k) => k !== 'at') : [];

  return el(
    'div',
    {},
    el(
      'h3',
      {},
      'Edit',
      authoredFields.length > 0 ? el('span', { class: 'pill' }, `authored: ${authoredFields.join(', ')}`) : null,
    ),
    el(
      'p',
      { class: 'note' },
      authoredFields.length > 0
        ? `Saved to data/world/overrides/rooms.json${authored?.at ? ` — last written ${ago(authored.at)}` : ''}. ` +
          'It survives npm run worldgen.'
        : 'Exactly as generated. Anything saved here lands in data/world/overrides/rooms.json and ' +
          'survives npm run worldgen — the generated files are never written to.',
    ),
    el('label', { class: 'field' }, el('span', {}, 'name'), name.node),
    el('label', { class: 'field' }, el('span', {}, 'prose'), prose.node),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'field' }, el('span', {}, 'sector'), sector),
    ),
    el('span', { class: 'field-label' }, 'flags'),
    el(
      'div',
      { class: 'flag-grid' },
      ...flagBoxes.map(({ flag, box }) => el('label', { class: 'flagbox' }, box, el('span', {}, flag))),
    ),
    el('div', { class: 'row' }, save, ...(authoredFields.length > 0 ? [revert(authoredFields, 'everything')] : [])),
    flash,
    // Stated rather than left to be discovered by trying it: a builder who expects to move a room and
    // finds no control should learn why here, not from a 400.
    el(
      'p',
      { class: 'note' },
      'Exits, position and room id are not editable: they are the join key into the source data and ' +
        'the grid the tilemap is carved from. Zone geometry is A8.',
    ),
  );
}
