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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHARACTERS_PROFILE,
  CHARACTER_CLIPS,
  CHARACTER_MANIFEST_VERSION,
  KIT_MANIFEST_VERSION,
  NATURE_PROFILE,
  VILLAGE_MANIFEST_VERSION,
  VILLAGE_PROFILE,
  buildAnimationLibrary,
  buildCatalogue,
  characterFamily,
  characterKind,
  gltfDirOf,
  kitFamily,
  kitId,
  kitRole,
  pngSize,
  readGlb,
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

/* -------------------------------------------------------------------------- */
/* M7b - the people                                                             */
/* -------------------------------------------------------------------------- */

/**
 * **These run without a pack on disk, and that is deliberate.**
 *
 * The two prop-kit suites above skip when `assets/**` is absent, because what they assert is a
 * property of *that kit* — how many models it has, what its textures are called. What M7b's importer
 * has to get right is a property of the *importer*: that a skin survives the rewrite, that a clip cut
 * is deterministic, and that the re-packed buffer is legal glTF. All three are answerable over
 * hand-built input, so they are, and a checkout with no packs still runs them.
 *
 * The one thing that genuinely needs the shipped article — *"the library the client will actually
 * fetch retargets onto the 65 joints the bodies bind"* — reads `client3d/public/models/characters`,
 * which is a build artefact of this very file and is present wherever `modelgen --characters` has run.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SHIPPED_UAL1 = join(REPO, 'packages', 'client3d', 'public', 'models', 'characters', 'animations', 'ual1.glb');

describe('the characters profile', () => {
  it('classifies a stem by its own shape, and the three kinds are total over the packs', () => {
    assert.equal(characterKind('Superhero_Male_FullBody'), 'body');
    assert.equal(characterKind('Superhero_Female_FullBody'), 'body');
    assert.equal(characterKind('Male_Ranger_Feet_Boots'), 'outfit');
    assert.equal(characterKind('Female_Ranger_Acc_Pauldrons'), 'outfit');
    assert.equal(characterKind('Male_Peasant_Body'), 'outfit');
    assert.equal(characterKind('Sword_Bronze'), 'weapon');
    assert.equal(characterKind('Shield_Wooden'), 'weapon');
  });

  it('undoes the base pack’s own texture asymmetry without collapsing the two skins', () => {
    // `T_Superhero_Female_Dark_BaseColor.png` carries the channel suffix and
    // `T_Superhero_Male_Dark.png` does not. A generated name would have produced one id, found one
    // file and dressed both bodies in the same skin.
    assert.equal(CHARACTERS_PROFILE.textureId('T_Superhero_Female_Dark_BaseColor.png'), 'superhero-female-dark');
    assert.equal(CHARACTERS_PROFILE.textureId('T_Superhero_Male_Dark.png'), 'superhero-male-dark');
    // ...and the `_png.png` typo the village kit already taught this importer about.
    assert.equal(CHARACTERS_PROFILE.textureId('T_Hair_1_BaseColor_png.png'), 'hair-1');
    assert.equal(CHARACTERS_PROFILE.textureId('T_Hair_1_BaseColor.png'), 'hair-1');
  });

  it('gives every part one role, blocks nothing, and declares a kind', () => {
    // Nothing a character wears sways and nothing it holds is ever scattered, so both of the two prop
    // kits' questions have one answer here.
    assert.equal(CHARACTERS_PROFILE.role('ranger'), 'solid');
    assert.equal(CHARACTERS_PROFILE.role('trim-metal'), 'solid');
    assert.equal(CHARACTERS_PROFILE.blocking.size, 0);
    assert.equal(CHARACTERS_PROFILE.version, CHARACTER_MANIFEST_VERSION);
    // The presence of `kind` is what switches on the three optional manifest fields - see
    // `KitProfile.kind`. Neither prop kit has one, which is what keeps their bytes unchanged.
    assert.ok(CHARACTERS_PROFILE.kind);
    assert.equal(NATURE_PROFILE.kind, undefined);
    assert.equal(VILLAGE_PROFILE.kind, undefined);
  });

  it('files a model on a shelf a human can read', () => {
    assert.equal(characterFamily('male-ranger-feet-boots'), 'male-ranger');
    assert.equal(characterFamily('superhero-female-full-body'), 'superhero-female');
    assert.equal(characterFamily('sword-bronze'), 'sword');
    assert.equal(characterFamily('nothing-like-this'), 'unknown');
  });
});

/** A two-primitive rigged glTF with a skin, in the shape the character packs actually take. */
function riggedSource(file: string, joints: number): Parameters<typeof buildCatalogue>[0][number] {
  return {
    file,
    gltfBytes: 100,
    binBytes: 200,
    gltf: {
      asset: { generator: 'test', version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'Armature' }, { name: 'Mesh', skin: 0 }],
      skins: [{ name: 'Armature', inverseBindMatrices: 2, joints: Array.from({ length: joints }, (_, i) => i) }],
      materials: [{ name: 'MI_Peasant', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 3, WEIGHTS_0: 4 }, indices: 1, material: 0 }] }],
      textures: [{ source: 0 }, { source: 1 }],
      images: [{ uri: 'T_Peasant_BaseColor.png' }, { uri: 'T_Peasant_Normal.png' }],
      samplers: [{}],
      accessors: [
        { count: 3, type: 'VEC3', componentType: 5126, min: [-0.2, 0, -0.1], max: [0.2, 1.8, 0.1] },
        { count: 3, type: 'SCALAR', componentType: 5123 },
        { count: joints, type: 'MAT4', componentType: 5126 },
        { count: 3, type: 'VEC4', componentType: 5121 },
        { count: 3, type: 'VEC4', componentType: 5126 },
      ],
      bufferViews: [{}],
      buffers: [{ byteLength: 200, uri: 'x.bin' }],
    } as never,
  };
}

