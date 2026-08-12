/**
 * Snow — the sky most of this world lives under, drawn on `rain.ts`'s terms.
 *
 * The owner's ruling was two words, *"draw real snow"*, and the reason it is not a nicety is
 * arithmetic: the modal climate every zone runs (`weather.ts`'s `temperateCold`) precipitates
 * **3,781 game hours of snow a year against 434 of rain**. Snow is not the edge case. It is the
 * weather, and until now it was borrowing the rain's six thousand additive streaks.
 *
 * Everything structural here is `rain.ts`'s, deliberately and line for line: one
 * `InstancedBufferGeometry`, one `ShaderMaterial`, **one draw call**, the seeds hashed once through
 * `hashCell` and never touched again, the field wrapped about a moving centre by `mod` in the vertex
 * program so the CPU cost of a blizzard is two uniform writes a frame, and `frustumCulled` off
 * because the real positions exist only in the shader. Read that file's header first; this one is
 * only the four things that are **different**, and each difference is a claim about what snow is.
 *
 * ## 1. A disc, not a streak — and alpha, not additive
 *
 * A raindrop is a moving specular highlight: a column of water lensing the sky, which is *light*, so
 * additive blending is the honest model and `RAIN_COLOUR` is a pale cool glint. A snowflake is a
 * white **solid**. It does not add light to what is behind it, it hides it.
 *
 * That distinction is not pedantry, it is the one real risk in this slice, and it is arithmetic
 * rather than taste. `DAY_SKY`'s background is its fog, `0xb9d4e4` — sRGB (185, 212, 228), already
 * three quarters of the way up the display. A flake drawn the rain's way (additive, its colour at
 * `RAIN_OPACITY`) lifts that by roughly **14, 15 and 19 of 255**, and the tone curve takes some of
 * even that back: a smear, not a snowflake, in the half of every day the sun is up. The same flake
 * at {@link NormalBlending} and {@link SNOW_OPACITY} lands at (218, 232, 245) — it moves the pixel
 * *toward a colour of its own* instead of merely brightening it, which is what gives it an edge. And
 * the night, where an additive field would have been easy, loses nothing: white over M4's dark fog
 * is still white.
 *
 * So snow blends as matter. It is the one place this file departs from its sibling, and the
 * departure is the reason snow needed a file at all rather than a second `Rain` with new constants.
 *
 * `depthWrite` stays off for exactly `rain.ts`'s reason (nine thousand quads occluding each other is
 * a grey sheet) and `depthTest` stays on (a wall in front of a flake hides it). Unsorted alpha over
 * a field of one colour is order-independent to the eye: every draw order converges on the same
 * near-white, because there is only one colour in the stack.
 *
 * The disc itself is **drawn by the fragment shader**, not sampled from a texture — one `length` and
 * one `smoothstep` on a varying that already exists. No asset, no fetch, no atlas, no `TextureLoader`
 * on a code path that must survive a cold cache, and the falloff is resolution-independent: a flake
 * a metre from the camera is a soft disc rather than sixteen visible texels.
 *
 * ## 2. Terminal velocity, and why that is most of the look
 *
 * {@link SNOW_FALL} is **2.2 m/s** against the rain's 30 — a thirteenth. It is the single change that
 * does the most work: at 30 m/s a particle is a streak whatever shape you give it, and at 2.2 it
 * hangs long enough to be an object. A flake crosses {@link SNOW_BOX}'s 34 m in **15.5 seconds** at
 * base speed and 25.8 at the slowest, where a drop crosses it in 1.1.
 *
 * The per-flake spread is wider than the rain's too — 0.6..1.5 of base against 0.8..1.3 — because a
 * slow field shows its uniformity. At rain speeds a 20% spread is enough to break the sheet; at snow
 * speeds the eye has fifteen seconds to notice that everything is falling at one rate.
 *
 * ## 3. The tumble: two incommensurate sinusoids per flake
 *
 * A flake that falls straight is sleet. The wander is two sine pairs at frequencies
 * {@link SNOW_OMEGA} and a ratio in {@link SNOW_OMEGA_RATIO} of it — both seeded per instance — with
 * x and z reading them through different phases and different small multipliers, so the path in plan
 * is a Lissajous figure that does not close.
 *
 * **Why two frequencies rather than one.** One sinusoid is a metronome: every flake swings side to
 * side on its own fixed period and the field visibly ticks. Two, at a ratio that is not a small
 * whole number, give a path whose period is the *least common multiple* of the two — and the ratio
 * band deliberately excludes 1 and 2, so even at the lowest-order rational it can hold (3/2) the
 * figure needs three cycles of the slow one.
 *
 * **A flake's path must close later than the flake wraps, and that is checked rather than hoped
 * for.** The binding pair is the fastest slow sinusoid against the slowest flake: 3 cycles at
 * 0.65 rad/s is 29.0 s of path, and a flake at 0.6 of {@link SNOW_FALL} crosses the 34 m box in
 * 25.8 s. `snow.test.ts` walks all nine thousand and asserts the inequality, which is what pins
 * {@link SNOW_OMEGA}'s ceiling to a number rather than to taste. (At base speed the flake lives
 * 15.5 s and the slowest tumble runs 62.8 s, so the typical margin is four-fold.)
 *
 * The amplitude is `uFlutter / speed`: a slow flake is a light flake and a light flake wanders
 * further. One divide, and it ties the two per-instance qualities together instead of seeding a
 * third.
 *
 * ## 4. Wind — and why the rain does not get this term today
 *
 * {@link SkyView.wind} was one of the two fields `sky.ts` documented as *"available and deliberately
 * unread"*. It is read here, as a **lateral velocity in metres a second**, mapped linearly:
 *
 * ```
 * drift = SNOW_WIND_MAX * min(1, wind / SNOW_WIND_FULL)      // 8 m/s at the hurricane's 100
 * ```
 *
 * Read as an angle off vertical, which is what the eye actually judges: at the fixture's **wind 12**
 * that is 0.96 m/s against 2.2 m/s of fall — **24° off vertical, a drift**; at a stiff **40**, 3.2 m/s
 * — **56°**; at the source's hurricane **100**, 8 m/s — **75°, very nearly horizontal**. A hurricane
 * slants hard and a breeze does not, which is the whole of the brief for this term. The wind goes
 * *inside* the `mod`, so a flake blown out of the box wraps to the upwind side for free and the field
 * never empties downwind — the same trick the vertical fall already uses.
 *
 * **The direction is a client-side constant** ({@link SNOW_WIND_DIR}) and says so, because the wire
 * does not carry one: `SkyView` has `wind` but no bearing, though `weather.ts`'s `Conditions.windDir`
 * (0–3, N/E/S/W) exists on the server and is thrown away when the view is built. One field on the
 * wire would make the drift the world's rather than the client's; it is named here as the cheapest
 * real improvement and not invented.
 *
 * **The rain deliberately keeps falling straight down.** Not an oversight and not laziness: a rain
 * streak is *elongated in view space* along screen-Y (`rain.ts`'s `view.xy += position.xy * vec2(...)`),
 * so giving it a lateral velocity would slide vertical streaks sideways — drops moving one way and
 * pointing another, which reads as a bug rather than as wind. Slanting the rain means slanting the
 * billboard's long axis as well, which is a change to the silhouette M4 signed off. A flake is a
 * disc and has no long axis, so it takes the term for free. Rain's slant is a real slice; this is
 * not it.
 */

