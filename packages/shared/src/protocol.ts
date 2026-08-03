/**
 * The wire protocol.
 *
 * The client sends *intents* and the server sends *facts*. A client message never asserts an
 * outcome — "I want to move north", not "I am now in room 3402" — so a malicious or desynced client
 * cannot invent state.
 *
 * Interest management is room-scoped: a player receives entity updates for their current room only,
 * plus a cheap summary of adjacent rooms so exits can be labelled. This falls out of the MUD's own
 * structure and keeps bandwidth flat no matter how large the world grows.
 */

import type { Equipped } from './equipment.ts';
import type { Posture, Status } from './position.ts';
import type { Direction, Room, RoomId, Sector, Zone, ZoneId } from './world.ts';

/**
 * Bumped to 11: you can point at what you mean.
 *
 * `loot` joins `look` and `attack` as an intent that may name an **entity id** rather than a keyword,
 * which is what a click on a body sends. The three are one idea: *this* one, not whichever one the
 * parser would have picked.
 *
 * **The reason it is a protocol change rather than client sugar** is that a keyword cannot express
 * it. `kill patrol` in a room holding three members of the Court Patrol is ambiguous by construction,
 * and `2.patrol` only helps if the player can see the ordering the server used. An id is the one
 * thing that says which body without either side guessing — and the server still resolves it through
 * the same visibility gate a keyword passes, so it names a body you can see or nothing at all.
 *
 * `look` and `attack` have carried `target` since before there was anything to do with it; this is
 * where all three get read.
 *
 * Was 10: the operator has a voice.
 *
 * `LogChannel` gained **`announce`** — a line an *administrator* is saying: world-wide, to a Place, to
 * a room, or to one character. One channel rather than four, because the fact a reader needs is "a
 * person is speaking to me through the game", not which scope they chose — the scope is already
 * legible from the prefix and from who else received it.
 *
 * **Taken deliberately, which is the whole reason it is a version bump rather than a quiet reuse.**
 * `DESIGN-admin-panel.md` §5 shipped announcements on `system` with a prefix and said in as many words
 * that a dedicated channel would be a protocol change to make on purpose. The reason to make it:
 * `system` is the *machine's* voice — your torch guttering, your rest paying out — and a client that
 * cannot tell that apart from a human being talking to it can neither style, filter nor alert on
 * either. A client meeting a channel it does not know must render it as ordinary text rather than
 * dropping the line; being told something in an unfamiliar colour beats not being told.
 *
 * Was 9: affects.
 *
 * `SelfView` gained `affects` — the timed effects on your own character, one row per cause, already
 * filtered to what you are allowed to be shown. **`SelfView.light` is unchanged and still carries the
 * burn**, even though the burn is now an affect underneath: the carried light has had its own HUD line
 * since Phase 1, and moving it into the affect list would be a protocol change in service of an
 * internal one. New client messages: none — `affects` arrives as typed `command` text.
 *
 * Nothing was added to `EntityView`. A stranger's affects are not yours to read, and the one that
 * *will* need to be visible on someone else — being stunned, being on fire — is a Phase 11 problem
 * with a Phase 11 answer.
 *
 * Was 8: posture and status.
 *
 * Both axes are on `SelfView` (the HUD shows them, and the client must not predict movement for a
 * character who is sitting) and on `EntityView` (a sleeping stranger should look asleep).
 *
 * Was 7: typed commands.
 *
 * The client can send a line of text (`command`), which the *server* parses — abbreviation priority
 * and target resolution are game rules, and target resolution is gated on visibility the client does
 * not have. The typed intents below stay: they are what keybinds and UI send, and both routes reach
 * the same handlers.
 *
 * Was 6: doors have live state — the `door` message, and `open`/`close` losing their required `dir`.
 * Was 5: carried light sources — `SelfView` gained `light`.
 */
export const PROTOCOL_VERSION = 11;

/**
 * One timed effect on your own character, as the HUD reads it.
 *
 * **One row per cause, not per record.** A single cause installs one affect node per derived stat it
 * touches — `second_wind` is three — so the server groups them before they reach here; see
 * `summariseAffects` in `affects.ts`. A client that received the raw list would either show three
 * identical countdowns or have to re-derive a grouping rule the server already applied, and the two
 * copies would disagree the first time one of them changed.
 *
 * `remainingMs` is counted down *by the client* between updates, from the value in the last message,
 * exactly as `CarriedLight.remainingMs` is. The server sends it when something changes and would
 * otherwise have to send it sixty times a second for a smooth clock.
 */
