/**
 * The authoritative simulation.
 *
 * Everything here is server-owned. Clients submit steering intents; this decides where anyone
 * actually is. No message from a client ever sets a position directly.
 */

import {
  bareRadiusFor,
  RACES,
  type ClassId,
  AffectFlag,
  HP_FLOOR,
  PLAYER_SPEED,
  POOL_FLOOR,
  REGEN_APPLY,
  ROOM_TILES,
  TICK_MS,
  TILE_SIZE,
  UNLIMITED_DURATION,
  accrue,
  addAffects,
  advanceAffects,
  affectKind,
  canAffordStep,
  clampPool,
  MAX_MOVE_POOL,
  encumberedMoveCost,
  hasType,
  learnedAt,
  swimSurcharge,
  SECTOR_REQUIRES_MOVEMENT,
  isResting,
  needsRegen,
  newAffect,
  regenPerMinute,
  regenerates,
  removeType,
  secondWindAffects,
  settlingAffect,
  sumApply,
  summariseAffects,
  type Affect,
  type AffectType,
  type Direction,
  playerCombatStats,
  tileCentre,
  type AggroRule,
  type CombatStats,
  type PursuitRule,
  type MobTemplate,
  type ResetCommand,
  type Rng,
  type Sector,
  type TileGrid,
  type StackPolicy,
  type VitalPool,
  type EntityId,
  type EntityView,
  type Place,
  type Room,
  type RoomId,
  type SelfView,
  type TilePoint,
  armourClassFrom,
  wornBulk,
  wornIds,
  // M7a: what a body draws as in 3D, and which way it is turned. Both pure, both in `shared` for the
  // usual reason — the renderer draws the answer and the server is the only thing allowed to decide it.
  appearanceOf,
  yawOf,
  type HeldView,
  experienceToNext,
  rollStarterKit,
  weaponFrom,
  STARTING_HIT_POINTS,
  emptyInventory,
  emptyPurse,
  type Purse,
  type Equipped,
  type Inventory,
  type Item,
  normaliseIntent,
  parseDice,
  rollDice,
  roomAtTile,
  arrivalTile,
  STARTING_CAPACITY,
  limitOf,
  roomCentre,
  slotsUsed,
  stackSlots,
  usedInside,
  type BagRow,
  type BagView,
  type ContainerRule,
  type Stack,
  samePlace,
  statusFor,
  BODY_SEPARATION,
  placeBody,
  stepBody,
  type BodyPoint,
  type Landing,
  type Posture,
  type Status,
  type SkillId,
} from '@mygame/shared';
// Subpath imports: `vision` and `light` are not re-exported from the package barrel.
import {
  bestLight,
  brightestLight,
  burnRemaining,
  effectiveRadius,
  expiresTo,
  isRoomMode,
  lightSource,
  lightSourceFrom,
  naturalLightTiles,
  roomLightsItself,
  roomLightTiles,
  toCarriedLight,
  type LightSource,
} from '@mygame/shared/light.ts';
import { DEFAULT_LIGHT_RADIUS, computeVisible } from '@mygame/shared/vision.ts';

import type { PlayerIdentity } from './players.ts';
import { LOCKS_HOLD, placeOf, type GameWorld } from './world.ts';

/** Pixels a character covers in one tick at walking pace — 15 at today's numbers. */
const STEP_PER_TICK = PLAYER_SPEED * (TICK_MS / 1000);

/**
 * How far around a mover {@link Simulation.bodiesNear} looks for something to bump into — 84px.
 *
 * Two tiles plus the separation, which is comfortably more than any pair of bodies can close in one
 * tick: the fastest thing in the world is `HUNT_SPEED` at 192px/s, so both of them together cover
 * 38.4px per 100ms tick and would still be inside the box when the test runs. Larger than it needs to
 * be on purpose — the cost is a subtraction per actor and the failure it prevents is a body that walks
 * through another because the query missed it by a pixel.
 */
const BODY_QUERY_REACH = TILE_SIZE * 2 + BODY_SEPARATION;

/**
 * The three pools, and where each one lives on {@link Player}.
 *
 * A table rather than three near-identical blocks, because the only thing that differs between them is
 * the floor: hit points go negative — that is the dying window — while mana and movement stop at
 * nothing. Written out once means a fourth pool costs a row.
 */
const REGEN_POOLS: readonly {
  readonly name: VitalPool;
  readonly current: 'hp' | 'mana' | 'move';
  readonly max: 'maxHp' | 'maxMana' | 'maxMove';
  readonly floor: number;
}[] = [
  { name: 'hp', current: 'hp', max: 'maxHp', floor: HP_FLOOR },
  { name: 'mana', current: 'mana', max: 'maxMana', floor: POOL_FLOOR },
  { name: 'move', current: 'move', max: 'maxMove', floor: POOL_FLOOR },
];

/**
 * How close to a waypoint counts as having reached it, in pixels.
 *
 * This can be far smaller than the 15px covered in a tick only because the final approach clamps its
 * step to the distance remaining (see {@link Simulation.tick}), so a mover lands *on* a waypoint
 * rather than past it. Without that clamp any radius under about half a step would be jumped clean
 * over, the mover would turn round, overshoot again, and orbit the point forever. The couple of
 * pixels here are slack for a step that a wall shaved a hair off, not a fudge factor for overshoot.
 */
const WAYPOINT_RADIUS = 2;

/**
 * Consecutive ticks without measurable progress before a route is abandoned.
 *
 * A route is planned on the tile grid, but movement is resolved by `stepMovement` against a
 * PLAYER_RADIUS collision box with axis-separated sliding, and the two can disagree: a smoothed
 * diagonal that shaves a corner, a segment a 20px-wide character does not quite fit along, or
 * geometry that changed after the click. Because an active path *overrides* the client's steering,
 * a jammed mover would grind into the wall forever while ignoring every key the player pressed —
 * the one failure mode of click-to-move that a player cannot get themselves out of. Five ticks is
 * half a second: long enough that one scraping tick does not cancel a legitimate walk, short enough
 * that nobody sits there wondering why they are stuck.
 */
const STUCK_TICKS = 5;

/**
 * Fraction of the requested step that must actually be covered for a tick to count as progress.
 *
 * Measured against what was asked for rather than an absolute distance: sliding along a wall on a
 * diagonal legitimately covers only ~71% of a step and must not read as stuck, while a mover pressed
 * flat into geometry covers essentially none of it.
 */
const PROGRESS_FRACTION = 0.25;

/**
 * The visible set of a character who has not had one computed yet.
 *
 * Shared and empty rather than a fresh `Set` per invalidation: after a change of Place the old set
 * indexes tiles on a grid the character is no longer standing on, and *nothing* is a far safer thing
 * to hand a caller than tiles from somewhere else.
 */
const NOTHING_VISIBLE: ReadonlySet<number> = new Set();

/** Cache key value meaning "no visible set has been computed", since no tile or radius is negative. */
const NEVER = -1;

/**
 * How long before a carried light burns out that its bearer is warned, in milliseconds.
 *
 * A light dying with no warning in a dark zone is miserable: the radius drops from 3 to 2 between
 * one tick and the next, the room you were walking into goes black, and the honest reading of that
 * is "the server glitched". Ten seconds is about four room crossings at `PLAYER_SPEED` — enough to
 * decide whether to press on or turn back, and short enough that it still reads as urgent rather
 * than as a status effect you have been carrying all along.
 *
 * **Now a re-export rather than the definition.** The threshold moved into the affect catalogue in
 * Phase 5b (`AFFECT_TYPES.light.warnAtMs`), because the warning is part of what a timed effect *is*
 * and the expiry pass has to be able to reach it without knowing that this particular one is a light.
 * The name stays because the client imports it for its own urgency styling.
 */
export const LIGHT_WARNING_MS = affectKind('light')?.warnAtMs ?? 10_000;

/** A click-to-move route the simulation is currently walking a player along. */
export interface ActivePath {
  /**
   * Waypoints still to reach, nearest first, in tile coordinates on the owning player's Place grid.
   * Consecutive waypoints are not necessarily adjacent tiles — a route is a smoothed polyline.
   */
  readonly points: TilePoint[];
  /**
   * Where the route ends: the tile the player actually clicked.
   *
   * Held separately because `points` is consumed as it is walked, so once the first waypoint is
   * reached this is the only surviving record of where the character was going.
   */
  readonly goal: TilePoint;
  /** Consecutive ticks that produced no measurable progress. See {@link STUCK_TICKS}. */
  stalled: number;
}

/** Why a route stopped being walked. Either way the client must stop drawing it. */
export type PathEndReason = 'arrived' | 'stuck';

export interface PathEnded {
  readonly player: Player;
  readonly reason: PathEndReason;
  /** The tile the route was aiming for — reached when `arrived`, given up on when `stuck`. */
  readonly goal: TilePoint;
}

/**
 * Anything in the world with a body.
 *
 * **This split is roadmap Phase 7's load-bearing half.** Before it, `sim.ts` was written throughout in
 * terms of `Player` — `playersIn`, `viewOf`, `visibleEntities`, `syncEntities` — and a mob arriving as a
 * *separate kind of thing* would have grown a second branch in every one of them. Those branches drift,
 * and the first to drift would have been the visibility gate, which is the one place a bug means seeing
 * something you should not.
 *
 * So the rule is: **everything true of a body lives here, and `Player` adds only what a *client* needs.**
 * A mob has hit points, a posture, an affect list and somewhere to stand for the same reasons a player
 * does, and every pass over the world — regeneration, affect expiry, presence, visibility — walks
 * `Actor` and neither knows nor cares which kind it has.
 *
 * What is deliberately *not* here: steering intent, a walked route, and the lit-tile set. Those are all
 * "what this client is doing and what it has been told", and a mob has no client. Phase 9 gives mobs
 * perception, and when it does that will be a field of their own — a mob's senses and a player's fog of
 * war answer different questions and must not share a set.
 */
export interface Actor {
  readonly id: EntityId;
  /** Player or mob. The one discriminator, and the wire carries it too — see `EntityKind`. */
  readonly kind: 'player' | 'mob';
  readonly name: string;
  /**
   * Which art the client draws this with.
   *
   * A **key, not a path**: the server says *what* stands here and the client owns the layer stack that
   * renders it. Same division `@mygame/client` keeps everywhere — the client owns no game state, and how
   * many PNGs a sentry is made of is not game state.
   */
  readonly sprite: string;
  x: number;
  y: number;
  facing: Direction;
  roomId: RoomId;
  /** Which map they are standing on. `x`/`y` are only meaningful against this Place's grid. */
  place: Place;
  /**
   * Who this is swinging at — `DESIGN-engagement.md` §2's **outbound pointer**.
   *
   * Exactly one, and the relationship is *not* symmetric: setting this does not make the target fight
   * back, which only happens because retaliation sets the target's own pointer separately. "Who is
   * fighting me" is the set of actors whose pointer names me, and it is **derived by scanning**, never
   * stored — §2 is explicit that there is no fight object to iterate.
   */
  fighting: EntityId | undefined;
  /**
   * What this body is wearing and wielding — **on `Actor` since Phase 16, and that is the change**.
   *
   * It used to be declared separately on `Player` and on `Mob`, which read as tidy and was the reason
   * `viewOf` had to gate on `isPlayer` to touch it at all: with no member on the base, describing "any
   * body's gear" needed a narrowing, and the narrowing quietly became a policy. Mobs had gear from 15c
   * onward and nobody could see it.
   *
   * Hoisting it says the true thing instead: **every body in this world has an equipment map, and most
   * of them are empty.** The two halves keep their own rules and neither moved — a player's is rolled at
   * creation and stored (`rollStarterKit`), a mob's is filled by the reset table *after* it spawns,
   * because `E` attaches to the last mobile loaded and the body must exist first. What is shared is only
   * that both can be read without asking which kind of thing this is.
   *
   * `combat.armourClass` is folded from it for both, at creation for a player and by `refitMobArmour`
   * for a mob. `combat.damage` is folded for a player only: a mob's damage is its harvested profile and
   * has never come from its weapon.
   */
  equipped: Equipped;
  /**
   * The last opponent this actor disengaged from.
   *
   * §2: *"Keep `wasFighting`."* One field, written by `disengage`, and it is what makes assist,
   * re-engagement after a flee, and "who were you just fighting" answerable at all — impossible to
   * reconstruct after the fact and cheap to keep.
   */
  wasFighting: EntityId | undefined;
  /**
   * The spell being wound up, or nothing — **Phase 20 slice 2**, `AFF2_CASTING` as a record rather
   * than a bit. On the Actor rather than the Player because mobs cast in slice 3, through the
   * source's own `MobCastSpell` shortcut, and a second copy of this field would be how the two paths
   * come to disagree about what casting *is*. `room` is where the cast began: the once-per-second
   * beat compares it against where the caster stands now, which is the whole of the forced-exit
   * interruption rule — no hook in `relocate`, exactly as the source's own beat says of itself:
   * *"this is simplistic part... called once / second."*
   */
  casting?: {
    readonly spell: string;
    readonly name: string;
    remainingMs: number;
    readonly totalMs: number;
    readonly room: RoomId;
    readonly target?: EntityId;
  };
  /**
   * The enemy that fled from this player and is owed a re-engagement on arrival. See `pursue.ts`.
   *
   * By **entity id**, not keyword, which is the whole point: `kill youth` picks the freshest youth
   * in the room, and the wounded one that ran is the one being chased. Players only — a mob's chase
   * is `hunt.ts`, with rules and give-up clocks a pair of legs does not need. Never persisted: a
   * pursuit is a moment, not a property.
   */
  pursuing: EntityId | undefined;
  /**
   * What this body fights with and how hard it is to hit. See `combat.ts`.
   *
   * On the actor rather than looked up from a template per swing, for the same reason `aggro` is: the
   * combat pass reads it every round for every combatant, and a player has no template to look up.
   */
  combat: CombatStats;
  /**
   * **This actor's own round length**, in milliseconds — §4.1's warning made a field.
   *
   * Not `ROUND_MS`. A single global round collapses every speed stat into "extra attacks per round", so a
   * fast dagger and a slow ogre become the same actor with a multiplier. Duris counts down a per-character
   * float and so do we; haste shortens this number for one body and touches nothing else.
   */
  roundMs: number;
  /**
   * How far this character can see, in tiles.
   *
   * A **derived stat**, not a tuning constant: it starts at the bare {@link DEFAULT_LIGHT_RADIUS}
   * and is raised by whichever light source they carry — so a torch is a real upgrade and can burn
   * out again. Never read a radius from anywhere else; that is what makes light a progression axis
   * rather than a number baked into rendering.
   */
  lightRadius: number;
  /**
   * Every timed effect on this character — the one list. See `shared/src/affects.ts`.
   *
   * **The only mutable source of truth for anything temporary.** `lightRadius` and {@link light}
   * below are both *derived* from it by {@link Simulation.recompute}, which is this project's
   * `affect_total`. Never splice it by hand: {@link Simulation.addAffect} and
   * {@link Simulation.removeAffects} exist so that no path can change what is on a character without
   * the derived stats following in the same breath.
   */
  affects: Affect[];
  /**
   * The light source being carried, or `undefined` for the bare eye.
   *
   * **Derived**, like `lightRadius` — both come from the `light` affect on the list above, and
   * {@link Simulation.recompute} is the one place either is written. It is cached on the character
   * rather than resolved at each read because `refreshVisible` consults it every tick to decide which
   * of the two illumination modes to run, and that is the hot path.
   *
   * How long is left is deliberately *not* cached beside it. That number changes every tick, so a copy
   * would mean recomputing every tick to keep it honest, which is exactly the incremental bookkeeping
   * the recompute discipline exists to avoid. Ask {@link Simulation.lightRemaining} instead.
   */
  light: LightSource | undefined;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  move: number;
  maxMove: number;
  level: number;
  /**
   * How the body is arranged. Independent of {@link status} — see `position.ts`.
   *
   * Never assigned directly outside {@link Simulation.setStance}: both axes are on the wire and a
   * change either has to reach the client or it is a divergence the player experiences as their
   * character refusing to move for no stated reason.
   */
  posture: Posture;
  /**
   * How conscious the body is. Derived from `hp` by {@link statusFor} *and* from its own previous
   * value, so it is refreshed rather than recomputed — see that function.
   */
  status: Status;
  /**
   * Fractional regeneration carried between ticks, one per pool.
   *
   * Regeneration is quoted per *minute* and spent per *tick*, so 13 hit points a minute is 0.0217 of a
   * point every 100 ms. Round that away each tick and every rate in the game is exactly zero for ever;
   * carry it and the pool moves at the rate it says it does. This is `regen_value` in
   * `event_hit_regen`, which does the same thing with a float.
   *
   * Transient. Nothing persists it — a fraction of a hit point is not worth a save, and the worst a
   * reconnect can cost you is a fiftieth of a point.
   */
  regenCarry: { hp: number; mana: number; move: number };
  /**
   * Milliseconds of being too winded to regenerate. Set by a successful flight, counted down by the
   * tick like an affect, and read by {@link Simulation.regenerate}.
   *
   * The owner's lever (2026-08-02): a fleeing kobold healed on the run, so the only practical kill
   * window at level 1 was its failed flee roll. On the base {@link Actor} because **one flee is one
   * price** — `attemptFlee` serves players and mobs through a single code path, and so does this.
   * Transient, like `regenCarry`: a pursuit does not survive a reconnect, so neither does the wind.
   */
  windedMs: number;
}

