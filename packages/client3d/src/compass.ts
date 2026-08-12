/**
 * A rose in the corner, because north stopped being up. M8.
 *
 * Every cardinal sentence this client shows comes from somewhere that has never seen the camera: the
 * server's own prose (*"you go east"*), the sky's (*"the sun rises over the northern horizon"*), the
 * room's exits, and the 2D client's map for a player who has both open. Under M3's fixed yaw all of
 * them agreed with the screen for free — north was up the frame and that was the point of nailing the
 * camera down (`rig.ts`'s old header). Once the owner can orbit, they agree with the screen only if
 * something on the screen says which way it is pointing. That is the compass, and it is the price of
 * the feature rather than a nicety on top of it.
 *
 * ## What it draws, and why the whole rose turns
 *
 * The rose carries all four letters and **rotates as one**, so north is a *place on the badge* rather
 * than a needle to read: at a glance the letter at the top of the badge is the direction up the frame,
 * and the letter where N happens to be is the world's north. A single north needle would be cheaper
 * to draw and would answer half the question — "where is north" but not "so which way am I facing" —
 * and the second half is the one a player asks after orbiting.
 *
 * The one number that drives it is the camera yaw, and the mapping is an identity worth writing down
 * because it looks too convenient to be right. World north is `(0, -1)` in `(x, z)`; the frame's up
 * is the camera's own forward and its right is `(cos ψ, -sin ψ)`; so north sits on screen at
 * `(sin ψ, cos ψ)` with `y` up, whose clockwise angle from screen-up is `atan2(sin ψ, cos ψ)` — which
 * is `ψ`. CSS `rotate()` is clockwise-positive, so **the rose's rotation in degrees is the camera's
 * yaw in degrees, exactly**. {@link roseRotation} is that identity, tested against the camera three
 * actually builds rather than trusted.
 *
 * It is a **heading** instrument and not a projected overlay, and the difference is real: the ground
 * is foreshortened under a 45-64° camera, so a point ten metres due north lands at a screen angle up
 * to 0.8° away from the plan-view direction, and the gap grows with the offset. Every game's compass
 * makes the same choice — the badge answers "which way am I pointing", not "where exactly on this
 * pixel does north lie", and drawing an ellipse to chase the second would make the first harder to
 * read.
 *
 * ## Cheap, and the arithmetic of "cheap"
 *
 * DOM rather than canvas: two elements and a `transform`, against a second 2D context with a
 * `clearRect` and four `fillText` calls every frame. The transform is written **only when the
 * rounded degree changes**, so a still camera costs one comparison per frame and allocates nothing;
 * a live orbit costs one string of about twenty characters per changed degree, which is a few hundred
 * bytes a second during a gesture and nothing at all between them. There is no pooling to do beyond
 * that: the elements are `index.html`'s, looked up once at attach, and this class never creates a
 * node.
 */

/** Where the rose lives in `index.html`. Read by id, like every other element this client owns. */
export const COMPASS_ROSE_ID = 'compass-rose';
/** The facing readout under it. */
export const COMPASS_FACING_ID = 'compass-facing';

/**
 * Degrees to rotate the rose, clockwise, for a camera at this yaw. **The identity is `yaw` itself.**
 *
 * See the file header for the derivation. Kept as a named function rather than inlined at the one
 * call site precisely *because* it is an identity: a reader who sees `rotate(${yaw}deg)` has to
 * rediscover why, and a future yaw convention that broke it would break it silently.
 */
export function roseRotation(yawDegrees: number): number {
  return yawDegrees;
}

/**
 * The compass bearing the camera is looking along — `0` north, `90` east, clockwise.
 *
 * The **negative** of the rig's yaw, modulo a turn, because the rig's yaw is the protocol's and that
 * runs anticlockwise (east is `-90`). This is the one place the two conventions are converted, and it
 * exists so that the thing shown to a human is in the units a human means by "bearing".
 */
export function bearingOf(yawDegrees: number): number {
  return ((-yawDegrees % 360) + 360) % 360;
}

/** The eight points, in bearing order from north. */
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Which of the eight points the camera is looking along — the readout under the rose.
 *
 * Eight rather than sixteen: the letters are there to answer *"am I looking roughly east?"* while the
 * rose answers precisely, and NNE on a 3 mm badge is three characters of noise. Rounded, so each
 * point owns 45° centred on itself and due north reads `N` from 337.5° through 22.5°.
 */
export function cardinalOf(yawDegrees: number): string {
  const index = Math.round(bearingOf(yawDegrees) / 45) % POINTS.length;
  return POINTS[index]!;
}

/**
 * The badge. Attached once to elements `index.html` already carries, updated from the render loop.
 *
 * Absent elements are not an error: `main.ts` builds this before it knows whether the page it is
 * running in is the client's own (the tests import this module headlessly, and a stripped host page
 * is a thing that has happened once already with the HUD lines).
 */
export class Compass {
  private rose: HTMLElement | undefined;
  private facing: HTMLElement | undefined;
  /** The last whole degree written, so a still camera writes nothing at all. */
  private lastDegree = Number.NaN;
  private lastPoint = '';

  attach(document: Document): void {
    this.rose = document.getElementById(COMPASS_ROSE_ID) ?? undefined;
    this.facing = document.getElementById(COMPASS_FACING_ID) ?? undefined;
  }

  /**
   * Point the rose. `yawDegrees` is `rig.yaw`, straight through.
   *
   * Called every frame; the two comparisons are the whole cost when nothing has turned. Rounding to a
   * whole degree is well under what a 44 px badge can show — one degree is 0.4 px at its rim — and it
   * is what makes "nothing has turned" true most frames rather than almost-true.
   */
  update(yawDegrees: number): void {
    const degree = Math.round(roseRotation(yawDegrees));
    if (degree === this.lastDegree) return;
    this.lastDegree = degree;
    if (this.rose) this.rose.style.transform = `rotate(${degree}deg)`;
    const point = cardinalOf(yawDegrees);
    if (point !== this.lastPoint) {
      this.lastPoint = point;
      if (this.facing) this.facing.textContent = point;
    }
  }
}