export interface AffectView {
  /** The affect type's id. Stable, so the client may key styling on it. */
  readonly type: string;
  /** How it reads. Authored server-side so both the HUD and the `affects` command say the same thing. */
  readonly name: string;
  /** Milliseconds until it lapses. Absent for one that never does. */
  readonly remainingMs?: number;
}

/**
 * The light source a character is carrying, for display.
 *
 * `lightRadius` on {@link SelfView} is the number that matters mechanically; this exists so the HUD
 * can say *what* is producing it and warn before it goes out. The client counts `remainingMs` down
 * itself between updates rather than the server resending it every tick.
 */
export interface CarriedLight {
  readonly id: string;
  readonly name: string;
  readonly radius: number;
  /** How this source illuminates. See `LightMode` in `light.ts`. */
  readonly mode: 'radius' | 'rooms';
  /** Milliseconds until it burns out. Absent for sources that never expire. */
  readonly remainingMs?: number;
}

/** A tile coordinate on the current Place's grid. */
export interface TilePoint {
  readonly tx: number;
  readonly ty: number;
}

export type EntityId = number;

/* -------------------------------------------------------------------------- */
/* Views — the server's rendering of state, trimmed to what a client may know   */
/* -------------------------------------------------------------------------- */

export type EntityKind = 'player' | 'mob' | 'item';

export interface EntityView {
  readonly id: EntityId;
  readonly kind: EntityKind;
  readonly name: string;
  /** Sprite key resolved against the client's asset atlas. */
  readonly sprite: string;
  /**
   * What this character is wearing, as **slot → item id**. Phase 15a.
   *
   * On the wire for *every* character rather than only yourself, which is the whole point: the
   * roadmap's completion test for this phase is that worn gear is visible on the body, and a stranger
   * in chainmail has to read as a stranger in chainmail before you decide whether to fight them.
   *
   * **Ids, not sheet names.** Which LPC layer a leather tunic draws as — and that the art is LPC at
   * all — stays the client's business, exactly as {@link sprite} already is. The server says what is
   * worn; the client owns how that looks. Sending sheet keys would put the art direction on the wire
   * and make a re-skin a protocol change.
   *
   * Absent for anything with no body to dress, which today is every ground item and every mob.
   */
  readonly wearing?: Readonly<Record<string, string>>;
  /** Position within the room cell, in tiles. Sub-tile precision for smooth movement. */
  readonly x: number;
  readonly y: number;
  readonly facing: Direction;
  /** Fraction in `[0, 1]`. Exact HP is deliberately not exposed for entities that are not you. */
  readonly healthFraction?: number;
  readonly level?: number;
  /** Currently in a fight — drives the combat indicator. */
  readonly fighting?: EntityId;
  /**
   * How this character is arranged and how conscious they are. Absent for entities that have no body
   * to arrange, which today is every ground item.
   *
   * On the wire for other characters, not just yourself, because a sleeping stranger has to *look*
   * asleep — otherwise the only way to tell is to attack them and find out.
   */
  readonly posture?: Posture;
  readonly status?: Status;
}

/** The one-line summary a client gets about a room it can see into but is not standing in. */
export interface AdjacentRoomView {
  readonly id: RoomId;
  readonly name: string;
  readonly sector: Sector;
  readonly occupied: boolean;
}

export interface RoomView {
  readonly room: Room;
  readonly entities: readonly EntityView[];
  readonly adjacent: Readonly<Partial<Record<Direction, AdjacentRoomView>>>;
}

