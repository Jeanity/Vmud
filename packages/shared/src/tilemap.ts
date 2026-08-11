/**
 * Room graph -> tile grid.
 *
 * This lives in `shared` and not in either the server or the client on purpose: the server uses the
 * grid for collision and the client uses it for rendering, and if the two ever disagree by a single
 * tile, players walk through walls the client drew. One function, one result, both sides.
 *
 * Layout: each room becomes a square block of floor on a fixed stride, leaving a gap between
 * neighbours. Exits carve a connector across that gap. Rooms with no exit between them stay
 * separated by void, so the zone's real topology is visible at a glance.
 *
 * ## Storage is sparse; the coordinate space is not — M0
 *
 * A grid used to hold three dense arrays sized to the level's **bounding box**, and a bounding box
 * is not an occupancy. Measured on the shipped world: zone 317 "The Roads of the Heartland" puts the
 * 58 rooms of its level 7 inside a 5364x8760-tile box and so asked for **225.9 MB** of typed arrays
 * to describe 4,698 tiles of floor — 521.1 MB across the zone's eleven levels, against a 16 KB
 * working set. Tiles now live in **{@link CHUNK_TILES}-square chunks allocated on first write**: two
 * `Uint8Array`s per chunk, 512 bytes together, held in a `Map` keyed `(ty >> 4) << 16 | (tx >> 4)`.
 * Nothing is allocated for a region nobody wrote to, so a grid costs what its rooms cost and the
 * bounding box stops being a bill.
 *
 * The chunk edge is a **fixed power of two** rather than the migration plan's per-grid stride cell,
 * for two reasons. A power of two resolves a tile with two shifts and two masks and no division, and
 * {@link tileAt} is the hot path — {@link canStand} asks it four times per movement step, and a
 * shadowcast asks it once per cell of every ray it walks. And a *fixed* edge is one layout for both
 * projections: the classic stride is 12 and a seamless one is 10, while carves and seams deliberately
 * write into the gap *between* room blocks, so a chunk boundary must not care which projection put a
 * tile there. It costs nothing against a stride-sized chunk on a dense level — a 12x12 cell holds
 * 144 tiles at 2 bytes either way — and at most three extra chunks around an isolated room.
 *
 * **Nothing about the coordinate space moved.** `width`, `height`, the tile index `ty * width + tx`,
 * {@link TILE_SIZE}, {@link TileGrid.roomOrigins} and everything derived from them mean exactly what
 * they meant before: the `seen` bitsets on the server and in every client are sized `width * height`,
 * indexed by that formula, and travel over the wire in that shape. Only the storage under the
 * accessors changed.
 *
 * Two things stopped being stored at all. **Room ownership is derived** — a tile belongs to the room
 * whose block covers it, one division by the stride and one `Map` lookup, so the `Int32Array` that
 * held a 4-byte room id for every tile of the bounding box is gone entirely. And **a sector is
 * stored as `index + 1`**, so that a cell nobody wrote reads back as "no sector" instead of as
 * `SECTOR_INDEX[0]`, which is `inside`; see {@link sectorAt}.
 */

import {
  DIRECTION_DELTA,
  OPPOSITE,
  boundsOf,
  type Direction,
  type Door,
  type Room,
  type RoomId,
  type Sector,
  type Zone,
} from './world.ts';
import { SCENERY, scatterFor, type RoomScenery, type SceneryKind } from './scenery.ts';

export const TILE_SIZE = 32;

/** Floor tiles per room edge. Odd, so a room has a true centre tile to spawn on. */
export const ROOM_TILES = 9;

/**
 * Void tiles between adjacent room blocks.
 *
 * **This number is tuned against `DEFAULT_LIGHT_RADIUS`, not chosen for looks.** A room's last floor
 * column and its neighbour's first are `ROOM_GAP + 1` tiles apart, and a light of radius `r` reaches
 * `r` tiles. So at a gap of 2 the next room sits 3 tiles away: invisible from your own doorway at the
 * starting radius of 2, and visible at radius 3 — the first torch.
 *
 * That is the whole point of the value. Finding a light source is what opens up seeing into the next
 * room before you walk into it, which makes the upgrade something you feel rather than read. At the
 * previous gap of 3 the next room was 4 tiles away and no early light reached it at all.
 *
 * Changing this, `ROOM_TILES`, or `DEFAULT_LIGHT_RADIUS` re-tunes that relationship. `vision.test.ts`
 * pins it, so it will tell you.
 */
export const ROOM_GAP = 2;

export const ROOM_STRIDE = ROOM_TILES + ROOM_GAP;

/**
 * The seam between flush blocks in a **seamless** zone — V8a. One tile, not zero, and the width is
 * load-bearing twice over: a door needs cells to stand in (`connectorCells` derives door geometry
 * identically at build time and at open/shut time, and zero-width would leave it nowhere), and a
 * blocked border needs cells to be solid in. An open seam is filled with floor, so at the classic
 * zoom the line does not exist to the eye — the plaza just continues.
 */
export const SEAM_GAP = 1;

/**
 * Width of the opening carved between two linked rooms. Odd, to centre on the room.
 *
 * The **default**, not the only answer, since M0: two linked *outdoor* rooms merge along their whole
 * shared edge instead. See {@link connectorSpan}.
 */
export const CONNECTOR_WIDTH = 3;

/**
 * Tile kinds.
 *
 * A const object rather than a TypeScript `enum`: Node strips types at run time and refuses any
 * construct that emits runtime code, and `enum` is exactly that. This form is erasable and still
 * gives us a named type.
 */
export const Tile = {
  Void: 0,
  Floor: 1,
  Connector: 2,
  /** A **shut** door. Not walkable, and not transparent — see {@link isWalkable}. */
  Door: 3,
  StairsUp: 4,
  StairsDown: 5,
  /** The same doorway standing open. Walkable and transparent, but still drawn as a door. */
  DoorOpen: 6,
  /**
   * A **blocked border, wearing something** — V8b, and the point of the seamless world's law.
   *
   * V8a left a no-exit seam as `Void`, which is solid and correct and looks like nothing: a black
   * gap between two grounds that are otherwise continuous. The owner's brief said what should be
   * there instead — *"if we need to keep people on paths etc we can do that with trees, fences,
   * rivers, buildings"* — so a blocked seam is now its own kind: as solid and as sight-stopping as
   * void, and drawn by the client as whatever the two sectors it separates call for.
   *
   * Deliberately a tile kind rather than a flag on `Void`. Walkability and opacity are lookups on
   * the kind, and a blocker that became walkable by omission would be a wall-walk exploit — being
   * its own number means every gate has to name it, and the two that matter do.
   */
  Blocker: 7,
  /**
   * **A thing standing in the room** — V8d. Solid, and *not* sight-stopping.
   *
   * The whole reason this is a second kind rather than more `Blocker` is that pair of answers.
   * `Blocker` is a wall: you neither cross it nor see past it. A fountain, a well, a handcart is
   * something you walk around and look straight over, and a plaza whose own furniture cast walls of
   * shadow would read worse than one with no furniture at all. Splitting solidity from opacity here
   * costs one number and means the scenery catalogue can say which a prop is — see
   * {@link scenery.SCENERY}, where the hay bale is the one that chooses `Blocker`.
   */
  Prop: 8,
} as const;

