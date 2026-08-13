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

import { CAMERA_PITCH_DEGREES, boundsOf, type Room, type Sector, type Zone } from '@mygame/shared';

import {
  CAMERA_DISTANCE,
  CAMERA_DISTANCE_MAX,
  CAMERA_DISTANCE_MIN,
  CAMERA_PITCH_FLOOR,
  CAMERA_PITCH_MAX,
  CAMERA_PITCH_MIN,
  PITCH_FLOOR_KNEE,
  pitchFloorFor,
} from './rig.ts';

/**
 * How many rungs the ladder of distances has. Thirteen samples, `32^(1/12)` = 1.335x apart.
 *
 * Geometric rather than linear because the dolly is: `dolly.DOLLY_RATIO` is a *ratio*, so equal
 * numbers of wheel notches are equal ratios of distance, and a linear ladder would spend eight of its
 * thirteen samples between 60 and 96 m — the stretch where the envelope is a straight line and
 * nothing interesting happens — while stepping over the whole portrait band in one.
 */
const ENVELOPE_RUNGS = 12;

/**
 * The **envelope** M9's dolly clamp became — `[distance, pitch]`, and it is a boundary walk rather
 * than a corner list.
 *
 * Shared from here rather than restated in each test file, and rather than exported from one test
 * file into another (which would run that file's `describe`s twice). Four files walk this list:
 * `rig.test.ts` for the ring and the shadow volume, `foliage.test.ts` for the fade bands,
 * `unproject.test.ts` for the pointer's round trip, and `dolly.test.ts` for the clamp itself.
 *
 * ## Why the corners of a rectangle stopped being the right sample set
 *
 * Until M9 the clamp was `[24, 96] x [45°, 64°]` and every consequence of the frame was monotone in
 * both axes, so the four corners *were* the whole domain: no interior point could be worse than all
 * four. M9 made the pitch floor a function of the distance ({@link rig.pitchFloorFor}), and a curved
 * boundary has no corners — the extremes now live **along** the floor, at distances no corner list
 * would name. Worse, the thing the ring is sized against is not monotone along that floor: measured
 * at 16:9 the frame's circumradius runs 21.9 m at 3 m, rises to 46.4 m at the knee, **dips** to
 * 46.0 m at 16 m and then climbs to 81.6 m at full pull-back. A sampler that took the two ends would
 * have missed the middle, and the middle is where a wide canvas breaks first.
 *
 * So: a geometric ladder of distances, and at each rung **both** edges of the envelope — the
 * shallowest pitch reachable there and the steepest. The interior needs no samples because pitch is
 * still monotone at fixed distance; it is the *distance* axis that stopped being sortable.
 *
 * ## The four old corners are in the list, deliberately
 *
 * All four are still legal poses (the floor at 24 m is 24.07°, well under 45°), so appending them
 * makes the pre-M9 rectangle a literal subset of what every test walks — which is the cheapest
 * possible guard against M9 having moved something in the range the owner has actually been playing
 * in for two days. {@link rig.CAMERA_DISTANCE}/{@link rig.CAMERA_PITCH_DEGREES} — home — is in for the
 * same reason, and the knee because a piecewise curve should always be sampled at its kink.
 */
export const ENVELOPE_POSES: readonly (readonly [distance: number, pitch: number])[] = (() => {
  const seen = new Set<string>();
  const out: (readonly [number, number])[] = [];
  const add = (distance: number, pitch: number): void => {
    const key = `${distance.toFixed(6)}:${pitch.toFixed(6)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([distance, pitch]);
  };
  const span = CAMERA_DISTANCE_MAX / CAMERA_DISTANCE_MIN;
  for (let rung = 0; rung <= ENVELOPE_RUNGS; rung++) {
    const distance = CAMERA_DISTANCE_MIN * span ** (rung / ENVELOPE_RUNGS);
    add(distance, pitchFloorFor(distance));
    add(distance, CAMERA_PITCH_MAX);
  }
  // The kink, and the pre-M9 rectangle. See the docblock.
  add(PITCH_FLOOR_KNEE, CAMERA_PITCH_FLOOR);
  add(PITCH_FLOOR_KNEE, CAMERA_PITCH_MAX);
  add(CAMERA_DISTANCE, CAMERA_PITCH_DEGREES);
  for (const distance of [24, CAMERA_DISTANCE_MAX]) {
    add(distance, CAMERA_PITCH_MIN);
    add(distance, CAMERA_PITCH_MAX);
  }
  return out;
})();

/**
 * The pre-M9 clamp's four corners, kept under their own name for the tests that assert **nothing
 * moved in the range that already existed**.
 *
 * Not a deprecated alias: `ENVELOPE_POSES` answers "is every reachable pose still affordable" and
 * this answers the different question "is the frame at the poses the owner has been using this week
 * the same frame it was". Both are worth asking and only one of them is allowed to change.
 */
export const LEGACY_CLAMP_CORNERS: readonly (readonly [distance: number, pitch: number])[] = [
  [24, CAMERA_PITCH_MIN],
  [24, CAMERA_PITCH_MAX],
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
