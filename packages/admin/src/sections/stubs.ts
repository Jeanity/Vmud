/**
 * A section whose game system does not exist yet.
 *
 * It says what it will be, names what unblocks it, and does nothing — the inventory drawer's rule.
 * A dead form pretending to edit quests would be worse than this in every way that matters.
 *
 * **No section uses it as of A7q**, and that is the good outcome rather than dead code: Quests was the
 * last stub in the panel, and it stopped being one when Phase 21 built the mechanism it was waiting
 * for. Kept because the rule at the top of this comment is `DESIGN-admin-panel.md` §5's, not this
 * file's — the next section whose system lands after its tab does will want exactly this.
 */

import { el, render } from '../dom.ts';

export function stubSection(
  slug: string,
  title: string,
  waits: string,
  paragraphs: string[],
): {
  slug: string;
  title: string;
  waits: string;
  mount(root: HTMLElement): void;
} {
  return {
    slug,
    title,
    waits,
    mount(root: HTMLElement): void {
      render(
        root,
        el('h2', {}, title),
        el('p', { class: 'note' }, `Waiting on: ${waits}.`),
        ...paragraphs.map((text) => el('p', { class: 'note' }, text)),
      );
    },
  };
}
