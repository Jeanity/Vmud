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
import { artPicker, artThumb } from '../artpicker.ts';
import { colourBox } from '../colourbox.ts';
import { el, render } from '../dom.ts';

/** One row as the search returns it. Optional fields are absent rather than null when they do not apply. */
interface ItemRow {
  readonly edited?: boolean;
  /** A6b: made here rather than harvested. **A different fact to `edited`** — see the marks below. */
  readonly created?: boolean;
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
  /** A7c: the sheet this item is drawn with, when somebody has chosen one. */
  readonly art?: string;
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
    readonly type: number;
    readonly slot?: string;
    readonly ac: number;
    readonly size: number;
    readonly cost: number;
    readonly damage?: { readonly count: number; readonly sides: number; readonly bonus: number };
    readonly art?: string;
  };
  readonly authored: Record<string, unknown> | null;
  /** Present when there is no harvest under this item: a Delete rather than a Restore. */
  readonly created?: Record<string, unknown> | null;
}

/**
 * The catalogue types a created item may be, in the order somebody reaches for them.
 *
 * A subset of `DURIS_ITEM` on purpose — the full list carries types nothing in the game reads yet
 * (`fireweapon`, `spellbook`, `scabbard`), and offering a type whose behaviour is unimplemented would be
 * offering to create an item that does nothing and cannot be told why.
 */
const CREATABLE_TYPES: readonly (readonly [value: number, label: string])[] = [
  [5, 'weapon'],
  [9, 'armour'],
  [11, 'worn'],
  [37, 'shield'],
  [1, 'light'],
  [15, 'container'],
  [19, 'food'],
  [10, 'potion'],
  [2, 'scroll'],
  [3, 'wand'],
  [4, 'staff'],
  [7, 'missile'],
  [18, 'key'],
  [8, 'treasure'],
];

/**
 * The slots a created item may be worn in — the game's own `EQUIP_SLOTS`, plus "carried only".
 *
 * Written out rather than imported so the *order* is an editorial choice: head down to feet, then the
 * paired and rare positions. `EQUIP_SLOTS`' order is the wire's, and sorting a form by a wire order is
 * how an operator ends up hunting for `feet` between `ioun` and `quiver`.
 */
