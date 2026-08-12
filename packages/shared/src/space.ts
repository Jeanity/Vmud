/**
 * The coordinate adapter — simulation space to renderer space. M0, `docs/PLAN-3d-migration.md` §3.
 *
 * **Write this first, in one file, with a test.** The plan says so and it is right: a mirrored world
 * is the same class of bug as the three direction encodings already listed in `CLAUDE.md` — every
 * frame looks entirely plausible, every room is in the wrong place, and you find out weeks later when
 * a player says the inn is on the wrong side of the road. One file, one axis map, one test that
 * fails loudly if a sign flips.
 *
 * ```
 * WORLD_SCALE = 1/32           renderer metres = simulation pixels / 32
 * renderer.x  =  sim.x / 32    east   -> +X, screen-right
 * renderer.z  =  sim.y / 32    south  -> +Z, screen-down.  NOT negated.
 * renderer.y  =  elevation     up
 * ```
 *
 * The one that catches people is `z`. `world.ts` fixes `y` as growing **southward** so world and
 * screen coordinates agree, and a renderer whose `+Z` also points south inherits that agreement for
 * free. Negating it — which is the reflex, because "z toward the viewer" is the OpenGL habit — mirrors
 * the entire world north-for-south while every individual room still renders correctly.
 * `space.test.ts` states the consequence as its headline case: **walking north must move -Z**.
 *
 * At this scale a room is 9 m across, the classic stride 11 m, `PLAYER_RADIUS` 0.31 m and
 * `PLAYER_SPEED` 4.69 m/s. The last is a fast run and is a tuning dial, not an architecture problem.
 *
 * ## Two deliberate deviations from the plan
 *
 * The plan puts this file in `packages/client`. It is here instead, because it is a **determinism
 * contract** — the client, the offline baker in `worldgen` and any future headless check all have to
 * agree about which way north is, and `shared` is where the other contracts of that kind live
 * (`rules.ts`'s seeded RNG, `tilemap.ts`'s `stepMovement`). The practical half of the argument is that
 * `packages/client` has no test runner wired into `npm test`, so a `space.test.ts` written there would
 * be a file nothing runs.
 *
 * And there is **no `three` import and no dependency of any kind**, deliberately. These are numbers
 * and an axis convention; they are as true before the renderer exists as after, and keeping them free
 * of it is what lets `worldgen` bake against the same map without pulling a WebGL library into an
 * offline pipeline.
 *
 * The one import is `Direction`, and it is a **type**, erased at run time — {@link yawOf} maps the
 * simulation's own compass onto this axis map, and re-spelling those six words here would be a second
 * copy of the encoding `CLAUDE.md`'s gotcha 1 already counts three of.
 */

import type { Direction } from './world.ts';

/** Renderer metres per simulation pixel. One tile ({@link TILE_SIZE}) is one metre. */
export const WORLD_SCALE = 1 / 32;

/** A point in renderer space: `y` is up, which is the one thing simulation space has no opinion on. */
export interface RenderPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Simulation position -> renderer position.
 *
 * `x` and `y` are simulation **pixels** — what `sim.ts` puts on the wire and what `stepMovement`
 * resolves collisions in — not tiles and not room cells. `elevation` is already in metres, because it
 * comes from a terrain height field rather than from anything the simulation measures in pixels; the
 * plan's §4.5 is explicit that a room's `pos.z` must *not* be multiplied into a slab height, since
 * 13.0% of occupied columns hold rooms at more than one z and the deepest stack is 21.
 */
export function toRenderPoint(x: number, y: number, elevation = 0): RenderPoint {
  return { x: x * WORLD_SCALE, y: elevation, z: y * WORLD_SCALE };
}

/**
 * Vertical field of view, in degrees.
 *
 * Narrow on purpose. A wide lens on a steeply pitched camera fans the scene out toward the frame
 * edges and flattens the perspective the pitch was chosen to produce; 30° keeps the near-orthographic
 * read of a three-quarter view while still being a perspective camera, which is what gives rain
 * streaks depth spread and leans trees outward at the edges.
 */
export const CAMERA_FOV_DEGREES = 30;

/**
 * Camera pitch below horizontal, in degrees.
 *
 * **Must stay strictly under 90.** At 90 the view direction is parallel to the up vector `(0, 1, 0)`
 * and the basis degenerates: the camera's roll becomes undefined and the frame flips or blanks
 * depending on which way the last floating-point comparison fell. 64° is the reference image's
 * register and leaves 26° of headroom.
 */
export const CAMERA_PITCH_DEGREES = 64;

/** Renderer up. Named rather than spelled out at each camera, because the pitch limit depends on it. */
export const RENDER_UP: RenderPoint = { x: 0, y: 1, z: 0 };

/**
 * A compass facing as a **renderer yaw in radians** — M7a, `PLAN-3d-migration.md` §6-M7's second item.
 *
 * §6-M7 says `EntityView.facing` must become a float because *"a 6-value cardinal enum makes a 3D
 * character snap visibly while strafing"*. It does; but the snap is a *simulation* fact — the server
 * genuinely only holds four headings (`faceDirection` refuses `up` and `down` outright) — so a float
 * on the wire today would be four values wearing a continuous type. This is therefore the **adapter,
 * not the fix**: it puts the field on the wire in the units a renderer wants, always present and
 * always correct, so the day the simulation grows a real heading nothing downstream changes shape.
 * M7b interpolates between these; a genuinely smooth server-side yaw is a later slice.
 *
 * **The number is `object.rotation.y` directly**, in this file's axis map, for a mesh whose rest
 * forward is `-Z` — which is Three.js' own convention and the Quaternius packs'. No negation, no
 * offset, no second convention to get wrong: M7b assigns it.
 *
 * Working it through, because the sign is the trap this file exists for. `+X` is east and `+Z` is
 * south, so the frame is right-handed with `+Y` up. A rotation of `θ` about `+Y` sends `(0,0,-1)` to
 * `(-sin θ, 0, -cos θ)`. At `θ = 0` that is due north; at `θ = π/2` it is `-X`, due **west**. So yaw
 * runs *anticlockwise seen from above* — north, west, south, east — which is the opposite of a
 * compass bearing and is stated here rather than left to be discovered:
 *
 * ```
 *   north  0        west  +π/2       south  ±π       east  -π/2
 * ```
 *
 * East is `-π/2` rather than `3π/2` so the range is `(-π, π]`: M7b's shortest-arc interpolation wants
 * a signed angle, and two representations of one heading is the kind of thing that spins a character
 * the long way round exactly once per turn.
 *
 * **`up` and `down` answer `0`.** A vertical facing has no horizontal heading at all, and the
 * simulation never produces one — `index.ts`'s `faceDirection` returns early on both, on the 2D note
 * that LPC has four sheet rows and no stair-ward one. Returning north rather than `undefined` keeps
 * the wire field non-optional in practice and keeps this function total; a caller that ever sees one
 * has a bug upstream, not here.
 */
export function yawOf(facing: Direction): number {
  switch (facing) {
    case 'north':
      return 0;
    case 'west':
      return Math.PI / 2;
    case 'south':
      return Math.PI;
    case 'east':
      return -Math.PI / 2;
    // No horizontal heading exists; see the note above.
    case 'up':
    case 'down':
      return 0;
  }
}
