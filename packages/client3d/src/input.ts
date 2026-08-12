/**
 * Keyboard to intent — `scene.ts:4423–4444`, re-expressed without Phaser.
 *
 * The mapping is unchanged: WASD and the arrows steer, **Shift** turns the same four keys into a
 * single-room `move`, and Q/E take a staircase without a modifier. The reason Shift is required on
 * the compass keys and not on the vertical ones is in the original and still holds — *"Shift is what
 * says 'step through the exit' rather than 'glide that way'… Up and down have no unmodified meaning
 * to disambiguate from, and demanding a modifier for them was friction with nothing on the other
 * side of it."*
 *
 * ## M8b: the glide is camera-relative, the step is not
 *
 * The owner, 2026-08-13: *"make W camera-relative when follow is on"*, and then the sentence that is
 * the whole specification — *"w should always be forward towards what the player is facing"*.
 *
 * So {@link STEER}'s four vectors stopped being world axes and became **the camera's own frame**, and
 * {@link cameraRelative} turns one into a world vector by rotating it through the rig's yaw. At yaw 0
 * the rotation is the identity *to the bit* (see the function), which is why the two tables below
 * still read as north/south/east/west and why this change is provably invisible at the pose everything
 * was authored at.
 *
 * **The rotation is only half the slice.** Making the keys camera-relative closes a feedback loop with
 * follow mode — the camera chases a heading the keys derive from the camera — and measured, that loop
 * is stable going forwards and violently unstable going backwards or sideways. {@link suspendsFollow}
 * is the other half and its docblock carries the numbers; neither half is safe to ship without the
 * other.
 *
 * **{@link TRAVEL} is deliberately untouched.** Shift+W is `move north` — the MUD's own room-to-room
 * step — and north is north in the prose, on the map, in the exits line and in every zone file on
 * disk. There is no frame in which `north` means "the way I am looking"; rotating those would not be a
 * feature, it would be a bug in the compass. So the same four keys mean *camera-forward* unmodified
 * and *world-north* shifted, and the pair is not a contradiction: one glides through a room and the
 * other walks out of it, which is a distinction this client has drawn since it had a keyboard.
 *
 * (Shift being both the travel modifier here and `orbit.ts`'s orbit modifier is pre-existing and
 * means orbiting and keyboard-travel are already mutually exclusive. Noted, not fixed.)
 *
 * ## Both of `CLAUDE.md`'s Phaser input traps, and what happens to them here
 *
 * **(a) Key capture eating characters out of text inputs** is a Phaser-specific hazard: its manager
 * calls `preventDefault()` in a document-level listener that runs before the keystroke reaches a
 * focused `<input>`, which is how `help` once arrived as `hlp`. There is no Phaser here, so the trap
 * does not exist — but the *discipline* it taught does, and this listener refuses to touch a
 * keystroke aimed at a form control at all: no read, and above all no `preventDefault`.
 *
 * **(b) `JustDown` polled in `update` losing chords and short taps** is not Phaser-specific and the
 * fix carries over exactly. A travel step is decided **on the `keydown` event**, reading
 * `event.shiftKey` off the event itself: the modifier state at the moment of the press is what the
 * player meant, and there is no stored edge to fire a frame late. `event.repeat` is dropped, because
 * holding Shift+W should walk one room and not the length of the zone.
 */

import { normaliseIntent, type Direction } from '@mygame/shared';

/**
 * `KeyboardEvent.code` rather than `key`, so a held modifier cannot change which key was pressed.
 *
 * **These are camera-frame vectors, not world ones** — `[0, -1]` is *up the screen*, and it is only
 * also world-north because the camera starts looking north. {@link cameraRelative} is what turns one
 * into a heading the server can walk; nothing should read this table without going through it.
 */
const STEER: Readonly<Record<string, readonly [x: number, y: number]>> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * `[direction, whether Shift is required]` — the `TRAVEL_KEYS` table, same shape, same reasons.
 *
 * **World-absolute at every camera yaw, for ever.** See the file header: these are the MUD's exits and
 * `north` is a fact about the world, not about the frame. `input.test.ts` pins it.
 */
const TRAVEL: Readonly<Record<string, readonly [dir: Direction, needsShift: boolean]>> = {
  KeyW: ['north', true],
  ArrowUp: ['north', true],
  KeyS: ['south', true],
  ArrowDown: ['south', true],
  KeyA: ['west', true],
  ArrowLeft: ['west', true],
  KeyD: ['east', true],
  ArrowRight: ['east', true],
  KeyQ: ['up', false],
  KeyE: ['down', false],
};

/**
 * Exported because `main.ts`'s debug keys have to make the same refusal.
 *
 * Two listeners on one window that disagree about what counts as typing is `CLAUDE.md` gotcha 5a
 * arriving by a different door: the one that does not check would eat a letter out of the command
 * line and the loss would look like a dropped keystroke rather than like a binding.
 */
