/**
 * The two-layer ground blend — §4 Layer B point 1, and the one shader that answers all 104 sector
 * pairs.
 *
 * > *"Measured: **40.7% of rooms have at least one cardinal neighbour with a different sector**, and
 * > 98 distinct sector-pairs actually occur in the world with 61 of them fewer than 50 times each.
 * > That rules out hand-authored transition sets absolutely. Instead the ground material blends two
 * > biome layers by *vertex weight* across the boundary — one shader handles all 98 pairs."*
 *
 * M2 re-measured and found **104** pairs across linked cardinal neighbours, 108 counting every
 * boundary with a known room behind it. The number does not change the argument; it makes it louder.
 *
 * ## Layer A is the material, layer B is the instance
 *
 * The pool already holds one ground material per sector, coloured by a **uniform**. That material is
 * layer A and nothing here touches it. Layer B — the biome the ground is turning into — is
 * per-*instance*, because it is a property of the room and there are 46,544 of those:
 *
 * - `iTint.rgb` is layer B's colour, in the **linear** working space three's shaders mix in (see
 *   `prototypes.srgbToLinear`, and note that `chunkPlan.ts` does the conversion because it computes
 *   this without being allowed to import `three`).
 * - `iBlend` is layer B's weight at the room block's **four corners**, in `(u,v)` order
 *   `(0,0) (1,0) (1,1) (0,1)`.
 *
 * Corners rather than the four edge weights the IR carries, and this is the one place the
 * implementation reads the geometry rather than the spec: the ground is a `BoxGeometry(1,1,1)` and
 * its top face has exactly four vertices, so *any* field over that face is bilinear whatever the
 * vertex shader computes. Handing the shader the corner values it can actually interpolate is honest;
 * handing it four edge midpoints and a ramp function would be arithmetic performed on a resolution
 * that does not exist. `chunkPlan.cornerBlend` does the edge-to-corner fold, where it is pure and
 * testable.
 *
 * **A room with no differing neighbour carries four zeros**, which makes the whole term vanish rather
 * than mix a colour into itself — and that is also how *"roofed rooms keep flat ground"* is
 * implemented. Not a branch, not a second material: an interior's blend weights are zero because an
 * interior has no biome to turn into.
 *
 * ## The breakup, and exactly how much of it is `hashCell`
 *
 * A bilinear weight field crossing 0.5 is a straight line, and a straight line between a forest and a
 * field is a mowed lawn. So the weight is perturbed before it is thresholded, by a smooth field of
 * world position **phased per room by `hashCell`** (`iTint.w`, computed on the CPU in `chunkPlan.ts`
 * from `RoomScene.seed`).
 *
 * Be precise about which half is which, because it matters for the determinism rule:
 *
 * - **The per-room phase is `hashCell`** — exact, integer, identical on every machine. It is what
 *   stops every boundary in the world wiggling in the same place, which is the visible failure.
 * - **The intra-room wiggle is an analytic function of world position**, not `hashCell`. `hashCell`'s
 *   `Math.imul` chain has no portable GLSL1-compatible equivalent, and a `fract(sin(...))` lattice
 *   hash is not bit-identical across GPU vendors. That is acceptable *here and only here*: nothing
 *   reads the ground's colour back, no gameplay value derives from it, and the field is continuous
 *   across chunk seams because it is keyed on world position exactly as `noise.ts`'s elevation is. A
 *   boundary that is a pixel different on an AMD card than on an NVIDIA one is not a desync.
 *
 * The noise is gated by `4w(1-w)`, so it is strongest where the weight is near a half and vanishes
 * where the ground is committed to one biome or the other. That is what makes it a *boundary*
 * breakup rather than a texture over the whole slab.
 *
 * ## The floor texture rides in the same patch — 2026-08-13
 *
 * *"I wonder why the entire room isn't cobblestones."* The ground was a flat colour and had been
 * since M3, so the answer was "because nothing ever put a texture on it". The map lives here rather
 * than on the material because of the one property this file exists to protect — see the next
 * section — and because the thing it most needs is already computed here: `vBlendWorld`, the warped
 * world position, which is what lets one repeat of a cobble tile run across a room, across the gap
 * and into the next room with no seam and no per-room uv. {@link BLEND_FRAGMENT_GLSL} is where it
 * lands and why it lands *after* the two-layer mix; `prototypes.GROUND_TEXTURES` is which sectors
 * take one and what was measured to choose them.
 *
 * ## One program
 *
 * Every one of the 48 ground materials (16 sectors x present/faded, minus the faded fold) carries the
 * same `onBeforeCompile` and the same `customProgramCacheKey`, so the pool's ground family is **one**
 * compiled program — the same discipline `prototypes.ts` has kept since M3, and the reason a hundred
 * sector pairs cost nothing.
 *
 * **The floor texture did not change that number and could very easily have.** `material.map` sets
 * `USE_MAP`, which is a `#define`: a cobbled city floor and an untextured field floor would have been
 * two programs, and the ground family would have split for the first time since M5a. A sampler
 * *declared by this patch* is a uniform instead, so all 48 compile byte-identical GLSL and differ
 * only in what is bound. `pool.programKeys` still answers nine.
 */

