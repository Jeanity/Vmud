/**
 * Containers and gold — `DESIGN-inventory.md` §4 and §8.
 *
 * The first suite is the rule the whole feature exists for: a container's contents do not count against
 * the bag holding it. The second is the exploit that rule opens and the depth limit that closes it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_NESTING_DEPTH,
  accepts,
  apportion,
  CURRENCIES,
  addCoins,
  containerBulk,
  describePurse,
  purseIsEmpty,
  describeContainer,
  freeInside,
  isMoney,
  putRefusal,
  usedInside,
  type Held,
} from './containers.ts';
import { stripColour } from './colour.ts';
import type { Item } from './equipment.ts';
import { DURIS_ITEM } from './items.ts';
import type { Stack } from './stacks.ts';

const arrow: Item = { id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 };
const sword: Item = { id: 'sword', name: 'a sword', ac: 0, size: 3 };
const quiver: Item = { id: 'quiver', name: 'a quiver', ac: 0, size: 2 };

const held = (capacity: number, accepts: Held['rule']['accepts'], contents: Stack[] = []): Held =>
  ({ rule: { capacity, accepts }, contents });

describe('a container’s contents are not the bag’s problem', () => {
  it('costs its own bulk and nothing more', () => {
    // §4's entire reason for existing, and the owner's own words: a quiver lets arrows "free up the
    // spot in the inventory". Sixty arrows inside a size-2 quiver cost the bag 2, not 62.
    const full = held(20, 'missile', [{ item: arrow, count: 20 }, { item: arrow, count: 20 }, { item: arrow, count: 20 }]);
    assert.equal(usedInside(full), 3, 'three stacks of twenty, inside');
    assert.equal(containerBulk(quiver), 2, 'and the bag pays two');
  });

  it('fills up on its own capacity', () => {
    const q = held(3, 'missile', [{ item: arrow, count: 20 }]);
    assert.equal(usedInside(q), 1);
    assert.equal(freeInside(q), 2);
  });

  it('never reports negative room, however over-stuffed a hand-edited save is', () => {
    const over = held(1, 'any', [{ item: sword, count: 1 }]);
    assert.equal(freeInside(over), 0);
  });
});

describe('depth 2 closes the bag-in-a-bag exploit', () => {
  it('refuses a container inside a container', () => {
    // Owner-confirmed (2026-08-03). Unbounded nesting is unbounded storage, and Diku has exactly that
    // problem. Refused by rule, so there is no depth counter to get wrong.
    assert.equal(MAX_NESTING_DEPTH, 2);
    assert.equal(putRefusal(held(20, 'any'), quiver, DURIS_ITEM.container, true), 'too-deep');
    assert.equal(accepts({ capacity: 20, accepts: 'any' }, DURIS_ITEM.container, true), false);
  });

  it('lets an ordinary item in', () => {
    assert.equal(putRefusal(held(20, 'any'), sword, DURIS_ITEM.weapon, false), undefined);
  });
});

describe('what a container will take', () => {
  it('a quiver takes arrows and nothing else', () => {
    // Restricted by Duris' own type rather than guessed from the name, so a "quiver of holding" that a
    // builder typed as a sack behaves the way its data says.
    assert.equal(putRefusal(held(20, 'missile'), arrow, DURIS_ITEM.missile, false), undefined);
    assert.equal(putRefusal(held(20, 'missile'), sword, DURIS_ITEM.weapon, false), 'wrong-kind');
  });

  it('a scabbard takes weapons', () => {
    assert.equal(putRefusal(held(20, 'weapon'), sword, DURIS_ITEM.weapon, false), undefined);
    assert.equal(putRefusal(held(20, 'weapon'), arrow, DURIS_ITEM.missile, false), 'wrong-kind');
  });

  it('a sack takes anything that is not a container', () => {
    assert.equal(putRefusal(held(20, 'any'), arrow, DURIS_ITEM.missile, false), undefined);
    assert.equal(putRefusal(held(20, 'any'), sword, DURIS_ITEM.weapon, false), undefined);
  });

  it('says *which* refusal, because three of them want three sentences', () => {
    // "It will not go in" teaches a player nothing about why.
    assert.equal(putRefusal(held(1, 'any'), sword, DURIS_ITEM.weapon, false), 'full');
    assert.equal(putRefusal(held(20, 'missile'), sword, DURIS_ITEM.weapon, false), 'wrong-kind');
    assert.equal(putRefusal(held(20, 'any'), quiver, DURIS_ITEM.container, true), 'too-deep');
  });

  it('checks kind before fullness, so a full quiver still says the right thing about a sword', () => {
    assert.equal(putRefusal(held(0, 'missile'), sword, DURIS_ITEM.weapon, false), 'wrong-kind');
  });
});

describe('coin — all four of Duris currencies', () => {
  it('recognises a money pile by its harvested type', () => {
    assert.equal(isMoney(DURIS_ITEM.money), true);
    assert.equal(isMoney(DURIS_ITEM.weapon), false);
    assert.equal(isMoney(undefined), false);
  });

  it('has copper, silver, gold and platinum in the source own order', () => {
    // Not guessable, so it was read. `utils.h` has GET_COPPER at cash[0] and GET_PLATINUM at cash[3],
    // and `actobj.c` pours value[0..3] into them in that order. Getting it backwards would turn the
    // catalogue's biggest platinum hoard into a pile of coppers.
    assert.deepEqual([...CURRENCIES], ['copper', 'silver', 'gold', 'platinum']);
  });

  it('adds each coin on its own', () => {
    assert.deepEqual(addCoins({ gold: 250 }, { gold: 1000, platinum: 5 }), { gold: 1250, platinum: 5 });
  });

  it('drops zeroes rather than recording three empty currencies', () => {
    assert.deepEqual(addCoins({}, { gold: 10 }), { gold: 10 });
  });

  it('cannot be driven negative or to NaN', () => {
    // The one number a bug in either direction is unrecoverable for: a negative purse is a character
    // who can never buy anything again, and one NaN propagates into every total that touches it.
    assert.deepEqual(addCoins({ gold: 100 }, { gold: -50 }), { gold: 100 });
    assert.deepEqual(addCoins({ gold: 100 }, { gold: Number.NaN }), { gold: 100 });
    assert.deepEqual(addCoins({ gold: -5 }, { gold: 10 }), { gold: 10 }, 'a corrupt save is not a debt');
  });

  it('knows an empty purse from a full one', () => {
    assert.equal(purseIsEmpty({}), true);
    assert.equal(purseIsEmpty({ copper: 0 }), true);
    assert.equal(purseIsEmpty({ copper: 1 }), false);
  });

  it('reads richest first, omitting what you do not have', () => {
    // "0 copper, 0 silver, 3 gold, 0 platinum" buries the one number that matters. Asserted with the
    // colour stripped, because the words are this test's subject and the palette is the next one's.
    assert.equal(stripColour(describePurse({ copper: 5, gold: 3 })), '3 gold, 5 copper');
    assert.equal(stripColour(describePurse({ platinum: 7500, gold: 15000 })), '7,500 platinum, 15,000 gold');
    assert.equal(describePurse({}), 'no coin', 'and an empty purse carries no codes at all');
  });

  it('gives each metal its own colour, and closes every run', () => {
    // Owner's ask (2026-08-04). In the MUD's own notation so the log and the character sheet's drawer
    // get it from this one function — two places formatting a purse is two places to disagree.
    // **`&N` after each**: an unterminated code bleeds into whatever the caller appends next, which is
    // how a colour bug becomes somebody else's line.
    const line = describePurse({ platinum: 1, gold: 2, silver: 3, copper: 4 });
    assert.match(line, /&\+W1 platinum&N/);
    assert.match(line, /&\+Y2 gold&N/);
    assert.match(line, /&\+w3 silver&N/);
    assert.match(line, /&\+y4 copper&N/);
    assert.equal(line.split('&N').length - 1, 4, 'one close per metal');
  });
});

describe('how a container reads in a listing', () => {
  it('says how full it is, because that is what you need before opening it', () => {
    assert.equal(describeContainer(quiver, held(20, 'any')), 'a quiver [0/20]');
  });

  it('names the restriction, so a refusal is predictable rather than surprising', () => {
    assert.equal(
      describeContainer(quiver, held(20, 'missile', [{ item: arrow, count: 20 }])),
      'a quiver (arrows) [1/20]',
    );
  });
});

describe('splitting coin loses none of it', () => {
  // The bug the owner caught in play. A kobold fisherman carrying 3 copper and 2 silver, killed by two
  // people, paid 1 silver 1 copper to one and a single copper to the other — the rest evaporated.
  const sum = (a: readonly number[]) => a.reduce((x, y) => x + y, 0);

  it('pays out exactly what the mob carried, at every split', () => {
    // The property flooring broke, and it broke it at *every* ratio rather than occasionally.
    for (const total of [1, 2, 3, 5, 6, 7, 20, 137]) {
      for (const weights of [[7, 3], [6, 4], [5, 5], [8, 2], [1, 1, 1], [10, 3, 1], [100, 1]]) {
        assert.equal(sum(apportion(total, weights)), total, `${total} across ${weights.join('/')}`);
      }
    }
  });

  it('reproduces the fisherman, whole', () => {
    // 3 copper and 2 silver between two killers: every coin reaches somebody.
    assert.equal(sum(apportion(3, [7, 3])), 3);
    assert.equal(sum(apportion(2, [7, 3])), 2);
  });

  it('still favours the bigger contributor', () => {
    // Conserving must not flatten it into an even split — the whole point of dividing by contribution
    // is that tanking and dealing are paid differently.
    const [big, small] = apportion(10, [8, 2]);
    assert.ok(big! > small!, `${big} should beat ${small}`);
    assert.equal(big! + small!, 10);
  });

  it('gives the odd coin to the larger share rather than dropping it', () => {
    assert.deepEqual(apportion(3, [7, 3]), [2, 1]);
    assert.deepEqual(apportion(1, [9, 1]), [1, 0], 'one coin, one winner');
  });

  it('splits evenly when nothing distinguishes the claimants', () => {
    // A kill nobody contributed to measurably. Even shares, and the remainder still goes out.
    assert.deepEqual(apportion(4, [0, 0]), [2, 2]);
    assert.equal(sum(apportion(5, [0, 0, 0])), 5);
  });

  it('is deterministic, because an unauditable coin split is worse than an unfair one', () => {
    // `CLAUDE.md` rule 3: no unseeded randomness in simulation. Ties go to the earlier claimant.
    assert.deepEqual(apportion(1, [5, 5]), [1, 0]);
    assert.deepEqual(apportion(1, [5, 5]), [1, 0]);
  });

  it('answers sensibly for nothing to split and nobody to split it', () => {
    assert.deepEqual(apportion(0, [1, 1]), [0, 0]);
    assert.deepEqual(apportion(5, []), []);
    assert.deepEqual(apportion(-3, [1]), [0]);
  });

  it('never pays anyone a negative amount, however odd the weights', () => {
    for (const cut of apportion(7, [-5, 3, 2])) assert.ok(cut >= 0, `${cut} is not negative`);
    assert.equal(sum(apportion(7, [-5, 3, 2])), 7);
  });
});
