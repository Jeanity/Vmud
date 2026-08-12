/**
 * The daylight recipe — M5b's answer to the one thing M4 deliberately left out.
 *
 * M4 was the go/no-go and its question was *"does the **light** match"* against a night reference, so
 * it tuned the night and nothing else: `night.ts` is one moon, one cold hemisphere and a dark fog,
 * and it is right. The picture the owner then confirmed the art direction against is the Quaternius
 * kit's own screenshots, and those are **sunlit**. So there has to be a second recipe, and the two
 * have to be equally good — a day mode that is the night one with the numbers doubled would make the
 * kit look like the grey-box world with a lamp on.
 *
 * ## The recipe is data; `night.ts` stays the rig
 *
 * Everything that differs between noon and midnight is a *number in a table* here, and `NightRig`
 * applies whichever table it is given. Nothing about the shadow fit, the hemisphere-not-ambient rule
 * or the single-directional-light rule changes — the plan's *"which is why you need no cascaded
 * shadow maps at all"* is a consequence of the camera being fixed and the camera does not move at
 * noon. That is also what makes *"do not regress the night"* checkable: {@link NIGHT_SKY} is M4's
 * constants, unmoved, and `night.test.ts` still asserts them at the module level.
 *
 * ## Four keys, and why not more
 *
 * Midnight, dawn, noon and dusk, interpolated. Four is the smallest set in which the two *interesting*
 * moments are keys rather than blends: the low warm sun that rakes the treeline, at both ends of the
 * day. A two-key day/night lerp passes through a grey-green nothing at 06:00 which is the one hour
 * the kit's foliage looks worst in.
 *
 * Hue is interpolated in **sRGB byte space** rather than in linear, and that is deliberate: these are
 * art-directed colours, chosen by eye against a monitor, and the path the eye expects between two
 * chosen colours is the one through the space they were chosen in. (The *shader* still works in
 * linear — three converts on `setHex`. This is about which curve the tween follows.)
 *
 * ## Tone mapping stays Neutral
 *
 * §5, and M4's finding restated: AgX sheds chroma in the bottom of the range, which is where a night
 * scene lives entirely — and the kit's saturated greens are exactly the thing not to spend. The
 * *exposure* is per recipe, because 1.6 was chosen to lift a moonlit 0.11 into readability and the
 * same number at noon is a white-out. See {@link SkyRecipe.exposure}.
 *
 * ## The clock the server does not tick
 *
 * **Settled 2026-08-13 and re-verified here**: `packages/server/src` has no game-hour clock — the only
 * "hour" matches are the scheduler's and the noticeboards' timestamps. So the hour is a *client* value
 * with a named hook, {@link World3D.setGameHour}, and a debug key to sweep it. When a MUD day/night
 * clock arrives it writes that hook and nothing else in this file changes.
 */

import type { Point3 } from './night.ts';

/* -------------------------------------------------------------------------- */
/* The recipe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything the sky is, at one instant. `NightRig.sky` writes all of it at once.
 *
 * Every field is a number M4 either chose or derived, so the night entry is copyable from `night.ts`
 * by inspection and the day entry is legible as "what changed".
 */
export interface SkyRecipe {
  readonly name: string;
  /** The hemisphere's two colours. `HemisphereLight`, never an `AmbientLight` — see `night.ts`. */
  readonly sky: number;
  readonly ground: number;
  readonly hemisphere: number;
  /** The one directional light: its colour, its strength and where it stands. */
  readonly sun: number;
  readonly sunIntensity: number;
  /** A unit vector **from the scene toward the light**, exactly as `MOON_FROM` is. */
  readonly from: Point3;
  /** Fog and background, one colour. See `NIGHT_COLOUR` for why they are never two. */
  readonly fog: number;
  readonly fogDensity: number;
  /** `renderer.toneMappingExposure`. Applied by `main.ts`, which owns the composer. */
  readonly exposure: number;
}

/**
 * M4's night, unchanged, as a recipe.
 *
 * The numbers are `night.ts`'s own constants and are imported by value rather than re-derived so that
 * a change there is a change here. The one thing this adds is `exposure`, which lived in `post.ts` as
 * a single default and is now per recipe.
 */
