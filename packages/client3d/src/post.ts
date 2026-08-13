/**
 * The grade: tone mapping and selective bloom, on one composer stack. §3 and §5's warning, together.
 *
 * > *"`postprocessing@6.39.4` (pmndrs, Zlib) for the effect chain — **pick this one and do not also
 * > use `UnrealBloomPass` from `three/examples`; they are two different composer stacks and do not
 * > compose**"*
 *
 * There is exactly one composer in this client and it comes from `postprocessing`. Nothing imports
 * anything from `three/examples/jsm/postprocessing`, and nothing should: the two libraries each own
 * `renderer.setRenderTarget` for the duration of a frame and interleaving them produces a black screen
 * with no error anywhere.
 *
 * ## Tone mapping is in the chain, not on the renderer, and both are wired
 *
 * > *"**Tone mapping: do not reflexively reach for `ACESFilmicToneMapping`.** ACES desaturates and
 * > hue-shifts exactly the saturated blue-teal your reference lives on. Try `AgXToneMapping` or
 * > `NeutralToneMapping` … and compare against the reference before committing."*
 *
 * So both are here and switchable at runtime — `__debug3d.toneMapping = 'agx' | 'neutral'`, or the
 * **T** key. **The default is `neutral`**, and the reasoning is the plan's own argument carried one
 * step further. The complaint against ACES is that it desaturates the blue-teal. AgX shares the
 * cause: it is a filmic transform with a long toe and a deliberate path-to-white, and its published
 * behaviour is to *reduce* chroma as it compresses — most visibly in the bottom third of the range,
 * which is where a night scene lives entirely. Khronos PBR Neutral was designed for the opposite
 * requirement: in-gamut colour below the compression knee passes through essentially unchanged, and
 * only highlights are rolled off. For a frame whose subject is a saturated dark hue and whose only
 * bright element is a portal that we *want* to blow out into bloom, Neutral keeps the hue and AgX
 * spends it. That is a judgement about this reference image, not about tone mappers in general, which
 * is why the switch exists and why the owner makes the call with both on screen.
 *
 * `renderer.toneMapping` stays `NoToneMapping` — the materials must hand linear HDR to the composer or
 * the image is tone-mapped twice, once before bloom and once after, and the bloom then blooms
 * already-compressed values. `renderer.toneMappingExposure` is still live and still the exposure
 * control: three sets that uniform on **every** program that declares one, and `ToneMappingEffect`'s
 * shader declares it via `#include <tonemapping_pars_fragment>`.
 *
 * `renderer.outputColorSpace` is left at three's default `SRGBColorSpace`. The final `EffectPass`
 * reads it and converts on the way to the screen; the intermediate buffers are `HalfFloatType` and
 * stay linear, which is the only arrangement in which a threshold of {@link BLOOM_THRESHOLD} means a
 * luminance rather than a gamma-encoded number.
 *
 * ## Selective, by depth equality
 *
 * `SelectiveBloomEffect` renders the depth of the objects in its {@link Grade.glow} selection, then
 * keeps only the pixels of the frame whose depth matches. Two consequences worth knowing before
 * looking at it: a selected object that is *occluded* does not bloom (correct — a portal behind a wall
 * should not glow through it), and the selection is a **layer flag written onto the object**, so a
 * pooled `InstancedMesh` that is recycled for something else must be removed from it. `world3d.ts`
 * does that on release; forgetting would make the ground bloom.
 */

