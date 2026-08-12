/**
 * The night rig — §6-M4's first line, and the one file that decides what the world is lit by.
 *
 * > *"`HemisphereLight` (sky ~`0x163a52`, ground ~`0x0a1a18`, no `AmbientLight`), one moon
 * > `DirectionalLight` with an orthographic shadow camera refitted per frame to the loaded ring
 * > (~40x26 m — which is why you need no cascaded shadow maps at all), `PCFSoftShadowMap`, `FogExp2`
 * > in the night colour…"*
 *
 * Three decisions in that sentence are load-bearing and each is implemented here with its number
 * written down beside it.
 *
 * ## No `AmbientLight`, and why the omission is the point
 *
 * An ambient term adds the same radiance to every surface whatever way it faces, which is exactly the
 * thing that makes a grey-box scene read as grey boxes: the tops, the sides and the shadowed faces all
 * arrive at the same value and the geometry flattens. A `HemisphereLight` costs the same one shader
 * term and instead interpolates sky against ground by the surface normal, so an upward face takes the
 * blue-teal of the sky and a downward one takes the cold ground bounce. That gradient is most of what
 * makes an unlit box look like an object at night, and it is why the plan names the two colours and
 * forbids the third light.
 *
 * ## One shadow camera, refitted, instead of cascades
 *
 * Cascaded shadow maps exist because a 200 m view distance cannot be covered by one orthographic
 * frustum at a usable texel density. This camera cannot see 200 m. At 30 degrees of vertical field,
 * 64 degrees of pitch and {@link rig.CAMERA_DISTANCE} metres back — the authored pose — the visible
 * ground is 41 m across and 22 m deep, so {@link SHADOW_HALF_WIDTH} x {@link SHADOW_HALF_DEPTH}
 * (40 x 26 m with margin) covers every caster that can put a shadow inside the frame, and at 2048 the
 * texel is under two centimetres. Refitting is a dozen dot products a frame; a cascade is three shadow
 * renders and a split-selection branch in every fragment shader.
 *
 * **M6 keeps that and makes it follow the rig.** The camera is no longer fixed: the dolly reaches
 * 48 m at 45 degrees, where the visible ground is 65 x 39 m and a box sized for the authored pose
 * would cut every shadow off in a line across the frame. So the constants above became the
 * *defaults* and {@link shadowExtentsFor} derives the box from the live frame. The plan's parenthesis
 * — *"which is why you need no cascaded shadow maps at all"* — survives the change and is worth
 * restating in its new form: one frustum still suffices because the *clamp* is bounded, not because
 * the camera is still. The worst pose costs 3.4 cm of texel instead of 2.2, and only while the owner
 * is standing in it.
 *
 * ## The fog density is derived from the frame, not chosen
 *
 * See {@link FOG_DENSITY}. What matters for the acceptance is the plan's other clause — *"tuned so the
 * streaming window's edge is never a visible hard line"* — and that is answered by geometry rather
 * than by the fog: the streamer's ring guarantees 40 m of built ground either side and 30 m ahead of
 * the character (`streamer.RING_COVER`), and the widest frame the dolly can produce reaches 32.3 m
 * either side and 24.8 m ahead. **The window's boundary is never inside the frame at all, at any pose
 * in the clamp** (`rig.test.ts` walks all four corners), so the fog is free to be tuned for mood
 * rather than for concealment. It is still a runtime knob, because mood is the owner's call.
 *
 * That separation is load-bearing and M6 is where it would have broken. Leaning on the fog to hide
 * the ring's rim only works at *night*: at 65.6 m of view depth — the far edge of the fully
 * pulled-back frame — {@link FOG_DENSITY} leaves 25% of a surface's own colour showing, but
 * `daylight.DAY_SKY`'s 0.006 leaves **86%**, which hides nothing. So the ring was widened to cover the
 * frame and no distance-coupled term was added to the sky recipes; if one is ever wanted, it belongs
 * in `daylight.ts` beside the rest of the recipe and not here.
 */

import { Color, DirectionalLight, FogExp2, HemisphereLight, PCFSoftShadowMap, Scene } from 'three';

import type { SkyRecipe } from './daylight.ts';
import type { GroundFrame } from './rig.ts';

/* -------------------------------------------------------------------------- */
/* The palette                                                                 */
/* -------------------------------------------------------------------------- */

