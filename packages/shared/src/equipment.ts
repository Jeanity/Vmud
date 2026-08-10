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

import type { ClassId } from './classes.ts';
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
  /**
   * The ranged fields, following the object for `weaponClass`'s own reason — the bow in your save
   * file has to still be a bow after a restart and a catalogue edit — plus one more this family
   * alone has: **the client reads them off `SelfView.equipped` to decide which verbs the click menu
   * may offer**, and the client has no catalogue to heal a missing field from. A launcher `fires` a
   * missile type; a missile *is* one ({@link missileType}); a throwable says so and how far, and a
   * returning one comes back to the hand. See `DESIGN-ranged.md`.
   */
  readonly fires?: number;
  readonly missileType?: number;
  readonly canThrow?: true;
  readonly throwRange?: number;
  readonly returning?: true;
  /**
   * **Really here, and not listed until somebody looks properly** — `ITEM_SECRET` (`defines.h:197`),
   * and the thing `search` exists to turn up.
   *
   * Not invisibility and not a container: the item is lying in the room or sitting in a corpse the
   * whole time, and `look` simply does not mention it. `do_search` clears the bit on a successful
   * `find_chance` and announces *"You find $p!"* to the room, which is why this is a property of
   * the **instance** rather than the template — being found is a thing that happens once, to one
   * needle, and a template flag would re-hide it for everyone on the next spawn.
   *
   * Absent means ordinary, which is every item in the world today.
   */
  readonly hidden?: true;
  /** Slice 7's magic launcher: the conjured missile's name. See the template field for the rules. */
  readonly conjures?: string;
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
   * **May ride the off hand**, so `wield <weapon> offhand` will take it — Phase 21, `handednessFor`.
   *
   * The mirror of {@link twoHanded} and on the instance for the identical reason: the dagger in your
   * save file is the dagger you wielded, and an **authored** blade (Windsong) has no catalogue entry
   * for anything to look the answer up in. Resolved at `instantiate` rather than copied, so what is
   * stored is the verdict rather than the ingredients.
   */
  readonly handedness?: 'either';
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
 * 0, that is the difference between being hit **45% of the time and 10%**. A real gap that neither
 * trivialises the starter zone nor makes it unplayable.
 *
 * **That second figure used to read "about 30%", and it was wrong.** `resolveAttack` hits when
 * `natural + bonus >= targetAc` (or on a natural 20), so at attack bonus 0 an AC of 19 is reached
 * only by a natural 19 or 20 — 10%, not 30%. 30% is AC 15. The error mattered rather than being a
 * stray decimal: it under-prices a point of armour by more than double, and a later pass designing
 * the class kits took it at face value and nearly built a whole exchange rate on it. Each point of
 * AC across this band is worth a flat **5 percentage points** of incoming hits.
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
/**
 * The id every starter shield is minted under, whatever it is called.
 *
 * The paladin's kite shield and the cleric's round shield share it deliberately — the comment on
 * the cleric's row says why, it draws through the mapping the paladin's already uses. Exported
 * because it is now load-bearing beyond art: a starter shield has no vnum and therefore no
 * catalogue template, so `DURIS_ITEM.shield` cannot be read off it, and this id is the only thing
 * that says a new paladin is holding a shield rather than a lantern. See `shieldInHand` in the
 * server, which is where a bash asks.
 */
export const STARTER_SHIELD_ID = 'shield';

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

