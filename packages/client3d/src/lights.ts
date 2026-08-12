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
 */

import { Color, PointLight, Scene } from 'three';

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

  constructor(scene: Scene) {
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      // Decay 2 is the physical inverse square. Anything else makes a light that reads as fog.
      const light = new PointLight(CLEARING_COLOUR, 0, reachOf(CLEARING_RADIUS), 2);
      light.castShadow = false;
      light.visible = true;
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
    light.intensity = radius > 0 ? candelaOf(CLEARING_CANDELA, radius) : 0;
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

  /** Every slot off. An arrival at a new Place, before anything has said what is lit there. */
  darken(): void {
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
