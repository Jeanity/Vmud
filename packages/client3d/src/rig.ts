/**
 * The camera rig — §3's spec, and the one place a degree is turned into a position.
 *
 * ```
 * camera: PerspectiveCamera, fov 30°, pitch 64°, pulled back along +Z, up = (0, 1, 0)
 * ```
 *
 * Every constant in that line already exists in `space.ts` and is imported rather than restated,
 * because the pitch in particular is a **safety limit** with its reasoning attached: at 90° the view
 * direction is parallel to the up vector and the basis degenerates, so the frame flips or blanks
 * depending on which way the last floating-point comparison fell. The constructor asserts it rather
 * than trusting the import, which costs one comparison at boot and makes the failure loud instead of
 * intermittent.
 *
 * **Perspective, not orthographic**, and the plan is worth quoting because the reflex goes the other
 * way for a three-quarter view: *"Rain streaks under ortho become identical parallel lines with no
 * depth spread, trees don't lean outward at frame edges, and post-processing support for ortho is
 * patchier. That parallax is most of what reads as modern indie 3D."*
 *
 * ## Yaw is fixed, and north is up the screen
 *
 * `space.ts` fixes `+Z` as south, so a camera pulled back along `+Z` looks north and the world's
 * north is the top of the frame — the same reading the Phaser client has always had, which is what
 * makes the 2D map and the 3D view describe the same place to a player who has both open. Free yaw
 * is not a missing feature at M3; it is a decision that would change how every wall occludes, and it
 * belongs after M4 has settled what the light does.
 *
 * ## The follow is rigid
 *
 * The camera is the character's position plus a constant offset, with no smoothing at all. The
 * Phaser client's camera lerp exists to hide a *sprite* being reconciled; here the body is already
 * eased (`entities.ts` carries the same 0.12 and 0.22 it always did) and a second filter on top of
 * the first is two time constants to tune and one of them invisible. M4 can add lag when there is a
 * reason to.
 */

import { PerspectiveCamera } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES } from '@mygame/shared';

/**
 * Metres from the character to the camera.
 *
 * Chosen from the window rather than by eye. At a 30° vertical field the ground the frame covers is
 * `2·D·tan(15°)·aspect` across and `2·D·tan(15°)/sin(64°)` deep, so at 16:9 that is `0.95·D` by
 * `0.60·D` metres. 36 m gives 34 x 22 m — a little over three stride cells by two — which sits
 * comfortably inside `streamer.ts`'s 5x3 footprint with its margin ring to spare. Move this and the
 * window has to move with it; the test asserts the pair still agree.
 */
export const CAMERA_DISTANCE = 36;

const RADIANS = Math.PI / 180;

export class CameraRig {
  readonly camera: PerspectiveCamera;
  /** Metres of the offset, precomputed: `(0, D·sin θ, D·cos θ)`. */
  private readonly offsetY: number;
  private readonly offsetZ: number;

  constructor(aspect = 1) {
    if (!(CAMERA_PITCH_DEGREES < 90)) {
      throw new Error(`camera pitch must stay under 90°, got ${CAMERA_PITCH_DEGREES}`);
    }
    this.camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, aspect, 0.5, 240);
    this.camera.up.set(0, 1, 0);
    const pitch = CAMERA_PITCH_DEGREES * RADIANS;
    this.offsetY = CAMERA_DISTANCE * Math.sin(pitch);
    this.offsetZ = CAMERA_DISTANCE * Math.cos(pitch);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = height === 0 ? 1 : width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Point the rig at a world position, in metres. */
  follow(x: number, y: number, z: number): void {
    this.camera.position.set(x, y + this.offsetY, z + this.offsetZ);
    this.camera.lookAt(x, y, z);
  }

  /** The ground extent the frame covers, in metres — what `streamer.ts`'s window is sized against. */
  footprint(): { width: number; depth: number } {
    const half = Math.tan((CAMERA_FOV_DEGREES / 2) * RADIANS) * CAMERA_DISTANCE;
    return {
      width: 2 * half * this.camera.aspect,
      depth: (2 * half) / Math.sin(CAMERA_PITCH_DEGREES * RADIANS),
    };
  }
}
