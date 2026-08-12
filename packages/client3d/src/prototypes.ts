/**
 * The bounded pool key set — M3's answer to the plan's risk 3, and the reason this file is data
 * rather than code.
 *
 * *"Geometries and materials are pooled per `(biome, archetype)` and **never** created per room or
 * per zone — bound the pool key set explicitly and assert its size in a test."* (§4, Layer C.) The
 * bound has to be a *fact about the program*, not a habit the streamer keeps, or the first archetype
 * somebody adds inside a loop reintroduces the leak. So every key that can ever exist is enumerated
 * here, at module load, from two closed lists and one boolean — and `prototypes.test.ts` asserts the
 * exact count. A change that widens the set fails that test, which is the whole point of the number.
 *
 * ## Why the key is not `(biome, archetype)` for every archetype
 *
 * Naively crossing 16 sectors with 11 archetypes gives 176 materials, twice over for the faded
 * variant. Most of that product is meaningless: a door is a door in a forest and in a cave, and a
 * *portal* is emphatically the same object wherever it hangs. Only three archetypes are terrain —
 * the ground you stand on and the two things that close a room in — and those are the ones the plan
 * means by "dressed by biome: forest→tree wall, cave→rock, city→facade". So:
 *
 * - {@link BIOME_ARCHETYPES} are crossed with all 16 {@link SECTORS}: 3 x 16 = 48.
 * - Everything else gets one material: 10 (nine at M3; click-to-move's `marker` is the tenth).
 * - Everything except the three archetypes that never fade (`self`, `other`, `marker` — see
 *   {@link NEVER_FADED}) gets a faded twin (see {@link FADE_OPACITY}): 55.
 *
 * **113 materials, created once at startup, never again.** That reads like a lot and is not: colour
 * is a uniform rather than a shader define, so all 113 share two compiled programs (opaque and
 * transparent) and the objects themselves are a few hundred bytes each.
 *
 * ## What M4 added, and what it deliberately did not
 *
 * Two materials: the `glow` archetype and its faded twin, for the stairwell markers. **Emissive and
 * fog of war both went in without a single new key**, and each for a reason worth keeping:
 *
 * - `emissive` is a uniform on `MeshLambertMaterial`, not a define, so the portal ring's light lives
 *   in {@link ARCHETYPE_EMISSIVE} beside its colour and costs no program.
 * - Fog of war is `InstancedMesh.instanceColor` (see `fogOfWar.ts`) — per *instance*, so the three
 *   states are three floats a chunk rather than three times the material pool. Keying them into the
 *   material would have taken 112 to 336 and, worse, made "which state is this room in" a property of
 *   the pool rather than of the room. (336 was the M4 figure; click-to-move's `marker` would make it
 *   339 had this file taken the same wrong turn.)
 *
 * The pool is still two programs. That was the constraint M4 was asked to respect and it held.
 *
 * ## Click-to-move's one addition: `marker`
 *
 * The destination ring click-to-move drops under the pointer (`marker.ts`) is a thirteenth archetype
 * rather than a repaint of `glow` or `portal`, because a pool whose keys are *legible* is the property
 * `materialKey`'s own docblock names — "a dump of the pool should be legible" — and a ring meaning "you
 * clicked here" sharing a name with a ring meaning "a way down" or "a way out" is a future reader's
 * false cognate waiting to happen. It follows `self`/`other`'s pattern exactly, not `glow`'s: never
 * faded (it is only ever drawn on the camera's own level, exactly where a body is), so it costs one
 * material and not two, and it is excluded from the per-chunk bucket ceiling in `pool.ts` because it is
 * never part of a room plan — `marker.ts` acquires its one wrapper once, the way `entities.ts` acquires
 * two, and never gives it back.
 *
 * ## Geometry is not keyed by biome at all
 *
 * Four unit shapes, scaled per instance by the matrix. That is what lets one `InstancedMesh` hold a
 * 9 m ground slab and a 0.6 m wall, and it collapses the geometry pool to a constant that does not
 * grow with the world, the zone or the archetype table.
 */

import { SECTORS, type Sector } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The four unit shapes. Everything drawn is one of these under a scale.
 *
 * `box` covers ground, walls, doors, steps, ramps and props; `cone` is the landmark slot; `torus` is
 * both the portal ring — the plan's emissive ring, which M4 lit — and the flat marker a stairwell
 * lays on its floor; `capsule` is a body. A fifth shape is a change to this list and to the test that
 * counts it.
 */
export const GEOMETRY_KEYS = ['box', 'cone', 'torus', 'capsule'] as const;

export type GeometryKey = (typeof GEOMETRY_KEYS)[number];

/* -------------------------------------------------------------------------- */
/* Archetypes                                                                  */
/* -------------------------------------------------------------------------- */

