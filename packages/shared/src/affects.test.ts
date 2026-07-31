/**
 * The affect primitive.
 *
 * What is worth testing here is not that a number counts down — it is the handful of rules that are
 * easy to state, easy to get wrong, and invisible when they are wrong:
 *
 * - **`type` is not a key.** One cause installs one node per stat it touches, so lookups work on runs.
 *   Every failure mode in `REFERENCE-mud-mechanics.md` §4.12 comes from forgetting this once.
 * - **Stacking is per-caller policy**, not a system rule. All three of Duris' idioms have to be
 *   expressible or two thirds of a spell list is unimplementable.
 * - **Recompute from base.** The fold is a pure function of the list, so an affect that came and went
 *   has to leave the totals exactly where they started — that is the property `unapply` cannot promise.
 * - **The sentinel survives arithmetic.** `-1` means for ever, and nothing may decrement it into a
 *   real and very short duration.
 *
 * Durations are in milliseconds and every step is explicit, so there is no clock here to make these
 * flake.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AFFECT_TYPES,
  AFFECT_TYPE_IDS,
  AffectFlag,
  UNLIMITED_DURATION,
  addAffects,
  advanceAffects,
  affectKind,
  affectsFor,
  hasFlag,
  hasType,
  newAffect,
  removeType,
  sumApply,
  summariseAffects,
  type Affect,
} from './affects.ts';

/** A regeneration node, the shape every multi-apply cause has. */
const regen = (modifier: number, durationMs = 10_000): Affect =>
  newAffect({ type: 'second_wind', durationMs, apply: 'hpRegen', modifier });

/* -------------------------------------------------------------------------- */

describe('the catalogue', () => {
  it('has an entry for every id, and no orphans either way', () => {
    // The list is the type and the table is the data — the same split `COMMANDS` and
    // `COMMAND_REQUIREMENTS` use — so this is the assertion that keeps them honest.
    for (const id of AFFECT_TYPE_IDS) {
      const kind = AFFECT_TYPES[id];
      assert.equal(kind.id, id, `${id} disagrees with its own key`);
      assert.ok(kind.name.length > 0, `${id} has no name`);
    }
    assert.deepEqual(Object.keys(AFFECT_TYPES).sort(), [...AFFECT_TYPE_IDS].sort());
  });

  it('resolves an id from outside the program without reaching Object.prototype', () => {
    assert.equal(affectKind('light')?.id, 'light');
    assert.equal(affectKind('spell_of_yesteryear'), undefined);
    // The own-property check. Without it this hands back `Object.prototype.toString` typed as a kind,
    // and the first read of `.name` is undefined several frames from the lookup.
    assert.equal(affectKind('toString'), undefined);
    assert.equal(affectKind('constructor'), undefined);
  });

  it('gives only the carried light a warning threshold', () => {
    // Not a rule, an observation worth pinning: warnings are for resources you can act on losing, and
    // adding one to everything would make the log a stream of near-misses.
    const warned = AFFECT_TYPE_IDS.filter((id) => AFFECT_TYPES[id].warnAtMs !== undefined);
    assert.deepEqual(warned, ['light']);
  });
});

describe('a new affect', () => {
  it('defaults to a bare timer, which is the commonest shape', () => {
    const affect = newAffect({ type: 'settling', durationMs: 5_000 });
    assert.equal(affect.apply, 'none');
    assert.equal(affect.modifier, 0);
    assert.equal(affect.flags, AffectFlag.None);
    assert.equal(affect.warned, false);
    assert.equal('context' in affect, false, 'omitted rather than undefined — exactOptionalPropertyTypes');
  });

  it('carries flags as a set, tested rather than walked', () => {
    const affect = newAffect({
      type: 'light',
      durationMs: 1_000,
      flags: AffectFlag.NoShow | AffectFlag.NoSave,
    });
    assert.ok(hasFlag(affect, AffectFlag.NoShow));
    assert.ok(hasFlag(affect, AffectFlag.NoSave));
    assert.ok(!hasFlag(affect, AffectFlag.Offline));
  });
});

describe('type is not a key', () => {
  it('holds several nodes of one cause and finds all of them', () => {
    const list: Affect[] = [
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'hpRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'manaRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'moveRegen', modifier: 8 }),
    ];
    assert.ok(hasType(list, 'second_wind'));
    assert.equal(affectsFor(list, 'hpRegen').length, 1);
    assert.equal(sumApply(list, 'hpRegen'), 6);
    assert.equal(sumApply(list, 'moveRegen'), 8);
  });

  it('removes the whole run, never just the first', () => {
    // The failure this prevents: a dispel that took one node would leave two thirds of a buff running
    // with no name for what was left and no way to remove it.
    const list: Affect[] = [regen(6), regen(4), newAffect({ type: 'settling', durationMs: 500 })];
    const removed = removeType(list, 'second_wind');
    assert.equal(removed.length, 2);
    assert.equal(sumApply(list, 'hpRegen'), 0);
    assert.deepEqual(list.map((a) => a.type), ['settling']);
  });

  it('reports removals in list order rather than in the order the walk found them', () => {
    const list: Affect[] = [regen(1), regen(2), regen(3)];
    assert.deepEqual(removeType(list, 'second_wind').map((a) => a.modifier), [1, 2, 3]);
  });

  it('removing a type nothing holds changes nothing', () => {
    const list: Affect[] = [regen(6)];
    assert.deepEqual(removeType(list, 'light'), []);
    assert.equal(list.length, 1);
  });
});

