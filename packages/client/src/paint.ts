/**
 * Rendering the MUD's `&+R` colour codes into DOM.
 *
 * Extracted from `log.ts` the moment a second pane needed it: the combat feed carries the fight's own
 * lines, and those are the ones with colour in them. One implementation, so a code that renders in the
 * log cannot render differently three inches to the right.
 *
 * **Spans, never HTML.** Everything through here is untrusted by construction — half of it is other
 * players' `say`, the rest is world prose harvested from third-party files — so the text is only ever
 * set with `textContent` on a node this function made. `parseColour` is a splitter, not a markup
 * generator, and that is the property that makes an injection impossible rather than merely unlikely.
 *
 * A line with no codes takes the plain path and stays one text node, which is most of them.
 */

import { hasColour, parseColour } from '@mygame/shared';

export function paint(line: HTMLElement, text: string): void {
  if (!hasColour(text)) {
    line.textContent = text;
    return;
  }
  line.replaceChildren();
  for (const span of parseColour(text)) {
    if (span.colour === undefined) {
      line.append(document.createTextNode(span.text));
      continue;
    }
    const node = document.createElement('span');
    node.style.color = span.colour;
    node.textContent = span.text;
    line.append(node);
  }
}
