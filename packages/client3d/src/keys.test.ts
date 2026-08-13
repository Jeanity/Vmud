/**
 * The keyboard's split — a bare key moves or types, an Alt key looks.
 *
 * Written against the owner's own report (2026-08-13): *"I only found the toggle as I went to open a
 * door and I wasn't in the chat box."* Every property below is a way that sentence could come back:
 *
 * 1. **A bare letter reaches the command line with its first character intact.** The fix for a
 *    swallowed binding is usually a second bug — focus moves and the letter that asked for it is
 *    gone, so `open door` arrives as `pen door`. The character is inserted by the *default action* of
 *    the keydown, resolved after the listener returns against whatever has focus then, so the whole
 *    property reduces to **`preventDefault` must not be called on this one route** — which is what
 *    {@link consumesDefault} says and what these tests pin, including an end-to-end model of the
 *    browser's own insertion.
 * 2. **A letter aimed at the command line is untouched**, by either half of the gate: the composed
 *    `typing` boolean *and* `intoFormControl`. The login card is the second half's real customer.
 * 3. **Every toggle still fires, behind Alt**, with its mnemonic letter and with the shift halves of
 *    R and G intact.
 * 4. **No toggle fires without the modifier** — the actual bug, asserted key by key over all eleven.
 * 5. **Movement is the one bare exception and it still moves.** W/A/S/D, the arrows and Q/E steer and
 *    travel exactly as they did, are never typed, and Shift+W is still `move north`.
 * 6. **The brackets keep the one thing that made them a gesture**: auto-repeat, which the nine
 *    letters still refuse.
 *
 * The `Input` half is driven through the *real* listener on the same fake window, attached in the
 * same order `main.ts` attaches it, because the property "a movement key was not typed" is about two
 * listeners agreeing and not about either table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/* -------------------------------------------------------------------------- */
/* Headless DOM, borrowed from `input.test.ts` and given a class hierarchy     */
/* -------------------------------------------------------------------------- */

/** The listeners `KeyRouter.attach` and `Input.attach` registered, in order. */
const windowListeners = new Map<string, Set<(event: unknown) => void>>();

(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, handler: (event: unknown) => void): void => {
    let held = windowListeners.get(type);
    if (!held) {
      held = new Set();
      windowListeners.set(type, held);
    }
    held.add(handler);
  },
  removeEventListener: (type: string, handler: (event: unknown) => void): void => {
    windowListeners.get(type)?.delete(handler);
  },
};

/**
 * `intoFormControl` is four `instanceof`s, so the stubs have to be a **hierarchy** and not four
 * unrelated classes: its first line is `target instanceof HTMLElement`, and an input that does not
 * inherit from that would be waved through as if it were the canvas. `input.test.ts` only ever needs
 * the `false` branch and declares four empty classes; this file tests the shield, so it needs the
 * `true` one.
 */
class FakeElement {
  isContentEditable = false;
}
class FakeInput extends FakeElement {}
class FakeTextArea extends FakeElement {}
class FakeSelect extends FakeElement {}

const globals = globalThis as unknown as Record<string, unknown>;
globals['HTMLElement'] = FakeElement;
globals['HTMLInputElement'] = FakeInput;
globals['HTMLTextAreaElement'] = FakeTextArea;
globals['HTMLSelectElement'] = FakeSelect;

// Imported *after* the globals exist: `keys.ts` reaches `intoFormControl` at call time, but
// `input.ts` is evaluated on import and a missing `window` there would throw before any test ran.
const { CONTROLS, KeyRouter, consumesDefault, route } = await import('./keys.ts');
const { Input, MOVEMENT_CODES } = await import('./input.ts');

/** As an `EventTarget`, which is what a real `KeyboardEvent.target` is typed as. */
function asTarget(element: FakeElement): EventTarget {
  return element as unknown as EventTarget;
}

/** The command line, as `event.target` sees it once the caret is in it. */
const commandLine = new FakeInput();
/** The login card's account field — `intoFormControl`'s other customer, and the gate's own shield. */
const loginField = new FakeInput();

/* -------------------------------------------------------------------------- */
/* Events                                                                      */
/* -------------------------------------------------------------------------- */

type Press = {
  code: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  target: EventTarget | null;
  defaultPrevented: boolean;
  preventDefault: () => void;
};

