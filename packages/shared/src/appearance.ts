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
 * This module needs neither: it is a **pure function of the sprite key, the worn kit and the
 * character's own identity**, so the same template is the same body on every server start, in every
 * process, without a seed to keep in step. A hash-based roll was considered for outfit variety and
 * rejected — the pack ships exactly two cuts (see {@link OUTFIT_STYLES}), so a coin toss would only
 * ever dress some guards as farmers. **Hair is where that argument turns over**: the pack ships five
 * distinguishable styles, a room full of identically-shorn kobolds reads as a cloning vat, and
 * {@link defaultHairFor} hashes the body's own identity rather than rolling — same body, same hair,
 * for ever, with no stored seed and no shared stream.
 *
 * ## One field the simulation *owns*
 *
 * Everything else here is derived: the outfit from worn gear, the mesh from the sprite key, the hands
 * from what is wielded. `hair` is the first that is **chosen** — a player types `hair long` and the
 * decision is persisted on their character record. It arrives here as {@link AppearanceSubject.hair},
 * an already-validated style id, because this module still knows no store and no catalogue; what it
 * owns is the mapping from a style to the two meshes that fit the two skulls.
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
 * Namespace for a mesh from the *Fantasy Props MegaKit* — M7b, and the only thing anybody holds.
 *
 * A fourth namespace rather than a fourth `outfit:` slot, because a weapon is not a garment: it hangs
 * off a hand bone rather than replacing a region of the body, it comes out of a different pack, and it
 * is the one thing on a body whose id is chosen from what the character is *wielding* rather than from
 * what they are wearing.
 */
export const PROP_PREFIX = 'prop:';

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

/**
 * Head shapes that have a **mesh of their own** — `mobpick`'s word to an in-house model's stem.
 *
 * The first crack in *"every mob in the world is a Quaternius human"*, and the shape it takes is the
 * one thing worth stating: a creature is chosen by the same head word the 2D sweep already assigned,
 * so nothing new has to be classified. `kobold` is a head shape the ULPC pack does not have — see
 * `HUMANOID_HEADS` — which is deliberate: it exists **only** as a 3D answer, and the 42 templates that
 * carry it were `lizard` until a kobold mesh existed to be more specific than that.
 *
 * A row here overrides the person branch entirely. The body word still sets the scale — a
 * `child/kobold` is a kobold *youth* at 0.72 of 0.756 m — but nothing else about a person applies:
 * see `characters.BodyTemplate.composable` for why a creature wears nothing, holds nothing and grows
 * no hair.
 *
 * **Empty is the honest state for everything else.** A wolf still gets `creature:wolf` and a capsule.
 */
export const CREATURE_BODY_FOR: Readonly<Record<string, string>> = {
  kobold: 'Kobold',
};

/** The stems above, sorted — the staging list, and what `characters.test.ts` joins on. */
export const CREATURE_BODY_MODELS: readonly string[] = Object.values(CREATURE_BODY_FOR).sort();

/**
 * Whether a model id names a body the **outfit pack can dress** — one predicate, because there are
 * now three kinds of body and only one of them wears clothes.
 *
 * Written because the alternative was already in the codebase in triplicate and was already subtly
 * wrong: several whole-world invariants ("nobody in the world is naked", "nobody is bald") excluded
 * the placeholders by testing {@link CREATURE_PREFIX}, which was a correct spelling of *"has no
 * mesh"* right up until a creature had one. A kobold has a mesh, emits a `base:` id and is still
 * un-dressable — so the question those tests are really asking is this one, and asking it in one
 * place is what stops the next creature quietly failing them.
 *
 * The renderer's own name for the same fact is `characters.BodyTemplate.composable`.
 */
export function wearsOutfits(model: string): boolean {
  return model.startsWith(BASE_PREFIX) && !CREATURE_BODY_MODELS.includes(model.slice(BASE_PREFIX.length));
}

/* -------------------------------------------------------------------------- */
/* Hair — the one thing on a body the simulation chooses                        */
/* -------------------------------------------------------------------------- */