/**
 * An actor with somebody watching through its eyes.
 *
 * Everything here answers a question only a *client* asks: what am I steering toward, what route is the
 * server walking me along, and which tiles have light on them from where I am standing. A mob has none
 * of those because a mob has no client, and that is the line the split is drawn on.
 */
export interface Player extends Actor {
  readonly kind: 'player';
  /**
   * Race, class and the six scores — Phase 21, restored from the record on entry and undefined for
   * a character minted before the phase (who adopts on a later entry, DESIGN-characters.md §6).
   * The derivations read it through `refitCombat` and friends; nothing consults a score directly
   * mid-fight, for 1.5's recompute-from-base rule.
   */
  identity: PlayerIdentity | undefined;
  /**
   * The hairstyle this character chose — `appearance.HAIR_STYLES`' own id, or `bald`.
   *
   * **The first thing about a body that is a stored decision rather than a derivation**, and it is on
   * `Player` rather than on `Actor` because that is exactly the distinction: a mob has nowhere to keep
   * a choice and nobody to make one, so `viewOf` hashes its entity id instead. Restored from the
   * record on entry and `undefined` for a character who has never typed `hair` — which is not "bald",
   * it is "take the default", and `appearanceOf` reads the two apart.
   *
   * Character creation still lives in the 2D client and has no way to ask (which is why M7b skipped
   * hair altogether), so the deterministic default is what stands in for the missing creation step
   * and the command is how a player overrides it.
   */
  hair: string | undefined;
  /**
   * Castings spent, by circle — Phase 21 slice 2. Debited when a cast *completes* (the source's
   * pay-then-fizzle order), refilled by memorization while resting, persisted so a relog is not a
   * free refill.
   */
  spentSlots: Map<number, number>;
  /** Continuous rest toward the next slot back. Transient on purpose — standing resets the trance. */
  memorizeMs: number;
  /**
   * Who last spoke to you privately, and *how*. `reply`'s target. Transient; a session fact.
   *
   * The mode rides along rather than being a second field, so the two cannot drift: there is no way
   * to hold a name without holding the manner it arrived in. It matters because the two private
   * verbs have different reach — a `tell` crosses the world, a `whisper` is a sound in one room —
   * and `reply` answers **in kind**. Answering a whisper with a tell would take the reply out of the
   * room the whisper was standing in, leaving the onlookers who were shown *"X whispers something to
   * Y"* watching one half of a conversation. See `doReply`.
   */
  replyTo?: { readonly name: string; readonly mode: 'tell' | 'whisper' };
  /** Quest state by id — restored from the record, written back through it. Slice 7. */
  quests: Map<string, number | 'done'>;
  /** Latest steering intent, normalised, replaced each time the client sends one. */
  intentX: number;
  intentY: number;
  /**
   * The last dry room this character stood in before entering water — **the entry shore**, and the
   * owner's anti-ferry rule (2026-08-07): a drowned corpse washes up where you went in, or drowning
   * is a free crossing of any ocean. Transient on purpose; a reconnect mid-lake forgets it and the
   * wash falls back to the nearest shore, which is recorded as the corner it is rather than defended.
   */
  lastShore?: RoomId;
  /**
   * The room a continuous step was just refused into for lack of movement — the edge-trigger that
   * says "too exhausted" once per shoreline instead of ten times a second. See the tick's gate.
   */
  shoreBlocked?: number;
  /**
   * The route being walked by click-to-move, or undefined when moving manually.
   *
   * Tile coordinates only mean anything against `place`'s grid, so this is dropped the instant the
   * player changes Place — see {@link Simulation.relocate}.
   */
  path: ActivePath | undefined;
  /**
   * Tile indices lit right now, on `place`'s grid.
   *
   * **Transient.** This is `visible`, not `seen`: it is recomputed from where the character stands
   * and is never persisted. The union of every visible set is `seen`, which lives in the player
   * record — see `players.ts`. Conflating the two is the main way this feature goes wrong.
   */
  visible: ReadonlySet<number>;
  /**
   * Rooms this character has peeked into with `look <direction>`, and **where they were standing when
   * they did** — ranged slice 2, `DESIGN-ranged.md`.
   *
   * **`from` is the invalidation, and it is a field rather than a hook on purpose.** The reveal is
   * supposed to last while you stay put and die the moment you move, and a player's room changes in two
   * unrelated places — the walk in {@link Simulation.advance} and the teleport in
   * {@link Simulation.relocate}. Clearing it at both would work until somebody adds a third, and the
   * failure would be silent and exactly wrong: seeing into a room two away is the one thing the owner
   * ruled out (*"I shouldn't be able to see from 2 rooms away"*). Comparing `from` against the current
   * room instead makes a stale set unreadable by construction, and makes the no-chaining rule fall out
   * rather than be enforced — walk into the room you peeked at and the whole set is void, including it.
   */
  revealed: { readonly from: RoomId; readonly rooms: ReadonlySet<RoomId> } | undefined;
  /**
   * The tile and radius `visible` was computed for.
   *
   * Shadowcasting a couple of hundred tiles is cheap, but not free ten times a second per player for
   * a character who has moved four pixels within the same tile. Light only changes when the tile
   * under the character or the radius does, so those three numbers are the whole cache key. See
   * {@link Simulation.refreshVisible}.
   */
  visibleTx: number;
  visibleTy: number;
  visibleRadius: number;
  /**
   * The room `visible` was computed for, when the carried source lights by **room** rather than by
   * radius. {@link NEVER} whenever the tile key above is the live one.
   *
   * A separate key because a beacon's lit set does not change as you walk across a room — it changes
   * when you *leave* it. Keying room-mode light on the tile would rebuild the whole room graph walk
   * every time the character crossed a tile boundary, nine times per room, for an identical answer.
   * Exactly one of the two keys is live at a time; whichever branch runs clears the other, so
   * swapping a torch for a beacon and back always recomputes rather than reading a stale set.
   */
  visibleRoom: RoomId;
  experience: number;
  /**
   * Accumulated flat damage from levelling — `DESIGN-progression.md` §8.
   *
   * Rolled once per level and stored on the record, exactly as `maxHp` is, and for the same reason: a
   * character's damage is a fact about them rather than something a formula reproduces. Zero for a
   * fresh character, because §8's bands give nothing below level 6.
   */
  damageBonus: number;
  /**
   * Skill proficiency ground **above the level's floor** — Phase 19.
   *
   * Sparse, and the sparseness is the design rather than a saving: the floor is a pure function of level
   * (`skillFloor`), so a skill with no entry here is not "unknown", it is *at the floor* — and a level
   * gain therefore drags every skill up without touching this map at all. `learnedAt` is the one road
   * from this to a number, and nothing should read the map directly.
   *
   * A `Map` on the player rather than a store of its own, unlike `following` and `grouping`: this is a
   * fact **about one character**, the same kind of thing as `experience` and `damageBonus`, and the
   * separate-store argument only applies to facts *between* characters.
   */
  skills: Map<SkillId, number>;
  // `equipped` is on `Actor` since Phase 16 — see the note there. A player's is rolled at creation and
  // stored, never re-derived: the same discipline as `maxHp`, and for the same reason. Acquiring,
  // dropping and swapping any of it arrived in Phase 15b; the roll is still where the first kit comes from.
  /**
   * What this character is carrying but not wearing. Phase 15b — `inventory.ts` is the maths.
   *
   * Separate from `equipped` because **worn gear costs no capacity** (`DESIGN-inventory.md` §6): what
   * you have on is not luggage. A character in thirty slots of plate carries an empty bag.
   */
  inventory: Inventory;
  /**
   * Coin, in all four of Duris currencies. Phase 15c — see `containers.ts`.
   *
   * **A number on the character, not a stack in the bag.** Coins as an item would cost slots, so a
   * player emptying a dungeon would spend their bag on money and have nowhere to put the loot. Duris
   * does the same (`points.cash`), and so does every Diku.
   */
  purse: Purse;
}

/**
 * An actor the world drives.
 *
 * Bare on purpose. Phase 7's mob is **hand-placed and motionless** — it stands where the world
 * configuration says and does nothing — so the only thing it needs beyond a body is a note of where it
 * came from, for the log line at boot and for the day something asks "which of these is that placement".
 * Aggression, reaction time, memory and pursuit are Phases 9 and 10; templates and reset tables are
 * Phase 8. None of them are declared here, because a field no code reads is how this project ended up
 * with four tested-and-never-called mechanisms.
 */
export interface Mob extends Actor {
  readonly kind: 'mob';
  /**
   * Who it objects to and how long it takes to work that out. From its template — see `aggression.ts`.
   *
   * On the actor rather than looked up per tick because the perception pass reads it for every aggressive
   * mob every tick, and a template lookup is a map probe to learn something that cannot change.
   */
  readonly aggro: AggroRule;
  /**
   * The door this mob wandered through last pulse — `last_direction`, the source's anti-backtrack
   * (`mobact.c:7536`). Transient and unsaved: a restart forgetting which way a kobold drifted is not
   * a fact anyone can miss.
   */
  lastWander?: Direction;
  /**
   * Whether it follows you out of the room, how far, and what turns it back. From its template — see
   * `pursuit.ts`. Beside {@link aggro} rather than inside it because noticing and chasing are different
   * decisions read by different passes.
   */
  readonly pursuit: PursuitRule;
  /**
   * The hit points it breaks off and runs at, or 0 for one that never does — `ACT_WIMPY`, resolved to a
   * number by the harvest. Read on round boundaries; see `morale.ts`.
   *
   * Beside {@link pursuit} for the same reason that sits beside {@link aggro}: whether a thing chases
   * you and whether it stays to be fought are different decisions read by different passes, and a mob
   * can perfectly well be a relentless hunter *and* a coward.
   */
  readonly wimpyAt: number;
  /**
   * The MUD's own mob vnum — never a renumbering of ours, the same rule room and zone ids follow.
   *
   * **Instance limits are counted on this**, and the count is world-wide: a mob of this vnum standing
   * anywhere at all suppresses its own replacement, which is what makes a lured mob leave a hole. See
   * `reset.ts`.
   */
  readonly vnum: number;
  // `equipped` is on `Actor` since Phase 16 — see the note there. A mob's is filled from the zone file's
  // `E` commands *after* it spawns, because `E` attaches to the last mobile loaded; `refitMobArmour`
  // folds the whole kit into `combat` once, rather than per piece.
  /**
   * What it is carrying but not wearing — the zone file's `G` commands.
   *
   * A plain list rather than an `Inventory`, and that is deliberate: capacity is a *player's* problem.
   * A mob's kit is authored rather than accumulated, so a bag that could refuse it would only ever mean
   * a builder's row silently doing nothing.
   */
  carrying: Item[];
}

export interface Transition {
  readonly player: Player;
  readonly from: RoomId;
  readonly to: RoomId;
  /** The Place the player left. Carried so callers need no special case for arriving on a new map. */
  readonly fromPlace: Place;
}

/**
 * Something that happened to a timed effect this tick.
 *
 * Facts, not prose. The simulation knows a torch went out; how that is worded, and on which log
 * channel, is `index.ts`'s business — the same split as every other event here. It matters more than
 * usual for expiry, because the requirement is that it *announces itself clearly*: a radius that
 * silently shrinks in a dark zone reads as a bug rather than a mechanic, so the announcement is part
 * of the feature and not decoration on it.
 *
 * One event per **cause**, not per record — see {@link Simulation.expireAffects}.
 */
export type AffectEventKind =
  /** About to lapse, by its type's own warning threshold. Fired once per instance. */
  | 'expiring'
  /** Lapsed. Already off the character's list by the time this is reported. */
  | 'expired';

export interface AffectEvent {
  /**
   * Whose effect lapsed — **either kind**. A mob's affects expire through the same pass a player's do,
   * which is the point of Phase 5b's one list and Phase 7's one map. Nothing is announced to a mob; the
   * announcer in `index.ts` sends only to players, and does so by asking rather than by assuming.
   */
  readonly actor: Actor;
  readonly kind: AffectEventKind;
  /**
   * The affect the event is about. For `expiring`, `durationMs` is how long is left; for `expired` it is
   * zero and the record has already been spliced off the character's list, so it is safe to read but
   * says nothing about the present.
   */
  readonly affect: Affect;
  /**
   * What the expiry installed in its place — a Beacon's torch, a rest cycle's next stage. Empty when
   * nothing followed.
   *
   * Carried because the announcement is usually *about* the successor: "leaving a pitch-soaked torch"
   * and "you catch your second wind" are both sentences the announcer has no other way to write.
   */
  readonly chained: readonly Affect[];
}

export interface TickResult {
  /** Players whose position changed this tick. */
  readonly moved: readonly Player[];
  readonly transitions: readonly Transition[];
  /** Routes that finished or were given up on this tick, so the client can be told to stop drawing. */
  readonly pathsEnded: readonly PathEnded[];
  /** Players a continuous step just refused for lack of movement — edge-triggered, one per shoreline. */
  readonly winded: readonly Player[];
  /**
   * Walkers standing on the last tile of their room with a **seam** ahead of them, asking to be
   * carried across. The sim reports rather than acts: crossing charges movement, announces to two
   * rooms and obeys the fight rules, and none of that is this file's business.
   */
  readonly seamCrossings: readonly { readonly player: Player; readonly dir: Direction }[];
  /**
   * Players whose lit set changed for a reason **other than moving** — a torch lit, a spell cast, a
   * Beacon of Hope crumbling to dust.
   *
   * Reported separately because everything else the tick loop does is keyed on movement, and a
   * character who lights a torch standing still moves nothing. Without this they would keep the old
   * disc until they next crossed a tile: `seen` would not grow, no `seenDelta` would go out, and a
   * client already painting the wider radius would click ground the server still refuses. That is
   * the one client/server divergence the delta protocol cannot absorb, so it is closed here rather
   * than left to whoever writes the first light source.
   *
   * It also fires when the lit set is *unchanged* but the carried source is not — swapping a torch
   * for an everburning one is the same radius and a different `SelfView.light`, and the client
   * counts `remainingMs` down itself, so it has to be told. Re-sending `self` for a player whose
   * disc did not actually move is harmless; not sending it leaves a HUD counting down a torch that
   * is no longer in their hand.
   */
  readonly relit: readonly Player[];
  /** Timed effects that lapsed this tick, or are about to. One entry per cause. */
  readonly affectEvents: readonly AffectEvent[];
  /**
   * Players whose hit points, mana or movement moved this tick.
   *
   * Reported so `self` is sent only to the characters whose numbers actually changed. Regeneration
   * touches a pool at most a few times a second even at the fastest rate — 16 per minute is one point
   * every four seconds — so broadcasting a `self` per player per tick would be forty times the traffic
   * for the same information.
   */
  readonly vitalsChanged: readonly Actor[];
}