/**
 * What a class starts with *instead of* the common roll, slot by slot — owner's ruling, 2026-08-08,
 * grown from the paladin's two slots to all nine classes when the owner asked for a paladin chest
 * piece and named the risk it created in the same breath: *"we don't need 1 buffed class that
 * everyone is going to want to play. we will have to give the other classes something equivalent."*
 *
 * Sparse and overriding rather than additive: a slot named here replaces {@link STARTER_KIT}'s
 * choices for that class, and a slot absent here falls through to the common table. Head, hands,
 * legs and feet are left alone for everybody, so every kit still varies in most of its slots.
 *
 * ## The correctness half, which matters more than the balance half
 *
 * The nine-class skill re-key left most classes with most weapon skills at **0**, and the common
 * `mainHand` rolls at random across four weapons. Measured before this table existed: a **cleric,
 * shaman, necromancer or rogue had a 75% chance** of starting with a weapon they could never train
 * — a cleric holding a short sword has `slashing-1h` ceiling 0, so that weapon swings at +0 for
 * ever and no amount of use lifts it. Ranger 25%, sorcerer 50%, druid 25%. Every `mainHand` below
 * maps to a skill its class actually has, and `equipment.test.ts` pins that for all nine.
 *
 * Note `StarterEntry` carries no `twoHanded` field, so every entry resolves through
 * `weaponSkillFor`'s one-handed branch. That is why the ranger's spear (`weaponClass` 15) trains
 * `piercing-1h` rather than `reach` — the good outcome, since no class has a `reach` grant before
 * level 25.
 *
 * ## The balance half, in the only currency level 1 has
 *
 * At level 1 weapon skill contributes **+0 to every class** (`toHitFrom(1)` is 0; it first bites at
 * level 7) and dual wield swings **0% of rounds**. So the only things a starting kit can be worth
 * are **armour class and average weapon damage**, and those are what these rows trade.
 *
 * Fitness is `F = 20·D / (11 − AC)` — damage dealt over the share of rounds a level-1 mob connects,
 * the player's own hit chance cancelling because at level 1 it is identical across the nine.
 * Measured over the real roll:
 *
 * ```
 *   paladin 19.00  rogue 18.60  warrior 18.58  ranger 18.52                martial, spread 2.6%
 *   necromancer 17.85  druid 17.78  sorcerer 17.74  shaman 17.74  cleric 17.52   caster, 1.9%
 *                                                   (common table 19.11)
 * ```
 *
 * **Equal fitness is not the same as an equal kit**, and two pairs had to learn it the hard way. The
 * druid and the shaman both sat on AC 4.50 / damage 5.67; the sorcerer and the necromancer both sat on
 * AC 4.00 / damage 6.25. Same fitness is the goal — same *coordinates* means one kit wearing two sets
 * of nouns. Both pairs are now each other's mirror and meet again only in fitness: AC 4.25 with a keen
 * sickle against AC 4.99 with a stone maul, and AC 3.25 with a blackthorn staff against AC 4.00 with a
 * bone knife. Neither pair was caught by a test — both were caught by looking at the nine side by
 * side, which is why `equipment.test.ts` now measures the distance between *every* pair.
 *
 * The five casters therefore run as a ladder rather than a cluster: sorcerer 3.25, necromancer 4.00,
 * druid 4.25, cleric 4.73, shaman 4.99 — frail-and-swinging through to armoured-and-slow.
 *
 * The martials sit ~6% above the casters, and that gap is the one deliberate inequality in the
 * table: the five casters hold circle-1 spells at level 1 and the four martials hold none until 11
 * or never. A sorcerer's two castings of `magic_missile` are ~22 damage a rest, comfortably more
 * than 6% of a kit. **No class is best on both axes** — the paladin tops armour, the warrior tops
 * damage — and that is the invariant to preserve if these numbers are ever retuned.
 *
 * Worth saying plainly, because it reads as a nerf and is: the paladin's damage went *down* to pay
 * for the chest piece. Before this table they were AC 5.32 / damage 7.00, F 24.65 against a common
 * 19.11 — **29% ahead of every other class**, which is the imbalance the owner spotted from the
 * outside. The mail is real; the sword is now the softest in the game at 2d4. That is the trade.
 *
 * ## Art
 *
 * Chest `id`s are reused from the common table wherever possible, because `KIT_ART` in the client
 * maps ids to sheets and **an id with no row simply does not draw**. `mail_shirt` is the one new id
 * and it ships with its mapping to `torso-chainmail`, whose six sheets are already staged. The
 * cleric's round shield reuses the bare `shield` id for the same reason. A `name` is free — only
 * the `id` reaches the renderer — which is why a druid's hide jerkin and a rogue's dark leathers
 * can both be a `leather_tunic` underneath.
 */
