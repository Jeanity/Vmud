/**
 * The card-foliage material — §5's *"Gap 2 — soft painterly foliage"*, and the two traps it names.
 *
 * > *"conifer canopies as ~14 intersecting alpha-clipped cards (`alphaTest ~0.4` with
 * > `AlphaToCoverage` + MSAA — clip, not blend, so they shadow-map and sort correctly),
 * > `MeshStandardMaterial` patched via `onBeforeCompile` with wind sway in the vertex shader keyed on
 * > an instance-position hash, a two-sided translucency term so the moon rims the canopy, and normals
 * > bent toward the canopy volume so 14 flat cards light as one soft mass rather than 14 planes."*
 *
 * One material family, one compiled program, and it dresses both the canopies and the undergrowth —
 * a needle spray and a grass blade are the same problem (a quad that has to stop being a quad) and
 * differ by a uniform, not by a shader.
 *
 * ## Trap 1 — the wind must be in the depth material too, or the shadows come off
 *
 * > *"**the wind displacement must be duplicated into `customDepthMaterial` or shadows visibly detach
 * > from the animated foliage**"*
 *
 * The shadow pass does not render this material. It renders a `MeshDepthMaterial`, and a depth
 * material that does not know about the sway draws the canopy where the canopy *would* be if it were
 * still — so the tree leans one way and its shadow stays put, which at a raking 41-degree moon is the
 * most obvious wrongness on the screen.
 *
 * "Duplicated" is exactly the word this file refuses to implement. There is **one**
 * {@link FOLIAGE_WIND_GLSL} string and **one** set of wind uniform objects, and both the visible
 * material and {@link createFoliageDepth}'s depth material are handed the same two by reference. So
 * parity is not a thing that is maintained, it is a thing that cannot be broken without deleting a
 * shared constant — and `foliage.test.ts` asserts both halves anyway: that the block injected into
 * the two vertex shaders is byte-identical, and that the uniform objects driving them are the same
 * objects.
 *
 * The one place three does *not* let the two agree is the clip threshold: `getDepthMaterial`
 * overwrites `result.alphaTest` with a flat `0.5` whenever the source material has
 * `alphaToCoverage`, with the comment *"approximate alphaToCoverage by using a fixed alphaTest
 * value"*. That is three's own decision and it is the right one — coverage is a dither and a shadow
 * cannot dither — so {@link FOLIAGE_ALPHA_TEST} is 0.4 and the mask's soft edge is wide enough that
 * 0.4 and 0.5 cut it in nearly the same place. Worth knowing before somebody spends an afternoon on
 * a needle that is a pixel narrower in the shadow than in the light.
 *
 * ## Trap 2 — a conifer is not a sphere
 *
 * > *"the 'bend normals toward the sphere centre' recipe is the **broadleaf** one — a conifer is a
 * > cone of tiered drooping branches, and spherical normals will flatten it into a lit blob and
 * > destroy the silhouette that makes it read as pine."*
 *
 * {@link FOLIAGE_NORMAL_GLSL} therefore never computes `normalize(position - centre)`. It builds the
 * normal in two steps:
 *
 * 1. **The cone shell.** For a cone of height `H` and base radius `R`, the outward surface normal at
 *    radius `rho` is `normalize(vec3(radial * H/R, 1))` — that ratio is the manifest's `coneSlope`,
 *    measured off the baked mesh's own crown rather than guessed. A tall spruce has a slope near 5.6
 *    and its shell normals are nearly horizontal; a squat sapling has 4.0 and its lean up. That
 *    difference *is* the difference between the two silhouettes under a low moon, and a sphere throws
 *    it away.
 * 2. **The tiers.** A conifer is not a smooth cone, it is a stack of whorls, and what makes it read
 *    as one is that the underside of each skirt is dark while the shoulder above it catches the light.
 *    So the shell normal is tipped down at the bottom of a tier and up at its top, by `droop`, using
 *    the **card's** height in the canopy (`aCard.y`, baked per card in `treegen.ts`) rather than the
 *    vertex's — a per-vertex tier coordinate would put a lighting seam through the middle of a card
 *    where the tier index rolls over.
 *
 * `uBend` mixes back toward the card's own flat normal and is a live knob, because the honest answer
 * to "how much" is a thing the owner decides by looking. At `uBend = 0` this is fourteen lit planes,
 * which is the failure the trap describes; at `1` it is a lit cone with tiers in it.
 *
 * ## Clip, not blend
 *
 * `transparent` is **false** and stays false. §5 is explicit that these must clip so they *"shadow-map
 * and sort correctly"*, and `post.ts` already runs the composer at `MULTISAMPLING = 4`, which is what
 * makes {@link FOLIAGE_ALPHA_TEST} plus `alphaToCoverage` produce a soft edge instead of a jagged
 * one. A blended canopy would need a per-instance depth sort the pool cannot give it, would write no
 * depth, and would put every tree in the transparent queue behind the rain.
 *
 * ## Where the colour variation is *not*
 *
 * Read §7 risk 2 before extending this file. Bent normals, translucency and wind change how a card is
 * *lit*; they cannot invent hand-painted colour inside it. What this material has instead is
 * per-card variation — hue and value jittered by `aCard.x`, the baked centroid hash — which stops a
 * canopy being one card repeated and does not pretend to be a painted atlas. See the M5a report.
 */

