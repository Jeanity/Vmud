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

import { ROOM_FLAGS, SECTORS, parseColour } from '@mygame/shared';

import { call, type RoomDetail, type ZoneRoomsBody, type ZonesBody, type ZoneRow } from '../api.ts';
import { colourBox } from '../colourbox.ts';
import { draftControl } from '../draft.ts';
import { ago, duration, el, render } from '../dom.ts';
import { drawZoneMap } from '../zonemap.ts';

/**
 * What `DELETE /rooms/:id` answers with — A8 slice 2.
 *
 * Declared here rather than in `api.ts` because nothing else reads it: this is the shape of one
 * report shown once, not a row type the rest of the panel shares.
 */
interface DeleteReport {
  readonly room: { readonly id: number; readonly name: string };
  readonly orphans: readonly { readonly from: number; readonly dir: string }[];
  readonly resets: Readonly<Record<string, number>>;
  readonly orphanedResets: number;
  readonly cleared: { readonly mobs: number; readonly corpses: number; readonly items: number };
  /** A8 slice 3: whether the grid moved, and what that cost. Absent on a delete that fit. */
  readonly extentChanged: boolean;
  readonly mapsCleared?: number;
  readonly told?: number;
}

/** What `POST /zones/:id/rooms` answers with. Same slice-3 tail as {@link DeleteReport}. */
interface BuildReport {
  readonly room: { readonly id: number; readonly name: string };
  readonly extentChanged: boolean;
  readonly mapsCleared?: number;
  readonly told?: number;
}

let timer: number | undefined;
let pickedZone: number | undefined;
let pickedRoom: number | undefined;
/** Only rooms on this level are listed, or every one when undefined. */
let pickedLevel: number | undefined;
/** Narrow the list to rooms nobody has written yet — the authoring queue. */
let needProse = false;
/**
 * The empty cell being built into, or nothing. A8.
 *
 * Kept beside `pickedRoom` and cleared whenever one is chosen, because they are the same slot on
 * screen: the right-hand pane shows either the room you are looking at or the room you are making,
 * never both. Two selections that can be live at once is how an operator saves an edit into the wrong
 * one.
 */
