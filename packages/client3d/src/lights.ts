/**
 * The fixed pool of eight point lights — §3's answer to clustered lighting, implemented literally.
 *
 * > *"**Clustered Lighting** solves a problem you can avoid — a fixed startup pool of 8 point lights
 * > that are *re-parented and re-coloured, never created or destroyed*, is the correct design on
 * > forward WebGL anyway, because three recompiles a shader permutation per light count and a
 * > mid-frame compile is a visible hitch."*
 *
 * ## `visible` is the trap, and it is not obvious
 *
 * The natural way to switch a pooled light off is `light.visible = false`. That is the one thing this
 * class must never do. `WebGLLights.setup` counts **visible** lights, `WebGLPrograms` puts
 * `NUM_POINT_LIGHTS` in the program cache key, and a program is compiled the first time each count is
 * seen — so a pool that hides its spare lights recompiles every material in the scene on the frame a
 * campfire comes into range, and again on the frame it leaves. Eight lights hidden and shown
 * independently is nine permutations of every material, arrived at one stutter at a time.
 *
 * So: **all eight are added to the scene in the constructor, all eight stay `visible`, for ever, and a
 * light that is off has `intensity === 0`.** A zero-intensity light costs one loop iteration in the
 * fragment shader and nothing else. {@link LightPool.audit} states the invariant as data and
 * `lights.test.ts` asserts it across a long churn of assignments, because it is the kind of rule that
 * is broken by a one-line "optimisation" a year from now.
 *
 * ## What the eight are for
 *
 * Slot 0 is the **clearing light**: the plan's *"per-room clearing light: the player's current room
 * gets a warm light from the pool"*. It follows the character, not the room's centre, because the
 * character is where the light they are carrying is — which is also why {@link LightPool.clearing}
 * takes a radius. Today that radius is a constant; at M7 it is `SelfView`'s carried-light radius and
 * nothing else in this file changes. That is the whole of the hook the plan asks to keep simple.
 *
 * Slots 1..7 are **scene lights**, claimed by the nearest campfires among the loaded chunks. Seven is
 * not a budget decision; it is what is left, and the assignment is nearest-first so that running out
 * costs you the furthest one.
 *
 * ## The carrier is the one thing the carried light must not light
 *
 * The owner, 2026-08-13: *"when the player moves he lights up like the light source is around his
 * neck … the player doesn't need to light up at all. just his surroundings depending on his light
 * source"*. The diagnosis is in the wording. Slot 0 sits at the character's own position, `y + 1.5` —
 * **neck height** — with `decay 2`, and three clamps the falloff at `max(d², 0.01)`. Every surface
 * whose normal has any component pointing *inward* at that point (the chin, the tops of the shoulders,
 * the tops of the thighs) is 0.2–0.35 m from a light that the ground three metres away sees at 1/9th
 * the strength: a hundredfold difference, worn as a collar. The light is doing exactly what it was
 * written to do, and there is no position that fixes it — a light high enough to reach the ground is
 * high enough to scorch the scalp, and a light low enough to miss the body lights the floor edge-on
 * and not at all. **Geometry cannot separate a body from the ground it is standing on. Only exclusion
 * can.**
 *
 * ### And three's WebGL renderer cannot exclude a light from an object
 *
 * The obvious tool is `Object3D.layers`, and it is the wrong one — worth writing down, because the
 * documentation reads as though it were the right one. Every `layers.test` in `three@0.185.1`'s WebGL
 * path tests an object against a **camera**: `WebGLRenderer.projectObject` decides with it whether a
 * *light* is collected at all, the render-list loop decides with it whether an *object* is drawn, and
 * `WebGLShadowMap` decides with it whether an object casts. There is no `light.layers.test(object
 * .layers)` anywhere; the light list is assembled once per `renderer.render` and every object drawn by
 * that call is lit by all of it. (Per-light mesh exclusion is a Babylon feature, and a WebGPU one.)
 *
 * So the exclusion has to be a **second render call with a different camera** — one pass for the
 * world, one for the body — and that is what `post.BodyPass` is. What lives here is its switch:
 * {@link LightPool.muteClearing} zeroes slot 0 for the length of the body pass and
 * {@link LightPool.unmuteClearing} puts it back, which is this file's own doctrine rather than a new
 * one — *a light that is off has `intensity === 0`*. Doing it by `visible`, or by dropping slot 0 off
 * {@link SELF_LAYER} so the body pass collected seven point lights instead of eight, would change
 * `NUM_POINT_LIGHTS` between the two passes and compile a second permutation of every material a body
 * is made of. Both passes see eight, and the eight are the same eight.
 */

import { Color, PointLight, Scene } from 'three';

