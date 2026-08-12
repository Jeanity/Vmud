/**
 * The region cull, on synthetic rigs and then on the real bodies.
 *
 * Two halves, deliberately: the **classification** is pure arithmetic over joint names and index
 * buffers and is tested with hand-built data, so a failure names the rule that broke; the
 * **measurement** — that the male base body really does split into a head worth keeping and four
 * regions worth hiding — is asserted against the generated import, so a re-exported pack that moved
 * the weights fails here rather than as a character with a hole in it.
 *
 * The real half reads `public/models/characters`, which is git-ignored and reproducible with
 * `node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --characters --source <packs>`.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { BufferAttribute, BufferGeometry } from 'three';

import {
  BODY_REGIONS,
  HIDDEN_BY_SLOT,
  hiddenMaskFor,
  maskedGeometry,
  maskedIndex,
  masks,
  regionMask,
  regionOfJoint,
  vertexRegions,
} from './skin.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHARACTERS_DIR = join(PACKAGE_ROOT, 'public', 'models', 'characters');

/** The 65, in skeleton order — the armature all three packs share. */
const JOINTS = [
  'root', 'pelvis', 'spine_01', 'spine_02', 'spine_03', 'neck_01', 'Head',
  'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l',
  'index_01_l', 'index_02_l', 'index_03_l', 'index_04_leaf_l',
  'middle_01_l', 'middle_02_l', 'middle_03_l', 'middle_04_leaf_l',
  'pinky_01_l', 'pinky_02_l', 'pinky_03_l', 'pinky_04_leaf_l',
  'ring_01_l', 'ring_02_l', 'ring_03_l', 'ring_04_leaf_l',
  'thumb_01_l', 'thumb_02_l', 'thumb_03_l', 'thumb_04_leaf_l',
  'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'index_01_r', 'index_02_r', 'index_03_r', 'index_04_leaf_r',
  'middle_01_r', 'middle_02_r', 'middle_03_r', 'middle_04_leaf_r',
  'pinky_01_r', 'pinky_02_r', 'pinky_03_r', 'pinky_04_leaf_r',
  'ring_01_r', 'ring_02_r', 'ring_03_r', 'ring_04_leaf_r',
  'thumb_01_r', 'thumb_02_r', 'thumb_03_r', 'thumb_04_leaf_r',
  'thigh_l', 'calf_l', 'foot_l', 'ball_l', 'ball_leaf_l',
  'thigh_r', 'calf_r', 'foot_r', 'ball_r', 'ball_leaf_r',
];

describe('which part of a body a joint owns', () => {
  it('partitions all 65 joints and leaves none over', () => {
    assert.equal(JOINTS.length, 65);
    const counts = new Map<string, number>();
    for (const joint of JOINTS) {
      const region = regionOfJoint(joint);
      counts.set(region, (counts.get(region) ?? 0) + 1);
    }
    // `other` must be empty: it is what an unrecognised name answers, and an armature that grew a
    // `tail_01` should show up as triangles nobody can dress rather than be filed under the head.
    assert.equal(counts.get('other'), undefined, `unclassified: ${JOINTS.filter((j) => regionOfJoint(j) === 'other')}`);
    assert.equal(counts.get('head'), 2, 'neck_01 and Head');
    assert.equal(counts.get('torso'), 3, 'three spine joints');
    assert.equal(counts.get('hips'), 2, 'root and pelvis');
    assert.equal(counts.get('arms'), 48, 'two clavicles, two arms, two hands and forty fingers');
    assert.equal(counts.get('legs'), 4);
    assert.equal(counts.get('feet'), 6, 'two feet, two balls and their two leaf tips');
    assert.equal([...counts.values()].reduce((n, v) => n + v, 0), 65);
  });

  it('answers `other` for a name no pack has, rather than guessing', () => {
    assert.equal(regionOfJoint('tail_01'), 'other');
    assert.equal(regionOfJoint(''), 'other');
    // …and near-misses do not slide into a neighbour.
    assert.equal(regionOfJoint('spine'), 'other', 'the underscore is part of the rule');
    assert.equal(regionOfJoint('head'), 'other', 'the vendor capitalises exactly one joint');
  });
});

