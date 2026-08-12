/**
 * The live sky — where the world's own clock and weather meet the recipes M5b and M6 built.
 *
 * `daylight.ts` shipped with a note that has now expired: *"the hour is a **client** value with a
 * named hook, `World3D.setGameHour`, and a debug key to sweep it. When a MUD day/night clock arrives
 * it writes that hook and nothing else in this file changes."* The clock arrived (`f85b5fb`, *The
 * world keeps time*) — a 75 s game hour, a 24/35/17 calendar and Duris' continuous climate
 * simulation, per zone. This file is the promised change, and the promise held: **no recipe moved.**
 * Everything here either produces an hour for `setGameHour` or modulates the recipe that hour returns.
 *
 * ## The wire, and the one arithmetic line that matters
 *
 * `{t:'sky'}` carries a whole {@link SkyView}: `hour`, `progress`, `hourMs`, the date, `sunlight`,
 * `sky`, `precip`, `wind`, `temp`, `light`, `sun`, `moon`. It arrives at `welcome`, on every Place
 * change, on every game hour and whenever the zone's weather turns — so between messages there can be
 * seventy-five seconds of silence, and a client that simply applied `view.hour` would **step** the sky
 * once every seventy-five seconds. Dawn would arrive as a cut.
 *
 * So the client holds the message *and the instant it arrived* and derives its own fractional hour:
 *
 * ```
 * display hour = hour + progress + (now - receivedAt) / hourMs
 * ```
 *
 * — {@link displayHourOf}, which is the whole reason `progress` and `hourMs` are on the wire at all.
 * `hourMs` rather than a constant because *"an operator can throw it"* (the protocol's own words, and
 * `settings.gameHourMs` is the switch): the server re-sends `sky` to everyone the moment the rate
 * changes, so the new rate arrives as data and the scrub simply runs faster from the next message on.
 *
 * ## Which fields are read, and which are carried unread
 *
 * Read: `hour`, `progress` and `hourMs` drive the daylight recipe; `sky` gates the rain
 * ({@link fallingOf}); `precip` scales its density ({@link rainDensityOf}) and, with `light`, decides
 * how much a storm darkens the frame ({@link gloomOf}).
 *
 * **Available and deliberately unread, named here so the next slice does not have to go looking:**
 *
 * | Field | What it is | What it would drive |
 * |---|---|---|
 * | `wind` | Duris' seven wind bands; 100 is a hurricane | `foliage.WindClock`'s amplitude, and the rain's slant — both are single uniforms already shared by every instance |
 * | `temp` | Degrees Celsius; `<= 0` is *why* `sky` says `snowing` | Breath in cold air, and the snow decision below if it is ever taken on temperature rather than on state |
 * | `sunlight` | `night` / `twilight` / `day`, the source's `IS_DAY` bands | Nothing here — the hour is finer than three bands and the recipe already keys on it. Carried for the HUD |
 * | `day`, `month`, `year` | The 24/35/17 calendar | A date in the HUD; the moon's phase is a function of `day` and the server has already folded it into `light` |
 *
 * ## The frame cost, and why the hour is quantised
 *
 * A live clock changes the hour every frame, and `main.ts`'s `applySky` is not free: two
 * `NightRig.sky` writes, each an eight-corner shadow re-fit. M6 was careful to re-apply the sky *only
 * on the frames the threshold actually moved* — *"a session spent entirely out of doors costs one
 * comparison a frame and nothing else"* — and a clock that re-applied every frame would quietly
 * repeal that.
 *
 * So the display hour is rounded to {@link SKY_HOUR_STEP}. The step is chosen by measurement rather
 * than by taste, and `sky.test.ts` sweeps all 12,288 of them: across one step **no colour ever moves
 * by more than one 8-bit level** — the smallest change a channel can make at all — and on four steps
 * in five none of the twelve channels moves whatsoever. So the quantisation cannot be seen, by
 * construction rather than by opinion, and at the default 75 s hour it costs about seven
 * re-applications a second instead of sixty. It scales with the rate on its own — throw `hourMs` to
 * 5 s and the step is under a frame, which is correct, because at that rate the sky really is moving
 * that fast.
 *
 * ## Defensive by contract
 *
 * `decodeServerMessage` validates *nothing but the tag* — `protocol.ts:1219`, three lines — so every
 * field here arrives as `unknown` in a `SkyView` costume. {@link sanitiseSky} is therefore not
 * paranoia but the actual contract: it clamps each field into the range its own documentation
 * promises and hands back a view the rest of the file can treat as arithmetic. A message that is not
 * an object at all is dropped whole and **the previously held sky keeps running**, which is the same
 * answer the interpolation gives for a late message: the world keeps time.
 */

