/**
 * The domain warp — M5c, and the answer to *"a winding road should actually wind"*.
 *
 * > *"The answer is a **deterministic domain warp**: a smooth seeded low-frequency displacement field
 * > over world position, applied to everything visual — ground, room centres, walls, scatter, and
 * > entities as rendered — so a chain of east-east-east road rooms draws as a road that drifts and
 * > bends. **Collision honesty survives by construction** because walls render through the same lens
 * > as floors: what you see is still exactly where you can walk."*
 *
 * One field, one function, and every visible thing in the renderer reads it. The simulation grid, the
 * server and the wire protocol never hear of it: this is a **lens**, not a move. A room's collision
 * tiles, its `seen` bitset, its path and its `moveTo` are all in the unwarped grid the MUD has always
 * had, and the only place the two spaces meet is the pointer, which inverts the lens before it speaks
 * (see {@link WarpField.invertInto}).
 *
 * ## Why a sum of plane waves and not `noise.ts`'s hashed lattice
 *
 * `noise.ts` is value noise over a `hashCell` lattice, and `hashCell` is `Math.imul` — which
 * `blend.ts` has already recorded has no portable GLSL1 equivalent. That is fine for a *colour* and
 * fatal for a *position*: the ground displaces in the vertex shader and a wall displaces on the CPU,
 * and if the two arithmetics disagree the wall leaves the ground. So the field is built from
 * something both sides can evaluate identically — three plane waves per axis, each a `sin` of a dot
 * product — and the **seed enters through the wave table rather than through the evaluation**
 * ({@link warpTable}). One table, two emissions: {@link warpInto} reads it in TypeScript and
 * {@link WARP_GLSL} is generated from the same numbers, so there is no second copy to drift.
 *
 * That keeps `CLAUDE.md`'s rule 3 in the only form it can take here. Nothing frame-dependent and
 * nothing client-dependent enters: the field is a pure function of world position and a world
 * constant, so two clients that never speak bend the same road the same way, and nothing reads it
 * back into the simulation.
 *
 * ## The three properties the design is bound to, and where each lives
 *
 * 1. **Bounded gradient, so the warp never folds.** A displacement map `p -> p + w(p)` is injective
 *    when `w` is a contraction, and it is the *derivative* that has to be small, not the
 *    displacement: three metres of drift is a bending road, a Jacobian over one is ground turned
 *    inside out. {@link warpJacobianNorm} is the number and `warp.test.ts` sweeps the built world
 *    asserting it stays under {@link WARP_GRADIENT_BOUND}.
 * 2. **Zero inside and in the city, full in the landscape.** {@link SECTOR_WARP}, plus the roof rule:
 *    a roofed room presents no warp at all, exactly as `blend.ts`'s ground tint presents no second
 *    layer — the absence of a term rather than a branch.
 * 3. **Ramped at boundaries.** {@link WarpField} carries the sector amplitude as a *field*, bilinear
 *    over the room lattice, and every drawn thing samples it at its own position. See that class's
 *    header for why the node rule is a `min` and why symmetry is the whole of it.
 */

import { Uniform } from 'three';

import { hashCell, type Room, type Sector, type Zone } from '@mygame/shared';

import type { Placement } from './chunkPlan.ts';
import type { ShaderPatch } from './foliage.ts';
import type { PlaceFrame } from './frame.ts';
import type { Archetype } from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The field                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The world constant the wave table is derived from.
 *
 * World-constant for `noise.ts`'s reason, quoted there: *"neighbouring chunks then agree at their
 * seams without communicating; a per-zone or per-component seed would reintroduce exactly the
 * mismatch that buys."* A per-zone warp seed would put a discontinuity on every Place boundary, which
 * is the one place a seam is supposed to read as an ordinary step.
 */
export const WARP_SEED = 0x5c1f_a37b;

/** `hashCell` returns an unsigned 32-bit integer; this is the divisor that maps it onto `[0, 1)`. */
const HASH_RANGE = 0x1_0000_0000;