import {
  BufferAttribute,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Uniform,
  Vector2,
  Vector3,
} from 'three';

import { hashCell } from '@mygame/shared';

/**
 * Flakes seeded. One and a half times the rain's six thousand, and it costs *less* than the rain.
 *
 * A rain streak's quad is `2*0.018` by `2*0.42*speed` view units — about **0.032** square, at the
 * mean speed. A flake's is `2*0.055` square — **0.0121**, or 38% of it. So nine thousand flakes put
 * `9000 * 0.0121 = 109` units of blended fill on the screen against the storm's `6000 * 0.032 = 190`:
 * **57% of a full rainstorm's fragment cost for half again as many particles.** Which is the
 * justification for going up rather than staying level — a blizzard *is* more particles than a
 * drizzle, points read sparser than lines at equal count, and the budget was already paid.
 *
 * The buffers are {@link SNOW_STRIDE} + {@link SNOW_DRIFT_STRIDE} floats each: 288 KB, uploaded once
 * at construction and never again (`rain.ts` is 96 KB on the same accounting). For scale that is
 * one percent of a single Quaternius kit texture.
 */
export const SNOW_FLAKES = 9000;

/**
 * The volume the snow lives in, in metres — **identical to `RAIN_BOX`, and `snow.test.ts` asserts
 * it.**
 *
 * Not a coincidence to be tidied away later: during the {@link PrecipFade} both fields are drawn at
 * once, and two storms occupying two different volumes would cross-fade as one storm receding while
 * another approached. One volume makes the transition a change of *form*.
 */
