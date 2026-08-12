/**
 * The pool, and the ledger it keeps on itself. The plan's risk 3, answered in one file.
 *
 * *"Memory is the thing that will actually kill this if you get it wrong… With continuous traversal
 * of a 46,500-room world, unpooled geometry and materials will leak until the tab dies after 20–40
 * minutes. The pooled-per-archetype rule is architecture, not optimisation."* So there are exactly
 * three allocating operations in the whole renderer and all three are here:
 *
 * 1. **Geometries.** Four unit shapes, built in the constructor. Never again.
 * 2. **Materials.** {@link prototypes.MATERIAL_KEYS}, built in the constructor. Never again.
 * 3. **Wrappers.** One `InstancedMesh` per `(chunk, prototype)`, taken from a free list and given
 *    back on unload. New ones are minted only while the free list is empty, which happens for the
 *    first few seconds of a session and then stops for ever.
 *
 * Nothing else allocates. A chunk that loads writes matrices into a buffer that already exists; a
 * chunk that unloads returns its wrappers and disposes nothing at all. That inverts the usual
 * Three.js streaming failure mode — instead of thousands of `dispose()` calls to get right, there is
 * a small fixed pool created once and a `dispose()` that runs at teardown.
 *
 * ## Why the wrapper capacity is fixed
 *
 * An `InstancedMesh`'s matrix buffer is sized at construction, so a wrapper can only be reused for a
 * bucket that fits in it. {@link WRAPPER_CAPACITY} is therefore a hard 32 and a bucket that overflows
 * takes a second wrapper rather than growing the first. That is one branch, and it is what makes
 * "the wrapper count is bounded by the window size" a statement a test can check instead of an
 * estimate — the ceiling is `MAX_WINDOW_CHUNKS x prototypes x ceil(instances / 32)`, and every term
 * in it is a constant.
 *
 * ## M4: every wrapper is minted with an `instanceColor`, and none is ever minted without one
 *
 * Fog of war is a per-instance colour multiply (`fogOfWar.ts`). `InstancedMesh.instanceColor` is
 * `null` until something writes one, and three puts `USE_INSTANCING_COLOR` in the program cache key —
 * so a pool where *some* wrappers carry a colour buffer compiles the Lambert material twice, and which
 * program a chunk gets would depend on what happened to be recycled into it. Allocating the buffer in
 * {@link ScenePool.mint}, filled with white, makes the define universal and the program count
 * unchanged. It costs 96 bytes an instance: 242 KB across the whole pre-warmed pool, folded into
 * {@link WRAPPER_BYTES} rather than reported separately, because it is per-instance data like the
 * matrix and belongs in the same number.
 *
 * ## The ledger is the CI-assertable proxy for `renderer.info.memory`
 *
 * `renderer.info.memory` needs a GPU and CI has none, so the pool counts what it hands out and the
 * debug object exposes **both** — `__debug3d.ledger` beside `__debug3d.rendererMemory` — so a human
 * can put them side by side in the browser once and confirm the proxy is honest. The plan asks for a
 * flat `renderer.info.memory` over a 1,000-room traversal; `traversal.test.ts` asserts the flat
 * ledger, headless, in a couple of seconds, which is the version that can run on every commit.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  TorusGeometry,
} from 'three';

import { FOG_INDEX, fogTintRow, type FogState } from './fogOfWar.ts';
import {
  ARCHETYPES,
  ARCHETYPE_CASTS,
  ARCHETYPE_EMISSIVE,
  EMISSIVE_COLOUR,
  FADE_OPACITY,
  GEOMETRY_KEYS,
  MATERIAL_KEYS,
  PORTAL_PULSE_DEPTH,
  PORTAL_PULSE_HZ,
  archetypeColour,
  type Archetype,
  type GeometryKey,
  type MaterialKey,
} from './prototypes.ts';
import { MAX_WINDOW_CHUNKS } from './streamer.ts';
import { SECTORS, type Sector } from '@mygame/shared';

/**
 * Instances one wrapper can hold.
 *
 * Sized against the worst room the IR can describe: one ground slab, four mouth strips, up to eight
 * wall segments, four door leaves and a dozen props all land in *different* buckets, so a single
 * bucket only ever fills up for `edge` walls (8) and `stair` steps (8, two flights of four). 32 is
 * four times the observed maximum and still only 2 KB of matrix buffer.
 */
export const WRAPPER_CAPACITY = 32;

/** Bytes of per-instance data per wrapper: sixteen floats of matrix and three of fog-of-war colour. */
const WRAPPER_BYTES = WRAPPER_CAPACITY * (16 + 3) * Float32Array.BYTES_PER_ELEMENT;

