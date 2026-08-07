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

/* -------------------------------------------------------------------------- */
/* Response shapes — hand-written mirrors of what `server/src/admin.ts` sends   */
/* -------------------------------------------------------------------------- */

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
