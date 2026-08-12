/**
 * The click-vs-hold state machine, driven by plain numbers and a fake {@link PointerControl.resolve}
 * — no `PointerEvent`, no `three`, no `World3D` — plus one integration case that assembles a `resolve`
 * the way `main.ts` really does, against a real `World3D` and the fixture zone, to prove the seen-gate
 * wiring and the `ty * grid.width + tx` index it depends on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bitsToBase64, createBitset, bitsetAdd } from '@mygame/shared/vision.ts';

import { sampleZone } from './fixture.ts';
import { HEADING_STEPS, HOLD_THRESHOLD_MS, PointerControl, type PointerTarget } from './pointer.ts';
import { World3D } from './world3d.ts';

/** A resolver that always answers the same target, for the tests that do not care where it landed. */
function fixedResolver(target: PointerTarget | undefined): PointerControl['resolve'] {
  return () => target;
}

const TARGET: PointerTarget = { tx: 10, ty: 4, simX: 320, simY: 128, seen: true };

describe('PointerControl: press is a click and the start of a possible hold, together', () => {
  it('fires onPress synchronously, with the resolved target', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    const seen: (PointerTarget | undefined)[] = [];
    pointer.onPress = (target) => seen.push(target);

    pointer.press(1, 1000, 0, 0);
    assert.deepEqual(seen, [TARGET]);
    assert.equal(pointer.pointerDown, true);
    assert.equal(pointer.steering, false, 'a press is not yet a hold');
    assert.deepEqual(pointer.lastTarget, TARGET);
  });

  it('passes `undefined` through when the ray misses the ground', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(undefined);
    let received: PointerTarget | undefined = TARGET;
    let calls = 0;
    pointer.onPress = (target) => {
      received = target;
      calls++;
    };
    pointer.press(1, 0, 0, 0);
    assert.equal(calls, 1);
    assert.equal(received, undefined);
  });
});

describe('PointerControl: the hold threshold', () => {
  it(`stays a click under ${HOLD_THRESHOLD_MS} ms — no steering, no onSteerStart`, () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    let starts = 0;
    pointer.onSteerStart = () => starts++;

    pointer.press(1, 1000, 0, 0);
    pointer.tick(1000 + HOLD_THRESHOLD_MS - 1, 0, 0);
    assert.equal(pointer.steering, false);
    assert.equal(starts, 0);
    assert.deepEqual(pointer.intent(), { x: 0, y: 0 });
  });

  it('a release before the threshold ends the press outright', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    pointer.press(1, 1000, 0, 0);
    pointer.release(1);
    assert.equal(pointer.pointerDown, false);
    assert.equal(pointer.lastTarget, undefined);
    // A late tick for a pointer that is no longer down must not resurrect it.
    pointer.tick(1000 + 500, 0, 0);
    assert.equal(pointer.steering, false);
  });

  it(`starts steering exactly once, the instant ${HOLD_THRESHOLD_MS} ms is crossed`, () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    let starts = 0;
    pointer.onSteerStart = () => starts++;

    pointer.press(1, 1000, 0, 0);
    pointer.tick(1000 + 100, 0, 0); // under the threshold
    assert.equal(pointer.steering, false);
    assert.equal(starts, 0);

    pointer.tick(1000 + HOLD_THRESHOLD_MS, 0, 0); // exactly at it
    assert.equal(pointer.steering, true);
    assert.equal(starts, 1);

    pointer.tick(1000 + 400, 0, 0); // still held, well past it
    assert.equal(pointer.steering, true);
    assert.equal(starts, 1, 'onSteerStart fires once a press, not once a frame');
  });
});

