/**
 * Water — §5's *"the top-left lake with a shoreline transition"*, and the sentence that says what it
 * must not be.
 *
 * > *"**water** — the top-left lake with a shoreline transition is a real water surface with depth
 * > fade and a foam line, **not a blue plane** and not a vertex blend of two ground materials.
 * > Budget both as explicit work in M5."*
 *
 * ## One surface per chunk, because that is what the IR already knows
 *
 * `shallow_water`, `deep_water` and `underwater` are real sectors in `SECTORS`, carried per room by
 * M1's repaired inference. So the water is not a mesh somebody authors and not a heightfield the
 * renderer discovers: it is **one quad over every water room**, sized to the room block plus half the
 * gap on each side, exactly as `chunkPlan.ts`'s ground slab and mouth strips are. Two adjacent water
 * rooms therefore tile with no overlap to z-fight and no seam to see, and a lake is however many
 * rooms the MUD said were wet.
 *
 * A whole-world mesh was the alternative and is wrong for the same reason a whole-world `InstancedMesh`
 * is wrong in `world3d.ts`: it can never be frustum-culled, it cannot be streamed, and it would have
 * to exist before the streamer knows which rooms are loaded.
 *
 * ## Three things make it water rather than a blue plane
 *
 * 1. **Depth fade.** The surface sits {@link WATER_DEPTH} metres above the room's own ground, and the
 *    shader mixes the shallow colour toward {@link prototypes.WATER_DEEP_COLOUR} — and the opacity up
 *    — by that depth. A shallow ford is nearly clear and you see the ground slab through it; a deep
 *    lake is opaque and reads as volume. The depth is per instance (`iTint.x`), so one material serves
 *    the ford and the lake.
 * 2. **A foam line where water meets land.** Per-instance again, and this is the part the corner
 *    attribute was already the right shape for: {@link waterFoamOf} asks the IR which of the room's
 *    four sides has land on the other side, folds those four edge weights onto the quad's four
 *    corners exactly as `chunkPlan.groundBlendOf` does, and the shader draws a band where the
 *    interpolated value crosses the foam threshold. The band is displaced by the same wave field that
 *    moves the normal, so it breaks and re-forms instead of being a ring.
 * 3. **A scrolling wave normal.** Two analytic gradient fields at different speeds and scales,
 *    summed, perturbing the shading normal — and a Blinn-ish specular lobe added on top of Lambert's
 *    diffuse, because *water is a specular material* and a matte blue quad is the blue plane the plan
 *    forbids. Analytic rather than a normal map: no texture to fetch, continuous across chunk seams
 *    because it reads world position, and one more thing the compression slice does not have to carry.
 *
 * ## The clock, and the determinism rule
 *
 * The scroll reads `uTime` off `pool.wind` — **the same clock the foliage sways on**, not a second
 * one. Wall-clock, like the rain and the portal pulse, and exempt from rule 3 by the same argument
 * those are: nothing reads it back, no gameplay value derives from it, and two clients at one lake
 * should see one set of waves. Sharing the object rather than adding a second is the discipline
 * `foliage.ts`'s trap 1 is built on, applied where it costs nothing to keep.
 */

import { Color, DoubleSide, MeshLambertMaterial, Uniform, Vector2, Vector3 } from 'three';

import type { ShaderPatch, WindClock } from './foliage.ts';
import { ROOM_METRES, metresOfTile } from './frame.ts';
import type { Placement } from './chunkPlan.ts';
import { WATER_DEEP_COLOUR, WATER_FOAM_COLOUR, linearRgb, materialKey } from './prototypes.ts';
import { CARDINALS, hashCell, type Cardinal, type RoomScene, type Sector } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* Which sectors are wet, and how deep                                         */
/* -------------------------------------------------------------------------- */

