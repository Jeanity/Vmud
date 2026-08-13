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

import { Matrix4, Vector3 } from 'three';

import {
  BASE_BODY_MODELS,
  CREATURE_BODY_MODELS,
  HAIR_MODELS,
  OUTFIT_PARTS,
  WEAPON_MODELS,
  everyGearPartId,
  everyHairId,
  everyModelId,
  everyWeaponId,
} from '@mygame/shared';

import { CLIPS } from './anim.ts';
import { CREATURE_LOOK, GRIP, stemOf } from './body.ts';
import {
  CHARACTER_MANIFEST_VERSION,
  HEAD_BONE,
  JOINT_COUNT,
  MAIN_HAND_BONE,
  OFF_HAND_BONE,
  type CharacterManifest,
} from './characters.ts';
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

/** Just enough of a glTF for the two joint checks below. Nothing here is a general reader. */
interface EmittedGltf {
  readonly accessors: { componentType: number; count: number; type: string; bufferView: number; byteOffset?: number }[];
  readonly bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
  readonly meshes: { primitives: { attributes: Record<string, number> }[] }[];
  readonly nodes: { name?: string }[];
  readonly skins?: { joints: number[]; inverseBindMatrices?: number }[];
}

function emitted(id: string): EmittedGltf {
  return JSON.parse(readFileSync(join(CHARACTERS_DIR, id, 'model.gltf'), 'utf8')) as EmittedGltf;
}

/** The armature a model binds, by name, in skeleton order — the join every rigged pack has to share. */
function jointNamesOf(id: string): string[] {
  const gltf = emitted(id);
  return (gltf.skins?.[0]?.joints ?? []).map((node) => gltf.nodes[node]?.name ?? '?');
}

/** A model's own inverse-bind matrix for `HEAD_BONE` — the number `HairTemplate.headInverse` keeps. */
function headInverseOf(id: string): Matrix4 {
  const gltf = emitted(id);
  const bin = readFileSync(join(CHARACTERS_DIR, id, 'model.bin'));
  const at = jointNamesOf(id).indexOf(HEAD_BONE);
  const accessor = gltf.accessors[gltf.skins![0]!.inverseBindMatrices!]!;
  const view = gltf.bufferViews[accessor.bufferView]!;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + at * 64;
  const elements = Array.from({ length: 16 }, (_, i) => bin.readFloatLE(start + i * 4));
  return new Matrix4().fromArray(elements);
}

/** The axis-aligned bounds of a model's first primitive, optionally transformed. */
function boundsOf(id: string, transform?: Matrix4): { readonly min: Vector3; readonly max: Vector3 } {
  const gltf = emitted(id);
  const bin = readFileSync(join(CHARACTERS_DIR, id, 'model.bin'));
  const accessor = gltf.accessors[gltf.meshes[0]!.primitives[0]!.attributes['POSITION']!]!;
  const view = gltf.bufferViews[accessor.bufferView]!;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const min = new Vector3(Infinity, Infinity, Infinity);
  const max = new Vector3(-Infinity, -Infinity, -Infinity);
  const point = new Vector3();
  for (let i = 0; i < accessor.count; i++) {
    point.set(bin.readFloatLE(start + i * 12), bin.readFloatLE(start + i * 12 + 4), bin.readFloatLE(start + i * 12 + 8));
    if (transform) point.applyMatrix4(transform);
    min.min(point);
    max.max(point);
  }
  return { min, max };
}

/**
 * `[jointIndex, weight]` for every influence on a model's first primitive.
 *
 * Reads the accessor through its buffer view honestly, stride and all, because a `JOINTS_0` is a
 * `Uint8Array` and a `WEIGHTS_0` a `Float32Array` and mixing them up would make this pass on nonsense.
 */
function weightsOf(id: string): [number, number][] {
  const gltf = emitted(id);
  const bin = readFileSync(join(CHARACTERS_DIR, id, 'model.bin'));
  const primitive = gltf.meshes[0]!.primitives[0]!;
  const read = (accessorIndex: number): number[] => {
    const accessor = gltf.accessors[accessorIndex]!;
    const view = gltf.bufferViews[accessor.bufferView]!;
    const at = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const out: number[] = [];
    for (let i = 0; i < accessor.count * 4; i++) {
      if (accessor.componentType === 5126) out.push(bin.readFloatLE(at + i * 4));
      else if (accessor.componentType === 5123) out.push(bin.readUInt16LE(at + i * 2));
      else out.push(bin.readUInt8(at + i));
    }
    return out;
  };
  const joints = read(primitive.attributes['JOINTS_0']!);
  const weights = read(primitive.attributes['WEIGHTS_0']!);
  return joints.map((joint, i) => [joint, weights[i] ?? 0]);
}

