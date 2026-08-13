/**
 * The front door's state machine, headless — protocol 23's handshake and protocol 24's cards.
 *
 * `session.test.ts` is the model for this file: drive the real object the way `main.ts` does rather
 * than prod one function, because every bug a gate can actually ship is a wiring bug. What is
 * different here is that the thing being driven is DOM, and this package has no jsdom and wants
 * none — `three` builds object graphs in bare Node and that is the property the whole suite rests
 * on. So the document is a stub, ninety lines of it, and it is **built from `index.html` itself**:
 * `getElementById` answers only for ids that are actually in the shipped markup, and `grab()` throws
 * for anything else. An id deleted from the page therefore fails this file rather than the browser,
 * which is the only reason a stub document is worth having at all.
 *
 * What the stub does *not* model is layout, focus order, CSS, or event bubbling. Nothing here
 * asserts anything about those, and a test that wanted to would need a real browser.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ABILITIES,
  BONUS_POINTS,
  PROTOCOL_VERSION,
  scoreWord,
  type Ability,
  type CharacterSummary,
  type ClassId,
  type ClientMessage,
  type RaceId,
  type ServerMessage,
} from '@mygame/shared';

import { LoginGate, type GateNet } from './login.ts';

/* -------------------------------------------------------------------------- */
/* The stub document                                                           */
/* -------------------------------------------------------------------------- */

/** Every `id="…"` the shipped page carries. The stub serves these and refuses everything else. */
const MARKUP_IDS: ReadonlySet<string> = new Set(
  [
    ...readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8').matchAll(/id="([^"]+)"/g),
  ].map((match) => match[1]!),
);

type Listener = (event: { preventDefault: () => void }) => void;

/** One element. Enough of the shape for `login.ts` and no more — see the file header. */
class StubNode {
  readonly id: string;
  className = '';
  type = '';
  hidden = false;
  disabled = false;
  value = '';
  checked = false;
  focused = false;
  children: StubNode[] = [];
  private own = '';
  private readonly listeners = new Map<string, Listener[]>();

  constructor(id = '') {
    this.id = id;
  }

  /** Own text when it is a leaf, the children's concatenated when it is not — as the DOM's is. */
  get textContent(): string {
    if (this.children.length > 0) return this.children.map((child) => child.textContent).join('');
    return this.own;
  }

  set textContent(value: string) {
    this.own = value;
    this.children = [];
  }

  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.children = nodes;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  focus(): void {
    this.focused = true;
  }

  /** The half a test needs that a browser supplies: fire what a click or a submit would fire. */
  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => {} });
  }
}

class StubDocument {
  private readonly byId = new Map<string, StubNode>();

  getElementById(id: string): StubNode | null {
    if (!MARKUP_IDS.has(id)) return null; // the page does not carry it, so neither does the stub
    let node = this.byId.get(id);
    if (!node) {
      node = new StubNode(id);
      this.byId.set(id, node);
    }
    return node;
  }

  createElement(): StubNode {
    return new StubNode();
  }
}

