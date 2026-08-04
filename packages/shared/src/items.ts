/**
 * The item catalogue: what a thing *is*, as opposed to the particular one you are holding.
 *
 * Phase 15c, and it is `DESIGN-inventory.md` §8's **type/instance split** finally landing. 15b's `Item`
 * is a flat record copied wherever it goes, which was honest while every item in the world came from
 * one authored kit and nothing had per-instance state. The moment charges arrive that stops being true:
 * a half-used wand is *this* wand, and a catalogue entry cannot hold that.
 *
 * So: `ItemTemplate` is the entry — harvested from Duris' `.obj` files, 20,079 of them — and `Item`
 * stays the instance. {@link instantiate} is the one road from one to the other.
 *
 * ## The scales are ours, the magnitudes are Duris'
 *
 * `DESIGN-progression.md` §1: **SRD sets the shape of the rules, Duris sets their magnitudes.** That
 * cuts both ways here. A weapon's damage dice are taken verbatim, because 14b already proved our whole
 * combat scale against Duris' hit points and a 2d6 sword is what that scale expects. Armour is
 * *compressed*, because Duris' armour numbers are on a scale of their own that our AC is not — see
 * {@link armourBonusFrom}. Every conversion is a named function with its measured targets written down,
 * so retuning is one edit rather than an archaeology exercise.
 */

import type { Dice } from './rules.ts';
import type { EquipSlot, Item } from './equipment.ts';

/* -------------------------------------------------------------------------- */
/* Duris' own constants, transcribed                                           */
/* -------------------------------------------------------------------------- */

/**
 * `ITEM_*` from `defines.h`. Only the types we do something with are named.
 *
 * A number rather than a string union because it **is** the file's own value and the join is numeric;
 * naming it here and translating at the edge would put a second vocabulary between us and the source.
 */
export const DURIS_ITEM = {
  light: 1,
  scroll: 2,
  wand: 3,
  staff: 4,
  weapon: 5,
  fireweapon: 6,
  missile: 7,
  treasure: 8,
  armor: 9,
  potion: 10,
  worn: 11,
  container: 15,
  key: 18,
  drinkcon: 17,
  food: 19,
  money: 20,
  book: 23,
  spellbook: 33,
  quiver: 30,
  scabbard: 36,
  shield: 37,
  storage: 35,
} as const;

/**
 * `ITEM_WEAR_*` bits from `defines.h`, mapped onto the slots we model.
 *
 * **Ordered, and the order is the rule**: an item commonly sets several wear bits — a ring that can go
 * on either hand, a weapon that can also be held — and the first match wins. Weapons are listed before
 * `hold` so a sword that is both wieldable and holdable arrives as a weapon, which is what it is for.
 *
 * Duris has 30 wear bits and we model 11 slots. Everything unmatched (`about`, `waist`, `wrist`,
 * `eyes`, `face`, `earring`, `tail`, `horn`, `ioun`, and the horse and spider bodies) yields no slot —
 * the item is still real, still carryable, still worth coins, just not wearable yet. Adding a slot
 * later is a row here and nothing else, which is exactly why the harvest keeps Duris' raw wear
 * position rather than translating it.
 */