import {
  Color,
  DoubleSide,
  MeshDepthMaterial,
  MeshLambertMaterial,
  RGBADepthPacking,
  Uniform,
  Vector2,
} from 'three';

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The plan's *"`alphaTest ~0.4`"*, quoted.
 *
 * Note the interaction with `alphaToCoverage` documented in the header: three clips the *shadow* at a
 * fixed 0.5 regardless of this value, so the mask's edge is deliberately soft over roughly 0.3..0.7
 * and the two thresholds land within a needle's width of each other.
 */
export const FOLIAGE_ALPHA_TEST = 0.4;

/**
 * Sway at the tip, as a **fraction of the thing's own height**. Dimensionless on purpose.
 *
 * A single metre figure cannot serve both a 16 m spruce and a 42 cm tuft: 16 cm is invisible on the
 * spruce from 35 m and would fold the tuft flat. Expressing it as a fraction and multiplying by
 * `uTreeHeight` inside the displacement makes one number mean the same thing at both scales — 0.024
 * is 38 cm at the top of a `pine-tall`, which is a breeze rather than a gale. The remaining
 * difference between a stiff trunk and a loose blade is {@link FoliageSpec.windGain}.
 */
export const WIND_STRENGTH = 0.024;

/** Radians a second of the base gust. Slow — a conifer is heavy and a fast one reads as underwater. */
export const WIND_SPEED = 0.9;

/** Which way the wind blows, in the XZ plane. Normalised; a constant, because weather is not yet data. */
export const WIND_DIRECTION: readonly [number, number] = [0.82, 0.57];

/** How far toward the cone-tiered normal a canopy is bent. See the header's trap 2 for what 0 costs. */
export const CANOPY_BEND = 0.78;

/** Backlight through a card, and how tightly it focuses. The moon rimming the canopy. */
export const CANOPY_TRANSLUCENCY = 0.55;
export const CANOPY_TRANSLUCENCY_POWER = 3;

/** Undergrowth fades out between these metres from the camera. Beyond the second, nothing is drawn. */
export const GRASS_FADE: readonly [number, number] = [17, 27];

/** Needles or blades. A uniform rather than a define, which is what keeps this to one program. */
export const MASK_NEEDLE = 0;
export const MASK_BLADE = 1;

/* -------------------------------------------------------------------------- */
/* The shared wind clock                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The uniforms every foliage material in the scene shares, **by reference**.
 *
 * One object, handed to every canopy, every undergrowth material and every one of their depth twins.
 * That is what makes the **F** key one write rather than a loop, and it is the mechanism behind trap
 * 1: a depth material cannot drift out of phase with the material it shadows for, because there is no
 * second clock to drift against.
 */