/**
 * Namespace for a mesh from *Universal Base Characters*' own `Hairstyles/` line.
 *
 * A fifth namespace rather than a sixth `outfit:` slot, for {@link PROP_PREFIX}'s reason one costume
 * over: hair is not a garment. It replaces no region of the body (the base bodies are bald — their
 * only head primitives are eyes and eyebrows), it hangs off a single joint, and it is the **only**
 * thing here chosen from a stored decision rather than derived from what a body is or wears.
 */
export const HAIR_PREFIX = 'hair:';

/**
 * The six hairstyle meshes staged into the character source, by their own file stems.
 *
 * Six of the pack's eight, and the two missing ones are a measurement rather than an oversight:
 * `Eyebrows_Regular` and `Eyebrows_Female` are already *inside* the base bodies — identical indices,
 * UVs, joints and weights, positions agreeing to 4.9e-7 m — so importing them would draw the same
 * 984 and 1,480 triangles twice on every character in the world. See `modelgen.characterKind`.
 */
export const HAIR_MODELS = [
  'Hair_Beard',
  'Hair_Buns',
  'Hair_Buzzed',
  'Hair_BuzzedFemale',
  'Hair_Long',
  'Hair_SimpleParted',
] as const;

export type HairModel = (typeof HAIR_MODELS)[number];

/**
 * One hairstyle as a player names it, and which mesh each body wears for it.
 *
 * **Two meshes per row where the vendor authored two**, and that is the whole reason this is a table
 * rather than a list of stems. Every hairstyle is weighted 100% to the `Head` joint, and the two base
 * rigs put that joint in different places (male `y = 1.5986, z = -0.0637`; female `1.5491, -0.0389`),
 * so a mesh authored against one skull sits ~50 mm out of place on the other. The vendor shipped the
 * buzz cut twice for exactly that reason — `Hair_Buzzed` and `Hair_BuzzedFemale` are the same 830
 * triangles refitted — and where they did, the fitted mesh is used and nothing is corrected.
 *
 * Where they did not, `client3d/src/body.ts` re-fits by binding the mesh with
 * `IBM_body(Head)⁻¹ · IBM_hair(Head)`, which is exact in the bone frame and measures within 8 mm of
 * the vendor's own refit of the style they did ship twice. So **every style is offered to every
 * body**, which matters more than it sounds: `mobpick.BODY_WORDS` has no `female` row that any player
 * hits, so a sex-split catalogue would have shown the owner three choices.
 */
export interface HairStyle {
  /** What a player types. Lower case, one word — the command matches on it. */
  readonly id: string;
  /** How it reads in prose: *"You tie your hair back into buns."* */
  readonly label: string;
  /** The mesh a female body wears. */
  readonly female: HairModel;
  /** The mesh a male body wears. */
  readonly male: HairModel;
}

/**
 * The catalogue, in the order `hair` lists it — **and the order is the numbering**, so it may be
 * appended to but not reshuffled: `hair 3` means the third row here.
 *
 * `bald` is not in it. Having no hair is the absence of a row rather than a row of its own, so
 * nothing has to invent an id for "no mesh" — see {@link BALD}.
 */
export const HAIR_STYLES: readonly HairStyle[] = [
  // The one row where the two halves differ, because it is the one style the vendor fitted twice.
  { id: 'buzzed', label: 'cropped short', female: 'Hair_BuzzedFemale', male: 'Hair_Buzzed' },
  { id: 'parted', label: 'parted at the side', female: 'Hair_SimpleParted', male: 'Hair_SimpleParted' },
  { id: 'long', label: 'worn long', female: 'Hair_Long', male: 'Hair_Long' },
  { id: 'buns', label: 'tied back into buns', female: 'Hair_Buns', male: 'Hair_Buns' },
  { id: 'beard', label: 'a beard and a bare scalp', female: 'Hair_Beard', male: 'Hair_Beard' },
];

/**
 * The style id that means **no hair mesh at all**, and the one id in the vocabulary that names no
 * file. A player may choose it; nothing rolls it.
 */
export const BALD = 'bald';