const WEAR_BITS: readonly (readonly [bit: number, slot: EquipSlot])[] = [
  [1 << 13, 'mainHand'], // ITEM_WIELD
  [1 << 3, 'chest'], // ITEM_WEAR_BODY
  [1 << 4, 'head'], // ITEM_WEAR_HEAD
  [1 << 5, 'legs'], // ITEM_WEAR_LEGS
  [1 << 6, 'feet'], // ITEM_WEAR_FEET
  [1 << 7, 'hands'], // ITEM_WEAR_HANDS
  [1 << 8, 'arms'], // ITEM_WEAR_ARMS
  [1 << 9, 'offHand'], // ITEM_WEAR_SHIELD
  [1 << 10, 'about'], // ITEM_WEAR_ABOUT — a cloak, worn about the body
  [1 << 11, 'waist'], // ITEM_WEAR_WAIST
  [1 << 12, 'wrist1'], // ITEM_WEAR_WRIST — bracers; the position picks which wrist
  [1 << 2, 'neck'], // ITEM_WEAR_NECK
  [1 << 17, 'eyes'], // ITEM_WEAR_EYES — the owner's eyepatch
  [1 << 18, 'face'], // ITEM_WEAR_FACE
  [1 << 19, 'ear1'], // ITEM_WEAR_EARRING
  [1 << 20, 'quiver'], // ITEM_WEAR_QUIVER
  [1 << 22, 'back'], // ITEM_WEAR_BACK
  [1 << 26, 'nose'], // ITEM_WEAR_NOSE
  [1 << 28, 'ioun'], // ITEM_WEAR_IOUN — orbits the head; a slot of its own in the source
  [1 << 1, 'ring1'], // ITEM_WEAR_FINGER
  [1 << 14, 'offHand'], // ITEM_HOLD — last, so a wieldable thing is a weapon first
];

/**
 * Duris' **wear position** (`WEAR_*`, the `E` command's third argument) mapped to our slots.
 *
 * Separate from {@link WEAR_BITS} and *not* derivable from it: the bits say what an item *may* go on,
 * the position says where a zone file put it. A mob wearing a ring on its left hand is `WEAR_FINGER_L`,
 * position 2, and there is no bit that distinguishes left from right.
 *
 * The four weapon positions collapse onto two, because Duris has races with four arms and we do not.
 */
const WEAR_POSITIONS: Readonly<Record<number, EquipSlot>> = {
  1: 'ring1', // WEAR_FINGER_R
  2: 'ring2', // WEAR_FINGER_L
  3: 'neck', // WEAR_NECK_1
  4: 'neck2', // WEAR_NECK_2
  5: 'chest', // WEAR_BODY
  6: 'head', // WEAR_HEAD
  7: 'legs', // WEAR_LEGS
  8: 'feet', // WEAR_FEET
  9: 'hands', // WEAR_HANDS
  10: 'arms', // WEAR_ARMS
  11: 'offHand', // WEAR_SHIELD
  12: 'about', // WEAR_ABOUT
  13: 'waist', // WEAR_WAIST
  14: 'wrist1', // WEAR_WRIST_R
  15: 'wrist2', // WEAR_WRIST_L
  16: 'mainHand', // PRIMARY_WEAPON — the commonest value in the world by a distance
  17: 'offHand', // SECONDARY_WEAPON
  18: 'offHand', // HOLD
  19: 'eyes', // WEAR_EYES
  20: 'face', // WEAR_FACE
  21: 'ear1', // WEAR_EARRING_R
  22: 'ear2', // WEAR_EARRING_L
  23: 'quiver', // WEAR_QUIVER
  25: 'mainHand', // THIRD_WEAPON, on a four-armed race
  26: 'offHand', // FOURTH_WEAPON
  27: 'back', // WEAR_BACK
};

/**
 * Which slot an item's **wear flags** allow, or nothing if it goes nowhere on a body.
 *
 * Exported because `worldgen` needs exactly this and used to keep **its own copy of the table**. That
 * duplicate was silent right up until Phase 16 added thirteen slots to the list here and the harvest
 * kept resolving against the old eleven — every bracer, cloak and eyepatch in the world stayed
 * slotless, and the only symptom was a number in a report. One table, one order, one place.
 */
export function slotForWearFlags(wearFlags: number): EquipSlot | undefined {
  for (const [bit, slot] of WEAR_BITS) {
    if ((wearFlags & bit) !== 0) return slot;
  }
  return undefined;
}

/** Which slot an `E` command's wear position means, or nothing if we do not model it. */
export function slotForWearPosition(position: number): EquipSlot | undefined {
  return WEAR_POSITIONS[position];
}

/* -------------------------------------------------------------------------- */
/* The conversions, each with its measured targets                             */
/* -------------------------------------------------------------------------- */

