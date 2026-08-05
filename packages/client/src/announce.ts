/**
 * The operator's banner — V3's second half, and A2's channel finally rendered.
 *
 * A2 took the protocol to 10 to give an administrator a voice of their own: `system` is the
 * *machine* talking — your torch guttering, your rest paying out — and `announce` is a *person*
 * talking to you through the game. The protocol note said in as many words that a client which cannot
 * tell those apart can neither style, filter nor alert on either. Until now this client could tell
 * them apart and did nothing with the difference: both were lines in the same column.
 *
 * ## A mirror, deliberately — and note that V1 chose the opposite
 *
 * The combat feed is a **split**: those lines land in the feed and nowhere else, because a fight is a
 * stream you watch and duplicating it would double the noise at the exact moment there is most of it.
 * An announcement is the other case. The banner is *transient* — it has to be, or it would sit over
 * the world for ever — and an announcement you happened to be looking away for must still be
 * findable afterwards. So it shows here **and** stays in the log, and the log is the record.
 *
 * ## One at a time
 *
 * A second announcement replaces the first rather than queueing behind it. An operator saying two
 * things in a row means the second one; a queue would show a stale line for as long as it took to
 * drain, and the one case that matters most — *"the server restarts in one minute"* after *"in five
 * minutes"* — is exactly where a queue would show the wrong number.
 *
 * Plain DOM beside `LogPanel` and `CombatFeed`, for the reasons those are: text is the browser's job,
 * and this must survive anything going wrong inside the canvas.
 */

import { paint } from './paint.ts';

/**
 * How long a banner stays up.
 *
 * Longer than a speech bubble by a good margin: an announcement is addressed to everyone, arrives
 * without warning, and the reader was by definition doing something else when it landed.
 */
const DWELL_MS = 9000;

export class AnnounceBanner {
  private readonly node: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const node = document.getElementById('announce');
    if (!node) throw new Error('announce element missing from index.html');
    this.node = node;
  }

  show(text: string): void {
    // Cleared before the new one is painted, not after: an announcement arriving 8.9 seconds into the
    // last one's dwell would otherwise be wiped by that one's timer a tenth of a second later.
    if (this.timer) clearTimeout(this.timer);
    // Painted rather than assigned — an operator writes through the same colour box every other
    // authored string in this game goes through, and `&+R` set as text is a literal on screen.
    paint(this.node, text);
    this.node.hidden = false;
    this.timer = setTimeout(() => {
      this.node.hidden = true;
      this.node.replaceChildren();
      this.timer = undefined;
    }, DWELL_MS);
  }
}