export function intoFormControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/**
 * Below this, a component is floating-point dust from the rotation and is not a direction. 1e-12.
 *
 * The only thing it exists to delete: `Math.sin(Math.PI)` is 1.22e-16, so a camera looking due south
 * would otherwise send `dx: -1.2246467991473532e-16` for a key that means "straight ahead" — twenty-three
 * characters of noise on the wire, and a `steer` the console could not be read by eye. The threshold is
 * four orders of magnitude above the worst dust a cardinal yaw can produce (2.5e-16) and nine below the
 * smallest component any *reachable* yaw can mean: a drag moves 0.25° per pixel, and the follow ease
 * snaps its tail inside `orbit.FOLLOW_SETTLE_DEGREES` — 0.05°, whose sine is 8.7e-4 — so no gesture can
 * leave the camera at an angle whose genuine sine lands under this. A yaw typed straight into
 * `__debug3d.camera.yaw` could, and would read as exactly north, which is the right answer anyway.
 */
const DUST = 1e-12;

/** Dust to a clean zero, and `-0` with it — `-0 === 0`, so the comparison catches both. */
function clean(value: number): number {
  return value > -DUST && value < DUST ? 0 : value;
}

/**
 * A {@link STEER} vector, rotated out of the camera's frame into the world's. **This is M8b.**
 *
 * `yawDegrees` is `rig.CameraRig.yaw` — the protocol's units, `0` north and anticlockwise seen from
 * above, so west is `+90` and east is `-90`. The world vector is the simulation's own axes, `x` east
 * and `y` **south**, which is what a `steer` message carries and what `entities.step` predicts with.
 *
 * ## The derivation, because both signs have a plausible opposite
 *
 * The camera sits at `(b·sin ψ, ·, b·cos ψ)` from the character and looks back at them (`rig.recompute`),
 * so in world `(x, y)` its **forward** is `F = (-sin ψ, -cos ψ)` and its **right** — the rig's local
 * `+X`, which is `rotY(ψ)` applied to `(1, 0, 0)` — is `R = (cos ψ, -sin ψ)`. A steer `(sx, sy)` is
 * `sx` of the right and `-sy` of the forward, because the table writes up-the-screen as `-1`:
 *
 * ```
 *   world = sx·R + (-sy)·F   =   ( sx·cos ψ + sy·sin ψ ,  sy·cos ψ - sx·sin ψ )
 * ```
 *
 * At `ψ = 0` that is `F = (0, -1)` and `R = (1, 0)` — exactly the table — which is the arithmetic
 * proof that the boot pose is unchanged.
 *
 * ## Byte-identity at yaw 0, and why it is not merely approximate
 *
 * `cos 0` is `1` and `sin 0` is `0`, both exact, so the two expressions collapse to `x·1 + y·0` and
 * `y·1 - x·0`. What has to survive that is the **sign of zero**, because `x·0` is `-0` for a negative
 * `x` and `-0` is a different bit pattern from `0` even though it compares equal: written as a
 * subtraction, `a - (±0)` is `a` for every finite `a` including zero itself, so no case needs checking.
 * The result is that a *diagonal* (0.7071067811865475) comes back as exactly the same double, not
 * merely one within a tolerance — "camera-relative movement at yaw 0 is the old movement" is a fact
 * about the bits. `input.test.ts` asserts it with `Object.is` over all nine key combinations, which is
 * what would catch it if a future edit reordered these terms.
 *
 * **This applies whether follow mode is on or off**, which is the answer to the obvious "shouldn't it
 * be conditional?": a camera the hand has orbited to face west, with keys still walking world-north, is
 * the thing that actually feels broken, and it is reachable with follow off. And because yaw 0
 * degenerates to the old behaviour exactly, there is no mode boundary to explain and no state in which
 * the player has to remember which rule the keyboard is under.
 */
export function cameraRelative(
  intent: { readonly x: number; readonly y: number },
  yawDegrees: number,
): { x: number; y: number } {
  const { x, y } = intent;
  // A rotation of nothing is nothing, exactly — no dust, no `-0`, and `main.ts`'s resend gate still
  // reads a released key as the `steer 0,0` it has always been.
  if (x === 0 && y === 0) return { x: 0, y: 0 };
  // No wrap: cosine and sine are periodic, so 450° rotates like 90° and only a non-finite yaw — which
  // `rig.wrapYaw` would answer 0 for anyway — needs saying out loud.
  if (!Number.isFinite(yawDegrees)) return { x, y };
  const yaw = (yawDegrees * Math.PI) / 180;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return { x: clean(x * cos + y * sin), y: clean(y * cos - x * sin) };
}

