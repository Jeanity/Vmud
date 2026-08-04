/**
 * Items — the harvested catalogue, searchable.
 *
 * Searchable since 15c; **editable since A6.** `DESIGN-admin-panel.md` §1's rule holds throughout:
 * authoring lands in `data/world/overrides/items.json` as a *partial* overlay the server composes over
 * the harvest at boot — so `npm run worldgen` can rebuild `items.json` forever underneath a growing
 * body of authored changes, and a re-harvest that improves an unedited field flows through.
 *
 * The editor offers **content** — name, keywords, armour class, damage, cost — and deliberately not
 * behaviour: slot, type, container rule and stacking are derived from Duris' own bits, and the server
 * refuses them by name. Clearing a field restores the harvested value exactly, because the server
 * keeps the pristine template of anything overridden; an edited row wears ✎.
 *
 * ## Searched, not listed
 *
 * Sixteen thousand rows is not a page. The term goes to the server and a bounded page comes back, with
 * the **total reported beside it** so a too-broad search is visible rather than silently truncated —
 * reading the first fifty of nine hundred and believing it is the answer is the failure this avoids.
 *
 * ## Colour is painted, never inserted
 *
 * Item names carry the builder's own `&+C` codes, and this is authored text from a third-party world
 * file. It goes through `parseColour` into spans, exactly as the game client and the colour box do —
 * never into `innerHTML`. That is the same rule Phase 15c learned the hard way when harvested names
 * first reached a character sheet and printed their codes verbatim.
 */

import { parseColour } from '@mygame/shared';

import { call } from '../api.ts';
import { colourBox } from '../colourbox.ts';
import { el, render } from '../dom.ts';

/** One row as the search returns it. Optional fields are absent rather than null when they do not apply. */
interface ItemRow {
  readonly edited?: boolean;
  readonly vnum: number;
  readonly name: string;
  readonly keywords: readonly string[];
  readonly type: number;
  readonly slot: string | null;
  readonly ac: number;
  readonly size: number;
  readonly cost: number;
  readonly damage?: string;
  readonly twoHanded?: boolean;
  readonly stackLimit?: number;
  readonly uses?: number;
  readonly container?: { readonly capacity: number; readonly accepts: string };
  readonly coins?: Readonly<Record<string, number>>;
}

interface SearchBody {
  readonly total: number;
  readonly catalogue: number;
  readonly items: readonly ItemRow[];
}

/** The full record the editor works on, with whatever is currently authored. */
interface ItemBody {
  readonly item: {
    readonly vnum: number;
    readonly name: string;
    readonly keywords: readonly string[];
    readonly ac: number;
    readonly cost: number;
    readonly damage?: { readonly count: number; readonly sides: number; readonly bonus: number };
  };
  readonly authored: Record<string, unknown> | null;
}

/** The kind filters, in the order an operator is likely to want them. */
const KINDS: readonly (readonly [value: string, label: string])[] = [
  ['', 'Everything'],
  ['weapon', 'Weapons'],
  ['twoHanded', 'Two-handed'],
  ['armour', 'Armour'],
  ['container', 'Containers'],
];

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

/**
 * The short facts under a name — only the ones that apply.
 *
 * Absent rather than blank, because a dash in a "capacity" column implies a sword has a capacity and
 * it is zero. What an item *is* comes from which of these are present at all.
 */
function traits(row: ItemRow): string[] {
  const out: string[] = [];
  if (row.damage) out.push(row.twoHanded ? `${row.damage} · two-handed` : row.damage);
  if (row.ac > 0) out.push(`+${row.ac} AC`);
  if (row.slot) out.push(row.slot);
  if (row.container) out.push(`holds ${row.container.capacity} (${row.container.accepts})`);
  if (row.stackLimit) out.push(`stacks to ${row.stackLimit}`);
  if (row.uses !== undefined) out.push(`${row.uses} charges`);
  if (row.coins) {
    out.push(Object.entries(row.coins).map(([metal, n]) => `${n} ${metal}`).join(', '));
  }
  out.push(`${row.size} slot${row.size === 1 ? '' : 's'}`);
  if (row.cost > 0) out.push(`${row.cost}c`);
  return out;
}

