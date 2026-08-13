/**
 * The wall texture — M9, and `blend.ts`'s trick applied to the family that never got it.
 *
 * > *"the rooms should bump right up against the next room so we don't have those bluish looking
 * > voids between rooms"* closed the gap; the owner's next two screenshots were bodies standing
 * > beside the **grey blocks** that closed it — one in a kobold field, one in a city street.
 *
 * M6 dressed interior walls with village modules and suppressed their grey boxes. Everything else —
 * every outdoor `edge`, every city wall, every `barrier` between two rooms you cannot walk between —
 * is still M3's flat `SECTOR_COLOUR.dressing` box. `prototypes.WALL_TEXTURES` argues at length why
 * the answer is a picture on that box rather than a module in front of it; this file is the picture.
 *
 * ## One program, and it is the same reason as the floor's
 *
 * `material.map` sets `USE_MAP`, which is a **`#define`**. A textured city wall and an untextured
 * door are both `plain` materials, so binding a map to one of them would split the family this
 * renderer has kept whole since M3 — and `plain` is the *biggest* family, 74 of the 316 materials.
 * So the map is a `sampler2D` **this patch declares**, which is a uniform, and every plain material
 * emits byte-identical GLSL whether it is bound to a cobble tile or to the white 1x1.
 *
 * Two consequences that follow from that and are easy to get wrong:
 *
 * - **Every plain material takes the patch, not just the walls.** A material with the patch and one
 *   without are two programs again. `uWallGain` is 0 for all but the two wall archetypes and at 0 the
 *   `mix` below returns white, so a door is M3's painted box to the bit.
 * - **`customProgramCacheKey` has to say so.** Three's own key does not know about an
 *   `onBeforeCompile`, so a patched material claiming the default key would take whichever program
 *   compiled first. `pool.programKeyOf` reads the same string, which is what keeps the headless
 *   program count honest against the browser's.
 *
 * ## Dominant-axis world sampling, and why not the geometry's own uv
 *
 * A wall is a `BoxGeometry(1,1,1)` scaled to `(length, height, depth)` — up to 11 m by 3 m by 1 m —
 * so its per-face `uv` is stretched by whatever that room's side happened to measure. The floor
 * solved this by sampling `blend.ts`'s world position; a wall needs the same, in the plane of
 * whichever face is being drawn.
 *
 * So the fragment picks two of the three world axes from the largest component of the face's own
 * world normal: `xz` for a top or bottom, `zy` for an east or west face, `xy` for a north or south
 * one. **One texture fetch**, not a three-tap triplanar blend, because a box's faces are axis-aligned
 * and there is no seam between two of them to blend across — the discontinuity is a 90-degree corner
 * the eye already reads as one.
 *
 * Three things fall out of it, all wanted: the courses run horizontally on every vertical face
 * whatever the wall's yaw; two rooms' walls meeting on the gap's midline share one continuous stone;
 * and nothing calls `fract`, so the derivatives stay continuous and the mip chain works at the fog
 * line.
 *
 * The normal is transformed by the plain model-and-instance matrix rather than by its inverse
 * transpose, and that is exact for what this asks of it: the placements are axis-aligned boxes under
 * a diagonal scale and a yaw, and a diagonal matrix maps a face's dominant axis to itself while a
 * rotation about Y maps x to z and back — which is precisely the choice being made. A correct normal
 * matrix would give the same three-way answer for two more multiplies a vertex.
 */

import { Uniform, Vector3, type Texture } from 'three';

import type { ShaderPatch } from './foliage.ts';
import type { WallTexture } from './prototypes.ts';

/**
 * One plain material's wall texture, as uniforms.
 *
 * Per material rather than shared, for `blend.GroundMapControls`' reason: *which* picture is exactly
 * the thing that varies between two materials in one family. Both are uniforms, so neither costs a
 * program.
 */
export interface WallMapControls {
  readonly uWallMap: Uniform<Texture | null>;
  /** Repeats per metre — `1 / WallTexture.metres`, converted here so the shader multiplies. */
  readonly uWallScale: Uniform<number>;
  readonly uWallGain: Uniform<number>;
  /** The texture's own linear mean, so an average texel multiplies to one. */
  readonly uWallMean: Uniform<Vector3>;
}