/**
 * The four directions an arrival edge can mean.
 *
 * `up` and `down` are dropped rather than mapped: a staircase has no wall you come through, so the
 * honest landing for one is the room's centre — the same answer a teleport and a portal get.
 */
function lateralHeading(dir: Direction | undefined): 'north' | 'east' | 'south' | 'west' | undefined {
  return dir === 'north' || dir === 'east' || dir === 'south' || dir === 'west' ? dir : undefined;
}

export class Simulation {
  private readonly world: GameWorld;
  /**
   * What kind of thing a worn item is, for drawing it — protocol 14's art class.
   *
   * **Injected, because the answer is in the catalogue and this file has no business holding it** — the
   * same seam `reset.ts` uses for its object census. Set by `index.ts` at boot; left undefined, every
   * item falls back to its own id, which is exactly the pre-14 behaviour and what a checkout with no
   * harvested catalogue should do.
   *
   * It cannot be derived from the `Item` alone, and that was measured rather than assumed: of the 4,820
   * off-hand items in the catalogue, "has armour and no damage dice" catches 417 — but **177 of those
   * are sleeves and bracers**, `ITEM_ARMOR` pieces that happen to map to the off hand. A character in
   * studded leather sleeves would have grown a shield.
   */
  artClassOf: ((item: Item) => string | undefined) | undefined;
  /**
   * The category silhouette for a bag row with no art — protocol 29, injected for `artClassOf`'s
   * reason: the taxonomy needs the catalogue's `type`, which is `index.ts`'s business. Returns the
   * ground sprite family (`item_flask`, …) the floor has drawn since 15b, so a potion in the bag
   * and a potion on the flagstones are the same silhouette.
   */
  iconOf: ((item: Item) => string) | undefined;
  /**
   * What a catalogue item is worth as a light, injected for the same reason {@link artClassOf} is:
   * the item catalogue is `index.ts`'s and `sim.ts` has no business importing it.
   *
   * Phase 16. Keyed by **id** rather than by `Item` because both callers have one and only one has
   * the object: `heldLights` looks up what is in a hand, and the resolver handed to `brightestLight`
   * turns an affect's `obj:<vnum>` context back into a source so a held light's burn can ride the
   * ordinary affect clock instead of a second timer beside it.
   */
  lightOf: ((id: string) => LightSource | undefined) | undefined;
  /**
   * Everything in the world with a body, players and mobs alike, in **one** map.
   *
   * One rather than two, and that is the point of Phase 7. Two maps would mean every pass over the
   * world — regeneration, affect expiry, presence, the visibility gate — either iterating both or
   * quietly forgetting one, and the one it forgot would be mobs, because mobs came second. A single map
   * with a `kind` discriminator makes "everyone" the default and "only players" the thing you have to
   * ask for by name.
   *
   * Ids are unique across both kinds, from one counter, so nothing downstream has to know which map an
   * `EntityId` came from.
   */
  private readonly actors = new Map<EntityId, Actor>();
  /**
   * Players whose light changed since the last tick, drained into {@link TickResult.relit}.
   *
   * Ids rather than players, so a character who disconnects between the change and the tick is
   * dropped by the lookup instead of being reported as a live object that is no longer in the world.
   *
   * Players only: this is "whose client needs telling", and a mob has no client. {@link recompute}
   * enforces that rather than relying on the drain to silently miss.
   */
  private readonly relit = new Set<EntityId>();
  private nextId = 1;
  private readonly crowdingTally = { stacked: 0, blocked: 0 };

  constructor(world: GameWorld) {
    this.world = world;
  }

  /* ------------------------------------------------------------------ */
  /* Solid bodies — the two funnels                                      */
  /* ------------------------------------------------------------------ */

  /**
   * **The one way a body moves continuously**, and the reason it is a method rather than four calls to
   * `stepBody`.
   *
   * Four passes move a body a fraction of a tile at a time — the player walk in {@link tick},
   * `hunt.ts`'s in-room drift and its room-to-room walk, and `station.ts` closing a fighter to melee —
   * and they must not disagree about what a body may walk through. Routing all four through here means
   * a fifth mover written next year gets the rule by construction; the alternative is a discipline, and
   * this file's history is a list of disciplines that were forgotten once.
   *
   * With nothing solid nearby this is `stepMovement` exactly, so terrain behaviour is untouched.
   */
  stepActor(
    actor: Actor,
    grid: TileGrid,
    intentX: number,
    intentY: number,
    distance: number,
  ): { x: number; y: number } {
    return stepBody(grid, actor, intentX, intentY, distance, this.bodiesNear(actor));
  }

  /**
   * Everyone close enough to `actor` to be worth testing against.
   *
   * A box rather than the room, and deliberately: two outdoor rooms merge along their whole shared
   * edge, so a body standing just over a seam is inches away on the same continuous ground while being
   * in a different room entirely. {@link BODY_QUERY_REACH} is generously larger than one tick's travel
   * plus {@link BODY_SEPARATION}, so nothing can cross the box's edge and the separation in one step.
   *
   * O(actors) per mover per tick, which is the cost `actorsIn` and `playersIn` already pay several
   * times a tick; movers are a handful even in a busy zone.
   */
  private *bodiesNear(actor: Actor): Iterable<BodyPoint> {
    for (const other of this.actors.values()) {
      if (other.id === actor.id) continue;
      if (!samePlace(other.place, actor.place)) continue;
      if (Math.abs(other.x - actor.x) > BODY_QUERY_REACH) continue;
      if (Math.abs(other.y - actor.y) > BODY_QUERY_REACH) continue;
      yield other;
    }
  }

  /**
   * **The one way a body is put on the floor** — spawns, zone resets and arrivals alike.
   *
   * Answers in *pixels* rather than tiles, because that is what every caller assigns to `x`/`y`, and
   * tallies the degradations on the way past so a crowded den shows up as a number rather than as two
   * kobolds in the same square. `self` is excluded from the occupancy scan: a body being relocated is
   * still standing wherever it was and must not refuse its own destination.
   */
  private landing(
    grid: TileGrid,
    place: Place,
    roomId: RoomId,
    origin: { readonly tx: number; readonly ty: number },
    prefer: { readonly tx: number; readonly ty: number },
    self?: EntityId,
  ): { x: number; y: number; landing: Landing } {
    const occupied: BodyPoint[] = [];
    for (const other of this.actors.values()) {
      if (other.id === self) continue;
      if (other.roomId !== roomId) continue;
      if (!samePlace(other.place, place)) continue;
      occupied.push(other);
    }
    const landing = placeBody(grid, roomId, origin, prefer, occupied);
    if (landing.stacked) this.crowdingTally.stacked++;
    if (landing.blocked) this.crowdingTally.blocked++;
    return { x: tileCentre(landing.tx), y: tileCentre(landing.ty), landing };
  }

  /**
   * How many bodies have had to be placed badly, ever, on this server.
   *
   * **A missing mob is worse than an overlap**, so {@link landing} degrades rather than refusing — but a
   * degradation that nobody can see is indistinguishable from a bug. `reset.ts` reads this before and
   * after a pass to report what that pass cost, and the boot log prints the total.
   */
  get crowding(): { readonly stacked: number; readonly blocked: number } {
    return this.crowdingTally;
  }

  get tickMs(): number {
    return TICK_MS;
  }

  room(id: RoomId): Room | undefined {
    return this.world.locate(id)?.room;
  }

  /** Every actor in the world, of either kind. The default, and what most passes want. */
  allActors(): Iterable<Actor> {
    return this.actors.values();
  }

  /** Every player. Narrower than {@link allActors}, so asking for it is a decision. */
  *allPlayers(): Iterable<Player> {
    for (const actor of this.actors.values()) if (isPlayer(actor)) yield actor;
  }

  /** Any actor by id, whichever kind. */
  get(id: EntityId): Actor | undefined {
    return this.actors.get(id);
  }

  /**
   * A player by id, or nothing if that id is a mob.
   *
   * The socket handlers want this one: a client can only ever be driving a player, and a message that
   * named a mob's id must not be honoured as if it named the sender.
   */
  player(id: EntityId): Player | undefined {
    const actor = this.actors.get(id);
    return actor && isPlayer(actor) ? actor : undefined;
  }

  /**
   * Everything standing in a given room — the unit of interest management. Room ids are globally
   * unique, so no Place check is needed: two actors in the same room are on the same map by definition.
   *
   * This is what **presence** is built from, so it must be every kind of body. `visibleEntities` in
   * `index.ts` calls it, and that is the single authority on who is drawn.
   */
  actorsIn(roomId: RoomId): Actor[] {
    const out: Actor[] = [];
    for (const a of this.actors.values()) if (a.roomId === roomId) out.push(a);
    return out;
  }

  /**
   * The players in a room — the ones a message can be *sent* to.
   *
   * Deliberately distinct from {@link actorsIn}, and both are real: presence asks "what is standing
   * here" and includes mobs, while `act()` and every `send` ask "who is listening" and cannot. Merging
   * them would either post log lines to things with no socket or hide mobs from the room view.
   */
  playersIn(roomId: RoomId): Player[] {
    const out: Player[] = [];
    for (const a of this.actors.values()) if (a.roomId === roomId && isPlayer(a)) out.push(a);
    return out;
  }

  /**
   * A brand-new character.
   *
   * Takes the rng for the same reason {@link spawnMob} does: the starting kit is rolled, and every
   * roll in the simulation comes from the seeded source — `CLAUDE.md` rule 3. Character creation is
   * simulation, and `Math.random()` here would make a character's opening hand unreproducible.
   *
   * `classId` is the chosen class, where there is one — the kit reads it so a paladin starts with the
   * sword and shield their skill table now assumes. It arrives as an argument rather than off
   * `player.identity` because the identity is hydrated by `restoreProgress` *after* this returns, so
   * reading it here would see `undefined` for every character ever created.
   */
  spawn(name: string, rng: Rng, classId?: ClassId): Player {
    const spawnRoom = this.world.spawnRoom();
    const place = placeOf(spawnRoom);
    const grid = this.world.grid(place);
    const origin = grid?.roomOrigins.get(spawnRoom.id);
    if (!grid || !origin) throw new Error(`spawn room ${spawnRoom.id} is not on any rendered grid`);
    // The centre is the preference, not the destination: a second character logging in should not land
    // inside the first, and the recall room is as entitled to a fountain in the middle as any other.
    const spot = this.landing(grid, place, spawnRoom.id, origin, roomCentre(origin));

    // **Phase 14b: the MUD's scale, not the SRD's.** `maxHitPoints(8, 1, 1)` gave 9 — the SRD's
    // d8-plus-Con — and the gentlest creature in the world is a level-2 baby kobold with 23. The
    // player needed seven rounds to kill it and died in five. See `DESIGN-progression.md` §1.
    const maxHp = STARTING_HIT_POINTS;
    // Rolled once, here, and stored on the record at the first save. The variance is the point: two
    // fresh characters are not the same character. See `equipment.ts`.
    const equipped = rollStarterKit(rng, classId);
    const base = playerCombatStats(1);
    const player: Player = {
      id: this.nextId++,
      kind: 'player',
      name,
      // One art key for every player. Which layers that is, and that they are LPC at all, is the
      // client's business — see `Actor.sprite`.
      sprite: 'human',
      // Centre of the tile, not its corner, so the collision box starts clear of walls.
      x: spot.x,
      y: spot.y,
      facing: 'south',
      roomId: spawnRoom.id,
      place,
      fighting: undefined,
      wasFighting: undefined,
      pursuing: undefined,
      equipped,
      // Empty, and it stays that way until they pick something up. A starting bag with something in
      // it would be a second kit nobody rolled.
      inventory: emptyInventory(),
      // Nobody starts with money. What you have, you took off something.
      purse: emptyPurse(),
      combat: {
        ...base,
        armourClass: base.armourClass + armourClassFrom(equipped),
        damage: weaponFrom(equipped, base.damage),
      },
      roundMs: base.roundMs,
      intentX: 0,
      intentY: 0,
      path: undefined,
      lightRadius: DEFAULT_LIGHT_RADIUS,
      // Nothing is affecting a new character, which is why the two derived fields below can be
      // written literally here rather than through `recompute`: the fold over an empty list is exactly
      // the bare eye, and asserting that is cheaper to read than calling the machinery to prove it.
      affects: [],
      // Everyone starts in the dark. Light is something you find, so there is no starting torch and
      // no "first light source" to configure — the bare radius is the whole of a new character's
      // vision until they walk onto something.
      light: undefined,
      visible: NOTHING_VISIBLE,
      // Nothing peeked at yet. A fresh character has looked nowhere, which is the same state a moved
      // one is in — see the field's own note on why that is a comparison rather than a reset.
      revealed: undefined,
      visibleTx: NEVER,
      visibleTy: NEVER,
      visibleRadius: NEVER,
      visibleRoom: NEVER,
      hp: maxHp,
      maxHp,
      mana: 30,
      maxMana: 30,
      move: MAX_MOVE_POOL,
      maxMove: MAX_MOVE_POOL,
      level: 1,
      experience: 0,
      // Nobody until the record says so — set by `restoreProgress`, minted by creation. Phase 21.
      identity: undefined,
      // Likewise: `undefined` means *nothing chosen*, which `appearanceOf` reads as "hash my name for
      // a default" and not as "bald". Only `hair bald` produces a bald character.
      hair: undefined,
      spentSlots: new Map(),
      memorizeMs: 0,
      quests: new Map(),
      // §8 gives nothing below level 6, so a fresh character genuinely starts at zero rather than
      // starting at a number nobody rolled.
      damageBonus: 0,
      // Empty, and empty is not "no skills" — every skill is at this level's floor, derived. Phase 19.
      skills: new Map(),
      // On your feet and awake. Both axes start at the top; everything that lowers them is either a
      // command or damage, and damage does not exist yet.
      posture: 'standing',
      status: 'normal',
      regenCarry: { hp: 0, mana: 0, move: 0 },
      windedMs: 0,
    };
    this.actors.set(player.id, player);
    return player;
  }

  /* ------------------------------------------------------------------------ */
  /* Affects                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Puts affects on a character and re-derives everything they feed.
   *
   * The one entry point, so that "the list changed" and "the derived stats changed" cannot come apart.
   * Duris achieves the same thing by having `affect_to_char` schedule `event_balance_affects` at delay
   * 0 — deferred and coalesced, so N changes in one pulse cost one rebuild
   * (`REFERENCE-mud-mechanics.md` §1.5). We rebuild immediately instead, and that is not laziness: the
   * fold is a walk of a list that is currently at most four entries long, and the deferral exists to
   * amortise a walk over ~165 boolean flags and every worn item. Coalescing four multiplications
   * behind a queue would cost more than it saved and would introduce a window in which a character's
   * stats disagree with their affects. When equipment lands in Phase 16 and the fold gets expensive,
   * *that* is when it earns a delay-0 event — and this is the one place it would go.
   */
  addAffect(actor: Actor, affects: Affect | readonly Affect[], policy: StackPolicy = 'replace'): boolean {
    const incoming = Array.isArray(affects) ? affects : [affects as Affect];
    const { changed } = addAffects(actor.affects, incoming, policy);
    if (changed) this.recompute(actor);
    return changed;
  }

  /**
   * Takes every node of a type off a character — the removal path, and therefore the dispel path.
   *
   * Every node, not the first: one cause installs one node per stat it touches, so removing by type
   * has to remove the run (`REFERENCE-mud-mechanics.md` §4.12). Returns them, because a caller
   * announcing a removal usually needs to know what it was that went.
   */
  removeAffects(actor: Actor, type: AffectType): Affect[] {
    const removed = removeType(actor.affects, type);
    if (removed.length > 0) this.recompute(actor);
    return removed;
  }

