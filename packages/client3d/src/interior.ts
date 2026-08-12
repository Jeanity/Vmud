/**
 * The second rendering mode — §6-M6, and the plan's own words for what it is not: *"This is a second
 * rendering mode, not a palette."*
 *
 * `inside` 23.2%, `cave` 17.3% and `city` 6.8% are **47.2% of the built world** (measured here over
 * all 46,544 rooms; the plan's 35.7% predates M1's sector repairs and is now the low estimate). Those
 * rooms need geometry the outdoor pass has no concept of — a lid, a floor you can see the boards of,
 * walls with a street face and a room face — and they need the sky term taken away. This file is the
 * geometry half. `indoors.ts` is the light half.
 *
 * Pure, like `chunkPlan.ts` and `scatter.ts` beside it and for the same reason: a `Placement` is
 * eight numbers and two strings, so the whole-world sweep can dress every interior in the world and
 * count its buckets without a GPU. `world3d.ts` is still the only file that turns any of it into a
 * matrix.
 *
 * ## The three layers, and which one is load-bearing
 *
 * 1. **The shell** is `chunkPlan.ts`'s and is always there: a roofed room gets a `ceiling` slab and
 *    its walls stop at it. That alone makes *"no sky from an interior"* true for all 21,978 roofed
 *    rooms **with the village kit absent entirely**, which matters because `public/models` is
 *    git-ignored and a fresh clone has none.
 * 2. **The dressing** is this file's: kit walls, floors, doorway arches, tiled roofs and chimneys on
 *    `inside` rooms. It is a strict addition — nothing here is required for the acceptance, and
 *    `world3d.ts` drops it wholesale if the manifest never lands.
 * 3. **The cull** is {@link roofGroups} plus `world3d.ts`: which lids come off, and which walls go
 *    see-through, when the player is under a roof.
 *
 * ## An inside room *is* the building
 *
 * The brief's rule, and it is also the only rule that keeps this honest: **no building footprint is
 * invented.** A room's exterior faces are exactly the sides the IR classifies `edge` (nothing beyond)
 * or `barrier` (a room beyond you cannot reach) — so a tavern that is four rooms is four rooms' worth
 * of walls with the party walls between them, and a street sees the outward faces of whatever inside
 * rooms happen to line it. Nothing extrudes a block, nothing merges rooms into a house, and there is
 * no second geometry system that could disagree with the collision grid about where a wall is.
 *
 * That is also why **`city` rooms get nothing from this file**. A street is open-air ground; what
 * makes it read as a street is that the inside rooms beside it now wear plaster and tile instead of
 * grey. The block faces are the neighbours' own walls, drawn by the neighbours.
 *
 * ## Which face gets a window — derived, not decorated
 *
 * The IR already knows which side of a room is outdoors:
 *
 * | edge kind | what it is | what it gets |
 * | --- | --- | --- |
 * | `edge` | no room in the next cell — the open air | the **exterior** face: windows, brick base |
 * | `barrier` | a room you cannot reach | a **party wall**: plain, no window |
 * | `open` / `door` | a crossing | two flanks of plain wall and an arch across the mouth |
 *
 * A window on a party wall would be a window into next door's larder; a window is exactly a hole to
 * the outside and the IR has already said which sides those are. Nothing here needs a heuristic.
 *
 * ## Caves are not kit territory
 *
 * The brief's ruling, taken as written: a cave gets the shell and nothing else — `chunkPlan`'s rock
 * walls at the sector's own colour and a rock lid over them. Plaster in a cavern would be worse than
 * grey. What a cave *does* get from M6 is the lid, the light recipe and the fade, which is the whole
 * of what "reads as underground" means.
 */

import {
  CARDINALS,
  type Cardinal,
  type RoomId,
  type RoomScene,
  type Zone,
  hashCell,
} from '@mygame/shared';

import type { Placement } from './chunkPlan.ts';
import { METRES_PER_TILE, ROOM_METRES, metresOfTile } from './frame.ts';
import {
  DIMENSIONS,
  VILLAGE_CHORD,
  VILLAGE_FLOORS,
  VILLAGE_METRICS,
  VILLAGE_PART_TEXTURES,
  VILLAGE_SCALE,
  VILLAGE_WALLS,
  villageGeometryKey,
  villageMaterialKey,
  villageRoleOf,
  type VillageRole,
} from './prototypes.ts';

