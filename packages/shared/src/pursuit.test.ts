/**
 * Pursuit: the tier a mob's flags produce, and the flags that turn a hunter back.
 *
 * The `huntRule` cases are §4.11's traps, pinned: HUNTER without MEMORY is inert, `NO_LURE` opts out
 * of hunting entirely, and SENTINEL is a *zone leash* rather than immobility — so a sentinel that
 * hunts at all hunts at the `zone` tier, and only the unleashed reach `relentless`. The tier tables
 * are asserted verbatim because they are tuning decisions, not derivations (see the module note in
 * `pursuit.ts`): if one of those numbers moves, the feel of being chased moves with it, and this is
 * where that shows up as a diff.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  GIVE_UP_MS,
  TRACK_ROOMS,
  huntBlockedBy,
  huntRule,
  noPursuit,
  pursues,
  type PursuitRule,
} from './index.ts';

describe('pursuit', () => {
  describe('basic rules', () => {
    it('determines if a rule pursues', () => {
      // noPursuit is always sentinel, so it doesn't pursue.
      assert.equal(pursues(noPursuit()), false);

      const zoneRule: PursuitRule = {
        tier: 'zone',
        trackRooms: TRACK_ROOMS.zone,
        giveUpMs: GIVE_UP_MS.zone,
        respectsSafeRooms: true,
        staysInZone: true,
        opensDoors: true,
      };
      assert.equal(pursues(zoneRule), true);

      const relentlessRule: PursuitRule = {
        tier: 'relentless',
        trackRooms: TRACK_ROOMS.relentless,
        giveUpMs: GIVE_UP_MS.relentless,
        respectsSafeRooms: true,
        staysInZone: false,
        opensDoors: true,
      };
      assert.equal(pursues(relentlessRule), true);
    });
  });

  describe('huntRule logic', () => {
    it('returns a "sentinel" tier when noLure is set', () => {
      const rule = huntRule({
        hunter: true,
        remembers: true,
        sentinel: false,
        staysInZone: false,
        noLure: true,
        opensDoors: true,
      });
      assert.equal(rule.tier, 'sentinel');
      assert.equal(rule.trackRooms, TRACK_ROOMS.sentinel);
      assert.equal(rule.giveUpMs, GIVE_UP_MS.sentinel);
    });

    it('returns a "sentinel" tier when hunter is false', () => {
      const rule = huntRule({
        hunter: false,
        remembers: true,
        sentinel: false,
        staysInZone: false,
        noLure: false,
        opensDoors: true,
      });
      assert.equal(rule.tier, 'sentinel');
    });

    it('returns a "sentinel" tier when remembers is false', () => {
      // §4.11: ACT_HUNTER does nothing without ACT_MEMORY — the whole hunt lives inside the
      // memory check, so a HUNTER alone just wanders. This is the dependency, pinned.
      const rule = huntRule({
        hunter: true,
        remembers: false,
        sentinel: false,
        staysInZone: false,
        noLure: false,
        opensDoors: true,
      });
      assert.equal(rule.tier, 'sentinel');
    });

    it('returns a "zone" tier if leashed (sentinel or staysInZone) and other conditions met', () => {
      const rule1 = huntRule({
        hunter: true,
        remembers: true,
        sentinel: true,
        staysInZone: false,
        noLure: false,
        opensDoors: true,
      });
      assert.equal(rule1.tier, 'zone');

      const rule2 = huntRule({
        hunter: true,
        remembers: true,
        sentinel: false,
        staysInZone: true,
        noLure: false,
        opensDoors: true,
      });
      assert.equal(rule2.tier, 'zone');
    });

    it('returns "relentless" if not leashed and other conditions met', () => {
      const rule = huntRule({
        hunter: true,
        remembers: true,
        sentinel: false,
        staysInZone: false,
        noLure: false,
        opensDoors: true,
      });
      assert.equal(rule.tier, 'relentless');
    });
  });

  describe('huntBlockedBy', () => {
    const rule: PursuitRule = {
      tier: 'relentless',
      trackRooms: 100,
      giveUpMs: null,
      respectsSafeRooms: true,
      staysInZone: false,
      opensDoors: true,
    };

    it('returns true if block is no_mob', () => {
      assert.equal(huntBlockedBy(['no_mob'], rule), true);
    });

    it('returns false for missing or empty flags', () => {
      // A room with no flag list and a room with an empty one are the same fact to a hunter.
      assert.equal(huntBlockedBy(undefined, rule), false);
      assert.equal(huntBlockedBy([], rule), false);
    });

    it('returns true if blocked by safe and respectsSafeRooms is true', () => {
      assert.equal(huntBlockedBy(['safe'], rule), true);
    });

    it('returns false for safe if respectsSafeRooms is false', () => {
      // §2.10's dragon: sanctuary respect is per rule, so an authored horror can ignore it.
      const ruleNoSafe: PursuitRule = { ...rule, respectsSafeRooms: false };
      assert.equal(huntBlockedBy(['safe'], ruleNoSafe), false);
    });
  });

  describe('tables', () => {
    it('has correct TRACK_ROOMS values', () => {
      assert.equal(TRACK_ROOMS.sentinel, 0);
      assert.equal(TRACK_ROOMS.local, 3);
      assert.equal(TRACK_ROOMS.zone, 40);
      assert.equal(TRACK_ROOMS.relentless, 500);
    });

    it('has correct GIVE_UP_MS values', () => {
      assert.equal(GIVE_UP_MS.sentinel, 0);
      assert.equal(GIVE_UP_MS.local, 30_000);
      assert.equal(GIVE_UP_MS.zone, 120_000);
      assert.equal(GIVE_UP_MS.relentless, null);
    });
  });
});