  /** Every node of a type currently on a character. */
  affectsOf(actor: Actor, type: AffectType): Affect[] {
    return actor.affects.filter((affect) => affect.type === type);
  }

  /**
   * Replaces a character's whole list — the one caller being a login restoring what was saved.
   *
   * Wholesale rather than affect-by-affect on purpose: a saved list is already a coherent set, and
   * feeding it through {@link addAffect} would apply stacking policies to nodes that were never
   * stacked, so a two-node cause could arrive as one. It takes ownership of the array it is given, so
   * the caller must hand over a copy if it intends to keep reading its own.
   */
  restoreAffects(actor: Actor, affects: Affect[]): void {
    actor.affects = affects;
    this.recompute(actor);
    // Nothing persists the *status*, so today a returning character is always `normal` and this call
    // does nothing. It is here because the invariant it keeps is about this method rather than about
    // logging in: a wholesale replace of the list has to leave the rest clock agreeing with the ladder,
    // and the day status is saved is not the day to remember that.
    this.refreshRest(actor);
  }

  /**
   * Rebuilds every derived stat from base — this project's `affect_total`.
   *
   * **The single derivation point.** Before Phase 5b there was exactly one derived stat and one place
   * that derived it, documented as *"the one place `lightRadius` is derived"*; this is that discipline
   * generalised rather than a second copy of it. Nothing here adjusts: it computes what each stat
   * *should* be from the base value and the whole list, and assigns. There is no `unapply` and there
   * must never be one — one missed undo and a character keeps a bonus for ever, invisibly, until
   * somebody notices the numbers are wrong and has no way to tell when they went wrong.
   *
   * Two things it does not do yet, both deliberate:
   *
   * - **No wound preservation.** Duris saves `missing_hps` before every rebuild and restores it after,
   *   because `max_hit` is itself derived and a rebuild can move it. Nothing in our taxonomy touches a
   *   maximum, so the save/restore would be `hp = maxHp - (maxHp - hp)` — arithmetic with no effect.
   *   The moment a `maxHp` location exists it belongs *here*, wrapped round the assignments below, and
   *   the persistence layer already stores the wound rather than the value for the same reason.
   * - **No death check.** `affect_total` tests whether the rebuild dropped the character below the
   *   death threshold and calls `die()`. Ours cannot, for the same reason: no location moves hit
   *   points.
   */
  private recompute(actor: Actor): void {
    // **Phase 16: the fold is over hands *and* affects, and `bestLight` arbitrates.** The roadmap
    // asked for best-of-equipped and `bestLight` has taken a list since Phase 5 waiting for one.
    //
    // Two contributors, not one, because they answer different questions. A **held** light is a fact
    // about your equipment and needs no clock when it never goes out — 35 of the world's 78 light
    // records are Duris' `-1`. An **affect** is a fact about time: it is how a finite burn counts
    // down, how the `GAME_DEV_LIGHT` ring works, and where a light spell will land in Phase 20. A
    // held light with a finite burn is therefore *both*, and appears in both lists — which costs
    // nothing, since `bestLight` keeps the incumbent on a tie and the two entries are equal.
    const lit = brightestLight(actor.affects, (id) => this.resolveLight(id));
    const best = bestLight([...this.heldLights(actor), lit?.source]);
    actor.light = best;
    // Slice 6: blood puts a floor under the bare eye — ultravision reaches 4, infravision 3 — and
    // it is a floor, never a replacement: a torch still out-reaches drow eyes. Mobs and the
    // identity-less keep the surface default through `bareRadiusFor`'s own fallback.
    const bare =
      isPlayer(actor) && actor.identity ? bareRadiusFor(RACES[actor.identity.race].vision) : DEFAULT_LIGHT_RADIUS;
    this.setLightRadius(actor, Math.max(effectiveRadius(best), bare));
    // Queued unconditionally rather than only when the radius moved, and the name of the queue is now a
    // little narrower than what it carries: `relit` is the one channel that tells a client its *own*
    // state changed, and everything hanging off it is either needed here or a cheap no-op. The `self` is
    // needed — the affect list is on it and the client counts the clocks down itself. The `seen` fold
    // costs nothing when the radius did not move, because the visible-set cache key did not move either.
    // The persistence write diffs before it dirties anything. Only the entity re-sync is genuinely
    // spare work, and affects change a few times a minute per character rather than per tick.
    this.relit.add(actor.id);
  }

  /**
   * Every light this character is carrying, **wherever it is** — worn, wielded, or in the bag.
   *
   * Owner's rule, 2026-08-06: *"light should come with no space, weight or slot cost… they can light from
   * the inventory."* So the two-hand rule below is gone, and with it the reason **11 of the catalogue's 64
   * lights could never work** — five glowing earrings, a set of golden horseshoes, and five with no wear
   * slot at all, which could not be equipped anywhere.
   *
   * **Read off the item rather than through `lightOf`**, which is what makes this possible: `Item.light`
   * carries the radius and the burn, so a bag walk needs no catalogue and an authored item works with no
   * entry in one. `lightOf` survives for the affect path, where all there is to go on is an id.
   *
   * Containers are searched too. A lantern in a quiver is a lantern you are carrying, and a rule that
   * stopped one level down would be a rule nobody could hold in their head.
   */
  private *carriedLightsOf(player: Player): Generator<LightSource> {
    for (const item of Object.values(player.equipped)) {
      if (!item?.light) continue;
      const source = lightSourceFrom(item.id, item.name, item.light);
      if (source) yield source;
    }
    yield* this.bagLights(player.inventory.stacks);
  }

  /** The lights in a bag, and inside anything in it. Depth is bounded at 2 by `containers.ts`. */
  private *bagLights(stacks: readonly Stack[]): Generator<LightSource> {
    for (const stack of stacks) {
      if (stack.item.light) {
        const source = lightSourceFrom(stack.item.id, stack.item.name, stack.item.light);
        if (source) yield source;
      }
      const inside = stack.held?.contents;
      if (inside && inside.length > 0) yield* this.bagLights(inside);
    }
  }

  /**
   * The light sources in a character's hands — Duris' `handler.c:431`, transcribed.
   *
   * *"if (((i >= WIELD) && (i <= HOLD)) && (ch->equipment[i]->type == ITEM_LIGHT) &&
   * ch->equipment[i]->value[2])"* — a lantern in your bag lights nothing. That is the whole of the
   * rule and the reason the interim `carriedLight` field had to collapse: it was a light beside your
   * inventory rather than a fact about it, so putting one down changed nothing and picking one up
   * needed a special case.
   *
   * Empty for a mob, and for every character before `lightOf` is injected — a `Simulation` built in a
   * unit test has no catalogue and must not need one to run a fight.
   */
  private heldLights(actor: Actor): LightSource[] {
    if (!isPlayer(actor)) return [];
    const out: LightSource[] = [];
    for (const source of this.carriedLightsOf(actor)) {
      // **Only the ones that never go out.** A finite light is represented by its burn affect and by
      // nothing else, so that when the affect expires the light actually stops — with the item still
      // sitting where it was, which is what Duris does (`value[2]` hits zero and the torch stays a
      // burnt-out torch). Listing it here as well would mean a guttered torch that never dims.
      if (source.durationMs === undefined) out.push(source);
    }
    return out;
  }

  /**
   * A light affect's `context` turned back into a source.
   *
   * The six hand-authored ids first, then the catalogue — in that order rather than the other way
   * because the authored ones are the ladder `pickups.ts` scatters and the dev ring, and they must
   * keep resolving even with no catalogue injected at all.
   */
  private resolveLight(id: string): LightSource | undefined {
    return lightSource(id) ?? this.lightOf?.(id);
  }

  /**
   * The one writer for a character's bag — **assign through this and the light cannot go stale.**
   *
   * Since 2026-08-06 a light lights you from **the bag** as well as from a slot, which turned every bag
   * write into a light change. There were twelve of them and four re-derived; the other eight would each
   * have needed a call, which is precisely the shape `afterKitChange`'s own comment warns about: *"a rule
   * installed at any one of those would be missing from the other five."*
   *
   * So the assignment is the seam. `player.inventory = x` outside this method is the bug, and the only
   * places that still do it are the ones building a character from nothing (`spawn`) where there is no
   * light to derive yet.
   */
  setInventory(player: Player, next: Inventory): void {
    player.inventory = next;
    this.syncHeldLight(player);
  }

  /**
   * Re-derives the burn clock after anything moves in or out of the kit **or the bag**.
   *
   * **Only finite lights get an affect.** One that never goes out is a standing fact about your
   * equipment and needs no timer; giving it one would put a clock on the HUD that never moves and an
   * expiry event that never fires. One that *does* burn needs the affect, because the affect list is
   * this simulation's only source of truth for anything temporary and a second timer beside it is the
   * bespoke thing Phase 5b deleted.
   *
   * **The burn is not restarted when something else changes.** The affect is left alone while the
   * same item is still the winner, so buckling on a shield does not refill your torch — the guard is
   * on `context`, which is the item's own id.
   */
  syncHeldLight(actor: Actor): void {
    // Typed as *definitely* finite rather than filtered and asserted: the burn below is required, and
    // a cast there would be the one place a source that never expires could quietly acquire a clock.
    const finite: (LightSource & { readonly durationMs: number })[] = [];
    if (isPlayer(actor)) {
      for (const source of this.carriedLightsOf(actor)) {
        if (source.durationMs !== undefined) finite.push({ ...source, durationMs: source.durationMs });
      }
    }
    // `bestLight` widens back to `LightSource`, so the winner is re-found in the list that knows it
    // is finite. One extra scan of at most two entries, against a cast that could go wrong silently.
    const winner = bestLight(finite);
    const best = winner ? finite.find((f) => f.id === winner.id) : undefined;
    // Only the affect this function owns. A `light` affect whose context is not an `obj:` id is the
    // dev ring or a scattered pickup, and swapping a shield must not put one out.
    const at = actor.affects.findIndex((a) => a.type === 'light' && a.context?.startsWith('obj:') === true);
    const current = at < 0 ? undefined : actor.affects[at];
    if (best) {
      if (current?.context === best.id) return;
      if (at >= 0) actor.affects.splice(at, 1);
      actor.affects.push(
        newAffect({
          type: 'light',
          durationMs: best.durationMs,
          apply: 'light',
          // `NoShow`, like the carried light it replaces: it has its own HUD line and its own prose.
          flags: AffectFlag.NoShow,
          context: best.id,
        }),
      );
    } else if (at >= 0) {
      // Either the hands are empty or what is in them never expires. Both mean the clock is wrong.
      actor.affects.splice(at, 1);
    }
    this.recompute(actor);
  }

  /**
   * How much burn the carried light has left, or `undefined` when it never runs out.
   *
   * Read through from the affect rather than cached on the character — see {@link Player.light}. Every
   * caller of this is a display or persistence path, none of them per-tick, so the walk is free.
   */
  lightRemaining(actor: Actor): number | undefined {
    // **The resolver is not optional here, and leaving it off was caught by driving it.** Without it
    // a held lantern's `obj:<vnum>` context does not resolve, this walk finds nothing, and the HUD
    // reports a 960-second lantern as one that never runs out — the opposite of true, on the one
    // number the whole light resource is made of. Same resolver as `recompute`'s, for the same reason:
    // two derivations of "which light is winning" must not be able to disagree.
    return burnRemaining(brightestLight(actor.affects, (id) => this.resolveLight(id))?.affect);
  }

  /**
   * Starts, keeps or drops the unbroken-rest clock, according to where the status ladder now is.
   *
   * Called from {@link setStance}, which is the only writer of `status`, so there is no path by which
   * a character can settle into a rest the mechanism does not know about. The three cases:
   *
   * - **Stopped resting** — the wait is over and it did not pay. `settling` comes off, because the
   *   whole cost of the reward is sitting still and a clock that survived getting up would let you
   *   collect it by resting for three seconds a dozen times.
   * - **Already settling, or already rewarded** — leave it alone. Otherwise `rest` → `sleep` would
   *   restart the clock and a player alternating the two would never finish it, which is a mechanic
   *   that punishes exactly the person paying attention to it.
   * - **Newly resting** — start the clock.
   *
   * `second_wind` is deliberately *not* removed on standing up. It is the one part of this that is
   * meant to be spent elsewhere: a bonus that only applied while resting would be adding regeneration
   * to the state that already has the most of it.
   */
  private refreshRest(actor: Actor): void {
    if (!isResting(actor.status)) {
      this.removeAffects(actor, 'settling');
      return;
    }
    if (hasType(actor.affects, 'settling') || hasType(actor.affects, 'second_wind')) return;
    this.addAffect(actor, settlingAffect());
  }

  /* ------------------------------------------------------------------------ */
  /* Posture and status                                                        */
  /* ------------------------------------------------------------------------ */

  /**
   * Moves a character on either axis, or both. Answers whether anything actually changed.
   *
   * The one writer, so that no path can change a stance without the caller knowing it has to tell the
   * client. Both axes are on the wire and the client gates its own movement prediction on them: a
   * server that quietly sat a character down would produce a sprite the player can still steer and
   * the server refuses to move, corrected every frame.
   */
  setStance(actor: Actor, next: { posture?: Posture; status?: Status }): boolean {
    const posture = next.posture ?? actor.posture;
    const status = next.status ?? actor.status;
    if (posture === actor.posture && status === actor.status) return false;

    actor.posture = posture;
    actor.status = status;
    // Anything that is no longer standing is no longer walking anywhere. Leaving a route attached to
    // a character who has just sat down would have the tick walk them along it from a sitting
    // position — the movement gate below stops the motion, but the route would sit there stalling
    // until `STUCK_TICKS` gave up on it and told the actor "something blocks the way", which is a
    // lie about what happened.
    // ...and only a player has a route to clear. A mob that cannot move has nothing queued, because
    // nothing queues movement for one yet; when pursuit does (Phase 10) it will be a mob's own field and
    // this branch will still be about clients.
    if (!this.canMove(actor) && isPlayer(actor)) {
      actor.path = undefined;
      actor.intentX = 0;
      actor.intentY = 0;
    }
    // Rest is something you settle into, and the clock for it hangs off this one writer rather than
    // off each of the five commands that can change a status.
    this.refreshRest(actor);
    return true;
  }

  /**
   * Brings `status` into line with hit points. Answers whether it changed.
   *
   * Separate from {@link setStance} because it is a *derivation* rather than a decision — and because
   * it must be called from wherever hp changes rather than polled, since {@link statusFor} reads the
   * current status as well as the number and so is not idempotent against a stale value.
   *
   * No caller yet: nothing damages a character until combat exists. It is here because it is the
   * other half of the axis, and a `status` field with no derivation is the sort of half-built
   * mechanism this project already has too many of — this one at least has a test.
   */
  refreshStatus(actor: Actor, fighting = false): boolean {
    return this.setStance(actor, { status: statusFor(actor.hp, actor.status, fighting) });
  }

  /**
   * Whether this character can move under their own power.
   *
   * **A deliberate divergence from the MUD.** Duris' command table gives movement
   * `STAT_NORMAL + POS_PRONE` — full consciousness, but *any* posture — so a seated character there
   * can shuffle from room to room. That is defensible when a room is a point and movement is a
   * teleport between points. Ours is not: we have continuous steering, and a character sliding across
   * the floor at walking pace while sitting down is not a MUD mechanic, it is a rendering fault.
   *
   * So both movement paths — steering and the single-room step — require standing here, and the
   * refusal says so. It is the one place in this file where the source was read and then not followed.
   */
  canMove(actor: Actor): boolean {
    return actor.posture === 'standing' && actor.status === 'normal';
  }

  remove(id: EntityId): void {
    this.actors.delete(id);
  }

