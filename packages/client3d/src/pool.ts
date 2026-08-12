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
 *
 * ## M5a: two more per-instance attributes, one more geometry source, two more programs
 *
 * Three changes, and each was made the way that keeps the ceiling a *bound* rather than an estimate.
 *
 * 1. **`iBlend` and `iTint` are minted on every wrapper**, exactly as `instanceColor` is and for the
 *    identical reason spelled out above: the free list is LIFO and recycles a wrapper from a ground
 *    bucket into a wall bucket within the frame, so an attribute that only *some* wrappers carried
 *    would make the ground's blend shader read whatever the last tenant left behind. Eight floats an
 *    instance, folded into {@link WRAPPER_BYTES}.
 * 2. **{@link ScenePool.registerGeometry}** lets `trees.ts` hand in the 48 baked meshes at boot. The
 *    key set is still closed (`prototypes.TREE_GEOMETRY_KEYS`) and the registration still happens
 *    once, so the ledger's `geometries` is a constant from the first second onward — which is what
 *    the traversal test actually asserts.
 * 3. **Two more compiled programs**, and no more. The blended ground and the card foliage are
 *    `onBeforeCompile` patches with a fixed `customProgramCacheKey`, so all 32 ground materials share
 *    one program and all 24 foliage materials share another, plus one depth program for the foliage's
 *    `customDepthMaterial`. {@link ScenePool.programKeys} enumerates them so a headless test can
 *    assert the count without a GPU, beside `__debug3d.programs` which is the real number.
 */

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  TorusGeometry,
} from 'three';

import { createBlendControls, patchGroundBlend, type BlendControls } from './blend.ts';
import {
  GRASS_FADE,
  MASK_BLADE,
  MASK_NEEDLE,
  createFoliageMaterial,
  createWindClock,
  type FoliageUniforms,
  type ShaderPatch,
  type WindClock,
} from './foliage.ts';
import { FOG_INDEX, fogTintRow, type FogState } from './fogOfWar.ts';
import {
  ARCHETYPES,
  ARCHETYPE_CASTS,
  ARCHETYPE_EMISSIVE,
  EMISSIVE_COLOUR,
  FADE_OPACITY,
  MATERIAL_KEYS,
  PORTAL_PULSE_DEPTH,
  PORTAL_PULSE_HZ,
  SHAPE_KEYS,
  TREE_VARIANTS_PER_ROOM,
  TREE_PARTS,
  archetypeColour,
  materialFamily,
  materialKey,
  type Archetype,
  type GeometryKey,
  type MaterialFamily,
  type MaterialKey,
  type ShapeKey,
} from './prototypes.ts';
import { MAX_WINDOW_CHUNKS, WINDOW_LEVELS } from './streamer.ts';
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

/**
 * Bytes of per-instance data per wrapper.
 *
 * Sixteen floats of matrix, three of fog-of-war colour, and M5a's eight: `iBlend`'s four corner
 * weights and `iTint`'s three colour channels plus a noise phase. See the header for why the last
 * eight are on *every* wrapper rather than only on the ground's.
 */
const WRAPPER_BYTES = WRAPPER_CAPACITY * (16 + 3 + 4 + 4) * Float32Array.BYTES_PER_ELEMENT;

/**
 * Distinct buckets a chunk's *room plan* can produce.
 *
 * Every placement in `chunkPlan.ts` carries the same sector and the same fade, so its material is
 * decided by its archetype alone — which makes the ceiling simply "the archetypes a room plan can
 * contain", i.e. all of them except the ones that are never part of a room plan. Ten: M4's `glow`
 * archetype took this from nine to ten; click-to-move's `marker` does not take it to eleven; and
 * M5a's three scatter archetypes are counted separately below, because they are `scatter.ts`'s and
 * are keyed by variant rather than by sector.
 */
const CHUNK_BUCKET_CEILING = ARCHETYPES.filter(
  (a) =>
    a !== 'self' &&
    a !== 'other' &&
    a !== 'marker' &&
    a !== 'trunk' &&
    a !== 'canopy' &&
    a !== 'grass' &&
    // `ground` comes off its own free list — see `ScenePool.mintBlend`.
    a !== 'ground',
).length;

