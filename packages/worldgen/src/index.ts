/**
 * Worldgen CLI: zMUD mapper database -> validated world JSON.
 *
 *   npm run worldgen -- --stats                 report only, write nothing
 *   npm run worldgen -- --zone 390              one zone
 *   npm run worldgen -- --descriptions          include the zMUD DB's own prose
 *   npm run worldgen -- --no-duris              skip the Duris .wld harvest
 *
 * Two sources, joined here. The zMUD mapper database supplies the room graph and the geometry; the
 * Duris `.wld` files supply real sector types, room flags and prose for the zones that can be matched
 * to them. See `duris.ts` for why that join is by name and what it does and does not cover.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ExtraDescription, ItemTemplate, RoomId, Zone, ZoneSpawns } from '@mygame/shared';

import { loadAuthoredZoneDir, mergeAuthoredZones } from './authored.ts';
import { diffuseSectors, type DiffusionResult } from './diffuse.ts';
import { harvest, harvestCompatible, loadDurisRooms, type DurisRoom, type HarvestResult } from './duris.ts';
import {
  buildRoomMap,
  buildZoneSpawns,
  companionPaths,
  newSpawnStats,
  type SpawnBuildStats,
} from './mobs.ts';
import { buildCatalogue } from './objects.ts';
import { loadShops } from './shops.ts';
import type { TerrainSource } from './terrain.ts';
import { loadWorld, type WorldgenStats } from './zmud.ts';

/** What the catalogue turned out to be, for the build report. */
function reportCatalogue(catalogue: readonly ItemTemplate[]): void {
  const wearable = catalogue.filter((t) => t.slot).length;
  const weapons = catalogue.filter((t) => t.damage).length;
  const containers = catalogue.filter((t) => t.container).length;
  console.log('\n  items');
  console.log(
    '    %s catalogued — %s wearable, %s weapons, %s containers',
    String(catalogue.length).padStart(6),
    wearable,
    weapons,
    containers,
  );
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DEFAULT_DB = join(REPO_ROOT, 'data', 'zones-source', 'TorilMud.dbm');
const DEFAULT_OUT = join(REPO_ROOT, 'data', 'world');
const DEFAULT_WLD = join(REPO_ROOT, 'data', 'zones-source', 'duris', 'areas', 'wld');
/** The `areas` directory the `wld`, `mob` and `zon` folders all sit under. */
const durisAreas = (wldDir: string): string => resolve(wldDir, '..');

interface Args {
  db: string;
  out: string;
  wld: string;
  zones?: number[];
  descriptions: boolean;
  duris: boolean;
  statsOnly: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    db: DEFAULT_DB,
    out: DEFAULT_OUT,
    wld: DEFAULT_WLD,
    descriptions: false,
    duris: true,
    statsOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--db':
        args.db = resolve(argv[++i] ?? '');
        break;
      case '--out':
        args.out = resolve(argv[++i] ?? '');
        break;
      case '--wld':
        args.wld = resolve(argv[++i] ?? '');
        break;
      case '--no-duris':
        args.duris = false;
        break;
      case '--zone':
      case '--zones': {
        const list = (argv[++i] ?? '')
          .split(',')
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isFinite(n));
        args.zones = [...(args.zones ?? []), ...list];
        break;
      }
      case '--descriptions':
        args.descriptions = true;
        break;
      case '--stats':
        args.statsOnly = true;
        break;
      default:
        if (flag?.startsWith('--')) {
          console.error(`unknown flag: ${flag}`);
          process.exit(2);
        }
    }
  }
  return args;
}

function report(stats: WorldgenStats): void {
  // Node's console.log only understands %s/%d/%i/%f/%j/%o/%O/%c — width specifiers like %7d are
  // passed through literally, so pad by hand.
  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);
  const num = (n: number) => String(n).padStart(7);
  const line = (label: string, value: number, of?: number) =>
    console.log(`    ${label.padEnd(21)}${num(value)}${of === undefined ? '' : `  (${pct(value, of)})`}`);

  console.log(`\n  grid pitch detected: ${stats.pitchXY} horizontal, ${stats.pitchZ} vertical`);
  console.log(`  zones: ${stats.zones}    rooms: ${stats.rooms}    exits: ${stats.exits}`);

  console.log('\n  exit layout');
  line('exact neighbour', stats.exactNeighbour, stats.exits);
  line('portal (in-zone)', stats.portals, stats.exits);
  line('portal (cross-zone)', stats.crossZone, stats.exits);
  line('seams (walked, no ring)', stats.seams, stats.portals + stats.crossZone);

  console.log('\n  discarded');
  line('diagonal exits', stats.droppedDiagonal);
  line('special ("enter x")', stats.droppedSpecial);
  line('duplicate direction', stats.duplicateDirection);
  line('dangling', stats.dangling);
  line('leads to itself', stats.selfLinks);
  line('rooms w/o zone', stats.roomsSkippedNoZone);
  line('rooms w/o coords', stats.roomsSkippedNoCoords);
  line('cell collisions', stats.cellCollisions);

  console.log('\n  terrain inferred');
  for (const [sector, count] of Object.entries(stats.sectorCounts).sort((a, b) => b[1] - a[1])) {
    line(sector, count, stats.rooms);
  }
  const bySource = Object.entries(stats.sectorSources).sort((a, b) => b[1] - a[1]);
  console.log('    via: ' + bySource.map(([k, v]) => `${k}=${pct(v, stats.rooms)}`).join('  '));
}

