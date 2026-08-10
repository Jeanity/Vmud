/**
 * The admin API, driven through the same plain request/response shapes the HTTP adapter feeds it.
 *
 * Everything here runs against a temporary directory, a synthetic zone and a fake set of live
 * operations, so no test can scribble on a real character or needs a socket. The live ops record
 * what they were asked and mutate the fake player the way the real implementations mutate the
 * simulation's, which is what lets the tests read the router's returned detail views for truth.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTHORED_MOB_BASE,
  AUTHORED_ROOM_BASE,
  AUTHORED_VNUM_BASE,
  AUTHORED_ZONE_BASE,
  DURIS_ITEM,
  LPC_ART,
  boundsOf,
  noPursuit,
  passiveRule,
  readCombatStats,
  type ItemTemplate,
  type MobTemplate,
  type Room,
  type RoomId,
  type Zone,
} from '@mygame/shared';

import { AdminApi, type AdminDeps, type AdminRequest, type AnnounceScope, type LiveOps } from './admin.ts';
import { applyItemOverride, loadItemOverrides, mergeItemOverride, type ItemOverrides } from './item-overrides.ts';
import { draftAuthoredMob, type AuthoredMobStore } from './mob-authoring.ts';
import { loadPlacements, type Placements } from './placements.ts';
import { draftQuest, loadQuests, type QuestDef } from './quests.ts';
import { applyMobOverride, mergeMobOverride } from './mob-overrides.ts';
import {
  draftAuthoredItem,
  takeAuthoredVnum,
  type AuthoredStore,
  type ItemDraft,
} from './item-authoring.ts';
import { AccountStore } from './accounts.ts';
import { PlayerStore, slugify } from './players.ts';
import type { MobOverrides } from './mob-overrides.ts';
import { loadAuthoredRooms } from './room-authoring.ts';
import type { WorldSettings } from './settings.ts';
import type { Player } from './sim.ts';
import { GameWorld } from './world.ts';

/** Two rooms side by side — enough for a teleport to have somewhere to go. */
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

/** A live character with exactly the fields the router reads and the fake ops mutate. */
function fakePlayer(name: string): Player {
  return {
    id: 7,
    kind: 'player',
    name,
    level: 1,
    experience: 0,
    hp: 9,
    maxHp: 9,
    mana: 30,
    maxMana: 30,
    move: 100,
    maxMove: 100,
    posture: 'standing',
    status: 'normal',
    fighting: undefined,
    roomId: 6001,
    place: { zone: 600, level: 0 },
    light: undefined,
    affects: [],
    // A7q: real on a real `Player` and read by the quest delete, which counts who is mid-quest before
    // it strands them. Empty rather than absent, so a test that puts progress in it is putting it where
    // the server would find it.
    quests: new Map<string, number | 'done'>(),
  } as unknown as Player;
}

interface Rig {
  api: AdminApi;
  store: PlayerStore;
  accounts: AccountStore;
  dir: string;
  players: Player[];
  calls: string[];
  heard: string[];
  scopes: AnnounceScope[];
  /** A7q: the live definitions, and the giver registry re-seeded from them on every write. */
  quests: Map<string, QuestDef>;
  questGivers: Set<number>;
}

function makeRig(options: { token?: string; auditFile?: string; overridesFile?: string; itemOverridesFile?: string; authoredRoomsFile?: string; mobOverridesFile?: string; authoredMobsFile?: string; placementsFile?: string; questsFile?: string; quests?: QuestDef[]; noPopulation?: boolean; zone?: Zone; occupants?: { players: string[]; mobs: string[]; corpses: string[] }; resets?: Record<string, number> } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-admin-'));
  const store = new PlayerStore({ dir });
  // A real store in its own corner of the temp dir: the account routes are thin enough that mocking
  // the store would test the mock.
  const accounts = new AccountStore({ dir: join(dir, 'accounts') });
  const world = new GameWorld([options.zone ?? testZone()], { zone: 600, room: null });
  const players: Player[] = [];
  const granted: { name: string; copper: number }[] = [];
  void granted;
  const calls: string[] = [];
  const heard: string[] = [];
  const scopes: AnnounceScope[] = [];
  let worldSettings: WorldSettings = { pvp: false, movementCosts: true };

  // A three-entry catalogue rather than the real 16,421: these tests are about the router's search
  // and its shape, and a synthetic set is the only way to assert "two weapons, one of them
  // two-handed" without the answer moving the next time the harvest changes. Hoisted above the live
  // ops because A6's `authorItem` closes over it.
  const items = new Map<number, ItemTemplate>([
    [100, { vnum: 100, keywords: ['dagger', 'silver'], name: '&+Ca silver dagger&N', roomLine: 'x', type: 5, slot: 'mainHand', ac: 0, size: 1, cost: 40, stackLimit: 1, damage: { count: 1, sides: 4, bonus: 0 } }],
    [101, { vnum: 101, keywords: ['greatsword'], name: 'a greatsword', roomLine: 'x', type: 5, slot: 'mainHand', ac: 0, size: 6, cost: 400, stackLimit: 1, damage: { count: 2, sides: 10, bonus: 0 }, twoHanded: true }],
    [102, { vnum: 102, keywords: ['sack'], name: 'a sack', roomLine: 'x', type: 15, ac: 0, size: 3, cost: 5, stackLimit: 1, container: { capacity: 20, accepts: 'any' } }],
  ]);

  // A6's live half, faithfully: a real overlay map with real pristine copies, so the tests exercise
  // the same merge/apply/revert path `index.ts` wires rather than a fake that agrees by luck.
  const itemOverrides: ItemOverrides = new Map();
  const pristineItems = new Map<number, ItemTemplate>();
  const authored: AuthoredStore = { items: new Map(), next: AUTHORED_VNUM_BASE };

  // A4's live half. Real enough to exercise the router's validation and its refusals, which is all
  // that lives on this side of the seam: the world-touching half is `index.ts`'s and is driven rather
  // than unit-tested, exactly as `giveItem` and the teleport are.
  // Keyed on **600**, the zone this rig's world actually has: the router checks `world.zone()` before
  // it asks the live ops anything, so a fixture registered under an id the world does not know would
  // only ever exercise the 404.
  const zoneMobs = new Map<number, { id: number; vnum: number; name: string; level: number; hp: number; maxHp: number; room: RoomId; roomName: string; status: string }[]>([
    [600, [
      { id: 700, vnum: 61, name: 'a kobold guard', level: 8, hp: 40, maxHp: 55, room: 6001 as RoomId, roomName: 'A Mossy Hollow', status: 'standing' },
      { id: 701, vnum: 61, name: 'a kobold guard', level: 8, hp: 55, maxHp: 55, room: 6001 as RoomId, roomName: 'A Mossy Hollow', status: 'standing' },
    ]],
  ]);
  const doors = new Map<string, { name: string; closed: boolean; locked: boolean }>([
    ['6001:north', { name: 'a rusted gate', closed: true, locked: false }],
  ]);

  const live: LiveOps = {
    online: () => players,
    grantCoins: (player, copper) => {
      granted.push({ name: player.name, copper });
      return Math.max(0, copper);
    },
    // `noPopulation` is how the 409 branch gets exercised: a zone the world *has* but that carries no
    // population file will never repop, and that is a different answer from a zone that does not exist.
    repopZone: (zone) =>
      zone === 600 && !options.noPopulation ? { spawned: 2, doors: 1, objects: 3, atLimit: 1 } : undefined,
    workDoor: (room, dir, next) => {
      const door = doors.get(`${room}:${dir}`);
      if (!door) return { error: `there is no door ${dir} of room ${room}` };
      if (next.closed !== undefined) door.closed = next.closed;
      if (next.locked !== undefined) door.locked = next.locked;
      return { ...door };
    },
    mobsIn: (zone) => zoneMobs.get(zone) ?? [],
    slayMob: (id) => {
      for (const list of zoneMobs.values()) {
        const at = list.findIndex((m) => m.id === id);
        if (at >= 0) return { name: list.splice(at, 1)[0]!.name };
      }
      return undefined;
    },
    spawnMob: (vnum) =>
      vnum === 61 ? { id: 999, name: 'a kobold guard' } : { error: `no mob ${vnum} in the loaded templates` },
    // Derived from the same record map the real server derives it from, rather than a hardcoded pair:
    // A9b creates templates at run time, and a fixed list is a rig in which a created mob can never be
    // searched for — a test that passes because the fake cannot express the bug.
    mobTemplates: () =>
      [...mobRecords.values()]
        .map((t) => ({ vnum: t.vnum, name: t.name, level: t.level, keywords: t.keywords }))
        .sort((a, b) => a.vnum - b.vnum),
    itemOverrides: () => itemOverrides,
    authorItem: (vnum, next, clearedKeys) => {
      const current = items.get(vnum);
      if (!current) return undefined;
      const pristine = pristineItems.get(vnum) ?? current;
      const merged = mergeItemOverride(itemOverrides.get(vnum), next, clearedKeys, 'test-time');
      if (merged) {
        pristineItems.set(vnum, pristine);
        itemOverrides.set(vnum, merged);
        const applied = applyItemOverride(pristine, merged);
        items.set(vnum, applied);
        return applied;
      }
      itemOverrides.delete(vnum);
      pristineItems.delete(vnum);
      items.set(vnum, pristine);
      return pristine;
    },
    // A6b's live half, equally faithfully: the real validator and the real allocator over a real map,
    // so a route test that creates an item exercises the same refusals the server does.
    authoredItems: () => authored.items,
    authorNewItem: (vnum, draft, by) => {
      const existing = vnum === undefined ? undefined : authored.items.get(vnum);
      if (vnum !== undefined && !existing) return { error: `no item created here with vnum ${vnum}` };
      const merged: ItemDraft = existing ? { ...existing.item, ...draft } : draft;
      const drafted = draftAuthoredItem(vnum ?? authored.next, merged);
      if ('error' in drafted) return drafted;
      const number = vnum ?? takeAuthoredVnum(authored);
      authored.items.set(number, { item: drafted.item, at: 'test-time', by });
      items.set(number, drafted.item);
      return { item: drafted.item };
    },
    deleteAuthoredItem: (vnum) => {
      if (!authored.items.has(vnum)) return false;
      authored.items.delete(vnum);
      items.delete(vnum);
      return true;
    },
    giveItem: (player, vnum) => {
      const template = items.get(vnum);
      if (!template) return { error: `no item ${vnum} in the catalogue` };
      calls.push(`give ${player.name} ${vnum}`);
      return { name: template.name };
    },
    setVitals: (player, pools) => {
      if (pools.hp !== undefined) player.hp = pools.hp;
      if (pools.mana !== undefined) player.mana = pools.mana;
      if (pools.move !== undefined) player.move = pools.move;
      calls.push(`setVitals ${JSON.stringify(pools)}`);
    },
    setLevel: (player, level) => {
      // The real implementation swaps in a whole profile; what matters to the router is that the
      // maxima move before any pool clamp reads them.
      player.level = level;
      player.maxHp = level * 10;
      player.hp = player.maxHp;
      calls.push(`setLevel ${level}`);
    },
    setLight: (player, source) => {
      (player as { light: unknown }).light = source ? { id: source.id, name: source.name, radius: source.radius } : undefined;
      calls.push(`setLight ${source?.id ?? 'none'}`);
    },
    clearAffects: (player) => {
      (player as { affects: unknown[] }).affects = [];
      calls.push('clearAffects');
    },
    teleport: (player, room) => {
      player.roomId = room;
      calls.push(`teleport ${room}`);
      return true;
    },
    tell: (_player, text) => void calls.push(`tell ${text}`),
    kick: (player) => void calls.push(`kick ${player.name}`),
    // A3's two reads, answered with fixtures: what these tests check is that the router asks and
    // shapes the reply, not that the simulation can count bodies.
    // A9c reads this as "does anything ever run this zone's reset table", which is what `noPopulation`
    // means here: a zone the world has, with no clock behind it.
    repopIn: (zone) => (zone === 600 && !options.noPopulation ? 90_000 : undefined),
    occupantsOf: () => options.occupants ?? { players: ['Ravi'], mobs: ['a sentry'], corpses: [] },
    // A8 slice 2. Recorded rather than simulated: what these tests check is that the router refuses,
    // orders and reports — whether a mob is actually gone is `sim`'s to prove, not the router's.
    clearRoom: (room) => {
      calls.push(`clearRoom ${room}`);
      return { mobs: 2, corpses: 1, items: 0 };
    },
    resetsNaming: () => options.resets ?? {},
    // A4c. The overlay lives in the rig, so a test can assert what was written without a file.
    mobOverrides: () => mobLoot,
    liveCountOf: () => 3,
    // A9c. A plain map, because the interesting half of placement is the router's validation — the
    // merge into live reset tables is `index.ts`'s and is driven rather than unit-tested, exactly as the
    // teleport and `giveItem` are.
    placements: () => placed,
    placeMob: (vnum, rows) => {
      if (!mobRecords.has(vnum)) return undefined;
      if (rows.length === 0) placed.delete(vnum);
      else placed.set(vnum, [...rows]);
      calls.push(`placeMob ${vnum} x${rows.length}`);
      return placed.get(vnum) ?? [];
    },
    // A9b. The rig runs the real store and the real validator, so a router test is also a test of the
    // record it wrote — a draft that lands wrong shows up as a bad template rather than as a call log
    // that looks right.
    authoredMobs: () => madeHere,
    authorNewMob: (vnum, draft) => {
      const number = vnum ?? madeHere.next;
      if (vnum !== undefined && !madeHere.mobs.has(vnum)) return { error: `no mob ${vnum} was made here` };
      const drafted = draftAuthoredMob(number, draft);
      if ('error' in drafted) return drafted;
      madeHere.mobs.set(number, { mob: drafted.mob, at: 'test-time' });
      if (vnum === undefined) madeHere.next = number + 1;
      mobRecords.set(number, drafted.mob);
      return { mob: drafted.mob };
    },
    unmakeMob: (vnum) => {
      const authored = madeHere.mobs.get(vnum);
      if (!authored) return undefined;
      madeHere.mobs.delete(vnum);
      mobRecords.delete(vnum);
      return { name: authored.mob.name, standing: 2 };
    },
    // A9. The rig runs the real fold, so a test of the router is also a test of what it wrote: a patch
    // that lands wrong here shows up as a wrong template rather than as a call log that looks right.
    mobTemplateOf: (vnum) => mobRecords.get(vnum),
    authorMob: (vnum, next, clearedKeys) => {
      calls.push(`authorMob ${vnum} ${Object.keys(next).join(',')} -${clearedKeys.join(',')}`);
      const current = mobRecords.get(vnum);
      if (!current) return undefined;
      const pristine = pristineMobs.get(vnum) ?? current;
      const merged = mergeMobOverride(mobLoot.get(vnum), next, clearedKeys, 'test-time');
      if (merged) {
        pristineMobs.set(vnum, pristine);
        mobLoot.set(vnum, merged);
        const applied = applyMobOverride(pristine, merged);
        mobRecords.set(vnum, applied);
        return applied;
      }
      mobLoot.delete(vnum);
      pristineMobs.delete(vnum);
      mobRecords.set(vnum, pristine);
      return pristine;
    },
    authorMobLoot: (vnum, loot) => {
      calls.push(`authorMobLoot ${vnum} x${loot.length}`);
      if (loot.length === 0) {
        mobLoot.delete(vnum);
        return { loot: [] };
      }
      const override = { loot: [...loot] };
      mobLoot.set(vnum, override);
      return override;
    },
    forgetPlace: (place) => {
      calls.push(`forgetPlace ${place.zone}:${place.level}`);
      return { characters: 3, told: 1 };
    },
    // A7q. The real map, the real re-seed, and a `resynced` count derived from the bodies the rig has
    // standing — so a test that deletes a quest can assert the giver was actually re-sent, which is the
    // half of the feature that is invisible from the response body alone.
    quests: () => questDefs,
    setQuests: (next) => {
      const before = new Set([...questDefs.values()].map((quest) => quest.giver));
      // Mirrors `index.ts` exactly, including the armour diff: a giver whose `protectGiver` flips is
      // still the same giver, so the badge comparison alone reports no change and re-sends nothing.
      const beforeProtected = new Set(
        [...questDefs.values()].filter((quest) => quest.protectGiver === true).map((quest) => quest.giver),
      );
      questDefs.clear();
      for (const quest of next) questDefs.set(quest.id, quest);
      questGivers.clear();
      const protectedGivers = new Set<number>();
      for (const quest of questDefs.values()) {
        questGivers.add(quest.giver);
        if (quest.protectGiver === true) protectedGivers.add(quest.giver);
      }
      const flipped = new Set<number>();
      for (const vnum of before) if (!questGivers.has(vnum)) flipped.add(vnum);
      for (const vnum of questGivers) if (!before.has(vnum)) flipped.add(vnum);
      for (const vnum of beforeProtected) if (!protectedGivers.has(vnum)) flipped.add(vnum);
      for (const vnum of protectedGivers) if (!beforeProtected.has(vnum)) flipped.add(vnum);
      let resynced = 0;
      for (const list of zoneMobs.values()) for (const mob of list) if (flipped.has(mob.vnum)) resynced++;
      calls.push(`setQuests ${questDefs.size} givers=${[...questGivers].join(',')}`);
      return { givers: [...questGivers].sort((a, b) => a - b), resynced };
    },
    publishRoom: (room, _place, regrid) => void calls.push(`publishRoom ${room.id} regrid=${regrid}`),
    // Held in the rig rather than written to disk: what these tests check is that the router reads,
    // validates and announces, not that a JSON file round-trips.
    settings: () => worldSettings,
    setSettings: (next) => {
      worldSettings = next;
      calls.push(`setSettings pvp=${next.pvp}`);
    },
  };

  // A4c: the authored-loot overlay this rig pretends to hold. **A9 shares it** — one record per vnum
  // holds a template's kit and its fields together, which is the thing that has to be true or a loot
  // save would unauthor a name.
  const mobLoot: MobOverrides = new Map();

  // A9: two synthetic templates, matching the summaries `mobTemplates` returns above. Full records
  // rather than rows, because the field editor reads and writes the whole thing.
  const mobRecords = new Map<number, MobTemplate>([
    [61, { vnum: 61, keywords: ['kobold', 'guard'], name: 'a kobold guard', room: 'A kobold guard stands here.', level: 8, hp: '8d8+16', sprite: 'kobold', aggro: passiveRule(8), pursuit: noPursuit(), combat: readCombatStats({ level: 8, armour: 40, damage: '2d6+2' }), experience: 500, wimpyAt: 0 }],
    [62, { vnum: 62, keywords: ['kobold', 'shaman'], name: '&+ya kobold shaman&N', room: 'A shaman mutters here.', level: 23, hp: '23d10+60', sprite: 'kobold', aggro: passiveRule(23), pursuit: noPursuit(), combat: readCombatStats({ level: 23, armour: 10, damage: '3d8' }), experience: 9000, wimpyAt: 138 }],
  ]);
  const pristineMobs = new Map<number, MobTemplate>();
  // A9c: where each mob is authored to live. Empty to start, exactly as a fresh server's is.
  const placed: Placements = new Map();

  // A9b: the created-mob store. Empty to start, exactly as a fresh server's is.
  const madeHere: AuthoredMobStore = { mobs: new Map(), next: AUTHORED_MOB_BASE };

  // A7q: the authored quests, and the giver registry `index.ts` seeds from them. Two structures rather
  // than one derived on demand, because the thing under test is precisely that the second is re-seeded
  // whenever the first is written — a derived getter could not fail the way the real code can.
  const questDefs = new Map<string, QuestDef>(
    (options.quests ?? []).map((quest) => [quest.id, quest] as const),
  );
  const questGivers = new Set<number>([...questDefs.values()].map((quest) => quest.giver));

  const deps: AdminDeps = {
    world,
    store,
    accounts,
    live,
    items,
    // Records the scope as well as the line: what these tests are checking is that the router
    // *resolved and validated* the target, not that the server walks the right set of players.
    announce: (text, scope) => {
      heard.push(text);
      scopes.push(scope);
      return players.length;
    },
    token: options.token,
    auditFile: options.auditFile,
    // Undefined unless a test asks: authoring must never write into the repository's real overlay.
    overridesFile: options.overridesFile,
    authoredRoomsFile: options.authoredRoomsFile,
    mobOverridesFile: options.mobOverridesFile,
    authoredMobsFile: options.authoredMobsFile,
    placementsFile: options.placementsFile,
    itemOverridesFile: options.itemOverridesFile,
    questsFile: options.questsFile,
    facts: { protocol: 9, tickMs: 100, roundMs: 3000, startedAt: Date.now() },
  };
  return { api: new AdminApi(deps), store, accounts, dir, players, calls, heard, scopes, quests: questDefs, questGivers };
}