/**
 * Distinct buckets one chunk can produce.
 *
 * Every placement in a chunk carries the same sector and the same fade, so its material is decided
 * by its archetype alone — which makes the ceiling simply "the archetypes a room plan can contain",
 * i.e. all of them except the two body ones. Nine.
 */
const CHUNK_BUCKET_CEILING = ARCHETYPES.filter((a) => a !== 'self' && a !== 'other').length;

/** `EntityLayer` takes two and never gives them back: one for you, one for everybody else. */
const ENTITY_WRAPPERS = 2;

/**
 * Wrappers minted in the constructor — **the architectural ceiling, allocated once**.
 *
 * The first draft of this file minted lazily and the traversal test caught what that costs: over a
 * thousand real rooms the free list was still being outgrown at room 900, climbing from 67 wrappers
 * to 110, because each denser region needed a few more than the last had left behind. That is not a
 * leak — it plateaus — but it is not *flat*, and "flat" is the property the plan asks for and the
 * one a reviewer can check at a glance.
 *
 * So the whole pool is built at startup from a number that is a product of two constants: the window
 * can hold {@link MAX_WINDOW_CHUNKS} chunks and a chunk can want {@link CHUNK_BUCKET_CEILING}
 * buckets. 70 x 10 + 2 = **702 wrappers, 1.71 MB of per-instance buffer, and not one byte more for
 * the rest of the session.** (M4's `glow` archetype took the per-chunk ceiling from nine to ten.)
 * Measured against the real world, the walk's high-water is a sixth of that, so the headroom is real;
 * the reason to allocate the ceiling anyway is that the ceiling is the thing that can be *reasoned*
 * about, and an empirical high-water is only ever a statement about the zones somebody happened to
 * walk.
 *
 * The pool does not *cap* at this figure — a bucket that overflowed would still get a wrapper,
 * because dropping geometry to protect a counter is the wrong trade — and {@link
 * LedgerSnapshot.wrappersCreated} exceeding it is exactly how that would be found.
 */
export const WRAPPER_POOL_SIZE = MAX_WINDOW_CHUNKS * CHUNK_BUCKET_CEILING + ENTITY_WRAPPERS;

/**
 * What the pool has handed out, maintained by the pool itself.
 *
 * Counters rather than a heap walk, because the number that matters is not "how much is allocated"
 * but "is it still the same as it was a thousand rooms ago". Every field is monotone or bounded and
 * the traversal test says which is which.
 */
export interface LedgerSnapshot {
  /** Created once in the constructor. Constant for the life of the pool. */
  readonly geometries: number;
  readonly materials: number;
  /** Minted in the constructor: {@link WRAPPER_POOL_SIZE}. */
  readonly prewarmed: number;
  /**
   * Minted wrappers, ever. **This is the leak indicator.**
   *
   * Equal to {@link prewarmed} for the life of a healthy session. Anything above it means a bucket
   * overflowed the ceiling the pool was sized against, which is a fact about the world rather than
   * about the renderer and wants the ceiling revisited rather than the counter ignored.
   */
  readonly wrappersCreated: number;
  /** Out on loan right now. Bounded by the window. */
  readonly wrappersLive: number;
  /** Waiting on the free list. `live + free === created`, always. */
  readonly wrappersFree: number;
  /** The largest `wrappersLive` ever reached — the high-water mark the report quotes. */
  readonly wrapperHighWater: number;
  readonly acquires: number;
  readonly releases: number;
  /** Vertex and index data of the four shapes. */
  readonly geometryBytes: number;
  /** `wrappersCreated x WRAPPER_BYTES`. */
  readonly instanceBytes: number;
  readonly bytes: number;
}

interface LedgerState {
  geometries: number;
  materials: number;
  wrappersCreated: number;
  wrappersLive: number;
  wrapperHighWater: number;
  acquires: number;
  releases: number;
  geometryBytes: number;
}

function geometryBytes(geometry: BufferGeometry): number {
  let bytes = 0;
  for (const attribute of Object.values(geometry.attributes)) {
    bytes += attribute.array.byteLength;
  }
  bytes += geometry.index?.array.byteLength ?? 0;
  return bytes;
}

/**
 * The four unit shapes.
 *
 * Every one is built so that a scale of `(sx, sy, sz)` gives a full extent of exactly those metres,
 * which is the invariant `chunkPlan.ts` writes its dimensions against. The capsule is the one that
 * needs saying twice: `CapsuleGeometry(0.5, 1)` is one metre across and **two** tall (the cylinder
 * plus two hemispherical caps), so a body scales its height by half.
 */
