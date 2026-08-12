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
 * And since the world clock landed, `sky`: the game hour, the weather and the ambient light over this
 * character's own zone. See `sky.ts` for the interpolation the handler feeds and the reason the sky
 * is applied inside the handler rather than on the next frame.
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
 * with the reference image beside them. `toneMapping`, `exposure`, `rainEnabled`, `rainOverride`,
 * `rainOpacity`, `shadowMapSize`, `fogDensity`, `fogColour`, `bloomIntensity`, `bloomThreshold`,
 * `hour` and `wetness` all take. Nothing in the *simulation* reads any of them; they reach the
 * renderer and stop there. Two of them are **overrides** over a fact the server is authoritative
 * about — `hour` and `rainOverride` — and both say so in `.sky` and `.rainOverride` rather than
 * silently diverging; see the look keys at the foot of this file.
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

import { TILE_SIZE, samePlace, type Direction, type Place, type SkyView } from '@mygame/shared';

import { DAY_SKY, NIGHT_SKY, clockOf, hourOf, normaliseHour, skyAt } from './daylight.ts';
import { approach, skyFor, type Enclosure } from './indoors.ts';
import { Dolly, rememberPose, rememberedPose, type CameraPose } from './dolly.ts';
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
import { CAMERA_DISTANCE_MAX, CAMERA_DISTANCE_MIN, CAMERA_PITCH_MAX, CAMERA_PITCH_MIN, CameraRig } from './rig.ts';
import { SkyClock, stormy, type Falling } from './sky.ts';
import {
  MAX_WINDOW_CHUNKS,
  RING_COVER,
  WINDOW_CELLS_NORTH,
  WINDOW_CELLS_SOUTH,
  WINDOW_CELLS_X,
  WINDOW_CELLS_Y,
  maxDistanceForAspect,
} from './streamer.ts';
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
const dolly = new Dolly();

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

/**
 * M6's boot step: the Medieval Village kit — eleven drawn models and six shared textures.
 *
 * Not awaited, and this one has the strongest version of the argument the other two make: **the world
 * is correct without it.** `chunkPlan` gives every roofed room a lid whether or not this ever
 * resolves, so a client with no `models/village` on disk shows grey interiors with no sky in them
 * rather than a hole in the roof. What the kit adds is plaster, boards, arches and tile.
 *
 * The gate is all-or-nothing at the *shell* level — `VillageSet.available` is true only when every
 * wall in every palette and every floor has registered — because `chunkPlan`'s `dressed` flag
 * suppresses the grey boxes, and half a kit would be half a room's walls missing. See `village.ts`.
 */