export function createWallMapControls(
  spec: WallTexture | undefined,
  placeholder: Texture | null,
): WallMapControls {
  return {
    // Never null in practice: a sampler with nothing bound reads texture unit 0, which is whatever
    // the last draw left there. The pool's white 1x1 is the same trick the kit materials use.
    uWallMap: new Uniform<Texture | null>(placeholder),
    uWallScale: new Uniform(spec ? 1 / spec.metres : 0),
    // Zero until the real texture lands, so a wall never flashes bright while the PNG is in flight —
    // `blend.createGroundMapControls`' own argument, and the reason `pool.dressWalls` raises it.
    uWallGain: new Uniform(0),
    uWallMean: new Uniform(new Vector3(...(spec?.mean ?? [1, 1, 1]))),
  };
}

/* -------------------------------------------------------------------------- */
/* The GLSL                                                                    */
/* -------------------------------------------------------------------------- */

export const WALL_VERTEX_DECL = /* glsl */ `
varying vec3 vWallPos;
varying vec3 vWallNrm;
`;

/**
 * Injected after `<begin_vertex>`, which is where `transformed` is declared — and which three emits
 * *after* `<beginnormal_vertex>`, so `objectNormal` is in scope too. One place, both varyings.
 */
export const WALL_VERTEX_GLSL = /* glsl */ `
  #ifdef USE_INSTANCING
  vWallPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vWallNrm = mat3(modelMatrix * instanceMatrix) * objectNormal;
  #else
  vWallPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vWallNrm = mat3(modelMatrix) * objectNormal;
  #endif
`;

export const WALL_FRAGMENT_DECL = /* glsl */ `
uniform sampler2D uWallMap;
uniform float uWallScale;
uniform float uWallGain;
uniform vec3 uWallMean;
varying vec3 vWallPos;
varying vec3 vWallNrm;
`;

/**
 * The multiply, injected **before** `<color_fragment>` for `blend.BLEND_FRAGMENT_GLSL`'s reason
 * exactly: that chunk is where three folds `instanceColor` in, and `instanceColor` is this
 * renderer's fog of war. Texturing after it would leave a full-brightness stone course inside an
 * unexplored room — a lit wall reaching into a black silhouette. Texturing first means the fog dims
 * the answer rather than half of it.
 *
 * `uWallGain` is 0 on 72 of the 74 plain materials and until the PNG lands, and at 0 the whole block
 * is a multiply by one.
 */
export const WALL_FRAGMENT_GLSL = /* glsl */ `
  {
    vec3 axis = abs(vWallNrm);
    vec2 wallUv = axis.y > max(axis.x, axis.z)
      ? vWallPos.xz
      : (axis.x > axis.z ? vWallPos.zy : vWallPos.xy);
    vec3 course = texture2D(uWallMap, wallUv * uWallScale).rgb / uWallMean;
    diffuseColor.rgb *= mix(vec3(1.0), course, uWallGain);
  }
`;

/** Apply the whole patch to one shader. Exported so `masonry.test.ts` can run it with no renderer. */
export function patchWallTexture(shader: ShaderPatch, map: WallMapControls): void {
  shader.uniforms['uWallMap'] = map.uWallMap as unknown as { value: unknown };
  shader.uniforms['uWallScale'] = map.uWallScale as unknown as { value: unknown };
  shader.uniforms['uWallGain'] = map.uWallGain as unknown as { value: unknown };
  shader.uniforms['uWallMean'] = map.uWallMean as unknown as { value: unknown };

  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\n${WALL_VERTEX_DECL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\n${WALL_VERTEX_GLSL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <common>',
    `#include <common>\n${WALL_FRAGMENT_DECL}`,
  );
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `${WALL_FRAGMENT_GLSL}\n#include <color_fragment>`,
  );
}

/**
 * Which two world axes a face samples on — {@link WALL_FRAGMENT_GLSL}'s pick, in TypeScript.
 *
 * Here for `blend.blendWeightAt`'s reason: the shader cannot run headless, but the *choice* is the
 * part that has to be right, and a test can check that a north wall's face reads `xy` (so its courses
 * run east–west and stack upward), that an east wall's reads `zy`, and that a lid reads `xz`.
 */
export function wallAxisOf(normal: readonly [number, number, number]): 'xy' | 'zy' | 'xz' {
  const [x, y, z] = [Math.abs(normal[0]), Math.abs(normal[1]), Math.abs(normal[2])];
  if (y > Math.max(x, z)) return 'xz';
  return x > z ? 'zy' : 'xy';
}
