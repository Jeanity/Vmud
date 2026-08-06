/**
 * Getting out of the way — **dodge and parry**, Phase 19 slice 2.
 *
 * `DESIGN-skills.md` §8.2 parked this with one sentence that turned out to be the whole design: *"both
 * need a defence roll we do not have — our AC is passive, and dodge/parry are an active second gate."*
 * That is exactly what the source does, and reading `new_combat.c` settles the shape rather than leaving
 * it to be invented.
 *
 * ## The order, from `hitCharacter` in `new_combat.c`
 *
 * ```
 * if (auto_hit || !canCharDodgeParry(victim, ch) || ((hitrand <= ch_tohit || crithit) && !critfumb))
 * {
 *   if (try_dodge_parry)
 *   {
 *     dodgerand = number(1, 101);   … if (dodgerand <= vict_dodge) → victDodge(), return FALSE
 *     if (!number(0, 1)) notch_skill(victim, SKILL_DODGE, 17);
 *     parryrand = number(1, 101);   … if (parryrand <= vict_parry) → victParry(), return FALSE
 *     if (!number(0, 1)) notch_skill(victim, SKILL_PARRY, 25);
 *   }
 *   … damage …
 * ```
 *
 * Three things fall out of that block and each is load-bearing:
 *
 * 1. **The defence rolls happen only when the attack has already beaten the armour class.** A blow that
 *    missed is a miss; dodge does not get consulted, and cannot make a miss into a dodge. Our `d20`
 *    against AC is the first gate exactly as `hitrand <= ch_tohit` is.
 * 2. **Dodge is tried first, and parry only if the dodge failed.** They are not one roll with two names.
 * 3. **The notch happens on the roll that failed, and only half the time** — `if (!number(0, 1))`. You
 *    learn from being hit at, not from succeeding, which is the opposite of the weapon skills and is
 *    why slice 1's `notchFromSwing` could not simply be reused.
 *
 * ## What is transcribed and what is dropped, named
 *
 * Both source functions are ~150 lines of modifiers over a two-line core. The core is
 * `skill / 5`, and everything after it multiplies. Kept: **the crowd penalty**, because it is the reason
 * ganging up works and we have the number it needs. Dropped, with the reason:
 *
 * - **Dexterity, agility and luck** — we have no ability scores. Same treatment `abilityChance` gave
 *   `chance_kick`'s `BOUNDED(80, DEX, 125)`: named as dropped rather than approximated, because a stat
 *   invented here would have to be un-invented when Phase 21 brings the real one.
 * - **Size** — `chance += (attsize - victsize) * 15` is *"very important"* in the source's own comment,
 *   and we have no sizes on actors at all. This is the largest known omission and it is worth stating:
 *   an ogre should be easier to dodge than a kobold, and today it is not.
 * - **Haste, blur, slow** — no such affects exist yet. `AFFECT_TYPE_IDS` is where they would go.
 * - **Terrain and `SINGLE_FILE`** — we *have* sectors, but the source's list is of underwater and
 *   low-ceiling types the loaded zones do not contain, and a modifier no room can trigger is a reader
 *   with nothing to read. It belongs with Phase 19 slice 5, swimming.
 * - **Riposte, thri-kreen leaps, blindfighting** — separate mechanisms with their own rows.
 *
 * ## A quirk worth keeping rather than tidying
 *
 * `vict_dodge += BOUNDED(0, (hitrand - ch_tohit) / 2, 30)` sits above the dodge roll under the comment
 * *"if they have a good to-hit we want the victim's dodge score to be affected less"*. Read carefully it
 * can only fire when the block was entered by a **critical** — an ordinary hit has `hitrand <= ch_tohit`,
 * so the term is negative and clamps to zero. So the rule it actually encodes is: *a critical hit from
 * somebody who could not otherwise have hit you is the easiest thing in the game to dodge*. That is odd
 * enough to look like a bug and consistent enough to be deliberate — a wild swing that happened to land
 * perfectly is still a wild swing. Transcribed in {@link dodgeChance}, and the alternative would have
 * been to quietly decide the source was wrong.
 */

/** The most a dodge can ever come to, however skilled. `BOUNDED(0, vict_dodge, 60)`. */
export const DODGE_CAP = 60;

/** Parry's own ceiling, `BOUNDED(0, vict_parry, 100)` — deliberately higher than dodge's. */
export const PARRY_CAP = 100;

/**
 * How much of a defence survives being set upon by several people at once.
 *
 * The source's table, verbatim, as a multiplier on the whole chance:
 *
 * ```
 * if (numb_att == 2)      mod -= 0.1;
 * else if (numb_att == 3) mod -= 0.25;
 * else if (numb_att == 4) mod -= 0.40;
 * else if (numb_att == 5) mod -= 0.60;
 * else                    mod -= (numb_att * 14) / 100;
 * ```
 *
 * **The `else` catches one attacker as well as six**, which is the part a reader would otherwise get
 * wrong: a lone attacker lands in it and costs the defender 14% of their chance. That is not a rounding
 * artefact — the chain is a plain `if`/`else if`, so the fall-through is the *default* case and being
 * attacked at all is what it charges for. Kept as written.
 */
export function crowdModifier(attackers: number): number {
  if (attackers === 2) return 1 - 0.1;
  if (attackers === 3) return 1 - 0.25;
  if (attackers === 4) return 1 - 0.4;
  if (attackers === 5) return 1 - 0.6;
  return 1 - (attackers * 14) / 100;
}

/** A mob's defensive skill: `BOUNDED(0, GET_LEVEL(vict) * 2, 100)`, the source's own NPC branch. */
export function mobDefenceSkill(level: number): number {
  return Math.max(0, Math.min(100, level * 2));
}