/** What the Duris harvest actually replaced. Reported separately because it is a second source. */
function reportHarvest(result: HarvestResult, totalRooms: number, totalZones: number): void {
  const { stats, matches } = result;
  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);
  const num = (n: number) => String(n).padStart(7);
  const line = (label: string, value: number, of?: number) =>
    console.log(`    ${label.padEnd(21)}${num(value)}${of === undefined ? '' : `  (${pct(value, of)})`}`);

  console.log('\n  Duris harvest');
  if (stats.matchedZones === 0) {
    console.log('    no .wld data found or nothing matched; sectors remain inferred.');
    return;
  }
  line('zones matched', stats.matchedZones, totalZones);
  line('zones near-missed', stats.rejectedZones);
  line('rooms in those zones', stats.roomsInMatchedZones);
  line('rooms joined by name', stats.joined, totalRooms);
  line('sectors replaced', stats.sectorsReplaced);
  line('sector conflicts', stats.sectorConflicts);
  line('kept (Duris blind spot)', stats.sectorsKeptBlindSpot);
  line('descriptions', stats.descriptions, totalRooms);
  line('rooms flagged', stats.flagged);
  const flags = Object.entries(stats.flagCounts).sort((a, b) => b[1] - a[1]);
  if (flags.length > 0) {
    console.log('    flags: ' + flags.map(([k, v]) => `${k}=${v}`).join('  '));
  }
  // Sanctuary is the one flag with a gameplay rule attached and almost no source data, so it is
  // called out by name rather than left in the tally.
  console.log(`    safe rooms (inns): ${stats.safeRooms}`);

  const top = [...matches].sort((a, b) => b[1].overlap - a[1].overlap).slice(0, 8);
  console.log('    strongest matches:');
  for (const [zoneId, m] of top) {
    const margin = m.margin === Number.POSITIVE_INFINITY ? 'inf' : `${m.margin.toFixed(1)}x`;
    console.log(`      zone ${String(zoneId).padStart(4)} -> ${m.file.padEnd(24)} ${(100 * m.overlap).toFixed(0).padStart(3)}%  margin ${margin}`);
  }
}

/**
 * The diffusion report, plus the honesty check.
 *
 * The headline is the default share before and after — the number this stage exists to move. The
 * validation block only prints when the harvest ran, because it *is* the harvest being used as
 * ground truth: rooms Duris pronounced on that the name rules could not label are exactly the rooms
 * diffusion had to predict, so re-running diffusion with the Duris seeds withheld and comparing its
 * answers against them measures real accuracy rather than mere coverage.
 */
function reportDiffusion(
  result: DiffusionResult,
  totalRooms: number,
  defaultedBefore: number,
  validation: { readonly n: number; readonly agreed: number; readonly compatible: number } | undefined,
): void {
  const { stats } = result;
  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);
  const num = (n: number) => String(n).padStart(7);
  const line = (label: string, value: number, of?: number) =>
    console.log(`    ${label.padEnd(21)}${num(value)}${of === undefined ? '' : `  (${pct(value, of)})`}`);

  console.log('\n  terrain diffusion');
  line('unlabelled going in', stats.targets, totalRooms);
  line('filled from graph', stats.filled, totalRooms);
  line('unreachable', stats.residual, totalRooms);
  console.log(`    rounds to fixpoint   ${num(stats.rounds)}`);
  const gained = Object.entries(stats.filledBySector).sort((a, b) => b[1] - a[1]);
  if (gained.length > 0) {
    console.log('    became: ' + gained.slice(0, 8).map(([k, v]) => `${k}=${v}`).join('  '));
  }
  console.log(
    `    default share: ${pct(defaultedBefore, totalRooms)} before, ${pct(stats.residual, totalRooms)} after`,
  );
  if (validation && validation.n > 0) {
    // Two scores, deliberately. Strict equality punishes our own finer vocabulary — Duris has no
    // word for `road`, so every road prediction "disagrees" with the field or inside its builders
    // reached for. The second number applies the harvest's own blind-spot rule to the comparison,
    // which is the standard the shipped world is actually built to.
    console.log(
      `    validated against Duris: ${validation.n} held-out rooms, ` +
        `${pct(validation.agreed, validation.n)} agree exactly, ` +
        `${pct(validation.compatible, validation.n)} under the harvest's own blind-spot rule`,
    );
  }
}

