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
import type { WeaponProc } from './procs.ts';

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

/** Every type the catalogue speaks, for validating an authored item against the source's vocabulary. */
export const DURIS_ITEM_TYPES: readonly number[] = Object.values(DURIS_ITEM);

/**
 * Where **our own** item vnums start. Nothing Duris ships may ever reach here.
 *
 * A6b. An authored item needs a number, and the only number that is safe is one the source can never
 * claim — `CLAUDE.md`'s rule is that vnums are the join key between every data source we have and are
 * never renumbered, so a collision is not a merge conflict, it is two different items silently
 * becoming one.
 *
 * **Measured rather than assumed:** the harvested catalogue's 16,421 entries run from 4 to **700,008**,
 * in blocks up to 90k with scattered outliers at 120k, 130k, 200k, 400k, 420k, 500k and 700k. Nine
 * million is an order of magnitude clear of the highest of those and leaves the whole 1M–8M range for
 * a future Duris drop to grow into. It is also large enough to be obvious on sight: a seven-digit vnum
 * beginning with a 9 is ours, and no lookup is needed to know it.
 */
export const AUTHORED_VNUM_BASE = 9_000_000;

/**
 * How many of a thing share one slot, by type. `DESIGN-inventory.md` §3.
 *
 * **Lives here rather than in the harvest** — it moved out of `worldgen/src/objects.ts` when A6b needed
 * the same answer for an item that has no `.obj` file behind it. A second copy would have drifted the
 * way `WEAR_BIT_ORDER` and the client's `EQUIPMENT_SLOTS` both did: silently, and visible only as a
 * number in a report.
 */
export function stackLimitFor(type: number): number {
  // Arrows are the doc's own worked example, at 20 to a slot. Coins and small consumables stack too;
  // a sword does not, because two swords are two swords.
  if (type === DURIS_ITEM.missile) return 20;
  if (type === DURIS_ITEM.potion || type === DURIS_ITEM.scroll || type === DURIS_ITEM.food) return 5;
  return 1;
}

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
export function armourBonusFrom(durisArmour: number, craftsmanship?: number): number {
  if (durisArmour <= 0) return 0;
  const base = Math.min(MAX_ITEM_ARMOUR_BONUS, Math.floor(Math.sqrt(durisArmour)));
  // The floor is at 1, not 0: a badly-made breastplate is still a breastplate, and armour that
  // protects you for nothing would make "wear the worse thing" a real answer to a real question,
  // which is a decision nobody should have to make about a jerkin.
  return Math.max(1, Math.min(MAX_ITEM_ARMOUR_BONUS, base + craftsmanshipBonus(craftsmanship)));
}

/* -------------------------------------------------------------------------- */
/* Craftsmanship                                                               */
/* -------------------------------------------------------------------------- */

/** `OBJCRAFT_AVERAGE` in `objmisc.h`. The middle of a 0–15 scale, and where two thirds of the world sits. */
export const CRAFT_AVERAGE = 7;

/** How far craftsmanship may move a piece of armour, either way. */
export const MAX_CRAFT_BONUS = 2;