import { SKY_STATES, type SkyState, type SkyView, type Sunlight } from '@mygame/shared';

import { normaliseHour, type SkyRecipe } from './daylight.ts';

/* -------------------------------------------------------------------------- */
/* Knobs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The server's own `DEFAULT_HOUR_MS`, restated as the fallback for a message that did not carry a
 * usable one. Never used against a healthy server, which sends the live rate in every message.
 */
export const DEFAULT_HOUR_MS = 75_000;

/**
 * The grid the display hour is rounded to, in game hours — seven game seconds, and at the default
 * rate 146 real milliseconds.
 *
 * See the header for why it exists. Why *this* value: one step of the four-key recipe never moves a
 * colour channel by more than a single 8-bit level and usually moves nothing at all, so the grid is
 * finer than the display it is drawn on.
 */
export const SKY_HOUR_STEP = 1 / 512;

/**
 * **The snow decision, and it is the owner's — left open on purpose.**
 *
 * The default climate snows nine times more than it rains: 3,781 game hours of a year against 434
 * (measured while the clock was built, `f85b5fb`). So "snow" is not an edge case here, it is the
 * *common* case, and giving it the rain's own long additive streaks is a real visual claim about most
 * of the world's weather. It is also the only thing available today that is not a lie of omission —
 * a snowstorm with a clear sky over it would read as a bug.
 *
 * Flipping this to `false` makes snow fall as nothing at all. Giving snow its **own** particle field
 * — slower, rounder, wind-borne, drifting rather than streaking — is one function: switch `main.ts`
 * on {@link fallingOf} (which already tells the truth about which is falling) and hand `'snow'` to a
 * `Snow` field beside `Rain`. Nothing else in this file or that one would move.
 *
 * The roadmap carries the open question; this constant is where the answer lands.
 */
export const SNOW_FALLS_AS_RAIN = true;

/**
 * The precipitation rate at which the storm is at full density, and the floor a drizzle keeps.
 *
 * `RAIN_FULL_PRECIP` is the source's own top band — above 80 Duris says *"It's raining really hard
 * right now"* and has nothing stronger to say (`weather.ts:638`), so that is where the picture should
 * have nothing stronger to show either. The floor exists because the bottom band is *"A light drizzle
 * is falling here"* at a rate of 1, and a drizzle drawn with 60 of 6,000 drops is a dry street with a
 * few sparks in it.
 */
export const RAIN_FULL_PRECIP = 80;
export const RAIN_DENSITY_MIN = 0.18;

/**
 * How far a full storm dims the outdoor recipe, and how far it opens the camera to compensate.
 *
 * **The recipes' own night/day travel stays primary and these three numbers are deliberately small.**
 * `light` is the source's answer to *"how dark does a storm make the afternoon"* and the honest
 * translation of a storm is not "turn everything down": it is that the key light is scattered into
 * the fill and the contrast collapses. So the sun loses nearly half of itself, the hemisphere loses a
 * seventh, and the exposure comes up by an eighth to give a quarter of that stop back as *grey*
 * rather than as *dark*.
 *
 * At full gloom over noon: the key falls 3.10 → 1.71 (between noon's and dusk's, which is exactly
 * what a storm-lit afternoon looks like), the fill 1.50 → 1.28, and the key:fill ratio 2.07 → 1.34 —
 * the flattening that reads as overcast. A lit surface ends at 0.62 of clear noon, about two thirds
 * of a stop; a shadowed one, lit by the hemisphere alone, ends at 0.95 and barely moves. That gap
 * closing *is* the effect.
 */
export const STORM_SUN_DIM = 0.45;
export const STORM_HEMISPHERE_DIM = 0.15;
export const STORM_EXPOSURE_LIFT = 0.12;

