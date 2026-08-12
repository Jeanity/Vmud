/**
 * The pool key set is bounded, and this is the assertion the plan asks for by name.
 *
 * *"Geometries and materials are pooled per (biome, archetype) and never created per room or per
 * zone — **bound the pool key set explicitly and assert its size in a test**."* A count that is
 * written down here and nowhere else is the only thing standing between the design and the failure
 * mode it exists to prevent, so the number is spelled out rather than recomputed from the same
 * tables the implementation uses: recomputing it would make the test agree with any change,
 * including the one that reintroduces the leak.
 *
 * M5a adds the number that matters most now that there are three material families: **the program
 * count**. 145 materials, three programs, and the third assertion in this file is the one that says
 * so — because a foliage material that forgot its `customProgramCacheKey`, or a ground material that
 * varied a `#define` instead of a uniform, would compile one program per material and the first
 * symptom would be a two-second hitch the first time somebody walked into a wood.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SECTORS } from '@mygame/shared';

import {
  ARCHETYPES,
  ARCHETYPE_GEOMETRY,
  BIOME_ARCHETYPES,
  GEOMETRY_KEYS,
  KIT_GEOMETRY_KEYS,
  KIT_MODELS,
  KIT_PARTS,
  KIT_TEXTURES,
  MATERIAL_KEYS,
  SHAPE_KEYS,
  TREE_GEOMETRY_KEYS,
  TREE_LODS,
  TREE_PARTS,
  TREE_VARIANTS,
  VARIANT_ARCHETYPES,
  VILLAGE_GEOMETRY_KEYS,
  VILLAGE_MODELS,
  CHARACTER_TEXTURES,
  characterMaterialKey,
  VILLAGE_PARTS,
  archetypeColour,
  kitMaterialKey,
  kitRoleOf,
  linearRgb,
  materialFamily,
  materialKey,
  treeFamily,
  treeMaterialKey,
  treePartsOf,
  treeRationOf,
  variantsFrom,
  villageMaterialKey,
} from './prototypes.ts';
import { ScenePool, WRAPPER_POOL_SIZE } from './pool.ts';

/** `kitSolid` and `kitLeaf`. Spelled out rather than derived, for this file's own stated reason. */
const KIT_ARCHETYPE_COUNT = 2;

/** `villageSolid` — M6's one. Same reason it is a literal: deriving it would let the table widen. */
const VILLAGE_ARCHETYPE_COUNT = 1;

/** `character` — M7b's one, and it is keyed by texture alone. Same reason it is a literal. */
const CHARACTER_ARCHETYPE_COUNT = 1;

