/**
 * What a body looks like in three dimensions — M7a, `docs/PLAN-3d-migration.md` §6-M7.
 *
 * The 3D sibling of `creature.ts`, and it is written to the same division of labour: the server says
 * *what stands here*, the renderer owns *which file that is*. The difference from the 2D side is only
 * that the vocabulary is now GLTF stems from the Quaternius packs instead of staged PNG keys.
 *
 * ## It rides the 2D classification rather than re-deriving one
 *
 * `mobpick.ts` (worldgen) already answered the hard question — *what is this creature, from its name*
 * — over all 1,503 mob templates, and its verdicts are stored per-vnum in
 * `data/world/overrides/mobs.json` as `Actor.sprite`, a `body/head` key. Measured 2026-08-13: 1,238
 * templates carry one, in 29 distinct combinations. **Asking that question a second time here would
 * be a second answer, and two answers drift** — the rule `creature.ts` states for the head-variant
 * lookup and `wornIds` states for art classes. So {@link appearanceOf} splits the same key and maps
 * each half:
 *
 * - the **body** word (`male`, `female`, `muscular`, `child`, …) chooses the base mesh's sex and the
 *   outfit's cut, because `BODY_WORDS` in `mobpick.ts` is *already* a martial/plain split — its
 *   `muscular` row is literally `giant, ogre, troll, brute, huge, massive, hulking, warrior, guard,
 *   champion`. A guard being dressed as a ranger therefore falls out of the existing sweep rather
 *   than out of a table invented here.
 * - the **head** word decides whether this is a person at all. {@link HUMANOID_HEADS} wear clothes;
 *   everything else is an animal and gets the {@link CREATURE_PREFIX} fallback.
 *
 * A sprite that does not parse — 158 loaded templates and every player still carry the bare word
 * `human`, because the sweep writes an override only where it found something — is a person. That is
 * the honest reading of the word and it is also the safe direction: a mob drawn as a human is wrong
 * in a way a player can shrug at, and a person drawn as a missing-model placeholder is not.
 *
 * ## Nothing here is random, and that is the determinism contract
 *
 * `CLAUDE.md` rule 3 bans `Math.random()` in simulation code, and the usual answer is a seeded RNG.
 * This module needs neither: it is a **pure function of the sprite key and the worn kit**, so the
 * same template is the same body on every server start, in every process, without a seed to keep in
 * step. A hash-based roll was considered for outfit variety and rejected — the pack ships exactly two
 * cuts (see {@link OUTFIT_STYLES}), so a coin toss would only ever dress some guards as farmers.
 *
 * ## Every id names a file that exists
 *
 * Measured on disk, 2026-08-13, from the zips under `assets/quaternius/` (git-ignored):
 * **2 base bodies** and **20 modular outfit parts** in the glTF line. `appearance.test.ts` walks the
 * whole emit surface against {@link BASE_BODY_MODELS} and {@link OUTFIT_PARTS} so an invented stem
 * fails there rather than as a 404 in M7b's loader.
 *
 * **Ids are prefixed, not paths.** `base:`, `outfit:` and `creature:` say which pack a stem belongs to
 * — or that it belongs to none — and where under `public/models/` M7b stages them is the renderer's
 * business, exactly as which PNG an LPC art id resolves to is the 2D client's. A re-stage is then not
 * a protocol change.
 */

import { HEAD_SHAPES } from './creature-art.ts';
import type { EquipSlot } from './equipment.ts';

/* -------------------------------------------------------------------------- */
/* The manifest — real file identities, measured on disk                       */
/* -------------------------------------------------------------------------- */

/** Namespace for a mesh from *Universal Base Characters*. */
export const BASE_PREFIX = 'base:';

/** Namespace for a mesh from *Modular Character Outfits — Fantasy*. */
export const OUTFIT_PREFIX = 'outfit:';

/**
 * Namespace for a body **no pack has a mesh for**, and the one id scheme here that names no file.
 *
 * *Ultimate Monsters* is not on itch (`PLAN-3d-migration.md`'s 2026-08-13 amendment: *"invalid game"*,
 * likely Patreon-only), so the world's animals have no models and inventing stems for them would put
 * 404s on the wire. `creature:wolf` instead says exactly what is true — *this is a wolf and we have no
 * wolf* — and lets M7b draw one placeholder that is visibly a placeholder. The class after the colon
 * is the ULPC head shape the 2D sweep already chose, so the day models are sourced the mapping is a
 * table, not another classification pass.
 *
 * Measured against the real population: **13 of 1,503 templates** land here, of which about half are
 * named people the 2D sweep mis-headed. The monster gap is small; see the M7a report.
 */
