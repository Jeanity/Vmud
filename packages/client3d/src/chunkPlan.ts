/**
 * One room's scene, as a list of boxes — the whole of M3's geometry, and deliberately not a
 * `three` import in sight.
 *
 * `describeRoom` says *what closes this room in on each side*; this file says *where the box goes*.
 * Keeping the second half pure is worth as much as keeping the first half pure was: a `Placement` is
 * eight numbers and two strings, so the 1,000-room traversal test can build every room in the world
 * and count what it allocated without a GPU, a canvas or a `WebGLRenderer` anywhere in the process.
 * `world3d.ts` is the only file that turns these into matrices.
 *
 * ## The one rule that generates almost everything
 *
 * **The parts of a room's nine-metre boundary that no mouth crosses are solid.** That is not a
 * rendering convention, it is what `buildZoneTilemap` already did and this file reads back: a
 * three-tile connector between two indoor rooms leaves three metres carved and six metres of void,
 * and void is as impassable as a wall. So every side gets the same treatment —
 *
 * - `mouth.span === 0` (an `edge`, a `barrier`, a `portal`): one wall the width of the side.
 * - `mouth.span === ROOM_TILES` (two outdoor rooms, M0's full-edge carve): no wall at all, and the
 *   lattice the plan complained about disappears exactly where it was supposed to.
 * - anything between: two flanking segments of `(9 - span) / 2`, and the mouth left open.
 *
 * A door then hangs a leaf across its mouth, and that is the entire wall system.
 *
 * ## Three readings worth stating, because each could have gone the other way
 *
 * 1. **A seam draws open ground and no marker.** M2's ruling is that a seam is an ordinary step in
 *    the fiction, so it must not get the emissive ring — and the ring is the only thing `portal`
 *    contributes. What a seam *does* get is its mouth strip, so the ground reads as running off the
 *    edge of the Place rather than stopping at a cliff. The strip is not walkable (`mouth.carved` is
 *    false and the collision grid has void there; the server carries the walker across when they
 *    press against it), and at grey-box that half-metre of visual licence buys the correct reading of
 *    a road leaving town. Revisit it the moment a player notices they are standing on nothing.
 * 2. **Each room draws half the gap.** Two adjacent rooms tile a two-metre gap exactly, with no
 *    overlap to z-fight and no hole at the window's edge where the far room is not loaded.
 * 3. **A barrier is thicker than an edge and is otherwise the same material.** The plan calls the
 *    thickness a correctness requirement — you must not be able to see into a room you cannot reach —
 *    so the difference is in the geometry, where it cannot be lost to a palette change.
 *
 * ## M4's one addition: a `glow` ring at every stairwell
 *
 * §6-M4 asks for *"emissive portal rings on `portal` edges … plus vertical stairwell features; give
 * stairwells a subtle glow marker, the horizontal rings the full emissive treatment"*. M2's seam
 * ruling left exactly **two** horizontal portal edges in the world and moved every other non-seam
 * portal to a vertical link — which is not an edge at all, it is a `stair` feature. So the two are
 * dressed differently on purpose: the ring gets an emissive that clears the bloom threshold, the
 * stairwell gets a flat ring on its floor at a fifth of that, under the threshold, so a way down
 * announces itself across a dark room without competing with a gate to somewhere else.
 */

import { CARDINALS, LEVEL_SEPARATION, type Cardinal, type RoomScene } from '@mygame/shared';

import { METRES_PER_TILE, ROOM_METRES, metresOfTile } from './frame.ts';
import { groundNoise } from './noise.ts';
import {
  ARCHETYPE_GEOMETRY,
  DIMENSIONS,
  materialKey,
  type Archetype,
  type GeometryKey,
  type MaterialKey,
} from './prototypes.ts';

/**
 * One instance: a unit shape, a material and an affine transform.
 *
 * Scale is the shape's **full extent** in metres, not a half-extent, because every dimension in
 * `DIMENSIONS` is stated as a full extent and a silent factor of two between the table and the
 * transform is the kind of thing that is only ever found by measuring a wall.
 */
export interface Placement {
  readonly archetype: Archetype;
  readonly geometry: GeometryKey;
  readonly material: MaterialKey;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly rx: number;
  readonly ry: number;
  readonly rz: number;
}

