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
 *
 * ## The frame, after M8
 *
 * One line joins it and its position is load-bearing: **the follow ease writes the rig's yaw before
 * `rig.follow` aims it.** The camera's angle and its position are settled in the same tick or the
 * frame is drawn at last tick's angle from this tick's place, which at a half-second ease is a
 * visible lag on every corner the player turns. Four writers now touch the camera and they are
 * ordered rather than merely present: the wheel and the drag write a whole pose through
 * `applyCameraPose`; the ease writes the yaw alone through `applyCameraYaw`, which is the same path
 * minus the two things a yaw cannot change (the fade band and the shadow box's *size*) and minus the
 * `localStorage` write; and `resize` re-derives the dolly's ceiling from the new aspect.
 */

import { WebGLRenderer } from 'three';

import { TILE_SIZE, samePlace, type Direction, type Place, type SkyView } from '@mygame/shared';

import { DAY_SKY, NIGHT_SKY, clockOf, hourOf, normaliseHour, skyAt } from './daylight.ts';
import { approach, skyFor, type Enclosure } from './indoors.ts';
import { CharacterSet } from './characters.ts';
import { Compass, bearingOf, cardinalOf } from './compass.ts';
import { DEFAULT_POSE, Dolly, rememberPose, rememberedPose, type CameraPose } from './dolly.ts';
import { EntityLayer } from './entities.ts';
import { FollowCamera, OrbitControl } from './orbit.ts';
import { PlateSet } from './plates.ts';
import { metresOfPixel, pixelOfMetres } from './frame.ts';
import { cameraRelative, Input, suspendsFollow } from './input.ts';
import { CONTROLS, KeyRouter } from './keys.ts';
import { LogPanel } from './log.ts';
import { LoginGate } from './login.ts';
import { Marker } from './marker.ts';
import { Net } from './net.ts';
import { SHADOW_MAP_TYPE, type ShadowFit } from './night.ts';
import { BODY_POOL_SIZE } from './pool.ts';
import { Grade, TONE_MAPPINGS, type ToneMapping } from './post.ts';
import { PointerControl, type PointerTarget } from './pointer.ts';
import { Rain } from './rain.ts';
import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  CameraRig,
  groundRadius,
} from './rig.ts';
import { PrecipFade, SkyClock, stormy, type Falling } from './sky.ts';
import { Snow } from './snow.ts';
import { MAX_WINDOW_CHUNKS, RING_CELLS, RING_COVER, WINDOW_HALF, WINDOW_LEVELS, maxDistanceForAspect } from './streamer.ts';
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
/** M7b: the character packs, and the pooled text that floats over what they draw. */
const characters = new CharacterSet();
const plates = new PlateSet(world.scene);
const entities = new EntityLayer(world.scene, world.pool, characters, plates);
const input = new Input();
/** The other half of the keyboard: the view controls behind Alt, and every bare letter to the log. */
const keys = new KeyRouter();
const marker = new Marker(world.scene, world.pool);
const pointer = new PointerControl();
const dolly = new Dolly();
/** M8: the Shift+drag, the mode that keeps the camera behind the player, and the rose that says which way is north. */
const orbit = new OrbitControl();
const followCamera = new FollowCamera(DEFAULT_POSE.follow);
const compass = new Compass();

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

/**
 * The two weather fields, side by side and never both settled at once.
 *
 * `Snow` is `Rain`'s sibling rather than its subclass and the two share nothing but a shape: one
 * `InstancedMesh` each, one draw call each, a seeded buffer allocated once and a shader that wraps
 * the field about the character for free. Which of them is drawn is `fallingOf`'s answer and nothing
 * else's; {@link precipFade} carries the frames in between. See `snow.ts` for what differs — a disc
 * instead of a streak, alpha instead of additive, a thirteenth of the fall speed, a per-flake tumble,
 * and the wind.
 */
const rain = new Rain();
const snow = new Snow();
world.scene.add(rain.mesh);
world.scene.add(snow.mesh);

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

/**
 * M9's boot step: the Fantasy Props kit — 26 drawn models of 94, and four atlases of which three are
 * the character packs' own.
 *
 * Not awaited, and it is the weakest-stakes of the five: without it a furnished room is an M6 room,
 * which is a plastered box with a lid, and that is a correct picture of an empty room. `PropsSet` is
 * also the one registry whose gate is *liveness* rather than completeness — one barrel that arrives is
 * worth drawing, where one missing wall module stands the whole village kit down. See `props.ts`.
 *
 * Ordered after the village deliberately: `dressAll` in that file is what puts the wall textures on
 * the grey `edge` and `barrier` boxes, and both loads sweep the same shared texture cache.
 */