const HAIR_BY_ID: ReadonlyMap<string, HairStyle> = new Map(HAIR_STYLES.map((style) => [style.id, style]));

/** Every id `hair` accepts, in list order, with {@link BALD} last. */
export function hairStyleIds(): readonly string[] {
  return [...HAIR_STYLES.map((style) => style.id), BALD];
}

/** Whether a string is a hairstyle this build knows — the gate a stored save passes through. */
export function isHairStyle(id: string): boolean {
  return id === BALD || HAIR_BY_ID.has(id);
}

/** The catalogue row for an id, or nothing for {@link BALD} and for anything unrecognised. */
export function hairStyle(id: string): HairStyle | undefined {
  return HAIR_BY_ID.get(id);
}

/**
 * A 32-bit hash of a string. `fmix32` over the bytes — the same avalanche `roomScene.ts` uses, kept
 * local because `appearance.ts` imports nothing that does I/O or geometry.
 */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * The hairstyle a body has when nobody chose one — **a pure function of who it is, and never
 * {@link BALD}**.
 *
 * The owner's two requirements, and they pull in opposite directions: *nobody is bald*, and *two
 * guards in a room do not match*. A constant default satisfies the first and fails the second; a roll
 * satisfies the second and breaks `CLAUDE.md` rule 3. A hash of the body's own identity satisfies
 * both, and costs no seed to keep in step across processes — the same argument this module already
 * makes for every other field it derives.
 *
 * **What the seed is differs between a player and a mob, and it has to.** A player's is their
 * character name: it never changes, so the default they see on their first login is the default they
 * see for ever, which is what makes it *their* look rather than a lottery they can reroll by
 * reconnecting. A mob has no such identity — a hundred kobold youths share one name — so its seed is
 * the entity id, which is what puts five different heads of hair in the Cubs Den. `Simulation.viewOf`
 * picks the seed; this function only hashes it.
 *
 * The result is a style id and never a mesh, so the command, the save and the default all speak one
 * vocabulary.
 */
export function defaultHairFor(seed: string): string {
  return HAIR_STYLES[hashOf(seed) % HAIR_STYLES.length]!.id;
}

/* -------------------------------------------------------------------------- */
/* Scale — a child is not a short adult, but it is a smaller one                */
/* -------------------------------------------------------------------------- */

/**
 * How tall a body stands, as a multiple of the base mesh — the owner's ask, 2026-08-13: *"can we
 * scale down the size of the mobs when they are labeled as youth or child etc?"*
 *
 * `mobpick.BODY_WORDS` has answered *"is this a child"* for the whole population since the mob sweep
 * and the renderer has ignored it, so every one of the world's 86 `child` and 44 `teen` templates has
 * been drawn at a grown man's 1.81 m. The two numbers are heights rather than tastes: a human child
 * of eight or nine is about 1.30 m and a fourteen-year-old about 1.60 m, which against the male base
 * body's 1.81 m is 0.72 and 0.88.
 *
 * ## `muscular` is deliberately **1**, and this is the trap
 *
 * The obvious other half of the feature — make giants giant — cannot be written from this table,
 * because `BODY_WORDS.muscular` conflates *size* with *role*: its trigger list is `giant, ogre, troll,
 * brute, huge, massive, hulking, warrior, guard, champion`. Scaling that row up would inflate every
 * town guard in the world into an ogre. It is the same conflation the female-body fix walked into, and
 * the fix is the same shape: **split the row in `mobpick.ts` and re-run the sweep** before any number
 * but 1 goes here. Recorded as a gap rather than guessed at.
 *
 * `skeleton` and `zombie` are 1 for a plainer reason: they are adult bodies that have died.
 */
export const BODY_SCALE: Readonly<Record<string, number>> = {
  child: 0.72,
  teen: 0.88,
};