const WEARABLE_SLOTS: readonly string[] = [
  'head', 'eyes', 'face', 'nose', 'ear1', 'ear2', 'neck', 'neck2', 'about', 'chest', 'back',
  'arms', 'wrist1', 'wrist2', 'hands', 'ring1', 'ring2', 'waist', 'legs', 'feet',
  'mainHand', 'offHand', 'quiver', 'ioun',
];

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
          //
          // **✦ is a different mark, not a louder one.** ✎ means a harvested item with changes over it,
          // and its editor offers Restore harvested. ✦ means there is no harvest at all, and its editor
          // offers Delete. An operator who cannot tell them apart from the row will eventually click
          // Restore expecting the first and get the second's nothing.
          el('span', { class: 'vnum' }, `${row.vnum}${row.created ? ' ✦' : row.edited ? ' ✎' : ''}`),
          // A7c. Half-size, because the question a list answers is *which of these have a picture* and
          // a 64 px tile on fifty rows is a page you scroll rather than scan. The item's own sheet, so
          // it also answers "which one" at a glance — two boots apart is visible at 32 px even when
          // the ids are not. Only when there is art: an empty tile would imply a missing file.
          row.art ? artThumb(row.art, 0.5) : null,
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
      // Whether there is a harvest under this item decides two things the record cannot say for itself:
      // which fields may be edited, and whether the dangerous button says Restore or Delete.
      const madeHere = Boolean(result.body.created);

      const flash = el('p', { class: 'flash' }, message ?? '');
      const name = colourBox({ value: item.name, placeholder: 'display name, colour codes welcome' });
      const keywords = el('input', { type: 'text', value: item.keywords.join(' ') }) as HTMLInputElement;
      const ac = el('input', { type: 'number', value: String(item.ac), min: '0', max: '50' }) as HTMLInputElement;
      const cost = el('input', { type: 'number', value: String(item.cost), min: '0' }) as HTMLInputElement;
      const dCount = el('input', { type: 'number', value: item.damage ? String(item.damage.count) : '', placeholder: '—' }) as HTMLInputElement;
      const dSides = el('input', { type: 'number', value: item.damage ? String(item.damage.sides) : '', placeholder: '—' }) as HTMLInputElement;
      const dBonus = el('input', { type: 'number', value: item.damage ? String(item.damage.bonus) : '', placeholder: '0' }) as HTMLInputElement;

      // A7c. Offered on **every** item, harvested or created: `art` is content in the same sense the
      // name is — choosing a sword's picture changes nothing about what the sword does — which is why
      // `ITEM_PATCH_KEYS` has it beside `name` rather than among the refused behaviour fields. Opens
      // on the item's own slot, so editing boots shows boots.
      const art = artPicker({ value: item.art, slot: item.slot });

      // **Only a created item gets these.** On a harvested one `slot`, `type` and `size` come from the
      // source's own bits and the server refuses to author them — offering boxes the save would reject
      // is worse than not offering them.
      const slot = el('select', {}) as HTMLSelectElement;
      const type = el('select', {}) as HTMLSelectElement;
      const size = el('input', { type: 'number', value: String(item.size), min: '1', max: '10' }) as HTMLInputElement;
      if (madeHere) {
        slot.append(el('option', { value: '' }, 'carried only'));
        for (const name of WEARABLE_SLOTS) slot.append(el('option', { value: name }, name));
        slot.value = item.slot ?? '';
        for (const [value, label] of CREATABLE_TYPES) type.append(el('option', { value: String(value) }, label));
        type.value = String(item.type);
      }

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
        } else if (madeHere ? item.damage !== undefined : authored && 'damage' in authored) {
          // **Blanking the triple clears the damage.** On a harvested item only an *authored* clear
          // makes sense — a blank triple on a tunic is "no damage here", not a request — so the guard
          // asks the overlay. On a created item there is no harvest to fall back to, so the record's
          // own dice are the thing being cleared and the record is what to ask.
          patch.damage = null;
        }

        // **`null` clears, `undefined` means untouched** — the same rule every other field here
        // follows, and the picker distinguishes them for free because "no art" is a state an operator
        // chooses with the None button rather than a box they blank.
        if (art.value() !== item.art) patch.art = art.value() ?? null;

        // The whole-record fields, and only where they exist to edit.
        if (madeHere) {
          if ((slot.value || undefined) !== item.slot) patch.slot = slot.value || null;
          if (Number(type.value) !== item.type) patch.type = Number(type.value);
          if (size.value.trim() && Number(size.value) !== item.size) patch.size = Number(size.value);
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

      /**
       * The dangerous button, and which one it is depends on what is under the item.
       *
       * Restore harvested on a created item would be a button with nothing to restore *to* — the honest
       * equivalent is Delete, and they are exclusive rather than both being shown greyed, because a
       * disabled Delete beside an enabled Restore invites exactly the wrong click.
       */
      const destroy = el('button', { class: 'danger' }, 'Delete') as HTMLButtonElement;
      destroy.addEventListener('click', () => {
        if (destroy.textContent === 'Delete') {
          // A two-click confirm rather than a modal: the second click is the confirmation, and the
          // button says so in between. Deleting an item is not undoable and not worth a silent single
          // click, but it is also not worth stealing focus for.
          destroy.textContent = 'Really delete?';
          return;
        }
        void (async () => {
          const gone = await call<{ ok: boolean }>('DELETE', `/items/${vnum}`);
          if (!gone.ok) {
            flash.textContent = gone.error ?? 'refused';
            destroy.textContent = 'Delete';
            return;
          }
          openPanel?.remove();
          openPanel = undefined;
          search();
        })();
      });

      // Give it to somebody. **The completion test for the whole slice** — an item that can be authored
      // and never held cannot be checked at all, and this is the shortest path from the catalogue to a
      // pair of hands. Any item, not only created ones: checking a harvested item's edit wants it too.
      const who = el('input', { type: 'text', placeholder: 'character' }) as HTMLInputElement;
      const give = el('button', {}, 'Give') as HTMLButtonElement;
      give.addEventListener('click', () => {
        const target = who.value.trim().toLowerCase();
        if (!target) {
          flash.textContent = 'type a character name first';
          return;
        }
        void (async () => {
          const handed = await call<{ ok: boolean; name: string }>('POST', `/players/${target}/give`, { vnum });
          flash.textContent = handed.ok ? `given to ${who.value.trim()}` : handed.error ?? 'refused';
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
      const madeNote = typeof result.body.created?.at === 'string'
        ? `made here — no harvest under it (${String(result.body.created.at).slice(0, 10)})`
        : 'made here — no harvest under it';
      const authoredNote = madeHere
        ? madeNote
        : authored
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
        // Only a created item can say what it *is*; a harvested one's row is the source's own bits.
        ...(madeHere
          ? [el('div', { class: 'row' }, el('label', {}, 'type'), type, el('label', {}, 'slot'), slot, el('label', {}, 'size'), size)]
          : []),
        el('div', { class: 'row' }, el('label', {}, 'art'), art.node),
        el('div', { class: 'row' }, save, madeHere ? destroy : revert, who, give, flash),
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

    /**
     * The New item form — A6b.
     *
     * Deliberately **not** the editor with an empty record in it. The editor's whole discipline is
     * diffing against what the server holds and sending only what changed, and there is nothing to diff
     * against before an item exists; reusing it would mean a second meaning for every blank box. So:
     * one form that posts a whole draft, and the editor takes over the moment the item is real.
     *
     * No vnum box, because the number is the server's to allocate. See `item-authoring.ts`.
     */
    const newFlash = el('p', { class: 'flash' });
    const newName = colourBox({ value: '', placeholder: 'display name, colour codes welcome' });
    const newKeywords = el('input', { type: 'text', placeholder: 'the words a player types' }) as HTMLInputElement;
    const newType = el('select', {}) as HTMLSelectElement;
    for (const [value, label] of CREATABLE_TYPES) newType.append(el('option', { value: String(value) }, label));
    const newSlot = el('select', {}) as HTMLSelectElement;
    newSlot.append(el('option', { value: '' }, 'carried only'));
    for (const name of WEARABLE_SLOTS) newSlot.append(el('option', { value: name }, name));
    const newAc = el('input', { type: 'number', value: '0', min: '0', max: '50' }) as HTMLInputElement;
    const newSize = el('input', { type: 'number', value: '1', min: '1', max: '10' }) as HTMLInputElement;
    const newCost = el('input', { type: 'number', value: '0', min: '0' }) as HTMLInputElement;
    const newDCount = el('input', { type: 'number', placeholder: '—' }) as HTMLInputElement;
    const newDSides = el('input', { type: 'number', placeholder: '—' }) as HTMLInputElement;
    const newDBonus = el('input', { type: 'number', placeholder: '0' }) as HTMLInputElement;
    // A7c. `draftAuthoredItem` has accepted `art` since A7b and no form ever offered it, so an item
    // made here could only be given a picture by creating it, finding it again and editing it.
    const newArt = artPicker({ value: undefined, slot: undefined });
    // The slot is being chosen a few centimetres away; the picker follows it rather than opening on
    // all 319 sheets for an item whose slot the form already knows.
    newSlot.addEventListener('change', () => newArt.setSlot(newSlot.value || undefined));
    const create = el('button', {}, 'Create') as HTMLButtonElement;
    const newForm = el('div', { class: 'item-editor', style: 'display:none' });

    create.addEventListener('click', () => {
      const words = [...new Set(newKeywords.value.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 0))];
      const draft: Record<string, unknown> = {
        name: newName.value().trim(),
        keywords: words,
        type: Number(newType.value),
        ac: Number(newAc.value || 0),
        size: Number(newSize.value || 1),
        cost: Number(newCost.value || 0),
        ...(newSlot.value ? { slot: newSlot.value } : {}),
        ...(newArt.value() ? { art: newArt.value() } : {}),
        ...(newDCount.value.trim() || newDSides.value.trim()
          ? { damage: { count: Number(newDCount.value), sides: Number(newDSides.value), bonus: Number(newDBonus.value || 0) } }
          : {}),
      };
      void (async () => {
        const made = await call<{ ok: boolean; vnum: number }>('POST', '/items', draft);
        if (!made.ok || !made.body) {
          // The server's own words. It has the only complete account of why a draft is not an item, and
          // paraphrasing it here would be a second validator that drifts.
          newFlash.textContent = made.error ?? 'refused';
          return;
        }
        const { vnum } = made.body;
        // Search *for the thing just made*, so it is on screen rather than somewhere in 16,421 rows —
        // and the editor opens on it, which is where art and the rest of the fields will be edited.
        field.value = String(vnum);
        reopen = { vnum, message: `created as vnum ${vnum}` };
        newForm.style.display = 'none';
        newFlash.textContent = '';
        newName.set('');
        newKeywords.value = '';
        newDCount.value = newDSides.value = newDBonus.value = '';
        newArt.set(undefined);
        search();
      })();
    });

    const newButton = el('button', {}, 'New item') as HTMLButtonElement;
    newButton.addEventListener('click', () => {
      newForm.style.display = newForm.style.display === 'none' ? '' : 'none';
    });

    render(
      newForm,
      el('div', { class: 'row' }, el('label', {}, 'name'), newName.node),
      el('div', { class: 'row' }, el('label', {}, 'keywords'), newKeywords),
      el('div', { class: 'row' }, el('label', {}, 'type'), newType, el('label', {}, 'slot'), newSlot, el('label', {}, 'size'), newSize),
      el(
        'div',
        { class: 'row' },
        el('label', {}, 'AC'), newAc,
        el('label', {}, 'damage'), newDCount, el('span', { class: 'muted' }, 'd'), newDSides, el('span', { class: 'muted' }, '+'), newDBonus,
        el('label', {}, 'cost'), newCost,
      ),
      el('div', { class: 'row' }, el('label', {}, 'art'), newArt.node),
      el('div', { class: 'row' }, create, newFlash),
      el('p', { class: 'note' }, 'The vnum is allocated at nine million and up, where no Duris item reaches.'),
    );

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
        el('div', { class: 'controls' }, field, kind, newButton),
        newForm,
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
          'Edits to a harvested item land in data/world/overrides/items.json as a partial overlay — ' +
            'only the fields you change — composed over the harvest when the server boots. ' +
            'npm run worldgen can rebuild the catalogue underneath it, and Restore harvested puts the ' +
            'original value back exactly. Items you create here are whole records in ' +
            'items-authored.json instead, numbered from nine million where no Duris item reaches, so a ' +
            're-harvest can never collide with one; they carry ✦ and a Delete rather than ✎ and a ' +
            'Restore. Either way, changes shape future spawns and loot — instances already in bags ' +
            'keep the copy they were made with. Give puts one in a live character’s hands.',
        ),
      ),
    );

    search();
  },
};
