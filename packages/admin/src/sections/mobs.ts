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

import { EQUIP_SLOTS, parseColour } from '@mygame/shared';

import { call, type ZonesBody } from '../api.ts';
import { colourBox } from '../colourbox.ts';
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
  /** A4c: what this template is authored to carry, folded into the search response by the server. */
  readonly loot?: readonly { readonly vnum: number; readonly slot?: string; readonly name?: string }[];
  /** A9: which of its own fields are authored over the harvest. Absent when none are. */
  readonly edited?: readonly string[];
  /** A9b: made here rather than harvested — a different fact from *edited*, and a different mark. */
  readonly created?: boolean;
}

/** A9: the whole authorable record, which is what the field editor opens on. */
interface MobRecord {
  readonly vnum: number;
  readonly name: string;
  readonly room: string;
  readonly keywords: readonly string[];
  readonly level: number;
  readonly hp: string;
  readonly damage: string;
  readonly armourClass: number;
  readonly experience: number;
  readonly wimpyAt: number;
  readonly sprite: string;
  /** A9b. One flag rather than a whole `AggroRule` — see `MobDraft.aggressive` for why. */
  readonly aggressive: boolean;
  readonly hunts: boolean;
}

/** The server's own cap, mirrored so the panel can refuse a thirteenth piece before a round trip. */
const MAX_LOOT = 12;

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

    /**
     * A9. A template whose editor should reopen after the next repaint, and what to say when it does.
     *
     * Saving refreshes the list so the row shows its new level and its ✎ mark — and the drawer lives
     * *inside* that list, so the refresh takes the open editor and its confirmation with it. That
     * confirmation is the whole point of the save: it is the sentence that says how many of these are
     * already standing and unchanged. So the intent survives the repaint and the editor reopens against
     * freshly fetched data, which is the Items page's own answer to the same problem.
     */
    let reopen: { vnum: number; message: string } | undefined;

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
          // A4c. The editor opens **below the row it belongs to** rather than in a third column,
          // because what it edits is that row: a loot form floating elsewhere on the page would be
          // one more thing to check you had the right mob in.
          const drawer = el('div', {});
          const loot = el('button', { type: 'button' }, template.loot?.length ? `Loot — ${template.loot.length}` : 'Loot…');
          loot.addEventListener('click', () => {
            if (drawer.childElementCount > 0) {
              render(drawer);
              return;
            }
            render(drawer, lootEditor(template, () => searchTemplates()));
          });
          // A9. Its own button beside Loot rather than a tab inside one drawer, because they edit two
          // different kinds of fact through two different routes — what a mob *is* against what it
          // *carries* — and one form posting to two endpoints is a save that can half-succeed.
          const edit = el('button', { type: 'button' }, 'Edit…');
          edit.addEventListener('click', () => {
            if (drawer.childElementCount > 0) {
              render(drawer);
              return;
            }
            void (async () => {
              render(drawer, await fieldEditor(template.vnum, refill));
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
              // ✎ beside the row exactly where the Items browser puts it, and it names the fields.
              template.created ? el('span', { class: 'pill' }, '✦ made here') : null,
              template.edited?.length ? el('span', { class: 'pill' }, `✎ ${template.edited.join(', ')}`) : null,
              edit,
              loot,
              spawn,
            ),
            drawer,
          );
          if (reopen?.vnum === template.vnum) {
            const { message } = reopen;
            reopen = undefined;
            void (async () => {
              render(drawer, await fieldEditor(template.vnum, refill, message));
            })();
          }
        }
      })();
    };

    /** Repaints the template list, carrying an editor's confirmation across the repaint. */
    const refill = (message?: string, vnum?: number): void => {
      if (message !== undefined && vnum !== undefined) reopen = { vnum, message };
      searchTemplates();
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
      makeCard(() => searchTemplates()),
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
            'double the population. Edit… changes the template itself — name, room line, keywords, level, ' +
            'hit points, damage, armour class, experience, wimpy threshold and sprite — which lands on ' +
            'every one the world spawns from then on and on none of those already standing. Aggression ' +
            'is not offered: it is a rule rather than a field, and all but one of its clauses have ' +
            'nothing to evaluate until races and alignment exist.',
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

/**
 * What a mob template is authored to carry — **A4c**, owner's ask 2026-08-04: *"assign items to mobs
 * as loot."*
 *
 * ## The sentence this control exists to say
 *
 * Loot here is per **template**. A harvested kit is per reset command — an `E` attaches to the last
 * mobile the zone file loaded — so the same vnum in two rooms can already be carrying two different
 * things. What is edited here is the other kind of fact, and it is the one that surprises: it changes
 * **every** instance the world spawns from now on, and **none** of the ones already standing there.
 * The panel says both halves out loud, and the save reports how many are walking around unaffected,
 * because "I authored it and nothing changed" is otherwise the first thing anybody reports.
 *
 * ## Slot means worn, no slot means carried
 *
 * The same distinction `reset.ts` draws between an `E` and a `G`, and for the same reason: where a
 * builder put a thing is a different fact from where it *may* go. So the slot is chosen here rather
 * than read off the item — which is what lets a ring go on the left hand, a thing no wear flag can say.
 */
function lootEditor(template: TemplateRow, done: () => void): HTMLElement {
  const flash = el('p', { class: 'note' });
  const rows: { vnum: number; name: string; slot: string }[] = (template.loot ?? []).map((row) => ({
    vnum: row.vnum,
    name: row.name ?? `item ${row.vnum}`,
    slot: row.slot ?? '',
  }));

  const list = el('div', { class: 'rows' });
  const save = el('button', { class: 'primary' }, 'Save loot');

  const redraw = (): void => {
    render(list);
    if (rows.length === 0) {
      list.append(el('p', { class: 'muted' }, 'Nothing — this template carries only what its zone file gives it.'));
    }
    rows.forEach((row, index) => {
      const slot = el('select', {}, el('option', { value: '' }, 'carried')) as HTMLSelectElement;
      for (const name of EQUIP_SLOTS) {
        slot.append(el('option', { value: name, ...(row.slot === name ? { selected: true } : {}) }, name));
      }
      slot.addEventListener('change', () => {
        row.slot = slot.value;
      });
      const drop = el('button', { type: 'button', class: 'danger' }, '×');
      drop.addEventListener('click', () => {
        rows.splice(index, 1);
        redraw();
      });
      list.append(
        el('div', { class: 'row' }, el('span', { class: 'vnum' }, String(row.vnum)), coloured(row.name), slot, drop),
      );
    });
  };
  redraw();

  /* ---- adding a piece, searched the way the Items page searches ---------- */

  const term = el('input', { type: 'search', placeholder: 'find an item by name, keyword or vnum' }) as HTMLInputElement;
  const found = el('div', { class: 'rows' });
  let pending = 0;
  const search = (): void => {
    const seq = ++pending;
    const q = term.value.trim();
    if (!q) {
      render(found);
      return;
    }
    void (async () => {
      const result = await call<{ items: { vnum: number; name: string }[] }>(
        'GET',
        `/items?q=${encodeURIComponent(q)}&limit=8`,
      );
      // Out-of-order replies dropped, exactly as the template search above does.
      if (seq !== pending) return;
      render(found);
      for (const item of result.body?.items ?? []) {
        const add = el('button', { type: 'button' }, 'Add');
        add.addEventListener('click', () => {
          if (rows.length >= MAX_LOOT) {
            flash.className = 'flash err';
            flash.textContent = `At most ${MAX_LOOT} pieces.`;
            return;
          }
          rows.push({ vnum: item.vnum, name: item.name, slot: '' });
          redraw();
        });
        found.append(
          el('div', { class: 'row' }, el('span', { class: 'vnum' }, String(item.vnum)), coloured(item.name), add),
        );
      }
    })();
  };
  let debounce: ReturnType<typeof setTimeout> | undefined;
  term.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(search, 150);
  });

  save.addEventListener('click', () => {
    void (async () => {
      save.disabled = true;
      const result = await call<{ spawned: number }>('PATCH', `/mobs/${template.vnum}/loot`, {
        loot: rows.map((row) => ({ vnum: row.vnum, ...(row.slot ? { slot: row.slot } : {}) })),
      });
      save.disabled = false;
      if (!result.ok || !result.body) {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'refused';
        return;
      }
      flash.className = 'note';
      // The count is the point: it is the difference between "nothing happened" and "nothing has
      // happened yet", and Repop on the Zones page is what turns the second into the first.
      flash.textContent =
        `Saved. ${result.body.spawned} of these are already standing and keep what they have — ` +
        `repop the zone to see the new kit.`;
      done();
    })();
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', {}, 'Loot for ', coloured(template.name), ' ', el('span', { class: 'pill' }, `#${template.vnum}`)),
    el(
      'p',
      { class: 'note' },
      'Per template: every one of these the world spawns from now on carries this, on top of whatever ' +
        'its zone file already gives it. Nothing already standing in the world is changed.',
    ),
    el('span', { class: 'field-label' }, 'carrying'),
    list,
    el('span', { class: 'field-label' }, 'add a piece'),
    term,
    found,
    flash,
    el('div', { class: 'row' }, save),
  );
}

