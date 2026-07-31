/**
 * The MUD text log — plain DOM rather than Phaser.
 *
 * Text is the one thing the browser does better than a canvas: selectable, scrollable, screen
 * readable, and free. Keeping it out of the renderer also means it survives anything going wrong
 * inside the game canvas, which is exactly when you most want to read it.
 */

import type { LogChannel } from '@mygame/shared';

const MAX_LINES = 500;

/**
 * The channels this panel can render.
 *
 * `echo` is the one the *server* never sends: it is your own typed line, reflected locally so the
 * scrollback reads as a conversation. Keeping it out of the protocol's {@link LogChannel} is
 * deliberate — nothing on the wire should be able to forge a line that looks like something you
 * typed.
 */
type PanelChannel = LogChannel | 'echo';

/** Typed lines kept for recall with the arrow keys. Deep enough to re-run a walk, not a session. */
const MAX_HISTORY = 50;

/** Whether the log pane was left collapsed. Remembered, like the key card and the fog slider. */
const LOG_STORAGE_KEY = 'mygame.logCollapsed';

export class LogPanel {
  private readonly root: HTMLElement;
  private readonly lines: HTMLElement;
  private readonly status: HTMLElement;
  private readonly entry: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private collapsed = false;

  /**
   * What to do with a submitted line. Set by the caller rather than the panel knowing about the
   * socket — this file owns the DOM and nothing else.
   */
  onCommand: ((text: string) => void) | undefined;

  /**
   * Raised when focus enters or leaves the command line.
   *
   * **The game must stop reading the keyboard while this is true**, or typing `west` walks you west
   * while it also sends the command. Phaser listens on the document, so it does not care that the
   * keystroke was aimed at an input; the scene has to be told. This is a notification rather than
   * the panel reaching into the scene, for the same reason `onCommand` is.
   */
  onFocusChange: ((focused: boolean) => void) | undefined;

  /**
   * Raised after the pane is shown or hidden.
   *
   * The map is a canvas sized to a grid column, and Phaser's `Scale.RESIZE` only watches the window —
   * so collapsing this pane widens the map's parent without anything telling the renderer. The caller
   * refreshes the scale manager; this file owns the DOM and nothing else.
   */
  onLayoutChange: (() => void) | undefined;

  /** Previously typed lines, newest last. `historyAt` is where the arrow keys currently sit. */
  private readonly history: string[] = [];
  private historyAt = 0;
  /** What was half-typed before the arrows started walking back, so Down can restore it. */
  private draft = '';
  /**
   * The last line written, and how many times it has been written in a row.
   *
   * Kept so an immediately-repeated line collapses into a counter instead of being appended again.
   * The server has several sentences it will say as often as it is asked — a refused destination is
   * the obvious one, since a held pointer re-asks several times a second and a refusal is answered
   * with a `log` line every time — and 500 lines of buffer is a few seconds of that, which
   * would evict real combat and system text a player had not finished reading. Rate-limiting the
   * *sender* would drop information; counting repeats keeps every one of them and costs one line.
   */
  private lastLine: HTMLElement | undefined;
  private lastKey: string | undefined;
  private lastCount = 0;