export const CREATURE_PREFIX = 'creature:';

/**
 * The two rigged bodies in *Universal Base Characters* \[Standard], by their own file stems.
 *
 * "Superhero" is the vendor's name for the base mesh, not a costume — these are the naked rigs every
 * outfit part in the other pack is bound to, and all of it shares the same 65 joints (the armature
 * risk §6-M7 flagged, retired headlessly on 2026-08-13).
 */
export const BASE_BODY_MODELS = ['Superhero_Female_FullBody', 'Superhero_Male_FullBody'] as const;

/** Which base mesh a body uses. The pack offers exactly these two and no third. */
export type BodySex = 'female' | 'male';

const BASE_BODY_FOR: Readonly<Record<BodySex, string>> = {
  female: 'Superhero_Female_FullBody',
  male: 'Superhero_Male_FullBody',
};

/**
 * The **two** outfits the pack actually ships, and the correction this module was written against.
 *
 * `HANDOFF.md`'s 2026-08-13 block reads *"Female/Male x Peasant/Ranger/etc"*. There is no *etc*:
 * listed headlessly out of `modular-character-outfits-fantasy-standard.zip`, the glTF line is 24
 * files — **20 modular parts plus 4 whole-outfit assemblies** — and the only two themes are Peasant
 * and Ranger. Everything downstream of this fact is smaller than it was planned to be, and saying so
 * here is cheaper than finding out in the renderer.
 */
export const OUTFIT_STYLES = ['peasant', 'ranger'] as const;

export type OutfitStyle = (typeof OUTFIT_STYLES)[number];

/**
 * Where a garment hangs, in the pack's own terms rather than the MUD's.
 *
 * A deliberately separate vocabulary from {@link EquipSlot}, which has 24 entries: the pack has six
 * attachment points and mapping 24 onto 6 is this module's job, not the renderer's. `torso` is the
 * pack's `Body` (renamed because "body" beside "base body" reads as the mesh itself) and `shoulders`
 * is its `Acc_Pauldron(s)`.
 */
export const GEAR_SLOTS = ['torso', 'arms', 'legs', 'feet', 'head', 'shoulders'] as const;

export type GearSlot = (typeof GEAR_SLOTS)[number];

/**
 * Every modular part in the pack, by file stem — the manifest a test asserts the emit surface against.
 *
 * Note the two asymmetries, which are the vendor's and are exactly why this is a table rather than a
 * `${sex}_${style}_${slot}` template: the male ranger's feet are `Feet_Boots` where the female's are
 * `Feet`, and his pauldron is singular where hers is plural. A generated name would be wrong for two
 * of twenty and the failure would be a silently missing mesh.
 */
export const OUTFIT_PARTS = [
  'Female_Peasant_Arms',
  'Female_Peasant_Body',
  'Female_Peasant_Feet',
  'Female_Peasant_Legs',
  'Female_Ranger_Acc_Pauldrons',
  'Female_Ranger_Arms',
  'Female_Ranger_Body',
  'Female_Ranger_Feet',
  'Female_Ranger_Head_Hood',
  'Female_Ranger_Legs',
  'Male_Peasant_Arms',
  'Male_Peasant_Body',
  'Male_Peasant_Feet',
  'Male_Peasant_Legs',
  'Male_Ranger_Acc_Pauldron',
  'Male_Ranger_Arms',
  'Male_Ranger_Body',
  'Male_Ranger_Feet_Boots',
  'Male_Ranger_Head_Hood',
  'Male_Ranger_Legs',
] as const;

const OUTFIT_PART_SET: ReadonlySet<string> = new Set(OUTFIT_PARTS);

/**
 * The part stem for a sex, a cut and a slot, or nothing when the pack has none.
 *
 * **Only the ranger has a head or shoulders**, so those two fall back to the ranger's rather than
 * going undrawn: the pack ships one hood and one pauldron set, and a peasant in the only hood there
 * is looks better than a hooded character with a bare head. The four garment slots exist in both cuts
 * and never fall back.
 */
