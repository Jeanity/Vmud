/**
 * `scenedump` — look at a derived scene without a graphics stack. M2.
 *
 * ```
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/scenedump.ts --zone 390
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/scenedump.ts --zone 296 --level 0
 * node --disable-warning=ExperimentalWarning packages/worldgen/src/scenedump.ts --zone 390 --rooms 6
 * ```
 *
 * **Invoked with `node` directly and deliberately given no `package.json` script.** `CLAUDE.md`
 * gotcha 6: npm eats unknown flags, and `--zone 390` through a nested `npm run --workspace` is lost
 * to npm's own config parser before this file ever sees it. Every other flag-taking tool in this
 * repo is invoked the same way for the same reason.
 *
 * The plan asks for this at M2 and the reason is worth stating: Layer B is pure and GPU-free, so the
 * question "does this room describe the place I think it describes" should be answerable in a
 * terminal, in a second, months before there is a renderer to be wrong about it. It also makes the
 * seam ruling visible — an `open` edge with no carved mouth prints as a `~`, and you can see at a
 * glance that the roads out of a zone are crossings and not magic gates.
 *
 * ## Reading the map
 *
 * One room is a four-column, three-row cell: the north edge above, the west and east edges either
 * side, the south edge below, and in the middle a biome letter and the enclosure count.
 *
 * ```
 *   --      the north side is an `edge` — no room in that cell at all
 *  |f2      forest, two solid sides; lower case means no landmark, upper case means one
 *   ##      the south side is a `barrier` — a room is there and nothing links to it
 * ```
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CARDINALS,
  cellIndex,
  describeRoom,
  indexRooms,
  sceneSeed,
  sceneZone,
  type Cardinal,
  type Room,
  type RoomScene,
  type SceneEdge,
  type Sector,
  type Zone,
} from '@mygame/shared';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ZONES_DIR = join(REPO_ROOT, 'data', 'world', 'zones');

/**
 * One letter per sector, chosen to be distinguishable at a glance rather than mnemonic-perfect.
 *
 * The three water sectors share a family (`s`/`w`/`u`) and the two that read as "nothing under your
 * feet" share another (`a`/`A`... which collides with the landmark's upper case, so `astral` takes
 * `t`). Getting these unique matters more than getting them pretty: the whole point of the dump is
 * that a wrongly-labelled zone is visible as a block of the wrong letter.
 */
const SECTOR_LETTER: Readonly<Record<Sector, string>> = {
  inside: 'i',
  city: 'c',
  road: 'r',
  field: 'g',
  forest: 'f',
  hills: 'h',
  mountain: 'm',
  swamp: 'p',
  desert: 'd',
  arctic: 'n',
  cave: 'v',
  shallow_water: 's',
  deep_water: 'w',
  underwater: 'u',
  air: 'y',
  astral: 't',
};

/** Edge glyphs. Two per class, because a horizontal wall and a vertical one need different marks. */
function edgeGlyph(edge: SceneEdge | undefined, axis: 'ns' | 'ew'): string {
  if (!edge) return ' ';
  switch (edge.kind) {
    case 'open':
      // A seam is open and carves nothing: the ground stops, the walker does not.
      return edge.mouth?.carved === false ? '~' : ' ';
    case 'door':
      return edge.closed ? '+' : '/';
    case 'portal':
      return '*';
    case 'barrier':
      return '#';
    case 'edge':
      return axis === 'ns' ? '-' : '|';
  }
}

function cellRows(scene: RoomScene | undefined): [string, string, string] {
  if (!scene) return ['    ', '    ', '    '];
  const north = edgeGlyph(scene.edges.north, 'ns');
  const south = edgeGlyph(scene.edges.south, 'ns');
  const west = edgeGlyph(scene.edges.west, 'ew');
  const east = edgeGlyph(scene.edges.east, 'ew');
  const landmark = scene.features.some((f) => f.t === 'landmark');
  const letter = SECTOR_LETTER[scene.biome.sector] ?? '?';
  return [
    ` ${north}${north} `,
    `${west}${landmark ? letter.toUpperCase() : letter}${scene.enclosure.solid}${east}`,
    ` ${south}${south} `,
  ];
}

