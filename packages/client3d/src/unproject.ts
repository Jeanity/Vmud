/**
 * Pointer to ground — a screen point through the rig's camera onto a horizontal plane. New, for
 * click-to-move and hold-to-steer.
 *
 * The plan priced this against `three-mesh-bvh` (`PLAN-3d-migration.md:84`, *"for click-to-move
 * raycasts"*) and M0's `world3d.ts` still carries the forward reference (`groundAt`'s docblock: *"needs
 * neither `three-mesh-bvh`… nor a loaded chunk"*). Neither is needed at grey-box: every room's ground is
 * one flat slab (`chunkPlan.roomElevation`), so the question a click asks is answered exactly by where a
 * ray meets the **plane** the character is already standing on, not by where it meets a mesh. Adding a
 * BVH would buy nothing this milestone can spend — there is no sloped or layered geometry yet for a mesh
 * raycast to answer that a plane does not — and it is a dependency this port was told not to add.
 *
 * ## The maths
 *
 * `Raycaster.setFromCamera` builds a world-space ray from a normalised device coordinate through the
 * camera's own projection and view matrices — the exact inverse of the `Vector3.project` that
 * `rig.test.ts` already leans on to check the forward direction. `Ray.intersectPlane` then walks that
 * ray to `y = groundY`. Two renderer-metre numbers out, no mesh, no BVH, no allocation. `undefined`
 * comes back only when the ray cannot meet the plane in front of the camera — the pitch is fixed at 64°
 * (`rig.ts`), so in practice that is a pointer above the horizon, empty sky at grey-box.
 */

import { Plane, Raycaster, Vector2, Vector3, type PerspectiveCamera } from 'three';

/** Renderer metres. Deliberately the same shape as `space.ts`'s `RenderPoint` without importing it —
 * this file has no `@mygame/shared` dependency, on the same reasoning `space.ts` gives for having
 * none of its own: the maths is true regardless of what, if anything, is on the other end of it. */
export interface GroundHit {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

// Scratch, module-level and reused: this runs on every held frame while the player is steering, and
// the one allocation rule this codebase keeps everywhere else (`pool.ts`, `entities.ts`'s `scratch`)
// applies here too, even though nothing here is pooled in the `ScenePool` sense.
const scratchNDC = new Vector2();
const scratchPlane = new Plane();
const scratchTarget = new Vector3();
const scratchRaycaster = new Raycaster();
const UP = new Vector3(0, 1, 0);

/**
 * Where the pointer's ray meets the horizontal plane `y = groundY`, in renderer metres.
 *
 * `ndcX`/`ndcY` are normalised device coordinates in `[-1, 1]` — screen-agnostic, so the caller owns
 * turning a `PointerEvent` into this pair (`pointer.ts`'s `ndcOfEvent`) and this function owns nothing
 * about the DOM. `groundY` is the plane's height, not derived here: the caller passes the *player's own*
 * elevation (`World3D.groundAt` at the player's position), because at grey-box that is the one ground
 * the click is judged against — see the file header on why a single flat plane is the right amount of
 * truth at this milestone.
 */
export function unprojectToGround(
  camera: PerspectiveCamera,
  ndcX: number,
  ndcY: number,
  groundY: number,
): GroundHit | undefined {
  scratchRaycaster.setFromCamera(scratchNDC.set(ndcX, ndcY), camera);
  // The plane `y = groundY`: normal (0,1,0), constant `-groundY`, so that for any point `p` on it
  // `normal·p + constant === p.y - groundY === 0`.
  scratchPlane.set(UP, -groundY);
  const hit = scratchRaycaster.ray.intersectPlane(scratchPlane, scratchTarget);
  return hit ? { x: hit.x, y: hit.y, z: hit.z } : undefined;
}