const CLASS_KIT: Readonly<Partial<Record<ClassId, Readonly<Partial<Record<EquipSlot, readonly StarterEntry[]>>>>>> = {
  /* ------------------------------------------------------------------ martial */

  // Tops the table on damage and sits at the bottom on armour — the warrior buys the blow with the
  // bruise. The only class that can train all four one-handed skills, so all four are on offer.
  warrior: {
    mainHand: [
      { id: 'broadsword', name: "a soldier's broadsword, notched to the spine", acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 6, bonus: 0 }, weaponClass: 5 },
      { id: 'bearded_axe', name: 'a bearded axe with a sweat-dark haft', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 2 }, weaponClass: 1 },
      { id: 'war_hammer', name: 'an iron-shod war hammer', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 1 }, weaponClass: 4 },
      { id: 'footman_flail', name: "a footman's flail, three links short", acMin: 0, acMax: 0, size: 2, damage: { count: 3, sides: 4, bonus: 0 }, weaponClass: 3 },
    ],
    chest: [
      { id: 'leather_tunic', name: 'a leather tunic, sold down and bought back', acMin: 0, acMax: 2, size: 3 },
      { id: 'padded_jerkin', name: 'a padded jerkin gone flat across the chest', acMin: 0, acMax: 2, size: 3 },
      { id: 'quilted_vest', name: 'a quilted vest, more mend than vest', acMin: 0, acMax: 1, size: 2 },
    ],
  },

  // Slashing and piercing both at 95, so the ranger's weapon roll is a genuine choice of shape rather
  // than of skill. The spear stays one-handed on purpose — see the docblock.
  ranger: {
    mainHand: [
      { id: 'hunting_sword', name: 'a hunting sword with a stag-horn grip', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 5 },
      { id: 'hunting_hatchet', name: 'a hatchet, chipped at the bit', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 1 },
      { id: 'skinning_knife', name: 'a skinning knife, worn narrow', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 4, bonus: 2 }, weaponClass: 2 },
      { id: 'boar_spear', name: 'a boar spear, hafted short', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 15 },
    ],
    chest: [
      { id: 'leather_tunic', name: 'a set of green-dyed travelling leathers', acMin: 1, acMax: 2, size: 3 },
      { id: 'padded_jerkin', name: 'a weathered jerkin, oiled against the rain', acMin: 1, acMax: 3, size: 3 },
    ],
  },

  // The armoured one. The longsword is FIXED — the owner asked for it by name — so the mail is paid
  // for in the blade's dice rather than in variety: 2d4 is the softest weapon in the game.
  paladin: {
    mainHand: [
      { id: 'longsword', name: 'a plain steel longsword', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 0 }, weaponClass: 5 },
    ],
    offHand: [
      { id: 'shield', name: 'a battered kite shield', acMin: 0, acMax: 2, size: 3 },
    ],
    chest: [
      { id: 'mail_shirt', name: 'a mail shirt, kept oiled', acMin: 2, acMax: 3, size: 4 },
      { id: 'mail_shirt', name: 'a scale hauberk with a mended shoulder', acMin: 1, acMax: 3, size: 4 },
    ],
  },

  // piercing-1h at 90 is the rogue's only weapon skill, so every option is a **dagger** — not a sword.
  // Worth being exact, because "blade" hides the rule: a short sword is `weaponClass` 9 and trains
  // *slashing*, which the rogue cannot train at all. Duris does let a thief use short swords, but
  // through a hardcode in `fight.c` rather than the skill table (its own 1h-slashing row for the class
  // is commented out and says so), and we have not built that exception. The four differ in shape
  // rather than in what they train. Light armour, second on damage.
  rogue: {
    mainHand: [
      { id: 'stiletto', name: 'a needle-point stiletto', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 6, bonus: 0 }, weaponClass: 2 },
      { id: 'poniard', name: 'a curved poniard', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 4, bonus: 2 }, weaponClass: 2 },
      { id: 'dirk', name: 'a dirk with a cord-wrapped hilt', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 1 }, weaponClass: 2 },
      { id: 'boot_knife', name: 'a flat knife made for a boot', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 2 },
    ],
    chest: [
      { id: 'leather_tunic', name: 'a jerkin of soft dark leather', acMin: 0, acMax: 2, size: 3 },
      { id: 'quilted_vest', name: 'a close-cut vest, quiet at the seams', acMin: 1, acMax: 2, size: 2 },
    ],
  },

  /* ------------------------------------------------------------------- caster */

  // bludgeon-1h at 70 is the cleric's ONLY weapon skill — the oldest rule in the genre arriving from
  // the data rather than from memory. Four blunt instruments, and the round shield reuses the bare
  // `shield` id so it draws through the mapping the paladin's already uses.
  cleric: {
    mainHand: [
      { id: 'iron_mace', name: 'a pitted iron mace', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 0 }, weaponClass: 6 },
      { id: 'temple_hammer', name: 'a temple hammer, its head bound with wire', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 4 },
      { id: 'oak_cudgel', name: 'a knotted oak cudgel', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 10 },
      { id: 'walking_staff', name: "a priest's walking staff", acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 3, bonus: 1 }, weaponClass: 12 },
    ],
    offHand: [
      { id: 'shield', name: 'a dented round shield', acMin: 0, acMax: 1, size: 3 },
    ],
    chest: [
      { id: 'mail_shirt', name: 'a mail shirt from the temple stores', acMin: 1, acMax: 3, size: 4 },
      { id: 'quilted_vest', name: 'a grey wool vestment over a padded shirt', acMin: 1, acMax: 2, size: 2 },
    ],
  },

  // **The heaviest caster, and the slowest.** Bludgeon on both axes and nothing else — 85 in one hand
  // is the best blunt ceiling of any class outside the martials — so all three weapons are blunt and
  // none of them is quick. Bone plate over hide puts the shaman at the top of the caster armour range.
  //
  // Deliberately the mirror of the druid below rather than its twin: the two used to sit on the exact
  // same point (AC 4.50, damage 5.67), which made them the same kit wearing different nouns. They now
  // sit at opposite ends of the caster frontier and meet again only in fitness.
  //
  // The two chest entries share a mean and differ in spread — one reliable, one a gamble — which is a
  // difference the roll can express and a single band cannot.
  shaman: {
    mainHand: [
      { id: 'stone_maul', name: 'a stone-headed maul', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 0 }, weaponClass: 4 },
      { id: 'totem_club', name: 'a totem club, ancestor-carved', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 0 }, weaponClass: 10 },
      { id: 'spirit_staff', name: 'a spirit staff hung with finger-bones', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 12 },
    ],
    chest: [
      { id: 'padded_jerkin', name: 'a totem coat plated with carved bone', acMin: 2, acMax: 3, size: 4 },
      { id: 'leather_tunic', name: 'a hide cuirass strung with ancestor-teeth', acMin: 1, acMax: 4, size: 3 },
    ],
  },

  // **The lightest and keenest caster.** Slashing at 80 is the druid's better skill and the sickle is
  // weaponClass 17, which nobody else in the game rolls; the flint axe is the same skill in a different
  // shape, and only the staff falls back on bludgeon at 70. Supple hide rather than plate, so the druid
  // sits at the bottom of the caster armour range and the top of its damage — the shaman's mirror.
  druid: {
    mainHand: [
      { id: 'bronze_sickle', name: 'a bronze sickle, edge kept keen', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 17 },
      { id: 'flint_axe', name: 'a flint-headed hand axe, bound with sinew', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 1 },
      { id: 'ash_quarterstaff', name: 'a quarterstaff of grey ash', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 12 },
    ],
    chest: [
      { id: 'leather_tunic', name: 'a jerkin of supple deerhide', acMin: 1, acMax: 2, size: 3 },
      { id: 'quilted_vest', name: 'a mantle of woven bark and leaf', acMin: 1, acMax: 3, size: 2 },
    ],
  },

  // **The frailest kit in the game, carrying the biggest stick.** Two staves on bludgeon-1h (60) and
  // two **daggers** on piercing-1h (80), so half the rolls open the better ceiling and the other half
  // look like a wizard — and the staves are the heaviest weapons any caster swings, the blackthorn on
  // 3d4. Daggers specifically, never swords: `weaponClass` 5, 9 and 13 all train *slashing*, which a
  // sorcerer's ceiling puts at 0, so a sword is a weapon they could carry and never learn.
  // Robes and nothing under them: AC 3.25 is the lowest of the nine, and a `0` chest roll is common.
  //
  // The second half of the same correction the druid and the shaman got. This class and the
  // necromancer used to sit on one point (AC 4.00, damage 6.25) — both frail arcanists, both d6, and
  // numerically indistinguishable. The split runs along the one real difference between them: a
  // sorcerer may train a staff and a necromancer may not, so the sorcerer takes the reach and the
  // fragility and the necromancer stays close and stays covered.
  sorcerer: {
    mainHand: [
      { id: 'blackthorn_staff', name: 'a gnarled blackthorn staff', acMin: 0, acMax: 0, size: 2, damage: { count: 3, sides: 4, bonus: 0 }, weaponClass: 12 },
      { id: 'shod_staff', name: 'an iron-shod walking staff', acMin: 0, acMax: 0, size: 2, damage: { count: 2, sides: 6, bonus: 0 }, weaponClass: 12 },
      { id: 'ritual_dagger', name: 'a slim ritual dagger', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 1 }, weaponClass: 2 },
      { id: 'wire_knife', name: 'a knife with a wire-wound grip', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 2 },
    ],
    chest: [
      { id: 'quilted_vest', name: 'a threadbare robe, thin at the elbows', acMin: 0, acMax: 1, size: 2 },
      { id: 'padded_jerkin', name: "a scholar's coat, ink at the cuff", acMin: 0, acMax: 2, size: 3 },
    ],
  },

  // **Daggers only, and better covered than the sorcerer for it.** piercing-1h at 80 is the
  // necromancer's single weapon skill, so there is no staff to reach for, no sword they could ever
  // learn, and no decision beyond which knife. Grave-cloth and a much-repaired coat put them three
  // quarters of a point of armour above the sorcerer while giving up half a point of damage — the
  // same fight, closer in.
  //
  // The numbers here did not move in the split; the sorcerer's did. Separating a pair only needs one
  // of them to move, and this was the one whose kit already said what it was.
  necromancer: {
    mainHand: [
      { id: 'bone_knife', name: 'a bone-handled knife', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 2 },
      { id: 'sacrificial_blade', name: 'a thin sacrificial blade', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 4, bonus: 2 }, weaponClass: 2 },
      { id: 'corpse_awl', name: "a corpse-tender's awl", acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 5, bonus: 0 }, weaponClass: 2 },
      { id: 'grave_dagger', name: 'a dagger dulled by grave soil', acMin: 0, acMax: 0, size: 1, damage: { count: 2, sides: 4, bonus: 1 }, weaponClass: 2 },
    ],
    chest: [
      { id: 'quilted_vest', name: 'a grave-cloth vest, stiff with age', acMin: 0, acMax: 2, size: 2 },
      { id: 'padded_jerkin', name: 'a padded coat, black and much repaired', acMin: 1, acMax: 3, size: 3 },
    ],
  },
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
 *
 * `classId` selects {@link CLASS_KIT}'s overrides where it has any. It is **optional and absent means
 * the common kit**, which is not a fallback so much as the honest answer for the two callers that
 * genuinely have no class: a pre-Phase-21 character with no identity, and the tests. A class with no
 * row in `CLASS_KIT` also takes the common kit, which is every class but the paladin.
 */