/**
 * The three sectors that get a surface, and how far above the room's ground it sits, in metres.
 *
 * Settled on the tilemap's own list rather than guessed: `shallow_water`, `deep_water` and
 * `underwater` are the water entries in `SECTORS` and there are no others.
 *
 * The numbers are read from the character's point of view, because that is the only place they are
 * ever judged from. `shallow_water` is a ford: 35 cm, mid-shin on the 1.8 m capsule, and the ground
 * under it is clearly visible. `deep_water` is 1.4 m — chest-deep, which is as far as a surface can
 * rise before a swimming character's head is inside it. `underwater` is the odd one and is the
 * honest reading of the sector: the room *is* the sea floor, so the surface is four metres up and
 * seen from below, as a lid.
 */
export const WATER_DEPTH: Readonly<Partial<Record<Sector, number>>> = {
  shallow_water: 0.35,
  deep_water: 1.4,
  underwater: 4,
};

export const WATER_SECTORS: ReadonlySet<Sector> = new Set(
  Object.keys(WATER_DEPTH) as Sector[],
);

/** Whether a sector gets a surface at all. */
export function isWater(sector: Sector): boolean {
  return WATER_SECTORS.has(sector);
}

/** The depth the fade saturates at. Past this the surface is as opaque and as dark as it gets. */
export const WATER_MAX_DEPTH = 2.2;

/** Alpha at the shore and at {@link WATER_MAX_DEPTH}. A ford you can see through; a lake you cannot. */
export const WATER_ALPHA: readonly [number, number] = [0.42, 0.9];

/** How wide the foam band is, in corner-weight units. Wider than a line, narrower than a shore. */
export const FOAM_WIDTH = 0.34;

/** Metres per cycle of the two wave fields, and how fast each scrolls. */
export const WAVE_SCALE: readonly [number, number] = [0.55, 1.7];
export const WAVE_SPEED: readonly [number, number] = [0.28, 0.61];

/** How far the wave normal tips, and how tight the specular lobe on it is. */
export const WAVE_STEEPNESS = 0.55;
export const WATER_SHININESS = 42;
export const WATER_SPECULAR = 1.35;

/** Salt for the per-room wave phase, so two neighbouring lakes are not one sheet. */
const SALT_WAVE_PHASE = 0x7a7e;
const HASH_RANGE = 0x1_0000_0000;

/* -------------------------------------------------------------------------- */
/* The shared knobs                                                            */
/* -------------------------------------------------------------------------- */

/** One object for every water material in the scene. Same pattern as `foliage.WindClock`. */
export interface WaterControls {
  readonly uWaveScale: Uniform<number>;
  readonly uWaveSpeed: Uniform<number>;
  readonly uWaveSteepness: Uniform<number>;
  readonly uFoamWidth: Uniform<number>;
  readonly uMaxDepth: Uniform<number>;
  readonly uSpecular: Uniform<number>;
}

export function createWaterControls(): WaterControls {
  return {
    uWaveScale: new Uniform(WAVE_SCALE[0]),
    uWaveSpeed: new Uniform(WAVE_SPEED[0]),
    uWaveSteepness: new Uniform(WAVE_STEEPNESS),
    uFoamWidth: new Uniform(FOAM_WIDTH),
    uMaxDepth: new Uniform(WATER_MAX_DEPTH),
    uSpecular: new Uniform(WATER_SPECULAR),
  };
}

/* -------------------------------------------------------------------------- */
/* The GLSL                                                                    */
/* -------------------------------------------------------------------------- */

export const WATER_VERTEX_DECL = /* glsl */ `
attribute vec4 iBlend;
attribute vec4 iTint;
varying float vShore;
varying float vDepth;
varying float vPhase;
varying vec2 vWorldXZ;
`;

/**
 * The per-vertex half: fold the four corners onto this vertex, and hand the fragment shader a world
 * position to sample the waves at.
 *
 * `position.xz + 0.5` is the unit plane's own `(u, v)` — the same expression `blend.ts` uses over the
 * ground's top face, and for the same reason: the quad has four vertices, so any field over it is
 * bilinear whatever the shader pretends, and interpolating the corner values is the honest version of
 * that.
 */
