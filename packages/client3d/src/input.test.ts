/**
 * M8b — the keyboard's frame, and the loop it closes with the camera.
 *
 * Seven properties, and every one of them is a way the owner would report *"movement is broken"* rather
 * than a bug with a name:
 *
 * 1. **Yaw 0 is the old behaviour, to the bit.** This is the property that makes the whole slice safe:
 *    the boot pose, the **C** key's home and a settled follow facing north all sit at yaw 0, so if the
 *    rotation is the identity there then nothing anybody has ever seen has changed. Asserted with
 *    `Object.is` over every key combination — a diagonal has to come back as the *same double*, not one
 *    within a tolerance, because "close enough" here would be a slow drift nobody could bisect.
 * 2. **The basis turns as one.** W is forward at every yaw, and D is 90° clockwise of it. Testing W
 *    alone would pass with the handedness inverted and A/D swapped, which is the single most likely
 *    way to get this wrong and the hardest to see in a screenshot.
 * 3. **Travel keys do not rotate.** Shift+W is `move north` at every camera angle, because `north` is
 *    north in the prose, on the map and in every zone file. Driven through the *real* `keydown`
 *    listener, because the property is about the listener's split and not about a table.
 * 4. **The loop converges — for the half of it that can.** With follow on, the camera eases toward the
 *    body's heading while the body's heading is set by camera-relative movement, which is a feedback
 *    loop and the one place this slice could produce something that feels drunk. **Forward converges**
 *    (swept over 16 camera yaws x 4 facings, with monotone approach asserted frame by frame) and
 *    **nothing else does** — a held sidestep spins the world through complete revolutions and a held
 *    backstep shakes it at 30 Hz. That measurement is why `input.suspendsFollow` exists, and both halves
 *    are pinned here: the forward sweep, and a characterisation of the unguarded hazard that a future
 *    edit would trip over before deciding the freeze was decoration.
 * 5. **Every held direction is stable once the freeze is in.** All eight, from 32 camera angles, from
 *    all four starting facings — the frozen five walk a dead straight line and the forward three settle.
 *    This is the property the owner would actually notice, and it is the reason to sweep rather than
 *    spot-check.
 * 6. **Nothing rotated is still nothing.** A rotation of the zero vector is exactly zero, `-0` included,
 *    at every angle — so `main.ts`'s resend gate reads a released key as the `steer 0,0` it always was
 *    and does not put a message on the wire every frame the camera is turning.
 * 7. **Follow off is not a second mode.** The yaw simply stops changing, so the walk is a straight line
 *    and one `steer` goes out. There is no branch in `cameraRelative` and this proves there is no need
 *    of one.
 *
 * The server's half of property 4 is `sim.ts`'s `facingOf`, mirrored below rather than imported — the
 * client cannot reach into `@mygame/server`, and a three-line copy with the original's line number on
 * it is more honest than a fake. {@link facingOf} carries the check that keeps the copy from rotting.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normaliseIntent, yawOf, type Direction } from '@mygame/shared';

import { cameraRelative, Input, suspendsFollow } from './input.ts';
import { FollowCamera } from './orbit.ts';
import { wrapYaw } from './rig.ts';

/* -------------------------------------------------------------------------- */
/* The keyboard's own vectors, as `Input.intent()` hands them over             */
/* -------------------------------------------------------------------------- */

/**
 * Every steer vector the four keys can produce, already normalised.
 *
 * Nine, not four: the diagonals are where a rounding shortcut would show first, and the zero is the
 * released-key case property 5 is about.
 */
const STEERS = {
  W: normaliseIntent(0, -1),
  S: normaliseIntent(0, 1),
  A: normaliseIntent(-1, 0),
  D: normaliseIntent(1, 0),
  WD: normaliseIntent(1, -1),
  WA: normaliseIntent(-1, -1),
  SD: normaliseIntent(1, 1),
  SA: normaliseIntent(-1, 1),
  none: normaliseIntent(0, 0),
} as const;

/** Sixteen yaws, 22.5° apart — the cardinals, the diagonals, and the eight angles between. */
const SWEEP_YAWS = Array.from({ length: 16 }, (_, index) => wrapYaw(index * 22.5));

