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

import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer, type WebSocket } from 'ws';

import {
  AUTHORED_VNUM_BASE,
  BASE_REGEN,
  DIRECTIONS,
  PLAYER_RADIUS,
  PROTOCOL_VERSION,
  ROUND_MS,
  DEFAULT_WEAPON,
  divideExperience,
  groupedShare,
  abilityChance,
  SCENERY,
  SEARCH_LAG_ROUNDS,
  SEARCH_LINES,
  findsIt,
  sceneryNamed,
  sceneryOf,
  SHIELDLESS_BASH_LINE,
  STARTER_SHIELD_ID,
  type Shield,
  abilityDamage,
  COMBAT_ABILITIES,
  isCombatAbility,
  type CombatAbilityId,
  type SkillId,
  MIN_ROUND_MS,
  MS_PER_DURIS_HOUR,
  MISSILE_TYPE,
  MISSILE_TYPE_NAMES,
  pick,
  randomInt,
  resolveAttack,
  ROOM_TILES,
  rollDamage,
  rollDice,
  HP_DEAD_BELOW,
  ITEM_TYPE_BOAT,
  ICE_STORM_MIN_CHANCE,
  MOB_CAST_CHANCE,
  PROC_DEPTH_CAP,
  SPECIAL_PROCS,
  SPELLS,
  SPELL_IDS,
  THREAT_PER_HEAL,
  rollProc,
  rollProcBlows,
  areaHitCount,
  rollEarthquake,
  defaultSaveMod,
  isSpellId,
  mobCastMs,
  rollSave,
  rollShrug,
  rollSpellBlows,
  reduceSpellDamage,
  scaleSpellDamage,
  rollSpellBuff,
  rollSpellHeal,
  shrugChance,
  spellFromDurisNumber,
  type Spell,
  OFFENSIVE_NOTCH_CHANCE,
  RESCUE_NOTCH_CHANCE,
  arrivalTile,
  ATTACK_VERBS,
  SWING_ANIMATION,
  attackTypeForRace,
  attackTypeForWeapon,
  type AttackType,
  AffectFlag,
  newAffect,
  sumApply,
  type AffectType,
  ceilingFor,
  DODGE_NOTCH_CHANCE,
  PARRY_NOTCH_CHANCE,
  defenceVerb,
  learnedAt,
  mobDefenceSkill,
  notchChance,
  NOTCH_COOLDOWN_MS,
  rollNotch,
  SKILL_CATEGORIES,
  SKILL_IDS,
  SKILLS,
  skillFloor,
  toHitFrom,
  weaponSkillFor,
  WEAPON_NOTCH_CHANCE,
  DUAL_WIELD_NOTCH_CHANCE,
  handednessFor,
  type OffHandSwing,
  abilityMod,
  armourToAc,
  attackBonusFor,
  ABILITIES,
  BONUS_POINTS,
  circleAt,
  CLASSES,
  isClassId,
  isRaceId,
  knownSpells,
  knowsSpell,
  maxManaFor,
  RACES,
  rollScores,
  scoreWord,
  slotsForCircle,
  spendBonus,
  UNLIMITED_DURATION,
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
  DURIS_ITEM,
  playerCombatStats,
  rollDamageGain,
  expectedDamageBonus,
  damrollFrom,
  hitrollFrom,

  weaponFrom,
  STARTING_HIT_POINTS,
  addCoins,
  carry,
  carryStack,
  describeContainer,
  describePurse,
  purseFromValue,
  purseValue,
  spendCoins,
  stripColour,
  instantiate,
  roomCentre,
  tileCentre,
  describeStack,
  freeInside,
  CURRENCIES,
  apportion,
  contributionValue,
  mergeStacks,
  mergeable,
  putRefusal,
  stackOf,
  type Held,
  isMoney,
  coinsOf,
  isWalkableAt,
  roomAtTile,
  purseIsEmpty,
  vnumOf,
  wordsFromName,
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
  type Inventory,
  type Item,
  type Stack,
  resolveWearSlot,
  meets,
  summariseAffects,
  parseDirection,
  placeKey,
  SECTOR_REQUIRES_MOVEMENT,
  samePlace,
  shortfall,
  canonicalCharacterName,
  characterNameProblem,
  BALD,
  defaultHairFor,
  type Ability,
  type AbilityScores,
  type AdjacentRoomView,
  type CharacterSummary,
  type ClassId,
  type ClientMessage,
  type Direction,
  type EntityId,
  type EntityView,
  type ExtraDescription,
  type GroupMemberView,
  type LogChannel,
  type Place,
  type Posture,
  type RaceId,
  type Requirement,
  type RoomId,
  type Status,
  type RoomView,
  type ServerMessage,
  type TileGrid,
  AUTHORED_MOB_BASE,
  type MobTemplate,
  type ResetCommand,
  type ZoneSpawns,
  type TilePoint,
} from '@mygame/shared';
// Subpath imports: `light`, `pathfind` and `vision` are not re-exported from the package barrel.
import { lightSource, lightSourceFrom, type LightSource } from '@mygame/shared/light.ts';
import { canWalkStraightTo, findPath, type PathFailure } from '@mygame/shared/pathfind.ts';
import { bitsToBase64, bitsetToSet } from '@mygame/shared/vision.ts';

import { UNSEEN_NAME, actLines, actLinesPair } from './act.ts';
import { roomLightsItself, underOpenSky } from '@mygame/shared/light.ts';

import { AccountStore, MAX_CHARACTERS_PER_ACCOUNT, type AccountRecord, type AuthResult } from './accounts.ts';
import { AdminApi, LOOPBACK, serveAdmin, type LiveOps } from './admin.ts';
import { artIdFromPath, artSheetPath } from './art.ts';
import { AUTHORED_SHOPS_FILE,
  findInStock,
  loadShops,
  priceToBuy,
  sellOffer,
  stockOf,
  willBuy,
  type Shop,
} from './shops.ts';
import {
  COMMANDS,
  COMMAND_REQUIREMENTS,
  directionOf,
  findTarget,
  isName,
  lookupCommand,
  newCommandBudget,
  parseTargetRef,
  spendCommand,
  splitCommand,
  type Command,
  type CommandBudget,
} from './commands.ts';
import { hairCommand } from './hair.ts';
import { wordsForItem, wordsForMob } from './keywords.ts';
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
  slugify,
  type LegacyRoomTiles,
  type PlayerIdentity,
  type PlayerRecord,
} from './players.ts';
import { QUESTS_FILE, carriedForQuest, consumeBrought, loadQuests, objectivePhrase, questsBy } from './quests.ts';
import { carriesLight, membershipDiff, roomsSeeingInto, visibleBodies, type CrossingDeps } from './nearby.ts';
import { afterLook, directionFrom, nameable, peek, revealShownIn, REVERSE } from './peek.ts';
import { RANGED_THREAT_FACTOR, breakChance, rollChance, takeMissile, wrongTargetChance } from './ranged.ts';
import {
  isUntouchable,
  setUntouchableVnums,
  advanceAssists,
  advanceCombat,
  attackersOf,
  canBeAttacked,
  clearEngagements,
  disengage,
  canEngage,
  engage,
  joinBySupporting,
  landBlow,
  forgetThreat,
  openingTarget,
  rescueFrom,
  type AssistEvent,
  type AttackOutcome,
  type DefenceSkills,
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
  corpseAnswersTo,
  corpseName,
  shoreFor,
  spoilsOf,
  makeCorpse,
  withinReach,
  type Corpse,
  type Graveyard,
} from './corpses.ts';
import {
  GROUND_DECAY_MS,
  advanceGround,
  dropItem,
  dropSpotNear,
  groundSprite,
  groundViewOf,
  itemsIn,
  visibleItemsIn,
  nearestMatching,
  takeItem,
  withinPickupReach,
  type Ground,
} from './ground.ts';
import { boardListing, boardMessage, loadBoards } from './boards.ts';
import { practiceCost, practiceRefusal, practiceSlate } from './practice.ts';
import { loadSettings, saveSettings, type WorldSettings } from './settings.ts';
import { GameClock } from './clock.ts';
import { WorldWeather } from './weather.ts';
import {
  adoptZones,
  astralMessageAt,
  clockBanner,
  hearsAstral,
  hearsWeather,
  loadWorldClock,
  saveWorldClock,
  skyFor,
} from './worldclock.ts';
import { attemptFlee, type FleeOutcome } from './flee.ts';
import { markPursuers, pursuitTarget } from './pursue.ts';
import {
  advanceHunts,
  beginHunt,
  beginWalkTo,
  PROVOKED_PATIENCE_MS,
  provokedLeash,
  WANDER_PULSE_MS,
  beginDrift,
  wanderRoll,
  forgetQuarry,
  type Hunt,
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
import { advanceZones, newZoneClock, refitMobArmour, runReset, type ZoneClock } from './reset.ts';
import { Simulation, isMob, isPlayer, type Actor, type AffectEvent, type Mob, type Player } from './sim.ts';
import { emptyZoneSpawns, indexTemplates, loadItemCatalogue, loadZoneSpawns } from './spawns.ts';
import {
  ITEMS_FILE,
  applyItemOverride,
  loadItemOverrides,
  mergeItemOverride,
  type ItemOverride,
} from './item-overrides.ts';
import {
  draftAuthoredItem,
  loadAuthoredStore,
  saveAuthoredStore,
  takeAuthoredVnum,
  type ItemDraft,
} from './item-authoring.ts';
import { ROOMS_FILE } from './overrides.ts';
import { PLACEMENTS_FILE, loadPlacements, placementResets } from './placements.ts';
import {
  AUTHORED_MOBS_FILE,
  draftAuthoredMob,
  loadAuthoredMobs,
} from './mob-authoring.ts';
import {
  MOBS_FILE,
  MOB_OVERRIDE_META,
  applyMobOverride,
  applyOutfit,
  loadMobOverrides,
  mergeMobOverride,
  outfitFor,
  type Outfit,
} from './mob-overrides.ts';
import {
  followersOf,
  forgetFollower,
  leaderOf,
  newFollowing,
  startFollowing,
  stopFollowing,
  wouldLoop,
} from './following.ts';
import {
  consentedTo,
  depart,
  disband,
  enrol,
  forgetGrouping,
  grantConsent,
  grouped,
  leads,
  MAX_GROUP_MEMBERS,
  membersWith,
  newGrouping,
  revokeConsent,
} from './grouping.ts';
import { buildPlaceGraph } from './placegraph.ts';
import { AUTHORED_ROOMS_FILE, saveAuthoredRooms } from './room-authoring.ts';
import { AUTHORED_ZONES_FILE } from './zone-authoring.ts';
import { GameWorld, WORLD_DIR, placeOf } from './world.ts';

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

// **What is a boat is a catalogue question**, so the sim is handed the answer rather than the
// catalogue — the same injection `artClassOf` rides in on, for A7d's reason: `sim.ts` knows no
// catalogue. The source's own live rule (`actmove.c`): `ITEM_BOAT`, carried **at the top level** or
// worn — a canoe inside a sack floats nobody, so `stack.held` is deliberately not searched.
sim.setSwimAid((actor) => {
  if (!isPlayer(actor)) return false;
  for (const stack of actor.inventory.stacks) {
    if (templateOf(stack.item)?.type === ITEM_TYPE_BOAT) return true;
  }
  for (const item of Object.values(actor.equipped)) {
    if (item !== undefined && templateOf(item)?.type === ITEM_TYPE_BOAT) return true;
  }
  return false;
});

// The event switch, injected the same way and read live — `settings` is reassigned when the panel
// throws it, and this closure reads the variable, so no restart stands between the operator and a
// free-movement evening. The owner's ask (2026-08-07): "just in case I decide to remove the cost of
// movement during special events."
sim.setMoveCosts(() => settings.movementCosts);

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
if (world.linksApplied > 0) {
  console.log(`[world] ${world.linksApplied} authored link(s) carved — see data/world/overrides/links.json`);
}
for (const why of world.linkRefusals) {
  // Loud and one line each. A refused link is a door somebody authored and nobody can walk through,
  // and the two reasons it happens — a zone switched off in the config, a direction the harvest
  // already uses — are both invisible from inside the game.
  console.warn(`[world] authored link refused: ${why}`);
}

/**
 * The world's population, and the clock that tops it up.
 *
 * One `ZoneClock` per zone listed to populate. A zone the harvest never matched still gets one — an empty
 * shell from `emptyZoneSpawns`, so its clock runs and authored placements have a table to be merged into.
 * A zone that is *not* listed is simply empty, which is the ordinary case for the 278 zones no Duris file
 * matched. **Having a harvest and being populated are separate facts**: the first is about
 * `data/world/spawns/`, the second is `world.config.json`'s `populate` list, and only the second decides
 * whether a zone fills. See `spawns.ts`.
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
  if (spawns) {
    loadedSpawns.push(spawns);
    continue;
  }
  // Not a warning any more: a zone with no harvested file is now a zone whose population is authored,
  // which is a thing this project does on purpose. It is still worth one line, because an empty shell
  // and a zone whose placements file is missing look identical from the game.
  loadedSpawns.push(emptyZoneSpawns(zoneId));
  console.log(`[pop] zone ${zoneId} has no harvested population file; its inhabitants are authored`);
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

// Phase 17. Keyed by keeper mob vnum — a shopkeeper is a mob vnum and nothing else, so this map is
// the whole of "is the thing in front of me a merchant". Empty when the harvest has not been run.
const shopsByKeeper = loadShops();
// Phase 23: the authored anchors lie over the harvest — same loader, same tolerance, second word.
for (const [keeper, shop] of loadShops(AUTHORED_SHOPS_FILE)) shopsByKeeper.set(keeper, shop);

/**
 * The patrol beats — Phase 25, and the measurement is the design here. `specs.mobile.c`'s
 * `patrol_leader` turned out to be a *bounded wander with a bias toward trouble* — Duris has no
 * waypoint machinery anywhere; `ACT_PATROL` merely excludes a mob from the mundane wander so its
 * spec can drive it. The waypoint beat is therefore **ours**, from DESIGN-city.md's ledger
 * ("patrol routes — waypoints on the tick"), built on the walk the hunts already own: a route is
 * its *turning points*, `firstStepToward` fills the rooms between, and a watchman walks end to
 * end, pausing at each reach, for ever. The source's one real patrol rule is kept: a mob with a
 * beat never mundane-wanders.
 */
const PATROLS_FILE = join(WORLD_DIR, 'overrides', 'patrols-authored.json');
const patrolsByVnum = new Map<number, { route: readonly RoomId[]; pauseMs: number }>();
try {
  const raw = JSON.parse(readFileSync(PATROLS_FILE, 'utf8')) as Record<string, { route?: unknown; pauseMs?: unknown }>;
  for (const [key, row] of Object.entries(raw)) {
    const vnum = Number(key);
    if (!Number.isInteger(vnum) || !Array.isArray(row?.route) || row.route.length < 2) continue;
    if (!row.route.every((room) => typeof room === 'number')) continue;
    patrolsByVnum.set(vnum, {
      route: row.route as RoomId[],
      pauseMs: typeof row.pauseMs === 'number' && row.pauseMs >= 0 ? row.pauseMs : 20_000,
    });
  }
} catch {
  /* no beats authored yet */
}

/** Where each patrolling body is in its beat: the leg it walks toward, and pulses left at rest. */
const patrolLegs = new Map<number, { leg: number; restPulses: number }>();

/**
 * The guildmasters — Phase 24. A registry file rather than a mob field, `shops-authored.json`'s
 * argument one door down: which mob teaches which class is content beside the mob, not a stat on
 * it, and a file of pairs needs no loader surgery. The class decides everything a Duris teacher's
 * own skill table decided: what the hall may teach is what `CLASS_SKILLS` grants that class.
 */
const TRAINERS_FILE = join(WORLD_DIR, 'overrides', 'trainers-authored.json');
const trainersByVnum = new Map<number, ClassId>();
try {
  const raw = JSON.parse(readFileSync(TRAINERS_FILE, 'utf8')) as { vnum?: unknown; class?: unknown }[];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (typeof row?.vnum === 'number' && typeof row.class === 'string' && isClassId(row.class)) {
        trainersByVnum.set(row.vnum, row.class);
      }
    }
  }
} catch {
  /* no guilds authored yet — the ordinary state of a world without a city */
}

/**
 * A6: the authored overlay, composed over the harvest — and the pristine copies that make a revert
 * honest.
 *
 * `itemOverrides` is the content of `data/world/overrides/items.json`, shared with the admin router
 * for saving. **`pristineItems` holds the harvested template of every vnum that carries an override**,
 * stashed the moment one first lands. Without it, "clear this field" could only rebuild from the
 * already-overridden template — which is not a revert, it is whatever the last edit happened to leave.
 * Only overridden vnums are stashed, so the map stays a handful of entries rather than a second
 * catalogue.
 */
const itemOverrides = loadItemOverrides();
const pristineItems = new Map<number, ItemTemplate>();
for (const [vnum, override] of itemOverrides) {
  const base = itemCatalogue.get(vnum);
  if (!base) continue; // authored against a vnum this harvest no longer has — kept in the file, inert
  pristineItems.set(vnum, base);
  itemCatalogue.set(vnum, applyItemOverride(base, override));
}

/**
 * A6b: items that were **made here**, added to the catalogue rather than folded over it.
 *
 * Added *after* the override fold and not through it, because there is nothing underneath them to fold
 * over — see `item-authoring.ts` for why the two overlays are separate files with opposite rules. From
 * this line on the catalogue makes no distinction: a created sword is looked up, matched by keyword,
 * spawned by a reset and put in a bag by exactly the code that handles a harvested one. **That is the
 * property worth protecting** — the moment anything downstream has to ask "is this one ours?", the
 * created item stops being a real item and becomes a special case.
 *
 * The vnum range is what makes it safe: `AUTHORED_VNUM_BASE` is an order of magnitude above the highest
 * vnum Duris ships, so `set` here can never quietly replace a harvested entry.
 */
const authoredStore = loadAuthoredStore();
for (const [vnum, authored] of authoredStore.items) itemCatalogue.set(vnum, authored.item);

/**
 * A4c: what each mob template is authored to carry, and the one function the spawn paths read it with.
 *
 * Held here rather than passed around because two very different callers need the same answer — the
 * zone reset and the panel's own spawn button — and a second copy of the resolution would be a second
 * chance to disagree about what a slot means.
 *
 * Loaded **after** the catalogue is whole, including created items: authored loot may name a vnum that
 * only exists because A6b made it, and reading the overlay before that fold would report it missing.
 */
const mobOverrides = loadMobOverrides();
// The rare-drop roll rides the spawn stream: which repop carries the blade is world luck, and world
// luck is seeded (`CLAUDE.md` rule 3) — a restart replays the same fortunate ranger.
const authoredOutfit = (vnum: number): Outfit =>
  outfitFor(mobOverrides.get(vnum), itemCatalogue, instantiate, (percent) => randomInt(spawnRng, 1, 100) <= percent);

/**
 * A9: the harvested template of every vnum that carries an override, stashed the moment one lands.
 *
 * `pristineItems`' twin and for the identical reason: without it, *clear this field* could only rebuild
 * from the already-overridden template, which is not a revert but whatever the last edit happened to
 * leave. Only overridden vnums are stashed, so it stays a handful of entries rather than a second
 * catalogue — and the fold below is what makes an authored level real for everything the world spawns
 * from here on, because `runReset` builds every mob out of this map.
 */
const pristineMobs = new Map<number, MobTemplate>();
for (const [vnum, override] of mobOverrides) {
  const base = mobTemplates.get(vnum);
  if (!base) continue; // authored against a vnum this harvest no longer has — kept in the file, inert
  pristineMobs.set(vnum, base);
  mobTemplates.set(vnum, applyMobOverride(base, override));
}
/**
 * A9b: mobs that were **made here**, added to the template map rather than folded over it.
 *
 * Added *after* the override fold and not through it, because there is nothing underneath them to fold
 * over — see `mob-authoring.ts` for why the two overlays are separate files with opposite rules. From
 * this line on the map makes no distinction: a created creature is looked up, matched by keyword, spawned,
 * fought, killed and looted by exactly the code that handles a harvested one. **That is the property worth
 * protecting** — the moment anything downstream has to ask *“is this one ours?”*, a created mob stops
 * being a real mob and becomes a special case.
 *
 * The vnum range is what makes it safe: `AUTHORED_MOB_BASE` is an order of magnitude above the highest
 * vnum Duris ships, so `set` here can never quietly replace a harvested entry.
 */
const authoredMobs = loadAuthoredMobs();
for (const [vnum, authored] of authoredMobs.mobs) mobTemplates.set(vnum, authored.mob);
if (authoredMobs.mobs.size > 0) {
  console.log(`[mobs] ${authoredMobs.mobs.size} creature(s) made here, numbered from ${AUTHORED_MOB_BASE}`);
}

// **The merchants' peace** — owner, 2026-08-10: keepers are immortal, unharmable, and never angry.
// The armour is combat's untouchable registry (seeded in `seedQuestGivers`, unioned there so a
// quest write cannot strip it); this is the temper — whatever the harvest gave a keeper's template,
// it loads passive, assisting nobody, anchored to its post. Duris' `.shp` carries a per-shop
// `shop_killable` Y/N; the owner's ruling reads every one as N, so there is no flag to consult.
for (const keeper of shopsByKeeper.keys()) {
  const template = mobTemplates.get(keeper);
  if (!template) continue;
  mobTemplates.set(keeper, {
    ...template,
    aggro: { ...template.aggro, disposition: 'passive', clauses: [], assists: false, sentinel: true },
  });
}

/**
 * Rebuilds every zone's reset table from its harvest plus the authored placements as they now stand.
 *
 * **Called on every placement write**, because a `ZoneClock` holds the `ZoneSpawns` it was made with:
 * editing only the overlay would be a change that took effect on the next server start and not before,
 * which is the class of "I saved it and nothing happened" this project keeps paying for.
 *
 * Rebuilt from `harvestedResets` rather than appended to what is there, so removing a placement removes
 * it — appending would make the table grow by one on every save.
 */
function repopulateResets(): void {
  const byZone = placementResets(placements, (room) => world.zoneOf(room));
  for (const clock of zoneClocks) {
    const base = harvestedResets.get(clock.spawns.zone) ?? clock.spawns.resets;
    clock.spawns = { ...clock.spawns, resets: [...base, ...(byZone.get(clock.spawns.zone) ?? [])] };
  }
}

/** Each zone's reset table as the harvest left it — what a placement rebuild starts from. */
const harvestedResets = new Map<number, readonly ResetCommand[]>();

/**
 * A9c: authored placements, merged into the reset tables the zone clocks will run.
 *
 * **After** the created-mob fold above, which is the ordering that makes the whole thing work: `runReset`
 * looks a command's vnum up in `mobTemplates`, so a placement naming 9,000,000 finds a real template and
 * needs no special case anywhere in the executor.
 *
 * **Appended, never interleaved.** A zone file's order is load-bearing — `G` and `E` attach to *the last
 * mobile loaded* — so an authored `M` inserted mid-table would hand somebody else's sword to a creature
 * we added. At the end, with `ifPrevious: false`, it can neither steal a cursor nor be skipped by one.
 *
 * A placement in a zone this server did not load is kept in the file and simply has nowhere to go; the
 * write path refuses such a room up front, so that only happens when a zone leaves `world.config.json`
 * underneath an overlay written earlier.
 */
const placements = loadPlacements();
for (const spawns of loadedSpawns) harvestedResets.set(spawns.zone, spawns.resets);
{
  const byZone = placementResets(placements, (room) => world.zoneOf(room));
  for (let i = 0; i < loadedSpawns.length; i++) {
    const spawns = loadedSpawns[i]!;
    const extra = byZone.get(spawns.zone);
    if (!extra || extra.length === 0) continue;
    loadedSpawns[i] = { ...spawns, resets: [...spawns.resets, ...extra] };
  }
  const placed = [...placements.values()].reduce((sum, rows) => sum + rows.length, 0);
  const homeless = placed - [...byZone.values()].reduce((sum, rows) => sum + rows.length, 0);
  if (placed > 0) {
    console.log(
      `[mobs] ${placed} authored placement(s) across ${byZone.size} zone(s)` +
        (homeless > 0 ? ` — ${homeless} in rooms this server has not loaded` : ''),
    );
  }
}

if (mobOverrides.size > 0) {
  const pieces = [...mobOverrides.values()].reduce((sum, o) => sum + (o.loot?.length ?? 0), 0);
  const notAField = new Set([...MOB_OVERRIDE_META, 'loot']);
  const edited = [...mobOverrides.values()].filter((o) => Object.keys(o).some((k) => !notAField.has(k))).length;
  console.log(
    `[mobs] ${mobOverrides.size} template(s) authored — ${pieces} piece(s) of loot, ${edited} with edited fields`,
  );
}

console.log(
  itemCatalogue.size > 0
    ? `[items] ${itemCatalogue.size} item types loaded` +
        (itemOverrides.size > 0 ? `, ${itemOverrides.size} edited` : '') +
        (authoredStore.items.size > 0 ? `, ${authoredStore.items.size} created here` : '')
    : '[items] no catalogue; mobs will carry nothing. Run `npm run worldgen`.',
);

/**
 * One authored edit to an item, applied live — the item half of `world.authorRoom`.
 *
 * Rebuilds from the **pristine** template plus whatever the merged override still says, so clearing a
 * field restores the harvest exactly. Affects every instance created from here on — a reset's next
 * `G`, a repop's next `O` — and deliberately not instances already in bags and on floors: an `Item`
 * is a flat copy by §8's design, and reaching into saves to rewrite them would be the kind of edit
 * nobody can audit.
 */
function authorItem(
  vnum: number,
  next: Partial<ItemOverride>,
  cleared: readonly string[],
): ItemTemplate | undefined {
  // **A created item is never patched.** It has no harvest underneath it, so a partial override against
  // it would be a patch over nothing and `Restore harvested` would restore an empty record. The two
  // overlays must never hold the same vnum; the range is the guard, and this is where it is enforced.
  if (vnum >= AUTHORED_VNUM_BASE) return undefined;
  const current = itemCatalogue.get(vnum);
  if (!current) return undefined;
  const pristine = pristineItems.get(vnum) ?? current;
  const merged = mergeItemOverride(itemOverrides.get(vnum), next, cleared, new Date().toISOString());
  if (merged) {
    pristineItems.set(vnum, pristine);
    itemOverrides.set(vnum, merged);
    const applied = applyItemOverride(pristine, merged);
    itemCatalogue.set(vnum, applied);
    return applied;
  }
  // Nothing authored remains: the entry is deleted and the harvest is back, mark and all.
  itemOverrides.delete(vnum);
  pristineItems.delete(vnum);
  itemCatalogue.set(vnum, pristine);
  return pristine;
}

/**
 * A6b: create an item, or edit one that was created here. **The whole-record path.**
 *
 * One function for both because an edit *is* a re-draft: the incoming fields are laid over the record
 * that exists and the result goes through the same validator a creation does. A second, laxer path for
 * edits is how a field ends up legal to change but illegal to set — the exact asymmetry
 * `readAuthoredItem` avoids by running the API's own validator against the file on disk.
 *
 * `vnum` is `undefined` to create — the number is the server's to allocate and never the caller's, so a
 * form cannot ask for one that a re-harvest might later claim.
 */
function authorNewItem(
  vnum: number | undefined,
  draft: ItemDraft,
  by: string,
): { item: ItemTemplate } | { error: string } {
  const existing = vnum === undefined ? undefined : authoredStore.items.get(vnum);
  if (vnum !== undefined && !existing) return { error: `no item created here with vnum ${vnum}` };

  // An edit keeps every field it does not mention. `draftAuthoredItem` reads an explicit `null` as
  // "back to the default", which is how a form clears one field without resending the rest.
  const merged: ItemDraft = existing ? { ...existing.item, ...draft } : draft;
  // **Drafted before the number is taken**, so a refused draft does not burn a vnum. The counter only
  // ever moves forward, and moving it for an item that was never created would leave a permanent hole
  // in the numbering for a typo.
  const drafted = draftAuthoredItem(vnum ?? authoredStore.next, merged);
  if ('error' in drafted) return drafted;
  const number = vnum ?? takeAuthoredVnum(authoredStore);

  authoredStore.items.set(number, { item: drafted.item, at: new Date().toISOString(), by });
  saveAuthoredStore(authoredStore);
  itemCatalogue.set(number, drafted.item);
  return { item: drafted.item };
}

/**
 * Removes a created item from the catalogue and the overlay.
 *
 * **Only ever a created one** — there is no such thing as deleting a harvested item, because the next
 * `npm run worldgen` would put it straight back and the only honest way to retire one is a zone edit.
 * Instances already in bags and on floors are untouched, for the same reason an edit does not reach
 * into them: an `Item` is a flat copy by §8's design, and a saved bag is not ours to rewrite.
 */
function deleteAuthoredItem(vnum: number): boolean {
  if (!authoredStore.items.has(vnum)) return false;
  authoredStore.items.delete(vnum);
  // The counter is untouched, which is the point of storing it: deleting the highest item must not
  // free its number for the next creation.
  saveAuthoredStore(authoredStore);
  itemCatalogue.delete(vnum);
  return true;
}

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
/** Phase 8¾'s clock. Starts one pulse out, so a freshly booted world stands still for ten seconds. */
let wanderCountdownMs = WANDER_PULSE_MS;

/**
 * A light handed to every character on join, for testing. Off unless `GAME_DEV_LIGHT` is set.
 *
 * Resolved once at boot and announced, because a server quietly handing everyone a lamp is exactly the
 * sort of thing that survives into a build nobody meant it to.
 */
const DEV_LIGHT = process.env.GAME_DEV_LIGHT ? lightSource(process.env.GAME_DEV_LIGHT) : undefined;

/**
 * How long a dropped thing lies there, overridable for testing. Off unless `GAME_DEV_DECAY_MS` is set.
 *
 * The sibling of {@link DEV_LIGHT} and for exactly its reason: the shipped clock is ten minutes, and
 * *watching* a thing decay — the warning, the line, the entity leaving every screen that held it —
 * otherwise means sitting still for ten of them. `GAME_DEV_DECAY_MS=4000` makes it a thing you can
 * see happen.
 *
 * **A rig, not a setting.** Like every other `GAME_DEV_*` switch it is default-off and announced at
 * boot, so a server quietly running a five-second floor is not a state that can happen unnoticed. A
 * value that is not a positive number is ignored rather than guessed at.
 */
const DEV_DECAY_MS = ((): number | undefined => {
  const raw = process.env.GAME_DEV_DECAY_MS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[dev] GAME_DEV_DECAY_MS=${raw} is not a positive number of milliseconds; ignored`);
    return undefined;
  }
  return parsed;
})();

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
if (DEV_DECAY_MS !== undefined) {
  console.log(`[dev] dropped things decay after ${DEV_DECAY_MS} ms rather than ${GROUND_DECAY_MS} (GAME_DEV_DECAY_MS)`);
}

/**
 * Phase 20 slice 2's test rig — a spell that exists so the *machinery* can be driven before any real
 * one does. `GAME_DEV_CAST` grants everyone knowledge of the dev bolt; off (the default), `cast`
 * answers honestly that you know no spells, which is true of every character until scrolls (slice 4)
 * and remains true of most until Phase 21's classes. A rig, **not** a spell: it costs nothing, it is
 * in no catalogue, and slice 3's registry replaces it.
 */
const DEV_SPELL = {
  id: 'dev_bolt',
  name: 'dev bolt',
  castMs: 3000,
  damage: { count: 2, sides: 4, bonus: 0 },
} as const;
const DEV_CAST = process.env.GAME_DEV_CAST !== undefined;
if (DEV_CAST) console.log(`[dev] everyone knows "${DEV_SPELL.name}" — cast ${DEV_SPELL.name} <target> (GAME_DEV_CAST)`);

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
 * The noticeboards' posts — Phase 23. One Map shared by `doRead` (the world reading) and the admin
 * router (the gods writing), loaded once; the router saves on every mutation, so a restart serves
 * yesterday's news rather than none.
 */
const boards = loadBoards();

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
 * The sky's own stream. Its own, for the reason the three above are their own: a rainstorm must not
 * shift what the next mob spawn rolls, and a busy night of combat must not change the weather.
 */
const weatherRng = makeRng(WORLD_SEED ^ 0x5c17a9);

/**
 * **The world clock** — game hours and weather, transcribed from Duris `weather.c`. See `clock.ts`
 * for the calendar, `weather.ts` for the climate model, `worldclock.ts` for the gates and the file.
 *
 * The owner asked, 2026-08-13, *"how long is this rain going to last?"*, and the honest answer was
 * *until you press R*. Now the world decides: an hour turns every 75 real seconds (`config.h:93`,
 * overridable), each zone's weather turns about every five game hours, and both survive a restart.
 *
 * Boot has two paths and the difference matters. With a saved file, the clock **resumes** — including
 * the downtime, at the rate now in force, because that is what the source's wall-clock-derived clock
 * does. Without one, it is seeded from `reset_time`'s own epoch (`db.c:762`), so a brand-new server
 * opens on the date a Duris player would have read.
 */
const savedWorldClock = loadWorldClock();
const gameClock = savedWorldClock
  ? GameClock.restore(savedWorldClock.clock, Date.now(), settings.gameHourMs)
  : GameClock.fresh(Date.now(), settings.gameHourMs);
const weather = new WorldWeather();
if (savedWorldClock) adoptZones(weather, savedWorldClock);
// Every loaded zone gets weather, whether or not anybody can stand outdoors in it: the source runs
// all hundred sectors regardless, the cost is a countdown per zone, and a zone with no sky simply
// never has anyone pass the gate to hear about it.
for (const zone of world.allZones()) weather.ensure(zone.id, gameClock.now(), weatherRng);
weather.relight(gameClock.now());
console.log(
  `[clock] ${clockBanner(gameClock.totalHours())} — ` +
    `${savedWorldClock ? 'resumed' : 'seeded from the source epoch'}, ` +
    `${Math.round(settings.gameHourMs / 1000)}s per game hour, ${weather.all().size} zones with weather`,
);

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
  const outcome = runReset(sim, clock, mobTemplates, itemCatalogue, countInstances, authoredOutfit, spawnRng, true);
  const dropped = placeResetObjects(outcome);
  console.log(
    `[pop] zone ${String(spawns.zone).padStart(4)} "${world.zone(spawns.zone)?.name ?? '?'}" — ` +
      `${String(outcome.spawned.length).padStart(4)} mobs from ${spawns.templates.length} templates, ` +
      `${outcome.doors} doors set, ${outcome.kitted} pieces of kit, ${dropped} objects; next reset in ${clock.lifespan} ticks ` +
      `(${Math.round((clock.lifespan * ZONE_TICK_MS) / 60_000)} min)` +
      // Only when it happened, so the ordinary line stays the shape it has always been. A den with more
      // bodies than standable floor still gets all of them — see `placeBody` — and this is the only
      // place that would ever say the world had to give something up to manage it.
      (outcome.crowded > 0 ? `; ${outcome.crowded} placed on a shared tile` : ''),
  );
}
if (loadedSpawns.length === 0) {
  console.log('[pop] no population files; the world is empty. Run `npm run worldgen`.');
}

/**
 * Things lost in the scenery, put where they were lost — `RoomScenery.conceals`.
 *
 * **Once, at boot, and never again.** A repop re-runs a zone's resets; this deliberately does not
 * ride along, because the needle is not population — it is a single object somebody dropped in a
 * bale, and a search that could be repeated every repop for the same needle would turn a discovery
 * into a farm. The floor is not persisted, so a restart is the only thing that puts it back, which
 * is the same grain as `do_search` clearing `ITEM_SECRET` until the next reset.
 *
 * **Dropped at the room's centre rather than on the prop**, which looks wrong and is not: a prop's
 * own tiles are solid, and an item lying inside them would be found and then be unreachable, since
 * picking it up needs somewhere to stand. The bale is where it *was* lost; the floor is where it
 * ends up once you have pulled it out.
 */
let concealed = 0;
for (const place of world.allPlaces()) {
  const grid = world.grid(place);
  for (const room of world.zone(place.zone)?.rooms ?? []) {
    for (const prop of room.scenery ?? []) {
      if (prop.conceals === undefined) continue;
      const template = itemCatalogue.get(prop.conceals);
      const origin = grid?.roomOrigins.get(room.id);
      if (!template || !origin) continue;
      const centre = roomCentre(origin);
      dropItem(
        ground,
        { ...instantiate(template), hidden: true },
        { roomId: room.id, place, x: tileCentre(centre.tx), y: tileCentre(centre.ty) },
        undefined,
        Number.MAX_SAFE_INTEGER,
      );
      concealed++;
    }
  }
}
if (concealed > 0) console.log(`[pop] ${concealed} thing(s) lost in the scenery, waiting to be searched out`);


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
 * Who may connect at all — DESIGN-accounts.md, protocol 23. The store loads every account at boot;
 * ownership of characters lives in it and nowhere else.
 */
const accounts = new AccountStore();

/**
 * A standing dev account, for the reload loop and the probe scripts. Off unless `GAME_DEV_ACCOUNT`
 * is set to `name:password`. Like every `GAME_DEV_*` switch: default-off, announced at boot, and a
 * rig rather than a setting — it creates the account if missing but will not overwrite a password,
 * because a switch that can silently rekey a real account is a foot-gun with no matching foot.
 */
const DEV_ACCOUNT = process.env.GAME_DEV_ACCOUNT;
if (DEV_ACCOUNT) {
  const colon = DEV_ACCOUNT.indexOf(':');
  const devName = colon > 0 ? DEV_ACCOUNT.slice(0, colon) : '';
  const devPassword = colon > 0 ? DEV_ACCOUNT.slice(colon + 1) : '';
  if (!devName || !devPassword) {
    console.warn(`[dev] GAME_DEV_ACCOUNT is not name:password; ignoring`);
  } else if (accounts.verify(devName, devPassword).ok) {
    console.log(`[dev] account "${devName}" standing (GAME_DEV_ACCOUNT)`);
  } else {
    const made = accounts.create(devName, devPassword);
    if (made.ok) console.log(`[dev] account "${devName}" created (GAME_DEV_ACCOUNT)`);
    else console.warn(`[dev] GAME_DEV_ACCOUNT "${devName}": ${made.reason} — not touching it`);
  }
}

/** Unbroken rest that buys one spent casting back — slice 2's memorization cadence. */
const MEMORIZE_SLOT_MS = 20_000;

/**
 * The authored quests — slice 7. Loaded once; `data/world/overrides/quests.json` is content, and a
 * checkout without it is a world where nobody has work for you, which is honest.
 */
const quests = loadQuests();
if (quests.size > 0) console.log(`[quests] ${quests.size} authored quest(s) loaded`);

/**
 * Seeds everything that hangs off the quest rows, from the quest rows. **A7q made this a function.**
 *
 * The giver is marked for the client, and armoured **only if its quest asked to be**: the view's badge
 * and combat's untouchable registry are seeded from the same map, so they cannot disagree. That was
 * three lines at boot until the admin panel grew an editor — and an editor that could write a quest
 * without running these lines would be an editor that mints a `?` over a mob the server has forgotten.
 *
 * **The two sets stopped being the same set on 2026-08-08**, when the owner corrected the rule he had
 * asked for that morning: *"the viscount for example should be killable."* Every giver is badged;
 * only a giver whose row carries `protectGiver` is immortal. The flag is OR-ed across a giver's rows
 * — see {@link QuestDef.protectGiver} — because a body cannot be half-immortal, and deciding it by
 * whichever row was read last would make the armour depend on the order of a file.
 *
 * So it is one function, called at boot and called again by {@link LiveOps.setQuests} on every write.
 * It reads `quests` rather than taking rows, which is the thing that makes it impossible to seed the
 * registries from a set the `quest` verb is not also reading.
 */
function seedQuestGivers(): { givers: Set<number>; protectedGivers: Set<number> } {
  const givers = new Set<number>();
  const protectedGivers = new Set<number>();
  for (const quest of quests.values()) {
    givers.add(quest.giver);
    if (quest.protectGiver === true) protectedGivers.add(quest.giver);
  }
  sim.setQuestGivers(givers);
  sim.setProtectedGivers(protectedGivers);
  // The union, not the giver set alone — the keepers' armour (owner, 2026-08-10) lives in the same
  // registry, and this function re-runs on every quest write: seeding givers alone would strip the
  // merchants the moment an operator saved a quest.
  setUntouchableVnums([...protectedGivers, ...shopsByKeeper.keys()]);
  return { givers, protectedGivers };
}
seedQuestGivers();
sim.setKeepers(shopsByKeeper.keys());
sim.setTrainers(trainersByVnum.keys());

/** Auth failures one socket may accrue before it is closed. A budget for typos, not dictionaries. */
const AUTH_ATTEMPT_BUDGET = 5;

type WireAuth = Extract<ClientMessage, { t: 'auth' }>;

/** The `auth` message against the account store: resume token first, then credentials. */
function resolveAuth(message: WireAuth): AuthResult {
  if (typeof message.resume === 'string' && message.resume.length > 0) {
    const resumed = accounts.resume(message.resume);
    return resumed ? { ok: true, account: resumed } : { ok: false, reason: 'session expired' };
  }
  const name = typeof message.account === 'string' ? message.account : '';
  const password = typeof message.password === 'string' ? message.password : '';
  return message.create === true ? accounts.create(name, password) : accounts.verify(name, password);
}

/**
 * The picker's contents. The join against character files happens here rather than in the account
 * store: ownership is the account's fact, level and recency are the character's, and only this
 * message needs both.
 */
function accountMessage(account: AccountRecord): Extract<ServerMessage, { t: 'account' }> {
  const stored = new Map(store.list().map((summary) => [summary.slug, summary]));
  const characters = account.characters.map((slug): CharacterSummary => {
    const summary = stored.get(slug);
    return {
      // Live cache first: a character created this boot has a name before it has a file.
      name: store.nameOf(slug) ?? summary?.name ?? slug,
      ...(summary?.level !== undefined ? { level: summary.level } : {}),
      ...(summary?.savedAt !== undefined ? { lastPlayed: summary.savedAt } : {}),
      ...(summary?.race !== undefined ? { race: summary.race } : {}),
      ...(summary?.class !== undefined ? { class: summary.class } : {}),
    };
  });
  return {
    t: 'account',
    account: account.name,
    characters,
    max: MAX_CHARACTERS_PER_ACCOUNT,
    resume: accounts.issueResume(account.slug),
  };
}

/**
 * May this account put this name on? Every refusal in DESIGN-accounts.md §5–§6 that needs a socket
 * lives here: someone else's character, a claim from off-loopback, a full account, a body already
 * walking. Success hands back the loaded record, whose stored name is canonical over the typed one.
 */
function admitCharacter(
  account: AccountRecord,
  requestedName: string,
  overLoopback: boolean,
): { ok: true; record: PlayerRecord } | { ok: false; reason: string } {
  let requested = requestedName.trim().slice(0, 24);
  const slug = slugify(requested);
  if (!slug) return { ok: false, reason: 'that name cannot be used' };
  const owner = accounts.ownerOf(slug);
  if (owner !== undefined && owner !== account.slug) {
    return { ok: false, reason: 'that character belongs to someone else' };
  }
  if (owner === undefined) {
    // Unowned. A brand-new name is anyone's to take; a name with history — a save on disk — is
    // claimable only over loopback (§6). Today that is the operator adopting their own flotsam;
    // the day the bind opens it is nobody remotely, and assignment becomes the admin API's job.
    if (store.hasStored(slug)) {
      if (!overLoopback) return { ok: false, reason: 'that character is not claimable from here' };
    } else {
      // A mint, and only a mint, passes the name law (owner's rule 2026-08-08 — shared/names.ts).
      // Saves that predate the law are grandfathered above: orphaning aldric11 over its digits
      // would cost more than the digits do.
      const problem = characterNameProblem(requested);
      if (problem) return { ok: false, reason: problem };
      requested = canonicalCharacterName(requested);
    }
    const claim = accounts.claim(account.slug, slug);
    if (!claim.ok) return { ok: false, reason: claim.reason };
  }
  for (const online of records.values()) {
    if (slugify(online.name) === slug) {
      return { ok: false, reason: 'that character is already in the world' };
    }
  }
  return { ok: true, record: store.load(requested) };
}

/**
 * **A8 slice 3: any Place whose grid moved while the server was down loses its maps here.**
 *
 * The live editor clears as it goes, so this only ever fires after somebody hand-edited
 * `rooms-authored.json` — or after a `npm run worldgen` that changed a harvested zone's own extent,
 * which is the case nobody would think to check. Either way the saved bitsets are indexed against a
 * grid that no longer exists and are **wrong rather than incomplete**, so they go before the first
 * player can connect and be shown fog in the wrong places.
 *
 * The overlay is rewritten afterwards so the next boot compares against the grid that now exists.
 * That is a write to a git-tracked file at start-up, which is exactly the thing to avoid doing
 * casually — it happens only when something really did change, and saying so in the log is the point.
 */
if (world.staleExtents.length > 0) {
  for (const place of world.staleExtents) {
    const cleared = store.forgetPlace(place);
    console.log(
      `[world] ${placeKey(place)} has been resized since the overlay was written — ` +
        `${cleared} explored map(s) cleared, because every tile index in them is measured from a ` +
        `corner that has moved`,
    );
    world.recordExtent(place);
  }
  saveAuthoredRooms(world.authoredRooms);
}

/**
 * Which other entities each connected player is currently being shown.
 *
 * The client holds a list of entities and mutates it with `entityEnter`/`entityLeave`, so the server
 * has to remember what it already said. Every gate folds into this one set — `visibleEntities` is
 * where they are resolved, and this is the answer it gave last time. Walking out of someone's
 * torchlight therefore produces a plain `entityLeave`, the same message as walking out of their room,
 * and the client needs no new concept for either.
 *
 * It is also **the audience index**, and that became worth saying on 2026-08-13: since visibility
 * reaches one open crossing beyond the room, "who should be told this entity changed" is no longer
 * answerable by `playersIn(actor.roomId)`. It is answerable by exactly this map, without a room lookup
 * — see {@link watchersOf}.
 */
const watching = new Map<EntityId, Set<EntityId>>();

/**
 * Every connected player currently being shown `id` — the audience for a change to an entity that has
 * neither entered nor left.
 *
 * Reads the watch sets rather than the room, which is both cheaper (one pass over the connected
 * players, no room graph) and *exactly* right: an `entityUpdate` or a turn is only ever meaningful to
 * somebody who already has the entity, whatever rule put it there. The room-based version silently
 * became wrong the day a body could be visible from the room next door.
 */
function* watchersOf(id: EntityId): Iterable<Player> {
  for (const [observerId, shown] of watching) {
    if (!shown.has(id)) continue;
    const observer = sim.player(observerId);
    if (observer) yield observer;
  }
}

/**
 * Who is walking behind whom — Phase 18. See `following.ts`.
 *
 * Live state with no save file behind it, deliberately: a train is a thing two people are doing right
 * now, and restoring one on login would put somebody behind a leader who logged off yesterday.
 */
const following = newFollowing();

/**
 * Who is grouped with whom, and who has consented to whom — Phase 18. See `grouping.ts`.
 *
 * Live state with no save file, for the same reason `following` has none and one more: consent is
 * something you gave a person who is standing there, and restoring it on login would let somebody
 * enrol a character whose player has not seen them since yesterday.
 */
const grouping = newGrouping();

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
function actToRoom(
  actor: Player,
  channel: LogChannel,
  render: (who: string) => string,
  /**
   * V3's extra fields, when the line is something somebody *said*.
   *
   * Passed through rather than added unconditionally: an `act` line is usually a thing that happened
   * — a door opening, somebody standing up — and `from` on one of those would invite a renderer to
   * draw a speech bubble containing a door.
   */
  extra?: { readonly from: EntityId; readonly speech: string },
): void {
  for (const line of actLines(actor, sim.playersIn(actor.roomId), canSee, render)) {
    send(line.to, { t: 'log', channel, text: line.text, ...extra });
  }
}

/**
 * The rooms a peek is currently showing this player — **and the one place a stale set is dropped.**
 *
 * Reading clears, which is deliberate. `Player.revealed` invalidates by comparing where it was made
 * against where the character is standing, and that alone would have a hole: walk out of the room and
 * back, and the old set matches again, so a reveal you earned minutes ago and walked away from would
 * light up without looking. Clearing it the first time it reads stale closes that, and keeps the whole
 * rule in one function rather than at every site that can move a body.
 *
 * Empty is the common case by a long way — nobody has looked anywhere — so it costs a comparison.
 */
function revealedRooms(player: Player): ReadonlySet<RoomId> {
  const shown = revealShownIn(player.revealed, player.roomId);
  // Dropped, not merely ignored — see the note above on walking back.
  if (shown.size === 0 && player.revealed) player.revealed = undefined;
  return shown;
}

/**
 * The room-graph lookups the crossing rules need — one construction, so the entity feed and the
 * notification fan-out cannot drift apart about what "open" means. `peekDeps`' own pattern.
 *
 * `world.doorway` rather than `exit.door`, exactly as `stepRoom` does it: the 5 exits in the shipped
 * world that face a door without declaring one share the same carved strip of tiles, so a rule reading
 * only its own side would make one of them a wall from one room and a window from the other.
 */
function crossingDeps(): CrossingDeps {
  return {
    roomOf: (id: RoomId) => sim.room(id),
    hasDoor: (from: RoomId, dir: Direction) => world.doorway(from, dir) !== undefined,
  };
}

/**
 * Everything `observer` can currently see: the bodies, and the things on the floor light falls on.
 *
 * **The single authority on entity presence.** Every gate is resolved here, so no caller has to
 * remember to apply one — and, more importantly, the room view and the incremental
 * `entityEnter`/`entityLeave` diff are built from the same list. Two implementations would disagree
 * the moment one of them learned about a new kind of entity, which is exactly what ground pickups were
 * and exactly what the room next door is.
 *
 * **Bodies reach one open crossing out; the floor does not.** Since 2026-08-13 the actor sources are
 * three (see {@link visibleBodies}), but pickups, corpses and dropped items below are still
 * `observer.roomId` and a lit tile — deliberately. The owner's ask was about *what is standing in the
 * next room*; a dagger on a floor you are not in is not something a camera makes obvious, and offering
 * one would put `get` in the position of refusing a thing the screen had just advertised. It also keeps
 * the item stores' own room-scoped `entityLeave` sites correct without a fan-out: nobody outside the
 * room ever watches an item.
 */
function visibleEntities(observer: Player): EntityView[] {
  const grid = world.grid(observer.place);
  if (!grid) return [];

  // **All three body sources, unioned and de-duplicated in one place** — `nearby.ts` owns the rules and
  // this owns the lookups. The three are: your own room through your own light (`canSee`, and the only
  // one whose bodies stay *nameable*); whatever a `look <direction>` is still showing; and — the
  // owner's ruling of 2026-08-13 — every room sharing an **open crossing** with yours that lights
  // itself. See that module's header for the gauntlet and for why reach does not widen with sight.
  //
  // `actorsIn`, not `playersIn`: presence is about what is standing here, and a mob is standing here.
  // `canSee` already asked the right question of any body, so a sentry is hidden by unlit ground and
  // revealed by a torch through the code that was already doing it for players.
  const out: EntityView[] = visibleBodies(observer, {
    ...crossingDeps(),
    actorsIn: (id: RoomId) => sim.actorsIn(id),
    viewOf: (actor: Actor) => sim.viewOf(actor),
    canSee: (subject: Actor) => canSee(observer, subject),
    revealed: revealedRooms(observer),
  });

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
  for (const entry of visibleItemsIn(ground, observer.roomId)) {
    if (!observer.visible.has(tileIndexAt(grid, entry.x, entry.y))) continue;
    const template = templateOf(entry.item);
    // A7d: the authored art id, when there is one, so a dagger on the floor is a dagger rather than
    // the generic weapon glyph. Read from the same template the type comes from.
    out.push(groundViewOf(entry, template?.type, template?.container !== undefined, template?.art));
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

  // The diff itself is {@link membershipDiff}, pure and in `nearby.ts`, so that "a body visible before
  // and visible now produces no message" is a tested claim rather than an inference from these ten
  // lines. Widening the visible set to the room next door is exactly the change that could have
  // broken it, and it broke nothing precisely because both halves read one list.
  const { entered, left, now } = membershipDiff(shown, visibleEntities(observer), observer.id);
  for (const entity of entered) send(observer.id, { t: 'entityEnter', entity });
  for (const id of left) {
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
  // Themselves first — `syncTurn`'s own documented gap, met a second time on the kit path (owner's
  // shield, 2026-08-07): a character is never in their own `watching` set, so a `wear` reached
  // every onlooker in the room except the wearer, whose body kept its old clothes until some
  // membership event happened to rebuild the entity list. The panel doll updated (it rides `self`),
  // which made the body's silence read as an art bug rather than a missing message.
  if (isPlayer(actor)) send(actor.id, { t: 'entityUpdate', entity: view });
  // `watchersOf`, not `playersIn(actor.roomId)`: since 2026-08-13 a body can be drawn from the room
  // next door, and a health bar that only updated for the room it stands in would leave a fight one
  // crossing away frozen on screen at the hit points it had when it came into view.
  for (const observer of watchersOf(actor.id)) send(observer.id, { t: 'entityUpdate', entity: view });
}

/**
 * Everyone whose view of `roomId` could have changed: the players standing in it, **and the players
 * standing in a room that can see into it** across an open crossing.
 *
 * The fan-out is the other half of the 2026-08-13 ruling, and it is here rather than at the ~25 call
 * sites for the reason `visibleEntities` is a single authority: a body appearing in a room now changes
 * what is drawn in up to five rooms, and a site that remembered the first and forgot the rest would
 * leave a sprite standing in a room its owner had walked out of. Every existing caller — a repop, a
 * death, a spilled corpse, a flee, a `part` — is correct for free.
 *
 * **One scan, not five.** `playersIn` walks every actor in the world, so calling it per neighbour would
 * multiply the cost of the tick's hottest bookkeeping by the branching factor. The room set is built
 * first (at most four lookups deep) and the actors are walked once against it.
 */
function observersNear(roomId: RoomId): Player[] {
  const rooms = new Set<RoomId>([roomId, ...roomsSeeingInto(roomId, crossingDeps())]);
  const out: Player[] = [];
  for (const player of sim.allPlayers()) if (rooms.has(player.roomId)) out.push(player);
  return out;
}

/**
 * Re-evaluates every observer who can see into a room — see {@link observersNear}.
 *
 * `except` is for the one caller that must not be included: the player who has *just arrived* somewhere
 * is about to be sent a whole `room` view, which re-seeds their watch set wholesale. Before the
 * fan-out existed they were simply no longer in the room being synced and the question never came up;
 * now they can be one of its neighbours, and diffing them here against a set `describeRoom` is a
 * moment away from replacing would spend an `entityLeave` on a body they are about to be re-sent.
 */
function syncEntitiesIn(
  roomId: RoomId,
  leaving?: { readonly id: EntityId; readonly dir: Direction },
  except?: EntityId,
): void {
  for (const observer of observersNear(roomId)) {
    if (observer.id === except) continue;
    syncEntities(observer, leaving);
  }
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
  // Gated on what each observer can actually see, like every other entity message: a mob turning in the
  // dark is nobody's business, and telling them would put its position on the wire. `watchersOf` *is*
  // that gate, and asking it directly is what makes the answer independent of which room the watcher
  // happens to be standing in — see the note on {@link watching}.
  for (const observer of watchersOf(actor.id)) send(observer.id, { t: 'entityMoved', moves: [move] });
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

/**
 * Ships the map of where this character has been — V4.
 *
 * **On arrival rather than on request**, and it is small enough that the choice is free: the loaded
 * world is 23 Places, so even a character who has walked all of it is a few hundred bytes. Pushing it
 * means the client can open the view instantly instead of waiting a round trip, and there is no
 * request message for a hostile client to spam.
 *
 * Arrival is also exactly when the answer can change. An edge needs both of its Places visited, and
 * visiting one is a Place change — so nothing that happens *within* a Place can add a node or a line.
 */
function sendPlaces(player: Player): void {
  const record = records.get(player.id);
  if (!record) return;
  const graph = buildPlaceGraph(world, record, player.place);
  send(player.id, { t: 'places', nodes: graph.nodes, edges: graph.edges, here: player.place });
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
  //
  // **And the room next door**, since 2026-08-13: the far-room light gate counts a torch carried *in*
  // the far room, so this character striking one is what makes them and everyone beside them visible
  // to an observer one open crossing away — and their torch guttering is what puts that room back into
  // darkness. Nothing else in the loop is keyed on it: a character who lights a torch on the spot has
  // moved nothing, which is the same gap `relit` itself exists to close, one room further out.
  syncEntitiesIn(player.roomId);
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
  store.setProgress(record, player.level, player.experience, player.maxHp, player.damageBonus);
  // Slice 2: the spent castings ride the same save — a relog must not be a free memorization.
  store.setSpentSlots(record, player.spentSlots);
  store.setQuests(record, player.quests);
  store.setEquipped(record, player.equipped);
  // The bag too, since 15b. Same fact of the same kind: what a character has is theirs, and losing it
  // to a disconnect would teach players not to carry anything.
  store.setInventory(record, player.inventory);
  // And the coin, since 15c. Money that evaporated on logout would teach players to spend it before
  // quitting, which is a mechanic nobody designed.
  store.setPurse(record, player.purse);
  // Phase 19, and the floor is passed rather than the level because the *store* has no business
  // deriving one: only values above it are worth a row, which is what keeps the file sparse.
  store.setSkills(record, player.skills, skillFloor(player.level));
  // The hair slice, and it rides here rather than at the command for the reason every other line in
  // this function does: `afterKitChange` is the one seam a change of any kind passes through, so a
  // second save call at the command would be a second thing to remember.
  store.setHair(record, player.hair);
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
  // **Who they are comes back before anything read off it.** Phase 21: `refitCombat` at the bottom
  // folds the strength and dexterity modifiers, so the identity has to be on the player before that
  // one rebuild runs — the same before-the-derivation ordering the kit gets one line down.
  player.identity = record.identity;
  // And what they look like. `undefined` here is a save written before the hair slice *and* a
  // character who has simply never typed the command — one case, on purpose, and `appearanceOf` reads
  // it as "hash my name for a default" rather than as "bald". Nothing derives from it, so it may sit
  // anywhere in this function; it sits beside the identity because that is what it is.
  player.hair = record.hair;
  // **The kit comes back before anything derived from it.** A stored character keeps what they were
  // wearing; only a genuinely new one rolls a fresh kit, which is what stops a reconnect being a
  // reroll. `combat` is rebuilt from it below rather than stored, because armour class is a
  // derivation and storing derivations is how the two drift.
  if (record.equipped && Object.keys(record.equipped).length > 0) player.equipped = record.equipped;
  // And the bag. Restored unconditionally when present, *including an empty one*, because an empty bag
  // with a raised capacity is still a fact about the character — see `PlayerStore.save`.
  // Assigned directly rather than through `sim.setInventory`, and it is the one place that is correct:
  // `refitCombat` and `syncHeldLight` both run at the end of this function, so re-deriving here would do
  // the same work twice on every login. A restored bag holding a lantern still lights the character —
  // that is what the `syncHeldLight` call at the bottom is for.
  if (record.inventory) player.inventory = record.inventory;
  if (record.purse) player.purse = record.purse;
  // Phase 19. **Before the level is read below and before `refitCombat` at the end**, and both orders
  // matter: what a skill is worth depends on the level's floor, and the attack bonus is folded from the
  // skill. A record with none restores an empty map, which is not "no skills" — every skill is at the
  // floor, derived.
  if (record.skills) player.skills = new Map(record.skills);

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
    // Phase 16, and the same migration `maxHp` gets one line up: a record written before 16b has no
    // stored bonus, and handing it zero would put a level-40 veteran back in the world hitting like a
    // novice. The band midpoints are what they would have rolled on average. Anybody levelling from
    // here rolls for real — see `levelUpIfEarned`.
    player.damageBonus = progress.damageBonus ?? expectedDamageBonus(progress.level);
  }

  // Slice 2: the pool and the spent castings follow the identity — after the level above (the
  // pool scales with it) and before `restoreVitals` runs outside, whose mana wound is subtracted
  // from the maximum this derives.
  player.spentSlots = new Map(record.spentSlots);
  player.quests = new Map(record.quests);
  if (record.identity) {
    const spec = CLASSES[record.identity.class];
    const mod = spec.casting
      ? abilityMod(spec.casting.kind === 'arcane' ? record.identity.scores.int : record.identity.scores.wis)
      : 0;
    player.maxMana = maxManaFor(record.identity.class, mod, player.level, RACES[record.identity.race].manaFactor);
    player.mana = Math.min(player.mana, player.maxMana);
  }

  refitCombat(player);
  // **And the light the restored kit is holding — found live 2026-08-06.** A character who logged out
  // wielding a redwood torch logged back in at the bare radius of 2 with the torch still in their hand,
  // and stayed there until they touched their kit. Phase 5b fixed this for a *finite* light by persisting
  // its burn as an affect; an **unlimited** one has no affect to persist by design (`syncHeldLight`: *"one
  // that never goes out is a standing fact about your equipment and needs no timer"*), so the only thing
  // that can restore it is re-deriving it from the kit — which every other kit change already does
  // through `afterKitChange`, and login was the one path that did not.
  sim.syncHeldLight(player);
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
  const result = applyExperience(
    progressRng,
    {
      level: player.level,
      experience: player.experience,
      maxHp: player.maxHp,
    },
    hpLevelBonus(player.identity),
  );
  if (result.gained === 0) {
    player.experience = result.experience;
    return;
  }

  player.level = result.level;
  player.experience = result.experience;
  player.maxHp = result.maxHp;
  player.hp = Math.min(player.maxHp, player.hp + result.hitPointsGained);

  // **Rolled here and nowhere else** — §8's rule, and hit points' rule before it: once, at the level-up,
  // then stored. A bonus derived at login is a bonus a player rerolls by reconnecting. Every level
  // crossed is rolled, so two levels at once pay both bands.
  let damageGained = 0;
  for (let l = before + 1; l <= player.level; l++) damageGained += rollDamageGain(progressRng, l);
  player.damageBonus += damageGained;

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
      `, with ${result.hitPointsGained} more hit point${result.hitPointsGained === 1 ? '' : 's'}` +
      (damageGained > 0 ? ` and ${damageGained} more damage a blow` : '') +
      '.',
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
/**
 * The sky over this character, as they are standing now — `{t:'sky'}`.
 *
 * Per player rather than broadcast because weather is per zone: two people in different zones
 * legitimately see different skies, which is `weather.c:872`'s hundred sectors surviving the port.
 */
function sendSky(player: Player): void {
  send(player.id, { t: 'sky', view: skyFor(gameClock, weather.get(player.place.zone)?.conditions) });
}

/**
 * One tick of the world clock: hours, weather, and everything either of them makes somebody hear.
 *
 * The two halves run on the same delta but on different edges. **Hours** fire on the integer
 * crossing — the astral line, the re-lighting of every zone, the hourly flush to disk. **Weather**
 * fires on its own per-zone countdown, roughly every five game hours (`weather.c:778`), independently
 * per zone exactly as the source's hundred separate events do.
 *
 * Sky pushes are collected rather than sent as they arise: an hour that turns in the same tick as a
 * zone's weather would otherwise send the same snapshot twice.
 */
function advanceWorldClock(): void {
  const hoursDelta = TICK_MS / gameClock.msPerHour();
  const crossed = gameClock.advance(TICK_MS);
  const time = gameClock.now();
  const resync = new Set<Player>();

  if (crossed.length > 0) {
    // A zone that did not exist at boot — one the panel created (A8d) — gets its weather here rather
    // than lazily when somebody walks into it. On the world's own clock, so the seeded stream is
    // consumed in an order a player's movements cannot change: `CLAUDE.md` rule 3 is about being able
    // to reproduce a world, and a roll whose timing depends on who logged in is not reproducible.
    for (const zone of world.allZones()) weather.ensure(zone.id, time, weatherRng);
    // Before the astral line, so a client that redraws on the message is told the right ambient
    // light for the hour that just began rather than the one that just ended.
    weather.relight(time);
    for (const hour of crossed) {
      const line = astralMessageAt(hour);
      if (line === undefined) continue;
      for (const player of sim.allPlayers()) {
        const room = world.locate(player.roomId)?.room;
        // `hearsAstral`, not `hearsWeather`: dawn breaks over a dark moor. See `worldclock.ts`.
        if (!room || !hearsAstral(room, player.status)) continue;
        send(player.id, { t: 'log', channel: 'room', text: line });
      }
    }
    for (const player of sim.allPlayers()) resync.add(player);
  }

  for (const change of weather.advance(hoursDelta, time, weatherRng)) {
    for (const player of sim.allPlayers()) {
      if (player.place.zone !== change.zone) continue;
      resync.add(player);
      const room = world.locate(player.roomId)?.room;
      if (!room || !hearsWeather(room, player.status)) continue;
      for (const line of change.messages) send(player.id, { t: 'log', channel: 'room', text: line });
    }
  }

  for (const player of resync) sendSky(player);

  // Once a game hour — seventy-five seconds by default, a small file, and the most a crash can cost
  // is an hour of drift the resume would have added anyway. Duris flushes its own dirty state on the
  // same edge (`weather.c:109`).
  if (crossed.length > 0) saveWorldClock(gameClock, weather, Date.now());
}

function announceAffect(event: AffectEvent): void {
  // Mobs run affects through the same expiry pass — that is the point of one list and one map — but
  // there is nobody behind a mob to read a line. Asked rather than assumed, so the day a mob's expiry
  // *should* say something out loud ("the ogre's rage subsides") this is where it is noticed.
  if (!isPlayer(event.actor)) return;
  const player = event.actor;

  // Slice 5: a lapsed buff changes numbers the profile folds, and the expiry pass cannot know that
  // (`chainFrom`'s own comment sends the duty here). Refit before the sentence, so a player who
  // reads "less protected" and checks their sheet finds the sheet already agreeing.
  if (event.kind === 'expired' && (event.affect.type === 'armor' || event.affect.type === 'bless')) {
    refitCombat(player);
  }

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
 * What this body's blow is called — **V7**, and the one place the two mappings meet.
 *
 * A **player** swings what is in their main hand, so the verb comes from the weapon's class
 * (`get_weapon_msg`); empty-handed, `weaponClass` is `undefined` and the source's own default is a punch.
 * A **mob** with no weapon swings itself, so the verb comes from its **race** (`GetFormType`) — which is
 * why the template carries the code and why a spider will sting the day there is a spider.
 *
 * Mobs are checked for a weapon **first**, because a guard holding a sword slashes: `equipped` is real on
 * a mob since 15c's kit harvest, and `reset.ts` puts 275 pieces of it on IceCrag alone. Only a bare-handed
 * creature falls through to its race, which is exactly the branch the source takes
 * (`msg = weapon ? get_weapon_msg(weapon) : ch->only.npc->attack_type`).
 */
function attackTypeOf(actor: Actor, hand: 'mainHand' | 'offHand' = 'mainHand'): AttackType {
  // `equipped` lives on `Player` and `Mob` rather than on `Actor`, so the narrowing is the price of the
  // base type staying small. Every actor is one or the other; a corpse is not an actor.
  // **The hand is a parameter since Phase 21**, because the off hand's blow is the off hand's weapon:
  // a swordsman with a dagger in the other fist slashes and then stabs, and one verb for both would
  // undo the point of the table. An empty off hand falls through to the punch, exactly as an empty
  // main hand does — and never reaches here, since nothing schedules a blow from an empty hand.
  const weapon = isPlayer(actor) || isMob(actor) ? actor.equipped[hand] : undefined;
  // Instance first, template as the heal: an instance minted before its template knew its class —
  // Brynn93's own Windsong, looted the hour before the class existed — reads the catalogue's answer
  // instead of punching for ever. The copy-down at `instantiate` remains the rule; this is the
  // back-fill for saves that predate a field.
  if (weapon) return attackTypeForWeapon(weapon.weaponClass ?? templateOf(weapon)?.weaponClass);
  if (isMob(actor)) return attackTypeForRace(mobTemplates.get(actor.vnum)?.race);
  return attackTypeForWeapon(undefined);
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
  // **V7: what the blow is called.** Owner's ask (2026-08-06), and it is `attack_hit_text[]` —
  // a weapon's verb from its class (`get_weapon_msg`), an unarmed body's from its race
  // (`GetFormType`). See `attacks.ts` for why those are two mappings and must not be merged.
  //
  // **Only on a hit.** A miss keeps "miss", because you do not slash and miss — the verb describes the
  // blow that landed, which is what the table is for. A fumble keeps its own phrase for the same reason.
  // **Phase 21: the off hand swings its own weapon**, so the verb comes from that hand's blade.
  const hand = outcome.offHand ? 'offHand' : 'mainHand';
  const verbs = ATTACK_VERBS[attackTypeOf(attacker, hand)];
  // **And the line says which hand threw it.** The source's live combat prints nothing to
  // distinguish the second blow — its off-hand call is `hit()` again — so the wording is taken from
  // where Duris does name the hand: `common.c:322`'s `<secondary weapon>` and `actobj.c:4923`'s
  // *"your secondary hand"*, in the owner's own shorter word. Cyan, because the two colours already
  // spoken for are the critical's yellow and the machinery's grey, and a second blade landing is
  // neither — it is the mechanic working, and it should be visible without shouting.
  const offHand = outcome.offHand ? '&+c(off hand)&N ' : '';
  // The two rolls with rules attached get the two colours a MUD reserves for them: a critical is
  // bright yellow and a fumble is the same dim grey as the machinery, because a fumble *is* the
  // absence of an event. Everything between is uncoloured — if every line shouted, none would.
  //
  // **Both persons are built up front rather than one being patched into the other.** The old version
  // rendered the third-person sentence and then ran a regex over it to turn "You hits" into "You hit",
  // with the four verb forms and their colour codes in the pattern — which worked for four fixed verbs
  // and could not survive eleven. Handing the sentence the pair it needs is what the regex was
  // approximating, and it is shorter.
  const form = (person: 'second' | 'third'): { readonly hit: string; readonly miss: string } => {
    const struck = verbs[person];
    return {
      hit: outcome.critical ? `&+Ycritically ${struck}&N` : struck,
      miss: outcome.fumble
        ? `&+Lfumble${person === 'third' ? 's' : ''} against&N`
        : `miss${person === 'third' ? 'es' : ''}`,
    };
  };

  const line = (who: string, whoPlain: string, whom: string, person: 'second' | 'third'): string => {
    const said = form(person);
    // **Phase 19 slice 2: a defended blow reads from the defender's side.** Every other line in this
    // function is *the attacker did something to the target*; a dodge is the one event where the
    // interesting party is the one who did not get hit, and the source's own sentence is built that way
    // (`victDodge` says *“you dodge X's attack”*, not *“X misses you”*). So the two names swap places
    // and the person swaps with them — which is why this is a branch and not a third `said` verb.
    if (outcome.defended) {
      const { kind, ease } = outcome.defended;
      const second = person === 'second';
      // `person` describes the *attacker*; the defender's person is its own question, answered by who
      // the defender is to this observer — `whom === 'you'` — and not by inverting the attacker's.
      // The inversion was right twice and wrong once, which is why it survived its drive: attacker
      // ("...misses being hit by your attack") and target ("You narrowly miss being hit...") both
      // read correctly, and only a *bystander* — attacker third, defender third — got "the kobold
      // shaman narrowly miss", the owner's sighting during the rescue drive (2026-08-07).
      const verb = defenceVerb(kind, ease, whom === 'you');
      // **`whoPlain`, not `who`.** The attacker's name arrives capitalised because every other sentence
      // here starts with it; in this one it is mid-sentence — *"You parry a kobold's attack"* — and
      // "A kobold's" would be wrong. Uncapitalising the string would be worse, since a player's name is
      // a proper noun, so the caller hands over both forms.
      return `${whom === 'you' ? 'You' : capitalise(whom)} ${verb} ${second ? 'your' : `${whoPlain}'s`} attack. ${offHand}${roll}`;
    }
    return outcome.hit
      ? `${who} ${said.hit} ${whom} for ${outcome.damage} damage. ${offHand}${roll}`
      : `${who} ${said.miss} ${whom}. ${offHand}${roll}`;
  };

  // Per recipient, gated on sight, like every other line about an entity — §4.10's warning about
  // pre-rendered strings is exactly this shape of message.
  for (const observer of sim.playersIn(attacker.roomId)) {
    const seesAttacker = observer.id === attacker.id || (watching.get(observer.id)?.has(attacker.id) ?? false);
    const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
    if (!seesAttacker && !seesTarget) continue;
    const who = observer.id === attacker.id ? 'You' : seesAttacker ? capitalise(attacker.name) : 'Something';
    const whom = observer.id === target.id ? 'you' : seesTarget ? target.name : 'something';
    // Second person for the one swinging, third for everyone watching — chosen here rather than
    // patched in afterwards. See `form` above for what that replaced and why it had to go.
    const plain = seesAttacker ? attacker.name : 'something';
    const text = observer.id === attacker.id
      ? line('You', 'your', whom, 'second')
      : line(who, plain, whom, 'third');
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
      // The two that were declared and unproduced since Phase 11 now have a producer, which is the whole
      // shape this list was written for: *“they are declared and unproduced”* rather than absent.
      outcome: outcome.defended
        ? outcome.defended.kind === 'dodge'
          ? 'dodged'
          : 'parried'
        : outcome.critical
          ? 'critical'
          : outcome.fumble
            ? 'fumble'
            : outcome.hit
              ? 'hit'
              : 'miss',
      // Protocol 22: which motion the blow plays, from the same table the verb reads — pierce, sting
      // and bite lunge, everything else swings. On misses too: you swing and miss. **And from the
      // hand that threw it**, so an off-hand dagger lunges while the sword above it slashed; the
      // wire needs no new field for that, because `wearing` has carried the off-hand item since
      // Phase 16 and the animation is chosen from the same weapon the verb was.
      swing: SWING_ANIMATION[attackTypeOf(attacker, hand)],
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
 * Slice 5's arrival bookkeeping, identical on the typed and continuous paths.
 *
 * The **entry shore** is written when a dry room is left for a swimming one — the owner's anti-ferry
 * rule: a drowned corpse washes up where its owner went in, so drowning is never a free crossing.
 * And a stroke swum without a boat **notches**, at the deliberate-act rate every verb uses: swimming
 * is the one skill you practise by going somewhere.
 */
function noteWaterCrossing(player: Player, from: RoomId): void {
  const here = sim.room(player.roomId);
  if (!here || SECTOR_REQUIRES_MOVEMENT[here.sector] !== 'swim') return;
  const shore = sim.room(from);
  if (shore && SECTOR_REQUIRES_MOVEMENT[shore.sector] !== 'swim') player.lastShore = from;
  if (!sim.hasSwimAid(player)) notchSkill(player, 'swim', OFFENSIVE_NOTCH_CHANCE);
}

/** How often drowning collects, and what it takes per beat. Data, beside the clocks it joins. */
const DROWN_BEAT_MS = 2000;
const drowningFor = new Map<EntityId, number>();

/**
 * Deep water collecting from anyone treading it on an empty pool — **what drowning is** (owner,
 * 2026-08-07): not a breath bar, but exhaustion with consequences. A swimmer with movement left is
 * merely tired; at zero, every second beat costs a sixteenth of their health until they reach ground,
 * find a boat, or die into the ordinary death — `reapPlayer`, corpse and all, where the wash-ashore
 * rule takes over. Mercy does not apply: mercy protects a downed body from *blows*, and water is not
 * swinging at anyone. A body the current is drowning keeps drowning until somebody gets it out.
 */
function advanceDrowning(): void {
  // The event switch suspends the whole economy of exhaustion, drowning included — free movement
  // means the pool never empties, and a beat that could still kill off a stale zero would make the
  // switch a lie for exactly the player it was thrown for. See `settings.ts`.
  if (!settings.movementCosts) return;
  for (const player of sim.allPlayers()) {
    const room = sim.room(player.roomId);
    const treading =
      room !== undefined &&
      SECTOR_REQUIRES_MOVEMENT[room.sector] === 'swim' &&
      player.move <= 0 &&
      player.status !== 'dead' &&
      !sim.hasSwimAid(player);
    if (!treading) {
      drowningFor.delete(player.id);
      continue;
    }
    const held = (drowningFor.get(player.id) ?? 0) + TICK_MS;
    if (held < DROWN_BEAT_MS) {
      drowningFor.set(player.id, held);
      continue;
    }
    drowningFor.set(player.id, 0);

    const beat = Math.max(3, Math.ceil(player.maxHp / 16));
    player.hp = Math.max(HP_DEAD_BELOW - 1, player.hp - beat);
    send(player.id, { t: 'log', channel: 'combat', text: '&+BYou are drowning!&N' });
    actToRoom(player, 'combat', (who) => `${who} thrashes in the water, drowning!`);
    sim.refreshStatus(player, player.fighting !== undefined);
    syncEntityState(player);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    // The tick's own reap pass watches `vitalsChanged`, which this damage is not part of — so the
    // death a beat causes is resolved here, by the same door every other death goes through.
    if (player.status === 'dead') reapPlayer(player);
  }
}

/**
 * The water gives the body up — the placement half of `shoreFor`, which owns the rules and the two
 * owner decisions behind them. In-Place only: the lookup refuses rooms on another grid, so a corpse
 * never crosses a level or a zone by drifting, and its coordinates stay on the grid it died over.
 */
function comeAshore(corpse: Corpse, entryShore?: RoomId): void {
  const sank = sim.room(corpse.roomId);
  if (!sank || SECTOR_REQUIRES_MOVEMENT[sank.sector] !== 'swim') return;

  const shore = shoreFor(
    corpse.roomId,
    (id) => {
      const room = sim.room(id);
      if (!room) return undefined;
      // Same Place only — a drift that changed grids would leave x/y meaning another map's tiles.
      return room.zone === sank.zone && room.pos.z === sank.pos.z ? room : undefined;
    },
    entryShore,
  );
  if (shore === undefined || shore === corpse.roomId) return;

  const origin = world.grid(corpse.place)?.roomOrigins.get(shore);
  if (!origin) return;
  const rest = arrivalTile(origin, undefined);
  const sankIn = corpse.roomId;
  corpse.roomId = shore;
  corpse.x = tileCentre(rest.tx);
  corpse.y = tileCentre(rest.ty);

  syncEntitiesIn(sankIn);
  syncEntitiesIn(shore);
  for (const observer of sim.playersIn(shore)) {
    send(observer.id, {
      t: 'log',
      channel: 'room',
      text: `&+bThe waters give up ${corpseName(corpse)}&N&+b, washed ashore.&N`,
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
  sim.setInventory(player, emptyInventory(player.inventory.capacity));
  // A death in deep water surrenders the body to it — to the shore its owner swam in from, which is
  // what keeps the bag from crossing an ocean for the price of dying (the owner's ferry rule).
  comeAshore(corpse, player.lastShore);

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
  //
  // The corpse line reads `corpse.roomId`, not `diedIn`, and the drive is why: a drowned body has
  // already washed ashore by here, and "your corpse lies where you fell" naming open water was the
  // one lie in an otherwise honest death. Where the two differ, the water is given its sentence.
  const washed = corpse.roomId !== diedIn;
  const resting = washed
    ? `The waters have carried ${corpse.of}'s remains ashore, to ${describeRoomName(corpse.roomId)}.`
    : `Your corpse lies where you fell — ${corpse.of}'s remains, in ${describeRoomName(diedIn)}.`;
  send(player.id, {
    t: 'log',
    channel: 'system',
    text:
      cost.experienceLost === 0
        ? `You were too green to lose anything by it. ${washed ? resting : 'Your corpse lies where you fell.'}`
        : `It cost you ${cost.experienceLost} experience` +
          (cost.levelsLost > 0 ? ` and ${cost.levelsLost} level${cost.levelsLost === 1 ? '' : 's'}` : '') +
          `. ${resting}`,
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

  // **Phase 18: a group multiplies what its members earned, and only the ones who fought count.**
  // Owner's call, 2026-08-06 — see `experience.ts` for the arithmetic and why it is composed this way
  // rather than replacing the contribution split. Two conditions decide who is counted, and both are
  // the source's: **in the room the thing died in** (`fight.c`: *"Ppl out of room still count against
  // exp gain? Erm... no"*) and, ours, **having contributed** — which is what makes twelve idle alts
  // parked in the room worth nothing to anybody.
  //
  // **The coin is deliberately not multiplied.** A purse is a thing the mob was carrying, not a pool
  // scaled by who turned up; paying a group more than the body held would mint money, where paying
  // them more experience than the body was worth is exactly what Duris does on purpose.
  const contributorsHere = new Set<EntityId>();
  for (const award of shares) {
    const earner = sim.player(award.actor);
    if (earner && earner.roomId === actor.roomId) contributorsHere.add(earner.id);
  }

  for (const [index, award] of shares.entries()) {
    const earner = sim.player(award.actor);
    if (!earner) continue;

    // The earner's own cohort: themselves plus the group-mates who also fought and are also here. One
    // member is not a group, so a solo contributor and somebody whose party all fled take the plain
    // share and the multiplier is never consulted.
    const cohort = contributorsHere.has(earner.id)
      ? [...contributorsHere]
        .map((id) => sim.player(id))
        .filter((who): who is Player => who !== undefined)
        .filter((who) => who.id === earner.id || grouped(grouping, earner.id, who.id))
      : [];
    const members = cohort.length;
    const experience = members > 1
      ? groupedShare(award.experience, {
        members,
        level: earner.level,
        // Measured over the cohort, not the mob: the wall exists to stop a level 1 being carried by a
        // level 50, and it is the company they are keeping that says whether that is happening.
        highest: Math.max(...cohort.map((who) => who.level)),
      })
      : award.experience;
    earner.experience += experience;

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
      // Said out loud for the same reason the breakdown is: the *rule* is the interesting part, and a
      // player who sees "group of 3" beside a bigger number than they got alone has learnt why parties
      // exist without anybody explaining it. It reports the cohort that was counted, not the group's
      // size, so a member who sat out is visibly not in it.
      members > 1 ? `group of ${members}` : undefined,
    ].filter(Boolean).join(', ');
    send(earner.id, {
      t: 'log',
      channel: 'system',
      text: `You gain ${experience} experience${how ? ` (${how})` : ''}.`,
    });
    // Slice 7: the kill also answers whoever asked for it. Before the level-up, so a quest line
    // reads in the order the deed happened; the reward itself waits at the giver.
    if (isMob(actor)) advanceKillQuests(earner, actor.vnum);
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

  // **A mob's corpse holds everything it had — carried *and* worn.** Phase 15c, and the rule now lives
  // in `corpses.ts` beside the corpse it fills, because Phase 16 made it a promise rather than a policy:
  // the mob's gear is on the wire, so what a player can *see* it holding is what this has to hand over.
  const spoils = spoilsOf(actor);
  const corpse = makeCorpse(graveyard, actor, isPlayer(actor), spoils);
  // A mob killed over deep water gives its loot to the nearest shore — it has no entry shore to owe
  // anybody, and a reward nobody can reach is the failure the wash exists to prevent.
  comeAshore(corpse);
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

/*
 * **`announceHunt` lived here until 2026-08-13, and the renderer retired it.**
 *
 * It said *"A kobold youth arrives from the east."* to everyone in the room a hunter walked into, and
 * the owner's call on reading it beside a lit mesh was that it had stopped earning its line: *"now
 * that the game is more visual we can probably do away with the announcements."*
 *
 * The argument for deleting rather than gating is in the code that was here: the sentence was
 * **already** gated on `watching`, so it only ever reached a player who could see the arrival — which
 * is exactly the case the renderer now covers. Its remaining audience was people watching a kobold
 * walk in *and* being told a kobold walked in. Inverting the gate to speak only for unseen arrivals
 * was considered and refused: telling you that something you cannot see just entered the room is a
 * bigger change to the game than removing prose, and it is not what was asked for.
 *
 * The `entered` event itself is untouched and still load-bearing — the tick reads it to re-evaluate
 * the room a hunter *left*, which nothing else would do (see `stirred`, further down).
 *
 * **The one thing worth watching**: this line doubled as a warning that a hunter had caught up with
 * you while your eye was elsewhere on screen. If chases start feeling like ambushes, the honest
 * replacement is a sound or an on-screen tell, not the sentence coming back.
 */

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
        // And where it now stands, for anyone who could see it *before* and can still see it now —
        // which since 2026-08-13 is the ordinary case for a flight through an open crossing. The
        // membership diff above says nothing about a body that never left view, so without this the
        // sprite would sit at the tile it bolted from until the mob moved again. See {@link syncTurn}.
        syncTurn(actor);
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
      // Both pointers a player holds just moved — `fighting` was cleared by the escape and `pursuing`
      // was set by `markPursuers` — and both feed `SelfView.target`. Sent last so it reflects the
      // clear above rather than racing it, and to everyone the flight touched rather than the fleer
      // alone: the chevron has to come off a body that is no longer there in the same beat the prose
      // says it ran.
      for (const other of outcome.changed) {
        if (isPlayer(other)) send(other.id, { t: 'self', view: sim.selfViewOf(other) });
      }
      if (self) send(self.id, { t: 'self', view: sim.selfViewOf(self) });
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
  // Everyone who could see the room they left — which since 2026-08-13 includes its open neighbours,
  // and the arriving player is standing in one of them. They are excluded by name: `describeRoom`
  // below re-seeds their watch set from a fresh room view, and a diff taken here against the old set
  // would spend an `entityLeave` on somebody the very next message re-sends.
  syncEntitiesIn(from, via ? { id: player.id, dir: via } : undefined, player.id);

  if (!samePlace(fromPlace, player.place)) {
    const zone = world.zone(player.place.zone);
    if (zone) send(player.id, { t: 'zone', zone, level: player.place.level });
    // A new Place can be a new zone, and weather is per zone — so walking from a dry wood into a
    // rainstorm has to say so here or the client keeps drawing the sky it left.
    sendSky(player);
    // A route is tile coordinates on the grid they just left. The simulation already dropped it in
    // relocate(); this is what stops the client drawing a line across the new map. Deliberately
    // inside the Place check — walking from one room to the next *within* a Place also comes through
    // here, and cancelling there would break every click-to-move that crosses a corridor.
    send(player.id, { t: 'path', points: [] });
    // A new Place means a new grid, so tile indices from the old one mean nothing: the whole bitset
    // for this Place goes out, and deltas take over again from here.
    sendSeen(player);
    sendPlaces(player);
  } else if (delta.length > 0) {
    send(player.id, { t: 'seenDelta', tiles: delta });
  }

  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  describeRoom(player);
  // After the room description, which re-seeded this player's own watch set — and for everyone in
  // the destination room, who pick the arrival up only if their light reaches them.
  syncEntitiesIn(player.roomId);
  // **Where they now stand, for whoever never stopped seeing them.** Before 2026-08-13 a step out of
  // a room was an `entityLeave` for everyone left behind, so their position was moot. Now a walk
  // through an open crossing keeps the body on their screens, and a membership diff says nothing at
  // all about a body that stayed visible — so without this it would stand frozen in the room they
  // walked out of until they next moved a pixel. A typed `east` is not in the tick's `moved` list.
  syncTurn(player);

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

  // **Phase 18: `here` just changed for the whole party.** Every arrival in the game funnels through
  // this function — walking, fleeing, being moved, waking up at the spawn room after dying — so the
  // roster's one derived field is refreshed from a single place. Pushed to all members rather than
  // working out which two rooms it mattered in: a party is at most thirteen rows.
  pushGroupTo(membersWith(grouping, player.id));
}

/**
 * "a rusted gate" -> "A rusted gate", for a door name that has to start a sentence.
 *
 * The names carry their own article, exactly as the light sources do (see {@link bare}), which is
 * right for "You open a rusted gate" and wrong for "a rusted gate is closed."
 *
 * **It capitalises the first *letter*, not the first character**, and that distinction is the whole
 * of Phase 16's prose bug: a harvested item's name is authored text and 4.6 million colour codes
 * exist across the world files, so `&+ya small brass lantern&N` starts with an ampersand. Upper-casing
 * character zero produced "&+ya small brass lantern lights the way" — a sentence that begins in lower
 * case *and* leaves the code intact — and it will do it to every door and every item the moment a
 * builder colours one. The scan walks past whole `&`-codes rather than past punctuation generally,
 * because the colour notation is the only thing that legitimately precedes a sentence's first word.
 */
function capitalise(name: string): string {
  // `&+X` (three characters) or `&X` (two) — `colour.ts`'s own grammar.
  const codes = /^(?:&\+?.)*/.exec(name)?.[0] ?? '';
  const rest = name.slice(codes.length);
  return codes + rest.charAt(0).toUpperCase() + rest.slice(1);
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

/**
 * `follow <name>`, `follow stop`, `follow me` — Phase 18's first half.
 *
 * Transcribed from `do_follow` (`actmove.c:3116`), including the two forms that read oddly and are
 * worth keeping because a Diku player's fingers already know them: **`follow` with your own name
 * stops**, and **`follow stop` is the *leader's* command**, throwing off everybody in the room rather
 * than clearing your own leader.
 *
 * The target is resolved through the same visible-set gate a `kill` passes, so you cannot fall in
 * behind somebody standing in the dark — and the refusal says the source's own sentence.
 */
function followCommand(player: Player, rest: string): void {
  const term = rest.trim();
  if (!term) {
    const leader = leaderOf(following, player.id);
    const who = leader === undefined ? undefined : sim.get(leader);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: who ? `You are following ${who.name}.` : 'You are following no one.',
    });
    return;
  }

  // **The leader's remedy, and it is scoped to the room on purpose.** Somebody trailing you from
  // three rooms back keeps following — the source is explicit about it, and the reason is that you
  // can only shake off what you can see.
  if (term.toLowerCase() === 'stop') {
    let thrown = 0;
    for (const id of followersOf(following, player.id)) {
      const follower = sim.get(id);
      if (!follower || follower.roomId !== player.roomId) continue;
      stopFollowing(following, id);
      thrown++;
      send(id, { t: 'log', channel: 'system', text: `${player.name} no longer wants you to follow.` });
    }
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: thrown === 0 ? 'Nobody here is following you.' : `You shake off ${thrown} follower(s).`,
    });
    return;
  }

  const view = resolveTarget(player, term);
  if (!view) return;
  const target = sim.get(view.id);
  if (!target) return;

  // Following yourself is how you stop, which is the source's own shape.
  if (target.id === player.id) {
    const was = stopFollowing(following, player.id);
    const leader = was === undefined ? undefined : sim.get(was);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: leader ? `You stop following ${leader.name}.` : 'You are already following yourself.',
    });
    if (leader && isPlayer(leader)) {
      send(leader.id, { t: 'log', channel: 'system', text: `${player.name} stops following you.` });
    }
    return;
  }

  if (wouldLoop(following, player.id, target.id)) {
    // Refused rather than silently dropping what they already had: a request that cannot be honoured
    // must not also cost the character the relationship they were in.
    send(player.id, { t: 'log', channel: 'error', text: "Sorry, but following in 'loops' is not allowed." });
    return;
  }

  if (!startFollowing(following, player.id, target.id)) {
    send(player.id, { t: 'log', channel: 'system', text: `You are already following ${target.name}.` });
    return;
  }

  send(player.id, { t: 'log', channel: 'system', text: `You now follow ${target.name}.` });
  if (isPlayer(target)) {
    send(target.id, { t: 'log', channel: 'system', text: `${player.name} starts following you.` });
  }
}

/**
 * Walks everybody who is following this character the same way they just went.
 *
 * **The intent is re-issued, never the position copied** — `ROADMAP.md`'s rule for the phase, and the
 * reason a train behaves itself with no code of its own. Each follower goes through the whole of
 * `stepRoom`: their own engagement check, their own closed door, their own deep water, their own
 * stamina. A member too tired to keep up simply stops, is told why by the ordinary refusal, and the
 * rest of the train carries on. Nothing here has to know that any of those rules exist.
 *
 * Recursive by construction, because the followers' own followers are picked up when each of them
 * steps. `wouldLoop` is what makes that terminate.
 *
 * Only followers who were **in the room the leader left** move. Somebody who fell behind is still
 * following — they simply did not see which way you went, which is the same rule `follow stop` uses
 * and for the same reason.
 */
function walkFollowers(leader: Player, from: RoomId, dir: Direction): void {
  for (const id of followersOf(following, leader.id)) {
    const follower = sim.get(id);
    if (!follower || !isPlayer(follower) || follower.roomId !== from) continue;
    send(follower.id, { t: 'log', channel: 'system', text: `You follow ${leader.name} ${dir}.` });
    stepRoom(follower, dir);
  }
}

/* -------------------------------------------------------------------------- */
/* Grouping — Phase 18's second half                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sends one character their roster — protocol 19.
 *
 * `here` is computed against **the recipient's** room rather than the leader's, because the question
 * the row answers is *"is this person with me"*. A five-member party split across two rooms therefore
 * sees two different rosters, which is correct: each half is told who is beside them.
 *
 * An empty group sends an empty list rather than nothing at all. That is the only way a client can be
 * told the group it was in has ended — by then the departed character is in no group to enumerate.
 */
function pushGroup(who: EntityId): void {
  const player = sim.player(who);
  if (!player) return;
  const ids = membersWith(grouping, who);
  const members: GroupMemberView[] = [];
  for (const [index, id] of ids.entries()) {
    const member = sim.player(id);
    if (!member) continue;
    members.push({
      id,
      name: member.name,
      level: member.level,
      leader: index === 0,
      // Clamped, because a dying character is on negative hit points and a bar drawn from a negative
      // fraction renders inside-out.
      health: fraction(member.hp, member.maxHp),
      // Protocol 21: the exact pair, unclamped on purpose — a healer looking at a groupmate in the
      // dying window should read the truth (−4 of 126), because that is the number they are racing.
      hp: member.hp,
      maxHp: member.maxHp,
      move: fraction(member.move, member.maxMove),
      mana: fraction(member.mana, member.maxMana),
      here: member.roomId === player.roomId,
    });
  }
  send(who, { t: 'group', members });
}

function fraction(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(1, value / max));
}

/** Pushes the roster to a whole party — every membership change ends in one of these. */
function pushGroupTo(ids: readonly EntityId[]): void {
  for (const id of ids) pushGroup(id);
}

/** A line to everybody in the group, the party's own channel. */
function tellGroup(ids: readonly EntityId[], text: string, except?: EntityId): void {
  for (const id of ids) {
    if (id === except) continue;
    send(id, { t: 'log', channel: 'system', text });
  }
}

/**
 * `consent <name>`, `consent who`, bare `consent` — Phase 18, and the half of grouping the *joiner*
 * does.
 *
 * Transcribed from `do_consent` (`actnew.c:311`), including the reach: the source scans the descriptor
 * list rather than the room, so consent may be given to **anybody online you could see**. That is not
 * laxity — it is what makes a party assemble before it is standing in one place, and the enrolment
 * itself still requires the same room.
 */
function consentCommand(player: Player, rest: string): void {
  const term = rest.trim();
  if (!term) {
    revokeConsent(grouping, player.id);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: 'You no longer feel generous and revoke your consent.',
    });
    return;
  }

  if (term.toLowerCase() === 'who') {
    const names = consentedTo(grouping, player.id)
      .map((id) => sim.player(id)?.name)
      .filter((name): name is string => name !== undefined);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: names.length === 0
        ? 'You have given nobody your consent.'
        : ['You have given your consent to:', ...names.map((name) => `  ${name}`)].join('\n'),
    });
    return;
  }

  const target = [...sim.allPlayers()].find((other) => isName(term, [other.name]));
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: 'No one by that name here...' });
    return;
  }
  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: 'You cannot give yourself consent!' });
    return;
  }

  if (!grantConsent(grouping, player.id, target.id)) {
    send(player.id, { t: 'log', channel: 'system', text: `${target.name} already has your consent.` });
    return;
  }
  send(player.id, { t: 'log', channel: 'system', text: `You give ${target.name} your consent.` });
  // The other half has to be told, or the handshake is a thing you do into the dark and then have to
  // say out loud on some other channel anyway.
  send(target.id, {
    t: 'log',
    channel: 'system',
    text: `${player.name} gives you consent — you may "group ${player.name.toLowerCase()}".`,
  });
}

/**
 * `group`, `group <name>`, `group me`, `group all` — Phase 18, and the leader's half.
 *
 * `do_group` (`group.c:358`) is one command doing five jobs, and it is transcribed rather than split
 * because which job it does follows from the state rather than from a different word: a name you have
 * is a kick, a name you do not have is an enrolment, your own name is leaving, and no name at all is
 * the roster. A Diku player's fingers already know this.
 */
function groupCommand(player: Player, rest: string): void {
  const term = rest.trim();
  const members = membersWith(grouping, player.id);

  if (!term) {
    if (members.length === 0) {
      send(player.id, { t: 'log', channel: 'system', text: 'But you are a member of no group?!' });
      return;
    }
    const lines = members.map((id, index) => {
      const member = sim.player(id);
      if (!member) return '  (gone)';
      const where = member.roomId === player.roomId ? '' : ' &+L(elsewhere)&N';
      return `  (${index === 0 ? ' Head' : 'Group'}) ${member.name}, level ${member.level} — ` +
        `${member.hp}/${member.maxHp} hit, ${member.move}/${member.maxMove} move${where}`;
    });
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: [`Your group consists of (${members.length}/${MAX_GROUP_MEMBERS}):`, ...lines].join('\n'),
    });
    return;
  }

  // **`group all` enrols your followers, and it is the seam between the phase's two halves.** The
  // source picks them out of `ch->followers` for a reason worth keeping: somebody who chose to walk
  // behind you has already said something about wanting to be with you, so this is the one bulk
  // enrolment that is not a way to conscript a room. Consent is still required of each.
  if (term.toLowerCase() === 'all') {
    if (members.length > 0 && !leads(grouping, player.id)) {
      send(player.id, { t: 'log', channel: 'error', text: 'This only works for group leaders.' });
      return;
    }
    let added = 0;
    for (const id of followersOf(following, player.id)) {
      const follower = sim.player(id);
      if (!follower || !canSee(player, follower)) continue;
      if (grouped(grouping, player.id, id)) continue;
      const result = enrol(grouping, player.id, id);
      if (result.ok) {
        added++;
        announceEnrolment(player, follower, result.merged);
      } else {
        send(player.id, { t: 'log', channel: 'error', text: refuseEnrolment(follower, result.why) });
      }
    }
    if (added === 0) send(player.id, { t: 'log', channel: 'system', text: 'No new group members.' });
    return;
  }

  const view = resolveTarget(player, term);
  if (!view) return;
  const target = sim.player(view.id);
  if (!target) {
    // A mob. `do_group_add` will take an NPC that is following you, which is Duris' charmed-pet
    // mechanic — and we have no charm, no orders and no pets, so a grouped mob would be a member with
    // nobody driving it and a share of the experience.
    send(player.id, { t: 'log', channel: 'error', text: 'They cannot be grouped.' });
    return;
  }

  // Your own name leaves the group, which is the form that reads oddly and is worth keeping.
  if (target.id === player.id) {
    if (members.length === 0) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: "You can't leave a group when you're not already in one!",
      });
      return;
    }
    leaveGroup(player, 'You leave the group.', `${player.name} leaves the group.`);
    return;
  }

  // Somebody already in your group: this is a kick. Same word, and the state decides.
  if (grouped(grouping, player.id, target.id)) {
    if (!leads(grouping, player.id)) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: 'You can not enroll group members without being head of a group.',
      });
      return;
    }
    const before = membersWith(grouping, player.id);
    const result = depart(grouping, target.id);
    send(target.id, { t: 'log', channel: 'system', text: `You have been kicked out of ${player.name}'s group.` });
    tellGroup(before, `${target.name} has been kicked out of ${player.name}'s group.`, target.id);
    if (result.dissolved !== undefined) {
      send(result.dissolved, { t: 'log', channel: 'system', text: 'Your group has been disbanded.' });
    }
    pushGroupTo(before);
    return;
  }

  if (members.length > 0 && !leads(grouping, player.id)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: 'You can not enroll group members without being head of a group.',
    });
    return;
  }

  const result = enrol(grouping, player.id, target.id);
  if (!result.ok) {
    send(player.id, { t: 'log', channel: 'error', text: refuseEnrolment(target, result.why) });
    return;
  }
  announceEnrolment(player, target, result.merged);
}

/** The four refusals, each said in its own words — see `EnrolResult` for why one boolean will not do. */
function refuseEnrolment(target: Player, why: string): string {
  switch (why) {
    case 'in-another-group': return `${target.name} is in another group.`;
    // Duris' own sentence, and it is the one that teaches the mechanic: the *joiner* consents.
    case 'no-consent': return `But you haven't ${target.name}'s permission to do that! (They must "consent" you.)`;
    case 'full': return 'Your group is too large!';
    case 'not-leader': return 'This only works for the group leader!';
    case 'already': return `${target.name} is already in your group.`;
    default: return 'You cannot group that.';
  }
}

/** Told to all three audiences the source tells: the leader, the joiner, and the party around them. */
function announceEnrolment(leader: Player, joined: Player, merged: readonly EntityId[]): void {
  const party = membersWith(grouping, leader.id);
  send(leader.id, { t: 'log', channel: 'system', text: `${joined.name} is now a member of your group.` });
  send(joined.id, { t: 'log', channel: 'system', text: `You are now a member of ${leader.name}'s group.` });
  for (const id of party) {
    if (id === leader.id || id === joined.id || merged.includes(id)) continue;
    send(id, { t: 'log', channel: 'system', text: `${joined.name} is now a member of ${leader.name}'s group.` });
  }
  // A merge is announced to the people it happened *to*, because from their side nothing they did has
  // changed and they have a new leader.
  for (const id of merged) {
    send(id, { t: 'log', channel: 'system', text: `Your group has merged into ${leader.name}'s group.` });
  }
  pushGroupTo(party);
}

/**
 * One character out of their group, however they came to be leaving, with everybody told.
 *
 * Shared by `group me` and by `disband`'s own path so that the promotion sentence and the dissolution
 * sentence are written once. Which of them is said is a property of the group's new shape, which is
 * `depart`'s answer rather than this function's.
 */
function leaveGroup(player: Player, toThem: string, toThePartyText: string): void {
  const before = membersWith(grouping, player.id);
  const result = depart(grouping, player.id);
  send(player.id, { t: 'log', channel: 'system', text: toThem });
  tellGroup(before, toThePartyText, player.id);
  if (result.promoted !== undefined) {
    send(result.promoted, { t: 'log', channel: 'system', text: 'You are now the leader of your group!' });
  }
  if (result.dissolved !== undefined) {
    send(result.dissolved, { t: 'log', channel: 'system', text: 'Your group has been disbanded.' });
  }
  pushGroupTo(before);
}

/** `disband` — the leader dissolving their own group, and `CMD_Y` at `STAT_SLEEPING`. */
function disbandCommand(player: Player): void {
  if (!leads(grouping, player.id)) {
    send(player.id, { t: 'log', channel: 'error', text: 'You must be the leader of a group to disband it.' });
    return;
  }
  const before = membersWith(grouping, player.id);
  const thrown = disband(grouping, player.id);
  send(player.id, { t: 'log', channel: 'system', text: 'You disband the group.' });
  for (const id of thrown) {
    send(id, { t: 'log', channel: 'system', text: `${player.name} has disbanded the group.` });
  }
  pushGroupTo(before);
}

/**
 * `gsay <what>` — the party's channel, and **it reaches the whole group regardless of room.**
 *
 * `do_gsay` (`actnew.c:232`) walks `ch->group` with no room check at all, which is the point of it: a
 * party splits up, and the one line that has to cross a wall is *"I am in trouble"*. That makes it the
 * first speech in the game that is not room-scoped — and note what it therefore does **not** carry:
 * `from`/`speech`, protocol 17's bubble fields. A bubble is drawn on a body the client holds, and most
 * of a group is not on your screen; a channel that drew bubbles for the members who happened to be
 * beside you and nothing for the rest would read as the far ones being ignored.
 */
function groupSay(player: Player, rest: string): void {
  const said = rest.trim().slice(0, 400);
  if (!said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Yes, but WHAT do you want to gsay?' });
    return;
  }
  const members = membersWith(grouping, player.id);
  if (members.length === 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'But you are a member of no group?!' });
    return;
  }
  // `&+G` is the source's own colour for it, and it survives to the client as the MUD's notation
  // rather than as markup — see `colour.ts`.
  send(player.id, { t: 'log', channel: 'say', text: `&+GYou group-say '${said}'&N` });
  for (const id of members) {
    if (id === player.id) continue;
    send(id, { t: 'log', channel: 'say', text: `&+G${player.name} group-says '${said}'&N` });
  }
}

/**
 * `bash <target>` and `kick <target>` — **Phase 19 slice 3, the first things you *do* in a fight.**
 *
 * Every consequence here already existed, which is why the slice is small and why the extraction that
 * preceded it was the real work:
 *
 * - **Landing it** goes through `landBlow`, so a kick that kills pays experience, leaves a corpse, clears
 *   everyone's engagement and credits threat — by construction rather than by being remembered.
 * - **Knocking somebody down** is `setStance(target, 'sitting')`, and they stay there because `canMove` is
 *   already the gate on walking. The handoff predicted this: *"Phase 19's bash needs no code."*
 * - **The lag** is `scheduler.cancel` plus a fresh `schedule`, which is exactly what `engage` does to make
 *   an opening blow wait a round.
 * - **The notch** is slice 1's, unchanged, including its cooldown.
 *
 * **A miss still starts the fight**, which is the source's own behaviour (`do_kick` calls `engage` on the
 * failure path too) and the right one: swinging a boot at somebody is a declaration whether or not it lands.
 */
/**
 * The shield a character is bashing with, or `undefined` for a bare arm.
 *
 * **Duris asks `ch->equipment[WEAR_SHIELD]` and we cannot**, because this project has no shield
 * slot: a shield is worn in `offHand`, and so is a lantern, a torch and a held spellbook. So the
 * question "is there a shield on that arm" has to be answered from the item, and it is answered two
 * ways because our shields come from two places.
 *
 * The catalogue's 242 shields carry `ITEM_TYPES.shield` on their template. The starter kit's do
 * not: `STARTER_KIT` mints its kite and round shields directly, with no vnum and therefore no
 * template to look the type up in. Testing only the template would have quietly excluded **every
 * new warrior and paladin** — the exact characters who bash, on the exact day they learn it — and
 * the bug would have looked like the penalty simply not working.
 *
 * `size` and `name` are all that leaves here: `abilities.ts` is rules maths and has no business
 * knowing what an inventory row looks like.
 */
function shieldInHand(player: Player): Shield | undefined {
  const worn = player.equipped.offHand;
  if (!worn) return undefined;
  const isShield = templateOf(worn)?.type === DURIS_ITEM.shield || worn.id === STARTER_SHIELD_ID;
  return isShield ? { size: worn.size, name: worn.name } : undefined;
}

function useAbility(player: Player, id: CombatAbilityId, rest: string): void {
  const ability = COMBAT_ABILITIES[id];
  const term = rest.trim();
  // Falls back to whoever you are already fighting, so `bash` mid-fight needs no argument — the commonest
  // case by far, and typing a name at the thing already hitting you is friction nobody asked for.
  const view = term ? resolveTarget(player, term) : undefined;
  if (term && !view) return; // `resolveTarget` has already said why.
  const target = view ? sim.get(view.id) : player.fighting === undefined ? undefined : sim.get(player.fighting);
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(ability.verb)} whom?` });
    return;
  }
  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot ${ability.verb} yourself.` });
    return;
  }

  // **The lag is checked here and set below**, and a pending one is a refusal rather than a queue: Duris'
  // `CharWait` blocks the *command*, and an ability that silently queued would leave a player pressing a
  // key and seeing nothing happen for three seconds.
  if (sim.affectsOf(player, 'off_balance').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You have not recovered your balance yet.' });
    return;
  }

  // Slice 4: a ceiling of zero is not "bad at it", it is "the training never happened" — a wizard
  // does not bash badly, a wizard does not bash. Free, unlike a failed attempt: you cannot be
  // charged a round for a move your class has never heard of.
  if (ceilingFor(ability.skill, classOf(player), player.level) === 0) {
    send(player.id, { t: 'log', channel: 'error', text: `Your training never covered ${ability.skill}.` });
    return;
  }

  const learned = learnedAt(player.skills.get(ability.skill), player.level, ability.skill, classOf(player));
  const shield = ability.usesShield ? shieldInHand(player) : undefined;

  // **Said before the roll, not after it** — `actoff.c:6299` prints this while working out the
  // chance, so it is a warning about the attempt rather than an excuse for the miss. Everyone we
  // can create sees it every time: the skill that would silence it is epic.
  if (ability.usesShield && !shield) {
    send(player.id, { t: 'log', channel: 'combat', text: SHIELDLESS_BASH_LINE });
  }

  const landed = randomInt(combatRng, 1, 100) <= abilityChance(ability, learned, shield);

  // Charged whether it lands or not — the cost is the attempt. Both clocks are set before anything else can
  // fail, so a refusal further down cannot leave a free ability behind.
  const lagMs = Math.round(ability.selfLagRounds * ROUND_MS);
  // Two clocks, because they mean different things. The **affect** is what refuses another ability and is
  // what the player can see; the **swing** reschedule is the auto-attack it displaced — pushed to whichever
  // is later, so an ability never *shortens* the round it was used in.
  sim.addAffect(player, newAffect({ type: 'off_balance', durationMs: lagMs, flags: AffectFlag.NoSave }));
  scheduler.cancel(player.id, 'swing');
  scheduler.schedule('swing', player.id, Math.max(lagMs, player.roundMs));

  // Protocol 22: the ability's motion, to everyone with sight of either party — the same structured
  // form a swing sends, because a bash the room cannot see moving is a sentence pretending to be an
  // event. `natural` is 0 by honest convention: abilities roll d100 against the skill, and there is
  // no d20 to report. Sent before the outcome branches so a miss animates the attempt it was.
  for (const observer of sim.playersIn(player.roomId)) {
    const seesAttacker = observer.id === player.id || (watching.get(observer.id)?.has(player.id) ?? false);
    const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
    if (!seesAttacker && !seesTarget) continue;
    send(observer.id, {
      t: 'attackResolved',
      attacker: player.id,
      target: target.id,
      hit: landed,
      critical: false,
      damage: 0,
      natural: 0,
      outcome: landed ? 'hit' : 'miss',
      swing: 'slash',
    });
  }

  if (!landed) {
    send(player.id, {
      t: 'log',
      channel: 'combat',
      text: `You try to ${ability.verb} ${target.name}&N and miss.`,
    });
    actToRoom(player, 'combat', (who) => `${who} tries to ${ability.verb} ${target.name}&N and misses.`);
    // A missed attempt is still a declaration. `engage` refuses if either party is already busy.
    if (engage(scheduler, player, target)) syncEntityState(player);
    return;
  }

  // A list, because a shield's contribution is `number(0, 4) + weight / 2` — one rolled term and
  // one flat — and a single `Dice` cannot hold both. Without a shield it is the one entry it always
  // was.
  const damage = abilityDamage(ability, learned, shield).reduce(
    (total, dice) => total + rollDice(combatRng, dice),
    0,
  );
  const result = landBlow({ sim, scheduler, book: threat, ledger }, player, target, damage);

  send(player.id, {
    t: 'log',
    channel: 'combat',
    text: `&+G-=[&N You ${ability.verb} ${target.name}&N for ${damage} damage. &+G]=-&N`,
  });
  actToRoom(player, 'combat', (who) => `${who} ${ability.verbThird} ${target.name}&N for ${damage} damage.`);

  if (ability.knocksDown && !result.incapacitated) {
    // Sitting, not prone: `SET_POS(victim, POS_SITTING + GET_STAT(victim))`. They can stand back up, and
    // standing costs them the round the lag below has already taken.
    sim.setStance(target, { posture: 'sitting' });
    // **All three audiences, and the drive found this missing.** `actToRoom` deliberately excludes the
    // actor, so without this line the one person who *did* it was the only one not told — the knockdown is
    // the whole reason to bash rather than swing, and a mechanic you cannot see is one nobody uses.
    send(player.id, { t: 'log', channel: 'combat', text: `&+YYou knock ${target.name}&N&+Y to the ground!&N` });
    send(target.id, { t: 'log', channel: 'combat', text: `${capitalise(player.name)} knocks you to the ground!` });
    // Excluding the target, who just got the second-person line — the TO_VICT/TO_NOTVICT split
    // rescue's messages make, caught here by slice 2's drive: a bashed caster read both sentences.
    for (const line of actLines(player, [...sim.playersIn(player.roomId)].filter((p) => p.id !== target.id), canSee, (who) => `${who} knocks ${target.name}&N to the ground!`)) {
      send(line.to, { t: 'log', channel: 'combat', text: line.text });
    }
    syncEntityState(target);
  }
  if (ability.targetLagRounds > 0 && !result.incapacitated) {
    scheduler.cancel(target.id, 'swing');
    scheduler.schedule('swing', target.id, Math.round(ability.targetLagRounds * ROUND_MS));
  }

  for (const actor of result.changed) syncEntityState(actor);
  if (result.death) resolveDeath(result.death);
  else syncEntityState(target);

  // **The skill you used is the skill you learn.** Slice 1's notch, at the source's own offensive rate
  // (`skill.notch.offensive`, 7) rather than the weapon rate — a verb you chose to use is rarer than a blow
  // that happened to land, so the source does not thin it with a gate.
  notchSkill(player, ability.skill, OFFENSIVE_NOTCH_CHANCE);
}

/**
 * `fire` / `shoot <target> [direction]` and `throw <target> [direction]` — ranged slices 3+4,
 * `DESIGN-ranged.md`, built on `do_fire`'s shape because `do_throw` is the source's unfinished stub
 * (§0.2). One handler for both delivery methods, one skill between them, and the grammar is the
 * owner's own sentences: *"shoot kobold west"*, *"fire east"*, *"throw dagger west"* — a trailing
 * direction aims into the next room, no direction aims into your own.
 *
 * The order of the gauntlet is `useAbility`'s where they share a rule, and three things are its own:
 *
 * - **Cross-room shots re-run the peek and then demand the reveal.** The gauntlet is re-walked
 *   because a door may have shut since you looked; the reveal is demanded because aiming at a room
 *   you have not looked into is the thing slice 2 exists to gate. Both refusals teach the sequence:
 *   look, then shoot.
 * - **The wrong-target roll happens before the to-hit**, so a veered shot resolves against the body
 *   it veered to — one clean roll against one armour class, not a hit transplanted between targets.
 * - **The projectile is found before the round is charged and committed after**, so a refusal
 *   anywhere in the gauntlet costs nothing, and a shot that happens always costs exactly one arrow —
 *   which then *lands somewhere* (the victim, or the floor of their room) unless the breakage roll
 *   destroys it. Never consumed, per the owner's rule; the roll is the only destruction there is.
 *
 * What deliberately is not here: `attackResolved` (the pose vocabulary knows `slash` and `thrust`,
 * and a bow animating as a sword swing would be worse than the log line — slice 6's business), any
 * engagement of the *shooter* (firing does not draw your sword; the target's retaliation is what
 * makes the fight mutual, exactly as being swung at is), and the pull (slice 5 — a cross-room victim
 * takes the damage, holds the grudge, and stands there until `provoked` exists).
 */
function rangedCommand(player: Player, rest: string, thrown: boolean): void {
  const verb = thrown ? 'throw' : 'fire';
  // Grammar: `<keyword> [direction]`, either half optional. The trailing word is a direction only if
  // it reads as one — `directionFrom` is a prefix match over the six, so `shoot kobold e` aims east
  // while `shoot dog` stays a keyword ("down" does not start with "dog").
  const words = rest.split(/\s+/).filter(Boolean);
  const dir = words.length > 0 ? directionFrom(words[words.length - 1]!) : undefined;
  const keyword = (dir ? words.slice(0, -1) : words).join(' ');

  // **Resolution only.** Every gate — from "is that a bow" to the door that shut since you looked —
  // lives in {@link shootAt}, which the click's `rangedAttack` intent enters without coming here.
  // The typed path's one privilege is words: keywords, ordinals, and the bare verb mid-fight.
  let target: Actor | undefined;
  if (dir) {
    const room = sim.room(player.roomId);
    if (!room) return;
    const outcome = peek(room, dir, peekDeps());
    if (outcome.t !== 'view') {
      send(player.id, { t: 'log', channel: 'error', text: shotBlockedBy(outcome) });
      return;
    }
    // Slice 2's gate, spent for real: you aim at what you have made out, and nothing else. This is
    // what "gated on the revealed set" means — the reveal is the aim.
    if (!revealedRooms(player).has(outcome.room.id)) {
      send(player.id, { t: 'log', channel: 'error', text: `You cannot make out what stands there — look ${dir} first.` });
      return;
    }
    const bodies = sim.actorsIn(outcome.room.id);
    if (keyword) {
      const ref = parseTargetRef(keyword);
      if (!ref) {
        send(player.id, { t: 'log', channel: 'error', text: `"${keyword}" is not something you can aim at.` });
        return;
      }
      target = findTarget(ref, bodies, (b) => namelistFor(sim.viewOf(b)));
      if (!target) {
        send(player.id, { t: 'log', channel: 'error', text: `You see no ${ref.keyword} to the ${dir}.` });
        return;
      }
    } else {
      // The owner's original form — *"fire east"*, no name. The first fair body there is the mark,
      // which is what firing blind into a room means.
      target = bodies.filter((b) => canBeAttacked(b) && (settings.pvp || !isPlayer(b)))[0];
      if (!target) {
        send(player.id, { t: 'log', channel: 'error', text: 'Nobody is standing there.' });
        return;
      }
    }
  } else if (!keyword) {
    // Mid-fight, the verb alone aims at your opponent — `bash`'s own convenience, same reason.
    target = player.fighting === undefined ? undefined : sim.get(player.fighting);
    if (!target) {
      send(player.id, { t: 'log', channel: 'error', text: `${capitalise(verb)} at what?` });
      return;
    }
  } else {
    const view = resolveTarget(player, keyword);
    if (!view) return;
    const resolved = sim.get(view.id);
    if (!resolved) {
      send(player.id, { t: 'log', channel: 'error', text: `You cannot ${verb} at that.` });
      return;
    }
    target = resolved;
  }
  shootAt(player, thrown, target, dir);
}

/** The peek lookups the shot shares with `lookDirection` — one construction, so they cannot drift. */
function peekDeps() {
  return {
    roomOf: (id: RoomId) => sim.room(id),
    occupantsOf: (id: RoomId) => [...sim.actorsIn(id)].map((a) => ({ name: a.name, carriesLight: carriesLight(a) })),
    doorAt: (id: RoomId, d: Direction) => {
      const doorway = world.doorway(id, d);
      return doorway ? { name: doorway.near.door.name, closed: doorway.near.door.closed } : undefined;
    },
  };
}

/** Why a peek outcome refuses a shot, in the shot's own words. */
function shotBlockedBy(outcome: { readonly t: 'no-exit' | 'closed-door' | 'nowhere' | 'one-way' | 'dark'; readonly door?: string }): string {
  return outcome.t === 'closed-door' && outcome.door !== undefined ? `${capitalise(outcome.door)} is closed.`
    : outcome.t === 'dark' ? "&+LIt's much too dark there to aim at anything!&N"
    : outcome.t === 'no-exit' ? 'There is no exit that way.'
    : 'Something blocks your shot.';
}

/**
 * The shot itself, however it was asked for — typed words or a click on a body. One gauntlet for
 * both, so the pointer can never loose a shot the keyboard would have refused: the weapon, the
 * training, the round's clock, the fresh peek, the reveal, and the fairness gates all live here and
 * only here.
 */
function shootAt(player: Player, thrown: boolean, target: Actor, dir: Direction | undefined): void {
  const verb = thrown ? 'throw' : 'fire';
  const weapon = player.equipped.mainHand;
  const weaponTemplate = weapon ? templateOf(weapon) : undefined;
  // Instance first, template healed under it — `attackTypeOf`'s own pattern, so a weapon minted
  // before slice 1 copied the ranged fields onto instances still shoots after a restart.
  const fires = weapon?.fires ?? weaponTemplate?.fires;
  const throwable = (weapon?.canThrow ?? weaponTemplate?.canThrow) === true;

  if (thrown) {
    if (!weapon) {
      send(player.id, { t: 'log', channel: 'error', text: 'Your main hand is empty — wield something worth throwing first.' });
      return;
    }
    if (!throwable) {
      send(player.id, { t: 'log', channel: 'error', text: `${capitalise(weapon.name)}&N is not balanced for throwing.` });
      return;
    }
  } else if (fires === undefined) {
    // `fires` doubles as the launcher test: every fireweapon in the catalogue carries it, and nothing
    // else does — so one field answers "is this a launcher" and "what does it take" together.
    send(player.id, { t: 'log', channel: 'error', text: `You need a launcher in your main hand to ${verb} — a bow, a crossbow, a sling.` });
    return;
  }

  // A ceiling of zero is "the training never happened", exactly as it is for bash — a wizard does not
  // shoot badly, a wizard does not shoot. Free, unlike a failed attempt.
  if (ceilingFor('ranged', classOf(player), player.level) === 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'Your training never covered ranged weapons.' });
    return;
  }

  // The same clock every combat ability answers to, so shot-bash-shot cannot beat the round.
  if (sim.affectsOf(player, 'off_balance').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You have not recovered your balance yet.' });
    return;
  }

  const crossRoom = dir !== undefined;
  if (dir) {
    // The gauntlet again, fresh, however the target was resolved — a door shut since you looked is a
    // door your arrow meets, and a click re-walks it exactly as a re-typed word would.
    const room = sim.room(player.roomId);
    if (!room) return;
    const outcome = peek(room, dir, peekDeps());
    if (outcome.t !== 'view') {
      send(player.id, { t: 'log', channel: 'error', text: shotBlockedBy(outcome) });
      return;
    }
    if (!revealedRooms(player).has(outcome.room.id)) {
      send(player.id, { t: 'log', channel: 'error', text: `You cannot make out what stands there — look ${dir} first.` });
      return;
    }
    if (target.roomId !== outcome.room.id) {
      // Resolved a moment ago, gone now — the reveal is a memory, and the world kept moving under it.
      send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N is no longer there.` });
      return;
    }
  } else if (target.roomId !== player.roomId) {
    send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N is not here.` });
    return;
  }

  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot ${verb} at yourself.` });
    return;
  }
  if (isUntouchable(target)) {
    send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N has no quarrel with you.` });
    return;
  }
  if (!settings.pvp && isPlayer(target)) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot attack ${target.name}. Player killing is switched off.` });
    return;
  }
  if (!canBeAttacked(target)) {
    send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N is in no state to fight.` });
    return;
  }

  // Who else is standing beside the mark, for the wrong-target roll. Recomputed here rather than
  // carried from resolution, because the click path never resolved a room's worth of bodies at all.
  const bystanders = sim
    .actorsIn(target.roomId)
    .filter((b) => b.id !== target.id && b.id !== player.id && canBeAttacked(b) && (settings.pvp || !isPlayer(b)));

  // The projectile, found now and committed below — a refusal above this line costs nothing.
  //
  // **Slice 7: a conjured shot has no projectile object at all.** `missile` stays undefined, and every
  // downstream rule that moves an arrow — the spend, the landing, the corpse, the breakage roll —
  // simply never sees one. A conjured arrow exists only in flight, which is the owner's "its own
  // arrows that never run out" taken at its word.
  const conjures = thrown ? undefined : (weapon?.conjures ?? weaponTemplate?.conjures);
  let missile: Item | undefined;
  let missileName: string;
  let spentBag: Inventory | undefined;
  if (thrown) {
    missile = weapon!;
    missileName = weapon!.name;
  } else if (conjures !== undefined) {
    missileName = conjures;
  } else {
    const taken = takeMissile(player.inventory, fires!, (item) => item.missileType ?? templateOf(item)?.missileType);
    if (!taken) {
      send(player.id, { t: 'log', channel: 'error', text: `You are out of ${MISSILE_TYPE_NAMES[fires!] ?? 'missile'}s.` });
      return;
    }
    missile = taken.missile;
    missileName = taken.missile.name;
    spentBag = taken.inventory;
  }

  // From here the shot happens. The round is charged first, `useAbility`'s own order — nothing below
  // this line refuses, so nothing below it can leave a free shot behind.
  sim.addAffect(player, newAffect({ type: 'off_balance', durationMs: ROUND_MS, flags: AffectFlag.NoSave }));
  scheduler.cancel(player.id, 'swing');
  scheduler.schedule('swing', player.id, Math.max(ROUND_MS, player.roundMs));

  // The projectile leaves. A returning weapon never does — it is enchanted to come back, and the same
  // enchantment is why it skips the breakage roll: 339 of these are the rarest things a rogue will
  // ever own, and a 5% chance of deleting one per throw would make the enchantment a trap.
  const returning = thrown && (weapon?.returning ?? weaponTemplate?.returning) === true;
  if (spentBag) {
    sim.setInventory(player, spentBag);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    rememberProgress(player);
  } else if (thrown && !returning) {
    const next = { ...player.equipped };
    delete next.mainHand;
    player.equipped = next;
    afterKitChange(player);
  }

  // **The wrong-target roll comes first**, so the to-hit resolves once, against the body the shot
  // actually went at. Only into a crowd: alone with your mark there is no wrong body to find.
  const learned = learnedAt(player.skills.get('ranged'), player.level, 'ranged', classOf(player));
  let intended: Actor | undefined;
  if (bystanders.length > 0 && rollChance(combatRng, wrongTargetChance(learned))) {
    const veered = pick(combatRng, bystanders);
    if (veered) {
      intended = target;
      target = veered;
    }
  }

  // The bow is not the sword: the base and the spells are the same ones melee folds, the skill is
  // `ranged` rather than the wielded blade's, and the ability is the SRD's own for each delivery —
  // DEX behind a string, STR behind a thrown blade. `player.combat.attackBonus` would smuggle in the
  // melee weapon skill and the strength bonus a bow does not earn, so it is rebuilt from parts.
  const mod = player.identity ? abilityMod(thrown ? player.identity.scores.str : player.identity.scores.dex) : 0;
  const attackBonus =
    playerCombatStats(player.level).attackBonus + toHitFrom(learned) + mod + sumApply(player.affects, 'hit') + (weaponTemplate?.hitroll ?? 0);
  const result = resolveAttack(combatRng, { attackBonus, targetAc: target.combat.armourClass });

  // The missile's own dice — the launcher contributes aim, the arrow contributes the wound. A
  // conjured arrow is the one exception and the one honest place for it: the magic launcher's **own**
  // dice are the arrow, since a bow otherwise carries none. The 1d2 floor is for the record with a
  // key and no dice, which the harvest guards say should not exist; a needle that pricks for a point
  // beats a crash.
  const dice =
    (thrown
      ? weapon!.damage ?? weaponTemplate?.damage
      : conjures !== undefined
        ? weapon?.damage ?? weaponTemplate?.damage
        : templateOf(missile!)?.damage) ?? { count: 1, sides: 2, bonus: 0 };
  const damage = result.hit ? Math.max(1, rollDice(combatRng, dice) + (result.critical ? rollDice(combatRng, dice) : 0) + mod) : 0;

  // One breakage roll per shot, higher across the boundary, and the only destruction in the system.
  // A conjured arrow skips it with the returning weapon, for the same shape of reason: there is
  // nothing in the world to destroy.
  const broken = returning || conjures !== undefined ? false : rollChance(combatRng, breakChance(crossRoom));

  // Protocol 22, at last for the bow — deferred from slices 3+4 because the pose vocabulary only
  // knew `slash` and `thrust`, and a bow animating as a sword swing would have been worse than the
  // log line. Both rooms' watchers are told: the shooter's room sees the draw, and a far-room
  // observer who can see the victim watches the arrival (their copy plays no pose — they cannot see
  // the archer — but the strike lands on the body they are looking at).
  {
    const audience = new Set([...sim.playersIn(player.roomId), ...sim.playersIn(target.roomId)]);
    for (const observer of audience) {
      const seesAttacker = observer.id === player.id || (watching.get(observer.id)?.has(player.id) ?? false);
      const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
      if (!seesAttacker && !seesTarget) continue;
      send(observer.id, {
        t: 'attackResolved',
        attacker: player.id,
        target: target.id,
        hit: result.hit,
        critical: result.critical,
        damage,
        natural: result.natural,
        outcome: result.hit ? 'hit' : 'miss',
        // The throwing arm is the thrust the pack drew; the bow has its own sheet family.
        swing: thrown ? 'thrust' : 'shoot',
        projectile: thrown ? 'blade' : 'arrow',
      });
    }
  }

  announceShot(player, target, {
    missileName,
    thrown,
    dir,
    hit: result.hit,
    damage,
    broken,
    returning,
    intended: intended?.name,
    rollText: `[d20 ${result.natural}${result.natural === result.total ? '' : ` → ${result.total}`} vs AC ${target.combat.armourClass}]`,
  });

  // **The arrow lands before the blow resolves**, so a killing shot leaves it in the body the corpse
  // is about to be made from — `resolveDeath` reads `carrying`, and the loot rule is the owner's:
  // *"the ones that hit the mob should remain in their corpse for looting once they die."*
  if (missile && !broken && !returning) {
    if (result.hit && isMob(target)) {
      target.carrying.push(missile);
    } else {
      // A miss lands on the far floor for collection; a hit on a *player* lands at their feet too,
      // because a bag is not something an arrow can force its way into.
      const spot = dropSpotNear(ground, target.roomId, target.x, target.y, spawnRng, (px, py) => {
        const grid = world.grid(target!.place);
        return !grid || (isWalkableAt(grid, px, py) && roomAtTile(grid, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)) === target!.roomId);
      });
      dropItem(ground, missile, { roomId: target.roomId, place: target.place, x: spot.x, y: spot.y }, undefined, DEV_DECAY_MS);
      syncEntitiesIn(target.roomId);
    }
  }

  if (result.hit) {
    const blow = landBlow(
      { sim, scheduler, book: threat, ledger },
      player,
      target,
      damage,
      // The two dials, and they are never both turned: a cross-room victim must not acquire a target
      // it cannot reach (the pull is slice 5's), and a same-room shot earns the discounted grudge
      // that lets a ranger fire from the back of the group without out-threatening the tank.
      crossRoom ? { retaliate: false } : { threatFactor: RANGED_THREAT_FACTOR },
    );
    for (const actor of blow.changed) syncEntityState(actor);
    if (blow.death) resolveDeath(blow.death);
    else syncEntityState(target);
    // Slice 5: the survivor answers. Only a cross-room hit provokes — a same-room shot already
    // retaliated through `landBlow`, and provoking the dead would walk a corpse.
    if (crossRoom && !blow.death && isMob(target)) provokeMob(target, player);
    // The landed blow teaches, under `notchFromSwing`'s own gates: nothing is learned from the
    // helpless or in sanctuary.
    if (target.level >= 2 && !sim.room(player.roomId)?.flags?.includes('safe')) {
      notchSkill(player, 'ranged', WEAPON_NOTCH_CHANCE);
    }
  } else if (!crossRoom) {
    // A point-blank miss is still noticed — melee's own zero-damage retaliation, unchanged. A
    // cross-room miss is an arrow clattering in from nowhere; until slice 5 gives the victim a way
    // to answer it, it does not pretend to.
    const blow = landBlow({ sim, scheduler, book: threat, ledger }, player, target, 0, { threatFactor: RANGED_THREAT_FACTOR });
    for (const actor of blow.changed) syncEntityState(actor);
  }
}

/**
 * `quit` / `logout` — leave the world on purpose, back to the character picker.
 *
 * All of the actual leaving — the save, the removal, the forgetting by every mob and group and
 * hunt — is the socket-close handler's, which has been the single authority on departure since
 * Phase 23 and must stay it: a second copy of that list here would be the drift the close handler's
 * own comments warn about. This says the goodbyes, tells the client to forget the *character* while
 * keeping the *account* (so the reconnect lands on the picker, not back in the body that just quit),
 * and closes the socket to let the one true cleanup path run.
 */
function quitCommand(player: Player): void {
  send(player.id, { t: 'log', channel: 'system', text: 'Farewell — the world will keep your place.' });
  actToRoom(player, 'room', (who) => `${who} leaves the world.`);
  send(player.id, { t: 'loggedOut' });
  sockets.get(player.id)?.close();
}

/**
 * The pull — ranged slice 5, `DESIGN-ranged.md` §2.1 as decided: **being shot provokes you; it does
 * not change what kind of creature you are.** The affect lifts the mob's reach to exactly one room
 * (`effectivePursuit`), lasts its own harvested `giveUpMs`, and stores the room it was standing in so
 * expiry can walk it back. A mob already provoked is not re-provoked: no stacking, no chaining, and a
 * second shot buys no second room.
 *
 * **The wounded and the wimpy run instead** — the owner's clause (*"come to my room or flee depending
 * on its flee setting … it adds an element of danger"*), answered by the same `wimpyAt` threshold
 * morale reads mid-fight, consulted at the moment the arrow lands. Zero is a mob that never runs,
 * which is most of them.
 */
function provokeMob(mob: Mob, shooter: Player): void {
  if (mob.wimpyAt > 0 && mob.hp <= mob.wimpyAt) {
    runFlee(mob);
    return;
  }
  // **A re-shot re-lights the anger and never moves the anchor** — the owner's kite, distinguished
  // from the tow it must not become. The original affect's context is the room it was provoked *in*;
  // refreshing re-reads it, so five minutes of sustained archery still measures the leash from the
  // post. The harvested patience decides the duration where there is any; the fallback covers both
  // degenerate harvests, and one is the common case — a sentinel's `giveUpMs` is zero (it never
  // chased, so it never learned patience), and `??` alone would have provoked 83% of the world for
  // zero milliseconds. `null` (the relentless) is the other.
  const standing = sim.affectsOf(mob, 'provoked')[0];
  const home = standing?.context ?? String(mob.roomId);
  if (standing) sim.removeAffects(mob, 'provoked');
  sim.addAffect(mob, newAffect({
    type: 'provoked',
    durationMs: mob.pursuit.giveUpMs || PROVOKED_PATIENCE_MS,
    context: home,
  }));
  beginHunt(hunts, mob, shooter, provokedLeash(world, Number(home)));
}

/** The shot's sentences, in one place so the six shapes (hit/miss × here/there, veered, snapped) stay one voice. */
function announceShot(
  player: Player,
  target: Actor,
  shot: {
    readonly missileName: string;
    readonly thrown: boolean;
    readonly dir: Direction | undefined;
    readonly hit: boolean;
    readonly damage: number;
    readonly broken: boolean;
    readonly returning: boolean;
    readonly intended: string | undefined;
    readonly rollText: string;
  },
): void {
  const flies = shot.thrown ? 'spins' : 'streaks';
  const whereTo = shot.dir ? ` ${shot.dir}` : '';
  // "Your arrow", never "Your an arrow" — the possessive supplies its own article, so the item's
  // leading one is stripped from behind the colour code it arrives wrapped in.
  const veer = shot.intended
    ? `${capitalise(shot.missileName)}&N ${flies} past ${shot.intended}&N — and`
    : `Your ${stripLeadingArticle(shot.missileName)}&N`;

  // The shooter reads the roll, exactly as a melee swing prints it — the fight stays auditable.
  const outcome = shot.hit
    ? `${veer} strikes ${target.name}&N for ${shot.damage} damage. ${shot.rollText}`
    : `${veer} flies wide of ${target.name}&N. ${shot.rollText}`;
  send(player.id, { t: 'log', channel: 'combat', text: `&+G-=[&N ${capitalise(outcome)} &+G]=-&N` });
  if (shot.broken) {
    send(player.id, { t: 'log', channel: 'combat', text: `&+yThe ${stripLeadingArticle(shot.missileName)}&N&+y snaps${shot.hit ? ' on impact' : ''}!&N` });
  } else if (shot.returning) {
    send(player.id, { t: 'log', channel: 'combat', text: `${capitalise(shot.missileName)}&N spins back into your hand.` });
  }

  // Your own room watches the loosing; the far room watches the arrival. Same fact, each side's view.
  const act = shot.thrown ? 'hurls' : 'fires';
  actToRoom(player, 'combat', (who) =>
    shot.dir
      ? `${who} ${act} ${shot.missileName}&N${whereTo}.`
      : `${who} ${act} ${shot.missileName}&N at ${target.name}&N.`,
  );
  if (shot.dir) {
    const from = ` from the ${REVERSE[shot.dir]}`;
    actAround(
      target,
      'combat',
      (who) =>
        shot.hit
          ? `${capitalise(shot.missileName)}&N ${flies} in${from} and strikes ${who}!`
          : `${capitalise(shot.missileName)}&N ${flies} in${from} and ${shot.broken ? 'snaps against the ground' : 'clatters to the ground'}.`,
      // The victim gets the second-person line below instead of hearing about themselves.
      shot.hit ? target.id : undefined,
    );
  }
  if (isPlayer(target)) {
    send(target.id, {
      t: 'log',
      channel: 'combat',
      text: shot.hit
        ? `&+R-=[&N ${capitalise(shot.missileName)}&N from ${player.name} strikes you for ${shot.damage} damage! &+R]=-&N`
        : `${capitalise(shot.missileName)}&N from ${player.name} flies wide of you.`,
    });
  }
}

/** `"a throwing dagger"` → `"throwing dagger"`, for sentences that supply their own article. */
function stripLeadingArticle(name: string): string {
  return name.replace(/^(?:&\+?[A-Za-z]+)?(?:an?|the|some)\s+/i, (m) => m.replace(/(?:an?|the|some)\s+$/i, ''));
}

/**
 * `search` — `do_search` (`actobj.c:5771`), and both of the owner's asks for it.
 *
 * Three things it can be pointed at, and the third is ours rather than the source's:
 *
 * - **Nothing** — the room, which is where a hidden thing lies. `do_search` with no argument walks
 *   `world[ch->in_room].contents`.
 * - **A corpse or a container** — `do_search <thing>` walks what is inside it, refusing anything
 *   that is not a container, storage, corpse or quiver, and refusing a *closed* one with its own
 *   sentence. This is the owner's 2026-08-06 ask, *"hidden items in corpses, found by searching"*.
 * - **A prop** — `search haystack`. Duris has no scenery, so this is an extension, and it is a
 *   small one: our props *are* the room's furniture, and the source's own second case is "a thing
 *   standing in the room that has an inside". A prop is searched by searching the room around it,
 *   which is why the roll and the result are identical and only the prose differs.
 *
 * **One find per search**, as the source does — `for (; k && !found_something; …)` stops at the
 * first — so a room with two hidden things takes two searches and two rounds. And the round is
 * charged whether or not anything turns up (`CharWait(ch, PULSE_VIOLENCE)` runs at the end,
 * unconditionally), which is what stops `search` being a free action you spam on every tile.
 */
function doSearch(player: Player, rest: string): void {
  const word = rest.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const fail = (): void => send(player.id, { t: 'log', channel: 'error', text: SEARCH_LINES.notFound });

  if (sim.affectsOf(player, 'off_balance').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You have not recovered your balance yet.' });
    return;
  }

  const room = sim.room(player.roomId);
  // Where the hidden things are. The room, unless something with an inside was named — and there are
  // two kinds of inside, because a corpse is not a ground item here. It has its own store, its own
  // reach rule and its own name matching, all of which `loot` already owns; searching a body has to
  // go through the same three or `search sentry` and `loot sentry` would disagree about which of the
  // three dead guards on the floor they mean.
  let pool: Item[];
  let searched: Corpse | undefined;
  if (word && sceneryNamed(room ? sceneryOf(room) : undefined, word) === undefined) {
    const bodies = corpsesIn(graveyard, player.roomId)
      .filter((corpse) => withinReach(corpse, player.x, player.y))
      .filter((corpse) => corpseAnswersTo(corpse, word));
    searched = bodies[0];
    if (searched) {
      pool = searched.contents;
    } else {
      const container = itemsIn(ground, player.roomId).find((entry) => wordsFor(entry.item).includes(word));
      // One sentence for "no such thing" and "that has no inside" — the source's own conflation.
      if (!container?.held) return fail();
      pool = container.held.contents.map((stack: Stack) => stack.item);
    }
  } else {
    pool = itemsIn(ground, player.roomId).map((entry) => entry.item);
  }

  // Charged before the outcome, so a fruitless search costs exactly what a lucky one does.
  sim.addAffect(
    player,
    newAffect({ type: 'off_balance', durationMs: Math.round(SEARCH_LAG_ROUNDS * ROUND_MS), flags: AffectFlag.NoSave }),
  );

  const scores = player.identity?.scores;
  const hiddenHere = pool.filter((item) => item.hidden === true);
  for (const item of hiddenHere) {
    // A character with no rolled scores predates Phase 20b; treat them as unremarkable rather than
    // refusing the verb, which would make `search` silently dead for every pre-phase body.
    if (!findsIt(combatRng, scores?.int ?? 10, scores?.wis ?? 10)) continue;
    reveal(item, searched);
    send(player.id, { t: 'log', channel: 'room', text: `You find ${item.name}&N!` });
    actToRoom(player, 'room', (who) => `${capitalise(who)} finds ${item.name}&N!`);
    return; // one find per search
  }
  fail();
}

/**
 * Clears `hidden` wherever the thing is — a corpse, a ground entry, or a container on the floor.
 *
 * The corpse is passed in rather than searched for because `Corpse.contents` is a **mutable array**
 * that `lootCorpse` reassigns, so the body holding an item is not discoverable by identity the way a
 * ground entry is. Splicing in place is also what keeps `looted` honest: the flag is derived from
 * `contents.length`, and a rebuilt array would have to re-derive it.
 */
function reveal(found: Item, corpse?: Corpse): void {
  if (corpse) {
    const index = corpse.contents.indexOf(found);
    if (index >= 0) {
      const { hidden: _gone, ...rest } = found;
      corpse.contents[index] = rest;
      return;
    }
  }
  for (const entry of ground.values()) {
    if (entry.item === found) {
      const { hidden: _gone, ...rest } = entry.item;
      ground.set(entry.id, { ...entry, item: rest });
      return;
    }
    if (!entry.held) continue;
    const index = entry.held.contents.findIndex((stack) => stack.item === found);
    if (index < 0) continue;
    const contents = entry.held.contents.map((stack: Stack, at: number) => {
      if (at !== index) return stack;
      const { hidden: _gone, ...rest } = stack.item;
      return { ...stack, item: rest };
    });
    ground.set(entry.id, { ...entry, held: { ...entry.held, contents } });
    return;
  }
}

/**
 * `rescue <ally>` — **Phase 19 slice 4**, and the first ability that makes grouping mean something
 * mechanically: taking a blow meant for somebody else. `rescue()` (`actoff.c:7261`), transcribed;
 * the mechanism is `rescueFrom` in `combat.ts` and the threat-standing decision is documented there.
 *
 * What stays the source's, verbatim where a player can read it: the refusals ("What about fleeing
 * instead?", "How can you rescue someone you are trying to kill?", "But nobody is fighting them?" —
 * the last costing nothing, no lag and no roll), one attacker peeled per use, one round of lag paid
 * on the *attempt*, and the messages. **Dropped and named as dropped**: `ROOM_SINGLE_FILE` (the flag
 * is not harvested — no room in our world carries it), the Guardian's `rescue all` (classes are
 * Phase 21), and the blind check, which our visibility gate already is — a rescuee you cannot see is
 * a rescuee `resolveTarget` will not resolve.
 *
 * **The notch shape is the opposite of bash and kick's, and it is kept that way on purpose.** Their
 * roll is `!notch && miss` — learning forces the blow home. Rescue's is `notch || roll > skill` —
 * learning forces the fumble, and the `||` short-circuits so a notching attempt never rolls for
 * success at all. See `RESCUE_NOTCH_CHANCE` for the full note.
 */
function doRescue(player: Player, rest: string): void {
  const term = rest.trim();
  if (!term) {
    send(player.id, { t: 'log', channel: 'error', text: 'Rescue whom?' });
    return;
  }
  const view = resolveTarget(player, term);
  if (!view) return; // `resolveTarget` has already said why.
  const target = view ? sim.get(view.id) : undefined;
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: 'Rescue whom?' });
    return;
  }
  if (target.id === player.id) {
    // The source's own answer, worth keeping word for word.
    send(player.id, { t: 'log', channel: 'error', text: 'What about fleeing instead?' });
    return;
  }
  if (player.fighting === target.id) {
    send(player.id, { t: 'log', channel: 'error', text: 'How can you rescue someone you are trying to kill?' });
    return;
  }
  if (sim.affectsOf(player, 'off_balance').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You have not recovered your balance yet.' });
    return;
  }
  // The empty case is a refusal, not a fumble: no lag, no roll, no notch — the source reaches
  // `CharWait` only when somebody was found.
  if (!attackersOf(sim, target.id).some((a) => a.id !== player.id)) {
    send(player.id, { t: 'log', channel: 'error', text: `But nobody is fighting ${target.name}&N?` });
    return;
  }

  // The cost is the attempt, exactly as bash and kick charge it: one round off balance, set before
  // the roll can fail. `CharWait(ch, PULSE_VIOLENCE)`.
  const lagMs = Math.round(ROUND_MS);
  sim.addAffect(player, newAffect({ type: 'off_balance', durationMs: lagMs, flags: AffectFlag.NoSave }));

  const learned = learnedAt(player.skills.get('rescue'), player.level, 'rescue', classOf(player));
  // The source's shape, `||` and all — a notch forces the fumble and skips the success roll entirely.
  const fumbled = notchSkill(player, 'rescue', RESCUE_NOTCH_CHANCE) || randomInt(combatRng, 1, 100) > learned;

  // The room hears about it either way — except the rescuee, who gets their own second person line,
  // which is the TO_VICT / TO_NOTVICT split `actToRoom` alone cannot make.
  const roomExceptRescuee = [...sim.playersIn(player.roomId)].filter((p) => p.id !== target.id);

  if (fumbled) {
    send(player.id, { t: 'log', channel: 'combat', text: 'You fail the rescue.' });
    if (isPlayer(target)) {
      send(target.id, {
        t: 'log',
        channel: 'combat',
        text: `${capitalise(player.name)}&N fails miserably in their attempt to rescue you.`,
      });
    }
    for (const line of actLines(player, roomExceptRescuee, canSee, (who) => `${who} futilely tries to rescue ${target.name}&N!`)) {
      send(line.to, { t: 'log', channel: 'combat', text: line.text });
    }
    if (player.fighting !== undefined) {
      scheduler.cancel(player.id, 'swing');
      scheduler.schedule('swing', player.id, Math.max(lagMs, player.roundMs));
    }
    return;
  }

  const result = rescueFrom({ sim, scheduler, book: threat, ledger }, player, target);
  if (!result) {
    send(player.id, { t: 'log', channel: 'error', text: `But nobody is fighting ${target.name}&N?` });
    return;
  }

  send(player.id, { t: 'log', channel: 'combat', text: '&+WBanzai! To the rescue...&N' });
  if (isPlayer(target)) {
    send(target.id, {
      t: 'log',
      channel: 'combat',
      text: `&+WYou are rescued by ${capitalise(player.name)}&+W, you are confused, but grateful!&N`,
    });
  }
  for (const line of actLines(player, roomExceptRescuee, canSee, (who) => `${who} &+Wheroically rescues ${target.name}&+W.&N`)) {
    send(line.to, { t: 'log', channel: 'combat', text: line.text });
  }

  // Pointers moved on up to three bodies; protocol 16's lesson is that every player whose pointer
  // moved gets a fresh `self` in the same beat, or their chevron lies until something else pushes one.
  for (const actor of result.changed) {
    syncEntityState(actor);
    if (isPlayer(actor)) send(actor.id, { t: 'self', view: sim.selfViewOf(actor) });
  }

  // After `engage` scheduled the opening swing, so the lag wins where it is longer — an ability never
  // shortens the round it was used in.
  scheduler.cancel(player.id, 'swing');
  scheduler.schedule('swing', player.id, Math.max(lagMs, player.roundMs));
}

/* -------------------------------------------------------------------------- */
/* Casting — Phase 20 slice 2, the wind-up                                     */
/* -------------------------------------------------------------------------- */

/**
 * A class spell leaves the book — Phase 21 slice 2, and the moment `DESIGN-spells.md`'s "until
 * classes change who knows what" arrives. The knowledge gate is `knownSpells` (class list x open
 * circles); the economy is castings per circle, checked here and **paid at completion** — the
 * source's pay-then-fizzle order, `completeCast`'s debit. A heal or a buff with no named target
 * aims at its caster; a strike wants the fight's target or a name.
 */
function castClassSpell(player: Player, spell: Spell, term: string): void {
  const identity = player.identity!;
  const opensAt = CLASSES[identity.class].casting?.opensAt ?? 1;
  const cap = slotsForCircle(player.level, opensAt, spell.circle);
  const spent = player.spentSlots.get(spell.circle) ?? 0;
  if (spent >= cap) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You have no circle-${spell.circle} castings left. Rest, and they return.`,
    });
    return;
  }

  const view = term ? resolveTarget(player, term) : undefined;
  if (term && !view) return; // `resolveTarget` has already said why.
  const supportive = spell.kind === 'heal' || spell.kind === 'buff';
  const aimed = view ? sim.get(view.id) : undefined;
  const target =
    aimed ?? (supportive ? player : player.fighting === undefined ? undefined : sim.get(player.fighting));
  // An area needs nobody named — the room is the target (`TAR_OFFAREA`); everything aimed wants
  // a body or a fight to borrow one from.
  if (!target && spell.kind !== 'area') {
    send(player.id, { t: 'log', channel: 'error', text: `Cast ${spell.name} at whom?` });
    return;
  }
  if (!supportive && target && target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: 'Aiming that at yourself seems unwise.' });
    return;
  }
  if (!supportive && target && isUntouchable(target)) {
    send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N has no quarrel with you.` });
    return;
  }

  const castMs = mobCastMs(combatRng, spell, player.level);
  if (target) faceToward(player, target.x, target.y);
  player.casting = {
    spell: spell.id,
    name: spell.name,
    remainingMs: castMs,
    totalMs: castMs,
    room: player.roomId,
    ...(target ? { target: target.id } : {}),
  };
  sim.setIntent(player.id, 0, 0);
  if (sim.clearPath(player)) send(player.id, { t: 'path', points: [] });
  scheduler.cancel(player.id, 'swing');
  if (castMs <= 0) {
    // The quick chant outruns the meter entirely — the same branch mob casting keeps for level 60.
    completeCast(player);
    return;
  }
  sim.addAffect(player, newAffect({ type: 'casting', durationMs: castMs + 1500, flags: AffectFlag.NoSave }));
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  send(player.id, { t: 'log', channel: 'combat', text: `&+CYou begin casting ${spell.name}...&N` });
  actToRoom(player, 'combat', (who) => `${who} begins casting...`);
  syncEntityState(player);
  scheduler.schedule('cast', player.id, 1000);
}

/**
 * `cast <spell> [target]` — the wind-up, before any real spell exists to wind up.
 *
 * `DESIGN-spells.md` §0 is the specification and §2's decisions bound this slice: the machinery, not
 * the magic. What is transcribed: the casting state locks every command (`permits`) and roots the
 * body (the three intent gates); the caster's auto-attacks stop — the swing is cancelled here and
 * given back when the cast ends either way, because a caster is a held piece; the wind-up re-validates
 * **once per second** on the source's own cadence (the beat is the interruption system: a changed
 * room catches every forced exit with no hook in `relocate`, and a lost footing catches bash through
 * the knockdown it already had); interruption costs nothing; and the star meter prints each beat,
 * which is the *Seen when* itself. Dropped and named: stun and silence (no such affects), the
 * ground-casting save (no such skill), the max-circle agility abort (no ability scores).
 *
 * The room's view is one line at the start and one at the end — `EntityView` carries no affects by
 * design, and a visible-states field is its own row, not this slice's. The bare room resync (`look`
 * with no argument via the client's own refresh) stays available mid-cast; everything a player *does*
 * is locked.
 */
function doCast(player: Player, rest: string): void {
  const line = rest.trim();
  if (!line) {
    send(player.id, { t: 'log', channel: 'error', text: 'Cast what?' });
    return;
  }
  if (sim.affectsOf(player, 'off_balance').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You have not recovered your balance yet.' });
    return;
  }
  // **A `no_magic` room refuses the weave before any spell is looked up** — 311 harvested rooms carry
  // the flag, and until the ranged kite made them a destination worth dragging a caster to, nothing
  // read it. The refusal is symmetric on purpose: the same silence that stops the shaman stops you.
  if (sim.room(player.roomId)?.flags?.includes('no_magic')) {
    send(player.id, { t: 'log', channel: 'error', text: '&+LSomething here smothers the weave — your magic will not answer.&N' });
    return;
  }
  // Phase 21 slice 2: what your class knows, gated by the circle your level has opened. Longest
  // name first, so `cast cure serious` is never eaten by a shorter sibling. The rig keeps
  // precedence over a real spell only when its switch is on and its own name was typed — a
  // control stays a control.
  const known = player.identity ? knownSpells(player.identity.class, player.level) : [];
  const classSpell = known
    .map((id) => SPELLS[id])
    .sort((a, b) => b.name.length - a.name.length)
    .find((spell) => line.toLowerCase().startsWith(spell.name));
  const named = line.toLowerCase().startsWith(DEV_SPELL.name);
  if (classSpell && !(DEV_CAST && named)) {
    castClassSpell(player, classSpell, line.slice(classSpell.name.length).trim());
    return;
  }
  if (!DEV_CAST || !named) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: known.length > 0 ? "You don't know that spell." : 'You know no spells.',
    });
    return;
  }

  const term = line.slice(DEV_SPELL.name.length).trim();
  const view = term ? resolveTarget(player, term) : undefined;
  if (term && !view) return; // `resolveTarget` has already said why.
  const target = view ? sim.get(view.id) : player.fighting === undefined ? undefined : sim.get(player.fighting);
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: `Cast ${DEV_SPELL.name} at whom?` });
    return;
  }
  if (target.id === player.id) {
    send(player.id, { t: 'log', channel: 'error', text: 'Aiming that at yourself seems unwise.' });
    return;
  }

  faceToward(player, target.x, target.y);
  player.casting = {
    spell: DEV_SPELL.id,
    name: DEV_SPELL.name,
    remainingMs: DEV_SPELL.castMs,
    totalMs: DEV_SPELL.castMs,
    room: player.roomId,
    target: target.id,
  };
  // Rooted from the first beat: intent zeroed, any route dropped, and the held piece stops swinging.
  sim.setIntent(player.id, 0, 0);
  if (sim.clearPath(player)) send(player.id, { t: 'path', points: [] });
  scheduler.cancel(player.id, 'swing');
  // The affect is the caster's own progress bar — `SelfView.affects` counts it down with zero client
  // work. A little slack past the true time, because the beat owns the ending and removes it
  // explicitly; the slack only ever shows if a beat is lost, which would be its own bug worth seeing.
  sim.addAffect(player, newAffect({ type: 'casting', durationMs: DEV_SPELL.castMs + 1500, flags: AffectFlag.NoSave }));
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });

  send(player.id, { t: 'log', channel: 'combat', text: `&+CYou begin casting ${DEV_SPELL.name}...&N` });
  actToRoom(player, 'combat', (who) => `${who} begins casting...`);
  // Protocol 22: the room sees the pose, not just the sentence — the view now carries `casting`.
  syncEntityState(player);
  scheduler.schedule('cast', player.id, 1000);
}

/**
 * `recite <scroll> [target]` — **Phase 20 slice 4**, and the first way a *player* casts a registry
 * spell. `do_recite` (`actoth.c:4166-4278`), transcribed: found in your carried things, **no class,
 * mana or memorization check of any kind** — the classless path is the whole reason scrolls carry
 * this phase (`DESIGN-spells.md` §2.1) — up to three stored spells cast **at the scroll's level**,
 * one round of lag, and the scroll burns the moment the recital starts, spells or no spells: the
 * source says the dust line first and extracts unconditionally, so a scroll aimed at nobody is a
 * scroll wasted, exactly as a cast into an empty room is paid for (§0.4's quirk, third appearance).
 *
 * No wind-up, deliberately: the source's recite is instant — the wind-up belongs to `do_cast`, and
 * a scroll trades the interruption window for the consumed item. Combat refusal is the command
 * table's (`CMD_N`, the source's own registration), so this is an opener, not combat spam.
 *
 * Per-slot skips are the source's `continue`: a slot naming a spell this world does not model yet
 * is skipped (said once, not per slot — the honest analogue of dropped-and-named), a target that
 * cannot be resolved skips that slot, and the PvP gate refuses per-slot with the scroll already
 * dust — `should_not_kill`'s own shape.
 */
function doRecite(player: Player, rest: string): void {
  const { word: scrollWord, rest: targetWord } = splitCommand(rest);
  if (!scrollWord) {
    send(player.id, { t: 'log', channel: 'error', text: 'Recite what?' });
    return;
  }
  const index = matchInventory(player.inventory, scrollWord, wordsFor);
  if (index === -1) {
    // The source's own line, and it is deliberately not "you are not carrying" — recite also reads
    // the held slot there; ours searches the bag alone until a held-item slot exists to search.
    send(player.id, { t: 'log', channel: 'error', text: 'You do not have that item.' });
    return;
  }
  const stack = player.inventory.stacks[index]!;
  const template = templateOf(stack.item);
  if (template?.type !== DURIS_ITEM.scroll || !template.scroll) {
    send(player.id, { t: 'log', channel: 'error', text: 'Recite is normally used for scrolls.' });
    return;
  }

  // The scroll burns first — dust line, room line, one round of lag, all before any spell fires.
  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  sim.setInventory(player, removed.inventory);
  send(player.id, { t: 'log', channel: 'combat', text: `You recite ${stack.item.name}&N which turns to dust in your hands.` });
  actToRoom(player, 'combat', (who) => `${who} recites ${stack.item.name}&N.`);
  sim.addAffect(player, newAffect({ type: 'off_balance', durationMs: Math.round(ROUND_MS), flags: AffectFlag.NoSave }));

  let unknown = false;
  for (const number of template.scroll.spells) {
    const spell = spellFromDurisNumber(number);
    if (!spell) {
      unknown = true;
      continue;
    }
    // Per-slot targeting, the source's parse-per-slot: the explicit word wins; without one an
    // aggressive slot falls to whoever you are fighting — which slot 1 may just have arranged, so a
    // bare `recite scroll` mid-volley keeps hitting what the first spell engaged — and a defensive
    // one falls to **yourself**, the parser's own `TAR_CHAR_DEFENSIVE` default (slice 5).
    let target: Actor | undefined;
    if (targetWord) {
      const view = resolveTarget(player, targetWord);
      if (!view) continue;
      target = sim.get(view.id);
    } else if (spell.kind === 'nuke' || spell.kind === 'area') {
      target = player.fighting === undefined ? undefined : sim.get(player.fighting);
    } else {
      target = player;
    }
    // An area asks for no target at all (`TAR_OFFAREA`); everything else with nobody to land on is
    // the source's per-slot `continue`.
    if (target && target.roomId !== player.roomId) target = undefined;
    if (spell.kind !== 'area' && !target) continue;
    if (spell.kind === 'nuke' && target) {
      if (!canBeAttacked(target)) continue;
      if (target.id === player.id) {
        // The source lets you nuke yourself; ours refuses until there is a reason to allow it —
        // self-engagement is a pointer the fight loop must never see. Named divergence.
        send(player.id, { t: 'log', channel: 'error', text: 'You cannot bring yourself to.' });
        continue;
      }
      if (!settings.pvp && isPlayer(target)) {
        send(player.id, { t: 'log', channel: 'error', text: `You cannot attack ${target.name}. Player killing is switched off.` });
        continue;
      }
    }
    if (spell.kind === 'area' && target?.id === player.id) {
      // Ice storm's own refusal, kept word for word (`magic.c:12878`).
      send(player.id, { t: 'log', channel: 'error', text: 'You suddenly decide against that, oddly enough.' });
      continue;
    }
    deliverSpell(player, spell, target, template.scroll.level);
  }
  if (unknown) {
    send(player.id, { t: 'log', channel: 'combat', text: '&+LPart of the writing speaks of magic this world does not know yet.&N' });
  }
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/**
 * `quaff <potion>` — the scroll's sibling, drunk. `do_quaff` (`actoth.c:3990-4164`), transcribed
 * with its three rules that make potions a different thing from scrolls:
 *
 * - **Everything casts on the drinker** — a potion of burning hands burns *you*, which is the
 *   source's own comedy and kept — and **areas are skipped**: *"We don't do area spells via potions
 *   unless the quaffer explodes."*
 * - **One draught per timer** (`TAG_POTION_TIMER`, three ticks): the cooldown is what keeps a bag
 *   of fifty cures from being an immortality button. The refusal is the source's own sentence.
 * - **Drinking under a sword risks the bottle**: quaffing is legal mid-fight (`CMD_Y`, where recite
 *   is refused) at a flat 50% spill — the potion gone, nothing gained, the room watching. The
 *   source sweetens the odds with dexterity, agility and luck; ours are Phase 21's ability scores,
 *   dropped and named.
 */
function doQuaff(player: Player, rest: string): void {
  const wanted = rest.trim();
  if (!wanted) {
    send(player.id, { t: 'log', channel: 'error', text: 'Quaff what?' });
    return;
  }
  const index = matchInventory(player.inventory, wanted, wordsFor);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: 'You do not have that item.' });
    return;
  }
  const stack = player.inventory.stacks[index]!;
  const template = templateOf(stack.item);
  if (template?.type !== DURIS_ITEM.potion || !template.potion) {
    send(player.id, { t: 'log', channel: 'error', text: 'You can only quaff potions.' });
    return;
  }
  if (sim.affectsOf(player, 'potion_sated').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: "&+cYou don't feel like another potion would do you any good yet.&N" });
    return;
  }

  // The spill: mid-fight, half the time, the bottle is lost and nothing else happens — no lag, no
  // timer, exactly the source's early return. Rolled before the vial leaves the bag so the two
  // consume sites cannot drift.
  if (player.fighting !== undefined && randomInt(combatRng, 0, 99) >= 50) {
    const spilled = removeAt(player.inventory, index);
    if (!spilled) return;
    sim.setInventory(player, spilled.inventory);
    send(player.id, { t: 'log', channel: 'combat', text: 'Whoops!  You spilled it!' });
    actToRoom(player, 'combat', (who) => `${who} attempts to quaff ${stack.item.name}&N, but spills it instead!`);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    rememberProgress(player);
    return;
  }

  const drunk = removeAt(player.inventory, index);
  if (!drunk) return;
  sim.setInventory(player, drunk.inventory);
  send(player.id, { t: 'log', channel: 'combat', text: `As you quaff ${stack.item.name}&N, the vial disappears in a bright &+Wflash of light!&N` });
  actToRoom(player, 'combat', (who) => `${who} &+yquaffs&N ${stack.item.name}&N.`);
  sim.addAffect(player, newAffect({ type: 'off_balance', durationMs: Math.round(ROUND_MS), flags: AffectFlag.NoSave }));
  // Three of the source's ticks at the torch calibration — thirty seconds between draughts.
  sim.addAffect(player, newAffect({ type: 'potion_sated', durationMs: 3 * MS_PER_DURIS_HOUR }));

  let unknown = false;
  for (const number of template.potion.spells) {
    const spell = spellFromDurisNumber(number);
    if (!spell) {
      unknown = true;
      continue;
    }
    if (spell.kind === 'area') continue; // The quaffer does not explode.
    deliverSpell(player, spell, player, template.potion.level);
    if (player.status === 'dead') return; // A nuke in a bottle can end the drinker; reap took over.
  }
  if (unknown) {
    send(player.id, { t: 'log', channel: 'combat', text: '&+LYou feel a slight gathering of magic within you, but part of it fades.&N' });
  }
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/**
 * `eat <food>` — the owner's fast-heal memory, and it was in the source all along: `do_eat`
 * (`actobj.c:3208-3357`) grants **regeneration** from a meal. `value[1] × 15` hit points a minute
 * (15 flat when unset), `value[2]` movement (defaulting to the hp figure), for `1 + value[0]` of
 * the source's ticks — so a great meal is a standing fast-heal that the regen soft cap
 * (`regenBonus`, the source's own anti-stacking clause) keeps honest: the white dragon egg soup's
 * ×30 lands near 85 a minute rather than 450, and fighting still zeroes everything.
 *
 * **One meal at a time** ("You feel sated already"), and 36 of the catalogue's 541 foods are
 * poisoned — `value[3]` drains instead of feeding, which is why "You feel sick" prints before the
 * numbers move. Dropped and named: the stat-food values (`value[4..6]`, STR through WIS) wait on
 * Phase 21's ability scores, and staleness timers on nothing we model.
 */
function doEat(player: Player, rest: string): void {
  const wanted = rest.trim();
  if (!wanted) {
    send(player.id, { t: 'log', channel: 'error', text: 'Eat what?' });
    return;
  }
  const index = matchInventory(player.inventory, wanted, wordsFor);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: "You can't find it!" });
    return;
  }
  const stack = player.inventory.stacks[index]!;
  const template = templateOf(stack.item);
  if (template?.type !== DURIS_ITEM.food || !template.food) {
    send(player.id, { t: 'log', channel: 'error', text: "That's not very edible, I'm afraid." });
    return;
  }
  if (sim.affectsOf(player, 'eaten').length > 0) {
    send(player.id, { t: 'log', channel: 'error', text: 'You feel sated already.' });
    return;
  }

  const eaten = removeAt(player.inventory, index);
  if (!eaten) return;
  sim.setInventory(player, eaten.inventory);
  send(player.id, { t: 'log', channel: 'system', text: `You eat ${stack.item.name}&N.` });
  actToRoom(player, 'room', (who) => `${who} eats ${stack.item.name}&N.`);

  const meal = template.food;
  const durationMs = (1 + meal.hours) * MS_PER_DURIS_HOUR;
  let hpRegen: number;
  let moveRegen: number;
  if (meal.poison > 0) {
    // The poisoned plate: the node cancels what you would have regenerated and drains on top —
    // `-value[3] - hit_regen(ch)`, transcribed against our base rather than a live read.
    send(player.id, { t: 'log', channel: 'combat', text: 'You feel &+gs&+Gi&+gc&+Gk&N.' });
    hpRegen = -(meal.poison + BASE_REGEN.hp);
    moveRegen = 0;
  } else {
    hpRegen = meal.hpBoost > 0 ? meal.hpBoost * 15 : 15;
    moveRegen = meal.moveBoost > 0 ? meal.moveBoost : hpRegen;
  }
  // Two nodes of one cause, second wind's own shape — and handed over **in one call**, which the
  // drive proved is not a style point: `addAffect`'s replace policy treats a type as one cause, so
  // a second call with the same type quietly evicted the first node, and the taster's hit points
  // crawled at the base rate while the panel said "well fed".
  const nodes = [newAffect({ type: 'eaten', durationMs, apply: 'hpRegen', modifier: hpRegen })];
  if (moveRegen !== 0) nodes.push(newAffect({ type: 'eaten', durationMs, apply: 'moveRegen', modifier: moveRegen }));
  sim.addAffect(player, nodes);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/**
 * `read <keyword>` — and in the source this is one line: `do_read` (`actinf.c:3206`) builds
 * `"at <arg>"` and calls `do_look`. Reading IS looking at an extra description; the machinery is
 * `new_look` case 7 (`actinf.c:2591-2712`), and the search order transcribed from it is fixed:
 *
 * 1. **The room's own extras** — the sign on the wall answers before anything in a bag does.
 * 2. **Worn equipment**, 3. **the bag**, 4. **the ground**, in exactly that order.
 *
 * Matching is `find_ex_description` over `isname`: **exact word, case-insensitive** — `read sig`
 * does not find a `sign`, because the live `isname` (`handler.c:908`) returns true only when the
 * search word ends where a keyword does. The two refusals are the source's own shape: a thing that
 * answered to the word but had no prose gets *"You see nothing special about it."* (the
 * `LISTOBJ_ACTIONDESC` fallback), and a word nothing answered to gets *"You do not see that
 * here."* Dropped and named: the dark-room vis gates (our light model is per-tile and
 * body-to-body, not room-wide), and `look at` routing through this same search — `look`'s
 * chain has its own order here (directions, containers, entities) and grafting extras into it is
 * its own decision for its own day.
 */
function doRead(player: Player, rest: string): void {
  const word = rest.trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!word) {
    send(player.id, { t: 'log', channel: 'error', text: 'Read what?' });
    return;
  }

  const prose = (text: string): void => send(player.id, { t: 'log', channel: 'room', text });

  const room = sim.room(player.roomId);

  // **The room's noticeboard outranks its prose** — Phase 23, `boards.c`'s machine: in the room
  // that holds the board, `read board` is the listing and `read <n>` is a message, before any
  // extra gets to answer to the same words. The source's spec-proc ran ahead of the generic
  // reader for the same reason. Elsewhere, numbers and the word "board" stay ordinary words —
  // the Anchor & Anvil's chalkboard answers to `read board` because no board stands in that room.
  if (room?.board !== undefined) {
    const posts = boards.get(room.board) ?? [];
    // **The thing the board is bolted to answers for it** — owner, 2026-08-10: *"maybe the plinth
    // can be the noticeboard that should be read."* `Room.board` has carried the posts since Phase
    // 23 and V8d stood a plinth in the same room because the prose promised one; nothing joined
    // them, so `read plinth` fell through to the granite extra and the notices were unreachable by
    // the name of the thing holding them. The Diku split survives it and is the reason the pair
    // reads well: **look at it, read what is on it.**
    const namedProp = sceneryNamed(room.scenery, word);
    const bolted = namedProp !== undefined && SCENERY[namedProp.kind].bearsBoard === true;
    if (bolted || word === 'board' || word === 'bulletin' || word === 'noticeboard') {
      for (const line of boardListing(posts)) prose(line);
      // `boards.c:306` — the one thing everyone in the square learns from a reader's back.
      actToRoom(player, 'room', (who) => `${capitalise(who)} studies the noticeboard.`);
      return;
    }
    if (/^\d+$/.test(word)) {
      for (const line of boardMessage(posts, Number(word))) prose(line);
      return;
    }
  }

  const roomHit = matchExtra(word, room?.extras);
  if (roomHit !== undefined) {
    prose(roomHit);
    return;
  }

  // The source shows the item's own line before its prose (`show_obj_to_char` with
  // `LISTOBJ_SHORTDESC`, then `page_string`) — you are told *what* you are reading off of.
  const readOff = (item: Item, text: string): void => {
    prose(`${capitalise(item.name)}&N:`);
    prose(text);
  };

  for (const worn of Object.values(player.equipped)) {
    if (!worn) continue;
    const hit = matchExtra(word, templateOf(worn)?.extras);
    if (hit !== undefined) return readOff(worn, hit);
  }
  for (const stack of player.inventory.stacks) {
    const hit = matchExtra(word, templateOf(stack.item)?.extras);
    if (hit !== undefined) return readOff(stack.item, hit);
  }
  for (const entry of visibleItemsIn(ground, player.roomId)) {
    const hit = matchExtra(word, templateOf(entry.item)?.extras);
    if (hit !== undefined) return readOff(entry.item, hit);
  }

  // No prose anywhere — but did anything at least answer to the word? The source's two refusals
  // are different sentences because they carry different information: "nothing special" says the
  // thing exists and is mute, "do not see" says the word found nothing at all.
  const answers = (item: Item): boolean => wordsFor(item).includes(word);
  const named =
    Object.values(player.equipped).some((worn) => worn !== undefined && answers(worn)) ||
    player.inventory.stacks.some((stack) => answers(stack.item)) ||
    visibleItemsIn(ground, player.roomId).some((entry) => answers(entry.item));
  send(player.id, {
    t: 'log',
    channel: 'error',
    text: named ? 'You see nothing special about it.' : 'You do not see that here.',
  });
}

/**
 * `find_ex_description` (`actinf.c:671`): the first block whose keyword list contains the word,
 * whole and case-blind. Keywords were lowercased at harvest; the caller lowercases the word.
 */
function matchExtra(word: string, extras: readonly ExtraDescription[] | undefined): string | undefined {
  if (!extras) return undefined;
  for (const extra of extras) {
    if (extra.keywords.split(/\s+/).includes(word)) return extra.text;
  }
  return undefined;
}

/** A room line about any actor — `actToRoom` for bodies that are not players, same gate, same render. */
function actAround(actor: Actor, channel: LogChannel, render: (who: string) => string, excludeId?: EntityId): void {
  const observers = [...sim.playersIn(actor.roomId)].filter((p) => p.id !== excludeId);
  for (const line of actLines(actor, observers, canSee, render)) {
    send(line.to, { t: 'log', channel, text: line.text });
  }
}

/**
 * One second of wind-up — the source's own `event_spellcast`, whose comment owns its shape: *"this is
 * simplistic part, which just checks for _most_ obvious stuff like char moving around etc. this is
 * called once / second."* The simplicity is the design: no hook in `relocate`, no hook in `bash` —
 * a forced exit changes the room and a knockdown changes the posture, and the next beat notices both.
 */
function castBeat(caster: Actor): void {
  const cast = caster.casting;
  if (!cast) return; // A stale event after a stop; `cancel` covers this, the return is the belt.

  if (caster.roomId !== cast.room) return stopCasting(caster, 'you are no longer where you began');
  if (caster.posture !== 'standing' || caster.status !== 'normal') {
    return stopCasting(caster, 'you have lost your footing');
  }
  if (cast.target !== undefined && !(isSpellId(cast.spell) && SPELLS[cast.spell].kind === 'area')) {
    // An area's named victim is incidental (`TAR_OFFAREA`) — its death does not break the wind-up,
    // because the room is the target. Everything aimed at one body still loses it with the body.
    const target = sim.get(cast.target);
    if (!target || target.roomId !== caster.roomId) return stopCasting(caster, 'your target is gone');
  }

  cast.remainingMs -= 1000;
  if (cast.remainingMs > 0) {
    // The source's star meter, one star per second left — the visible half of the wind-up. The
    // caster's own line only: a mob's telegraph is the "begins casting" the room already heard.
    if (isPlayer(caster)) {
      const stars = '*'.repeat(Math.ceil(cast.remainingMs / 1000));
      send(caster.id, { t: 'log', channel: 'combat', text: `Casting: ${cast.name} &+C${stars}&N` });
    }
    scheduler.schedule('cast', caster.id, 1000);
    return;
  }
  completeCast(caster);
}

/**
 * The cast breaks, and it costs nothing — the source's rule: the price is paid at completion, so an
 * interruption loses time and never the spell. The swing comes back if a fight is on, because the
 * held piece is released either way.
 */
function stopCasting(caster: Actor, why?: string): void {
  if (!caster.casting) return;
  delete caster.casting;
  scheduler.cancel(caster.id, 'cast');
  sim.removeAffects(caster, 'casting');
  // The pose ends with the state — protocol 22's flag rides the view.
  syncEntityState(caster);
  if (isPlayer(caster)) {
    send(caster.id, {
      t: 'log',
      channel: 'combat',
      text: `&+RYour spell is disrupted${why ? ` — ${why}` : ''}!&N`,
    });
  }
  actAround(caster, 'combat', (who) => `${who}'s spell fizzles away.`);
  if (caster.fighting !== undefined) {
    scheduler.cancel(caster.id, 'swing');
    scheduler.schedule('swing', caster.id, Math.max(MIN_ROUND_MS, caster.roundMs));
  }
  if (isPlayer(caster)) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
}

/**
 * The wind-up finishes and the rig's bolt lands — through `landBlow`, which is the entire point of
 * that seam existing: a killing bolt pays experience, leaves a corpse and clears engagements by
 * construction. Slice 3's real spells replace the rig; this path is what they inherit.
 */
function completeCast(caster: Actor): void {
  const cast = caster.casting;
  if (!cast) return;
  delete caster.casting;
  sim.removeAffects(caster, 'casting');
  // Slice 2: the casting is spent the moment the wind-up completes — before the fizzle check
  // below, which is the pay-then-fizzle order the source keeps (`DESIGN-spells.md` §0.4). Scrolls
  // never pass here (recite delivers without a wind-up), so a burnt page cannot also cost a
  // memorised casting; the rig's bolt is not a registry spell and stays costless.
  if (isPlayer(caster) && caster.identity && isSpellId(cast.spell) && knowsSpell(caster.identity.class, cast.spell, caster.level)) {
    const circle = SPELLS[cast.spell].circle;
    caster.spentSlots.set(circle, (caster.spentSlots.get(circle) ?? 0) + 1);
  }
  // Before the strike's own syncs, so observers see the pose end and the blow land in that order.
  syncEntityState(caster);

  const target = cast.target === undefined ? undefined : sim.get(cast.target);

  if (isSpellId(cast.spell) && SPELLS[cast.spell].kind === 'area') {
    // An area needs no target to land on — the fizzle below is deliberately skipped: the named
    // victim dying mid-wind-up does not stop the room from shaking (`TAR_OFFAREA`'s whole meaning).
    deliverSpell(caster, SPELLS[cast.spell], target && target.roomId === caster.roomId ? target : undefined);
    return;
  }

  if (!target || target.roomId !== caster.roomId) {
    // The pay-then-fizzle quirk is authentic (`DESIGN-spells.md` §0.4) — with nothing costing
    // anything yet, this is just the fizzle half, kept in the shape the costs will land into.
    if (isPlayer(caster)) {
      send(caster.id, { t: 'log', channel: 'combat', text: '&+RYour spell fizzles — nothing is there to strike.&N' });
    }
    resumeSwing(caster);
    return;
  }

  if (isSpellId(cast.spell)) {
    deliverSpell(caster, SPELLS[cast.spell], target);
    return;
  }

  // The rig's bolt — no gates on purpose: the machinery slice drove wind-up and interruption with it,
  // and it stays as the costless, gateless control the real spells are measured against.
  const damage = rollDice(combatRng, DEV_SPELL.damage);
  const result = landBlow({ sim, scheduler, book: threat, ledger }, caster, target, damage);
  if (isPlayer(caster)) {
    send(caster.id, {
      t: 'log',
      channel: 'combat',
      text: `&+C-=[ Your ${DEV_SPELL.name} strikes ${target.name}&N&+C for ${damage}! ]=-&N`,
    });
  }
  actAround(caster, 'combat', (who) => `${who}'s ${DEV_SPELL.name} strikes ${target.name}&N.`);
  settleStrike(caster, target, result.changed, result.death);
}

/**
 * An actor's race code, in the one namespace both halves of the world speak — a mob's harvested
 * `race` off its template, a player's from their identity, and `undefined` for a raceless legacy
 * character. Two mechanisms key on this and both must read it identically: the shrug gate
 * (`shrugChance`) and the dwarves' damage reduction (`reduceSpellDamage`). Extracted the day the
 * second arrived, because two copies of this expression is how they come to disagree.
 */
function raceCodeOf(actor: Actor): string | undefined {
  if (isMob(actor)) return mobTemplates.get(actor.vnum)?.race;
  return isPlayer(actor) && actor.identity ? RACES[actor.identity.race].code : undefined;
}

/**
 * A registry spell lands — **the two gates, in the damage order** (`DESIGN-spells.md` §1): the save
 * first, adjusting the amount by the spell's own convention, then the shrug per blow — which is why
 * magic missile's bolts arrive as a list, each facing the shrug alone (`magic.c:495-512`). A raceless
 * victim — every player until Phase 21 — never shrugs; that is the source's own shape, MR being an
 * innate and innates riding races.
 *
 * Then, after the gate has said yes, the **damage modifier**: a duergar or mountain dwarf takes 20%
 * less generic spell damage (`fight.c:3817`), silently. It is not a gate and cannot refuse a blow —
 * it only makes one smaller, which is why it sits here and not up beside the shrug.
 */
function completeSpellStrike(caster: Actor, spell: Spell, target: Actor, atLevel = caster.level): void {
  // Gate 1, once per cast: the save. Only conventions the shipped spells use are modelled.
  // `atLevel` diverges from the body's own for exactly one caller: a recited scroll casts at the
  // *scroll's* stored level (`do_recite` passes `value[0]` where `do_cast` passes `GET_LEVEL`), and
  // it feeds the save mod and the dice together because the source's `level` parameter is one value.
  let doubled = false;
  if (spell.save === 'double-on-fail') {
    // Slice 5: bless's `saves` nodes join the mod here — negative helps the defender, and the ×5
    // inside `saveFailurePercent` applies to them exactly as it does to the offensive mod.
    const mod = defaultSaveMod(atLevel, target.level, spell.circle) + sumApply(target.affects, 'saves');
    doubled = !rollSave(combatRng, target.level, mod, isMob(target));
  }
  // Gate 2's chance, computed once; rolled per blow. **Phase 21 lights the player half**: a race
  // code from the character's identity enters exactly the gate mob codes always did — the arithmetic
  // and its pinned tests unchanged, which was the whole design. A raceless legacy character still
  // never shrugs, as before the phase.
  const race = raceCodeOf(target);
  const shrug = shrugChance(race, target.level);

  const changed: Actor[] = [];
  let death: Death | undefined;
  let struck = 0;
  let shrugged = 0;
  for (const blow of rollSpellBlows(combatRng, spell.id, atLevel)) {
    if (rollShrug(combatRng, shrug)) {
      shrugged++;
      continue;
    }
    // The dwarves' 20%, then the economy translation — the source's modifier first, on source-scale
    // damage where the source applies it, and our pool divisor last. Both after the save doubling,
    // so all three compose the way the pools do.
    const reduced = reduceSpellDamage(doubled ? blow.damage * 2 : blow.damage, spell.damageType, race);
    const damage = scaleSpellDamage(reduced, isPlayer(target));
    struck += damage;
    const result = landBlow({ sim, scheduler, book: threat, ledger }, caster, target, damage);
    changed.push(...result.changed);
    if (result.death) {
      death = result.death;
      break; // The source stops the volley when the victim dies — nothing left to strike.
    }
    if (result.incapacitated) break;
  }

  emitSpellBolt(caster, target, struck);

  const spellName = `&+C${spell.name}&N`;
  if (shrugged > 0 && struck === 0) {
    if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: `${capitalise(target.name)}&N shrugs off your ${spellName}!` });
    if (isPlayer(target)) send(target.id, { t: 'log', channel: 'combat', text: `&+WYou shrug off ${caster.name}&N&+W's ${spellName}&+W!&N` });
    actAround(caster, 'combat', (who) => `${target.name}&N shrugs off ${who}'s ${spellName}.`, target.id);
  } else {
    if (isPlayer(caster)) {
      send(caster.id, { t: 'log', channel: 'combat', text: `&+C-=[ Your ${spell.name} strikes ${target.name}&N&+C for ${struck}!${doubled ? ' (no save)' : ''} ]=-&N` });
    }
    if (isPlayer(target)) {
      send(target.id, { t: 'log', channel: 'combat', text: `&+R-=[ ${capitalise(caster.name)}&N&+R's ${spell.name} strikes you for ${struck}! ]=-&N` });
    }
    actAround(caster, 'combat', (who) => `${who}'s ${spellName} strikes ${target.name}&N.`, target.id);
  }

  settleStrike(caster, target, changed, death);
}

/**
 * A spell's bolt crosses the screen — the owner's ask beside the arrow's flight: *"we are going to
 * need attack animations for spells also."* The wind-up already animates (protocol 22's spellcast
 * pose); this is the strike's half, riding the same `attackResolved` channel the arrow rides, with
 * no `swing` — the caster's arms finished their work seconds ago — and `projectile: 'bolt'` for the
 * client's tween. Sent whether the target saves or shrugs: the bolt travelled either way, and a
 * spell that visibly lands for nothing is exactly what a shrug should look like. Mob casts ride it
 * for free, so the shaman's magic missile finally looks like one.
 */
function emitSpellBolt(caster: Actor, target: Actor, struck: number): void {
  const audience = new Set([...sim.playersIn(caster.roomId), ...sim.playersIn(target.roomId)]);
  for (const observer of audience) {
    const seesCaster = observer.id === caster.id || (watching.get(observer.id)?.has(caster.id) ?? false);
    const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
    if (!seesCaster && !seesTarget) continue;
    send(observer.id, {
      t: 'attackResolved',
      attacker: caster.id,
      target: target.id,
      hit: struck > 0,
      critical: false,
      damage: struck,
      natural: 0,
      outcome: struck > 0 ? 'hit' : 'miss',
      projectile: 'bolt',
    });
  }
}

/**
 * One completed spell reaches its target — the routing seam every casting path converges on: a
 * finished wind-up (player or mob) and a recited scroll slot both land here, so the three kinds
 * cannot come to behave differently by arrival route.
 */
function deliverSpell(caster: Actor, spell: Spell, target: Actor | undefined, atLevel = caster.level): void {
  // Areas are the one kind with no required target — `TAR_OFFAREA`, castable at a room. Everything
  // else without a body to land on has already fizzled upstream; the guard is the belt.
  if (spell.kind === 'area') return completeSpellArea(caster, spell, atLevel, target);
  if (!target) return;
  switch (spell.kind) {
    case 'nuke': return completeSpellStrike(caster, spell, target, atLevel);
    case 'heal': return completeSpellHeal(caster, spell, target, atLevel);
    case 'buff': return completeSpellBuff(caster, spell, target, atLevel);
  }
}

/**
 * Whether an area reaches this body — `should_area_hit` (`utility.c:5765-5838`), transcribed in its
 * own order because the order is the design: **fighting each other outranks every exemption** (your
 * groupmate beating you is still hit by your quake), then mob-casters cannot catch mobs
 * (`utility.c:5791` — the rule that keeps a shaman's storm from clearing its own warren), the
 * caster's group is exempt, and the default is **yes** — an area is indiscriminate, and a stranger
 * standing near your fight is standing too near. Dropped and named: wraithform, riders, single-file
 * rooms and `TAG_IMMUNE_AREA`, none of which exist here yet. The PvP switch stands in for
 * `should_not_kill`, refusing player-on-player splash the same way it refuses the sword.
 */
function shouldAreaHit(caster: Actor, victim: Actor): boolean {
  if (victim.id === caster.id) return false;
  if (victim.roomId !== caster.roomId) return false;
  if (!canBeAttacked(victim)) return false;
  if (caster.fighting === victim.id || victim.fighting === caster.id) return true;
  if (isMob(caster) && isMob(victim)) return false;
  if (isPlayer(caster) && isPlayer(victim)) {
    if (!settings.pvp) return false;
    if (membersWith(grouping, caster.id).includes(victim.id)) return false;
  }
  return true;
}

/** Earthquake's ground, from the sector — `magic.c:3331-3377`'s switch, in our vocabulary. */
function quakeGround(sector: string): number {
  switch (sector) {
    case 'shallow_water':
    case 'deep_water':
    case 'underwater':
    case 'air':
    case 'astral':
      return 0; // What earthquake?
    case 'mountain':
      return 2; // Landslides.
    case 'inside':
    case 'cave':
      return 3; // The ceiling caves in — the famous reason not to cast this underground.
    default:
      return 1;
  }
}

/**
 * An area lands on the room — **slice 6, and Phase 20's last mechanism.** Two shapes under one seam:
 *
 * **Ice storm** is the `cast_as_damage_area` family (`utility.c:5916-6010`): collect everyone
 * {@link shouldAreaHit} reaches, thin the **players** by {@link areaHitCount} — never the named
 * target, never any NPC, which is why a room of thirty mobs takes thirty full hits — and land
 * `dice(min(level,36), 8)` on each survivor separately.
 *
 * **Earthquake** is its own loop (`magic.c:3318-3527`) and always was: the ground refuses water and
 * air, everyone in the room but the caster is touched, **bystanders are knocked about without
 * damage** (the agility save, or down they go with a round of lag), and genuine targets take
 * `dice(1,30)+level` felled or the sector-scaled graze if they keep their feet. The agility save is
 * rolled through our save machinery at the source's own +4 mod, named as the stand-in until ability
 * scores exist (Phase 21) — greater-race exemptions ride the same wait.
 *
 * Both shapes now pass each victim's damage through {@link reduceSpellDamage} before the pool
 * divisor, and the two areas land on opposite sides of it: an earthquake is `SPLDAM_GENERIC`
 * (`magic.c:3485`) and a dwarf takes a fifth less rock, an ice storm is `SPLDAM_COLD`
 * (`magic.c:12868`) and he takes it whole. The source applies the modifier table inside
 * `spell_damage`, which every area victim reaches one at a time — so per body, never per cast.
 */
function completeSpellArea(caster: Actor, spell: Spell, atLevel: number, named?: Actor): void {
  const bodies = [...sim.actorsIn(caster.roomId)];

  if (spell.id === 'earthquake') {
    const ground = quakeGround(sim.room(caster.roomId)?.sector ?? 'field');
    if (ground === 0) {
      if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: 'No earth to quake here, try a different spell.' });
      resumeSwing(caster);
      return;
    }
    if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: '&+yYou cause the earth to shake, crack and buckle!&N' });
    actAround(caster, 'combat', (who) => `${who} causes an &=LyEARTHQUAKE!&N`);

    let death: Death | undefined;
    const changed: Actor[] = [];
    for (const body of bodies) {
      if (body.id === caster.id) continue;
      if (!canBeAttacked(body) || body.roomId !== caster.roomId) continue;
      const kept = rollSave(combatRng, body.level, 4, isMob(body));
      if (!shouldAreaHit(caster, body)) {
        // A bystander is shaken, never harmed — the knockdown-only branch, and most of the fun.
        if (body.posture !== 'standing') continue;
        if (kept) {
          if (isPlayer(body)) send(body.id, { t: 'log', channel: 'combat', text: '&+LYou stagger, but manage to keep your balance!&N' });
          actAround(body, 'combat', (who) => `${who} staggers slightly but manages to keep their balance.`, body.id);
        } else {
          sim.setStance(body, { posture: 'sitting' });
          scheduler.cancel(body.id, 'swing');
          if (body.fighting !== undefined) scheduler.schedule('swing', body.id, Math.max(MIN_ROUND_MS, body.roundMs));
          if (isPlayer(body)) send(body.id, { t: 'log', channel: 'combat', text: '&+mYou stagger and fall to your knees!&N' });
          actAround(body, 'combat', (who) => `${who} staggers and falls to their knees!`, body.id);
          syncEntityState(body);
        }
        continue;
      }
      const rolls = rollEarthquake(combatRng, atLevel, ground);
      // Per victim, because the innate is the victim's: one dwarf in a room of six takes less
      // falling rock than the five beside him, and hears nothing about it.
      const armour = raceCodeOf(body);
      if (!kept) {
        if (isPlayer(body)) send(body.id, { t: 'log', channel: 'combat', text: '&+WYou fall and injure yourself!&N' });
        actAround(body, 'combat', (who) => `${who} crashes to the ground!`, body.id);
        const felled = scaleSpellDamage(reduceSpellDamage(rolls.felled, spell.damageType, armour), isPlayer(body));
        const result = landBlow({ sim, scheduler, book: threat, ledger }, caster, body, felled);
        changed.push(...result.changed);
        if (result.death) { death = result.death; resolveDeath(result.death); continue; }
        if (!result.incapacitated) {
          sim.setStance(body, { posture: 'sitting' });
          scheduler.cancel(body.id, 'swing');
          if (body.fighting !== undefined) scheduler.schedule('swing', body.id, Math.max(MIN_ROUND_MS, body.roundMs));
        }
        syncEntityState(body);
      } else {
        if (isPlayer(body)) send(body.id, { t: 'log', channel: 'combat', text: '&+LYou stagger and almost break your leg!&N' });
        actAround(body, 'combat', (who) => `${who} staggers and almost falls!`, body.id);
        const grazed = scaleSpellDamage(reduceSpellDamage(rolls.grazed, spell.damageType, armour), isPlayer(body));
        const result = landBlow({ sim, scheduler, book: threat, ledger }, caster, body, grazed);
        changed.push(...result.changed);
        if (result.death) { death = result.death; resolveDeath(result.death); continue; }
        syncEntityState(body);
      }
    }
    for (const actor of changed) syncEntityState(actor);
    if (caster.fighting === undefined && named && !death && canBeAttacked(named)) engage(scheduler, caster, named);
    resumeSwing(caster);
    if (isPlayer(caster)) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
    return;
  }

  // Ice storm — the `cast_as_damage_area` shape.
  if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: '&+WYou conjure a storm of ice!&N' });
  actAround(caster, 'combat', (who) => `${who} conjures an ice storm!`);

  const reached = bodies.filter((body) => shouldAreaHit(caster, body));
  const players = reached.filter((body) => isPlayer(body));
  const hit = areaHitCount(combatRng, players.length, ICE_STORM_MIN_CHANCE);
  let toSkip = players.length - hit;
  const skipped = new Set<EntityId>();
  // The source's random-walk-with-coin-flips over the victim array; ours draws from the player list
  // directly, honouring both of its rules — never the named target, and only players are thinned.
  const candidates = players.filter((p) => p.id !== named?.id);
  while (toSkip > 0 && candidates.length > 0) {
    const at = randomInt(combatRng, 0, candidates.length - 1);
    skipped.add(candidates[at]!.id);
    candidates.splice(at, 1);
    toSkip--;
  }

  for (const body of reached) {
    if (skipped.has(body.id)) continue;
    if (!canBeAttacked(body) || body.roomId !== caster.roomId) continue;
    // One bolt per victim, so a storm visibly fans out from the caster. The earthquake above sends
    // none, deliberately: the ground does its work, and a quake that shot beams would be a lie.
    emitSpellBolt(caster, body, 1);
    const armour = raceCodeOf(body);
    for (const blow of rollSpellBlows(combatRng, spell.id, atLevel)) {
      // Routed through the same pair as every other delivery, and an ice storm is `SPLDAM_COLD`, so
      // it returns the number untouched — the call is here so the *next* area spell cannot forget it.
      const dealt = scaleSpellDamage(reduceSpellDamage(blow.damage, spell.damageType, armour), isPlayer(body));
      const result = landBlow({ sim, scheduler, book: threat, ledger }, caster, body, dealt);
      if (isPlayer(body)) send(body.id, { t: 'log', channel: 'combat', text: `&+R-=[ ${capitalise(caster.name)}&N&+R's storm of ice crushes you for ${dealt}! ]=-&N` });
      if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: `&+C-=[ Your storm of ice crushes ${body.name}&N&+C for ${dealt}! ]=-&N` });
      for (const actor of result.changed) syncEntityState(actor);
      if (result.death) { resolveDeath(result.death); break; }
      syncEntityState(body);
    }
  }
  if (caster.fighting === undefined && named && canBeAttacked(named) && named.roomId === caster.roomId) engage(scheduler, caster, named);
  resumeSwing(caster);
  if (isPlayer(caster)) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
}

/**
 * A heal lands — **slice 5, and `joinBySupporting`'s second producer** (rescue was the first).
 * `heal()`'s shape (`magic.c:5858-5891`): the roll is small and level-blind, the recipient hears the
 * handler's own sentence, and helping a combatant makes their fight yours — threat rides
 * `THREAT_PER_HEAL` of what was actually restored inside `joinBySupporting`, so topping up an
 * unhurt ally costs nothing and saving a tank's life is remembered.
 */
function completeSpellHeal(caster: Actor, spell: Spell, target: Actor, atLevel: number): void {
  const amount = rollSpellHeal(combatRng, spell.id, atLevel);
  const restored = Math.max(0, Math.min(target.maxHp - target.hp, amount));
  target.hp = Math.min(target.maxHp, target.hp + amount);
  sim.refreshStatus(target, target.fighting !== undefined);

  if (isPlayer(target) && spell.felt) send(target.id, { t: 'log', channel: 'combat', text: spell.felt });
  if (isPlayer(caster) && caster.id !== target.id) {
    send(caster.id, { t: 'log', channel: 'combat', text: `&+WYour ${spell.name} restores ${target.name}&N&+W. (+${restored})&N` });
  }
  actAround(caster, 'combat', (who) => caster.id === target.id ? `${who} glows briefly with soft light.` : `${who} tends to ${target.name}&N.`, target.id);

  const joined = joinBySupporting(threat, ledger, sim, caster, target, THREAT_PER_HEAL * restored);
  for (const actor of joined) syncEntityState(actor);
  resumeSwing(caster);
  syncEntityState(target);
  if (isPlayer(target)) send(target.id, { t: 'self', view: sim.selfViewOf(target) });
  if (isPlayer(caster)) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
  // The roster is how a healer aims (protocol 21), so the number it shows must move when the heal
  // does — the tick's own roster push rides regeneration, which can be most of a minute away.
  if (isPlayer(target)) for (const id of membersWith(grouping, target.id)) pushGroup(id);
}

/**
 * A buff takes hold — slice 5's other half, and the affect registry's first spell-borne nodes.
 * The source's re-cast rule kept exactly (`magic.c:4326-4340`): already affected means the duration
 * refreshes and **the numbers are never re-rolled** — a lucky armor roll is yours to keep alive.
 * Bless is `TAR_NOCOMBAT` in its registration, so a fighting recipient refuses it by name.
 */
function completeSpellBuff(caster: Actor, spell: Spell, target: Actor, atLevel: number): void {
  if (spell.id === 'bless' && target.fighting !== undefined) {
    // The registration's TAR_NOCOMBAT half — the blessing is a rite, not a battle cry.
    if (isPlayer(caster)) send(caster.id, { t: 'log', channel: 'combat', text: 'The blessing cannot take hold in the fury of combat.' });
    resumeSwing(caster);
    return;
  }
  const rolled = rollSpellBuff(combatRng, spell.id, atLevel);
  if (!rolled) {
    resumeSwing(caster);
    return;
  }

  const existing = sim.affectsOf(target, spell.id as AffectType);
  if (existing.length > 0) {
    // The source's else-branch: glow as new, duration back to full, numbers untouched.
    for (const node of existing) node.durationMs = rolled.durationMs;
    if (isPlayer(target)) {
      send(target.id, {
        t: 'log',
        channel: 'combat',
        text: spell.id === 'armor' ? '&+WThe bands of magic armor glow as new!&N' : '&+WThe blessing is renewed!&N',
      });
    }
  } else {
    // One call for the whole cause — the eaten lesson, found the same night it was written into
    // `doEat`: per-node calls under the replace policy evict each other, and bless's `saves` node
    // had been quietly deleting its `hit` node since the slice landed.
    sim.addAffect(
      target,
      rolled.nodes.map((node) => newAffect({ type: spell.id as AffectType, durationMs: rolled.durationMs, apply: node.apply, modifier: node.modifier })),
    );
    if (isPlayer(target) && spell.felt) send(target.id, { t: 'log', channel: 'combat', text: spell.felt });
    actAround(caster, 'combat', (who) => caster.id === target.id ? `${who} is briefly outlined in soft light.` : `${who} wards ${target.name}&N.`, target.id);
  }

  // `ac` and `hit` are folded by `refitCombat`, so the profile must pass the seam now — and only a
  // player has one to refit; mobs never receive buffs until their profile learns the same fold.
  if (isPlayer(target)) refitCombat(target);
  resumeSwing(caster);
  syncEntityState(target);
  if (isPlayer(target)) send(target.id, { t: 'self', view: sim.selfViewOf(target) });
  if (isPlayer(caster) && caster.id !== target.id) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
}

/**
 * A landed blow's weapon gets its say — `weapon_proc` (`fight.c:7756-7858`), the owner's Windsong
 * ask made mechanism. Fired from its own walk of the tick's attacks, **after** the announce and
 * notch walks, so a proc that kills mid-walk cannot leave those narrating a corpse; every gate is
 * re-checked here because the walk order guarantees nothing about who is still standing.
 *
 * The source's own preconditions kept (`fight.c:7743-7760`): the blow landed (a defended blow is
 * already `hit: false`), both parties still in the room, the victim still up — **a killing blow
 * does not proc**, because the weapon has nothing left to act on.
 */
function maybeWeaponProc(outcome: AttackOutcome): void {
  if (!outcome.hit) return;
  fireWeaponProc(outcome.attacker, outcome.target, 0);
}

/**
 * One firing, and the recursion the owner remembers: *"it could proc on a proc."* The source got
 * that for free — extra hits re-entered `hit()`, whose tail is `weapon_proc` — and ours re-enters
 * here off its own volley. {@link PROC_DEPTH_CAP} is the belt the source never wore (its one
 * limiter ships disabled): the odds make a third firing rare and an eighth absurd, but a sword that
 * swings forever must be impossible, not unlikely.
 */
function fireWeaponProc(attacker: Actor, target: Actor, depth: number): void {
  if (depth >= PROC_DEPTH_CAP) return;
  // `canEngage` is the standing test (`canBeAttacked` is the target's): a felled or sleeping
  // attacker wields nothing worth hearing from. Same-room and victim-up are the source's own gate.
  if (!canEngage(attacker) || attacker.roomId !== target.roomId || !canBeAttacked(target)) return;
  // `equipped` lives on `Player` and `Mob`, not on `Actor` — `attackTypeOf`'s own narrowing.
  const weapon = isPlayer(attacker) || isMob(attacker) ? attacker.equipped.mainHand : undefined;
  const proc = weapon ? templateOf(weapon)?.proc : undefined;
  if (!proc) return;

  if (proc.t === 'spells') {
    // The harvested data path: the weapon casts. Everything below is Phase 20's own pipeline —
    // the forge hammer's earthquake IS the scroll's earthquake — at the weapon's stored level.
    if (!rollProc(combatRng, proc.oneIn)) return;
    const known = proc.spells.map((n) => spellFromDurisNumber(n)).filter((s): s is Spell => s !== undefined);
    if (known.length === 0) return; // Inert until the registry grows its spells — the scroll rule.
    const chosen = proc.pickOne ? [known[randomInt(combatRng, 0, known.length - 1)]!] : known;
    for (const spell of chosen) {
      // Aggressive magic strikes the one being hit; the rest tends the wielder (`fight.c:7831-7838`).
      const at = spell.kind === 'heal' || spell.kind === 'buff' ? attacker : target;
      deliverSpell(attacker, spell, at, proc.level);
      if (!canEngage(attacker) || !canBeAttacked(target) || target.roomId !== attacker.roomId) break;
    }
    return; // The data path never recurses: its output is spells, and a spell wields nothing.
  }

  const special = SPECIAL_PROCS[proc.id];
  if (!rollProc(combatRng, special.oneIn)) return;

  // The blade takes over. The takeover is said once; the blows then read like the blows they are.
  const weaponName = weapon!.name;
  if (isPlayer(attacker)) send(attacker.id, { t: 'log', channel: 'combat', text: special.self.replace('$p', weaponName) });
  actAround(attacker, 'combat', (who) => special.room.replace('$n', who).replace('$p', weaponName));

  // **The wielder's whole arm, not the bare dice** — owner's report (2026-08-07): proc blows read
  // 6–11 while regular swings read 30-something, because the first cut rolled the weapon's own dice
  // alone. `combat.damage` is the folded profile every ordinary swing uses (weapon + damage bonus +
  // damroll), so the blade taking over still swings like the one holding it.
  const dice = attacker.combat.damage;
  const blows = rollProcBlows(combatRng, special);
  const changed: Actor[] = [];
  let death: Death | undefined;
  for (let i = 0; i < blows; i++) {
    // **A blow of the blade's own is still a blow** — owner's report (2026-08-08): *"procced
    // attacks are also supposed to be able to crit."* The source agrees by construction: its
    // extra hits re-enter `hit()` whole, so each rolls the d20 — it can miss, and it can crit,
    // and the crit doubles the whole roll exactly as the wielder's own would. Dropped and named:
    // dodge and parry against a possessed blade are the defender's own seam and wait with the
    // defensive-proc row, and the fumble is skipped — a blade that takes over does not drop itself.
    const roll = resolveAttack(combatRng, {
      attackBonus: attacker.combat.attackBonus,
      targetAc: target.combat.armourClass,
    });
    const damage = roll.hit ? rollDamage(combatRng, dice, roll.critical) : 0;
    const result = roll.hit
      ? landBlow({ sim, scheduler, book: threat, ledger }, attacker, target, damage)
      : undefined;
    if (result) changed.push(...result.changed);
    const critically = roll.critical ? 'critically ' : '';
    if (isPlayer(attacker)) {
      send(attacker.id, {
        t: 'log',
        channel: 'combat',
        text: roll.hit
          ? `&+W-=[ ${weaponName}&N&+W ${critically}slashes ${target.name}&N&+W of its own accord for ${damage}! ]=-&N`
          : `&+W-=[ ${weaponName}&N&+W lashes out of its own accord, but misses ${target.name}&N&+W! ]=-&N`,
      });
    }
    if (isPlayer(target)) {
      send(target.id, {
        t: 'log',
        channel: 'combat',
        text: roll.hit
          ? `&+R-=[ ${capitalise(weaponName)}&N&+R ${critically}slashes you of its own accord for ${damage}! ]=-&N`
          : `&+R-=[ ${capitalise(weaponName)}&N&+R lashes out of its own accord, but misses you! ]=-&N`,
      });
    }
    // The structured form too, so the extra slashes *animate* — protocol 22's field, now carrying
    // the blow's own real d20.
    for (const observer of sim.playersIn(attacker.roomId)) {
      const seesAttacker = observer.id === attacker.id || (watching.get(observer.id)?.has(attacker.id) ?? false);
      const seesTarget = observer.id === target.id || (watching.get(observer.id)?.has(target.id) ?? false);
      if (!seesAttacker && !seesTarget) continue;
      send(observer.id, {
        t: 'attackResolved',
        attacker: attacker.id,
        target: target.id,
        hit: roll.hit,
        critical: roll.critical,
        damage,
        natural: roll.natural,
        outcome: roll.critical ? 'critical' : roll.hit ? 'hit' : 'miss',
        swing: 'slash',
      });
    }
    if (result?.death) {
      death = result.death;
      break;
    }
    if (result?.incapacitated) break;
  }
  for (const actor of changed) syncEntityState(actor);
  if (death) resolveDeath(death);
  else syncEntityState(target);
  if (isPlayer(target)) send(target.id, { t: 'self', view: sim.selfViewOf(target) });

  // The proc on the proc — off its own blows, exactly as the source's re-entered hit() had it.
  if (special.recurses && !death) fireWeaponProc(attacker, target, depth + 1);
}

/** The tail every completed strike shares: the declaration, the swing back, the syncs. */
function settleStrike(caster: Actor, target: Actor, changed: readonly Actor[], death: Death | undefined): void {
  // Never at yourself: a quaffed nuke (`do_quaff` casts everything on the drinker) damages the body
  // but must not point the fight loop at it — an engagement with both ends on one actor is a state
  // nothing downstream can read.
  if (caster.fighting === undefined && target.id !== caster.id && canBeAttacked(target)) engage(scheduler, caster, target);
  resumeSwing(caster);
  for (const actor of changed) syncEntityState(actor);
  if (death) resolveDeath(death);
  else syncEntityState(target);
  if (isPlayer(caster)) send(caster.id, { t: 'self', view: sim.selfViewOf(caster) });
}

/** The held piece released: the swing comes back on a fresh round, when there is a fight to swing in. */
function resumeSwing(caster: Actor): void {
  if (caster.fighting === undefined) return;
  scheduler.cancel(caster.id, 'swing');
  scheduler.schedule('swing', caster.id, Math.max(MIN_ROUND_MS, caster.roundMs));
}

/**
 * A mob reaches for a spell instead of its swing — `MobCastSpell`'s shape (`mobact.c:542-784`),
 * injected into `advanceCombat`'s round boundary: what a shaman knows is authored content
 * (`MobTemplate.spells`, the panel's field), the odds are {@link MOB_CAST_CHANCE}, and the wind-up
 * gets the source's level-rolled quick chant — a young shaman telegraphs, an old one is dangerous.
 */
function mobStartCast(mob: Mob, target: Actor): boolean {
  const known = mobTemplates.get(mob.vnum)?.spells;
  if (!known || known.length === 0) return false;
  // **The kite's payoff** — ranged slice 5's re-ruling. A caster dragged into one of the 311
  // `no_magic` rooms finds nothing to draw on and falls through to its swing: the fight the player
  // engineered is the fight they get. Checked per round rather than cached, because the fight can
  // drift back out of the room and the weave comes back.
  if (sim.room(mob.roomId)?.flags?.includes('no_magic')) return false;
  if (randomInt(combatRng, 1, 100) > MOB_CAST_CHANCE) return false;

  // Slice 5: what of its list this round can *use*. A heal aims inward and a whole mob wastes no
  // round topping itself up (`MobCastSpell` weighs its choices by state; this is the two-line
  // version of that judgement). Buffs are skipped by name: a mob's combat profile is template data
  // with no affect fold, and a ward that changed nothing would be a lie with a duration.
  const usable = known.filter((id) => {
    const kind = SPELLS[id].kind;
    if (kind === 'nuke' || kind === 'area') return true;
    if (kind === 'heal') return mob.hp < mob.maxHp;
    return false;
  });
  if (usable.length === 0) return false;

  const spell = SPELLS[usable[randomInt(combatRng, 0, usable.length - 1)]!];
  const castMs = mobCastMs(combatRng, spell, mob.level);
  scheduler.cancel(mob.id, 'swing');
  mob.casting = {
    spell: spell.id,
    name: spell.name,
    remainingMs: castMs,
    totalMs: castMs,
    room: mob.roomId,
    target: spell.kind === 'heal' ? mob.id : target.id,
  };
  if (castMs <= 0) {
    // Level 60+ casts instantly in the source; none of ours reaches it, but the branch is the rule.
    completeCast(mob);
    return true;
  }
  // The same shown affect a player's wind-up wears; and since protocol 22 the view itself carries
  // `casting`, so the pose reaches observers — the sync this site was missing until the animations
  // slice went looking for the machine-readable tell its own stale comment promised.
  sim.addAffect(mob, newAffect({ type: 'casting', durationMs: castMs + 1500, flags: AffectFlag.NoSave }));
  actAround(mob, 'combat', (who) => `&+C${who} begins casting...&N`);
  syncEntityState(mob);
  scheduler.schedule('cast', mob.id, 1000);
  return true;
}

/** Classic MUD single-step movement: walk one room and land in its centre. */
function stepRoom(player: Player, dir: Direction): void {
  // Reached by the `move` intent as well as the typed command, and only the latter has been through
  // the table's gate. §5: `flee` is the one way out, and it is named in the refusal.
  //
  // Casting roots you the same double way: `permits` catches the typed step, this catches the
  // keybind's intent — and a follower mid-cast whose leader walks off is *asked* to step through
  // here, so the train breaks on a casting follower with no rule of its own, which is right.
  if (player.casting) {
    send(player.id, { t: 'log', channel: 'error', text: "You're busy spellcasting!" });
    return;
  }
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

  const destination = sim.room(exit.to);

  // **Phase 16's wall, with slice 5's door in it.** Deep water is now priced rather than gated — the
  // owner's ruling (2026-08-07): anyone may swim, the surcharge in `spendMove` is what the skill
  // buys down, and a boat means you are not swimming at all. Two walls remain, each named: `fly`
  // waits for Phase 20, and **`underwater` keeps refusing** because diving is the source's *breath*
  // mechanism, not its swim skill — a rule worth building the day one of the harvest's 192
  // underwater rooms is actually loaded, and not before.
  const needs = destination ? SECTOR_REQUIRES_MOVEMENT[destination.sector] : undefined;
  if (needs === 'fly') {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: 'There is nothing to stand on. You would have to fly.',
    });
    return;
  }
  if (needs === 'swim' && destination!.sector === 'underwater') {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: 'The water closes overhead there. Diving is more than swimming, and nothing teaches it yet.',
    });
    return;
  }

  // Stamina, after that. `SECTOR_MOVE_COST` finally has a caller — a step across a bog costs more
  // than a step along a road, and running out means stopping to catch your breath rather than being
  // unable to walk at all. Since Phase 16 the cost is multiplied by what you are hauling.
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
  // Slice 5's bookkeeping — the entry shore and the stroke's notch — on the typed path exactly as on
  // the continuous one, so which key you walked with cannot change what the water knows about you.
  noteWaterCrossing(player, from);

  // **Phase 18: the train.** After the leader has actually arrived, so a follower who steps into the
  // room behind them finds them already there — and after `announceArrival`, so the order in
  // everybody's log is the order it happened in. Each follower is *asked* to make the same step
  // rather than moved, which is what makes a closed door, an empty stamina pool or a fight of their
  // own break the train correctly and with no rule of its own here.
  walkFollowers(player, from, dir);
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
  // **Seeing a body is not being able to reach it, and slice 2 made that distinction load-bearing.**
  // `visibleEntities` now also carries whoever you peeked at one room away, which is right for drawing
  // and wrong for every verb built on this: `targetsFor` feeds `resolveTarget`, and `resolveTarget`
  // feeds `kill`, `get`, `look <keyword>` and the rest — so without this filter `kill kobold` would
  // reach through a wall at something in the next room, which is a bug the reveal introduced and not a
  // feature it earned. Ranged is the one verb allowed to name them, and it asks for them by name.
  //
  // The filter is {@link nameable} rather than a predicate written here, so the rule has one home
  // and a second reader of the visible set has to choose between seeing and touching on purpose.
  const entities = nameable(visibleEntities(observer));
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
    entity.id === player.id ? [...namelistFor(entity), 'me', 'self'] : namelistFor(entity),
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
  // Directions get first refusal, which is Diku's own `search_block` order — `look e` is east even in
  // a room with an entity answering to `e`. The whole argument must name the direction, so `look in
  // quiver` and `look east wall` fall through untouched.
  const dir = directionFrom(argument);
  if (dir) {
    lookDirection(player, dir);
    return;
  }
  // Containers next, and it takes the argument whole: `look in quiver` is one request, not `look` at
  // something called "in quiver". It answers `look quiver` too when the quiver is a container, since
  // "what is in it" is the only interesting thing to say about one.
  if (lookInside(player, argument)) return;

  // **Scenery and extras, before bodies** — and until now `look` consulted neither, which is the
  // bug the plinth exposed. `do_look` (`actinf.c:2632`) walks room extras, then equipment, then
  // objects, through the same `find_ex_description` our `read` already uses; ours walked none of
  // them, so `read fountain` answered and `look fountain` said *"You do not see that here"* about
  // a fountain filling the middle of the screen. Bodies still come after, because a body is the
  // thing you are most likely to mean and nothing fixed answers to a person's name.
  const word = argument.trim().toLowerCase().split(/\s+/)[0] ?? '';
  const room = sim.room(player.roomId);
  // Authored prose outranks the catalogue: a room that wrote its own fountain gets its own words.
  const authored = matchExtra(word, room?.extras);
  if (authored !== undefined) {
    send(player.id, { t: 'log', channel: 'room', text: authored });
    return;
  }
  const prop = sceneryNamed(room ? sceneryOf(room) : undefined, word);
  if (prop) {
    send(player.id, { t: 'log', channel: 'room', text: SCENERY[prop.kind].look });
    // The one thing a noticeboard has to volunteer, or nobody learns it is readable.
    if (SCENERY[prop.kind].bearsBoard === true && room?.board !== undefined) {
      const posts = boards.get(room.board) ?? [];
      send(player.id, {
        t: 'log',
        channel: 'room',
        text:
          posts.length === 0
            ? 'Nothing is posted on it at the moment. (&+Wread board&N)'
            : `${posts.length} notice${posts.length === 1 ? ' is' : 's are'} posted on it. (&+Wread board&N)`,
      });
    }
    return;
  }

  const target = resolveTarget(player, argument);
  if (!target) return;
  describeEntity(player, target);
}

/** How a peeked room is introduced. Compass reads as bearing, vertical as relation. */
const PEEK_PHRASE: Readonly<Record<Direction, string>> = {
  north: 'To the north',
  east: 'To the east',
  south: 'To the south',
  west: 'To the west',
  up: 'Above you',
  down: 'Below you',
};

/**
 * `look <direction>` — the room one exit away, gated on *its* light rather than yours. The rules and
 * their order are `peek.ts`'s (read its header for what is the source's, what is opened deliberately,
 * and what is dropped by name); this is the rendering, plus the facing rule — peering east is dealing
 * with east, so you turn.
 */
function lookDirection(player: Player, dir: Direction): void {
  const room = sim.room(player.roomId);
  if (!room) return;
  faceDirection(player, dir);

  const outcome = peek(room, dir, {
    roomOf: (id) => sim.room(id),
    occupantsOf: (id) => [...sim.actorsIn(id)].map((a) => ({ name: a.name, carriesLight: carriesLight(a) })),
    doorAt: (id, d) => {
      const doorway = world.doorway(id, d);
      return doorway ? { name: doorway.near.door.name, closed: doorway.near.door.closed } : undefined;
    },
  });

  switch (outcome.t) {
    case 'no-exit':
      send(player.id, { t: 'log', channel: 'room', text: 'You see nothing special...' });
      return;
    // The same sentence the door tells a step, because it is the same fact about the same door.
    case 'closed-door':
      send(player.id, { t: 'log', channel: 'room', text: `${capitalise(outcome.door)} is closed.` });
      return;
    case 'nowhere':
      send(player.id, { t: 'log', channel: 'room', text: 'Swirling mists block your sight.' });
      return;
    case 'one-way':
      send(player.id, { t: 'log', channel: 'room', text: 'Something seems to be blocking your line of sight.' });
      return;
    case 'dark':
      send(player.id, { t: 'log', channel: 'room', text: "&+LIt's much too dark there for you to see!&N" });
      return;
    case 'view': {
      // **Ranged slice 2: what you just made out is now on the map, not only in the log.** Recorded
      // here rather than in `peek` because peeking is a pure question and this is a fact about one
      // player — and recorded only on `view`, so a shut door, a dark room or the world's edge reveals
      // nothing, which is the same gate the prose already passes.
      //
      // Additive while you stand still: looking west then north shows both, which is what the sentence
      // "the reveal lasts while you stay put" means when you look twice. Standing somewhere else makes
      // the whole set unreadable — see `Player.revealed`.
      player.revealed = afterLook(player.revealed, player.roomId, outcome.room.id);
      // The same diff every other arrival goes through, so a revealed body enters by `entityEnter` and
      // leaves by the ordinary rule when the set stops being readable. Nothing bespoke on the wire.
      syncEntities(player);

      if (outcome.door) {
        send(player.id, { t: 'log', channel: 'room', text: `${capitalise(outcome.door)} is open.` });
      }
      send(player.id, { t: 'log', channel: 'room', text: `&+W${PEEK_PHRASE[dir]}:&N ${outcome.room.name}` });
      if (outcome.room.description) {
        send(player.id, { t: 'log', channel: 'room', text: outcome.room.description });
      }
      // The count is the tactical information: three patrol members are one name and a number.
      if (outcome.occupants.length === 0) {
        send(player.id, { t: 'log', channel: 'room', text: 'Nobody is standing there.' });
      } else {
        const listed = outcome.occupants
          .map((o) => (o.count > 1 ? `${o.name}&N [x${o.count}]` : `${o.name}&N`))
          .join(', ');
        send(player.id, { t: 'log', channel: 'room', text: `You can make out: ${listed}.` });
      }
      return;
    }
  }
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
    // **A corpse says what is on it** — owner's ask, 2026-08-06: *"when looking at a corpse it should list
    // what items the mob has that is lootable."* Everything needed already existed; what was missing was
    // saying it, and until now the only way to learn a body held anything was to walk over and `loot` it.
    const corpse = graveyard.get(target.id);
    if (corpse) describeCorpse(player, corpse);
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
 * What a body is carrying, as `look` reports it.
 *
 * ## Three decisions, and the first two were already argued elsewhere
 *
 * **On `look`, never on the entity feed.** V2's target menu carries `EntityView.container` and its note is
 * emphatic that the flag says *is a container* and **not** *what is in it*, because *"sending contents to
 * everyone in the room would hand out the answer to the verb"*. A corpse is the opposite case and should
 * be: a mob's worn kit **is** the reward — which is why `resolveDeath` puts a mob's gear in its corpse and
 * a player's on their body — so seeing a steel long sword on a body is what makes crossing the room worth
 * doing. `look` is a deliberate act aimed at one thing, so it is the right place; the feed is not.
 *
 * **At any distance, unlike a container.** `lookInsideEntity` gates on reach — *"you can look at something
 * across the room; you cannot see inside it from there"* — and this deliberately does not. The difference
 * is real rather than convenient: a container's contents are *inside* it and a corpse's are *on* it, which
 * is the same distinction that makes the verb `search` rather than `look inside`. It also puts the choice
 * back where the owner wanted it: you learn there is something worth having, and then decide to walk over
 * — which is a decision, where "walk over to find out" is a chore.
 *
 * **The visible subset, from the first version.** Nothing is hidden yet, so today that is everything. The
 * distinction is stated now because hidden items are a placed roadmap row (`search`, `ITEM_SECRET`, and a
 * reveal roll that wants ability scores) — and if this shipped as *"everything on the body"*, that row
 * would later have to change what this one promised. Filtering happens here when there is something to
 * filter; no field is invented before it has a writer.
 */
function describeCorpse(player: Player, corpse: Corpse): void {
  if (corpse.contents.length === 0) {
    // Said rather than left silent, and it is the sentence that makes the feature worth having: **an empty
    // body is information**. Without it, "no list" would mean either *nothing on it* or *the feature did
    // not fire*, and a player cannot tell those apart.
    send(player.id, { t: 'log', channel: 'room', text: '  It has been picked clean.' });
    return;
  }
  send(player.id, { t: 'log', channel: 'room', text: '  It is carrying:' });
  for (const item of corpse.contents) {
    // Painted through the same `describeStack` the bag and the container listing use, so one body's
    // contents cannot read differently from the same items once they are in your hands. Count of one,
    // because a corpse holds items rather than stacks — the two-arrow quiver is inside a container that is
    // itself one of these.
    send(player.id, {
      t: 'log',
      channel: 'room',
      text: `    ${describeStack({ item, count: 1 }, item.uses)}`,
    });
  }
}

/**
 * An entity id, resolved the way a typed keyword is: **through this character's own visible set**.
 *
 * The client may send any number it likes, so this is the gate that makes a click no more powerful
 * than a word. `visibleEntities` is the single authority both presence and prose already resolve
 * through, so pointing at something you cannot see finds nothing, exactly as naming it would.
 */
function targetById(player: Player, id: EntityId): EntityView | undefined {
  // Through `targetsFor` rather than `visibleEntities` directly, so a **click is exactly as powerful as
  // a word** — which is this function's whole stated job. Slice 2 put peeked bodies in the visible set,
  // and reading it raw here would have let the pointer attack something a room away that no typed
  // keyword could name. The two paths share one filter rather than each keeping their own.
  return targetsFor(player).find((entity) => entity.id === id);
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

/**
 * `quest` — the whole quest interface, slice 7: spoken in a giver's room it takes, reports, or
 * turns in their quest, whichever the state calls for; spoken anywhere else it reports what you
 * carry. One verb because the source's questmasters work by conversation, and ours holds the
 * entire conversation in the states a quest can be in.
 */
function doQuest(player: Player): void {
  const giver = sim
    .actorsIn(player.roomId)
    .find((a): a is Mob => isMob(a) && questsBy(quests, a.vnum).length > 0);
  if (!giver) {
    const held = [...player.quests].filter(([, v]) => v !== 'done');
    if (held.length === 0) {
      send(player.id, { t: 'log', channel: 'system', text: 'Nobody here has work for you.' });
      return;
    }
    for (const [id, state] of held) {
      const def = quests.get(id);
      if (!def) continue;
      // **A `bring` reports too, and its progress is the bag.** This used to skip every objective that
      // was not a `kill`, so a fetch quest was one you could hold and never get a word about. The
      // number a `kill` stores is `state`; the number a `bring` has is however many of the thing you
      // are carrying right now, which is why one of these is read from the save and the other from
      // the inventory. Both print the same `n of m` line, because to a player they are the same
      // question — how far along am I.
      const done = def.objective.kind === 'kill' ? (state as number) : carriedForQuest(player.inventory, def.objective.vnum);
      send(player.id, {
        t: 'log',
        channel: 'system',
        text: `Quest "${def.name}": ${done} of ${def.objective.count} ${def.objective.what}.`,
      });
    }
    return;
  }

  for (const def of questsBy(quests, giver.vnum)) {
    const state = player.quests.get(def.id);
    if (state === 'done') {
      send(player.id, { t: 'log', channel: 'say', text: `${giver.name}&N says, 'Our business is settled.'` });
      continue;
    }
    if (state === undefined) {
      player.quests.set(def.id, 0);
      send(player.id, { t: 'log', channel: 'say', text: `${giver.name}&N says, '${def.ask}'` });
      // Both kinds now, in the sentence the `kill` already used, unchanged: the count is the
      // objective, and a fetch quest that announced itself with no number left the player to infer
      // *"one"* from silence — right by accident until it was wrong for eight nuggets.
      send(player.id, {
        t: 'log',
        channel: 'system',
        text: `Quest taken: ${objectivePhrase(def.objective)}. (Say "quest" here again when it is done.)`,
      });
      persistAdminEdit(player);
      continue;
    }
    // How far along, in the units the objective counts. A `kill` accumulates into the save file; a
    // `bring` is however much of it is in the bag at this moment — the vnum join, not a word, which is
    // the bug commit `41aecce` fixed and `carriedForQuest` now owns along with the summing that makes
    // a stack of eight read as eight.
    const done =
      def.objective.kind === 'kill'
        ? typeof state === 'number'
          ? state
          : 0
        : carriedForQuest(player.inventory, def.objective.vnum);
    if (done < def.objective.count) {
      send(player.id, {
        t: 'log',
        channel: 'say',
        text:
          def.objective.kind === 'kill'
            ? `${giver.name}&N says, 'Not done. ${def.objective.count - done} of the ${def.objective.what} still stand.'`
            : // A `bring` said nothing at all here, so short-handing a fetch quest was indistinguishable
              // from the giver having no work — you spoke and were ignored. It says the shortfall now,
              // in the same shape the kill's refusal has. *"1 more an onion"* is the wording trap:
              // a `what` authored before counting is written for a sentence with no number in it, so a
              // quest that wants one asks for the thing rather than for a quantity of it.
              def.objective.count === 1
              ? `${giver.name}&N says, 'Not yet. Bring me ${def.objective.what}.'`
              : `${giver.name}&N says, 'Not yet. Bring me ${def.objective.count - done} more ${def.objective.what}.'`,
      });
      continue;
    }
    // **The giver takes what was brought.** Exactly the count, before anything is paid, so a turn-in
    // cannot hand over the reward and leave the goods in the bag — which is what happened until now,
    // and what made one onion able to satisfy the Viscount for ever. `quest.c:145-160` does the same
    // thing with `obj_from_char` + `extract_obj`, and the prose two paragraphs down has always
    // claimed the giver *"has taken the brought thing"*.
    if (def.objective.kind === 'bring') {
      sim.setInventory(player, consumeBrought(player.inventory, def.objective.vnum, def.objective.count));
      send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    }
    player.quests.set(def.id, 'done');
    send(player.id, { t: 'log', channel: 'say', text: `${giver.name}&N says, '${def.thanks}'` });
    player.experience += def.reward.xp;
    if (def.reward.copper > 0) {
      player.purse = addCoins(player.purse, { copper: def.reward.copper });
      send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    }
    // Only when there is something to report. A quest that pays purely in an object — which is what
    // most of the harvested Duris ones do — printed *"You gain 0 experience"* over a turn-in that had
    // just handed over a ring, and `giveItem` announces the ring itself.
    if (def.reward.xp > 0 || def.reward.copper > 0) {
      send(player.id, {
        t: 'log',
        channel: 'system',
        text: `You gain ${def.reward.xp} experience${def.reward.copper > 0 ? ` and ${def.reward.copper} copper` : ''}.`,
      });
    }
    // **The item pays through `giveItem`**, the admin `give` route's own call, so a quest hands over
    // an object by exactly the path an operator does: money piles convert to coin, a full bag is
    // refused rather than dropped on the floor, and the recipient is told. A refusal is reported and
    // the quest still closes — the giver has said their piece and taken the brought thing, and a
    // turn-in that half-happens because a bag was full is worse than one that owes an item.
    if (def.reward.item !== undefined) {
      const paid = adminLive.giveItem(player, def.reward.item);
      if ('error' in paid) {
        send(player.id, { t: 'log', channel: 'error', text: `${giver.name}&N has something for you, but ${paid.error}.` });
      }
    }
    levelUpIfEarned(player);
    persistAdminEdit(player);
  }
}

/**
 * A kill counts toward whoever holds an open quest for that vnum — slice 7's one hook in the
 * award path. Progress lines ride the kill's own moment; the reward waits for the giver.
 */
function advanceKillQuests(earner: Player, vnum: number): void {
  for (const [id, state] of earner.quests) {
    if (state === 'done' || typeof state !== 'number') continue;
    const def = quests.get(id);
    if (!def || def.objective.kind !== 'kill' || def.objective.vnum !== vnum) continue;
    if (state >= def.objective.count) continue;
    const next = state + 1;
    earner.quests.set(id, next);
    send(earner.id, {
      t: 'log',
      channel: 'system',
      text:
        next >= def.objective.count
          ? `&+YQuest "${def.name}" complete — return to your patron.&N`
          : `Quest "${def.name}": ${next} of ${def.objective.count} ${def.objective.what}.`,
    });
  }
}

/**
 * `gossip <text>` — the world-wide hum, Phase 21's first channel. Every player hears it, named,
 * ungated by rooms or sight: a channel is a voice over the world, not a sound in it, which is why
 * none of these three set `from`/`speech` — nothing should draw a bubble over a body for words
 * that did not pass through the room's air.
 */
function doGossip(player: Player, rest: string): void {
  const text = rest.trim();
  if (!text) {
    send(player.id, { t: 'log', channel: 'error', text: 'Gossip what?' });
    return;
  }
  for (const listener of sim.allPlayers()) {
    send(listener.id, {
      t: 'log',
      channel: 'gossip',
      text:
        listener.id === player.id
          ? `&+mYou gossip, '${text}'&N`
          : `&+m${player.name} gossips, '${text}'&N`,
    });
  }
}

/** The delivery both `tell` and `reply` share; the recipient's `replyTo` is the whole state. */
function deliverTell(from: Player, to: Player, text: string): void {
  send(to.id, { t: 'log', channel: 'tell', text: `&+c${from.name} tells you, '${text}'&N` });
  send(from.id, { t: 'log', channel: 'tell', text: `&+cYou tell ${to.name}, '${text}'&N` });
  to.replyTo = { name: from.name, mode: 'tell' };
}

/** `tell <name> <text>` — person to person, anywhere in the world. The whisper row's other half. */
function doTell(player: Player, rest: string): void {
  const { word, rest: text } = splitCommand(rest);
  const said = text.trim();
  if (!word || !said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Tell whom what?' });
    return;
  }
  const target = [...sim.allPlayers()].find(
    (p) => p.id !== player.id && p.name.toLowerCase().startsWith(word.toLowerCase()),
  );
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: 'Nobody by that name is listening.' });
    return;
  }
  deliverTell(player, target, said);
}

/**
 * `reply <text>` — answers the last person who spoke to you privately, **in the manner they used**.
 *
 * ## Why the mode is carried, when Duris does not carry it
 *
 * Duris' `do_reply` re-runs `do_tell` against `ch->only.pc->last_tell` (`actcomm.c:871-887`), and
 * `last_tell` is written in exactly one place — inside `do_tell` (`actcomm.c:1032-1033`). `do_whisper`
 * never touches it, so **in the source a whisper cannot be replied to at all**; you type the verb
 * again. That is a defensible answer, and it is not the one taken here: a private word deserves the
 * one-key answer whichever verb carried it.
 *
 * But routing a whisper's answer through `tell` — the literal "set `replyTo` and let `reply` do what
 * it always does" — would quietly change its reach mid-conversation. The room was shown *"X whispers
 * something to Y"*; a tell back leaves the room entirely, so those onlookers see the opening of a
 * conversation and never its other half. So `reply` answers a whisper **with a whisper**, and the
 * mode stored beside the name is the whole of what makes that possible.
 */
function doReply(player: Player, rest: string): void {
  const said = rest.trim();
  if (!said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Reply what?' });
    return;
  }
  const to = player.replyTo;
  if (!to) {
    send(player.id, { t: 'log', channel: 'error', text: 'Nobody has told you anything to reply to.' });
    return;
  }
  if (to.mode === 'whisper') {
    // Room-scoped on the way back, exactly as it was on the way in — `playersIn`, not `allPlayers`.
    // Leaning in to murmur needs the other person within leaning distance, and the refusal has to
    // name that rather than borrow `tell`'s "no longer here", which would read as *gone from the
    // world* when they are very often standing one room away.
    const near = [...sim.playersIn(player.roomId)].find((p) => p.id !== player.id && p.name === to.name);
    if (!near) {
      send(player.id, { t: 'log', channel: 'error', text: `${to.name} is no longer close enough to whisper to.` });
      return;
    }
    deliverWhisper(player, near, said.slice(0, 400));
    return;
  }
  const target = [...sim.allPlayers()].find((p) => p.name === to.name);
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: `${to.name} is no longer here.` });
    return;
  }
  deliverTell(player, target, said);
}

/** `gsay <text>` — the group the roster already draws, given its own line. Room-unbounded, like Duris's. */
function doGsay(player: Player, rest: string): void {
  const said = rest.trim();
  if (!said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Tell the group what?' });
    return;
  }
  const members = membersWith(grouping, player.id);
  if (members.length <= 1) {
    send(player.id, { t: 'log', channel: 'error', text: 'You are in no group.' });
    return;
  }
  for (const id of members) {
    send(id, {
      t: 'log',
      channel: 'gsay',
      text:
        id === player.id
          ? `&+GYou tell the group, '${said}'&N`
          : `&+G${player.name} tells the group, '${said}'&N`,
    });
  }
}

function listWho(player: Player): void {
  // Slice 5: worth reading now that a body is somebody — "Weststar — level 1 Mountain Dwarf Cleric".
  const names = [...sim.allPlayers()]
    .map(
      (p) =>
        `  ${p.name} — level ${p.level}` +
        (p.identity ? ` ${RACES[p.identity.race].name} ${CLASSES[p.identity.class].name}` : ''),
    )
    .sort();
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
  //
  // **V3 rides on this and adds no second send path.** `from` and `speech` go out with the very line
  // the `act()` gate already decided each person may hear, so the bubble reaches exactly the people
  // the sentence does — by construction, rather than by keeping a second recipient list in step. An
  // unseen speaker's `from` names a body their listener's client does not hold, and a bubble with
  // nothing to attach to is simply not drawn; the gate is applied once and the renderer cannot
  // disobey it.
  const speech = { from: player.id, speech: said };
  send(player.id, { t: 'log', channel: 'say', text: `You say, '${said}'`, ...speech });
  actToRoom(player, 'say', (who) => `${who} says, '${said}'`, speech);
}

/**
 * `whisper <who> <what>` — one person in the room, not the whole of it.
 *
 * Owner's ask (2026-08-05), immediately after watching V3's first bubble: *"we will need a whisper
 * option so we can talk to just one person in the room… so we aren't all just talking over each
 * other and filling the room with speech bubbles."*
 *
 * ## The privacy costs nothing, and that is V3's design paying off
 *
 * V3 put `from`/`speech` **on the log line itself** rather than in a message of its own, precisely so
 * that whoever the `act()` gate picked is who gets the bubble. So a whisper needs no new mechanism at
 * all: the recipient's line carries the fields and their client draws a bubble; the room's line —
 * *"X whispers something to Y"* — carries neither and draws nothing. Nobody had to write a rule
 * saying a whisper is private. It falls out of who receives which sentence.
 *
 * ## The room learns *that* you whispered, which is Duris' call and a good one
 *
 * `do_whisper` sends `"$n whispers something to $N."` to everyone else in the room (`TO_NOTVICT`,
 * `actcomm.c:1126`). Transcribed rather than decided: whispering in company is itself a visible act,
 * and a whisper that left no trace would make a room of people unable to tell conversation from
 * conspiracy. The function is live code — no `#if` guard encloses it, and `interp.c:2631` registers
 * it in the command table unconditionally.
 *
 * `reply` answers one of these with another one; the reasoning is in {@link doReply}.
 */
function whisperTo(player: Player, rest: string): void {
  // `splitCommand` is this project's `half_chop`, and sharing it with `tell` is the point: the split
  // this hand-rolled looked for a literal space, so a tab between the name and the message swallowed
  // the whole line into the name and the whisper came back as "who do you want to whisper to".
  const { word: name, rest: text } = splitCommand(rest);
  const said = text.slice(0, 400);
  if (!name || !said) {
    send(player.id, { t: 'log', channel: 'error', text: 'Who do you want to whisper to — and what?' });
    return;
  }

  const view = resolveTarget(player, name);
  if (!view) return; // `resolveTarget` has already said why.

  if (view.id === player.id) {
    // Transcribed because it is better than anything I would have written. `do_whisper`:
    // "You can't get your mouth close enough to your ear..." — and the room watches you try.
    send(player.id, { t: 'log', channel: 'error', text: "You cannot get your mouth close enough to your own ear." });
    actToRoom(player, 'say', (who) => `${who} whispers quietly to themselves.`);
    return;
  }

  const target = sim.get(view.id);
  if (!target) {
    send(player.id, { t: 'log', channel: 'error', text: 'They are no longer here.' });
    return;
  }

  deliverWhisper(player, target, said);
}

/**
 * The three sentences a whisper makes — shared by `whisper` and by a whispered `reply`, exactly as
 * {@link deliverTell} is shared by `tell` and a told one.
 *
 * ## Why all three ride `say`, and not `tell` or a channel of whisper's own
 *
 * Considered and rejected: a `whisper` member on `LogChannel`, protocol 27, its own dim colour in the
 * client's `.ch-*` block. The discriminator is already written down a few functions up, in
 * {@link doGossip}: Phase 21's three channels are **voices over the world, not sounds in it**, which
 * is precisely why none of them sets `from`/`speech`. A whisper is the other kind of thing. It is
 * gated by the room's own {@link canSee}; `permits` refuses it from a body not upright enough to lean
 * (`STAT_RESTING + POS_SITTING`, stricter than `say`'s `POS_PRONE`); and the recipient's line *does*
 * carry `from`/`speech` and *does* draw a bubble. Every property that separates `say` from `tell`
 * puts a whisper on `say`'s side, so a third colour would be painting the wrong distinction.
 *
 * And the bump buys only that colour: `log.ts` turns a channel into a CSS class and nothing else —
 * there is no per-channel filtering to hang off it. Protocol stays at **26**.
 */
function deliverWhisper(from: Player, to: Actor, said: string): void {
  send(from.id, { t: 'log', channel: 'say', text: `You whisper '${said}' to ${to.name}&N.` });

  // **The bubble goes only here.** `from`/`speech` ride this one line, so the recipient's client is
  // the only one with anything to draw — which is the whole of the privacy, and it is the same gate
  // the sentence passes rather than a second one beside it.
  if (isPlayer(to)) {
    send(to.id, {
      t: 'log',
      channel: 'say',
      text: `${capitalise(nameSeenBy(to, from))} whispers to you, '${said}'`,
      // Only when they can actually see who it was. An unseen whisperer's line reads "someone
      // whispers to you" and there is no body on their screen to hang a bubble from anyway — but
      // saying so here keeps the two halves from ever disagreeing.
      ...(canSee(to, from) ? { from: from.id, speech: said } : {}),
    });
    // The one thing the source does not do (`do_whisper` never writes `last_tell`), and the mode is
    // carried so the answer comes back as a whisper rather than as a tell. See {@link doReply}.
    to.replyTo = { name: from.name, mode: 'whisper' };
  }

  // Everyone else: that it happened, and between whom. Never what was said. `actLinesPair` because
  // **both** names need the gate — `$n` and `$N` in the source — and it drops the whisperer and the
  // recipient itself, which is what `TO_NOTVICT` means.
  for (const line of actLinesPair(from, to, sim.playersIn(from.roomId), canSee, (who, whom) => `${who} whispers something to ${whom}&N.`)) {
    send(line.to, { t: 'log', channel: 'say', text: line.text });
  }
}

/** `open east`, or bare `open` for the door the character is facing. */
/**
 * `unlock <dir>` / `lock <dir>` — `do_unlock` and `do_lock`, arriving with Phase 26's vault.
 *
 * The key is an **object you are carrying** whose vnum is the door's `keyId`, which is what makes a
 * lock a question rather than a wall: the answer is somewhere in the world. Three refusals, the
 * source's own: no door, no lock on it, and no key in hand. A door must be **shut** to be locked —
 * `actmove.c` refuses to turn a key in an open door, and so does this, because the alternative is a
 * locked door standing open and nobody able to say what that means.
 *
 * Both ends are set, exactly as `workDoor` sets both ends of a swing: a doorway locked from one
 * side only is the asymmetry `world.doorway` exists to prevent.
 */
function keyDoorCommand(player: Player, verb: 'unlock' | 'lock', argument: string): void {
  const dir = argument ? parseDirection(argument) : player.facing;
  if (!dir) {
    send(player.id, { t: 'log', channel: 'error', text: `"${argument}" is not a direction.` });
    return;
  }
  const doorway = world.doorway(player.roomId, dir);
  if (!doorway) {
    send(player.id, { t: 'log', channel: 'error', text: `There is nothing to ${verb} ${dir}.` });
    return;
  }
  faceDirection(player, dir);
  const { near, far } = doorway;
  const name = near.door.name;
  const locking = verb === 'lock';

  if (near.door.keyId === undefined) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(name)} has no lock.` });
    return;
  }
  if (near.door.locked === locking) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `${capitalise(name)} is already ${locking ? 'locked' : 'unlocked'}.`,
    });
    return;
  }
  if (!near.door.closed) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(name)} is open — shut it first.` });
    return;
  }
  const holding = player.inventory.stacks.some((stack) => vnumOf(stack.item) === near.door.keyId);
  if (!holding) {
    send(player.id, { t: 'log', channel: 'error', text: `You do not have the key to ${name}.` });
    return;
  }

  // Both ends, the far one optional exactly as `setDoorClosed` treats it — a one-way exit has a
  // near side and nothing behind it.
  near.door.locked = locking;
  if (far) far.door.locked = locking;
  send(player.id, { t: 'log', channel: 'room', text: `You ${verb} ${name}.` });
  actToRoom(player, 'room', (who) => `${capitalise(who)} ${locking ? 'locks' : 'unlocks'} ${name}.`);
}

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
  // **Phase 20: casting owns the caster.** The source's interpreter blocks *every* command while the
  // casting bit is set (`interp.c:1440-1467`, the sentence is its own), and this single gate is why
  // one check covers the typed line and every clicked verb alike. The way out of the lockout is the
  // wind-up ending — or somebody ending it for you, which is the phase's whole tactical texture.
  if (player.casting) {
    send(player.id, { t: 'log', channel: 'error', text: "You're busy spellcasting!" });
    return false;
  }
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
function runCommand(player: Player, line: string): void {
  const budget = budgets.get(player.id);
  if (budget && !spendCommand(budget, Date.now())) {
    send(player.id, { t: 'log', channel: 'error', text: 'You are typing too fast to think straight.' });
    return;
  }

  const { word, rest } = splitCommand(line);
  if (!word) return;

  // **The confirmation is intercepted before the command table, which is `interp.c:1343` exactly.**
  // Putting `yes` and `no` in the table instead would be the obvious move and is wrong: `n` is north,
  // and a table entry would either steal it or force the refusal onto some second-choice word. Read
  // here, while an answer is actually pending, `n` means no and means north the rest of the time —
  // and no key is taken from anybody.
  const awaiting = pendingConfirm.get(player.id);
  if (awaiting !== undefined) {
    pendingConfirm.delete(player.id);
    const first = word[0];
    if (first === 'y') {
      // Re-run the line that armed it, with the answer in hand. Re-resolving rather than acting on a
      // stored reference is the point — see `pendingConfirm`.
      const { rest: confirmedRest } = splitCommand(awaiting);
      if (!permits(player, 'junk')) return;
      junkFromBag(player, confirmedRest, true);
      return;
    }
    send(player.id, { t: 'log', channel: 'system', text: 'Left alone.' });
    // **And then fall through**, so the line still does whatever it says. Duris leaves the
    // confirmation armed when the answer is neither yes nor no; this clears it, which is a deliberate
    // divergence and the safer half of it — an armed destroy that survives ten minutes of play and
    // then fires on a stray `y` is precisely the accident the owner asked for a confirmation to
    // prevent. `n` still costs nothing: it cancels, and then walks you north.
  }

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
    case 'quest': return doQuest(player);
    case 'gossip': return doGossip(player, rest);
    case 'tell': return doTell(player, rest);
    case 'reply': return doReply(player, rest);
    case 'gsay': return doGsay(player, rest);
    case 'open': return workDoorCommand(player, 'open', rest);
    case 'unlock': return keyDoorCommand(player, 'unlock', rest);
    case 'lock': return keyDoorCommand(player, 'lock', rest);
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
    case 'get': {
      // `get <thing> from <container>` splits here rather than inside the ground handler, because the
      // two are different acts against different stores that happen to share a verb — which is what
      // Diku does too (`do_get` branches on the argument count).
      const from = /^(.*?)\s+from\s+(.+)$/i.exec(rest.trim());
      if (from) return getFromSomething(player, from[1]!, from[2]!);
      // `get axe corpse` — two words and no `from`, which is how Diku writes it and how a player's fingers
      // will. Only read that way when the last word names something to take *from*, so `get long sword` on
      // a floor holding one stays a pickup rather than becoming "there is no long in your sword".
      const pair = /^(.*\S)\s+(\S+)$/.exec(rest.trim());
      if (pair && namesSomethingToTakeFrom(player, pair[2]!)) return getFromSomething(player, pair[1]!, pair[2]!);
      return getFromGround(player, rest);
    }
    case 'put': return putInContainer(player, rest);
    case 'drop': return dropFromBag(player, rest);
    case 'follow': return followCommand(player, rest);
    case 'consent': return consentCommand(player, rest);
    case 'group': return groupCommand(player, rest);
    case 'gsay': return groupSay(player, rest);
    case 'disband': return disbandCommand(player);
    case 'skills': return listSkills(player);
    case 'spells': return listSpells(player);
    // Phase 19 slice 3. One handler for both, because the difference between them is data — see
    // `COMBAT_ABILITIES`. `isCombatAbility` narrows the command name to an id rather than a cast.
    case 'bash':
    case 'kick':
      return isCombatAbility(command) ? useAbility(player, command, rest) : undefined;
    // Ranged slices 3+4 — `DESIGN-ranged.md`. Two spellings for the launcher because the owner asked
    // for both by name, and one handler for all three verbs: an arrow and a knife differ in data.
    case 'fire':
    case 'shoot':
      return rangedCommand(player, rest, false);
    case 'throw':
      return rangedCommand(player, rest, true);
    // Owner, 2026-08-09: "I logged in the wrong character." Both spellings, one farewell.
    case 'quit':
    case 'logout':
      return quitCommand(player);
    // Phase 19 slice 4. Not routed through `useAbility`: a rescue rolls no dice against a body — it
    // moves a fight, and its notch runs backwards. See `doRescue`.
    case 'rescue': return doRescue(player, rest);
    // Looking harder at what is already in front of you. No skill anywhere in `do_search` — the gate
    // is ability scores, so everyone may try and the clever are quietly better. See `search.ts`.
    case 'search': return doSearch(player, rest);
    // Phase 20 slice 2. The wind-up — see `doCast` for what is machinery and what still waits.
    case 'cast': return doCast(player, rest);
    // Phase 20 slice 4. The classless casting path — a scroll asks nothing of who you are.
    case 'recite': return doRecite(player, rest);
    // The scroll's sibling, drunk — everything lands on the drinker, and mid-fight the bottle is a bet.
    case 'quaff': return doQuaff(player, rest);
    // The meal beside the bottle — regeneration for as long as it lasts, one meal at a time.
    case 'eat': return doEat(player, rest);
    // One line in the source: reading is looking at an extra description. Room, worn, bag, ground.
    case 'read': return doRead(player, rest);
    case 'practice': return doPractice(player, rest);
    // The one command in the table that changes nothing but how you look. Bare lists, argument sets.
    case 'hair': return doHair(player, rest);
    // Never destroys on this pass: an unconfirmed junk arms the question and returns.
    case 'junk': return junkFromBag(player, rest, false);
    case 'wear': return wearFromBag(player, rest);
    case 'wield': return wieldFromBag(player, rest);
    case 'remove': return removeWorn(player, rest);
    case 'inventory': return listInventory(player);
    case 'equipment': return listEquipment(player);
    // Phase 17. All four resolve the keeper the same way, so the refusal for "there is nobody here
    // to trade with" is written once in `keeperFor` rather than four times.
    case 'whisper': return whisperTo(player, rest);
    case 'list': return listShopStock(player);
    case 'buy': return buyFromShop(player, rest);
    case 'sell': return sellToShop(player, rest);
    case 'value': return valueAtShop(player, rest);
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
  // The quest giver's refusal, said out loud — the silent half lives in `canBeAttacked` and
  // `landBlow`, where the areas already ask.
  if (isUntouchable(target)) {
    send(player.id, { t: 'log', channel: 'error', text: `${target.name}&N has no quarrel with you.` });
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
  // **The target goes out with the swing, not with the first blow.** `SelfView.target` is what the
  // client's chevron is drawn from, and `syncEntityState` carries the *entity* diff, not this. Without
  // this line the only `self` a fight produced was the one the damage sent on the round boundary, so
  // the marker appeared up to a full round after the attack — owner's report (2026-08-04): "it takes a
  // round of combat to appear. it should appear instantly." Pointing at something is the player's own
  // act and lands on their own screen immediately.
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
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
  // `corpseAnswersTo` is the shared rule, so `loot sentry` and `get axe corpse` cannot disagree about
  // which body a word means. An empty `rest` matches every one of them, which is a bare `loot`.
  const matching = here.filter((c) => corpseAnswersTo(c, rest));
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
  sim.setInventory(player, result.inventory);

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

/**
 * `get <thing> <corpse>` — **one item off a body, and leave the rest.**
 *
 * Owner's ask, 2026-08-06: *"so it just gets the axe and leaves everything else — as a way to not overload
 * your inventory."* It is the other half of the corpse listing that shipped an hour before it: you look at a
 * body, see what is on it, and take the one thing you came for. Without it `loot` is all-or-nothing, and a
 * twenty-slot bag turns a rich corpse into a problem rather than a reward.
 *
 * **Diku spells it this way, so it needs no new verb.** `do_get` takes `get <obj> <container>` where the
 * container may be a corpse — `get axe corpse` and `get axe from corpse` both land here, through the same
 * `from` split `get` already used for containers.
 *
 * ## Every refusal is `searchCorpse`'s, called rather than restated
 *
 * `lootRefusal` for whose body it is, and the reach test `lootByKeyword` applies around it — note that
 * `lootRefusal` deliberately does *not* check distance, because it is pure and reach is the caller's. Two
 * loot verbs with two ideas of whose corpse it is would be a way to rob a protected body by typing the
 * longer command.
 *
 * ## Coin comes off as coin, even when it is asked for by name
 *
 * A money pile is an *item* in `contents` until something converts it, and `searchCorpse` converts it on
 * the way past — `DESIGN-inventory.md` §8, so that a mob's four platinum cannot fill a bag slot. Naming it
 * here has to do the same, or `get coins corpse` would be the one path in the game that carries money.
 */
function getFromCorpse(player: Player, wanted: string, corpse: Corpse): void {
  const refusal = lootRefusal(corpse, player, settings.pvp);
  if (refusal || !withinReach(corpse, player.x, player.y)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: refusal === 'someone-elses'
        ? 'That is not yours to take — player corpses are protected while PvP is off.'
        : refusal === 'gone'
          ? 'That is not here.'
          : `You are not close enough to ${corpseName(corpse)}. Step over to it.`,
    });
    return;
  }
  // You kneel to the body you are taking from, not the one you were last looking at.
  faceToward(player, corpse.x, corpse.y);

  const word = wanted.trim().toLowerCase();
  // `get all corpse` — the owner's ask for the players that like to type (2026-08-07), and it is
  // Diku's own idiom. It IS `loot`, so it goes through `loot`'s whole path rather than a second
  // emptying loop that would drift from it.
  if (word === 'all') return searchCorpse(player, corpse);
  // Matched on the item's own keywords, the rule `get` off the floor and out of a container both use, so
  // `get axe corpse` works on "a chipped hand axe" without anybody typing the adjectives.
  const at = corpse.contents.findIndex((item) => item.id === word || wordsFor(item).includes(word));
  if (at === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `There is no ${wanted} on ${corpseName(corpse)}.` });
    return;
  }
  const item = corpse.contents[at]!;

  if (isMoney(templateOf(item)?.type)) {
    const gained = templateOf(item)?.coins ?? {};
    player.purse = addCoins(player.purse, gained);
    corpse.contents.splice(at, 1);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `You get &+Y${describePurse(gained)}&N from ${corpseName(corpse)}.`,
    });
  } else {
    const result = carry(player.inventory, item);
    if (!('stacks' in result)) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: `You have no room for ${item.name} — ${result.free} slot${result.free === 1 ? '' : 's'} free.`,
      });
      return;
    }
    // **Off the body before it reaches the bag**, the ordering `getFromContainer` keeps and for the same
    // reason: nothing between the two may leave one item in two places.
    corpse.contents.splice(at, 1);
    sim.setInventory(player, result);
    send(player.id, { t: 'log', channel: 'system', text: `You get ${item.name} from ${corpseName(corpse)}.` });
  }

  // **Emptied, not searched.** `looted` drives the sprite and 15b's note is explicit that it means *empty* —
  // so taking the last thing is what turns the pile into bones, while taking one of three leaves a pile,
  // which is exactly what tells the next person along there is still something here.
  if (corpse.contents.length === 0) corpse.looted = true;

  actToRoom(player, 'room', (who) => `${who} takes ${item.name} from ${corpseName(corpse)}.`);
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
 * How many of an object vnum exist **anywhere in the world**.
 *
 * The thing that unblocked `O`. Its limit is world-wide, exactly as a mob's is, and honouring it means
 * looking in every place an object can be — which is the whole reason this lives here rather than in
 * `reset.ts`: no other file can see all of them.
 *
 * Six hiding places, and leaving any one out means the world grows by one per repop for ever:
 *
 * 1. On a floor (`ground`)
 * 2. In a corpse
 * 3. In a player's bag — counting `count`, because a stack of five arrows is five
 * 4. Inside a container in a player's bag — §4's contents are still instances
 * 5. Worn by a player
 * 6. Carried or worn by a mob
 *
 * Walked fresh on each call rather than kept as a running tally. A tally would be faster and would
 * drift: every take, drop, death, decay, spill and disconnect would have to remember to adjust it, and
 * the one that forgot would be invisible until a zone quietly stopped repopping. Resets happen once a
 * zone every seventy minutes or so, against a world of a few thousand objects — this is not a hot path.
 */
function countInstances(vnum: number): number {
  const id = `obj:${vnum}`;
  let seen = 0;

  for (const entry of ground.values()) {
    if (entry.item.id === id) seen++;
    // Inside a container on the floor counts as existing. Otherwise a player could hold the world's
    // only copy of something under the limit by leaving it in a dropped sack, and the next repop would
    // mint another one.
    for (const inside of entry.held?.contents ?? []) if (inside.item.id === id) seen += inside.count;
  }
  for (const corpse of graveyard.values()) for (const item of corpse.contents) if (item.id === id) seen++;

  for (const player of sim.allPlayers()) {
    for (const stack of player.inventory.stacks) {
      if (stack.item.id === id) seen += stack.count;
      for (const inside of stack.held?.contents ?? []) if (inside.item.id === id) seen += inside.count;
    }
    for (const worn of Object.values(player.equipped)) if (worn?.id === id) seen++;
  }

  for (const actor of sim.allActors()) {
    if (!isMob(actor)) continue;
    for (const item of actor.carrying) if (item.id === id) seen++;
    for (const worn of Object.values(actor.equipped)) if (worn?.id === id) seen++;
  }
  return seen;
}

/**
 * Puts the objects a reset asked for onto their floors.
 *
 * Placed at the room's centre rather than scattered: an `O` command says *"this belongs in this room"*
 * and nothing in the file says where, so inventing a position would be inventing content. A dropped
 * thing lands where you dropped it because that is a fact; a reset object has no such fact behind it.
 */
function placeResetObjects(outcome: {
  readonly objects: readonly { readonly template: ItemTemplate; readonly room: RoomId }[];
  readonly contents: readonly { readonly template: ItemTemplate; readonly container: number }[];
}): number {
  let placed = 0;
  const rooms: RoomId[] = [];
  // What each vnum's most recently placed instance is, so a `P` can find the chest its `O` just put
  // down. Duris resolves against the last object loaded and this is that, kept per vnum because two
  // chests of the same kind in one zone must each get their own contents rather than sharing one.
  const lastPlaced = new Map<number, EntityId>();
  for (const { template, room } of outcome.objects) {
    const located = world.locate(room);
    const origin = located && world.grid(located.place)?.roomOrigins.get(room);
    if (!located || !origin) continue;
    const centre = roomCentre(origin);
    const entry = dropItem(
      ground,
      instantiate(template),
      { roomId: room, place: located.place, x: tileCentre(centre.tx), y: tileCentre(centre.ty) },
      undefined,
      DEV_DECAY_MS,
    );
    placed++;
    rooms.push(room);
    lastPlaced.set(template.vnum, entry.id);
  }

  // **The `P` half, resolved here because this is where the identities are.** `reset.ts` hands back the
  // container's vnum; the ground store is the only thing that knows which body on which floor that
  // vnum most recently became.
  for (const { template, container } of outcome.contents) {
    const id = lastPlaced.get(container);
    const entry = id === undefined ? undefined : ground.get(id);
    if (!entry) continue;
    const rule = entry.held?.rule ?? templateOf(entry.item)?.container;
    if (!rule) continue;
    const item = instantiate(template);
    const held: Held = { rule, contents: entry.held?.contents ?? [] };
    // The same refusals `put` applies, so a builder's chest cannot hold what a player could not put in
    // it — a full one stays full, and a quiver still takes only arrows.
    if (putRefusal(held, item, template.type, template.container !== undefined)) continue;
    const { held: _was, ...rest } = entry;
    ground.set(entry.id, { ...rest, held: { rule, contents: intoContents(held, item) } });
    placed++;
    rooms.push(entry.roomId);
  }
  // **Every room that received something, not just the first.** A repop scatters objects across a
  // whole zone, and syncing only `objects[0].room` left anyone standing in the other rooms unable to
  // see what had just appeared at their feet until something else made them resync. Harmless at boot,
  // where nobody is connected yet, and exactly the kind of thing that only shows up an hour in.
  for (const room of new Set(rooms)) syncEntitiesIn(room);
  return placed;
}

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
 * The words this item answers to — the authored keyword list unioned with its display name.
 *
 * This closure is what every item matcher is fed, and it is the whole fix for `wield two-handed`
 * failing on a sword authored as `sword two-handed black`: the matchers are injected with a word
 * list rather than owning a split, and this is the list. See `keywords.ts` for the measured
 * arguments — union over replacement, and the two guards.
 */
function wordsFor(item: Item): readonly string[] {
  return wordsForItem(item, templateOf(item));
}

/**
 * The words an *entity in the room* answers to — what `resolveTarget` feeds `findTarget`.
 *
 * Three kinds of view, three sources, one union rule:
 *
 * - **A mob** has an authored list on its spawn template (`['sentry', 'guard', 'watch']` on the
 *   sentry guard), and until this function nothing read it: `kill watch` found nothing with the word
 *   authored precisely so it would. The live mob does not carry the list — its `vnum` reaches the
 *   template, the same join the death spoils use.
 * - **A ground object** answers to its catalogue words, so `look sword` works on a dropped sword the
 *   moment `get sword` does — the two verbs resolving the same object by different rules is the kind
 *   of inconsistency a player reads as haunted.
 * - **Everything else** — players, corpses — answers to its display name, colour-stripped.
 */
function namelistFor(view: EntityView): readonly string[] {
  const dropped = ground.get(view.id);
  if (dropped) return wordsFor(dropped.item);
  const actor = sim.get(view.id);
  if (actor && isMob(actor)) return wordsForMob(actor.name, mobTemplates.get(actor.vnum)?.keywords);
  return wordsFromName(view.name);
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
  const weapon = weaponFrom(player.equipped, base.damage);
  // **Phase 16: the swing is the weapon's dice plus what the character is and what they are wearing.**
  // `DESIGN-progression.md` §8 — the level bonus is ours (Duris has none, and puts high-level power in
  // gear), and the damroll is Duris' own, summed across every slot rather than read off the weapon.
  // Both land on `Dice.bonus`, which already existed and is not doubled by a critical — the SRD's rule,
  // and the right one here: a crit should reward the weapon rather than the character sheet.
  // **Phase 19: what you are good at.** `floor(learned / 10)` for the skill this weapon trains — see
  // `skills.ts` for why that number is a division of `getChartoHitSkillMod` rather than a choice. Folded
  // here rather than read at swing time because this is already the one seam every kit change passes
  // through, and a notch calls it too: the six callers become seven and the fight loop learns nothing.
  // The same instance-then-template heal `attackTypeOf` performs, for the same saves: a weapon
  // minted before its template knew its class still trains the right skill.
  const mainHand = player.equipped.mainHand;
  const skill = weaponSkillFor(
    mainHand && mainHand.weaponClass === undefined && templateOf(mainHand)?.weaponClass !== undefined
      ? { weaponClass: templateOf(mainHand)!.weaponClass!, ...(mainHand.twoHanded ? { twoHanded: true as const } : {}) }
      : mainHand,
  );
  const skillBonus = skill === undefined ? 0 : toHitFrom(learnedAt(player.skills.get(skill), player.level, skill, classOf(player)));
  // **Phase 20 slice 5: what magic is doing for you, beside what the kit does.** `sumApply` over the
  // affect list — armor's node arrives already compressed through `armourBonusFrom`, so it adds in
  // our AC points exactly as a worn breastplate does, and bless's `hit` is Duris hitroll, which is
  // the same 1:1 mapping gear's `hitrollFrom` already rides. The eighth caller learns nothing new;
  // affect installs and expiries simply have to pass through this seam too, and do.
  // **Phase 21: what the character *is*, beside what they wear and know.** STR onto the swing and
  // the to-hit, DEX onto the armour class — the SRD's own places for them, folded here because this
  // is the one seam every stat-shaped fact already passes through. Zero for the identity-less, so a
  // pre-phase character fights exactly as they did the day before the phase landed.
  const strMod = player.identity ? abilityMod(player.identity.scores.str) : 0;
  const dexMod = player.identity ? abilityMod(player.identity.scores.dex) : 0;
  // **Phase 21: what the off hand brings, folded here rather than asked for at swing time.** This is
  // already the one seam every kit change and every notch passes through, so `advanceCombat` can add
  // a second blow by reading one field instead of taking a third injected lookup — and a weapon
  // swapped mid-fight or a dual-wield notch both reach the round through the call site that already
  // existed. Everything below is the same arm as the main hand: `damageBonus`, damroll and strength
  // are properties of the body, and only the dice change hands.
  const offHandSwing = offHandFrom(player, strMod);
  player.combat = {
    ...base,
    armourClass: base.armourClass + armourClassFrom(player.equipped) + sumApply(player.affects, 'ac') + dexMod,
    attackBonus:
      base.attackBonus + hitrollFrom(player.equipped) + skillBonus + sumApply(player.affects, 'hit') + strMod,
    damage: { ...weapon, bonus: weapon.bonus + player.damageBonus + damrollFrom(player.equipped) + strMod },
    ...(offHandSwing ? { offHand: offHandSwing } : {}),
  };
  player.roundMs = base.roundMs;
}

/**
 * The second blade's contribution, or nothing — **the equipment half of the dual-wield gate**.
 *
 * Three refusals, and each one is a different question the source asks in a different place:
 *
 * - **Is there a weapon there at all?** A shield, a lantern and a bare hand all give the off-hand
 *   slot nothing to swing with. `ch->equipment[WIELD2]` is the source's own test and it is a test for
 *   an *object*; ours has to be a test for dice, because our off hand legitimately holds things
 *   Duris' `WIELD2` never did.
 * - **May it ride that hand?** {@link handednessFor} again, deliberately re-asked rather than trusted
 *   from the wield. `wield … offhand` is the gate, but a save written before this phase could have a
 *   weapon sitting in `offHand` from the two-hander displacement path — and it should go on being a
 *   stat stick rather than quietly gaining a swing at the next login.
 * - **Does this character dual wield?** `ceilingFor` answers, and a **0 ceiling is the refusal** —
 *   `learnedAt` can never return anything above it, so a wizard's skill is 0 and the roll can never
 *   succeed. That is the same table `wieldOffHand` reads to say *"You lack the training"*, so the
 *   hand a character may fill and the hand that may swing cannot come to disagree.
 *
 * **Handled here and only for players**, matching `defenceOf`'s parry: the source's NPC branch is
 * `GET_LEVEL(ch) * 2`, but our mobs' off-hand slots hold harvested shields and light sources rather
 * than second weapons, so the branch would be a mechanism with no data behind it — the
 * tested-and-never-called shape this project keeps refusing. It becomes true for mobs the day one is
 * harvested with two blades, and `handednessFor` will be what notices.
 */
function offHandFrom(player: Player, strMod: number): OffHandSwing | undefined {
  const held = player.equipped.offHand;
  if (!held?.damage) return undefined;
  // Instance first, template as the heal — `attackTypeOf`'s own rule, for the same saves: a dagger
  // minted before this phase carries no `handedness`, and its catalogue entry still knows.
  if (handednessFor(held) !== 'either' && handednessFor(templateOf(held)) !== 'either') return undefined;
  const klass = classOf(player);
  if (ceilingFor('dual-wield', klass, player.level) <= 0) return undefined;
  return {
    damage: {
      ...held.damage,
      bonus: held.damage.bonus + player.damageBonus + damrollFrom(player.equipped) + strMod,
    },
    skill: learnedAt(player.skills.get('dual-wield'), player.level, 'dual-wield', klass),
  };
}

/**
 * What constitution, blood and calling add to every level's hit-point roll — Phase 21's
 * `applyExperience` seam (DESIGN-characters.md §2). The class die arrives as a temper on the
 * calibrated base curve rather than a replacement for it: +1 for the d10 classes, −1 for the d6
 * ones, so a warrior outlasts a sorcerer without either leaving the band `DESIGN-progression.md`
 * §3 tuned mob damage against.
 */
function hpLevelBonus(identity: PlayerIdentity | undefined): number {
  if (!identity) return 0;
  const die = CLASSES[identity.class].hitDie;
  const classAdjust = die >= 10 ? 1 : die <= 6 ? -1 : 0;
  return abilityMod(identity.scores.con) + RACES[identity.race].hpBonus + classAdjust;
}

/**
 * What a defender brings to the dodge and parry rolls — **Phase 19 slice 2**.
 *
 * The one place a player's skills and a mob's are both answered, which is why `combat.ts` takes it as a
 * lookup rather than reading either: a second copy of this is a second chance for the two to drift.
 *
 * **A player's numbers come through `learnedAt`**, so the level floor applies exactly as it does to a
 * weapon skill — nobody has to have practised dodging to have some. **A mob's is the source's own NPC
 * branch**, `BOUNDED(0, level * 2, 100)`, which at level 8 is 16 and gives a 3% dodge before the crowd
 * penalty: present, and small enough that it is not a stealth rebalance of every fight in the world.
 *
 * **Parry is zero for every mob**, and that is transcription rather than an omission. The source reads
 * `else if (IS_WARRIOR(vict))`, so a non-warrior NPC parries nothing at all — and we have no classes
 * until Phase 21, so every mob takes the `else`. Same shape as `attackBonusFor`'s untaken `martial`
 * branch, erring the same safe way, and it becomes true for warriors the day the class column is read.
 */
function defenceOf(defender: Actor): DefenceSkills {
  if (!isPlayer(defender)) {
    return { dodge: mobDefenceSkill(defender.level), parry: 0, weapon: 0, armed: false };
  }
  const mainHand = defender.equipped.mainHand;
  const weaponSkill = weaponSkillFor(mainHand);
  // **The bow-tank penalty — `fight.c:8763`, transcribed on the owner's ask (2026-08-09).** *"Much
  // harder to parry with fireweapons like a bow, but not impossible"*: the source divides the whole
  // parry value by ten when the wielded thing is a fireweapon, and that is most of what makes
  // standing in melee with a bow a decision rather than a loadout. The other half of the source's
  // punishment — swings at skill zero — we already have by construction: a launcher has no weapon
  // class, so `weaponSkill` below is undefined and both the to-hit fold and the `weapon` half of the
  // parry chance are already nothing. `wield <sword>` is combat-legal, which is the one-command way
  // out the penalty exists to make worth taking. Instance first, template healed under it — the same
  // launcher test `shootAt` uses.
  const wieldingFireweapon = (mainHand?.fires ?? (mainHand ? templateOf(mainHand)?.fires : undefined)) !== undefined;
  const parry = learnedAt(defender.skills.get('parry'), defender.level, 'parry', classOf(defender));
  return {
    dodge: learnedAt(defender.skills.get('dodge'), defender.level, 'dodge', classOf(defender)),
    parry: wieldingFireweapon ? Math.floor(parry / 10) : parry,
    weapon: weaponSkill === undefined ? 0 : learnedAt(defender.skills.get(weaponSkill), defender.level, weaponSkill, classOf(defender)),
    // **`unarmed` is a weapon skill but not a weapon.** `weaponSkillFor` answers `unarmed` for an empty
    // hand by design — that is the skill you swing *with* — but `getCharParryVal` refuses outright
    // without an object: *you do not parry a sword with your arm*. So this reads the hand, not the skill.
    armed: defender.equipped.mainHand !== undefined,
  };
}

/**
 * A defensive skill notched because it just failed — **the mirror of {@link notchFromSwing}**.
 *
 * Two differences from the offensive notch, both from the source. It fires on the **defender** rather
 * than the attacker, so being fought teaches you something even on a round where you never landed a
 * blow. And the base chances are `skill.notch.defensive` — **17 for dodge, 25 for parry** — rather than
 * the weapon notch's 6.67; `combat.ts` has already applied the source's own coin flip, so what reaches
 * here is the half of failed rolls that get to try.
 *
 * The same three gates the offensive notch keeps, and for the same reasons: nothing is learned from a
 * level-1 creature, nothing is learned in a safe room, and only players learn.
 */
function notchFromDefence(outcome: AttackOutcome): void {
  const skill = outcome.defenceNotch;
  if (skill === undefined) return;
  const { attacker, target } = outcome;
  if (!isPlayer(target)) return;
  if (attacker.level < 2) return;
  if (sim.room(target.roomId)?.flags?.includes('safe')) return;
  notchSkill(target, skill, skill === 'dodge' ? DODGE_NOTCH_CHANCE : PARRY_NOTCH_CHANCE);
}

/**
 * A landing blow teaches the arm that threw it — **Phase 19's whole Seen when**.
 *
 * Every gate here is the source's, and the order they are in matters:
 *
 * - **Players only.** A mob's proficiency is a pure function of its level (`mobWeaponSkill`), so there is
 *   nothing to raise; `notch_skill` returns on `IS_NPC` for exactly this reason.
 * - **The blow has to have landed.** `new_combat.c` notches inside the damage branch, and it is the right
 *   place: swinging at air teaches nothing.
 * - **Not against something helpless or trivial.** The source refuses a target below level 2 and a
 *   player's own pet, both anti-farming: *"This prevents players from notching up skills using images and
 *   summoned pets."* We have no pets, so the level floor is the half that transcribes.
 * - **Not in a safe room.** `notch_skill` refuses `ROOM_GUILD | ROOM_SAFE` — you cannot grind in
 *   sanctuary, which is what stops the one safe room in the world becoming a training hall.
 *
 * The roll itself, the cooldown and the refit are {@link notchSkill}'s, shared with every other way a
 * skill can be learned.
 */
function notchFromSwing(outcome: AttackOutcome): void {
  const { attacker, target } = outcome;
  if (!isPlayer(attacker) || !outcome.hit) return;
  if (target.level < 2) return;
  if (sim.room(attacker.roomId)?.flags?.includes('safe')) return;

  // **The hand that threw it is the hand that learns.** A dagger in the off hand trains `piercing-1h`
  // and not whatever the sword above it is, because the source's notch is inside `hit()` and `hit()`
  // was handed `ch->equipment[WIELD2]` — the weapon is the argument, so the weapon is what improves.
  const skill = weaponSkillFor(attacker.equipped[outcome.offHand ? 'offHand' : 'mainHand']);
  if (skill === undefined) return;
  notchSkill(attacker, skill, WEAPON_NOTCH_CHANCE);
}

/**
 * The dual-wield notch — **`notch_skill(ch, SKILL_DUAL_WIELD, 17)`, `new_combat.c:2342`**.
 *
 * **Not gated on the blow landing**, and that is the whole difference from {@link notchFromSwing}
 * above. The source puts this call on the line *before* its off-hand `hit()`, inside the branch the
 * dual roll has just won — so what teaches you is getting the second blade moving, not what it then
 * did. `outcome.offHand` is that won roll, which is why the flag rather than `hit` is the condition.
 *
 * The other three gates are the offensive notch's, unchanged and for its reasons: players only,
 * nothing is learned from a level-1 creature, and nothing is learned in a safe room.
 */
function notchFromDualWield(outcome: AttackOutcome): void {
  if (!outcome.offHand) return;
  const { attacker, target } = outcome;
  if (!isPlayer(attacker)) return;
  if (target.level < 2) return;
  if (sim.room(attacker.roomId)?.flags?.includes('safe')) return;
  notchSkill(attacker, 'dual-wield', DUAL_WIELD_NOTCH_CHANCE);
}

/**
 * Rolls one notch and, if it takes, records it — **slice 1's tail, factored out for slice 3.**
 *
 * The base chance differs by *why* you are learning (a landed blow is `WEAPON_NOTCH_CHANCE`, a verb you
 * chose is `OFFENSIVE_NOTCH_CHANCE`), and nothing else does: the cooldown, the curve, the ceiling, the
 * sentence, the refit and the save are the same however the skill was used. Two copies of this would have
 * been two places to forget the refit, which is the line that makes a notch worth anything.
 *
 * The **cooldown is read before the roll and written after it**, which is the shape `guild.c` has and the
 * only shape that behaves: reading it after would let one swing both notch and re-arm at full chance.
 *
 * Returns whether the notch took, because `rescue` needs the answer **before** its outcome: the
 * source's roll there is `notch_skill(…) || roll > skill` — a notch forces the fumble. Every other
 * caller ignores it.
 */
function notchSkill(player: Player, skill: SkillId, base: number): boolean {
  const category = SKILLS[skill].category;
  const cooldown = category === 'physical' ? 'notch_physical' : 'notch_mental';
  const learned = learnedAt(player.skills.get(skill), player.level, skill, classOf(player));
  const chance = notchChance(base, learned, ceilingFor(skill, classOf(player), player.level), {
    onCooldown: sim.affectsOf(player, cooldown).length > 0,
  });
  if (!rollNotch(combatRng, chance)) return false;

  player.skills.set(skill, learned + 1);
  sim.addAffect(
    player,
    newAffect({ type: cooldown, durationMs: NOTCH_COOLDOWN_MS[category], flags: AffectFlag.NoShow }),
  );
  // The source's own line, colour and all: `"&+cYou feel your skill in %s improving."`
  send(player.id, {
    t: 'log',
    channel: 'combat',
    text: `&+cYou feel your skill in ${SKILLS[skill].name} improving.&N`,
  });
  // **The refit is what makes the point real** for a weapon skill — `attackBonus` is folded from it — and is
  // harmless for an ability, whose damage is read at the moment it is used.
  refitCombat(player);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
  return true;
}

/**
 * `skills` — what you are good at, and how good.
 *
 * Every skill is listed, not only the ones ground past the floor, and that is the interface decision
 * worth stating: the floor means a character *has* all nine from level 1, so a list that hid the ones at
 * the floor would read as skills you have not unlocked. The floor is marked instead, which teaches the
 * mechanic — *"1h slashing 40% (free)"* says both what you have and where the earning starts.
 */
function listSkills(player: Player): void {
  const floor = skillFloor(player.level);
  const rows = SKILL_IDS.filter((id) => ceilingFor(id, classOf(player), player.level) > 0).map((id) => {
    // Slice 4's one change to the list: a zero-ceiling skill does not appear at all — a wizard's
    // sheet showing "bash 0/0 (mastered)" would be the interface lying twice in one line.
    const learned = learnedAt(player.skills.get(id), player.level, id, classOf(player));
    const ceiling = ceilingFor(id, classOf(player), player.level);
    // The owner's own format (2026-08-07): "dodge 12/50" — where you are over where this skill tops
    // out, in one glance. The notes keep saying *why* a number is what it is.
    const note = learned >= ceiling ? ' &+Y(mastered)&N' : learned <= floor ? " &+L(at your level's floor)&N" : '';
    return `  ${SKILLS[id].name.padEnd(16)} ${String(learned).padStart(3)}/${ceiling}${note}`;
  });
  // The cooldown is said out loud when it is up, because a player whose skills stopped rising deserves
  // the reason rather than a theory.
  const held = SKILL_CATEGORIES.filter((c) => sim.affectsOf(player, c === 'physical' ? 'notch_physical' : 'notch_mental').length > 0);
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: [
      'Your skills (learned / ceiling):',
      ...rows,
      ...(held.length > 0
        ? [`&+LYou have learnt something ${held.join(' and ')} recently, and are learning more slowly.&N`]
        : []),
    ].join('\n'),
  });
}

/**
 * `spells` — what magic you can call on, and honestly, from where. Owner's ask (2026-08-07):
 * *"a /spells to list spells for casters with their current levels."*
 *
 * **Nobody *knows* a spell yet, and the list says so rather than pretending.** Casters are Phase
 * 21's classes; until then the classless path is `recite`, so this prints the registry — every
 * spell the world can currently produce, by circle, with what it does — plus the scrolls in your
 * bag that can actually cast today, each with its stored level. When memorization lands, the
 * known-spells half of this display grows the practice numbers the owner's ask describes, exactly
 * as `skills` shows learned/ceiling.
 */
function listSpells(player: Player): void {
  const byCircle = [...SPELL_IDS].sort((a, b) => SPELLS[a].circle - SPELLS[b].circle || SPELLS[a].name.localeCompare(SPELLS[b].name));
  const rows = byCircle.map((id) => {
    const spell = SPELLS[id];
    const what = spell.kind === 'nuke' ? 'damage' : spell.kind === 'heal' ? 'healing' : spell.kind === 'buff' ? 'blessing' : 'the whole room';
    return `  circle ${spell.circle}  ${spell.name.padEnd(16)} &+L(${what})&N`;
  });

  // The half that can act today: scrolls in the bag, each with the level its spells cast at.
  const scrolls: string[] = [];
  for (const stack of player.inventory.stacks) {
    const template = templateOf(stack.item);
    if (template?.type !== DURIS_ITEM.scroll || !template.scroll) continue;
    const names = template.scroll.spells
      .map((n) => spellFromDurisNumber(n)?.name ?? 'something this world does not know yet')
      .join(', ');
    scrolls.push(`  ${stack.item.name}&N — ${names} &+L(casts at level ${template.scroll.level})&N`);
  }

  // Slice 2: a classed caster reads their own book — circles, castings left, the spells in each —
  // and the world catalogue steps aside for it. The classless keep the catalogue and the line that
  // used to promise them classes now names what they hold instead.
  const identity = player.identity;
  const casting = identity ? CLASSES[identity.class].casting : undefined;
  const mine: string[] = [];
  if (identity && casting) {
    const known = knownSpells(identity.class, player.level);
    const top = circleAt(player.level, casting.opensAt);
    for (let circle = 1; circle <= top; circle++) {
      const names = known.filter((id) => SPELLS[id].circle === circle).map((id) => SPELLS[id].name);
      if (names.length === 0) continue;
      const cap = slotsForCircle(player.level, casting.opensAt, circle);
      const left = cap - (player.spentSlots.get(circle) ?? 0);
      mine.push(`  circle ${circle} — ${left} of ${cap} castings: ${names.join(', ')}`);
    }
  }

  send(player.id, {
    t: 'log',
    channel: 'system',
    text: (identity && casting
      ? [
          mine.length > 0 ? 'You have committed to memory:' : 'Nothing answers you yet — your first circle is still to open.',
          ...mine,
          ...(mine.length > 0 ? ['&+LRest returns spent castings, one at a time.&N'] : []),
          ...(scrolls.length > 0 ? ['Your scrolls:', ...scrolls] : []),
        ]
      : [
          'Spells this world knows:',
          ...rows,
          '',
          '&+LYou know none of them yourself. A scroll casts for anyone: recite <scroll> [target].&N',
          ...(scrolls.length > 0 ? ['Your scrolls:', ...scrolls] : ['&+LYou are carrying no scrolls.&N']),
        ]
    ).join('\n'),
  });
}

/* -------------------------------------------------------------------------- */
/* `hair` — the one command that changes only how you look                      */
/* -------------------------------------------------------------------------- */

/**
 * `hair` — read the list; `hair <style|number>` — choose one. The owner's ask, and the first
 * appearance field a player owns rather than derives.
 *
 * The decision, the numbering and every word of the prose are `hair.ts`'s and are pure; what is here
 * is the three things that need this file — the character's *drawn* hair (only `viewOf` knows whether
 * a hood is covering it), the resync, and the room.
 *
 * **The resync is the `wear` path, deliberately, and not a second one.** `afterKitChange` is the seam
 * every kit change already passes through: it re-derives, re-sends the character sheet, publishes
 * `syncEntityState` to the wearer *and* every watcher, and hands the record to `rememberProgress`
 * (which is what persists the choice). A hair change needs the last two and gets the rest for nothing;
 * a narrower path would be a second thing to keep in step with the first.
 */
function doHair(player: Player, rest: string): void {
  const current = player.hair ?? defaultHairFor(player.name);
  // **The one fact the pure half cannot know.** Every starter kit fills the `head` slot — a cap or a
  // hood, both of which resolve to the pack's single hood mesh — and hair is drawn *under* a hood,
  // which is a closed mesh. Without saying so, a fresh character typing `hair long` watches nothing at
  // all happen and concludes the command is broken. Read off `viewOf`, the authority on what is drawn.
  const covered = (id: string): boolean => id !== BALD && sim.viewOf(player).hair === undefined;

  const outcome = hairCommand(rest, current, covered(current));
  if (outcome.t === 'list') {
    send(player.id, { t: 'log', channel: 'system', text: outcome.text });
    return;
  }
  if (outcome.t === 'refuse') {
    send(player.id, { t: 'log', channel: 'error', text: outcome.text });
    return;
  }

  player.hair = outcome.id;
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: outcome.you + (covered(outcome.id) ? ' &+LYour headgear covers it — remove it to be seen.&N' : ''),
  });
  afterKitChange(player);
  // Seen by the room as well as by the mirror, which is what makes it worth typing in company — and
  // through `actToRoom`, so an observer standing in the dark reads "someone" rather than your name.
  actToRoom(player, 'system', outcome.room);
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
  // **Phase 16: light is a fact about your hands, so it is re-derived here and nowhere else.** This
  // is the one seam every kit change already passes through, which is exactly why it is the right
  // place: a lantern can reach a hand by `wear`, by `wield`, by `get`, by a shield displacing it, by
  // an admin `give` or by a login restoring a save, and a rule installed at any one of those would be
  // missing from the other five.
  const before = player.light?.id;
  sim.syncHeldLight(player);
  const after = player.light?.id;
  if (before !== after) {
    // Announced, because `light.ts` says it must be: *"a radius that silently shrinks reads as a
    // bug"*. Both directions — the drop into the dark is the half that matters, and the lift is what
    // tells a player the thing they just picked up was worth picking up.
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: after
        ? `${capitalise(player.light!.name)} lights the way.`
        : 'You are in the dark.',
    });
  }
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
  const inRoom = visibleItemsIn(ground, player.roomId);
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
  const found = nearestMatching(here, rest, player.x, player.y, wordsFor);
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

  // **The contents come back up with it.** `carryStack` rather than `carry`, so a quiver that was put
  // down full is picked up full — and it is charged only for the quiver's own bulk, because §4's rule
  // that contents do not count against the bag holding them does not stop applying on the floor.
  const result = carryStack(player.inventory, {
    ...stackOf(entry.item),
    ...(entry.held ? { held: entry.held } : {}),
  });
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
  sim.setInventory(player, result);

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

/**
 * The container at a bag position, or nothing if that stack is not one.
 *
 * A stack becomes a container the first time something is put in it: `held` is created on demand from
 * the catalogue's rule rather than at pickup, so the 16,000 items that are *not* containers carry no
 * empty structure around, and a sack picked up before this shipped still works.
 */
function heldAt(player: Player, index: number): Held | undefined {
  const stack = player.inventory.stacks[index];
  if (!stack) return undefined;
  if (stack.held) return stack.held;
  const rule = templateOf(stack.item)?.container;
  return rule ? { rule, contents: [] } : undefined;
}

/**
 * `look in <container>`: what is inside one, in the bag or at your feet.
 *
 * **The bag is searched first**, because `look in sack` while standing on an identical sack means the
 * one you are holding — that is the one `inventory` just told you about, and reaching past it to the
 * floor would be the wrong guess in the common case.
 *
 * Returns whether it handled the argument, so {@link lookAt} can fall through to looking at a *person*
 * rather than swallowing every `look`. **The word "in" is what decides how hard it tries.** Typed, this
 * owns the request and answers for it, including the refusals. Untyped — a bare `look kobold` — it only
 * speaks when it has actually found a container, because otherwise a kobold doll lying at your feet
 * would answer *"a kobold doll is not a container"* to somebody who wanted to look at the kobold.
 */
function lookInside(player: Player, argument: string): boolean {
  // `look in quiver`, and `look inside quiver`. Without stripping these the target resolver hunts for
  // an entity literally named "in quiver" and answers "You see no in quiver here", which reads as the
  // quiver being gone rather than as the phrasing being unsupported.
  const match = /^(?:in|inside)\s+(.+)$/i.exec(argument.trim());
  const explicit = match !== null;
  const wanted = (match?.[1] ?? argument).trim();
  if (!wanted) return false;

  // Through the same resolver `put` and `get … from` use, so the bag-before-floor precedence is one
  // rule in one place rather than three copies that drift.
  const lookup = resolveContainer(player, wanted);
  if (lookup.found === 'container') {
    const { ref } = lookup;
    describeContents(player, ref.item, ref.held, ref.where === 'bag' ? 'You are carrying' : 'Lying here');
    return true;
  }

  if (!explicit) return false;
  // **"Not a container" and "not here" are different answers and a player can act on the difference.**
  // Collapsing them told somebody holding a blowgun needle that they had no needle, which sends them
  // looking for a thing that is already in their hand.
  send(player.id, {
    t: 'log',
    channel: 'error',
    text:
      lookup.found === 'not-a-container'
        ? `${capitalise(lookup.item.name)} is not a container.`
        : `You see no ${wanted} to look inside.`,
  });
  return true;
}

/**
 * Looking into one particular container on the floor — what the *Look inside* menu row sends.
 *
 * Takes an **id** and re-reads the store, the same discipline {@link pickUp} follows and for the same
 * reason: the sack you clicked may have been picked up in the meantime, and being told it has gone is
 * the honest answer rather than being shown what used to be in it.
 *
 * The reach gate is `get`'s, not `look`'s. You can look *at* something across the room; you cannot see
 * into it from there, and the refusal says which so the player knows to walk over.
 */
function lookInsideEntity(player: Player, id: EntityId): void {
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
  const rule = entry.held?.rule ?? templateOf(entry.item)?.container;
  if (!rule) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(entry.item.name)} is not a container.` });
    return;
  }
  faceToward(player, entry.x, entry.y);
  describeContents(player, entry.item, { rule, contents: entry.held?.contents ?? [] }, 'Lying here');
}

/** The listing itself, shared by the carried and the lying-here cases so they cannot drift apart. */
function describeContents(player: Player, item: Item, held: Held, where: string): void {
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `&+c${where}:&N ${describeContainer(item, held)}`,
  });
  if (held.contents.length === 0) {
    send(player.id, { t: 'log', channel: 'system', text: '  it is empty' });
    return;
  }
  for (const inside of held.contents) {
    send(player.id, { t: 'log', channel: 'system', text: `  - ${describeStack(inside, inside.item.uses)}` });
  }
  const free = freeInside(held);
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `  &+K${free} slot${free === 1 ? '' : 's'} free.&N`,
  });
}

/** Replaces the container at a position with a new state of it. */
function setHeld(player: Player, index: number, held: Held): void {
  const stacks = [...player.inventory.stacks];
  const stack = stacks[index];
  if (!stack) return;
  stacks[index] = { ...stack, held };
  sim.setInventory(player, { stacks, capacity: player.inventory.capacity });
}

/**
 * A container somebody named, and **which store it lives in**.
 *
 * The two are genuinely different writes — a bag position against an entity id in a shared map — and
 * collapsing them behind one "index" would be the kind of ambiguity that turned a walk key into a sack
 * the last time this file guessed at an index. The tag makes the caller say which it is writing to.
 */
type ContainerRef =
  | { readonly where: 'bag'; readonly index: number; readonly item: Item; readonly held: Held }
  | {
      readonly where: 'ground';
      readonly id: EntityId;
      readonly item: Item;
      readonly held: Held;
      /** Where it lies, carried along so turning toward it needs no second lookup that could miss. */
      readonly x: number;
      readonly y: number;
    };

/**
 * What naming a container found: one, something that is not one, or nothing.
 *
 * Three answers rather than an optional, because *"that is not a container"* and *"there is no such
 * thing here"* are different facts and a player can act on the difference — being told you have no
 * needle while holding one sends you looking for something already in your hand.
 */
type ContainerLookup =
  | { readonly found: 'container'; readonly ref: ContainerRef }
  | { readonly found: 'not-a-container'; readonly item: Item }
  | { readonly found: 'nothing' };

/**
 * Resolves a keyword to a container — **the bag first, then what is in reach on the floor**.
 *
 * One resolver for `put`, `get … from` and `look in`, so the precedence cannot drift between them.
 * The bag wins because `put arrow sack` while standing on an identical sack means the one you are
 * holding: that is the sack `inventory` just told you about, and reaching past it would be the wrong
 * guess in the common case.
 *
 * The floor half uses **`get`'s reach gate, not `look`'s**. You can look at something across the room;
 * you cannot reach into it from there.
 */
function resolveContainer(player: Player, keyword: string): ContainerLookup {
  const index = matchInventory(player.inventory, keyword, wordsFor);
  if (index !== -1) {
    const item = player.inventory.stacks[index]!.item;
    const held = heldAt(player, index);
    if (held) return { found: 'container', ref: { where: 'bag', index, item, held } };
    // Deliberately not falling through to the floor. Something you are holding by that name is what
    // you meant, and answering about a different object with the same name would be worse than saying
    // this one will not do.
    return { found: 'not-a-container', item };
  }

  const reachable = visibleItemsIn(ground, player.roomId).filter((entry) => withinPickupReach(entry, player.x, player.y));
  const entry = nearestMatching(reachable, keyword, player.x, player.y, wordsFor);
  if (!entry) return { found: 'nothing' };
  const rule = entry.held?.rule ?? templateOf(entry.item)?.container;
  if (!rule) return { found: 'not-a-container', item: entry.item };
  return {
    found: 'container',
    ref: {
      where: 'ground',
      id: entry.id,
      item: entry.item,
      held: { rule, contents: entry.held?.contents ?? [] },
      x: entry.x,
      y: entry.y,
    },
  };
}

/**
 * Writes a container's new contents back to whichever store it came from.
 *
 * **Ground entries are re-read by id before the write**, the discipline `pickUp` follows: the sack may
 * have been picked up since it was resolved, and quietly recreating it would put items into an object
 * that no longer exists. Returns whether the write happened, so a caller that has *not yet* committed
 * its own half can abandon the whole move rather than leaving the item in two places or in none.
 *
 * Empty contents drop the field entirely, which keeps `dropItem`'s invariant: `held` on a ground entry
 * means *holding something*. An emptied sack is still a sack — the rule comes back from the catalogue
 * the same way it did the first time.
 */
function writeHeld(player: Player, ref: ContainerRef, held: Held): boolean {
  if (ref.where === 'bag') {
    const stack = player.inventory.stacks[ref.index];
    if (!stack || stack.item.id !== ref.item.id) return false;
    setHeld(player, ref.index, held);
    return true;
  }
  const entry = ground.get(ref.id);
  if (!entry || entry.roomId !== player.roomId) return false;
  const { held: _was, ...rest } = entry;
  ground.set(ref.id, held.contents.length > 0 ? { ...rest, held } : rest);
  return true;
}

/** Where the container is, in the words the message wants: "in your quiver" / "in the sack here". */
function containerPhrase(ref: ContainerRef): string {
  return ref.where === 'bag' ? ref.item.name : `${ref.item.name} lying here`;
}

/** Says why a named container is unusable, in the words the two verbs share. */
function refuseContainer(player: Player, lookup: ContainerLookup, keyword: string, forPutting: boolean): void {
  send(player.id, {
    t: 'log',
    channel: 'error',
    text:
      lookup.found === 'not-a-container'
        ? `${capitalise(lookup.item.name)} is not a container.`
        : forPutting
          ? `You see no ${keyword} to put things in.`
          : `You see no ${keyword} here.`,
  });
}

/** Adds one item to a container's contents, merging rather than piling up singletons. */
function intoContents(held: Held, item: Item): Stack[] {
  const incoming = stackOf(item);
  const contents = [...held.contents];
  const at = contents.findIndex((s) => mergeable(s, incoming));
  if (at < 0) {
    contents.push(incoming);
    return contents;
  }
  const { merged, leftover } = mergeStacks(contents[at]!, incoming, limitOf(item));
  contents[at] = merged;
  if (leftover) contents.push(leftover);
  return contents;
}

/**
 * `put <item> <container>`: move something from the bag into a container — **yours or one on the
 * floor**.
 *
 * **The container's contents do not count against the bag** (§4), so this is the command that buys a
 * player space — twenty loose arrows become one quiver, and nineteen slots come back. A floor container
 * buys more than that: a chest by the door is storage you do not carry at all.
 *
 * The *item* still comes from the bag only. `put` moves one thing from your hands into a container;
 * something already on the floor is a `get` away from being in your hands, and making this verb also a
 * floor-to-floor mover would be two acts sharing a word.
 */
function putInContainer(player: Player, rest: string): void {
  // `put arrow quiver`, and also `put arrow in quiver` because a player will type it.
  const words = rest.trim().split(/\s+/).filter((w) => w.length > 0 && w.toLowerCase() !== 'in');
  if (words.length < 2) {
    send(player.id, { t: 'log', channel: 'error', text: 'Put what in what?' });
    return;
  }
  const target = words[words.length - 1]!;
  const wanted = words.slice(0, -1).join(' ');

  const lookup = resolveContainer(player, target);
  if (lookup.found !== 'container') {
    refuseContainer(player, lookup, target, true);
    return;
  }
  const ref = lookup.ref;

  const itemIndex = matchInventory(player.inventory, wanted, wordsFor);
  if (itemIndex === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${wanted}.` });
    return;
  }
  if (ref.where === 'bag' && itemIndex === ref.index) {
    send(player.id, { t: 'log', channel: 'error', text: 'It will not hold itself.' });
    return;
  }

  const item = player.inventory.stacks[itemIndex]!.item;
  const itemTemplate = templateOf(item);
  const refusal = putRefusal(ref.held, item, itemTemplate?.type, itemTemplate?.container !== undefined);
  if (refusal) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      // Three refusals, three sentences — §4's own reason for keeping them apart.
      text:
        refusal === 'too-deep'
          ? `${capitalise(item.name)} is a container, and a container does not go inside another.`
          : refusal === 'wrong-kind'
            ? `That does not belong in ${ref.item.name}.`
            : `There is no room in ${ref.item.name}.`,
    });
    return;
  }

  // **One pass over the array, because a removal does not always shift the indices.** An early version
  // removed the item and then adjusted the container's index by one — right only when the source stack
  // *emptied*. `removeAt` splices at count 1 and merely decrements above it, so putting one of five
  // eggs away shifted nothing and the adjusted index pointed at the neighbour. Found live: it made the
  // guard's walk key a container and duplicated a suit of mail into it.
  const stacks = [...player.inventory.stacks];
  const source = stacks[itemIndex]!;
  const emptied = source.count <= 1;
  if (emptied) stacks.splice(itemIndex, 1);
  else stacks[itemIndex] = { ...source, count: source.count - 1 };

  const contents = intoContents(ref.held, item);

  if (ref.where === 'bag') {
    // Only a bag container has an index to shift, and only a removal below it shifts one.
    const at = emptied && itemIndex < ref.index ? ref.index - 1 : ref.index;
    const container = stacks[at];
    // Belt and braces after the bug above: if the index does not still name the container we resolved,
    // do nothing rather than turning some innocent item into a sack.
    if (!container || container.item.id !== ref.item.id) return;
    stacks[at] = { ...container, held: { rule: ref.held.rule, contents } };
    sim.setInventory(player, { stacks, capacity: player.inventory.capacity });
  } else {
    // **The floor is written first, and the bag only if that succeeded.** The other order hands the
    // item to a sack that may have been picked up in the meantime, and the item is then in neither
    // place. Nothing has been taken from the player until this line runs.
    if (!writeHeld(player, ref, { rule: ref.held.rule, contents })) {
      send(player.id, { t: 'log', channel: 'error', text: `${capitalise(ref.item.name)} is not there any more.` });
      return;
    }
    sim.setInventory(player, { stacks, capacity: player.inventory.capacity });
  }

  send(player.id, { t: 'log', channel: 'system', text: `You put ${item.name} in ${containerPhrase(ref)}.` });
  if (ref.where === 'ground') {
    faceToward(player, ref.x, ref.y);
    actToRoom(player, 'room', (who) => `${who} puts ${item.name} in ${ref.item.name}.`);
  }
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/**
 * The corpse in the room a word names, if any — **nearest still worth searching**, `loot`'s own rule.
 *
 * Not filtered by reach, deliberately: a body across the floor still *is* what `get axe corpse` meant, and
 * answering "step over to it" is worth more than falling through to the container path and saying you are
 * carrying no corpse.
 */
function corpseNamed(player: Player, word: string): Corpse | undefined {
  // A word has to be given here, unlike `loot`: this is the *second* term of `get axe <here>`, and an
  // empty one meaning "any corpse" would make `get axe` alone start rifling bodies.
  if (!word.trim()) return undefined;
  const matching = corpsesIn(graveyard, player.roomId).filter((c) => corpseAnswersTo(c, word));
  return nearestLootable(matching, player.x, player.y);
}

/**
 * Whether a word names something a player could take *from* — a corpse or a container.
 *
 * Read before `get <a> <b>` is treated as the two-word form, so the ambiguity falls the safe way. Being
 * wrong in the other direction costs more than a refusal does: it turns a perfectly good floor pickup into
 * a player being told there is no "long" in their sword.
 */
function namesSomethingToTakeFrom(player: Player, word: string): boolean {
  if (corpseNamed(player, word)) return true;
  return resolveContainer(player, word).found === 'container';
}

/** Sends `get <thing> <where>` to the body or the container that `where` names. */
function getFromSomething(player: Player, wanted: string, target: string): void {
  const corpse = corpseNamed(player, target);
  if (corpse) return getFromCorpse(player, wanted, corpse);
  return getFromContainer(player, wanted, target);
}

/** `get <item> from <container>`: take something back out, of yours or of one lying here. */
function getFromContainer(player: Player, wanted: string, target: string): void {
  const lookup = resolveContainer(player, target);
  if (lookup.found !== 'container') {
    refuseContainer(player, lookup, target, false);
    return;
  }
  const ref = lookup.ref;

  const word = wanted.trim().toLowerCase();
  const at = ref.held.contents.findIndex(
    (s) => !word || s.item.id === word || wordsFor(s.item).includes(word),
  );
  if (at === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `There is no ${wanted} in ${ref.item.name}.` });
    return;
  }

  const stack = ref.held.contents[at]!;
  // Coming *out* costs bag slots, so it can be refused — which is the honest mirror of putting it in
  // having freed them.
  const result = carry(player.inventory, stack.item);
  if (!('stacks' in result)) {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: `You have no room for ${stack.item.name} — ${result.free} slot${result.free === 1 ? '' : 's'} free.`,
    });
    return;
  }

  const contents = [...ref.held.contents];
  if (stack.count > 1) contents[at] = { ...stack, count: stack.count - 1 };
  else contents.splice(at, 1);

  // **Out of the container before it reaches the bag**, so a container that has gone cannot also have
  // handed you its arrow. The bag write is the last thing that happens, exactly as in `put`.
  if (!writeHeld(player, ref, { rule: ref.held.rule, contents })) {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(ref.item.name)} is not there any more.` });
    return;
  }
  sim.setInventory(player, result);

  send(player.id, { t: 'log', channel: 'system', text: `You get ${stack.item.name} from ${containerPhrase(ref)}.` });
  if (ref.where === 'ground') {
    faceToward(player, ref.x, ref.y);
    actToRoom(player, 'room', (who) => `${who} gets ${stack.item.name} from ${ref.item.name}.`);
  }
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/**
 * A command line waiting for a yes — the confirmation half of `junk`.
 *
 * **The whole line is kept, not the item it resolved to**, which is `interp.c`'s own shape
 * (`strcpy(desc->last_command, argument)` at the arming site) and is the better of the two. Storing a
 * resolved reference means acting on a decision made against a world that has since moved; re-running
 * the line asks the question again, so a bag that changed between the ask and the answer produces an
 * honest refusal rather than destroying whatever slid into that slot.
 *
 * Per connection rather than per character, exactly as Duris keeps it on the descriptor: it is a fact
 * about a conversation, not about a person, and it must not survive a disconnect.
 */
const pendingConfirm = new Map<EntityId, string>();

/**
 * `junk <keyword>`: destroy something outright, once you have said so twice.
 *
 * Owner's ask (2026-08-05), and the source already had both halves of it —
 * `CMD_CNF_N(CMD_JUNK, STAT_RESTING + POS_SITTING, do_junk, 56)` is *requires confirmation, and may
 * not be used while fighting*. Even the prompt is transcribable: `do_junk` writes **"WARNING: JUNK
 * permanently destroys the specified object(s)"** and offers `(Yes/No) [No]`, defaulting to no.
 *
 * **Why the verb exists at all when `drop` does.** Dropping is not disposal — Phase 15b put things on
 * a real floor where they are still an entity, still visible, and still counted against their vnum's
 * world-wide instance limit by the `O` reset census. Getting rid of something by dropping it makes it
 * somebody else's problem and the zone's. This makes it nobody's.
 */
function junkFromBag(player: Player, rest: string, confirmed: boolean): void {
  if (!rest.trim()) {
    send(player.id, { t: 'log', channel: 'error', text: 'Junk what?' });
    return;
  }
  const index = matchInventory(player.inventory, rest, wordsFor);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return;
  }
  const stack = player.inventory.stacks[index];
  if (!stack) return;

  if (!confirmed) {
    // Armed, and the room is told nothing: deciding to destroy something is not yet an act.
    pendingConfirm.set(player.id, `junk ${rest.trim()}`);
    send(player.id, {
      t: 'log',
      channel: 'error',
      text:
        `Junking ${stack.item.name} destroys it permanently — it is not dropped, it is gone. ` +
        `Type "yes" to confirm, or anything else to think better of it.`,
    });
    return;
  }

  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  sim.setInventory(player, removed.inventory);

  // **What was inside goes with it, and that is the one place this deliberately parts company with
  // every other way a thing leaves your hands.** A corpse spills, a decaying container spills, a drop
  // puts the whole quiver down still full — because in all three the player has not asked for the
  // contents to stop existing. Here they have. Spilling a junked sack onto the floor would answer a
  // request to destroy something by creating litter, which is the opposite of the verb.
  const inside = stack.held?.contents ?? [];
  const alsoGone = inside.reduce((sum, held) => sum + held.count, 0);

  send(player.id, {
    t: 'log',
    channel: 'system',
    text:
      `You destroy ${stack.item.name}.` +
      (alsoGone > 0 ? ` The ${alsoGone} thing${alsoGone === 1 ? '' : 's'} inside go with it.` : ''),
  });
  // The room sees the act but not the item: what somebody chose to throw away is their business, and
  // naming it would let a bystander learn the contents of a bag they never looked in.
  actToRoom(player, 'room', (who) => `${who} destroys something.`);
  send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  rememberProgress(player);
}

/** `drop <keyword>`: put something down where you stand. */
function dropFromBag(player: Player, rest: string): void {
  if (!rest.trim()) {
    send(player.id, { t: 'log', channel: 'error', text: 'Drop what?' });
    return;
  }
  const index = matchInventory(player.inventory, rest, wordsFor);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return;
  }
  // **Read before the removal, because it goes with the item.** A container holding anything is always
  // a stack of one — `mergeable` refuses to merge one that holds things — so taking the item takes the
  // whole stack and its `held` with it. Losing it here would destroy every arrow in a quiver the moment
  // its owner put it down.
  const held = player.inventory.stacks[index]?.held;
  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  sim.setInventory(player, removed.inventory);
  // **One to two tiles away, in a random direction** — owner's rule, 2026-08-05. Not the room's
  // centre, and no longer the character's exact feet: A7d gave items real pictures and three things
  // on one tile read as one object with a fringe. The distance is bounded by the pickup reach it
  // pairs with (three tiles), so a dropped thing is always still within arm's reach.
  const spot = dropSpotNear(ground, player.roomId, player.x, player.y, spawnRng, (px, py) => {
    const grid = world.grid(player.place);
    // No grid means no floor to reason about, so anywhere is as good as anywhere — the fallback in
    // `dropSpotNear` takes over. Also refuses a spot in another room: a dropped sword must not slide
    // through a doorway into the corridor.
    return !grid || (isWalkableAt(grid, px, py) && roomAtTile(grid, Math.floor(px / TILE_SIZE), Math.floor(py / TILE_SIZE)) === player.roomId);
  });
  const entry = dropItem(
    ground,
    removed.item,
    { roomId: player.roomId, place: player.place, x: spot.x, y: spot.y },
    held,
    DEV_DECAY_MS,
  );

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
  equipFromBag(player, rest, 'wear');
}

/**
 * The words that mean *the other hand*, stripped off the tail of a `wield` argument.
 *
 * **A suffix rather than a command of its own, which is why `commands.ts` gains no row.** The parking
 * lot asked for `wield <weapon> offhand`, and that is one verb taking two words — adding an `offhand`
 * command would have put a new prefix into the abbreviation table for no gain, and that table's order
 * is load-bearing (a mid-table insert once stole `g` from `get`).
 *
 * Four spellings because a player types what they think of, and `off hand`, `off-hand`, `offhand` and
 * Duris' own `secondary` (`actobj.c:4923` — *"your secondary hand"*) are all the same thought.
 */
const OFFHAND_WORDS: readonly string[] = ['offhand', 'off-hand', 'off hand', 'secondary', 'second'];

/**
 * `wield <weapon>`: take a weapon in hand — `wear`'s sibling, and now that it has a rule of its own.
 *
 * **Duris splits the two and 15b did not, for a reason that has since expired.** The argument then was
 * that one verb was enough while a character had one weapon and refusing `wear dagger` would be a rule
 * with no benefit attached. Two-handed weapons are that benefit: 557 of the catalogue's 2,841 weapons
 * need both hands, and *which hand a thing occupies* is suddenly a question with consequences.
 *
 * The split is deliberately **asymmetric**, which is the kinder half of Duris' behaviour without the
 * unkind half. `wield` refuses anything that is not a weapon, so it means what it says; `wear` still
 * accepts a weapon, because a player who types the wrong verb at the right item should get their sword
 * in their hand rather than a lecture. Duris refuses both ways; that costs a beginner a swing and buys
 * nothing.
 */
function wieldFromBag(player: Player, rest: string): void {
  const trimmed = rest.trim();
  const lowered = trimmed.toLowerCase();
  // Longest first, so `off hand` is not matched as `hand`'s prefix by the shorter `second`. Matched
  // on a **word** boundary — a space before the suffix — so nobody wielding "a dagger of the second
  // moon" loses their moon.
  const suffix = OFFHAND_WORDS.find((word) => lowered.endsWith(` ${word}`));
  if (suffix === undefined) {
    equipFromBag(player, trimmed, 'wield');
    return;
  }
  equipFromBag(player, trimmed.slice(0, trimmed.length - suffix.length - 1).trim(), 'wield', 'offHand');
}

/**
 * The one act behind `wear` and `wield` — including the two-hand rule, which neither may skip.
 *
 * **A two-handed weapon takes the off hand too, and what was there goes into the bag.** Duris refuses
 * outright — *"You need two free hands to wield that"* — and this displaces instead, which is the house
 * rule `wear` already follows: a character cannot end an equip holding less than they started, because
 * losing gear to one mistyped command is the feeling this project's owner named as the worst in a game.
 * The refusal survives in the one case where displacing would lose something: a bag with no room for
 * what comes off.
 *
 * The rule runs **both ways**. Wielding a greatsword sheds the shield; strapping on a shield sheds the
 * greatsword. One of those is easy to forget, and forgetting it is a character quietly fighting with a
 * two-hander and a shield.
 */
function equipFromBag(player: Player, rest: string, mode: 'wear' | 'wield', hand?: 'offHand'): void {
  if (!rest.trim()) {
    send(player.id, { t: 'log', channel: 'error', text: mode === 'wield' ? 'Wield what?' : 'Wear what?' });
    return;
  }
  const index = matchInventory(player.inventory, rest, wordsFor);
  if (index === -1) {
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return;
  }
  const item = player.inventory.stacks[index]!.item;
  // **Not everything can be worn**, and since 15c most things cannot: keys, coins, food and trash are
  // the bulk of the harvested catalogue and none of them go anywhere on a body. Refusing by name is the
  // only honest answer — the alternative is inventing a slot, and any resting value picked would make
  // every key in the world wearable somewhere.
  //
  // **Template first here, instance as the fallback** — the reverse of the weapon-class heal, and
  // deliberately: a slot edit (the owner's shroud, `about` → `back`) is a statement about where the
  // thing *belongs*, and the next wear should honour it even on an instance minted under the old
  // answer. The instance copy still matters for anything whose template has gone.
  const named = templateOf(item)?.slot ?? item.slot;
  if (!named) {
    send(player.id, { t: 'log', channel: 'error', text: `You cannot ${mode} ${item.name}.` });
    return;
  }
  if (mode === 'wield' && named !== 'mainHand') {
    send(player.id, { t: 'log', channel: 'error', text: `${capitalise(item.name)} is not a weapon. Try wearing it.` });
    return;
  }

  // **`wield <weapon> offhand`** — the parking lot's own form, and the source's own two refusals in
  // the source's own order (`actobj.c:4908` then `:4918`). Both are checked *before* anything is
  // moved, so a refused wield leaves the bag exactly as it was.
  if (hand === 'offHand') {
    // The training gate. Duris asks `!GET_CHAR_SKILL(ch, SKILL_DUAL_WIELD)`, a per-class table; ours
    // asks the ceiling, which is the same table in our shape — a group whose ceiling is 0 never
    // learned this at all, and `learnedAt` can never lift them off the floor of it.
    if (ceilingFor('dual-wield', classOf(player), player.level) <= 0) {
      send(player.id, { t: 'log', channel: 'error', text: 'You lack the training to use two weapons.' });
      return;
    }
    // The weapon gate. Two-handers, reach weapons and anything too heavy are all refused by
    // `handednessFor` having declined to call them `'either'` — see there for how the source's
    // strength-scaled weight test became a class-and-bulk one. Instance first, template as the heal.
    if (handednessFor(item) !== 'either' && handednessFor(templateOf(item)) !== 'either') {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: `${capitalise(item.name)} is too much weapon for your off hand.`,
      });
      return;
    }
  }

  // **A ring goes on any finger** — owner's design, 2026-08-07: *"picks the first free slot and
  // wears it there"*. Item data only ever names a pair's first slot, so before this a second ring
  // displaced the first while the other hand stayed bare. Ears, wrists and neckwear are the same
  // shape — `resolveWearSlot` holds the rule and its tests.
  const slot = hand ?? resolveWearSlot(named, player.equipped);

  // Every slot this equip empties. Normally one; a two-hander clears both hands, and so does putting
  // something in the off hand while a two-hander is held.
  const clears: EquipSlot[] = [slot];
  if (slot === 'mainHand' && item.twoHanded) clears.push('offHand');
  if (slot === 'offHand' && player.equipped.mainHand?.twoHanded) clears.push('mainHand');

  const removed = removeAt(player.inventory, index);
  if (!removed) return;
  let bag = removed.inventory;

  const displaced: Item[] = [];
  for (const cleared of clears) {
    const worn = player.equipped[cleared];
    if (!worn) continue;
    const stowed = carry(bag, worn);
    if (!('stacks' in stowed)) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: `You would have nowhere to put ${worn.name}. Make room first.`,
      });
      return;
    }
    bag = stowed;
    displaced.push(worn);
  }

  sim.setInventory(player, bag);
  const kit = { ...player.equipped };
  for (const cleared of clears) delete kit[cleared];
  player.equipped = { ...kit, [slot]: item };

  // A blade in the off hand is still wielded, not worn — the slot alone used to decide this, and the
  // slot alone would now say a player "wears" the dagger they just drew.
  const verb = slot === 'mainHand' || hand === 'offHand' ? 'wield' : 'wear';
  send(player.id, {
    t: 'log',
    channel: 'system',
    // Duris' `where[]` names the two hands `<primary weapon>` and `<secondary weapon>` (`common.c:322`),
    // and the confirmation says which one took it — otherwise the only way to tell a successful
    // off-hand wield from an ordinary one is to look at the paper doll.
    text: hand === 'offHand' ? `You wield ${item.name} in your off hand.` : `You ${verb} ${item.name}.`,
  });
  if (item.twoHanded) {
    send(player.id, { t: 'log', channel: 'system', text: `It takes both hands.` });
  }
  for (const gone of displaced) {
    send(player.id, { t: 'log', channel: 'system', text: `You stop using ${gone.name}.` });
  }
  actToRoom(player, 'room', (who) => `${who} ${verb}s ${item.name}.`);
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
      (item.id === wanted || wordsFor(item).includes(wanted)),
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
  sim.setInventory(player, stowed);
  const next = { ...player.equipped };
  delete next[wornSlot];
  player.equipped = next;

  send(player.id, { t: 'log', channel: 'system', text: `You stop using ${found.name}.` });
  actToRoom(player, 'room', (who) => `${who} removes ${found.name}.`);
  afterKitChange(player);
}

/* -------------------------------------------------------------------------- */
/* Shops — Phase 17                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The shopkeeper standing in this room, or a refusal saying why not.
 *
 * **One resolver for all four verbs**, so *"there is nobody here to trade with"* is written once and
 * the four commands cannot drift into four different sentences for the same situation.
 *
 * Sight-gated like everything else: `canSee` decides, so a keeper standing in the dark is somebody
 * you cannot do business with — which is the same answer `kill` and `look` give, and it falls out of
 * the existing gate rather than being a rule shops invented.
 *
 * **A keeper you are fighting will not serve you, and that rule is ours.** `interp.c` puts all four
 * verbs at `in_battle = TRUE`, so the parser lets them through — the refusal belongs to the keeper,
 * and a merchant taking your coin while you swing at them is the kind of thing that reads as the game
 * not noticing.
 */
function keeperFor(player: Player): { mob: Mob; shop: Shop } | undefined {
  // **Awake and on your feet, and this is the keeper's rule rather than the parser's.** `CMD_TRIG`
  // puts all four verbs at the table's floor, so a sleeping character can *type* `buy` — the source
  // leaves that to the shopkeeper's own routine, and so does this. Checked before the room is
  // searched, because "you are asleep" is a better answer than "there is nobody here" to somebody
  // whose eyes are shut.
  if (player.status !== 'normal' || player.posture !== 'standing') {
    send(player.id, {
      t: 'log',
      channel: 'error',
      text: 'You will have to be awake and on your feet to do business.',
    });
    return undefined;
  }
  for (const actor of sim.actorsIn(player.roomId)) {
    if (!isMob(actor) || !canSee(player, actor)) continue;
    const shop = shopsByKeeper.get(actor.vnum);
    if (!shop) continue;
    if (actor.fighting === player.id || player.fighting === actor.id) {
      send(player.id, {
        t: 'log',
        channel: 'error',
        text: `${capitalise(actor.name)} is rather busy fighting you.`,
      });
      return undefined;
    }
    return { mob: actor, shop };
  }
  send(player.id, { t: 'log', channel: 'error', text: 'There is nobody here to trade with.' });
  return undefined;
}

/**
 * The words a shelf entry answers to.
 *
 * `wordsForItem` wants an instantiated `Item` and a shelf holds `ItemTemplate`s — nothing has been
 * made yet, which is the whole point of unlimited stock. So the same union is built from the template
 * directly: authored keywords plus the name split, which is what `wordsForItem` does once there is an
 * item to ask about. One rule, reached two ways, rather than two rules.
 */
function stockWords(template: ItemTemplate): readonly string[] {
  return [...new Set([...template.keywords, ...wordsFromName(template.name)])];
}

/** What the keeper says, in the keeper's voice — the same shape `say` uses so it reads as a person. */
function keeperSays(player: Player, mob: Mob, text: string): void {
  send(player.id, { t: 'log', channel: 'say', text: `${capitalise(mob.name)} says, '${text}'` });
}

/** The guildmaster standing in your room, or nothing — `FindTeacher`, against our registry. */
function teacherFor(player: Player): { mob: Mob; classId: ClassId } | undefined {
  for (const actor of sim.actorsIn(player.roomId)) {
    if (!isMob(actor)) continue;
    const classId = trainersByVnum.get(actor.vnum);
    if (classId !== undefined) return { mob: actor, classId };
  }
  return undefined;
}

/**
 * `practice` — Phase 24, `do_practice` on our seams. Bare, it prints the hall's slate: every skill
 * the teacher's class knows, with your standing and the price, or the source's own "(cannot
 * practice)" for what your class may never hold. Named, it walks the refusal ladder in the
 * source's order — the purse, twice your level, your ceiling, twice the teacher's level with its
 * four sassy answers — and a lesson that survives them all costs the curve and pays **+1 learned**.
 */
function doPractice(player: Player, rest: string): void {
  const here = teacherFor(player);
  if (!here) {
    send(player.id, { t: 'log', channel: 'error', text: 'There is no one here to teach you.' });
    return;
  }
  const classId = classOf(player);
  const effective = (skill: SkillId): number => learnedAt(player.skills.get(skill), player.level, skill, classId);

  const word = rest.trim().toLowerCase();
  if (!word) {
    const rows = practiceSlate(here.classId, { classId, level: player.level, learned: effective });
    if (rows.length === 0) {
      keeperSays(player, here.mob, 'This hall has nothing left to teach anyone.');
      return;
    }
    send(player.id, { t: 'log', channel: 'system', text: `&+B${'Skill'.padEnd(18)} ${'You'.padEnd(9)}Cost of Teachings&N` });
    for (const row of rows) {
      const name = SKILLS[row.skill].name.padEnd(18);
      const standing = `${row.learned}/${row.ceiling}`.padEnd(9);
      const price = row.cost === undefined ? '(cannot practice)' : stripColour(describePurse(purseFromValue(row.cost)));
      send(player.id, { t: 'log', channel: 'system', text: `${name} ${standing}${price}` });
    }
    return;
  }

  // Exact id or display-name match first, then prefix — the source's own two-pass search, which it
  // grew after `guard` kept reaching "guardian spirits".
  const match =
    SKILL_IDS.find((id) => id === word || SKILLS[id].name.toLowerCase() === word) ??
    SKILL_IDS.find((id) => SKILLS[id].name.toLowerCase().startsWith(word) || id.startsWith(word));
  if (!match) {
    send(player.id, { t: 'log', channel: 'error', text: `No skill called "${rest.trim()}" is taught anywhere.` });
    return;
  }
  if (ceilingFor(match, here.classId) <= 0) {
    keeperSays(player, here.mob, 'That is not something I can teach you.');
    return;
  }

  const learned = effective(match);
  const ceiling = classId ? ceilingFor(match, classId, player.level) : 0;
  const cost = practiceCost(learned);
  const refusal = practiceRefusal(
    {
      learned,
      ceiling,
      studentLevel: player.level,
      teacherLevel: here.mob.level,
      canAfford: purseValue(player.purse) >= cost,
    },
    randomInt(spawnRng, 1, 4),
  );
  if (refusal) {
    keeperSays(player, here.mob, refusal);
    return;
  }

  const paid = spendCoins(player.purse, cost);
  if (!paid) {
    keeperSays(player, here.mob, "Sorry, boss, but I'm afraid you cannot afford the training.");
    return;
  }
  player.purse = paid;
  player.skills.set(match, learned + 1);
  send(player.id, { t: 'log', channel: 'system', text: `You practice '${SKILLS[match].name}' for a while...` });
  // The owner's ask, in the grind's own voice — `notchSkill`'s exact sentence, so a point announces
  // itself the same way however it was earned — plus the standing, because this point was paid for
  // and the buyer is owed the number.
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `&+cYou feel your skill in ${SKILLS[match].name} improving.&N (${learned + 1}/${classId ? ceilingFor(match, classId, player.level) : 0})`,
  });
  // Owner-reported the same evening: the purse in the open inventory tab held its number until the
  // panel was reopened. The shop verbs already push the fresh bag through `afterKitChange` after
  // every coin movement; a lesson moves coin and takes the same seam.
  afterKitChange(player);
}

/** `list` — what is on the shelf, and what each costs *you*. */
function listShopStock(player: Player): void {
  const here = keeperFor(player);
  if (!here) return;
  const stock = stockOf(here.shop, itemCatalogue);
  if (stock.length === 0) {
    keeperSays(player, here.mob, 'I have nothing to sell just now.');
    return;
  }
  send(player.id, { t: 'log', channel: 'system', text: `&+c${capitalise(here.mob.name)} is selling:&N` });
  stock.forEach((template, index) => {
    // Numbered, because `buy 2` is what a player reads off this list — and `findInStock` accepts it
    // for that reason. The price is what *you* pay, not the item's cost: a shelf that quoted the
    // world's price and charged another would be a lie in the one place a player is counting.
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `  ${String(index + 1).padStart(2)}. ${template.name}&N — ${describePurse(purseFromValue(priceToBuy(template, here.shop, shopCha(player))))}`,
    });
  });
}

/** The shopper's charisma modifier — CHA's first reader, zero for the identity-less. Phase 21. */
function shopCha(player: Player): number {
  return player.identity ? abilityMod(player.identity.scores.cha) : 0;
}

/**
 * Whose ceilings apply — the **class**, since the nine-class re-key. Undefined (the flat 95) for the
 * identity-less, which is still every pre-Phase-21 character and every mob path that asks.
 */
function classOf(player: Player): ClassId | undefined {
  return player.identity?.class;
}

/** `buy <keyword|number>` — the coin leaves, the item arrives, and the bag has to have room. */
function buyFromShop(player: Player, rest: string): void {
  const here = keeperFor(player);
  if (!here) return;
  const stock = stockOf(here.shop, itemCatalogue);
  if (!rest.trim()) {
    keeperSays(player, here.mob, 'Buy what? Try "list".');
    return;
  }
  const template = findInStock(stock, rest, stockWords);
  if (!template) {
    keeperSays(player, here.mob, "I do not sell that.");
    return;
  }

  const price = priceToBuy(template, here.shop, shopCha(player));
  const paid = spendCoins(player.purse, price);
  if (!paid) {
    keeperSays(player, here.mob, `That costs ${stripColour(describePurse(purseFromValue(price)))}. You do not have it.`);
    return;
  }

  // **Room in the bag is checked before the coin moves**, or a full bag costs you the price of
  // something you never received. `carry` answers both questions at once, which is why it is asked
  // first and the purse is only written after it succeeds.
  const item = instantiate(template);
  const stowed = carry(player.inventory, item);
  if (!('stacks' in stowed)) {
    keeperSays(player, here.mob, `You have nowhere to put that — ${stowed.free} slot${stowed.free === 1 ? '' : 's'} free.`);
    return;
  }
  sim.setInventory(player, stowed);
  player.purse = paid;

  keeperSays(player, here.mob, `Thank you, that will be ${stripColour(describePurse(purseFromValue(price)))}.`);
  send(player.id, { t: 'log', channel: 'system', text: `You buy ${item.name}&N.` });
  afterKitChange(player);
}

/**
 * Offers on the table — Phase 23's haggle, owner-designed from the shop floor (2026-08-10): *"the
 * merchants should only offer a small fraction of the value... maybe they can make an offer and we
 * can accept it or not."* One standing offer per player: `sell` (or `value`) rolls it and says the
 * number, selling the same thing to the same keeper inside the window completes at exactly that
 * number, and anything else — another item, another keeper, half a minute of thought — lets it
 * lapse. Wall-clock on purpose: the window is a courtesy to a human deciding, not simulation state.
 */
const OFFER_TTL_MS = 30_000;
const pendingSales = new Map<number, { keeper: number; itemName: string; price: number; expiresAt: number }>();

/** Rolls a fresh offer, says it, and puts it on the table. Shared by `value` and first-`sell`. */
function quoteOffer(player: Player, here: { mob: Mob; shop: Shop }, found: { item: Item; template: ItemTemplate }): void {
  // The haggling die rides the colour stream: the price of a cloak in a shop is the world being
  // itself, not a fight to audit.
  const price = sellOffer(found.template, here.shop, randomInt(spawnRng, 0, 9999) / 9999, shopCha(player));
  if (price <= 0) {
    keeperSays(player, here.mob, `Keep ${stripColour(found.item.name)}. It is not worth my coin.`);
    pendingSales.delete(player.id);
    return;
  }
  pendingSales.set(player.id, {
    keeper: here.mob.vnum,
    itemName: found.item.name,
    price,
    expiresAt: Date.now() + OFFER_TTL_MS,
  });
  keeperSays(
    player,
    here.mob,
    `${stripColour(describePurse(purseFromValue(price)))} for ${stripColour(found.item.name)}, and not a copper more. Sell it again if we have a deal.`,
  );
}

/** `value <keyword>` — the keeper makes an offer. The same offer `sell` would make, and it stands. */
function valueAtShop(player: Player, rest: string): void {
  const here = keeperFor(player);
  if (!here) return;
  const found = offered(player, here, rest);
  if (!found) return;
  quoteOffer(player, here, found);
}

/**
 * `sell <keyword>` — an offer first, the deal on the second ask.
 *
 * The first `sell` is a quote: the keeper rolls their offer and it goes on the table. The second
 * `sell` of the same thing to the same keeper, inside the window, completes at the quoted price —
 * never at a fresh roll, because a deal you accepted is the deal you were offered.
 */
function sellToShop(player: Player, rest: string): void {
  const here = keeperFor(player);
  if (!here) return;
  const found = offered(player, here, rest);
  if (!found) return;

  const standing = pendingSales.get(player.id);
  const accepting =
    standing !== undefined &&
    standing.keeper === here.mob.vnum &&
    standing.itemName === found.item.name &&
    standing.expiresAt > Date.now();
  if (!accepting) {
    quoteOffer(player, here, found);
    return;
  }

  pendingSales.delete(player.id);
  const taken = removeAt(player.inventory, found.at);
  if (!taken) {
    // Re-read rather than trusting the resolution above, the same discipline `pickUp` keeps: two
    // things can happen to a bag between one line and the next.
    send(player.id, { t: 'log', channel: 'error', text: 'You no longer have that.' });
    return;
  }
  sim.setInventory(player, taken.inventory);
  player.purse = addCoins(player.purse, purseFromValue(standing.price));

  keeperSays(player, here.mob, `Done. ${stripColour(describePurse(purseFromValue(standing.price)))}, as agreed.`);
  send(player.id, { t: 'log', channel: 'system', text: `You sell ${found.item.name}&N.` });
  afterKitChange(player);
}

/**
 * The thing in your bag you are offering, with the refusals a keeper actually makes.
 *
 * Shared by `sell` and `value` because they ask the same question and only differ in what they do
 * with the answer — and because "I won't buy that" has to mean the same thing in both, or a player
 * gets a price for something that is then refused.
 */
function offered(
  player: Player,
  here: { mob: Mob; shop: Shop },
  rest: string,
): { at: number; item: Item; template: ItemTemplate } | undefined {
  if (!rest.trim()) {
    keeperSays(player, here.mob, 'Sell what?');
    return undefined;
  }
  const at = matchInventory(player.inventory, rest, wordsFor);
  if (at < 0) {
    // The mistake-proofing — owner, 2026-08-10: *"we shouldn't be able to sell worn equipment so we
    // don't sell them by mistake."* Worn gear was never sellable (the matcher above reads the bag
    // alone), but the old refusal said "not carrying", which to somebody wearing the thing reads as
    // a bug. Now it says what is actually true, and what to do about it.
    const word = rest.trim().toLowerCase().split(/\s+/)[0] ?? '';
    const wearingIt = Object.values(player.equipped).some(
      (worn) => worn !== undefined && wordsFor(worn).includes(word),
    );
    if (wearingIt) {
      keeperSays(player, here.mob, 'You are wearing that. Take it off first, if you mean it.');
      return undefined;
    }
    send(player.id, { t: 'log', channel: 'error', text: `You are not carrying ${rest}.` });
    return undefined;
  }
  const item = player.inventory.stacks[at]!.item;
  const template = templateOf(item);
  if (!template) {
    // A starter-kit piece has no catalogue entry and therefore no cost the world agrees on. Refused
    // by name rather than priced at zero, which would read as the keeper being insulting.
    keeperSays(player, here.mob, 'I deal in ordinary goods, not that.');
    return undefined;
  }
  if (!willBuy(here.shop, template)) {
    keeperSays(player, here.mob, 'I will not buy that.');
    return undefined;
  }
  return { at, item, template };
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
    // A container shows how full it is instead of a plain name, because "how much more fits" is the
    // question you actually have about one. §4's `describeContainer` owns that wording.
    const rule = stack.held?.rule ?? templateOf(stack.item)?.container;
    const label = rule
      ? describeContainer(stack.item, { rule, contents: stack.held?.contents ?? [] })
      : describeStack(stack, stack.item.uses);
    send(player.id, {
      t: 'log',
      channel: 'system',
      text: `  ${label} (${slots} slot${slots === 1 ? '' : 's'})`,
    });
    // Its contents, indented under it. Shown inline rather than behind a `look in`, because the whole
    // point of the container is that the arrows are still *yours* — hiding them behind a second
    // command would make a quiver feel like storage rather than like carrying.
    for (const inside of stack.held?.contents ?? []) {
      send(player.id, {
        t: 'log',
        channel: 'system',
        text: `    - ${describeStack(inside, inside.item.uses)}`,
      });
    }
  }

  // Coin is a line of its own, above the kit — it is not worn and it is not carried, and putting it
  // in either list would be a lie about where it lives.
  send(player.id, {
    t: 'log',
    channel: 'system',
    text: `&+YPurse:&N ${describePurse(player.purse)}`,
  });
}

/**
 * `equipment` — what you are wearing, and `inventory`'s other half.
 *
 * They were one printout until the owner read it (2026-08-07): *"when I type inventory it is showing
 * what I am wearing"* — a full kit is eleven lines and a fresh character's bag is none, so the worn
 * list drowned the carried one and the command read as answering the wrong question. Diku's own split
 * is the fix, verbs and all: `inventory` is what you carry, `equipment` is what you wear, and the
 * lineage's fingers already know `i` and `eq`.
 *
 * `CMD_Y(CMD_EQUIPMENT, STAT_SLEEPING + POS_PRONE, …)` — readable while asleep, mid-fight, from the
 * floor. Checking what you are wearing is interface, not action.
 */
function listEquipment(player: Player): void {
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
      // A casting body is rooted: the intent is dropped silently, because steer packets arrive
      // continuously and a refusal line per packet would be sixty complaints a second. The typed and
      // clicked paths say the sentence; this one just does not move.
      if (player.casting) break;
      // Grabbing the keyboard takes manual control back off the pathfinder. A zero vector is a key
      // *release*, and the client sends one every time you let go — cancelling on that would kill a
      // route the moment the player brushed a movement key. `setIntent` answers after normalising,
      // so a sub-threshold nudge counts as a release here too.
      const steering = sim.setIntent(player.id, message.dx, message.dy);
      if (steering && sim.clearPath(player)) send(player.id, { t: 'path', points: [] });
      break;
    }

    case 'moveTo':
      if (player.casting) {
        send(player.id, { t: 'log', channel: 'error', text: "You're busy spellcasting!" });
        break;
      }
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
      // `inside` is the *Look inside* row on a container's menu. It goes to its own resolver rather
      // than through `targetById`, because what it needs is the ground **entry** — the view carries a
      // flag saying the thing holds items, not what it holds.
      if (message.inside) {
        lookInsideEntity(player, message.target);
        break;
      }
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

    case 'rangedAttack': {
      if (!permits(player, message.thrown === true ? 'throw' : 'fire')) break;
      // Deliberately **not** through `targetById`: ranged is the one verb allowed to name a revealed
      // body, which is exactly what `nameable` strips for every other verb. `visibleEntities` is
      // still the gate — the pointer reaches what the eye can see, and nothing more, and `shootAt`
      // re-walks the whole gauntlet behind it.
      const view = visibleEntities(player).find((e) => e.id === message.target && e.kind !== 'item');
      const target = view ? sim.get(view.id) : undefined;
      if (!target) {
        send(player.id, { t: 'log', channel: 'error', text: 'You cannot make that out any more.' });
        break;
      }
      // The click supplies no words, so the direction is derived: the exit of this room that leads
      // to the target's. One room of derivation only, which is the reveal's own reach.
      let dir: Direction | undefined;
      if (target.roomId !== player.roomId) {
        const here = sim.room(player.roomId);
        dir = here
          ? (Object.entries(here.exits).find(([, exit]) => exit?.to === target.roomId)?.[0] as Direction | undefined)
          : undefined;
        if (!dir) {
          send(player.id, { t: 'log', channel: 'error', text: 'You have no clear line to them.' });
          break;
        }
      }
      shootAt(player, message.thrown === true, target, dir);
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

    // V4. A read, and the only client message that asks for something rather than intending it — the
    // graph is pushed on every Place change, but the *rooms explored* on each node climbs with every
    // step, so a view opened mid-exploration wants a fresh answer rather than the last push.
    case 'places':
      sendPlaces(player);
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

    case 'auth':
    case 'enter':
    case 'charCreate':
    case 'charConfirm':
    case 'checkName':
      // The handshake already happened; a repeat while embodied is ignored rather than trusted.
      // `checkName` joins them for the same reason: it is a question asked at the door, and a body
      // already in the world has no name left to choose.
      break;

    // The typed `flee` and the protocol's own intent reach the same place, exactly as `command` and the
    // movement intents do. A keybind or a UI button sends this; the command line sends the other.
    case 'flee':
      // The source is explicit that you cannot voluntarily flee mid-cast — the lockout covers flee
      // like everything else, and the way out of a bad cast is finishing it or being knocked out of it.
      if (player.casting) {
        send(player.id, { t: 'log', channel: 'error', text: "You're busy spellcasting!" });
        break;
      }
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
  // The coin verb, through the same seam every purse movement takes, so the open inventory tab
  // learns immediately — the exact staleness the owner reported of practice, not re-earned here.
  grantCoins: (player, copper) => {
    const total = Math.max(0, purseValue(player.purse) + copper);
    player.purse = purseFromValue(total);
    afterKitChange(player);
    return total;
  },
  // A6. The router validates and persists; these apply — the same split `authorRoom` keeps.
  itemOverrides: () => itemOverrides,
  authorItem,
  // A6b. Whole records rather than patches — see `item-authoring.ts` for why they are separate.
  authoredItems: () => authoredStore.items,
  authorNewItem,
  deleteAuthoredItem,
  /* ---- A4: zones and mobs, live ---------------------------------------- */

  repopZone(zone) {
    const clock = zoneClocks.find((candidate) => candidate.spawns.zone === zone);
    if (!clock) return undefined;
    // `force`, and it is the second caller of a flag that has existed since Phase 8 for exactly this —
    // see `runReset`'s own note about a sub-100% `M` never firing on a timed pass.
    const outcome = runReset(sim, clock, mobTemplates, itemCatalogue, countInstances, authoredOutfit, spawnRng, true);
    const objects = placeResetObjects(outcome);
    // The same presence pass the timed reset does, and for the same reason: a mob that appeared in a
    // dark corner is still nobody's business until a light falls on it, so this is per-observer rather
    // than a broadcast. Leaving it out is the bug where a forced repop is invisible until you walk away
    // and back — which is precisely the loop this button exists to shorten.
    for (const room of new Set(outcome.spawned.map((mob) => mob.roomId))) syncEntitiesIn(room);
    return { spawned: outcome.spawned.length, doors: outcome.doors, objects, atLimit: outcome.atLimit };
  },

  workDoor(room, dir, next) {
    const direction = parseDirection(dir);
    if (!direction) return { error: `"${dir}" is not a direction` };
    const doorway = world.doorway(room, direction);
    if (!doorway) return { error: `there is no door ${dir} of room ${room}` };
    // **Both ends.** `doorway()` returns them precisely so nothing has to remember to; a door shut from
    // one side only is a wall from the other, and the two sides share one carved strip of tiles.
    for (const end of [doorway.near, doorway.far]) {
      if (!end) continue;
      if (next.closed !== undefined) end.door.closed = next.closed;
      if (next.locked !== undefined) end.door.locked = next.locked;
    }
    // Told to the rooms on both sides, because a door swinging is a thing you would see and hear from
    // either one. Not sight-gated: it comes from outside the world, like A2's room announcement.
    const said = next.closed === undefined
      ? `${capitalise(doorway.near.door.name)} clicks.`
      : `${capitalise(doorway.near.door.name)} swings ${next.closed ? 'shut' : 'open'}.`;
    for (const end of [doorway.near, doorway.far]) {
      if (!end) continue;
      for (const player of sim.playersIn(end.roomId)) {
        send(player.id, { t: 'log', channel: 'system', text: said });
      }
    }
    return { name: doorway.near.door.name, closed: doorway.near.door.closed, locked: doorway.near.door.locked };
  },

  mobsIn(zone) {
    const out: {
      id: number; vnum: number; name: string; level: number; hp: number; maxHp: number;
      room: RoomId; roomName: string; status: string; fighting?: number;
    }[] = [];
    // Walked room by room rather than over every actor in the world, because the zone's own room list
    // is the index we already have and `actorsIn` is the presence primitive. A 219-room zone is the
    // largest loaded and this is a panel refresh, not a tick.
    for (const room of world.zone(zone)?.rooms ?? []) {
      for (const actor of sim.actorsIn(room.id)) {
        if (!isMob(actor)) continue;
        out.push({
          id: actor.id,
          vnum: actor.vnum,
          name: actor.name,
          level: actor.level,
          hp: actor.hp,
          maxHp: actor.maxHp,
          room: room.id,
          roomName: room.name,
          status: actor.status,
          ...(actor.fighting === undefined ? {} : { fighting: actor.fighting }),
        });
      }
    }
    // By room, then by id — so the three guards of one patrol read as a group and the order is stable
    // across refreshes. Sorting by name would separate twins whose hit points differ.
    out.sort((a, b) => a.room - b.room || a.id - b.id);
    return out;
  },

  slayMob(id) {
    const actor = sim.get(id);
    if (!actor || !isMob(actor)) return undefined;
    const name = actor.name;
    // **The game's own death path.** A corpse where it fell, holding what it carried, and the room
    // told — an admin kill that made a body vanish would exercise a path the game does not have, and
    // the whole point of this loop is to watch the real one. No killer and an empty ledger, so nobody
    // is paid experience or coin — `resolveDeath` already takes that case, because a mob can die to a
    // burn or a fall with nobody to credit.
    resolveDeath({ actor, killer: undefined, contributions: new Map() });
    return { name };
  },

  spawnMob(vnum, room) {
    const template = mobTemplates.get(vnum);
    if (!template) return { error: `no mob ${vnum} in the loaded templates` };
    // Through the simulation's own spawner, on the world rng — so an admin-placed mob rolls its hit
    // points and its tile from the same seeded stream every other mob does, and a restart reproduces
    // the world it had. `CLAUDE.md` rule 3.
    const mob = sim.spawnMob(template, room, spawnRng);
    if (!mob) return { error: `room ${room} is in a Place with no grid — nothing can stand there` };
    // **A4c, and the panel's spawn button is the first place anybody will look for it.** A reset
    // dresses what it spawns; this path has no reset table behind it at all, so without this line the
    // one spawn an operator can watch happen would be the one that arrives empty. No armour refold is
    // needed: the mob is bare, so its combat profile is still the template's own.
    const dressed = applyOutfit(mob, authoredOutfit(vnum));
    if (dressed > 0) refitMobArmour(mob, template.combat.armourClass);
    syncEntitiesIn(room);
    return { id: mob.id, name: mob.name };
  },

  mobTemplates() {
    return [...mobTemplates.values()]
      .map((t) => ({ vnum: t.vnum, name: t.name, level: t.level, keywords: t.keywords ?? [] }))
      .sort((a, b) => a.vnum - b.vnum);
  },

  /* ---- A7q: quests ------------------------------------------------------- */

  quests: () => quests,

  /**
   * A7q: the whole live half of the quest editor, and the reason it is one function.
   *
   * Three things move together or the world lies: the map `doQuest` and `advanceKillQuests` read, the
   * giver set behind the `?` badge, and `combat.ts`'s untouchable registry. `seedQuestGivers` owns the
   * last two and reads the first, so the only way to get them out of step would be to not call it.
   *
   * **The map is cleared and refilled rather than replaced.** `quests` is a `const` closed over by the
   * two quest functions above; rebinding it is impossible and reassigning a new map would leave them
   * reading the old one for ever. This is the one place that matters, and it matters silently.
   *
   * ## The badge, live
   *
   * A quest deleted out from under a standing giver has to take the `?` *and* the immunity with it, and
   * the immunity is free — `canBeAttacked` reads the registry on every swing. The badge is not: it is a
   * field of an `EntityView` a client was sent minutes ago, and nothing re-sends a view for a mob that
   * has not moved, entered, left or fought. That is `describeRoom`'s own trap seen from the other side.
   * So the changed vnums are re-sent explicitly through `syncEntityState`, which is exactly the message
   * for *"here is an entity you already know about, as it now stands"* — the same call a fight starting
   * or a shield being worn already makes. Only the vnums whose giver status actually **flipped**, so an
   * edit to a quest's prose does not re-broadcast the warren.
   */
  setQuests(next) {
    const before = new Set([...quests.values()].map((quest) => quest.giver));
    // **The armour is watched as closely as the badge, and for a sharper reason.** Ticking
    // `protectGiver` on a mob that was already a giver does not change the giver set at all, so
    // comparing only those two would re-send nothing — and every client already in the room would keep
    // an `EntityView` whose `untouchable` says the opposite of what `combat.ts` now believes. That
    // leaves *Attack* on the click menu of a body the server will refuse to let anyone hit, which is
    // precisely the thing protocol 27 added the bit to prevent. Both sets, therefore, compared both ways.
    const beforeProtected = new Set(
      [...quests.values()].filter((quest) => quest.protectGiver === true).map((quest) => quest.giver),
    );
    quests.clear();
    for (const quest of next) quests.set(quest.id, quest);
    const { givers, protectedGivers } = seedQuestGivers();

    const flipped = new Set<number>();
    for (const vnum of before) if (!givers.has(vnum)) flipped.add(vnum);
    for (const vnum of givers) if (!before.has(vnum)) flipped.add(vnum);
    for (const vnum of beforeProtected) if (!protectedGivers.has(vnum)) flipped.add(vnum);
    for (const vnum of protectedGivers) if (!beforeProtected.has(vnum)) flipped.add(vnum);
    let resynced = 0;
    if (flipped.size > 0) {
      for (const actor of sim.allActors()) {
        if (!isMob(actor) || !flipped.has(actor.vnum)) continue;
        syncEntityState(actor);
        resynced++;
      }
    }
    return { givers: [...givers].sort((a, b) => a - b), resynced };
  },

  mobOverrides() {
    return mobOverrides;
  },

  liveCountOf(vnum) {
    return sim.countOf(vnum);
  },

  authorMobLoot(vnum, loot) {
    if (!mobTemplates.has(vnum)) return undefined;
    // **The live map is the truth and the file is its shadow**, the same order every other overlay
    // keeps: applied here, written by the router. Nothing already standing in the world is touched —
    // loot is per template, so it lands on the next spawn. See `authorMobLoot` in `admin.ts`.
    // **Merged rather than replaced, since A9.** The record now holds a template's fields as well as its
    // kit, so writing `{loot}` over it would silently unauthor a name somebody set an hour ago — and
    // clearing the loot has to leave the rest standing rather than delete the entry.
    const merged = mergeMobOverride(
      mobOverrides.get(vnum),
      loot.length === 0 ? {} : { loot: [...loot] },
      loot.length === 0 ? ['loot'] : [],
      new Date().toISOString(),
    );
    if (!merged) {
      mobOverrides.delete(vnum);
      return { loot: [] };
    }
    mobOverrides.set(vnum, merged);
    return merged;
  },

  mobTemplateOf(vnum) {
    return mobTemplates.get(vnum);
  },

  /**
   * One authored edit to a mob template, applied live — **A9**, and `authorItem`'s twin.
   *
   * Rebuilt from the **pristine** template plus whatever the merged override still says, so clearing a
   * field restores the harvest exactly rather than restoring the last edit. Every mob the world spawns
   * from here on is built from the result — `runReset` and `spawnMob` both read `mobTemplates` — and
   * nothing already standing is touched, which is the sentence the panel has to say out loud.
   */
  authorMob(vnum, next, cleared) {
    const current = mobTemplates.get(vnum);
    if (!current) return undefined;
    const pristine = pristineMobs.get(vnum) ?? current;
    const merged = mergeMobOverride(mobOverrides.get(vnum), next, cleared, new Date().toISOString());
    if (merged) {
      pristineMobs.set(vnum, pristine);
      mobOverrides.set(vnum, merged);
      const applied = applyMobOverride(pristine, merged);
      mobTemplates.set(vnum, applied);
      return applied;
    }
    // Nothing authored remains: the entry goes and the harvest is back, mark and all.
    mobOverrides.delete(vnum);
    pristineMobs.delete(vnum);
    mobTemplates.set(vnum, pristine);
    return pristine;
  },

  authoredMobs() {
    return authoredMobs;
  },

  /**
   * A9b: create a mob, or re-draft one that was created here. **The whole-record path.**
   *
   * One function for both because an edit *is* a re-draft: the incoming fields are laid over the record
   * that exists and the result goes through the same validator a creation does. A second, laxer path for
   * edits is how a field ends up legal to change but illegal to set — the asymmetry `readAuthoredMob`
   * avoids by running this same validator against the file on disk.
   *
   * `vnum` is `undefined` to create: the number is the server's to allocate and never the caller's, so a
   * form cannot ask for one a re-harvest might later claim.
   */
  authorNewMob(vnum, draft) {
    const existing = vnum === undefined ? undefined : authoredMobs.mobs.get(vnum);
    if (vnum !== undefined && !existing) return { error: `no mob ${vnum} was made here` };
    const number = vnum ?? authoredMobs.next;
    const drafted = draftAuthoredMob(number, draft);
    if ('error' in drafted) return drafted;
    authoredMobs.mobs.set(number, {
      mob: drafted.mob,
      at: new Date().toISOString(),
      ...(existing?.by ? { by: existing.by } : {}),
    });
    // **The counter only ever moves forward**, including past a number that is later deleted: a vnum is an
    // identity, and handing a freed one out again would silently change what a corpse or a limit refers to.
    if (vnum === undefined) authoredMobs.next = number + 1;
    mobTemplates.set(number, drafted.mob);
    return { mob: drafted.mob };
  },

  /**
   * A9b: unmake a created mob. Harvested ones are refused — there is no such thing as deleting a Duris
   * record, only authoring over it, which is what `Restore harvested` undoes.
   *
   * **What is already standing is left standing.** A created mob's instances are ordinary actors with
   * their own hit points and their own fights; deleting the idea of them mid-swing would be a mob
   * vanishing out of a round, which is the path A4's Slay note says the game does not have. They live out
   * their lives and nothing spawns another.
   */
  unmakeMob(vnum) {
    const authored = authoredMobs.mobs.get(vnum);
    if (!authored) return undefined;
    authoredMobs.mobs.delete(vnum);
    mobTemplates.delete(vnum);
    return { name: authored.mob.name, standing: sim.countOf(vnum) };
  },

  placements() {
    return placements;
  },

  /**
   * A9c: where a creature lives. Returns what it now stands at, or nothing for a vnum with no template.
   *
   * **Applied to the live reset tables as well as the map**, which is the difference between a placement
   * that works and one that works after a restart: `newZoneClock` copied the table at boot, so writing
   * only the overlay would leave every clock in the process running the population it started with.
   */
  placeMob(vnum, rows) {
    if (!mobTemplates.has(vnum)) return undefined;
    if (rows.length === 0) placements.delete(vnum);
    else placements.set(vnum, [...rows]);
    repopulateResets();
    return placements.get(vnum) ?? [];
  },

  giveItem(player, vnum) {
    const template = itemCatalogue.get(vnum);
    if (!template) return { error: `no item ${vnum} in the catalogue` };

    // **A money pile is converted, never carried** — `DESIGN-inventory.md` §8, and `isMoney` exists
    // so that a pile never reaches a `Stack` at all. A6b's `give` never learned it, so handing
    // somebody an amethyst put a 50-platinum *object* in their bag: it cost them slots, it could not
    // be spent, and Phase 17 found it the first time a shop asked for payment. The ground pickup path
    // has always done this; this is the second caller it should have had.
    if (isMoney(template.type)) {
      const gained = coinsOf(template);
      player.purse = addCoins(player.purse, gained);
      send(player.id, { t: 'log', channel: 'system', text: `You receive &+Y${describePurse(gained)}&N.` });
      send(player.id, { t: 'self', view: sim.selfViewOf(player) });
      persistAdminEdit(player);
      return { name: template.name };
    }

    const item = instantiate(template);
    const stowed = carry(player.inventory, item);
    if (!('stacks' in stowed)) {
      return {
        error: `${player.name} has nowhere to put ${item.name} — ${stowed.free} slot${stowed.free === 1 ? '' : 's'} free`,
      };
    }
    sim.setInventory(player, stowed);
    // Told, not slipped in. A bag that gains something silently is indistinguishable from a bug, and the
    // operator watching is not the only person who should know.
    send(player.id, { t: 'log', channel: 'system', text: `${item.name} appears in your hands.` });
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    persistAdminEdit(player);
    return { name: item.name };
  },
  setVitals(player, pools) {
    if (pools.hp !== undefined) player.hp = pools.hp;
    if (pools.mana !== undefined) player.mana = pools.mana;
    if (pools.move !== undefined) player.move = pools.move;
    // The same consequence order a wound has: status follows the pools, then the owner hears their
    // own numbers and the room sees the health bar move.
    sim.refreshStatus(player);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
    syncEntityState(player);
    // And their groupmates' rosters — found by slice 5's drive: the tick's push rides regeneration,
    // so a panel-set pool sat stale on everyone else's screen for up to a minute.
    for (const id of membersWith(grouping, player.id)) pushGroup(id);
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
    // **Phase 16: the damage bonus is set, not rolled, on an admin edit.** Rolling it would make an
    // operator's "put them at 50" a slot machine, and setting a level backwards then forwards would
    // ratchet a character's damage up for free. The band midpoints are the same answer the migration
    // path gives, which keeps an admin-made 50 and a levelled 50 comparable.
    player.damageBonus = expectedDamageBonus(level);
    player.combat = profile.combat;
    player.roundMs = profile.combat.roundMs;
    // After the profile, or the assignment above overwrites the bonus and the damroll with it.
    refitCombat(player);
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

  skyNow(zone) {
    return skyFor(gameClock, zone === undefined ? undefined : weather.get(zone)?.conditions);
  },

  occupantsOf(room) {
    const players: string[] = [];
    const mobs: string[] = [];
    for (const actor of sim.actorsIn(room)) (isPlayer(actor) ? players : mobs).push(actor.name);
    // Ungated on sight, deliberately, and this is the one place in the project where that is right:
    // an operator is looking at the world from outside it, not standing in the room with a torch.
    return { players, mobs, corpses: corpsesIn(graveyard, room).map((corpse) => corpseName(corpse)) };
  },

  clearRoom(room) {
    // **Removed, not slain.** `slayMob` goes through `resolveDeath` on purpose, and that is exactly
    // wrong here: it would leave a corpse in a room that is about to stop existing. Nothing died —
    // the room did.
    const mobs = sim.actorsIn(room).filter((actor) => !isPlayer(actor));
    for (const mob of mobs) sim.remove(mob.id);

    const corpses = corpsesIn(graveyard, room);
    for (const corpse of corpses) graveyard.delete(corpse.id);

    const items = itemsIn(ground, room);
    for (const item of items) ground.delete(item.id);

    return { mobs: mobs.length, corpses: corpses.length, items: items.length };
  },

  forgetPlace(place) {
    const characters = store.forgetPlace(place);

    // **Re-seat every body on the Place, and this is the half that is easy to miss.** An actor's
    // `x`/`y` are tile coordinates measured from the grid's origin, and the origin *is* the extent's
    // corner — `(room.pos.x - bounds.minX) * ROOM_STRIDE`. So a grid that grew leftward or upward has
    // moved every actor by a whole cell without anybody touching them. `relocate` re-derives the
    // origin from the freshly built grid, which is why this runs after `dropGrid`.
    let told = 0;
    for (const actor of sim.allActors()) {
      if (!samePlace(actor.place, place)) continue;
      sim.relocate(actor, actor.roomId);
    }

    for (const player of sim.allPlayers()) {
      if (!samePlace(player.place, place)) continue;
      const zone = world.zone(place.zone);
      if (zone) send(player.id, { t: 'zone', zone, level: place.level });
      // The `zone` message only resets a client's fog when the Place *changes*, and this is the same
      // Place — so the empty map has to be sent explicitly or the client keeps drawing the old one.
      sendSeen(player);
      sendPlaces(player);
      describeRoom(player);
      send(player.id, {
        t: 'log',
        channel: 'announce',
        text:
          '[Announcement] The shape of this area has changed, so your explored map of it has been ' +
          'reset. Nothing else about your character is affected.',
      });
      told += 1;
    }
    return { characters, told };
  },

  resetsNaming(room) {
    // Every loaded zone, not just the room's own: `arg3` is a room id and nothing stops a zone's
    // reset table naming a room in another zone — 168's own table already names 43321 and 72774.
    const byKind: Record<string, number> = {};
    for (const clock of zoneClocks) {
      for (const reset of clock.spawns.resets) {
        if (reset.room !== room) continue;
        byKind[reset.kind] = (byKind[reset.kind] ?? 0) + 1;
      }
    }
    return byKind;
  },

  settings() {
    return settings;
  },

  setSettings(next) {
    settings = next;
    // The clock is a live object holding its own rate, so throwing the setting has to reach it — and
    // it reaches it as a *rate* change: `setMsPerHour` leaves the accumulated hours alone, so the
    // world speeds up or slows down without the date moving. Everything downstream follows for free,
    // because the weather's timers are counted in game hours rather than in milliseconds.
    gameClock.setMsPerHour(settings.gameHourMs);
    // Written in the same breath it is applied, so the two cannot get out of step. See `settings.ts`
    // for why a switch that reverts on restart is the failure mode worth designing against.
    saveSettings(settings);
    // And the clock's own file, so the rate the world resumes at is the rate it was left at.
    saveWorldClock(gameClock, weather, Date.now());
    for (const player of sim.allPlayers()) sendSky(player);
    console.log(
      `[settings] pvp=${settings.pvp} movementCosts=${settings.movementCosts} gameHourMs=${settings.gameHourMs}`,
    );
  },
};

// **Protocol 14: what a worn thing *is*, for drawing it.** The catalogue is the only place that knows,
// and `sim.ts` is the only place that builds an `EntityView`, so this is the seam between them.
//
// **A7b made this the whole mechanism rather than a special case.** It used to answer `'shield'` for
// one Duris type and nothing for everything else, because the pack had one shield sheet and there was
// nowhere to record any other choice. Now an item carries an authored `art` id and this hands it
// straight out: 319 sheets are indexed, and which one an item wears is data rather than a branch here.
//
// The shield fallback survives underneath it, and earns its place — 419 shields are in the catalogue
// and none of them has authored art yet, so without this every one of them would stop being drawn the
// day this line changed. `DURIS_ITEM.shield` rather than a guess from the item's own fields: measured,
// the obvious heuristic dresses 177 pairs of sleeves as shields.
// Protocol 29: the bag's category silhouette rides the exact taxonomy the floor draws — one
// function, so a potion in the drawer and a potion on the flagstones can never disagree about
// what kind of thing a potion is. Art deliberately not passed: this resolver is the *fallback*,
// consulted only when `artClassOf` above found nothing.
sim.iconOf = (item) => groundSprite(item, templateOf(item)?.type);

sim.artClassOf = (item) => {
  const template = templateOf(item);
  return (
    template?.art ??
    (template?.type === DURIS_ITEM.shield
      ? 'shield'
      // Ranged slice 6, the shield's own argument one row down: 50 launchers are in the catalogue
      // and none has authored art, so every arrow-firing one draws as the staged short bow until an
      // operator chooses better. Keyed on what it *fires* rather than its type alone, because the
      // one staged sheet is a bow and a crossbow drawn as one would be a lie with a string — the
      // quarrel-firers stay undrawn, the documented degradation, until their sheets are staged.
      : template?.type === DURIS_ITEM.fireweapon && template.fires === MISSILE_TYPE.arrow
        ? 'bow'
        // The worn quiver, same argument once more: the catalogue's quivers have no authored art,
        // and the sheet artgen staged for them draws any of them until an operator chooses better.
        : template?.type === DURIS_ITEM.quiver
          ? 'quiver'
          : undefined)
  );
};

// Phase 16. The catalogue's 64 light sources, resolved by item id — `sim.ts` has no business owning
// a catalogue, the same rule `artClassOf` above follows. `vnumOf` returns nothing for a starter-kit
// id, and no starter-kit piece is a light, so the miss is the answer rather than a gap.
sim.lightOf = (id) => {
  // `vnumOf` takes an `Item`; here there is only an id, which is the half of it that matters. The
  // pattern is the same one it owns, kept in one place by calling it with the shape it wants.
  const match = /^obj:(\d+)$/.exec(id);
  const template = match ? itemCatalogue.get(Number(match[1])) : undefined;
  return template ? lightSourceFrom(id, template.name, template.light) : undefined;
};

const admin = new AdminApi({
  world,
  store,
  accounts,
  live: adminLive,
  // The same catalogue the simulation instantiates from, not a second copy read off disk — an Items
  // section showing something the running world does not have would be worse than no section.
  items: itemCatalogue,
  itemOverridesFile: ITEMS_FILE,
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
  authoredRoomsFile: AUTHORED_ROOMS_FILE,
  authoredZonesFile: AUTHORED_ZONES_FILE,
  mobOverridesFile: MOBS_FILE,
  placementsFile: PLACEMENTS_FILE,
  authoredMobsFile: AUTHORED_MOBS_FILE,
  // A7q. `quests.ts`'s own constant, so the loader six hundred lines above and the writer share a path.
  questsFile: QUESTS_FILE,
  // Phase 23. The same Map `doRead` serves players from — the panel writes what the world reads.
  boards,
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
  // A7c. One staged LPC sheet, for the admin panel's art picker.
  //
  // **Deliberately outside the admin gate, and the reason is mechanical rather than a relaxation.**
  // The gate's first line of defence is that `x-admin-token` must be *present* — a custom header
  // forces any cross-origin request into a CORS preflight this server never answers. An `<img>` tag
  // cannot send a header at all, so a gated route would have to be fetched as a blob and drawn onto
  // a canvas: several hundred requests and a great deal of machinery to protect bytes the game
  // client already serves unauthenticated to every player who loads it. These are CC-BY-SA sheets of
  // boots and helmets; there is no secret in one. The path is closed by lookup rather than by
  // sanitising — see `art.ts`.
  const artId = req.url ? artIdFromPath(req.url) : undefined;
  if (artId) {
    const file = artSheetPath(artId);
    if (!file || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `no staged sheet for art "${artId}" — run npm run artgen` }));
      return;
    }
    // Immutable: an id names one file for the life of a stage, and a picker that re-fetched 319
    // sheets on every keystroke would be unusable on the first scroll.
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
    const sheet = createReadStream(file);
    // **The handler is not optional.** An unhandled `error` on a stream throws, and a throw out here
    // takes the whole game server down with it — the header is already written by this point, so all
    // that can be done is to end the response and let the picker show a broken tile. `npm run artgen`
    // restaging while the panel is open is enough to reach this.
    sheet.on('error', (err) => {
      console.error(`[art] could not read ${file}:`, err);
      res.end();
    });
    sheet.pipe(res);
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

wss.on('connection', (socket, request) => {
  let player: Player | undefined;
  // The handshake's held state: a successful `auth` parks the account here for `enter` to spend.
  let account: AccountRecord | undefined;
  let authFailures = 0;
  // Protocol 24's conversation state. `adopting` is set when an `enter` found a pre-identity save
  // (the cards open minus the name step); `creating` holds the roll between `charRolled` and the
  // confirm — a reroll simply overwrites it, which is what makes rerolls free.
  let adopting: { name: string; slug: string } | undefined;
  let creating:
    | { name: string; slug: string; isAdopt: boolean; race: RaceId; class: ClassId; scores: AbilityScores }
    | undefined;
  // Read once at connect — the §6 claim gate wants to know where the socket came from, and the
  // answer must not be able to change mid-connection.
  const overLoopback = LOOPBACK.has(request.socket.remoteAddress ?? '');

  socket.on('message', (raw) => {
    const message = decodeClientMessage(String(raw));
    if (!message) return;

    if (!player) {
      // Protocol 23's two-step handshake: `auth` proves the account, `enter` picks the body.
      // Anything else sent before a character exists is dropped on the floor, exactly as before.
      if (message.t === 'auth') {
        if (account) return; // authed already; the only legal move now is `enter`
        if (message.protocol !== PROTOCOL_VERSION) {
          socket.send(encode({ t: 'rejected', reason: `protocol ${PROTOCOL_VERSION} required` }));
          socket.close();
          return;
        }
        const result = resolveAuth(message);
        if (!result.ok) {
          // `authFailed`, not `rejected`: the socket survives, because a mistyped password is not
          // a protocol violation and the form gets to try again. Up to a budget — a courtesy for
          // typos that must not double as a courtesy for dictionaries.
          socket.send(encode({ t: 'authFailed', reason: result.reason }));
          if (++authFailures >= AUTH_ATTEMPT_BUDGET) socket.close();
          return;
        }
        account = result.account;
        socket.send(encode(accountMessage(account)));
        return;
      }
      // Protocol 32: "is this name free?", asked while it is being typed. **Advisory only** — it
      // reserves nothing, so the refusal inside `charCreate` below stays exactly where it was and
      // remains the one that decides. See `ClientMessage.checkName` for why this exists at all.
      //
      // The two refusals are deliberately asked in the same order and with the same words the mint
      // uses, because a name rejected here and accepted there — or refused with different prose —
      // would be worse than no check.
      if (message.t === 'checkName') {
        if (!account) return;
        const requested = typeof message.name === 'string' ? message.name : '';
        const problem =
          characterNameProblem(requested) ??
          (accounts.ownerOf(slugify(requested.trim().slice(0, 24))) !== undefined ||
          store.hasStored(slugify(requested.trim().slice(0, 24)))
            ? 'that name is taken'
            : undefined);
        // The name is echoed so a client can discard an answer to a question it has moved on from.
        socket.send(encode({ t: 'nameChecked', name: requested, ...(problem ? { problem } : {}) }));
        return;
      }
      // Protocol 24: name-then-race-then-class-then-roll. `charCreate` opens or rerolls; the
      // confirm mints. Both speak `authFailed` for refusals, like everything else at this door.
      if (message.t === 'charCreate') {
        if (!account) return;
        if (!isRaceId(message.race) || !isClassId(message.class)) {
          socket.send(encode({ t: 'authFailed', reason: 'no such race or calling' }));
          return;
        }
        let name: string;
        let slug: string;
        let isAdopt: boolean;
        if (typeof message.name === 'string' && message.name.trim().length > 0) {
          const requested = message.name.trim().slice(0, 24);
          slug = slugify(requested);
          if (!slug) {
            socket.send(encode({ t: 'authFailed', reason: 'that name cannot be used' }));
            return;
          }
          const problem = characterNameProblem(requested);
          if (problem) {
            socket.send(encode({ t: 'authFailed', reason: problem }));
            return;
          }
          if (accounts.ownerOf(slug) !== undefined || store.hasStored(slug)) {
            socket.send(encode({ t: 'authFailed', reason: 'that name is taken' }));
            return;
          }
          name = canonicalCharacterName(requested);
          isAdopt = false;
        } else if (adopting) {
          ({ name, slug } = adopting);
          isAdopt = true;
        } else {
          return; // nameless with nothing to adopt is not a legal move
        }
        const scores = rollScores(progressRng, message.race, message.class);
        creating = { name, slug, isAdopt, race: message.race, class: message.class, scores };
        const words = {} as Record<Ability, string>;
        for (const ability of ABILITIES) words[ability] = scoreWord(scores[ability]);
        socket.send(
          encode({ t: 'charRolled', race: message.race, class: message.class, words, scores, bonus: BONUS_POINTS }),
        );
        return;
      }
      if (message.t === 'charConfirm') {
        if (!account || !creating) return;
        const spent = spendBonus(creating.scores, message.spend ?? {}, creating.race);
        if (!spent.ok) {
          socket.send(encode({ t: 'authFailed', reason: spent.reason }));
          return;
        }
        const identity: PlayerIdentity = { race: creating.race, class: creating.class, scores: spent.scores };
        if (!creating.isAdopt) {
          // Re-checked at the mint: two windows can roll the same name, and only one may keep it.
          if (accounts.ownerOf(creating.slug) !== undefined || store.hasStored(creating.slug)) {
            socket.send(encode({ t: 'authFailed', reason: 'that name was taken while you rolled' }));
            creating = undefined;
            return;
          }
          const claim = accounts.claim(account.slug, creating.slug);
          if (!claim.ok) {
            socket.send(encode({ t: 'authFailed', reason: claim.reason }));
            return;
          }
        }
        const record = store.load(creating.name);
        record.identity = identity;
        if (!creating.isAdopt) {
          // A minted body starts with constitution already in its hit points — the level-1 half of
          // the bonus every later level rolls through `hpLevelBonus`. Adoption keeps its history.
          store.setProgress(record, 1, 0, Math.max(6, STARTING_HIT_POINTS + hpLevelBonus(identity)));
        }
        store.flush(record);
        console.log(
          `[chargen] ${record.name}: ${identity.race} ${identity.class}` +
            `${creating.isAdopt ? ' (adopted at level ' + String(record.progress?.level ?? 1) + ')' : ''}`,
        );
        adopting = undefined;
        creating = undefined;
        // The refreshed list is the success signal; the client enters the new body off it.
        socket.send(encode(accountMessage(account)));
        return;
      }
      if (message.t !== 'enter' || !account) return;
      // Read before `admitCharacter` caches a blank record: "has history" must mean history that
      // predates this very attempt, or a fresh mint would be told to adopt itself.
      const hadHistory = store.hasStored(slugify(message.name.trim().slice(0, 24)));
      const admitted = admitCharacter(account, message.name, overLoopback);
      if (!admitted.ok) {
        socket.send(encode({ t: 'authFailed', reason: admitted.reason }));
        return;
      }
      const record = admitted.record;
      if (!record.identity && hadHistory) {
        // A body from before the phase: it enters nothing until it decides who it always was.
        // The claim (if this was flotsam) has already stuck, which is the right half to keep.
        adopting = { name: record.name, slug: slugify(record.name) };
        creating = undefined;
        socket.send(encode({ t: 'charAdopt', name: record.name }));
        return;
      }
      // The stored spelling is canonical: `enter aldric` puts on the character named Aldric.
      const name = record.name;
      // The class comes off the record, which chargen has already written by the time `enter`
      // arrives — `spawn` cannot read `player.identity`, since that is hydrated a few lines below.
      player = sim.spawn(name, progressRng, record.identity?.class);
      sockets.set(player.id, socket);
      watching.set(player.id, new Set());
      budgets.set(player.id, newCommandBudget(Date.now()));

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
      // The sky, before the first room description: a client that dresses the world by hour and
      // weather should have both in hand before it is told what the world looks like.
      sendSky(player);
      // Light the spawn tile before the bitset goes out, so a brand new character sees the ground
      // they are standing on rather than one tick of total darkness.
      foldSeen(player);
      // After `zone` and before the first room description: the client needs the grid built to index
      // the bitset against, and needs the shading in place before it draws the room.
      sendSeen(player);
      sendPlaces(player);
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
        sendPlaces(player);
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
    // A half-asked question does not survive the conversation it was asked in. Entity ids are
    // reissued, so an armed junk left here would be inherited by whoever is handed this id next — and
    // their first `y` would destroy something of theirs.
    pendingConfirm.delete(player.id);
    // Phase 18, and the same reissued-id argument in its other form: a leftover link would drag the
    // next character handed this id along behind a stranger. Whoever was following them is told, so
    // a train that loses its leader knows it rather than quietly walking on alone.
    for (const orphan of forgetFollower(following, player.id)) {
      send(orphan, { t: 'log', channel: 'system', text: `${player.name} is no longer here to follow.` });
    }
    // And out of their group, with the same argument again in its third form: a leftover membership
    // would put the next character handed this id into a stranger's party and start dividing their
    // kills. The party is told, because a member who silently stops counting toward the group's share
    // is a number going down for no visible reason — and the promotion is said out loud for the same
    // reason it is when somebody leaves on purpose.
    {
      const party = membersWith(grouping, player.id);
      const departed = forgetGrouping(grouping, player.id);
      tellGroup(party, `${player.name} is no longer in your group.`, player.id);
      if (departed.promoted !== undefined) {
        send(departed.promoted, { t: 'log', channel: 'system', text: 'You are now the leader of your group!' });
      }
      if (departed.dissolved !== undefined) {
        send(departed.dissolved, { t: 'log', channel: 'system', text: 'Your group has been disbanded.' });
      }
      pushGroupTo(party);
    }
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
  // First in the tick, and before anything that can move a body: the hour and the sky are the frame
  // everything else happens inside, and a sunrise announced after this tick's arrivals would reach a
  // character in the room they left.
  advanceWorldClock();

  const { moved, transitions, pathsEnded, winded, seamCrossings, relit, affectEvents, vitalsChanged } = sim.tick();

  // **Carried across a seam** — the owner's ruling that a road leaving a zone is a step. The sim
  // spotted the walker pressed against the edge; the crossing itself is the ordinary typed step, so
  // it pays the terrain, obeys the fight refusal, announces to both rooms and runs the arrival. A
  // player who cannot afford the ground, or is mid-fight, is refused here exactly as `east` would
  // refuse them — which is why this is `stepRoom` and not a teleport.
  for (const { player, dir } of seamCrossings) stepRoom(player, dir);

  // Walking never crosses a Place today, but `fromPlace` means anything that moves a player mid-tick
  // (a trap, a portal tile, a summon) is announced correctly without a second code path.
  for (const { player, from, fromPlace } of transitions) {
    announceArrival(player, from, fromPlace);
    noteWaterCrossing(player, from);
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

  // A continuous step refused for lack of movement — once per shoreline, the sim's edge-trigger, so
  // holding W against water you cannot afford says this once rather than ten times a second.
  for (const player of winded) {
    send(player.id, { t: 'log', channel: 'system', text: 'You are too exhausted to go on. (Try "rest".)' });
  }

  // Deep water collecting its due from anyone treading it on an empty pool — see the function.
  advanceDrowning();

  // Said before the state that follows it lands, so the player reads "your torch gutters and dies"
  // and *then* sees the dark close in, rather than watching the radius drop and being told why
  // afterwards. Expiry is server-authoritative and this line is the whole of its being a mechanic
  // rather than a glitch.
  for (const event of affectEvents) announceAffect(event);

  // Ranged slice 5's tail: anger lapsing starts the walk home. Here rather than in the expiry pass
  // because a walk is the hunt pass's business — `chainFrom`'s own comment sends the duty here. A mob
  // still fighting stays put: the fight it picked up owns it now, and home can wait for the victor.
  for (const event of affectEvents) {
    if (event.kind !== 'expired' || event.affect.type !== 'provoked') continue;
    const mob = event.actor;
    if (!isMob(mob) || mob.fighting !== undefined) continue;
    const home = event.affect.context === undefined ? Number.NaN : Number(event.affect.context);
    if (Number.isInteger(home)) beginWalkTo(hunts, mob, home);
  }

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

  // **A roster is other people's numbers**, so it goes stale on *their* vitals rather than on the
  // reader's — protocol 19's whole reason for being a message instead of a field on `self`. Collected
  // into a set first, so a party of three all taking a hit in one tick is one push each and not nine.
  // `relighted` is deliberately not excluded here: a relight sends a `self`, which carries none of
  // somebody else's health, and a torch guttering does not move a pool anyway.
  const rosters = new Set<EntityId>();
  for (const actor of vitalsChanged) {
    if (!isPlayer(actor)) continue;
    for (const id of membersWith(grouping, actor.id)) rosters.add(id);
  }
  for (const id of rosters) pushGroup(id);

  // Slice 2: memorization. A resting caster commits spent castings back to memory, lowest circle
  // first, one per unbroken twenty seconds off their feet — rising resets the trance. The refill
  // is time and posture only, deliberately: Duris's per-spell mem times are the parked follow-on.
  for (const player of sim.allPlayers()) {
    if (player.spentSlots.size === 0) continue;
    // `resting` is a *status*, not a posture — the two-axis state machine (§1.3) that has bitten
    // before. The stance command owns getting there; this pass only asks whether you are.
    if (player.status !== 'resting') {
      player.memorizeMs = 0;
      continue;
    }
    player.memorizeMs += TICK_MS;
    if (player.memorizeMs < MEMORIZE_SLOT_MS) continue;
    player.memorizeMs = 0;
    const circle = [...player.spentSlots.keys()].sort((a, b) => a - b)[0]!;
    const left = (player.spentSlots.get(circle) ?? 1) - 1;
    if (left <= 0) player.spentSlots.delete(circle);
    else player.spentSlots.set(circle, left);
    send(player.id, { t: 'log', channel: 'system', text: `&+WYou commit a circle-${circle} spell back to memory.&N` });
  }

  // Slice 6: the sun pass. The underdark races burn under the open sky — a self-lit room in an
  // open-sky sector is the sun, and the price is one visible `hit` node at −2, installed and
  // removed as the body moves between sun and shade. Idempotent by construction: where you stand
  // is re-derived every tick, so no movement path needs a hook and none can be missed.
  for (const player of sim.allPlayers()) {
    const race = player.identity ? RACES[player.identity.race] : undefined;
    if (!race?.sunVulnerable) continue;
    const room = sim.room(player.roomId);
    const scorched = room !== undefined && underOpenSky(room.sector) && roomLightsItself(room);
    const has = sim.affectsOf(player, 'sun_scorched').length > 0;
    if (scorched === has) continue;
    if (scorched) {
      sim.addAffect(
        player,
        newAffect({ type: 'sun_scorched', durationMs: UNLIMITED_DURATION, apply: 'hit', modifier: -2, flags: AffectFlag.NoSave }),
      );
      send(player.id, {
        t: 'log',
        channel: 'system',
        text: '&+rThe cursed sun of the surface world burns into your skin!&N',
      });
    } else {
      sim.removeAffects(player, 'sun_scorched');
      send(player.id, { t: 'log', channel: 'system', text: 'The shade is a mercy on your skin.' });
    }
    // The node changes a number the fight reads, so the profile follows in the same tick.
    refitCombat(player);
    send(player.id, { t: 'self', view: sim.selfViewOf(player) });
  }

  // Who has noticed whom. Runs over aggressive mobs only — 52 of IceCrag's 66 are passive and cost one field
  // read — and the delay inside it is the mechanic: see `perception.ts` and §4.5.
  for (const event of advancePerception(sim, awareness, TICK_MS)) announceNotice(event);

  // And who is coming after whom. Downstream of noticing rather than beside it: `beginHunt` is called from
  // the notice event, so a chase can only start from a decision Phase 9 already made and delayed.
  //
  // **Silent since 2026-08-13.** A chase used to announce its arrivals further down, after the entity
  // sync, and that ordering was load-bearing: the sentence read `watching`, which does not contain the
  // mob until `syncEntities` has run for this tick, so announcing here caught every observer one tick
  // too early and printed nothing at all. The line is gone — the renderer shows the arrival — and the
  // hazard is recorded because it is the shape of the bug any future per-observer line will hit.
  // **Phase 8¾: the world drifts.** Every `PULSE_MOBILE` (the source's own ten seconds), each idle
  // non-sentinel rolls one of seven doors and strolls through the walker the hunts already use — so
  // the announce lines, the `no_mob` refusals and the tile-by-tile motion are all inherited rather
  // than rebuilt. The exclusions are the source's (fighting, casting, not standing) plus two of ours,
  // both about findability: a shopkeeper's post is the shop, and a quest giver who wanders is a
  // quest that cannot be started. `spawnRng`, because a stroll is the world's colour, not a fight's
  // arithmetic — and the two streams must not perturb each other.
  wanderCountdownMs -= TICK_MS;
  if (wanderCountdownMs <= 0) {
    wanderCountdownMs = WANDER_PULSE_MS;
    for (const actor of sim.allActors()) {
      if (!isMob(actor)) continue;
      const mob = actor;
      if (mob.fighting !== undefined || mob.casting) continue;
      if (mob.posture !== 'standing' || mob.status !== 'normal') continue;
      if (hunts.has(mob.id)) continue; // mid-chase, mid-stroll, or mid-shuffle already
      if (sim.affectsOf(mob, 'provoked').length > 0) continue;

      // **Phase 25: a body with a beat walks it and does nothing else** — `ACT_PATROL`'s one real
      // rule, kept. Standing at the leg's end: rest a few pulses (counted in pulses rather than
      // wall time, so the beat stays inside the simulation's clock), then turn to the next turning
      // point; the walk itself is the hunts' own, announcements and arrival settle included.
      const beat = patrolsByVnum.get(mob.vnum);
      if (beat) {
        const state = patrolLegs.get(mob.id) ?? { leg: 0, restPulses: 0 };
        const target = beat.route[state.leg]!;
        if (mob.roomId === target) {
          patrolLegs.set(mob.id, {
            leg: (state.leg + 1) % beat.route.length,
            restPulses: Math.max(1, Math.round(beat.pauseMs / WANDER_PULSE_MS)),
          });
        } else if (state.restPulses > 0) {
          patrolLegs.set(mob.id, { leg: state.leg, restPulses: state.restPulses - 1 });
        } else {
          beginWalkTo(hunts, mob, target);
        }
        continue;
      }
      // Roaming between rooms is for the unanchored only: ACT_SENTINEL is the wander bit (not the
      // pursuit tier — §0.4's own warning), and two exclusions are ours, both about findability — a
      // shopkeeper's post is the shop, and a quest giver who wanders is a quest that cannot be
      // started. The in-room shuffle below is open to all of them: no post is left by shifting your
      // weight beside it.
      const roams = !mob.aggro.sentinel && !shopsByKeeper.has(mob.vnum) && !sim.isQuestGiver(mob.vnum);
      // The door lookup is `CAN_GO`'s closed-door half — see `wanderRoll` for the youths it freed.
      // The 1-in-3 gate in front of the roll is the owner's tone-down (2026-08-09): our field rooms
      // are exit-rich, so the source's bare seven-face die had half the youths on the move every
      // pulse and the field read as through-traffic. A pulse the gate refuses falls through to the
      // in-room shuffle below, so the world stays alive at the ankles while the doors calm down.
      const step = roams && randomInt(spawnRng, 1, 3) === 1
        ? wanderRoll(world, mob, randomInt(spawnRng, 0, 6), mob.lastWander, (room, dir) => {
            const doorway = world.doorway(room, dir);
            return doorway !== undefined && doorway.near.door.closed;
          })
        : undefined;
      if (step) {
        mob.lastWander = step.dir;
        beginWalkTo(hunts, mob, step.room);
        continue;
      }
      // The source's own memory clear: a refused pulse forgets the last door, so it is legal again.
      delete mob.lastWander;

      // **The in-room shuffle** — the owner's ask, on the pulses the die said "stay": one standing
      // mob in three ambles to a random walkable tile of its own room. Three candidate tiles, first
      // walkable wins; a room too cramped to offer one simply keeps its statue this pulse.
      if (randomInt(spawnRng, 1, 3) !== 1) continue;
      const grid = world.grid(mob.place);
      const origin = grid?.roomOrigins.get(mob.roomId);
      if (!grid || !origin) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const tx = origin.tx + randomInt(spawnRng, 0, ROOM_TILES - 1);
        const ty = origin.ty + randomInt(spawnRng, 0, ROOM_TILES - 1);
        const x = tileCentre(tx);
        const y = tileCentre(ty);
        if (!isWalkableAt(grid, x, y) || roomAtTile(grid, tx, ty) !== mob.roomId) continue;
        // Far enough to read as a walk, not a twitch.
        if (Math.hypot(x - mob.x, y - mob.y) < TILE_SIZE * 1.5) continue;
        beginDrift(hunts, mob, { x, y });
        break;
      }
    }
  }

  const hunt = advanceHunts(sim, world, hunts, TICK_MS);
  // A hunter that has caught up starts swinging. This is the seam Phase 10 left open on purpose and the
  // exact point `mobact.c` calls `MobStartFight` — the hunt's job ends at the doorway.
  for (const event of hunt.events) {
    if (event.kind !== 'arrived') continue;
    const quarry = sim.player(hunts.get(event.mob.id)?.quarry ?? -1);
    if (!quarry) continue;
    if (engage(scheduler, event.mob, quarry)) syncEntityState(event.mob);
  }

  // **The tick drains the scheduler once, and routes by kind.** Phase 20's mandatory first commit:
  // the drain used to live inside `advanceCombat`, which discarded every kind it did not know — so a
  // spell's wind-up event would have popped there and vanished. Draining here makes the tick the one
  // dispatcher; `advanceCombat` is handed the events and keeps exactly its old behaviour.
  const dueEvents = scheduler.advance(TICK_MS);
  // A kind nothing routes is a bug worth hearing about, not a silence — the exact failure the old
  // shape had. `command` is the scheduler's declared-but-unproduced kind; nothing schedules one, and
  // the day something does, it gets a case here first.
  for (const event of dueEvents) {
    switch (event.kind) {
      case 'swing':
        break; // `advanceCombat`'s below, handed the whole list.
      case 'cast': {
        // Phase 20's beat — before `advanceCombat`, so a cast that completes this tick strikes
        // before this tick's swings land on its caster, which is the order the wind-up promised.
        const caster = sim.get(event.actor);
        if (caster) castBeat(caster);
        break;
      }
      default:
        console.error(`[tick] undispatched '${event.kind}' event for #${event.actor} — add a route beside advanceCombat`);
    }
  }

  // Blows land. Driven by the scheduler rather than a scan: most ticks pop nothing at all.
  //
  // The last argument is Phase 14's morale check, injected the way `advanceAssists` takes `perceives`:
  // `combat.ts` decides *when* a mob's nerve is tested (its own round boundary) and this decides what
  // happens when it goes — the same `runFlee` a player's own `flee` runs.
  const combat = advanceCombat(
    sim,
    scheduler,
    threat,
    ledger,
    combatRng,
    dueEvents,
    (mob) => {
      const outcome = runFlee(mob);
      return outcome.kind === 'fled';
    },
    defenceOf,
    // Phase 20 slice 3: what a shaman knows is content, so the decision lives here, not in combat.ts.
    (mob, target) => mobStartCast(mob, target),
  );
  for (const outcome of combat.attacks) announceAttack(outcome);
  // **Phase 19: you get better at what you do.** Only on a blow that landed, only for a player, and
  // through the same `combatRng` that rolled the blow — a skill that rose because `Math.random()` said
  // so would make a fight unreplayable, which is `CLAUDE.md` §3.
  for (const outcome of combat.attacks) notchFromSwing(outcome);
  // **And you get better at what is done to you** — slice 2, the other half. Separate from the line
  // above rather than folded into it because they fire on opposite bodies for opposite reasons: one on
  // the attacker for a blow that landed, one on the defender for a defence that did not.
  for (const outcome of combat.attacks) notchFromDefence(outcome);
  // **Phase 21: and you get better at swinging twice.** A third pass rather than a branch inside the
  // first, because it fires on a different condition — the dual roll rather than a landed blow — and
  // folding the two would have hidden that difference inside an `if`. See `notchFromDualWield`.
  for (const outcome of combat.attacks) notchFromDualWield(outcome);
  for (const change of combat.switches) announceSwitch(change);
  // The source's own sentence (`actmove.c:3586`), so a bashed caster's recovery is as visible as the
  // knockdown was — the player timing a re-bash is reading exactly this line.
  for (const mob of combat.stood) actAround(mob, 'combat', (who) => `${who} clambers to its feet.`);
  for (const death of combat.deaths) resolveDeath(death);
  // **Weapons get their say last** — a separate walk, after every announce and notch above, so a
  // proc that kills cannot leave an earlier walk narrating a corpse; `fireWeaponProc` re-checks
  // every gate itself. Ability blows deliberately do not proc yet (the source procs backstab and we
  // have none); the day they should, `useAbility` calls the same function.
  for (const outcome of combat.attacks) maybeWeaponProc(outcome);

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
        dropItem(
          ground,
          item,
          { roomId: event.corpse.roomId, place: event.corpse.place, x: event.corpse.x, y: event.corpse.y },
          undefined,
          DEV_DECAY_MS,
        );
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


  // Things lying on the floor, on the same clock and immediately after the corpses that spill onto
  // it. The order matters by exactly one tick and is worth keeping straight: a corpse spilling this
  // tick puts items down with a full clock, so nothing can be created and aged in the same pass.
  for (const event of advanceGround(ground, TICK_MS)) {
    if (event.kind === 'gone') {
      // **A container spills rather than taking its contents with it** — the corpse rule, one store
      // over, and for the same reason: destroying what was inside because nobody came back is the
      // "I came back and it was gone" feeling rather than "somebody got there first". The spilled
      // things land where the container lay and start their own clock.
      // **One ground entry per *thing*, not per stack**, which is why the count is walked. Dropping a
      // stack's worth as a single entry would destroy nineteen of twenty arrows — the exact silent
      // loss `GroundItem.held` was added to stop, one level down. A stack carrying `held` always has
      // `count: 1` (see `mergeable`), so a nested container cannot be duplicated by this loop.
      const spilled = event.entry.held?.contents ?? [];
      for (const stack of spilled) {
        for (let i = 0; i < stack.count; i++) {
          dropItem(
            ground,
            stack.item,
            { roomId: event.entry.roomId, place: event.entry.place, x: event.entry.x, y: event.entry.y },
            stack.held,
            DEV_DECAY_MS,
          );
        }
      }

      for (const observer of sim.playersIn(event.entry.roomId)) {
        if (!watching.get(observer.id)?.has(event.entry.id)) continue;
        send(observer.id, { t: 'entityLeave', id: event.entry.id });
        watching.get(observer.id)?.delete(event.entry.id);
        send(observer.id, {
          t: 'log',
          channel: 'room',
          text:
            `${capitalise(stripColour(event.entry.item.name))} crumbles away` +
            (spilled.length > 0 ? ', spilling what it held onto the ground.' : '.'),
        });
      }
      if (spilled.length > 0) syncEntitiesIn(event.entry.roomId);
      continue;
    }
    // **The same sentence, said twice: once to the log and once to the renderer.** A ground object is
    // sent on `entityEnter` and never re-sent per tick, so the 3D client counts its rot clock down from
    // whatever snapshot it was handed — which is right for a client that walked in ten seconds ago and
    // drifts for one that has been standing here for nine minutes. This is the correction, and it is
    // sent at exactly the moment `advanceGround` latches `warned`, so the glint starts to dim on the
    // frame the log line arrives. `entityUpdate` on an item id is already an established shape — a
    // looted corpse has used it since Phase 13.
    // Built exactly as `visibleEntities` builds it — the same three injected facts — because a view
    // that disagreed with the one the client already holds would swap the item's picture and drop its
    // *Look inside* row on the way past.
    const fadingTemplate = templateOf(event.entry.item);
    const fadingView = groundViewOf(
      event.entry,
      fadingTemplate?.type,
      fadingTemplate?.container !== undefined,
      fadingTemplate?.art,
    );
    for (const observer of sim.playersIn(event.entry.roomId)) {
      if (!watching.get(observer.id)?.has(event.entry.id)) continue;
      send(observer.id, {
        t: 'log',
        channel: 'room',
        text: `${capitalise(stripColour(event.entry.item.name))} is starting to fall apart.`,
      });
      send(observer.id, { t: 'entityUpdate', entity: fadingView });
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
  for (const outcome of advanceZones(sim, zoneClocks, mobTemplates, itemCatalogue, countInstances, authoredOutfit, spawnRng, TICK_MS)) {
    const droppedNow = placeResetObjects(outcome);
    if (outcome.spawned.length === 0 && outcome.doors === 0 && droppedNow === 0) continue;
    console.log(
      `[pop] zone ${outcome.zone} repopped: +${outcome.spawned.length} mobs, ` +
        `${outcome.doors} doors reset, +${droppedNow} objects, ${outcome.atLimit} already at limit` +
        (outcome.crowded > 0 ? `, ${outcome.crowded} on a shared tile` : ''),
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
  //
  // **The rooms first, then one pass over the players** — this is the tick's hottest bookkeeping and
  // the shape changed with the 2026-08-13 ruling. A body walking about in the room next door is drawn
  // to whoever can see through the crossing, so their view has to be re-evaluated on the same beat as
  // anyone standing beside it. Getting that wrong does not hide the mob (the next sync from any cause
  // brings it in) — it *strands* it, drawn at the tile it was on when something last happened.
  //
  // Collecting rooms before players is not a micro-optimisation: `playersIn` walks every actor in the
  // world, so the old per-mover call was already one full scan each, and widening it to five rooms a
  // mover would have multiplied that. This is one scan for the whole tick however many things moved.
  const dirty = new Set<Player>();
  const stirred = new Set<RoomId>();
  for (const actor of movedActors) {
    if (isPlayer(actor)) dirty.add(actor);
    stirred.add(actor.roomId);
  }
  // The room a hunter *left* needs re-evaluating too, and nothing else would do it: the loop above only
  // reaches the room it arrived in, so whoever it walked away from would keep drawing it standing there.
  for (const event of hunt.events) {
    if (event.kind === 'entered' && event.from !== undefined) stirred.add(event.from);
  }
  const crossings = crossingDeps();
  const watchRooms = new Set<RoomId>(stirred);
  for (const roomId of stirred) for (const near of roomsSeeingInto(roomId, crossings)) watchRooms.add(near);
  for (const player of sim.allPlayers()) if (watchRooms.has(player.roomId)) dirty.add(player);
  for (const observer of dirty) syncEntities(observer);

  // Nothing is said about who walked in any more — the renderer says it. See the note where
  // `announceHunt` used to be defined for why the sentence went and the event stayed.

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

/**
 * Flush everything a connected character is holding, then go.
 *
 * `PlayerStore` writes on a debounce, so anything not captured here is worth up to
 * `SAVE_DEBOUNCE_MS` of lost progress on every exit.
 */
function shutdown(): void {
  // Nobody's socket closes on a restart, so the burn each connected player is holding has to be
  // captured here or every `node --watch` reload hands them back a full torch.
  for (const player of sim.allPlayers()) {
    rememberAffects(player);
    rememberVitals(player);
    rememberProgress(player);
  }
  store.flushAll();
  // The world's own state, not any character's: the hour it reached and every zone's sky. Flushed on
  // the hour anyway, so this only buys back the part-hour — but it is the difference between a
  // `node --watch` reload landing mid-storm and landing on a re-rolled one.
  saveWorldClock(gameClock, weather, Date.now());
  process.exit(0);
}

// `node --watch` restarts on SIGTERM/SIGINT; without this, up to SAVE_DEBOUNCE_MS of exploration
// is lost on every code change.
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);

// The same exit, asked for over the IPC channel instead of by a signal — `supervisor.ts`'s Stop and
// Restart. **It has to be a message rather than a signal, and the reason is Windows**: there are no
// POSIX signals there, so a parent's `child.kill('SIGTERM')` is `TerminateProcess` and the handler
// above never runs. A restart button that silently cost every player their last few seconds would
// be worse than no button. Wired only when a channel exists, so nothing changes when this process
// is started by hand.
if (process.channel) {
  process.on('message', (message: unknown) => {
    if ((message as { t?: unknown } | null)?.t === 'shutdown') shutdown();
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

