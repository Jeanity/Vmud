/**
 * Character persistence: the `seen` map on disk, and what happens to a save written by the previous
 * version.
 *
 * The migration is the load-bearing part. Fog used to be room-granular, so every save file on disk
 * right now holds a list of room ids and no bitsets at all. A character logging in with one of those
 * must not be met with a crash, and should not be met with a blank map either — the old model's
 * reveal map is exactly "the tiles this character had seen", so the conversion is faithful rather
 * than a guess.
 *
 * Everything here runs against a temporary directory and a synthetic zone, so no test can scribble
 * on a real character or depend on generated world data.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AffectFlag,
  CONNECTOR_WIDTH,
  ROOM_GAP,
  ROOM_TILES,
  STARTING_CAPACITY,
  UNLIMITED_DURATION,
  boundsOf,
  newAffect,
  roomCentre,
  secondWindAffects,
  settlingAffect,
  type Affect,
  type Inventory,
  type Item,
  type Room,
  type Zone,
} from '@mygame/shared';
import { bitsetHas } from '@mygame/shared/vision.ts';

import { legacyRoomReveal } from './legacy-fog.ts';
import {
  PlayerStore,
  seenTileCount,
  slugify,
  type LegacyRoomTiles,
  type PlayerStoreOptions,
} from './players.ts';
import { GameWorld } from './world.ts';

/** Two rooms side by side, joined by a corridor — enough for a reveal map with stubs in it. */
function testZone(): Zone {
  const rooms: Room[] = [
    {
      id: 6001,
      zone: 600,
      name: 'A Mossy Hollow',
      sector: 'forest',
      pos: { x: 0, y: 0, z: 0 },
      exits: { east: { to: 6002 } },
    },
    {
      id: 6002,
      zone: 600,
      name: 'A Fallen Log',
      sector: 'forest',
      pos: { x: 1, y: 0, z: 0 },
      exits: { west: { to: 6001 } },
    },
  ];
  return { id: 600, name: 'Test Hollow', rooms, bounds: boundsOf(rooms), entryRoom: 6001 };
}

const GROUND = { zone: 600, level: 0 } as const;

function makeWorld(): GameWorld {
  return new GameWorld([testZone()], { zone: 600, room: null });
}

/** The migration hook `index.ts` builds, against the same synthetic world. */
function legacyResolver(world: GameWorld) {
  return (roomId: number): LegacyRoomTiles | undefined => {
    const located = world.locate(roomId);
    if (!located) return undefined;
    const grid = world.grid(located.place);
    if (!grid) return undefined;
    const tiles = legacyRoomReveal(grid, located.room);
    if (tiles.length === 0) return undefined;
    return { place: located.place, tileCount: grid.width * grid.height, tiles };
  };
}

function makeStore(options: Omit<PlayerStoreOptions, 'dir'> = {}): { store: PlayerStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-players-'));
  return { store: new PlayerStore({ dir, ...options }), dir };
}

function readSaved(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, `${slugify(name)}.json`), 'utf8')) as Record<string, unknown>;
}

/** Runs `body` with `console.warn` and `console.log` captured rather than printed. */
function quietly<T>(body: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const realWarn = console.warn;
  const realLog = console.log;
  console.warn = (...args: unknown[]): void => void warnings.push(args.join(' '));
  console.log = (): void => {};
  try {
    return { result: body(), warnings };
  } finally {
    console.warn = realWarn;
    console.log = realLog;
  }
}

