/**
 * The three states, and the arithmetic that turns a lit colour into a remembered one.
 *
 * §6-M4: *"three-state fog of war as a per-chunk uniform … unseen: near-black; seen-but-not-visible:
 * dimmed, desaturated; visible: lit."* Three claims, and all three are checkable without a GPU
 * because the multiplier is computed on the CPU (see `fogOfWar.ts` for why it has to be).
 *
 * The one worth reading twice is *desaturated*. A per-channel multiply cannot desaturate anything by
 * itself, so the test does not ask whether the tint is small — it asks whether the **result** of
 * applying the tint to the base has less chroma than the base did. That is the property the design
 * claims, and it is the one an implementation that merely dimmed would fail.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Color } from 'three';

import {
  FOG_INDEX,
  FOG_STATES,
  MEMORY_DESATURATION,
  MEMORY_DIM,
  MEMORY_HUE,
  fogStateOf,
  fogTint,
  fogTintRow,
  luminanceOf,
  rememberedColour,
  unseenColour,
} from './fogOfWar.ts';
import { ARCHETYPES, BIOME_ARCHETYPES, archetypeColour } from './prototypes.ts';
import { SECTORS } from '@mygame/shared';

/** Distance from grey, as a fraction of luminance. The thing "desaturated" means, in one number. */
function chroma(colour: Color): number {
  const lum = luminanceOf(colour);
  if (lum <= 0) return 0;
  const max = Math.max(colour.r, colour.g, colour.b);
  const min = Math.min(colour.r, colour.g, colour.b);
  return (max - min) / lum;
}

/** Every base colour the pool can hold. The tint table has to be right for all of them, not one. */
function everyBase(): Color[] {
  const out: Color[] = [];
  for (const archetype of ARCHETYPES) {
    if ((BIOME_ARCHETYPES as readonly string[]).includes(archetype)) {
      for (const sector of SECTORS) out.push(new Color(archetypeColour(archetype, sector)));
    } else {
      out.push(new Color(archetypeColour(archetype, undefined)));
    }
  }
  return out;
}

describe('which state a room is in', () => {
  it('is the plan’s three, and visible outranks seen', () => {
    assert.deepEqual([...FOG_STATES], ['unseen', 'remembered', 'visible']);
    assert.equal(fogStateOf(false, false), 'unseen');
    assert.equal(fogStateOf(true, false), 'remembered');
    assert.equal(fogStateOf(true, true), 'visible');
    // The window that makes the ordering load-bearing: the room you have just walked into is visible
    // this frame and does not enter the server's `seen` bitset until the next `seenDelta`.
    assert.equal(fogStateOf(false, true), 'visible', 'a room you are standing in must never flash black');
  });

  it('packs the tint row in that order', () => {
    assert.deepEqual(FOG_INDEX, { unseen: 0, remembered: 1, visible: 2 });
    const row = fogTintRow(new Color(0x3f6437));
    assert.equal(row.length, 9);
    assert.deepEqual([...row.slice(6)], [1, 1, 1], 'the visible slot must be exactly white');
  });
});

