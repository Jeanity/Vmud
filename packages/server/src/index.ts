/**
 * WebSocket game server.
 *
 * Runs the simulation on a fixed tick and pushes state to clients.
 *
 * ## Two gates, not one
 *
 * **Interest management is room-scoped**: you are told about your own room and given one-line
 * summaries of its neighbours. That is a bandwidth question and it is unchanged.
 *
 * **Visibility is tile-scoped**: within your room, you are told about entities light actually falls
 * on. That is a gameplay question. Terrain you have seen is remembered — the `seen` bitset — but
 * creatures are not: a mob that wanders into a remembered room while you are away stays invisible
 * until light reaches it again.
 *
 * Both gates apply, and they apply to different things, which is why they are computed separately.
 */

import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  DIRECTIONS,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  ROUND_MS,
  DEFAULT_WEAPON,
  OPPOSITE,
  divideExperience,
  armourToAc,
  attackBonusFor,
  parseDice,
  roundLengthFor,
  type CombatStats,
  TICK_MS,
  TILE_SIZE,
  ZONE_TICK_MS,
  affectKind,
  decodeClientMessage,
  doorwayTiles,
  HP_FLOOR,
  encode,
  applyDeathCost,
  applyExperience,
  armourClassFrom,
  makeRng,
  playerCombatStats,

  weaponFrom,
  STARTING_HIT_POINTS,
  addCoins,
  carry,
  describePurse,
  describeStack,
  CURRENCIES,
  apportion,
  contributionValue,
  isMoney,
  purseIsEmpty,
  vnumOf,
  type Purse,
  type ItemTemplate,
  emptyInventory,
  limitOf,
  loose,
  stackSlots,
  matchInventory,
  removeAt,
  slotsFree,
  slotsUsed,
  type EquipSlot,
  type Item,
  meets,
  summariseAffects,
  parseDirection,
  placeKey,
  samePlace,
  shortfall,
  type AdjacentRoomView,
  type ClientMessage,
  type Direction,
  type EntityId,
  type EntityView,
  type LogChannel,
  type Place,
  type Posture,
  type Requirement,
  type RoomId,
  type Status,
  type RoomView,
  type ServerMessage,
  type TileGrid,
  type ZoneSpawns,
  type TilePoint,
} from '@mygame/shared';
// Subpath imports: `light`, `pathfind` and `vision` are not re-exported from the package barrel.
import { lightSource, type LightSource } from '@mygame/shared/light.ts';
import { canWalkStraightTo, findPath, type PathFailure } from '@mygame/shared/pathfind.ts';
import { bitsToBase64, bitsetToSet } from '@mygame/shared/vision.ts';

import { UNSEEN_NAME, actLines } from './act.ts';
import { AdminApi, serveAdmin, type LiveOps } from './admin.ts';
import {
  COMMANDS,
  COMMAND_REQUIREMENTS,
  directionOf,
  findTarget,
  keywordsFromName,
  lookupCommand,
  newCommandBudget,
  parseTargetRef,
  spendCommand,
  splitCommand,
  type Command,
  type CommandBudget,
} from './commands.ts';
import { legacyRoomReveal } from './legacy-fog.ts';
import {
  WORLD_SEED,
  pickupInRoom,
  pickupOutcome,
  pickupViewOf,
  standingOn,
  type GroundPickup,
  type PickupOutcome,
} from './pickups.ts';
import {
  PlayerStore,
  seenTileCount,
  type LegacyRoomTiles,
  type PlayerRecord,
} from './players.ts';
import {
  advanceAssists,
  advanceCombat,
  clearEngagements,
  disengage,
  engage,
  forgetThreat,
  openingTarget,
  type AssistEvent,
  type AttackOutcome,
  type Death,
  type LedgerBook,
  type TargetSwitch,
  type ThreatBook,
} from './combat.ts';
import {
  advanceCorpses,
  corpseViewOf,
  corpsesIn,
  nearestLootable,
  lootCorpse,
  lootRefusal,
  corpseName,
  makeCorpse,
  withinReach,
  type Corpse,
  type Graveyard,
} from './corpses.ts';
import {
  dropItem,
  groundViewOf,
  itemsIn,
  nearestMatching,
  takeItem,
  withinPickupReach,
  type Ground,
} from './ground.ts';
import { loadSettings, saveSettings, type WorldSettings } from './settings.ts';
import { attemptFlee, type FleeOutcome } from './flee.ts';
import { markPursuers, pursuitTarget } from './pursue.ts';
import {
  advanceHunts,
  beginHunt,
  forgetQuarry,
  type Hunt,
  type HuntEvent,
} from './hunt.ts';
import { Scheduler } from './scheduler.ts';
import { advanceStations } from './station.ts';
import {
  advancePerception,
  forgetTarget,
  perceives,
  type MobAwareness,
  type NoticeEvent,
} from './perception.ts';
import { advanceZones, newZoneClock, runReset, type ZoneClock } from './reset.ts';
import { Simulation, isMob, isPlayer, type Actor, type AffectEvent, type Player } from './sim.ts';
import { indexTemplates, loadItemCatalogue, loadZoneSpawns } from './spawns.ts';
import { ROOMS_FILE } from './overrides.ts';
import { GameWorld, placeOf } from './world.ts';

/**
 * Deliberately `GAME_PORT` and not `PORT`.
 *
 * Dev harnesses set `PORT` for *the web server*, and `concurrently` passes its environment to every
 * child — so reading `PORT` here makes the game server silently steal Vite's port. Worse, Node sets
 * `SO_REUSEADDR`, so on Windows the second bind succeeds instead of failing, and you get two
 * processes on one port with no error anywhere.
 */
const PORT = Number(process.env['GAME_PORT'] ?? 8787);

// Which zones exist is configuration, not code: `world.config.json` is the only thing that decides.
const world = GameWorld.load();
const sim = new Simulation(world);

for (const zone of world.allZones()) {
  const levels = world.levelsOf(zone.id);
  // `console.log` has no width specifiers — `%4d` would print literally — so pad by hand.
  console.log(
    `[world] zone ${String(zone.id).padStart(4)} "${zone.name}" — ` +
      `${String(zone.rooms.length).padStart(4)} rooms on ${levels.length} ` +
      `level${levels.length === 1 ? '' : 's'} (${levels.join(', ')})`,
  );
}
const startRoom = world.spawnRoom();
console.log(
  `[world] ${world.allPlaces().length} places loaded; new characters start in room ` +
    `${startRoom.id} "${startRoom.name}" at place ${placeKey(placeOf(startRoom))}`,
);
if (world.locksRelaxed > 0) {
  // Loud, because it is a lie the world is being told and somebody will one day wonder why their
  // locked door opens. See `LOCKS_HOLD`.
  console.log(
    `[world] ${world.locksRelaxed} locked doors unlocked: no key exists to open one yet ` +
      `(objects are Phase 15). Doors still shut, and still have to be opened.`,
  );
}

/**
 * The world's population, and the clock that tops it up.
 *
 * One `ZoneClock` per loaded zone that has a population file. A zone without one is simply empty — see
 * `spawns.ts` — which is the ordinary case for the 278 zones no Duris file matched.
 *
 * **The RNG is seeded and shared.** Every hit-point roll, every tile a mob stands on and every re-rolled
 * lifespan comes out of this one stream, so a restart reproduces the world it had. `CLAUDE.md` rule 3:
 * `Math.random()` in simulation code makes a desync unreproducible and a fight unauditable.
 */
const spawnRng = makeRng(WORLD_SEED);
const zoneClocks: ZoneClock[] = [];
const loadedSpawns: ZoneSpawns[] = [];
for (const zoneId of world.populate) {
  const spawns = loadZoneSpawns(zoneId);
  if (spawns) loadedSpawns.push(spawns);
  else console.warn(`[pop] zone ${zoneId} is listed to populate but has no population file`);
}
const mobTemplates = indexTemplates(loadedSpawns);

/**
 * Every item type in the world, by vnum. Phase 15c — see `spawns.ts`.
 *
 * World-wide rather than per zone, because a `G` command in IceCrag may name an object defined in a
 * file belonging to somewhere else entirely: `real_object` in the source is a global lookup and there
 * is no per-zone answer to "what is object 91000".
 */
const itemCatalogue = loadItemCatalogue();
console.log(
  itemCatalogue.size > 0
    ? `[items] ${itemCatalogue.size} item types loaded`
    : '[items] no catalogue; mobs will carry nothing. Run `npm run worldgen`.',
);

/**
 * What each mob has worked out, by mob id. See `perception.ts`.
 *
 * Held here rather than on the actor because it is `perception.ts`'s business alone — a `Mob` is a body, and
 * Phase 7's split exists to keep it one.
 */
const awareness = new Map<number, MobAwareness>();

/**
 * Who is currently chasing whom, by mob id. See `hunt.ts`.
 *
 * Beside {@link awareness} for the same reason and with the same lifetime rules: keyed on ids, cleared when
 * a character leaves. A mob with no entry here is standing still, which is almost all of them almost always
 * — only 34 of IceCrag's 66 can hunt at all, and only after something has noticed you.
 */
const hunts = new Map<number, Hunt>();

/**
 * A light handed to every character on join, for testing. Off unless `GAME_DEV_LIGHT` is set.
 *
 * Resolved once at boot and announced, because a server quietly handing everyone a lamp is exactly the
 * sort of thing that survives into a build nobody meant it to.
 */
const DEV_LIGHT = process.env.GAME_DEV_LIGHT ? lightSource(process.env.GAME_DEV_LIGHT) : undefined;

/**
 * A weapon handed to every character on join, for testing. Off unless `GAME_DEV_DAMAGE` is set.
 *
 * The sibling of {@link DEV_LIGHT} and for the same reason: IceCrag's weakest inhabitant has about 150
 * hit points and the practice weapon does 1d6, so *watching* anything to do with a health bar means
 * either a hundred swings or a switch. `GAME_DEV_DAMAGE=8d10+40` makes a fight short enough to see.
 *
 * Dice notation, parsed by the same `parseDice` the harvest uses — an unreadable value is refused loudly
 * rather than silently becoming a mob that swings for NaN.
 */
/**
 * A level to start every character at, for testing. Off unless `GAME_DEV_LEVEL` is set.
 *
 * **These numbers are a test rig, not a progression.** `ROADMAP.md` §4 records character progression —
 * ability scores, hit dice, levelling — as the largest hole in the schedule, and inventing its numbers
 * here would be exactly the quiet decision that section exists to prevent. What this does is make a
 * character *survivable enough to watch a fight*, which is a different and much lower bar: a level-1
 * character has 9 hit points and IceCrag's weakest inhabitant has about 150, so without it every combat
 * mechanic is observable for about six seconds.
 *
 * The shape is borrowed from the mob derivation in `combat.ts` rather than invented fresh — same
 * `attackBonusFor`, same `armourToAc` — so a tester is fighting with the arithmetic the game already
 * uses. The hit points and the weapon dice are frankly arbitrary and chosen to make a fight last about a
 * minute against a same-level castle guard.
 */
const DEV_LEVEL = process.env.GAME_DEV_LEVEL ? Number(process.env.GAME_DEV_LEVEL) : undefined;
if (process.env.GAME_DEV_LEVEL && (!Number.isFinite(DEV_LEVEL) || (DEV_LEVEL ?? 0) < 1)) {
  console.warn(`[dev] GAME_DEV_LEVEL="${process.env.GAME_DEV_LEVEL}" is not a level; ignoring`);
} else if (DEV_LEVEL) {
  console.log(`[dev] every character joins at level ${DEV_LEVEL} (GAME_DEV_LEVEL)`);
}

/** The test rig's stats for a level. See {@link DEV_LEVEL} for why these are not a progression. */
function devProfile(level: number): { maxHp: number; combat: CombatStats } {
  return {
    maxHp: 12 * level,
    combat: {
      // Fed the *Duris* scale, because `armourToAc` is what converts it — a level 35 lands near AC 21,
      // which is the SRD's plate-and-shield band and roughly what a castle officer wears.
      armourClass: armourToAc(-3 * level),
      damage: parseDice(`${Math.max(1, Math.ceil(level / 8))}d8+${level}`) ?? DEFAULT_WEAPON,
      attackBonus: attackBonusFor(level, true),
      roundMs: roundLengthFor(level),
    },
  };
}

const DEV_DAMAGE = process.env.GAME_DEV_DAMAGE ? parseDice(process.env.GAME_DEV_DAMAGE) : undefined;
if (process.env.GAME_DEV_DAMAGE && !DEV_DAMAGE) {
  console.warn(`[dev] GAME_DEV_DAMAGE="${process.env.GAME_DEV_DAMAGE}" is not dice notation; ignoring`);
} else if (DEV_DAMAGE) {
  console.log(`[dev] every character joins hitting for ${process.env.GAME_DEV_DAMAGE} (GAME_DEV_DAMAGE)`);
}
if (process.env.GAME_DEV_LIGHT && !DEV_LIGHT) {
  console.warn(`[dev] GAME_DEV_LIGHT="${process.env.GAME_DEV_LIGHT}" is not a light source id; ignoring`);
} else if (DEV_LIGHT) {
  console.log(`[dev] every character joins carrying ${DEV_LIGHT.name} (GAME_DEV_LIGHT)`);
}

/**
 * Future-dated work, ordered by when it is due. See `scheduler.ts`.
 *
 * Phase 11's *Carries* item, and its first consumer is the per-actor round clock — one timer per
 * combatant, most actors having none. Phase 2's command input queue lands on this too when it is written.
 */
const scheduler = new Scheduler();

/**
 * Every fighting mob's threat table. See `threat.ts` for why this exists and what it diverges from.
 *
 * Empty for almost every mob almost always — a table is created on the first blow and dropped when the
 * fight ends, so 92 standing inhabitants cost nothing.
 */
const threat: ThreatBook = new Map();

/**
 * What each character did to each mob, for dividing experience when it dies. See `combat.ts`.
 *
 * Separate from {@link threat} because they answer different questions and decay differently — a tank
 * whose aggro was pulled has low threat and a large share, and one map could not say both.
 */
const ledger: LedgerBook = new Map();

/** Everything lying dead on the floor. See `corpses.ts`. */
const graveyard: Graveyard = new Map();

/**
 * Everything *else* lying on the floor: dropped, spilled from a corpse, or put down. See `ground.ts`.
 *
 * **Not persisted, and that is a known limit rather than an oversight.** A restart clears the floor,
 * so a character's own gear is safe (it is in their file) and only what somebody chose to put down is
 * lost. Persisting it needs a world-state file that also has to survive `npm run worldgen` rebuilding
 * the rooms underneath it — a real design question, and 15c's, not something to answer by accident
 * here. The `inventory` command is where a player's things actually live.
 */
const ground: Ground = new Map();

/**
 * The operator's switches, read once at boot. See `settings.ts`.
 *
 * `let` rather than `const` because the panel throws them at run time; the write goes to disk in the
 * same breath, so a restart cannot silently revert one.
 */
let settings: WorldSettings = loadSettings();

/**
 * The stream every die roll in a fight comes from.
 *
 * Seeded and separate from the spawn stream, so a fight is reproducible from its seed and so combat
 * cannot shift the world's population by consuming rolls out of the same sequence. `CLAUDE.md` rule 3:
 * never `Math.random()` in simulation.
 */
const combatRng = makeRng(WORLD_SEED ^ 0xf16847);

/**
 * Rolls that belong to a character rather than to the world: their starting kit, and the hit points
 * each level grants. Phase 14b.
 *
 * Its own stream, like the two above, so that creating a character does not shift what the next mob
 * spawn or the next attack rolls. Interleaved streams are reproducible only if every consumer runs in
 * the same order, which is exactly the property a live server does not have.
 */
const progressRng = makeRng(WORLD_SEED ^ 0x14b0de);

/**
 * The opening population, and it is a **forced** reset.
 *
 * Forced matters for one reason, and it is §4.9's gotcha: on a *timed* reset an `M` below 100% never fires
 * at all, so a forced pass is the only time a percentage is consulted. Every `M` we harvested is at 100,
 * so this changes nothing today — but a boot that filled the world by the timed rule would silently be
 * the wrong rule the day a sub-100 command arrives.
 */
for (const spawns of loadedSpawns) {
  const clock = newZoneClock(spawns, spawnRng);
  zoneClocks.push(clock);
  const outcome = runReset(sim, clock, mobTemplates, itemCatalogue, spawnRng, true);
  console.log(
    `[pop] zone ${String(spawns.zone).padStart(4)} "${world.zone(spawns.zone)?.name ?? '?'}" — ` +
      `${String(outcome.spawned.length).padStart(4)} mobs from ${spawns.templates.length} templates, ` +
      `${outcome.doors} doors set, ${outcome.kitted} pieces of kit; next reset in ${clock.lifespan} ticks ` +
      `(${Math.round((clock.lifespan * ZONE_TICK_MS) / 60_000)} min)`,
  );
}
if (loadedSpawns.length === 0) {
  console.log('[pop] no population files; the world is empty. Run `npm run worldgen`.');
}


/** Sockets by entity id, so we can address a single player. */
const sockets = new Map<EntityId, WebSocket>();

/**
 * Persisted character data (the seen map) by entity id.
 *
 * The store is handed a way to translate a pre-v4 save's room ids into tiles, so a character written
 * by the previous version keeps the map they walked instead of being met with an error or a blank
 * world. {@link legacyRoomReveal} reproduces the old room-granular fog's own rule, which is exactly
 * what "tiles this character had seen" meant then — see `PlayerStore.migrateExplored`. It is the
 * only caller of that rule anywhere, and both go when the `explored` field does.
 */
const store = new PlayerStore({
  resolveLegacyRoom: (roomId): LegacyRoomTiles | undefined => {
    const located = world.locate(roomId);
    if (!located) return undefined;
    const grid = world.grid(located.place);
    if (!grid) return undefined;
    const tiles = legacyRoomReveal(grid, located.room);
    if (tiles.length === 0) return undefined;
    return { place: located.place, tileCount: grid.width * grid.height, tiles };
  },
});
const records = new Map<EntityId, PlayerRecord>();

/**
 * Which other entities each connected player is currently being shown.
 *
 * The client holds a list of entities and mutates it with `entityEnter`/`entityLeave`, so the server
 * has to remember what it already said. Both gates fold into this one set: an entity is in it when
 * it is in your room *and* lit. Walking out of someone's torchlight therefore produces a plain
 * `entityLeave`, the same message as walking out of their room — the client needs no new concept and
 * the protocol needs no new message.
 */
const watching = new Map<EntityId, Set<EntityId>>();

/**
 * Per-connection command allowance. See {@link newCommandBudget}.
 *
 * Keyed by entity rather than by socket so it dies with the character on disconnect; a reconnect
 * gets a fresh burst, which is right — it is a flood guard, not a punishment that follows you.
 */
const budgets = new Map<EntityId, CommandBudget>();

function send(id: EntityId, message: ServerMessage): void {
  const socket = sockets.get(id);
  if (socket && socket.readyState === socket.OPEN) socket.send(encode(message));
}

/**
 * Sends to everyone standing in `roomId`, optionally skipping one player.
 *
 * For lines that name **nobody** — "The iron gate is opened from the other side." A line that names
 * an actor must go through {@link actToRoom} instead, because the name is not the same for every
 * recipient. See the header of that function.
 */
function sendToRoom(roomId: RoomId, message: ServerMessage, except?: EntityId): void {
  for (const player of sim.playersIn(roomId)) {
    if (player.id !== except) send(player.id, message);
  }
}

/** Sends to everyone standing on `place` — for terrain, which is Place-scoped rather than room-scoped. */
function sendToPlace(place: Place, message: ServerMessage): void {
  for (const player of sim.allPlayers()) {
    if (samePlace(player.place, place)) send(player.id, message);
  }
}

/* -------------------------------------------------------------------------- */
/* Visibility: what light reaches                                              */
/* -------------------------------------------------------------------------- */

/** The tile a world-pixel position sits in, as an index into `grid`. */
function tileIndexAt(grid: TileGrid, x: number, y: number): number {
  return Math.floor(y / TILE_SIZE) * grid.width + Math.floor(x / TILE_SIZE);
}

/**
 * Whether `observer` can see `subject` right now.
 *
 * **The single authority on that question**, and it has to be, because two things depend on it and
 * they must never disagree: whether a character is drawn at all, and what a log line is allowed to
 * call them. Entity presence was gated on this rule from the start; prose was not, which is how
 * `say` came to ship a pre-rendered `"Alice says, '...'"` to an observer whose client had never been
 * told Alice was in the room. One function, both consumers — see {@link actToRoom}.
 *
 * You always see yourself: `computeVisible` lights its own origin, and being told about your own
 * character is not optional.
 */