/** The most armour class one piece of found gear may be worth. */
export const MAX_ITEM_ARMOUR_BONUS = 8;

/**
 * Duris' armour value, compressed onto our AC.
 *
 * **Owner's decision (2026-08-03): a clear but bounded upgrade.** Measured across the 5,144 armour
 * pieces in the catalogue that carry a value at all, `value[0]` runs median **7**, p90 **16**, max
 * **200** — against a starter kit authored at **+0 to +3** a piece. Used raw, six median pieces would
 * be +42 armour class and a level 1 would be unhittable.
 *
 * `floor(sqrt(v))`, capped, lands exactly on the three targets that were measured:
 *
 * | Duris `value[0]` | here |
 * | --- | --- |
 * | 1–3 | +1 |
 * | 7 (the median) | **+2** — edges a median starter piece |
 * | 16 (p90) | **+4** |
 * | 64 and up | **+8** (the cap) |
 *
 * The square root is doing the real work: it keeps the *ordering* of the whole catalogue intact — a
 * 200-point legendary still beats a 16-point one — while flattening the top so the best gear in the
 * world is a strong edge rather than immunity. One function, one cap, one edit to retune.
 */
export function armourBonusFrom(durisArmour: number): number {
  if (durisArmour <= 0) return 0;
  return Math.min(MAX_ITEM_ARMOUR_BONUS, Math.floor(Math.sqrt(durisArmour)));
}

/** The most slots one item may cost. `DESIGN-inventory.md` §2's own breastplate is ten of twenty. */
export const MAX_ITEM_SIZE = 10;

/**
 * Duris' weight, converted to slots of bulk.
 *
 * Measured: weight runs median **2**, p90 **20**, max a nonsensical 1,000,000 (a builder's slip on a
 * ship or a corpse-like object). Fifths of a weight unit put a median item at 1 slot and a p90 item at
 * 4, with the cap catching the absurd ones — and the cap is not defensive tidiness, it is the design
 * doc's own rule that the heaviest thing you can carry is half a bag.
 */
export function sizeFrom(weight: number): number {
  if (!Number.isFinite(weight) || weight <= 0) return 1;
  return Math.max(1, Math.min(MAX_ITEM_SIZE, Math.ceil(weight / 5)));
}

/* -------------------------------------------------------------------------- */
/* The template                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a container will accept. `any` is a sack; the restricted ones are the reason containers exist —
 * `DESIGN-inventory.md` §4's quiver, which lets arrows stop eating your inventory.
 *
 * A list with the type derived from it, rather than the type alone, because a save file is validated
 * against these at load time (`readInventory`) and a hand-written copy of the union would silently
 * start refusing a kind the day a fourth one is added.
 */
export const CONTAINER_ACCEPTS = ['any', 'missile', 'weapon'] as const;
export type ContainerAccepts = (typeof CONTAINER_ACCEPTS)[number];

export interface ContainerRule {
  /** How many slots of bulk it holds — **not** counted against the bag holding it. §4. */
  readonly capacity: number;
  readonly accepts: ContainerAccepts;
}

