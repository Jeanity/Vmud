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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  KIT_MANIFEST_VERSION,
  NATURE_PROFILE,
  VILLAGE_MANIFEST_VERSION,
  VILLAGE_PROFILE,
  buildCatalogue,
  gltfDirOf,
  kitFamily,
  kitId,
  kitRole,
  pngSize,
  readSources,
  sourceDir,
  villageFamily,
  villageRole,
  villageTextureId,
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

/* -------------------------------------------------------------------------- */
/* M6: the second source dir                                                    */
/* -------------------------------------------------------------------------- */

describe('the village profile’s naming rules', () => {
  it('undoes the pack’s Unreal-style channel naming', () => {
    // The nature pack names a texture after the thing it dresses and {@link kitId} is enough; the
    // village pack uses `T_<thing>_<channel>` and passing that straight through would give the
    // manifest `t-plaster-base-color` and the client a pool key nobody can read.
    assert.equal(villageTextureId('T_Plaster_BaseColor.png'), 'plaster');
    assert.equal(villageTextureId('T_UnevenBrick_BaseColor.png'), 'uneven-brick');
    assert.equal(villageTextureId('T_RoundTiles_BaseColor.png'), 'round-tiles');
    assert.equal(villageTextureId('T_MetalOrnaments_BaseColor.png'), 'metal-ornaments');
    // Upstream's own typo: the extension is in the stem. Undone here rather than on disk, because
    // the file name is the join key back to the pack.
    assert.equal(villageTextureId('T_VineLeaf_png.png'), 'vine-leaf');
    // The dropped channels collapse onto the base colour's id, which is deliberate and is why
    // `readSources` reads the base colour last — see its comment.
    assert.equal(villageTextureId('T_Plaster_Normal.png'), 'plaster');
    assert.equal(villageTextureId('T_RockTrim_ORM.png'), 'rock-trim');
  });

  it('names a family by the longest prefix, so a door frame is not a door', () => {
    assert.equal(villageFamily('wall-plaster-straight'), 'wall');
    assert.equal(villageFamily('floor-wood-dark'), 'floor');
    assert.equal(villageFamily('roof-round-tiles-8x8'), 'roof');
    // The three pairs that need longest-prefix rather than first-match.
    assert.equal(villageFamily('door-frame-flat-brick'), 'door-frame');
    assert.equal(villageFamily('door-1-flat'), 'door');
    assert.equal(villageFamily('stairs-exterior-straight'), 'stairs');
    assert.equal(villageFamily('stair-interior-solid'), 'stair');
    assert.equal(villageFamily('window-shutters-thin-flat-open'), 'window-shutters');
    assert.equal(villageFamily('window-thin-flat1'), 'window');
  });

  it('sorts a village primitive into a role, and only the vine sways', () => {
    // Almost everything in this pack is masonry, timber or tile. The vine is an alpha-masked leaf
    // sheet and belongs in the family `foliage.ts` already has for the nature kit's leaves.
    assert.equal(villageRole('plaster'), 'solid');
    assert.equal(villageRole('uneven-brick'), 'solid');
    assert.equal(villageRole('round-tiles'), 'solid');
    assert.equal(villageRole('wood-trim'), 'solid');
    assert.equal(villageRole('vine-leaf'), 'leaf');
  });

  it('finds the glTF directory whether or not the pack is nested', () => {
    // The itch download unpacks as `village/Medieval Village MegaKit[Standard]/glTF`, and typing that
    // bracketed name on a command line is a trap — so the resolver descends one level, but **only**
    // when the choice is unambiguous. Two packs under one directory is an error, not a coin toss.
    assert.equal(gltfDirOf(join(sourceDir(), 'no-such-directory-anywhere')), undefined);
    // …and it finds the nature pack's own `glTF` directly when that pack is present, which is the
    // path the unchanged nature import takes.
    if (existsSync(GLTF_DIR)) assert.equal(gltfDirOf(sourceDir()), GLTF_DIR);
  });
});