export const WATER_VERTEX_GLSL = /* glsl */ `
  vec2 waterUv = position.xz + 0.5;
  vShore = mix(mix(iBlend.x, iBlend.y, waterUv.x), mix(iBlend.w, iBlend.z, waterUv.x), waterUv.y);
  vDepth = iTint.x;
  vPhase = iTint.y;
  #ifdef USE_INSTANCING
  vWorldXZ = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xz;
  #else
  vWorldXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
  #endif
`;

export const WATER_FRAGMENT_DECL = /* glsl */ `
uniform float uTime;
uniform float uWaveScale;
uniform float uWaveSpeed;
uniform float uWaveSteepness;
uniform float uFoamWidth;
uniform float uMaxDepth;
uniform float uSpecular;
uniform vec3 uDeepColour;
uniform vec3 uFoamColour;
uniform vec2 uAlpha;
varying float vShore;
varying float vDepth;
varying float vPhase;
varying vec2 vWorldXZ;

/**
 * Height of the wave field at a point, and its gradient — two octaves crossing at an angle so the
 * pattern never resolves into rows. Continuous across a chunk seam because it reads world position
 * and nothing else, which is the property \`noise.ts\` and \`blend.ts\` both rely on.
 */
vec3 waterWave(vec2 p, float t) {
  vec2 a = p * uWaveScale + vec2(t * uWaveSpeed, t * uWaveSpeed * 0.61);
  vec2 b = p * uWaveScale * 2.7 - vec2(t * uWaveSpeed * 1.9, t * uWaveSpeed * 0.83);
  float h = sin(a.x + a.y * 0.71) * 0.6 + sin(b.x * 0.83 - b.y) * 0.4;
  float dx = cos(a.x + a.y * 0.71) * 0.6 * uWaveScale
           + cos(b.x * 0.83 - b.y) * 0.4 * uWaveScale * 2.7 * 0.83;
  float dz = cos(a.x + a.y * 0.71) * 0.6 * uWaveScale * 0.71
           - cos(b.x * 0.83 - b.y) * 0.4 * uWaveScale * 2.7;
  return vec3(h, dx, dz);
}
`;

/**
 * The colour half. Injected before `<color_fragment>` for `blend.ts`'s reason — the fog-of-war
 * `instanceColor` multiply happens there and must dim the finished answer rather than half of it.
 */
export const WATER_COLOUR_GLSL = /* glsl */ `
  {
    float depth = clamp(vDepth / max(uMaxDepth, 0.001), 0.0, 1.0);
    diffuseColor.rgb = mix(diffuseColor.rgb, uDeepColour, depth);
    diffuseColor.a = mix(uAlpha.x, uAlpha.y, depth);
  }
`;

/**
 * The lit half: tip the normal onto the wave, add a specular lobe, and lay the foam over the top.
 *
 * **Injected immediately before `<opaque_fragment>`, and that position is load-bearing twice over.**
 * `outgoingLight` does not exist until three has assembled it four lines earlier, so an injection at
 * `<lights_fragment_end>` — where `foliage.ts`'s translucency correctly goes — would not compile
 * here. And a Lambert's `outgoingLight` is `directDiffuse + indirectDiffuse + emissive` and reads
 * **nothing** from `reflectedLight.directSpecular`, so a specular term added to that struct would be
 * computed, uploaded and thrown away. The lobe is therefore added to `outgoingLight` by hand.
 *
 * Blinn-Phong by hand rather than a `MeshPhysicalMaterial` because these are Lambert materials by
 * pool policy (see `foliage.ts`'s note on why `MeshStandardMaterial` was not adopted): a second
 * lighting model in the same frame for one surface is not a trade worth making, and water's specular
 * is a single lobe rather than a BRDF.
 *
 * The foam is a `smoothstep` over the shore weight **displaced by the wave height**, so the line
 * ripples along the shore instead of tracing the room block's outline. That displacement is the whole
 * difference between "a foam line" and "a white border".
 */