/**
 * Whether the zone-name fallback (`source: 'zone'` / `'zone-suffix'`) should block diffusion from
 * overwriting a room, the way a room-level guess does — M1's brief left this an explicit judgement
 * call. Answered empirically rather than by feel, with the same held-out method `reportDiffusion`'s
 * validation above already uses for the `default` tier: find rooms where the zone-tier guess and an
 * independent Duris answer both exist, and score "keep the zone guess" against "ask the neighbours
 * instead" on the same 693 held-out rooms.
 *
 * **Measured 2026-08-11: keeping the zone guess scores 48.1% exact / 48.1% harvest-compatible; asking
 * the neighbours scores 65.5% / 69.4%.** A zone-only guess is not a strong claim about one room, it is
 * the zone's average character, and a specific neighbour vote beats the average often enough that the
 * mission's "or, if you judge it honest" clause is exercised here: `seeds` below is room/room-suffix
 * only. This function reruns the same comparison on every build — a live number in the report, not a
 * comment that can go stale — rather than trusting the one-off measurement forever.
 */
function reportZoneTierPolicy(
  preHarvestZones: readonly Zone[],
  harvestedZones: readonly Zone[],
  sources: ReadonlyMap<RoomId, TerrainSource>,
  harvested: HarvestResult,
  roomTierSeeds: ReadonlySet<RoomId>,
): void {
  const heldOut = [...harvested.sectored].filter((id) => {
    const s = sources.get(id);
    return s === 'zone' || s === 'zone-suffix';
  });
  if (heldOut.length === 0) return;

  // Truth comes from the *harvested* zones — the sector the join actually settled on for a held-out
  // room, which is what "keep" and "ask" are both being scored against.
  const truth = new Map<RoomId, Zone['rooms'][number]['sector']>();
  for (const zone of harvestedZones) for (const room of zone.rooms) truth.set(room.id, room.sector);

  // "Keep the zone guess" reads the *pre-harvest* zones — the name rules' own answer, before harvest
  // had a chance to overwrite it with the very truth being predicted. Reading this from
  // `harvestedZones` instead would silently score the harvest against itself.
  const zoneGuess = new Map<RoomId, Zone['rooms'][number]['sector']>();
  for (const zone of preHarvestZones) for (const room of zone.rooms) zoneGuess.set(room.id, room.sector);

  let keepAgree = 0;
  let keepCompatible = 0;
  for (const id of heldOut) {
    const guess = zoneGuess.get(id)!;
    const real = truth.get(id)!;
    if (guess === real) keepAgree++;
    if (harvestCompatible(guess, real)) keepCompatible++;
  }

  // "Ask the neighbours": withhold both the zone-tier guess and the held-out rooms' own harvest
  // answer from seeding, diffuse over the *harvested* zones (so neighbours carry the best available
  // evidence), and score what reaches the held-out rooms blind.
  const heldOutSet = new Set(heldOut);
  const blindSeeds = new Set<RoomId>(roomTierSeeds);
  for (const id of harvested.sectored) if (!heldOutSet.has(id)) blindSeeds.add(id);
  const blind = diffuseSectors(harvestedZones, blindSeeds);
  const predicted = new Map<RoomId, Zone['rooms'][number]['sector']>();
  for (const zone of blind.zones) for (const room of zone.rooms) predicted.set(room.id, room.sector);
  let askAgree = 0;
  let askCompatible = 0;
  for (const id of heldOut) {
    const guess = predicted.get(id)!;
    const real = truth.get(id)!;
    if (guess === real) askAgree++;
    if (harvestCompatible(guess, real)) askCompatible++;
  }

  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);
  console.log(`\n  zone-tier seed policy, validated against ${heldOut.length} held-out rooms`);
  console.log(
    `    keep the zone guess:  ${pct(keepAgree, heldOut.length)} exact, ${pct(keepCompatible, heldOut.length)} compatible`,
  );
  console.log(
    `    ask the neighbours:   ${pct(askAgree, heldOut.length)} exact, ${pct(askCompatible, heldOut.length)} compatible  <- policy in effect`,
  );
}