export const NIGHT_SKY: SkyRecipe = {
  name: 'night',
  sky: 0x163a52,
  ground: 0x0a1a18,
  hemisphere: 2.2,
  sun: 0xc4d3ef,
  sunIntensity: 1.15,
  from: { x: -0.55, y: 0.66, z: -0.51 },
  fog: 0x0d2430,
  fogDensity: 0.018,
  exposure: 1.6,
};

/**
 * Noon. The kit's own screenshots, as numbers.
 *
 * - **A warm sun at 3.1.** Nearly three times the moon, because it is: the ratio between a sunlit and
 *   a shadowed face is what says "outdoors in daylight", and at the moon's 1.15 with the hemisphere
 *   lifted to match, everything arrives at the same value and the world flattens into the overcast
 *   look the grey-box scene already had.
 * - **A sky-blue hemisphere at 1.5, over a warm bounce.** Lower than the night's 2.2 *and* far
 *   brighter, because `HEMISPHERE_INTENSITY` is a multiplier on a near-black colour at night and on a
 *   real blue here. The ground half is a dry warm grey rather than the night's green-black: a
 *   downward-facing surface at noon is lit by the dirt under it.
 * - **Fog pushed back and brightened.** 0.006 rather than 0.018 — transmittance 0.96 at 33 m against
 *   the night's 0.70 — so the far treeline recedes without the frame becoming a haze. The colour is a
 *   pale warm blue: aerial perspective at noon is the sky leaking into the distance.
 * - **The sun sits higher than the moon but not overhead** (y 0.78 at noon against the moon's 0.66):
 *   high enough to read as midday, low enough that a 3 m wall still throws a shadow you can see, which
 *   is the whole reason `night.ts` refuses a vertical light.
 * - **Exposure 0.95.** Neutral maps a sunlit 0.55 to most of the display range on its own; 1.6 would
 *   put the lit ground into the bloom threshold and turn every clearing into a portal.
 */
export const DAY_SKY: SkyRecipe = {
  name: 'day',
  sky: 0x8fc4ee,
  ground: 0x6b6154,
  hemisphere: 1.5,
  sun: 0xfff2d6,
  sunIntensity: 3.1,
  from: { x: -0.38, y: 0.78, z: -0.5 },
  fog: 0xb9d4e4,
  fogDensity: 0.006,
  exposure: 0.95,
};

/**
 * Dawn, and its mirror at dusk. The two moments the kit's foliage is worth looking at.
 *
 * A low sun (y 0.19) means long shadows and a canopy lit from the side, which is exactly the
 * condition `foliage.ts`'s two-sided translucency was written for — the moon rimming a canopy is a
 * quiet effect and a low sun through the same term is not. The fog is denser than noon's and warm, so
 * the distance goes gold rather than blue.
 *
 * Dusk is dawn's colours with the sun on the other side of the sky and a cooler cast, not a copy: the
 * light before rain is not the light after it, and having both keys means the sweep passes through
 * two different evenings.
 */
export const DAWN_SKY: SkyRecipe = {
  name: 'dawn',
  sky: 0x9db4d0,
  ground: 0x54483e,
  hemisphere: 1.7,
  sun: 0xffcf94,
  sunIntensity: 2.2,
  from: { x: -0.82, y: 0.19, z: -0.54 },
  fog: 0xd8c0a4,
  fogDensity: 0.013,
  exposure: 1.15,
};

export const DUSK_SKY: SkyRecipe = {
  name: 'dusk',
  sky: 0x6d7fa8,
  ground: 0x3c3a3a,
  hemisphere: 1.9,
  sun: 0xffab6b,
  sunIntensity: 1.9,
  from: { x: 0.84, y: 0.17, z: -0.51 },
  fog: 0x8f7f90,
  fogDensity: 0.015,
  exposure: 1.3,
};

/**
 * The day, as four keys on a twenty-four hour dial.
 *
 * Ordered and wrapping: {@link skyAt} finds the segment an hour falls in and interpolates, and 23:00
 * blends dusk back toward midnight the short way round because the last entry's successor is the
 * first. Hours rather than a 0..1 phase because the thing this exists to serve is a MUD clock, and a
 * MUD clock counts hours.
 */
