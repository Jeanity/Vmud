/**
 * `modelgen`'s two promises: the names are a function of the kit, and the output is a function of the
 * input.
 *
 * The second is the one the brief asks for by name — *"Deterministic output (stable ordering; no
 * timestamps)"* — and it is worth a test rather than a habit because the failure is silent: an
 * importer that reordered its manifest by `readdir` would produce a different 30 MB tree on every
 * machine, and nobody would notice until two people compared a diff. {@link buildCatalogue} is pure
 * over the parsed glTFs precisely so this can be asserted without writing a byte.
 *
 * Follows the project's skip-if-absent shape: `assets/**` is git-ignored, so a worktree has no kit at
 * all and the naming rules — which need nothing but strings — still run.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  KIT_MANIFEST_VERSION,
  buildCatalogue,
  kitFamily,
  kitId,
  kitRole,
  pngSize,
  readSources,
  sourceDir,
} from './modelgen.ts';

describe('the kit importer’s naming rules', () => {
  it('turns a Quaternius file name into a join key', () => {
    // Underscores separate words and so do camel humps, so a reader looking for the rock paths finds
    // them under `rock-`. These ids are compared character for character against
    // `client3d/src/prototypes.ts`'s `KIT_MODELS` and the kit entries in `TREE_VARIANTS`.
    assert.equal(kitId('CommonTree_1.gltf'), 'common-tree-1');
    assert.equal(kitId('RockPath_Round_Small_1.gltf'), 'rock-path-round-small-1');
    assert.equal(kitId('Bush_Common_Flowers.gltf'), 'bush-common-flowers');
    assert.equal(kitId('Grass_Wispy_Tall.gltf'), 'grass-wispy-tall');
    assert.equal(kitId('Flower_3_Group.gltf'), 'flower-3-group');
    assert.equal(kitId('Mushroom_Laetiporus.gltf'), 'mushroom-laetiporus');
    assert.equal(kitId('Fern_1.gltf'), 'fern-1');
    // Textures go through the same function, so the manifest's texture ids are the same shape.
    assert.equal(kitId('Bark_NormalTree_Normal.png'), 'bark-normal-tree-normal');
    assert.equal(kitId('PathRocks_Diffuse.png'), 'path-rocks-diffuse');
    assert.equal(kitId('Leaves.png'), 'leaves');
  });

  it('sorts a primitive into the family that decides how it is drawn', () => {
    // The brief's rule, and the one classification everything downstream hangs off: *"Leaves_*,
    // Grass, Flowers textures sway; bark and rock do not"*.
    assert.equal(kitRole('leaves'), 'leaf');
    assert.equal(kitRole('leaves-normal-tree-c'), 'leaf');
    assert.equal(kitRole('leaf-pine-c'), 'leaf');
    assert.equal(kitRole('grass'), 'leaf');
    assert.equal(kitRole('flowers'), 'leaf');
    assert.equal(kitRole('bark-normal-tree'), 'solid');
    assert.equal(kitRole('rocks-diffuse'), 'solid');
    assert.equal(kitRole('path-rocks-diffuse'), 'solid');
    // A mushroom cap is a closed mesh with no alpha; putting it in the leaf family would give it a
    // clip it has nothing to clip against.
    assert.equal(kitRole('mushrooms'), 'solid');
  });

  it('names a family by the longest prefix, so a rock path is not a rock', () => {
    assert.equal(kitFamily('common-tree-3'), 'common-tree');
    assert.equal(kitFamily('rock-path-square-wide'), 'rock-path');
    assert.equal(kitFamily('rock-medium-2'), 'rock-medium');
    assert.equal(kitFamily('pebble-round-4'), 'pebble');
    assert.equal(kitFamily('something-else'), 'unknown');
  });

  it('reads a PNG’s dimensions out of its IHDR without decoding it', () => {
    // Sixteen bytes rather than a dependency. The manifest carries width and height so the client can
    // put texture memory on the allocation ledger, which after M5b is its largest single number.
    const header = Buffer.alloc(24);
    header.writeUInt32BE(2048, 16);
    header.writeUInt32BE(1024, 20);
    assert.deepEqual(pngSize(header), { width: 2048, height: 1024 });
    assert.deepEqual(pngSize(Buffer.alloc(4)), { width: 0, height: 0 });
  });
});

const GLTF_DIR = join(sourceDir(), 'glTF');

describe('the kit importer’s catalogue', () => {
  if (!existsSync(GLTF_DIR)) {
    it('skips: the Quaternius nature kit is not on disk', (t) => {
      t.skip(
        `no kit at ${GLTF_DIR} — assets/** is git-ignored, so point --source or GAME_NATURE_KIT at ` +
          `the main checkout: node packages/worldgen/src/modelgen.ts --source D:/MyGame/assets/quaternius/nature`,
      );
    });
    return;
  }

  const { sources, textures } = readSources(GLTF_DIR);

  it('is byte-identical on a second run over the same input', () => {
    // The brief's own acceptance: *"Deterministic output (stable ordering; no timestamps)"*. Twice
    // through the pure half, compared as JSON, which covers the manifest **and** every rewritten
    // glTF — the two things a `readdir` order or a `Date.now()` could have leaked into.
    const first = buildCatalogue(sources, textures);
    const second = buildCatalogue(sources, textures);
    assert.equal(JSON.stringify(first.manifest), JSON.stringify(second.manifest));
    assert.deepEqual([...first.gltfs.keys()], [...second.gltfs.keys()]);
    for (const [id, text] of first.gltfs) assert.equal(second.gltfs.get(id), text, `${id} differs`);
    // …and the order is a property of the kit rather than of the filesystem.
    const ids = first.manifest.models.map((model) => model.id);
    assert.deepEqual(ids, [...ids].sort(), 'the manifest is not sorted by id');
    const textureIds = first.manifest.textures.map((texture) => texture.id);
    assert.deepEqual(textureIds, [...textureIds].sort());
  });

  it('describes all 68 models with real metres and a role for every primitive', () => {
    const { manifest } = buildCatalogue(sources, textures);
    assert.equal(manifest.version, KIT_MANIFEST_VERSION);
    assert.equal(manifest.models.length, 68, 'the textured glTF line is 68 models — see the M5b brief');
    let triangles = 0;
    for (const model of manifest.models) {
      assert.ok(model.parts.length >= 1 && model.parts.length <= 2, `${model.id} has ${model.parts.length} parts`);
      assert.ok(model.url.startsWith('models/nature/'), `${model.url} is not a served path`);
      assert.ok(!model.url.includes('..'), `${model.url} escapes the served root`);
      assert.ok(model.triangles > 0, `${model.id} has no triangles`);
      assert.ok(model.height > 0, `${model.id} is flat`);
      // **The kit is already at world scale** — the finding the whole placement layer rests on. One
      // room cell is 9 m; nothing in the kit may be a centimetre or a kilometre.
      assert.ok(model.width > 0.1 && model.width < 20, `${model.id} is ${model.width} m across`);
      assert.ok(model.height < 25, `${model.id} is ${model.height} m tall`);
      // A model sinks a little below its own origin — roots and skirts — and is never launched above
      // it, because `scatter.ts` places by the origin and a model floating off it would hover.
      assert.ok(model.minY <= 0.1, `${model.id} starts ${model.minY} m above its origin`);
      assert.equal(model.blocks, model.blockRadius > 0, `${model.id} blocks without a radius`);
      for (const part of model.parts) {
        assert.ok(part.material.length > 0, `${model.id} has an unnamed primitive`);
        assert.equal(part.role, kitRole(part.texture), `${model.id}/${part.texture} role`);
        assert.ok(part.triangles > 0);
      }
      triangles += model.triangles;
    }
    // The brief's measurement, re-derived: *"148,947 tris across the whole kit"*.
    assert.equal(triangles, 148947);
  });

  it('drops the normal maps and keeps every base colour the models refer to', () => {
    const { manifest, gltfs } = buildCatalogue(sources, textures);
    // Twelve base-colour textures; the three 4–5.6 MB normal maps are gone. See the header for why:
    // nothing in `client3d` samples one, and they are over half the kit's texture weight.
    assert.equal(manifest.textures.length, 12);
    for (const texture of manifest.textures) {
      assert.ok(!texture.id.endsWith('-normal'), `${texture.id} is a normal map and should be dropped`);
      assert.ok(texture.width > 0 && texture.height > 0, `${texture.id} has no dimensions`);
      assert.ok(texture.used > 0, `${texture.id} is copied and worn by nothing`);
    }
    // Every emitted glTF points at the shared directory and at its own buffer, and refers to no image
    // that is not in the manifest — a dangling image is a 404 in the browser's network tab.
    const known = new Set(manifest.textures.map((texture) => `../textures/${texture.id}.png`));
    for (const [id, text] of gltfs) {
      const gltf = JSON.parse(text) as { images?: { uri: string }[]; buffers: { uri: string }[] };
      assert.equal(gltf.buffers[0]?.uri, 'model.bin', `${id} points at the wrong buffer`);
      for (const image of gltf.images ?? []) {
        assert.ok(known.has(image.uri), `${id} refers to ${image.uri}, which is not copied`);
      }
      assert.ok(!text.includes('normalTexture'), `${id} still refers to a normal map`);
    }
  });
});
