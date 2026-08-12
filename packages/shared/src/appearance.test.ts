/**
 * What a body looks like in three dimensions — M7a.
 *
 * Three claims are worth more than the rest and they are the ones to read first.
 *
 * **Every id names a file.** The whole risk of this module is that a stem is *plausible* rather than
 * real: `Male_Ranger_Feet` reads perfectly and does not exist, because the vendor called it
 * `Male_Ranger_Feet_Boots`. A wrong stem is not a crash, it is a missing mesh in M7b's loader weeks
 * later, so the emit surface is walked exhaustively against the manifest here.
 *
 * **The head-shape partition is total.** A shape that is neither humanoid nor animal would fall to
 * whichever branch happened to be written second. `creaturegen` can add one at any time.
 *
 * **The answer is a function, not a roll.** `CLAUDE.md` rule 3's usual remedy is a seeded RNG; this
 * module needs none, and the test that says so is the one that would catch somebody adding a hash for
 * variety and quietly making two servers disagree about what a guard looks like.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BASE_PREFIX,
  CREATURE_PREFIX,
  GEAR_ART,
  GEAR_SLOTS,
  HELD_ART,
  HUMANOID_HEADS,
  OUTFIT_PARTS,
  OUTFIT_PREFIX,
  OUTFIT_STYLES,
  PROP_PREFIX,
  WEAPON_ART,
  WEAPON_MODELS,
  appearanceOf,
  everyGearPartId,
  everyModelId,
  everyWeaponId,
  type AppearanceSubject,
} from './appearance.ts';
import { BODY_SHAPES, HEAD_SHAPES } from './creature-art.ts';
import { EQUIP_SLOTS } from './equipment.ts';

const MANIFEST: ReadonlySet<string> = new Set([
  ...everyModelId(),
  ...everyGearPartId(),
]);

/** Every id in one appearance, model and parts together — what a manifest check has to cover. */
function idsIn(subject: AppearanceSubject): readonly string[] {
  const look = appearanceOf(subject);
  if (!look) return [];
  return [look.model, ...(look.gear ?? []).map((g) => g.part)];
}

describe('the manifest', () => {
  it('holds only stems the packs actually ship', () => {
    // Measured on disk 2026-08-13 out of the two zips under `assets/quaternius/`. The counts are
    // asserted rather than described because `HANDOFF.md` got them wrong in exactly the direction
    // that costs time — it reads "Female/Male x Peasant/Ranger/etc", and there is no etc.
    assert.equal(OUTFIT_PARTS.length, 20, 'the glTF line is 24 files: 20 modular parts + 4 assemblies');
    assert.equal(OUTFIT_STYLES.length, 2, 'Peasant and Ranger, and nothing else');
    assert.equal(new Set(OUTFIT_PARTS).size, OUTFIT_PARTS.length, 'no stem listed twice');
  });

  it('keeps the vendor’s two asymmetries, which a generated name would get wrong', () => {
    // `${sex}_${style}_${slot}` is the obvious implementation and it is wrong for two of twenty.
    // Widened, deliberately: `OUTFIT_PARTS` is `as const`, so `includes('Male_Ranger_Feet')` is a
    // *compile* error — which is a real second line of defence, and also the reason this has to be a
    // string comparison if it is to read as a test of the data rather than of the type.
    const parts: readonly string[] = OUTFIT_PARTS;
    assert.ok(parts.includes('Male_Ranger_Feet_Boots'), 'his boots carry the suffix');
    assert.ok(parts.includes('Female_Ranger_Feet'), 'hers do not');
    assert.ok(!parts.includes('Male_Ranger_Feet'), 'the plausible-but-absent stem');
    assert.ok(parts.includes('Male_Ranger_Acc_Pauldron'), 'his pauldron is singular');
    assert.ok(parts.includes('Female_Ranger_Acc_Pauldrons'), 'hers are plural');
  });

  it('says which pack every id came from', () => {
    for (const id of MANIFEST) {
      const prefixed =
        id.startsWith(BASE_PREFIX) || id.startsWith(OUTFIT_PREFIX) || id.startsWith(CREATURE_PREFIX);
      assert.ok(prefixed, `${id} carries no pack prefix`);
    }
  });
});

