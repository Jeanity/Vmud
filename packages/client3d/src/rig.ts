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
 * ## The yaw was fixed. It is the owner's now — M8
 *
 * M3 wrote, and every slice since read: *"`space.ts` fixes `+Z` as south, so a camera pulled back
 * along `+Z` looks north and the world's north is the top of the frame — the same reading the Phaser
 * client has always had, which is what makes the 2D map and the 3D view describe the same place to a
 * player who has both open. Free yaw is not a missing feature at M3; it is a decision that would
 * change how every wall occludes."* That ruling is **overturned**, by the owner, in their own words
 * (2026-08-13): *"whats the chance we can rotate the screen when I hold the shift key and move my
 * mouse side to side?"*, *"always having the camera behind my player"*, *"like a full 3d game"*.
 *
 * What replaced the ruling is not a free variable but a **complete answer to the thing the ruling was
 * protecting**, and that answer is most of this slice:
 *
 * - The 2D map and the 3D view still describe one place, because **the frame now says which way it is
 *   pointing**: `compass.ts` puts a rose in the corner that reads {@link CameraRig.yaw} directly. The
 *   agreement M3 bought by nailing the camera down is bought instead by telling the player the truth,
 *   which is what every 3D game with a minimap does.
 * - *"How every wall occludes"* was the real cost and it is paid in `interior.ts`: the near-wall fade
 *   asks **which wall stands between the camera and the player**, not "the south one", and answers one
 *   or two sides depending on where the camera has been swung to.
 * - Everything else that quietly meant "the camera looks north" was found and re-derived: the
 *   streaming ring is a **disc** now rather than a rectangle with a lookahead (`streamer.ts`), and the
 *   moon's shadow volume is an **oriented** box that turns with the frame (`night.ts`).
 *
 * **What is deliberately still north is the keyboard.** `input.ts` maps W to the world's north and
 * Shift+W to the exit named *north*, and it still does at any yaw — a MUD's directions are cardinal,
 * `move north` is the command the server takes, and making the walk keys camera-relative is a
 * gameplay decision the owner has not made. The compass is what keeps that honest. It is the obvious
 * next ask and it is not this slice's to take.
 *
 * ### M8b took it — and only half of it
 *
 * *"W should always be forward towards what the player is facing"* (owner, 2026-08-13). So the **glide**
 * keys are camera-relative now: `input.cameraRelative` rotates the steer vector through {@link
 * CameraRig.yaw} before it becomes a `steer`, which is a pure function of this file's own angle and
 * changes nothing at yaw 0. The **travel** keys did not move: Shift+W is still `move north`, because
 * north is north in the prose, on the map and in every zone file, and the paragraph above is still the
 * reason. The compass is still what keeps the pair honest.
 *
 * ## The follow is rigid in position, eased in yaw
 *
 * The camera is the character's position plus an offset, with no positional smoothing at all. The
 * Phaser client's camera lerp exists to hide a *sprite* being reconciled; here the body is already
 * eased (`entities.ts` carries the same 0.12 and 0.22 it always did) and a second filter on top of
 * the first is two time constants to tune and one of them invisible.
 *
 * The **yaw** is the one exception and it is not the same kind of number: under `orbit.ts`'s follow
 * mode the yaw chases the *body's* heading, which the wire delivers in four cardinal jumps, so
 * without easing every corner turned would be a 90° cut. That easing lives in `orbit.ts` and writes
 * {@link CameraRig.yaw} like any other writer; this file still has no time constant in it.
 *
 * ## M6: the distance and the pitch are live, and everything derived follows them
 *
 * Two owner questions — *"are we going to be able to zoom out?"* and *"we may need to lower the
 * angles so we can see more what is in front"* — are both questions about **this file's two
 * numbers**, and neither can be answered by argument. So they became variables inside a clamp, the
 * mouse wheel moves them (`dolly.ts`), and the frame the owner settles on is read off
 * `__debug3d.camera` and baked as the default later.
 *
 * That makes {@link CAMERA_DISTANCE} and `CAMERA_PITCH_DEGREES` the *home* of a range rather than
 * the shape of the world, and it puts a duty on everything that was tuned against them. Three
 * systems were: the undergrowth fade bands (`foliage.ts`, derived from the view-depth range the
 * frame contains), the moon's shadow volume (`night.ts`, refitted per frame to a box that must
 * contain the visible ground), and the streaming ring (`streamer.ts`, sized so built ground always
 * reaches past the frame's far edge). All three now read {@link CameraRig.ground} instead of a
 * constant, and each has a test that walks the four corners of the clamp rather than one pose.
 *
 * M8 adds a third axis to that clamp and the same duty falls out of it: the corners are now
 * `{distance} x {pitch} x {yaw}`, and because the yaw is a full circle the tests sweep it rather than
 * taking its ends. `fixture.CLAMP_CORNERS` is unchanged and `fixture.SWEEP_YAWS` is the new outer
 * loop.
 *
 * ## The exact trapezoid, and why the old approximation had to go
 *
 * The frame's ground is not a rectangle centred on the character; it is a trapezoid that flares
 * away from the camera, and at 64° the difference is small enough to ignore — which is why M3 wrote
 * `2·D·tan(15°)/sin(64°)` and moved on. At 45° it is not small: the approximation puts the far edge
 * 4.7 m nearer than it is, which is four metres of ground the fade band would dissolve and the
 * streamer would not have built. {@link groundFrame} is therefore the honest intersection — a ray
 * per frame edge, met with the plane — and its numbers reproduce `night.ts`'s hand-derived *"12.4 m
 * north and 20.4 m either side"* at the default pose exactly.
 */

import { PerspectiveCamera } from 'three';

import { CAMERA_FOV_DEGREES, CAMERA_PITCH_DEGREES } from '@mygame/shared';

/**
 * Metres from the character to the camera — **the default, and the frame the world was tuned at.**
 *
 * Chosen from the window rather than by eye. M3 sized it with the approximation `0.95·D` across by
 * `0.60·D` deep at 16:9, which put 36 m at "34 x 22 m — a little over three stride cells by two";
 * {@link groundFrame}'s exact trapezoid says 41 m across at the far edge, 30 m at the near one, and
 * 21.8 m deep, which is the same decision with a better number under it. Either way it sits
 * comfortably inside `streamer.ts`'s ring with room to spare. Since M6 this is the *home* of a
 * range, not a fixed truth; see {@link CAMERA_DISTANCE_MIN} and {@link CAMERA_DISTANCE_MAX}.
 */
export const CAMERA_DISTANCE = 36;

/**
 * How close the dolly may come.
 *
 * At 24 m and 64° the frame holds 27 x 15 m of ground — about two and a half room blocks across and
 * one and a half deep. That is the point where a room still reads as a room: pull in further and the
 * character's own two metres start to own the frame, the room you are standing in no longer fits in
 * it, and the three-quarter view stops being a view of a *place*. Two thirds of the default.
 */
export const CAMERA_DISTANCE_MIN = 24;

/**
 * How far the dolly may pull back. **The number every derived system's worst case is computed at.**
 *
 * 96 is the owner's own call — the slice shipped at 48 ("exactly twice the minimum") and the first
 * session's verdict was *"can I get more zoom out? about 100% more"* (2026-08-13), so the ceiling
 * doubled the same evening. The cost the 48 doc warned about was paid knowingly: the streaming
 * ring, the pre-warmed wrapper pool and the ledger all derive from this pose (see
 * {@link groundFrame}'s callers) and all roughly quadrupled — that is what the owner bought, and
 * the derivation chain is why the purchase was one constant. If a lesser machine chokes at full
 * pull-back, lower this before touching anything downstream of it; everything re-derives. On a
 * screen wider than the ring covers, `streamer.maxDistanceForAspect` still pulls the ceiling in
 * rather than letting the frame outrun the built world; see {@link CameraRig.maxDistance}.
 */
export const CAMERA_DISTANCE_MAX = 96;

/**
 * The shallowest the rig may be tilted — *"lower the angles so we can see more what is in front"*.
 *
 * 45° halves the ground compression of 64° in the near field and doubles how far ahead you see. The
 * floor is where it is because the far edge of the frame runs along the ray at `pitch - 15°`, and
 * `1/tan` is at its steepest near zero. Measured at {@link CAMERA_DISTANCE_MAX}, the ground visible
 * *ahead of the character* runs 16.5 m at 64°, **24.8 m at 45°**, 29.4 m at 40°, 36.3 m at 35° and
 * 48.0 m at 30° — the last five degrees of that list cost more than the first nineteen. Every one of
 * those metres is ground the streamer has to have built and the shadow camera has to contain, so the
 * clamp is what keeps a wheel notch from quietly costing a ring of chunks.
 */
export const CAMERA_PITCH_MIN = 45;

/**
 * The steepest — and it is `space.ts`'s 64°, the pose the whole build was authored at.
 *
 * The range only opens *downward* on purpose. Above 64° the view walks toward the top-down the LPC
 * art is not drawn for, and nobody asked for it; the owner's question was about seeing further
 * ahead, which is the other direction.
 */
export const CAMERA_PITCH_MAX = CAMERA_PITCH_DEGREES;

const RADIANS = Math.PI / 180;

/** `metres`, clamped into the dolly's range. A ceiling below {@link CAMERA_DISTANCE_MAX} may be
 * imposed by the streaming ring on a very wide screen — see {@link CameraRig.maxDistance}. */
export function clampDistance(metres: number, ceiling: number = CAMERA_DISTANCE_MAX): number {
  if (!Number.isFinite(metres)) return CAMERA_DISTANCE;
  const top = Math.max(CAMERA_DISTANCE_MIN, Math.min(ceiling, CAMERA_DISTANCE_MAX));
  return Math.min(Math.max(metres, CAMERA_DISTANCE_MIN), top);
}

/** `degrees`, clamped into the tilt's range. */
export function clampPitch(degrees: number): number {
  if (!Number.isFinite(degrees)) return CAMERA_PITCH_DEGREES;
  return Math.min(Math.max(degrees, CAMERA_PITCH_MIN), CAMERA_PITCH_MAX);
}

/**
 * `degrees`, wrapped into `(-180, 180]` — the yaw's answer to {@link clampPitch}, and it **wraps
 * rather than clamps** because a circle has no ends.
 *
 * The half-open range is the same choice `space.yawOf` makes for the wire's body yaw and for the same
 * reason: two representations of one heading is what turns a shortest-arc ease the long way round,
 * exactly once per turn. `-180` folds to `+180` so the range has one representative of due south.
 *
 * The yaw is in the **protocol's own units**, which is the whole reason follow mode is a copy rather
 * than a conversion: `0` is north and it runs anticlockwise seen from above, so west is `+90`, south
 * is `180` and east is `-90`. That is `object.rotation.y` for a thing whose rest forward is `-Z`,
 * which is what the camera is and what every body on the wire is (`shared/space.ts`'s `yawOf`).
 */
export function wrapYaw(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  // An angle already in range comes back **bit-identical**, and the fast path is there for that
  // rather than for the two arithmetic operations it saves: `((90.025 + 180) % 360 + 360) % 360 -
  // 180` is 90.02499999999998, so without this a yaw would not survive being wrapped twice, a
  // settled follow would never compare equal to its own target, and a stored 52.5 would come back as
  // something a human did not type.
  if (degrees > -180 && degrees <= 180) return degrees;
  const folded = (((degrees + 180) % 360) + 360) % 360 - 180;
  // `((-180 + 180) % 360)` is 0, which comes back as -180; a circle's one south is +180.
  return folded === -180 ? 180 : folded;
}

/**
 * Where the frame meets the ground, exactly — the trapezoid, not the rectangle.
 *
 * All six numbers are metres and all six are measured from the **focus point**, which is the
 * character: the camera looks at their feet, so the frame's centre line passes through them.
 */
export interface GroundFrame {
  /**
   * Metres of ground visible *ahead* of the character — up the frame. The far edge.
   *
   * **Called `north` until M8**, when the yaw opened and the name became a lie: this is the camera's
   * own forward, and which compass direction that is now depends on {@link CameraRig.yaw}. The rename
   * is the point — three of this field's four readers were doing world-axis arithmetic with it.
   */
  readonly ahead: number;
  /** Metres visible behind them, down the frame. Always the smaller — the camera is pitched. */
  readonly behind: number;
  /** Half the frame's width where it is narrowest, at the near edge. */
  readonly halfWidthNear: number;
  /** Half its width where it is widest, at the far edge. What the ring and the shadow box must hold. */
  readonly halfWidthFar: number;
  /** View depth (`-mvPosition.z`, the number `foliage.ts`'s fade is compared against) at the near edge. */
  readonly nearDepth: number;
  /** The same at the far edge. Nothing on screen is deeper than this. */
  readonly farDepth: number;
}

/**
 * The ground the frame contains at a given pose.
 *
 * A ray per frame edge, met with the plane the character stands on. With `h = D·sin θ` the camera's
 * height and `b = D·cos θ` its ground offset behind the focus, an edge ray leaving at depression
 * angle `φ` meets the ground `h/tan φ` from the camera's nadir and `h/sin φ` along the ray, and the
 * view depth of that meeting is `(h/sin φ)·cos(fov/2)` because the edge ray is `fov/2` off the
 * camera's own axis. The far edge is `φ = pitch - fov/2` and the near edge `φ = pitch + fov/2`.
 *
 * Undefined for `pitch <= fov/2` — the far ray would be at or above the horizon and would never meet
 * the ground at all. {@link CAMERA_PITCH_MIN} keeps that 30° away, and the clamp is the guard.
 */
export function groundFrame(
  distance: number,
  pitchDegrees: number,
  aspect: number,
  fovDegrees: number = CAMERA_FOV_DEGREES,
): GroundFrame {
  const half = (fovDegrees / 2) * RADIANS;
  const pitch = pitchDegrees * RADIANS;
  const far = pitch - half;
  const near = pitch + half;
  if (!(far > 1e-6)) throw new Error(`pitch ${pitchDegrees}° is at or below half the ${fovDegrees}° field`);
  const height = distance * Math.sin(pitch);
  const behind = height / Math.tan(pitch);
  const rangeFar = height / Math.sin(far);
  const rangeNear = height / Math.sin(near);
  const spread = Math.tan(half);
  return {
    ahead: height / Math.tan(far) - behind,
    behind: behind - height / Math.tan(near),
    halfWidthNear: rangeNear * spread * aspect,
    halfWidthFar: rangeFar * spread * aspect,
    nearDepth: rangeNear * Math.cos(half),
    farDepth: rangeFar * Math.cos(half),
  };
}

/**
 * How far the frame's ground reaches from the character, in the worst direction — **the one number
 * the whole yaw-independent half of M8 is built on.**
 *
 * Under a fixed yaw the frame's extent was three numbers with three different world-axis meanings
 * (ahead, behind, either side) and every consumer could take the one it needed. Once the yaw turns,
 * the *only* statement about the footprint that survives a rotation is its **circumradius about the
 * character**: rotate the trapezoid to any angle and its furthest corner is still exactly this far
 * away, and no world-axis extent is stable for a degree.
 *
 * So this is what `streamer.ts` sizes the ring against and what `night.ts`'s oriented shadow box is
 * checked against. It is the far pair of corners in every case the clamp can reach — the near edge is
 * both narrower and closer — but taking the max of both pairs costs one comparison and does not
 * depend on that staying true.
 */
export function groundRadius(frame: GroundFrame): number {
  return Math.max(Math.hypot(frame.halfWidthFar, frame.ahead), Math.hypot(frame.halfWidthNear, frame.behind));
}

export class CameraRig {
  readonly camera: PerspectiveCamera;
  /**
   * Metres of the offset, recomputed whenever the pose moves.
   *
   * `(b·sin ψ, D·sin θ, b·cos ψ)` with `b = D·cos θ` the ground offset behind the focus, `θ` the
   * pitch and `ψ` the yaw. At `ψ = 0` that is M3's `(0, D·sin θ, D·cos θ)` exactly, which is the
   * arithmetic proof that opening the yaw moved nothing at the pose everything was authored at.
   */
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private metres = CAMERA_DISTANCE;
  private degrees = CAMERA_PITCH_DEGREES;
  private yawDegrees = 0;
  /**
   * A ceiling below {@link CAMERA_DISTANCE_MAX}, imposed from outside.
   *
   * `streamer.maxDistanceForAspect` computes it from the canvas: on a screen wide enough that the
   * fully-pulled-back frame would reach past the built ring, the dolly stops sooner rather than the
   * frame showing void at its corners. `main.ts` writes it on every resize. Defaults to no extra
   * limit, so a rig nobody talks to has exactly M3's behaviour.
   */
  private ceiling = CAMERA_DISTANCE_MAX;

  constructor(aspect = 1) {
    if (!(CAMERA_PITCH_DEGREES < 90)) {
      throw new Error(`camera pitch must stay under 90°, got ${CAMERA_PITCH_DEGREES}`);
    }
    this.camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, aspect, 0.5, 240);
    this.camera.up.set(0, 1, 0);
    this.recompute();
  }

  /** Metres from the character to the camera. Writing it clamps; see {@link clampDistance}. */
  get distance(): number {
    return this.metres;
  }

  set distance(metres: number) {
    this.metres = clampDistance(metres, this.ceiling);
    this.recompute();
  }

  /** Degrees below the horizontal. Writing it clamps; see {@link clampPitch}. */
  get pitch(): number {
    return this.degrees;
  }

  set pitch(degrees: number) {
    this.degrees = clampPitch(degrees);
    this.recompute();
  }

  /**
   * Which way the camera looks, in degrees. Writing it wraps; see {@link wrapYaw}.
   *
   * `0` is north — the pose M3 nailed down and the one the world was authored at — and the sign is
   * the protocol's, so `follow`ing a body is `rig.yaw = body.yaw` in degrees and nothing else. Two
   * writers: `orbit.ts`'s Shift+drag and `orbit.ts`'s follow mode, never both in one frame.
   */
  get yaw(): number {
    return this.yawDegrees;
  }

  set yaw(degrees: number) {
    this.yawDegrees = wrapYaw(degrees);
    this.recompute();
  }

  /** The same angle in radians — what `night.ts`'s oriented box and `interior.ts`'s wall test take. */
  get yawRadians(): number {
    return this.yawDegrees * RADIANS;
  }

  get maxDistance(): number {
    return this.ceiling;
  }

  /** Lowering the ceiling below the live distance pulls the camera in with it, immediately. */
  set maxDistance(metres: number) {
    this.ceiling = Math.max(CAMERA_DISTANCE_MIN, Math.min(metres, CAMERA_DISTANCE_MAX));
    this.metres = clampDistance(this.metres, this.ceiling);
    this.recompute();
  }

  /**
   * Back to the pose the world was authored at. The **C** key and `__debug3d.camera.reset()`.
   *
   * **The yaw goes home too**, and it is the most useful third of the key: a player who has orbited
   * themselves somewhere confusing wants north back at the top of the frame, and hunting for it by
   * hand through a full circle is the thing a reset key exists to spare them.
   */
  reset(): void {
    this.metres = clampDistance(CAMERA_DISTANCE, this.ceiling);
    this.degrees = CAMERA_PITCH_DEGREES;
    this.yawDegrees = 0;
    this.recompute();
  }

  /** Whether the rig is anywhere other than home — what decides if the pose is worth remembering. */
  get moved(): boolean {
    return this.metres !== CAMERA_DISTANCE || this.degrees !== CAMERA_PITCH_DEGREES || this.yawDegrees !== 0;
  }

  resize(width: number, height: number): void {
    this.camera.aspect = height === 0 ? 1 : width / height;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Point the rig at a world position, in metres.
   *
   * Not to be confused with `orbit.CameraPose.follow`, which is the *mode* — this is the per-frame
   * aim and it happens whether or not the mode is on.
   */
  follow(x: number, y: number, z: number): void {
    this.camera.position.set(x + this.offsetX, y + this.offsetY, z + this.offsetZ);
    this.camera.lookAt(x, y, z);
  }

  /**
   * The ground this pose actually contains — what the fade bands, the shadow box and the ring all
   * read now that the pose can move. See {@link groundFrame}.
   */
  ground(): GroundFrame {
    return groundFrame(this.metres, this.degrees, this.camera.aspect);
  }

  /**
   * The frame's ground extent as one width and one depth, kept for the streamer's own sizing note.
   *
   * The trapezoid's widest and its full depth, so a caller comparing this against a rectangle is
   * comparing against something that contains the frame rather than something that averages it.
   */
  footprint(): { width: number; depth: number } {
    const ground = this.ground();
    return { width: 2 * ground.halfWidthFar, depth: ground.ahead + ground.behind };
  }

  private recompute(): void {
    const pitch = this.degrees * RADIANS;
    const yaw = this.yawDegrees * RADIANS;
    const behind = this.metres * Math.cos(pitch);
    // `+Z` is south and yaw 0 must leave the camera exactly where M3 put it, due south of the focus:
    // `sin 0 = 0`, `cos 0 = 1`. A rotation of `ψ` about `+Y` sends `(0, 0, 1)` to `(sin ψ, 0, cos ψ)`,
    // which is the same rotation the wire's body yaw means and is why follow mode is a plain copy.
    this.offsetX = behind * Math.sin(yaw);
    this.offsetY = this.metres * Math.sin(pitch);
    this.offsetZ = behind * Math.cos(yaw);
  }
}
