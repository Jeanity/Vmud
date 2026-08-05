/**
 * The card that says where you have arrived — **V5**.
 *
 * `ROADMAP.md`: *"Crossing into a new Place is currently a change of floor tiles. A brief title card
 * — zone name, level — gives travel the sense of arrival every MUD gets from its room header line."*
 * That is the whole of it, and the second half of the Seen-when is the part that shapes the code:
 * *"then gets out of the way."*
 *
 * ## Ambient, which is a different thing from transient
 *
 * `AnnounceBanner` is also temporary, and the two are not the same job. An announcement is **addressed
 * to you** and arrives without warning, so it dwells nine seconds and is mirrored into the log where it
 * can be found afterwards. An arrival card is **a caption on something you just did deliberately** —
 * you pressed a direction and the floor changed — so it is short, and it is *not* mirrored, because
 * the log already carries the line `announceArrival` writes. Duplicating it would make one keystroke
 * produce the same sentence twice on one screen.
 *
 * ## It must never take a click
 *
 * `pointer-events: none`, for the reason `#announce` has it: the card sits over the middle of the map,
 * which is exactly where the ground somebody is trying to click to walk to. A caption that has to be
 * waited out before you can move is worse than no caption.
 *
 * ## Replaced, never queued
 *
 * The same rule the banner keeps, and it matters more here: a staircase is three Places in four
 * seconds, and a queue would show the bottom of the stairs while you stood at the top.
 */

/** How long a card stays up. Short — you asked for this by walking, and you already know why. */
const DWELL_MS = 2600;

export class ArrivalCard {
  private readonly node: HTMLElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const node = document.getElementById('arrival');
    if (!node) throw new Error('arrival element missing from index.html');
    this.node = node;
    this.title = document.createElement('strong');
    this.detail = document.createElement('span');
    // **Replaced, not appended.** Constructing twice over one element would otherwise leave two pairs
    // of children in it, and every later write would land on the second pair while the first sat
    // there empty and visible. Only one card is built in practice; making the constructor idempotent
    // costs a word and removes a way for that to stop being true.
    this.node.replaceChildren(this.title, this.detail);
  }

  /**
   * Shows one arrival.
   *
   * `level` is omitted when the zone has only one, because *"level 0"* under the name of a place with
   * no other floors is not information, it is furniture. The client can answer that itself: it holds
   * the whole `Zone`, so the distinct `z` values of its rooms are the count.
   */
  show(zoneName: string, level: number, levels: number): void {
    this.title.textContent = zoneName;
    this.detail.textContent = levels > 1 ? `level ${level}` : '';
    this.node.hidden = false;
    // Restarted rather than stacked, so walking through three Places leaves the last one on screen
    // for its full time rather than the first one's clock ending all three.
    if (this.timer) clearTimeout(this.timer);
    // Re-triggering the animation needs the class off and a reflow between, or a second arrival
    // inside the dwell shows no fade at all.
    this.node.classList.remove('showing');
    void this.node.offsetWidth;
    this.node.classList.add('showing');
    this.timer = setTimeout(() => {
      this.node.classList.remove('showing');
      // Hidden only after the fade has run, so `hidden` cannot cut the transition short.
      this.timer = setTimeout(() => {
        this.node.hidden = true;
      }, 400);
    }, DWELL_MS);
  }
}
