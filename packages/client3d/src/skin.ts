/**
 * Which part of a body a vertex belongs to, and how to stop drawing the parts that are dressed —
 * **M7b's load-bearing measurement, and the reason a composed body is not just "add the meshes".**
 *
 * ## The finding this file exists for
 *
 * `shared/src/appearance.ts` warns that the outfit parts *"are cut to REPLACE the base mesh's region,
 * not layer over it"*. That is true, and M7b measured how true. Sampling the male base body and the
 * peasant and ranger garments at bind pose, binned into 24 angular sectors at chest and thigh height:
 *
 * ```
 *   peasant torso   6 of 24 sectors outside the body,  18 inside, worst  -58 mm
 *   peasant legs    4 of 23 outside,                   19 inside, worst  -38 mm
 *   ranger  torso   1 of 24 outside,                   23 inside, worst -147 mm
 *   ranger  legs    6 of 23 outside,                   17 inside, worst  -38 mm
 * ```
 *
 * The garments sit **inside** the naked silhouette almost everywhere. Drawing both is not z-fighting,
 * it is a naked body worn over its own clothes. And the vendor agrees: their own whole-outfit
 * assemblies (`Outfits/Male_Peasant.gltf`) contain the four parts and **no base mesh at all** — no
 * torso, no head. Their intended composition is *replace*, and the head the assembly is missing is
 * exactly what the base body is for.
 *
 * ## Why the cull has to be per vertex
 *
 * A base body is **one** skinned primitive (`MI_Superhero_Male`, 12,566 triangles) plus eyes and
 * eyebrows. There is no torso sub-mesh to hide. What there *is* is a skin weight per vertex against
 * the 65 named joints — and a joint name is a statement about which part of a body a vertex is on.
 * So {@link regionOfJoint} maps the 65 names onto seven regions, {@link vertexRegions} labels each
 * vertex by its **dominant** joint, and {@link maskedIndex} rebuilds the index buffer with the
 * dressed regions dropped.
 *
 * Measured on the real bodies, by the *dominant* joint of each vertex:
 *
 * ```
 *   male    arms 4890  head 2852  legs 1858  feet 1290  torso  972  seam 394  hips 310  = 12,566 tris
 *   female  arms 4656  head 3070  legs 1826  feet 1280  torso 1240  seam 434  hips 306  = 12,812 tris
 * ```
 *
 * A fully dressed male keeps **2,922 of 12,566** and a female 3,130 — a head, a neck, and the part of
 * the seam skirt that touches them. (Not 3,246: a triangle spanning the torso *and* the arm is
 * "seam" by that table and is still dropped by the rule below, because all three of its vertices are
 * dressed. 324 triangles fall in that gap and dropping them is right.) What survives is precisely the
 * piece the vendor's own whole-outfit assemblies do not ship, which is the argument in one number.
 *
 * ## Two rules that keep holes out of the result
 *
 * 1. **A triangle is dropped only when all three of its vertices are dressed.** The 394 male
 *    "seam" triangles straddle a boundary and are kept, so a garment that stops a millimetre short of
 *    where the weights change shows skin rather than the inside of the abdomen. It costs 3% of the
 *    body and it is the difference between a seam and a hole.
 * 2. **Hips go with the legs, never with the torso.** The peasant torso garment reaches down to
 *    y = 0.921 m and the legs garment up to y = 1.054 m, so the hip is covered by the *trousers*.
 *    Hiding it with a jerkin and no trousers would cut a character in half at the waist.
 *
 * ## Nothing here allocates per entity
 *
 * A masked index is a property of `(base body, dressed set)` and there are at most 2 x 2^4 = 32 of
 * them; `characters.ts` caches them and every rig wearing the same set shares one. The vertex data is
 * never copied — a masked geometry is a *view*, exactly as `pool.mintAttributed`'s is, with the
 * position/normal/uv/skinIndex/skinWeight attributes of the template and an index of its own.
 */

import { BufferAttribute, BufferGeometry, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';

/**
 * The seven parts of a body, in the order {@link vertexRegions} encodes them.
 *
 * `other` exists and should stay empty: it is what an unrecognised joint name answers, and a body
 * whose rig grew a `tail_01` would show up as triangles nobody can dress rather than as triangles
 * silently filed under the head.
 */
export const BODY_REGIONS = ['head', 'torso', 'hips', 'arms', 'legs', 'feet', 'other'] as const;

export type BodyRegion = (typeof BODY_REGIONS)[number];

const REGION_INDEX: Readonly<Record<BodyRegion, number>> = {
  head: 0,
  torso: 1,
  hips: 2,
  arms: 3,
  legs: 4,
  feet: 5,
  other: 6,
};

/**
 * Which region a joint owns, from its name alone — the whole of the classification.
 *
 * By name and not by index, because the name is the thing all three packs agree on: the base bodies,
 * the twenty outfit parts and both animation libraries bind the *same 65 names in the same order*
 * (verified headlessly, 2026-08-13). An index-based table would be one vendor re-export away from
 * dressing a character's arm in its own boot.
 *
 * `root` is filed with the hips because that is where its few vertices are — it is the pelvis' parent
 * and the origin of the whole rig — and because the alternative, `other`, would leave a scrap of hip
 * undressable.
 */
export function regionOfJoint(name: string): BodyRegion {
  if (name === 'Head' || name === 'neck_01') return 'head';
  if (name.startsWith('spine_')) return 'torso';
  if (name === 'pelvis' || name === 'root') return 'hips';
  if (/^(clavicle|upperarm|lowerarm|hand|index|middle|pinky|ring|thumb)_/.test(name)) return 'arms';
  if (/^(thigh|calf)_/.test(name)) return 'legs';
  if (/^(foot|ball)_/.test(name)) return 'feet';
  return 'other';
}

/**
 * One region per vertex, by **dominant** skin weight.
 *
 * Dominant rather than blended, because the question is categorical: a vertex on the shoulder is
 * weighted to the clavicle and the spine, and the honest answer for "is this covered by a sleeve or by
 * a jerkin" is whichever pulls it harder. The ties that remain land on the boundary and are caught by
 * the all-three rule in {@link maskedIndex}.
 *
 * `joints` and `weights` are the raw interleaved `JOINTS_0`/`WEIGHTS_0` attribute arrays, four per
 * vertex, exactly as glTF stores them.
 */
export function vertexRegions(
  joints: ArrayLike<number>,
  weights: ArrayLike<number>,
  jointNames: readonly string[],
): Uint8Array {
  const count = Math.floor(joints.length / 4);
  const regions = new Uint8Array(count);
  // The 65 names cost one classification each rather than one per vertex — a body is 7,281 vertices
  // and the regex above is not free.
  const byJoint = new Uint8Array(jointNames.length);
  for (let j = 0; j < jointNames.length; j++) {
    byJoint[j] = REGION_INDEX[regionOfJoint(jointNames[j] ?? '')];
  }
  for (let v = 0; v < count; v++) {
    let best = 0;
    let bestWeight = -1;
    for (let k = 0; k < 4; k++) {
      const weight = weights[v * 4 + k] ?? 0;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = joints[v * 4 + k] ?? 0;
      }
    }
    regions[v] = byJoint[best] ?? REGION_INDEX.other;
  }
  return regions;
}

