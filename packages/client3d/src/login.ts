/**
 * The front door — protocol 23's handshake and protocol 24's creation conversation, in a DOM
 * overlay.
 *
 * Until this slice the file stopped at the door on purpose and said so in a sentence: a character
 * that predated identities was told to go and adopt one *"in the 2D client on port 5273; this one
 * has no creation cards"*. That sentence is gone, and with it the last reason to open the Phaser
 * client at all: `npm run dev:3d` starts supervisor, this client and the admin panel, and a player
 * can now roll a complete character without any of the other three ever running.
 *
 * ## The conversation, and where each half lives
 *
 * 1. `auth` — from `?account=&password=` on the URL, from a `sessionStorage` resume token, or from
 *    the form.
 * 2. `account` — the character list, and the fork. A name with an identity is entered; a name with
 *    history and no identity is answered by the server with `charAdopt`; a fresh name opens the
 *    cards.
 * 3. `charCreate` — a race and a calling, plus a name on a fresh mint and *no* name when adopting.
 *    The server answers `charRolled`; sending it again rerolls, and the bonus points reset with the
 *    dice because the server says so in the same message.
 * 4. `charConfirm` — the roll, plus whatever the five points were spent on. The mint's success
 *    signal is a *refreshed `account` message*, not an acknowledgement, and the client enters the
 *    new body off it.
 *
 * All 81 race/class pairs are legal. There is no restriction table anywhere in the server or in
 * `@mygame/shared`, and a class minimum is satisfied *inside* `rollScores` rather than by refusing
 * the combination — so nothing here greys anything out, and a gnome warrior is a gnome warrior.
 *
 * ## The panels, and the one measurement that shapes them
 *
 * Three panels in one card — `#gate-form`, `#gate-picker`, `#gate-cards` — and the cards panel is
 * itself three pages: race, calling, roll. The card widens from 22rem to 30rem while the cards are
 * up, because the longest bonus line the race data actually produces (Mountain Dwarf's six, 46
 * characters) wraps at the narrower width.
 *
 * ## Words and numbers, together, and why both
 *
 * `charRolled` carries `words` and `scores`, and the protocol's own docblocks explain the pair. The
 * words are the rule — *"deliberately never numbers: 'you learn your character is strong, not that
 * it is 88' survives the change of scale"* — and the numbers are the owner's amendment of
 * 2026-08-08: *"the actual number as well… so they don't spend all day trying for a maxed out
 * character or accepting a dud."* So the row reads `STR · very good · 16`: the word leads and takes
 * the ink, the number follows in a fixed-width right-aligned cell so all six form one column that
 * can be scanned in a glance, and **both track the spend live** — a point landing on a 15 turns
 * `good 15` into `very good 16` in the same repaint, which is the whole of the calibration being
 * asked for. The card also says how the dice work, for the same reason and from the same message.
 *
 * ## What the tab remembers, and what it deliberately does not
 *
 * - `mygame:resume`, `mygame:account`, `mygame:character` — as before.
 * - **Nothing about a roll in progress.** A half-finished character is page memory only. It cannot
 *   usefully be persisted: the server's half of the conversation (`creating`/`adopting`, a closure
 *   over the socket in `server/src/index.ts`) does not survive a reload either, so a restored card
 *   would be a picture of a conversation nobody else remembers.
 *
 * ## Surviving a reconnect — the rule this file already had, extended
 *
 * The bug this class was previously fixed for was found on the wire: `net.send` silently drops a
 * handshake message when the socket is not OPEN, and a resume token dies with every server restart,
 * so a submit landing in a reconnect window vanished without a word. Credentials are therefore held
 * in page memory ({@link LoginGate.typed}) and replayed on the next open. **A half-finished roll is
 * the same bug wearing a new hat**, and it is answered the same way:
 *
 * - The card's held state is an ordinary object in a page that never reloaded, so it survives the
 *   drop untouched — the player is still looking at exactly what they left.
 * - The *server's* half is what needs rebuilding, and `chargenResumeAction` (shared, unit-tested
 *   apart from any socket) decides how much: nothing while the player is only choosing, an `enter`
 *   to re-open an adoption, a `charCreate` once race and calling are both picked.
 * - A roll already on screen cannot be preserved — the dice lived in the dead closure — so the
 *   replay throws them again and the card *says so* rather than silently changing the numbers under
 *   the player's eyes.
 *
 * ### The one hazard the donor has and this does not: a confirm that died in flight
 *
 * `charConfirm` sets `pendingEnter`, and the *refreshed `account` list* is what consumes it. A
 * reconnect also produces an `account` message — so a confirm that never reached the server is
 * followed, one reconnect later, by an `enter` on a name that was never minted. The server's `enter`
 * claims a free name and spawns it identity-less (that is protocol 23's rule and the reason
 * `?character=` boots in one URL), so the failure mode is a body with no race, no calling and no
 * scores: precisely what this whole conversation exists to prevent.
 *
 * {@link LoginGate.generation} closes it. It counts sockets, `pendingEnter` records the one it was
 * sent on, and the enter only fires when the `account` message came back on that same socket — or
 * when the refreshed list proves the mint landed anyway, which is a `CharacterSummary` bearing this
 * name *with a `race` on it*. Anything else falls through to the resume path with the card intact.
 * (The 2D client consumes `pendingEnter` unconditionally and therefore still has this hazard; it is
 * out of this slice's remit, and named in the handoff instead.)
 *
 * ## One thing the donor needs and this does not
 *
 * The Phaser gate holds `enter` until the scene's handlers exist, because Phaser registers them in
 * `create()` — a frame or more after the module ran — and the world's answer to `enter` is
 * immediate. `main.ts` here registers every handler synchronously *before* `net.connect()`, so there
 * is no window to lose and no `setReady` to wait on. That is worth stating: the absence is a
 * consequence of the boot order, not an oversight, and reordering `main.ts` would reintroduce it.
 */