/**
 * The ground's own pre-warm: one wrapper per chunk the window can hold.
 *
 * Exactly one, and provably: every ground placement a chunk produces — the room's slab and up to four
 * half-gap mouth strips — carries the same archetype, the same sector and the same fade, so they are
 * one bucket of at most five instances in a wrapper that holds thirty-two.
 */
const BLEND_POOL_SIZE = MAX_WINDOW_CHUNKS;

/**
 * Wrappers one chunk's *scatter* can want — M5a, and derived rather than measured.
 *
 * `scatter.ts`'s three caps are what make this a constant: a room draws at most
 * {@link TREE_VARIANTS_PER_ROOM} species x {@link TREE_PARTS} meshes, plus one undergrowth bucket, and
 * each of those buckets holds at most {@link WRAPPER_CAPACITY} instances because `TREES_PER_ROOM_MAX`
 * and `GRASS_PER_ROOM_MAX` are both exactly that number. Seven, and the arithmetic is in that file's
 * header.
 */
const SCATTER_WRAPPER_CEILING = TREE_VARIANTS_PER_ROOM * TREE_PARTS.length + 1;

/**
 * Chunks that can carry scatter: the window's own cells, on one level.
 *
 * Half of {@link MAX_WINDOW_CHUNKS}, because the three scatter archetypes are in `prototypes.ts`'s
 * never-faded set and `world3d.ts` grows nothing on the level below — see that set's docblock for why
 * a 30%-alpha alpha-clipped treeline is a contradiction rather than an economy.
 */
const SCATTER_CHUNKS = MAX_WINDOW_CHUNKS / WINDOW_LEVELS;

/** `EntityLayer` takes two and never gives them back: one for you, one for everybody else. */
const ENTITY_WRAPPERS = 2;

/**
 * `marker.ts` takes one and never gives it back — the destination ring click-to-move drops under the
 * pointer. Excluded from {@link CHUNK_BUCKET_CEILING} for the same reason `self`/`other` are: it is
 * never a placement `planChunk` produces, so counting it against every one of {@link
 * MAX_WINDOW_CHUNKS} chunks would charge the ceiling for wrappers the streamer can never actually ask
 * a room to hold, the same over-count `ENTITY_WRAPPERS` was carved out to avoid at M3.
 */
const MARKER_WRAPPERS = 1;

/**
 * Wrappers minted in the constructor — **the architectural ceiling, allocated once**.
 *
 * The first draft of this file minted lazily and the traversal test caught what that costs: over a
 * thousand real rooms the free list was still being outgrown at room 900, climbing from 67 wrappers
 * to 110, because each denser region needed a few more than the last had left behind. That is not a
 * leak — it plateaus — but it is not *flat*, and "flat" is the property the plan asks for and the
 * one a reviewer can check at a glance.
 *
 * So the whole pool is built at startup from a number that is a product of constants: the window can
 * hold {@link MAX_WINDOW_CHUNKS} chunks and a chunk can want {@link CHUNK_BUCKET_CEILING} buckets,
 * plus — M5a — {@link SCATTER_WRAPPER_CEILING} more on each of the {@link SCATTER_CHUNKS} cells that
 * can grow anything. `70 x 10 + 35 x 7 + 2 + 1 = **948 wrappers, 3.11 MB of per-instance buffer**, and
 * not one byte more for the rest of the session. (M4's `glow` archetype took the per-chunk ceiling
 * from nine to ten; click-to-move's `marker` adds the trailing `+ 1`, alongside the bodies rather than
 * inside the per-chunk term — see {@link MARKER_WRAPPERS}; M5a adds the scatter term.) Measured
 * against the real world, the walk's high-water is a fraction of that, so the headroom is real; the
 * reason to allocate the ceiling anyway is that the ceiling is the thing that can be *reasoned* about,
 * and an empirical high-water is only ever a statement about the zones somebody happened to walk.
 *
 * The pool does not *cap* at this figure — a bucket that overflowed would still get a wrapper,
 * because dropping geometry to protect a counter is the wrong trade — and {@link
 * LedgerSnapshot.wrappersCreated} exceeding it is exactly how that would be found.
 */
