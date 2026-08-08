/**
 * Quests — A7q, the tab that was a stub until the mechanism underneath it existed.
 *
 * Phase 21 slice 7 built one quest and said the shape was one *"the admin panel can grow an editor
 * for"*. This is that editor, in A6/A9's authoring pattern: a list, an editor that opens under the
 * row you clicked, a create form that posts a whole draft, and a two-click delete.
 *
 * ## Three things this section says out loud that the others do not have to
 *
 * 1. **The id is the key, and it cannot be edited.** A character's progress is filed under the quest
 *    id in their save file, so renaming a quest does not move anybody's progress — it strands it. The
 *    server refuses an id change with that sentence; the form simply does not offer the box after
 *    creation, and the note under the list explains why a rename is a delete and a create.
 * 2. **A giver is a mob vnum, and a number is not something to check work against.** Every vnum field
 *    carries a live name hint beside it — *"1401 · Gwark"* — resolved against the same `/mobs` and
 *    `/items` searches the other sections use. A typo shows as *"no mob 1410"* while you are still
 *    typing rather than as a refusal after you save.
 * 3. **A write lands on the running world.** The server re-seeds the `?` badge and the untouchable
 *    registry from the rows on every write, and answers with how many standing bodies it re-sent. The
 *    flash says so, because *"saved — and nothing appeared to happen"* is the bug report this avoids.
 */

import { parseColour } from '@mygame/shared';

import { call, type QuestObjective, type QuestRow, type QuestWriteBody, type QuestsBody } from '../api.ts';
import { el, render } from '../dom.ts';

/** Paints authored text as spans, never markup — the same rule the items section keeps. */
function coloured(text: string): HTMLElement {
  const holder = el('span', {});
  for (const span of parseColour(text)) {
    const node = el('span', {}, span.text);
    if (span.colour !== undefined) node.style.color = span.colour;
    holder.append(node);
  }
  return holder;
}

/** *“kill 3 × kobold youths”* — the objective in the words the progress line uses. */
function objectiveLine(objective: QuestObjective): string {
  return objective.kind === 'kill'
    ? `kill ${objective.count ?? 1} × ${objective.what}`
    : `bring ${objective.what}`;
}

/**
 * A vnum box with the name behind it painted alongside, resolving as you type.
 *
 * The one piece of machinery in this section, and it earns its place: a giver, a quarry and a fetched
 * item are three numbers on one form, and a form of three numbers is one an operator cannot check
 * before they press Save. The lookup is debounced and sequenced — a slower earlier reply landing last
 * would label the box with the name of a vnum already retyped, which reads as the panel being wrong
 * rather than late.
 *
 * `seed` is the name the list already resolved, so an editor opens with the answer rather than
 * flickering through "looking…" for a number that has not changed.
 */
function vnumField(options: {
  readonly value: number | undefined;
  readonly kind: 'mob' | 'item';
  readonly seed?: string | null | undefined;
}): { node: HTMLElement; input: HTMLInputElement; value(): number | undefined } {
  const input = el('input', {
    type: 'number',
    min: '0',
    placeholder: 'vnum',
    value: options.value === undefined ? '' : String(options.value),
  }) as HTMLInputElement;
  const hint = el('span', { class: 'muted' }, options.seed ?? '');

  let pending = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const resolve = (): void => {
    const raw = input.value.trim();
    if (!raw) {
      hint.textContent = '';
      return;
    }
    const seq = ++pending;
    hint.textContent = 'looking…';
    void (async () => {
      // The sections' own searches, which match an exact vnum as a term — so this asks the same
      // question the Mobs and Items tabs ask and cannot disagree with what they show.
      const path = options.kind === 'mob' ? `/mobs?q=${raw}&limit=5` : `/items?q=${raw}&limit=5`;
      const result = await call<{ mobs?: { vnum: number; name: string }[]; items?: { vnum: number; name: string }[] }>(
        'GET',
        path,
      );
      if (seq !== pending) return;
      const rows = result.body?.mobs ?? result.body?.items ?? [];
      const match = rows.find((row) => String(row.vnum) === raw);
      render(hint);
      if (match) hint.append(coloured(match.name));
      else hint.textContent = `no ${options.kind} ${raw}`;
    })();
  };
  input.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(resolve, 200);
  });
  if (options.seed === undefined && options.value !== undefined) resolve();

  return {
    node: el('span', { class: 'row' }, input, hint),
    input,
    value: () => (input.value.trim() ? Number(input.value) : undefined),
  };
}

