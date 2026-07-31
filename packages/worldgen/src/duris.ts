/**
 * Duris `.wld` harvest: real sector types, room flags and prose.
 *
 * ## What this is for
 *
 * The zMUD mapper database has no sector column and no descriptions — mappers only ever needed
 * geometry — so `terrain.ts` *guesses* terrain from room names and 23.2% of rooms fall back to a
 * default. The Duris source is the same Sojourn lineage and its `.wld` files carry the real numbers.
 * This pass joins the two and replaces guesses with data wherever it can.
 *
 * ## The join, and its honest limits
 *
 * **Room ids do not match.** Toril and Duris split in 1995 and renumbered independently — measured on
 * this data, the best constant vnum offset for a matched zone is agreed by only 4–11 of its rooms out
 * of 25–100, across 20–68 distinct candidate offsets. There is no arithmetic shortcut.
 *
 * So the join is by **room name**, in two stages:
 *
 * 1. **Zone to file**, by voting. Every room name that Duris knows anywhere casts a vote for the
 *    files containing it; the winner must cover ≥30% of the zone and beat the runner-up ≥2×. Duris
 *    renamed many inherited zones, so zone *names* cannot be joined — room names are the world's
 *    actual prose and largely survived on both sides.
 * 2. **Room to room**, by name within the winning file only. Restricting to one file is what makes
 *    this safe: "Gravel Path" occurs in hundreds of zones, and a global name lookup would import
 *    another zone's terrain.
 *
 * Measured yield: **49 of 327 zones match confidently**, covering 5,919 rooms — 12.7% of the world.
 * Inside a matched zone the coverage is near-total (IceCrag Castle: 216 of 219). It is a *partial*
 * enrichment source and always will be; only 21% of Toril's distinct room names occur in Duris at
 * all.
 *
 * ## Optional by construction
 *
 * `data/zones-source/` is git-ignored and may simply not be there. Every function here degrades to
 * "no enrichment" rather than throwing, because the project rule is that the engine must always be
 * able to build against a world it did not import.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Room, RoomFlag, RoomId, Sector, Zone } from '@mygame/shared';

/* -------------------------------------------------------------------------- */
/* Format                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Duris colour codes, which appear inside names and descriptions and must come out before use.
 *
 * Four shapes: `&n`/`&N` to reset, `&+X`/`&-X` for a foreground/background colour, and `&=XX` for a
 * pair. Stripping is not cosmetic — a name with codes in it will not join, because the join is on
 * normalised text.
 */
const COLOUR_CODE = /&(?:[nN]|[+\-][A-Za-z]|=[A-Za-z]{2})/g;

export function stripColour(text: string): string {
  return text.replace(COLOUR_CODE, '');
}

