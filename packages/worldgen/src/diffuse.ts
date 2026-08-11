/**
 * Terrain inference — graph label-diffusion.
 *
 * The name rules label what they can; this fills the rest from *context*. A room called "A Bend in
 * the Passage" says nothing about its terrain, but its neighbours do: a passage between cave rooms
 * is cave, and one between city streets is city. So every room the rules could not label takes the
 * majority sector of its labelled neighbours, the newly labelled become voters, and the wave repeats
 * until nothing changes. This is plain label propagation over the room graph — the structure the MUD
 * already maintains as its single source of truth about adjacency.
 *
 * ## Which edges vote
 *
 * **Every exit, both directions, portals and cross-zone links included.** That needs saying because
 * the renderer's rule is the opposite — beacons and tilemaps stop at portals, since the far side is
 * a different coordinate space. Diffusion is not geometry, it is *context*, and adjacency in the
 * room graph is context wherever the exit leads. Cross-zone edges also carry the answer for a shape
 * the survey found repeatedly: whole zones with not one classifiable name (the auto-generated
 * Underdark travel grids), which can only ever be labelled from the zone next door.
 *
 * ## Determinism
 *
 * Worldgen output must be identical run to run — `data/world` is git-ignored *because* it is
 * reproducible. Three choices keep it so:
 *
 * - **Rounds are synchronous.** Each round's votes read only the labels committed before it, so the
 *   order rooms are visited within a round cannot change the outcome.
 * - **Ties break by data, then by name.** A tied vote goes to whichever tied sector is commonest
 *   among the *seed* labels of the room's own zone — the zone's prevailing character — and a tie
 *   still standing falls to alphabetical order. Arbitrary, stated, stable.
 * - **No randomness.** Nothing here reads a clock or an RNG.
 *
 * Labels freeze once assigned. A frozen wavefront means a room between two seeded regions takes
 * whichever reaches it first — and when both arrive in the same round, the vote and the tie-break
 * above decide. Iterative relaxation could in principle refine borders, but it trades a provable
 * fixpoint for a convergence argument, and a one-room border shift is not worth that.
 */

import type { RoomId, Sector, Zone, ZoneId } from '@mygame/shared';

export interface DiffusionStats {
  /** Rooms that entered unlabelled. */
  readonly targets: number;
  /** How many of them a label reached. */
  readonly filled: number;
  /** Rooms no label could ever reach — connected components containing no seed at all. */
  readonly residual: number;
  /** Sweeps until the fixpoint. A measure of how deep the unlabelled regions run. */
  readonly rounds: number;
  /** What the filled rooms became, for the report. */
  readonly filledBySector: Readonly<Record<string, number>>;
}

export interface DiffusionResult {
  readonly zones: readonly Zone[];
  readonly stats: DiffusionStats;
  /**
   * Every room a label reached, seeds excluded — `stats.filled` is this set's size, exposed per-room
   * for callers that need to know *which* rooms diffusion actually decided (the M1 build report's
   * per-zone breakdown, and its regression tests).
   *
   * **Not the same as "the room object changed".** A room can enter unlabelled, get voted a sector
   * that happens to equal the value it already carried (its zone-tier guess agreeing with its
   * neighbours, say), and come out of {@link diffuseSectors} as the *same object reference* — see
   * "reuses room objects it did not change" in `diffuse.test.ts`. Reference identity would silently
   * undercount exactly the rooms where diffusion and the prior guess agree, which is not a rare edge
   * case: `field` alone is common enough that a defaulted room voted back to `field` by its neighbours
   * is a real, non-negligible shape. This set is built from the vote itself, not from the output
   * objects, so it is exact regardless of whether the label changed anything visible.
   */
  readonly reached: ReadonlySet<RoomId>;
}

/**
 * Fills every non-seed room's sector from its neighbours. Pure: returns new zones, mutates nothing.
 *
 * `seeds` are the rooms whose current sector is *evidence* — a name-rule match or a Duris-harvested
 * value — rather than the default the loader fell back to. Everything outside the set is treated as
 * unlabelled, whatever sector it happens to carry, and keeps its old value only if no label can
 * reach it at all.
 */
