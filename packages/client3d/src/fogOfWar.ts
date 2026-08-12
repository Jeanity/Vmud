/**
 * Three-state fog of war, as a per-chunk uniform. §6-M4's last item, and the one that replaces
 * something rather than adding to it.
 *
 * > *"three-state fog of war as a per-chunk uniform rather than the blurred 1 px-per-tile canvas"* —
 * > *"unseen: near-black; seen-but-not-visible: dimmed, desaturated; visible: lit."*
 *
 * M3 shipped the two-state stand-in its own header admits to: a room whose centre tile was not in the
 * `seen` bitset drew with the *faded* materials, the same transparent twin the level below uses. That
 * conflated two different statements — "you are not standing there" and "you have never been there" —
 * and it had no third state at all. This file is the replacement.
 *
 * ## The uniform is `instanceColor`, and that is why there is no shader in this file
 *
 * A chunk is one room (see `world3d.ts`), so "per-chunk uniform" and "per-room uniform" are the same
 * thing here, and three already has a per-instance channel that multiplies the diffuse term:
 * `InstancedMesh.instanceColor`. Every wrapper in the pool is minted with one, filled with white, so
 * `USE_INSTANCING_COLOR` is defined for **every** material in the scene from boot — one program, not
 * two — and a chunk's fog state costs three floats written per instance at build time and nothing at
 * all per frame. An `onBeforeCompile` patch would have had to invent a way to vary a uniform across
 * meshes that share a material, which is the problem `instanceColor` exists to solve.
 *
 * ## Desaturation cannot be a multiply, so it is not done in the shader
 *
 * `instanceColor` scales each channel independently, and no per-channel scale desaturates a colour it
 * does not already know. But the pool *does* know: there are {@link prototypes.MATERIAL_KEYS} base
 * colours and three states, so the ratio that turns each lit colour into its remembered one is a
 * finite table computed once at startup ({@link fogTint}). The shader multiplies; the desaturation
 * happened on the CPU, exactly, before a frame was drawn. A remembered forest floor comes out
 * `(0.49, 0.30, 1.07)` — the blue channel above one, because memory of green ground at night is
 * *bluer* than the ground is, and a multiply that could only ever darken could not say that.
 *
 * All arithmetic here is in three's **working colour space**, which is linear-sRGB: `new Color(hex)`
 * converts on the way in, `material.color` is uploaded already converted, and `vColor` multiplies the
 * diffuse *after* that conversion. Doing the mix in sRGB instead would give a remembered surface that
 * is too light by roughly a stop.
 */

import { Color } from 'three';

/* -------------------------------------------------------------------------- */
/* The states                                                                  */
/* -------------------------------------------------------------------------- */

/** Ordered dimmest to brightest, which is also the order the tint table is packed in. */
export const FOG_STATES = ['unseen', 'remembered', 'visible'] as const;

export type FogState = (typeof FOG_STATES)[number];

/** Index into a packed tint row. A `Record` rather than `indexOf`, so it is a lookup and not a scan. */
export const FOG_INDEX: Readonly<Record<FogState, number>> = { unseen: 0, remembered: 1, visible: 2 };

/**
 * Which of the three a room is in.
 *
 * **`visible` outranks `seen`**, and the ordering is load-bearing rather than tidy: the room a
 * character has just walked into is visible on the frame they arrive and does not enter the server's
 * `seen` bitset until the next `seenDelta`, so testing `seen` first would flash every new room black
 * for a tick. The other way round there is no such window — a room you can see is lit whether or not
 * the bookkeeping has caught up.
 */
export function fogStateOf(seen: boolean, visible: boolean): FogState {
  if (visible) return 'visible';
  return seen ? 'remembered' : 'unseen';
}

/* -------------------------------------------------------------------------- */
/* The palette of memory                                                       */
/* -------------------------------------------------------------------------- */

/** Rec. 709 luminance, in linear light. What "how bright is this colour" means here. */
export function luminanceOf(colour: Color): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/**
 * The cast a remembered surface takes, as a linear triple whose own luminance is 1.
 *
 * Two properties, both deliberate. It is **normalised**, because it is a *hue* and mixing toward it
 * must not change how bright the result is — that is {@link MEMORY_DIM}'s job, separately, so the two
 * can be tuned without fighting. And it is only *slightly* cool: its own chroma is about 0.29, well
 * below the 0.85 of a forest floor or a desert, which is what makes the mix a genuine desaturation
 * rather than a swap of one strong colour for another.
 *
 * That bound is the whole argument, and it is provable rather than eyeballed. A mix satisfies
 * `chroma(result) <= (1 - t)·chroma(base) + t·chroma(hue)`, so every base above the hue's chroma
 * loses some and every base converges on one common cast. `fogOfWar.test.ts` asserts exactly that
 * inequality over every material in the pool.
 */
export const MEMORY_HUE = coolGrey(0.86, 0.99, 1.19);

/** Light a remembered surface keeps. A third: unmistakably behind you, still legible as terrain. */
export const MEMORY_DIM = 0.34;

/** How far toward {@link MEMORY_HUE} the base colour is dragged. Memory keeps a quarter of its hue. */
export const MEMORY_DESATURATION = 0.72;