function canSee(observer: Player, subject: Actor): boolean {
  if (observer.id === subject.id) return true;
  // Room scope first — it is the cheaper of the two gates and the one that holds across Places.
  if (observer.roomId !== subject.roomId) return false;
  const grid = world.grid(observer.place);
  if (!grid) return false;
  return observer.visible.has(tileIndexAt(grid, subject.x, subject.y));
}

/**
 * Sends a line about `actor` to everyone else in their room, **re-rendered per recipient**.
 *
 * The rendering rule and the reasoning behind it live in `act.ts`; this is the half that knows about
 * rooms and sockets. What matters here is the third argument: the visibility test handed to it is
 * {@link canSee}, the very function entity presence is gated on, so prose and presence cannot come to
 * different conclusions about who is in the room.
 */
function actToRoom(actor: Player, channel: LogChannel, render: (who: string) => string): void {
  for (const line of actLines(actor, sim.playersIn(actor.roomId), canSee, render)) {
    send(line.to, { t: 'log', channel, text: line.text });
  }
}

/**
 * Everything in `observer`'s room that light currently falls on, including the observer.
 *
 * Everything must be standing on, or lying on, a lit tile — {@link canSee} is the test.
 *
 * **The single authority on entity presence.** Both gates are resolved here, so no caller has to
 * remember to apply one of them, and — more importantly — the room view and the incremental
 * `entityEnter`/`entityLeave` diff are built from the same list. Two implementations would disagree
 * the moment one of them learned about a new kind of entity, which is exactly what ground pickups
 * are.
 */
function visibleEntities(observer: Player): EntityView[] {
  const grid = world.grid(observer.place);
  if (!grid) return [];

  const out: EntityView[] = [];
  // `actorsIn`, not `playersIn`: presence is about what is standing here, and a mob is standing here.
  // This one word is what makes a mob visible at all, and it is the *only* change the gate needed —
  // `canSee` already asked the right question of any body, so a sentry is hidden by unlit ground and
  // revealed by a torch through the code that was already doing it for players.
  for (const other of sim.actorsIn(observer.roomId)) {
    if (canSee(observer, other)) out.push(sim.viewOf(other));
  }

  const pickup = visiblePickup(observer, grid);
  if (pickup) out.push(pickupViewOf(pickup));

  // Corpses, through the same light gate as everything else. A body lying in the dark is not visible
  // just because you know something died — `canSee` is the single authority and it takes a position,
  // so a corpse is fed the same question a standing mob is.
  for (const corpse of corpsesIn(graveyard, observer.roomId)) {
    if (observer.visible.has(tileIndexAt(grid, corpse.x, corpse.y))) out.push(corpseViewOf(corpse));
  }

  // Dropped things, through the same gate for the same reason. A dagger on the floor of an unlit room
  // is not visible because you happen to know somebody dropped one — and this is what makes a dark
  // room a real place to lose something in.
  for (const entry of itemsIn(ground, observer.roomId)) {
    if (observer.visible.has(tileIndexAt(grid, entry.x, entry.y))) out.push(groundViewOf(entry));
  }
  return out;
}

/**
 * The ground pickup this character can see in the room they are standing in, if any.
 *
 * Three conditions, and all three are already-existing rules rather than new ones:
 *
 * 1. **In this room.** Interest management stays room-scoped — the design says so explicitly, and a
 *    `RoomView` listing a torch in the room next door would be describing somewhere else. A light
 *    seen through a doorway is therefore not offered until you step in, the same as a mob standing
 *    in one.
 * 2. **Lit.** The reason the pickup needs no new message type at all: `entityEnter` already gates on
 *    visibility, so a torch on the floor of a dark room is simply not mentioned, and finding one is
 *    an act of exploring rather than of reading the entity list.
 * 3. **Not already taken by this character.** Per character, never per world — the room keeps
 *    offering its torch to everyone who has not yet found it, including someone standing next to the
 *    player who just took theirs. See the header of `pickups.ts`.
 */
function visiblePickup(observer: Player, grid: TileGrid): GroundPickup | undefined {
  const record = records.get(observer.id);
  if (!record) return undefined;
  const pickup = pickupInRoom(grid, observer.roomId);
  if (!pickup || store.hasTaken(record, pickup.key)) return undefined;
  return observer.visible.has(pickup.ty * grid.width + pickup.tx) ? pickup : undefined;
}

/**
 * Brings one player's view of the entities around them up to date, sending only the difference.
 *
 * This is the single authority on entity presence: room scope and light are both resolved here, so
 * no caller has to remember to apply one of them. `leaving` carries the direction hint for a player
 * who walked out through an exit, which is what lets the client animate the departure rather than
 * blinking the sprite out.
 */
function syncEntities(observer: Player, leaving?: { readonly id: EntityId; readonly dir: Direction }): void {
  const shown = watching.get(observer.id);
  if (!shown) return;

  const now = new Set<EntityId>();
  for (const entity of visibleEntities(observer)) {
    if (entity.id === observer.id) continue;
    now.add(entity.id);
    if (!shown.has(entity.id)) send(observer.id, { t: 'entityEnter', entity });
  }
  for (const id of shown) {
    if (now.has(id)) continue;
    send(observer.id, {
      t: 'entityLeave',
      id,
      ...(leaving?.id === id ? { to: leaving.dir } : {}),
    });
  }
  watching.set(observer.id, now);
}


/**
 * Re-sends one actor's `EntityView` to everyone who can see it.
 *
 * The engagement pointer is on the view and drives the client's combat indicator, so a fight starting or
 * ending is a change to a *visible property* of an entity that has neither moved nor entered nor left —
 * the same gap `syncTurn` was written for in Phase 9, one field along. `entityUpdate` is the message for
 * exactly this: here is an entity you already know about, as it now stands.
 */
function syncEntityState(actor: Actor): void {
  const view = sim.viewOf(actor);
  for (const observer of sim.playersIn(actor.roomId)) {
    if (!watching.get(observer.id)?.has(actor.id)) continue;
    send(observer.id, { t: 'entityUpdate', entity: view });
  }
}

/** Re-evaluates every observer standing in a room. */
function syncEntitiesIn(
  roomId: RoomId,
  leaving?: { readonly id: EntityId; readonly dir: Direction },
): void {
  for (const observer of sim.playersIn(roomId)) syncEntities(observer, leaving);
}

/**
 * Tells everyone who can already see an actor that it has turned.
 *
 * **{@link syncEntities} cannot do this**, and the distinction cost a live debugging session: it is a
 * *membership* diff. It sends `entityEnter` for whoever became visible and `entityLeave` for whoever
 * dropped out, and for an entity that was visible before and is visible now it sends nothing at all. A
 * mob that turns has not entered or left anything, so the one observer who most needs to know — the
 * person standing in front of it — was the only one never told.
 *
 * The tick's own `entityMoved` batch does not cover it either: that is built from the players who
 * *moved*, and a mob is neither a player nor moving. So a mob's `facing` reached a client only in the
 * `entityEnter` payload, meaning the very first sight of it — and `turnToward`'s whole claim, that a mob
 * turning toward you is a real change on screen rather than a line of text asserting one, was false on
 * the wire while being true in the simulation. Unit tests could not see it: they assert the simulation.
 *
 * `entityMoved` is the right message rather than a new one — it is exactly "this entity is now here,
 * facing this way", and the client already applies it to any entity id it is watching. The position is
 * sent unchanged, which is what makes it a turn.
 */
function syncTurn(actor: Actor): void {
  const move = { id: actor.id, x: actor.x, y: actor.y, facing: actor.facing };
  // Themselves first, and this was a real gap: a character is never in their own `watching` set, so
  // before this a player learned which way everyone in the room was looking and never which way they
  // were. It did not show while facing was a thing the client guessed from its own keyboard; the
  // moment facing became a *rule* — you look at what you are dealing with — the client stopped
  // guessing and this became the only way it could know.
  if (isPlayer(actor)) send(actor.id, { t: 'entityMoved', moves: [move] });
  for (const observer of sim.playersIn(actor.roomId)) {
    // Gated on what this observer can actually see, like every other entity message: a mob turning in
    // the dark is nobody's business, and telling them would put its position on the wire.
    if (!watching.get(observer.id)?.has(actor.id)) continue;
    send(observer.id, { t: 'entityMoved', moves: [move] });
  }
}

/**
 * **You face what you are dealing with** — the owner's rule, 2026-08-02.
 *
 * Facing used to mean one thing only: the way you were walking. It now means *what has your
 * attention*, which is a different fact and a better one — you turn to the door you open, the corpse
 * you go through, the person you look at, and the thing trying to kill you. Movement is only the
 * default, for when nothing else has a claim.
 *
 * Two helpers rather than one because the two kinds of claim arrive differently: an interaction with
 * a *body* knows where it stands ({@link faceToward}) and an interaction with an *exit* knows only
 * which way it lies ({@link faceDirection}).
 */
function faceToward(player: Player, x: number, y: number): void {
  if (sim.turnToward(player, x, y)) syncTurn(player);
}

/**
 * Turns to a compass direction. `up` and `down` are ignored on purpose — LPC has four sheet rows and
 * no stair-ward one, so a character working a trapdoor keeps the facing they had rather than
 * snapping to an arbitrary substitute. Phase 7's note on the row order is the same fact.
 */
function faceDirection(player: Player, dir: Direction): void {
  if (dir === 'up' || dir === 'down' || player.facing === dir) return;
  player.facing = dir;
  syncTurn(player);
}

/**
 * Folds the light currently falling on a character into their persistent `seen` set.
 *
 * Returns the tiles that were new, which is exactly the `seenDelta` payload. Returns nothing at all
 * when the character has not changed tile, because then nothing can have been newly lit.
 */
function foldSeen(player: Player): number[] {
  const record = records.get(player.id);
  const grid = world.grid(player.place);
  if (!record || !grid) return [];
  if (!sim.refreshVisible(player)) return [];
  return store.markSeen(record, player.place, grid.width * grid.height, player.visible);
}

/** Ships a Place's whole seen bitset. Sent on arriving at a Place; deltas carry it from there. */
function sendSeen(player: Player): void {
  const record = records.get(player.id);
  const grid = world.grid(player.place);
  if (!record || !grid) return;
  const bits = store.seenBits(record, player.place, grid.width * grid.height);
  send(player.id, { t: 'seen', place: player.place, bits: bitsToBase64(bits) });
}

/* -------------------------------------------------------------------------- */
/* Light: finding it, carrying it, losing it                                   */
/* -------------------------------------------------------------------------- */

/**
 * Everything a client is owed when a character's light changes for a reason other than moving.
 *
 * All four consequences are the same omission if they are forgotten, so they live together: the
 * wider disc has to be folded into `seen` and shipped, or `moveTo` refuses ground the client is
 * already drawing lit; the new radius has to reach the HUD; and anything that just came into range —
 * or dropped out of it — has to enter or leave. Called from the tick's relit list and directly by
 * the pickup path, which changes light after the tick has already drained that list.
 */
function applyRelight(player: Player): void {
  const tiles = foldSeen(player);
  if (tiles.length > 0) send(player.id, { t: 'seenDelta', tiles });
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  // Both directions: light reaching further reveals entities, light shrinking hides them.
  syncEntities(player);
  // The light is part of the character now, so the record follows it. This is the only path a change
  // can take — `recompute` queues every one of them into `relit` — so putting it here catches a torch
  // found, a torch burnt out and a Beacon crumbled without three separate call sites.
  rememberAffects(player);
}

/**
 * Copies the savable affects onto the persistent record.
 *
 * Durations are read live off the player rather than from whatever was last saved, so the call made as
 * a connection closes writes them as they actually stood. `setAffects` drops the `NoSave` ones, so this
 * is safe to call from anywhere without a caller having to know which is which. See
 * {@link PlayerStore.setAffects} for why it is not written every tick.
 */
function rememberAffects(player: Player): void {
  const record = records.get(player.id);
  if (!record) return;
  store.setAffects(record, player.affects);
}

/**
 * Copies how hurt a character is onto their record — the wound, never the value.
 *
 * Called where the light is remembered, because both are the same kind of fact: live state that has to
 * survive a disconnect. See {@link PlayerStore.setMissing} for why the difference between "you are on
 * 4 of 10" and "you are 6 down" matters the moment a maximum can change.
 */
function rememberVitals(player: Player): void {
  const record = records.get(player.id);
  if (!record) return;
  store.setMissing(record, player);
}

/**
 * Copies the level reached, the experience held, the hit points rolled and the kit worn onto the
 * record. See {@link restoreProgress}.
 *
 * Hit points and equipment are here rather than derived at login because both are **rolled** — see
 * `DESIGN-progression.md` §3 and §5. A character who reconnected into a freshly-rolled kit could
 * reroll until they liked it, and a maximum recomputed from a formula would change whenever the
 * formula did.
 */
function rememberProgress(player: Player): void {
  const record = records.get(player.id);
  if (!record) return;
  store.setProgress(record, player.level, player.experience, player.maxHp);
  store.setEquipped(record, player.equipped);
  // The bag too, since 15b. Same fact of the same kind: what a character has is theirs, and losing it
  // to a disconnect would teach players not to carry anything.
  store.setInventory(record, player.inventory);
  // And the coin, since 15c. Money that evaporated on logout would teach players to spend it before
  // quitting, which is a mechanic nobody designed.
  store.setPurse(record, player.purse);
}

/**
 * Puts a returning character's level and experience back — the owner's rule (2026-08-02): the
 * number on the file is the character's level, whatever set it, and it survives logout.
 *
 * The profile it derives is still {@link devProfile}'s arithmetic — the storage half of progression
 * arrived ahead of Phase 14b, the *derivation* half did not, and this function is the seam where
 * 14b's real ability scores and hit dice take over. Applied only when the stored level differs from
 * the fresh spawn's: a natural level-1 character keeps `playerCombatStats(1)`'s numbers rather than
 * being quietly re-profiled by the rig's slightly different level-1 row.
 *
 * **Before {@link restoreVitals}, always** — the wound is a deficit against maxima, so the maxima
 * must be right before the deficit is applied, or a 4-point wound on a 420-point warrior heals to
 * full at every login.
 */
function restoreProgress(player: Player, record: PlayerRecord): void {
  // **The kit comes back before anything derived from it.** A stored character keeps what they were
  // wearing; only a genuinely new one rolls a fresh kit, which is what stops a reconnect being a
  // reroll. `combat` is rebuilt from it below rather than stored, because armour class is a
  // derivation and storing derivations is how the two drift.
  if (record.equipped && Object.keys(record.equipped).length > 0) player.equipped = record.equipped;
  // And the bag. Restored unconditionally when present, *including an empty one*, because an empty bag
  // with a raised capacity is still a fact about the character — see `PlayerStore.save`.
  if (record.inventory) player.inventory = record.inventory;
  if (record.purse) player.purse = record.purse;

  const progress = record.progress;
  if (progress) {
    player.experience = progress.experience;
    player.level = progress.level;
    // **Stored, not derived.** `devProfile`'s arithmetic used to recompute hit points from the level
    // on every login, which meant a character's maximum silently changed whenever that function did.
    // Phase 14b rolls them once per level and keeps them — see `DESIGN-progression.md` §3. A record
    // written before this phase has no `maxHp`, so it falls back to the level's expected average
    // rather than to nothing.
    player.maxHp = progress.maxHp ?? expectedHitPoints(progress.level);
    player.hp = player.maxHp;
  }

  refitCombat(player);
}

/**
 * What a character of this level would have rolled on average — the migration path only.
 *
 * Used for records written before hit points were stored, and for nothing else. The average of
 * Duris' `number(0,3) + 1` is 2.5 below level 26 and 1 above it, so this reproduces the curve's
 * expectation without pretending to know what dice a character that never rolled any would have got.
 */
function expectedHitPoints(level: number): number {
  const low = Math.min(level, 25) - 1;
  const high = Math.max(0, level - 25);
  return Math.round(STARTING_HIT_POINTS + low * 2.5 + high);
}

/**
 * Spends whatever experience a character has banked, and tells them about it.
 *
 * Phase 14b, and the point at which the experience economy stops being decorative. Duris' own loop:
 * the cost is subtracted rather than accumulated, so one kill can carry a low-level character up more
 * than once, and *"experience to next level"* is a number they can read off their own sheet.
 *
 * The hit points gained are **added to the current pool as well as the maximum**, which is the small
 * kindness Duris also does: levelling mid-fight should help you survive it rather than merely raising
 * a ceiling you are nowhere near.
 */
function levelUpIfEarned(player: Player): void {
  const before = player.level;
  const result = applyExperience(progressRng, {
    level: player.level,
    experience: player.experience,
    maxHp: player.maxHp,
  });
  if (result.gained === 0) {
    player.experience = result.experience;
    return;
  }

  player.level = result.level;
  player.experience = result.experience;
  player.maxHp = result.maxHp;
  player.hp = Math.min(player.maxHp, player.hp + result.hitPointsGained);

  // Attack bonus and round length move with the level; armour and weapon come from the kit, which
  // levelling does not change. One rebuild, so nothing can read a stale half.
  refitCombat(player);
  sim.refreshStatus(player);

  send(player.id, {
    t: 'log',
    channel: 'system',
    text:
      `&+WYou raise a level!&N You are now level ${player.level}` +
      (result.gained > 1 ? ` (up ${result.gained} from ${before})` : '') +
      `, with ${result.hitPointsGained} more hit point${result.hitPointsGained === 1 ? '' : 's'}.`,
  });
  // Persisted at once, for the owner's rule that progress is permanent: a level gained and then lost
  // to a crash is the worst possible bug in a progression system.
  persistAdminEdit(player);
}

/** Puts a returning character's wounds back. A save with nothing missing leaves them at full. */
function restoreVitals(player: Player, record: PlayerRecord): void {
  const missing = record.missing;
  if (!missing) return;
  // Clamped, so a hand-edited save cannot put a character below the death floor on login — arriving
  // already dead is not a state anything downstream is prepared for.
  player.hp = Math.max(HP_FLOOR + 1, player.maxHp - missing.hp);
  player.mana = Math.max(0, player.maxMana - missing.mana);
  player.move = Math.max(0, player.maxMove - missing.move);
  sim.refreshStatus(player);
}

/**
 * Puts a returning character's timed effects back on them.
 *
 * The counterpart to the `taken` set, and it has to exist for the same reason that does: without it a
 * disconnect took the lantern away and left every room this character had emptied still empty, which
 * is a one-way loss of light that no amount of walking can undo. Restored *before* the first
 * `foldSeen` of the session, so the character's own bitset and their first room description are both
 * computed at the radius they are actually carrying.
 *
 * The list is validated on the way off disk (see `decodeAffects`), so what arrives here is already
 * catalogue-resolvable — a light source the game no longer ships was dropped there rather than
 * half-restored here. Assigned wholesale and then folded once, which is the same discipline as
 * everywhere else: the list is the truth and the derived stats follow it, never the other way round.
 */
function restoreAffects(player: Player, record: PlayerRecord): void {
  if (record.affects.length === 0) return;
  // Copied, because the record's own list is what gets written back to disk and the simulation
  // decrements durations in place every tick. Sharing them would have the save file quietly track the
  // live countdown and defeat the debounce.
  sim.restoreAffects(player, record.affects.map((affect) => ({ ...affect })));

  const carried = player.light;
  if (carried) {
    const left = sim.lightRemaining(player);
    console.log(`[light] ${record.name}: resumed ${carried.id}, ${left === undefined ? 'unlimited' : `${left}ms`} left`);
  }
}

/**
 * The catalogue's names carry their own article — "a pitch-soaked torch", "the Beacon of Hope" —
 * which is right for "You pick up a pitch-soaked torch" and wrong for everything possessive. This
 * strips it so the same name can be used both ways.
 */
function bare(name: string): string {
  return name.replace(/^(?:an?|the) /i, '');
}

/**
 * The sentence for each {@link PickupOutcome}.
 *
 * Separate from the decision, which lives in `pickups.ts`: there is one right answer to "does this
 * go in their hand" and several reasonable ways to say it, and the wording is the half that gets
 * revised. Every line names both sources, because "it is no use to you" with nothing to compare
 * against reads as the game refusing a pickup for no reason.
 */