describe('the character import', () => {
  const sources = [riggedSource('Male_Peasant_Body.gltf', 65), riggedSource('Superhero_Male_FullBody.gltf', 65)];
  const textures = new Map<string, Buffer>();

  it('is a pure function of its input, twice over', () => {
    assert.equal(
      sha1(buildCatalogue(sources, textures, CHARACTERS_PROFILE)),
      sha1(buildCatalogue(sources, textures, CHARACTERS_PROFILE)),
    );
  });

  it('keeps the rig in the emitted glTF, which is the thing the rewrite used to drop', () => {
    // The one change the characters profile forced on the shared rewrite. A node naming a `skins`
    // array that is not in the document is a `GLTFLoader` throw, not an untextured mesh.
    const built = buildCatalogue(sources, textures, CHARACTERS_PROFILE);
    for (const model of built.manifest.models) {
      const gltf = JSON.parse(built.gltfs.get(model.id)!) as { skins?: { joints: number[] }[] };
      assert.equal(gltf.skins?.[0]?.joints.length, 65, `${model.stem} lost its rig`);
      assert.equal(model.joints, 65);
    }
  });

  it('records the vendor stem beside the kebab id, because the round trip is lossy', () => {
    const built = buildCatalogue([riggedSource('Male_Ranger_Feet_Boots.gltf', 65)], textures, CHARACTERS_PROFILE);
    const boots = built.manifest.models[0]!;
    // His boots are `Feet_Boots` where hers are `Feet`: a renderer that re-derived the vendor's
    // spelling from the kebab id would 404 on two of the twenty parts.
    assert.equal(boots.stem, 'Male_Ranger_Feet_Boots');
    assert.equal(boots.id, 'male-ranger-feet-boots');
    assert.equal(boots.kind, 'outfit');
  });

  it('drops the normal map and keeps the base colour, exactly as the two prop kits do', () => {
    const built = buildCatalogue(sources, textures, CHARACTERS_PROFILE);
    assert.deepEqual([...built.textureFiles.keys()], ['peasant']);
    const gltf = JSON.parse(built.gltfs.get('male-peasant-body')!) as { images: { uri: string }[] };
    assert.deepEqual(gltf.images.map((image) => image.uri), ['../textures/peasant.png']);
  });

  it('emits none of the three new fields for a profile that does not classify', () => {
    // The nature and village manifests must be what they were before `skins`, `kind`, `stem` and
    // `joints` existed. All four are conditional, and this is the assertion that they stayed that way.
    const built = buildCatalogue([riggedSource('CommonTree_1.gltf', 65)], textures, NATURE_PROFILE);
    const model = built.manifest.models[0]!;
    assert.equal(model.kind, undefined);
    assert.equal(model.stem, undefined);
    assert.equal(model.joints, undefined);
    assert.equal(built.manifest.animations, undefined);
    // ...and the skin passthrough is conditional on the *source* having one, not on the profile, so a
    // hypothetical rigged tree would still keep its rig rather than emit a dangling reference.
    assert.ok(built.gltfs.get('common-tree-1')!.includes('"skins"'));
  });
});