/**
 * Metres per cycle of each octave. **Long, and deliberately not harmonic.**
 *
 * A room is 9 m and the cell pitch is 11 m, so anything under ~30 m would read as a room-scale
 * wobble — the very *"repeating on a hard 12 m beat"* the plan complains about, wearing a curve. The
 * longest wave is fifteen room blocks across, which is the scale at which a road *drifts*; the
 * shortest is four, which is the scale at which it *bends*. The ratios are irrational-ish for
 * `foliage.ts`'s reason — three waves at 160/80/40 would beat together and the eye would find the
 * period in about four seconds.
 *
 * **Long wavelengths are the cheap way to buy wander**, and that is what settled these three. The
 * gradient cost of an octave is `amplitude x 2pi / wavelength` and the gradient is the scarce thing
 * ({@link WARP_GRADIENT_BOUND}), so lengthening a wave buys displacement at no cost to the bound. The
 * table was measured against three numbers rather than chosen: the world-wide peak Jacobian, the mean
 * displacement, and — the one that answers the owner's sentence — how far two neighbouring room
 * blocks move *relative to each other*, which is what breaks the lattice read. See the M5c report.
 */
export const WARP_WAVELENGTHS: readonly number[] = [163, 89, 47];

/**
 * Metres of displacement each octave contributes at its peak.
 *
 * They sum to 3.6 m per axis — the design's *"~2.5-3.5 m"* — which is a third of a room block:
 * enough that a straight run of road visibly leaves the lattice, small enough that no room ever
 * displaces past its own neighbour. The fall-off is roughly 1/2 per octave rather than the 1/f a
 * fractal would use, because what is wanted here is a *drift* with texture on it rather than a rough
 * field.
 */
export const WARP_AMPLITUDES: readonly number[] = [2.2, 1.0, 0.4];

/**
 * The bound the field is held under, and the reason the number is what it is.
 *
 * `p -> p + w(p)` is injective when the Lipschitz constant of `w` is below 1, and the fixed-point
 * inversion the pointer runs converges at exactly that rate. 0.35 is the design's own figure and it
 * buys both: no fold, and an inversion that loses a factor of three per step. Asserted against a
 * dense sweep of the built world rather than against the analytic worst case, which is the sum of
 * every octave's gradient in both axes at once and is not a configuration the field ever reaches.
 */
export const WARP_GRADIENT_BOUND = 0.35;

/** One plane wave: an amplitude in metres, a wave vector in radians per metre, and a phase. */
export interface WarpOctave {
  readonly amplitude: number;
  readonly kx: number;
  readonly kz: number;
  readonly phase: number;
}

/** The octaves summed for each axis of the displacement. `x` is east, `z` is south — `space.ts`'s. */
export interface WarpTable {
  readonly x: readonly WarpOctave[];
  readonly z: readonly WarpOctave[];
}

/** Renderer metres. The same two fields {@link warpInto} and {@link WarpField} write into. */
export interface WarpVec {
  x: number;
  z: number;
}

/**
 * The wave table for a seed — **the only place the seed is read**.
 *
 * Direction and phase come from `hashCell`, which is the project's determinism contract and is exact
 * integer arithmetic on every machine; the wavelengths and amplitudes are the constants above. Two
 * independent sets, one per output axis, so the displacement is not a scaled copy of itself along the
 * diagonal — a single scalar field driving both components would shear the world along one line
 * instead of swirling it.
 */
export function warpTable(seed: number): WarpTable {
  const axis = (which: number): WarpOctave[] =>
    WARP_WAVELENGTHS.map((wavelength, i) => {
      const k = (Math.PI * 2) / wavelength;
      const angle = (hashCell(i, which, 0, seed) / HASH_RANGE) * Math.PI * 2;
      const phase = (hashCell(i, which, 1, seed) / HASH_RANGE) * Math.PI * 2;
      return {
        amplitude: WARP_AMPLITUDES[i] ?? 0,
        kx: Math.cos(angle) * k,
        kz: Math.sin(angle) * k,
        phase,
      };
    });
  return { x: axis(0), z: axis(1) };
}

/** The table every material and every placement in the running renderer shares. */
export const WARP_TABLE: WarpTable = warpTable(WARP_SEED);

/** Tables already built, by seed. A table is four trig calls an octave and is asked for constantly. */
const TABLES = new Map<number, WarpTable>([[WARP_SEED, WARP_TABLE]]);

/** The table for a seed, built once. */
export function tableFor(seed: number): WarpTable {
  const held = TABLES.get(seed);
  if (held) return held;
  const built = warpTable(seed);
  TABLES.set(seed, built);
  return built;
}

/**
 * The displacement at a world position, in metres, **before any sector scaling**.
 *
 * Writes into a caller-owned vector rather than returning one: this runs for every tree, every prop
 * and every body in the window on the frames a chunk builds, and `pool.ts`'s no-allocation discipline
 * applies to the field that moves them as much as to the buffers they are written into.
 */
