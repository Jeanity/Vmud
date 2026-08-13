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
 * constant, and each has a test that walks the whole clamp rather than one pose — the four corners
 * of M6's rectangle, and since M9 an envelope sweep (`fixture.ENVELOPE_POSES`).
 *
 * M8 adds a third axis to that clamp and the same duty falls out of it: the corners are now
 * `{distance} x {pitch} x {yaw}`, and because the yaw is a full circle the tests sweep it rather than
 * taking its ends. `fixture.SWEEP_YAWS` is that outer loop.
 *
 * ## M9: the clamp stopped being a rectangle
 *
 * > *"I would also like to be able to move the camera angle right down to eye level and be able to
 * > zoom in so I can see my character better just so I can check him out"* — owner, 2026-08-13.
 *
 * Two asks, and taken as two numbers they are unaffordable: eye level at 96 m would demand a ring and
 * a shadow texel sized for a view nobody would ever play at. Taken as **one pose** they are nearly
 * free, because the owner does not want eye level at 96 m — they want it *up close*, standing in
 * front of their own character. So the pitch floor became a **function of the distance**
 * ({@link pitchFloorFor}) and the clamp became an **envelope**: at the near end it opens down to
 * {@link CAMERA_PITCH_FLOOR}, and it closes back to {@link CAMERA_PITCH_MIN} exactly where the dolly
 * stops.
 *
 * The curve is not a taste. Every extent of {@link groundFrame} is linear in the distance, so the
 * *cost* of a pose is `D · r(θ)` for a shape function `r` that explodes as the pitch nears half the
 * field. Setting `D · r(θ) = 96 · r(45°)` traces the **iso-cost curve** — the shallowest tilt at each
 * distance whose frame reaches no further than today's worst already does — and
 * {@link pitchFloorFor}'s ramp is a **chord** of it. `r` is convex, so a chord between two points on
 * or above the curve lies above it for its whole length: the envelope can never spend more ground
 * than today's rectangle did, and that is a proof rather than a measurement. `rig.test.ts` measures
 * it anyway, over the whole envelope, because a proof about the wrong function is still wrong.
 *
 * **Nothing downstream grew.** The ring, the shadow volume and the fade bands all size themselves off
 * the worst reachable pose, and the worst reachable pose is still 96 m at 45° — unchanged to the last
 * bit, because that pose is the chord's own upper endpoint. See the delta table in
 * `docs/HANDOFF.md`: it has no row.
 *
 * ### The horizon is the floor, and it is 15°
 *
 * The owner's *"right down to eye level"* reads as a pitch near zero and cannot be one. The frame's
 * far edge runs along the `pitch − fov/2` ray; below 15° that ray is **above the horizon**, meets no
 * ground at all, and `groundFrame` — along with `ahead`, `halfWidthFar`, `farDepth` and every system
 * derived from them — stops having an answer. {@link CAMERA_PITCH_FLOOR} is 20°, five degrees of
 * grazing clearance, and the reason it still *reads* as eye level is that eye level is a **height**
 * rather than an angle: at the closest pose the camera's eye sits 1.93 m above the ground
 * (`3 · sin 20° + `{@link FOCUS_LIFT}), which is a tall man's eyeline. The pitch is what it has to be
 * for the frame to have a far edge; the height is what the owner actually asked for, and they get it.
 *
 * ### The camera aims at the character's middle now
 *
 * A rig that aims at the feet is invisible at 36 m and useless at 3 m: a 1.8 m body centred on its
 * own feet puts the head 21° off a 15° half-frame, so the close-up the owner asked for would have
 * been a close-up of their boots. {@link focusLiftFor} raises the aim point to {@link FOCUS_LIFT} —
 * the body's own midpoint — over the near band, and fades it out by 20 m where it stops mattering.
 * It is a fifth argument to {@link groundFrame} rather than a fudge in the rig, because it raises the
 * camera and therefore genuinely moves the ground the frame contains.
 *
 * ### What M9 does **not** do: the camera has no idea what it is inside
 *
 * At 24 m the camera stood 10.5 m back and 17 m up and was outside everything. At
 * {@link CAMERA_DISTANCE_MIN} it stands **2.82 m back and 1.93 m up**, and there are two places that
 * puts it somewhere solid:
 *
 * - **Under the ground.** The terrain is a flat slab per room cell, not a displaced mesh, so it never
 *   rises under a camera inside the player's own cell. It *steps* at cell boundaries, and the camera
 *   trails the player by 2.82 m against an 11 m stride — so whenever the player is within 2.82 m of
 *   the boundary behind them, the camera is over the **neighbour's** slab. The lift is what makes
 *   most of that safe: 1.93 m of clearance against a worst intra-component step of 1.4 m
 *   (`roomScene.GROUND_AMPLITUDE`'s 0.7 for mountain, doubled). It is **not** enough against a
 *   component boundary (`GROUND_BASE_METRES`, up to 4.4 m) or a roofed room one level up
 *   (`LEVEL_SEPARATION`, 4 m), where the camera goes into the hillside.
 * - **Inside a wall or a tree.** Nothing pulls the camera in, anywhere — {@link CameraRig.follow}
 *   sets a position and aims, unconditionally. Indoors it is usually *better* than it was, because at
 *   2.82 m the camera is often inside the room with the player rather than outside the building
 *   looking in (see `interior.ts` for the near-wall fade's own version of this note); outdoors, a
 *   trunk two metres behind you will fill the frame.
 *
 * **Named rather than fixed, deliberately.** A collision-aware camera is a real feature — a sphere
 * cast from the focus to the eye, a spring that pulls the distance in on a hit and lets it back out,
 * and a rule for what happens when there is nowhere to stand — and it is a slice, not a clause in
 * this one. What makes naming it a boundary rather than a hole shipped on purpose: the close poses
 * are a **deliberate act**, five flicks of the wheel from home and held only while the owner is
 * looking at their character, not somewhere the camera drifts on its own — and one notch back out is
 * the way home.
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
 * How close the dolly may come. **Three metres — a portrait, not a view of a place.**
 *
 * M6 stopped at 24 m and the reasoning was sound for what it was answering: *"at 24 m and 64° the
 * frame holds 27 x 15 m of ground… pull in further and the character's own two metres start to own
 * the frame, the room you are standing in no longer fits in it, and the three-quarter view stops
 * being a view of a place."* Every clause of that is still true. M9's answer is that **the owner
 * sometimes wants the character to own the frame** — *"zoom in so I can see my character better just
 * so I can check him out"* — and a floor set to stop them is a floor set against the ask.
 *
 * Three is where a 1.8 m body fills the frame's height. The half-angle a body of height `h` subtends
 * at distance `D` is `atan(h/2D)`, and the frame's own half-angle is `fov/2` = 15°, so the figure
 * exactly fills the frame at `D = 0.9/tan 15°` = **3.36 m**. At 3 m it overflows slightly — head and
 * shoulders and the weapon in a hand, which is the view the ask describes — and one notch of the
 * wheel out at 3.4 m has the whole figure. Below 3 m nothing breaks (the near plane is 0.5 m and the
 * nearest point of the body is still 2.7 m away at this distance); it simply stops being a view of a
 * character and starts being a view of a chest.
 */
export const CAMERA_DISTANCE_MIN = 3;

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
 * The shallowest the rig may be tilted **at full pull-back** — *"lower the angles so we can see more
 * what is in front"*.
 *
 * 45° halves the ground compression of 64° in the near field and doubles how far ahead you see. The
 * floor is where it is because the far edge of the frame runs along the ray at `pitch - 15°`, and
 * `1/tan` is at its steepest near zero. Measured at 48 m, the ground visible *ahead of the
 * character* runs 16.5 m at 64°, **24.8 m at 45°**, 29.4 m at 40°, 36.3 m at 35° and 48.0 m at 30° —
 * the last five degrees of that list cost more than the first nineteen. (Those five numbers were
 * written when {@link CAMERA_DISTANCE_MAX} *was* 48 and the docblock has said "measured at
 * `CAMERA_DISTANCE_MAX`" ever since the ceiling doubled; at 96 m every one of them doubles too, and
 * 45° costs **49.7 m** ahead rather than 24.8.) Every one of those metres is ground the streamer has
 * to have built and the shadow camera has to contain, so the clamp is what keeps a wheel notch from
 * quietly costing a ring of chunks.
 *
 * **Since M9 this is one end of a curve rather than a flat floor.** It is the pitch floor at
 * {@link CAMERA_DISTANCE_MAX} — which is the pose every derived system's worst case is still computed
 * at, so `streamer.ts` and `night.ts` read it exactly as they always did — and {@link pitchFloorFor}
 * is the floor at every other distance. See {@link CAMERA_PITCH_FLOOR} for the other end.
 */
export const CAMERA_PITCH_MIN = 45;

/**
 * The shallowest the rig may be tilted **anywhere** — 20°, and it is a fact about the field of view
 * rather than a preference.
 *
 * {@link groundFrame} is undefined at or below `fov/2` = 15°: the far edge of the frame runs along
 * the `pitch − 15°` ray, and at 15° that ray is horizontal, meets the ground nowhere, and takes
 * `ahead`, `halfWidthFar` and `farDepth` to infinity with it. There is no pitch below 15° at which
 * this renderer has a frame, so the owner's *"right down to eye level"* has a hard stop five degrees
 * above where the phrase suggests.
 *
 * **Five degrees of grazing clearance, and each one is bought.** The far ray's depression is
 * `pitch − 15°`, and the ground it reaches goes as `1/tan` of that: at 5° a metre of camera height is
 * 11.4 m of ground, at 3° it is 19.1 m, at 1° it is 57.3 m. {@link FOCUS_LIFT} pays that multiplier
 * too — it is height like any other — so a floor at 16° would have turned the 0.9 m aim-point lift
 * into 51 m of extra frame and blown the ring on its own. 20° keeps the whole envelope inside today's
 * footprint with the lift included.
 *
 * What makes it read as eye level anyway: at {@link CAMERA_DISTANCE_MIN} the camera's eye is
 * `3 · sin 20° + 0.9` = **1.93 m** above the ground, looking at a point 0.9 m up the character's
 * body from 2.8 m away. Eye level is a height, and the height is right even though the angle cannot
 * be.
 */
export const CAMERA_PITCH_FLOOR = 20;

/**
 * Metres of distance over which the floor stays flat at {@link CAMERA_PITCH_FLOOR} — **ten, the
 * portrait band.**
 *
 * Inside it the character is a meaningful fraction of the frame and the shallow tilt is the whole
 * point: a 1.8 m body subtends 34% of the frame's height at 10 m, 57% at 6 m and all of it at 3.4 m.
 * Beyond it you are looking at a place rather than at a person, the ask stops applying, and the
 * budget rather than the owner is what sets the floor — so that is where {@link pitchFloorFor}'s
 * ramp starts.
 *
 * It lands on one seamless stride cell (`streamer.STRIDE_METRES` is 10 m), which is a sanity check
 * and deliberately **not** the derivation: the number comes from the angle a body subtends, and
 * importing it from the tilemap would claim a dependency the camera does not have — and would point
 * `rig.ts` at a module that imports `rig.ts`.
 */
export const PITCH_FLOOR_KNEE = 10;

/**
 * Metres the camera's aim point rises up the character's body at close range — **0.9, its midpoint.**
 *
 * The rig has always aimed at the focus it is given and `main.ts` has always given it the ground
 * under the player's feet. At 36 m that is invisible. At 3 m it is the difference between a portrait
 * and a photograph of two boots: a body of height `h` centred on its own feet puts the head
 * `atan(h·cos θ / (D − h·sin θ))` off the view axis, which at 3 m and 20° is **35°** against a
 * 15° half-frame. Aiming at `h/2` halves that to 17.4° — the figure overflows the frame's height by a
 * tenth at the very closest pose and fits inside it from 3.4 m out.
 *
 * Applied to the *orbit centre*, so the camera rises with the aim point and the pitch keeps meaning
 * what it says. That makes it real height, which is why {@link groundFrame} has to be told about it.
 */
export const FOCUS_LIFT = 0.9;

/**
 * Where the lift has faded to nothing — 20 m, one band beyond {@link PITCH_FLOOR_KNEE}.
 *
 * It fades rather than switching off because the aim point is where the character sits in the frame,
 * and a step in that is the character jumping half their own height up the screen on one notch of the
 * wheel. Full inside the portrait band, linear to zero over the next ten metres, and **exactly zero
 * from 20 m out** — which is the property that matters most: the entire pre-M9 clamp began at 24 m,
 * so every pose the owner has ever looked at is computed with a lift of 0 and is bit-identical to
 * what it was.
 */
export const FOCUS_LIFT_FADE = 20;

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

/**
 * The shallowest pitch allowed at this distance — **M9's envelope, as one function.**
 *
 * Flat at {@link CAMERA_PITCH_FLOOR} through the portrait band ({@link PITCH_FLOOR_KNEE}), then a
 * straight ramp to {@link CAMERA_PITCH_MIN} at the far end. See this file's header for why a chord
 * of the iso-cost curve is provably affordable and why the curve itself is not usable directly (it
 * asymptotes onto the 15° horizon singularity, where a metre of camera height is fifty metres of
 * ground).
 *
 * ## The ramp ends at the *live* ceiling, not at `CAMERA_DISTANCE_MAX`
 *
 * `streamer.maxDistanceForAspect` already pulls the dolly's ceiling in on a canvas too wide for the
 * ring, and its docblock argues the trade: *"nobody will notice a few metres of zoom, and everybody
 * would notice the world ending inside the frame."* The envelope has to answer the same question and
 * the answer has to be the same one, because a wide canvas widens the frame at **every** pose, not
 * just at the far one — at 32:9 a mid-range pose sitting on a floor derived for 16:9 reaches 88.7 m
 * against 81.6 m of built ring, and it does so at a distance well *below* the ceiling, where lowering
 * the ceiling cannot reach it.
 *
 * Ramping to 45° at whatever the ceiling is compresses the whole envelope by the same factor the
 * ceiling was compressed by, which restores the invariant at every aspect **and costs no zoom at
 * all** — measured: at 21:9 the ceiling stays today's 79.6 m and the floor at 36 m rises from 27.6°
 * to 29.3°; at 32:9 the ceiling stays 56.5 m and the floor at 36 m rises to 34.0°. Solving it the
 * other way — leaving the floor alone and pulling the ceiling in until the envelope fitted — would
 * have cost an ultrawide 15 m of pull-back and a 32:9 screen 23 m.
 *
 * At {@link RING_ASPECT} the ceiling *is* {@link CAMERA_DISTANCE_MAX} and this is the plain curve.
 */
export function pitchFloorFor(distance: number, ceiling: number = CAMERA_DISTANCE_MAX): number {
  if (!Number.isFinite(distance)) return CAMERA_PITCH_MIN;
  const top = Math.max(CAMERA_DISTANCE_MIN, Math.min(ceiling, CAMERA_DISTANCE_MAX));
  // A ceiling inside the portrait band leaves no ramp to draw. Answer the strict end rather than
  // dividing by zero — it is unreachable through `maxDistanceForAspect` (whose own floor is
  // `CAMERA_DISTANCE_MIN`) and a NaN floor would silently unclamp the pitch entirely.
  if (!(top > PITCH_FLOOR_KNEE)) return CAMERA_PITCH_MIN;
  if (distance <= PITCH_FLOOR_KNEE) return CAMERA_PITCH_FLOOR;
  const along = Math.min(1, (distance - PITCH_FLOOR_KNEE) / (top - PITCH_FLOOR_KNEE));
  return CAMERA_PITCH_FLOOR + (CAMERA_PITCH_MIN - CAMERA_PITCH_FLOOR) * along;
}

/**
 * Metres the aim point sits above the ground at this distance. See {@link FOCUS_LIFT}.
 *
 * Zero from {@link FOCUS_LIFT_FADE} out, which covers the whole of the pre-M9 clamp — so this
 * function is the identity on every pose that existed before it did.
 */
export function focusLiftFor(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= PITCH_FLOOR_KNEE) return FOCUS_LIFT;
  if (distance >= FOCUS_LIFT_FADE) return 0;
  return FOCUS_LIFT * ((FOCUS_LIFT_FADE - distance) / (FOCUS_LIFT_FADE - PITCH_FLOOR_KNEE));
}

/**
 * `degrees`, clamped into the tilt's range **at this distance**. See {@link pitchFloorFor}.
 *
 * The distance defaults to {@link CAMERA_DISTANCE_MAX}, which is the *strictest* floor the envelope
 * has (45°) and therefore the safe answer for a caller that does not know where the camera is: a
 * pitch that survives this call is legal everywhere. Every caller inside the client passes a real
 * distance; the default exists for `dolly.rememberedPose`, which parses a pitch out of storage before
 * it knows what ceiling the canvas will impose — and the rig re-clamps when that ceiling arrives.
 */
export function clampPitch(
  degrees: number,
  distance: number = CAMERA_DISTANCE_MAX,
  ceiling: number = CAMERA_DISTANCE_MAX,
): number {
  if (!Number.isFinite(degrees)) return CAMERA_PITCH_DEGREES;
  return Math.min(Math.max(degrees, pitchFloorFor(distance, ceiling)), CAMERA_PITCH_MAX);
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
 * the ground at all. {@link CAMERA_PITCH_FLOOR} keeps that 5° away, and the clamp is the guard.
 *
 * `lift` is M9's aim-point rise ({@link FOCUS_LIFT}), in metres, and it is **not** cosmetic: the
 * camera orbits the lifted point, so it stands `lift` higher than it otherwise would and every ray
 * out of it meets the ground further away. The far edge pays `lift / tan(pitch − fov/2)`, which is
 * 11.4x the lift at the envelope's floor — the single largest reason {@link CAMERA_PITCH_FLOOR} is
 * 20° and not 16°. Defaults to 0, which is the whole of the pre-M9 clamp; the `behind` offset is
 * unchanged by it, because a vertical lift moves the camera up rather than back.
 */
export function groundFrame(
  distance: number,
  pitchDegrees: number,
  aspect: number,
  fovDegrees: number = CAMERA_FOV_DEGREES,
  lift = 0,
): GroundFrame {
  const half = (fovDegrees / 2) * RADIANS;
  const pitch = pitchDegrees * RADIANS;
  const far = pitch - half;
  const near = pitch + half;
  if (!(far > 1e-6)) throw new Error(`pitch ${pitchDegrees}° is at or below half the ${fovDegrees}° field`);
  // Height **above the ground**, which is what every ray below is measured from — so the lift joins
  // it here and nowhere else. `behind` stays the camera's horizontal offset from the focus, which a
  // vertical lift does not touch, and keeps M3's own `eye/tan θ` spelling rather than the equal
  // `D·cos θ`: `RING_RADIUS`, `WINDOW_HALF` and the pre-warmed pool are all floors of expressions
  // rooted here, and a last-bit difference in a number a `Math.floor` is taken of is a ring that
  // changes size for no reason anybody could find later.
  const eye = distance * Math.sin(pitch);
  const height = eye + lift;
  const behind = eye / Math.tan(pitch);
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

/**
 * The frame a **reachable** pose produces — {@link groundFrame} with this distance's own aim-point
 * lift already in it.
 *
 * The one-line reason it exists: `groundFrame` is the geometry and takes the lift as an argument, so
 * every caller that forgets the argument gets an answer that is quietly 10 m short at close range and
 * exactly right everywhere the old clamp could reach — which is the worst possible failure mode,
 * because it passes every test written before M9. This is what {@link CameraRig.ground} calls and
 * what the envelope sweep in `fixture.ts` is walked through, so the lift is remembered once.
 */
export function frameAt(distance: number, pitchDegrees: number, aspect: number): GroundFrame {
  return groundFrame(distance, pitchDegrees, aspect, CAMERA_FOV_DEGREES, focusLiftFor(distance));
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

  /**
   * **Writing the distance can move the pitch, and that is M9's envelope doing its job.**
   *
   * The floor rises as the camera pulls back ({@link pitchFloorFor}), so a rig sitting at 20° three
   * metres out and then dollied to 96 m would be holding a pitch its own clamp forbids — the frame
   * would reach 285 m ahead, past four rings of built ground. Re-clamping here means the camera tilts
   * *up* as it pulls back, which is both the only safe answer and the one that feels like an orbit
   * camera in every other game: zoom out and the view rises to take in the world.
   */
  set distance(metres: number) {
    this.metres = clampDistance(metres, this.ceiling);
    this.degrees = clampPitch(this.degrees, this.metres, this.ceiling);
    this.recompute();
  }

  /** Degrees below the horizontal. Writing it clamps against the live distance; see {@link clampPitch}. */
  get pitch(): number {
    return this.degrees;
  }

  set pitch(degrees: number) {
    this.degrees = clampPitch(degrees, this.metres, this.ceiling);
    this.recompute();
  }

  /** The shallowest tilt this rig will accept where it currently stands. See {@link pitchFloorFor}. */
  get pitchFloor(): number {
    return pitchFloorFor(this.metres, this.ceiling);
  }

  /**
   * Metres the aim point sits above the focus it is given. See {@link FOCUS_LIFT}.
   *
   * Read by {@link follow} and by {@link ground}, and exposed because `__debug3d.camera` is how the
   * owner reads a pose back and a camera that is silently aiming somewhere other than where it was
   * told to would make every number on that readout a small lie.
   */
  get focusLift(): number {
    return focusLiftFor(this.metres);
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

  /**
   * Lowering the ceiling below the live distance pulls the camera in with it, immediately — **and
   * since M9 tilts it up with it too.**
   *
   * The envelope's ramp ends at the ceiling ({@link pitchFloorFor}), so a narrower ceiling is a
   * steeper floor at every distance inside it. Both re-clamps happen here, in this order, because the
   * pitch floor is a function of the distance and the distance has just changed. This is also the one
   * place that repairs a pose read out of storage before any canvas existed — see {@link clampPitch}.
   */
  set maxDistance(metres: number) {
    this.ceiling = Math.max(CAMERA_DISTANCE_MIN, Math.min(metres, CAMERA_DISTANCE_MAX));
    this.metres = clampDistance(this.metres, this.ceiling);
    this.degrees = clampPitch(this.degrees, this.metres, this.ceiling);
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
    // M9. The caller hands us the ground under the player's feet and at close range that is the wrong
    // thing to point at — see {@link FOCUS_LIFT}. The lift is added to *both* the aim and the eye, so
    // the camera orbits the raised point and the pitch still means degrees below the horizontal
    // rather than degrees below whatever the aim happened to be. Zero beyond
    // {@link FOCUS_LIFT_FADE}, so every pose the pre-M9 clamp could reach is untouched arithmetic.
    const lift = focusLiftFor(this.metres);
    const aimY = y + lift;
    this.camera.position.set(x + this.offsetX, aimY + this.offsetY, z + this.offsetZ);
    this.camera.lookAt(x, aimY, z);
  }

  /**
   * The ground this pose actually contains — what the fade bands, the shadow box and the ring all
   * read now that the pose can move. See {@link groundFrame}.
   *
   * The lift goes in because it is real height: the frame at 3 m reaches 19.2 m ahead with it and
   * 8.9 m without, and the system that believed the smaller number would be the streamer.
   */
  ground(): GroundFrame {
    return frameAt(this.metres, this.degrees, this.camera.aspect);
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
