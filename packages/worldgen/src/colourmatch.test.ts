/**
 * A7h — a colour for a zone's loot.
 *
 * Two things are pinned: what counts as a zone's loot (the reset kinds that name an *object*, and the
 * container a `put` names), and the four ways an item is passed over — each of which is reported rather
 * than silent, because a bulk pass that quietly did nothing would look identical to one that worked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ItemTemplate, ResetCommand, RoomId } from '@mygame/shared';

import { lootOf } from './colourmatch.ts';
import { proposeFor } from './colourassign.ts';

function reset(kind: ResetCommand['kind'], what: number, extra: Partial<ResetCommand> = {}): ResetCommand {
  return { kind, ifPrevious: false, what, limit: 1, percent: 100, ...extra } as ResetCommand;
}

function item(over: Partial<ItemTemplate>): ItemTemplate {
  return {
    vnum: 1, keywords: [], name: '', roomLine: '', type: 9, ac: 0, size: 1, cost: 0, stackLimit: 1,
    ...over,
  } as ItemTemplate;
}

describe('what counts as a zone’s loot', () => {
  it('takes the four reset kinds that name an object', () => {
    const loot = lootOf({
      resets: [
        reset('mob', 900, { room: 1 as RoomId }),
        reset('give', 10),
        reset('equip', 11, { wearPosition: 16 }),
        reset('object', 12, { room: 1 as RoomId }),
        reset('door', 99, { room: 1 as RoomId }),
        reset('follower', 901),
      ],
    });
    // The mob, the door and the follower name creatures and rooms, not things a player picks up.
    assert.deepEqual(loot, [10, 11, 12]);
  });

  it('takes the container a `put` names as well as what goes in it', () => {
    // A chest is itself an item somebody sees and carries. Missing it would leave the one object in a
    // room a player definitely interacts with uncoloured.
    assert.deepEqual(lootOf({ resets: [reset('put', 20, { container: 21 })] }), [20, 21]);
  });

  it('lists each vnum once, in the order the table names it', () => {
    // Order is for the report: reading proposals in reset order groups a mob with the kit dressing it,
    // which is how somebody reviewing them is thinking about it.
    assert.deepEqual(lootOf({ resets: [reset('give', 10), reset('equip', 11), reset('give', 10)] }), [10, 11]);
  });

  it('finds nothing in a zone that places no objects', () => {
    assert.deepEqual(lootOf({ resets: [reset('mob', 900, { room: 1 as RoomId })] }), []);
  });
});

describe('proposing a colour', () => {
  // `cape-solid` really is `cloth`/`white` with a `cloth_ulpc` ramp list; `weapon-sword-dagger-dagger`
  // really has no `recolors`. Using real ids keeps the test honest about the index it runs against.
  const catalogue = new Map<number, ItemTemplate>([
    [10, item({ vnum: 10, name: 'a hooded black cape', keywords: ['cape'], slot: 'about' })],
    [11, item({ vnum: 11, name: 'a plain cape', keywords: ['cape'], slot: 'about' })],
    [12, item({ vnum: 12, name: 'a red dagger', keywords: ['dagger'], slot: 'mainHand' })],
    [13, item({ vnum: 13, name: 'a brass key', keywords: ['key'] })],
    [14, item({ vnum: 14, name: 'a blue cape', keywords: ['cape'], slot: 'about' })],
  ]);
  const overlay = {
    '10': { art: 'cape-solid' },
    '11': { art: 'cape-solid' },
    '12': { art: 'weapon-sword-dagger-dagger' },
    '14': { art: 'cape-solid#cloth_ulpc.navy' },
  };

  it('colours what the name names', () => {
    const { proposals } = proposeFor([10], catalogue, overlay);
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0]?.ramp, 'cloth_ulpc.black');
    assert.equal(proposals[0]?.art, 'cape-solid#cloth_ulpc.black');
    // The word that decided it, so a wrong proposal is diagnosable from the report alone.
    assert.equal(proposals[0]?.because, 'black');
  });

  it('leaves alone, and counts, every reason not to', () => {
    const { proposals, skipped } = proposeFor([11, 12, 13, 14], catalogue, overlay);
    assert.deepEqual(proposals, []);
    assert.equal(skipped['no-colour-in-the-name'], 1, 'a plain cape');
    assert.equal(skipped['not-recolourable'], 1, 'a dagger sheet declares no palettes');
    assert.equal(skipped['no-art'], 1, 'a key was never given art');
    assert.equal(skipped['already-coloured'], 1, 'the blue cape was coloured already');
  });

  it('refuses to recolour art that is drawn in skin', () => {
    // Found by running the pass: *"a heavy black nosering"* wears `head-nose-big`, the only art the nose
    // slot has, whose material is `body` — so its base ramp is a skin tone and *black* would have
    // blackened the nose rather than the ring. A `body` ramp belongs to the character's own body layer.
    const skin = new Map<number, ItemTemplate>([
      [20, item({ vnum: 20, name: 'a heavy black nosering', keywords: ['nosering'], slot: 'nose' })],
    ]);
    const { proposals, skipped } = proposeFor([20], skin, { '20': { art: 'head-nose-big' } });
    assert.deepEqual(proposals, []);
    assert.equal(skipped['skin-toned-art'], 1);
  });

  it('never overwrites a colour somebody already chose', () => {
    // What makes a re-run safe, and what lets the pass compose with the panel: colour a zone, hand-fix
    // the ones that came out wrong, run it again — and the fixes stay.
    const { proposals } = proposeFor([14], catalogue, overlay);
    assert.deepEqual(proposals, []);
  });

  it('reads art from the overlay, which is where A7g put all of it', () => {
    // Reading the catalogue alone would find no art anywhere and report that nothing can be coloured.
    const { proposals } = proposeFor([10], catalogue, {});
    assert.deepEqual(proposals, [], 'no art in the catalogue, and none in an empty overlay');
  });
});