/** `Object.is` on both components, so `-0` fails against `0`. Tolerances are the enemy here. */
function assertSame(actual: { x: number; y: number }, expected: { x: number; y: number }, what: string): void {
  assert.ok(Object.is(actual.x, expected.x), `${what}: x was ${actual.x}, wanted ${expected.x}`);
  assert.ok(Object.is(actual.y, expected.y), `${what}: y was ${actual.y}, wanted ${expected.y}`);
}

describe('cameraRelative: yaw 0 is the identity, to the bit', () => {
  it('returns the same doubles it was given, for every key combination', () => {
    // The safety property the whole slice rests on. A diagonal is 0.7071067811865475 and it has to come
    // back as *that*, not 0.707107 and not 0.7071067811865476 — the boot pose is yaw 0, so any drift
    // here is a change to behaviour the owner has already signed off, arriving silently.
    for (const [name, steer] of Object.entries(STEERS)) {
      assertSame(cameraRelative(steer, 0), steer, `${name} at yaw 0`);
    }
  });

  it('treats a negative zero yaw the same, because wrapYaw can produce one', () => {
    for (const [name, steer] of Object.entries(STEERS)) {
      assertSame(cameraRelative(steer, -0), steer, `${name} at yaw -0`);
    }
  });

  it('leaves the vector alone rather than emitting NaN when the yaw is not a number', () => {
    // `rig.yaw` cannot be one — its setter wraps — but a rotation that answered `{NaN, NaN}` would send
    // the character nowhere and the failure would surface as "movement stopped", four files away.
    assertSame(cameraRelative(STEERS.W, Number.NaN), STEERS.W, 'W at a NaN yaw');
    assertSame(cameraRelative(STEERS.W, Number.POSITIVE_INFINITY), STEERS.W, 'W at an infinite yaw');
  });
});

describe('cameraRelative: the cardinals come out exact', () => {
  /** `[yaw, what W means there]` — the camera's forward, in world axes with `y` south. */
  const CASES: readonly (readonly [yaw: number, x: number, y: number, name: string])[] = [
    [0, 0, -1, 'north'],
    [90, -1, 0, 'west'],
    [180, 0, 1, 'south'],
    [-90, 1, 0, 'east'],
  ];

  it('sends W the way the camera is looking, with no floating-point dust on the wire', () => {
    // Exact equality on purpose: `Math.sin(Math.PI)` is 1.22e-16, so without `input.ts`'s dust floor a
    // camera looking due south would put `dx: -1.2246467991473532e-16` on the wire for a key that means
    // "straight ahead". This is the assertion that would catch that floor being removed.
    for (const [yaw, x, y, name] of CASES) {
      assertSame(cameraRelative(STEERS.W, yaw), { x, y }, `W at yaw ${yaw} should be ${name}`);
    }
  });

  it('turns the whole basis together — D is a quarter turn clockwise of W, at every yaw', () => {
    // The property that testing W alone would miss. Invert the handedness and W still points where the
    // camera looks; A and D swap, which reads as "the controls are mirrored" and is invisible in a
    // still frame.
    for (const yaw of SWEEP_YAWS) {
      const forward = cameraRelative(STEERS.W, yaw);
      const right = cameraRelative(STEERS.D, yaw);
      // Rotating `(x, y)` a quarter turn clockwise on a screen-space y-down axis pair gives `(-y, x)`.
      assert.ok(
        Math.abs(right.x - -forward.y) < 1e-12 && Math.abs(right.y - forward.x) < 1e-12,
        `at yaw ${yaw}, D was (${right.x}, ${right.y}) but a clockwise quarter turn of W is (${-forward.y}, ${forward.x})`,
      );
      // And back is the negative of forward, which pins S against a sign flip that swapping A and D
      // would otherwise hide.
      const back = cameraRelative(STEERS.S, yaw);
      assert.ok(
        Math.abs(back.x + forward.x) < 1e-12 && Math.abs(back.y + forward.y) < 1e-12,
        `at yaw ${yaw}, S was not the opposite of W`,
      );
    }
  });

  it('is a rotation: length is preserved and a full turn is a no-op', () => {
    for (const yaw of SWEEP_YAWS) {
      for (const [name, steer] of Object.entries(STEERS)) {
        const turned = cameraRelative(steer, yaw);
        assert.ok(
          Math.abs(Math.hypot(turned.x, turned.y) - Math.hypot(steer.x, steer.y)) < 1e-12,
          `${name} at yaw ${yaw} changed length`,
        );
        const wrapped = cameraRelative(steer, yaw + 360);
        assert.ok(
          Math.abs(wrapped.x - turned.x) < 1e-12 && Math.abs(wrapped.y - turned.y) < 1e-12,
          `${name} disagreed between yaw ${yaw} and ${yaw + 360}`,
        );
      }
    }
  });

  it('puts W on the diagonal at 45°, which is the case a cardinals-only test would pass without', () => {
    // Camera looking north-west: W walks north-west. Both components negative and equal in magnitude —
    // an axis-swap bug survives every cardinal and dies here.
    const turned = cameraRelative(STEERS.W, 45);
    assert.ok(turned.x < 0 && turned.y < 0, `W at yaw 45 went (${turned.x}, ${turned.y}), not north-west`);
    assert.ok(Math.abs(turned.x - turned.y) < 1e-12, 'the 45° diagonal was not symmetric');
    assert.ok(Math.abs(Math.hypot(turned.x, turned.y) - 1) < 1e-12, 'the 45° diagonal was not a unit vector');
  });
});