/**
 * What a mob **is** — **A9**, owner's ask 2026-08-06: *"we need to be able to edit existing mobs."*
 *
 * The Items editor's shape, deliberately: the whole record read from its own route rather than from the
 * search row, `null` to clear a field back to the harvest, and **Restore harvested** clearing exactly what
 * is authored rather than every box on the form.
 *
 * ## The two sentences this form has to say
 *
 * **Per template.** It changes every one the world spawns from now on and none of the ones already
 * standing, because a mob is built from its template at spawn and never re-reads it. The save reports how
 * many are walking around unaffected, for the reason the loot editor does: *"I saved it and nothing
 * changed"* is otherwise the first thing anybody reports, and Repop on the Zones page is what turns it into
 * *"nothing has changed yet"*.
 *
 * **These are the combat scale.** Level, hit points and damage are what Phase 14b calibrated the fight
 * against, so this form is also the fastest way to make a zone unwinnable. That is a real power and the
 * note says so where somebody can read it before they use it, rather than in a design document.
 *
 * ## Why there is no attack bonus or round length
 *
 * Both are functions of the level, re-derived by the server whenever one is authored. A box for either
 * would be a box you could type into and watch be overwritten on save.
 */
async function fieldEditor(
  vnum: number,
  done: (message?: string, forVnum?: number) => void,
  opening?: string,
): Promise<HTMLElement> {
  const opened = await call<{
    mob: MobRecord;
    authored: Record<string, unknown> | null;
    created: Record<string, unknown> | null;
    spawned: number;
  }>('GET', `/mobs/${vnum}/template`);
  if (!opened.ok || !opened.body) {
    return el('p', { class: 'flash err' }, opened.error ?? 'could not read the template');
  }
  const { mob, authored, spawned } = opened.body;
  // A9b. Whether there is a harvest under this creature decides two things the record cannot say for
  // itself: which fields may be edited, and whether the dangerous button says Restore or Delete.
  const madeHere = Boolean(opened.body.created);

  // A message carried across a repaint by `reopen` lands here, which is what makes a save's confirmation
  // outlive the list refresh that shows its result.
  const flash = el('p', { class: opening ? 'note' : 'flash' }, opening ?? '');
  const name = colourBox({ value: mob.name, placeholder: 'a kobold guard' });
  const room = colourBox({ value: mob.room, placeholder: 'A kobold guard stands here.', multiline: true, rows: 2 });
  const keywords = el('input', { type: 'text', value: mob.keywords.join(' ') }) as HTMLInputElement;
  const level = el('input', { type: 'number', min: '1', max: '60', value: String(mob.level) }) as HTMLInputElement;
  const hp = el('input', { type: 'text', value: mob.hp, placeholder: '8d8+16' }) as HTMLInputElement;
  const damage = el('input', { type: 'text', value: mob.damage, placeholder: '2d6+2' }) as HTMLInputElement;
  const armour = el('input', { type: 'number', min: '0', max: '40', value: String(mob.armourClass) }) as HTMLInputElement;
  const experience = el('input', { type: 'number', min: '0', value: String(mob.experience) }) as HTMLInputElement;
  const wimpy = el('input', { type: 'number', min: '0', value: String(mob.wimpyAt) }) as HTMLInputElement;
  const sprite = el('input', { type: 'text', value: mob.sprite }) as HTMLInputElement;

  // **Only a mob made here gets these.** On a harvested one, aggression is the source's own `ACT_*` bits
  // and the server refuses to author them — offering boxes the save would reject is worse than not
  // offering them, which is the rule the Items editor already follows for slot, type and size.
  const aggressive = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const hunts = el('input', { type: 'checkbox' }) as HTMLInputElement;
  aggressive.checked = mob.aggressive;
  hunts.checked = mob.hunts;

  const save = el('button', { class: 'primary' }, 'Save') as HTMLButtonElement;
  save.addEventListener('click', () => {
    const words = keywords.value.trim().split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      flash.className = 'flash err';
      flash.textContent = 'a mob needs at least one keyword — it is what a player types at it';
      return;
    }
    // **Only what actually changed**, measured against the record this form opened on.
    //
    // Posting every box every time works and is one line shorter, and it is wrong for two reasons that
    // only show up later. The ✎ mark on the row would name all ten fields after any edit, which makes it
    // useless as a reason to open one — the whole argument for naming them rather than counting them. And
    // it would author the other nine, so a re-harvest that improved a room line this operator never
    // touched would no longer reach the game. An overlay that records what somebody *decided* is the
    // thing that lets the harvest keep moving underneath it.
    //
    // Typing the harvest's own value back therefore does not un-author a field; **Restore harvested** is
    // the way back off, which is one button rather than a rule about equality nobody can see.
    const patch: Record<string, unknown> = {};
    const changed = <T>(key: string, now: T, before: T): void => {
      if (JSON.stringify(now) !== JSON.stringify(before)) patch[key] = now;
    };
    changed('name', name.value(), mob.name);
    changed('room', room.value(), mob.room);
    changed('keywords', words, [...mob.keywords]);
    changed('level', Number(level.value), mob.level);
    changed('hp', hp.value.trim(), mob.hp);
    changed('damage', damage.value.trim(), mob.damage);
    changed('armourClass', Number(armour.value), mob.armourClass);
    changed('experience', Number(experience.value), mob.experience);
    changed('wimpyAt', Number(wimpy.value), mob.wimpyAt);
    changed('sprite', sprite.value.trim(), mob.sprite);
    if (madeHere) {
      changed('aggressive', aggressive.checked, mob.aggressive);
      changed('hunts', hunts.checked, mob.hunts);
    }
    if (Object.keys(patch).length === 0) {
      // Said here rather than sent, because the server refuses an empty patch and *"nothing to change"*
      // as an error reads like a failure when it is the honest description of pressing Save twice.
      flash.className = 'note';
      flash.textContent = 'Nothing changed.';
      return;
    }

    void (async () => {
      save.disabled = true;
      const result = await call<{ spawned: number }>('PATCH', `/mobs/${vnum}/template`, patch);
      save.disabled = false;
      if (!result.ok || !result.body) {
        flash.className = 'flash err';
        flash.textContent = result.error ?? 'refused';
        return;
      }
      done(
        `Saved. ${result.body.spawned} of these are already standing and are unchanged — ` +
          `repop the zone to meet the new one.`,
        vnum,
      );
    })();
  });

  const authoredKeys = Object.keys(authored ?? {}).filter((k) => k !== 'at' && k !== 'by' && k !== 'loot');

  /**
   * A9b. **Delete where a harvested mob offers Restore**, because *Restore harvested* on a created one
   * would be a button with nothing behind it to restore to — the honest control is the one that unmakes
   * the record. The server refuses to delete a harvested vnum for the mirror reason: the next worldgen
   * would put it straight back, so a delete that appeared to work would be a lie with a restart's fuse
   * on it.
   */
  const destroy = el('button', { class: 'danger' }, 'Delete') as HTMLButtonElement;
  destroy.addEventListener('click', () => {
    void (async () => {
      const gone = await call<{ standing: number }>('DELETE', `/mobs/${vnum}/template`);
      if (!gone.ok) {
        flash.className = 'flash err';
        flash.textContent = gone.error ?? 'refused';
        return;
      }
      // The count matters here for the opposite reason it does on a save: what is standing *outlives* the
      // record, because those are ordinary actors in ordinary fights.
      done(
        `Unmade. ${gone.body?.standing ?? 0} already standing will live out their lives; nothing new spawns.`,
        undefined,
      );
    })();
  });

  const revert = el('button', { class: 'danger' }, 'Restore harvested') as HTMLButtonElement;
  revert.addEventListener('click', () => {
    if (authoredKeys.length === 0) {
      flash.className = 'flash';
      flash.textContent = 'nothing is authored on this mob';
      return;
    }
    void (async () => {
      // Clears exactly what is authored and **leaves the loot alone** — it is a separate route with a
      // separate button, and a Restore that quietly emptied a kit would be the worst kind of surprise.
      const cleared = await call<{ ok: boolean }>(
        'PATCH',
        `/mobs/${vnum}/template`,
        Object.fromEntries(authoredKeys.map((k) => [k, null])),
      );
      if (!cleared.ok) {
        flash.className = 'flash err';
        flash.textContent = cleared.error ?? 'refused';
        return;
      }
      done('Harvest restored. The loot is a separate button and is untouched.', vnum);
    })();
  });

  return el(
    'div',
    { class: 'card item-editor' },
    el('h3', {}, 'Edit ', coloured(mob.name), ' ', el('span', { class: 'pill' }, `#${vnum}`)),
    el('div', { class: 'row' }, el('label', {}, 'name'), name.node),
    el('div', { class: 'row' }, el('label', {}, 'room line'), room.node),
    el('div', { class: 'row' }, el('label', {}, 'keywords'), keywords),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'level'), level,
      el('label', {}, 'hp'), hp,
      el('label', {}, 'damage'), damage,
      el('label', {}, 'AC'), armour,
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'experience'), experience,
      el('label', {}, 'flees below'), wimpy,
      el('span', { class: 'muted' }, 'hp (0 never runs)'),
      el('label', {}, 'sprite'), sprite,
    ),
    // Only a created mob can say what it objects to; a harvested one's aggression is the source's bits.
    ...(madeHere
      ? [
          el(
            'div',
            { class: 'row' },
            el('label', {}, 'attacks on sight'), aggressive,
            el('label', {}, 'follows you'), hunts,
            el('span', { class: 'muted' }, 'a hunter always remembers — one without memory is inert'),
          ),
        ]
      : []),
    el('div', { class: 'row' }, save, madeHere ? destroy : revert, flash),
    el(
      'p',
      { class: 'note' },
      `Per template: this changes every one the world spawns from now on, and none of the ${spawned} ` +
        'already standing. Level, hit points and damage are what the whole combat scale is calibrated ' +
        'against — this is also the fastest way to make a zone unwinnable.',
    ),
    el(
      'p',
      { class: 'note' },
      madeHere
        ? `made here — no harvest under it${typeof opened.body.created?.at === 'string' ? ` (${String(opened.body.created.at).slice(0, 10)})` : ''}`
        : authoredKeys.length > 0
        ? `authored: ${authoredKeys.join(', ')}${typeof authored?.at === 'string' ? ` (${authored.at.slice(0, 10)})` : ''}`
        : 'nothing authored — every field is the harvest\u2019s',
    ),
  );
}