export type Tile = (typeof Tile)[keyof typeof Tile];

/**
 * Tiles a character may stand on.
 *
 * **A shut door is geometry, not decoration.** This used to be `tile !== Void`, which made
 * `Tile.Door` walkable and left door state consulted only at tilemap build time — so `stepRoom`
 * refused a locked door while WASD, the drag joystick and click-to-move all walked through the same
 * doorway, because all three resolve against this function and nothing else. The MUD the project is
 * built on blocks movement on *closed* rather than on *locked* (`actmove.c:1220`: "The %s seems to be
 * closed"), locked being the flag that stops you opening it, so that is the test here too.
 *
 * The consequence to keep in mind is that opening a door has to reach every grid holding its tiles —
 * the server's and every client's — or prediction and collision disagree at that tile. {@link
 * setDoorTiles} is the one mutation both sides run, and the `door` server message is what carries it.
 */
export function isWalkable(tile: number): boolean {
  return tile !== Tile.Void && tile !== Tile.Door && tile !== Tile.Blocker && tile !== Tile.Prop;
}

/** Either state of a doorway, for code that cares that a tile *is* a door rather than how it stands. */
export function isDoorTile(tile: number): boolean {
  return tile === Tile.Door || tile === Tile.DoorOpen;
}

/** The tile kind a door in this state carves. */
function doorTile(door: Door): number {
  return door.closed ? Tile.Door : Tile.DoorOpen;
}

/* -------------------------------------------------------------------------- */
/* Sparse storage                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Edge of a storage chunk, in tiles. A power of two — see the module header for why it is fixed
 * rather than tracking the grid's own stride.
 */
export const CHUNK_TILES = 16;

/** `log2(CHUNK_TILES)`. Kept beside it so the two can never drift apart. */
const CHUNK_SHIFT = 4;

/** `CHUNK_TILES - 1`, the within-chunk offset mask. */
const CHUNK_MASK = CHUNK_TILES - 1;

const CHUNK_CELLS = CHUNK_TILES * CHUNK_TILES;

/**
 * One allocated square of a grid. 512 bytes, and the only thing on a grid that scales with area.
 *
 * `kinds` and `sectors` are separate arrays rather than interleaved because every hot read wants one
 * of them and not the other: collision and vision read kinds and never sectors, and the painter
 * reads sectors only for the tiles it is already drawing.
 */
interface TileChunk {
  /** {@link Tile} value per cell, row-major within the chunk. 0 is `Void`, which is the right blank. */
  readonly kinds: Uint8Array;
  /** Sector index **plus one** per cell, so that 0 means "nothing here". See {@link sectorAt}. */
  readonly sectors: Uint8Array;
}

/**
 * The answer {@link sectorAt} gives for a cell no room, corridor or seam ever wrote.
 *
 * **This is the fix for a latent bug, not a tidy-up.** `sectors` used to be a zero-filled dense array
 * that only occupied cells were written into, and 0 is a real sector: `SECTOR_INDEX[0]` is `inside`.
 * So every void cell in the world claimed to be an interior floor. That was invisible while the void
 * was skipped by everything that read it, and it becomes wrong the moment anything *dresses* the gaps
 * — which is the entire point of the 3D plan's Layer B. Storing `index + 1` costs nothing (there are
 * 16 sectors and a byte holds 255) and makes "no sector here" a value callers have to name.
 */
export const NO_SECTOR = -1;

/**
 * The chunk key for a tile: `(ty >> 4) << 16 | (tx >> 4)`.
 *
 * Packed into one integer rather than looked up through a per-grid `chunksAcross`, so the resolve
 * needs no field off the grid and no division. It is safe up to 65,536 chunks — 1,048,576 tiles — on
 * an axis; the largest level in the shipped world is 8,760 tiles tall, and a grid that big would have
 * failed on the dense arrays this replaced long before it collided here.
 *
 * Callers must have bounds-checked `tx` and `ty` first: a negative coordinate would fold onto some
 * other chunk's key rather than reporting itself.
 */
function chunkKey(tx: number, ty: number): number {
  return ((ty >> CHUNK_SHIFT) << 16) | (tx >> CHUNK_SHIFT);
}

/** Offset of a tile inside its own chunk. */
function chunkOffset(tx: number, ty: number): number {
  return ((ty & CHUNK_MASK) << CHUNK_SHIFT) | (tx & CHUNK_MASK);
}

export interface TileGrid {
  readonly width: number;
  readonly height: number;
  readonly level: number;
  /**
   * Allocated chunks, keyed by {@link chunkKey}. Absent means "all void, no sector", which is the
   * overwhelming majority of any real level's bounding box.
   *
   * Exposed rather than hidden because {@link gridBytes} has to count it and because the type stays a
   * plain data record — several call sites build a variant grid with `{ ...grid, roomOrigins }`, and
   * a class with private state would break them. Read it through {@link tileAt} and
   * {@link sectorAt}; write it through {@link setTile}.
   */
  readonly chunks: Map<number, TileChunk>;
  /**
   * Room id per **room cell**, keyed `(cellY << 16) | cellX` where a cell is one room-block stride.
   *
   * This is what replaced the `Int32Array` of a room id per tile. Ownership was never anything but
   * "the block this tile is inside" — nothing except the room-interior pass ever wrote that array —
   * so it is cheaper to answer the question than to store 4 bytes per tile of bounding box for it.
   * See {@link roomAtTile}.
   */
  readonly cells: ReadonlyMap<number, RoomId>;
  /** Tile-space origin of each room block on this level. */
  readonly roomOrigins: ReadonlyMap<RoomId, { readonly tx: number; readonly ty: number }>;
  /**
   * Every flight of stairs stamped into this level, with the room and exit it came from.
   *
   * The stamp used to write three tile kinds and discard `exit.to` with everything else, so the grid
   * knew a room had *a* staircase and nothing about where it went — and a stairwell you can walk up
   * needs the far room, not a decorative block. Rooms in zone order, `up` before `down`.
   */
  readonly stairs: readonly StairBlock[];
  /**
   * Tiles between adjacent room blocks on this grid — {@link ROOM_GAP} for the classic projection,
   * {@link SEAM_GAP} for a seamless zone. Carried on the grid because door geometry is *derived*,
   * not stored: `doorwayTiles` recomputes the cells a door was carved into, and it must recompute
   * them against the projection that carved them.
   */
  readonly gap: number;
}

/*
 * There is deliberately no per-room `reveal` map here any more.
 *
 * It held "the tiles this room uncovers when first entered", which was the whole of the old
 * room-granular fog. Visibility is now tile-granular — a light radius and a line of sight, unioned
 * into a per-character `seen` bitset — so a room-shaped notion of what has been revealed is not a
 * smaller version of the truth, it is a *different* rule. Leaving it on this type left a second,
 * subtly different answer to "what may this character see" sitting where anyone writing new code
 * would find it first, and it built one array entry per floor tile per room on every grid build for
 * a consumer that no longer existed.
 *
 * The one thing that still needs the old rule is migrating a pre-v4 save, and that lives in the
 * server's `legacy-fog.ts`, named for what it is and dated to be deleted with the field it reads.
 */

