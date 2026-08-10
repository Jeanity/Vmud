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
  /**
   * Whether what is in the off hand changes the outcome.
   *
   * True of `bash` alone, and it is the reason this interface now has to be handed the wearer's
   * gear at all. `chance_kick` reads no equipment; `bash` reads it twice, once for the chance and
   * once for the damage. A flag rather than a special case on `id === 'bash'`, because the next
   * ability that leans on a shield — `shieldpunch` is the obvious one, `actoff.c:7666` — should be
   * able to say so in the table instead of in an `if`.
   */
  readonly usesShield?: true;
}

/**
 * What a bash needs to know about the thing in your off hand.
 *
 * Deliberately **not** {@link equipment.Item}. This module is the rules maths and has no business
 * knowing what an inventory row looks like; it needs a bulk and a name, and narrowing the input to
 * exactly those two is what keeps the dependency from running the wrong way. The caller decides
 * what counts as a shield — for us, `DURIS_ITEM.shield` worn in `offHand` — which is also where
 * the answer belongs, since a lantern lives in the same slot and is not one.
 */
export interface Shield {
  /** Slots of bulk, {@link items.sizeFrom}'s conversion of Duris' pounds. */
  readonly size: number;
  /** Tested for the substring `spiked`, exactly as `actoff.c:6470` does. */
  readonly name: string;
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
    usesShield: true,
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
 *
 * **The shield is the second input** — the owner's fifth ask, and the source's answer to it. See
 * {@link SHIELDLESS_BASH_FLOOR} for why a bash without one is a fifth as likely to land, and
 * {@link shieldBonus} for what carrying one is worth. `kick` ignores the argument: nothing in
 * `chance_kick` reads equipment.
 */
export function abilityChance(ability: CombatAbility, learned: number, shield?: Shield): number {
  const raw = ability.usesShield
    ? shield
      ? learned + shieldBonus(shield.size)
      : (learned * SHIELDLESS_BASH_FLOOR) / 100
    : learned;
  return Math.max(0, Math.min(100, raw));
}

/**
 * The multiplier, as a percentage, on a bash thrown with nothing in the off hand.
 *
 * `actoff.c:6286`: `modifier = GET_CHAR_SKILL(ch, SKILL_SHIELDLESS_BASH)`, raised to 20 if it is
 * lower, then `percent_chance *= modifier / 100.0`. The comment beside it reads *"Minimum of 4/5
 * reduction. Max no reduction."*
 *
 * **For every character this game can make, the floor is the whole rule**, and that is the finding
 * that settles the owner's ask. `SKILL_SHIELDLESS_BASH` is created `TAR_PHYS | TAR_EPIC`
 * (`epic_skills.c:172`) and `skills.c:4748` zeroes it on every ordinary character, so nobody
 * without epic training ever has a point in it — the multiplier is pinned at 20 permanently. A
 * shieldless bash is a fifth as likely to land, for good.
 *
 * That is why the ask — *"bash should refuse without a shield"* — is nearly right and still wrong to
 * transcribe literally. The source never refuses; it makes you miss four times out of five and tells
 * you it is going to. The hard refusal the ask describes is real, but it belongs to `shieldpunch`
 * (`actoff.c:7666`, *"Punch with what?"*), which we have not built.
 *
 * Kept as a named constant rather than `0.2` inline so that if epic skills ever arrive, the thing
 * that changes is one lookup and not a magic number nobody can find.
 */
export const SHIELDLESS_BASH_FLOOR = 20;

/** What the source prints the first time, and every time, for a character with no epic training. */
export const SHIELDLESS_BASH_LINE = 'Bashing without a shield is tough, but you try anyway...';

/**
 * What a shield in the off hand adds to a bash, in percentage points.
 *
 * `actoff.c:6282` is `percent_chance += (ch->equipment[WEAR_SHIELD]->weight / 1.8)`, with the
 * author's own note: *"Heaviest shield in game atm is church door at 30 lbs -> 16.67 % increase."*
 *
 * **We do not have `weight`, and that was a deliberate choice, not an oversight.** Duris' pounds were
 * converted to {@link items.sizeFrom}'s slots of bulk — `ceil(weight / 5)`, capped at ten — because
 * this project's encumbrance is measured in bag slots. Rather than re-introduce a second unit for
 * one formula, the term is rebuilt from `size` at the **midpoint of the bucket it stands for**: a
 * size of *n* means a weight somewhere in `5n-4 .. 5n`, whose middle is `5n - 2`. So the bonus is
 * `(5 * size - 2) / 1.8`, which tracks the source's curve to within ±1.4 points.
 *
 * Measured over the 242 shields in the catalogue before choosing that: they run the whole range, 97
 * at size 1 and two at the size cap, so this term is worth between **+0.6 and +26.7 points**
 * depending on what you are carrying. It is not a rounding error, and a heavy shield is a real
 * choice — which is the reason to get the conversion right rather than flatten it.
 */
export function shieldBonus(size: number): number {
  return (5 * Math.max(1, size) - 2) / 1.8;
}

/**
 * The dice a landed ability rolls, with the skill folded into the bonus.
 *
 * `floor(learned / 10)` — the same conversion `toHitFrom` uses, for the reason given in the module note:
 * Duris' skill-scaled damage is on a 1–100 scale and ours is not, so the number is converted rather than
 * copied. A mastered kick is `1d6+9`, which sits beside a weapon swing rather than replacing it.
 *
 * **Returns a list, because a shield adds a second die.** `actoff.c:6469` is
 * `dmg += number(0, 4) + weight / 2` — a flat part and a rolled part — and our {@link Dice} is one
 * die with one bonus, so a single value cannot hold both. `number(0, 4)` is `1d5 - 1`. Everything
 * deterministic is folded into the first entry's bonus; the caller sums the rolls.
 *
 * The doubling is the source's, and it is a **string test on the item's name**:
 * `if (strstr(ch->equipment[WEAR_SHIELD]->name, "spiked")) dmg *= 2`. Nineteen shields in our
 * catalogue answer it. Faithfully reproduced, oddity included — it is how the world was authored,
 * and a flag we invented instead would apply to a different set of shields than the MUD's did.
 */
export function abilityDamage(
  ability: CombatAbility,
  learned: number,
  shield?: Shield,
): readonly Dice[] {
  const skill = Math.floor(learned / 10);
  if (!ability.usesShield || !shield) {
    return [{ ...ability.damage, bonus: ability.damage.bonus + skill }];
  }
  // The midpoint conversion `shieldBonus` explains, halved rather than divided by 1.8.
  const flat = Math.floor((5 * Math.max(1, shield.size) - 2) / 2);
  const spiked = /spiked/i.test(shield.name) ? 2 : 1;
  return [
    { count: ability.damage.count, sides: ability.damage.sides, bonus: (ability.damage.bonus + skill + flat) * spiked },
    // `number(0, 4)`, and doubled with the rest when the shield is spiked.
    { count: spiked, sides: 5, bonus: -spiked },
  ];
}