describe('cameraRelative: a rotation of nothing is nothing', () => {
  it('answers exactly zero at every yaw, with no negative zero', () => {
    // `-0` would compare equal to `0` in `main.ts`'s resend gate, so this is not about that — it is
    // about `JSON.stringify` writing `-0` as `0` while `Object.is` disagrees, which is the shape of bug
    // that makes a wire log and a debugger tell two different stories.
    for (const yaw of [...SWEEP_YAWS, 45, -137.891, 1e-9, 360, -360]) {
      assertSame(cameraRelative(STEERS.none, yaw), { x: 0, y: 0 }, `zero at yaw ${yaw}`);
    }
  });

  it('sends no steer while no key is held, however hard the camera is turning', () => {
    // `main.ts`'s gate, modelled: `intent.x !== lastIntentX || intent.y !== lastIntentY`. The camera
    // sweeping a full circle under an idle keyboard must put nothing on the wire at all — otherwise
    // every orbit gesture would be sixty `steer 0,0` a second.
    let lastX = 0;
    let lastY = 0;
    let sent = 0;
    for (let yaw = -180; yaw <= 180; yaw += 0.25) {
      const intent = cameraRelative(STEERS.none, yaw);
      if (intent.x !== lastX || intent.y !== lastY) {
        sent += 1;
        lastX = intent.x;
        lastY = intent.y;
      }
    }
    assert.equal(sent, 0, 'an idle keyboard put steer messages on the wire while the camera turned');
  });
});

/* -------------------------------------------------------------------------- */
/* Travel keys stay world-absolute                                             */
/* -------------------------------------------------------------------------- */

describe('the travel keys are the MUD’s own directions and do not turn with the camera', () => {
  /** Shift+key, and the exit it must always name. `Input` is not even told the camera's yaw. */
  const SHIFTED: readonly (readonly [code: string, dir: Direction])[] = [
    ['KeyW', 'north'],
    ['KeyS', 'south'],
    ['KeyA', 'west'],
    ['KeyD', 'east'],
    ['ArrowUp', 'north'],
    ['ArrowLeft', 'west'],
  ];

  it('names north for Shift+W, and the camera’s angle is not an input to that at all', () => {
    // The structural half of the property, and the strongest form of it: `Input` has no yaw parameter,
    // no yaw field and no import that could reach one, so there is no angle at which this could differ.
    // The rotation lives entirely in `cameraRelative`, which the travel path never calls.
    for (const [code, dir] of SHIFTED) {
      const input = new Input();
      const travelled: Direction[] = [];
      input.onTravel = (direction) => travelled.push(direction);
      input.attach();
      keydown(code, { shiftKey: true });
      input.detach();
      assert.deepEqual(travelled, [dir], `shift+${code} should be ${dir}`);
    }
  });

  it('takes the staircase on Q and E without a modifier, unchanged', () => {
    const input = new Input();
    const travelled: Direction[] = [];
    input.onTravel = (direction) => travelled.push(direction);
    input.attach();
    keydown('KeyQ', {});
    keydown('KeyE', {});
    input.detach();
    assert.deepEqual(travelled, ['up', 'down']);
  });

  it('still refuses to glide while Shift is down, so a step cannot be walked back out of', () => {
    // Pre-existing and load-bearing for the property above: the shifted press that names an exit must
    // not also produce a steer, or the character would leave the room and immediately walk back in.
    const input = new Input();
    input.attach();
    keydown('ShiftLeft', {});
    keydown('KeyW', { shiftKey: true });
    assert.deepEqual(input.intent(), { x: 0, y: 0 }, 'a shifted W glided as well as stepping');
    // And the rotation cannot resurrect it: nothing times a rotation matrix is still nothing.
    assertSame(cameraRelative(input.intent(), 137), { x: 0, y: 0 }, 'a shifted W at an orbited yaw');
    input.detach();
  });

  it('reads the unshifted key as a camera-frame glide, which is the other half of the split', () => {
    const input = new Input();
    input.attach();
    keydown('KeyW', {});
    // Camera-frame `(0, -1)`: up the screen. At yaw 0 that is world-north and identical to the old
    // behaviour; at yaw -90 the same keypress is world-east, and the same key shifted is still `north`.
    assert.deepEqual(input.intent(), { x: 0, y: -1 });
    assertSame(cameraRelative(input.intent(), -90), { x: 1, y: 0 }, 'W glides east with the camera facing east');
    input.detach();
  });
});