/** A `keydown`, with only the fields the router reads and a `defaultPrevented` the tests can read. */
function press(
  code: string,
  init: {
    key?: string;
    alt?: boolean;
    ctrl?: boolean;
    meta?: boolean;
    shift?: boolean;
    repeat?: boolean;
    composing?: boolean;
    target?: EventTarget | null;
  } = {},
): Press {
  const event: Press = {
    code,
    key: init.key ?? keyOf(code, init.shift ?? false),
    altKey: init.alt ?? false,
    ctrlKey: init.ctrl ?? false,
    metaKey: init.meta ?? false,
    shiftKey: init.shift ?? false,
    repeat: init.repeat ?? false,
    isComposing: init.composing ?? false,
    target: init.target ?? null,
    defaultPrevented: false,
    preventDefault: (): void => {
      event.defaultPrevented = true;
    },
  };
  return event;
}

/** What a US layout puts in `event.key` for a code — enough of one for the codes these tests use. */
function keyOf(code: string, shift: boolean): string {
  if (code.startsWith('Key')) {
    const letter = code.slice(3);
    return shift ? letter : letter.toLowerCase();
  }
  if (code.startsWith('Digit')) return code.slice(5);
  switch (code) {
    case 'BracketLeft':
      return shift ? '{' : '[';
    case 'BracketRight':
      return shift ? '}' : ']';
    case 'Space':
      return ' ';
    case 'Quote':
      return shift ? '"' : "'";
    case 'Slash':
      return shift ? '?' : '/';
    default:
      return code;
  }
}

/** The physical key a character comes off on a US layout — the inverse of {@link keyOf}. */
function codeOf(character: string): string {
  if (/[a-z]/i.test(character)) return `Key${character.toUpperCase()}`;
  if (/[0-9]/.test(character)) return `Digit${character}`;
  if (character === ' ') return 'Space';
  return 'Unidentified';
}

/** Through every window `keydown` listener, in registration order, as the browser would. */
function dispatch(event: Press): Press {
  for (const handler of windowListeners.get('keydown') ?? []) handler(event);
  return event;
}

/* -------------------------------------------------------------------------- */
/* A router on a bench, with the callbacks recorded                            */
/* -------------------------------------------------------------------------- */

type Bench = {
  router: InstanceType<typeof KeyRouter>;
  views: { code: string; shift: boolean }[];
  lines: number;
  helps: number;
  done: () => void;
};

function bench(): Bench {
  const router = new KeyRouter();
  const state: Bench = {
    router,
    views: [],
    lines: 0,
    helps: 0,
    done: (): void => router.detach(),
  };
  router.onView = (code, shift) => state.views.push({ code, shift });
  router.onLine = () => {
    state.lines += 1;
  };
  router.onHelp = () => {
    state.helps += 1;
  };
  router.attach();
  return state;
}

/** Every view control, and how it is written in the log — kept beside {@link CONTROLS}'s own table. */
const VIEW_CODES = [
  'KeyO',
  'KeyC',
  'KeyK',
  'KeyT',
  'KeyR',
  'KeyB',
  'KeyF',
  'KeyV',
  'KeyG',
  'BracketLeft',
  'BracketRight',
] as const;

/* -------------------------------------------------------------------------- */
/* 1. A bare letter reaches the command line, first character intact           */
/* -------------------------------------------------------------------------- */