describe('the seen map on disk', () => {
  it('starts empty for a character nobody has played', () => {
    const { store } = makeStore();
    const record = store.load('Newcomer');
    assert.equal(record.seen.size, 0);
    assert.equal(seenTileCount(record), 0);
    assert.equal(record.lastRoom, undefined);
  });

  it('round-trips seen tiles through base64, keyed per Place', () => {
    const { store, dir } = makeStore();
    const record = store.load('Wanderer');

    store.markSeen(record, GROUND, 288, [0, 5, 287]);
    store.markSeen(record, { zone: 600, level: 1 }, 144, [12]);
    store.setLastRoom(record, 6001);
    store.flush(record);

    const saved = readSaved(dir, 'Wanderer');
    assert.deepEqual(Object.keys(saved['seen'] as object).sort(), ['600:0', '600:1']);
    assert.equal(saved['lastRoom'], 6001);

    // A second store reading the same directory is a restart in miniature.
    const restarted = new PlayerStore({ dir });
    const reloaded = restarted.load('Wanderer');
    assert.equal(seenTileCount(reloaded), 4);
    assert.equal(reloaded.lastRoom, 6001);

    const ground = restarted.seenBits(reloaded, GROUND, 288);
    for (const index of [0, 5, 287]) assert.equal(bitsetHas(ground, index), true);
    assert.equal(bitsetHas(ground, 12), false, 'level 1 s tile 12 is not level 0 s');
    assert.equal(bitsetHas(restarted.seenBits(reloaded, { zone: 600, level: 1 }, 144), 12), true);
  });

  it('reports only the tiles that were new, which is what the delta ships', () => {
    const { store } = makeStore();
    const record = store.load('Delta');

    assert.deepEqual(store.markSeen(record, GROUND, 288, [4, 5, 6]), [4, 5, 6]);
    // Walking on: two tiles overlap the light of a moment ago and must not be re-sent.
    assert.deepEqual(store.markSeen(record, GROUND, 288, [5, 6, 7, 8]), [7, 8]);
    assert.deepEqual(store.markSeen(record, GROUND, 288, [5, 6]), []);
    assert.equal(seenTileCount(record), 5);
  });

  it('keeps each Place s tiles apart, because an index means nothing without its grid', () => {
    const { store } = makeStore();
    const record = store.load('Climber');

    store.markSeen(record, GROUND, 288, [100]);
    const canopy = store.seenBits(record, { zone: 600, level: 1 }, 144);
    assert.equal(bitsetHas(canopy, 100), false, 'tile 100 on another level is another place entirely');
    assert.equal(seenTileCount(record), 1);
  });

  it('survives a save file that is corrupt rather than refusing to let anyone play', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'brokenone.json'), '{ this is not json');
    const record = store.load('BrokenOne');
    assert.equal(record.name, 'BrokenOne');
    assert.equal(record.seen.size, 0);
  });
});

/**
 * Affects on disk — and in particular the carried light, which is one row of them.
 *
 * The carried light is the other half of `taken`, and the split is what makes the asymmetry dangerous:
 * `taken` says "this room is empty for you" and survives everything, so a light that did *not* survive
 * turned every disconnect into a permanent, unrecoverable loss of light. `node --watch` restarts the
 * dev server on each code change, which made that the ordinary case. Phase 5b moved the light into the
 * affect list, so what is tested here is that the one persistence path keeps that guarantee.
 */