/** The room-block stride this grid was laid out on: nine tiles of floor plus its own gap. */
function strideOf(grid: TileGrid): number {
  return ROOM_TILES + grid.gap;
}

/** Room-cell key, matching {@link TileGrid.cells}. */
function cellKeyOf(cellX: number, cellY: number): number {
  return (cellY << 16) | cellX;
}

/**
 * An empty grid, ready to be stamped into.
 *
 * Exported because a hand-built fixture is a legitimate second caller — `vision.test.ts` and
 * `pathfind.test.ts` both need geometry {@link buildZoneTilemap} cannot produce (a lone pillar, a
 * wall with a slit in it, a maze) and used to assemble the typed arrays themselves. There is one
 * constructor now, so a fixture cannot invent a grid whose `cells` disagree with its `roomOrigins`.
 *
 * `roomOrigins` are expected on stride multiples, because that is what {@link roomAtTile} inverts.
 * An origin off the stride still lands in *some* cell and the last room written to that cell wins,
 * which is the same answer the dense array gave when two rooms shared a position.
 */
export function createTileGrid(init: {
  readonly width: number;
  readonly height: number;
  readonly level?: number;
  readonly gap?: number;
  readonly roomOrigins?: ReadonlyMap<RoomId, { readonly tx: number; readonly ty: number }>;
  readonly stairs?: readonly StairBlock[];
}): TileGrid {
  const gap = init.gap ?? ROOM_GAP;
  const stride = ROOM_TILES + gap;
  const roomOrigins = init.roomOrigins ?? new Map<RoomId, { readonly tx: number; readonly ty: number }>();
  const cells = new Map<number, RoomId>();
  for (const [id, origin] of roomOrigins) {
    cells.set(cellKeyOf(Math.floor(origin.tx / stride), Math.floor(origin.ty / stride)), id);
  }
  return {
    width: init.width,
    height: init.height,
    level: init.level ?? 0,
    chunks: new Map<number, TileChunk>(),
    cells,
    roomOrigins,
    stairs: init.stairs ?? [],
    gap,
  };
}

/**
 * Writes one tile, allocating its chunk if this is the first thing ever written there.
 *
 * The allocate-on-write is what makes a carve free to reach outside the room that ordered it: a
 * corridor is cut into the gap and a seam is stamped along a shared edge, both of which routinely
 * land in a chunk no room block touched. Resolving the owning chunk per write, rather than handing
 * carves a pre-sized region, is what means a chunk boundary is never a thing anyone has to think
 * about.
 *
 * Omitting `sector` leaves whatever sector the cell already carried, which is what the three passes
 * that re-kind an existing floor tile want — stairs, scenery and {@link setDoorTiles} all change what
 * a tile *is* without changing what ground it stands on.
 */
export function setTile(grid: TileGrid, tx: number, ty: number, kind: number, sector?: number): void {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return;
  const key = chunkKey(tx, ty);
  let chunk = grid.chunks.get(key);
  if (!chunk) {
    chunk = { kinds: new Uint8Array(CHUNK_CELLS), sectors: new Uint8Array(CHUNK_CELLS) };
    grid.chunks.set(key, chunk);
  }
  const offset = chunkOffset(tx, ty);
  chunk.kinds[offset] = kind;
  if (sector !== undefined) chunk.sectors[offset] = sector + 1;
}

export function tileAt(grid: TileGrid, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return Tile.Void;
  const chunk = grid.chunks.get(chunkKey(tx, ty));
  if (!chunk) return Tile.Void;
  return chunk.kinds[chunkOffset(tx, ty)] ?? Tile.Void;
}

/**
 * The same read, from a tile index.
 *
 * Indices are the currency of everything that crosses the wire — `seen` bitsets, the `door` message's
 * changed-tile list, the lit set — so the callers that speak in them should not each have to
 * re-derive `tx` and `ty` and get the division right.
 */
export function tileAtIndex(grid: TileGrid, index: number): number {
  if (index < 0 || index >= grid.width * grid.height) return Tile.Void;
  const tx = index % grid.width;
  return tileAt(grid, tx, (index - tx) / grid.width);
}

/**
 * Which sector's artwork a tile wears, or {@link NO_SECTOR} where nothing was ever laid down.
 *
 * Callers that draw must decide what void looks like rather than being handed `inside` by accident —
 * see {@link NO_SECTOR} for the bug that answer used to cause.
 */
export function sectorAt(grid: TileGrid, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return NO_SECTOR;
  const chunk = grid.chunks.get(chunkKey(tx, ty));
  if (!chunk) return NO_SECTOR;
  const stored = chunk.sectors[chunkOffset(tx, ty)] ?? 0;
  return stored === 0 ? NO_SECTOR : stored - 1;
}

/**
 * Which room a tile-space point belongs to, or -1 in a corridor, a seam or the void.
 *
 * Derived rather than stored: a tile is a room's when it falls inside that room's 9x9 block, and the
 * block's position is the stride times the cell. A corridor, a seam and a corner all fall in the gap
 * and so belong to nobody, which is the answer the dense array gave too — it was only ever written by
 * the room-interior pass.
 */
export function roomAtTile(grid: TileGrid, tx: number, ty: number): RoomId | -1 {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return -1;
  const stride = strideOf(grid);
  const cellX = Math.floor(tx / stride);
  const cellY = Math.floor(ty / stride);
  if (tx - cellX * stride >= ROOM_TILES || ty - cellY * stride >= ROOM_TILES) return -1;
  return grid.cells.get(cellKeyOf(cellX, cellY)) ?? -1;
}

/**
 * Bytes of tile storage this grid has actually allocated.
 *
 * Counted by the structure itself rather than sampled from the process, because `process.memoryUsage`
 * moves with the garbage collector and would make the ceiling a flaky test. It counts the chunk
 * payload and nothing else: `roomOrigins`, `cells` and `stairs` are one entry per room or per vertical
 * exit, so they scale with the *content* of a level and were never the 268.9 MB problem — the dense
 * arrays scaled with its empty bounding box, and those are what this replaced.
 */
export function gridBytes(grid: TileGrid): number {
  let bytes = 0;
  for (const chunk of grid.chunks.values()) bytes += chunk.kinds.byteLength + chunk.sectors.byteLength;
  return bytes;
}

/** Stable sector ordering so the numeric ids in a grid's sectors mean the same thing everywhere. */
export const SECTOR_INDEX: readonly Sector[] = [
  'inside', 'city', 'road', 'field', 'forest', 'hills', 'mountain', 'swamp',
  'desert', 'arctic', 'cave', 'shallow_water', 'deep_water', 'underwater', 'air', 'astral',
];

const SECTOR_TO_INDEX = new Map<Sector, number>(SECTOR_INDEX.map((s, i) => [s, i]));

export function sectorIndex(sector: Sector): number {
  return SECTOR_TO_INDEX.get(sector) ?? 3;
}

