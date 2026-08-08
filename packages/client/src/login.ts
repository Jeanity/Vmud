/**
 * The front door — protocol 23's handshake, driven from a DOM overlay.
 *
 * Two steps, two panels in one card: credentials (`auth`), then a body (`enter`). The game boots
 * behind the overlay untouched and renders nothing meaningful until `welcome`, which is the message
 * that drops the card. Plain DOM like the log and the feed, and for the stronger form of the usual
 * reason: a password box inside a canvas would be a reimplementation of the browser's whole input
 * stack, wrong in every accessibility particular.
 *
 * ## What the tab remembers (sessionStorage, like the name it replaces)
 *
 * - `mygame:resume` — the server's resume token, taken from every `account` message. A reload
 *   re-auths with it and skips the password; a second tab has its own storage and gets the form,
 *   which is what keeps two-tabs-two-characters testing alive.
 * - `mygame:character` — the last body this tab entered. A *resumed* auth walks straight back into
 *   it, so the reload loop feels exactly like the pre-account client: F5 and you are standing where
 *   you stood. A *typed* login always shows the picker — you came to choose.
 * - `mygame:account` — the account name, only to prefill the form.
 *
 * ## Dev conveniences, in the `?name=` tradition
 *
 * `?account=X&password=Y` auths on every (re)connect — the successor to `?name=` for the two-window
 * flow and for surviving the dev server's restarts, where in-memory resume tokens die. `&create=1`
 * mints the account first; `&character=Z` picks the body. Convenience for a loopback dev server,
 * not a pattern for a public one — a password in a URL is in the history of every tab that shows
 * it.
 */

import {
  ABILITIES,
  CLASSES,
  CLASS_IDS,
  PROTOCOL_VERSION,
  RACES,
  RACE_IDS,
  racialBonuses,
  scoreWord,
  type Ability,
  type CharacterSummary,
  type ClassId,
  type RaceId,
  type ServerMessage,
} from '@mygame/shared';

import type { Net } from './net.ts';

const RESUME_KEY = 'mygame:resume';
const ACCOUNT_KEY = 'mygame:account';
const CHARACTER_KEY = 'mygame:character';

export class LoginGate {
  private readonly overlay: HTMLElement;
  private readonly accountForm: HTMLFormElement;
  private readonly nameInput: HTMLInputElement;
  private readonly passwordInput: HTMLInputElement;
  private readonly createBox: HTMLInputElement;
  private readonly formError: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly pickerTitle: HTMLElement;
  private readonly characterList: HTMLElement;
  private readonly newForm: HTMLFormElement;
  private readonly newName: HTMLInputElement;
  private readonly pickerError: HTMLElement;
  private readonly chargenPanel: HTMLElement;
  private readonly chargenTitle: HTMLElement;
  private readonly chargenGrid: HTMLElement;
  private readonly chargenRoll: HTMLElement;
  private readonly chargenScores: HTMLElement;
  private readonly chargenBonus: HTMLElement;
  private readonly chargenError: HTMLElement;

  /** Which step is waiting on the server, so `authFailed` lands under the right caret. */
  private pending: 'none' | 'auth' | 'resume' | 'enter' | 'autoEnter' | 'chargen' = 'none';
  /**
   * The creation card's held state — protocol 24. `name` for a fresh mint, `adoptName` when a
   * pre-identity save is deciding who it always was; the spend is client-side bookkeeping the
   * server re-validates at the confirm.
   */
  private chargen:
    | {
        name?: string;
        adoptName?: string;
        race?: RaceId;
        class?: ClassId;
        words?: Readonly<Record<Ability, string>>;
        scores?: Readonly<Record<Ability, number>>;
        bonus: number;
        spend: Partial<Record<Ability, number>>;
      }
    | undefined;
  /** Entered the moment the refreshed `account` list confirms the mint. */
  private pendingEnter: string | undefined;
  /** True while the current `auth` was sent without the user typing — resume or URL params. */
  private handsFree = false;
  /**
   * `enter` is held until the scene has booted, because the world answers it *immediately* —
   * `welcome`, `zone`, `seen`, `self`, the room — and the scene registers its handlers in Phaser's
   * `create()`, a frame or more after this module ran. A human on the picker can never beat that
   * frame; the hands-free resume path on loopback reliably did, and the world arrived before
   * anything was listening. `auth` is not held: its answers land here, and this object is ready
   * the moment it exists.
   */
  private ready = false;
  private enterWhenReady: string | undefined;
  /**
   * The last `account` message, kept because the hands-free path never shows the picker — and when
   * its auto-`enter` is refused, the picker (with this list in it) is exactly what must appear.
   */
  private lastAccount: Extract<ServerMessage, { t: 'account' }> | undefined;

