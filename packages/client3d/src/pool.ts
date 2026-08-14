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
  DataTexture,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
  TorusGeometry,
  type Texture,
} from 'three';

import {
  createBlendControls,
  createGroundMapControls,
  patchGroundBlend,
  type BlendControls,
  type GroundMapControls,
} from './blend.ts';
import {
  GRASS_FADE,
  KIT_ALPHA_TEST,
  KIT_LEAF_FADE,
  MASK_BLADE,
  MASK_NEEDLE,
  MASK_TEXTURE,
  createFoliageMaterial,
  createWindClock,
  type FoliageUniforms,
  type ShaderPatch,
  type WindClock,
} from './foliage.ts';
import { FOG_INDEX, fogTintRow, type FogState } from './fogOfWar.ts';
import { createWallMapControls, patchWallTexture, type WallMapControls } from './masonry.ts';
import {
  ARCHETYPES,
  ARCHETYPE_CASTS,
  ARCHETYPE_EMISSIVE,
  CHARACTER_PROP_TEXTURES,
  EMISSIVE_COLOUR,
  FADE_OPACITY,
  KIT_MODELS_PER_ROOM,
  KIT_PARTS_MAX,
  KIT_TEXTURE_CASTS,
  MATERIAL_KEYS,
  PORTAL_PULSE_DEPTH,
  PORTAL_PULSE_HZ,
  PROPS_MODELS_PER_ROOM,
  PROPS_PARTS_MAX,
  SCENERY_AUTHORED_PARTS_MAX,
  SCENERY_SCATTER_PARTS_MAX,
  SHAPE_KEYS,
  TREE_VARIANTS_PER_ROOM,
  TREE_PARTS,
  VILLAGE_PARTS_MAX,
  VILLAGE_ROLE_CASTS,
  VILLAGE_WALL_MODELS_PER_ROOM,
  WALL_OPEN_OPACITY,
  archetypeColour,
  groundTextureOf,
  kitRoleOf,
  materialFamily,
  materialKey,
  sparkleFadeColour,
  sparkleFadeOf,
  villageRoleOf,
  wallTextureOf,
  type Archetype,
  type GeometryKey,
  type KitTextureId,
  type MaterialFamily,
  type MaterialKey,
  type ShapeKey,
} from './prototypes.ts';
import { MAX_WINDOW_CHUNKS, WINDOW_LEVELS } from './streamer.ts';
import { createPuddleMaterial, createWetControls, patchWetGround, type WetControls } from './wetness.ts';
import { createWaterMaterial, type WaterControls, createWaterControls } from './water.ts';
import { createWarpControls, patchWarpVertex, type WarpControls } from './warp.ts';
import { SCATTER_BLOCKS, SECTORS, type Sector } from '@mygame/shared';

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
 * Sixteen floats of matrix, three of fog-of-war colour, M5a's eight — `iBlend`'s four corner weights
 * and `iTint`'s three colour channels plus a noise phase — and M5c's four, `iWarp`'s corner
 * amplitudes. See the header for why the last twelve are on *every* wrapper rather than only on the
 * ground's.
 */
const WRAPPER_BYTES = WRAPPER_CAPACITY * (16 + 3 + 4 + 4 + 4) * Float32Array.BYTES_PER_ELEMENT;

/**
 * How many segments the ground slab's horizontal axes are cut into — M5c. See `prototypes.SHAPE_KEYS`.
 *
 * A pool constant rather than a `prototypes.ts` one because it is a statement about vertex memory: it
 * takes `groundBox` from 24 vertices to 90 and from 12 triangles to 96, which across the ~350 ground
 * instances a full window draws is 33 k triangles against a p90 frame of 1.45 M.
 */
const GROUND_SEGMENTS = 4;

/** The same for the water surface, and it is two rather than four — see {@link buildWaterPlane}. */
const WATER_SEGMENTS = 2;

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
    // M6's `villageSolid` is counted against {@link INTERIOR_WRAPPER_CEILING} for the kit's own
    // reason: it is `interior.ts`'s and is keyed by model rather than by sector. `ceiling` is *not*
    // carved out — it is a `planChunk` placement like the walls and the ground, it is biome-keyed
    // like them, and every one of the 108 chunks in the window can genuinely have one.
    a !== 'villageSolid' &&
    // M7b's `character` is never a `planChunk` placement either — a body is placed by the simulation's
    // own coordinates, not by a room plan — so counting it here would charge the ceiling for one more
    // wrapper on all 300 chunks for a family that uses no wrappers at all. Bodies are `SkinnedMesh`es
    // and come off {@link BODY_POOL_SIZE}; the `creature:` capsules ride `ENTITY_WRAPPERS`.
    a !== 'character' &&
    // M5b's four are all counted elsewhere: the kit's two against the scatter term, the puddle
    // against {@link PUDDLE_WRAPPERS}, and water off its own free list. Counting them here as well
    // would charge the ceiling for four wrappers on all seventy chunks, including the thirty-five on
    // the level below that can never grow any of them.
    a !== 'kitSolid' &&
    a !== 'kitLeaf' &&
    a !== 'water' &&
    a !== 'puddle' &&
    // M9's `propSolid` is `villageSolid`'s case in a second costume: it is `furnish.ts`'s, it is
    // keyed by `(model, texture)` rather than by sector, and it is counted against
    // {@link DRESSED_WRAPPER_CEILING} on the 293 cells that can be dressed rather than against all
    // 586 chunks — half of which are the level below, which is never furnished.
    a !== 'propSolid' &&
    // `ground` comes off its own free list — see `ScenePool.mintAttributed`.
    a !== 'ground',
).length;

/**
 * The ground's own pre-warm: one wrapper per chunk the window can hold.
 *
 * Exactly one, and now trivially so: since 2026-08-13 a chunk produces **exactly one** ground
 * placement — a single slab spanning the room block plus half the gap on every side (see
 * `chunkPlan.ts`'s header on the voids that replaced). It used to be the slab plus up to four
 * half-gap mouth strips, which was also one wrapper, at five instances of the thirty-two it holds.
 */
const BLEND_POOL_SIZE = MAX_WINDOW_CHUNKS;

/**
 * Anisotropic samples on a floor texture. Eight, and clamped by three to the driver's maximum.
 *
 * The ground is seen at 64 degrees from vertical and stretches to the fog, so it is the one surface
 * in this renderer where trilinear filtering alone turns paving into a grey wash within ten metres.
 * Eight is the usual point of diminishing returns and is supported everywhere WebGL2 is.
 */
const GROUND_ANISOTROPY = 8;

/**
 * Wrappers one chunk's *scatter* can want — M5a, and derived rather than measured.
 *
 * `scatter.ts`'s three caps are what make this a constant: a room draws at most
 * {@link TREE_VARIANTS_PER_ROOM} species x {@link TREE_PARTS} meshes, plus one undergrowth bucket, and
 * each of those buckets holds at most {@link WRAPPER_CAPACITY} instances because `TREES_PER_ROOM_MAX`
 * and `GRASS_PER_ROOM_MAX` are both exactly that number. Seven, and the arithmetic is in that file's
 * header.
 */
const SCATTER_WRAPPER_CEILING =
  TREE_VARIANTS_PER_ROOM * TREE_PARTS.length + 1 + KIT_MODELS_PER_ROOM * KIT_PARTS_MAX;

/**
 * Wrappers one chunk's **interior dressing** can want — M6, derived the same way and from the same
 * kind of caps.
 *
 * A dressed room draws {@link VILLAGE_WALL_MODELS_PER_ROOM} wall models (a plain and a feature) of at
 * most {@link VILLAGE_PARTS_MAX} primitives each, plus one floor model, one arch, the roof's two
 * primitives and a chimney. Eleven, and every one of those buckets holds well inside
 * {@link WRAPPER_CAPACITY}: twelve wall chords, nine floor tiles, four arches, one roof, one chimney.
 *
 * `interior.test.ts` sweeps the world and asserts both halves — no room over eleven buckets, no
 * bucket over thirty-two instances — because a bound that is only an argument is a bound that a
 * palette edit can quietly break.
 */
export const INTERIOR_WRAPPER_CEILING = VILLAGE_WALL_MODELS_PER_ROOM * VILLAGE_PARTS_MAX + 1 + 1 + 2 + 1;

/**
 * Wrappers one chunk's **furniture** can want — M9, derived from the same kind of caps as the two
 * above it.
 *
 * A furnished room draws {@link prototypes.PROPS_MODELS_PER_ROOM} models of at most
 * {@link prototypes.PROPS_PARTS_MAX} primitives each. **Six**, and every one of those buckets holds
 * well inside {@link WRAPPER_CAPACITY}: `PROPS_PER_ROOM_MAX` is twelve instances across both models.
 *
 * Two models rather than four is a pool decision made in `prototypes.ts` and it is what keeps this
 * number small enough to matter — see {@link DRESSED_WRAPPER_CEILING} for what it buys.
 */
const FURNITURE_WRAPPER_CEILING = PROPS_MODELS_PER_ROOM * PROPS_PARTS_MAX;

