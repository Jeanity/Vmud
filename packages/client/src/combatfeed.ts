/**
 * The combat feed — the fight's own lines, in the character pane below the display controls.
 *
 * Owner-placed and owner-split (2026-08-02, Track V's V1): the rolls used to land in the log,
 * interleaved with room prose and chat, a column away from the fight. They now land **only** here —
 * `scene.ts` routes the `combat` channel away from the log — so the reading rule is spatial: prose
 * and speech on the left, violence on the right. That makes this pane the fight's record, which is
 * why the cap below is generous rather than a ticker's half-dozen.
 *
 * Capped rather than fading: docked text that vanishes on a timer reads as a glitch, so old lines
 * scroll away instead, inside the section's own bounded scroll (`#combat-lines` in the CSS — the
 * sheet body scrolls as a whole, and a long fight must not push the brightness slider off screen).
 *
 * Plain DOM beside `LogPanel` for the same reasons it is: text is the browser's job, and this must
 * survive anything going wrong inside the canvas. The pane this lives in collapses to a rail —
 * the owner's chosen trade; the vitals stay pinned to the map either way.
 */

import { paint } from './paint.ts';

/** How many lines are kept. The whole of a long fight, since nothing else carries them now. */
const MAX_LINES = 150;

export class CombatFeed {
  private readonly lines: HTMLElement;

  constructor() {
    const lines = document.getElementById('combat-lines');
    if (!lines) throw new Error('combat-lines element missing from index.html');
    this.lines = lines;
  }

  push(text: string): void {
    const line = document.createElement('div');
    // Painted, not assigned: these are the lines that *have* colour. `-=[` in green is your blow and
    // in red is one landing on you — Duris' own convention, from `fight.c`'s `dam_message` — and set
    // as text it would read as a literal `&+G` in the middle of every swing.
    paint(line, text);
    this.lines.append(line);
    while (this.lines.children.length > MAX_LINES) this.lines.firstElementChild?.remove();
    // Follow the newest blow. Unconditional: this is a ticker, and the place to study history is
    // the log. Scrolling only-when-at-bottom would leave it stuck mid-fight after one stray wheel.
    this.lines.scrollTop = this.lines.scrollHeight;
  }
}