  /**
   * Records a steering intent. Normalised here so a hostile client cannot request extra speed.
   *
   * Returns whether this is a real push rather than a key release, which is what lets the caller
   * decide that manual control has been taken back from an active path. Note it answers *after*
   * normalisation, so a sub-threshold nudge counts as a release and cannot cancel a route.
   */
  setIntent(id: EntityId, dx: number, dy: number): boolean {
    // A mob has no steering intent to set, and an id off the wire could name one.
    const player = this.player(id);
    if (!player) return false;
    const intent = normaliseIntent(dx, dy);
    player.intentX = intent.x;
    player.intentY = intent.y;
    return intent.x !== 0 || intent.y !== 0;
  }

  /* ------------------------------------------------------------------------ */
  /* Visibility                                                                */
  /* ------------------------------------------------------------------------ */

  /**
   * Adds the room's own light to a lit set, when the room has any.
   *
   * Reads the room out of the zone rather than the tile under the character's feet, for the reason
   * `refreshRoomLight` gives: `roomAtTile` reports −1 in a corridor and `roomId` holds the last real
   * room, which is the room a character in a doorway is standing in as far as every other rule is
   * concerned.
   *
   * Returns the original set untouched when the room is dark, so the common case — a dark dungeon, which
   * is what the whole visibility model was built for — allocates nothing.
   */
  private withNaturalLight(player: Player, lit: Set<number>): Set<number> {
    const located = this.world.locate(player.roomId);
    if (!located || !roomLightsItself(located.room)) return lit;
    const grid = this.world.grid(player.place);
    const zone = this.world.zone(player.place.zone);
    if (!grid || !zone) return lit;
    for (const tile of naturalLightTiles(grid, zone, player.roomId)) lit.add(tile);
    return lit;
  }

  /**
   * Recomputes a player's lit tiles when — and only when — they can have changed.
   *
   * Returns `true` when it actually recomputed, which is the caller's signal that there may be new
   * tiles to fold into `seen` and ship. A player standing still, or drifting within one tile, gets
   * `false` and costs nothing: at 10 Hz most ticks of most walks land in the tile they started in,
   * and shadowcasting all of them again would be pure waste.
   *
   * Called on arrival too, because {@link relocate} invalidates the cache — the same tile numbers on
   * a different Place's grid are a different place entirely.
   */
  refreshVisible(player: Player): boolean {
    // A `rooms`-mode source is a different *kind* of seeing, not a bigger number, so it takes a
    // different derivation and a different cache key. Everything downstream — `seen`, the click
    // gate, who is lit — reads `player.visible` and neither knows nor cares which branch filled it.
    const source = player.light;
    if (source && isRoomMode(source)) return this.refreshRoomLight(player, source);

    const tx = Math.floor(player.x / TILE_SIZE);
    const ty = Math.floor(player.y / TILE_SIZE);
    if (tx === player.visibleTx && ty === player.visibleTy && player.lightRadius === player.visibleRadius) {
      return false;
    }
    const grid = this.world.grid(player.place);
    if (!grid) return false;

    // **A room that lights itself lights it for everyone in it** — the owner's ask, 2026-08-06, and a
    // union rather than a branch: your own light still reaches past the room's floor (through a doorway,
    // down a corridor), so the two are additive and neither can take anything away. In a lit room the
    // disc adds nothing and the union is the room; in a dark one the room adds nothing and it is the
    // disc; in a lit room with a torch you see the room *and* what the torch reaches beyond it.
    player.visible = this.withNaturalLight(player, computeVisible(grid, tx, ty, player.lightRadius));
    player.visibleTx = tx;
    player.visibleTy = ty;
    player.visibleRadius = player.lightRadius;
    // Retiring the other key, so that picking a beacon back up recomputes rather than reading the
    // room set this character had two sources ago.
    player.visibleRoom = NEVER;
    return true;
  }

  /**
   * The lit set for a `rooms`-mode source: whole rooms out to `source.radius` exits, through walls.
   *
   * Keyed on the **room**, not the tile. A beacon lights the same set from every tile of the room it
   * is carried in, so the tile key would rebuild the room-graph walk nine times per room for an
   * identical answer — and unlike the shadowcast this walk indexes every room in the zone to start.
   * At the shipped beacon's radius of 1 the result is the character's own room and its immediate
   * neighbours, recomputed once per room entered.
   *
   * `player.roomId` rather than the room under the character's feet: `roomAtTile` reports -1 in a
   * corridor, and `roomId` holds the last real room, which is precisely the room a character in a
   * corridor is being lit *from*. The corridor itself is still lit, because `roomLightTiles` adds
   * the gap between any two rooms that are both in range.
   *
   * The set is taken verbatim from the shared derivation with nothing added — not even the tile
   * underfoot, which `computeVisible` does add. The client re-derives this every frame from the same
   * function, and a server that quietly seasons the result is a one-tile disagreement between the
   * ground the client draws lit and the ground the server will let you click on.
   */
  private refreshRoomLight(player: Player, source: LightSource): boolean {
    if (player.visibleRoom === player.roomId && player.visibleRadius === player.lightRadius) {
      return false;
    }
    const grid = this.world.grid(player.place);
    const zone = this.world.zone(player.place.zone);
    if (!grid || !zone) return false;

    // Unioned here too. A beacon already lights this room, so in practice this changes nothing — but
    // leaving it out would make natural light a property of *which light you carry*, which is exactly
    // the kind of rule that is discovered later by somebody standing in a lit room holding a beacon.
    player.visible = this.withNaturalLight(player, roomLightTiles(grid, zone, player.roomId, source.radius));
    player.visibleRoom = player.roomId;
    player.visibleRadius = player.lightRadius;
    // See above: exactly one key is live, so the tile key is retired while this one is.
    player.visibleTx = NEVER;
    player.visibleTy = NEVER;
    return true;
  }

  /**
   * Forces everyone standing on `place` to recompute what they can see, and says who that was.
   *
   * For when the *map* changed rather than the character: a door swinging open turns an opaque tile
   * transparent, and every cache key {@link refreshVisible} holds — the tile underfoot, the radius,
   * the room — is still exactly what it was. Nobody has moved, so nothing else in the tick loop would
   * ever ask again, and the room beyond an opened door would stay dark until its bearer happened to
   * cross a tile boundary.
   *
   * `visible` itself is left alone rather than emptied. The indices still address the same grid, so
   * they stay true until the recompute replaces them; blanking them would put every observer in the
   * dark for the gap between this call and the next refresh.
   */
  invalidateVisible(place: Place): Player[] {
    const affected: Player[] = [];
    // Players only: the lit set is a client's fog of war, and a mob has none to invalidate.
    for (const player of this.allPlayers()) {
      if (!samePlace(player.place, place)) continue;
      player.visibleTx = NEVER;
      player.visibleTy = NEVER;
      player.visibleRadius = NEVER;
      player.visibleRoom = NEVER;
      affected.push(player);
    }
    return affected;
  }

  /**
   * Changes how far a character can see — a torch lit, a spell cast, a Beacon of Hope crumbling.
   *
   * Returns whether it changed anything, so an immediate caller knows whether to re-send `self`. The
   * new radius takes effect on the next {@link refreshVisible}, which will recompute because the
   * radius is part of its cache key: there is no separate invalidation to forget.
   *
   * The player is also queued into the next tick's {@link TickResult.relit}. That is not a
   * convenience — the tick loop's fold-into-`seen` pass only visits players who *moved*, so without
   * it a character who lights a torch while standing still keeps the old lit disc, grows no `seen`,
   * and is refused by `moveTo` on ground their client is already drawing lit.
   */
  setLightRadius(actor: Actor, radius: number): boolean {
    const clamped = Math.max(0, Math.floor(radius));
    if (clamped === actor.lightRadius) return false;
    actor.lightRadius = clamped;
    this.relit.add(actor.id);
    return true;
  }

  /**
   * Puts a light source in a character's hand, or takes the last one away.
   *
   * **Now an affect install.** It used to write three fields on the character; it now replaces the
   * `light` affect and lets {@link recompute} derive the source and the radius from the list. The
   * observable behaviour is unchanged and that is the point of the exercise — the migration deletes a
   * bespoke timer instead of adding a parallel one, which is the only way to find out whether the
   * primitive was general enough to be worth building. `effectiveRadius` still turns a catalogue entry
   * into the tile number every consumer reads, so the rule that a `rooms` source reports a usable
   * radius stays in the catalogue.
   *
   * `replace` rather than `join`: lighting a second torch is not two torches' worth of burn. This is
   * the "refresh in place" idiom from `REFERENCE-mud-mechanics.md` §3.5 and it is the caller's choice,
   * as stacking always is.
   *
   * The burn timer is *reset* by default, not carried over: a fresh torch is a fresh torch, and
   * there is no inventory in which a half-burnt one could be waiting. Whether the new source is
   * actually an upgrade is the caller's decision — `bestLight` in the catalogue answers it — because
   * "you found a candle while holding a lantern" is a different sentence from "your torch went out",
   * and only the caller knows which one it is looking at.
   *
   * `remainingMs` exists for the one caller that is not lighting anything: restoring a character who
   * logged out mid-burn. It is clamped into the source's own range, so a hand-edited save cannot
   * hand out a torch that burns for a week, and a source that never expires ignores it outright —
   * "no remaining time" means unlimited here, never zero.
   *
   * The player is always queued into {@link TickResult.relit}, by `recompute`, even when the radius is
   * unchanged: the `SelfView.light` payload has changed by definition and the client is counting
   * `remainingMs` down against it.
   */
  setCarriedLight(actor: Actor, source: LightSource | undefined, remainingMs?: number): void {
    removeType(actor.affects, 'light');
    if (source) {
      // `NoShow`, because the carried light has had its own HUD line and its own log prose since
      // Phase 1. Not `NoSave`: a torch that vanished on every reconnect is the bug `restoreLight`
      // exists to fix, and `node --watch` made that the normal case rather than an edge one.
      actor.affects.push(
        newAffect({
          type: 'light',
          durationMs:
            source.durationMs === undefined
              ? UNLIMITED_DURATION
              : Math.max(0, Math.min(source.durationMs, remainingMs ?? source.durationMs)),
          apply: 'light',
          flags: AffectFlag.NoShow,
          context: source.id,
        }),
      );
    }
    this.recompute(actor);
  }

  /**
   * Takes the queue of players whose light changed and empties it.
   *
   * `tick` drains this into {@link TickResult.relit}, but light can also change *between* ticks — a
   * character walking onto a torch is handled after the tick has already returned — and those
   * players would otherwise wait a further 100 ms for a `self` that is already true. Public so the
   * one caller that changes light outside the tick can collect its own consequences instead of
   * duplicating what the relit path does with them.
   *
   * Ids in, players out: a character who disconnected between the change and the drain is dropped by
   * the lookup rather than handed back as a live object that has left the world.
   */
  drainRelit(): Player[] {
    const out: Player[] = [];
    for (const id of this.relit) {
      const player = this.player(id);
      if (player) out.push(player);
    }
    this.relit.clear();
    return out;
  }

  /**
   * Runs every affect on every character down by one tick, and reports what that did.
   *
   * **The one expiry pass**, and it replaced the hand-wound light burn rather than running beside it.
   * Duris does the same walk once per 75-second tick (`affect_update`); ours is on the 100 ms tick,
   * which is the clock this project says drives timers.
   *
   * Runs at the top of {@link tick} so that anything it installs lands in *this* tick's `relit` rather
   * than the next one: the log line saying the torch died and the `self` carrying the smaller radius
   * then reach the client together.
   *
   * ## Events are per cause, not per record
   *
   * A cause installs one node per stat it touches — `second_wind` is three — and it ends *once*. So
   * expired nodes are grouped by type and a type is only reported when its **last** node has gone;
   * a longer-lived sibling still on the list means the cause is still running. Without that, standing
   * up from a rest would print "your second wind fades" three times and re-arm the rest clock three
   * times. It is `REFERENCE-mud-mechanics.md` §4.12 for the third time, and it is the rule this record
   * shape most rewards getting right once.
   */
  private expireAffects(): AffectEvent[] {
    const events: AffectEvent[] = [];

    for (const player of this.actors.values()) {
      if (player.affects.length === 0) continue;
      const { expired, expiring } = advanceAffects(player.affects, TICK_MS);

      for (const affect of expiring) {
        if (events.some((e) => e.kind === 'expiring' && e.actor === player && e.affect.type === affect.type)) {
          continue;
        }
        events.push({ actor: player, kind: 'expiring', affect, chained: [] });
      }

      const ended = new Set<AffectType>();
      for (const affect of expired) {
        // A sibling node of the same cause outlived this one, so the cause has not ended.
        if (hasType(player.affects, affect.type)) continue;
        if (ended.has(affect.type)) continue;
        ended.add(affect.type);
        events.push({ actor: player, kind: 'expired', affect, chained: this.chainFrom(player, affect) });
      }
    }

    return events;
  }