describe('stacking policies', () => {
  it('keep refuses when the cause is already running', () => {
    // Duris' sanctuary: checks the bit and bails. The incumbent wins outright, timer and all.
    const list: Affect[] = [regen(6, 9_000)];
    const { changed } = addAffects(list, [regen(99, 60_000)], 'keep');
    assert.equal(changed, false);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.modifier, 6, 'the incumbent is untouched');
  });

  it('keep still adds when nothing of that type is held', () => {
    const list: Affect[] = [newAffect({ type: 'settling', durationMs: 500 })];
    assert.equal(addAffects(list, [regen(6)], 'keep').changed, true);
    assert.equal(list.length, 2);
  });

  it('replace throws the whole run away and starts again', () => {
    // Duris' armor: refresh in place. Lighting a second torch is not two torches' worth of burn.
    const list: Affect[] = [regen(6, 1_000), regen(6, 1_000)];
    const { removed } = addAffects(list, [regen(6, 60_000)], 'replace');
    assert.equal(removed.length, 2);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.durationMs, 60_000);
  });

  it('join sums both duration and modifier', () => {
    // Duris' `affect_join`. Two doses of the same poison are worse and last longer.
    const list: Affect[] = [regen(6, 10_000)];
    addAffects(list, [regen(4, 5_000)], 'join');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.modifier, 10);
    assert.equal(list[0]?.durationMs, 15_000);
  });

  it('join matches on the location as well as the type', () => {
    // Duris matches on type alone, which is safe there only because the spells using `affect_join` are
    // single-location. Matching the pair is the same rule stated so a multi-apply cause cannot fold a
    // hit-point bonus into a mana one.
    const list: Affect[] = [
      newAffect({ type: 'second_wind', durationMs: 10_000, apply: 'hpRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 10_000, apply: 'manaRegen', modifier: 6 }),
    ];
    addAffects(list, [newAffect({ type: 'second_wind', durationMs: 10_000, apply: 'manaRegen', modifier: 5 })], 'join');
    assert.equal(list.length, 2);
    assert.equal(sumApply(list, 'hpRegen'), 6, 'the hp node is untouched');
    assert.equal(sumApply(list, 'manaRegen'), 11);
  });

  it('join into an unlimited affect leaves it unlimited', () => {
    // The sentinel is -1, so plain addition would turn "for ever" into a duration measured in
    // milliseconds and just short of nothing.
    const list: Affect[] = [newAffect({ type: 'light', durationMs: UNLIMITED_DURATION, apply: 'light' })];
    addAffects(list, [newAffect({ type: 'light', durationMs: 60_000, apply: 'light' })], 'join');
    assert.equal(list[0]?.durationMs, UNLIMITED_DURATION);
  });

  it('adding nothing is not a change', () => {
    const list: Affect[] = [regen(6)];
    assert.deepEqual(addAffects(list, []), { changed: false, removed: [] });
  });
});

describe('the expiry pass', () => {
  it('runs every duration down by one step', () => {
    const list: Affect[] = [regen(6, 1_000), newAffect({ type: 'settling', durationMs: 500 })];
    const { expired, expiring } = advanceAffects(list, 100);
    assert.deepEqual(expired, []);
    assert.deepEqual(expiring, []);
    assert.deepEqual(list.map((a) => a.durationMs), [900, 400]);
  });

  it('expires at zero rather than giving everything one free step', () => {
    const list: Affect[] = [regen(6, 100)];
    const { expired } = advanceAffects(list, 100);
    assert.equal(expired.length, 1);
    assert.equal(list.length, 0, 'and it is off the list, not sitting at zero');
  });

  it('never counts down the unlimited sentinel', () => {
    const list: Affect[] = [newAffect({ type: 'light', durationMs: UNLIMITED_DURATION, apply: 'light' })];
    for (let i = 0; i < 1_000; i++) advanceAffects(list, 100);
    assert.equal(list[0]?.durationMs, UNLIMITED_DURATION);
  });

  it('splices without skipping, however many go at once', () => {
    // The walk runs backwards for exactly this reason: a forward loop that spliced would step over the
    // entry that moved into the index it just vacated.
    const list: Affect[] = [regen(1, 100), regen(2, 100), regen(3, 100), regen(4, 100)];
    const { expired } = advanceAffects(list, 100);
    assert.equal(expired.length, 4);
    assert.equal(list.length, 0);
  });

  it('leaves the survivors alone when only some of a run expires', () => {
    const list: Affect[] = [regen(6, 100), regen(4, 5_000)];
    const { expired } = advanceAffects(list, 100);
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.modifier, 6);
    assert.equal(sumApply(list, 'hpRegen'), 4, 'the cause is still partly running');
  });

  it('warns once, latched, before the end', () => {
    const warnAt = AFFECT_TYPES.light.warnAtMs!;
    const list: Affect[] = [newAffect({ type: 'light', durationMs: warnAt + 200, apply: 'light', context: 'torch' })];

    assert.deepEqual(advanceAffects(list, 100).expiring, [], 'not yet');
    assert.equal(advanceAffects(list, 100).expiring.length, 1, 'the crossing');
    assert.deepEqual(advanceAffects(list, 100).expiring, [], 'and never again for this instance');
  });

  it('warns on the first step for an affect resumed below its own threshold', () => {
    // The case a bare edge test misses, and the reason `warned` is a latch rather than a comparison of
    // before and after: a character logging in with five seconds of torch left has never been warned,
    // and would otherwise be told nothing at all before the dark closed in.
    const list: Affect[] = [newAffect({ type: 'light', durationMs: 5_000, apply: 'light', context: 'torch' })];
    assert.equal(advanceAffects(list, 100).expiring.length, 1);
  });

  it('does not warn about something that expires in the same step', () => {
    const list: Affect[] = [newAffect({ type: 'light', durationMs: 100, apply: 'light', context: 'torch' })];
    const { expired, expiring } = advanceAffects(list, 100);
    assert.equal(expired.length, 1);
    assert.deepEqual(expiring, [], 'it has gone; a warning about it would arrive too late to act on');
  });
});