import { Uniform, Vector3, type Texture } from 'three';

import type { ShaderPatch } from './foliage.ts';
import type { GroundTexture } from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * How far the boundary wanders, as a fraction of the weight range.
 *
 * At 0 the transition is a ruler-straight bilinear ramp. At 0.5 it is lace. 0.28 puts the visible
 * line about a metre and a half either side of where the geometry says it is, which at a 9 m room is
 * enough to read as terrain and not so much that a forest appears in the middle of a field.
 */
export const BLEND_NOISE = 0.28;

/**
 * Cycles per metre of the breakup field.
 *
 * Deliberately much higher than `GROUND_NOISE_FREQUENCY` (one undulation every 22 m): the elevation
 * field is landform and this is a *shoreline*, so it wants detail at the scale of a stride rather
 * than of a zone. 0.42 is a full wiggle every 2.4 m.
 */
export const BLEND_FREQUENCY = 0.42;

/** The shared knobs, one object for all 48 ground materials. Same pattern as `foliage.WindClock`. */
export interface BlendControls {
  readonly uBlendNoise: Uniform<number>;
  readonly uBlendFrequency: Uniform<number>;
}

export function createBlendControls(): BlendControls {
  return {
    uBlendNoise: new Uniform(BLEND_NOISE),
    uBlendFrequency: new Uniform(BLEND_FREQUENCY),
  };
}

/* -------------------------------------------------------------------------- */
/* The floor texture — 2026-08-13                                              */
/* -------------------------------------------------------------------------- */

/**
 * One ground material's floor texture, as uniforms — **per material, where {@link BlendControls} is
 * shared, and the difference is the whole point.**
 *
 * `BlendControls` is one object handed to all 48 materials by reference, because a knob that is
 * tuned once must move all of them at once. This is the opposite: a city floor is cobbled and a
 * forest floor is not, and *which texture* is exactly the thing that varies between two materials in
 * one family. Both are uniforms, so both cost nothing in programs; see `prototypes.GROUND_TEXTURES`
 * rule 1 for why the map must not be `material.map`.
 *
 * `uGroundGain` at zero is the untextured case and it is a real one: 13 of the 16 sectors take it,
 * and at zero the `mix` below returns white and the fragment is M3's painted box to the bit.
 */
export interface GroundMapControls {
  readonly uGroundMap: Uniform<Texture | null>;
  /** Repeats per metre — `1 / GroundTexture.metres`, converted here so the shader multiplies. */
  readonly uGroundScale: Uniform<number>;
  readonly uGroundGain: Uniform<number>;
  /** The texture's own linear mean, so an average texel multiplies to one. See rule 2. */
  readonly uGroundMean: Uniform<Vector3>;
}