describe('PointerControl: the steer intent, once steering', () => {
  it('normalises and quantises the heading from self toward the resolved target', () => {
    // (400, 300) - (100, 300) = (300, 0) -> normalised (1, 0). Chosen axis-aligned so the expected
    // heading needs no trigonometry to state.
    const target: PointerTarget = { tx: 12, ty: 9, simX: 400, simY: 300, seen: true };
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(target);
    pointer.press(1, 0, 0, 0);
    pointer.tick(HOLD_THRESHOLD_MS, 100, 300);
    assert.deepEqual(pointer.intent(), { x: 1, y: 0 });
  });

  it(`quantises to 1/${HEADING_STEPS} of a unit vector`, () => {
    // (1, 1) normalised is (0.7071…, 0.7071…); at 100 steps that rounds to 0.71 on both axes.
    const target: PointerTarget = { tx: 0, ty: 0, simX: 100, simY: 100, seen: true };
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(target);
    pointer.press(1, 0, 0, 0);
    pointer.tick(HOLD_THRESHOLD_MS, 0, 0);
    assert.deepEqual(pointer.intent(), { x: 0.71, y: 0.71 });
  });

  it('holds the last heading through a one-frame miss rather than zeroing it', () => {
    let target: PointerTarget | undefined = { tx: 5, ty: 5, simX: 400, simY: 300, seen: true };
    const pointer = new PointerControl();
    pointer.resolve = () => target;
    pointer.press(1, 0, 0, 0);
    pointer.tick(HOLD_THRESHOLD_MS, 100, 300);
    const steady = pointer.intent();
    assert.notDeepEqual(steady, { x: 0, y: 0 });

    target = undefined; // the ray grazes past the horizon for a frame
    pointer.tick(HOLD_THRESHOLD_MS + 16, 100, 300);
    assert.equal(pointer.steering, true, 'a miss does not cancel an already-started hold');
    assert.deepEqual(pointer.intent(), steady, 'the heading is held, not zeroed, through the miss');
    assert.equal(pointer.lastTarget, undefined, 'but the debug read-out honestly reports the miss');
  });

  it('release zeroes the intent exactly as a key release does', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver({ tx: 1, ty: 1, simX: 400, simY: 300, seen: true });
    pointer.press(1, 0, 0, 0);
    pointer.tick(HOLD_THRESHOLD_MS, 100, 300);
    assert.notDeepEqual(pointer.intent(), { x: 0, y: 0 });

    pointer.release(1);
    assert.equal(pointer.steering, false);
    assert.deepEqual(pointer.intent(), { x: 0, y: 0 });
  });

  it('cancel ends a live hold with no release event — a movement key taking the wheel back', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    pointer.press(1, 0, 0, 0);
    pointer.tick(HOLD_THRESHOLD_MS, 0, 0);
    assert.equal(pointer.steering, true);

    pointer.cancel();
    assert.equal(pointer.pointerDown, false);
    assert.equal(pointer.steering, false);
    assert.deepEqual(pointer.intent(), { x: 0, y: 0 });
  });

  it('ignores a move or release from a pointer that is not the one held', () => {
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(TARGET);
    pointer.press(1, 0, 0, 0);
    pointer.drag(2, 0.9, 0.9); // a second finger, say — must not steal the aim point
    pointer.release(2);
    assert.equal(pointer.pointerDown, true, 'the original press is still live');
  });
});

describe('PointerControl: the seen-gate is the click\'s business, never the hold\'s', () => {
  it('a press on unseen ground still tracks — the caller decides whether to send `moveTo`', () => {
    const unseen: PointerTarget = { tx: 3, ty: 3, simX: 96, simY: 96, seen: false };
    const pointer = new PointerControl();
    pointer.resolve = fixedResolver(unseen);
    const received: (PointerTarget | undefined)[] = [];
    pointer.onPress = (target) => received.push(target);

    pointer.press(1, 0, 0, 0);
    assert.deepEqual(received, [unseen], 'onPress always fires; `seen` is data, not a filter');

    // Held past the threshold, steering must still work — index.html:1003's "NOT fog-gated".
    pointer.tick(HOLD_THRESHOLD_MS, 0, 0);
    assert.equal(pointer.steering, true);
    assert.notDeepEqual(pointer.intent(), { x: 0, y: 0 }, 'steering toward unseen ground is still steering');
  });
});

describe('the seen-gate, assembled the way main.ts assembles it', () => {
  it('answers `seen` from the real `ty * grid.width + tx` index against `World3D.hasSeenTile`', () => {
    const world = new World3D();
    world.setPlace(sampleZone(), 0);
    const grid = world.grid!;

    const litTile = grid.roomOrigins.get(3)!;
    const litIndex = (litTile.ty + 4) * grid.width + (litTile.tx + 4);
    const bits = createBitset(grid.width * grid.height);
    bitsetAdd(bits, litIndex);
    world.setSeen(bitsToBase64(bits));

    // The same composition `main.ts`'s `pointer.resolve` uses: floor to a tile, index it, ask the world.
    const resolveSeen = (simX: number, simY: number): boolean => {
      const tx = Math.floor(simX / 32);
      const ty = Math.floor(simY / 32);
      return world.hasSeenTile(ty * grid.width + tx);
    };

    const litSimX = (litTile.tx + 4) * 32 + 16;
    const litSimY = (litTile.ty + 4) * 32 + 16;
    assert.equal(resolveSeen(litSimX, litSimY), true, 'the tile just marked seen must read as seen');

    const darkTile = grid.roomOrigins.get(1)!; // room 1 is barrier-only and unreached in this fixture
    assert.equal(resolveSeen(darkTile.tx * 32 + 16, darkTile.ty * 32 + 16), false);

    world.dispose();
  });

  it('is permissive before any `seen` snapshot has arrived, matching `stateOf`\'s own default', () => {
    const world = new World3D();
    world.setPlace(sampleZone(), 0);
    // No `setSeen` call at all — the gap between `zone` and the first `seen` message.
    assert.equal(world.hasSeenTile(0), true);
    world.dispose();
  });
});