function pickupLine(outcome: PickupOutcome, carried: LightSource | undefined, found: LightSource): string {
  if (!carried) return `You pick up ${found.name}, and the dark draws back.`;
  switch (outcome) {
    case 'equip':
      return `You pick up ${found.name}; it outshines your ${bare(carried.name)}.`;
    case 'refresh':
      return `You pick up ${found.name} and let the spent one fall.`;
    case 'replace':
      return `Your ${bare(carried.name)} is all but spent; you take ${found.name} in its place.`;
    case 'spare':
      // "Serves you better" rather than "burns brighter": most of these are a tie on radius settled
      // by burn time — a fresh torch against a candle — and claiming a difference in brightness the
      // catalogue does not have is the kind of line a player checks the HUD over.
      return `You pick up ${found.name}, but your ${bare(carried.name)} serves you better; it is no use to you.`;
  }
}

/**
 * Walks a character onto whatever their room has lying on the floor.
 *
 * Tile-exact: you pick a light up by standing on its tile, not by passing near it. That is
 * affordable to be strict about because the tile is *visible* first — it arrives as an `item` entity
 * the moment light falls on it, and click-to-move will walk you onto it — so the strictness reads as
 * precision rather than as the game refusing a pickup you thought you had made. A tick covers 15 px
 * against a 32 px tile, so no tile can be stepped over between two checks.
 *
 * Deliberately **not** broadcast to the room. Everyone finds their own copy, so "Someone picks up a
 * torch" would be followed by that same torch still lying there for the witness — a shared-world
 * sentence describing a per-character world. See the header of `pickups.ts`.
 */
function collectPickup(player: Player): void {
  const record = records.get(player.id);
  const grid = world.grid(player.place);
  if (!record || !grid) return;

  const pickup = pickupInRoom(grid, player.roomId);
  if (!pickup || !standingOn(pickup, player.x, player.y)) return;
  // `markTaken` answers false if this character already had it, which also makes a second tick
  // standing on the same tile a no-op rather than a repeated announcement.
  if (!store.markTaken(record, pickup.key)) return;

  const found = pickup.source;
  const carried = player.light;
  // Never summed and never simply "the new one": two torches are not a lantern, and a candle found
  // while holding a lantern is a downgrade. `pickups.ts` owns the comparison, including the part
  // `bestLight` deliberately will not make — how much is left in what you are already holding.
  const outcome = pickupOutcome(carried, sim.lightRemaining(player), found);

  // A spare is taken all the same, and gone. Without an inventory there is nowhere to put one, and
  // leaving it on the floor would have a lantern-bearer trip the same message every time they
  // crossed the room. Saying so plainly is better than a silent nothing.
  if (outcome !== 'spare') sim.setCarriedLight(player, found);
  send(player.id, { t: 'log', channel: 'room', text: pickupLine(outcome, carried, found) });

  // The item has left this character's world even when it was no upgrade, so the client is told to
  // stop drawing it. The relit path re-syncs too when the light actually changed; this covers the
  // case where it did not.
  syncEntities(player);
}

/**
 * Turns a timed effect lapsing into something the player can read.
 *
 * The generic case is the catalogue's `wearOff` line, which is Duris' `wear_off_message` and is why the
 * prose lives with the type rather than at the site that installs it: the expiry pass does not know
 * what expired, only that something did.
 *
 * The two chains get better sentences than a generic one could write, and both name their successor.
 * The light's are the older of the two and the reason `announceLight` existed at all: a radius that
 * silently shrinks in a dark zone reads as a bug, so the announcement is part of the mechanic.
 */
function announceAffect(event: AffectEvent): void {
  // Mobs run affects through the same expiry pass — that is the point of one list and one map — but
  // there is nobody behind a mob to read a line. Asked rather than assumed, so the day a mob's expiry
  // *should* say something out loud ("the ogre's rage subsides") this is where it is noticed.
  if (!isPlayer(event.actor)) return;
  const player = event.actor;

  const text = affectLine(event);
  if (text) send(player.id, { t: 'log', channel: 'system', text });

  // A warning re-anchors the HUD's own clock, which is the one moment in a countdown where it matters.
  // Between one message and the next the client counts `remainingMs` down itself against Phaser's
  // scene clock — that is what keeps it smooth without sixty messages a second — and that clock stalls
  // while the tab is in the background. A player who came back to the tab could therefore read "2:41
  // left" off a torch with ten seconds in it. Expiry already re-syncs through the relit path; this
  // gives the warning the same guarantee.
  if (event.kind === 'expiring') {
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  }
}

function affectLine(event: AffectEvent): string | undefined {
  const { affect, chained, kind } = event;

  if (affect.type === 'light') {
    // Resolved from the id rather than from `player.light`, which by this point is already the
    // successor: the sentence is about the thing that has just gone.
    const source = affect.context === undefined ? undefined : lightSource(affect.context);
    if (!source) return undefined;
    const name = bare(source.name);
    if (kind === 'expiring') return `Your ${name} is burning low.`;
    const replacement = chained[0]?.context === undefined ? undefined : lightSource(chained[0].context);
    return replacement
      ? `Your ${name} crumbles away, leaving ${replacement.name}.`
      : `Your ${name} gutters and dies. The dark closes in.`;
  }

  // The rest cycle. The wait ending is the good news and gets the better line; the reward ending falls
  // through to the catalogue's own wear-off prose, and the wait re-arming says nothing at all, because
  // "you settle back down" every ninety seconds for as long as someone sits still is a nag.
  if (kind === 'expired' && affect.type === 'settling') {
    return chained.length > 0 ? 'You catch your second wind.' : undefined;
  }

  return kind === 'expired' ? affectKind(affect.type)?.wearOff : undefined;
}

/**
 * A mob deciding it has seen you.
 *
 * Two halves, and the *turn* is the one that matters: `facing` is on `EntityView` and drives which of the
 * four LPC sheet rows the client draws, so a mob turning toward you is a real change on screen rather than a
 * line of text claiming something happened. The sentence is the MUD half of the same event.
 *
 * **It notices and does nothing else.** It cannot attack — engagement is Phase 11, and
 * `DESIGN-engagement.md` requires the first combat code to make stickiness explicit rather than growing out
 * of something adjacent. So the wording says what is true: it has seen you, and it is looking at you.
 *
 * A remembered target gets no line. The mob has already announced them once, and repeating it every time
 * somebody steps back over a threshold is the same nag the carried light's warning latch exists to prevent —
 * but it still *turns*, because that is where it is looking now.
 */
function announceNotice(event: NoticeEvent): void {
  const { mob, target } = event;
  if (sim.turnToward(mob, target.x, target.y)) {
    // Room-scoped and gated on light like every other entity update: a mob turning in the dark is nobody's
    // business until a light falls on it.
    //
    // Both calls, and they do different jobs. `syncEntitiesIn` settles *membership* — it is what brings the
    // mob into view for anyone whose light has just reached it — and `syncTurn` carries the new facing to
    // everyone who could already see it. Only the second one delivers the turn; see {@link syncTurn}.
    syncEntitiesIn(mob.roomId);
    syncTurn(mob);
  }
  // The chase starts here, before the `remembered` gate: being recognised on sight is exactly when
  // something should come after you again, and a mob that announced you once and then let you walk away
  // for ever would make memory the opposite of what §2.3 wants it for.
  beginHunt(hunts, mob, target);

  // **And if it is already standing next to you, it attacks.** This closes a gap Phase 11 left open
  // without anyone noticing: engagement was only ever started by a *hunt arriving*, so the 31 aggressive
  // mobs that do not hunt — sentinels, and anything without `ACT_MEMORY` — would notice you, say so, turn
  // to face you, and then stand there for ever.
  //
  // `openingTarget` rather than `target`, because with several people in the room the mob has no threat
  // history to read and Duris' own rule is the better answer: it goes for whoever looks weakest. Threat
  // takes over from the first blow. See `threat.ts` for why both rules are kept.
  if (mob.fighting === undefined && mob.roomId === target.roomId) {
    const chosen = openingTarget(sim, mob) ?? target;
    if (engage(scheduler, mob, chosen)) syncEntityState(mob);
  }

  if (event.remembered) return;

  send(target.id, {
    t: 'log',
    channel: 'combat',
    text: `${capitalise(mob.name)} fixes its eyes on you.`,
  });
  // The room sees it too, rendered per recipient — an observer who cannot see the mob is told nothing, which
  // `actToRoom` resolves through the same `canSee` the entity gate uses.
  actToRoom(target, 'combat', (who) => `${capitalise(mob.name)} turns to watch ${who}.`);
}


/**
 * Marks a swing as yours or as one landing on you — Duris' own convention, and the reason a fight
 * scans at a glance instead of having to be read.
 *
 * `fight.c`'s `dam_message` brackets the attacker's copy of the line in **green** `-=[ … ]=-` and the
 * victim's copy in **red**, and nothing at all for the bystanders. Two colours carry the only question
 * that matters while a fight is running — *is this me hitting, or me being hit* — without a word of
 * prose spent on it. A player watching two mobs brawl gets plain lines, correctly: neither is theirs.
 *
 * Self-inflicted is possible in principle (a spell that rebounds), so the attacker case is tested
 * first and once. Green wins that tie: it is the blow you chose to throw.
 */
function bracket(observer: Player, outcome: AttackOutcome, text: string): string {
  if (observer.id === outcome.attacker.id) return `&+G-=[&N ${text} &+G]=-&N`;
  if (observer.id === outcome.target.id) return `&+R-=[&N ${text} &+R]=-&N`;
  return text;
}

/**
 * One swing, as the log reads it.
 *
 * **The roll is printed.** `CLAUDE.md` calls for "combat rolls" in the text log and `rules.ts` has carried
 * the natural d20 on `AttackResult` since it was written, unread — showing it is what makes a fight
 * auditable rather than a health bar moving for reasons nobody can check. A critical and a fumble say so,
 * because a natural 20 and a natural 1 are the two rolls with rules attached.
 */
function announceAttack(outcome: AttackOutcome): void {
  const { attacker, target } = outcome;
  // A helpless target has no armour class worth quoting — the roll is shown because a fight stays
  // auditable, but printing "vs AC 11" beside a blow that could not have missed would be a lie about why
  // it landed.
  const rollText = outcome.helpless
    ? `[d20 ${outcome.natural} — defenceless]`
    : `[d20 ${outcome.natural}${outcome.natural === outcome.total ? '' : ` → ${outcome.total}`} vs AC ${target.combat.armourClass}]`;
  // Dim, because the roll is the machinery behind the sentence rather than part of it. It stays
  // readable and stops competing with the blow for the eye.
  const roll = `&+L${rollText}&N`;
  // The two rolls with rules attached get the two colours a MUD reserves for them: a critical is
  // bright yellow and a fumble is the same dim grey as the machinery, because a fumble *is* the
  // absence of an event. Everything between is uncoloured — if every line shouted, none would.
  const verb = outcome.critical
    ? '&+Ycritically hits&N'
    : outcome.hit
      ? 'hits'
      : 'misses';

  const line = (who: string, whom: string): string =>
    outcome.hit
      ? `${who} ${verb} ${whom} for ${outcome.damage} damage. ${roll}`
      : `${who} ${outcome.fumble ? '&+Lfumbles against&N' : verb} ${whom}. ${roll}`;

  // Per recipient, gated on sight, like every other line about an entity — §4.10's warning about
  // pre-rendered strings is exactly this shape of message.
  for (const observer of sim.playersIn(attacker.roomId)) {
    const seesAttacker = observer.id === attacker.id || (watching.get(observer.id)?.has(attacker.id) ?? false);
    const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
    if (!seesAttacker && !seesTarget) continue;
    const who = observer.id === attacker.id ? 'You' : seesAttacker ? capitalise(attacker.name) : 'Something';
    const whom = observer.id === target.id ? 'you' : seesTarget ? target.name : 'something';
    // "You hits" — the one place the shared sentence needs a different verb form. The pattern reads
    // through the colour codes the verbs now carry, which is why they are in the alternation.
    const text = observer.id === attacker.id
      ? line('You', whom).replace(
          /^You (&\+Ycritically hits&N|hits|misses|&\+Lfumbles against&N)/,
          (_m, v: string) =>
            `You ${v
              .replace(/^hits$/, 'hit')
              .replace(/^&\+Ycritically hits&N$/, '&+Ycritically hit&N')
              .replace(/^misses$/, 'miss')
              .replace(/^&\+Lfumbles against&N$/, '&+Lfumble against&N')}`,
        )
      : line(who, whom);
    send(observer.id, { t: 'log', channel: 'combat', text: bracket(observer, outcome, text) });

    // The structured form too, so the client can animate rather than parse prose.
    send(observer.id, {
      t: 'attackResolved',
      attacker: attacker.id,
      target: target.id,
      hit: outcome.hit,
      critical: outcome.critical,
      damage: outcome.damage,
      natural: outcome.natural,
      // Only the four that have mechanisms behind them. `dodged`, `parried` and `blocked` wait for the
      // defence skills in Phase 19; the client is told to treat anything it does not know as a miss.
      outcome: outcome.critical ? 'critical' : outcome.fumble ? 'fumble' : outcome.hit ? 'hit' : 'miss',
    });
  }

  if (!outcome.incapacitated) return;
  // The fight ended, and *why* differs by what went down. A player is spared by the mercy rule and is
  // still alive in the dying window; a mob has no such window and is simply dead. Saying the same
  // sentence for both would misdescribe one of them — and the difference matters to a player deciding
  // whether to go back for a body.
  const slain = !isPlayer(target);
  for (const observer of sim.playersIn(target.roomId)) {
    const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
    if (!seesTarget) continue;
    send(observer.id, {
      t: 'log',
      channel: 'combat',
      text: observer.id === target.id
        ? 'You collapse, and the fighting stops.'
        : slain
          ? `${capitalise(target.name)} is dead!`
          : `${capitalise(target.name)} collapses, and the fighting stops.`,
    });
  }
}


/**
 * A player who has bled out. Phase 14b's last clause, and the answer Phase 13 left open.
 *
 * **Nothing reached here before.** `combat.ts` routes only mobs to {@link resolveDeath} — a player at
 * zero is spared by the mercy rule into the dying window, and the window's *end* was never built. A
 * character who bled past the floor simply lay at negative hit points for ever, and the only way back
 * was an admin edit. So this is not a penalty bolted onto a death; it is the death.
 *
 * The order is the interesting part, and each step depends on the one before:
 *
 * 1. **The corpse is made first**, from the body, while it still has a position — Phase 13's rule, and
 *    the same reason `resolveDeath` does it in that order.
 * 2. **The cost is charged before the respawn**, so the line that reports it can be sent with the
 *    arrival rather than a tick later, and so a character cannot log out in the gap and keep the level.
 * 3. **The respawn is a full arrival**, the same one a teleport runs: fog, room, entities. Restoring
 *    hit points without it would leave a live character standing in a room the client thinks is empty.
 *
 * `DESIGN-progression.md` §6.
 *
 * ## What death costs, now that a corpse can hold things
 *
 * **Your bag goes into the corpse. What you are wearing stays on you.** 14b deferred this with *"a
 * corpse you cannot loot is a character permanently disarmed"*; 15b makes the corpse lootable, so the
 * question is live and this is the middle it lands on.
 *
 * Taking everything is the conventional MUD answer and it is the wrong one here — the owner's stated
 * horror is *"there is nothing worse than playing a game of months and losing everything due to one
 * mistake"*, and a naked corpse run through the zone that just killed you is exactly that mistake
 * compounding. Taking *nothing* makes death a teleport with an experience bill. The split costs you
 * the thing you chose to be carrying, leaves you able to fight your way back to it, and makes the
 * thirty-minute player-corpse clock in `corpses.ts` a deadline that means something.
 */
function reapPlayer(player: Player): void {
  const diedIn = player.roomId;

  for (const observer of sim.playersIn(diedIn)) {
    if (observer.id === player.id) continue;
    if (!watching.get(observer.id)?.has(player.id)) continue;
    send(observer.id, { t: 'log', channel: 'combat', text: `${capitalise(player.name)} has died.` });
  }

  // Before the body moves. A player's corpse decays on its own longer clock — see `corpses.ts`.
  // The bag goes with it and the bag is emptied here, so the two halves cannot both hold the same
  // dagger — a duplication bug that would be invisible until somebody noticed the world getting richer.
  // Flattened: a stack of five arrows is five arrows on the body, not one entry.
  const carried = loose(player.inventory);
  const corpse = makeCorpse(graveyard, player, true, carried);
  player.inventory = emptyInventory(player.inventory.capacity);

  const cost = applyDeathCost({ level: player.level, experience: player.experience, maxHp: player.maxHp });
  player.level = cost.level;
  player.experience = cost.experience;
  // Levelling down leaves the profile stale — attack bonus and round length are read off the level.
  // Armour and weapon come from the kit, which dying does not touch.
  refitCombat(player);

  // Whole again, and standing. `setStance` rather than assignment: both axes are on the wire, and a
  // character revived into a posture the client does not know about cannot be moved.
  player.hp = player.maxHp;
  player.mana = player.maxMana;
  player.move = player.maxMove;
  sim.setStance(player, { status: 'normal', posture: 'standing' });
  // The wind of whatever killed them dies with them; a corpse run should not start out of breath.
  player.windedMs = 0;

  const home = world.spawnRoom();
  const from = player.roomId;
  const fromPlace = player.place;
  if (sim.relocate(player, home.id)) {
    announceArrival(player, from, fromPlace);
    for (const actor of clearEngagements(scheduler, sim, player)) syncEntityState(actor);
  }
  // The body has gone and the corpse has taken its place; tell whoever is still standing there both
  // at once, the same way `resolveDeath` does it.
  syncEntitiesIn(diedIn);
  for (const observer of sim.playersIn(diedIn)) {
    if (!watching.get(observer.id)?.has(corpse.id)) continue;
    send(observer.id, {
      t: 'log',
      channel: 'room',
      text: `${capitalise(corpseName(corpse))} falls to the ground.`,
    });
  }

  send(player.id, { t: 'log', channel: 'combat', text: '&+RYou have died.&N' });
  // **The cost, named.** Phase 14b's completion test is "dying costs something you can point at in
  // the log", so it is spelled out rather than left to be inferred from a number that moved.
  send(player.id, {
    t: 'log',
    channel: 'system',
    text:
      cost.experienceLost === 0
        ? 'You were too green to lose anything by it. Your corpse lies where you fell.'
        : `It cost you ${cost.experienceLost} experience` +
          (cost.levelsLost > 0 ? ` and ${cost.levelsLost} level${cost.levelsLost === 1 ? '' : 's'}` : '') +
          `. Your corpse lies where you fell — ${corpse.of}'s remains, in ${describeRoomName(diedIn)}.`,
  });
  // **Said only when there was something to lose**, and said plainly, because it is the half of the
  // cost a player can still do something about. The clock is named for the same reason: thirty minutes
  // is a deadline, and a deadline you are not told is just a thing that happened.
  if (carried.length > 0) {
    send(player.id, {
      t: 'log',
      channel: 'system',
      text:
        `&+YYou were carrying ${carried.length} thing${carried.length === 1 ? '' : 's'}, and ${
          carried.length === 1 ? 'it is' : 'they are'
        } in your corpse.&N ` +
        `Your gear is still on you. The body lasts about thirty minutes.`,
    });
  }
  persistAdminEdit(player);
}

/** A room's name for a sentence, or its id when the room is not one this server loaded. */
function describeRoomName(id: RoomId): string {
  return world.locate(id)?.room.name ?? `room ${id}`;
}

/**
 * A body reaching the end: pay out, remove it, and leave a corpse where it fell.
 *
 * Order matters and it is not obvious. The **corpse is created before the actor is removed**, because it
 * takes its position from the body — a corpse placed after the fact would have to remember coordinates
 * that no longer belong to anything. And the entity sync runs **after both**, so observers receive one
 * consistent picture rather than a frame in which the mob has gone and nothing has replaced it.
 */