function buildGeometry(key: GeometryKey): BufferGeometry {
  switch (key) {
    case 'box':
      return new BoxGeometry(1, 1, 1);
    case 'cone':
      return new ConeGeometry(0.5, 1, 8);
    case 'torus':
      // Radius 1, tube 0.13: a uniform scale by the wanted ring radius keeps the tube in proportion.
      return new TorusGeometry(1, 0.13, 8, 24);
    case 'capsule':
      return new CapsuleGeometry(0.5, 1, 4, 8);
  }
}

/** Splits a material key back into the parts {@link prototypes.materialKey} put in it. */
function partsOf(key: MaterialKey): { archetype: string; sector: Sector | undefined; faded: boolean } {
  const bits = key.split('|');
  const archetype = bits[0] ?? '';
  const faded = bits[bits.length - 1] === 'dim';
  const middle = bits.length > 1 && bits[1] !== 'dim' ? bits[1] : undefined;
  const sector = SECTORS.find((s) => s === middle);
  return { archetype, sector, faded };
}

export class ScenePool {
  private readonly geometries = new Map<GeometryKey, BufferGeometry>();
  private readonly materials = new Map<MaterialKey, MeshLambertMaterial>();
  /** Nine floats a key: the three fog-of-war multipliers, packed by {@link FOG_INDEX}. */
  private readonly tints = new Map<MaterialKey, Float32Array>();
  /** Whether a wrapper drawn with this key belongs in the shadow pass. Derived, never passed in. */
  private readonly casts = new Map<MaterialKey, boolean>();
  /** The materials the portal pulse writes. Two: the ring and its faded twin. */
  private readonly pulsing: { material: MeshLambertMaterial; base: number }[] = [];
  private readonly free: InstancedMesh[] = [];
  private readonly state: LedgerState = {
    geometries: 0,
    materials: 0,
    wrappersCreated: 0,
    wrappersLive: 0,
    wrapperHighWater: 0,
    acquires: 0,
    releases: 0,
    geometryBytes: 0,
  };

  constructor() {
    for (const key of GEOMETRY_KEYS) {
      const geometry = buildGeometry(key);
      this.geometries.set(key, geometry);
      this.state.geometryBytes += geometryBytes(geometry);
    }
    this.state.geometries = this.geometries.size;

    for (const key of MATERIAL_KEYS) {
      const { archetype, sector, faded } = partsOf(key);
      const kind = archetype as Archetype;
      const material = new MeshLambertMaterial({ color: archetypeColour(kind, sector) });
      if (faded) {
        material.transparent = true;
        material.opacity = FADE_OPACITY;
      }
      const emissive = ARCHETYPE_EMISSIVE[kind];
      if (emissive !== undefined) {
        material.emissive.setHex(EMISSIVE_COLOUR[kind] ?? 0xffffff);
        // A faded emissive is a light source one level down; dimming it with the opacity alone would
        // leave a full-strength glow behind a 30% ring.
        material.emissiveIntensity = faded ? emissive * FADE_OPACITY : emissive;
        if (kind === 'portal') this.pulsing.push({ material, base: material.emissiveIntensity });
      }
      material.name = key;
      this.materials.set(key, material);
      // The fog-of-war table is a pure function of the material's own colour, so it is built here,
      // once, and never recomputed. See `fogOfWar.ts` for why the desaturation cannot be a shader.
      this.tints.set(key, fogTintRow(new Color(archetypeColour(kind, sector))));
      this.casts.set(key, ARCHETYPE_CASTS[kind] && !faded);
    }
    this.state.materials = this.materials.size;

    // The free list, whole, before a single chunk exists. See `WRAPPER_POOL_SIZE`.
    const box = this.geometry('box');
    const first = this.material(MATERIAL_KEYS[0]!);
    for (let i = 0; i < WRAPPER_POOL_SIZE; i++) this.free.push(this.mint(box, first));
  }