export function warpInto(out: WarpVec, x: number, z: number, table: WarpTable): void {
  let dx = 0;
  for (const octave of table.x) dx += octave.amplitude * Math.sin(x * octave.kx + z * octave.kz + octave.phase);
  let dz = 0;
  for (const octave of table.z) dz += octave.amplitude * Math.sin(x * octave.kx + z * octave.kz + octave.phase);
  out.x = dx;
  out.z = dz;
}

/**
 * The readable form of {@link warpInto} — the design's `warpOf(x, z, seed)`.
 *
 * Allocates, and is therefore for tests, sweeps and the one-off caller. Everything on a hot path
 * takes a table and a scratch vector.
 */
export function warpOf(x: number, z: number, seed: number = WARP_SEED): WarpVec {
  const out: WarpVec = { x: 0, z: 0 };
  warpInto(out, x, z, tableFor(seed));
  return out;
}

/**
 * The largest singular value of the field's Jacobian at a point — *the* number the fold bound is on.
 *
 * Analytic, because the field is a sum of sines and its derivative is a sum of cosines: a finite
 * difference would confuse the bound with its own step size. The 2x2 spectral norm has a closed form
 * — `sqrt((s + sqrt(s^2 - 4 det^2)) / 2)` where `s` is the sum of the squared entries — and using the
 * spectral norm rather than the largest entry matters: a matrix whose entries are all 0.3 has a norm
 * of 0.6, and it is the norm that decides whether the map folds.
 */
export function warpJacobianNorm(x: number, z: number, table: WarpTable): number {
  let a = 0;
  let b = 0;
  for (const o of table.x) {
    const c = o.amplitude * Math.cos(x * o.kx + z * o.kz + o.phase);
    a += c * o.kx;
    b += c * o.kz;
  }
  let c2 = 0;
  let d = 0;
  for (const o of table.z) {
    const c = o.amplitude * Math.cos(x * o.kx + z * o.kz + o.phase);
    c2 += c * o.kx;
    d += c * o.kz;
  }
  const s = a * a + b * b + c2 * c2 + d * d;
  const det = a * d - b * c2;
  const inner = Math.max(0, s * s - 4 * det * det);
  return Math.sqrt(Math.max(0, (s + Math.sqrt(inner)) / 2));
}

/* -------------------------------------------------------------------------- */
/* The GLSL twin                                                               */
/* -------------------------------------------------------------------------- */

/** Enough digits that a `float` cannot tell the GLSL from the TypeScript. */
function literal(value: number): string {
  return value.toFixed(9);
}

/**
 * {@link warpInto}, emitted as GLSL from the **same table**.
 *
 * This is `foliage.ts`'s trap 1 in its third costume, and the same answer: there is one string, it is
 * generated rather than typed, and every shader that warps is handed this exact constant. A hand-kept
 * copy of six sine terms would be wrong within a milestone, and the failure — a wall a hand's breadth
 * off the ground it stands on — is the kind that is noticed as *"the art is sloppy"* rather than as a
 * bug.
 *
 * `warpAmp` is the sector amplitude, already interpolated by the caller; `uWarp` is the shared
 * on/off. Both arrive as arguments so this function is pure GLSL with no uniform of its own — the
 * declarations live in {@link WARP_VERTEX_DECL} beside the attribute, where a reader looking for
 * "what does this shader need bound" finds them all in one place.
 */
export function warpGlsl(table: WarpTable): string {
  const sum = (octaves: readonly WarpOctave[]): string =>
    octaves
      .map(
        (o) =>
          `${literal(o.amplitude)} * sin(p.x * ${literal(o.kx)} + p.y * ${literal(o.kz)} + ${literal(o.phase)})`,
      )
      .join('\n    + ');
  return /* glsl */ `
vec2 warpField(vec2 p) {
  return vec2(
    ${sum(table.x)},
    ${sum(table.z)}
  );
}
`;
}

/** The one warp GLSL constant. See {@link warpGlsl}. */
export const WARP_GLSL: string = warpGlsl(WARP_TABLE);

/**
 * The shared switch, **one object handed to every warped material by reference**.
 *
 * `foliage.ts`'s `WindClock` pattern exactly, and for the same reason it gives: a second copy is a
 * second state of the world in one frame, and the two would be visible as a lake displaced by a
 * different amount from the shore it laps. One uniform, so the **V** key compiles nothing.
 *
 * The CPU half of the switch is {@link WarpField.strength}, and `World3D.warpEnabled` writes both —
 * a toggle that moved the ground and left the trees behind would be worse than no toggle.
 */