describe('the character key set', () => {
  it('gives the pool one material per atlas and no more', () => {
    assert.equal(new Set(CHARACTER_TEXTURES).size, CHARACTER_TEXTURES.length);
    // 14: twelve Quaternius atlases and two in-house, the kobold's and the troll's.
    assert.equal(CHARACTER_TEXTURES.length, 14);
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
    for (const id of [...everyGearPartId(), ...everyWeaponId(), ...everyHairId()]) {
      assert.ok(byStem.has(stemOf(id)), `nothing staged for ${id}`);
    }
    for (const stem of BASE_BODY_MODELS) assert.ok(byStem.has(stem), `no base body ${stem}`);
    // The in-house creatures ride the same manifest and are staged by the same run — see
    // `modelgen.CreatureImport`. A stem `appearanceOf` can emit and nothing staged is a mob that
    // silently keeps drawing as a capsule, which is the same failure as a missing garment.
    for (const stem of CREATURE_BODY_MODELS) assert.ok(byStem.has(stem), `no creature body ${stem}`);
    assert.equal(
      manifest.models.length,
      BASE_BODY_MODELS.length +
        OUTFIT_PARTS.length +
        WEAPON_MODELS.length +
        HAIR_MODELS.length +
        CREATURE_BODY_MODELS.length,
    );
    assert.equal(manifest.models.length, 34);
  });

  it('classifies every model, and the five kinds partition it', () => {
    const kinds = new Map<string, number>();
    for (const model of manifest.models) kinds.set(model.kind, (kinds.get(model.kind) ?? 0) + 1);
    assert.deepEqual([...kinds].sort(), [
      ['body', 2],
      ['creature', 2],
      ['hair', 6],
      ['outfit', 20],
      ['weapon', 4],
    ]);
  });

  it('staged no hairstyle nothing can wear, and wears none it did not stage', () => {
    // Both directions, because the two lists are written by hand in two packages. `HAIR_STYLES` names
    // meshes and the import stages files; a style naming a mesh nobody imported is a bald character,
    // and a mesh no style names is payload the player downloads to never see.
    const staged = manifest.models.filter((model) => model.kind === 'hair').map((model) => model.stem).sort();
    assert.deepEqual(staged, [...HAIR_MODELS].sort());
    assert.deepEqual(everyHairId().map((id) => stemOf(id)).sort(), staged);
  });

  it('leaves the eyebrows where they already are — inside the base bodies', () => {
    // The measurement that decided what *not* to import. `Eyebrows_Regular` and `Eyebrows_Female` are
    // the male and female bodies' own eyebrow primitives to within 4.9e-7 m, so staging them would
    // draw the same triangles twice on every character in the world. Asserted as an absence, because
    // the only way that decision survives is if somebody trying to "complete" the pack trips over it.
    for (const stem of ['Eyebrows_Regular', 'Eyebrows_Female']) {
      assert.ok(!byStem.has(stem), `${stem} was staged — it is already inside the base bodies`);
    }
    // And the eyebrows really are still drawn: each base body wears a hair atlas of its own.
    for (const stem of BASE_BODY_MODELS) {
      const textures = byStem.get(stem)!.parts.map((part) => part.texture);
      assert.ok(
        textures.some((texture) => texture.startsWith('hair-')),
        `${stem} has no eyebrow primitive`,
      );
    }
  });

  it('sits every hairstyle on a head rather than on the floor', () => {
    // A hairstyle is authored in the body's own space, not at the origin — the *Rigged to Head Bone*
    // line rather than *Origin at 0* — which is what lets `body.ts` hang it with one matrix and no
    // attachment code. The tell is `minY`: a scalp starts about a metre and a half up.
    for (const model of manifest.models.filter((entry) => entry.kind === 'hair')) {
      assert.ok(model.minY > 1.4 && model.minY < 1.7, `${model.stem} starts at y=${model.minY}`);
      assert.ok(model.height < 0.35, `${model.stem} is ${model.height} m of hair`);
    }
  });

  it('binds one armature: 65 joints on every Quaternius file and none on a prop', () => {
    // Join 2, and it is the risk §6-M7 flagged as *"if it's false, M7 roughly doubles into a
    // retargeting project"*. It is not false, and this is where it stays not false.
    //
    // **A creature is excluded by kind, not by exception.** The invariant was never "everything
    // skinned has 65 joints" — it is "every file that composes with every other one does", which is
    // what lets 20 garments and 16 clips be written once. A model that opts out of composition
    // (`BodyTemplate.composable`) is outside the claim, and saying so here is what keeps the claim
    // true rather than quietly widened.
    for (const model of manifest.models.filter((entry) => entry.kind !== 'creature')) {
      const wanted = model.kind === 'weapon' ? 0 : JOINT_COUNT;
      assert.equal(model.joints, wanted, `${model.stem} binds ${model.joints} joints`);
    }
  });

  it('gives each creature its own rig and its own clips, and never the shared ones', () => {
    // The other half of the sentence above. A creature that arrived with 65 joints would mean the
    // author had bound it to the Quaternius armature after all — which would be *good news*, and
    // would still be a change nobody had noticed, because `body.acquireRig` would go on handing it a
    // clip table it no longer needed. Either direction is worth a failing test.
    const creatures = manifest.models.filter((entry) => entry.kind === 'creature');
    assert.equal(creatures.length, CREATURE_BODY_MODELS.length);
    for (const model of creatures) {
      assert.ok(model.joints > 0, `${model.stem} is unrigged and would slide`);
      assert.notEqual(model.joints, JOINT_COUNT, `${model.stem} binds the shared armature after all`);
      // Its clips travel inside its own file, so the manifest is the one place their absence shows
      // without a GPU. `Idle_Loop` and `Walk_Loop` are the two the state machine cannot do without:
      // a body with neither stands in its bind pose whatever it is doing.
      const clips = new Set((model.clips ?? []).map((clip) => clip.name));
      for (const needed of ['Idle_Loop', 'Walk_Loop']) {
        assert.ok(clips.has(needed), `${model.stem} has no ${needed}`);
      }
      // Every clip it ships must be one the state machine actually asks for, or it is dead weight
      // in the download and a name somebody will reach for and not find.
      for (const clip of clips) assert.ok((CLIPS as readonly string[]).includes(clip), `${clip} is not a CLIPS name`);
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

  it('binds every hairstyle to the base bodies’ own armature, name for name and in order', () => {
    // The claim M7b's armature note makes about the outfit parts, checked for the fourth pack: the
    // hairstyles are not merely 65-jointed, they are *the same* 65 joints in the same order, which is
    // what lets a hair mesh bind to a body's skeleton at all. Read off the emitted files rather than
    // the manifest, because the manifest only counts.
    const reference = jointNamesOf('superhero-male-full-body');
    assert.equal(reference.length, JOINT_COUNT);
    assert.deepEqual(jointNamesOf('superhero-female-full-body'), reference, 'the two bodies disagree');
    for (const model of manifest.models.filter((entry) => entry.kind === 'hair')) {
      assert.deepEqual(jointNamesOf(model.id), reference, `${model.stem} binds a different armature`);
    }
  });

  it('weights every hairstyle wholly to the head, which is what the refit rests on', () => {
    // `HairTemplate.headInverse`'s premise. A hairstyle with any weight on the neck or the spine would
    // make `IBM_body(Head)⁻¹ · IBM_hair(Head)` a partial correction rather than an exact one, and the
    // error would show up as hair sliding off during a walk cycle rather than at rest.
    const head = jointNamesOf('superhero-male-full-body').indexOf(HEAD_BONE);
    assert.ok(head >= 0, 'no Head joint in the rig');
    for (const model of manifest.models.filter((entry) => entry.kind === 'hair')) {
      for (const [joint, weight] of weightsOf(model.id)) {
        if (weight <= 0.001) continue;
        assert.equal(joint, head, `${model.stem} puts weight on joint ${joint}, not the head`);
      }
    }
  });

  it('re-fits a hairstyle onto the other sex’s skull to within a centimetre', () => {
    // **The measurement the whole hair design rests on**, and the reason it is a test rather than a
    // sentence in a docblock. `body.ts` binds a cross-sex hairstyle with `IBM_body(Head)⁻¹ ·
    // IBM_hair(Head)`; the only way to know that is *right* is to run it against the one style the
    // vendor themselves fitted twice and see how close it lands to their answer.
    const male = headInverseOf('superhero-male-full-body');
    const female = headInverseOf('superhero-female-full-body');
    // The two skulls really are in different places, or none of this would be necessary.
    const apart = new Vector3().setFromMatrixPosition(male).sub(new Vector3().setFromMatrixPosition(female)).length();
    assert.ok(apart > 0.04, `the two rigs put Head ${apart.toFixed(3)} m apart — the refit would be pointless`);

    const refit = new Matrix4().copy(male).invert().multiply(female);
    const fitted = boundsOf('hair-buzzed');
    const carried = boundsOf('hair-buzzed-female', refit);
    const centre = (b: { min: Vector3; max: Vector3 }): Vector3 =>
      new Vector3().addVectors(b.min, b.max).multiplyScalar(0.5);
    const error = centre(carried).distanceTo(centre(fitted));
    assert.ok(error < 0.012, `the refit lands ${(error * 1000).toFixed(0)} mm from the vendor's own`);

    // …and doing nothing would not: this is the number the refit exists to remove.
    const naive = centre(boundsOf('hair-buzzed-female')).distanceTo(centre(fitted));
    assert.ok(naive > 0.03, `an unfitted mesh is only ${(naive * 1000).toFixed(0)} mm out`);
    assert.ok(error < naive / 3, 'the refit must be a large improvement, not a rounding one');

    // The native case is exact by construction, and that is what makes the common path free: a male
    // hairstyle's own head inverse is *byte-identical* to the male body's, so the refit is the
    // identity and the mesh is drawn exactly where the vendor put it.
    const own = headInverseOf('hair-buzzed');
    assert.deepEqual(own.elements, male.elements, 'a natively-fitted hairstyle must need no correction');
    // …to within the general matrix inverse's own noise once it has been through the same arithmetic.
    const identity = new Matrix4().copy(male).invert().multiply(own).elements;
    for (const [i, value] of identity.entries()) {
      assert.ok(Math.abs(value - new Matrix4().elements[i]!) < 1e-6, `element ${i} drifted to ${value}`);
    }
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