function req(method: string, path: string, body?: unknown): AdminRequest {
  return { method, path, token: 'anything', remote: '127.0.0.1', body };
}

/** Runs `body` with console noise captured — the audit trail logs every mutation by design. */
function quietly<T>(body: () => T): T {
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (): void => {};
  console.warn = (): void => {};
  try {
    return body();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
}

describe('the gate', () => {
  it('requires the header before it cares about the value', () => {
    const { api } = makeRig();
    const bare = api.route({ method: 'GET', path: '/status', token: undefined, remote: '127.0.0.1', body: undefined });
    assert.equal(bare.status, 401);
    assert.match(String((bare.body as { error: string }).error), /x-admin-token/);
  });

  it('checks the token only when one is configured', () => {
    const open = makeRig();
    assert.equal(open.api.route(req('GET', '/status')).status, 200);

    const locked = makeRig({ token: 'hunter2' });
    assert.equal(locked.api.route(req('GET', '/status')).status, 401);
    assert.equal(
      locked.api.route({ method: 'GET', path: '/status', token: 'hunter2', remote: '127.0.0.1', body: undefined }).status,
      200,
    );
  });

  it('refuses anything that is not loopback, token or no token', () => {
    const { api } = makeRig({ token: 'hunter2' });
    for (const remote of ['192.168.1.20', undefined]) {
      const response = api.route({ method: 'GET', path: '/status', token: 'hunter2', remote, body: undefined });
      assert.equal(response.status, 403);
    }
  });
});

describe('the reads', () => {
  it('reports the world and the catalogue on /status', () => {
    const { api, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    const body = api.route(req('GET', '/status')).body as Record<string, unknown>;
    assert.equal(body.playersOnline, 1);
    assert.equal((body.zones as unknown[]).length, 1);
    assert.ok((body.lights as { id: string }[]).some((l) => l.id === 'torch'));
    assert.equal(body.token, 'open (loopback only)');
  });

  it('lists rooms for the teleport picker', () => {
    const { api } = makeRig();
    const body = api.route(req('GET', '/rooms')).body as { rooms: { id: number; name: string }[] };
    assert.deepEqual(body.rooms.map((r) => r.id), [6001, 6002]);
  });

  it('splits the roster into online and stored-only', () => {
    const { api, store, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    // Ravi also has a file — the roster must not list them twice.
    store.flush(store.load('Ravi'));
    store.flush(store.load('Asleep'));

    const body = api.route(req('GET', '/players')).body as {
      online: { slug: string }[];
      stored: { slug: string }[];
    };
    assert.deepEqual(body.online.map((p) => p.slug), ['ravi']);
    assert.deepEqual(body.stored.map((p) => p.slug), ['asleep']);
  });

  it('404s a character nobody has', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('GET', '/players/nobody')).status, 404);
  });

  it('shows both halves of an online character, labelled', () => {
    const { api, store, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    store.markTaken(store.load('Ravi'), 'pickup:6001:0');

    const body = api.route(req('GET', '/players/ravi')).body as Record<string, unknown>;
    assert.equal(body.online, true);
    assert.equal((body.live as { hp: number }).hp, 9);
    assert.equal((body.record as { takenCount: number }).takenCount, 1);
  });
});

describe('editing a live character', () => {
  it('clamps pools to what the body can hold, and hp never below 1', () => {
    const { api, players, calls } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('PATCH', '/players/ravi', { hp: 99999, mana: -40 })));
    assert.equal(response.status, 200);
    assert.equal(calls[0], 'setVitals {"hp":9,"mana":0}');

    quietly(() => api.route(req('PATCH', '/players/ravi', { hp: -5 })));
    assert.equal(calls[1], 'setVitals {"hp":1}');
  });

  it('applies level before pools, so the clamp reads the new maximum', () => {
    const { api, players, calls } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('PATCH', '/players/ravi', { level: 35, hp: 200 })));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['setLevel 35', 'setVitals {"hp":200}']);
    assert.equal((response.body as { live: { hp: number } }).live.hp, 200, 'level 35 holds 350, so 200 stands');
  });

  it('refuses a wound on a live character rather than accepting what disconnect would discard', () => {
    const { api, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    const response = api.route(req('PATCH', '/players/ravi', { wound: { hp: 3 } }));
    assert.equal(response.status, 409);
    assert.match((response.body as { error: string }).error, /online/);
  });

  it('refuses unknown fields and unknown lights by name', () => {
    const { api, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    assert.match(
      (api.route(req('PATCH', '/players/ravi', { hitpoints: 4 })).body as { error: string }).error,
      /unknown field "hitpoints"/,
    );
    assert.match(
      (api.route(req('PATCH', '/players/ravi', { light: 'sun' })).body as { error: string }).error,
      /unknown light "sun".*torch/,
    );
  });

  it('grants and extinguishes a light through the live seam', () => {
    const { api, players, calls } = makeRig();
    players.push(fakePlayer('Ravi'));
    const granted = quietly(() => api.route(req('PATCH', '/players/ravi', { light: 'torch' })));
    assert.equal((granted.body as { live: { light: { id: string } } }).live.light.id, 'torch');
    quietly(() => api.route(req('PATCH', '/players/ravi', { light: null })));
    assert.deepEqual(calls, ['setLight torch', 'setLight none']);
  });
});

describe('editing a stored character', () => {
  it('sets the wound, writes the file at once, and heals it away again', () => {
    const { api, store, dir } = makeRig();
    store.flush(store.load('Asleep'));

    const response = quietly(() => api.route(req('PATCH', '/players/asleep', { wound: { hp: 4 } })));
    assert.equal(response.status, 200);
    const saved = JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')) as { missing?: unknown };
    assert.deepEqual(saved.missing, { hp: 4, mana: 0, move: 0 });

    quietly(() => api.route(req('PATCH', '/players/asleep', { healed: true })));
    const healed = JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')) as { missing?: unknown };
    assert.equal('missing' in healed, false);
  });

  it('writes a granted light in the shape the loader already validates', () => {
    const { api, store, dir } = makeRig();
    store.flush(store.load('Asleep'));

    quietly(() => api.route(req('PATCH', '/players/asleep', { light: 'torch' })));
    const saved = JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')) as {
      affects: { type: string; context: string; durationMs: number }[];
    };
    assert.equal(saved.affects.length, 1);
    assert.equal(saved.affects[0]!.type, 'light');
    assert.equal(saved.affects[0]!.context, 'torch');
    assert.equal(saved.affects[0]!.durationMs, 240_000, 'a fresh grant carries the full burn');

    // And the round trip holds: a new store loads it as a real affect.
    const reloaded = new PlayerStore({ dir }).load('Asleep');
    assert.equal(reloaded.affects.length, 1);
    assert.equal(reloaded.affects[0]!.context, 'torch');
  });

  it('refuses pools offline, with the reason', () => {
    const { api, store } = makeRig();
    store.flush(store.load('Asleep'));
    assert.match(
      (api.route(req('PATCH', '/players/asleep', { hp: 5 })).body as { error: string }).error,
      /stored as the wound/,
    );
  });

  it('sets a level offline, permanently, keeping the experience they had', () => {
    const { api, store, dir } = makeRig();
    const record = store.load('Asleep');
    store.setProgress(record, 10, 4_000);
    store.flush(record);

    const response = quietly(() => api.route(req('PATCH', '/players/asleep', { level: 30 })));
    assert.equal(response.status, 200);
    assert.equal((response.body as { record: { level: number } }).record.level, 30);
    const saved = JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')) as { level?: number; experience?: number };
    assert.equal(saved.level, 30);
    assert.equal(saved.experience, 4_000, 'a level edit is not an opinion about what they earned');
  });
});