/** Room name reduced to a join key: colour stripped, punctuation flattened, case folded. */
export function normaliseName(name: string): string {
  return stripColour(name)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DurisRoom {
  readonly vnum: number;
  /** Source file, which is the unit the zone match resolves to. */
  readonly file: string;
  readonly name: string;
  /** {@link normaliseName} of `name`. The join key. */
  readonly key: string;
  readonly description: string;
  /** Raw `room_flags` bitfield. See {@link ROOM_FLAG_BITS}. */
  readonly flags: number;
  /** Raw `sector_type`. See {@link DURIS_SECTOR}. */
  readonly sector: number;
}

/**
 * Parses one `.wld` file.
 *
 * Record layout, classic Diku:
 *
 * ```
 * #<vnum>
 * <name>~
 * <description...>
 * ~
 * <zone> <room_flags> <sector_type>
 * D<0-5> ... exit records ...
 * E ... extra descriptions ...
 * S
 * ```
 *
 * Walked line by line rather than split on a `/^#(\d+)$/m` regex. That is not a style preference:
 * `areas/wld/surface.wld` is large enough that the regex split overflows the call stack, and a
 * parser that silently drops the biggest file in the set is worse than one that is slightly longer.
 *
 * Only the header is read. Exit records are deliberately ignored — the room graph comes from the
 * zMUD map, the two disagree after thirty years of independent editing, and Diku's direction
 * encoding is a *third* one in this project (`0=N, 1=E, 2=S, 3=W, 4=U, 5=D`). Nothing here needs to
 * touch it, so nothing here can get it wrong.
 */
export function parseWld(text: string, file: string): DurisRoom[] {
  const lines = text.split(/\r?\n/);
  const rooms: DurisRoom[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = /^#(\d+)\s*$/.exec(lines[i] ?? '');
    if (!header) {
      i++;
      continue;
    }
    const vnum = Number(header[1]);
    i++;

    // Name, terminated by `~` — which is usually on the same line but is not guaranteed to be.
    let name = '';
    while (i < lines.length && !(lines[i] ?? '').includes('~')) {
      name += `${lines[i] ?? ''} `;
      i++;
    }
    name += (lines[i] ?? '').split('~')[0] ?? '';
    i++;

    // Description, terminated by a line that is nothing but `~`.
    const description: string[] = [];
    while (i < lines.length && (lines[i] ?? '').trim() !== '~') {
      description.push(lines[i] ?? '');
      i++;
    }
    i++;

    while (i < lines.length && (lines[i] ?? '').trim() === '') i++;
    const numbers = (lines[i] ?? '').trim().split(/\s+/).map(Number);
    i++;

    // A record whose numeric line is not three numbers is malformed; skip it rather than importing
    // a NaN sector that would render as the fallback everywhere.
    if (numbers.length < 3 || !Number.isFinite(numbers[1]) || !Number.isFinite(numbers[2])) continue;

    rooms.push({
      vnum,
      file,
      name: stripColour(name).trim(),
      key: normaliseName(name),
      description: cleanDescription(description.join('\n')),
      flags: numbers[1]!,
      sector: numbers[2]!,
    });
  }

  return rooms;
}

/**
 * Room prose, tidied for a chat log rather than an 80-column terminal.
 *
 * Diku descriptions are hard-wrapped at ~78 characters with a leading space or three on the first
 * line. Left alone they wrap twice — once by the author and once by the browser — which reads as
 * ragged nonsense at any panel width. Paragraph breaks are kept; line breaks inside a paragraph are
 * not, because they were a typesetting decision for a terminal we are not using.
 */
function cleanDescription(raw: string): string {
  return stripColour(raw)
    .split(/\n\s*\n/)
    .map((para) => para.split('\n').map((l) => l.trim()).join(' ').trim())
    .filter((para) => para.length > 0)
    .join('\n\n')
    .trim();
}

/** Reads every `.wld` in a directory. Returns an empty map if the directory is not there. */
export function loadDurisRooms(wldDir: string): Map<string, DurisRoom[]> {
  const byFile = new Map<string, DurisRoom[]>();
  let files: string[];
  try {
    files = readdirSync(wldDir);
  } catch {
    return byFile;
  }
  for (const file of files) {
    if (!file.endsWith('.wld')) continue;
    try {
      // latin1, not utf8: these files predate UTF-8 in practice and carry high-bit bytes that would
      // decode to replacement characters and break the join on the affected names.
      byFile.set(file, parseWld(readFileSync(join(wldDir, file), 'latin1'), file));
    } catch {
      // One unreadable file must not cost the other 446.
    }
  }
  return byFile;
}

/* -------------------------------------------------------------------------- */
/* Sectors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Duris `sector_type` (`SECT_*` in `defines.h`) to ours.
 *
 * Duris has 40 sectors and we have 16, and the two vocabularies are not nested — the mapping is
 * lossy in both directions and worth reading rather than skimming:
 *
 * - **Duris splits the underworld ten ways** (wild / city / inside / water / noswim / mountain /
 *   slime / low-ceiling / liquid-mithril / mushroom) where we have one `cave`. The city and inside
 *   variants keep their surface equivalents instead, because those describe what a room *looks*
 *   like, which is what our sector actually drives; everything else down there is rock.
 * - **The high sectors are late additions and the old zones predate them.** `SECT_ROAD` is 37 of 40
 *   and appears on 306 of 781,053 rooms; `SECT_SWAMP` and `SECT_ARCTIC` are 26 and 25 and total
 *   ~12k. Builders of everything older reached for `field` or `city` instead — which is why
 *   {@link BLIND_SPOT} keeps our more specific guess against those two generic reaches, and why this
 *   table must still map the high values: the phase-3 version stopped at 24, and every room carrying
 *   a later sector — all 47k of them, arctic and swamp included — was silently dropped as evidence.
 *   "Duris has no swamp" was this table's gap, not the data's.
 * - **The elemental planes** collapse to the nearest thing we can draw. There is no fire plane here,
 *   though `SECT_LAVA` gets `mountain` — volcanic rock is a look we have; a plane is not.
 */
export const DURIS_SECTOR: Readonly<Record<number, Sector>> = {
  0: 'inside',
  1: 'city',
  2: 'field',
  3: 'forest',
  4: 'hills',
  5: 'mountain',
  6: 'shallow_water',
  7: 'deep_water',
  8: 'air',
  9: 'underwater',
  10: 'underwater',
  11: 'astral',
  12: 'deep_water',
  13: 'cave',
  14: 'city',
  15: 'inside',
  16: 'shallow_water',
  17: 'deep_water',
  18: 'air',
  19: 'air',
  20: 'deep_water',
  21: 'cave',
  22: 'astral',
  23: 'astral',
  24: 'desert',
  25: 'arctic',
  26: 'swamp',
  27: 'cave', // SECT_UNDRWLD_MOUNTAIN — a mountain under the world is rock overhead, which is cave
  28: 'cave', // SECT_UNDRWLD_SLIME
  29: 'cave', // SECT_UNDRWLD_LOWCEIL
  30: 'cave', // SECT_UNDRWLD_LIQMITH
  31: 'cave', // SECT_UNDRWLD_MUSHROOM — a mushroom forest would render surface trees; it is a cave
  32: 'city', // SECT_CASTLE_WALL
  33: 'city', // SECT_CASTLE_GATE
  34: 'city', // SECT_CASTLE — the fortification itself: exterior stonework, not an interior
  35: 'astral', // SECT_NEG_PLANE
  36: 'astral', // SECT_PLANE_OF_AVERNUS
  37: 'road',
  38: 'forest', // SECT_SNOWY_FOREST — the trees are the look; we have no snowy variant
  39: 'mountain', // SECT_LAVA
};

/**
 * Sectors Duris' builders could mostly not express when the zones were written.
 *
 * The original claim here — "sectors we can express and Duris cannot" — turned out to be this file's
 * own gap: `SECT_ROAD`, `SECT_SWAMP` and `SECT_ARCTIC` exist in `defines.h`, but as late additions
 * (25, 26 and 37 of 40) that the old zones predate almost entirely — road appears on 306 rooms in
 * 781k. So the rule survives its premise being corrected: where a zone *does* use the late sectors
 * the harvest now takes them directly, and where a builder reached for `field` or `inside` because
 * their zone was older than the word, our more specific guess is still kept. A guess landing in this
 * set against one of the two generic buckets is information the *file* could not carry, even though
 * the format eventually could.
 *
 * This is the one heuristic in this module and it is deliberately narrow. The alternative — letting
 * real data always win — turns every road into a field and every bog into a field, which is a
 * visible downgrade on the map for no gain in truth: Duris did not decide those rooms were fields,
 * it had no other word at the time.
 */
const BLIND_SPOT: ReadonlySet<Sector> = new Set<Sector>(['road', 'swamp', 'arctic']);
const GENERIC: ReadonlySet<Sector> = new Set<Sector>(['field', 'inside']);

/**
 * Whether one of our sectors and a Duris one are the same claim about a room, under the blind-spot
 * rule above. Exported for the diffusion validation, which must score predictions by the *same*
 * standard the harvest applies when deciding whether to overwrite: a predicted `road` against a
 * harvested `field` is not a miss, it is the exact case the harvest itself rules our way. One
 * definition, so the report and the harvest cannot come to grade the same pair differently.
 */
export function harvestCompatible(ours: Sector, duris: Sector): boolean {
  return ours === duris || (BLIND_SPOT.has(ours) && GENERIC.has(duris));
}

/* -------------------------------------------------------------------------- */
/* Flags                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Duris `ROOM_*` bits to our {@link RoomFlag}s.
 *
 * `BIT_n` in `defines.h` is `1 << (n - 1)` — verified against `BIT_12 = 2048` and
 * `BIT_32 = 2147483648`, because an off-by-one here would silently import the wrong flag entirely and
 * every value would still look plausible.
 *
 * Three of our eight flags are **not here, and cannot be**:
 *
 * - `peaceful` — Duris has no `ROOM_PEACE`. A distinct concept from `safe` and left unpopulated.
 * - `death_trap` — no `ROOM_DEATH` either.
 * - and `safe` is not `ROOM_SAFE`. See {@link SAFE_BITS}.
 */
export const ROOM_FLAG_BITS: readonly (readonly [bit: number, flag: RoomFlag])[] = [
  [1 << 0, 'dark'],      // ROOM_DARK
  [1 << 2, 'no_mob'],    // ROOM_NO_MOB
  [1 << 3, 'indoors'],   // ROOM_INDOORS
  [1 << 6, 'no_recall'], // ROOM_NO_RECALL
  [1 << 7, 'no_magic'],  // ROOM_NO_MAGIC
];

/**
 * What makes a room a sanctuary: **an inn**.
 *
 * The design rule is the owner's, and it is a sharper rule than the source data's: *"the only safe
 * rooms should be inns. If you wander out of the inn you are in the world of the MUD and it comes
 * with all the dangers."* So `safe` is harvested from `ROOM_INN` rather than from `ROOM_SAFE`.
 *
 * That turns out to be the only way to get any sanctuary at all. Measured across all 781,053 Duris
 * rooms, `ROOM_SAFE` is set on **11** of them and none is in a zone we match; `ROOM_INN` is set on
 * 88 and two of those are reachable in our world. `ROOM_SAFE` is unioned in anyway, because where an
 * upstream builder said "safe" outright they meant it.
 *
 * Temples and churches may be sprinkled in later. When they are, they are authored content, not a
 * harvest — nothing upstream marks them.
 */
const SAFE_BITS = (1 << 19) /* ROOM_INN */ | (1 << 11) /* ROOM_SAFE */;

/** The flags a bitfield carries, in {@link ROOM_FLAG_BITS} order so output is deterministic. */
export function flagsFrom(bits: number): RoomFlag[] {
  const flags: RoomFlag[] = [];
  for (const [bit, flag] of ROOM_FLAG_BITS) if ((bits & bit) !== 0) flags.push(flag);
  if ((bits & SAFE_BITS) !== 0) flags.push('safe');
  return flags;
}

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/** A zone matched to a `.wld` file, with the evidence that matched it. */
export interface ZoneMatch {
  readonly file: string;
  /** Fraction of the zone's rooms whose name Duris knows *in this file*. */
  readonly overlap: number;
  /** How far ahead of the runner-up. `Infinity` when nothing else scored. */
  readonly margin: number;
}

/** Minimum evidence to accept a zone match. Below either bar the zone is left entirely alone. */
export const MIN_OVERLAP = 0.3;
export const MIN_MARGIN = 2;

/**
 * Which `.wld` file a zone came from, or nothing.
 *
 * Votes on the *file*, not the zone number in the file's header — a Duris zone number means nothing
 * on our side, and several inherited zones were split or merged across files.
 *
 * The two thresholds are what stop a plausible-looking wrong answer. Overlap alone is not enough: a
 * four-room zone whose rooms are all called "A Dark Tunnel" would match the first wilderness file
 * containing that name at 100%. The margin is what catches that.
 */
export function matchZone(zone: Zone, nameToFiles: ReadonlyMap<string, ReadonlySet<string>>): ZoneMatch | undefined {
  const votes = new Map<string, number>();
  for (const room of zone.rooms) {
    const files = nameToFiles.get(normaliseName(room.name));
    if (!files) continue;
    // One vote per file per room, even when a file holds that name many times — otherwise a
    // wilderness zone with a thousand identical rooms outvotes every real match.
    for (const file of files) votes.set(file, (votes.get(file) ?? 0) + 1);
  }

  const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const top = ranked[0];
  if (!top || zone.rooms.length === 0) return undefined;

  const second = ranked[1];
  const overlap = top[1] / zone.rooms.length;
  const margin = second ? top[1] / second[1] : Number.POSITIVE_INFINITY;
  if (overlap < MIN_OVERLAP || margin < MIN_MARGIN) return undefined;
  return { file: top[0], overlap, margin };
}

/** Name index across every file, for the zone vote. */
export function buildNameIndex(byFile: ReadonlyMap<string, readonly DurisRoom[]>): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const [file, rooms] of byFile) {
    for (const room of rooms) {
      if (!room.key) continue;
      let files = index.get(room.key);
      if (!files) {
        files = new Set();
        index.set(room.key, files);
      }
      files.add(file);
    }
  }
  return index;
}

