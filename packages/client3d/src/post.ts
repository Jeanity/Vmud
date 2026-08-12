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
import { HalfFloatType, NoToneMapping, SRGBColorSpace, type Camera, type Scene, type WebGLRenderer } from 'three';

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

export class Grade {
  readonly composer: EffectComposer;
  /** Objects that bloom. `Selection extends Set<Object3D>`; adding one flags its render layer. */
  readonly glow: Selection;

  private readonly renderer: WebGLRenderer;
  private readonly bloom: SelectiveBloomEffect;
  private readonly tone: ToneMappingEffect;
  private mapping: ToneMapping = DEFAULT_TONE_MAPPING;

  constructor(renderer: WebGLRenderer, scene: Scene, camera: Camera) {
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

    this.composer.addPass(new RenderPass(scene, camera));
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
