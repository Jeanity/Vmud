/**
 * The two things you can *do* in a fight — **Phase 19 slice 3**, `bash` and `kick`.
 *
 * Until now a fight was `kill` and then watching: auto-attacks on a round clock, with `flee` the only other
 * verb. These are the first abilities, and they were chosen because the source has both and because their
 * *consequences* already existed here — a knocked-down body stays down because `canMove` is the gate, and
 * "lag" is `scheduler.cancel` plus a fresh `schedule`, which is what `engage` already does to make an
 * opening blow wait a round.
 *
 * ## What is transcribed, and the one thing that is not
 *
 * From `chance_kick` / `do_bash` (`actoff.c`): both are `CMD_Y(… STAT_NORMAL + POS_STANDING …)`, so on your
 * feet and allowed mid-fight; the chance to land is **the skill percentage itself**; a bash sits the victim
 * down and lags them a round while the basher takes a **two-round** self-lag; a kick lags its user a round
 * and a half.
 *
 * **Dropped and named as dropped**: Duris scales the chance by `BOUNDED(80, DEX, 125) / 100` and derives
 * kick damage from `MAX(STR/2, martial_arts)`. There are no ability scores yet — Phase 14b never built its
 * derivation half — so the dexterity scaling is absent and the damage is skill-derived instead. When
 * ability scores land, this is one of the three places waiting for them.
 *
 * ## The damage is converted, not copied
 *
 * Duris' kick does `MAX(STR/2, martial) + kick_skill` on a 1–100 scale, which at mastery is about 95 — where
 * a level-30 weapon swing here does about 25. Copying it would break the band `DESIGN-progression.md` §8
 * calibrated. So the established conversion is reused: `floor(learned / 10)`, the same one that turns a skill
 * percentage into a d20 to-hit bonus (`toHitFrom`), on top of a small base die.
 *
 * That leaves **kick as a real blow and bash as barely one**, which is the source's own shape: `do_bash`
 * passes `MAX(1, dam)` because a bash is for the knockdown, not the damage.
 *
 * ## Why everything here says *combat* ability
 *
 * `rules.ts` already owns the word: in the SRD an "ability" is a **stat** — `ABILITIES` is
 * `['str', 'dex', 'con', 'int', 'wis', 'cha']`, the vocabulary Phase 14b's unbuilt half will fill in. These
 * are the other sense of the word, so they carry the adjective rather than shadowing it. Worth noticing
 * that the collision is itself informative: the thing this module cannot do yet — scale a kick off strength —
 * is named in the module it collides with.
 */

import type { Dice } from './rules.ts';
import type { SkillId } from './skills.ts';

export const COMBAT_ABILITY_IDS = ['bash', 'kick'] as const;
export type CombatAbilityId = (typeof COMBAT_ABILITY_IDS)[number];

export interface CombatAbility {
  readonly id: CombatAbilityId;
  /** The skill it rolls against and notches. */
  readonly skill: SkillId;
  /** Base dice. The skill's contribution is added to `bonus` — see {@link abilityDamage}. */
  readonly damage: Dice;
  /**
   * How long the user cannot act afterwards, as a multiple of a combat round.
   *
   * Duris' `CharWait`, in `PULSE_VIOLENCE`. This is the cost that makes an ability a decision rather than
   * a free extra: kicking instead of swinging trades a round and a half of blows for one kick.
   */
  readonly selfLagRounds: number;
  /** How long the *target* cannot act, when it lands. `CharWait(victim, …)`. */
  readonly targetLagRounds: number;
  /** Whether landing it puts the target on the ground. */
  readonly knocksDown: boolean;
  /** Second person, for the line the user reads. */
  readonly verb: string;
  /** Third person, for everyone watching. */
  readonly verbThird: string;
}

export const COMBAT_ABILITIES: Readonly<Record<CombatAbilityId, CombatAbility>> = {
  bash: {
    id: 'bash',
    skill: 'bash',
    // `MAX(1, dam)` in the source: a bash is for the knockdown, so the damage is incidental.
    damage: { count: 1, sides: 4, bonus: 0 },
    // Two rounds, and it is the longest lag in the game so far: `set_short_affected_by(ch, SKILL_BASH,
    // 2 * PULSE_VIOLENCE)`, which in Duris also blocks a follow-up kick — *"you haven't reoriented
    // yourself yet enough for another kick"*. Ours blocks any ability, which is the same idea stated once.
    selfLagRounds: 2,
    targetLagRounds: 1,
    knocksDown: true,
    verb: 'bash',
    verbThird: 'bashes',
  },
  kick: {
    id: 'kick',
    skill: 'kick',
    damage: { count: 1, sides: 6, bonus: 0 },
    // `(PULSE_VIOLENCE * 3) / 2` — a round and a half.
    selfLagRounds: 1.5,
    targetLagRounds: 0,
    knocksDown: false,
    verb: 'kick',
    verbThird: 'kicks',
  },
};

/** Whether a string names an ability. The command dispatch's gate. */
export function isCombatAbility(value: string): value is CombatAbilityId {
  return Object.hasOwn(COMBAT_ABILITIES, value);
}

/**
 * The chance to land, as a percentage: **the skill itself**.
 *
 * `chance_kick` returns `GET_CHAR_SKILL(ch, SKILL_KICK)` and then scales it by dexterity, which we do not
 * have. So at level 1 (floor 1) a kick lands one time in a hundred and at mastery 95 — which reads harshly
 * until you notice what the floor does: from level 27 every character has 40, so this is a coin-flip-ish
 * ability that gets reliable, rather than one that does not work until you grind it.
 */
export function abilityChance(learned: number): number {
  return Math.max(0, Math.min(100, learned));
}

/**
 * The dice a landed ability rolls, with the skill folded into the bonus.
 *
 * `floor(learned / 10)` — the same conversion `toHitFrom` uses, for the reason given in the module note:
 * Duris' skill-scaled damage is on a 1–100 scale and ours is not, so the number is converted rather than
 * copied. A mastered kick is `1d6+9`, which sits beside a weapon swing rather than replacing it.
 */
export function abilityDamage(ability: CombatAbility, learned: number): Dice {
  return { ...ability.damage, bonus: ability.damage.bonus + Math.floor(learned / 10) };
}