describe('affects on disk', () => {
  /** The `light` affect for a source, as `Simulation.setCarriedLight` builds it. */
  const lightAffect = (id: string, durationMs: number): Affect =>
    newAffect({ type: 'light', durationMs, apply: 'light', flags: AffectFlag.NoShow, context: id });

  it('is an empty list for a character nobody has played', () => {
    const { store } = makeStore();
    assert.deepEqual(store.load('Newcomer').affects, []);
  });

  it('round-trips a carried light and its remaining burn through a restart', () => {
    const { store, dir } = makeStore();
    const record = store.load('Torchbearer');

    store.setAffects(record, [lightAffect('torch', 91_500)]);
    store.flush(record);

    const saved = readSaved(dir, 'Torchbearer');
    assert.deepEqual(saved['affects'], [
      { type: 'light', durationMs: 91_500, apply: 'light', modifier: 0, flags: AffectFlag.NoShow, context: 'torch' },
    ]);

    const reloaded = new PlayerStore({ dir }).load('Torchbearer');
    assert.equal(reloaded.affects.length, 1);
    assert.equal(reloaded.affects[0]?.context, 'torch');
    assert.equal(reloaded.affects[0]?.durationMs, 91_500);
  });

  it('omits the field rather than writing an empty array, for an unaffected character', () => {
    const { store, dir } = makeStore();
    const record = store.load('Blindfold');
    store.markSeen(record, GROUND, 288, [1]);
    store.flush(record);

    assert.equal('affects' in readSaved(dir, 'Blindfold'), false);
  });

  it('keeps a source that never expires without inventing a burn for it', () => {
    const { store, dir } = makeStore();
    const record = store.load('Lanternjaw');
    store.setAffects(record, [lightAffect('lantern', UNLIMITED_DURATION)]);
    store.flush(record);

    const reloaded = new PlayerStore({ dir }).load('Lanternjaw');
    assert.equal(reloaded.affects[0]?.context, 'lantern');
    assert.equal(reloaded.affects[0]?.durationMs, UNLIMITED_DURATION, 'unlimited survives as the sentinel');
  });

  /**
   * The point of the flag, and the reason it is enforced here rather than at the call site: the server
   * hands its whole list over on every save, so a `NoSave` affect that leaked through would be banked
   * by every disconnect. The rest cycle costs half a minute of sitting still, and that is the cost.
   */
  it('never writes an affect that asked not to be saved', () => {
    const { store, dir } = makeStore();
    const record = store.load('Napper');
    store.setAffects(record, [...secondWindAffects(), settlingAffect(), lightAffect('torch', 1_000)]);
    store.flush(record);

    const saved = readSaved(dir, 'Napper') as { affects?: { type: string }[] };
    assert.deepEqual(saved.affects?.map((a) => a.type), ['light'], 'only the light is a fact about the character');
  });

  it('reads a save written before affects existed as a carried light', () => {
    // Pre-v9: two fields of its own. Migrated rather than discarded — refusing to read an old save
    // locks a character out of their own map over a data format.
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'earlybird.json'),
      JSON.stringify({
        name: 'EarlyBird',
        seen: {},
        taken: ['r6001'],
        light: 'torch',
        lightRemainingMs: 91_500,
        savedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const record = store.load('EarlyBird');
    assert.equal(record.affects.length, 1);
    assert.equal(record.affects[0]?.type, 'light');
    assert.equal(record.affects[0]?.apply, 'light');
    assert.equal(record.affects[0]?.context, 'torch');
    assert.equal(record.affects[0]?.durationMs, 91_500);
    assert.equal(store.hasTaken(record, 'r6001'), true, 'the rest of the save still loads');
  });

  it('reads a pre-v9 save with no light at all as nothing affecting them', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'inthedark.json'),
      JSON.stringify({ name: 'InTheDark', seen: {}, taken: ['r6001'], savedAt: '2026-07-01T00:00:00.000Z' }),
    );
    assert.deepEqual(store.load('InTheDark').affects, []);
  });

  it('reads a pre-v9 light with no burn as one that never expires', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'lamplighter.json'),
      JSON.stringify({ name: 'Lamplighter', seen: {}, light: 'lantern', savedAt: '2026-07-01T00:00:00.000Z' }),
    );
    const record = store.load('Lamplighter');
    assert.equal(record.affects[0]?.durationMs, UNLIMITED_DURATION);
  });

  it('ignores a hand-edited light of the wrong shape rather than handing it to the catalogue', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'meddler.json'),
      JSON.stringify({
        name: 'Meddler',
        seen: {},
        light: { id: 'torch' },
        lightRemainingMs: 'soon',
        savedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    assert.deepEqual(store.load('Meddler').affects, []);
  });

  it('reads a pre-v9 negative remaining time as spent rather than as unlimited', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'gutterer.json'),
      JSON.stringify({
        name: 'Gutterer',
        seen: {},
        light: 'torch',
        lightRemainingMs: -4000,
        savedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const record = store.load('Gutterer');
    // 0, not the unlimited sentinel: a torch that came back burning for ever is the one bug this field
    // could produce that nobody would ever report.
    assert.equal(record.affects[0]?.durationMs, 0);
  });

  /**
   * The file is hand-editable, so every field has to survive being wrong. The failure mode this
   * prevents is not a crash — it is an affect that feeds a location nothing derives from, which is
   * invisible, permanent, and impossible to explain from the symptom.
   */
  it('drops an affect whose type the catalogue no longer knows', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'ghost.json'),
      JSON.stringify({
        name: 'Ghost',
        seen: {},
        affects: [
          { type: 'spell_of_yesteryear', durationMs: 5_000, apply: 'hpRegen', modifier: 99, flags: 0 },
          { type: 'light', durationMs: 5_000, apply: 'light', modifier: 0, flags: 2, context: 'torch' },
        ],
        savedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const record = store.load('Ghost');
    assert.deepEqual(record.affects.map((a) => a.type), ['light']);
  });

  it('falls back to a location nothing derives rather than trusting an unknown one', () => {
    const { store, dir } = makeStore();
    writeFileSync(
      join(dir, 'cheat.json'),
      JSON.stringify({
        name: 'Cheat',
        seen: {},
        affects: [{ type: 'second_wind', durationMs: 5_000, apply: 'godmode', modifier: 9999, flags: 0 }],
        savedAt: '2026-07-01T00:00:00.000Z',
      }),
    );
    const record = store.load('Cheat');
    assert.equal(record.affects[0]?.apply, 'none', 'an unknown apply is inert, not trusted');
  });

  /**
   * The offline clock.
   *
   * Default is **paused** — a saved duration resumes with exactly the time it had, which is how the
   * carried light has always behaved. `Offline` is the opt-out, and it exists so that a later cooldown
   * cannot be dodged by closing the tab. Nothing sets it yet; this pins the loader half so the flag
   * means something the day something does.
   */
  it('pauses a saved affect while logged out, unless it asked not to be', () => {
    const { store, dir } = makeStore();
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    writeFileSync(
      join(dir, 'sleeper.json'),
      JSON.stringify({
        name: 'Sleeper',
        seen: {},
        affects: [
          { type: 'light', durationMs: 60_000, apply: 'light', modifier: 0, flags: AffectFlag.NoShow, context: 'torch' },
          { type: 'second_wind', durationMs: 60_000, apply: 'hpRegen', modifier: 6, flags: AffectFlag.Offline },
        ],
        savedAt: hourAgo,
      }),
    );
    const record = store.load('Sleeper');
    assert.deepEqual(record.affects.map((a) => a.type), ['light'], 'the offline one burned away while away');
    assert.equal(record.affects[0]?.durationMs, 60_000, 'and the paused one did not lose a millisecond');
  });
});