/* -------------------------------------------------------------------------- */
/* Sanitising                                                                  */
/* -------------------------------------------------------------------------- */

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** `weather.h:64-69` — the bands, used only to repair a message that carried a bad `sunlight`. */
function sunlightAt(hour: number): Sunlight {
  const h = Math.floor(normaliseHour(hour));
  if (h >= 8 && h <= 16) return 'day';
  if ((h >= 5 && h <= 7) || (h >= 17 && h <= 19)) return 'twilight';
  return 'night';
}

/**
 * A served sky, clamped into the ranges its own contract promises — or nothing, when the payload is
 * not an object at all and there is therefore nothing to repair.
 *
 * Every clamp names the range from `protocol.ts`'s comment on the field. `hour` is normalised rather
 * than floored: the contract says 0–23 and integral, but a fractional hour is *more* information and
 * interpolates correctly, so it is kept rather than thrown away.
 */
export function sanitiseSky(raw: unknown): SkyView | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const view = raw as Partial<Record<keyof SkyView, unknown>>;
  const hour = normaliseHour(finite(view.hour, 0));
  const state = view.sky;
  return {
    hour,
    progress: clamp(finite(view.progress, 0), 0, 1),
    // Floored at a millisecond rather than defaulted, because an operator who threw the rate to
    // something tiny meant it; zero or negative is the only value that would divide by nothing.
    hourMs: Math.max(1, finite(view.hourMs, DEFAULT_HOUR_MS)),
    day: finite(view.day, 0),
    month: finite(view.month, 0),
    year: finite(view.year, 0),
    sunlight:
      view.sunlight === 'day' || view.sunlight === 'twilight' || view.sunlight === 'night'
        ? view.sunlight
        : sunlightAt(hour),
    sky: SKY_STATES.includes(state as SkyState) ? (state as SkyState) : 'clear',
    precip: clamp(finite(view.precip, 0), 0, 100),
    // Unbounded above in the source — 100 is a hurricane, not a ceiling.
    wind: Math.max(0, finite(view.wind, 0)),
    // Degrees Celsius, and the only field with no natural floor: below zero is why `sky` says snow.
    temp: finite(view.temp, 0),
    light: clamp(finite(view.light, 0), 0, 100),
    sun: view.sun === true,
    moon: view.moon === true,
  };
}

/* -------------------------------------------------------------------------- */
/* The clock                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The display hour, from a held view and the wall clock. The header's one arithmetic line.
 *
 * `now` is `performance.now()` and `receivedAt` is the same clock read when the message landed, so
 * the difference is real elapsed milliseconds and nothing else. Negative elapsed is clamped away: a
 * message whose stamp is in the future is a bug somewhere, and running the sky *backwards* is a worse
 * answer than freezing it for an instant.
 *
 * Nothing bounds the elapsed time above, and that is the point. A socket that died at 03:00 leaves
 * the sky scrubbing on: the world keeps time whether or not anyone is listening, and the reconnect's
 * own `sky` message replaces the whole snapshot the moment it arrives.
 */
export function displayHourOf(view: SkyView, receivedAt: number, now: number): number {
  const elapsed = Math.max(0, now - receivedAt);
  return normaliseHour(view.hour + view.progress + elapsed / Math.max(1, view.hourMs));
}

/** The display hour, rounded to the grid `applySky` is actually re-run on. See {@link SKY_HOUR_STEP}. */
export function quantiseHour(hour: number): number {
  return Math.round(hour / SKY_HOUR_STEP) * SKY_HOUR_STEP;
}

/* -------------------------------------------------------------------------- */
/* Weather                                                                     */
/* -------------------------------------------------------------------------- */

/** What is coming down, honestly — whatever the renderer then chooses to draw it with. */
export type Falling = 'none' | 'rain' | 'snow';

/**
 * The sky state, as a thing falling out of it.
 *
 * Keyed on the **state** rather than on `precip`, because that is what the state *is*: `skyOf`
 * returns `raining`/`snowing` exactly when `precipRate > 0` (`weather.ts:743`), splitting on
 * `temp <= 0`. So the rate is free to be zero-ish without the gate flickering, and it is left to
 * scale density instead.
 */
export function fallingOf(view: SkyView): Falling {
  if (view.sky === 'raining') return 'rain';
  if (view.sky === 'snowing') return 'snow';
  return 'none';
}

