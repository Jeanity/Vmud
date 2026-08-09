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
 */

import {
  DIRECTION_DELTA,
  boundsOf,
  type Direction,
  type Door,
  type Room,
  type RoomId,
  type Sector,
  type Zone,
} from './world.ts';

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

/** Width of the opening carved between two linked rooms. Odd, to centre on the room. */
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
  return tile !== Tile.Void && tile !== Tile.Door;
}

/** Either state of a doorway, for code that cares that a tile *is* a door rather than how it stands. */
export function isDoorTile(tile: number): boolean {
  return tile === Tile.Door || tile === Tile.DoorOpen;
}

/** The tile kind a door in this state carves. */
function doorTile(door: Door): number {
  return door.closed ? Tile.Door : Tile.DoorOpen;
}

export interface TileGrid {
  readonly width: number;
  readonly height: number;
  readonly level: number;
  /** `Tile` value per cell, row-major. */
  readonly tiles: Uint8Array;
  /** Sector index per cell, for choosing artwork. Void cells carry the sector of no room. */
  readonly sectors: Uint8Array;
  /** Owning room id per cell, or -1. Drives "which room am I in" without a spatial query. */
  readonly rooms: Int32Array;
  /** Tile-space origin of each room block on this level. */
  readonly roomOrigins: ReadonlyMap<RoomId, { readonly tx: number; readonly ty: number }>;
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

/** Stable sector ordering so the numeric ids in `TileGrid.sectors` mean the same thing everywhere. */
export const SECTOR_INDEX: readonly Sector[] = [
  'inside', 'city', 'road', 'field', 'forest', 'hills', 'mountain', 'swamp',
  'desert', 'arctic', 'cave', 'shallow_water', 'deep_water', 'underwater', 'air', 'astral',
];

const SECTOR_TO_INDEX = new Map<Sector, number>(SECTOR_INDEX.map((s, i) => [s, i]));

export function sectorIndex(sector: Sector): number {
  return SECTOR_TO_INDEX.get(sector) ?? 3;
}

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
  const bounds = boundsOf(rooms);
  const cellsWide = bounds.maxX - bounds.minX + 1;
  const cellsHigh = bounds.maxY - bounds.minY + 1;
  const width = cellsWide * stride;
  const height = cellsHigh * stride;

  const tiles = new Uint8Array(width * height);
  const sectors = new Uint8Array(width * height);
  const roomsAt = new Int32Array(width * height).fill(-1);
  const roomOrigins = new Map<RoomId, { tx: number; ty: number }>();

  const originOf = (room: Room) => ({
    tx: (room.pos.x - bounds.minX) * stride,
    ty: (room.pos.y - bounds.minY) * stride,
  });

  const byId = new Map<RoomId, Room>();
  for (const room of rooms) byId.set(room.id, room);

  // Room interiors.
  for (const room of rooms) {
    const origin = originOf(room);
    roomOrigins.set(room.id, origin);
    const sector = sectorIndex(room.sector);
    for (let dy = 0; dy < ROOM_TILES; dy++) {
      for (let dx = 0; dx < ROOM_TILES; dx++) {
        const index = (origin.ty + dy) * width + origin.tx + dx;
        tiles[index] = Tile.Floor;
        sectors[index] = sector;
        roomsAt[index] = room.id;
      }
    }
  }

  // Connectors, and stairs for vertical links.
  for (const room of rooms) {
    const origin = roomOrigins.get(room.id)!;
    const sector = sectorIndex(room.sector);

    // Vertical exits, both at once — see `stairPlacement` for why they cannot be decided separately.
    // Stamped inside the room block, which `carve` never writes into (its cells are all in the gap),
    // so the two passes cannot fight over a tile whatever order the rooms come in.
    const stairs = stairPlacement(room.id, !!room.exits.up, !!room.exits.down);
    for (const [offset, kind] of [
      [stairs.up, Tile.StairsUp],
      [stairs.down, Tile.StairsDown],
    ] as const) {
      if (!offset) continue;
      for (let dy = 0; dy < STAIR_TILES; dy++) {
        for (let dx = 0; dx < STAIR_TILES; dx++) {
          tiles[(origin.ty + offset.dy + dy) * width + origin.tx + offset.dx + dx] = kind;
        }
      }
    }

    for (const [dir, exit] of Object.entries(room.exits) as [Direction, Room['exits'][Direction]][]) {
      if (!exit) continue;
      // Handled above, together.
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
      carve(tiles, sectors, width, height, origin, delta[0], delta[1], kind, sector);
    }
  }

  if (seamless) stampSeams(rooms, roomOrigins, tiles, sectors, width, height);

