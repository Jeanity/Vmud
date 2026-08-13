/**
 * Which of the three things a keystroke is: a step, a view control, or the start of a command.
 *
 * ## The bug this file exists to close
 *
 * The owner, 2026-08-13, having toggled the follow camera by accident: *"I only found the toggle as I
 * went to open a door and I wasn't in the chat box."* They reached for `open` — the MUD verb — and got
 * a camera mode, because `main.ts` bound **O** as a bare letter.
 *
 * It was not one unlucky letter. The nine this client bound are **T R B F V C O K G**, and every one
 * of them is a verb in the game it is a client for: **o**pen, **k**ill, **g**et, **c**ast and
 * **c**lose, **r**est and **r**emove, **f**lee and **f**ollow, **t**ell, **b**uy and **b**ash,
 * **v**alue. The old mitigation — `input.typing` plus {@link intoFormControl} — only ever covered the
 * case where the caret is *already* in the command line. The owner's case is the other one, and it is
 * the common one: hands on the world, MUD reflex, letter goes to the camera.
 *
 * This is `CLAUDE.md` gotcha 5a's family. There it was Phaser's key capture eating letters out of a
 * focused input; here it is a bare binding eating a letter that never got as far as the input. Same
 * loss, same symptom — *"I typed a word and something else happened"* — and the same root: a letter
 * bound in the world is a letter the game has taken away from the language.
 *
 * ## The rule, in one sentence
 *
 * **Bare keys move or type; Alt keys look.** Nothing bare does anything to the frame any more, so
 * every letter the player presses either walks or lands in the command line, and there is no third
 * outcome to be surprised by.
 *
 * ## Why Alt, and why not the other two
 *
 * - **Ctrl is the browser's own plane and two of the nine are lethal there.** Ctrl+C is copy and
 *   Ctrl+V is paste, over a log panel whose whole point is selectable text; Ctrl+T, Ctrl+R, Ctrl+F,
 *   Ctrl+K, Ctrl+G, Ctrl+B and Ctrl+O are all real Chrome shortcuts, and Ctrl+T and Ctrl+W are
 *   *reserved* — the page never sees them and `preventDefault` cannot reach them. Rejected outright.
 * - **Shift is spoken for twice over, and it is how capitals are typed.** It is already `input.ts`'s
 *   travel modifier (Shift+W is `move north`) and `orbit.ts`'s orbit gesture, and — decisively — the
 *   whole point of this change is that a bare letter starts a command, so `Say hello to Bob` would
 *   fire three toggles before it typed a character. Rejected.
 * - **Alt collides with nothing this game or this browser needs.** It produces no character on a
 *   Windows or Linux layout, so it cannot be confused with typing; the *menu-bar-on-keyup* hazard is a
 *   property of a **lone** Alt press and release, which a chord is not; and Chrome hands Alt chords to
 *   the page before its own menu mnemonics, which is why Google Docs can bind Alt+F, Alt+E, Alt+V,
 *   Alt+O and Alt+T for its own menus in the same browser on the same OS. Every chord below calls
 *   `preventDefault`, which is what keeps Chrome's Alt+F out of the wind toggle.
 *
 * **Ctrl+Alt is AltGr on Windows and produces characters**, so the Ctrl test runs *before* the Alt
 * test and an AltGr keystroke is refused rather than read as a view control.
 *
 * Function keys were the fallback the brief allowed if all three modifiers were bad. They are not
 * needed, and they would have cost the mnemonics — the owner already knows that F is the wind, and
 * "F4 is the wind" is a thing to learn rather than a thing to remember. **F1 is used for exactly one
 * job**, the controls line, because that is the one key in the set whose meaning is already universal.
 *
 * ## Movement is the one exception, and it is the right one
 *
 * W/A/S/D, the four arrows and Q/E do **not** type. Two reasons, and the second is the stronger:
 *
 * 1. The owner walks with them. A W that opened the command line instead of walking would be a worse
 *    bug than the one being fixed.
 * 2. **In a MUD, bare `w` already means "go west".** `n`/`s`/`e`/`w`/`u`/`d` are the movement
 *    abbreviations every Diku descendant has shipped since 1990, so the reflex and the binding agree:
 *    a player who presses W to move is not typing the first letter of a word, they are moving. This is
 *    the one place where the world's claim on a letter matches what the player meant by it.
 *
 * The exception is legible because it is not a list kept here: {@link MOVEMENT_CODES} is built from
 * `input.ts`'s own {@link STEER} and {@link TRAVEL} tables, so a key added to movement stops typing on
 * the same commit and cannot drift.
 *
 * And it costs nothing, because **Enter opens the prompt** — the MUD reflex the 2D client has had
 * since `scene.ts:1514` and this one somehow never got. So `wear cloak` is Enter then the word, and
 * every letter of the alphabet is reachable.
 *
 * ## Both of `CLAUDE.md`'s input traps
 *
 * **(a)** is the whole subject of this file, and it is answered twice: the caret's claim on the
 * keyboard is checked (`typing` *and* {@link intoFormControl}, because either alone re-arms the world
 * while the other still needs it off), and the world no longer claims a bare letter at all.
 *
 * **(b)** — edges lost to polling — carries over as it did in `input.ts`: every decision here is taken
 * on the `keydown` event, reading `altKey` and `shiftKey` off the event itself, so the modifier state
 * at the moment of the press is what the player meant. `repeat` is refused for the nine letters and
 * deliberately allowed for the two brackets, where hold-and-step is the gesture.
 */