function resolveDeath(death: Death): void {
  const { actor, killer } = death;

  // Said before the body goes, so the sentence still has something to name.
  for (const observer of sim.playersIn(actor.roomId)) {
    if (!watching.get(observer.id)?.has(actor.id)) continue;
    send(observer.id, {
      t: 'log',
      channel: 'combat',
      text: killer && observer.id === killer.id
        ? `You have slain ${actor.name}!`
        : `${capitalise(actor.name)} is dead!`,
    });
  }
  // Structured, so a client can play a death animation rather than parse prose.
  for (const observer of sim.playersIn(actor.roomId)) {
    if (!watching.get(observer.id)?.has(actor.id)) continue;
    send(observer.id, { t: 'died', id: actor.id, ...(killer ? { killer: killer.id } : {}) });
  }

  // **Experience, divided by contribution rather than handed to whoever landed the last blow.** This is
  // the choice that makes tanking and healing viable with no role system — see `experience.ts`.
  const template = isMob(actor) ? mobTemplates.get(actor.vnum) : undefined;
  const pool = template?.experience ?? 0;
  // **Coin is awarded on death, not looted.** Owner's call (2026-08-03): *"maybe we can just have the
  // coins awarded when a mob is killed… then we can skip the looting currency altogether."* Right for
  // the same reason experience works this way — coin is a number rather than a thing, and walking to a
  // body to collect a number is ceremony with no decision in it. Duris keeps a mob's purse on the same
  // line of the same file as its experience, which says it thought so too.
  const purse = template?.coins ?? {};
  const shares = divideExperience(pool, death.contributions);

  // **Apportioned across everyone at once, not floored per earner.** Owner caught the first version in
  // play: a fisherman carrying 3 copper and 2 silver paid 1 silver 1 copper to one killer and a single
  // copper to the other, and the rest simply vanished. Flooring each share destroys a third to a half
  // of a small purse at *every* ratio — and small purses are most of the world. `apportion` hands out
  // the remainders, so what a mob carried is exactly what the room receives.
  // **Weighted by the raw contribution, not by the experience it already bought.** Owner's rule
  // (2026-08-03): the split "should go on how much they contribute to the fight, either by damage or
  // healing" — which `contributionValue` already measures, folding damage dealt, damage taken and
  // support into one number. Feeding the *floored* experience back in would round twice: a healer
  // whose experience share lost a point to flooring would lose coin for the same reason, compounding
  // an error the apportionment above exists to remove.
  const weights = shares.map((award) => contributionValue(award.contribution));
  const cuts = new Map<string, number[]>();
  for (const kind of CURRENCIES) {
    const whole = purse[kind] ?? 0;
    if (whole > 0) cuts.set(kind, apportion(whole, weights));
  }

  for (const [index, award] of shares.entries()) {
    const earner = sim.player(award.actor);
    if (!earner) continue;
    earner.experience += award.experience;

    const gained: Record<string, number> = {};
    for (const [kind, split] of cuts) {
      const cut = split[index] ?? 0;
      if (cut > 0) gained[kind] = cut;
    }
    if (!purseIsEmpty(gained)) {
      earner.purse = addCoins(earner.purse, gained);
      send(earner.id, {
        t: 'log',
        channel: 'system',
        text: `You receive &+Y${describePurse(gained)}&N.`,
      });
    }
    const { dealt, taken, supported } = award.contribution;
    // The breakdown is printed because the *rule* is the interesting part: a player who tanked and dealt
    // nothing should be able to see that this is why they were paid.
    const how = [
      dealt > 0 ? `${dealt} dealt` : undefined,
      taken > 0 ? `${taken} taken` : undefined,
      supported > 0 ? `${supported} support` : undefined,
    ].filter(Boolean).join(', ');
    send(earner.id, {
      t: 'log',
      channel: 'system',
      text: `You gain ${award.experience} experience${how ? ` (${how})` : ''}.`,
    });
    // **And this is where it finally buys something.** Experience has been earned and banked since
    // Phase 13 with nothing to spend it on: the number went up and never did anything. Phase 14b.
    levelUpIfEarned(earner);
    // **Checkpointed at the award, not only at level-up and disconnect.** Found live: a browser
    // reload races the dying socket's close handler against the new session's join, and the join
    // can read the record before the close writes it — 388 experience evaporated exactly that way.
    // A kill is rare enough that paying for the flush here is nothing, and it makes the owner's
    // rule — progress is permanent — hold for the experience itself, not only for the level it buys.
    const ledger = records.get(earner.id);
    if (ledger) {
      rememberProgress(earner);
      store.flush(ledger);
    }
    send(earner.id, { t: 'self', view: sim.selfViewOf(earner) });
  }

  // **A mob's corpse holds everything it had — carried *and* worn.** Phase 15c, and note the deliberate
  // asymmetry with `reapPlayer`, which puts only the bag in and leaves the gear on the body: a player's
  // worn kit is theirs and losing it to one mistake is the thing the owner named as the worst feeling in
  // a game, while a mob's worn kit **is** the loot. Killing a guard for the sword it was holding is the
  // oldest reward loop there is, and a guard that kept its sword would make the fight pointless.
  const spoils = isMob(actor) ? [...actor.carrying, ...Object.values(actor.equipped).filter((i) => i !== undefined)] : [];
  const corpse = makeCorpse(graveyard, actor, isPlayer(actor), spoils);
  const room = actor.roomId;
  sim.remove(actor.id);
  // Every mob forgets it, and nothing keeps chasing it.
  forgetTarget(awareness, actor.id);
  forgetQuarry(hunts, actor.id);
  forgetThreat(threat, actor.id);
  scheduler.cancel(actor.id);
  awareness.delete(actor.id);
  hunts.delete(actor.id);
  ledger.delete(actor.id);
  threat.delete(actor.id);

  // The body is gone and the corpse has taken its place; tell the room both at once.
  syncEntitiesIn(room);
  for (const observer of sim.playersIn(room)) {
    if (!watching.get(observer.id)?.has(corpse.id)) continue;
    send(observer.id, {
      t: 'log',
      channel: 'room',
      text: `${capitalise(corpseName(corpse))} falls to the ground.`,
    });
  }
}

/**
 * A mob changing its mind about who it is fighting.
 *
 * The visible payoff of the threat table, and it has to be *said* — the combat indicator on the entity
 * shows who a mob is on, but a switch that happened silently would read as the log skipping a beat. §2.7's
 * whole point is that a player can cause this deliberately, and a mechanic you cause deliberately has to
 * be one you can see land.
 */
function announceSwitch(change: TargetSwitch): void {
  const { mob, to } = change;
  for (const observer of sim.playersIn(mob.roomId)) {
    if (!watching.get(observer.id)?.has(mob.id)) continue;
    const whom = observer.id === to.id ? 'you' : to.name;
    send(observer.id, {
      t: 'log',
      channel: 'combat',
      text: `${capitalise(mob.name)} turns on ${whom}!`,
    });
  }
}

/**
 * One mob coming to another's aid.
 *
 * The source's own three lines, per recipient — it says something different to the helper, to the ally
 * and to everyone else, which is exactly what `act()` was built for in Phase 1.
 */
function announceAssist(event: AssistEvent): void {
  const { helper, ally, foe } = event;
  for (const observer of sim.playersIn(helper.roomId)) {
    if (!watching.get(observer.id)?.has(helper.id)) continue;
    const whom = observer.id === foe.id ? 'you' : foe.name;
    send(observer.id, {
      t: 'log',
      channel: 'combat',
      text: `${capitalise(helper.name)} assists ${ally.name} heroically, and turns on ${whom}!`,
    });
  }
}

/**
 * What a chase looks like from inside the game.
 *
 * Only `entered` says anything, and only to the room it walked into. Giving up is silent on purpose: the
 * mob has no way to tell you it has lost interest, and a line saying so would be the game narrating its own
 * state rather than the world behaving. Arriving in your room is silent too — that is the moment Phase 11
 * turns into a blow, and announcing it twice would read as a stutter.
 */
function announceHunt(event: HuntEvent): void {
  if (event.kind !== 'entered' || event.to === undefined) return;
  const from = event.heading ? OPPOSITE[event.heading] : undefined;
  for (const observer of sim.playersIn(event.to)) {
    // Per observer and gated on sight, like every other line about an entity: somebody who cannot see the
    // thing that just walked in is told nothing. §4.10's warning about pre-rendered strings is why this
    // builds the sentence inside the loop rather than once outside it.
    if (!watching.get(observer.id)?.has(event.mob.id)) continue;
    send(observer.id, {
      t: 'log',
      channel: 'combat',
      text: from
        ? `${capitalise(event.mob.name)} arrives from the ${from}.`
        : `${capitalise(event.mob.name)} arrives.`,
    });
  }
}

/**
 * One flee attempt, resolved and said out loud — Phase 14, and `DESIGN-engagement.md` §5's only
 * voluntary way out of a fight.
 *
 * **The single entry point for both kinds of flight**: a player typing `flee`, and a mob whose morale
 * broke on a round boundary. `attemptFlee` decides what happened and this renders it, which is the same
 * split every other event in this file keeps — and it is what stops a servant bolting and a character
 * escaping from drifting into two different mechanics.
 */
function runFlee(actor: Actor): FleeOutcome {
  // Both captured *before* the attempt, and the second is load-bearing rather than tidy.
  //
  // `left` is who is owed the departure line — a successful flight moves the body out of this room, and
  // the line belongs to the people it left standing there. **`sawIt` is the harder half.** `canSee`
  // tests the subject's *tile* against the observer's lit set, so asking it after the body has gone
  // through the doorway answers about a tile in the next room, and every escape comes out as
  // "Someone flees west!" — observed live before this line existed. Snapshotting who could see it while
  // it was still standing here is the fix, and it is the same ordering hazard Phases 9 and 10 each hit
  // once: the observation has to be made while the fact is still true, not when the message is written.
  // The room it is fleeing *from*, captured for the same reason `sawIt` is: by the time the outcome is
  // worded the body has already gone, and the exit that was taken belongs to the room it left.
  const from = actor.roomId;
  const left = [...sim.playersIn(actor.roomId)];
  const sawIt = new Set(left.filter((observer) => canSee(observer, actor)).map((observer) => observer.id));
  const outcome = attemptFlee({ world, sim, scheduler, rng: combatRng }, actor);
  const self = isPlayer(actor) ? actor : undefined;

  // Per recipient, like every line that names an actor — a body nobody could see is still "someone",
  // which is the whole reason `act.ts` exists.
  const toRoom = (render: (who: string) => string): void => {
    for (const line of actLines(actor, left, (observer) => sawIt.has(observer.id), render)) {
      send(line.to, { t: 'log', channel: 'combat', text: line.text });
    }
  };

  switch (outcome.kind) {
    case 'helpless':
      if (self) send(self.id, { t: 'log', channel: 'error', text: 'You are in no state to run.' });
      break;

    case 'scrambled':
      // `do_flee`'s own consolation: the round is spent, and you are on your feet for the next one.
      if (self) {
        send(self.id, { t: 'log', channel: 'combat', text: 'You scramble madly to your feet!' });
        send(self.id, { t: 'self', view: sim.selfViewOf(self) });
      }
      toRoom((who) => `${capitalise(who)} scrambles madly to their feet!`);
      syncEntitiesIn(actor.roomId);
      break;

    case 'cornered':
      if (self) send(self.id, { t: 'log', channel: 'combat', text: 'You look for a way out, and find none!' });
      toRoom((who) => `${capitalise(who)} looks for a way out, and finds none!`);
      break;

    case 'panicked':
      if (self) send(self.id, { t: 'log', channel: 'combat', text: 'PANIC! You could not escape!' });
      toRoom((who) => `${capitalise(who)} tries to flee, but cannot get away!`);
      break;

    case 'fled': {
      // **A portal is named, because otherwise the line is a lie of omission.** Owner's report
      // (2026-08-03): a mob fled east out of a room whose only visible opening was north, and the
      // message said "flees east" — so it read as the game moving something through a wall. 6.1% of
      // the world's exits are portals: links the layout pass could not reconcile with the map's own
      // coordinates, real in the room graph and carved into no tiles. The direction is kept as well
      // as the portal, so the line still says which way to follow.
      const through = world.locate(from)?.room.exits[outcome.dir]?.portal;
      toRoom((who) =>
        through
          ? `${capitalise(who)} flees through a portal to the ${outcome.dir}!`
          : `${capitalise(who)} flees ${outcome.dir}!`,
      );
      // Everyone whose pointer this broke — they stopped swinging and their combat indicator must go.
      for (const other of outcome.changed) syncEntityState(other);
      if (self) {
        // The wind is named or it is a mystery: without this line the player's bars simply stop for a
        // minute and the game looks broken. Review's finding, and it is right — a cost the player
        // cannot see is indistinguishable from a bug.
        const winded = self.windedMs > 0 ? ' You are winded, and will not recover until you catch your breath.' : '';
        send(self.id, { t: 'log', channel: 'combat', text: `You flee ${outcome.dir}!${winded}` });
        // The whole arrival, exactly as walking through the exit would produce: the departure diff for
        // the room behind, the map and bitset if the Place changed, the new room's description.
        announceArrival(self, outcome.from, outcome.fromPlace, outcome.dir);
      } else {
        // A mob moved itself, so both rooms need re-evaluating — nothing else in the tick will do it.
        syncEntitiesIn(outcome.from);
        syncEntitiesIn(actor.roomId);
      }
      // **And it comes after you.** Fleeing buys distance from the blow, not from the encounter: a
      // pursuer that can path starts hunting, which is Phase 10's machinery answering Phase 14's exit.
      // `beginHunt` refuses a mob whose rule cannot chase, so this needs no guard of its own.
      const chaser = outcome.wasFighting;
      if (self && chaser && isMob(chaser)) beginHunt(hunts, chaser, self);
      // The mirror (owner's pick, §5b option 2): a mob that flees leaves everyone it escaped
      // pointing at it, and walking after it re-engages *that* body rather than its freshest twin.
      markPursuers(actor, outcome.changed);
      // Fleeing is an escape, not a reposition: a player who runs gives up any chase of their own.
      if (self) self.pursuing = undefined;
      break;
    }
  }
  return outcome;
}

/** `affects` — the text half of the display path. Duris shows the same list on `score`. */
function listAffects(player: Player): void {
  const shown = summariseAffects(player.affects);
  if (shown.length === 0) {
    send(player.id, { t: 'log', channel: 'system', text: 'You are not affected by anything.' });
    return;
  }
  send(player.id, { t: 'log', channel: 'system', text: 'You are affected by:' });
  for (const affect of shown) {
    // Padded with `padEnd` rather than a format specifier: `console.log` has no width specifiers in
    // Node and neither has a template string, and `%-14s` printed literally is `CLAUDE.md` gotcha 4.
    const clock = affect.remainingMs === undefined ? '' : `  ${formatDuration(affect.remainingMs)}`;
    send(player.id, { t: 'log', channel: 'system', text: `  ${affect.name.padEnd(20)}${clock}` });
  }
}

/** `m:ss` for a countdown a player reads in the log, matching the HUD's own clock. */
function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Room description                                                            */
/* -------------------------------------------------------------------------- */

function buildRoomView(player: Player): RoomView | undefined {
  const room = sim.room(player.roomId);
  if (!room) return undefined;

  const adjacent: Partial<Record<Direction, AdjacentRoomView>> = {};
  for (const dir of DIRECTIONS) {
    const exit = room.exits[dir];
    if (!exit) continue;
    const target = sim.room(exit.to);
    if (!target) continue;
    adjacent[dir] = {
      id: target.id,
      name: target.name,
      sector: target.sector,
      occupied: sim.playersIn(target.id).length > 0,
    };
  }

  return {
    room,
    // Lit entities only. The room view is a full replacement on the client, so an unlit mob standing
    // in a corner — or an unlit torch lying in one — must be absent from it for the same reason it
    // gets no `entityEnter`: remembered ground is terrain, not a live radar.
    entities: visibleEntities(player),
    adjacent,
  };
}

/**
 * What a room says when nobody has written it yet. Owner-requested, 2026-08-02.
 *
 * **Rendered, never stored.** The obvious version — write this sentence into an override for every
 * undescribed room — would put 40,619 entries in the overlay, mark every one of them authored, and
 * destroy the meaning of the ✎ mark that exists to show where the real work is. It would also have to
 * be undone one room at a time. This costs nothing, and the moment prose is written it disappears on
 * its own, because it is only ever the `||` branch of a room that has none.
 *
 * Dim, and in brackets, because it is a **builder's note and not the world's voice**. A player who
 * cannot tell the difference between a room the game has not finished and a room that is deliberately
 * bare has been lied to. Two thirds of the loaded world is in this state — The Stag Forest and The
 * Stump Bog have prose for 0 of 191 rooms between them — so it will be read a great deal.
 *
 * The other half of the owner's request, giving a room prose from a short prompt through a local
 * model, is the next A slice: see `ROADMAP.md` §4.
 */
const NO_DESCRIPTION = '&+L[ No description yet. ]&N';

function describeRoom(player: Player): void {
  const record = records.get(player.id);
  if (record) store.setLastRoom(record, player.roomId);

  const view = buildRoomView(player);
  if (!view) return;
  send(player.id, { t: 'room', view });
  // The client replaces its entity list wholesale from that message, so the watch set has to be
  // re-seeded to match it exactly. Leaving the previous contents would have the next diff re-send an
  // entity the client already has, or silently never remove one it does not.
  watching.set(
    player.id,
    new Set(view.entities.filter((e) => e.id !== player.id).map((e) => e.id)),
  );
  send(player.id, { t: 'log', channel: 'room', text: view.room.name });
  send(player.id, { t: 'log', channel: 'room', text: view.room.description || NO_DESCRIPTION });
  const exits = Object.keys(view.adjacent);
  send(player.id, {
    t: 'log',
    channel: 'room',
    text: exits.length ? `Exits: ${exits.join(', ')}.` : 'There are no obvious exits.',
  });
}

/**
 * Everything a client is owed once the player has already been moved.
 *
 * The order matters: `zone` carries the map the room sits on, so it has to land before `seen` or the
 * room description, or the client shades a grid it has not built. Crossing into another zone and
 * climbing to another level of this one go through here identically — there is only one kind of
 * arrival.
 */
function announceArrival(player: Player, from: RoomId, fromPlace: Place, via?: Direction): void {
  // The character's light moved with them, so fold it in before anything is sent: the bitset below
  // and the room view after it must both describe where they are standing *now*.
  const delta = foldSeen(player);
  syncEntitiesIn(from, via ? { id: player.id, dir: via } : undefined);

  if (!samePlace(fromPlace, player.place)) {
    const zone = world.zone(player.place.zone);
    if (zone) send(player.id, { t: 'zone', zone, level: player.place.level });
    // A route is tile coordinates on the grid they just left. The simulation already dropped it in
    // relocate(); this is what stops the client drawing a line across the new map. Deliberately
    // inside the Place check — walking from one room to the next *within* a Place also comes through
    // here, and cancelling there would break every click-to-move that crosses a corridor.
    send(player.id, { t: 'path', points: [] });
    // A new Place means a new grid, so tile indices from the old one mean nothing: the whole bitset
    // for this Place goes out, and deltas take over again from here.
    sendSeen(player);
  } else if (delta.length > 0) {
    send(player.id, { t: 'seenDelta', tiles: delta });
  }

  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  describeRoom(player);
  // After the room description, which re-seeded this player's own watch set — and for everyone in
  // the destination room, who pick the arrival up only if their light reaches them.
  syncEntitiesIn(player.roomId);

  // **Pursuit closes here** (owner's pick, `DESIGN-progression.md` §5b option 2). On the watch set
  // `describeRoom` just re-seeded, so the quarry check passes the exact visibility gate a typed
  // `kill` would — a mob that fled into darkness is gone, not tracked through a wall. Placed on the
  // one arrival path rather than on any command, because the pointer rides the player: walking,
  // clicking, whatever brought them here, the chase resumes the moment they and the quarry share a
  // lit room.
  const quarry = pursuitTarget(sim, player, (id) => watching.get(player.id)?.has(id) ?? false);
  if (quarry) {
    send(player.id, { t: 'log', channel: 'combat', text: `You close in on ${quarry.name}!` });
    startFight(player, quarry.id);
  }
}

/**
 * "a rusted gate" -> "A rusted gate", for a door name that has to start a sentence.
 *
 * The names carry their own article, exactly as the light sources do (see {@link bare}), which is
 * right for "You open a rusted gate" and wrong for "a rusted gate is closed."
 */
function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * "Not while you are fighting." §6's `CMD_N` on every direction, for the paths the command table
 * cannot reach.
 *
 * `COMMAND_REQUIREMENTS` gates the *typed* `north`; it is read in `runCommand` and nothing else goes
 * through there. The protocol's own `move` and `moveTo` intents are what a keybind and a click send,
 * and they arrive at `handle` — so without this a player refused the word walked out with the keyboard
 * instead, which is the failure Phase 4 warned about landing on a different axis than expected.
 */
