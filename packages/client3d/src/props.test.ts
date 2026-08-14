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

import { GLINT_PILE_LIFT } from './glint.ts';
import { ScenePool } from './pool.ts';
import { PROPS_MANIFEST_VERSION, PropsSet, SPARKLE_JOINTS, type PropsManifest } from './props.ts';
import {
  ANIMATED_MODELS,
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

/**
 * The retired loot sparkle's model id.
 *
 * Written here rather than exported from `prototypes.ts`, because `ANIMATED_MODELS` is empty and the
 * renderer no longer names this model anywhere: `glint.ts` draws the floor as a particle field. What
 * the tests below still hold is the **import**, which is the thing the next rigged prop will arrive
 * through — see `props.SPARKLE_JOINTS` and `modelgen.buildAnimatedObject`.
 */
const LOOT_SPARKLE = 'loot_sparkle';

/** The clip on the retired model, and its measured length. Held against the manifest, nothing else. */
const SPARKLE_CLIP = 'Idle_Loop';
const SPARKLE_CLIP_SECONDS = 2.4;

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

    it('measures the bone pile the corpse glint is lifted off', () => {
      // `glint.GLINT_PILE_LIFT` is written down rather than read from this file, for `SPARKLE_JOINTS`'
      // reason: the renderer's own statement of what the mesh is, held here against the mesh. A
      // re-import that flattened the pile would otherwise leave every corpse glinting from inside its
      // own ribs, which is a thing nobody would notice until they saw it.
      const pile = byId.get('bonepile');
      assert.ok(pile, 'the unlooted bone pile is not in the manifest');
      assert.equal(pile.height, GLINT_PILE_LIFT);
      // Only the unlooted pile emits — a picked-clean body has nothing to glint about — so the looted
      // one's height is deliberately not a constant anywhere. Asserted as the shorter of the two, which
      // is the owner's read-it-across-the-room rule seen from this end.
      const looted = byId.get('bonepile_looted');
      assert.ok(looted && looted.height < pile.height, 'a looted pile must read flatter');
    });

    it('still carries the loot sparkle as a verified rigged import, drawn by nothing', () => {
      // **The model is retired and this test is not.** `glint.ts` draws the floor as a particle field
      // now, so nothing clones this rig — but `modelgen.buildAnimatedObject` is kept for the next
      // rigged prop and *this* is the only thing that verifies it produces something bindable: a skin,
      // seven named joints in order, one clip with real channels, and two primitives sharing their
      // accessors so `props.mergeShared` has something to merge. Deleting it would leave the category
      // with no proof at all until the day somebody needed it.
      const entry = byId.get(LOOT_SPARKLE);
      assert.ok(entry, 'the loot sparkle is not in the manifest');
      assert.equal(entry.kind, 'animated', 'without this the loader takes the static branch');
      assert.equal(entry.joints, SPARKLE_JOINTS.length);
      assert.equal(entry.triangles, 420);
      // 0.26 x 0.111 x 0.418 m, base at y = 0.002 — knee-high on a 1.81 m character. `glint.GLINT_RISE`
      // is 0.65 m and was chosen against the same body, which is why the replacement reads at the same
      // height as the thing it replaced.
      assert.equal(entry.height, 0.418);
      assert.ok(Math.abs(entry.minY) < 0.01, `the sparkle sinks ${entry.minY} m below its own origin`);
      // One clip, five channels: one rotation path per glint bone, each independent. The measured fact
      // that made keeping the rig worth 1,472 B a copy, back when a copy was what a glint cost.
      assert.deepEqual(
        entry.clips?.map((clip) => clip.name),
        [SPARKLE_CLIP],
      );
      assert.equal(entry.clips?.[0]?.duration, SPARKLE_CLIP_SECONDS);
      assert.equal(entry.clips?.[0]?.channels, 5);
      // The manifest reports **one** part — the importer aggregates by material, and both of this
      // model's primitives carry a material named `loot_sparkle`. Which is exactly the fact that
      // matters below: the *file* has two primitives on one "atlas", the shape every other model in
      // this pack is forbidden from having because `registerGeometry` is first-wins and the second
      // would be silently dropped. Here it is handled rather than avoided, by `props.mergeShared`,
      // because both reference the *same* accessors. Half a sparkle is 228 triangles of 420 — a glint
      // with a bite out of it.
      assert.equal(entry.parts.length, 1);
      assert.equal(entry.parts[0]!.texture, LOOT_SPARKLE);
      assert.equal(entry.parts[0]!.triangles, 420);
      assert.equal(entry.parts[0]!.vertices, 1497);
      assert.equal(entry.parts[0]!.vertexColours, true, 'the colour is baked into COLOR_0');
      const gltf = JSON.parse(readFileSync(join(MODELS, LOOT_SPARKLE, 'model.gltf'), 'utf8')) as {
        meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[];
        skins: { joints: number[] }[];
        nodes: { name?: string }[];
      };
      const primitives = gltf.meshes[0]!.primitives;
      assert.equal(primitives.length, 2);
      // The property `mergeShared` refuses without: one POSITION, one NORMAL, one JOINTS_0, one
      // WEIGHTS_0, one COLOR_0, two index buffers.
      assert.deepEqual(primitives[0]!.attributes, primitives[1]!.attributes);
      assert.notEqual(primitives[0]!.indices, primitives[1]!.indices);
      assert.deepEqual(Object.keys(primitives[0]!.attributes).sort(), [
        'COLOR_0',
        'JOINTS_0',
        'NORMAL',
        'POSITION',
        'WEIGHTS_0',
      ]);
      // The armature, by name and in order — `props.SPARKLE_JOINTS` is this package's statement of it.
      assert.deepEqual(
        gltf.skins[0]!.joints.map((node) => gltf.nodes[node]!.name),
        [...SPARKLE_JOINTS],
      );
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
      // The animated objects register too, and they are the only rows that also produce a *template*.
      // Empty today — `glint.ts` retired the one member `ANIMATED_MODELS` ever had — so this loop
      // asserts nothing and is kept as the check the next rigged prop turns back on.
      for (const model of ANIMATED_MODELS) {
        assert.ok(pool.hasGeometry(propsGeometryKey(model, model)), `${model} did not register`);
        assert.ok(set.animated(model), `${model} registered no template`);
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