import { MOVEMENT_CODES, intoFormControl } from './input.ts';

/**
 * What the world should do with a keystroke.
 *
 * A discriminated union on `t` rather than a set of booleans, because the four outcomes are exclusive
 * and the caller must handle all of them — a fifth added later should not compile until `main.ts` has
 * something to do with it.
 *
 * - `ignore` — not ours. The caret has it, an IME has it, or the browser has it.
 * - `move` — `input.ts`'s business. Named rather than folded into `ignore` so the one exception to
 *   "a bare key types" is a thing the tests can point at.
 * - `view` — an Alt chord that names one of the view controls.
 * - `line` — the command line should take the keyboard. `typed` is the whole first-character
 *   question: see {@link consumesDefault}.
 * - `help` — F1. The controls, into the log.
 */
export type KeyRoute =
  | { readonly t: 'ignore' }
  | { readonly t: 'move' }
  | { readonly t: 'view'; readonly code: string; readonly shift: boolean }
  | { readonly t: 'line'; readonly typed: boolean }
  | { readonly t: 'help' };

/**
 * The fields {@link route} reads off a `KeyboardEvent`, and nothing else.
 *
 * Structural rather than the DOM type so a test can pass a plain object — the same trick
 * `input.test.ts` plays with its `keydown` helper, and the reason the routing can be swept without a
 * headless browser.
 */
export type KeyPress = {
  readonly code: string;
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing?: boolean;
  readonly target?: EventTarget | null;
};

/**
 * `[code, how the key is written, what it does]` — the view controls, and the F1 line's source.
 *
 * **One table, two readers.** {@link route} asks it whether a code is a view control and
 * {@link CONTROLS} spells it out for the player, so a key that changes here changes in the help text
 * on the same line and the two cannot disagree. The owner found **O** by accident and had no list;
 * a list that can rot is how they would come to have a wrong one instead.
 *
 * By `code`, not by `key`, for the reason the brackets were already `code`: the physical position is
 * the same on every layout, and with Alt held on macOS `event.key` for Option+O is `ø` while `code`
 * is still `KeyO`.
 */