  return { width, height, level, tiles, sectors, rooms: roomsAt, roomOrigins, gap };
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
 * will do in paint once V8b dresses it. Seam tiles belong to no room (`-1`), exactly as corridors
 * always have: you are in the room you left until you stand somewhere real.
 *
 * The corner cells where four blocks meet belong to no pair, so they get their own rule: floor only
 * when all four rooms exist and all four seams around the corner are open floor — an open plaza's
 * centre pillar would be a hole in the claim that this is one ground — and solid otherwise, which
 * at a walled building's corner is its corner post.
 */
function stampSeams(
  rooms: readonly Room[],
  roomOrigins: ReadonlyMap<RoomId, { tx: number; ty: number }>,
  tiles: Uint8Array,
  sectors: Uint8Array,
  width: number,
  height: number,
): void {
  const at = new Map<string, Room>();
  for (const room of rooms) at.set(`${room.pos.x},${room.pos.y}`, room);
  const stamp = (tx: number, ty: number, kind: number, sector: number): void => {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) return;
    const index = ty * width + tx;
    tiles[index] = kind;
    sectors[index] = sector;
  };

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
      const back = neighbour.exits[REVERSE_DIR[dir]];
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

      if (!open) continue; // the seam is already solid — the blocker V8b will dress
      const sector = seamSector(room, neighbour);
      if (door) {
        // The gate on the derived cells; the rest of the seam stays wall.
        for (const { tx, ty } of connectorCells(origin, dx, dy, SEAM_GAP)) {
          stamp(tx, ty, doorTile(door), sector);
        }
      } else {
        for (const { tx, ty } of cells) stamp(tx, ty, Tile.Floor, sector);
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
    if (!allOpen) continue;
    const origin = roomOrigins.get(room.id)!;
    stamp(origin.tx + ROOM_TILES, origin.ty + ROOM_TILES, Tile.Floor, seamSector(quad[0]!, quad[1]!));
  }
}

const REVERSE_DIR: Readonly<Record<'east' | 'south', Direction>> = { east: 'west', south: 'north' };

/**
 * The gap cells the opening between a room block and its neighbour occupies, in tile space.
 *
 * Shared by the build-time carve and the live {@link setDoorTiles} so a door that opens flips exactly
 * the cells it was carved into. Two functions deriving the same strip separately is the shape of bug
 * this file exists to avoid — the server would open six tiles and a client seven, and the seventh
 * would be a tile the client walks through and the server does not.
 *
 * Vertical links have a zero horizontal delta and occupy no gap at all; they get a stair marker on
 * the room's centre tile instead, so this yields nothing for them.
 */
function connectorCells(
  origin: { tx: number; ty: number },
  dx: number,
  dy: number,
  gap = ROOM_GAP,
): { tx: number; ty: number }[] {
  if (dx === 0 && dy === 0) return [];
  const offset = (ROOM_TILES - CONNECTOR_WIDTH) / 2;
  const cells: { tx: number; ty: number }[] = [];

  for (let step = 0; step < gap; step++) {
    for (let span = 0; span < CONNECTOR_WIDTH; span++) {
      if (dx !== 0) {
        cells.push({
          tx: dx > 0 ? origin.tx + ROOM_TILES + step : origin.tx - 1 - step,
          ty: origin.ty + offset + span,
        });
      } else {
        cells.push({
          tx: origin.tx + offset + span,
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
  [Tile.Void]: 0,
};

/**
 * Cuts the opening between a room block and its neighbour across the gap.
 *
 * Idempotent, and order-independent between the two sides of an exit — see {@link CARVE_RANK}.
 */
function carve(
  tiles: Uint8Array,
  sectors: Uint8Array,
  width: number,
  height: number,
  origin: { tx: number; ty: number },
  dx: number,
  dy: number,
  kind: number,
  sector: number,
): void {
  for (const { tx, ty } of connectorCells(origin, dx, dy)) {
    if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
    const index = ty * width + tx;
    if ((CARVE_RANK[tiles[index] ?? Tile.Void] ?? 0) >= (CARVE_RANK[kind] ?? 0)) continue;
    tiles[index] = kind;
    sectors[index] = sector;
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
    if (grid.tiles[index] === kind) continue;
    grid.tiles[index] = kind;
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
    const index = ty * grid.width + tx;
    if (isDoorTile(grid.tiles[index] ?? Tile.Void)) found.push(index);
  }
  return found;
}

/** Which room a tile-space point belongs to, or -1 in a corridor or the void. */
export function roomAtTile(grid: TileGrid, tx: number, ty: number): RoomId | -1 {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return -1;
  return grid.rooms[ty * grid.width + tx] ?? -1;
}

export function tileAt(grid: TileGrid, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height) return Tile.Void;
  return grid.tiles[ty * grid.width + tx] ?? Tile.Void;
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