/**
 * What Duris' craftsmanship scale is worth in armour class.
 *
 * ## This is a divergence, and the reason is the interesting part
 *
 * **In Duris, craftsmanship does nothing at all.** `objmisc.h` defines the whole 0–15 ladder from
 * `OBJCRAFT_TERRIBLE` to `OBJCRAFT_ONE_KIND`, `common.c` gives each rung a sentence — *"of
 * one-of-a-kind craftsmanship"* — and every mechanical use of it in the source is **commented out**:
 * the `max_condition` derivation in `db.c` (marked `wipe2011`) and the extra-attack roll in
 * `fight.c`. It survives only as prose in `identify`.
 *
 * So this is not a transcription. It is the same call V6 made about colour: **the world's builders
 * used the scale and the engine threw it away.** They set it deliberately and at scale — of 21,474
 * objects, 66.7% sit at average and **a third do not**, with 1,284 marked one-of-a-kind and 1,041
 * marked below average. An item that tells the player it was made by a master artisan and is
 * mechanically identical to the average one is a promise the source does not keep, and we can.
 *
 * ## The size, and why it is small
 *
 * Thirds of a rung off average, bounded at ±{@link MAX_CRAFT_BONUS}, against a base that runs 0–8:
 *
 * | craftsmanship | | here | of the catalogue |
 * | --- | --- | --- | --- |
 * | 0–2 | terribly to very poorly made | **−2** | 0.6% |
 * | 3–5 | fairly poorly to below average | **−1** | 5.5% |
 * | 6–8 | either side of average | **0** | 68.3% |
 * | 9–11 | above average to excellently made | **+1** | 9.6% |
 * | 12–15 | skilled artisan to one-of-a-kind | **+2** | 16.0% |
 *
 * **Thirds rather than quarters, and the measurement is why.** Quarter-steps look tidier and leave
 * only 1.3% of the world below average — because the builders' one heavily-used low rung is 5, *"of
 * below average quality"* on 1,041 objects, and quarters round that to nothing. A scale on which
 * a thousand items are labelled shoddy and none of them are is not a scale. Thirds move **31.7%** of
 * the catalogue, in both directions, by an amount that is an edge rather than a tier — which is the
 * same bound `armourBonusFrom`'s own cap exists to keep.
 *
 * **Condition is deliberately not an axis, and that is measured too.** The `.obj` format carries one
 * (`<weight> <cost> <condition>`) and `structs.h` calls it *"items condition or level"*; in the
 * shipped world it is **100 on 99.0% of objects** — 21,262 of 21,474. Nothing in this game wears an
 * item down, so a condition term would be ×1 for the whole world and a rounding error for 206 items.
 * Multiplying by it would be arithmetic that looks like a mechanic.
 *
 * **Material is not carried either**, and for the project's own reason rather than for lack of data:
 * it is on 100% of objects, at position 1 of the numeric run. But `common.c`'s `materials[]` table
 * makes material a **damage-resistance** row — phys, fire, cold, light, gas, acid, negative, holy,
 * psi, spirit — and this game has no damage types to resist. It would also double-count against
 * armour, since `value[0]` already tracks it closely (dragonscale median 12, iron 7, leather 5): the
 * builders encoded material into the armour number themselves. Harvest it the day damage types
 * arrive; a field with no reader is the exact failure `ROADMAP.md` rule 1 exists to prevent.
 */
export function craftsmanshipBonus(craftsmanship?: number): number {
  // Absent, not zero. Zero is `OBJCRAFT_TERRIBLE` and a real value on 34 objects, so defaulting a
  // missing field to it would quietly declare every un-harvested item the worst in the world.
  if (craftsmanship === undefined || !Number.isFinite(craftsmanship)) return 0;
  const step = Math.round((craftsmanship - CRAFT_AVERAGE) / 3);
  // `|| 0` collapses `-0`, which `Math.round` produces for the rungs just below average and which
  // `assert.deepEqual` and `Object.is` both consider a different number from zero.
  return Math.max(-MAX_CRAFT_BONUS, Math.min(MAX_CRAFT_BONUS, step)) || 0;
}

/** Duris' own sentence for a rung of the scale, for anything that shows one to a person. */
export const CRAFTSMANSHIP_NAMES: readonly string[] = [
  'terribly made',
  'extremely poorly made',
  'very poorly made',
  'fairly poorly made',
  'of well below average quality',
  'of below average quality',
  'of slightly below average quality',
  'of average quality',
  'of slightly above average quality',
  'of above average quality',
  'of well above average quality',
  'excellently made',
  'made by a skilled artisian',
  'made by a very skilled artisian',
  'made by a master artisian',
  'of one-of-a-kind craftsmanship',
];