/** The multiple a `mobpick` body word draws at. 1 for every word without a row — including `muscular`. */
export function bodyScaleFor(bodyWord: string): number {
  return BODY_SCALE[bodyWord] ?? 1;
}

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
/* What is in the hands — M7b                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The four props from the *Fantasy Props MegaKit*, by their own file stems.
 *
 * Four, and the number is the coordinator's: a sword, an axe, a shield and a torch cover what a
 * hand in this world is usually doing, and every blunt instrument drawn as a sword would be a lie
 * repeated 687 times. The pack has more — this is the set M7b staged, and adding a mace is a row in
 * {@link WEAPON_ART}, a row in `modelgen`'s source directory and nothing else.
 */
export const WEAPON_MODELS = ['Axe_Bronze', 'Shield_Wooden', 'Sword_Bronze', 'Torch_Metal'] as const;

export type WeaponModel = (typeof WEAPON_MODELS)[number];

/**
 * Duris' weapon class to a mesh — `objmisc.h:363-384`, and the **only shape fact 98% of the
 * catalogue has**.
 *
 * This is the finding that decided the table's key. `GEAR_ART` keys on the art class `wornIds` puts
 * on the wire, and that works for garments because `artassign` has authored art for them. It does not
 * work for weapons: measured over `data/world/items.json`, **7,415 catalogue items sit in a hand slot
 * and 119 of them have any art id at all** — 102 shields and 17 bows, both through `artClassOf`'s own
 * fallbacks. Every other blade in the world arrives on the wire as `obj:1234`, a string with no shape
 * in it. `Item.weaponClass` is on the *instance*, is copied from the template at `instantiate`, and
 * covers 2,740 of those 7,415; and it is the same field the starter and class kits already fill (a
 * `dagger` is 2, a `broadsword` is 5), so one table serves both populations instead of two.
 *
 * **What is deliberately absent is most of the ladder**, and each absence is a mesh the pack does not
 * have rather than an oversight: bludgeon (`HAMMER` 4, `MACE` 6, `SPIKED_MACE` 7, `CLUB` 10,
 * `SPIKED_CLUB` 11, `STAFF` 12, `NUMCHUCKS` 20 — 687 items), `FLAIL` 3 and `WHIP` 14, `POLEARM` 8,
 * `SPEAR` 15, `LANCE` 16, `SICKLE` 17, `TRIDENT` 18 and `HORN` 19. A club drawn as a sword is a
 * character holding the wrong thing, which reads as a bug; an empty hand reads as a fist, which the
 * combat log will happily call a punch. **Empty beats wrong** — the same rule `GEAR_ART` states for
 * gloves and jewellery.
 */
export const WEAPON_ART: Readonly<Record<number, WeaponModel>> = {
  // WEAPON_AXE. The one haft-and-bit the pack has, and 135 catalogue items want it.
  1: 'Axe_Bronze',
  // WEAPON_DAGGER (659), WEAPON_LONGSWORD (516), WEAPON_SHORTSWORD (204), WEAPON_2HANDSWORD (219).
  // One blade for four lengths: `Sword_Bronze` is 1.13 m from pommel to point, which is a longsword,
  // and a dagger drawn at that size is the honest cost of a four-prop kit. Scaling per class is the
  // renderer's to do if it ever matters and is not a second id.
  2: 'Sword_Bronze',
  5: 'Sword_Bronze',
  9: 'Sword_Bronze',
  13: 'Sword_Bronze',
};

/**
 * What an **art class or kit id** in a hand means, when the weapon ladder has nothing to say.
 *
 * Two rows and both earn their place. `shield` is the string `artClassOf` hands out for every one of
 * the catalogue's shields (`DURIS_ITEM.shield`) *and* the literal id `equipment.ts` gives the
 * paladin's kite and the cleric's round — {@link STARTER_SHIELD_ID}, which that file exports for
 * exactly this kind of reason. A shield carries no `weaponClass`, so without this row the one thing
 * in the game that is unambiguously an off-hand object would draw nothing.
 *
 * `bow` is the launcher fallback `artClassOf` emits for the catalogue's 17 arrow-firers, and it is
 * here to be **explicitly refused**: the props kit has no bow, and an archer holding a sword would be
 * a worse lie than an archer holding nothing. Listed rather than omitted so the next reader knows it
 * was considered.
 */