/** The boxes a quest is made of, shared by the create form and the editor. */
interface QuestForm {
  readonly rows: HTMLElement[];
  /** The draft as the server wants it, or the reason it is not one yet. */
  read(): { draft: Record<string, unknown> } | { error: string };
}

function questForm(quest: QuestRow | undefined): QuestForm {
  const name = el('input', { type: 'text', value: quest?.name ?? '', placeholder: 'Thin the warren' }) as HTMLInputElement;
  const ask = el('textarea', { rows: '3', placeholder: 'what the giver says when the quest is taken' }) as HTMLTextAreaElement;
  const thanks = el('textarea', { rows: '2', placeholder: 'what they say at the turn-in' }) as HTMLTextAreaElement;
  ask.value = quest?.ask ?? '';
  thanks.value = quest?.thanks ?? '';

  const giver = vnumField({ value: quest?.giver, kind: 'mob', seed: quest?.giverName });

  const kind = el('select', {}) as HTMLSelectElement;
  kind.append(el('option', { value: 'kill' }, 'kill'), el('option', { value: 'bring' }, 'bring'));
  kind.value = quest?.objective.kind ?? 'kill';

  const target = vnumField({
    value: quest?.objective.vnum,
    kind: quest?.objective.kind === 'bring' ? 'item' : 'mob',
    seed: quest?.targetName,
  });
  const count = el('input', {
    type: 'number', min: '1', max: '100',
    value: String(quest?.objective.count ?? 1),
  }) as HTMLInputElement;
  const what = el('input', {
    type: 'text', placeholder: 'kobold youths',
    value: quest?.objective.what ?? '',
  }) as HTMLInputElement;
  const countRow = el('span', { class: 'row' }, el('label', {}, 'count'), count);
  // A `bring` has no count — the loader would ignore one, and a box the server ignores is a box that
  // lies. The kind toggle hides it rather than disabling it, and re-aims the target lookup at the
  // catalogue the objective actually names.
  const syncKind = (): void => {
    countRow.style.display = kind.value === 'kill' ? '' : 'none';
  };
  kind.addEventListener('change', syncKind);
  syncKind();

  const xp = el('input', { type: 'number', min: '0', value: String(quest?.reward.xp ?? 0) }) as HTMLInputElement;
  const copper = el('input', { type: 'number', min: '0', value: String(quest?.reward.copper ?? 0) }) as HTMLInputElement;
  // The third pool, and a box that has to exist even for an operator who never uses it: `PATCH` lays
  // the patch over the record and re-validates the whole, so a form that read only two numbers would
  // rewrite `reward` without the item every time somebody fixed a typo in the ask.
  const rewardItem = vnumField({ value: quest?.reward.item, kind: 'item', seed: quest?.rewardItemName });

  return {
    rows: [
      el('div', { class: 'row' }, el('label', {}, 'name'), name),
      el('div', { class: 'row' }, el('label', {}, 'giver'), giver.node),
      el('div', { class: 'row' }, el('label', {}, 'ask'), ask),
      el('div', { class: 'row' }, el('label', {}, 'thanks'), thanks),
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'objective'), kind,
        target.node,
        countRow,
        el('label', {}, 'called'), what,
      ),
      el('div', { class: 'row' }, el('label', {}, 'xp'), xp, el('label', {}, 'copper'), copper),
      el('div', { class: 'row' }, el('label', {}, 'reward item'), rewardItem.node),
    ],
    read() {
      const giverVnum = giver.value();
      if (giverVnum === undefined) return { error: 'a giver vnum is required' };
      const targetVnum = target.value();
      if (targetVnum === undefined) return { error: 'the objective needs a vnum' };
      const objective: Record<string, unknown> =
        kind.value === 'kill'
          ? { kind: 'kill', vnum: targetVnum, count: Number(count.value || 1), what: what.value.trim() }
          : { kind: 'bring', vnum: targetVnum, what: what.value.trim() };
      return {
        draft: {
          giver: giverVnum,
          name: name.value.trim(),
          ask: ask.value.trim(),
          thanks: thanks.value.trim(),
          objective,
          // An empty box is `null` rather than omitted, so clearing one through `PATCH` actually
          // clears it — a missing key would be laid over the record and leave the old vnum standing.
          reward: { xp: Number(xp.value || 0), copper: Number(copper.value || 0), item: rewardItem.value() ?? null },
        },
      };
    },
  };
}