/** What an unexplored surface is allowed to reflect, linear. sRGB #1a1a20 — a silhouette, not a hole. */
export const UNSEEN_ALBEDO = 0.012;

/**
 * The most of *memory* an unexplored surface may keep.
 *
 * The second half of {@link unseenColour}'s clamp, and the one that is easy to leave out. An absolute
 * near-black target alone is right for a bright surface and *wrong* for a dark one: `cave` dressing is
 * already darker than {@link UNSEEN_ALBEDO}, so an unexplored cave would come out **brighter** than a
 * remembered one and the three states would be out of order for exactly the biome where the ordering
 * matters most. Taking the darker of the two makes the ordering total.
 */
export const UNSEEN_OF_MEMORY = 0.35;

/** The unexplored cast. Colder and flatter than memory: nothing about it is remembered, only massed. */
export const UNSEEN_HUE = coolGrey(0.82, 0.97, 1.26);

function coolGrey(r: number, g: number, b: number): Color {
  const colour = new Color();
  // Written channel-by-channel rather than through `setRGB`, because these are already *linear*
  // values and `setRGB` would convert them as if they were sRGB.
  colour.r = r;
  colour.g = g;
  colour.b = b;
  const lum = luminanceOf(colour);
  colour.multiplyScalar(1 / lum);
  return colour;
}

/** Divisor floor. A base channel of zero has no ratio, and 1e-4 linear is below any visible value. */
const FLOOR = 1e-4;

/** Ceiling on a tint channel. Stops a near-black base from being *brightened* by its own memory. */
const TINT_CEILING = 8;

/**
 * What a lit surface of this colour looks like once it is only remembered.
 *
 * Absolute, not a ratio — the ratio is {@link fogTint}'s job, and keeping the two apart is what makes
 * the palette readable: this function is the design decision and that one is the plumbing.
 */
export function rememberedColour(base: Color, out = new Color()): Color {
  const lum = luminanceOf(base);
  out.copy(base).multiplyScalar(1 - MEMORY_DESATURATION);
  out.r += MEMORY_HUE.r * lum * MEMORY_DESATURATION;
  out.g += MEMORY_HUE.g * lum * MEMORY_DESATURATION;
  out.b += MEMORY_HUE.b * lum * MEMORY_DESATURATION;
  return out.multiplyScalar(MEMORY_DIM);
}

/** Scratch for {@link unseenColour}, which needs the remembered value to clamp against. */
const REMEMBERED_SCRATCH = new Color();

/**
 * What an unexplored surface reflects: the darkest of three numbers, per channel.
 *
 * The *constant* is the design — the read wanted is one mass of dark with no biome in it, so that a
 * forest you have never entered and a cave you have never entered are the same silhouette. The two
 * clamps are the corrections that make it total: never brighter than the lit surface, and never
 * brighter than {@link UNSEEN_OF_MEMORY} of the remembered one. Without the second, the darkest
 * sectors invert the state ordering; see that constant.
 */
export function unseenColour(base: Color, out = new Color()): Color {
  const remembered = rememberedColour(base, REMEMBERED_SCRATCH);
  out.r = Math.min(base.r, UNSEEN_HUE.r * UNSEEN_ALBEDO, remembered.r * UNSEEN_OF_MEMORY);
  out.g = Math.min(base.g, UNSEEN_HUE.g * UNSEEN_ALBEDO, remembered.g * UNSEEN_OF_MEMORY);
  out.b = Math.min(base.b, UNSEEN_HUE.b * UNSEEN_ALBEDO, remembered.b * UNSEEN_OF_MEMORY);
  return out;
}

/**
 * The per-instance multiplier that carries a material's base colour into a fog state.
 *
 * Written into three floats of `instanceColor`. `visible` is exactly `(1, 1, 1)` — the lit state must
 * be bit-identical to no tint at all, or every surface in the game is quietly a fraction off.
 */
export function fogTint(base: Color, state: FogState, out = new Color()): Color {
  if (state === 'visible') return out.setRGB(1, 1, 1);
  const target = state === 'remembered' ? rememberedColour(base) : unseenColour(base);
  out.r = Math.min(TINT_CEILING, target.r / Math.max(base.r, FLOOR));
  out.g = Math.min(TINT_CEILING, target.g / Math.max(base.g, FLOOR));
  out.b = Math.min(TINT_CEILING, target.b / Math.max(base.b, FLOOR));
  return out;
}

/**
 * The three tints for one base colour, packed `[unseen rgb, remembered rgb, visible rgb]`.
 *
 * Nine floats a material, 113 materials — four kilobytes for the whole world's fog of war, built once
 * in the pool's constructor and read with an offset from {@link FOG_INDEX} thereafter.
 */
export function fogTintRow(base: Color): Float32Array {
  const row = new Float32Array(FOG_STATES.length * 3);
  const scratch = new Color();
  for (const state of FOG_STATES) {
    fogTint(base, state, scratch);
    const at = FOG_INDEX[state] * 3;
    row[at] = scratch.r;
    row[at + 1] = scratch.g;
    row[at + 2] = scratch.b;
  }
  return row;
}
