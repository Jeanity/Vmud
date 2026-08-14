/**
 * The loot glint — a golden mote fountain rising off a thing on the floor, on `rain.ts`'s terms.
 *
 * The owner's idea, and the reason it replaces a rigged mesh: *"you know how we got rain and snow,
 * which means we have particle animation so why couldn't we come up with a sparkly golden particle
 * flickering up from the ground for loot?"*
 *
 * Everything structural here is `rain.ts`'s and `snow.ts`'s, deliberately and line for line: one
 * {@link InstancedBufferGeometry} (a quad plus instanced attributes), one {@link ShaderMaterial},
 * **one draw call**, every buffer allocated in the constructor and **never** reallocated, the seeds
 * hashed once through `hashCell` and never touched again, `frustumCulled` off because every real
 * position exists only in the shader, `matrixAutoUpdate` off, no shadows. Read `rain.ts`'s header
 * first; this one is the four things that are **different**, and the first is the whole design.
 *
 * ## 1. A field of *emitters*, which the weather does not have
 *
 * Rain and snow are scene-wide fields that follow the camera: one centre uniform, and the vertex
 * program wraps nine thousand flakes around it for free. A glint emits from **specific world
 * positions** that appear and disappear as loot drops, is taken, and rots.
 *
 * So the instance buffer is cut into {@link MAX_GLINT_EMITTERS} contiguous runs of
 * {@link GLINT_MOTES}, and an emitter is a run. Three instanced attributes:
 *
 * | Attribute | Stride | Written | What it is |
 * |---|---|---|---|
 * | `aMote` | {@link GLINT_STRIDE} | **once, in the constructor** | this mote's bearing, radius, phase and speed |
 * | `aOrigin` | {@link GLINT_ORIGIN_STRIDE} | when the floor changes | the emitter's world position |
 * | `aLife` | {@link GLINT_LIFE_STRIDE} | when the floor changes | when this thing rots, and over how long |
 *
 * `instanceCount` is `emitters x GLINT_MOTES`, set in {@link commit} — the same one-integer-write
 * `Rain.density` uses to thin a storm, wearing a different hat. Emitters are packed from slot 0, so
 * a prefix of the buffer is always the whole live set.
 *
 * **A frame whose floor has not changed does no work at all**, and that is checked rather than
 * hoped for: {@link emit} compares the five floats it is about to write against the ones already in
 * the buffer and returns without touching either attribute when they agree. Five compares per
 * emitter — 295 for the worst floor this world can build (see {@link MAX_GLINT_EMITTERS}) — and no
 * upload, no allocation, no matrix and no mixer. The rise, the drift, the twinkle and the rot fade
 * are all functions of `uTime` and the seed.
 *
 * ## 2. Additive, because a glint is light
 *
 * The rain blends additive and the snow normal, and `snow.ts`'s §1 is the argument for why: a
 * raindrop is a moving specular highlight and a snowflake is a white solid. A glint is neither — it
 * is *light coming off something*, so it adds to what is behind it. That is also what stops it
 * reading as confetti: alpha-blended motes are little coloured squares lying in front of the grass,
 * and additive ones are sparks.
 *
 * `depthWrite` is off for `rain.ts`'s reason (motes must not occlude each other) and `depthTest` is
 * **on**, which is what lets a corpse's own bone pile hide the bottom of its plume — see §4.
 *
 * ## 3. The angular floor, and it is the one thing weather never needed
 *
 * A mote is a fixed number of view units across, so its size on screen falls as `1/distance`. The
 * weather never cared: rain and snow are *centred on the character*, so the drops that matter are
 * the near ones. Loot is not. Items are the one entity class interest management keeps strictly to
 * the observer's own room, so a glint is never more than about 12 m from the **character** — but the
 * camera's default pose is **36 m back** (`dolly.DEFAULT_POSE`) and its ceiling is 96, so the glint
 * is routinely 40 m from the **eye**, where a 0.016-unit mote is 1.5 px and shimmers into aliasing.
 *
 * So the size is floored in *angle* rather than in metres:
 *
 * ```glsl
 * float size = max(uSize, uMinAngle * depth);   // never thinner than uMinAngle radians
 * ```
 *
 * The two terms cross at `GLINT_SIZE / GLINT_MIN_ANGLE` = **14.5 m**: nearer than that a mote is a
 * fixed-size object in the world and grows as you walk up to it, further away it holds a constant
 * angular size and simply stops shrinking. At the camera's 30° field (`shared.CAMERA_FOV_DEGREES`)
 * over an 800 px viewport that floor is **3.4 px across**, which is a bright point rather than a
 * flickering sub-pixel. See {@link GLINT_MIN_ANGLE} for the arithmetic at three distances.
 *
 * This is a *resolution-independent* claim — an angle, not a pixel count — so a 4K window gets a
 * bigger mote in pixels and the same one in the frame, which is the correct behaviour and the reason
 * the uniform is not the viewport height.
 *
 * ## 4. What emits, and what the emitter's height means
 *
 * Two things emit, and both are the caller's decision rather than this file's — `entities.ts` owns
 * the list:
 *
 * - **A thing lying on the floor.** `kind: 'item'` with no `object:` model — a dropped sword, a
 *   spilled quiver, the room's own scatter pickup. Its origin is the ground, so the plume rises out
 *   of the floor itself and there is nothing there but the light.
 * - **A corpse that still holds something.** The owner asked for it separately: *"is there anyway to
 *   overlay the sparkle and the bonepile when there is loot in the corpse?"* With particles it is not
 *   an overlay problem at all. `Corpse.looted` is already on the wire — `appearance.corpseModelFor`
 *   sends `object:bonepile` for a body worth searching and `object:bonepile_looted` for one picked
 *   clean — so the client needs **no new protocol field**: the unlooted stem emits and the looted one
 *   does not. Its origin is lifted by {@link GLINT_PILE_LIFT} times the corpse's own scale, so the
 *   motes leave the *top* of the pile. Without that lift a dragon's corpse would swallow its own
 *   glint whole: `corpseScaleFor` is unbounded above and the plume is only {@link GLINT_RISE} tall.
 *
 * **The glint is uniform.** Owner's ruling, and it is a rule about the game rather than the
 * renderer: *"a MUD's tension is partly not knowing"*, so nothing about an item may be legible before
 * it is picked up — no rarity tint, no value scaling, no second colour. Considered and declined. The
 * one permitted variation is **how long it has left**, which is `aLife`, and the one *non*-variation
 * that still had to be broken up is the phase — see {@link glintMotes}.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  ShaderMaterial,
  Uniform,
} from 'three';

import { hashCell } from '@mygame/shared';

/**
 * Motes one emitter carries. **Twenty-four, and the number is a rate rather than a density.**
 *
 * A mote lives {@link GLINT_LIFE} seconds, so 24 of them phase-spread over that loop is a mote
 * leaving the floor every **71 ms** — fast enough to read as a continuous fountain and slow enough
 * that the eye can follow one of them up. Halve it and the column becomes a stutter of separate
 * sparks; double it and the extra motes land inside the ones already there, because the plume's
 * volume has not changed.
 *
 * The fragment cost is what makes being generous possible at all. A mote's quad is `2 x`
 * {@link GLINT_SIZE} square — **0.001024** view units² against a rain streak's 0.032 and a
 * snowflake's 0.0121 — so the worst floor this world can build (59 emitters, see
 * {@link MAX_GLINT_EMITTERS}) puts `59 x 24 x 0.001024 = 1.45` units of blended fill on the screen
 * against a full rainstorm's 190. **Under one percent of a storm**, for every glint in the room.
 */