export interface WindClock {
  readonly uTime: Uniform<number>;
  /** 0 or 1. The **F** key and `__debug3d.windEnabled`. A uniform, so toggling compiles nothing. */
  readonly uWind: Uniform<number>;
  readonly uWindDir: Uniform<Vector2>;
  readonly uWindStrength: Uniform<number>;
  readonly uWindSpeed: Uniform<number>;
}

export function createWindClock(): WindClock {
  return {
    uTime: new Uniform(0),
    uWind: new Uniform(1),
    uWindDir: new Uniform(new Vector2(WIND_DIRECTION[0], WIND_DIRECTION[1])),
    uWindStrength: new Uniform(WIND_STRENGTH),
    uWindSpeed: new Uniform(WIND_SPEED),
  };
}

/* -------------------------------------------------------------------------- */
/* The GLSL                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Declarations shared by the visible material's vertex shader and the depth material's.
 *
 * One string for both, for the same reason {@link FOLIAGE_WIND_GLSL} is: the depth program declaring
 * one uniform differently is a shadow that is displaced by a different amount, which is trap 1 wearing
 * a hat. Uniforms the depth path never reads are declared anyway and compile away — three only uploads
 * what the linked program actually kept.
 */
export const FOLIAGE_VERTEX_DECL = /* glsl */ `
uniform float uTime;
uniform float uWind;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform float uWindSpeed;
uniform float uWindGain;
uniform float uTreeHeight;
uniform vec2 uCanopyAxis;
uniform float uConeSlope;
uniform float uTiers;
uniform float uDroop;
uniform float uBend;
uniform vec2 uFade;
attribute vec2 aCard;
varying vec2 vFoliageUv;
varying float vFoliageCard;
varying float vFoliageFade;
`;

/**
 * **The one wind displacement.** Injected verbatim into both vertex shaders; see the header's trap 1.
 *
 * `origin` is the instance's own world translation — `instanceMatrix[3].xyz` — so the phase is a
 * function of *where the tree stands*, which is the plan's *"keyed on an instance-position hash"* and
 * is what makes two clients that never speak sway the same tree the same way. Nothing reads it back:
 * the sway is the one place in this renderer, beside the rain and the portal pulse, where wall-clock
 * time is allowed in at all.
 *
 * Three terms, and each is doing a job:
 *
 * - `bend = h * h` — a cantilever, not a shear. The foot of the trunk does not move and the tip moves
 *   most, which is the difference between a tree in wind and a tree being dragged sideways.
 * - two sines at an irrational-ish ratio — a single sine is a metronome and the eye finds it in about
 *   four seconds.
 * - `flutter`, scaled by the card hash — the cards inside one canopy do not move as one sheet.
 *
 * The `y` term is negative and follows the magnitude of the horizontal offset: a card swinging on an
 * arc drops as it goes out, and without it the canopy visibly *stretches* at the extremes.
 */
export const FOLIAGE_WIND_GLSL = /* glsl */ `
float foliagePhase(vec3 origin) {
  return sin(dot(origin.xz, vec2(0.7371, 0.4113)) * 3.11) * 6.2831853;
}

vec3 foliageWind(vec3 local, vec3 origin, float card) {
  float height = max(uTreeHeight, 0.001);
  float h = clamp(local.y / height, 0.0, 1.0);
  float bend = h * h;
  float phase = foliagePhase(origin) + card * 6.2831853;
  float t = uTime * uWindSpeed;
  float gust = sin(t + phase) * 0.75 + sin(t * 2.37 + phase * 1.7) * 0.25;
  float flutter = sin(t * 5.1 + phase * 3.3) * 0.18 * card;
  vec2 sway = uWindDir * ((gust + flutter) * uWindStrength * uWindGain * height * bend);
  float drop = -abs(sway.x) * 0.12 - abs(sway.y) * 0.12;
  return vec3(sway.x, drop, sway.y) * uWind;
}
`;

/**
 * The bent normal. **Colour material only** — a depth pass has no normals to bend.
 *
 * See the header's trap 2 for why this is a cone and a tier stack rather than a sphere.
 */