/* -------------------------------------------------------------------------- */
/* Enrichment                                                                  */
/* -------------------------------------------------------------------------- */

export interface HarvestStats {
  /** Zones that met both thresholds. */
  matchedZones: number;
  /** Zones with some name overlap that failed a threshold — the interesting near-misses. */
  rejectedZones: number;
  roomsInMatchedZones: number;
  /** Rooms that found at least one same-named room in the matched file. */
  joined: number;
  sectorsReplaced: number;
  /** Joined rooms whose candidates disagreed on sector, so the guess was kept. */
  sectorConflicts: number;
  /** Joined rooms whose guess was in Duris' blind spot and was kept. See `BLIND_SPOT`. */
  sectorsKeptBlindSpot: number;
  descriptions: number;
  flagged: number;
  safeRooms: number;
  flagCounts: Record<string, number>;
}

export function newHarvestStats(): HarvestStats {
  return {
    matchedZones: 0,
    rejectedZones: 0,
    roomsInMatchedZones: 0,
    joined: 0,
    sectorsReplaced: 0,
    sectorConflicts: 0,
    sectorsKeptBlindSpot: 0,
    descriptions: 0,
    flagged: 0,
    safeRooms: 0,
    flagCounts: {},
  };
}

/**
 * Returns a copy of `zone` enriched from its matched `.wld` file, and records what happened.
 *
 * Immutable in, immutable out — the caller decides whether to keep the result, which keeps this
 * testable and keeps a half-applied harvest impossible.
 *
 * Where several Duris rooms share a name, they are combined rather than one being picked:
 *
 * - **Sector** must be unanimous. Rooms sharing a name in one zone are almost always the same kind
 *   of room, so a disagreement means the name is generic ("A Dark Tunnel") and the honest answer is
 *   to keep the guess rather than take a coin flip.
 * - **Flags** are intersected. A flag is applied only when *every* candidate carries it, which is
 *   the conservative direction for every flag we import: wrongly marking a room `safe` or `no_magic`
 *   changes what the player may do there.
 * - **Description** takes the longest, which is the one most likely to be the real room rather than
 *   a stub.
 */
