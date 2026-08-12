/**
 * Wetness — the other half of §5's *"two things the reference has that no proposal costed properly"*.
 *
 * > *"**wetness** — a roughness drop alone renders as 'slightly darker', not 'wet'. You need a
 * > streaked specular response and instanced puddle decals with the portal reflected as a cheap
 * > approximation, **or the rain will read as animated fog over dry ground within one second**."*
 *
 * M4 shipped the rain and gated it on `roofed`. What it did not ship is any evidence on the ground
 * that it is raining, and that sentence is the reason it matters: six thousand additive streaks in
 * front of dry grass is a screen effect, not weather.
 *
 * ## Three responses, one uniform
 *
 * {@link WetControls.uWet} runs 0..1 and is shared **by reference** by every material that responds
 * to it — the 48 ground materials, the kit's solids, and the puddle decals. One object, one write a
 * frame from `main.ts`, and no possibility of a ground that is wet beside a boulder that is not.
 * (The same discipline `foliage.WindClock` keeps, for the same reason.)
 *
 * 1. **Darker and less scattered.** A wet surface is darker because the water film traps light in it,
 *    so the diffuse is scaled down by {@link WET_DARKEN}. On its own this is exactly the failure the
 *    plan names, which is why it is one of three and not the whole of it.
 * 2. **A streaked specular.** The film is not a mirror, it is a mirror with the ground's own drainage
 *    pattern in it, so the lobe is *anisotropic*: stretched along a world-space direction by
 *    {@link WET_STREAK}, and modulated by a slow analytic field so it breaks into runnels rather than
 *    laying one even sheen over a nine-metre slab. That streak is the thing the eye reads as "wet"
 *    rather than as "dark".
 * 3. **Puddles.** {@link planPuddles} lays a few flat discs on the free tiles of `road` and `city`
 *    rooms — the two sectors that are hard ground with hollows in them, and the two the plan's own
 *    example is set on. They are near-black with a tight specular lobe, which is the cheap
 *    approximation the plan asks for: a puddle is a hole full of sky, and at this camera the sky it
 *    reflects is the moon or the sun and nothing else.
 *
 * ## Why the puddles are placed dry and hidden, rather than placed when it rains
 *
 * A puddle is geometry, and geometry arrives through `world3d.build`. Making its *existence* depend on
 * the weather would mean rebuilding every loaded chunk the moment the rain starts — seventy chunks
 * through the free list in one frame, for a visual change that should cost nothing. So they are
 * planned always and their wrappers' `visible` is toggled once when the wetness crosses zero
 * ({@link World3D.setWetness}). A hidden `InstancedMesh` costs no draw call and no fragment.
 *
 * ## The clock
 *
 * {@link Wetness.update} takes wall-clock seconds, like the rain and the portal pulse, and is exempt
 * from rule 3 by the same argument: nothing reads it back and the server never hears of it. The rise
 * is fast and the dry-off is slow, which is what "while (and shortly after) it rains" means —
 * {@link WET_RISE_SECONDS} to soak and {@link WET_DRY_SECONDS} to dry, so stepping out of a storm
 * leaves the street shining for the best part of a minute.
 */

import { Color, DoubleSide, MeshLambertMaterial, Uniform, Vector2 } from 'three';

import type { Placement } from './chunkPlan.ts';
import type { ShaderPatch, WindClock } from './foliage.ts';
import { METRES_PER_TILE, metresOfTile } from './frame.ts';
import { materialKey } from './prototypes.ts';
import { ROOM_TILES, hashCell, type RoomScene, type Sector } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/** Seconds of rain to go fully wet, and seconds of no rain to go fully dry. */
export const WET_RISE_SECONDS = 6;
export const WET_DRY_SECONDS = 40;

/** How much of its diffuse a fully wet surface keeps. Not far — the streak does the talking. */
export const WET_DARKEN = 0.74;

/** Strength of the wet specular lobe, and how tight it is. */
export const WET_SPECULAR = 0.85;
export const WET_SHININESS = 26;

/**
 * How far the lobe is stretched along the streak direction, and which way that runs in world XZ.
 *
 * Anisotropy is the whole point (see the header): an isotropic lobe on flat ground is a headlight
 * spot that follows the camera, and a stretched one is a wet road.
 */
export const WET_STREAK = 3.4;
export const WET_STREAK_DIR: readonly [number, number] = [0.72, -0.69];

/** Cycles per metre of the runnel field. Coarse: puddling is a property of a yard, not of a pebble. */
export const WET_RUNNEL_FREQUENCY = 0.21;

