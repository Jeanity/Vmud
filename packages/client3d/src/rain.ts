/**
 * Rain — one draw call, zero per-frame CPU, and a wrap that the vertex shader does by itself.
 *
 * > *"camera-parented rain as one `InstancedMesh` of ~6,000 elongated quads modulo-wrapped in a custom
 * > vertex shader (one draw call, zero CPU per frame, additive, `depthWrite` off)"*
 *
 * ## The wrap, which is the whole trick
 *
 * Six thousand drops fall inside a box that follows the character. A drop's seeded position is fixed
 * for the session; its drawn position is
 *
 * ```
 * x = centre.x + mod(seed.x - centre.x + W/2, W) - W/2
 * y = base    + mod(seed.y - t * fall,        H)
 * ```
 *
 * and the same for `z`. Read the `x` line twice: as the character walks east, every drop's *world*
 * position is unchanged until it falls outside the box, at which point `mod` teleports it to the far
 * side. So the rain is stationary in the world — it does not slide with the camera, which is the tell
 * that gives away a naive camera-parented particle field — and the box is always full without anything
 * ever being spawned or killed. The teleport happens at the box's edge, where {@link RAIN_BOX}'s
 * radial fade has already taken the drop to zero alpha, so it is never seen.
 *
 * `t` is `performance.now()`. **This is the milestone's one deliberate exception to determinism** and
 * it is a safe one: nothing reads the rain back, it writes no state, and no gameplay-visible value is
 * derived from it. The seeds themselves go through `hashCell` — the project's determinism contract —
 * rather than `Math.random`, so two clients at least agree on the *shape* of the storm.
 *
 * ## Not literally parented to the camera
 *
 * The plan says camera-parented and this is a child of the scene, because the camera carries 64
 * degrees of pitch and a child of it inherits them: the rain would fall at 26 degrees off vertical,
 * *toward* the viewer, which reads as a blizzard seen from a diving aircraft. Following the camera by
 * uniform instead costs one `Vector3` write a frame and keeps gravity pointing down. Everything else
 * the phrase was asking for — the fixed instance count, the absence of a particle simulation, the
 * single draw — is exactly as specified.
 *
 * ## Billboarding in view space
 *
 * The quad's corners are added *after* the world position has gone through the view matrix, so a
 * streak is always screen-aligned and always the same width in pixels regardless of the camera's
 * pitch. A world-space elongated box would foreshorten to a dot at this pitch, which is the failure
 * mode the plan's *"rain streaks under ortho become identical parallel lines"* note is a cousin of.
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
  Vector2,
  Vector3,
} from 'three';

import { hashCell } from '@mygame/shared';

/** The plan's ~6,000. One draw call whatever this is; the number only buys density. */
export const RAIN_DROPS = 6000;

/**
 * The box the storm lives in, in metres.
 *
 * Wider than the frame (34 x 22 m) so a drop is already invisible by the time it wraps, and tall
 * enough that a drop entering at the top has fallen for most of a second before it reaches the
 * character's eyeline. 34 m of height at {@link RAIN_FALL} is 1.1 s of life per drop.
 */
export const RAIN_BOX = { width: 64, height: 34, depth: 64 } as const;

/** Metres a second, before per-drop variance. Fast enough to streak, slow enough to read as rain. */
export const RAIN_FALL = 30;

/** Where the box sits relative to the focus: mostly above, a little below, so the ground is wet too. */
export const RAIN_BASE = -6;

/** Streak size in view units at one metre — half-width and half-length before the depth divide. */
export const RAIN_SIZE = { width: 0.018, length: 0.42 } as const;

/** Cool and pale; the drops pick up the moon, not the ground. */
export const RAIN_COLOUR = 0x9fc4dc;

/** Additive alpha at the centre of the box. Low: six thousand of them add up fast. */
export const RAIN_OPACITY = 0.22;

/** Floats per drop in the instanced attribute: `(seedX, seedZ, seedY, speed)`. */
export const RAIN_STRIDE = 4;

/** Salt for {@link hashCell}, so the storm is not a rotation of some other seeded field. */
const RAIN_SEED = 0x5261_696e;

/** `hashCell` is unsigned 32-bit; this maps it onto `[0, 1)`. Same divisor `noise.ts` uses. */
const HASH_RANGE = 0x1_0000_0000;

/**
 * The per-drop attribute buffer, built once.
 *
 * Pure and exported so `rain.test.ts` can assert the layout without a GPU: every element in range,
 * the stride exactly {@link RAIN_STRIDE}, and two calls with the same seed byte-identical. That last
 * one is what makes the storm a *fact about the build* rather than about the machine.
 */