/**
 * Wrappers one chunk's **dressed scenery** can want — M9, and the one number M9b actually costs.
 *
 * At M9 this was `PROPS_PARTS_MAX`: one authored prop at three primitives, because `SCENERY_MODELS`
 * named exactly one dressable kind and a room's scenery list was hand-written. M9b gives four more
 * kinds a mesh and **four of the five that draw are ones `scenery.scatterFor` derives**, so a room
 * can now ask for as many props as that function can place.
 *
 * A `max` and not a sum, and the exclusivity is `scatterFor`'s own first line — *"a room that was
 * authored keeps what it was given"*, it returns the authored list **instead of** a generated one —
 * so no room in the world holds both an authored fountain and four generated crates:
 *
 * ```
 * authored   1 prop  x 2 primitives (the widest kind nothing derives)             = 2
 * scattered  4 props x 3 primitives (the market cart's wood, iron and cloth)      = 12
 * max                                                                             = 12  (was 3)
 * ```
 *
 * The four is `scenery.SCATTER_BLOCKS.length` — the same constant the scatter dedupes against, one
 * prop a quadrant — and `tilemap.sceneryOf` only ever thins that list further. The two and the three
 * are read off {@link prototypes.SCENERY_MODELS} rather than written down, so a kind given a wider
 * stand-in tomorrow resizes the pool instead of overflowing it.
 *
 * **The three is the expensive digit and it is the `cart`'s.** A barrel, a crate and a stump are one
 * or two primitives; the market cart is three, and scattering it across open field is what takes this
 * from 8 to 12 — `+4` wrappers on each of 293 cells, `+4,650,496 B`. Taken because the owner asked
 * for wagons in a field by name. `furnish.test.ts` sweeps the world and reports the measured worst
 * room against this bound, which it does not reach.
 */
const SCENERY_WRAPPER_CEILING = Math.max(
  SCENERY_AUTHORED_PARTS_MAX,
  SCATTER_BLOCKS.length * SCENERY_SCATTER_PARTS_MAX,
);

/**
 * The wet-weather decal's own bucket — M5b. One per ground-level chunk, and provably one: every
 * puddle in a room is the same archetype with no sector and no variant, so they are one bucket of at
 * most eight instances in a wrapper that holds thirty-two.
 *
 * The water *surface* is not counted here: it comes off its own free list, for the same three.js
 * reason ground does. See {@link mintAttributed}.
 */
const PUDDLE_WRAPPERS = 1;

/**
 * What a *dressed* chunk actually costs — **the `max` that made M6's second rendering mode free, and
 * what M9's furniture does to it.**
 *
 * The scatter term and the interior term are **mutually exclusive per chunk**, and not by luck: a
 * room is dressed by `interior.ts` only when it is roofed and `inside`, and every one of the four
 * tables that grow vegetation (`scatter.ts`'s `TREES_BY_SECTOR`, `GRASS_BY_SECTOR`,
 * `CLUTTER_BY_SECTOR` and `KIT_BY_SECTOR`) has no `inside` row, while `planPuddles` refuses a roofed
 * room outright. So no chunk in the world can want both, and charging the pool for their sum would
 * size it for a room that cannot exist.
 *
 * At M6 that read `max(15 + 1, 11) = 16` and the interior fitted inside the budget the understory
 * already had.
 *
 * ## What M9 changes, and — more importantly — what it does not
 *
 * **The exclusivity is untouched and it is the thing that was protected.** Furniture is added to the
 * *interior* term rather than becoming a third one, because `furnish.planFurniture` refuses any room
 * `interior.dressable` refuses — the same "roofed and `inside`" predicate, asked once and reused. So
 * the `max` is still a `max` over two terms no chunk can want at once, and the whole-world sweep in
 * `interior.test.ts` still says so.
 *
 * That is also why the **outdoor and city walls are a texture and not a village module**: a module
 * would have put the interior term's modules on the chunks that grow scatter, which is exactly the
 * assumption above, and `max(16, 11)` would have become `16 + 7 = 23` — `+7` wrappers on each of
 * {@link SCATTER_CHUNKS} cells, `+8,138,368 B`. `prototypes.WALL_TEXTURES` argues the rest of it.
 *
 * What *does* move is which term wins:
 *
 * ```
 * scatter  15 + puddle 1 + scenery 3 = 19      <- the binding term, and it is the scenery's doing
 * interior 11 + furniture 6          = 17
 * max                                = 19      (was 16)
 * ```
 *
 * **The scenery term is the expensive one and it is worth naming as such.** Dressing an authored
 * `cart` with a market stall costs `+3` on the *scatter* side, because all ten of the world's
 * authored scenery props stand in outdoor `city` and `road` rooms and those chunks grow the
 * understory too. Three wrappers on 293 cells is `+3,487,872 B` for three carts in one hand-authored
 * zone — a poor rate against today's content, and taken anyway because `Room.scenery` is the seam the
 * owner authors through and the price is per *slot* rather than per cart. Furniture and dressed
 * scenery are made **exclusive per room** by `furnish.ts` so the two never sum: a room somebody
 * bothered to put a fountain in does not also want two generated barrels.
 *
 * The `+3` is the whole of it, because the furniture's `+6` lands on the side that was losing:
 * `11 + 6 = 17` is still under `15 + 1 + 3`.
 */
export const DRESSED_WRAPPER_CEILING = Math.max(
  SCATTER_WRAPPER_CEILING + PUDDLE_WRAPPERS + SCENERY_WRAPPER_CEILING,
  INTERIOR_WRAPPER_CEILING + FURNITURE_WRAPPER_CEILING,
);

/**
 * Chunks that can carry scatter: the window's own cells, on one level.
 *
 * Half of {@link MAX_WINDOW_CHUNKS}, because the three scatter archetypes are in `prototypes.ts`'s
 * never-faded set and `world3d.ts` grows nothing on the level below — see that set's docblock for why
 * a 30%-alpha alpha-clipped treeline is a contradiction rather than an economy.
 */
const SCATTER_CHUNKS = MAX_WINDOW_CHUNKS / WINDOW_LEVELS;

/**
 * `EntityLayer` takes three and never gives them back: one for you, one for everybody else, and —
 * M7b — one for the `creature:` placeholders, which are the only bodies that carry a per-instance
 * colour. See that file's note on why the two *people* wrappers stay white.
 */
const ENTITY_WRAPPERS = 3;

/**
 * How many **body rigs** may exist at once — M7b, and the pool's first per-entity allocation family.
 *
 * ## Why a body cannot be an instance, and therefore why this number exists at all
 *
 * Every other allocation in this file is an `InstancedMesh` wrapper shared by up to 32 copies of one
 * shape. A `SkinnedMesh` cannot be one of those: skinning reads a *per-mesh* bone texture, and two
 * instances of one skinned mesh would be two characters in the same pose. So a body costs its own
 * skeleton, and the pool's job changes from "reuse a buffer" to "keep the count bounded".
 *
 * ## The number, and the world it was measured against
 *
 * Interest management gives a client its own room plus the revealed neighbours (`world3d.ts`), so the
 * question is how many bodies those rooms can hold. Measured over `data/world/spawns`, all 49 zones:
 * **1,231 rooms carry mob resets, the fullest carries 14, the 99th percentile is 6 and the median is
 * 1** — only ten rooms in the whole world exceed six. Players add themselves and their group.
 *
 * ```
 *   14  the fullest room in the world (a reset limit, so an upper bound on its own population)
 * +  6  its busiest neighbour at p99
 * +  4  a full group of players standing in it
 * = 24
 * ```
 *
 * **Over the cap a body draws as a capsule**, which is M3's world and already correct code — see
 * `entities.ts`. That makes this a *performance* bound rather than a correctness one, which is the
 * only kind of cap worth having: the failure mode is a distant stranger drawn as a grey pill, not a
 * missing character.
 *
 * ## What one costs, and why the total is small
 *
 * 65 `Bone`s, one `Skeleton`, and the two buffers a skeleton owns: `boneMatrices` is
 * `65 x 16` floats = 4,160 B, and three sizes the bone texture at `ceil(sqrt(65 x 4) / 4) x 4 = 20`,
 * so 20 x 20 RGBA float = 6,400 B. **10,560 B a rig, 253 KB across the cap** — a hundredth of the
 * 23.2 MB of instance buffers this pool already holds. Geometry and materials are shared and are on
 * the ledger already; nothing here allocates either.
 */
export const BODY_POOL_SIZE = 24;

/** `65 x 16` floats of `boneMatrices` plus a `20 x 20` RGBA-float bone texture. See {@link BODY_POOL_SIZE}. */
export const BODY_RIG_BYTES = 65 * 16 * Float32Array.BYTES_PER_ELEMENT + 20 * 20 * 4 * Float32Array.BYTES_PER_ELEMENT;

/**
 * How many **loot sparkles** may exist at once — the pool's second per-entity family.
 *
 * ## Why it is a second family rather than more of the first
 *
 * A sparkle is a `SkinnedMesh` for {@link BODY_POOL_SIZE}'s reason exactly — skinning reads a per-mesh
 * bone texture, so two instances of one skinned mesh are two copies of one pose, and five glint bones
 * on independent 25-key paths *are* the effect. But it must not come off the body cap: a floor with
 * thirty things on it would then draw the people standing over them as grey pills, which is the wrong
 * thing to spend a skeleton on and exactly the failure the body cap exists to avoid.
 *
 * ## The number, and the world it was measured against
 *
 * Items are the one entity class interest management keeps **strictly to the observer's own room** —
 * `index.visibleEntities` widens *bodies* one open crossing out and deliberately does not widen the
 * floor (its own header says so). So the question is only "how much can lie on one floor".
 *
 * The server has **no cap on that at all** — no constant, no refusal, no per-room sweep; `dropSpotNear`
 * spaces drops a tile apart for twelve attempts and then gives up and stacks. So this is a measured sum
 * rather than a bound read off the simulation:
 *
 * ```
 *   20  the fullest floor in the built world — data/world/spawns/113.json, room 41994, twenty `O`
 *       resets of vnum 821 (`some nightshade`), every one placed at the room centre
 * + 20  one player's whole bag put down on top of it — `inventory.STARTING_CAPACITY`, and `drop`
 *       takes one item per command, so this is twenty deliberate acts
 * +  1  the room's own deterministic scatter pickup; `pickups.pickupInRoom` returns at most one
 * = 41
 * ```
 *
 * Corpses are **not** in that sum, and it is worth saying why: a corpse is also `kind: 'item'` on the
 * wire, but since `b3e44bb` it draws a bone pile out of an `InstancedMesh` and never asks for a rig.
 * The fourteen bodies of the world's busiest reset room cost this family nothing.
 *
 * ## What is past it, and what happens there
 *
 * Two paths can exceed 41 in a single tick and neither has a refusal in front of it: a decaying
 * container spills one ground entry per *unit* it held (a quiver of twenty arrows becomes twenty), and
 * a decaying player corpse spills `loose(inventory)` — reachable in the hundreds when the bag is full
 * of missiles. **Over the cap an item draws as the capsule again**, which is the same trade
 * {@link BODY_POOL_SIZE} makes and the same reason: a performance bound, not a correctness one.
 *
 * The capsule and not *nothing*, deliberately. The server has already decided this item is visible —
 * it passed the lit-tile gate and the `hidden` filter — and a renderer that answered that by drawing
 * nothing would hide a thing the player can walk over and `get`, which is the one failure the whole
 * `search`/`ITEM_SECRET` split exists to keep the server in charge of. An orange pill at the back of a
 * pile of forty-two is a worse-looking floor; an invisible sword is a lost sword.
 *
 * ## What one costs
 *
 * Seven joints, so `7 x 16` floats of `boneMatrices` = 448 B, and three sizes the bone texture at
 * `ceil(sqrt(7 x 4) / 4) x 4 = 8`, so 8 x 8 RGBA float = 1,024 B. **1,472 B a rig, 60,352 B across the
 * cap** — 13.9% of a body's 10,560 B and a quarter of one percent of the pool's instance buffers.
 * Geometry and materials are shared and already on the ledger.
 */
