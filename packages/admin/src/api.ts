/**
 * The panel's one way of talking to the game server.
 *
 * Every request goes to `/admin/api/...` on this page's own origin — the Vite dev server proxies it
 * to the game server — and carries the `x-admin-token` header, whose presence is required before its
 * value matters (see `DESIGN-admin-panel.md` §3). The token itself lives in `localStorage`, entered
 * through the header field; when the server has no `GAME_ADMIN_TOKEN`, any value passes.
 */

const TOKEN_KEY = 'mygame-admin-token';

export function storedToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? 'dev';
}

export function rememberToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export interface ApiResult<T> {
  readonly ok: boolean;
  readonly status: number;
  /** The parsed body on success. */
  readonly body: T | undefined;
  /** The server's own sentence on failure — written for a person, so show it verbatim. */
  readonly error: string | undefined;
}

export async function call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/admin/api${path}`, {
      method,
      headers: {
        'x-admin-token': storedToken(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error =
        typeof (parsed as { error?: unknown } | undefined)?.error === 'string'
          ? (parsed as { error: string }).error
          : `${response.status} ${response.statusText}`;
      return { ok: false, status: response.status, body: undefined, error };
    }
    return { ok: true, status: response.status, body: parsed as T, error: undefined };
  } catch {
    return { ok: false, status: 0, body: undefined, error: 'game server unreachable — is `npm run dev` running?' };
  }
}

/**
 * The same call, aimed at the **supervisor** instead of the game server.
 *
 * A separate function rather than a path argument, because the difference is not cosmetic: this one
 * reaches a different process on a different port, and it is the only part of the panel expected to
 * work while the game server is down. Its unreachable message says so — "is the supervisor running"
 * is a different question from "is the game running", and answering the first with the second is how
 * an operator ends up restarting something that was never the problem.
 */
export async function callSupervisor<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch(`/supervisor/api${path}`, {
      method,
      headers: {
        'x-admin-token': storedToken(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error =
        typeof (parsed as { error?: unknown } | undefined)?.error === 'string'
          ? (parsed as { error: string }).error
          : `${response.status} ${response.statusText}`;
      return { ok: false, status: response.status, body: undefined, error };
    }
    return { ok: true, status: response.status, body: parsed as T, error: undefined };
  } catch {
    return {
      ok: false,
      status: 0,
      body: undefined,
      error: 'supervisor unreachable — is `npm run supervisor` running?',
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Response shapes — hand-written mirrors of what `server/src/admin.ts` sends   */
/* -------------------------------------------------------------------------- */

/* ---- A10: the supervisor -------------------------------------------------- */

/** Mirrors `supervisor.ts`'s `statusBody`. */
export interface SupervisorBody {
  ok: boolean;
  supervisor: {
    startedAt: number;
    uptimeMs: number;
    port: number;
    gamePort: number;
    token: string;
    giveUpAfter: number;
    command: string;
  };
  server: {
    state: 'up' | 'starting' | 'backoff' | 'stopped' | 'gave-up';
    /** The state as a sentence, written server-side so the two cannot disagree. */
    detail: string;
    pid: number | null;
    since: number | null;
    uptimeMs: number | null;
    /** Milliseconds from spawn to the first `/health` answer. */
    readyMs: number | null;
    restarts: number;
    failures: number;
    backoffUntil: number | null;
    attempt: number | null;
    lastExit: { at: number; code: number | null; signal: string | null; text: string; ranMs: number } | null;
  };
  /** What the game server itself says — the only honest source for "how many am I about to drop". */
  game: { reachable: boolean; players: number | null; zones: number | null };
  log: { total: number; dropped: number };
}

export interface SupervisorLogBody {
  lines: { seq: number; at: number; stream: 'out' | 'err' | 'sup'; text: string }[];
  total: number;
  dropped: number;
}

export interface StatusBody {
  ok: boolean;
  startedAt: number;
  uptimeMs: number;
  protocol: number;
  tickMs: number;
  roundMs: number;
  playersOnline: number;
  places: number;
  spawn: { room: number; name: string };
  zones: { id: number; name: string; rooms: number; levels: number[]; populated: boolean }[];
  lights: { id: string; name: string; radius: number; mode: string; durationMs: number | null }[];
  token: string;
}

export interface RoomRef {
  id: number;
  name: string;
}

export interface AffectRow {
  type: string;
  apply: string;
  modifier: number;
  durationMs: number | null;
  context: string | null;
}

export interface LiveHalf {
  slug: string;
  name: string;
  id: number;
  level: number;
  experience: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  move: number;
  maxMove: number;
  posture: string;
  status: string;
  fighting: number | null;
  room: RoomRef | null;
  place: string;
  light: { id: string; name: string; radius: number } | null;
  affects: AffectRow[];
}

export interface StoredHalf {
  savedAt: string | null;
  lastRoom: RoomRef | null;
  seenPlaces: number;
  seenTiles: number;
  takenCount: number;
  /** The stored level and experience, or null where never set. Real, persisted facts since 2026-08-02. */
  level: number | null;
  experience: number | null;
  wound: { hp: number; mana: number; move: number } | null;
  affects: AffectRow[];
}

export interface PlayerDetail {
  slug: string;
  name: string;
  online: boolean;
  live?: LiveHalf;
  record: StoredHalf;
}

export interface StoredSummary {
  slug: string;
  name: string;
  savedAt: string | undefined;
  lastRoom: number | undefined;
  seenTiles: number;
  takenCount: number;
  affectCount: number;
  wound: { hp: number; mana: number; move: number } | undefined;
  level: number | undefined;
}

export interface RosterBody {
  online: LiveHalf[];
  stored: StoredSummary[];
}

export interface RoomsBody {
  rooms: { id: number; name: string; zone: number; zoneName: string; level: number }[];
}

/* ---- A7q: quests --------------------------------------------------------- */

/**
 * One quest as `GET /quests` sends it — the record, plus the names its numbers stand for.
 *
 * The names are *hints* and never fields: `giver` stays the vnum, because the vnum is the join key
 * and the file holds nothing else. A form that posted a name back would be posting something the
 * server cannot store. See `admin.ts`'s `questRow`.
 */
export interface QuestObjective {
  kind: 'kill' | 'bring';
  vnum: number;
  /**
   * How many, on **both** kinds. Optional only because a row may have been written by a server from
   * before a `bring` could count; the server normalises a missing one to 1 and always sends it back.
   */
  count?: number;
  what: string;
}

export interface QuestRow {
  id: string;
  giver: number;
  name: string;
  ask: string;
  thanks: string;
  objective: QuestObjective;
  reward: { xp: number; copper: number; item?: number };
  /** Set only when the giver is armoured against all harm. Absent — the default — means killable. */
  protectGiver?: true;
  /** Null when the vnum names nothing this server loaded — a real state, not an error. */
  giverName: string | null;
  /** How many of the giver are standing right now. A patron who never spawns is a quest nobody finds. */
  giverStanding: number;
  targetName: string | null;
  /** Null both when no item is paid and when the vnum names nothing loaded. */
  rewardItemName: string | null;
}

export interface QuestsBody {
  total: number;
  quests: QuestRow[];
}

/** What a write answers with: the row as it now stands, and what the live re-seed did. */
export interface QuestWriteBody {
  ok: boolean;
  quest?: QuestRow;
  /** Every giver vnum after the write — the registry behind the `?` badge and the immunity. */
  givers: number[];
  /** How many standing bodies were re-sent to their watchers because their giver status flipped. */
  resynced: number;
  /** On a delete: how many online characters were carrying progress this id no longer names. */
  stranded?: number;
}

/* ---- A3: the zone browser ------------------------------------------------ */

export interface Occupants {
  players: string[];
  mobs: string[];
  corpses: string[];
}

export interface ZoneRow {
  id: number;
  name: string;
  rooms: number;
  levels: number[];
  populated: boolean;
  /** Milliseconds to the next repop, or null for a zone with no population at all. */
  repopInMs: number | null;
  entryRoom: number;
  described: number;
  flagged: number;
}

export interface ZonesBody {
  zones: ZoneRow[];
  /** A8d: zones created here that `world.config.json` does not load yet. Absent when there are none. */
  pending?: { id: number; name: string; note: string }[];
}

/** What a builder has authored on top of the generated room. Every field optional — it is a patch. */
export interface RoomOverride {
  name?: string;
  description?: string;
  sector?: string;
  flags?: string[];
  /** When it was last written. */
  at?: string;
  /** The model that drafted the prose, and the brief it was given. Absent on hand-written rooms. */
  by?: string;
  brief?: string;
}

export interface OllamaBody {
  reachable: boolean;
  models: { name: string; size: number; parameters: string | null }[];
}

export interface DraftBody {
  description: string;
  model: string;
  brief: string;
  ms: number;
}

export interface ZoneRoomRow {
  id: number;
  name: string;
  level: number;
  /** Cell position on this zone's own normalised grid — what the map draws. */
  x: number;
  y: number;
  sector: string;
  flags: string[];
  /** Destination as well as direction: an exit off this grid must not be drawn as a neighbour. */
  exits: { dir: string; to: number }[];
  described: boolean;
  /** Whether this room carries hand-authored content — how you find your own work in a 219-room zone. */
  authored: boolean;
  occupants: Occupants;
}

export interface ZoneRoomsBody {
  zone: { id: number; name: string };
  rooms: ZoneRoomRow[];
}

export interface RoomDetail {
  id: number;
  name: string;
  zone: number;
  place: string;
  pos: { x: number; y: number; z: number };
  sector: string;
  flags: string[];
  description: string | null;
  /**
   * The authored overlay for this room, or null for one still exactly as generated.
   *
   * **Which fields it names is what matters**, not just that it exists: the editor offers to revert
   * precisely those and leaves the harvested ones alone. See `server/src/overrides.ts`.
   */
  authored: RoomOverride | null;
  /** A8 slice 3: whether removing this room would resize the level, and so reset every map of it. */
  holdsExtent: boolean;
  /**
   * The rooms within two steps, with their prose — the context a room cannot be written without.
   *
   * "Southwestern Corner Of the Banquet Hall" does not say whether the hall is laid for a feast or
   * in ruins. The room next door does. Ordered by nearness, described rooms first within each ring.
   */
  nearby: {
    id: number;
    hops: number;
    /** The first step taken to get here — "north of you", even two rooms out. Null for the room itself. */
    dir: string | null;
    name: string;
    sector: string;
    description: string | null;
    /** False for a room read from a zone this server does not run — good context, not reachable. */
    loaded: boolean;
  }[];
  occupants: Occupants;
  exits: {
    dir: string;
    to: number;
    /** Null when the destination is in a zone this server has not loaded — see `toZone`. */
    toName: string | null;
    /** Named when the destination is off the loaded world: `up` out of IceCrag goes to zone 219. */
    toZone: { id: number; name: string } | null;
    loaded: boolean;
    portal: boolean;
    door: { name: string; closed: boolean; locked: boolean } | null;
  }[];
}