/**
 * Whether the rain field falls for what is coming down. **This is the snow decision, as one branch.**
 *
 * See {@link SNOW_FALLS_AS_RAIN} for the argument and for what changes when the owner takes it.
 */
export function rainVisibleFor(falling: Falling): boolean {
  if (falling === 'rain') return true;
  if (falling === 'snow') return SNOW_FALLS_AS_RAIN;
  return false;
}

/**
 * How much of the storm falls, 0..1 — the precipitation rate as a fraction of the drop count.
 *
 * Zero when nothing is coming down, so a caller that ignored the gate would still draw nothing. See
 * {@link RAIN_FULL_PRECIP} for why the ladder tops out at 80 and floors at a fifth: it is the
 * source's own five prose bands, from *"a light drizzle"* to *"raining really hard"*, as a picture.
 */
export function rainDensityOf(view: SkyView): number {
  if (!rainVisibleFor(fallingOf(view))) return 0;
  const rate = clamp(view.precip, 0, 100) / RAIN_FULL_PRECIP;
  return RAIN_DENSITY_MIN + (1 - RAIN_DENSITY_MIN) * Math.min(1, rate);
}

/**
 * How much of the sky's own light the weather is eating, 0..1.
 *
 * **`light` is not an absolute brightness and must not be used as one.** `calc_light_zone`
 * (`weather.ts:281`) builds it as sun + moon − precip, clamped to 0–100 — and the sun peaks at *60*
 * at noon while a moonless midnight is legitimately **0**. Dimming the recipe by `1 - light/60` would
 * therefore darken every clear night by the full amount, which is M4's signed-off night regressed by
 * arithmetic.
 *
 * What the field is good for is the *shortfall*, because the source says in as many words that rain
 * is the only thing that subtracts. So the clear-sky light for this very hour, moon phase and climate
 * is `light + precip` — no client-side replication of anything — and the gloom is the fraction of it
 * the rain took:
 *
 * ```
 * gloom = precip / (light + precip)
 * ```
 *
 * Clear noon: 0/(60+0) = **0**, and the recipe is untouched at every hour of a dry day. Noon under
 * rate 30: 30/(30+30) = **0.5**. Noon under rate 60 or worse: the light is gone, and it saturates at
 * **1**. A moonless midnight, dry: 0/(0+0) → **0**, the case the naive mapping gets wrong. A full moon
 * (light 35) under a light rain of 10: 10/(25+10) = **0.29**, which is proportionate rather than
 * absolute — exactly the property that lets one mapping serve every hour.
 */
export function gloomOf(view: SkyView): number {
  const precip = clamp(view.precip, 0, 100);
  if (precip <= 0) return 0;
  const clear = clamp(view.light, 0, 100) + precip;
  return clear > 0 ? Math.min(1, precip / clear) : 0;
}

/**
 * The outdoor recipe, under weather — {@link STORM_SUN_DIM} and its two siblings applied.
 *
 * **Identity at zero, and that is load-bearing.** A dry sky returns the *same object* `skyAt` made, so
 * a world with no storm in it is byte-for-byte M5b's, `indoors.skyFor`'s `blend <= 0` identity still
 * holds, and `daylight.test.ts`'s envelope sweep still describes what is on screen. Only the three
 * fields the storm has an opinion about are touched; the colours, the sun's position and the fog are
 * the hour's alone, because a storm that also moved the sun would be two systems arguing about where
 * the shadows fall.
 */
export function stormy(recipe: SkyRecipe, gloom: number): SkyRecipe {
  const g = clamp(Number.isFinite(gloom) ? gloom : 0, 0, 1);
  if (g <= 0) return recipe;
  return {
    ...recipe,
    name: `${recipe.name} (storm ${g.toFixed(2)})`,
    hemisphere: recipe.hemisphere * (1 - STORM_HEMISPHERE_DIM * g),
    sunIntensity: recipe.sunIntensity * (1 - STORM_SUN_DIM * g),
    exposure: recipe.exposure * (1 + STORM_EXPOSURE_LIFT * g),
  };
}