/**
 * The layer everything that is not the player's own body is drawn on — three's default, and the
 * default mask of every camera and every object ever constructed.
 *
 * Named rather than written as `0` because it is now half of a pair, and a bare zero at the call
 * sites would read as "reset the layers" rather than as "this belongs to the world".
 */
export const WORLD_LAYER = 0;

/**
 * The layer the player's own body — rig, garments, hair, held props, or the capsule standing in for
 * all of it — is drawn on, and **only** it.
 *
 * The main camera renders {@link WORLD_LAYER}, so the body is invisible to it; `post.BodyPass`'s
 * camera renders this one and nothing else, so the body is the only thing that pass draws. Every
 * light in the scene is enabled on **both** layers, because the body must still be lit by the
 * hemisphere, the moon and M6's interior key — the clearing light is excluded by being muted for the
 * length of that pass, not by being kept off this layer. See the header for why that distinction is
 * load-bearing rather than stylistic.
 *
 * **1, not 10.** `postprocessing`'s `Selection` claims layer 10 by default and `post.ts` uses one for
 * the bloom, so that number is spoken for; nothing else in this renderer touches `layers` at all.
 */
export const SELF_LAYER = 1;

/** The plan's number, and the only light count this renderer will ever compile a shader for. */
export const LIGHT_POOL_SIZE = 8;

/** Slot 0. Reserved for the character, always, even when nothing is standing there. */
export const CLEARING_SLOT = 0;

/** Warm against a blue-teal night — the contrast that makes a clearing read as sheltered. */
export const CLEARING_COLOUR = 0xffb877;

/** A campfire is oranger and dirtier than a lantern. */
export const FIRE_COLOUR = 0xff8a3c;

/**
 * Metres of reach for the clearing light when nothing says otherwise.
 *
 * `vision.DEFAULT_LIGHT_RADIUS` is 2 *tiles*, which is the radius at which the server reveals the
 * collision grid — a fog-of-war number, not a photometric one, and a 2 m lamp in a 9 m room lights
 * the character's feet and nothing else. This is the visual radius and it is deliberately its own
 * constant until M7 gives the two a reason to meet.
 */
export const CLEARING_RADIUS = 7;

/**
 * Candela at one metre of radius, before the inverse-square falloff.
 *
 * Scaled by radius squared in {@link LightPool.clearing} so that widening the light keeps the same
 * brightness *at its rim* rather than washing out the middle — which is what makes "a bigger lantern"
 * read as bigger rather than as brighter.
 */
export const CLEARING_CANDELA = 0.16;

/** Campfires are dimmer than the thing the player is carrying and are meant to be looked *at*. */
export const FIRE_RADIUS = 6;
export const FIRE_CANDELA = 0.11;

/** Metres past which a light contributes nothing. Three's window term; keeps the falloff bounded. */
function reachOf(radius: number): number {
  return radius * 2.2;
}

function candelaOf(candela: number, radius: number): number {
  return candela * radius * radius;
}

/** A light source the world wants lit, in metres. */
export interface LightRequest {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Squared distance from the camera focus. The only thing nearest-first ordering needs. */
  readonly rank: number;
}

/** What the pool is doing right now — `__debug3d.lightsInUse` and the test's invariant, one shape. */
export interface LightAudit {
  /** Always {@link LIGHT_POOL_SIZE}. A different number means something created or removed a light. */
  readonly total: number;
  /** Lights with a non-zero intensity. The number a human means by "how many lights are on". */
  readonly lit: number;
  /** Always {@link LIGHT_POOL_SIZE}. **If this ever differs from `total`, a shader recompiled.** */
  readonly visible: number;
  /** Constructed, ever. Equal to `total` for the life of the process. */
  readonly created: number;
}

export class LightPool {
  private readonly lights: PointLight[] = [];
  private readonly warm = new Color(CLEARING_COLOUR);
  private readonly fire = new Color(FIRE_COLOUR);
  private created = 0;
  /**
   * Slot 0's candela while it is muted, or `undefined` when it is not — see {@link muteClearing}.
   *
   * A field rather than a caller-held value so the mute cannot be lost by an exception thrown
   * between the two halves of a render pass, and so a second mute inside the first cannot overwrite
   * the saved intensity with the zero the first one wrote.
   */
  private muted: number | undefined;

