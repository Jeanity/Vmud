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
 * - Everything else gets one material: 8.
 * - Everything except the two body archetypes gets a faded twin (see {@link FADE_OPACITY}): 54.
 *
 * **110 materials, created once at startup, never again.** That reads like a lot and is not: colour
 * is a uniform rather than a shader define, so all 110 share two compiled programs (opaque and
 * transparent) and the objects themselves are a few hundred bytes each.
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
 * The four unit shapes. Everything drawn at M3 is one of these under a scale.
 *
 * `box` covers ground, walls, doors, steps, ramps and props; `cone` is the landmark slot; `torus` is
 * the portal ring — the plan's emissive ring, unlit and grey until M4 gives it a light; `capsule` is
 * a body. A fifth shape is a change to this list and to the test that counts it.
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
  'stair',
  'prop',
  'landmark',
  'self',
  'other',
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
 * level — so a faded capsule would be a variant nothing can produce.
 */
const NEVER_FADED: ReadonlySet<Archetype> = new Set<Archetype>(['self', 'other']);

export const ARCHETYPE_GEOMETRY: Readonly<Record<Archetype, GeometryKey>> = {
  ground: 'box',
  edge: 'box',
  barrier: 'box',
  door: 'box',
  doorOpen: 'box',
  portal: 'torus',
  stair: 'box',
  prop: 'box',
  landmark: 'cone',
  self: 'capsule',
  other: 'capsule',
};

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
  // The reference image's ring, in grey-box. Bright enough to find in a flat scene, and the one
  // thing here that is *meant* to look wrong until M4 makes it emissive.
  portal: 0x7fd8ff,
  stair: 0xdad2bc,
  prop: 0x8a7f6a,
  landmark: 0xc9b483,
  // Self and others are told apart by colour and by nothing else at M3 — no nameplates until M7.
  self: 0x5fd0ff,
  other: 0xff9a5c,
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
 * Two things fade and they are the same statement: **ground that is not fully present.** The level
 * below (the plan's "faded, for the cliff/shaft read") and ground this character has never seen (the
 * fog, as a per-room dimming — M3's stand-in for M4's per-chunk uniform). One variant serves both
 * because a player needs to know "you are not standing there" in exactly one visual register, and
 * two registers for one meaning is how a scene stops being readable.
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
  /** How many boxes a flight of stairs is cut into. A ramp is one. */
  stairSteps: 4,
  stairThickness: 0.35,
  propHeight: 1.2,
  landmarkHeight: 2.2,
  /** A body: `PLAYER_RADIUS` is 10 px = 0.31 m, so the capsule is drawn at the collision box's width. */
  bodyRadius: 0.32,
  bodyHeight: 1.8,
} as const;