/* -------------------------------------------------------------------------- */
/* The feedback loop                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `sim.ts:2542`'s `facingOf`, mirrored — the client cannot import the server.
 *
 * The **tie rule is the one that matters** and it is the reason this loop is stable at all: a steer
 * exactly on a diagonal keeps the previous facing rather than picking one, so the camera at 45° is not
 * handed a target that flips between north and west frame by frame. Copied, not paraphrased.
 */
function facingOf(dx: number, dy: number, previous: Direction): Direction {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'south' : 'north';
  return previous;
}

const CARDINALS: readonly Direction[] = ['north', 'east', 'south', 'west'];

/** The wire's yaw for a facing, in the rig's degrees — `FollowCamera.update`'s own conversion. */
function degreesOf(facing: Direction): number {
  return wrapYaw((yawOf(facing) * 180) / Math.PI);
}

/** 60 fps, the rate `main.ts` clamps to and the one the half-life is quoted against. */
const FRAME_SECONDS = 1 / 60;

/** Thirty-two yaws, 11.25° apart — the sweep's own sixteen and the sixteen between them. */
const FINE_YAWS = Array.from({ length: 32 }, (_, index) => wrapYaw(index * 11.25));

/**
 * Hold a key combination for `frames` from a given camera yaw and body facing, closing the loop.
 *
 * Client rotates the steer -> server picks a facing from it (`facingOf`) -> the wire carries the
 * facing's yaw -> the camera eases toward it -> the next frame's steer is rotated by the new yaw. Uses
 * the real {@link FollowCamera} and the real {@link suspendsFollow}, primed so the first-sight snap is
 * spent on a no-op rather than teleporting the camera onto the answer.
 *
 * `honourSuspension` is the switch that makes the hazard visible: pass `false` and the loop runs
 * unguarded, which is what the client did between the rotation landing and the freeze landing.
 * `main.ts`'s two ownership checks (a held pointer, a server-walked route) are the caller's, not
 * modelled here — neither can be true while the keyboard is the thing driving.
 */
function hold(
  steer: { readonly x: number; readonly y: number },
  startYaw: number,
  startFacing: Direction,
  frames: number,
  honourSuspension = true,
) {
  const follow = new FollowCamera(true);
  // Spend the `seeded` snap against the camera's own angle: `update` returns that angle unchanged, and
  // every frame after it eases. This is the state the **O** key leaves the mode in, which is the only
  // way a real session reaches a misaligned camera with follow armed.
  follow.update(startYaw, (startYaw * Math.PI) / 180, FRAME_SECONDS, false);
  const suspended = honourSuspension && suspendsFollow(steer);

  let yaw = startYaw;
  let facing = startFacing;
  const trace: { yaw: number; facing: Direction; x: number; y: number }[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const world = cameraRelative(steer, yaw);
    facing = facingOf(world.x, world.y, facing);
    const eased = follow.update(yaw, yawOf(facing), FRAME_SECONDS, suspended);
    if (eased !== undefined) yaw = eased;
    trace.push({ yaw, facing, x: world.x, y: world.y });
  }
  return trace;
}

