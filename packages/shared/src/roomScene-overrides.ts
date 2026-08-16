/**
 * The per-zone scene override layer — **the format, designed at M2; the pipeline is M8's.**
 *
 * The plan is specific about the timing and it is right: *"the per-zone JSON override layer for
 * hand-tuning important zones — design its format at M2, while `roomScene.ts` is being written, not
 * as a retrofit"*. So this file is the type, the vocabulary and a validator with tests, and nothing
 * else. **Nothing reads it yet.** `describeRoom` does not take it, `worldgen` does not load it, no
 * file under `data/world/overrides/` has this shape. That is deliberate: a format that exists and is
 * validated costs nothing to keep correct, and a half-wired one costs a debugging session.
 *
 * ## What is authorable, and why the list is short
 *
 * Only the knobs a human can hold an opinion about, and only where a wrong answer is a *look* rather
 * than a *rule*:
 *
 * | Knob | Scope | What it moves |
 * |---|---|---|
 * | `sector` | room | the biome, and therefore ground, scatter, blend weights and the landmark palette |
 * | `theme` | zone, room | which of {@link THEME_COUNT} material sets dresses it |
 * | `landmark` | room | the slot: a named kind, or `'none'` to clear one the hash chose |
 * | `base` | room | metres of elevation offset, for a zone that should sit in a valley |
 *
 * Everything else in a {@link RoomScene} is *derived from geometry* — edge classes, enclosure,
 * mouths, stair placement, prop footprints — and is not offered here on purpose. An override that
 * could say "this barrier is open" would be an override that puts a hole in the collision grid's
 * wall, and the point of the IR is that the picture and the physics cannot disagree.
 *
 * **`SceneEnclosure.ceiling` is the one knob that looks like it belongs here and does not — yet.**
 * It is a per-zone fact a human holds an opinion about, which is this file's whole remit, and it was
 * still put in code as `roomScene.GIANT_FOLK_ZONES` in 2026-08-16 for the reason at the top of this
 * header: nothing reads this format, and half-wiring a loader to carry eighteen zone ids would have
 * cost the debugging session that warning is about. It is the first thing M8 should absorb when the
 * pipeline is real, and the closed list is written to be lifted out whole.
 *
 * ## The 1-neighbourhood consequence — read this before writing a loader
 *
 * `describeRoom` reads the room **and its four cardinal neighbours**, so:
 *
 * 1. **Editing one room's `sector` changes up to five scenes** — its own, and one edge of each
 *    neighbour, because blend weights carry the far room's sector and `connectorSpan` merges only
 *    when *both* rooms are outdoor. Change a `forest` room to `inside` and four neighbouring rooms'
 *    nine-tile merged edges narrow to three-tile doorways. **A loader must re-derive the neighbours
 *    of every room it touched, not just the room.**
 * 2. **It can also change ground components far beyond the neighbourhood.** Components are a
 *    whole-zone connected-component pass ({@link groundComponents}), so flipping one room out of
 *    {@link OUTDOOR_SECTORS} can *split* a 494-room region in two — and both halves then take a
 *    different `base` offset, because the offset is hashed from the component id, which is the
 *    smallest room id in the component. The blast radius of a one-word edit is a whole region of
 *    ground, and a re-bake must redo the component pass for the zone, not patch it.
 * 3. **`base` on a room is therefore a component-level statement in disguise.** It is offered
 *    per-room because that is the unit an author points at, and a loader should apply it to the room's
 *    whole component or accept a visible step in the ground at that room's edges. M8's call; recorded
 *    here so it is made rather than discovered.
 *
 * That is also the answer to the six zones M1 could not label — zone 35 "Color legend", the two
 * pirate ships, the two ferries, the dagger quest — which are structurally unlabelable by any
 * name-and-graph pipeline and are exactly what a hand-authored `sector` line is for.
 */

import { SECTORS, type RoomId, type Sector, type ZoneId } from './world.ts';
import { LANDMARK_KINDS, THEME_COUNT, type LandmarkKind } from './roomScene.ts';

/** Bumped when the shape changes incompatibly. A loader must refuse a version it does not know. */
export const SCENE_OVERRIDE_VERSION = 1;

/** `'none'` clears a landmark the hash chose; a kind forces one. Absent leaves the hash alone. */
export type LandmarkOverride = LandmarkKind | 'none';

/** What one room may be told about itself. Every field optional; an empty object is legal and inert. */
export interface RoomSceneOverride {
  readonly sector?: Sector;
  readonly theme?: number;
  readonly landmark?: LandmarkOverride;
  /** Metres. See the module note on why this is a component-level statement wearing a room's clothes. */
  readonly base?: number;
}

/**
 * One zone's overrides.
 *
 * Keyed by room id **as a string**, because this is a JSON file and JSON has no integer keys. The
 * validator insists the key parses to an integer and matches nothing else, so `"92060 "` and
 * `"0x1674c"` are errors rather than rooms that silently never match.
 */
export interface ZoneSceneOverrides {
  readonly version: number;
  readonly zone: ZoneId;
  /** Applied to every room in the zone that does not name its own. */
  readonly theme?: number;
  readonly rooms?: Readonly<Record<string, RoomSceneOverride>>;
  /** Free text for the human who wrote it. Never read by anything. */
  readonly note?: string;
}