describe('the emit surface', () => {
  /**
   * Every sprite key the world can hold, crossed with every body word — the real population's
   * vocabulary rather than a sample, so a head shape or a body word the sweep can produce cannot
   * reach a stem nobody staged.
   */
  const everySprite: readonly string[] = [
    ...BODY_SHAPES.flatMap((body) => HEAD_SHAPES.map((head) => `${body}/${head}`)),
    // The unclassified case: 158 loaded templates and every player still carry the bare word.
    'human',
    '',
    'nonsense',
    '/leading-slash',
    'trailing-slash/',
  ];

  it('never emits an id outside the manifest, for any mob in the vocabulary', () => {
    for (const sprite of everySprite) {
      for (const id of idsIn({ kind: 'mob', sprite })) {
        assert.ok(MANIFEST.has(id), `mob ${JSON.stringify(sprite)} emitted ${id}, which is not staged`);
      }
    }
  });

  it('never emits an id outside the manifest, for any player wearing anything', () => {
    // Every wear slot crossed with every authored kit id *and* a few shapes the catalogue really
    // sends — an indexed art class, and a raw `obj:` id for the 16,000 entries with no art at all.
    const values = [...Object.keys(GEAR_ART), 'torso-clothes-tunic-black', 'obj:32', 'shield', 'bow'];
    for (const sprite of everySprite) {
      for (const slot of EQUIP_SLOTS) {
        for (const value of values) {
          const worn = { [slot]: value };
          for (const id of idsIn({ kind: 'player', sprite, wearing: worn })) {
            assert.ok(MANIFEST.has(id), `${slot}=${value} emitted ${id}, which is not staged`);
          }
        }
      }
    }
  });

  it('draws nothing at all for a ground object', () => {
    // A dropped sword has no body, which is why `wearing` and `posture` are already absent for one.
    assert.equal(appearanceOf({ kind: 'item', sprite: 'item_weapon' }), undefined);
  });
});

describe('the humanoid/animal partition', () => {
  it('classifies every head shape the pack has, one way or the other', () => {
    // The gap this guards: `creaturegen` adds a shape, nobody adds it here, and it silently becomes
    // a `creature:` id — a named NPC turning into a placeholder with no error anywhere.
    assert.ok(HEAD_SHAPES.length > 0, 'the index must have been generated');
    const beasts = HEAD_SHAPES.filter((s) => !HUMANOID_HEADS.has(s));
    assert.equal(HUMANOID_HEADS.size + beasts.length, HEAD_SHAPES.length + extraHumanoids().length);
    assert.deepEqual(beasts.slice().sort(), ['boarman', 'mouse', 'pig', 'rabbit', 'rat', 'sheep', 'wolf']);
  });

  /** Humanoid names not in the ULPC index, if any — kept explicit so the arithmetic above is honest. */
  function extraHumanoids(): readonly string[] {
    return [...HUMANOID_HEADS].filter((s) => !HEAD_SHAPES.includes(s));
  }

  it('adds no humanoid the pack does not have a head for', () => {
    assert.deepEqual(extraHumanoids(), [], 'HUMANOID_HEADS must be a subset of the indexed shapes');
  });

  it('sends an animal to the documented fallback and gives it no clothes', () => {
    const wolf = appearanceOf({ kind: 'mob', sprite: 'male/wolf' });
    assert.equal(wolf?.model, 'creature:wolf');
    assert.equal(wolf?.gear, undefined, 'there is no rig to hang a tunic on');
  });

  it('dresses a kobold as a person, because the 2D sweep already ruled it one', () => {
    // `mobpick.ts`: 42 of the world's 88 creature-named templates are kobolds and it heads them
    // `lizard`. A kobold is bipedal and clothed; it is not a `creature:`.
    const kobold = appearanceOf({ kind: 'mob', sprite: 'male/lizard' });
    assert.equal(kobold?.model, `${BASE_PREFIX}Superhero_Male_FullBody`);
    assert.ok((kobold?.gear ?? []).length > 0);
  });

  it('reads a body it was never given a key for as a person', () => {
    // The 158-template case, and the safe direction: a mob drawn as a human is wrong in a way a
    // player shrugs at; a person drawn as a missing-model placeholder is not.
    for (const sprite of ['human', '', 'nonsense']) {
      assert.ok(
        appearanceOf({ kind: 'mob', sprite })?.model.startsWith(BASE_PREFIX),
        `${JSON.stringify(sprite)} should be a person`,
      );
    }
  });
});

