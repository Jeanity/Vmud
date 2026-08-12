/**
 * The ground displacement field — one function, world-constant, no state.
 *
 * `RoomScene.ground.elevation` carries a {@link GroundNoise} rather than a height, and the header of
 * `roomScene.ts` says why the seed is world-constant: *"neighbouring chunks then agree at their seams
 * without communicating; a per-zone or per-component seed would reintroduce exactly the mismatch that
 * buys."* This file is the other half of that contract — the evaluation — and it has the same
 * property for the same reason: it reads a **world position** and nothing else, so two rooms, two
 * chunks and two clients that never speak agree on the height where they meet.
 *
 * Value noise on an integer lattice, bilinear with a smoothstep fade, hashed with `hashCell`. Not
 * gradient noise: gradient noise is better-looking and needs a permutation table, and a table is
 * state that has to be built identically everywhere. `hashCell` is already the project's determinism
 * contract and is already imported by everything that places anything, so the cheapest correct
 * answer is to key the lattice on it.
 *
 * At M3 the field is sampled **once per room, at the room's centre**, and the ground is a flat slab
 * at that height. The plan's subdivided, per-vertex displaced ground is M5's; sampling one point now
 * costs one hash per room and means the flat grey slabs already sit at the heights the real terrain
 * will have, so a level's shape is legible before there is a mesh to show it.
 */

import { hashCell, type GroundNoise } from '@mygame/shared';

/** `hashCell` returns an unsigned 32-bit integer; this is the divisor that maps it onto `[0, 1)`. */
const HASH_RANGE = 0x1_0000_0000;

/** One lattice corner's value, in `[-1, 1]`. */
function corner(seed: number, ix: number, iz: number): number {
  return (hashCell(ix, iz, 0, seed) / HASH_RANGE) * 2 - 1;
}

/** Hermite fade. Kills the lattice's linear creases without the cost of a cubic interpolation. */
function fade(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Metres of displacement at a world position, either side of the component's base.
 *
 * `x` and `z` are renderer metres in the frame's own space, which is what makes the field agree
 * across chunk boundaries — a chunk never offsets its samples into a local space.
 */
export function groundNoise(noise: GroundNoise, x: number, z: number): number {
  const u = x * noise.frequency;
  const v = z * noise.frequency;
  const iu = Math.floor(u);
  const iv = Math.floor(v);
  const fu = fade(u - iu);
  const fv = fade(v - iv);

  const a = corner(noise.seed, iu, iv);
  const b = corner(noise.seed, iu + 1, iv);
  const c = corner(noise.seed, iu, iv + 1);
  const d = corner(noise.seed, iu + 1, iv + 1);

  const top = a + (b - a) * fu;
  const bottom = c + (d - c) * fu;
  return (top + (bottom - top) * fv) * noise.amplitude;
}