function outfitPart(sex: BodySex, style: OutfitStyle, slot: GearSlot): string | undefined {
  const Sex = sex === 'female' ? 'Female' : 'Male';
  const Style = style === 'ranger' ? 'Ranger' : 'Peasant';
  const direct = ((): string | undefined => {
    switch (slot) {
      case 'torso':
        return `${Sex}_${Style}_Body`;
      case 'arms':
        return `${Sex}_${Style}_Arms`;
      case 'legs':
        return `${Sex}_${Style}_Legs`;
      case 'feet':
        // The vendor's own asymmetry, and the reason this is not a template string.
        return Style === 'Ranger' && Sex === 'Male' ? 'Male_Ranger_Feet_Boots' : `${Sex}_${Style}_Feet`;
      case 'head':
        return `${Sex}_Ranger_Head_Hood`;
      case 'shoulders':
        return Sex === 'Female' ? 'Female_Ranger_Acc_Pauldrons' : 'Male_Ranger_Acc_Pauldron';
    }
  })();
  return direct !== undefined && OUTFIT_PART_SET.has(direct) ? direct : undefined;
}

/* -------------------------------------------------------------------------- */
/* Reading the 2D classification                                               */
/* -------------------------------------------------------------------------- */

/**
 * The ULPC head shapes that name a **person**, and therefore a body that wears clothes.
 *
 * Every one of these is bipedal and clothed in every source this world draws on — an orc, a goblin,
 * a kobold (`lizard`, and `mobpick.ts` notes 42 of 88 creature-named templates are kobolds), a
 * skeleton, a troll. They all get the base mesh, which means **an orc is a human in this build**.
 * That is a real loss and it is the coordinator's ruling for M7a: a body in the right clothes
 * standing in the right room beats a placeholder, and the day a green mesh is sourced this set is
 * where it plugs in.
 *
 * Anything in `HEAD_SHAPES` and not here is an animal — `wolf`, `rat`, `mouse`, `rabbit`, `pig`,
 * `sheep`, `boarman`. `appearance.test.ts` asserts the partition is total, so a head shape added to
 * the pack cannot quietly fall to a default.
 */
export const HUMANOID_HEADS: ReadonlySet<string> = new Set([
  'human',
  'orc',
  'goblin',
  'troll',
  'minotaur',
  'wartotaur',
  'skeleton',
  'zombie',
  'vampire',
  'frankenstein',
  'alien',
  'lizard',
  'jack',
]);

/**
 * The other half of the partition: an indexed head shape that is **not** a person.
 *
 * Derived from `HEAD_SHAPES` rather than listed, so `creaturegen` adding a shape puts it here without
 * anybody remembering to — and, crucially, so the set is *closed*: a word that is not an indexed head
 * shape at all is a typo, not an animal, and draws the ordinary guard `creature.ts` promises.
 *
 * Today: `boarman`, `mouse`, `pig`, `rabbit`, `rat`, `sheep`, `wolf`.
 */
const ANIMAL_HEADS: ReadonlySet<string> = new Set(HEAD_SHAPES.filter((shape) => !HUMANOID_HEADS.has(shape)));

/**
 * Which base mesh a `mobpick` body word asks for.
 *
 * Absent means male, which is `mobpick.DEFAULT_BODY` — not a preference, just the same default the
 * 2D side already took, kept here so the two sides describe one population the same way.
 *
 * **Measured, and it is a finding rather than a footnote: today this table never fires.** All 1,238
 * classified templates are male-bodied, because `mobpick.BODY_WORDS` has no `female` row at all — its
 * five rows are `muscular`, `child`, `teen`, `skeleton`, `zombie` — so `bodyFromWords` can only ever
 * return one of those or the male default. **Every mob in the world is male**, including *a frost
 * giant matron* and *Essra the drow priestess*, and that is equally true of the 2D client today; it is
 * simply invisible there because ULPC's male and female bodies read alike at 64 px and will not on a
 * lit 3D mesh.
 *
 * The fix is not here. It is a `female` row in `BODY_WORDS` (worldgen owns the classifier) plus a
 * re-run of `npm run mobsweep`, or per-vnum `sprite` edits in `data/world/overrides/mobs.json`. This
 * table is written to be already correct when either lands.
 */
const SEX_FOR_BODY_WORD: Readonly<Record<string, BodySex>> = {
  female: 'female',
  pregnant: 'female',
};

/**
 * Which cut a `mobpick` body word asks for — the whole of the mob outfit decision.
 *
 * `muscular` is the only martial row in `BODY_WORDS` and it is martial by its own trigger list
 * (`warrior`, `guard`, `champion`, alongside `giant` and `ogre`), so it is the only one that reaches
 * for the ranger's leathers. Everything else — `male`, `female`, `teen`, `child`, `skeleton`,
 * `zombie` — is a civilian, an undead or a youth, and wears the peasant's.
 */