import {
  ABILITIES,
  CLASSES,
  CLASS_IDS,
  PROTOCOL_VERSION,
  RACES,
  RACE_IDS,
  SPELLS,
  chargenAdoptReplyAction,
  chargenResumeAction,
  characterNameProblem,
  racialBonuses,
  scoreWord,
  spendBonus,
  type Ability,
  type CharacterSummary,
  type ClassId,
  type ClientMessage,
  type RaceId,
  type ServerMessage,
} from '@mygame/shared';

import type { ConnectionState } from './net.ts';

const RESUME_KEY = 'mygame:resume';
const ACCOUNT_KEY = 'mygame:account';
const CHARACTER_KEY = 'mygame:character';

/**
 * The slice of `net.ts` this gate uses.
 *
 * Named as an interface rather than imported as the class so the state machine below can be driven
 * headlessly against a recorder. `Net` satisfies it structurally, so `main.ts` passes the real one
 * and nothing at the call site changes.
 */
export interface GateNet {
  readonly state: ConnectionState;
  send(message: ClientMessage): void;
  on<T extends ServerMessage['t']>(
    tag: T,
    handler: (message: Extract<ServerMessage, { t: T }>) => void,
  ): void;
}

/** Which step is waiting on the server, so an `authFailed` lands under the right caret. */
type Pending = 'none' | 'auth' | 'resume' | 'enter' | 'autoEnter' | 'chargen' | 'chargenResume';

/** Which page of the creation card is showing. The three are one conversation, not three panels. */
type Page = 'race' | 'class' | 'roll';

/**
 * The creation card's held state — protocol 24.
 *
 * `name` for a fresh mint, `adoptName` when a pre-identity save is deciding who it always was;
 * exactly one of the two is ever set, and which one is set is what decides whether the eventual
 * `charCreate` carries a name. `spend` is client-side bookkeeping that the server re-validates at
 * the confirm — this file validates it too, with the server's own {@link spendBonus}, so the card
 * cannot offer a spend the mint would refuse.
 */