let pickedGap: { x: number; y: number } | undefined;

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
      pickedGap = undefined;
      const result = await call<RoomDetail>('GET', `/rooms/${id}`);
      if (!result.ok || !result.body) {
        render(detailPane, el('div', { class: 'card' }, el('p', { class: 'flash err' }, result.error ?? 'gone')));
        return;
      }
      // Re-fetched after a save rather than patched in place: the server decides what an edit
      // actually became — a trimmed name, a flag list deduplicated — and the form must show that
      // rather than what was typed. The zone is refetched too, so the map's authored marks follow.
      const zoneName = result.body.place;
      renderRoom(
        detailPane,
        result.body,
        () => {
          void showRoom(id);
          if (pickedZone !== undefined) void showZone(pickedZone);
        },
        // **The report replaces the room, and the selection is dropped first.** Re-fetching the room
        // to redraw the pane is what every other write here does and is exactly wrong after a delete:
        // it would 404, and the reopen-what-you-were-looking-at logic at mount would 404 again next
        // time the tab is opened.
        (report) => {
          pickedRoom = undefined;
          render(detailPane, removalReport(report, zoneName));
          if (pickedZone !== undefined) void showZone(pickedZone);
        },
      );
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
          // **Building into a gap.** The cell is already chosen by the click, so the form opens
          // where a room's detail would be and the map marks the hole it is going to fill. On
          // success the zone is refetched — the new room has to reach the map and the room list
          // from the server rather than being drawn from what the form thought it sent.
          (x, y) => {
            pickedGap = { x, y };
            pickedRoom = undefined;
            if (pickedLevel === undefined) return;
            render(
              detailPane,
              roomBuilder(
                id,
                pickedLevel,
                { x, y },
                body.rooms,
                // **A build that resized the Place stops and says so, rather than sailing on into
                // the new room's editor.** Everything else here can be undone by writing again;
                // this one just took every character's explored map of the area, and walking
                // straight past that would be the panel deciding it did not matter.
                (report) => {
                  pickedGap = undefined;
                  if (report.extentChanged) {
                    render(detailPane, resizeReport(report));
                    void showZone(id);
                    return;
                  }
                  void showZone(id).then(() => showRoom(report.room.id));
                },
                () => {
                  pickedGap = undefined;
                  render(detailPane);
                  redraw();
                },
              ),
            );
            redraw();
          },
          (room) => {
            // **Picking a room shows it in place.** Owner, 2026-08-02: the "needs prose" list is a
            // work queue, and a queue that answers "which room" without answering "where" is half
            // an answer — the surrounding rooms are the context you write from. The map only draws
            // one level (eleven stacked is a picture of nothing), so choosing a room chooses its
            // level too, and the map appears around the selection rather than staying hidden.
            const row = body.rooms.find((candidate) => candidate.id === room);
            if (row) pickedLevel = row.level;
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
      renderZones(zonePane, result.body.zones, result.body.pending ?? [], refreshZones, (id) => {
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

function renderZones(
  pane: HTMLElement,
  zones: readonly ZoneRow[],
  pending: readonly { id: number; name: string; note: string }[],
  refresh: () => Promise<void>,
  pick: (id: number) => void,
): void {
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
              // A4. **Offered only where there is a population to repop**, because the server refuses
              // the rest by name and a button whose only outcome is a refusal is worse than no button.
              // The click does not stop propagating: selecting the zone you just repopped is what you
              // want next, and the row's own handler does that.
              el(
                'td',
                {},
                zone.repopInMs === null
                  ? ''
                  : el(
                      'button',
                      {
                        type: 'button',
                        title: 'Run this zone’s reset now. Additive — nothing despawns, and per-vnum limits still hold.',
                        onclick: (event: Event) => {
                          const button = event.currentTarget as HTMLButtonElement;
                          void (async () => {
                            const done = await call<{ spawned: number; doors: number; objects: number; atLimit: number }>(
                              'POST',
                              `/zones/${zone.id}/repop`,
                            );
                            // Reported on the button itself rather than in a flash somewhere else: the
                            // interesting number is `atLimit`, and it is what tells an operator that
                            // hammering this does *not* fill the zone.
                            button.textContent = done.ok && done.body
                              ? `+${done.body.spawned} mobs, ${done.body.atLimit} at limit`
                              : done.error ?? 'refused';
                            setTimeout(() => { button.textContent = 'Repop'; }, 4000);
                          })();
                        },
                      },
                      'Repop',
                    ),
              ),
            ),
          ),
        ),
      ),
    ),
    // A8d: created zones the config does not load yet. Their whole state is one sentence, and the
    // sentence is the server's — the note names the file and the restart, so the panel never has to.
    ...(pending.length === 0
      ? []
      : [
          el(
            'div',
            { class: 'card' },
            el('h3', {}, `Created, not loaded — ${pending.length}`),
            ...pending.map((zone) =>
              el(
                'p',
                { class: 'note' },
                `${zone.id} — ${zone.name}`,
                el('div', { class: 'muted', style: 'font-size:11px' }, zone.note),
              ),
            ),
          ),
        ]),
    zoneCreator(refresh),
  );
}

/**
 * A8d — a zone from nothing: a name, and the server does the rest. The response's `note` is shown
 * verbatim, because the config edit and the restart are *deliberately* not this panel's to perform —
 * which zones load is a file, and the person holding the file should read the instruction the server
 * wrote rather than a paraphrase.
 */