function describeEdgeLine(dir: Cardinal, edge: SceneEdge): string {
  const bits: string[] = [edge.kind];
  if (edge.seam) bits.push('seam');
  if (edge.inbound) bits.push('inbound');
  if (edge.closed) bits.push('shut');
  if (edge.locked) bits.push('locked');
  if (edge.mouth) bits.push(`mouth ${edge.mouth.span}@${edge.mouth.offset}${edge.mouth.carved ? '' : ' uncarved'}`);
  if (edge.to !== undefined) bits.push(`-> ${edge.to}${edge.sector ? ` (${edge.sector})` : ''}`);
  return `      ${dir.padEnd(6)} ${bits.join(', ')}`;
}

function dumpLevel(zone: Zone, level: number, scenes: ReadonlyMap<number, RoomScene>): void {
  const rooms = zone.rooms.filter((r) => r.pos.z === level);
  if (rooms.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const room of rooms) {
    minX = Math.min(minX, room.pos.x);
    minY = Math.min(minY, room.pos.y);
    maxX = Math.max(maxX, room.pos.x);
    maxY = Math.max(maxY, room.pos.y);
  }

  const at = new Map<string, Room>();
  for (const room of rooms) at.set(`${room.pos.x},${room.pos.y}`, room);

  console.log('');
  console.log(`  level ${level} — ${rooms.length} rooms, cells x ${minX}..${maxX}, y ${minY}..${maxY}`);
  console.log('');
  for (let y = minY; y <= maxY; y++) {
    const lines: [string, string, string] = ['', '', ''];
    for (let x = minX; x <= maxX; x++) {
      const room = at.get(`${x},${y}`);
      const rows = cellRows(room ? scenes.get(room.id) : undefined);
      lines[0] += rows[0];
      lines[1] += rows[1];
      lines[2] += rows[2];
    }
    for (const line of lines) console.log(`  ${line.replace(/\s+$/, '')}`);
  }
}

function summarise(zone: Zone, scenes: ReadonlyMap<number, RoomScene>): void {
  const edgeKinds = new Map<string, number>();
  const enclosure = [0, 0, 0, 0, 0];
  const landmarks = new Map<string, number>();
  const components = new Set<number>();
  const themes = new Set<number>();
  let seams = 0;
  let inbound = 0;
  let stairs = 0;
  let props = 0;

  for (const scene of scenes.values()) {
    for (const dir of CARDINALS) {
      const edge = scene.edges[dir];
      edgeKinds.set(edge.kind, (edgeKinds.get(edge.kind) ?? 0) + 1);
      if (edge.seam) seams += 1;
      if (edge.inbound) inbound += 1;
    }
    enclosure[scene.enclosure.solid] = (enclosure[scene.enclosure.solid] ?? 0) + 1;
    if (scene.ground.component >= 0) components.add(scene.ground.component);
    themes.add(scene.biome.theme);
    for (const feature of scene.features) {
      if (feature.t === 'landmark') landmarks.set(feature.kind, (landmarks.get(feature.kind) ?? 0) + 1);
      if (feature.t === 'stair') stairs += 1;
      if (feature.t === 'prop') props += 1;
    }
  }

  console.log('');
  console.log(`  edges     ${[...edgeKinds].sort().map(([k, n]) => `${k} ${n}`).join(', ')}`);
  console.log(`            ${seams} seam, ${inbound} inbound`);
  console.log(`  enclosure ${enclosure.map((n, i) => `${i}:${n}`).join('  ')}`);
  console.log(`  ground    ${components.size} components, theme ${[...themes].join('/')} of the zone`);
  console.log(
    `  features  ${props} props, ${stairs} stairs, ` +
      `${[...landmarks].map(([k, n]) => `${n} ${k}`).join(', ') || 'no landmarks'}`,
  );
  console.log(`  zone      ${zone.rooms.length} rooms${zone.seamless ? ', seamless' : ''}`);
}