/**
 * The sectors that are **open ground** — the ones two neighbouring rooms may merge across.
 *
 * Deliberately not "everything that is not `inside`". A cave, a city street and a building interior
 * all have walls that a doorway is cut through, and a nine-tile-wide hole in a cave wall is not a
 * cave. These six are the ones where the boundary between two rooms is a line on a map and nothing a
 * body could walk into. See {@link connectorSpan}.
 */
const OUTDOOR_SECTORS: ReadonlySet<Sector> = new Set<Sector>([
  'field', 'forest', 'road', 'hills', 'swamp', 'desert',
]);

/**
 * World-pixel centre of a tile. Movement always targets centres, never corners.
 *
 * Here rather than in `sim.ts` because the hunt needs it too, and a second copy of `t * TILE_SIZE +
 * TILE_SIZE / 2` is exactly the kind of duplicate that drifts by half a tile and then makes mobs clip
 * doorframes that players walk through cleanly.
 */
export function tileCentre(t: number): number {
  return t * TILE_SIZE + TILE_SIZE / 2;
}

/** Tile-space centre of a room block — where a character spawns or lands after a transition. */
export function roomCentre(origin: { tx: number; ty: number }): { tx: number; ty: number } {
  const half = (ROOM_TILES - 1) / 2;
  return { tx: origin.tx + half, ty: origin.ty + half };
}

/* -------------------------------------------------------------------------- */
/* Stairs                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Edge of a stair block, in tiles. Odd, so it has a centre tile; small enough to leave floor round it.
 *
 * A single marker tile — which is what this used to be — is invisible at any zoom you actually play
 * at, and vertical travel is the one movement the geometry cannot express: `buildZoneTilemap` carves
 * no corridor for an `up` exit because the far side is a different Place. So the only way to know a
 * room has stairs was to read the exit list. A 3x3 block is a landmark you can see across a room.
 */
export const STAIR_TILES = 3;

/** Top-left offsets a stair block can take inside a room's floor: 7 per axis, 49 in all. */
const STAIR_SLOTS = ROOM_TILES - STAIR_TILES + 1;

export interface StairOffset {
  /** Tiles east of the room block's own origin. */
  readonly dx: number;
  /** Tiles south of it. */
  readonly dy: number;
}

/**
 * One flight of stairs, as the grid remembers it.
 *
 * **`to` is the field that used to be thrown away.** The stamp wrote `Tile.StairsUp` over nine cells
 * and kept nothing else, so a renderer could tell a room had a flight and could not tell where it
 * went — and a real stairwell is a thing joining two rooms, not a texture. Keeping the exit's target
 * here costs one number per vertical exit (9,138 in the whole world) and is what a later milestone
 * builds the geometry of a shaft from.
 */
export interface StairBlock {
  /** The room whose floor this flight is stamped into. */
  readonly room: RoomId;
  readonly dir: 'up' | 'down';
  /** The room at the other end — the exit's `to`. */
  readonly to: RoomId;
  /** Tile-space top-left of the {@link STAIR_TILES}-square block. */
  readonly tx: number;
  readonly ty: number;
}

/**
 * Integer hash, so stair placement is *varied but not random*.
 *
 * The client and the server each build their own grid from the same zone data and must agree tile for
 * tile — a stair block one tile apart on the two sides is terrain the client draws and the server
 * does not. `Math.random()` is therefore not merely discouraged here by the project's determinism
 * rule, it would desync the map. A hash of the room id gives every room a different-looking answer
 * that both sides compute identically, for ever, with nothing to seed or persist.
 *
 * The mix is the standard two-round xorshift-multiply; nothing about it needs to be cryptographic,
 * only well spread across the 49 slots.
 */
