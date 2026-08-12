/**
 * The character import's contract with the wire, with the pool, and with the state machine.
 *
 * `kit.test.ts`'s argument, one pack over: the same facts exist in three places — `appearance.ts`'s
 * emitted ids, `prototypes.ts`'s key set, and the generated `manifest.json` — and a duplicated fact is
 * two facts the moment nobody checks. This file is the check, and it asserts the four joins the whole
 * milestone rides on:
 *
 * 1. **Every id the server can put on the wire names a model in the manifest.** `appearanceOf` emits
 *    `base:Superhero_Male_FullBody`, `outfit:Male_Ranger_Feet_Boots` and `prop:Sword_Bronze`; the
 *    renderer joins on the stem, asymmetries and all. A missing one is an invisible character.
 * 2. **One armature.** Every rigged model binds 65 joints, and both animation libraries do too.
 * 3. **Every clip `anim.ts` names was cut into a library**, and none was cut that nothing plays.
 * 4. The pool key set and the manifest agree about which textures exist.
 *
 * Skips cleanly when `public/models/characters` is absent: it is git-ignored and reproducible with
 * `node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --characters --source <packs>`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { BASE_BODY_MODELS, OUTFIT_PARTS, WEAPON_MODELS, everyGearPartId, everyModelId, everyWeaponId } from '@mygame/shared';

import { CLIPS } from './anim.ts';
import { CREATURE_LOOK, GRIP, stemOf } from './body.ts';
import { CHARACTER_MANIFEST_VERSION, JOINT_COUNT, MAIN_HAND_BONE, OFF_HAND_BONE, type CharacterManifest } from './characters.ts';
import { CHARACTER_PROP_TEXTURES, CHARACTER_TEXTURES } from './prototypes.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHARACTERS_DIR = join(PACKAGE_ROOT, 'public', 'models', 'characters');

/**
 * The whole import's budget, in bytes.
 *
 * **Forty-five megabytes, and like the nature kit's forty it is a ceiling rather than a target.** The
 * measured import is 35.0 MB: 7.1 MB of glTF + bin, 25.0 MB of PNG and 2.0 MB of re-cut animation.
 * The PNG is 71% of it and is uncompressed on the brief's own deferral of Draco/KTX2/meshopt — two
 * 4096² atlases (`peasant` 4.9 MB, `ranger` 6.5 MB) are a third of the whole milestone's payload on
 * their own. **When the compression slice lands this number should fall by most of itself**, and the
 * character atlases are the first candidates, ahead of the nature kit's.
 */
const CHARACTER_BUDGET = 45 * 1024 * 1024;

describe('the character key set', () => {
  it('gives the pool one material per atlas and no more', () => {
    assert.equal(new Set(CHARACTER_TEXTURES).size, CHARACTER_TEXTURES.length);
    assert.equal(CHARACTER_TEXTURES.length, 12);
    // The disjointness `pool.programKeyOf` relies on to answer "is this material's object skinned".
    for (const prop of CHARACTER_PROP_TEXTURES) {
      assert.ok((CHARACTER_TEXTURES as readonly string[]).includes(prop), `${prop} is not a character atlas`);
    }
    assert.equal(CHARACTER_PROP_TEXTURES.size, 3, 'the props kit ships three trims');
  });

  it('names a grip for every prop the server can put in a hand, and no others', () => {
    assert.deepEqual(Object.keys(GRIP).sort(), [...WEAPON_MODELS].sort());
    // The shield is the one that turns; the three shafted props ride the forearm at identity.
    assert.equal(GRIP['Shield_Wooden']!.rx, -Math.PI / 2);
    for (const stem of ['Sword_Bronze', 'Axe_Bronze', 'Torch_Metal']) assert.equal(GRIP[stem]!.rx, 0);
  });

  it('strips a prefix without touching the vendor’s own spelling', () => {
    assert.equal(stemOf('outfit:Male_Ranger_Feet_Boots'), 'Male_Ranger_Feet_Boots');
    assert.equal(stemOf('base:Superhero_Female_FullBody'), 'Superhero_Female_FullBody');
    assert.equal(stemOf('prop:Sword_Bronze'), 'Sword_Bronze');
    assert.equal(stemOf('Sword_Bronze'), 'Sword_Bronze', 'an unprefixed id is already a stem');
  });

  it('has a placeholder look only for shapes `appearanceOf` can actually emit', () => {
    // The table is interim by construction: the day a monster pack lands and these become real
    // models, every row here is dead code that a reader can see is dead.
    const creatures = everyModelId()
      .filter((id) => id.startsWith('creature:'))
      .map((id) => stemOf(id));
    for (const shape of Object.keys(CREATURE_LOOK)) {
      assert.ok(creatures.includes(shape), `${shape} is not a creature the server can emit`);
    }
    // Not every emittable shape needs a row — the default is the point — but a wolf must have one,
    // because it is the most common animal in the world and the one a grey pill reads worst as.
    assert.ok(CREATURE_LOOK['wolf']);
  });
});

