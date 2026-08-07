/**
 * What a blow is called — **V7**, and it is a transcription rather than a decision.
 *
 * Owner, 2026-08-06: *"if I swing an axe or a sword it should say You slash the mob for 200 damage; if it
 * was a club it should be bludgeon."* Diku has had exactly that table since the beginning and Duris keeps
 * it: `attack_hit_text[]` (`fight.c:132`), eleven types with a second-person, third-person and past form
 * each. Nothing here is invented; the interesting part is which of two mappings picks a row.
 *
 * ## No protocol change, and that is why this is a V item
 *
 * The combat line is already rendered **per recipient** on the server (`announceAttack`), so a verb is a
 * different word in a sentence that already exists. `ROADMAP.md` §2b's test for a Track V slice is
 * *"presentation of what already exists: at most an additive message field, no new rules"* — this needs
 * not even that.
 *
 * ## Two mappings, and merging them would silently break one
 *
 * A **weapon's** verb comes from `get_weapon_msg` (`objmisc.c:63`), which switches on `value[0]` — the
 * `weaponClass` Phase 19 harvested for the skill mapping hours before this was asked for. So the data was
 * already there.
 *
 * **It is not the same grouping as the skill mapping**, and that is worth stating because the two look
 * alike enough to be "tidied" into one:
 *
 * | Weapon | Skill (`weaponSkillFor`) | Verb (`attackTypeForWeapon`) |
 * | --- | --- | --- |
 * | hammer, flail, club, lance | `bludgeon-1h` | **crush** |
 * | mace, staff, numchucks | `bludgeon-1h` | **bludgeon** |
 * | polearm, two-handed | `reach` | **slash** |
 *
 * Both are the source's own. One says what you get better at; the other says what the blow looks like.
 *
 * An **unarmed body's** verb comes from `GetFormType` (`mobconv.c:528`), which switches on the creature's
 * **race** — so a spider stings and a troll mauls, and neither is a field anybody authored. Measured over
 * every `.mob` record in the world, the races we can currently draw a body for split three ways: 5,808
 * humanoids **punch**, 634 ogres and trolls **maul**, and 514 giants **crush**. The other seven verbs are
 * reachable only by creatures the LPC set has no body for, which `spriteFor` refuses to spawn — so they
 * are transcribed and waiting rather than dead: the day there is creature art, a wolf bites without
 * anybody revisiting combat prose.
 */

/**
 * The eleven types, with the id being Duris' own `MSG_*` name lowercased.
 *
 * `punch` is `MSG_HIT`'s verb rather than "hit", which is the source's own choice and a better one: *"you
 * hit the kobold"* says nothing about how, and every other row in the table is specific.
 */
export const ATTACK_TYPE_IDS = [
  'hit',
  'bludgeon',
  'pierce',
  'slash',
  'whip',
  'claw',
  'bite',
  'sting',
  'crush',
  'maul',
  'thrash',
] as const;

export type AttackType = (typeof ATTACK_TYPE_IDS)[number];

export interface AttackVerb {
  /** What *you* do: "you **slash** the kobold". */
  readonly second: string;
  /** What somebody else does: "Brynn **slashes** the kobold". */
  readonly third: string;
  /** For a sentence about a blow already landed. Unused today; it is the table's third column. */
  readonly past: string;
}

/**
 * `attack_hit_text[]`, verbatim.
 *
 * The list and the table are separate for the reason `AFFECT_TYPE_IDS` and `SKILL_IDS` are: a row added
 * to one and not the other is a type error rather than a silent gap.
 */
export const ATTACK_VERBS: Readonly<Record<AttackType, AttackVerb>> = {
  hit: { second: 'punch', third: 'punches', past: 'punched' },
  bludgeon: { second: 'bludgeon', third: 'bludgeons', past: 'bludgeoned' },
  pierce: { second: 'pierce', third: 'pierces', past: 'pierced' },
  slash: { second: 'slash', third: 'slashes', past: 'slashed' },
  whip: { second: 'whip', third: 'whips', past: 'whipped' },
  claw: { second: 'claw', third: 'claws', past: 'clawed' },
  bite: { second: 'bite', third: 'bites', past: 'bitten' },
  sting: { second: 'sting', third: 'stings', past: 'stung' },
  crush: { second: 'crush', third: 'crushes', past: 'crushed' },
  maul: { second: 'maul', third: 'mauls', past: 'mauled' },
  thrash: { second: 'thrash', third: 'thrashes', past: 'thrashed' },
};

/**
 * Which of the two staged swing motions each attack type plays — protocol 22, the animations slice.
 *
 * LPC ships exactly two melee motions (an overhead arc and a straight lunge), so eleven verbs fold
 * onto two: **pierce, sting and bite lunge; everything else swings.** Beside {@link ATTACK_VERBS}
 * for the reason the verb table itself is a `Record` — a type added to one and not the other is a
 * type error, not a silently un-animated blow.
 */
export const SWING_ANIMATION: Readonly<Record<AttackType, 'slash' | 'thrust'>> = {
  hit: 'slash',
  bludgeon: 'slash',
  pierce: 'thrust',
  slash: 'slash',
  whip: 'slash',
  claw: 'slash',
  bite: 'thrust',
  sting: 'thrust',
  crush: 'slash',
  maul: 'slash',
  thrash: 'slash',
};