describe('the verbs', () => {
  it('teleports a live character and refuses rooms the world does not have', () => {
    const { api, players, calls } = makeRig();
    players.push(fakePlayer('Ravi'));

    assert.equal(api.route(req('POST', '/players/ravi/teleport', { room: 99999 })).status, 400);
    const response = quietly(() => api.route(req('POST', '/players/ravi/teleport', { room: 6002 })));
    assert.equal(response.status, 200);
    assert.deepEqual(calls, ['teleport 6002']);
    assert.equal((response.body as { live: { room: { id: number } } }).live.room.id, 6002);
  });

  it('moves the offline by writing lastRoom, which login now honours', () => {
    const { api, store, dir } = makeRig();
    store.flush(store.load('Asleep'));
    const response = quietly(() => api.route(req('POST', '/players/asleep/teleport', { room: 6002 })));
    assert.equal(response.status, 200);
    assert.equal((response.body as { record: { lastRoom: { id: number } } }).record.lastRoom.id, 6002);
    const saved = JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')) as { lastRoom?: number };
    assert.equal(saved.lastRoom, 6002);
    // A room the world does not have is still refused, offline or not.
    assert.equal(api.route(req('POST', '/players/asleep/teleport', { room: 99999 })).status, 400);
  });

  it('tells and kicks the connected, and says why it cannot otherwise', () => {
    const { api, players, calls } = makeRig();
    assert.equal(api.route(req('POST', '/players/ravi/tell', { text: 'hello' })).status, 409);

    players.push(fakePlayer('Ravi'));
    quietly(() => api.route(req('POST', '/players/ravi/tell', { text: '  hello   there \n friend ' })));
    assert.equal(calls[0], 'tell hello there friend', 'operator speech is collapsed to one line');
    quietly(() => api.route(req('POST', '/players/ravi/kick')));
    assert.equal(calls[1], 'kick Ravi');
  });

  it('resets pickups and reports the count', () => {
    const { api, store } = makeRig();
    const record = store.load('Collector');
    store.markTaken(record, 'one');
    store.markTaken(record, 'two');
    store.flush(record);

    const response = quietly(() => api.route(req('POST', '/players/collector/reset-pickups')));
    assert.deepEqual(response.body, { ok: true, cleared: 2 });
  });

  it('deletes only the offline, once', () => {
    const { api, store, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    store.flush(store.load('Ravi'));
    store.flush(store.load('Asleep'));

    assert.equal(api.route(req('DELETE', '/players/ravi')).status, 409);
    assert.equal(quietly(() => api.route(req('DELETE', '/players/asleep'))).status, 200);
    assert.equal(api.route(req('DELETE', '/players/asleep')).status, 404);
  });

  it('announces to everyone and rejects a paste-sized line', () => {
    const { api, players, heard, scopes } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('POST', '/announce', { text: 'The server restarts in five minutes.' })));
    assert.deepEqual(response.body, { ok: true, heard: 1, where: 'the world' });
    assert.deepEqual(heard, ['The server restarts in five minutes.']);
    assert.deepEqual(scopes, [{ kind: 'world' }], 'no target named means the world');
    assert.equal(api.route(req('POST', '/announce', { text: 'x'.repeat(400) })).status, 400);
  });

  it('narrows to a room, and names it back so the operator can see where it went', () => {
    const { api, players, scopes } = makeRig();
    players.push(fakePlayer('Ravi'));
    const response = quietly(() => api.route(req('POST', '/announce', { text: 'Mind the gap.', room: 6002 })));
    assert.equal(response.status, 200);
    assert.deepEqual(scopes, [{ kind: 'room', room: 6002 }]);
    assert.match((response.body as { where: string }).where, /A Fallen Log/);
  });

  it('narrows to a place, parsed from the same string /status reports', () => {
    const { api, scopes } = makeRig();
    const response = quietly(() => api.route(req('POST', '/announce', { text: 'Snow is falling.', place: '600:0' })));
    assert.equal(response.status, 200);
    assert.deepEqual(scopes, [{ kind: 'place', place: { zone: 600, level: 0 } }]);
  });

  it('refuses a target the world does not have, rather than shouting into nowhere', () => {
    const { api, scopes } = makeRig();
    assert.equal(api.route(req('POST', '/announce', { text: 'hello', room: 99999 })).status, 400);
    assert.equal(api.route(req('POST', '/announce', { text: 'hello', place: '600:9' })).status, 400);
    assert.equal(api.route(req('POST', '/announce', { text: 'hello', place: 'the archives' })).status, 400);
    assert.deepEqual(scopes, [], 'nothing was said');
  });

  it('refuses both targets at once rather than picking one', () => {
    // An operator who named a room *and* a place meant one of them, and guessing which sends the
    // line to the wrong people — which is the one failure an announcement cannot take back.
    const { api } = makeRig();
    const response = api.route(req('POST', '/announce', { text: 'hello', room: 6001, place: '600:0' }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /not both/);
  });

  it('reports the world switches, off by default', () => {
    const { api } = makeRig();
    assert.deepEqual(api.route(req('GET', '/settings')).body, { settings: { pvp: false, movementCosts: true } });
  });

  it('throws the PvP switch and tells the whole world it happened', () => {
    // Announcing is the requirement, not a courtesy: this switch decides whether the person next to
    // you can kill you, and finding out by dying is not acceptable.
    const { api, players, heard, scopes } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('PATCH', '/settings', { pvp: true })));
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { settings: unknown }).settings, { pvp: true, movementCosts: true });
    assert.equal((response.body as { changed: boolean }).changed, true);
    assert.equal(heard.length, 1);
    assert.match(heard[0]!, /now ON/);
    assert.deepEqual(scopes, [{ kind: 'world' }], 'a rule change is never scoped');
  });

  it('throws the movement switch and announces it, both ways', () => {
    // The owner's event switch (2026-08-07). Announced like PvP and for the mirrored reason: one
    // decides whether your neighbour can kill you, the other whether the ocean can.
    const { api, heard } = makeRig();
    const freed = quietly(() => api.route(req('PATCH', '/settings', { movementCosts: false })));
    assert.equal(freed.status, 200);
    assert.deepEqual((freed.body as { settings: unknown }).settings, { pvp: false, movementCosts: false });
    assert.match(heard[0] ?? '', /FREE/);
    quietly(() => api.route(req('PATCH', '/settings', { movementCosts: true })));
    assert.match(heard[1] ?? '', /back ON/);
  });

  it('says nothing when the switch is already where you set it', () => {
    // Re-saving a panel that is already correct must not spam a world that is already correct.
    const { api, heard } = makeRig();
    const response = quietly(() => api.route(req('PATCH', '/settings', { pvp: false })));
    assert.equal((response.body as { changed: boolean }).changed, false);
    assert.deepEqual(heard, []);
  });

  it('refuses anything that is not a boolean rather than guessing', () => {
    // The safe reading of a malformed dangerous flag is to refuse it. `"true"` and `1` both look like
    // consent and neither is.
    const { api, calls } = makeRig();
    for (const pvp of ['true', 1, null, undefined]) {
      assert.equal(api.route(req('PATCH', '/settings', { pvp })).status, 400);
    }
    assert.deepEqual(calls.filter((c) => c.startsWith('setSettings')), []);
  });

  it('leaves an audit line for every mutation', () => {
    const auditFile = join(mkdtempSync(join(tmpdir(), 'mygame-audit-')), 'admin-audit.jsonl');
    const rig = makeRig({ auditFile });
    rig.players.push(fakePlayer('Ravi'));
    quietly(() => rig.api.route(req('POST', '/players/ravi/tell', { text: 'logged' })));

    const lines = readFileSync(auditFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!) as { action: string; slug: string; text: string };
    assert.equal(entry.action, 'tell');
    assert.equal(entry.slug, 'ravi');
    assert.equal(entry.text, 'logged');
  });
});

describe('identity', () => {
  it('keys everything on the same slugify the store uses', () => {
    const { api, players } = makeRig();
    players.push(fakePlayer('Sir Reginald III'));
    const slug = slugify('Sir Reginald III');
    const response = api.route(req('GET', `/players/${slug}`));
    assert.equal(response.status, 200);
    assert.equal((response.body as { name: string }).name, 'Sir Reginald III');
  });
});

describe('the zone browser', () => {
  it('lists zones with their live repop clock, and says nothing rather than zero', () => {
    // "Never repops" and "repops now" are opposite facts; a zone with no population file reports
    // null so the panel can draw a dash instead of an alarming 0.
    const { api } = makeRig();
    const body = api.route(req('GET', '/zones')).body as {
      zones: { id: number; name: string; rooms: number; repopInMs: number | null; described: number }[];
    };
    assert.equal(body.zones.length, 1);
    assert.equal(body.zones[0]!.id, 600);
    assert.equal(body.zones[0]!.rooms, 2);
    assert.equal(body.zones[0]!.repopInMs, 90_000);
    assert.equal(body.zones[0]!.described, 0, 'the synthetic zone carries no prose, and says so');
  });

  it('browses one zone room by room, with who is standing in each', () => {
    const { api } = makeRig();
    const body = api.route(req('GET', '/zones/600/rooms')).body as {
      zone: { id: number };
      rooms: {
        id: number;
        name: string;
        x: number;
        y: number;
        sector: string;
        exits: { dir: string; to: number }[];
        occupants: { mobs: string[] };
      }[];
    };
    assert.equal(body.zone.id, 600);
    assert.deepEqual(body.rooms.map((r) => r.id), [6001, 6002]);
    // The cell on this zone's own normalised grid — the map's entire input, so it is worth pinning.
    assert.deepEqual([body.rooms[0]!.x, body.rooms[0]!.y], [0, 0]);
    assert.deepEqual([body.rooms[1]!.x, body.rooms[1]!.y], [1, 0]);
    // Destination as well as direction. The map draws a neighbour line only when the exit really
    // lands in the cell the direction points at — otherwise it is a portal or a staircase, and a
    // line would assert an adjacency the world does not have.
    assert.deepEqual(body.rooms[0]!.exits, [{ dir: 'east', to: 6002 }]);
    assert.deepEqual(body.rooms[0]!.occupants.mobs, ['a sentry'], 'live, not what the reset table meant');
  });

  it('refuses a zone the server is not running', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('GET', '/zones/999/rooms')).status, 404);
    assert.equal(api.route(req('GET', '/zones/nonsense/rooms')).status, 400);
  });

  it('describes one room, with the live state of every way out', () => {
    // Door state is mutated by open/close and put back by the repop, which is exactly why it belongs
    // in a panel: this is the only place that says whether a door is standing open right now.
    const { api } = makeRig();
    const body = api.route(req('GET', '/rooms/6001')).body as {
      name: string;
      place: string;
      description: string | null;
      exits: { dir: string; to: number; toName: string; door: unknown }[];
    };
    assert.equal(body.name, 'A Mossy Hollow');
    assert.equal(body.place, '600:0');
    assert.equal(body.description, null, 'absent prose reads as absent, not as an empty string');
    assert.equal(body.exits.length, 1);
    assert.equal(body.exits[0]!.dir, 'east');
    assert.equal(body.exits[0]!.toName, 'A Fallen Log', 'named, so the browser is navigable');
  });

  it('404s a room the world does not have', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('GET', '/rooms/99999')).status, 404);
  });

  it('carries the neighbouring rooms and their prose', () => {
    // The context a room cannot be written without: "Southwestern Corner Of the Banquet Hall" does
    // not say whether the hall is laid for a feast or in ruins, and the room next door does.
    const { api } = makeRig();
    const body = api.route(req('GET', '/rooms/6001')).body as {
      nearby: { id: number; hops: number; dir: string | null; name: string; description: string | null }[];
    };
    assert.equal(body.nearby.length, 1);
    assert.deepEqual(
      { id: body.nearby[0]!.id, hops: body.nearby[0]!.hops, dir: body.nearby[0]!.dir },
      { id: 6002, hops: 1, dir: 'east' },
    );
  });

  it('never lists the room itself, however the exits loop back', () => {
    const { api } = makeRig();
    const body = api.route(req('GET', '/rooms/6001')).body as { nearby: { id: number }[] };
    // 6001 → east → 6002 → west → 6001. Without the seen-set the second hop walks straight home and
    // the author is shown the room they are editing as context for itself.
    assert.ok(!body.nearby.some((near) => near.id === 6001));
  });

  it('keeps machine-written prose out of the panel\'s own context, or rather does not', () => {
    // The panel shows *everything*, including what a model wrote — an author needs to read their own
    // zone back. It is only the **model's** view that is filtered, and that filtering lives in
    // `promptNeighbours`, not here. Pinned so the cascade fix is not "helpfully" widened to the
    // panel, which would hide an author's work from them.
    const { api } = makeRig();
    quietly(() => api.route(req('PATCH', '/rooms/6002', { description: 'Machine wrote this.', by: 'gemma3:12b' })));
    const body = api.route(req('GET', '/rooms/6001')).body as { nearby: { id: number; description: string | null }[] };
    const neighbour = body.nearby.find((n) => n.id === 6002);
    assert.equal(neighbour?.description, 'Machine wrote this.', 'the human still sees it');
  });

  it('says whether an exit leads anywhere this server has loaded', () => {
    const { api } = makeRig();
    const body = api.route(req('GET', '/rooms/6001')).body as {
      exits: { dir: string; toName: string | null; loaded: boolean; toZone: unknown }[];
    };
    assert.equal(body.exits[0]!.loaded, true);
    assert.equal(body.exits[0]!.toName, 'A Fallen Log');
    // Null for a loaded destination: the room name says everything, and a zone label on every local
    // exit would be noise on 99% of them.
    assert.equal(body.exits[0]!.toZone, null);
  });
});

describe('authoring a room', () => {
  /** The room as the router now reports it — the shape the panel re-renders from after a save. */
  const roomOf = (api: AdminApi, id: number) =>
    api.route(req('GET', `/rooms/${id}`)).body as {
      name: string;
      sector: string;
      flags: string[];
      description: string | null;
      authored: Record<string, unknown> | null;
    };

  it('writes name, prose, terrain and flags onto the live room', () => {
    const { api } = makeRig();
    const response = quietly(() =>
      api.route(
        req('PATCH', '/rooms/6001', {
          name: '&+GThe Mossy Hollow&N',
          description: 'Green light, and no sound at all.',
          sector: 'swamp',
          flags: ['dark', 'safe'],
        }),
      ),
    );
    assert.equal(response.status, 200);

    const room = roomOf(api, 6001);
    assert.equal(room.name, '&+GThe Mossy Hollow&N', 'colour codes are content, stored verbatim');
    assert.equal(room.description, 'Green light, and no sound at all.');
    assert.equal(room.sector, 'swamp');
    assert.deepEqual(room.flags, ['dark', 'safe']);
  });

  it('refuses geometry rather than ignoring it', () => {
    const { api } = makeRig();
    // Silently dropping these is the dangerous version: a panel that posts `pos` and gets a 200 has
    // told its operator the room moved. Position, exits and id are A8's, and they are the join key.
    for (const field of ['pos', 'exits', 'id', 'zone']) {
      const response = quietly(() => api.route(req('PATCH', '/rooms/6001', { [field]: 1 })));
      assert.equal(response.status, 400, `${field} must be refused`);
      assert.match(String((response.body as { error: string }).error), /not authorable/);
    }
    assert.equal(roomOf(api, 6001).authored, null, 'and nothing was written');
  });

  it('refuses a sector the game does not have, and changes nothing', () => {
    const { api } = makeRig();
    const response = quietly(() => api.route(req('PATCH', '/rooms/6001', { sector: 'forrest' })));
    assert.equal(response.status, 400);
    assert.equal(roomOf(api, 6001).sector, 'forest');
  });

  it('says when the terrain moved, because that re-carves the tilemap', () => {
    const { rig } = { rig: makeRig() };
    quietly(() => rig.api.route(req('PATCH', '/rooms/6001', { description: 'Prose only.' })));
    assert.ok(rig.calls.includes('publishRoom 6001 regrid=false'), 'prose is description, not terrain');

    quietly(() => rig.api.route(req('PATCH', '/rooms/6001', { sector: 'deep_water' })));
    assert.ok(rig.calls.includes('publishRoom 6001 regrid=true'), 'terrain re-carves the grid');
  });

  it('re-carves on the way back too — a reverted sector is still a sector change', () => {
    // The live desync this prevents: reverting restores the terrain without *setting* one, so a test
    // shaped like "did the patch name a sector" answers no while the terrain has in fact changed
    // back. The server kept a water grid under a floor of ice.
    const { api, calls } = makeRig();
    quietly(() => api.route(req('PATCH', '/rooms/6001', { sector: 'deep_water' })));
    calls.length = 0;
    quietly(() => api.route(req('PATCH', '/rooms/6001', { sector: null })));

    assert.equal(roomOf(api, 6001).sector, 'forest');
    assert.ok(calls.includes('publishRoom 6001 regrid=true'));
  });

  it('reverts a field to the generated value and leaves the others authored', () => {
    const { api } = makeRig();
    quietly(() => api.route(req('PATCH', '/rooms/6001', { name: 'Renamed', description: 'Written.' })));
    quietly(() => api.route(req('PATCH', '/rooms/6001', { description: null })));

    const room = roomOf(api, 6001);
    assert.equal(room.name, 'Renamed', 'reverting prose must not silently rename the room back');
    assert.equal(room.description, null);
    assert.deepEqual(Object.keys(room.authored ?? {}).filter((k) => k !== 'at'), ['name']);
  });

  it('leaves no entry behind when the last authored field is reverted', () => {
    const { api } = makeRig();
    quietly(() => api.route(req('PATCH', '/rooms/6001', { description: 'Written.' })));
    quietly(() => api.route(req('PATCH', '/rooms/6001', { description: null })));

    // Not `{ at: … }`: an override of nothing but a timestamp still reads as authored to every
    // check that asks whether an entry exists, so the room would wear the mark forever.
    assert.equal(roomOf(api, 6001).authored, null);
  });

  it('refuses an empty patch rather than stamping the room', () => {
    const { api } = makeRig();
    assert.equal(quietly(() => api.route(req('PATCH', '/rooms/6001', {}))).status, 400);
    assert.equal(roomOf(api, 6001).authored, null);
  });

  it('404s a room that is not loaded', () => {
    const { api } = makeRig();
    assert.equal(quietly(() => api.route(req('PATCH', '/rooms/99999', { name: 'Nowhere' }))).status, 404);
  });
});

