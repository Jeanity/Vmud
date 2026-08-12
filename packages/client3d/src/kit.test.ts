/**
 * The kit's contract with the pool, in both directions.
 *
 * `prototypes.ts` enumerates the kit's models, their primitives and their textures **at module
 * load**, because that is the only way the material and geometry key sets stay a fact about the
 * program rather than a habit the loader keeps. That means the same facts exist twice — once in
 * `KIT_PART_TEXTURES` and once in the generated `manifest.json` — and a duplicated fact is two facts
 * the moment nobody checks. This file is the check, and it is `assets.test.ts`'s argument applied to
 * the second producer:
 *
 * 1. **Every model this package has a key for is in the manifest**, with the primitives it expects
 *    and the textures it expects. A kit model renamed upstream would otherwise be a pool key nothing
 *    can fill, drawn as nothing, for ever.
 * 2. **Every kit tree in `TREE_VARIANTS` really is a tree in the kit** — two primitives, or one for
 *    the `DeadTree` family, matching `treePartsOf` exactly.
 * 3. **The foliage material family reaches the kit's leaves**, uniform object for uniform object,
 *    which is `foliage.ts`'s trap 1 asserted for M5b's materials rather than M5a's.
 * 4. The size budget, and the number the compression slice exists to reduce.
 *
 * Skips cleanly when `public/models/nature` is absent: it is git-ignored and reproducible with
 * `node packages/worldgen/src/modelgen.ts --source <kit>`, exactly as `models/trees` is.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ShaderLib } from 'three';

import { FOLIAGE_WIND_GLSL, MASK_TEXTURE, type ShaderPatch } from './foliage.ts';
import { KIT_MANIFEST_VERSION, kitPartCount, treeTexture, wantedModels, type KitManifest } from './kit.ts';
import { ScenePool } from './pool.ts';
import {
  KIT_MODELS,
  KIT_PARTS,
  KIT_PART_TEXTURES,
  KIT_TEXTURES,
  TREE_LODS,
  kitGeometryKey,
  kitMaterialKey,
  kitRoleOf,
  treeMaterialKey,
  treePartsOf,
  variantsFrom,
  type TreeVariant,
} from './prototypes.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATURE_DIR = join(PACKAGE_ROOT, 'public', 'models', 'nature');

/**
 * The whole import's budget, in bytes.
 *
 * **Forty megabytes, and it is deliberately a large number that is still a ceiling.** The kit is
 * ~10 MB of glTF+bin and ~20 MB of PNG, uncompressed, because the brief defers Draco/KTX2/meshopt to
 * a follow-up slice on purpose: *"the first 'world in clothes' moment should not wait on a
 * compression toolchain"*. The headroom above 30 MB is not room to grow into — it is slack so that a
 * re-import of the same kit cannot fail this test on a rounding difference. When the compression
 * slice lands this number should fall by most of itself.
 */
const KIT_BUDGET = 40 * 1024 * 1024;

describe('the kit’s key set', () => {
  it('gives every model at least one part and every part a known texture', () => {
    assert.equal(KIT_MODELS.length, 43);
    assert.equal(kitPartCount(), 48);
    assert.equal(KIT_PARTS.length, 48);
    const textures = new Set<string>(KIT_TEXTURES);
    for (const model of KIT_MODELS) {
      const parts = KIT_PART_TEXTURES[model] ?? [];
      assert.ok(parts.length >= 1 && parts.length <= 2, `${model} has ${parts.length} parts`);
      assert.equal(new Set(parts).size, parts.length, `${model} wears one texture twice`);
      for (const texture of parts) assert.ok(textures.has(texture), `${model} wears unknown ${texture}`);
    }
    // Every key is unique, or two models would share a geometry slot and the second would be dropped.
    const keys = KIT_PARTS.map((part) => kitGeometryKey(part.model, part.texture));
    assert.equal(new Set(keys).size, keys.length);
  });

  it('gives every kit tree a bark texture and every leafy one a leaf texture', () => {
    const kitTrees = variantsFrom('kit');
    assert.equal(kitTrees.length, 20);
    for (const variant of kitTrees) {
      const parts = treePartsOf(variant);
      const bark = treeTexture(variant, 'trunk');
      assert.ok(bark, `${variant} has no bark texture`);
      assert.equal(kitRoleOf(bark), 'solid', `${variant}'s bark is not a solid`);
      const leaf = treeTexture(variant, 'canopy');
      if (parts.includes('canopy')) {
        assert.ok(leaf, `${variant} has a canopy and no leaf texture`);
        assert.equal(kitRoleOf(leaf), 'leaf');
      } else {
        assert.equal(leaf, undefined, `${variant} has no canopy but names a leaf texture`);
      }
    }
    // A baked tree has no kit texture at all — `trees.ts` paints it from the treegen manifest.
    for (const variant of variantsFrom('baked')) assert.equal(treeTexture(variant, 'trunk'), undefined);
  });
});

