import Phaser from 'phaser';

import { AnnounceBanner } from './announce.ts';
import { CombatFeed } from './combatfeed.ts';
import { LogPanel } from './log.ts';
import { Net } from './net.ts';
import { WorldScene } from './scene.ts';

const NAMES = [
  'Aldric', 'Brynn', 'Cadeus', 'Delwyn', 'Eryndor', 'Fenwick',
  'Gwynne', 'Halvard', 'Ilyana', 'Joreth', 'Kaelin', 'Lyra',
];

/**
 * Who to log in as. `?name=` wins; otherwise a generated name, **kept for the life of the tab**.
 *
 * The name is the character's identity on the server: it keys the save file holding the seen map,
 * the pickups this character has already taken and the light they are carrying. Rolling a fresh one
 * on every page load therefore made all three unobservable in the default dev flow — walk onto the
 * torch in a room, reload, and it is lying there again for the new stranger you have become.
 *
 * `sessionStorage`, not `localStorage`, and that is the whole point of the choice: a reload is the
 * same tab and keeps the character, while a second tab is a second character. Testing two players
 * side by side is the other thing this name is for, and a name that persisted across tabs would
 * have both windows fighting over one character.
 *
 * Storage access is wrapped because it throws outright in a partitioned or cookie-blocked context,
 * and failing to *name* the player is not a reason to fail to start the game.
 */
const NAME_KEY = 'mygame:name';

function playerName(): string {
  const requested = new URLSearchParams(location.search).get('name');
  if (requested) return requested.slice(0, 24);

  const remembered = readSession(NAME_KEY);
  if (remembered) return remembered;

  const pick = NAMES[Math.floor(Math.random() * NAMES.length)] ?? 'Wanderer';
  const name = `${pick}${Math.floor(Math.random() * 90 + 10)}`;
  writeSession(NAME_KEY, name);
  return name;
}

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
    // A tab that cannot remember its own name simply rolls a new one next reload.
  }
}

const log = new LogPanel();

// The game server shares a host with the dev site but not a port — see GAME_PORT in the server.
const gamePort = import.meta.env['VITE_GAME_PORT'] ?? '8787';
const net = new Net(`ws://${location.hostname}:${gamePort}`, playerName());
net.onStateChange = (state) => {
  log.setStatus(state === 'open' ? 'connected' : state);
  if (state === 'closed') log.write('error', 'Disconnected. Retrying…');
};

const scene = new WorldScene(net, log);

// The combat channel's one destination — the scene routes it away from the log, so this is a
// split, not a mirror: prose and speech on the left, violence on the right (the owner's rule).
// A second listener rather than a branch inside the scene's own — Net.on fans out, and the feed
// is DOM that owes the renderer nothing.
const combatFeed = new CombatFeed();
// V3's banner, on the same fan-out and for the same reason. **Note this one is a mirror where the
// feed is a split**: an announcement also stays in the log, because the banner is transient by
// necessity and a line you were looking away for has to be findable afterwards. See `announce.ts`.
const announce = new AnnounceBanner();
net.on('log', (message) => {
  if (message.channel === 'combat') combatFeed.push(message.text);
  if (message.channel === 'announce') announce.show(message.text);
});

// The line goes to the server unparsed: which command an abbreviation means, and which orc `2.orc`
// is, are both game rules, and the second needs room contents gated on what this character can see.
log.onCommand = (text) => net.send({ t: 'command', text });
// While the caret is in the prompt the game must not read the keyboard at all, or typing `west`
// walks you west as well as sending the command. Phaser listens on the document and cannot tell the
// difference by itself.
log.onFocusChange = (focused) => scene.setTyping(focused);
// Restore whichever way the log was left **before** the resize hook is attached, and before the game
// is constructed. Both orderings matter: the DOM has to settle first so Phaser measures the column it
// is actually getting, and the hook must not fire against a scene that has no scale manager yet — a
// `Scene` only gains one when a `Game` adds it, so notifying here would throw and the game would never
// be built at all.
log.setCollapsed(LogPanel.rememberedCollapsed(), false);

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0b0d0a',
  pixelArt: true,
  roundPixels: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
  },
  scene,
});

// Attached after the game exists, for the reason given above the restore call. Collapsing a pane
// resizes a *grid column*, and `Scale.RESIZE` only listens for window resizes — so the renderer has to
// be told, or the canvas keeps the width it had and the map is drawn into a letterbox of its new space.
log.onLayoutChange = () => scene.refreshViewport();

// Dev-only handle so the running scene can be inspected from the console. Phaser keeps no global
// registry, and reading pixels back off the canvas is unreliable once a frame has been presented.
if (import.meta.env.DEV) {
  (window as unknown as { __game: Phaser.Game }).__game = game;
}

net.connect();