describe('the item catalogue', () => {
  /** The search takes its term from the query string, which is the one read that cannot use the path. */
  function search(api: AdminApi, query: Record<string, string>): { total: number; items: Record<string, unknown>[] } {
    const response = api.route({ ...req('GET', '/items'), query });
    assert.equal(response.status, 200);
    return response.body as { total: number; items: Record<string, unknown>[] };
  }

  it('lists everything when nothing is asked for', () => {
    const { api } = makeRig();
    const all = search(api, {});
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map((i) => i['vnum']), [100, 101, 102], 'by vnum, the catalogue\'s own order');
  });

  it('matches a keyword, which is what a player would type', () => {
    const { api } = makeRig();
    assert.deepEqual(search(api, { q: 'dagger' }).items.map((i) => i['vnum']), [100]);
  });

  it('matches the display name with its colour codes stripped', () => {
    // `&+Ca silver dagger&N` — searching for "silver" against the raw string finds it by luck here,
    // so the test uses a term that only exists *around* a code to prove the stripping.
    const { api } = makeRig();
    assert.deepEqual(search(api, { q: 'a silver' }).items.map((i) => i['vnum']), [100]);
  });

  it('matches an exact vnum, because a reset table names items by number and nothing else', () => {
    const { api } = makeRig();
    assert.deepEqual(search(api, { q: '101' }).items.map((i) => i['vnum']), [101]);
  });

  it('filters by kind, including the two-handed weapons wield exists for', () => {
    const { api } = makeRig();
    assert.equal(search(api, { kind: 'weapon' }).total, 2);
    assert.deepEqual(search(api, { kind: 'twoHanded' }).items.map((i) => i['vnum']), [101]);
    assert.deepEqual(search(api, { kind: 'container' }).items.map((i) => i['vnum']), [102]);
  });

  it('reports the total beside the page, so a too-broad search is visible', () => {
    // The row cap is what keeps 16,421 entries off the wire; without `total` an operator reading the
    // first page has no way to know they are reading part of the answer.
    const { api } = makeRig();
    const page = search(api, { limit: '1' });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1);
  });

  it('answers one item whole, and 404s for one that is not there', () => {
    const { api } = makeRig();
    const one = api.route(req('GET', '/items/101'));
    assert.equal(one.status, 200);
    assert.equal((one.body as { item: { twoHanded?: boolean } }).item.twoHanded, true);
    assert.equal(api.route(req('GET', '/items/9999')).status, 404);
  });

  it('carries the chosen art on the row, and drops the field when there is none — A7c', () => {
    // The recorded loose end: `itemRow` omitted `art`, so the picker's own work was invisible the
    // moment it was saved and the panel could not mark which of 16,421 items have a picture.
    //
    // The id comes from the generated index rather than being typed in, because a hardcoded sheet
    // name would turn a re-stage of the art pack into a failing admin test.
    const { api } = makeRig();
    const sheet = LPC_ART[0]!.id;

    assert.equal('art' in search(api, { q: '100' }).items[0]!, false, 'absent, not null, before anything is chosen');

    const patched = api.route(req('PATCH', '/items/100', { art: sheet }));
    assert.equal(patched.status, 200);
    assert.equal((patched.body as { item: Record<string, unknown> }).item['art'], sheet, 'and on the save response');
    assert.equal(search(api, { q: '100' }).items[0]!['art'], sheet);

    api.route(req('PATCH', '/items/100', { art: null }));
    assert.equal('art' in search(api, { q: '100' }).items[0]!, false, 'cleared back to absent');
  });

  it('refuses art the index does not have, and names it', () => {
    const { api } = makeRig();
    const refused = api.route(req('PATCH', '/items/100', { art: '../../../etc/passwd' }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /no such art/);
  });
});

describe('authoring an item — A6', () => {
  it('refuses behaviour fields by name, with the reason', () => {
    const { api } = makeRig();
    // `slot` crossed to the authorable side on the owner's shroud ruling (2026-08-07); `type` is
    // still behaviour and still says so.
    const refused = api.route(req('PATCH', '/items/100', { type: 9 }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /behaviour/);
    const moved = quietly(() => api.route(req('PATCH', '/items/100', { slot: 'back' })));
    assert.equal(moved.status, 200);
    assert.equal((moved.body as { item: { slot?: string } }).item.slot, 'back');
    // And a weapon's class is authorable since Windsong punched: the verb, skill and animation in one.
    const classed = quietly(() => api.route(req('PATCH', '/items/100', { weaponClass: 5 })));
    assert.equal(classed.status, 200);
    assert.equal((classed.body as { item: { weaponClass?: number } }).item.weaponClass, 5);
  });

  it('lands an edit on the live catalogue and marks the row edited', () => {
    const { api } = makeRig();
    const patched = api.route(req('PATCH', '/items/100', { name: '&+Ra crimson dagger&N', cost: 90 }));
    assert.equal(patched.status, 200);

    const rows = (api.route({ ...req('GET', '/items'), query: { q: 'dagger' } }).body as { items: Record<string, unknown>[] }).items;
    assert.equal(rows[0]!['name'], '&+Ra crimson dagger&N');
    assert.equal(rows[0]!['edited'], true, 'the ✎ mark');
    assert.equal(rows[0]!['cost'], 90);

    const one = api.route(req('GET', '/items/100')).body as { item: ItemTemplate; authored: unknown };
    assert.equal(one.item.name, '&+Ra crimson dagger&N');
    assert.ok(one.authored, 'the editor is told which fields are authored');
  });

  it('clears a field back to the harvest, and a full revert drops the mark', () => {
    // The pristine copy is what makes this a revert rather than "whatever the last edit left".
    const { api } = makeRig();
    api.route(req('PATCH', '/items/100', { name: 'renamed', cost: 90 }));
    const half = api.route(req('PATCH', '/items/100', { name: null }));
    assert.equal(half.status, 200);
    const halved = (half.body as { item: { name: string; cost: number } }).item;
    assert.equal(halved.name, '&+Ca silver dagger&N', 'the harvest is back');
    assert.equal(halved.cost, 90, 'the other authored field survives');

    const full = api.route(req('PATCH', '/items/100', { cost: null }));
    assert.equal((full.body as { authored: unknown }).authored, null, 'nothing authored, no entry');
    const rows = (api.route({ ...req('GET', '/items'), query: { q: 'dagger' } }).body as { items: Record<string, unknown>[] }).items;
    assert.equal(rows[0]!['edited'], undefined, 'and the mark is gone');
  });

  it('validates whole-or-nothing, so a half-bad patch changes nothing', () => {
    const { api } = makeRig();
    const bad = api.route(req('PATCH', '/items/100', { name: 'fine', damage: { count: 0, sides: 6 } }));
    assert.equal(bad.status, 400);
    const rows = (api.route({ ...req('GET', '/items'), query: { q: 'dagger' } }).body as { items: Record<string, unknown>[] }).items;
    assert.equal(rows[0]!['name'], '&+Ca silver dagger&N', 'the good half did not land either');
  });

  it('persists to the overlay file, in the shape the loader reads back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-itemfile-'));
    const file = join(dir, 'items.json');
    const { api } = makeRig({ itemOverridesFile: file });
    quietly(() => api.route(req('PATCH', '/items/101', { damage: { count: 3, sides: 10, bonus: 2 } })));
    const back = loadItemOverrides(file);
    assert.deepEqual(back.get(101)?.damage, { count: 3, sides: 10, bonus: 2 });
  });

  it('404s an unknown vnum before validating anything', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PATCH', '/items/9999', { name: 'x' })).status, 404);
  });
});

describe('creating an item — A6b', () => {
  /** The smallest legal creation. Everything below is this plus one change. */
  const draft = {
    name: '&+ya brass lantern&N',
    keywords: ['lantern', 'brass'],
    type: DURIS_ITEM.light,
    size: 2,
    cost: 40,
  };

  it('allocates the vnum from the reserved range and puts the item in the catalogue', () => {
    const { api } = makeRig();
    const made = quietly(() => api.route(req('POST', '/items', draft)));
    assert.equal(made.status, 201);
    const { vnum } = made.body as { vnum: number };
    assert.equal(vnum, AUTHORED_VNUM_BASE, 'the first created item starts the range');

    // From here it is an item like any other: findable by the words a player would type.
    const rows = (api.route({ ...req('GET', '/items'), query: { q: 'lantern' } }).body as {
      items: Record<string, unknown>[];
    }).items;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!['vnum'], vnum);
    assert.equal(rows[0]!['created'], true, 'the created mark');
    assert.equal(rows[0]!['edited'], undefined, 'and NOT the edited mark — they mean different things');
  });

  it('refuses a caller-chosen vnum, which is the whole collision argument', () => {
    const { api } = makeRig();
    const refused = api.route(req('POST', '/items', { ...draft, vnum: 100 }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /allocated by the server/);
  });

  it('refuses an incomplete draft rather than filling in a name', () => {
    const { api } = makeRig();
    const refused = api.route(req('POST', '/items', { keywords: ['thing'], type: DURIS_ITEM.treasure }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /name/);
  });

  it('hands out a fresh number each time', () => {
    const { api } = makeRig();
    const first = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };
    const second = quietly(() => api.route(req('POST', '/items', { ...draft, name: 'a second lantern' })))
      .body as { vnum: number };
    assert.notEqual(first.vnum, second.vnum);
    assert.equal(second.vnum, first.vnum + 1);
  });

  it('edits a created item through the same PATCH, and re-drafts rather than patching', () => {
    const { api } = makeRig();
    const { vnum } = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };

    // `slot` is refused on a harvested item because the source's bits decide it. On a created one there
    // is no source to disagree with, so it is simply a field.
    const edited = quietly(() => api.route(req('PATCH', `/items/${vnum}`, { slot: 'head', cost: 75 })));
    assert.equal(edited.status, 200);
    const one = api.route(req('GET', `/items/${vnum}`)).body as {
      item: ItemTemplate;
      created: unknown;
    };
    assert.equal(one.item.slot, 'head');
    assert.equal(one.item.cost, 75);
    assert.equal(one.item.name, '&+ya brass lantern&N', 'an unmentioned field is untouched');
    assert.ok(one.created, 'the editor is told there is no harvest to restore');
  });

  it('deletes a created item', () => {
    const { api } = makeRig();
    const { vnum } = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };
    assert.equal(quietly(() => api.route(req('DELETE', `/items/${vnum}`))).status, 200);
    assert.equal(api.route(req('GET', `/items/${vnum}`)).status, 404);
  });

  it('refuses to delete a harvested item, and says why', () => {
    // A delete that appeared to work would be a lie with a restart's fuse on it.
    const { api } = makeRig();
    const refused = api.route(req('DELETE', '/items/100'));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /worldgen would/);
    assert.equal(api.route(req('GET', '/items/100')).status, 200, 'and it is still there');
  });

  it('never reuses a deleted number', () => {
    const { api } = makeRig();
    const { vnum } = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };
    quietly(() => api.route(req('DELETE', `/items/${vnum}`)));
    const next = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };
    assert.equal(next.vnum, vnum + 1, 'a recycled identity would point old saves at a new item');
  });

  it('gives a created item to a live character, which is how it is checked at all', () => {
    const { api, players, calls } = makeRig();
    players.push(fakePlayer('Ravi'));
    const { vnum } = quietly(() => api.route(req('POST', '/items', draft))).body as { vnum: number };
    const given = quietly(() => api.route(req('POST', '/players/ravi/give', { vnum })));
    assert.equal(given.status, 200);
    assert.equal((given.body as { name: string }).name, '&+ya brass lantern&N');
    assert.ok(calls.some((c) => c === `give Ravi ${vnum}`));
  });

  it('refuses a give to somebody offline — an instance needs a live bag', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('POST', '/players/ravi/give', { vnum: 100 })).status, 409);
  });

  it('refuses a give of an item the catalogue does not have', () => {
    const { api, players } = makeRig();
    players.push(fakePlayer('Ravi'));
    assert.equal(api.route(req('POST', '/players/ravi/give', { vnum: 424242 })).status, 404);
  });
});

describe('zones and mobs, live — A4', () => {
  it('forces a repop and reports what it did', () => {
    const { api } = makeRig();
    const done = api.route(req('POST', '/zones/600/repop'));
    assert.equal(done.status, 200);
    assert.deepEqual(done.body, { ok: true, zone: 600, spawned: 2, doors: 1, objects: 3, atLimit: 1 });

    // A zone the world *has* but that carries no population file will never repop, and that is a
    // **refusal with a reason** rather than a cheerful zero: "0 mobs appeared" reads as a broken
    // button rather than as a fact about the zone. A different answer again from a zone that does
    // not exist, which is the test below.
    const empty = makeRig({ noPopulation: true }).api.route(req('POST', '/zones/600/repop'));
    assert.equal(empty.status, 409);
    assert.match(String((empty.body as { error: string }).error), /geometry only/);
  });

  it('404s a zone this server never loaded, before it asks the world to repop it', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('POST', '/zones/999/repop')).status, 404);
  });

  it('lists live instances rather than templates, with an entity id on every row', () => {
    // The distinction the whole section rests on: the Zones browser says what a zone is *authored* to
    // contain, this says what is standing in it. Two kobold guards of one vnum, one of them wounded —
    // and only the id can tell them apart, which is protocol 11's argument all over again.
    const { api } = makeRig();
    const body = api.route(req('GET', '/zones/600/mobs')).body as { total: number; mobs: { id: number; vnum: number; hp: number }[] };
    assert.equal(body.total, 2);
    assert.deepEqual(body.mobs.map((m) => m.id), [700, 701]);
    assert.equal(new Set(body.mobs.map((m) => m.vnum)).size, 1, 'same vnum');
    assert.notEqual(body.mobs[0]!.hp, body.mobs[1]!.hp, 'different bodies');
  });

  it('slays one instance by id and stops finding it', () => {
    const { api } = makeRig();
    const slain = api.route(req('DELETE', '/mobs/700'));
    assert.equal(slain.status, 200);
    assert.equal((slain.body as { name: string }).name, 'a kobold guard');

    const left = api.route(req('GET', '/zones/600/mobs')).body as { mobs: { id: number }[] };
    assert.deepEqual(left.mobs.map((m) => m.id), [701], 'and it took the right twin');

    // Gone rather than refused: an id that named a mob a second ago and does not now is a thing that
    // died, and the panel's list is simply stale.
    assert.equal(api.route(req('DELETE', '/mobs/700')).status, 404);
  });

  it('spawns from a harvested template and refuses a vnum with no record', () => {
    const { api } = makeRig();
    const made = api.route(req('POST', '/mobs', { vnum: 61, room: 6001 }));
    assert.equal(made.status, 201);
    assert.equal((made.body as { id: number }).id, 999);

    const refused = api.route(req('POST', '/mobs', { vnum: 4242, room: 6001 }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /no mob 4242/);
  });

  it('refuses a spawn into a room the world does not have, before it reaches the simulation', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('POST', '/mobs', { vnum: 61, room: 99999 })).status, 404);
    assert.equal(api.route(req('POST', '/mobs', { vnum: 61 })).status, 400, 'and a spawn with no room at all');
  });

  it('searches templates on keyword, vnum and the name with colour stripped', () => {
    const { api } = makeRig();
    const search = (q: string): number[] =>
      (api.route({ ...req('GET', '/mobs'), query: { q } }).body as { mobs: { vnum: number }[] }).mobs.map((m) => m.vnum);
    assert.deepEqual(search('guard'), [61], 'authored keyword');
    assert.deepEqual(search('62'), [62], 'exact vnum');
    // `&+ya kobold shaman&N` — matched with the codes stripped, or a builder's colour hides the mob.
    assert.deepEqual(search('a kobold shaman'), [62]);
    assert.deepEqual(search('kobold'), [61, 62]);
  });

  it('works a door, and refuses a change that changes nothing', () => {
    const { api } = makeRig();
    const opened = api.route(req('POST', '/rooms/6001/door', { dir: 'north', closed: false }));
    assert.equal(opened.status, 200);
    assert.deepEqual((opened.body as { door: unknown }).door, { name: 'a rusted gate', closed: false, locked: false });

    // Independent flags, because they are independent in the world: LOCKS_HOLD is off, so a locked
    // door still opens, and testing the day it goes on needs them settable apart.
    const locked = api.route(req('POST', '/rooms/6001/door', { locked: true, dir: 'north' }));
    assert.deepEqual((locked.body as { door: { closed: boolean; locked: boolean } }).door, { name: 'a rusted gate', closed: false, locked: true });

    // A request that changes nothing and reports success is indistinguishable from one that failed.
    assert.equal(api.route(req('POST', '/rooms/6001/door', { dir: 'north' })).status, 400);
    assert.equal(api.route(req('POST', '/rooms/6001/door', { dir: 'sideways', closed: true })).status, 400);
    assert.equal(api.route(req('POST', '/rooms/6001/door', { dir: 'south', closed: true })).status, 404, 'no door that way');
  });

  it('audits every one of them, because they all change the world', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-audit-'));
    const auditFile = join(dir, 'audit.jsonl');
    const { api } = makeRig({ auditFile });
    api.route(req('POST', '/mobs', { vnum: 61, room: 6001 }));
    api.route(req('DELETE', '/mobs/701'));
    api.route(req('POST', '/rooms/6001/door', { dir: 'north', closed: true }));

    const actions = readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { action: string }).action);
    assert.deepEqual(actions, ['mob.spawn', 'mob.slay', 'door.work']);
  });
});