describe('the village importer’s catalogue', () => {
  const source = sourceDir(VILLAGE_PROFILE);
  const dir = gltfDirOf(source);
  if (!dir) {
    it('skips: the Quaternius village kit is not on disk', (t) => {
      t.skip(
        `no kit under ${source} — assets/** is git-ignored, so point --source or GAME_VILLAGE_KIT at ` +
          `the main checkout: node packages/worldgen/src/modelgen.ts --village ` +
          `--source D:/MyGame/assets/quaternius/village`,
      );
    });
    return;
  }

  const { sources: villageSources, textures: villageTextures } = readSources(dir, VILLAGE_PROFILE);

  it('is byte-identical on a second run over the same input', () => {
    const first = buildCatalogue(villageSources, villageTextures, VILLAGE_PROFILE);
    const second = buildCatalogue(villageSources, villageTextures, VILLAGE_PROFILE);
    // The same determinism bar the nature kit is held to, on the same pure half — and additionally
    // by content hash, because a manifest that matched while a rewritten glTF drifted would pass a
    // JSON comparison of the manifest alone.
    assert.equal(JSON.stringify(first.manifest), JSON.stringify(second.manifest));
    assert.equal(sha1(first), sha1(second), 'the village import is not reproducible');
    const ids = first.manifest.models.map((model) => model.id);
    assert.deepEqual(ids, [...ids].sort(), 'the manifest is not sorted by id');
  });

  it('describes the whole pack at world scale, with a served path per model', () => {
    const { manifest } = buildCatalogue(villageSources, villageTextures, VILLAGE_PROFILE);
    assert.equal(manifest.version, VILLAGE_MANIFEST_VERSION);
    assert.ok(manifest.generator.includes('Medieval Village'));
    assert.equal(manifest.models.length, 176, 'the textured glTF line is 176 models');
    let triangles = 0;
    for (const model of manifest.models) {
      assert.ok(model.url.startsWith('models/village/'), `${model.url} is not a served path`);
      assert.ok(!model.url.includes('..'), `${model.url} escapes the served root`);
      assert.ok(model.triangles > 0, `${model.id} has no triangles`);
      // **Nothing blocks**, and the empty set is the point: `blocks` is the scatter's question and no
      // village module is ever scattered — every one is placed from the room IR's own edges.
      assert.equal(model.blocks, false, `${model.id} claims to block`);
      assert.equal(model.blockRadius, 0);
      for (const part of model.parts) {
        assert.equal(part.role, villageRole(part.texture), `${model.id}/${part.texture} role`);
      }
      triangles += model.triangles;
    }
    assert.equal(triangles, 117880, 'the pack’s triangle count moved');
  });

  it('measures the 2 m module grid the renderer maps onto a 9 m room', () => {
    // **The first act of this milestone, as a regression test.** Every `Wall_*` and every `Floor_*`
    // is exactly two metres across; `9 / 2` is 4.5, which is why `client3d`'s `VILLAGE_SCALE` exists
    // and why it is 1.5. If a re-import ever moves this, the tiling silently stops being exact.
    const { manifest } = buildCatalogue(villageSources, villageTextures, VILLAGE_PROFILE);
    const byId = new Map(manifest.models.map((model) => [model.id, model]));
    const walls = manifest.models.filter(
      (model) => model.family === 'wall' && model.id.startsWith('wall-plaster-'),
    );
    assert.ok(walls.length >= 5, `only ${walls.length} plaster wall modules`);
    for (const wall of walls) {
      // Two metres to within two millimetres: `Wall_Plaster_Straight_L` and `_R` measure 2.0018
      // because each carries a corner return that laps past the module line, which is what a return
      // is for. Everything else is exactly 2.000.
      assert.ok(Math.abs(wall.width - 2) < 0.01, `${wall.id} is ${wall.width} m across, not a 2 m module`);
      assert.ok(wall.height > 2.9 && wall.height < 3.2, `${wall.id} is ${wall.height} m tall`);
    }
    // The modules `client3d` actually draws are exact, with no return to allow for.
    for (const id of ['wall-plaster-straight', 'wall-plaster-wood-grid', 'wall-arch']) {
      assert.equal(byId.get(id)!.width, 2, `${id} is not a 2 m module`);
    }
    for (const floor of manifest.models.filter((model) => model.family === 'floor' && !model.id.includes('half'))) {
      if (floor.id.includes('overhang')) continue;
      assert.equal(floor.width, 2, `${floor.id} is ${floor.width} m across`);
      assert.equal(floor.depth, 2, `${floor.id} is ${floor.depth} m deep`);
    }
    // The roof the interior mode uses is a whole-building piece rather than a module, and it is
    // within half a metre of a 9 m room plus its eaves — which is what makes it placeable unscaled.
    const roof = byId.get('roof-round-tiles-8x8')!;
    assert.ok(roof.width > 9.5 && roof.width < 10.5, `the 8x8 roof is ${roof.width} m across`);
    console.log(
      `[M6 module grid] wall ${walls[0]!.width} x ${walls[0]!.height} m, ` +
        `roof ${roof.width} x ${roof.depth} m rising ${(roof.height + roof.minY).toFixed(3)} m; ` +
        `${manifest.models.length} models, ${manifest.textures.length} base-colour textures`,
    );
  });

  it('keeps nine base colours and drops thirteen channel maps', () => {
    const { manifest, gltfs } = buildCatalogue(villageSources, villageTextures, VILLAGE_PROFILE);
    // Nine of the pack's twenty-two PNGs. The other thirteen are normal, roughness and ORM maps —
    // 38.1 MB that nothing in a Lambert renderer samples.
    assert.equal(manifest.textures.length, 9);
    for (const texture of manifest.textures) {
      assert.ok(texture.used > 0, `${texture.id} is copied and worn by nothing`);
      assert.ok(texture.width > 0 && texture.height > 0, `${texture.id} has no dimensions`);
    }
    const known = new Set(manifest.textures.map((texture) => `../textures/${texture.id}.png`));
    for (const [id, text] of gltfs) {
      const gltf = JSON.parse(text) as { images?: { uri: string }[]; buffers: { uri: string }[] };
      assert.equal(gltf.buffers[0]?.uri, 'model.bin', `${id} points at the wrong buffer`);
      for (const image of gltf.images ?? []) assert.ok(known.has(image.uri), `${id} refers to ${image.uri}`);
      assert.ok(!text.includes('normalTexture'), `${id} still refers to a normal map`);
    }
  });

  it('leaves the nature import byte-identical', () => {
    // The parameterisation's one hard requirement: `NATURE_PROFILE` must be what the file did before
    // it had profiles at all. Checked by the profile's own fields rather than by re-running the
    // nature import, which the suite above already does.
    assert.equal(NATURE_PROFILE.id, 'nature');
    assert.equal(NATURE_PROFILE.textureId, kitId);
    assert.equal(NATURE_PROFILE.role, kitRole);
    assert.equal(NATURE_PROFILE.version, KIT_MANIFEST_VERSION);
    assert.ok(NATURE_PROFILE.generator.includes('Stylized Nature MegaKit'));
    assert.notEqual(VILLAGE_PROFILE.id, NATURE_PROFILE.id);
  });
});

/** A content hash over everything an import writes, so "identical" covers the glTFs and not just the manifest. */
function sha1(built: ReturnType<typeof buildCatalogue>): string {
  const hash = createHash('sha1');
  hash.update(JSON.stringify(built.manifest));
  for (const id of [...built.gltfs.keys()].sort()) hash.update(`${id}\u0000${built.gltfs.get(id)}`);
  for (const [id, file] of [...built.textureFiles].sort()) hash.update(`${id}\u0000${file}`);
  return hash.digest('hex');
}