export function createGroundMapControls(
  spec: GroundTexture | undefined,
  placeholder: Texture | null,
): GroundMapControls {
  return {
    // Never null in practice: a sampler with nothing bound reads texture unit 0, which is whatever
    // the last draw happened to leave there. The white 1x1 `pool.ts` already mints for the kit is the
    // same trick in the same shape — see `pool.whiteTexture`.
    uGroundMap: new Uniform<Texture | null>(placeholder),
    uGroundScale: new Uniform(spec ? 1 / spec.metres : 0),
    // Zero until the real texture lands. A gain that was live against the placeholder would multiply
    // the floor by `white / mean`, which is a room that flashes bright and then settles.
    uGroundGain: new Uniform(0),
    uGroundMean: new Uniform(new Vector3(...(spec?.mean ?? [1, 1, 1]))),
  };
}

/* -------------------------------------------------------------------------- */
/* The GLSL                                                                    */
/* -------------------------------------------------------------------------- */

export const BLEND_VERTEX_DECL = /* glsl */ `
attribute vec4 iBlend;
attribute vec4 iTint;
varying float vBlendWeight;
varying vec3 vBlendColour;
varying vec2 vBlendWorld;
varying float vBlendPhase;
`;

/**
 * The weight field, evaluated per vertex.
 *
 * `position.xz + 0.5` is the unit box's own `(u, v)`, which is why the ground slab is a box and this
 * needs no second attribute to say where on the room a vertex is. The side faces get the same
 * treatment and that is correct: where a level drops away, the exposed edge of the slab should show
 * the same two soils the top does.
 */
export const BLEND_VERTEX_GLSL = /* glsl */ `
  vec2 blendUv = position.xz + 0.5;
  vBlendWeight = mix(mix(iBlend.x, iBlend.y, blendUv.x), mix(iBlend.w, iBlend.z, blendUv.x), blendUv.y);
  vBlendColour = iTint.rgb;
  vBlendPhase = iTint.w;
  #ifdef USE_INSTANCING
  vBlendWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
  #else
  vBlendWorld = (modelMatrix * vec4(transformed, 1.0)).xz;
  #endif
`;

export const BLEND_FRAGMENT_DECL = /* glsl */ `
uniform float uBlendNoise;
uniform float uBlendFrequency;
uniform sampler2D uGroundMap;
uniform float uGroundScale;
uniform float uGroundGain;
uniform vec3 uGroundMean;
varying float vBlendWeight;
varying vec3 vBlendColour;
varying vec2 vBlendWorld;
varying float vBlendPhase;

// Two octaves of a smooth analytic field. Continuous across a chunk seam because it reads world
// position and nothing else — the same property noise.ts relies on, for the same reason.
float blendBreakup(vec2 p) {
  float a = sin(p.x * 1.13 + p.y * 0.71) * 0.5 + sin(p.y * 1.31 - p.x * 0.47) * 0.5;
  float b = sin(p.x * 2.91 - p.y * 2.13);
  return a * 0.62 + b * 0.38;
}
`;

/**
 * The mix, injected **before** `<color_fragment>` and not after.
 *
 * `<color_fragment>` is where three multiplies `instanceColor` into `diffuseColor`, and
 * `instanceColor` is this renderer's fog of war (`fogOfWar.ts`). Blending after it would leave the
 * neighbour's soil at full brightness inside an unexplored room — a bright green tongue reaching into
 * a black silhouette. Blending first means the fog dims the answer rather than half of it.
 *
 * **The floor texture goes in the same block, after the mix, and that ordering is load-bearing three
 * times over.** After the mix, because a cobble pattern multiplied over layer A and *then* mixed
 * toward a flat layer B would leave the neighbouring biome untextured on one side of a soft boundary
 * and stone on the other — the seam would reappear as a texture edge exactly where a milestone was
 * spent hiding it. Still before `<color_fragment>`, for the same reason the mix is: the fog of war
 * must dim a cobbled street, not sit under it. And **faded out by the same `w`**, so the stones
 * dissolve as the ground turns into whatever is next door rather than running into it — which is what
 * makes a paved square end at the field it meets instead of paving the field.
 *
 * Three's `map_fragment` is not involved at all and there is no `USE_MAP` in this shader. See
 * `prototypes.GROUND_TEXTURES` rule 1.
 */