/* -------------------------------------------------------------------------- */
/* Light                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * One Duris hour of burn, in milliseconds.
 *
 * **Pinned to our own torch rather than to a clock.** Duris keeps a light's life in `value[2]` as
 * mud-hours; `light.ts` keeps ours in milliseconds tuned against *room crossings*, and there is no
 * true conversion between the two because a mud hour is not a real one. So the rate is fixed by
 * making the two catalogues agree at the one item they share: Duris' redwood torch burns **24
 * hours** and ours burns **240 seconds**, so an hour is ten seconds and every other harvested light
 * falls out of that. A plain candle's 10 hours lands at 100 s against our own candle's 45; a small
 * brass lantern's 96 at 16 minutes.
 */
export const MS_PER_DURIS_HOUR = 10_000;

/**
 * Above this many Duris hours a light is treated as never going out.
 *
 * Not tidiness — the data demands it. Beside the honest `-1`s the world contains a redwood torch of
 * **99,999,999 hours**, which is a builder writing *forever* in the only column available. At the
 * conversion above that is thirty-one thousand years of burn, and carrying it as a finite number
 * would mean a countdown on the HUD that never visibly moves. A thousand hours is already three
 * hours of play, well past any expedition, and it leaves the genuinely long ones (300, 999) finite.
 */
export const DURIS_HOURS_UNLIMITED = 1000;

/**
 * What a harvested light is worth, or nothing for an item that is not one.
 *
 * **Radius is ours; duration is Duris'.** Diku light is a boolean — a room is lit or it is not — so
 * there is no radius in the source to transcribe, and inventing a ladder of radii would contradict
 * `light.ts`'s own finding: `ROOM_GAP` makes **3 the gate**, and anything between 2 and 3 is
 * mechanically indistinguishable from carrying nothing. So every light the world ships sees exactly
 * as far as a torch, and what separates a candle from a lantern is how long you keep it — which is
 * the axis Duris itself varies, and the one our five hand-authored sources were built around.
 *
 * `value[2] === 0` is a light that has already burnt out. Three of them exist, and they come back as
 * `undefined` rather than as a zero-duration source: a candle melted onto a skull is scenery, and a
 * source that expires on the tick you equip it would announce itself and go out in the same breath.
 */
export function lightFromValues(type: number, values: readonly number[]): { readonly radius: number; readonly durationMs?: number } | undefined {
  if (type !== DURIS_ITEM.light) return undefined;
  const hours = values[2] ?? 0;
  if (hours === 0) return undefined;
  // The gate, from `light.ts`. Named through the constant so moving `ROOM_GAP` moves this too.
  const radius = HARVESTED_LIGHT_RADIUS;
  if (hours < 0 || hours > DURIS_HOURS_UNLIMITED) return { radius };
  return { radius, durationMs: hours * MS_PER_DURIS_HOUR };
}

/**
 * The radius every harvested light burns at — the `ROOM_GAP` threshold, and the reason a light is
 * worth finding at all. See {@link lightFromValues} for why it is one number and not a ladder.
 */
export const HARVESTED_LIGHT_RADIUS = 3;

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
/**
 * Duris' `ITEM_BOAT` (type 22) — the shipped game's **live** deep-water key: carried at the top level
 * or worn (*"water walking items actually"* — `actmove.c`'s own comment), it answers *"You need a
 * boat to go there"*. 29 exist in the harvest, canoes and rafts and boots of water-walking. Phase 19
 * slice 5 keeps them as the swim bundle's exemption: a boat means you are not swimming.
 */
