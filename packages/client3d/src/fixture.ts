/**
 * A hand-built zone, for the tests that must not depend on `data/world`.
 *
 * Three of the seven test files sweep the real world and skip themselves when it is absent (it is
 * git-ignored and reproducible with `npm run worldgen`). The other four assert *geometry* — that a
 * barrier is thicker than an edge, that a full-span outdoor mouth grows no wall, that a door leaf
 * appears — and those must run on a checkout that has never generated a world, or the invariants
 * they guard are only checked on one machine.
 *
 * Deliberately small and deliberately shaped: a 3x1 row of rooms with one of every edge class
 * between them. `edge`, `barrier`, `open` at both widths, `door` and `portal` all occur, which is
 * every branch in `classifyEdge` that produces geometry.
 *
 * Not a `.test.ts` file, so `node --test` does not try to run it.
 */

import { boundsOf, type Room, type Sector, type Zone } from '@mygame/shared';

import {
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
} from './rig.ts';

/**
 * The four corners of M6's dolly clamp — `[distance, pitch]`.
 *
 * Shared from here rather than restated in each test file, and rather than exported from one test
 * file into another (which would run that file's `describe`s twice). Four files walk this list:
 * `rig.test.ts` for the ring and the shadow volume, `foliage.test.ts` for the fade bands,
 * `unproject.test.ts` for the pointer's round trip, and `dolly.test.ts` for the clamp itself. Every
 * consequence of the frame is monotone in both axes, so the extremes are the corners — and a
 * milestone whose whole point is that the pose *moves* cannot be tested at one pose.
 */
export const CLAMP_CORNERS: readonly (readonly [distance: number, pitch: number])[] = [
  [CAMERA_DISTANCE_MIN, CAMERA_PITCH_MIN],
  [CAMERA_DISTANCE_MIN, CAMERA_PITCH_MAX],
  [CAMERA_DISTANCE_MAX, CAMERA_PITCH_MIN],
  [CAMERA_DISTANCE_MAX, CAMERA_PITCH_MAX],
];

/**
 * Yaws to sweep — M8's third axis, and it is **swept rather than cornered.**
 *
 * The distance and the pitch have ends and every consequence of them is monotone, so four corners are
 * the whole domain. A yaw has neither: it wraps, and the things derived from it are worst *between*
 * the cardinals rather than at them — the ring's tightest case is the diagonal, the near-wall fade
 * answers two walls there instead of one, and an axis-aligned box around a rotated frame is biggest
 * at 45°. A test that took "the corners" of the yaw would take exactly the four angles at which
 * everything is easiest.
 *
 * 7° rather than a round number, deliberately: 360 is divisible by every round step anybody would
 * reach for, and a stride that lands on the cardinals and the diagonals is a stride that never
 * samples the awkward angles. This one visits 52 yaws, hits no cardinal exactly, and comes within
 * 3.5° of every angle on the circle.
 */
export const SWEEP_YAWS: readonly number[] = Array.from({ length: Math.ceil(360 / 7) }, (_, i) => -180 + i * 7);

/** The eight angles worth naming when a test wants a handful rather than a sweep. */
export const CARDINAL_YAWS: readonly number[] = [0, 45, 90, 135, 180, -135, -90, -45];

interface RoomSpec {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly sector: Sector;
  readonly exits?: Room['exits'];
  readonly flags?: Room['flags'];
}

export function zoneOf(specs: readonly RoomSpec[], id = 900, seamless = false): Zone {
  const rooms: Room[] = specs.map((spec) => ({
    id: spec.id,
    zone: id,
    name: `room ${spec.id}`,
    sector: spec.sector,
    pos: { x: spec.x, y: spec.y, z: spec.z ?? 0 },
    exits: spec.exits ?? {},
    ...(spec.flags ? { flags: spec.flags } : {}),
  }));
  return {
    id,
    name: 'a test zone',
    rooms,
    bounds: boundsOf(rooms),
    ...(seamless ? { seamless: true } : {}),
  };
}

/**
 * Two outdoor rooms that merge along their whole shared edge (M0's carve), a walled indoor room
 * behind a door, an unreachable room across a barrier, and a portal with nowhere to go.
 *
 * ```
 *        (1,0) barrier-only, unreachable from anywhere
 *          |
 *  (0,1)--(1,1)--(2,1)      (0,1)<->(1,1) is field<->field: a nine-tile merge
 *   forest field  inside     (1,1)<->(2,1) has a door: a three-tile gate
 *                            (2,1) also has an east portal
 * ```
 */
export function sampleZone(): Zone {
  return zoneOf([
    { id: 1, x: 1, y: 0, sector: 'field' },
    { id: 2, x: 0, y: 1, sector: 'forest', exits: { east: { to: 3 } } },
    {
      id: 3,
      x: 1,
      y: 1,
      sector: 'field',
      exits: { west: { to: 2 }, east: { to: 4, door: { name: 'a door', closed: true, locked: false } } },
    },
    {
      id: 4,
      x: 2,
      y: 1,
      sector: 'inside',
      exits: {
        west: { to: 3, door: { name: 'a door', closed: true, locked: false } },
        east: { to: 99, portal: true },
      },
      flags: ['indoors'],
    },
  ]);
}