import {
  EffectComposer,
  EffectPass,
  RenderPass,
  SelectiveBloomEffect,
  ToneMappingEffect,
  ToneMappingMode,
  type Selection,
} from 'postprocessing';
import {
  HalfFloatType,
  NoToneMapping,
  PerspectiveCamera,
  SRGBColorSpace,
  type Scene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';

import { SELF_LAYER } from './lights.ts';

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/** The two the plan names. ACES is deliberately absent: it is the one the plan rules out. */
export const TONE_MAPPINGS = ['neutral', 'agx'] as const;

export type ToneMapping = (typeof TONE_MAPPINGS)[number];

/** See the header for the argument. Switchable at runtime precisely because it is a judgement. */
export const DEFAULT_TONE_MAPPING: ToneMapping = 'neutral';

/**
 * Exposure, applied inside the tone mapping shader.
 *
 * Above one because the night rig is honest about being night: the moon puts about 0.11 on a lit
 * mid-albedo surface and the hemisphere about 0.024 on a shadowed one, and Neutral maps 0.11 to
 * roughly a tenth of the display range. 1.6 lifts the lit terrain to a readable low-key value without
 * pulling the shadows off the floor, which is the trade the whole grade turns on.
 */
export const DEFAULT_EXPOSURE = 1.6;

/**
 * Luminance above which the bloom's own threshold pass lets a pixel through.
 *
 * Redundant with the selection — a masked frame contains nothing but the portal — and kept anyway as
 * a second line: if the depth mask ever fails (a driver that resolves multisampled depth differently,
 * say), a threshold at 0.55 means the failure mode is "no bloom" rather than "the whole night glows".
 */
export const BLOOM_THRESHOLD = 0.55;
export const BLOOM_SMOOTHING = 0.15;
export const BLOOM_INTENSITY = 1.9;
export const BLOOM_RADIUS = 0.75;

/**
 * MSAA samples on the composer's own buffers.
 *
 * `WebGLRenderer({ antialias: true })` stops meaning anything the moment the scene renders into a
 * composer target, and at this camera pitch every wall in the world presents a long near-horizontal
 * edge, which is the worst case for aliasing. Four samples is the cheapest setting that removes the
 * crawl on those edges.
 */
export const MULTISAMPLING = 4;

/* -------------------------------------------------------------------------- */
/* The chain                                                                   */
/* -------------------------------------------------------------------------- */

const MODES: Readonly<Record<ToneMapping, ToneMappingMode>> = {
  neutral: ToneMappingMode.NEUTRAL,
  agx: ToneMappingMode.AGX,
};

/* -------------------------------------------------------------------------- */
/* The body pass                                                               */
/* -------------------------------------------------------------------------- */

/**
 * What {@link BodyPass} needs of the light pool, and nothing more.
 *
 * A two-method interface rather than `LightPool` itself, so this file keeps knowing only about the
 * composer: which of the eight slots is the carried one, and why muting it is an intensity rather
 * than a `visible`, are `lights.ts`'s business and are argued there.
 */
export interface CarriedLight {
  /** Zero the light the player is carrying. Called immediately before the body is drawn. */
  muteClearing(): void;
  /** Put it back. Called from a `finally`, whatever the draw did. */
  unmuteClearing(): void;
}

/**
 * The player's own body, drawn on its own, without the light it is carrying — the owner's report of
 * 2026-08-13 answered, and the only shape the answer could take.
 *
 * *"when the player moves he lights up like the light source is around his neck … the player doesn't
 * need to light up at all. just his surroundings depending on his light source."*
 *
 * `lights.ts`'s header has the diagnosis and the proof that no light position fixes it. The short
 * version: three's WebGL renderer assembles **one light list per `renderer.render` call** and lights
 * every object of that call with all of it — `layers` is tested against a camera and never against a
 * light — so excluding one light from one object means two calls. This is the second one.
 *
 * ## It goes **first**, and that is not an accident
 *
 * The body is drawn into the cleared buffer before the world is, and the world pass then runs with
 * `clear` off. The alternative — world first, body second — is one line shorter and quietly wrong:
 * every transparent thing in the frame would already have been composited by the time the body
 * arrived, so rain and snow falling *in front of* the player would be painted over by the player, and
 * another character's nameplate would show through them. Drawing the body first restores the ordering
 * a single pass had: opaque world geometry in front of it wins on depth, and everything transparent
 * blends over it exactly as before. The only thing that changes is that the body is no longer sorted
 * among the opaques, which costs a few overdrawn pixels and nothing else.
 *
 * Being first also makes this the pass that clears the buffer, paints the background and updates the
 * shadow map — three jobs the composer's single `RenderPass` used to do. The world pass gives all
 * three up ({@link Grade}), and the shadow map is the one worth naming: it is a 2048² render over
 * every caster in the ring, and letting both passes update it would double it for nothing.
 *
 * ## The twin camera
 *
 * The camera is a second `PerspectiveCamera` rather than the real one with its `layers` flipped, for
 * a reason that is invisible until it bites. Three refreshes a program's light uniforms when the
 * camera object changes (`WebGLRenderer.setProgram`: *"lighting uniforms depend on the camera so
 * enforce an update"*) or when the GL program changes; with one camera object used twice, neither is
 * guaranteed to fire, and the body would be drawn with the light values left over from the world
 * pass — which is to say, with the collar still on. A distinct object makes the refresh certain.
 *
 * It is synced by {@link syncBodyCamera} every frame rather than by `copy`, because `Object3D.copy`
 * brings `layers` and `matrixWorldAutoUpdate` with it and would need three of its four effects undone.
 */
export class BodyPass extends RenderPass {
  private readonly main: PerspectiveCamera;
  private readonly own: PerspectiveCamera;
  private readonly carried: CarriedLight;

  constructor(scene: Scene, main: PerspectiveCamera, carried: CarriedLight) {
    const own = new PerspectiveCamera();
    // Synced by hand every frame; three must not recompute a world matrix from a local one nobody
    // writes. See {@link syncBodyCamera}.
    own.matrixAutoUpdate = false;
    own.matrixWorldAutoUpdate = false;
    own.layers.set(SELF_LAYER);
    super(scene, own);
    this.main = main;
    this.own = own;
    this.carried = carried;
  }

  /** The camera this pass draws with. Exposed for `__debug3d` and for the test that syncs it by hand. */
  get camera3d(): PerspectiveCamera {
    return this.own;
  }

  override render(
    renderer: WebGLRenderer,
    inputBuffer: WebGLRenderTarget,
    outputBuffer: WebGLRenderTarget,
    deltaTime?: number,
    stencilTest?: boolean,
  ): void {
    syncBodyCamera(this.main, this.own);
    this.carried.muteClearing();
    try {
      super.render(renderer, inputBuffer, outputBuffer, deltaTime, stencilTest);
    } finally {
      // A throw inside a draw costs one frame of a slightly over-lit player, not a world that never
      // lights up again.
      this.carried.unmuteClearing();
    }
  }
}

/**
 * Point the body pass's camera exactly where the real one is pointing.
 *
 * Both matrices are copied outright rather than derived, which is what lets `matrixWorldAutoUpdate`
 * stay off: with it on, three would call `updateMatrixWorld` on an unparented camera and rebuild
 * `matrixWorld` from a *local* matrix nobody has written, putting the body pass at the origin looking
 * north. The scalars come too because the renderer reads `far` for the logarithmic depth term and the
 * frustum culler reads the projection, and a twin that disagreed about either would cull the player
 * out of their own pass at the edge of the frame.
 *
 * `layers` is deliberately not touched: it is the one thing about the twin that must **not** match.
 */
/**
 * The frame's two scene passes, in the order the composer must run them.
 *
 * A function rather than four lines inside {@link Grade}'s constructor because `Grade` needs a live
 * `WebGLRenderer` and these do not, so this is the seam a headless test can reach: the order, and the
 * three responsibilities the world pass hands to the body pass, are the part with consequences.
 *
 * `[0]` is the body, first, into the cleared buffer and with the carried light muted. `[1]` is the
 * world, over it, with its clear, its background and its shadow-map update all off — see
 * {@link BodyPass} for why the body goes first and `lights.SELF_LAYER` for why there are two of these
 * at all.
 */
export function scenePasses(scene: Scene, camera: PerspectiveCamera, carried: CarriedLight): [BodyPass, RenderPass] {
  const body = new BodyPass(scene, camera, carried);
  // The composer blits the depth buffer out to a texture after **every** pass that asks, and a
  // `RenderPass` asks by default. Two of them in a row is two full-screen depth blits a frame for one
  // texture, and the first is overwritten by the second before anything reads it — the `EffectPass`
  // that wants it (the bloom's depth mask) runs after both. So the body pass gives up the blit and
  // the world pass keeps it, which leaves the depth texture holding exactly what one `RenderPass`
  // used to put there: the whole frame, body included.
  body.needsDepthBlit = false;
  const world = new RenderPass(scene, camera);
  world.clear = false;
  // Without this the world pass wipes the body: `WebGLBackground` forces a full clear whenever
  // `scene.background` is a `Color`, which `night.ts` always makes it, and that clear ignores
  // `renderer.autoClear`. `ignoreBackground` nulls the background for the length of the pass, and
  // with the composer holding `autoClear` false the clear then does not happen at all.
  world.ignoreBackground = true;
  // The 2048² shadow map is rendered once a frame, by the body pass. Both passes see the same
  // casters — `night.ts` enables `SELF_LAYER` on the moon's *shadow camera* precisely so that the one
  // object that is not on the world's layer still casts — so the map the body pass built is the whole
  // map, and rebuilding it here would be a second full pass over every caster in the ring.
  world.skipShadowMapUpdate = true;
  return [body, world];
}

export function syncBodyCamera(main: PerspectiveCamera, own: PerspectiveCamera): void {
  own.matrixWorld.copy(main.matrixWorld);
  own.matrixWorldInverse.copy(main.matrixWorldInverse);
  own.projectionMatrix.copy(main.projectionMatrix);
  own.projectionMatrixInverse.copy(main.projectionMatrixInverse);
  own.fov = main.fov;
  own.aspect = main.aspect;
  own.zoom = main.zoom;
  own.near = main.near;
  own.far = main.far;
}

export class Grade {
  readonly composer: EffectComposer;
  /** Objects that bloom. `Selection extends Set<Object3D>`; adding one flags its render layer. */
  readonly glow: Selection;

  /** The player's own body, drawn first and without their own lamp. See {@link BodyPass}. */
  readonly body: BodyPass;

  private readonly renderer: WebGLRenderer;
  private readonly bloom: SelectiveBloomEffect;
  private readonly tone: ToneMappingEffect;
  private mapping: ToneMapping = DEFAULT_TONE_MAPPING;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: PerspectiveCamera, carried: CarriedLight) {
    this.renderer = renderer;
    // The materials must not tone map. See the header — twice-graded bloom is the failure this avoids.
    renderer.toneMapping = NoToneMapping;
    renderer.toneMappingExposure = DEFAULT_EXPOSURE;
    renderer.outputColorSpace = SRGBColorSpace;

    this.composer = new EffectComposer(renderer, {
      // Linear HDR between passes: the whole point of putting the grade last is that everything before
      // it can exceed one, which is what makes an emissive ring bloom instead of clipping.
      frameBufferType: HalfFloatType,
      multisampling: MULTISAMPLING,
    });

    this.bloom = new SelectiveBloomEffect(scene, camera, {
      luminanceThreshold: BLOOM_THRESHOLD,
      luminanceSmoothing: BLOOM_SMOOTHING,
      intensity: BLOOM_INTENSITY,
      radius: BLOOM_RADIUS,
      mipmapBlur: true,
    });
    // The mask keeps the pixels whose scene depth equals the selection's depth. Not inverted: the
    // selection is the thing that glows, not the thing that does not.
    this.bloom.inverted = false;
    this.bloom.ignoreBackground = false;
    this.glow = this.bloom.selection;
    this.tone = new ToneMappingEffect({ mode: MODES[DEFAULT_TONE_MAPPING] });

    // **Two scene passes, and the order is the mechanism** — see {@link scenePasses}, which is where
    // the four properties that make it work are set and argued.
    //
    // Neither pass adds a program: both collect the same ten lights (`night.ts`'s hemisphere and
    // moon, `lights.ts`'s eight), so `NUM_POINT_LIGHTS` and `NUM_DIR_LIGHT_SHADOWS` are identical
    // across them and every material compiles exactly once. `RenderPass` has no shader of its own,
    // and the `ClearPass` the world pass would have used is disabled rather than added.
    const [body, world] = scenePasses(scene, camera, carried);
    this.body = body;
    this.composer.addPass(body);
    this.composer.addPass(world);
    // **One `EffectPass`, two effects.** postprocessing merges the fragment shaders of the effects in
    // a pass into a single program; two passes would be two full-screen draws and two more programs
    // for no gain. Bloom first, grade last: the tone curve must see the light the bloom added.
    this.composer.addPass(new EffectPass(camera, this.bloom, this.tone));
  }

  render(delta: number): void {
    this.composer.render(delta);
  }

  /** Owns the renderer's size too — `EffectComposer.setSize` forwards to it and resizes every target. */
  setSize(width: number, height: number): void {
    this.composer.setSize(width, height, false);
  }

  get toneMapping(): ToneMapping {
    return this.mapping;
  }

  set toneMapping(mode: ToneMapping) {
    if (!TONE_MAPPINGS.includes(mode)) return;
    this.mapping = mode;
    // Changing the mode swaps a `#define`, so the effect pass recompiles — once, on a keypress, which
    // is the only place in this renderer where a compile is allowed to be visible.
    this.tone.mode = MODES[mode];
  }

  /** The other half of the comparison: two tone curves at one exposure say nothing useful. */
  get exposure(): number {
    return this.renderer.toneMappingExposure;
  }

  set exposure(value: number) {
    this.renderer.toneMappingExposure = Math.max(0, value);
  }

  get bloomIntensity(): number {
    return this.bloom.intensity;
  }

  set bloomIntensity(value: number) {
    this.bloom.intensity = Math.max(0, value);
  }

  get bloomThreshold(): number {
    return this.bloom.luminanceMaterial.threshold;
  }

  set bloomThreshold(value: number) {
    this.bloom.luminanceMaterial.threshold = value;
  }

  /** How many objects are currently flagged to bloom. The live check that the wiring reached them. */
  get glowing(): number {
    return this.glow.size;
  }

  /**
   * The escape hatch for the one failure mode of a depth-equality mask: it silently passes nothing.
   *
   * `SelectiveBloomEffect` keeps the pixels whose scene depth equals the selection's depth, and that
   * comparison runs against the composer's resolved depth texture. Resolving depth out of a
   * multisampled buffer is a driver-dependent path, and if it comes back a hair different the mask
   * rejects every pixel — no error, no warning, just a ring that is lit and does not glow.
   *
   * Turning this off leaves the plain `BloomEffect` behind it: `inverted` with an empty selection is
   * precisely the condition under which the effect's own `update` skips the mask, so the fallback is
   * the superclass rather than a second object. What then keeps the whole night from glowing is
   * {@link BLOOM_THRESHOLD} — which is why that value is set as if the mask did not exist.
   *
   * The caller must also stop feeding the selection; `main.ts` does, in the same statement.
   */
  get selective(): boolean {
    return !this.bloom.inverted;
  }

  set selective(on: boolean) {
    this.bloom.inverted = !on;
    if (!on) this.glow.clear();
  }

  dispose(): void {
    this.composer.dispose();
  }
}