interface Chargen {
  name?: string;
  adoptName?: string;
  race?: RaceId;
  class?: ClassId;
  words?: Readonly<Record<Ability, string>>;
  scores?: Readonly<Record<Ability, number>>;
  bonus: number;
  spend: Partial<Record<Ability, number>>;
  page: Page;
}

export class LoginGate {
  private readonly net: GateNet;
  private readonly overlay: HTMLElement;
  private readonly card: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly account: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private readonly create: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly picker: HTMLElement;
  private readonly characters: HTMLElement;
  private readonly newForm: HTMLFormElement;
  private readonly newName: HTMLInputElement;
  private readonly cards: HTMLElement;
  private readonly cardsTitle: HTMLElement;
  private readonly step: HTMLElement;
  private readonly choices: HTMLElement;
  private readonly rollPage: HTMLElement;
  private readonly scoreRows: HTMLElement;
  private readonly bonusLine: HTMLElement;
  private readonly diceLine: HTMLElement;

  /**
   * The name a `checkName` is outstanding for, or nothing.
   *
   * Holds the *question* rather than a boolean, because the answer echoes the name back and the
   * two have to be compared — see the `nameChecked` handler. Cleared on the answer, and on any
   * path that leaves the name step, so a late reply cannot reopen a panel the player has left.
   */
  private checking: string | undefined;

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
  /** The creation card, or nothing. Survives a reconnect by being an object in a live page. */
  private chargen: Chargen | undefined;
  /** Entered the moment the refreshed `account` list confirms the mint — see the header's hazard. */
  private pendingEnter: string | undefined;
  /**
   * Sockets, counted. Bumped by {@link onConnected}, which `main.ts` calls on every open.
   *
   * Its one reader is the `pendingEnter` gate: "did this `account` message come back on the socket
   * the confirm went out on?" is otherwise unanswerable, and answering it wrong mints a body with
   * no identity. Nothing else in the gate cares which connection it is on.
   */
  private generation = 0;
  private pendingEnterGeneration = -1;

  /** Raised while the overlay is up. `main.ts` folds it into the keyboard gate with the log's. */
  onVisibility: ((visible: boolean) => void) | undefined;

  constructor(net: GateNet) {
    // Explicit fields, assigned here: Node's type stripping rejects parameter properties outright
    // (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `CLAUDE.md` gotcha 8), and `login.test.ts` imports this
    // module into a bare Node process.
    this.net = net;
    this.overlay = grab('gate');
    this.card = grab('gate-card');
    this.form = grab('gate-form') as HTMLFormElement;
    this.account = grab('gate-account') as HTMLInputElement;
    this.password = grab('gate-password') as HTMLInputElement;
    this.create = grab('gate-create') as HTMLInputElement;
    this.error = grab('gate-error');
    this.picker = grab('gate-picker');
    this.characters = grab('gate-characters');
    this.newForm = grab('gate-new') as HTMLFormElement;
    this.newName = grab('gate-new-name') as HTMLInputElement;
    this.cards = grab('gate-cards');
    this.cardsTitle = grab('gate-cards-title');
    this.step = grab('gate-step');
    this.choices = grab('gate-choices');
    this.rollPage = grab('gate-roll');
    this.scoreRows = grab('gate-scores');
    this.bonusLine = grab('gate-bonus');
    this.diceLine = grab('gate-dice');

    this.account.value = read(ACCOUNT_KEY) ?? '';

    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      const account = this.account.value.trim();
      const password = this.password.value;
      if (!account || !password) return this.say('account and password, both');
      write(ACCOUNT_KEY, account);
      this.handsFree = false;
      // Captured before the send, because the send may not happen: a socket mid-reconnect drops
      // handshakes silently, and `onConnected` replays this the moment the next one opens.
      this.typed = { account, password, create: this.create.checked };
      if (this.net.state !== 'open') {
        // The truth beats a swallowed click: the attempt is queued in `typed` and fires itself.
        this.say('reconnecting — entering as soon as the server answers');
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
      if (!name) return;
      // **Protocol 32: the name is judged here, at the step that asked for it.**
      //
      // It used to open the cards immediately, on the reasoning that "the server owns every
      // refusal". That is still true and was still the wrong place to stop: the name only travels on
      // `charCreate`, which is not sent until a race *and* a calling are chosen, so `that name is
      // taken` arrived two decisions later on a different panel. The owner met it on their first
      // real roll — *"it didn't tell me the name was taken until I went to select a class"*.
      //
      // Two questions, and only one of them is the server's. The law — length, letters, reserved
      // words, rude roots, the Realms' own famous names — lives in `@mygame/shared` so that both
      // sides can run it, so it is run **here, with no round trip at all**. Only a name that passes
      // it is worth asking about, and the one thing the client cannot know is whether a free-looking
      // name is already spoken for on somebody else's account.
      const problem = characterNameProblem(name);
      if (problem) {
        this.say(problem);
        return;
      }
      this.checking = name;
      this.say('checking that name…');
      this.net.send({ t: 'checkName', name });
    });

