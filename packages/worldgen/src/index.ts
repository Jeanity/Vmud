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

import type { RoomId, Zone, ZoneSpawns } from '@mygame/shared';

import { diffuseSectors, type DiffusionResult } from './diffuse.ts';
import { harvest, harvestCompatible, loadDurisRooms, type HarvestResult } from './duris.ts';
import {
  buildZoneSpawns,
  companionPaths,
  newSpawnStats,
  type SpawnBuildStats,
} from './mobs.ts';
import { loadWorld, type WorldgenStats } from './zmud.ts';

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

  console.log('\n  discarded');
  line('diagonal exits', stats.droppedDiagonal);
  line('special ("enter x")', stats.droppedSpecial);
  line('duplicate direction', stats.duplicateDirection);
  line('dangling', stats.dangling);
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
  line('dropped (no room)', stats.commandsDropped, stats.commands);
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

  // Diffusion runs last, over whatever the earlier stages left unlabelled: seeds are every room a
  // name rule reached plus every room the harvest settled, and only the loader's defaults are
  // filled in. Order matters — seeding from the harvest is what lets a matched zone's real terrain
  // bleed into the unmatched rooms around it.
  const nameSeeds = new Set<RoomId>();
  for (const [id, source] of sources) if (source !== 'default') nameSeeds.add(id);
  const seeds = new Set<RoomId>(nameSeeds);
  if (harvested) for (const id of harvested.sectored) seeds.add(id);

  // The held-out check: rooms Duris settled that the name rules defaulted are re-predicted from
  // name seeds alone, on the pre-harvest zones, and compared against what Duris actually said.
  let validation: { n: number; agreed: number; compatible: number } | undefined;
  if (harvested) {
    const heldOut = [...harvested.sectored].filter((id) => sources.get(id) === 'default');
    if (heldOut.length > 0) {
      const blind = diffuseSectors(world.zones, nameSeeds);
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

  const defaultedBefore = stats.rooms - nameSeeds.size;
  const diffused = diffuseSectors(zones, seeds);
  zones = diffused.zones;
  reportDiffusion(diffused, stats.rooms, defaultedBefore, validation);

  // Population, last: it needs the *final* zones. Diffusion can rewrite a sector but never a name, so in
  // practice the order is free — but taking it last means the room ids written into a reset table are
  // provably the ones actually shipped.
  const spawns: ZoneSpawns[] = [];
  const spawnStats = newSpawnStats();
  if (harvested) {
    const areas = durisAreas(args.wld);
    const durisByFile = loadDurisRooms(args.wld);
    for (const [zoneId, match] of harvested.matches) {
      const zone = zones.find((z) => z.id === zoneId);
      if (!zone) continue;
      const { mob, zon } = companionPaths(areas, match.file);
      try {
        const built = buildZoneSpawns(zone, match.file, mob, zon, durisByFile.get(match.file) ?? [], spawnStats);
        if (built) spawns.push(built);
      } catch (err) {
        // A matched `.wld` with no `.mob`/`.zon` beside it is ordinary — plenty of zones are rooms only —
        // so a missing file is a skip, not a failure. Anything else is a real problem and rethrows.
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    spawns.sort((a, b) => a.zone - b.zone);
    reportSpawns(spawns, spawnStats);
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