const STYLE_FOR_BODY_WORD: Readonly<Record<string, OutfitStyle>> = {
  muscular: 'ranger',
};

/** A sprite key split into the halves `mobpick.spriteKey` joined, tolerating the bare-word case. */
function readSprite(sprite: string): { readonly body: string; readonly head: string } {
  const slash = sprite.indexOf('/');
  if (slash <= 0) return { body: '', head: sprite };
  return { body: sprite.slice(0, slash), head: sprite.slice(slash + 1) };
}

/* -------------------------------------------------------------------------- */
/* Player gear — the 3D sibling of the client's KIT_ART                        */
/* -------------------------------------------------------------------------- */

/**
 * What an authored kit id is, for the purpose of dressing a mesh — the direct analogue of `KIT_ART`
 * in `packages/client/src/scene.ts`, and deliberately the same shape: **id → where it hangs**.
 *
 * It covers the ids `equipment.ts` invents for the starter and class kits, because those are not
 * catalogue items and have no template to carry an art id — the same reason `KIT_ART` still exists on
 * the 2D side after `artgen` retired it as *the* mechanism. Anything harvested arrives as an LPC art
 * class (`torso-clothes-tunic-black`, `backpack-black`) or as a raw `obj:` id, and falls through to
 * {@link SLOT_GEAR}, which keys on the wear slot instead.
 *
 * **The `style` is where the pack's poverty shows.** Three starter chest pieces and one class chest
 * piece compete for two torso meshes, so the split follows the kit's own materials rather than
 * inventing a third: woollen breeches, worn shoes and the much-mended quilted vest (the lowest-AC
 * chest, 1–2 against 1–3) are peasant; leather, padding and mail are ranger. That preserves the one
 * distinction the meshes can carry, and no more.
 *
 * **An id with no row and no slot fallback simply does not draw**, which is `KIT_ART`'s own contract
 * and the honest default for something the pack has no mesh for. That is the whole of `hands`
 * (`hand_wraps`, `work_gloves` — the pack ships no gloves), everything held (`shield`, `bow`, every
 * weapon — no held meshes here at all), and all jewellery.
 */
export const GEAR_ART: Readonly<Record<string, { readonly slot: GearSlot; readonly style: OutfitStyle }>> = {
  // Chest — the common roll, then the class kits' one shared id.
  leather_tunic: { slot: 'torso', style: 'ranger' },
  padded_jerkin: { slot: 'torso', style: 'ranger' },
  quilted_vest: { slot: 'torso', style: 'peasant' },
  mail_shirt: { slot: 'torso', style: 'ranger' },
  // Legs and feet already come in plain/martial pairs, which is what makes this mapping cheap.
  leather_leggings: { slot: 'legs', style: 'ranger' },
  rough_breeches: { slot: 'legs', style: 'peasant' },
  worn_shoes: { slot: 'feet', style: 'peasant' },
  travel_boots: { slot: 'feet', style: 'ranger' },
  // Both head pieces reach the one hood the pack has — see `outfitPart`.
  leather_cap: { slot: 'head', style: 'ranger' },
  cloth_hood: { slot: 'head', style: 'ranger' },
};

/**
 * Where a **wear slot** hangs when the item itself said nothing this module recognises — the fallback
 * that carries the 16,421-entry catalogue.
 *
 * Keyed on {@link EquipSlot} because that is the half of `EntityView.wearing` that is always
 * meaningful: the value may be an art class, a kit id or a bare `obj:1234`, but the key is always the
 * slot the server put it in. Sixteen of the twenty-four slots are absent on purpose and each absence
 * is a mesh the pack does not have.
 *
 * `back` and `about` both reach `shoulders` — a cloak and a pack are the two things this world hangs
 * behind a character, and the pauldrons are the only mesh that sits there.
 */
const SLOT_GEAR: Readonly<Partial<Record<EquipSlot, GearSlot>>> = {
  chest: 'torso',
  arms: 'arms',
  legs: 'legs',
  feet: 'feet',
  head: 'head',
  back: 'shoulders',
  about: 'shoulders',
};