/** The plan's sky colour, quoted. A cold blue-teal — the hue the whole reference frame lives on. */
export const SKY_COLOUR = 0x163a52;

/** The plan's ground colour. Near-black and *green*-shifted, so a downward face is not merely dark. */
export const GROUND_COLOUR = 0x0a1a18;

/**
 * Fog and background, one colour.
 *
 * Deliberately the same value for both: distant geometry fades to exactly what is behind it, so there
 * is no silhouette line where the world runs out. Darker and slightly greener than {@link SKY_COLOUR}
 * so the hemisphere still reads as a *sky* against it rather than as the same wash.
 */
export const NIGHT_COLOUR = 0x0d2430;

/** Moonlight. Cool but not blue — a blue key over a blue ambient leaves nothing to contrast with. */
export const MOON_COLOUR = 0xc4d3ef;

/**
 * Hemisphere intensity.
 *
 * Reads high for an ambient term and is not: {@link SKY_COLOUR} is 0.008/0.042/0.087 in linear working
 * space, so at 2.2 the brightest thing it can put on an upward-facing 0.4-albedo surface is about
 * 0.024 — roughly a fifth of what the moon puts on a lit one. That ratio *is* the night: shadowed
 * faces keep their hue and lose four fifths of their light.
 */
export const HEMISPHERE_INTENSITY = 2.2;

/** Moon intensity. The key, and the only light in the rig that casts. */
export const MOON_INTENSITY = 1.15;

/**
 * Where the moon is, as a unit vector **from the scene toward the light**.
 *
 * North-west and 41 degrees up, so shadows rake to the south-east — which at this fixed yaw is down
 * and to the right of the frame, toward the camera. Long enough to read (a 3 m wall throws 3.4 m) and
 * never parallel to the up vector, which is what keeps {@link shadowBasis} out of its degenerate case.
 */
export const MOON_FROM = { x: -0.55, y: 0.66, z: -0.51 } as const;

/**
 * Half-extents of the region the shadow camera is fitted to, in metres — the plan's ~40 x 26 m, and
 * since M6 the **default** rather than the only value. See {@link shadowExtentsFor}.
 *
 * Sized from the frame, not from the streaming window: the window is 90 x 60 m, but a caster outside
 * the *frustum* can only matter if its shadow reaches inside it, and at 41 degrees of elevation a
 * 3.6 m barrier throws four metres. {@link SHADOW_PAD} covers that and a little more.
 */
export const SHADOW_HALF_WIDTH = 20;
export const SHADOW_HALF_DEPTH = 13;

/** Vertical half-extent. Ground sits near y=0 and nothing at M4 is taller than 3.6 m. */
export const SHADOW_HALF_HEIGHT = 6;

/** Metres of slack around the fitted box. Absorbs off-frame casters and the terrain's displacement. */
export const SHADOW_PAD = 2.5;

/** How far back along {@link MOON_FROM} the shadow camera sits. Only has to keep `near` positive. */
export const SHADOW_DISTANCE = 60;

/** Texels a side. 2048 over 45 m is a 2.2 cm texel — soft under PCF, not mushy. A runtime knob. */
export const SHADOW_MAP_SIZE = 2048;

/**
 * `FogExp2` density, in reciprocal metres.
 *
 * Derived rather than dialled. The camera sees ground between 33 m (the near edge of the frame) and
 * 43 m (the far edge), so *everything* on screen is far away and the fog has ten metres of range in
 * which to say so. At 0.018 the transmittance is `exp(-(0.018 d)^2)` = **0.70 at 33 m and 0.55 at
 * 43 m**: a quarter of the depth cue lost across the frame, which is aerial perspective you can see,
 * while the foreground keeps seven tenths of its own colour. Push it to 0.03 and the near ground is
 * half fog; drop it to 0.008 and the far treeline stops receding.
 */
export const FOG_DENSITY = 0.018;

/**
 * The half-extents a frame needs, in metres — M6, the same numbers as above at the default pose.
 *
 * The box is axis-aligned and centred on the character, so its half-extents are the *furthest* the
 * frame reaches in each axis: the trapezoid's widest edge, and the greater of how far it sees ahead
 * and behind. Centring it on the character rather than on the frame's own centroid wastes some of it
 * to the south — but it keeps `fitShadowCamera` a function of one point, which is what makes the
 * refit eight dot products, and the waste is 12 m of ground at the shallowest pose.
 *
 * At the default pose this returns 20.4 x 12.3 against the constants' hand-derived 20 x 13, so the
 * default frame's texel density is unchanged; at 48 m and 45 degrees it returns 32.3 x 24.8, which
 * over a 2048 map is a 3.4 cm texel rather than 2.2. That is the honest cost of the wider frame, and
 * it is paid only while the owner is standing in it — which is the whole point of deriving it rather
 * than sizing the constant for the worst case and losing a third of the resolution everywhere.
 */