export function enrichZone(
  zone: Zone,
  durisRooms: readonly DurisRoom[],
  stats: HarvestStats,
  /**
   * Collects the rooms whose sector Duris pronounced on unambiguously — replaced, confirmed equal,
   * or kept over a generic (the blind-spot rule). The diffusion stage seeds from this set: a room
   * Duris *confirmed* as field must not be treated as the loader's fallback and relabelled from its
   * neighbours, and without this record the two cases are the same bytes.
   */
  sectored: Set<RoomId> = new Set(),
): Zone {
  const byKey = new Map<string, DurisRoom[]>();
  for (const room of durisRooms) {
    if (!room.key) continue;
    const bucket = byKey.get(room.key);
    if (bucket) bucket.push(room);
    else byKey.set(room.key, [room]);
  }

  stats.roomsInMatchedZones += zone.rooms.length;

  const rooms = zone.rooms.map((room): Room => {
    const candidates = byKey.get(normaliseName(room.name));
    if (!candidates || candidates.length === 0) return room;
    stats.joined++;

    let next = room;

    // ---- sector ----
    const sectors = new Set(candidates.map((c) => DURIS_SECTOR[c.sector]).filter((s): s is Sector => !!s));
    if (sectors.size > 1) {
      // Ambiguous, so it settles nothing: the room keeps its inferred sector and stays eligible for
      // diffusion if that guess was the default.
      stats.sectorConflicts++;
    } else if (sectors.size === 1) {
      sectored.add(room.id);
      const harvested = [...sectors][0]!;
      if (BLIND_SPOT.has(room.sector) && GENERIC.has(harvested)) {
        // Duris had no word for what we inferred, and reached for a generic one. Keep ours.
        stats.sectorsKeptBlindSpot++;
      } else if (harvested !== room.sector) {
        next = { ...next, sector: harvested };
        stats.sectorsReplaced++;
      }
    }

    // ---- description ----
    const longest = candidates.reduce(
      (best, c) => (c.description.length > best.length ? c.description : best),
      '',
    );
    // A stub of a dozen characters is not prose; it is a builder's placeholder.
    if (longest.length > 20) {
      next = { ...next, description: longest };
      stats.descriptions++;
    }

    // ---- flags ----
    const intersected = candidates.reduce((acc, c) => acc & c.flags, 0xffffffff);
    const flags = flagsFrom(intersected);
    if (flags.length > 0) {
      next = { ...next, flags };
      stats.flagged++;
      for (const flag of flags) stats.flagCounts[flag] = (stats.flagCounts[flag] ?? 0) + 1;
      if (flags.includes('safe')) stats.safeRooms++;
    }

    return next;
  });

  return { ...zone, rooms };
}