/**
 * Words in an art class that mean **armour**, and so the ranger's cut.
 *
 * A string scan rather than a lookup into `LPC_ART`, because the value on the wire is not always an
 * indexed art id — protocol 14 lets it be a kit id or the item's own `obj:` id — and a rule that
 * worked for one of three shapes would be a rule that mostly did not fire. Whole-substring is fine
 * here where it would not be for the name matcher: these are hyphenated art ids, not English, and the
 * cost of a false positive is a plainer character wearing leathers.
 */
const MARTIAL_WORDS: readonly string[] = [
  'chain',
  'mail',
  'plate',
  'scale',
  'brigandine',
  'splint',
  'armour',
  'armor',
  'cuirass',
  'hauberk',
  'greave',
  'bracer',
  'pauldron',
  'gorget',
];

function styleFrom(artClass: string): OutfitStyle {
  const lower = artClass.toLowerCase();
  return MARTIAL_WORDS.some((word) => lower.includes(word)) ? 'ranger' : 'peasant';
}

/* -------------------------------------------------------------------------- */
/* The answer                                                                  */
/* -------------------------------------------------------------------------- */

/** One mesh hung on the base body. `part` is a prefixed id, never a path — see the module note. */
export interface GearPart {
  readonly slot: GearSlot;
  readonly part: string;
}

/**
 * What a body looks like: one mesh, and what is hung on it.
 *
 * **Whether a part *hides* the base mesh beneath it is the renderer's call, not this module's**, and
 * M7b has to make it: the pack's `Body`/`Arms`/`Legs`/`Feet` parts are cut to replace those sections
 * of the naked rig rather than to layer over them, so drawing both will z-fight along every seam. That
 * is a mesh fact, it is the same for every character, and putting a `hides` flag on the wire would be
 * shipping the same constant 1,500 times. The 2D side draws the same line — `KIT_ART` holds the z
 * order, and the server has never known one.
 */
export interface Appearance {
  /** A prefixed model id — `base:…` for a person, `creature:…` for something with no mesh yet. */
  readonly model: string;
  /** Visible garments, at most one per {@link GearSlot}. Absent when nothing is drawn. */
  readonly gear?: readonly GearPart[];
}

/**
 * What {@link appearanceOf} needs, and exactly the three things `Simulation.viewOf` already has.
 *
 * A structural subset rather than `Actor` or `EntityView`, so this stays testable without a
 * simulation and stays honest about its inputs: an appearance is a function of *what you are* and
 * *what you have on*, and of nothing else.
 */
export interface AppearanceSubject {
  readonly kind: 'player' | 'mob' | 'item';
  /** The 2D sprite key: `body/head`, or a bare word for a body the sweep never classified. */
  readonly sprite: string;
  /** Slot → art class, exactly `EntityView.wearing`. */
  readonly wearing?: Readonly<Record<string, string>>;
}

/**
 * The single authority on what a body draws as.
 *
 * Answers nothing for a **ground object** — a dropped sword has no body, which is why `wearing` and
 * `posture` are already absent for one. What an item on the floor looks like in 3D is `groundSprite`'s
 * question and M7b's, and inventing a mesh for it here would be a second answer to it.
 *
 * Ordering inside `gear` is `GEAR_SLOTS`' order, not the wearer's, so two characters in the same kit
 * produce byte-identical views and a diff on the wire means something changed.
 */
export function appearanceOf(subject: AppearanceSubject): Appearance | undefined {
  if (subject.kind === 'item') return undefined;

  const { body, head } = readSprite(subject.sprite);

  // An animal, and we have no animal meshes. The class is the head shape the 2D sweep chose, so this
  // is a rename away from being a real model id the day one exists.
  //
  // **Only a shape the pack actually indexes may reach this branch**, which is `creature.ts`'s own
  // rule wearing 3D clothes: *"A bulk assignment of fifteen hundred rows will eventually contain a
  // typo, and the honest failure for one is one ordinary-looking guard."* `mobs.json` is 1,238
  // hand-editable rows, and without this test a mistyped `male/wolff` would not draw a wolf — it
  // would emit `creature:wolff`, an id nothing has ever staged, and turn one guard into a 404. So an
  // unrecognised word falls through to the person below, exactly as an unrecognised body does.
  if (ANIMAL_HEADS.has(head)) {
    return { model: `${CREATURE_PREFIX}${head}` };
  }

  const sex = SEX_FOR_BODY_WORD[body] ?? 'male';
  const model = `${BASE_PREFIX}${BASE_BODY_FOR[sex]}`;

  // A player wears what the character sheet says. A mob wears its template's cut, because mobs carry
  // no equipment list — the same division `viewOf` already draws when it puts `wearing` on players
  // only, and for the same reason: dressing mobs from an inventory waits until they have one.
  const gear =
    subject.kind === 'player'
      ? playerGear(sex, subject.wearing)
      : mobGear(sex, STYLE_FOR_BODY_WORD[body] ?? 'peasant');

  return gear.length > 0 ? { model, gear } : { model };
}