export interface WarpControls {
  readonly uWarp: Uniform<number>;
}

export function createWarpControls(): WarpControls {
  return { uWarp: new Uniform(1) };
}

/**
 * What a warped vertex shader needs bound: the switch, the per-instance amplitude, and the field.
 *
 * `iWarp` is the four corner amplitudes, in `blend.ts`'s `(u,v)` winding, written by
 * `pool.writeWarp`. It rides on the same wrappers `iBlend` and `iTint` do — the ground's and the
 * water surface's — which is not a coincidence: those are exactly the two families that warp in the
 * shader, because they are the only two that are *continuous surfaces* rather than objects. See
 * `world3d.ts` for the other half of that split.
 */
export const WARP_VERTEX_DECL = /* glsl */ `
uniform float uWarp;
attribute vec4 iWarp;
${WARP_GLSL}`;

/**
 * The displacement, per vertex, in world space.
 *
 * Three decisions in nine lines:
 *
 * 1. **`transformed` is displaced, not `mvPosition`.** Everything downstream — `<project_vertex>`,
 *    `<worldpos_vertex>` and therefore the shadow-map lookup and the fog — reads `transformed`, so
 *    displacing it once is the only way all four agree. The cost is that the world-space delta has to
 *    be divided back through the instance's own scale, which is the `length(warpModel[n].xyz)` pair:
 *    exact for a scale-and-translate matrix, and every ground slab, mouth strip and water surface in
 *    the renderer is one (`planChunk` and `planWater` write `rx = ry = rz = 0`, asserted in
 *    `warp.test.ts` over the whole built world).
 * 2. **The amplitude is bilinear over the box's own face**, `position.xz + 0.5` being the unit box's
 *    and the unit plane's `(u, v)` — the same expression `blend.ts` and `water.ts` already use. Since
 *    the amplitude field is *itself* bilinear over the room lattice and a box never straddles a
 *    lattice cell, this reproduces the field exactly rather than approximating it. See
 *    {@link WarpField}.
 * 3. **It runs before the blend's and the water's own blocks**, so `vBlendWorld` and `vWorldXZ` are
 *    warped positions and the boundary breakup and the wave field travel through the same lens as the
 *    ground they are painted on. Because each patch inserts itself immediately after
 *    `#include <begin_vertex>`, that means {@link patchWarpVertex} must be applied **last** —
 *    `pool.ts` does, and `warp.test.ts` pins the resulting order.
 */
export const WARP_VERTEX_GLSL = /* glsl */ `
  #ifdef USE_INSTANCING
  {
    vec2 warpUv = position.xz + 0.5;
    float warpAmp = mix(mix(iWarp.x, iWarp.y, warpUv.x), mix(iWarp.w, iWarp.z, warpUv.x), warpUv.y);
    mat4 warpModel = modelMatrix * instanceMatrix;
    vec2 warpDelta = warpField((warpModel * vec4(transformed, 1.0)).xz) * (warpAmp * uWarp);
    transformed.x += warpDelta.x / max(length(warpModel[0].xyz), 1e-4);
    transformed.z += warpDelta.y / max(length(warpModel[2].xyz), 1e-4);
  }
  #endif
`;

/**
 * Apply the warp to one shader. Exported so `warp.test.ts` can run it without a renderer.
 *
 * **Call this after every other vertex patch on the same material** — see
 * {@link WARP_VERTEX_GLSL} point 3.
 */