/** How many puddles a room of hard ground gets, and how wide they are in metres. */
export const PUDDLES_BY_SECTOR: Readonly<Partial<Record<Sector, number>>> = { road: 5, city: 4 };
export const PUDDLE_SIZE: readonly [number, number] = [0.9, 2.6];

/** Millimetres above the ground slab, so a decal never z-fights the thing it lies on. */
export const PUDDLE_LIFT = 0.012;

/** The hard cap, so one room is always one bucket in one wrapper. See `pool.PUDDLE_WRAPPERS`. */
export const PUDDLES_PER_ROOM_MAX = 8;

const SALT_PUDDLE_TILE = 0x5d01;
const SALT_PUDDLE_SIZE = 0x5d02;
const SALT_PUDDLE_JITTER = 0x5d03;
const SALT_PUDDLE_YAW = 0x5d04;
const HASH_RANGE = 0x1_0000_0000;

/* -------------------------------------------------------------------------- */
/* The shared uniform                                                          */
/* -------------------------------------------------------------------------- */

export interface WetControls {
  /** 0..1. Written once a frame by `main.ts` through `World3D.setWetness`. */
  readonly uWet: Uniform<number>;
  readonly uWetSpecular: Uniform<number>;
  readonly uWetStreak: Uniform<number>;
  readonly uWetStreakDir: Uniform<Vector2>;
  readonly uWetDarken: Uniform<number>;
  readonly uRunnel: Uniform<number>;
}

export function createWetControls(): WetControls {
  return {
    uWet: new Uniform(0),
    uWetSpecular: new Uniform(WET_SPECULAR),
    uWetStreak: new Uniform(WET_STREAK),
    uWetStreakDir: new Uniform(new Vector2(WET_STREAK_DIR[0], WET_STREAK_DIR[1])),
    uWetDarken: new Uniform(WET_DARKEN),
    uRunnel: new Uniform(WET_RUNNEL_FREQUENCY),
  };
}

/* -------------------------------------------------------------------------- */
/* The GLSL                                                                    */
/* -------------------------------------------------------------------------- */

export const WET_FRAGMENT_DECL = /* glsl */ `
uniform float uWet;
uniform float uWetSpecular;
uniform float uWetStreak;
uniform vec2 uWetStreakDir;
uniform float uWetDarken;
uniform float uRunnel;
varying vec3 vWetWorld;

/** Where the water pools. Slow, analytic, world-keyed — continuous across a chunk seam. */
float wetRunnel(vec2 p) {
  return sin(p.x * 1.7 + p.y * 0.9) * 0.5 + sin(p.y * 2.3 - p.x * 1.1) * 0.5;
}
`;

export const WET_VERTEX_DECL = /* glsl */ `
varying vec3 vWetWorld;
`;

export const WET_VERTEX_GLSL = /* glsl */ `
  #ifdef USE_INSTANCING
  vWetWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
  vWetWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
`;

/**
 * The wet response, added after three has finished lighting the surface.
 *
 * `WET_GAIN_CONST` is a per-material multiplier baked in at patch time rather than a uniform, because
 * it is the *only* thing that differs between the ground's response and the kit's — a boulder is
 * rounder than a road and takes a weaker sheen — and a `#define` that is constant per family costs no
 * program that the family did not already cost.
 *
 * The anisotropy is done the cheap honest way: the halfway vector is compressed along the streak
 * direction before the lobe is taken, which stretches the highlight perpendicular to it. That is one
 * dot product and one multiply-add more than an isotropic lobe.
 */
export const WET_LIGHT_GLSL = /* glsl */ `
  if (uWet > 0.001) {
    float runnel = wetRunnel(vWetWorld.xz * uRunnel) * 0.5 + 0.5;
    float film = uWet * mix(0.55, 1.0, runnel);
    outgoingLight *= mix(1.0, uWetDarken, film);
    #if NUM_DIR_LIGHTS > 0
      vec3 toSun = directionalLights[0].direction;
      vec3 view = normalize(vViewPosition);
      vec3 halfway = normalize(toSun + view);
      // Squash the halfway vector along the streak: the lobe stretches across it.
      float along = dot(halfway.xz, uWetStreakDir);
      vec3 squashed = normalize(halfway - vec3(uWetStreakDir.x, 0.0, uWetStreakDir.y)
        * along * (1.0 - 1.0 / max(uWetStreak, 1.0)));
      float lobe = pow(max(dot(normal, squashed), 0.0), float(WET_SHININESS_CONST));
      outgoingLight += directionalLights[0].color * lobe * uWetSpecular * film * float(WET_GAIN_CONST);
    #endif
  }
`;

