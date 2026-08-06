/**
 * Skills: percentages you grind by using, not levels you buy — **Phase 19**.
 *
 * `DESIGN-skills.md` is the argument; this is the arithmetic. Everything here is pure, so the whole
 * mechanism is testable without a fight, a socket or a world.
 *
 * ## The shape, in one paragraph
 *
 * A skill is a number 0–100 with a **ceiling** above it and a **floor** under it. The floor is a pure
 * function of level (`MIN(40, 3 * level / 2)`) and it does the heavy lifting: a fresh level-30
 * character is *competent for free*, and the grind is what makes them better than competent. The
 * ceiling is what the grind cannot reach — it is approached asymptotically, because the notch chance
 * carries `(1 − learned / ceiling)` — which is what leaves room for teachers, quests and class
 * specialisations to exist later without any of them being the *only* way up.
 *
 * ## Which weapon skills exist, and why not the ones the live combat names
 *
 * This is the finding that shaped the phase, and it is written up in full in `DESIGN-skills.md` §0
 * and §4. Duris has **two** weapon-skill schemes and they are wired to each other's opposite:
 *
 * - `getWeaponSkillNumb` (`new_combat_util.c:829`) is in the **live** combat and maps a weapon to a
 *   skill **per weapon type** — `SKILL_LONGSWORD`, `SKILL_DAGGER`, eighteen of them. Every one of those
 *   ids appears **exactly once in the entire source**: as that function's return value. None is ever
 *   `SKILL_CREATE`d, so none has a name, a category or a `maxlearn`; `update_skills` therefore zeroes
 *   both `learned` and `taught` for all of them, and the live combat's weapon-skill contribution is
 *   **0 for every player character in the shipped game**.
 * - `required_weapon_skill` (`fight.c:6896`) is in the **dead** combat (`#ifndef NEW_COMBAT`, and
 *   `NEW_COMBAT` is defined) and maps a weapon to one of **eight damage classes** — 1h/2h ×
 *   slashing/piercing/bludgeon/flaying, plus reach weapons and unarmed. Every one of those *is*
 *   registered, with a name, `TAR_PHYS`, and a per-class ceiling table (warrior 100, ranger 100,
 *   bard 90, assassin 85, ethermancer 70 …).
 *
 * So we take the **damage classes**: they are the only weapon skills the source actually defines, their
 * ceiling table is the real data Phase 21 will grow {@link ceilingFor} into, and eight categories is a
 * shape a player can hold in their head where eighteen weapon shapes is a spreadsheet. Transcribing the
 * live mapping instead would have faithfully reproduced a mechanism that does nothing.
 *
 * Measured over all 2,841 harvested weapons, the mapping lands: **1h slashing 851, 1h piercing 728,
 * 1h bludgeon 571, 2h slashing 310, 2h bludgeon 158, 1h flaying 128, reach 81, 2h flaying 7** — three
 * skills covering 76% of the world, which is why a player realistically has a main and a sideline. Six
 * weapons have no class at all and one is a two-handed dagger the source itself logs as a builder
 * error; both get no skill rather than a wrong one.
 */

import type { ItemTemplate } from './items.ts';
import { randomInt, type Rng } from './rules.ts';

/* -------------------------------------------------------------------------- */
/* The catalogue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The two categories, which are the two **rate limits**.
 *
 * `SKILL_CREATE("swim", SKILL_SWIM, TAR_PHYS)` — a skill's category is data in the source's own skill
 * table, so it is data here. Both exist from the start even though every skill this phase ships is
 * physical: a cooldown shared by everything would make the two-category design unobservable, and an
 * unobservable design is one nobody can build on later.
 */
