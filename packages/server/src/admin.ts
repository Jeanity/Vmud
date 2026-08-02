/**
 * The admin API — `/admin/api` on the game server's own HTTP listener.
 *
 * See `docs/DESIGN-admin-panel.md`. The rules that shape this file:
 *
 * - **The server is the only writer.** Every operation lands on the live simulation or on the
 *   `PlayerStore`'s own cached records, never on a file behind them — a file edited behind the
 *   running store is overwritten by its next flush.
 * - **Refusal over pretence.** An edit that cannot honestly take effect — a wound set on a character
 *   whose disconnect will overwrite it, a teleport for a character login does not place — is refused
 *   with a reason a person can read, not accepted and quietly discarded. Refusals are `409`.
 * - **This class is a pure router.** It maps a plain request shape to a plain response shape, with
 *   every capability that touches the live world injected through {@link LiveOps} — implemented in
 *   `index.ts`, the one file that cannot be unit-tested. What can be tested is here, and is.
 *
 * ## Auth
 *
 * Three layers, cheapest first (§3 of the design doc): the loopback bind this listener already has;
 * a mandatory `x-admin-token` header, whose *presence* is the point — a custom header forces any
 * cross-origin browser request into a CORS preflight, and nothing here grants CORS, so a hostile
 * web page cannot ride the operator's browser into this API; and `GAME_ADMIN_TOKEN`, checked when
 * set. Requests from non-loopback addresses are refused outright as belt and braces against a
 * future bind change.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname } from 'node:path';

import {
  AffectFlag,
  ROOM_FLAGS,
  SECTORS,
  UNLIMITED_DURATION,
  newAffect,
  placeKey,
  type Direction,
  type Place,
  type Room,
  type RoomFlag,
  type RoomId,
  type Sector,
  type ZoneId,
} from '@mygame/shared';
// A subpath import, as `vision.ts` is in `players.ts`: the catalogue is not in the package barrel.
import { LIGHT_SOURCES, lightSource, type LightSource } from '@mygame/shared/light.ts';

import { draftDescription, listModels, ollamaReachable } from './ollama.ts';
import { saveRoomOverrides } from './overrides.ts';
import { seenTileCount, slugify, type PlayerStore, type StoredSummary } from './players.ts';
import type { Player } from './sim.ts';
import type { GameWorld } from './world.ts';

/** The request as the router sees it: transport details already reduced to facts. */
export interface AdminRequest {
  readonly method: string;
  /** Path below `/admin/api`, query string already stripped. */
  readonly path: string;
  /** The `x-admin-token` header, when one was sent. */
  readonly token: string | undefined;
  /** The socket's remote address, for the loopback gate. */
  readonly remote: string | undefined;
  /** The parsed JSON body, when one was sent. */
  readonly body: unknown;
}

export interface AdminResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Everything the router may do to the *live* world, implemented beside the helpers it needs in
 * `index.ts`. Each of these owes the affected client its updates — a vitals change sends the new
 * `self` view and the room its health bar, a teleport runs the whole arrival — so the router never
 * has to know how the wire works.
 */
export interface LiveOps {
  /** Every connected player. */
  online(): readonly Player[];
  /** Applies already-clamped pool values, refreshes status, and tells the client. */
  setVitals(player: Player, pools: { hp?: number; mana?: number; move?: number }): void;
  /** The `GAME_DEV_LEVEL` rig, per character: profile, pools refilled, client told. */
  setLevel(player: Player, level: number): void;
  /** Hands over (or takes away, with `undefined`) a carried light through the sim's own seam. */
  setLight(player: Player, source: LightSource | undefined): void;
  /** Strips every affect and recomputes — `restoreAffects(player, [])`. */
  clearAffects(player: Player): void;
  /** Moves the character and runs the full arrival. False when the room has no floor to stand on. */
  teleport(player: Player, room: RoomId): boolean;
  /** One line to one player, marked as the operator's voice. */
  tell(player: Player, text: string): void;
  /** Closes the socket; the ordinary disconnect path does the bookkeeping. */
  kick(player: Player): void;
  /**
   * Publishes an authored room edit: saves the overlay, and re-sends what the change invalidated.
   *
   * Two different resyncs, because a room is two things to a client. Prose and flags are *description*
   * — anyone standing there gets the room re-described, and nobody else needs telling. A sector change
   * is *terrain*: it re-carves the tilemap, so everyone on the whole Place needs the `zone` message
   * again or their collision copy disagrees with the server's. `regrid` says which happened.
   */
  publishRoom(room: Room, place: Place, regrid: boolean): void;

  /* ---- reads ---------------------------------------------------------- */

  /**
   * Milliseconds until this zone's next repop, or undefined for one with no population at all.
   *
   * A read rather than an operation, and here rather than on `world` because it is *live* state: the
   * zone clock is a running countdown re-rolled from the zone's own band after every reset, and the
   * static world knows nothing about it. See `reset.ts`.
   */
  repopIn(zone: ZoneId): number | undefined;

  /** Who and what is standing in a room this instant, by name. For the room browser. */
  occupantsOf(room: RoomId): {
    readonly players: readonly string[];
    readonly mobs: readonly string[];
    readonly corpses: readonly string[];
  };
}

/** Who an operator's line is aimed at. See {@link AdminDeps.announce}. */
export type AnnounceScope =
  | { readonly kind: 'world' }
  /** Everyone standing on one {@link Place} — a zone at a level. */
  | { readonly kind: 'place'; readonly place: Place }
  | { readonly kind: 'room'; readonly room: RoomId };

export interface AdminDeps {
  readonly world: GameWorld;
  readonly store: PlayerStore;
  readonly live: LiveOps;
  /**
   * One line to whoever the scope names. Returns how many heard it.
   *
   * A scope rather than three functions because the three differ only in which set of players they
   * walk — and the count coming back is what makes an operator's *"did anyone get that"* answerable,
   * which matters far more for a room of one than for the world.
   */
  readonly announce: (text: string, scope: AnnounceScope) => number;
  /** `GAME_ADMIN_TOKEN`; undefined means any header value passes (the header itself is still required). */
  readonly token: string | undefined;
  /** Where the audit trail is appended, or undefined to keep it off disk (tests). */
  readonly auditFile: string | undefined;
  /**
   * Where authored room content is saved, or undefined to edit the live world without persisting.
   *
   * Same shape as {@link auditFile} and for the same reason: a unit test must be able to exercise the
   * editor without writing into the repository's real overlay. Defaults to `overrides.ts`'s own
   * constant in `index.ts`, so the loader and the writer share one path.
   */
  readonly overridesFile: string | undefined;
  /** Boot-time constants the dashboard reports. */
  readonly facts: {
    readonly protocol: number;
    readonly tickMs: number;
    readonly roundMs: number;
    readonly startedAt: number;
  };
}