/**
 * The chance in a hundred that a blow is dodged.
 *
 * `chance = MAX(1, dodge_skill / 5)` — note the floor of **one**, which only applies when the skill is
 * non-zero: `if (dodge_skill) chance = MAX(1, dodge_skill / 5)`, so somebody who has never dodged has no
 * chance at all rather than a 1% one. A trained 95 gives 19 before modifiers.
 *
 * `criticalOvershoot` is the quirk from the module note: the amount by which a *critical* beat what the
 * attacker needed, halved and capped at 30. Zero for an ordinary hit, which is what the source computes.
 */
export function dodgeChance(options: {
  readonly skill: number;
  readonly attackers: number;
  readonly criticalOvershoot?: number;
}): number {
  if (options.skill <= 0) return 0;
  // **The order is the source's and it is not the obvious one.** `getCharDodgeVal` multiplies by the
  // modifiers and clamps to 100; the overshoot is added *afterwards*, at the call site in
  // `new_combat.c`, and only then is the 60 cap applied. Adding it first would put the critical bonus
  // through the crowd penalty as well, which is a different — and quieter — number.
  const rolled = clampChance(Math.max(1, Math.floor(options.skill / 5)) * crowdModifier(options.attackers), 100);
  return clampChance(rolled + Math.min(30, Math.max(0, options.criticalOvershoot ?? 0)), DODGE_CAP);
}

/**
 * The chance in a hundred that a blow is parried. **Zero for an empty hand.**
 *
 * `if (!canCharDodgeParry(vict, attacker) || !weapon) return 0;` — you do not parry a sword with your
 * arm, and that gate is the reason parry gets the higher cap: it costs something to be eligible for.
 *
 * A player's skill is `(SKILL_PARRY / 2) + (weapon skill / 2)` — half the general knack, half your
 * familiarity with the thing in your hand, so parrying well with an axe is partly an axe skill. A
 * **mob**'s is the warrior branch, `level * 2`, and non-warriors get **zero**; we have no classes until
 * Phase 21, so `warrior` is passed in and is false for everything the harvest produces. That is the same
 * treatment `attackBonusFor` gives its own `martial` branch, and it errs in the same safe direction.
 */
export function parryChance(options: {
  readonly parrySkill: number;
  readonly weaponSkill: number;
  readonly attackers: number;
  readonly armed: boolean;
}): number {
  if (!options.armed) return 0;
  const skill = Math.floor(options.parrySkill / 2) + Math.floor(options.weaponSkill / 2);
  if (skill <= 0) return 0;
  return clampChance(Math.floor(skill / 5) * crowdModifier(options.attackers), PARRY_CAP);
}

function clampChance(raw: number, cap: number): number {
  return Math.max(0, Math.min(cap, Math.floor(raw)));
}

/** How comfortably a defence succeeded, for the prose. `getDodgeEaseString`'s own five bands. */
export const DEFENCE_EASE = ['no-trouble', 'easily', 'plain', 'barely', 'narrowly'] as const;
export type DefenceEase = (typeof DEFENCE_EASE)[number];

/**
 * Which band a successful defence falls in.
 *
 * `passedby` in the source is the **chance**, not the margin — `victDodge(ch, victim, …, dodgerand,
 * vict_dodge)` passes the roll and the chance, and `getDodgeEaseString(passedby, …)` is called on the
 * chance. So the prose describes *how good you are at this*, not *how close that one was*, which is why
 * a 90% dodger reads as having "no trouble" even on a roll of 89.
 */
export function defenceEase(chance: number): DefenceEase {
  if (chance > 85) return 'no-trouble';
  if (chance > 60) return 'easily';
  if (chance > 40) return 'plain';
  if (chance > 20) return 'barely';
  return 'narrowly';
}

/** The verb, in the person it is read in. The source's own words from the two ease tables. */
export function defenceVerb(kind: 'dodge' | 'parry', ease: DefenceEase, second: boolean): string {
  if (kind === 'dodge') {
    switch (ease) {
      case 'no-trouble': return second ? 'have no trouble dodging' : 'has no trouble dodging';
      case 'easily': return second ? 'easily dodge' : 'easily dodges';
      case 'plain': return second ? 'dodge' : 'dodges';
      case 'barely': return second ? 'barely dodge' : 'barely dodges';
      // The source's own phrasing, and it is the one line that is not built on the verb — a defence this
      // narrow is described as the blow nearly landing rather than as a thing you did.
      case 'narrowly': return second ? 'narrowly miss being hit by' : 'narrowly misses being hit by';
    }
  }
  switch (ease) {
    case 'no-trouble': return second ? 'have no trouble parrying' : 'has no trouble parrying';
    case 'easily': return 'easily parry';
    case 'plain': return second ? 'parry' : 'parries';
    case 'barely': return second ? 'barely parry' : 'barely parries';
    case 'narrowly': return second ? 'narrowly parry' : 'narrowly parries';
  }
}

/**
 * The chance of notching a defensive skill after it failed you — `get_property("skill.notch.defensive")`.
 *
 * **17 for dodge and 25 for parry**, and both are then halved by the source's `if (!number(0, 1))` coin
 * flip at the call site. Held here as the raw property values with {@link DEFENCE_NOTCH_ODDS} beside
 * them, rather than pre-multiplied, so the two facts stay separately checkable against the source.
 */
export const DODGE_NOTCH_CHANCE = 17;
export const PARRY_NOTCH_CHANCE = 25;

/** `if (!number(0, 1))` — the defensive notch is attempted on half of the rolls that failed. */
export const DEFENCE_NOTCH_ODDS = 0.5;