describe('a bare letter opens the command line and does not lose itself doing it', () => {
  it('routes every letter of the alphabet that is not a movement key to the line', () => {
    for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
      const code = codeOf(letter);
      const taken = route(press(code), false);
      if (MOVEMENT_CODES.has(code)) {
        assert.equal(taken.t, 'move', `${letter} is a movement key and must still move`);
        continue;
      }
      assert.deepEqual(taken, { t: 'line', typed: true }, `${letter} should start a command`);
    }
  });

  it('never prevents the default on a typed character — this is the first character, and it is the bug', () => {
    // The whole property in one assertion. The browser inserts the character with the *default
    // action* of the keydown, which it resolves after this listener returns and against whatever has
    // focus then; prevent it and the letter that asked for the command line is the one letter the
    // command line never gets. Measured in Chrome on 2026-08-13: focus inside keydown without
    // preventing it, and `o` then `pen door` arrives in the box as `open door`.
    for (const letter of 'bcfghijlmnoprtuvxyz') {
      const taken = route(press(codeOf(letter)), false);
      assert.equal(consumesDefault(taken), false, `${letter} had its default action taken away`);
    }
  });

  it('leaves the event unprevented through the real listener, not merely in the rule', () => {
    const held = bench();
    const event = dispatch(press('KeyO'));
    assert.equal(held.lines, 1, 'a bare O did not reach the command line');
    assert.equal(held.views.length, 0, 'a bare O still toggled the camera');
    assert.equal(event.defaultPrevented, false, 'the router swallowed the first character');
    held.done();
  });

  it('types `open door` from the world, character for character', () => {
    // The owner's own gesture, modelled end to end with the browser's half of it: a keydown that
    // nobody prevented inserts its character into whatever has focus at that moment, and focusing
    // the input raises `typing` synchronously through `log.onFocusChange` -> `applyTyping`.
    assert.equal(typeFromTheWorld('open door'), 'open door');
    // And the one that started it all: the first character is `o`, and it is not eaten.
    assert.ok(typeFromTheWorld('open door').startsWith('o'), 'the first character was swallowed');
  });

  it('types a line that starts with a digit, a quote or a slash — commands are not only letters', () => {
    assert.equal(route(press('Digit3'), false).t, 'line');
    assert.equal(route(press('Quote'), false).t, 'line');
    assert.equal(route(press('Slash'), false).t, 'line');
    assert.equal(route(press('Slash', { shift: true }), false).t, 'line', '? should type, not toggle');
  });

  it('does not open the line on a space, which contributes nothing and is pressed idly', () => {
    assert.deepEqual(route(press('Space'), false), { t: 'ignore' });
  });

  it('ignores the keys that are not characters at all', () => {
    for (const code of ['Escape', 'Tab', 'Backspace', 'F5', 'ShiftLeft', 'AltLeft', 'ControlLeft']) {
      assert.deepEqual(route(press(code), false), { t: 'ignore' }, `${code} should be nobody's`);
    }
  });

  it('opens the line on Enter, and prevents that one — an unprevented Enter submits the form', () => {
    const held = bench();
    const event = dispatch(press('Enter'));
    assert.equal(held.lines, 1, 'Enter did not open the prompt');
    assert.equal(
      event.defaultPrevented,
      true,
      'Enter was left to its default, which submits the freshly focused form and clears the line',
    );
    held.done();
  });
});

/**
 * The world's keyboard and the browser's insertion, together.
 *
 * `focused` stands in for the caret being in the command line: the router raises it through
 * `onLine`, and `typing` goes up with it because `main.ts` composes that boolean out of the log's own
 * focus event, which `.focus()` fires synchronously. After that the browser aims the keydown at the
 * input, so both halves of the gate are up — which is why the rest of the word is typed by the
 * *default action* and never routed at all.
 */
