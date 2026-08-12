/**
 * The village kit's contract with the importer — `kit.test.ts`'s sibling, holding the same seam.
 *
 * `prototypes.ts` names eleven models, nineteen `(model, texture)` parts and a table of measured
 * metres, all of them enumerated **at module load** because the material pool is sized against them.
 * `modelgen --village` writes a manifest describing what is actually on disk. Neither knows about the
 * other. This file is the only thing that makes them agree, and without it the failure mode is a room
 * with three walls: a key nothing registers draws nothing, silently.
 *
 * Skips cleanly when `public/models/village` is absent — it is git-ignored and reproducible with
 * `node packages/worldgen/src/modelgen.ts --village`, exactly as `data/world` is with `npm run
 * worldgen`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { ScenePool } from './pool.ts';
import {
  KIT_TEXTURES,
  VILLAGE_FLOORS,
  VILLAGE_METRICS,
  VILLAGE_MODELS,
  VILLAGE_PARTS,
  VILLAGE_PART_TEXTURES,
  VILLAGE_ROLE_CASTS,
  VILLAGE_TEXTURES,
  VILLAGE_WALLS,
  villageGeometryKey,
  villageMaterialKey,
  villageRoleOf,
} from './prototypes.ts';
import { VILLAGE_MANIFEST_VERSION, VILLAGE_REQUIRED, VillageSet, type VillageManifest } from './village.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MODELS = join(REPO_ROOT, 'packages', 'client3d', 'public', 'models', 'village');
const MANIFEST = join(MODELS, 'manifest.json');

describe('the village palettes', () => {
  it('never names a model the pool has no key for', () => {
    // The palettes are what `interior.ts` rolls against and the pool is sized against the parts
    // table, so a palette entry outside it is a wall nothing can draw — the exact silent failure
    // this file exists to catch, one indirection earlier.
    for (const palette of VILLAGE_WALLS) {
      assert.ok(VILLAGE_MODELS.includes(palette.plain), `${palette.plain} is not a pool model`);
      assert.ok(VILLAGE_MODELS.includes(palette.window), `${palette.window} is not a pool model`);
      assert.equal(villageRoleOf(palette.plain), 'wall');
      assert.equal(villageRoleOf(palette.window), 'wall');
    }
    for (const floor of VILLAGE_FLOORS) {
      assert.ok(VILLAGE_MODELS.includes(floor), `${floor} is not a pool model`);
      assert.equal(villageRoleOf(floor), 'floor');
    }
    // `VILLAGE_REQUIRED` is what `VillageSet.available` waits for, and it must be exactly the shell:
    // every wall and every floor, and nothing that is only a garnish.
    for (const model of VILLAGE_REQUIRED) {
      const role = villageRoleOf(model);
      assert.ok(role === 'wall' || role === 'floor', `${model} is required and is a ${role}`);
    }
    assert.ok(VILLAGE_REQUIRED.length >= 5, 'the shell needs more than one wall and one floor');
  });

  it('gives every part a role, and every role a shadow answer', () => {
    for (const model of VILLAGE_MODELS) {
      const role = villageRoleOf(model);
      assert.ok(role in VILLAGE_ROLE_CASTS, `${model}'s role ${role} has no shadow rule`);
      assert.ok((VILLAGE_PART_TEXTURES[model] ?? []).length > 0, `${model} has no parts`);
      for (const texture of VILLAGE_PART_TEXTURES[model] ?? []) {
        assert.ok(VILLAGE_TEXTURES.includes(texture), `${model} wears an unlisted texture ${texture}`);
      }
    }
    // A floor does not cast, on `ARCHETYPE_CASTS`'s own argument for `ground`; a wall and a roof do.
    assert.equal(VILLAGE_ROLE_CASTS.floor, false);
    assert.equal(VILLAGE_ROLE_CASTS.wall, true);
    assert.equal(VILLAGE_ROLE_CASTS.roof, true);
  });

  it('gives the open twin its own key and never confuses it with the vertical fade', () => {
    const solid = villageMaterialKey('wall-plaster-straight', 'plaster');
    const open = villageMaterialKey('wall-plaster-straight', 'plaster', true);
    assert.equal(solid, 'village|wall-plaster-straight|plaster');
    assert.equal(open, 'village|wall-plaster-straight|plaster|open');
    // The word that matters: `dim` is the level below and `open` is the wall the camera is behind.
    assert.ok(!open.includes('dim'));
    assert.equal(villageGeometryKey('wall-plaster-straight', 'plaster'), 'village:wall-plaster-straight:plaster');
  });

  it('shares the pool’s texture cache with the nature kit without colliding', () => {
    // **A latent hazard, pinned.** `ScenePool.registerTexture` is keyed on the bare manifest id and
    // is now written by two importers with two naming rules — `modelgen.kitId` for the nature pack
    // and `modelgen.villageTextureId` for the village one. They happen not to collide today (bark,
    // leaves and rocks against plaster, brick and tile) and nothing enforces it, so the collision
    // would arrive as an inn wearing pine needles the day somebody added a `Grass` to the village
    // pack. One `assert` is cheaper than a second namespace.
    const shared = KIT_TEXTURES.filter((id) => (VILLAGE_TEXTURES as readonly string[]).includes(id));
    assert.deepEqual(shared, [], 'the two kits claim the same texture id — the pool cache is one map');
  });

  it('registers a stand-in for every part, so the headless walk exercises the real path', () => {
    const pool = new ScenePool();
    const set = new VillageSet();
    assert.equal(set.available, false, 'an empty set must not claim it can dress a room');
    set.standIn(pool);
    assert.equal(set.available, true);
    assert.equal(set.loaded, VILLAGE_MODELS.length);
    for (const part of VILLAGE_PARTS) {
      assert.ok(pool.hasGeometry(villageGeometryKey(part.model, part.texture)), `${part.model}/${part.texture}`);
    }
    pool.dispose();
  });
});

if (!existsSync(MANIFEST)) {
  describe('the village kit on disk', () => {
    it('skips: the imported village kit is absent', (t) => {
      t.skip(`no ${MANIFEST} (git-ignored) — run \`node packages/worldgen/src/modelgen.ts --village\``);
    });
  });
} else {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as VillageManifest;
  const byId = new Map(manifest.models.map((model) => [model.id, model]));

  describe('the village kit on disk', () => {
    it('is the version this client reads', () => {
      assert.equal(manifest.version, VILLAGE_MANIFEST_VERSION);
      assert.ok(manifest.generator.includes('Medieval Village'));
      // The manifest is the whole pack; the pool's eleven are a subset of it, deliberately.
      assert.ok(manifest.models.length > 150, `only ${manifest.models.length} models imported`);
      assert.ok(VILLAGE_MODELS.length < manifest.models.length);
    });

    it('has every model and every part `prototypes.ts` names, with its files present', () => {
      for (const model of VILLAGE_MODELS) {
        const entry = byId.get(model);
        assert.ok(entry, `${model} is in the pool key set and not in the manifest`);
        const dir = join(MODELS, model);
        assert.ok(existsSync(join(dir, 'model.gltf')), `${model}/model.gltf is missing`);
        assert.ok(existsSync(join(dir, 'model.bin')), `${model}/model.bin is missing`);
        // The parts table must be the manifest's own, minus the untextured glass — which is the one
        // documented omission and is checked as an omission rather than assumed away.
        const textured = entry.parts.filter((part) => part.texture !== 'none').map((part) => part.texture);
        assert.deepEqual(
          [...(VILLAGE_PART_TEXTURES[model] ?? [])].sort(),
          [...new Set(textured)].sort(),
          `${model}'s parts disagree with the manifest`,
        );
      }
    });

    it('imports the seven glass primitives and gives none of them a pool key', () => {
      const glass = manifest.models.flatMap((model) => model.parts.filter((part) => part.texture === 'none'));
      assert.equal(glass.length, 7, 'the untextured `MI_WindowGlass` set moved');
      for (const model of VILLAGE_MODELS) {
        for (const part of byId.get(model)?.parts ?? []) {
          assert.ok(
            part.texture !== 'none' || !(VILLAGE_PART_TEXTURES[model] ?? []).includes(part.texture as never),
            `${model} gave a pool key to an untextured primitive`,
          );
        }
      }
    });

    it('measures the module grid the same way `prototypes.ts` states it', () => {
      // **The measurement the whole milestone rests on**, held against the generated manifest so a
      // re-import that moved a module fails here rather than silently unpicking the tiling. Note the
      // manifest's `depth` is the model's Z extent, which for a wall is its thickness.
      const wall = byId.get('wall-plaster-straight')!;
      assert.equal(wall.width, VILLAGE_METRICS.module, 'the wall module is no longer 2 m across');
      assert.ok(Math.abs(wall.height - VILLAGE_METRICS.wallHeight) < 0.01);
      assert.ok(Math.abs(wall.depth - VILLAGE_METRICS.wallDepth) < 0.01);
      for (const floor of VILLAGE_FLOORS) {
        const entry = byId.get(floor)!;
        assert.equal(entry.width, VILLAGE_METRICS.module, `${floor} is not a 2 m module`);
        assert.equal(entry.depth, VILLAGE_METRICS.module, `${floor} is not square`);
        assert.ok(entry.height < 0.05, `${floor} is ${entry.height} m thick — that is not a floor`);
      }
      const arch = byId.get('wall-arch')!;
      assert.equal(arch.width, VILLAGE_METRICS.module);
      assert.ok(Math.abs(arch.height - VILLAGE_METRICS.archHeight) < 0.01);
      const roof = byId.get('roof-round-tiles-8x8')!;
      assert.ok(Math.abs(roof.width - VILLAGE_METRICS.roofWidth) < 0.01);
      assert.ok(Math.abs(roof.depth - VILLAGE_METRICS.roofDepth) < 0.01);
      assert.ok(Math.abs(roof.height + roof.minY - VILLAGE_METRICS.roofRise) < 0.01);
      assert.ok(Math.abs(-roof.minY - VILLAGE_METRICS.roofDrop) < 0.01);
      // A 9.95 m roof over a 9 m block leaves an eave inside the two-tile gap, so two neighbouring
      // buildings' roofs never interpenetrate. That is what makes the tiled roof placeable at all.
      assert.ok(roof.width > 9 && roof.width < 11, `the roof is ${roof.width} m over a 9 m room`);
      assert.ok(roof.depth > 9 && roof.depth < 11);
    });

    it('carries only the textures the drawn models wear, and they are on disk', () => {
      const needed = new Set<string>();
      for (const model of VILLAGE_MODELS) {
        for (const texture of VILLAGE_PART_TEXTURES[model] ?? []) needed.add(texture);
      }
      let bytes = 0;
      for (const id of needed) {
        const entry = manifest.textures.find((texture) => texture.id === id);
        assert.ok(entry, `${id} is worn by a drawn model and is not in the manifest`);
        const file = join(MODELS, 'textures', `${id}.png`);
        assert.ok(existsSync(file), `${file} is missing`);
        assert.equal(statSync(file).size, entry.bytes, `${id}.png is not the size the manifest records`);
        bytes += entry.bytes;
      }
      const all = manifest.textures.reduce((total, texture) => total + texture.bytes, 0);
      console.log(
        `[M6 village textures] ${needed.size} of ${manifest.textures.length} fetched at runtime: ` +
          `${(bytes / 1024 / 1024).toFixed(1)} MB of the pack's ${(all / 1024 / 1024).toFixed(1)} MB`,
      );
      assert.ok(needed.size < manifest.textures.length, 'every texture is fetched — the subset buys nothing');
    });

    it('never uses a model with more parts than the pool is sized for', () => {
      for (const model of VILLAGE_MODELS) {
        assert.ok(
          (VILLAGE_PART_TEXTURES[model] ?? []).length <= 3,
          `${model} has more primitives than VILLAGE_PARTS_MAX`,
        );
      }
    });
  });
}