describe('migrating a pre-v4 save', () => {
  /** Exactly what the previous version wrote: room ids, no bitsets. */
  function writeLegacy(dir: string, name: string, explored: number[]): void {
    writeFileSync(
      join(dir, `${slugify(name)}.json`),
      JSON.stringify({ name, explored, lastRoom: explored[0], savedAt: '2026-07-01T00:00:00.000Z' }),
    );
  }

  it('converts explored rooms into the tiles those rooms used to reveal', () => {
    const world = makeWorld();
    const { store, dir } = makeStore({ resolveLegacyRoom: legacyResolver(world) });
    writeLegacy(dir, 'Oldtimer', [6001]);

    const record = quietly(() => store.load('Oldtimer')).result;

    const grid = world.grid(GROUND);
    assert.ok(grid);
    const room = world.locate(6001)?.room;
    assert.ok(room);
    const revealed = legacyRoomReveal(grid, room);
    // Every tile the old fog had uncovered, and not one more: its own 9x9 floor plus the corridor
    // stubs leading out of it.
    assert.equal(revealed.length, ROOM_TILES * ROOM_TILES + CONNECTOR_WIDTH * ROOM_GAP);
    assert.equal(seenTileCount(record), revealed.length);
    const bits = store.seenBits(record, GROUND, grid.width * grid.height);
    for (const index of revealed) assert.equal(bitsetHas(bits, index), true);

    // The room it never entered stays unseen, so the migration cannot hand out free map.
    const centre = roomCentre(grid.roomOrigins.get(6002)!);
    assert.equal(bitsetHas(bits, centre.ty * grid.width + centre.tx), false);
  });

  it('rewrites the file in the new shape, so the old field is read exactly once', () => {
    const world = makeWorld();
    const { store, dir } = makeStore({ resolveLegacyRoom: legacyResolver(world) });
    writeLegacy(dir, 'Rewritten', [6001, 6002]);

    const record = quietly(() => store.load('Rewritten')).result;
    store.flush(record);

    const saved = readSaved(dir, 'Rewritten');
    assert.equal('explored' in saved, false, 'the obsolete field should be gone');
    assert.equal(typeof (saved['seen'] as Record<string, string>)['600:0'], 'string');
    assert.equal(saved['lastRoom'], 6001);
  });

  it('skips rooms in zones this server no longer loads, rather than failing the login', () => {
    const world = makeWorld();
    const { store, dir } = makeStore({ resolveLegacyRoom: legacyResolver(world) });
    // 6001 is real; 55555 belongs to a zone that is not in world.config.json any more. The zone list
    // is configuration and may legitimately have shrunk since the save was written.
    writeLegacy(dir, 'Traveller', [6001, 55555]);

    const record = quietly(() => store.load('Traveller')).result;
    const grid = world.grid(GROUND);
    assert.ok(grid);
    const room = world.locate(6001)?.room;
    assert.ok(room);
    assert.equal(seenTileCount(record), legacyRoomReveal(grid, room).length);
  });

  it('discards the old field with a warning when there is no world to map it onto', () => {
    // The documented fallback. Losing a map is a bad day; being unable to log in is a bug report.
    const { store, dir } = makeStore();
    writeLegacy(dir, 'Unmappable', [6001, 6002]);

    const { result: record, warnings } = quietly(() => store.load('Unmappable'));
    assert.equal(record.name, 'Unmappable');
    assert.equal(record.seen.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /discarding 2 pre-v4 explored rooms/);
  });
});