/** Duris' weapon classes, `objmisc.h:362`. The same ladder `skills.ts` reads, named again locally. */
export const WEAPON_CLASS = {
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
 * The ladder as a picker reads it — owner's ask (2026-08-07, on finding Windsong *punching*):
 * *"we need to set attack type to slash, bludgeon etc with a dropdown."* The dropdown picks a
 * **class**, not a verb, because the class decides three things at once — the verb
 * ({@link attackTypeForWeapon}), the skill a swing trains (`weaponSkillFor`), and which animation
 * plays (`SWING_ANIMATION`) — and letting an author pick a verb that disagreed with the trained
 * skill would be two vocabularies for one fact. No scimitar in Duris' twenty: a scimitar is the
 * longsword family, which is exactly the row Windsong wears now.
 */
export const WEAPON_CLASS_CHOICES: readonly { readonly value: number; readonly label: string }[] = Object.entries(
  WEAPON_CLASS,
).map(([name, value]) => ({
  value,
  label: `${name.replace(/([A-Z])/g, ' $1').toLowerCase()} — ${ATTACK_VERBS[attackTypeForWeapon(value)].third}`,
}));

/**
 * What a weapon's blow is called — `get_weapon_msg`, transcribed.
 *
 * **Note what it does not read: the two-handed flag.** The skill mapping needs it (a greatsword trains a
 * different skill from a shortsword) and this does not — a two-handed sword still slashes. Transcribed
 * that way rather than tidied into one function for exactly that reason.
 *
 * Falls back to `hit` for a weapon with no class and for anything that is not a weapon, which is the
 * source's `default`. Bare hands land here too, and the caller does not need a branch: `undefined` is a
 * character punching.
 */
export function attackTypeForWeapon(weaponClass: number | undefined): AttackType {
  switch (weaponClass) {
    case WEAPON_CLASS.axe:
    case WEAPON_CLASS.shortsword:
    case WEAPON_CLASS.twoHandSword:
    case WEAPON_CLASS.sickle:
    case WEAPON_CLASS.polearm:
    case WEAPON_CLASS.longsword:
      return 'slash';
    case WEAPON_CLASS.dagger:
    case WEAPON_CLASS.spear:
    case WEAPON_CLASS.trident:
    case WEAPON_CLASS.horn:
      return 'pierce';
    case WEAPON_CLASS.hammer:
    case WEAPON_CLASS.flail:
    case WEAPON_CLASS.club:
    case WEAPON_CLASS.spikedClub:
    case WEAPON_CLASS.lance:
      return 'crush';
    case WEAPON_CLASS.mace:
    case WEAPON_CLASS.spikedMace:
    case WEAPON_CLASS.staff:
    case WEAPON_CLASS.numchucks:
      return 'bludgeon';
    case WEAPON_CLASS.whip:
      return 'whip';
    default:
      return 'hit';
  }
}

/**
 * What an unarmed body's blow is called, from its **race code** — `GetFormType`, transcribed.
 *
 * The codes are the fourth column of `race_names_table` in `common.c`, which is the same short string
 * `worldgen/src/mobs.ts` reads to choose a sprite. Only the races that reach the table are listed; the
 * source's own `default` is `MSG_HIT`, so anything unrecognised punches, and a player character (which has
 * no race until Phase 21) does too.
 *
 * Every group here is one `case` block in the source. Kept whole rather than reduced to the codes we can
 * currently draw, because the reduction is `spriteFor`'s job and it changes the day there is creature art —
 * at which point this needs no edit.
 */
const RACE_ATTACK: Readonly<Record<string, AttackType>> = {
  // MSG_WHIP — the illithid's tentacles.
  PI: 'whip',
  // MSG_MAUL — ogres, trolls, golems, primates, storm giants, firbolgs, snow ogres.
  PO: 'maul',
  PT: 'maul',
  OG: 'maul',
  TR: 'maul',
  GO: 'maul',
  PR: 'maul',
  SG: 'maul',
  FI: 'maul',
  SO: 'maul',
  // MSG_CRUSH — elementals, efreet, demons, giants, devils, plants, constructs.
  G: 'crush',
  GI: 'crush',
  FE: 'crush',
  AE: 'crush',
  WE: 'crush',
  EE: 'crush',
  EF: 'crush',
  DE: 'crush',
  DV: 'crush',
  PT2: 'crush',
  CO: 'crush',
  // MSG_CLAW — lycanthropes, dragons, dracoliches, dragonkin, reptiles, skeletons, zombies, revenants,
  // spectres.
  LY: 'claw',
  DR: 'claw',
  DL: 'claw',
  DK: 'claw',
  RE: 'claw',
  SK: 'claw',
  ZO: 'claw',
  RV: 'claw',
  SP: 'claw',
  // MSG_THRASH — quadrupeds, which is where the hooves come in.
  QU: 'thrash',
  // MSG_BITE — snakes, carnivores, parasites, animals, beholders, worms.
  SN: 'bite',
  CA: 'bite',
  PA: 'bite',
  AN: 'bite',
  BE: 'bite',
  PW: 'bite',
  // MSG_STING — insects and arachnids.
  IN: 'sting',
  AR: 'sting',
};

export function attackTypeForRace(raceCode: string | undefined): AttackType {
  if (!raceCode) return 'hit';
  return RACE_ATTACK[raceCode.toUpperCase()] ?? 'hit';
}
