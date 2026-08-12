/**
 * The rose, against the frame it is describing.
 *
 * Two of these three properties are the kind that look obviously right and are half the time wrong,
 * because a compass has two conventions in it and they run opposite ways:
 *
 * 1. **Where north is on screen** — the rose's rotation, which is the camera yaw exactly. The
 *    derivation is in `compass.ts`; this checks it against the *camera*, by projecting a point due
 *    north through a real rig and asking which side of the frame it landed on. A rose derived from
 *    the same wrong sign as the code would agree with it; a projection will not.
 * 2. **Which way the player is looking** — the bearing, which is the *negative* of the yaw, because
 *    the protocol's yaw runs anticlockwise and a bearing runs clockwise. This is the sign that would
 *    make a player walking east read "W" and doubt the whole feature.
 * 3. **The letters**, which round to eight points with north owning the seam at 0/360.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Compass, bearingOf, cardinalOf, roseRotation } from './compass.ts';
import { SWEEP_YAWS } from './fixture.ts';
import { CameraRig } from './rig.ts';

describe('the rose', () => {
  it('puts its N where the camera actually shows north, at every yaw', () => {
    /*
     * **The property, not the identity — and measured off the camera three actually built.**
     *
     * Take where the rig *put* the camera, drop its height, and that is the frame's own ground basis:
     * forward is the way it looks, right is a quarter turn from it. Ask where world north sits in
     * that basis and take the clockwise angle from up. The rose is rotated by `roseRotation` with its
     * N drawn at the top, so the two must agree at every yaw. Nothing here reads `rig.yaw` except to
     * hand it to the rose, so a sign error anywhere in `recompute` → `lookAt` → the badge shows up.
     *
     * The basis rather than a *projection* of a north-ward point, deliberately: the ground is
     * foreshortened under a 45-64° camera, so a plan-view direction and its projected screen angle
     * genuinely differ (by 0.8° at 10 m in the worst case here). The rose is a heading instrument —
     * see `compass.ts` — and the heading is what this checks.
     */
    const rig = new CameraRig(16 / 9);
    let worst = 0;
    for (const yaw of SWEEP_YAWS) {
      rig.yaw = yaw;
      rig.follow(0, 0, 0);
      rig.camera.updateMatrixWorld(true);
      const at = rig.camera.position;
      // The camera looks at the focus, so forward on the ground is the way back to it from where the
      // rig stood the camera. Normalised, because only its direction is wanted.
      const length = Math.hypot(at.x, at.z);
      const forward = { x: -at.x / length, z: -at.z / length };
      // Screen-right is forward turned a quarter clockwise seen from above: `(-f.z, f.x)`.
      const right = { x: -forward.z, z: forward.x };
      // World north is `-Z` (`space.ts`), read in that basis.
      const onScreen = (Math.atan2(-right.z, -forward.z) * 180) / Math.PI;
      const rose = roseRotation(yaw);
      const error = Math.abs((((onScreen - rose + 540) % 360) + 360) % 360 - 180);
      worst = Math.max(worst, error);
      assert.ok(error < 1e-6, `at yaw ${yaw} north is ${onScreen.toFixed(3)}° on screen, rose says ${rose}°`);
    }
    console.log(`[M8 compass] north's heading matches the rose to ${worst.toExponential(2)}° over 52 yaws`);
  });

  it('reads the bearing the other way round, because a compass is not a rotation.y', () => {
    // The four quadrants, and the sign that matters: yaw -90 is the camera looking **east**.
    assert.equal(bearingOf(0), 0);
    assert.equal(bearingOf(-90), 90, 'yaw -90 is east — the protocol runs anticlockwise');
    assert.equal(bearingOf(180), 180);
    assert.equal(bearingOf(90), 270, 'yaw +90 is west');
    // Always a bearing, never a negative one.
    for (const yaw of SWEEP_YAWS) {
      const bearing = bearingOf(yaw);
      assert.ok(bearing >= 0 && bearing < 360, `${bearing} is not a bearing`);
    }
  });

  it('names all eight points, with north owning the seam', () => {
    assert.equal(cardinalOf(0), 'N');
    assert.equal(cardinalOf(-90), 'E');
    assert.equal(cardinalOf(180), 'S');
    assert.equal(cardinalOf(90), 'W');
    assert.equal(cardinalOf(-45), 'NE');
    assert.equal(cardinalOf(-135), 'SE');
    assert.equal(cardinalOf(135), 'SW');
    assert.equal(cardinalOf(45), 'NW');
    // The seam: a bearing of 350 and a bearing of 10 are both north, or the letter flickers through
    // every point on the rose as the camera crosses it.
    assert.equal(cardinalOf(10), 'N');
    assert.equal(cardinalOf(-10), 'N');
    assert.equal(cardinalOf(179.9), 'S');
    assert.equal(cardinalOf(-179.9), 'S');
    // Every yaw names something, and only ever one of the eight.
    const points = new Set(SWEEP_YAWS.map(cardinalOf));
    assert.equal(points.size, 8, `${[...points].join(',')}`);
  });
});

describe('the badge', () => {
  it('writes the DOM only when the whole degree changed', () => {
    // A still camera must cost two comparisons a frame and allocate nothing. The transform string is
    // the only allocation in the file and it is per changed degree, not per frame.
    const rose = fakeElement();
    const facing = fakeElement();
    const compass = new Compass();
    compass.attach(fakeDocument({ 'compass-rose': rose, 'compass-facing': facing }));

    compass.update(0);
    assert.equal(rose.style.transform, 'rotate(0deg)');
    assert.equal(facing.textContent, 'N');
    const writes = rose.writes;
    for (let i = 0; i < 60; i++) compass.update(0.2);
    assert.equal(rose.writes, writes, 'a fifth of a degree of drift rewrote the transform 60 times');

    compass.update(-90);
    assert.equal(rose.style.transform, 'rotate(-90deg)');
    assert.equal(facing.textContent, 'E', 'the letter is the bearing, not the yaw');
    assert.equal(rose.writes, writes + 1);
  });

  it('shrugs at a page that has no compass in it', () => {
    // The tests import this headlessly and a stripped host page is a thing that has happened once
    // already with the HUD lines. Attaching to nothing, and updating after, must not throw.
    const compass = new Compass();
    compass.attach(fakeDocument({}));
    compass.update(137);
  });
});

interface FakeElement {
  style: { transform: string };
  textContent: string;
  writes: number;
}

function fakeElement(): FakeElement & HTMLElement {
  const element = {
    textContent: '',
    writes: 0,
    style: {
      _transform: '',
      get transform(): string {
        return this._transform as string;
      },
      set transform(value: string) {
        (this as unknown as { _transform: string })._transform = value;
        element.writes += 1;
      },
    },
  };
  return element as unknown as FakeElement & HTMLElement;
}

function fakeDocument(byId: Record<string, HTMLElement>): Document {
  return { getElementById: (id: string): HTMLElement | null => byId[id] ?? null } as unknown as Document;
}
