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

/**
 * Every place a humanoid can wear something — Phase 16, and it is Duris' own list.
 *
 * 15a modelled eleven, which covered 87% of the world's `E` commands and dropped the rest into the
 * mob's hands as loot. Owner's call (2026-08-04): *"we should add all the slots… items like eyepatches
 * are rare but they should be usable when found by a player."* Measured, the thirteen added here
 * recover **233 of the 315 lost placements**, and the biggest single one is the waist at 94.
 *
 * **Paired slots mirror Duris' paired positions**, which is why there are two of several: the source
 * has `WEAR_FINGER_R`/`_L`, `WEAR_NECK_1`/`_2`, `WEAR_WRIST_R`/`_L` and `WEAR_EARRING_R`/`_L`, and one
 * `ITEM_WEAR_*` bit each — the bit says *what kind of place*, the position says *which one*.
 *
 * **What is deliberately still missing**, and it is not an oversight in either case:
 *
 * - `WEAR_TAIL`, `WEAR_HORN`, and the four-arm positions (`ARMS_2`, `HANDS_2`, `WRIST_LR`, `WRIST_LL`)
 *   need a body that has them. They land with races — Phase 21 — because a slot no character can ever
 *   fill is the tested-and-never-called mechanism this project keeps warning itself about.
 * - `WEAR_HORSE_BODY` and `WEAR_LEGS_REAR` are barding, and want mounts.
 * - `WEAR_ATTACH_BELT_1..3` has **no `ITEM_WEAR` bit at all**, so no item can declare itself belt-
 *   attachable; only an `E` command can place one, and the whole world does it twice. It is a
 *   container-on-a-belt mechanic rather than a wear slot, and it waits for a reason to exist.
 */
export const EQUIP_SLOTS = [
  'head',
  'eyes',
  'face',
  'nose',
  'ear1',
  'ear2',
  'neck',
  'neck2',
  'back',
  'about',
  'chest',
  'arms',
  'wrist1',
  'wrist2',
  'hands',
  'mainHand',
  'offHand',
  'waist',
  'legs',
  'feet',
  'ring1',
  'ring2',
  'quiver',
  'ioun',
] as const;

export type EquipSlot = (typeof EQUIP_SLOTS)[number];

/**
 * The slots that come in pairs, first name to second — **a ring goes on any finger** (owner's
 * design, 2026-08-07: *"picks the first free slot and wears it there"*, the paired-slot cousin of
 * dual-wieldable weapons). An item's data names only the pair's first slot; when that one is taken
 * and its twin is bare, the twin is where the item goes, and displacement begins only when both
 * are full — which is what wearing two rings has always meant. Ears and wrists are the same shape:
 * nobody authors an earring for the *left* ear specifically.
 */
export const PAIRED_SLOTS: Readonly<Partial<Record<EquipSlot, EquipSlot>>> = {
  ring1: 'ring2',
  ear1: 'ear2',
  wrist1: 'wrist2',
  neck: 'neck2',
};

/**
 * Where a wear actually lands: the named slot, unless it is the first of a pair that is already
 * taken while its twin sits bare — then the twin. Displacement is downstream's business and starts
 * only when this returns an occupied slot, which for a pair means both are full.
 */