describe('the pool key set', () => {
  it('has exactly seven built shapes, and the trees and the kit on top of them', () => {
    // Seven at M5c: `groundBox` is the plain box with a subdivided face, and it exists because the
    // domain warp displaces the ground's *vertices* — four corners can only draw a curve as a chord.
    assert.equal(SHAPE_KEYS.length, 7);
    assert.deepEqual(
      [...SHAPE_KEYS],
      ['box', 'groundBox', 'cone', 'torus', 'capsule', 'grassCross', 'waterPlane'],
    );
    // 8 baked + 20 kit variants. Closed, enumerated at module load, and asserted against the two
    // manifests in `assets.test.ts` and `kit.test.ts` — see those files for the other half of the
    // contract. The geometry count is *not* `variants x parts x LODs`, because the kit's `DeadTree`
    // is a trunk and nothing else: 8x2 + 15x2 + 5x1 = 51 parts, x3 LODs = 153.
    assert.equal(TREE_VARIANTS.length, 28);
    assert.equal(variantsFrom('baked').length, 8);
    assert.equal(variantsFrom('kit').length, 20);
    assert.equal(TREE_PARTS.length, 2);
    assert.equal(TREE_LODS.length, 3);
    assert.equal(TREE_GEOMETRY_KEYS.length, 153);
    assert.equal(new Set(TREE_GEOMETRY_KEYS).size, 153);
    // Five `DeadTree`s with no canopy is the whole of the difference from `28 x 2 x 3 = 168`.
    assert.equal(TREE_GEOMETRY_KEYS.length, 168 - 5 * TREE_LODS.length);
    // The kit's props: 43 models, of which five carry two primitives — the flowering bush and the
    // four flower clusters.
    assert.equal(KIT_MODELS.length, 43);
    assert.equal(KIT_PARTS.length, 48);
    assert.equal(KIT_GEOMETRY_KEYS.length, 48);
    assert.equal(new Set(KIT_GEOMETRY_KEYS).size, 48);
    // M6's village: eleven of the pack's 176 models, nineteen `(model, texture)` parts. The eleven
    // are the closed subset the interior mode draws — see `VILLAGE_PART_TEXTURES` for what is
    // deliberately absent (stairs, door frames, vines, and the seven untextured glass primitives).
    assert.equal(VILLAGE_MODELS.length, 11);
    assert.equal(VILLAGE_PARTS.length, 19);
    assert.equal(VILLAGE_GEOMETRY_KEYS.length, 19);
    assert.equal(new Set(VILLAGE_GEOMETRY_KEYS).size, 19);
    assert.equal(GEOMETRY_KEYS.length, 7 + 153 + 48 + 19);
  });

  it('gives every kit part a role, and the two roles a family each', () => {
    // `modelgen.kitRole`'s mirror. `kit.test.ts` holds both to the generated manifest; this holds the
    // *rule* — a texture whose name starts `leaves`/`leaf-`, or that is `grass` or `flowers`, sways.
    for (const texture of KIT_TEXTURES) {
      const role = kitRoleOf(texture);
      assert.ok(role === 'solid' || role === 'leaf', `${texture} has no role`);
    }
    assert.equal(kitRoleOf('bark-normal-tree'), 'solid');
    assert.equal(kitRoleOf('rocks-diffuse'), 'solid');
    // A mushroom cap is a closed mesh with no alpha in it, so it is solid however organic it looks.
    assert.equal(kitRoleOf('mushrooms'), 'solid');
    assert.equal(kitRoleOf('leaves'), 'leaf');
    assert.equal(kitRoleOf('leaf-pine-c'), 'leaf');
    assert.equal(kitRoleOf('grass'), 'leaf');
    assert.equal(kitRoleOf('flowers'), 'leaf');
    // Which decides the family, which decides the program.
    assert.equal(materialFamily('kitSolid'), 'kitSolid');
    assert.equal(materialFamily('kitLeaf'), 'kitLeaf');
    // …and a tree's family depends on where its mesh came from, and on nothing else.
    assert.equal(materialFamily('trunk', 'pine-tall'), 'plain');
    assert.equal(materialFamily('trunk', 'common-tree-1'), 'kitSolid');
    assert.equal(materialFamily('canopy', 'pine-tall'), 'foliage');
    assert.equal(materialFamily('canopy', 'common-tree-1'), 'kitLeaf');
  });

  it('rations the landmark trees and leaves the workhorses alone', () => {
    // The brief: *"TwistedTree … landmark accents, <=1 per room, never bulk scatter"*. By **family**,
    // because five variants each rationed to one is five twisted trees.
    assert.equal(treeFamily('twisted-tree-3'), 'twisted-tree');
    assert.equal(treeFamily('common-tree-1'), 'common-tree');
    assert.equal(treeFamily('pine-tall'), 'pine-tall');
    assert.equal(treeRationOf('twisted-tree-1'), 1);
    assert.equal(treeRationOf('twisted-tree-5'), 1);
    assert.equal(treeRationOf('dead-tree-2'), 4);
    assert.equal(treeRationOf('common-tree-1'), Infinity);
    assert.equal(treeRationOf('pine-tall'), Infinity);
  });

  it('gives DeadTree a trunk and no canopy, and every other tree both', () => {
    for (const variant of TREE_VARIANTS) {
      const parts = treePartsOf(variant);
      assert.ok(parts.includes('trunk'), `${variant} has no trunk`);
      assert.equal(parts.includes('canopy'), !variant.startsWith('dead-tree-'), variant);
    }
    // …and the material pool is sized off that, not off the cross product.
    assert.ok(!MATERIAL_KEYS.includes(treeMaterialKey('canopy', 'dead-tree-1' as never)));
    assert.ok(MATERIAL_KEYS.includes(treeMaterialKey('trunk', 'dead-tree-1' as never)));
  });

  it('has exactly 312 materials, and the arithmetic is legible', () => {
    // Terrain: 5 biome archetypes x 16 sectors = 80, of which `grass` never fades, so
    // 4 x 16 = 64 with twins (128) plus 16 without = 144.
    // Trees: 51 real parts across 28 variants, none of which fade.
    // Objects: the remaining 12 archetypes = 12, with twins for all but `self`/`other`/`marker`/
    //   `water`/`puddle` = 19.
    // Kit props: 48 `(model, texture)` parts, none of which fade.
    // Village: 19 parts, each with an **open** twin — the near-wall fade, which is not the vertical
    //   policy's `dim` and has its own opacity — so 38.
    // Characters: 12 atlases, keyed by texture alone rather than by `(model, texture)` — a body
    //   material carries no per-model uniform, so 26 models share twelve materials. None fade.
    // 144 + 51 + 19 + 48 + 38 + 12 = 312.
    //
    // 110 at M3. M4 added `glow` and its twin — the stairwell marker — the *whole* of M4's growth,
    // because the emissive ring is a uniform on an existing material and the three-state fog of war is
    // a per-instance colour, so neither multiplied this table. Click-to-move added `marker`: 113.
    // M5a added 32: eight barks, eight canopies and sixteen undergrowths. M5b added 85: 35 kit tree
    // parts, 48 kit prop parts, and the water and puddle surfaces. **M6 adds 70**: the `ceiling`
    // archetype crossed with the sixteen sectors and twinned (32), and the village's 19 parts
    // twinned (38). Neither adds a *program*. **M7b adds 12** and, unlike every prior milestone, it
    // *does* add two programs — a body is a `SkinnedMesh` and the sword in its hand is not, and
    // `USE_SKINNING` is a `#define`. See the traversal test, which now asserts nine and says why.
    const terrain = (BIOME_ARCHETYPES.length - 1) * SECTORS.length;
    let trees = 0;
    for (const variant of TREE_VARIANTS) trees += treePartsOf(variant).length;
    const objects =
      ARCHETYPES.length -
      BIOME_ARCHETYPES.length -
      VARIANT_ARCHETYPES.length -
      KIT_ARCHETYPE_COUNT -
      VILLAGE_ARCHETYPE_COUNT -
      CHARACTER_ARCHETYPE_COUNT;
    assert.equal(terrain, 64);
    assert.equal(trees, 51);
    assert.equal(objects, 12);
    assert.equal(MATERIAL_KEYS.length, 312);
    // The `- 5` is `self`, `other`, `marker`, `water` and `puddle` — the object archetypes with no
    // faded twin. Literals rather than `NEVER_FADED.size` on purpose, the same reasoning the file
    // header gives for the whole test: recomputing the exclusion from the table under test would let
    // the table widen silently and this assertion would still agree with it.
    assert.equal(
      MATERIAL_KEYS.length,
      terrain * 2 +
        SECTORS.length +
        trees +
        objects +
        (objects - 5) +
        KIT_PARTS.length +
        VILLAGE_PARTS.length * 2 +
        CHARACTER_TEXTURES.length,
    );
  });

  it('enumerates without duplicates', () => {
    assert.equal(new Set(MATERIAL_KEYS).size, MATERIAL_KEYS.length);
  });

  it('is closed: every key any of the three constructors can produce is already in the list', () => {
    const known = new Set(MATERIAL_KEYS);
    for (const archetype of ARCHETYPES) {
      if ((VARIANT_ARCHETYPES as readonly string[]).includes(archetype)) continue;
      // The kit's two archetypes are never crossed with a sector: a kit material's identity is its
      // `(model, texture)` pair, which is the third loop below.
      if (archetype === 'kitSolid' || archetype === 'kitLeaf') continue;
      // Nor is M6's, for the same reason: a village material's identity is its `(model, texture)`
      // pair plus whether it is the open twin, which is the fourth loop below.
      if (archetype === 'villageSolid') continue;
      // Nor is M7b's: a character material's identity is its *texture* and nothing else — twelve
      // atlases across 26 models — which is the fifth loop below.
      if (archetype === 'character') continue;
      for (const faded of [false, true]) {
        for (const sector of SECTORS) {
          assert.ok(known.has(materialKey(archetype, sector, faded)), `${archetype}/${sector}/${faded}`);
        }
        assert.ok(known.has(materialKey(archetype, undefined, faded)), `${archetype}/-/${faded}`);
      }
    }
    for (const archetype of VARIANT_ARCHETYPES) {
      for (const variant of TREE_VARIANTS) {
        if (!treePartsOf(variant).includes(archetype)) continue;
        assert.ok(known.has(treeMaterialKey(archetype, variant)), `${archetype}/${variant}`);
      }
    }
    for (const part of KIT_PARTS) {
      assert.ok(known.has(kitMaterialKey(part.model, part.texture)), `${part.model}/${part.texture}`);
    }
    for (const texture of CHARACTER_TEXTURES) {
      assert.ok(known.has(characterMaterialKey(texture)), `character/${texture}`);
    }
    for (const part of VILLAGE_PARTS) {
      for (const open of [false, true]) {
        assert.ok(
          known.has(villageMaterialKey(part.model, part.texture, open)),
          `${part.model}/${part.texture}/${open}`,
        );
      }
    }
  });

  it('gives every archetype a shape the pool can hold', () => {
    for (const archetype of ARCHETYPES) {
      assert.ok(GEOMETRY_KEYS.includes(ARCHETYPE_GEOMETRY[archetype]), archetype);
    }
  });

  it('gives a terrain archetype a different colour per sector', () => {
    const grounds = new Set(SECTORS.map((sector) => archetypeColour('ground', sector)));
    assert.equal(grounds.size, SECTORS.length, 'two sectors sharing a ground colour is a palette bug');
    // A barrier is the edge material darkened — same hue family, unmistakably not the same value.
    for (const sector of SECTORS) {
      assert.notEqual(archetypeColour('barrier', sector), archetypeColour('edge', sector));
      // Undergrowth is its own ground, darker. Never equal, or the tufts are invisible.
      assert.notEqual(archetypeColour('grass', sector), archetypeColour('ground', sector));
    }
  });

  it('converts sRGB to the linear space the blend shader mixes in', () => {
    // The three anchors three's own `Color.setHex` agrees on: black, white, and the 0.5 midpoint,
    // which is where a naive `x / 255` would be visibly wrong (0.5 sRGB is 0.214 linear, not 0.5).
    assert.deepEqual(linearRgb(0x000000), [0, 0, 0]);
    const white = linearRgb(0xffffff);
    for (const channel of white) assert.ok(Math.abs(channel - 1) < 1e-6, `white is ${channel}`);
    const mid = linearRgb(0x808080)[0];
    assert.ok(Math.abs(mid - 0.2158) < 0.002, `0x80 linearises to ${mid}`);
  });

  it('sorts every archetype into one of three material families', () => {
    assert.equal(materialFamily('ground'), 'blend');
    assert.equal(materialFamily('canopy'), 'foliage');
    assert.equal(materialFamily('grass'), 'foliage');
    assert.equal(materialFamily('trunk'), 'plain');
    assert.equal(materialFamily('edge'), 'plain');
  });

  it('builds the whole pool in the constructor and never grows it', () => {
    const pool = new ScenePool();
    const start = pool.snapshot();
    // The six built shapes. The 153 tree keys and the 48 kit keys arrive through `registerGeometry`
    // at boot — see `trees.ts` and `kit.ts` for why that does not unbind the key set.
    assert.equal(start.geometries, SHAPE_KEYS.length);
    assert.equal(start.materials, MATERIAL_KEYS.length);
    // 108 window chunks x 9 plain buckets + 54 ground-level cells x (15 scatter + 1 puddle) wrappers
    // + 2 bodies + 1 marker = 1,839, plus 108 ground wrappers and 54 water wrappers on their own free
    // lists = 2,001. Derived, not chosen — see `pool.ts`. M5a's scatter term was 7 (3 species x 2
    // parts + 1 undergrowth); M5b adds 4 kit models x 2 parts to it, and the two surfaces separately.
    //
    // **M6 moved every one of these**, and by a lot: the streaming ring went from 7 x 5 x 2 = 70 cells
    // to 9 x 6 x 2 = 108, because the dolly can now show 24.8 m of ground ahead of the character
    // instead of 12.3 and 32.3 m either side instead of 20.4 (`streamer.ts`). The pool is minted once
    // — that is the flat-ledger acceptance — so the ceiling has to be the worst pose rather than the
    // current one, and 703 more wrappers is what the wider frame costs at boot.
    //
    // **M6-interiors moves it by exactly 108** — one wrapper per window chunk for the `ceiling`
    // archetype, the lid every roofed room gets. The *dressing* moves it by nothing: a chunk is
    // dressed by `interior.ts` only when it is roofed and `inside`, and no scatter table has an
    // `inside` row, so `pool.DRESSED_WRAPPER_CEILING` is a `max(16, 11)` over two terms no chunk in
    // the world can want at once. `interior.test.ts` asserts that exclusivity over all 46,544 rooms
    // rather than leaving it as an argument.
    // **The owner's zoom doubling moves all of it again** (2026-08-13, the same evening): the dolly
    // ceiling went 48 -> 96 on the ask "about 100% more", the ring re-derived to 15 x 10 x 2 = 300
    // cells — with `SHADOW_PAD` now folded into the lateral and north cell counts, because at 48 m
    // the `ceil` slack covered the moon's pad by luck and at 96 m it stopped — and the pool followed:
    // 300 x 10 + 150 x 16 + 3 = 5,403, plus 300 ground and 150 water wrappers on their own lists.
    // Nothing here was chosen; the clamp was — twice now.
    // **M7b moves it by exactly one**: a third entity wrapper for the `creature:` placeholders, which
    // are the only bodies carrying a per-instance colour and so cannot share the two white ones. The
    // `character` archetype itself adds none — a body is a `SkinnedMesh` off `BODY_POOL_SIZE`, not a
    // wrapper — which is why it is carved out of `CHUNK_BUCKET_CEILING` beside `self`/`other`/`marker`.
    //
    // **M8 moves all of it once more, and it is the free yaw's whole bill.** The owner asked to orbit
    // the camera; a streaming ring with a lookahead in it is a claim about which way the camera
    // points, so the ring became a symmetric **disc** of 293 cells a level, 586 chunks against 300.
    // The pool followed by arithmetic and nothing else: `586 x 10 + 293 x 16 + 3 + 1 = 10,552`, plus
    // 586 ground and 293 water wrappers on their own lists = **11,431**. `+5,577` wrappers at 3,968 B
    // is `+22.1 MB`, all of it instance buffer and not one byte of geometry. See `streamer.ts` for
    // why symmetric beat rotating the window (churn: an orbit is one continuous drag, and a window
    // that changed shape during it would rebuild the world under the gesture) and why the disc beat
    // the 19 x 19 square that covers the same radius (19% of the cells, for one `hypot`).
    assert.equal(WRAPPER_POOL_SIZE, 10_552);
    assert.equal(start.prewarmed, 11_431);
    assert.equal(start.blendWrappers, 879, 'ground and water both own their instanced attributes');
    assert.equal(start.wrappersCreated, 11_431, 'all three free lists are whole before anything asks');
    assert.equal(start.wrappersFree, 11_431);
    assert.equal(start.wrappersLive, 0);
    // M7b: no rig exists until a base body has loaded, and none has. The body family is the one
    // allocation in this pool that is *not* pre-warmed — see `BODY_POOL_SIZE`.
    assert.equal(start.rigsCreated, 0);
    assert.equal(start.rigsLive, 0);
    assert.equal(start.rigsRefused, 0);
    // Nothing has been loaded, so nothing is on the texture ledger. It is the biggest number in the
    // renderer once the kit lands, and it must be zero until it does.
    assert.equal(start.textures, 0);
    assert.equal(start.textureBytes, 0);

    // Ask for every key. Nothing may be constructed by the asking.
    for (const key of MATERIAL_KEYS) assert.ok(pool.material(key));
    for (const key of SHAPE_KEYS) assert.ok(pool.geometry(key));
    const after = pool.snapshot();
    assert.deepEqual(after, start);
    pool.dispose();
  });

  it('costs nine programs for 312 materials, plus two for the foliage shadows', () => {
    const pool = new ScenePool();
    const keys = pool.programKeys();
    assert.equal(
      keys.size,
      9,
      'expected plain/blend/foliage x2/kit-solid/water/puddle/character x2, got ' + [...keys].join(', '),
    );
    // The two foliage programs are the *same patch* under two `#define` sets: `USE_MAP` is three's
    // and cannot be a uniform, so a textured kit leaf and an untextured baked card are two compiled
    // programs however identical the source is. Both are alpha-clipped and double-sided.
    const foliage = [...keys].filter((key) => key.includes(':foliage'));
    assert.equal(foliage.length, 2, foliage.join(', '));
    assert.equal(foliage.filter((key) => key.includes(':map:')).length, 1, 'one of the two is textured');
    for (const key of foliage) assert.ok(key.includes(':clip:'), `${key} does not clip`);
    assert.equal([...keys].filter((key) => key.includes('ground-blend')).length, 1);
    assert.equal([...keys].filter((key) => key.includes('kit-solid')).length, 1, '83 kit solids, one program');
    assert.equal([...keys].filter((key) => key.includes(':water')).length, 1);
    assert.equal([...keys].filter((key) => key.includes(':puddle')).length, 1);
    // **M7b's two, and the only milestone so far to cost more than one program.**
    //
    // A character material is `kitSolid`'s recipe minus the wetness patch — rain darkening a boulder
    // is the effect working and rain darkening a face is a sheen nobody asked for — so it is its own
    // `customProgramCacheKey`, which is one. The *second* is not a material difference at all:
    // `USE_SKINNING` is an **object** define, a body is a `SkinnedMesh` and the sword in its hand is a
    // plain `Mesh` parented to a bone, so those two compile separately however identical their
    // materials are. The pool records which is which at build time (the body atlases and the prop
    // atlases are disjoint sets) precisely so this proxy does not under-report the browser by one.
    const character = [...keys].filter((key) => key.includes(':character:'));
    assert.equal(character.length, 2, character.join(', '));
    assert.equal(character.filter((key) => key.endsWith(':skin')).length, 1, 'nine skinned atlases');
    assert.equal(character.filter((key) => key.endsWith(':rigid')).length, 1, 'three prop atlases');
    // Only foliage clips: a kit solid is bark and rock, opaque however the glTF's `MASK` flag reads.
    assert.equal([...keys].filter((key) => key.includes(':clip:')).length, 2);
    // `foliage.ts`'s trap 1: one depth material per foliage program, and no more.
    assert.equal(pool.depthPrograms().size, 2);
    pool.dispose();
  });

  it('gives a kit material a texture slot from the first compile, not from the frame it loads', () => {
    // `USE_MAP` is a `#define`. A kit material born without a map and given one when the PNG lands
    // would compile a *second* program on that frame, and — worse for this project — the headless
    // program proxy would report a different number than the browser. The white 1x1 placeholder is
    // what makes those two agree; see `pool.whiteTexture`.
    const pool = new ScenePool();
    const key = kitMaterialKey('rock-medium-1', 'rocks-diffuse');
    const material = pool.material(key);
    assert.ok(material.map, 'a kit material has no texture slot');
    assert.equal(material.vertexColors, true, 'the kit bakes its AO into COLOR_0');
    const before = pool.programKeys().size;
    // Swapping the placeholder for a real texture must not move the program count.
    pool.dressKit(key, material.map);
    assert.equal(pool.programKeys().size, before);
    pool.dispose();
  });

  it('recycles wrappers rather than minting them', () => {
    const pool = new ScenePool();
    const minted = pool.snapshot().wrappersCreated;
    const first = pool.acquire('box', 'edge|field');
    const second = pool.acquire('box', 'edge|forest');
    assert.equal(pool.snapshot().wrappersLive, 2);
    pool.release(first);
    pool.release(second);
    assert.equal(pool.snapshot().wrappersFree, minted);

    for (let round = 0; round < 50; round++) {
      const mesh = pool.acquire('cone', 'landmark');
      pool.release(mesh);
    }
    const ledger = pool.snapshot();
    assert.equal(ledger.wrappersCreated, minted, 'fifty acquire/release rounds must mint nothing');
    assert.equal(ledger.wrappersLive, 0);
    assert.equal(ledger.acquires - ledger.releases, ledger.wrappersLive);
    assert.equal(ledger.wrapperHighWater, 2);
    assert.equal(ledger.bytes, ledger.geometryBytes + ledger.instanceBytes);
    pool.dispose();
  });

  it('moves the undergrowth’s fade to a new frame without touching a canopy — M6', () => {
    /*
     * The wheel writes `uFade` on every understory material in the pool, live. Two things must hold
     * and the second is the one with teeth:
     *
     * - it must reach the **depth** materials, or a tuft dissolves while its shadow stays — which is
     *   `foliage.ts`'s trap 1, and it holds by construction because a foliage pair shares one
     *   uniforms object *by reference*; asserted here as object identity rather than as equal values;
     * - it must **not** reach a canopy. `createFoliageUniforms` gives a canopy `1e6` precisely so a
     *   tree cannot dissolve inside the frame, and a `setFadeBands` that swept every foliage uniform
     *   would hand a fifteen-metre spruce the grass band and fade it out at the back of the view.
     */
    const pool = new ScenePool();
    const canopyKey = MATERIAL_KEYS.find((key) => key.startsWith('canopy|'));
    assert.ok(canopyKey, 'no baked canopy in the key set');
    const grass = pool.foliage(materialKey('grass', 'forest', false));
    const canopy = pool.foliage(canopyKey);
    assert.ok(grass && canopy);
    const canopyBefore = { x: canopy.uFade.value.x, y: canopy.uFade.value.y };

    pool.setFadeBands([60, 75], [62, 77]);
    assert.deepEqual([grass.uFade.value.x, grass.uFade.value.y], [60, 75]);
    assert.deepEqual([canopy.uFade.value.x, canopy.uFade.value.y], [canopyBefore.x, canopyBefore.y]);
    assert.ok(canopy.uFade.value.x > 1e5, 'a canopy must never fade inside the frame');
    assert.deepEqual({ ...pool.fadeBands() }, { grass: [60, 75], kitLeaf: [62, 77] });

    // Every sector's undergrowth moved, not just the one that was asked for by name.
    for (const sector of SECTORS) {
      const other = pool.foliage(materialKey('grass', sector, false));
      if (other) assert.equal(other.uFade.value.x, 60, `${sector}'s tufts kept the old band`);
    }
    pool.dispose();
  });

  it('re-points a recycled wrapper at whatever the next chunk asked for', () => {
    const pool = new ScenePool();
    const first = pool.acquire('box', 'edge|forest');
    pool.release(first);
    const second = pool.acquire('cone', 'landmark');
    assert.equal(second, first, 'the free list is LIFO, so the same object comes straight back');
    assert.equal(second.geometry, pool.geometry('cone'));
    assert.equal(second.material, pool.material('landmark'));
    assert.equal(second.count, 0);
    pool.dispose();
  });

  it('keeps ground on its own free list, with its own blend buffers', () => {
    const pool = new ScenePool();
    const ground = pool.acquire('groundBox', 'ground|forest');
    // Not the shared shape: a blend wrapper owns a `BufferGeometry` view carrying `iBlend`/`iTint`
    // and M5c's `iWarp`, because three has no per-instance slot beyond `instanceMatrix` and
    // `instanceColor`. See `ScenePool.mintAttributed`.
    assert.notEqual(ground.geometry, pool.geometry('groundBox'));
    assert.ok(ground.geometry.getAttribute('iBlend'), 'the ground wrapper has no blend attribute');
    assert.ok(ground.geometry.getAttribute('iTint'), 'the ground wrapper has no tint attribute');
    assert.ok(ground.geometry.getAttribute('iWarp'), 'the ground wrapper has no warp attribute');
    // …but it shares the subdivided box's vertex data, so there is no second copy on the GPU.
    assert.equal(
      ground.geometry.getAttribute('position'),
      pool.geometry('groundBox').getAttribute('position'),
    );
    // …and that shape is the subdivided one, not the plain box the walls draw with.
    assert.ok(
      pool.geometry('groundBox').getAttribute('position').count >
        pool.geometry('box').getAttribute('position').count,
      'the ground slab is not subdivided — the warp would draw a nine-metre chord',
    );

    pool.writeBlend(ground, 0, [0.5, 0.5, 0, 0], [0.1, 0.2, 0.3, 0.4]);
    const blend = ground.geometry.getAttribute('iBlend');
    assert.equal(blend.getX(0), 0.5);
    assert.equal(blend.getZ(0), 0);
    // M5c's corner amplitudes ride the same wrapper and the same no-op rule.
    pool.writeWarp(ground, 0, [1, 0.25, 0, 0.5]);
    assert.equal(ground.geometry.getAttribute('iWarp').getY(0), 0.25);

    // A wall released back never becomes a ground wrapper and vice versa.
    pool.release(ground);
    const wall = pool.acquire('box', 'edge|forest');
    assert.notEqual(wall, ground);
    // …and writing blend or warp data to a wall is a no-op rather than an error.
    pool.writeBlend(wall, 0, [1, 1, 1, 1], [1, 1, 1, 1]);
    pool.writeWarp(wall, 0, [1, 1, 1, 1]);
    pool.release(wall);
    assert.equal(pool.snapshot().wrappersCreated, 11_431, 'the split lists must not mint');
    pool.dispose();
  });

  it('keeps water on a third free list, over the plane rather than the box', () => {
    // M5b. The same three.js fact as the ground's — `InstancedMesh` special-cases exactly two
    // per-instance buffers and neither is `iBlend` — but a different *shape*, so a third list rather
    // than a wider one. A water wrapper released back must never come off the ground's list, or a
    // room's slab would be drawn as a single quad.
    const pool = new ScenePool();
    const water = pool.acquire('waterPlane', 'water');
    assert.notEqual(water.geometry, pool.geometry('waterPlane'));
    assert.ok(water.geometry.getAttribute('iBlend'), 'the water wrapper has no corner attribute');
    assert.equal(water.geometry.getAttribute('position'), pool.geometry('waterPlane').getAttribute('position'));
    // Foam at two corners, depth and phase in the tint. See `water.planWater`.
    pool.writeBlend(water, 0, [1, 1, 0, 0], [1.4, 0.25, 0, 0]);
    assert.equal(water.geometry.getAttribute('iBlend').getX(0), 1);
    // A `Float32Array` round trip, so the depth comes back as 1.399999976 — asserted with a tolerance
    // rather than exactly, because the alternative is an assertion about IEEE 754.
    assert.ok(Math.abs(water.geometry.getAttribute('iTint').getX(0) - 1.4) < 1e-6);
    pool.release(water);

    const ground = pool.acquire('groundBox', 'ground|forest');
    assert.notEqual(ground, water, 'a released water wrapper came back as ground');
    assert.equal(
      ground.geometry.getAttribute('position'),
      pool.geometry('groundBox').getAttribute('position'),
    );
    pool.release(ground);
    const again = pool.acquire('waterPlane', 'water');
    assert.equal(again, water, 'LIFO: the water list gave its own wrapper back');
    pool.release(again);
    assert.equal(pool.snapshot().wrappersCreated, 11_431, 'the three lists must not mint');
    pool.dispose();
  });

  it('hands a canopy wrapper its custom depth material, and takes it away again', () => {
    const pool = new ScenePool();
    // `foliage.ts`'s trap 1 wired at the only place it can be: `customDepthMaterial` is a property of
    // the *object*, so a recycled wrapper must be given the right one — and a wrapper that used to be
    // a canopy must lose it, or a wall would cast a needle-shaped shadow.
    const canopy = pool.acquire('box', 'canopy|pine-tall');
    assert.ok(canopy.customDepthMaterial, 'a canopy wrapper has no custom depth material');
    pool.release(canopy);
    const wall = pool.acquire('box', 'edge|forest');
    assert.equal(wall, canopy, 'LIFO: the same object');
    assert.equal(wall.customDepthMaterial, undefined, 'the depth material outlived its canopy');
    pool.dispose();
  });

  it('accepts a baked geometry once and refuses to replace it', () => {
    const pool = new ScenePool();
    const before = pool.snapshot().geometries;
    const key = 'trunk:pine-tall:0';
    assert.equal(pool.hasGeometry(key), false, 'nothing is baked in');
    const box = pool.geometry('box');
    pool.registerGeometry(key, box);
    assert.equal(pool.hasGeometry(key), true);
    assert.equal(pool.snapshot().geometries, before + 1);
    pool.registerGeometry(key, pool.geometry('cone'));
    assert.equal(pool.geometry(key), box, 'a second registration must not swap it under a live wrapper');
    assert.equal(pool.snapshot().geometries, before + 1);
    pool.dispose();
  });
});
