/**
 * Worn equipment, and the kit a character starts with.
 *
 * Owner-requested with Phase 14b: *"give new players some basic equipment… something with a tiny AC
 * boost so not every level 1 is a cookie-cutter version of every other one."* It belongs here rather
 * than in Phase 15 because **variance at level 1 is a progression question, not an inventory
 * question** — two characters who roll differently have different first hours, and that is the
 * difference between a starting band and a starting number.
 *
 * ## What this is not
 *
 * Not inventory. There is no picking up, dropping, container, capacity or trade here, and no item
 * that is not the kit you were created with — all of that is Phase 15, and
 * `DESIGN-inventory.md` already specifies it. This module knows what a leather tunic *is* and what
 * wearing one does. Who has one and how they got it is the server's, and today the answer is always
 * "they started with it".
 *
 * ## Armour class is expressed the SRD way here, and that is deliberate
 *
 * `armourToAc` exists to convert **Duris' armour scale**, where *lower is better* and a well-armoured
 * mob carries −122. That conversion is needed because those numbers were harvested. These items were
 * not harvested — they are authored by us, in the SRD's own terms — so they carry a straight AC bonus
 * and need no conversion at all. Routing authored gear through a scale built to translate foreign
 * data would be a round trip for nothing, and one sign error from making armour hurt.
 *
 * Slots are `DESIGN-inventory.md` §6's exactly, because that document already settled them and they
 * map onto LPC's layered sprites — which is what makes worn gear *visible on the character*.
 */

import type { Dice, Rng } from './rules.ts';

export const EQUIP_SLOTS = [
  'head',
  'neck',
  'back',
  'chest',
  'hands',
  'mainHand',
  'offHand',
  'legs',
  'feet',
  'ring1',
  'ring2',
] as const;

export type EquipSlot = (typeof EQUIP_SLOTS)[number];

export interface Item {
  /** Stable id, so a stored kit survives a rename of the display name. */
  readonly id: string;
  readonly name: string;
  /**
   * Where it may be worn, or **absent for something that can only be carried**.
   *
   * Optional since 15c, and the harvest is why: of the 20,079 objects in the catalogue, keys, trash,
   * food, coins and treasure are the majority and none of them go anywhere on a body. Before this they
   * would have needed a slot invented for them, and any resting value picked — `back`, say — would have
   * made every key in the world wearable on your back.
   */
  readonly slot?: EquipSlot;
  /**
   * Added to armour class. Higher is harder to hit — the SRD's direction, not Duris'.
   *
   * Rolled per item within its own band, which is what makes two fresh characters different. A
   * lucky one starts several points harder to hit than an unlucky one, and both are viable.
   */
  readonly ac: number;
  /** What it hits for, on a weapon. Absent on everything worn rather than wielded. */
  readonly damage?: Dice;
  /**
   * Slots this costs in a bag. Phase 15b, and `DESIGN-inventory.md` §2 is the spec.
   *
   * **A bulk model wearing a slot model's clothes**, deliberately: a breastplate costing ten of your
   * twenty makes armour a real logistical decision without asking anybody to add up pounds. Worn and
   * wielded gear costs nothing — §6 — so this is only ever charged against what is in the bag.
   */
  readonly size: number;
}

/** A character's worn gear. Absent slots are empty — most of them, for a starting character. */
export type Equipped = Partial<Record<EquipSlot, Item>>;

/**
 * One entry a starter kit can roll.
 *
 * `acMin`/`acMax` is the band, inclusive. The *choice* of item varies as well as its quality, so two
 * characters differ in what they are wearing and not only in how good it is — a rough spread of kit
 * reads as a person who scraped together what they could, which is the fiction anyway.
 */
interface StarterEntry {
  readonly id: string;
  readonly name: string;
  readonly acMin: number;
  readonly acMax: number;
  readonly damage?: Dice;
  /** Slots in a bag. Light kit, so 1–3 of a starting 20 — see `DESIGN-inventory.md` §2. */
  readonly size: number;
}

/**
 * What a new character might be wearing, by slot.
 *
 * Modest on purpose. The totals land between roughly **+2 and +9 armour class**, so an unlucky
 * character sits near AC 12 and a lucky one near AC 19 — against the level 1–5 band's attack bonus of
 * 0, that is the difference between being hit about 45% of the time and about 30%. A real gap that
 * neither trivialises the starter zone nor makes it unplayable.
 *
 * Weapons vary in **damage die** rather than armour: a dagger is quick and light, a club is heavier.
 * The spread is small because a level-1 weapon should not decide the first ten levels.
 *
 * **Their magnitude is Duris', not the SRD's, and that was learned the hard way.** The first version
 * used SRD dice — a 1d6 short sword — against mobs whose hit points are on the MUD scale, and a
 * level-1 character dealt about 2 damage a round to a 35-hit-point kobold. They survived it
 * comfortably and could never finish it: the kobold hit its morale threshold and fled, over and over.
 * Fixing hit points without fixing damage had corrected one half of the same collision. These sit
 * where a same-level fight lasts six to eight rounds, which is what `DESIGN-progression.md` §2 asks
 * for and what the flee threshold assumes.
 */
