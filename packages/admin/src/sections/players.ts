/**
 * The player editor — the panel's first built section, and the pattern the rest copy.
 *
 * Two halves per character, labelled with where each fact lives: the **live** simulation state
 * while they are connected, and the **on-disk** record either way. Which controls appear follows
 * the API's own refusal rules rather than papering over them — an offline character offers wound
 * editing and deletion, a live one offers pools, level and teleport, and nothing offers an edit
 * the server would discard. See `DESIGN-admin-panel.md` §6.
 */

import {
  call,
  type PlayerDetail,
  type RoomsBody,
  type RosterBody,
  type StatusBody,
} from '../api.ts';
import { ago, duration, el, render } from '../dom.ts';

let timer: number | undefined;
let picked: string | undefined;

/** The light catalogue and room list, fetched once per mount — they change on restart, not mid-session. */
let lights: StatusBody['lights'] = [];
let rooms: RoomsBody['rooms'] = [];

export const playersSection = {
  slug: 'players',
  title: 'Players',
  mount(root: HTMLElement): void {
    const rosterPane = el('div', {});
    const detailPane = el('div', {});
    render(
      root,
      el('h2', {}, 'Players'),
      el(
        'p',
        { class: 'note' },
        'Everyone the game knows: connected characters from the live simulation, the rest from data/players/. Pick one to edit.',
      ),
      el('div', { class: 'columns' }, rosterPane, detailPane),
    );

    /**
     * The detail pane refreshes on pick, after every action, and by its own button — never on the
     * poll. A form that re-renders under the operator's caret eats what they were typing, and a
     * regenerating pool changes the payload every few seconds, so "only when changed" would not
     * save it.
     */
    const refreshDetail = async (): Promise<void> => {
      if (!picked) {
        render(detailPane);
        return;
      }
      const result = await call<PlayerDetail>('GET', `/players/${picked}`);
      if (!result.ok || !result.body) {
        render(detailPane, el('div', { class: 'card' }, el('p', { class: 'flash err' }, result.error ?? 'gone')));
        return;
      }
      renderDetail(detailPane, result.body, refreshDetail, async () => {
        await Promise.all([refreshRoster(), refreshDetail()]);
      });
    };

    /**
     * The roster *is* polled — but re-rendered only when its facts changed, because a wholesale
     * replace moves the rows under a click in flight. The JSON string is the cheapest possible
     * "did anything change" at this size.
     */
    let lastRoster = '';
    const refreshRoster = async (): Promise<void> => {
      const result = await call<RosterBody>('GET', '/players');
      if (!result.ok || !result.body) {
        lastRoster = '';
        render(rosterPane, el('p', { class: 'flash err' }, result.error ?? 'unreachable'));
        return;
      }
      const fingerprint = JSON.stringify(result.body) + `|${picked ?? ''}`;
      if (fingerprint === lastRoster) return;
      lastRoster = fingerprint;
      renderRoster(rosterPane, result.body, (slug) => {
        picked = slug;
        lastRoster = '';
        void Promise.all([refreshRoster(), refreshDetail()]);
      });
    };

    void (async () => {
      const status = await call<StatusBody>('GET', '/status');
      if (status.ok && status.body) lights = status.body.lights;
      const roomList = await call<RoomsBody>('GET', '/rooms');
      if (roomList.ok && roomList.body) rooms = roomList.body.rooms;
      await Promise.all([refreshRoster(), refreshDetail()]);
    })();
    timer = window.setInterval(() => void refreshRoster(), 5000);
  },
  unmount(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  },
};

/* -------------------------------------------------------------------------- */
/* Roster                                                                      */
/* -------------------------------------------------------------------------- */