function zoneCreator(refresh: () => Promise<void>): HTMLElement {
  const name = el('input', { type: 'text', placeholder: 'zone name — e.g. The Sunken Stair', maxlength: '60' }) as HTMLInputElement;
  const roomName = el('input', { type: 'text', placeholder: 'first room (optional)', maxlength: '80' }) as HTMLInputElement;
  const flash = el('p', { class: 'note muted' });
  const create = el('button', { type: 'button' }, 'Create zone') as HTMLButtonElement;
  create.addEventListener('click', () => {
    void (async () => {
      create.disabled = true;
      const body: Record<string, string> = { name: name.value, by: 'panel' };
      if (roomName.value.trim()) body.roomName = roomName.value.trim();
      const made = await call<{ zone: number; room: number; note: string }>('POST', '/zones', body);
      create.disabled = false;
      if (!made.ok || !made.body) {
        flash.className = 'flash err';
        flash.textContent = made.error ?? 'refused';
        return;
      }
      flash.className = 'note';
      flash.textContent = made.body.note;
      name.value = '';
      roomName.value = '';
      await refresh();
    })();
  });
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'New zone'),
    el('p', { class: 'note muted' }, 'Creates the zone and its first room at the origin. Loading it is a config line and a restart — the answer says exactly which.'),
    name,
    roomName,
    create,
    flash,
  );
}

function renderRooms(
  pane: HTMLElement,
  body: ZoneRoomsBody,
  onGap: (x: number, y: number) => void,
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
          drawZoneMap({
            rooms: body.rooms,
            level: pickedLevel,
            selected: pickedRoom,
            onPick: pick,
            onGap,
            ...(pickedGap ? { gap: pickedGap } : {}),
          }),
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

/**
 * Open/shut and lock/unlock for one doorway — A4.
 *
 * **Two independent buttons rather than one three-state control**, because the two flags are
 * independent in the world: `LOCKS_HOLD` is off, so a locked door still opens, and an operator
 * testing the day it goes on has to be able to set them apart. A combined control would have to
 * invent an ordering between them and would be wrong the moment locks bite.
 *
 * Each says what it *will do*, not what the door is — the state is already three columns to the left,
 * and a button labelled with the current state is the classic way to make somebody close a door they
 * meant to open.
 */
function doorControls(
  room: number,
  dir: string,
  door: { name: string; closed: boolean; locked: boolean },
  reload: () => void,
): HTMLElement {
  const work = (patch: Record<string, unknown>) => () => {
    void (async () => {
      await call('POST', `/rooms/${room}/door`, { dir, ...patch });
      // Reloaded rather than patched in place: the server owns both ends of the doorway and the room
      // detail is what shows them, so re-reading is the only way the panel and the world cannot drift.
      reload();
    })();
  };
  return el(
    'span',
    { class: 'door-ops' },
    el('button', { type: 'button', onclick: work({ closed: !door.closed }) }, door.closed ? 'open' : 'shut'),
    el('button', { type: 'button', onclick: work({ locked: !door.locked }) }, door.locked ? 'unlock' : 'lock'),
  );
}

function renderRoom(pane: HTMLElement, room: RoomDetail, reload: () => void, gone: (report: DeleteReport) => void): void {
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
                  // A destination off the loaded world is still a destination. Every staircase in
                  // IceCrag leads into zone 219 — a separate zone file — and used to read as
                  // "(not loaded)", which told an author nothing about what is up those stairs.
                  exit.loaded
                    ? el('td', {}, `${exit.toName} (${exit.to})`)
                    : el(
                        'td',
                        {},
                        exit.toName ?? `room ${exit.to}`,
                        ` (${exit.to})`,
                        el('span', { class: 'pill' }, exit.toZone ? exit.toZone.name : 'unmapped'),
                      ),
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
                  // A4: work it from here. Only where there *is* a door — an empty cell on every
                  // other exit would suggest one could be added, and geometry is A8's.
                  el('td', {}, exit.door ? doorControls(room.id, exit.dir, exit.door, reload) : ''),
                ),
              ),
            ),
          ),
      nearbyProse(room),
      roomEditor(room, reload),
      roomRemover(room, gone),
    ),
  );
}