function typeFromTheWorld(text: string): string {
  const router = new KeyRouter();
  let value = '';
  let focused = false;
  router.onLine = () => {
    focused = true;
    router.typing = true;
  };
  router.attach();
  try {
    for (const character of text) {
      const event = press(codeOf(character), {
        key: character,
        target: focused ? asTarget(commandLine) : null,
      });
      dispatch(event);
      // The browser's own half: an unprevented printable keydown inserts itself into what has focus.
      if (!event.defaultPrevented && focused) value += character;
    }
  } finally {
    router.detach();
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* 2. A letter aimed at the command line is untouched                          */
/* -------------------------------------------------------------------------- */

describe('the caret keeps the keyboard, by both halves of the gate', () => {
  it('ignores everything while `typing` is raised', () => {
    for (const code of [...VIEW_CODES, 'KeyW', 'Enter', 'F1', 'KeyZ']) {
      assert.deepEqual(route(press(code), true), { t: 'ignore' }, `${code} was read while typing`);
      assert.deepEqual(
        route(press(code, { alt: true }), true),
        { t: 'ignore' },
        `alt+${code} was read while typing`,
      );
    }
  });

  it('fires nothing at all through the real listener while typing', () => {
    const held = bench();
    held.router.typing = true;
    const event = dispatch(press('KeyO'));
    assert.equal(held.lines, 0);
    assert.equal(held.views.length, 0);
    assert.equal(event.defaultPrevented, false, 'a keystroke meant for the command line was prevented');
    held.done();
  });

  it('still shields the login card through `intoFormControl`, with `typing` down', () => {
    // The gate raises `typing` too, but the two shields are independent on purpose: either one alone
    // clearing would re-arm the world while the other still needs it off. This is the second one,
    // tested without the first — a letter typed into the account field, and an Alt chord aimed at it.
    const held = bench();
    const typed = dispatch(press('KeyO', { target: asTarget(loginField) }));
    const chord = dispatch(press('KeyG', { alt: true, target: asTarget(loginField) }));
    assert.equal(held.lines, 0, 'a letter typed into the login card opened the command line');
    assert.equal(held.views.length, 0, 'an alt chord aimed at the login card moved the sky');
    assert.equal(typed.defaultPrevented, false, 'the login card lost a character');
    assert.equal(chord.defaultPrevented, false);
    held.done();
  });

  it('shields a textarea, a select and a contenteditable the same way', () => {
    const editable = new FakeElement();
    editable.isContentEditable = true;
    for (const element of [new FakeTextArea(), new FakeSelect(), editable]) {
      assert.deepEqual(route(press('KeyT', { target: asTarget(element) }), false), { t: 'ignore' });
    }
  });

  it('leaves an IME alone while it is composing', () => {
    assert.deepEqual(route(press('KeyO', { composing: true }), false), { t: 'ignore' });
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Every toggle still fires, behind Alt                                     */
/* -------------------------------------------------------------------------- */

describe('the view controls kept their mnemonics and moved behind Alt', () => {
  it('fires each of the eleven on its own alt chord', () => {
    for (const code of VIEW_CODES) {
      const held = bench();
      const event = dispatch(press(code, { alt: true }));
      assert.deepEqual(held.views, [{ code, shift: false }], `alt+${code} did not fire`);
      assert.equal(held.lines, 0, `alt+${code} also opened the command line`);
      assert.equal(
        event.defaultPrevented,
        true,
        `alt+${code} was left to the browser, whose Alt+F is the Chrome menu`,
      );
      held.done();
    }
  });

  it('carries the shift half of R and G through, so the releases still work', () => {
    const held = bench();
    dispatch(press('KeyR', { alt: true, shift: true }));
    dispatch(press('KeyG', { alt: true, shift: true }));
    assert.deepEqual(held.views, [
      { code: 'KeyR', shift: true },
      { code: 'KeyG', shift: true },
    ]);
    held.done();
  });

  it('answers F1 with the controls, and keeps the browser’s own help out of it', () => {
    const held = bench();
    const event = dispatch(press('F1'));
    assert.equal(held.helps, 1);
    assert.equal(held.lines, 0, 'F1 typed into the command line instead of answering');
    assert.equal(event.defaultPrevented, true, 'F1 was left to open the browser’s help in a new tab');
    held.done();
  });

  it('says the modifier out loud, and names every key it binds', () => {
    // The owner found O by accident and had no list. A list that can go stale is worse than none, so
    // `CONTROLS` is generated from the same table `route` reads; this is the assertion that the two
    // are still the same table.
    assert.match(CONTROLS, /ALT\+key/, 'the controls line does not state the modifier');
    for (const key of ['O', 'C', 'K', 'T', 'R', 'B', 'F', 'V', 'G', '[', ']']) {
      assert.ok(CONTROLS.includes(`alt+${key}:`), `the controls line never mentions alt+${key}`);
    }
    assert.match(CONTROLS, /F1/, 'the controls line does not say how to see itself again');
    assert.match(CONTROLS, /enter opens the line/, 'the controls line does not mention the escape hatch');
  });
});

/* -------------------------------------------------------------------------- */
/* 4. Nothing fires without the modifier                                       */
/* -------------------------------------------------------------------------- */

describe('no toggle fires on a bare key — the reported bug, key by key', () => {
  it('sends all eleven to the command line instead when Alt is not held', () => {
    for (const code of VIEW_CODES) {
      const held = bench();
      dispatch(press(code));
      assert.equal(held.views.length, 0, `a bare ${code} still fired a view control`);
      assert.equal(held.lines, 1, `a bare ${code} did not reach the command line`);
      held.done();
    }
  });

  it('refuses Ctrl and Meta outright, so the browser keeps its own plane', () => {
    for (const code of VIEW_CODES) {
      assert.deepEqual(route(press(code, { ctrl: true }), false), { t: 'ignore' }, `ctrl+${code}`);
      assert.deepEqual(route(press(code, { meta: true }), false), { t: 'ignore' }, `meta+${code}`);
    }
  });

  it('refuses AltGr, which is Ctrl+Alt on Windows and types a character', () => {
    // The order of the two tests in `route` is the whole of this: Ctrl is asked before Alt, so an
    // AltGr keystroke is refused rather than read as a view control with a stray Ctrl on it.
    for (const code of VIEW_CODES) {
      assert.deepEqual(route(press(code, { alt: true, ctrl: true }), false), { t: 'ignore' }, `altgr+${code}`);
    }
  });

  it('leaves alt chords it does not bind to the browser, unprevented', () => {
    // Alt+Left is Back and Alt+Tab is the window switcher. Claiming the modifier does not mean
    // claiming every key under it.
    for (const code of ['ArrowLeft', 'Home', 'Tab', 'KeyD', 'KeyZ']) {
      const held = bench();
      const event = dispatch(press(code, { alt: true }));
      assert.equal(held.views.length, 0, `alt+${code} fired something`);
      assert.equal(held.lines, 0, `alt+${code} opened the command line`);
      assert.equal(event.defaultPrevented, false, `alt+${code} was taken away from the browser`);
      held.done();
    }
  });

  it('stops listening once detached', () => {
    const held = bench();
    held.done();
    dispatch(press('KeyO', { alt: true }));
    dispatch(press('KeyZ'));
    assert.equal(held.views.length, 0);
    assert.equal(held.lines, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Movement is the one bare exception, and it still moves                   */
/* -------------------------------------------------------------------------- */

describe('the movement keys still move, and are never typed', () => {
  it('claims exactly the codes `input.ts` claims, derived rather than restated', () => {
    // The exception is only legible if it cannot drift. `MOVEMENT_CODES` is built from `STEER` and
    // `TRAVEL` themselves, so this is a check that the union is what the two tables actually hold.
    assert.deepEqual(
      [...MOVEMENT_CODES].sort(),
      [
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'KeyA',
        'KeyD',
        'KeyE',
        'KeyQ',
        'KeyS',
        'KeyW',
      ],
    );
  });

  it('routes each of them to `move` and never to the command line', () => {
    for (const code of MOVEMENT_CODES) {
      assert.deepEqual(route(press(code), false), { t: 'move' }, `${code} should steer`);
      assert.deepEqual(
        route(press(code, { shift: true }), false),
        { t: 'move' },
        `shift+${code} should still take the exit`,
      );
    }
  });

  it('still steers, with the router attached beside `Input` in `main.ts`’s own order', () => {
    // Both listeners on one window, `Input` first exactly as `main.ts` attaches it. The property is
    // that they do not fight: the steer is read and nothing is typed.
    const input = new Input();
    input.attach();
    const held = bench();
    dispatch(press('KeyW'));
    assert.deepEqual(input.intent(), { x: 0, y: -1 }, 'W stopped steering');
    assert.equal(held.lines, 0, 'W was typed into the command line instead of walking');
    assert.equal(held.views.length, 0);
    held.done();
    input.detach();
  });

  it('still travels on shift+W, and the router does not touch it', () => {
    const input = new Input();
    const travelled: string[] = [];
    input.onTravel = (direction) => travelled.push(direction);
    input.attach();
    const held = bench();
    dispatch(press('ShiftLeft', { shift: true }));
    dispatch(press('KeyW', { shift: true }));
    dispatch(press('KeyD', { shift: true }));
    assert.deepEqual(travelled, ['north', 'east'], 'shift+WASD stopped taking the exit');
    assert.deepEqual(input.intent(), { x: 0, y: 0 }, 'a shifted travel key also glided');
    assert.equal(held.lines, 0, 'a shifted movement key was typed');
    held.done();
    input.detach();
  });

  it('still takes the staircase on Q and E, which are letters and are not typed', () => {
    const input = new Input();
    const travelled: string[] = [];
    input.onTravel = (direction) => travelled.push(direction);
    input.attach();
    const held = bench();
    dispatch(press('KeyQ'));
    dispatch(press('KeyE'));
    assert.deepEqual(travelled, ['up', 'down']);
    assert.equal(held.lines, 0);
    held.done();
    input.detach();
  });

  it('reaches every letter of the alphabet anyway, because Enter opens the prompt first', () => {
    // The cost of the exception, and its refund. `wear cloak` is unreachable as a bare word — W
    // walks — so the escape hatch has to exist, and it is the MUD's own reflex.
    const held = bench();
    dispatch(press('Enter'));
    assert.equal(held.lines, 1, 'Enter did not open the prompt, so w/a/s/d/q/e are unreachable');
    held.done();
  });
});

/* -------------------------------------------------------------------------- */
/* 6. Repeat: the brackets sweep, the toggles do not strobe                    */
/* -------------------------------------------------------------------------- */

describe('auto-repeat is the brackets’ feature and the toggles’ hazard', () => {
  it('reads every repeat of alt+[ and alt+], because a sweep is hold-and-step', () => {
    const held = bench();
    for (let n = 0; n < 4; n += 1) dispatch(press('BracketRight', { alt: true, repeat: n > 0 }));
    assert.equal(held.views.length, 4, 'the hour sweep stopped repeating');
    held.done();
  });

  it('refuses a repeat on all nine letters, so a held key is not a strobe', () => {
    for (const code of VIEW_CODES.filter((entry) => entry.startsWith('Key'))) {
      const held = bench();
      dispatch(press(code, { alt: true }));
      dispatch(press(code, { alt: true, repeat: true }));
      dispatch(press(code, { alt: true, repeat: true }));
      assert.deepEqual(held.views, [{ code, shift: false }], `alt+${code} fired on auto-repeat`);
      held.done();
    }
  });
});