export const WRAPPER_POOL_SIZE =
  MAX_WINDOW_CHUNKS * CHUNK_BUCKET_CEILING +
  SCATTER_CHUNKS * SCATTER_WRAPPER_CEILING +
  ENTITY_WRAPPERS +
  MARKER_WRAPPERS;

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
  /** M5a: wrappers that own a `BufferGeometry` view carrying `iBlend`/`iTint`. See `mintBlend`. */
  readonly blendWrappers: number;
  /** Distinct compiled programs the material pool can produce — {@link ScenePool.programKeys}. */
  readonly programs: number;
  /** The same for `customDepthMaterial`s. {@link ScenePool.depthPrograms}. */
  readonly depthProgramCount: number;
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
 * The five unit shapes.
 *
 * Every one is built so that a scale of `(sx, sy, sz)` gives a full extent of exactly those metres,
 * which is the invariant `chunkPlan.ts` writes its dimensions against. The capsule is the one that
 * needs saying twice: `CapsuleGeometry(0.5, 1)` is one metre across and **two** tall (the cylinder
 * plus two hemispherical caps), so a body scales its height by half.
 *
 * `grassCross` is M5a's and breaks the centring convention deliberately: its base is at `y = 0`, like
 * a baked tree's and unlike a box's, because a tuft is placed by its foot. It also carries `aCard`,
 * the attribute `foliage.ts` reads for the blade jitter and the height coordinate — the two quads get
 * different jitters so the cross is not the same blade twice.
 */
function buildGeometry(key: ShapeKey): BufferGeometry {
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
    case 'grassCross':
      return buildGrassCross();
  }
}

function buildGrassCross(): BufferGeometry {
  const geometry = new BufferGeometry();
  // prettier-ignore
  const position = new Float32Array([
    -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,  -0.5, 1, 0,
    0, 0, -0.5,   0, 0, 0.5,   0, 1, 0.5,   0, 1, -0.5,
  ]);
  // prettier-ignore
  const normal = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
    1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
  ]);
  // prettier-ignore
  const uv = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  // `(jitter, heightCoord)`. Two different jitters, one per quad — see the docblock above.
  // prettier-ignore
  const card = new Float32Array([
    0.13, 0,  0.13, 0,  0.13, 1,  0.13, 1,
    0.61, 0,  0.61, 0,  0.61, 1,  0.61, 1,
  ]);
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setAttribute('aCard', new BufferAttribute(card, 2));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]), 1));
  return geometry;
}

