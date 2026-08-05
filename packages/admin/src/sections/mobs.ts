/**
 * Mobs — what is standing in the world right now, and putting more of it there. A4.
 *
 * ## Instances, not templates
 *
 * This is the distinction the whole section rests on, and it is why the Zones browser could not just
 * grow a column. Zones answers *what a zone is authored to contain* — a static fact, read from the
 * harvested population file. This answers *what is standing in it this second*: three kobold guards
 * of one vnum, two of them wounded, one of them chasing somebody across the courtyard.
 *
 * So every row carries an **entity id**, and that is not decoration. A keyword cannot express "this
 * one" — `kill patrol` is ambiguous by construction — which is the argument protocol 11 already made
 * for clicking a body in the game. Slay takes the id for the same reason.
 *
 * ## Two lists, deliberately not merged
 *
 * The **live** list is per zone and changes under you. The **template** list is the catalogue, is the
 * same 1,000-odd rows for ever, and is what a spawn is chosen from. Merging them would mean one table
 * whose rows meant two different things depending on a column, and an operator could not tell whether
 * slaying a row killed one guard or unmade the idea of guards.
 *
 * ## Names are painted, never inserted
 *
 * A mob's name is authored text out of a third-party world file and carries the builder's own `&+y`
 * codes — the same rule the Items panel learned the hard way. Through `parseColour` into spans, never
 * `innerHTML`.
 */

import { parseColour } from '@mygame/shared';

import { call, type ZonesBody } from '../api.ts';
import { el, render } from '../dom.ts';

interface MobRow {
  readonly id: number;
  readonly vnum: number;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly room: number;
  readonly roomName: string;
  readonly status: string;
  readonly fighting?: number;
}

interface TemplateRow {
  readonly vnum: number;
  readonly name: string;
  readonly level: number;
  readonly keywords: readonly string[];
}

/** Paints authored text as spans. Never markup — see the note at the top of this file. */
function coloured(text: string): HTMLElement {
  const holder = el('span', {});
  for (const span of parseColour(text)) {
    const node = el('span', {}, span.text);
    if (span.colour !== undefined) node.style.color = span.colour;
    holder.append(node);
  }
  return holder;
}