export interface ChunkPlanInput {
  readonly scene: RoomScene;
  /** Tile-space origin of the room block in the {@link frame.PlaceFrame}. */
  readonly origin: { readonly tx: number; readonly ty: number };
  /** Metres, already anchored to the camera's level — see {@link roomElevation}. */
  readonly elevation: number;
  /** Tiles between room blocks on this grid. `PlaceFrame.gap`. */
  readonly gap: number;
  /** The level below, or ground never seen. See `FADE_OPACITY`. */
  readonly faded: boolean;
  /**
   * Live door state, overriding what the `zone` message's `Room` said.
   *
   * The `door` server message is Place-scoped terrain and arrives long after the zone did, so the
   * `RoomExit.door.closed` the IR read is a snapshot from arrival. Held beside the scene rather than
   * written into it: the zone's rooms are the protocol's own objects and mutating them would leave
   * two answers to "is this door shut" in one client.
   */
  readonly doorClosed: Readonly<Partial<Record<Cardinal, boolean>>>;
}

/** Ramp rise over its three-metre run, in metres. A slope, where a stairwell is a ladder. */
const RAMP_RISE = 1.2;

/**
 * Where a room's ground sits, in metres, with the camera's own level at zero.
 *
 * **The IR states absolute heights and this re-anchors them, deliberately.** `elevation.height` is
 * `level * separation`, so a stacked room on level 5 is at 20 m and a continuous room beside it is
 * at 0 — which is right as a *policy* and wrong as a frame, because within one Place a house and the
 * field it stands in are the same level and must share a floor. Anchoring on the camera's level puts
 * the walked ground at y≈0 whatever level it is, keeps the level below exactly one `separation`
 * down, and keeps the numbers the renderer works in small.
 *
 * Both branches use the IR's own separation where it has one, so the two never drift.
 */
export function roomElevation(
  scene: RoomScene,
  roomLevel: number,
  cameraLevel: number,
  centreX: number,
  centreZ: number,
): number {
  const elevation = scene.ground.elevation;
  if (elevation.t === 'stacked') return elevation.height - cameraLevel * elevation.separation;
  return (
    (roomLevel - cameraLevel) * LEVEL_SEPARATION +
    elevation.base +
    groundNoise(elevation.noise, centreX, centreZ)
  );
}

/* -------------------------------------------------------------------------- */
/* Per-side geometry                                                           */
/* -------------------------------------------------------------------------- */

/** Which way is "outward" across a side, in metres of `(x, z)`. */
const OUTWARD: Readonly<Record<Cardinal, readonly [x: number, z: number]>> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

/** True for the two sides whose boundary line runs east–west. */
function alongX(dir: Cardinal): boolean {
  return dir === 'north' || dir === 'south';
}

/**
 * Distance from the room centre to a side's boundary line, along that side's outward axis.
 *
 * Always half a room block. Named because the wall, the mouth strip, the leaf and the ring all
 * measure from it and a literal `4.5` in four places is four chances to write `4` in one of them.
 */
const HALF_ROOM = ROOM_METRES / 2;