export const ITEM_TYPE_BOAT = 22;

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
  /** Armour class it is worth, already compressed and already including craftsmanship. See {@link armourBonusFrom}. */
  readonly ac: number;
  /**
   * Duris' `OBJCRAFT_*` rung, 0–15, absent where the builder left it at average.
   *
   * **Already folded into {@link ac}** — this is carried so a person can be told *why* one steel helm
   * beats another, which is otherwise unanswerable from the record. The admin panel's item row reads
   * it through {@link CRAFTSMANSHIP_NAMES}; that reader is the reason it is here at all.
   */
  readonly craftsmanship?: number;
  /**
   * What it lights, for the 64 light sources the world ships. Absent on everything else.
   *
   * Read by the simulation's own light fold, which is what makes a lantern in your hand brighter than
   * one in your bag — Duris' rule, `handler.c:431`. See {@link lightFromValues}.
   */
  readonly light?: { readonly radius: number; readonly durationMs?: number };
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
   * Duris' weapon class — `value[0]` of a weapon, `objmisc.h:362`'s 1–20 ladder.
   *
   * **Parsed and thrown away until Phase 19.** `objects.ts` has read `values[0]` since the harvest
   * landed (for the two-handed disjunction) and kept nothing; this is what **decides which skill a
   * swing trains**, through `weaponSkillFor` in `skills.ts`, so it now has a reader — which is the rule
   * a field on this shape is allowed to exist under.
   *
   * Absent on everything that is not a weapon, and on the **6 weapons with no class at all**: those
   * train no skill rather than a wrong one, which is the source's own answer.
   */
  readonly weaponClass?: number;
  /**
   * Duris' `APPLY_HITROLL` / `APPLY_DAMROLL`, summed over the item's `A` blocks.
   *
   * **This is the gear-side power curve §8 leaves room for**, and it was parsed and discarded until
   * 2026-08-04: 3,207 objects carry a hitroll and 3,187 a damroll (median +2, p90 +4, max +100).
   * Absent when zero. Negative is kept — cursed gear is content, not corruption.
   */
  readonly hitroll?: number;
  readonly damroll?: number;
  /**
   * Which LPC sheet a body wearing this is drawn with — an **art id** from `lpc-art.ts`, never a path.
   *
   * A7b, and it replaces the client's `ITEM_LAYER`: ten hardcoded rows that could hold neither the
   * 16,421-entry catalogue nor anything authored. An id rather than a filename because that is what
   * keeps a re-skin out of the protocol — `artgen` can restage every sheet and nothing else moves.
   *
   * Absent on almost everything, and that is the honest default: a ring is not drawn, and neither is
   * an item nobody has chosen art for. The renderer simply has no layer to add.
   */
  readonly art?: string;
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
  /**
   * What a scroll recites — Phase 20 slice 4, on all 135 scrolls the catalogue holds.
   *
   * `value[0]` is the level every stored spell casts at and `value[1..3]` are **Duris' own spell
   * numbers** (`do_recite` reads exactly these, `actoth.c:4234`), kept raw for the same reason
   * {@link ItemTemplate.type} is: they are the file's own vocabulary, and the translation lives in
   * one place (`spells.ts`'s `spellFromDurisNumber`). Duplicates are legal and meaningful — the
   * shipped *scroll of ice* stores chill touch twice and casts it twice. Spells we do not model yet
   * stay recorded here and begin working the day the registry grows them.
   */
  readonly scroll?: { readonly level: number; readonly spells: readonly number[] };
  /**
   * What a weapon does on its own — the proc. Harvested from `value[5..7]` for the 210 weapons the
   * catalogue ships with the data path (`weapon_proc`, `fight.c:7764` — chance, cast level, packed
   * spell numbers kept raw per the scroll rule), or a `special` reference into `procs.ts`'s
   * registry for the bespoke blades whose behaviour was C in the source and is authored here —
   * Windsong first. Template-only, like `scroll`: the instance in a bag needs no copy because the
   * executor reads the wielder's template at proc time.
   */
  readonly proc?: WeaponProc;
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
    // Phase 19: which skill this trains follows the object, not the catalogue — the same argument the
    // line above makes, and `readItem` reads it back for the same reason.
    ...(template.weaponClass === undefined ? {} : { weaponClass: template.weaponClass }),
    // And what it is worth as a light. Copied down for the same reason, and it is what lets the bag and
    // `syncLight` answer "is this a light" without a catalogue in hand — see `Item.light`.
    ...(template.light === undefined ? {} : { light: template.light }),
    ...(template.hitroll ? { hitroll: template.hitroll } : {}),
    ...(template.damroll ? { damroll: template.damroll } : {}),
  };
}

/** The vnum an instantiated item came from, or nothing for an authored one. */
export function vnumOf(item: Item): number | undefined {
  const match = /^obj:(\d+)$/.exec(item.id);
  return match ? Number(match[1]) : undefined;
}