/* -------------------------------------------------------------------------- */
/* The held sky                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The last sky the server sent, the instant it landed, and whether a human has taken the wheel.
 *
 * Holds no `three` object and touches no renderer: it answers *what hour is it* and *what is falling*,
 * and `main.ts` does everything else with the answers. That is what lets the whole of this — the
 * interpolation, the override, the stale replacement, the resilience — be driven headlessly.
 *
 * **Three states, and the debug object reads all three** (`__debug3d.sky`):
 *
 * | | `served` | `overridden` | `live` | {@link hourAt} |
 * |---|---|---|---|---|
 * | Old server, or `welcome` not yet answered | no | no | no | `undefined` — the caller keeps its own default hour |
 * | Following the world | yes | no | **yes** | the interpolated hour |
 * | A human pressed `G` or a bracket | either | **yes** | no | the hour they chose, unmoving |
 */
export class SkyClock {
  private held: SkyView | undefined;
  private heldAt = 0;
  private manual: number | undefined;

  /**
   * A served sky. **Replaces whatever was held, whole**, which is the answer to a server that
   * restarted mid-session and is now a fortnight earlier in its year: there is no merging to do and
   * no field worth keeping, so the newest message simply *is* the sky. A payload that will not
   * sanitise is dropped and the previous one keeps running — a garbled message must not be able to
   * put the world at midnight.
   */
  accept(raw: unknown, now: number): SkyView | undefined {
    const clean = sanitiseSky(raw);
    if (!clean) return undefined;
    this.held = clean;
    this.heldAt = Number.isFinite(now) ? now : 0;
    return clean;
  }

  /** The last view accepted, exactly as the frame is reading it. `__debug3d.sky.view`. */
  get view(): SkyView | undefined {
    return this.held;
  }

  /** When it landed, on `performance.now()`'s clock. */
  get receivedAt(): number {
    return this.heldAt;
  }

  /** Whether the server has ever sent one. False against a server that predates the clock. */
  get served(): boolean {
    return this.held !== undefined;
  }

  /** Whether a human has taken the hour by hand. */
  get overridden(): boolean {
    return this.manual !== undefined;
  }

  /** Whether the frame's hour is coming from the world's clock right now. */
  get live(): boolean {
    return this.held !== undefined && this.manual === undefined;
  }

  /**
   * The hour to light this frame by, or `undefined` when there is nothing to say and the caller
   * should keep the hour it already has — which for a client talking to an old server is M4's
   * midnight, unchanged and un-errored.
   */
  hourAt(now: number): number | undefined {
    if (this.manual !== undefined) return this.manual;
    if (!this.held) return undefined;
    // Normalised *after* rounding: 23.9995 quantises up to a flat 24, and a caller comparing this
    // against its own `normaliseHour`d copy would see 24 against 0 and re-apply the sky every frame
    // for the 146 ms that lasts.
    return normaliseHour(quantiseHour(displayHourOf(this.held, this.heldAt, now)));
  }

  /** Take the hour by hand — `G`, `[`, `]`, `__debug3d.hour`. Returns the hour taken. */
  override(hour: number): number {
    this.manual = normaliseHour(Number.isFinite(hour) ? hour : 0);
    return this.manual;
  }

  /**
   * Give the hour back to the world — `Shift+G`.
   *
   * False when there is no world clock to give it back to, and the override is dropped anyway: the
   * caller keeps whatever hour it was showing, because there is nothing truer to return to. Saying so
   * in the log is better than silently pinning a sky the owner thinks they released.
   */
  resume(): boolean {
    this.manual = undefined;
    return this.held !== undefined;
  }

  /** What the world says is coming down. `'none'` when it has not said. */
  get falling(): Falling {
    return this.held ? fallingOf(this.held) : 'none';
  }

  /**
   * Whether the world wants rain drawn, or `undefined` when it has no opinion — which is what lets
   * `main.ts` write `override ?? world ?? true` and keep M4's always-on rain as the pre-clock default.
   */
  get raining(): boolean | undefined {
    return this.held ? rainVisibleFor(fallingOf(this.held)) : undefined;
  }

  /** How hard, 0..1, or `undefined` when the world has no opinion. */
  get rainDensity(): number | undefined {
    return this.held ? rainDensityOf(this.held) : undefined;
  }

  /** How much light the weather is eating, 0..1. Zero with no view, so the recipe is untouched. */
  get gloom(): number {
    return this.held ? gloomOf(this.held) : 0;
  }
}
