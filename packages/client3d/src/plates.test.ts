/**
 * The two curves the floating text is made of, and the dependency it is not made of.
 *
 * `PlateSet` needs a `document` and so exists only in a browser; what is testable — and what actually
 * decides whether a name is readable and whether a damage number can be caught by the eye — is the
 * pair of pure functions the class drives itself with. They are exported for exactly that reason.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  DAMAGE_RISE,
  DAMAGE_SECONDS,
  NAMEPLATE_LIFT,
  PLATE_COUNT,
  PLATE_FAR,
  PLATE_NEAR,
  damageOpacity,
  damageRise,
  plateOpacity,
  plateSize,
} from './plates.ts';
import { BODY_POOL_SIZE } from './pool.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('a nameplate’s distance fade', () => {
  it('is full inside the near band, gone past the far one, and linear between', () => {
    assert.equal(plateOpacity(0), 1);
    assert.equal(plateOpacity(PLATE_NEAR), 1);
    assert.equal(plateOpacity(PLATE_FAR), 0);
    assert.equal(plateOpacity(1000), 0);
    assert.ok(Math.abs(plateOpacity((PLATE_NEAR + PLATE_FAR) / 2) - 0.5) < 1e-9);
    // Monotone, so a name never brightens as it recedes.
    let previous = 1;
    for (let metres = 0; metres < 60; metres += 0.5) {
      const now = plateOpacity(metres);
      assert.ok(now <= previous + 1e-9, `opacity rose at ${metres} m`);
      previous = now;
    }
  });

  it('reaches past the camera’s own working range but not past the ring', () => {
    // The dolly runs to 96 m and the streaming ring is derived from it, so a plate that faded at 200 m
    // would be a plate that never faded. 44 m is inside the frame at every pose and outside the
    // distance at which a 34 px name is legible anyway.
    assert.ok(PLATE_FAR > PLATE_NEAR);
    assert.ok(PLATE_FAR < 96);
  });

  it('floats clear of a 1.81 m head', () => {
    assert.ok(NAMEPLATE_LIFT > 1.81, 'a plate through the top of a skull is worse than no plate');
    assert.ok(NAMEPLATE_LIFT < 2.6, 'and one at ceiling height reads as belonging to the room');
  });
});

describe('a damage number’s flight', () => {
  it('climbs the whole way, decelerating, and stops exactly where it was aimed', () => {
    assert.equal(damageRise(0), 0);
    assert.ok(Math.abs(damageRise(DAMAGE_SECONDS) - DAMAGE_RISE) < 1e-9);
    assert.equal(damageRise(DAMAGE_SECONDS * 10), DAMAGE_RISE, 'clamped, so a stale number does not fly away');
    // Decelerating: more than half the distance in the first half of the time.
    assert.ok(damageRise(DAMAGE_SECONDS / 2) > DAMAGE_RISE * 0.5);
    let previous = -1;
    for (let t = 0; t <= DAMAGE_SECONDS; t += 0.02) {
      const now = damageRise(t);
      assert.ok(now >= previous, `fell back at ${t.toFixed(2)} s`);
      previous = now;
    }
  });

  it('holds full opacity long enough to be read, then goes', () => {
    assert.equal(damageOpacity(0), 1);
    // A number that starts fading on the frame it appears reads as a flicker rather than as a number.
    // A third of 1.1 s is 0.37 s — two digits, comfortably.
    assert.equal(damageOpacity(0.3), 1);
    assert.ok(damageOpacity(0.3) > damageOpacity(0.6));
    // Exactly zero, not 2.2e-16: the band arithmetic is clamped, because a `SpriteMaterial` handed a
    // fractionally negative opacity draws fully opaque on some drivers.
    assert.equal(damageOpacity(DAMAGE_SECONDS), 0);
    assert.equal(damageOpacity(DAMAGE_SECONDS * 2), 0);
  });

  it('expires inside a combat round, so two rounds never overlap', () => {
    // `ROUND_MS` is 3,000 and haste will shorten it; 1.1 s leaves room for both.
    assert.ok(DAMAGE_SECONDS < 1.5);
  });
});

describe('what the pool holds', () => {
  it('has a plate for every body the renderer can draw', () => {
    assert.equal(PLATE_COUNT, BODY_POOL_SIZE, 'a body with no plate is an unlabelled character');
  });

  it('sizes a plate to be legible without being a billboard', () => {
    const { width, height, metres } = plateSize();
    assert.equal(width / height, 4, 'a 4:1 cell holds a twenty-character name at 34 px');
    assert.ok(metres < 2, 'a plate wider than the character it labels reads as scenery');
    // Two textures per body at 256 x 64 RGBA: 3 MB across the pool, allocated once and never again.
    assert.equal(PLATE_COUNT * 2 * width * height * 4, 3_145_728);
  });

  it('adds no dependency — troika was considered and declined', () => {
    // The argument is in `plates.ts`'s header and the enforcement is here, beside `assets.test.ts`'s
    // own version: `troika-three-text` builds SDF atlases at run time for arbitrary live-editing text,
    // and what this renderer needs is a name that never changes and a two-digit number.
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@mygame/shared', 'postprocessing', 'three']);
    assert.ok(!('troika-three-text' in manifest.dependencies));
    assert.ok(!('troika-three-text' in manifest.devDependencies));
  });
});
