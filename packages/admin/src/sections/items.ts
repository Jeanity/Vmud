/**
 * Items — the harvested catalogue, searchable.
 *
 * **Read-only, and that is the whole slice rather than a shortcut.** `DESIGN-admin-panel.md` §1's rule
 * is that authoring lands as overlay files the game loads, and there is no item overlay yet — A6 is
 * where that goes. What was blocking this section was never the editor, it was the *data*: until 15c
 * every item in the world came from the rolled starter kit in `shared/src/equipment.ts`, which is code,
 * so there was nothing to look at. There are 16,421 entries now, and being able to find one is the
 * thing an operator needs first and every day after.
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
import { el, render } from '../dom.ts';

/** One row as the search returns it. Optional fields are absent rather than null when they do not apply. */
interface ItemRow {
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
        list.append(
          el(
            'div',
            { class: 'row' },
            el('span', { class: 'vnum' }, String(row.vnum)),
            coloured(row.name),
            el('span', { class: 'note' }, traits(row).join(' · ')),
            // The authored keyword list, which is what a player types and what `isName` matches. Worth
            // showing because it is frequently *not* what the display name suggests.
            el('span', { class: 'muted' }, row.keywords.join(' ')),
          ),
        );
      }
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
        el('h3', {}, 'Why this is read-only'),
        el(
          'p',
          { class: 'note' },
          'The catalogue is harvested from Duris’ .obj files by npm run worldgen, so it is ' +
            'reproducible rather than authored — editing it here would be editing a build output. ' +
            'Item authoring lands as overlay files the same way room prose does, which is A6.',
        ),
      ),
    );

    search();
  },
};