/**
 * The neighbourhood's prose, above the editor.
 *
 * **The owner's case, and it is the whole argument** (2026-08-02): "Southwestern Corner Of the
 * Banquet Hall" is one of IceCrag's three unwritten rooms, and its name is nearly everything you
 * have. Whether that hall is laid for a feast or standing in ruins is not in the name, not in the
 * sector, and not recoverable by thinking harder — it is in the room next door. Writing without it
 * produces something plausible and wrong, and a model writing without it does the same thing faster.
 *
 * Placed *above* the box rather than in a tab or a popover: it has to be readable while you type, or
 * it is not context, it is a lookup.
 *
 * Prose is rendered through the same painter the client uses, because the neighbours are coloured and
 * a new room should match its neighbours' colour as well as their subject.
 */
function nearbyProse(room: RoomDetail): HTMLElement | null {
  if (room.nearby.length === 0) return null;
  const described = room.nearby.filter((near) => near.description);

  return el(
    'details',
    // Open when the room being looked at has nothing of its own — which is exactly when it is about
    // to be written, and exactly when the neighbours are the only thing to write from.
    room.description ? { class: 'nearby' } : { class: 'nearby', open: true },
    el(
      'summary',
      {},
      `Nearby — ${room.nearby.length} room${room.nearby.length === 1 ? '' : 's'} within two steps`,
      described.length === 0
        ? el('span', { class: 'pill' }, 'none described')
        : el('span', { class: 'pill' }, `${described.length} with prose`),
    ),
    ...room.nearby.map((near) =>
      el(
        'div',
        { class: 'near' },
        el(
          'div',
          { class: 'near-head' },
          el('span', { class: 'muted' }, near.dir ? `${near.dir}${near.hops > 1 ? ` ×${near.hops}` : ''} · ` : ''),
          near.name,
          el('span', { class: 'muted' }, ` · ${near.sector} · #${near.id}`),
          // A room from a zone this server does not run is still good context; it is just not
          // somewhere a player can walk today, and conflating the two would mislead.
          near.loaded ? null : el('span', { class: 'pill' }, 'not in play'),
        ),
        near.description
          ? painted('div', 'near-prose', near.description)
          : el('div', { class: 'near-prose muted' }, 'no description'),
      ),
    ),
  );
}

