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

import { formatArtId, parseArtId, splitRamp } from '@mygame/shared';

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
  /** **A7e** — the ramps this sheet may be recoloured into, or absent if it may not be. */
  readonly recolours?: { readonly material: string; readonly base: string; readonly ramps: readonly string[] };
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
  /** **A7f** — the item this picker is editing. Absent on the New-item form, which has no vnum yet. */
  readonly vnum?: number;
}

/**
 * The model to ask, if any is installed — **A7f**, looked up once per tab.
 *
 * **No dropdown, and that is the point.** The name-matching half needs no model at all and answers most
 * items, so a model *chooser* beside the colour control would be a decision an operator has to make
 * before finding out whether one is even needed. This asks the server what is installed the first time
 * somebody presses Suggest, sends the first one, and sends nothing when Ollama is not running — which
 * degrades to the deterministic half rather than to an error.
 *
 * A room-prose draft still has its own chooser, and rightly: which model writes your world's prose is a
 * real choice. Which model picks between *red* and *maroon* is not.
 */
let modelLookup: Promise<{ model?: string }> | undefined;
async function preferredModel(): Promise<{ model?: string }> {
  modelLookup ??= (async () => {
    const result = await call<{ models?: { name: string; size?: number }[] }>('GET', '/ollama');
    const installed = result.body?.models ?? [];
    // **Base models are skipped, and a drive is why.** `qwen2.5-coder:1.5b-base` answered the colour
    // question with prose that named no ramp, because a base model completes text and does not follow
    // *“reply with exactly one word”* — instruction-following is what the instruct tune adds. The closed
    // list caught it and the suggestion came back empty, which is the right failure but a wasted 13 s.
    //
    // **Then the smallest**, which is the opposite of what a prose draft wants and right for the same
    // reason: this is a one-word classification over a list that is already in the prompt, so there is
    // nothing for a larger model to be better at — and the first call pays a cold start measured at
    // **67 s for an 8B against 13 s for a 1.5B**. Warm, both are under a second.
    const usable = installed.filter((m) => !/[-:]base/.test(m.name));
    const smallest = [...usable].sort((a, b) => (a.size ?? Infinity) - (b.size ?? Infinity))[0];
    return smallest ? { model: smallest.name } : {};
  })();
  return modelLookup;
}

/**
 * A 64×64 window onto a staged sheet, showing the south-facing standing frame.
 *
 * Served from `/lpc/<sheet>.png` on the panel's own origin — the game server, through the Vite proxy
 * — so this is a plain `<img>`-less div with a background and needs neither auth nor a canvas. See
 * `server/src/art.ts` for why the sheets come from there rather than from the client's port.
 */
/**
 * Whether an entry is an **overlay** — art that is meaningless on its own.
 *
 * ULPC splits a lot of gear into a base and the things painted on top of it: `cape_trim` is the hem
 * of a cloak, `shield_pattern` is a heraldic device with no shield under it, `hat_trim` is a band.
 * Chosen alone they draw a few dozen pixels somewhere unexpected and read, entirely reasonably, as
 * the renderer being broken.
 *
 * **This is not hypothetical.** The owner picked `cape-trim` for a hooded black cape on 2026-08-05,
 * reported it as *"sitting around his feet instead of shoulders"* and then, after a real layering bug
 * had been fixed, as *"no visible cape from any angle"* — both accurate, and neither a bug. Its whole
 * content is about thirty pixels along the ankles. The index holds **71 more like it**: 48
 * `shield_pattern`, 13 `hat_trim`, 4 `shield_trim`, 3 `jacket_trim`, 3 `hat_overlay` and 2
 * `shield_paint`.
 *
 * A suffix test on ULPC's own `type_name` rather than a list of the seventy-one, because the pack
 * names them consistently and a hand-kept list would be one re-index away from being wrong.
 */
