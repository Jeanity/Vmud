/**
 * The admin API, driven through the same plain request/response shapes the HTTP adapter feeds it.
 *
 * Everything here runs against a temporary directory, a synthetic zone and a fake set of live
 * operations, so no test can scribble on a real character or needs a socket. The live ops record
 * what they were asked and mutate the fake player the way the real implementations mutate the
 * simulation's, which is what lets the tests read the router's returned detail views for truth.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  AUTHORED_VNUM_BASE,
  DURIS_ITEM,
  LPC_ART,
  boundsOf,
  type ItemTemplate,
  type Room,
  type Zone,
} from '@mygame/shared';

import { AdminApi, type AdminDeps, type AdminRequest, type AnnounceScope, type LiveOps } from './admin.ts';
import { applyItemOverride, loadItemOverrides, mergeItemOverride, type ItemOverrides } from './item-overrides.ts';
import {
  draftAuthoredItem,
  takeAuthoredVnum,
  type AuthoredStore,
  type ItemDraft,
} from './item-authoring.ts';
import { PlayerStore, slugify } from './players.ts';
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
  } as unknown as Player;
}

interface Rig {
  api: AdminApi;
  store: PlayerStore;
  dir: string;
  players: Player[];
  calls: string[];
  heard: string[];
  scopes: AnnounceScope[];
}

function makeRig(options: { token?: string; auditFile?: string; overridesFile?: string; itemOverridesFile?: string } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-admin-'));
  const store = new PlayerStore({ dir });
  const world = new GameWorld([testZone()], { zone: 600, room: null });
  const players: Player[] = [];
  const calls: string[] = [];
  const heard: string[] = [];
  const scopes: AnnounceScope[] = [];
  let worldSettings: WorldSettings = { pvp: false };

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

  const live: LiveOps = {
    online: () => players,
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
    repopIn: (zone) => (zone === 600 ? 90_000 : undefined),
    occupantsOf: () => ({ players: ['Ravi'], mobs: ['a sentry'], corpses: [] }),
    publishRoom: (room, _place, regrid) => void calls.push(`publishRoom ${room.id} regrid=${regrid}`),
    // Held in the rig rather than written to disk: what these tests check is that the router reads,
    // validates and announces, not that a JSON file round-trips.
    settings: () => worldSettings,
    setSettings: (next) => {
      worldSettings = next;
      calls.push(`setSettings pvp=${next.pvp}`);
    },
  };

  const deps: AdminDeps = {
    world,
    store,
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
    itemOverridesFile: options.itemOverridesFile,
    facts: { protocol: 9, tickMs: 100, roundMs: 3000, startedAt: Date.now() },
  };
  return { api: new AdminApi(deps), store, dir, players, calls, heard, scopes };
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
    assert.deepEqual(api.route(req('GET', '/settings')).body, { settings: { pvp: false } });
  });

  it('throws the PvP switch and tells the whole world it happened', () => {
    // Announcing is the requirement, not a courtesy: this switch decides whether the person next to
    // you can kill you, and finding out by dying is not acceptable.
    const { api, players, heard, scopes } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('PATCH', '/settings', { pvp: true })));
    assert.equal(response.status, 200);
    assert.deepEqual((response.body as { settings: unknown }).settings, { pvp: true });
    assert.equal((response.body as { changed: boolean }).changed, true);
    assert.equal(heard.length, 1);
    assert.match(heard[0]!, /now ON/);
    assert.deepEqual(scopes, [{ kind: 'world' }], 'a rule change is never scoped');
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
    const refused = api.route(req('PATCH', '/items/100', { slot: 'head' }));
    assert.equal(refused.status, 400);
    assert.match(String((refused.body as { error: string }).error), /behaviour/);
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