export const SNOW_BOX = { width: 64, height: 34, depth: 64 } as const;

/** Metres a second before per-flake variance. A thirteenth of the rain's 30 — see the header. */
export const SNOW_FALL = 2.2;

/** Per-flake multiplier on {@link SNOW_FALL}. Wider than the rain's, because a slow field shows. */
export const SNOW_SPEED = { min: 0.6, max: 1.5 } as const;

/** Where the box sits relative to the focus. `RAIN_BASE`'s number, for the same reason. */
export const SNOW_BASE = -6;

/** Half-extent of a flake's quad in view units at one metre, before the per-flake size spread. */
export const SNOW_SIZE = 0.055;

/**
 * How much bigger the fastest flake is drawn than the slowest.
 *
 * Keyed on the same per-flake speed rather than on a fresh hash, because it is the same fact: a
 * flake that falls faster is a heavier flake, and a heavier flake is a bigger one. The 2.25x spread
 * is most of what gives the field depth at a fixed camera.
 */
export const SNOW_SIZE_SPREAD = { min: 0.6, max: 1.35 } as const;

/** Barely off white, and cool. Snow is lit by the sky, whatever the sky happens to be. */
export const SNOW_COLOUR = 0xeef4ff;

/** Peak alpha at the centre of a flake. Alpha, not additive — see the header's §1. */
export const SNOW_OPACITY = 0.62;

/** Metres of lateral wander for a flake of unit speed. Divided by speed, so light flakes wander. */
export const SNOW_FLUTTER = 0.85;

/**
 * The tumble's slow frequency band, radians a second, and the ratio the fast one takes to it.
 *
 * **The upper end of the band is not a taste decision, it is the constraint.** `snow.test.ts` walks
 * every flake and asserts that its path closes later than it wraps out of the box; the binding pair
 * is the *fastest* slow sinusoid against the *slowest* flake, which at 0.65 rad/s and 0.6 of
 * {@link SNOW_FALL} is 29.0 s of path against 25.8 s of life. Raise this and the field starts
 * repeating itself on screen.
 */
export const SNOW_OMEGA = { min: 0.3, max: 0.65 } as const;
export const SNOW_OMEGA_RATIO = { min: 1.37, max: 1.97 } as const;

/**
 * The wind mapping: metres a second of lateral drift at {@link SNOW_WIND_FULL}, linearly.
 *
 * 100 is the source's hurricane (`weather.ts`'s deviation 4: `SEASON_HURRICANE` *assigns* 100 rather
 * than drifting toward it), and `wind` is unbounded above, so the ramp is clamped rather than
 * extrapolated. See the header for the three angles this produces.
 */
export const SNOW_WIND_MAX = 8;
export const SNOW_WIND_FULL = 100;

/**
 * Which way the wind blows, as a unit vector in world XZ. **A client-side constant, because the wire
 * carries a speed and no bearing** — see the header's §4.
 *
 * East-south-east, chosen to disagree with `wetness.WET_STREAK_DIR` rather than to match it: the
 * ground's drainage runs downhill and the wind does not, and two effects sharing one direction would
 * read as one effect.
 */
export const SNOW_WIND_DIR: readonly [number, number] = [0.82, 0.57];

/** Floats per flake in the position attribute: `(seedX, seedZ, seedY, speed)`. `rain.ts`'s layout. */
export const SNOW_STRIDE = 4;

/** Floats per flake in the tumble attribute: `(omegaSlow, omegaFast, phaseA, phaseB)`. */
export const SNOW_DRIFT_STRIDE = 4;