describe('the admin edits', () => {
  it('lists what is on disk, and prefers the cache over a stale file', () => {
    const { store, dir } = makeStore();
    const record = store.load('Wanderer');
    store.markSeen(record, GROUND, 288, [0, 5, 287]);
    store.markTaken(record, 'pickup:6001:0');
    store.setLastRoom(record, 6001);
    store.flush(record);

    // A second character written by hand, as a restart would find it.
    writeFileSync(
      join(dir, 'stray.json'),
      JSON.stringify({ name: 'Stray', taken: ['a', 'b'], savedAt: '2026-08-01T00:00:00.000Z' }),
    );

    const roster = store.list();
    assert.deepEqual(roster.map((s) => s.slug), ['stray', 'wanderer']);
    const wanderer = roster[1]!;
    assert.equal(wanderer.name, 'Wanderer');
    assert.equal(wanderer.seenTiles, 3);
    assert.equal(wanderer.takenCount, 1);
    assert.equal(wanderer.lastRoom, 6001);
    assert.equal(roster[0]!.takenCount, 2);

    // The cache is ahead of the file: the roster must report the edit, not the write behind it.
    store.markTaken(record, 'pickup:6001:1');
    assert.equal(store.list()[1]!.takenCount, 2, 'the unflushed edit is the truth');
  });

  it('skips a file whose stored name does not match its filename, with a warning', () => {
    const { store, dir } = makeStore();
    writeFileSync(join(dir, 'ravi.json'), JSON.stringify({ name: 'Somebody Else', savedAt: 'x' }));
    const { result: roster, warnings } = quietly(() => store.list());
    assert.equal(roster.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? '', /does not match its filename/);
  });

  it('sets the wound directly, sanitised the way the loader would', () => {
    const { store, dir } = makeStore();
    const record = store.load('Bruised');

    store.setWound(record, { hp: 4.6, mana: -3, move: Number.NaN });
    assert.deepEqual(record.missing, { hp: 5, mana: 0, move: 0 });
    store.flush(record);
    assert.deepEqual(readSaved(dir, 'Bruised')['missing'], { hp: 5, mana: 0, move: 0 });

    // All-zero is "unhurt", which is stored as nothing at all.
    store.setWound(record, { hp: 0 });
    assert.equal(record.missing, undefined);
    store.flush(record);
    assert.equal('missing' in readSaved(dir, 'Bruised'), false);

    store.setWound(record, undefined);
    assert.equal(record.missing, undefined);
  });

  it('clears the taken set and reports how many went', () => {
    const { store } = makeStore();
    const record = store.load('Collector');
    store.markTaken(record, 'one');
    store.markTaken(record, 'two');
    assert.equal(store.clearTaken(record), 2);
    assert.equal(record.taken.size, 0);
    assert.equal(store.clearTaken(record), 0, 'clearing nothing is a no-op, not a dirty write');
  });

  it('deletes the file and the cached record together', () => {
    const { store, dir } = makeStore();
    const record = store.load('Doomed');
    store.markSeen(record, GROUND, 288, [1, 2, 3]);
    store.flush(record);
    assert.equal(store.list().length, 1);

    assert.equal(store.delete('Doomed'), true);
    assert.equal(store.list().length, 0);
    // The cache went too: a reload starts blank rather than resurrecting the evicted record.
    assert.equal(seenTileCount(store.load('Doomed')), 0);

    // Deleting a character who was never flushed still evicts the cache, and says no file went.
    const ghost = store.load('Ghost');
    store.markSeen(ghost, GROUND, 288, [9]);
    assert.equal(store.delete('Ghost'), false);
    assert.equal(seenTileCount(store.load('Ghost')), 0);
    void dir;
  });
});