export const HELD_ART: Readonly<Record<string, WeaponModel | undefined>> = {
  shield: 'Shield_Wooden',
  bow: undefined,
};

/**
 * One thing in one hand, as much of it as an appearance can use.
 *
 * Three fields and no item: `appearanceOf` is pure and knows no catalogue, so what reaches it is what
 * `Simulation.viewOf` can read off `actor.equipped` without one — the art class it already computed
 * for `wearing`, the weapon class the instance carries, and whether the thing burns.
 */
export interface HeldView {
  /** The same string `wearing[slot]` carries: an art class, a kit id, or a raw `obj:` id. */
  readonly art?: string;
  /** `Item.weaponClass`, Duris' own ladder. Absent on everything that is not a weapon. */
  readonly weaponClass?: number;
  /** `Item.light` — a torch, a lantern, a lit brand. Absent on everything that does not burn. */
  readonly light?: true;
}

/** What is in the two hands. Either half may be absent, and usually both are. */
export interface Hands {
  readonly main?: string;
  readonly off?: string;
}

/**
 * The mesh for one hand, or nothing — and **light wins**, because a lit thing is the most legible
 * object a character can hold in a dark room and the world's 64 light sources are mostly torches.
 *
 * Order after that is authored-first: an art class or kit id this module recognises beats the weapon
 * ladder, because the ladder is a *class* and the id is the *thing*. Then the ladder. Then nothing,
 * which is the answer for 5,527 of the catalogue's 7,415 hand-slot items and is the right one.
 */