export interface HarvestResult {
  readonly zones: readonly Zone[];
  readonly stats: HarvestStats;
  /** Per-zone match evidence, for the report. */
  readonly matches: ReadonlyMap<number, ZoneMatch>;
  /** Rooms whose sector Duris settled unambiguously. See {@link enrichZone}. */
  readonly sectored: ReadonlySet<RoomId>;
}

/**
 * Enriches every zone that matches a `.wld` file, leaving the rest untouched.
 *
 * A missing or empty Duris directory is not an error: the result is the input, and the caller says
 * so in its report. That is what keeps `npm run worldgen` working on a checkout with no third-party
 * data in it.
 */
export function harvest(zones: readonly Zone[], wldDir: string): HarvestResult {
  const stats = newHarvestStats();
  const matches = new Map<number, ZoneMatch>();
  const sectored = new Set<RoomId>();

  const byFile = loadDurisRooms(wldDir);
  if (byFile.size === 0) return { zones, stats, matches, sectored };

  const nameIndex = buildNameIndex(byFile);

  const enriched = zones.map((zone) => {
    const match = matchZone(zone, nameIndex);
    if (!match) {
      // Only count it as a rejection if there was *something* to reject — most zones simply have no
      // overlap at all, and calling those near-misses would make the number meaningless.
      const anyOverlap = zone.rooms.some((r) => nameIndex.has(normaliseName(r.name)));
      if (anyOverlap) stats.rejectedZones++;
      return zone;
    }
    stats.matchedZones++;
    matches.set(zone.id, match);
    return enrichZone(zone, byFile.get(match.file) ?? [], stats, sectored);
  });

  return { zones: enriched, stats, matches, sectored };
}