  constructor(scene: Scene) {
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      // Decay 2 is the physical inverse square. Anything else makes a light that reads as fog.
      const light = new PointLight(CLEARING_COLOUR, 0, reachOf(CLEARING_RADIUS), 2);
      light.castShadow = false;
      light.visible = true;
      // **All eight on both layers, including slot 0.** The body pass must see the same eight point
      // lights the world pass does or `NUM_POINT_LIGHTS` differs between them and every material a
      // body is made of compiles a second time. Slot 0 is kept off the body by {@link muteClearing},
      // which is an intensity and therefore a uniform. See the header.
      light.layers.enable(SELF_LAYER);
      light.position.set(0, 0, 0);
      this.lights.push(light);
      scene.add(light);
      this.created += 1;
    }
  }

  get size(): number {
    return this.lights.length;
  }

  /** Read-only view, for the test that has to walk every light and check `visible`. */
  at(index: number): PointLight | undefined {
    return this.lights[index];
  }

  /**
   * The character's own light. Slot 0, every frame, whether or not it is lit.
   *
   * `radius` is the hook: a carried torch widens it, a darkness spell narrows it, and `intensity`
   * follows by the square so the rim keeps its brightness. Passing 0 turns the slot off without
   * touching `visible`.
   */
  clearing(x: number, y: number, z: number, radius = CLEARING_RADIUS): void {
    const light = this.lights[CLEARING_SLOT];
    if (!light) return;
    light.position.set(x, y, z);
    light.color.copy(this.warm);
    light.distance = reachOf(radius);
    const candela = radius > 0 ? candelaOf(CLEARING_CANDELA, radius) : 0;
    // **Written through the mute, not around it.** The mute spans one render pass and this is called
    // from the frame loop outside it, so today the two never overlap — but a write that landed on the
    // live light while it was muted would be undone by `unmuteClearing` restoring the candela from
    // before, and the clearing light would be one frame stale for ever after with nothing to show for
    // it. The saved value is the truth while muted; the light itself stays at zero.
    if (this.muted !== undefined) this.muted = candela;
    else light.intensity = candela;
  }

  /**
   * Re-point slots 1.. at the nearest requests and zero whatever is left over.
   *
   * Sorted rather than taken in arrival order so that walking toward a campfire lights it before the
   * one behind you goes out. The sort is over at most a window's worth of entries and only runs when
   * the loaded set changes, which is once per stride cell crossed.
   */
  scene(requests: readonly LightRequest[]): void {
    const ordered = [...requests].sort((a, b) => a.rank - b.rank);
    for (let slot = CLEARING_SLOT + 1; slot < this.lights.length; slot++) {
      const light = this.lights[slot];
      if (!light) continue;
      const request = ordered[slot - CLEARING_SLOT - 1];
      if (!request) {
        // Off, not hidden. See the header: `visible` is the one property that must not move.
        light.intensity = 0;
        continue;
      }
      light.position.set(request.x, request.y, request.z);
      light.color.copy(this.fire);
      light.distance = reachOf(FIRE_RADIUS);
      light.intensity = candelaOf(FIRE_CANDELA, FIRE_RADIUS);
    }
  }

  /**
   * Take slot 0 out of the frame for the length of the body pass — the owner's report, answered.
   *
   * *"the player doesn't need to light up at all. just his surroundings depending on his light
   * source."* The surroundings are drawn by the world pass, with slot 0 at whatever
   * {@link LightPool.clearing} last wrote; the body is drawn by `post.BodyPass` with slot 0 at zero,
   * and the two are the same eight lights in the same eight slots. See the header for why this is a
   * mute rather than a layer, and why it is an intensity rather than a `visible`.
   *
   * Re-entrant by refusal: a second mute inside the first is ignored, so the saved candela is always
   * the one the world pass will draw with.
   */
  muteClearing(): void {
    if (this.muted !== undefined) return;
    const light = this.lights[CLEARING_SLOT];
    if (!light) return;
    this.muted = light.intensity;
    light.intensity = 0;
  }

  /**
   * Put slot 0 back. Called from a `finally`, so a throw inside the body pass costs one dark frame
   * rather than a world that never lights up again.
   */
  unmuteClearing(): void {
    const held = this.muted;
    if (held === undefined) return;
    this.muted = undefined;
    const light = this.lights[CLEARING_SLOT];
    if (light) light.intensity = held;
  }

  /** Whether slot 0 is currently muted. `__debug3d`, and the test that drives a pass by hand. */
  get clearingMuted(): boolean {
    return this.muted !== undefined;
  }

  /** Every slot off. An arrival at a new Place, before anything has said what is lit there. */
  darken(): void {
    // A mute outlives a `darken` only in the sense that the saved candela does; dropping it here
    // would put the old clearing light back the moment the pass ended, in a Place that has not said
    // it is lit yet. Whatever `clearing` writes next is what `unmuteClearing` will restore.
    if (this.muted !== undefined) this.muted = 0;
    for (const light of this.lights) light.intensity = 0;
  }

  audit(): LightAudit {
    let lit = 0;
    let visible = 0;
    for (const light of this.lights) {
      if (light.intensity > 0) lit += 1;
      if (light.visible) visible += 1;
    }
    return { total: this.lights.length, lit, visible, created: this.created };
  }

  dispose(): void {
    for (const light of this.lights) {
      light.removeFromParent();
      light.dispose();
    }
    this.lights.length = 0;
  }
}
