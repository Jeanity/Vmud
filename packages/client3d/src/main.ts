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
 * `path` — which at M3 only drove the prediction gate (`serverWalking` zeroes the intent while the
 * server is walking you). Click-to-move gives it a second job: the destination marker is positioned
 * from this same message, never from the click itself — see the handler's own comment.
 *
 * Not wired, each for a reason rather than by omission:
 *
 * | Message | Why not |
 * |---|---|
 * | `attackResolved`, `died` | No combat visuals until M7. The plan notes the *2D* client had no handler for these either until protocol 22. |
 * | `places`, `group` | DOM panels (`placemap.ts`, `grouproster.ts`) that owe the renderer nothing. Pure UI, and copying 600 lines of it would say nothing about whether the 3D world streams. |
 * | `pathFailed` | The refusal already arrives as a `log` line, which is rendered. The 2D client's extra flash is a 2D effect, and click-to-move's client-side seen-gate means most refusals this client could cause never reach the server to answer at all — see `pointer.ts`'s header. |
 * | `pong` | No latency HUD. Nothing sends `ping`. |
 * | `loggedOut`, `charRolled` | The handshake this client implements stops short of both — see `login.ts`. |
 *
 * ## `__debug3d`
 *
 * Exposed unconditionally rather than behind `import.meta.env.DEV`, because the acceptance for M3 was
 * *"expose `window.__debug3d` … the dev page must boot to a state where those counters are readable
 * from the console"*, and a built preview has to answer the same question a dev server does.
 *
 * At M3 it was a read-only snapshot. **M4 makes half of it writable**, and deliberately: the
 * milestone's whole question is *"does the light match"*, which is answered by a human turning knobs
 * with the reference image beside them. `toneMapping`, `exposure`, `rainEnabled`, `rainOpacity`,
 * `shadowMapSize`, `fogDensity`, `fogColour`, `bloomIntensity` and `bloomThreshold` all take. Nothing
 * in the *simulation* reads any of them; they reach the renderer and stop there.
 *
 * ## The frame, after M4
 *
 * One thing changed shape. `renderer.render(scene, camera)` became `grade.render(delta)`, because the
 * scene now goes through a `postprocessing` `EffectComposer` — bloom and the tone curve, in that
 * order, in one pass. §3's warning is worth restating where the call site is: **there is one composer
 * stack in this client and it is pmndrs', and `three/examples`' `UnrealBloomPass` must never be added
 * beside it.** Everything else in the loop is where it was: movement settles, then the window
 * recentres, then the light and the camera take the same position, then it draws.
 */

import { WebGLRenderer } from 'three';

import { TILE_SIZE, samePlace, type Direction, type Place } from '@mygame/shared';

import { DAY_SKY, NIGHT_SKY, clockOf, hourOf, normaliseHour } from './daylight.ts';
import { EntityLayer } from './entities.ts';
import { metresOfPixel, pixelOfMetres } from './frame.ts';
import { Input, intoFormControl } from './input.ts';
import { LogPanel } from './log.ts';
import { LoginGate } from './login.ts';
import { Marker } from './marker.ts';
import { Net } from './net.ts';
import { SHADOW_MAP_TYPE, type ShadowFit } from './night.ts';
import { Grade, TONE_MAPPINGS, type ToneMapping } from './post.ts';
import { PointerControl, type PointerTarget } from './pointer.ts';
import { Rain } from './rain.ts';
import { CameraRig } from './rig.ts';
import { MAX_WINDOW_CHUNKS, WINDOW_CELLS_X, WINDOW_CELLS_Y, WINDOW_MARGIN } from './streamer.ts';
import { unprojectToGround } from './unproject.ts';
import type { WarpVec } from './warp.ts';
import { Wetness } from './wetness.ts';
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
const marker = new Marker(world.scene, world.pool);
const pointer = new PointerControl();

const canvasHost = document.getElementById('view');
if (!canvasHost) throw new Error('missing element #view');
// `antialias` is deliberately off: the scene renders into the composer's own buffers and the
// context's multisampling never sees it. MSAA is `post.ts`'s `MULTISAMPLING`, on those buffers.
const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = SHADOW_MAP_TYPE;
// The composer calls `renderer.render` several times a frame, and `info` resets on each of them. Off,
// so `__debug3d.drawCalls` counts the *frame* — the world, the shadow map, the depth mask and the
// full-screen passes — which is the number that matters when the question is why it is slow.
renderer.info.autoReset = false;
canvasHost.append(renderer.domElement);

