import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { placeKey, samePlace, type Place } from './protocol.ts';

describe('samePlace', () => {
  it('is true for the same zone and level', () => {
    const a: Place = { zone: 260, level: 0 };
    const b: Place = { zone: 260, level: 0 };
    assert.equal(samePlace(a, b), true);
  });

  it('is false for the same zone at a different level', () => {
    const a: Place = { zone: 260, level: 0 };
    const b: Place = { zone: 260, level: 1 };
    assert.equal(samePlace(a, b), false);
  });

  it('is false for a different zone at the same level', () => {
    const a: Place = { zone: 260, level: 0 };
    const b: Place = { zone: 261, level: 0 };
    assert.equal(samePlace(a, b), false);
  });

  it('is false when both zone and level differ', () => {
    const a: Place = { zone: 260, level: 0 };
    const b: Place = { zone: 261, level: 1 };
    assert.equal(samePlace(a, b), false);
  });
});

describe('placeKey', () => {
  it('is stable for the same Place, including two separately-built objects', () => {
    const a: Place = { zone: 260, level: 2 };
    const b: Place = { zone: 260, level: 2 };
    assert.equal(placeKey(a), placeKey(a));
    assert.equal(placeKey(a), placeKey(b));
  });

  it('differs when the level differs', () => {
    assert.notEqual(placeKey({ zone: 260, level: 0 }), placeKey({ zone: 260, level: 1 }));
  });

  it('differs when the zone differs', () => {
    assert.notEqual(placeKey({ zone: 260, level: 0 }), placeKey({ zone: 261, level: 0 }));
  });

  it('does not collide across the zone/level boundary for multi-digit ids', () => {
    // Without a delimiter, zone 1 level 23 and zone 12 level 3 would both stringify to "123".
    assert.notEqual(placeKey({ zone: 1, level: 23 }), placeKey({ zone: 12, level: 3 }));
  });
});