export const itemsSection = {
  slug: 'items',
  title: 'Items',
  mount(root: HTMLElement): void {
    const field = el('input', { type: 'search', placeholder: 'name, keyword or vnum' }) as HTMLInputElement;
    const kind = el('select', {}) as HTMLSelectElement;
    for (const [value, label] of KINDS) kind.append(el('option', { value }, label));
    const count = el('p', { class: 'note' }, 'searching…');
    const list = el('div', { class: 'rows' });

    const paint = (body: SearchBody): void => {
      count.textContent =
        body.total === body.items.length
          ? `${body.total} of ${body.catalogue} items`
          : `showing ${body.items.length} of ${body.total} matches — narrow the search to see the rest`;

      render(list);
      if (body.items.length === 0) {
        list.append(el('p', { class: 'empty' }, 'Nothing in the catalogue matches.'));
        return;
      }
      for (const row of body.items) {
        const line = el(
          'div',
          { class: 'row clickable' },
          // ✎ beside the vnum, exactly where the zones browser puts it: *that* it is authored lives
          // on the row, *what* is authored lives in the editor.
          el('span', { class: 'vnum' }, row.edited ? `${row.vnum} ✎` : String(row.vnum)),
          coloured(row.name),
          el('span', { class: 'note' }, traits(row).join(' · ')),
          // The authored keyword list, which is what a player types and what `isName` matches. Worth
          // showing because it is frequently *not* what the display name suggests.
          el('span', { class: 'muted' }, row.keywords.join(' ')),
        );
        line.addEventListener('click', () => void openEditor(row.vnum, line));
        list.append(line);
        if (reopen?.vnum === row.vnum) {
          const { message } = reopen;
          reopen = undefined;
          void openEditor(row.vnum, line, message);
        }
      }
      // The item fell out of the current search — nothing to reopen against, so the intent is dropped
      // rather than left to fire against some later, unrelated repaint.
      reopen = undefined;
    };

    /**
     * The editor, expanded under the clicked row — A6.
     *
     * Built from `GET /items/:vnum` rather than from the search row, because the row is a summary and
     * an editor seeded from a summary quietly erases whatever the summary omitted. Only the fields
     * that *differ from what the server holds* are sent, so saving an untouched form is a no-op and
     * the overlay never accumulates fields nobody changed.
     */
    let openPanel: HTMLElement | undefined;
    /**
     * A vnum whose editor should reopen after the next repaint, and what to say when it does.
     *
     * The editor lives inside the results list, so refreshing the list to show an edit necessarily
     * destroys it. Rather than avoid the refresh — which would leave a stale row under an open
     * editor — the panel reopens itself against freshly fetched data and carries its message across.
     */
    let reopen: { vnum: number; message: string } | undefined;
    const openEditor = async (vnum: number, under: HTMLElement, message?: string): Promise<void> => {
      openPanel?.remove();
      openPanel = undefined;
      const result = await call<ItemBody>('GET', `/items/${vnum}`);
      if (!result.ok || !result.body) return;
      const { item, authored } = result.body;

      const flash = el('p', { class: 'flash' }, message ?? '');
      const name = colourBox({ value: item.name, placeholder: 'display name, colour codes welcome' });
      const keywords = el('input', { type: 'text', value: item.keywords.join(' ') }) as HTMLInputElement;
      const ac = el('input', { type: 'number', value: String(item.ac), min: '0', max: '50' }) as HTMLInputElement;
      const cost = el('input', { type: 'number', value: String(item.cost), min: '0' }) as HTMLInputElement;
      const dCount = el('input', { type: 'number', value: item.damage ? String(item.damage.count) : '', placeholder: '—' }) as HTMLInputElement;
      const dSides = el('input', { type: 'number', value: item.damage ? String(item.damage.sides) : '', placeholder: '—' }) as HTMLInputElement;
      const dBonus = el('input', { type: 'number', value: item.damage ? String(item.damage.bonus) : '', placeholder: '0' }) as HTMLInputElement;

      const save = el('button', {}, 'Save') as HTMLButtonElement;
      save.addEventListener('click', () => {
        const patch: Record<string, unknown> = {};

        // **Canonicalised before it is compared, because the server canonicalises before it stores.**
        // Diffing the raw box against the harvest meant a trailing space or a repeated keyword
        // produced a patch whose *stored* value equalled the harvest — an override identical to the
        // thing it overrides, wearing a permanent ✎ and frozen against every future re-harvest.
        // That is precisely the freeze the partial overlay exists to avoid.
        const typedName = name.value().trim();
        if (typedName && typedName !== item.name) patch.name = typedName;
        const words = [...new Set(keywords.value.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0))];
        if (words.length > 0 && words.join(' ') !== item.keywords.join(' ')) patch.keywords = words;

        // **A blank number box means "I did not touch this", never zero.** `Number('')` is 0, so
        // select-all-delete in the cost box used to author a free breastplate and flash "saved".
        // Emptying a box is how somebody starts retyping, not how they ask for nothing.
        if (ac.value.trim() && Number(ac.value) !== item.ac) patch.ac = Number(ac.value);
        if (cost.value.trim() && Number(cost.value) !== item.cost) patch.cost = Number(cost.value);

        const typedDice = dCount.value.trim() || dSides.value.trim();
        if (typedDice) {
          const dice = { count: Number(dCount.value), sides: Number(dSides.value), bonus: Number(dBonus.value || 0) };
          if (JSON.stringify(dice) !== JSON.stringify(item.damage ?? null)) patch.damage = dice;
        } else if (authored && 'damage' in authored) {
          // **Blanking the triple clears an authored damage** — and only an authored one. On an item
          // whose dice come from the harvest a blank triple is still "no damage here", so nothing is
          // sent; without this branch the only way to undo a dice edit was Restore harvested, which
          // takes the name with it.
          patch.damage = null;
        }

        if (Object.keys(patch).length === 0) {
          flash.textContent = 'nothing changed';
          return;
        }
        void (async () => {
          const saved = await call<{ ok: boolean }>('PATCH', `/items/${vnum}`, patch);
          if (!saved.ok) {
            flash.textContent = saved.error ?? 'refused';
            return;
          }
          // The list repaint destroys this panel — it is a child of `list` — so the editor is asked
          // to reopen itself with fresh data and carry the message across. Without this the
          // confirmation was wiped within a frame and iterative tuning meant re-clicking the row
          // after every save.
          reopen = { vnum, message: 'saved — future spawns use it; existing instances keep their copy' };
          search();
        })();
      });

      const revert = el('button', { class: 'danger' }, 'Restore harvested') as HTMLButtonElement;
      revert.addEventListener('click', () => {
        // Clears exactly what is authored, not every field: the server deletes the entry once nothing
        // authored remains, which is what takes the ✎ off the row.
        const keys = Object.keys(authored ?? {}).filter((k) => k !== 'at' && k !== 'by');
        if (keys.length === 0) {
          flash.textContent = 'nothing is authored on this item';
          return;
        }
        void (async () => {
          const cleared = await call<{ ok: boolean }>('PATCH', `/items/${vnum}`, Object.fromEntries(keys.map((k) => [k, null])));
          if (!cleared.ok) {
            flash.textContent = cleared.error ?? 'refused';
            return;
          }
          reopen = { vnum, message: 'harvest restored' };
          search();
        })();
      });

      const authoredKeys = Object.keys(authored ?? {}).filter((k) => k !== 'at' && k !== 'by');
      const authoredNote = authored
        ? `authored: ${authoredKeys.join(', ')}${typeof authored.at === 'string' ? ` (${authored.at.slice(0, 10)})` : ''}`
        : 'nothing authored — every field is the harvest’s';

      openPanel = el(
        'div',
        { class: 'item-editor' },
        el('div', { class: 'row' }, el('label', {}, 'name'), name.node),
        el('div', { class: 'row' }, el('label', {}, 'keywords'), keywords),
        el(
          'div',
          { class: 'row' },
          el('label', {}, 'AC'), ac,
          el('label', {}, 'damage'), dCount, el('span', { class: 'muted' }, 'd'), dSides, el('span', { class: 'muted' }, '+'), dBonus,
          el('label', {}, 'cost'), cost,
        ),
        el('div', { class: 'row' }, save, revert, flash),
        el('p', { class: 'note' }, authoredNote),
      );
      under.after(openPanel);
    };

    let pending = 0;
    const search = (): void => {
      const seq = ++pending;
      const params = new URLSearchParams();
      if (field.value.trim()) params.set('q', field.value.trim());
      if (kind.value) params.set('kind', kind.value);
      void (async () => {
        const result = await call<SearchBody>('GET', `/items?${params.toString()}`);
        // **Out-of-order replies are dropped rather than painted.** Typing fires a search per keystroke
        // and a slower earlier one landing last would show results for a term the operator has already
        // finished editing — which reads as the search being wrong rather than late.
        if (seq !== pending) return;
        if (result.ok && result.body) {
          paint(result.body);
          return;
        }
        count.textContent = result.error ?? 'could not read the catalogue';
        render(list);
      })();
    };

    let debounce: ReturnType<typeof setTimeout> | undefined;
    field.addEventListener('input', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(search, 150);
    });
    kind.addEventListener('change', search);

    render(
      root,
      el('h2', {}, 'Items'),
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'controls' }, field, kind),
        count,
        list,
      ),
      el(
        'div',
        { class: 'card' },
        el('h3', {}, 'How authoring works'),
        el(
          'p',
          { class: 'note' },
          'Edits land in data/world/overrides/items.json as a partial overlay — only the fields you ' +
            'change — composed over the harvest when the server boots. npm run worldgen can rebuild ' +
            'the catalogue underneath it, and Restore harvested puts the original value back exactly. ' +
            'Edits shape future spawns and loot; instances already in bags keep the copy they were made with.',
        ),
      ),
    );

    search();
  },
};
