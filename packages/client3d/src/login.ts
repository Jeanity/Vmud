/**
 * The front door, cut down to what M3 needs — protocol 23's handshake and nothing after it.
 *
 * The Phaser client's `login.ts` is 656 lines because it owns protocol 24's whole creation
 * conversation: race cards, class cards, a roll shown in words, five bonus points, adoption of
 * pre-phase saves, and a reconnect path that rebuilds the server's half of it. **None of that is
 * M3's.** A grey-box renderer needs to get a body into the world so that chunks can stream and a
 * ledger can be read; choosing who that body is belongs to the client with the cards in it, and both
 * clients speak to the same server, so a character made in the 2D client walks straight into this
 * one.
 *
 * So this file is the two steps and the two hands-free paths:
 *
 * 1. `auth` — from `?account=&password=` on the URL, from a `sessionStorage` resume token, or from
 *    the form.
 * 2. `enter` — the character named in `?character=`, the one this tab last used, or one picked from
 *    the list. A **free** name enters directly and the server spawns it identity-less, which is what
 *    makes `?character=Greybox` a one-URL boot for a fresh account.
 *
 * ## What it deliberately cannot do, and how it says so
 *
 * A character saved *before* protocol 24 is answered with `charAdopt` — "decide who you always
 * were" — and there is nothing here to decide it with. That case shows a sentence pointing at the
 * 2D client rather than a dead card, because a silent stall at the door is the worst possible
 * failure for a page whose whole job is to boot far enough to read a counter.
 *
 * ## One thing the donor needs and this does not
 *
 * The Phaser gate holds `enter` until the scene's handlers exist, because Phaser registers them in
 * `create()` — a frame or more after the module ran — and the world's answer to `enter` is
 * immediate. `main.ts` here registers every handler synchronously *before* `net.connect()`, so there
 * is no window to lose and no `setReady` to wait on. That is worth stating: the absence is a
 * consequence of the boot order, not an oversight, and reordering `main.ts` would reintroduce it.
 */

import { PROTOCOL_VERSION, type CharacterSummary, type ServerMessage } from '@mygame/shared';

import type { Net } from './net.ts';

const RESUME_KEY = 'mygame:resume';
const ACCOUNT_KEY = 'mygame:account';
const CHARACTER_KEY = 'mygame:character';

type Pending = 'none' | 'auth' | 'resume' | 'enter' | 'autoEnter';

export class LoginGate {
  private readonly overlay: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly account: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private readonly create: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly characters: HTMLElement;
  private readonly newForm: HTMLFormElement;
  private readonly newName: HTMLInputElement;

  private pending: Pending = 'none';
  private handsFree = false;
  /**
   * The credentials the user actually typed, held in page memory for the life of the tab.
   *
   * The gap this closes was found on the wire, not in review. `net.send` silently drops a handshake
   * message when the socket is not OPEN — by design, with a comment promising "login.ts reacts to
   * state changes". It did, but `onConnected` could only replay a URL credential or a resume token,
   * and **a resume token dies with every server restart** (`authFailed: session expired`), which in
   * dev is constantly. So the one path a human actually uses — type a password, click enter —
   * had no replay at all: a submit landing in a reconnect window vanished without a word, and the
   * owner's first attempt to log into the 3D world ended on a form that ate the click.
   *
   * Held in memory only, never persisted — closing the tab forgets it, which is what a password
   * field promises. Cleared on an explicit `authFailed` for a typed attempt, so a wrong password
   * cannot replay itself forever.
   */
  private typed: { account: string; password: string; create: boolean } | undefined;
  private last: Extract<ServerMessage, { t: 'account' }> | undefined;

  /** Raised while the overlay is up. `main.ts` folds it into the keyboard gate with the log's. */
  onVisibility: ((visible: boolean) => void) | undefined;