/** Level bounds for the test rig — TorilMUD's own ceiling, and 0 is not a character. */
const LEVEL_MIN = 1;
const LEVEL_MAX = 60;

/** The longest line an operator may speak. Longer is a paste error, not a message. */
const TEXT_MAX = 300;

const PATCH_KEYS = new Set(['hp', 'mana', 'move', 'level', 'light', 'clearAffects', 'wound', 'healed']);

/**
 * What a builder may author on a room. **Geometry is deliberately absent** — see `authorRoom`.
 *
 * A closed list rather than a filter, because the failure mode of the open version is silent: a
 * panel that posts `pos` and gets a 200 back has told its operator the room moved.
 */
const ROOM_PATCH_KEYS = new Set(['name', 'description', 'sector', 'flags', 'by', 'brief']);

/** Fields the panel may record about a draft, but which are not themselves authored content. */
const ROOM_META_KEYS = new Set(['by', 'brief']);

/** Bounds on authored prose. A room name is a line; a description is a paragraph or three. */
const ROOM_NAME_MAX = 120;
const ROOM_PROSE_MAX = 4000;

/**
 * How far the neighbourhood shown beside a room reaches, and how much of it is kept.
 *
 * Two hops because a corner's neighbours are often other corners — the room that actually describes
 * the place can be a step past the ones touching it. Twelve because a castle hub reaches twenty in
 * two steps and past a handful this stops being context and becomes something the author has to read.
 */
const NEARBY_HOPS = 2;
const NEARBY_MAX = 12;

/**
 * How much of the neighbourhood the *model* is shown, and how many style examples it gets.
 *
 * Fewer neighbours than the panel displays: an author skims twelve rooms and takes what is useful,
 * whereas a model given twelve adjacent descriptions writes a summary of the wing rather than a room
 * in it. Four is enough to fix what the place is without drowning the brief.
 *
 * Three samples because that is where few-shot stops paying: a fourth example of the same voice adds
 * little, and every one of them is ~115 words of context competing with the instruction at the end.
 */
const NEARBY_IN_PROMPT = 4;
const SAMPLE_COUNT = 3;

/** A brief is a few words. Longer is prose the author should simply write themselves. */
const BRIEF_MAX = 400;