export const SPARKLE_POOL_SIZE = 41;

/** `7 x 16` floats of `boneMatrices` plus an `8 x 8` RGBA-float bone texture. See {@link SPARKLE_POOL_SIZE}. */
export const SPARKLE_RIG_BYTES = 7 * 16 * Float32Array.BYTES_PER_ELEMENT + 8 * 8 * 4 * Float32Array.BYTES_PER_ELEMENT;

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
 * plus — M5a — {@link DRESSED_WRAPPER_CEILING} more on each of the {@link SCATTER_CHUNKS} cells that
 * can grow or be dressed with anything. `300 x 10 + 150 x 16 + 2 + 1 = **5,403 wrappers**`, plus the
 * ground's and the water's own free lists: **5,853 wrappers, 23.2 MB of per-instance buffer**, and not
 * one byte more for the rest of the session. (The 300 is the owner's own doing: the dolly ceiling
 * doubled to 96 m on the ask *"about 100% more"*, 2026-08-13, and the ring re-derived.) (M4's `glow` archetype took the per-chunk ceiling from
 * nine to ten and M5b's carve-outs took it back to nine; click-to-move's `marker` adds the trailing
 * `+ 1`, alongside the bodies rather than inside the per-chunk term — see {@link MARKER_WRAPPERS};
 * M5a adds the scatter term. **The dolly multiplied the chunk count by 1.54**, because its clamp made
 * the streaming ring 9 x 6 x 2 instead of 7 x 5 x 2 — that whole delta was the ring, not this file.
 * **M6-interiors adds exactly one**, the `ceiling` archetype every roofed room's lid comes out of;
 * the *dressing* adds none at all, because {@link DRESSED_WRAPPER_CEILING} is a `max` over two terms
 * no chunk can want at once.) Measured
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
  SCATTER_CHUNKS * DRESSED_WRAPPER_CEILING +
  ENTITY_WRAPPERS +
  MARKER_WRAPPERS;

/**
 * The water surface's own pre-warm: one wrapper per ground-level chunk the window can hold.
 *
 * Exactly one, and provably: a room is one sector, so a water room has one surface. Water is in
 * `prototypes.ts`'s never-faded set, so the level below never grows one — see that set for why a
 * 30%-alpha transparent surface over a transparent surface is two lies about depth in one pixel.
 */
const WATER_POOL_SIZE = SCATTER_CHUNKS;

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
  /** M5a: wrappers that own a `BufferGeometry` view carrying `iBlend`/`iTint`. See `mintAttributed`. */
  readonly blendWrappers: number;
  /** Distinct compiled programs the material pool can produce — {@link ScenePool.programKeys}. */
  readonly programs: number;
  /** The same for `customDepthMaterial`s. {@link ScenePool.depthPrograms}. */
  readonly depthProgramCount: number;
  /** M5b: distinct kit textures loaded. Twelve when the kit is whole; zero headless. */
  readonly textures: number;
  /** Estimated texture memory, mip chain included. See {@link ScenePool.registerTexture}. */
  readonly textureBytes: number;
  /**
   * M7b: body rigs minted, ever. **The second leak indicator**, and it is read exactly as
   * {@link wrappersCreated} is: bounded by {@link BODY_POOL_SIZE} for the life of a healthy session,
   * flat from the moment the pool has seen its busiest room.
   *
   * Unlike the wrappers this one is *not* pre-warmed, and the reason is that a rig cannot be built
   * before the base bodies have loaded — there are no bones to clone until the GLB lands. So it climbs
   * from zero over the first few rooms and then stops, and "then stops" is what `traversal.test.ts`
   * asserts over a body-churn walk.
   */
  readonly rigsCreated: number;
  /** Out on loan right now: one per entity currently drawn as a real body. */
  readonly rigsLive: number;
  /** Waiting on a free list. `live + free === created`, always, per base model. */
  readonly rigsFree: number;
  /** The largest `rigsLive` ever reached. Compare against {@link BODY_POOL_SIZE}. */
  readonly rigHighWater: number;
  /**
   * Entities that wanted a rig and were handed a capsule instead, because the cap was full.
   *
   * Monotone, and **it is meant to stay at zero**: a non-zero value is not a bug, it is the world
   * telling you the cap was measured against the wrong rooms. See {@link BODY_POOL_SIZE}.
   */
  readonly rigsRefused: number;
  /** `rigsCreated x BODY_RIG_BYTES`, folded into {@link bytes}. */
  readonly rigBytes: number;
  /**
   * Loot-sparkle rigs minted, ever — **the third leak indicator**, read exactly as {@link rigsCreated}
   * is: it climbs off zero over the first crowded floor and then stops.
   *
   * Its own counters rather than more of the body's, for {@link SPARKLE_POOL_SIZE}'s reason: the two
   * families have different caps, different costs and different failure modes, and a single number
   * would let a floor full of daggers push the people standing over it back to capsules.
   */
  readonly sparklesCreated: number;
  readonly sparklesLive: number;
  readonly sparklesFree: number;
  readonly sparkleHighWater: number;
  /** Items handed a capsule because the cap was full. Meant to stay at zero; see the cap. */
  readonly sparklesRefused: number;
  /** `sparklesCreated x SPARKLE_RIG_BYTES`, folded into {@link bytes}. */
  readonly sparkleBytes: number;
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
  rigsCreated: number;
  rigsLive: number;
  rigHighWater: number;
  rigsRefused: number;
  sparklesCreated: number;
  sparklesLive: number;
  sparkleHighWater: number;
  sparklesRefused: number;
}

/**
 * What the pool needs a body rig to be — M7b, and deliberately three members and no more.
 *
 * The pool owns the *ledger* and the *recycling*; `body.ts` owns what a rig actually is. That split is
 * `registerGeometry`'s exactly — the pool counts bytes it did not build — and it is what keeps a file
 * about `InstancedMesh` free lists from importing an `AnimationMixer`.
 */
export interface PooledRig {
  /** Taken off the scene graph and stopped, but kept whole. Called by {@link ScenePool.releaseBody}. */
  park(): void;
  /** Teardown, once, at {@link ScenePool.dispose}. The only place a skeleton's texture is released. */
  dispose(): void;
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
    case 'groundBox':
      // M5c. Four segments across each horizontal axis — and one vertically, because the warp is XZ
      // only and a slab's 20 cm side has nothing to bend. Every face is cut on the *same* horizontal
      // grid, so the top, the bottom and the four sides share their corner positions exactly and the
      // box stays watertight under a per-vertex displacement. See `SHAPE_KEYS` for the 21 cm.
      return new BoxGeometry(1, 1, 1, GROUND_SEGMENTS, 1, GROUND_SEGMENTS);
    case 'cone':
      return new ConeGeometry(0.5, 1, 8);
    case 'torus':
      // Radius 1, tube 0.13: a uniform scale by the wanted ring radius keeps the tube in proportion.
      return new TorusGeometry(1, 0.13, 8, 24);
    case 'capsule':
      return new CapsuleGeometry(0.5, 1, 4, 8);
    case 'grassCross':
      return buildGrassCross();
    case 'waterPlane':
      return buildWaterPlane();
  }
}

/**
 * A one-metre quad lying in the XZ plane, facing up, centred on its own origin.
 *
 * `PlaneGeometry` is built in XY facing `+Z`, so it is rotated once here rather than per instance:
 * a placement's `rx/ry/rz` are then free to mean what they mean everywhere else, and a water surface
 * with a rotation baked into every instance matrix would be a trap for the first person to try to
 * tilt one.
 *
 * **M5b said two triangles and M5c makes it eight**, and the reason is the one thing that is not per
 * fragment: the domain warp moves *vertices*. A surface eleven metres across with four corners draws
 * the warp as a chord and leaves the shore it laps by 20 cm; at two segments that is 5 cm, which is
 * inside the foam band and therefore invisible. Two rather than the ground's four because a lake has
 * a soft edge and a road does not — and because this shape carries the puddles as well, where the
 * subdivision buys nothing at all and costs six triangles a decal.
 */