/**
 * A8 — building a room in a gap the source left.
 *
 * The fixture is the shape the whole slice exists for: three rooms in a row with the middle cell
 * empty, so a room put there fills a hole inside an extent that already reaches past it. Widening
 * the grid is what shifts every saved `seen` index, and this cannot do it.
 */
describe('creating a room', () => {
  /** Rooms at (0,0) and (2,0), a gap at (1,0), and 6001's east exit deliberately unspoken for. */
  function gappyZone(): Zone {
    const rooms: Room[] = [
      { id: 6001, zone: 600, name: 'A Mossy Hollow', sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: {} },
      { id: 6003, zone: 600, name: 'A Far Bank', sector: 'forest', pos: { x: 2, y: 0, z: 0 }, exits: {} },
    ];
    return { id: 600, name: 'Test Hollow', rooms, bounds: boundsOf(rooms), entryRoom: 6001 };
  }

  const good = { name: 'A Hidden Dell', sector: 'cave', x: 1, y: 0, level: 0, exits: ['west', 'east'] };

  it('fills the gap, joins both neighbours, and hands back an id of its own', () => {
    const { api } = makeRig({ zone: gappyZone() });
    const response = api.route(req('POST', '/zones/600/rooms', good));
    assert.equal(response.status, 200);

    const { room } = response.body as { room: { id: number; name: string; exits: { dir: string; to: number }[] } };
    assert.ok(room.id >= AUTHORED_ROOM_BASE, `${room.id} is ours, not the harvest's`);
    assert.equal(room.name, 'A Hidden Dell');
    assert.deepEqual(
      [...room.exits].sort((a, b) => a.dir.localeCompare(b.dir)),
      [{ dir: 'east', to: 6003 }, { dir: 'west', to: 6001 }],
    );
  });

  it('writes the far side too, so the room can be walked out of as well as into', () => {
    const { api } = makeRig({ zone: gappyZone() });
    const created = api.route(req('POST', '/zones/600/rooms', good));
    const id = (created.body as { room: { id: number } }).room.id;

    const back = api.route(req('GET', '/rooms/6001')).body as { exits: { dir: string; to: number }[] };
    assert.deepEqual(back.exits.find((e) => e.dir === 'east')?.to, id);
  });

  it("refuses the world's objections with 409 and the request's own faults with 400", () => {
    const { api } = makeRig({ zone: gappyZone() });

    // A cell somebody already has.
    const taken = api.route(req('POST', '/zones/600/rooms', { ...good, x: 0, exits: ['east'] }));
    assert.equal(taken.status, 409);
    assert.match((taken.body as { error: string }).error, /already holds room 6001/);

    // A direction with nothing beside it.
    const nowhere = api.route(req('POST', '/zones/600/rooms', { ...good, exits: ['north'] }));
    assert.equal(nowhere.status, 409);

    // Malformed drafts are the request's fault, not the world's.
    assert.equal(api.route(req('POST', '/zones/600/rooms', { ...good, sector: 'forrest' })).status, 400);
    assert.equal(api.route(req('POST', '/zones/600/rooms', { ...good, exits: [] })).status, 400);
    assert.equal(api.route(req('POST', '/zones/999/rooms', good)).status, 404);
  });

  it('spends no id on a refused draft', () => {
    const { api } = makeRig({ zone: gappyZone() });
    api.route(req('POST', '/zones/600/rooms', { ...good, x: 0, exits: ['east'] }));
    const created = api.route(req('POST', '/zones/600/rooms', good));
    assert.equal((created.body as { room: { id: number } }).room.id, AUTHORED_ROOM_BASE);
  });

  it('builds against the edge, and clears the Place when it does — slice 3', () => {
    const { api, calls } = makeRig({ zone: gappyZone(), occupants: { players: [], mobs: [], corpses: [] } });
    // (3,0) is one cell beyond the level's 0..2, and reachable because 6003 sits at (2,0). That is
    // the only kind of outside-the-extent cell there is: a room must be joined to a neighbour, so it
    // can never be more than one cell past the edge.
    const wide = api.route(req('POST', '/zones/600/rooms', { ...good, x: 3, exits: ['west'] }));
    assert.equal(wide.status, 200);
    assert.equal((wide.body as { extentChanged: boolean }).extentChanged, true);
    assert.ok(calls.includes('forgetPlace 600:0'));
  });

  it('does not clear anything for a room that fits in the gap', () => {
    const { api, calls } = makeRig({ zone: gappyZone() });
    const inside = api.route(req('POST', '/zones/600/rooms', good));
    assert.equal((inside.body as { extentChanged: boolean }).extentChanged, false);
    assert.equal(calls.filter((c) => c.startsWith('forgetPlace')).length, 0);
  });

  it('sends an edit to the created room back to its own record, never to rooms.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a8-'));
    const overridesFile = join(dir, 'rooms.json');
    const authoredRoomsFile = join(dir, 'rooms-authored.json');
    const { api } = makeRig({ zone: gappyZone(), overridesFile, authoredRoomsFile });

    const id = (api.route(req('POST', '/zones/600/rooms', good)).body as { room: { id: number } }).room.id;
    assert.equal(api.route(req('PATCH', `/rooms/${id}`, { description: 'Ferns crowd the walls.' })).status, 200);

    const authored = JSON.parse(readFileSync(authoredRoomsFile, 'utf8')) as { rooms: Record<string, { description: string }> };
    assert.equal(authored.rooms[String(id)]?.description, 'Ferns crowd the walls.');
    // A6b's rule, in its second home: two overlays claiming one room is a state where the answer
    // depends on load order. `rooms.json` is never even created — the harvested path is the only
    // writer of it, and this edit never went down that path.
    assert.equal(existsSync(overridesFile), false);
  });

  it('refuses to unauthor a field of a created room — there is nothing underneath to restore', () => {
    const { api } = makeRig({ zone: gappyZone() });
    const id = (api.route(req('POST', '/zones/600/rooms', good)).body as { room: { id: number } }).room.id;

    const cleared = api.route(req('PATCH', `/rooms/${id}`, { description: null }));
    assert.equal(cleared.status, 400);
    assert.match((cleared.body as { error: string }).error, /no harvested room underneath/);
  });

  it('survives a reload — which is the completion test', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a8-reload-'));
    const authoredRoomsFile = join(dir, 'rooms-authored.json');
    const { api } = makeRig({ zone: gappyZone(), authoredRoomsFile });
    const id = (api.route(req('POST', '/zones/600/rooms', good)).body as { room: { id: number } }).room.id;

    // A second world built from the same file and a *fresh* zone — which is what `npm run worldgen`
    // produces, and the thing an overlay has to survive.
    const reloaded = new GameWorld([gappyZone()], { zone: 600, room: null }, [], new Map(), loadAuthoredRooms(authoredRoomsFile));
    const located = reloaded.locate(id);
    assert.ok(located, 'the room came back');
    assert.equal(located.room.name, 'A Hidden Dell');
    assert.equal(located.room.exits.west?.to, 6001);
    assert.equal(reloaded.zone(600)!.rooms.find((r) => r.id === 6001)!.exits.east?.to, id, 'and so did the far side');
    assert.deepEqual(reloaded.authoredRefusals, []);
  });

  it('audits the build', () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'mygame-a8-audit-'));
    const auditFile = join(auditDir, 'audit.jsonl');
    const { api } = makeRig({ zone: gappyZone(), auditFile });
    api.route(req('POST', '/zones/600/rooms', good));

    const line = JSON.parse(readFileSync(auditFile, 'utf8').trim()) as { action: string; exits: string[] };
    assert.equal(line.action, 'room.create');
    assert.deepEqual([...line.exits].sort(), ['east', 'west']);
  });
});

/**
 * A8 slice 2 — taking a room out.
 *
 * The fixture is a 2x2 block, because deletion needs a room that holds no bound *alone* to be legal
 * at all: anything the extent rests on would narrow the grid, and a narrower grid shifts every saved
 * tile index exactly as a wider one does. In a 2x2 every room sits on the extent and every bound is
 * shared, which is precisely the case that must be allowed.
 */
describe('deleting a room', () => {
  function blockZone(): Zone {
    const rooms: Room[] = [
      { id: 6001, zone: 600, name: 'A Mossy Hollow', sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 6002 }, south: { to: 6003 } } },
      { id: 6002, zone: 600, name: 'A Fallen Log', sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 6001 }, south: { to: 6004 } } },
      { id: 6003, zone: 600, name: 'A Hollow Stump', sector: 'forest', pos: { x: 0, y: 1, z: 0 }, exits: { north: { to: 6001 }, east: { to: 6004 } } },
      { id: 6004, zone: 600, name: 'A Bramble Thicket', sector: 'forest', pos: { x: 1, y: 1, z: 0 }, exits: { west: { to: 6003 }, north: { to: 6002 } } },
    ];
    return { id: 600, name: 'Test Hollow', rooms, bounds: boundsOf(rooms), entryRoom: 6001 };
  }

  /** A straight line, so the end room is the only thing holding its bound and cannot go. */
  function spurZone(): Zone {
    const rooms: Room[] = [
      { id: 6001, zone: 600, name: 'A Mossy Hollow', sector: 'forest', pos: { x: 0, y: 0, z: 0 }, exits: { east: { to: 6002 } } },
      { id: 6002, zone: 600, name: 'A Fallen Log', sector: 'forest', pos: { x: 1, y: 0, z: 0 }, exits: { west: { to: 6001 }, east: { to: 6003 } } },
      { id: 6003, zone: 600, name: 'A Far Bank', sector: 'forest', pos: { x: 2, y: 0, z: 0 }, exits: { west: { to: 6002 } } },
    ];
    return { id: 600, name: 'Test Hollow', rooms, bounds: boundsOf(rooms), entryRoom: 6001 };
  }

  const empty = { players: [], mobs: [], corpses: [] };

  it('clears the Place when the room it removes was holding the extent — slice 3', () => {
    const { api, calls } = makeRig({ zone: spurZone(), occupants: empty });
    const response = api.route(req('DELETE', '/rooms/6003'));
    assert.equal(response.status, 200);
    assert.equal((response.body as { extentChanged: boolean }).extentChanged, true);
    // The maps for this Place are wrong rather than merely incomplete, so they go — and the players
    // on it are told, which is what `forgetPlace` does.
    assert.ok(calls.includes('forgetPlace 600:0'));
  });

  it('leaves the maps alone when the extent does not move', () => {
    const { api, calls } = makeRig({ zone: blockZone(), occupants: empty });
    const response = api.route(req('DELETE', '/rooms/6002'));
    assert.equal((response.body as { extentChanged: boolean }).extentChanged, false);
    assert.equal(calls.filter((c) => c.startsWith('forgetPlace')).length, 0);
  });

  it('refuses the spawn room, whoever asks', () => {
    const { api } = makeRig({ zone: blockZone(), occupants: empty });
    const response = api.route(req('DELETE', '/rooms/6001'));
    assert.equal(response.status, 409);
    assert.match((response.body as { error: string }).error, /where new characters arrive/);
  });

  it('refuses a room somebody is standing in, and names them', () => {
    const { api } = makeRig({ zone: blockZone(), occupants: { players: ['Ravi'], mobs: [], corpses: [] } });
    const response = api.route(req('DELETE', '/rooms/6002'));
    assert.equal(response.status, 409);
    assert.match((response.body as { error: string }).error, /Ravi is standing in room 6002/);
  });

  it('reports the exits it orphaned rather than rewriting the neighbours', () => {
    const { api } = makeRig({ zone: blockZone(), occupants: empty });
    const response = api.route(req('DELETE', '/rooms/6002'));
    assert.equal(response.status, 200);

    const body = response.body as { orphans: { from: number; dir: string }[] };
    assert.deepEqual(
      [...body.orphans].sort((a, b) => a.from - b.from),
      [
        { from: 6001, dir: 'east' },
        { from: 6004, dir: 'north' },
      ],
    );
    // Decision 3: tolerated, not repaired. 6001 still points east at a room that is gone, exactly as
    // the 5 dangling exits the shipped world already has do.
    const still = api.route(req('GET', '/rooms/6001')).body as { exits: { dir: string; to: number }[] };
    assert.equal(still.exits.find((e) => e.dir === 'east')?.to, 6002);
  });

  it('reports the reset commands it orphaned — the only moment anybody is told', () => {
    const { api } = makeRig({ zone: blockZone(), occupants: empty, resets: { mob: 3, equip: 5, door: 1 } });
    const body = api.route(req('DELETE', '/rooms/6002')).body as {
      resets: Record<string, number>;
      orphanedResets: number;
    };
    assert.deepEqual(body.resets, { mob: 3, equip: 5, door: 1 });
    assert.equal(body.orphanedResets, 9);
  });

  it('empties the room only once the world has accepted the delete', () => {
    // Refused because somebody is standing in it — the room survives, so nothing may be despawned.
    const refused = makeRig({ zone: blockZone(), occupants: { players: ['Ravi'], mobs: [], corpses: [] } });
    refused.api.route(req('DELETE', '/rooms/6002'));
    assert.equal(
      refused.calls.filter((c) => c.startsWith('clearRoom')).length,
      0,
      'nothing was despawned for a delete that did not happen',
    );

    const done = makeRig({ zone: blockZone(), occupants: empty });
    done.api.route(req('DELETE', '/rooms/6002'));
    assert.ok(done.calls.includes('clearRoom 6002'));
    assert.ok(done.calls.includes('publishRoom 6002 regrid=true'), 'the floor has to stop being floor');
  });

  it('writes a tombstone for a harvested room, and it holds across a reload', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a8-del-'));
    const authoredRoomsFile = join(dir, 'rooms-authored.json');
    const { api } = makeRig({ zone: blockZone(), occupants: empty, authoredRoomsFile });
    assert.equal(api.route(req('DELETE', '/rooms/6002')).status, 200);

    const store = loadAuthoredRooms(authoredRoomsFile);
    assert.deepEqual([...store.deleted], [6002]);
    // A fresh zone off disk — what `npm run worldgen` produces — with the overlay on top.
    const reloaded = new GameWorld([blockZone()], { zone: 600, room: null }, [], new Map(), store);
    assert.equal(reloaded.locate(6002), undefined, 'it stayed deleted');
    assert.deepEqual(reloaded.authoredRefusals, []);
  });

  it('deletes a created room by removing its record, and unwires what it wired', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a8-delc-'));
    const authoredRoomsFile = join(dir, 'rooms-authored.json');
    const { api } = makeRig({ zone: blockZone(), occupants: empty, authoredRoomsFile });

    // Clear a cell, then build back into the hole it left — the only way to get a created room into
    // a zone with no gaps, and a fair exercise of the two halves against each other.
    api.route(req('DELETE', '/rooms/6002'));
    const rebuilt = api.route(
      req('POST', '/zones/600/rooms', { name: 'A Sink Hole', sector: 'cave', x: 1, y: 0, level: 0, exits: ['south'] }),
    );
    assert.equal(rebuilt.status, 200);
    const id = (rebuilt.body as { room: { id: number } }).room.id;
    const wired = api.route(req('GET', '/rooms/6004')).body as { exits: { dir: string; to: number }[] };
    assert.equal(wired.exits.find((e) => e.dir === 'north')?.to, id, 'we wrote that link');

    // Now remove the created room. The reverse exit goes with it: that link exists only because of
    // our record, so leaving it would be inventing a dangling exit rather than tolerating one.
    assert.equal(api.route(req('DELETE', `/rooms/${id}`)).status, 200);
    const back = api.route(req('GET', '/rooms/6004')).body as { exits: { dir: string; to: number }[] };
    assert.equal(back.exits.find((e) => e.dir === 'north'), undefined, 'and it came out with it');

    const store = loadAuthoredRooms(authoredRoomsFile);
    assert.equal(store.rooms.size, 0, 'the record is the room');
    assert.deepEqual([...store.deleted], [6002], 'and no tombstone for something we made');
    assert.equal(store.next, AUTHORED_ROOM_BASE + 1, 'but the id it used is never handed out again');
  });

  it('audits the removal with what it orphaned', () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'mygame-a8-del-audit-'));
    const auditFile = join(auditDir, 'audit.jsonl');
    const { api } = makeRig({ zone: blockZone(), occupants: empty, auditFile, resets: { mob: 2 } });
    api.route(req('DELETE', '/rooms/6002'));

    const line = JSON.parse(readFileSync(auditFile, 'utf8').trim()) as {
      action: string;
      orphanedExits: number;
      orphanedResets: number;
    };
    assert.equal(line.action, 'room.delete');
    assert.equal(line.orphanedExits, 2);
    assert.equal(line.orphanedResets, 2);
  });
});

