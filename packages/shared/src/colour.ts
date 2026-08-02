/**
 * Coloured text — the MUD's own notation, kept rather than invented.
 *
 * Owner's request, 2026-08-02: *"I just want the ability to add some color to everything."* The
 * useful discovery behind this file is that **the world already has colour and we were throwing it
 * away**: Duris' builders wrote `&+R` / `&n` codes into room names and prose, there are **4,588,357
 * of them across the 447 `.wld` files** (4,199 in IceCrag alone), and `cleanDescription` stripped
 * every one at harvest. So the decision here is not "what markup should we invent" but "stop
 * discarding twenty-five years of authored colour, and let new text use the same vocabulary".
 *
 * ## The notation
 *
 * Four shapes, which is exactly what `duris.ts` already had to recognise in order to strip:
 *
 * - `&n` / `&N` — back to plain.
 * - `&+X` — foreground. **Case is brightness**: `&+r` is a dim red, `&+R` a bright one.
 * - `&-X` — background. Parsed and deliberately **ignored** — see below.
 * - `&=XY` — foreground and background at once. The foreground half is used, the other half is not.
 *
 * ## Two things it does not do, both on purpose
 *
 * **Backgrounds are dropped.** The game renders on a dark parchment ground that the whole palette is
 * tuned against, and a builder's `&-B` from a black-terminal era would produce an unreadable block
 * in the middle of a paragraph. They are parsed so that the *text* around them survives intact,
 * which is the part that matters.
 *
 * **This produces segments, not HTML.** A renderer turns segments into whatever it draws with — the
 * client into spans, a future terminal into ANSI — and nothing here builds markup, because building
 * markup in a shared module is how a text-injection bug gets into two clients at once. The player's
 * own `say` passes through the same pipeline as authored prose, so the parser must never emit
 * anything a caller has to trust.
 */

/** One run of text that shares a colour. `colour` is undefined for plain text. */
export interface ColourSpan {
  readonly text: string;
  /** A CSS colour, already resolved from the code. Undefined means "whatever the channel is". */
  readonly colour?: string;
}

/**
 * The palette, tuned to the game's own dark ground rather than to a 1990s terminal.
 *
 * Lowercase is the muted member of each pair and uppercase the bright one, which is Duris' own
 * convention. `l`/`L` is its black: on a black background a literal black is invisible, so it lands
 * as the two greys the log already uses for de-emphasis — and that matters more than fidelity here,
 * because `&+L` is the **most used colour in the world** after the reset code.
 */
export const COLOURS: Readonly<Record<string, string>> = {
  r: '#a8564a', R: '#e0705e',
  g: '#6f9a5f', G: '#8fd07a',
  b: '#5878a8', B: '#7fa6e0',
  y: '#a8904a', Y: '#e0c46a',
  m: '#9a6394', M: '#d08ac8',
  c: '#5f96a8', C: '#7fc8e0',
  w: '#b8b2a4', W: '#f0ece0',
  l: '#55524a', L: '#7d786c',
};

/**
 * Every code shape, as one expression. The same four the harvest recognises — see `duris.ts`, whose
 * `COLOUR_CODE` this deliberately mirrors so the two cannot drift into disagreeing about what a code
 * is. If a code shape is added here it must be added there, or the join key will keep one.
 */
const CODE = /&(?:[nN]|[+-][A-Za-z]|=[A-Za-z]{2})/g;

/** Whether a string carries any colour at all — for a caller that can skip the work. */
export function hasColour(text: string): boolean {
  CODE.lastIndex = 0;
  return CODE.test(text);
}

/** The text with every code removed. What a log, a search index or a join key wants. */
export function stripColour(text: string): string {
  return text.replace(CODE, '');
}

/**
 * Splits text into coloured runs.
 *
 * An unknown colour letter resolves to no colour rather than to an error or a default: builders
 * across twenty-five years used codes this palette may not list, and the right answer to one is to
 * show the words plainly. Losing a colour is a blemish; losing the sentence is a bug.
 */
export function parseColour(text: string): ColourSpan[] {
  const spans: ColourSpan[] = [];
  let colour: string | undefined;
  let at = 0;

  const push = (chunk: string): void => {
    if (chunk.length === 0) return;
    spans.push(colour === undefined ? { text: chunk } : { text: chunk, colour });
  };

  CODE.lastIndex = 0;
  for (let match = CODE.exec(text); match !== null; match = CODE.exec(text)) {
    push(text.slice(at, match.index));
    at = match.index + match[0].length;

    const code = match[0];
    if (code === '&n' || code === '&N') {
      colour = undefined;
    } else if (code[1] === '+') {
      colour = COLOURS[code[2] ?? ''];
    } else if (code[1] === '=') {
      // Foreground first, background second. Only the first is honoured — see the header.
      colour = COLOURS[code[2] ?? ''];
    }
    // `&-X` is a background on its own: parsed, and the current foreground is left alone.
  }
  push(text.slice(at));
  return spans;
}