/** What a thing *is*, for the purpose of choosing a material and a shape. */
export const ARCHETYPES = [
  'ground',
  'edge',
  'barrier',
  'door',
  'doorOpen',
  'portal',
  'glow',
  'stair',
  'prop',
  'landmark',
  'self',
  'other',
  'marker',
] as const;

export type Archetype = (typeof ARCHETYPES)[number];

/**
 * The archetypes whose material depends on the ground they stand on.
 *
 * Deliberately three. `edge` is the plan's "one rule, a third of all edges" — 32.2% of the world's
 * boundaries dressed by biome — and `barrier` is the correctness requirement that must read as
 * solid; both are terrain and both change with the sector. Nothing else does.
 */
export const BIOME_ARCHETYPES = ['ground', 'edge', 'barrier'] as const satisfies readonly Archetype[];

const BIOME_KEYED: ReadonlySet<Archetype> = new Set<Archetype>(BIOME_ARCHETYPES);

/**
 * Archetypes that never fade.
 *
 * A body is only ever on your own level — interest management is room-scoped and a room is on one
 * level — so a faded capsule would be a variant nothing can produce. `marker` joins them for the same
 * reason: click-to-move only ever aims at ground on the level the player is walking (`main.ts` gates
 * the unprojection plane on the player's own `groundAt`), so a faded destination ring is equally a
 * variant nothing can produce.
 */
const NEVER_FADED: ReadonlySet<Archetype> = new Set<Archetype>(['self', 'other', 'marker']);

export const ARCHETYPE_GEOMETRY: Readonly<Record<Archetype, GeometryKey>> = {
  ground: 'box',
  edge: 'box',
  barrier: 'box',
  door: 'box',
  doorOpen: 'box',
  portal: 'torus',
  glow: 'torus',
  stair: 'box',
  prop: 'box',
  landmark: 'cone',
  self: 'capsule',
  other: 'capsule',
  // A flat ring, exactly `glow`'s shape — see `marker.ts` for why the geometry is shared but the
  // material is not.
  marker: 'torus',
};

/**
 * What casts a shadow, and — by its absence — what does not. M4.
 *
 * `receiveShadow` is **not** here: everything receives, always, set once when a wrapper is minted.
 * (In r185 that is a uniform rather than a define — `WebGLRenderer.js:2690` — so varying it would
 * cost no program, which is worth knowing and is not the reason. The reason is that there is nothing
 * in a grey-box scene that should be exempt from moonlight, and a second per-archetype table whose
 * every entry is `true` is a table that will one day be wrong in one row.)
 *
 * `castShadow` is what varies, and it decides membership of the shadow render list rather than
 * anything about the shader:
 *
 * - **`ground` does not cast.** A 0.2 m slab shadowing the slab beside it is acne with a long name,
 *   and there is nothing under it at M4 for a real shadow to land on. Excluding it also halves the
 *   shadow pass's draw calls, because ground is the one archetype every chunk has.
 * - **`portal` and `glow` do not cast.** They are light sources. A ring that occludes the moon reads
 *   as a hole in the world rather than as a thing that shines.
 * - **`marker` does not cast**, for the same reason as `portal`/`glow`: it is a UI cue floating a few
 *   centimetres off the ground, not an object, and a shadow under a destination ring would read as a
 *   solid disc sitting on the grass rather than as a mark on it.
 * - Everything with height casts, including bodies: the plan's *"soft moon shadows"* is mostly walls
 *   and props, but a character with no shadow floats however good the terrain looks.
 */
export const ARCHETYPE_CASTS: Readonly<Record<Archetype, boolean>> = {
  ground: false,
  edge: true,
  barrier: true,
  door: true,
  doorOpen: true,
  portal: false,
  glow: false,
  stair: true,
  prop: true,
  landmark: true,
  self: true,
  other: true,
  marker: false,
};

/**
 * How much light a thing makes of its own — M4's *"emissive portal rings"*, as a table.
 *
 * The numbers are `emissiveIntensity`, and they are above one on purpose: the composer's buffers are
 * `HalfFloatType`, so a ring at 5.5 hands the bloom pass a value five and a half times display white
 * and gets a halo instead of a flat clipped disc. That is the entire mechanism behind the reference
 * image's glowing gate, and it only works because the grade happens *after* the bloom (see `post.ts`).
 *
 * The stairwell marker is at 0.9 — under the bloom threshold, by design. §6-M4 asks for *"the
 * horizontal rings the full emissive treatment"* and stairwells only a *"subtle glow marker"*, and the
 * cheapest way to keep those apart is a value that cannot reach the bloom even if the selection
 * mask fails.
 *
 * `marker` sits between the two at 1.1: brighter than the stairwell hint, because a destination the
 * player just chose should read more insistently than a passive "there is a way down here", but nowhere
 * near the portal's 5.5 — a walk-to ring is not a gate to somewhere else and must not compete with one
 * for the eye. Fixed rather than pulsed through this table: `marker.ts` breathes its *scale* instead,
 * carrying over `scene.ts:2756-2764`'s tween rather than reusing the portal's emissive swing, so it is
 * never added to `pool.ts`'s `pulse()` list and this number never changes at runtime.
 */