/* -------------------------------------------------------------------------- */
/* The module grid                                                             */
/* -------------------------------------------------------------------------- */

/** Chords along one side of a room. Three, and `interior.test.ts` asserts it divides exactly. */
export const CHORDS_PER_SIDE = ROOM_METRES / VILLAGE_CHORD;

/** Half a room block, in metres — the distance from its centre to any of its four boundary lines. */
const HALF_ROOM = ROOM_METRES / 2;

/**
 * Yaw, in radians, that turns a module's local `+X` along a side and its local `-Z` outward.
 *
 * A `Wall_*` module is authored running along `X` with its outward face toward `-Z` (measured: the
 * panel spans `z ∈ [-0.314, +0.0924]`, so 31 cm of it laps *out* past its own plane and 9 cm laps
 * in). North is `-Z` in this project's frame, so the north wall is the identity and the rest follow
 * anticlockwise looking down — which, because `+Y` is up and `+Z` is south, is a **negative** yaw per
 * quarter turn eastward.
 */
const SIDE_YAW: Readonly<Record<Cardinal, number>> = {
  north: 0,
  east: -Math.PI / 2,
  south: Math.PI,
  west: Math.PI / 2,
};

/** Which way is "outward" across a side, in metres of `(x, z)`. `chunkPlan`'s table, restated. */
const OUTWARD: Readonly<Record<Cardinal, readonly [x: number, z: number]>> = {
  north: [0, -1],
  east: [1, 0],
  south: [0, 1],
  west: [-1, 0],
};

function alongX(dir: Cardinal): boolean {
  return dir === 'north' || dir === 'south';
}

/* -------------------------------------------------------------------------- */
/* Which walls the camera is behind                                            */
/* -------------------------------------------------------------------------- */

/**
 * The sides whose wall stands between this camera and the room it is looking into — **derived from
 * the rig rather than written down**, because the rig moves now and a hard-coded answer would be a
 * statement about the pose M6 happened to be authored at.
 *
 * M6 wrote: *"the yaw is fixed, so the camera is always due **south** of its focus and only the south
 * wall can be between the two,"* and closed with *"returned as a set rather than the constant `south`
 * so that the day free yaw arrives, the callers are already asking the right question."* **That day
 * is M8.** The answer is now the real one: a side's wall stands between the camera and the room's
 * floor exactly when the camera is out past that side's plane, which is `outward · toCamera > 0` —
 * the same test a renderer uses to ask which faces of a box are facing it.
 *
 * Two consequences the fixed yaw hid, and both are visible in a tavern:
 *
 * - **The usual answer is two walls, not one.** A box has four sides and a camera at any angle other
 *   than a cardinal is outside two of their planes; each hides a strip of the floor inside it, deep
 *   in the direction the camera is offset and shallow in the other. Orbit to the south-east and both
 *   the south and east walls hide floor; fading only the "nearest" leaves a solid corner post
 *   between the camera and the player, which is the exact frame the fade exists to prevent, arrived
 *   at by rounding.
 * - **On a cardinal it must be exactly one.** `cos 90°` is 6e-17 rather than 0, so a bare `> 0` test
 *   fades the south wall of a camera due east of the room, forever, invisibly. {@link SIDE_DEADBAND}
 *   is the answer and it is free: a wall the camera is within two degrees of being edge-on to hides
 *   9 cm of floor at the authored pose, and 9 cm of floor is not worth a transparent wall.
 *
 * The pitch still decides how much a faded wall was costing: the sightline from the camera to the
 * player's feet passes the boundary line — 4.5 m out — at `4.5 x tan(pitch)` above the floor, which is
 * **4.5 m at the shallowest pose in the clamp and 9.2 m at the steepest**, against a wall 3.0 m tall.
 * So the wall never hides the *player* at any pose the dolly can reach. What it does hide is the strip
 * of floor immediately inside it, `wallHeight / tan(pitch)` deep: **3.00 m at 45 degrees and 1.46 m at
 * 64**. A third of the room's depth at the shallow end, with whatever is standing in it — which is why
 * the wall fades rather than the ceiling alone coming off.
 *
 * The returned set is one of {@link OCCLUDING_SETS}' eight, **by identity**: `world3d.ts` compares the
 * set it gets against the set it holds to decide whether any wall in the window has to be rebuilt, and
 * a fresh `Set` per frame would rebuild the building the player is standing in sixty times a second.
 */