export function diffuseSectors(zones: readonly Zone[], seeds: ReadonlySet<RoomId>): DiffusionResult {
  // Room index and undirected adjacency, built in sorted order so every later iteration is too.
  const zoneOf = new Map<RoomId, ZoneId>();
  const labels = new Map<RoomId, Sector>();
  const unlabelled: RoomId[] = [];

  for (const zone of zones) {
    for (const room of zone.rooms) {
      zoneOf.set(room.id, zone.id);
      if (seeds.has(room.id)) labels.set(room.id, room.sector);
      else unlabelled.push(room.id);
    }
  }
  unlabelled.sort((a, b) => a - b);

  const neighbours = new Map<RoomId, Set<RoomId>>();
  const link = (a: RoomId, b: RoomId): void => {
    let set = neighbours.get(a);
    if (!set) neighbours.set(a, (set = new Set()));
    set.add(b);
  };
  for (const zone of zones) {
    for (const room of zone.rooms) {
      for (const exit of Object.values(room.exits)) {
        if (!exit || !zoneOf.has(exit.to)) continue; // a dangling or unloaded far side votes nowhere
        link(room.id, exit.to);
        link(exit.to, room.id); // symmetric even for one-way exits: adjacency is mutual context
      }
    }
  }

  // The tie-break table: each zone's seed-label histogram. Computed once, from seeds only, so the
  // tie-break cannot drift as diffusion itself adds labels — a judge must not count its own verdicts.
  const zoneSeedCounts = new Map<ZoneId, Map<Sector, number>>();
  for (const [id, sector] of labels) {
    const zoneId = zoneOf.get(id)!;
    let counts = zoneSeedCounts.get(zoneId);
    if (!counts) zoneSeedCounts.set(zoneId, (counts = new Map()));
    counts.set(sector, (counts.get(sector) ?? 0) + 1);
  }

  const targets = unlabelled.length;
  let open = unlabelled;
  let rounds = 0;
  const filledBySector: Record<string, number> = {};
  const reached = new Set<RoomId>();

  while (open.length > 0) {
    // Votes are collected against the labels as they stood at the top of the round and committed
    // together at the bottom — the synchronous sweep the header promises.
    const assigned: [RoomId, Sector][] = [];
    const still: RoomId[] = [];

    for (const id of open) {
      const votes = new Map<Sector, number>();
      for (const neighbour of neighbours.get(id) ?? []) {
        const sector = labels.get(neighbour);
        if (sector) votes.set(sector, (votes.get(sector) ?? 0) + 1);
      }
      if (votes.size === 0) {
        still.push(id);
        continue;
      }

      const top = Math.max(...votes.values());
      const tied = [...votes.keys()].filter((sector) => votes.get(sector) === top);
      assigned.push([id, breakTie(tied, zoneSeedCounts.get(zoneOf.get(id)!))]);
    }

    if (assigned.length === 0) break; // only unreachable rooms remain
    for (const [id, sector] of assigned) {
      labels.set(id, sector);
      reached.add(id);
      filledBySector[sector] = (filledBySector[sector] ?? 0) + 1;
    }
    open = still;
    rounds++;
  }

  const out = zones.map((zone) => ({
    ...zone,
    rooms: zone.rooms.map((room) => {
      const sector = labels.get(room.id);
      return !sector || sector === room.sector ? room : { ...room, sector };
    }),
  }));

  return {
    zones: out,
    reached,
    stats: {
      targets,
      filled: targets - open.length,
      residual: open.length,
      rounds,
      filledBySector,
    },
  };
}

/** The stated tie-break: the zone's prevailing seed sector first, alphabetical order last. */
function breakTie(tied: readonly Sector[], zoneCounts: ReadonlyMap<Sector, number> | undefined): Sector {
  if (tied.length === 1) return tied[0]!;
  let best: Sector | undefined;
  let bestScore = -1;
  for (const sector of [...tied].sort()) {
    const score = zoneCounts?.get(sector) ?? 0;
    if (score > bestScore) {
      best = sector;
      bestScore = score;
    }
  }
  return best!;
}
