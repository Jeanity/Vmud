import Phaser from 'phaser';

import { AnnounceBanner } from './announce.ts';
import { ArrivalCard } from './arrival.ts';
import { PlaceMap } from './placemap.ts';
import { CombatFeed } from './combatfeed.ts';
import { GroupRoster } from './grouproster.ts';
import { LogPanel } from './log.ts';
import { LoginGate } from './login.ts';
import { Net } from './net.ts';
import { WorldScene } from './scene.ts';

const log = new LogPanel();

// The game server shares a host with the dev site but not a port — see GAME_PORT in the server.
const gamePort = import.meta.env['VITE_GAME_PORT'] ?? '8787';
// Protocol 23: the socket no longer carries a name. Who you are is `login.ts`'s conversation —
// which tab remembers which character moved there with it, sessionStorage semantics intact.
const net = new Net(`ws://${location.hostname}:${gamePort}`);
const login = new LoginGate(net);
net.onStateChange = (state) => {
  log.setStatus(state === 'open' ? 'connected' : state);
  if (state === 'closed') log.write('error', 'Disconnected. Retrying…');
  // Every fresh socket starts at the front door — resume token first, form if the tab has none.
  if (state === 'open') login.onConnected();
};

const scene = new WorldScene(net, log);

// **Two writers, one keyboard gate.** The scene must not read (or capture — gotcha 5a) keys while
// the caret is in the log's prompt *or* while the login card is up, and either source alone
// clearing the gate would re-arm the captures while the other still needs them off. Composed here
// because main.ts is the only place that knows both exist.
let logTyping = false;
let gateUp = true; // the overlay is visible from the first paint
const applyTyping = (): void => scene.setTyping(logTyping || gateUp);
login.onVisibility = (visible) => {
  gateUp = visible;
  applyTyping();
};
applyTyping();

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

// V4. On the same fan-out, and for the third time the reason is that this is DOM which owes the
// renderer nothing: a graph of a dozen labelled discs is the browser's job, and it stays legible if
// anything goes wrong inside the canvas. The scene owns the *key*, because Phaser is what holds the
// keyboard and because the toggle has to be gated on whether the caret is in the command line.
const placeMap = new PlaceMap();
net.on('places', (message) => placeMap.update(message.nodes, message.edges, message.here));
placeMap.onOpen = () => net.send({ t: 'places' });
scene.setPlaceMap(placeMap);

// Phase 18's shared list. On the same fan-out as the feed and the banner, and for the fourth time the
// reason is that this is DOM which owes the renderer nothing. Nothing else has to know a group exists:
// the server sends the whole roster whenever it changes or a member's pools move, and an empty one is
// how it says you are in no group.
const groupRoster = new GroupRoster();
net.on('group', (message) => groupRoster.update(message.members));

// V5. Nothing listens on the socket for this one — the scene already knows when a Place changed,
// because it is the thing that redraws the map, so the card is handed to it rather than wired to a
// message of its own.
scene.setArrivalCard(new ArrivalCard());

// The line goes to the server unparsed: which command an abbreviation means, and which orc `2.orc`
// is, are both game rules, and the second needs room contents gated on what this character can see.
log.onCommand = (text) => net.send({ t: 'command', text });
// While the caret is in the prompt the game must not read the keyboard at all, or typing `west`
// walks you west as well as sending the command. Phaser listens on the document and cannot tell the
// difference by itself. Routed through the composed gate above, beside the login overlay's claim.
log.onFocusChange = (focused) => {
  logTyping = focused;
  applyTyping();
};
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