export const FOLIAGE_NORMAL_GLSL = /* glsl */ `
vec3 foliageBentNormal(vec3 local, vec3 flatNormal, float tierCoord) {
  vec2 offset = local.xz - uCanopyAxis;
  float r = length(offset);
  vec3 radial = r > 1e-4 ? vec3(offset.x / r, 0.0, offset.y / r) : vec3(0.0, 0.0, 1.0);
  // The cone shell, from the crown's own slope. Emphatically not the spherical recipe: see trap 2.
  vec3 cone = normalize(vec3(radial.x * uConeSlope, 1.0, radial.z * uConeSlope));
  // Within one whorl: -1 under the skirt, +1 on the shoulder. What separates the tiers under a
  // raking moon instead of merging them into one lit mass.
  float lift = fract(tierCoord * uTiers) * 2.0 - 1.0;
  vec3 bent = normalize(cone + vec3(0.0, lift * uDroop, 0.0));
  return normalize(mix(flatNormal, bent, uBend));
}
`;

/**
 * The alpha mask, shared by the visible fragment shader and the depth one.
 *
 * No texture, and that is a decision rather than a shortcut — see §7 risk 2 and the M5a report. A
 * needle spray is a fan of strands from the base of the card; a blade is a vertical taper. Both are a
 * handful of ALU and both are keyed on the card's own hash so two cards side by side are not the same
 * card. `uMaskKind` picks between them: a **uniform** branch, coherent across every fragment of every
 * draw, so it costs a jump and not a program.
 */
export const FOLIAGE_MASK_GLSL = /* glsl */ `
uniform float uMaskKind;
uniform float uMaskCount;
uniform float uMaskSpread;
varying vec2 vFoliageUv;
varying float vFoliageCard;
varying float vFoliageFade;

float foliageNeedleMask(vec2 uv, float jitter) {
  vec2 p = vec2(uv.x - 0.5, uv.y);
  float r = length(vec2(p.x, p.y * 0.92)) * 1.35;
  float a = atan(p.x, max(p.y, 1e-3));
  float k = clamp(a / uMaskSpread * 0.5 + 0.5, 0.0, 1.0);
  float strand = abs(fract(k * uMaskCount + jitter) - 0.5) * 2.0;
  // Wide and merged at the base, fine and separate at the tip: a spray, not a comb.
  float width = mix(0.95, 0.30, smoothstep(0.05, 0.85, r));
  float m = 1.0 - smoothstep(width * 0.5, width, strand);
  m *= 1.0 - smoothstep(0.62, 1.0, r);
  m *= 1.0 - smoothstep(uMaskSpread * 0.82, uMaskSpread, abs(a));
  return m;
}

float foliageBladeMask(vec2 uv, float jitter) {
  float k = fract(uv.x * uMaskCount + jitter);
  float d = abs(k - 0.5) * 2.0;
  float width = mix(1.0, 0.18, uv.y);
  float m = 1.0 - smoothstep(width * 0.45, width, d);
  m *= 1.0 - smoothstep(0.82, 1.0, uv.y);
  return m;
}

float foliageMask(vec2 uv, float jitter) {
  float m = uMaskKind < 0.5 ? foliageNeedleMask(uv, jitter) : foliageBladeMask(uv, jitter);
  return m * vFoliageFade;
}
`;

/**
 * The two-sided translucency term — the plan's *"so the moon rims the canopy"*.
 *
 * Added to `directDiffuse` after three's own lighting, and reading the moon out of
 * `directionalLights[0]` because there is exactly one directional light in the rig and there is meant
 * to be (`night.ts`: one moon, no cascades). The term is `pow(dot(-normal, toLight), k)`: strongest
 * where a card faces directly away from the moon, which is the half of the canopy the camera is
 * looking at when the moon is behind it, and zero on the lit side where three's own diffuse already
 * has the answer.
 */
export const FOLIAGE_TRANSLUCENCY_GLSL = /* glsl */ `
#if NUM_DIR_LIGHTS > 0
  {
    vec3 toMoon = directionalLights[0].direction;
    float back = max(0.0, dot(-normal, toMoon));
    reflectedLight.directDiffuse +=
      directionalLights[0].color * pow(back, uTranslucencyPower) * uTranslucency * diffuseColor.rgb;
  }
#endif
`;