function buildWaterPlane(): BufferGeometry {
  const geometry = new PlaneGeometry(1, 1, WATER_SEGMENTS, WATER_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

/**
 * The 1x1 white texture every kit material is born with — and the reason it exists is the same one
 * `createFoliageDepth` gives for setting `alphaTest` before the first compile.
 *
 * `USE_MAP` is a `#define`. A kit material created without a map and given one when the PNG lands
 * would compile a *second* program on the frame the texture arrives, and — worse for this project —
 * `ScenePool.programKeys()`, the headless proxy the tests assert against, would report a different
 * number than the browser does. A white 1x1 multiplies to nothing and is four bytes.
 */
function whiteTexture(): DataTexture {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  texture.colorSpace = SRGBColorSpace;
  texture.name = 'kit:placeholder';
  texture.needsUpdate = true;
  return texture;
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

/** Splits a material key back into the parts the three key builders in `prototypes.ts` put in it. */
function partsOf(key: MaterialKey): {
  archetype: string;
  sector: Sector | undefined;
  faded: boolean;
  variant: string | undefined;
  /** M5b: the kit texture a `kit|model|texture` key names. Undefined for every other key shape. */
  texture: KitTextureId | undefined;
  /** M6: `village|model|texture|open` — the near-wall fade. Never the same thing as `faded`. */
  open?: boolean;
} {
  const bits = key.split('|');
  // `character|ranger` — M7b, the third marker-led shape and the only one with no model in it. See
  // `prototypes.CHARACTER_TEXTURES` for why a character material's identity is its texture alone.
  if (bits[0] === 'character') {
    return {
      archetype: 'character',
      sector: undefined,
      faded: false,
      // The texture id sits in `variant` as well as in `texture`, because a character material's
      // *whole* identity is its atlas — there is no model half — and `buildMaterial` is handed the
      // variant rather than the texture.
      variant: bits[1],
      texture: bits[1] as KitTextureId | undefined,
    };
  }
  // `props|trim-metal` — M9, and the same shape `character|` is for the same reason: a furniture
  // material's whole identity is its atlas. See `prototypes.propsMaterialKey`.
  if (bits[0] === 'props') {
    return {
      archetype: 'propSolid',
      sector: undefined,
      // Never faded and never open: the level below is not furnished (`prototypes.NEVER_FADED`) and
      // the near-wall fade is a *wall* thing — a barrel that went translucent because the camera was
      // outside the room would read as a hole in the floor.
      faded: false,
      variant: bits[1],
      // Left undefined so the cast falls through to `ARCHETYPE_CASTS.propSolid`, which is an
      // unconditional true. `KIT_TEXTURE_CASTS` is the kit's table and knows nothing about `trim-*`.
      texture: undefined,
    };
  }
  // `village|wall-plaster-straight|plaster[|open]` — the second marker-led key shape, and it is a
  // marker for `kit|`'s reason: a village model id and a kit model id are both "a lowercase
  // hyphenated word" and nothing about the string itself would tell them apart.
  if (bits[0] === 'village') {
    return {
      archetype: 'villageSolid',
      sector: undefined,
      // **Not `faded`.** That word means the level below, and the village kit never draws there —
      // see `prototypes.NEVER_FADED`. This is the near-wall fade and it has its own opacity.
      faded: false,
      variant: bits[1],
      texture: undefined,
      open: bits[3] === 'open',
    };
  }
  // `kit|bush-common-flowers|flowers` — the one key shape with a marker rather than a deduced
  // middle, because a kit model id and a tree variant id are both "a lowercase hyphenated word" and
  // nothing about the string itself would tell them apart.
  if (bits[0] === 'kit') {
    const texture = bits[2] as KitTextureId | undefined;
    const role = kitRoleOf(texture ?? '');
    return {
      archetype: role === 'leaf' ? 'kitLeaf' : 'kitSolid',
      sector: undefined,
      faded: false,
      variant: bits[1],
      texture,
    };
  }
  const archetype = bits[0] ?? '';
  const faded = bits[bits.length - 1] === 'dim';
  const middle = bits.length > 1 && bits[1] !== 'dim' ? bits[1] : undefined;
  const sector = SECTORS.find((s) => s === middle);
  // `trunk|pine-tall` — a second segment that is not a sector is a tree variant. The two key shapes
  // are told apart by what the middle *is*, not by a marker, because `materialKey` and
  // `treeMaterialKey` between them can only ever produce one or the other.
  const variant = sector === undefined && middle !== undefined ? middle : undefined;
  return { archetype, sector, faded, variant, texture: undefined };
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
  /**
   * Per-ground-material floor-texture uniforms — 2026-08-13, and one entry for **every** ground
   * material whether or not its sector has a texture.
   *
   * Uniformly, for `MATERIAL_KEYS`'s own reason about the village's `open` twin: a table with an
   * exception in it is a table that will be wrong in one row, and a `GroundMapControls` whose gain is
   * zero is four uniforms and no branch anywhere. It is also what lets {@link dressGround} be a sweep
   * rather than a lookup with a guard.
   */
  private readonly groundMaps = new Map<MaterialKey, GroundMapControls>();
  /**
   * The wall texture's four uniforms, per plain material — M9, and the sibling of
   * {@link groundMaps} one family along. Every plain key is in here; only the `edge` and `barrier`
   * ones are ever given a gain. See `masonry.ts`.
   */
  private readonly wallMaps = new Map<MaterialKey, WallMapControls>();
  /**
   * The foliage materials whose `uFade` follows the live frame, and which of the two bands each takes.
   *
   * A list rather than a walk over {@link foliages} at write time, because a **canopy** must never be
   * in it: `createFoliageUniforms` gives a canopy `1e6` precisely so it cannot dissolve inside the
   * frame, and a `setFadeBands` that swept every foliage uniform would hand a tree the understory's
   * band and dissolve it at the back of the view. Membership is decided once, where the band is
   * chosen, so the two cannot disagree. See {@link setFadeBands}.
   */
  private readonly faders: { readonly uniforms: FoliageUniforms; readonly kit: boolean }[] = [];
  /** The one wind clock every foliage material and every foliage depth material shares. */
  readonly wind: WindClock = createWindClock();
  /** The one set of ground-blend knobs. Same pattern, same reason. */
  readonly blend: BlendControls = createBlendControls();
  /** The one set of wetness knobs — the rain's after-effect on ground and the puddle opacity. */
  readonly wet: WetControls = createWetControls();
  /** The one set of water knobs: wave speed, foam width, how far the depth fade reaches. */
  readonly water: WaterControls = createWaterControls();
  /** The one warp switch, shared by reference with every material that displaces. See `warp.ts`. */
  readonly warp: WarpControls = createWarpControls();
  /** Which family each key belongs to, so `acquire` routes without re-parsing a string. */
  private readonly families = new Map<MaterialKey, MaterialFamily>();
  /** Kit textures, by manifest id. Loaded once at boot by `kit.ts`; owned here so teardown finds them. */
  private readonly textures = new Map<string, Texture>();
  private textureBytes = 0;
  /** The white 1x1 every kit material is born with. See {@link whiteTexture}. */
  private readonly placeholder = whiteTexture();
  /**
   * Geometries whose bytes are already on the ledger, **by object identity**.
   *
   * A kit tree has no LOD ladder and registers one mesh under three keys (`prototypes.ts`'s
   * `TREE_GEOMETRY_KEYS`). Counting its bytes per key would put 105 kit tree geometries on a ledger
   * that holds 35, and the ledger's whole job is to be the honest proxy for GPU memory.
   */
  private readonly counted = new Set<BufferGeometry>();
  private readonly free: InstancedMesh[] = [];
  /** The ground's own free list. See {@link mintAttributed} for why there are three. */
  private readonly blendFree: InstancedMesh[] = [];
  /** The water surface's, over `waterPlane` rather than `box`. Same three.js fact, different shape. */
  private readonly waterFree: InstancedMesh[] = [];
  private readonly blendWrappers = new Set<InstancedMesh>();
  /**
   * The body rigs, by base model — M7b. One free list per `(model, outfit-set)` family's *model* half.
   *
   * Keyed on the base body alone rather than on the whole `(model, outfit-set)` the brief names,
   * because the outfit half is not baked into a rig: a rig is 65 bones and a skeleton, and
   * `BodyRig.dress` swaps the meshes hanging off it in place. So a male rig recycled from a peasant
   * guard into a mailed player is the same 10,560 bytes and no allocation at all, where a free list
   * per gear combination would have 128 buckets and reuse almost nothing. Two lists in practice.
   */
  private readonly rigFree = new Map<string, PooledRig[]>();
  /** Every rig ever minted, live or free, so teardown reaches the ones on loan. */
  private readonly rigsAll = new Set<PooledRig>();
  /**
   * The sparkles' free list — **one list, not a map**, and that is the whole difference from
   * {@link rigFree}.
   *
   * A body's list is keyed by base model because a male rig and a female rig bind different bones. The
   * animated objects are one model with one armature ({@link prototypes.ANIMATED_MODELS}), so keying
   * would be a map that never has a second entry. If a second animated object is ever imported this is
   * the line that becomes a `Map`.
   */
  private readonly sparkleFree: PooledRig[] = [];
  private readonly sparklesAll = new Set<PooledRig>();
  private readonly state: LedgerState = {
    geometries: 0,
    materials: 0,
    wrappersCreated: 0,
    wrappersLive: 0,
    wrapperHighWater: 0,
    acquires: 0,
    releases: 0,
    geometryBytes: 0,
    rigsCreated: 0,
    rigsLive: 0,
    rigHighWater: 0,
    rigsRefused: 0,
    sparklesCreated: 0,
    sparklesLive: 0,
    sparkleHighWater: 0,
    sparklesRefused: 0,
  };

  constructor() {
    // Only the shapes this package builds. The tree and kit geometries arrive at boot through
    // `registerGeometry` — see the header for why that does not unbind the key set.
    for (const key of SHAPE_KEYS) {
      const geometry = buildGeometry(key);
      this.geometries.set(key, geometry);
      this.counted.add(geometry);
      this.state.geometryBytes += geometryBytes(geometry);
    }
    this.state.geometries = this.geometries.size;

    for (const key of MATERIAL_KEYS) {
      const { archetype, sector, faded, variant, texture, open } = partsOf(key);
      const kind = archetype as Archetype;
      const material = this.buildMaterial(key, kind, sector, variant);
      if (faded) {
        material.transparent = true;
        material.opacity = FADE_OPACITY;
      }
      // M6's near-wall fade. `transparent` and `opacity` are uniforms rather than defines, so the
      // open twin compiles no program of its own — which is what lets every village wall have one.
      if (open) {
        material.transparent = true;
        material.opacity = WALL_OPEN_OPACITY;
        // Written but not read back for depth: a wall the camera is behind must not occlude the
        // *bodies* inside the room, and a transparent surface that still writes depth would sort
        // them out of the frame even though it is only 42% opaque.
        material.depthWrite = false;
      }
      const emissive = ARCHETYPE_EMISSIVE[kind];
      if (emissive !== undefined) {
        material.emissive.setHex(EMISSIVE_COLOUR[kind] ?? 0xffffff);
        // A faded emissive is a light source one level down; dimming it with the opacity alone would
        // leave a full-strength glow behind a 30% ring.
        material.emissiveIntensity = faded ? emissive * FADE_OPACITY : emissive;
        if (kind === 'portal') this.pulsing.push({ material, base: material.emissiveIntensity });
        // The ring hangs millimetres from the surfaces it decorates (a cave mouth's strip, an
        // arch), and the doubled 96 m dolly stretched the depth buffer until it could no longer
        // separate them — the owner watched the Faerie Court's ring shimmer. Slope-scaled offset
        // wins that tie in screen space at every distance, where a bigger lift would only move
        // the same fight further away. Depth semantics are otherwise untouched: the ring still
        // writes and tests depth like any opaque thing.
        material.polygonOffset = true;
        material.polygonOffsetFactor = -2;
        material.polygonOffsetUnits = -2;
      }
      material.name = key;
      this.materials.set(key, material);
      // The fog-of-war table is a pure function of the material's own colour, so it is built here,
      // once, and never recomputed. See `fogOfWar.ts` for why the desaturation cannot be a shader.
      this.tints.set(key, fogTintRow(new Color(archetypeColour(kind, sector, variant))));
      // A kit part's shadow behaviour is its *texture's*, not its role's — a 10 cm path stone and a
      // 3 m boulder are both `kitSolid` and only one is worth a draw in the shadow pass.
      // A village part's shadow behaviour is its *role's* — every wall is a wall, where a kit prop's
      // is its texture's because a path stone and a boulder share one. And an **open** wall never
      // casts: it is the wall the player is standing behind, and a shadow thrown by something the
      // frame is deliberately seeing through is a shadow with no visible caster.
      const casts =
        kind === 'villageSolid'
          ? !open && VILLAGE_ROLE_CASTS[villageRoleOf(variant ?? '')]
          : texture !== undefined
            ? KIT_TEXTURE_CASTS[texture]
            : ARCHETYPE_CASTS[kind];
      this.casts.set(key, casts && !faded);
      this.families.set(key, materialFamily(kind, variant));
    }
    this.state.materials = this.materials.size;

    // All three free lists, whole, before a single chunk exists. See `WRAPPER_POOL_SIZE`.
    const box = this.geometry('box');
    const first = this.material(MATERIAL_KEYS[0]!);
    for (let i = 0; i < WRAPPER_POOL_SIZE; i++) this.free.push(this.mint(box, first));
    // The ground's own shape, subdivided for the warp — see `prototypes.SHAPE_KEYS`. An attributed
    // wrapper is bound to one shape for life (see `mintAttributed`), so the ground's free list is
    // minted over the shape the ground actually draws and never over the plain box.
    const slab = this.geometry('groundBox');
    const ground = this.material(materialKey('ground', SECTORS[0], false));
    for (let i = 0; i < BLEND_POOL_SIZE; i++) this.blendFree.push(this.mintAttributed(slab, ground));
    const surface = this.geometry('waterPlane');
    const waterMaterial = this.material(materialKey('water', undefined, false));
    for (let i = 0; i < WATER_POOL_SIZE; i++) this.waterFree.push(this.mintAttributed(surface, waterMaterial));
  }

  /**
   * One material, in whichever of the seven families its archetype belongs to.
   *
   * The dispatch is `prototypes.materialFamily`'s and lives there rather than here so that the test
   * that counts programs and the code that creates them read the same table.
   */
  private buildMaterial(
    key: MaterialKey,
    kind: Archetype,
    sector: Sector | undefined,
    variant: string | undefined,
  ): MeshLambertMaterial {
    const colour = archetypeColour(kind, sector, variant);
    const family = materialFamily(kind, variant);

    if (family === 'water') return createWaterMaterial(this.wind, this.water, colour, key, this.warp);
    if (family === 'puddle') return createPuddleMaterial(this.wind, this.wet, colour, key);

    // **The loot sparkle's fade ladder, and it is filed under `character` on purpose.**
    //
    // Read *before* the archetype branches because its key says `props|` and its recipe does not. A
    // sparkle is a `SkinnedMesh` (`sparkle.ts`), and `USE_SKINNING` is an **object**-level define in
    // three — so a props material worn by a skinned mesh would be a tenth compiled program however
    // identical it looked to the barrel's. What it can share instead is the program the bodies already
    // compiled: `MeshLambertMaterial` + `map` + `vertexColors` + `FrontSide` + no wetness patch +
    // skinned, which is byte-identical GLSL. Hence the same `customProgramCacheKey` and the same
    // `userData.skinned`, and hence **no new program at all** — asserted in `props.test.ts`.
    //
    // Not taking the wetness patch is right on its own merits rather than convenient: rain darkening a
    // boulder is the effect working, and rain darkening a *glint of light* is a wet-look mask on the
    // one thing in the frame that is not a surface. Same sentence the bodies make, one family over.
    //
    // The only thing that varies down the ladder is `color`, which is the `diffuse` uniform — the same
    // channel that lets all 48 ground materials share one program. See `prototypes.SPARKLE_FADE_STEPS`
    // for why the fade is a colour ladder and not an opacity one.
    const sparkle = sparkleFadeOf(key);
    if (sparkle !== undefined) {
      const material = new MeshLambertMaterial({ color: sparkleFadeColour(sparkle) });
      material.map = this.placeholder;
      material.vertexColors = true;
      material.side = FrontSide;
      material.customProgramCacheKey = (): string => 'character';
      material.userData['skinned'] = true;
      return material;
    }

    if (kind === 'character') {
      // **A body, a garment or a held prop — M7b, and the one thing in this renderer that does not
      // get wet.**
      //
      // Everything else about it is `kitSolid`: a Lambert with the pack's base-colour map, the pack's
      // baked vertex colour, single-sided because every one of these is a closed mesh. What it does
      // *not* take is `patchWetGround`, and that is the whole reason this is its own branch rather
      // than a twelfth tenant of the one below. Rain darkening a boulder is the effect working; rain
      // darkening a face is a sheen nobody asked for, applied to the one surface a player looks at.
      //
      // **The honest cost is an eighth compiled program**, and it is charged here rather than hidden:
      // `customProgramCacheKey` must describe the shader source, so a material with no wet patch
      // claiming `kit-solid` would take whichever program happened to compile first and the bug would
      // be "sometimes people are shiny". Twelve materials share this one key, so it is one program for
      // every body in the world.
      const material = new MeshLambertMaterial({ color: colour });
      material.map = this.placeholder;
      material.vertexColors = true;
      material.side = FrontSide;
      material.customProgramCacheKey = (): string => 'character';
      // Not a shader switch — a *record*, so `programKeyOf` can report the real number the browser
      // compiles. `USE_SKINNING` is an object define, so a skinned body and a rigid sword are two
      // programs from one material recipe; the two texture sets are disjoint, which is what lets the
      // question be answered here. See `prototypes.CHARACTER_PROP_TEXTURES`.
      material.userData['skinned'] = !CHARACTER_PROP_TEXTURES.has(variant ?? '');
      return material;
    }

    if (family === 'kitSolid') {
      // Bark, rock, path stone and mushroom cap — and, since M6, every village wall, floor, arch,
      // roof and chimney. A Lambert with the kit's own texture and its baked vertex AO, single-sided
      // because every one of these is a closed mesh and a back face is an overdrawn fragment. **No
      // alpha test**: the kit marks bark `MASK` out of Blender habit and its bark textures are
      // opaque, so clipping would buy `USE_ALPHATEST` and nothing else.
      const material = new MeshLambertMaterial({ color: colour });
      material.map = this.placeholder;
      material.vertexColors = true;
      material.side = FrontSide;
      material.onBeforeCompile = (shader): void => {
        // Wetness reaches the kit's solids too: a wet boulder is the most legible wet thing in a
        // frame, and it is the same shared uniform the ground uses.
        patchWetGround(shader as unknown as ShaderPatch, this.wet, 0.55);
      };
      material.customProgramCacheKey = (): string => 'kit-solid';
      return material;
    }

    if (family === 'kitLeaf') {
      // The kit's leaves, grass and flowers, on **exactly** M5a's foliage material family — the wind,
      // the two-sided translucency and the shared clock — with the procedural needle/blade mask
      // switched off by a uniform, because a kit leaf's silhouette is already in its own alpha and
      // carving a needle spray out of a painted leaf would put holes in it.
      const pair = createFoliageMaterial(
        this.wind,
        {
          // Overwritten per model from the manifest by `kit.ts`; this is what a leaf wears if the
          // manifest never arrives.
          height: 2,
          windGain: 1.4,
          // No cone, no tiers: the bent-normal recipe is for intersecting cards and a kit leaf mesh
          // has real normals of its own. `foliage.ts`'s trap 2 in the other direction.
          bend: 0,
          // **A canopy never fades and an understory does.** `kitLeaf` serves both — a kit tree's
          // leaf primitive and a fern — and the difference is the one thing about them that is not a
          // shared uniform value. A tree that dissolved inside the frame would be the most visible
          // bug in the build; a fern that does not is a few hundred fragments at the back of it.
          ...(kind === 'canopy' ? {} : { fade: KIT_LEAF_FADE }),
          maskKind: MASK_TEXTURE,
          translucency: 0.5,
        },
        colour,
        key,
        this.placeholder,
      );
      pair.material.alphaTest = KIT_ALPHA_TEST;
      pair.depth.alphaTest = KIT_ALPHA_TEST;
      pair.material.side = DoubleSide;
      this.depths.set(key, pair.depth);
      this.foliages.set(key, pair.uniforms);
      // Only the understory tracks the frame. A canopy was handed no `fade` above and must keep its
      // `1e6`; see {@link faders}.
      if (kind !== 'canopy') this.faders.push({ uniforms: pair.uniforms, kit: true });
      return pair.material;
    }

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
      if (kind === 'grass') this.faders.push({ uniforms: pair.uniforms, kit: false });
      return pair.material;
    }

    const material = new MeshLambertMaterial({ color: colour });
    if (family === 'blend') {
      // The floor texture's four uniforms, this material's own — see `blend.GroundMapControls` for
      // why they are per material where the blend knobs beside them are shared, and
      // `prototypes.GROUND_TEXTURES` for which three of the sixteen sectors actually carry one.
      const map = createGroundMapControls(groundTextureOf(sector), this.placeholder);
      this.groundMaps.set(key, map);
      material.onBeforeCompile = (shader): void => {
        const patch = shader as unknown as ShaderPatch;
        patchGroundBlend(patch, this.blend, map);
        // M5b: the ground is the surface the rain actually lands on, so the wet response goes on the
        // same 48 materials and in the same patch. Still one program — see `patchWetGround`.
        patchWetGround(patch, this.wet);
        // M5c, **last on purpose**: a vertex patch inserts itself immediately after
        // `#include <begin_vertex>`, so applying the warp last is what makes it run *first* — before
        // the blend reads `transformed` for `vBlendWorld`. The boundary breakup then rides the warped
        // ground rather than staying pinned to a lattice the ground has left. See `warp.ts`.
        patchWarpVertex(patch, this.warp);
      };
      // One key for all 32 ground materials. The whole of §4's *"one shader handles all 98 pairs"*.
      material.customProgramCacheKey = (): string => 'ground-blend';
      return material;
    }

    // **Plain, and every one of them takes the wall patch** — M9. The map is a sampler this patch
    // declares rather than `material.map`, so `USE_MAP` is never set and the biggest material family
    // in the renderer still compiles one program; but a patched material and an unpatched one are two
    // programs however identical their uniforms, so the patch goes on *all* 74 rather than on the two
    // wall archetypes. `wallTextureOf` answers `undefined` for the other seventy-two, which is a gain
    // of zero, which is a multiply by one and M3's painted box to the bit. See `masonry.ts`.
    const wall = createWallMapControls(wallTextureOf(kind, sector), this.placeholder);
    this.wallMaps.set(key, wall);
    material.onBeforeCompile = (shader): void => {
      patchWallTexture(shader as unknown as ShaderPatch, wall);
    };
    material.customProgramCacheKey = (): string => 'plain-wall';
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
   * A wrapper that owns its own per-instance data — the ground and the water surface, and nothing
   * else. M5a, generalised at M5b.
   *
   * **This is the one place the pool has more than one free list, and the reason is a three.js fact
   * rather than a design preference.** `InstancedMesh` special-cases exactly two per-instance
   * buffers, `instanceMatrix` and `instanceColor`, and both live on the *mesh*. Anything else — like
   * `blend.ts`'s four corner weights and its layer-B colour — has to be an `InstancedBufferAttribute`
   * on the **geometry**, and the geometry in this pool is shared by every wrapper that draws a box.
   * Putting `iBlend` on the pooled `BoxGeometry` would give one buffer to seventy chunks: every room
   * would blend toward the last room built.
   *
   * So such a wrapper carries a `BufferGeometry` of its own. It is a *view*, not a copy — the
   * position, normal, uv and index attributes are the pooled shape's own objects, so they upload once
   * and there is no extra vertex data on the GPU at all — with two instanced attributes added that
   * are genuinely its own. Minted at boot beside everything else and never re-pointed at another
   * shape, because ground is always a box and a water surface is always a plane.
   *
   * **Water reuses the same two attributes rather than inventing a third pair**, and that is not a
   * saving, it is the observation that the two problems have one shape: `iBlend` is a field over the
   * quad's four corners — layer B's weight for ground, how near the land is for water — and `iTint`
   * is four floats of per-room look. One buffer layout, two readings, and `writeBlend` serves both.
   */
  private mintAttributed(shape: BufferGeometry, material: MeshLambertMaterial): InstancedMesh {
    const geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(shape.attributes)) geometry.setAttribute(name, attribute);
    geometry.setIndex(shape.index);
    const corners = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 4), 4);
    corners.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iBlend', corners);
    const tint = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 4), 4);
    tint.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iTint', tint);
    // M5c's third: the sector warp amplitude at the box's four corners. On the same two families for
    // the same reason they carry the other two — these are the surfaces the warp moves per *vertex*,
    // and a vertex shader cannot ask which room it is in. Born at 1 (full landscape) rather than 0,
    // so a wrapper that somehow drew before `writeWarp` reached it would bend with the world rather
    // than stand rigid inside it.
    const warp = new InstancedBufferAttribute(new Float32Array(WRAPPER_CAPACITY * 4).fill(1), 4);
    warp.setUsage(DynamicDrawUsage);
    geometry.setAttribute('iWarp', warp);

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
   * Hand the pool a mesh — `trees.ts` and `kit.ts`, once per model, at boot.
   *
   * Refuses a key that is already filled rather than replacing it, because a second registration is
   * either a double load (harmless, and the first answer is as good) or a key collision (a bug, and
   * silently swapping the geometry under a live wrapper is the worst way to find it).
   *
   * Bytes are counted **per geometry object, not per key**. A kit tree has no LOD ladder and is
   * registered under all three LOD keys (see `prototypes.TREE_GEOMETRY_KEYS`); charging it three
   * times would put 105 kit meshes on a ledger that holds 35, and the ledger's entire job is to be an
   * honest proxy for what the GPU is actually holding.
   */
  registerGeometry(key: GeometryKey, geometry: BufferGeometry): void {
    if (this.geometries.has(key)) return;
    this.geometries.set(key, geometry);
    if (!this.counted.has(geometry)) {
      this.counted.add(geometry);
      this.state.geometryBytes += geometryBytes(geometry);
    }
    this.state.geometries = this.geometries.size;
  }

  /**
   * Hand the pool a kit texture — `kit.ts`, once per distinct PNG, at boot.
   *
   * Twelve of them across sixty-eight models: `Bark_NormalTree` alone dresses ten. The cache is by
   * manifest id and lives here rather than in `kit.ts` for two reasons. It is the pool that owns
   * teardown, and a texture is the one GPU resource in this renderer that `dispose()` genuinely has
   * to reach; and it is the pool that keeps the ledger, and **texture memory is the largest single
   * number in M5b** — 2048² RGBA is 16 MB before mipmaps, so twelve of them dwarf the 4.5 MB of
   * instance buffers the ledger was built to watch.
   *
   * The byte figure is `w x h x 4 x 4/3`: four bytes a texel and the geometric series of the mip
   * chain, which is what a driver actually allocates for a mipmapped RGBA8 texture. It is an estimate
   * and says so; `__debug3d.rendererMemory.textures` is the count the renderer will confirm.
   */
  registerTexture(id: string, texture: Texture, width: number, height: number): void {
    if (this.textures.has(id)) return;
    this.textures.set(id, texture);
    this.textureBytes += Math.round(width * height * 4 * (4 / 3));
  }

  /** A loaded kit texture, or the white placeholder every kit material was born with. */
  texture(id: string): Texture | undefined {
    return this.textures.get(id);
  }

  /**
   * Point a kit material at its real texture, now that it has arrived.
   *
   * Not `material.map = t` at the call site, because the pooled material's `customDepthMaterial` — the
   * one that clips the *shadow* — needs the same map or every kit leaf casts the shadow of a solid
   * quad. That is `foliage.ts`'s trap 1 in its second costume: not the wind this time but the mask,
   * and the same answer, which is that the two are wired in one place from one object.
   */
  dressKit(key: MaterialKey, texture: Texture): void {
    const material = this.materials.get(key);
    if (!material) return;
    material.map = texture;
    const depth = this.depths.get(key);
    if (depth) depth.map = texture;
  }

  /**
   * Put the floor textures on the ground materials, now that the pack they came from has arrived —
   * 2026-08-13, and the sibling of {@link dressKit} with two differences that both matter.
   *
   * It writes a **uniform** rather than `material.map`, because `USE_MAP` is a `#define` and a city
   * floor that compiled its own program would split the one family this renderer has spent five
   * milestones keeping whole (`prototypes.GROUND_TEXTURES` rule 1). And it is a **sweep over the
   * pool's own table** rather than a call per key, because the sectors that take a texture are data
   * in `prototypes.ts` and the loader should not have to know them.
   *
   * The gain is raised here and only here. A material born with a gain and a placeholder would
   * divide a white 1x1 by the texture's mean and draw the floor two-and-a-half times too bright for
   * however long the fetch takes; born at zero, an undressed room is exactly M3's painted box and the
   * texture simply appears.
   *
   * Idempotent, and it has to be: `kit.ts` and `village.ts` both finish their loads by sweeping, and
   * which lands first is a race between two fetches.
   */
  dressGround(lookup: (id: string) => Texture | undefined): number {
    let dressed = 0;
    for (const [key, map] of this.groundMaps) {
      const spec = groundTextureOf(partsOf(key).sector);
      if (!spec) continue;
      const texture = lookup(spec.texture);
      if (!texture) continue;
      // The floor samples this in **world space** and steps outside `[0, 1]` on the first metre, so
      // three's default `ClampToEdgeWrapping` would smear one row of texels across a whole street.
      // Shared with the village modules that also wear it, whose own uvs are inside the unit square —
      // so this is a no-op for them, and `needsUpdate` because the parameters are applied at upload.
      if (texture.wrapS !== RepeatWrapping || texture.wrapT !== RepeatWrapping) {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.needsUpdate = true;
      }
      // A floor at a 64-degree camera is the most grazing surface in the frame, which is exactly the
      // case trilinear filtering blurs to mush. Clamped by three to whatever the driver supports.
      if (texture.anisotropy < GROUND_ANISOTROPY) texture.anisotropy = GROUND_ANISOTROPY;
      map.uGroundMap.value = texture;
      map.uGroundGain.value = spec.gain;
      dressed += 1;
    }
    return dressed;
  }

  /**
   * Put the wall textures on the `edge` and `barrier` materials — M9, {@link dressGround}'s twin one
   * family along, and it differs from it in exactly nothing that matters.
   *
   * Same sweep over the pool's own table rather than a call per key, because which sectors take a
   * wall texture is `prototypes.ts`'s to say and the loader should not have to know them. Same
   * `RepeatWrapping`, and it is not optional here either: the sample is a **world** coordinate and
   * steps outside `[0, 1]` within the first metre, so three's default `ClampToEdgeWrapping` would
   * smear one row of texels down an entire city wall. Same idempotence, because `kit.ts` and
   * `village.ts` both finish their loads by sweeping and which lands first is a race.
   *
   * No anisotropy bump: a wall is seen close to **face-on** at a 45-to-64-degree camera, which is the
   * one orientation trilinear filtering handles well and the exact opposite of the grazing floor
   * `GROUND_ANISOTROPY` exists for. The two textures are shared objects, so a bump here would also be
   * a bump on the floor, which already has one.
   */
  dressWalls(lookup: (id: string) => Texture | undefined): number {
    let dressed = 0;
    for (const [key, map] of this.wallMaps) {
      const parts = partsOf(key);
      const spec = wallTextureOf(parts.archetype as Archetype, parts.sector);
      if (!spec) continue;
      const texture = lookup(spec.texture);
      if (!texture) continue;
      if (texture.wrapS !== RepeatWrapping || texture.wrapT !== RepeatWrapping) {
        texture.wrapS = RepeatWrapping;
        texture.wrapT = RepeatWrapping;
        texture.needsUpdate = true;
      }
      map.uWallMap.value = texture;
      map.uWallGain.value = spec.gain;
      dressed += 1;
    }
    return dressed;
  }

  /** Which wall materials are wearing a real texture. `__debug3d`, and the tests. */
  wallTextured(): number {
    let count = 0;
    for (const map of this.wallMaps.values()) {
      if (map.uWallGain.value > 0) count += 1;
    }
    return count;
  }

  /** Which ground materials are wearing a real floor texture. `__debug3d`, and the tests. */
  groundTextured(): number {
    let count = 0;
    for (const map of this.groundMaps.values()) {
      if (map.uGroundGain.value > 0) count += 1;
    }
    return count;
  }

  /**
   * Whether a key resolves — the material half of {@link hasGeometry}, and M7b's reason for it.
   *
   * A character primitive's material key comes out of the *manifest's* texture id, and the pool's key
   * set is closed at module load from `prototypes.CHARACTER_TEXTURES`. `characters.test.ts` asserts
   * the two agree, so a divergence is a failing test — but a re-imported pack with a thirteenth atlas
   * would otherwise reach {@link material}'s throw from inside a frame, and a renderer that stops
   * drawing because one garment gained a texture is a worse failure than a garment that is not drawn.
   */
  hasMaterial(key: MaterialKey): boolean {
    return this.materials.has(key);
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
   * Move the undergrowth's distance fade to a new frame — M6, and one write per material.
   *
   * Called whenever the rig's distance or pitch changes (`world3d.setCameraFrame`), with the bands
   * `foliage.fadeBandsFor` derives from the frame the camera is now showing. It reaches the depth
   * materials for free: a foliage pair shares one `FoliageUniforms` object by reference, which is
   * `foliage.ts`'s trap 1 holding — a shadow whose fade drifted from its caster's would be a tuft
   * that vanished while its shadow stayed.
   *
   * Compiles nothing and allocates nothing: `uFade` is a `Vector2` uniform written in place.
   */
  setFadeBands(grass: readonly [number, number], kitLeaf: readonly [number, number]): void {
    for (const fader of this.faders) {
      const band = fader.kit ? kitLeaf : grass;
      fader.uniforms.uFade.value.set(band[0], band[1]);
    }
  }

  /** The bands currently in force, read back off the first of each family. `__debug3d.camera`. */
  fadeBands(): { grass: readonly [number, number]; kitLeaf: readonly [number, number] } {
    const of = (kit: boolean): readonly [number, number] => {
      const found = this.faders.find((fader) => fader.kit === kit);
      return found ? [found.uniforms.uFade.value.x, found.uniforms.uFade.value.y] : [0, 0];
    };
    return { grass: of(false), kitLeaf: of(true) };
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
   * Ground and water come off their own free lists — see {@link mintAttributed} for the three.js fact
   * behind that — and the routing is by material family so the caller never has to know.
   */
  acquire(geometry: GeometryKey, material: MaterialKey): InstancedMesh {
    this.state.acquires += 1;
    this.state.wrappersLive += 1;
    if (this.state.wrappersLive > this.state.wrapperHighWater) {
      this.state.wrapperHighWater = this.state.wrappersLive;
    }

    const family = this.families.get(material);
    const owns = family === 'blend' || family === 'water';
    let reused: InstancedMesh;
    if (family === 'blend') {
      reused = this.blendFree.pop() ?? this.mintAttributed(this.geometry('groundBox'), this.material(material));
    } else if (family === 'water') {
      reused = this.waterFree.pop() ?? this.mintAttributed(this.geometry('waterPlane'), this.material(material));
    } else {
      reused = this.free.pop() ?? this.mint(this.geometry(geometry), this.material(material));
    }
    // An attributed wrapper keeps its own geometry for ever: it is a shape with two extra buffers on
    // it, and re-pointing it at the shared shape would take those buffers away.
    if (!owns) reused.geometry = this.geometry(geometry);
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

  /* ------------------------------------------------------------------ M7b: bodies */

  /**
   * A body rig for one entity — from the free list where possible, minted while the cap allows,
   * `undefined` once it does not.
   *
   * **The one allocating call in this file that can refuse**, and the refusal is the design: a wrapper
   * that overflows still gets minted, because dropping geometry to protect a counter is the wrong
   * trade for *terrain*, and `wrappersCreated` climbing past its ceiling is the report. A body is the
   * opposite trade — the 25th character in a room is a grey capsule at the back of a crowd, which
   * costs the player nothing and costs the frame a great deal less than a 25th skeleton. See
   * {@link BODY_POOL_SIZE} for the arithmetic and for the world it was measured against.
   *
   * `mint` is supplied by the caller for `registerGeometry`'s reason: the pool counts what it hands
   * out and does not need to know that a rig contains an `AnimationMixer`.
   */
  acquireBody(model: string, mint: () => PooledRig): PooledRig | undefined {
    const free = this.rigFree.get(model);
    const reused = free?.pop();
    if (!reused && this.state.rigsLive >= BODY_POOL_SIZE) {
      this.state.rigsRefused += 1;
      return undefined;
    }
    const rig = reused ?? this.mintRig(mint);
    this.state.rigsLive += 1;
    if (this.state.rigsLive > this.state.rigHighWater) this.state.rigHighWater = this.state.rigsLive;
    return rig;
  }

  private mintRig(mint: () => PooledRig): PooledRig {
    const rig = mint();
    this.rigsAll.add(rig);
    this.state.rigsCreated += 1;
    return rig;
  }

  /* --------------------------------------------------------------- the loot sparkle */

  /**
   * A sparkle rig for one ground item — the body family's twin, with its own cap and its own counters.
   *
   * Refuses past {@link SPARKLE_POOL_SIZE} exactly as {@link acquireBody} refuses past the body cap,
   * and for the same reason: the caller draws the capsule, which is already-correct code and costs the
   * frame a great deal less than a forty-second skeleton. See the cap for the arithmetic, for the two
   * spill paths that can exceed it in one tick, and for why the fallback is a capsule rather than
   * nothing at all.
   *
   * `mint` is the caller's for `acquireBody`'s reason: this file counts what it hands out and does not
   * need to know that a sparkle contains an `AnimationMixer`.
   */
  acquireSparkle(mint: () => PooledRig): PooledRig | undefined {
    const reused = this.sparkleFree.pop();
    if (!reused && this.state.sparklesLive >= SPARKLE_POOL_SIZE) {
      this.state.sparklesRefused += 1;
      return undefined;
    }
    let rig = reused;
    if (!rig) {
      rig = mint();
      this.sparklesAll.add(rig);
      this.state.sparklesCreated += 1;
    }
    this.state.sparklesLive += 1;
    if (this.state.sparklesLive > this.state.sparkleHighWater) {
      this.state.sparkleHighWater = this.state.sparklesLive;
    }
    return rig;
  }

  /** Hand a sparkle back. Nothing is disposed, for {@link releaseBody}'s reason. */
  releaseSparkle(rig: PooledRig): void {
    rig.park();
    this.state.sparklesLive -= 1;
    this.sparkleFree.push(rig);
  }

  /** Hand a rig back. Nothing is disposed — that is the free list's whole point, here as everywhere. */
  releaseBody(model: string, rig: PooledRig): void {
    rig.park();
    this.state.rigsLive -= 1;
    let free = this.rigFree.get(model);
    if (!free) {
      free = [];
      this.rigFree.set(model, free);
    }
    free.push(rig);
  }

  /**
   * Write one instance's four corner weights and four floats of look.
   *
   * Ground reads them as layer B's weight and its linear colour plus a breakup phase; water reads the
   * same two attributes as how near the land is at each corner, and as `(depth, phase, 0, 0)`. A
   * no-op on any wrapper that owns neither buffer, which is every wrapper that is not one of those
   * two — the caller passes every placement's optional data through here and this is where the
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
   * Write one instance's four corner **warp amplitudes** — M5c, and the same shape as
   * {@link writeBlend} for the same reason.
   *
   * Separate from `writeBlend` rather than a fifth argument on it, because the two answer different
   * questions on different schedules: the blend is what the room's biome is turning into and the warp
   * is how much of the world's own bend this patch of ground shows. A no-op on any wrapper that owns
   * no `iWarp`, which is every wrapper that is not the ground's or the water's.
   */
  writeWarp(mesh: InstancedMesh, index: number, corners: readonly number[]): void {
    if (!this.blendWrappers.has(mesh)) return;
    const warp = mesh.geometry.getAttribute('iWarp') as InstancedBufferAttribute | undefined;
    if (!warp) return;
    warp.setXYZW(index, corners[0] ?? 1, corners[1] ?? 1, corners[2] ?? 1, corners[3] ?? 1);
    warp.needsUpdate = true;
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
    // Back to the list it was minted on, by the shape it owns rather than by what it last drew: an
    // attributed wrapper's geometry is a view over one specific pooled shape and can never serve the
    // other. `waterPlane` is the discriminator because it is the only shape a water wrapper carries.
    if (!this.blendWrappers.has(mesh)) this.free.push(mesh);
    else if (mesh.geometry.getAttribute('position') === this.geometries.get('waterPlane')?.getAttribute('position')) {
      this.waterFree.push(mesh);
    } else this.blendFree.push(mesh);
  }

  /**
   * The distinct compiled programs this pool's materials can produce — the M5a number, headless.
   *
   * `renderer.info.programs` is the real answer and needs a GPU; `__debug3d.programs` exposes it. This
   * is what a test can check, and it is a faithful proxy because it is built from the same things
   * three's own program cache key is built from for these materials: the material type, the side
   * (`DOUBLE_SIDED`), whether the alpha test is live (`USE_ALPHATEST`), whether there is a map
   * (`USE_MAP`), whether vertex colours are on (`USE_COLOR_ALPHA`), and `customProgramCacheKey`.
   *
   * **`map` and `vertexColors` are in the key from M5b and were not before**, and the reason is that
   * they became load-bearing: they are `#define`s, and a kit material with a texture genuinely cannot
   * share a program with a `MeshLambertMaterial` that has none. Leaving them out would have made this
   * proxy report five where the browser compiles seven, which is worse than not having a proxy.
   *
   * **The ground's floor texture is deliberately *not* in this key, and that is honest rather than a
   * loophole.** It is a `sampler2D` the `blend.ts` patch declares, not `material.map`, so it sets no
   * `#define` and every one of the 48 ground materials emits byte-identical GLSL whether it is bound
   * to a cobble tile or to the white 1x1. Three compiles one program for them and this reports one.
   * The distinction worth keeping hold of is that a *uniform* — a colour, an opacity, a sampler, a
   * repeat — never splits a program and a *define* always does; `material.map` is a define wearing a
   * uniform's name, which is exactly why the floor texture is not one.
   *
   * Expect **seven** entries — plain Lambert, blended ground, card foliage, kit solid, kit leaf,
   * water, puddle — plus {@link depthPrograms} for the shadow pass. All 48 ground materials still
   * share one, and all 83 kit materials share two. That is the property.
   */
  programKeys(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const material of this.materials.values()) keys.add(programKeyOf(material));
    return keys;
  }

  /** The same, for the `customDepthMaterial` family. Two: the card foliage's and the kit leaf's. */
  depthPrograms(): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const material of this.depths.values()) keys.add(programKeyOf(material));
    return keys;
  }

  snapshot(): LedgerSnapshot {
    const instanceBytes = this.state.wrappersCreated * WRAPPER_BYTES;
    const rigBytes = this.state.rigsCreated * BODY_RIG_BYTES;
    const sparkleBytes = this.state.sparklesCreated * SPARKLE_RIG_BYTES;
    let rigsFree = 0;
    for (const free of this.rigFree.values()) rigsFree += free.length;
    return {
      sparklesCreated: this.state.sparklesCreated,
      sparklesLive: this.state.sparklesLive,
      sparklesFree: this.sparkleFree.length,
      sparkleHighWater: this.state.sparkleHighWater,
      sparklesRefused: this.state.sparklesRefused,
      sparkleBytes,
      rigsCreated: this.state.rigsCreated,
      rigsLive: this.state.rigsLive,
      rigsFree,
      rigHighWater: this.state.rigHighWater,
      rigsRefused: this.state.rigsRefused,
      rigBytes,
      geometries: this.state.geometries,
      materials: this.state.materials,
      prewarmed: WRAPPER_POOL_SIZE + BLEND_POOL_SIZE + WATER_POOL_SIZE,
      wrappersCreated: this.state.wrappersCreated,
      wrappersLive: this.state.wrappersLive,
      wrappersFree: this.free.length + this.blendFree.length + this.waterFree.length,
      wrapperHighWater: this.state.wrapperHighWater,
      acquires: this.state.acquires,
      releases: this.state.releases,
      geometryBytes: this.state.geometryBytes,
      instanceBytes,
      bytes: this.state.geometryBytes + instanceBytes + rigBytes + sparkleBytes,
      blendWrappers: this.blendWrappers.size,
      programs: this.programKeys().size,
      depthProgramCount: this.depthPrograms().size,
      textures: this.textures.size,
      textureBytes: this.textureBytes,
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
    // M7b, first: a skeleton's bone texture is the second GPU resource in this renderer that nothing
    // else releases (the kit's PNGs are the first), and it is per rig rather than per pool. Walked
    // over `rigsAll` rather than over the free lists, because a hot reload catches rigs on loan.
    for (const rig of this.rigsAll) rig.dispose();
    this.rigsAll.clear();
    this.rigFree.clear();
    // The sparkles own a bone texture each on exactly the same terms, and are walked over `sparklesAll`
    // for exactly the same reason: a hot reload catches the ones standing over a floor full of loot.
    for (const rig of this.sparklesAll) rig.dispose();
    this.sparklesAll.clear();
    this.sparkleFree.length = 0;
    for (const mesh of this.free) mesh.dispose();
    this.free.length = 0;
    // A blend wrapper owns its geometry, and `InstancedMesh.dispose` only releases `instanceMatrix`
    // and `instanceColor` — the two attributes that hang off the *geometry* need the geometry
    // disposed as well, or a hot reload leaks 70 pairs of buffers. The vertex data inside the view is
    // the pooled box's and is released once, below; `WebGLAttributes.remove` is idempotent, so the
    // double release is a no-op rather than a fault.
    for (const mesh of [...this.blendFree, ...this.waterFree]) {
      mesh.geometry.dispose();
      mesh.dispose();
    }
    this.blendFree.length = 0;
    this.waterFree.length = 0;
    this.blendWrappers.clear();
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const material of this.materials.values()) material.dispose();
    for (const material of this.depths.values()) material.dispose();
    // A texture is the one GPU resource here that nothing else will release — a geometry's buffers go
    // with the geometry and a material owns none — so twelve 2048² PNGs would survive every hot
    // reload of the session if this line were missing. That is 200 MB by the tenth reload.
    for (const texture of this.textures.values()) texture.dispose();
    this.placeholder.dispose();
    this.textures.clear();
    this.geometries.clear();
    this.counted.clear();
    this.materials.clear();
    this.depths.clear();
    this.foliages.clear();
    this.faders.length = 0;
    this.tints.clear();
    this.casts.clear();
    this.families.clear();
    // The textures these point at are the village pack's and were released in the sweep above; what
    // is dropped here is only the uniform objects that held them.
    this.groundMaps.clear();
    this.wallMaps.clear();
    this.pulsing.length = 0;
  }
}