describe('determinism', () => {
  it('gives one template the same body every time it is asked', () => {
    // Two *constructions* rather than two calls, because the failure this guards against is a
    // module-level cache or a hash seeded from something that moves.
    const subject = (): AppearanceSubject => ({ kind: 'mob', sprite: 'muscular/human' });
    const first = appearanceOf(subject());
    const second = appearanceOf(subject());
    assert.deepEqual(first, second);
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(second)));
  });

  it('gives two players in the same kit byte-identical gear, in slot order', () => {
    // Object key order is insertion order in V8, so a player who wore boots before a tunic would
    // otherwise produce a different payload from one who dressed the other way round — and every
    // `entityUpdate` would look like a change.
    const boots_first = appearanceOf({
      kind: 'player',
      sprite: 'human',
      wearing: { feet: 'travel_boots', chest: 'mail_shirt', legs: 'rough_breeches' },
    });
    const tunic_first = appearanceOf({
      kind: 'player',
      sprite: 'human',
      wearing: { chest: 'mail_shirt', legs: 'rough_breeches', feet: 'travel_boots' },
    });
    assert.equal(JSON.stringify(boots_first), JSON.stringify(tunic_first));
    const slots = (boots_first?.gear ?? []).map((g) => g.slot);
    assert.deepEqual(slots, slots.slice().sort((a, b) => GEAR_SLOTS.indexOf(a) - GEAR_SLOTS.indexOf(b)));
  });

  it('varies the body only with the sprite key, never with the call', () => {
    const male = appearanceOf({ kind: 'mob', sprite: 'male/human' })?.model;
    const female = appearanceOf({ kind: 'mob', sprite: 'female/human' })?.model;
    assert.equal(male, `${BASE_PREFIX}Superhero_Male_FullBody`);
    assert.equal(female, `${BASE_PREFIX}Superhero_Female_FullBody`);
    assert.notEqual(male, female);
  });
});

describe('a mob’s clothes come out of the 2D sweep', () => {
  const styleOf = (sprite: string): string | undefined =>
    appearanceOf({ kind: 'mob', sprite })?.gear?.find((g) => g.slot === 'torso')?.part;

  it('puts the martial body in the ranger’s leathers and everyone else in the peasant’s', () => {
    // `mobpick.BODY_WORDS.muscular` is literally `giant, ogre, troll, brute, huge, massive, hulking,
    // warrior, guard, champion` — the split is the sweep's, not one invented here.
    assert.equal(styleOf('muscular/human'), `${OUTFIT_PREFIX}Male_Ranger_Body`);
    assert.equal(styleOf('male/human'), `${OUTFIT_PREFIX}Male_Peasant_Body`);
    assert.equal(styleOf('child/human'), `${OUTFIT_PREFIX}Male_Peasant_Body`);
    assert.equal(styleOf('female/human'), `${OUTFIT_PREFIX}Female_Peasant_Body`);
  });

  it('dresses the four garment slots and leaves the two accessories off', () => {
    // The hood and the pauldrons are the ranger's *distinguishing* pieces; on all 1,238 classified
    // templates they would make every guard in the world one hooded silhouette.
    const gear = appearanceOf({ kind: 'mob', sprite: 'muscular/human' })?.gear ?? [];
    assert.deepEqual(gear.map((g) => g.slot), ['torso', 'arms', 'legs', 'feet']);
  });

  it('never leaves a mob naked', () => {
    for (const body of BODY_SHAPES) {
      const gear = appearanceOf({ kind: 'mob', sprite: `${body}/human` })?.gear ?? [];
      assert.equal(gear.length, 4, `${body} should be dressed`);
    }
  });
});