export const GLINT_MOTES = 24;

/**
 * How many emitters the buffers are cut for — **128, and the arithmetic is below.**
 *
 * ## What one floor can hold
 *
 * Items are the one entity class interest management keeps **strictly to the observer's own room**:
 * `index.visibleItemsIn(ground, observer.roomId)` and `corpsesIn(graveyard, observer.roomId)`, where
 * bodies widen one open crossing out. So the question is only *how much can lie on one floor*, and
 * the server has **no cap on that at all** — no constant, no refusal, no per-room sweep.
 *
 * The retired rig's cap was 41 and it did not count corpses, because a corpse drew a bone pile out of
 * an `InstancedMesh` and never asked for a skeleton. A corpse emits now, so it is in the sum:
 *
 * ```
 *   20  the fullest floor in the built world — data/world/spawns/113.json, room 41994, twenty `O`
 *       resets of vnum 821 (`some nightshade`), every one placed at the room centre
 * + 20  one player's whole bag put down on top of it — `inventory.STARTING_CAPACITY`, and `drop`
 *       takes one item per command, so this is twenty deliberate acts
 * +  1  the room's own deterministic scatter pickup; `pickups.pickupInRoom` returns at most one
 * + 14  the corpses of the world's fullest reset room, all killed and none yet looted — the same 14
 *       `pool.BODY_POOL_SIZE` is derived from, measured over all 49 zones of data/world/spawns
 * +  4  a full group of players' own corpses beside them
 * = 59
 * ```
 *
 * ## Why 128 and not 59
 *
 * Because **the field costs the same either way.** The buffers are allocated once and never
 * reallocated — `rain.ts`'s rule, kept — so the cap buys a ceiling on 110,592 B of attribute and
 * nothing else: no per-emitter object, no skeleton, no free list, no draw call. Doubling 59 to 118
 * and rounding to the next power of two costs **55 KB**, which is a fifth of the snow's 288 KB and
 * 0.09% of the ledger this renderer already carries. Against that, two spill paths the server has no
 * refusal in front of can each put more than 59 things on one floor in a single tick: a decaying
 * container spills one ground entry per *unit* it held (a quiver of twenty arrows becomes twenty
 * entries) and a decaying player corpse spills `loose(inventory)`, reachable in the hundreds when the
 * bag is full of missiles.
 *
 * **Past the cap an item draws the capsule again**, which is what `entities.ts` did before the
 * glint and is already-correct code. The capsule and not *nothing*, deliberately: the server has
 * already decided this item is visible — it passed the lit-tile gate and the `hidden` filter — so a
 * renderer that answered by drawing nothing would hide a thing the player can walk over and `get`.
 * An orange pill at the back of a pile of a hundred and thirty is a worse-looking floor; an invisible
 * sword is a lost sword.
 */