export const SKILL_CATEGORIES = ['physical', 'mental'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * How long a notch shuts its category's door, from `get_property("timer.mins.physicalNotch", 5)` and
 * its mental twin.
 *
 * It does not shut it, quite — see {@link notchChance}. Duris' own later thinking is that a cooldown
 * should make notching *harder* rather than impossible, and the comment in `guild.c` says so.
 */
export const NOTCH_COOLDOWN_MS: Readonly<Record<SkillCategory, number>> = {
  physical: 5 * 60_000,
  mental: 10 * 60_000,
};

/** How much harder notching is while the category's cooldown is up. `chance /= 4` in the source. */
export const NOTCH_COOLDOWN_DIVISOR = 4;

export const SKILL_IDS = [
  'slashing-1h',
  'piercing-1h',
  'bludgeon-1h',
  'flaying-1h',
  'slashing-2h',
  'bludgeon-2h',
  'flaying-2h',
  'reach',
  'unarmed',
  // Phase 19 slice 3. Not weapon skills: these are the two **verbs**, and they are notched by using them
  // rather than by swinging. `TAR_PHYS` like everything else here, so they share the physical cooldown.
  // Phase 19 slice 2. Notched on the **defender** — you learn these by being swung at rather than by
  // swinging, which is why they sit apart from the nine weapon skills and why `notchFromSwing` could not
  // simply be pointed at them.
  'dodge',
  'parry',
  'bash',
  'kick',
  // Phase 19 slice 4. `SKILL_CREATE("rescue", SKILL_RESCUE, TAR_PHYS)` — the first skill that is neither
  // a way to hit nor a way to avoid being hit: it moves a fight from one body to another.
  'rescue',
] as const;

export type SkillId = (typeof SKILL_IDS)[number];

export interface Skill {
  readonly id: SkillId;
  /** How it reads. The source's own name from `skills.c`, which is what a player should see. */
  readonly name: string;
  readonly category: SkillCategory;
}

/**
 * Every skill, and the list and the table are separate for the reason `AFFECT_TYPE_IDS` and
 * `AFFECT_TYPES` are: a row added to one without the other is a type error rather than a silent gap.
 *
 * Names are `skills.c`'s (`SKILL_CREATE("1h slashing", …)`), reordered only in the id so that the
 * weapon's shape reads first in a list sorted alphabetically.
 */
export const SKILLS: Readonly<Record<SkillId, Skill>> = {
  'slashing-1h': { id: 'slashing-1h', name: '1h slashing', category: 'physical' },
  'piercing-1h': { id: 'piercing-1h', name: '1h piercing', category: 'physical' },
  'bludgeon-1h': { id: 'bludgeon-1h', name: '1h bludgeon', category: 'physical' },
  'flaying-1h': { id: 'flaying-1h', name: '1h flaying', category: 'physical' },
  'slashing-2h': { id: 'slashing-2h', name: '2h slashing', category: 'physical' },
  'bludgeon-2h': { id: 'bludgeon-2h', name: '2h bludgeon', category: 'physical' },
  'flaying-2h': { id: 'flaying-2h', name: '2h flaying', category: 'physical' },
  'reach': { id: 'reach', name: 'reach weapons', category: 'physical' },
  'unarmed': { id: 'unarmed', name: 'unarmed damage', category: 'physical' },
  'dodge': { id: 'dodge', name: 'dodge', category: 'physical' },
  'parry': { id: 'parry', name: 'parry', category: 'physical' },
  'bash': { id: 'bash', name: 'bash', category: 'physical' },
  'kick': { id: 'kick', name: 'kick', category: 'physical' },
  'rescue': { id: 'rescue', name: 'rescue', category: 'physical' },
};

/** Whether a string is a skill this build knows. The load path's gate — see `players.ts`. */
export function isSkillId(value: string): value is SkillId {
  return Object.hasOwn(SKILLS, value);
}

/* -------------------------------------------------------------------------- */
/* Which skill a weapon trains                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Duris' weapon classes, `objmisc.h:362`. Only the ones the mapping distinguishes are named here.
 *
 * Note 7 and 11 — `SPIKED_MACE` and `SPIKED_CLUB` — which the source's own comments mark *"should be
 * removed"*. They fold into mace and club, which is the source tidying its own history; we inherit the
 * tidying rather than the duplicates.
 */
const WEAPON_CLASS = {
  axe: 1,
  dagger: 2,
  flail: 3,
  hammer: 4,
  longsword: 5,
  mace: 6,
  spikedMace: 7,
  polearm: 8,
  shortsword: 9,
  club: 10,
  spikedClub: 11,
  staff: 12,
  twoHandSword: 13,
  whip: 14,
  spear: 15,
  lance: 16,
  sickle: 17,
  trident: 18,
  horn: 19,
  numchucks: 20,
} as const;

/**
 * Which skill this weapon trains, or `undefined` for one that trains nothing.
 *
 * `required_weapon_skill` (`fight.c:6896`), transcribed — with **one deliberate divergence**, and it is
 * a divergence toward our own consistency rather than away from the source. Duris asks
 * `IS_SET(extra_flags, ITEM_TWOHANDS)` here, while `wield` asks Duris' *other* question,
 * `flag || class == WEAPON_2HANDSWORD` (`actobj.c`, and `objects.ts:274` transcribes it). Those
 * disagree about **22 two-handed swords that carry no flag**. We use the disjunction in both places, so
 * which hand a weapon takes and which skill it trains can never disagree — a greatsword that needed
 * both hands and trained the one-handed skill would be indefensible in a way the source's own
 * inconsistency is not.
 *
 * Two `undefined` cases, both the source's: a weapon with no class at all (6 in the catalogue), and a
 * **two-handed dagger**, which `required_weapon_skill` refuses after writing a builder-error log line.
 * There is exactly one in the world. No skill is trained and no bonus applies; the weapon still swings.
 */
export function weaponSkillFor(
  weapon: Pick<ItemTemplate, 'weaponClass' | 'twoHanded'> | undefined,
): SkillId | undefined {
  // No weapon at all is not a gap, it is a skill: `!wpn → SKILL_UNARMED_DAMAGE`.
  if (!weapon) return 'unarmed';
  const cls = weapon.weaponClass;
  if (cls === undefined) return undefined;
  const twoHanded = weapon.twoHanded === true;

  switch (cls) {
    case WEAPON_CLASS.axe:
    case WEAPON_CLASS.shortsword:
    case WEAPON_CLASS.twoHandSword:
    case WEAPON_CLASS.sickle:
    case WEAPON_CLASS.longsword:
      return twoHanded ? 'slashing-2h' : 'slashing-1h';
    case WEAPON_CLASS.dagger:
    case WEAPON_CLASS.horn:
      // The builder-error case. A two-handed dagger trains nothing, which is the source's answer.
      return twoHanded ? undefined : 'piercing-1h';
    case WEAPON_CLASS.hammer:
    case WEAPON_CLASS.club:
    case WEAPON_CLASS.spikedClub:
    case WEAPON_CLASS.mace:
    case WEAPON_CLASS.spikedMace:
    case WEAPON_CLASS.staff:
    case WEAPON_CLASS.lance:
      return twoHanded ? 'bludgeon-2h' : 'bludgeon-1h';
    case WEAPON_CLASS.whip:
    case WEAPON_CLASS.flail:
    case WEAPON_CLASS.numchucks:
      return twoHanded ? 'flaying-2h' : 'flaying-1h';
    case WEAPON_CLASS.trident:
    case WEAPON_CLASS.spear:
      return twoHanded ? 'reach' : 'piercing-1h';
    case WEAPON_CLASS.polearm:
      return twoHanded ? 'reach' : 'slashing-1h';
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* The floor, the ceiling, and what is stored                                  */
/* -------------------------------------------------------------------------- */

/** Where the level-driven floor stops climbing. `MIN(40, …)` in `update_skills`. */
export const SKILL_FLOOR_CAP = 40;

/**
 * What every skill is worth for free at this level: `MIN(40, 3 * level / 2)`.
 *
 * `update_skills` (`guild.c:63`) drags **both** the ceiling and the learned value up to this, and that
 * second half is the one that matters: a fresh level-30 character is functional without having ground
 * anything, and everything above 40% is earned. It caps at level 27 and is `1.5` a level below that.
 */
export function skillFloor(level: number): number {
  return Math.min(SKILL_FLOOR_CAP, Math.floor((3 * Math.max(0, level)) / 2));
}

/**
 * The ceiling, with no classes to ask — **Phase 21's seam, and the whole reason this is a function.**
 *
 * `taught` is `maxlearn[spec]` per class per skill in the source, and we have no classes until Phase 21.
 * One number for everyone until then, and the day the class table arrives this body changes and no
 * caller does.
 *
 * **95 rather than 100**, because Duris' teachers stop short of the ceiling: the top of a skill should
 * be somewhere the game can later put a teacher, a quest or a specialisation. A ceiling reached by
 * grinding alone leaves nothing for any of them.
 */
export const SKILL_CEILING = 95;

export function ceilingFor(_skill: SkillId): number {
  return SKILL_CEILING;
}

/**
 * What a character's skill actually is: the floor, or what they have ground past it.
 *
 * **The floor is derived rather than written**, which is the whole of why skills store sparsely — a
 * character who has never held an axe has an axe skill that is a pure function of their level, and a
 * row saying so would be a row nobody needs. A level gain therefore drags every skill up with no write
 * at all, which is `update_skills` for free.
 *
 * **One divergence, and it only shows below level 27.** Duris *writes* the floor into `learned`, so a
 * character who loses a level keeps the higher number; ours recomputes, so they drop to the new level's
 * floor. Above level 27 both are 40 and the question does not arise; below it, a death costing a level
 * costs 1.5% of every unpractised skill. That is consistent with Phase 14b — a lost level costs what a
 * level is worth — and it is the price of not writing 9 rows into every character's file at every
 * level-up.
 */
export function learnedAt(stored: number | undefined, level: number, skill: SkillId): number {
  return Math.min(ceilingFor(skill), Math.max(skillFloor(level), stored ?? 0));
}

/* -------------------------------------------------------------------------- */
/* Notching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The base chance on a landing blow, as a **percentage**, and it folds two of the source's rolls into
 * one number.
 *
 * `new_combat.c:2070` gates the weapon-skill notch behind `!number(0, 4)` — one swing in five — and
 * then calls `notch_skill(ch, wpn_skill_num, 33.33)`. Independent probabilities multiply, so one roll
 * at `33.33 / 5` has exactly the distribution of two rolls and costs the determinism budget one draw
 * per swing instead of two. 6.666% of landing blows, before the curve below.
 */
export const WEAPON_NOTCH_CHANCE = 33.33 / 5;

/**
 * The base chance when you *use* a skill rather than swing with it.
 *
 * `get_property("skill.notch.offensive", 7)` — the number `do_kick`, `do_hitall` and `do_bash` all pass to
 * `notch_skill`. Ungated, unlike the weapon notch: using a verb deliberately is already rarer than landing
 * a blow, so the source does not thin it further.
 */
export const OFFENSIVE_NOTCH_CHANCE = 7;

/**
 * The base chance for a rescue's notch — `get_property("skill.notch.rescue", 10)`, its own rate and a
 * point and a half above the offensive verbs'.
 *
 * **The roll's position is the interesting part, and it must not be tidied to match bash and kick.**
 * Their shape is `!notch_skill(…) && miss` — a successful notch forces the blow to land. `rescue()`'s
 * is `notch_skill(…) || roll > skill` — a successful notch forces the attempt to *fail*, and the `||`
 * short-circuits, so the success roll is never made on a notching attempt. The moment you learn
 * something about rescuing is a moment you fumble one; the consolation runs the other way round.
 */
export const RESCUE_NOTCH_CHANCE = 10;

/**
 * The chance this notch attempt succeeds, as a percentage — **the compiled-out branch, on purpose.**
 *
 * `notch_skill`'s interesting half is `guild.c:183–233`, which is `#if wipe2011`, and `wipe2011` is
 * defined **nowhere**: as shipped, the two rules below are absent and the cooldown affect the function
 * writes has no reader in the entire source. `DESIGN-skills.md` §2 measures why that matters — at
 * {@link WEAPON_NOTCH_CHANCE} and a 3 s round, an ungoverned grind takes a skill 0 → 100 in about 25
 * minutes, and a number you can max in one sitting is decorative.
 *
 * So both rules are ours-by-adoption, and each carries the source's own reasoning:
 *
 * - **`(1 − learned / ceiling)`.** The last ten points cost more than the first fifty, so the ceiling is
 *   approached rather than arrived at.
 * - **`/ 4` while the category's cooldown is up**, not a refusal. The comment says it: *"Instead of
 *   simply not allowing notches, we just make it harder."* A player who keeps fighting is slowed, not
 *   stopped, which is the difference between a rate limit and a punishment.
 */
export function notchChance(
  base: number,
  learned: number,
  ceiling: number,
  options: { readonly onCooldown: boolean },
): number {
  if (learned >= ceiling) return 0;
  const curved = base * (1 - learned / ceiling);
  return options.onCooldown ? curved / NOTCH_COOLDOWN_DIVISOR : curved;
}

/**
 * Rolls a notch. `number(1, 10000) > chance * 100` fails, so a percentage resolves to two decimals.
 *
 * Through the seeded {@link Rng} like every other roll in the simulation — a skill that rose because
 * `Math.random()` said so would make a fight unreplayable, which is the rule in `CLAUDE.md` §3.
 */
export function rollNotch(rng: Rng, chance: number): boolean {
  if (chance <= 0) return false;
  return randomInt(rng, 1, 10_000) <= Math.round(chance * 100);
}

/* -------------------------------------------------------------------------- */
/* What a skill is worth                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What a weapon skill adds to the attack bonus: **`floor(learned / 10)`, +0 to +9.**
 *
 * Derived, not chosen. `getChartoHitSkillMod(wpn_skl_lvl) { return wpn_skl_lvl >> 1; }` — half the
 * percentage, added to a to-hit total that is rolled against `number(1, 100)`. Ours is `d20 + bonus`
 * against AC, so:
 *
 * ```
 * half of 0..95 on a 100-point scale = 0..47 points of 100
 * 0..47 of 100 scaled to a d20       = 0..9   →  floor(learned / 10)
 * ```
 *
 * The floor is what keeps it tame: everyone at level 27+ has 40% for free, which is `+4` that costs
 * nothing, so the **earned** spread between a novice and a master of the same level is at most `+5` —
 * the size of the SRD proficiency bonus it resembles. Below level 6 the floor is under 10 and the bonus
 * is `+0` or `+1`, which leaves Phase 14b's calibration of that band alone.
 */
export function toHitFrom(learned: number): number {
  return Math.floor(learned / 10);
}

/**
 * A mob's weapon skill: **`min(100, floor(level × 1.75))`**, and it stores nothing.
 *
 * `getNPCweaponSkillLevel` (`new_combat_util.c:905`) scales by class — `× 2.0` for warriors down to
 * `× 1.2` for mages — and **`CLASS_NONE` is `× 1.75`**, which is what every mob in our world is until
 * Phase 21. A pure function of level, so a mob carries zero bytes for it, exactly as §1.6 says.
 *
 * Not the `level << 1` our own reference doc used to quote: that is `fight.c`'s, in the branch the
 * shipped source does not compile. The difference is real — a level-30 mob is 52%, not 60%.
 */
export function mobWeaponSkill(level: number): number {
  return Math.min(100, Math.floor(Math.max(1, level) * 1.75));
}