  /** Raised while the overlay is up. The scene's typing gate hangs off it — see `main.ts`. */
  onVisibility: ((visible: boolean) => void) | undefined;

  constructor(private readonly net: Net) {
    this.overlay = grab('login');
    this.accountForm = grab('login-account') as HTMLFormElement;
    this.nameInput = grab('login-name') as HTMLInputElement;
    this.passwordInput = grab('login-password') as HTMLInputElement;
    this.createBox = grab('login-create') as HTMLInputElement;
    this.formError = grab('login-error');
    this.picker = grab('login-picker');
    this.pickerTitle = grab('login-picker-title');
    this.characterList = grab('login-characters');
    this.newForm = grab('login-new') as HTMLFormElement;
    this.newName = grab('login-new-name') as HTMLInputElement;
    this.pickerError = grab('login-picker-error');
    this.chargenPanel = grab('login-chargen');
    this.chargenTitle = grab('chargen-title');
    this.chargenGrid = grab('chargen-grid');
    this.chargenRoll = grab('chargen-roll');
    this.chargenScores = grab('chargen-scores');
    this.chargenBonus = grab('chargen-bonus');
    this.chargenError = grab('chargen-error');

    this.nameInput.value = readSession(ACCOUNT_KEY) ?? '';

    this.accountForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const account = this.nameInput.value.trim();
      const password = this.passwordInput.value;
      if (!account || !password) return this.fail('account and password, both');
      writeSession(ACCOUNT_KEY, account);
      this.handsFree = false;
      this.pending = 'auth';
      this.net.send({
        t: 'auth',
        protocol: PROTOCOL_VERSION,
        account,
        password,
        ...(this.createBox.checked ? { create: true } : {}),
      });
    });

    this.newForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = this.newName.value.trim();
      // Protocol 24: a new name opens the creation cards; only `enter` on an existing body skips
      // them. The server still owns every refusal — the cards are pages, not permissions.
      if (name) this.startChargen({ name });
    });

    grab('chargen-back').addEventListener('click', () => {
      this.chargen = undefined;
      this.pendingEnter = undefined;
      if (this.lastAccount) {
        this.showPicker(this.lastAccount.account, this.lastAccount.characters, this.lastAccount.max);
      } else {
        this.showForm();
      }
    });
    grab('chargen-reroll').addEventListener('click', () => this.sendCreate());
    grab('chargen-confirm').addEventListener('click', () => {
      const held = this.chargen;
      if (!held || !held.words) return;
      this.pending = 'chargen';
      this.pendingEnter = held.adoptName ?? held.name;
      this.net.send({ t: 'charConfirm', spend: held.spend });
    });

    net.on('charRolled', (message) => {
      const held = this.chargen;
      if (!held) return;
      this.pending = 'none';
      held.words = message.words;
      held.scores = message.scores;
      held.bonus = message.bonus;
      held.spend = {};
      this.showRoll();
    });

    net.on('charAdopt', (message) => {
      // The body predates identities: same cards, no name step, history kept.
      this.pending = 'none';
      this.startChargen({ adoptName: message.name });
    });

    grab('login-switch').addEventListener('click', () => {
      // "Not you?" — forget everything this tab knew and start at the form.
      clearSession(RESUME_KEY);
      clearSession(CHARACTER_KEY);
      this.passwordInput.value = '';
      this.showForm();
    });

    net.on('account', (message) => {
      this.lastAccount = message;
      writeSession(RESUME_KEY, message.resume);
      if (this.pendingEnter) {
        // The refreshed list is the mint's success signal — walk straight into the new body.
        const target = this.pendingEnter;
        this.pendingEnter = undefined;
        this.chargen = undefined;
        this.enter(target, 'enter');
        return;
      }
      const wanted = params().get('character') ?? readSession(CHARACTER_KEY) ?? undefined;
      // Hands-free auth walks straight back into the remembered body; a typed login came to choose.
      if (this.handsFree && wanted) {
        this.enter(wanted, 'autoEnter');
        return;
      }
      this.showPicker(message.account, message.characters, message.max);
    });

    net.on('authFailed', (message) => {
      const pending = this.pending;
      this.pending = 'none';
      switch (pending) {
        case 'resume':
          // An expired session is not the user's mistake; the form, quietly, is the answer.
          clearSession(RESUME_KEY);
          this.showForm();
          return;
        case 'autoEnter': {
          // The remembered body was refused — taken, or already walking. Choose by hand: the
          // hands-free path skipped the picker, so it has to be *raised* here, not just written
          // to — an error inside a hidden panel explains nothing.
          clearSession(CHARACTER_KEY);
          const held = this.lastAccount;
          if (held) {
            this.showPicker(held.account, held.characters, held.max);
            this.pickerError.textContent = message.reason;
            this.pickerError.hidden = false;
          } else {
            this.showForm();
            this.fail(message.reason);
          }
          return;
        }
        case 'enter':
          this.pickerError.textContent = message.reason;
          this.pickerError.hidden = false;
          return;
        case 'chargen':
          this.pendingEnter = undefined;
          this.chargenError.textContent = message.reason;
          this.chargenError.hidden = false;
          return;
        default:
          this.fail(message.reason);
      }
    });

    net.on('welcome', () => {
      this.pending = 'none';
      this.overlay.hidden = true;
      this.onVisibility?.(false);
    });
  }

  /** Called on every socket open: hands-free auth if the tab can manage it, the form otherwise. */
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
    const resume = readSession(RESUME_KEY);
    if (resume) {
      this.handsFree = true;
      this.pending = 'resume';
      this.net.send({ t: 'auth', protocol: PROTOCOL_VERSION, resume });
      return;
    }
    this.showForm();
  }

  /** Called once the scene's handlers exist (`create()` has run). Releases any held `enter`. */
  setReady(): void {
    this.ready = true;
    const held = this.enterWhenReady;
    this.enterWhenReady = undefined;
    if (held) this.enter(held, 'autoEnter');
  }

  private enter(name: string, step: 'enter' | 'autoEnter'): void {
    if (!this.ready) {
      this.enterWhenReady = name;
      return;
    }
    this.pending = step;
    writeSession(CHARACTER_KEY, name);
    this.net.send({ t: 'enter', name });
  }

  private showForm(): void {
    this.overlay.hidden = false;
    this.picker.hidden = true;
    this.chargenPanel.hidden = true;
    this.accountForm.hidden = false;
    this.formError.hidden = true;
    this.onVisibility?.(true);
    this.nameInput.focus();
  }

  private showPicker(account: string, characters: readonly CharacterSummary[], max: number): void {
    this.overlay.hidden = false;
    this.accountForm.hidden = true;
    this.chargenPanel.hidden = true;
    this.picker.hidden = false;
    this.pickerError.hidden = true;
    this.pickerTitle.textContent = `${account} — choose a character`;
    this.characterList.replaceChildren(
      ...characters.map((character) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'login-character';
        const name = document.createElement('b');
        name.textContent = character.name;
        row.append(name);
        const facts: string[] = [];
        if (character.level !== undefined) facts.push(`level ${character.level}`);
        // Local, not sliced from the ISO string: the wire timestamp is UTC, and a character played
        // this morning must not be listed under yesterday's date east of Greenwich.
        if (character.lastPlayed) {
          const played = new Date(character.lastPlayed);
          if (!Number.isNaN(played.getTime())) facts.push(played.toLocaleDateString());
        }
        if (facts.length > 0) {
          const detail = document.createElement('span');
          detail.textContent = facts.join(' · ');
          row.append(detail);
        }
        row.addEventListener('click', () => this.enter(character.name, 'enter'));
        return row;
      }),
    );
    // The cap is the server's fact, shipped in the message so this form cannot disagree with it.
    this.newForm.hidden = characters.length >= max;
    this.newName.value = '';
    this.onVisibility?.(true);
  }

  /** Opens the cards at the race page — for a fresh name, or for a body deciding what it was. */
  private startChargen(start: { name?: string; adoptName?: string }): void {
    this.chargen = { ...start, bonus: 0, spend: {} };
    this.overlay.hidden = false;
    this.accountForm.hidden = true;
    this.picker.hidden = true;
    this.chargenPanel.hidden = false;
    this.chargenError.hidden = true;
    this.chargenRoll.hidden = true;
    this.onVisibility?.(true);
    this.showRaces();
  }

  private showRaces(): void {
    const held = this.chargen;
    if (!held) return;
    this.chargenTitle.textContent = held.adoptName
      ? `Who was ${held.adoptName} all along?`
      : `${held.name} — choose a race`;
    this.chargenRoll.hidden = true;
    this.chargenGrid.hidden = false;
    this.chargenGrid.replaceChildren(
      ...RACE_IDS.map((id) => {
        const race = RACES[id];
        const bonuses = racialBonuses(race);
        const traits = ABILITIES.filter((a) => bonuses[a] !== 0)
          .map((a) => `${bonuses[a] > 0 ? '+' : ''}${bonuses[a]} ${a.toUpperCase()}`)
          .join('  ');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chargen-choice';
        const name = document.createElement('b');
        name.textContent = race.name;
        const line = document.createElement('span');
        line.className = 'traits';
        line.textContent = traits || 'no favours, no debts';
        const blurb = document.createElement('span');
        blurb.className = 'blurb';
        blurb.textContent = race.flavour;
        row.append(name, line, blurb);
        row.addEventListener('click', () => {
          held.race = id;
          this.showClasses();
        });
        return row;
      }),
    );
  }

  private showClasses(): void {
    const held = this.chargen;
    if (!held) return;
    this.chargenTitle.textContent = `${held.adoptName ?? held.name} the ${RACES[held.race!].name} — choose a calling`;
    this.chargenGrid.hidden = false;
    this.chargenGrid.replaceChildren(
      ...CLASS_IDS.map((id) => {
        const spec = CLASSES[id];
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'chargen-choice';
        const name = document.createElement('b');
        name.textContent = spec.name;
        const line = document.createElement('span');
        line.className = 'traits';
        line.textContent = spec.casting
          ? `${spec.casting.kind} caster${spec.casting.opensAt > 1 ? ` from level ${spec.casting.opensAt}` : ''}`
          : 'no spells, no apologies';
        const blurb = document.createElement('span');
        blurb.className = 'blurb';
        blurb.textContent = spec.flavour;
        row.append(name, line, blurb);
        row.addEventListener('click', () => {
          held.class = id;
          this.sendCreate();
        });
        return row;
      }),
    );
  }

  /** `charCreate` — the first ask and every reroll. The bonus points reset with the dice. */
  private sendCreate(): void {
    const held = this.chargen;
    if (!held || !held.race || !held.class) return;
    this.pending = 'chargen';
    this.chargenError.hidden = true;
    this.net.send({
      t: 'charCreate',
      ...(held.name !== undefined ? { name: held.name } : {}),
      race: held.race,
      class: held.class,
    });
  }

  private spent(): number {
    const held = this.chargen;
    if (!held) return 0;
    return ABILITIES.reduce((sum, a) => sum + (held.spend[a] ?? 0), 0);
  }

  /** The roll, in words — the owner's rule. `+1`s appear beside a word as points land on it. */
  private showRoll(): void {
    const held = this.chargen;
    if (!held || !held.words) return;
    this.chargenTitle.textContent = `${held.adoptName ?? held.name} the ${RACES[held.race!].name} ${CLASSES[held.class!].name}`;
    this.chargenGrid.hidden = true;
    this.chargenRoll.hidden = false;
    const left = held.bonus - this.spent();
    this.chargenBonus.textContent =
      left > 0 ? `${left} point${left === 1 ? '' : 's'} to spend` : 'every point spent';
    // The dice, explained — the owner's reason: nobody should grind for an impossible twenty or
    // keep a dud because the odds were a mystery. Set here, not in the markup, so the words can
    // never drift from the roll that is actually made.
    const hint = document.getElementById('chargen-hint');
    if (hint) {
      hint.textContent =
        'Each score: 4d6, drop the lowest — 3 to 18, average just over 12 — then your race’s ' +
        'bonuses, raised to your calling’s minimums. Reroll all six as often as you like; the ' +
        'five points reset each time.';
    }
    this.chargenScores.replaceChildren(
      ...ABILITIES.map((ability) => {
        const row = document.createElement('div');
        row.className = 'score-row';
        const ab = document.createElement('span');
        ab.className = 'ab';
        ab.textContent = ability;
        const word = document.createElement('span');
        word.className = 'word';
        const spentHere = held.spend[ability] ?? 0;
        // The owner's amendment: the number rides beside the word, and both track the spend live —
        // "good 15" becomes "very good 16" as a point lands, which is the whole calibration.
        const base = held.scores?.[ability];
        const shown = base === undefined ? undefined : base + spentHere;
        word.textContent = shown === undefined ? held.words![ability] : `${scoreWord(shown)} ${shown}`;
        const plus = document.createElement('span');
        plus.className = 'plus';
        plus.textContent = spentHere > 0 ? `+${spentHere}` : '';
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.textContent = '−';
        minus.disabled = spentHere === 0;
        minus.addEventListener('click', () => {
          if ((held.spend[ability] ?? 0) > 0) {
            held.spend[ability] = (held.spend[ability] ?? 0) - 1;
            this.showRoll();
          }
        });
        const more = document.createElement('button');
        more.type = 'button';
        more.textContent = '+';
        more.disabled = left <= 0;
        more.addEventListener('click', () => {
          if (this.spent() < held.bonus) {
            held.spend[ability] = (held.spend[ability] ?? 0) + 1;
            this.showRoll();
          }
        });
        row.append(ab, word, plus, minus, more);
        return row;
      }),
    );
  }

  private fail(reason: string): void {
    this.formError.textContent = reason;
    this.formError.hidden = false;
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
function readSession(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // A tab that cannot remember simply asks again next reload.
  }
}

function clearSession(key: string): void {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing stored, nothing lost.
  }
}