function heldArt(held: HeldView | undefined): WeaponModel | undefined {
  if (!held) return undefined;
  if (held.light) return 'Torch_Metal';
  if (held.art !== undefined && held.art in HELD_ART) return HELD_ART[held.art];
  return held.weaponClass === undefined ? undefined : WEAPON_ART[held.weaponClass];
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
  /**
   * The hairstyle mesh, as a {@link HAIR_PREFIX} id. Absent for a bald body and for a `creature:` one.
   *
   * Beside `gear` rather than inside it, for the reason {@link Appearance.hands} is: a garment
   * replaces a region of the naked mesh and hair replaces nothing, so the renderer's cull
   * (`skin.hiddenMaskFor`) must never see it. A `hair` entry in the gear list would be one
   * `HIDDEN_BY_SLOT` row away from taking a character's face off.
   */
  readonly hair?: string;
  /**
   * How tall this body stands as a multiple of the base mesh — **absent when 1**, which is 2,761 of
   * the world's 2,891 bodies, so the field costs nothing on the wire for almost everybody.
   *
   * A pure function of the `mobpick` body word; see {@link BODY_SCALE} for the two rows and for why
   * `muscular` is not one of them.
   */
  readonly scale?: number;
  /**
   * What is held, as {@link PROP_PREFIX} ids — M7b. Absent when both hands are empty or unmapped.
   *
   * Beside `gear` rather than inside it for the same reason `GEAR_SLOTS` is not `EQUIP_SLOTS`: a
   * garment replaces a region of the body and a weapon hangs off a bone, so the renderer does two
   * different things with them and a single list would make it ask which kind each entry was.
   */
  readonly hands?: Hands;
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
  /**
   * What is in each hand — M7b, and the one input `wearing` cannot stand in for.
   *
   * `wearing` already carries a `mainHand` entry, so this looks redundant until you read what is in
   * it: `artClassOf(item) ?? item.id`, which for 98% of the catalogue's weapons is `obj:1234`. See
   * {@link WEAPON_ART} for the measurement and for why `Item.weaponClass` is the join key instead.
   *
   * **Filled for mobs as well as players since Phase 16.** It used to be players only, on the claim
   * that mobs carried no equipment list — which stopped being true the moment `reset.ts` began
   * executing the zone tables' `E` commands. An armed guard now holds what the builder gave it.
   */
  readonly holding?: { readonly main?: HeldView; readonly off?: HeldView };
  /**
   * The **stored** hairstyle id, when this body has one — the first appearance field the simulation
   * owns rather than derives.
   *
   * Filled from `PlayerRecord.hair` for a player and never for a mob, which has nowhere to keep a
   * choice. Absent, or naming a style this build does not know, both fall through to
   * {@link defaultHairFor} — so an old save loads and a renamed style degrades to the default instead
   * of to a bald character.
   */
  readonly hair?: string;
  /**
   * What {@link defaultHairFor} hashes when {@link hair} says nothing — a character name for a player,
   * an entity id for a mob. See that function for why the two differ.
   *
   * Empty means *no default at all*: the body is drawn bald. Nothing in the simulation passes empty;
   * it is what keeps `appearanceOf` a total function for a caller that has no identity to offer.
   */
  readonly hairSeed?: string;
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

  // Read before the animal branch, deliberately: a `child/wolf` is a wolf **cub**, and the placeholder
  // capsule `entities.ts` draws for it should be the smaller one. Scale is a fact about the body word
  // and the body word is on every sprite, mesh or no mesh.
  const scale = bodyScaleFor(body);
  const scaled = scale === 1 ? {} : { scale };

  // An animal, and we have no animal meshes. The class is the head shape the 2D sweep chose, so this
  // is a rename away from being a real model id the day one exists.
  //
  // **Only a shape the pack actually indexes may reach this branch**, which is `creature.ts`'s own
  // rule wearing 3D clothes: *"A bulk assignment of fifteen hundred rows will eventually contain a
  // typo, and the honest failure for one is one ordinary-looking guard."* `mobs.json` is 1,238
  // hand-editable rows, and without this test a mistyped `male/wolff` would not draw a wolf — it
  // would emit `creature:wolff`, an id nothing has ever staged, and turn one guard into a 404. So an
  // unrecognised word falls through to the person below, exactly as an unrecognised body does.
  // A head shape we have a **mesh** for. Read before both branches below, because it is more specific
  // than either: a kobold is not an animal (it would draw as a tinted capsule) and not a person (it
  // would draw as a 1.81 m human in peasant cloth), and the whole point of the row is to say so.
  //
  // Bare, exactly like the animal branch above and for a stronger reason: that one has nothing to hang
  // gear on, this one has a rig the gear does not fit. See `CREATURE_BODY_FOR`.
  const creature = CREATURE_BODY_FOR[head];
  if (creature) return { model: `${BASE_PREFIX}${creature}`, ...scaled };

  if (ANIMAL_HEADS.has(head)) {
    // No rig, so no gear, no hands and — the reason this is stated rather than assumed — no hair: a
    // wolf's placeholder is a tinted capsule and a hairstyle would have nothing to hang off.
    return { model: `${CREATURE_PREFIX}${head}`, ...scaled };
  }

  const sex = SEX_FOR_BODY_WORD[body] ?? 'male';
  const model = `${BASE_PREFIX}${BASE_BODY_FOR[sex]}`;

  // A player wears what the character sheet says. **A mob wears its template's cut even now that it
  // has a real equipment list**, and the reason changed in Phase 16 from "it has none" to a measured
  // one: harvested gear does not carry art.
  //
  // `playerGear` resolves a garment through its art class, and 98% of the catalogue arrives on the
  // wire as a bare `obj:1234` — a string `styleFrom` scans for words like "mail" and "plate" and,
  // finding none, calls **peasant**. So routing mobs through it would dress every guard in the world
  // in the same cloth *and* strip the 1,372 of 2,016 bodies that wear no chest piece down to bare
  // skin, because `playerGear` draws only what is actually worn. The template cut is chosen per
  // template by the mob sweep and is the better signal of the two until harvested armour has art.
  //
  // The hands are the opposite case and that is why they are not gated: `Item.weaponClass` is a real
  // shape fact on the instance, so a sword can be drawn as a sword without any art at all.
  const gear =
    subject.kind === 'player'
      ? playerGear(sex, subject.wearing)
      : mobGear(sex, STYLE_FOR_BODY_WORD[body] ?? 'peasant');

  // M7b. Built here rather than folded into `gear` — see `Appearance.hands`. `undefined` on both
  // halves collapses to no field at all, so a bare-handed character's payload is byte-identical to
  // the one M7a sent and a diff on the wire still means something changed.
  const main = heldArt(subject.holding?.main);
  const off = heldArt(subject.holding?.off);
  const hands: Hands | undefined =
    main || off
      ? { ...(main ? { main: `${PROP_PREFIX}${main}` } : {}), ...(off ? { off: `${PROP_PREFIX}${off}` } : {}) }
      : undefined;

  const hair = hairFor(sex, subject, gear);

  return {
    model,
    ...(gear.length > 0 ? { gear } : {}),
    ...(hair ? { hair } : {}),
    ...(hands ? { hands } : {}),
    ...scaled,
  };
}

