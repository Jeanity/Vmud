/**
 * Boot, the message handlers, the frame loop, and `window.__debug3d`.
 *
 * The order in this file is load-bearing twice over. **Every handler is registered before
 * `net.connect()`**, which is what lets `login.ts` send `enter` the instant it can rather than
 * waiting on a readiness callback the way the Phaser client must (see that file's header). And
 * within the frame, movement is settled before the window is recentred and before anything is drawn,
 * so the camera, the streamer and the bodies all describe the same instant.
 *
 * ## Which handlers are wired, and which are deliberately not
 *
 * Wired, because M3's brief names them: `welcome`, `zone`, `seen`, `seenDelta`, `door`, `room`,
 * `self`, `entityEnter`, `entityLeave`, `entityUpdate`, `entityMoved`, `log`, `rejected`, and
 * `path` — the last because it drives the prediction gate (`serverWalking` zeroes the intent while
 * the server is walking you), which is part of the reconciliation semantics being carried over even
 * though nothing here can *start* a route yet.
 *
 * Not wired, each for a reason rather than by omission:
 *
 * | Message | Why not |
 * |---|---|
 * | `attackResolved`, `died` | No combat visuals until M7. The plan notes the *2D* client had no handler for these either until protocol 22. |
 * | `places`, `group` | DOM panels (`placemap.ts`, `grouproster.ts`) that owe the renderer nothing. Pure UI, and copying 600 lines of it would say nothing about whether the 3D world streams. |
 * | `pathFailed` | The refusal already arrives as a `log` line, which is rendered. The 2D client's extra flash is a 2D effect. |
 * | `pong` | No latency HUD. Nothing sends `ping`. |
 * | `loggedOut`, `charRolled` | The handshake this client implements stops short of both — see `login.ts`. |
 *
 * ## `__debug3d`
 *
 * Exposed unconditionally rather than behind `import.meta.env.DEV`, because the acceptance for this
 * milestone is *"expose `window.__debug3d` … the dev page must boot to a state where those counters
 * are readable from the console"*, and a built preview has to answer the same question a dev server
 * does. It is a read-only snapshot: nothing in the renderer reads it back.
 */

import { WebGLRenderer } from 'three';

import { samePlace, type Direction, type Place } from '@mygame/shared';

import { EntityLayer } from './entities.ts';
import { metresOfPixel } from './frame.ts';
import { Input } from './input.ts';
import { LogPanel } from './log.ts';
import { LoginGate } from './login.ts';
import { Net } from './net.ts';
import { CameraRig } from './rig.ts';
import { MAX_WINDOW_CHUNKS, WINDOW_CELLS_X, WINDOW_CELLS_Y, WINDOW_MARGIN } from './streamer.ts';
import { World3D } from './world3d.ts';

/* -------------------------------------------------------------------------- */
/* Wiring                                                                      */
/* -------------------------------------------------------------------------- */

const log = new LogPanel();

// The game server shares a host with the dev site but not a port — see GAME_PORT in the server, and
// `CLAUDE.md` gotcha 2 for why it is never called PORT.
const gamePort = import.meta.env['VITE_GAME_PORT'] ?? '8787';
const net = new Net(`ws://${location.hostname}:${gamePort}`);
const login = new LoginGate(net);

const world = new World3D();
const rig = new CameraRig();
const entities = new EntityLayer(world.scene, world.pool);
const input = new Input();

const canvasHost = document.getElementById('view');
if (!canvasHost) throw new Error('missing element #view');
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
canvasHost.append(renderer.domElement);

/** Server-authoritative facts the loop reads. Held here rather than in the world: none of it draws. */
let place: Place | undefined;
let roomId: number | undefined;
let roomName = '';
let canMovePredicted = true;
let serverWalking = false;
let lastIntentX = 0;
let lastIntentY = 0;
/**
 * Forces the next frame to transmit the steering intent even if it has not changed.
 *
 * Carried over with its reasoning: the server zeroes a player's intent whenever it relocates them,
 * so after any arrival and after a reconnect the two sides disagree about what has already been
 * sent, and the client would predict movement it never asked for and rubber-band on the spot.
 */
