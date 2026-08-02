/**
 * A text box that can carry colour — the panel's one prose editor.
 *
 * Owner-requested with A5, and deliberately built as a component rather than as part of the room
 * form: **every editor gets this**. Room prose and names now, mob names and item descriptions at A6,
 * quest text at A7, and eventually a name coloured by race or by level. Writing it once means the
 * codes behave identically everywhere, which matters more than it sounds — a palette that inserted
 * `&+R` in one box and `&R` in another would produce two kinds of wrong text in one world.
 *
 * ## Why a palette and not a colour wheel
 *
 * The MUD's palette is **sixteen colours and no more**: eight hues, each in a dim and a bright form,
 * which is what `&+r` against `&+R` means. There is no `#8fd07a` to pick — a wheel would offer
 * millions of colours of which fifteen thousand map onto the same code and the rest map onto
 * nothing. So the control is the palette itself, and picking is unambiguous by construction.
 *
 * ## Why the preview is not optional
 *
 * A colour code you cannot see rendered is a colour code you get wrong. `&+L` reads as "light" and
 * is in fact near-black; `&+y` and `&+Y` differ by one shift key and by a great deal of contrast.
 * The preview below the box renders through the *same* `parseColour` the game client uses, so what
 * is shown here is what the player will see, not an approximation of it.
 */

import { COLOURS, parseColour, stripColour } from '@mygame/shared';

import { el } from './dom.ts';

/** The palette, in the order a person looks for a colour rather than the order the codes fall in. */
const SWATCHES: readonly { readonly code: string; readonly label: string }[] = [
  { code: 'W', label: 'white' },
  { code: 'w', label: 'grey' },
  { code: 'L', label: 'dark grey' },
  { code: 'l', label: 'black' },
  { code: 'R', label: 'red' },
  { code: 'r', label: 'dark red' },
  { code: 'Y', label: 'yellow' },
  { code: 'y', label: 'brown' },
  { code: 'G', label: 'green' },
  { code: 'g', label: 'dark green' },
  { code: 'C', label: 'cyan' },
  { code: 'c', label: 'dark cyan' },
  { code: 'B', label: 'blue' },
  { code: 'b', label: 'dark blue' },
  { code: 'M', label: 'magenta' },
  { code: 'm', label: 'purple' },
];

export interface ColourBox {
  /** The field itself, to be placed in a form. */
  readonly field: HTMLTextAreaElement | HTMLInputElement;
  /** Palette, preview and field together, ready to append. */
  readonly node: HTMLElement;
  /** What is currently typed, codes and all. */
  value(): string;
  /** Replaces the contents and refreshes the preview. */
  set(text: string): void;
}

export interface ColourBoxOptions {
  readonly value: string;
  /** One line for a name, a box for prose. */
  readonly multiline?: boolean;
  readonly rows?: number;
  readonly placeholder?: string;
  /** Raised on every edit, so a form can enable its save button. */
  readonly onInput?: () => void;
}

/**
 * Builds the control.
 *
 * The insertion rule is the part worth stating: with a selection, the swatch **wraps** it and closes
 * with `&N`, because colouring a word you have highlighted is what the gesture obviously means. With
 * no selection it inserts an opening code at the caret and leaves it open, because that is how you
 * start a coloured passage. Both leave the caret somewhere useful — inside the wrap, or after the
 * code — so typing can continue without reaching for the mouse again.
 */
export function colourBox(options: ColourBoxOptions): ColourBox {
  const field = options.multiline
    ? el('textarea', {
        class: 'colour-field',
        rows: String(options.rows ?? 8),
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      })
    : el('input', {
        class: 'colour-field',
        type: 'text',
        ...(options.placeholder ? { placeholder: options.placeholder } : {}),
      });
  field.value = options.value;

  const preview = el('div', { class: 'colour-preview' });

  const refresh = (): void => {
    preview.replaceChildren();
    const text = field.value;
    if (!text.trim()) {
      preview.append(el('span', { class: 'muted' }, 'nothing to preview'));
      return;
    }
    // **Spans, never HTML**, exactly as `client/src/paint.ts` does it: this text is authored by hand
    // and could contain anything, and `parseColour` is a splitter rather than a markup generator.
    for (const span of parseColour(text)) {
      const node = el('span', {}, span.text);
      if (span.colour !== undefined) node.style.color = span.colour;
      preview.append(node);
    }
  };

  const insert = (code: string): void => {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const before = field.value.slice(0, start);
    const selected = field.value.slice(start, end);
    const after = field.value.slice(end);

    if (selected) {
      field.value = `${before}&+${code}${selected}&N${after}`;
      // Caret left around the wrapped text, so it can be re-coloured or extended.
      field.setSelectionRange(start + 3, start + 3 + selected.length);
    } else {
      field.value = `${before}&+${code}${after}`;
      field.setSelectionRange(start + 3, start + 3);
    }
    field.focus();
    refresh();
    options.onInput?.();
  };

  field.addEventListener('input', () => {
    refresh();
    options.onInput?.();
  });

  const palette = el(
    'div',
    { class: 'colour-palette' },
    ...SWATCHES.map((swatch) =>
      el('button', {
        type: 'button',
        class: 'swatch',
        title: `${swatch.label} — &+${swatch.code}`,
        style: `background:${COLOURS[swatch.code] ?? '#000'}`,
        onclick: (event: Event) => {
          event.preventDefault();
          insert(swatch.code);
        },
      }),
    ),
    // Reset is not a colour and does not belong among the swatches: it is what *ends* one, and a
    // passage left open runs until the next code or the end of the line.
    el(
      'button',
      {
        type: 'button',
        class: 'swatch reset',
        title: 'end colour — &N',
        onclick: (event: Event) => {
          event.preventDefault();
          const at = field.selectionStart ?? field.value.length;
          field.value = `${field.value.slice(0, at)}&N${field.value.slice(at)}`;
          field.setSelectionRange(at + 2, at + 2);
          field.focus();
          refresh();
          options.onInput?.();
        },
      },
      '&N',
    ),
    el(
      'button',
      {
        type: 'button',
        class: 'swatch strip',
        title: 'remove every colour code',
        onclick: (event: Event) => {
          event.preventDefault();
          field.value = stripColour(field.value);
          refresh();
          options.onInput?.();
        },
      },
      'clear',
    ),
  );

  refresh();

  return {
    field,
    node: el('div', { class: 'colour-box' }, palette, field, preview),
    value: () => field.value,
    set: (text: string) => {
      field.value = text;
      refresh();
    },
  };
}