describe('what a garment hides', () => {
  it('gives the hips to the legs and never to the torso', () => {
    // The measurement behind it: the peasant torso garment reaches down to y = 0.921 m and the legs
    // garment up to y = 1.054 m, so the hip is covered by the trousers. A jerkin that hid it would cut
    // a character in half at the waist.
    assert.deepEqual([...HIDDEN_BY_SLOT['legs']!].sort(), ['hips', 'legs']);
    assert.deepEqual(HIDDEN_BY_SLOT['torso'], ['torso']);
  });

  it('hides nothing for the two accessory slots', () => {
    // The hood sits over a head (the base bodies are bald: their head primitives are eyes and
    // eyebrows) and the pauldrons over a sleeve. Hiding for either would take a face off.
    assert.deepEqual(HIDDEN_BY_SLOT['head'], []);
    assert.deepEqual(HIDDEN_BY_SLOT['shoulders'], []);
    assert.equal(hiddenMaskFor(['head', 'shoulders']), 0);
  });

  it('composes a whole kit into one mask', () => {
    const mask = hiddenMaskFor(['torso', 'arms', 'legs', 'feet', 'head', 'shoulders']);
    for (const region of ['torso', 'arms', 'legs', 'feet', 'hips'] as const) {
      assert.ok(masks(mask, region), `${region} should be hidden by a full kit`);
    }
    assert.ok(!masks(mask, 'head'), 'a head is never hidden');
    assert.equal(mask, regionMask(['torso', 'arms', 'legs', 'feet', 'hips']));
  });

  it('ignores a slot no garment maps to', () => {
    assert.equal(hiddenMaskFor(['ioun', 'quiver']), 0);
  });
});

describe('labelling vertices and dropping triangles', () => {
  const regionsFor = (jointIndices: readonly number[]): Uint8Array => {
    const joints = new Uint16Array(jointIndices.length * 4);
    const weights = new Float32Array(jointIndices.length * 4);
    jointIndices.forEach((joint, v) => {
      joints[v * 4] = joint;
      weights[v * 4] = 1;
    });
    return vertexRegions(joints, weights, JOINTS);
  };

  it('takes the dominant joint, not the first', () => {
    // A shoulder vertex pulled 0.7 by the clavicle and 0.3 by the spine is an arm, whichever order
    // the exporter happened to write the influences in.
    const joints = new Uint16Array([2, 31, 0, 0]);
    const weights = new Float32Array([0.3, 0.7, 0, 0]);
    assert.equal(BODY_REGIONS[vertexRegions(joints, weights, JOINTS)[0]!], 'arms');
    const flipped = vertexRegions(new Uint16Array([31, 2, 0, 0]), new Float32Array([0.3, 0.7, 0, 0]), JOINTS);
    assert.equal(BODY_REGIONS[flipped[0]!], 'torso');
  });

  it('keeps a triangle that straddles a seam and drops one that does not', () => {
    //   0,1,2 all on the spine — hidden by a jerkin.
    //   3,4,5 two on the spine and one on the neck — the seam, and it stays.
    const regions = regionsFor([2, 3, 4, 2, 3, 5]);
    const index = [0, 1, 2, 3, 4, 5];
    const kept = maskedIndex(index, regions, hiddenMaskFor(['torso']));
    assert.deepEqual([...(kept as number[])], [3, 4, 5], 'the seam triangle survives, the interior one does not');
  });

  it('returns the source index untouched for a naked body', () => {
    const regions = regionsFor([2, 3, 4]);
    const index = [0, 1, 2];
    assert.equal(maskedIndex(index, regions, 0), index, 'no mask, no allocation');
  });

  it('shares every vertex attribute with the template and owns only the index', () => {
    const template = new BufferGeometry();
    const position = new BufferAttribute(new Float32Array(18), 3);
    template.setAttribute('position', position);
    template.setIndex([0, 1, 2, 3, 4, 5]);
    const regions = regionsFor([2, 2, 2, 6, 6, 6]);
    const masked = maskedGeometry(template, regions, hiddenMaskFor(['torso']));
    assert.equal(masked.getAttribute('position'), position, 'the vertex data must upload once, not twice');
    assert.notEqual(masked.getIndex(), template.getIndex());
    assert.equal(masked.getIndex()!.count, 3, 'the spine triangle went and the head triangle stayed');
  });

  it('refuses a primitive with no index rather than building one', () => {
    const template = new BufferGeometry();
    template.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
    assert.throws(() => maskedGeometry(template, new Uint8Array(3), 1), /indexed/);
  });
});

/* -------------------------------------------------------------------------- */
/* Against the real bodies                                                      */
/* -------------------------------------------------------------------------- */