export function occludingSides(
  pitchDegrees: number,
  yawRadians = 0,
): {
  readonly sides: ReadonlySet<Cardinal>;
  /** Metres of floor the wall hides, measured inward from its own plane. */
  readonly hidden: number;
  /** Metres of clearance the sightline to the player's feet has over the wall head. */
  readonly clearance: number;
} {
  const tangent = Math.tan((pitchDegrees * Math.PI) / 180);
  const head = DIMENSIONS.ceilingHeight;
  // Where the camera stands relative to its focus, on the ground: `rig.ts`'s own offset, normalised.
  // Yaw 0 puts it at `(0, +1)` — due south — which is M6's answer and the fixed point of the change.
  const toCameraX = Math.sin(yawRadians);
  const toCameraZ = Math.cos(yawRadians);
  let key = 0;
  for (let i = 0; i < CARDINALS.length; i++) {
    const dir = CARDINALS[i]!;
    const [ox, oz] = OUTWARD[dir];
    if (ox * toCameraX + oz * toCameraZ > SIDE_DEADBAND) key |= 1 << i;
  }
  return {
    sides: OCCLUDING_SETS[key]!,
    hidden: Math.round((head / tangent) * 1000) / 1000,
    clearance: Math.round((HALF_ROOM * tangent - head) * 1000) / 1000,
  };
}

/**
 * `sin 2°` — how far round onto a side the camera must be before that side's wall counts as being in
 * the way.
 *
 * Not an epsilon against floating point (though it covers that too); an **angular** deadband, chosen
 * so that a camera parked on a cardinal gets one wall rather than two-minus-a-rounding-error, and so
 * that a yaw resting exactly on a quadrant boundary cannot flip the set — and therefore rebuild the
 * building — on the last bit of a `sin`. Two degrees of orbit is 8 px of drag.
 */
export const SIDE_DEADBAND = Math.sin((2 * Math.PI) / 180);

/**
 * Every set {@link occludingSides} can return, indexed by a bitmask over {@link CARDINALS}.
 *
 * Sixteen slots for eight reachable answers — four cardinals and four diagonals; the empty set and
 * the opposite-pair sets are unreachable by construction and are here so the lookup is an index
 * rather than a branch. Built once so the returned set is the *same object* for the same answer,
 * which is what lets `world3d.ts` decide "has the near wall changed?" with a `!==`.
 */
const OCCLUDING_SETS: readonly ReadonlySet<Cardinal>[] = Array.from({ length: 16 }, (_, mask) => {
  const sides: Cardinal[] = [];
  for (let i = 0; i < CARDINALS.length; i++) if (mask & (1 << i)) sides.push(CARDINALS[i]!);
  return new Set<Cardinal>(sides);
});

/* -------------------------------------------------------------------------- */
/* Roof groups                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Has this room a lid — **`roomScene.isRoofed`'s predicate, restated, because it is private there.**
 *
 * `describeRoom` reports the answer on `enclosure.roofed` and that is the authority; this is the same
 * rule spelled out for the one caller that cannot afford to go through `describeRoom` at all.
 * {@link roofGroups} is a graph walk that asks the question once per room *and once per neighbour*,
 * and `describeRoom` classifies four edges and places every prop in the room to answer it — which
 * would make building the groups for Skullport's 1,466 rooms a matter of describing about five
 * thousand scenes to learn eighteen booleans.
 *
 * A duplicated fact is a fact that can drift, so `interior.test.ts` sweeps all 46,544 rooms and
 * asserts this agrees with `describeRoom(...).enclosure.roofed` exactly. That is the same contract
 * `prototypes.kitRoleOf` holds against `modelgen.kitRole`.
 */
export function roofedRoom(room: { readonly sector: string; readonly flags?: readonly string[] }): boolean {
  return room.sector === 'inside' || room.sector === 'cave' || (room.flags?.includes('indoors') ?? false);
}