const VIEW: readonly (readonly [code: string, key: string, what: string])[] = [
  ['KeyO', 'O', 'camera behind you'],
  ['KeyC', 'C', 'camera home, facing north'],
  ['KeyK', 'K', 'roof cull'],
  ['KeyT', 'T', 'tone mapping'],
  ['KeyR', 'R', 'weather  (+shift: back to the world’s)'],
  ['KeyB', 'B', 'bloom'],
  ['KeyF', 'F', 'wind'],
  ['KeyV', 'V', 'warp'],
  ['KeyG', 'G', 'day/night  (+shift: back to the world’s clock)'],
  ['BracketLeft', '[', 'an hour back'],
  ['BracketRight', ']', 'an hour on'],
];

const VIEW_CODES: ReadonlySet<string> = new Set(VIEW.map(([code]) => code));

/**
 * The two chords where auto-repeat is the feature rather than a misfire.
 *
 * Sweeping the hour is *hold and step* — the gesture `main.ts` describes as wanting a position rather
 * than a character — so the brackets read every repeat. The nine letters are toggles, and a toggle
 * that repeats at the keyboard's rate is a strobe.
 */
const REPEATS: ReadonlySet<string> = new Set(['BracketLeft', 'BracketRight']);

/** Frozen singletons for the routes that carry no payload — nothing allocates on a keystroke. */
const IGNORE: KeyRoute = { t: 'ignore' };
const MOVE: KeyRoute = { t: 'move' };
const HELP: KeyRoute = { t: 'help' };
const LINE_TYPED: KeyRoute = { t: 'line', typed: true };
const LINE_EMPTY: KeyRoute = { t: 'line', typed: false };

/**
 * Where a keystroke goes. Pure — the caller owns the DOM and the state.
 *
 * The order of the tests is the specification and every one of them is load-bearing:
 *
 * 1. **The caret's claim comes first**, both halves of it, or this listener would eat a letter out of
 *    the command line and the loss would read as a dropped keystroke rather than as a binding.
 * 2. **A composition is not ours.** An IME assembling a character sends `keydown` with
 *    `isComposing` raised and `key` as `Process`; reading it would take the keyboard away from the
 *    composition mid-word.
 * 3. **Ctrl and Meta before Alt**, because Ctrl+Alt is AltGr and AltGr types.
 * 4. **Alt is the view plane** — and an Alt chord that names nothing is left alone rather than
 *    swallowed, so Alt+Left is still Back and Alt+Tab is still the window switcher.
 * 5. **Movement before printable**, which is the one exception and the reason it is one line.
 * 6. **Enter, then F1, then anything printable.** Space is deliberately not printable enough to open
 *    the prompt: it contributes nothing to a command and people press it idly, and losing the world's
 *    keyboard to an idle thumb is the same surprise this file exists to delete.
 */
export function route(event: KeyPress, typing: boolean): KeyRoute {
  if (typing || intoFormControl(event.target ?? null)) return IGNORE;
  if (event.isComposing) return IGNORE;
  if (event.ctrlKey || event.metaKey) return IGNORE;
  if (event.altKey) {
    if (!VIEW_CODES.has(event.code)) return IGNORE;
    if (event.repeat && !REPEATS.has(event.code)) return IGNORE;
    return { t: 'view', code: event.code, shift: event.shiftKey };
  }
  if (MOVEMENT_CODES.has(event.code)) return MOVE;
  if (event.key === 'Enter') return LINE_EMPTY;
  if (event.key === 'F1') return HELP;
  if (event.key.length === 1 && event.key !== ' ') return LINE_TYPED;
  return IGNORE;
}