/* -------------------------------------------------------------------------- */
/* Patching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The shape of what `onBeforeCompile` is handed, narrowed to the three fields this file writes.
 *
 * Structural rather than three's own `WebGLProgramParametersWithUniforms`, so `foliage.test.ts` can
 * call the patch with a plain object built from `ShaderLib` and check what came out — the parity
 * proof needs to run the patch, not a renderer.
 */
export interface ShaderPatch {
  vertexShader: string;
  fragmentShader: string;
  uniforms: Record<string, { value: unknown }>;
}

/** Everything a foliage material needs that is not shared with every other one. */
export interface FoliageUniforms {
  /** Per-material multiplier on {@link WIND_STRENGTH}. A blade is loose where a bole is stiff. */
  readonly uWindGain: Uniform<number>;
  readonly uTreeHeight: Uniform<number>;
  readonly uCanopyAxis: Uniform<Vector2>;
  readonly uConeSlope: Uniform<number>;
  readonly uTiers: Uniform<number>;
  readonly uDroop: Uniform<number>;
  readonly uBend: Uniform<number>;
  readonly uFade: Uniform<Vector2>;
  readonly uMaskKind: Uniform<number>;
  readonly uMaskCount: Uniform<number>;
  readonly uMaskSpread: Uniform<number>;
  readonly uTranslucency: Uniform<number>;
  readonly uTranslucencyPower: Uniform<number>;
}

export interface FoliageSpec {
  /**
   * The height of the *unscaled geometry*, in its own units — metres for a baked tree, 1 for the unit
   * grass cross. The wind's `h` is `local.y / height`, evaluated before the instance matrix, so this
   * is the number that makes the tip the tip whatever an instance is scaled to.
   */
  readonly height: number;
  /** See {@link FoliageUniforms.uWindGain}. 1 for a tree, higher for anything that should whip. */
  readonly windGain?: number;
  /** Metres from the trunk's foot to the crown's axis. See `treegen.ts`'s `TreeCanopy`. */
  readonly axis?: readonly [number, number];
  readonly coneSlope?: number;
  readonly tiers?: number;
  readonly droop?: number;
  readonly bend?: number;
  readonly fade?: readonly [number, number];
  readonly maskKind?: number;
  readonly maskCount?: number;
  readonly maskSpread?: number;
  readonly translucency?: number;
}

export function createFoliageUniforms(spec: FoliageSpec): FoliageUniforms {
  const axis = spec.axis ?? [0, 0];
  // A fade that starts past the fog's own reach is a fade that never happens, which is what a canopy
  // wants: a tree must not dissolve inside the frame. `1e6` rather than a flag, so the shader has one
  // path.
  const fade = spec.fade ?? [1e6, 1e6 + 1];
  return {
    uWindGain: new Uniform(spec.windGain ?? 1),
    uTreeHeight: new Uniform(spec.height),
    uCanopyAxis: new Uniform(new Vector2(axis[0], axis[1])),
    uConeSlope: new Uniform(spec.coneSlope ?? 4),
    uTiers: new Uniform(spec.tiers ?? 1),
    uDroop: new Uniform(spec.droop ?? 0),
    uBend: new Uniform(spec.bend ?? CANOPY_BEND),
    uFade: new Uniform(new Vector2(fade[0], fade[1])),
    uMaskKind: new Uniform(spec.maskKind ?? MASK_NEEDLE),
    uMaskCount: new Uniform(spec.maskCount ?? 7),
    uMaskSpread: new Uniform(spec.maskSpread ?? 1.15),
    uTranslucency: new Uniform(spec.translucency ?? CANOPY_TRANSLUCENCY),
    uTranslucencyPower: new Uniform(CANOPY_TRANSLUCENCY_POWER),
  };
}

/**
 * The vertex patch, applied identically to the visible material and to the depth material.
 *
 * `bend` is the only asymmetry and it is an *addition*, not a variation: the depth pass is handed
 * `false` because it has no normals, and everything up to and including the displacement is the same
 * text. `foliage.test.ts` asserts that by slicing {@link FOLIAGE_WIND_GLSL} out of both results.
 */