/** Coarse, per-room label provenance across every stage of the pipeline — the M1 build report. */
type ProvenanceBucket = 'name' | 'suffix' | 'zone' | 'harvest' | 'diffusion' | 'default';

const PROVENANCE_BUCKETS: readonly ProvenanceBucket[] = ['name', 'suffix', 'zone', 'harvest', 'diffusion', 'default'];

const zeroProvenance = (): Record<ProvenanceBucket, number> => ({
  name: 0,
  suffix: 0,
  zone: 0,
  harvest: 0,
  diffusion: 0,
  default: 0,
});

/**
 * Merges every stage's evidence into one bucket per room. `TerrainSource`'s four non-default tiers
 * collapse to three here — `'zone'` absorbs both `'zone'` and `'zone-suffix'`, because the
 * word/compound distinction that matters at the room level (a suffix guess is weaker evidence, see
 * `terrain.ts`) is no longer interesting once a room has already fallen through to its zone's name;
 * the finer split stays available in the "terrain inferred" section above for anyone who wants it.
 *
 * Precedence where a room qualifies for more than one bucket: **harvest beats every name-rule tier**,
 * because `sectored` means Duris pronounced on the room unambiguously (replaced, confirmed, or kept
 * over Duris' own generic blind spot — see `duris.ts`), which is stronger evidence than a regex match
 * even when the two happen to agree. **Diffusion only applies to rooms no seed claims** — by
 * construction `reached` and `sectored` are disjoint, since harvested rooms are always seeds (see
 * `main`), but the guard costs nothing and states the invariant rather than assuming it.
 */
function classifyProvenance(
  sources: ReadonlyMap<RoomId, TerrainSource>,
  sectored: ReadonlySet<RoomId> | undefined,
  reached: ReadonlySet<RoomId>,
): Map<RoomId, ProvenanceBucket> {
  const out = new Map<RoomId, ProvenanceBucket>();
  for (const [id, source] of sources) {
    const bucket: ProvenanceBucket =
      source === 'room' ? 'name' : source === 'room-suffix' ? 'suffix' : source === 'default' ? 'default' : 'zone';
    out.set(id, bucket);
  }
  if (sectored) for (const id of sectored) out.set(id, 'harvest');
  for (const id of reached) if (!sectored?.has(id)) out.set(id, 'diffusion');
  return out;
}

interface ZoneProvenance {
  readonly id: number;
  readonly name: string;
  readonly rooms: number;
  readonly byBucket: Readonly<Record<ProvenanceBucket, number>>;
}

export interface ProvenanceReport {
  readonly totalRooms: number;
  readonly worldwide: Readonly<Record<ProvenanceBucket, number>>;
  readonly zonesFullyDefaulted: number;
  readonly zones: readonly ZoneProvenance[];
}

/**
 * One row per zone plus the world-wide roll-up. Computed once and shared by the console report and
 * the `terrain-report.json` sidecar (see `main`), so the two can never disagree about the numbers.
 *
 * Takes `zones` from *before* the authored-world merge deliberately: authored rooms are hand-placed,
 * not inferred, so they carry no entry in `provenance` at all and are skipped (the `if (!bucket)
 * continue` below) rather than miscounted as `default`. `main` calls this ahead of that merge for
 * exactly this reason — see the call site.
 *
 * **This report's `default` count is not `reportDiffusion`'s `residual`, on purpose.** `residual` is
 * "rooms diffusion could not reach", which — since M1 stopped treating a zone-tier guess as a
 * protected seed — includes rooms that still carry a real, if weak, zone-level answer that simply had
 * no neighbour to confirm or overrule it (bucketed `zone` here, not `default`). `default` here means
 * *no evidence reached the room at all*, which is the honest reading of the M1 acceptance bar ("<2%
 * defaulted"): a room resting on its zone's name is not undecided the way a room with no name-rule
 * match and no reachable neighbour is. Concretely, in the 2026-08-11 build: `residual` is 148 rooms
 * (0.3%), of which 54 are `zone`-bucket survivors and 94 are genuinely `default` (0.2%) — the second
 * number is the one this milestone's bar is measured against.
 */
function buildProvenanceReport(zones: readonly Zone[], provenance: ReadonlyMap<RoomId, ProvenanceBucket>): ProvenanceReport {
  const world = zeroProvenance();
  let zonesFullyDefaulted = 0;
  let totalRooms = 0;

  const zoneReports: ZoneProvenance[] = [];
  for (const zone of [...zones].sort((a, b) => a.id - b.id)) {
    const counts = zeroProvenance();
    for (const room of zone.rooms) {
      const bucket = provenance.get(room.id);
      if (!bucket) continue;
      counts[bucket]++;
      world[bucket]++;
      totalRooms++;
    }
    if (zone.rooms.length > 0 && counts.default === zone.rooms.length) zonesFullyDefaulted++;
    zoneReports.push({ id: zone.id, name: zone.name, rooms: zone.rooms.length, byBucket: counts });
  }

  return { totalRooms, worldwide: world, zonesFullyDefaulted, zones: zoneReports };
}