/**
 * **A9b** — a creature with no `.mob` record behind it. Owner's ask, 2026-08-06: *"create new mobs."*
 *
 * The smallest form that can produce a *whole* template, because that is what a created mob is: there is
 * no harvest underneath to supply the fields nobody filled in. Everything with a sensible default has one
 * (a room line in the source's idiom, a human sprite, no experience, never flees) and everything that
 * cannot be guessed is required — a creature with no keywords is one no player can type at.
 *
 * **The number is not asked for.** A vnum is the join key between the template map, every reset and every
 * instance limit, so it is the server's to allocate from a reserved base and never a form's to choose.
 *
 * Once made it is an ordinary template: it can be searched, edited, given loot and spawned by the button
 * three rows up. What it cannot yet do is **repop** — a zone's population is a worldgen output, so
 * placing one permanently needs its own overlay, and the note under the form says so rather than leaving
 * it to be discovered when the server restarts.
 */
function makeCard(done: () => void): HTMLElement {
  const flash = el('p', { class: 'flash' });
  const name = colourBox({ value: '', placeholder: 'a bone hound' });
  const keywords = el('input', { type: 'text', placeholder: 'bone hound' }) as HTMLInputElement;
  const level = el('input', { type: 'number', min: '1', max: '60', value: '1' }) as HTMLInputElement;
  const hp = el('input', { type: 'text', placeholder: '8d8+16' }) as HTMLInputElement;
  const damage = el('input', { type: 'text', placeholder: '2d6+2' }) as HTMLInputElement;
  const armour = el('input', { type: 'number', min: '0', max: '40', value: '10' }) as HTMLInputElement;
  const experience = el('input', { type: 'number', min: '0', value: '0' }) as HTMLInputElement;
  const aggressive = el('input', { type: 'checkbox' }) as HTMLInputElement;

  const make = el('button', { class: 'primary' }, 'Make it') as HTMLButtonElement;
  make.addEventListener('click', () => {
    const words = keywords.value.trim().split(/\s+/).filter((w) => w.length > 0);
    void (async () => {
      make.disabled = true;
      const created = await call<{ vnum: number }>('POST', '/mobs/template', {
        name: name.value(),
        keywords: words,
        level: Number(level.value),
        hp: hp.value.trim(),
        damage: damage.value.trim(),
        armourClass: Number(armour.value),
        experience: Number(experience.value),
        aggressive: aggressive.checked,
      });
      make.disabled = false;
      if (!created.ok || !created.body) {
        // The server's own sentence, which names the field — "refused" would leave somebody guessing
        // which of eight boxes it meant.
        flash.className = 'flash err';
        flash.textContent = created.error ?? 'refused';
        return;
      }
      flash.className = 'note';
      flash.textContent = `Made #${created.body.vnum}. Search for it above to edit it, give it loot or spawn one.`;
      name.set('');
      keywords.value = '';
      done();
    })();
  });

  return el(
    'div',
    { class: 'card item-editor' },
    el('h3', {}, 'Make one'),
    el('div', { class: 'row' }, el('label', {}, 'name'), name.node),
    el('div', { class: 'row' }, el('label', {}, 'keywords'), keywords),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'level'), level,
      el('label', {}, 'hp'), hp,
      el('label', {}, 'damage'), damage,
      el('label', {}, 'AC'), armour,
    ),
    el(
      'div',
      { class: 'row' },
      el('label', {}, 'experience'), experience,
      el('label', {}, 'attacks on sight'), aggressive,
    ),
    el('div', { class: 'row' }, make, flash),
    el(
      'p',
      { class: 'note' },
      'It gets its number from nine million up, where no Duris mob reaches, so npm run worldgen can be ' +
        're-run for ever without a made creature and a harvested one contending for the same key. From ' +
        'then on it is an ordinary template — searchable, editable, lootable, spawnable. It will not ' +
        'repop yet: a zone\u2019s population is a worldgen output, so placing one permanently is the next ' +
        'piece of work.',
    ),
  );
}