export function patchFoliageVertex(shader: ShaderPatch, bend: boolean): void {
  const declarations = FOLIAGE_VERTEX_DECL + FOLIAGE_WIND_GLSL + (bend ? FOLIAGE_NORMAL_GLSL : '');
  shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${declarations}`);

  if (bend) {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      '#include <beginnormal_vertex>\n  objectNormal = foliageBentNormal(position, objectNormal, aCard.y);',
    );
  }

  // The displacement itself. `instanceMatrix[3].xyz` is the instance's world translation and is the
  // plan's instance-position hash key; the guard is honest rather than defensive — every use of this
  // material in this renderer is an `InstancedMesh`, and a non-instanced one would simply not sway.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    [
      '#include <begin_vertex>',
      '  vFoliageUv = uv;',
      '  vFoliageCard = aCard.x;',
      '  #ifdef USE_INSTANCING',
      '  transformed += foliageWind(position, instanceMatrix[3].xyz, aCard.x);',
      '  #endif',
    ].join('\n'),
  );

  // Distance fade, after `mvPosition` exists. One value per vertex: a 0.55 m tuft does not need it
  // per fragment, and the canopy's fade is switched off by its uniforms anyway.
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    '#include <project_vertex>\n  vFoliageFade = 1.0 - smoothstep(uFade.x, uFade.y, -mvPosition.z);',
  );
}

/**
 * The fragment patch's mask half — again identical between the two materials.
 *
 * A shadow cast by an unmasked card is a shadow cast by a solid quad, which is a black rectangle on
 * the ground under every tree. The clip has to happen in the depth pass too, and it has to be *this*
 * clip.
 */
export function patchFoliageMaskFragment(shader: ShaderPatch): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\n${FOLIAGE_MASK_GLSL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <alphatest_fragment>',
    '  diffuseColor.a *= foliageMask(vFoliageUv, vFoliageCard);\n#include <alphatest_fragment>',
  );
}

/* -------------------------------------------------------------------------- */
/* The materials                                                               */
/* -------------------------------------------------------------------------- */

/** What {@link createFoliageMaterial} hands back: the pair, already wired to one clock. */
export interface FoliagePair {
  readonly material: MeshLambertMaterial;
  /** Assign to `InstancedMesh.customDepthMaterial`. Carries the same wind. See trap 1. */
  readonly depth: MeshDepthMaterial;
  readonly uniforms: FoliageUniforms;
}

/**
 * A canopy or an undergrowth material, and the depth material that shadows for it.
 *
 * `MeshLambertMaterial` rather than §5's `MeshStandardMaterial`, and the reason is the pool's: every
 * other material in this renderer is a Lambert (`pool.ts`), the night rig has one directional light
 * and a hemisphere and no environment map, and a Standard material would buy a specular lobe that a
 * matte needle has no use for at the cost of a second lighting model in the same frame. If a wet
 * canopy in M5b wants a specular response, this is the line to revisit.
 */
export function createFoliageMaterial(
  clock: WindClock,
  spec: FoliageSpec,
  colour: number,
  name: string,
): FoliagePair {
  const uniforms = createFoliageUniforms(spec);
  const material = new MeshLambertMaterial({ color: new Color(colour) });
  material.name = name;
  material.alphaTest = FOLIAGE_ALPHA_TEST;
  material.alphaToCoverage = true;
  // Clip, never blend. See the header.
  material.transparent = false;
  material.side = DoubleSide;
  material.onBeforeCompile = (shader): void => {
    const patch = shader as unknown as ShaderPatch;
    assign(patch.uniforms, clock, uniforms);
    patchFoliageVertex(patch, true);
    patchFoliageMaskFragment(patch);
    patch.fragmentShader = patch.fragmentShader.replace(
      '#include <common>',
      '#include <common>\nuniform float uTranslucency;\nuniform float uTranslucencyPower;',
    );
    // After three's own lighting, so `reflectedLight` and `normal` both exist and the term is added
    // to a finished answer rather than mixed into one.
    patch.fragmentShader = patch.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>\n${FOLIAGE_TRANSLUCENCY_GLSL}`,
    );
  };
  // One key for the whole family: 48 grounds share a program at M4 for the same reason, and every
  // difference between two foliage materials is a uniform.
  material.customProgramCacheKey = (): string => 'foliage';

  return { material, depth: createFoliageDepth(clock, uniforms, `${name}:depth`), uniforms };
}