function hashStair(roomId: RoomId, salt: number): number {
  let h = (roomId * 2 + salt) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

function slotAt(index: number): StairOffset {
  return { dx: index % STAIR_SLOTS, dy: Math.floor(index / STAIR_SLOTS) % STAIR_SLOTS };
}

/** Whether two blocks at these offsets would share a tile. */
function stairsOverlap(a: StairOffset, b: StairOffset): boolean {
  return Math.abs(a.dx - b.dx) < STAIR_TILES && Math.abs(a.dy - b.dy) < STAIR_TILES;
}

/**
 * Where a room's stairs sit, as offsets inside its floor.
 *
 * Both are decided together because a room with stairs *both* up and down has to put them somewhere
 * they do not overlap, and that is not a choice either block can make on its own. `up` picks freely
 * from all 49 slots; `down` then picks from the slots that clear it, which is never an empty set — a
 * 3x3 block in a 9x9 room always leaves a far corner free.
 *
 * Exported so this is testable and so nothing has to re-derive it: `roomCentre` is still where a
 * character *lands*, and the stairs are deliberately somewhere else most of the time.
 */
export function stairPlacement(
  roomId: RoomId,
  hasUp: boolean,
  hasDown: boolean,
): { readonly up?: StairOffset; readonly down?: StairOffset } {
  const up = hasUp ? slotAt(hashStair(roomId, 0)) : undefined;
  if (!hasDown) return up ? { up } : {};

  const downHash = hashStair(roomId, 1);
  if (!up) return { down: slotAt(downHash) };

  // Every slot that clears the up block, in a fixed order, so the choice is a function of the data.
  const clear: StairOffset[] = [];
  for (let i = 0; i < STAIR_SLOTS * STAIR_SLOTS; i++) {
    const slot = slotAt(i);
    if (!stairsOverlap(up, slot)) clear.push(slot);
  }
  // Cannot be empty for a 3x3 block in a 9x9 room, but a room shape that made it empty would
  // otherwise silently put both flights on the same tiles.
  const down = clear[downHash % clear.length] ?? slotAt(downHash);
  return { up, down };
}

/** The flights a room contributes to the grid, in tile space. Placement is unchanged; only kept. */
function stairBlocksOf(room: Room, origin: { tx: number; ty: number }): StairBlock[] {
  const up = room.exits.up;
  const down = room.exits.down;
  const placement = stairPlacement(room.id, !!up, !!down);
  const out: StairBlock[] = [];
  if (up && placement.up) {
    out.push({
      room: room.id,
      dir: 'up',
      to: up.to,
      tx: origin.tx + placement.up.dx,
      ty: origin.ty + placement.up.dy,
    });
  }
  if (down && placement.down) {
    out.push({
      room: room.id,
      dir: 'down',
      to: down.to,
      tx: origin.tx + placement.down.dx,
      ty: origin.ty + placement.down.dy,
    });
  }
  return out;
}

/**
 * The flight whose block covers this tile, if any.
 *
 * A linear scan of {@link TileGrid.stairs}, which is one entry per vertical exit on the level — 58
 * for the largest level in the shipped world. A caller that wanted this per tile over a whole grid
 * would want an index instead, and should build one rather than making this pretend to be one.
 */
export function stairAt(grid: TileGrid, tx: number, ty: number): StairBlock | undefined {
  for (const stair of grid.stairs) {
    if (tx >= stair.tx && tx < stair.tx + STAIR_TILES && ty >= stair.ty && ty < stair.ty + STAIR_TILES) {
      return stair;
    }
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Scenery                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything standing in a room — what was authored, or what the wilderness grew there.
 *
 * **The one accessor both sides must use.** The server stamps footprints out of this and the client
 * draws sprites from it; if either read `room.scenery` directly it would see the authored list and
 * miss the scatter, and the two would disagree about which tiles are solid — a player walking
 * through a bush the server says is there, which is the exact desync the whole "a prop is a rule"
 * argument exists to prevent.
 */
export function sceneryOf(room: Room): readonly RoomScenery[] {
  return scatterFor(room.id, room.sector, room.scenery);
}

/**
 * The tile a prop's footprint becomes — V8d.
 *
 * {@link Tile.Prop} for the ordinary case and {@link Tile.Blocker} for the opaque one, which is the
 * only difference between them: both stop movement, and only `Blocker` stops sight.
 */
export function sceneryTile(kind: SceneryKind): number {
  return SCENERY[kind].opaque ? Tile.Blocker : Tile.Prop;
}

/**
 * Why a room's props cannot stand where they were put, or `undefined` if they can.
 *
 * Called by the worldgen validator so a bad placement is a build failure with a sentence attached,
 * rather than a prop that quietly loses the tiles it could not have. Three things can be wrong, and
 * the third is the one nobody can see coming:
 *
 * 1. The footprint leaves the room. Rooms are {@link ROOM_TILES} square and props do not spill into
 *    the gap, because the gap is where doors and seams live.
 * 2. Two props overlap.
 * 3. **The footprint lands on a staircase.** Stairs are stamped inside the room block at an offset
 *    derived from the room id ({@link stairPlacement}), so they are invisible to anyone reading the
 *    room's JSON — an author has no way to know a flight is at 4,4 without asking. This asks.
 *
 * What it deliberately does *not* check is whether a prop walls a room in half. That is real, and
 * it is already caught: the seamless world's law is that a flood-fill of the rendered tiles equals
 * a walk of the room graph, and `seamless.test.ts` asserts it over every open-rendered zone. A
 * fountain across a doorway fails that test, which is the test doing its job.
 */
export function scenerySiting(room: Room): string | undefined {
  const props = room.scenery ?? [];
  if (props.length === 0) return undefined;

  const stairs = stairPlacement(room.id, !!room.exits.up, !!room.exits.down);
  const stairCells = new Set<number>();
  for (const offset of [stairs.up, stairs.down]) {
    if (!offset) continue;
    for (let dy = 0; dy < STAIR_TILES; dy++) {
      for (let dx = 0; dx < STAIR_TILES; dx++) {
        stairCells.add((offset.dy + dy) * ROOM_TILES + offset.dx + dx);
      }
    }
  }

  const taken = new Map<number, SceneryKind>();
  for (const prop of props) {
    const spec = SCENERY[prop.kind];
    if (!spec) return `unknown scenery kind "${prop.kind}"`;

    if (!Number.isInteger(prop.tx) || !Number.isInteger(prop.ty)) {
      return `${prop.kind} at ${prop.tx},${prop.ty} is not on a whole tile`;
    }
    if (
      prop.tx < 0 ||
      prop.ty < 0 ||
      prop.tx + spec.width > ROOM_TILES ||
      prop.ty + spec.depth > ROOM_TILES
    ) {
      return (
        `${prop.kind} at ${prop.tx},${prop.ty} is ${spec.width}x${spec.depth} and does not fit ` +
        `inside a ${ROOM_TILES}x${ROOM_TILES} room`
      );
    }

    for (let dy = 0; dy < spec.depth; dy++) {
      for (let dx = 0; dx < spec.width; dx++) {
        const cell = (prop.ty + dy) * ROOM_TILES + prop.tx + dx;
        const other = taken.get(cell);
        if (other) return `${prop.kind} at ${prop.tx},${prop.ty} overlaps ${other}`;
        if (stairCells.has(cell)) {
          return `${prop.kind} at ${prop.tx},${prop.ty} stands on this room's staircase`;
        }
        taken.set(cell, prop.kind);
      }
    }
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Building a grid                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Builds the tile grid for one Z level of a zone.
 *
 * The grid spans the rooms on that level and nothing more, so its coordinates belong to that Place
 * alone. Nothing may be positioned against a grid built for a different level.
 *
 * Only exits that are geometric neighbours on the same level are carved. Portals and vertical links
 * are not corridors — they are handled as transitions, and appear as stair tiles instead.
 */
export function buildZoneTilemap(zone: Zone, level = 0): TileGrid {
  const rooms = zone.rooms.filter((r) => r.pos.z === level);
  const seamless = zone.seamless === true;
  const gap = seamless ? SEAM_GAP : ROOM_GAP;
  const stride = ROOM_TILES + gap;

  // Sized to the rooms on *this* level, not to `zone.bounds` — which is the union over every level
  // and so describes a Place that does not exist. Zone 260's four-room ground level shares its
  // bounds with the 90-room level above it, and sizing from the union gave it a 156x180 grid that
  // was 2.5% occupied: a 4992x5760 render texture on the client (over `GL_MAX_TEXTURE_SIZE` on any
  // GPU capped at 4096), and a zoom-to-fit that framed almost entirely void.
  //
  // Only non-portal exits between geometric neighbours are carved, so every corridor lies between
  // two cells that are themselves on this level — tightening the bounds cannot push one off-grid.
  //
  // The width and height are still the *bounding box*, and deliberately: they are the coordinate
  // space the `seen` bitsets and every tile index on the wire are expressed in. What the sparse
  // chunks changed is that nothing is allocated for the empty parts of it.
  const bounds = boundsOf(rooms);
  const cellsWide = bounds.maxX - bounds.minX + 1;
  const cellsHigh = bounds.maxY - bounds.minY + 1;
  const width = cellsWide * stride;
  const height = cellsHigh * stride;

  const roomOrigins = new Map<RoomId, { tx: number; ty: number }>();
  const stairs: StairBlock[] = [];
  const byId = new Map<RoomId, Room>();
  for (const room of rooms) {
    const origin = {
      tx: (room.pos.x - bounds.minX) * stride,
      ty: (room.pos.y - bounds.minY) * stride,
    };
    roomOrigins.set(room.id, origin);
    byId.set(room.id, room);
    // Both flights decided together — see `stairPlacement` for why they cannot be decided separately.
    stairs.push(...stairBlocksOf(room, origin));
  }

  const grid = createTileGrid({ width, height, level, gap, roomOrigins, stairs });

  // Room interiors.
  for (const room of rooms) {
    const origin = roomOrigins.get(room.id)!;
    const sector = sectorIndex(room.sector);
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        setTile(grid, origin.tx + dx, origin.ty + dy, Tile.Floor, sector);
      }
    }
  }

  // Stairs, over the floor they stand on. Stamped inside the room block, which `carve` never writes
  // into (its cells are all in the gap), so the two passes cannot fight over a tile whatever order
  // the rooms come in.
  for (const stair of stairs) {
    const kind = stair.dir === 'up' ? Tile.StairsUp : Tile.StairsDown;
    for (let dy = 0; dy < STAIR_TILES; dy++) {
      for (let dx = 0; dx < STAIR_TILES; dx++) setTile(grid, stair.tx + dx, stair.ty + dy, kind);
    }
  }

  // Connectors.
  for (const room of rooms) {
    const origin = roomOrigins.get(room.id)!;
    const sector = sectorIndex(room.sector);

    for (const [dir, exit] of Object.entries(room.exits) as [Direction, Room['exits'][Direction]][]) {
      if (!exit) continue;
      // Vertical links are stairs, handled above.
      if (dir === 'up' || dir === 'down') continue;

      // Portals and links whose far side is not on this level get no corridor; they are
      // transitions, not geometry.
      if (exit.portal) continue;
      const target = byId.get(exit.to);
      if (!target) continue;

      // A seamless zone's horizontal edges are stamped as *pairs* below, not carved per side —
      // carving would fight the full-edge fill through CARVE_RANK (floor beats door, so a doorway
      // whose far side opened first would dissolve into plaza).
      if (seamless) continue;

      const delta = DIRECTION_DELTA[dir];
      const kind = exit.door ? doorTile(exit.door) : Tile.Connector;
      carve(grid, origin, delta[0], delta[1], kind, sector, connectorSpan(room, target, dir));
    }
  }

  if (seamless) stampSeams(rooms, roomOrigins, grid);

  // Scenery last, and only over plain floor — V8d. A prop is authored as a room-relative offset and
  // so cannot reach the gap where doors and seams live, but it *can* be written over a staircase,
  // which is stamped inside the room block at an offset nobody reading the room's JSON can see. The
  // `Floor` test is the guard: a prop never eats a stair, a door or a connector, whatever it was
  // told to do. Authoring is stopped from getting there at all by `scenerySiting`, which the
  // worldgen validator runs and which knows where the flights are.
  for (const room of rooms) {
    const standing = sceneryOf(room);
    if (standing.length === 0) continue;
    const origin = roomOrigins.get(room.id)!;
    for (const prop of standing) {
      const spec = SCENERY[prop.kind];
      if (!spec) continue;
      const kind = sceneryTile(prop.kind);
      for (let dy = 0; dy < spec.depth; dy++) {
        for (let dx = 0; dx < spec.width; dx++) {
          const tx = origin.tx + prop.tx + dx;
          const ty = origin.ty + prop.ty + dy;
          if (tileAt(grid, tx, ty) !== Tile.Floor) continue;
          setTile(grid, tx, ty, kind);
        }
      }
    }
  }

  return grid;
}

/**
 * How wide the opening between two linked rooms is cut — M0's one deliberate change to what the world
 * looks like.
 *
 * Every link used to be a {@link CONNECTOR_WIDTH} neck, so the world was a lattice of nine-tile
 * squares joined by three-tile corridors repeating on a hard twelve-tile beat, with two to four of
 * those beats on screen at any time. That is right for a building and wrong for a field: two adjacent
 * meadows do not meet through a doorway. **When both rooms are {@link OUTDOOR_SECTORS} the whole
 * shared edge is carved**, so adjacent outdoor rooms merge into one continuous walkable ground and the
 * lattice disappears for the biomes that were most obviously hurt by it.
 *
 * Two exceptions, and both are load-bearing:
 *
 * 1. **A door keeps its width, from either side.** A nine-tile-wide doorway is not a door, and the
 *    check reads *both* exits because 5 links in the shipped world have a door on one side and a
 *    plain exit facing it back. Widening the plain side would leave the door standing in the middle
 *    of an opening you could walk round, which is worse than either answer on its own —
 *    {@link CARVE_RANK} resolves the *kind* of a contested cell and can do nothing about a cell the
 *    other side never contested.
 * 2. **Seamless zones never reach here.** Their borders are stamped as pairs by {@link stampSeams},
 *    which already fills an open edge completely.
 *
 * Symmetric in its two rooms, so the two sides of a two-way exit carve the same strip and the result
 * does not depend on the order the zone data lists rooms in.
 *
 * The design cost, stated plainly because it is a choice and not a fix: outdoor room-to-room movement
 * loses its pinch point. The room is still the unit of interest management and of prose, and
 * `stepRoom` still enforces one-way exits on the typed command, so nothing about MUD semantics moves.
 */
function connectorSpan(from: Room, to: Room, dir: Direction): number {
  if (from.exits[dir]?.door) return CONNECTOR_WIDTH;
  const back = to.exits[OPPOSITE[dir]];
  if (back && !back.portal && back.to === from.id && back.door) return CONNECTOR_WIDTH;
  if (!OUTDOOR_SECTORS.has(from.sector) || !OUTDOOR_SECTORS.has(to.sector)) return CONNECTOR_WIDTH;
  return ROOM_TILES;
}

/**
 * The seamless projection's seams — V8a, DESIGN-open-world.md §3.
 *
 * Every pair of adjacent rooms is decided **once**, from both exits together, and stamps exactly one
 * of three seam shapes: an exit with no door fills the whole shared edge with floor, so the two
 * rooms read as one continuous ground; an exit with a door narrows to a {@link CONNECTOR_WIDTH}
 * gate — placed on the same cells `doorwayTiles` derives at run time, which is the invariant that
 * lets the door open and shut — with the rest of the seam left solid as the wall the door lives in;
 * and no exit leaves the whole seam solid, the void doing quietly what a tree line or a house wall
 * will do in paint once V8b dresses it. Seam tiles belong to no room, exactly as corridors always
 * have: you are in the room you left until you stand somewhere real.
 *
 * The corner cells where four blocks meet belong to no pair, so they get their own rule: floor only
 * when all four rooms exist and all four seams around the corner are open floor — an open plaza's
 * centre pillar would be a hole in the claim that this is one ground — and solid otherwise, which
 * at a walled building's corner is its corner post.
 */
function stampSeams(
  rooms: readonly Room[],
  roomOrigins: ReadonlyMap<RoomId, { tx: number; ty: number }>,
  grid: TileGrid,
): void {
  const at = new Map<string, Room>();
  for (const room of rooms) at.set(`${room.pos.x},${room.pos.y}`, room);

  /** The open seam between a pair leans on the outdoor side's ground; `inside` never spills out. */
  const seamSector = (a: Room, b: Room): number =>
    sectorIndex(a.sector === 'inside' ? b.sector : a.sector);

  // Right-hand and downward neighbours only: every adjacent pair exactly once.
  const openSeams = new Set<string>();
  for (const room of rooms) {
    const origin = roomOrigins.get(room.id)!;
    for (const [dir, dx, dy] of [
      ['east', 1, 0],
      ['south', 0, 1],
    ] as const) {
      const neighbour = at.get(`${room.pos.x + dx},${room.pos.y + dy}`);
      if (!neighbour) continue;
      const out = room.exits[dir];
      const back = neighbour.exits[OPPOSITE[dir]];
      const exit = out && !out.portal && out.to === neighbour.id ? out : undefined;
      const ret = back && !back.portal && back.to === room.id ? back : undefined;
      const door = exit?.door ?? ret?.door;
      const open = (exit ?? ret) !== undefined;

      const cells: { tx: number; ty: number }[] = [];
      for (let span = 0; span < ROOM_TILES; span++) {
        cells.push(
          dx === 1
            ? { tx: origin.tx + ROOM_TILES, ty: origin.ty + span }
            : { tx: origin.tx + span, ty: origin.ty + ROOM_TILES },
        );
      }

      if (!open) {
        // **V8b: the blocked seam gets something in it.** The tiles were already solid — void
        // refuses passage as firmly as a wall does — so this changes nothing about the law and
        // everything about the world: a border with no exit is a house wall, a hedge, a tree line
        // or a run of water, and now it is *drawn* as one. The sector is carried on the tile so
        // the client can choose which; the seam takes the **indoor** side's sector when there is
        // one, because a building's outside wall belongs to the building.
        const wall = sectorIndex(room.sector === 'inside' ? room.sector : neighbour.sector);
        for (const { tx, ty } of cells) setTile(grid, tx, ty, Tile.Blocker, wall);
        continue;
      }
      const sector = seamSector(room, neighbour);
      if (door) {
        // **The wall first, then the gate in it** — V8b's correction to V8a. V8a stamped only the
        // gate and left the rest of the seam as void: solid, and invisible, so a doorway in a
        // building read as a door floating in a gap. The wall is laid across the whole shared edge
        // and the gate stamped over its middle, which is what a door in a wall actually is.
        const wall = sectorIndex(room.sector === 'inside' ? room.sector : neighbour.sector);
        for (const { tx, ty } of cells) setTile(grid, tx, ty, Tile.Blocker, wall);
        for (const { tx, ty } of connectorCells(origin, dx, dy, SEAM_GAP)) {
          setTile(grid, tx, ty, doorTile(door), sector);
        }
      } else {
        for (const { tx, ty } of cells) setTile(grid, tx, ty, Tile.Floor, sector);
        openSeams.add(`${room.pos.x},${room.pos.y},${dir}`);
      }
    }
  }

  // Corners, after every seam has declared itself.
  for (const room of rooms) {
    const { x, y } = room.pos;
    const quad = [at.get(`${x},${y}`), at.get(`${x + 1},${y}`), at.get(`${x},${y + 1}`), at.get(`${x + 1},${y + 1}`)];
    if (quad.some((r) => r === undefined)) continue;
    const allOpen =
      openSeams.has(`${x},${y},east`) &&
      openSeams.has(`${x},${y},south`) &&
      openSeams.has(`${x + 1},${y},south`) &&
      openSeams.has(`${x},${y + 1},east`);
    const origin = roomOrigins.get(room.id)!;
    // V8b: a corner where any seam is shut is the post the walls meet at, and it is drawn rather
    // than left as a hole. Only a corner with open floor on all four sides stays plaza.
    if (!allOpen) {
      setTile(grid, origin.tx + ROOM_TILES, origin.ty + ROOM_TILES, Tile.Blocker, sectorIndex(quad[0]!.sector));
      continue;
    }
    setTile(grid, origin.tx + ROOM_TILES, origin.ty + ROOM_TILES, Tile.Floor, seamSector(quad[0]!, quad[1]!));
  }
}

/**
 * The gap cells the opening between a room block and its neighbour occupies, in tile space.
 *
 * Shared by the build-time carve and the live {@link setDoorTiles} so a door that opens flips exactly
 * the cells it was carved into. Two functions deriving the same strip separately is the shape of bug
 * this file exists to avoid — the server would open six tiles and a client seven, and the seventh
 * would be a tile the client walks through and the server does not.
 *
 * `span` is the width of the opening across the shared edge, centred on it: {@link CONNECTOR_WIDTH}
 * for a doorway and {@link ROOM_TILES} for two outdoor rooms that merge. Doors are always the former,
 * which is why {@link doorwayTiles} takes the default and must keep taking it.
 *
 * Vertical links have a zero horizontal delta and occupy no gap at all; they get a stair block inside
 * the room instead, so this yields nothing for them.
 */
function connectorCells(
  origin: { tx: number; ty: number },
  dx: number,
  dy: number,
  gap = ROOM_GAP,
  span = CONNECTOR_WIDTH,
): { tx: number; ty: number }[] {
  if (dx === 0 && dy === 0) return [];
  const offset = (ROOM_TILES - span) / 2;
  const cells: { tx: number; ty: number }[] = [];

  for (let step = 0; step < gap; step++) {
    for (let across = 0; across < span; across++) {
      if (dx !== 0) {
        cells.push({
          tx: dx > 0 ? origin.tx + ROOM_TILES + step : origin.tx - 1 - step,
          ty: origin.ty + offset + across,
        });
      } else {
        cells.push({
          tx: origin.tx + offset + across,
          ty: dy > 0 ? origin.ty + ROOM_TILES + step : origin.ty - 1 - step,
        });
      }
    }
  }
  return cells;
}

/**
 * Which of two kinds survives when both sides of an exit carve the same strip.
 *
 * Both sides of a two-way exit carve *the same cells*, so without an ordering rule the result is
 * whichever room the zone data happened to list second. That was harmless while every carved kind was
 * equally walkable; it stops being harmless the moment one of them is a wall.
 *
 * Floor is never downgraded, then a shut door beats an open one, then either beats a plain connector.
 * Both halves earn their place on the shipped world: 5 door exits have a *plain* exit facing them
 * back, so without door-beats-connector those doorways would be a door from one room and an open
 * corridor from the other; and closed-beats-open means any future disagreement about a door's state
 * fails shut rather than opening a passage one side believes is barred.
 */
const CARVE_RANK: Readonly<Record<number, number>> = {
  [Tile.Floor]: 4,
  [Tile.Door]: 3,
  [Tile.DoorOpen]: 2,
  [Tile.Connector]: 1,
  [Tile.StairsUp]: 4,
  [Tile.StairsDown]: 4,
  // Above void, below everything walkable: a blocker may be painted over emptiness, and any real
  // passage — a corridor, a door, a floor — beats a wall that two sectors merely implied.
  [Tile.Blocker]: 0.5,
  [Tile.Void]: 0,
};

/**
 * Cuts the opening between a room block and its neighbour across the gap.
 *
 * Idempotent, and order-independent between the two sides of an exit — see {@link CARVE_RANK}.
 */
function carve(
  grid: TileGrid,
  origin: { tx: number; ty: number },
  dx: number,
  dy: number,
  kind: number,
  sector: number,
  span: number,
): void {
  for (const { tx, ty } of connectorCells(origin, dx, dy, ROOM_GAP, span)) {
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) continue;
    if ((CARVE_RANK[tileAt(grid, tx, ty)] ?? 0) >= (CARVE_RANK[kind] ?? 0)) continue;
    setTile(grid, tx, ty, kind, sector);
  }
}

/**
 * Opens or shuts a doorway already carved into a grid, in place.
 *
 * Returns the tile indices it changed, which is exactly what a client needs to repaint and what makes
 * a no-op call free. **The one mutation both the server and the client run**, for the same reason
 * `stepMovement` is one function: the server decides a door is open, and every client has to reach
 * bit-identical geometry from that fact or its prediction walks through a tile the server refuses.
 *
 * It will only ever rewrite a cell that already holds a door, so it cannot carve a passage through
 * void, overwrite a room's floor, or turn a plain corridor into a door however wrong its arguments
 * are. Calling it for both sides of a two-way door is therefore safe and the second call is free —
 * they name the same cells.
 */
export function setDoorTiles(
  grid: TileGrid,
  roomId: RoomId,
  dir: Direction,
  closed: boolean,
): number[] {
  const kind = closed ? Tile.Door : Tile.DoorOpen;
  const changed: number[] = [];
  for (const index of doorwayTiles(grid, roomId, dir)) {
    const tx = index % grid.width;
    const ty = (index - tx) / grid.width;
    if (tileAt(grid, tx, ty) === kind) continue;
    setTile(grid, tx, ty, kind);
    changed.push(index);
  }
  return changed;
}

/**
 * The tiles the doorway leading `dir` out of `roomId` occupies, in whichever state it stands.
 *
 * Empty when that exit has no door carved on this grid — a portal, a staircase, a plain corridor, or
 * a room that is not on this level at all. Callers therefore get "no doorway here" and "a doorway
 * with no tiles" as the same answer, which is what both of them mean in practice.
 */
export function doorwayTiles(grid: TileGrid, roomId: RoomId, dir: Direction): number[] {
  const origin = grid.roomOrigins.get(roomId);
  if (!origin) return [];
  const [dx, dy] = DIRECTION_DELTA[dir];

  const found: number[] = [];
  for (const { tx, ty } of connectorCells(origin, dx, dy, grid.gap)) {
    if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) continue;
    if (isDoorTile(tileAt(grid, tx, ty))) found.push(ty * grid.width + tx);
  }
  return found;
}

/** Walkability at a world-pixel position, used by both the server and client predictor. */
export function isWalkableAt(grid: TileGrid, px: number, py: number): boolean {
  return isWalkable(tileAt(grid, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)));
}