/** One room in the neighbourhood shown beside the editor. See `AdminApi.neighbourhood`. */
interface NearbyRoom {
  readonly id: number;
  readonly hops: number;
  readonly dir: string | null;
  readonly name: string;
  readonly sector: string;
  readonly description: string | null;
  /** False for a room read from a zone this server does not run — good context, not reachable. */
  readonly loaded: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export class AdminApi {
  private readonly deps: AdminDeps;

  constructor(deps: AdminDeps) {
    this.deps = deps;
    if (deps.auditFile) mkdirSync(dirname(deps.auditFile), { recursive: true });
  }

  /**
   * The whole API, including the two routes that cannot answer immediately.
   *
   * **`route` is synchronous and stays that way.** Every operation on the world is a function call
   * against objects already in memory, and making 30 endpoints `async` to accommodate two would make
   * every test `await` something that never waits. Drafting prose is the exception in kind, not in
   * degree: it is an HTTP call to a model that may spend half a minute loading weights. So it lives
   * on this path, and everything else falls through to the sync router unchanged.
   *
   * The gate runs here too, before the fall-through — an async route must not be reachable without it.
   */
  async routeAsync(request: AdminRequest): Promise<AdminResponse> {
    const refused = this.gate(request);
    if (refused) return refused;

    const parts = request.path.split('/').filter((p) => p.length > 0);
    const [head, slug, action] = parts;

    if (head === 'ollama' && parts.length === 1 && request.method === 'GET') return this.ollama();
    if (head === 'rooms' && slug !== undefined && action === 'describe' && parts.length === 3 && request.method === 'POST') {
      return this.describe(slug, request.body);
    }
    return this.route(request);
  }

  route(request: AdminRequest): AdminResponse {
    const refused = this.gate(request);
    if (refused) return refused;

    const parts = request.path.split('/').filter((p) => p.length > 0);
    const [head, slug, action] = parts;

    if (head === 'status' && parts.length === 1 && request.method === 'GET') return this.status();
    if (head === 'rooms' && parts.length === 1 && request.method === 'GET') return this.rooms();
    if (head === 'zones' && parts.length === 1 && request.method === 'GET') return this.zones();
    if (head === 'zones' && slug !== undefined && action === 'rooms' && parts.length === 3 && request.method === 'GET') {
      return this.zoneRooms(slug);
    }
    if (head === 'rooms' && slug !== undefined && parts.length === 2) {
      if (request.method === 'GET') return this.room(slug);
      if (request.method === 'PATCH') return this.authorRoom(slug, request.body);
    }
    if (head === 'announce' && parts.length === 1 && request.method === 'POST') {
      return this.announce(request.body);
    }
    if (head === 'players' && parts.length === 1 && request.method === 'GET') return this.roster();
    if (head === 'players' && slug !== undefined && parts.length === 2) {
      if (request.method === 'GET') return this.player(slug);
      if (request.method === 'PATCH') return this.patch(slug, request.body);
      if (request.method === 'DELETE') return this.delete(slug);
    }
    if (head === 'players' && slug !== undefined && action !== undefined && parts.length === 3 && request.method === 'POST') {
      if (action === 'teleport') return this.teleport(slug, request.body);
      if (action === 'tell') return this.tell(slug, request.body);
      if (action === 'kick') return this.kick(slug);
      if (action === 'reset-pickups') return this.resetPickups(slug);
    }
    return { status: 404, body: { error: `no such admin route: ${request.method} ${request.path}` } };
  }

  /* ------------------------------------------------------------------------ */
  /* Auth                                                                      */
  /* ------------------------------------------------------------------------ */

  private gate(request: AdminRequest): AdminResponse | undefined {
    if (!request.remote || !LOOPBACK.has(request.remote)) {
      return { status: 403, body: { error: 'admin is loopback-only' } };
    }
    if (typeof request.token !== 'string') {
      // Present before correct: the header is the CSRF defence, the value is only the lock.
      return { status: 401, body: { error: 'x-admin-token header required' } };
    }
    if (this.deps.token !== undefined && request.token !== this.deps.token) {
      return { status: 401, body: { error: 'bad admin token' } };
    }
    return undefined;
  }

  /* ------------------------------------------------------------------------ */
  /* Reads                                                                     */
  /* ------------------------------------------------------------------------ */

  private status(): AdminResponse {
    const { world, live, facts } = this.deps;
    const spawn = world.spawnRoom();
    return {
      status: 200,
      body: {
        ok: true,
        startedAt: facts.startedAt,
        uptimeMs: Date.now() - facts.startedAt,
        protocol: facts.protocol,
        tickMs: facts.tickMs,
        roundMs: facts.roundMs,
        playersOnline: live.online().length,
        places: world.allPlaces().length,
        spawn: { room: spawn.id, name: spawn.name },
        zones: world.allZones().map((zone) => ({
          id: zone.id,
          name: zone.name,
          rooms: zone.rooms.length,
          levels: world.levelsOf(zone.id),
          populated: world.populate.includes(zone.id),
        })),
        // The catalogue, for the grant-light picker. Code, not data — see the items section of the
        // design doc — so shipping it read-only here is the honest whole of "items" today.
        lights: Object.values(LIGHT_SOURCES).map((source) => ({
          id: source.id,
          name: source.name,
          radius: source.radius,
          mode: source.mode,
          durationMs: source.durationMs ?? null,
        })),
        token: this.deps.token === undefined ? 'open (loopback only)' : 'required',
      },
    };
  }

  private rooms(): AdminResponse {
    const { world } = this.deps;
    const rooms = world.allZones().flatMap((zone) =>
      zone.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        zone: zone.id,
        zoneName: zone.name,
        level: room.pos.z,
      })),
    );
    rooms.sort((a, b) => (a.zone - b.zone) || (a.id - b.id));
    return { status: 200, body: { rooms } };
  }

  /* ------------------------------------------------------------------------ */
  /* Zones — A3, read-only                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Every loaded zone, with its live repop clock.
   *
   * The clock is the half that cannot come from the world files: it is re-rolled from the zone's own
   * band after each reset, so *when the next one is due* is a fact about this run. A zone with no
   * population file reports `null` rather than 0 — "never repops" and "repops now" are opposite
   * things and a dash beats a zero.
   */
  private zones(): AdminResponse {
    const { world, live } = this.deps;
    return {
      status: 200,
      body: {
        zones: world.allZones().map((zone) => {
          const levels = world.levelsOf(zone.id);
          const repopInMs = live.repopIn(zone.id);
          return {
            id: zone.id,
            name: zone.name,
            rooms: zone.rooms.length,
            levels,
            populated: world.populate.includes(zone.id),
            repopInMs: repopInMs ?? null,
            entryRoom: zone.entryRoom,
            // Two counts worth having at a glance, because both are things the harvest only
            // *partly* supplies and the gap is the interesting part: how much of this zone has real
            // prose, and how much carries a flag. See Phase 3's measured yield.
            described: zone.rooms.filter((room) => room.description).length,
            flagged: zone.rooms.filter((room) => (room.flags?.length ?? 0) > 0).length,
          };
        }),
      },
    };
  }

  /** Every room of one zone, summarised — the browser's middle column. */
  private zoneRooms(slug: string): AdminResponse {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not a zone id` } };
    const zone = this.deps.world.zone(id as ZoneId);
    if (!zone) return { status: 404, body: { error: `zone ${id} is not loaded` } };

    return {
      status: 200,
      body: {
        zone: { id: zone.id, name: zone.name },
        rooms: zone.rooms.map((room) => ({
          id: room.id,
          name: room.name,
          level: room.pos.z,
          // **The map's whole input.** Worldgen normalises coordinates per zone, so these are small
          // integers on that zone's own grid — level 9 of IceCrag is 110 rooms inside 13x14 — and a
          // spatial view is a direct drawing of them rather than a layout problem. See A4b.
          x: room.pos.x,
          y: room.pos.y,
          sector: room.sector,
          flags: room.flags ?? [],
          // Destinations as well as directions, because the map cannot assume east means the cell to
          // the right: a cross-zone exit or a staircase leads off this grid entirely, and drawing it
          // as a neighbour line would assert an adjacency the world does not have — decision 1 in
          // `HANDOFF.md`, in its smallest form.
          exits: Object.entries(room.exits).map(([dir, exit]) => ({ dir, to: exit.to })),
          described: Boolean(room.description),
          // So the map can mark authored rooms at a glance — which is the only way to find your own
          // work again in a 219-room zone.
          authored: this.deps.world.overrides.has(room.id),
          // Live, and the reason the browser is worth having open while testing: it says where the
          // population actually *is* rather than where the reset table meant to put it.
          occupants: this.deps.live.occupantsOf(room.id),
        })),
      },
    };
  }

  /**
   * The rooms around this one, with their prose — the context you cannot write without.
   *
   * **The case that demands it** (owner, 2026-08-02): "Southwestern Corner Of the Banquet Hall" is
   * one of three IceCrag rooms with no description, and its name is nearly all you have. Whether it
   * is a corner of a hall laid for a feast or a corner of a hall in ruins is not in the name, is not
   * in the sector, and is not recoverable by thinking harder — it is in the room next door. An author
   * given only the room they are editing writes something plausible and wrong, and a model given only
   * the room they are editing does the same thing faster.
   *
   * Two hops rather than one, because a corner's neighbours are frequently other corners: the
   * Southwestern Corner's neighbour may be the Southern Wall, and the hall itself a step beyond it.
   * Two is where the prose usually starts. Bounded at {@link NEARBY_MAX} because a hub room in a
   * castle can reach twenty in two steps, and past a handful this stops being context and becomes a
   * wall — the author has to read it.
   *
   * Breadth-first, so what comes back is ordered by *nearness*, which is also the order of relevance:
   * a truncated list keeps the adjacent rooms and drops the far ones, which is the right thing to
   * lose. Rooms with prose come first at equal distance, since a described neighbour is the only kind
   * that carries information — an undescribed one contributes its name and nothing else.
   *
   * This is also, deliberately, the shape the Ollama slice needs: prompt context is exactly "what do
   * the rooms around this one say", and building it here means the panel and the generator read the
   * same neighbourhood rather than two subtly different ones.
   */
  private neighbourhood(room: Room): readonly NearbyRoom[] {
    const seen = new Set<RoomId>([room.id]);
    const out: NearbyRoom[] = [];
    // `dir` is the *first* step taken to reach a room, which is what an author reads as "north of
    // here". Beyond one hop there is no single direction, so it is carried forward rather than
    // recomputed — "two rooms off to the north" is true and useful; a second bearing would not be.
    let frontier: { id: RoomId; dir: string | null }[] = [{ id: room.id, dir: null }];

    for (let hops = 1; hops <= NEARBY_HOPS; hops++) {
      const next: { id: RoomId; dir: string | null }[] = [];
      const reached: NearbyRoom[] = [];
      for (const step of frontier) {
        // **`referenceRoom`, not `locate` — the walk crosses zone boundaries.** IceCrag's staircases
        // lead into zone 219, which this server does not run, and stopping there would leave every
        // room at the top of a stair with no context in the one direction that has any. The rooms
        // are on disk; not playing a zone is a different thing from not knowing what is in it.
        const here = this.deps.world.referenceRoom(step.id);
        if (!here) continue;
        for (const [dir, exit] of Object.entries(here.exits)) {
          if (seen.has(exit.to)) continue;
          seen.add(exit.to);
          const found = this.deps.world.referenceRoom(exit.to);
          if (!found) continue;
          const from = step.dir ?? dir;
          next.push({ id: exit.to, dir: from });
          reached.push({
            id: found.id,
            hops,
            dir: from,
            name: found.name,
            sector: found.sector,
            description: found.description ?? null,
            // Said plainly, because it changes what the room *is*: prose from an unplayed zone is
            // still good context for writing, but a player cannot walk there today.
            loaded: this.deps.world.locate(found.id) !== undefined,
          });
        }
      }
      // Described first *within* this ring, never across rings: nearness outranks prose, because a
      // silent room next door still tells you where you are.
      reached.sort((a, b) => Number(Boolean(b.description)) - Number(Boolean(a.description)));
      out.push(...reached);
      if (out.length >= NEARBY_MAX) break;
      frontier = next;
    }
    return out.slice(0, NEARBY_MAX);
  }

  /** One room in full: its prose, its flags, and the live state of every way out of it. */
  private room(slug: string): AdminResponse {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not a room id` } };
    const located = this.deps.world.locate(id as RoomId);
    if (!located) return { status: 404, body: { error: `no room ${id} in the loaded world` } };
    const { room, place } = located;

    return {
      status: 200,
      body: {
        id: room.id,
        name: room.name,
        zone: room.zone,
        place: placeKey(place),
        pos: room.pos,
        sector: room.sector,
        flags: room.flags ?? [],
        // Absent rather than empty for a room the harvest never reached — 5,889 of 46,508 carry
        // prose, so "no description" is the ordinary case and should read as one.
        description: room.description ?? null,
        // Which of the fields above are hand-authored rather than harvested, so the editor can offer
        // to revert exactly those and no others. Null for an untouched room.
        authored: this.deps.world.overrides.get(room.id) ?? null,
        // **The neighbourhood, with its prose.** See {@link neighbourhood}.
        nearby: this.neighbourhood(room),
        occupants: this.deps.live.occupantsOf(room.id),
        exits: Object.entries(room.exits).map(([dir, exit]) => {
          const destination = this.deps.world.locate(exit.to);
          // **Door state is live**, mutated by `open`/`close` and put back by the zone reset — which
          // is exactly why it belongs in a panel rather than in the world files: this says whether
          // the castle's front door is standing open *right now*.
          const door = this.deps.world.doorway(room.id, dir as Direction)?.near.door;
          // **An exit off the loaded world still goes somewhere, and the room is on disk.** `up` and
          // `down` out of IceCrag lead into zone 219, "IceCrag Castle - Lower Level", a separate
          // zone file not in `world.config.json` — so every staircase in the castle used to report
          // `(not loaded)` and nothing else. It reports the actual room now, named and described,
          // because not *playing* a zone is a different thing from not knowing what is in it.
          const beyond = destination ? undefined : this.deps.world.referenceRoom(exit.to);
          const zone = destination ? undefined : this.deps.world.zoneOf(exit.to);
          return {
            dir,
            to: exit.to,
            toName: destination?.room.name ?? beyond?.name ?? null,
            portal: Boolean(exit.portal),
            // Null when the destination *is* loaded — the room name already says everything, and a
            // zone label on every local exit would be noise on 99% of them.
            toZone:
              destination || zone === undefined
                ? null
                : { id: zone, name: this.deps.world.zoneName(zone) ?? `zone ${zone}` },
            loaded: destination !== undefined,
            door: door
              ? { name: door.name, closed: Boolean(door.closed), locked: Boolean(door.locked) }
              : null,
          };
        }),
      },
    };
  }

  private roster(): AdminResponse {
    const online = this.deps.live.online().map((player) => this.liveView(player));
    const onlineSlugs = new Set(online.map((view) => view.slug));
    // The record half of a connected character is owned by the live session — see `patch` — so the
    // roster's "stored" list is the characters who are *only* on disk.
    const stored = this.deps.store.list().filter((summary) => !onlineSlugs.has(summary.slug));
    return { status: 200, body: { online, stored } };
  }

  private player(slug: string): AdminResponse {
    const online = this.findOnline(slug);
    const summary = this.deps.store.list().find((s) => s.slug === slug);
    if (!online && !summary) return { status: 404, body: { error: `no character "${slug}"` } };

    const name = online?.name ?? summary!.name;
    const record = this.deps.store.load(name);
    return {
      status: 200,
      body: {
        slug,
        name,
        online: online !== undefined,
        ...(online ? { live: this.liveView(online) } : {}),
        record: {
          savedAt: summary?.savedAt ?? null,
          lastRoom: this.roomRef(record.lastRoom),
          seenPlaces: record.seen.size,
          seenTiles: seenTileCount(record),
          takenCount: record.taken.size,
          level: record.progress?.level ?? null,
          experience: record.progress?.experience ?? null,
          wound: record.missing ?? null,
          affects: record.affects.map((affect) => ({
            type: affect.type,
            apply: affect.apply,
            modifier: affect.modifier,
            durationMs: affect.durationMs === UNLIMITED_DURATION ? null : affect.durationMs,
            context: affect.context ?? null,
          })),
        },
      },
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Drafting prose with a local model                                         */
  /* ------------------------------------------------------------------------ */

  /** What Ollama has, for the picker. An empty list is "not running", not an error. */
  private async ollama(): Promise<AdminResponse> {
    const models = await listModels();
    return {
      status: 200,
      body: {
        reachable: models.length > 0 || (await ollamaReachable()),
        models: models.map((model) => ({ name: model.name, size: model.size, parameters: model.parameters })),
      },
    };
  }

  /**
   * Drafts a description for one room. **Saves nothing.**
   *
   * The draft comes back to the editor's box, where it can be read, rewritten, coloured or discarded,
   * and only the ordinary `PATCH` writes it. That order is the point: unreviewed machine prose must
   * never be the thing already in the world, and *not* keeping a draft must be the cheap path.
   *
   * Everything the model is shown is assembled here rather than in the panel, so the prompt cannot
   * drift between what an operator sees and what is actually sent — and so the same context the
   * editor already displays is the context the model gets.
   */
  private async describe(slug: string, body: unknown): Promise<AdminResponse> {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not a room id` } };
    const located = this.deps.world.locate(id as RoomId);
    if (!located) return { status: 404, body: { error: `no room ${id} in the loaded world` } };

    if (typeof body !== 'object' || body === null) return { status: 400, body: { error: 'expected a JSON object' } };
    const { model, brief } = body as { model?: unknown; brief?: unknown };
    if (typeof model !== 'string' || !model.trim()) {
      return { status: 400, body: { error: 'model is required — GET /ollama lists what is installed' } };
    }
    if (typeof brief !== 'string' || !brief.trim()) {
      // Refused rather than defaulted, because a brief is the one thing only the author knows. A
      // model given the room name alone writes the name back at you in seven sentences.
      return { status: 400, body: { error: 'a brief is required — a few words, e.g. "forest by a stream"' } };
    }
    if (brief.length > BRIEF_MAX) return { status: 400, body: { error: `brief must be at most ${BRIEF_MAX} characters` } };

    const { room } = located;
    const result = await draftDescription({
      model: model.trim(),
      brief: brief.trim(),
      room: {
        name: room.name,
        sector: room.sector,
        zone: this.deps.world.zoneName(room.zone) ?? `zone ${room.zone}`,
      },
      nearby: this.neighbourhood(room)
        .filter((near) => near.description)
        .slice(0, NEARBY_IN_PROMPT)
        .map((near) => ({ name: near.name, description: near.description!, dir: near.dir })),
      samples: this.styleSamples(room),
    });

    if (!result.ok) {
      // 502, not 500: the failure is a service this server talks to, and the distinction matters to
      // whoever reads it — the panel is fine, the model is not.
      return { status: 502, body: { error: result.error } };
    }
    this.audit('room.draft', { room: id, model: result.model, brief: brief.trim(), ms: result.ms });
    return {
      status: 200,
      body: { description: result.description, model: result.model, brief: brief.trim(), ms: result.ms },
    };
  }

  /**
   * Real descriptions from the same zone, to show the model the style rather than describe it.
   *
   * **Spread across the zone rather than taken from beside the room.** The neighbours are already in
   * the prompt doing a different job — they constrain the *content* — and re-using them as style
   * examples would show the model three rooms that all describe the same hall and invite it to write
   * a fourth. Sampling at intervals through the zone's described rooms gives it the range of the
   * style instead: a corridor, a courtyard, a chamber.
   *
   * Deterministically chosen, so pressing the button twice varies by the model's own sampling and not
   * by which examples it happened to get — otherwise a worse second draft tells you nothing about
   * whether to try a third. Longest-first within the pick, because a 51-word room demonstrates less
   * of the voice than a 130-word one, and the median is 115.
   */
  private styleSamples(room: Room): readonly { name: string; description: string }[] {
    const zone = this.deps.world.zone(room.zone);
    if (!zone) return [];
    const described = zone.rooms.filter((candidate) => candidate.description && candidate.id !== room.id);
    if (described.length === 0) return [];

    const step = Math.max(1, Math.floor(described.length / SAMPLE_COUNT));
    const picked: Room[] = [];
    for (let i = 0; i < described.length && picked.length < SAMPLE_COUNT; i += step) picked.push(described[i]!);
    return picked
      .sort((a, b) => (b.description?.length ?? 0) - (a.description?.length ?? 0))
      .map((candidate) => ({ name: candidate.name, description: candidate.description! }));
  }

  /* ------------------------------------------------------------------------ */
  /* Writes — authored world content (A5)                                      */
  /* ------------------------------------------------------------------------ */

  /**
   * Rewrites a room's authored content: its name, its prose, its terrain, its flags.
   *
   * **Four fields, and the omissions are the design.** A room's id, position and exits are geometry —
   * the join key into every data source we have, and the grid the tilemap is carved from — so they are
   * refused here rather than quietly ignored, and they belong to A8 with its own decisions in front of
   * it. Everything accepted is *description*, which is what a builder actually writes.
   *
   * `null` is how a field is *unauthored*, and it is not the same as `""`: an empty description is a
   * room deliberately left blank, whereas null drops the override and lets the harvest show through
   * again. That distinction is the whole of "revert" and costs one branch.
   */
  private authorRoom(slug: string, body: unknown): AdminResponse {
    const id = Number(slug);
    if (!Number.isInteger(id)) return { status: 400, body: { error: `"${slug}" is not a room id` } };
    const located = this.deps.world.locate(id as RoomId);
    if (!located) return { status: 404, body: { error: `no room ${id} in the loaded world` } };

    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    }
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    for (const key of keys) {
      if (!ROOM_PATCH_KEYS.has(key)) {
        return {
          status: 400,
          body: {
            error:
              `"${key}" is not authorable — one of: ${[...ROOM_PATCH_KEYS].join(', ')}. ` +
              `A room's id, position and exits are geometry, not content.`,
          },
        };
      }
    }

    // Validated whole before anything is written, so an edit either lands or does not.
    const next: {
      name?: string;
      description?: string;
      sector?: Sector;
      flags?: readonly RoomFlag[];
      by?: string;
      brief?: string;
    } = {};
    const cleared: string[] = [];

    // Provenance rides along with a save rather than being written at generation time, because the
    // draft is only ever *offered* — nothing is authored until a person presses Save, and recording
    // "written by qwen2.5:14b" against prose that was then rejected would be a lie about the world.
    for (const key of ROOM_META_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === null) cleared.push(key);
      else if (typeof value !== 'string') return { status: 400, body: { error: `${key} must be a string or null` } };
      else next[key as 'by' | 'brief'] = value.slice(0, BRIEF_MAX);
    }

    if (patch.name !== undefined) {
      if (patch.name === null) cleared.push('name');
      else if (typeof patch.name !== 'string' || !patch.name.trim()) {
        return { status: 400, body: { error: 'name must be a non-empty string, or null to unauthor it' } };
      } else if (patch.name.length > ROOM_NAME_MAX) {
        return { status: 400, body: { error: `name must be at most ${ROOM_NAME_MAX} characters` } };
      } else next.name = patch.name.trim();
    }
    if (patch.description !== undefined) {
      if (patch.description === null) cleared.push('description');
      else if (typeof patch.description !== 'string') {
        return { status: 400, body: { error: 'description must be a string, or null to unauthor it' } };
      } else if (patch.description.length > ROOM_PROSE_MAX) {
        return { status: 400, body: { error: `description must be at most ${ROOM_PROSE_MAX} characters` } };
      } else next.description = patch.description;
    }
    if (patch.sector !== undefined) {
      if (patch.sector === null) cleared.push('sector');
      else if (typeof patch.sector !== 'string' || !(SECTORS as readonly string[]).includes(patch.sector)) {
        return { status: 400, body: { error: `sector must be one of: ${SECTORS.join(', ')}` } };
      } else next.sector = patch.sector as Sector;
    }
    if (patch.flags !== undefined) {
      if (patch.flags === null) cleared.push('flags');
      else if (!Array.isArray(patch.flags)) {
        return { status: 400, body: { error: 'flags must be an array' } };
      } else {
        const bad = patch.flags.filter((f) => typeof f !== 'string' || !(ROOM_FLAGS as readonly string[]).includes(f));
        if (bad.length > 0) {
          return { status: 400, body: { error: `unknown flags ${JSON.stringify(bad)} — one of: ${ROOM_FLAGS.join(', ')}` } };
        }
        next.flags = [...new Set(patch.flags as RoomFlag[])];
      }
    }

    // **Read before anything moves.** Whether the tilemap must be re-carved is decided by comparing
    // the room's terrain across the *whole* operation, not by asking what the patch requested — a
    // revert restores a sector without setting one, and a patch-shaped test calls that no change
    // while the terrain has in fact changed back. See `GameWorld.dropGrid`.
    const sectorBefore = located.room.sector;

    // Clearing is a different operation from patching — it removes keys rather than setting them —
    // so it runs against the stored override before the patch is merged over the top.
    if (cleared.length > 0) this.deps.world.revertRoom(id as RoomId, cleared);

    const applied = this.deps.world.authorRoom(id as RoomId, next, new Date().toISOString());
    if (!applied) return { status: 404, body: { error: `no room ${id} in the loaded world` } };
    if (this.deps.overridesFile) saveRoomOverrides(this.deps.world.overrides, this.deps.overridesFile);

    const regrid = applied.room.sector !== sectorBefore;
    if (regrid) this.deps.world.dropGrid(applied.place);
    this.deps.live.publishRoom(applied.room, applied.place, regrid);

    this.audit('room.author', { room: id, fields: keys, cleared, regrid });
    return {
      status: 200,
      body: {
        ok: true,
        room: { id: applied.room.id, name: applied.room.name, sector: applied.room.sector },
        regrid,
        authored: this.deps.world.overrides.get(id as RoomId) ?? null,
      },
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Writes                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * The one mutating verb on a character's own state. Which half it lands on is decided by whether
   * they are connected, and the split is enforced rather than smoothed over: at disconnect the live
   * character overwrites the record (`rememberAffects`/`rememberVitals` in `index.ts`), so a
   * record-side edit under a live session would be accepted and then silently discarded — the exact
   * shape of bug an admin tool exists to not have.
   */
  private patch(slug: string, body: unknown): AdminResponse {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return { status: 400, body: { error: 'PATCH body must be a JSON object' } };
    }
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length === 0) return { status: 400, body: { error: 'empty patch' } };
    for (const key of keys) {
      if (!PATCH_KEYS.has(key)) {
        return { status: 400, body: { error: `unknown field "${key}" — one of: ${[...PATCH_KEYS].join(', ')}` } };
      }
    }

    // Validated before anything is applied, so a patch either happens or does not — half-applied
    // edits are worse than refused ones.
    if (patch.light !== undefined && patch.light !== null) {
      if (typeof patch.light !== 'string' || !lightSource(patch.light)) {
        return {
          status: 400,
          body: { error: `unknown light "${String(patch.light)}" — one of: ${Object.keys(LIGHT_SOURCES).join(', ')}` },
        };
      }
    }
    for (const pool of ['hp', 'mana', 'move'] as const) {
      const value = patch[pool];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        return { status: 400, body: { error: `${pool} must be a finite number` } };
      }
    }
    if (patch.level !== undefined) {
      const level = patch.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < LEVEL_MIN || level > LEVEL_MAX) {
        return { status: 400, body: { error: `level must be an integer in [${LEVEL_MIN}..${LEVEL_MAX}]` } };
      }
    }

    const online = this.findOnline(slug);
    if (online) return this.patchLive(slug, online, patch);
    return this.patchStored(slug, patch);
  }

  private patchLive(slug: string, player: Player, patch: Record<string, unknown>): AdminResponse {
    if (patch.wound !== undefined) {
      return {
        status: 409,
        body: { error: `${player.name} is online — the live pools are the truth; set hp/mana/move instead` },
      };
    }
    const applied: Record<string, unknown> = {};

    // Level first: it moves the maxima the pool clamps below read off the mutated player.
    if (patch.level !== undefined) {
      this.deps.live.setLevel(player, patch.level as number);
      applied.level = patch.level;
    }
    if (patch.clearAffects === true) {
      this.deps.live.clearAffects(player);
      applied.clearAffects = true;
    }
    if (patch.light !== undefined) {
      const source = patch.light === null ? undefined : lightSource(patch.light as string);
      this.deps.live.setLight(player, source);
      applied.light = patch.light;
    }
    if (patch.healed === true) {
      this.deps.live.setVitals(player, { hp: player.maxHp, mana: player.maxMana, move: player.maxMove });
      applied.healed = true;
    }
    const pools: { hp?: number; mana?: number; move?: number } = {};
    // Hit points clamp at 1, not the death floor: an admin-induced dying window would enter the
    // mercy and engagement machinery from a path no design covers, and what death costs is still
    // Phase 13's open question. When that is decided, this is the one line to change.
    if (typeof patch.hp === 'number') pools.hp = Math.min(Math.max(1, Math.round(patch.hp)), player.maxHp);
    if (typeof patch.mana === 'number') pools.mana = Math.min(Math.max(0, Math.round(patch.mana)), player.maxMana);
    if (typeof patch.move === 'number') pools.move = Math.min(Math.max(0, Math.round(patch.move)), player.maxMove);
    if (pools.hp !== undefined || pools.mana !== undefined || pools.move !== undefined) {
      this.deps.live.setVitals(player, pools);
      Object.assign(applied, pools);
    }

    this.audit('patch', { slug, online: true, ...applied });
    return this.player(slug);
  }

  private patchStored(slug: string, patch: Record<string, unknown>): AdminResponse {
    const summary = this.deps.store.list().find((s) => s.slug === slug);
    if (!summary) return { status: 404, body: { error: `no character "${slug}"` } };

    for (const pool of ['hp', 'mana', 'move'] as const) {
      if (patch[pool] !== undefined) {
        return {
          status: 409,
          body: { error: `${summary.name} is offline — pools are stored as the wound; PATCH {"wound":{...}} instead` },
        };
      }
    }
    const record = this.deps.store.load(summary.name);
    const applied: Record<string, unknown> = {};

    if (patch.level !== undefined) {
      // Real since 2026-08-02, the owner's rule: the number on the file is the character's level,
      // and login derives the rest from it (`restoreProgress` in `index.ts`). Experience is kept
      // as it was — a level edit is not an opinion about what they have earned.
      this.deps.store.setProgress(record, patch.level as number, record.progress?.experience ?? 0);
      applied.level = patch.level;
    }
    if (patch.wound !== undefined) {
      const wound = patch.wound;
      if (wound !== null && (typeof wound !== 'object' || Array.isArray(wound))) {
        return { status: 400, body: { error: 'wound must be {hp?,mana?,move?} or null' } };
      }
      this.deps.store.setWound(record, wound === null ? undefined : (wound as { hp?: number }));
      applied.wound = record.missing ?? null;
    }
    if (patch.healed === true) {
      this.deps.store.setWound(record, undefined);
      applied.healed = true;
    }
    if (patch.clearAffects === true) {
      this.deps.store.setAffects(record, []);
      applied.clearAffects = true;
    }
    if (patch.light !== undefined) {
      // The pre-v9 migration's own shape (`players.ts`), which is what makes it certain to load: a
      // fresh grant carries the catalogue's full burn, an extinguish is simply no light row at all.
      const keep = record.affects.filter((affect) => affect.type !== 'light');
      if (patch.light !== null) {
        const source = lightSource(patch.light as string)!;
        keep.push(
          newAffect({
            type: 'light',
            durationMs: source.durationMs ?? UNLIMITED_DURATION,
            apply: 'light',
            flags: AffectFlag.NoShow,
            context: source.id,
          }),
        );
      }
      this.deps.store.setAffects(record, keep);
      applied.light = patch.light;
    }

    if (Object.keys(applied).length === 0) {
      return { status: 400, body: { error: 'nothing in that patch applies to an offline character' } };
    }
    // Immediately, not on the debounce: the operator is looking at the file's truth right now.
    this.deps.store.flush(record);
    this.audit('patch', { slug, online: false, ...applied });
    return this.player(slug);
  }

  private teleport(slug: string, body: unknown): AdminResponse {
    const room = (body as { room?: unknown } | null)?.room;
    if (typeof room !== 'number' || !Number.isInteger(room)) {
      return { status: 400, body: { error: 'body must be {"room": <id>}' } };
    }
    const located = this.deps.world.locate(room as RoomId);
    if (!located) return { status: 400, body: { error: `no room ${room} in the loaded world` } };

    const player = this.findOnline(slug);
    if (!player) {
      // Offline is a real move since 2026-08-02: login returns a character to `lastRoom`, so
      // writing it is exactly "they will be standing there when they next log in".
      const summary = this.deps.store.list().find((s) => s.slug === slug);
      if (!summary) return { status: 404, body: { error: `no character "${slug}"` } };
      const record = this.deps.store.load(summary.name);
      const from = record.lastRoom;
      this.deps.store.setLastRoom(record, room as RoomId);
      this.deps.store.flush(record);
      this.audit('teleport', { slug, online: false, from: from ?? null, to: room, place: placeKey(located.place) });
      return this.player(slug);
    }

    const from = player.roomId;
    if (!this.deps.live.teleport(player, room as RoomId)) {
      return { status: 400, body: { error: `room ${room} has no floor to stand on` } };
    }
    this.audit('teleport', { slug, from, to: room, place: placeKey(located.place) });
    return this.player(slug);
  }

  private tell(slug: string, body: unknown): AdminResponse {
    const player = this.findOnline(slug);
    if (!player) return { status: 409, body: { error: `"${slug}" is not online — a tell needs a reader` } };
    const text = cleanLine((body as { text?: unknown } | null)?.text);
    if (!text) return { status: 400, body: { error: `body must be {"text": "..."} (max ${TEXT_MAX} chars)` } };
    this.deps.live.tell(player, text);
    this.audit('tell', { slug, text });
    return { status: 200, body: { ok: true } };
  }

  private kick(slug: string): AdminResponse {
    const player = this.findOnline(slug);
    if (!player) return { status: 409, body: { error: `"${slug}" is not online` } };
    this.deps.live.kick(player);
    this.audit('kick', { slug });
    return { status: 200, body: { ok: true } };
  }

  private resetPickups(slug: string): AdminResponse {
    const online = this.findOnline(slug);
    const summary = this.deps.store.list().find((s) => s.slug === slug);
    if (!online && !summary) return { status: 404, body: { error: `no character "${slug}"` } };
    const record = this.deps.store.load(online?.name ?? summary!.name);
    const cleared = this.deps.store.clearTaken(record);
    if (cleared > 0) this.deps.store.flush(record);
    this.audit('reset-pickups', { slug, cleared });
    return { status: 200, body: { ok: true, cleared } };
  }

  private delete(slug: string): AdminResponse {
    const online = this.findOnline(slug);
    if (online) {
      // The disconnect path writes the whole record back; a file deleted under it resurrects.
      return { status: 409, body: { error: `${online.name} is online — kick them first, then delete` } };
    }
    const summary = this.deps.store.list().find((s) => s.slug === slug);
    if (!summary) return { status: 404, body: { error: `no character "${slug}"` } };
    this.deps.store.delete(summary.name);
    this.audit('delete', { slug });
    return { status: 200, body: { ok: true } };
  }

  /**
   * An operator speaking: world-wide by default, or narrowed with `room` or `place`.
   *
   * One endpoint with an optional target rather than three, because the audit line, the validation and
   * the "how many heard it" answer are identical for all three and only the set of listeners differs.
   * Naming both at once is refused rather than resolved by precedence — an operator who typed both
   * meant one of them, and guessing which sends a line to the wrong people.
   */
  private announce(body: unknown): AdminResponse {
    const raw = (body ?? {}) as { text?: unknown; room?: unknown; place?: unknown };
    const text = cleanLine(raw.text);
    if (!text) return { status: 400, body: { error: `body must be {"text": "..."} (max ${TEXT_MAX} chars)` } };
    if (raw.room !== undefined && raw.place !== undefined) {
      return { status: 400, body: { error: 'name a room or a place, not both' } };
    }

    let scope: AnnounceScope = { kind: 'world' };
    let where = 'the world';

    if (raw.room !== undefined) {
      if (typeof raw.room !== 'number' || !Number.isInteger(raw.room)) {
        return { status: 400, body: { error: 'room must be a room id' } };
      }
      const located = this.deps.world.locate(raw.room as RoomId);
      if (!located) return { status: 400, body: { error: `no room ${raw.room} in the loaded world` } };
      scope = { kind: 'room', room: raw.room as RoomId };
      where = `room ${raw.room} (${located.room.name})`;
    } else if (raw.place !== undefined) {
      // `zone:level`, the same string `placeKey` produces — so the panel can hand back exactly what
      // `/status` gave it and the two cannot drift apart on a separator.
      const place = parsePlace(raw.place);
      if (!place) return { status: 400, body: { error: 'place must be "<zone>:<level>", as /status reports it' } };
      if (!this.deps.world.grid(place)) {
        return { status: 400, body: { error: `no place ${placeKey(place)} in the loaded world` } };
      }
      scope = { kind: 'place', place };
      where = `place ${placeKey(place)}`;
    }

    const heard = this.deps.announce(text, scope);
    this.audit('announce', { text, scope: scope.kind, where, heard });
    return { status: 200, body: { ok: true, heard, where } };
  }

  /* ------------------------------------------------------------------------ */
  /* Small pieces                                                              */
  /* ------------------------------------------------------------------------ */

  private findOnline(slug: string): Player | undefined {
    return this.deps.live.online().find((player) => slugify(player.name) === slug);
  }

  private roomRef(roomId: RoomId | undefined): { id: RoomId; name: string } | null {
    if (roomId === undefined) return null;
    const located = this.deps.world.locate(roomId);
    return { id: roomId, name: located?.room.name ?? '(a room this server no longer loads)' };
  }

  private liveView(player: Player): Record<string, unknown> & { slug: string; name: string } {
    return {
      slug: slugify(player.name),
      name: player.name,
      id: player.id,
      level: player.level,
      experience: player.experience,
      hp: Math.round(player.hp),
      maxHp: player.maxHp,
      mana: Math.round(player.mana),
      maxMana: player.maxMana,
      move: Math.round(player.move),
      maxMove: player.maxMove,
      posture: player.posture,
      status: player.status,
      fighting: player.fighting ?? null,
      room: this.roomRef(player.roomId),
      place: placeKey(player.place),
      light: player.light ? { id: player.light.id, name: player.light.name, radius: player.light.radius } : null,
      affects: player.affects.map((affect) => ({
        type: affect.type,
        apply: affect.apply,
        modifier: affect.modifier,
        durationMs: affect.durationMs === UNLIMITED_DURATION ? null : Math.round(affect.durationMs),
        context: affect.context ?? null,
      })),
    };
  }

  /**
   * The trail every mutation leaves: an `[admin]` console line in the server's own voice, and a JSON
   * line in `data/admin-audit.jsonl`. An admin tool's first bug report is "who changed this", and
   * the answer should predate the question. Reads are not logged; the file would be all polling.
   */
  private audit(action: string, detail: Record<string, unknown>): void {
    console.log(`[admin] ${action} ${JSON.stringify(detail)}`);
    if (!this.deps.auditFile) return;
    try {
      appendFileSync(this.deps.auditFile, `${JSON.stringify({ at: new Date().toISOString(), action, ...detail })}\n`);
    } catch (err) {
      console.error(`[admin] could not write audit line:`, (err as Error).message);
    }
  }
}