export const MAX_GLINT_EMITTERS = 128;

/**
 * How high a mote climbs, in metres. **0.65, and it is measured against the bone pile.**
 *
 * `bonepile` is authored 0.409 m tall (`models/props/manifest.json`), so a plume that stopped at
 * half a metre would be a glow *inside* a corpse rather than over it. 0.65 clears the unlooted pile
 * by a quarter of a metre at a human's scale, and the lift in §4 handles every scale above that.
 *
 * Read as a body: a mote's top is a little above a standing character's knee, which is where a
 * dropped thing's attention belongs — high enough to see over the understory, low enough that it is
 * plainly coming *off the floor* rather than hovering.
 */
export const GLINT_RISE = 0.65;

/** Seconds a mote takes to climb {@link GLINT_RISE}, before the per-mote spread. */
export const GLINT_LIFE = 1.7;

/**
 * Per-mote multiplier on {@link GLINT_LIFE}, inverted — a *speed*, so a bigger number is a faster
 * mote and a shorter life.
 *
 * The spread is what stops the fountain reading as a conveyor: 0.7..1.35 turns one 1.7 s loop into
 * lives of 1.26 s to 2.43 s, so two motes launched in the same 71 ms slot are metres apart by the
 * top. Wider than the rain's 0.8..1.3 and narrower than the snow's 0.6..1.5, for the snow's stated
 * reason read backwards: this field is fast enough not to show its uniformity but slow enough that a
 * 20% spread would.
 */
export const GLINT_SPEED = { min: 0.7, max: 1.35 } as const;

/**
 * Metres the plume spreads to at its top. **0.22, which is a hand's width either side of the thing.**
 *
 * A dropped sword is roughly a metre long and a bone pile 0.76 m across, so a plume much wider than
 * this stops reading as *coming off that object* and starts reading as weather in a small area. The
 * radius also opens as the mote climbs (`0.25 + 0.75 t` in the vertex program), which is what makes
 * the silhouette a fountain rather than a cylinder.
 */
export const GLINT_RADIUS = 0.22;

/**
 * Radians a mote turns about the emitter over its whole climb. **1.1 — a sixth of a turn.**
 *
 * Deliberately not a whole revolution: a mote that spirals visibly is a magic effect, and this is
 * meant to read as *catching the light*. A sixth of a turn is enough that the path is a curve rather
 * than a radial line, and little enough that the eye reads it as drift.
 */
export const GLINT_CURL = 1.1;

/** Half-extent of a mote's quad in view units at one metre. The near-field size; see §3. */
export const GLINT_SIZE = 0.016;

/**
 * The angular floor on a mote's half-size, in radians — **§3's whole mechanism, as one number.**
 *
 * 0.0011 rad is 0.063°. At the camera's 30° field over an 800 px viewport that is 26.67 px a degree,
 * so the floor is **1.68 px of half-size, 3.4 px across**. Three distances, with
 * {@link GLINT_SIZE} = 0.016 and the `max` taken in view units:
 *
 * | Distance | Size taken | Angular half-size | Across, at 800 px |
 * | --- | --- | --- | --- |
 * | 3 m (the dolly's floor) | 0.016, the world size | 0.305° | 16.3 px |
 * | 12 m (the far corner of the room) | 0.016, the world size | 0.076° | 4.1 px |
 * | 36 m (`dolly.DEFAULT_POSE`) | 0.0396, the angular floor | 0.063° | 3.4 px |
 * | 96 m (`rig.CAMERA_DISTANCE_MAX`) | 0.1056, the angular floor | 0.063° | 3.4 px |
 *
 * The plume itself still shrinks — 0.65 m of rise is 23 px at 36 m and 9 px at 96 — so a distant
 * glint is a small twinkling cluster rather than a full-size effect stamped on the horizon. Only the
 * *mote* is floored, and only so that it survives being drawn.
 */