function refuseIfFighting(player: Player): boolean {
  if (player.fighting === undefined) return false;
  send(player.id, { t: 'log', channel: 'error', text: 'Not while you are fighting! (Try "flee".)' });
  return true;
}

/** Classic MUD single-step movement: walk one room and land in its centre. */
function stepRoom(player: Player, dir: Direction): void {
  // Reached by the `move` intent as well as the typed command, and only the latter has been through
  // the table's gate. §5: `flee` is the one way out, and it is named in the refusal.
  if (refuseIfFighting(player)) return;
  const room = sim.room(player.roomId);
  const exit = room?.exits[dir];
  if (!exit) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot go ${dir}.` });
    return;
  }
  // Closed, not locked. Locked is what stops you *opening* it; closed is what stops you walking
  // through — `actmove.c:1220`. Checking `locked` here let an unlocked-but-shut door be stepped
  // through, and it was also the *only* place either flag was consulted, which is what left the
  // continuous movement paths walking through doorways this refused. They are geometry now
  // (`isWalkable`); this covers the doors geometry cannot express — portals and vertical links carve
  // no tiles at all.
  //
  // `world.doorway` rather than `exit.door`, so the 5 exits in the shipped world that face a door
  // without declaring one are refused too. They share the carved strip, so the alternative is a
  // doorway that is a wall from one room and a corridor from the other.
  const doorway = world.doorway(player.roomId, dir);
  if (doorway?.near.door.closed) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `${capitalise(doorway.near.door.name)} is closed.`,
    });
    return;
  }

  // Stamina, before anything is moved. `SECTOR_MOVE_COST` finally has a caller — a step across a bog
  // costs more than a step along a road, and running out means stopping to catch your breath rather
  // than being unable to walk at all.
  const destination = sim.room(exit.to);
  if (destination && !sim.spendMove(player, room!.sector, destination.sector)) {
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: 'You are too exhausted to go on. (Try "rest".)',
    });
    return;
  }

  const from = player.roomId;
  const fromPlace = player.place;
  const hadPath = sim.hasPath(player);

  if (!sim.relocate(player, exit.to, dir)) {
    // The exit is real, it simply leaves the zones this server was told to load. Naming the zone is
    // the useful half of the message: it says exactly what to add to world.config.json.
    const zoneId = world.zoneOf(exit.to);
    send(player.id, {
      t: 'log',
      channel: 'error',
      text:
        zoneId === undefined
          ? 'That way lies somewhere not yet mapped.'
          : `That way leads into zone ${zoneId}, which is not part of this world yet.`,
    });
    return;
  }

  // `relocate` always drops the route: tile coordinates are meaningless once a character has been
  // picked up and put down somewhere else, even one room away. A step that *changes* Place is told
  // to the client by `announceArrival`; a step within one Place is not, and without this the drawn
  // polyline and its pulsing destination marker stay on screen pointing at a room the character is
  // no longer walking to — falsifying the protocol's own guarantee that the drawn route is provably
  // the route being walked.
  if (hadPath && samePlace(fromPlace, player.place)) send(player.id, { t: 'path', points: [] });

  announceArrival(player, from, fromPlace, dir);
}

/**
 * Whether anyone's collision box is standing in this doorway.
 *
 * A door that shut on top of a character would wall them in: `canStand` tests the four corners of the
 * box against the grid, so once every corner sits on a shut door tile `stepMovement` refuses to move
 * them in *any* direction. That is the one failure the codebase treats as unacceptable — a state the
 * player cannot get themselves out of (see `STUCK_TICKS` in `sim.ts`) — and unlike a jammed route
 * there is no five-tick timeout that would ever release it.
 *
 * The doorway is 3 tiles across and 2 deep, so this is the ordinary case of someone walking through,
 * not a corner case. Refusing to close is the same answer a physical door gives.
 *
 * It tests every character, seen or not. That does mean shutting a door reveals that *something* is
 * in the way — but it says nothing about who, which is the distinction {@link actToRoom} exists to
 * hold, and a door you cannot push shut is a fact the character's hands would report anyway.
 */
function doorwayBlocked(place: Place, roomId: RoomId, dir: Direction): boolean {
  const grid = world.grid(place);
  if (!grid) return false;
  const tiles = new Set(doorwayTiles(grid, roomId, dir));
  if (tiles.size === 0) return false;

  const r = PLAYER_RADIUS;
  for (const player of sim.allPlayers()) {
    if (!samePlace(player.place, place)) continue;
    for (const [dx, dy] of [[-r, -r], [r, -r], [-r, r], [r, r]] as const) {
      if (tiles.has(tileIndexAt(grid, player.x + dx, player.y + dy))) return true;
    }
  }
  return false;
}

/**
 * Opens or shuts a door, both sides of it, and tells everyone who needs to know.
 *
 * Follows `do_open`/`do_close` in `actmove.c`: refuse when there is no door, when it already stands
 * that way, and — opening only — when it is locked. A lock is not a second kind of shut, it is the
 * thing that stops you *unshutting* it, which is why the movement check in `stepRoom` reads `closed`
 * and this one reads `locked`.
 *
 * Three audiences, and they are told three different things: the character acts, their room watches
 * someone act, and the room on the far side sees a door move with nobody attached to it. The MUD
 * words that last one "opened from the other side", and it is worth keeping — it is the only signal
 * that there is anyone through there at all.
 */
function workDoor(player: Player, verb: 'open' | 'close', dir: Direction): void {
  const closing = verb === 'close';
  const doorway = world.doorway(player.roomId, dir);
  if (!doorway) {
    send(player.id, { t: 'log', channel: 'error', text: `There is nothing to ${verb} ${dir}.` });
    return;
  }

  // You turn to the door before you touch it. After the existence check rather than before, so
  // `open north` at a blank wall does not spin the character round to look at nothing.
  faceDirection(player, dir);

  const { near, far } = doorway;
  const name = near.door.name;
  if (near.door.closed === closing) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `${capitalise(name)} is already ${closing ? 'closed' : 'open'}.`,
    });
    return;
  }
  if (!closing && near.door.locked) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(name)} seems to be locked.` });
    return;
  }
  if (closing && doorwayBlocked(near.place, near.roomId, dir)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You cannot close ${name} — something is standing in the way.`,
    });
    return;
  }

  const changes = world.setDoorClosed(doorway, closing);

  send(player.id, { t: 'log', channel: 'room', text: `You ${verb} ${name}.` });
  actToRoom(player, 'room', (who) => `${who} ${verb}s ${name}.`);
  if (far) {
    sendToRoom(far.roomId, {
      t: 'log',
      channel: 'room',
      text: closing
        ? `${capitalise(name)} closes quietly.`
        : `${capitalise(name)} is opened from the other side.`,
    });
  }

  // Terrain, so it goes to the whole Place rather than the room — see the `door` message. Sent for
  // each side, because a door whose two ends live on different Places changed geometry on both.
  const places = new Map<string, Place>();
  for (const { side } of changes) {
    sendToPlace(side.place, { t: 'door', room: side.roomId, dir: side.dir, closed: closing });
    places.set(placeKey(side.place), side.place);
  }

  // A shut door is opaque, so what everyone here can see just changed while nobody moved — and every
  // cache key `refreshVisible` holds is still the one it was computed under. `applyRelight` is
  // exactly the "your lit set changed without you moving" path: it folds the new tiles into `seen`,
  // ships the delta, and re-runs the entity diff in both directions.
  for (const place of places.values()) {
    for (const affected of sim.invalidateVisible(place)) applyRelight(affected);
  }
}

/**
 * What to tell the player when a click cannot be honoured.
 *
 * `unexplored` is not a malfunction — it is the fog of war doing the job it exists to do, so it is
 * phrased as the character not knowing the way and sent on the system channel rather than the error
 * one. A player who reads "you cannot go there" concludes the game is broken; one who reads "you
 * have not seen that far" concludes they should carry a better light.
 */
const PATH_FAILURE: Readonly<Record<PathFailure, { readonly channel: LogChannel; readonly text: string }>> = {
  unexplored: {
    channel: 'system',
    text: 'You cannot see that far — you must get closer before you can go there.',
  },
  unreachable: { channel: 'error', text: 'You cannot find a way through to there.' },
  'not-walkable': { channel: 'error', text: 'There is nothing to walk on there.' },
  'off-map': { channel: 'error', text: 'There is nothing there.' },
};

/**
 * Answers a click: a route from where the player stands to the tile they clicked, or why there is
 * none.
 *
 * The search is server-side and gated on *this character's* seen tiles. That gate is the entire
 * point of the feature — a client that computed its own route could simply decline to apply it,
 * reveal a zone once, and then click across the whole map, at which point exploration stops
 * mattering.
 */
function moveTo(player: Player, rawTx: number, rawTy: number): void {
  // Refused outright rather than clamped to the room, because a route is a *plan* and a plan that
  // silently stops at the doorway would look like the pathfinder failing. The steering gate in
  // `sim.ts` would stall it there anyway and report "something blocks the way", which is a worse
  // answer than the true one.
  if (refuseIfFighting(player)) return;
  const grid = world.grid(player.place);
  const record = records.get(player.id);
  if (!grid || !record) {
    // Should not happen — every connected player has both — but a click that goes unanswered leaves
    // the client with no way to know its request died, so say something rather than nothing.
    send(player.id, { t: 'pathFailed', reason: 'unreachable' });
    send(player.id, { t: 'log', ...PATH_FAILURE.unreachable });
    return;
  }

  // Tile coordinates arrive from the network, so floor them rather than trusting the client to send
  // integers. `Math.floor` leaves NaN as NaN, which the bounds test below rejects.
  const tx = Math.floor(rawTx);
  const ty = Math.floor(rawTy);
  if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
    send(player.id, { t: 'pathFailed', reason: 'off-map' });
    send(player.id, { t: 'log', ...PATH_FAILURE['off-map'] });
    return;
  }

  // The gate: tiles this character has SEEN, not rooms they have ENTERED.
  //
  // That distinction is the whole change. Under the old rule a route could not be plotted past the
  // room you were standing in, so approaching a corridor mouth showed you the next room and then
  // refused to let you click into it. Now light spilling through the mouth marks those tiles seen,
  // and seen tiles are walkable — while the anti-speedrun property survives untouched, because you
  // can still only ever see one lit radius beyond wherever you are actually standing.
  //
  // It also drops the old gate's dependence on room ownership entirely. A per-room reveal map had to
  // exist because corridor tiles belong to no room and report -1 from `roomAtTile`, so a room-derived
  // gate sealed every corridor. A bitset of tile indices has no such notion to get wrong, which is
  // why that map and the `allowedTiles` that built the gate from it are both gone.
  //
  // This is the *only* place `allowed` is built. Nothing in `shared` offers a function for it, on
  // purpose: a gate builder sitting next to `findPath` is what the next author would reach for, and
  // the one that used to sit there implemented the rule this replaced.
  //
  // Rebuilt per request because the set grows as you walk; it is a few thousand ints at most.
  const tileCount = grid.width * grid.height;
  const allowed = bitsetToSet(store.seenBits(record, player.place, tileCount), tileCount);

  const result = findPath({
    grid,
    fromTx: Math.floor(player.x / TILE_SIZE),
    fromTy: Math.floor(player.y / TILE_SIZE),
    toTx: tx,
    toTy: ty,
    allowed,
  });

  if (!result.ok) {
    // A refused click deliberately does *not* cancel a walk already in progress. Misclicking into
    // the fog while crossing a room should not strand you halfway.
    send(player.id, { t: 'pathFailed', reason: result.reason });
    send(player.id, { t: 'log', ...PATH_FAILURE[result.reason] });
    return;
  }

  const points = dropWaypointBehind(grid, allowed, player, result.points);
  sim.setPath(player, points);
  // Echoed back rather than left to the client to guess: the drawn route is then provably the route
  // being walked.
  send(player.id, { t: 'path', points });
}

/**
 * Drops the leading waypoint when the character has already walked past it.
 *
 * `findPath` reasons in tiles, so a route always begins at the centre of the tile the character is
 * standing in. But a freely-steered character rests wherever it stopped, up to half a tile from that
 * centre, and following the route literally means a visible step *backwards* on every single click:
 * measured at x=190 in tile 5 (centre 176), a click due east moved the character 14px west for a
 * tick and a half before it turned round.
 *
 * Skipping the waypoint is only safe when the straight line from where the character actually is to
 * the *second* waypoint keeps the whole collision box on walkable, explored ground — the same test
 * smoothing uses, so the anti-speedrun gate applies to this shortcut exactly as it does to the rest
 * of the route. When it does not hold, the route is left alone and the character squares up first.
 */
function dropWaypointBehind(
  grid: TileGrid,
  allowed: ReadonlySet<number>,
  player: Player,
  points: readonly TilePoint[],
): readonly TilePoint[] {
  const second = points[1];
  if (!second) return points;
  return canWalkStraightTo(grid, allowed, player.x, player.y, second) ? points.slice(1) : points;
}

/* -------------------------------------------------------------------------- */
/* Typed commands                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How hurt something looks, from the fraction of its hit points left.
 *
 * Duris' own ladder (`actinf.c`, `do_look` at a character), minus the colour codes and the construct
 * variants we have nothing to apply them to. Bands rather than a number on purpose: exact HP for
 * anyone but yourself is deliberately not on the wire — `EntityView` carries `healthFraction` and
 * `SelfView` carries the real numbers — so the prose has to be readable without it, and a ladder is
 * what makes "nearly dead" a judgement the player makes rather than one the interface makes for them.
 */
function conditionOf(fraction: number): string {
  const percent = fraction * 100;
  if (percent >= 100) return 'is in excellent condition';
  if (percent >= 90) return 'has a few scratches';
  if (percent >= 75) return 'has some small wounds and bruises';
  if (percent >= 50) return 'has quite a few wounds';
  if (percent >= 30) return 'has some big nasty wounds and scratches';
  if (percent >= 15) return 'looks pretty hurt';
  return 'is in awful condition';
}

/**
 * What this character can currently refer to by name, in the order the game searches.
 *
 * The order is a gameplay decision, not an implementation detail. Duris fixes it in `generic_find` —
 * characters in the room, then your inventory, then your equipment, then objects in the room — and
 * that ordering is what makes `wear ring` take yours rather than the one on the floor. Ours is the
 * same idea over the lists that exist today: people first, then what is lying about. Inventory and
 * equipment slot in above the ground when they arrive (roadmap Phase 15).
 *
 * It is built from {@link visibleEntities}, so **you cannot name what you cannot see** — the same
 * gate that decides whether a character is drawn decides whether they can be targeted, and there is
 * no second rule to keep in step. Typing `look torch` in the dark answers "you see no torch here",
 * which is also what the screen is showing.
 */
function targetsFor(observer: Player): EntityView[] {
  const entities = visibleEntities(observer);
  const people = entities.filter((e) => e.kind !== 'item');
  const things = entities.filter((e) => e.kind === 'item');
  return [...people, ...things];
}

/** Resolves a typed reference against what the character can see, or explains why it found nothing. */
function resolveTarget(player: Player, argument: string): EntityView | undefined {
  const ref = parseTargetRef(argument);
  if (!ref) {
    // A malformed ordinal (`foo.orc`, `.orc`, `0.orc`) matches nothing rather than falling back to
    // the first candidate — see `parseTargetRef`. Say so, or it reads as the thing not being there.
    send(player.id, { t: 'log', channel: 'error', text: `"${argument}" is not something you can name.` });
    return undefined;
  }

  const found = findTarget(ref, targetsFor(player), (entity) =>
    entity.id === player.id
      ? [...keywordsFromName(entity.name), 'me', 'self']
      : keywordsFromName(entity.name),
  );
  if (!found) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text:
        ref.ordinal === 1
          ? `You see no ${ref.keyword} here.`
          : `You do not see ${ref.ordinal} of those here.`,
    });
  }
  return found;
}

function lookAt(player: Player, argument: string): void {
  if (!argument) {
    describeRoom(player);
    return;
  }
  const target = resolveTarget(player, argument);
  if (!target) return;
  describeEntity(player, target);
}

/**
 * What one body looks like to another — the tail of `look <keyword>`, and what a click on it runs.
 *
 * Split out so the typed path and the pointed-at path cannot come to describe the same thing two
 * different ways. The caller has already resolved *which* entity, by whichever route; from here they
 * are the same request.
 */
function describeEntity(player: Player, target: EntityView): void {
  // Looking at something is the lightest interaction there is and it still turns you: a room where
  // everyone is examining each other and nobody has moved their head reads as a room of statues.
  if (target.id !== player.id) faceToward(player, target.x, target.y);

  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'room', text: 'You look yourself over.' });
  }
  if (target.kind === 'item') {
    send(player.id, { t: 'log', channel: 'room', text: `You see ${target.name} lying here.` });
    return;
  }

  const level = target.level === undefined ? '' : ` (level ${target.level})`;
  const condition = target.healthFraction === undefined ? '' : `, and ${conditionOf(target.healthFraction)}`;
  send(player.id, {
    t: 'log',
    channel: 'room',
    text: `${capitalise(target.name)}${level} is standing here${condition}.`,
  });
}

/**
 * An entity id, resolved the way a typed keyword is: **through this character's own visible set**.
 *
 * The client may send any number it likes, so this is the gate that makes a click no more powerful
 * than a word. `visibleEntities` is the single authority both presence and prose already resolve
 * through, so pointing at something you cannot see finds nothing, exactly as naming it would.
 */
function targetById(player: Player, id: EntityId): EntityView | undefined {
  return visibleEntities(player).find((entity) => entity.id === id);
}

/** The exits of the current room, with what is in the way of each. */
function listExits(player: Player): void {
  const room = sim.room(player.roomId);
  if (!room) return;

  const lines: string[] = [];
  for (const dir of DIRECTIONS) {
    const exit = room.exits[dir];
    if (!exit) continue;
    const doorway = world.doorway(player.roomId, dir);
    const target = sim.room(exit.to);
    // A shut door is what you see, not what is behind it — naming the room through a closed door
    // would hand out geography the character has no way to have learned.
    const beyond = doorway?.near.door.closed
      ? `${doorway.near.door.name} (closed${doorway.near.door.locked ? ', locked' : ''})`
      : (target?.name ?? 'somewhere not yet mapped');
    lines.push(`  ${dir.padEnd(5)} - ${beyond}`);
  }

  send(player.id, {
    t: 'log',
    channel: 'room',
    text: lines.length ? ['Obvious exits:', ...lines].join('\n') : 'There are no obvious exits.',
  });
}

function listWho(player: Player): void {
  const names = [...sim.allPlayers()].map((p) => `  ${p.name} (level ${p.level})`).sort();
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: [`${names.length} player${names.length === 1 ? '' : 's'} online:`, ...names].join('\n'),
  });
}

/**
 * The command list.
 *
 * Generated from {@link COMMANDS} rather than written out, so a command added to the table cannot be
 * missing from help — the commonest way a command surface rots.
 */
function showHelp(player: Player): void {
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: [
      'Commands (any unambiguous prefix will do — n, sa, ex):',
      `  ${COMMANDS.join(', ')}`,
      '  look <thing>, kill <thing>, open <dir>, close <dir>, say <words>',
      'Refer to one of several with an ordinal: 2.torch.',
    ].join('\n'),
  });
}

/* -------------------------------------------------------------------------- */
/* Posture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What each posture command moves you to, and what it is called when you get there.
 *
 * `rest` and `sleep` are *status* changes and leave the posture exactly where it was — that is the
 * whole point of the two axes, and `do_sleep` in the MUD is literally
 * `SET_POS(ch, GET_POS(ch) + STAT_SLEEPING)`. So you can fall asleep on your feet, and the room is
 * told as much.
 */
const POSTURE_COMMANDS: Readonly<Record<string, {
  readonly posture?: Posture;
  readonly status?: Status;
  readonly already: string;
  readonly self: string;
  readonly room: (who: string) => string;
}>> = {
  stand: {
    posture: 'standing',
    status: 'normal',
    already: 'You are already on your feet.',
    self: 'You clamber to your feet.',
    room: (who) => `${who} clambers to their feet.`,
  },
  sit: {
    posture: 'sitting',
    already: 'You are already sitting down.',
    self: 'You sit down.',
    room: (who) => `${who} sits down.`,
  },
  kneel: {
    posture: 'kneeling',
    already: 'You are already kneeling.',
    self: 'You kneel.',
    room: (who) => `${who} kneels.`,
  },
  rest: {
    status: 'resting',
    already: 'You are already resting.',
    self: 'You settle down and rest.',
    room: (who) => `${who} settles down to rest.`,
  },
  sleep: {
    status: 'sleeping',
    already: 'You are already fast asleep.',
    self: 'You drift off to sleep.',
    // The one line worth keeping verbatim from the source: it is the two-axis model showing off.
    room: (who) => `${who} falls asleep.`,
  },
};

function changeStance(player: Player, command: 'stand' | 'sit' | 'kneel' | 'rest' | 'sleep'): void {
  const move = POSTURE_COMMANDS[command]!;

  // `sleep` standing up is legal and gets its own line, because "asleep on their feet" is exactly the
  // sort of thing the two axes exist to be able to say.
  const onFeet = player.posture === 'standing';

  if (!sim.setStance(player, { ...(move.posture ? { posture: move.posture } : {}), ...(move.status ? { status: move.status } : {}) })) {
    send(player.id, { t: 'log', channel: 'error', text: move.already });
    return;
  }

  send(player.id, { t: 'log', channel: 'room', text: move.self });
  const line = command === 'sleep' && onFeet
    ? (who: string) => `${who} falls asleep on their feet, which should be entertaining.`
    : move.room;
  actToRoom(player, 'room', line);

  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  // Everyone watching needs the new stance: `EntityView` carries it so a sleeper looks asleep.
  syncEntitiesIn(player.roomId);
}

/**
 * `wake`, or `wake <someone>`.
 *
 * Waking someone else is the reason this is not folded into {@link changeStance}: it resolves a target
 * through the same visibility gate everything else does, so you cannot rouse a stranger you cannot
 * see. Coming out of sleep lands you at `resting`, never straight at `normal` — `do_wake` is
 * `SET_POS(tmp_char, GET_POS(tmp_char) + STAT_RESTING)`, and standing up is a separate act.
 */
function wakeUp(player: Player, argument: string): void {
  if (!argument) {
    if (player.status !== 'sleeping') {
      send(player.id, { t: 'log', channel: 'error', text: 'You are already awake.' });
      return;
    }
    sim.setStance(player, { status: 'resting' });
    send(player.id, { t: 'log', channel: 'room', text: 'You wake, and lie there a moment.' });
    actToRoom(player, 'room', (who) => `${who} wakes up.`);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    syncEntitiesIn(player.roomId);
    return;
  }

  if (player.status === 'sleeping') {
    send(player.id, { t: 'log', channel: 'error', text: 'You cannot wake anyone while asleep yourself.' });
    return;
  }

  const target = resolveTarget(player, argument);
  if (!target) return;
  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: "To wake yourself, just type 'wake'." });
    return;
  }

  // A player, specifically: `wake` sends the woken character a `self`, and only a player has one. A mob
  // that can be roused is Phase 9's business and will be roused by being attacked, not by being asked.
  const sleeper = sim.player(target.id);
  if (!sleeper || sleeper.status !== 'sleeping') {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(target.name)} is not asleep.` });
    return;
  }

  sim.setStance(sleeper, { status: 'resting' });
  send(player.id, { t: 'log', channel: 'room', text: `You wake ${sleeper.name} up.` });
  send(sleeper.id, { t: 'log', channel: 'room', text: `You are woken by ${nameSeenBy(sleeper, player)}.` });
  send(sleeper.id, { t: 'self', view: sim.selfViewOf(sleeper) });
  syncEntitiesIn(sleeper.roomId);
}