    net.on('nameChecked', (message) => {
      // **Answering a question we have moved on from is the failure this guard exists for.** A
      // player who submits, edits and submits again has two answers in flight and no promise about
      // their order; opening the cards on the older one would carry the wrong name into the mint.
      if (this.checking === undefined || message.name !== this.checking) return;
      this.checking = undefined;
      if (message.problem) {
        this.say(message.problem);
        return;
      }
      this.hideError();
      this.startCards({ name: message.name.trim() });
    });

    grab('gate-back').addEventListener('click', () => this.back());
    grab('gate-reroll').addEventListener('click', () => this.sendCreate());
    grab('gate-confirm').addEventListener('click', () => this.confirm());

    net.on('account', (message) => {
      this.last = message;
      write(RESUME_KEY, message.resume);
      if (this.takePendingEnter(message)) return;
      if (this.chargen) {
        // Reached only on a reconnect: the very first `account` a tab ever receives is what opens
        // the picker, and `chargen` cannot be set before that has happened once. The card is still
        // on screen — nothing here touched it while the socket was down — so the job is to rebuild
        // the server's half of the conversation, not to show anything new.
        this.resumeChargen();
        return;
      }
      const wanted = params().get('character') ?? read(CHARACTER_KEY);
      if (wanted && (this.handsFree || message.characters.some((c) => c.name === wanted))) {
        this.enter(wanted, 'autoEnter');
        return;
      }
      this.showPicker(message.account, message.characters, message.max);
    });

    net.on('charRolled', (message) => {
      const held = this.chargen;
      if (!held) return;
      this.pending = 'none';
      // Race and calling come back off the wire rather than being assumed: a reroll replayed after
      // a reconnect is answered by the server's idea of what is being rolled, and if those two ever
      // disagreed the card should show the server's.
      held.race = message.race;
      held.class = message.class;
      held.words = message.words;
      held.scores = message.scores;
      held.bonus = message.bonus;
      held.spend = {};
      held.page = 'roll';
      this.showRoll();
    });

    net.on('charAdopt', (message) => {
      this.pending = 'none';
      // Ordinarily the first answer to a picker click on a pre-identity save: same cards, no name
      // step, history kept. But it is also what a reconnect's replayed `enter` gets back once the
      // server's `adopting` is rebuilt — and by then the cards may already hold a race or calling
      // the player chose while offline (or a `charCreate` the dead socket swallowed). Only
      // `openCards` resets the cards; the other two leave them exactly as found.
      const action = chargenAdoptReplyAction(this.chargen, message.name);
      switch (action.kind) {
        case 'openCards':
          this.startCards({ adoptName: message.name });
          return;
        case 'sendCreate':
          this.sendCreate();
          if (this.chargen?.words) this.say('The connection dropped — the dice were thrown again.');
          return;
        case 'wait':
          return;
      }
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
      if (was === 'chargen') {
        // A name taken while rolling, a spend that overreached, a race the server does not know:
        // all of them leave the card exactly where it is, because the card is where the fix is.
        this.pendingEnter = undefined;
        this.say(message.reason);
        return;
      }
      if (was === 'chargenResume') {
        // The replayed `enter` was refused — the name was claimed while the connection was down,
        // the account no longer owns it, whatever. Held state cannot be trusted after that, so the
        // card is dropped cleanly and the reason is plain, rather than sitting on a conversation
        // that cannot be rebuilt.
        this.chargen = undefined;
        this.pendingEnter = undefined;
        this.toLastPanel();
        this.say('The connection was lost — start again.');
        return;
      }
      if (was === 'autoEnter') clear(CHARACTER_KEY);
      this.toLastPanel();
      this.say(message.reason);
    });

