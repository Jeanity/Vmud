/**
 * A7e — the same garment in another colour.
 *
 * The tests pin the four things a reader would otherwise have to take on trust: the id format degrades
 * to *no recolour* rather than to nothing, the swap is index-by-index so shading survives, the guide's
 * ±1 tolerance is real slack rather than decoration, and transparent pixels are left alone.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  RECOLOUR_TOLERANCE,
  formatArtId,
  nearestSwap,
  parseArtId,
  parseHex,
  recolourPixels,
  splitRamp,
  isKnownArt,
  swapsFor,
} from './recolour.ts';

/** The first three of cloth's `white` and `red`, as the pack writes them. */
const WHITE = ['#2e2b44', '#4f4b62', '#6e6a82'];
const RED = ['#3a1a1a', '#6b2626', '#a33a3a'];

describe('the art id', () => {
  it('round-trips through both halves', () => {
    assert.deepEqual(parseArtId('cape-solid#cloth_ulpc.red'), { id: 'cape-solid', ramp: 'cloth_ulpc.red' });
    assert.equal(formatArtId('cape-solid', 'cloth_ulpc.red'), 'cape-solid#cloth_ulpc.red');
  });

  it('reads a plain id as an art with no recolour', () => {
    // The ordinary case, and the one every caller written before A7e was built against — 16,000 items
    // carry a bare id and must keep working through this unchanged.
    assert.deepEqual(parseArtId('cape-solid'), { id: 'cape-solid' });
    assert.equal(formatArtId('cape-solid', undefined), 'cape-solid');
  });

  it('degrades a malformed id to its base art rather than to nothing', () => {
    // A trailing separator is the shape a half-finished edit takes. Better a cloak in the wrong colour
    // than a person with a hole where their cloak was.
    assert.deepEqual(parseArtId('cape-solid#'), { id: 'cape-solid' });
  });

  it('splits a ramp into its table and its name', () => {
    assert.deepEqual(splitRamp('cloth_ulpc.red'), { table: 'cloth_ulpc', name: 'red' });
    assert.equal(splitRamp('cloth_ulpc'), undefined);
    assert.equal(splitRamp('.red'), undefined);
  });
});

describe('reading a colour', () => {
  it('takes the pack’s own spelling, with or without the hash', () => {
    assert.deepEqual(parseHex('#4B2B13'), [75, 43, 19]);
    assert.deepEqual(parseHex('4b2b13'), [75, 43, 19]);
    assert.equal(parseHex('#fff'), undefined);
  });
});

describe('building the swaps', () => {
  it('maps index to index, so the shading survives and only the hue moves', () => {
    // This is the whole recolour. Position 0 is the darkest shade in both ramps, so pairing them by
    // position is what keeps a garment's folds where the artist put them.
    const swaps = swapsFor(WHITE, RED);
    assert.equal(swaps.length, 3);
    assert.deepEqual(swaps[0]?.from, parseHex(WHITE[0]!));
    assert.deepEqual(swaps[0]?.to, parseHex(RED[0]!));
    assert.deepEqual(swaps[2]?.to, parseHex(RED[2]!));
  });

  it('drops a colour that maps to itself', () => {
    // Picking the base ramp back is a real thing to do, and it should cost no pixels at all.
    assert.deepEqual(swapsFor(WHITE, WHITE), []);
  });

  it('truncates to the shorter ramp rather than refusing', () => {
    // `eye` ramps are three colours where everything else is six. Recolouring the shades that *do*
    // correspond beats handing back the base sheet, which looks like the feature failing.
    assert.equal(swapsFor(WHITE, RED.slice(0, 2)).length, 2);
  });
});

describe('matching a pixel', () => {
  it('accepts a channel one out, which is the guide’s own slack', () => {
    // Not defensive: the sheets have been through many hands, and a pixel meant to be one colour is here
    // and there one off. Exact matching leaves those at the base colour, which on a red cloak reads as
    // dirt — one stray dark pixel is more noticeable than a hundred correct ones.
    const swaps = swapsFor(WHITE, RED);
    const exact = parseHex(WHITE[0]!)!;
    const off = [exact[0] + 1, exact[1], exact[2] - 1] as const;
    assert.ok(nearestSwap(off, swaps));
    assert.equal(RECOLOUR_TOLERANCE, 1);
  });

  it('leaves a colour outside the ramp alone', () => {
    assert.equal(nearestSwap([12, 200, 40], swapsFor(WHITE, RED)), undefined);
  });

  it('takes the nearest match rather than the first', () => {
    // Where two ramp entries are within tolerance of each other, first-match would make the result depend
    // on the ramp's order rather than on the pixel.
    const swaps = swapsFor(['#000000', '#010101'], ['#ff0000', '#00ff00']);
    assert.deepEqual(nearestSwap([1, 1, 1], swaps)?.to, [0, 255, 0]);
  });
});

describe('recolouring a buffer', () => {
  it('moves the pixels it matches and reports how many', () => {
    const swaps = swapsFor(WHITE, RED);
    const [r, g, b] = parseHex(WHITE[1]!)!;
    const data = new Uint8ClampedArray([r, g, b, 255, 9, 200, 9, 255]);
    assert.equal(recolourPixels(data, swaps), 1);
    assert.deepEqual([...data.slice(0, 3)], [...parseHex(RED[1]!)!]);
    assert.deepEqual([...data.slice(4, 7)], [9, 200, 9], 'the unmatched pixel is untouched');
  });

  it('leaves transparent pixels alone', () => {
    // A sheet's padding is `#00000000`, and the darkest entry of several ramps is near-black — so
    // recolouring the transparent border would tint the empty half of every frame.
    const swaps = swapsFor(['#000000'], ['#ff0000']);
    const data = new Uint8ClampedArray([0, 0, 0, 0]);
    assert.equal(recolourPixels(data, swaps), 0);
    assert.deepEqual([...data], [0, 0, 0, 0]);
  });

  it('does nothing at all when there is nothing to do', () => {
    const data = new Uint8ClampedArray([1, 2, 3, 255]);
    assert.equal(recolourPixels(data, []), 0);
  });
});

describe('validating an art value', () => {
  const index = new Map([
    ['cape-solid', { recolours: { material: 'cloth', base: 'white', ramps: ['cloth_ulpc.red'] } }],
    ['hat-bandana', {}],
  ]);

  it('accepts a plain id, recolourable or not', () => {
    assert.ok(isKnownArt('cape-solid', index));
    assert.ok(isKnownArt('hat-bandana', index));
  });

  it('accepts a ramp the art actually offers', () => {
    assert.ok(isKnownArt('cape-solid#cloth_ulpc.red', index));
  });

  it('refuses a ramp the art does not offer', () => {
    // Not ignored: `cloth_ulpc.red` on a steel helm would recolour from the wrong base and give back a
    // sheet that looks untouched — indistinguishable from the save having failed.
    assert.equal(isKnownArt('cape-solid#metal_ulpc.gold', index), false);
    assert.equal(isKnownArt('hat-bandana#cloth_ulpc.red', index), false);
  });

  it('refuses art the index does not have', () => {
    assert.equal(isKnownArt('no-such-art', index), false);
    assert.equal(isKnownArt('no-such-art#cloth_ulpc.red', index), false);
  });
});