/** A GLB with three clips, a mesh and a skin — everything {@link buildAnimationLibrary} must cut. */
function fixtureGlb(): Buffer {
  const bin = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) bin.writeFloatLE(i, i * 4);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Armature', children: [1] },
      { name: 'root', children: [2] },
      { name: 'pelvis', mesh: 0, skin: 0 },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 0, material: 0 }] }],
    materials: [{ name: 'MI_Mannequin' }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 0 }],
    animations: [0, 1, 2].map((i) => ({
      name: `Clip_${i}`,
      channels: [{ sampler: 0, target: { node: 1 + (i % 2), path: 'translation' } }],
      samplers: [{ input: i * 2, output: i * 2 + 1, interpolation: 'LINEAR' }],
    })),
    accessors: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      bufferView: i,
      componentType: 5126,
      count: 1,
      type: i % 2 === 0 ? 'SCALAR' : 'VEC3',
      ...(i % 2 === 0 ? { max: [0.5 + i] } : {}),
    })),
    bufferViews: [0, 1, 2, 3, 4, 5, 6].map((i) => ({ buffer: 0, byteOffset: i * 4, byteLength: 4 })),
    buffers: [{ byteLength: bin.length }],
  };
  const text = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (text.length % 4)) % 4;
  const jsonChunk = Buffer.concat([text, Buffer.alloc(pad, 0x20)]);
  const out = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + bin.length);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  const at = 20 + jsonChunk.length;
  out.writeUInt32LE(bin.length, at);
  out.writeUInt32LE(0x004e4942, at + 4);
  bin.copy(out, at + 8);
  return out;
}