/**
 * A mob's clothes: the whole cut, every slot the cut has.
 *
 * Head and shoulders are left off deliberately even though `outfitPart` would answer for them — the
 * hood and the pauldrons are the ranger's *distinguishing* pieces, and putting them on all 1,238
 * classified templates would make every guard in the world the same hooded silhouette. A mob in the
 * four garment slots is dressed; the two accessories wait for something that means them.
 */
function mobGear(sex: BodySex, style: OutfitStyle): readonly GearPart[] {
  const out: GearPart[] = [];
  for (const slot of ['torso', 'arms', 'legs', 'feet'] as const) {
    const part = outfitPart(sex, style, slot);
    if (part) out.push({ slot, part: `${OUTFIT_PREFIX}${part}` });
  }
  return out;
}

/**
 * A player's clothes: what they are actually wearing, resolved slot by slot.
 *
 * Two slots can compete for one mesh — `back` and `about` both hang on the shoulders, `chest` and
 * nothing else on the torso — so the first answer wins in `GEAR_SLOTS` order and the second is
 * dropped. That is the same "one mesh per attachment point" rule the renderer would have to enforce
 * anyway, applied here where it is testable.
 */
function playerGear(sex: BodySex, wearing: Readonly<Record<string, string>> | undefined): readonly GearPart[] {
  if (!wearing) return [];

  const chosen = new Map<GearSlot, string>();
  let torsoStyle: OutfitStyle | undefined;
  for (const [slot, artClass] of Object.entries(wearing)) {
    const authored = GEAR_ART[artClass];
    const gearSlot = authored?.slot ?? SLOT_GEAR[slot as EquipSlot];
    if (!gearSlot || chosen.has(gearSlot)) continue;
    const style = authored?.style ?? styleFrom(artClass);
    const part = outfitPart(sex, style, gearSlot);
    if (!part) continue;
    chosen.set(gearSlot, part);
    if (gearSlot === 'torso') torsoStyle = style;
  }

  // **A chest garment brings its own sleeves**, unless something is worn on the arms in its own right.
  //
  // This is reading the pack rather than inventing a rule: `Body` and `Arms` are two halves of one
  // garment there — the vendor's own `Outfits/Male_Peasant.gltf` is the four parts pre-joined — so
  // drawing `Body` alone puts a jerkin on a character with bare skin from the shoulder down. Caught by
  // looking at a real payload: `rollStarterKit` fills head, chest, hands, legs and feet and **no kit in
  // the game fills `arms`**, so without this every player in the world would be sleeveless while every
  // mob, which gets the whole cut, had sleeves. An actual `arms` item still wins — it ran first above.
  if (torsoStyle && !chosen.has('arms')) {
    const sleeves = outfitPart(sex, torsoStyle, 'arms');
    if (sleeves) chosen.set('arms', sleeves);
  }

  const out: GearPart[] = [];
  for (const slot of GEAR_SLOTS) {
    const part = chosen.get(slot);
    if (part) out.push({ slot, part: `${OUTFIT_PREFIX}${part}` });
  }
  return out;
}

/**
 * Every id {@link appearanceOf} can ever emit for a *model*, for a test and for M7b's staging list.
 *
 * The `creature:` half is derived from `HEAD_SHAPES` rather than listed, so a head shape added to the
 * ULPC index by `creaturegen` appears here without anybody remembering to add it.
 */
export function everyModelId(): readonly string[] {
  const bases = BASE_BODY_MODELS.map((stem) => `${BASE_PREFIX}${stem}`);
  const creatures = [...ANIMAL_HEADS].map((shape) => `${CREATURE_PREFIX}${shape}`);
  return [...bases, ...creatures].sort();
}

/** Every id it can emit for a *part*. Every one is a stem in {@link OUTFIT_PARTS}. */
export function everyGearPartId(): readonly string[] {
  return OUTFIT_PARTS.map((stem) => `${OUTFIT_PREFIX}${stem}`);
}