void world.village.load(world.pool).then((problem) => {
  if (problem) log.write('error', problem);
  else {
    log.write(
      'system',
      `village: ${world.village.loaded} models, ${world.village.triangles} tris, ` +
        `${world.village.textures} textures (${(world.village.textureBytes / 1024 / 1024).toFixed(1)} MB)`,
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
  // And the wheel, on the same one boolean. Three listeners that each decided for themselves what
  // counts as typing is the shape gotcha 5a warns about; there is one answer and they all read it.
  dolly.typing = input.typing;
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
/* The dolly — M6's live frame                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Move the rig, and carry the new frame to everything that was tuned against the old one.
 *
 * The order is the load-bearing part. The rig is written first because everything downstream is
 * derived from `rig.ground()`, and `rig.ground()` is only right once the clamp has had its say — a
 * caller that computed the fade band from the number it *asked* for rather than the one the rig
 * *took* would put the band a metre outside the frame at either end of the range.
 *
 * `remember` is false for the boot restore and for a resize: writing storage from the value that was
 * just read out of it is noise, and a resize is the window's decision rather than the owner's.
 */
function applyCameraPose(pose: CameraPose, remember = true): void {
  rig.distance = pose.distance;
  rig.pitch = pose.pitch;
  // The undergrowth's fade band, the moon's shadow volume and M6's near-wall set, in one call. See
  // `World3D.setCameraFrame`.
  world.setCameraFrame(rig.ground(), rig.pitch);
  if (remember) rememberPose({ distance: rig.distance, pitch: rig.pitch });
}

dolly.poseOf = () => ({ distance: rig.distance, pitch: rig.pitch });
// The ring cannot cover the fully-pulled-back frame on a very wide canvas, so the *dolly* stops
// sooner rather than the frame showing void at its far corners. Recomputed on every resize below.
dolly.ceilingOf = () => rig.maxDistance;
dolly.onPose = (pose) => applyCameraPose(pose);
dolly.attach(renderer.domElement);

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

/**
 * The world's clock and the weather over this character — `{t:'sky'}`, and the whole of the slice's
 * inbound half.
 *
 * **Applied here rather than on the next frame, and that is the "no flash of wrong sky" clause.** The
 * server sends this at `welcome`, immediately after `zone` and *before* the first room description
 * (`index.ts:10874`) — so the message that says what hour it is arrives before the message that
 * causes anything to be built. Applying it synchronously means the very first frame that has a world
 * in it also has the right sky over that world; deferring to the frame loop would put one frame of
 * midnight in front of an afternoon, at the one moment the player is looking hardest.
 *
 * It also arrives on every Place change (weather is per zone, so walking out of a dry wood into a
 * rainstorm has to say so), on every game hour, whenever the zone's weather turns, and whenever an
 * operator throws `gameHourMs` — which is how a change of *rate* reaches the interpolation.
 *
 * **A message that will not sanitise leaves the held sky running** (`SkyClock.accept`), and so does a
 * server that never sends one. Neither is an error and neither writes to the log: the log is the
 * player's, and a malformed frame of weather is not their problem.
 */
net.on('sky', (message) => {
  const now = performance.now();
  if (!sky.accept(message.view, now)) return;
  // Under a manual override this is the *same* hour it already was — but the gloom may have moved, so
  // the sky is re-applied anyway. A storm that darkened the afternoon must still darken the noon the
  // owner pinned with **G**; the override is over the clock, not over the weather.
  const hour = sky.hourAt(now);
  if (hour !== undefined) applySky(hour);
});

net.on('log', (message) => log.write(message.channel, message.text));
net.on('rejected', (message) => log.write('error', `Rejected: ${message.reason}`));

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

let last = performance.now();
let fps = 0;
/**
 * A human's standing instruction about the rain, or `undefined` for *"whatever the world says"*.
 *
 * Three writers and they must not fight: the **R** key, `__debug3d.rainEnabled` and — since the world
 * clock — the served sky. The frame composes them in one place ({@link rainWanted}) and ANDs the
 * answer with "is there a roof overhead" before touching the mesh. Letting any writer set `visible`
 * directly would mean stepping into a cave permanently turned the toggle off.
 *
 * **`undefined` rather than a boolean default**, so that "nobody has an opinion" is a state the
 * composition can see: with no served sky it falls through to M4's always-on rain, which is what a
 * client talking to a server that predates the clock should still do.
 */
let rainOverride: boolean | undefined;

/**
 * The world's own sky: the last `{t:'sky'}`, when it landed, and whether a human has taken the hour.
 *
 * Held here beside `rainOverride` and `gameHour` for the reason all three are — none of it draws, and
 * the renderer must not own a fact the server is authoritative about. See `sky.ts` for the
 * interpolation, the snow decision and the storm-light mapping.
 */
const sky = new SkyClock();

/**
 * What the rain should be doing, from the three writers, in precedence order.
 *
 * A hard override outranks the world, because that is what pressing **R** while standing in a
 * downpour has to mean; the world outranks the default, because that is the whole slice; and the
 * default is `true`, because that is M4's world and the thing an old server must still get.
 */
function rainWanted(): boolean {
  return rainOverride ?? sky.raining ?? true;
}

/**
 * How wet the world is, and the ramp that gets it there. M5b.
 *
 * Held here beside `rainWanted` because it is driven by the same question the rain is — *is it
 * falling on this character right now* — and answered on the frame that already knows. See
 * `wetness.ts` for why the rise is fast and the dry-off is slow.
 */
const wetness = new Wetness();

/**
 * The hour of the game day, as last applied. **A server value now, and the note it replaces was
 * right about how it would arrive.**
 *
 * M5b recorded that `packages/server/src` ticked no game clock and that `World3D.setGameHour` was
 * *"the named hook a future server clock writes; nothing else would change"*. The clock arrived
 * (`f85b5fb`) and nothing else did change: this is still the one number the lighting is derived
 * from, and it is now written every frame from `sky.hourAt(now)` instead of only by a keypress.
 *
 * It starts at midnight, which is M4's world, and stays there until either a `sky` message or a
 * keypress moves it — so a client talking to a server that predates the clock is exactly M5b's.
 */
let gameHour = 0;

/**
 * How far across the threshold the light is — 0 out of doors, 1 fully indoors. M6.
 *
 * Held beside `gameHour` rather than inside `World3D` because it is the same *kind* of thing: a
 * client-side presentation value the server has no opinion about, driven by the frame loop, and one
 * that a future server clock (for the hour) or a future portal effect (for this) would write through
 * a named hook rather than by reaching into the scene graph.
 */
let indoorBlend = 0;
let indoorTarget: Enclosure = 'outdoor';

/**
 * Apply a sky: the scene graph takes the lights and the fog, the composer takes the exposure.
 *
 * **Three layers, composed outermost-last, and the order is the design.**
 *
 * 1. `skyAt(hour)` — the hour, which is now the world's own and no longer a debug key's.
 * 2. `stormy(…, sky.gloom)` — the weather over that hour, which dims the key light and opens the
 *    camera a little. **Outdoor only, and that is the point**: it is folded in *before* the enclosure
 *    so the interior blend crosses from the storm-lit street to the lamplit room, one interpolation,
 *    no pop and no second threshold. At `gloom === 0` it returns the hour's own object untouched, so
 *    a dry world is byte-for-byte M5b's.
 * 3. `skyFor(…, enclosure, blend)` — M6's threshold, unchanged and unaware that layer 2 exists.
 *
 * At `indoorBlend === 1` every field of the result is the interior recipe's, which is still the whole
 * of *"the daylight keys keep working outside and do nothing weird inside"* — and now also of "the
 * weather stops at the door", for free, because a storm that could reach inside would have to be a
 * fourth layer applied after the third.
 */
function applySky(hour: number): void {
  gameHour = normaliseHour(hour);
  // The named hook first — the one `daylight.ts` promised the server clock would write, and it does.
  // It records the hour and applies the outdoor sky. Then the weather and the enclosure over the top,
  // which is a second `NightRig.sky` write and eight more dot products; on a dry day out of doors it
  // is the same recipe object and the second write is exactly idempotent, which is what keeps a clear
  // sky identical to M5b's.
  world.setGameHour(gameHour);
  const recipe = skyFor(stormy(skyAt(gameHour), sky.gloom), indoorTarget, indoorBlend);
  world.night.sky = recipe;
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
    // geometry to hide the sky until M6 — is to stop the rain when the character is under one. The
    // *whether* is now the world's (`rainWanted` composes the three writers); the roof gate is
    // unchanged, which is what keeps the wet ground and the puddles behaving exactly as M5b tuned.
    rain.enabled = rainWanted() && !world.roofed;
    // And the *how hard*. A hard **R** on means M4's storm at full strength — the key means "show me
    // the rain" — while the world's own rate drives everything else. See `sky.rainDensityOf`.
    rain.density = rainOverride === true ? 1 : (sky.rainDensity ?? 1);
  } else {
    // No body yet: the login card is still up and the storm has nowhere to be centred.
    rain.enabled = false;
  }
  // M6's threshold. The target is the room the character is standing in; the blend walks toward it,
  // and — with the world clock's hour, below — the sky is re-applied only on the frames one of the
  // two actually moved. A session standing still out of doors costs two comparisons a frame.
  const enclosure = world.enclosure;
  // **The remembered end of the fade is the last interior, not the current room.** Stepping out of a
  // tavern sets the target to `outdoor`, and `skyFor` has no recipe for that — it would return the
  // hour's sky outright and the transition would be a cut. So the interior end is held and only the
  // scalar moves, which also makes a cave mouth into a cellar a fade between the two interiors
  // through the sky rather than a restart.
  if (enclosure !== 'outdoor') indoorTarget = enclosure;
  const wanted = enclosure === 'outdoor' ? 0 : 1;
  const stepped = approach(indoorBlend, wanted, seconds);
  const crossing = stepped !== indoorBlend;
  if (crossing) indoorBlend = stepped;
  // The world's clock, scrubbed. `hourAt` is `undefined` when nobody has told us the time — an old
  // server, or a `welcome` still in flight — and the hour then stays wherever it was, which is M4's
  // midnight or whatever the owner last pinned. Under a manual override it returns that pin
  // unchanged, so `moved` is false and the whole sky costs one comparison a frame, exactly as M6's
  // threshold does. Live, it is quantised to `SKY_HOUR_STEP` so a 75 s hour re-applies about seven
  // times a second rather than sixty, for a colour step no display can show — see `sky.ts`.
  const live = sky.hourAt(now);
  const moved = live !== undefined && live !== gameHour;
  // One call for both, so an hour that turns on the same frame as a doorway is one write and not two.
  if (crossing || moved) applySky(live ?? gameHour);
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
  // M6. The frame's *width* is the canvas aspect's business as much as the rig's, so both derived
  // systems have to be told — and the dolly's ceiling with them, because a canvas that has just been
  // dragged out to 21:9 can no longer show 48 m of pull-back inside the built ring. Writing
  // `maxDistance` pulls the live distance in with it if it has to.
  rig.maxDistance = maxDistanceForAspect(rig.camera.aspect);
  applyCameraPose({ distance: rig.distance, pitch: rig.pitch }, false);
}

window.addEventListener('resize', resize);
resize();
// The pose this tab was last left at, if it is not the default one. Applied after the first `resize`
// so the aspect-derived ceiling is already in force and a remembered 48 m on a now-narrower window
// is clamped rather than honoured.
applyCameraPose(rememberedPose() ?? { distance: rig.distance, pitch: rig.pitch }, false);
requestAnimationFrame(frame);

/* -------------------------------------------------------------------------- */
/* The debug object                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `__debug3d.camera` — **the readout the whole milestone exists to produce.**
 *
 * The owner turns the wheel until the frame looks right and then reads these two numbers off the
 * console; they are what gets baked into `rig.CAMERA_DISTANCE` and `space.CAMERA_PITCH_DEGREES`
 * later. Everything else on the object is there so the answer can be sanity-checked without
 * screenshots: `ground` is the trapezoid the pose actually shows, `fade` is where the undergrowth
 * dissolves in view-space metres, and `maxDistance` is the ceiling this canvas's aspect allows.
 *
 * One persistent object rather than a fresh literal from a getter, so `__debug3d.camera.distance =
 * 42` in the console does what it obviously means. Writing either number goes through the same
 * `applyCameraPose` the wheel does, so the fade band, the shadow volume and the stored pose all
 * follow a typed value exactly as they follow a scrolled one.
 */
const cameraKnob = {
  get distance(): number {
    return Number(rig.distance.toFixed(3));
  },
  set distance(metres: number) {
    applyCameraPose({ distance: metres, pitch: rig.pitch });
  },
  get pitch(): number {
    return Number(rig.pitch.toFixed(3));
  },
  set pitch(degrees: number) {
    applyCameraPose({ distance: rig.distance, pitch: degrees });
  },
  /** The clamp, so a value that refuses to take is obviously a clamp and not a broken setter. */
  get limits(): { distance: [number, number]; pitch: [number, number] } {
    return {
      distance: [CAMERA_DISTANCE_MIN, Math.min(rig.maxDistance, CAMERA_DISTANCE_MAX)],
      pitch: [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX],
    };
  },
  /** Lower than {@link CAMERA_DISTANCE_MAX} only on a canvas too wide for the ring. `streamer.ts`. */
  get maxDistance(): number {
    return Number(rig.maxDistance.toFixed(3));
  },
  /** Metres of ground this pose shows, ahead/behind/either side, and its view-depth range. */
  get ground(): Record<string, number> {
    const g = rig.ground();
    return {
      north: Number(g.north.toFixed(2)),
      south: Number(g.south.toFixed(2)),
      halfWidthFar: Number(g.halfWidthFar.toFixed(2)),
      nearDepth: Number(g.nearDepth.toFixed(2)),
      farDepth: Number(g.farDepth.toFixed(2)),
    };
  },
  /** Where the undergrowth fades, live. Both bands must sit outside `ground.nearDepth`. */
  get fade(): ReturnType<World3D['pool']['fadeBands']> {
    return world.pool.fadeBands();
  },
  /** Half-extents the moon's shadow volume is currently fitted to. Grows with the frame. */
  get shadow(): { width: number; depth: number } {
    const { width, depth } = world.night.extents;
    return { width: Number(width.toFixed(2)), depth: Number(depth.toFixed(2)) };
  },
  /** Back to the authored pose, and forget the remembered one. Also the **C** key. */
  reset(): CameraPose {
    rig.reset();
    applyCameraPose({ distance: rig.distance, pitch: rig.pitch });
    return { distance: rig.distance, pitch: rig.pitch };
  },
};

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

  /**
   * The streaming ring's shape and the metres of built ground it guarantees in each direction.
   *
   * Asymmetric since M6 — `north` is one cell more than `south`, because the camera looks north and
   * the frame is a trapezoid. See `streamer.ts`.
   */
  get window(): {
    cellsX: number;
    cellsY: number;
    north: number;
    south: number;
    max: number;
    coverMetres: typeof RING_COVER;
  } {
    return {
      cellsX: WINDOW_CELLS_X,
      cellsY: WINDOW_CELLS_Y,
      north: WINDOW_CELLS_NORTH,
      south: WINDOW_CELLS_SOUTH,
      max: MAX_WINDOW_CHUNKS,
      coverMetres: RING_COVER,
    };
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
  /**
   * What the rain is being asked to do, from all three writers. The rain itself also needs there to
   * be no roof — see the frame loop.
   *
   * Writing it takes a **hard override**, exactly as pressing **R** does; `rainOverride = null` hands
   * it back to the world.
   */
  get rainEnabled(): boolean {
    return rainWanted();
  },
  set rainEnabled(on: boolean) {
    rainOverride = on;
  },
  /**
   * The standing instruction, or `null` for *"follow the world"* — the writable form of the **R** and
   * **Shift+R** pair. Reads `null` on a fresh client, which is why the rain follows the served sky.
   */
  get rainOverride(): boolean | null {
    return rainOverride ?? null;
  },
  set rainOverride(value: boolean | null) {
    rainOverride = value ?? undefined;
  },
  /** Whether it is actually falling right now: `rainEnabled` and no roof. */
  get raining(): boolean {
    return rain.enabled;
  },
  /**
   * How much of the storm is falling, 0..1 — the world's `precip` as drops. One when the world has
   * no opinion, which is M4's full storm.
   */
  get rainDensity(): number {
    return rain.density;
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

  /* ------------------------------------------------------------------- M6 */

  /**
   * The interior mode's whole state, in one object — **the read-out the milestone is judged on.**
   *
   * `enclosure` is which of the three light recipes is being asked for, `blend` is how far across the
   * threshold the light actually is (1 while standing still indoors), and `roofGroup` is the id of
   * the lid currently off — the smallest room id of the connected roofed component the character is
   * inside, so two rooms of one inn report the same number and the house next door reports a
   * different one. `interiors` counts the chunks in the window wearing village modules and
   * `villageInstances` the modules themselves, which together are the answer to "is anything actually
   * being dressed" without opening a picture.
   */
  get interior(): {
    enclosure: string;
    blend: number;
    roofGroup: number | undefined;
    cull: boolean;
    interiors: number;
    villageInstances: number;
    villageLoaded: number;
    dressing: boolean;
  } {
    const census = world.scatterCensus();
    return {
      enclosure: world.enclosure,
      blend: Number(indoorBlend.toFixed(3)),
      roofGroup: world.roofGroup,
      cull: world.roofCull,
      interiors: census.interiors,
      villageInstances: census.village,
      villageLoaded: world.village.loaded,
      dressing: world.village.available,
    };
  },
  /** Village textures loaded and the megabytes they cost. The compression slice's second target. */
  get villageTextures(): { count: number; megabytes: number } {
    return {
      count: world.village.textures,
      megabytes: Number((world.village.textureBytes / 1024 / 1024).toFixed(2)),
    };
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
  /**
   * The hour of the game day, 0..24, as last applied.
   *
   * **Writing it is a manual override**, exactly as pressing `[` is — the same act, so the same
   * consequence. `__debug3d.sky.live` goes false and stays false until **Shift+G**.
   */
  get hour(): number {
    return Number(gameHour.toFixed(4));
  },
  set hour(value: number) {
    applySky(sky.override(value));
  },
  /**
   * **The read-out this slice is judged on: is the sky the world's, or a human's?**
   *
   * `live` is true only while the hour is coming from the server's clock — a served view and no
   * override. `overridden` is the other half and they are not each other's negation: a client that
   * has never heard a `sky` message is neither, and that third state is the one to look for when the
   * sky is stuck at midnight (it means the server predates the clock, or `welcome` has not landed).
   *
   * `view` is the last served snapshot verbatim, clamped — the hour and progress the interpolation is
   * scrubbing from, the date, the weather, and the `wind`/`temp` fields nothing reads yet. `recipe`
   * is what the rig is actually wearing, which on a wet afternoon reads `dawn->day (storm 0.58)` and
   * indoors reads `inside`.
   */
  get sky(): {
    live: boolean;
    overridden: boolean;
    hour: number;
    recipe: string;
    falling: Falling;
    gloom: number;
    view: SkyView | undefined;
  } {
    return {
      live: sky.live,
      overridden: sky.overridden,
      hour: Number(gameHour.toFixed(4)),
      recipe: world.night.sky?.name ?? 'night',
      falling: sky.falling,
      gloom: Number(sky.gloom.toFixed(3)),
      view: sky.view,
    };
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

  /* ------------------------------------------------------------------ M6 */

  /** The live rig: `distance`, `pitch`, what they show, and `reset()`. See {@link cameraKnob}. */
  get camera(): typeof cameraKnob {
    return cameraKnob;
  },
};

(window as unknown as { __debug3d: typeof debug }).__debug3d = debug;

/* -------------------------------------------------------------------------- */
/* The look keys                                                               */
/* -------------------------------------------------------------------------- */

/**
 * **T** cycles the tone mapping, **R** toggles the rain, **B** toggles the bloom, **F** the wind,
 * M5c's **V** the domain warp, M6's **C** puts the camera back on its authored pose — and M5b's **G**
 * flips day against night, with **[** and **]** sweeping the hour an hour at a time.
 *
 * ## Since the world clock: the same keys, as *overrides*
 *
 * The hour is the server's now, so **G**, **[** and **]** can no longer simply set it — the next
 * message would take it straight back, and a key that undoes itself in under a second is worse than
 * no key. So touching any of them **detaches** the hour from the live clock and pins it (`SkyClock`'s
 * `override`), and `__debug3d.sky.live` goes false so the state is readable rather than guessed at.
 *
 * **Shift+G hands it back.** Not a double-tap and not a hold: a chord is one gesture with no timing
 * window to miss, it is read off `event.shiftKey` at the moment of the press — which is `CLAUDE.md`
 * gotcha 5b's own prescription, and the trap that gotcha describes is precisely a modifier tested
 * after the edge was consumed — and it binds no new letter, which matters because every letter bound
 * here is a letter that can go missing out of the command line. **Shift+R** is its twin for the rain,
 * for the same reason and by the same rule: the bare letter takes manual control, the shifted one
 * gives it back to the world.
 *
 * **R stays a hard override in both modes.** Pressing it flips whatever is currently falling and
 * pins that, whether the hour is live or held; the weather and the clock are separate wheels and
 * grabbing one does not grab the other. Which is also why the `sky` handler re-applies the sky under
 * an override: the storm's own dimming is the *weather's*, and the pinned hour does not exempt the
 * frame from it.
 *
 * M6 adds no other letter on purpose: its two controls are the wheel and Shift+wheel (`dolly.ts`),
 * because a hunt for a frame wants a dial and because every letter bound here is a letter that can
 * go missing out of the command line.
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
    // Stepped from whatever the frame is *showing* rather than from whatever was last pinned, so the
    // first press off a live clock lands an hour from now and not an hour from midnight.
    const from = sky.hourAt(performance.now()) ?? gameHour;
    applySky(sky.override(from + (event.code === 'BracketRight' ? 1 : -1)));
    log.write('system', `time: ${clockOf(gameHour)} (${world.night.sky?.name ?? 'night'}) — held, shift+G to release`);
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
      if (event.shiftKey) {
        // Back to the world's weather. Says what it went back *to*, because "released" on its own
        // leaves the owner unable to tell a dry sky from a broken toggle.
        rainOverride = undefined;
        log.write(
          'system',
          sky.served
            ? `rain: the world's — ${sky.falling === 'none' ? 'dry' : sky.falling}`
            : 'rain: the world has sent no sky, so the default (on) stands',
        );
        return;
      }
      // A hard override, from whatever is currently being asked for — so the key always flips what
      // the owner can see, whether that was the world's answer or their own.
      rainOverride = !rainWanted();
      log.write('system', `rain: ${rainOverride ? 'on' : 'off'} (held, shift+R to release)`);
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
    case 'KeyC': {
      // M6. The wheel is a hunt and a hunt needs a way home: **C** puts the rig back on the pose the
      // world was authored at and forgets the remembered one, so the next reload starts there too.
      //
      // A key rather than a double-tap of the tilt control, which is Shift+wheel and has no tap to
      // double. It is also the only *letter* this milestone binds, which is why it goes through the
      // same `input.typing` / `intoFormControl` gate as every other one — `CLAUDE.md` gotcha 5a.
      const pose = cameraKnob.reset();
      log.write('system', `camera: ${pose.distance} m at ${pose.pitch}° (default)`);
      return;
    }
    case 'KeyK':
      // M6. Puts the lids back on over the player's head — the milestone's A/B, in the pattern **F**
      // set for the wind and **V** for the warp. Standing in a tavern with it off, the frame is
      // exactly what §6-M6 forbids; that is the point of the key.
      world.roofCull = !world.roofCull;
      log.write(
        'system',
        `roof cull: ${world.roofCull ? 'on' : 'off (the lid stays on, and the near wall with it)'}`,
      );
      return;
    case 'KeyG': {
      if (event.shiftKey) {
        // Back to the world's clock. `resume` is false when there is no clock to go back to — an old
        // server, or a `welcome` still in flight — and the hour then stays where it was pinned,
        // because there is nothing truer to return it to. Saying so beats silently doing nothing.
        const resumed = sky.resume();
        const live = sky.hourAt(performance.now());
        if (live !== undefined) applySky(live);
        log.write(
          'system',
          resumed
            ? `time: ${clockOf(gameHour)} — the world's clock, live`
            : `time: ${clockOf(gameHour)} — the world has sent no sky; the hour stays as set`,
        );
        return;
      }
      // Jump to whichever of the two the rig is not near, and hold it there. Midnight and noon are
      // the two keys the recipes were authored at, so the flip lands on an authored sky rather than
      // on a blend — which is the whole reason the key exists, and the reason it must pin rather than
      // let the next `sky` message drag it back off the key seventy-five seconds later.
      const day = gameHour >= 9 && gameHour < 17;
      applySky(sky.override(hourOf(day ? NIGHT_SKY : DAY_SKY)));
      log.write(
        'system',
        `time: ${clockOf(gameHour)} — ${day ? NIGHT_SKY.name : DAY_SKY.name} (held, shift+G to release)`,
      );
      return;
    }
    default:
      return;
  }
});

log.write(
  'system',
  'M6 — wheel: zoom (24-48 m)   shift+wheel: tilt (45-64°)   C: camera home   K: roof cull.  ' +
    'T: tone mapping   R: rain   B: bloom   F: wind   V: warp   G: day/night   [ ]: sweep the hour.  ' +
    'The sky follows the world clock: G and [ ] hold it, shift+G gives it back, shift+R the rain.  ' +
    'Read the frame you like off window.__debug3d.camera, the interior off .interior, the clock off .sky.',
);

net.connect();

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