/** Everything a player may know about their own character, including exact numbers. */
export interface SelfView {
  readonly id: EntityId;
  readonly name: string;
  readonly level: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly mana: number;
  readonly maxMana: number;
  readonly move: number;
  readonly maxMove: number;
  readonly experience: number;
  readonly experienceToNext: number;
  /**
   * What this character is wearing, by slot. Phase 14b's starting kit.
   *
   * On the wire because the paper doll draws it, and because armour class is derived from it —
   * a client that could not see the gear could not explain why one level-1 character is harder to
   * hit than another, which is the entire point of rolling it.
   */
  readonly equipped: Equipped;
  readonly roomId: RoomId;
  /** Which map the player is standing on. See {@link Place}. */
  readonly place: Place;
  /**
   * The two position axes. See `position.ts` — they are orthogonal, and the client needs both.
   *
   * Not only for the HUD: the client predicts its own movement, and a character who is sitting or
   * asleep is not moving. Predicting a walk the server will refuse produces a sprite that slides and
   * is then yanked back every frame.
   */
  readonly posture: Posture;
  readonly status: Status;
  /**
   * How far this character can currently see, in tiles.
   *
   * A derived stat, not a constant: it comes from the best active light source, so a torch is a real
   * upgrade over the bare 2-tile starting radius and can expire back down again.
   */
  readonly lightRadius: number;
  /** What is producing that radius, when it is anything other than the bare unaided minimum. */
  readonly light?: CarriedLight;
  /**
   * Every timed effect currently on this character that they are allowed to see.
   *
   * Always present, empty when there is nothing — an array rather than an optional field because the
   * client renders a list and "no field" and "empty list" mean the same thing to it, while an optional
   * one would mean every reader needed a default.
   *
   * The carried light is **not** in here despite being an affect underneath. It has its own line, and
   * saying it twice in two vocabularies is worse than saying it once.
   */
  readonly affects: readonly AffectView[];
}

/**
 * The unit of rendering: one zone at one vertical level.
 *
 * Worldgen normalises room coordinates *per zone*, so different zones do not share a coordinate
 * space and neither do different levels of one zone. Every cross-zone exit in the world is
 * therefore a portal — measured, 0 of 991 cross-zone exits are geometric neighbours. Moving between
 * zones and moving between levels are consequently the *same* operation: leave one Place, arrive at
 * a room in another. Modelling it once is why this type exists.
 */
export interface Place {
  readonly zone: ZoneId;
  readonly level: number;
}

export function samePlace(a: Place, b: Place): boolean {
  return a.zone === b.zone && a.level === b.level;
}

export function placeKey(place: Place): string {
  return `${place.zone}:${place.level}`;
}

/* -------------------------------------------------------------------------- */
/* Client → server                                                             */
/* -------------------------------------------------------------------------- */

export type ClientMessage =
  | { readonly t: 'hello'; readonly protocol: number; readonly name: string }
  /** Walk one room in a direction. The server decides whether it is legal. */
  | { readonly t: 'move'; readonly dir: Direction }
  /** Sub-room movement intent: a normalised direction vector held since the last tick. */
  | { readonly t: 'steer'; readonly dx: number; readonly dy: number }
  /**
   * Click to move: "walk me to this tile".
   *
   * A destination, never a route. The server does the pathfinding, because the route must be gated
   * on this character's explored map and a client that computed its own path could simply ignore
   * that and walk through the fog.
   */
  | { readonly t: 'moveTo'; readonly tx: number; readonly ty: number }
  /** Abandon any active path. Sent when the player takes manual control. */
  | { readonly t: 'stop' }
  | { readonly t: 'attack'; readonly target: EntityId }
  | { readonly t: 'flee' }
  /**
   * Work the door in a direction. Omitting `dir` means "the one I am facing" — the server holds the
   * authoritative facing, so letting it resolve this keeps the client from guessing at a fact it only
   * has a predicted copy of.
   */
  | { readonly t: 'open'; readonly dir?: Direction }
  | { readonly t: 'close'; readonly dir?: Direction }
  | { readonly t: 'look'; readonly target?: EntityId }
  /**
   * Go through a corpse. Omitting `target` means the nearest one still worth searching, which is what
   * the typed `loot` resolves to; naming one is what a click on a particular body sends.
   */
  | { readonly t: 'loot'; readonly target?: EntityId }
  | { readonly t: 'say'; readonly text: string }
  /**
   * A line the player typed, verbatim and unparsed.
   *
   * Still an intent — "I want to open east", never an outcome — but a *textual* one, and the server
   * owns every step of turning it into an action. Which command `sa` abbreviates to is a game rule
   * that two clients must not be able to disagree about, and resolving `2.orc` needs the room
   * contents **as this character may see them**, which is knowledge the client does not have and
   * must not be handed. See `server/src/commands.ts`.
   */
  | { readonly t: 'command'; readonly text: string }
  /** Round-trip timing probe; the server echoes `ts` back untouched. */
  | { readonly t: 'ping'; readonly ts: number };