export function isOverlayArt(kind: string): boolean {
  return /_(trim|paint|pattern|overlay)$/.test(kind);
}

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
  // **A7e: the id and the ramp are held apart and joined only on the way out.** An `art` value is
  // `cape-solid#cloth_ulpc.red`, but a picker that stored that string would have to re-split it on every
  // repaint and on every slot change — and the two halves are chosen by two different controls.
  const opened = parseArtId(options.value ?? '');
  let chosen = options.value === undefined ? undefined : opened.id;
  let ramp = opened.ramp;
  let slotFilter = options.slot;

  const current = el('div', { class: 'art-current' });
  const choose = el('button', { type: 'button' }, 'Choose art…') as HTMLButtonElement;
  const clearBtn = el('button', { type: 'button' }, 'None') as HTMLButtonElement;
  const browser = el('div', { class: 'art-browser', style: 'display:none' });
  const rampRow = el('div', { class: 'row' });
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
        // **Three states, not two.** The index is fetched on the chooser's first open, so before that
        // there is no entry for *anything* — and saying "not in the index; re-run artgen" about a
        // perfectly good id, on every editor opened, is the panel lying about the operator's data.
        // Silence until we actually know: `index` undefined means unasked, not absent.
        el(
          'span',
          { class: 'muted' },
          entry ? ` ${entry.id}` : index ? ' — not in the index; re-run artgen' : '',
        ),
        // **Said again after the choice, not only before it.** The tile's mark is easy to miss while
        // scanning a grid, and this is the line an operator reads when they come back wondering why
        // the cloak they picked is invisible. It names the fix rather than only the fault.
        entry && isOverlayArt(entry.kind)
          ? el('span', { class: 'art-warn' }, `⚠ overlay — layers over a base piece; on its own it draws almost nothing`)
          : null,
      ),
    );
  };

  /**
   * The colour control — **A7e**, owner's ask 2026-08-05: *"if I need a fiery red cloak I can select the
   * black one and change the colors."*
   *
   * **Shown only for art that can actually take one.** 168 of the 346 indexed sheets declare no
   * `recolors`, and offering a dropdown that silently does nothing is worse than offering none — the
   * roadmap's point (3), and the reason the index carries the field rather than the panel guessing.
   *
   * The ramps are named `table.name` because that is what they are, and the label says the family out
   * loud: an operator picking *red* wants to know whether they are getting cloth's red or metal's, and
   * the same word means two quite different things across the pack's twelve tables.
   */
  const paintRamps = (): void => {
    const entry = chosen === undefined ? undefined : index?.find((a) => a.id === chosen);
    render(rampRow);
    if (!entry?.recolours) {
      // Nothing said when there is nothing to offer. A line reading *"this cannot be recoloured"* on 178
      // of 346 sheets would be noise on the commonest case rather than information.
      ramp = undefined;
      return;
    }
    const select = el('select', {}, el('option', { value: '' }, `original — ${entry.recolours.base}`)) as HTMLSelectElement;
    for (const option of entry.recolours.ramps) {
      const parts = splitRamp(option);
      select.append(
        el(
          'option',
          { value: option, ...(ramp === option ? { selected: true } : {}) },
          parts ? `${parts.name} (${parts.table.replace('_', ' ')})` : option,
        ),
      );
    }
    select.addEventListener('change', () => {
      ramp = select.value || undefined;
      options.onPick?.(formatArtId(chosen!, ramp));
    });
    // **A7f: Suggest, beside the dropdown it fills in.** §8's rule made visible — it proposes into the
    // control an operator was already looking at, so keeping the suggestion costs a Save and dropping it
    // costs nothing at all. Offered only when the picker was given a vnum, because the server reads the
    // item's own name to answer and a New-item form has no vnum to read.
    const flash = el('span', { class: 'muted' }, `${entry.recolours.ramps.length} ramps`);
    const suggest = el('button', { type: 'button' }, 'Suggest') as HTMLButtonElement;
    suggest.addEventListener('click', () => {
      void (async () => {
        suggest.disabled = true;
        flash.textContent = 'thinking…';
        const answer = await call<{ ramp: string | null; how?: string; because?: string; reason?: string }>(
          'POST',
          `/items/${options.vnum}/colour`,
          // The model is optional by design: the name is tried first and needs nothing installed, so a
          // machine with no Ollama still gets the common case.
          { ...(await preferredModel()) },
        );
        suggest.disabled = false;
        if (!answer.ok || !answer.body) {
          flash.textContent = answer.error ?? 'refused';
          return;
        }
        if (!answer.body.ramp) {
          flash.textContent = answer.body.reason ?? 'nothing suggested itself';
          return;
        }
        select.value = answer.body.ramp;
        ramp = answer.body.ramp;
        options.onPick?.(formatArtId(chosen!, ramp));
        // Says **which half answered**: the builder's own word deserves more trust than a model's guess,
        // and somebody reviewing a run of these wants to tell them apart at a glance.
        flash.textContent = answer.body.how === 'name'
          ? `from the name: “${answer.body.because}”`
          : 'suggested by the model — worth a look';
      })();
    });

    rampRow.append(
      el('label', {}, 'colour'),
      select,
      ...(options.vnum === undefined ? [] : [suggest]),
      flash,
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
      const overlay = isOverlayArt(entry.kind);
      const tile = el(
        'button',
        {
          type: 'button',
          class: `art-tile${entry.id === chosen ? ' chosen' : ''}${overlay ? ' overlay' : ''}`,
          // The authors are in here rather than on the tile because attribution is mandatory under
          // CC-BY-SA and an operator picking art should be able to see whose it is without leaving
          // the panel — but a credit line under every tile would treble the grid's height.
          //
          // The overlay warning goes **first**, because it is the one line that changes whether you
          // want this at all, and a tooltip is read from the top.
          title:
            (overlay ? `An overlay — draws over another piece and shows almost nothing alone.\n\n` : '') +
            `${entry.name} — ${entry.id}\n${entry.kind}${entry.slot ? ` · ${entry.slot}` : ''}\n${entry.authors.join(', ')}`,
        },
        artThumb(entry.sheet, 1),
        el('span', { class: 'art-label' }, entry.name),
        // A corner mark rather than a word in the label: the label is already clipped to one line, and
        // the thing an operator needs is "this one is different", which a glyph carries and a
        // truncated adjective does not.
        overlay ? el('span', { class: 'art-overlay-mark', title: 'overlay' }, '◫') : null,
      );
      tile.addEventListener('click', () => {
        chosen = entry.id;
        // **A ramp belongs to the art it was chosen for.** `cloth_ulpc.red` on a cape means nothing on a
        // steel helm, and carrying it across would either recolour from the wrong base or silently do
        // nothing — so a new picture starts in its own colour.
        ramp = undefined;
        paintCurrent();
        paintRamps();
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
    // A7e: and only now can we know whether it has ramps at all, which is why this is here rather than
    // beside the first `paintCurrent`.
    paintRamps();
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
    ramp = undefined;
    paintCurrent();
    paintRamps();
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

  // **A7e changed when the index is needed, and the old rule had to bend.** It was fetched on the
  // chooser's *first open*, deliberately: the editor opens on every row click in a 16,421-row catalogue
  // and almost none of those are about art. But the colour control is the one thing an operator reaches
  // for *without* re-picking art — the whole ask is "select the black one and change the colours" — and a
  // dropdown that appears only after you open a browser you did not want is a control nobody finds.
  //
  // So: eagerly **only when the item already has art**, which is the case that has ramps to offer. An
  // item with none still costs nothing, and that is the majority the original rule was protecting.
  if (chosen !== undefined) loading ??= load();

  return {
    node: el('div', { class: 'art-picker' }, el('div', { class: 'row' }, current, choose, clearBtn), rampRow, browser),
    // **Joined here and nowhere else**, so an unrecoloured art returns exactly the bare id it always did.
    value: () => (chosen === undefined ? undefined : formatArtId(chosen, ramp)),
    set: (id: string | undefined) => {
      const parsed = parseArtId(id ?? '');
      chosen = id === undefined ? undefined : parsed.id;
      ramp = parsed.ramp;
      paintCurrent();
      paintRamps();
      paintGrid();
    },
    setSlot: (slot: string | undefined) => {
      slotFilter = slot;
      paintGrid();
    },
  };
}