export function rainSeeds(count: number, seed = RAIN_SEED): Float32Array {
  const out = new Float32Array(count * RAIN_STRIDE);
  for (let i = 0; i < count; i++) {
    const at = i * RAIN_STRIDE;
    out[at] = (hashCell(i, 0, 0, seed) / HASH_RANGE) * RAIN_BOX.width;
    out[at + 1] = (hashCell(i, 1, 0, seed) / HASH_RANGE) * RAIN_BOX.depth;
    out[at + 2] = (hashCell(i, 2, 0, seed) / HASH_RANGE) * RAIN_BOX.height;
    // 0.8..1.3 of the base fall speed. The spread is what stops the field pulsing as one sheet.
    out[at + 3] = 0.8 + (hashCell(i, 3, 0, seed) / HASH_RANGE) * 0.5;
  }
  return out;
}

/** One screen-aligned quad, in the units the vertex shader multiplies by {@link RAIN_SIZE}. */
const QUAD_CORNERS = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 2, 3, 0]);

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uCentre;
uniform vec3 uBox;
uniform float uFall;
uniform vec2 uSize;
uniform float uBase;

attribute vec4 aSeed;

varying float vFade;

void main() {
  // Wrapped about the focus. See the header: the world position is what stays still.
  float halfW = uBox.x * 0.5;
  float halfD = uBox.z * 0.5;
  float dx = mod(aSeed.x - uCentre.x + halfW, uBox.x) - halfW;
  float dz = mod(aSeed.y - uCentre.z + halfD, uBox.z) - halfD;
  float dy = mod(aSeed.z - uTime * uFall * aSeed.w, uBox.y);

  vec3 world = vec3(uCentre.x + dx, uCentre.y + uBase + dy, uCentre.z + dz);
  vec4 view = viewMatrix * vec4(world, 1.0);

  // Screen-aligned, and elongated along the streak. Length tracks speed so a fast drop is a longer
  // line, which is the only cue that says how hard it is raining.
  view.xy += position.xy * vec2(uSize.x, uSize.y * aSeed.w);
  gl_Position = projectionMatrix * view;

  // Gone before it wraps: zero alpha at the box's rim, so the teleport is never on screen.
  float radial = length(vec2(dx, dz)) / min(halfW, halfD);
  vFade = 1.0 - smoothstep(0.55, 0.98, radial);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;

varying float vFade;

void main() {
  // Additive blending is src*srcAlpha + dst, so the fade belongs in alpha and the colour stays pure.
  gl_FragColor = vec4(uColour, vFade * uOpacity);
}
`;

/**
 * The storm: one mesh, one material, one draw.
 *
 * Held rather than rebuilt — the geometry and its six thousand seeds are allocated in the constructor
 * and never again, which is the same rule `pool.ts` keeps for everything else in the scene. Toggling
 * it off sets `visible`, which for a mesh (unlike for a light — see `lights.ts`) recompiles nothing.
 */
export class Rain {
  readonly mesh: Mesh;
  /** Public so a headless test can read the uniforms the frame writes; nothing else touches it. */
  readonly material: ShaderMaterial;
  private readonly centre = new Vector3();

  constructor(count = RAIN_DROPS) {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(QUAD_CORNERS, 3));
    geometry.setIndex(new BufferAttribute(QUAD_INDEX, 1));
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(rainSeeds(count), RAIN_STRIDE));
    geometry.instanceCount = count;

    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: new Uniform(0),
        uCentre: new Uniform(this.centre),
        uBox: new Uniform(new Vector3(RAIN_BOX.width, RAIN_BOX.height, RAIN_BOX.depth)),
        uFall: new Uniform(RAIN_FALL),
        uSize: new Uniform(new Vector2(RAIN_SIZE.width, RAIN_SIZE.length)),
        uBase: new Uniform(RAIN_BASE),
        uColour: new Uniform(new Color(RAIN_COLOUR)),
        uOpacity: new Uniform(RAIN_OPACITY),
      },
      transparent: true,
      blending: AdditiveBlending,
      // Rain must not write depth or six thousand quads occlude each other and the field turns into a
      // grey sheet. It still *tests* depth, so a wall in front of a drop hides it.
      depthWrite: false,
      depthTest: true,
      // Both faces, because the quad is built in view space and its winding is whatever the corner
      // order happens to give after the projection.
      side: DoubleSide,
      fog: false,
    });

    this.mesh = new Mesh(geometry, this.material);
    // The geometry's own bounds describe a 2 m quad at the origin; every real position is computed in
    // the shader, so culling it against those bounds would remove the storm the moment the camera
    // looked away from the origin.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 10;
    this.mesh.matrixAutoUpdate = false;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  set enabled(on: boolean) {
    this.mesh.visible = on;
  }

  get opacity(): number {
    return this.material.uniforms['uOpacity']?.value as number;
  }

  set opacity(value: number) {
    const uniform = this.material.uniforms['uOpacity'];
    if (uniform) uniform.value = Math.max(0, value);
  }

  /**
   * The frame's two writes. **This is the whole per-frame cost of six thousand drops.**
   *
   * `seconds` is wall-clock since boot, not the frame delta: an accumulator would drift with the
   * frame rate and a tab that slept would resume the storm mid-air.
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
