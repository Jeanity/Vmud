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

import { boundsOf, type Room, type Zone } from '@mygame/shared';

import { AdminApi, type AdminDeps, type AdminRequest, type LiveOps } from './admin.ts';
import { PlayerStore, slugify } from './players.ts';
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
}

function makeRig(options: { token?: string; auditFile?: string } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'mygame-admin-'));
  const store = new PlayerStore({ dir });
  const world = new GameWorld([testZone()], { zone: 600, room: null });
  const players: Player[] = [];
  const calls: string[] = [];
  const heard: string[] = [];

  const live: LiveOps = {
    online: () => players,
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
  };

  const deps: AdminDeps = {
    world,
    store,
    live,
    announce: (text) => {
      heard.push(text);
      return players.length;
    },
    token: options.token,
    auditFile: options.auditFile,
    facts: { protocol: 9, tickMs: 100, roundMs: 3000, startedAt: Date.now() },
  };
  return { api: new AdminApi(deps), store, dir, players, calls, heard };
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
    const { api, players, heard } = makeRig();
    players.push(fakePlayer('Ravi'));

    const response = quietly(() => api.route(req('POST', '/announce', { text: 'The server restarts in five minutes.' })));
    assert.deepEqual(response.body, { ok: true, heard: 1 });
    assert.deepEqual(heard, ['The server restarts in five minutes.']);
    assert.equal(api.route(req('POST', '/announce', { text: 'x'.repeat(400) })).status, 400);
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