/** Just W, which is the case the freeze deliberately lets through. */
function holdW(startYaw: number, startFacing: Direction, frames: number) {
  return hold(STEERS.W, startYaw, startFacing, frames);
}

describe('holding W with follow on: the camera and the body converge, from any misalignment', () => {
  /**
   * 3.5 s, and the number is derived rather than guessed.
   *
   * Every yaw is within 45° of a cardinal, so 45° is the widest arc this loop can ever have to close.
   * At 60 fps the ease closes `1 - 2^(-(1/60)/0.3)` = 3.7748% of the remainder per frame, so the arc
   * left after `n` frames is `45 x 0.96225^n` and it drops under `FOLLOW_SETTLE_DEGREES` (0.05°, where
   * the ease snaps the tail) at `n = 177`. The measured worst case is 178 — yaw 45 exactly, where the
   * diagonal tie spends one frame aiming at the far cardinal before the neighbour wins. 210 is that
   * with a fifth in hand; a regression that made this loop *slower* rather than unstable would show up
   * here rather than passing quietly.
   */
  const SETTLE_FRAMES = 210;
  const EXTRA_FRAMES = 200;

  it('settles on a cardinal, and stays there, from all 16 yaws and all 4 starting facings', () => {
    for (const startYaw of SWEEP_YAWS.map((yaw) => wrapYaw(yaw + 11.25)).concat(SWEEP_YAWS)) {
      for (const startFacing of CARDINALS) {
        const trace = holdW(startYaw, startFacing, SETTLE_FRAMES + EXTRA_FRAMES);
        const settled = trace[SETTLE_FRAMES - 1]!;
        const where = `from yaw ${startYaw} facing ${startFacing}`;

        // The camera arrived on one of the four, exactly — not near one.
        assert.ok(
          CARDINALS.some((dir) => Object.is(settled.yaw, degreesOf(dir))),
          `${where}: camera settled at ${settled.yaw}, which is not a cardinal`,
        );
        // The body agrees with it, and the walk is the exact unit vector of that cardinal.
        assert.equal(degreesOf(settled.facing), settled.yaw, `${where}: body and camera disagree`);
        assert.equal(Math.abs(settled.x) + Math.abs(settled.y), 1, `${where}: the travel direction is off-axis`);

        // No drift: 200 further frames of holding W change nothing at all.
        for (const later of trace.slice(SETTLE_FRAMES)) {
          assert.ok(Object.is(later.yaw, settled.yaw), `${where}: the camera drifted after settling`);
          assert.equal(later.facing, settled.facing, `${where}: the facing changed after settling`);
          assert.ok(Object.is(later.x, settled.x) && Object.is(later.y, settled.y), `${where}: the walk drifted`);
        }
      }
    }
  });

  it('approaches monotonically — never overshoots, never doubles back', () => {
    // This is the "does it feel drunk" assertion. Converging is not enough: a loop that swung past its
    // target and came back would also converge, and would read as the camera wobbling every time the
    // player turned a corner. The distance to the final heading must fall every single frame.
    for (const startYaw of SWEEP_YAWS) {
      for (const startFacing of CARDINALS) {
        const trace = holdW(startYaw, startFacing, SETTLE_FRAMES);
        const target = trace[trace.length - 1]!.yaw;
        let previous = Math.abs(wrapYaw(target - startYaw));
        for (const [index, step] of trace.entries()) {
          const distance = Math.abs(wrapYaw(target - step.yaw));
          assert.ok(
            distance <= previous + 1e-9,
            `from yaw ${startYaw} facing ${startFacing}: frame ${index} moved away from ${target} (${previous} -> ${distance})`,
          );
          previous = distance;
        }
      }
    }
  });

  it('changes the body’s facing at most once on the way, so the walk curves rather than zig-zags', () => {
    // A steer that starts exactly on a diagonal is handed the *previous* facing by `facingOf`, so the
    // first frame can aim the camera at a cardinal 45° away and the second can settle on its neighbour.
    // One such correction is the arc straightening out; two would be a hunt.
    for (const startYaw of SWEEP_YAWS) {
      for (const startFacing of CARDINALS) {
        const trace = holdW(startYaw, startFacing, SETTLE_FRAMES);
        let changes = 0;
        for (let index = 1; index < trace.length; index += 1) {
          if (trace[index]!.facing !== trace[index - 1]!.facing) changes += 1;
        }
        assert.ok(changes <= 1, `from yaw ${startYaw} facing ${startFacing}: the facing changed ${changes} times`);
      }
    }
  });

  it('is already settled when the camera starts on the body’s own heading — the common case', () => {
    // What every ordinary frame looks like: follow has caught up, W walks dead ahead, and neither the
    // camera nor the wire moves. If this ever stopped holding, the client would be sending a `steer`
    // sixty times a second for a character walking in a straight line.
    for (const facing of CARDINALS) {
      const trace = holdW(degreesOf(facing), facing, 30);
      for (const step of trace) {
        assert.ok(Object.is(step.yaw, degreesOf(facing)), `${facing}: the camera moved off a settled heading`);
        assert.equal(step.facing, facing);
      }
    }
  });
});