/** Salt for {@link hashCell}. Distinct from the rain's, so the two fields are not one field twice. */
const SNOW_SEED = 0x536e_6f77;

/** `hashCell` is unsigned 32-bit; this maps it onto `[0, 1)`. `noise.ts`'s divisor. */
const HASH_RANGE = 0x1_0000_0000;

const TAU = Math.PI * 2;

/**
 * The per-flake position buffer, built once — `rainSeeds`'s exact shape, so one test reads both.
 *
 * Pure and exported so `snow.test.ts` can assert the layout without a GPU: every element inside the
 * box the shader wraps against, the stride exactly {@link SNOW_STRIDE}, and two calls with the same
 * seed byte-identical. `hashCell` rather than `Math.random` for `CLAUDE.md` rule 3's reason — two
 * players in one blizzard should at least agree about its shape.
 */
export function snowSeeds(count: number, seed = SNOW_SEED): Float32Array {
  const out = new Float32Array(count * SNOW_STRIDE);
  const span = SNOW_SPEED.max - SNOW_SPEED.min;
  for (let i = 0; i < count; i++) {
    const at = i * SNOW_STRIDE;
    out[at] = (hashCell(i, 0, 0, seed) / HASH_RANGE) * SNOW_BOX.width;
    out[at + 1] = (hashCell(i, 1, 0, seed) / HASH_RANGE) * SNOW_BOX.depth;
    out[at + 2] = (hashCell(i, 2, 0, seed) / HASH_RANGE) * SNOW_BOX.height;
    out[at + 3] = SNOW_SPEED.min + (hashCell(i, 3, 0, seed) / HASH_RANGE) * span;
  }
  return out;
}

/**
 * The per-flake tumble buffer, built once.
 *
 * The fast frequency is seeded as a **multiple** of the slow one rather than independently, which is
 * what makes the "no flake repeats itself on screen" claim checkable rather than probabilistic: the
 * ratio is confined to {@link SNOW_OMEGA_RATIO}, a band that excludes both 1 and 2, so the combined
 * path needs at least three cycles of the slow sinusoid — 29.0 s at the fastest end of
 * {@link SNOW_OMEGA}, against the 25.8 s the slowest flake spends in the box.
 */
export function snowDrift(count: number, seed = SNOW_SEED): Float32Array {
  const out = new Float32Array(count * SNOW_DRIFT_STRIDE);
  const omegaSpan = SNOW_OMEGA.max - SNOW_OMEGA.min;
  const ratioSpan = SNOW_OMEGA_RATIO.max - SNOW_OMEGA_RATIO.min;
  for (let i = 0; i < count; i++) {
    const at = i * SNOW_DRIFT_STRIDE;
    const slow = SNOW_OMEGA.min + (hashCell(i, 4, 0, seed) / HASH_RANGE) * omegaSpan;
    const ratio = SNOW_OMEGA_RATIO.min + (hashCell(i, 5, 0, seed) / HASH_RANGE) * ratioSpan;
    out[at] = slow;
    out[at + 1] = slow * ratio;
    out[at + 2] = (hashCell(i, 6, 0, seed) / HASH_RANGE) * TAU;
    out[at + 3] = (hashCell(i, 7, 0, seed) / HASH_RANGE) * TAU;
  }
  return out;
}

/** One screen-aligned quad. `position.xy` doubles as the disc's coordinate in the fragment shader. */
const QUAD_CORNERS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 2, 3, 0]);

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uCentre;
uniform vec3 uBox;
uniform float uFall;
uniform float uSize;
uniform vec2 uSizeSpread;
uniform vec2 uSpeedRange;
uniform float uBase;
uniform float uFlutter;
uniform vec2 uWind;

attribute vec4 aSeed;
attribute vec4 aDrift;

varying vec2 vQuad;
varying float vFade;