export function planChunk(input: ChunkPlanInput): readonly Placement[] {
  const { scene, origin, elevation, gap, faded } = input;
  const sector = scene.biome.sector;
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const cx = x0 + HALF_ROOM;
  const cz = z0 + HALF_ROOM;
  const out: Placement[] = [];

  const put = (
    archetype: Archetype,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void => {
    out.push({
      archetype,
      geometry: ARCHETYPE_GEOMETRY[archetype],
      material: materialKey(archetype, sector, faded),
      x,
      y,
      z,
      sx,
      sy,
      sz,
      rx,
      ry,
      rz,
    });
  };

  /* ------------------------------------------------------------------ ground */

  put('ground', cx, elevation - DIMENSIONS.groundThickness / 2, cz, ROOM_METRES, DIMENSIONS.groundThickness, ROOM_METRES);

  /* ------------------------------------------------------------------- sides */

  const gapMetres = gap * METRES_PER_TILE;
  const half = gapMetres / 2;

  for (const dir of CARDINALS) {
    const edge = scene.edges[dir];
    const span = (edge.mouth?.span ?? 0) * METRES_PER_TILE;
    const offset = (edge.mouth?.offset ?? 0) * METRES_PER_TILE;
    const [ox, oz] = OUTWARD[dir];
    const lateral = alongX(dir);
    // Centre of the side's boundary line, and the outward normal from it.
    const bx = cx + ox * HALF_ROOM;
    const bz = cz + oz * HALF_ROOM;

    // Half the gap, filled with ground, wherever a mouth crosses. The other half is the far room's.
    if (span > 0) {
      const stripCentre = mouthCentre(x0, z0, dir, offset, span);
      put(
        'ground',
        lateral ? stripCentre : bx + ox * (half / 2),
        elevation - DIMENSIONS.groundThickness / 2,
        lateral ? bz + oz * (half / 2) : stripCentre,
        lateral ? span : half,
        DIMENSIONS.groundThickness,
        lateral ? half : span,
      );
    }

    // The wall, or the two segments of it either side of the mouth.
    const wall: Archetype = edge.solid ? (edge.kind === 'barrier' ? 'barrier' : 'edge') : 'edge';
    const thickness = wall === 'barrier' ? DIMENSIONS.barrierThickness : DIMENSIONS.edgeThickness;
    const height = wall === 'barrier' ? DIMENSIONS.barrierHeight : DIMENSIONS.edgeHeight;
    const wallY = elevation + height / 2;
    const wallOut = thickness / 2;
    if (span <= 0) {
      // The whole side. Overlong by a thickness at each end so the four corners close.
      const length = ROOM_METRES + 2 * thickness;
      put(
        wall,
        lateral ? cx : bx + ox * wallOut,
        wallY,
        lateral ? bz + oz * wallOut : cz,
        lateral ? length : thickness,
        height,
        lateral ? thickness : length,
      );
    } else if (span < ROOM_METRES) {
      // `offset` is `(ROOM_TILES - span) / 2` by construction, so both segments are the same length.
      const segment = offset + thickness;
      const low = (lateral ? x0 : z0) - thickness + segment / 2;
      const high = (lateral ? x0 : z0) + offset + span + segment / 2;
      for (const along of [low, high]) {
        put(
          wall,
          lateral ? along : bx + ox * wallOut,
          wallY,
          lateral ? bz + oz * wallOut : along,
          lateral ? segment : thickness,
          height,
          lateral ? thickness : segment,
        );
      }
    }

    // A door hangs in its mouth: shut, it fills it; open, it stands as a leaf against one jamb.
    if (edge.kind === 'door' && span > 0) {
      const closed = input.doorClosed[dir] ?? edge.closed === true;
      const leafCentre = mouthCentre(x0, z0, dir, offset, span);
      const t = DIMENSIONS.doorThickness;
      const y = elevation + DIMENSIONS.doorHeight / 2;
      if (closed) {
        put(
          'door',
          lateral ? leafCentre : bx,
          y,
          lateral ? bz : leafCentre,
          lateral ? span : t,
          DIMENSIONS.doorHeight,
          lateral ? t : span,
        );
      } else {
        // Swung back against the low jamb. Modelled by swapping the leaf's extents rather than by a
        // rotation: the read is identical and a placement with no rotation is one fewer thing that
        // can be transposed between here and the matrix that draws it.
        const hinge = (lateral ? x0 : z0) + offset + t / 2;
        put(
          'doorOpen',
          lateral ? hinge : bx,
          y,
          lateral ? bz : hinge,
          lateral ? t : span,
          DIMENSIONS.doorHeight,
          lateral ? span : t,
        );
      }
    }

    // The ring. Two of these exist in the entire world (M2's measurement) plus whatever an override
    // layer adds later, which is exactly why it must not be reachable from a seam — see the header.
    if (edge.kind === 'portal') {
      const radius = DIMENSIONS.portalRadius;
      put(
        'portal',
        bx + ox * half,
        elevation + radius + 0.2,
        bz + oz * half,
        radius,
        radius,
        radius,
        0,
        lateral ? 0 : Math.PI / 2,
        0,
      );
    }
  }

  /* ---------------------------------------------------------------- features */

  for (const feature of scene.features) {
    if (feature.t === 'prop') {
      const w = feature.width * METRES_PER_TILE;
      const d = feature.depth * METRES_PER_TILE;
      put(
        'prop',
        x0 + metresOfTile(feature.tx) + w / 2,
        elevation + DIMENSIONS.propHeight / 2,
        z0 + metresOfTile(feature.ty) + d / 2,
        w,
        DIMENSIONS.propHeight,
        d,
      );
      continue;
    }
    if (feature.t === 'landmark') {
      const base = Math.min(feature.width, feature.depth) * METRES_PER_TILE;
      put(
        'landmark',
        x0 + metresOfTile(feature.tx) + (feature.width * METRES_PER_TILE) / 2,
        elevation + DIMENSIONS.landmarkHeight / 2,
        z0 + metresOfTile(feature.ty) + (feature.depth * METRES_PER_TILE) / 2,
        base,
        DIMENSIONS.landmarkHeight,
        base,
      );
      continue;
    }
    planStair(put, feature, x0, z0, elevation, scene);
    planStairGlow(put, feature, x0, z0, elevation);
  }

  return out;
}

/** Centre of a mouth along its own side, in the axis the side runs along. */
function mouthCentre(x0: number, z0: number, dir: Cardinal, offset: number, span: number): number {
  return (alongX(dir) ? x0 : z0) + offset + span / 2;
}

/**
 * A flight, as boxes.
 *
 * `style` is the IR's, and it is the elevation policy showing through: a roofed room's levels are a
 * real `separation` apart and need steps, an open one's are a different part of the same hill and
 * need a slope. The rise follows from the same place — the stacked policy's own `separation` for a
 * stairwell, a fixed shallow {@link RAMP_RISE} for a ramp — so the flight is as tall as the gap it
 * crosses rather than as tall as a number in this file.
 */
function planStair(
  put: (
    archetype: Archetype,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rx?: number,
    ry?: number,
    rz?: number,
  ) => void,
  feature: Extract<RoomScene['features'][number], { t: 'stair' }>,
  x0: number,
  z0: number,
  elevation: number,
  scene: RoomScene,
): void {
  const run = feature.span * METRES_PER_TILE;
  const width = run;
  const elev = scene.ground.elevation;
  const rise = feature.style === 'ramp' ? RAMP_RISE : elev.t === 'stacked' ? elev.separation : LEVEL_SEPARATION;
  const sign = feature.dir === 'up' ? 1 : -1;
  const bx = x0 + metresOfTile(feature.tx);
  const bz = z0 + metresOfTile(feature.ty);

  if (feature.style === 'ramp') {
    // Tilted about X, so it climbs toward -Z (north). Which way a ramp faces is not in the IR — the
    // vertical exit has no direction on the compass — so it is a constant, and a consistent one.
    const angle = Math.atan2(rise, run) * sign;
    put(
      'stair',
      bx + width / 2,
      elevation + (rise * sign) / 2,
      bz + run / 2,
      width,
      DIMENSIONS.stairThickness,
      Math.hypot(run, rise),
      angle,
    );
    return;
  }

  const steps = DIMENSIONS.stairSteps;
  const depth = run / steps;
  for (let i = 0; i < steps; i++) {
    const height = (rise * (i + 1)) / steps;
    put(
      'stair',
      bx + width / 2,
      elevation + (sign * height) / 2,
      bz + run - depth * (i + 0.5),
      width,
      height,
      depth,
    );
  }
}

/**
 * The flat marker a flight lays around its own mouth. M4.
 *
 * At the room's floor level and not the flight's, always: the marker's job is to be visible from
 * across the room at a 64 degree camera, and a ring that climbed with the steps would be edge-on from
 * exactly the direction a player approaches from. `rx = pi/2` lays the torus in the XZ plane; the
 * unit torus has radius 1, so a uniform scale by {@link DIMENSIONS.glowRadius} keeps the tube in
 * proportion the same way the portal ring does.
 */
function planStairGlow(
  put: (
    archetype: Archetype,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    rx?: number,
    ry?: number,
    rz?: number,
  ) => void,
  feature: Extract<RoomScene['features'][number], { t: 'stair' }>,
  x0: number,
  z0: number,
  elevation: number,
): void {
  const run = feature.span * METRES_PER_TILE;
  const radius = DIMENSIONS.glowRadius;
  put(
    'glow',
    x0 + metresOfTile(feature.tx) + run / 2,
    elevation + DIMENSIONS.glowLift,
    z0 + metresOfTile(feature.ty) + run / 2,
    radius,
    radius,
    radius,
    Math.PI / 2,
  );
}