/**
 * Which roofed rooms share one lid — the connected components of the roofed graph, per Place.
 *
 * **This is what stops the interior mode from being a global switch.** Walk into a tavern and the
 * tavern's roof comes off; the house next door keeps its own, because it is a different component.
 * A whole-level "all roofs off while indoors" toggle was the cheaper option and it is wrong in
 * exactly the case that matters most — Bryn Shander's 229 inside rooms line 119 city ones, and
 * un-roofing the whole street to show one common room would undo the thing M6 exists to build.
 *
 * The predicate is deliberately **not** `groundComponents`'s: two roofed rooms share a lid when a
 * cardinal crossing joins them on the same level and neither end is a portal. A **door does not
 * break the group** — an inn's kitchen behind a shut door is still under the inn's roof, and a group
 * that changed shape when a door swung would rebuild half the window on a `door` message. A seam
 * does break it, because a seam's far side is another Place's coordinate frame and another lid.
 *
 * Links are followed both ways for `groundComponents`'s reason: 392 cardinal links in the built world
 * are one-way, and a directed fill would put a one-way pair in one group or two depending on which
 * room the zone file happened to list first. The id is the smallest room id in the component, so it
 * is stable under any traversal order and legible in a dump.
 */
export function roofGroups(zone: Zone, roofed: (room: Zone['rooms'][number]) => boolean): ReadonlyMap<RoomId, RoomId> {
  const byId = new Map<RoomId, Zone['rooms'][number]>();
  for (const room of zone.rooms) byId.set(room.id, room);

  const links = new Map<RoomId, RoomId[]>();
  const join = (a: RoomId, b: RoomId): void => {
    const list = links.get(a);
    if (list) list.push(b);
    else links.set(a, [b]);
  };
  for (const room of zone.rooms) {
    if (!roofed(room)) continue;
    for (const dir of CARDINALS) {
      const exit = room.exits[dir];
      if (!exit || exit.portal) continue;
      const next = byId.get(exit.to);
      if (!next || next.pos.z !== room.pos.z || !roofed(next)) continue;
      join(room.id, next.id);
      join(next.id, room.id);
    }
  }

  const of = new Map<RoomId, RoomId>();
  const seen = new Set<RoomId>();
  for (const start of zone.rooms) {
    if (seen.has(start.id) || !roofed(start)) continue;
    const members: RoomId[] = [];
    const stack: RoomId[] = [start.id];
    seen.add(start.id);
    while (stack.length > 0) {
      const id = stack.pop()!;
      members.push(id);
      for (const next of links.get(id) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    let group = members[0]!;
    for (const id of members) if (id < group) group = id;
    for (const id of members) of.set(id, group);
  }
  return of;
}

/* -------------------------------------------------------------------------- */
/* The dressing                                                               */
/* -------------------------------------------------------------------------- */

const HASH_RANGE = 0x1_0000_0000;

const SALT_WALL_PICK = 0x6d02;
const SALT_CHIMNEY = 0x6d04;

function roll(seed: number, salt: number, index: number): number {
  return hashCell(seed, salt, index, salt ^ index) / HASH_RANGE;
}

export interface InteriorInput {
  readonly scene: RoomScene;
  /** Tile-space origin of the room block, as `chunkPlan` takes it. */
  readonly origin: { readonly tx: number; readonly ty: number };
  /** Metres, already anchored to the camera's level. */
  readonly elevation: number;
  /**
   * True when the player is under **this** lid — see {@link roofGroups}.
   *
   * Drives two things at once and they must not be separated: the roof is not drawn, and the walls
   * the camera is behind are drawn open. Splitting them would let a frame exist with the lid off and
   * the near wall solid, which is a room you are looking into through a wall you cannot see past.
   */
  readonly roofOpen: boolean;
  /**
   * True when nothing stands on this room's own cell one level up.
   *
   * A tiled gable is a *building top*, so a room with a storey above it gets the flat `ceiling` slab
   * and no roof — which, seen from outside and above, is exactly what the underside of the next floor
   * looks like. This is the composition the brief asks for spelled out as one boolean: the upper
   * floor's floor is never the lower floor's missing ceiling, because the lower floor always has its
   * own ceiling and only ever loses its *roof*.
   *
   * Necessary and not sufficient: {@link roofVisible} is the other half, and it is what stops a mine
   * gallery with nothing above it from growing a pantile roof in the dark.
   */
  readonly top: boolean;
  /** The sides whose wall draws open when {@link roofOpen}. {@link occludingSides}. */
  readonly openSides: ReadonlySet<Cardinal>;
}

/** True for the rooms this file dresses: an inside room, roofed. Caves and streets are not kit. */
export function dressable(scene: RoomScene): boolean {
  return scene.enclosure.roofed && scene.biome.sector === 'inside';
}

/**
 * Whether a street can see this room's top — **and therefore whether it gets a tiled gable.**
 *
 * Found by walking The Comarian Mines during the acceptance pass, which is exactly the failure the
 * plan's risk 1 predicts: a rule tuned on Bryn Shander put a Quaternius pantile roof on *"A Simple
 * Stone Room"* four hundred metres inside a mountain, floating in the dark over rock that is not
 * modelled. `top` — "no storey above this cell" — turned out to be the wrong question, because in a
 * dungeon the answer is nearly always yes and there is still no sky.
 *
 * The right question is the one a builder would ask: **is there anything out there to see it from?**
 * A cardinal side whose far room is a *known, unroofed* sector is a face onto the open air, and a
 * gable is what that face wears. Everything else — a chamber walled in by other chambers, a mine
 * gallery, a temple cell — keeps `chunkPlan`'s flat lid, which from above is the plain top of a
 * structure cut into rock and is the honest picture.
 *
 * Measured over all 10,799 roofed `inside` rooms: **2,945 grow a roof, 27.3%**, and the split falls
 * exactly where the fiction says it should — Undermountain II 4%, The Citadel 6%, Temple of Dumathoin
 * 0%, against Bryn Shander 45%, Silverymoon 57%, Beluir 61% and Skullport 76%. Nothing in that list
 * was tuned; it is what the sector graph already said.
 *
 * One known imprecision, recorded rather than papered over: `SceneEdge.sector` carries the far room's
 * *sector* and not its `indoors` flag, so one of the 1,036 outdoor-sector rooms the MUD flags
 * `indoors` reads here as open air. That is a roof over a room next to a covered market, which is a
 * cheap thing to be wrong about compared with re-deriving the neighbour's whole scene to ask.
 */
export function roofVisible(scene: RoomScene): boolean {
  for (const dir of CARDINALS) {
    const sector = scene.edges[dir].sector;
    if (sector !== undefined && sector !== 'inside' && sector !== 'cave') return true;
  }
  return false;
}

/**
 * Whether this room wears a tiled roof rather than a flat lid — the one question both halves ask.
 *
 * `chunkPlan` needs it to know whether to draw its slab and `planInterior` needs it to know whether
 * to draw the gable, and the two must never disagree: a slab under a gable breaks the roof surface a
 * metre in from each eave, and neither would be a room with no lid at all.
 */
export function hasRoof(scene: RoomScene, top: boolean): boolean {
  return top && dressable(scene) && roofVisible(scene);
}

/**
 * One interior, as village modules.
 *
 * Returns nothing at all for anything that is not {@link dressable}, so a caller may hand it every
 * room in the world and let the IR decide — which is what `world3d.ts` does, and what the whole-world
 * sweep relies on.
 */
export function planInterior(input: InteriorInput): readonly Placement[] {
  const { scene, origin, elevation, roofOpen, top, openSides } = input;
  if (!dressable(scene)) return [];

  const out: Placement[] = [];
  const x0 = metresOfTile(origin.tx);
  const z0 = metresOfTile(origin.ty);
  const cx = x0 + HALF_ROOM;
  const cz = z0 + HALF_ROOM;

  // The palette is the zone's theme, not the room's seed: a street of houses in four different
  // materials is a model village, and `SceneBiome.theme` is exactly the per-zone knob M2 built for
  // this. The room's own seed then picks *within* the pair, so no two rooms are identical either.
  const palette = VILLAGE_WALLS[scene.biome.theme % VILLAGE_WALLS.length]!;
  const floorModel = VILLAGE_FLOORS[scene.biome.theme % VILLAGE_FLOORS.length]!;

  put(out, floorModel, cx, elevation, cz, {
    // 3 x 3 chords over a 9 m room. `sy` is 1 because a floor module is 2 cm thick and stays so:
    // the horizontal scale is the grid mapping, the vertical is the object's own proportion.
    tiles: CHORDS_PER_SIDE,
    lift: 0,
  });

  for (const dir of CARDINALS) {
    const edge = scene.edges[dir];
    const open = roofOpen && openSides.has(dir);
    const exterior = edge.kind === 'edge';
    const span = (edge.mouth?.span ?? 0) * METRES_PER_TILE;
    const offset = (edge.mouth?.offset ?? 0) * METRES_PER_TILE;

    if (span <= 0) {
      // A solid side: three chords, and only an exterior one may carry a window. `chord` 1 is the
      // middle of the side, which is where a window belongs and where a hashed choice would put it
      // only two times in three.
      for (let chord = 0; chord < CHORDS_PER_SIDE; chord++) {
        const window = exterior && chord === 1 && roll(scene.seed, SALT_WALL_PICK, chord + dirIndex(dir) * 8) < 0.65;
        wall(out, window ? palette.window : palette.plain, dir, x0, z0, elevation, chord, open);
      }
      continue;
    }

    // A mouth: the two flanks are one chord each (`(9 - 3) / 2 = 3`, exactly {@link VILLAGE_CHORD}),
    // and the opening takes the arch. A window never goes on a flank — it is the wall beside a door.
    if (span < ROOM_METRES) {
      wall(out, palette.plain, dir, x0, z0, elevation, 0, open);
      wall(out, palette.plain, dir, x0, z0, elevation, CHORDS_PER_SIDE - 1, open);
      arch(out, dir, x0, z0, elevation, offset, span, open);
    }
  }

  // The lid is `chunkPlan`'s. What this file adds on top of it is the tiled gable — and only for a
  // room with open air above it *and a street to be seen from* (see `roofVisible`, found by walking
  // The Comarian Mines), and only while somebody is not standing underneath.
  if (hasRoof(scene, top) && !roofOpen) {
    const metrics = VILLAGE_METRICS;
    // Seated by its wall plate: the model's origin is at the plate and its fascia hangs `roofDrop`
    // below, so putting the origin at the wall head lands the eaves just over the top of the wall.
    const rise = ROOF_RIDGE / metrics.roofRise;
    const head = DIMENSIONS.ceilingHeight;
    out.push({
      archetype: 'villageSolid',
      geometry: villageGeometryKey('roof-round-tiles-8x8', 'round-tiles'),
      material: villageMaterialKey('roof-round-tiles-8x8', 'round-tiles'),
      x: cx,
      y: elevation + head,
      z: cz,
      sx: 1,
      sy: rise,
      sz: 1,
      rx: 0,
      ry: 0,
      rz: 0,
    });
    out.push({
      archetype: 'villageSolid',
      geometry: villageGeometryKey('roof-round-tiles-8x8', 'wood-trim'),
      material: villageMaterialKey('roof-round-tiles-8x8', 'wood-trim'),
      x: cx,
      y: elevation + head,
      z: cz,
      sx: 1,
      sy: rise,
      sz: 1,
      rx: 0,
      ry: 0,
      rz: 0,
    });
    // One roof in three carries a chimney. A roofscape with a chimney on every house is a factory and
    // one with none is a stage set; a third is what a hashed roll gives that reads as neither.
    if (roll(scene.seed, SALT_CHIMNEY, 0) < 0.34) {
      out.push({
        archetype: 'villageSolid',
        geometry: villageGeometryKey('prop-chimney2', 'uneven-brick'),
        material: villageMaterialKey('prop-chimney2', 'uneven-brick'),
        // Off the ridge line and toward the back, where a flue actually rises — and sunk a metre into
        // the slope so its base is inside the tiles rather than floating over them.
        x: cx + (roll(scene.seed, SALT_CHIMNEY, 1) - 0.5) * 2,
        y: elevation + head + ROOF_RIDGE - 1.6,
        z: cz - 1.5,
        sx: 1,
        sy: 1,
        sz: 1,
        rx: 0,
        ry: 0,
        rz: 0,
      });
    }
  }

  return out;
}

/**
 * Metres from the wall head to the ridge — **the one number in this file that fights the kit.**
 *
 * `Roof_RoundTiles_8x8` measures 6.001 m from its wall plate to its ridge over a 9.95 m span, which
 * is a 54-degree pitch: correct for the kit's own eye-level renders and wrong for a camera looking
 * down at 45 to 64 degrees, where the roof is the largest thing in the frame and a 6 m gable on a 3 m
 * wall turns a village into a field of towers. At 3.7 m the ridge sits 6.7 m above the floor, a
 * 1.23:1 roof-to-wall that reads as a house, and the round tiles compress 38% along the slope — which
 * at the dolly's closest 24 m is a tile row a third of a pixel shorter than it was drawn.
 *
 * The alternative was a smaller roof model scaled up, and it is worse: every `Roof_RoundTiles_*`
 * shares one pitch, so a narrower one stretched to a 9 m span stretches the tiles *across* instead,
 * which is the axis the eye reads a tile course along.
 */
export const ROOF_RIDGE = 3.7;

function dirIndex(dir: Cardinal): number {
  return CARDINALS.indexOf(dir);
}

/**
 * One floor, as a square of chords.
 *
 * Every module in one placement list rather than one stretched slab: the floor texture is boards and
 * flags, and a single module scaled 4.5x would draw a plank four and a half metres wide.
 */
function put(
  out: Placement[],
  model: string,
  cx: number,
  elevation: number,
  cz: number,
  layout: { readonly tiles: number; readonly lift: number },
): void {
  const textures = VILLAGE_PART_TEXTURES[model] ?? [];
  const first = (layout.tiles - 1) / 2;
  for (let ix = 0; ix < layout.tiles; ix++) {
    for (let iz = 0; iz < layout.tiles; iz++) {
      for (const texture of textures) {
        out.push({
          archetype: 'villageSolid',
          geometry: villageGeometryKey(model, texture),
          material: villageMaterialKey(model, texture),
          x: cx + (ix - first) * VILLAGE_CHORD,
          y: elevation + layout.lift,
          z: cz + (iz - first) * VILLAGE_CHORD,
          sx: VILLAGE_SCALE,
          sy: 1,
          sz: VILLAGE_SCALE,
          rx: 0,
          ry: 0,
          rz: 0,
        });
      }
    }
  }
}

/** One wall chord, on a side, at a chord index along it. */
function wall(
  out: Placement[],
  model: string,
  dir: Cardinal,
  x0: number,
  z0: number,
  elevation: number,
  chord: number,
  open: boolean,
): void {
  const [ox, oz] = OUTWARD[dir];
  const lateral = alongX(dir);
  // The chord's centre along the side, and the side's own boundary line.
  const along = (lateral ? x0 : z0) + chord * VILLAGE_CHORD + VILLAGE_CHORD / 2;
  const bx = x0 + HALF_ROOM + ox * HALF_ROOM;
  const bz = z0 + HALF_ROOM + oz * HALF_ROOM;
  for (const texture of VILLAGE_PART_TEXTURES[model] ?? []) {
    out.push({
      archetype: 'villageSolid',
      geometry: villageGeometryKey(model, texture),
      material: villageMaterialKey(model, texture, open),
      x: lateral ? along : bx,
      y: elevation,
      z: lateral ? bz : along,
      // X runs along the side and Z through the wall's thickness; both take the grid mapping. Y is
      // the module's own 3.12 m and is never scaled — see `VILLAGE_METRICS`.
      sx: VILLAGE_SCALE,
      sy: 1,
      sz: VILLAGE_SCALE,
      rx: 0,
      ry: SIDE_YAW[dir],
      rz: 0,
    });
  }
}

/**
 * The arch across a mouth.
 *
 * Six centimetres deep and three metres wide at {@link VILLAGE_SCALE}, which is exactly the carved
 * opening — so the collision grid's three walkable tiles stay three walkable tiles and nothing about
 * the doorway is narrower to look at than it is to walk through. `chunkPlan`'s door leaf still hangs
 * in the same mouth and now swings inside a frame.
 */
function arch(
  out: Placement[],
  dir: Cardinal,
  x0: number,
  z0: number,
  elevation: number,
  offset: number,
  span: number,
  open: boolean,
): void {
  const [ox, oz] = OUTWARD[dir];
  const lateral = alongX(dir);
  const centre = (lateral ? x0 : z0) + offset + span / 2;
  const bx = x0 + HALF_ROOM + ox * HALF_ROOM;
  const bz = z0 + HALF_ROOM + oz * HALF_ROOM;
  out.push({
    archetype: 'villageSolid',
    geometry: villageGeometryKey('wall-arch', 'wood-trim'),
    material: villageMaterialKey('wall-arch', 'wood-trim', open),
    x: lateral ? centre : bx,
    y: elevation,
    z: lateral ? bz : centre,
    sx: span / VILLAGE_METRICS.module,
    sy: 1,
    sz: VILLAGE_SCALE,
    rx: 0,
    ry: SIDE_YAW[dir],
    rz: 0,
  });
}

/* -------------------------------------------------------------------------- */
/* Reading a plan back                                                         */
/* -------------------------------------------------------------------------- */

/** The role of the module a placement draws, from its geometry key. `village:<model>:<texture>`. */
export function roleOfPlacement(placement: Placement): VillageRole | undefined {
  if (placement.archetype !== 'villageSolid') return undefined;
  const model = placement.geometry.split(':')[1];
  return model === undefined ? undefined : villageRoleOf(model);
}