export const ARCHETYPE_EMISSIVE: Readonly<Partial<Record<Archetype, number>>> = {
  portal: 5.5,
  glow: 0.9,
  marker: 1.1,
};

/**
 * How far the portal's emissive swings, and how fast, in Hz.
 *
 * Time-based and therefore exempt from the determinism rule — and it has to stay exempt by being
 * *unread*: nothing samples the pulse, nothing derives a position from it, and the server never hears
 * of it. A ring that sat at a constant value would read as a texture rather than as a thing that is on.
 */
export const PORTAL_PULSE_DEPTH = 0.18;
export const PORTAL_PULSE_HZ = 0.28;

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A material's identity: archetype, the sector when the archetype is terrain, and whether this is
 * the faded twin.
 *
 * A string rather than a tuple because it is a `Map` key on the hot path of every chunk build, and
 * because a dump of the pool should be legible: `ground|forest`, `barrier|cave|dim`, `portal`.
 */
export type MaterialKey = string;

export function materialKey(archetype: Archetype, sector: Sector | undefined, faded: boolean): MaterialKey {
  const biome = BIOME_KEYED.has(archetype) ? `|${sector ?? SECTORS[0]}` : '';
  return `${archetype}${biome}${faded && !NEVER_FADED.has(archetype) ? '|dim' : ''}`;
}

/** Every key {@link materialKey} can ever return, enumerated once. The pool is built from this. */
export const MATERIAL_KEYS: readonly MaterialKey[] = (() => {
  const keys: MaterialKey[] = [];
  for (const archetype of ARCHETYPES) {
    const sectors = BIOME_KEYED.has(archetype) ? SECTORS : ([undefined] as const);
    for (const sector of sectors) {
      keys.push(materialKey(archetype, sector, false));
      if (!NEVER_FADED.has(archetype)) keys.push(materialKey(archetype, sector, true));
    }
  }
  return keys;
})();

/* -------------------------------------------------------------------------- */
/* Colour                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Grey-box biome colours: the ground you stand on, and the thing that walls it in.
 *
 * Flat, unlit, deliberately drab. M4 is the milestone that decides whether the *light* matches the
 * reference, and a palette tuned now would be tuned against no lighting at all and thrown away.
 * What these have to do is one job: make it obvious at a glance which sector a room resolved to,
 * because M1 changed 9.5% of the world's sectors and this is the first time anyone can look at the
 * result.
 */
const SECTOR_COLOUR: Readonly<Record<Sector, { readonly ground: number; readonly dressing: number }>> = {
  inside: { ground: 0x6b6055, dressing: 0x8a7b66 },
  city: { ground: 0x7a7570, dressing: 0x9a9088 },
  road: { ground: 0x8a7a5c, dressing: 0x6d6248 },
  field: { ground: 0x6f8a4a, dressing: 0x54683a },
  forest: { ground: 0x3f6437, dressing: 0x25401f },
  hills: { ground: 0x7d8a53, dressing: 0x5c6640 },
  mountain: { ground: 0x8b8578, dressing: 0x615c53 },
  swamp: { ground: 0x4d5a3a, dressing: 0x36402a },
  desert: { ground: 0xc2ab74, dressing: 0x9a875a },
  arctic: { ground: 0xd6dee4, dressing: 0xa8b4bd },
  cave: { ground: 0x4a4640, dressing: 0x322f2b },
  shallow_water: { ground: 0x4f7f96, dressing: 0x3b6070 },
  deep_water: { ground: 0x2e5470, dressing: 0x224054 },
  underwater: { ground: 0x27485c, dressing: 0x1b3444 },
  air: { ground: 0x8fb8d8, dressing: 0x6f92ac },
  astral: { ground: 0x7a63a8, dressing: 0x584878 },
};