describe('the kit’s materials', () => {
  it('puts the kit’s leaves on the foliage family, sharing one wind clock by reference', () => {
    /*
     * `foliage.ts`'s trap 1, extended to M5b's materials. The proof is the same two halves it was at
     * M5a — identical code and identical *objects* — and the reason it has to be re-asserted here is
     * that a kit leaf reaches the family down a different path: the pool builds it in a separate
     * branch, with a texture and a different mask kind, and a branch that constructed its own uniforms
     * would detach every kit shadow in the world without failing a single M5a test.
     */
    const pool = new ScenePool();
    const key = kitMaterialKey('fern-1', 'leaves');
    const material = pool.material(key);
    const uniforms = pool.foliage(key);
    assert.ok(uniforms, 'a kit leaf material has no foliage uniforms');

    const compile = (source: { vertexShader: string; fragmentShader: string }, patch: unknown): ShaderPatch => {
      const shader: ShaderPatch = { vertexShader: source.vertexShader, fragmentShader: source.fragmentShader, uniforms: {} };
      (patch as (s: unknown, r: unknown) => void)(shader, undefined);
      return shader;
    };
    const lit = compile(ShaderLib.lambert, material.onBeforeCompile);
    // The pool holds the depth twin; acquiring a wrapper is how it is normally reached, and this is
    // the same object. `standIn` fills the kit's keys the way `traversal.test.ts` does — a wrapper
    // cannot be acquired for a geometry that has never been registered, which is by design.
    pool.registerGeometry(kitGeometryKey('fern-1', 'leaves'), pool.geometry('box'));
    const wrapper = pool.acquire(kitGeometryKey('fern-1', 'leaves'), key);
    const depth = wrapper.customDepthMaterial;
    assert.ok(depth, 'a kit leaf wrapper carries no custom depth material');
    const shadow = compile(ShaderLib.depth, depth.onBeforeCompile);

    // Identical code: the one wind constant, in both.
    assert.ok(lit.vertexShader.includes(FOLIAGE_WIND_GLSL), 'the kit leaf lost the wind');
    assert.ok(shadow.vertexShader.includes(FOLIAGE_WIND_GLSL), 'the kit leaf’s shadow lost the wind');
    // Identical inputs: the same objects, not equal values.
    for (const name of ['uTime', 'uWind', 'uWindDir', 'uWindStrength', 'uWindSpeed', 'uWindGain', 'uTreeHeight']) {
      assert.ok(lit.uniforms[name], `the kit leaf never got ${name}`);
      assert.equal(shadow.uniforms[name], lit.uniforms[name], `${name} is two objects, so it can drift`);
    }
    assert.equal(lit.uniforms['uTime'], pool.wind.uTime, 'the kit is on a second clock');

    // …and the mask is switched off by a **uniform**, which is what keeps it inside the family.
    assert.equal(uniforms.uMaskKind.value, MASK_TEXTURE);
    assert.equal(uniforms.uBend.value, 0, 'a kit leaf mesh has real normals and must not be bent onto a cone');
    // The texture reaches the depth material too, or the shadow is the rectangle the leaf is painted on.
    assert.ok(material.map, 'a kit leaf has no texture slot');
    // `customDepthMaterial` is typed as the base `Material`, which has no `map`; the object is a
    // `MeshDepthMaterial` and does. Narrowed rather than cast away, so the assertion still fails if
    // it ever stops being one.
    assert.equal((depth as { map?: unknown }).map, material.map, 'the shadow cannot see the leaf’s alpha');
    pool.release(wrapper);
    pool.dispose();
  });

  it('puts the kit’s solids on an opaque, single-sided, vertex-coloured Lambert', () => {
    const pool = new ScenePool();
    const bark = pool.material(treeMaterialKey('trunk', 'common-tree-1' as TreeVariant));
    const rock = pool.material(kitMaterialKey('rock-medium-1', 'rocks-diffuse'));
    for (const material of [bark, rock]) {
      assert.equal(material.alphaTest, 0, 'the kit’s solids are opaque however the glTF’s MASK flag reads');
      assert.equal(material.side, 0, 'FrontSide: every kit solid is a closed mesh');
      assert.equal(material.vertexColors, true, 'the kit bakes its ambient occlusion into COLOR_0');
      assert.ok(material.map, 'a kit solid has no texture slot');
      // White diffuse: a kit material's colour is its texture, and anything else tints the palette.
      assert.equal(material.color.getHex(), 0xffffff);
    }
    // …and a kit solid casts a shadow where a path stone does not. `KIT_TEXTURE_CASTS`, through the pool.
    pool.registerGeometry(kitGeometryKey('rock-medium-1', 'rocks-diffuse'), pool.geometry('box'));
    pool.registerGeometry(kitGeometryKey('rock-path-round-wide', 'path-rocks-diffuse'), pool.geometry('box'));
    const boulder = pool.acquire(kitGeometryKey('rock-medium-1', 'rocks-diffuse'), kitMaterialKey('rock-medium-1', 'rocks-diffuse'));
    assert.equal(boulder.castShadow, true);
    pool.release(boulder);
    const stone = pool.acquire(
      kitGeometryKey('rock-path-round-wide', 'path-rocks-diffuse'),
      kitMaterialKey('rock-path-round-wide', 'path-rocks-diffuse'),
    );
    assert.equal(stone.castShadow, false, 'a 10 cm path stone is not worth a draw in the shadow pass');
    pool.release(stone);
    pool.dispose();
  });

  it('registers a kit tree’s one mesh under three LOD keys and charges the ledger once', () => {
    // The kit ships no LOD ladder, so `kit.ts` registers the same `BufferGeometry` under all three
    // keys — `trees.ts`'s *"one that ships its own LODs skips the ladder"*, in the direction the kit
    // took. The ledger must count the object, not the keys, or it stops being an honest proxy for
    // what the GPU holds.
    const pool = new ScenePool();
    const before = pool.snapshot();
    const box = pool.geometry('box');
    for (const lod of TREE_LODS) pool.registerGeometry(`trunk:common-tree-1:${lod}`, box);
    const after = pool.snapshot();
    assert.equal(after.geometries, before.geometries + TREE_LODS.length, 'three keys');
    assert.equal(after.geometryBytes, before.geometryBytes, 'but one geometry’s worth of bytes');
    pool.dispose();
  });
});