const STARTER_KIT: Readonly<Partial<Record<EquipSlot, readonly StarterEntry[]>>> = {
  mainHand: [
    { id: 'dagger', name: 'a notched iron dagger', acMin: 0, acMax: 1, size: 1, damage: { count: 2, sides: 4, bonus: 0 } },
    { id: 'shortsword', name: 'a short sword with a worn grip', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 0 } },
    { id: 'club', name: 'a knotted wooden club', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 6, bonus: 0 } },
    { id: 'handaxe', name: 'a chipped hand axe', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 2 } },
  ],
  chest: [
    { id: 'leather_tunic', name: 'a leather tunic', acMin: 1, acMax: 3, size: 3 },
    { id: 'padded_jerkin', name: 'a padded jerkin', acMin: 1, acMax: 3, size: 3 },
    { id: 'quilted_vest', name: 'a quilted vest, much mended', acMin: 1, acMax: 2, size: 2 },
  ],
  legs: [
    { id: 'leather_leggings', name: 'a pair of leather leggings', acMin: 0, acMax: 2, size: 2 },
    { id: 'rough_breeches', name: 'rough woollen breeches', acMin: 0, acMax: 1, size: 2 },
  ],
  feet: [
    { id: 'worn_shoes', name: 'a pair of worn-out leather shoes', acMin: 0, acMax: 1, size: 1 },
    { id: 'travel_boots', name: 'scuffed travelling boots', acMin: 0, acMax: 2, size: 2 },
  ],
  head: [
    { id: 'leather_cap', name: 'a plain leather cap', acMin: 0, acMax: 1, size: 1 },
    { id: 'cloth_hood', name: 'a patched cloth hood', acMin: 0, acMax: 1, size: 1 },
  ],
  hands: [
    { id: 'hand_wraps', name: 'a set of frayed hand wraps', acMin: 0, acMax: 1, size: 1 },
    { id: 'work_gloves', name: 'a pair of stiff work gloves', acMin: 0, acMax: 1, size: 1 },
  ],
};

/** Inclusive integer in `[min, max]`, through the seeded rng. */
function between(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Rolls the kit a character is created with.
 *
 * **Seeded, and rolled exactly once.** `CLAUDE.md` rule 3 forbids `Math.random()` in simulation code
 * and character creation is simulation; storing the result is what stops a player rerolling their kit
 * by reconnecting until they like it. The same reason hit points are stored rather than derived.
 *
 * Every slot in {@link STARTER_KIT} is filled — a new character is dressed, not naked with one shoe.
 * The variance is in *which* item and *how good*, not in whether you got one.
 */
export function rollStarterKit(rng: Rng): Equipped {
  const kit: Equipped = {};
  for (const slot of EQUIP_SLOTS) {
    const choices = STARTER_KIT[slot];
    if (!choices || choices.length === 0) continue;
    const pick = choices[Math.floor(rng() * choices.length)]!;
    kit[slot] = {
      id: pick.id,
      name: pick.name,
      slot,
      ac: between(rng, pick.acMin, pick.acMax),
      size: pick.size,
      ...(pick.damage ? { damage: pick.damage } : {}),
    };
  }
  return kit;
}

/**
 * The kit reduced to **slot → item id**, which is all the wire needs.
 *
 * Names, armour values and damage dice are the *character sheet's* business and stay off the entity
 * feed: a stranger's tunic has to be drawn, not appraised, and shipping its armour class would tell
 * every onlooker exactly how hard the wearer is to hit. See `EntityView.wearing`.
 */
export function wornIds(equipped: Equipped): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of EQUIP_SLOTS) {
    const item = equipped[slot];
    if (item) out[slot] = item.id;
  }
  return out;
}

/** Every point of armour class the worn kit is worth. */
export function armourClassFrom(equipped: Equipped): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) total += equipped[slot]?.ac ?? 0;
  return total;
}

/**
 * What this character swings.
 *
 * The main hand if it holds something with damage on it; otherwise the caller's fallback, which is
 * still `DEFAULT_WEAPON` — a character can be disarmed of a concept we do not have yet, and an
 * unarmed character must still be able to fight.
 */
export function weaponFrom(equipped: Equipped, fallback: Dice): Dice {
  return equipped.mainHand?.damage ?? fallback;
}

const SLOT_SET = new Set<string>(EQUIP_SLOTS);

/**
 * Rebuilds one item from whatever was on disk, or `undefined` if it is not a well-formed one.
 *
 * `slot` is supplied by {@link readEquipped}, which knows it from the key it is reading; a **carried**
 * item has no such key, so it carries its own `slot` field and this validates it against
 * {@link EQUIP_SLOTS}. That check is not ceremony — these files are hand-editable, and an item whose
 * slot is `"belt"` would sit in a bag being un-wearable for reasons nothing could explain.
 */
export function readItem(raw: unknown, slot?: EquipSlot): Item | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string' || typeof item.ac !== 'number') return undefined;
  // A missing slot is a carry-only item, not a malformed one. An *unrecognised* slot is still refused:
  // these files are hand-editable and `"belt"` would sit in a bag being unwearable for reasons nothing
  // could explain, which is worse than being plainly unwearable.
  const where = slot ?? (typeof item.slot === 'string' ? (item.slot as EquipSlot) : undefined);
  if (where !== undefined && !SLOT_SET.has(where)) return undefined;
  const damage = item.damage as Dice | undefined;
  return {
    id: item.id,
    name: item.name,
    ...(where === undefined ? {} : { slot: where }),
    ac: item.ac,
    // Absent on a kit written before Phase 15b gave items a bulk. One slot is the right guess for
    // a starter garment and keeps a pre-15b character's bag arithmetic from going NaN.
    size: typeof item.size === 'number' && item.size > 0 ? item.size : 1,
    ...(damage && typeof damage.count === 'number' && typeof damage.sides === 'number'
      ? { damage: { count: damage.count, sides: damage.sides, bonus: damage.bonus ?? 0 } }
      : {}),
  };
}

/** Rebuilds a kit from whatever was on disk, dropping anything that is not a well-formed item. */
export function readEquipped(raw: unknown): Equipped {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Equipped = {};
  for (const slot of EQUIP_SLOTS) {
    const item = readItem((raw as Record<string, unknown>)[slot], slot);
    if (item) out[slot] = item;
  }
  return out;
}