export const SKY_KEYS: readonly { readonly hour: number; readonly recipe: SkyRecipe }[] = [
  { hour: 0, recipe: NIGHT_SKY },
  { hour: 6, recipe: DAWN_SKY },
  { hour: 12, recipe: DAY_SKY },
  { hour: 19, recipe: DUSK_SKY },
];

/** The two the **G** key flips between. Night first, because that is the world M4 shipped. */
export const SKY_PRESETS: readonly SkyRecipe[] = [NIGHT_SKY, DAY_SKY];

/* -------------------------------------------------------------------------- */
/* Interpolation                                                              */
/* -------------------------------------------------------------------------- */

/** Wrap an hour into `[0, 24)`. Negative hours are as valid as any others; a clock is a circle. */
export function normaliseHour(hour: number): number {
  const wrapped = hour % 24;
  return wrapped < 0 ? wrapped + 24 : wrapped;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** sRGB byte-space lerp. See the header for why this is not done in linear. */
function mixHex(a: number, b: number, t: number): number {
  const r = Math.round(mix((a >> 16) & 0xff, (b >> 16) & 0xff, t));
  const g = Math.round(mix((a >> 8) & 0xff, (b >> 8) & 0xff, t));
  const blue = Math.round(mix(a & 0xff, b & 0xff, t));
  return (r << 16) | (g << 8) | blue;
}

function mixPoint(a: Point3, b: Point3, t: number): Point3 {
  const x = mix(a.x, b.x, t);
  const y = mix(a.y, b.y, t);
  const z = mix(a.z, b.z, t);
  // Renormalised, because `fitShadowCamera` builds an orthonormal basis from this and a vector that
  // shortened as it swung would quietly shrink the shadow volume at every hour that is not a key.
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}

/**
 * The sky at an hour of the game day.
 *
 * Pure, and exported so `daylight.test.ts` can sweep all twenty-four without a renderer: every field
 * stays inside the envelope its two keys set, the sun never dips to or past the horizon (which would
 * degenerate the shadow basis — `night.ts`'s `shadowUpFor` guards the *other* end of the same
 * problem), and 24:00 is 00:00 exactly.
 */
export function skyAt(hour: number): SkyRecipe {
  const h = normaliseHour(hour);
  const keys = SKY_KEYS;
  let index = 0;
  for (let i = 0; i < keys.length; i++) {
    if (h >= keys[i]!.hour) index = i;
  }
  const from = keys[index]!;
  const to = keys[(index + 1) % keys.length]!;
  const span = (to.hour - from.hour + 24) % 24 || 24;
  const t = ((h - from.hour + 24) % 24) / span;
  // Smoothstep rather than linear: the sun neither leaves nor arrives at a constant rate, and a
  // linear sweep visibly changes gear at every key.
  const s = t * t * (3 - 2 * t);
  return {
    name: `${from.recipe.name}->${to.recipe.name}`,
    sky: mixHex(from.recipe.sky, to.recipe.sky, s),
    ground: mixHex(from.recipe.ground, to.recipe.ground, s),
    hemisphere: mix(from.recipe.hemisphere, to.recipe.hemisphere, s),
    sun: mixHex(from.recipe.sun, to.recipe.sun, s),
    sunIntensity: mix(from.recipe.sunIntensity, to.recipe.sunIntensity, s),
    from: mixPoint(from.recipe.from, to.recipe.from, s),
    fog: mixHex(from.recipe.fog, to.recipe.fog, s),
    fogDensity: mix(from.recipe.fogDensity, to.recipe.fogDensity, s),
    exposure: mix(from.recipe.exposure, to.recipe.exposure, s),
  };
}

/** The hour a named preset sits at, for the **G** key's jump. */
export function hourOf(recipe: SkyRecipe): number {
  return SKY_KEYS.find((key) => key.recipe === recipe)?.hour ?? 0;
}

/** Convenience for the log line and the HUD: `01:30`. */
export function clockOf(hour: number): string {
  const h = normaliseHour(hour);
  const whole = Math.floor(h);
  const minutes = Math.round((h - whole) * 60);
  return `${String(whole).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