export function shadowExtentsFor(frame: GroundFrame): { readonly width: number; readonly depth: number } {
  return {
    width: Math.max(frame.halfWidthNear, frame.halfWidthFar),
    depth: Math.max(frame.north, frame.south),
  };
}

/* -------------------------------------------------------------------------- */
/* The shadow fit — pure                                                       */
/* -------------------------------------------------------------------------- */

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An orthographic shadow camera, fully specified. Everything a `DirectionalLight` needs writing. */
export interface ShadowFit {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly near: number;
  readonly far: number;
  /** Where to put the light so that the fit's `near`/`far` mean what they say. */
  readonly position: Point3;
  /** The up vector the light must carry, or `lookAt` builds a different basis than this fit assumed. */
  readonly up: Point3;
}

const WORLD_UP: Point3 = { x: 0, y: 1, z: 0 };
/** Fallback up for a light within half a degree of vertical. Never reached by {@link MOON_FROM}. */
const FALLBACK_UP: Point3 = { x: 0, y: 0, z: 1 };

function dot(a: Point3, b: Point3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Point3, b: Point3): Point3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function normalise(v: Point3): Point3 {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length === 0) return WORLD_UP;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

/**
 * The up vector a light pointing this way must use.
 *
 * `Object3D.lookAt` builds its basis from `this.up`, and a light shining straight down with an up of
 * `(0, 1, 0)` degenerates — the cross product is zero and the shadow camera's orientation depends on
 * which way the last floating-point comparison fell. Same failure as the camera pitch limit in
 * `rig.ts`, and answered the same way: name the case and switch axes before it can happen.
 */
export function shadowUpFor(toLight: Point3): Point3 {
  return Math.abs(dot(normalise(toLight), WORLD_UP)) > 0.999 ? FALLBACK_UP : WORLD_UP;
}

/**
 * Fit an orthographic shadow camera to an axis-aligned box, exactly.
 *
 * The eight corners are projected into the light's own basis and the extents taken from the result —
 * which is the only fit that is correct for an oblique light. Taking the box's half-extents directly
 * would be right for a light straight overhead and progressively too small for a raking one, and the
 * symptom of too small is shadows that vanish at the edge of the frame rather than an error.
 *
 * The basis matches `Object3D.lookAt`'s: `+Z` from the target toward the light, `X = up x Z`,
 * `Y = Z x X`. It has to, or the fit and the camera three actually builds describe different volumes.
 */
export function fitShadowCamera(
  centre: Point3,
  half: { readonly width: number; readonly height: number; readonly depth: number },
  toLight: Point3,
  distance: number,
  pad: number,
): ShadowFit {
  const forward = normalise(toLight);
  const up = shadowUpFor(forward);
  const right = normalise(cross(up, forward));
  const realUp = cross(forward, right);
  const position: Point3 = {
    x: centre.x + forward.x * distance,
    y: centre.y + forward.y * distance,
    z: centre.z + forward.z * distance,
  };

  let left = Infinity;
  let rightMost = -Infinity;
  let bottom = Infinity;
  let top = -Infinity;
  let near = Infinity;
  let far = -Infinity;

  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const p: Point3 = {
          x: centre.x + sx * half.width - position.x,
          y: centre.y + sy * half.height - position.y,
          z: centre.z + sz * half.depth - position.z,
        };
        const u = dot(p, right);
        const v = dot(p, realUp);
        // Depth away from the light. `forward` points *at* the light, so the scene is behind it.
        const w = -dot(p, forward);
        if (u < left) left = u;
        if (u > rightMost) rightMost = u;
        if (v < bottom) bottom = v;
        if (v > top) top = v;
        if (w < near) near = w;
        if (w > far) far = w;
      }
    }
  }

  return {
    left: left - pad,
    right: rightMost + pad,
    bottom: bottom - pad,
    top: top + pad,
    // A shadow camera whose near plane crosses the light is a black frame, so the floor is explicit.
    near: Math.max(0.1, near - pad),
    far: far + pad,
    position,
    up,
  };
}

