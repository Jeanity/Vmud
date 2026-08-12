/**
 * The destination ring click-to-move drops under the pointer — `scene.ts:2749-2765`'s `pathMarker`,
 * carried over as a pooled wrapper rather than a Phaser `Graphics` circle.
 *
 * One wrapper, acquired once and never released — `entities.ts`'s `selfMesh`/`otherMesh` pattern
 * exactly, not the per-chunk streaming one: a marker is not terrain, it does not stream, and there is
 * ever at most one of it. See `prototypes.ts`'s header for why that earned its own archetype rather
 * than repainting `glow` or `portal`.
 *
 * ## What moved and what did not, against the 2D marker
 *
 * The 2D marker is positioned by `drawPath`, which is called from the `path` message handler with the
 * server's own route — never from the click itself. This carries over unchanged: `main.ts` calls
 * {@link Marker.show} from its `net.on('path', …)` handler, at the *last* point of the server's route,
 * not from wherever the pointer's ray happened to land. Two consequences fall out for free, both
 * already true of the donor and both worth stating because a click-time marker would lose them:
 *
 * - **A refused click leaves the marker alone.** The server answers a refusal with `pathFailed`, never
 *   with an empty `path`, so a click on unreachable-but-seen ground does not blank out the ring the
 *   character is still walking toward — `scene.ts:2808-2809`'s *"a refused destination does not cancel
 *   the one the character is still walking"*, true here for the same reason: nothing in `main.ts`
 *   touches the marker except the `path` handler.
 * - **The client-side seen-gate needs no marker-side plumbing at all.** A click on unseen ground never
 *   reaches the server (`pointer.ts`), so no `path` ever arrives for it, so the marker simply never
 *   moves. The gate and the marker do not know about each other.
 *
 * ## The pulse
 *
 * `scene.ts:2756-2764` tweens the Phaser marker's *scale*, 0.8 to 1.3 over a 640 ms yoyo,
 * `Sine.easeInOut`, forever. That is a closed-form wave once written out — a yoyo's up-leg and down-leg
 * are one half-period each, so the full period is 1.28 s — and reproducing it that way avoids pulling a
 * tween runtime into a renderer that does not otherwise have one. It deliberately does **not** reuse
 * `pool.ts`'s portal pulse (`ScenePool.pulse`, an emissive-intensity swing): that would change what
 * breathes from the ring's *size* to its *brightness*, a different look than the one being ported, for
 * a mechanism that exists to serve one archetype (`portal`) already spoken for.
 */

import { Object3D, type InstancedMesh, type Scene } from 'three';

import { DIMENSIONS } from './prototypes.ts';
import type { ScenePool } from './pool.ts';

/** Midpoint and half-swing of the 0.8-1.3 scale range — `scene.ts:2758`. */
const PULSE_MID = (0.8 + 1.3) / 2;
const PULSE_AMPLITUDE = (1.3 - 0.8) / 2;

/** Full-cycle frequency, in Hz, of a 640 ms yoyo (up-leg + down-leg = one period). `scene.ts:2760`. */
const PULSE_HZ = 1 / (2 * 0.64);

export class Marker {
  private readonly mesh: InstancedMesh;
  private readonly pool: ScenePool;
  private readonly scratch = new Object3D();
  private shown = false;
  private x = 0;
  private y = 0;
  private z = 0;

  constructor(scene: Scene, pool: ScenePool) {
    this.pool = pool;
    this.mesh = pool.acquire('torus', 'marker');
    // Never painted with `pool.paint`, so the wrapper keeps the plain-white `instanceColor` every
    // mint starts with — the same choice `entities.ts` makes for `self`/`other` and the same reason:
    // fog of war is a statement about terrain, and this is not terrain.
    scene.add(this.mesh);
  }

  /** Whether a destination is currently drawn — `__debug3d` reads this indirectly through `pointer.ts`. */
  get visible(): boolean {
    return this.shown;
  }

  /**
   * Shows the ring at a ground position, in renderer metres. `y` is the *ground's* elevation — this
   * file adds {@link DIMENSIONS.glowLift}, the same clearance the stairwell marker uses, so the tube
   * does not z-fight the slab beneath it.
   */
  show(x: number, y: number, z: number): void {
    this.shown = true;
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Clears the destination. The protocol's "no path" (an empty `path` message) — `scene.ts:2775-2778`. */
  hide(): void {
    this.shown = false;
    this.mesh.count = 0;
  }

  /**
   * Once a frame while shown: rewrites the one instance with the current breath of the pulse.
   *
   * `seconds` is wall-clock, matching `ScenePool.pulse`'s own reasoning — an accumulator would run at a
   * different rate on a different machine, and there is no state here that a variable frame rate could
   * corrupt, only a phase nobody has promised to keep in sync with anything else.
   */
  pulse(seconds: number): void {
    if (!this.shown) return;
    const swing = PULSE_MID + PULSE_AMPLITUDE * Math.sin(seconds * PULSE_HZ * Math.PI * 2);
    const radius = DIMENSIONS.glowRadius * swing;
    this.scratch.position.set(this.x, this.y + DIMENSIONS.glowLift, this.z);
    // Flat on the ground, exactly `chunkPlan.ts`'s `planStairGlow`: rx = pi/2 lays the unit torus into
    // the XZ plane so it reads from the 64 degree camera the way a mark on the ground should, rather
    // than edge-on the way a stairwell's own vertical ring is deliberately not drawn.
    this.scratch.rotation.set(Math.PI / 2, 0, 0);
    this.scratch.scale.setScalar(radius);
    this.scratch.updateMatrix();
    this.mesh.setMatrixAt(0, this.scratch.matrix);
    this.mesh.count = 1;
    this.pool.finish(this.mesh);
  }
}