/** Splits a material key back into the parts {@link prototypes.materialKey} put in it. */
function partsOf(key: MaterialKey): {
  archetype: string;
  sector: Sector | undefined;
  faded: boolean;
  variant: string | undefined;
} {
  const bits = key.split('|');
  const archetype = bits[0] ?? '';
  const faded = bits[bits.length - 1] === 'dim';
  const middle = bits.length > 1 && bits[1] !== 'dim' ? bits[1] : undefined;
  const sector = SECTORS.find((s) => s === middle);
  // `trunk|pine-tall` — a second segment that is not a sector is a tree variant. The two key shapes
  // are told apart by what the middle *is*, not by a marker, because `materialKey` and
  // `treeMaterialKey` between them can only ever produce one or the other.
  const variant = sector === undefined && middle !== undefined ? middle : undefined;
  return { archetype, sector, faded, variant };
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
  /** The `customDepthMaterial` a foliage key's wrapper must carry. See `foliage.ts`'s trap 1. */
  private readonly depths = new Map<MaterialKey, MeshDepthMaterial>();
  /** Per-foliage-material uniforms, so `trees.ts` can write a species' cone onto its canopy. */
  private readonly foliages = new Map<MaterialKey, FoliageUniforms>();
  /** The one wind clock every foliage material and every foliage depth material shares. */
  readonly wind: WindClock = createWindClock();
  /** The one set of ground-blend knobs. Same pattern, same reason. */
  readonly blend: BlendControls = createBlendControls();
  /** Which of the three families each key belongs to, so `acquire` routes without re-parsing a string. */
  private readonly families = new Map<MaterialKey, MaterialFamily>();
  private readonly free: InstancedMesh[] = [];
  /** The ground's own free list. See {@link mintBlend} for why there are two. */
  private readonly blendFree: InstancedMesh[] = [];
  private readonly blendWrappers = new Set<InstancedMesh>();
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
    // Only the shapes this package builds. The 48 baked tree geometries arrive at boot through
    // `registerGeometry` — see the header for why that does not unbind the key set.
    for (const key of SHAPE_KEYS) {
      const geometry = buildGeometry(key);
      this.geometries.set(key, geometry);
      this.state.geometryBytes += geometryBytes(geometry);
    }
    this.state.geometries = this.geometries.size;

    for (const key of MATERIAL_KEYS) {
      const { archetype, sector, faded } = partsOf(key);
      const kind = archetype as Archetype;
      const material = this.buildMaterial(key, kind, sector);
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
      this.families.set(key, materialFamily(kind));
    }
    this.state.materials = this.materials.size;

    // Both free lists, whole, before a single chunk exists. See `WRAPPER_POOL_SIZE`.
    const box = this.geometry('box');
    const first = this.material(MATERIAL_KEYS[0]!);
    for (let i = 0; i < WRAPPER_POOL_SIZE; i++) this.free.push(this.mint(box, first));
    const ground = this.material(materialKey('ground', SECTORS[0], false));
    for (let i = 0; i < BLEND_POOL_SIZE; i++) this.blendFree.push(this.mintBlend(box, ground));
  }

  /**
   * One material, in whichever of the three families its archetype belongs to.
   *
   * The dispatch is `prototypes.materialFamily`'s and lives there rather than here so that the test
   * that counts programs and the code that creates them read the same table.
   */
  private buildMaterial(key: MaterialKey, kind: Archetype, sector: Sector | undefined): MeshLambertMaterial {
    const colour = archetypeColour(kind, sector);
    const family = materialFamily(kind);

    if (family === 'foliage') {
      // A canopy's real shape constants arrive from the manifest (`trees.ts`); these are the defaults
      // a tree would wear if it never did, and are what undergrowth wears for ever.
      const pair =
        kind === 'grass'
          ? createFoliageMaterial(
              this.wind,
              {
                // The grass cross is a **unit** shape: its local height is 1 and the instance matrix
                // scales it to `DIMENSIONS.grassHeight`. The wind reads local space, so 1 is the
                // honest answer and `windGain` is what makes a blade whip where a bole does not.
                height: 1,
                windGain: 8,
                bend: 0,
                fade: GRASS_FADE,
                maskKind: MASK_BLADE,
                maskCount: 5,
                translucency: 0.4,
              },
              colour,
              key,
            )
          : createFoliageMaterial(
              this.wind,
              { height: 10, maskKind: MASK_NEEDLE, coneSlope: 4, tiers: 6, droop: 0.4 },
              colour,
              key,
            );
      this.depths.set(key, pair.depth);
      this.foliages.set(key, pair.uniforms);
      return pair.material;
    }

    const material = new MeshLambertMaterial({ color: colour });
    if (family === 'blend') {
      material.onBeforeCompile = (shader): void => {
        patchGroundBlend(shader as unknown as ShaderPatch, this.blend);
      };
      // One key for all 32 ground materials. The whole of §4's *"one shader handles all 98 pairs"*.
      material.customProgramCacheKey = (): string => 'ground-blend';
    }
    return material;
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

  /**
   * A wrapper that owns its own per-instance blend data — the ground, and only the ground. M5a.
   *
   * **This is the one place the pool has two free lists, and the reason is a three.js fact rather
   * than a design preference.** `InstancedMesh` special-cases exactly two per-instance buffers,
   * `instanceMatrix` and `instanceColor`, and both live on the *mesh*. Anything else — like
   * `blend.ts`'s four corner weights and its layer-B colour — has to be an `InstancedBufferAttribute`
   * on the **geometry**, and the geometry in this pool is shared by every wrapper that draws a box.
   * Putting `iBlend` on the pooled `BoxGeometry` would give one buffer to seventy chunks: every room
   * would blend toward the last room built.
   *
   * So a blend wrapper carries a `BufferGeometry` of its own. It is a *view*, not a copy — the
   * position, normal, uv and index attributes are the pooled box's own objects, so they upload once
   * and there is no extra vertex data on the GPU at all — with two instanced attributes added that
   * are genuinely its own. Seventy of them, minted at boot beside everything else, one per chunk the
   * window can hold, and never re-pointed at another shape because ground is always a box.
   */
  private mintBlend(box: BufferGeometry, material: MeshLambertMaterial): InstancedMesh {
    const geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(box.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(box.index);
    const shape = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 4), 4);
    shape.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iBlend', shape);
    const tint = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 4), 4);
    tint.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iTint', tint);

    const mesh = this.mint(geometry, material);
    this.blendWrappers.add(mesh);
    return mesh;
  }

  geometry(key: GeometryKey): BufferGeometry {
    const found = this.geometries.get(key);
    // Unreachable for a shape key, and reachable for a tree key only before the manifest has landed —
    // which is why `world3d.ts` asks {@link hasGeometry} first rather than catching this. Thrown
    // rather than defaulted because a silent fallback shape is a bug that renders.
    if (!found) throw new Error(`no pooled geometry for ${key}`);
    return found;
  }

  /** Whether a key resolves yet. The scatter's gate while the GLBs are still in flight. */
  hasGeometry(key: GeometryKey): boolean {
    return this.geometries.has(key);
  }

  /**
   * Hand the pool a baked mesh — `trees.ts`, once per GLB, at boot.
   *
   * Refuses a key that is already filled rather than replacing it, because a second registration is
   * either a double load (harmless, and the first answer is as good) or a key collision (a bug, and
   * silently swapping the geometry under a live wrapper is the worst way to find it).
   */
  registerGeometry(key: GeometryKey, geometry: BufferGeometry): void {
    if (this.geometries.has(key)) return;
    this.geometries.set(key, geometry);
    this.state.geometryBytes += geometryBytes(geometry);
    this.state.geometries = this.geometries.size;
  }

  material(key: MaterialKey): MeshLambertMaterial {
    const found = this.materials.get(key);
    if (!found) throw new Error(`no pooled material for ${key}`);
    return found;
  }

  /** The per-material foliage uniforms, for `trees.ts` to write a species' crown onto its canopy. */
  foliage(key: MaterialKey): FoliageUniforms | undefined {
    return this.foliages.get(key);
  }

  /**
   * Repaint a pooled material, **and rebuild its fog-of-war tint row with it**.
   *
   * The second half is the whole reason this is a method rather than `pool.material(k).color.setHex`.
   * `fogOfWar.fogTint` returns a *ratio* — the multiplier that carries a specific base colour to its
   * remembered and unseen values — so a row computed against the placeholder green and then applied to
   * a `aspen-thin` canopy two shades lighter would leave an unexplored aspen brighter than the
   * silhouette the three-state read depends on. Only `trees.ts` calls it, once per variant, at boot.
   */
  recolour(key: MaterialKey, hex: number): void {
    const material = this.materials.get(key);
    if (!material) return;
    material.color.setHex(hex);
    this.tints.set(key, fogTintRow(new Color(hex)));
  }

  /**
   * A wrapper for one `(chunk, prototype)` bucket, from the free list where possible.
   *
   * Deliberately **per chunk and not one world-spanning batch**, which is the plan's own wording: a
   * single `InstancedMesh` covering the whole window would never be frustum-culled, and at a 64°
   * camera a third of the window is behind the near plane. The caller fills the matrices, sets
   * `count`, and calls {@link finish}.
   *
   * Ground comes off a second free list — see {@link mintBlend} for the three.js fact behind that —
   * and the routing is by material family so the caller never has to know.
   */
  acquire(geometry: GeometryKey, material: MaterialKey): InstancedMesh {
    this.state.acquires += 1;
    this.state.wrappersLive += 1;
    if (this.state.wrappersLive > this.state.wrapperHighWater) {
      this.state.wrapperHighWater = this.state.wrappersLive;
    }

    const wantsBlend = this.families.get(material) === 'blend';
    const reused = wantsBlend
      ? this.blendFree.pop() ?? this.mintBlend(this.geometry('box'), this.material(material))
      : this.free.pop() ?? this.mint(this.geometry(geometry), this.material(material));
    // A blend wrapper keeps its own geometry for ever: it is a box with two extra buffers on it, and
    // re-pointing it at the shared box would take those buffers away.
    if (!wantsBlend) reused.geometry = this.geometry(geometry);
    reused.material = this.material(material);
    reused.castShadow = this.casts.get(material) ?? false;
    // Trap 1, at the one place it can actually be wired: the depth material is a property of the
    // *object*, not of the material, so a recycled wrapper must be given the right one — or, for
    // everything that is not foliage, have the last tenant's taken away.
    const depth = this.depths.get(material);
    if (depth) reused.customDepthMaterial = depth;
    else delete (reused as { customDepthMaterial?: unknown }).customDepthMaterial;
    reused.count = 0;
    reused.visible = true;
    return reused;
  }

  /**
   * Write one ground instance's blend: four corner weights, and layer B's linear colour and phase.
   *
   * A no-op on a wrapper that is not a blend wrapper, which is every wrapper that is not ground —
   * the caller passes every placement's optional blend data through here and this is where the
   * question "does this archetype have any" is answered once.
   */
  writeBlend(
    mesh: InstancedMesh,
    index: number,
    corners: readonly [number, number, number, number],
    tint: readonly [number, number, number, number],
  ): void {
    if (!this.blendWrappers.has(mesh)) return;
    const shape = mesh.geometry.getAttribute('iBlend') as InstancedBufferAttribute | undefined;
    const colour = mesh.geometry.getAttribute('iTint') as InstancedBufferAttribute | undefined;
    if (!shape || !colour) return;
    shape.setXYZW(index, corners[0], corners[1], corners[2], corners[3]);
    colour.setXYZW(index, tint[0], tint[1], tint[2], tint[3]);
    shape.needsUpdate = true;
    colour.needsUpdate = true;
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
    if (this.blendWrappers.has(mesh)) this.blendFree.push(mesh);
    else this.free.push(mesh);
  }

  /**
   * The distinct compiled programs this pool's materials can produce — the M5a number, headless.
   *
   * `renderer.info.programs` is the real answer and needs a GPU; `__debug3d.programs` exposes it. This
   * is what a test can check, and it is a faithful proxy because it is built from the same four things
   * three's own program cache key is built from for these materials: the material type, whether the
   * alpha test is live (`USE_ALPHATEST`), the side (`DOUBLE_SIDED`), and `customProgramCacheKey`.
   *
   * Expect **three** entries — plain Lambert, blended ground, card foliage — plus {@link
   * depthPrograms} for the shadow pass. Everything that differs within a family is a uniform, which
   * is the discipline `prototypes.ts` has kept since M3 and the reason 145 materials cost three
   * programs.
   */
  programKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const material of this.materials.values()) keys.add(programKeyOf(material));
    return keys;
  }

  /** The same, for the `customDepthMaterial` family. One: the foliage's. */
  depthPrograms(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const material of this.depths.values()) keys.add(programKeyOf(material));
    return keys;
  }

  snapshot(): LedgerSnapshot {
    const instanceBytes = this.state.wrappersCreated * WRAPPER_BYTES;
    return {
      geometries: this.state.geometries,
      materials: this.state.materials,
      prewarmed: WRAPPER_POOL_SIZE + BLEND_POOL_SIZE,
      wrappersCreated: this.state.wrappersCreated,
      wrappersLive: this.state.wrappersLive,
      wrappersFree: this.free.length + this.blendFree.length,
      wrapperHighWater: this.state.wrapperHighWater,
      acquires: this.state.acquires,
      releases: this.state.releases,
      geometryBytes: this.state.geometryBytes,
      instanceBytes,
      bytes: this.state.geometryBytes + instanceBytes,
      blendWrappers: this.blendWrappers.size,
      programs: this.programKeys().size,
      depthProgramCount: this.depthPrograms().size,
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
    // A blend wrapper owns its geometry, and `InstancedMesh.dispose` only releases `instanceMatrix`
    // and `instanceColor` — the two attributes that hang off the *geometry* need the geometry
    // disposed as well, or a hot reload leaks 70 pairs of buffers. The vertex data inside the view is
    // the pooled box's and is released once, below; `WebGLAttributes.remove` is idempotent, so the
    // double release is a no-op rather than a fault.
    for (const mesh of this.blendFree) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.blendFree.length = 0;
    this.blendWrappers.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const material of this.depths.values()) material.dispose();
    this.geometries.clear();
    this.materials.clear();
    this.depths.clear();
    this.foliages.clear();
    this.tints.clear();
    this.casts.clear();
    this.families.clear();
    this.pulsing.length = 0;
  }
}

/** See {@link ScenePool.programKeys}: the parts of three's own cache key these materials can vary. */
function programKeyOf(material: MeshLambertMaterial | MeshDepthMaterial): string {
  const custom = material.customProgramCacheKey?.() ?? 'default';
  return `${material.type}:${material.side}:${material.alphaTest > 0 ? 'clip' : 'opaque'}:${custom}`;
}