describe('the cull against the imported bodies', () => {
  if (!existsSync(CHARACTERS_DIR)) {
    it('skips: the character packs have not been imported', (t) => {
      t.skip(
        `no characters at ${CHARACTERS_DIR} — run ` +
          '`node --disable-warning=ExperimentalWarning packages/worldgen/src/modelgen.ts --characters --source <packs>`',
      );
    });
    return;
  }

  /** Reads a glTF's skin attributes straight off the `.bin`, without three or a loader. */
  const readBody = (
    id: string,
  ): { jointNames: string[]; joints: Float32Array; weights: Float32Array; index: Uint16Array | Uint32Array } => {
    const gltf = JSON.parse(readFileSync(join(CHARACTERS_DIR, id, 'model.gltf'), 'utf8')) as {
      skins: { joints: number[] }[];
      nodes: { name?: string }[];
      meshes: { primitives: { attributes: Record<string, number>; indices: number; material: number }[] }[];
      materials: { name: string }[];
      accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
      bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[];
    };
    const bin = readFileSync(join(CHARACTERS_DIR, id, 'model.bin'));
    const jointNames = gltf.skins[0]!.joints.map((node) => gltf.nodes[node]!.name ?? '');
    // The skin primitive is the biggest one — eyes and eyebrows are an order of magnitude smaller.
    let best: { attributes: Record<string, number>; indices: number } | undefined;
    for (const mesh of gltf.meshes) {
      for (const primitive of mesh.primitives) {
        if (!best || gltf.accessors[primitive.indices]!.count > gltf.accessors[best.indices]!.count) best = primitive;
      }
    }
    /**
     * One accessor, honouring its own `componentType`.
     *
     * **`JOINTS_0` is `UNSIGNED_BYTE` in these files, not `UNSIGNED_SHORT`** — a 65-joint rig fits in
     * a byte and the exporter takes it. Reading it at the wrong width scrambles every influence and
     * the cull silently keeps almost everything, which is exactly how this reader was caught.
     */
    const read = (accessorIndex: number, comps: number): Float32Array => {
      const accessor = gltf.accessors[accessorIndex]!;
      const view = gltf.bufferViews[accessor.bufferView]!;
      const size = accessor.componentType === 5126 ? 4 : accessor.componentType === 5123 ? 2 : 1;
      const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const stride = view.byteStride ?? size * comps;
      const out = new Float32Array(accessor.count * comps);
      for (let i = 0; i < accessor.count; i++) {
        for (let c = 0; c < comps; c++) {
          const at = base + i * stride + c * size;
          out[i * comps + c] = size === 4 ? bin.readFloatLE(at) : size === 2 ? bin.readUInt16LE(at) : bin.readUInt8(at);
        }
      }
      return out;
    };
    const joints = read(best!.attributes['JOINTS_0']!, 4);
    const weights = read(best!.attributes['WEIGHTS_0']!, 4);
    const indexAccessor = gltf.accessors[best!.indices]!;
    const indexView = gltf.bufferViews[indexAccessor.bufferView]!;
    const at = (indexView.byteOffset ?? 0) + (indexAccessor.byteOffset ?? 0);
    const wide = indexAccessor.componentType === 5125;
    const index = wide ? new Uint32Array(indexAccessor.count) : new Uint16Array(indexAccessor.count);
    for (let i = 0; i < indexAccessor.count; i++) index[i] = wide ? bin.readUInt32LE(at + i * 4) : bin.readUInt16LE(at + i * 2);
    return { jointNames, joints, weights, index };
  };

  for (const [id, total, kept] of [
    ['superhero-male-full-body', 12566, 2922],
    ['superhero-female-full-body', 12812, 3130],
  ] as const) {
    it(`leaves ${id} a head and a seam when it is fully dressed`, () => {
      const body = readBody(id);
      // The armature the whole milestone rests on, read off the file rather than assumed.
      assert.deepEqual(body.jointNames, JOINTS, 'the base body no longer binds the 65 shared joints');
      const regions = vertexRegions(body.joints, body.weights, body.jointNames);
      assert.equal(body.index.length / 3, total, 'the base body changed triangle count');
      const mask = hiddenMaskFor(['torso', 'arms', 'legs', 'feet']);
      const survivors = maskedIndex(body.index, regions, mask).length / 3;
      assert.equal(survivors, kept, 'the fully-dressed cull moved');
      // The number that matters is not the exact count but the *shape* of the answer: about a quarter
      // of the body survives, and it is the head — which is precisely the piece the vendor's own
      // whole-outfit assemblies (`Outfits/Male_Peasant.gltf`, four parts and no base mesh) do not ship.
      assert.ok(survivors / total > 0.2 && survivors / total < 0.32, `kept ${((survivors / total) * 100).toFixed(1)}%`);
      // And a naked body keeps all of it.
      assert.equal(maskedIndex(body.index, regions, 0).length / 3, total);
    });
  }

  it('drops more for every garment added, and never fewer', () => {
    const body = readBody('superhero-male-full-body');
    const regions = vertexRegions(body.joints, body.weights, body.jointNames);
    let previous = maskedIndex(body.index, regions, 0).length;
    for (const slots of [['torso'], ['torso', 'arms'], ['torso', 'arms', 'legs'], ['torso', 'arms', 'legs', 'feet']]) {
      const next = maskedIndex(body.index, regions, hiddenMaskFor(slots)).length;
      assert.ok(next < previous, `${slots.join('+')} did not drop anything`);
      previous = next;
    }
  });
});