/**
 * Prints {@link buildProvenanceReport}'s result: one line per zone, sorted by id, then the world-wide
 * summary. Every zone rather than a top-N — `reportSpawns` below sets this precedent for a
 * genuinely per-zone report, and a reviewer checking a *named* zone (the Nightwood, the Labyrinth, a
 * Grid-UD-*) needs to find it by scanning for the id, not guess whether it survived a cutoff. Long,
 * but this output is meant to be redirected and grepped like the rest of `npm run worldgen`.
 */
function reportSectorProvenance(report: ProvenanceReport): void {
  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);

  console.log('\n  terrain provenance, by zone');
  for (const zone of report.zones) {
    const b = zone.byBucket;
    const summary = PROVENANCE_BUCKETS.map((k) => `${k}=${b[k]}`).join(' ');
    console.log(
      `    zone ${String(zone.id).padStart(4)} ${zone.name.slice(0, 32).padEnd(32)} ` +
        `${String(zone.rooms).padStart(5)} rooms — ${summary}  (defaulted ${pct(b.default, zone.rooms)})`,
    );
  }

  console.log('\n  terrain provenance, world-wide');
  for (const bucket of PROVENANCE_BUCKETS) {
    const n = report.worldwide[bucket];
    console.log(`    ${bucket.padEnd(12)}${String(n).padStart(7)}  (${pct(n, report.totalRooms)})`);
  }
  console.log(
    `    zones fully defaulted: ${report.zonesFullyDefaulted} of ${report.zones.length}` +
      `    world defaulted: ${pct(report.worldwide.default, report.totalRooms)}`,
  );
}

/**
 * What the population harvest found, and — more usefully — what it lost.
 *
 * The drop rate is the number to read. A reset command whose room does not resolve is dropped rather than
 * guessed at, so this is the honest measure of how far the name join carries: about two thirds of the
 * commands, which is the same partial-source story Phase 3 told about terrain and prose.
 */
function reportSpawns(spawns: readonly ZoneSpawns[], stats: SpawnBuildStats): void {
  const pct = (n: number, d: number) => (d === 0 ? '0.0%' : `${((100 * n) / d).toFixed(1)}%`);
  const num = (n: number) => String(n).padStart(7);
  const line = (label: string, value: number, of?: number) =>
    console.log(`    ${label.padEnd(21)}${num(value)}${of === undefined ? '' : `  (${pct(value, of)})`}`);

  console.log('\n  population harvest');
  if (spawns.length === 0) {
    console.log('    no .mob/.zon data matched; the world is unpopulated.');
    return;
  }
  line('zones populated', spawns.length);
  line('mob templates', stats.templates);
  line('templates skipped', stats.templatesSkipped);
  line('rooms vnum-mapped', stats.roomsMapped);
  line('reset commands read', stats.commands);
  // "unresolved", not "no room": a command is dropped either because the room it names is not one we
  // kept or because its mob template is not one we kept. Calling it "no room" was misleading even
  // before 15c, and actively wrong now that `give`/`equip`/`put` legitimately have no room at all.
  line('dropped (unresolved)', stats.commandsDropped, stats.commands);
  // A subset of the line above, broken out because it is the only loss here that is not about rooms:
  // kit whose mob failed to place. Before Phase 16 gated it, this gear stayed in the table and dressed
  // whichever earlier mob was still standing — 66.2% of all kit, on the wrong bodies. See
  // `buildZoneSpawns`. A sudden jump in this number means mob placement regressed, not equipment.
  line('  of which orphaned kit', stats.kitOrphaned, stats.commandsDropped);
  // Phase 14: how much of the world will actually break and run. Printed because `ACT_WIMPY` is set
  // sparingly upstream, and a morale mechanic that nothing in the shipped world carries the flag for
  // would look built and be invisible — the same reason the `safe` room count is reported.
  const harvested = spawns.flatMap((zone) => zone.templates);
  line('templates that flee', harvested.filter((t) => t.wimpyAt > 0).length, harvested.length);
  const kinds = Object.entries(stats.byKind).sort((a, b) => b[1] - a[1]);
  if (kinds.length > 0) console.log('    kept: ' + kinds.map(([k, v]) => `${k}=${v}`).join('  '));
  // Which of those the server can currently act on. `M` and `D` have executors; the object commands are
  // carried so Phase 15 adds a branch rather than re-reading the file.
  const executable = (stats.byKind['mob'] ?? 0) + (stats.byKind['door'] ?? 0);
  console.log(`    executable now: ${executable} (mob, door); the rest await items in Phase 15`);
  for (const zone of spawns) {
    const mobs = zone.resets.filter((r) => r.kind === 'mob');
    const limit = mobs.reduce((sum, r) => sum + r.limit, 0);
    console.log(
      `      zone ${String(zone.zone).padStart(4)} <- ${zone.source.padEnd(20)} ` +
        `${String(zone.templates.length).padStart(3)} templates, ${String(mobs.length).padStart(3)} spawns, ` +
        `limits total ${limit}, lifespan ${zone.lifespanMin}-${zone.lifespanMax} ticks`,
    );
  }
}