/** What the flash says after a write — the live half, which is the part nobody can see from here. */
function liveNote(body: QuestWriteBody | undefined): string {
  if (!body) return '';
  const resynced = body.resynced ?? 0;
  const badge = resynced > 0 ? ` · ${resynced} standing body${resynced === 1 ? '' : 'ies'} re-marked` : '';
  return `${body.givers.length} giver${body.givers.length === 1 ? '' : 's'} live${badge}`;
}

export const questsSection = {
  slug: 'quests',
  title: 'Quests',
  mount(root: HTMLElement): void {
    const count = el('p', { class: 'note' }, 'reading…');
    const list = el('div', { class: 'rows' });
    let openPanel: HTMLElement | undefined;
    /** An id whose editor reopens after the next repaint, and what to say when it does — items' trick. */
    let reopen: { id: string; message: string } | undefined;

    const openEditor = (quest: QuestRow, under: HTMLElement, message?: string): void => {
      openPanel?.remove();
      const flash = el('p', { class: 'flash' }, message ?? '');
      const form = questForm(quest);

      const save = el('button', {}, 'Save') as HTMLButtonElement;
      save.addEventListener('click', () => {
        const read = form.read();
        if ('error' in read) {
          flash.textContent = read.error;
          return;
        }
        void (async () => {
          const saved = await call<QuestWriteBody>('PATCH', `/quests/${encodeURIComponent(quest.id)}`, read.draft);
          if (!saved.ok) {
            // The server's own sentence, verbatim: it has the only complete account of why a draft is
            // not a quest, and paraphrasing here would be a second validator that drifts.
            flash.textContent = saved.error ?? 'refused';
            return;
          }
          reopen = { id: quest.id, message: `saved · ${liveNote(saved.body)}` };
          refresh();
        })();
      });

      const destroy = el('button', { class: 'danger' }, 'Delete') as HTMLButtonElement;
      destroy.addEventListener('click', () => {
        if (destroy.textContent === 'Delete') {
          // Two clicks rather than a modal, exactly as the item editor does — and the button says what
          // the second one costs, because the cost here is somebody else's progress.
          destroy.textContent = 'Really delete? progress is lost';
          return;
        }
        void (async () => {
          const gone = await call<QuestWriteBody>('DELETE', `/quests/${encodeURIComponent(quest.id)}`);
          if (!gone.ok) {
            flash.textContent = gone.error ?? 'refused';
            destroy.textContent = 'Delete';
            return;
          }
          const stranded = gone.body?.stranded ?? 0;
          openPanel?.remove();
          openPanel = undefined;
          count.textContent =
            `deleted "${quest.id}" · ${liveNote(gone.body)}` +
            (stranded > 0 ? ` · ${stranded} online character${stranded === 1 ? '' : 's'} lost progress` : '');
          refresh();
        })();
      });

      openPanel = el(
        'div',
        { class: 'item-editor' },
        ...form.rows,
        el('div', { class: 'row' }, save, destroy, flash),
        el(
          'p',
          { class: 'note' },
          `id "${quest.id}" — the key every character’s progress is filed under, so it cannot be changed ` +
            'here. A rename is a delete and a create, which is the same thing said out loud.',
        ),
      );
      under.after(openPanel);
    };

    const paint = (body: QuestsBody): void => {
      count.textContent =
        body.total === 0
          ? 'no quests authored — the world has no work in it yet'
          : `${body.total} quest${body.total === 1 ? '' : 's'} in data/world/overrides/quests.json`;
      render(list);
      for (const quest of body.quests) {
        const line = el(
          'div',
          { class: 'row clickable' },
          el('span', { class: 'vnum' }, quest.id),
          el('span', {}, quest.name),
          el(
            'span',
            { class: 'note' },
            `${objectiveLine(quest.objective)} · ${quest.reward.xp} xp` +
              (quest.reward.copper > 0 ? `, ${quest.reward.copper}c` : '') +
              (quest.reward.item === undefined ? '' : `, ${quest.rewardItemName ?? `item ${quest.reward.item}`}`),
          ),
          // The giver, named — the whole reason the list route resolves it. `standing: 0` is worth
          // showing rather than hiding: a patron nothing spawns is a quest nobody will ever be offered.
          el(
            'span',
            { class: 'muted' },
            quest.giverName ? `${quest.giverName} (${quest.giver})` : `giver ${quest.giver} — not loaded`,
            quest.giverStanding === 0 ? ' · none standing' : '',
          ),
        );
        line.addEventListener('click', () => openEditor(quest, line));
        list.append(line);
        if (reopen?.id === quest.id) {
          const { message } = reopen;
          reopen = undefined;
          openEditor(quest, line, message);
        }
      }
      reopen = undefined;
    };

    const refresh = (): void => {
      void (async () => {
        const result = await call<QuestsBody>('GET', '/quests');
        if (result.ok && result.body) {
          paint(result.body);
          return;
        }
        count.textContent = result.error ?? 'could not read the quests';
        render(list);
      })();
    };

    /* ---------------------------------------------------------------- create */

    // Not the editor with an empty record in it — items' argument, and it holds here for one extra
    // reason: this form has an **id box** and the editor must never have one.
    const newFlash = el('p', { class: 'flash' });
    const newId = el('input', { type: 'text', placeholder: 'gwark-thins-the-warren' }) as HTMLInputElement;
    const newForm = el('div', { class: 'item-editor', style: 'display:none' });
    let fields = questForm(undefined);

    const create = el('button', {}, 'Create') as HTMLButtonElement;
    create.addEventListener('click', () => {
      const read = fields.read();
      if ('error' in read) {
        newFlash.textContent = read.error;
        return;
      }
      const id = newId.value.trim().toLowerCase();
      void (async () => {
        const made = await call<QuestWriteBody>('POST', '/quests', { id, ...read.draft });
        if (!made.ok) {
          newFlash.textContent = made.error ?? 'refused';
          return;
        }
        newForm.style.display = 'none';
        newFlash.textContent = '';
        newId.value = '';
        // A fresh set of boxes, because the ones just used hold the quest that now exists — and the
        // editor is where it is edited from here.
        fields = questForm(undefined);
        paintNewForm();
        reopen = { id, message: `created · ${liveNote(made.body)}` };
        refresh();
      })();
    });

    const paintNewForm = (): void => {
      render(
        newForm,
        el(
          'div',
          { class: 'row' },
          el('label', {}, 'id'), newId,
          el('span', { class: 'muted' }, 'a slug: lower case, digits and hyphens. Permanent — it keys every save file'),
        ),
        ...fields.rows,
        el('div', { class: 'row' }, create, newFlash),
      );
    };
    paintNewForm();

    const newButton = el('button', {}, 'New quest') as HTMLButtonElement;
    newButton.addEventListener('click', () => {
      newForm.style.display = newForm.style.display === 'none' ? '' : 'none';
    });

    render(
      root,
      el('h2', {}, 'Quests'),
      el('div', { class: 'card' }, el('div', { class: 'controls' }, newButton), newForm, count, list),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'How authoring works'),
        el(
          'p',
          { class: 'note' },
          'Quests are whole records in data/world/overrides/quests.json — content in the one directory ' +
            'git tracks, so they are committed with the world rather than harvested into it. A write ' +
            'lands on the running server immediately: the definitions the quest verb reads, the gold ? ' +
            'over a giver’s head, and the rule that makes a giver un-attackable are all re-seeded from ' +
            'these rows in one motion, so a giver can never wear the badge without the armour. Players ' +
            'standing in the room see the mark change without reconnecting. What a character stores is ' +
            'one number per quest id, so editing prose or a reward touches no save file — but deleting ' +
            'a quest, or changing its id, strands whatever progress was filed under it.',
        ),
      ),
    );

    refresh();
  },
};