describe('suspendsFollow: forward keeps the camera, everything else freezes it', () => {
  it('splits the eight directions exactly along the line stability falls on', () => {
    // Not a taste call — the partition below is the measured one. `input.ts`'s docblock has the
    // arithmetic: a resting state needs `ψ = quantise(ψ + θ)`, which θ = 0 and θ = ±45 satisfy and
    // θ = ±90, 180 cannot. The two tests after this one hold both halves to it.
    assert.equal(suspendsFollow(STEERS.W), false, 'forward must keep following');
    assert.equal(suspendsFollow(STEERS.WA), false, 'forward-left must keep following');
    assert.equal(suspendsFollow(STEERS.WD), false, 'forward-right must keep following');
    assert.equal(suspendsFollow(STEERS.A), true, 'a sidestep must freeze the camera');
    assert.equal(suspendsFollow(STEERS.D), true, 'a sidestep must freeze the camera');
    assert.equal(suspendsFollow(STEERS.S), true, 'backing up must freeze the camera');
    assert.equal(suspendsFollow(STEERS.SA), true, 'backing away must freeze the camera');
    assert.equal(suspendsFollow(STEERS.SD), true, 'backing away must freeze the camera');
  });

  it('claims nothing when no key is held, so a stopped body still gets the camera behind it', () => {
    // The release valve. A player who strafed 90° out of alignment pays it off the moment they let go,
    // which is the only reason freezing during the strafe is affordable at all.
    assert.equal(suspendsFollow(STEERS.none), false);
  });
});

describe('every held direction is stable, from every camera angle', () => {
  const FRAMES = 600;

  it('leaves the camera still and the walk straight for every frozen direction', () => {
    // With the freeze in place these five have no loop to close: the yaw is a constant, so the rotated
    // steer is a constant, so the character walks a dead straight line for as long as the key is down.
    for (const name of ['A', 'D', 'S', 'SA', 'SD'] as const) {
      for (const startYaw of FINE_YAWS) {
        for (const startFacing of CARDINALS) {
          const trace = hold(STEERS[name], startYaw, startFacing, FRAMES);
          const first = trace[0]!;
          for (const step of trace) {
            assert.ok(Object.is(step.yaw, startYaw), `${name} from yaw ${startYaw}: the camera moved`);
            assert.ok(
              Object.is(step.x, first.x) && Object.is(step.y, first.y),
              `${name} from yaw ${startYaw}: the walk direction moved`,
            );
          }
        }
      }
    }
  });

  it('settles the camera and the walk for every forward direction, including the diagonals', () => {
    // The half the freeze deliberately lets through, and the diagonals are the interesting case: their
    // fixed point is supplied by `facingOf`'s *tie* rule rather than by the identity, so W+D settling
    // is a fact about the server's tie-breaking and would break if that rule ever changed.
    for (const name of ['W', 'WA', 'WD'] as const) {
      for (const startYaw of FINE_YAWS) {
        for (const startFacing of CARDINALS) {
          const trace = hold(STEERS[name], startYaw, startFacing, FRAMES);
          const settled = trace[FRAMES - 201]!;
          for (const later of trace.slice(FRAMES - 200)) {
            assert.ok(
              Object.is(later.yaw, settled.yaw),
              `${name} from yaw ${startYaw} facing ${startFacing}: the camera never settled (${settled.yaw} -> ${later.yaw})`,
            );
            assert.equal(later.facing, settled.facing, `${name} from yaw ${startYaw}: the facing never settled`);
            assert.ok(
              Object.is(later.x, settled.x) && Object.is(later.y, settled.y),
              `${name} from yaw ${startYaw}: the walk never settled`,
            );
          }
        }
      }
    }
  });
});