/* -------------------------------------------------------------------------- */
/* Server → client                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A line for the text log — the MUD half of the hybrid presentation.
 *
 * `system` is the machine talking (your torch is guttering); **`announce` is a person talking** — an
 * operator, through the admin panel, to the world, a Place, a room or you alone. Keeping them apart is
 * what lets a client style one and alert on the other, and it is the whole of protocol 10.
 */
export type LogChannel = 'room' | 'combat' | 'say' | 'system' | 'error' | 'announce';

/**
 * How one swing resolved, beyond whether it landed.
 *
 * The first four are produced today. The rest are the vocabulary a MUD combat log is *made* of — you
 * dodged, it was parried, the shield took it — and each needs a mechanism that does not exist yet, so
 * they are declared and unproduced. See {@link ServerMessage} `attackResolved`.
 */
export const ATTACK_OUTCOMES = [
  'hit',
  'miss',
  'critical',
  'fumble',
  // Phase 19, defence skills.
  'dodged',
  'parried',
  'blocked',
  // Phase 20, spells.
  'absorbed',
  'resisted',
] as const;

export type AttackOutcomeKind = (typeof ATTACK_OUTCOMES)[number];

export type ServerMessage =
  | {
      readonly t: 'welcome';
      readonly protocol: number;
      readonly you: EntityId;
      readonly tickMs: number;
      readonly roundMs: number;
    }
  | { readonly t: 'rejected'; readonly reason: string }
  /**
   * The map the player is now standing on. Sent on join **and again on every arrival at a new
   * {@link Place}** — a different zone, or a different level of the same zone.
   *
   * The client rebuilds the tile grid from this with the same `buildZoneTilemap` the server used,
   * rather than being shipped a grid. One implementation, so the collision and the rendering cannot
   * drift apart.
   *
   * Receiving this for a *different* Place **must** reset the client's `seen` bitset, and a {@link
   * seen} snapshot for the new Place follows immediately. This is the exact opposite of the pre-v4
   * rule, which keyed fog on globally unique room ids and therefore spanned the whole world: `seen`
   * is now tile indices, and the same index names a different tile on every grid. Carrying one Place's
   * bitset onto another's grid does not degrade, it corrupts. Receiving this for the Place already
   * drawn is a resync rather than travel, and there the bitset must be *kept* — otherwise every delta
   * since the last snapshot is dropped and ground the character has walked goes black again.
   */
  | { readonly t: 'zone'; readonly zone: Zone; readonly level: number }
  /**
   * Every tile of the current Place this character has ever seen, as a base64 bitset indexed by
   * tile index. Sent on arriving at a Place.
   *
   * A bitset rather than a list of indices because a fully-explored 168x156 grid is 26,208 tiles —
   * about 150 KB as JSON integers, against 3.3 KB of bits.
   *
   * Server-owned rather than a client drawing effect: this is character progress, it must survive a
   * browser clear, and it gates click-to-move, so a client must not be able to forge it.
   */
  | { readonly t: 'seen'; readonly place: Place; readonly bits: string }
  /**
   * Tiles seen for the first time since the last message, for the Place the player is currently on.
   *
   * Sent as the character moves, batched with the tick. The client does not derive this itself: its
   * position is predicted and would drift from the server's by a tile here and there, and the
   * server's copy is the one that decides where you may click.
   *
   * It deliberately carries no {@link Place} — it is a delta against whichever bitset the client
   * currently holds, and one extra field on the highest-frequency message is not free. The invariant
   * that makes that safe is an ordering one the *server* must keep: light is folded into `seen` only
   * ever against the player's current Place, and on a Place change the arrival messages (`zone`, then
   * the full `seen` snapshot) are sent before any further delta. Send a delta across that boundary
   * and it lands on the wrong grid silently.
   */
  | { readonly t: 'seenDelta'; readonly tiles: readonly number[] }
  /**
   * A door on the current {@link Place} opened or shut.
   *
   * The client applies it with the same `setDoorTiles` the server ran, so both grids reach the same
   * bytes — a shut door is not walkable, and a client whose copy is stale predicts straight through a
   * tile the server will refuse.
   *
   * **Place-scoped, not room-scoped.** Everything else about *entities* is gated on your room, but
   * this is terrain: the grid belongs to the Place, `zone` and `seen` are already shipped whole, and
   * a door two rooms away that this client has wrong is a desync waiting for the player to walk into
   * it. It says nothing about who did it — that is a separate `log` line, rendered per recipient.
   */
  | {
      readonly t: 'door';
      readonly room: RoomId;
      readonly dir: Direction;
      readonly closed: boolean;
    }
  /** Full room contents. Sent on entering a room and on resync. */
  | { readonly t: 'room'; readonly view: RoomView }
  /** Your own character's numbers changed. */
  | { readonly t: 'self'; readonly view: SelfView }
  | { readonly t: 'entityEnter'; readonly entity: EntityView; readonly from?: Direction }
  | { readonly t: 'entityLeave'; readonly id: EntityId; readonly to?: Direction }
  /** Positional delta for entities in your room, batched once per tick. */
  | {
      readonly t: 'entityMoved';
      readonly moves: readonly { readonly id: EntityId; readonly x: number; readonly y: number; readonly facing: Direction }[];
    }
  | { readonly t: 'entityUpdate'; readonly entity: EntityView }
  /** One resolved attack. Carries the roll so the client can show it and so fights are auditable. */
  | {
      readonly t: 'attackResolved';
      readonly attacker: EntityId;
      readonly target: EntityId;
      readonly hit: boolean;
      readonly critical: boolean;
      readonly damage: number;
      readonly natural: number;
      /**
       * *Why* it went the way it did, when there is more to say than hit or miss.
       *
       * Reserved in Phase 11 and only ever `'hit'`, `'miss'`, `'critical'` or `'fumble'` until the
       * mechanisms that can produce the others exist: **dodge, parry and shield block are defence skills
       * (Phase 19)** and **casting is Phase 20**. It is here now rather than then because of `ROADMAP.md`
       * §4's first question — a new field on a message costs nothing today and costs a rewrite of every
       * combat message site once a client, a log renderer and a replay all read this shape.
       *
       * A client should treat an unknown value as a plain miss rather than refusing to draw it.
       */
      readonly outcome?: AttackOutcomeKind;
    }
  | { readonly t: 'died'; readonly id: EntityId; readonly killer?: EntityId }
  /**
   * The route the server will walk you along, for display. An empty array clears it.
   *
   * Authoritative: the client draws this, it does not compute it. Sending it back costs little and
   * means the drawn route is provably the one being walked.
   */
  | { readonly t: 'path'; readonly points: readonly TilePoint[] }
  /** A click that could not be honoured, with the reason, so the client can say why. */
  | {
      readonly t: 'pathFailed';
      readonly reason: 'unexplored' | 'unreachable' | 'not-walkable' | 'off-map';
    }
  | { readonly t: 'log'; readonly channel: LogChannel; readonly text: string }
  | { readonly t: 'pong'; readonly ts: number; readonly serverTime: number };

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * JSON for now — it is trivially debuggable in the browser's network panel, which matters far more
 * during early development than bytes on the wire. `entityMoved` is the only high-frequency message
 * and is already batched per tick; if profiling ever says otherwise, swap this pair of functions.
 */
export function encode(message: ServerMessage | ClientMessage): string {
  return JSON.stringify(message);
}

export function decodeClientMessage(raw: string): ClientMessage | undefined {
  const parsed: unknown = safeParse(raw);
  if (!isTagged(parsed)) return undefined;
  return parsed as ClientMessage;
}

export function decodeServerMessage(raw: string): ServerMessage | undefined {
  const parsed: unknown = safeParse(raw);
  if (!isTagged(parsed)) return undefined;
  return parsed as ServerMessage;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isTagged(value: unknown): value is { t: string } {
  return typeof value === 'object' && value !== null && typeof (value as { t?: unknown }).t === 'string';
}