/** A page: a fresh document, a fresh sessionStorage, and a URL with the given query on it. */
function newPage(search = ''): StubDocument {
  const doc = new StubDocument();
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  // `defineProperty` rather than assignment: whether the DOM lib declares these as `var` or `const`
  // is a lib-version detail, and a test should not depend on it.
  for (const [name, value] of [
    ['document', doc],
    ['sessionStorage', storage],
    ['location', { search }],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  return doc;
}

/* -------------------------------------------------------------------------- */
/* The fake socket                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `GateNet`, recorded.
 *
 * `send` drops when the connection is not open, because `Net` does exactly that for handshake
 * messages — silently, by design, with a comment promising "login.ts reacts to state changes" — and
 * the whole of this gate's replay machinery exists to survive it. A fake that queued instead would
 * be testing a client that does not ship.
 */
class FakeNet implements GateNet {
  state: 'connecting' | 'open' | 'closed' = 'open';
  readonly sent: ClientMessage[] = [];
  private readonly handlers = new Map<string, ((message: ServerMessage) => void)[]>();

  send(message: ClientMessage): void {
    if (this.state !== 'open') return;
    this.sent.push(message);
  }

  on<T extends ServerMessage['t']>(
    tag: T,
    handler: (message: Extract<ServerMessage, { t: T }>) => void,
  ): void {
    const list = this.handlers.get(tag) ?? [];
    list.push(handler as unknown as (message: ServerMessage) => void);
    this.handlers.set(tag, list);
  }

  deliver(message: ServerMessage): void {
    for (const handler of this.handlers.get(message.t) ?? []) handler(message);
  }

  /** Everything sent since the mark — the shape most assertions below actually want. */
  since(mark: number): ClientMessage[] {
    return this.sent.slice(mark);
  }

  lastOf<T extends ClientMessage['t']>(tag: T): Extract<ClientMessage, { t: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      const message = this.sent[i]!;
      if (message.t === tag) return message as Extract<ClientMessage, { t: T }>;
    }
    return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Driving the card                                                            */
/* -------------------------------------------------------------------------- */

function el(doc: StubDocument, id: string): StubNode {
  const node = doc.getElementById(id);
  assert.ok(node, `${id} is not an id in index.html`);
  return node;
}

/** A choice button by the name on it — the `<b>` is always the row's first child. */
function pick(doc: StubDocument, label: string): StubNode {
  const rows = el(doc, 'gate-choices').children;
  const found = rows.find((row) => row.children[0]?.textContent === label);
  assert.ok(found, `no choice named ${label}; saw ${rows.map((r) => r.children[0]?.textContent).join(', ')}`);
  return found;
}

/** The six rows of the roll, unpacked: `[ab, word, num, plus, minus, more]` in `showRoll`'s order. */
function rollRows(
  doc: StubDocument,
): { ability: string; word: string; num: string; minus: StubNode; more: StubNode }[] {
  return el(doc, 'gate-scores').children.map((row) => ({
    ability: row.children[0]!.textContent,
    word: row.children[1]!.textContent,
    num: row.children[2]!.textContent,
    minus: row.children[4]!,
    more: row.children[5]!,
  }));
}

function rolled(
  race: RaceId,
  klass: ClassId,
  scores: Record<Ability, number>,
): Extract<ServerMessage, { t: 'charRolled' }> {
  const words = {} as Record<Ability, string>;
  for (const ability of ABILITIES) words[ability] = scoreWord(scores[ability]);
  return { t: 'charRolled', race, class: klass, words, scores, bonus: BONUS_POINTS };
}

function accountMessage(
  characters: readonly CharacterSummary[],
): Extract<ServerMessage, { t: 'account' }> {
  return { t: 'account', account: 'dev', characters, max: 16, resume: 'tok' };
}

/** Form, submit, `account` — the two steps every creation test starts from. */
function signedIn(
  net: FakeNet,
  doc: StubDocument,
  characters: readonly CharacterSummary[] = [],
): LoginGate {
  const gate = new LoginGate(net);
  gate.onConnected();
  el(doc, 'gate-account').value = 'dev';
  el(doc, 'gate-password').value = 'devpass';
  el(doc, 'gate-form').fire('submit');
  net.deliver(accountMessage(characters));
  return gate;
}

/**
 * A socket that dropped and came back.
 *
 * `main.ts` calls `onConnected` on every open, and from this object's point of view that is the
 * whole of a reconnect: the credentials it kept replay themselves, and the `account` that follows
 * is what carries the card's recovery.
 */
function reconnect(gate: LoginGate, net: FakeNet): void {
  net.state = 'closed';
  net.state = 'open';
  gate.onConnected();
}

const DEV_AUTH = { t: 'auth', protocol: PROTOCOL_VERSION, account: 'dev', password: 'devpass' } as const;
const MODEST: Record<Ability, number> = { str: 10, dex: 12, con: 11, int: 15, wis: 9, cha: 13 };

/* -------------------------------------------------------------------------- */

describe('the 3D gate, end to end', () => {
  it('walks a fresh name through race, calling, roll, reroll, spend and mint', () => {
    const doc = newPage();
    const net = new FakeNet();
    signedIn(net, doc);

    // The picker, and the one thing protocol 24 changed about it: a new name opens the cards and
    // claims nothing. Nothing may go out until a calling has been chosen too.
    assert.equal(el(doc, 'gate-picker').hidden, false);
    el(doc, 'gate-new-name').value = 'Threeby';
    el(doc, 'gate-new').fire('submit');
    assert.equal(el(doc, 'gate-cards').hidden, false);
    assert.equal(el(doc, 'gate-picker').hidden, true);
    assert.equal(el(doc, 'gate-cards-title').textContent, 'Threeby — choose a race');
    assert.equal(el(doc, 'gate-choices').children.length, 9, 'nine races');
    assert.equal(net.lastOf('charCreate'), undefined, 'the name was claimed before the cards were filled in');

    // Race, then calling. All 81 pairs are legal, so nothing is ever disabled on either page.
    pick(doc, 'Gnome').fire('click');
    assert.equal(el(doc, 'gate-choices').children.length, 9, 'nine callings');
    assert.equal(
      el(doc, 'gate-choices').children.filter((row) => row.disabled).length,
      0,
      'a race/calling pair was greyed out; all 81 are legal',
    );
    const beforeCreate = net.sent.length;
    pick(doc, 'Sorcerer').fire('click');
    assert.deepEqual(net.since(beforeCreate), [
      { t: 'charCreate', name: 'Threeby', race: 'gnome', class: 'sorcerer' },
    ]);

    // The roll: one row per ability, the word leading and the number beside it.
    net.deliver(rolled('gnome', 'sorcerer', MODEST));
    assert.equal(el(doc, 'gate-roll').hidden, false);
    assert.equal(el(doc, 'gate-choices').hidden, true);
    assert.deepEqual(rollRows(doc).map((row) => `${row.ability} ${row.word} ${row.num}`), [
      'str average 10',
      'dex above average 12',
      'con average 11',
      'int good 15',
      'wis below average 9',
      'cha above average 13',
    ]);
    assert.equal(el(doc, 'gate-bonus').textContent, '5 points to spend');
    assert.match(el(doc, 'gate-dice').textContent, /4d6, drop the lowest/, 'the card must say how the dice work');
    assert.match(el(doc, 'gate-dice').textContent, /Gnome bonuses, raised to Sorcerer minimums/);

    // A reroll is the same message again, and the points come back with the dice.
    const beforeReroll = net.sent.length;
    el(doc, 'gate-reroll').fire('click');
    assert.deepEqual(net.since(beforeReroll), [
      { t: 'charCreate', name: 'Threeby', race: 'gnome', class: 'sorcerer' },
    ]);
    net.deliver(rolled('gnome', 'sorcerer', { ...MODEST, str: 15 }));
    assert.equal(rollRows(doc)[0]!.num, '15');
    assert.equal(el(doc, 'gate-bonus').textContent, '5 points to spend');

    // The spend, and the owner's amendment: word and number move together. 15 → 16 is exactly the
    // boundary where `good` becomes `very good`, which is why it is the one asserted.
    rollRows(doc)[0]!.more.fire('click');
    assert.equal(rollRows(doc)[0]!.word, 'very good');
    assert.equal(rollRows(doc)[0]!.num, '16');
    assert.equal(el(doc, 'gate-bonus').textContent, '4 points to spend');
    rollRows(doc)[0]!.more.fire('click');
    assert.equal(rollRows(doc)[0]!.num, '17');
    rollRows(doc)[0]!.minus.fire('click');
    assert.equal(rollRows(doc)[0]!.num, '16');
    assert.equal(el(doc, 'gate-bonus').textContent, '4 points to spend');

    // The mint, and the refreshed list that is its only success signal.
    const beforeConfirm = net.sent.length;
    el(doc, 'gate-confirm').fire('click');
    assert.deepEqual(net.since(beforeConfirm), [{ t: 'charConfirm', spend: { str: 1 } }]);
    net.deliver(accountMessage([{ name: 'Threeby', level: 1, race: 'gnome', class: 'sorcerer' }]));
    assert.deepEqual(net.lastOf('enter'), { t: 'enter', name: 'Threeby' });

    net.deliver({ t: 'welcome', protocol: PROTOCOL_VERSION, you: 1, tickMs: 100, roundMs: 3000 });
    assert.equal(el(doc, 'gate').hidden, true, 'the overlay outlived the welcome');
  });

  it('adopts a pre-identity save with the same cards, no name step and a nameless charCreate', () => {
    const doc = newPage();
    const net = new FakeNet();
    // A body with history and no identity — exactly what the picker has to be able to show as such.
    signedIn(net, doc, [{ name: 'Aldric', level: 12 }]);
    assert.equal(el(doc, 'gate-characters').textContent, 'Aldric · level 12 · no identity yet');

    el(doc, 'gate-characters').children[0]!.fire('click');
    assert.deepEqual(net.lastOf('enter'), { t: 'enter', name: 'Aldric' });
    net.deliver({ t: 'charAdopt', name: 'Aldric' });

    assert.equal(el(doc, 'gate-cards').hidden, false);
    assert.equal(el(doc, 'gate-cards-title').textContent, 'Who was Aldric all along?');
    pick(doc, 'Drow').fire('click');
    const mark = net.sent.length;
    pick(doc, 'Warrior').fire('click');
    // Nameless: the server's `adopting` owns the name, and carrying one would be a fresh mint.
    assert.deepEqual(net.since(mark), [{ t: 'charCreate', race: 'drow', class: 'warrior' }]);

    net.deliver(rolled('drow', 'warrior', MODEST));
    el(doc, 'gate-confirm').fire('click');
    assert.deepEqual(net.lastOf('charConfirm'), { t: 'charConfirm', spend: {} });
    // The level survives the adoption — the server keeps it — and the refreshed row now has a race.
    net.deliver(accountMessage([{ name: 'Aldric', level: 12, race: 'drow', class: 'warrior' }]));
    assert.deepEqual(net.lastOf('enter'), { t: 'enter', name: 'Aldric' });
  });

  it('refuses an overreaching spend at the card, and survives one refused at the server', () => {
    const doc = newPage();
    const net = new FakeNet();
    signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Spender';
    el(doc, 'gate-new').fire('submit');
    pick(doc, 'Human').fire('click');
    pick(doc, 'Warrior').fire('click');
    // Human carries no racial bonus anywhere, so its buy cap is a flat 18 — which puts STR 17 one
    // point under the ceiling and leaves the rest of the card a plain budget question.
    net.deliver(rolled('human', 'warrior', { str: 17, dex: 12, con: 11, int: 10, wis: 10, cha: 10 }));

    // The cap: one point takes STR to 18 and the second is refused though four points remain.
    rollRows(doc)[0]!.more.fire('click');
    assert.equal(rollRows(doc)[0]!.num, '18');
    assert.equal(el(doc, 'gate-bonus').textContent, '4 points to spend');
    assert.equal(rollRows(doc)[0]!.more.disabled, true, 'the card offered a buy past the cap');
    rollRows(doc)[0]!.more.fire('click');
    assert.equal(rollRows(doc)[0]!.num, '18', 'a disabled button still spent a point');

    // The budget: the other four land, and then every `+` on the card is dead.
    for (let i = 0; i < 4; i++) rollRows(doc)[1]!.more.fire('click');
    assert.equal(el(doc, 'gate-bonus').textContent, 'every point spent');
    assert.deepEqual(rollRows(doc).map((row) => row.more.disabled), [true, true, true, true, true, true]);
    rollRows(doc)[2]!.more.fire('click');
    assert.equal(rollRows(doc)[2]!.num, '11', 'a sixth point landed anyway');
    assert.deepEqual(net.lastOf('charConfirm'), undefined);

    // And the server's own refusal — the contract `spendBonus` states, reachable for a spend this
    // card would not have built — leaves the card open with the reason on it. The card is the fix.
    el(doc, 'gate-confirm').fire('click');
    assert.deepEqual(net.lastOf('charConfirm'), { t: 'charConfirm', spend: { str: 1, dex: 4 } });
    net.deliver({ t: 'authFailed', reason: 'only 5 points to spend' });
    assert.equal(el(doc, 'gate-cards').hidden, false, 'a refused spend threw the whole card away');
    assert.equal(el(doc, 'gate-error').textContent, 'only 5 points to spend');

    // And it must not leave a pending enter behind: the next `account` would otherwise walk into a
    // body that was never minted.
    const mark = net.sent.length;
    net.deliver(accountMessage([]));
    assert.equal(
      net.since(mark).some((message) => message.t === 'enter'),
      false,
      'a refused mint still tried to enter the body',
    );
  });

  it('keeps a half-finished character across a reconnect, and rebuilds only the server’s half', () => {
    const doc = newPage();
    const net = new FakeNet();
    const gate = signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Dropout';
    el(doc, 'gate-new').fire('submit');
    pick(doc, 'Drow').fire('click');

    // (a) Still only choosing: nothing has been sent, so there is nothing to rebuild. The re-auth is
    // the whole of the reconnect, and the card is untouched — proved by picking up where it left off.
    let mark = net.sent.length;
    reconnect(gate, net);
    net.deliver(accountMessage([]));
    assert.deepEqual(net.since(mark), [DEV_AUTH], 'a card nobody had finished choosing replayed something');
    assert.equal(el(doc, 'gate-cards').hidden, false, 'the reconnect showed the picker over a live card');
    mark = net.sent.length;
    pick(doc, 'Warrior').fire('click');
    assert.deepEqual(net.since(mark), [{ t: 'charCreate', name: 'Dropout', race: 'drow', class: 'warrior' }]);

    // (b) Mid-roll: the dice lived in the server's dead closure, so the replay throws them again and
    // the card says so rather than changing six numbers in silence.
    net.deliver(rolled('drow', 'warrior', MODEST));
    rollRows(doc)[0]!.more.fire('click');
    mark = net.sent.length;
    reconnect(gate, net);
    net.deliver(accountMessage([]));
    assert.deepEqual(net.since(mark), [
      DEV_AUTH,
      { t: 'charCreate', name: 'Dropout', race: 'drow', class: 'warrior' },
    ]);
    assert.match(el(doc, 'gate-error').textContent, /the dice were thrown again/);
    net.deliver(rolled('drow', 'warrior', { ...MODEST, con: 16 }));
    assert.equal(rollRows(doc)[2]!.num, '16');
    assert.equal(el(doc, 'gate-bonus').textContent, '5 points to spend', 'the old spend outlived the dice');
    assert.equal(el(doc, 'gate-cards').hidden, false);
  });

  it('re-opens an adoption after a reconnect without resetting the cards', () => {
    const doc = newPage();
    const net = new FakeNet();
    const gate = signedIn(net, doc, [{ name: 'Aldric', level: 12 }]);
    el(doc, 'gate-characters').children[0]!.fire('click');
    net.deliver({ t: 'charAdopt', name: 'Aldric' });
    pick(doc, 'Halfling').fire('click');
    pick(doc, 'Rogue').fire('click');
    net.deliver(rolled('halfling', 'rogue', MODEST));

    // `adopting` is the one piece of server state a nameless `charCreate` depends on, so the replay
    // is an `enter` first and the `charAdopt` it earns must leave the chosen pair alone.
    const mark = net.sent.length;
    reconnect(gate, net);
    net.deliver(accountMessage([{ name: 'Aldric', level: 12 }]));
    assert.deepEqual(net.since(mark), [DEV_AUTH, { t: 'enter', name: 'Aldric' }]);
    net.deliver({ t: 'charAdopt', name: 'Aldric' });
    assert.deepEqual(net.lastOf('charCreate'), { t: 'charCreate', race: 'halfling', class: 'rogue' });
    assert.equal(el(doc, 'gate-cards-title').textContent, 'Aldric the Halfling Rogue');
    assert.match(el(doc, 'gate-error').textContent, /the dice were thrown again/);
  });

  it('will not enter a body whose confirm died with the socket, and does enter one whose answer did', () => {
    /*
     * The hazard `LoginGate.generation` exists for. `charConfirm` arms `pendingEnter`, and a
     * *reconnect* also produces an `account` message — so consuming it unconditionally sends `enter`
     * on a name that was never minted, and the server's `enter` claims a free name and spawns it
     * identity-less. That is the exact body this whole conversation exists to prevent, arrived at
     * through the conversation.
     */
    const doc = newPage();
    const net = new FakeNet();
    const gate = signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Inflight';
    el(doc, 'gate-new').fire('submit');
    pick(doc, 'Human').fire('click');
    pick(doc, 'Warrior').fire('click');
    net.deliver(rolled('human', 'warrior', MODEST));
    el(doc, 'gate-confirm').fire('click');
    assert.ok(net.lastOf('charConfirm'));

    // The confirm never landed: the reconnect's list has no such character, so the card stands and
    // the dice are thrown again. No `enter` anywhere.
    const mark = net.sent.length;
    reconnect(gate, net);
    net.deliver(accountMessage([]));
    assert.deepEqual(
      net.since(mark).map((message) => message.t),
      ['auth', 'charCreate'],
      'a name that was never minted was entered',
    );
    assert.equal(el(doc, 'gate-cards').hidden, false);

    // The other half: the mint *did* land and only its answer was lost. A summary carrying a race is
    // proof no reconnect can fake, so the body is entered rather than rolled again.
    const doc2 = newPage();
    const net2 = new FakeNet();
    const gate2 = signedIn(net2, doc2);
    el(doc2, 'gate-new-name').value = 'Landed';
    el(doc2, 'gate-new').fire('submit');
    pick(doc2, 'Human').fire('click');
    pick(doc2, 'Warrior').fire('click');
    net2.deliver(rolled('human', 'warrior', MODEST));
    el(doc2, 'gate-confirm').fire('click');
    reconnect(gate2, net2);
    net2.deliver(accountMessage([{ name: 'Landed', level: 1, race: 'human', class: 'warrior' }]));
    assert.deepEqual(net2.lastOf('enter'), { t: 'enter', name: 'Landed' });
  });

  it('says nothing to the socket while it is down, and says so on the card', () => {
    const doc = newPage();
    const net = new FakeNet();
    signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Patient';
    el(doc, 'gate-new').fire('submit');
    pick(doc, 'Human').fire('click');

    // A calling chosen against a dead socket: the send would be dropped in silence by `Net`, which
    // is the bug this file exists to have fixed, so the card promises what the replay will do.
    net.state = 'closed';
    const mark = net.sent.length;
    pick(doc, 'Warrior').fire('click');
    assert.deepEqual(net.since(mark), []);
    assert.match(el(doc, 'gate-error').textContent, /reconnecting/);

    // And a confirm against a dead socket says the *truth*, which is different: the replay is a
    // `charCreate`, so what comes back is new dice rather than the mint that was asked for.
    net.state = 'open';
    pick(doc, 'Warrior').fire('click');
    net.deliver(rolled('human', 'warrior', MODEST));
    net.state = 'closed';
    el(doc, 'gate-confirm').fire('click');
    assert.equal(net.lastOf('charConfirm'), undefined);
    assert.match(el(doc, 'gate-error').textContent, /the dice will be thrown again/);
  });

  it('steps back one page at a time and drops the card at the picker', () => {
    const doc = newPage();
    const net = new FakeNet();
    const gate = signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Backer';
    el(doc, 'gate-new').fire('submit');
    pick(doc, 'Halfling').fire('click');
    pick(doc, 'Rogue').fire('click');
    net.deliver(rolled('halfling', 'rogue', MODEST));

    el(doc, 'gate-back').fire('click'); // roll → calling
    assert.equal(el(doc, 'gate-roll').hidden, true);
    assert.equal(el(doc, 'gate-choices').hidden, false);
    assert.equal(el(doc, 'gate-cards-title').textContent, 'Backer the Halfling — choose a calling');
    el(doc, 'gate-back').fire('click'); // calling → race
    assert.equal(el(doc, 'gate-cards-title').textContent, 'Backer — choose a race');
    el(doc, 'gate-back').fire('click'); // race → the picker, and the card is gone
    assert.equal(el(doc, 'gate-cards').hidden, true);
    assert.equal(el(doc, 'gate-picker').hidden, false);

    // With no card held, a reconnect has nothing to rebuild — the proof the hold was dropped.
    const mark = net.sent.length;
    reconnect(gate, net);
    net.deliver(accountMessage([]));
    assert.deepEqual(net.since(mark), [DEV_AUTH]);
  });

  it('says what a body is on the picker, from the summary protocol 24 added', () => {
    const doc = newPage();
    const net = new FakeNet();
    signedIn(net, doc, [
      { name: 'Ready', level: 4, race: 'mountain-dwarf', class: 'cleric' },
      { name: 'Bare' },
    ]);
    const rows = el(doc, 'gate-characters').children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.textContent, 'Ready · level 4 · Mountain Dwarf Cleric');
    assert.equal(rows[1]!.textContent, 'Bare · no identity yet');
  });

  it('shows nine races carrying the numbers a pick is actually made on', () => {
    const doc = newPage();
    const net = new FakeNet();
    signedIn(net, doc);
    el(doc, 'gate-new-name').value = 'Reader';
    el(doc, 'gate-new').fire('submit');

    // Derived from `factors` by `racialBonuses` — the same function the server rolls with — so a card
    // and a roll cannot disagree about what a race is worth. Barbarian is the loudest row in the data.
    const barbarian = pick(doc, 'Barbarian');
    assert.equal(barbarian.children[1]!.textContent, '+4 STR  −1 DEX  +4 CON  −2 INT  −2 CHA');
    assert.equal(barbarian.children[2]!.textContent, 'medium · ordinary eyes · mana 80% · +1 hp a level');
    const drow = pick(doc, 'Drow');
    assert.equal(
      drow.children[2]!.textContent,
      'medium · ultravision · mana 120% · −1 hp a level · shrugs off magic · burns in sunlight',
    );

    pick(doc, 'Human').fire('click');
    const paladin = pick(doc, 'Paladin');
    assert.equal(paladin.children[1]!.textContent, 'd10 hit die · divine caster from level 11');
    assert.equal(
      paladin.children[2]!.textContent,
      'needs STR 11 · DEX 5 · CON 10 · WIS 13 · CHA 10 · cure light, bless',
    );
  });
});