describe('the progress on disk', () => {
  it('round-trips level and experience, flat in the file', () => {
    const { store, dir } = makeStore();
    const record = store.load('Veteran');
    store.setProgress(record, 35, 67_635);
    store.flush(record);

    const saved = readSaved(dir, 'Veteran');
    assert.equal(saved['level'], 35);
    assert.equal(saved['experience'], 67_635);

    const reloaded = new PlayerStore({ dir }).load('Veteran');
    assert.deepEqual(reloaded.progress, { level: 35, experience: 67_635 });
  });

  it('stores a brand-new character as nothing recorded', () => {
    const { store, dir } = makeStore();
    const record = store.load('Fresh');
    store.setProgress(record, 1, 0);
    assert.equal(record.progress, undefined);
    store.flush(record);
    const saved = readSaved(dir, 'Fresh');
    assert.equal('level' in saved, false);
    assert.equal('experience' in saved, false);
  });

  it('keeps level 1 when there is experience worth keeping', () => {
    const { store } = makeStore();
    const record = store.load('Beginner');
    store.setProgress(record, 1, 500);
    assert.deepEqual(record.progress, { level: 1, experience: 500 });
  });

  it('sanitises what it is given and what it reads back', () => {
    const { store, dir } = makeStore();
    const record = store.load('Suspicious');
    store.setProgress(record, 400.7, -12);
    assert.deepEqual(record.progress, { level: 60, experience: 0 }, 'clamped to the band, floored at zero');
    store.flush(record);

    // A hand-edited file: "big" is not a level, and 99 means "high", not "forget my level".
    writeFileSync(
      join(dir, 'hacked.json'),
      JSON.stringify({ name: 'Hacked', level: 99, experience: 'lots', savedAt: 'x' }),
    );
    const hacked = new PlayerStore({ dir }).load('Hacked');
    assert.deepEqual(hacked.progress, { level: 60, experience: 0 });

    writeFileSync(join(dir, 'wordy.json'), JSON.stringify({ name: 'Wordy', level: 'big', savedAt: 'x' }));
    assert.equal(new PlayerStore({ dir }).load('Wordy').progress, undefined);
  });

  it('shows the stored level on the roster', () => {
    const { store } = makeStore();
    const record = store.load('Veteran');
    store.setProgress(record, 40, 1);
    store.flush(record);
    assert.equal(store.list()[0]!.level, 40);
  });
});