/**
 * The depth twin. **The whole of trap 1 is that this function exists and shares its arguments.**
 *
 * `RGBADepthPacking` because that is what a `DirectionalLight`'s shadow map uses on WebGL2 without
 * float depth textures, and three's own `_depthMaterial` is configured the same way — a custom depth
 * material that packed differently would render a shadow map the shader could not read.
 */
export function createFoliageDepth(
  clock: WindClock,
  uniforms: FoliageUniforms,
  name: string,
): MeshDepthMaterial {
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.name = name;
  // Overwritten to 0.5 by `getDepthMaterial` every frame because the source material has
  // `alphaToCoverage` — set here anyway so that `USE_ALPHATEST` is on from the first compile and the
  // program does not change shape on frame two. See the header.
  depth.alphaTest = FOLIAGE_ALPHA_TEST;
  depth.side = DoubleSide;
  depth.onBeforeCompile = (shader): void => {
    const patch = shader as unknown as ShaderPatch;
    assign(patch.uniforms, clock, uniforms);
    patchFoliageVertex(patch, false);
    patchFoliageMaskFragment(patch);
  };
  depth.customProgramCacheKey = (): string => 'foliage-depth';
  return depth;
}

/** Copy both uniform records into a shader's own, **by reference**. The parity, mechanically. */
function assign(target: Record<string, { value: unknown }>, clock: WindClock, own: FoliageUniforms): void {
  for (const [key, uniform] of Object.entries(clock)) target[key] = uniform as { value: unknown };
  for (const [key, uniform] of Object.entries(own)) target[key] = uniform as { value: unknown };
}

/* -------------------------------------------------------------------------- */
/* The mirror                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * {@link FOLIAGE_WIND_GLSL} in TypeScript, statement for statement.
 *
 * **This is not what runs.** GLSL is what runs, and no headless test can execute it. What this is for
 * is the other half of the parity proof and the only half a CI machine can check by *evaluating*
 * rather than by comparing text: `foliage.test.ts` drives it from the visible material's uniform
 * objects and again from the depth material's, and asserts the two runs agree at every sample. Since
 * the shader code is byte-identical by construction (one constant, injected twice) and the inputs are
 * the same objects, identical inputs plus identical code is the whole of "the shadow stays attached".
 *
 * It also lets the *shape* of the motion be asserted rather than eyeballed: zero at the foot, bounded
 * by the strength, and different for two trees a metre apart.
 */
export function foliageWindOffset(
  local: readonly [number, number, number],
  origin: readonly [number, number, number],
  card: number,
  clock: WindClock,
  uniforms: Pick<FoliageUniforms, 'uTreeHeight' | 'uWindGain'>,
): readonly [number, number, number] {
  const height = Math.max(uniforms.uTreeHeight.value, 0.001);
  const h = Math.min(1, Math.max(0, local[1] / height));
  const bend = h * h;
  const phase = Math.sin((origin[0] * 0.7371 + origin[2] * 0.4113) * 3.11) * 6.2831853 + card * 6.2831853;
  const t = clock.uTime.value * clock.uWindSpeed.value;
  const gust = Math.sin(t + phase) * 0.75 + Math.sin(t * 2.37 + phase * 1.7) * 0.25;
  const flutter = Math.sin(t * 5.1 + phase * 3.3) * 0.18 * card;
  const amount = (gust + flutter) * clock.uWindStrength.value * uniforms.uWindGain.value * height * bend;
  const swayX = clock.uWindDir.value.x * amount;
  const swayZ = clock.uWindDir.value.y * amount;
  const drop = -Math.abs(swayX) * 0.12 - Math.abs(swayZ) * 0.12;
  const on = clock.uWind.value;
  return [swayX * on, drop * on, swayZ * on];
}