/** What `observer` may call `actor`, for the one place a line is addressed to a single recipient. */
function nameSeenBy(observer: Player, actor: Player): string {
  return canSee(observer, actor) ? actor.name : UNSEEN_NAME;
}

function saySomething(player: Player, text: string): void {
  const said = text.trim().slice(0, 400);
  if (!said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Yes, but what do you want to say?' });
    return;
  }
  // Rendered per listener, never broadcast pre-formatted: an observer standing outside the speaker's
  // torchlight hears "someone says", which is the same answer the entity gate already gives their
  // client about who is in the room.
  send(player.id, { t: 'log', channel: 'say', text: `You say, '${said}'` });
  actToRoom(player, 'say', (who) => `${who} says, '${said}'`);
}

/** `open east`, or bare `open` for the door the character is facing. */
function workDoorCommand(player: Player, verb: 'open' | 'close', argument: string): void {
  if (!argument) {
    workDoor(player, verb, player.facing);
    return;
  }
  const dir = parseDirection(argument);
  if (!dir) {
    send(player.id, { t: 'log', channel: 'error', text: `"${argument}" is not a direction.` });
    return;
  }
  workDoor(player, verb, dir);
}

/**
 * Everything a typed line passes through, in order.
 *
 * **This is the one gate, and that is the point of it.** The MUD puts roughly 300 lines of state
 * machine between looking a command up and running it — falling, currents, casting, charm
 * disobedience, and stealth broken by an *allowlist* of commands that do not break it. The design
 * lesson (`REFERENCE-mud-mechanics.md` §3.12) is not the list, it is the location: a check at the
 * single point every action passes through can be audited by reading one function, and scattered
 * `breakStealth()` calls at each action site will always be forgotten somewhere, and players will
 * find the one you forgot.
 *
 * So the seam is here and it is named, even though the gauntlet is currently one flood check. The
 * position legality gate arrives in roadmap Phase 4 and the stealth allowlist with stealth itself;
 * both belong between the lookup and the dispatch below, and nowhere else. Nothing is declared ahead
 * of having a mechanic to declare it for — a table column no code reads is how this project ended up
 * with four tested mechanisms that have never been called.
 */
/**
 * Why the body will not do it — and it names the axis that is actually the problem.
 *
 * "You cannot do that" is the answer that makes a player think the game is broken. "You would have to
 * stand up first" is the answer that tells them which key to press next, and {@link shortfall} exists
 * so the message can be about the right half: telling someone to stand up while they are unconscious
 * is not help.
 */
function refusalFor(player: Player, need: Requirement): string {
  if (shortfall(player, need) === 'status') {
    switch (player.status) {
      case 'sleeping':
        return 'You are fast asleep. (Try "wake".)';
      case 'resting':
        return 'Not while you are resting — you would have to get up.';
      case 'incapacitated':
        return 'You are barely conscious and can do nothing but lie there.';
      case 'dying':
        return 'You are bleeding to death. Nothing else is going to happen until that stops.';
      case 'dead':
        return 'You are dead. That rather limits your options.';
      default:
        return 'You are in no state for that.';
    }
  }
  // Posture, then, and the required one is the useful half to name.
  switch (need.posture) {
    case 'standing':
      return 'You would have to stand up first.';
    case 'kneeling':
      return 'You would have to at least kneel up first.';
    default:
      return 'You would have to sit up first.';
  }
}

/**
 * The pre-dispatch gauntlet: may this character do this thing at all? Says why if not.
 *
 * **This is Phase 2's seam, extracted into a function so that a second entry point can reach it.**
 * The rule the comments have always stated is that these checks are read in exactly *one place* —
 * scattered ones get forgotten and players find the one you forgot — and that property is what a
 * clicked verb would otherwise break. A menu that ran `kill` past the gate would let you open a fight
 * while asleep, and one that re-implemented the gate would be the second copy the seam exists to
 * prevent. So it moved from *a location* to *a name*, and both callers pass through it.
 *
 * Two independent axes, in the source's own order:
 *
 * - **In combat** — `DESIGN-engagement.md` §6's `CMD_N`, a third axis rather than a posture
 *   consequence. Named in the refusal, because §4 leaves steering working while refusing the exits,
 *   so "you cannot do that" has to say which of the two it is or the game reads as broken.
 * - **Position** — a minimum on posture and on status, from `COMMAND_REQUIREMENTS`.
 */
function permits(player: Player, command: Command): boolean {
  const need = COMMAND_REQUIREMENTS[command];
  if (need.inCombat === false && player.fighting !== undefined) {
    send(player.id, { t: 'log', channel: 'error', text: 'Not while you are fighting!' });
    return false;
  }
  if (!meets(player, need)) {
    send(player.id, { t: 'log', channel: 'error', text: refusalFor(player, need) });
    return false;
  }
  return true;
}

function runCommand(player: Player, line: string): void {
  const budget = budgets.get(player.id);
  if (budget && !spendCommand(budget, Date.now())) {
    send(player.id, { t: 'log', channel: 'error', text: 'You are typing too fast to think straight.' });
    return;
  }

  const { word, rest } = splitCommand(line);
  if (!word) return;

  const command = lookupCommand(word);
  if (!command) {
    // The MUD's own answer, and it is the right one: it says "that is not a command" without
    // guessing at what was meant, and guessing is what would eventually walk somebody off a cliff.
    send(player.id, { t: 'log', channel: 'error', text: `Huh? Type "help" for the commands.` });
    return;
  }

  if (!permits(player, command)) return;

  const dir = directionOf(command);
  if (dir) {
    stepRoom(player, dir);
    return;
  }

  switch (command) {
    case 'look': return lookAt(player, rest);
    case 'exits': return listExits(player);
    case 'say': return saySomething(player, rest);
    case 'open': return workDoorCommand(player, 'open', rest);
    case 'close': return workDoorCommand(player, 'close', rest);
    case 'who': return listWho(player);
    case 'help': return showHelp(player);
    case 'affects': return listAffects(player);

    case 'stand':
    case 'sit':
    case 'kneel':
    case 'rest':
    case 'sleep':
      return changeStance(player, command);

    case 'wake': return wakeUp(player, rest);

    case 'flee':
      runFlee(player);
      return;

    case 'stop':
      sim.clearPath(player);
      send(player.id, { t: 'path', points: [] });
      return;

    case 'loot': return lootByKeyword(player, rest);
    case 'get': return getFromGround(player, rest);
    case 'drop': return dropFromBag(player, rest);
    case 'wear': return wearFromBag(player, rest);
    case 'remove': return removeWorn(player, rest);
    case 'inventory': return listInventory(player);
    case 'kill': {
      // Resolves the target and then refuses, rather than refusing first — "you see no orc here" is
      // the more useful of the two answers, and it keeps target resolution exercised.
      if (!rest) {
        send(player.id, { t: 'log', channel: 'error', text: 'Kill what?' });
        return;
      }
      const view = resolveTarget(player, rest);
      if (!view) return;
      return startFight(player, view.id);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The acts, once something has been picked out                                */
/* -------------------------------------------------------------------------- */

/**
 * Open a fight with a particular body — the tail of `kill <keyword>`, and what a click on one runs.
 *
 * Takes an **id** rather than a keyword because that is the fact both routes end up holding: the
 * typed path resolves a word into one, the pointed-at path is handed one. Everything from here — the
 * self-attack refusal, the stop-then-set switch, the prose — is the same request however it arrived.
 */
function startFight(player: Player, id: EntityId): void {
  const target = sim.get(id);
  if (!target) return;
  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: 'You cannot attack yourself.' });
    return;
  }
  // **The PvP gate, and it closes a hole rather than adding a rule.** Nothing refused this before: the
  // check above was the only one, so any player could open a fight on any other and the game shipped
  // as a pkill game by omission. Owner's rule (2026-08-03) — off by default, thrown from the panel for
  // the evenings it should be on. See `settings.ts`.
  if (!settings.pvp && isPlayer(target)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You cannot attack ${target.name}. Player killing is switched off.`,
    });
    return;
  }
  if (player.fighting === target.id) {
    send(player.id, { t: 'log', channel: 'error', text: `You are already fighting ${target.name}.` });
    return;
  }
  // §2: retargeting is stop-then-set, never set-again. `engage` refuses an actor that is already
  // fighting, so switching opponents has to go through `disengage` first — one code path, so a switch
  // cannot leave a stale pointer.
  if (player.fighting !== undefined) {
    if (disengage(scheduler, player)) syncEntityState(player);
  }
  if (!engage(scheduler, player, target, { immediate: true })) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot attack ${target.name}.` });
    return;
  }
  // Any engagement retires the chase — either this *is* the pursuit landing, or the player picked a
  // new fight and the old claim is history. One clear on the one engage path, so it cannot go stale.
  player.pursuing = undefined;
  send(player.id, { t: 'log', channel: 'combat', text: `You attack ${target.name}!` });
  actToRoom(player, 'combat', (who) => `${who} attacks ${target.name}!`);
  syncEntityState(player);
}

/**
 * `loot` and `loot <keyword>`: work out which body, then go through it.
 *
 * The resolution half. Which corpse a word means is a game rule — nearest unlooted first, matched on
 * the dead thing's own name — and it stays here, while {@link searchCorpse} is the act itself.
 */
function lootByKeyword(player: Player, rest: string): void {
  const inRoom = corpsesIn(graveyard, player.roomId);
  const here = inRoom.filter((c) => withinReach(c, player.x, player.y));
  if (here.length === 0) {
    // **Two different refusals, and saying the right one matters.** A corpse lies where its owner
    // fell, so in a nine-tile room it is routinely across the floor from you — and "there is nothing
    // here to loot" while one is plainly visible reads as the game being broken rather than as a
    // reason to take three steps.
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: inRoom.length > 0
        ? `You are not close enough to ${corpseName(inRoom[0]!)}. Step over to it.`
        : 'There is nothing here to loot.',
    });
    return;
  }
  // Matched on the dead thing's own name, so `loot sentry` works on "the corpse of a sentry" without
  // the player having to type the whole phrase. Same whole-word rule target resolution uses.
  const wanted = rest.trim().toLowerCase();
  const matching = wanted
    ? here.filter((c) => keywordsFromName(c.of).some((k) => k === wanted) || c.of.toLowerCase().includes(wanted))
    : here;
  // **Nearest unlooted first** — the owner's rule, and it applies to `loot sentry` as much as to a
  // bare `loot`: three dead guards on one floor are three bodies with the same name.
  const corpse = nearestLootable(matching, player.x, player.y);
  if (!corpse) {
    send(player.id, { t: 'log', channel: 'error', text: `You see no corpse of ${rest || 'anything'} here.` });
    return;
  }
  searchCorpse(player, corpse);
}

/**
 * Going through one particular body — the act, shared by the typed word and the click.
 *
 * Re-runs `lootRefusal` even when the caller resolved the corpse itself, because the two routes can
 * arrive holding different amounts of certainty: a keyword was filtered to what is in reach, a click
 * was not, and this is the one place that knows which refusals exist.
 */
function searchCorpse(player: Player, corpse: Corpse): void {
  const refusal = lootRefusal(corpse, player, settings.pvp);
  if (refusal) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: refusal === 'someone-elses'
        ? // Names the rule rather than only the refusal. "That is not yours" alone reads like a bug
          // to somebody standing over a body they can plainly see, and the switch is an operator
          // decision a player is entitled to know the state of.
          'That is not yours to take — player corpses are protected while PvP is off.'
        : refusal === 'not-here'
          ? `You are not close enough to ${corpseName(corpse)}. Step over to it.`
          : 'That is not here.',
    });
    return;
  }
  // You kneel to the body you are going through, not the one you were last looking at.
  faceToward(player, corpse.x, corpse.y);

  if (corpse.contents.length === 0) {
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: corpse.looted
        ? `${capitalise(corpseName(corpse))} has already been picked clean.`
        : `You search ${corpseName(corpse)} and find nothing worth taking.`,
    });
    // A body that held nothing is marked emptied all the same, so the sprite tells the truth to the
    // next person along and nobody walks over to check twice.
    if (!corpse.looted) {
      corpse.looted = true;
      syncCorpseView(corpse);
    }
    return;
  }

  // **Coin comes off a body first, and never touches the bag.** Most of the world's money is carried
  // rather than lying about — 15c's harvest gives IceCrag mobs four platinum apiece — so a corpse that
  // handed you a "pile of coins" *item* would be the common case, not the exception. Same rule the
  // ground already follows: converted, not carried, and it cannot be refused for want of a slot.
  const coin = corpse.contents.filter((item) => isMoney(templateOf(item)?.type));
  if (coin.length > 0) {
    let gained: Purse = {};
    for (const item of coin) gained = addCoins(gained, templateOf(item)?.coins ?? {});
    player.purse = addCoins(player.purse, gained);
    corpse.contents = corpse.contents.filter((item) => !isMoney(templateOf(item)?.type));
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `You get ${describePurse(gained)} from ${corpseName(corpse)}.`,
    });
  }

  const result = lootCorpse(corpse, player.inventory);
  player.inventory = result.inventory;

  for (const item of result.taken) {
    send(player.id, { t: 'log', channel: 'system', text: `You get ${item.name} from ${corpseName(corpse)}.` });
  }
  if (result.left.length > 0) {
    // **Named, not counted.** "3 items would not fit" leaves a player guessing which; naming them is
    // what lets somebody decide what to drop to make room.
    send(player.id, {
      t: 'log',
      channel: 'error',
      text:
        `You cannot carry ${result.left.map((item) => item.name).join(', ')} — ` +
        `${slotsFree(player.inventory)} slot${slotsFree(player.inventory) === 1 ? '' : 's'} free.`,
    });
  }
  actToRoom(player, 'room', (who) => `${who} searches ${corpseName(corpse)}.`);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
  syncCorpseView(corpse);
}

/** Re-sends a corpse to everyone watching it — its sprite changes with whether it still holds anything. */
function syncCorpseView(corpse: Corpse): void {
  for (const observer of sim.playersIn(corpse.roomId)) {
    if (!watching.get(observer.id)?.has(corpse.id)) continue;
    send(observer.id, { t: 'entityUpdate', entity: corpseViewOf(corpse) });
  }
}

/* -------------------------------------------------------------------------- */
/* Carrying things — Phase 15b                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The catalogue entry an instance came from, or nothing for the authored starter kit.
 *
 * The bridge between the two halves of §8's type/instance split. An `Item` carries what a *bag* needs —
 * name, bulk, armour, stacking — and deliberately not what only the catalogue knows: its Duris type, its
 * container rule, what it is worth in coin. Anything asking those questions comes through here.
 */
function templateOf(item: Item): ItemTemplate | undefined {
  const vnum = vnumOf(item);
  return vnum === undefined ? undefined : itemCatalogue.get(vnum);
}

/**
 * Rebuilds the fighting profile from the level and the worn kit.
 *
 * **One function because there are now six callers** — creation, login, levelling, dying, wearing and
 * removing — and every one of them has to do the identical three lines. They had drifted once already:
 * `levelUpIfEarned` passed `player.combat.damage` as the fallback where the others pass `base.damage`,
 * which is the same value only while nothing has ever changed weapons. Since 15b something can.
 */
function refitCombat(player: Player): void {
  const base = playerCombatStats(player.level);
  player.combat = {
    ...base,
    armourClass: base.armourClass + armourClassFrom(player.equipped),
    damage: weaponFrom(player.equipped, base.damage),
  };
  player.roundMs = base.roundMs;
}

/**
 * Everything that has to happen after a character's kit or bag changes.
 *
 * Four things, and leaving any one out is a bug somebody has to reproduce: the fighting profile is
 * derived from the kit, the HUD reads the character sheet, **other players see what you are wearing**
 * (15a put `wearing` on the entity view), and the record has to learn about it before the next crash.
 */
function afterKitChange(player: Player): void {
  refitCombat(player);
  sim.refreshStatus(player);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  syncEntityState(player);
  rememberProgress(player);
}

/**
 * `get` and `get <keyword>`: pick something up off the floor.
 *
 * Resolution is `ground.ts`'s rule — nearest match within reach — and it is deliberately the same
 * shape `loot` uses, because they are the same act against two different containers. The two refusals
 * are kept apart for the reason `loot`'s are: *"there is nothing here"* while a dagger is plainly
 * visible across the room reads as the game being broken rather than as a reason to take three steps.
 */
function getFromGround(player: Player, rest: string): void {
  const inRoom = itemsIn(ground, player.roomId);
  const here = inRoom.filter((entry) => withinPickupReach(entry, player.x, player.y));
  if (here.length === 0) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: inRoom.length > 0
        ? `You are not close enough to ${inRoom[0]!.item.name}. Step over to it.`
        : 'There is nothing here to pick up.',
    });
    return;
  }
  const found = nearestMatching(here, rest, player.x, player.y);
  if (!found) {
    send(player.id, { t: 'log', channel: 'error', text: `You see no ${rest} here.` });
    return;
  }
  pickUp(player, found.id);
}

/**
 * Taking one particular thing off the floor — the act, shared by the typed word and the click.
 *
 * Takes an **id** and re-reads the store, rather than taking the entry the caller resolved. That is
 * not defensiveness: two players can reach for the same dagger in the same tick, and the one whose
 * message arrives second must be told it has gone rather than be handed a second copy of it.
 */