/**
 * Whether the caller must call `preventDefault` — **and the one place the first character is saved.**
 *
 * The classic version of this bug is not the binding, it is the fix for the binding: focus moves to
 * the command line and the letter that asked for it is gone, so `open door` arrives as `pen door` and
 * the player learns to type the first letter twice. It happens when the handler calls
 * `preventDefault`, because the character is not inserted by the handler — it is inserted by the
 * **default action of the keydown**, which the browser resolves *after* the listener returns and
 * against whatever has focus *then*. Focus the input and leave the default alone and the browser puts
 * the character where the caret now is.
 *
 * So `line` with `typed` raised is the one route that must **not** be prevented, and it is written as
 * a rule with a name rather than as a missing line in a switch, because a missing line is exactly what
 * a later edit adds back.
 *
 * *(Measured, not assumed: probed in Chrome on 2026-08-13 by focusing an input inside a `keydown`
 * listener without preventing it — `o` then `pen door` arrived in the box as `open door`, first
 * character intact.)*
 *
 * Everything else is prevented, and each for its own reason: an Alt chord so Chrome's own Alt+F menu
 * mnemonic stays out of the wind toggle, **F1** so the browser does not open its help in a new tab,
 * and **Enter** because the default action of Enter on a freshly focused input inside a `<form>` is to
 * submit it — which would clear a half-typed line before the player had typed anything at all.
 */
export function consumesDefault(route: KeyRoute): boolean {
  switch (route.t) {
    case 'view':
    case 'help':
      return true;
    case 'line':
      return !route.typed;
    default:
      return false;
  }
}

/**
 * The controls, as one line for the log. **States the modifier**, which is the whole job.
 *
 * Generated from {@link VIEW} so it cannot describe a key that has moved. Kept to a line the owner can
 * read in one breath rather than a panel — the brief's *"discoverability, cheaply"*, and a settings UI
 * for eleven toggles would be more surface than the toggles.
 */
export const CONTROLS: string =
  'controls — typing: any letter starts a command (enter opens the line, esc leaves it); ' +
  'W A S D / arrows walk, shift+them takes the exit named north/south/east/west, Q E take stairs; ' +
  'click the ground to walk there, hold and drag to steer, shift+drag orbits, wheel zooms.  ' +
  `view keys are all ALT+key, so no bare letter is taken from the command line — ${VIEW.map(
    ([, key, what]) => `alt+${key}: ${what}`,
  ).join('   ')}.  F1 says this again.`;

/**
 * The window's `keydown`, routed. One listener, one answer, three callbacks.
 *
 * Shaped like {@link Input} on purpose — `typing` written from outside, `attach`/`detach`, callbacks
 * rather than reaching into the caller — because `main.ts` already composes one boolean for four
 * listeners and this is the fifth. Two listeners on one window that disagree about what counts as
 * typing is the shape `CLAUDE.md` gotcha 5a warns about.
 *
 * The switch bodies stay in `main.ts`, where the renderer, the sky and the camera knob live; what
 * moved here is the *decision*, which is the part that had a bug in it and the part a headless test
 * can reach.
 */
export class KeyRouter {
  /**
   * Raised while the caret is in the command line **or** the login card is up.
   *
   * Written by `main.ts`'s `applyTyping`, from the same two sources as `input.typing`, for the same
   * reason: either source alone clearing it would re-arm the keyboard while the other still needs it
   * off.
   */
  typing = false;

  /** An Alt chord naming one of {@link VIEW}. `shift` is the release half of R and G. */
  onView: ((code: string, shift: boolean) => void) | undefined;
  /** The command line should take the keyboard. Called for Enter and for any printable character. */
  onLine: (() => void) | undefined;
  /** F1. */
  onHelp: (() => void) | undefined;

  attach(): void {
    window.addEventListener('keydown', this.down);
  }

  detach(): void {
    window.removeEventListener('keydown', this.down);
  }

  private readonly down = (event: KeyboardEvent): void => {
    const taken = route(event, this.typing);
    // Before the callback, not after: a handler that threw would otherwise leave the browser's own
    // default running on a chord this client had already claimed.
    if (consumesDefault(taken)) event.preventDefault();
    switch (taken.t) {
      case 'view':
        this.onView?.(taken.code, taken.shift);
        return;
      case 'line':
        this.onLine?.();
        return;
      case 'help':
        this.onHelp?.();
        return;
      default:
        return;
    }
  };
}