/* -------------------------------------------------------------------------- */
/* Movement                                                                    */
/* -------------------------------------------------------------------------- */

/** Pixels per second on foot. Roughly one nine-tile room every two seconds. */
export const PLAYER_SPEED = 150;

/** Half-extent of a character's collision box, in pixels. */
export const PLAYER_RADIUS = 10;

/** Whether a character's whole collision box clears the walls at this position. */
export function canStand(grid: TileGrid, x: number, y: number): boolean {
  const r = PLAYER_RADIUS;
  return (
    isWalkableAt(grid, x - r, y - r) &&
    isWalkableAt(grid, x + r, y - r) &&
    isWalkableAt(grid, x - r, y + r) &&
    isWalkableAt(grid, x + r, y + r)
  );
}

/**
 * Advances a character by `distance` along a normalised intent, resolving collisions.
 *
 * **The server and the client predictor must both call this.** Client-side prediction is only
 * correct if both sides compute movement identically; keeping one implementation here makes drift
 * impossible by construction rather than by discipline.
 *
 * Axes are resolved separately so a character slides along a wall instead of sticking to it.
 */
export function stepMovement(
  grid: TileGrid,
  x: number,
  y: number,
  intentX: number,
  intentY: number,
  distance: number,
): { x: number; y: number } {
  let nx = x;
  let ny = y;

  const tryX = nx + intentX * distance;
  if (canStand(grid, tryX, ny)) nx = tryX;

  const tryY = ny + intentY * distance;
  if (canStand(grid, nx, tryY)) ny = tryY;

  return { x: nx, y: ny };
}