describe('the loop the freeze exists to break is real — do not delete it', () => {
  /**
   * Characterisation, not aspiration. These two assertions describe the *broken* behaviour on purpose:
   * they are what a future edit would trip over if it decided `suspendsFollow` looked unnecessary and
   * removed it. When ROADMAP task #35 gives the simulation a real float heading the loop goes away at
   * its source and these should fail — at which point read them, delete them, and delete the freeze.
   */
  const FRAMES = 600;
  const STEADY = 300;

  it('spins the world through complete revolutions on a held sidestep, unguarded', () => {
    const trace = hold(STEERS.D, 0, 'north', FRAMES, false);
    const tail = trace.slice(STEADY).map((step) => step.yaw);
    const swing = Math.max(...tail) - Math.min(...tail);
    assert.ok(swing > 300, `an unguarded sidestep only swung the camera ${swing}°; the loop may have moved`);
  });

  it('shakes it at half the frame rate on a held backstep, unguarded', () => {
    const trace = hold(STEERS.S, 0, 'north', FRAMES, false);
    let flips = 0;
    for (let index = STEADY + 1; index < FRAMES; index += 1) {
      if (trace[index]!.facing !== trace[index - 1]!.facing) flips += 1;
    }
    assert.ok(flips > 200, `an unguarded backstep only flipped the facing ${flips} times; the loop may have moved`);
  });

  it('and the guarded versions of both are dead still', () => {
    for (const name of ['D', 'S'] as const) {
      const trace = hold(STEERS[name], 0, 'north', FRAMES);
      const tail = trace.slice(STEADY).map((step) => step.yaw);
      assert.equal(Math.max(...tail) - Math.min(...tail), 0, `${name} moved the camera with the freeze on`);
    }
  });
});

describe('holding W with follow off: no loop, and one steer', () => {
  it('walks a straight line at whatever angle the hand left the camera', () => {
    // With the mode disarmed there is no feedback at all — the yaw is a constant, so the rotation is a
    // constant, so `main.ts`'s resend gate fires exactly once. This is why `cameraRelative` needs no
    // branch on follow mode: the two "modes" are one function with a variable that stops varying.
    const yaw = -137.891;
    const first = cameraRelative(STEERS.W, yaw);
    let lastX = 0;
    let lastY = 0;
    let sent = 0;
    for (let frame = 0; frame < 600; frame += 1) {
      const intent = cameraRelative(STEERS.W, yaw);
      assertSame(intent, first, `frame ${frame}`);
      if (intent.x !== lastX || intent.y !== lastY) {
        sent += 1;
        lastX = intent.x;
        lastY = intent.y;
      }
    }
    assert.equal(sent, 1, 'a straight walk under a still camera did not send exactly one steer');
  });
});

/* -------------------------------------------------------------------------- */
/* Headless DOM, borrowed from `orbit.test.ts`                                 */
/* -------------------------------------------------------------------------- */

/** The `keydown` listeners `Input.attach` registered, in order. */
const windowListeners = new Map<string, Set<(event: unknown) => void>>();

(globalThis as unknown as { window: unknown }).window = {
  addEventListener: (type: string, handler: (event: unknown) => void): void => {
    let held = windowListeners.get(type);
    if (!held) {
      held = new Set();
      windowListeners.set(type, held);
    }
    held.add(handler);
  },
  removeEventListener: (type: string, handler: (event: unknown) => void): void => {
    windowListeners.get(type)?.delete(handler);
  },
};

/**
 * `input.intoFormControl` is four `instanceof`s against DOM classes, and `instanceof` against an
 * undeclared name is a `ReferenceError` rather than `false`. `orbit.test.ts`'s note, same fix: nothing
 * here is ever an instance of one, and the branch under test is the first line, which returns `false`.
 */
for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement']) {
  (globalThis as unknown as Record<string, unknown>)[name] ??= class {};
}

/** A `keydown` through the real listener, with only the fields `Input` reads. */
function keydown(code: string, init: { shiftKey?: boolean; repeat?: boolean }): void {
  for (const handler of windowListeners.get('keydown') ?? []) {
    handler({
      code,
      shiftKey: init.shiftKey ?? false,
      repeat: init.repeat ?? false,
      target: null,
      preventDefault: (): void => {},
    });
  }
}