describe('a player’s clothes come off the character sheet', () => {
  const partsOf = (wearing: Record<string, string>): Record<string, string> => {
    const gear = appearanceOf({ kind: 'player', sprite: 'human', wearing })?.gear ?? [];
    return Object.fromEntries(gear.map((g) => [g.slot, g.part]));
  };

  it('puts a mail shirt on the torso, and takes it off again', () => {
    // The completion test of the equipment half, in the two states that matter.
    const dressed = partsOf({ chest: 'mail_shirt' });
    assert.equal(dressed['torso'], `${OUTFIT_PREFIX}Male_Ranger_Body`);
    const bare = partsOf({});
    assert.equal(bare['torso'], undefined, 'removing it must remove the mesh');
    assert.equal(appearanceOf({ kind: 'player', sprite: 'human', wearing: {} })?.gear, undefined);
  });

  it('is naked with no kit at all, rather than falling back to a mob’s outfit', () => {
    // The branch that would be easiest to get wrong: a fresh or stripped character must not inherit
    // the peasant set every mob gets, or `remove` would visibly do nothing.
    assert.equal(appearanceOf({ kind: 'player', sprite: 'human' })?.gear, undefined);
  });

  it('maps each authored kit id to the slot and cut its material says', () => {
    assert.equal(partsOf({ chest: 'leather_tunic' })['torso'], `${OUTFIT_PREFIX}Male_Ranger_Body`);
    assert.equal(partsOf({ chest: 'quilted_vest' })['torso'], `${OUTFIT_PREFIX}Male_Peasant_Body`);
    assert.equal(partsOf({ legs: 'leather_leggings' })['legs'], `${OUTFIT_PREFIX}Male_Ranger_Legs`);
    assert.equal(partsOf({ legs: 'rough_breeches' })['legs'], `${OUTFIT_PREFIX}Male_Peasant_Legs`);
    assert.equal(partsOf({ feet: 'travel_boots' })['feet'], `${OUTFIT_PREFIX}Male_Ranger_Feet_Boots`);
    assert.equal(partsOf({ feet: 'worn_shoes' })['feet'], `${OUTFIT_PREFIX}Male_Peasant_Feet`);
    assert.equal(partsOf({ head: 'cloth_hood' })['head'], `${OUTFIT_PREFIX}Male_Ranger_Head_Hood`);
  });

  it('reads an armour word out of an unmapped art class', () => {
    // The catalogue's 16,421 entries cannot each have a row, so the fallback keys on the wear slot
    // and reads the cut off the art id's own words.
    assert.equal(partsOf({ chest: 'torso-chainmail' })['torso'], `${OUTFIT_PREFIX}Male_Ranger_Body`);
    assert.equal(partsOf({ chest: 'torso-clothes-tunic-black' })['torso'], `${OUTFIT_PREFIX}Male_Peasant_Body`);
    assert.equal(partsOf({ chest: 'obj:32' })['torso'], `${OUTFIT_PREFIX}Male_Peasant_Body`);
  });

  it('draws nothing for the slots the pack has no mesh for', () => {
    // Sixteen of twenty-four, and each absence is a real gap: no gloves, no belts, no jewellery, and
    // nothing held. `KIT_ART`'s own contract — an id with no row simply does not draw.
    const silent: readonly string[] = [
      'eyes', 'face', 'nose', 'ear1', 'ear2', 'neck', 'neck2', 'hands', 'mainHand',
      'offHand', 'waist', 'wrist1', 'wrist2', 'ring1', 'ring2', 'quiver', 'ioun',
    ];
    for (const slot of silent) {
      assert.deepEqual(partsOf({ [slot]: 'work_gloves' }), {}, `${slot} must draw nothing`);
      assert.deepEqual(partsOf({ [slot]: 'shield' }), {}, `${slot} must draw nothing`);
    }
    assert.equal(silent.length + Object.keys({ chest: 0, arms: 0, legs: 0, feet: 0, head: 0, back: 0, about: 0 }).length, EQUIP_SLOTS.length);
  });

  it('lets one attachment point be claimed once, in slot order', () => {
    // `back` and `about` both hang on the shoulders. Two meshes on one bone is a renderer bug; the
    // rule is enforced here, where it is testable.
    const gear = appearanceOf({
      kind: 'player',
      sprite: 'human',
      wearing: { back: 'obj:1', about: 'obj:2' },
    })?.gear ?? [];
    assert.equal(gear.filter((g) => g.slot === 'shoulders').length, 1);
  });

  it('gives a chest garment its own sleeves, because the pack cuts them as one', () => {
    // Found by printing a real `viewOf` payload rather than by reasoning: `rollStarterKit` fills
    // head, chest, hands, legs and feet, and **no kit in the game fills `arms`** — so without this
    // every player was sleeveless while every mob, which gets the whole cut, had sleeves.
    const gear = partsOf({ chest: 'padded_jerkin' });
    assert.equal(gear['torso'], `${OUTFIT_PREFIX}Male_Ranger_Body`);
    assert.equal(gear['arms'], `${OUTFIT_PREFIX}Male_Ranger_Arms`, 'the sleeves follow the cut');
  });

  it('lets a real arms item outrank the sleeves the chest would have brought', () => {
    const gear = partsOf({ chest: 'mail_shirt', arms: 'torso-clothes-tunic-black' });
    assert.equal(gear['torso'], `${OUTFIT_PREFIX}Male_Ranger_Body`);
    assert.equal(gear['arms'], `${OUTFIT_PREFIX}Male_Peasant_Arms`, 'what is worn wins');
  });

  it('grows no sleeves from nothing', () => {
    // The bare-legs case must stay bare: only a *chest* piece implies arms.
    assert.equal(partsOf({ legs: 'rough_breeches' })['arms'], undefined);
    assert.equal(partsOf({})['arms'], undefined);
  });

  it('dresses a female player from the female set', () => {
    const gear = appearanceOf({
      kind: 'player',
      sprite: 'female/human',
      wearing: { chest: 'leather_tunic', feet: 'travel_boots' },
    })?.gear ?? [];
    assert.deepEqual(gear.map((g) => g.part), [
      `${OUTFIT_PREFIX}Female_Ranger_Body`,
      // The sleeves the tunic brings with it — and hers, not his.
      `${OUTFIT_PREFIX}Female_Ranger_Arms`,
      `${OUTFIT_PREFIX}Female_Ranger_Feet`,
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* M7b — what is in the hands                                                  */
/* -------------------------------------------------------------------------- */

describe('what a body is holding', () => {
  const hands = (holding: AppearanceSubject['holding']): { main?: string; off?: string } =>
    appearanceOf({ kind: 'player', sprite: 'human', ...(holding ? { holding } : {}) })?.hands ?? {};

  it('emits nothing at all for two empty hands, so an unarmed payload is M7a’s to the byte', () => {
    const bare = appearanceOf({ kind: 'player', sprite: 'human' });
    assert.equal(bare?.hands, undefined);
    assert.equal(appearanceOf({ kind: 'player', sprite: 'human', holding: {} })?.hands, undefined);
    // A hand holding something the pack has no mesh for is the same as an empty one.
    assert.equal(hands({ main: { weaponClass: 6 } }).main, undefined, 'a mace has no mesh');
  });

  it('draws the four blade classes as the one sword the pack has', () => {
    // WEAPON_DAGGER 2, WEAPON_LONGSWORD 5, WEAPON_SHORTSWORD 9, WEAPON_2HANDSWORD 13 — 1,598 of the
    // catalogue's hand-slot items between them. One blade for four lengths is the honest cost of a
    // four-prop kit, and is stated in `WEAPON_ART` rather than hidden.
    for (const weaponClass of [2, 5, 9, 13]) {
      assert.equal(hands({ main: { weaponClass } }).main, `${PROP_PREFIX}Sword_Bronze`, `class ${weaponClass}`);
    }
    assert.equal(hands({ main: { weaponClass: 1 } }).main, `${PROP_PREFIX}Axe_Bronze`);
  });

  it('leaves the hand empty for every class the pack has no mesh for', () => {
    // Bludgeon (4, 6, 7, 10, 11, 12, 20), flail 3, whip 14, polearm 8, spear 15, lance 16, sickle 17,
    // trident 18, horn 19. **Empty beats wrong**: a club drawn as a sword reads as a bug, an empty
    // hand reads as a fist, and the combat log will happily call that a punch.
    for (const weaponClass of [0, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20]) {
      assert.equal(hands({ main: { weaponClass } }).main, undefined, `class ${weaponClass} drew something`);
    }
  });

  it('knows a shield by the one string the whole game calls one', () => {
    // `artClassOf`'s catalogue fallback and `equipment.STARTER_SHIELD_ID` are both the literal
    // `'shield'`, so one row covers the paladin's kite, the cleric's round and all 102 in the
    // catalogue — none of which carries a `weaponClass` at all.
    assert.equal(hands({ off: { art: 'shield' } }).off, `${PROP_PREFIX}Shield_Wooden`);
    assert.equal(HELD_ART['shield'], 'Shield_Wooden');
  });

  it('refuses the bow explicitly rather than by omission', () => {
    // The props kit has no bow, and an archer holding a sword is a worse lie than an archer holding
    // nothing. Listed in `HELD_ART` as `undefined` so the next reader knows it was considered.
    assert.ok('bow' in HELD_ART);
    assert.equal(hands({ main: { art: 'bow', weaponClass: 5 } }).main, undefined, 'the row must beat the ladder');
  });

  it('puts a light in the hand ahead of anything else', () => {
    // A lit thing is the most legible object a character can hold in a dark room, and the catalogue's
    // 53 hand-slot lights are mostly torches.
    assert.equal(hands({ main: { light: true } }).main, `${PROP_PREFIX}Torch_Metal`);
    assert.equal(hands({ main: { light: true, weaponClass: 5 } }).main, `${PROP_PREFIX}Torch_Metal`, 'a burning sword burns');
  });

  it('fills both hands independently', () => {
    const both = hands({ main: { weaponClass: 5 }, off: { art: 'shield' } });
    assert.deepEqual(both, { main: `${PROP_PREFIX}Sword_Bronze`, off: `${PROP_PREFIX}Shield_Wooden` });
    // One hand only emits one key, so a diff on the wire still means something changed.
    assert.deepEqual(hands({ off: { art: 'shield' } }), { off: `${PROP_PREFIX}Shield_Wooden` });
  });

  it('gives a mob empty hands, exactly as it gives one no `wearing`', () => {
    // Mobs carry no equipment list, so `viewOf` hands `appearanceOf` no `holding` for one. Stated as
    // a test because it is a *gap* — Phase 16's, when mobs have gear worth taking off them.
    const guard = appearanceOf({ kind: 'mob', sprite: 'muscular/human' });
    assert.ok(guard?.gear, 'a mob is still dressed from its template');
    assert.equal(guard?.hands, undefined);
  });

  it('emits only ids the props kit actually has', () => {
    const staged = new Set(everyWeaponId());
    assert.equal(staged.size, WEAPON_MODELS.length);
    for (const model of Object.values(WEAPON_ART)) {
      assert.ok(staged.has(`${PROP_PREFIX}${model}`), `${model} is not in WEAPON_MODELS`);
    }
    for (const model of Object.values(HELD_ART)) {
      if (model) assert.ok(staged.has(`${PROP_PREFIX}${model}`), `${model} is not in WEAPON_MODELS`);
    }
    // Sword, axe, shield, torch — and the sword's four classes make the *ladder* bigger than the set.
    assert.deepEqual([...WEAPON_MODELS].sort(), ['Axe_Bronze', 'Shield_Wooden', 'Sword_Bronze', 'Torch_Metal']);
  });

  it('says nothing about hands for a ground object', () => {
    assert.equal(appearanceOf({ kind: 'item', sprite: 'human', holding: { main: { weaponClass: 5 } } }), undefined);
  });
});