describe('the imported kit', () => {
  if (!existsSync(NATURE_DIR)) {
    it('skips: the kit has not been imported', (t) => {
      t.skip(
        `no imported kit at ${NATURE_DIR} — run ` +
          `\`node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --source <kit>\``,
      );
    });
    return;
  }

  const manifest = JSON.parse(readFileSync(join(NATURE_DIR, 'manifest.json'), 'utf8')) as KitManifest;
  const byId = new Map(manifest.models.map((model) => [model.id, model]));

  it('is the version this client reads', () => {
    assert.equal(manifest.version, KIT_MANIFEST_VERSION);
    assert.ok(manifest.generator.includes('Quaternius'), 'the manifest does not say where it came from');
  });

  it('holds every key prototypes.ts sized the pool for, and the manifest agrees on every part', () => {
    // The bounded-pool contract's second half, for the kit. See this file's header.
    for (const model of KIT_MODELS) {
      const entry = byId.get(model);
      assert.ok(entry, `${model} has a pool key and is not in the manifest`);
      assert.deepEqual(
        entry.parts.map((part) => part.texture),
        [...(KIT_PART_TEXTURES[model] ?? [])],
        `${model}: prototypes.ts and the manifest disagree about its primitives`,
      );
      for (const part of entry.parts) assert.equal(part.role, kitRoleOf(part.texture), `${model}/${part.texture}`);
    }
    // …and the kit's trees, whose textures live in `kit.ts` because the pool needs them before the
    // manifest can arrive.
    for (const variant of variantsFrom('kit')) {
      const entry = byId.get(variant);
      assert.ok(entry, `${variant} is a kit tree and is not in the manifest`);
      const parts = treePartsOf(variant);
      assert.equal(entry.parts.length, parts.length, `${variant} has ${entry.parts.length} primitives`);
      for (const part of entry.parts) {
        const expected = treeTexture(variant, part.role === 'solid' ? 'trunk' : 'canopy');
        assert.equal(part.texture, expected, `${variant}'s ${part.role} texture`);
      }
      assert.ok(entry.blocks, `${variant} is a tree and must block`);
    }
    // The five `Petal_*` are imported and deliberately have no pool key. A named gap, asserted so it
    // stays a decision rather than becoming a bug.
    const wanted = wantedModels();
    const unused = manifest.models.filter((model) => !wanted.has(model.id)).map((model) => model.id);
    assert.deepEqual(unused.sort(), ['petal-1', 'petal-2', 'petal-3', 'petal-4', 'petal-5']);
  });

  it('has every file it lists, at the size it recorded, inside the budget', () => {
    let total = 0;
    let triangles = 0;
    for (const model of manifest.models) {
      const dir = join(NATURE_DIR, model.id);
      assert.ok(existsSync(join(dir, 'model.gltf')), `${model.id} is listed and missing`);
      assert.ok(existsSync(join(dir, 'model.bin')), `${model.id} has no buffer`);
      const bytes = statSync(join(dir, 'model.gltf')).size + statSync(join(dir, 'model.bin')).size;
      assert.equal(bytes, model.bytes, `${model.id} is not the size the manifest claims`);
      total += bytes;
      triangles += model.triangles;
    }
    let textureBytes = 0;
    for (const texture of manifest.textures) {
      const file = join(NATURE_DIR, 'textures', `${texture.id}.png`);
      assert.ok(existsSync(file), `${texture.id} is listed and missing`);
      assert.equal(statSync(file).size, texture.bytes);
      textureBytes += texture.bytes;
    }
    // Nothing on disk the manifest does not know about: a model renamed upstream would otherwise ship
    // for ever beside its replacement. `modelgen` clears the directory, and this proves it did.
    const listed = new Set<string>([...manifest.models.map((m) => m.id), 'textures', 'manifest.json', 'ATTRIBUTION.md']);
    const extra = readdirSync(NATURE_DIR).filter((entry) => !listed.has(entry));
    assert.deepEqual(extra, [], `unlisted entries in the kit directory:\n${extra.join('\n')}`);

    console.log(
      `[M5b kit import] ${manifest.models.length} models, ${triangles} triangles, ` +
        `${(total / 1024 / 1024).toFixed(1)} MiB of glTF+bin + ` +
        `${manifest.textures.length} textures ${(textureBytes / 1024 / 1024).toFixed(1)} MiB ` +
        `= ${((total + textureBytes) / 1024 / 1024).toFixed(1)} MiB of a ${KIT_BUDGET / 1024 / 1024} MiB budget ` +
        `(uncompressed: Draco/KTX2/meshopt are the follow-up slice)`,
    );
    assert.ok(total + textureBytes < KIT_BUDGET, `the kit is ${total + textureBytes} B, over budget`);
  });

  it('carries the attribution the licence does not require and the project does', () => {
    const note = readFileSync(join(NATURE_DIR, 'ATTRIBUTION.md'), 'utf8');
    assert.ok(note.includes('CC0'), 'the attribution names no licence');
    assert.ok(note.includes('Quaternius'), 'the attribution does not credit the vendor');
    assert.ok(note.includes('modelgen.ts'), 'the attribution does not say how to re-create the set');
    assert.ok(note.includes('Normal maps dropped'), 'the attribution does not say what was changed');
  });
});