/**
 * Folds a matched `.wld` file's room extras onto the zone's rooms, through {@link buildRoomMap} —
 * the same name join the spawns ride, because the `.wld` vnums and the zMUD ids parted ways thirty
 * years ago and the room *name* is the one thing both sides still agree on. Returns undefined when
 * the file offers nothing, so the caller can leave the zone object untouched rather than rebuilding
 * 46,000 rooms to attach prose to 2,800.
 */
function attachRoomExtras(
  zone: Zone,
  durisRooms: readonly DurisRoom[],
): { zone: Zone; attached: number } | undefined {
  const withExtras = durisRooms.filter((r) => r.extras && r.extras.length > 0);
  if (withExtras.length === 0) return undefined;
  const byVnum = buildRoomMap(zone, durisRooms);
  const byRoom = new Map<RoomId, ExtraDescription[]>();
  for (const durisRoom of withExtras) {
    const roomId = byVnum.get(durisRoom.vnum);
    if (roomId === undefined) continue;
    byRoom.set(roomId, [...(byRoom.get(roomId) ?? []), ...durisRoom.extras!]);
  }
  if (byRoom.size === 0) return undefined;
  return {
    zone: {
      ...zone,
      rooms: zone.rooms.map((room) => {
        const extras = byRoom.get(room.id);
        return extras ? { ...room, extras } : room;
      }),
    },
    attached: [...byRoom.values()].reduce((sum, list) => sum + list.length, 0),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  console.log('reading %s', args.db);
  const started = Date.now();
  const { world, stats, sources } = loadWorld(args.db, {
    ...(args.zones ? { onlyZones: args.zones } : {}),
    includeDescriptions: args.descriptions,
  });
  console.log('parsed in %dms', Date.now() - started);

  report(stats);

  // The harvest runs after the graph is built and only replaces fields on rooms that already exist,
  // so it can never add, remove or re-link a room. Geometry stays the zMUD map's business.
  let zones: readonly Zone[] = world.zones;
  let harvested: HarvestResult | undefined;
  if (args.duris) {
    harvested = harvest(zones, args.wld);
    zones = harvested.zones;
    reportHarvest(harvested, stats.rooms, stats.zones);
  } else {
    console.log('\n  Duris harvest skipped (--no-duris).');
  }

  // Diffusion runs last, over whatever the earlier stages left unlabelled. Seeds are every room
  // whose *own name* yielded a sector, plus every room the harvest settled — a room whose own name
  // gave nothing is never treated as evidence, even when that "nothing" is really "we fell back to
  // the zone's name". See `reportZoneTierPolicy`'s docblock: keeping a zone-tier guess instead of
  // asking the graph measures 48.1% accurate against 65.5-69.4% for asking, so `source: 'zone'` /
  // `'zone-suffix'` rooms are *not* seeds here, on purpose — M1's "or, if you judge it honest" clause.
  // Order matters — seeding from the harvest is what lets a matched zone's real terrain bleed into
  // the unmatched rooms around it.
  //
  // Water safety, since a wrong `shallow_water`/`deep_water` majority is the one mistake that reads
  // as a bug rather than an approximation: widening the target pool to include `zone`-tier rooms does
  // not widen who gets to *vote*. A room only ever enters `labels` — and so only ever casts a vote —
  // by being a seed (room/room-suffix name match, or harvest) or by being voted a label itself in an
  // earlier round from the graph; the zone-tier guess a room *carried on entry* is never read as
  // evidence by `diffuseSectors` (see `diffuse.ts`: non-seed rooms go straight into `unlabelled`,
  // full stop, whatever sector they happen to hold). So a shoreline cannot flood inland any further
  // under this policy than it already could under the old one — the only change is that more rooms
  // are now *eligible to be corrected*, not that water can propagate through any new channel. The
  // Great Harbor of Waterdeep (zone 105) is the concrete case: 44 rooms named for the harbor carried
  // a zone-guessed `deep_water` that their real neighbours — mostly quays and warehouses — voted down
  // to `city`/`inside`, which is the harbour district, not open water.
  const roomTierSeeds = new Set<RoomId>();
  for (const [id, source] of sources) if (source === 'room' || source === 'room-suffix') roomTierSeeds.add(id);
  const seeds = new Set<RoomId>(roomTierSeeds);
  if (harvested) for (const id of harvested.sectored) seeds.add(id);

  // The held-out check: rooms Duris settled that the name rules defaulted entirely are re-predicted
  // from room-tier seeds alone, on the pre-harvest zones, and compared against what Duris actually
  // said. (Re-reads `sources.get(id) === 'default'` rather than "not a seed", because a zone-tier
  // room is no longer a seed either and is not what this specific check is about — see the next one.)
  let validation: { n: number; agreed: number; compatible: number } | undefined;
  if (harvested) {
    const heldOut = [...harvested.sectored].filter((id) => sources.get(id) === 'default');
    if (heldOut.length > 0) {
      const blind = diffuseSectors(world.zones, roomTierSeeds);
      const truth = new Map<RoomId, Zone['rooms'][number]['sector']>();
      for (const zone of zones) for (const room of zone.rooms) truth.set(room.id, room.sector);
      const predicted = new Map<RoomId, Zone['rooms'][number]['sector']>();
      for (const zone of blind.zones) for (const room of zone.rooms) predicted.set(room.id, room.sector);
      let agreed = 0;
      let compatible = 0;
      for (const id of heldOut) {
        const ours = predicted.get(id)!;
        const duris = truth.get(id)!;
        if (ours === duris) agreed++;
        if (harvestCompatible(ours, duris)) compatible++;
      }
      validation = { n: heldOut.length, agreed, compatible };
    }
  }

  const defaultedBefore = stats.sectorSources['default'] ?? 0;
  const diffused = diffuseSectors(zones, seeds);
  zones = diffused.zones;
  reportDiffusion(diffused, stats.rooms, defaultedBefore, validation);
  if (harvested) reportZoneTierPolicy(world.zones, harvested.zones, sources, harvested, roomTierSeeds);

  // The M1 provenance report: merges name-rule tier, harvest and diffusion into one bucket per room
  // and prints it per zone plus world-wide. Computed from `zones` *before* the authored-world merge
  // further down — see `buildProvenanceReport`'s docblock for why — so it runs here, right after the
  // stage it is reporting on, rather than at the end with the other file writes.
  const provenance = classifyProvenance(sources, harvested?.sectored, diffused.reached);
  const provenanceReport = buildProvenanceReport(zones, provenance);
  reportSectorProvenance(provenanceReport);
  if (!args.statsOnly) {
    mkdirSync(args.out, { recursive: true });
    writeFileSync(join(args.out, 'terrain-report.json'), JSON.stringify(provenanceReport, null, 2));
  }

  // Population, last: it needs the *final* zones. Diffusion can rewrite a sector but never a name, so in
  // practice the order is free — but taking it last means the room ids written into a reset table are
  // provably the ones actually shipped.
  const spawns: ZoneSpawns[] = [];
  const spawnStats = newSpawnStats();
  if (harvested) {
    const areas = durisAreas(args.wld);
    const durisByFile = loadDurisRooms(args.wld);
    const zoneList = [...zones];
    let extrasAttached = 0;
    for (const [zoneId, match] of harvested.matches) {
      const index = zoneList.findIndex((z) => z.id === zoneId);
      if (index === -1) continue;
      const durisRooms = durisByFile.get(match.file) ?? [];
      // Room extras ride the same name join the spawns use, and the same `--descriptions` switch
      // the zMUD prose does: both are third-party text, and one flag governs all of it.
      if (args.descriptions) {
        const enriched = attachRoomExtras(zoneList[index]!, durisRooms);
        if (enriched) {
          zoneList[index] = enriched.zone;
          extrasAttached += enriched.attached;
        }
      }
      const zone = zoneList[index]!;
      const { mob, zon } = companionPaths(areas, match.file);
      try {
        const built = buildZoneSpawns(zone, match.file, mob, zon, durisRooms, spawnStats);
        if (built) spawns.push(built);
      } catch (err) {
        // A matched `.wld` with no `.mob`/`.zon` beside it is ordinary — plenty of zones are rooms only —
        // so a missing file is a skip, not a failure. Anything else is a real problem and rethrows.
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    spawns.sort((a, b) => a.zone - b.zone);
    zones = zoneList;
    reportSpawns(spawns, spawnStats);
    if (args.descriptions) console.log('     %s room extra descriptions attached', String(extrasAttached));
  }

  // **Phase 22 — the authored world merges beside the harvest**, and only on full builds: a
  // `--zone` build cannot see every side of a cross-source edge, and a merge that can only
  // half-look would have to guess. The skip is announced rather than silent, because a filtered
  // rebuild that quietly dropped Velen would look exactly like a working build until somebody
  // walked at the missing gate.
  const authoredDir = join(REPO_ROOT, 'data', 'authored', 'zones');
  if (args.zones === undefined) {
    const authored = loadAuthoredZoneDir(authoredDir);
    if (authored.length > 0) {
      const merged = mergeAuthoredZones([...zones], authored);
      zones = merged.zones;
      console.log(
        '\n  authored world\n     %d zone(s), %d room(s) — %d cross-source edge(s) stitched, %d cross-authored',
        merged.report.zones,
        merged.report.rooms,
        merged.report.crossSource,
        merged.report.crossAuthored,
      );
    }
  } else if (loadAuthoredZoneDir(authoredDir).length > 0) {
    console.log('\n  authored world skipped (--zone build); run a full worldgen before shipping');
  }

  if (args.statsOnly) {
    console.log('\n--stats given; nothing written.');
    return;
  }

  mkdirSync(join(args.out, 'zones'), { recursive: true });

  for (const zone of zones) {
    writeFileSync(join(args.out, 'zones', `${zone.id}.json`), JSON.stringify(zone));
  }

  // One population file per populated zone, *beside* the zones rather than inside them: a zone's rooms
  // are geometry and belong to every consumer, while its inhabitants are content only the server reads.
  // A zone with no file is simply empty, which is what an unmatched zone honestly is.
  if (spawns.length > 0) {
    mkdirSync(join(args.out, 'spawns'), { recursive: true });
    for (const zone of spawns) {
      writeFileSync(join(args.out, 'spawns', `${zone.zone}.json`), JSON.stringify(zone));
    }
  }

  // **The item catalogue: one file for the whole world**, not one per zone.
  //
  // Rooms and mobs are partitioned by zone because interest management is room-scoped and a zone's
  // inhabitants only ever matter where that zone is loaded. Objects are not: a `G` command in IceCrag
  // can name an object defined in a file belonging to somewhere else entirely, because `real_object`
  // is a world-wide lookup. Splitting the catalogue by zone would mean resolving a vnum by searching
  // every file, which is the join the single file already answers.
  const objectDir = join(args.wld, '..', 'obj');
  let catalogue: ItemTemplate[] = [];
  try {
    catalogue = buildCatalogue(objectDir);
    writeFileSync(join(args.out, 'items.json'), JSON.stringify(catalogue));
    reportCatalogue(catalogue);
  } catch (err) {
    // Same posture as the rest of the Duris readers: the source tree is git-ignored and may not be
    // there. A world with no items is a poorer world, not a failed build.
    console.log('\nno item catalogue: %s', (err as Error).message);
  }

  // Shops — Phase 17. **Keyed by the keeper's mob vnum, not by room**, because that is the join the
  // game actually makes: you walk up to a *mob* and ask what it sells, and a keeper that wanders is
  // still the keeper. The `.shp` records name a room too and it is kept for reporting only.
  //
  // One file for the world, exactly as the catalogue is and for the same reason: a keeper vnum is a
  // world-wide lookup, and splitting it by zone would mean searching every file to answer one id.
  try {
    const shops = [...loadShops(join(args.wld, '..', 'shp')).values()].sort((a, b) => a.keeper - b.keeper);
    writeFileSync(join(args.out, 'shops.json'), JSON.stringify(shops));
    const stocked = shops.filter((s) => s.sells.length > 0).length;
    const buying = shops.filter((s) => s.buysTypes.length > 0).length;
    console.log(
      '\n  shops\n     %d keepers — %d with stock, %d that buy',
      shops.length,
      stocked,
      buying,
    );
  } catch (err) {
    console.log('\nno shops: %s', (err as Error).message);
  }

  // A light index so the server can list and lazily load zones without reading the whole world.
  const index = {
    meta: world.meta,
    zones: zones.map((z: Zone) => ({
      id: z.id,
      name: z.name,
      rooms: z.rooms.length,
      bounds: z.bounds,
      entryRoom: z.entryRoom,
    })),
  };
  writeFileSync(join(args.out, 'index.json'), JSON.stringify(index, null, 2));

  console.log(
    '\nwrote %d zone files, %d population files + index.json to %s',
    zones.length,
    spawns.length,
    args.out,
  );
}

main();