/**
 * Apply the wet response to one shader. Ground and kit solids alike.
 *
 * Exported so `wetness.test.ts` can run it without a renderer, and so `pool.ts` can hand the *same*
 * {@link WetControls} object to every material it patches — which is the mechanism, not a
 * convenience: two sets of uniforms would be two states of the weather in one frame.
 */
export function patchWetGround(shader: ShaderPatch, controls: WetControls, gain = 1): void {
  for (const [key, uniform] of Object.entries(controls)) {
    shader.uniforms[key] = uniform as { value: unknown };
  }
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\n${WET_VERTEX_DECL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <project_vertex>',
    `#include <project_vertex>\n${WET_VERTEX_GLSL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\n#define WET_SHININESS_CONST ${WET_SHININESS}\n` +
      `#define WET_GAIN_CONST ${gain.toFixed(3)}\n${WET_FRAGMENT_DECL}`,
  );
  // After `<opaque_fragment>`, which is where `outgoingLight` is assembled from the reflected light
  // and the emissive. Adding before it would be adding to a value that is about to be overwritten.
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <opaque_fragment>',
    `${WET_LIGHT_GLSL}\n#include <opaque_fragment>`,
  );
}

/* -------------------------------------------------------------------------- */
/* The puddle material                                                         */
/* -------------------------------------------------------------------------- */

export const PUDDLE_FRAGMENT_DECL = /* glsl */ `
uniform float uTime;
uniform float uWet;
uniform float uWetSpecular;
varying vec2 vPuddleUv;
`;

export const PUDDLE_VERTEX_DECL = /* glsl */ `
varying vec2 vPuddleUv;
`;

/**
 * A puddle: an elliptical hole in the ground with the sky in it.
 *
 * The disc is cut out of the quad by distance from its centre rather than by a texture, with a soft
 * edge that widens as the puddle dries — a drying puddle shrinks from its rim inward, which is one
 * `smoothstep` and reads correctly. Opacity follows `uWet` directly, so a puddle is simply not there
 * on a dry day even before `world3d.ts` hides its wrapper.
 */
export const PUDDLE_FRAGMENT_GLSL = /* glsl */ `
  {
    vec2 d = vPuddleUv - 0.5;
    float r = length(d) * 2.0;
    // Dries from the rim inward: at uWet = 1 the disc fills the quad, at 0.2 it is a damp centre.
    float edge = mix(0.25, 1.0, clamp(uWet, 0.0, 1.0));
    float disc = 1.0 - smoothstep(edge * 0.72, edge, r);
    if (disc < 0.01) discard;
    #if NUM_DIR_LIGHTS > 0
      vec3 toSun = directionalLights[0].direction;
      vec3 halfway = normalize(toSun + normalize(vViewPosition));
      float lobe = pow(max(dot(normal, halfway), 0.0), 96.0);
      outgoingLight += directionalLights[0].color * lobe * uWetSpecular * 2.4;
      // A dim wide term so the puddle is not black where the lobe misses it: the hemisphere in it.
      outgoingLight += directionalLights[0].color * pow(max(dot(normal, halfway), 0.0), 6.0) * 0.12;
    #endif
    diffuseColor.a *= disc * clamp(uWet, 0.0, 1.0) * 0.85;
  }
`;

/**
 * The puddle decal material. Transparent, no depth write, no shadow — see `ARCHETYPE_CASTS`.
 *
 * `clock` is taken and its `uTime` bound even though the fragment shader does not read it today: the
 * uniform is declared, three drops what the linked program does not keep, and a raindrop-ripple pass
 * is the obvious next thing to want here. Declaring it now costs nothing and keeps the puddle on the
 * one shared clock rather than tempting a second.
 */