function renderRoster(pane: HTMLElement, roster: RosterBody, pick: (slug: string) => void): void {
  const row = (
    slug: string,
    name: string,
    online: boolean,
    where: string,
    detail: string,
  ): HTMLElement =>
    el(
      'tr',
      { class: `pick${picked === slug ? ' picked' : ''}`, onclick: () => pick(slug) },
      el('td', {}, el('span', { class: `dot ${online ? 'on' : 'off'}` })),
      el('td', {}, name),
      el('td', {}, where),
      el('td', { class: 'muted' }, detail),
    );

  render(
    pane,
    el(
      'div',
      { class: 'card' },
      el('h3', {}, `Online — ${roster.online.length}`),
      roster.online.length === 0
        ? el('p', { class: 'note' }, 'Nobody is connected.')
        : el(
            'table',
            {},
            el('tbody', {},
              ...roster.online.map((player) =>
                row(
                  player.slug,
                  player.name,
                  true,
                  player.room ? `${player.room.name}` : '?',
                  `L${player.level} · ${player.hp}/${player.maxHp} hp${player.fighting !== null ? ' · fighting' : ''}`,
                ),
              ),
            ),
          ),
      el('h3', {}, `On disk — ${roster.stored.length}`),
      roster.stored.length === 0
        ? el('p', { class: 'note' }, 'No character files beyond the connected.')
        : el(
            'table',
            {},
            el('tbody', {},
              ...roster.stored.map((summary) =>
                row(
                  summary.slug,
                  summary.name,
                  false,
                  summary.savedAt ? `saved ${ago(summary.savedAt)}` : 'never saved',
                  `${summary.level !== undefined ? `L${summary.level} · ` : ''}` +
                    `${summary.seenTiles} tiles seen · ${summary.takenCount} pickups` +
                    (summary.wound ? ` · wounded` : ''),
                ),
              ),
            ),
          ),
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Detail                                                                      */
/* -------------------------------------------------------------------------- */

function renderDetail(
  pane: HTMLElement,
  detail: PlayerDetail,
  refresh: () => Promise<void>,
  changed: () => Promise<void>,
): void {
  const flash = el('p', { class: 'flash' });

  const report = (result: { ok: boolean; error: string | undefined }, did: string): void => {
    flash.className = result.ok ? 'flash ok' : 'flash err';
    flash.textContent = result.ok ? did : (result.error ?? 'failed');
  };

  /** PATCHes the character and re-renders from the response the server already sent back. */
  const patch = async (body: Record<string, unknown>, did: string): Promise<void> => {
    const result = await call<PlayerDetail>('PATCH', `/players/${detail.slug}`, body);
    report(result, did);
    if (result.ok) await changed();
  };
  const verb = async (action: string, body: unknown, did: string): Promise<void> => {
    const result = await call('POST', `/players/${detail.slug}/${action}`, body);
    report(result, did);
    if (result.ok) await changed();
  };
  const remove = async (): Promise<void> => {
    const result = await call('DELETE', `/players/${detail.slug}`);
    report(result, 'deleted');
    if (result.ok) {
      picked = undefined;
      await changed();
    }
  };

  const blocks: HTMLElement[] = [];

  blocks.push(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el(
          'h3',
          {},
          `${detail.name} `,
          el('span', { class: `pill ${detail.online ? 'live' : 'disk'}` }, detail.online ? 'online — live state' : 'offline — on disk'),
        ),
        el('span', { class: 'spacer' }),
        el('button', { onclick: () => void refresh(), title: 'The pane never refreshes itself — it would eat what you were typing.' }, 'Refresh'),
      ),
      flash,
    ),
  );

  if (detail.online && detail.live) blocks.push(liveBlock(detail.live, patch, verb));
  blocks.push(recordBlock(detail, patch, verb, remove));

  render(pane, ...blocks);
}

/* ------------------------------------------------------------- live editing */

function liveBlock(
  live: NonNullable<PlayerDetail['live']>,
  patch: (body: Record<string, unknown>, did: string) => Promise<void>,
  verb: (action: string, body: unknown, did: string) => Promise<void>,
): HTMLElement {
  const hp = el('input', { type: 'number', value: String(live.hp), min: '1', max: String(live.maxHp) });
  const mana = el('input', { type: 'number', value: String(live.mana), min: '0', max: String(live.maxMana) });
  const move = el('input', { type: 'number', value: String(live.move), min: '0', max: String(live.maxMove) });
  const level = el('input', { type: 'number', value: String(live.level), min: '1', max: '60' });

  const lightPick = el('select', {});
  for (const source of lights) {
    lightPick.append(el('option', { value: source.id }, `${source.name} (r${source.radius})`));
  }
  if (live.light) lightPick.value = live.light.id;

  const roomInput = el('input', { type: 'number', list: 'room-list', value: live.room ? String(live.room.id) : '' });
  const roomList = el('datalist', { id: 'room-list' });
  for (const room of rooms) {
    roomList.append(el('option', { value: String(room.id) }, `${room.name} — z${room.zone} L${room.level}`));
  }

  const tellInput = el('input', { type: 'text', size: '32', maxlength: '300', placeholder: 'a line only they will see' });

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Live'),
    el(
      'dl',
      { class: 'kv' },
      el('dt', {}, 'where'),
      el('dd', {}, live.room ? `${live.room.name} (room ${live.room.id}, place ${live.place})` : '?'),
      el('dt', {}, 'stance'),
      el('dd', {}, `${live.posture} · ${live.status}${live.fighting !== null ? ` · fighting #${live.fighting}` : ''}`),
      el('dt', {}, 'experience'),
      el('dd', {}, String(live.experience)),
      el('dt', {}, 'light'),
      el('dd', {}, live.light ? `${live.light.name} (radius ${live.light.radius})` : 'none — the bare radius'),
    ),

    el(
      'div',
      { class: 'row' },
      el('label', {}, 'hp'), hp, el('span', { class: 'muted' }, `/ ${live.maxHp}`),
      el('label', {}, 'mana'), mana, el('span', { class: 'muted' }, `/ ${live.maxMana}`),
      el('label', {}, 'move'), move, el('span', { class: 'muted' }, `/ ${live.maxMove}`),
      el('button', { onclick: () => void patch({ hp: Number(hp.value), mana: Number(mana.value), move: Number(move.value) }, 'pools set') }, 'Apply'),
      el('button', { onclick: () => void patch({ healed: true }, 'healed to full') }, 'Heal'),
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'level'), level,
      el('button', { onclick: () => void patch({ level: Number(level.value) }, `level set — saved to the character file`) }, 'Set'),
      el('span', { class: 'rig' }, 'the level persists; the numbers it derives are the dev profile’s until Phase 14b'),
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'light'), lightPick,
      el('button', { onclick: () => void patch({ light: lightPick.value }, 'light granted') }, 'Grant'),
      el('button', { onclick: () => void patch({ light: null }, 'light extinguished') }, 'Extinguish'),
      el('button', { onclick: () => void patch({ clearAffects: true }, 'affects cleared') }, 'Clear affects'),
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'teleport'), roomInput, roomList,
      el('button', { onclick: () => void verb('teleport', { room: Number(roomInput.value) }, 'teleported') }, 'Go'),
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'tell'), tellInput,
      el(
        'button',
        {
          onclick: () => {
            const text = tellInput.value.trim();
            if (!text) return;
            void verb('tell', { text }, 'sent').then(() => {
              tellInput.value = '';
            });
          },
        },
        'Send',
      ),
      el(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (window.confirm(`Disconnect ${live.name}?`)) void verb('kick', undefined, 'kicked');
          },
        },
        'Kick',
      ),
    ),
    affectTable('Affects (live)', live.affects),
  );
}