/** Dressing colours for the archetypes that are objects rather than terrain. */
const OBJECT_COLOUR: Readonly<Record<Archetype, number>> = {
  ground: 0x000000,
  edge: 0x000000,
  barrier: 0x000000,
  door: 0xd0a070,
  doorOpen: 0x9a7048,
  // The reference image's ring. The *diffuse* is near-black on purpose — a portal is a thing that
  // emits, not a thing that is lit, and a bright albedo under it would put moonlight on the tube and
  // flatten the glow. All of its colour is in `ARCHETYPE_EMISSIVE`.
  portal: 0x0a1416,
  glow: 0x0d1614,
  stair: 0xdad2bc,
  prop: 0x8a7f6a,
  landmark: 0xc9b483,
  // Self and others are told apart by colour and by nothing else at M3 — no nameplates until M7.
  self: 0x5fd0ff,
  other: 0xff9a5c,
  // Near-black, the same reasoning as `portal`/`glow` above: a destination ring emits, it is not lit.
  marker: 0x1a1710,
};

/**
 * What the emissive archetypes actually shine, as distinct from what they reflect.
 *
 * The reference's gate is a saturated cyan and the stairwell marker a colder, quieter teal, so that
 * one reads as "somewhere else" and the other as "another floor" without a legend. The destination
 * marker takes a third, warm hue for the same reason: `0xffe9a8` is `scene.ts:822`'s `PATH_COLOUR`,
 * unchanged — the one piece of the 2D route's look this port keeps, so a player who has used both
 * clients reads "that is where I am walking" in the same colour on either one.
 */
export const EMISSIVE_COLOUR: Readonly<Partial<Record<Archetype, number>>> = {
  portal: 0x64e2ff,
  glow: 0x74d9c0,
  marker: 0xffe9a8,
};

/** The colour a material key paints. A pure function of the key's three parts. */
export function archetypeColour(archetype: Archetype, sector: Sector | undefined): number {
  if (archetype === 'ground') return SECTOR_COLOUR[sector ?? 'field'].ground;
  if (archetype === 'edge') return SECTOR_COLOUR[sector ?? 'field'].dressing;
  // A barrier is the same material as an edge, darkened — thickness is what says "you cannot pass",
  // and a second hue would say something the classification does not mean.
  if (archetype === 'barrier') return darken(SECTOR_COLOUR[sector ?? 'field'].dressing, 0.7);
  return OBJECT_COLOUR[archetype];
}

function darken(colour: number, factor: number): number {
  const r = Math.round(((colour >> 16) & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/**
 * How much of a faded thing is left.
 *
 * **M4 took one of this twin's two jobs away and left it the other.** At M3 it meant both "the level
 * below" and "ground you have never seen", because there was no third state to give the second one.
 * There is now: fog of war is `instanceColor` (`fogOfWar.ts`) and an unexplored room is drawn *opaque
 * and near-black* — a silhouette, which is what unexplored ground should be — while transparency is
 * reserved for the one statement it is actually right for.
 *
 * That statement is the plan's *"the camera renders the player's level plus one below (faded, for the
 * cliff/shaft read)"*. A level below has to be see-*through*, not merely dark, or a shaft reads as a
 * floor with a stain on it. The two meanings are now in two registers because they were always two
 * meanings.
 */
export const FADE_OPACITY = 0.3;

/* -------------------------------------------------------------------------- */
/* Dimensions                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Metres, and every one of them a decision the geometry can be read back from.
 *
 * The only load-bearing pair is `edgeThickness` against `barrierThickness`. The plan calls a barrier
 * a *correctness requirement, not aesthetics* — "must be visually solid and thicker than an `edge`,
 * because the player can otherwise see into a room they cannot reach" — so the two numbers differ by
 * more than a rendering tolerance and `chunkPlan.test.ts` asserts the inequality rather than the
 * values.
 */
export const DIMENSIONS = {
  /** How deep the ground slab is. Thick enough to have a visible side where a level drops away. */
  groundThickness: 0.2,
  edgeThickness: 0.6,
  edgeHeight: 3,
  barrierThickness: 1.4,
  barrierHeight: 3.6,
  doorThickness: 0.35,
  doorHeight: 2.6,
  /** Ring radius and tube radius, before the per-instance scale. */
  portalRadius: 1.5,
  portalTube: 0.2,
  /**
   * The stairwell marker: a ring laid flat on the floor around the flight's mouth.
   *
   * Wide enough to enclose the {@link chunkPlan} stair block's three-metre span and low enough that a
   * character walks over it rather than into it. Its whole job is to be the thing you notice when a
   * room has a way down in it, from across the room, at a 64 degree camera.
   */
  glowRadius: 1.7,
  glowLift: 0.08,
  /** How many boxes a flight of stairs is cut into. A ramp is one. */
  stairSteps: 4,
  stairThickness: 0.35,
  propHeight: 1.2,
  landmarkHeight: 2.2,
  /** A body: `PLAYER_RADIUS` is 10 px = 0.31 m, so the capsule is drawn at the collision box's width. */
  bodyRadius: 0.32,
  bodyHeight: 1.8,
} as const;
