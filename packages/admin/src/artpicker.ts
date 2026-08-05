/**
 * The art picker — A7c, and the half of A7b that was missing.
 *
 * A7b made `art` an authorable field on any item and drew the chosen sheet on the body. What it did
 * not do was give anybody a way to *find* a legal value: the id is one of 319 generated strings, it
 * is refused by name if wrong, and nothing on screen listed them. So the field existed and was
 * effectively unusable, which is the shape of thing `ROADMAP.md` rule 1 exists to catch.
 *
 * ## Why a grid of pictures and not a `<select>`
 *
 * The same argument `colourbox.ts` makes about colour codes, and more sharply. `torso-tunic-brown`
 * and `torso-shirt-brown` are one word apart and look nothing alike; `arms-armour` is a pair of
 * shoulder plates rather than sleeves. **The id does not describe the picture**, so a dropdown of
 * ids is a list of guesses. What an operator is choosing is an image, so the control shows images.
 *
 * ## The thumbnail is a crop, not a scaled sheet
 *
 * Every staged sheet is 576×256 — nine columns by four rows of 64 px, LPC's walk cycle. The frame
 * worth showing is **column 0 of row 2**: row 2 is south-facing (LPC's row order is
 * north/west/south/east, `scene.ts`'s `LPC_ROW`) and column 0 is the contact pose that doubles as
 * standing. So the tile is a 64×64 window onto the sheet at offset `0, -128`, done with
 * `background-position` — no canvas, no fetch, and the browser caches one image per sheet however
 * many times it is drawn.
 *
 * Rendered `pixelated` at 2×. LPC is 64 px art and a browser's default smoothing turns a crisp
 * helmet into a smudge at any size but 1:1, which would defeat the point of showing it at all.
 *
 * ## Filtered to the slot, but never restricted to it
 *
 * `GET /art?slot=` filters on `artgen`'s own type mapping, which is a hint and enforced nowhere —
 * the server's own comment says somebody will eventually want a hat sheet on a helmet-shaped shield.
 * So the picker opens on the item's slot and carries a way to see everything, rather than deciding
 * for the operator that a `waist` item may only wear belts.
 */

import { call } from './api.ts';
import { el, render } from './dom.ts';

/** One indexed sheet, as `GET /art` returns it — a mirror of `shared/src/lpc-art.ts`'s `ArtEntry`. */
export interface ArtRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly slot?: string;
  readonly sheet: string;
  readonly z: number;
  readonly authors: readonly string[];
  readonly licences: readonly string[];
}

interface ArtBody {
  readonly total: number;
  readonly art: readonly ArtRow[];
}

export interface ArtPicker {
  /** Current row, chooser and all, ready to append to a form. */
  readonly node: HTMLElement;
  /** The chosen art id, or undefined for none. */
  value(): string | undefined;
  /** Sets the selection without raising `onPick` — for seeding a form from a record. */
  set(id: string | undefined): void;
  /**
   * Re-points the slot filter.
   *
   * The New item form needs this and the editor does not: there the slot is a dropdown being filled
   * in beside the picker, so a filter fixed at construction would open on whatever the form happened
   * to default to and quietly stay there. **The selection is never cleared by a slot change** — the
   * filter is a hint, and an operator who chose a sash for a `neck` item meant it.
   */
  setSlot(slot: string | undefined): void;
}

export interface ArtPickerOptions {
  /** What the item currently wears, if anything. */
  readonly value: string | undefined;
  /** The item's slot, used to open the browser on the sheets it probably wants. Absent is fine. */
  readonly slot?: string | undefined;
  /** Raised on every change, including a clear. */
  readonly onPick?: (id: string | undefined) => void;
}

/**
 * A 64×64 window onto a staged sheet, showing the south-facing standing frame.
 *
 * Served from `/lpc/<sheet>.png` on the panel's own origin — the game server, through the Vite proxy
 * — so this is a plain `<img>`-less div with a background and needs neither auth nor a canvas. See
 * `server/src/art.ts` for why the sheets come from there rather than from the client's port.
 */
export function artThumb(sheet: string, scale = 2): HTMLElement {
  const size = 64 * scale;
  return el('div', {
    class: 'art-thumb',
    // `background-size` is the *whole sheet* scaled, and the position scales with it: at 2× the
    // south row starts 256 px down rather than 128. Getting this wrong shows a different facing,
    // which reads as the art being wrong rather than the maths.
    style:
      `width:${size}px;height:${size}px;` +
      `background-image:url(/lpc/${sheet}.png);` +
      `background-size:${576 * scale}px ${256 * scale}px;` +
      `background-position:0 -${128 * scale}px;`,
  });
}