/** A node whose text is rendered with the MUD's colour codes honoured. Spans, never HTML. */
function painted(tag: 'div' | 'p', className: string, text: string): HTMLElement {
  const node = el(tag, { class: className });
  for (const span of parseColour(text)) {
    const part = el('span', {}, span.text);
    if (span.colour !== undefined) part.style.color = span.colour;
    node.append(part);
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/* Building a room — A8                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The form behind an empty cell on the map.
 *
 * **Where the room goes is already answered by the time this opens** — it is the cell that was
 * clicked — which is the reason the map hosts this and a coordinate field does not exist. What is
 * left to decide is what the room *is*, and which of its neighbours it opens onto.
 *
 * **The exits are checkboxes over the rooms that are actually there**, never a free direction list.
 * An infill room's exit has no destination to choose: it is whatever stands in the adjacent cell, so
 * offering `north` where nothing lies north is offering a refusal. The panel derives them from the
 * rooms it is already drawing, so the list on screen and the list the server will accept are the
 * same list by construction.
 *
 * At least one must be ticked, and the button says so rather than the server having to. A room with
 * no way in is not something to explain after the fact.
 */
function roomBuilder(
  zoneId: number,
  level: number,
  gap: { x: number; y: number },
  rooms: readonly import('../api.ts').ZoneRoomRow[],
  done: (report: BuildReport) => void,
  cancel: () => void,
): HTMLElement {
  const flash = el('p', { class: 'note' });

  const byCell = new Map<string, (typeof rooms)[number]>();
  for (const room of rooms) if (room.level === level) byCell.set(`${room.x},${room.y}`, room);

  const neighbours = (
    [
      ['north', 0, -1],
      ['east', 1, 0],
      ['south', 0, 1],
      ['west', -1, 0],
    ] as const
  )
    .flatMap(([dir, dx, dy]) => {
      const room = byCell.get(`${gap.x + dx},${gap.y + dy}`);
      // A neighbour whose exit back this way is already spoken for cannot be joined — the server
      // refuses rather than replacing one, so the panel shows it greyed with the reason instead of
      // offering a tick that will fail.
      return room ? [{ dir: dir as string, room, taken: room.exits.some((exit) => exit.dir === OPPOSITE_DIR[dir]) }] : [];
    });

  const name = colourBox({ value: '', placeholder: 'the room’s name' });
  const prose = colourBox({
    value: '',
    multiline: true,
    rows: 8,
    placeholder: 'What a player reads on walking in. Colour it with the swatches above.',
  });
  const sector = el('select', {}, ...SECTORS.map((s) => el('option', { value: s }, s)));
  const flagBoxes = ROOM_FLAGS.map((flag) => ({ flag, box: el('input', { type: 'checkbox', id: `new-flag-${flag}` }) }));

  // **A8 slice 3: is this cell outside what the level already covers?** Computed here from the rooms
  // the panel is already drawing rather than asked of the server, because the warning has to be on
  // screen *before* the button is pressed — the server can only tell you afterwards, and afterwards
  // is too late for a thing that clears everybody's explored map.
  const onLevel = rooms.filter((r) => r.level === level);
  const widens =
    onLevel.length === 0 ||
    gap.x < Math.min(...onLevel.map((r) => r.x)) ||
    gap.x > Math.max(...onLevel.map((r) => r.x)) ||
    gap.y < Math.min(...onLevel.map((r) => r.y)) ||
    gap.y > Math.max(...onLevel.map((r) => r.y));

  const build = el('button', { class: widens ? 'danger' : 'primary', disabled: true }, widens ? 'Build room, and reset every map here' : 'Build room');
  const exitBoxes = neighbours.map((entry) => {
    const box = el('input', { type: 'checkbox', id: `new-exit-${entry.dir}` });
    if (entry.taken) box.disabled = true;
    return { ...entry, box };
  });

  const retest = (): void => {
    build.disabled = !name.value().trim() || !exitBoxes.some((entry) => entry.box.checked);
  };
  name.field.addEventListener('input', retest);
  for (const entry of exitBoxes) entry.box.addEventListener('change', retest);

  build.addEventListener('click', () => {
    void (async () => {
      build.disabled = true;
      const result = await call<BuildReport>('POST', `/zones/${zoneId}/rooms`, {
        name: name.value().trim(),
        description: prose.value(),
        sector: (sector as HTMLSelectElement).value,
        flags: flagBoxes.filter((entry) => entry.box.checked).map((entry) => entry.flag),
        x: gap.x,
        y: gap.y,
        level,
        exits: exitBoxes.filter((entry) => entry.box.checked).map((entry) => entry.dir),
      });
      if (!result.ok || !result.body) {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'refused';
        build.disabled = false;
        return;
      }
      done(result.body);
    })();
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Build a room ', el('span', { class: 'pill' }, `cell ${gap.x},${gap.y} · L${level}`)),
    widens
      ? el(
          'p',
          { class: 'flash err' },
          'This cell is outside what the level covers, so building here makes the grid bigger — and ' +
            'every explored map of this place is measured from a corner that would move. They will ' +
            'all be reset, for every character, online or not, and the people standing here will be ' +
            'told. Pick a cell inside the shape if you would rather not.',
        )
      : el(
          'p',
          { class: 'note' },
          'A room built inside the level’s current extent — filling a gap resizes nothing, so every ' +
            'explored map of this place stays valid. It is saved to an overlay that survives npm run ' +
            'worldgen and takes effect with no restart.',
        ),
    el('span', { class: 'field-label' }, 'name'),
    name.node,
    el('span', { class: 'field-label' }, 'terrain'),
    sector,
    el('span', { class: 'field-label' }, 'flags'),
    el(
      'div',
      { class: 'flag-grid' },
      ...flagBoxes.map(({ flag, box }) => el('label', { class: 'flagbox' }, box, el('span', {}, flag))),
    ),
    el('span', { class: 'field-label' }, 'ways out'),
    neighbours.length === 0
      ? el('p', { class: 'flash err' }, 'Nothing adjoins this cell, so there is no way in. Pick one beside a room.')
      : el(
          'div',
          { class: 'flag-grid' },
          ...exitBoxes.map((entry) =>
            el(
              'label',
              { class: 'flagbox' },
              entry.box,
              el(
                'span',
                entry.taken ? { class: 'muted' } : {},
                `${entry.dir} — ${entry.room.name}`,
                entry.taken ? ' (already has an exit this way)' : '',
              ),
            ),
          ),
        ),
    el('span', { class: 'field-label' }, 'description'),
    prose.node,
    flash,
    el('div', { class: 'row' }, build, el('button', { type: 'button', onclick: cancel }, 'Cancel')),
  );
}

/** The exit a neighbour would need in order to already be joined to this cell. */
const OPPOSITE_DIR: Readonly<Record<string, string>> = {
  north: 'south',
  south: 'north',
  east: 'west',
  west: 'east',
};

/**
 * Taking a room out — A8 slice 2, and the one control in this panel that destroys something.
 *
 * **Two gestures, the same rule the PvP switch follows**, and for a stronger reason than symmetry:
 * every other write here can be undone by writing again, and this one cannot. A room removed with a
 * stray click takes its prose with it, and the prose is the part nobody can regenerate.
 *
 * **The report is the feature, not the confirmation.** What a delete leaves behind is *tolerated*
 * rather than repaired — neighbours keep pointing at nothing, and reset commands that named the room
 * are skipped in silence on every boot from now on — so this response is the only moment anybody is
 * ever told. It stays on screen after the room has gone, which is why it renders into the pane rather
 * than beside a button that is about to disappear with it.
 */
function roomRemover(room: RoomDetail, gone: (report: DeleteReport) => void): HTMLElement {
  const flash = el('p', { class: 'note' });
  const confirm = el('button', { class: 'danger' }, 'Yes, remove it');
  const cancel = el('button', { type: 'button' }, 'Cancel');
  const armed = el('div', { class: 'row' }, confirm, cancel);
  armed.hidden = true;

  const arm = el('button', { type: 'button' }, 'Remove room…');
  arm.addEventListener('click', () => {
    arm.hidden = true;
    armed.hidden = false;
    // **Slice 3's warning, and it has to be here rather than in the response.** A room the level's
    // extent rests on takes the whole Place's explored maps with it, which is a different order of
    // consequence from a dangling exit — so it is said in red, before the second gesture, not
    // reported afterwards when nothing can be done about it.
    flash.className = room.holdsExtent ? 'flash err' : 'note';
    flash.textContent = room.holdsExtent
      ? 'This cannot be undone, and this room is holding the edge of its level — removing it makes ' +
        'the grid smaller, so every explored map of this place will be reset for every character, ' +
        'online or not. Neighbours that lead here will also be left pointing at nothing.'
      : 'This cannot be undone. Neighbours that lead here will be left pointing at nothing, and any ' +
        'reset command naming this room will be skipped from now on.';
  });
  cancel.addEventListener('click', () => {
    armed.hidden = true;
    arm.hidden = false;
    flash.className = 'note';
    flash.textContent = '';
  });

  confirm.addEventListener('click', () => {
    void (async () => {
      confirm.disabled = true;
      const result = await call<DeleteReport>('DELETE', `/rooms/${room.id}`);
      if (!result.ok || !result.body) {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'refused';
        confirm.disabled = false;
        return;
      }
      gone(result.body);
    })();
  });

  return el('div', { class: 'danger-zone' }, el('span', { class: 'field-label' }, 'geometry'), arm, armed, flash);
}

/**
 * What a build that moved the grid cost — A8 slice 3.
 *
 * Two numbers, and they answer different questions. `mapsCleared` is how many *characters* lost an
 * explored map, most of whom are not here; `told` is how many were online to be given the line
 * saying so. The gap between them is the part worth seeing, because it is the people who will find
 * out by logging in later.
 */
function resizeReport(report: BuildReport): HTMLElement {
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, `Built — ${report.room.name} `, el('span', { class: 'pill' }, `#${report.room.id}`)),
    el(
      'p',
      { class: 'flash err' },
      `The level is bigger than it was, so every explored map of it has been reset: ` +
        `${report.mapsCleared ?? 0} character(s), of whom ${report.told ?? 0} were online and told. ` +
        `Nothing else about anybody is affected.`,
    ),
    el(
      'p',
      { class: 'note' },
      'Tile indices are measured from the corner of the level’s extent, and that corner moved. A ' +
        'preserved map would have been drawn in the wrong places rather than merely being short.',
    ),
  );
}

/** What the server says a delete cost. Rendered once, because nothing will ever say it again. */
function removalReport(report: DeleteReport, zoneName: string): HTMLElement {
  const kinds = Object.entries(report.resets);
  return el(
    'div',
    { class: 'card' },
    el('h3', {}, `Removed — ${report.room.name} `, el('span', { class: 'pill' }, `#${report.room.id}`)),
    el(
      'p',
      { class: 'note' },
      `It is gone from ${zoneName}, and from the overlay that survives npm run worldgen.`,
    ),
    el(
      'dl',
      { class: 'kv' },
      el('dt', {}, 'exits left dangling'),
      el(
        'dd',
        {},
        report.orphans.length === 0
          ? el('span', { class: 'muted' }, 'none')
          : report.orphans.map((o) => `${o.from} (${o.dir})`).join(', '),
      ),
      el('dt', {}, 'reset commands orphaned'),
      el(
        'dd',
        {},
        report.orphanedResets === 0
          ? el('span', { class: 'muted' }, 'none')
          : `${report.orphanedResets} — ${kinds.map(([kind, n]) => `${n} ${kind}`).join(', ')}`,
      ),
      el('dt', {}, 'cleared out of it'),
      el(
        'dd',
        {},
        report.cleared.mobs + report.cleared.corpses + report.cleared.items === 0
          ? el('span', { class: 'muted' }, 'nothing')
          : `${report.cleared.mobs} mob(s), ${report.cleared.corpses} corpse(s), ${report.cleared.items} item(s)`,
      ),
      el('dt', {}, 'explored maps reset'),
      el(
        'dd',
        {},
        report.extentChanged
          ? `${report.mapsCleared ?? 0} character(s), ${report.told ?? 0} of them online and told`
          : el('span', { class: 'muted' }, 'none — the level is the same size'),
      ),
    ),
    // Said plainly because it is the half nobody expects: the spawn files are a worldgen output, so
    // an authored delete cannot edit them. The orphaned commands come back on every rebuild and are
    // skipped on every boot, for ever, without another word.
    report.orphanedResets === 0
      ? null
      : el(
          'p',
          { class: 'note' },
          'Those reset commands are in a generated file and cannot be edited from here. They will ' +
            'come back on the next worldgen and be skipped every boot, silently. This is the only ' +
            'time you will be told.',
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

  // The model drafts into the prose box and saves nothing; the Save button below is still the only
  // thing that writes. `retest` is called on apply so a draft enables Save exactly as typing would.
  const draft = draftControl({
    roomId: room.id,
    current: () => prose.value(),
    apply: (text) => {
      prose.set(text);
      retest();
    },
  });

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
      // Provenance rides with the prose it belongs to and only then: recording "written by
      // qwen2.5:14b" against a draft that was rejected would be a lie about the world, so it is
      // attached at the moment the description is actually saved.
      const from = draft.provenance();
      if (from && patch.description !== undefined) {
        patch.by = from.by;
        patch.brief = from.brief;
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
    // Provenance, shown where it is read. "Why does this one sound different" is otherwise
    // unanswerable a month later, and with nine models installed the answer is usually the model.
    authored?.by
      ? el(
          'p',
          { class: 'note' },
          'Prose drafted by ',
          el('b', {}, authored.by),
          authored.brief ? ` from the brief “${authored.brief}”.` : '.',
        )
      : null,
    el('label', { class: 'field' }, el('span', {}, 'name'), name.node),
    draft.node,
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