  private mint(geometry: BufferGeometry, material: MeshLambertMaterial): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, WRAPPER_CAPACITY);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    // White, so a wrapper that nobody tints draws exactly as its material says. Allocated here and
    // never conditionally — see the header: a null `instanceColor` is a second shader program.
    const colours = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 3).fill(1), 3);
    colours.setUsage(DynamicDrawUsage);
    mesh.instanceColor = colours;
    // Everything receives moonlight's shadow, set once and never varied — see `ARCHETYPE_CASTS` for
    // why that is a table not worth having. `castShadow` is the one that varies, per key, in
    // `acquire`.
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.count = 0;
    mesh.visible = false;
    this.state.wrappersCreated += 1;
    return mesh;
  }

  geometry(key: GeometryKey): BufferGeometry {
    const found = this.geometries.get(key);
    // Unreachable while `GeometryKey` is the only way to ask, and thrown rather than defaulted
    // because a silent fallback shape is a bug that renders.
    if (!found) throw new Error(`no pooled geometry for ${key}`);
    return found;
  }

  material(key: MaterialKey): MeshLambertMaterial {
    const found = this.materials.get(key);
    if (!found) throw new Error(`no pooled material for ${key}`);
    return found;
  }

  /**
   * A wrapper for one `(chunk, prototype)` bucket, from the free list where possible.
   *
   * Deliberately **per chunk and not one world-spanning batch**, which is the plan's own wording: a
   * single `InstancedMesh` covering the whole window would never be frustum-culled, and at a 64°
   * camera a third of the window is behind the near plane. The caller fills the matrices, sets
   * `count`, and calls {@link finish}.
   */
  acquire(geometry: GeometryKey, material: MaterialKey): InstancedMesh {
    this.state.acquires += 1;
    this.state.wrappersLive += 1;
    if (this.state.wrappersLive > this.state.wrapperHighWater) {
      this.state.wrapperHighWater = this.state.wrappersLive;
    }

    const reused = this.free.pop() ?? this.mint(this.geometry(geometry), this.material(material));
    reused.geometry = this.geometry(geometry);
    reused.material = this.material(material);
    reused.castShadow = this.casts.get(material) ?? false;
    reused.count = 0;
    reused.visible = true;
    return reused;
  }

  /**
   * Write one chunk's fog-of-war state across every instance in a wrapper.
   *
   * The same three floats `count` times, because a chunk is a room and a room is in one state. Called
   * on build and on any retint; the buffer is `DynamicDrawUsage` and the upload is a few hundred bytes.
   */
  paint(mesh: InstancedMesh, material: MaterialKey, state: FogState, count: number): void {
    const colours = mesh.instanceColor;
    const row = this.tints.get(material);
    if (!colours || !row) return;
    const array = colours.array as Float32Array;
    const at = FOG_INDEX[state] * 3;
    const r = row[at] ?? 1;
    const g = row[at + 1] ?? 1;
    const b = row[at + 2] ?? 1;
    for (let i = 0; i < count; i++) {
      array[i * 3] = r;
      array[i * 3 + 1] = g;
      array[i * 3 + 2] = b;
    }
    colours.needsUpdate = true;
  }

  /**
   * The portal ring's breath. One uniform write for every ring in the world, once a frame.
   *
   * `seconds` is wall-clock, like the rain's: an accumulator would run at a different rate on a
   * different machine, and two players standing at the same gate should see it at the same phase.
   */
  pulse(seconds: number): void {
    const swing = 1 - PORTAL_PULSE_DEPTH + PORTAL_PULSE_DEPTH * Math.sin(seconds * PORTAL_PULSE_HZ * Math.PI * 2);
    for (const entry of this.pulsing) entry.material.emissiveIntensity = entry.base * swing;
  }

  /** Call once a wrapper's matrices are written, so frustum culling uses the instances' own bounds. */
  finish(mesh: InstancedMesh): void {
    mesh.instanceMatrix.needsUpdate = true;
    // Without this the sphere is the unit shape's, so a 9 m ground slab claims a 0.9 m radius and is
    // culled the moment its centre leaves the frustum — which at this camera pitch is constantly.
    mesh.computeBoundingSphere();
  }

  /** Hand a wrapper back. Nothing is disposed: that is the entire point of the free list. */
  release(mesh: InstancedMesh): void {
    mesh.removeFromParent();
    mesh.count = 0;
    mesh.visible = false;
    this.state.releases += 1;
    this.state.wrappersLive -= 1;
    this.free.push(mesh);
  }

  snapshot(): LedgerSnapshot {
    const instanceBytes = this.state.wrappersCreated * WRAPPER_BYTES;
    return {
      geometries: this.state.geometries,
      materials: this.state.materials,
      prewarmed: WRAPPER_POOL_SIZE,
      wrappersCreated: this.state.wrappersCreated,
      wrappersLive: this.state.wrappersLive,
      wrappersFree: this.free.length,
      wrapperHighWater: this.state.wrapperHighWater,
      acquires: this.state.acquires,
      releases: this.state.releases,
      geometryBytes: this.state.geometryBytes,
      instanceBytes,
      bytes: this.state.geometryBytes + instanceBytes,
    };
  }

  /**
   * Teardown. The only place `dispose()` is ever called, which is how it should read.
   *
   * A pool that disposed per unload would be the design this one exists to avoid; a pool that never
   * disposed at all would leak a page's worth of GPU objects on a hot reload, and Vite hot-reloads
   * constantly.
   */
  dispose(): void {
    for (const mesh of this.free) mesh.dispose();
    this.free.length = 0;
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.tints.clear();
    this.casts.clear();
    this.pulsing.length = 0;
  }
}