describe('the bag on disk', () => {
  const arrow: Item = { id: 'arrow', name: 'an arrow', ac: 0, size: 1, stackLimit: 20 };
  const sack: Item = { id: 'sack', name: 'a small sack', ac: 0, size: 3 };

  it('round-trips a bag, keeping stacks as stacks', () => {
    const { store, dir } = makeStore();
    const record = store.load('Packer');
    const bag: Inventory = { stacks: [{ item: arrow, count: 12 }], capacity: STARTING_CAPACITY };
    store.setInventory(record, bag);
    store.flush(record);

    const reloaded = new PlayerStore({ dir }).load('Packer');
    assert.deepEqual(reloaded.inventory, bag);
  });

  it('keeps what is inside a container', () => {
    // **The 15c bug this exists for.** `readInventory` read `item`, `count` and `remaining` and
    // stopped, so anything a player had *put somewhere* was gone at the next login — and, because
    // `setInventory` normalises through that same reader, gone before it ever reached the disk. The
    // shared test proves the reader; this proves the whole trip, which is where it actually failed.
    const { store, dir } = makeStore();
    const record = store.load('Quivered');
    const bag: Inventory = {
      stacks: [
        {
          item: sack,
          count: 1,
          held: { rule: { capacity: 30, accepts: 'missile' }, contents: [{ item: arrow, count: 20 }] },
        },
      ],
      capacity: STARTING_CAPACITY,
    };
    store.setInventory(record, bag);
    store.flush(record);

    assert.ok(JSON.stringify(readSaved(dir, 'Quivered')).includes('"held"'), 'the file itself has it');
    const reloaded = new PlayerStore({ dir }).load('Quivered');
    assert.deepEqual(reloaded.inventory, bag);
  });

  it('writes nothing for an empty bag at the default capacity', () => {
    const { store, dir } = makeStore();
    const record = store.load('Empty');
    store.setInventory(record, { stacks: [], capacity: STARTING_CAPACITY });
    store.flush(record);
    assert.equal('inventory' in readSaved(dir, 'Empty'), false);
  });
});

/**
 * A8 slice 3 — forgetting a Place's map when its grid moves.
 *
 * The offline half is the one that matters and the one a lazier implementation would miss. A resized
 * grid makes every saved bitset for the Place **wrong rather than incomplete**, and the characters
 * most likely to be hurt are the ones not connected to notice: they log in weeks later to fog lifted
 * off places they have never been.
 */
describe('forgetting a Place', () => {
  it('clears the map of a character who is nowhere near, without loading them', () => {
    const { store, dir } = makeStore();
    const away = store.load('Wanderer');
    store.markSeen(away, GROUND, 288, [0, 5, 287]);
    store.markSeen(away, { zone: 600, level: 1 }, 144, [12]);
    store.flushAll();

    // A second store over the same directory — nothing cached, exactly as it is at boot.
    const restarted = new PlayerStore({ dir });
    assert.equal(restarted.forgetPlace(GROUND), 1);

    const back = restarted.load('Wanderer');
    assert.equal(bitsetHas(restarted.seenBits(back, GROUND, 288), 5), false, 'the resized Place is blank');
    // **Only that Place.** Every other level of every other zone is indexed against its own grid and
    // has not moved, so clearing them would be destroying maps for nothing.
    assert.equal(bitsetHas(restarted.seenBits(back, { zone: 600, level: 1 }, 144), 12), true);
  });

  it('clears a cached record too, and counts both', () => {
    const { store, dir } = makeStore();
    const offline = store.load('Wanderer');
    store.markSeen(offline, GROUND, 288, [1]);
    store.flushAll();

    const restarted = new PlayerStore({ dir });
    // One loaded (so cached, standing in for an online character) and one only on disk.
    const online = restarted.load('Ravi');
    restarted.markSeen(online, GROUND, 288, [2]);

    assert.equal(restarted.forgetPlace(GROUND), 2);
    assert.equal(bitsetHas(restarted.seenBits(online, GROUND, 288), 2), false);
  });

it('writes the cleared map to disk at once, rather than on the save debounce', () => {
    const { store, dir } = makeStore();
    const record = store.load('Ravi');
    store.markSeen(record, GROUND, 288, [1, 2, 3]);
    store.flushAll();

    store.forgetPlace(GROUND);

    // **Read straight off disk, with no flush in between.** A debounced write would leave this file
    // holding the old map, and a restart inside that window is unrecoverable: by then the stored
    // extent matches the grid, so the boot-time check agrees nothing has changed and the one
    // character who was online keeps a map drawn in the wrong places for ever.
    const onDisk = JSON.parse(readFileSync(join(dir, 'ravi.json'), 'utf8')) as { seen?: Record<string, string> };
    assert.equal(onDisk.seen?.['600:0'], undefined);
  });

  it('counts only the characters that had a map there to lose', () => {
    const { store } = makeStore();
    const record = store.load('Wanderer');
    store.markSeen(record, GROUND, 288, [1]);
    assert.equal(store.forgetPlace({ zone: 600, level: 7 }), 0, 'nobody has ever been there');
    assert.equal(bitsetHas(store.seenBits(record, GROUND, 288), 1), true);
  });
});