/** One thing wrong, with the path to it, so a build failure names the line rather than the file. */
export interface OverrideProblem {
  /** Dotted path from the document root, e.g. `rooms.92060.sector`. */
  readonly path: string;
  readonly message: string;
}

const SECTOR_SET: ReadonlySet<string> = new Set<string>(SECTORS);
const LANDMARK_SET: ReadonlySet<string> = new Set<string>([...LANDMARK_KINDS, 'none']);

/** Metres. Wider than {@link GROUND_BASE_METRES}, because an author overriding it means to. */
const BASE_LIMIT = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Everything wrong with a candidate override document, or an empty array.
 *
 * **Returns problems rather than throwing**, and returns *all* of them rather than the first: an
 * author fixing a hand-written JSON file wants the whole list in one run, and a build step wants to
 * print it. It is a validator and not a parser — it neither coerces nor fills in defaults, because a
 * validator that quietly repairs its input is a validator whose tests prove nothing about the file on
 * disk.
 *
 * Unknown keys are errors, not warnings. A typo'd `"secter"` that validated clean would be an
 * override that does nothing, discovered by eye, months later, in a zone that still looks wrong.
 */
export function validateZoneSceneOverrides(value: unknown, path = ''): OverrideProblem[] {
  const problems: OverrideProblem[] = [];
  const at = (key: string): string => (path ? `${path}.${key}` : key);

  if (!isRecord(value)) {
    return [{ path: path || '<root>', message: 'expected an object' }];
  }

  const known = new Set(['version', 'zone', 'theme', 'rooms', 'note']);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) problems.push({ path: at(key), message: `unknown key ${JSON.stringify(key)}` });
  }

  if (value['version'] !== SCENE_OVERRIDE_VERSION) {
    problems.push({
      path: at('version'),
      message: `expected version ${SCENE_OVERRIDE_VERSION}, got ${JSON.stringify(value['version'])}`,
    });
  }

  const zone = value['zone'];
  if (!Number.isInteger(zone)) {
    problems.push({ path: at('zone'), message: `expected an integer zone id, got ${JSON.stringify(zone)}` });
  }

  if ('theme' in value) problems.push(...themeProblems(value['theme'], at('theme')));

  if ('note' in value && typeof value['note'] !== 'string') {
    problems.push({ path: at('note'), message: 'expected a string' });
  }

  if ('rooms' in value) {
    const rooms = value['rooms'];
    if (!isRecord(rooms)) {
      problems.push({ path: at('rooms'), message: 'expected an object keyed by room id' });
    } else {
      for (const [key, entry] of Object.entries(rooms)) {
        const here = `${at('rooms')}.${key}`;
        // `Number(key)` alone accepts " 12", "0x0c" and "1e3"; the round-trip refuses all three.
        const id = Number(key);
        if (!Number.isInteger(id) || String(id) !== key) {
          problems.push({ path: here, message: `room key ${JSON.stringify(key)} is not a plain integer room id` });
        }
        problems.push(...roomProblems(entry, here));
      }
    }
  }

  return problems;
}

function themeProblems(theme: unknown, path: string): OverrideProblem[] {
  if (!Number.isInteger(theme) || (theme as number) < 0 || (theme as number) >= THEME_COUNT) {
    return [{ path, message: `expected an integer 0..${THEME_COUNT - 1}, got ${JSON.stringify(theme)}` }];
  }
  return [];
}

function roomProblems(entry: unknown, path: string): OverrideProblem[] {
  if (!isRecord(entry)) return [{ path, message: 'expected an object' }];

  const problems: OverrideProblem[] = [];
  const known = new Set(['sector', 'theme', 'landmark', 'base']);
  for (const key of Object.keys(entry)) {
    if (!known.has(key)) problems.push({ path: `${path}.${key}`, message: `unknown key ${JSON.stringify(key)}` });
  }

  if ('sector' in entry && !SECTOR_SET.has(entry['sector'] as string)) {
    problems.push({ path: `${path}.sector`, message: `${JSON.stringify(entry['sector'])} is not a sector` });
  }
  if ('theme' in entry) problems.push(...themeProblems(entry['theme'], `${path}.theme`));
  if ('landmark' in entry && !LANDMARK_SET.has(entry['landmark'] as string)) {
    problems.push({
      path: `${path}.landmark`,
      message: `${JSON.stringify(entry['landmark'])} is not a landmark kind or "none"`,
    });
  }
  if ('base' in entry) {
    const base = entry['base'];
    if (typeof base !== 'number' || !Number.isFinite(base) || Math.abs(base) > BASE_LIMIT) {
      problems.push({
        path: `${path}.base`,
        message: `expected a finite number within +/-${BASE_LIMIT} metres, got ${JSON.stringify(base)}`,
      });
    }
  }

  return problems;
}

/**
 * A room id an override document names, for a loader that wants to re-derive scenes.
 *
 * Exported because point 1 of the module note is the thing a loader will get wrong: it is not enough
 * to re-derive the rooms listed here, their cardinal neighbours have to be re-derived too. Handing
 * the id list out is half of making that easy; the other half is M8's.
 */
export function overriddenRooms(overrides: ZoneSceneOverrides): readonly RoomId[] {
  return Object.keys(overrides.rooms ?? {}).map(Number).filter(Number.isInteger);
}