export const GLINT_MIN_ANGLE = 0.0011;

/**
 * The twinkle's base frequency, radians a second.
 *
 * Two incommensurate sinusoids multiplied, `snow.ts`'s §3 argument at a tenth of the scale: one
 * sinusoid is a metronome and the whole field blinks together. The second runs at 0.41 of the first
 * and reads a different seed, so the product's period is the least common multiple of two numbers
 * that do not divide — longer than any mote lives, which is all that has to be true.
 */
export const GLINT_FLICKER = 5.2;

/**
 * Gold, and warm. sRGB (255, 207, 92).
 *
 * Not white and not amber: white is a spark or a magic missile, amber is firelight, and a glint off
 * something worth picking up is the colour of a lit metal edge. Additive, so what actually reaches
 * the pixel is this times the alpha below — see {@link GLINT_OPACITY}.
 */
export const GLINT_COLOUR = 0xffcf5c;

/**
 * Peak additive alpha at the centre of a mote. **0.5, and the arithmetic is what makes it a light.**
 *
 * Additive blending is `src * srcAlpha + dst`, so a mote at its brightest lifts the pixel behind it
 * by `0.5 x (255, 207, 92)` = **(128, 104, 46) of 255**. Over the mid-green a grass room actually
 * draws, that is a clear warm point; where two motes overlap the sum runs to white, which is exactly
 * what a spark core should do and is free.
 */
export const GLINT_OPACITY = 0.5;

/**
 * How dim the rot fade goes at the very end. **0.30, and it is not zero on purpose.**
 *
 * The retired fade ladder's number, kept for its argument: the item is still there and can still be
 * picked up right up to the moment the server deletes it, so a glint that reached black would be a
 * lie about a thing you could still walk over and `get`. What the fade has to say is *this is going*,
 * which a third of the brightness says clearly against the full-strength glints beside it, and the
 * disappearance itself is the server's `entityLeave`.
 *
 * What changed is that the fade is now a **slope rather than eight rungs**. The ladder existed
 * because a `SkinnedMesh` has no per-instance channel and eight shared materials were the only way to
 * vary anything; a shader reading `uTime` against a per-emitter deadline has no such problem, so the
 * dim is continuous and costs one `clamp`.
 */
export const GLINT_ROT_FLOOR = 0.3;

/**
 * Metres the corpse plume is lifted, per unit of the corpse's own scale — **`bonepile`'s authored
 * height**.
 *
 * 0.409 m, read off `models/props/manifest.json` and held against it by `props.test.ts`, so a
 * re-import that changed the mesh fails a test rather than quietly burying the glint. Only the
 * unlooted pile matters here: `bonepile_looted` is 0.213 m and never emits.
 */
export const GLINT_PILE_LIFT = 0.409;

/** Floats per mote in the seed attribute: `(bearing, radius², phase, speed)`. Written once. */
export const GLINT_STRIDE = 4;

/** Floats per mote in the emitter attribute: `(x, y, z)`. Rewritten when the floor changes. */
export const GLINT_ORIGIN_STRIDE = 3;

/** Floats per mote in the clock attribute: `(goneAt, warnSpan)`, both seconds. See {@link emit}. */
export const GLINT_LIFE_STRIDE = 2;

/**
 * How far the derived rot deadline may drift before {@link emit} calls it a change, in seconds.
 *
 * The caller hands over *milliseconds remaining*, which it counts down itself between server
 * messages, and this file turns that into an absolute `goneAt` on its own clock. Those two move
 * together, so on a steady countdown `goneAt` is constant to within float noise and nothing is
 * rewritten; the only thing that ever moves it further is the server's own correction when it latches
 * the warning.
 *
 * **0.1 s, and the number is a float32 bound rather than a taste.** `goneAt` is stored in a
 * `Float32Array` at the magnitude of `performance.now() / 1000`: one hour into a session that is
 * 3,600, where a float32 ulp is 2.4e-4 s, and a full day is 86,400, where it is 7.8e-3. Both are two
 * orders inside this slack, so the tolerance is doing its job — absorbing representation — and not
 * hiding a real change. Ten minutes of decay quantised at 0.1 s is a fade that is still smooth to
 * six thousand steps.
 */
export const GLINT_CLOCK_SLACK = 0.1;