/**
 * Which hair mesh goes on this body, or nothing.
 *
 * Three answers in order, and the first is the one worth reading:
 *
 * 1. **A hood hides hair.** The pack's only headwear is the ranger hood, and it is a closed mesh that
 *    wraps a skull — long hair drawn under it comes out through the cloth. So a body wearing anything
 *    in the `head` gear slot goes bare-headed under it, which is the same *empty beats wrong* rule
 *    `WEAPON_ART` states for the bow and `GEAR_ART` for gloves. Note that this can only fire for a
 *    **player**: `mobGear` deliberately never fills `head`.
 * 2. **A stored choice wins**, including {@link BALD} — which is the whole point of a stored choice,
 *    and the one way a character is bald on purpose.
 * 3. **Otherwise the identity's own default**, so nobody is accidentally bald.
 *
 * An id the catalogue does not recognise is treated as absent rather than as bald: a save written
 * against a style this build has since renamed should put *some* hair on the head.
 */
function hairFor(sex: BodySex, subject: AppearanceSubject, gear: readonly GearPart[]): string | undefined {
  if (gear.some((part) => part.slot === 'head')) return undefined;
  const chosen = subject.hair !== undefined && isHairStyle(subject.hair) ? subject.hair : undefined;
  if (chosen === BALD) return undefined;
  const id = chosen ?? (subject.hairSeed ? defaultHairFor(subject.hairSeed) : undefined);
  if (id === undefined) return undefined;
  const style = hairStyle(id);
  return style ? `${HAIR_PREFIX}${sex === 'female' ? style.female : style.male}` : undefined;
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
  // A creature with a mesh emits a `base:` id like any other body — the prefix says which pack a stem
  // belongs to, and the kobold's is the one `CharacterSet` loads. See `CREATURE_BODY_FOR`.
  const meshed = CREATURE_BODY_MODELS.map((stem) => `${BASE_PREFIX}${stem}`);
  const creatures = [...ANIMAL_HEADS].map((shape) => `${CREATURE_PREFIX}${shape}`);
  return [...bases, ...meshed, ...creatures].sort();
}

/** Every id it can emit for a *part*. Every one is a stem in {@link OUTFIT_PARTS}. */
export function everyGearPartId(): readonly string[] {
  return OUTFIT_PARTS.map((stem) => `${OUTFIT_PREFIX}${stem}`);
}

/** Every id it can emit for a **hand** — M7b, and the staging list for the props kit. */
export function everyWeaponId(): readonly string[] {
  return WEAPON_MODELS.map((stem) => `${PROP_PREFIX}${stem}`);
}

/**
 * Every id it can emit for **hair**, and the staging list for the six hairstyle meshes.
 *
 * Derived from {@link HAIR_STYLES} rather than from {@link HAIR_MODELS}, so a mesh that is staged but
 * that no style reaches shows up here as an absence — which is what `characters.test.ts` checks, and
 * the only way "we imported a hairstyle nobody can wear" is visible without opening the manifest.
 */
export function everyHairId(): readonly string[] {
  const out = new Set<string>();
  for (const style of HAIR_STYLES) {
    out.add(`${HAIR_PREFIX}${style.female}`);
    out.add(`${HAIR_PREFIX}${style.male}`);
  }
  return [...out].sort();
}