/* -------------------------------------------------------------------------- */
/* The rig                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The two lights, the fog, and the per-frame refit. Constructed once, disposed once.
 *
 * Nothing here is ever added to or removed from the scene after the constructor — the same discipline
 * `lights.ts` keeps and for the same reason: three compiles a shader permutation per light count, and
 * a light appearing mid-session is a compile in the middle of a frame.
 */
export class NightRig {
  readonly hemisphere: HemisphereLight;
  readonly moon: DirectionalLight;
  readonly fog: FogExp2;
  /** The last fit applied. Read by `__debug3d.moon`; nothing in the renderer reads it back. */
  fit: ShadowFit;

  private readonly scene: Scene;
  private mapSize = SHADOW_MAP_SIZE;
  private colour = NIGHT_COLOUR;
  /**
   * Where the key light stands — M5b.
   *
   * A field rather than the module constant, because the sun moves and the moon does not. It starts
   * at {@link MOON_FROM} and stays there unless {@link sky} is written, so a rig nobody talks to is
   * M4's rig exactly and `night.test.ts`'s assertions about the moon still describe the object it
   * constructs.
   */
  private toLight: Point3 = MOON_FROM;
  /** The last recipe applied, for `__debug3d.sky`. `undefined` means "M4's night, untouched". */
  private recipe: SkyRecipe | undefined;
  /** The last focus point, so a recipe change can re-fit without waiting for the next frame. */
  private centre: Point3 = { x: 0, y: 0, z: 0 };
  /**
   * The half-extents the box is fitted to — M6's live frame, or M4's constants until told otherwise.
   *
   * A field rather than the module constants for the same reason {@link toLight} is one: the camera
   * moves now, and a shadow volume sized for a pose the rig has left is a line across the ground
   * where the shadows stop. `world3d.setCameraFrame` writes it whenever the wheel does.
   */
  private half = { width: SHADOW_HALF_WIDTH, depth: SHADOW_HALF_DEPTH };

  constructor(scene: Scene) {
    this.scene = scene;

    this.fog = new FogExp2(NIGHT_COLOUR, FOG_DENSITY);
    scene.fog = this.fog;
    scene.background = new Color(NIGHT_COLOUR);

    this.hemisphere = new HemisphereLight(SKY_COLOUR, GROUND_COLOUR, HEMISPHERE_INTENSITY);
    scene.add(this.hemisphere);

    this.moon = new DirectionalLight(MOON_COLOUR, MOON_INTENSITY);
    this.moon.castShadow = true;
    this.moon.shadow.mapSize.set(this.mapSize, this.mapSize);
    // Depth bias against a 2 cm texel. `normalBias` does the work — it offsets along the surface
    // normal, which is what peter-panning avoids paying for — and the constant bias only cleans up
    // the grazing case the normal offset cannot reach.
    this.moon.shadow.bias = -0.0004;
    this.moon.shadow.normalBias = 0.03;
    this.moon.up.set(0, 1, 0);
    scene.add(this.moon);
    // The target is a real object in the graph or its world matrix is never updated, and the light
    // then points at the origin whatever we write into it. Three's own documented footgun.
    scene.add(this.moon.target);

    this.fit = this.apply({ x: 0, y: 0, z: 0 });
  }

  /**
   * Re-fit the shadow camera on the frame's focus. Called every frame with the camera's own target.
   *
   * Cheap by construction: eight corners, three dot products each, and a projection matrix rebuild.
   * The alternative — a static world-sized shadow camera — is what forces cascades, and this camera is
   * too tightly bounded to need them.
   */
  refit(x: number, y: number, z: number): void {
    this.centre = { x, y, z };
    this.fit = this.apply(this.centre);
  }

  /**
   * Resize the shadow volume to the frame the camera is now showing — M6. See {@link shadowExtentsFor}.
   *
   * Re-fits immediately rather than waiting for the next frame, on `NightRig.sky`'s reasoning: a
   * volume that changed a frame after the camera did is a frame of shadows cut off at the old edge,
   * and the owner turning the wheel would see it flicker.
   */
  setExtents(halfWidth: number, halfDepth: number): void {
    const width = Math.max(1, halfWidth);
    const depth = Math.max(1, halfDepth);
    if (width === this.half.width && depth === this.half.depth) return;
    this.half = { width, depth };
    this.fit = this.apply(this.centre);
  }