function main(argv: readonly string[]): void {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };

  const zoneId = Number(flag('zone'));
  if (!Number.isInteger(zoneId)) {
    console.error('usage: node --disable-warning=ExperimentalWarning packages/worldgen/src/scenedump.ts --zone <id> [--level <z>] [--rooms <n>]');
    process.exitCode = 1;
    return;
  }
  const file = join(ZONES_DIR, `${zoneId}.json`);
  if (!existsSync(file)) {
    console.error(`${file} is not there. Run \`npm run worldgen\` first.`);
    process.exitCode = 1;
    return;
  }

  const zone = JSON.parse(readFileSync(file, 'utf8')) as Zone;
  const context = sceneZone(zone);
  const cells = cellIndex(zone);
  const rooms = indexRooms([zone]);

  const scenes = new Map<number, RoomScene>();
  for (const room of zone.rooms) {
    const neighbours: Partial<Record<Cardinal, Room>> = {};
    for (const dir of CARDINALS) {
      const delta = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] }[dir];
      const exit = room.exits[dir];
      const cell = cells.get(`${room.pos.x + delta[0]!},${room.pos.y + delta[1]!},${room.pos.z}`);
      const across = exit ? (rooms.get(exit.to) ?? (exit.portal ? undefined : cell)) : cell;
      if (across) neighbours[dir] = across;
    }
    scenes.set(room.id, describeRoom(context, room, neighbours, sceneSeed(context, room)));
  }

  console.log(`zone ${zone.id} "${zone.name}" — ${zone.rooms.length} rooms`);
  console.log('');
  console.log('  legend  edges: (space) open  ~ seam, uncarved  / open door  + shut door  * portal  # barrier  - | edge');
  console.log('          middle: biome letter (UPPER = landmark) then the number of solid sides');
  console.log('          biomes: i inside  c city  r road  g field  f forest  h hills  m mountain  p swamp');
  console.log('                  d desert  n arctic  v cave  s shallow  w deep  u underwater  y air  t astral');

  const only = flag('level');
  const levels = [...new Set(zone.rooms.map((r) => r.pos.z))].sort((a, b) => a - b);
  for (const level of levels) {
    if (only !== undefined && Number(only) !== level) continue;
    dumpLevel(zone, level, scenes);
  }

  summarise(zone, scenes);

  const detail = Number(flag('rooms') ?? 0);
  if (detail > 0) {
    console.log('');
    for (const room of zone.rooms.slice(0, detail)) {
      const scene = scenes.get(room.id);
      if (!scene) continue;
      console.log(`  room ${room.id} "${room.name}" at ${room.pos.x},${room.pos.y},${room.pos.z}`);
      console.log(
        `      biome  ${scene.biome.sector} theme ${scene.biome.theme}` +
          (scene.biome.blend.length > 0
            ? `, blends ${scene.biome.blend.map((b) => `${b.dir} ${b.sector} ${b.weight}`).join('; ')}`
            : ''),
      );
      console.log(
        `      ground component ${scene.ground.component}, ` +
          (scene.ground.elevation.t === 'continuous'
            ? `continuous base ${scene.ground.elevation.base} m, amplitude ${scene.ground.elevation.noise.amplitude} m`
            : `stacked level ${scene.ground.elevation.level} at ${scene.ground.elevation.height} m`),
      );
      for (const dir of CARDINALS) console.log(describeEdgeLine(dir, scene.edges[dir]));
      console.log(
        `      features ${scene.features.map((f) => (f.t === 'stair' ? `${f.style} ${f.dir}->${f.to}` : `${f.kind}`) + `@${f.tx},${f.ty}`).join(' ') || '(none)'}`,
      );
      console.log(`      seed ${scene.seed}, enclosure ${scene.enclosure.solid}${scene.enclosure.roofed ? ' roofed' : ''}`);
    }
  }
}

const invokedDirectly = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) main(process.argv.slice(2));