/**
 * A9 — editing what a mob **is**.
 *
 * Owner's ask, 2026-08-06: *"we need to be able to edit existing mobs."* The router's half is the same
 * shape `authorItem` has, and the tests pin the three places a mob differs from an item: a level that
 * drags derived numbers with it, a route that must not collide with the entity-id one already at
 * `/mobs/:id`, and a Restore that has to leave the loot standing.
 */
describe('editing a mob template', () => {
  it('reads the whole record, what is authored on it, and how many are standing', () => {
    const { api } = makeRig();
    const response = api.route(req('GET', '/mobs/61/template'));
    assert.equal(response.status, 200);
    const body = response.body as { mob: Record<string, unknown>; authored: unknown; spawned: number };
    assert.equal(body.mob.name, 'a kobold guard');
    assert.equal(body.mob.level, 8);
    // Damage comes back as notation rather than as a record, because that is what goes in the box and
    // what the next save posts back — and `writeDice` keeps the bonus, which a `${count}d${sides}` would
    // silently drop the first time somebody opened the editor and pressed Save.
    assert.equal(body.mob.damage, '2d6+2');
    assert.equal(body.authored, null);
    assert.equal(body.spawned, 3);
  });

  it('authors a field and leaves the others as the harvest left them', () => {
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/template', { name: 'Gwark, the kobold king' }));
    assert.equal(response.status, 200);
    const body = response.body as { mob: Record<string, unknown>; spawned: number };
    assert.equal(body.mob.name, 'Gwark, the kobold king');
    assert.equal(body.mob.level, 8, 'untouched');
    // Same number the loot route reports, for the same reason: an edit is per template.
    assert.equal(body.spawned, 3);
  });

  it('moves the derived combat numbers with an authored level', () => {
    const { api } = makeRig();
    const before = (api.route(req('GET', '/mobs/61/template')).body as { mob: { level: number } }).mob;
    assert.equal(before.level, 8);
    api.route(req('PATCH', '/mobs/61/template', { level: 40 }));
    const after = api.route(req('GET', '/mobs/61/template')).body as { mob: { level: number } };
    assert.equal(after.mob.level, 40);
  });

  it('restores the harvest when the authored fields are cleared', () => {
    const { api } = makeRig();
    api.route(req('PATCH', '/mobs/61/template', { name: 'Gwark', level: 40 }));
    const cleared = api.route(req('PATCH', '/mobs/61/template', { name: null, level: null }));
    assert.equal(cleared.status, 200);
    const body = cleared.body as { mob: Record<string, unknown>; authored: unknown };
    assert.equal(body.mob.name, 'a kobold guard');
    assert.equal(body.mob.level, 8);
    // Nothing authored remains, so the entry is gone — which is what takes the mark off the row.
    assert.equal(body.authored, null);
  });

  it('keeps a template\u2019s loot when its fields are restored', () => {
    // The two live in one record and have two buttons. A Restore that quietly emptied a kit would be
    // the worst kind of surprise, so it is asserted rather than left to the reader.
    const { api } = makeRig();
    api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100, slot: 'head' }] }));
    api.route(req('PATCH', '/mobs/61/template', { level: 40 }));
    api.route(req('PATCH', '/mobs/61/template', { level: null }));
    const listed = api.route({ ...req('GET', '/mobs'), query: { q: '61' } }).body as { mobs: { vnum: number; loot?: unknown[] }[] };
    assert.equal(listed.mobs.find((m) => m.vnum === 61)?.loot?.length, 1);
  });

  it('keeps a template\u2019s fields when its loot is emptied', () => {
    // And the other way round, which A4c's replace-the-record write would have got wrong: clearing the
    // kit must not unauthor a name somebody set an hour earlier.
    const { api } = makeRig();
    api.route(req('PATCH', '/mobs/61/template', { name: 'Gwark' }));
    api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100 }] }));
    api.route(req('PATCH', '/mobs/61/loot', { loot: [] }));
    const body = api.route(req('GET', '/mobs/61/template')).body as { mob: { name: string } };
    assert.equal(body.mob.name, 'Gwark');
  });

  it('marks the search row with which fields are authored', () => {
    const { api } = makeRig();
    api.route(req('PATCH', '/mobs/61/template', { level: 40, hp: '40d12+300' }));
    const listed = api.route({ ...req('GET', '/mobs'), query: { q: '61' } }).body as { mobs: { vnum: number; edited?: string[] }[] };
    const row = listed.mobs.find((m) => m.vnum === 61);
    assert.deepEqual([...(row?.edited ?? [])].sort(), ['hp', 'level']);
  });

  it('refuses a number outside the band rather than clamping it', () => {
    // The opposite of what the file loader does with the same number, and deliberately: a form is a
    // person still holding the keyboard, and telling them is worth more than quietly storing 60.
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/template', { level: 900 }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /level must be an integer from 1 to 60/);
  });

  it('refuses dice the game could not roll', () => {
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/template', { hp: 'three d six' }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /dice the game can roll/);
  });

  it('names an unauthorable field rather than ignoring it', () => {
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/template', { aggro: 'aggressive' }));
    assert.equal(response.status, 400);
    const { error } = response.body as { error: string };
    assert.match(error, /"aggro" is not authorable/);
    // And it says why, because "not authorable" on a field the roadmap lists reads as an oversight.
    assert.match(error, /races and alignment/);
  });

  it('refuses a patch that changes nothing', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PATCH', '/mobs/61/template', {})).status, 400);
  });

  it('is a vnum here and an entity id at /mobs/:id, and the two do not collide', () => {
    // `DELETE /mobs/999` kills the body with entity id 999; `PATCH /mobs/61/template` edits the idea of
    // kobold guards. Different id spaces, so different paths — one path whose meaning depends on the
    // verb is what the route note says not to build.
    const { api } = makeRig();
    // 700 is a body standing in the world; 61 is the idea of kobold guards. Each number is meaningless
    // in the other space, and both routes say so rather than answering about the wrong thing.
    assert.equal(api.route(req('GET', '/mobs/700/template')).status, 404, 'no template numbered 700');
    assert.equal(api.route(req('GET', '/mobs/61/template')).status, 200, 'but there is a template 61');
    assert.equal(api.route(req('DELETE', '/mobs/61')).status, 404, 'and no body with entity id 61');
    assert.equal(quietly(() => api.route(req('DELETE', '/mobs/700'))).status, 200, 'while 700 is one');
  });

  it('writes the overlay to disk, fields and all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a9-'));
    const mobOverridesFile = join(dir, 'mobs.json');
    const { api } = makeRig({ mobOverridesFile });
    api.route(req('PATCH', '/mobs/61/template', { level: 40, sprite: 'kobold-king' }));
    const written = JSON.parse(readFileSync(mobOverridesFile, 'utf8')) as Record<string, Record<string, unknown>>;
    assert.equal(written['61']?.level, 40);
    assert.equal(written['61']?.sprite, 'kobold-king');
  });
});

/**
 * A9c — where a creature lives.
 *
 * Owner's ask, 2026-08-06: *"the mob needs to be assigned a room in a zone and not just dropped by hand."*
 * The router's half is validation, and every one of these tests is a way the operator could otherwise end
 * up with a placement that looks saved and never fires.
 */
describe('placing a mob in a room', () => {
  it('assigns rooms and names them back', () => {
    const { api, calls } = makeRig();
    const response = quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001, limit: 3 }] })));
    assert.equal(response.status, 200);
    const body = response.body as { placements: { room: number; limit: number; name: string; zone: number }[] };
    assert.equal(body.placements.length, 1);
    assert.equal(body.placements[0]?.limit, 3);
    // Named on the way out, because a list of bare room ids is one nobody can check their own work in.
    assert.equal(body.placements[0]?.name, 'A Mossy Hollow');
    assert.equal(body.placements[0]?.zone, 600);
    assert.ok(calls.includes('placeMob 61 x1'));
  });

  it('defaults the limit to one, which is what a placement usually means', () => {
    const { api } = makeRig();
    const body = quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001 }] }))).body as {
      placements: { limit: number }[];
    };
    assert.equal(body.placements[0]?.limit, 1);
  });

  it('reads them back, with how many are standing right now', () => {
    const { api } = makeRig();
    quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001, limit: 2 }] })));
    const body = api.route(req('GET', '/mobs/61/placements')).body as { placements: unknown[]; standing: number };
    assert.equal(body.placements.length, 1);
    // The number that makes "I placed it and nothing appeared" answerable: a placement lands on the next
    // repop, not this second.
    assert.equal(body.standing, 3);
  });

  it('unplaces on an empty list, the shape the loot route already uses', () => {
    const { api } = makeRig();
    quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001 }] })));
    quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [] })));
    const body = api.route(req('GET', '/mobs/61/placements')).body as { placements: unknown[] };
    assert.deepEqual(body.placements, []);
  });

  it('refuses a room the world does not have', () => {
    const { api } = makeRig();
    const response = api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 999_999 }] }));
    assert.equal(response.status, 404);
    assert.match((response.body as { error: string }).error, /no room 999999/);
  });

  it('refuses a room in a zone nothing repops, and says why', () => {
    // The failure this exists to prevent: a reset filed in a table no clock runs, which looks saved and
    // never fires — indistinguishable from the feature not working.
    const { api } = makeRig({ noPopulation: true });
    const response = api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001 }] }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /does not populate/);
  });

  it('refuses one room listed twice rather than quietly deduplicating it', () => {
    // Two `M` commands for one room share a *global* cap, so the second could only ever be the one that
    // finds the limit met. Refusing is what stops somebody believing they placed two.
    const { api } = makeRig();
    const response = api.route(req('PUT', '/mobs/61/placements', {
      placements: [{ room: 6001 }, { room: 6001, limit: 2 }],
    }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /listed twice/);
  });

  it('refuses a limit outside the band', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001, limit: 0 }] })).status, 400);
    assert.equal(api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001, limit: 500 }] })).status, 400);
  });

  it('validates the whole list before writing any of it', () => {
    const { api, calls } = makeRig();
    api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001 }, { room: 999_999 }] }));
    assert.equal(calls.filter((c) => c.startsWith('placeMob')).length, 0, 'nothing was written');
  });

  it('refuses a template this server has not loaded', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PUT', '/mobs/999999/placements', { placements: [] })).status, 404);
  });

  it('writes the overlay to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a9c-'));
    const placementsFile = join(dir, 'placements.json');
    const { api } = makeRig({ placementsFile });
    quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001, limit: 4 }] })));
    const back = loadPlacements(placementsFile);
    assert.deepEqual(back.get(61), [{ room: 6001, limit: 4 }]);
  });

  it('audits it, because it changes what the world will spawn', () => {
    const auditDir = mkdtempSync(join(tmpdir(), 'mygame-a9c-audit-'));
    const auditFile = join(auditDir, 'audit.jsonl');
    const { api } = makeRig({ auditFile });
    quietly(() => api.route(req('PUT', '/mobs/61/placements', { placements: [{ room: 6001 }] })));
    const line = JSON.parse(readFileSync(auditFile, 'utf8').trim()) as { action: string; rooms: number[] };
    assert.equal(line.action, 'mob.place');
    assert.deepEqual(line.rooms, [6001]);
  });
});

/**
 * A9b — mobs made here rather than harvested.
 *
 * The tests pin what makes a created mob a different animal from an edited one: it is a whole record with
 * no harvest behind it, it gets a number the caller may not choose, that number is never handed out twice,
 * and it can be deleted where a Duris creature cannot.
 */