void main() {
  float speed = aSeed.w;

  // The tumble. Two sinusoids per axis at two frequencies whose ratio is never 1 or 2, read through
  // swapped phases so x and z are never in step — a Lissajous path that outlives the flake.
  float amp = uFlutter / speed;
  float slowA = uTime * aDrift.x + aDrift.z;
  float fastA = uTime * aDrift.y + aDrift.w;
  vec2 flutter = vec2(
    sin(slowA) + 0.5 * sin(fastA),
    cos(slowA * 0.83 + aDrift.w) + 0.5 * cos(fastA * 1.19 + aDrift.z)
  ) * amp;

  // Wind and flutter go *inside* the wrap, so a flake blown off the edge reappears upwind and the
  // field never empties downwind. See the header's §4.
  float halfW = uBox.x * 0.5;
  float halfD = uBox.z * 0.5;
  float sx = aSeed.x + uWind.x * uTime + flutter.x;
  float sz = aSeed.y + uWind.y * uTime + flutter.y;
  float dx = mod(sx - uCentre.x + halfW, uBox.x) - halfW;
  float dz = mod(sz - uCentre.z + halfD, uBox.z) - halfD;
  float dy = mod(aSeed.z - uTime * uFall * speed, uBox.y);

  vec3 world = vec3(uCentre.x + dx, uCentre.y + uBase + dy, uCentre.z + dz);
  vec4 view = viewMatrix * vec4(world, 1.0);

  // Screen-aligned and square: a flake has no long axis, so unlike the rain's streak there is
  // nothing here that has to agree with the direction of travel.
  float grade = clamp((speed - uSpeedRange.x) / max(0.0001, uSpeedRange.y - uSpeedRange.x), 0.0, 1.0);
  float size = uSize * mix(uSizeSpread.x, uSizeSpread.y, grade);
  view.xy += position.xy * size;
  gl_Position = projectionMatrix * view;

  vQuad = position.xy;
  // Zero alpha at the box's rim, so the wrap is never on screen. The rain's radial fade, verbatim.
  float radial = length(vec2(dx, dz)) / min(halfW, halfD);
  vFade = 1.0 - smoothstep(0.55, 0.98, radial);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;

varying vec2 vQuad;
varying float vFade;

void main() {
  // The disc, drawn rather than sampled: bright core, soft skirt. Squaring the smoothstep is what
  // turns a hard-edged dot into something with a defocused rim, which is what a flake close to the
  // camera actually looks like — and it costs one multiply instead of a texture unit.
  float d = length(vQuad);
  float disc = 1.0 - smoothstep(0.15, 1.0, d);
  disc *= disc;
  // Alpha blending, not additive: a flake hides what is behind it. See the header's §1 for why that
  // matters most at noon, where an additive white has nowhere left to go.
  gl_FragColor = vec4(uColour, disc * vFade * uOpacity);
}
`;

/**
 * The blizzard: one mesh, one material, one draw.
 *
 * Held rather than rebuilt, exactly as `Rain` is — the geometry and its two nine-thousand-element
 * buffers are allocated in the constructor and never again. Toggling it off sets `visible`, which
 * for a mesh recompiles nothing.
 */
export class Snow {
  readonly mesh: Mesh;
  /** Public so a headless test can read the uniforms the frame writes; nothing else touches it. */
  readonly material: ShaderMaterial;
  private readonly centre = new Vector3();
  /** Flakes seeded — the ceiling {@link density} scales, over a buffer never reallocated. */
  private readonly flakes: number;
  private readonly field: InstancedBufferGeometry;
  private rate = 1;
  private gale = 0;

  constructor(count = SNOW_FLAKES) {
    this.flakes = count;
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(QUAD_CORNERS, 3));
    geometry.setIndex(new BufferAttribute(QUAD_INDEX, 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(snowSeeds(count), SNOW_STRIDE));
    geometry.setAttribute('aDrift', new InstancedBufferAttribute(snowDrift(count), SNOW_DRIFT_STRIDE));
    geometry.instanceCount = count;
    this.field = geometry;

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: new Uniform(0),
        uCentre: new Uniform(this.centre),
        uBox: new Uniform(new Vector3(SNOW_BOX.width, SNOW_BOX.height, SNOW_BOX.depth)),
        uFall: new Uniform(SNOW_FALL),
        uSize: new Uniform(SNOW_SIZE),
        uSizeSpread: new Uniform(new Vector2(SNOW_SIZE_SPREAD.min, SNOW_SIZE_SPREAD.max)),
        uSpeedRange: new Uniform(new Vector2(SNOW_SPEED.min, SNOW_SPEED.max)),
        uBase: new Uniform(SNOW_BASE),
        uFlutter: new Uniform(SNOW_FLUTTER),
        uWind: new Uniform(new Vector2(0, 0)),
        uColour: new Uniform(new Color(SNOW_COLOUR)),
        uOpacity: new Uniform(SNOW_OPACITY),
      },
      transparent: true,
      blending: NormalBlending,
      depthWrite: false,
      depthTest: true,
      side: DoubleSide,
      fog: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    // Every real position is computed in the shader; the geometry's own bounds are a 2 m quad at the
    // origin, so culling against them would delete the weather the moment the camera looked away.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    // One past the rain's 10: during a crossfade the alpha field draws over the additive one, which
    // is the order that reads correctly when both are on screen at partial strength.
    this.mesh.renderOrder = 11;
    this.mesh.matrixAutoUpdate = false;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  set enabled(on: boolean) {
    this.mesh.visible = on;
  }

  /** How much of the blizzard falls, 0..1. One, until something tells it otherwise. */
  get density(): number {
    return this.rate;
  }

  /**
   * Flakes actually drawn this frame — {@link density} of the seeded count.
   *
   * The seeds are never reallocated, so this and `aSeed.count` diverge on purpose: the gap is the
   * snow that is not falling.
   */
  get drawn(): number {
    return this.field.instanceCount;
  }

  /**
   * Thin the blizzard — `sky.snowDensityOf`, and `Rain.density`'s argument word for word.
   *
   * **Fewer flakes rather than fainter ones**: fading nine thousand discs to a fifth of their alpha
   * is a whiteout seen through gauze, not a light fall. A **prefix** of the instance buffer thins
   * evenly for free, because a flake's position comes from `hashCell(i)` and not from `i` — the
   * first 1,620 indices are already spread across the whole box, which `snow.test.ts` counts by
   * octile. Nothing is reallocated and nothing re-uploaded: `instanceCount` is read at draw time, so
   * this is one integer write and the same single draw call.
   */
  set density(value: number) {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
    if (clamped === this.rate) return;
    this.rate = clamped;
    this.field.instanceCount = Math.round(this.flakes * clamped);
  }

  /**
   * The world's wind speed, `SkyView.wind` — Duris' bands, where 100 is a hurricane.
   *
   * Mapped to a lateral velocity by {@link SNOW_WIND_MAX} and {@link SNOW_WIND_FULL} and pointed
   * along {@link SNOW_WIND_DIR}. Written as the raw wire value rather than as metres so the mapping
   * lives in one place and `__debug3d` can report both ends of it.
   */
  get wind(): number {
    return this.gale;
  }

  set wind(value: number) {
    const clean = Math.max(0, Number.isFinite(value) ? value : 0);
    if (clean === this.gale) return;
    this.gale = clean;
    const drift = SNOW_WIND_MAX * Math.min(1, clean / SNOW_WIND_FULL);
    const uniform = this.material.uniforms['uWind'];
    if (uniform) (uniform.value as Vector2).set(SNOW_WIND_DIR[0] * drift, SNOW_WIND_DIR[1] * drift);
  }

  /** Metres a second the field is being pushed sideways. The readable end of {@link wind}. */
  get windMetres(): number {
    return SNOW_WIND_MAX * Math.min(1, this.gale / SNOW_WIND_FULL);
  }

  get opacity(): number {
    return this.material.uniforms['uOpacity']?.value as number;
  }

  set opacity(value: number) {
    const uniform = this.material.uniforms['uOpacity'];
    if (uniform) uniform.value = Math.max(0, value);
  }

  /**
   * The frame's two writes. **This is the whole per-frame cost of nine thousand flakes.**
   *
   * `seconds` is wall-clock since boot rather than a frame delta, for `Rain.update`'s reason: an
   * accumulator drifts with the frame rate, and a tab that slept would resume the blizzard mid-air.
   */
  update(seconds: number, x: number, y: number, z: number): void {
    const time = this.material.uniforms['uTime'];
    if (time) time.value = seconds;
    this.centre.set(x, y, z);
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