/**
 * `"36:0"` back into a {@link Place}, or nothing.
 *
 * The inverse of `placeKey`, and deliberately strict: a level is a signed integer (there are basements),
 * a zone is not, and anything else is a typo rather than a place worth guessing at.
 */
function parsePlace(value: unknown): Place | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+):(-?\d+)$/.exec(value.trim());
  if (!match) return undefined;
  return { zone: Number(match[1]) as ZoneId, level: Number(match[2]) };
}

/** One line of operator speech: trimmed, collapsed to single spaces, bounded. Undefined when unusable. */
function cleanLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > TEXT_MAX) return undefined;
  return text;
}

/** How much request body the admin API will read. Nothing here legitimately approaches it. */
const BODY_LIMIT = 64 * 1024;

/**
 * The node adapter: reads the body, hands the router a plain request, writes its plain response.
 *
 * Lives here rather than in `index.ts` so that file's contribution stays one line — everything in
 * this function is testable in principle, but the request/response shapes above are where the
 * behaviour is, and they are tested directly.
 */
export function serveAdmin(api: AdminApi, req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > BODY_LIMIT) overflowed = true;
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const respond = (response: AdminResponse): void => {
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    };
    if (overflowed) return respond({ status: 413, body: { error: 'body too large' } });

    let body: unknown;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw);
      } catch {
        return respond({ status: 400, body: { error: 'body is not JSON' } });
      }
    }
    const token = req.headers['x-admin-token'];
    // `routeAsync`, which answers the two model-backed routes and hands everything else to the sync
    // router untouched. The `catch` is the difference between a bug and a hung browser tab: a
    // rejected promise here would leave the response never written and the panel spinning forever.
    api
      .routeAsync({
        method: req.method ?? 'GET',
        path: (req.url ?? '').slice('/admin/api'.length).split('?')[0] || '/',
        token: typeof token === 'string' ? token : undefined,
        remote: req.socket.remoteAddress,
        body,
      })
      .then(respond)
      .catch((err: unknown) => {
        console.error('[admin] route threw:', err);
        respond({ status: 500, body: { error: (err as Error).message ?? 'admin route failed' } });
      });
  });
}

export type { StoredSummary };
