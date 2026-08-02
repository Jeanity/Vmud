/**
 * The target menu — click a body, get its verbs. Track V's V2, owner-requested.
 *
 * **The point is identity, not convenience.** A room can hold three members of the Court Patrol, and
 * `kill patrol` is ambiguous by construction: the parser picks one and nothing on screen says which.
 * Since Phase 14c those three also *move*, so "the one on the left" stops being a description a
 * second after you make it. Clicking is the only way to say *that* one, and the menu's header — the
 * name of what you clicked — is the confirmation that you picked what you meant.
 *
 * Plain DOM, like the log and the combat feed: buttons, focus and text are the browser's job, and it
 * survives anything going wrong inside the canvas. It is presentation only — every verb sends an
 * intent the game already has, with the target resolved to an id, and the server applies exactly the
 * gate and the visibility rule a typed word would have met.
 */

/** One row. `danger` is for the verb you would not want to hit by accident. */
export interface TargetVerb {
  readonly label: string;
  readonly danger?: boolean;
  readonly run: () => void;
}

export class TargetMenu {
  private readonly root: HTMLElement;
  /** What is currently on offer, so a caller can ask whether the click it just saw was ours. */
  private open = false;

  constructor() {
    const root = document.getElementById('target-menu');
    if (!root) throw new Error('target-menu element missing from index.html');
    this.root = root;

    // Anywhere else closes it. This catches the rest of the page — the panels, the log, the bars.
    document.addEventListener('pointerdown', (event) => {
      const target = event.target as Node;
      if (this.root.contains(target)) return;
      // **Except the canvas, and this exception is load-bearing.** Phaser dispatches its pointer
      // handling synchronously inside this same DOM event, so the order is: canvas listener runs,
      // the scene opens the menu, the event bubbles here, and this closes it again microseconds
      // later. The menu appeared to do nothing at all. The scene is already the owner of that case
      // — `onPointerDown` closes any open menu before deciding whether to open a new one — so
      // deferring to it costs nothing and is the only ordering that works.
      if (target instanceof HTMLCanvasElement) return;
      this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Shows the verbs for one body at a point on the stage.
   *
   * `x`/`y` are canvas pixels, which are stage pixels — `#game` is `inset: 0` of `#stage`, so the
   * two coordinate systems are the same one and the menu lands on the thing that was clicked.
   */
  show(x: number, y: number, who: string, verbs: readonly TargetVerb[]): void {
    if (verbs.length === 0) return;
    this.root.replaceChildren();

    const title = document.createElement('b');
    title.className = 'who';
    title.textContent = who;
    this.root.append(title);

    for (const verb of verbs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = verb.label;
      if (verb.danger) button.className = 'danger';
      // `click` rather than `pointerdown`, so the document-level closer above has already run and a
      // press that slides off the button does nothing — which is what a menu should do.
      button.addEventListener('click', () => {
        this.close();
        verb.run();
      });
      this.root.append(button);
    }

    this.root.hidden = false;
    this.open = true;

    // Placed after unhiding, because a hidden element measures zero and would be nudged by an
    // offscreen test that always passed. Kept inside the stage on both axes: a menu opened on the
    // right-hand edge should not be the one thing you cannot read.
    const stage = this.root.parentElement;
    const width = this.root.offsetWidth;
    const height = this.root.offsetHeight;
    const maxX = (stage?.clientWidth ?? width) - width - 4;
    const maxY = (stage?.clientHeight ?? height) - height - 4;
    this.root.style.left = `${Math.max(4, Math.min(x + 6, maxX))}px`;
    this.root.style.top = `${Math.max(4, Math.min(y + 6, maxY))}px`;
  }

  close(): void {
    if (!this.open) return;
    this.root.hidden = true;
    this.root.replaceChildren();
    this.open = false;
  }
}