/**
 * How much of its slot a mote's phase may jitter within. **0.8, which leaves the fountain even.**
 *
 * See {@link glintMotes}: the phases are stratified one per `1 / GLINT_MOTES` of the loop and
 * jittered inside their own slot. At 0.8 the jitter spans the middle four fifths of a slot, so two
 * consecutive motes are never closer than `0.2 / GLINT_MOTES` of the loop — **14 ms** at
 * {@link GLINT_LIFE} — and the column can never bunch into a pulse.
 */
export const GLINT_JITTER = 0.8;

/** Salt for {@link hashCell}, so the glint is not a rotation of the rain's or the snow's field. */
const GLINT_SEED = 0x476c_696e;

/** `hashCell` is unsigned 32-bit; this maps it onto `[0, 1)`. `noise.ts`'s divisor. */
const HASH_RANGE = 0x1_0000_0000;

/**
 * The per-mote seed buffer, built once — `rainSeeds` and `snowSeeds`' third sibling.
 *
 * Pure and exported so `glint.test.ts` can assert the layout without a GPU: every element inside the
 * range the shader reads it against, the stride exactly {@link GLINT_STRIDE}, and two calls with the
 * same seed byte-identical. `hashCell` rather than `Math.random` for `CLAUDE.md` rule 3's reason —
 * two players standing over one dropped sword should see the same sword.
 *
 * **The phase is stratified, and that is the one place this differs from its two siblings.** Rain and
 * snow seed a whole box and any clumping is invisible among thousands; an emitter has
 * {@link GLINT_MOTES} motes and *is* the visible unit, so twenty-four independent hashes would leave
 * some emitters with a gap in their column and others with a pulse. Each mote therefore owns slot
 * `i % GLINT_MOTES` of the loop and jitters inside it by {@link GLINT_JITTER} — an even fountain per
 * emitter, with the emitters still differing from each other because bearing, radius, jitter and
 * speed all read `hashCell(i)` on the **global** instance index.
 */
export function glintMotes(count: number, motes = GLINT_MOTES, seed = GLINT_SEED): Float32Array {
  const out = new Float32Array(count * GLINT_STRIDE);
  const span = GLINT_SPEED.max - GLINT_SPEED.min;
  for (let i = 0; i < count; i++) {
    const at = i * GLINT_STRIDE;
    // Bearing about the emitter, as a fraction of a turn. The shader multiplies by TAU.
    out[at] = hashCell(i, 0, 0, seed) / HASH_RANGE;
    // The *square* of the radius fraction, so the shader's `sqrt` spreads the motes evenly over the
    // disc instead of crowding them at the middle — the standard uniform-disc sample, one op.
    out[at + 1] = hashCell(i, 1, 0, seed) / HASH_RANGE;
    // The stratified phase. `i % motes` is this mote's slot within its own emitter, because the runs
    // are contiguous and `motes` divides the buffer exactly.
    const slot = i % motes;
    const jitter = (hashCell(i, 2, 0, seed) / HASH_RANGE - 0.5) * GLINT_JITTER;
    out[at + 2] = (slot + 0.5 + jitter) / motes;
    out[at + 3] = GLINT_SPEED.min + (hashCell(i, 3, 0, seed) / HASH_RANGE) * span;
  }
  return out;
}

/** One screen-aligned quad. `position.xy` doubles as the mote's coordinate in the fragment shader. */
const QUAD_CORNERS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 2, 3, 0]);