describe('making a mob', () => {
  const HOUND = {
    name: 'a bone hound',
    keywords: ['bone', 'hound'],
    level: 12,
    hp: '12d8+30',
    damage: '2d6+3',
    armourClass: 14,
    experience: 2400,
  };

  it('makes one, numbers it from the reserved base and returns the whole record', () => {
    const { api } = makeRig();
    const response = quietly(() => api.route(req('POST', '/mobs/template', HOUND)));
    assert.equal(response.status, 201);
    const body = response.body as { vnum: number; mob: Record<string, unknown> };
    assert.equal(body.vnum, AUTHORED_MOB_BASE);
    assert.equal(body.mob.name, 'a bone hound');
    assert.equal(body.mob.level, 12);
    // Derived rather than posted — a form has no business naming a round length.
    assert.equal(body.mob.damage, '2d6+3');
  });

  it('refuses a vnum the caller chose, because it is the join key', () => {
    const { api } = makeRig();
    const response = api.route(req('POST', '/mobs/template', { ...HOUND, vnum: 1410 }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /allocated by the server/);
  });

  it('never hands the same number out twice, even after a delete', () => {
    // The reason the counter is stored rather than derived: "highest plus one" recycles the number of
    // whatever was deleted last, and a vnum is an identity.
    const { api } = makeRig();
    const first = (quietly(() => api.route(req('POST', '/mobs/template', HOUND))).body as { vnum: number }).vnum;
    quietly(() => api.route(req('DELETE', `/mobs/${first}/template`)));
    const second = (quietly(() => api.route(req('POST', '/mobs/template', HOUND))).body as { vnum: number }).vnum;
    assert.equal(second, first + 1, 'the freed number is gone for good');
  });

  it('says what is wrong rather than merely refusing', () => {
    const { api } = makeRig();
    const noName = api.route(req('POST', '/mobs/template', { ...HOUND, name: '' }));
    assert.match((noName.body as { error: string }).error, /name is required/);
    const badDice = api.route(req('POST', '/mobs/template', { ...HOUND, hp: 'lots' }));
    assert.match((badDice.body as { error: string }).error, /dice the game can roll/);
    const noWords = api.route(req('POST', '/mobs/template', { ...HOUND, keywords: [] }));
    assert.match((noWords.body as { error: string }).error, /at least one keyword/);
  });

  it('writes a disposition and its clause together, or neither', () => {
    // A9 refused to author aggression because a disposition with no clause marks a mob hostile that never
    // attacks. One boolean cannot express that state, which is what makes it safe to offer.
    const { api } = makeRig();
    const made = quietly(() => api.route(req('POST', '/mobs/template', { ...HOUND, aggressive: true })));
    const vnum = (made.body as { vnum: number }).vnum;
    const read = api.route(req('GET', `/mobs/${vnum}/template`)).body as { mob: { aggressive: boolean } };
    assert.equal(read.mob.aggressive, true);
  });

  it('edits one as a re-draft, taking the fields an override refuses', () => {
    const { api } = makeRig();
    const vnum = (quietly(() => api.route(req('POST', '/mobs/template', HOUND))).body as { vnum: number }).vnum;
    // `aggressive` is not authorable on a harvested mob and is here, because there is no harvest to
    // disagree with. The panel does not choose the path; the vnum range does.
    const edited = quietly(() => api.route(req('PATCH', `/mobs/${vnum}/template`, { aggressive: true, level: 20 })));
    assert.equal(edited.status, 200);
    const body = edited.body as { mob: { level: number; aggressive: boolean }; created: boolean };
    assert.equal(body.created, true);
    assert.equal(body.mob.level, 20);
    assert.equal(body.mob.aggressive, true);
    // And the fields it did not mention are still what they were — a re-draft, not a replacement.
    const read = api.route(req('GET', `/mobs/${vnum}/template`)).body as { mob: { name: string; hp: string } };
    assert.equal(read.mob.name, 'a bone hound');
    assert.equal(read.mob.hp, '12d8+30');
  });

  it('marks the search row as made here rather than edited', () => {
    const { api } = makeRig();
    quietly(() => api.route(req('POST', '/mobs/template', HOUND)));
    const listed = api.route({ ...req('GET', '/mobs'), query: { q: 'hound' } }).body as {
      mobs: { vnum: number; created?: boolean; edited?: string[] }[];
    };
    const row = listed.mobs.find((m) => m.vnum === AUTHORED_MOB_BASE);
    assert.equal(row?.created, true);
    assert.equal(row?.edited, undefined, 'made here is not the same fact as edited');
  });

  it('refuses to delete a harvested mob, and says why', () => {
    const { api } = makeRig();
    const response = api.route(req('DELETE', '/mobs/61/template'));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /the next worldgen would restore it/);
  });

  it('deletes one made here, and says how many are still standing', () => {
    const { api } = makeRig();
    const vnum = (quietly(() => api.route(req('POST', '/mobs/template', HOUND))).body as { vnum: number }).vnum;
    const gone = quietly(() => api.route(req('DELETE', `/mobs/${vnum}/template`)));
    assert.equal(gone.status, 200);
    // Instances outlive the idea of them: they are ordinary actors in ordinary fights, and unmaking one
    // mid-round would be a mob vanishing out of a swing.
    assert.equal((gone.body as { standing: number }).standing, 2);
    assert.equal(api.route(req('GET', `/mobs/${vnum}/template`)).status, 404);
  });

  it('writes the overlay to disk with its counter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a9b-'));
    const authoredMobsFile = join(dir, 'mobs-authored.json');
    const { api } = makeRig({ authoredMobsFile });
    quietly(() => api.route(req('POST', '/mobs/template', HOUND)));
    const written = JSON.parse(readFileSync(authoredMobsFile, 'utf8')) as {
      next: number;
      mobs: Record<string, { name: string; level: number }>;
    };
    assert.equal(written.next, AUTHORED_MOB_BASE + 1);
    assert.equal(written.mobs[String(AUTHORED_MOB_BASE)]?.name, 'a bone hound');
  });
});

/**
 * A7q — the quest editor.
 *
 * The giver is mob **61**, which the rig has two of standing in zone 600, because half of what these
 * tests are about is what happens to those two bodies: the `?` over their heads and the immunity behind
 * it are seeded from these rows, and a write that did not re-seed them would leave a badge on a mob
 * anybody may kill. `resynced` is the count that says the bodies were re-sent.
 */
describe('authoring a quest — A7q', () => {
  const CULL = {
    id: 'cull-the-shamans',
    giver: 61,
    name: 'Cull the shamans',
    ask: 'The shamans have grown loud. Silence two of them.',
    thanks: 'Quiet at last.',
    objective: { kind: 'kill', vnum: 62, count: 2, what: 'kobold shamans' },
    reward: { xp: 500, copper: 50 },
  };

  it('creates one, and re-seeds the giver registry in the same breath', () => {
    const { api, questGivers } = makeRig();
    const response = quietly(() => api.route(req('POST', '/quests', CULL)));
    assert.equal(response.status, 201);
    const body = response.body as { quest: Record<string, unknown>; givers: number[]; resynced: number };
    assert.equal(body.quest.id, 'cull-the-shamans');
    // The whole point of the route: the badge and the immunity move with the row, not on the next boot.
    assert.deepEqual(body.givers, [61]);
    assert.deepEqual([...questGivers], [61]);
    // Both standing kobold guards were re-sent to whoever was watching them — the badge is live.
    assert.equal(body.resynced, 2);
  });

  it('resolves the names behind the numbers, so a list is readable', () => {
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const body = api.route(req('GET', '/quests')).body as {
      total: number;
      quests: { id: string; giver: number; giverName: string; giverStanding: number; targetName: string }[];
    };
    assert.equal(body.total, 1);
    assert.equal(body.quests[0]?.giver, 61, 'the number stays the join key');
    assert.equal(body.quests[0]?.giverName, 'a kobold guard');
    // Colour codes stripped, exactly as the mob search strips them: `&+y` is not a name.
    assert.equal(body.quests[0]?.targetName, 'a kobold shaman');
    assert.equal(body.quests[0]?.giverStanding, 3);
  });

  it('re-sends the giver when only the armour flips, which the badge diff alone never notices', () => {
    // The bug this pins: ticking `protectGiver` on a mob that is *already* a giver leaves the giver
    // set identical, so a re-sync that compared only those two would report `resynced: 0` — and every
    // client already in the room would keep showing **Attack** on a body the server has just started
    // refusing to let anyone hit. The stale menu is invisible from the response body, which is exactly
    // why it is asserted here rather than trusted to a look-and-see drive.
    const { api, questGivers } = makeRig({ quests: [CULL as QuestDef] });
    const response = quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { protectGiver: true })));
    assert.equal(response.status, 200);
    const body = response.body as { quest: { protectGiver?: true }; givers: number[]; resynced: number };
    assert.equal(body.quest.protectGiver, true);
    // The giver set did not move — and the bodies were re-sent anyway.
    assert.deepEqual(body.givers, [61]);
    assert.deepEqual([...questGivers], [61]);
    assert.equal(body.resynced, 2, 'both standing guards must be re-sent when the armour changes');

    // And off again, which is the direction an operator uses to undo a mistake.
    const off = quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { protectGiver: false })));
    assert.equal(off.status, 200);
    const offBody = off.body as { quest: { protectGiver?: true }; resynced: number };
    assert.equal(offBody.quest.protectGiver, undefined);
    assert.equal(offBody.resynced, 2);
  });

  it('leaves a quest that says nothing about armour with a killable giver', () => {
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const body = api.route(req('GET', '/quests')).body as { quests: { protectGiver?: true }[] };
    // The owner's default, asserted rather than assumed: work on offer is not a licence to live.
    assert.equal(body.quests[0]?.protectGiver, undefined);
  });

  it('refuses a giver the world does not have', () => {
    const { api } = makeRig();
    const response = api.route(req('POST', '/quests', { ...CULL, giver: 4242 }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /no mob 4242 among the loaded templates/);
  });

  it('refuses a kill target the world does not have, because it could never complete', () => {
    const { api } = makeRig();
    const response = api.route(req('POST', '/quests', { ...CULL, objective: { ...CULL.objective, vnum: 4242 } }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /nothing to kill/);
  });

  it('takes a bring objective against the item catalogue', () => {
    const { api } = makeRig();
    const bring = { ...CULL, id: 'fetch-the-dagger', objective: { kind: 'bring', vnum: 100, what: 'the silver dagger' } };
    assert.equal(quietly(() => api.route(req('POST', '/quests', bring))).status, 201);
    const missing = api.route(req('POST', '/quests', { ...bring, id: 'x', objective: { kind: 'bring', vnum: 999, what: 'a rumour' } }));
    assert.equal(missing.status, 400);
    assert.match((missing.body as { error: string }).error, /nothing to bring/);
  });

  /**
   * The third reward pool, which the Duris harvest made necessary: of the quest givers who stand in a
   * loaded zone, every one whose objective is reachable pays an object and no coin at all.
   */
  it('pays an item beside the two numbers, and checks it against the catalogue', () => {
    const { api } = makeRig();
    const paid = { ...CULL, id: 'pays-a-ring', reward: { xp: 0, copper: 0, item: 100 } };
    const created = quietly(() => api.route(req('POST', '/quests', paid)));
    assert.equal(created.status, 201);
    assert.deepEqual((created.body as { quest: { reward: unknown } }).quest.reward, { xp: 0, copper: 0, item: 100 });

    const missing = api.route(req('POST', '/quests', { ...paid, id: 'owes-a-ghost', reward: { xp: 0, copper: 0, item: 999 } }));
    assert.equal(missing.status, 400);
    assert.match((missing.body as { error: string }).error, /no item 999 in the catalogue/);
  });

  it('names the reward item beside the number, as it does the giver and the target', () => {
    const paid = { ...CULL, reward: { xp: 0, copper: 0, item: 100 } };
    const { api } = makeRig({ quests: [paid as QuestDef] });
    const body = api.route(req('GET', '/quests')).body as { quests: { rewardItemName: string | null }[] };
    assert.equal(body.quests[0]?.rewardItemName, 'a silver dagger');
    // Null rather than absent when nothing is paid — a real state the form reads, not an error.
    const { api: plain } = makeRig({ quests: [CULL as QuestDef] });
    const bare = plain.route(req('GET', '/quests')).body as { quests: { rewardItemName: string | null }[] };
    assert.equal(bare.quests[0]?.rewardItemName, null);
  });

  it('treats a reward item as absent rather than zero, because vnum 0 is legal', () => {
    // `copper: 0` means "pays no coin"; `item: 0` cannot mean "pays no item" without making item 0
    // unpayable, so the field is either a vnum or it is not there.
    assert.deepEqual(draftQuest({ ...CULL, reward: { xp: 1, copper: 2 } }), {
      quest: { ...CULL, objective: CULL.objective, reward: { xp: 1, copper: 2 } } as QuestDef,
    });
    const cleared = draftQuest({ ...CULL, reward: { xp: 1, copper: 2, item: null } });
    assert.ok('quest' in cleared && !('item' in cleared.quest.reward), 'null clears it, as an emptied form box does');
    const kept = draftQuest({ ...CULL, reward: { xp: 1, copper: 2, item: 0 } });
    assert.ok('quest' in kept && kept.quest.reward.item === 0, 'vnum 0 survives, so it is payable');
    assert.deepEqual(draftQuest({ ...CULL, reward: { xp: 1, copper: 2, item: 'ring' } }), {
      error: 'reward item must be a whole item vnum, or absent',
    });
  });

  it('says what is wrong with a draft rather than merely refusing', () => {
    const { api } = makeRig();
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ...CULL, id: 'Cull The Shamans' }, /slug/],
      [{ ...CULL, id: '' }, /id is required/],
      [{ ...CULL, name: '  ' }, /name is required/],
      [{ ...CULL, ask: 'x'.repeat(601) }, /at most 600 characters/],
      [{ ...CULL, objective: { kind: 'steal', vnum: 62, what: 'a purse' } }, /kind must be "kill" or "bring"/],
      [{ ...CULL, objective: { kind: 'kill', vnum: 62, count: 0, what: 'shamans' } }, /count must be a whole number from 1 to 100/],
      [{ ...CULL, objective: { kind: 'kill', vnum: 62, count: 2, what: '' } }, /objective what is required/],
      [{ ...CULL, reward: { xp: -1, copper: 0 } }, /reward xp/],
      [{ ...CULL, reward: { xp: 0, copper: 99_000_000 } }, /reward copper/],
    ];
    for (const [body, reason] of cases) {
      const response = api.route(req('POST', '/quests', body));
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      assert.match((response.body as { error: string }).error, reason);
    }
  });

  it('refuses a second quest with an id already taken', () => {
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const response = api.route(req('POST', '/quests', { ...CULL, name: 'A different quest' }));
    assert.equal(response.status, 409);
    assert.match((response.body as { error: string }).error, /already exists/);
    // And the one that was there is untouched — a refused create must not be a half-applied edit.
    const listed = api.route(req('GET', '/quests')).body as { quests: { name: string }[] };
    assert.equal(listed.quests[0]?.name, 'Cull the shamans');
  });

  it('patches as a re-draft, leaving the fields it did not mention', () => {
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const response = quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { reward: { xp: 900, copper: 0 } })));
    assert.equal(response.status, 200);
    const quest = (response.body as { quest: Record<string, unknown> }).quest;
    assert.deepEqual(quest.reward, { xp: 900, copper: 0 });
    assert.equal(quest.ask, 'The shamans have grown loud. Silence two of them.');
    assert.deepEqual(quest.objective, { kind: 'kill', vnum: 62, count: 2, what: 'kobold shamans' });
  });

  it('refuses an id change, because the id is where progress is filed', () => {
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const response = api.route(req('PATCH', '/quests/cull-the-shamans', { id: 'renamed' }));
    assert.equal(response.status, 409);
    assert.match((response.body as { error: string }).error, /every character mid-quest would lose theirs/);
    // An id echoed back unchanged is not a change, and must not be treated as one.
    assert.equal(quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { id: 'cull-the-shamans', name: 'Hush' }))).status, 200);
  });

  it('404s a quest nobody has, on both verbs', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PATCH', '/quests/nothing', { name: 'x' })).status, 404);
    assert.equal(api.route(req('DELETE', '/quests/nothing')).status, 404);
  });

  it('deletes one, un-badges its giver and says whose progress it stranded', () => {
    const { api, players, questGivers } = makeRig({ quests: [CULL as QuestDef] });
    const ravi = fakePlayer('Ravi');
    ravi.quests.set('cull-the-shamans', 1);
    players.push(ravi, fakePlayer('Nobody'));

    const response = quietly(() => api.route(req('DELETE', '/quests/cull-the-shamans')));
    assert.equal(response.status, 200);
    const body = response.body as { stranded: number; givers: number[]; resynced: number };
    // The giver stops being one the instant this returns — registry emptied, both bodies re-sent.
    assert.deepEqual(body.givers, []);
    assert.equal(questGivers.size, 0);
    assert.equal(body.resynced, 2);
    // And the honest sentence: one character was mid-quest, and their row now names nothing.
    assert.equal(body.stranded, 1);
  });

  it('leaves the world alone when nothing about the giver changed', () => {
    // An edit to prose must not re-broadcast the warren: only a vnum whose giver status *flipped* is
    // re-sent, which is the difference between a resync and a stampede.
    const { api } = makeRig({ quests: [CULL as QuestDef] });
    const response = quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { thanks: 'Well done.' })));
    assert.equal((response.body as { resynced: number }).resynced, 0);
  });

  it('round-trips through the loader, in the shape the file is hand-authored in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a7q-'));
    const questsFile = join(dir, 'quests.json');
    const { api } = makeRig({ questsFile });
    quietly(() => api.route(req('POST', '/quests', CULL)));
    quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { reward: { xp: 750, copper: 25 } })));

    // The written file, read by the loader the server boots with — the only test of "does it survive a
    // restart" that does not need a restart.
    const reloaded = loadQuests(questsFile);
    assert.equal(reloaded.size, 1);
    assert.deepEqual(reloaded.get('cull-the-shamans')?.reward, { xp: 750, copper: 25 });

    // And the layout, because the file is git-tracked content a person edits: keys in reading order,
    // and the two leaf records on one line each.
    const text = readFileSync(questsFile, 'utf8');
    assert.match(text, /"objective": \{ "kind": "kill", "vnum": 62, "count": 2, "what": "kobold shamans" \}/);
    assert.match(text, /"reward": \{ "xp": 750, "copper": 25 \}/);
    assert.deepEqual(
      [...text.matchAll(/^ {4}"(\w+)":/gm)].map((m) => m[1]),
      ['id', 'giver', 'name', 'ask', 'thanks', 'objective', 'reward'],
    );

    // A delete empties it rather than leaving the last record behind.
    quietly(() => api.route(req('DELETE', '/quests/cull-the-shamans')));
    assert.equal(loadQuests(questsFile).size, 0);
    assert.equal(readFileSync(questsFile, 'utf8'), '[]\n');
  });

  it('writes the reward item only when one is paid, as it writes a bring count only above one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a7q-item-'));
    const questsFile = join(dir, 'quests.json');
    const { api } = makeRig({ questsFile });
    quietly(() => api.route(req('POST', '/quests', { ...CULL, reward: { xp: 0, copper: 0, item: 100 } })));

    const text = readFileSync(questsFile, 'utf8');
    assert.match(text, /"reward": \{ "xp": 0, "copper": 0, "item": 100 \}/);
    assert.deepEqual(loadQuests(questsFile).get('cull-the-shamans')?.reward, { xp: 0, copper: 0, item: 100 });

    // Cleared through the editor, the key goes away rather than becoming a zero a reader would believe.
    quietly(() => api.route(req('PATCH', '/quests/cull-the-shamans', { reward: { xp: 5, copper: 0, item: null } })));
    assert.match(readFileSync(questsFile, 'utf8'), /"reward": \{ "xp": 5, "copper": 0 \}\n/);
    assert.deepEqual(loadQuests(questsFile).get('cull-the-shamans')?.reward, { xp: 5, copper: 0 });
  });

  /**
   * The writer's half of the back-compatibility bargain, and the reason it is worth a test of its own:
   * the four quests shipped in `data/world/overrides/quests.json` were hand-authored before a `bring`
   * could count. A writer that stamped `"count": 1` onto each of them would turn the first panel edit
   * of any one quest into a diff touching every other, in the one directory under `data/` git tracks.
   */
  it('leaves a bring of one uncounted in the file, and writes the count when there is one to write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a7q-count-'));
    const questsFile = join(dir, 'quests.json');
    const { api } = makeRig({ questsFile });

    // Posted with no count at all — the shape every `bring` quest in the shipped file has.
    const fetch = { ...CULL, id: 'fetch-the-dagger', objective: { kind: 'bring', vnum: 100, what: 'the silver dagger' } };
    assert.equal(quietly(() => api.route(req('POST', '/quests', fetch))).status, 201);
    assert.match(readFileSync(questsFile, 'utf8'), /"objective": \{ "kind": "bring", "vnum": 100, "what": "the silver dagger" \}/);
    // Silent in the file, a 1 in the record: the normalisation is the loader's, not the reader's.
    assert.equal(loadQuests(questsFile).get('fetch-the-dagger')?.objective.count, 1);

    // Ask for eight and the field appears, in `kill`'s own slot between the vnum and the words.
    quietly(() => api.route(req('PATCH', '/quests/fetch-the-dagger', { objective: { kind: 'bring', vnum: 100, count: 8, what: 'silver daggers' } })));
    assert.match(readFileSync(questsFile, 'utf8'), /"objective": \{ "kind": "bring", "vnum": 100, "count": 8, "what": "silver daggers" \}/);
    assert.equal(loadQuests(questsFile).get('fetch-the-dagger')?.objective.count, 8);

    // And back down to one, which takes the key away again rather than leaving a `1` behind.
    quietly(() => api.route(req('PATCH', '/quests/fetch-the-dagger', { objective: { kind: 'bring', vnum: 100, count: 1, what: 'the silver dagger' } })));
    assert.match(readFileSync(questsFile, 'utf8'), /"objective": \{ "kind": "bring", "vnum": 100, "what": "the silver dagger" \}/);
  });

  it('refuses a count outside 1–100 on a bring, exactly as it does on a kill', () => {
    const { api } = makeRig();
    const fetch = { ...CULL, id: 'fetch-too-many', objective: { kind: 'bring', vnum: 100, count: 250, what: 'daggers' } };
    const tooMany = api.route(req('POST', '/quests', fetch));
    assert.equal(tooMany.status, 400);
    assert.match((tooMany.body as { error: string }).error, /count must be a whole number from 1 to 100/);

    for (const count of [0, -1, 2.5]) {
      const bad = api.route(req('POST', '/quests', { ...fetch, objective: { ...fetch.objective, count } }));
      assert.equal(bad.status, 400, `count ${count} should be refused`);
    }
    // A `kill` still may not omit it — the asymmetry is deliberate, and this is the half that holds.
    const mute = api.route(req('POST', '/quests', { ...CULL, id: 'kill-some', objective: { kind: 'kill', vnum: 62, what: 'shamans' } }));
    assert.equal(mute.status, 400);
    assert.match((mute.body as { error: string }).error, /count must be a whole number from 1 to 100/);
  });

  it('audits every write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a7q-audit-'));
    const auditFile = join(dir, 'audit.jsonl');
    const { api } = makeRig({ auditFile });
    quietly(() => {
      api.route(req('POST', '/quests', CULL));
      api.route(req('PATCH', '/quests/cull-the-shamans', { name: 'Hush the shamans' }));
      api.route(req('DELETE', '/quests/cull-the-shamans'));
    });
    const actions = readFileSync(auditFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { action: string }).action);
    assert.deepEqual(actions, ['quest.create', 'quest.author', 'quest.delete']);
  });
});