let resendIntent = true;

/* -------------------------------------------------------------------------- */
/* The keyboard gate — two writers, one boolean                                */
/* -------------------------------------------------------------------------- */

let logTyping = false;
let gateUp = true; // the overlay is visible from the first paint
const applyTyping = (): void => {
  input.typing = logTyping || gateUp;
};
login.onVisibility = (visible) => {
  gateUp = visible;
  applyTyping();
};
log.onFocusChange = (focused) => {
  logTyping = focused;
  applyTyping();
};
applyTyping();

log.onCommand = (text) => net.send({ t: 'command', text });
log.onLayoutChange = () => resize();
log.setCollapsed(LogPanel.rememberedCollapsed(), false);

net.onStateChange = (state) => {
  log.setStatus(state === 'open' ? 'connected' : state);
  if (state === 'closed') log.write('error', 'Disconnected. Retrying…');
  if (state === 'open') login.onConnected();
};

input.onTravel = (dir: Direction) => net.send({ t: 'move', dir });
input.onManual = () => {
  if (!serverWalking) return;
  net.send({ t: 'stop' });
  serverWalking = false;
};
input.attach();

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

net.on('welcome', (message) => {
  entities.selfId = message.you;
  entities.clear(false);
  place = undefined;
  roomId = undefined;
  roomName = '';
  canMovePredicted = true;
  serverWalking = false;
  // A reconnect spawns a fresh server-side player whose intent is zero, whatever this client last
  // sent down the old socket.
  resendIntent = true;
});

net.on('zone', (message) => {
  place = { zone: message.zone.id, level: message.level };
  world.setPlace(message.zone, message.level);
  // Everyone else was in the Place just left; the local body is what the camera follows.
  entities.clear(true);
  resendIntent = true;
});

net.on('seen', (message) => {
  if (!place || !samePlace(message.place, place)) return;
  world.setSeen(message.bits);
});

net.on('seenDelta', (message) => world.addSeen(message.tiles));

net.on('door', (message) => world.applyDoor(message.room, message.dir, message.closed));

net.on('room', (message) => {
  roomId = message.view.room.id;
  roomName = message.view.room.name;
  setText('hud-where', roomName);
  for (const view of message.view.entities) entities.upsert(view);
  // Anything the server no longer lists for this room is gone.
  const present = new Set(message.view.entities.map((e) => e.id));
  for (const id of entities.ids()) {
    if (!present.has(id) && id !== entities.selfId) entities.remove(id);
  }
});

net.on('self', (message) => {
  roomId = message.view.roomId;
  // Mirrored, never inferred — `Simulation.canMove` is the authority and this is a copy of its
  // answer. Predicting a walk the server refuses is what makes a sitting character rubber-band.
  canMovePredicted = message.view.posture === 'standing' && message.view.status === 'normal';
  setText('hud-name', `${message.view.name}  lvl ${message.view.level}`);
});

net.on('entityEnter', (message) => entities.upsert(message.entity));
net.on('entityLeave', (message) => entities.remove(message.id));
net.on('entityUpdate', (message) => entities.upsert(message.entity));
net.on('entityMoved', (message) => {
  for (const move of message.moves) entities.moved(move.id, move.x, move.y, move.facing);
});

net.on('path', (message) => {
  // An empty array is the protocol's "no path", whether the route arrived, was abandoned, or was
  // dropped by a step through an exit. Nothing draws it at M3; it gates prediction.
  serverWalking = message.points.length > 0;
});

net.on('log', (message) => log.write(message.channel, message.text));
net.on('rejected', (message) => log.write('error', `Rejected: ${message.reason}`));

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

let last = performance.now();
let fps = 0;