  constructor() {
    this.root = must('log');
    this.lines = must('log-lines');
    this.status = must('log-status');
    this.entry = must('log-entry') as HTMLFormElement;
    this.input = must('log-input') as HTMLInputElement;
    must('log-bar').addEventListener('click', () => this.toggle());

    this.entry.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });

    this.input.addEventListener('focus', () => this.onFocusChange?.(true));
    this.input.addEventListener('blur', () => this.onFocusChange?.(false));

    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // Back to the game without sending. The line is left in place, because losing a half-typed
        // command to a stray Escape is the kind of small betrayal people remember.
        this.input.blur();
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        // Claimed here so the arrows recall history instead of moving the caret — and so they never
        // reach the game as steering, which is what they are outside this input.
        event.preventDefault();
        this.recall(event.key === 'ArrowUp' ? -1 : 1);
      }
    });
  }

  /** Puts the caret in the command line, opening the log first if it is collapsed. */
  focusInput(): void {
    if (this.collapsed) this.toggle();
    this.input.focus();
    // To the end, not selecting: focusing a recalled line should let you keep typing it.
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }

  get inputFocused(): boolean {
    return document.activeElement === this.input;
  }

  blurInput(): void {
    this.input.blur();
  }

  private submit(): void {
    const text = this.input.value.trim();
    this.input.value = '';
    this.draft = '';
    if (!text) return;

    // Consecutive duplicates collapse: walking north four times should leave one entry to recall,
    // not four to page past.
    if (this.history[this.history.length - 1] !== text) this.history.push(text);
    while (this.history.length > MAX_HISTORY) this.history.shift();
    this.historyAt = this.history.length;

    // Echoed locally rather than waiting for the server to reflect it. Most commands answer with
    // something, but `say` answers on a different channel and movement answers with a room
    // description, and in both cases the scrollback reads better with your own line above the reply.
    this.write('echo', `> ${text}`);
    this.onCommand?.(text);
  }

  private recall(step: number): void {
    if (this.history.length === 0) return;
    // Stepping off the newest entry restores whatever was being typed before the arrows started.
    if (this.historyAt === this.history.length) this.draft = this.input.value;

    const next = Math.min(this.history.length, Math.max(0, this.historyAt + step));
    this.historyAt = next;
    this.input.value = next === this.history.length ? this.draft : (this.history[next] ?? '');
    const end = this.input.value.length;
    this.input.setSelectionRange(end, end);
  }

  toggle(): void {
    this.setCollapsed(!this.collapsed, true);
  }

  /**
   * Shows or hides the log pane, and remembers the choice.
   *
   * **Two classes, because two things change.** `#log.hidden` is the pane's own business — its body
   * goes away and its bar turns on its side. `#shell.log-hidden` is the *grid's*: the column shrinks
   * to a rail and the map takes the space. Neither is derivable from the other by CSS alone, since a
   * child cannot size its own grid track.
   *
   * The map is a canvas sized to its parent, and Phaser's `Scale.RESIZE` watches the *window* — a grid
   * column changing width raises no window resize at all. So the caller is told, and refreshes it.
   */
  setCollapsed(next: boolean, persist: boolean): void {
    this.collapsed = next;
    this.root.classList.toggle('hidden', this.collapsed);
    document.getElementById('shell')?.classList.toggle('log-hidden', this.collapsed);
    const caret = document.getElementById('log-caret');
    if (caret) caret.textContent = this.collapsed ? '▸' : '◂';
    // A collapsed panel must not keep the keyboard. Otherwise the log slides away, the caret stays
    // where it was, and every key the player presses to walk is silently typed into a hidden box.
    if (this.collapsed) this.input.blur();
    if (persist) {
      try {
        localStorage.setItem(LOG_STORAGE_KEY, this.collapsed ? '1' : '0');
      } catch {
        // Storage disabled. A preference that does not survive a reload beats a crash.
      }
    }
    this.onLayoutChange?.();
  }

  /** Whether the log pane was left collapsed last session. Shown by default — it is the MUD half. */
  static rememberedCollapsed(): boolean {
    try {
      return localStorage.getItem(LOG_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  write(channel: PanelChannel, text: string): void {
    // Stay pinned to the bottom only if the reader is already there, so scrolling back to re-read
    // something isn't yanked away by the next combat round.
    const atBottom =
      this.lines.scrollHeight - this.lines.scrollTop - this.lines.clientHeight < 40;

    const key = `${channel}\n${text}`;
    // `isConnected` rather than trusting the handle: the eviction below can remove the line this
    // still points at, and updating a detached node would silently lose the repeat.
    if (this.lastLine?.isConnected && this.lastKey === key) {
      this.lastCount++;
      this.lastLine.textContent = `${text} (x${this.lastCount})`;
    } else {
      const line = document.createElement('p');
      line.className = `ch-${channel}`;
      line.textContent = text;
      this.lines.append(line);
      this.lastLine = line;
      this.lastKey = key;
      this.lastCount = 1;
    }

    while (this.lines.childElementCount > MAX_LINES) this.lines.firstElementChild?.remove();
    if (atBottom) this.lines.scrollTop = this.lines.scrollHeight;
  }
}

function must(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element;
}