const grade = new Grade(renderer, world.scene, rig.camera);
world.setGlowSet(grade.glow);

const rain = new Rain();
world.scene.add(rain.mesh);

/**
 * M5a's one asynchronous boot step: fetch the baked conifers.
 *
 * Deliberately **not awaited**. §5's delivery rule serves these from `public/` over HTTP and the first
 * `zone` message can beat them by a second on a cold cache; blocking the renderer on 827 KiB of GLB
 * would trade a world with no trees for a black screen. The chunks that built before the manifest
 * landed simply have no vegetation, and the first cell the player crosses rebuilds them with it. If
 * the whole set is missing — nobody ran `treegen` — the reason goes in the log and the world is M4's.
 */
void world.trees.load(world.pool).then((problem) => {
  if (problem) log.write('error', problem);
  else log.write('system', `trees: ${world.trees.loaded} variants, ${world.trees.triangles} tris at LOD0`);
});

/**
 * M5b's boot step: fetch the Quaternius kit — sixty-three models and twelve shared textures.
 *
 * Not awaited either, and the argument is the tree bake's with one number changed: this is ~30 MB
 * uncompressed (the brief defers Draco/KTX2/meshopt deliberately, and this is the figure that
 * deferral costs), so blocking the renderer on it would trade a world with no understory for a black
 * screen for a second or two. Chunks built before it lands have M5a's dressing and the first cell the
 * player crosses rebuilds them with the kit's.
 *
 * `world.kit.load` is a *second* registry rather than a second call to `TreeSet.load`, and the seam
 * still holds: the twenty kit trees are registered under the same `(variant, part, lod)` keys the
 * baked ones use, so nothing downstream of `trees.ts` can tell them apart. See `kit.ts`'s header.
 */