/** Hoisted out of the loop: one closure for the session rather than one per frame. */
const groundAt = (px: number, py: number): number => world.groundAt(px, py);

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Clamped: a tab that was in the background for a minute must not integrate a minute of movement
  // in one step, which would send the predictor through every wall between here and there.
  const seconds = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps = seconds > 0 ? 1 / seconds : fps;

  const raw = input.intent();
  // A key held *across* a click is being ignored by the server for as long as the route lasts, so
  // the intent is zeroed rather than the raw keys: nothing is predicted that the character is not
  // doing, and the `steer 0,0` that goes out reads as a key release rather than as a cancellation.
  const intent = serverWalking ? { x: 0, y: 0 } : raw;
  if (resendIntent || intent.x !== lastIntentX || intent.y !== lastIntentY) {
    resendIntent = false;
    lastIntentX = intent.x;
    lastIntentY = intent.y;
    net.send({ t: 'steer', dx: intent.x, dy: intent.y });
  }

  entities.step(seconds, world.grid, intent, canMovePredicted);

  const self = entities.self();
  if (self) {
    // Recentred on the *predicted* position, for the same reason the 2D client's lit set is:
    // streaming a fifth of a room behind the character shows its seam every time they turn round.
    world.update(self.x, self.y);
    rig.follow(metresOfPixel(self.x), groundAt(self.x, self.y), metresOfPixel(self.y));
  }
  entities.render(groundAt);

  renderer.render(world.scene, rig.camera);
}

function resize(): void {
  const width = canvasHost!.clientWidth;
  const height = canvasHost!.clientHeight;
  if (width === 0 || height === 0) return;
  renderer.setSize(width, height, false);
  rig.resize(width, height);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);

/* -------------------------------------------------------------------------- */
/* The debug object                                                            */
/* -------------------------------------------------------------------------- */

const debug = {
  get chunksLoaded(): number {
    return world.chunksLoaded;
  },
  /** The vertical policy, visible: chunks per level, and how many are drawn faded. */
  get chunksByLevel(): Record<number, number> {
    return world.chunkLevels().levels;
  },
  get fadedChunks(): number {
    return world.chunkLevels().faded;
  },
  get pooledGeometries(): number {
    return world.ledger().geometries;
  },
  get pooledMaterials(): number {
    return world.ledger().materials;
  },
  /** Wrappers ever minted. **The leak indicator**: it must stop climbing. */
  get instancedMeshes(): number {
    return world.ledger().wrappersCreated;
  },
  get ledgerBytes(): number {
    return world.ledger().bytes;
  },
  /** The whole ledger — see `pool.ts` for what each field means and which are bounded. */
  get ledger(): ReturnType<World3D['ledger']> {
    return world.ledger();
  },
  /** `renderer.info.memory`, beside the ledger, so a human can confirm the proxy is honest. */
  get rendererMemory(): { geometries: number; textures: number; programs: number } {
    return {
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      programs: renderer.info.programs?.length ?? 0,
    };
  },
  get drawCalls(): number {
    return renderer.info.render.calls;
  },
  get entities(): number {
    return entities.count;
  },
  get cameraLevel(): number | undefined {
    return world.frame?.level;
  },
  get roomId(): number | undefined {
    return roomId;
  },
  get roomName(): string {
    return roomName;
  },
  get place(): Place | undefined {
    return place;
  },
  /** Simulation pixels, predicted — what the streamer and the camera are centred on. */
  get position(): { x: number; y: number } | undefined {
    const self = entities.self();
    return self ? { x: self.x, y: self.y } : undefined;
  },
  get window(): { cellsX: number; cellsY: number; margin: number; max: number } {
    return { cellsX: WINDOW_CELLS_X, cellsY: WINDOW_CELLS_Y, margin: WINDOW_MARGIN, max: MAX_WINDOW_CHUNKS };
  },
  get fps(): number {
    return Math.round(fps);
  },
};

(window as unknown as { __debug3d: typeof debug }).__debug3d = debug;

net.connect();

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