export function resolveWearSlot(named: EquipSlot, equipped: Equipped): EquipSlot {
  const twin = PAIRED_SLOTS[named];
  return twin && equipped[named] && !equipped[twin] ? twin : named;
}

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
   * Needs **both hands**, so nothing may occupy the off hand while it is held. `wield` enforces it.
   *
   * On the item rather than looked up per swing, because the rule has to survive a restart and a
   * catalogue edit: the greatsword in your save file is the greatsword you wielded.
   */
  readonly twoHanded?: true;
  /**
   * Duris' weapon class, which decides **which skill swinging this trains** — Phase 19.
   *
   * On the item for the reason `twoHanded` is, and the argument is the same sentence with a different
   * noun: the greatsword in your save file has to still train the two-handed slashing skill after a
   * restart, and an **authored** item (A6b) has no catalogue entry to look it up in at all.
   */
  readonly weaponClass?: number;
  /**
   * What this thing is worth as a light — radius in tiles, and the burn in milliseconds if it has one.
   *
   * **On the item since 2026-08-06, and it is what makes light cost nothing.** Owner's rule: *"light
   * should come with no space, weight or slot cost"*, so a light lights you from wherever it is — a hand,
   * a hat, or the bottom of your bag — and the bag does not charge bulk for it. Both of those need to be
   * answerable *locally*: `stackSlots` is pure arithmetic in `shared` and cannot be handed a catalogue
   * resolver, and `syncLight` has to look at the bag rather than at two slots.
   *
   * The same argument `twoHanded` and `weaponClass` make, one noun over: a lantern in a save file has to
   * still be a lantern after a restart, and an **authored** item (A6b, and A6c's light editor) has no
   * catalogue entry to look one up in.
   */
  readonly light?: { readonly radius: number; readonly durationMs?: number };
  /** What wearing it adds to accuracy and to damage — Duris' `APPLY_HITROLL` / `APPLY_DAMROLL`. */
  readonly hitroll?: number;
  readonly damroll?: number;
  /**
   * Slots this costs in a bag. Phase 15b, and `DESIGN-inventory.md` §2 is the spec.
   *
   * **A bulk model wearing a slot model's clothes**, deliberately: a breastplate costing ten of your
   * twenty makes armour a real logistical decision without asking anybody to add up pounds. Worn and
   * wielded gear costs nothing — §6 — so this is only ever charged against what is in the bag.
   */
  readonly size: number;
  /**
   * How many of this share one slot, and how many charges one of them carries. §3, and both are
   * **copied from the catalogue entry rather than looked up** — the same treatment `ac`, `size` and
   * `damage` already get.
   *
   * That denormalisation is deliberate. The alternative is threading a `(item) => limit` lookup
   * through `carry`, `slotsUsed`, `fits` and every caller of them, so that a bag could not answer
   * "does this fit" without being handed the catalogue. An item that knows its own bulk should know
   * its own stacking too.
   *
   * Absent means "does not stack" and "no charges", which is what a sword is.
   */
  readonly stackLimit?: number;
  readonly uses?: number;
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
  /**
   * Duris' weapon class, so a starting weapon **trains a skill from the first swing** — Phase 19.
   *
   * Not decoration: without it a fresh character's whole first level would train nothing, because
   * `weaponSkillFor` reads this and a synthesised item has no `.obj` file to read it from. Each of the
   * four is already *named* after one of Duris' classes, so there is nothing to invent.
   */
  readonly weaponClass?: number;
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
    { id: 'dagger', name: 'a notched iron dagger', acMin: 0, acMax: 1, size: 1, damage: { count: 2, sides: 4, bonus: 0 }, weaponClass: 2 },
    { id: 'shortsword', name: 'a short sword with a worn grip', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 9 },
    { id: 'club', name: 'a knotted wooden club', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 6, bonus: 0 }, weaponClass: 10 },
    { id: 'handaxe', name: 'a chipped hand axe', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 2 }, weaponClass: 1 },
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
      // Phase 19: which skill this trains. Two of the four rolls are `piercing-1h` and `slashing-1h`,
      // and the club and the axe put a character on `bludgeon-1h` and `slashing-1h` — so a starting
      // character's first weapon already decides what their first level teaches them.
      ...(pick.weaponClass === undefined ? {} : { weaponClass: pick.weaponClass }),
    };
  }
  return kit;
}

/**
 * The kit reduced to **slot → art class**, which is all the wire needs.
 *
 * Names, armour values and damage dice are the *character sheet's* business and stay off the entity
 * feed: a stranger's tunic has to be drawn, not appraised, and shipping its armour class would tell
 * every onlooker exactly how hard the wearer is to hit. See `EntityView.wearing`.
 *
 * **Protocol 14 changed what the value means, and the change is smaller than it looks.** It used to be
 * the item's id, on 15a's rule that ids keep art direction off the wire. That rule holds for the
 * authored starter kit, where an id names exactly one thing and therefore *is* its own class — a
 * `leather_tunic` goes out as `leather_tunic`, unchanged. It could never hold for harvested gear: the
 * catalogue has 419 shields, and `obj:32` tells a client nothing about what to draw.
 *
 * `classOf` is injected rather than looked up here, the same shape `reset.ts` uses for its census —
 * this module has no business holding the catalogue. Anything it cannot classify keeps its id, which
 * means a slot with no art simply does not draw.
 */