function pickUp(player: Player, id: EntityId): void {
  const entry = ground.get(id);
  if (!entry || entry.roomId !== player.roomId) {
    send(player.id, { t: 'log', channel: 'error', text: 'It is not there any more.' });
    return;
  }
  if (!withinPickupReach(entry, player.x, player.y)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You are not close enough to ${entry.item.name}. Step over to it.`,
    });
    return;
  }
  // **A money pile is converted, not carried.** Phase 15c. Coin lives on the character rather than in
  // the bag — §8 — so a pile leaves the world and the purse goes up, and `ITEM_MONEY` never reaches a
  // `Stack` at all. Checked before the bag, or a pile of ten thousand platinum would be refused for
  // want of a slot.
  const template = templateOf(entry.item);
  if (template && isMoney(template.type)) {
    takeItem(ground, entry.id);
    player.purse = addCoins(player.purse, template.coins ?? {});
    faceToward(player, entry.x, entry.y);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `You pick up ${describePurse(template.coins ?? {})}.`,
    });
    actToRoom(player, 'room', (who) => `${who} picks up some coins.`);
    rememberProgress(player);
    for (const observer of sim.playersIn(entry.roomId)) {
      if (!watching.get(observer.id)?.has(entry.id)) continue;
      send(observer.id, { t: 'entityLeave', id: entry.id });
      watching.get(observer.id)?.delete(entry.id);
    }
    return;
  }

  const result = carry(player.inventory, entry.item);
  if (!('stacks' in result)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text:
        `${capitalise(entry.item.name)} needs ${result.needed} slot${result.needed === 1 ? '' : 's'} ` +
        `and you have ${result.free}.`,
    });
    return;
  }
  // **Removed only once the bag has accepted it.** The other order loses the item entirely to a full
  // bag, and an item that leaves the world is the one inventory bug you cannot apologise your way out
  // of.
  takeItem(ground, entry.id);
  player.inventory = result;

  faceToward(player, entry.x, entry.y);
  send(player.id, { t: 'log', channel: 'system', text: `You pick up ${entry.item.name}.` });
  actToRoom(player, 'room', (who) => `${who} picks up ${entry.item.name}.`);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
  // It has left the floor, so everyone who could see it is told — including the taker, whose client
  // would otherwise keep drawing a dagger they are now carrying.
  for (const observer of sim.playersIn(entry.roomId)) {
    if (!watching.get(observer.id)?.has(entry.id)) continue;
    send(observer.id, { t: 'entityLeave', id: entry.id });
    watching.get(observer.id)?.delete(entry.id);
  }
}

/** `drop <keyword>`: put something down where you stand. */
function dropFromBag(player: Player, rest: string): void {
  if (!rest.trim()) {
    send(player.id, { t: 'log', channel: 'error', text: 'Drop what?' });
    return;
  }
  const index = matchInventory(player.inventory, rest);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return;
  }
  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  player.inventory = removed.inventory;
  // At the character's feet, not the room's centre — the same rule a corpse follows, and what makes
  // *where* you dropped something a fact worth remembering.
  const entry = dropItem(ground, removed.item, {
    roomId: player.roomId,
    place: player.place,
    x: player.x,
    y: player.y,
  });

  send(player.id, { t: 'log', channel: 'system', text: `You drop ${removed.item.name}.` });
  actToRoom(player, 'room', (who) => `${who} drops ${removed.item.name}.`);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
  // Now on the floor, so whoever can see that tile is told about it.
  syncEntitiesIn(entry.roomId);
}

/**
 * `wear <keyword>`: put something on, swapping out whatever was in that slot.
 *
 * **Anything with a slot may be worn, weapons included.** Duris splits `wield` from `wear` and refuses
 * each the other's items; we have one verb, because the split earns its keep only when a character has
 * enough gear for the distinction to save typing, and refusing `wear dagger` today would be a rule with
 * no benefit attached. `wield` as an alias is 15c's, with the two-handed weapons that make it mean
 * something.
 *
 * The swap is what makes this safe: what comes off goes into the bag, so a character cannot end a
 * `wear` with less than they started. If the bag has no room for the old piece the whole thing is
 * refused, which is the only outcome that does not silently drop something on the floor.
 */
function wearFromBag(player: Player, rest: string): void {
  if (!rest.trim()) {
    send(player.id, { t: 'log', channel: 'error', text: 'Wear what?' });
    return;
  }
  const index = matchInventory(player.inventory, rest);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return;
  }
  const item = player.inventory.stacks[index]!.item;
  // **Not everything can be worn**, and since 15c most things cannot: keys, coins, food and trash are
  // the bulk of the harvested catalogue and none of them go anywhere on a body. Refusing by name is the
  // only honest answer — the alternative is inventing a slot, and any resting value picked would make
  // every key in the world wearable somewhere.
  const slot = item.slot;
  if (!slot) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot wear ${item.name}.` });
    return;
  }
  const displaced = player.equipped[slot];

  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  let bag = removed.inventory;

  if (displaced) {
    const stowed = carry(bag, displaced);
    if (!('stacks' in stowed)) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: `You would have nowhere to put ${displaced.name}. Make room first.`,
      });
      return;
    }
    bag = stowed;
  }

  player.inventory = bag;
  player.equipped = { ...player.equipped, [slot]: item };

  send(player.id, { t: 'log', channel: 'system', text: `You wear ${item.name}.` });
  if (displaced) {
    send(player.id, { t: 'log', channel: 'system', text: `You stop using ${displaced.name}.` });
  }
  actToRoom(player, 'room', (who) => `${who} wears ${item.name}.`);
  afterKitChange(player);
}

/** `remove <keyword>`: take something off and put it in the bag. Refused if it will not fit. */
function removeWorn(player: Player, rest: string): void {
  const wanted = rest.trim().toLowerCase();
  if (!wanted) {
    send(player.id, { t: 'log', channel: 'error', text: 'Remove what?' });
    return;
  }
  // Searched by **entry**, so the slot comes from the key rather than from the item. What is in a slot
  // is worn in that slot whatever the item's own `slot` says — and since 15c an item's may be absent.
  const entry = Object.entries(player.equipped).find(
    ([, item]) =>
      item !== undefined &&
      (item.id === wanted || item.name.toLowerCase().split(/[^a-z0-9]+/).includes(wanted)),
  );
  if (!entry) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not wearing ${rest}.` });
    return;
  }
  const wornSlot = entry[0] as EquipSlot;
  const found = entry[1] as Item;
  const stowed = carry(player.inventory, found);
  if (!('stacks' in stowed)) {
    // Refused rather than dropped on the floor. A character who typed `remove` and found their armour
    // lying in a corridor would be right to call that a bug.
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You have nowhere to put ${found.name} — ${stowed.free} slot${stowed.free === 1 ? '' : 's'} free.`,
    });
    return;
  }
  player.inventory = stowed;
  const next = { ...player.equipped };
  delete next[wornSlot];
  player.equipped = next;

  send(player.id, { t: 'log', channel: 'system', text: `You stop using ${found.name}.` });
  actToRoom(player, 'room', (who) => `${who} removes ${found.name}.`);
  afterKitChange(player);
}

/**
 * `inventory`: what you are carrying, and what you are wearing.
 *
 * Both lists, because they are one question a player asks. Diku prints them from two commands
 * (`inventory` and `equipment`) and every player types both in sequence; there is no reason to make
 * them.
 */
function listInventory(player: Player): void {
  const used = slotsUsed(player.inventory);
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `&+cYou are carrying&N (${used} of ${player.inventory.capacity} slots):`,
  });
  if (player.inventory.stacks.length === 0) {
    send(player.id, { t: 'log', channel: 'system', text: '  nothing' });
  }
  for (const stack of player.inventory.stacks) {
    // `describeStack` owns the count and the charges — "(x3)" and "[3/5]" — because how a stack reads
    // is a rule (§3: charges show only once touched) rather than a formatting choice, and a second
    // copy of it here would drift from the one the container listing will need.
    const slots = stackSlots(stack, limitOf(stack.item));
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `  ${describeStack(stack, stack.item.uses)} (${slots} slot${slots === 1 ? '' : 's'})`,
    });
  }

  // Coin is a line of its own, above the kit — it is not worn and it is not carried, and putting it
  // in either list would be a lie about where it lives.
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `&+YPurse:&N ${describePurse(player.purse)}`,
  });

  send(player.id, { t: 'log', channel: 'system', text: '&+cYou are wearing:&N' });
  const worn = Object.entries(player.equipped).filter(([, item]) => item !== undefined);
  if (worn.length === 0) {
    send(player.id, { t: 'log', channel: 'system', text: '  nothing' });
  }
  for (const [slot, item] of worn) {
    // The armour value is shown here and nowhere else, which is the rule `wornIds` states: your own
    // sheet may appraise your gear, a stranger's entity view may not.
    const bonus = item!.ac > 0 ? ` &+g[+${item!.ac} AC]&N` : '';
    send(player.id, { t: 'log', channel: 'system', text: `  <${slot}> ${item!.name}${bonus}` });
  }
}

function handle(player: Player, message: ClientMessage): void {
  switch (message.t) {
    case 'steer': {
      // Grabbing the keyboard takes manual control back off the pathfinder. A zero vector is a key
      // *release*, and the client sends one every time you let go — cancelling on that would kill a
      // route the moment the player brushed a movement key. `setIntent` answers after normalising,
      // so a sub-threshold nudge counts as a release here too.
      const steering = sim.setIntent(player.id, message.dx, message.dy);
      if (steering && sim.clearPath(player)) send(player.id, { t: 'path', points: [] });
      break;
    }

    case 'moveTo':
      moveTo(player, message.tx, message.ty);
      break;

    case 'stop':
      sim.clearPath(player);
      send(player.id, { t: 'path', points: [] });
      break;

    case 'move':
      stepRoom(player, message.dir);
      break;

    // **The three pointed-at intents** — V2. A click names an entity id where a typed line names a
    // keyword, and everything after the naming is shared: the same gate, the same visibility rule,
    // the same act. What the id buys is the thing a keyword cannot say — *that* patrol member, not
    // whichever of the three the parser would have picked.
    case 'look':
      if (message.target === undefined) {
        describeRoom(player);
        break;
      }
      if (!permits(player, 'look')) break;
      {
        const view = targetById(player, message.target);
        if (view) describeEntity(player, view);
      }
      break;

    case 'attack': {
      if (!permits(player, 'kill')) break;
      // Through the visible set, so a click can name only what a word could have named.
      const view = targetById(player, message.target);
      if (view) startFight(player, view.id);
      break;
    }

    case 'loot': {
      if (!permits(player, 'loot')) break;
      if (message.target === undefined) {
        lootByKeyword(player, '');
        break;
      }
      // A corpse is not in `visibleEntities` as an actor — it is its own store — so this resolves
      // against the graveyard and lets `searchCorpse` apply the reach and ownership refusals.
      const corpse = corpsesIn(graveyard, player.roomId).find((c) => c.id === message.target);
      if (!corpse) {
        send(player.id, { t: 'log', channel: 'error', text: 'That is not here.' });
        break;
      }
      searchCorpse(player, corpse);
      break;
    }

    case 'get': {
      if (!permits(player, 'get')) break;
      if (message.target === undefined) {
        getFromGround(player, '');
        break;
      }
      // Straight to `pickUp`, which re-reads the store and applies the reach test itself — a click has
      // not been filtered to what is in reach the way a keyword has.
      pickUp(player, message.target);
      break;
    }

    case 'say':
      saySomething(player, message.text);
      break;

    case 'command':
      // The one place typed text enters the game. Everything about turning it into an action —
      // abbreviation, target resolution, the pre-dispatch gauntlet — is in `runCommand`.
      if (typeof message.text === 'string') runCommand(player, message.text.slice(0, 400));
      break;

    case 'open':
    case 'close':
      // No direction means the one the character is facing. Facing is server-owned, and the client
      // only holds a predicted copy, so resolving it here rather than on the wire keeps the client
      // sending an intent rather than an outcome.
      workDoor(player, message.t, message.dir ?? player.facing);
      break;

    case 'ping':
      send(player.id, { t: 'pong', ts: message.ts, serverTime: Date.now() });
      break;

    case 'hello':
      // Already handled during the handshake; a second hello is ignored rather than trusted.
      break;

    // The typed `flee` and the protocol's own intent reach the same place, exactly as `command` and the
    // movement intents do. A keybind or a UI button sends this; the command line sends the other.
    case 'flee':
      runFlee(player);
      break;

    default: {
      const _exhaustive: never = message;
      void _exhaustive;
    }
  }
}

/**
 * The admin API — routing, validation and audit live in `admin.ts`, which is testable; what lives
 * here is only what genuinely needs this file's helpers. Each operation owes the affected client
 * its updates, and pays that debt through the same paths the game itself uses: a vitals change is
 * told the way combat tells it, a teleport is a whole `announceArrival`, a granted light rides the
 * relit queue exactly as a picked-up torch does (the next tick's `applyRelight` sends the `self`
 * and the seen delta — nothing here needs to).
 */
const ADMIN_TOKEN = process.env.GAME_ADMIN_TOKEN || undefined;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Writes everything an admin edit changed straight to disk — the owner's rule (2026-08-02): a
 * panel edit is a permanent fact the moment it is made, not at the next disconnect. The ordinary
 * play paths keep their debounce; this is the one caller that pays for immediacy, because the
 * operator is looking at the file's truth right now and a crash between edit and disconnect must
 * not undo their work.
 */
function persistAdminEdit(player: Player): void {
  const record = records.get(player.id);
  if (!record) return;
  rememberAffects(player);
  rememberVitals(player);
  rememberProgress(player);
  store.setLastRoom(record, player.roomId);
  store.flush(record);
}

const adminLive: LiveOps = {
  online: () => [...sim.allPlayers()],
  setVitals(player, pools) {
    if (pools.hp !== undefined) player.hp = pools.hp;
    if (pools.mana !== undefined) player.mana = pools.mana;
    if (pools.move !== undefined) player.move = pools.move;
    // The same consequence order a wound has: status follows the pools, then the owner hears their
    // own numbers and the room sees the health bar move.
    sim.refreshStatus(player);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    syncEntityState(player);
    persistAdminEdit(player);
  },
  setLevel(player, level) {
    // The numbers are still `GAME_DEV_LEVEL`'s arithmetic — `devProfile` is the derivation until
    // Phase 14b replaces it — but the level itself is a recorded fact now, persisted below and
    // restored at every login. The owner's rule: an admin edit is permanent.
    const profile = devProfile(level);
    player.level = level;
    player.maxHp = profile.maxHp;
    player.hp = profile.maxHp;
    player.combat = profile.combat;
    player.roundMs = profile.combat.roundMs;
    sim.refreshStatus(player);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    syncEntityState(player);
    persistAdminEdit(player);
  },
  setLight(player, source) {
    sim.setCarriedLight(player, source);
    persistAdminEdit(player);
  },
  clearAffects(player) {
    sim.restoreAffects(player, []);
    persistAdminEdit(player);
  },
  teleport(player, room) {
    const from = player.roomId;
    const fromPlace = player.place;
    if (!sim.relocate(player, room)) return false;
    // The tick's own transition order: arrival first, then engagement broken both ways — leaving
    // the room ends a fight, and a summons is a way of leaving the room.
    announceArrival(player, from, fromPlace);
    for (const actor of clearEngagements(scheduler, sim, player)) syncEntityState(actor);
    // `describeRoom` inside the arrival already recorded the new room; this makes it durable now,
    // because login honours `lastRoom` and an admin move is a permanent one.
    persistAdminEdit(player);
    return true;
  },
  tell(player, text) {
    // `announce`, not `system`: protocol 10 separates the machine's voice from a person's, and a line
    // typed by an operator is a person's whichever scope it was aimed at. The prefix stays because the
    // channel says *who* is speaking and the prefix says *how widely* — this one is for you alone.
    send(player.id, { t: 'log', channel: 'announce', text: `[Admin] ${text}` });
  },
  kick(player) {
    // The line lands before the close so the player is told rather than dropped; the close handler
    // does every piece of the ordinary disconnect bookkeeping.
    send(player.id, { t: 'log', channel: 'system', text: 'You have been disconnected by an admin.' });
    sockets.get(player.id)?.close();
  },

  /**
   * Shows an authored room edit to whoever is standing in it, without a restart.
   *
   * Two scopes, because a room is two things to a client. **Prose, name and flags are description** —
   * only the people in that room have them on screen, so they get the room re-described and nobody
   * else is disturbed. **A sector change is terrain**: `buildZoneTilemap` carves the grid from
   * sectors, and the client builds its own copy from the `zone` message, so everyone on the Place
   * needs that message again or their collision copy silently disagrees with the server's — they
   * predict through walls that now exist, or stop at ones that no longer do.
   *
   * `zone` for a Place the client already holds is a resync rather than travel, and the protocol's
   * own rule (see `protocol.ts`) is that the `seen` bitset must be *kept* across it. It is, because
   * nothing here touches it: fog is tile indices on a grid whose dimensions did not change.
   */
  publishRoom(room, place, regrid) {
    for (const player of sim.allPlayers()) {
      const here = player.roomId === room.id;
      const onPlace = placeKey(player.place) === placeKey(place);
      if (regrid && onPlace) {
        const zone = world.zone(place.zone);
        if (zone) send(player.id, { t: 'zone', zone, level: place.level });
      }
      if (here) describeRoom(player);
    }
  },

  repopIn(zone) {
    const clock = zoneClocks.find((candidate) => candidate.spawns.zone === zone);
    if (!clock) return undefined;
    // Ticks remaining, converted back to wall time — a zone tick is far slower than the sim's, and
    // `carryMs` is the fraction already accumulated toward the next one.
    const remaining = Math.max(0, clock.lifespan - clock.age);
    return remaining * ZONE_TICK_MS - clock.carryMs;
  },

  occupantsOf(room) {
    const players: string[] = [];
    const mobs: string[] = [];
    for (const actor of sim.actorsIn(room)) (isPlayer(actor) ? players : mobs).push(actor.name);
    // Ungated on sight, deliberately, and this is the one place in the project where that is right:
    // an operator is looking at the world from outside it, not standing in the room with a torch.
    return { players, mobs, corpses: corpsesIn(graveyard, room).map((corpse) => corpseName(corpse)) };
  },

  settings() {
    return settings;
  },

  setSettings(next) {
    settings = next;
    // Written in the same breath it is applied, so the two cannot get out of step. See `settings.ts`
    // for why a switch that reverts on restart is the failure mode worth designing against.
    saveSettings(settings);
    console.log(`[settings] pvp=${settings.pvp}`);
  },
};

const admin = new AdminApi({
  world,
  store,
  live: adminLive,
  /**
   * The operator speaking, to as many people as the scope names.
   *
   * The three scopes differ only in which set of players they walk, so they share everything else —
   * the channel, the counting, and the prefix that says how widely it went. A room-scoped line is
   * deliberately **not** gated on who can see whom: this is a voice from outside the world, so a
   * character standing in the dark hears it like everyone else.
   */
  announce: (text, scope) => {
    const listeners =
      scope.kind === 'room'
        ? sim.playersIn(scope.room)
        : scope.kind === 'place'
          ? [...sim.allPlayers()].filter((player) => samePlace(player.place, scope.place))
          : [...sim.allPlayers()];
    const prefix = scope.kind === 'world' ? '[Announcement]' : '[Here]';
    let heard = 0;
    for (const player of listeners) {
      send(player.id, { t: 'log', channel: 'announce', text: `${prefix} ${text}` });
      heard++;
    }
    return heard;
  },
  token: ADMIN_TOKEN,
  auditFile: join(REPO_ROOT, 'data', 'admin-audit.jsonl'),
  overridesFile: ROOMS_FILE,
  facts: { protocol: PROTOCOL_VERSION, tickMs: TICK_MS, roundMs: ROUND_MS, startedAt: Date.now() },
});
// Announced at boot like every other switch, so a server quietly running an open admin API is not a
// thing that can happen unnoticed. Loopback-only is inherited from the bind at the bottom of this file.
console.log(
  `[admin] api on http://127.0.0.1:${PORT}/admin/api — ` +
    (ADMIN_TOKEN ? 'GAME_ADMIN_TOKEN required' : 'GAME_ADMIN_TOKEN not set: open on loopback'),
);