/**
 * Whether these keys must **freeze the follow camera** — the other half of M8b, and it is not optional.
 *
 * ## The loop, and why only half of it is stable
 *
 * Camera-relative movement closes a feedback loop that did not exist before it: the steer is rotated by
 * the camera's yaw, the server sets the body's facing from that steer (`sim.ts:2049`), and follow mode
 * eases the camera's yaw toward that facing. Write the camera's yaw as `ψ` and the key's angle *within
 * the camera's frame* as `θ` — 0 for W, ±90 for A and D, 180 for S. Then the body's heading is
 * `quantise(ψ + θ)` and the camera chases it, so a resting state needs `ψ = quantise(ψ + θ)`.
 *
 * For **θ = 0** that is `ψ = quantise(ψ)`, which every cardinal satisfies: the loop converges, monotonically,
 * from any misalignment, and `input.test.ts` sweeps 16 yaws x 4 facings to prove it. For **θ = ±45** the
 * quantiser's *tie* rule supplies the fixed point — `facingOf` keeps the previous facing on an exact
 * diagonal, so W+D settles rather than drifting. For **θ = ±90 and 180 there is no solution at all**, and
 * measured rather than merely argued, the result is:
 *
 * ```
 *   A or D    the camera makes complete revolutions — 356° of yaw in the steady state
 *   S+A, S+D  the same, 356°
 *   S         a limit cycle: the target flips between two cardinals every frame, and the world
 *             shakes ±5° at 30 Hz around the diagonal
 * ```
 *
 * That is not a rough edge, it is the client shaking itself apart on a held key, and it is the same
 * shape of bug `dolly.FOLLOW_ON_FRESH` originally shipped `false` to avoid — arriving on S instead of W.
 *
 * ## The rule, and why it is this one
 *
 * **Forward keeps the camera; everything else freezes it.** In the camera's own frame "forward" is
 * simply `y < 0` — the table's own up-the-screen — so the test is one comparison and needs no dot
 * product. It partitions exactly along the stability line measured above, which is the reason to prefer
 * it to the cruder "freeze whenever any key is down": that would work, but it would also throw away the
 * one case that converges, and with it the behaviour the owner asked for — the camera settling in behind
 * you as you run.
 *
 * It is also the *right* rule rather than a lucky one. Backing up and sidestepping are defined
 * **relative to the camera**; a camera that moved in response to them would be redefining the gesture
 * while the gesture was still being made. Every third-person game with a strafe key does this, and
 * `orbit.ts` already states the principle for the other hand — a hand on the controls outranks a rule
 * about where the camera should be. This is the same suspension the Shift+drag takes, for the same
 * reason, through the same parameter.
 *
 * **This is a stopgap with a named successor.** ROADMAP task #35 gives the simulation a real float
 * heading fed by the camera rather than derived from movement, and when it lands the loop is gone at its
 * source and this predicate should go with it.
 */
export function suspendsFollow(keys: { readonly x: number; readonly y: number }): boolean {
  // An idle keyboard claims nothing: the camera must still settle in behind a body that has stopped,
  // which is where a strafe's 90° of accumulated disagreement gets paid off.
  if (keys.x === 0 && keys.y === 0) return false;
  return keys.y >= 0;
}

export class Input {
  private readonly held = new Set<string>();
  /**
   * Raised while the caret is in the command line **or** the login card is up.
   *
   * Composed by `main.ts` from both sources, exactly as the Phaser client composes its typing gate,
   * because either source alone clearing it would re-arm the keyboard while the other still needs it
   * off.
   */
  typing = false;
  onTravel: ((dir: Direction) => void) | undefined;
  /** Raised on any movement key's press edge — what takes the wheel back from a server-walked path. */
  onManual: (() => void) | undefined;

  attach(): void {
    window.addEventListener('keydown', this.down);
    window.addEventListener('keyup', this.up);
    // A key held while the tab loses focus never sends its `keyup`, so the character walks into a
    // wall until you come back and press it again.
    window.addEventListener('blur', this.clear);
  }

  detach(): void {
    window.removeEventListener('keydown', this.down);
    window.removeEventListener('keyup', this.up);
    window.removeEventListener('blur', this.clear);
    this.held.clear();
  }

  /**
   * The steering intent this frame, normalised.
   *
   * Zero while Shift is held: gliding and stepping at once would walk the character back out of the
   * room it just entered.
   */
  intent(): { x: number; y: number } {
    if (this.typing) return { x: 0, y: 0 };
    if (this.held.has('ShiftLeft') || this.held.has('ShiftRight')) return { x: 0, y: 0 };
    let dx = 0;
    let dy = 0;
    for (const code of this.held) {
      const step = STEER[code];
      if (!step) continue;
      dx += step[0];
      dy += step[1];
    }
    return normaliseIntent(dx, dy);
  }

  private readonly down = (event: KeyboardEvent): void => {
    if (this.typing || intoFormControl(event.target)) return;
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.held.add(event.code);
      return;
    }
    if (event.code in STEER) event.preventDefault();
    const wasSteering = STEER[event.code] !== undefined;
    if (wasSteering && !this.held.has(event.code)) this.onManual?.();
    this.held.add(event.code);
    if (event.repeat) return;
    const travel = TRAVEL[event.code];
    if (travel && (!travel[1] || event.shiftKey)) this.onTravel?.(travel[0]);
  };

  private readonly up = (event: KeyboardEvent): void => {
    this.held.delete(event.code);
  };

  private readonly clear = (): void => {
    this.held.clear();
  };
}