  constructor(private readonly net: Net) {
    this.overlay = grab('gate');
    this.form = grab('gate-form') as HTMLFormElement;
    this.account = grab('gate-account') as HTMLInputElement;
    this.password = grab('gate-password') as HTMLInputElement;
    this.create = grab('gate-create') as HTMLInputElement;
    this.error = grab('gate-error');
    this.picker = grab('gate-picker');
    this.characters = grab('gate-characters');
    this.newForm = grab('gate-new') as HTMLFormElement;
    this.newName = grab('gate-new-name') as HTMLInputElement;

    this.account.value = read(ACCOUNT_KEY) ?? '';

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const account = this.account.value.trim();
      const password = this.password.value;
      if (!account || !password) return this.fail('account and password, both');
      write(ACCOUNT_KEY, account);
      this.handsFree = false;
      // Captured before the send, because the send may not happen: a socket mid-reconnect drops
      // handshakes silently, and `onConnected` replays this the moment the next one opens.
      this.typed = { account, password, create: this.create.checked };
      if (this.net.state !== 'open') {
        // The truth beats a swallowed click: the attempt is queued in `typed` and fires itself.
        this.fail('reconnecting — entering as soon as the server answers');
        return;
      }
      this.pending = 'auth';
      this.net.send({
        t: 'auth',
        protocol: PROTOCOL_VERSION,
        account,
        password,
        ...(this.create.checked ? { create: true } : {}),
      });
    });

    this.newForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = this.newName.value.trim();
      // A free name is claimed and spawned by `enter` itself; the cards are only reached by asking
      // for them, and this client never does. See the header.
      if (name) this.enter(name, 'enter');
    });

    net.on('account', (message) => {
      this.last = message;
      write(RESUME_KEY, message.resume);
      const wanted = params().get('character') ?? read(CHARACTER_KEY);
      if (wanted && (this.handsFree || message.characters.some((c) => c.name === wanted))) {
        this.enter(wanted, 'autoEnter');
        return;
      }
      this.showPicker(message.account, message.characters, message.max);
    });

    net.on('charAdopt', (message) => {
      this.pending = 'none';
      this.showPicker(this.last?.account ?? '', this.last?.characters ?? [], this.last?.max ?? 0);
      this.say(
        `${message.name} predates character identities and has to adopt a race and calling first. ` +
          'Do that once in the 2D client on port 5273; this one has no creation cards.',
      );
    });

    net.on('authFailed', (message) => {
      const was = this.pending;
      this.pending = 'none';
      // A refused typed attempt must not replay itself on the next reconnect — a wrong password
      // looping forever is worse than typing it again. Expiry of a *resume* leaves `typed` alone.
      if (was === 'auth') this.typed = undefined;
      if (was === 'resume') {
        // An expired session is not the user's mistake; the form, quietly, is the answer.
        clear(RESUME_KEY);
        this.showForm();
        return;
      }
      if (was === 'autoEnter') clear(CHARACTER_KEY);
      if (this.last) this.showPicker(this.last.account, this.last.characters, this.last.max);
      else this.showForm();
      this.say(message.reason);
    });

    net.on('rejected', (message) => this.say(`Rejected: ${message.reason}`));

    net.on('welcome', () => {
      this.pending = 'none';
      this.overlay.hidden = true;
      this.onVisibility?.(false);
    });
  }

  /** Called on every socket open: hands-free where the tab can manage it, the form otherwise. */
  onConnected(): void {
    const search = params();
    const account = search.get('account');
    const password = search.get('password');
    if (account && password) {
      this.handsFree = true;
      this.pending = 'auth';
      this.net.send({
        t: 'auth',
        protocol: PROTOCOL_VERSION,
        account,
        password,
        ...(search.get('create') ? { create: true } : {}),
      });
      return;
    }
    // Typed credentials outrank the resume token: they are fresher intent, and the token dies with
    // every server restart while the human's password does not. This is the replay the silent-drop
    // rule in `net.send` was always promising — a submit or a bounce at any point now self-heals on
    // the next reconnect, and `CHARACTER_KEY` walks the body back in through the `account` handler.
    if (this.typed) {
      this.pending = 'auth';
      this.net.send({
        t: 'auth',
        protocol: PROTOCOL_VERSION,
        account: this.typed.account,
        password: this.typed.password,
        ...(this.typed.create ? { create: true } : {}),
      });
      return;
    }
    const resume = read(RESUME_KEY);
    if (resume) {
      this.handsFree = true;
      this.pending = 'resume';
      this.net.send({ t: 'auth', protocol: PROTOCOL_VERSION, resume });
      return;
    }
    this.showForm();
  }

  private enter(name: string, step: 'enter' | 'autoEnter'): void {
    this.pending = step;
    write(CHARACTER_KEY, name);
    this.net.send({ t: 'enter', name });
  }

  private showForm(): void {
    this.overlay.hidden = false;
    this.picker.hidden = true;
    this.form.hidden = false;
    this.onVisibility?.(true);
    this.account.focus();
  }

  private showPicker(account: string, characters: readonly CharacterSummary[], max: number): void {
    this.overlay.hidden = false;
    this.form.hidden = true;
    this.picker.hidden = false;
    grab('gate-picker-title').textContent = account ? `${account} — choose a body` : 'choose a body';
    this.characters.replaceChildren(
      ...characters.map((character) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'gate-character';
        row.textContent = character.level === undefined ? character.name : `${character.name} · level ${character.level}`;
        row.addEventListener('click', () => this.enter(character.name, 'enter'));
        return row;
      }),
    );
    // The cap is the server's fact, shipped in the message so this form cannot disagree with it.
    this.newForm.hidden = characters.length >= max;
    this.onVisibility?.(true);
  }

  private fail(reason: string): void {
    this.say(reason);
  }

  private say(text: string): void {
    this.error.textContent = text;
    this.error.hidden = false;
  }
}

function grab(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`${id} element missing from index.html`);
  return node;
}

function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

/** Wrapped because storage access throws outright in a partitioned or cookie-blocked context. */
function read(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // A tab that cannot remember simply asks again next reload.
  }
}

function clear(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored, nothing lost.
  }
}