export const mobsSection = {
  slug: 'mobs',
  title: 'Mobs',
  mount(root: HTMLElement): void {
    const zonePicker = el('select', {}) as HTMLSelectElement;
    const liveCount = el('p', { class: 'note' }, 'pick a zone');
    const liveList = el('div', { class: 'rows' });
    const flash = el('p', { class: 'flash' });

    /* ---- the live half ---------------------------------------------------- */

    const loadLive = (): void => {
      const zone = Number(zonePicker.value);
      if (!Number.isInteger(zone)) return;
      void (async () => {
        const result = await call<{ total: number; mobs: MobRow[] }>('GET', `/zones/${zone}/mobs`);
        render(liveList);
        if (!result.ok || !result.body) {
          liveCount.textContent = result.error ?? 'could not read the zone';
          return;
        }
        const { mobs, total } = result.body;
        liveCount.textContent = total === 0
          ? 'nothing alive in this zone — it may not have repopped yet'
          : `${total} standing`;

        let lastRoom = -1;
        for (const mob of mobs) {
          // A room heading whenever it changes, rather than a room column repeated down every row:
          // the list is sorted by room precisely so a patrol reads as a group, and a heading is what
          // makes that visible instead of merely true.
          if (mob.room !== lastRoom) {
            lastRoom = mob.room;
            liveList.append(el('div', { class: 'row group' }, el('span', { class: 'muted' }, `${mob.roomName} (${mob.room})`)));
          }
          const slay = el('button', { type: 'button', class: 'danger' }, 'Slay') as HTMLButtonElement;
          slay.addEventListener('click', () => {
            void (async () => {
              const done = await call<{ name: string }>('DELETE', `/mobs/${mob.id}`);
              // The server's own sentence on failure — most often "no live mob with entity id N",
              // which means somebody else killed it and this list is a few seconds stale.
              flash.textContent = done.ok ? `slain: ${done.body?.name ?? mob.name}` : done.error ?? 'refused';
              loadLive();
            })();
          });
          liveList.append(
            el(
              'div',
              { class: 'row' },
              // The entity id first and in the vnum's column, because it is the thing that says
              // *which* — the vnum only says what kind, and a room of twins shares it.
              el('span', { class: 'vnum' }, `#${mob.id}`),
              coloured(mob.name),
              el('span', { class: 'note' }, `level ${mob.level} · ${mob.hp}/${mob.maxHp} hp · ${mob.status}`),
              // Only when it is in a fight, and it names the id rather than the body: that is what a
              // second row in this list can be matched against.
              mob.fighting === undefined ? null : el('span', { class: 'pill' }, `fighting #${mob.fighting}`),
              el('span', { class: 'muted' }, `vnum ${mob.vnum}`),
              slay,
            ),
          );
        }
      })();
    };

    zonePicker.addEventListener('change', loadLive);

    const refresh = el('button', { type: 'button' }, 'Refresh') as HTMLButtonElement;
    refresh.addEventListener('click', loadLive);

    /* ---- the spawn half --------------------------------------------------- */

    const term = el('input', { type: 'search', placeholder: 'name, keyword or vnum' }) as HTMLInputElement;
    const room = el('input', { type: 'number', placeholder: 'room id' }) as HTMLInputElement;
    const templateCount = el('p', { class: 'note' }, 'searching…');
    const templateList = el('div', { class: 'rows' });

    let pending = 0;
    const searchTemplates = (): void => {
      const seq = ++pending;
      const params = new URLSearchParams();
      if (term.value.trim()) params.set('q', term.value.trim());
      void (async () => {
        const result = await call<{ total: number; catalogue: number; mobs: TemplateRow[] }>('GET', `/mobs?${params.toString()}`);
        // Out-of-order replies dropped rather than painted, exactly as the item search does: typing
        // fires one per keystroke and a slow early one landing last reads as the search being wrong.
        if (seq !== pending) return;
        render(templateList);
        if (!result.ok || !result.body) {
          templateCount.textContent = result.error ?? 'could not read the templates';
          return;
        }
        const { mobs, total, catalogue } = result.body;
        templateCount.textContent = total === mobs.length
          ? `${total} of ${catalogue} templates`
          : `showing ${mobs.length} of ${total} matches — narrow the search to see the rest`;

        for (const template of mobs) {
          const spawn = el('button', { type: 'button' }, 'Spawn here') as HTMLButtonElement;
          spawn.addEventListener('click', () => {
            const into = Number(room.value);
            if (!Number.isInteger(into)) {
              // Asked for rather than guessed. Defaulting to the zone's entry room would put a
              // dragon somewhere nobody was looking, and the operator would not know where.
              flash.textContent = 'type a room id first — a spawn needs somewhere to stand';
              return;
            }
            void (async () => {
              const made = await call<{ id: number; name: string }>('POST', '/mobs', { vnum: template.vnum, room: into });
              flash.textContent = made.ok && made.body
                ? `spawned #${made.body.id} in room ${into}`
                : made.error ?? 'refused';
              loadLive();
            })();
          });
          templateList.append(
            el(
              'div',
              { class: 'row' },
              el('span', { class: 'vnum' }, String(template.vnum)),
              coloured(template.name),
              el('span', { class: 'note' }, `level ${template.level}`),
              el('span', { class: 'muted' }, template.keywords.join(' ')),
              spawn,
            ),
          );
        }
      })();
    };

    let debounce: ReturnType<typeof setTimeout> | undefined;
    term.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(searchTemplates, 150);
    });

    render(
      root,
      el('h2', {}, 'Mobs'),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Standing right now'),
        el('div', { class: 'controls' }, zonePicker, refresh, flash),
        liveCount,
        liveList,
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'Spawn one'),
        el('div', { class: 'controls' }, term, el('label', {}, 'into room'), room),
        templateCount,
        templateList,
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'What this does and does not do'),
        el(
          'p',
          { class: 'note' },
          'Slay runs the game’s own death path, so the body leaves a corpse holding what it carried ' +
            'and the room is told — an admin kill that made a mob vanish would exercise a path the ' +
            'game does not have. Nobody is paid experience or coin, because nobody hurt it. Spawn ' +
            'rolls hit points and a tile from the same seeded stream every other mob uses, so the ' +
            'world stays reproducible. Repop lives on the Zones page and is additive: nothing ' +
            'despawns, and the per-vnum world-wide limits still hold, so pressing it twice does not ' +
            'double the population. Editing a template — name, level, combat numbers, aggression — ' +
            'is A4c and needs a mob overlay first, the same shape items-authored.json gave items.',
        ),
      ),
    );

    // The zone list comes from the same endpoint the Zones page uses; the picker is populated from
    // whatever this server actually loaded rather than from a list typed here.
    void (async () => {
      const zones = await call<ZonesBody>('GET', '/zones');
      if (!zones.ok || !zones.body) {
        liveCount.textContent = zones.error ?? 'could not read the zone list';
        return;
      }
      // Populated zones first and selected by default: a zone with no population has nothing to show
      // here, and opening on one would make the section look broken.
      const rows = [...zones.body.zones].sort((a, b) => Number(b.populated) - Number(a.populated) || a.id - b.id);
      for (const zone of rows) {
        zonePicker.append(el('option', { value: String(zone.id) }, `${zone.id} — ${zone.name}${zone.populated ? '' : ' (no population)'}`));
      }
      if (rows.length > 0) {
        zonePicker.value = String(rows[0]!.id);
        loadLive();
      }
    })();

    searchTemplates();
  },
};