  /**
   * What one expiry leaves behind — the two chains we have, in the one place they live.
   *
   * Duris does this with a long per-type `switch` inside `affect_update`, and the shape is right even
   * though the implementation there is a wall: *what an affect turns into* is knowledge about the
   * mechanic, not about timing, so it cannot live in the generic pass and it should not be scattered
   * across the mechanics either — a chain installed from somewhere the expiry pass cannot see is a
   * chain that fires in the wrong tick.
   *
   * Both chains are returned rather than merely installed, because the announcement needs them: "your
   * Beacon crumbles away, leaving a torch" and "you catch your second wind" are both sentences about
   * the *successor*, and index.ts has no other way to learn what it was.
   */
  private chainFrom(actor: Actor, expired: Affect): readonly Affect[] {
    switch (expired.type) {
      case 'light': {
        // Resolved through the catalogue, so a source naming an id that no longer exists leaves
        // nothing behind rather than putting an undefined in the character's hand.
        const source = expired.context === undefined ? undefined : lightSource(expired.context);
        const replacement = source ? expiresTo(source) : undefined;
        this.setCarriedLight(actor, replacement);
        return this.affectsOf(actor, 'light');
      }

      // The rest cycle: half a minute of sitting still buys a minute of extra regeneration, and if you
      // are still sitting when it lapses the wait starts again. Guarded on the status rather than
      // assumed from the fact that the timer ran — `refreshRest` takes `settling` off the moment rest
      // is broken, so reaching here already implies it, and stating the invariant is cheaper than
      // trusting two functions to keep agreeing about it.
      case 'settling':
        if (!isResting(actor.status)) return [];
        this.addAffect(actor, secondWindAffects());
        return this.affectsOf(actor, 'second_wind');

      case 'second_wind':
        if (!isResting(actor.status)) return [];
        this.addAffect(actor, settlingAffect());
        return this.affectsOf(actor, 'settling');

      // Phase 19's two skill-notch cooldowns chain to nothing — they are pure timers whose lapsing *is*
      // their meaning. Listed rather than left to a `default`, and the value of that showed immediately:
      // adding them to `AFFECT_TYPE_IDS` made this function a type error until they were handled, which
      // is exactly the guard a wall of cases is for.
      case 'notch_physical':
      case 'notch_mental':
      // And Phase 19 slice 3's ability lag, for the same reason: it is a timer whose lapsing is the whole
      // of its meaning. The exhaustive switch caught this one too, which is the third time it has paid for
      // itself.
      case 'off_balance':
      // Slice 6: the sun pass installs and removes this explicitly; expiry is not its path — the
      // duration is unlimited — but the wall of cases wants every member named, and rightly.
      case 'sun_scorched':
        return [];

      // Phase 20's wind-up chains to nothing — the `cast` event owns both of its endings and removes
      // this affect explicitly, so expiring *here* means a beat went missing, and the lingering row on
      // screen is deliberately the tell. Fourth time the wall of cases has paid for itself.
      case 'casting':
        return [];

      // Slice 5's buffs chain to nothing — but their lapsing changes numbers `refitCombat` folds, so
      // index.ts refits on their expiry (it sees the event; the timing pass here cannot know about
      // combat profiles). Fifth time the wall of cases has paid for itself.
      case 'armor':
      case 'bless':
        return [];

      // The potion cooldown is a pure timer whose lapsing is its meaning — the catalogue's wearOff
      // line says so out loud. Sixth payment from the wall of cases.
      case 'potion_sated':
        return [];

      // Ranged slice 5's provocation chains to nothing *here* — what its expiry causes is a walk, not
      // an affect, and walks belong to the hunt pass. index.ts sees the expiry event and starts the mob
      // home; this pass only lets the anger lapse. Seventh payment from the wall of cases.
      case 'provoked':
        return [];

      // A meal ending chains to nothing: the regeneration nodes lapse with it, and the vitals fold
      // simply stops seeing them — second wind's own shape. Seventh payment.
      case 'eaten':
        return [];
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Click-to-move                                                             */
  /* ------------------------------------------------------------------------ */

  /** Whether this player is currently being walked along a route. */
  hasPath(player: Player): boolean {
    return player.path !== undefined;
  }

  /**
   * Puts a player on a route: tile coordinates on their current Place's grid, nearest first, exactly
   * as `findPath` returned them. An empty route is the same as clearing.
   *
   * Any held steering is dropped. The path supersedes it, and leaving it set would have the player
   * carry on walking in the old direction the instant the route finished — with nothing on screen to
   * explain why, since the drawn route would already be gone.
   */
  setPath(player: Player, points: readonly TilePoint[]): void {
    // Copied rather than aliased: waypoints are consumed as they are reached, and the same array is
    // sent to the client for drawing.
    const waypoints = points.map((p) => ({ tx: p.tx, ty: p.ty }));
    const goal = waypoints[waypoints.length - 1];
    if (!goal) {
      this.clearPath(player);
      return;
    }
    player.path = { points: waypoints, goal, stalled: 0 };
    player.intentX = 0;
    player.intentY = 0;
  }

  /** Abandons any active route. Returns true if there was one to abandon. */
  clearPath(player: Player): boolean {
    if (!player.path) return false;
    player.path = undefined;
    return true;
  }

  /* ------------------------------------------------------------------------ */
  /* Regeneration                                                              */
  /* ------------------------------------------------------------------------ */

  /**
   * Moves every pool one tick's worth, and reports whose numbers changed.
   *
   * In the tick loop rather than on a scheduler, and that is a considered choice. Duris drives this
   * with a self-rescheduling event per character per pool, because it has no per-tick pass to hang it
   * on. We do. A scheduler earns its keep on *sparse, future-dated* work — a spell landing in three
   * seconds, a per-actor combat clock, an item decaying in an hour — and regeneration is the opposite
   * of sparse: every character, every tick. Putting it behind a queue would be an abstraction with one
   * consumer that did not want it.
   *
   * The rate is recomputed every tick rather than cached, so sitting down speeds healing on the very
   * next tick instead of whenever something happened to invalidate it. It is three multiplications.
   */
  private regenerate(): Actor[] {
    const changed: Actor[] = [];

    // Every body, not every player. Mobs heal for the same reasons and by the same table — Diku's do —
    // and routing them through a second loop is how the two would come to disagree about how fast a
    // wound closes. Since Phase 13 they are damaged in earnest, so this is the pass that closes a
    // kobold's wounds between fights — and the pass that must *not* close them while it runs from one.
    for (const player of this.actors.values()) {
      // The wind comes back on the same clock affects expire on, and deliberately outside the
      // `regenerates` gate below: this is a timer, not healing, and a timer that only ran for bodies
      // worth healing would freeze whenever that gate's definition moved. (Today it excludes only the
      // dead, whose wind is moot — the placement is cheap insurance, not a live bug being dodged.)
      if (player.windedMs > 0) player.windedMs = Math.max(0, player.windedMs - TICK_MS);
      if (!regenerates(player)) continue;
      let moved = false;

      // **Treading deep water gives no wind back** — the commented-out source's own rule, and the
      // drive proved the mechanic is dead without it: `swimming_char` calls `StartRegen` only when
      // you *leave* the waters, and without that suppression a drowning swimmer's pool ticked back
      // above zero between beats and the water let go for ever. Movement only; health and mana mend
      // as they always did — it is your arms that are busy.
      const room = this.room(player.roomId);
      const treading =
        room !== undefined &&
        SECTOR_REQUIRES_MOVEMENT[room.sector] === 'swim' &&
        isPlayer(player) &&
        !this.hasSwimAid(player);

      for (const pool of REGEN_POOLS) {
        if (pool.name === 'move' && treading) continue;
        const current = player[pool.current];
        const max = player[pool.max];
        // The affect total for this pool's location, summed fresh each tick for the same reason the
        // rate is: it is one walk of a list with at most a handful of entries, and caching it would
        // mean an invalidation to forget every time something landed or lapsed.
        // `fighting` and `winded` are the two suppressors, and the first is a wiring fix as much as a
        // rule: `regenPerMinute` had authored "fighting means zero" from the start, and this call site
        // never passed it — every combatant quietly trickled 13 hp a minute through their own fights.
        const rate = regenPerMinute(pool.name, player, {
          fighting: player.fighting !== undefined,
          winded: player.windedMs > 0,
          bonus: sumApply(player.affects, REGEN_APPLY[pool.name]),
          // Phase 23: the inn's heal-room clause — the room is already in hand from the treading
          // check, and the level rides along because a heal room pays by it.
          healRoom: room?.flags?.includes('inn') ?? false,
          level: player.level,
        });
        // Nothing to do: full and healing, or a rate of zero. Skipping keeps the carry untouched so a
        // character who sits still at full health does not bank a point to spend the instant they are
        // scratched.
        if (!needsRegen(current, max, rate)) continue;

        const { points, carry } = accrue(player.regenCarry[pool.name], rate);
        player.regenCarry[pool.name] = carry;
        if (points === 0) continue;

        const next = clampPool(current + points, max, pool.floor);
        if (next === current) continue;
        player[pool.current] = next;
        moved = true;
      }

      // Hit points decide consciousness, so the status follows them in the same tick rather than a
      // tick later — otherwise a bleed could carry a character past the death threshold while they
      // were still described as merely dying.
      if (moved && this.refreshStatus(player)) moved = true;
      if (moved) changed.push(player);
    }

    return changed;
  }

  /**
   * Charges a character for entering a room, or refuses.
   *
   * The caller for `SECTOR_MOVE_COST`, which has been written, tested and **called by nothing** since
   * the beginning. Answers `false` when the pool cannot cover the step, which is Duris' rule: running
   * out of movement does not disable walking, it makes each step something you have to have the
   * stamina for.
   */
  spendMove(actor: Actor, from: Sector, to: Sector): boolean {
    // The operator's event switch: with costs off, every step is affordable and nothing is charged.
    // Injected like the swim aid — whether costs are in force is a world rule, and this class holds
    // no settings for the same reason it holds no catalogue.
    if (!this.chargesMove()) return true;
    let cost = encumberedMoveCost(from, to, this.loadOf(actor));
    // **Phase 19 slice 5: deep water is priced, not gated** — the owner's ruling. A player without a
    // swim aid pays the dead drain's own surcharge on top of the terrain rate, falling with the swim
    // skill; a boat (the aid, injected — this class knows no catalogue, A7d's rule) means you are not
    // swimming and pay the plain rate. Mobs never pay the surcharge for the reason they never pay
    // encumbrance: their movement is governed by their own clocks, not by a pool they can empty.
    if (SECTOR_REQUIRES_MOVEMENT[to] === 'swim' && isPlayer(actor) && !this.hasSwimAid(actor)) {
      cost += swimSurcharge(
        learnedAt(
          actor.skills.get('swim'),
          actor.level,
          'swim',
          isPlayer(actor) ? actor.identity?.class : undefined,
        ),
      );
    }
    if (!canAffordStep(actor.move, cost)) return false;
    actor.move -= cost;
    return true;
  }

  /**
   * Whether something the actor has makes deep water free — a boat, in the source's own live rule
   * (`ITEM_BOAT`, carried at the top level or worn; a canoe inside a sack floats nobody).
   *
   * Injected by `index.ts` at boot rather than derived here, because *what is a boat* is a catalogue
   * question and this class deliberately holds no catalogue. Everything that bundles with swimming —
   * the surcharge, the notch, the drowning — asks this one predicate, so "a boat means you are not
   * swimming" cannot come apart across three call sites.
   */
  hasSwimAid(actor: Actor): boolean {
    return this.swimAid(actor);
  }

  private swimAid: (actor: Actor) => boolean = () => false;

  setSwimAid(check: (actor: Actor) => boolean): void {
    this.swimAid = check;
  }

  /** Whether movement is being charged at all — the event switch, injected. Defaults on: free is the exception. */
  private chargesMove: () => boolean = () => true;

  setMoveCosts(check: () => boolean): void {
    this.chargesMove = check;
  }

  /**
   * How full a character is, as a fraction of their bag — worn gear included.
   *
   * The denominator is the **bag's** capacity while the numerator counts the body too, which looks
   * lopsided and is the point: capacity answers *what will fit*, and `DESIGN-inventory.md` §6 puts
   * worn gear outside it, while load answers *what you are hauling* and a breastplate is squarely
   * inside that. Using bag-used alone would mean a character in full plate with an empty pack was
   * unencumbered, and Phase 16's completion test is exactly the opposite.
   *
   * **Mobs are never encumbered.** Their kit is loot, harvested from `E` commands and never chosen,
   * so charging a guard for the sword it was authored holding would slow every equipped mob in
   * IceCrag for a reason nobody decided — the same argument `reset.ts` makes about mob armour.
   */
  loadOf(actor: Actor): number {
    if (!isPlayer(actor)) return 0;
    const capacity = actor.inventory.capacity;
    if (capacity <= 0) return 0;
    return (slotsUsed(actor.inventory) + wornBulk(actor.equipped)) / capacity;
  }

  tick(): TickResult {
    // Before movement, so a light that dies this tick has already shrunk the radius that the
    // fold-into-`seen` pass below will use. The other order would grow `seen` by a tick's worth of
    // ground a character was no longer able to see.
    const affectEvents = this.expireAffects();

    const step = STEP_PER_TICK;
    const moved: Player[] = [];
    const transitions: Transition[] = [];
    const pathsEnded: PathEnded[] = [];
    // Players a continuous step just refused for lack of movement — edge-triggered, see the gate.
    const winded: Player[] = [];
    /** Walkers pressed against a seam, asking to be carried across. See `seamUnderfoot`. */
    const seamCrossings: { player: Player; dir: Direction }[] = [];

    // Players only, and this is the one pass where that is the *mechanic* rather than a limitation:
    // movement here is driven by a held steering vector or a server-walked route, and both are things a
    // client asked for. A mob moves when Phase 10 makes it hunt, and that will be its own pass over the
    // room graph rather than another reader of `intentX`.
    for (const player of this.allPlayers()) {
      if (!player.path && player.intentX === 0 && player.intentY === 0) continue;
      // Sitting, kneeling, prone, asleep or worse: nothing moves. Checked here rather than only at
      // the command dispatcher because steering arrives as a held vector and would otherwise keep
      // walking a character who sat down mid-stride.
      if (!this.canMove(player)) continue;

      // Collision is resolved against the grid for this player's own Place. Zones — and levels of
      // one zone — have separate coordinate spaces, so a single world-wide grid does not exist and
      // walking two players on the same one would put them through each other's walls.
      const grid = this.world.grid(player.place);
      if (!grid) continue;

      // A route is the authoritative intent for as long as it lasts: it *replaces* the client's
      // steer vector rather than blending with it, so click-to-move and the keyboard can never fight
      // over the same character. Taking manual control back is done by dropping the route (see
      // `clearPath`), not by out-pushing it.
      let intentX = player.intentX;
      let intentY = player.intentY;
      let distance = step;

      const path = player.path;
      if (path) {
        // Consume every waypoint already stood on. A loop rather than an `if`: smoothing can leave
        // two waypoints within one radius of each other.
        while (path.points.length > 0 && reached(player, path.points[0]!)) path.points.shift();

        const waypoint = path.points[0];
        if (!waypoint) {
          player.path = undefined;
          pathsEnded.push({ player, reason: 'arrived', goal: path.goal });
          continue;
        }

        const dx = tileCentre(waypoint.tx) - player.x;
        const dy = tileCentre(waypoint.ty) - player.y;
        const heading = normaliseIntent(dx, dy);
        intentX = heading.x;
        intentY = heading.y;
        // Never step past the waypoint — the same movement routine, just a shorter distance for one
        // tick. Overshooting is what makes a follower orbit its target; clamping deletes the failure
        // mode instead of hiding it behind a radius tuned large enough to swallow it.
        distance = Math.min(step, Math.hypot(dx, dy));
      }

      if (intentX === 0 && intentY === 0) continue;

      const startX = player.x;
      const startY = player.y;

      // One movement routine for both kinds of movement. Click-to-move deliberately owns no code
      // here beyond choosing the direction: a second implementation would drift from the client's
      // predictor and desync every walk.
      //
      // **And one routine for walls and bodies both** — {@link stepActor}, since bodies became solid.
      // A route is planned over the tilemap and cannot see a mob standing on it, so the deflection in
      // `stepBody` is what keeps the stall counter below from ending an honest walk as `'stuck'`
      // merely because something was in the way.
      const next = this.stepActor(player, grid, intentX, intentY, distance);

      // **`DESIGN-engagement.md` §4: steering works inside the room, every exit is refused.**
      //
      // The gate has to be here as well as on the command table, and that is not a scattered check —
      // it is the *only* place that can see a step about to leave. Steering is pure geometry: a
      // doorway tile is walkable like any other, so nothing above this line knows the difference
      // between crossing a room and crossing a floor. Without it, WASD walked straight out of a fight
      // that `north` was refusing, which made the refusal a formality.
      //
      // The threshold counts as outside: a corridor tile reports -1, and stopping at it is what "you
      // cannot leave" should feel like from inside the room.
      const into = roomAtTile(grid, Math.floor(next.x / TILE_SIZE), Math.floor(next.y / TILE_SIZE));
      if (player.fighting !== undefined) {
        if (into !== player.roomId) continue;
      }

      // **The same bill the typed step pays — Phase 19 slice 5 closed the gap.** `stepRoom` has
      // charged `SECTOR_MOVE_COST` since Phase 16; a WASD or click crossing landed here, where
      // nothing charged — so the default way of walking was the free way, and "all terrain costs"
      // (owner, 2026-08-07) was a rule with a hole in it. This is the only place that can see a
      // continuous step about to cross, the same fact the fighting gate above states, so the pool is
      // asked before the step and the transition block below merely records what was already paid.
      //
      // Refused like the fighting gate refuses: the step clamps at the boundary. `shoreBlocked` is
      // the edge-trigger for the message — holding W against a shoreline you cannot afford should say
      // so once, not sixty times a second — and a *path* is left to the stall counter, which ends it
      // as stuck within the second: which is what it is.
      if (into !== -1 && into !== player.roomId) {
        const from = this.room(player.roomId);
        const to = this.room(into as RoomId);
        if (from && to && !this.spendMove(player, from.sector, to.sector)) {
          if (player.shoreBlocked !== into) {
            player.shoreBlocked = into;
            winded.push(player);
          }
          continue;
        }
        delete player.shoreBlocked;
      }

      player.x = next.x;
      player.y = next.y;

      // **A seam carries you through** — the owner's ruling that a road leaving a zone is a step and
      // not a teleport. Continuous movement cannot cross a boundary the geometry never carved: the
      // walker simply stops against the last tile of their own room and nothing happens, which is
      // what made every zone edge feel like a wall with a violet ring on it. Pressed against that
      // edge, heading that way, with a seam exit there — ask to be taken across. The *asking* is
      // the point: this file owns no announcements, no movement costs and no fight rules, so the
      // request goes up with the tick and `index.ts` runs the ordinary step, which pays all three.
      const seam = this.seamUnderfoot(player, grid, intentX, intentY);
      if (seam) seamCrossings.push({ player, dir: seam });

      if (path) {
        if (Math.hypot(player.x - startX, player.y - startY) < distance * PROGRESS_FRACTION) {
          if (++path.stalled >= STUCK_TICKS) {
            player.path = undefined;
            pathsEnded.push({ player, reason: 'stuck', goal: path.goal });
          }
        } else {
          path.stalled = 0;
        }
      }

      if (player.x === startX && player.y === startY) continue;

      // **Facing follows the walk only when nothing else has a claim on it.** In a fight it belongs to
      // the opponent — `station.ts` points every engaged body at what it is fighting, so a character
      // backing away from something northward keeps their eyes on it and walks backwards, which is what
      // face-to-face combat looks like from outside. Setting it here as well would have the two writers
      // fight over the same field once per tick, and the walk would win every time.
      if (player.fighting === undefined) player.facing = facingOf(intentX, intentY, player.facing);
      moved.push(player);

      const roomId = roomAtTile(
        grid,
        Math.floor(player.x / TILE_SIZE),
        Math.floor(player.y / TILE_SIZE),
      );
      // -1 means a corridor: keep the previous room until they arrive somewhere real.
      if (roomId !== -1 && roomId !== player.roomId) {
        transitions.push({ player, from: player.roomId, to: roomId, fromPlace: player.place });
        player.roomId = roomId;
      }
    }

    // After movement, so a step's cost is already spent when the tick reports the new numbers.
    const vitalsChanged = this.regenerate();

    // Drained rather than read: a light change is an edge, and reporting it twice would have the
    // server re-send `self` and re-fold `seen` every tick for the rest of the character's life.
    return { moved, transitions, pathsEnded, winded, seamCrossings, relit: this.drainRelit(), affectEvents, vitalsChanged };
  }

  /**
   * Puts a player in any room of the loaded world, wherever it is.
   *
   * This is the *only* movement primitive that crosses a Place, and it does not care whether the
   * destination is another zone or another level of this one — both are just "a room on a different
   * grid". Returns the Place they arrived in, or undefined if the room belongs to a zone this
   * server has not loaded.
   */
  relocate(actor: Actor, roomId: RoomId, heading?: Direction): Place | undefined {
    const target = this.world.locate(roomId);
    if (!target) return undefined;
    const grid = this.world.grid(target.place);
    const origin = grid?.roomOrigins.get(roomId);
    if (!grid || !origin) return undefined;

    // **You arrive at the wall you came through, not in the middle of the floor.** Owner's report
    // (2026-08-03): landing on the centre meant every body that changed room stacked on one tile, and
    // whoever was underneath could not be clicked. `heading` is the direction *travelled*, so walking
    // north puts you at the southern edge. Omitted — a teleport, a respawn, a portal — keeps the
    // centre, which is honest when nothing was walked through. The lateral spread is the actor's id
    // rather than a roll, so no `Rng` has to reach this and a restart still reproduces the world.
    //
    // The spread is a **preference** since bodies became solid, for two reasons it never covered. Two
    // ids that fold to the same lateral offset still collided, and the tile it picks is picked blind:
    // `arrivalTile` knows the room's width and nothing about the scenery stamped into it, so an arrival
    // could land in a prop exactly as a spawn could. {@link landing} keeps the answer when it is a
    // legal one and walks outward from it when it is not, so the arrival fiction survives and the
    // failures do not.
    const arrival = arrivalTile(origin, lateralHeading(heading), actor.id);
    const spot = this.landing(grid, target.place, roomId, origin, arrival, actor.id);
    actor.place = target.place;
    actor.roomId = roomId;
    // Centre of the tile, not its corner, so the collision box starts clear of walls.
    actor.x = spot.x;
    actor.y = spot.y;

    // **You face the way you walked.** Owner's report, 2026-08-13: *"the mobs have a tendency to run
    // backwards"* — and this is where most of that came from. Every other mover already turns itself:
    // the continuous walk in `tick` (see its `facingOf` call), `hunt.ts` at both of its steps, and
    // `station.ts`, which points a fighting body at what it is fighting. A **room-to-room step turned
    // nobody**, though the direction travelled was right here in scope and already spending itself on
    // `arrivalTile`. A wandering mob therefore carried its spawn facing — `'south'` — through every
    // room it ever walked into, which cost nothing visible while the renderer drew four flat sprite
    // rows and costs a great deal now that it drives a lit mesh running a forward gait.
    //
    // Guarded exactly as the walk is: `fighting` means the facing belongs to the opponent
    // (`station.ts`'s rule, and a body backing through a door still watches what it is backing away
    // from), and a headless relocate — a teleport, a respawn, a portal — has no direction to offer and
    // must leave the facing alone rather than inventing north.
    // `up` and `down` are refused for the reason `faceDirection` refuses them and `yawOf` answers 0
    // for them: a stairway has no compass heading, and a body that took one should keep the last one
    // it had rather than be turned to an invented north.
    if (heading !== undefined && heading !== 'up' && heading !== 'down' && actor.fighting === undefined) {
      actor.facing = heading;
    }

    // Everything above is true of any body. Everything below is a *client's* view of one, and a mob has
    // none — so the narrowing is here, at the one place that needs it, rather than in a second copy of
    // this method for the other kind.
    if (!isPlayer(actor)) return target.place;

    // Steering held from the old map would otherwise walk them straight back into a wall here.
    actor.intentX = 0;
    actor.intentY = 0;
    // A route is tile coordinates on one Place's grid and is meaningless the moment the player
    // stands on another — the same numbers name a different spot, or no spot at all. Dropping it
    // here rather than at each call site means no future way of crossing a Place can forget to.
    actor.path = undefined;
    // The lit set is tile indices on that same grid and is stale for exactly the same reason. It is
    // emptied rather than merely marked dirty so that nothing can read another Place's tiles in the
    // window before the next refresh — and the cache key is cleared so that landing on the same tile
    // numbers as the last Place still recomputes.
    actor.visible = NOTHING_VISIBLE;
    actor.visibleTx = NEVER;
    actor.visibleTy = NEVER;
    actor.visibleRadius = NEVER;
    // The room key too. A beacon's set is rooms on *this* grid, and the same room id cannot appear
    // on two grids — but a character carried back to a room they were last lit in would otherwise
    // match a key that was set against the Place they have just left.
    actor.visibleRoom = NEVER;
    return target.place;
  }

  /**
   * The seam a walker is pressed against, or nothing.
   *
   * Three things have to be true, and the order they are checked in is the cheapness order. The
   * walker must be **heading** somewhere — a body standing still is not asking to leave. The room
   * must have a **seam** that way, which is the rare case and settles it for almost everybody. And
   * the walker must be on the **last tile** of their own room block in that direction, so that
   * crossing happens where the ground runs out and not from the middle of a field.
   *
   * The dominant axis decides the direction: pressing north-east against a north seam should cross,
   * and picking the larger component is what `headingOf` already does for facing. Diagonal input
   * into a corner therefore resolves to whichever way the walker mostly meant.
   */
  private seamUnderfoot(player: Player, grid: TileGrid, intentX: number, intentY: number): Direction | undefined {
    if (intentX === 0 && intentY === 0) return undefined;
    const dir: Direction =
      Math.abs(intentX) >= Math.abs(intentY) ? (intentX > 0 ? 'east' : 'west') : intentY > 0 ? 'south' : 'north';
    const room = this.room(player.roomId);
    const exit = room?.exits[dir];
    if (!exit?.seam) return undefined;
    const origin = grid.roomOrigins.get(player.roomId);
    if (!origin) return undefined;
    const tx = Math.floor(player.x / TILE_SIZE) - origin.tx;
    const ty = Math.floor(player.y / TILE_SIZE) - origin.ty;
    const atEdge =
      dir === 'east' ? tx >= ROOM_TILES - 1
      : dir === 'west' ? tx <= 0
      : dir === 'south' ? ty >= ROOM_TILES - 1
      : ty <= 0;
    return atEdge ? dir : undefined;
  }

  /** Giver vnums for the view's `questGiver` bit — combat.ts keeps the twin that refuses harm. */
  private questGivers = new Set<number>();

  /** Whether a mob vnum offers work — the wander pass reads it, because a giver findable is a quest playable. */
  isQuestGiver(vnum: number): boolean {
    return this.questGivers.has(vnum);
  }

  setQuestGivers(vnums: Iterable<number>): void {
    this.questGivers = new Set(vnums);
  }

  /**
   * The **subset** of those the server will not let anyone harm, for the view's `untouchable` bit.
   *
   * A third copy of a fact `combat.ts` already holds, and it earns its keep the way `questGivers`
   * does: the view is built here and the refusal happens there, so this side needs to be able to
   * answer *"would that blow be refused"* without importing the combat module into the renderer's
   * data path. `seedQuestGivers` fills both from one pass over the same rows, which is what stops
   * them drifting — the badge, the armour and the menu all come out of a single read.
   */
  private protectedGivers = new Set<number>();

  setProtectedGivers(vnums: Iterable<number>): void {
    this.protectedGivers = new Set(vnums);
  }

  /**
   * Keeper vnums, for the view's `$` badge and *List wares* row — protocol 28. Set once at boot
   * from the shop map's own keys, and folded into the view's `untouchable` below because the owner's
   * rule is absolute: a merchant cannot be harmed, whatever quest rows say about them.
   */
  private keepers = new Set<number>();

  setKeepers(vnums: Iterable<number>): void {
    this.keepers = new Set(vnums);
  }

  /** Trainer vnums for the view's `%` badge — protocol 30. Not folded into `untouchable`: a guildmaster may be fought. */
  private trainers = new Set<number>();

  setTrainers(vnums: Iterable<number>): void {
    this.trainers = new Set(vnums);
  }

  /**
   * How one actor appears to somebody else — players and mobs through the same function.
   *
   * There is no branch on `kind` here beyond passing it along, and that is the whole return on the
   * Phase 7 split: a mob is drawn, named, health-barred and posture-described by the code that already
   * did it for players, so the two cannot come to disagree about what a body looks like.
   *
   * Exact hit points are still not on it. `healthFraction` is what a stranger may know about you.
   *
   * **M7a: the 3D fields ride here and nowhere else.** `model`, `gear` and `yaw` are derived from
   * facts already on this object — the sprite key, the worn kit and the compass facing — by pure
   * functions in `@mygame/shared`, so every path that already re-sent a view re-sends the new fields
   * for free. That is the point of putting them here rather than at the six senders: `afterKitChange`
   * has re-published a wearer's view since the owner's shield report of 2026-08-07, and a wear or a
   * remove therefore reaches the mesh without a line being added anywhere else.
   */
  viewOf(actor: Actor): EntityView {
    // Built once and spread, because `wearing` and `gear` are the same fact in two vocabularies and
    // computing them from two different reads of `actor.equipped` is how they would come to disagree.
    // **Mobs read the same field players do, since Phase 16.** The `isPlayer` gate that used to stand
    // here was written when a mob's `equipped` was always empty; it has not been since 15c, when
    // `reset.ts` began executing the zone tables' `E` commands. So the gear was on the body, counted
    // in its armour class and handed to its corpse — and simply never described to anybody. Measured
    // over the world's own reset tables: **644 of 2,016 spawned bodies wear at least one piece**, and
    // dropping the gate is the whole of what puts them on the wire.
    const wearing =
      Object.keys(actor.equipped).length > 0 ? wornIds(actor.equipped, this.artClassOf) : undefined;
    // M7b: what is in the hands. Read off the same `equipped` the line above walked, and read *here*
    // rather than inside `appearanceOf` because that function is pure and knows no `Item` — what it
    // takes is the three fields a mesh can be chosen from. `wearing.mainHand` is already on the wire
    // and is not enough: for 98% of the catalogue's weapons it is `obj:1234`. See `WEAPON_ART`.
    const holding = handsOf(actor.equipped, wearing);
    // **The hair slice, and the only place the two halves of the rule meet.** A player's hairstyle is a
    // stored decision and their seed is their *name* — it never changes, so the default they meet on
    // their first login is theirs for good and a reconnect is not a reroll. A mob has no such identity
    // (a hundred templates share the name "a kobold youth"), so its seed is the entity id, which is
    // what puts five different heads of hair in one den. `appearanceOf` only hashes what it is given.
    const player = isPlayer(actor);
    const look = appearanceOf({
      kind: actor.kind,
      sprite: actor.sprite,
      ...(wearing ? { wearing } : {}),
      ...(holding ? { holding } : {}),
      ...(player && actor.hair !== undefined ? { hair: actor.hair } : {}),
      hairSeed: player ? actor.name : `mob:${actor.id}`,
    });
    return {
      id: actor.id,
      kind: actor.kind,
      ...(isMob(actor) && this.questGivers.has(actor.vnum) ? { questGiver: true as const } : {}),
      ...(isMob(actor) && this.keepers.has(actor.vnum) ? { keeper: true as const } : {}),
      ...(isMob(actor) && this.trainers.has(actor.vnum) ? { trainer: true as const } : {}),
      ...(isMob(actor) && (this.protectedGivers.has(actor.vnum) || this.keepers.has(actor.vnum))
        ? { untouchable: true as const }
        : {}),
      name: actor.name,
      sprite: actor.sprite,
      x: actor.x,
      y: actor.y,
      facing: actor.facing,
      // Clamped at the bottom because hit points go **negative** — see the dying window in `position.ts`.
      // A bar cannot be less than empty, and a negative fraction would draw as one on the client.
      healthFraction: Math.max(0, actor.hp) / actor.maxHp,
      level: actor.level,
      posture: actor.posture,
      status: actor.status,
      // The outbound pointer, already on the wire since before there was anything to put in it — it drives
      // the client's combat indicator. `DESIGN-engagement.md` §2: the wire form *is* the outbound pointer,
      // so nothing about the protocol had to change when combat finally arrived.
      ...(actor.fighting === undefined ? {} : { fighting: actor.fighting }),
      // Protocol 22: the wind-up is visible on the body, not just in the caster's own affect list —
      // the observer's half of "begins casting...". The client holds the spellcast pose while set.
      ...(actor.casting === undefined ? {} : { casting: true as const }),
      // What they are wearing, so the body on screen is the one the character sheet describes — and,
      // for a mob, the one its corpse is about to hand over. `index.ts` puts worn *and* carried gear
      // into the corpse, so this field is the promise the loot keeps.
      ...(wearing ? { wearing } : {}),
      // M7a. `sprite` above is untouched and still says `human`; these say the same thing in the
      // renderer's vocabulary. `appearanceOf` answers `undefined` only for ground objects, which
      // never reach this function — every caller passes an `Actor` — so the guard is a type narrowing
      // rather than a case anybody expects to hit.
      ...(look ? { model: look.model } : {}),
      ...(look?.gear ? { gear: look.gear } : {}),
      // M7b, and it rides exactly the same resync path: `afterKitChange` -> `syncEntityState` ->
      // `viewOf` -> `entityUpdate`, so a `wield` reaches the hand without a line anywhere else.
      ...(look?.hands ? { hands: look.hands } : {}),
      // The hair slice. `hair` rides that same seam and nothing new was built for it: the command
      // calls `afterKitChange`, which is what already re-publishes a wearer's view to themselves and
      // to every watcher. `scale` is absent for the ~95% of bodies that draw at adult height.
      ...(look?.hair ? { hair: look.hair } : {}),
      ...(look?.scale === undefined ? {} : { scale: look.scale }),
      // Derived rather than stored: the simulation holds four headings, so a yaw field of its own
      // would be a second copy of `facing` to keep in step. `space.ts` owns the axis argument.
      yaw: yawOf(actor.facing),
    };
  }

  /**
   * Puts one instance of a template in a room.
   *
   * **Hit points are rolled, not fixed.** Duris rolls `dice(n, size) + bonus` per instance, so two guards
   * of the same vnum are not equally tough — and the roll goes through the seeded `Rng` the caller owns,
   * never `Math.random()`, so a restart reproduces the world it had. (`CLAUDE.md` rule 3: unseeded
   * randomness makes a desync unreproducible and a fight unauditable.)
   *
   * The tile is rolled too, from the same stream. Duris has no notion of where in a room something
   * stands — a room is a point there — so a position has to come from somewhere, and stacking every
   * inhabitant on the centre tile would put them exactly where an arriving player lands.
   *
   * **The roll is a preference, not the answer.** *"A room's floor is `ROOM_TILES` square and carved
   * walkable"* is what this comment used to claim, and it was wrong twice over: V8d stamps scenery into
   * the room block as solid `Prop` and `Blocker` cells, and nothing here looked at who was standing
   * there already. Both bills came due on 2026-08-13 — the owner photographed a kobold youth in room
   * 41260 with its head and shoulders out of the top of a grey scenery block, and asked in the same
   * session that bodies never load on top of each other. {@link landing} takes the rolled tile and
   * returns the nearest one a body can actually stand on, so the RNG stream is untouched and only a
   * bad roll moves.
   *
   * Answers nothing when the room is not on a rendered grid — a reset command for a zone this server does
   * not load. That is a configuration that has moved on, not a broken build, so the caller counts it.
   */
  spawnMob(template: MobTemplate, roomId: RoomId, rng: Rng): Mob | undefined {
    const located = this.world.locate(roomId);
    if (!located) return undefined;
    const place = placeOf(located.room);
    const grid = this.world.grid(place);
    const origin = grid?.roomOrigins.get(roomId);
    if (!grid || !origin) return undefined;

    // A template whose hp expression the harvest let through unparseable would otherwise be a mob with
    // NaN hit points, which reads as a health bar that never moves. One point is a body; zero is nothing.
    const dice = parseDice(template.hp);
    const maxHp = dice ? Math.max(1, rollDice(rng, dice)) : 1;
    const tx = origin.tx + Math.floor(rng() * ROOM_TILES);
    const ty = origin.ty + Math.floor(rng() * ROOM_TILES);
    const spot = this.landing(grid, place, roomId, origin, { tx, ty });

    const mob: Mob = {
      id: this.nextId++,
      kind: 'mob',
      vnum: template.vnum,
      aggro: template.aggro,
      pursuit: template.pursuit,
      wimpyAt: template.wimpyAt,
      name: template.name,
      sprite: template.sprite,
      // Centre of the tile, as `spawn` does, so the collision box starts clear of walls.
      x: spot.x,
      y: spot.y,
      facing: 'south',
      roomId,
      place,
      fighting: undefined,
      wasFighting: undefined,
      pursuing: undefined,
      combat: template.combat,
      roundMs: template.combat.roundMs,
      // Bare. Its kit arrives from the zone file's `E` and `G` commands *after* this returns — they
      // attach to the last mobile loaded, so the body must exist first. See `reset.ts`.
      equipped: {},
      carrying: [],
      lightRadius: DEFAULT_LIGHT_RADIUS,
      affects: [],
      light: undefined,
      hp: maxHp,
      maxHp,
      mana: 0,
      maxMana: 0,
      // No movement pool: nothing moves a mob yet, and a full bar it never spends would be a number
      // implying a mechanic. Phase 10's pursuit is what gives mobs somewhere to spend one.
      move: 0,
      maxMove: 0,
      // (A player's pool is MAX_MOVE_POOL, set in `spawn` — see `vitals.ts` for why it is static.)
      level: template.level,
      // On its feet and awake. Nothing can knock it over yet — `update_pos`'s forced collapse waits for
      // hit points to move, which waits for combat.
      posture: 'standing',
      status: 'normal',
      regenCarry: { hp: 0, mana: 0, move: 0 },
      windedMs: 0,
    };
    this.actors.set(mob.id, mob);
    return mob;
  }

  /**
   * Puts one door back to the state its zone file authored, and says whether anything moved.
   *
   * Reset restores doors even though it never despawns a mob, and the asymmetry is not an inconsistency:
   * a door has **one** authored state and no instance limit, so "top up to the limit" and "restore" are
   * the same operation for it. A mob you dragged away is gone; a door you opened is just open.
   *
   * `locked` implies `closed` — you cannot lock a door standing open — and that is enforced here rather
   * than trusted from the file, because a `.zon` row saying locked-and-open is a builder's slip and the
   * grid would take it literally as walkable.
   *
   * The `locked` half is then dropped while {@link LOCKS_HOLD} is off, and this is the call site that
   * makes that policy hold *over time* rather than only at load: relaxing the world once is undone by
   * the first repop that runs a `D ... 2` row. IceCrag's very first reset command locks the castle's
   * front door, so without this line the castle re-seals itself 75 seconds after boot.
   */
  resetDoor(command: ResetCommand): boolean {
    // A `D` row carries all three or it is not a door row. `room` became optional in 15c because most
    // letters have no room at all; asking for it here rather than asserting keeps that honest.
    if (!command.direction || !command.doorState || command.room === undefined) return false;
    const doorway = this.world.doorway(command.room, command.direction as Direction);
    if (!doorway) return false;

    const closed = command.doorState !== 'open';
    const locked = LOCKS_HOLD && command.doorState === 'locked';
    const wasClosed = doorway.near.door.closed;
    const wasLocked = doorway.near.door.locked;
    if (wasClosed === closed && wasLocked === locked) return false;

    for (const side of [doorway.near, doorway.far]) {
      if (side) side.door.locked = locked;
    }
    this.world.setDoorClosed(doorway, closed);
    return true;
  }

  /**
   * Turns an actor to face a point, and answers whether it moved.
   *
   * The visible half of noticing, and the reason `facing` was on `EntityView` from the beginning: the LPC
   * sheets carry four rows and the client picks one off this field, so a mob turning toward you is a real
   * change on screen rather than a log line claiming something happened.
   *
   * `facingOf` is the same helper movement uses, so a mob that turns and a player who walks agree about what
   * "east" means — including the diagonal-ambiguity rule that keeps a sprite from flickering between two
   * rows when the difference is a pixel.
   */
  turnToward(actor: Actor, x: number, y: number): boolean {
    const next = facingOf(x - actor.x, y - actor.y, actor.facing);
    if (next === actor.facing) return false;
    actor.facing = next;
    return true;
  }

  /**
   * How many of one vnum are alive, anywhere in the world.
   *
   * **World-wide, not per zone**, because that is what `mob_index[].number` is in the source and it is
   * load-bearing: a mob lured three zones away still counts against its own limit, so its replacement
   * does not spawn. That single fact is what makes luring a tactic with a consequence rather than a way
   * to farm a room.
   */
  countOf(vnum: number): number {
    let n = 0;
    for (const actor of this.actors.values()) if (isMob(actor) && actor.vnum === vnum) n++;
    return n;
  }

  selfViewOf(player: Player): SelfView {
    return {
      id: player.id,
      name: player.name,
      // Protocol 24: the sheet gets the numbers the roll withheld — race, class and the six scores.
      // Omitted for a character who has not adopted, so a pre-phase save's view is byte-identical.
      ...(player.identity
        ? { identity: { race: player.identity.race, class: player.identity.class, scores: player.identity.scores } }
        : {}),
      level: player.level,
      hp: player.hp,
      maxHp: player.maxHp,
      mana: player.mana,
      maxMana: player.maxMana,
      move: player.move,
      maxMove: player.maxMove,
      experience: player.experience,
      // Phase 14b: the real remainder against Duris' step curve, not the placeholder 300 this held
      // while nothing consumed experience. `null` at the ceiling reads as "no next level" and is
      // shown as such rather than as a target of zero, which would look like a level-up stuck.
      experienceToNext: experienceToNext({ level: player.level, experience: player.experience, maxHp: player.maxHp }) ?? 0,
      equipped: player.equipped,
      // Protocol 15. Omitted for a character carrying nothing at the default capacity, so the common
      // case costs no payload on a message sent every time a hit point moves.
      ...(player.inventory.stacks.length > 0 || player.inventory.capacity !== STARTING_CAPACITY
        ? { bag: bagViewOf(player, this.artClassOf, this.iconOf) }
        : {}),
      // **The fight first, then the chase.** Both are real at different moments and the precedence is
      // resolved here rather than in the client: while you are swinging at something that is your
      // target, and the instant the fight breaks the pointer to what ran is what you still care about.
      ...(player.fighting !== undefined
        ? { target: player.fighting }
        : player.pursuing !== undefined
          ? { target: player.pursuing }
          : {}),
      roomId: player.roomId,
      place: player.place,
      posture: player.posture,
      status: player.status,
      lightRadius: player.lightRadius,
      // Omitted rather than set to undefined when there is nothing in hand: `exactOptionalProperty-
      // Types` is on, and the wire form has to be consistent about it too, since `JSON.stringify`
      // drops an undefined value and a client cannot otherwise tell "no light" from "field the
      // server forgot to fill in".
      ...(player.light ? { light: toCarriedLight(player.light, this.lightRemaining(player)) } : {}),
      // Grouped and filtered by the shared display path, so the HUD and the `affects` command cannot
      // come to disagree about what is shown or how it is worded.
      affects: summariseAffects(player.affects).map((summary) => ({
        type: summary.type,
        name: summary.name,
        ...(summary.remainingMs === undefined ? {} : { remainingMs: Math.max(0, Math.round(summary.remainingMs)) }),
      })),
    };
  }
}

/**
 * Narrowing, in one place each.
 *
 * Written as predicates rather than inline `a.kind === 'player'` tests so that the *reason* a branch
 * exists is named at the branch. Every one of these in the codebase marks somewhere a mob genuinely
 * cannot go — a socket to send down, a route to walk, a lit set of its own — and they should be easy to
 * count. There are very few, which is the measure of whether Phase 7 did its job.
 */
export function isPlayer(actor: Actor): actor is Player {
  return actor.kind === 'player';
}

export function isMob(actor: Actor): actor is Mob {
  return actor.kind === 'mob';
}

/** Is the player close enough to this waypoint to call it reached? */
function reached(player: Player, point: TilePoint): boolean {
  return (
    Math.hypot(tileCentre(point.tx) - player.x, tileCentre(point.ty) - player.y) <= WAYPOINT_RADIUS
  );
}


/**
 * What is in the two hands, in the three fields `appearanceOf` can choose a mesh from — M7b.
 *
 * The whole of the server's share of the weapons slice, and it is a projection rather than a
 * decision: which of the four props kit meshes a `weaponClass` means is `shared/appearance.ts`'s
 * (`WEAPON_ART`), and this function's only job is to hand it the facts an `Item` carries that the
 * wire's `wearing` record has thrown away.
 *
 * `art` comes out of the `wearing` record that has already been built rather than by calling
 * `artClassOf` a second time — two reads of the same equipment through the same resolver is exactly
 * how `wearing` and `gear` would come to disagree, which is the note `viewOf` opens with.
 */
function handsOf(
  equipped: Equipped,
  wearing: Readonly<Record<string, string>> | undefined,
): { main?: HeldView; off?: HeldView } | undefined {
  const read = (slot: 'mainHand' | 'offHand'): HeldView | undefined => {
    const item = equipped[slot];
    if (!item) return undefined;
    const art = wearing?.[slot];
    return {
      ...(art === undefined ? {} : { art }),
      ...(item.weaponClass === undefined ? {} : { weaponClass: item.weaponClass }),
      // The presence of a light, not its radius: a lantern and a torch are one mesh.
      ...(item.light ? { light: true as const } : {}),
    };
  };
  const main = read('mainHand');
  const off = read('offHand');
  return main || off ? { ...(main ? { main } : {}), ...(off ? { off } : {}) } : undefined;
}

/** Keeps the previous facing when an intent is diagonal-ambiguous, to avoid sprite flicker. */
function facingOf(dx: number, dy: number, previous: Direction): Direction {
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  if (Math.abs(dy) > Math.abs(dx)) return dy > 0 ? 'south' : 'north';
  return previous;
}

/**
 * The bag as the character sheet's drawer draws it — protocol 15.
 *
 * **Deliberately the same shape the `inventory` command prints**, because they are one answer to one
 * question and two renderings of a bag that could disagree is a bug nobody would think to look for.
 * Containers show how full they are and their contents indented, exactly as the text listing does.
 *
 * Text and counts rather than `Item` records: `self` goes out on every vitals change, and a stranger's
 * armour value has no business riding along on a heartbeat.
 */
function bagViewOf(
  player: Player,
  artOf?: (item: Item) => string | undefined,
  iconOf?: (item: Item) => string,
): BagView {
  /**
   * Folds identical rows together **for display only** — owner's ask (2026-08-04): *"instead of seeing
   * a shard of silver 4 times it should just say a shard of silver x4… if they use a slot each then it
   * can say 4 slots."*
   *
   * **This is not §3's stacking and must not be confused with it.** A `Stack` is items sharing one
   * slot, which only things with a `stackLimit` do; four shards of silver are four separate stacks
   * costing four slots, and that is correct — the bag really is that full. What was wrong was printing
   * the same line four times. So count *and* slots are summed: the row says four of these, costing
   * four slots, which is true of the bag and readable at a glance.
   *
   * Keyed on everything that makes two rows the same thing. Charges are in the key because §3 already
   * refuses to merge a part-used potion into a stack of full ones, and a listing that merged them would
   * claim four full bottles when one is nearly empty. A container holding anything never folds: its
   * contents are what distinguish it, and two quivers of different arrows are two quivers.
   */
  const fold = (rows: readonly BagRow[]): BagRow[] => {
    const out: BagRow[] = [];
    const at = new Map<string, number>();
    for (const row of rows) {
      const foldable = row.contents === undefined;
      const key = `${row.name} ${row.remaining ?? ''} ${row.holds?.join('/') ?? ''}`;
      const seen = foldable ? at.get(key) : undefined;
      if (seen === undefined) {
        if (foldable) at.set(key, out.length);
        out.push(row);
        continue;
      }
      const first = out[seen]!;
      out[seen] = { ...first, count: (first.count ?? 1) + (row.count ?? 1), slots: first.slots + row.slots };
    }
    return out;
  };

  const rowOf = (stack: Stack, rule?: ContainerRule): BagRow => ({
    name: stack.item.name,
    // **A7d-bag, protocol 20, through the seam that already existed.** `artClassOf` is injected by
    // `index.ts` because the catalogue is not this file's business — the same resolver that dresses a
    // body, so an item in the bag and the same item on the shoulders cannot draw differently. Absent
    // when the item has no art, which is most of the catalogue.
    ...(() => {
      // A real picture outranks a silhouette; a silhouette outranks a blank — protocol 29, found
      // when the potion recall stripped 364 rows back to artlessness and the drawer went empty.
      const art = artOf?.(stack.item);
      if (art !== undefined) return { art };
      const icon = iconOf?.(stack.item);
      return icon === undefined ? {} : { icon };
    })(),
    ...(stack.count > 1 ? { count: stack.count } : {}),
    ...(stack.remaining !== undefined && stack.item.uses !== undefined && stack.remaining < stack.item.uses
      ? { remaining: stack.remaining }
      : {}),
    slots: stackSlots(stack, limitOf(stack.item)),
    ...(rule ? { holds: [usedInside({ rule, contents: stack.held?.contents ?? [] }), rule.capacity] as const } : {}),
    ...(stack.held && stack.held.contents.length > 0
      ? { contents: fold(stack.held.contents.map((inside) => rowOf(inside))) }
      : {}),
  });

  const purse = Object.fromEntries(Object.entries(player.purse).filter(([, n]) => n > 0));
  return {
    rows: fold(player.inventory.stacks.map((stack) => rowOf(stack, stack.held?.rule))),
    used: slotsUsed(player.inventory),
    capacity: player.inventory.capacity,
    ...(Object.keys(purse).length > 0 ? { purse } : {}),
  };
}
