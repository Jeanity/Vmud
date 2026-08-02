/**
 * A section whose game system does not exist yet.
 *
 * It says what it will be, names what unblocks it, and does nothing — the inventory drawer's rule.
 * A dead form pretending to edit quests would be worse than this in every way that matters.
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