describe('the fold', () => {
  it('totals a location and leaves the others at zero', () => {
    const list: Affect[] = [
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'hpRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'hpRegen', modifier: 4 }),
      newAffect({ type: 'settling', durationMs: 9_000 }),
    ];
    assert.equal(sumApply(list, 'hpRegen'), 10);
    assert.equal(sumApply(list, 'manaRegen'), 0);
    assert.equal(sumApply(list, 'none'), 0, 'a timer contributes nothing anywhere');
  });

  it('returns to base when an affect comes and goes — the property unapply cannot promise', () => {
    const list: Affect[] = [];
    const before = sumApply(list, 'hpRegen');
    addAffects(list, [regen(6, 100), regen(4, 100)]);
    assert.equal(sumApply(list, 'hpRegen'), 10);
    advanceAffects(list, 100);
    assert.equal(sumApply(list, 'hpRegen'), before, 'exactly where it started, not near it');
  });

  it('sums a negative modifier without a special case', () => {
    // Debuffs are the same record. That is most of the argument for having one.
    const list: Affect[] = [regen(6), newAffect({ type: 'second_wind', durationMs: 100, apply: 'hpRegen', modifier: -10 })];
    assert.equal(sumApply(list, 'hpRegen'), -4);
  });
});

describe('the display path', () => {
  it('shows one row per cause however many nodes it installed', () => {
    // Three identical countdowns ticking together would be a leak of the record shape into the HUD.
    const list: Affect[] = [
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'hpRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'manaRegen', modifier: 6 }),
      newAffect({ type: 'second_wind', durationMs: 9_000, apply: 'moveRegen', modifier: 8 }),
    ];
    assert.deepEqual(summariseAffects(list), [
      { type: 'second_wind', name: AFFECT_TYPES.second_wind.name, remainingMs: 9_000 },
    ]);
  });

  it('keeps the longest remaining of a group', () => {
    // What a player wants from "how long have I got" is the last moment any of it is still true.
    const list: Affect[] = [regen(6, 3_000), regen(4, 11_000)];
    assert.equal(summariseAffects(list)[0]?.remainingMs, 11_000);
  });

  it('treats unlimited as outlasting every number, whichever order it arrives in', () => {
    const forever = newAffect({ type: 'second_wind', durationMs: UNLIMITED_DURATION, apply: 'hpRegen' });
    assert.equal(summariseAffects([forever, regen(6, 9_000)])[0]?.remainingMs, undefined);
    assert.equal(summariseAffects([regen(6, 9_000), forever])[0]?.remainingMs, undefined);
  });

  it('hides what asked to be hidden', () => {
    // The carried light. It has had its own HUD line and its own log prose since Phase 1, and listing
    // it again under "affects" would say the same thing twice in two vocabularies.
    const list: Affect[] = [
      newAffect({ type: 'light', durationMs: 9_000, apply: 'light', flags: AffectFlag.NoShow, context: 'torch' }),
      regen(6),
    ];
    assert.deepEqual(summariseAffects(list).map((a) => a.type), ['second_wind']);
  });

  it('keeps first-seen order, so a list does not reshuffle as it counts down', () => {
    const list: Affect[] = [newAffect({ type: 'settling', durationMs: 30_000 }), regen(6, 60_000)];
    assert.deepEqual(summariseAffects(list).map((a) => a.type), ['settling', 'second_wind']);
  });

  it('shows nothing for a character nothing is affecting', () => {
    assert.deepEqual(summariseAffects([]), []);
  });
});