/**
 * The dressed regions as a bit mask, so a `(body, gear)` pair is one integer and a cache key.
 *
 * Seven bits, of which four are ever set today — see {@link HIDDEN_BY_SLOT}.
 */
export function regionMask(regions: Iterable<BodyRegion>): number {
  let mask = 0;
  for (const region of regions) mask |= 1 << REGION_INDEX[region];
  return mask;
}

/**
 * Which regions a garment in a given {@link GearSlot} covers — and the two that cover nothing.
 *
 * `head` and `shoulders` are deliberately empty. The pack's only headwear is the ranger hood, which
 * sits **over** a head rather than replacing it (and the base bodies are bald: their head primitives
 * are eyes and eyebrows, 984 and 768 triangles, with no hair mesh at all), and the pauldrons are an
 * accessory strapped over a sleeve. Hiding anything for either would take a face off.
 *
 * `legs` claims the hips as well — see this file's header, rule 2.
 */
export const HIDDEN_BY_SLOT: Readonly<Record<string, readonly BodyRegion[]>> = {
  torso: ['torso'],
  arms: ['arms'],
  legs: ['legs', 'hips'],
  feet: ['feet'],
  head: [],
  shoulders: [],
};

/** The mask a whole gear list hides. The renderer's one call into this file per dressing. */
export function hiddenMaskFor(slots: Iterable<string>): number {
  let mask = 0;
  for (const slot of slots) {
    for (const region of HIDDEN_BY_SLOT[slot] ?? []) mask |= 1 << REGION_INDEX[region];
  }
  return mask;
}

/** Whether a mask hides a named region — for the tests and for `__debug3d`. */
export function masks(mask: number, region: BodyRegion): boolean {
  return (mask & (1 << REGION_INDEX[region])) !== 0;
}

/**
 * The surviving triangles, as a fresh index array — **all three vertices dressed, or it stays**.
 *
 * Returns the source array untouched when the mask hides nothing, so a naked body costs no allocation
 * and no second geometry at all.
 */
export function maskedIndex(index: ArrayLike<number>, regions: Uint8Array, mask: number): ArrayLike<number> {
  if (mask === 0) return index;
  const kept: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t] ?? 0;
    const b = index[t + 1] ?? 0;
    const c = index[t + 2] ?? 0;
    const hidden =
      (mask & (1 << (regions[a] ?? 6))) !== 0 &&
      (mask & (1 << (regions[b] ?? 6))) !== 0 &&
      (mask & (1 << (regions[c] ?? 6))) !== 0;
    if (hidden) continue;
    kept.push(a, b, c);
  }
  return kept;
}

/**
 * A geometry that draws the undressed part of a body — a **view**, never a copy.
 *
 * Every vertex attribute is the template's own object, so the position, normal, uv, skin index and
 * skin weight buffers upload once however many masks are alive; only the index is new, and at 16 bits
 * a whole male body's is 75 KB. `characters.ts` caches these by `(stem, mask)` so the 32 possible
 * masks are an upper bound on how many can ever exist, and the realistic number is three or four.
 *
 * Throws on a geometry with no index rather than building one: every character primitive in all three
 * packs is indexed, and silently un-indexing would quadruple the vertex count of a body.
 */
export function maskedGeometry(template: BufferGeometry, regions: Uint8Array, mask: number): BufferGeometry {
  const index = template.getIndex();
  if (!index) throw new Error('a character primitive must be indexed');
  const kept = maskedIndex(index.array as ArrayLike<number>, regions, mask);
  const geometry = new BufferGeometry();
  for (const [name, attribute] of Object.entries(template.attributes)) {
    geometry.setAttribute(name, attribute as BufferAttribute);
  }
  // The kept list is a subset of the source's own indices, so the vertex count — and therefore the
  // width the index needs — is the template's, not the subset's.
  const wide = (template.getAttribute('position')?.count ?? 0) > 65535;
  geometry.setIndex(
    wide ? new Uint32BufferAttribute(Array.from(kept as number[]), 1) : new Uint16BufferAttribute(Array.from(kept as number[]), 1),
  );
  geometry.name = `${template.name}|mask${mask}`;
  return geometry;
}