/* ------------------------------------------------------------- record block */

function recordBlock(
  detail: PlayerDetail,
  patch: (body: Record<string, unknown>, did: string) => Promise<void>,
  verb: (action: string, body: unknown, did: string) => Promise<void>,
  remove: () => Promise<void>,
): HTMLElement {
  const record = detail.record;
  const offline = !detail.online;

  const rows: (HTMLElement | null)[] = [
    el('h3', {}, 'On disk'),
    el(
      'dl',
      { class: 'kv' },
      el('dt', {}, 'saved'),
      el('dd', {}, record.savedAt ? `${ago(record.savedAt)}` : 'never'),
      el('dt', {}, 'last room'),
      el('dd', {}, record.lastRoom ? `${record.lastRoom.name} (${record.lastRoom.id}) — login returns them here` : '—'),
      el('dt', {}, 'level'),
      el(
        'dd',
        {},
        record.level !== null
          ? `${record.level} · ${record.experience ?? 0} experience`
          : 'never set — logs in as a fresh level 1',
      ),
      el('dt', {}, 'seen'),
      el('dd', {}, `${record.seenTiles} tiles across ${record.seenPlaces} place${record.seenPlaces === 1 ? '' : 's'}`),
      el('dt', {}, 'pickups'),
      el('dd', {}, `${record.takenCount} collected`),
      el('dt', {}, 'wound'),
      el(
        'dd',
        {},
        record.wound ? `${record.wound.hp} hp · ${record.wound.mana} mana · ${record.wound.move} move below full` : 'unhurt',
      ),
    ),
  ];

  if (offline) {
    const woundHp = el('input', { type: 'number', value: String(record.wound?.hp ?? 0), min: '0' });
    const woundMana = el('input', { type: 'number', value: String(record.wound?.mana ?? 0), min: '0' });
    const woundMove = el('input', { type: 'number', value: String(record.wound?.move ?? 0), min: '0' });
    const levelInput = el('input', { type: 'number', value: String(record.level ?? 1), min: '1', max: '60' });
    const moveRoom = el('input', { type: 'number', list: 'room-list-offline', value: record.lastRoom ? String(record.lastRoom.id) : '' });
    const moveRoomList = el('datalist', { id: 'room-list-offline' });
    for (const room of rooms) {
      moveRoomList.append(el('option', { value: String(room.id) }, `${room.name} — z${room.zone} L${room.level}`));
    }
    const lightPick = el('select', {});
    for (const source of lights) {
      lightPick.append(el('option', { value: source.id }, `${source.name} (r${source.radius})`));
    }
    rows.push(
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'level'), levelInput,
        el('button', { onclick: () => void patch({ level: Number(levelInput.value) }, 'level saved to the file') }, 'Set'),
        el('span', { class: 'rig' }, 'permanent — login derives their numbers from it'),
      ),
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'move to'), moveRoom, moveRoomList,
        el('button', { onclick: () => void verb('teleport', { room: Number(moveRoom.value) }, 'moved — takes effect at login') }, 'Go'),
      ),
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'wound: hp'), woundHp,
        el('label', {}, 'mana'), woundMana,
        el('label', {}, 'move'), woundMove,
        el(
          'button',
          {
            onclick: () =>
              void patch(
                { wound: { hp: Number(woundHp.value), mana: Number(woundMana.value), move: Number(woundMove.value) } },
                'wound set',
              ),
          },
          'Apply',
        ),
        el('button', { onclick: () => void patch({ healed: true }, 'wound cleared') }, 'Heal'),
        el('span', { class: 'muted' }, 'the deficit below maxima derived at login — the file never stores the value'),
      ),
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'light'), lightPick,
        el('button', { onclick: () => void patch({ light: lightPick.value }, 'light written to the save') }, 'Grant'),
        el('button', { onclick: () => void patch({ light: null }, 'light removed from the save') }, 'Extinguish'),
        el('button', { onclick: () => void patch({ clearAffects: true }, 'stored affects cleared') }, 'Clear affects'),
      ),
    );
  }

  rows.push(
    el(
      'div',
      { class: 'row' },
      el(
        'button',
        {
          onclick: () => {
            if (window.confirm(`Forget every pickup ${detail.name} has collected? Each room offers its find again.`)) {
              void verb('reset-pickups', undefined, 'pickups reset');
            }
          },
        },
        'Reset pickups',
      ),
      offline
        ? el(
            'button',
            {
              class: 'danger',
              onclick: () => {
                if (window.confirm(`Delete ${detail.name}'s save file? Their map, pickups and affects are gone for good.`)) {
                  void remove();
                }
              },
            },
            'Delete character',
          )
        : el('span', { class: 'muted' }, 'delete: kick them first — a live session writes the file back'),
    ),
    affectTable('Affects (stored)', record.affects),
  );

  return el('div', { class: 'card' }, ...rows.filter((r): r is HTMLElement => r !== null));
}

function affectTable(title: string, affects: { type: string; apply: string; modifier: number; durationMs: number | null; context: string | null }[]): HTMLElement {
  if (affects.length === 0) return el('p', { class: 'note' }, `${title}: none.`);
  return el(
    'div',
    {},
    el('h3', {}, title),
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, 'type'), el('th', {}, 'apply'), el('th', { class: 'num' }, 'modifier'), el('th', {}, 'remaining'), el('th', {}, 'context'))),
      el(
        'tbody',
        {},
        ...affects.map((affect) =>
          el(
            'tr',
            {},
            el('td', {}, affect.type),
            el('td', {}, affect.apply),
            el('td', { class: 'num' }, String(affect.modifier)),
            el('td', {}, affect.durationMs === null ? 'permanent' : duration(affect.durationMs)),
            el('td', {}, affect.context ?? '—'),
          ),
        ),
      ),
    ),
  );
}