/**
 * Normalises a raw input vector so no client can request extra speed by sending a long one.
 *
 * The finiteness test is not defensive tidying, it is the difference between a wedged character and
 * a working one. Steering arrives straight off the wire, so `{t:'steer'}` with the fields missing —
 * or holding a string — reaches here as `NaN`, and `NaN < 0.01` is *false*, so a bare magnitude test
 * lets it straight through. Downstream, `NaN !== 0` reads as a real push: it cancels any active
 * route, and the simulation's idle skip (`!path && intentX === 0`) stops firing, so that character is
 * walked every tick forever while `stepMovement` refuses to move them a pixel. Treating it as a key
 * release costs one comparison and removes the state entirely. `Infinity` is rejected for the same
 * reason by the same test — it survives `hypot` and only turns into `NaN` at the division.
 */
export function normaliseIntent(dx: number, dy: number): { x: number; y: number } {
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length < 0.01) return { x: 0, y: 0 };
  return { x: dx / length, y: dy / length };
}

/**
 * Where a body lands when it enters a room **travelling in a direction**.
 *
 * Owner's report (2026-08-03): *"they shouldn't just flee to the center of a room, as that means they
 * can hide behind someone else who might be standing there."* Every arrival used {@link roomCentre} —
 * flee, walking a room, teleporting, respawning — so every body that changed room stacked on one tile
 * and the one underneath was unclickable.
 *
 * You arrive at the **far side from the way you were going**: walk north and you come in at the
 * southern edge, having just stepped through that wall. That is the position the fiction already
 * implies, and it fixes three things at once — bodies stop stacking, a doorway reads as a doorway
 * instead of a teleport to the middle of the floor, and the walk across the room afterwards is the
 * player's own rather than a jump.
 *
 * ## The lateral offset is derived, not rolled
 *
 * Two things arriving from the same direction still need to not occupy the same tile, and `CLAUDE.md`
 * rule 3 forbids `Math.random()` in simulation code. `spread` is therefore any stable number the caller
 * already has — an entity id — folded across the room's width. Deterministic, so a restart reproduces
 * the world, and no `Rng` has to be threaded through every caller of `relocate` to place a body.
 *
 * `undefined` for `from` means there is no direction to speak of — a teleport, a respawn, a portal —
 * and those keep the centre, which is the honest answer when nothing was walked through.
 */
export function arrivalTile(
  origin: { tx: number; ty: number },
  from: 'north' | 'east' | 'south' | 'west' | undefined,
  spread = 0,
): { tx: number; ty: number } {
  const centre = roomCentre(origin);
  if (!from) return centre;

  // One tile in from the wall, so a body never lands *on* the boundary the collision box has to clear.
  const near = 1;
  const far = ROOM_TILES - 2;
  // Across the room's width, skipping the two edge tiles for the same reason.
  const lateral = origin.tx + 1 + (((spread % (ROOM_TILES - 2)) + (ROOM_TILES - 2)) % (ROOM_TILES - 2));
  const lateralY = origin.ty + 1 + (((spread % (ROOM_TILES - 2)) + (ROOM_TILES - 2)) % (ROOM_TILES - 2));

  switch (from) {
    // Heading north means arriving at the southern edge — you came through that wall.
    case 'north': return { tx: lateral, ty: origin.ty + far };
    case 'south': return { tx: lateral, ty: origin.ty + near };
    case 'east': return { tx: origin.tx + near, ty: lateralY };
    case 'west': return { tx: origin.tx + far, ty: lateralY };
  }
}