export function rollStarterKit(rng: Rng, classId?: ClassId): Equipped {
  const kit: Equipped = {};
  const override = classId === undefined ? undefined : CLASS_KIT[classId];
  for (const slot of EQUIP_SLOTS) {
    const choices = override?.[slot] ?? STARTER_KIT[slot];
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
    // And its mirror. Without this line a dagger reloaded from disk would come home main-hand-only,
    // and the off hand it had been swinging from all of yesterday would refuse it — silently, and
    // only for characters who had logged out. `twoHanded`'s own lesson, one field over.
    ...(item.handedness === 'either' ? { handedness: 'either' as const } : {}),
    // Phase 19, and the same rule again: without this line a sword reloaded from disk would train no
    // skill and lose its to-hit bonus, silently, and only for characters who had logged out.
    ...(typeof item.weaponClass === 'number' && item.weaponClass > 0 ? { weaponClass: item.weaponClass } : {}),
    // Ranged, the same rule a fifth time: a bow that forgot what it fires over a restart would refuse
    // every arrow in the quiver, and the click menu would stop offering Fire — silently, and only for
    // characters who had logged out.
    ...(typeof item.fires === 'number' && item.fires > 0 ? { fires: item.fires } : {}),
    ...(typeof item.missileType === 'number' && item.missileType > 0 ? { missileType: item.missileType } : {}),
    ...(item.canThrow === true ? { canThrow: true as const } : {}),
    ...(typeof item.throwRange === 'number' && item.throwRange > 0 ? { throwRange: item.throwRange } : {}),
    ...(item.returning === true ? { returning: true as const } : {}),
    // Slice 7, the same rule once more: a magic bow that forgot its own arrows over a restart would
    // wake up demanding a quiver.
    ...(typeof item.conjures === 'string' && item.conjures.length > 0 ? { conjures: item.conjures } : {}),
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