const VERTEX = /* glsl */ `
uniform float uTime;
uniform float uRise;
uniform float uLife;
uniform float uRadius;
uniform float uCurl;
uniform float uSize;
uniform float uMinAngle;
uniform float uFlicker;
uniform float uFloor;

attribute vec4 aMote;
attribute vec3 aOrigin;
attribute vec2 aLife;

varying vec2 vQuad;
varying float vBright;

const float TAU = 6.283185307179586;

void main() {
  // This mote's own climb, and where it is in it. fract is the wrap: a mote that reaches the top
  // reappears at the floor, which is why nothing is ever spawned or killed.
  float life = uLife / aMote.w;
  float t = fract(aMote.z + uTime / life);

  // The path: a sixth of a turn about the emitter, on a disc that opens as the mote climbs. sqrt
  // on the seeded radius is the uniform-disc sample — without it the column is dense at the axis.
  float angle = aMote.x * TAU + t * uCurl;
  float radius = uRadius * sqrt(aMote.y) * (0.25 + 0.75 * t);
  vec3 world = aOrigin + vec3(cos(angle) * radius, t * uRise, sin(angle) * radius);

  vec4 view = viewMatrix * vec4(world, 1.0);

  // Screen-aligned and square, snow.ts's billboard: a mote has no long axis, so unlike the rain's
  // streak there is nothing here that has to agree with the direction of travel.
  //
  // The one term the weather does not have — see the header's §3. Below the crossover the mote is a
  // fixed size in the world; above it the angular floor takes over and it stops shrinking.
  float depth = max(-view.z, 0.001);
  float size = max(uSize, uMinAngle * depth);
  view.xy += position.xy * size;
  gl_Position = projectionMatrix * view;

  vQuad = position.xy;

  // In at the floor, out well before the top, so neither end of the plume has a hard edge.
  float ramp = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.55, 1.0, t));

  // The twinkle: two incommensurate sinusoids multiplied, each reading a different seed, so no two
  // motes brighten together and no mote repeats itself inside its own life.
  float twinkle = 0.55 + 0.45
    * sin(uTime * uFlicker * aMote.w + aMote.z * TAU)
    * sin(uTime * uFlicker * 0.41 + aMote.x * TAU);

  // The rot fade, as a slope. aLife.y <= 0 is "this thing does not rot" — every corpse, and every
  // scatter pickup — and holds the glint at full strength until the server takes the entity away.
  float rot = aLife.y <= 0.0 ? 1.0 : clamp((aLife.x - uTime) / aLife.y, 0.0, 1.0);

  vBright = ramp * twinkle * mix(uFloor, 1.0, rot);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuad;
varying float vBright;

void main() {
  // The mote, drawn rather than sampled — one length and one smoothstep on a varying that already
  // exists, so there is no asset, no fetch and no atlas on a path that must survive a cold cache.
  // Squaring gives a hot core with a soft skirt, which under additive blending is what turns a disc
  // into a point of light.
  float d = length(vQuad);
  float core = 1.0 - smoothstep(0.0, 1.0, d);
  core *= core;
  // Additive is src*srcAlpha + dst, so everything variable belongs in alpha and the colour stays pure
  // — rain.ts's note, and the reason the twinkle and the rot fade are both folded into vBright.
  gl_FragColor = vec4(uColour, core * vBright * uOpacity);
}
`;

/**
 * The floor's glints: one mesh, one material, one draw, however many things are lying on it.
 *
 * Held rather than rebuilt, exactly as {@link Rain} and {@link Snow} are — the geometry and its three
 * instanced buffers are allocated in the constructor and never again. Fields are declared and
 * assigned in the constructor body rather than written as parameter properties (`CLAUDE.md` gotcha 8:
 * this module is reachable from a headless test).
 *
 * The frame's shape is three calls:
 *
 * ```ts
 * glint.update(now / 1000);          // the clock, and the emitter cursor back to zero
 * for (const thing of floor) glint.emit(x, y, z, remainingMs, warnAtMs);
 * glint.commit();                    // instanceCount, and an upload only if something moved
 * ```
 */
export class GlintField {
  readonly mesh: Mesh;
  /** Public so a headless test can read the uniforms the frame writes; nothing else touches it. */
  readonly material: ShaderMaterial;
  private readonly field: InstancedBufferGeometry;
  private readonly origin: InstancedBufferAttribute;
  private readonly clock: InstancedBufferAttribute;
  /** Emitter slots the buffers are cut for — the ceiling {@link emit} refuses past. */
  private readonly slots: number;
  private readonly motes: number;
  /** Emitters offered since the last {@link update}. */
  private filled = 0;
  /** Emitters the last {@link commit} drew. */
  private live = 0;
  /** Set by {@link emit} when a write actually changed a buffer; cleared by {@link commit}. */
  private moved = false;
  /** How many times {@link commit} has flagged the buffers for upload. See {@link uploads}. */
  private sent = 0;
  private seconds = 0;