export function patchWarpVertex(shader: ShaderPatch, controls: WarpControls): void {
  shader.uniforms['uWarp'] = controls.uWarp as unknown as { value: unknown };
  shader.vertexShader = shader.vertexShader.replace(
    '#include <common>',
    `#include <common>\n${WARP_VERTEX_DECL}`,
  );
  shader.vertexShader = shader.vertexShader.replace(
    '#include <begin_vertex>',
    `#include <begin_vertex>\n${WARP_VERTEX_GLSL}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Sector amplitude                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How much of the field a sector shows, before the roof rule and before the boundary ramp.
 *
 * > *"Amplitude scales by sector (zero for inside/city so buildings stay square; full for
 * > road/field/forest/swamp/hills/desert)"*
 *
 * The six full ones are exactly {@link OUTDOOR_SECTORS}, which is not a coincidence and is not a
 * dependency either: that set answers *"does walkable ground merge across this boundary"* and this
 * table answers *"is this ground a landscape or a floor"*, and they agree on the six because a
 * landscape is what merges. Written out rather than derived, so the two can be given different
 * answers the day one of them needs one.
 *
 * The nine the design does not name:
 *
 * - **`mountain`, `arctic`** are landscape and take the full amplitude. They are excluded from
 *   `OUTDOOR_SECTORS` because their *boundaries* are cliffs and drifts rather than open ground, which
 *   is a statement about the mouth between two rooms and nothing to do with whether the ground bends.
 * - **The three water sectors** take it too, and this is the row worth stating out loud: a river that
 *   runs down a ruler is the same complaint as a road that does, and the water surface warps through
 *   the same lens as the ground under it, so a shore stays a shore.
 * - **`cave` is zero**, and would be zero anyway — it is roofed, and a roofed room presents no warp.
 *   Named here so a reader does not have to find the roof rule to know what a cave does.
 * - **`air` and `astral` are zero.** There is no ground to bend and nothing standing on it.
 */
export const SECTOR_WARP: Readonly<Record<Sector, number>> = {
  inside: 0,
  city: 0,
  road: 1,
  field: 1,
  forest: 1,
  hills: 1,
  mountain: 1,
  swamp: 1,
  desert: 1,
  arctic: 1,
  cave: 0,
  shallow_water: 1,
  deep_water: 1,
  underwater: 1,
  air: 0,
  astral: 0,
};

/**
 * A room's own amplitude: its sector's, and **zero if it has a roof**.
 *
 * The roof predicate is `roomScene.ts`'s `isRoofed`, restated because that function is private to
 * `shared` and this package may not widen its exports for a rendering concern. `warp.test.ts` pins
 * the restatement against `describeRoom`'s own `enclosure.roofed` over the whole built world, so the
 * copy cannot drift without a test going red — which is the only honest way to hold a duplicated
 * predicate.
 */
export function roomWarpAmplitude(room: Room): number {
  if (room.flags?.includes('indoors') === true) return 0;
  return SECTOR_WARP[room.sector] ?? 1;
}

/* -------------------------------------------------------------------------- */
/* The amplitude lattice                                                       */
/* -------------------------------------------------------------------------- */

/** How many times {@link WarpField.invertInto} iterates. See its docblock for where 12 comes from. */
export const WARP_INVERSE_STEPS = 12;

/**
 * The warp as the renderer sees it: the field, times a sector amplitude that is itself a field.
 *
 * ## Why the amplitude has to be continuous, and what that forces
 *
 * A displacement that jumps across a boundary is a **tear** — two pieces of ground that used to meet
 * drawn a metre apart, with the void showing between them. So the amplitude cannot be *"this room's
 * sector"* evaluated per room: a road beside a city would warp to its own edge and the city would
 * not, and the gate between them would come apart. It cannot be a per-room ramp either, however
 * carefully weighted, unless the two sides of every boundary compute the **same number** for the
 * shared edge — and any rule of the form *"mix my amplitude toward my neighbour's by the IR's edge
 * weight"* is asymmetric by construction: the road reads `mix(1, 0, t)` and the city reads
 * `mix(0, 1, t)`, and they agree only at `t = 0.5`.
 *
 * So the amplitude is a **field over world position, defined once**, and everything samples it:
 *
 * - a **node** is a corner of the room lattice, and its value is the `min` of the amplitudes of the
 *   (up to four) room cells that touch it. `min` is symmetric — all four rooms compute the same
 *   number from the same four cells — and it is *zero-preserving*, which is the property the design
 *   actually asks for: a city cell drags every node it touches to zero, so **the buildings stay
 *   square** and the ramp happens in the landscape outside them, which is where a ramp belongs.
 * - a node sits **in the middle of the gap**, not on the block's own corner, and that half-metre
 *   matters: `planChunk` draws each room's block *plus half the gap on every side*, so a lattice
 *   pinned to the block corners would leave a room's own west and north mouth strips sticking out
 *   into the next cell, picking up a ramp toward a neighbour they belong to. Offset by `gap / 2`, a
 *   cell's territory is exactly the footprint one room draws, and two rooms' strips meet **on** a
 *   node, where they cannot disagree at all.
 * - between nodes the value is **bilinear**, which is what makes the ramp smooth and what makes it
 *   exact: a room block, a mouth strip and a puddle all lie inside one lattice cell, so a box that
 *   hands its shader four corner samples reproduces the field over its whole face rather than
 *   approximating it. The CPU and the GPU therefore agree exactly on the amplitude, and the only
 *   difference left between a shader-warped surface and a CPU-warped prop standing on it is the
 *   chord error of the *displacement* over the box, which is centimetres.
 *
 * The IR's blend weights are what named the neighbours in the first place — `describeRoom` builds the
 * cell index this lattice is folded from — but the weight itself does not enter the value, and that
 * is the one place this deviates from the design's letter. A weight in the value makes the two sides
 * of a boundary disagree, and a disagreement in a colour is a slightly different green while a
 * disagreement in a position is a hole in the world.
 *
 * ## Levels
 *
 * One lattice geometry — the camera level's {@link PlaceFrame} — and one node array **per level**,
 * built on first use. A room on the level below bends with its own level's sectors, which is right:
 * the cellar under a square town square is itself roofed and flat, and reading the amplitude off the
 * level above would bend it to match a street it has never seen.
 */
export class WarpField {
  readonly table: WarpTable;
  /** 0 or 1. The **V** key and `__debug3d.warpEnabled`; mirrored into `pool.warp.uWarp`. */
  strength = 1;

  private readonly stride: number;
  /** Metres the lattice is shifted west and north of the block corners: half a gap. See the header. */
  private readonly offset: number;
  private readonly nodesX: number;
  private readonly nodesY: number;
  private readonly minX: number;
  private readonly minY: number;
  private readonly rooms: readonly Room[];
  private readonly levels = new Map<number, Float32Array>();
  /** Reused by {@link invertInto}, which is the one method that evaluates the field in a loop. */
  private readonly scratch: WarpVec = { x: 0, z: 0 };

  /** Fields are declared and assigned rather than written as parameter properties — `CLAUDE.md` 8. */
  constructor(rooms: readonly Room[], frame: PlaceFrame, table: WarpTable = WARP_TABLE) {
    this.rooms = rooms;
    this.table = table;
    this.stride = frame.stride;
    this.offset = frame.gap / 2;
    this.minX = frame.minX;
    this.minY = frame.minY;
    // One node per cell corner. `widthTiles` is `cells x stride`, and a tile is a metre.
    this.nodesX = Math.max(2, Math.round(frame.widthTiles / frame.stride) + 1);
    this.nodesY = Math.max(2, Math.round(frame.heightTiles / frame.stride) + 1);
  }

  /** Nodes across, for `__debug3d` and for the tests that size the sweep. */
  get lattice(): { readonly nodesX: number; readonly nodesY: number; readonly stride: number } {
    return { nodesX: this.nodesX, nodesY: this.nodesY, stride: this.stride };
  }

  /**
   * The node array for a level, folded from the rooms on it. Built once per level, never rebuilt.
   *
   * Every node starts at 1 — *"no room says otherwise"* — and each room takes the `min` at its four
   * corners. A node no room touches is never sampled by anything drawn, because a drawn box always
   * lies inside a cell some room occupies; it keeps its 1 so that a stray read at the rim of the
   * lattice is the landscape's answer rather than a black hole in the middle of a field.
   */
  private nodesFor(level: number): Float32Array {
    const held = this.levels.get(level);
    if (held) return held;
    const nodes = new Float32Array(this.nodesX * this.nodesY).fill(1);
    for (const room of this.rooms) {
      if (room.pos.z !== level) continue;
      const i = room.pos.x - this.minX;
      const j = room.pos.y - this.minY;
      const amplitude = roomWarpAmplitude(room);
      if (amplitude >= 1) continue;
      for (const dj of [0, 1]) {
        for (const di of [0, 1]) {
          const nx = i + di;
          const ny = j + dj;
          if (nx < 0 || ny < 0 || nx >= this.nodesX || ny >= this.nodesY) continue;
          const at = ny * this.nodesX + nx;
          if (amplitude < nodes[at]!) nodes[at] = amplitude;
        }
      }
    }
    this.levels.set(level, nodes);
    return nodes;
  }

  /** The sector amplitude at a world position, 0..1. Bilinear over the lattice; see the header. */
  ampAt(x: number, z: number, level: number): number {
    const nodes = this.nodesFor(level);
    const u = (x + this.offset) / this.stride;
    const v = (z + this.offset) / this.stride;
    let i = Math.floor(u);
    let j = Math.floor(v);
    // Clamped rather than wrapped or refused: a mouth strip on the last cell of a Place reaches half
    // a gap past the final node, and a room on a level the frame was not sized for can sit outside
    // the lattice entirely. The edge value is the honest answer to both.
    const fu = i < 0 ? 0 : i > this.nodesX - 2 ? 1 : u - i;
    const fv = j < 0 ? 0 : j > this.nodesY - 2 ? 1 : v - j;
    i = Math.min(Math.max(i, 0), this.nodesX - 2);
    j = Math.min(Math.max(j, 0), this.nodesY - 2);
    const row = j * this.nodesX + i;
    const a = nodes[row]!;
    const b = nodes[row + 1]!;
    const c = nodes[row + this.nodesX]!;
    const d = nodes[row + this.nodesX + 1]!;
    const top = a + (b - a) * fu;
    const bottom = c + (d - c) * fu;
    return top + (bottom - top) * fv;
  }

  /** The displacement the renderer actually applies: the field, scaled by the sector amplitude. */
  displaceInto(out: WarpVec, x: number, z: number, level: number): void {
    const amplitude = this.ampAt(x, z, level) * this.strength;
    if (amplitude === 0) {
      out.x = 0;
      out.z = 0;
      return;
    }
    warpInto(out, x, z, this.table);
    out.x *= amplitude;
    out.z *= amplitude;
  }

  /**
   * The lens, run backwards: the unwarped position that draws at `(x, z)`. **The pointer's own step.**
   *
   * A click resolves to a point on the warped ground, and everything downstream of it — the tile
   * index, the `seen` gate, the `moveTo` — speaks the unwarped simulation grid. Without this a click
   * lands wherever the field happened to push that ground, which at three metres is a third of a room
   * away from where the player aimed.
   *
   * Banach's own iteration: `q <- p - w(q)`, whose error falls by the field's Lipschitz constant every
   * step. {@link WARP_GRADIENT_BOUND} is 0.35 for the field alone (measured: 0.237), but the
   * *composed* map includes the amplitude ramp — which crosses from 0 to 1 over one 11 m cell and so
   * contributes up to `|w| / stride` of its own — so the honest rate beside a city wall is nearer 0.7
   * than 0.24, and it is exactly there that a click most wants to land on the right tile.
   * {@link WARP_INVERSE_STEPS} is therefore 12 rather than the design's 2-3, which closes the world's
   * worst case to under a millimetre for 72 sine evaluations **once a frame at most**. `warp.test.ts`
   * sweeps the world and reports where the worst residual is.
   */
  invertInto(out: WarpVec, x: number, z: number, level: number): void {
    let qx = x;
    let qz = z;
    for (let i = 0; i < WARP_INVERSE_STEPS; i++) {
      this.displaceInto(this.scratch, qx, qz, level);
      qx = x - this.scratch.x;
      qz = z - this.scratch.z;
    }
    out.x = qx;
    out.z = qz;
  }

  /**
   * The four corner amplitudes of an axis-aligned box, in `blend.ts`'s `(u,v)` winding
   * `(0,0) (1,0) (1,1) (0,1)` — north-west, north-east, south-east, south-west.
   *
   * What a shader-warped surface is handed. Written into a caller-owned array of four for the reason
   * every other hot-path signature in this file is written that way.
   */
  cornersInto(out: number[], x: number, z: number, sx: number, sz: number, level: number): void {
    const west = x - sx / 2;
    const east = x + sx / 2;
    const north = z - sz / 2;
    const south = z + sz / 2;
    out[0] = this.ampAt(west, north, level);
    out[1] = this.ampAt(east, north, level);
    out[2] = this.ampAt(east, south, level);
    out[3] = this.ampAt(west, south, level);
  }
}

/** A field over a Place, from the zone the `zone` message carried and the frame it was drawn in. */
export function warpFieldOf(zone: Zone, frame: PlaceFrame, table: WarpTable = WARP_TABLE): WarpField {
  return new WarpField(zone.rooms, frame, table);
}

/* -------------------------------------------------------------------------- */
/* Rigid placements                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The archetypes that warp **in the vertex shader**, and therefore not here.
 *
 * Two, and the line between them and everything else is *continuous surface* against *object*. A
 * ground slab and its neighbour share an edge and must not open a crack along it, so they displace
 * per vertex from a world position both of them evaluate the same way. A tree, a wall, a body and a
 * ring are objects: warping *their* vertices would stretch them by the local gradient — a 28% squash
 * across a character at the worst point of the field — so they move whole, by the field sampled at
 * the one point that is theirs.
 *
 * There is a second consequence and it is the reason no shadow can come adrift. Nothing in this set
 * casts (`prototypes.ARCHETYPE_CASTS`: ground, water and puddle are all `false`), and everything that
 * *does* cast is displaced by its **instance matrix** — which three's own depth material reads. So
 * there is exactly one copy of every object's displacement, in the matrix, and the shadow pass cannot
 * disagree with the colour pass about where a thing is. `warp.test.ts` pins both halves: that the two
 * sets are disjoint, and that a future archetype joining both fails the test.
 */
export const WARP_IN_SHADER: ReadonlySet<Archetype> = new Set<Archetype>(['ground', 'water']);

/** Metres of chord a long box is cut into. See {@link warpPlacementInto}. */
export const WARP_CHORD_SPAN = 3;

/** Below this length, a box is displaced whole rather than bent. Metres. */
export const WARP_CHORD_MIN = 1.5;

/** How much longer than it is wide a box must be before bending it means anything. */
export const WARP_CHORD_ASPECT = 2;

/**
 * One placement, through the lens — the CPU half of the warp.
 *
 * **A compact object moves whole.** A tree, a prop, a puddle, a ring, a landmark: the field is
 * sampled at its anchor and its translation moves, its rotation and scale untouched. That is what
 * keeps a body a body.
 *
 * **A long box is bent, as a chord.** A wall is not an object, it is a *line* — the boundary of a
 * room block, running beside the ground's own edge for ten metres — and a wall displaced by the field
 * at its midpoint would part company with the ground at both ends and with the wall around the corner
 * at one of them. So its axis is cut into {@link WARP_CHORD_SPAN} pieces, each piece's two ends are
 * warped, and each is redrawn as a box between them: rotated by the yaw the two warped ends imply and
 * scaled to the distance between them, so consecutive pieces meet exactly and the whole run follows
 * the ground it stands on to within the chord error of three metres — **1.6 cm**, measured, against
 * the 17.6 cm a single ten-metre chord would leave.
 *
 * The three gates on bending are all necessary. **No existing rotation**: a ramp already carries an
 * `rx`, and a yaw composed onto it under three's `XYZ` order is not the rotation anybody meant.
 * **Elongated**: a cone landmark and a square prop have no long axis, and picking one would spin them
 * by an arbitrary yaw. **Long enough**: under a metre and a half the chord error is under a
 * millimetre and cutting it up would only cost instances.
 */
export function warpPlacementInto(
  out: Placement[],
  placement: Placement,
  field: WarpField,
  level: number,
  scratch: WarpVec,
): void {
  const { x, z, sx, sz, rx, ry, rz } = placement;
  const length = Math.max(sx, sz);
  const width = Math.min(sx, sz);
  const bend =
    rx === 0 &&
    ry === 0 &&
    rz === 0 &&
    length >= WARP_CHORD_MIN &&
    length >= width * WARP_CHORD_ASPECT;

  if (!bend) {
    field.displaceInto(scratch, x, z, level);
    out.push(scratch.x === 0 && scratch.z === 0 ? placement : { ...placement, x: x + scratch.x, z: z + scratch.z });
    return;
  }

  const alongX = sx >= sz;
  const pieces = Math.max(1, Math.ceil(length / WARP_CHORD_SPAN));
  const step = length / pieces;
  const start = (alongX ? x : z) - length / 2;
  // The near end of the first piece, warped once and then carried: every internal joint is evaluated
  // exactly once, so two consecutive pieces cannot land on two different answers for the point they
  // share.
  let ax = alongX ? start : x;
  let az = alongX ? z : start;
  field.displaceInto(scratch, ax, az, level);
  let wax = ax + scratch.x;
  let waz = az + scratch.z;

  for (let i = 0; i < pieces; i++) {
    const bx = alongX ? start + step * (i + 1) : x;
    const bz = alongX ? z : start + step * (i + 1);
    field.displaceInto(scratch, bx, bz, level);
    const wbx = bx + scratch.x;
    const wbz = bz + scratch.z;
    const dx = wbx - wax;
    const dz = wbz - waz;
    const span = Math.hypot(dx, dz) || step;
    out.push({
      ...placement,
      x: (wax + wbx) / 2,
      z: (waz + wbz) / 2,
      sx: alongX ? span : width,
      sz: alongX ? width : span,
      // Three's `RotY` sends local +x to `(cos, 0, -sin)` and local +z to `(sin, 0, cos)`, so the two
      // axes want two different atan2s. Getting this wrong lays every wall across its own doorway.
      ry: alongX ? Math.atan2(-dz, dx) : Math.atan2(dx, dz),
    });
    ax = bx;
    az = bz;
    wax = wbx;
    waz = wbz;
  }
}