void world.props.load(world.pool).then((problem) => {
  if (problem) log.write('error', problem);
  else {
    log.write(
      'system',
      `props: ${world.props.loaded} models, ${world.props.triangles} tris, ` +
        `${world.props.textures} new atlases (${(world.props.textureBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
  }
});

/**
 * M7b's boot step: the character packs — 26 models, twelve atlases and two re-cut animation libraries.
 *
 * **Not awaited**, and the argument is the other three's with the stakes raised: this is the payload
 * that decides whether the owner's character has a body, and it is ~35 MB on a cold cache. Blocking
 * the renderer on it would trade *"capsules for a second"* for a black screen, and the capsule path is
 * still there and still correct — `entities.ts` draws one for any body with no rig, and takes a rig on
 * the first resync after the pack lands. So a session starts as M3's and becomes M7's without a
 * reload and without a frame of nothing.
 *
 * A missing `models/characters` — nobody ran `modelgen --characters` — is a world of capsules with the
 * reason in the log, which is exactly what M6 does for a missing village kit.
 */
void characters.load(world.pool).then((problem) => {
  if (problem) log.write('error', problem);
  else {
    const missing = characters.missingClips();
    log.write(
      'system',
      `characters: ${characters.loaded} models, ${characters.clipCount} clips ` +
        `(${(characters.animationBytes / 1024 / 1024).toFixed(1)} MB), ` +
        `${characters.textures} atlases (${(characters.textureBytes / 1024 / 1024).toFixed(1)} MB)`,
    );
    // A clip the state machine names and the pack did not ship is a body that freezes at the moment it
    // matters, so it is said out loud rather than swallowed by the mixer's own `undefined` action.
    if (missing.length > 0) log.write('error', `characters: missing clips ${missing.join(', ')}`);
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
  // Four now. M8's orbit is a fourth listener on the canvas and it reads the same answer.
  orbit.typing = input.typing;
  // Five. `keys.ts` is the second listener on the *window*, which is the pair gotcha 5a is actually
  // about — the one that did not check would eat a letter out of the command line.
  keys.typing = input.typing;
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
  rig.yaw = pose.yaw;
  followCamera.enabled = pose.follow;
  // The undergrowth's fade band, the moon's shadow volume and M6's near-wall set, in one call. See
  // `World3D.setCameraFrame`. The yaw goes with them since M8: the volume is oriented and the wall
  // set is a question about where the camera stands.
  world.setCameraFrame(rig.ground(), rig.pitch, rig.yawRadians);
  compass.update(rig.yaw);
  if (remember) rememberPose(cameraPose());
}

/** The rig's live pose as the value everything that moves it reads and writes. */
function cameraPose(): CameraPose {
  return { distance: rig.distance, pitch: rig.pitch, yaw: rig.yaw, follow: followCamera.enabled };
}

/**
 * The **yaw only**, for the per-frame follow ease — deliberately not `applyCameraPose`.
 *
 * Two things the full path does that this must not: it writes the distance and pitch back through
 * their clamps sixty times a second for no reason, and it calls `rememberPose`, which is a
 * `localStorage` write. What is remembered is the yaw the owner's *hand* chose; a followed yaw is
 * derived from where the player is standing and will be re-derived on the next frame anyway.
 */
function applyCameraYaw(degrees: number): void {
  rig.yaw = degrees;
  // `setCameraYaw` and not `setCameraFrame`: the fade bands are a function of the view depth and the
  // shadow box's *size* is a function of the frame's, and a yaw changes neither. Only which way the
  // box points, and which wall is in the way. See `World3D.setCameraYaw`.
  world.setCameraYaw(rig.yawRadians);
  compass.update(rig.yaw);
}

dolly.poseOf = cameraPose;
// The ring cannot cover the fully-pulled-back frame on a very wide canvas, so the *dolly* stops
// sooner rather than the frame showing void at its far corners. Recomputed on every resize below.
dolly.ceilingOf = () => rig.maxDistance;
dolly.onPose = (pose) => applyCameraPose(pose);
dolly.attach(renderer.domElement);

/**
 * M8's Shift+drag. The pose it produces goes through exactly the path the wheel's does — and it
 * **switches follow off**, because a hand on the camera outranks a rule about where the camera
 * should be. `orbit.ts`'s header for why that is one boolean rather than a suspended third state.
 */
orbit.poseOf = cameraPose;
orbit.onPose = (pose) => {
  const wasFollowing = followCamera.enabled;
  // `remember: false` — a `localStorage` write per `pointermove` is sixty a second. `onSettled` below
  // writes once, when the hand lets go, which is also the only moment the stored value is a pose the
  // owner chose rather than one they dragged through.
  applyCameraPose({ ...pose, follow: false }, false);
  if (wasFollowing) log.write('system', 'camera: free — the orbit took it; O to put it back behind you');
};
orbit.onSettled = (pose) => rememberPose(pose);
orbit.attach(renderer.domElement);
compass.attach(document);

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
  // M8. A fresh body has no heading to have turned *from*, so the next one it reports is a first
  // sight and the camera takes it whole rather than swinging in from the old session's angle —
  // `orbit.FollowCamera`'s `seeded`, which is `body.ts`'s `yawSeeded` one level up.
  followCamera.clear();
});

net.on('zone', (message) => {
  place = { zone: message.zone.id, level: message.level };
  world.setPlace(message.zone, message.level);
  // Everyone else was in the Place just left; the local body is what the camera follows.
  entities.clear(true);
  resendIntent = true;
  // Arriving somewhere else is the other first sight: a portal can land you facing anywhere, and an
  // eased swing on arrival would be a second of the camera catching up to a room you are already in.
  followCamera.clear();
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

/**
 * **The two messages the server has always sent and no client has ever read** — M7b, and the plan's
 * own note: *"the current client has no `attackResolved` or `died` handler at all, the server emits
 * them and the client discards them."*
 *
 * `attackResolved` moves both ends of the blow and puts a number in the air; `died` drops the body and
 * holds it there. Everything about *which* motion is `anim.ts`'s; everything about *where* the number
 * goes is `plates.ts`'s. What lives here is only the wiring, which is the shape every other handler in
 * this file has.
 *
 * `groundAt` is handed in rather than reached for because `entities.ts` knows nothing about `World3D`
 * — the same injection `render` already takes, and the reason a damage number lands on the ground the
 * character is standing on rather than at y = 0.
 */
net.on('attackResolved', (message) => {
  entities.attackResolved(
    message.attacker,
    message.target,
    message.hit,
    message.critical,
    message.damage,
    message.swing,
    groundAt,
  );
});
net.on('died', (message) => entities.died(message.id));

net.on('log', (message) => log.write(message.channel, message.text));
net.on('rejected', (message) => log.write('error', `Rejected: ${message.reason}`));

/* -------------------------------------------------------------------------- */
/* The frame                                                                   */
/* -------------------------------------------------------------------------- */

let last = performance.now();
let fps = 0;
/**
 * A human's standing instruction about the weather, or `undefined` for *"whatever the world says"*.
 *
 * Three writers and they must not fight: the **R** key, `__debug3d.rainEnabled` and — since the world
 * clock — the served sky. The frame composes them in one place ({@link precipWanted}) and ANDs the
 * answer with "is there a roof overhead" before touching either mesh. Letting any writer set
 * `visible` directly would mean stepping into a cave permanently turned the toggle off.
 *
 * **`undefined` rather than a boolean default**, so that "nobody has an opinion" is a state the
 * composition can see: with no served sky it falls through to M4's always-on rain, which is what a
 * client talking to a server that predates the clock should still do.
 *
 * Still a *boolean* now that there are two fields, and deliberately: the owner's question at this key
 * is *"show me the weather"* / *"get it out of the frame"*, never *"give me snow instead"* — which
 * one it is remains the world's to say, and the world says it through `fallingOf`.
 */
let rainOverride: boolean | undefined;

/**
 * A hand override for the snow's wind, or `undefined` for *"whatever the world says"*.
 *
 * **Here because the term is otherwise unviewable, not because a knob is nice to have.** The modal
 * climate every zone in this world runs (`weather.ts`'s `temperateCold`) is `SEASON_CALM` in three of
 * its four seasons and `SEASON_BREEZY` in the fourth, both of which random-walk the windspeed by ±2 a
 * change against a floor of zero — so every zone in the live save sits at **wind 0** and the snow
 * falls dead vertical. The climates that would blow (`stormyCold`, `arctic`'s chinook, `desert`) are
 * in `WORLD_WEATHER_ROWS` and assigned to no zone, because the per-zone climate table is deferred.
 *
 * So `__debug3d.snowWind = 100` is the only way to see the mapping today, and the same pattern
 * `rainOverride` uses: `null` hands it back.
 */
let windOverride: number | undefined;

/**
 * The world's own sky: the last `{t:'sky'}`, when it landed, and whether a human has taken the hour.
 *
 * Held here beside `rainOverride` and `gameHour` for the reason all three are — none of it draws, and
 * the renderer must not own a fact the server is authoritative about. See `sky.ts` for the
 * interpolation, the snow decision and the storm-light mapping.
 */
const sky = new SkyClock();

/**
 * The rain-to-snow crossfade. See `sky.PrecipFade`; it holds four numbers and no `three` object.
 *
 * Fed once a frame with what {@link precipWanted} composed and how hard {@link precipDensity} says it
 * is coming down, then advanced on the frame's own delta. Its two outputs are the two fields'
 * densities, and while both are above zero the weather costs two draw calls instead of one.
 */
const precipFade = new PrecipFade();

/**
 * **What** should be falling, from the three writers, in precedence order — the type, not a boolean.
 *
 * A hard override outranks the world, because that is what pressing **R** while standing in a
 * downpour has to mean; the world outranks the default, because that is the whole slice; and the
 * default is rain, because that is M4's world and the thing an old server must still get.
 *
 * The override is still the one boolean it always was — *show me weather* / *show me none* — and the
 * type it resolves to when it is forcing weather on is the world's own if the world has one, and
 * `sky.would` (which is `temp <= 0`) if it does not. So **R** on a frozen dry night gives snow and on
 * a warm dry night gives rain, which is what "flip whatever is currently falling" has to mean when
 * nothing currently is.
 */
function precipWanted(): Falling {
  if (rainOverride === false) return 'none';
  if (rainOverride === true) return sky.falling !== 'none' ? sky.falling : sky.would;
  if (!sky.served) return 'rain';
  return sky.falling;
}

/**
 * Whether **anything** is being asked to fall. The **R** key's own question, and `__debug3d`'s.
 *
 * Unchanged in meaning from the slice before this one: it composes the same three writers in the
 * same order. It simply no longer assumes the answer is rain.
 */
function rainWanted(): boolean {
  return precipWanted() !== 'none';
}

/**
 * How hard, 0..1 — the precipitation ladder, or M4's full storm under a hard **R** or an old server.
 *
 * Phase-blind on purpose (`sky.precipDensityOf`): the rate is one field in the source and the
 * temperature splits it, so the same number serves whichever field is being handed it.
 */
function precipDensity(): number {
  return rainOverride === true ? 1 : (sky.density ?? 1);
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

  // M8b. The keyboard's four vectors are the **camera's** frame now, so W is "away from the camera",
  // which with the camera behind you is "the way you are facing" — the owner's own sentence. The
  // rotation is the identity to the bit at yaw 0, so this line changes nothing at the boot pose; see
  // `input.cameraRelative`. Deliberately unconditional on follow mode: an orbited camera with
  // world-locked keys is the thing that feels broken, and it is reachable with follow off.
  const keys = input.intent();
  const raw = cameraRelative(keys, rig.yaw);
  // The joystick outranks both the keyboard and a stale server route, exactly as `scene.ts:4431-4438`
  // ranks them: it is a deliberate, held instruction, so it beats a route it has already told the
  // server to drop and it beats the keyboard for the one frame a key goes down before `onManual` has
  // cancelled the drag.
  //
  // **And it is not rotated**, because it was never in the camera's frame to begin with: a held
  // pointer aims from the character to a raycast ground point, both of them world positions, so the
  // heading is already the world's. Same for click-to-move's route, which the server derives from its
  // own waypoints. Camera-agnostic by construction — the rotation belongs to the keyboard alone.
  const pointerIntent = pointer.steering ? pointer.intent() : undefined;
  // A key held *across* a click is being ignored by the server for as long as the route lasts, so
  // the intent is zeroed rather than the raw keys: nothing is predicted that the character is not
  // doing, and the `steer 0,0` that goes out reads as a key release rather than as a cancellation.
  const intent = pointerIntent ?? (serverWalking ? { x: 0, y: 0 } : raw);
  // M8b's second half. Backing up and sidestepping are defined *relative to the camera*, so the camera
  // must hold still while they are held or it redefines the gesture underneath the hand — measured, and
  // measured badly: holding D spins the world through complete revolutions and holding S shakes it ±5°
  // at 30 Hz. `input.suspendsFollow` carries the whole derivation. Only when the keyboard is the thing
  // actually driving: a held pointer and a server-walked route are world-space and close no loop, so
  // they must keep the camera swinging in behind the body exactly as they always have.
  const keysHoldCamera = pointerIntent === undefined && !serverWalking && suspendsFollow(keys);
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
    // M8. Before the aim, so the frame the camera takes this tick is the eased one and not last
    // tick's — a yaw applied after `rig.follow` would put the camera one frame behind its own angle,
    // which at a half-second ease is a visible lag on every corner turned. `self.view.yaw` is M7a's
    // wire float, the same field M7b turns the *body* with; `orbit.ts` owns the fact that the camera
    // eases where the body snaps. A live Shift+drag suspends the chase without disarming the mode.
    const eased = followCamera.update(rig.yaw, self.view.yaw, seconds, orbit.orbiting || keysHoldCamera);
    if (eased !== undefined) applyCameraYaw(eased);
    rig.follow(x, y, z);
    // The moon's shadow camera and the clearing light take the *same* three numbers the camera did,
    // in the same frame. Anything else and the shadow volume trails the frame by a tick.
    world.focus(x, y, z);
    rain.update(now / 1000, x, y, z);
    snow.update(now / 1000, x, y, z);
    // **What** is falling, and **how hard**, through the crossfade. `precipWanted` composes the three
    // writers into a type and `precipDensity` into a rate; the fade turns the pair into two
    // densities, which are equal to the rate for whichever field is settled and split between them
    // for the second and a half either side of a temperature crossing zero. See `sky.PrecipFade`.
    precipFade.want(precipWanted(), precipDensity());
    precipFade.advance(seconds);
    // Weather is gated on the roof, not on the biome: §4's enclosure class says "3-4 solid wants no
    // weather", and the cheapest honest version of that at grey-box — where there is no ceiling
    // geometry to hide the sky until M6 — is to stop it when the character is under one. The roof
    // gate is M4's, unchanged and now applied to both fields, which is what keeps the wet ground and
    // the puddles behaving exactly as M5b tuned them.
    const sheltered = world.roofed;
    rain.enabled = !sheltered && precipFade.rain > 0;
    snow.enabled = !sheltered && precipFade.snow > 0;
    rain.density = precipFade.rain;
    snow.density = precipFade.snow;
    // The one field the sky documented as available-and-unread that this slice reads. A drift at a
    // breeze, very nearly horizontal at the source's hurricane — `snow.ts`'s §4 for the mapping, and
    // for why the rain deliberately does not take the same term yet.
    snow.wind = windOverride ?? sky.wind;
  } else {
    // No body yet: the login card is still up and the storm has nowhere to be centred.
    rain.enabled = false;
    snow.enabled = false;
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
  // The ground's memory of the weather. Wall-clock, like the fields' own time, and driven by whether
  // something is *actually* falling rather than by whether the player wants it — step under a roof
  // and the street outside stays wet, which is right, and the roof you are under dries.
  //
  // **Snow wets the ground on the same ramp the rain does, and that is a choice.** Melt is what
  // actually happens to snow landing on a trodden street, `wetness.ts`'s three responses (darker,
  // streaked specular, puddles) are all correct for meltwater, and the alternative — a whitening
  // term that accumulates on upward faces and would need its own uniform, its own ramp and its own
  // per-material patch — is a real slice rather than a line. **Frost whitening is named here as a
  // future nicety and deliberately not built.**
  world.setWetness(wetness.update(now / 1000, rain.enabled || snow.enabled));
  // M7b: the frame's own delta and the camera go in too — the delta drives every mixer and the
  // measured gait, and the camera billboards the nameplates and measures their distance fade.
  entities.render(seconds, groundAt, warpAt, rig.camera);

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
  applyCameraPose(cameraPose(), false);
}

window.addEventListener('resize', resize);
resize();
// The pose this tab was last left at, if it is not the default one. Applied after the first `resize`
// so the aspect-derived ceiling is already in force and a remembered 96 m on a now-narrower window
// is clamped rather than honoured.
//
// **`DEFAULT_POSE` rather than whatever the rig's constructor happens to hold**, and that is a fix
// rather than a rewording: `rememberPose` *erases* storage when a pose equals `DEFAULT_POSE`, on the
// stated invariant that "a tab that stored the default and a tab that stored nothing must behave
// identically". Since the angle lock moved `DEFAULT_POSE.pitch` to the clamp's floor, the two ends
// disagreed — dialling to exactly 36 m / 45° erased the store and the next reload came up at the
// rig's authored 64°. One expression, and the invariant is true again.
applyCameraPose(rememberedPose() ?? DEFAULT_POSE, false);
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
    applyCameraPose({ ...cameraPose(), distance: metres });
  },
  get pitch(): number {
    return Number(rig.pitch.toFixed(3));
  },
  set pitch(degrees: number) {
    applyCameraPose({ ...cameraPose(), pitch: degrees });
  },
  /** M8. Degrees, `0` north, wrapping — `rig.wrapYaw` for the sign. Writing it does not stop a follow. */
  get yaw(): number {
    return Number(rig.yaw.toFixed(3));
  },
  set yaw(degrees: number) {
    applyCameraPose({ ...cameraPose(), yaw: degrees });
  },
  /** M8. Whether the camera keeps itself behind the player. The **O** key. */
  get follow(): boolean {
    return followCamera.enabled;
  },
  set follow(on: boolean) {
    applyCameraPose({ ...cameraPose(), follow: on });
  },
  /** The compass bearing the frame is pointing along, and the point it rounds to. `compass.ts`. */
  get facing(): { bearing: number; point: string } {
    return { bearing: Number(bearingOf(rig.yaw).toFixed(1)), point: cardinalOf(rig.yaw) };
  },
  /** The clamp, so a value that refuses to take is obviously a clamp and not a broken setter. */
  get limits(): { distance: [number, number]; pitch: [number, number]; yaw: string } {
    return {
      distance: [CAMERA_DISTANCE_MIN, Math.min(rig.maxDistance, CAMERA_DISTANCE_MAX)],
      pitch: [CAMERA_PITCH_MIN, CAMERA_PITCH_MAX],
      // Not a pair, because a circle has no ends — the yaw wraps where the other two clamp.
      yaw: 'wraps, (-180, 180]',
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
      // `ahead`/`behind` since M8, and renamed rather than left alone: they are the *camera's* axes
      // and calling them north and south was true only while the yaw was nailed down.
      ahead: Number(g.ahead.toFixed(2)),
      behind: Number(g.behind.toFixed(2)),
      halfWidthFar: Number(g.halfWidthFar.toFixed(2)),
      nearDepth: Number(g.nearDepth.toFixed(2)),
      farDepth: Number(g.farDepth.toFixed(2)),
      radius: Number(groundRadius(g).toFixed(2)),
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
  /**
   * Back to the shipped pose, and forget the remembered one. Also the **C** key.
   *
   * `DEFAULT_POSE` rather than `rig.reset()`: the rig's own reset goes to the pose the world was
   * *authored* at (64°), and the shipped default has been the clamp's floor since the angle lock.
   * Going through the dolly's constant is what makes this key's other half — *forget* — actually
   * erase, because `rememberPose` erases exactly what equals `DEFAULT_POSE`.
   */
  reset(): CameraPose {
    applyCameraPose(DEFAULT_POSE);
    return cameraPose();
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
  /**
   * M7b — the bodies, and everything a human needs to answer *"why is that one a capsule"*.
   *
   * `drawn` under `held` means somebody is on the capsule path, and the three reasons are all
   * readable here: the pack has not loaded (`models` is 0), the entity is a `creature:` (no monster
   * pack exists), or the cap was reached (`refused` is climbing). See `pool.BODY_POOL_SIZE`.
   */
  get bodies(): Record<string, number | boolean> {
    const ledger = world.ledger();
    return {
      held: entities.count,
      drawn: entities.rigged,
      rigsCreated: ledger.rigsCreated,
      rigsLive: ledger.rigsLive,
      rigsFree: ledger.rigsFree,
      rigHighWater: ledger.rigHighWater,
      refused: ledger.rigsRefused,
      rigBytes: ledger.rigBytes,
      cap: BODY_POOL_SIZE,
      models: characters.loaded,
      clips: characters.clipCount,
      maskedBodies: characters.maskedGeometries,
      // Six when the hair slice's import has run and zero against a pre-slice `public/models` — the
      // one number that tells a bald-looking world apart from a stale one.
      hairstyles: characters.hairCount,
      available: characters.available,
    };
  },
  /** What the local body is currently playing, and which way it is actually turned. */
  get motion(): Record<string, unknown> | undefined {
    const self = entities.self();
    if (!self) return undefined;
    const subject = {
      ...(self.view.hands?.main ? { mainHand: self.view.hands.main } : {}),
      ...(self.view.fighting !== undefined ? { fighting: true } : {}),
      ...(self.view.casting ? { casting: true } : {}),
    };
    return {
      ...(self.rig ? self.rig.motion.motion(subject) : { gait: 'capsule' }),
      metresPerSecond: Number((self.rig?.motion.metresPerSecond ?? 0).toFixed(3)),
      wireYaw: self.view.yaw,
      drawnYaw: self.rig ? Number(self.rig.drawnYaw.toFixed(3)) : undefined,
      model: self.view.model,
      gear: (self.view.gear ?? []).map((entry) => `${entry.slot}=${entry.part}`),
      hands: self.view.hands,
    };
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
  /** M8. Whether a Shift+drag is live — the state that suspends the follow ease without disarming it. */
  get orbiting(): boolean {
    return orbit.orbiting;
  },

  /**
   * The streaming ring's shape and the metres of built ground it guarantees.
   *
   * A **disc** since M8, and one number rather than three: the camera can be pointed anywhere, so the
   * only guarantee that survives a rotation is a radius. `cells` is the rasterisation — how many of
   * the `(2·reach + 1)²` candidates actually made it in, which is the 19% the disc saves over the
   * square that would cover the same radius. See `streamer.ts`.
   */
  get window(): {
    cells: number;
    reach: number;
    levels: number;
    max: number;
    coverMetres: typeof RING_COVER;
  } {
    return {
      cells: RING_CELLS.length,
      reach: WINDOW_HALF,
      levels: WINDOW_LEVELS,
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
   * Whether **weather** is being asked for, from all three writers — rain or snow, whichever the
   * world has. The field itself also needs there to be no roof — see the frame loop.
   *
   * Writing it takes a **hard override**, exactly as pressing **R** does; `rainOverride = null` hands
   * it back to the world. The name is M4's and is kept rather than churned: it is the same one
   * boolean, and `__debug3d.sky.falling` next to it says which of the two it is turning on.
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
  /** Whether rain is actually falling right now: asked for, of that type, and no roof. */
  get raining(): boolean {
    return rain.enabled;
  },
  /** Whether **snow** is actually falling right now. `raining`'s twin, and the common one. */
  get snowing(): boolean {
    return snow.enabled;
  },
  /**
   * How much of the storm is falling, 0..1 — the world's `precip` as drops. One when the world has
   * no opinion, which is M4's full storm.
   */
  get rainDensity(): number {
    return rain.density;
  },
  /** The same for the snow, and the two are complementary while the crossfade is running. */
  get snowDensity(): number {
    return snow.density;
  },
  get rainOpacity(): number {
    return rain.opacity;
  },
  set rainOpacity(value: number) {
    rain.opacity = value;
  },
  get snowOpacity(): number {
    return snow.opacity;
  },
  set snowOpacity(value: number) {
    snow.opacity = value;
  },
  /**
   * The wind the snow is slanting to, in the wire's own units — 100 is the source's hurricane.
   *
   * **Writing it is a hard override**, and it is the only way to see the term in this world: every
   * zone runs the calm modal climate and sits at zero. `__debug3d.snowWind = 100` lays the blizzard
   * over at 75° off vertical; `snowWindOverride = null` hands it back. See `snow.ts`'s header §4 for
   * the mapping and `precip.windMetres` for the other end of it.
   */
  get snowWind(): number {
    return snow.wind;
  },
  set snowWind(value: number) {
    windOverride = Number.isFinite(value) ? Math.max(0, value) : undefined;
  },
  /** The standing instruction, or `null` for *"follow the world"*. `rainOverride`'s twin. */
  get snowWindOverride(): number | null {
    return windOverride ?? null;
  },
  set snowWindOverride(value: number | null) {
    windOverride = value ?? undefined;
  },
  /**
   * The two weather fields as instances: seeded, drawn, and the draw calls they cost this frame.
   *
   * **`draws` is the number the transition is judged on.** It is 1 under any settled weather, 0 under
   * a dry sky, and 2 only while a temperature crossing zero is being carried across — for
   * `PRECIP_CROSSFADE_SECONDS` and not a frame longer. `windMetres` is the readable end of the
   * snow's wind mapping: metres a second of lateral drift, against a 2.2 m/s fall.
   */
  get precip(): {
    falling: Falling;
    draws: number;
    crossing: boolean;
    rainDrawn: number;
    snowDrawn: number;
    windMetres: number;
  } {
    return {
      falling: precipFade.falling,
      draws: rain.enabled || snow.enabled ? precipFade.draws : 0,
      crossing: precipFade.crossing,
      rainDrawn: rain.enabled ? rain.drawn : 0,
      snowDrawn: snow.enabled ? snow.drawn : 0,
      windMetres: Number(snow.windMetres.toFixed(2)),
    };
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
  /* ------------------------------------------------------------------- M9 */

  /**
   * The furniture and the wall texture, in one object — **M9's read-out, and it answers the owner's
   * two screenshots directly.**
   *
   * `wallMaterials` is how many of the pool's `edge`/`barrier` materials are wearing a real picture
   * rather than M3's flat colour: 20 when the village pack has landed (ten sectors x present/faded),
   * 0 before it, and the number that says the grey blocks are gone. `furnished` counts the chunks in
   * the window carrying furniture and `propInstances` the pieces themselves — the same pair
   * `interiors`/`villageInstances` is, one layer up.
   */
  get furniture(): {
    furnished: number;
    propInstances: number;
    propsLoaded: number;
    wallMaterials: number;
    propTextures: { count: number; megabytes: number };
  } {
    const census = world.scatterCensus();
    return {
      furnished: census.furnished,
      propInstances: census.props,
      propsLoaded: world.props.loaded,
      wallMaterials: world.pool.wallTextured(),
      propTextures: {
        count: world.props.textures,
        megabytes: Number((world.props.textureBytes / 1024 / 1024).toFixed(2)),
      },
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
   * scrubbing from, the date and the weather. `recipe` is what the rig is actually wearing, which on
   * a wet afternoon reads `dawn->day (storm 0.58)` and indoors reads `inside`.
   *
   * The weather half reads in three parts and they answer three different questions. `falling` is
   * what the **world** says is coming down; `wanted` is what the three writers **composed** out of
   * that, which differs only under a hard **R**; and `fade` is what is on **screen**, two weights
   * that sum to one across a crossing and to one alone the rest of the time. `would` is what a dry
   * sky would produce if it produced anything — `temp <= 0` — which is what **R** shows you.
   */
  get sky(): {
    live: boolean;
    overridden: boolean;
    hour: number;
    recipe: string;
    falling: Falling;
    wanted: Falling;
    would: Falling;
    fade: { rain: number; snow: number };
    gloom: number;
    view: SkyView | undefined;
  } {
    const fade = precipFade.weights;
    return {
      live: sky.live,
      overridden: sky.overridden,
      hour: Number(gameHour.toFixed(4)),
      recipe: world.night.sky?.name ?? 'night',
      falling: sky.falling,
      wanted: precipWanted(),
      would: sky.would,
      fade: { rain: Number(fade.rain.toFixed(3)), snow: Number(fade.snow.toFixed(3)) },
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
/* The look keys — all of them behind Alt since 2026-08-13                     */
/* -------------------------------------------------------------------------- */

/**
 * **Alt+T** cycles the tone mapping, **Alt+R** toggles the weather, **Alt+B** the bloom, **Alt+F** the
 * wind, M5c's **Alt+V** the domain warp, M6's **Alt+C** puts the camera back on its authored pose —
 * and M5b's **Alt+G** flips day against night, with **Alt+[** and **Alt+]** sweeping the hour.
 *
 * ## Every one of these was a bare letter until the owner tried to open a door
 *
 * *"I only found the toggle as I went to open a door and I wasn't in the chat box."* — 2026-08-13. The
 * nine letters this block bound are nine MUD verbs, the mitigation only ever covered the case where
 * the caret was **already** in the command line, and the owner's case is the other one. `keys.ts`
 * carries the whole argument: why Alt and not Ctrl or Shift, why movement is the one bare exception,
 * and how the first character of a typed command survives the focus. What is left here is the eleven
 * bodies, reached through `KeyRouter.onView` with the code and the shift state the router read off
 * the press.
 *
 * **The brackets moved under Alt with the rest**, which the brief did not ask for. The reason is the
 * rule rather than the key: "any bare printable character starts a command" is only a promise the
 * player can trust if it has no exceptions beyond the movement keys, and `[` left bare is a printable
 * character that silently jumps the sky instead of typing — the reported bug, in the one place the
 * fix would have left it. The gesture is untouched: `Alt+]` held still sweeps, because `keys.ts`
 * refuses `repeat` for the nine letters and allows it for these two.
 *
 * ## Since the world clock: the same keys, as *overrides*
 *
 * The hour is the server's now, so **G**, **[** and **]** can no longer simply set it — the next
 * message would take it straight back, and a key that undoes itself in under a second is worse than
 * no key. So touching any of them **detaches** the hour from the live clock and pins it (`SkyClock`'s
 * `override`), and `__debug3d.sky.live` goes false so the state is readable rather than guessed at.
 *
 * **Alt+Shift+G hands it back.** Not a double-tap and not a hold: a chord is one gesture with no
 * timing window to miss, it is read off `event.shiftKey` at the moment of the press — which is
 * `CLAUDE.md` gotcha 5b's own prescription, and the trap that gotcha describes is precisely a modifier
 * tested after the edge was consumed. **Alt+Shift+R** is its twin for the rain, for the same reason
 * and by the same rule: the plain chord takes manual control, the shifted one gives it back to the
 * world. (Alt+Shift is Windows' layout-switch hotkey, which — like the menu bar on Alt — is a property
 * of pressing and releasing the pair *alone*, not of a chord with a letter in it.)
 *
 * **R stays a hard override in both modes.** Pressing it flips whatever is currently falling and
 * pins that, whether the hour is live or held; the weather and the clock are separate wheels and
 * grabbing one does not grab the other. Which is also why the `sky` handler re-applies the sky under
 * an override: the storm's own dimming is the *weather's*, and the pinned hour does not exempt the
 * frame from it.
 *
 * *"Whatever is currently falling"* is now two things rather than one — the owner's snow ruling gave
 * snow its own field — and the key's meaning is unchanged by construction: it flips a boolean about
 * **weather**, and which of the two fields that boolean turns on stays the world's answer
 * (`sky.falling`), or on a dry sky the answer `temp` gives (`sky.would`). Nothing about the gesture,
 * the chord or the precedence moved.
 *
 * M6 adds no other letter on purpose: its two controls are the wheel and Shift+wheel (`dolly.ts`),
 * because a hunt for a frame wants a dial. That accounting — *every letter bound here is a letter
 * that can go missing out of the command line* — was right about the cost and wrong about the
 * remedy, which was rationing rather than a modifier. Alt buys the whole alphabet back.
 *
 * **M8 adds exactly one, O**, and it is the one that cost the owner the door: its two real controls
 * are a drag and a drag (`orbit.ts`), and the only thing that genuinely needs a key is a *mode* — you
 * cannot toggle a boolean with a gesture that is already the boolean's opposite. The letter is still
 * O, because behind Alt the mnemonic is free.
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
 * position, not a character. Every code below is read the same way, which is also what makes the Alt
 * chord layout-proof: with Alt held on a Mac, `event.key` for Option+O is `ø` and `code` is `KeyO`.
 *
 * Both of `CLAUDE.md`'s input traps are answered in `keys.ts` now, which is the only listener that
 * decides anything: the gate is checked *and* `intoFormControl` is asked, and every decision is taken
 * on the `keydown` event with `event.repeat` refused for the toggles and allowed for the two
 * brackets. What changed is that `preventDefault` is now *called* on these chords rather than
 * carefully avoided — Chrome's own Alt+F menu mnemonic is only kept out of the wind toggle by the
 * page consuming the press, and the one route that must never be prevented (a typed character on its
 * way to the command line) is named in `keys.consumesDefault` rather than left implicit.
 */
keys.onView = (code: string, shift: boolean): void => {
  if (code === 'BracketLeft' || code === 'BracketRight') {
    // Stepped from whatever the frame is *showing* rather than from whatever was last pinned, so the
    // first press off a live clock lands an hour from now and not an hour from midnight.
    const from = sky.hourAt(performance.now()) ?? gameHour;
    applySky(sky.override(from + (code === 'BracketRight' ? 1 : -1)));
    log.write('system', `time: ${clockOf(gameHour)} (${world.night.sky?.name ?? 'night'}) — held, alt+shift+G to release`);
    return;
  }
  switch (code) {
    case 'KeyT': {
      const at = TONE_MAPPINGS.indexOf(grade.toneMapping);
      const next = TONE_MAPPINGS[(at + 1) % TONE_MAPPINGS.length] ?? TONE_MAPPINGS[0]!;
      grade.toneMapping = next;
      log.write('system', `tone mapping: ${next}`);
      return;
    }
    case 'KeyR':
      if (shift) {
        // Back to the world's weather. Says what it went back *to*, because "released" on its own
        // leaves the owner unable to tell a dry sky from a broken toggle.
        rainOverride = undefined;
        log.write(
          'system',
          sky.served
            ? `weather: the world's — ${sky.falling === 'none' ? 'dry' : sky.falling}`
            : 'weather: the world has sent no sky, so the default (rain, on) stands',
        );
        return;
      }
      // A hard override, from whatever is currently being asked for — so the key always flips what
      // the owner can see, whether that was the world's answer or their own. Type-aware since snow
      // got its own field: turning weather *on* shows the world's own phase, or on a dry sky the one
      // the temperature says this place would have.
      rainOverride = !rainWanted();
      log.write(
        'system',
        rainOverride
          ? `weather: ${precipWanted()} on (held, alt+shift+R to release)`
          : 'weather: off (held, alt+shift+R to release)',
      );
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
      // M6. The wheel is a hunt and a hunt needs a way home: **C** puts the rig back on the shipped
      // pose and forgets the remembered one, so the next reload starts there too.
      //
      // **M8 makes it the most useful key on the list**, because the yaw goes home with everything
      // else: a player who has orbited themselves somewhere confusing gets north back at the top of
      // the frame in one press, rather than hunting for it through a full circle.
      const pose = cameraKnob.reset();
      log.write('system', `camera: ${pose.distance} m at ${pose.pitch}°, facing north (default)`);
      return;
    }
    case 'KeyO': {
      // M8. *"Always having the camera behind my player."* **On by default since M8b** — the reason it
      // shipped off was that W was world-north, and `input.cameraRelative` retired it; the key is now
      // the way *out* of the mode as much as the way in. `dolly.FOLLOW_ON_FRESH` has the history.
      //
      // **Alt+O.** The bare letter is what the owner pressed reaching for `open`, and it is the press
      // that produced this whole scheme — `keys.ts` has the account. O keeps the mnemonic because
      // behind Alt it costs the command line nothing.
      applyCameraPose({ ...cameraPose(), follow: !followCamera.enabled });
      log.write(
        'system',
        followCamera.enabled
          ? 'camera: behind you — it swings round as you turn; shift+drag or alt+O takes it back'
          : `camera: free — held at ${cardinalOf(rig.yaw)}; alt+O puts it behind you again`,
      );
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
      if (shift) {
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
        `time: ${clockOf(gameHour)} — ${day ? NIGHT_SKY.name : DAY_SKY.name} (held, alt+shift+G to release)`,
      );
      return;
    }
    default:
      return;
  }
};