  constructor(slots = MAX_GLINT_EMITTERS, motes = GLINT_MOTES) {
    this.slots = slots;
    this.motes = motes;
    const count = slots * motes;

    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(QUAD_CORNERS, 3));
    geometry.setIndex(new BufferAttribute(QUAD_INDEX, 1));
    geometry.setAttribute('aMote', new InstancedBufferAttribute(glintMotes(count, motes), GLINT_STRIDE));
    this.origin = new InstancedBufferAttribute(new Float32Array(count * GLINT_ORIGIN_STRIDE), GLINT_ORIGIN_STRIDE);
    this.clock = new InstancedBufferAttribute(new Float32Array(count * GLINT_LIFE_STRIDE), GLINT_LIFE_STRIDE);
    geometry.setAttribute('aOrigin', this.origin);
    geometry.setAttribute('aLife', this.clock);
    // Nothing on the floor yet. Every emitter is drawn as a prefix, so zero is the empty room and
    // there is no "hide the unused ones" branch anywhere.
    geometry.instanceCount = 0;
    this.field = geometry;

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: new Uniform(0),
        uRise: new Uniform(GLINT_RISE),
        uLife: new Uniform(GLINT_LIFE),
        uRadius: new Uniform(GLINT_RADIUS),
        uCurl: new Uniform(GLINT_CURL),
        uSize: new Uniform(GLINT_SIZE),
        uMinAngle: new Uniform(GLINT_MIN_ANGLE),
        uFlicker: new Uniform(GLINT_FLICKER),
        uFloor: new Uniform(GLINT_ROT_FLOOR),
        uColour: new Uniform(new Color(GLINT_COLOUR)),
        uOpacity: new Uniform(GLINT_OPACITY),
      },
      transparent: true,
      // A glint is light. See the header's §2.
      blending: AdditiveBlending,
      // Motes must not occlude each other, but a wall — or a corpse's own bone pile — must occlude
      // them. `rain.ts`'s pair, unchanged.
      depthWrite: false,
      depthTest: true,
      // Both faces, because the quad is built in view space and its winding is whatever the corner
      // order gives after the projection.
      side: DoubleSide,
      fog: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    // Every real position is computed in the shader; the geometry's own bounds are a 2 m quad at the
    // origin, so culling against them would delete every glint in the world the moment the camera
    // looked away from it.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // One past the snow's 11, which is one past the rain's 10. The glint is the innermost of the
    // three: weather is between the eye and the world, and a glint is *in* the world.
    this.mesh.renderOrder = 12;
    this.mesh.matrixAutoUpdate = false;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  set enabled(on: boolean) {
    this.mesh.visible = on;
  }

  /** Emitter slots the buffers were cut for. {@link MAX_GLINT_EMITTERS} unless a test says otherwise. */
  get capacity(): number {
    return this.slots;
  }

  /** Motes an emitter carries. {@link GLINT_MOTES} unless a test says otherwise. */
  get motesPerEmitter(): number {
    return this.motes;
  }

  /** Emitters the last {@link commit} accepted — things on the floor that are actually glinting. */
  get emitters(): number {
    return this.live;
  }

  /** Instances drawn this frame: {@link emitters} x {@link motesPerEmitter}. One draw call. */
  get drawn(): number {
    return this.field.instanceCount;
  }

  /** The clock the shader is reading, in seconds. `__debug3d`, and the tests. */
  get time(): number {
    return this.seconds;
  }

  /**
   * Frames on which this field actually handed the GPU new data — **the number the whole performance
   * claim is made of, and the only way to see it from outside.**
   *
   * It should climb when loot is dropped, taken, or corrected by the server, and be flat across every
   * frame in between. A field that had lost its comparison in {@link emit} would look identical on
   * screen and drive this at the frame rate, which is exactly the bug that is invisible without a
   * counter. Read by `glint.test.ts` and available to `__debug3d`.
   *
   * Counted here rather than read off `BufferAttribute.version`, because `getAttribute` answers a
   * union with `InterleavedBufferAttribute` — which has no `version` of its own — and because
   * `needsUpdate` is **write-only** in three: its setter bumps the version and there is no getter.
   */
  get uploads(): number {
    return this.sent;
  }

  /**
   * What the field costs, in bytes — **allocated in the constructor, and this number never moves.**
   *
   * The three instanced attributes plus the shared quad and its index, on the accounting `rain.ts`
   * and `snow.ts` use for theirs (96 KB and 288 KB). At the shipped
   * `MAX_GLINT_EMITTERS x GLINT_MOTES` that is `3,072 x (4 + 3 + 2) x 4` = 110,592 B of instance data
   * and 60 B of quad: **110,652 B**.
   *
   * Deliberately *not* on `pool.LedgerSnapshot`: this geometry is built here and never registered,
   * exactly as the two weather fields' are, so `traversal.test.ts`'s ledger neither sees it nor should.
   */
  get bytes(): number {
    const perInstance = (GLINT_STRIDE + GLINT_ORIGIN_STRIDE + GLINT_LIFE_STRIDE) * Float32Array.BYTES_PER_ELEMENT;
    return (
      this.slots * this.motes * perInstance +
      QUAD_CORNERS.byteLength +
      QUAD_INDEX.byteLength
    );
  }

  /**
   * What one emitter slot's world position currently is — `[x, y, z]`, freshly allocated.
   *
   * For headless tests and `__debug3d`, on the same terms `Rain.material` is public: the buffer is
   * the *only* record of where a glint is, so a test that could not read it could only assert that
   * some number of emitters existed. It reads the run's first mote, which {@link emit} keeps in step
   * with the other twenty-three by construction.
   */
  originAt(slot: number): [number, number, number] {
    const at = slot * this.motes * GLINT_ORIGIN_STRIDE;
    const a = this.origin.array as Float32Array;
    return [a[at] ?? 0, a[at + 1] ?? 0, a[at + 2] ?? 0];
  }

  /** The same for the clock: `[goneAt, warnSpan]` in seconds, `[0, 0]` for a thing that never rots. */
  lifeAt(slot: number): [number, number] {
    const at = slot * this.motes * GLINT_LIFE_STRIDE;
    const a = this.clock.array as Float32Array;
    return [a[at] ?? 0, a[at + 1] ?? 0];
  }

  get opacity(): number {
    return this.material.uniforms['uOpacity']?.value as number;
  }

  set opacity(value: number) {
    const uniform = this.material.uniforms['uOpacity'];
    if (uniform) uniform.value = Math.max(0, value);
  }

  /**
   * Open a frame: write the clock and put the emitter cursor back to zero.
   *
   * `seconds` is wall-clock since boot rather than a frame delta, for `Rain.update`'s reason — an
   * accumulator drifts with the frame rate, and a tab that slept would resume every plume mid-air.
   * It is also the clock {@link emit} measures a rot deadline against, so the two cannot disagree.
   */
  update(seconds: number): void {
    this.seconds = seconds;
    const time = this.material.uniforms['uTime'];
    if (time) time.value = seconds;
    this.filled = 0;
  }

  /**
   * Place one emitter, in world metres. Answers **false** when the field is full.
   *
   * The caller draws its fallback on a false — see {@link MAX_GLINT_EMITTERS} for why that fallback
   * is a capsule rather than nothing.
   *
   * `remainingMs` and `warnAtMs` are `protocol.EntityView`'s pair and travel together or not at all;
   * either being absent means *this thing does not rot* and holds the glint at full strength. They are
   * turned into an absolute deadline on this field's own clock here rather than by the caller, so
   * there is exactly one place that knows what `uTime` means.
   *
   * **This is the method that makes a still floor free.** The five floats it is about to write are
   * compared against the ones already in the buffers first, and on a match it returns having touched
   * nothing — no write, no `needsUpdate`, no upload. See {@link GLINT_CLOCK_SLACK} for why the
   * deadline gets a tolerance and the position does not.
   */
  emit(x: number, y: number, z: number, remainingMs?: number, warnAtMs?: number): boolean {
    const slot = this.filled;
    if (slot >= this.slots) return false;
    this.filled = slot + 1;

    const rots = remainingMs !== undefined && warnAtMs !== undefined && warnAtMs > 0;
    // `goneAt` is only meaningful beside a positive `warnSpan`; the shader reads the span first.
    const goneAt = rots ? this.seconds + Math.max(remainingMs, 0) / 1000 : 0;
    const warnSpan = rots ? warnAtMs / 1000 : 0;

    const base = slot * this.motes;
    const origins = this.origin.array as Float32Array;
    const clocks = this.clock.array as Float32Array;
    const o = base * GLINT_ORIGIN_STRIDE;
    const c = base * GLINT_LIFE_STRIDE;
    if (
      origins[o] === x &&
      origins[o + 1] === y &&
      origins[o + 2] === z &&
      clocks[c + 1] === warnSpan &&
      Math.abs((clocks[c] ?? 0) - goneAt) <= GLINT_CLOCK_SLACK
    ) {
      return true;
    }

    // Replicated across the run rather than read off `gl_InstanceID`: that name is GLSL ES 3.00 only,
    // and a `ShaderMaterial` compiles GLSL1 unless it is told otherwise. The write is rare — this
    // branch is reached on the frame a thing is dropped, taken, or corrected by the server — so
    // twenty-four copies of five floats is the cheaper half of the trade by a wide margin.
    for (let m = 0; m < this.motes; m++) {
      const at = (base + m) * GLINT_ORIGIN_STRIDE;
      origins[at] = x;
      origins[at + 1] = y;
      origins[at + 2] = z;
      const life = (base + m) * GLINT_LIFE_STRIDE;
      clocks[life] = goneAt;
      clocks[life + 1] = warnSpan;
    }
    this.moved = true;
    return true;
  }

  /**
   * Close the frame: draw the emitters that were offered, and upload only if one of them moved.
   *
   * `instanceCount` is read at draw time, so the common case — a floor that did not change — is one
   * integer comparison and nothing else. The buffers are never reallocated and never resized; the
   * emitters past {@link emitters} keep whatever they last held and are simply not drawn.
   */
  commit(): void {
    this.live = this.filled;
    const wanted = this.filled * this.motes;
    if (this.field.instanceCount !== wanted) this.field.instanceCount = wanted;
    if (!this.moved) return;
    this.moved = false;
    this.sent += 1;
    this.origin.needsUpdate = true;
    this.clock.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