describe('the colour of memory', () => {
  it('leaves a lit surface bit-identical to no tint at all', () => {
    for (const base of everyBase()) {
      const tint = fogTint(base, 'visible');
      assert.deepEqual([tint.r, tint.g, tint.b], [1, 1, 1], 'the lit state must not be a fraction off');
    }
  });

  it('dims every remembered surface, and by roughly the stated third', () => {
    for (const base of everyBase()) {
      const lum = luminanceOf(base);
      if (lum < 1e-4) continue;
      const remembered = rememberedColour(base);
      const ratio = luminanceOf(remembered) / lum;
      assert.ok(ratio < 1, 'a remembered surface must be darker than a lit one');
      // The mix toward a luminance-normalised hue is brightness-neutral, so the whole of the loss is
      // `MEMORY_DIM`. Checked as a band rather than an equality because rounding through `Color` is
      // not exact.
      assert.ok(
        Math.abs(ratio - MEMORY_DIM) < 0.01,
        `remembered kept ${ratio.toFixed(3)} of its light, expected about ${MEMORY_DIM}`,
      );
    }
  });

  it('desaturates it — measured on the result, not on the multiplier', () => {
    // The provable form. A mix toward a hue satisfies
    //   chroma(result) <= (1 - t)·chroma(base) + t·chroma(hue)
    // so every base is dragged toward one common cast, and every base *above* the hue's own chroma
    // strictly loses some. Asserting the inequality rather than "it got smaller" is what keeps the
    // near-grey sectors (`arctic`, `city`) honest: they have nothing to lose and must not be
    // required to lose it.
    const hue = chroma(MEMORY_HUE);
    assert.ok(hue < 0.35, `the memory cast is itself saturated (${hue.toFixed(3)}) and cannot desaturate anything`);

    let desaturated = 0;
    for (const base of everyBase()) {
      if (luminanceOf(base) < 1e-4) continue;
      const got = chroma(rememberedColour(base));
      const bound = (1 - MEMORY_DESATURATION) * chroma(base) + MEMORY_DESATURATION * hue;
      assert.ok(got <= bound + 1e-9, `memory kept ${got.toFixed(3)} chroma, above the mix bound ${bound.toFixed(3)}`);
      if (chroma(base) > hue) {
        assert.ok(got < chroma(base), 'a saturated base must lose chroma to memory');
        desaturated += 1;
      }
    }
    assert.ok(desaturated > 20, `only ${desaturated} bases were saturated enough to test the claim`);
  });

  it('takes memory colder than the surface was', () => {
    // The direction of the cast, stated as a fact rather than left to the reader of a hex triple: a
    // remembered forest floor is bluer *relative to its own green* than the lit one, which is what
    // "night memory" is meant to read as.
    const forest = new Color(archetypeColour('ground', 'forest'));
    const remembered = rememberedColour(forest);
    assert.ok(remembered.b / remembered.g > forest.b / forest.g, 'memory is not cooler than the lit surface');
    const tint = fogTint(forest, 'remembered');
    assert.ok(tint.b > tint.g, 'the blue channel of a green base must survive better than the green');
    assert.ok(tint.g < 1);
  });

  it('takes an unexplored surface near-black without ever brightening one', () => {
    for (const base of everyBase()) {
      const unseen = unseenColour(base);
      assert.ok(unseen.r <= base.r + 1e-12, 'an unexplored surface must never be lighter than a lit one');
      assert.ok(unseen.g <= base.g + 1e-12);
      assert.ok(unseen.b <= base.b + 1e-12);
      assert.ok(luminanceOf(unseen) < 0.02, `unexplored luminance ${luminanceOf(unseen)} is not near-black`);
      const tint = fogTint(base, 'unseen');
      assert.ok(tint.r <= 1 && tint.g <= 1 && tint.b <= 1, 'an unseen tint may only ever darken');
    }
  });

  it('orders the three states by brightness for every material in the pool', () => {
    // The property a reader of a screenshot actually checks: unexplored is darker than remembered is
    // darker than lit, everywhere, with no sector inverting the order.
    for (const base of everyBase()) {
      if (luminanceOf(base) < 1e-4) continue;
      const unseen = luminanceOf(unseenColour(base));
      const remembered = luminanceOf(rememberedColour(base));
      const lit = luminanceOf(base);
      assert.ok(unseen < remembered, `unseen ${unseen} is not darker than remembered ${remembered}`);
      assert.ok(remembered < lit, `remembered ${remembered} is not darker than lit ${lit}`);
    }
  });

  it('produces a finite tint for a base of pure black', () => {
    // `edge` and `barrier` read their colour from the sector table, but the object table holds a
    // literal 0x000000 for them as a placeholder — so a black base is reachable and division by it
    // must not be.
    const tint = fogTint(new Color(0x000000), 'remembered');
    for (const channel of [tint.r, tint.g, tint.b]) {
      assert.ok(Number.isFinite(channel), 'a black base produced a non-finite tint');
      assert.ok(channel >= 0 && channel <= 8, `tint channel ${channel} escaped the ceiling`);
    }
  });
});