describe('the imported characters', () => {
  if (!existsSync(CHARACTERS_DIR)) {
    it('skips: the character packs have not been imported', (t) => {
      t.skip(
        `no characters at ${CHARACTERS_DIR} — run ` +
          '`node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --characters --source <packs>`',
      );
    });
    return;
  }

  const manifest = JSON.parse(readFileSync(join(CHARACTERS_DIR, 'manifest.json'), 'utf8')) as CharacterManifest;
  const byStem = new Map(manifest.models.map((model) => [model.stem, model]));

  it('is the version this client reads, and says what made it', () => {
    assert.equal(manifest.version, CHARACTER_MANIFEST_VERSION);
    assert.ok(manifest.generator.includes('Quaternius'));
  });

  it('holds a model for every id the server can put on the wire', () => {
    // Join 1, and the reason `stem` is in the manifest at all: the vendor's naming is inconsistent in
    // exactly two places (`Male_Ranger_Feet_Boots` where hers is `Feet`, his `Acc_Pauldron` where hers
    // is plural), so a renderer that re-derived the name would 404 on two of twenty.
    for (const id of [...everyGearPartId(), ...everyWeaponId()]) {
      assert.ok(byStem.has(stemOf(id)), `nothing staged for ${id}`);
    }
    for (const stem of BASE_BODY_MODELS) assert.ok(byStem.has(stem), `no base body ${stem}`);
    assert.equal(manifest.models.length, BASE_BODY_MODELS.length + OUTFIT_PARTS.length + WEAPON_MODELS.length);
    assert.equal(manifest.models.length, 26);
  });

  it('classifies every model, and the three kinds partition it', () => {
    const kinds = new Map<string, number>();
    for (const model of manifest.models) kinds.set(model.kind, (kinds.get(model.kind) ?? 0) + 1);
    assert.deepEqual([...kinds].sort(), [
      ['body', 2],
      ['outfit', 20],
      ['weapon', 4],
    ]);
  });

  it('binds one armature: 65 joints on every rigged file and none on a prop', () => {
    // Join 2, and it is the risk §6-M7 flagged as *"if it's false, M7 roughly doubles into a
    // retargeting project"*. It is not false, and this is where it stays not false.
    for (const model of manifest.models) {
      const wanted = model.kind === 'weapon' ? 0 : JOINT_COUNT;
      assert.equal(model.joints, wanted, `${model.stem} binds ${model.joints} joints`);
    }
  });

  it('stands its bodies on the ground, at the height the world was built for', () => {
    for (const stem of BASE_BODY_MODELS) {
      const body = byStem.get(stem)!;
      // M5a's tree rule for a person: the lowest vertex is the sole of the foot, so the rig's origin
      // goes straight onto the ground height and nothing is lifted.
      assert.ok(Math.abs(body.minY) < 0.02, `${stem} sinks ${body.minY} m below its own origin`);
      // ~1.8 m against a 9 m room, which is `DIMENSIONS.bodyHeight` to within a centimetre — the
      // capsule it replaces was already the right size, so nothing is rescaled on disk or in the rig.
      assert.ok(body.height > 1.7 && body.height < 1.9, `${stem} is ${body.height} m tall`);
    }
  });

  it('names every texture the pool built a material for, and nothing it did not', () => {
    assert.deepEqual(
      manifest.textures.map((texture) => texture.id).sort(),
      [...CHARACTER_TEXTURES].sort(),
      'the pool key set and the import disagree about which atlases exist',
    );
    for (const model of manifest.models) {
      for (const part of model.parts) {
        assert.ok((CHARACTER_TEXTURES as readonly string[]).includes(part.texture), `${model.stem} wears ${part.texture}`);
      }
    }
  });

  it('cut both animation libraries to exactly what the state machine plays', () => {
    // Join 3, in both directions. A clip the machine names and the pack did not ship is a body that
    // freezes; a clip shipped that nothing plays is payload the player downloads for nothing.
    const libraries = manifest.animations ?? [];
    assert.equal(libraries.length, 2, 'both UAL volumes');
    const shipped = libraries.flatMap((library) => library.clips.map((clip) => clip.name));
    assert.deepEqual(shipped.slice().sort(), [...CLIPS].sort());
    for (const clip of libraries.flatMap((library) => library.clips)) {
      assert.ok(clip.duration > 0.1, `${clip.name} is ${clip.duration} s`);
      // 65 joints x translation/rotation/scale, on every clip in both volumes.
      assert.equal(clip.channels, JOINT_COUNT * 3, `${clip.name} has ${clip.channels} channels`);
    }
  });

  it('threw away most of both libraries, which is the point of cutting them', () => {
    for (const library of manifest.animations ?? []) {
      assert.ok(library.sourceClips >= 43, `${library.id} came from ${library.sourceClips} clips`);
      assert.ok(library.clips.length < library.sourceClips / 2, `${library.id} kept too much`);
      // Both come in over 7 MB and leave under 2.
      assert.ok(library.sourceBytes > 7 * 1024 * 1024);
      assert.ok(library.bytes < 2 * 1024 * 1024, `${library.id} is ${(library.bytes / 1024 / 1024).toFixed(2)} MiB`);
    }
  });

  it('names the two hand bones the rig hangs props off', () => {
    // Right hand main, left off — `space.ts`'s frame: a body's rest forward is `-Z`, so its left is
    // `+X`, and `hand_l` measures at x = +0.706 in the bind pose.
    assert.equal(MAIN_HAND_BONE, 'hand_r');
    assert.equal(OFF_HAND_BONE, 'hand_l');
    const body = JSON.parse(readFileSync(join(CHARACTERS_DIR, 'superhero-male-full-body', 'model.gltf'), 'utf8')) as {
      skins: { joints: number[] }[];
      nodes: { name?: string }[];
    };
    const names = body.skins[0]!.joints.map((node) => body.nodes[node]!.name);
    for (const bone of [MAIN_HAND_BONE, OFF_HAND_BONE]) assert.ok(names.includes(bone), `no ${bone} in the rig`);
  });

  it('keeps the skin in the emitted glTF, which is the thing the rewrite used to drop', () => {
    for (const model of manifest.models) {
      const text = readFileSync(join(CHARACTERS_DIR, model.id, 'model.gltf'), 'utf8');
      const gltf = JSON.parse(text) as { skins?: unknown[]; nodes?: { skin?: number }[] };
      if (model.kind === 'weapon') {
        assert.equal(gltf.skins, undefined, `${model.stem} has no rig and should carry no skins array`);
        continue;
      }
      // A node naming a `skins` array the document does not have is a `GLTFLoader` throw, not an
      // untextured mesh — which is why this is asserted per model rather than argued once.
      assert.equal(gltf.skins?.length, 1, `${model.stem} lost its skin in the rewrite`);
      const referenced = (gltf.nodes ?? []).some((node) => node.skin !== undefined);
      assert.ok(referenced, `${model.stem} has a skin nothing uses`);
    }
  });

  it('ships nothing on disk the manifest does not list, and stays inside its budget', () => {
    const expected = new Set(['manifest.json', 'ATTRIBUTION.md']);
    for (const model of manifest.models) expected.add(model.id);
    expected.add('textures');
    expected.add('animations');
    assert.deepEqual(readdirSync(CHARACTERS_DIR).sort(), [...expected].sort());

    let bytes = 0;
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else bytes += statSync(path).size;
      }
    };
    walk(CHARACTERS_DIR);
    assert.ok(bytes < CHARACTER_BUDGET, `${(bytes / 1024 / 1024).toFixed(1)} MiB of characters`);
    // …and the animation half really is the small half, which is what `buildAnimationLibrary` bought.
    const animation = (manifest.animations ?? []).reduce((n, library) => n + library.bytes, 0);
    assert.ok(animation < bytes * 0.1, `animation is ${((animation / bytes) * 100).toFixed(0)}% of the import`);
  });
});