    net.on('rejected', (message) => this.say(`Rejected: ${message.reason}`));

    net.on('welcome', () => {
      this.pending = 'none';
      this.chargen = undefined;
      this.pendingEnter = undefined;
      this.overlay.hidden = true;
      this.onVisibility?.(false);
    });
  }

  /** Called on every socket open: hands-free where the tab can manage it, the form otherwise. */
  onConnected(): void {
    this.generation += 1;
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

  /* ------------------------------------------------------------------ steps */

  /**
   * The `pendingEnter` gate — the whole of the header's in-flight-confirm hazard, in one place.
   *
   * True means this message was consumed and the caller must stop. The mint is believed on two
   * grounds and no others: the answer came back on the socket the confirm went out on, or the
   * refreshed list names this character *with a race*, which only a completed mint can produce.
   */
  private takePendingEnter(message: Extract<ServerMessage, { t: 'account' }>): boolean {
    const target = this.pendingEnter;
    if (target === undefined) return false;
    const sameSocket = this.pendingEnterGeneration === this.generation;
    const minted = message.characters.some((c) => c.name === target && c.race !== undefined);
    this.pendingEnter = undefined;
    if (!sameSocket && !minted) return false; // the confirm died with the socket; the card stands
    this.chargen = undefined;
    this.enter(target, 'enter');
    return true;
  }

  private enter(name: string, step: 'enter' | 'autoEnter'): void {
    this.pending = step;
    write(CHARACTER_KEY, name);
    this.net.send({ t: 'enter', name });
  }

  /**
   * Reached from the `account` handler whenever a reconnect lands while the card is open.
   *
   * The card itself needs nothing rebuilt — it never touched the dead socket — so this only replays
   * what the server's now-empty `creating`/`adopting` needs before the card's next click can mean
   * anything again. `chargenResumeAction` is the pure decision, unit-tested in `@mygame/shared`.
   */
  private resumeChargen(): void {
    const held = this.chargen;
    if (!held) return;
    const action = chargenResumeAction(held);
    switch (action.kind) {
      case 'reopenAdoption':
        // `charAdopt`'s handler recognises this as a replay (the name already matches what is
        // held) and leaves the cards alone rather than resetting them.
        this.pending = 'chargenResume';
        this.net.send({ t: 'enter', name: action.name });
        return;
      case 'sendCreate': {
        // The dice cannot survive: they lived in the server's dead closure. Throwing them again is
        // the only honest recovery, so the card says it rather than quietly changing six numbers.
        const rerolled = held.words !== undefined;
        this.sendCreate();
        if (rerolled) this.say('The connection dropped — the dice were thrown again.');
        return;
      }
      case 'none':
        return;
    }
  }

  /** `charCreate` — the first ask and every reroll. The bonus points reset with the dice. */
  private sendCreate(): void {
    const held = this.chargen;
    if (!held || !held.race || !held.class) return;
    if (this.net.state !== 'open') {
      // Dropping in silence is the bug this file exists to have fixed. `resumeChargen` will send
      // this again off the next `account`, so the sentence is a promise the code keeps.
      this.say('reconnecting — the dice go as soon as the server answers');
      return;
    }
    this.pending = 'chargen';
    this.hideError();
    this.net.send({
      t: 'charCreate',
      ...(held.name !== undefined ? { name: held.name } : {}),
      race: held.race,
      class: held.class,
    });
  }

  /** `charConfirm` — the mint. The refreshed `account` list is what says it worked. */
  private confirm(): void {
    const held = this.chargen;
    if (!held || !held.words) return;
    if (this.net.state !== 'open') {
      // Deliberately *not* queued: the reconnect's replay is a `charCreate`, so a confirm parked
      // here would be answered by different dice. Say what will actually happen.
      this.say('reconnecting — the dice will be thrown again when the server answers');
      return;
    }
    this.pending = 'chargen';
    this.pendingEnter = held.adoptName ?? held.name;
    this.pendingEnterGeneration = this.generation;
    this.hideError();
    this.net.send({ t: 'charConfirm', spend: held.spend });
  }

  /** One page back: roll → calling → race → the picker, dropping the card at the last step. */
  private back(): void {
    const held = this.chargen;
    if (!held) return this.toLastPanel();
    if (held.page === 'roll') {
      held.page = 'class';
      this.showClasses();
      return;
    }
    if (held.page === 'class') {
      held.page = 'race';
      this.showRaces();
      return;
    }
    this.chargen = undefined;
    this.pendingEnter = undefined;
    this.toLastPanel();
  }

  /* ----------------------------------------------------------------- panels */

  private toLastPanel(): void {
    if (this.last) this.showPicker(this.last.account, this.last.characters, this.last.max);
    else this.showForm();
  }

  private showForm(): void {
    this.stopChecking();
    this.overlay.hidden = false;
    this.picker.hidden = true;
    this.cards.hidden = true;
    this.form.hidden = false;
    this.card.className = 'card';
    this.hideError();
    this.onVisibility?.(true);
    this.account.focus();
  }

  /** Any path that leaves the name step drops an outstanding question with it. */
  private stopChecking(): void {
    this.checking = undefined;
  }

  private showPicker(account: string, characters: readonly CharacterSummary[], max: number): void {
    this.stopChecking();
    this.overlay.hidden = false;
    this.form.hidden = true;
    this.cards.hidden = true;
    this.picker.hidden = false;
    this.card.className = 'card';
    this.hideError();
    grab('gate-picker-title').textContent = account ? `${account} — choose a body` : 'choose a body';
    this.characters.replaceChildren(
      ...characters.map((character) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'gate-character';
        const name = document.createElement('b');
        name.textContent = character.name;
        const facts: string[] = [];
        if (character.level !== undefined) facts.push(`level ${character.level}`);
        // Protocol 24 put race and class on the summary precisely so the picker can say what a body
        // is — and so the one body that will *ask* can be recognised before it is clicked. A save
        // from before the phase has neither, and clicking it opens the cards rather than the world.
        if (character.race && character.class) {
          facts.push(`${RACES[character.race].name} ${CLASSES[character.class].name}`);
        } else {
          facts.push('no identity yet');
        }
        const detail = document.createElement('span');
        detail.textContent = ` · ${facts.join(' · ')}`;
        row.append(name, detail);
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
  private startCards(start: { name?: string; adoptName?: string }): void {
    this.stopChecking();
    this.chargen = { ...start, bonus: 0, spend: {}, page: 'race' };
    this.overlay.hidden = false;
    this.form.hidden = true;
    this.picker.hidden = true;
    this.cards.hidden = false;
    this.card.className = 'card wide';
    this.hideError();
    this.onVisibility?.(true);
    this.showRaces();
  }

  private showRaces(): void {
    const held = this.chargen;
    if (!held) return;
    this.cardsTitle.textContent = held.adoptName
      ? `Who was ${held.adoptName} all along?`
      : `${held.name} — choose a race`;
    this.step.textContent = held.adoptName
      ? 'The level, the map and the kit are kept. Only who they always were is in question.'
      : 'Blood first: it moves every score before the dice are thrown, and it never changes again.';
    this.rollPage.hidden = true;
    this.choices.hidden = false;
    this.choices.replaceChildren(
      ...RACE_IDS.map((id) => {
        const race = RACES[id];
        const bonuses = racialBonuses(race);
        // Derived from `factors`, never transcribed: `racialBonuses` is the one implementation the
        // server rolls with, so a card and a roll cannot disagree about what a race is worth.
        const traits = ABILITIES.filter((a) => bonuses[a] !== 0)
          .map((a) => `${bonuses[a] > 0 ? '+' : '−'}${Math.abs(bonuses[a])} ${a.toUpperCase()}`)
          .join('  ');
        // `manaFactor` is already a percentage of the class pool in the data ("human 100"), so it
        // is printed as one rather than folded into a multiplier that would need rounding.
        const facts = [
          race.size,
          race.vision === 'normal' ? 'ordinary eyes' : race.vision,
          `mana ${race.manaFactor}%`,
        ];
        if (race.hpBonus !== 0) {
          facts.push(`${race.hpBonus > 0 ? '+' : '−'}${Math.abs(race.hpBonus)} hp a level`);
        }
        if (race.magicResistant) facts.push('shrugs off magic');
        if (race.sunVulnerable) facts.push('burns in sunlight');
        return this.choice(race.name, traits || 'no favours, no debts', facts.join(' · '), race.flavour, () => {
          held.race = id;
          held.page = 'class';
          this.showClasses();
        });
      }),
    );
  }

  private showClasses(): void {
    const held = this.chargen;
    if (!held || !held.race) return;
    const who = held.adoptName ?? held.name;
    this.cardsTitle.textContent = `${who} the ${RACES[held.race].name} — choose a calling`;
    // No combination is refused: `rollScores` raises a short ability to the class minimum rather
    // than turning the pair away, which is why nothing here is greyed out and why the minimums are
    // printed on the card. All 81 pairs are legal, and the roll is where that is decided.
    this.step.textContent =
      'Every calling is open to every race. A score below a calling’s minimum is raised to it by the roll, not refused.';
    this.rollPage.hidden = true;
    this.choices.hidden = false;
    this.choices.replaceChildren(
      ...CLASS_IDS.map((id) => {
        const spec = CLASSES[id];
        const traits = [`d${spec.hitDie} hit die`];
        traits.push(
          spec.casting
            ? `${spec.casting.kind} caster${spec.casting.opensAt > 1 ? ` from level ${spec.casting.opensAt}` : ''}`
            : 'no spells, no apologies',
        );
        const mins = ABILITIES.filter((a) => spec.mins[a] !== undefined)
          .map((a) => `${a.toUpperCase()} ${spec.mins[a]!}`)
          .join(' · ');
        const facts = mins ? `needs ${mins}` : 'no minimum worth the name';
        const known =
          spec.spells.length > 0 ? `${spec.spells.map((s) => SPELLS[s].name).join(', ')}` : undefined;
        return this.choice(spec.name, traits.join(' · '), known ? `${facts} · ${known}` : facts, spec.flavour, () => {
          held.class = id;
          this.sendCreate();
        });
      }),
    );
  }

  /** One row of the race or calling list. Four lines, because four facts are what decides a pick. */
  private choice(
    title: string,
    traits: string,
    facts: string,
    blurb: string,
    onPick: () => void,
  ): HTMLElement {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'gate-choice';
    const name = document.createElement('b');
    name.textContent = title;
    const traitLine = document.createElement('span');
    traitLine.className = 'traits';
    traitLine.textContent = traits;
    const factLine = document.createElement('span');
    factLine.className = 'facts';
    factLine.textContent = facts;
    const blurbLine = document.createElement('span');
    blurbLine.className = 'blurb';
    blurbLine.textContent = blurb;
    row.append(name, traitLine, factLine, blurbLine);
    row.addEventListener('click', onPick);
    return row;
  }

  /** The points spent so far, which is the only number the `+` buttons are gated on besides the cap. */
  private spent(): number {
    const held = this.chargen;
    if (!held) return 0;
    return ABILITIES.reduce((sum, a) => sum + (held.spend[a] ?? 0), 0);
  }

  /**
   * The roll — words and numbers, and the dice explained.
   *
   * Deliberately does **not** clear the error line: a reconnect's "the dice were thrown again" is
   * set before the replacement roll arrives, and it is exactly the notice that must survive it.
   */
  private showRoll(): void {
    const held = this.chargen;
    if (!held || !held.words || !held.scores || !held.race || !held.class) return;
    const scores = held.scores;
    const race = held.race;
    this.cardsTitle.textContent = `${held.adoptName ?? held.name} the ${RACES[race].name} ${CLASSES[held.class].name}`;
    this.step.textContent = 'What the dice said, and the five points that answer them.';
    this.choices.hidden = true;
    this.rollPage.hidden = false;

    // The server's own arithmetic, called with the client's own spend: one implementation, so the
    // number on the card is the number the mint will store. `ok` is false only for a spend this
    // card refused to build, which is why the fallback is the untouched roll rather than an error.
    const applied = spendBonus(scores, held.spend, race);
    const shown = applied.ok ? applied.scores : scores;
    const left = held.bonus - this.spent();
    this.bonusLine.textContent =
      left > 0 ? `${left} point${left === 1 ? '' : 's'} to spend` : 'every point spent';
    // The dice, explained — the owner's reason: nobody should grind for an impossible twenty or
    // keep a dud because the odds were a mystery. Written here rather than in the markup, and from
    // the message's own `bonus`, so the sentence cannot drift from the roll that was actually made.
    // 4d6-drop-lowest is 3–18 with a mean of 12.24 (`rollFourDropLowest`, `shared/src/scores.ts`);
    // the racial bonus lands inside the roll and the class minimum on top of it, in that order.
    this.diceLine.textContent =
      `Each score: 4d6, drop the lowest — 3 to 18, average just over 12 — then ${RACES[race].name} ` +
      `bonuses, raised to ${CLASSES[held.class].name} minimums. Reroll as often as you like; ` +
      `the ${held.bonus} points reset with the dice.`;

    this.scoreRows.replaceChildren(
      ...ABILITIES.map((ability) => {
        const row = document.createElement('div');
        row.className = 'score-row';
        const label = document.createElement('span');
        label.className = 'ab';
        label.textContent = ability;
        // The word leads and the number follows, and both are read off the *spent* scores: a point
        // landing on 15 shows "very good 16" in the same repaint, which is the calibration the
        // owner asked for. The word is `scoreWord`'s, the server's own ladder.
        const value = shown[ability];
        const word = document.createElement('span');
        word.className = 'word';
        word.textContent = scoreWord(value);
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(value);
        const spentHere = held.spend[ability] ?? 0;
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
        // Gated on the server's own refusal, not on a copy of its rules: `spendBonus` owns both the
        // five-point budget and the buy cap (18, plus whatever the race carries above it), and it
        // is asked here with the exact spend the button would produce. So the card can never build
        // a spend the mint would reject — the `authFailed` path below is for the races it *can*.
        more.disabled = !this.canSpend(ability);
        more.addEventListener('click', () => {
          if (!this.canSpend(ability)) return;
          held.spend[ability] = (held.spend[ability] ?? 0) + 1;
          this.showRoll();
        });
        row.append(label, word, num, plus, minus, more);
        return row;
      }),
    );
  }

  /** Whether one more point may land on this ability — asked of `spendBonus`, never re-derived. */
  private canSpend(ability: Ability): boolean {
    const held = this.chargen;
    if (!held || !held.scores || !held.race) return false;
    if (this.spent() >= held.bonus) return false;
    const next: Partial<Record<Ability, number>> = { ...held.spend };
    next[ability] = (held.spend[ability] ?? 0) + 1;
    return spendBonus(held.scores, next, held.race).ok;
  }

  private say(text: string): void {
    this.error.textContent = text;
    this.error.hidden = false;
  }

  private hideError(): void {
    this.error.textContent = '';
    this.error.hidden = true;
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