  /** What the volume is currently sized to, in metres. `__debug3d.moonExtents`. */
  get extents(): { readonly width: number; readonly depth: number } {
    return this.half;
  }

  /**
   * The last {@link SkyRecipe} applied, or `undefined` while the rig is still M4's untouched night.
   *
   * `__debug3d.sky`. Nothing in the renderer reads it back; it exists so a human can ask what they
   * are looking at without counting hex digits.
   */
  get sky(): SkyRecipe | undefined {
    return this.recipe;
  }

  /**
   * Apply a whole sky at once — M5b's day/night switch.
   *
   * **One write for the lot, and that is the point.** A hemisphere brightened without its fog, or a
   * sun moved without its shadow re-fit, is a frame that is half past dawn; and the failure mode of
   * eight separate setters is that somebody adds a ninth field and forgets one call site. So the
   * recipe is a value, this is the only thing that consumes it, and the refit happens here rather
   * than waiting for the next frame — the owner pressing **G** should see the shadows swing in the
   * same frame the colours change.
   *
   * `exposure` is deliberately *not* applied here: it belongs to the composer, which this file does
   * not own and must not import (`post.ts` is `main.ts`'s). See `main.ts`'s `applySky`.
   */
  set sky(recipe: SkyRecipe | undefined) {
    if (!recipe) return;
    this.recipe = recipe;
    this.hemisphere.color.setHex(recipe.sky);
    this.hemisphere.groundColor.setHex(recipe.ground);
    this.hemisphere.intensity = recipe.hemisphere;
    this.moon.color.setHex(recipe.sun);
    this.moon.intensity = recipe.sunIntensity;
    this.toLight = recipe.from;
    this.fogDensity = recipe.fogDensity;
    this.nightColour = recipe.fog;
    this.fit = this.apply(this.centre);
  }

  private apply(centre: Point3): ShadowFit {
    const fit = fitShadowCamera(
      centre,
      { width: this.half.width, height: SHADOW_HALF_HEIGHT, depth: this.half.depth },
      this.toLight,
      SHADOW_DISTANCE,
      SHADOW_PAD,
    );
    this.moon.position.set(fit.position.x, fit.position.y, fit.position.z);
    this.moon.up.set(fit.up.x, fit.up.y, fit.up.z);
    this.moon.target.position.set(centre.x, centre.y, centre.z);
    this.moon.target.updateMatrixWorld();

    const camera = this.moon.shadow.camera;
    camera.left = fit.left;
    camera.right = fit.right;
    camera.top = fit.top;
    camera.bottom = fit.bottom;
    camera.near = fit.near;
    camera.far = fit.far;
    camera.updateProjectionMatrix();
    return fit;
  }

  get shadowMapSize(): number {
    return this.mapSize;
  }

  /**
   * Resize the shadow map.
   *
   * The old render target has to be disposed and nulled by hand: `mapSize` is read when the map is
   * *created*, so writing it alone changes the number the debug panel reports and nothing else.
   */
  set shadowMapSize(size: number) {
    const clamped = Math.max(256, Math.min(4096, Math.round(size)));
    if (clamped === this.mapSize) return;
    this.mapSize = clamped;
    this.moon.shadow.mapSize.set(clamped, clamped);
    this.moon.shadow.map?.dispose();
    this.moon.shadow.map = null;
  }

  get fogDensity(): number {
    return this.fog.density;
  }

  set fogDensity(density: number) {
    this.fog.density = Math.max(0, density);
  }

  get nightColour(): number {
    return this.colour;
  }

  /** Fog and background move together, always. See {@link NIGHT_COLOUR} for why they are one value. */
  set nightColour(hex: number) {
    this.colour = hex;
    this.fog.color.setHex(hex);
    if (this.scene.background instanceof Color) this.scene.background.setHex(hex);
    else this.scene.background = new Color(hex);
  }

  dispose(): void {
    this.moon.shadow.map?.dispose();
    this.moon.shadow.map = null;
    this.moon.dispose();
    this.hemisphere.dispose();
  }
}

/** The shadow filter the plan names. Applied to the renderer, which this file does not own. */
export const SHADOW_MAP_TYPE = PCFSoftShadowMap;