export function createPuddleMaterial(
  clock: WindClock,
  controls: WetControls,
  colour: number,
  name: string,
): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ color: new Color(colour) });
  material.name = name;
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
  material.onBeforeCompile = (shader): void => {
    const patch = shader as unknown as ShaderPatch;
    patch.uniforms['uTime'] = clock.uTime as unknown as { value: unknown };
    patch.uniforms['uWet'] = controls.uWet as unknown as { value: unknown };
    patch.uniforms['uWetSpecular'] = controls.uWetSpecular as unknown as { value: unknown };
    patch.vertexShader = patch.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${PUDDLE_VERTEX_DECL}`,
    );
    patch.vertexShader = patch.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vPuddleUv = position.xz + 0.5;',
    );
    patch.fragmentShader = patch.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${PUDDLE_FRAGMENT_DECL}`,
    );
    patch.fragmentShader = patch.fragmentShader.replace(
      '#include <opaque_fragment>',
      `${PUDDLE_FRAGMENT_GLSL}\n#include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = (): string => 'puddle';
  return material;
}

/* -------------------------------------------------------------------------- */
/* The wetness clock                                                           */
/* -------------------------------------------------------------------------- */

/**
 * How wet the world is, and how fast that changes. Held here rather than in `main.ts` so the ramp is
 * testable without a frame loop.
 */
export class Wetness {
  private wet = 0;
  private last: number | undefined;

  get value(): number {
    return this.wet;
  }

  /** For a test, or for `__debug3d.wetness = 1` when the owner wants to see it without waiting. */
  set value(next: number) {
    this.wet = Math.min(1, Math.max(0, next));
  }

  /**
   * Advance on wall-clock seconds.
   *
   * The delta is clamped at a quarter-second for the reason `main.ts` clamps the frame's: a tab that
   * slept for a minute must not soak or dry the whole world in one step, because the whole point of
   * the ramp is that it is visible.
   */
  update(seconds: number, raining: boolean): number {
    const previous = this.last ?? seconds;
    this.last = seconds;
    const delta = Math.min(Math.max(seconds - previous, 0), 0.25);
    const rate = raining ? 1 / WET_RISE_SECONDS : -1 / WET_DRY_SECONDS;
    this.wet = Math.min(1, Math.max(0, this.wet + rate * delta));
    return this.wet;
  }
}

/* -------------------------------------------------------------------------- */
/* Placement — pure                                                            */
/* -------------------------------------------------------------------------- */

export interface PuddleInput {
  readonly scene: RoomScene;
  readonly origin: { readonly tx: number; readonly ty: number };
  readonly elevation: number;
  /** The tiles nothing may stand on. `scatter.freeTiles`'s answer, passed in so it is computed once. */
  readonly free: readonly number[];
}

/**
 * A few puddles on hard ground.
 *
 * Roofed rooms get none, and the reason is the one M4 already settled for the rain: weather is gated
 * on the roof, so a covered street is dry and a puddle under a roof would be the rain's own gate
 * contradicted by a decal. Everything else follows `scatter.ts`'s discipline exactly — free tiles
 * only, so a puddle never lands on the arrival ring or the centre cross where it would read as
 * something to walk round.
 */
export function planPuddles(input: PuddleInput): readonly Placement[] {
  const { scene, origin, elevation, free } = input;
  if (scene.enclosure.roofed) return [];
  const wanted = Math.min(PUDDLES_BY_SECTOR[scene.biome.sector] ?? 0, PUDDLES_PER_ROOM_MAX);
  if (wanted === 0 || free.length === 0) return [];

  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const material = materialKey('puddle', undefined, false);
  const out: Placement[] = [];
  for (let i = 0; i < wanted; i++) {
    const tile = free[Math.floor(roll(scene.seed, SALT_PUDDLE_TILE, i) * free.length)]!;
    const tx = tile % ROOM_TILES;
    const ty = Math.floor(tile / ROOM_TILES);
    const size = PUDDLE_SIZE[0] + roll(scene.seed, SALT_PUDDLE_SIZE, i) * (PUDDLE_SIZE[1] - PUDDLE_SIZE[0]);
    out.push({
      archetype: 'puddle',
      geometry: 'waterPlane',
      material,
      x: x0 + metresOfTile(tx) + roll(scene.seed, SALT_PUDDLE_JITTER, i * 2) * METRES_PER_TILE,
      y: elevation + PUDDLE_LIFT,
      z: z0 + metresOfTile(ty) + roll(scene.seed, SALT_PUDDLE_JITTER, i * 2 + 1) * METRES_PER_TILE,
      sx: size,
      sy: 1,
      // Elliptical rather than round, and rotated: a puddle that is a perfect circle reads as a
      // decal, which is what it is and what it must not look like.
      sz: size * (0.6 + roll(scene.seed, SALT_PUDDLE_SIZE, 64 + i) * 0.7),
      rx: 0,
      ry: roll(scene.seed, SALT_PUDDLE_YAW, i) * Math.PI * 2,
      rz: 0,
    });
  }
  return out;
}

/** One decision, in `[0, 1)`. `scatter.ts`'s own helper, restated where it is used. */
function roll(seed: number, salt: number, index: number): number {
  return hashCell(salt, index, 0, seed) / HASH_RANGE;
}