export const WATER_LIGHT_GLSL = /* glsl */ `
  {
    vec3 wave = waterWave(vWorldXZ, uTime + vPhase * 31.4);
    vec3 rippled = normalize(normal + vec3(-wave.y, 0.0, -wave.z) * uWaveSteepness);
    #if NUM_DIR_LIGHTS > 0
      vec3 toSun = directionalLights[0].direction;
      vec3 halfway = normalize(toSun + normalize(vViewPosition));
      float lobe = pow(max(dot(rippled, halfway), 0.0), float(WATER_SHININESS_CONST));
      outgoingLight += directionalLights[0].color * lobe * uSpecular;
    #endif
    // The shore. \`vShore\` is 1 against a land edge and 0 out in open water.
    float crest = wave.x * 0.5 + 0.5;
    float band = vShore + (crest - 0.5) * uFoamWidth * 0.9;
    float foam = smoothstep(1.0 - uFoamWidth, 1.0 - uFoamWidth * 0.25, band);
    outgoingLight = mix(outgoingLight, uFoamColour, foam * 0.85);
    diffuseColor.a = max(diffuseColor.a, foam * 0.95);
  }
`;

/* -------------------------------------------------------------------------- */
/* The material                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One material for every water surface in the world. One program.
 *
 * `transparent` and `depthWrite: false`: a surface you cannot see through is not water, and a
 * transparent surface that writes depth hides whatever is drawn after it — including the *next* water
 * chunk, which at a 64 degree camera is most of the lake. It still tests depth, so a boulder standing
 * in the shallows occludes the water in front of it.
 *
 * `DoubleSide` because `underwater` rooms are seen from below: the surface is a lid four metres up
 * and a single-sided quad would simply not be there.
 */
export function createWaterMaterial(
  clock: WindClock,
  controls: WaterControls,
  colour: number,
  name: string,
): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color: new Color(colour) });
  material.name = name;
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.onBeforeCompile = (shader): void => {
    patchWater(shader as unknown as ShaderPatch, clock, controls);
  };
  material.customProgramCacheKey = (): string => 'water';
  return material;
}