export function artPicker(options: ArtPickerOptions): ArtPicker {
  let chosen = options.value;
  let slotFilter = options.slot;

  const current = el('div', { class: 'art-current' });
  const choose = el('button', { type: 'button' }, 'Choose art…') as HTMLButtonElement;
  const clearBtn = el('button', { type: 'button' }, 'None') as HTMLButtonElement;
  const browser = el('div', { class: 'art-browser', style: 'display:none' });
  const grid = el('div', { class: 'art-grid' });
  const term = el('input', { type: 'search', placeholder: 'name, kind or id' }) as HTMLInputElement;
  const everything = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const note = el('span', { class: 'note' }, '');

  /**
   * The sheets, once. 319 rows of metadata is a few tens of kilobytes and the whole index is what
   * both the search and the slot filter run over — refetching per keystroke would put a network
   * round trip inside typing for no gain, and the index cannot change without a server restart.
   */
  let index: readonly ArtRow[] | undefined;
  let loading: Promise<void> | undefined;

  const paintCurrent = (): void => {
    const entry = chosen === undefined ? undefined : index?.find((a) => a.id === chosen);
    render(current);
    if (chosen === undefined) {
      // Not an empty box: an item with no art is the normal case — 319 sheets against 16,421 items —
      // and a blank space beside a label reads as something failing to load.
      current.append(el('span', { class: 'muted' }, 'no art — drawn as nothing on the body'));
      return;
    }
    current.append(artThumb(entry?.sheet ?? chosen));
    current.append(
      el(
        'span',
        { class: 'art-name' },
        // The id as well as the name, because the id is what lands in the overlay file and what a
        // bug report will quote. The name alone would leave "Bracers" ambiguous across three sheets.
        el('strong', {}, entry?.name ?? chosen),
        el('span', { class: 'muted' }, entry ? ` ${entry.id}` : ' — not in the index; re-run artgen'),
      ),
    );
  };

  const paintGrid = (): void => {
    if (!index) return;
    const wanted = term.value.trim().toLowerCase();
    const slot = everything.checked ? undefined : slotFilter;
    const matches = index.filter(
      (a) =>
        (!slot || a.slot === slot) &&
        (!wanted || a.id.includes(wanted) || a.name.toLowerCase().includes(wanted) || a.kind.includes(wanted)),
    );

    note.textContent = slot
      ? `${matches.length} for ${slot} — tick to see all ${index.length}`
      : `${matches.length} of ${index.length}`;

    render(grid);
    if (matches.length === 0) {
      grid.append(
        el(
          'p',
          { class: 'empty' },
          slot ? `nothing indexed for ${slot} — tick “every slot” to see the rest` : 'no sheet matches that',
        ),
      );
      return;
    }
    for (const entry of matches) {
      const tile = el(
        'button',
        {
          type: 'button',
          class: entry.id === chosen ? 'art-tile chosen' : 'art-tile',
          // The authors are in here rather than on the tile because attribution is mandatory under
          // CC-BY-SA and an operator picking art should be able to see whose it is without leaving
          // the panel — but a credit line under every tile would treble the grid's height.
          title: `${entry.name} — ${entry.id}\n${entry.kind}${entry.slot ? ` · ${entry.slot}` : ''}\n${entry.authors.join(', ')}`,
        },
        artThumb(entry.sheet, 1),
        el('span', { class: 'art-label' }, entry.name),
      );
      tile.addEventListener('click', () => {
        chosen = entry.id;
        paintCurrent();
        paintGrid();
        options.onPick?.(chosen);
      });
      grid.append(tile);
    }
  };

  const load = async (): Promise<void> => {
    const result = await call<ArtBody>('GET', '/art');
    if (!result.ok || !result.body) {
      note.textContent = result.error ?? 'could not read the art index';
      return;
    }
    index = result.body.art;
    // The current selection may only now be nameable — the row was painted before the index arrived.
    paintCurrent();
    paintGrid();
  };

  choose.addEventListener('click', () => {
    const showing = browser.style.display !== 'none';
    browser.style.display = showing ? 'none' : '';
    choose.textContent = showing ? 'Choose art…' : 'Close';
    if (showing) return;
    // **Fetched on first open, not on mount.** The editor opens on every row click and the great
    // majority of those are not about art; loading the index eagerly would put a request behind
    // every click in a 16,421-row catalogue to serve the handful that reach for the picker.
    loading ??= load();
    void loading;
  });

  clearBtn.addEventListener('click', () => {
    chosen = undefined;
    paintCurrent();
    paintGrid();
    options.onPick?.(undefined);
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  term.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(paintGrid, 120);
  });
  everything.addEventListener('change', paintGrid);

  render(
    browser,
    el(
      'div',
      { class: 'row' },
      term,
      el('label', { class: 'art-all' }, everything, 'every slot'),
      note,
    ),
    grid,
  );

  paintCurrent();

  return {
    node: el('div', { class: 'art-picker' }, el('div', { class: 'row' }, current, choose, clearBtn), browser),
    value: () => chosen,
    set: (id: string | undefined) => {
      chosen = id;
      paintCurrent();
      paintGrid();
    },
    setSlot: (slot: string | undefined) => {
      slotFilter = slot;
      paintGrid();
    },
  };
}