export function wornIds(equipped: Equipped, classOf: (item: Item) => string | undefined = () => undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of EQUIP_SLOTS) {
    const item = equipped[slot];
    if (item) out[slot] = classOf(item) ?? item.id;
  }
  return out;
}

/**
 * The bulk of everything a character is wearing and wielding.
 *
 * **Worn gear costs no bag capacity and still weighs on you**, and those are two different questions
 * that `DESIGN-inventory.md` §6 only answers the first of. §6's rule is about *storage*: a character
 * in thirty slots of plate still has an empty bag, because what you have on is not luggage. It says
 * nothing about *effort*, and Phase 16's whole completion test is that heavy armour slows you across
 * a swamp — which it cannot do if a breastplate is weightless the moment you put it on.
 *
 * So this feeds encumbrance and nothing else. Nowhere does it reduce what you can carry.
 */
export function wornBulk(equipped: Equipped): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) total += equipped[slot]?.size ?? 0;
  return total;
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

/**
 * What the whole kit adds to a swing, and to landing one.
 *
 * **Summed over every slot, not just the weapon** — that is what `APPLY_DAMROLL` means in the source,
 * and it is why a ring is worth wearing. Kept separate from {@link weaponFrom} because the dice come
 * from one hand and these come from the body.
 */
export function damrollFrom(equipped: Equipped): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) total += equipped[slot]?.damroll ?? 0;
  return total;
}

export function hitrollFrom(equipped: Equipped): number {
  let total = 0;
  for (const slot of EQUIP_SLOTS) total += equipped[slot]?.hitroll ?? 0;
  return total;
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
    // **Read back, or a saved stack silently unstacks.** Caught by a test: without these, twenty
    // arrows written to disk return as twenty items that each want their own slot, and a bag that
    // fitted yesterday refuses to load today. Absent means "does not stack" and "no charges", which
    // is every item written before 15c and every sword written since.
    ...(typeof item.stackLimit === 'number' && item.stackLimit > 1 ? { stackLimit: item.stackLimit } : {}),
    ...(typeof item.uses === 'number' && item.uses > 0 ? { uses: item.uses } : {}),
    // Same rule as those two: a persisted field with no line here is deleted on the next login, and a
    // greatsword that quietly became one-handed over a restart would let a shield in beside it.
    ...(item.twoHanded === true ? { twoHanded: true as const } : {}),
    // Phase 19, and the same rule again: without this line a sword reloaded from disk would train no
    // skill and lose its to-hit bonus, silently, and only for characters who had logged out.
    ...(typeof item.weaponClass === 'number' && item.weaponClass > 0 ? { weaponClass: item.weaponClass } : {}),
    // Read back, or a lantern in a save file comes home as a stick. The radius is required and the burn
    // is not: an unlimited light simply has none, which is 32 of the catalogue's 64.
    ...(typeof (item.light as { radius?: unknown } | undefined)?.radius === 'number'
      ? {
          light: {
            radius: (item.light as { radius: number }).radius,
            ...(typeof (item.light as { durationMs?: unknown }).durationMs === 'number'
              ? { durationMs: (item.light as { durationMs: number }).durationMs }
              : {}),
          },
        }
      : {}),
    // Read back for the reason `stackLimit` is: a persisted field with no line here is deleted at the
    // next login, and a sword that quietly lost its damroll would be a bug nobody could reproduce.
    ...(typeof item.hitroll === 'number' && item.hitroll !== 0 ? { hitroll: item.hitroll } : {}),
    ...(typeof item.damroll === 'number' && item.damroll !== 0 ? { damroll: item.damroll } : {}),
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