const http = createServer((req, res) => {
  if (req.url?.startsWith('/admin/api')) {
    serveAdmin(admin, req, res);
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        zones: world.allZones().map((z) => z.id),
        players: sockets.size,
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (socket) => {
  let player: Player | undefined;

  socket.on('message', (raw) => {
    const message = decodeClientMessage(String(raw));
    if (!message) return;

    if (!player) {
      if (message.t !== 'hello') return;
      if (message.protocol !== PROTOCOL_VERSION) {
        socket.send(encode({ t: 'rejected', reason: `protocol ${PROTOCOL_VERSION} required` }));
        socket.close();
        return;
      }
      const name = message.name.trim().slice(0, 24) || 'Someone';
      player = sim.spawn(name, progressRng);
      sockets.set(player.id, socket);
      watching.set(player.id, new Set());
      budgets.set(player.id, newCommandBudget(Date.now()));

      const record = store.load(name);
      records.set(player.id, record);
      // Before the first `foldSeen` below: a returning torch-bearer must light their spawn tile at
      // the radius they are carrying, not at the bare one and then again a tick later.
      restoreAffects(player, record);
      // Level before wounds — the wound is a deficit against maxima the level derives, so this
      // order is what makes "4 below full" mean the same thing it meant at logout.
      restoreProgress(player, record);
      // Wounds too, and before the first `self` goes out so the HUD opens on the right numbers.
      restoreVitals(player, record);
      // Login returns you to where you were — the owner's rule (2026-08-02), and what makes an
      // admin teleport a permanent fact rather than a session one. Before `welcome`, so everything
      // the client is told (`zone`, the bitset, the room) describes where the character actually
      // is. A room the server no longer loads leaves them at spawn: `relocate` refuses it, and a
      // shrunken zone list is configuration, not an error.
      if (record.lastRoom !== undefined && record.lastRoom !== player.roomId) {
        sim.relocate(player, record.lastRoom);
      }

      send(player.id, {
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        you: player.id,
        tickMs: TICK_MS,
        roundMs: ROUND_MS,
      });
      const home = world.zone(player.place.zone);
      if (home) send(player.id, { t: 'zone', zone: home, level: player.place.level });
      // Light the spawn tile before the bitset goes out, so a brand new character sees the ground
      // they are standing on rather than one tick of total darkness.
      foldSeen(player);
      // After `zone` and before the first room description: the client needs the grid built to index
      // the bitset against, and needs the shading in place before it draws the room.
      sendSeen(player);
      // A testing light, when one is asked for. **Off unless `GAME_DEV_LIGHT` names a catalogue id**, so
      // it cannot reach a real server by accident — the same shape as `LOCKS_HOLD`, a switch that is
      // named, explained and default-off rather than a commented-out line somebody re-enables.
      //
      // Granted through `setCarriedLight` like any other light, deliberately: a tester on a special code
      // path is testing something nobody plays. `GAME_DEV_LIGHT=glowing_ring_of_testing` lights the room
      // and its neighbours entirely, which is what makes a mechanic watchable without first solving the
      // lighting puzzle Phase 5 made hard on purpose.
      if (DEV_LIGHT) {
        sim.setCarriedLight(player, DEV_LIGHT);
        foldSeen(player);
        sendSeen(player);
      }
      // Level first, then the weapon override, so `GAME_DEV_DAMAGE` can still tune one number of a
      // profile rather than having to replace the whole thing. **A saved level wins over the rig**:
      // the switch exists to make a fresh character watchable, not to re-flatten one whose level is
      // now a recorded fact — see `restoreProgress`.
      if (DEV_LEVEL && Number.isFinite(DEV_LEVEL) && !record.progress) {
        const profile = devProfile(DEV_LEVEL);
        player.level = DEV_LEVEL;
        player.maxHp = profile.maxHp;
        player.hp = profile.maxHp;
        player.combat = profile.combat;
        player.roundMs = profile.combat.roundMs;
      }
      if (DEV_DAMAGE) player.combat = { ...player.combat, damage: DEV_DAMAGE };
      send(player.id, { t: 'self', view: sim.selfViewOf(player) });
      describeRoom(player);
      syncEntitiesIn(player.roomId);
      console.log(
        `[join] ${name} (#${player.id}) in room ${player.roomId} ` +
          `(place ${placeKey(player.place)}), ${seenTileCount(record)} tiles already seen`,
      );
      return;
    }

    handle(player, message);
  });

  socket.on('close', () => {
    if (!player) return;
    const record = records.get(player.id);
    if (record) {
      // The burn has been counting down since the light was last announced, and this is the last
      // moment anyone can read it off the player. After `sim.remove` below it is gone.
      rememberAffects(player);
      rememberVitals(player);
      rememberProgress(player);
      store.flush(record);
      records.delete(player.id);
    }
    const room = player.roomId;
    sockets.delete(player.id);
    watching.delete(player.id);
    budgets.delete(player.id);
    sim.remove(player.id);
    // Every mob forgets them. `noticed` as well as the dwell timer, and that is not tidiness: entity ids are
    // reissued, so a mob that remembered id 7 would silently already know the next character handed it.
    forgetTarget(awareness, player.id);
    // And nothing keeps chasing them. `Hunt` holds an id rather than a body for this reason, but the entry
    // still has to go or the mob walks toward the last room a ghost was seen in until its timer expires.
    forgetQuarry(hunts, player.id);
    // §5: a pointer must not outlive the entity. Clears the departing character's own target *and*
    // everyone swinging at them — found by scanning, because there is no fight object to read.
    for (const actor of clearEngagements(scheduler, sim, player)) syncEntityState(actor);
    scheduler.cancel(player.id);
    // And every mob forgets what they had earned. Entity ids are reissued, so a table that remembered id
    // 7 would hand the next character to be given it a grudge they never earned — the same hazard
    // `forgetTarget` exists for.
    forgetThreat(threat, player.id);
    // After the removal, so the same diff that handles walking out of someone's torchlight handles
    // vanishing outright. Whoever was watching them is told; whoever could not see them anyway is
    // not told anything, and is not confused by a departure they never saw arrive.
    syncEntitiesIn(room);
    console.log(`[part] ${player.name} (#${player.id})`);
  });

  socket.on('error', (err) => console.error('[ws]', err.message));
});

setInterval(() => {
  const { moved, transitions, pathsEnded, relit, affectEvents, vitalsChanged } = sim.tick();

  // Walking never crosses a Place today, but `fromPlace` means anything that moves a player mid-tick
  // (a trap, a portal tile, a summon) is announced correctly without a second code path.
  for (const { player, from, fromPlace } of transitions) {
    announceArrival(player, from, fromPlace);
    // §5: **leaving the room ends engagement.** Reachable only via flee or by being moved — §4 refuses the
    // exits outright while fighting — so this is not a free disengage; it is the bookkeeping for one that
    // was already paid for. Both directions, because the pointer breaking is not symmetric: whoever was
    // swinging at them is still engaged until something clears it.
    for (const actor of clearEngagements(scheduler, sim, player)) syncEntityState(actor);
  }

  // The route is done with, whether it arrived or gave up: clear the drawn line either way. Only
  // giving up needs saying out loud — arriving is self-evident, but a walk that stops short with no
  // explanation reads as the server dropping input.
  for (const { player, reason, goal } of pathsEnded) {
    send(player.id, { t: 'path', points: [] });
    if (reason === 'stuck') {
      send(player.id, { t: 'log', channel: 'system', text: 'Something blocks the way; you stop.' });
      // Worth a server-side line as well: a jam means the planned route and the collision geometry
      // disagreed, and the tile it gave up short of is the whole of the reproduction.
      console.log(
        `[path] ${player.name} (#${player.id}) stuck short of tile ` +
          `${goal.tx},${goal.ty} in room ${player.roomId} (place ${placeKey(player.place)})`,
      );
    }
  }

  // Said before the state that follows it lands, so the player reads "your torch gutters and dies"
  // and *then* sees the dark close in, rather than watching the radius drop and being told why
  // afterwards. Expiry is server-authoritative and this line is the whole of its being a mechanic
  // rather than a glitch.
  for (const event of affectEvents) announceAffect(event);

  // Light travels with the character: fold whatever it now falls on into `seen` and ship only the
  // difference, batched with this tick. `foldSeen` is free for a mover who stayed in the same tile,
  // which most ticks of most walks are.
  //
  // Deliberately before the two passes below rather than after them. Both read `player.visible`, and
  // this is what makes it describe where the character is standing *now*: without it a pickup would
  // be judged against last tick's lit set, and `syncEntities` would drop and re-add a companion who
  // is still perfectly visible.
  for (const player of moved) {
    const tiles = foldSeen(player);
    if (tiles.length > 0) send(player.id, { t: 'seenDelta', tiles });
  }

  // Walking onto a light. Before the relit sweep below so that a torch found this tick is a torch
  // lit this tick: `setCarriedLight` queues into the relit set, and `drainRelit` collects it here
  // instead of leaving it for the next tick.
  for (const player of moved) collectPickup(player);

  // A light source that changed while the character stood still — a torch found, a Beacon burned
  // out. Everything below this point is keyed on *movement*, and a character whose torch dies on the
  // spot has moved nothing, so their new disc would otherwise sit unused until they next crossed a
  // tile: `seen` would not grow, the click gate would still refuse ground the client is drawing lit,
  // an entity that just came into range would get no `entityEnter`, and the client would never be
  // told the new radius at all. All four are the same omission, so they are all handled here.
  //
  // A set, because a character can reach it by both routes in one tick — a torch that burns out on
  // the very tile the next one is lying on — and doing the work twice would send two `self` views
  // describing the same state.
  const relighted = new Set<Player>(relit);
  for (const player of sim.drainRelit()) relighted.add(player);
  for (const player of relighted) applyRelight(player);

  // Pools that moved. Only the characters whose numbers actually changed, and only when they did:
  // at the fastest rate in the game a pool gains a point every four seconds, so a `self` per player
  // per tick would be forty times the traffic to say the same thing.
  //
  // After `applyRelight`, which already sends a `self` — a character who both found a torch and healed
  // in the same tick would otherwise get two, describing the same state.
  // Actors, not players: mobs regenerate through the same pass. Only a player has a `self` to be sent,
  // so the filter is here — and a mob whose health moved is picked up by the entity sync below instead,
  // which is what carries `healthFraction` to everyone watching it.
  // **Bleeding out, resolved before the `self` below.** The dying window is a clock driven by
  // regeneration's negative rate, so the tick that carries a character past the floor is a *vitals*
  // change and this is the only place that sees it. Reaping first means the `self` that follows
  // describes the revived character rather than the corpse — otherwise the client is told they are
  // dead and then, a tick later, that they are somewhere else and fine.
  //
  // No edge-tracking is needed: handling a death *resolves* it, so a player is never `dead` twice.
  for (const actor of vitalsChanged) {
    if (isPlayer(actor) && actor.status === 'dead') reapPlayer(actor);
  }

  for (const actor of vitalsChanged) {
    if (!isPlayer(actor) || relighted.has(actor)) continue;
    send(actor.id, { t: 'self', view: sim.selfViewOf(actor) });
  }

  // Who has noticed whom. Runs over aggressive mobs only — 52 of IceCrag's 66 are passive and cost one field
  // read — and the delay inside it is the mechanic: see `perception.ts` and §4.5.
  for (const event of advancePerception(sim, awareness, TICK_MS)) announceNotice(event);

  // And who is coming after whom. Downstream of noticing rather than beside it: `beginHunt` is called from
  // the notice event, so a chase can only start from a decision Phase 9 already made and delayed.
  //
  // **Announced further down, after the entity sync, and that ordering is load-bearing.** `announceHunt`
  // only tells an observer who can actually see the arrival, which it reads from `watching` — and
  // `watching` does not contain the mob until `syncEntities` has run for this tick. Announcing here caught
  // every observer one tick too early and printed nothing at all; the chase was visible on screen and
  // silent in the log.
  const hunt = advanceHunts(sim, world, hunts, TICK_MS);
  // A hunter that has caught up starts swinging. This is the seam Phase 10 left open on purpose and the
  // exact point `mobact.c` calls `MobStartFight` — the hunt's job ends at the doorway.
  for (const event of hunt.events) {
    if (event.kind !== 'arrived') continue;
    const quarry = sim.player(hunts.get(event.mob.id)?.quarry ?? -1);
    if (!quarry) continue;
    if (engage(scheduler, event.mob, quarry)) syncEntityState(event.mob);
  }

  // Blows land. Driven by the scheduler rather than a scan: most ticks pop nothing at all.
  //
  // The last argument is Phase 14's morale check, injected the way `advanceAssists` takes `perceives`:
  // `combat.ts` decides *when* a mob's nerve is tested (its own round boundary) and this decides what
  // happens when it goes — the same `runFlee` a player's own `flee` runs.
  const combat = advanceCombat(sim, scheduler, threat, ledger, combatRng, TICK_MS, (mob) => {
    const outcome = runFlee(mob);
    return outcome.kind === 'fled';
  });
  for (const outcome of combat.attacks) announceAttack(outcome);
  for (const change of combat.switches) announceSwitch(change);
  for (const death of combat.deaths) resolveDeath(death);

  // Corpses age. Almost every tick this does nothing, and the map is empty in a world nobody is fighting
  // in — so it is a walk over a handful of entries rather than a scan of anything.
  for (const event of advanceCorpses(graveyard, TICK_MS)) {
    if (event.kind === 'gone') {
      // **The corpse spills before it goes.** The roadmap's own rule: a body that took its contents
      // with it would destroy a reward because a player was slow rather than because of anything they
      // did, and *"I came back and it was gone"* is a worse feeling than *"somebody else got there
      // first"*. Each thing lands where the corpse lay, so the pile is still findable.
      const spilled = event.corpse.contents;
      for (const item of spilled) {
        dropItem(ground, item, {
          roomId: event.corpse.roomId,
          place: event.corpse.place,
          x: event.corpse.x,
          y: event.corpse.y,
        });
      }
      event.corpse.contents = [];

      // Whoever could see it has to be told, or it sits on their screen for ever.
      for (const observer of sim.playersIn(event.corpse.roomId)) {
        if (!watching.get(observer.id)?.has(event.corpse.id)) continue;
        send(observer.id, { t: 'entityLeave', id: event.corpse.id });
        watching.get(observer.id)?.delete(event.corpse.id);
        send(observer.id, {
          t: 'log',
          channel: 'room',
          text:
            `${capitalise(corpseName(event.corpse))} crumbles to dust` +
            (spilled.length > 0 ? ', and what it held spills onto the ground.' : '.'),
        });
      }
      // After the `entityLeave`s, so the spilled items arrive as new entities rather than being
      // swept up by the same diff that removes the corpse.
      if (spilled.length > 0) syncEntitiesIn(event.corpse.roomId);
      continue;
    }
    for (const observer of sim.playersIn(event.corpse.roomId)) {
      if (!watching.get(observer.id)?.has(event.corpse.id)) continue;
      send(observer.id, {
        t: 'log',
        channel: 'room',
        text: `${capitalise(corpseName(event.corpse))} is beginning to rot away.`,
      });
    }
  }

  // Mobs wading into fights beside them. After the round rather than before, so a mob that assists does
  // it in response to a blow that has actually landed.
  // `perceives` rather than `canSee`: the latter is a *player's* light-gated sight, and Phase 9 settled
  // that a mob's is not — a guard is not blind in a hall it has stood in for years. Same function, so
  // noticing and assisting cannot come to disagree about what a mob can make out.
  for (const event of advanceAssists(sim, scheduler, (mob, foe) => perceives(mob, foe))) {
    announceAssist(event);
    syncEntityState(event.helper);
  }
  for (const actor of combat.changed) syncEntityState(actor);
  // Anyone whose hit points moved needs their own numbers back, and the room needs their health bar.
  for (const outcome of combat.attacks) {
    if (isPlayer(outcome.target)) send(outcome.target.id, { t: 'self', view: sim.selfViewOf(outcome.target) });
    syncEntityState(outcome.target);
  }

  // Zone repop. Almost every tick this does nothing — a zone comes due once every seventy minutes or so —
  // so the loop is a fraction added to a counter and a comparison, and the work only happens when one
  // fires. See `reset.ts` for why the fraction is carried rather than rounded.
  for (const outcome of advanceZones(sim, zoneClocks, mobTemplates, itemCatalogue, spawnRng, TICK_MS)) {
    if (outcome.spawned.length === 0 && outcome.doors === 0) continue;
    console.log(
      `[pop] zone ${outcome.zone} repopped: +${outcome.spawned.length} mobs, ` +
        `${outcome.doors} doors reset, ${outcome.atLimit} already at limit`,
    );
    // Anyone standing where something appeared has to be told. Presence is per-observer and gated on
    // light, so `syncEntitiesIn` is the right call rather than a broadcast — a mob that repopped in a dark
    // corner is still nobody's business until a light falls on it.
    for (const room of new Set(outcome.spawned.map((mob) => mob.roomId))) syncEntitiesIn(room);
  }

  // **The fight moves with you** — Phase 14c. Every engaged mob closes on whoever it is fighting and
  // follows them around the room, which is the half of Phase 6's model that was only ever half true:
  // blows already landed at any range, but the body stood on the tile it spawned on while you walked
  // to the far corner.
  //
  // After the combat pass rather than before, so a mob that just broke and ran, died or switched
  // target has already had its pointer settled — this only ever walks bodies whose fight is current.
  // Nothing here reads the threat table: it closes on `fighting`, which is what threat chooses, so a
  // tank holding aggro holds the thing in place beside them for free.
  const stations = advanceStations(sim, world, TICK_MS);
  for (const mob of stations.turned) syncTurn(mob);

  // Players and hunting mobs, in one list. **Actors, not players**, and that widening is the whole of what
  // makes a chase visible: before Phase 10 this batch was built from `moved`, which the simulation fills
  // with players only, so a mob's position had no way onto the wire at all. `syncTurn` had already found
  // the facing half of the same hole.
  const movedActors: Actor[] = [...moved, ...hunt.moved, ...stations.moved];
  if (movedActors.length === 0) return;

  // Who needs their view of other entities re-evaluated. Presence depends on the observer's own lit
  // set and on where the others are standing, so both ends of every pair that could have changed:
  // anyone who moved, and anyone standing in a room where something moved. A player alone in a quiet
  // room is not re-evaluated at all.
  const dirty = new Set<Player>();
  for (const actor of movedActors) {
    if (isPlayer(actor)) dirty.add(actor);
    for (const other of sim.playersIn(actor.roomId)) dirty.add(other);
  }
  // The room a hunter *left* needs re-evaluating too, and nothing else would do it: the loop above only
  // reaches the room it arrived in, so whoever it walked away from would keep drawing it standing there.
  for (const event of hunt.events) {
    if (event.kind !== 'entered' || event.from === undefined) continue;
    for (const other of sim.playersIn(event.from)) dirty.add(other);
  }
  for (const observer of dirty) syncEntities(observer);

  // Now that `watching` is current, say who walked in. See the note where the hunt is advanced.
  for (const event of hunt.events) announceHunt(event);

  // Positions, batched per observer rather than per room — the only high-frequency message we send.
  // Per observer because the two players in a room may not be able to see each other: broadcasting
  // the room's movements would put an unlit character's exact position on the wire, and standing
  // still in the dark would stop working the moment someone read the network panel.
  for (const observer of dirty) {
    const shown = watching.get(observer.id);
    const moves = movedActors
      .filter((actor) => actor.id === observer.id || shown?.has(actor.id))
      .map((actor) => ({ id: actor.id, x: actor.x, y: actor.y, facing: actor.facing }));
    if (moves.length > 0) send(observer.id, { t: 'entityMoved', moves });
  }
}, TICK_MS);

// `node --watch` restarts on SIGTERM/SIGINT; without this, up to SAVE_DEBOUNCE_MS of exploration
// is lost on every code change.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // Nobody's socket closes on a restart, so the burn each connected player is holding has to be
    // captured here or every `node --watch` reload hands them back a full torch.
    for (const player of sim.allPlayers()) {
      rememberAffects(player);
      rememberVitals(player);
      rememberProgress(player);
    }
    store.flushAll();
    process.exit(0);
  });
}

http.on('error', (err) => {
  console.error(`[server] could not listen on ${PORT}: ${err.message}`);
  process.exit(1);
});

// Bind to loopback explicitly rather than every interface: this is a dev server holding an
// unauthenticated world, and it has no business being reachable from the network.
http.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] listening on http://127.0.0.1:${PORT} (ws on the same port)`);
});