/** A4c — authoring what a mob template carries. */
describe('mob loot', () => {
  it('writes a template’s loot and says how many are already standing', () => {
    const { api, calls } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100, slot: 'head' }, { vnum: 100 }] }));
    assert.equal(response.status, 200);

    const body = response.body as { loot: unknown[]; spawned: number };
    assert.deepEqual(body.loot, [{ vnum: 100, slot: 'head' }, { vnum: 100 }]);
    // The number that stops "I authored it and nothing changed" being the first bug report: loot is
    // per template, so it lands on the next spawn and not on the bodies already walking around.
    assert.equal(body.spawned, 3);
    assert.ok(calls.includes('authorMobLoot 61 x2'));
  });

  it('refuses an item the catalogue does not have, rather than storing it to fail later', () => {
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 999_999 }] }));
    assert.equal(response.status, 404);
    assert.match((response.body as { error: string }).error, /no item 999999/);
  });

  it('refuses a slot the game does not model', () => {
    const { api } = makeRig();
    const response = api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100, slot: 'tail' }] }));
    assert.equal(response.status, 400);
    assert.match((response.body as { error: string }).error, /no such slot: tail/);
  });

  it('refuses a template this server has not loaded', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('PATCH', '/mobs/99999/loot', { loot: [] })).status, 404);
  });

  it('takes an empty list as "carry nothing", which is how an author undoes it', () => {
    const { api, calls } = makeRig();
    api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100 }] }));
    const cleared = api.route(req('PATCH', '/mobs/61/loot', { loot: [] }));
    assert.equal(cleared.status, 200);
    assert.deepEqual((cleared.body as { loot: unknown[] }).loot, []);
    assert.ok(calls.includes('authorMobLoot 61 x0'));
  });

  it('validates the whole list before writing any of it', () => {
    const { api, calls } = makeRig();
    // The second row is bad. A half-applied edit is worse than a refused one.
    const response = api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100 }, { vnum: 999_999 }] }));
    assert.equal(response.status, 404);
    assert.equal(calls.filter((c) => c.startsWith('authorMobLoot')).length, 0);
  });

  it('audits it, because it changes what the world will spawn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mygame-a4c-'));
    const auditFile = join(dir, 'audit.jsonl');
    const { api } = makeRig({ auditFile });
    api.route(req('PATCH', '/mobs/61/loot', { loot: [{ vnum: 100 }] }));

    const line = JSON.parse(readFileSync(auditFile, 'utf8').trim()) as { action: string; vnum: number; pieces: number };
    assert.equal(line.action, 'mob.loot');
    assert.equal(line.vnum, 61);
    assert.equal(line.pieces, 1);
  });
});

/**
 * A8d — `POST /zones`, a zone from nothing. The store rules live in `zone-authoring.test.ts`; this is
 * the route's own contract: the server allocates, the origin room is written in the same motion, and
 * the answer tells a person — in words — that the config and a restart are the other half.
 */
describe('creating a zone', () => {
  it('creates the zone and its origin room, and says what to do next', () => {
    const { api } = makeRig();
    const created = quietly(() =>
      api.route(req('POST', '/zones', { name: 'The Sunken Stair', roomName: 'A Flooded Landing', by: 'test' })),
    );
    assert.equal(created.status, 201);
    const body = created.body as { zone: number; room: number; note: string };
    assert.ok(body.zone >= AUTHORED_ZONE_BASE, `${body.zone} is ours, not the harvest's`);
    assert.ok(body.room >= AUTHORED_ROOM_BASE, `${body.room} is ours, not the harvest's`);
    assert.match(body.note, /world\.config\.json/);
    assert.match(body.note, /restart/);

    // Until the config loads it, the listing shows it as pending — a creation must not be invisible.
    const zones = api.route(req('GET', '/zones')).body as {
      pending?: { id: number; name: string }[];
      zones: { id: number }[];
    };
    assert.equal(zones.pending?.length, 1);
    assert.equal(zones.pending?.[0]?.name, 'The Sunken Stair');
    assert.ok(!zones.zones.some((zone) => zone.id === body.zone), 'not in the loaded list — nothing restarted');

    // The origin room is in the authored store, at the origin, with its extent already recorded so
    // the first boot does not read the new Place as stale.
    const second = quietly(() => api.route(req('POST', '/zones', { name: 'The Second Stair' }))).body as {
      zone: number;
    };
    assert.equal(second.zone, body.zone + 1, 'the counter advances rather than reissuing');
  });

  it('refuses a chosen id, an unusable name, and a non-object body', () => {
    const { api } = makeRig();
    assert.equal(api.route(req('POST', '/zones', { id: 555, name: 'A Chosen Number' })).status, 400);
    assert.equal(api.route(req('POST', '/zones', { name: '   ' })).status, 400);
    assert.equal(api.route(req('POST', '/zones', { name: 'x'.repeat(61) })).status, 400);
    assert.equal(api.route(req('POST', '/zones', 'nonsense')).status, 400);
  });
});

describe('accounts — the reset path', () => {
  it('lists accounts without ever shipping a hash', () => {
    const { api, accounts } = makeRig();
    accounts.create('Danny', 'first-password');
    accounts.claim('danny', 'aldric');
    const response = api.route(req('GET', '/accounts'));
    assert.equal(response.status, 200);
    const body = response.body as { accounts: Array<Record<string, unknown>> };
    assert.equal(body.accounts.length, 1);
    assert.equal(body.accounts[0]?.['slug'], 'danny');
    assert.deepEqual(body.accounts[0]?.['characters'], ['aldric']);
    assert.equal(JSON.stringify(body).includes('scrypt'), false);
  });

  it('resets a password, and the old one stops working', () => {
    const { api, accounts } = makeRig();
    accounts.create('Danny', 'old-password');
    const response = quietly(() => api.route(req('POST', '/accounts/danny/password', { password: 'new-password' })));
    assert.equal(response.status, 200);
    assert.equal(accounts.verify('Danny', 'old-password').ok, false);
    assert.equal(accounts.verify('Danny', 'new-password').ok, true);
  });

  it('refuses a reset for nobody, a bad body, and a bad password', () => {
    const { api, accounts } = makeRig();
    accounts.create('Danny', 'fine-password');
    assert.equal(api.route(req('POST', '/accounts/nobody/password', { password: 'x-password' })).status, 404);
    assert.equal(api.route(req('POST', '/accounts/danny/password', { nope: true })).status, 400);
    assert.equal(api.route(req('POST', '/accounts/danny/password', { password: '   ' })).status, 400);
  });

  it('assigns an unowned character and refuses a held one', () => {
    const { api, accounts } = makeRig();
    accounts.create('First', 'pw-first');
    accounts.create('Second', 'pw-second');
    const assigned = quietly(() => api.route(req('POST', '/accounts/first/claim', { character: 'Aldric' })));
    assert.equal(assigned.status, 200);
    assert.equal(accounts.ownerOf('aldric'), 'first');
    const stolen = api.route(req('POST', '/accounts/second/claim', { character: 'aldric' }));
    assert.equal(stolen.status, 409);
    assert.equal(api.route(req('POST', '/accounts/nobody/claim', { character: 'aldric' })).status, 404);
    assert.equal(api.route(req('POST', '/accounts/first/claim', { character: '!!!' })).status, 400);
  });
});
