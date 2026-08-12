/**
 * Keyboard to intent — `scene.ts:4423–4444`, re-expressed without Phaser.
 *
 * The mapping is unchanged: WASD and the arrows steer, **Shift** turns the same four keys into a
 * single-room `move`, and Q/E take a staircase without a modifier. The reason Shift is required on
 * the compass keys and not on the vertical ones is in the original and still holds — *"Shift is what
 * says 'step through the exit' rather than 'glide that way'… Up and down have no unmodified meaning
 * to disambiguate from, and demanding a modifier for them was friction with nothing on the other
 * side of it."*
 *
 * ## Both of `CLAUDE.md`'s Phaser input traps, and what happens to them here
 *
 * **(a) Key capture eating characters out of text inputs** is a Phaser-specific hazard: its manager
 * calls `preventDefault()` in a document-level listener that runs before the keystroke reaches a
 * focused `<input>`, which is how `help` once arrived as `hlp`. There is no Phaser here, so the trap
 * does not exist — but the *discipline* it taught does, and this listener refuses to touch a
 * keystroke aimed at a form control at all: no read, and above all no `preventDefault`.
 *
 * **(b) `JustDown` polled in `update` losing chords and short taps** is not Phaser-specific and the
 * fix carries over exactly. A travel step is decided **on the `keydown` event**, reading
 * `event.shiftKey` off the event itself: the modifier state at the moment of the press is what the
 * player meant, and there is no stored edge to fire a frame late. `event.repeat` is dropped, because
 * holding Shift+W should walk one room and not the length of the zone.
 */

import { normaliseIntent, type Direction } from '@mygame/shared';

/** `KeyboardEvent.code` rather than `key`, so a held modifier cannot change which key was pressed. */
const STEER: Readonly<Record<string, readonly [x: number, y: number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/** `[direction, whether Shift is required]` — the `TRAVEL_KEYS` table, same shape, same reasons. */
const TRAVEL: Readonly<Record<string, readonly [dir: Direction, needsShift: boolean]>> = {
  KeyW: ['north', true],
  ArrowUp: ['north', true],
  KeyS: ['south', true],
  ArrowDown: ['south', true],
  KeyA: ['west', true],
  ArrowLeft: ['west', true],
  KeyD: ['east', true],
  ArrowRight: ['east', true],
  KeyQ: ['up', false],
  KeyE: ['down', false],
};

function intoFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

export class Input {
  private readonly held = new Set<string>();
  /**
   * Raised while the caret is in the command line **or** the login card is up.
   *
   * Composed by `main.ts` from both sources, exactly as the Phaser client composes its typing gate,
   * because either source alone clearing it would re-arm the keyboard while the other still needs it
   * off.
   */
  typing = false;
  onTravel: ((dir: Direction) => void) | undefined;
  /** Raised on any movement key's press edge — what takes the wheel back from a server-walked path. */
  onManual: (() => void) | undefined;

  attach(): void {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    // A key held while the tab loses focus never sends its `keyup`, so the character walks into a
    // wall until you come back and press it again.
    window.addEventListener('blur', this.clear);
  }

  detach(): void {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.clear);
    this.held.clear();
  }

  /**
   * The steering intent this frame, normalised.
   *
   * Zero while Shift is held: gliding and stepping at once would walk the character back out of the
   * room it just entered.
   */
  intent(): { x: number; y: number } {
    if (this.typing) return { x: 0, y: 0 };
    if (this.held.has('ShiftLeft') || this.held.has('ShiftRight')) return { x: 0, y: 0 };
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      const step = STEER[code];
      if (!step) continue;
      dx += step[0];
      dy += step[1];
    }
    return normaliseIntent(dx, dy);
  }

  private readonly down = (event: KeyboardEvent): void => {
    if (this.typing || intoFormControl(event.target)) return;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.held.add(event.code);
      return;
    }
    if (event.code in STEER) event.preventDefault();
    const wasSteering = STEER[event.code] !== undefined;
    if (wasSteering && !this.held.has(event.code)) this.onManual?.();
    this.held.add(event.code);
    if (event.repeat) return;
    const travel = TRAVEL[event.code];
    if (travel && (!travel[1] || event.shiftKey)) this.onTravel?.(travel[0]);
  };

  private readonly up = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly clear = (): void => {
    this.held.clear();
  };
}
