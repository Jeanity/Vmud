/**
 * Light without sky — the other half of §6-M6's second rendering mode, and the half the plan spends
 * its sentence on: *"roof and ceiling geometry, camera-aware roof culling and wall fading, interior
 * light sources, **no sky term, no weather, a different shadow setup**"*.
 *
 * `daylight.ts` is the model this follows exactly: the recipe is **data**, `night.ts` stays the rig,
 * and nothing here touches a light object. Which means the three rules M4 settled survive unchanged
 * indoors — one hemisphere and never an `AmbientLight`, one directional and never a second, both
 * added in the constructor and never removed, because three compiles a shader permutation per light
 * count and a light appearing mid-session is a compile in the middle of a frame.
 *
 * ## There is no "remove the sky term". There is only a different sky.
 *
 * The temptation is to switch the `HemisphereLight` off indoors. That is wrong twice: it is a shader
 * permutation if done by `visible` (`lights.ts`'s trap, in its third costume), and it is wrong
 * *artistically* — a hemisphere is not "the sky", it is a two-colour gradient keyed on the surface
 * normal, and indoors the two colours are the ceiling's bounce and the floor's. So the interior
 * recipes keep the term and re-point it: a dim warm grey above, a darker one below, at a fifth of
 * the night's intensity. Upward faces catch the lamp-lit plaster overhead, downward ones go to the
 * boards. That gradient is what stops an interior reading as a flat-shaded box, and it is the same
 * argument `night.ts` makes for refusing an ambient light in the first place.
 *
 * ## The shadow story, decided rather than defaulted
 *
 * **One interior key, steeply overhead, still casting.** The alternatives were both considered:
 *
 * - *No dynamic interior shadows* (`sunIntensity: 0`) is cheaper and honest about there being no sun
 *   in a cellar. It was rejected on `prototypes.ts`'s own words about bodies — *"a character with no
 *   shadow floats however good the terrain looks"* — which is more true indoors, not less: outdoors a
 *   character is read against ground texture and undergrowth, and on a bare plank floor a contact
 *   shadow is the only thing putting them **on** it.
 * - *A second, shadow-casting point light at the hearth* is what the fiction wants and it is not
 *   available: point-light shadows are six cube faces per light, `lights.ts`'s eight-light pool is
 *   explicitly `castShadow = false`, and turning one on would be six extra shadow renders and a new
 *   program permutation for the price of one room's mood.
 *
 * So the existing directional stays, and only its **direction** and its strength change: from 41
 * degrees of elevation outdoors to 72 indoors, which is the difference between "the sun rakes in" and
 * "the room is lit from above". Two things follow that are worth having on purpose. A steeper light
 * makes `fitShadowCamera`'s box tighter, so the shadow texel is *smaller* indoors than out — 1.9 cm
 * against 2.2 at the default pose. And the per-frame refit is unchanged: it is a function of the
 * light direction and the frame, both of which it already reads, so nothing about the interior mode
 * fights it.
 *
 * ## The fog is the wall of the world
 *
 * There is exactly one sky rig for the whole scene, so an interior recipe lights the street outside
 * the door too. That is unavoidable with one hemisphere and one directional, and the honest fix is
 * not to add lights — it is to make the far field go dark, which is what an interior *is*. Interior
 * `fogDensity` is roughly the night's, and the near-black colour takes the un-roofed neighbours and
 * the streaming ring's rim down to a fifth of their own colour by the far edge of the widest frame.
 * A dark surround with a warm pool of lamp light in the middle is the reference image's own read,
 * indoors: the clearing light (`lights.ts` slot 0, warm, 7 m) is what lifts the player's own room
 * out of it.
 *
 * ## Crossing the threshold
 *
 * {@link mixSky} is `daylight.ts`'s interpolator, exported for this, and `main.ts` runs one scalar
 * toward the enclosure the player is in over {@link INDOOR_BLEND_SECONDS}. Short — a third of a
 * second, about a tenth of a combat round — because the *geometry* swaps in one frame (a roof group
 * opening is a rebuild) and a light that took a second to follow it would leave the player standing
 * in a lit street inside a roofless room.
 *
 * The daylight controls keep working and do nothing weird: the hour is still the **outdoor** state,
 * `[`/`]` and `G` still move it, and indoors the blend has already reached 1 so the interior recipe
 * wins every field. Step outside and the hour you set is the hour you get.
 */

import { mixSky, type SkyRecipe } from './daylight.ts';

/**
 * Which of the three worlds the player is standing in.
 *
 * Not the IR's `enclosure` verbatim: that carries `solid` as well, and §4's *"3 or 4 solid wants an
 * interior probe, no sky term"* was written before `roofed` existed and does not survive contact with
 * the built world — a forest clearing walled in by three `edge` sides is three tree walls and a sky,
 * and 8,470 outdoor rooms have three or more. **`roofed` is the honest predicate**, it is the one the
 * rain (`main.ts`), the ground blend (`chunkPlan.groundBlendOf`) and the elevation policy
 * (`roomScene.ts`) already use, and consistency across four systems is worth more than matching a
 * sentence written before the IR did.
 */