describe('re-cutting an animation library', () => {
  const source = fixtureGlb();

  it('keeps exactly the clips it was asked for, in the order it was asked', () => {
    const { glb, clips, sourceClips } = buildAnimationLibrary(source, ['Clip_2', 'Clip_0']);
    assert.deepEqual(clips.map((clip) => clip.name), ['Clip_2', 'Clip_0']);
    assert.equal(sourceClips, 3);
    assert.deepEqual(readGlb(glb).json.animations.map((clip) => clip.name), ['Clip_2', 'Clip_0']);
  });

  it('throws on a clip the pack does not have, rather than shipping a body that freezes', () => {
    assert.throws(() => buildAnimationLibrary(source, ['Backflip_Of_Doom']), /no clip named/);
  });

  it('drops the mannequin and every accessor no kept clip reads', () => {
    const after = readGlb(buildAnimationLibrary(source, ['Clip_0']).glb);
    // The mesh is the vendor's own preview body; nothing draws it, and its skin's inverse-bind
    // matrices are the *mannequin's* rather than the character's — binding to them would be the one
    // way to get the retarget wrong.
    assert.equal(after.json.meshes, undefined);
    assert.equal(after.json.skins, undefined);
    assert.equal(after.json.materials, undefined);
    for (const node of after.json.nodes ?? []) {
      assert.equal(node.mesh, undefined);
      assert.equal(node.skin, undefined);
    }
    // Nodes all stay: they carry the joint *names* the retarget binds on, and pruning them would mean
    // reindexing every channel target for no measurable saving.
    assert.equal((after.json.nodes ?? []).length, 3);
    // One clip reads two accessors of the seven.
    assert.equal(after.json.accessors.length, 2);
    assert.equal(after.json.bufferViews.length, 2);
  });

  it('re-packs the buffer legally: every view four-byte aligned and inside the buffer', () => {
    const { glb } = buildAnimationLibrary(source, ['Clip_0', 'Clip_1', 'Clip_2']);
    const { json, bin } = readGlb(glb);
    const declared = json.buffers[0]!.byteLength;
    assert.ok(declared <= bin.length, 'the BIN chunk is shorter than the buffer says');
    for (const view of json.bufferViews) {
      assert.equal((view.byteOffset ?? 0) % 4, 0, 'a buffer view is not four-byte aligned');
      assert.ok((view.byteOffset ?? 0) + view.byteLength <= declared, 'a buffer view runs off the end');
    }
    for (const clip of json.animations) {
      for (const sampler of clip.samplers) {
        assert.ok(json.accessors[sampler.input], `${clip.name}: dangling input`);
        assert.ok(json.accessors[sampler.output], `${clip.name}: dangling output`);
      }
      for (const channel of clip.channels) assert.ok(json.nodes?.[channel.target.node], `${clip.name}: dangling target`);
    }
    // The bytes really did come across, at their new offsets.
    assert.equal(bin.readFloatLE(0), 0);
    assert.equal(bin.readFloatLE(4), 1);
  });

  it('is byte-identical twice, and the order it emits in is the order it was given', () => {
    const first = buildAnimationLibrary(source, ['Clip_2', 'Clip_0']).glb;
    assert.ok(first.equals(buildAnimationLibrary(source, ['Clip_2', 'Clip_0']).glb), 'the re-cut is not deterministic');
    // ...and a different *request* is a different file, which is what makes the first assertion mean
    // something.
    assert.ok(!first.equals(buildAnimationLibrary(source, ['Clip_0', 'Clip_2']).glb));
  });

  it('reads a clip’s length off its own keyframe times', () => {
    const { clips } = buildAnimationLibrary(source, ['Clip_1']);
    assert.equal(clips[0]!.duration, 2.5, 'the input accessor’s max is the clip’s end');
    assert.equal(clips[0]!.channels, 1);
  });
});

describe('the shipped animation library', { skip: existsSync(SHIPPED_UAL1) ? false : 'run modelgen --characters first' }, () => {
  it('retargets by name onto the 65 joints the bodies bind', () => {
    // The armature risk 6-M7 flagged as *"if it's false, M7 roughly doubles into a retargeting
    // project"*, checked on the file the browser will actually fetch.
    const { json } = readGlb(readFileSync(SHIPPED_UAL1));
    const targets = new Set<string>();
    for (const clip of json.animations) {
      for (const channel of clip.channels) targets.add(json.nodes![channel.target.node]!.name ?? '');
    }
    assert.equal(targets.size, 65);
    for (const name of ['root', 'pelvis', 'Head', 'hand_r', 'hand_l', 'foot_r']) {
      assert.ok(targets.has(name), `${name} is not animated`);
    }
    // Every clip drives all 65 joints on all three channels, and nothing draws.
    for (const clip of json.animations) assert.equal(clip.channels.length, 195, clip.name);
    assert.equal(json.meshes, undefined, 'the mannequin is still in the shipped file');
    assert.deepEqual(json.animations.map((clip) => clip.name).sort(), [...CHARACTER_CLIPS['ual1']!].sort());
  });
});
