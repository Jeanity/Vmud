/**
 * The furniture kit's contract with the importer — `village.test.ts`'s sibling, holding the same seam
 * for the fourth pack.
 *
 * `prototypes.ts` names 26 models, 49 `(model, texture)` parts and a table of measured metres, all of
 * them enumerated **at module load** because the material pool is sized against them and because
 * `furnish.ts` sites a piece against `roomScene.walkableRequired` using nothing but that table.
 * `modelgen --props` writes a manifest describing what is actually on disk. Neither knows about the
 * other. This file is the only thing that makes them agree.
 *
 * The failure mode it exists to catch is worse here than for the village: a wrong *footprint* is not
 * a wall with a hole in it, it is a bookcase standing on the tile a player arrives on, and the
 * whole-world sweep in `furnish.test.ts` would pass while it happened — because that sweep checks the
 * planner against this table, and this file is what checks the table against the pack.
 *
 * Skips cleanly when `public/models/props` is absent — it is git-ignored and reproducible with
 * `node packages/worldgen/src/modelgen.ts --props`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ScenePool } from './pool.ts';
import { PROPS_MANIFEST_VERSION, PropsSet, type PropsManifest } from './props.ts';
import {
  CHARACTER_PROP_TEXTURES,
  PROPS_METRICS,
  PROPS_MODELS,
  PROPS_PARTS,
  PROPS_PART_TEXTURES,
  PROPS_TEXTURES,
  SCENERY_MODELS,
  propsGeometryKey,
  propsMaterialKey,
} from './prototypes.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODELS = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', 'props');
const MANIFEST = join(MODELS, 'manifest.json');

describe('the furniture registry', () => {
  it('gives every drawn model a footprint and every part a listed atlas', () => {
    for (const model of PROPS_MODELS) {
      const metric = PROPS_METRICS[model];
      assert.ok(metric, `${model} has no measured footprint`);
      assert.ok(metric.width > 0 && metric.depth > 0 && metric.height > 0, `${model} measures zero`);
      const textures = PROPS_PART_TEXTURES[model] ?? [];
      assert.ok(textures.length > 0, `${model} has no parts`);
      for (const texture of textures) {
        assert.ok(PROPS_TEXTURES.includes(texture), `${model} wears an unlisted atlas ${texture}`);
      }
    }
    // A scenery stand-in from *this* pack must be a drawn model, or `furnish.dressedScenery` would
    // suppress a grey box and draw nothing in its place — a hole where the catalogue promises a
    // handcart. The other two packs answer the same question in `furnish.test.ts`, which is where the
    // three registries are checked together.
    for (const [kind, models] of Object.entries(SCENERY_MODELS)) {
      for (const entry of models) {
        if (entry.pack !== 'props') continue;
        assert.ok(PROPS_MODELS.includes(entry.model), `scenery ${kind} names ${entry.model}, which is not drawn`);
      }
    }
  });

  it('shares three of its four atlases with the character packs, and pays for one', () => {
    // The saving this kit's docblock claims, asserted rather than believed: `trim-furniture`,
    // `trim-metal` and `trim-props` are the atlases the outfit pack's sword, axe and shield already
    // wear, and `ScenePool.registerTexture` is keyed by manifest id — so whichever load lands first
    // pays and the other gets them free. `trim-cloth` is the one this kit adds.
    const shared = PROPS_TEXTURES.filter((texture) => CHARACTER_PROP_TEXTURES.has(texture));
    assert.deepEqual([...shared], ['trim-furniture', 'trim-metal', 'trim-props']);
    assert.deepEqual(
      PROPS_TEXTURES.filter((texture) => !CHARACTER_PROP_TEXTURES.has(texture)),
      ['trim-cloth'],
    );
  });

  it('costs six materials and no new program', () => {
    // The whole reason `propsMaterialKey` takes a texture and not a pair: 26 models, four materials.
    // And the reason `materialFamily` answers `kitSolid`: a barrel is a Lambert with a base-colour
    // map and a vertex colour drawn single-sided, which is a boulder to the `#define`.
    //
    // **Six since the corpses**, and the two extra are the interesting ones: `bonepile` and
    // `bonepile_looted` carry no atlas at all — their colour is baked into `COLOR_0` and their map is
    // a 1x1 white (see `modelgen.buildObject`). They are still `map x vertexColour` drawn
    // single-sided, so they are the *same* `#define` set, which is exactly what the program assertion
    // below now proves rather than assumes: colour without a texture cost two materials and no shader.
    const pool = new ScenePool();
    const before = pool.programKeys().size;
    const keys = new Set(PROPS_PARTS.map((part) => propsMaterialKey(part.texture)));
    assert.equal(keys.size, 6);
    for (const key of keys) {
      const material = pool.material(key);
      assert.ok(material.map, 'a furniture material has no texture slot to swap into');
      assert.equal(material.vertexColors, true);
      pool.dressKit(key, material.map);
    }
    assert.equal(pool.programKeys().size, before, 'dressing the furniture compiled a program');
    pool.dispose();
  });
});

describe('the furniture kit on disk', () => {
  if (!existsSync(MANIFEST)) {
    it('skips: public/models/props is absent', (t) => {
      t.skip(`no imported kit at ${MANIFEST} (git-ignored) — run modelgen --props first`);
    });
  } else {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as PropsManifest;
    const byId = new Map(manifest.models.map((model) => [model.id, model]));

    it('is the version this client reads', () => {
      assert.equal(manifest.version, PROPS_MANIFEST_VERSION);
    });

    it('has every drawn model, with the parts and the atlases the pool expects', () => {
      for (const model of PROPS_MODELS) {
        const entry = byId.get(model);
        assert.ok(entry, `${model} is in the pool's key set and not in the manifest`);
        const textures = [...(PROPS_PART_TEXTURES[model] ?? [])].sort();
        const actual = [...new Set(entry.parts.map((part) => part.texture))].sort();
        assert.deepEqual(actual, textures, `${model}'s atlases disagree with the pack`);
        // The property `registerGeometry`'s first-wins behaviour makes load-bearing: one primitive per
        // atlas, so nothing is silently dropped on the way into the pool.
        assert.equal(entry.parts.length, textures.length, `${model} has two primitives on one atlas`);
        assert.ok(existsSync(join(MODELS, model, 'model.gltf')), `${model} has no glTF on disk`);
        assert.ok(existsSync(join(MODELS, model, 'model.bin')), `${model} has no buffer on disk`);
      }
    });

    it('measures what `PROPS_METRICS` says it does, to the millimetre', () => {
      // The table `furnish.ts` sites against. A pack re-import that resized a bookcase would
      // otherwise put it on the arrival ring with every other test still green.
      for (const model of PROPS_MODELS) {
        const entry = byId.get(model)!;
        const metric = PROPS_METRICS[model]!;
        assert.equal(metric.width, entry.width, `${model} width`);
        assert.equal(metric.depth, entry.depth, `${model} depth`);
        assert.equal(metric.height, entry.height, `${model} height`);
        // Every drawn piece sits on the floor: nothing here hangs from a ceiling or a wall peg, which
        // is what would make a placement at `y = elevation` bury it. Four centimetres of slack for
        // `Cage_Small`'s feet, which is the deepest in the set.
        assert.ok(Math.abs(entry.minY) < 0.05, `${model} sinks ${entry.minY} m below its own origin`);
      }
    });

    it('is a pack of correctly scaled furniture, which the nature kit was not', () => {
      // The claim `PROPS_METRICS`' docblock makes, checked: against a 1.81 m base body, a stool is
      // knee high, a table-height piece is waist high, and the tallest thing in the set is a market
      // stall you can walk under the awning of. Nothing needs a scale factor, which is why a
      // furniture placement's is 1.
      assert.ok(PROPS_METRICS['stool']!.height < 0.7, 'a stool should be knee high');
      assert.ok(PROPS_METRICS['workbench']!.height < 1.0, 'a workbench should be waist high');
      assert.ok(PROPS_METRICS['bookcase-2']!.height > 2.4, 'a bookcase should be over head height');
      for (const model of PROPS_MODELS) {
        assert.ok(PROPS_METRICS[model]!.height < 3.0, `${model} is taller than a room`);
      }
    });

    it('carries only the four atlases the pool keys, and never the 4096 sheet', () => {
      const needed = new Set<string>();
      for (const model of PROPS_MODELS) for (const t of PROPS_PART_TEXTURES[model] ?? []) needed.add(t);
      assert.deepEqual([...needed].sort(), [...PROPS_TEXTURES].sort());
      // `page-noise` is in the manifest — the manifest is the whole pack — and is never fetched,
      // because no drawn model wears it. It is the single largest file in the import.
      const page = manifest.textures.find((texture) => texture.id === 'page-noise');
      assert.ok(page, 'the pack should still carry the scroll sheet');
      assert.ok(!needed.has('page-noise'), 'the 4096 scroll sheet must not be fetched');
      assert.ok(page.bytes > 4_000_000, 'and it is worth not fetching');
    });

    it('registers into the pool under the keys the placements will ask for', () => {
      // The stand-in path, which is also the headless path the traversal test walks on. What it
      // proves is that the key a placement writes is the key a registration answers.
      const pool = new ScenePool();
      const set = new PropsSet();
      assert.equal(set.available, false, 'an empty set must not claim to be drawable');
      set.standIn(pool);
      assert.equal(set.available, true);
      for (const part of PROPS_PARTS) {
        assert.ok(
          pool.hasGeometry(propsGeometryKey(part.model, part.texture)),
          `${part.model}/${part.texture} did not register`,
        );
      }
      pool.dispose();
    });

    it('reports the bytes it costs, so the compression slice has a target', () => {
      let bytes = 0;
      let triangles = 0;
      for (const model of PROPS_MODELS) {
        const entry = byId.get(model)!;
        triangles += entry.triangles;
        bytes += statSync(join(MODELS, model, 'model.gltf')).size;
        bytes += statSync(join(MODELS, model, 'model.bin')).size;
      }
      const atlases = manifest.textures
        .filter((texture) => (PROPS_TEXTURES as readonly string[]).includes(texture.id))
        .reduce((n, texture) => n + texture.bytes, 0);
      console.log(
        `[M9 props] ${PROPS_MODELS.length} drawn of ${manifest.models.length}, ${triangles} tris, ` +
          `${(bytes / 1024).toFixed(0)} KiB of glTF+bin, ${(atlases / 1024 / 1024).toFixed(1)} MiB of atlas ` +
          `(${((atlases - manifest.textures.filter((t) => t.id === 'trim-cloth').reduce((n, t) => n + t.bytes, 0)) / 1024 / 1024).toFixed(1)} MiB of it already on the wire for the characters)`,
      );
      assert.ok(triangles < 60_000, `${triangles} triangles across the drawn set is more than a forest`);
    });
  }
});