/**
 * See {@link ScenePool.programKeys}: the parts of three's own cache key these materials can vary.
 *
 * `map` and `vertexColors` joined the key at M5b. Both are `#define`s in three's `WebGLProgram`
 * parameters (`USE_MAP`, `USE_COLOR_ALPHA`), so two materials that differ in either are two compiled
 * programs however identical everything else is — and a proxy that said otherwise would under-report
 * exactly the thing it exists to bound.
 */
function programKeyOf(material: MeshLambertMaterial | MeshDepthMaterial): string {
  const custom = material.customProgramCacheKey?.() ?? 'default';
  const map = material.map ? 'map' : 'nomap';
  const colours = 'vertexColors' in material && material.vertexColors ? 'vcol' : 'novcol';
  const clip = material.alphaTest > 0 ? 'clip' : 'opaque';
  // M7b: `USE_SKINNING` joined the key for `map`'s reason exactly, one level up. It is a `#define`
  // driven by the *object* rather than by the material, which would normally put it out of a
  // material-walking proxy's reach — except that the character textures split cleanly into the ones
  // only a body wears and the ones only a prop wears, so the pool can record which at build time.
  // Without this the proxy would say eight where the browser compiles nine.
  const skin = 'skinned' in material.userData ? (material.userData['skinned'] ? 'skin' : 'rigid') : 'noskin';
  return `${material.type}:${material.side}:${clip}:${map}:${colours}:${custom}:${skin}`;
}
