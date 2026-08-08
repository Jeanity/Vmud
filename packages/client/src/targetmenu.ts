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
  /** What the row does. Absent only on a row that opens a {@link TargetVerb.submenu} instead. */
  readonly run?: () => void;
  /**
   * Rows this one opens rather than acting itself — the caster's spell list.
   *
   * **A group that expands in place, not a flyout.** A flyout is a second rectangle, and it brings a
   * second copy of every problem this class already solved once: where it goes, how it is kept inside
   * the stage, and what happens when the pointer crosses the gap between the two. An indented group
   * needs none of that, because the thing that grows is the menu already being clamped. The one cost
   * is that the menu changes height under the pointer, which is why {@link place} runs again on every
   * toggle rather than only at {@link show}.
   */
  readonly submenu?: readonly TargetVerb[];
}

export class TargetMenu {
  private readonly root: HTMLElement;
  /** What is currently on offer, so a caller can ask whether the click it just saw was ours. */
  private open = false;
  /** Where {@link show} was asked to put it, kept because a submenu toggle has to clamp again. */
  private anchorX = 0;
  private anchorY = 0;

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

    this.root.append(...this.rowsFor(verbs));

    this.root.hidden = false;
    this.open = true;

    // Placed after unhiding, because a hidden element measures zero and would be nudged by an
    // offscreen test that always passed.
    this.place(x, y);
  }

  /**
   * One level of rows, and recursive because a submenu is a list of exactly the same thing.
   *
   * A row with a submenu carries the marker in its own text rather than in a pseudo-element: the
   * arrow is what says this row *opens* instead of acting, so it belongs to the label, and a `::after`
   * would put the one piece of that meaning in the stylesheet.
   */
  private rowsFor(verbs: readonly TargetVerb[]): HTMLElement[] {
    const nodes: HTMLElement[] = [];
    for (const verb of verbs) {
      const button = document.createElement('button');
      button.type = 'button';
      if (verb.danger) button.className = 'danger';

      const children = verb.submenu ?? [];
      if (children.length > 0) {
        const group = document.createElement('div');
        group.className = 'group';
        group.hidden = true;
        group.append(...this.rowsFor(children));
        const mark = (): void => {
          button.textContent = `${verb.label} ${group.hidden ? '▸' : '▾'}`;
          button.setAttribute('aria-expanded', String(!group.hidden));
        };
        mark();
        // Opening a group is not choosing a verb, so this one press does **not** close the menu —
        // the only row in here that leaves it standing, and the reason it cannot share the handler
        // below. Re-clamped after the toggle: a spell list opened near the bottom of the stage grows
        // straight off it, and the rows you opened it for are the ones that fall past the edge.
        button.addEventListener('click', () => {
          group.hidden = !group.hidden;
          mark();
          this.place(this.anchorX, this.anchorY);
        });
        nodes.push(button, group);
        continue;
      }

      button.textContent = verb.label;
      // `click` rather than `pointerdown`, so the document-level closer above has already run and a
      // press that slides off the button does nothing — which is what a menu should do.
      button.addEventListener('click', () => {
        this.close();
        verb.run?.();
      });
      nodes.push(button);
    }
    return nodes;
  }

  /**
   * Pins the menu near a point and keeps it inside the stage on both axes — a menu opened on the
   * right-hand edge should not be the one thing you cannot read.
   *
   * Measures rather than assumes, so it is correct at whatever height the menu currently is; the
   * anchor is stored because a submenu toggle has to ask the same question again about a taller box.
   */
  private place(x: number, y: number): void {
    this.anchorX = x;
    this.anchorY = y;
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