export const BLEND_FRAGMENT_GLSL = /* glsl */ `
  {
    float base = clamp(vBlendWeight * 2.0, 0.0, 1.0);
    // Strongest at the half-way line, nothing where the ground has made up its mind.
    float gate = 4.0 * base * (1.0 - base);
    float wobble = blendBreakup(vBlendWorld * uBlendFrequency + vBlendPhase * 17.0);
    float w = clamp(base + wobble * uBlendNoise * gate, 0.0, 1.0);
    float layerB = smoothstep(0.03, 0.97, w);
    diffuseColor.rgb = mix(diffuseColor.rgb, vBlendColour, layerB);
    // World-space, so the paving runs through the room, through the gap and into the next room with
    // no seam and no per-room uv. uGroundGain is 0 for the thirteen sectors with no floor texture
    // and until the PNG lands, and at 0 this whole term is a multiply by one.
    vec3 stone = texture2D(uGroundMap, vBlendWorld * uGroundScale).rgb / uGroundMean;
    diffuseColor.rgb *= mix(vec3(1.0), stone, uGroundGain * (1.0 - layerB));
  }
`;

/**
 * Apply the whole patch to one shader. Exported so `blend.test.ts` can run it without a renderer.
 *
 * `controls` is the pool's one shared knob object; `map` is **this material's own** floor texture —
 * see {@link GroundMapControls} for why the two have different lifetimes and why neither costs a
 * program.
 */
export function patchGroundBlend(shader: ShaderPatch, controls: BlendControls, map: GroundMapControls): void {
  shader.uniforms['uBlendNoise'] = controls.uBlendNoise as unknown as { value: unknown };
  shader.uniforms['uBlendFrequency'] = controls.uBlendFrequency as unknown as { value: unknown };
  shader.uniforms['uGroundMap'] = map.uGroundMap as unknown as { value: unknown };
  shader.uniforms['uGroundScale'] = map.uGroundScale as unknown as { value: unknown };
  shader.uniforms['uGroundGain'] = map.uGroundGain as unknown as { value: unknown };
  shader.uniforms['uGroundMean'] = map.uGroundMean as unknown as { value: unknown };

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\n${BLEND_VERTEX_DECL}`,
  );
  // After `<begin_vertex>` because the world position is taken from `transformed`, which that chunk
  // is what declares.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\n${BLEND_VERTEX_GLSL}`,
  );

  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\n${BLEND_FRAGMENT_DECL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `${BLEND_FRAGMENT_GLSL}\n#include <color_fragment>`,
  );
}

/* -------------------------------------------------------------------------- */
/* The mirror                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The weight field in TypeScript — {@link BLEND_VERTEX_GLSL}'s bilinear, restated.
 *
 * Here for the same reason `foliage.foliageWindOffset` is: the shader cannot run headless, but the
 * *field* is the part that has to be right, and a test can check that it is 0 at the room's centre
 * when the four corners are 0, that it reaches the corner value at the corner, and that two rooms
 * meeting at a shared edge agree on the weight along it.
 */
export function blendWeightAt(
  corners: readonly [number, number, number, number],
  u: number,
  v: number,
): number {
  const top = corners[0] + (corners[1] - corners[0]) * u;
  const bottom = corners[3] + (corners[2] - corners[3]) * u;
  return top + (bottom - top) * v;
}