export const ENCLOSURES = ['outdoor', 'inside', 'cave'] as const;

export type Enclosure = (typeof ENCLOSURES)[number];

/**
 * An inn, a shop, a temple, a cellar — anything roofed that is not living rock.
 *
 * Warm and low. The key is a lamp-coloured 0.62 from 72 degrees up, the hemisphere is a fifth of the
 * night's intensity over a *warm* pair, and the exposure comes up to 1.5 because everything in the
 * frame is now made of its own reflected light rather than of a sun.
 */
export const INSIDE_SKY: SkyRecipe = {
  name: 'inside',
  // The ceiling's bounce and the floor's. Warm grey over a browner one — plaster over boards.
  sky: 0x6d6055,
  ground: 0x2e2721,
  hemisphere: 0.42,
  // Tallow, not daylight: a lamp is yellow-green-poor and this is as far toward it as a single
  // key can go without the plaster reading as sandstone.
  sun: 0xffd9a4,
  sunIntensity: 0.62,
  // 72 degrees up and a little to the north-west, so the shadow a body throws is short, offset and
  // legible rather than a disc under its own feet. See the header on why this one still casts. Unit
  // to six places, because `fitShadowCamera` builds an orthonormal basis from it and a vector 0.2%
  // long would scale the shadow volume by the same amount every frame it is applied.
  from: { x: -0.234843, y: 0.951057, z: -0.200845 },
  // Near-black and warm, so the far field goes to lamplit soot rather than to blue.
  fog: 0x0e0b09,
  fogDensity: 0.019,
  exposure: 1.5,
};

/**
 * A cave, a mine, the Underdark — the light of a place that has never had any.
 *
 * Colder, dimmer and foggier than {@link INSIDE_SKY} on every axis, which is the whole difference:
 * an interior is warm because something in it is burning, and a cavern is not. The key is kept (a
 * shaft of pale light from a crack overhead is exactly what a cave wants) but at a third of the
 * inn's strength, and the fog is dense enough that the tunnel behind you is gone by 40 m.
 */
export const CAVE_SKY: SkyRecipe = {
  name: 'cave',
  sky: 0x3f4750,
  ground: 0x14181b,
  hemisphere: 0.34,
  sun: 0xa8c0d4,
  sunIntensity: 0.22,
  from: { x: -0.178975, y: 0.970296, z: -0.162757 },
  fog: 0x05070a,
  fogDensity: 0.026,
  exposure: 1.62,
};

/** The recipe an enclosure asks for, or nothing at all when the answer is "whatever the hour says". */
export function indoorSky(enclosure: Enclosure): SkyRecipe | undefined {
  if (enclosure === 'inside') return INSIDE_SKY;
  if (enclosure === 'cave') return CAVE_SKY;
  return undefined;
}

/**
 * Seconds to cross the threshold. A third of a second — see the header on why it is not longer.
 *
 * Wall-clock, like the rain's and the wind's and for the same reason: two players walking through one
 * door should see one transition, and an accumulator drifts with the frame rate.
 */
export const INDOOR_BLEND_SECONDS = 0.33;

/**
 * The blend, advanced by one frame — a first-order approach with a fixed time constant.
 *
 * Not a linear ramp on a counter: a player who steps in and straight back out again would otherwise
 * finish the second transition from wherever the first had got to *at the first transition's rate*,
 * which reads as the light sticking. An exponential approach is symmetric, has no state but the value
 * itself, and its `dt` clamp is `main.ts`'s existing one.
 */
export function approach(current: number, target: number, seconds: number): number {
  if (seconds <= 0) return current;
  const k = 1 - Math.exp(-seconds / (INDOOR_BLEND_SECONDS / 3));
  const next = current + (target - current) * Math.min(1, k);
  // Snapped at the ends so the recipe applied while standing still is byte-for-byte the authored one
  // rather than something 0.4% short of it — which would make `__debug3d.sky` unreadable.
  if (Math.abs(next - target) < 1e-3) return target;
  return next;
}

/**
 * The sky the frame should actually be lit by: the hour's, the enclosure's, or a point between.
 *
 * `outdoor` is whatever `daylight.skyAt` said for the current hour, so the two systems compose rather
 * than one overriding the other — and at `blend === 1` every field is the interior's, which is the
 * whole of *"the daylight keys keep working outside and do nothing weird inside"*.
 */
export function skyFor(outdoor: SkyRecipe, enclosure: Enclosure, blend: number): SkyRecipe {
  const indoor = indoorSky(enclosure);
  if (!indoor || blend <= 0) return outdoor;
  if (blend >= 1) return indoor;
  return mixSky(outdoor, indoor, blend);
}
