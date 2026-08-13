/**
 * The wall texture, and the one property it exists to have: **it costs no program.**
 *
 * The owner's complaint was grey blocks beside their character — outdoors and in a city street, where
 * M6 dressed only the interiors. `prototypes.WALL_TEXTURES` argues why the answer is a picture on
 * `chunkPlan`'s existing box rather than a village module in front of it, and the load-bearing half
 * of that argument is a number: nine programs, unchanged. The obvious implementation — `material.map`
 * — sets `USE_MAP`, which is a `#define`, which would split the biggest material family in the
 * renderer in two. This file is what stops that from being reintroduced by somebody tidying up.
 *
 * The second thing it checks is the axis pick, which is `blend.blendWeightAt`'s trick in a second
 * costume: the shader cannot run headless, but the *choice* is the part that has to be right, and a
 * wall whose courses ran vertically would be visible from across a plaza.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { DataTexture, RepeatWrapping, ShaderLib } from 'three';

import {
  SECTORS,
  cellIndex,
  describeRoom,
  indexRooms,
  neighboursOf,
  sceneSeed,
  sceneZone,
  type Zone,
} from '@mygame/shared';

import {
  WALL_FRAGMENT_GLSL,
  WALL_VERTEX_GLSL,
  createWallMapControls,
  patchWallTexture,
  wallAxisOf,
} from './masonry.ts';
import { ScenePool } from './pool.ts';
import {
  ARCHETYPES,
  GROUND_TEXTURES,
  WALL_TEXTURES,
  materialFamily,
  materialKey,
  wallTextureOf,
} from './prototypes.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

describe('the wall texture', () => {
  it('reaches every wall the owner can see, and nothing that is not a wall', () => {
    // The two archetypes `chunkPlan.ts` draws a boundary with, and no third. A door, a stair, a
    // landmark, a destination ring and a body are all `plain` too and would every one of them be
    // wrong with masonry multiplied over them.
    for (const archetype of ARCHETYPES) {
      if (materialFamily(archetype) !== 'plain') continue;
      for (const sector of SECTORS) {
        const spec = wallTextureOf(archetype, sector);
        if (archetype === 'edge' || archetype === 'barrier') {
          assert.equal(spec !== undefined, WALL_TEXTURES[sector] !== undefined, `${archetype}/${sector}`);
        } else {
          assert.equal(spec, undefined, `${archetype}/${sector} took a wall texture`);
        }
      }
    }
    // Ten of the sixteen sectors. `cave` is M6's ruling — plaster in a cavern would be worse than
    // grey — and the four water sectors plus `air`/`astral` are surfaces nobody has looked at yet.
    assert.equal(Object.keys(WALL_TEXTURES).length, 10);
    assert.equal(WALL_TEXTURES['cave'], undefined, 'a cave keeps its rock at the sector colour');
    assert.equal(WALL_TEXTURES['deep_water'], undefined);
    assert.equal(WALL_TEXTURES['astral'], undefined);
  });

  it('costs nothing on the wire, because the village pack already fetched both pictures', () => {
    // The claim `WALL_TEXTURES`' docblock makes. `village.ts` only fetches the atlases its eleven
    // drawn modules wear, so a wall texture outside that set would be a new megabyte on the wire —
    // and this milestone's whole pitch is that the grey blocks cost one line and four uniforms.
    const fetched = new Set(Object.values(GROUND_TEXTURES).map((spec) => spec.texture));
    for (const spec of Object.values(WALL_TEXTURES)) {
      assert.ok(fetched.has(spec.texture), `${spec.texture} is not already fetched for a floor`);
    }
    // And it reuses those textures' own measured linear means, so the palette is untouched and the
    // fog-of-war ratio rows still land where `ScenePool.recolour` built them.
    for (const spec of Object.values(WALL_TEXTURES)) {
      const floor = Object.values(GROUND_TEXTURES).find((g) => g.texture === spec.texture);
      assert.deepEqual([...spec.mean], [...floor!.mean], `${spec.texture}'s mean drifted from the floor's`);
      assert.ok(spec.gain > 0 && spec.gain <= 1, `${spec.texture} gain ${spec.gain}`);
      assert.ok(spec.metres >= 2 && spec.metres <= 8, `${spec.texture} repeats every ${spec.metres} m`);
    }
  });

  it('picks the two world axes the face normal leaves', () => {
    // A north or south wall's face points along Z, so it samples `xy`: courses run east-west and
    // stack upward. An east or west wall's points along X and samples `zy`. A lid points up and takes
    // the plan view. Anything else would put a stretched elevation on the top of a wall.
    assert.equal(wallAxisOf([0, 0, -1]), 'xy');
    assert.equal(wallAxisOf([0, 0, 1]), 'xy');
    assert.equal(wallAxisOf([1, 0, 0]), 'zy');
    assert.equal(wallAxisOf([-1, 0, 0]), 'zy');
    assert.equal(wallAxisOf([0, 1, 0]), 'xz');
    assert.equal(wallAxisOf([0, -1, 0]), 'xz');
    // A diagonal is decided by the larger component and never by chance — the shader's `>` and this
    // function's must agree at the tie, which they do because both prefer Z when X and Z are equal.
    assert.equal(wallAxisOf([0.9, 0.1, 0.2]), 'zy');
    assert.equal(wallAxisOf([0.2, 0.1, 0.9]), 'xy');
    assert.equal(wallAxisOf([0.5, 0.1, 0.5]), 'xy');
  });

  it('finds all four of its anchors in three’s own Lambert source', () => {
    // **The failure this catches is silence.** `patchWallTexture` works by `String.replace` on three's
    // `#include` markers; if a marker moved between releases the uniforms would still be added to
    // `shader.uniforms` and the *code* would simply never be inserted — every wall would stay grey and
    // nothing anywhere would say so. Run against `ShaderLib.lambert`, which is the actual source three
    // compiles, so a version bump that renamed a chunk fails here rather than in a screenshot.
    const shader = {
      uniforms: {} as Record<string, { value: unknown }>,
      vertexShader: ShaderLib['lambert']!.vertexShader,
      fragmentShader: ShaderLib['lambert']!.fragmentShader,
    };
    // The anchors must be there to begin with, or the assertions below would pass vacuously.
    assert.ok(shader.vertexShader.includes('#include <begin_vertex>'));
    assert.ok(shader.fragmentShader.includes('#include <color_fragment>'));
    patchWallTexture(shader, createWallMapControls(undefined, null));

    for (const name of ['uWallMap', 'uWallScale', 'uWallGain', 'uWallMean']) {
      assert.ok(name in shader.uniforms, `${name} was not bound`);
    }
    // Declared once per stage, and the varyings' types match across the two — a mismatch is a link
    // error rather than a compile error and would be reported against neither file.
    for (const source of [shader.vertexShader, shader.fragmentShader]) {
      assert.equal((source.match(/varying vec3 vWallPos;/g) ?? []).length, 1);
      assert.equal((source.match(/varying vec3 vWallNrm;/g) ?? []).length, 1);
    }
    // The vertex body lands **after** `<begin_vertex>`, which is what declares `transformed`, and
    // after `<beginnormal_vertex>`, which is what declares `objectNormal`. Both are read by name.
    const begin = shader.vertexShader.indexOf('#include <begin_vertex>');
    const normal = shader.vertexShader.indexOf('#include <beginnormal_vertex>');
    const body = shader.vertexShader.indexOf('vWallPos = (modelMatrix');
    assert.ok(normal >= 0 && normal < begin, 'objectNormal is declared before the anchor');
    assert.ok(body > begin, 'the vertex body landed before the chunk that declares `transformed`');
    // And the fragment body lands **before** `<color_fragment>`, which is where three folds
    // `instanceColor` — this renderer's fog of war — into `diffuseColor`. After it, an unexplored room
    // would show a full-brightness stone course inside a black silhouette.
    const colour = shader.fragmentShader.indexOf('#include <color_fragment>');
    const course = shader.fragmentShader.indexOf('vec3 course = texture2D(uWallMap');
    assert.ok(course > 0 && course < colour, 'the wall texture landed after the fog of war');
    // `diffuseColor` is declared at the top of `main`, well before either anchor.
    const declared = shader.fragmentShader.indexOf('vec4 diffuseColor = vec4(');
    assert.ok(declared >= 0 && declared < course, 'diffuseColor is not in scope where the patch writes it');
  });

  it('is one sample and no `fract`, so the mip chain works at the fog line', () => {
    // A three-tap triplanar blend is the usual answer and it is three times the cost for a box whose
    // faces meet at 90 degrees — there is no seam to blend across. And a `fract` anywhere in the uv
    // would break the derivative at every repeat boundary, which at the far end of a 96 m dolly is a
    // line of aliasing across every wall in the frame.
    assert.equal((WALL_FRAGMENT_GLSL.match(/texture2D/g) ?? []).length, 1);
    assert.ok(!WALL_FRAGMENT_GLSL.includes('fract'));
    // World space, so two rooms' walls meeting on the gap's midline share one continuous stone.
    assert.ok(WALL_VERTEX_GLSL.includes('modelMatrix'));
    assert.ok(WALL_VERTEX_GLSL.includes('instanceMatrix'));
  });

  it('gives every plain material the patch and only the walls a gain', () => {
    const pool = new ScenePool();
    const before = pool.programKeys().size;
    assert.equal(pool.wallTextured(), 0, 'a wall must not be textured before the pack lands');

    // A 1x1 stand-in for the village pack's plaster and brick. What is being checked is the sweep and
    // the program count, neither of which cares what the pixels are.
    const stone = new DataTexture(new Uint8Array([200, 190, 180, 255]), 1, 1);
    stone.needsUpdate = true;
    const dressed = pool.dressWalls(() => stone);

    // Ten sectors x `edge`/`barrier` x present/faded = 40.
    assert.equal(dressed, 40);
    assert.equal(pool.wallTextured(), 40);
    assert.equal(pool.programKeys().size, before, 'texturing the walls compiled a program');
    assert.equal(pool.programKeys().size, 9, 'the program count is the number this project watches');
    // World-space sampling steps outside `[0, 1]` in the first metre, so the default clamp would
    // smear one row of texels down an entire city wall.
    assert.equal(stone.wrapS, RepeatWrapping);
    assert.equal(stone.wrapT, RepeatWrapping);

    // Idempotent: `kit.ts` and `village.ts` both finish their loads by sweeping and which lands first
    // is a race between two fetches.
    assert.equal(pool.dressWalls(() => stone), 40);
    assert.equal(pool.wallTextured(), 40);

    // And a sector with no row is untouched, in both twins.
    for (const faded of [false, true]) {
      const cave = pool.material(materialKey('edge', 'cave', faded));
      assert.ok(cave, 'a cave still has an edge material');
    }
    stone.dispose();
    pool.dispose();
  });

  it('reaches the rooms the owner was standing in', () => {
    // The coverage the milestone is judged on, over the whole built world rather than over a fixture.
    // M6's dressing reaches a room only when it is roofed *and* `inside`; a `city` street's blocks and
    // a `field` room's boundary were both outside it, and both were in the screenshots.
    if (!existsSync(ZONES_DIR)) return;
    const zones = readdirSync(ZONES_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => JSON.parse(readFileSync(join(ZONES_DIR, file), 'utf8')) as Zone)
      .sort((a, b) => a.id - b.id);
    const rooms = indexRooms(zones);

    let total = 0;
    let withWall = 0;
    let textured = 0;
    let solidEdges = 0;
    let texturedEdges = 0;
    const bySector = new Map<string, { rooms: number; walls: number }>();
    for (const zone of zones) {
      const context = sceneZone(zone);
      const cells = cellIndex(zone);
      for (const room of zone.rooms) {
        const scene = describeRoom(context, room, neighboursOf(cells, room, rooms), sceneSeed(context, room));
        total += 1;
        const sector = scene.biome.sector;
        let solid = 0;
        for (const dir of ['north', 'east', 'south', 'west'] as const) {
          const edge = scene.edges[dir];
          if (!edge.solid && (edge.mouth?.span ?? 0) > 0) continue;
          solid += 1;
        }
        if (solid === 0) continue;
        withWall += 1;
        solidEdges += solid;
        const row = bySector.get(sector) ?? { rooms: 0, walls: 0 };
        row.rooms += 1;
        bySector.set(sector, row);
        // A dressed interior's grey boxes are suppressed and wear village panels instead; every other
        // room with a solid side draws `edge` or `barrier`, which is what this table paints.
        if (wallTextureOf('edge', sector) === undefined) continue;
        textured += 1;
        texturedEdges += solid;
        row.walls += solid;
      }
    }
    // Split, because an `inside` room's grey boxes are *suppressed* the moment the village kit lands
    // and it wears panels instead — so its row here is the fallback (a kit that never loaded, or a
    // party wall whose other side is undressed) rather than the headline. The headline is everything
    // else: the streets and the open country M6 never reached at all.
    const interior = bySector.get('inside') ?? { rooms: 0, walls: 0 };
    console.log(
      `[M9 walls] ${textured} of ${withWall} rooms with a solid side gain a textured wall ` +
        `(${((textured / withWall) * 100).toFixed(1)}%), ${texturedEdges} of ${solidEdges} solid sides; ` +
        `${texturedEdges - interior.walls} of them outdoors, where M6 dressed nothing at all; ` +
        `${total} rooms swept`,
    );
    console.log(
      `[M9 walls by sector] ${[...bySector]
        .filter(([, row]) => row.walls > 0)
        .sort((a, b) => b[1].walls - a[1].walls)
        .map(([sector, row]) => `${sector} ${row.walls}`)
        .join(', ')}`,
    );
    // The city rooms the owner's screenshot was taken in, and the field rooms the kobolds are in.
    assert.ok((bySector.get('city')?.walls ?? 0) > 3000, 'the city walls are the complaint');
    assert.ok((bySector.get('field')?.walls ?? 0) > 100, 'and so was the kobold field');
    assert.ok(textured / withWall > 0.5, `only ${textured} of ${withWall} rooms gain a picture`);
  });

  it('leaves the grey box exactly as M3 painted it when nothing has loaded', () => {
    // The untextured case is the *common* one for the first second of every session and the permanent
    // one for a clone with no `public/models`. A gain of zero makes the shader's `mix` return white,
    // which is a multiply by one — so the fallback is not a fallback, it is the same fragment.
    const pool = new ScenePool();
    for (const sector of SECTORS) {
      for (const archetype of ['edge', 'barrier'] as const) {
        const material = pool.material(materialKey(archetype, sector, false));
        assert.equal(material.map, null, `${archetype}/${sector} took a \`map\` and therefore a define`);
      }
    }
    assert.equal(pool.wallTextured(), 0);
    pool.dispose();
  });
});