/** One catalogue entry. Harvested; never authored by hand. */
export interface ItemTemplate {
  /** Duris' object vnum. The join key between the `.obj` files and every `G`/`E`/`P` reset command. */
  readonly vnum: number;
  /**
   * The words it answers to — **Duris' own authored list**.
   *
   * This is the field `isName` was written against, and it replaces `keywordsFromName` for anything
   * harvested. An authored list is what lets a longsword answer to `sword` without also answering to
   * `steel` by accident, which a split display name cannot do.
   */
  readonly keywords: readonly string[];
  /** Its name in a sentence, colour codes intact. */
  readonly name: string;
  /** The line when it is lying on the floor. */
  readonly roomLine: string;
  /** Duris' `ITEM_*` type. Kept raw — it is the file's own value and the vocabulary of the source. */
  readonly type: number;
  /** Where it may be worn, or absent for something that can only be carried. */
  readonly slot?: EquipSlot;
  /** Armour class it is worth, already compressed. See {@link armourBonusFrom}. */
  readonly ac: number;
  /** What it hits for, verbatim from `value[1]d value[2]`. Absent on anything that is not a weapon. */
  readonly damage?: Dice;
  /**
   * Needs **both hands** — 557 of the catalogue's 2,841 weapons. `wield` is what enforces it.
   *
   * Harvested from Duris' own disjunction (`extra_flags & ITEM_TWOHANDS || value[0] == 13`), which is
   * not the same as either half: twenty-two two-handed swords carry no flag at all. See `objects.ts`.
   */
  readonly twoHanded?: true;
  /**
   * Duris' `APPLY_HITROLL` / `APPLY_DAMROLL`, summed over the item's `A` blocks.
   *
   * **This is the gear-side power curve §8 leaves room for**, and it was parsed and discarded until
   * 2026-08-04: 3,207 objects carry a hitroll and 3,187 a damroll (median +2, p90 +4, max +100).
   * Absent when zero. Negative is kept — cursed gear is content, not corruption.
   */
  readonly hitroll?: number;
  readonly damroll?: number;
  readonly size: number;
  /** Coins it is worth. Duris' own `cost`. */
  readonly cost: number;
  /** How many share one slot. §3, and independent of {@link uses}. */
  readonly stackLimit: number;
  /** Charges in **one** item — a wand's, a large potion's. §3. Absent means it is not consumed by use. */
  readonly uses?: number;
  /** Set when this is a container. §4. */
  readonly container?: ContainerRule;
  /**
   * What this is worth in coin, when it is a pile of money rather than a thing.
   *
   * All four of Duris currencies — see `containers.ts`. `value[0..3]` are copper, silver, gold and
   * platinum in that order, read off `utils.h` rather than guessed, because a pile of "platinum and
   * gold" carries its numbers in `value[2]` and `value[3]` and reading `value[0]` as "the coins"
   * would report fifteen thousand coppers and lose the platinum entirely.
   */
  readonly coins?: Readonly<Partial<Record<"copper" | "silver" | "gold" | "platinum", number>>>;
}

/**
 * Turns a catalogue entry into a thing you can hold.
 *
 * The **id** is `obj:<vnum>`, which keeps harvested items in a namespace of their own: the starter
 * kit's ids are bare words (`leather_tunic`), so nothing harvested can ever collide with something
 * authored, and which of the two an item came from stays readable in a save file.
 *
 * A template with no slot yields an item with no slot — a key, a coin, a lump of ore. `wear` refuses
 * those by name rather than by putting them somewhere arbitrary.
 */
export function instantiate(template: ItemTemplate): Item {
  return {
    id: `obj:${template.vnum}`,
    name: template.name,
    ...(template.slot ? { slot: template.slot } : {}),
    ac: template.ac,
    size: template.size,
    ...(template.damage ? { damage: template.damage } : {}),
    // **Copied down, or nothing in the harvested world stacks.** The catalogue has carried
    // `stackLimit` and `uses` since the harvest landed and nothing read them; this is the line that
    // connects them to the bag. Only carried when they mean something — a `stackLimit` of 1 is the
    // default and writing it on every sword in a save file says nothing.
    ...(template.stackLimit > 1 ? { stackLimit: template.stackLimit } : {}),
    ...(template.uses === undefined ? {} : { uses: template.uses }),
    // On the instance too, because the rule follows the object and not the catalogue: a greatsword in
    // a save file has to still need two hands after a restart, and `readItem` reads this back for the
    // same reason it reads `stackLimit` — a field with no line in its reader is deleted, silently.
    ...(template.twoHanded ? { twoHanded: true as const } : {}),
    ...(template.hitroll ? { hitroll: template.hitroll } : {}),
    ...(template.damroll ? { damroll: template.damroll } : {}),
  };
}

/** The vnum an instantiated item came from, or nothing for an authored one. */
export function vnumOf(item: Item): number | undefined {
  const match = /^obj:(\d+)$/.exec(item.id);
  return match ? Number(match[1]) : undefined;
}