/** Apply the whole patch to one shader. Exported so `water.test.ts` can run it without a renderer. */
export function patchWater(shader: ShaderPatch, clock: WindClock, controls: WaterControls): void {
  // The wind clock, **by reference** — one `uTime` for the leaves and the lake. See the header.
  shader.uniforms['uTime'] = clock.uTime as unknown as { value: unknown };
  for (const [key, uniform] of Object.entries(controls)) {
    shader.uniforms[key] = uniform as { value: unknown };
  }
  const deep = linearRgb(WATER_DEEP_COLOUR);
  const foam = linearRgb(WATER_FOAM_COLOUR);
  // `Vector3`/`Vector2` rather than plain records: three's `WebGLUniforms` dispatches on the shape of
  // the value, and a bare `{x,y,z}` happens to work today by an implementation detail nobody promised.
  shader.uniforms['uDeepColour'] = { value: new Vector3(deep[0], deep[1], deep[2]) };
  shader.uniforms['uFoamColour'] = { value: new Vector3(foam[0], foam[1], foam[2]) };
  shader.uniforms['uAlpha'] = { value: new Vector2(WATER_ALPHA[0], WATER_ALPHA[1]) };

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\n${WATER_VERTEX_DECL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\n${WATER_VERTEX_GLSL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\n#define WATER_SHININESS_CONST ${WATER_SHININESS}\n${WATER_FRAGMENT_DECL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `${WATER_COLOUR_GLSL}\n#include <color_fragment>`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    `${WATER_LIGHT_GLSL}\n#include <opaque_fragment>`,
  );
}

/* -------------------------------------------------------------------------- */
/* Placement — pure                                                            */
/* -------------------------------------------------------------------------- */

export interface WaterInput {
  readonly scene: RoomScene;
  readonly origin: { readonly tx: number; readonly ty: number };
  readonly elevation: number;
  /** Tiles between room blocks. The surface covers the block plus half the gap on every side. */
  readonly gap: number;
}

/**
 * Which of the room's four sides has land behind it, as a weight in `[0, 1]`.
 *
 * The IR already answers this and it answers it *twice*, which is the useful part:
 *
 * - `scene.edges[dir].kind` is `edge` or `barrier` when there is nothing walkable across that
 *   boundary at all — the outer rim of the region, and as hard a shore as exists.
 * - `scene.biome.blend` carries *"one entry per crossable edge whose far ground differs"*, so a lake
 *   room whose neighbour is a field has an entry naming that field. A neighbour that is also water
 *   produces no entry, which is exactly the answer wanted: open water has no foam in the middle of it.
 *
 * The weight is 1 for a hard rim and the blend's own weight (scaled) for a crossable shore, so a
 * three-tile beach foams less than a whole shared edge. Roofed water — an indoor cistern — foams on
 * every side, because a wall *is* a shore.
 */
export function waterFoamOf(scene: RoomScene): {
  readonly corners: readonly [number, number, number, number];
  readonly edges: Readonly<Partial<Record<Cardinal, number>>>;
} {
  const edges: { -readonly [K in Cardinal]?: number } = {};
  for (const dir of CARDINALS) {
    const edge = scene.edges[dir];
    if (edge.kind === 'edge' || edge.kind === 'barrier') {
      edges[dir] = 1;
      continue;
    }
    // A crossing whose far ground is dry land. `blend` only lists the ones that differ, which is the
    // question being asked, so a water-to-water crossing is silently and correctly absent.
    const entry = scene.biome.blend.find((candidate) => candidate.dir === dir);
    if (entry && !isWater(entry.sector)) edges[dir] = Math.min(1, entry.weight * 2);
    // `sector` on the edge itself covers the case `blend` cannot: a seam whose far zone is loaded.
    else if (!entry && edge.sector !== undefined && !isWater(edge.sector)) edges[dir] = 0.6;
  }
  const n = edges.north ?? 0;
  const e = edges.east ?? 0;
  const s = edges.south ?? 0;
  const w = edges.west ?? 0;
  // `(u,v) = (position.x + 0.5, position.z + 0.5)`: +x is east and +z is south, so (0,0) is the
  // north-west corner and the winding runs NW, NE, SE, SW. `chunkPlan.groundBlendOf`'s fold exactly.
  return { corners: [Math.max(n, w), Math.max(n, e), Math.max(s, e), Math.max(s, w)], edges };
}

/**
 * The room's water surface, or nothing.
 *
 * Pure, like `chunkPlan.ts` and `scatter.ts` beside it and for the same reason: a `Placement` is a
 * handful of numbers, so `water.test.ts` can sweep every room in the built world and assert that the
 * surface is over water, above the ground, and foaming only where there is a shore — without a GPU.
 */
export function planWater(input: WaterInput): Placement | undefined {
  const { scene, origin, elevation, gap } = input;
  const sector = scene.biome.sector;
  const depth = WATER_DEPTH[sector];
  if (depth === undefined) return undefined;

  const span = ROOM_METRES + gap;
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const foam = waterFoamOf(scene);
  const phase = hashCell(scene.seed, 0, 0, SALT_WAVE_PHASE) / HASH_RANGE;

  return {
    archetype: 'water',
    geometry: 'waterPlane',
    material: materialKey('water', undefined, false),
    x: x0 + ROOM_METRES / 2,
    y: elevation + depth,
    z: z0 + ROOM_METRES / 2,
    sx: span,
    sy: 1,
    sz: span,
    rx: 0,
    ry: 0,
    rz: 0,
    blend: foam.corners,
    // `(depth, phase, -, -)`. The other two floats are the ground blend's colour channels and mean
    // nothing here; a water wrapper reads only `.x` and `.y`. See `pool.writeBlend`.
    tint: [depth, phase, 0, 0],
  };
}