/**
 * The other two routes: the command line takes the keyboard, and F1 says how.
 *
 * `onLine` is raised for **Enter** and for **any bare printable character** — the second is the whole
 * fix. `LogPanel.focusInput` opens the pane if it was collapsed and puts the caret at the end, and
 * `keys.ts` has deliberately *not* prevented the keydown, so the browser's own default action drops
 * the character into the input that focus just moved to. That is why `open door` typed from the world
 * arrives as `open door` and not as `pen door`.
 *
 * Nothing has to be undone on the way in: focusing the input fires `log.onFocusChange`, which runs
 * `applyTyping`, which raises the same one boolean every listener reads — so the glide stops on the
 * same tick the caret arrives.
 */
keys.onLine = () => log.focusInput();
keys.onHelp = () => log.write('system', CONTROLS);
keys.attach();

log.write('system', CONTROLS);
log.write(
  'system',
  'M8 — the sky follows the world clock: alt+G and alt+[ ] hold it, alt+shift+G gives it back, ' +
    'alt+shift+R the weather.  Rain and snow are two fields and the world picks; alt+R forces ' +
    'whichever this place would have.  ' +
    'The compass in the corner is which way the frame points, and W walks that way — but shift+W is ' +
    'still the exit named north, whatever the compass says.  ' +
    'Read the frame you like off window.__debug3d.camera, the interior off .interior, the clock and ' +
    'the weather off .sky, the two fields off .precip.',
);

net.connect();

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}