void world.kit.load(world.pool).then((problem) => {
  if (problem) log.write('error', problem);
  else {
    log.write(
      'system',
      `kit: ${world.kit.loaded} models, ${world.kit.triangles} tris, ` +
        `${world.kit.textures} textures (${(world.kit.textureBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  }
});

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
  // Composed identically to `input.typing` — a click aimed at the command line or the login card must
  // never fall through to the world. `pointer.ts`'s header, and `CLAUDE.md` gotcha 5a's discipline.
  pointer.typing = input.typing;
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

input.onTravel = (dir: Direction) => {
  net.send({ t: 'move', dir });
  // Taking an exit is manual control exactly as pressing a movement key is — `scene.ts:4681-4689`'s
  // `takeExit` grabs the wheel back from *both* a server-walked path and a live drag, because `update`
  // (there) or `frame` (here) only watch the steering keys and cannot notice a vertical step on its own.
  if (serverWalking || pointer.pointerDown) {
    net.send({ t: 'stop' });
    serverWalking = false;
    pointer.cancel();
  }
};
input.onManual = () => {
  // Touching a movement key takes the wheel back from a held pointer too, on the same press edge —
  // `scene.ts:4397-4410`'s single grab covers both a server-walked path and a live drag.
  pointer.cancel();
  if (!serverWalking) return;
  net.send({ t: 'stop' });
  serverWalking = false;
};
input.attach();

/* -------------------------------------------------------------------------- */
/* Click-to-move and hold-to-steer                                            */
/* -------------------------------------------------------------------------- */

/**
 * Screen point to world tile, the composition `pointer.ts`'s header promises: a ground-plane
 * unprojection (`unproject.ts`) through metres back to simulation pixels (`frame.ts`'s
 * `pixelOfMetres`, the inverse of `space.ts`'s `WORLD_SCALE`) to a tile index tested against the
 * `seen` bitset (`World3D.hasSeenTile`) — the same `ty * grid.width + tx` maths `vision.ts`'s
 * `computeVisible` writes and `fogOfWar.ts`'s per-chunk states read.
 *
 * The plane is the *player's own* ground: `world.groundAt(self.x, self.y)`, not the tile eventually
 * clicked — see `unproject.ts`'s header for why one flat plane is the right amount of truth at
 * grey-box, and gated on there being a body to plant it under at all.
 */
/** Scratch for the pointer's inverse warp and for the frame's own. One each, for the session. */
const clickScratch: WarpVec = { x: 0, z: 0 };
const selfScratch: WarpVec = { x: 0, z: 0 };
pointer.resolve = (ndcX: number, ndcY: number): PointerTarget | undefined => {
  const self = entities.self();
  if (!self) return undefined;
  const hit = unprojectToGround(rig.camera, ndcX, ndcY, world.groundAt(self.x, self.y));
  if (!hit) return undefined;
  // M5c: the ray met the ground where it is *drawn*, and everything below this line — the tile index,
  // the `seen` gate, the `moveTo` — speaks the unwarped grid the simulation walks. So the lens is run
  // backwards first. Without it a click lands wherever the domain warp pushed that patch of ground,
  // which at three metres is a third of a room from where the player aimed, and the error is largest
  // in exactly the open country where click-to-move is most used. See `WarpField.invertInto`.
  world.unwarpAt(clickScratch, hit.x, hit.z);
  const simX = pixelOfMetres(clickScratch.x);
  const simY = pixelOfMetres(clickScratch.z);
  const tx = Math.floor(simX / TILE_SIZE);
  const ty = Math.floor(simY / TILE_SIZE);
  const grid = world.grid;
  const seen = grid !== undefined && world.hasSeenTile(ty * grid.width + tx);
  return { tx, ty, simX, simY, seen };
};

pointer.onPress = (target) => {
  // Clicking the world means you want to play, not type — `scene.ts:2521-2524`'s reasoning: done
  // explicitly because a click that left the caret in the log would silently swallow the next WASD.
  if (log.inputFocused) log.blurInput();
  // The client-side half of the seen-gate: `moveTo` only ever goes out for ground already in the
  // `seen` bitset. The server would refuse an unseen tile regardless (`pathFailed`'s `'unexplored'`);
  // see `pointer.ts`'s header for why this class asks first rather than letting every ray-plane click
  // make the round trip. `target` is `undefined` off the ground plane — nothing to send either way.
  if (target?.seen) net.send({ t: 'moveTo', tx: target.tx, ty: target.ty });
};

/**
 * A hold crossed `pointer.ts`'s `HOLD_THRESHOLD_MS` — `scene.ts:2669-2677`'s pair: the route the click
 * fired has to go, because the player is now steering by hand.
 */
pointer.onSteerStart = () => {
  net.send({ t: 'stop' });
  serverWalking = false;
};

pointer.attach(renderer.domElement);

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
  // Whatever the old body was doing is nobody's business now — `scene.ts:2145-2152`'s reconnect
  // handling drops the same two things, for the same reason `buildZone` does below.
  marker.hide();
  pointer.cancel();
});

net.on('zone', (message) => {
  place = { zone: message.zone.id, level: message.level };
  world.setPlace(message.zone, message.level);
  // Everyone else was in the Place just left; the local body is what the camera follows.
  entities.clear(true);
  resendIntent = true;
  // The route was drawn in the old map's tiles, which mean nothing here — `scene.ts:2878-2886`'s
  // `buildZone`: the server sends a fresh `path` if it is still walking us somewhere, and a drag in
  // flight was aimed at ground that has just been replaced, so the button has to be pressed again.
  serverWalking = false;
  marker.hide();
  pointer.cancel();
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
  // The lit half of the three-state fog of war: this room and the rooms an exit links it to. See
  // `world3d.ts`'s header for why the room graph is the right source and a raycast is not.
  world.setHere(roomId);
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
  // dropped by a step through an exit. At M3 it only gated prediction; click-to-move gives it a
  // second job — `scene.ts:2767-2797`'s `drawPath`, minus the line: the marker sits at the *last*
  // point of the server's own route, authoritative rather than wherever the click's ray landed, so a
  // refused destination leaves an already-drawn marker alone exactly as `scene.ts:2808-2809` does —
  // nothing here reacts to `pathFailed` at all, on purpose.
  serverWalking = message.points.length > 0;
  const destination = message.points[message.points.length - 1];
  if (destination) {
    const simX = (destination.tx + 0.5) * TILE_SIZE;
    const simY = (destination.ty + 0.5) * TILE_SIZE;
    // The server answers in grid tiles, so the ring goes through the lens like everything else — a
    // mark on ground that has moved has to move with it.
    const x = metresOfPixel(simX);
    const z = metresOfPixel(simY);
    world.warpAt(clickScratch, x, z);
    marker.show(x + clickScratch.x, world.groundAt(simX, simY), z + clickScratch.z);
  } else {
    marker.hide();
  }
});

net.on('log', (message) => log.write(message.channel, message.text));
net.on('rejected', (message) => log.write('error', `Rejected: ${message.reason}`));

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

let last = performance.now();
let fps = 0;
/**
 * Whether the player wants rain at all, as distinct from whether it is falling.
 *
 * Two writers and they must not fight: the **R** key and `__debug3d.rainEnabled` set this, and the
 * frame ANDs it with "is there a roof overhead" before touching the mesh. Letting either writer set
 * `visible` directly would mean stepping into a cave permanently turned the toggle off.
 */
let rainWanted = true;

/**
 * How wet the world is, and the ramp that gets it there. M5b.
 *
 * Held here beside `rainWanted` because it is driven by the same question the rain is — *is it
 * falling on this character right now* — and answered on the frame that already knows. See
 * `wetness.ts` for why the rise is fast and the dry-off is slow.
 */
const wetness = new Wetness();

/**
 * The hour of the game day. **A client value, and the reason is recorded rather than assumed.**
 *
 * Verified again while building M5b: `packages/server/src` ticks no game clock — the only `hour`
 * matches are the scheduler's and the noticeboards' wall-clock timestamps, and no wire message
 * carries a time of day. So the world starts at midnight, which is M4's world and the one the
 * lighting was signed off on, and the **G** key and `[`/`]` move it. `World3D.setGameHour` is the
 * named hook a future server clock writes; nothing else would change.
 */
let gameHour = 0;

/** Apply a sky: the scene graph takes the lights and the fog, the composer takes the exposure. */
function applySky(hour: number): void {
  gameHour = normaliseHour(hour);
  const recipe = world.setGameHour(gameHour);
  // The one part of a recipe `night.ts` cannot apply, because the composer is this file's and not the
  // scene graph's — see `NightRig.sky`. 1.6 lifts a moonlit 0.11 into readability and would put a
  // sunlit clearing through the bloom threshold, so it travels with the rest of the recipe.
  grade.exposure = recipe.exposure;
}
applySky(gameHour);

/** Hoisted out of the loop: one closure for the session rather than one per frame. */
const groundAt = (px: number, py: number): number => world.groundAt(px, py);
/** The same, for M5c's lens — `entities.ts` takes it injected rather than holding a `World3D`. */
const warpAt = (out: WarpVec, x: number, z: number): void => world.warpAt(out, x, z);

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Clamped: a tab that was in the background for a minute must not integrate a minute of movement
  // in one step, which would send the predictor through every wall between here and there.
  const seconds = Math.min((now - last) / 1000, 0.1);
  last = now;
  fps = seconds > 0 ? 1 / seconds : fps;
  renderer.info.reset();

  // Taken before the step below and reused after it: `entities.step` mutates this same `Body` in
  // place, so one lookup serves both the *pre*-step position a held pointer steers from and the
  // *post*-step position the camera follows.
  const self = entities.self();

  // Once a frame, on the position the character was at when this frame began — `scene.ts:2657-2694`'s
  // `updateDrag` reads `self.x/self.y` before `stepMovement` runs for the same reason: the frame has
  // not decided where the body is going yet, so the heading is aimed from where it last settled. See
  // `pointer.ts`'s header for why this cannot instead wait for the next `pointermove`.
  if (self) pointer.tick(now, self.x, self.y);

  const raw = input.intent();
  // The joystick outranks both the keyboard and a stale server route, exactly as `scene.ts:4431-4438`
  // ranks them: it is a deliberate, held instruction, so it beats a route it has already told the
  // server to drop and it beats the keyboard for the one frame a key goes down before `onManual` has
  // cancelled the drag.
  const pointerIntent = pointer.steering ? pointer.intent() : undefined;
  // A key held *across* a click is being ignored by the server for as long as the route lasts, so
  // the intent is zeroed rather than the raw keys: nothing is predicted that the character is not
  // doing, and the `steer 0,0` that goes out reads as a key release rather than as a cancellation.
  const intent = pointerIntent ?? (serverWalking ? { x: 0, y: 0 } : raw);
  if (resendIntent || intent.x !== lastIntentX || intent.y !== lastIntentY) {
    resendIntent = false;
    lastIntentX = intent.x;
    lastIntentY = intent.y;
    net.send({ t: 'steer', dx: intent.x, dy: intent.y });
  }

  entities.step(seconds, world.grid, intent, canMovePredicted);

  if (self) {
    // Recentred on the *predicted* position, for the same reason the 2D client's lit set is:
    // streaming a fifth of a room behind the character shows its seam every time they turn round.
    world.update(self.x, self.y);
    // M5c: through the lens, once, and then every consumer of the frame's own position takes the
    // warped numbers — the camera, the moon's shadow volume, the clearing light and the rain's
    // centre. The camera especially: the body is drawn displaced (`entities.render`), so a rig
    // following the grid position would let the character drift across the screen as the field
    // changed under them. Streaming is *not* in this list and must not be — `world.update` above
    // takes the simulation position, because which chunks are near is a question about the grid.
    world.warpAt(selfScratch, metresOfPixel(self.x), metresOfPixel(self.y));
    const x = metresOfPixel(self.x) + selfScratch.x;
    const y = groundAt(self.x, self.y);
    const z = metresOfPixel(self.y) + selfScratch.z;
    rig.follow(x, y, z);
    // The moon's shadow camera and the clearing light take the *same* three numbers the camera did,
    // in the same frame. Anything else and the shadow volume trails the frame by a tick.
    world.focus(x, y, z);
    rain.update(now / 1000, x, y, z);
    // Weather is gated on the roof, not on the biome: §4's enclosure class says "3-4 solid wants no
    // weather", and the cheapest honest version of that at grey-box — where there is no ceiling
    // geometry to hide the sky until M6 — is to stop the rain when the character is under one.
    rain.enabled = rainWanted && !world.roofed;
  } else {
    // No body yet: the login card is still up and the storm has nowhere to be centred.
    rain.enabled = false;
  }
  // The ground's memory of the rain. Wall-clock, like the rain's own time, and driven by whether it
  // is *actually* falling rather than by whether the player wants it — step under a roof and the
  // street outside stays wet, which is right, and the roof you are under dries.
  world.setWetness(wetness.update(now / 1000, rain.enabled));
  entities.render(groundAt, warpAt);

  world.pool.pulse(now / 1000);
  marker.pulse(now / 1000);
  // The foliage clock. Wall-clock, like the rain's and the pulse's, and for the same reason: an
  // accumulator drifts with the frame rate and two players at one treeline should see one wind.
  world.breathe(now / 1000);

  grade.render(seconds);
}

function resize(): void {
  const width = canvasHost!.clientWidth;
  const height = canvasHost!.clientHeight;
  if (width === 0 || height === 0) return;
  // Through the composer, which forwards to the renderer and resizes every intermediate target with
  // it. Calling `renderer.setSize` as well would leave the buffers a frame behind on every drag.
  grade.setSize(width, height);
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

  /* ------------------------------------------------------------- click-to-move */

  /** Where the pointer currently resolves to, simulation pixels — `null` when not held or off the ground. */
  get clickTarget(): { x: number; y: number } | null {
    const target = pointer.lastTarget;
    return target ? { x: target.simX, y: target.simY } : null;
  },
  /** Whether a hold has crossed the threshold and is currently driving a steer intent. */
  get steering(): boolean {
    return pointer.steering;
  },
  /** Whether the primary pointer button is currently held over the canvas. */
  get pointerDown(): boolean {
    return pointer.pointerDown;
  },

  get window(): { cellsX: number; cellsY: number; margin: number; max: number } {
    return { cellsX: WINDOW_CELLS_X, cellsY: WINDOW_CELLS_Y, margin: WINDOW_MARGIN, max: MAX_WINDOW_CHUNKS };
  },
  get fps(): number {
    return Math.round(fps);
  },

  /* ------------------------------------------------------------------ M4 */

  /**
   * `'neutral'` or `'agx'`. **The comparison the plan asks for, live.**
   *
   * Also the **T** key, because the honest way to judge two tone curves is to flip between them with
   * the reference on the other monitor, not to reload the page between them.
   */
  get toneMapping(): ToneMapping {
    return grade.toneMapping;
  },
  set toneMapping(mode: ToneMapping) {
    grade.toneMapping = mode;
  },
  /** The two tone curves are only comparable at a matched exposure; this is how you match them. */
  get exposure(): number {
    return grade.exposure;
  },
  set exposure(value: number) {
    grade.exposure = value;
  },
  /** What the player wants. The rain itself also needs there to be no roof — see the frame loop. */
  get rainEnabled(): boolean {
    return rainWanted;
  },
  set rainEnabled(on: boolean) {
    rainWanted = on;
  },
  /** Whether it is actually falling right now: `rainEnabled` and no roof. */
  get raining(): boolean {
    return rain.enabled;
  },
  get rainOpacity(): number {
    return rain.opacity;
  },
  set rainOpacity(value: number) {
    rain.opacity = value;
  },
  /** Texels a side. Writing it disposes the old shadow map; three builds the new one next frame. */
  get shadowMapSize(): number {
    return world.night.shadowMapSize;
  },
  set shadowMapSize(size: number) {
    world.night.shadowMapSize = size;
  },
  get fogDensity(): number {
    return world.night.fogDensity;
  },
  set fogDensity(value: number) {
    world.night.fogDensity = value;
  },
  /** Fog and background as one `0xRRGGBB`. The single most likely thing to want to try by hand. */
  get fogColour(): number {
    return world.night.nightColour;
  },
  set fogColour(hex: number) {
    world.night.nightColour = hex;
  },
  /**
   * The light pool's own audit.
   *
   * `visible` must equal `total` for ever. If it does not, something switched a light off with
   * `visible` instead of `intensity` and three has been recompiling shaders — see `lights.ts`.
   */
  get lightsInUse(): ReturnType<World3D['lights']['audit']> {
    return world.lights.audit();
  },
  /** The orthographic volume the moon's shadow camera was fitted to this frame. */
  get moon(): ShadowFit {
    return world.night.fit;
  },
  /** How the loaded window divides between unseen, remembered and visible. */
  get fogOfWar(): ReturnType<World3D['fogCensus']> {
    return world.fogCensus();
  },
  get roofed(): boolean {
    return world.roofed;
  },
  /**
   * Compiled shader programs. **The number that must stop moving.**
   *
   * Expect it to settle within the first few frames and never change again while walking: the light
   * counts are fixed at boot, the material pool is two programs, and nothing is added to the scene
   * afterwards. It moves once more if you press **T** — a tone-mapping mode is a `#define`.
   */
  get programs(): number {
    return renderer.info.programs?.length ?? 0;
  },
  get bloomIntensity(): number {
    return grade.bloomIntensity;
  },
  set bloomIntensity(value: number) {
    grade.bloomIntensity = value;
  },
  get bloomThreshold(): number {
    return grade.bloomThreshold;
  },
  set bloomThreshold(value: number) {
    grade.bloomThreshold = value;
  },
  /**
   * Objects currently flagged to bloom — the live check that the selection wiring reached them.
   *
   * Zero in a room with no portal is correct. Zero *while looking at a portal ring* means the pooled
   * wrapper never made it into the selection, and the ring will be lit but will not glow.
   */
  get bloomSelected(): number {
    return grade.glowing;
  },
  /**
   * Turn the depth mask off and let the luminance threshold do the selecting on its own.
   *
   * A diagnostic rather than a look knob, and the order of the two statements matters: the grade
   * clears the flags already written onto pooled wrappers, and the world stops writing new ones. Read
   * `post.ts`'s `selective` before reaching for it — the symptom it answers is `bloomSelected` above
   * zero while a portal ring in front of you refuses to glow.
   */
  get bloomSelective(): boolean {
    return grade.selective;
  },
  set bloomSelective(on: boolean) {
    grade.selective = on;
    world.setGlowSet(on ? grade.glow : undefined);
  },

  /* ------------------------------------------------------------------ M5a */

  /** Baked tree variants whose meshes are all in the pool. Eight when the bake is whole. */
  get treesLoaded(): number {
    return world.trees.loaded;
  },
  /** Trees standing in the loaded window right now. The number a dense forest room is judged on. */
  get treeInstances(): number {
    return world.scatterCensus().trees;
  },
  /** Every scatter instance including undergrowth — trunks, canopies and tufts. */
  get scatterInstances(): number {
    return world.scatterCensus().instances;
  },
  /**
   * Compiled programs the material pool can produce, and the depth programs beside them.
   *
   * **The M5a number to watch.** Three colour programs — plain Lambert, blended ground, card foliage
   * — and one depth program for the foliage's `customDepthMaterial`. Fixed at boot: every difference
   * within a family is a uniform. Compare against `programs` above, which is what the driver actually
   * compiled and includes three's own shadow, and the composer's full-screen passes.
   */
  get foliagePrograms(): { materials: number; depth: number } {
    const ledger = world.ledger();
    return { materials: ledger.programs, depth: ledger.depthProgramCount };
  },
  /**
   * Whether the foliage sways — the **F** key's other end.
   *
   * One uniform, shared by every canopy, every tuft and **every one of their depth materials**. Turn
   * it off and watch a tree's shadow not move: that is `foliage.ts`'s trap 1 passing, by hand.
   */
  get windEnabled(): boolean {
    return world.windEnabled;
  },
  set windEnabled(on: boolean) {
    world.windEnabled = on;
  },

  /* ------------------------------------------------------------------ M5b */

  /** Quaternius models whose every primitive is in the pool. Sixty-three when the import is whole. */
  get kitLoaded(): number {
    return world.kit.loaded;
  },
  /** Kit textures loaded, and the megabytes they cost on the wire. The compression slice's target. */
  get kitTextures(): { count: number; megabytes: number } {
    return { count: world.kit.textures, megabytes: Number((world.kit.textureBytes / 1024 / 1024).toFixed(2)) };
  },
  /** Kit understory instances standing in the loaded window — trees excluded, they are `treeInstances`. */
  get kitInstances(): number {
    return world.scatterCensus().kit;
  },
  /** Chunks in the window currently drawing a water surface. Zero everywhere but a shore. */
  get waterChunks(): number {
    return world.scatterCensus().water;
  },
  /**
   * 0..1. Writable, because *"is the wet response too strong"* is a judgement made by looking and
   * waiting six seconds for a storm to soak in is six seconds too long to hold an opinion.
   */
  get wetness(): number {
    return world.wetness;
  },
  set wetness(value: number) {
    wetness.value = value;
    world.setWetness(wetness.value);
  },
  /** The hour of the game day, 0..24. See `World3D.setGameHour`: the server ticks no clock. */
  get hour(): number {
    return gameHour;
  },
  set hour(value: number) {
    applySky(value);
  },
  /** Which recipe the rig is wearing, by name — `night`, `day`, or a blend like `dawn->day`. */
  get sky(): string {
    return world.night.sky?.name ?? 'night';
  },
  /** The estimated texture memory, beside the ledger, because at M5b it is the biggest number. */
  get textureBytes(): number {
    return world.ledger().textureBytes;
  },

  /* ------------------------------------------------------------------ M5c */

  /**
   * Whether the world bends — the **V** key's other end.
   *
   * Off is the lattice M5b shipped, exactly. Flipping it is the whole acceptance: the ground, the
   * walls, the trees, the kit, the water, the rings, the lights and the bodies must all move
   * *together*, because they all read one field. Anything that stays put when the rest moves is
   * something that was left out of the lens.
   */
  get warpEnabled(): boolean {
    return world.warpEnabled;
  },
  set warpEnabled(on: boolean) {
    world.warpEnabled = on;
  },
  /**
   * The lens at the character's own feet: the metres the ground under them has been pushed, the
   * sector amplitude there, and the round-trip error of the inverse the pointer runs.
   *
   * The third number is the one to watch. It is `|invert(warp(p)) - p|` at the position the player is
   * standing in, in metres, and it is what stands between a click and the tile it means.
   */
  get warp(): { dx: number; dz: number; amplitude: number; inverseError: number } | undefined {
    const self = entities.self();
    const field = world.warp;
    const frame = world.frame;
    if (!self || !field || !frame) return undefined;
    const x = metresOfPixel(self.x);
    const z = metresOfPixel(self.y);
    const there: WarpVec = { x: 0, z: 0 };
    field.displaceInto(there, x, z, frame.level);
    const back: WarpVec = { x: 0, z: 0 };
    field.invertInto(back, x + there.x, z + there.z, frame.level);
    return {
      dx: Number(there.x.toFixed(3)),
      dz: Number(there.z.toFixed(3)),
      amplitude: Number(field.ampAt(x, z, frame.level).toFixed(3)),
      inverseError: Number(Math.hypot(back.x - x, back.z - z).toFixed(4)),
    };
  },
};

(window as unknown as { __debug3d: typeof debug }).__debug3d = debug;

/* -------------------------------------------------------------------------- */
/* The look keys                                                               */
/* -------------------------------------------------------------------------- */

/**
 * **T** cycles the tone mapping, **R** toggles the rain, **B** toggles the bloom, **F** the wind,
 * M5c's **V** the domain warp — and M5b's **G** flips day against night, with **[** and **]** sweeping
 * the hour an hour at a time.
 *
 * **V** is M5c's own version of what **F** does for trap 1: the warp is applied in two places, in a
 * vertex shader for the continuous surfaces and on the CPU for everything that is an object, and the
 * only way those two can be seen to agree is to switch them off together and watch nothing move
 * relative to anything else.
 *
 * Keys because M4 and M5 are judgements made by looking, and reaching for the console between looks
 * costs the comparison its immediacy — the plan's *"judge it side by side with the reference on the
 * same monitor"* is a thing you do with a keyboard. **F** earns its place twice over: it is the mood
 * knob for the foliage *and* the fastest hand check of `foliage.ts`'s trap 1, because a shadow that
 * jumps when the wind stops is a depth material that was never carrying the displacement. **G** is
 * M5b's equivalent: the kit was chosen off sunlit screenshots and M4 tuned only the night, so the two
 * have to be comparable in one keystroke or one of them will quietly stay wrong.
 *
 * `[` and `]` are `BracketLeft`/`BracketRight` by **code**, not by key, so they are the same two
 * physical keys on every layout — the sweep is a gesture (hold and step) and a gesture wants a
 * position, not a character.
 *
 * Both of `CLAUDE.md`'s input traps apply and both are answered the way `input.ts` answers them. The
 * gate is checked *and* `intoFormControl` is asked, so a **t** typed into the command line reaches the
 * command line — the letter-eating failure in gotcha 5a arrived through exactly this door, from a
 * listener that read a key it had no business reading. Nothing here calls `preventDefault`, and the
 * decision is taken on the `keydown` event with `event.repeat` refused rather than polled, which is
 * gotcha 5b. **The bracket keys deliberately do not refuse `repeat`**: a sweep is the one case where
 * auto-repeat is the feature, and they are read off the event rather than polled either way.
 */
window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (input.typing || intoFormControl(event.target)) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
    applySky(gameHour + (event.code === 'BracketRight' ? 1 : -1));
    log.write('system', `time: ${clockOf(gameHour)} (${world.night.sky?.name ?? 'night'})`);
    return;
  }
  if (event.repeat) return;
  switch (event.code) {
    case 'KeyT': {
      const at = TONE_MAPPINGS.indexOf(grade.toneMapping);
      const next = TONE_MAPPINGS[(at + 1) % TONE_MAPPINGS.length] ?? TONE_MAPPINGS[0]!;
      grade.toneMapping = next;
      log.write('system', `tone mapping: ${next}`);
      return;
    }
    case 'KeyR':
      rainWanted = !rainWanted;
      log.write('system', `rain: ${rainWanted ? 'on' : 'off'}`);
      return;
    case 'KeyB':
      grade.bloomIntensity = grade.bloomIntensity > 0 ? 0 : 1.9;
      log.write('system', `bloom: ${grade.bloomIntensity > 0 ? 'on' : 'off'}`);
      return;
    case 'KeyF':
      world.windEnabled = !world.windEnabled;
      log.write('system', `wind: ${world.windEnabled ? 'on' : 'off'}`);
      return;
    case 'KeyV':
      // M5c. Straightens the world back onto its lattice — the before-and-after the whole milestone
      // is judged on, and the fastest way to see that the walls, the trees and the bodies all move
      // through the *same* lens as the ground: nothing should shift relative to anything else.
      world.warpEnabled = !world.warpEnabled;
      log.write('system', `warp: ${world.warpEnabled ? 'on' : 'off (the grid, as it was)'}`);
      return;
    case 'KeyG': {
      // Jump to whichever of the two the rig is not near. Midnight and noon are the two keys the
      // recipes were authored at, so the flip lands on an authored sky rather than on a blend.
      const day = gameHour >= 9 && gameHour < 17;
      applySky(hourOf(day ? NIGHT_SKY : DAY_SKY));
      log.write('system', `time: ${clockOf(gameHour)} — ${day ? NIGHT_SKY.name : DAY_SKY.name}`);
      return;
    }
    default:
      return;
  }
});

log.write(
  'system',
  'M5c — T: tone mapping (neutral/agx)   R: rain   B: bloom   F: wind   V: warp   G: day/night' +
    '   [ ]: sweep the hour.  Knobs on window.__debug3d.',
);

net.connect();

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
